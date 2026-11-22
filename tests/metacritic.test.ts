import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, kv, stmts, type GameRow } from "../src/db";
import { bestOf, browseUrl, isList, listRows, lists, mdeps, metacriticTick, parseBrowseHtml, pickSteamHit, resolveRows, resolvedApp, type McRow } from "../src/metacritic";
import { catalogUpsertFromDetails, ddeps, parseSimilarHtml, similarTo } from "../src/discover";
import type { SteamSearchHit } from "../src/steam";

const metaHtml = readFileSync(join(import.meta.dir, "fixtures", "metacritic-browse-metascore.html"), "utf8");
const userHtml = readFileSync(join(import.meta.dir, "fixtures", "metacritic-browse-userscore.html"), "utf8");

const hit = (appId: number, name: string, metascore: string | null = null): SteamSearchHit => ({ appId, name, tinyImage: "", metascore, priceUsd: null });
const row = (title: string, metascore: number | null = 90, slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")): McRow =>
  ({ rank: 1, title, slug, releaseText: "Jan 1, 2020", metascore, userscore: null, summary: null, image: null });
const details = (appid: number, over: Record<string, unknown> = {}) => ({
  type: "game", name: `App ${appid}`, steam_appid: appid, short_description: "nice", genres: [{ id: "1", description: "RPG" }],
  release_date: { coming_soon: false, date: "Mar 30, 2021" }, metacritic: { score: 80 }, header_image: `h${appid}.jpg`, ...over,
}) as any;
const mkGame = (appid: number, name: string) => stmts.upsertGame({
  igdb_id: null, steam_appid: appid, name, slug: name.toLowerCase(), summary: null, storyline: null, release_year: null, first_release_date: null,
  rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: "[]",
  game_modes_json: "[]", developer: null, publisher: null,
}) as GameRow;

let now = Date.parse("2026-11-04T12:00:00Z");
let pages: Record<string, string | null> = {};
let fetched: string[] = [];
let searches: string[] = [];
let answers: Record<string, SteamSearchHit[]> = {};

beforeEach(() => {
  db.exec("DELETE FROM kv WHERE key LIKE 'metacritic.%' OR key LIKE 'discover.%'; DELETE FROM catalog; DELETE FROM games; DELETE FROM follows; DELETE FROM requests;");
  now = Date.parse("2026-11-04T12:00:00Z"); pages = {}; fetched = []; searches = []; answers = {};
  mdeps.now = () => now; mdeps.log = () => {}; mdeps.resolveDelayMs = 0;
  mdeps.fetchPage = async url => { fetched.push(url); const p = pages[url]; if (p == null) throw new Error("down"); return p; };
  mdeps.search = async term => { searches.push(term); return answers[term] ?? []; };
  ddeps.now = () => now; ddeps.log = () => {};
  ddeps.details = async () => null;
  ddeps.art = async ids => new Map(ids.map(id => [id, { portrait: `p${id}`, hero: "h", cardWide: "c" }]));
});

describe("browse pages", () => {
  test("cards: rank, title, slug, date, Metascore, blurb, box art", () => {
    const rows = parseBrowseHtml(metaHtml);
    expect(rows.map(r => r.title)).toEqual(["Disco Elysium: The Final Cut", "Half-Life 2", "Grand Theft Auto V"]);
    expect(rows[0]).toMatchObject({ rank: 1, slug: "disco-elysium-the-final-cut", releaseText: "Mar 30, 2021", metascore: 97, userscore: null });
    expect(rows[0].summary).toStartWith("Disco Elysium - The Final Cut is the definitive edition");
    expect(rows[0].image).toStartWith("https://www.metacritic.com/a/img/");
    expect(rows[2]).toMatchObject({ rank: 3, metascore: 96, releaseText: "Apr 13, 2015" });
  });
  test("the user-score pages carry the user score and no Metascore", () => {
    const rows = parseBrowseHtml(userHtml);
    expect(rows[0]).toMatchObject({ title: "Clair Obscur: Expedition 33", userscore: 9.6, metascore: null });
    expect(rows[1]).toMatchObject({ title: "Resident Evil Requiem", userscore: 9.5 });
  });
  test("urls and list keys", () => {
    expect(browseUrl("all", 2)).toBe("https://www.metacritic.com/browse/game/pc/all/all-time/metascore/?platform=pc&page=2");
    expect(browseUrl("players")).toContain("/all-time/userscore/");
    expect(browseUrl("2024")).toContain("/pc/all/2024/metascore/");
    expect(lists().slice(0, 3).map(l => l.key)).toEqual(["all", "players", "2026"]);
    expect(isList("2026")).toBe(true); expect(isList("2027")).toBe(false); expect(isList("1999")).toBe(false); expect(isList("top")).toBe(false);
  });
  test("lists are cached for a day; when the site is down the old copy is served, marked stale", async () => {
    pages[browseUrl("2024")] = metaHtml;
    const a = await listRows("2024");
    expect(a.rows.length).toBe(3); expect(a.stale).toBe(false); expect(fetched.length).toBe(1);
    await listRows("2024");
    expect(fetched.length).toBe(1);
    now += 25 * 3600_000; pages = {};
    const b = await listRows("2024");
    expect(b.stale).toBe(true); expect(b.rows.length).toBe(3); expect(b.at).toBe(a.at);
  });
  test("all time reads two pages and keeps counting", async () => {
    pages[browseUrl("all", 1)] = metaHtml; pages[browseUrl("all", 2)] = userHtml;
    const { rows } = await listRows("all");
    expect(rows.map(r => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("matching a Metacritic title to the store", () => {
  test("the same name, punctuation aside, wins; soundtracks and demos never do", () => {
    const r = row("Disco Elysium: The Final Cut", 97);
    expect(pickSteamHit(r, [hit(1233220, "Disco Elysium - The Final Cut Soundtrack", "91"), hit(632470, "Disco Elysium - The Final Cut", "97")])?.appId).toBe(632470);
    expect(pickSteamHit(r, [hit(1233220, "Disco Elysium - The Final Cut Soundtrack", "97")])).toBeNull();
  });
  test("Metacritic's year suffix is dropped before comparing", () => {
    expect(pickSteamHit(row("Cart Life (2013)", 79), [hit(2324660, "Cart Life", "")])?.appId).toBe(2324660);
  });
  test("among several exact names the one the store scores the same wins", () => {
    expect(pickSteamHit(row("Half-Life 2", 96), [hit(2477290, "Half-Life 2", ""), hit(220, "Half-Life 2", "96")])?.appId).toBe(220);
  });
  test("a longer store name is accepted only when the store confirms the very same Metascore, and only one does", () => {
    const r = row("Sid Meier's Pirates!", 88);
    expect(pickSteamHit(r, [hit(3920, "Sid Meier's Pirates! Gold Plus (Classic)", "88")])?.appId).toBe(3920);
    expect(pickSteamHit(r, [hit(3920, "Sid Meier's Pirates! Gold Plus (Classic)", "85")])).toBeNull();
    expect(pickSteamHit(r, [hit(1, "Sid Meier's Pirates! A", "88"), hit(2, "Sid Meier's Pirates! B", "88")])).toBeNull();
    expect(pickSteamHit(row("The Witcher 3: Wild Hunt - Blood and Wine", 92), [])).toBeNull();
    expect(pickSteamHit(row("Half-Life", 96), [hit(220, "Half-Life 2", "96")])).toBeNull();     // a sequel is another game
  });
  test("a newer edition of the same game counts; an expansion, upgrade or sequel does not", () => {
    expect(pickSteamHit(row("The Elder Scrolls V: Skyrim", 94), [hit(489830, "The Elder Scrolls V: Skyrim Special Edition", "0"), hit(1746860, "The Elder Scrolls V: Skyrim Anniversary Upgrade", "")])?.appId).toBe(489830);
    expect(pickSteamHit(row("Mass Effect 2", 94), [hit(1328670, "Mass Effect™ Legendary Edition", "86"), hit(24980, "Mass Effect 2 (2010) Edition", "")])?.appId).toBe(24980);
    expect(pickSteamHit(row("Grand Theft Auto V", 96), [hit(3240220, "Grand Theft Auto V Enhanced", ""), hit(12110, "Grand Theft Auto: Vice City – The Definitive Edition", "")])?.appId).toBe(3240220);
    expect(pickSteamHit(row("The Witcher 3: Wild Hunt", 93), [hit(292030, "The Witcher® 3: Wild Hunt – Complete Edition", "93"), hit(1, "The Witcher 3: Wild Hunt — Songs of the Past", "")])?.appId).toBe(292030);
    expect(pickSteamHit(row("Half-Life 2", 96), [hit(380, "Half-Life 2: Episode One", "87")])).toBeNull();
    expect(pickSteamHit(row("Planescape: Torment", 91), [hit(466300, "Planescape: Torment: Enhanced Edition", ""), hit(2, "Planescape: Torment: Enhanced Edition Official Soundtrack", "")])?.appId).toBe(466300);
  });
  test("answers are kept, misses are retried after a week, nothing is asked twice", async () => {
    answers["Half-Life 2"] = [hit(220, "Half-Life 2", "96")];
    const rows = [row("Half-Life 2", 96), row("Unknown Thing", 70)];
    expect(await resolveRows(rows)).toBe(2);
    expect(resolvedApp(rows[0].slug)).toMatchObject({ appId: 220, name: "Half-Life 2" });
    expect(resolvedApp(rows[1].slug)).toMatchObject({ appId: null });
    expect(await resolveRows(rows)).toBe(0);
    now += 8 * 86_400_000;
    expect(await resolveRows(rows)).toBe(1);
    expect(searches).toEqual(["Half-Life 2", "Unknown Thing", "Unknown Thing"]);
  });
});

describe("the best-of rows", () => {
  test("matched titles become items in Metacritic's order with its score; unmatched ones count as pending; expansions fall away", async () => {
    pages[browseUrl("all", 1)] = metaHtml;                                                 // page two is down: page one still counts
    answers["Disco Elysium: The Final Cut"] = [hit(632470, "Disco Elysium - The Final Cut", "97")];
    answers["Half-Life 2"] = [hit(220, "Half-Life 2", "96")];
    answers["Grand Theft Auto V"] = [hit(271590, "Grand Theft Auto V", "96")];
    const first = await bestOf("all");
    expect(first.total).toBe(3); expect(first.pending).toBe(3); expect(first.items).toEqual([]);
    await new Promise(r => setTimeout(r, 30));                                              // the background matching, instant in tests
    catalogUpsertFromDetails(details(632470, { name: "Disco Elysium - The Final Cut", metacritic: { score: 91 } }));
    catalogUpsertFromDetails(details(220, { type: "dlc", name: "Half-Life 2: Episode" }));
    mkGame(271590, "Grand Theft Auto V");
    const done = await bestOf("all");
    expect(done.pending).toBe(0);
    expect(done.items.map(i => [i.appId, i.rank, i.metacritic])).toEqual([[632470, 1, 97], [271590, 3, 96]]);
    expect(done.items[0]).toMatchObject({ name: "Disco Elysium - The Final Cut", releaseIso: "2021-03-30", portrait: "p632470", inLibrary: false, mcSlug: "disco-elysium-the-final-cut" });
    expect(done.items[1]).toMatchObject({ inLibrary: true, releaseText: "Apr 13, 2015", userScore: null });
    expect(done.label).toBe("All time");
  });
  test("the players' list carries user scores", async () => {
    pages[browseUrl("players")] = userHtml;
    answers["Clair Obscur: Expedition 33"] = [hit(1903340, "Clair Obscur: Expedition 33", "92")];
    await resolveRows((await listRows("players")).rows);
    const l = await bestOf("players");
    expect(l.items.map(i => [i.appId, i.userScore])).toEqual([[1903340, 9.6]]);
    expect(l.pending).toBe(0);
  });
  test("an unknown list is refused; the tick warms the lists and resolves within its budget", async () => {
    await expect(bestOf("1990" as any)).rejects.toThrow();
    pages[browseUrl("all", 1)] = metaHtml; pages[browseUrl("players")] = userHtml; pages[browseUrl("2026")] = metaHtml; pages[browseUrl("2025")] = userHtml;
    await metacriticTick();
    expect(searches.length).toBe(5);                                                        // five distinct titles across the four lists
  });
});

describe("more like this", () => {
  const similar = `<div id="similar"><a role="button" class="similar_grid_capsule" data-ds-appid="374320" data-ds-itemkey="App_374320" data-ds-tagids="[29482,122]" href="https://store.steampowered.com/app/374320/DARK_SOULS_III/?snr=1_300"> <img src="https://cdn/374320/capsule_616x353.jpg" srcset="x 2x"> </a>
<a role="button" class="similar_grid_capsule" data-ds-appid="1245620" href="https://store.steampowered.com/app/1245620/ELDEN_RING/"><img src="https://cdn/1245620/capsule.jpg"></a>
<a role="button" class="similar_grid_capsule" data-ds-appid="2000" href="https://store.steampowered.com/app/2000/Some_Game_Soundtrack/"><img src="s.jpg"></a>
<a role="button" class="similar_grid_capsule" data-ds-appid="374320" href="https://store.steampowered.com/app/374320/DARK_SOULS_III/"><img src="dup.jpg"></a></div>`;
  test("capsules give the app, a name from the link, the art and the tags", () => {
    const rows = parseSimilarHtml(similar);
    expect(rows.map(r => [r.appId, r.name])).toEqual([[374320, "DARK SOULS III"], [1245620, "ELDEN RING"], [2000, "Some Game Soundtrack"]]);
    expect(rows[0]).toMatchObject({ capsule: "https://cdn/374320/capsule_616x353.jpg", tagIds: [29482, 122] });
  });
  test("the row leaves out the game itself and junk, uses the catalog's names, and is cached a week", async () => {
    let calls = 0;
    ddeps.fetchSimilar = async () => { calls++; return similar; };
    catalogUpsertFromDetails(details(374320, { name: "DARK SOULS™ III", release_date: { coming_soon: false, date: "Apr 11, 2016" } }));
    const a = await similarTo(1245620);
    expect(a.items.map(i => [i.appId, i.name])).toEqual([[374320, "DARK SOULS™ III"]]);
    expect(a.items[0]).toMatchObject({ releaseIso: "2016-04-11", portrait: "p374320" });
    await similarTo(1245620);
    expect(calls).toBe(1);
    now += 8 * 86_400_000;
    ddeps.fetchSimilar = async () => { calls++; throw new Error("down"); };
    const c = await similarTo(1245620);
    expect(calls).toBe(2); expect(c.stale).toBe(true); expect(c.items.length).toBe(1);
  });
});
