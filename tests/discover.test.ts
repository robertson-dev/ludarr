import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, stmts, type GameRow } from "../src/db";
import { parseReleaseText, daysUntil, parseFeedHtml, feedRows, discover, enrichCatalog, follow, unfollow, followsTick, ddeps, type Feed } from "../src/discover";
import { steamReleaseIso } from "../src/steam";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "steam-search-rows.html"), "utf8");

const mkGame = (appid: number, name: string, extra: Record<string, unknown> = {}) => stmts.upsertGame({
  igdb_id: null, steam_appid: appid, name, slug: name.toLowerCase(), summary: null, storyline: null, release_year: null, first_release_date: null,
  rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: "[]",
  game_modes_json: "[]", developer: null, publisher: null, ...extra,
}) as GameRow;

const details = (appid: number, over: Record<string, unknown> = {}) => ({
  type: "game", name: `App ${appid}`, steam_appid: appid, short_description: "nice", genres: [{ id: "1", description: "Action" }],
  release_date: { coming_soon: true, date: "Oct 28, 2026" }, metacritic: { score: 80 }, header_image: "h.jpg", ...over,
}) as any;

let now = Date.parse("2026-10-14T12:00:00Z");
let feeds: Partial<Record<Feed, string>> = {};
let detailCalls: number[] = [];
let detailMap: Record<number, any> = {};
let created: { gameId?: number; appId?: number; by?: string }[] = [];

