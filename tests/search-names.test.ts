import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db, stmts, type GameRow, type RequestRow } from "../src/db";
import { buildQuery, certainlyThisGame, nameQueries, queryPlan, rankForNames, rankReleases } from "../src/releases";
import * as requests from "../src/requests";
import { rdeps, createRequest, requestsTick } from "../src/requests";
import { sdeps, searchReleases } from "../src/search";
import { isFor } from "../src/rss";
import { activityApi } from "../src/api/activity";
import { createProfile } from "../src/library/profiles";
import type { ProwlarrRelease } from "../src/prowlarr";
import type { Indexer, Release } from "../src/plugins/types";

const rel = (title: string, over: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: title, title, instanceId: 1, indexerId: 1, indexer: "T", size: 20e9, age: 10, publishDate: "", seeders: 10, leechers: 0,
  grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent",
  categories: [], indexerFlags: [], fileName: null, ...over,
});

const saved = { indexers: sdeps.indexers, rdeps: { ...rdeps } };
afterAll(() => {
  sdeps.indexers = saved.indexers; Object.assign(rdeps, saved.rdeps);
  db.exec("DELETE FROM requests; DELETE FROM fetches; DELETE FROM games; DELETE FROM profiles WHERE name LIKE 'Names %'");
});

/** a fake indexer: answers each query from a table, and remembers what it was asked */
function fakeIndexer(answers: Record<string, string[]>) {
  const asked: string[] = [];
  const indexer: Indexer = {
    test: async () => ({ ok: true, detail: "" }),
    search: async (q: string) => { asked.push(q); return (answers[q.toLowerCase()] ?? []).map(t => rel(t) as unknown as Release); },
    download: async () => { throw new Error("no"); },
  };
  return { asked, indexer };
}

describe("one release, judged under every name the game goes by", () => {
  test("an alias finds a release listed only under it, and the view carries that alias's score and flags", () => {
    const qs = nameQueries("Resident Evil 4", 2005, ["Biohazard 4"]);
    const [v] = rankForNames(qs, [rel("Biohazard.4-RELOADED")]);
    const [own] = rankReleases(buildQuery("Biohazard 4", 2005), [rel("Biohazard.4-RELOADED")]);
    expect(rankReleases(qs[0], [rel("Biohazard.4-RELOADED")])).toEqual([]);            // the game's own name does not even match it
    expect(v.matchedName).toBe("Biohazard 4");
    expect(certainlyThisGame(v)).toBe(true);
    expect({ score: v.score, flags: v.flags, match: v.match, reasons: v.reasons }).toEqual({ score: own.score, flags: own.flags, match: own.match, reasons: own.reasons });
  });
  test("a release certain only under an alias is kept as that alias's view, even when the game's own name scores it higher", () => {
    const qs = nameQueries("Kingdom Hearts: Final Mix", 2002, ["Kingdom Hearts Final Mix HD"]);
    const r = rel("Kingdom.Hearts.Final.Mix.HD-CODEX");
    const [mine] = rankReleases(qs[0], [r]), [alias] = rankReleases(qs[1], [r]);
    expect(certainlyThisGame(mine)).toBe(false); expect(mine.flags.extraWords).toBe(true);       // "HD" after the name
    expect(certainlyThisGame(alias)).toBe(true);
    expect(mine.score).toBeGreaterThan(alias.score);                                             // the subtitle bonus
    const [v] = rankForNames(qs, [r]);
    expect(v.matchedName).toBe("Kingdom Hearts Final Mix HD");
    expect({ score: v.score, flags: v.flags }).toEqual({ score: alias.score, flags: alias.flags });
    // and the other way round: the buried name of the game's own view is not paired with the alias's certainty
    const [doom] = rankForNames(nameQueries("Doom", 1993, ["The Ultimate Doom"]), [rel("The.Ultimate.Doom-GOG")]);
    expect(doom.matchedName).toBe("The Ultimate Doom"); expect(doom.flags.buried).toBe(false); expect(certainlyThisGame(doom)).toBe(true);
  });
  test("when no name makes it certain, the best-scoring view is kept (the interactive list still shows it)", () => {
    const qs = nameQueries("The Legend of Zelda: Majora's Mask", 2000, ["Zelda Majora"]);
    const [v] = rankForNames(qs, [rel("The.Legend.of.Zelda.Ocarina.of.Time.USA.N64-PDX")], { platforms: ["n64"] });
    expect(certainlyThisGame(v)).toBe(false); expect(v.matchedName).toBe("The Legend of Zelda: Majora's Mask");
  });
  test("a franchise-only alias (\"Zelda\") never makes a sequel or another entry certain", () => {
    const qs = nameQueries("The Legend of Zelda: Majora's Mask", 2000, ["Zelda"]);
    const titles = [
      "Zelda.II.The.Adventure.of.Link.USA.NES-HOODLUM", "Zelda.3.USA.SNES-PDX", "Zelda.Breath.of.the.Wild-CODEX",
      "The.Legend.of.Zelda.Ocarina.of.Time.USA.N64-PDX", "Legend.of.Zelda.The.USA.NES-PDX", "Zelda 2 (USA) NES",
    ];
    for (const platforms of [undefined, ["n64"], ["nes"], ["snes"]] as ("n64" | "nes" | "snes")[][] | undefined[]) {
      const views = rankForNames(qs, titles.map(t => rel(t)), { platforms: platforms as never });
      for (const v of views) expect({ title: v.title, certain: certainlyThisGame(v) }).toEqual({ title: v.title, certain: false });
    }
    expect(rankForNames(qs, [rel("Zelda.II.The.Adventure.of.Link.USA.NES-HOODLUM")], { platforms: ["nes"] })[0].flags.sequel).toBe(true);
  });
  test("the same torrent found under two names is one row", () => {
    const qs = nameQueries("Resident Evil 4", 2005, ["Biohazard 4"]);
    const out = rankForNames(qs, [rel("Resident.Evil.4.Biohazard.4-RELOADED", { infoHash: "AA", indexer: "A" }), rel("Resident.Evil.4.Biohazard.4-RELOADED", { infoHash: "aa", indexer: "B", guid: "x2" })]);
    expect(out).toHaveLength(1); expect(out[0].alsoOn).toEqual(["B"]);
  });
});

