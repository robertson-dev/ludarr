import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db, stmts, type GameRow, type RequestRow } from "../src/db";
import { rdeps, createRequest, requestsTick, orderCandidates, autoContext, automaticRefusals, drmKind, mayVouch, type GameFacts } from "../src/requests";
import { nameQueries, rankForNames, type ReleaseView } from "../src/releases";
import type { ProwlarrRelease } from "../src/prowlarr";
import { DEFAULT_PROFILE } from "../src/library/profiles";
import { CONFIG_KEYS } from "../src/config";
import { rssdeps, rssSync } from "../src/rss";

/* ─────────── the CrackWatch rule: a game with Steam's own DRM (or none) is cracked once GazelleGames has a group's release ─────────── */

const P = { id: 0, ...DEFAULT_PROFILE };
const row = (title: string, o: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: `g:${title}:${Math.random().toString(36).slice(2, 8)}`, title, instanceId: 1, indexerId: 8, indexer: "GazelleGames", size: 3e9, age: 0, publishDate: "",
  seeders: 20, leechers: 0, grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent",
  categories: [], indexerFlags: [], fileName: null, ...o,
});
/** a usenet post (anyone can post any name there) */
const nzb = (title: string, o: Partial<ProwlarrRelease> = {}) => row(title, { indexer: "DrunkenSlug", indexerId: 20, protocol: "usenet", seeders: null, ...o });
const ranked = (name: string, year: number | null, rows: ProwlarrRelease[]) => rankForNames(nameQueries(name, year), rows);
const titles = (v: ReleaseView[]) => v.map(x => x.title);
const facts = (iso: string, crack: string | null, drm: string | null, o: GameFacts = {}): GameFacts => ({ release_iso: iso, release_year: Number(iso.slice(0, 4)), first_release_date: null, crack_status: crack, drm, ...o });
const take = (name: string, year: number, f: GameFacts, rows: ProwlarrRelease[], at: string | number, o: { blocked?: Set<string>; tried?: Set<string>; profile?: typeof P } = {}) =>
  titles(orderCandidates(ranked(name, year, rows), o.profile ?? P, { preferUsenet: true, game: f, now: typeof at === "number" ? at : Date.parse(at), blocked: o.blocked, tried: o.tried }));
const ctxOf = (name: string, year: number, f: GameFacts, rows: ProwlarrRelease[], at: string | number) => { const r = ranked(name, year, rows); return { r, ctx: autoContext(r, f, typeof at === "number" ? at : Date.parse(at)) }; };

/** Probably Stolen (game 53, Steam 4348910, out 2026-10-28): CrackWatch said "uncracked" (Steam) and request 58 refused all
 *  seven copies it found at 2026-11-09 22:00 as "a copy now would be a fake" — titles, sizes and trackers as the live server
 *  kept them; the post dates (the export keeps none) after the store date: TENOKE's on release day, the rest days later */
const PS = "Probably Stolen - Cyberpunk Shopkeeper Sim";
const PS_FACTS: GameFacts = { release_iso: "2026-10-28", release_year: 2026, first_release_date: null, crack_status: "uncracked", drm: "Steam" };
const PS_AT = Date.parse("2026-11-09T22:00:36Z");
const TENOKE_GGN = "Probably.Stolen.Cyberpunk.Shopkeeper.Sim-TENOKE (2026) [Windows / Multi-Language / Full ISO]";
const HOME_RIP = "Probably Stolen: Cyberpunk Shopkeeper Sim (2026) [Windows / Multi-Language / Home Rip]";
const FITGIRL = "Probably Stolen: Cyberpunk Shopkeeper Sim v1.00-REV2 + Bonus OST [FitGirl Repack] (2026) [Windows / Multi-Language / P2P Full Repack]";
const psRows = (date: (i: number) => string = i => ["2026-10-28T19:12:00Z", "2026-10-28T19:40:00Z", "2026-10-28T19:31:00Z", "2026-11-02T09:00:00Z", "2026-10-30T11:00:00Z", "2026-10-28T20:05:00Z", "2026-10-28T21:10:00Z"][i]) => [
  row(TENOKE_GGN, { size: 2_649_354_589, publishDate: date(0) }),
  row("Probably Stolen Cyberpunk Shopkeeper Sim-TENOKE", { indexer: "IPTorrents", size: 2_641_404_887, publishDate: date(1) }),
  row("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-TENOKE", { indexer: "FileList.io", size: 3_383_982_034, publishDate: date(2) }),
  row(HOME_RIP, { size: 343_741_577, publishDate: date(3) }),
  row(FITGIRL, { size: 613_858_544, publishDate: date(4) }),
  row("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-TENOKE", { indexer: "Milkie", size: 3_383_981_630, publishDate: date(5) }),
  row("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-TENOKE", { indexer: "PreToMe", size: 2_652_142_305, publishDate: date(6) }),
];
const WHY_PS = "CrackWatch says not cracked, but TENOKE released it: Steam's own DRM only";
const WAITS_STEAM = "CrackWatch says the game is not cracked yet (Steam)";
/** a copy of Probably Stolen nobody vouches for: another uploader's, on a tracker */
const PLAIN = (o: Partial<ProwlarrRelease> = {}) => row("Probably Stolen Cyberpunk Shopkeeper Sim", { indexer: "TorrentGalaxy", indexerId: 31, size: 2.6e9, seeders: 80, publishDate: "2026-10-30T09:00:00Z", ...o });

