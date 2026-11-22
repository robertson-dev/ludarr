import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, type RequestRow, type JobRow, type GameRow } from "../src/db";
import { rdeps, createRequest, requestsTick, retryRequest, cancelRequest, grabManually, RequestError, orderCandidates, installClass, certainlyThisGame, autoContext, automaticRefusals, profileRefusals, onePerRelease, isBlocked, gameBlocklist, type GameFacts, type Refused } from "../src/requests";
import { events } from "../src/events";
import { buildQuery, nameQueries, rankForNames, rankReleases, type ReleaseView } from "../src/releases";
import type { ProwlarrRelease } from "../src/prowlarr";
import { DEFAULT_PROFILE, createProfile } from "../src/library/profiles";
const P = { id: 0, ...DEFAULT_PROFILE };

const rv = (over: Partial<ReleaseView> & Partial<ReleaseView["parsed"]> = {}): ReleaseView => {
  const { group = null, repack = false, scene = false, format = null, edition = null, junk = [], ...rest } = over as any;
  return {
    guid: "g" + Math.random().toString(36).slice(2), title: "Hades (2020) [Windows / English / Home Rip]", instanceId: 1, indexerId: 11, indexer: "GGn", size: 5e9, age: 10,
    publishDate: "", seeders: 40, leechers: 0, grabs: null, files: null, downloadUrl: "http://p/dl", magnetUrl: null, infoUrl: null, infoHash: null,
    protocol: "torrent", categories: [], indexerFlags: [], fileName: null,
    parsed: { group, repack, scene, version: null, edition, languages: null, dlc: false, junk, year: 2020, platform: "Windows", format },
    match: { ok: true, core: 1, optional: 1 }, score: 120, reasons: [], flags: { sequel: false, extraWords: false, buried: false, yearOff: null }, alsoOn: [],
    ...rest,
  };
};

let game: GameRow;
let searchResults: ReleaseView[] = [];
let grabFail: Set<string> = new Set();
const grabs: string[] = [];
let nzb = true;
let agentOn = false;
let now = Date.now();
// the request deps as they were before this file faked them: given back once it is done, so a file run after it in the same
// process (tests/ways-requests.test.ts) meets the real ones
const savedR = { ...rdeps };
afterAll(() => { Object.assign(rdeps, savedR); });

beforeEach(() => {
  db.exec("DELETE FROM requests; DELETE FROM jobs; DELETE FROM packages; DELETE FROM fetches; DELETE FROM games;");
  game = stmts.upsertGame({
    igdb_id: null, steam_appid: 1145360, name: "Hades", slug: "hades", summary: null, storyline: null, release_year: 2020, first_release_date: null,
    rating: null, cover_url: "c.jpg", banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: "[]",
    game_modes_json: "[]", developer: null, publisher: null,
  });
  searchResults = [rv()]; grabFail = new Set(); grabs.length = 0; nzb = true; agentOn = false; now = Date.now();
  rdeps.log = () => {};
  rdeps.now = () => now;
  rdeps.usenetAvailable = async () => nzb;
  rdeps.agentReady = () => agentOn;
  rdeps.search = async () => ({ query: {} as any, searched: [], raw: searchResults.length, ranked: searchResults, errors: [] });
  rdeps.grab = async (rel, gameId) => {
    grabs.push(rel.title);
    if (grabFail.has(rel.guid)) throw new Error("PROWLARR_DOWNLOAD_HTTP_429");
    const row = stmts.insertFetch({ game_id: gameId, guid: rel.guid, indexer_id: rel.indexerId, indexer: rel.indexer, title: rel.title, protocol: rel.protocol, size: rel.size, info_hash: null, client: rel.protocol === "usenet" ? "nzbget" : "rtorrent", client_id: "x", state: "submitted", release_json: JSON.stringify(rel) });
    return { fetch: { id: row.id } as any, duplicate: false };
  };
});

const req = (id: number) => stmts.requestById.get(id) as RequestRow;

describe("policy", () => {
  test("install class from format / title / parse", () => {
    expect(installClass(rv({ format: "Home Rip" }))).toBe("clean");
    expect(installClass(rv({ format: "DRM Free" }))).toBe("clean");
    expect(installClass(rv({ title: "Hades [GOG Edition 2020]", format: null }))).toBe("clean");
    expect(installClass(rv({ format: "Full ISO" }))).toBe("iso");
    expect(installClass(rv({ title: "Hades-CODEX", format: null, scene: true, group: "CODEX" }))).toBe("iso");
    expect(installClass(rv({ title: "Hades [FitGirl Repack]", format: null, repack: true, group: "FitGirl" }))).toBe("repack");
    expect(installClass(rv({ format: "GameDOX" }))).toBe("installer");
    expect(installClass(rv({ title: "Hades", format: null }))).toBe("unknown");
  });
  test("the automatic matcher refuses anything that might be another game", () => {
    const base = rv({ title: "Castlevania: Belmont's Curse (2026) [Windows / Multi-Language / Home Rip]" });
    expect(certainlyThisGame(base)).toBe(true);
    expect(certainlyThisGame(rv({ match: { ok: true, core: 1, optional: 0 } }))).toBe(false);                       // "Castlevania: The Arcade" — subtitle missing
    expect(certainlyThisGame(rv({ match: { ok: true, core: 1, optional: 0.5 } }))).toBe(false);                     // "Castlevania Curse of Darkness" — half a subtitle is another game
    expect(certainlyThisGame(rv({ flags: { sequel: true, extraWords: false, buried: false, yearOff: null } }))).toBe(false);
    expect(certainlyThisGame(rv({ flags: { sequel: false, extraWords: true, buried: false, yearOff: null } }))).toBe(false);
    expect(certainlyThisGame(rv({ flags: { sequel: false, extraWords: false, buried: true, yearOff: null } }))).toBe(false);
    expect(certainlyThisGame(rv({ flags: { sequel: false, extraWords: false, buried: false, yearOff: 17 } }))).toBe(false);
    expect(certainlyThisGame(rv({ flags: { sequel: false, extraWords: false, buried: false, yearOff: 1 } }))).toBe(true);
    expect(certainlyThisGame(rv({ match: { ok: false, core: 0.5, optional: 1 } }))).toBe(false);
    expect(orderCandidates([rv({ title: "wrong", match: { ok: true, core: 1, optional: 0 } }), base], P, { preferUsenet: false }).map(r => r.title)).toEqual([base.title]);
    expect(certainlyThisGame(rv({ flags: { sequel: false, extraWords: false, buried: false, yearOff: null, wrongKind: "a mod, not the game (mod)" } }))).toBe(false);
    expect(certainlyThisGame(rv({ platform: "Android" } as any))).toBe(true);    // rv keeps parsed.platform = Windows …
    expect(certainlyThisGame({ ...base, parsed: { ...base.parsed, platform: "Android" } })).toBe(false);   // … a non-PC block is refused
  });
  test("the automatic matcher refuses what is not the PC game: an APK mod in one usenet part, console / mobile builds", () => {
    const q = buildQuery("DAVE THE DIVER", 2023);
    const row = (title: string, protocol: "torrent" | "usenet" = "usenet") => ({
      guid: title, title, instanceId: 1, indexerId: 8, indexer: "DrunkenSlug", size: 3e9, age: 10, publishDate: "", seeders: protocol === "torrent" ? 50 : null, leechers: 0,
      grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol, categories: [], indexerFlags: [], fileName: null,
    });
    const ranked = rankReleases(q, [
      row(`[30/44] "GAME - Dave The Diver V1.0.40 Mod.part1.rar"`),
      row("Dave The Diver v1.0.40 MOD APK"),
      row("Dave.the.Diver.NSW-SUXXORS"),
      row("Dave the Diver (2023) [Android / English / Home Rip]", "torrent"),
      row("Dave.The.Diver.v1.0.40.Modded"),
      row("Dave.The.Diver-RUNE (2023) [Windows / Multi-Language / Full ISO]", "torrent"),
      row("Dave.The.Diver.v1.0.2.Incl.Mods-P2P"),
    ] as any);
    const by = Object.fromEntries(ranked.map(r => [r.title, r]));
    expect(by[`[30/44] "GAME - Dave The Diver V1.0.40 Mod.part1.rar"`].flags.wrongKind).toMatch(/usenet post/);
    expect(by["Dave The Diver v1.0.40 MOD APK"].flags.wrongKind).toMatch(/not a PC build \(apk\)/);
    expect(by["Dave.the.Diver.NSW-SUXXORS"].flags.wrongKind).toMatch(/nsw/);
    expect(by["Dave the Diver (2023) [Android / English / Home Rip]"].flags.wrongKind).toBe("platform: Android");
    expect(by["Dave.The.Diver.v1.0.40.Modded"].flags.wrongKind).toMatch(/a mod/);
    expect(by["Dave.The.Diver-RUNE (2023) [Windows / Multi-Language / Full ISO]"].flags.wrongKind ?? null).toBeNull();
    expect(by["Dave.The.Diver.v1.0.2.Incl.Mods-P2P"].flags.wrongKind ?? null).toBeNull();
    expect(ranked.filter(certainlyThisGame).map(r => r.title).sort()).toEqual(["Dave.The.Diver-RUNE (2023) [Windows / Multi-Language / Full ISO]", "Dave.The.Diver.v1.0.2.Incl.Mods-P2P"]);
    expect(orderCandidates(ranked, P, { preferUsenet: true }).map(r => r.title).sort()).toEqual(["Dave.The.Diver-RUNE (2023) [Windows / Multi-Language / Full ISO]", "Dave.The.Diver.v1.0.2.Incl.Mods-P2P"]);
  });
  test("a torrent posted hours ago with no seeders yet is still a candidate; an old seedless one is not", () => {
    const fresh = rv({ title: "fresh", format: "Full ISO", seeders: 0, publishDate: new Date(now - 2 * 3600_000).toISOString() });
    const stale = rv({ title: "stale", format: "Full ISO", seeders: 0, publishDate: new Date(now - 3 * 86_400_000).toISOString() });
    expect(orderCandidates([stale, fresh], P, { preferUsenet: false }).map(r => r.title)).toEqual(["fresh"]);
  });
  test("clean before iso before repack; usenet first within a class when NZBGet is around; junk/low/dead dropped", () => {
    const repack = rv({ title: "r", format: null, repack: true, score: 150 });
    const isoT = rv({ title: "isoT", format: "Full ISO", score: 140 });
    const isoN = rv({ title: "isoN", format: null, scene: true, protocol: "usenet", seeders: null, score: 120 });
    const clean = rv({ title: "clean", format: "Home Rip", score: 110 });
    const junk = rv({ title: "junk", format: "Home Rip", score: 200, junk: ["trainer"] });
    const low = rv({ title: "low", format: "Home Rip", score: 40 });
    const dead = rv({ title: "dead", format: "Home Rip", score: 130, seeders: 0 });
    const nourl = rv({ title: "nourl", format: "Home Rip", score: 130, downloadUrl: null });
    expect(orderCandidates([repack, isoT, isoN, clean, junk, low, dead, nourl], P, { preferUsenet: true }).map(r => r.title)).toEqual(["clean", "isoN", "isoT", "r"]);
    expect(orderCandidates([repack, isoT, isoN, clean], P, { preferUsenet: false }).map(r => r.title)).toEqual(["clean", "isoT", "isoN", "r"]);
  });
});

