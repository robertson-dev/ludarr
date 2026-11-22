import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillGameSources, db, serializeGame, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { addGame, deleteGame, gameDetail, lookup, onGameChange, refreshGame, serializeLibraryGame, statusOf, updateDetails } from "../src/library/games";
import { gamesApi } from "../src/api/games";
import { normName } from "../src/catalog/store";
import { cdeps } from "../src/catalog/worker";
import { ddeps, followsTick } from "../src/discover";
import * as registry from "../src/plugins/registry";

const saved = { sources: cdeps.sources, ddeps: { ...ddeps } };
afterAll(() => {
  cdeps.sources = saved.sources; Object.assign(ddeps, saved.ddeps);
  db.exec("DELETE FROM requests; DELETE FROM follows; DELETE FROM jobs; DELETE FROM packages; DELETE FROM games; DELETE FROM routes; DELETE FROM title_names; DELETE FROM title_ids; DELETE FROM titles");
});

beforeEach(() => {
  process.env.LUDARR_CONFIG = mkdtempSync(join(tmpdir(), "ludarr-manual-"));
  db.exec("DELETE FROM requests; DELETE FROM follows; DELETE FROM jobs; DELETE FROM packages; DELETE FROM games; DELETE FROM routes; DELETE FROM title_names; DELETE FROM title_ids; DELETE FROM titles; DELETE FROM plugin_instances WHERE kind='metadata'");
  registry.clearCache();
  cdeps.sources = saved.sources;
  ddeps.log = () => {};
});

