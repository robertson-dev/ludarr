import { beforeEach, describe, expect, test } from "bun:test";
import { db, serializeGame, stmts, type GameRow } from "../src/db";
import { checkGame, crackwatchSync, cwsdeps, dueIn } from "../src/crackwatch-sync";
import type { CwGame } from "../src/crackwatch";

const cw = (slug: string, o: Partial<CwGame>): CwGame => ({ slug, title: slug, status: "cracked", statusText: null, releaseDate: null, crackDate: null, daysToCrack: null, drm: "Steam", group: null, cover: null, description: null, stores: [], url: `https://isitcracked.com/game/${slug}`, ...o });
const game = (name: string, appid: number, monitored = 1) => {
  const g = stmts.upsertGame({ igdb_id: null, steam_appid: appid, name, slug: name.toLowerCase().replace(/\W+/g, "-"), summary: null, storyline: null, release_year: null, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["win"]', game_modes_json: "[]", developer: null, publisher: null }) as GameRow;
  db.query("UPDATE games SET monitored=? WHERE id=?").run(monitored, g.id);
  return stmts.gameById.get(g.id) as GameRow;
};

let site: Record<string, CwGame | null> = {};
let looked: string[] = [];
let created: { gameId: number; by?: string }[] = [];
let now = Date.parse("2026-10-19T12:00:00Z");
beforeEach(() => {
  db.exec("DELETE FROM games; DELETE FROM catalog; DELETE FROM history; DELETE FROM requests; DELETE FROM packages");
  site = {}; looked = []; created = []; now = Date.parse("2026-10-19T12:00:00Z");
  cwsdeps.find = async title => { looked.push(title); return site[title] ?? null; };
  cwsdeps.createRequest = opt => { created.push(opt); return { request: { id: 1 } as never, duplicate: false }; };
  cwsdeps.now = () => now;
  process.env.CRACKWATCH_SYNC_HOURS = "6";
});

describe("crack status", () => {
  test("verdicts stand for a while: open ones six hours, settled ones a week, untracked ones three days", () => {
    expect(dueIn("uncracked")).toBe(6 * 3600); expect(dueIn("unreleased")).toBe(6 * 3600); expect(dueIn(null)).toBe(6 * 3600);
    expect(dueIn("cracked")).toBe(7 * 86400); expect(dueIn("untracked")).toBe(3 * 86400);
  });
  test("the library gets DRM, status, date and group; untracked games are marked so; nothing is asked twice before it is due", async () => {
    const pz = game("Planet Zoo 2", 1), en = game("Enshrouded", 2), ds = game("Demon's Souls", 3);
    site["Planet Zoo 2"] = cw("planet-zoo-2", { status: "uncracked", drm: "Denuvo", releaseDate: "2026-10-13" });
    site["Enshrouded"] = cw("enshrouded", { status: "cracked", drm: "Steam", group: "RUNE", crackDate: "2026-10-15" });
    expect(await crackwatchSync()).toEqual({ checked: 3, changed: 3 });
    const row = (id: number) => stmts.gameById.get(id) as GameRow;
    expect(row(pz.id)).toMatchObject({ drm: "Denuvo", crack_status: "uncracked", crack_date: null, crack_group: null, crackwatch_slug: "planet-zoo-2" });
    expect(row(en.id)).toMatchObject({ drm: "Steam", crack_status: "cracked", crack_date: "2026-10-15", crack_group: "RUNE" });
    expect(row(ds.id)).toMatchObject({ drm: null, crack_status: "untracked", crackwatch_slug: null });
    expect(serializeGame(row(en.id))).toMatchObject({ drm: "Steam", crackStatus: "cracked", crackGroup: "RUNE", crackwatchUrl: "https://isitcracked.com/game/enshrouded" });
    looked = [];
    expect(await crackwatchSync()).toEqual({ checked: 0, changed: 0 });                   // all three were just checked
    now += 7 * 3600 * 1000;
    expect(await crackwatchSync()).toEqual({ checked: 1, changed: 0 });                   // only the uncracked one is due again
    expect(looked).toEqual(["Planet Zoo 2"]);
    looked = []; now += 8 * 86400 * 1000;
    await crackwatchSync();
    expect(looked.sort()).toEqual(["Demon's Souls", "Enshrouded", "Planet Zoo 2"]);
    expect(created).toEqual([]);                                                          // nothing changed: no search
  });
  test("a monitored game without a copy that turns cracked gets a history entry and a search; one with a copy or unmonitored only the entry", async () => {
    const pz = game("Planet Zoo 2", 1), off = game("Dark Game", 2, 0), has = game("Owned Game", 3);
    for (const n of ["Planet Zoo 2", "Dark Game", "Owned Game"]) site[n] = cw(n, { status: "uncracked", drm: "Denuvo" });
    await crackwatchSync();
    stmts.insertPackage.get(has.id, null, "/library/owned", "Owned Game", null, 1, "{}");
    for (const n of ["Planet Zoo 2", "Dark Game", "Owned Game"]) site[n] = cw(n, { status: "cracked", drm: "Denuvo", group: "RUNE", crackDate: "2026-10-20" });
    now += 7 * 3600 * 1000;
    expect(await crackwatchSync()).toMatchObject({ checked: 3, changed: 3 });
    expect(created).toEqual([{ gameId: pz.id, by: "crackwatch" }]);
    const hist = db.query("SELECT game_id, event, message FROM history ORDER BY id").all() as { game_id: number; event: string; message: string }[];
    expect(hist.map(h => [h.game_id, h.event])).toEqual([[pz.id, "cracked"], [off.id, "cracked"], [has.id, "cracked"]]);
    expect(hist[0].message).toBe("cracked by RUNE on 2026-10-20 (Denuvo)");
    // a hypervisor bypass also counts as something to find; a later real crack is reported once more
    const fc = game("EA SPORTS FC 27", 9);
    site["EA SPORTS FC 27"] = cw("ea-sports-fc-27", { status: "unreleased", drm: "Denuvo" });
    await checkGame(fc);
    site["EA SPORTS FC 27"] = cw("ea-sports-fc-27", { status: "hypervisor", drm: "Denuvo", group: "DenuvOwO" });
    created = [];
    await checkGame(stmts.gameById.get(fc.id) as GameRow);
    expect(created).toEqual([{ gameId: fc.id, by: "crackwatch" }]);
    site["EA SPORTS FC 27"] = cw("ea-sports-fc-27", { status: "cracked", drm: "Denuvo", group: "RUNE" });
    await checkGame(stmts.gameById.get(fc.id) as GameRow);
    expect((db.query("SELECT message FROM history WHERE game_id=? ORDER BY id").all(fc.id) as { message: string }[]).map(h => h.message)).toEqual(["bypassed (hypervisor) by DenuvOwO (Denuvo)", "cracked by RUNE (Denuvo)"]);
  });
  test("the storefront entries Discover shows are checked after the library; a site error leaves a game for the next pass; 0 hours turns it all off", async () => {
    stmts.catalogTouch.run(4115450, "Phantom Blade Zero"); stmts.catalogTouch.run(99, "Some Indie");
    site["Phantom Blade Zero"] = cw("phantom-blade-zero", { status: "unreleased", drm: "Denuvo", releaseDate: "2026-10-28" });
    const g = game("Enshrouded", 2);
    cwsdeps.find = async title => { looked.push(title); if (title === "Enshrouded") throw new Error("HTTP 503"); return site[title] ?? null; };
    expect(await crackwatchSync()).toEqual({ checked: 2, changed: 2 });                   // both storefront entries went from unknown to a verdict
    expect((stmts.gameById.get(g.id) as GameRow).crackwatch_at).toBeNull();
    expect(db.query("SELECT steam_appid, drm, crack_status FROM catalog ORDER BY steam_appid").all()).toEqual([{ steam_appid: 99, drm: null, crack_status: "untracked" }, { steam_appid: 4115450, drm: "Denuvo", crack_status: "unreleased" }]);
    process.env.CRACKWATCH_SYNC_HOURS = "0"; looked = [];
    expect(await crackwatchSync()).toEqual({ checked: 0, changed: 0 }); expect(looked).toEqual([]);
    process.env.CRACKWATCH_SYNC_HOURS = "6";
    expect(await checkGame(stmts.gameById.get(g.id) as GameRow)).toBeNull();            // the site error, reported as nothing learned
  });
});

/* ─────────── Fix A review round (2026-11-09): a crack wakes the search that waits for one ─────────── */
import type { RequestRow } from "../src/db";

describe("review: a search waiting for a crack", () => {
  test("is asked to look now when the verdict turns cracked, instead of at its next try hours later; no second search is started", async () => {
    const g = game("Black Myth: Wukong", 2358720);
    db.query("UPDATE games SET crack_status='uncracked', drm='Denuvo', crackwatch_at=? WHERE id=?").run(Math.floor(now / 1000) - 7 * 3600, g.id);
    const r = stmts.insertRequest.get(g.id, "auto") as RequestRow;
    db.query("UPDATE requests SET stage='waiting for a crack — searching again in 6h', next_try_at=? WHERE id=?").run(Math.floor(now / 1000) + 5 * 3600, r.id);
    site["Black Myth: Wukong"] = cw("black-myth-wukong", { status: "cracked", group: "RUNE", drm: "Denuvo" });
    await checkGame(stmts.gameById.get(g.id) as GameRow);
    const after = stmts.requestById.get(r.id) as RequestRow;
    expect({ next: after.next_try_at, stage: after.stage }).toEqual({ next: null, stage: "queued" });
    expect(created).toEqual([]);
  });
  test("a search that is downloading, or a verdict that is still uncracked, is left alone", async () => {
    const g = game("Black Myth: Wukong", 2358720);
    db.query("UPDATE games SET crack_status='uncracked', crackwatch_at=? WHERE id=?").run(Math.floor(now / 1000) - 7 * 3600, g.id);
    const r = stmts.insertRequest.get(g.id, "auto") as RequestRow;
    const at = Math.floor(now / 1000) + 5 * 3600;
    db.query("UPDATE requests SET next_try_at=? WHERE id=?").run(at, r.id);
    site["Black Myth: Wukong"] = cw("black-myth-wukong", { status: "uncracked", drm: "Denuvo" });
    await checkGame(stmts.gameById.get(g.id) as GameRow);
    expect((stmts.requestById.get(r.id) as RequestRow).next_try_at).toBe(at);
  });
});