/* ─────────── Fix A: "Call of Duty®: Modern Warfare® 4" (2026) took Call of Duty 4: Modern Warfare (2007), 2026-11-09 ─────────── */

/** a row as an indexer hands it over */
const row = (title: string, o: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: `g:${title}:${Math.random().toString(36).slice(2, 8)}`, title, instanceId: 1, indexerId: 8, indexer: "DrunkenSlug", size: 7e9, age: 0, publishDate: "",
  seeders: 30, leechers: 0, grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent",
  categories: [], indexerFlags: [], fileName: null, ...o,
});
const usenet = { protocol: "usenet" as const, seeders: null };
const ranked = (name: string, year: number | null, rows: ProwlarrRelease[], aliases: string[] = []) => rankForNames(nameQueries(name, year, aliases), rows);
const MW4 = "Call of Duty®: Modern Warfare® 4";
const MW4_FACTS = { release_iso: "2026-10-22", release_year: 2026, first_release_date: null, crack_status: null, drm: null };
const AT = Date.parse("2026-11-09T08:20:39Z");
/** the four copies the live server tried for MW4 (fetch #60 and the manual case): every one the 2007 game */
const mw4Rows = () => [
  row("Call.of.Duty.4.Modern.Warfare.v1.7.2.MacOSX.Intel.Cracked-AR", { ...usenet, size: 7_960_044_095, age: 3140, publishDate: "2018-04-04T08:48:00Z" }),
  row("Call of Duty 4-Modern Warfare Repack-P2P.exe.rar", { ...usenet, size: 40_000_000, age: 1501 }),
  row("Call of Duty 4-Modern Warfare Repack-P2P.exe.rar", { ...usenet, size: 40_000_001, age: 1501 }),
  row("Call.of.Duty.4.Modern.Warfare-Razor1911", { size: 6_790_000_000, seeders: 55, indexer: "FileList.io" }),
];
const REORDERED = "the words of the name are in another order (another game?)";

describe("the automatic matcher refuses another game with the same words, a fake, an update, an early post (Fix A)", () => {
  test("the four copies MW4 took are refused, each saying why; MW4's own copy among them is taken", () => {
    const r = ranked(MW4, 2026, mw4Rows());
    expect(orderCandidates(r, P, { preferUsenet: true, game: MW4_FACTS, now: AT })).toEqual([]);
    const ctx = autoContext(r, MW4_FACTS, AT);
    const why = (title: string) => automaticRefusals(r.find(v => v.title === title)!, ctx);
    expect(why("Call.of.Duty.4.Modern.Warfare.v1.7.2.MacOSX.Intel.Cracked-AR")).toEqual([REORDERED, 'more words after the name ("macosx"): another game or an add-on', "not a PC build (macosx)", "posted 3123 days before the game came out"]);
    expect(why("Call of Duty 4-Modern Warfare Repack-P2P.exe.rar")).toEqual(expect.arrayContaining([REORDERED, "a file name, not a release (.exe.rar)"]));
    expect(why("Call.of.Duty.4.Modern.Warfare-Razor1911")).toEqual([REORDERED]);                      // a clean scene name: refused by its name alone
    const own = ranked(MW4, 2026, [...mw4Rows(), row("Call.of.Duty.Modern.Warfare.4-RUNE", { size: 98e9, publishDate: "2026-10-23T09:00:00Z" })]);
    expect(orderCandidates(own, P, { preferUsenet: true, game: MW4_FACTS, now: AT }).map(v => v.title)).toEqual(["Call.of.Duty.Modern.Warfare.4-RUNE"]);
    // and the other way round: Modern Warfare 4 is not Call of Duty 4 (2007)
    const cod4 = { release_iso: "2007-11-12", release_year: 2007, first_release_date: null, crack_status: "cracked", drm: null };
    expect(orderCandidates(ranked("Call of Duty 4: Modern Warfare", 2007, [row("Call.of.Duty.Modern.Warfare.4-RUNE", { size: 98e9 })]), P, { preferUsenet: true, game: cod4, now: AT })).toEqual([]);
  });
  test("R6a: far below a tenth of the other copies is an update or a fake; a repack, a launch build and a lone small game are not", () => {
    const big = row("Command.And.Conquer.Red.Alert.3-RELOADED", { ...usenet, size: 10_680_000_000 });
    const small = row("Command.and.Conquer.Red.Alert.3-SKIDROW", { ...usenet, size: 461_800_000 });
    const ra3 = ranked("Command & Conquer™ Red Alert™ 3", 2009, [big, small]);
    expect(orderCandidates(ra3, P, { preferUsenet: true }).map(v => v.title)).toEqual([big.title]);
    expect(automaticRefusals(ra3.find(v => v.title === small.title)!, autoContext(ra3))).toEqual(["far smaller than the other copies (0.5 GB against 10.7 GB): an update or a fake"]);
    // the same release posted again does not vouch for itself: two posts of a fake beside the game
    const fakes = ranked("Hades", 2020, [row("Hades-CODEX", { size: 40_000_000 }), row("Hades.CODEX", { size: 40_000_100 }), row("Hades-RUNE", { size: 10e9 })]);
    expect(orderCandidates(fakes, P, { preferUsenet: false }).map(v => v.title)).toEqual(["Hades-RUNE"]);
    const keeps = (name: string, rows: ProwlarrRelease[]) => orderCandidates(ranked(name, null, rows), P, { preferUsenet: false }).length;
    expect(keeps("Dispatch", [row("Dispatch-RUNE (2025) [Windows / Multi-Language / Full ISO]", { size: 3.53e9 }), row("Dispatch.Complete-RUNE (2025) [Windows / Multi-Language / Full ISO]", { size: 17.54e9 }), row("Dispatch Complete-RUNE", { size: 17.5e9 }), row("Dispatch.Complete-RUNE", { size: 17.57e9 })])).toBe(4);
    expect(keeps("Endacopia", [row("Endacopia [FitGirl Repack] (2026) [Windows / English / P2P Full Repack]", { size: 350.4e6 }), row("Endacopia-TENOKE (2026) [Windows / English / Full ISO]", { size: 1.19e9 }), row("Endacopia-TENOKE", { size: 2.99e9 })])).toBe(3);
    expect(keeps("Balatro", [row("Balatro (2024) [Windows / Multi-Language / Home Rip]", { size: 59.7e6 })])).toBe(1);
  });
  test("R10: posted more than a week before the game existed is another game — unless a copy's year says the game is older", () => {
    const stupid: GameFacts = { release_iso: "2026-10-21", release_year: null, first_release_date: null, crack_status: "cracked", drm: "Steam" };
    const sn = (o: Partial<ProwlarrRelease>) => ranked("Stupid Never Dies", null, [row("Stupid.Never.Dies-RUNE", o)]);
    const take = (v: ReleaseView[], g: GameFacts) => orderCandidates(v, P, { preferUsenet: false, game: g, now: AT }).length;
    expect(take(sn({ publishDate: "2026-10-19T10:00:00Z" }), stupid)).toBe(1);                     // RUNE two days early: fine
    const old = sn({ publishDate: "2014-03-01T00:00:00Z" });
    expect(take(old, stupid)).toBe(0);
    expect(automaticRefusals(old[0], autoContext(old, stupid, AT))).toEqual(["posted 4617 days before the game came out"]);
    expect(take(sn({ age: 4000 }), stupid)).toBe(0);                                                  // no date: its age says when
    expect(take(sn({}), stupid)).toBe(1);                                                             // neither: the rule says nothing
    expect(take(sn({ publishDate: "2014-03-01T00:00:00Z" }), { ...stupid, release_iso: null })).toBe(1); // nor without a date for the game
    // Outer Wilds: on Epic in 2019, on Steam on 2020-06-18 — GazelleGames' "(2019)" beside the CODEX post says so
    const ow: GameFacts = { release_iso: "2020-06-18", release_year: 2020, first_release_date: null, crack_status: "untracked", drm: null };
    const codex = row("Outer.Wilds-CODEX", { ...usenet, size: 14.73e9, publishDate: "2019-06-01T00:00:00Z" });
    const ggn = row("Outer Wilds (2019) [Windows / Multi-Language / Home Rip]", { size: 3.49e9, publishDate: "2020-01-01T00:00:00Z" });
    expect(orderCandidates(ranked("Outer Wilds", 2020, [codex, ggn]), P, { preferUsenet: true, game: ow, now: AT }).map(v => v.title).sort()).toEqual([ggn.title, codex.title].sort());
    const alone = ranked("Outer Wilds", 2020, [codex]);
    // judged in 2020, the game recent: its Steam date was what the rule knew; in 2026 the game is older than two years, and a
    // post up to two years before its store date is its launch (the review round's change, tested there)
    expect(automaticRefusals(alone[0], autoContext(alone, ow, Date.parse("2020-11-01T00:00:00Z")))).toEqual(["posted 383 days before the game came out"]);
    expect(automaticRefusals(alone[0], autoContext(alone, ow, AT))).toEqual([]);
    expect(take(alone, { ...ow, first_release_date: Date.parse("2019-05-28T00:00:00Z") / 1000 })).toBe(1);   // IGDB's first date
  });
  test("R11: a game CrackWatch says is uncracked or not out takes only a DRM-free store copy; a console dump is not its business", () => {
    const facts = { release_iso: "2024-08-20", release_year: 2024, first_release_date: null, crack_status: "uncracked", drm: "Denuvo" };
    const r = ranked("Black Myth: Wukong", 2024, [row("Black.Myth.Wukong-RUNE", { size: 130e9 }), row("Black Myth Wukong (2024) [GOG Edition 2024] [Windows / Multi-Language / DRM Free]", { size: 128e9 })]);
    expect(orderCandidates(r, P, { preferUsenet: false, game: facts, now: AT }).map(v => v.title)).toEqual(["Black Myth Wukong (2024) [GOG Edition 2024] [Windows / Multi-Language / DRM Free]"]);
    expect(automaticRefusals(r.find(v => v.title === "Black.Myth.Wukong-RUNE")!, autoContext(r, facts, AT))).toEqual(["CrackWatch says the game is not cracked yet (Denuvo): a copy now would be a fake"]);
    expect(automaticRefusals(r.find(v => v.title === "Black.Myth.Wukong-RUNE")!, autoContext(r, { ...facts, release_iso: "2026-12-05", crack_status: "unreleased", drm: null }, AT))).toEqual(["CrackWatch says the game is not out yet: a copy now would be a fake"]);
    // the store's date has passed since: the verdict is stale (the review round asks CrackWatch again before such a search)
    expect(automaticRefusals(r.find(v => v.title === "Black.Myth.Wukong-RUNE")!, autoContext(r, { ...facts, crack_status: "unreleased", drm: null }, AT))).toEqual(["CrackWatch has no verdict on the release yet (it still lists the game as not out)"]);
    expect(orderCandidates(r, P, { preferUsenet: false, game: { ...facts, crack_status: "cracked" }, now: AT })).toHaveLength(2);
    const dump = rankForNames(nameQueries("Black Myth: Wukong", 2024), [row("Black.Myth.Wukong.PS5-DUPLEX", { size: 90e9 })], { platforms: ["ps5"], known: ["ps5"] });
    expect(orderCandidates(dump, P, { preferUsenet: false, game: facts, now: AT })).toHaveLength(1);
  });
  test("a refusal is said in words by the profile too, and the blocklist knows a title written another way", () => {
    expect(profileRefusals(rv({ title: "x", score: 40, seeders: 0, format: "Home Rip" }), P)).toEqual(["scores 40, under the profile's 70", "no seeders"]);
    expect(profileRefusals(rv({ title: "x", format: "Home Rip" }), P)).toEqual([]);
    const blocked = new Set(["guid-1", "Hades.v1.0-CODEX"]);
    expect([isBlocked(blocked, { guid: "guid-1", title: "a" }), isBlocked(blocked, { guid: "g", title: "Hades v1.0 CODEX" }), isBlocked(blocked, { guid: "g", title: "Hades v1.1 CODEX" })]).toEqual([true, true, false]);
  });
  test("the same release posted again counts once: its first post in the order given holds its place, the other posts follow", () => {
    // review round: the first in the profile's order (the best-scored one overrode prefer-usenet), and the reposts kept after
    // the round's releases, to be tried when a post fails on its source
    const a = rv({ title: "Hades-CODEX", score: 121 }), b = rv({ title: "Hades.CODEX", score: 125 }), c = rv({ title: "hades codex", score: 90 }), d = rv({ title: "Hades-RUNE", score: 130 });
    expect(onePerRelease([a, b, c, d]).map(v => v.title)).toEqual(["Hades-CODEX", "Hades-RUNE", "Hades.CODEX", "hades codex"]);
    expect(onePerRelease([a, b, c, d], 1).map(v => v.title)).toEqual(["Hades-CODEX", "Hades.CODEX"]);
  });
});