describe("what a search asks", () => {
  test("the order: the name [name + year when short, full, head]; each alias's full name (+ year when short); every search term as typed; the aliases' heads — each once", () => {
    expect(queryPlan("The Legend of Zelda: Majora's Mask", 2000, ["Zelda: Majora's Mask 64", "Mujura no Kamen"], ["Majora N64", "the legend of zelda"])).toEqual([
      { text: "The Legend of Zelda Majora's Mask", kind: "name" },
      { text: "The Legend of Zelda", kind: "name" },
      { text: "Zelda Majora's Mask 64", kind: "alias" },
      { text: "Mujura no Kamen", kind: "alias" },
      { text: "Majora N64", kind: "term" },
      { text: "Zelda", kind: "head" },
    ]);
    expect(queryPlan("INSIDE", 2016, ["Inside Playdead"], ["inside 2016"]).map(q => q.text)).toEqual(["INSIDE 2016", "INSIDE", "Inside Playdead 2016", "Inside Playdead"]);
    expect(queryPlan("Hades", null).map(q => q.text)).toEqual(buildQuery("Hades").queries);       // a game without other names asks what it always did
  });
  test("five aliases and three search terms are all asked, even by the interactive search that stops early", async () => {
    const aliases = ["Alpha One", "Beta Two", "Gamma Three", "Delta Four", "Epsilon Five"], terms = ["term one", "term two", "term three"];
    const many = Array.from({ length: 12 }, (_, i) => `Hades.v1.${i}-CODEX`);
    const f = fakeIndexer({ hades: many });
    sdeps.indexers = () => [{ id: 1, name: "Fake", indexer: f.indexer }];
    const res = await searchReleases("Hades: Underworld", null, { aliases, terms });
    for (const a of aliases) expect(f.asked).toContain(a);
    for (const t of terms) expect(f.asked).toContain(t);
    expect(res.queries.map(q => q.name)).toEqual(["Hades: Underworld", ...aliases]);
    expect(res.query.name).toBe("Hades: Underworld");
  });
  test("a search term that returns another game's release brings back nothing that is not the game", async () => {
    const f = fakeIndexer({ "majora n64": ["The.Legend.of.Zelda.Ocarina.of.Time.USA.N64-PDX", "Banjo.Kazooie.USA.N64-PDX"] });
    sdeps.indexers = () => [{ id: 1, name: "Fake", indexer: f.indexer }];
    const res = await searchReleases("The Legend of Zelda: Majora's Mask", 2000, { terms: ["Majora N64"], thorough: true, platforms: ["n64"] });
    expect(f.asked).toContain("Majora N64");
    expect(res.ranked.filter(certainlyThisGame)).toEqual([]);
    expect(res.ranked.map(r => r.title)).not.toContain("Banjo.Kazooie.USA.N64-PDX");
  });
});

