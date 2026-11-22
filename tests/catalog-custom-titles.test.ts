/**
 * The custom source's titles (review findings ways-api-1, ways-api-9): a title made for a game's ways knows the game's
 * year, release date and platforms, so a same-named game of another year from another source never merges into it; by
 * name, a title a library game holds is never another library game's, and a store's listing with no year is never taken
 * for it; and a game another source already gave a title (titles.game_id, or its Steam id) keeps that one title when it
 * gets a way.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { collectSync, ensureTitle, reingestCustom } from "../src/catalog/providers/custom";
import { steamProvider } from "../src/catalog/providers/steam";
import { ingest } from "../src/catalog/store";
import type { Contribution } from "../src/catalog/types";
import { cdeps } from "../src/catalog/worker";
import { db, stmts, upsertGame, type GameRow } from "../src/db";
import { gameDetail } from "../src/library/games";
import { insertPlan, insertWay } from "../src/ways/store";
import type { RuntimePlanSpec } from "../src/ways/types";

const made = { games: [] as number[], plans: [] as number[], titles: [] as number[] };
const realSources = cdeps.sources;
// a game's page lists the routes of the enabled sources: these two
beforeAll(() => { cdeps.sources = () => [{ id: 1, name: "custom", source: { id: "custom" } as never }, { id: 2, name: "steam", source: { id: "steam" } as never }]; });
afterAll(() => {
  cdeps.sources = realSources;
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.titles) db.query("DELETE FROM titles WHERE id=?").run(id);
  db.exec("DELETE FROM routes WHERE source IN ('custom', 'titles-compat')");
  db.exec("DELETE FROM catalog_sources WHERE id='titles-compat'");
});

const spec = (): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Titles-.*[.]zip$", channel: "stable" }, launch: { exe: "run.exe", argv: [] },
  content: { kind: "rom", platform: "pc", what: "the game's data", search: ["x"], accept: { hashes: [{ algo: "sha1", value: "a".repeat(40) }], formats: ["zip"] }, normalize: null, place: "data.zip" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
});
let seq = 0;
function withWay(g: GameRow) {
  const p = insertPlan({ name: `Titles Port ${++seq}`, kind: "port", repo: `titles/port-${seq}`, platforms: ["pc"], spec: spec(), status: "ready" });
  made.plans.push(p.id);
  return insertWay({ gameId: g.id, planId: p.id });
}
function game(o: Partial<GameRow>): GameRow {
  const g = upsertGame(o) as GameRow;
  made.games.push(g.id);
  return g;
}
const titlesNamed = (norm: string) => db.query("SELECT t.id, t.year, t.game_id AS gameId, t.meta_source AS source FROM titles t JOIN title_names n ON n.title_id=t.id WHERE n.norm=? ORDER BY t.id").all(norm) as { id: number; year: number | null; gameId: number | null; source: string }[];
const own = (ids: number[]) => made.titles.push(...ids);

describe("a title made for a game's ways knows the game's year (ways-api-1)", () => {
  test("a Steam game of the same name and another year gets its own title; neither game shows the other's ways", async () => {
    const old = game({ name: "Titles Shock", slug: "titles-shock", release_year: 1994, platforms_json: JSON.stringify(["pc"]), source: "manual" } as Partial<GameRow>);
    withWay(old);
    reingestCustom();
    const before = titlesNamed("titles shock");
    own(before.map(t => t.id));
    expect(before).toEqual([{ id: before[0].id, year: 1994, gameId: old.id, source: "custom" }]);
    // the 2023 remake, from Steam
    const remake = game({ steam_appid: 995_400, name: "Titles Shock", slug: "titles-shock-2023", release_year: 2023 } as Partial<GameRow>);
    ingest(steamProvider, (await steamProvider.collect({} as never)).filter(c => c.title.gameId === remake.id));
    const after = titlesNamed("titles shock");
    own(after.map(t => t.id));
    expect(after.map(t => [t.year, t.gameId])).toEqual([[1994, old.id], [2023, remake.id]]);
    expect(gameDetail(old.id)!.routes.map((r: { source: string }) => r.source)).toEqual(["custom"]);
  });

  test("a title made before it knew the year takes the game's year, date and platforms at the next ingest", () => {
    const g = game({ name: "Titles Yearless", slug: "titles-yearless", release_year: 1999, release_iso: "1999-03-04", platforms_json: JSON.stringify(["n64"]) } as Partial<GameRow>);
    const t = (db.query("INSERT INTO titles (slug, name, sort_name) VALUES ('titles-yearless', 'Titles Yearless', 'titles yearless') RETURNING id").get() as { id: number }).id;
    own([t]);
    stmts.setGameTitle.run(t, g.id);
    withWay(stmts.gameById.get(g.id) as GameRow);
    expect(collectSync().find(c => c.title.gameId === g.id)!.title).toMatchObject({ year: 1999, releaseIso: "1999-03-04", platforms: ["n64"] });
    reingestCustom();
    expect(db.query("SELECT year, release_iso, platforms_json FROM titles WHERE id=?").get(t)).toEqual({ year: 1999, release_iso: "1999-03-04", platforms_json: '["n64"]' });
  });
});

describe("a game keeps the title another source gave it (ways-api-9)", () => {
  test("a Steam game whose games.title_id was never set: its way goes under the Steam title, with no second title", async () => {
    const g = game({ steam_appid: 995_401, name: "Titles Quake", slug: "titles-quake", release_year: 1996 } as Partial<GameRow>);
    ingest(steamProvider, (await steamProvider.collect({} as never)).filter(c => c.title.gameId === g.id));
    const steam = titlesNamed("titles quake");
    own(steam.map(t => t.id));
    expect(steam).toEqual([{ id: steam[0].id, year: 1996, gameId: g.id, source: "steam" }]);
    expect((stmts.gameById.get(g.id) as GameRow).title_id).toBeNull();
    withWay(g);
    reingestCustom();
    expect(titlesNamed("titles quake").map(t => t.id)).toEqual([steam[0].id]);
    expect((stmts.gameById.get(g.id) as GameRow).title_id).toBe(steam[0].id);
    expect(gameDetail(g.id)!.routes.map((r: { source: string }) => r.source).sort()).toEqual(["custom", "steam"]);
  });

  test("a title its Steam id names (listed from the store feeds, held by no game) is the one it gets", () => {
    const t = (db.query("INSERT INTO titles (slug, name, sort_name, year) VALUES ('titles-feed-game', 'Titles Feed Game', 'titles feed game', 2001) RETURNING id").get() as { id: number }).id;
    own([t]);
    db.query("INSERT INTO title_ids (scheme, value, title_id, source) VALUES ('steam', '995402', ?, 'steam')").run(t);
    const g = game({ steam_appid: 995_402, name: "Titles Feed Game", slug: "titles-feed-game", release_year: 2001 } as Partial<GameRow>);
    expect(ensureTitle(g)).toBe(t);
    expect(db.query("SELECT game_id FROM titles WHERE id=?").get(t)).toEqual({ game_id: g.id });
    // one another game holds is never taken
    const t2 = (db.query("INSERT INTO titles (slug, name, sort_name, game_id) VALUES ('titles-held', 'Titles Held', 'titles held', ?) RETURNING id").get(g.id) as { id: number }).id;
    own([t2]);
    db.query("INSERT INTO title_ids (scheme, value, title_id, source) VALUES ('steam', '995403', ?, 'steam')").run(t2);
    const other = game({ steam_appid: 995_403, name: "Titles Held", slug: "titles-held", release_year: 2002 } as Partial<GameRow>);
    const mine = ensureTitle(other);
    own([mine]);
    expect(mine).not.toBe(t2);
  });
});

describe("by name, a title a library game holds is no other game's (ways-api-1, when a year is missing)", () => {
  const steamOf = async (g: GameRow) => (await steamProvider.collect({} as never)).filter(c => c.title.gameId === g.id);
  const routesOf = (g: GameRow) => gameDetail(g.id)!.routes.map((r: { source: string }) => r.source);
  function handAdded(name: string, slug: string, year: number | null, platforms = ["pc"]): GameRow {
    const g = game({ name, slug, release_year: year, platforms_json: JSON.stringify(platforms), source: "manual" } as Partial<GameRow>);
    withWay(g);
    reingestCustom();
    return g;
  }

  test("a game added by hand with no year, then a Steam game of the same name: each keeps a title of its own", async () => {
    const old = handAdded("Titles Thief", "titles-thief", null);
    const steam = game({ steam_appid: 995_410, name: "Titles Thief", slug: "titles-thief-2014", release_year: 2014 } as Partial<GameRow>);
    ingest(steamProvider, await steamOf(steam));
    const titles = titlesNamed("titles thief");
    own(titles.map(t => t.id));
    expect(titles.map(t => [t.year, t.gameId, t.source])).toEqual([[null, old.id, "custom"], [2014, steam.id, "steam"]]);
    expect(routesOf(old)).toEqual(["custom"]);
  });

  test("a game added by hand, then a tracked Steam game of the same name that has no date yet: two titles", async () => {
    const old = handAdded("Titles Evil", "titles-evil", 2005);
    const tracked = game({ steam_appid: 995_411, name: "Titles Evil", slug: "titles-evil-remake", release_year: null } as Partial<GameRow>);
    ingest(steamProvider, await steamOf(tracked));
    const titles = titlesNamed("titles evil");
    own(titles.map(t => t.id));
    expect(titles.map(t => [t.year, t.gameId])).toEqual([[2005, old.id], [null, tracked.id]]);
    expect(routesOf(old)).toEqual(["custom"]);
  });

  test("a Steam game in the library of the same name and year as one added by hand: two games are never one title", async () => {
    const old = handAdded("Titles Arx", "titles-arx", 2002);
    const steam = game({ steam_appid: 995_413, name: "Titles Arx", slug: "titles-arx-steam", release_year: 2002 } as Partial<GameRow>);
    ingest(steamProvider, await steamOf(steam));
    const titles = titlesNamed("titles arx");
    own(titles.map(t => t.id));
    expect(titles.map(t => [t.year, t.gameId])).toEqual([[2002, old.id], [2002, steam.id]]);
    expect(routesOf(old)).toEqual(["custom"]);
  });

  test("a store listing of the same name with no date, held by no game: its own title, and its Steam id names that one", () => {
    const old = handAdded("Titles System", "titles-system", 1994);
    // what steamProvider lists for a store-feed entry the library does not have: its Steam id, no year while it is TBA
    const listing: Contribution = {
      title: { ids: [{ scheme: "steam", value: "995412" }], name: "Titles System", platforms: ["pc"], year: null, releaseIso: null },
      routes: [{ key: "app/995412", kind: "native", platform: "pc", label: "Steam" }],
    };
    ingest(steamProvider, [listing]);
    const titles = titlesNamed("titles system");
    own(titles.map(t => t.id));
    expect(titles.map(t => [t.year, t.gameId])).toEqual([[1994, old.id], [null, null]]);
    expect(db.query("SELECT title_id FROM title_ids WHERE scheme='steam' AND value='995412'").get()).toEqual({ title_id: titles[1].id });
    expect(routesOf(old)).toEqual(["custom"]);
  });

  test("a compatibility list (console serials, no year) still reaches the held title by name", () => {
    const g = handAdded("Titles Ico", "titles-ico", 2001, ["ps2"]);
    const held = titlesNamed("titles ico");
    own(held.map(t => t.id));
    ingest({ id: "titles-compat", metaRank: 30 }, [{
      title: { ids: [{ scheme: "serial", value: "SCUS-99541" }], name: "Titles Ico", platforms: ["ps2"] },
      routes: [{ key: "SCUS-99541", kind: "emulated", platform: "ps2", label: "PCSX2", status: "playable" }],
    }]);
    expect(titlesNamed("titles ico").map(t => [t.id, t.gameId])).toEqual([[held[0].id, g.id]]);
    expect(db.query("SELECT title_id FROM title_ids WHERE scheme='serial' AND value='SCUS-99541'").get()).toEqual({ title_id: held[0].id });
  });
});