describe("the searcher with Fix A: say why, wait for a crack, look CrackWatch up, re-check the blocklist, one post per release", () => {
  const asMw4 = (crack: string | null = "untracked") => db.query("UPDATE games SET name=?, release_year=2026, release_iso='2026-10-22', crack_status=?, drm=NULL WHERE id=?").run(MW4, crack, game.id);
  const blocks = () => (db.query("SELECT COUNT(*) AS n FROM blocklist WHERE game_id=?").get(game.id) as { n: number }).n;
  const refusedOf = (id: number) => JSON.parse(req(id).refused_json ?? "null") as Refused[] | null;
  const looked: string[] = [];
  beforeEach(() => { looked.length = 0; rdeps.crackCheck = async g => { looked.push(g.name); return null; }; rdeps.crackWaitMs = 8000; });

  test("a search that takes nothing says why (stage, message, refused_json), blocklists nothing, and the next search takes the game", async () => {
    asMw4();
    searchResults = ranked(MW4, 2026, mw4Rows());
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    expect(r.state).toBe("requested"); expect(grabs).toEqual([]);
    expect(r.stage).toBe("4 copies found, none certainly this game — searching again in 6h");
    expect(r.message).toMatch(new RegExp(`^${REORDERED.replace(/[()?]/g, "\\$&")} — Call.of.Duty.4.Modern.Warfare`));    // the reason first (review round)
    const refused = refusedOf(request.id)!;
    expect(refused).toHaveLength(4);
    for (const x of refused) { expect(x.why[0]).toBe(REORDERED); expect(Object.keys(x).sort()).toEqual(["indexer", "protocol", "size", "title", "why"]); }
    expect(blocks()).toBe(0);
    // the real copy shows up: it is taken, and the refusals are cleared
    searchResults = ranked(MW4, 2026, [...mw4Rows(), row("Call.of.Duty.Modern.Warfare.4-RUNE", { size: 98e9 })]);
    now += 7 * 3600_000;
    await requestsTick();
    r = req(request.id);
    expect(r.state).toBe("fetching"); expect(grabs).toEqual(["Call.of.Duty.Modern.Warfare.4-RUNE"]); expect(r.refused_json).toBeNull();
  });

  test("CrackWatch says uncracked: the search waits for a crack (a DRM-free copy is still taken); CrackWatch off: its verdict is not heeded", async () => {
    db.query("UPDATE games SET crack_status='uncracked', drm='Denuvo' WHERE id=?").run(game.id);
    searchResults = rankReleases(buildQuery("Hades", 2020), [row("Hades-RUNE (2020) [Windows / Multi-Language / Full ISO]", { size: 10e9 })]);
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    expect(r).toMatchObject({ state: "requested", stage: "waiting for a crack — searching again in 6h", message: "CrackWatch says the game is not cracked yet (Denuvo): a copy now would be a fake — Hades-RUNE (2020) [Windows / Multi-Language / Full ISO]" });
    expect(grabs).toEqual([]);
    searchResults = rankReleases(buildQuery("Hades", 2020), [row("Hades-RUNE (2020) [Windows / Multi-Language / Full ISO]", { size: 10e9 }), row("Hades (2020) [GOG Edition 2020] [Windows / Multi-Language / DRM Free]", { size: 9.8e9 })]);
    now += 7 * 3600_000;
    await requestsTick();
    expect(grabs).toEqual(["Hades (2020) [GOG Edition 2020] [Windows / Multi-Language / DRM Free]"]);
    await cancelRequest(request.id, true); grabs.length = 0;
    process.env.CRACKWATCH_SYNC_HOURS = "0";
    try {
      searchResults = rankReleases(buildQuery("Hades", 2020), [row("Hades-RUNE (2020) [Windows / Multi-Language / Full ISO]", { size: 10e9 })]);
      createRequest({ gameId: game.id });
      await requestsTick();
      expect(grabs).toEqual(["Hades-RUNE (2020) [Windows / Multi-Language / Full ISO]"]);
    } finally { delete process.env.CRACKWATCH_SYNC_HOURS; }
  });

  test("a Steam game out for less than a year that CrackWatch was never asked about is looked up once before its search", async () => {
    db.query("UPDATE games SET release_iso=?, crack_status=NULL WHERE id=?").run(new Date(now - 10 * 86_400_000).toISOString().slice(0, 10), game.id);
    rdeps.crackCheck = async g => { looked.push(g.name); db.query("UPDATE games SET crack_status='uncracked', drm='Denuvo' WHERE id=?").run(g.id); return { status: "uncracked" }; };
    searchResults = [rv({ title: "Hades-RUNE", format: "Full ISO" })];
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(looked).toEqual(["Hades"]);
    expect(req(request.id).stage).toBe("waiting for a crack — searching again in 6h");
    // the next search: a verdict is there, nothing is asked
    now += 7 * 3600_000; await requestsTick();
    expect(looked).toEqual(["Hades"]);
  });

  test("a lookup that fails or does not answer changes nothing: the search goes on; an old game, a verdict, CrackWatch off: nothing is asked", async () => {
    const logs: string[] = []; rdeps.log = (...x) => logs.push(x.join(" "));
    db.query("UPDATE games SET release_iso=?, crack_status=NULL WHERE id=?").run(new Date(now - 10 * 86_400_000).toISOString().slice(0, 10), game.id);
    rdeps.crackCheck = async () => { throw new Error("HTTP 503"); };
    searchResults = [rv({ title: "Hades-RUNE", format: "Full ISO" })];
    let { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(req(request.id).state).toBe("fetching"); expect(logs.join("\n")).toMatch(/CrackWatch could not be asked \(HTTP 503\) — searching anyway/);
    await cancelRequest(request.id, true);
    rdeps.crackCheck = () => new Promise(() => {}); rdeps.crackWaitMs = 20;
    ({ request } = createRequest({ gameId: game.id }));
    await requestsTick();
    expect(req(request.id).state).toBe("fetching"); expect(logs.join("\n")).toMatch(/CrackWatch did not answer within 0.02 s — searching anyway/);
    await cancelRequest(request.id, true);
    rdeps.crackCheck = async g => { looked.push(g.name); return null; };
    for (const [iso, crack, off] of [["2020-09-17", null, false], [new Date(now - 10 * 86_400_000).toISOString().slice(0, 10), "cracked", false], [new Date(now - 10 * 86_400_000).toISOString().slice(0, 10), null, true]] as const) {
      db.query("UPDATE games SET release_iso=?, crack_status=? WHERE id=?").run(iso, crack, game.id);
      if (off) process.env.CRACKWATCH_SYNC_HOURS = "0";
      try { ({ request } = createRequest({ gameId: game.id })); await requestsTick(); await cancelRequest(request.id, true); } finally { delete process.env.CRACKWATCH_SYNC_HOURS; }
    }
    expect(looked).toEqual([]);
  });

  test("the candidate list is checked against the blocklist at each grab: what was blocklisted since is passed by, as tried", async () => {
    const a = rv({ title: "A", format: "Home Rip", score: 130 }), b = rv({ title: "B Release", format: "Home Rip", score: 120 }), c = rv({ title: "C", format: "Home Rip", score: 110 });
    searchResults = [a, b, c];
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(grabs).toEqual(["A"]);
    // meanwhile the second one is blocklisted under its title written another way (a repost elsewhere failed, the admin …)
    stmts.insertBlock.run(game.id, null, "B.Release", "GGn", "a fake");
    try {
      stmts.setFetchState.run("failed", 0, "nzbget: FAILURE/HEALTH", req(request.id).fetch_id);
      await requestsTick();
      const r = req(request.id);
      expect(grabs).toEqual(["A", "C"]); expect(r.state).toBe("fetching");
      expect(JSON.parse(r.tried_json!).sort()).toEqual([a.guid, b.guid].sort());
    } finally { db.query("DELETE FROM blocklist WHERE game_id=?").run(game.id); }
  });

  test("the same release posted twice takes one of the round's tries, not two", async () => {
    searchResults = [rv({ title: "Hades-CODEX", format: "Home Rip", score: 125 }), rv({ title: "Hades.CODEX", format: "Home Rip", protocol: "usenet", seeders: null, score: 120 }),
      rv({ title: "B", format: "Home Rip", score: 110 }), rv({ title: "C", format: "Home Rip", score: 105 }), rv({ title: "D", format: "Home Rip", score: 100 }), rv({ title: "E", format: "Home Rip", score: 99 })];
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect((JSON.parse(req(request.id).candidates_json!) as ReleaseView[]).map(c => c.title)).toEqual(["Hades.CODEX", "B", "C", "D", "Hades-CODEX"]);   // usenet first (prefer-usenet), its torrent twin last (review round)
  });
});

describe("requests", () => {
  test("create by gameId, duplicates, unknown game", async () => {
    const a = createRequest({ gameId: game.id });
    expect(a.duplicate).toBe(false); expect(a.request).toMatchObject({ state: "requested", gameName: "Hades", coverUrl: "c.jpg", progress: 0.01 });
    expect(createRequest({ gameId: game.id }).duplicate).toBe(true);
    expect(() => createRequest({ gameId: 12345 })).toThrow(/no such game/);
  });

  test("the whole journey: match → fetch mirrored → job → ready, with live events", async () => {
    const seen: any[] = [];
    const off = events.subscribe(e => seen.push(e));
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    expect(r.state).toBe("fetching"); expect(grabs).toEqual([searchResults[0].title]);
    expect(JSON.parse(r.release_json!).title).toBe(searchResults[0].title);
    expect(r.stage).toBe("queued in the download client");
    stmts.setFetchDownloading.run(0.5, "DOWNLOADING", 48_000_000, r.fetch_id);
    await requestsTick();
    r = req(request.id);
    expect(r.stage).toBe("downloading · 48 MB/s"); expect(r.progress).toBeCloseTo(0.275, 3);
    stmts.setFetchSeedbox.run("/box/Hades", 1, 5e9, r.fetch_id); stmts.setFetchState.run("pulling", 0.4, null, r.fetch_id); stmts.setFetchPulling.run(0.4, 0, r.fetch_id);
    await requestsTick();
    expect(req(request.id).stage).toBe("transferring to ludarr");
    stmts.setFetchDone.run("/downloads/Hades", r.fetch_id);
    await requestsTick();
    r = req(request.id);
    expect(r.state).toBe("processing"); expect(r.job_id).not.toBeNull();
    const job = stmts.jobById.get(r.job_id!) as JobRow;
    expect(job).toMatchObject({ input_path: "/downloads/Hades", request_id: request.id, game_id: game.id, state: "queued" });
    stmts.setJob.run("running", "deterministic", 0.5, "extracting", job.id);
    await requestsTick();
    expect(req(request.id).stage).toBe("extracting"); expect(req(request.id).progress).toBeCloseTo(0.925, 6);
    const pkg = stmts.insertPackage.get(game.id, job.id, "/lib/hades", "Hades", null, 5e9, "{}") as any;
    stmts.setJobDone.run("ready", "/lib/hades", "{}", job.id);
    await requestsTick();
    r = req(request.id);
    expect(r).toMatchObject({ state: "ready", stage: "imported", progress: 1, package_id: pkg.id });
    expect(r.done_at).not.toBeNull();
    off();
    const reqEvents = seen.filter(e => e.event === "request");
    expect(reqEvents.length).toBeGreaterThan(5);
    expect(reqEvents.at(-1).data.state).toBe("ready");
  });

  test("candidates fall through: grab failures, transfer failure, processing failure; then it fails for good", async () => {
    const a = rv({ title: "A", format: "Home Rip" }), b = rv({ title: "B", format: "Home Rip", score: 100 }), c = rv({ title: "C", format: "Full ISO" }), d = rv({ title: "D", format: null });
    searchResults = [a, b, c, d]; grabFail.add(a.guid);
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    expect(r.state).toBe("fetching"); expect(r.attempt).toBe(1); expect(grabs).toEqual(["A", "B"]);
    expect(r.message).toBeNull();                                            // the error cleared once B was in flight
    stmts.setFetchState.run("failed", 0, "not found on the seedbox", r.fetch_id);
    await requestsTick();
    r = req(request.id);
    expect(r.state).toBe("fetching"); expect(r.attempt).toBe(2); expect(grabs.at(-1)).toBe("C");
    stmts.setFetchDone.run("/dl/C", r.fetch_id); await requestsTick();
    r = req(request.id); expect(r.state).toBe("processing");
    stmts.setJobFailed.run("failed", "no executable to launch", r.job_id); await requestsTick();
    r = req(request.id);
    expect(r.state).toBe("fetching"); expect(r.attempt).toBe(3); expect(grabs.at(-1)).toBe("D");
    expect(r.message).toBeNull();
    stmts.setFetchState.run("failed", 0, "dead torrent", r.fetch_id); await requestsTick();
    r = req(request.id);
    // young request: out of candidates means "keep looking", remembering every release it burned
    expect(r.state).toBe("requested"); expect(r.stage).toMatch(/no usable copy yet — searching again in 6h/); expect(r.message).toBe("dead torrent");
    expect(JSON.parse(r.tried_json!).sort()).toEqual([a.guid, b.guid, c.guid, d.guid].sort());
    expect(r.next_try_at).toBe(Math.floor(now / 1000) + 6 * 3600);
    now += 7 * 3600 * 1000; grabs.length = 0;
    await requestsTick();                                   // the same four are offered again → all already tried → waits again
    r = req(request.id); expect(r.state).toBe("requested"); expect(grabs).toEqual([]); expect(r.stage).toMatch(/no usable copy yet/);
    // a week later with still nothing new it gives up for good
    db.exec(`UPDATE requests SET created_at = created_at - ${8 * 86_400} WHERE id = ${request.id}`);
    now += 7 * 3600 * 1000;
    await requestsTick();
    r = req(request.id); expect(r.state).toBe("requested");  // "nothing new" alone never fails it; only burning candidates when old does
  });

  test("nothing suitable → waits and looks again later; search errors back off briefly", async () => {
    searchResults = [rv({ score: 10 })];
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    expect(r.state).toBe("requested"); expect(r.stage).toMatch(/^1 copy found, none taken/); expect(r.next_try_at).toBe(Math.floor(now / 1000) + 6 * 3600);
    searchResults = [rv()];
    await requestsTick();
    expect(req(request.id).state).toBe("requested");                       // not due yet
    now += 7 * 3600 * 1000;
    await requestsTick();
    expect(req(request.id).state).toBe("fetching");
    rdeps.search = async () => { throw new Error("prowlarr down"); };
    db.exec("DELETE FROM requests");
    const r2 = (await createRequest({ gameId: game.id })).request;
    await requestsTick();
    r = req(r2.id);
    expect(r.state).toBe("requested"); expect(r.message).toBe("prowlarr down"); expect(r.next_try_at).toBe(Math.floor(now / 1000) + 600);
  });

  test("an old request that burns its last candidate fails for good; retry wipes the memory", async () => {
    const a = rv({ title: "A", format: "Home Rip" });
    searchResults = [a]; grabFail.add(a.guid);
    const { request } = createRequest({ gameId: game.id });
    db.exec(`UPDATE requests SET created_at = created_at - ${8 * 86_400} WHERE id = ${request.id}`);
    await requestsTick();
    expect(req(request.id)).toMatchObject({ state: "failed", stage: "every candidate release failed" });
    const again = retryRequest(request.id);
    expect(again.state).toBe("requested"); expect(req(request.id).tried_json).toBeNull();
  });

  test("a seedbox download that stops moving is dropped for the next candidate", async () => {
    // the stall clock is the fetch worker's (fetches.still_sec: src/fetch.ts runs it only while the client answers and a
    // torrent has no one to download from); the search acts on it
    const a = rv({ title: "A", format: "Home Rip" }), b = rv({ title: "B", format: "Home Rip", score: 100 });
    searchResults = [a, b];
    const logs: string[] = []; rdeps.log = (...x) => logs.push(x.join(" "));
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    const polled = (stillMin: number) => stmts.setFetchPolled.run(Math.floor(now / 1000), stillMin * 60, r.fetch_id);
    stmts.setFetchDownloading.run(0, null, 0, r.fetch_id); polled(0); await requestsTick();
    now += 20 * 60_000; polled(20); await requestsTick();                      // 20 min without a byte: patience
    r = req(request.id); expect(r.attempt).toBe(0); expect(grabs).toEqual(["A"]);
    stmts.setFetchDownloading.run(0.1, null, 5e6, r.fetch_id); now += 40 * 60_000; polled(0); await requestsTick();   // it moved → the clock restarts
    r = req(request.id); expect(r.attempt).toBe(0); expect(r.state).toBe("fetching");
    now += 46 * 60_000; polled(46); await requestsTick();                      // 46 min stuck at 10% → next candidate
    r = req(request.id);
    expect(r.attempt).toBe(1); expect(grabs).toEqual(["A", "B"]); expect(logs.join("\n")).toMatch(/stalled — no progress for 46 min \(no seeders\?\)|stalled — no progress for 46 min/);
    expect(JSON.parse(r.tried_json!)).toEqual([a.guid]);
    expect(stmts.fetchById.get(r.fetch_id!)).toBeTruthy();
  });

  test("the recipes need the AI tier and there is no key: the download is kept and picked up once a key appears", async () => {
    const input = mkdtempSync(join(tmpdir(), "ahoy-req-"));
    const a = rv({ title: "A", format: "Full ISO" }), b = rv({ title: "B", format: "Full ISO", score: 100 });
    searchResults = [a, b];
    agentOn = false;
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    stmts.setFetchDone.run(input, r.fetch_id); await requestsTick();
    r = req(request.id); expect(r.state).toBe("processing");
    const held = r.job_id!;
    stmts.setJobFailed.run("failed", "only an installer (setup.exe) — nothing to extract, it has to be run — the AI importer could take over once it has an API key", held);
    await requestsTick(); await requestsTick();
    r = req(request.id);
    expect(r.state).toBe("processing"); expect(r.stage).toMatch(/needs the AI importer/); expect(r.job_id).toBe(held);
    expect(r.attempt).toBe(0); expect(grabs).toEqual(["A"]);                   // nothing burned, nothing re-grabbed
    agentOn = true;
    try {
      await requestsTick();
      r = req(request.id);
      expect(r.job_id).not.toBe(held); expect(r.stage).toBe("importing");
      expect(stmts.jobById.get(r.job_id!)).toMatchObject({ state: "queued", input_path: input, request_id: request.id });
      // the same failure while the key is there is a real failure → next candidate
      stmts.setJobFailed.run("failed", "no executable to launch", r.job_id!); await requestsTick();
      r = req(request.id); expect(r.attempt).toBe(1); expect(grabs).toEqual(["A", "B"]);
    } finally { agentOn = false; rmSync(input, { recursive: true, force: true }); }
  });

  test("the AI importer's key is rejected: hold, try again after 30 minutes, never burn the copy", async () => {
    const input = mkdtempSync(join(tmpdir(), "ahoy-req-"));
    searchResults = [rv({ title: "A", format: "Full ISO" }), rv({ title: "B", format: "Full ISO", score: 100 })];
    agentOn = true;
    try {
      const { request } = createRequest({ gameId: game.id });
      await requestsTick();
      let r = req(request.id);
      stmts.setFetchDone.run(input, r.fetch_id); await requestsTick();
      r = req(request.id); const first = r.job_id!;
      stmts.setJobFailed.run("failed", "model API HTTP 401: invalid x-api-key", first); await requestsTick(); await requestsTick();
      r = req(request.id);
      expect(r.state).toBe("processing"); expect(r.stage).toMatch(/key was rejected/); expect(r.job_id).toBe(first);
      expect(r.next_try_at).toBe(Math.floor(now / 1000) + 1800); expect(grabs).toEqual(["A"]);
      now += 31 * 60_000; await requestsTick();
      r = req(request.id);
      expect(r.job_id).not.toBe(first); expect(r.stage).toBe("importing"); expect(r.next_try_at).toBeNull(); expect(grabs).toEqual(["A"]);
    } finally { agentOn = false; rmSync(input, { recursive: true, force: true }); }
  });

  test("needs the AI tier but the download is gone: nothing to wait for → next candidate", async () => {
    searchResults = [rv({ title: "A", format: "Full ISO" }), rv({ title: "B", format: "Full ISO", score: 100 })];
    agentOn = false;
    const logs: string[] = []; rdeps.log = (...x) => logs.push(x.join(" "));
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    stmts.setFetchDone.run(join(tmpdir(), "ahoy-gone-" + Math.random()), r.fetch_id); await requestsTick();
    r = req(request.id);
    stmts.setJobFailed.run("failed", "only an installer — the AI importer could take over once it has an API key", r.job_id!); await requestsTick();
    r = req(request.id); expect(r.attempt).toBe(1); expect(grabs).toEqual(["A", "B"]); expect(logs.join("\n")).toMatch(/download is gone/);
  });

  test("a waiting request can be told to look now; what it tried stays tried", async () => {
    searchResults = [];
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id); expect(r.next_try_at).toBeGreaterThan(0);
    db.exec(`UPDATE requests SET tried_json = '["old"]' WHERE id = ${request.id}`);
    const out = retryRequest(request.id);
    expect(out.state).toBe("requested"); expect(out.stage).toBe("queued");
    r = req(request.id); expect(r.next_try_at).toBeNull(); expect(r.tried_json).toBe('["old"]');
    db.exec(`UPDATE requests SET next_try_at = ${Math.floor(now / 1000) + 3600} WHERE id = ${request.id}`);
    retryRequest(request.id, { fresh: true });                      // "forget what you tried"
    r = req(request.id); expect(r.next_try_at).toBeNull(); expect(r.tried_json).toBeNull();
    searchResults = [rv()]; await requestsTick();
    expect(req(request.id).state).toBe("fetching");
  });

  test("a tracker request on release day looks again every hour", async () => {
    searchResults = [];
    db.exec("DELETE FROM requests");
    const { request } = createRequest({ gameId: game.id, by: "tracker" });
    await requestsTick();
    expect(req(request.id).next_try_at).toBe(Math.floor(now / 1000) + 3600);
  });

  test("cancel stops the fetch and drops the row", async () => {
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    const fid = req(request.id).fetch_id!;
    await cancelRequest(request.id, true);
    expect(stmts.requestById.get(request.id)).toBeNull();
    expect(stmts.fetchById.get(fid)).toBeNull();
    await expect(cancelRequest(request.id, true)).rejects.toThrow(/not found/);
  });
});

