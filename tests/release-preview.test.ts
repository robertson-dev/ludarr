/**
 * "Test the search" for a game that is not saved yet: GET /release?term=…&platforms=… judges console dumps the way the
 * saved game's automatic search will — the platforms checked like a GameDraft's, the console pass run when nothing on
 * PC is certain, and a dump for one of those consoles taken.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/db";
import { app } from "../src/server";
import { apiKey } from "../src/config";
import { sdeps } from "../src/search";

const saved = { ...sdeps };
const clean = () => db.exec("DELETE FROM requests; DELETE FROM follows; DELETE FROM jobs; DELETE FROM packages; DELETE FROM games");
afterAll(() => { Object.assign(sdeps, saved); clean(); });
const dump = "Legend of Zelda, The - Majora's Mask (USA) N64";
beforeEach(() => {
  process.env.LUDARR_CONFIG = mkdtempSync(join(tmpdir(), "ludarr-preview-"));
  clean();
  // an indexer that files dumps under consoles: a PC search (4000) finds nothing, the console pass (every category) finds the dump
  const listing = [{ guid: dump, title: dump, instanceId: 0, indexerId: 1, indexer: "T", size: 3.2e7, age: 10, publishDate: "", seeders: 10, leechers: 0, grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent", categories: [{ id: 1000 }], indexerFlags: [], fileName: null }];
  sdeps.indexers = () => [{ id: 1, name: "T", indexer: { search: async (_t: string, opt?: { categories?: number[] }) => ((opt?.categories ?? [4000]).length === 0 ? listing : []) } as never }];
});
type Preview = { game: { platforms: string[] }; searched: string[]; items: { title: string; certain: boolean; allowed: boolean; flags: { wrongKind?: string | null } }[]; error?: string };
const get = async (q: string) => { const r = await app.request(`/api/v1/release?${q}`, { headers: { "x-api-key": apiKey() } }); return { status: r.status, body: await r.json() as Preview }; };
const term = encodeURIComponent("The Legend of Zelda: Majora's Mask");

test("a draft's platforms make the preview judge its dumps as the saved game's search will", async () => {
  const r = await get(`term=${term}&year=2000&platforms=n64`);
  expect(r.status).toBe(200);
  expect(r.body.game.platforms).toEqual(["n64"]);
  expect(r.body.searched.some(s => s.endsWith("(console)"))).toBe(true);                  // nothing on PC: the console pass followed
  expect(r.body.items.map(i => ({ t: i.title, certain: i.certain, allowed: i.allowed }))).toEqual([{ t: dump, certain: true, allowed: true }]);
  const only = await get(`term=${term}&year=2000&scope=console&platforms=Nintendo%2064`);
  expect(only.body.items.map(i => ({ t: i.title, certain: i.certain }))).toEqual([{ t: dump, certain: true }]);
  // the same as the saved game
  const add = await app.request("/api/v1/game", { method: "POST", headers: { "x-api-key": apiKey(), "content-type": "application/json" }, body: JSON.stringify({ source: "manual", monitored: false, game: { name: "The Legend of Zelda: Majora's Mask", year: 2000, platforms: ["n64"] } }) });
  const id = ((await add.json()) as { item: { id: number } }).item.id;
  const savedGame = await get(`gameId=${id}`);
  expect(savedGame.body.items.map(i => ({ t: i.title, certain: i.certain, allowed: i.allowed }))).toEqual([{ t: dump, certain: true, allowed: true }]);
});

test("platforms are checked like a GameDraft's, and without them a term-only preview stays on PC", async () => {
  const bad = await get(`term=${term}&year=2000&platforms=Atari%20Jaguar`);
  expect(bad.status).toBe(400); expect(bad.body.error).toMatch(/platforms: "Atari Jaguar" is not a platform ludarr knows/);
  const none = await get(`term=${term}&year=2000`);
  expect(none.body.items).toEqual([]);
  expect(none.body.game.platforms).toEqual([]);
});

test("a saved game's platforms give way to the ones the request lists, like its names do", async () => {
  const add = await app.request("/api/v1/game", { method: "POST", headers: { "x-api-key": apiKey(), "content-type": "application/json" }, body: JSON.stringify({ source: "manual", monitored: false, game: { name: "The Legend of Zelda: Majora's Mask", year: 2000, platforms: ["n64"] } }) });
  const id = ((await add.json()) as { item: { id: number } }).item.id;
  const r = await get(`gameId=${id}&scope=console&platforms=snes`);
  expect(r.body.game.platforms).toEqual(["snes"]);
  expect(r.body.items.map(i => ({ certain: i.certain, why: i.flags.wrongKind }))).toEqual([{ certain: false, why: "platform: Nintendo 64" }]);
});