describe("what CrackWatch's DRM field says", () => {
  test("Steam's own DRM, none, a protection that holds, or a name the rule does not know", () => {
    for (const d of ["Steam", "Steamworks", "Steam DRM", "SteamStub", "Steam CEG", "steam"]) expect([d, drmKind(d)]).toEqual([d, "steam"]);
    for (const d of ["None", "DRM-Free", "DRM Free", "No DRM"]) expect([d, drmKind(d)]).toEqual([d, "none"]);
    for (const d of ["Denuvo", "Denuvo + Steam", "Steam + Denuvo", "Steam, Denuvo", "Steam / EA app", "EA App", "EA Anti-Cheat", "Origin", "Ubisoft Connect", "Uplay + Steam",
      "Arxan", "Steam + Arxan", "VMProtect", "Ricochet + Battle.net", "Always-online", "Always Online + Steam", "Microsoft Store", "UWP", "Xbox App"]) expect([d, drmKind(d)]).toEqual([d, "strong"]);
    for (const d of [null, "", "Theia + PSN", "Ricochet", "Easy Anti-Cheat", "Rockstar Games Launcher", "DRM", "Steam + Online", "TBD"]) expect([d, drmKind(d)]).toEqual([d, "unknown"]);
  });
  test("the field's other spellings: a store in brackets, an anti-cheat or Epic's services beside Steam, a protection removed, a version", () => {
    for (const d of ["DRM-Free (GOG)", "No DRM (Steam)", "Steam (DRM-free)", "GOG"]) expect([d, drmKind(d)]).toEqual([d, "none"]);
    for (const d of ["Steam (Steamworks)", "SteamStub v3", "Steam API", "Steam + VAC", "Steam + Easy Anti-Cheat", "Steam + BattlEye", "Steam + EOS", "Steam / GOG",
      "Steam, Denuvo removed", "Steam (Denuvo removed)", "Denuvo (removed)"]) expect([d, drmKind(d)]).toEqual([d, "steam"]);
    // a protection still there beside one removed holds
    expect(drmKind("Steam, Denuvo (removed) + Arxan")).toBe("strong");
  });
});

describe("Probably Stolen: CrackWatch says uncracked, its only DRM is Steam's, and TENOKE released it on GazelleGames", () => {
  test("its seven copies are taken, the profile's best first (the Home Rip, then the TENOKE ISO and its posts, then FitGirl's repack)", () => {
    const r = ranked(PS, 2026, psRows());
    const order = orderCandidates(r, P, { preferUsenet: true, game: PS_FACTS, now: PS_AT });
    expect(order).toHaveLength(7);
    expect(order[0].title).toBe(HOME_RIP);
    expect(order[1].title).toBe(TENOKE_GGN);
    expect(order[6].title).toBe(FITGIRL);
    const ctx = autoContext(r, PS_FACTS, PS_AT);
    expect(ctx.crack).toBeNull();
    expect(ctx.cracked).toMatchObject({ by: "TENOKE", title: TENOKE_GGN, why: WHY_PS, out: Date.parse("2026-10-28") });
    for (const v of r) expect([v.title, automaticRefusals(v, ctx)]).toEqual([v.title, []]);
  });
  test("FitGirl's repack on GazelleGames is enough; the copy named is a group's before a repacker's before a Home Rip", () => {
    const fg = ranked(PS, 2026, [row(HOME_RIP, { size: 343_741_577, publishDate: "2026-11-02T09:00:00Z" }), row(FITGIRL, { size: 613_858_544, publishDate: "2026-10-30T11:00:00Z" })]);
    expect(autoContext(fg, PS_FACTS, PS_AT).cracked?.why).toBe("CrackWatch says not cracked, but FitGirl released it: Steam's own DRM only");
    expect(orderCandidates(fg, P, { preferUsenet: true, game: PS_FACTS, now: PS_AT })).toHaveLength(2);
    expect(autoContext(ranked(PS, 2026, psRows()), PS_FACTS, PS_AT).cracked?.title).toBe(TENOKE_GGN);
  });
  test("no copy that says so posted since the game came out: it waits, and says why the copies found do not count", () => {
    const early = ranked(PS, 2026, psRows(() => "2026-10-20T10:00:00Z"));
    expect(orderCandidates(early, P, { preferUsenet: true, game: PS_FACTS, now: PS_AT })).toEqual([]);
    expect(autoContext(early, PS_FACTS, PS_AT).cracked).toBeNull();
    expect(automaticRefusals(early.find(v => v.title === HOME_RIP)!, autoContext(early, PS_FACTS, PS_AT))[0]).toMatch(/^CrackWatch says the game is not cracked yet \(Steam\): .+ was posted before the game came out$/);
    const undated = ranked(PS, 2026, psRows(() => ""));
    expect(orderCandidates(undated, P, { preferUsenet: true, game: PS_FACTS, now: PS_AT })).toEqual([]);
    expect(automaticRefusals(undated[0], autoContext(undated, PS_FACTS, PS_AT))[0]).toMatch(/^CrackWatch says the game is not cracked yet \(Steam\): .+ has no post date$/);
    // nothing anyone made at all: the message says so
    const plain = ranked(PS, 2026, [PLAIN()]);
    expect(automaticRefusals(plain[0], autoContext(plain, PS_FACTS, PS_AT))).toEqual([`${WAITS_STEAM}, and no cracking group or repacker has released it since it came out`]);
    // the game not out by its store date ("uncracked" before release day): no post can say it is cracked
    expect(take(PS, 2026, PS_FACTS, psRows(), "2026-10-27T12:00:00Z")).toEqual([]);
  });
  test("every other rule still applies: a copy posted long before the game existed, a copy far smaller than the others", () => {
    const old = row("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-RUNE", { size: 2.6e9, publishDate: "2025-06-01T00:00:00Z" });
    const tiny = nzb("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-DOGE", { size: 20e6, publishDate: "2026-10-29T00:00:00Z" });
    const r = ranked(PS, 2026, [...psRows(), old, tiny]);
    const ctx = autoContext(r, PS_FACTS, PS_AT);
    expect(automaticRefusals(r.find(v => v.title === old.title)!, ctx)).toEqual(["posted 214 days before the game came out", "posted before the game came out: only copies posted since say it is cracked (CrackWatch says not cracked)"]);
    expect(automaticRefusals(r.find(v => v.title === tiny.title)!, ctx)).toEqual(["far smaller than the other copies (20 MB against 2.6 GB): an update or a fake"]);
    expect(titles(orderCandidates(r, P, { preferUsenet: true, game: PS_FACTS, now: PS_AT }))).not.toContain(old.title);
  });
});