describe("console fallback", () => {
  const ps5 = () => rv({
    title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]",
    parsed: { group: "BigBlueBox", repack: false, scene: true, version: null, edition: null, languages: null, dlc: false, junk: [], year: 2020, platform: "PlayStation 5", format: "USA / Full ISO" },
    flags: { sequel: false, extraWords: false, buried: false, yearOff: null, platform: "ps5" },
  });
  test("no PC copy: the searcher asks the console categories for the consoles the game is on, and grabs the dump", async () => {
    db.query("UPDATE games SET platforms_json='[\"PS5\"]' WHERE id=?").run(game.id);
    const calls: any[] = [];
    rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { query: {} as any, searched: [], raw: 0, ranked: opt?.categories ? [ps5()] : [], errors: [] }; };
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls.map(c => c?.categories ?? null)).toEqual([null, []]);                 // the console pass asks every category: the title names the console
    expect(calls[1].platforms).toEqual(["ps5"]);
    expect(req(request.id).state).toBe("fetching");
    expect(grabs).toEqual(["Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]"]);
  });
  test("platforms unknown: any console is asked for; fallback off in the profile: the search stays on PC", async () => {
    const calls: any[] = [];
    rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { query: {} as any, searched: [], raw: 0, ranked: [], errors: [] }; };
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls[1].platforms.length).toBeGreaterThan(10);
    expect(req(request.id).state).toBe("requested");
    const prof = createProfile({ name: "PC only", consoleFallback: false });
    try {
      db.query("UPDATE games SET profile_id=? WHERE id=?").run(prof.id, game.id);
      await cancelRequest(request.id, true);
      calls.length = 0;
      const { request: r2 } = createRequest({ gameId: game.id });
      await requestsTick();
      expect(calls).toHaveLength(1);
      expect(req(r2.id).state).toBe("requested");
    } finally {
      // a profile this test made never stays: with none before it, it would be every later game's (profileFor takes the first)
      db.query("UPDATE games SET profile_id=NULL WHERE profile_id=?").run(prof.id);
      db.query("DELETE FROM profiles WHERE id=?").run(prof.id);
    }
  });
});

