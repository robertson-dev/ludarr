import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, serializeGame, stmts, upsertGame, type GameRow } from "../src/db";
import { app } from "../src/server";
import { artApi } from "../src/api/art";
import { gamesApi } from "../src/api/games";
import { apiKey } from "../src/config";
import { adeps, libretroSystems, resolveGameArt, sniffImage, storeCustomArt } from "../src/art";
import { ndeps } from "../src/net/public-url";

const image = (sig: number[], size = 3000) => { const b = new Uint8Array(size).fill(7); b.set(sig); return b; };
const PNG = image([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = image([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = image([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const STEAM_POSTER = "https://cdn.cloudflare.steamstatic.com/steam/apps/1/library_600x900_2x.jpg";
const STEAM_HERO = "https://cdn.cloudflare.steamstatic.com/steam/apps/1/library_hero.jpg";

const saved = { adeps: { ...adeps }, ndeps: { ...ndeps } };
afterAll(() => {
  Object.assign(adeps, saved.adeps); Object.assign(ndeps, saved.ndeps);
  db.exec("DELETE FROM requests; DELETE FROM follows; DELETE FROM packages; DELETE FROM games; DELETE FROM kv WHERE key LIKE 'art.%'");
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ludarr-ownart-"));
  process.env.LUDARR_CONFIG = dir;
  db.exec("DELETE FROM requests; DELETE FROM follows; DELETE FROM packages; DELETE FROM games; DELETE FROM kv WHERE key LIKE 'art.%'; DELETE FROM plugin_instances WHERE kind='metadata'");
  adeps.igdb = () => null; adeps.steamSearch = async () => []; adeps.steamDetails = async () => null;
  adeps.steamArt = (async () => null) as never;
  adeps.fetch = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
  ndeps.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  ndeps.fetch = async () => new Response(PNG, { headers: { "content-type": "image/png" } });
});

const key = () => ({ "x-api-key": apiKey() });
const game = (name: string, extra: Record<string, unknown> = {}) => upsertGame({ igdb_id: null, steam_appid: null, name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`, summary: null, storyline: null, release_year: 2009, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["ps3"]', game_modes_json: "[]", developer: null, publisher: null, ...extra }) as GameRow;
const row = (id: number) => stmts.gameById.get(id) as GameRow;
const own = (id: number) => serializeGame(row(id)).customArt;
const putArt = async (id: number, kind: string, body: BodyInit, type: string) => app.request(`/api/v1/game/${id}/art/${kind}`, { method: "PUT", headers: { ...key(), "content-type": type }, body });
const putUrl = (id: number, kind: string, body: unknown) => putArt(id, kind, JSON.stringify(body), "application/json");
const del = async (id: number, kind: string) => app.request(`/api/v1/game/${id}/art/${kind}`, { method: "DELETE", headers: key() });
const files = () => (existsSync(join(dir, "art", "custom")) ? readdirSync(join(dir, "art", "custom")).sort() : []);

describe("art set by hand", () => {
  test("only the API key writes art; the public art router only ever reads", async () => {
    const g = game("Locked Door");
    expect((await app.request(`/api/v1/game/${g.id}/art/poster`, { method: "PUT", headers: { "content-type": "image/png" }, body: PNG })).status).toBe(401);
    expect((await app.request(`/api/v1/game/${g.id}/art/poster`, { method: "DELETE" })).status).toBe(401);
    expect((await app.request(`/api/v1/game/${g.id}/art/poster`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://img.example.com/p.png" }) })).status).toBe(401);
    expect(artApi.routes.length).toBeGreaterThan(0);
    expect(artApi.routes.filter(r => r.method !== "GET")).toEqual([]);
    for (const method of ["PUT", "POST", "DELETE"]) {
      const res = await app.request(`/api/v1/art/game/${g.id}/poster`, { method, headers: { "content-type": "image/png" }, body: method === "DELETE" ? undefined : PNG });
      expect({ method, status: res.status }).toEqual({ method, status: 404 });
    }
    expect(own(g.id)).toEqual([]); expect(files()).toEqual([]);
  });
  test("an uploaded poster is the game's own: served first, kept over automatic art, replaced whole, and DELETE gives automatic art back", async () => {
    const g = game("Demon's Souls", { steam_appid: 990101, cover_url: STEAM_POSTER });
    adeps.fetch = (async () => new Response(JPG, { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    let res = await putArt(g.id, "poster", PNG, "image/png");
    expect(res.status).toBe(200);
    const { item } = await res.json() as { item: any };
    expect(item.customArt).toEqual(["poster"]); expect(item.customArtAt).toBeGreaterThan(0);
    let got = await artApi.request(`/api/v1/art/game/${g.id}/poster`);
    expect(got.headers.get("x-ludarr-art")).toBe("custom"); expect(got.headers.get("content-type")).toBe("image/png"); expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    res = await putArt(g.id, "poster", JPG, "image/jpeg");
    expect(res.status).toBe(200);
    expect(files()).toEqual([`game-${g.id}-poster.jpg`]);                              // the PNG it replaced is gone
    expect((await res.json() as { item: any }).item.customArtAt).toBeGreaterThanOrEqual(item.customArtAt);
    // automatic art leaves it alone
    let asked = 0;
    adeps.steamArt = (async () => { asked++; return { portrait: "https://cdn.cloudflare.steamstatic.com/steam/apps/2/library_600x900_2x.jpg", hero: STEAM_HERO, cardWide: "x" }; }) as never;
    await resolveGameArt(row(g.id), true);
    expect(row(g.id).cover_url).toBe(STEAM_POSTER);
    res = await del(g.id, "poster");
    expect(res.status).toBe(200); expect((await res.json() as { item: any }).item.customArt).toEqual([]);
    expect(files()).toEqual([]);
    got = await artApi.request(`/api/v1/art/game/${g.id}/poster`);
    expect(got.headers.get("x-ludarr-art")).toBeNull(); expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect((await del(g.id, "poster")).status).toBe(404);                              // nothing of its own left to reset
    expect(asked).toBeGreaterThan(0);
  });
  test("only PNG, JPEG or WebP, judged by the bytes, and at most 15 MB counted while it streams in", async () => {
    const g = game("Strict");
    expect((await putArt(g.id, "poster", "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml")).status).toBe(415);
    expect((await putArt(g.id, "poster", "<html>not an image</html>", "image/png")).status).toBe(400);
    expect((await putArt(g.id, "banner", WEBP, "image/webp")).status).toBe(200);
    expect(sniffImage(PNG)).toBe("image/png"); expect(sniffImage(JPG)).toBe("image/jpeg"); expect(sniffImage(WEBP)).toBe("image/webp"); expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
    const MB = new Uint8Array(1 << 20).fill(1);
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({ pull(c) { if (pulled >= 16) { c.close(); return; } c.enqueue(pulled++ === 0 ? image([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 1 << 20) : MB); } });
    const res = await app.request(`/api/v1/game/${g.id}/art/poster`, { method: "PUT", headers: { ...key(), "content-type": "image/png" }, body: big, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(own(g.id)).toEqual(["banner"]); expect(files()).toEqual([`game-${g.id}-banner.webp`]);
    expect((await putArt(g.id, "cover", PNG, "image/png")).status).toBe(404);          // no such kind of art
    expect((await putArt(424242, "poster", PNG, "image/png")).status).toBe(404);       // no such game
    // plain bytes and the common image/jpg spelling are taken when the bytes are an image
    expect((await putArt(g.id, "logo", JPG, "image/jpg")).status).toBe(200);
    expect((await putArt(g.id, "hero", "<html></html>", "application/octet-stream")).status).toBe(400);
    expect((await putArt(g.id, "hero", PNG, "application/octet-stream")).status).toBe(200);
    expect(own(g.id)).toEqual(["banner", "hero", "logo"]); expect(files()).toEqual([`game-${g.id}-banner.webp`, `game-${g.id}-hero.png`, `game-${g.id}-logo.jpg`]);
  });
  test("a link is fetched once over https from a public address — every redirect checked — and must give an image", async () => {
    const g = game("Linked");
    const fetched: string[] = [];
    ndeps.fetch = async (u: string) => { fetched.push(u); return new Response(PNG, { headers: { "content-type": "image/png" } }); };
    let res = await putUrl(g.id, "logo", { url: "https://img.example.com/logo.png" });
    expect(res.status).toBe(200); expect(fetched).toEqual(["https://img.example.com/logo.png"]);
    expect((await artApi.request(`/api/v1/art/game/${g.id}/logo`)).headers.get("x-ludarr-art")).toBe("custom");
    const refused = async (body: unknown, status = 400) => { const r = await putUrl(g.id, "hero", body); expect({ body, status: r.status }).toEqual({ body, status }); };
    await refused({ url: "http://img.example.com/h.png" });
    ndeps.lookup = async (h: string) => [{ address: h === "inside.example.com" ? "10.0.0.7" : "93.184.216.34", family: 4 }];
    await refused({ url: "https://inside.example.com/h.png" });
    await refused({ url: "https://127.0.0.1/h.png" });
    ndeps.fetch = async (u: string) => (u.includes("hop.") ? new Response(null, { status: 302, headers: { location: "https://inside.example.com/x.png" } }) : new Response(PNG, { headers: { "content-type": "image/png" } }));
    await refused({ url: "https://hop.example.com/h.png" });
    ndeps.fetch = async () => new Response("<html></html>", { headers: { "content-type": "text/html" } });
    await refused({ url: "https://img.example.com/page" });
    ndeps.fetch = async () => new Response("gone", { status: 404, headers: { "content-type": "image/png" } });
    await refused({ url: "https://img.example.com/gone.png" });
    ndeps.fetch = async () => new Response(image([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 16 * (1 << 20)), { headers: { "content-type": "image/png" } });
    await refused({ url: "https://img.example.com/huge.png" }, 413);
    await refused({ link: "https://img.example.com/x.png" });
    expect(own(g.id)).toEqual(["logo"]);
  });
  test("hero and logo exist only as the game's own; a banner falls back to the game's own poster before its cover", async () => {
    const g = game("Heroic", { cover_url: STEAM_POSTER });
    for (const kind of ["hero", "logo"]) expect((await artApi.request(`/api/v1/art/game/${g.id}/${kind}`)).status).toBe(404);
    expect((await artApi.request(`/api/v1/art/game/424242/hero`)).status).toBe(404);
    expect((await putArt(g.id, "hero", JPG, "image/jpeg")).status).toBe(200);
    const hero = await artApi.request(`/api/v1/art/game/${g.id}/hero`);
    expect(hero.status).toBe(200); expect(hero.headers.get("content-type")).toBe("image/jpeg");
    expect((await del(g.id, "hero")).status).toBe(200);
    expect((await artApi.request(`/api/v1/art/game/${g.id}/hero`)).status).toBe(404);
    await putArt(g.id, "poster", PNG, "image/png");
    const banner = await artApi.request(`/api/v1/art/game/${g.id}/banner`);
    expect(banner.headers.get("x-ludarr-art")).toBe("custom"); expect(banner.headers.get("content-type")).toBe("image/png");
  });
  test("a game added by hand with art links keeps them as its own; a link that gives no image refuses the add", async () => {
    ndeps.fetch = async (u: string) => new Response(u.endsWith(".png") ? PNG : JPG, { headers: { "content-type": u.endsWith(".png") ? "image/png" : "image/jpeg" } });
    const post = async (body: unknown) => gamesApi.request("/api/v1/game", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const res = await post({ source: "manual", game: { name: "Linked Art" }, posterUrl: "https://img.example.com/p.png", bannerUrl: "https://img.example.com/b.jpg", searchNow: false });
    expect(res.status).toBe(201);
    const { item } = await res.json() as { item: any };
    expect(item.customArt).toEqual(["poster", "banner"]);
    expect(files()).toEqual([`game-${item.id}-banner.jpg`, `game-${item.id}-poster.png`]);
    ndeps.fetch = async () => new Response("<html></html>", { headers: { "content-type": "text/html" } });
    const bad = await post({ source: "manual", game: { name: "No Art" }, posterUrl: "https://img.example.com/p.png" });
    expect(bad.status).toBe(400);
    expect((stmts.allGames.all() as GameRow[]).map(x => x.name)).toEqual(["Linked Art"]);
    // a deleted game's own art goes with it
    expect((await gamesApi.request(`/api/v1/game/${item.id}`, { method: "DELETE" })).status).toBe(200);
    expect(files()).toEqual([]);
  });
});

describe("automatic art for a game without a store id", () => {
  test("a Steam poster only when the store's own year agrees with the game's; with no year, Steam is not even asked", async () => {
    adeps.fetch = (async () => new Response(PNG, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    let searched = 0;
    adeps.steamSearch = async () => { searched++; return [{ appId: 1, name: "Demon's Souls", tinyImage: "", metascore: null, priceUsd: null }]; };
    adeps.steamArt = (async () => ({ portrait: STEAM_POSTER, hero: STEAM_HERO, cardWide: "x" })) as never;
    adeps.steamDetails = async () => ({ release_date: { coming_soon: false, date: "Nov 12, 2020" } }) as never;      // the remake
    const g = game("Demon's Souls", { platforms_json: "[]" });
    expect(await resolveGameArt(g, true)).toMatchObject({ cover: null, banner: null });
    adeps.steamDetails = async () => ({ release_date: { coming_soon: false, date: "Feb 5, 2009" } }) as never;
    expect(await resolveGameArt(g, true)).toMatchObject({ cover: STEAM_POSTER, source: "steam:1" });
    searched = 0;
    const noYear = game("Demon's Souls", { release_year: null, platforms_json: "[]" });
    expect((await resolveGameArt(noYear, true)).cover).toBeNull(); expect(searched).toBe(0);
  });
  test("an IGDB poster only when IGDB's first release date agrees — or by the game's own IGDB id", async () => {
    adeps.fetch = (async () => new Response(PNG, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    let year = 2020;
    const igdbGame = (id: number, y: number) => ({ id, name: "Demon's Souls", first_release_date: Date.UTC(y, 1, 5) / 1000, cover: { image_id: `co${id}` } });
    const g = game("Demon's Souls", { platforms_json: "[]" });
    adeps.igdb = () => ({ search: async () => [igdbGame(5, year)], details: async () => [] }) as never;
    expect((await resolveGameArt(g, true)).cover).toBeNull();
    year = 2009;
    expect(await resolveGameArt(g, true)).toMatchObject({ source: "igdb:5", cover: expect.stringContaining("co5") });
    adeps.igdb = () => ({ search: async () => [igdbGame(5, 2009), igdbGame(77, 2020)], details: async () => [] }) as never;
    const byId = game("Demon's Souls", { igdb_id: 77, platforms_json: "[]" });
    expect(await resolveGameArt(byId, true)).toMatchObject({ source: "igdb:77" });
  });
  test("libretro is asked only for the consoles the game is on, however they are written", () => {
    expect(libretroSystems(["Nintendo 64", "win"])).toEqual(["Nintendo - Nintendo 64"]);
    expect(libretroSystems(["N64", "n64", "nintendo 64"])).toEqual(["Nintendo - Nintendo 64"]);
    expect(libretroSystems(["PS2", "Genesis", "Mega Drive"])).toEqual(["Sony - PlayStation 2", "Sega - Mega Drive - Genesis"]);
    expect(libretroSystems(["win", "pc", "mac"])).toEqual([]);
    expect(libretroSystems(["dos"])).toEqual(["DOS"]);
  });
  test("with its own poster only a missing banner is looked for; with its own banner, banner_url is never written; with both nothing is asked", async () => {
    adeps.fetch = (async () => new Response(PNG, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    let calls = 0;
    adeps.steamArt = (async () => { calls++; return { portrait: STEAM_POSTER, hero: STEAM_HERO, cardWide: "x" }; }) as never;
    const g = game("Own Poster", { steam_appid: 990201 });
    await storeCustomArt(g.id, "poster", { bytes: PNG, type: "image/png" });
    await resolveGameArt(row(g.id), true);
    expect(row(g.id).cover_url).toBeNull(); expect(row(g.id).banner_url).toBe(STEAM_HERO);
    calls = 0;
    await resolveGameArt(row(g.id), true);
    expect(calls).toBe(0);
    const h = game("Own Banner", { steam_appid: 990202 });
    await storeCustomArt(h.id, "banner", { bytes: JPG, type: "image/jpeg" });
    await resolveGameArt(row(h.id), true);
    expect(row(h.id).cover_url).toBe(STEAM_POSTER); expect(row(h.id).banner_url).toBeNull();
    const both = game("Own Both", { steam_appid: 990203 });
    await storeCustomArt(both.id, "poster", { bytes: PNG, type: "image/png" });
    await storeCustomArt(both.id, "banner", { bytes: PNG, type: "image/png" });
    calls = 0;
    await resolveGameArt(row(both.id), true);
    expect(calls).toBe(0); expect(row(both.id)).toMatchObject({ cover_url: null, banner_url: null });
  });
});