describe("a copy that says the game is cracked is believed from GazelleGames only (review: a lone post anywhere else)", () => {
  const AT = "2026-11-09T12:00:00Z";
  test("Dead by Daylight (CrackWatch: uncracked, Steam; online-only since 2016): a usenet -CODEX, a public tracker's repack, even GazelleGames' own copy", () => {
    const dbd = facts("2016-06-14", "uncracked", "Steam");
    expect(take("Dead by Daylight", 2016, dbd, [nzb("Dead.by.Daylight-CODEX", { size: 42e9, publishDate: "2026-10-20T03:00:00Z" })], AT)).toEqual([]);
    expect(take("Dead by Daylight", 2016, dbd, [row("Dead by Daylight v9.3.0 [FitGirl Repack]", { indexer: "1337x", indexerId: 30, size: 25e9, seeders: 40, publishDate: "2026-09-02T10:00:00Z" })], AT)).toEqual([]);
    const ggn = [row("Dead by Daylight (2016) [Windows / Multi-Language / Home Rip]", { size: 40e9, publishDate: "2026-10-01T00:00:00Z" })];
    expect(take("Dead by Daylight", 2016, dbd, ggn, AT)).toEqual([]);
    const { r, ctx } = ctxOf("Dead by Daylight", 2016, dbd, ggn, AT);
    const days = Math.round((Date.parse(AT) - Date.parse("2016-06-14")) / 86_400_000);
    expect(automaticRefusals(r[0], ctx)).toEqual([`${WAITS_STEAM}: out ${days} days ago: CrackWatch is not that far behind`]);
  });
  test("ArcheAge Chronicles (an MMO, out 2026-11-03): a usenet -RUNE does not unlock other uploaders' posts; on GazelleGames, an online game still waits", () => {
    const aac = facts("2026-11-03", "uncracked", "Steam");
    const rows = [
      nzb("ArcheAge.Chronicles-RUNE", { size: 48e9, publishDate: "2026-11-05T09:00:00Z" }),
      row("ArcheAge Chronicles PC Game", { indexer: "TorrentGalaxy", indexerId: 31, size: 45e9, seeders: 300, publishDate: "2026-11-04T09:00:00Z" }),
    ];
    expect(take("ArcheAge Chronicles", 2026, aac, rows, AT)).toEqual([]);
    const { r, ctx } = ctxOf("ArcheAge Chronicles", 2026, aac, rows, AT);
    expect(automaticRefusals(r.find(v => v.indexer === "TorrentGalaxy")!, ctx)).toEqual([`${WAITS_STEAM}: RUNE's release is not on GazelleGames, whose staff check it`]);
    const ggn = [...rows, row("ArcheAge.Chronicles-RUNE (2026) [Windows / Multi-Language / Full ISO]", { size: 48e9, publishDate: "2026-11-05T10:00:00Z" })];
    const mmo = { ...aac, genres_json: JSON.stringify(["Massively Multiplayer", "RPG"]) };
    expect(take("ArcheAge Chronicles", 2026, mmo, ggn, AT)).toEqual([]);
    const m = ctxOf("ArcheAge Chronicles", 2026, mmo, ggn, AT);
    expect(automaticRefusals(m.r[0], m.ctx)).toEqual([`${WAITS_STEAM}: an online game: what holds it is the server`]);
  });
  test("Probably Stolen's lone posts: a 40 MB -DOGE, a lowercase -tenoke, a retired group's -CODEX, each alone on usenet", () => {
    for (const lone of [nzb("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-DOGE", { size: 40e6, publishDate: "2026-10-29T00:00:00Z" }),
      nzb("probably.stolen.cyberpunk.shopkeeper.sim-tenoke", { size: 2.6e9, publishDate: "2026-10-29T00:00:00Z" }),
      nzb("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-CODEX", { size: 2.6e9, publishDate: "2026-10-29T00:00:00Z" })]) {
      expect([lone.title, take(PS, 2026, PS_FACTS, [lone], PS_AT)]).toEqual([lone.title, []]);
      expect([lone.title, take(PS, 2026, PS_FACTS, [lone, PLAIN()], PS_AT)]).toEqual([lone.title, []]);
    }
  });
  test("the adversarial set's RUNE-named fakes of games that hold, as CrackWatch labels Dead by Daylight (uncracked, Steam), and a fake on two trackers", () => {
    const at = Date.parse("2026-11-09T00:00:00Z");
    expect(take("Black Myth: Wukong", 2024, facts("2024-08-20", "uncracked", "Steam"), [row("Black.Myth.Wukong-RUNE", { indexer: "x", size: 130e9, publishDate: "2024-08-22T00:00:00Z" })], at)).toEqual([]);
    expect(take("Call of Duty®: Black Ops 7", 2025, facts("2025-11-14", "uncracked", "Steam"), [row("Call.of.Duty.Black.Ops.7-RUNE", { indexer: "x", size: 60e9, publishDate: "2025-11-15T00:00:00Z" })], Date.parse("2025-11-20T00:00:00Z"))).toEqual([]);
    const twice = [row("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-RUNE", { indexer: "1337x", indexerId: 30, size: 2.6e9, publishDate: "2026-10-29T00:00:00Z" }),
      row("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-RUNE", { indexer: "ThePirateBay", indexerId: 32, size: 2.6e9, publishDate: "2026-10-29T02:00:00Z" })];
    expect(take(PS, 2026, PS_FACTS, twice, PS_AT)).toEqual([]);
  });
});