describe("the version that was asked for", () => {
  const dump = (platform: string, label: string, tag: string) => rv({
    title: `Marvel.vs.Capcom.Clash.of.Super.Heroes.${tag}-GROUP (1998) [${label} / English / Full ISO]`,
    parsed: { group: "GROUP", repack: false, scene: true, version: null, edition: null, languages: null, dlc: false, junk: [], year: 1998, platform: label, format: "Full ISO" },
    flags: { sequel: false, extraWords: false, buried: false, yearOff: null, platform: platform as any },
  });
  const on = (platforms: string[], want: string | null) => db.query("UPDATE games SET platforms_json=?, want_platform=?, steam_appid=NULL WHERE id=?").run(JSON.stringify(platforms), want, game.id);
  // these are about the game's own search: no emulator is set up for the console here (tests/recipes.test.ts has that)
  const realEnsure = rdeps.ensureWay;
  beforeEach(() => { rdeps.ensureWay = async () => ({ state: "none", why: "no recipe here" }); });
  afterEach(() => { rdeps.ensureWay = realEnsure; });
  test("a console's version whose emulator is being set up: the search waits for it, a minute at a time, and asks nothing meanwhile", async () => {
    on(["Arcade", "PS3", "X360", "DC"], "arcade");
    const asked: string[] = [];
    rdeps.ensureWay = async (_g, platform) => { asked.push(platform); return { state: "waiting", emulator: "MAME", jobId: 1 }; };
    const calls: any[] = [];
    rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { query: {} as any, searched: [], raw: 0, ranked: [], errors: [] }; };
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(asked).toEqual(["arcade"]);
    expect(calls).toEqual([]);
    const r = req(request.id);
    expect(r.state).toBe("requested");
    expect(r.stage).toBe("setting up MAME for the Arcade version");
    expect(r.next_try_at! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
    // the emulator could not be set up after all: the game's own search goes on
    rdeps.ensureWay = async () => ({ state: "none", why: "it could not be set up" });
    db.query("UPDATE requests SET next_try_at=0 WHERE id=?").run(request.id);
    await requestsTick();
    expect(calls.map(c => c?.platforms)).toEqual([["arcade"]]);
  });
  test("the PC version, and no version: no emulator is set up", async () => {
    const asked: string[] = [];
    rdeps.ensureWay = async (_g, platform) => { asked.push(platform); return { state: "none", why: "" }; };
    rdeps.search = async () => ({ query: {} as any, searched: [], raw: 0, ranked: [], errors: [] });
    on(["win", "PS3"], "pc");
    createRequest({ gameId: game.id });
    await requestsTick();
    db.query("DELETE FROM requests WHERE game_id=?").run(game.id);
    on(["win", "PS3"], null);
    createRequest({ gameId: game.id });
    await requestsTick();
    expect(asked).toEqual([]);
  });
  test("a console's version: looked for by itself, for that console only, with no PC pass before it", async () => {
    on(["Arcade", "PS3", "X360", "DC"], "x360");
    const calls: any[] = [];
    rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { query: {} as any, searched: [], raw: 0, ranked: opt?.categories ? [dump("x360", "Xbox 360", "XBOX360")] : [rv()], errors: [] }; };
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls).toHaveLength(1);                                           // the PC pass was never asked
    expect(calls[0]).toMatchObject({ categories: [], platforms: ["x360"], known: ["x360"] });
    expect(req(request.id).state).toBe("fetching");
    expect(grabs).toEqual(["Marvel.vs.Capcom.Clash.of.Super.Heroes.XBOX360-GROUP (1998) [Xbox 360 / English / Full ISO]"]);
  });
  test("the arcade version of a game that is also on PC: the PC copies are not what was asked for", async () => {
    on(["win", "Arcade"], "arcade");
    const calls: any[] = [];
    rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { query: {} as any, searched: [], raw: 0, ranked: [], errors: [] }; };
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls.map(c => c?.platforms)).toEqual([["arcade"]]);
    expect(req(request.id).state).toBe("requested");                         // nothing yet: it waits and looks again
    expect(grabs).toEqual([]);
  });
  test("the fallback's profile setting does not keep a version that was asked for from being looked for", async () => {
    on(["Arcade", "PS3"], "ps3");
    const prof = createProfile({ name: "PC only (asked)", consoleFallback: false });
    try {
      db.query("UPDATE games SET profile_id=? WHERE id=?").run(prof.id, game.id);
      const calls: any[] = [];
      rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { query: {} as any, searched: [], raw: 0, ranked: [], errors: [] }; };
      createRequest({ gameId: game.id });
      await requestsTick();
      expect(calls.map(c => c?.platforms)).toEqual([["ps3"]]);
    } finally {
      db.query("UPDATE games SET profile_id=NULL WHERE profile_id=?").run(prof.id);
      db.query("DELETE FROM profiles WHERE id=?").run(prof.id);
    }
  });
  test("the PC version: no console's dump is taken in its place", async () => {
    on(["win", "PS3", "X360"], "pc");
    const calls: any[] = [];
    rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { query: {} as any, searched: [], raw: 0, ranked: [], errors: [] }; };
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.categories).toBeUndefined();                            // the PC pass, and nothing after it
    expect(req(request.id).state).toBe("requested");
  });
  test("no version asked for: as before, the PC first, then the consoles the game is on", async () => {
    on(["Arcade", "PS3", "X360", "DC"], null);
    const calls: any[] = [];
    rdeps.search = async (_n, _y, opt) => { calls.push(opt); return { query: {} as any, searched: [], raw: 0, ranked: [], errors: [] }; };
    createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls).toHaveLength(2);
    expect(calls[1].platforms).toEqual(["arcade", "ps3", "x360", "dc"]);
  });
});