describe("the searcher, RSS and the interactive search use every name", () => {
  let game: GameRow;
  const grabs: string[] = [];
  beforeEach(() => {
    db.exec("DELETE FROM requests; DELETE FROM jobs; DELETE FROM packages; DELETE FROM fetches; DELETE FROM games; DELETE FROM blocklist;");
    game = stmts.upsertGame({ igdb_id: null, steam_appid: 990771, name: "Resident Evil 4", slug: "re4", summary: null, storyline: null, release_year: 2005, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["win"]', game_modes_json: "[]", developer: null, publisher: null });
    // its own profile: the PC pass, then the console fallback, whatever profiles other tests left behind
    const prof = createProfile({ name: `Names ${Math.random().toString(36).slice(2, 8)}`, consoleFallback: true });
    db.query("UPDATE games SET aliases_json=?, search_terms_json=?, profile_id=? WHERE id=?").run(JSON.stringify(["Biohazard 4"]), JSON.stringify(["re4 pc"]), prof.id, game.id);
    grabs.length = 0;
    rdeps.log = () => {}; rdeps.now = () => Date.now(); rdeps.usenetAvailable = async () => false; rdeps.agentReady = () => false;
    rdeps.grab = async (r, gameId) => {
      grabs.push(r.title);
      const row = stmts.insertFetch({ game_id: gameId, guid: r.guid, indexer_id: r.indexerId, indexer: r.indexer, title: r.title, protocol: r.protocol, size: r.size, info_hash: null, client: "rtorrent", client_id: "x", state: "submitted", release_json: JSON.stringify(r) });
      return { fetch: { id: row.id } as never, duplicate: false };
    };
  });
  test("both passes of the automatic searcher send the game's aliases and search terms", async () => {
    const calls: unknown[] = [];
    rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { ranked: [] }; };
    // a PC game that names a console it is on: the console pass is for that console (review round: a PC game with no console
    // it is known to be on never falls back to "any console" — MW4 would take a 40 MB "PS5" post)
    db.query("UPDATE games SET platforms_json=? WHERE id=?").run('["win","PS4"]', game.id);
    createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatchObject({ aliases: ["Biohazard 4"], terms: ["re4 pc"] });
    expect(calls[1]).toMatchObject({ platforms: ["ps4"], known: ["ps4"] });
    db.exec("DELETE FROM requests"); calls.length = 0;
    db.query("UPDATE games SET platforms_json=? WHERE id=?").run('["win"]', game.id);
    createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls).toHaveLength(1);                                         // a PC game alone: its PC copy is the one to wait for
  });
  test("a release only an alias names is grabbed; what a search term brings back for another game is not", async () => {
    rdeps.search = searchReleases;
    const f = fakeIndexer({ "re4 pc": ["Devil.May.Cry.4-RELOADED"], "biohazard 4": ["Biohazard.4-RELOADED"] });
    sdeps.indexers = () => [{ id: 1, name: "Fake", indexer: f.indexer }];
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(f.asked).toEqual(expect.arrayContaining(["Resident Evil 4", "Biohazard 4", "re4 pc"]));
    expect(grabs).toEqual(["Biohazard.4-RELOADED"]);
    expect((stmts.requestById.get(request.id) as RequestRow).state).toBe("fetching");
    // nothing but the other game: nothing is grabbed
    db.exec("DELETE FROM requests; DELETE FROM fetches;"); grabs.length = 0;
    const g = fakeIndexer({ "re4 pc": ["Devil.May.Cry.4-RELOADED"] });
    sdeps.indexers = () => [{ id: 1, name: "Fake", indexer: g.indexer }];
    createRequest({ gameId: game.id });
    await requestsTick();
    expect(g.asked).toContain("re4 pc"); expect(grabs).toEqual([]);
  });
  test("an RSS feed item is the game under any of its names; a search term never makes one the game", () => {
    const item = rel("Biohazard.4-RELOADED") as unknown as Release;
    expect(isFor(item, { name: "Resident Evil 4", year: 2005 })).toBe(false);
    expect(isFor(item, { name: "Resident Evil 4", year: 2005, aliases: ["Biohazard 4"] })).toBe(true);
    expect(isFor(rel("Devil.May.Cry.4-RELOADED") as unknown as Release, { name: "Resident Evil 4", year: 2005, aliases: ["Biohazard 4"] })).toBe(false);
  });
  test("GET /release asks the game's own names, or the ones listed (≤ 5 aliases, ≤ 3 terms) for a game not saved yet", async () => {
    const f = fakeIndexer({ "biohazard 4": ["Biohazard.4-RELOADED"] });
    sdeps.indexers = () => [{ id: 1, name: "Fake", indexer: f.indexer }];
    const own = await (await activityApi.request(`/api/v1/release?gameId=${game.id}`)).json() as any;
    expect(own.searched).toEqual(expect.arrayContaining(["Resident Evil 4", "Biohazard 4", "re4 pc"]));
    expect(own.game).toMatchObject({ aliases: ["Biohazard 4"], terms: ["re4 pc"] });
    expect(own.queries.map((q: { name: string }) => q.name)).toEqual(["Resident Evil 4", "Biohazard 4"]);
    const hit = own.items.find((i: { title: string }) => i.title === "Biohazard.4-RELOADED");
    expect(hit).toMatchObject({ matchedName: "Biohazard 4", certain: true });
    f.asked.length = 0;
    const draft = await (await activityApi.request("/api/v1/release?term=Resident%20Evil%204&year=2005&aliases=Biohazard%204&terms=re4%20remake")).json() as any;
    expect(f.asked).toEqual(expect.arrayContaining(["Biohazard 4", "re4 remake"]));
    expect(draft.items.some((i: { title: string; certain: boolean }) => i.title === "Biohazard.4-RELOADED" && i.certain)).toBe(true);
    const six = await activityApi.request(`/api/v1/release?term=X&${["a", "b", "c", "d", "e", "f"].map(a => `aliases=${a}`).join("&")}`);
    expect(six.status).toBe(400); expect(((await six.json()) as { error: string }).error).toMatch(/aliases: at most 5/);
    const four = await activityApi.request(`/api/v1/release?term=X&${["a", "b", "c", "d"].map(a => `terms=${a}`).join("&")}`);
    expect(four.status).toBe(400);
  });
  test("certainlyThisGame lives with the ranking and is still importable from the searcher", () => {
    expect(requests.certainlyThisGame).toBe(certainlyThisGame);
  });
  test("GET /release says, for each release, why the automatic searcher would not take it (Fix A)", async () => {
    const f = fakeIndexer({ "resident evil 4": ["Resident.Evil.4.Update.v1.1-RELOADED", "Resident.Evil.4-RELOADED", "Resident Evil 4 (Demo)", "Resident.Evil.4.Biohazard.4.Repack-P2P.exe.rar"] });
    sdeps.indexers = () => [{ id: 1, name: "Fake", indexer: f.indexer }];
    const own = await (await activityApi.request(`/api/v1/release?gameId=${game.id}`)).json() as { items: { title: string; certain: boolean; allowed: boolean; refusals: string[] }[] };
    const by = Object.fromEntries(own.items.map(i => [i.title, i]));
    expect(by["Resident.Evil.4-RELOADED"]).toMatchObject({ certain: true, refusals: [], allowed: true });
    expect(by["Resident.Evil.4.Update.v1.1-RELOADED"]).toMatchObject({ certain: false, refusals: ["an update or a patch, not the game"], allowed: false });
    expect(by["Resident Evil 4 (Demo)"]).toMatchObject({ certain: false, refusals: ["(Demo): a demo, not the game as it was sold"] });
    expect(by["Resident.Evil.4.Biohazard.4.Repack-P2P.exe.rar"].refusals).toContain("a file name, not a release (.exe.rar)");
  });
});