describe("only a copy the search may believe says it is cracked (review: blocklisted, tried, a blocked group)", () => {
  const tenoke = row(TENOKE_GGN, { size: 2_649_354_589, publishDate: "2026-10-28T19:12:00Z" });
  const other = PLAIN();
  test("refused as a bad copy (its title on the blocklist), of a group the profile blocks, with a word it rules out: none of them vouches", () => {
    expect(take(PS, 2026, PS_FACTS, [tenoke, other], PS_AT)).toEqual(expect.arrayContaining([tenoke.title, other.title]));
    expect(take(PS, 2026, PS_FACTS, [tenoke, other], PS_AT, { blocked: new Set([tenoke.guid, tenoke.title]) })).toEqual([]);
    expect(take(PS, 2026, PS_FACTS, [tenoke, other], PS_AT, { profile: { ...P, blockedGroups: ["TENOKE"] } })).toEqual([]);
    expect(take(PS, 2026, PS_FACTS, [tenoke, other], PS_AT, { profile: { ...P, mustNotContain: ["TENOKE"] } })).toEqual([]);
    const { r, ctx } = ctxOf(PS, 2026, PS_FACTS, [tenoke, other], PS_AT);
    expect(mayVouch(P, new Set([tenoke.title]))(r.find(v => v.title === tenoke.title)!)).toBe(false);
    expect(ctx.cracked?.by).toBe("TENOKE");
    const blocked = autoContext(r, PS_FACTS, PS_AT, () => true, mayVouch(P, new Set([tenoke.title])));
    expect(automaticRefusals(r.find(v => v.title === other.title)!, blocked)).toEqual([`${WAITS_STEAM}: TENOKE's release is one this search refuses (blocklisted, or the profile rules it out)`]);
  });
  test("a post that failed on its source (blocked by its guid only), one tried already, a dead torrent: the release still exists, and says it", () => {
    expect(take(PS, 2026, PS_FACTS, [tenoke, other], PS_AT, { blocked: new Set([tenoke.guid]) })).toEqual([other.title]);
    expect(take(PS, 2026, PS_FACTS, [tenoke, other], PS_AT, { tried: new Set([tenoke.guid]) })).toEqual([other.title]);
    expect(take(PS, 2026, PS_FACTS, [{ ...tenoke, seeders: 0 }, other], PS_AT)).toEqual([other.title]);
  });
});

describe("copies posted before the game came out (review: they rode in once a later post lifted the wait)", () => {
  test("Probably Stolen's live rows beside a -RUNE usenet post 8 days before the store date, or from June, or undated: that post waits", () => {
    for (const date of ["2026-10-20T10:00:00Z", "2026-06-01T10:00:00Z", ""]) {
      const early = nzb("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-RUNE", { size: 2.7e9, publishDate: date });
      const r = ranked(PS, 2026, [...psRows(), early]);
      const order = titles(orderCandidates(r, P, { preferUsenet: true, game: PS_FACTS, now: PS_AT }));
      expect([date, order.length, order.includes(early.title)]).toEqual([date, 7, false]);
      expect(automaticRefusals(r.find(v => v.title === early.title)!, autoContext(r, PS_FACTS, PS_AT))).toContain(`${date ? "posted before the game came out" : "no post date"}: only copies posted since say it is cracked (CrackWatch says not cracked)`);
    }
  });
  test("'not out yet': a copy before the store's date is a fake; past it, a group's release on GazelleGames posted since says it is out and cracked — the fake still waits", () => {
    const shrek = facts("2026-11-10", "unreleased", "Steam");
    const fake = nzb("DreamWorks.Shrek.2.Remastered-RUNE", { size: 9e9, publishDate: "2026-11-05T00:00:00Z" });
    const a = ctxOf("DreamWorks Shrek 2 Remastered", 2026, shrek, [fake], "2026-11-09T00:00:00Z");
    expect(take("DreamWorks Shrek 2 Remastered", 2026, shrek, [fake], "2026-11-09T00:00:00Z")).toEqual([]);
    expect(automaticRefusals(a.r[0], a.ctx)).toEqual(["CrackWatch says the game is not out yet: a copy now would be a fake"]);
    // the store's date has passed and CrackWatch still says "not out": the early post alone says nothing
    const b = ctxOf("DreamWorks Shrek 2 Remastered", 2026, shrek, [fake], "2026-11-12T00:00:00Z");
    expect(automaticRefusals(b.r[0], b.ctx)).toEqual(["CrackWatch has no verdict on the release yet (it still lists the game as not out): RUNE's release is not on GazelleGames, whose staff check it"]);
    const real = row("DreamWorks.Shrek.2.Remastered-TENOKE (2026) [Windows / Multi-Language / Full ISO]", { size: 9.2e9, publishDate: "2026-11-10T18:00:00Z" });
    const c = ctxOf("DreamWorks Shrek 2 Remastered", 2026, shrek, [fake, real], "2026-11-12T00:00:00Z");
    expect(c.ctx.cracked?.why).toBe("CrackWatch still lists the game as not out, but TENOKE released it: Steam's own DRM only");
    const taken = take("DreamWorks Shrek 2 Remastered", 2026, shrek, [fake, real], "2026-11-12T00:00:00Z");
    expect(taken).toEqual([real.title]);
    expect(taken).not.toContain(fake.title);
    expect(automaticRefusals(c.r.find(v => v.title === fake.title)!, c.ctx)).toEqual(["posted before the game came out: only copies posted since say it is cracked (CrackWatch still lists the game as not out)"]);
  });
});

describe("release day (review: 00:00 UTC of the store date is hours before Steam unlocks the game)", () => {
  const shrek = facts("2026-11-10", "unreleased", "Steam");
  test("a usenet -RUNE at 01:30, a public tracker's repack at 00:05: nothing; GazelleGames' TENOKE that evening: taken", () => {
    expect(take("DreamWorks Shrek 2 Remastered", 2026, shrek, [nzb("DreamWorks.Shrek.2.Remastered-RUNE", { size: 9e9, publishDate: "2026-11-10T01:30:00Z" })], "2026-11-10T03:00:00Z")).toEqual([]);
    expect(take("DreamWorks Shrek 2 Remastered", 2026, shrek, [row("DreamWorks Shrek 2 Remastered [FitGirl Repack]", { indexer: "1337x", indexerId: 30, size: 6e9, seeders: 50, publishDate: "2026-11-10T00:05:00Z" })], "2026-11-10T01:00:00Z")).toEqual([]);
    const real = row("DreamWorks.Shrek.2.Remastered-TENOKE (2026) [Windows / Multi-Language / Full ISO]", { size: 9.2e9, publishDate: "2026-11-10T19:00:00Z" });
    expect(take("DreamWorks Shrek 2 Remastered", 2026, shrek, [real], "2026-11-10T21:00:00Z")).toEqual([real.title]);
  });
});