describe("an import refused because the game got a built way meanwhile", () => {
  test("the request ends ready with the way's package: nothing is blocklisted and no other release is fetched", async () => {
    const a = rv({ title: "A", format: "Home Rip" }), b = rv({ title: "B", format: "Home Rip", score: 100 });
    searchResults = [a, b];
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    expect(r.state).toBe("fetching"); expect(grabs).toEqual(["A"]);
    stmts.setFetchDone.run("/dl/A", r.fetch_id); await requestsTick();
    r = req(request.id); expect(r.state).toBe("processing");
    // meanwhile the admin built a way to play: the game's copy is a recomp, and the import refuses to replace it
    const manifest = { schema: 1, name: "Hades", slug: "hades", version: null, launch: { exe: "x.exe", args: "", cwd: "" }, prerequisites: [], files: [], totalSize: 1, source: null, tier: "deterministic", kind: "recomp", platform: "n64", notes: null, createdAt: "" };
    const pkg = stmts.insertPackage.get(game.id, null, "/games/hades-way", "Hades", null, 1, JSON.stringify(manifest)) as { id: number };
    stmts.setJobFailed.run("failed", "the game has a built way; replace it from the game page", r.job_id);
    const blocked = (db.query("SELECT COUNT(*) AS n FROM blocklist").get() as { n: number }).n;
    await requestsTick();
    r = req(request.id);
    expect(r.state).toBe("ready"); expect(r.package_id).toBe(pkg.id);
    expect(grabs).toEqual(["A"]);
    expect((db.query("SELECT COUNT(*) AS n FROM blocklist").get() as { n: number }).n).toBe(blocked);
  });
});

/* ─────────── Fix A review round (2026-11-09) ─────────── */

const blockRows = () => db.query("SELECT guid, title, class FROM blocklist WHERE game_id=? ORDER BY id").all(game.id) as { guid: string | null; title: string; class: string | null }[];
const candsOf = (id: number) => (JSON.parse(req(id).candidates_json ?? "[]") as ReleaseView[]).map(c => c.guid);

describe("review: a release's other posts after a download that failed on its source", () => {
  const owRows = () => [
    row("Outer.Wilds-CODEX", { ...usenet, guid: "ds-1", size: 14.73e9 }), row("Outer.Wilds-CODEX", { ...usenet, guid: "ds-2", size: 14.75e9 }),
    row("Outer.Wilds-CODEX", { ...usenet, guid: "ds-3", size: 14.74e9 }), row("Outer Wilds-CODEX", { guid: "ipt-1", size: 14.70e9, indexer: "IPTorrents" }),
  ];
  beforeEach(() => { db.query("UPDATE games SET name='Outer Wilds', release_year=2020, release_iso=NULL, crack_status='untracked' WHERE id=?").run(game.id); db.exec("DELETE FROM blocklist"); });

  test("the round keeps a release's other posts after its distinct releases; a dead post blocks that post only, and the next post is grabbed", async () => {
    searchResults = ranked("Outer Wilds", 2020, [...owRows(), row("Outer.Wilds.v1.0.7-GOG", { guid: "gog-1", size: 6.2e9, indexer: "GGn" })]);
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(candsOf(request.id)).toEqual(["gog-1", "ds-1", "ds-2", "ds-3", "ipt-1"]);                       // the distinct releases first, then the reposts
    expect(grabs).toEqual(["Outer.Wilds.v1.0.7-GOG"]);
    stmts.setFetchState.run("failed", 0, "not found in the download client (rtorrent ABC)", req(request.id).fetch_id);
    await requestsTick();
    expect(blockRows()).toEqual([{ guid: "gog-1", title: "Outer.Wilds.v1.0.7-GOG", class: "source" }]);
    expect(grabs).toEqual(["Outer.Wilds.v1.0.7-GOG", "Outer.Wilds-CODEX"]);                                     // the next distinct release, then …
    stmts.setFetchState.run("failed", 0, "nzbget: FAILURE/HEALTH", req(request.id).fetch_id);
    await requestsTick();
    expect(blockRows().map(b => [b.guid, b.class])).toEqual([["gog-1", "source"], ["ds-1", "source"]]);
    expect(grabs).toEqual(["Outer.Wilds.v1.0.7-GOG", "Outer.Wilds-CODEX", "Outer.Wilds-CODEX"]);              // … the same release's next post
    expect(JSON.parse(req(request.id).release_json!).guid).toBe("ds-2");
  });

  test("a copy the import refused blocks its title: the same release's other posts and its copy on another tracker are passed by", async () => {
    searchResults = ranked("Outer Wilds", 2020, owRows());
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    stmts.setFetchDone.run("/dl/ow", r.fetch_id); await requestsTick();
    r = req(request.id); expect(r.state).toBe("processing");
    stmts.setJobFailed.run("failed", "no executable to launch", r.job_id); await requestsTick();
    r = req(request.id);
    expect(blockRows()).toEqual([{ guid: "ds-1", title: "Outer.Wilds-CODEX", class: null }]);
    expect(grabs).toEqual(["Outer.Wilds-CODEX"]);
    expect(r).toMatchObject({ state: "requested" }); expect(r.stage).toMatch(/^no usable copy yet/);
    // the next search: every post of it is the same refused copy
    now += 7 * 3600_000; await requestsTick();
    expect(grabs).toEqual(["Outer.Wilds-CODEX"]);
  });

  test("a transient import failure ('input is gone') and a stall are the source's: the next post is tried; the next search still has the other posts", async () => {
    searchResults = ranked("Outer Wilds", 2020, owRows());
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    let r = req(request.id);
    stmts.setFetchDone.run("/dl/ow", r.fetch_id); await requestsTick();
    r = req(request.id);
    stmts.setJobFailed.run("failed", "input is gone: /dl/ow", r.job_id); await requestsTick();
    expect(grabs).toEqual(["Outer.Wilds-CODEX", "Outer.Wilds-CODEX"]);
    expect(blockRows().map(b => b.class)).toEqual(["source"]);
    // blocked by its guid only: the next search offers the other posts again
    expect(orderCandidates(ranked("Outer Wilds", 2020, owRows()), P, { preferUsenet: true, blocked: gameBlocklist(game.id) }).map(c => c.guid)).toEqual(["ds-2", "ds-3", "ipt-1"]);
  });

  test("the same release on usenet and a tracker: the profile's protocol picks which post goes first (prefer-usenet), the other follows it", () => {
    const r = ranked("Hades", 2020, [row("Hades-CODEX", { ...usenet, guid: "u" }), row("Hades.CODEX", { guid: "t", seeders: 400 })]);
    expect(r.map(v => v.guid)).toEqual(["t", "u"]);                                                     // the torrent scores higher …
    const order = orderCandidates(r, P, { preferUsenet: true });
    expect(order.map(v => v.guid)).toEqual(["u", "t"]);                                                  // … the profile puts usenet first …
    expect(onePerRelease(order).map(v => v.guid)).toEqual(["u", "t"]);                                   // … and the round keeps that order
  });

  test("a title's versions stay apart: v1.1.2 is not v1.12", () => {
    const blocked = new Set(["Hollow.Knight.v1.1.2-GOG"]);
    expect(isBlocked(blocked, { guid: "x", title: "Hollow.Knight.v1.12-GOG" })).toBe(false);
    expect(isBlocked(blocked, { guid: "x", title: "Hollow Knight v1.1.2-GOG" })).toBe(true);
    expect(onePerRelease([rv({ title: "Hollow.Knight.v1.1.2-GOG" }), rv({ title: "Hollow.Knight.v1.12-GOG" })], 1).map(v => v.title)).toEqual(["Hollow.Knight.v1.1.2-GOG"]);
    expect(onePerRelease([rv({ title: "Game.v1.01.0-RUNE" }), rv({ title: "Game.v1.0.10-RUNE" })]).map(v => v.title)).toEqual(["Game.v1.01.0-RUNE", "Game.v1.0.10-RUNE"]);
  });

  test("a candidate list made by the rules before is judged by its title again at the grab (MW4's frozen Razor1911)", async () => {
    db.query("UPDATE games SET name=?, release_year=2026, release_iso='2026-10-22', crack_status='untracked' WHERE id=?").run(MW4, game.id);
    const logs: string[] = []; rdeps.log = (...x) => logs.push(x.join(" "));
    searchResults = [rv({ title: "Call.of.Duty.Modern.Warfare.4-RUNE", format: "Home Rip" })];
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(grabs).toEqual(["Call.of.Duty.Modern.Warfare.4-RUNE"]);
    // the list as the rules before this change made it: the 2007 game after it, certain then
    const old = rv({ title: "Call.of.Duty.4.Modern.Warfare-Razor1911", format: null, scene: true, group: "Razor1911" });
    db.query("UPDATE requests SET candidates_json=? WHERE id=?").run(JSON.stringify([JSON.parse(req(request.id).release_json!), old]), request.id);
    stmts.setFetchState.run("failed", 0, "nzbget: FAILURE/HEALTH", req(request.id).fetch_id);
    await requestsTick();
    expect(grabs).toEqual(["Call.of.Duty.Modern.Warfare.4-RUNE"]);
    expect(logs.join("\n")).toMatch(/passed by: the words of the name are in another order/);
  });
});

describe("review: the console fallback of a game that is on PC", () => {
  const calls: any[] = [];
  beforeEach(() => {
    calls.length = 0;
    rdeps.search = async (_n, _y, opt) => { calls.push(opt ?? {}); return { query: {} as any, searched: [], raw: 0, ranked: opt?.categories ? searchConsole : searchResults, errors: [] }; };
  });
  let searchConsole: ReleaseView[] = [];
  const asSteam = (crack: string | null) => db.query("UPDATE games SET name=?, release_year=2026, release_iso='2026-10-22', crack_status=?, drm='Ricochet', platforms_json='[\"win\"]' WHERE id=?").run(MW4, crack, game.id);
  const fake = () => rankForNames(nameQueries(MW4, 2026), [row("Call.of.Duty.Modern.Warfare.4.PS5-DUPLEX", { ...usenet, size: 40e6, publishDate: "2022-01-01T00:00:00Z" }), row("Call.of.Duty.Modern.Warfare.4.PS5-PRELUDE", { size: 92e9 })], { platforms: ["ps5", "ps4"], known: [] });

  test("CrackWatch says uncracked: no console dump is looked for, the search waits for a crack", async () => {
    asSteam("uncracked");
    searchResults = ranked(MW4, 2026, [row("Call.of.Duty.Modern.Warfare.4-RUNE", { size: 98e9 })]); searchConsole = fake();
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls).toHaveLength(1); expect(grabs).toEqual([]);
    expect(req(request.id).stage).toBe("waiting for a crack — searching again in 6h");
  });

  test("a Steam game whose PC copies are all refused never takes 'any console's' dump: it names no console it is on", async () => {
    asSteam("cracked");
    searchResults = ranked(MW4, 2026, mw4Rows()); searchConsole = fake();
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls).toHaveLength(1); expect(grabs).toEqual([]);
    expect(req(request.id).stage).toMatch(/^4 copies found, none certainly this game/);
  });

  test("a game on PC and on PS5 with no PC copy at all: the PS5 dumps only, a 40 MB one and one posted before the game existed refused", async () => {
    db.query("UPDATE games SET name=?, release_year=2026, release_iso='2026-10-22', crack_status=NULL, steam_appid=NULL, platforms_json=? WHERE id=?").run(MW4, JSON.stringify(["PC (Microsoft Windows)", "PlayStation 5"]), game.id);
    searchResults = [];
    searchConsole = rankForNames(nameQueries(MW4, 2026), [row("Call.of.Duty.Modern.Warfare.4.PS5-DUPLEX", { ...usenet, size: 40e6, publishDate: "2026-10-25T00:00:00Z" }),
      row("Call.of.Duty.Modern.Warfare.4.PS5-OLD", { size: 90e9, publishDate: "2022-01-01T00:00:00Z" }), row("Call.of.Duty.Modern.Warfare.4.PS5-PRELUDE", { size: 92e9 })], { platforms: ["ps5"], known: ["ps5"] });
    const ctx = autoContext(searchConsole, { release_iso: "2026-10-22", release_year: 2026 }, now);
    expect(automaticRefusals(searchConsole.find(v => v.title.endsWith("DUPLEX"))!, ctx)).toEqual(["40 MB is far too small for a PlayStation 5 game"]);
    // a store's re-release of an older game is small: the Virtual Console's 45 MB Majora's Mask on Wii U is kept
    const vc = rankForNames(nameQueries("The Legend of Zelda: Majora's Mask", 2000), [row("The.Legend.of.Zelda.Majoras.Mask.WiiU-PACT", { ...usenet, size: 45e6 })], { platforms: ["wiiu"], known: ["wiiu", "n64"] });
    expect(automaticRefusals(vc[0], autoContext(vc, { release_year: 2000 }, now))).toEqual([]);
    expect(automaticRefusals(searchConsole.find(v => v.title.endsWith("OLD"))!, ctx)[0]).toMatch(/^posted \d+ days before the game came out$/);
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(calls).toHaveLength(2); expect(calls[1].platforms).toEqual(["ps5"]);
    expect(grabs).toEqual(["Call.of.Duty.Modern.Warfare.4.PS5-PRELUDE"]);
    expect(req(request.id).state).toBe("fetching");
  });
});