beforeEach(() => {
  db.exec("DELETE FROM follows; DELETE FROM catalog; DELETE FROM requests; DELETE FROM games; DELETE FROM kv WHERE key LIKE 'discover.%';");
  now = Date.parse("2026-10-14T12:00:00Z"); feeds = {}; detailCalls = []; detailMap = {}; created = [];
  ddeps.now = () => now;
  ddeps.log = () => {};
  ddeps.fetchFeed = async f => { if (feeds[f] == null) throw new Error("feed down"); return feeds[f]!; };
  ddeps.details = async id => { detailCalls.push(id); return detailMap[id] ?? null; };
  ddeps.createRequest = opt => { created.push(opt); return { request: { id: 100 + created.length, state: "requested" } as any, duplicate: false }; };
  ddeps.onboard = async ids => ({ saved: ids.map(id => mkGame(id, "Onboarded " + id)), missing: [] });
  ddeps.art = async ids => new Map(ids.map(id => [id, { portrait: id % 2 ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/ab/library_capsule_2x.jpg` : null, hero: "h", cardWide: "c" }]));
});

describe("release dates", () => {
  test("exact, monthly, quarterly, seasonal, yearly, unknown", () => {
    expect(parseReleaseText("Oct 15, 2026")).toEqual({ text: "Oct 15, 2026", iso: "2026-10-15", sort: "2026-10-15", precision: "day" });
    expect(parseReleaseText("15 Oct, 2026").iso).toBe("2026-10-15");
    expect(parseReleaseText("1st Nov, 2026").iso).toBe("2026-11-01");
    expect(parseReleaseText("November 2026")).toMatchObject({ iso: null, sort: "2026-11-30", precision: "month" });
    expect(parseReleaseText("Q1 2027")).toMatchObject({ sort: "2027-03-31", precision: "quarter" });
    expect(parseReleaseText("Early 2027")).toMatchObject({ sort: "2027-04-30", precision: "quarter" });
    expect(parseReleaseText("2027")).toMatchObject({ sort: "2027-12-31", precision: "year" });
    expect(parseReleaseText("Coming soon")).toMatchObject({ iso: null, sort: null, precision: "tba" });
    expect(parseReleaseText("")).toMatchObject({ precision: "tba" });
    expect(daysUntil("2026-10-28", now)).toBe(14);
    expect(daysUntil(null, now)).toBeNull();
    expect(steamReleaseIso("Oct 28, 2026")).toBe("2026-10-28");
    expect(steamReleaseIso("Q4 2026")).toBeNull();
  });
});

describe("feed parsing", () => {
  test("rows from the store's html: id, title, date, reviews, capsule, tags", () => {
    const rows = parseFeedHtml(fixture);
    expect(rows.length).toBe(3);
    const cs = rows.find(r => r.appId === 730)!;
    expect(cs.name).toBe("Counter-Strike 2");
    expect(cs.capsule).toMatch(/capsule_231x87\.jpg/);
    expect(cs.tagIds.length).toBeGreaterThan(3);
    const reviewed = rows.filter(r => r.reviewSummary);
    expect(reviewed.length).toBe(2);
    expect(reviewed[0].reviewPct).toBeGreaterThan(0);
    expect(reviewed[0].reviewCount).toBeGreaterThan(0);
    expect(rows.every(r => typeof r.releaseText === "string")).toBe(true);
  });
  test("feeds are cached, served stale when Steam is down, and refreshed when old", async () => {
    feeds.popularnew = fixture;
    const a = await feedRows("popularnew", 50);
    expect(a.rows.length).toBe(3); expect(a.stale).toBe(false);
    feeds.popularnew = undefined;
    const b = await feedRows("popularnew", 50);
    expect(b.rows.length).toBe(3); expect(b.stale).toBe(false);          // within TTL: cache, not even a fetch
    now += 2 * 3600_000;
    const c = await feedRows("popularnew", 50);
    expect(c.rows.length).toBe(3); expect(c.stale).toBe(true);           // fetch failed → stale copy
    expect((await feedRows("topsellers", 50)).rows).toEqual([]);
  });
});

describe("discover + catalog", () => {
  test("sections merge feed rows with catalog details, library and tracking state", async () => {
    feeds.popularcomingsoon = fixture; feeds.popularnew = fixture; feeds.topsellers = fixture;
    detailMap[730] = details(730, { name: "Counter-Strike 2", release_date: { coming_soon: false, date: "Sep 27, 2023" } });
    const n = await enrichCatalog([730, 999], 5, 0);
    expect(n).toBe(2); expect(detailCalls).toEqual([730, 999]);
    expect(await enrichCatalog([730], 5, 0)).toBe(0);                     // fresh: no second call
    const g = mkGame(730, "Counter-Strike 2");
    await follow({ gameId: g.id });
    const { sections } = await discover();
    expect(sections.map(s => s.key)).toEqual(["coming_soon", "new", "top"]);
    const cs = sections[2].items.find(i => i.appId === 730)!;
    expect(cs).toMatchObject({ name: "Counter-Strike 2", inLibrary: true, gameId: g.id, followed: true, comingSoon: false, metacritic: 80, genres: ["Action"], releaseIso: "2023-09-27" });
    expect(cs.img).toBe("h.jpg");                                          // catalog header wins
    expect(sections[2].items.find(i => i.appId !== 730)!.img).toMatch(/capsule_231x87/);   // feed capsule until enriched
    const other = sections[2].items.find(i => i.appId !== 730)!;
    expect(other).toMatchObject({ inLibrary: false, followed: false, metacritic: null });
    expect(sections[1].items.some(i => i.appId === 730)).toBe(false);          // a 2023 release is not "new & trending"
    expect(sections[0].items.some(i => i.appId === 730)).toBe(false);          // nor "coming soon"
  });
});

describe("tracking", () => {
  test("follow by appId onboards the game, reads the date, dedupes; unfollow removes", async () => {
    detailMap[4115450] = details(4115450, { name: "Phantom Blade Zero" });
    const r = await follow({ appId: 4115450 });
    expect(r.duplicate).toBe(false);
    expect(r.follow).toMatchObject({ releaseIso: "2026-10-28", releaseText: "Oct 28, 2026", comingSoon: true, daysUntil: 14, requestedAt: null });
    expect(r.game.name).toBe("Onboarded 4115450");
    expect((await follow({ appId: 4115450 })).duplicate).toBe(true);
    expect((stmts.followsAll.all() as any[]).length).toBe(1);
    unfollow(r.game.id);
    expect((stmts.followsAll.all() as any[]).length).toBe(0);
    expect(() => unfollow(r.game.id)).toThrow(/not tracking/);
  });
  test("the tick requests a tracked game on release day, re-reads moved dates, leaves the future alone", async () => {
    detailMap[1] = details(1, { release_date: { coming_soon: true, date: "Oct 14, 2026" } });    // today
    detailMap[2] = details(2, { release_date: { coming_soon: true, date: "Dec 1, 2026" } });     // later
    detailMap[3] = details(3, { release_date: { coming_soon: false, date: "Oct 1, 2026" } });    // already out (flag flipped)
    const a = await follow({ appId: 1 }), b = await follow({ appId: 2 }), c = await follow({ appId: 3 });
    const r1 = await followsTick();
    expect(r1.requested).toBe(2);
    expect(created.map(x => x.gameId).sort()).toEqual([a.game.id, c.game.id].sort());
    expect(created[0].by).toBe("tracker");
    const pending = stmts.followsPending.all() as any[];
    expect(pending.map(p => p.game_id)).toEqual([b.game.id]);
    // game 2 is seven weeks out → re-read only every 12h; 13h later the publisher moved it up to today → the next tick picks it up
    now += 13 * 3600_000;
    detailMap[2] = details(2, { release_date: { coming_soon: true, date: "Oct 15, 2026" } });
    const r2 = await followsTick();
    expect(r2.requested).toBe(1);
    expect((stmts.followsAll.all() as any[]).find(f => f.game_id === b.game.id).release_iso).toBe("2026-10-15");
    expect(await followsTick()).toEqual({ requested: 0 });
  });
  test("a game releasing within two days is re-read every 30 minutes", async () => {
    detailMap[5] = details(5, { release_date: { coming_soon: true, date: "Oct 15, 2026" } });
    await follow({ appId: 5 });
    detailCalls = [];
    await followsTick();                                   // just checked at follow time → no call
    expect(detailCalls).toEqual([]);
    now += 31 * 60_000;
    await followsTick();
    expect(detailCalls).toEqual([5]);                       // imminent → re-read after 30 min
  });
});