describe("an old namesake's release posted again after the new game's date (review: the wrong game, which installs)", () => {
  test("Alone in the Dark (2024) beside 2008's -RELOADED: on usenet, on two trackers, on GazelleGames with its own year: nothing", () => {
    const aitd = facts("2024-03-20", "uncracked", "Steam");
    const at = "2024-05-10T00:00:00Z";
    expect(take("Alone in the Dark", 2024, aitd, [nzb("Alone.in.the.Dark-RELOADED", { size: 7.6e9, publishDate: "2024-05-02T00:00:00Z" })], at)).toEqual([]);
    const two = [row("Alone.in.the.Dark-RELOADED", { indexer: "FileList.io", indexerId: 5, size: 7.6e9, publishDate: "2024-05-02T00:00:00Z" }),
      row("Alone in the Dark-RELOADED", { indexer: "IPTorrents", indexerId: 6, size: 7.6e9, publishDate: "2024-05-03T00:00:00Z" })];
    expect(take("Alone in the Dark", 2024, aitd, two, at)).toEqual([]);
    const { r, ctx } = ctxOf("Alone in the Dark", 2024, aitd, two, at);
    expect(automaticRefusals(r[0], ctx)).toEqual([`${WAITS_STEAM}: RELOADED's release is not on GazelleGames, whose staff check it`]);
    expect(take("Alone in the Dark", 2024, aitd, [...two, row("Alone.in.the.Dark-RELOADED (2008) [Windows / Multi-Language / Full ISO]", { size: 7.6e9, publishDate: "2024-05-02T00:00:00Z" })], at)).toEqual([]);
    expect(take("Dead Space", 2023, facts("2023-01-27", "uncracked", "Steam"), [nzb("Dead.Space-RELOADED", { size: 7e9, publishDate: "2023-02-10T00:00:00Z" })], "2023-03-01T00:00:00Z")).toEqual([]);
  });
});

describe("a group's release posted just before the store date (review: Stupid Never Dies, RUNE 25 h before it)", () => {
  // the live corpus row: fetch 14, GazelleGames, 22.65 GB; the store date 2026-10-21; CrackWatch: cracked by RUNE on 2026-10-19
  const rune = row("Stupid.Never.Dies-RUNE (2026) [Windows / Multi-Language / Full ISO]", { size: 22_648_926_687, seeders: 43, publishDate: "2026-10-19T22:54:34Z" });
  test("before the store date nothing; from the store day (the tracker's request at 00:16) and after, RUNE's post is taken", () => {
    for (const st of ["unreleased", "uncracked"]) {
      const f = facts("2026-10-21", st, "Steam");
      expect([st, take("Stupid Never Dies", 2026, f, [rune], "2026-10-20T04:57:26Z")]).toEqual([st, []]);
      expect([st, take("Stupid Never Dies", 2026, f, [rune], "2026-10-21T00:16:53Z")]).toEqual([st, [rune.title]]);
      expect([st, take("Stupid Never Dies", 2026, f, [rune], "2026-10-22T12:00:00Z")]).toEqual([st, [rune.title]]);
    }
  });
  test("three days early, or not on GazelleGames: it does not count, and the message names it", () => {
    const f = facts("2026-10-21", "uncracked", "Steam");
    const early = { ...rune, publishDate: "2026-10-18T00:00:00Z" };
    const e = ctxOf("Stupid Never Dies", 2026, f, [early], "2026-10-22T12:00:00Z");
    expect(automaticRefusals(e.r[0], e.ctx)).toEqual([`${WAITS_STEAM}: RUNE's release was posted before the game came out`]);
    const fl = row("Stupid.Never.Dies-RUNE", { indexer: "FileList.io", indexerId: 5, size: 22.6e9, publishDate: "2026-10-20T16:30:00Z" });
    const n = ctxOf("Stupid Never Dies", 2026, f, [fl], "2026-10-22T12:00:00Z");
    expect(automaticRefusals(n.r[0], n.ctx)).toEqual([`${WAITS_STEAM}: RUNE's release is not on GazelleGames, whose staff check it`]);
  });
});

