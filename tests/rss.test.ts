import { beforeEach, describe, expect, test } from "bun:test";
import { db, kv, stmts, type GameRow } from "../src/db";
import { isFor, rssSync, rssdeps } from "../src/rss";
import type { Release } from "../src/plugins/types";

const rel = (title: string, guid = title): Release => ({ guid, title, instanceId: 1, indexerId: 5, indexer: "DrunkenSlug", size: 5e9, age: 0, publishDate: new Date().toISOString(), seeders: null, leechers: null, grabs: null, files: null, downloadUrl: "https://x/" + guid, magnetUrl: null, protocol: "usenet", categories: [4050], infoHash: null, fileName: null } as unknown as Release);
const game = (name: string, year: number | null = null) => stmts.upsertGame({ igdb_id: null, steam_appid: null, name, slug: name.toLowerCase().replace(/\W+/g, "-"), summary: null, storyline: null, release_year: year, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["win"]', game_modes_json: "[]", developer: null, publisher: null }) as GameRow;

let feed: Release[] = [];
let created: { gameId: number; by?: string }[] = [];
beforeEach(() => {
  db.exec("DELETE FROM games; DELETE FROM requests; DELETE FROM kv WHERE key LIKE 'rss.%'");
  feed = []; created = [];
  rssdeps.indexers = () => [{ name: "Prowlarr", indexer: { test: async () => ({ ok: true, detail: "" }), search: async () => [], recent: async () => feed, download: async () => { throw new Error("no"); } } }];
  rssdeps.createRequest = opt => { created.push(opt); return { request: { id: created.length } as never, duplicate: false }; };
  rssdeps.log = () => {};
  rssdeps.now = () => Date.parse("2026-10-19T12:00:00Z");
});

describe("RSS sync", () => {
  test("a feed item is the game only under the searcher's own rules: whole subtitle, no sequel, year close", () => {
    expect(isFor(rel("Castlevania.Belmonts.Curse-RUNE"), { name: "Castlevania: Belmont's Curse", year: 2026 })).toBe(true);
    expect(isFor(rel("Castlevania-RUNE"), { name: "Castlevania: Belmont's Curse", year: 2026 })).toBe(false);
    expect(isFor(rel("Hollow.Knight.Silksong-RUNE"), { name: "Hollow Knight", year: 2017 })).toBe(false);
    expect(isFor(rel("Hollow_Knight_v1.5.78-GOG"), { name: "Hollow Knight", year: 2017 })).toBe(true);
    expect(isFor(rel("Battlefield_Vietnam-Razor1911"), { name: "Hollow Knight", year: 2017 })).toBe(false);
  });
  test("a new feed item for a wanted game starts one search; items are judged once; games already searching or unmonitored are left alone", async () => {
    const hk = game("Hollow Knight", 2017), cv = game("Castlevania: Belmont's Curse", 2026), busy = game("Frosthaven", 2026), off = game("Baron", 2026);
    rssdeps.wanted = () => [
      { id: hk.id, name: hk.name, monitored: true, cutoffUnmet: false, request: null },
      { id: cv.id, name: cv.name, monitored: true, cutoffUnmet: true, request: { state: "ready" } },
      { id: busy.id, name: busy.name, monitored: true, cutoffUnmet: false, request: { state: "matching" } },
      { id: off.id, name: off.name, monitored: false, cutoffUnmet: false, request: null },
    ] as never;
    feed = [rel("Battlefield_Vietnam-Razor1911"), rel("Hollow_Knight_v1.5.78-GOG", "a"), rel("Hollow.Knight.v1.5.78.Windows-GOG", "b"), rel("Castlevania.Belmonts.Curse-RUNE"), rel("Frosthaven.v1.0-RUNE"), rel("Baron-RUNE")];
    expect(await rssSync()).toBe(2);
    expect(created).toEqual([{ gameId: hk.id, by: "rss" }, { gameId: cv.id, by: "upgrade" }]);   // one search per game however many items; a copy below cutoff = an upgrade search
    created = [];
    expect(await rssSync()).toBe(0);                                                                // nothing new in the feed
    feed.push(rel("Hollow.Knight.v1.5.80-GOG", "c"));
    expect(await rssSync()).toBe(1);
    expect(JSON.parse(kv.get("rss.seen")!)).toHaveProperty("1:c");
  });
  test("nothing wanted, or no indexer with a feed: the feeds are not even read", async () => {
    let reads = 0;
    rssdeps.indexers = () => [{ name: "P", indexer: { test: async () => ({ ok: true, detail: "" }), search: async () => [], recent: async () => { reads++; return feed; }, download: async () => { throw new Error("no"); } } }];
    rssdeps.wanted = () => [];
    expect(await rssSync()).toBe(0); expect(reads).toBe(0);
    const hk = game("Hollow Knight", 2017);
    rssdeps.wanted = () => [{ id: hk.id, name: hk.name, monitored: true, cutoffUnmet: false, request: null }] as never;
    rssdeps.indexers = () => [{ name: "plain", indexer: { test: async () => ({ ok: true, detail: "" }), search: async () => [], download: async () => { throw new Error("no"); } } }];
    expect(await rssSync()).toBe(0);
  });
});