const post = async (body: unknown) => gamesApi.request("/api/v1/game", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = async (id: number, body: unknown) => gamesApi.request(`/api/v1/game/${id}/details`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const steamGame = (appid: number, name: string, year: number | null, extra: Record<string, unknown> = {}) => upsertGame({ igdb_id: null, steam_appid: appid, name, slug: name.toLowerCase().replace(/\W+/g, "-"), summary: null, storyline: null, release_year: year, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["win"]', game_modes_json: "[]", developer: null, publisher: null, ...extra });
const title = (name: string, year: number | null, gameId: number | null = null) => {
  const id = (db.query("INSERT INTO titles (slug, name, sort_name, year, platforms_json, game_id) VALUES (?,?,?,?,'[]',?) RETURNING id").get(`${name.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`, name, normName(name), year, gameId) as { id: number }).id;
  db.query("INSERT INTO title_names (norm, title_id) VALUES (?,?)").run(normName(name), id);
  return id;
};
const row = (id: number) => stmts.gameById.get(id) as GameRow;
const zelda = { name: "Zelda 64: Recompiled", aliases: ["Majora's Mask Recompiled", "zelda 64 recompiled", "Zelda 64: Recompiled"], platforms: ["Nintendo 64", "PC", "n64"], year: 2024, summary: "A native port.", genres: ["Action"], developer: "Wiseguy", publisher: null, searchTerms: ["zelda64recomp", "Zelda64Recomp"] };

describe("a game added by hand", () => {
  test("is stored as described: source manual, its own slug, platforms as ids, other names and search terms each once; a monitored one is searched at once", async () => {
    const res = await post({ source: "manual", game: zelda });
    expect(res.status).toBe(201);
    const { item } = await res.json() as { item: any };
    expect(item).toMatchObject({ source: "manual", name: "Zelda 64: Recompiled", slug: "zelda-64-recompiled", platforms: ["n64", "pc"], releaseYear: 2024, summary: "A native port.", genres: ["Action"], developer: "Wiseguy", publisher: null, monitored: true, customArt: [] });
    expect(item.aliases).toEqual(["Majora's Mask Recompiled"]);                 // the name again and a spelling of it are dropped
    expect(item.searchTerms).toEqual(["zelda64recomp"]);
    expect(item.status).toBe("searching"); expect(item.request.state).toBe("requested");
    // a second game of the same name in another year gets its own slug
    const again = await (await post({ source: "manual", game: { name: "Zelda 64: Recompiled", year: 2030 } })).json() as { item: any };
    expect(again.item.slug).toBe("zelda-64-recompiled-2030");
  });
  test("what validateGameDraft refuses is a 400, and nothing is stored", async () => {
    for (const game of [{}, { name: "" }, { name: "X", platforms: ["Atari Jaguar"] }, { name: "X", aliases: ["a", "b", "c", "d", "e", "f"] }, { name: "X", searchTerms: ["a", "b", "c", "d"] }, { name: "X", year: 2001, releaseIso: "2003-01-01" }]) {
      const res = await post({ source: "manual", game });
      expect({ game, status: res.status }).toEqual({ game, status: 400 });
    }
    expect((stmts.allGames.all() as GameRow[]).length).toBe(0);
  });
  test("the duplicate guard looks at every library game, whatever its source: the same name (or one it goes by) and a year at most one off is a 409 with the game's id, unless forced", async () => {
    const hades = steamGame(1145360, "Hades", 2020);
    let res = await post({ source: "manual", game: { name: "HADES", year: 2021 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ existingId: hades.id, error: expect.stringContaining("already in the library") });
    expect((await post({ source: "manual", game: { name: "Hades" } })).status).toBe(409);            // no year: the name alone is enough to ask
    expect((await post({ source: "manual", game: { name: "Hades", year: 2023 } })).status).toBe(201);  // another game of that name
    expect((await post({ source: "manual", game: { name: "Hades", year: 2021 }, force: true })).status).toBe(201);
    db.query("UPDATE games SET aliases_json=? WHERE id=?").run(JSON.stringify(["Biohazard 4"]), steamGame(254700, "Resident Evil 4", 2005).id);
    res = await post({ source: "manual", game: { name: "Biohazard 4", year: 2005 } });
    expect(res.status).toBe(409);
    expect((await post({ source: "manual", game: { name: "Leon's Story", aliases: ["Resident Evil 4"], year: 2006 } })).status).toBe(409);
  });
  test("it is linked to the catalog title of its name and year when no library game holds that title yet", async () => {
    const mm = title("The Legend of Zelda: Majora's Mask", 2000);
    const { item } = await (await post({ source: "manual", game: { name: "The Legend of Zelda: Majora's Mask", year: 2000, platforms: ["n64"] } })).json() as { item: any };
    expect(item.titleId).toBe(mm);
    expect((db.query("SELECT game_id FROM titles WHERE id=?").get(mm) as { game_id: number }).game_id).toBe(item.id);
    // another year, no year, a title another game holds, or two titles of that name and year: no link
    title("Doom", 2016);
    expect((await (await post({ source: "manual", game: { name: "Doom", year: 1993 } })).json() as { item: any }).item.titleId).toBeNull();
    title("Quake", null);
    expect((await (await post({ source: "manual", game: { name: "Quake", year: 1996 } })).json() as { item: any }).item.titleId).toBeNull();
    const other = steamGame(77, "Other", 1999);
    title("Heretic", 1994, other.id);
    expect((await (await post({ source: "manual", game: { name: "Heretic", year: 1994 } })).json() as { item: any }).item.titleId).toBeNull();
    title("Hexen", 1995); title("Hexen", 1996);
    expect((await (await post({ source: "manual", game: { name: "Hexen", year: 1995 } })).json() as { item: any }).item.titleId).toBeNull();
  });
  test("a catalog-only title added twice is one game, and the title knows its game", async () => {
    const t = title("Dinosaur Planet", 2000);
    const a = await addGame({ source: "catalog", id: t, searchNow: false });
    expect(a.source).toBe("catalog");
    expect((db.query("SELECT game_id FROM titles WHERE id=?").get(t) as { game_id: number }).game_id).toBe(a.id);
    const b = await addGame({ source: "catalog", id: t, searchNow: false });
    expect(b.id).toBe(a.id);
    // a game added before titles remembered it: found by its title, and the title claimed
    db.query("UPDATE titles SET game_id=NULL WHERE id=?").run(t);
    expect((await addGame({ source: "catalog", id: t, searchNow: false })).id).toBe(a.id);
    expect((db.query("SELECT game_id FROM titles WHERE id=?").get(t) as { game_id: number }).game_id).toBe(a.id);
    expect((stmts.allGames.all() as GameRow[]).length).toBe(1);
  });
  test("Refresh has nothing to read a hand-made game from", async () => {
    const { item } = await addGame({ source: "manual", game: { name: "Ghost Game" }, searchNow: false }).then(i => ({ item: i }));
    await expect(refreshGame(item.id)).rejects.toThrow("a game added by hand has no source to refresh it from");
    expect((await gamesApi.request(`/api/v1/game/${item.id}/refresh`, { method: "POST" })).status).toBe(400);
  });
});

describe("editing a game's details", () => {
  test("a game added by hand: every field of its description; the slug stays; the name never comes back as an alias", async () => {
    const g = await addGame({ source: "manual", game: { name: "Old Name", year: 2001, aliases: ["New Name"] }, searchNow: false });
    const res = await put(g.id, { name: "New Name", summary: "S", platforms: ["SNES", "pc"], releaseIso: "2001-06-01", genres: ["RPG"], developer: "D", publisher: "P", searchTerms: ["old name snes"] });
    expect(res.status).toBe(200);
    const { item } = await res.json() as { item: any };
    expect(item).toMatchObject({ name: "New Name", slug: "old-name", summary: "S", platforms: ["snes", "pc"], releaseIso: "2001-06-01", releaseYear: 2001, genres: ["RPG"], developer: "D", publisher: "P", searchTerms: ["old name snes"], aliases: [] });
    expect((await put(g.id, { aliases: ["Kyuu Namae", "kyuu namae", "New Name"] }).then(r => r.json()) as { item: any }).item.aliases).toEqual(["Kyuu Namae"]);
    // the date sets the year when only the date changes; a year the date contradicts is refused
    expect((await put(g.id, { releaseIso: "2003-02-02" }).then(r => r.json()) as { item: any }).item.releaseYear).toBe(2003);
    expect((await put(g.id, { year: 1999 })).status).toBe(400);
    expect((await put(g.id, { year: null, releaseIso: null }).then(r => r.json()) as { item: any }).item).toMatchObject({ releaseYear: null, releaseIso: null });
  });
  test("a Steam, IGDB or catalog game: only the names it goes by and its search terms (400 naming any other field)", async () => {
    const hades = steamGame(1145360, "Hades", 2020);
    const ok = await put(hades.id, { aliases: ["Hades Underworld"], searchTerms: ["hades supergiant"] });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { item: any }).item).toMatchObject({ aliases: ["Hades Underworld"], searchTerms: ["hades supergiant"], name: "Hades" });
    let res = await put(hades.id, { name: "Hades II" });
    expect(res.status).toBe(400); expect((await res.json() as { error: string }).error).toMatch(/^name comes from Steam/);
    res = await put(hades.id, { summary: "x", year: 2021, aliases: [] });
    expect(res.status).toBe(400); expect((await res.json() as { error: string }).error).toMatch(/^summary, year come from Steam/);
    expect(row(hades.id).aliases_json).toBe(JSON.stringify(["Hades Underworld"]));          // nothing of a refused edit is kept
  });
  test("a field it does not know, an empty edit, and too many names are refused rather than ignored", async () => {
    const g = await addGame({ source: "manual", game: { name: "Thing" }, searchNow: false });
    for (const [body, re] of [[{ monitored: false }, /not a field of a game's details: monitored/], [{}, /nothing to change/], [{ aliases: ["a", "b", "c", "d", "e", "f"] }, /aliases: at most 5/], [{ searchTerms: ["a", "b", "c", "d"] }, /searchTerms: at most 3/], [[1], /an object/]] as [unknown, RegExp][]) {
      const res = await put(g.id, body);
      expect(res.status).toBe(400); expect((await res.json() as { error: string }).error).toMatch(re);
    }
    expect((await put(424242, { name: "x" })).status).toBe(404);
  });
  test("renaming a hand-made game onto another library game is a 409 unless forced", async () => {
    const hades = steamGame(1145360, "Hades", 2020);
    const g = await addGame({ source: "manual", game: { name: "Hadez", year: 2020 }, searchNow: false });
    const res = await put(g.id, { name: "Hades" });
    expect(res.status).toBe(409); expect(await res.json()).toMatchObject({ existingId: hades.id });
    expect((await put(g.id, { name: "Hades", force: true })).status).toBe(200);
  });
});

describe("what the library says about a game", () => {
  test("upsertGame records where a new row came from, and keeps an existing row's origin; the backfill fixes IGDB rows stored as Steam", () => {
    expect(steamGame(5, "S", null).source).toBe("steam");
    expect(upsertGame({ igdb_id: 7, name: "I", slug: "i" }).source).toBe("igdb");
    expect(upsertGame({ steam_appid: 8, name: "C", slug: "c", source: "catalog" }).source).toBe("catalog");
    expect(upsertGame({ steam_appid: 8, name: "C2", slug: "c" }).source).toBe("catalog");
    const wrong = db.query("INSERT INTO games (name, igdb_id, source) VALUES ('Old IGDB', 99, 'steam') RETURNING id").get() as { id: number };
    const manual = db.query("INSERT INTO games (name, source) VALUES ('Hand', 'manual') RETURNING id").get() as { id: number };
    expect(backfillGameSources()).toBe(1);
    expect(row(wrong.id).source).toBe("igdb"); expect(row(manual.id).source).toBe("manual");
    expect(backfillGameSources()).toBe(0);
  });
  test("serializeGame carries source, aliases, searchTerms, the kinds of art set by hand and when they changed", () => {
    const g = steamGame(11, "Art Game", 2001);
    db.query("UPDATE games SET aliases_json=?, search_terms_json=?, art_json=? WHERE id=?").run('["A"]', '["t"]', JSON.stringify({ poster: "upload:game-1-poster.png", logo: "upload:game-1-logo.webp", bogus: "upload:x", at: 1234 }), g.id);
    expect(serializeGame(row(g.id))).toMatchObject({ source: "steam", aliases: ["A"], searchTerms: ["t"], customArt: ["poster", "logo"], customArtAt: 1234 });
    expect(serializeGame(steamGame(12, "Plain", null))).toMatchObject({ aliases: [], searchTerms: [], customArt: [], customArtAt: null });
  });
  test("a way being built or its game file taken in shows 'importing · preparing' until the game has a copy players can start; the AI working out a way changes nothing", () => {
    const g = steamGame(21, "Way Game", 2001);
    const job = (kind: string, state = "queued") => { const j = stmts.insertJobOf.get(null, null, g.id, `way:${kind}`, kind, "{}", null) as JobRow; if (state !== "queued") db.query("UPDATE jobs SET state=? WHERE id=?").run(state, j.id); return j; };
    const status = () => { const s = serializeLibraryGame(row(g.id)); return `${s.status}:${s.statusDetail}`; };
    expect(status()).toBe("missing:no copy yet");
    job("construct"); job("construct", "running");
    expect(status()).toBe("missing:no copy yet");
    const a = job("assemble");
    expect(status()).toBe("importing:preparing");
    db.query("UPDATE jobs SET state='running', message='downloading the program from GitHub' WHERE id=?").run(a.id);
    expect(status()).toBe("importing:preparing");                                     // never the job's own (admin-facing) message
    db.query("UPDATE jobs SET state='done' WHERE id=?").run(a.id);
    job("content", "running");
    expect(status()).toBe("importing:preparing");
    const rom = stmts.insertPackage.get(g.id, null, "/lib/way", "Way", null, 1e6, JSON.stringify({ kind: "rom" })) as PackageRow;
    expect(status()).toBe("importing:preparing");                                     // a dump is not a copy players can start
    stmts.insertPackage.get(g.id, null, "/lib/way2", "Way", null, 1e6, JSON.stringify({ kind: "emulated" }));
    expect(status()).toMatch(/^available:/);
    expect(statusOf(row(g.id), rom, null, { kind: "assemble", state: "queued" } as JobRow).status).toBe("importing");
    expect(statusOf(row(g.id), rom, null, { kind: "construct", state: "running" } as JobRow).status).toBe("available");
  });
  test("a copy says what it is and which launcher it needs", () => {
    const g = steamGame(31, "Kinds", 2001);
    stmts.insertPackage.get(g.id, null, "/lib/k", "K", null, 1, JSON.stringify({ launch: { exe: "a.exe" } }));
    expect(serializeLibraryGame(row(g.id)).file).toMatchObject({ kind: "native", requiresLauncher: null });
    stmts.insertPackage.get(g.id, null, "/lib/k2", "K", null, 1, JSON.stringify({ kind: "emulated", requires: { launcher: "0.10.0" }, launch: { exe: "x.exe" } }));
    expect(serializeLibraryGame(row(g.id)).file).toMatchObject({ kind: "emulated", requiresLauncher: "0.10.0" });
    expect(gameDetail(g.id)!.jobs).toEqual([]);
  });
});

describe("finding and tracking", () => {
  test("lookup answers with library games found by their name or by a name they go by, whatever their source — each game once", async () => {
    const z = await addGame({ source: "manual", game: { name: "Zelda 64: Recompiled", aliases: ["Majora's Mask Recompiled"], year: 2024 }, searchNow: false });
    let hits = await lookup("majora");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: { scheme: "game", value: String(z.id) }, name: "Zelda 64: Recompiled", source: "library", gameId: z.id, status: "missing", year: 2024 });
    expect((await lookup("zelda 64"))[0].gameId).toBe(z.id);
    // a Steam game in the library and the catalog's title for it: one hit, the library's
    const hades = steamGame(1145360, "Hades", 2020);
    const t = title("Hades", 2020);
    db.query("INSERT INTO title_ids (scheme, value, title_id, source) VALUES ('steam', '1145360', ?, 'steam')").run(t);
    db.query("INSERT INTO routes (title_id, kind, platform, provenance, source, source_key) VALUES (?, 'native', 'pc', 'retail', 'steam', 'steam:1')").run(t);
    cdeps.sources = () => [{ id: 1, name: "Steam", source: { id: "steam", label: "Steam", about: "", every: 60, metaRank: 80, collect: async () => [] } as never }];
    hits = await lookup("hades");
    expect(hits.filter(h => h.gameId === hades.id)).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: { scheme: "steam", value: "1145360" }, source: "library" });
    expect(await lookup("nothing like it")).toEqual([]);
  });
  test("a hand-made game that is not out yet is tracked by its own date and requested on the day; an edit of the date moves the track", async () => {
    const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const created: { gameId?: number; by?: string }[] = [];
    ddeps.createRequest = opt => { created.push(opt); return { request: { id: 1 } as never, duplicate: false }; };
    ddeps.now = () => Date.now();
    const g = await addGame({ source: "manual", game: { name: "Future Game", releaseIso: day } });
    expect(g.status).toBe("unreleased"); expect(g.tracked).toBe(true); expect(g.request).toBeNull();
    const f = stmts.followByGame.get(g.id) as { release_iso: string; coming_soon: number };
    expect(f).toMatchObject({ release_iso: day, coming_soon: 1 });
    await followsTick();
    expect(created).toEqual([]);
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    await updateDetails(g.id, { releaseIso: later });
    await followsTick();
    expect((stmts.followByGame.get(g.id) as { release_iso: string }).release_iso).toBe(later);
    ddeps.now = () => Date.parse(later + "T09:00:00Z");
    await followsTick();
    expect(created).toEqual([{ gameId: g.id, by: "tracker" }]);
  });
  test("whoever follows game changes hears adds, edits, art and deletes", async () => {
    const heard: string[] = [];
    const off = onGameChange((id, how) => heard.push(`${how}:${id}`));
    try {
      const g = await addGame({ source: "manual", game: { name: "Heard" }, searchNow: false });
      await updateDetails(g.id, { summary: "now" });
      await deleteGame(g.id);
      expect(heard).toEqual([`added:${g.id}`, `changed:${g.id}`, `deleted:${g.id}`]);
    } finally { off(); }
  });
});