describe("what says a game is cracked (review: a Home Rip, a game with no DRM, the crackers that sign their releases)", () => {
  // Batomon Showdown's only copy (live game 24), as if CrackWatch tracked it uncracked
  const bat = row("Batomon Showdown (2026) [Windows / Multi-Language / Home Rip]", { size: 202_584_349, seeders: 14, publishDate: "2026-09-21T16:13:05Z" });
  const AT = "2026-11-03T05:41:00Z";
  test("GazelleGames' Home Rip of a Steam-only game; with no DRM, any copy there", () => {
    expect(take("Batomon Showdown", 2026, facts("2026-09-15", "uncracked", "Steam"), [bat], AT)).toEqual([bat.title]);
    expect(ctxOf("Batomon Showdown", 2026, facts("2026-09-15", "uncracked", "Steam"), [bat], AT).ctx.cracked?.why).toBe("CrackWatch says not cracked, but GazelleGames has a Home Rip of it: Steam's own DRM only");
    expect(take("Batomon Showdown", 2026, facts("2026-09-15", "uncracked", "None"), [bat], AT)).toEqual([bat.title]);
    const internal = row("Batomon.Showdown.v1.2-GGn (2026) [Windows / Multi-Language / GGn Internal]", { size: 210e6, publishDate: "2026-09-22T00:00:00Z" });
    expect(take("Batomon Showdown", 2026, facts("2026-09-15", "uncracked", "None"), [internal], AT)).toEqual([internal.title]);
    expect(take("Batomon Showdown", 2026, facts("2026-09-15", "uncracked", "Steam"), [internal], AT)).toEqual([]);
  });
  test("a group that signs its release counts on GazelleGames; P2P, GOG, Goldberg and a group no one knows do not", () => {
    const one = (t: string) => take(PS, 2026, PS_FACTS, [row(t, { size: 2.65e9, publishDate: "2026-10-28T20:00:00Z" }), PLAIN()], PS_AT).length;
    for (const g of ["TENOKE", "DARKSiDERS", "FCKDRM", "voices38", "CHRONOS", "VREX", "ALI213", "3DM", "CONSPIR4CY", "RAZOR1911"]) expect([g, one(`Probably.Stolen.Cyberpunk.Shopkeeper.Sim-${g} (2026) [Windows / Multi-Language / Full ISO]`)]).toEqual([g, 2]);
    for (const t of ["Probably Stolen - Cyberpunk Shopkeeper Sim-ElAmigos (2026) [Windows / Multi-Language / P2P Full Repack]", "Probably Stolen - Cyberpunk Shopkeeper Sim [DODI Repack] (2026) [Windows / Multi-Language / P2P Full Repack]"]) expect([t, one(t)]).toEqual([t, 2]);
    for (const g of ["P2P", "GOG", "Goldberg", "SUXXORS", "Tenoke"]) expect([g, one(`Probably.Stolen.Cyberpunk.Shopkeeper.Sim-${g} (2026) [Windows / Multi-Language / Full ISO]`)]).toEqual([g, 0]);
    expect(one("Probably Stolen: Cyberpunk Shopkeeper Sim (2026) [Windows / Multi-Language / P2P Full Repack]")).toBe(0);
  });
  test("the group named another way ('[TENOKE]', '- TENOKE'), and a group whose name is a word of the game's but not its last", () => {
    const one = (t: string) => take(PS, 2026, PS_FACTS, [row(t, { size: 2.65e9, publishDate: "2026-10-28T20:00:00Z" }), PLAIN()], PS_AT).length;
    expect(one("Probably Stolen Cyberpunk Shopkeeper Sim [TENOKE] (2026) [Windows / Multi-Language / Full ISO]")).toBe(2);
    expect(one("Probably Stolen Cyberpunk Shopkeeper Sim - TENOKE (2026) [Windows / Multi-Language / Full ISO]")).toBe(2);
    const rf = ctxOf("Rune Factory: Guardians of Azuma", 2025, facts("2025-06-05", "uncracked", "Steam"), [row("Rune.Factory.Guardians.of.Azuma-RUNE (2025) [Windows / Multi-Language / Full ISO]", { size: 12e9, publishDate: "2025-06-05T20:00:00Z" })], "2025-06-10T00:00:00Z");
    expect(rf.ctx.cracked?.by).toBe("RUNE");
    const an = ctxOf("Anomaly Collapse", 2025, facts("2025-08-01", "uncracked", "Steam"), [row("Anomaly.Collapse-ANOMALY (2025) [Windows / Multi-Language / Full ISO]", { size: 1.2e9, publishDate: "2025-08-01T20:00:00Z" })], "2025-08-10T00:00:00Z");
    expect(an.ctx.cracked?.by).toBe("ANOMALY");
    // the word the game's name ends with is the name's own ("Project-RUNE"), and a word inside it is never a repacker or a group
    expect(ctxOf("Project Rune", 2026, facts("2026-10-28", "uncracked", "Steam"), [row("PROJECT-RUNE (2026) [Windows / Multi-Language / Full ISO]", { publishDate: "2026-10-29T00:00:00Z" })], PS_AT).ctx.cracked).toBeNull();
    const vtm = "Vampire: The Masquerade - Bloodlines 2";
    const homeRip = row("Vampire: The Masquerade - Bloodlines 2 (2025) [Windows / Multi-Language / Home Rip]", { size: 40e9, publishDate: "2025-10-25T00:00:00Z" });
    const v = ctxOf(vtm, 2025, facts("2025-10-21", "uncracked", "Steam"), [homeRip], "2025-11-09T00:00:00Z");
    expect(v.r[0].parsed.group).toBe("Masquerade");
    expect(v.ctx.cracked?.by).toBe("a Home Rip");
    const codex = ctxOf("Codex Mortis", 2026, facts("2026-10-28", "uncracked", "Steam"), [row("Codex Mortis (2026) [Windows / Multi-Language / Home Rip]", { size: 2e9, publishDate: "2026-11-01T00:00:00Z" })], PS_AT);
    expect(codex.ctx.cracked?.by).toBe("a Home Rip");
  });
});