describe("review: R6a, the size against the other copies", () => {
  const keep = (name: string, rows: ProwlarrRelease[], o: { now?: number; game?: GameFacts } = {}) => orderCandidates(ranked(name, null, rows), P, { preferUsenet: true, ...o }).map(v => v.title).sort();
  test("a few small posts with clean names cannot outvote the game's real size", () => {
    const real = row("Dispatch-RUNE", { size: 17.5e9 });
    const fakes = [row("Dispatch.Complete-RUNE", { ...usenet, size: 22e6 }), row("Dispatch.v1.0.1-RUNE", { ...usenet, size: 37e6 }), row("Dispatch.MULTi12-RUNE", { ...usenet, size: 46e6 })];
    expect(keep("Dispatch", [real, ...fakes])).toEqual(["Dispatch-RUNE"]);
    expect(keep("Dispatch", [real, row("Dispatch.Complete.Edition-RUNE", { size: 17.6e9 }), ...fakes, row("Dispatch.Proper-RUNE", { ...usenet, size: 51e6 })])).toEqual(["Dispatch-RUNE", "Dispatch.Complete.Edition-RUNE"].sort());
    // the real copy dead (no seeders): it still says how big the game is
    expect(keep("Dispatch", [row("Dispatch-RUNE", { size: 17.5e9, seeders: 0 }), ...fakes])).toEqual([]);
  });
  test("a copy is not refused for the size of copies the profile could never take, and one big bundle does not make the game small", () => {
    const base = row("Euro.Truck.Simulator.2.v1.0.2-SKIDROW", { ...usenet, size: 1.3e9 });
    const bundles = [11e9, 16e9, 17e9].map((s, i) => row(`Euro Truck Simulator 2 v1.5${i} + All DLC [FitGirl Repack]`, { size: s, seeders: 0 }));
    expect(keep("Euro Truck Simulator 2", [base, ...bundles])).toEqual([base.title]);
    expect(keep("Microsoft Flight Simulator", [row("Microsoft.Flight.Simulator-CODEX", { size: 8e9 }), row("Microsoft Flight Simulator v1.2 [FitGirl Repack]", { size: 9e9 }), row("Microsoft Flight Simulator Premium Deluxe Edition [DODI Repack]", { size: 100e9 })])).toHaveLength(3);
  });
  test("the size reference is made once per search: thousands of copies are judged in a moment", () => {
    const many = ranked("Hades", null, Array.from({ length: 5000 }, (_, i) => row(`Hades.v1.${i}-CODEX`, { size: 5e9 + i * 1e6 })));
    const t0 = performance.now();
    expect(orderCandidates(many, P, { preferUsenet: true })).toHaveLength(5000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("review: R10, posted before the game existed", () => {
  const take = (name: string, rows: ProwlarrRelease[], g: GameFacts) => orderCandidates(ranked(name, g.release_year ?? null, rows), P, { preferUsenet: true, game: g, now: AT }).map(v => v.title);
  test("a year tag two years off still says how old the game is (a refused copy can vouch for the date)", () => {
    const g: GameFacts = { release_iso: "2026-06-01", release_year: 2026, first_release_date: null, crack_status: "cracked", drm: null };
    const ggn = row("Valhallish (2024) [Windows / Multi-Language / Full ISO]", { size: 60e9, publishDate: "2024-12-01T00:00:00Z" });
    const empress = row("Valhallish-EMPRESS", { ...usenet, size: 58e9, publishDate: "2025-01-10T00:00:00Z" });
    expect(take("Valhallish", [ggn, empress], g)).toEqual([empress.title]);
    expect(take("Valhallish", [empress], g)).toEqual([]);                                                // without the tag: posted before the game existed
  });
  test("an older game's store date is often a re-release on Steam: its launch posts within two years before it are the game; a new game's are not", () => {
    const ra3: GameFacts = { release_iso: "2009-01-08", release_year: 2009, first_release_date: null, crack_status: null, drm: null };
    expect(take("Command & Conquer™ Red Alert™ 3", [row("Command.And.Conquer.Red.Alert.3-RELOADED", { ...usenet, size: 10.7e9, publishDate: "2008-10-30T00:00:00Z" })], ra3)).toEqual(["Command.And.Conquer.Red.Alert.3-RELOADED"]);
    const control: GameFacts = { release_iso: "2020-08-27", release_year: 2020, first_release_date: null, crack_status: "cracked", drm: null };
    expect(take("Control", [row("Control-CODEX", { ...usenet, size: 26e9, publishDate: "2019-08-26T00:00:00Z" })], control)).toEqual(["Control-CODEX"]);
    const ds: GameFacts = { release_iso: "2023-01-27", release_year: 2023, first_release_date: null, crack_status: "cracked", drm: null };
    expect(take("Dead Space", [row("Dead.Space-RELOADED", { ...usenet, size: 7e9, publishDate: "2008-10-21T00:00:00Z" })], ds)).toEqual([]);   // the 2008 game, years before
    const recent: GameFacts = { release_iso: "2026-10-21", release_year: 2026, first_release_date: null, crack_status: "cracked", drm: null };
    expect(take("Stupid Never Dies", [row("Stupid.Never.Dies-RUNE", { size: 3e9, publishDate: "2026-08-12T00:00:00Z" })], recent)).toEqual([]);   // 70 days early, a new game
  });
  test("a placeholder post date is no date", () => {
    const g: GameFacts = { release_iso: "2026-10-21", release_year: 2026, first_release_date: null, crack_status: "cracked", drm: null };
    for (const o of [{ publishDate: "0001-01-01T00:00:00Z" }, { publishDate: "1970-01-01T00:00:00Z" }, { publishDate: "", age: 30000 }]) {
      expect(take("Stupid Never Dies", [row("Stupid.Never.Dies-RUNE", { size: 3e9, ...o })], g)).toEqual(["Stupid.Never.Dies-RUNE"]);
    }
  });
});

describe("review: R11, a game CrackWatch says is not cracked", () => {
  const wukong: GameFacts = { release_iso: "2024-08-20", release_year: 2024, first_release_date: null, crack_status: "uncracked", drm: "Denuvo" };
  test("only a copy a curated tracker marks DRM-free is exempt: a 'GOG' word or group in a free-text name is not", () => {
    const r = ranked("Black Myth: Wukong", 2024, [row("Black.Myth.Wukong-GOG", { ...usenet, size: 128e9 }), row("Black Myth Wukong v1.0.8 GOG [FitGirl Repack]", { size: 70e9 }), row("Black Myth Wukong (DRM-Free)", { size: 125e9 }), row("Black.Myth.Wukong.v1.0.8-GOG", { size: 128e9 })]);
    expect(orderCandidates(r, P, { preferUsenet: true, game: wukong, now: AT })).toEqual([]);
  });
  test("beside a curated DRM-free copy, the trusted repackers' builds and the GOG-named posts of it are taken too", () => {
    const kcd: GameFacts = { release_iso: "2025-02-04", release_year: 2025, first_release_date: null, crack_status: "uncracked", drm: "Denuvo" };
    const rows = [row("Kingdom Come: Deliverance II (2025) [GOG Edition 2025] [Windows / Multi-Language / DRM Free]", { size: 110e9 }), row("Kingdom Come: Deliverance II - Gold Edition (v1.2.1 + 3 DLCs, MULTi14) [FitGirl Repack]", { size: 60e9 }),
      row("Kingdom.Come.Deliverance.II-ElAmigos", { size: 100e9 }), row("Kingdom Come: Deliverance II [DODI Repack]", { size: 70e9 }), row("Kingdom.Come.Deliverance.II-GOG", { ...usenet, size: 108e9 }), row("Kingdom.Come.Deliverance.II-RUNE", { ...usenet, size: 109e9 })];
    expect(orderCandidates(ranked("Kingdom Come: Deliverance II", 2025, rows), P, { preferUsenet: true, game: kcd, now: AT }).map(v => v.title).sort()).toEqual(rows.slice(0, 5).map(x => x.title).sort());
  });
});

describe("review: what a search that took nothing says", () => {
  test("refused by the profile: the stage counts what was found and the message gives the first reason before the release's name", async () => {
    db.query("UPDATE games SET name=?, release_year=2026, release_iso='2026-10-22', crack_status='untracked' WHERE id=?").run(MW4, game.id);
    searchResults = ranked(MW4, 2026, [...mw4Rows(), row("Call.of.Duty.Modern.Warfare.4-RUNE", { size: 98e9, seeders: 0, publishDate: "2026-11-01T00:00:00Z" })]);
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    const r = req(request.id);
    expect(r.stage).toBe("5 copies found, none taken — searching again in 6h");
    expect(r.message).toBe(`${REORDERED} — Call.of.Duty.4.Modern.Warfare-Razor1911`);
    expect((JSON.parse(r.refused_json!) as Refused[]).find(x => x.title === "Call.of.Duty.Modern.Warfare.4-RUNE")!.why).toEqual(["no seeders"]);
  });
});

describe("review: a stale 'not out yet' on release day", () => {
  test("the store says the game is out and CrackWatch said 'unreleased' hours ago: it is asked again before the search", async () => {
    const day = new Date(now).toISOString().slice(0, 10);
    db.query("UPDATE games SET name='Stupid Never Dies', release_year=NULL, release_iso=?, crack_status='unreleased', crackwatch_at=? WHERE id=?").run(day, Math.floor(now / 1000) - 5 * 3600, game.id);
    const looked: string[] = [];
    rdeps.crackCheck = async g => { looked.push(g.name); db.query("UPDATE games SET crack_status='cracked', crackwatch_at=? WHERE id=?").run(Math.floor(now / 1000), g.id); return { status: "cracked" }; };
    searchResults = ranked("Stupid Never Dies", null, [row("Stupid.Never.Dies-TENOKE", { size: 3e9, publishDate: new Date(now - 3600_000).toISOString() })]);
    const { request } = createRequest({ gameId: game.id, by: "tracker" });
    await requestsTick();
    expect(looked).toEqual(["Stupid Never Dies"]);
    expect(grabs).toEqual(["Stupid.Never.Dies-TENOKE"]); expect(req(request.id).state).toBe("fetching");
  });
  test("CrackWatch still says 'unreleased' after the store date: the search waits, and says CrackWatch has no verdict on the release yet", async () => {
    const day = new Date(now - 86_400_000).toISOString().slice(0, 10);
    db.query("UPDATE games SET name='Stupid Never Dies', release_year=NULL, release_iso=?, crack_status='unreleased', crackwatch_at=? WHERE id=?").run(day, Math.floor(now / 1000) - 5 * 3600, game.id);
    rdeps.crackCheck = async g => { db.query("UPDATE games SET crackwatch_at=? WHERE id=?").run(Math.floor(now / 1000), g.id); return { status: "unreleased" }; };
    searchResults = ranked("Stupid Never Dies", null, [row("Stupid.Never.Dies-TENOKE", { size: 3e9 })]);
    const { request } = createRequest({ gameId: game.id, by: "tracker" });
    await requestsTick();
    const r = req(request.id);
    expect(grabs).toEqual([]); expect(r.stage).toBe("waiting for a crack — searching again in 1h");
    expect(r.message).toBe("CrackWatch has no verdict on the release yet (it still lists the game as not out) — Stupid.Never.Dies-TENOKE");
  });
});

describe("review 2026-11-10: one download has one search, and a download in the finished-downloads folder keeps its record", () => {
  const otherGame = () => stmts.upsertGame({
    igdb_id: null, steam_appid: 999001, name: "Hades Again", slug: "hades-again", summary: null, storyline: null, release_year: 2020, first_release_date: null,
    rating: null, cover_url: "c.jpg", banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: "[]",
    game_modes_json: "[]", developer: null, publisher: null,
  });
  /** grab as src/fetch.ts answers the same post again: the download it already has, `duplicate` */
  const sharingGrab = () => {
    const byGuid = new Map<string, number>();
    rdeps.grab = async (rel, gameId) => {
      grabs.push(rel.title);
      const had = byGuid.get(rel.guid);
      if (had != null && stmts.fetchById.get(had)) return { fetch: { id: had } as any, duplicate: true };
      const row = stmts.insertFetch({ game_id: gameId, guid: rel.guid, indexer_id: rel.indexerId, indexer: rel.indexer, title: rel.title, protocol: rel.protocol, size: rel.size, info_hash: null, client: "rtorrent", client_id: "x", state: "submitted", release_json: JSON.stringify(rel) });
      byGuid.set(rel.guid, row.id);
      return { fetch: { id: row.id } as any, duplicate: false };
    };
  };
  test("a post another search is downloading is passed by (no try, nothing blocklisted), and that search keeps its download", async () => {
    sharingGrab();
    const logs: string[] = []; rdeps.log = (...x) => logs.push(x.join(" "));
    const second = otherGame();
    const a = createRequest({ gameId: game.id }).request;
    await requestsTick();
    const fid = req(a.id).fetch_id!;
    expect(req(a.id).state).toBe("fetching");
    const b = createRequest({ gameId: second.id }).request;
    await requestsTick();
    const rb = req(b.id);
    expect(rb.fetch_id).toBeNull();                                            // never two searches on one download
    expect(rb.state).toBe("requested");
    expect(rb.message).toMatch(/another search \(Hades\) is already downloading this very copy/);
    expect(rb.tried_json ?? "[]").toBe("[]");
    expect(gameBlocklist(second.id)).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/passed by: search #\d+ is already on its download/);
    await cancelRequest(b.id, true);
    expect(stmts.fetchById.get(fid)).toBeTruthy();
    expect(req(a.id).state).toBe("fetching");
  });
  test("two searches already on one download (rows from before): cancelling one or its stall leaves the download to the other", async () => {
    sharingGrab();
    const second = otherGame();
    const a = createRequest({ gameId: game.id }).request;
    await requestsTick();
    const fid = req(a.id).fetch_id!;
    const b = createRequest({ gameId: second.id }).request;
    db.query("UPDATE requests SET state='fetching', fetch_id=? WHERE id=?").run(fid, b.id);
    await cancelRequest(b.id, true);
    expect(stmts.fetchById.get(fid)).toBeTruthy();                             // A's download stays
    await requestsTick();
    expect(req(a.id).state).toBe("fetching"); expect(req(a.id).fetch_id).toBe(fid);
    await cancelRequest(a.id, true);                                            // the last search on it takes it along, as before
    expect(stmts.fetchById.get(fid)).toBeNull();
  });
  /** game A's search downloading release R, game B's own search downloading another release S */
  const twoSearches = async () => {
    const second = otherGame();
    const a = createRequest({ gameId: game.id }).request;
    await requestsTick();
    const S = rv({ title: "Hades Again (2020) [Windows / English / Home Rip]" });
    searchResults = [S];
    const b = createRequest({ gameId: second.id }).request;
    await requestsTick();
    expect([req(a.id).state, req(b.id).state]).toEqual(["fetching", "fetching"]);
    expect(req(b.id).fetch_id).not.toBe(req(a.id).fetch_id);
    return { second, a: req(a.id), b: req(b.id), R: JSON.parse(req(a.id).release_json!) as ReleaseView, S };
  };
  test("a pick by hand refused because another search is downloading that copy leaves the game's own search and download as they were", async () => {
    sharingGrab();
    const { second, a, b, R } = await twoSearches();
    grabs.length = 0;
    const err = await grabManually(R, second.id).then(() => null, e => e);
    expect(err).toBeInstanceOf(RequestError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/already being downloaded for another search \(Hades\)/);
    expect(grabs).toEqual([]);                                                 // refused before anything was asked for or touched
    expect(req(b.id)).toMatchObject({ state: "fetching", fetch_id: b.fetch_id });   // B's own search, still on its own download
    expect(stmts.fetchById.get(b.fetch_id!)).toBeTruthy();
    expect(req(a.id)).toMatchObject({ state: "fetching", fetch_id: a.fetch_id });
    expect((db.query("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n).toBe(2);
  });
  test("the same torrent under another post (known only once it is grabbed) is refused the same way: nothing of the game's is cancelled", async () => {
    sharingGrab();
    const { second, a, b, R } = await twoSearches();
    // another indexer's post of R's torrent: no download carries its guid, the grab finds A's by the info hash
    const other = rv({ title: R.title, indexer: "Other", indexerId: 12 });
    const real = rdeps.grab;
    rdeps.grab = async (rel, gameId) => (rel.guid === other.guid ? { fetch: { id: a.fetch_id! } as any, duplicate: true } : real(rel, gameId));
    const err = await grabManually(other, second.id).then(() => null, e => e);
    expect(err?.status).toBe(409);
    expect(req(b.id)).toMatchObject({ state: "fetching", fetch_id: b.fetch_id });
    expect(stmts.fetchById.get(b.fetch_id!)).toBeTruthy();
    expect(req(a.id)).toMatchObject({ state: "fetching", fetch_id: a.fetch_id });
    expect(stmts.fetchById.get(a.fetch_id!)).toBeTruthy();
  });
  test("a pick that is taken replaces the game's own search and its download, as before; one whose grab fails changes nothing", async () => {
    sharingGrab();
    const { second, b } = await twoSearches();
    const bad = rv({ title: "Hades Again v2 (2020) [Windows / English / Home Rip]" });
    const real = rdeps.grab;
    rdeps.grab = async (rel, gameId) => { if (rel.guid === bad.guid) throw new Error("PROWLARR_DOWNLOAD_HTTP_429"); return real(rel, gameId); };
    await expect(grabManually(bad, second.id)).rejects.toThrow(/429/);
    expect(req(b.id)).toMatchObject({ state: "fetching", fetch_id: b.fetch_id });   // the pick failed: the search it would have replaced goes on
    expect(stmts.fetchById.get(b.fetch_id!)).toBeTruthy();
    const pick = rv({ title: "Hades Again v3 (2020) [Windows / English / Home Rip]" });
    const out = await grabManually(pick, second.id);
    expect(out.duplicate).toBe(false);
    expect(req(b.id)).toBeNull();                                              // the own search is gone …
    expect(stmts.fetchById.get(b.fetch_id!)).toBeNull();                       // … and its download with it
    expect(req(out.request.id)).toMatchObject({ state: "fetching", requested_by: "manual", fetch_id: out.download.id });
    expect(stmts.fetchById.get(out.download.id)).toBeTruthy();
    expect((stmts.requestActiveForGame.get(second.id) as RequestRow).id).toBe(out.request.id);
  });
  test("picking the very copy the game's own search is downloading keeps that download: the new search takes it over", async () => {
    sharingGrab();
    const { second, b, S } = await twoSearches();
    const out = await grabManually(S, second.id);
    expect(out.duplicate).toBe(true);
    expect(out.download.id).toBe(b.fetch_id!);
    expect(req(b.id)).toBeNull();
    expect(stmts.fetchById.get(b.fetch_id!)).toBeTruthy();                     // never dropped from under the pick
    expect(req(out.request.id)).toMatchObject({ state: "fetching", requested_by: "manual", fetch_id: b.fetch_id });
  });
  test("cancelling a search whose download already lies in the finished-downloads folder keeps the download's record", async () => {
    const { rmdeps } = await import("../src/remote");
    const { remove } = await import("../src/fetch");
    const root = mkdtempSync(join(tmpdir(), "ludarr-finished-"));
    const saved = rmdeps.roots;
    rmdeps.roots = () => [{ from: "", to: root, client: "", instanceId: 0, kind: "synced" as const }];
    try {
      const { request } = createRequest({ gameId: game.id });
      await requestsTick();
      const fid = req(request.id).fetch_id!;
      const place = join(root, "Hades-GOG");
      mkdirSync(place); writeFileSync(join(place, "game.bin"), "12345");
      db.query("UPDATE fetches SET state='done', progress=1, local_path=? WHERE id=?").run(place, fid);
      await cancelRequest(request.id, true);
      expect(stmts.requestById.get(request.id)).toBeNull();
      const kept = stmts.fetchById.get(fid) as { state: string; local_path: string; imported_at: number | null } | null;
      expect(kept).toMatchObject({ state: "done", local_path: place, imported_at: null });      // still there for the leftovers list
      await expect(remove(fid, false)).rejects.toThrow(/still in the finished-downloads folder/);   // DELETE /download/:id says why
      rmSync(place, { recursive: true, force: true });                                              // once its files are gone, the record may go
      await remove(fid, false);
      expect(stmts.fetchById.get(fid)).toBeNull();
    } finally { rmdeps.roots = saved; rmSync(root, { recursive: true, force: true }); }
  });
});