describe("what still waits for CrackWatch", () => {
  test("a protection that holds, Steam named beside it or not: the adversarial set's RUNE-named fakes of Denuvo and online-only games", () => {
    const wukong = ranked("Black Myth: Wukong", 2024, [row("Black.Myth.Wukong-RUNE (2024) [Windows / Multi-Language / Full ISO]", { size: 130e9, publishDate: "2024-08-22T00:00:00Z" })]);
    const at = Date.parse("2024-09-09T00:00:00Z");
    for (const drm of ["Denuvo", "Denuvo + Steam", "Steam + EA app", "Ubisoft Connect", "Arxan + Steam", "Always-online", "Microsoft Store"]) {
      expect([drm, titles(orderCandidates(wukong, P, { preferUsenet: true, game: facts("2024-08-20", "uncracked", drm), now: at }))]).toEqual([drm, []]);
    }
    expect(automaticRefusals(wukong[0], autoContext(wukong, facts("2024-08-20", "uncracked", "Denuvo"), at))).toEqual(["CrackWatch says the game is not cracked yet (Denuvo): a copy now would be a fake"]);
    const bo7 = ranked("Call of Duty®: Black Ops 7", 2025, [row("Call.of.Duty.Black.Ops.7-RUNE", { size: 60e9, publishDate: "2025-11-15T00:00:00Z" })]);
    expect(automaticRefusals(bo7[0], autoContext(bo7, facts("2025-11-14", "uncracked", "Ricochet + Battle.net"), at))).toEqual(["CrackWatch says the game is not cracked yet (Ricochet + Battle.net): a copy now would be a fake"]);
  });
  test("a DRM the rule does not know, or none named: it waits as before", () => {
    const r = ranked(PS, 2026, psRows());
    for (const drm of [null, "Theia + PSN", "Ricochet", "Steam + Online"]) {
      expect([drm, orderCandidates(r, P, { preferUsenet: true, game: { ...PS_FACTS, drm }, now: PS_AT })]).toEqual([drm, []]);
      expect(automaticRefusals(r.find(v => v.title === HOME_RIP)!, autoContext(r, { ...PS_FACTS, drm }, PS_AT))).toEqual([`CrackWatch says the game is not cracked yet${drm ? ` (${drm})` : ""}: a copy now would be a fake`]);
    }
  });
  test("no DRM at all counts as Steam's own does", () => {
    const r = ranked(PS, 2026, psRows());
    expect(autoContext(r, { ...PS_FACTS, drm: "DRM-Free" }, PS_AT).cracked?.why).toBe("CrackWatch says not cracked, but TENOKE released it: the game has no DRM");
    expect(orderCandidates(r, P, { preferUsenet: true, game: { ...PS_FACTS, drm: "None" }, now: PS_AT })).toHaveLength(7);
  });
  test("the store's own date is the one read: with none, IGDB's first date (any platform's: a console launch) does not overrule 'not out yet'", () => {
    const f: GameFacts = { release_iso: null, release_year: 2026, first_release_date: Date.parse("2025-06-26T00:00:00Z") / 1000, crack_status: "unreleased", drm: "Steam" };
    const rows = [row("Stellar.Port.Odyssey-RUNE (2026) [Windows / Multi-Language / Full ISO]", { size: 8e9, publishDate: "2026-11-01T00:00:00Z" })];
    expect(take("Stellar Port Odyssey", 2026, f, rows, PS_AT)).toEqual([]);
    const { r, ctx } = ctxOf("Stellar Port Odyssey", 2026, f, rows, PS_AT);
    expect(ctx.cracked).toBeNull();
    expect(automaticRefusals(r[0], ctx)).toEqual(["CrackWatch says the game is not out yet: a copy now would be a fake"]);
    // with its store date past, the same post says it is out
    expect(take("Stellar Port Odyssey", 2026, { ...f, release_iso: "2026-10-30" }, rows, PS_AT)).toEqual([rows[0].title]);
  });
  test("a DRM-free copy on a curated tracker is still taken by itself; CrackWatch's 'cracked' needs nothing", () => {
    const ggn = row("Probably Stolen: Cyberpunk Shopkeeper Sim (2026) [GOG Edition 2026] [Windows / Multi-Language / DRM Free]", { size: 400e6, publishDate: "2026-11-01T00:00:00Z" });
    expect(take(PS, 2026, PS_FACTS, [ggn, PLAIN()], PS_AT)).toEqual([ggn.title]);
    const cracked = autoContext(ranked(PS, 2026, psRows()), { ...PS_FACTS, crack_status: "cracked" }, PS_AT);
    expect([cracked.crack, cracked.cracked]).toEqual([null, null]);
  });
  test("the setting's help says what the rule does", () => {
    const doc = CONFIG_KEYS.find(k => k.key === "CRACKWATCH_SYNC_HOURS")!.doc;
    expect(doc).toContain("unless its only DRM is Steam's own (or none)");
    expect(doc).toContain("GazelleGames has a cracking group's or a repacker's release of it (or a Home Rip) with its year, posted since it came out");
  });
});

describe("the searcher: Probably Stolen is grabbed, and the admin reads why", () => {
  let game: GameRow;
  let searchResults: ReleaseView[] = [];
  const grabs: string[] = [];
  const logs: string[] = [];
  const saved = { ...rdeps };
  const savedRss = { ...rssdeps };
  let onGrab: ((n: number) => void) | null = null;
  afterAll(() => { Object.assign(rdeps, saved); Object.assign(rssdeps, savedRss); });
  const req = (id: number) => stmts.requestById.get(id) as RequestRow;
  const history = () => (db.query("SELECT message FROM history WHERE game_id=? AND event='grabbed' ORDER BY id").all(game.id) as { message: string }[]).map(h => h.message);
  beforeEach(() => {
    db.exec("DELETE FROM requests; DELETE FROM jobs; DELETE FROM packages; DELETE FROM fetches; DELETE FROM history; DELETE FROM blocklist; DELETE FROM games;");
    game = stmts.upsertGame({
      igdb_id: null, steam_appid: 4348910, name: PS, slug: "probably-stolen", summary: null, storyline: null, release_year: 2026, first_release_date: null,
      rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: "[\"win\"]",
      game_modes_json: "[]", developer: null, publisher: null,
    });
    db.query("UPDATE games SET release_iso='2026-10-28', crack_status='uncracked', drm='Steam' WHERE id=?").run(game.id);
    grabs.length = 0; logs.length = 0; onGrab = null;
    rdeps.log = (...x) => logs.push(x.join(" "));
    rdeps.now = () => PS_AT;
    rdeps.usenetAvailable = async () => true;
    rdeps.agentReady = () => false;
    rdeps.crackCheck = async () => null;
    rdeps.search = async () => ({ query: {} as any, searched: [], raw: searchResults.length, ranked: searchResults, errors: [] });
    rdeps.grab = async (rel, gameId) => {
      grabs.push(rel.title);
      onGrab?.(grabs.length);
      const f = stmts.insertFetch({ game_id: gameId, guid: rel.guid, indexer_id: rel.indexerId, indexer: rel.indexer, title: rel.title, protocol: rel.protocol, size: rel.size, info_hash: null, client: "rtorrent", client_id: "x", state: "submitted", release_json: JSON.stringify(rel) });
      return { fetch: { id: f.id } as any, duplicate: false };
    };
  });

  test("the Home Rip is grabbed; the log, the candidates and the grab's history line say CrackWatch was overruled and why", async () => {
    searchResults = ranked(PS, 2026, psRows());
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    const r = req(request.id);
    expect(grabs).toEqual([HOME_RIP]);
    expect(r.state).toBe("fetching"); expect(r.refused_json).toBeNull();
    const cands = JSON.parse(r.candidates_json!) as (ReleaseView & { cracked?: string })[];
    expect(cands).toHaveLength(7);                                                                // 4 releases, then the TENOKE reposts
    expect(cands.every(c => c.cracked === WHY_PS)).toBe(true);
    expect(logs.join("\n")).toContain(`first: ${HOME_RIP} — ${WHY_PS} (${TENOKE_GGN})`);
    expect(history()).toEqual([`torrent · clean · ${WHY_PS}`]);
  });

  test("no copy that says so since the game came out: the search waits for one, and says why", async () => {
    searchResults = ranked(PS, 2026, psRows(() => "2026-10-20T10:00:00Z"));
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    const r = req(request.id);
    expect(grabs).toEqual([]);
    expect(r.stage).toBe("waiting for a crack — searching again in 6h");
    expect(r.message).toMatch(/^CrackWatch says the game is not cracked yet \(Steam\): .+ was posted before the game came out — /);
  });

  test("the game counts as cracked but the profile takes none of its copies: the stage does not say it waits for a crack", async () => {
    searchResults = ranked(PS, 2026, psRows().map(x => ({ ...x, seeders: 0 })));
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    const r = req(request.id);
    expect(grabs).toEqual([]);
    expect(r.stage).toBe("7 copies found, none taken — searching again in 6h");
    expect(r.message).toBe(`no seeders — ${TENOKE_GGN}`);
  });

  test("the copy that proved it failed its import and is blocklisted by its title: the next search takes nothing on its word", async () => {
    const tenoke = row(TENOKE_GGN, { size: 2_649_354_589, publishDate: "2026-10-28T19:12:00Z" });
    searchResults = ranked(PS, 2026, [tenoke, PLAIN()]);
    stmts.insertBlock.run(game.id, tenoke.guid, tenoke.title, "GazelleGames", "import failed: the archive asks for a password");
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(grabs).toEqual([]);
    expect(req(request.id).stage).toBe("waiting for a crack — searching again in 6h");
  });

  test("CrackWatch's DRM turns out to name a protection before the next grab: the copies taken on the old verdict are passed by", async () => {
    searchResults = ranked(PS, 2026, psRows());
    onGrab = n => { if (n === 1) { db.query("UPDATE games SET drm='Denuvo + Steam' WHERE id=?").run(game.id); throw new Error("the indexer refused the download"); } };
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(grabs).toEqual([HOME_RIP]);
    expect(logs.join("\n")).toContain("passed by: CrackWatch now says the game is not cracked (Denuvo + Steam), and its copies no longer say otherwise");
    expect(req(request.id).state).toBe("requested");
    expect(history()).toEqual([]);
  });

  test("CrackWatch says cracked before the next grab: the copy is taken for itself, and its line keeps no stale reason", async () => {
    searchResults = ranked(PS, 2026, psRows());
    onGrab = n => { if (n === 1) { db.query("UPDATE games SET crack_status='cracked' WHERE id=?").run(game.id); throw new Error("the indexer refused the download"); } };
    const { request } = createRequest({ gameId: game.id });
    await requestsTick();
    expect(grabs).toHaveLength(2);
    expect(req(request.id).state).toBe("fetching");
    expect(history()).toEqual([`torrent · iso`]);
  });

  test("RSS: the waiting search looks again the moment GazelleGames' TENOKE post shows up on a feed, and takes it", async () => {
    let now = Date.parse("2026-10-28T12:00:00Z");
    rdeps.now = () => now;
    // release day, noon: only TENOKE's post on FileList (no tracker that checks it): the search waits
    const fl = row("Probably.Stolen.Cyberpunk.Shopkeeper.Sim-TENOKE", { indexer: "FileList.io", indexerId: 5, size: 3_383_982_034, publishDate: "2026-10-28T11:31:00Z" });
    searchResults = ranked(PS, 2026, [fl]);
    const { request } = createRequest({ gameId: game.id, by: "auto" });
    await requestsTick();
    expect(grabs).toEqual([]);
    expect(req(request.id).stage).toBe("waiting for a crack — searching again in 6h");
    // 13:20: GazelleGames' post shows up on its feed
    now = Date.parse("2026-10-28T13:20:00Z");
    const ggn = row(TENOKE_GGN, { size: 2_649_354_589, publishDate: "2026-10-28T13:12:00Z" });
    const unrelated = row("Some.Other.Game-RUNE (2026) [Windows / Multi-Language / Full ISO]", { publishDate: "2026-10-28T13:00:00Z" });
    searchResults = ranked(PS, 2026, [fl, ggn]);
    rssdeps.now = () => now;
    rssdeps.log = () => {};
    rssdeps.indexers = () => [{ name: "GazelleGames", indexer: { test: async () => ({ ok: true, detail: "" }), search: async () => [], recent: async () => [unrelated as any, ggn as any], download: async () => { throw new Error("no"); } } }];
    expect(await rssSync()).toBe(1);
    expect(req(request.id)).toMatchObject({ state: "requested", next_try_at: null });
    await requestsTick();
    expect(grabs).toEqual([TENOKE_GGN]);
    // the same item again wakes nothing (each feed item is judged once)
    expect(await rssSync()).toBe(0);
  });
});
