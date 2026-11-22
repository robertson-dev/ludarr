import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, kv, stmts, type GameRow } from "../src/db";
import { adeps, allowedUrl, ART_MAX_BYTES, cachedImage, coverQuality, gametdbCandidates, libretroName, pickLibretro, placeholderSvg, resolveGameArt, sniffCachedImage, steamPoster, wideImage } from "../src/art";
import { assetsToArt } from "../src/steam";
import { artApi } from "../src/api/art";

process.env.LUDARR_CONFIG = mkdtempSync(join(tmpdir(), "ludarr-art-"));
/** 2000 bytes that start as a picture of that kind does: the cache keeps what the bytes are, not what the source calls them */
const image = (sig: number[]) => { const b = new Uint8Array(2000).fill(1); b.set(sig); return b; };
const PNG = image([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = image([0xff, 0xd8, 0xff, 0xe0]);
const game = () => stmts.upsertGame({ igdb_id: null, steam_appid: null, name: "Demon's Souls", slug: "demons-souls", summary: null, storyline: null, release_year: 2009, first_release_date: null, rating: null, cover_url: "https://art.gametdb.com/ps3/cover/US/NPUB30910.jpg", banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["ps3"]', game_modes_json: "[]", developer: null, publisher: null }) as GameRow;

beforeEach(() => { db.exec("DELETE FROM games; DELETE FROM title_ids; DELETE FROM titles; DELETE FROM kv WHERE key LIKE 'art.%'"); adeps.igdb = () => null; adeps.steamSearch = async () => []; adeps.steamDetails = async () => null; });

describe("art", () => {
  test("placeholders carry the title; only image hosts are proxied", () => {
    expect(placeholderSvg("The Legend of Zelda: Majora's Mask")).toMatch(/Zelda: Majora's<\/text>.*>Mask<\/text>/);
    expect(placeholderSvg("<b>x</b>")).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(placeholderSvg("Wide", "banner")).toContain('width="1920"');
    expect(allowedUrl("https://cdn.cloudflare.steamstatic.com/steam/apps/1/library_600x900.jpg")).toBe(true);
    expect(allowedUrl("https://thumbnails.libretro.com/x/y.png")).toBe(true);
    expect(allowedUrl("https://evil.example/steamstatic.com.png")).toBe(false);
    expect(allowedUrl("http://art.gametdb.com/x.jpg")).toBe(false);
  });
  test("libretro names: tags stripped, ', The' put back, USA preferred over Europe and betas", () => {
    expect(libretroName("Legend of Zelda, The - Majora's Mask (USA) (Rev 1).png")).toBe("The Legend of Zelda - Majora's Mask");
    expect(libretroName("Demon's Souls (Europe) (En,Fr,De).png")).toBe("Demon's Souls");
    const names = ["Demon's Souls (Europe).png", "Demon's Souls (USA) (Beta).png", "Demon's Souls (USA).png", "Dark Souls (USA).png"];
    expect(pickLibretro(names, "Demon's Souls")).toBe("Demon's Souls (USA).png");
    expect(pickLibretro(names, "The Legend of Zelda: Majora's Mask")).toBeNull();
    expect(pickLibretro(["Legend of Zelda, The - Majora's Mask (USA).png"], "The Legend of Zelda: Majora's Mask")).toBe("Legend of Zelda, The - Majora's Mask (USA).png");
  });
  test("GameTDB candidates: high-res US, then Europe, before the small covers; Japan after both; PSN serials last", () => {
    const c = gametdbCandidates([{ scheme: "serial", value: "NPUB30910" }, { scheme: "serial", value: "BCJS30022" }, { scheme: "serial", value: "BLES00932" }, { scheme: "serial", value: "BLUS30443" }, { scheme: "titleid", value: "534507D4" }], ["ps3"]);
    expect(c.slice(0, 4)).toEqual([
      "https://art.gametdb.com/ps3/coverHQ/US/BLUS30443.jpg", "https://art.gametdb.com/ps3/coverHQ/EN/BLES00932.jpg",
      "https://art.gametdb.com/ps3/cover/US/BLUS30443.jpg", "https://art.gametdb.com/ps3/cover/EN/BLES00932.jpg",
    ]);
    expect(c.indexOf("https://art.gametdb.com/ps3/coverHQ/JA/BCJS30022.jpg")).toBeGreaterThan(c.indexOf("https://art.gametdb.com/ps3/cover/EN/BLES00932.jpg"));
    expect(c.at(-1)).toBe("https://art.gametdb.com/ps3/cover/US/NPUB30910.jpg");
    expect(c.some(u => u.includes("534507D4"))).toBe(false);
    expect(gametdbCandidates([{ scheme: "serial", value: "RZDE01" }], ["wii"])).toEqual(["https://art.gametdb.com/wii/coverHQ/US/RZDE01.png", "https://art.gametdb.com/wii/cover/US/RZDE01.png"]);
  });
  test("a poster is judged: wide Steam art is none, Japanese or thumbnail-sized covers are poor, box art is proper", () => {
    expect(wideImage("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3747730/f0b6/header.jpg")).toBe(true);
    expect(wideImage("https://cdn.cloudflare.steamstatic.com/steam/apps/1/capsule_616x353.jpg")).toBe(true);
    expect(wideImage("https://cdn.cloudflare.steamstatic.com/steam/apps/1/library_600x900.jpg")).toBe(false);
    expect(coverQuality("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/ab/header_2x.jpg")).toBe(0);
    expect(coverQuality(null)).toBe(0);
    expect(coverQuality("https://art.gametdb.com/ps3/cover/JA/BCJS30022.jpg")).toBe(1);
    expect(coverQuality("https://art.gametdb.com/ps3/coverHQ/JA/BCJS30022.jpg")).toBe(1);
    expect(coverQuality("https://art.gametdb.com/ps3/cover/US/BLUS30443.jpg")).toBe(1);
    expect(coverQuality("https://art.gametdb.com/ps3/coverHQ/US/BLUS30443.jpg")).toBe(2);
    expect(coverQuality("https://images.igdb.com/igdb/image/upload/t_cover_big/co1l2i.jpg")).toBe(1);
    expect(coverQuality("https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1l2i.jpg")).toBe(2);
    expect(coverQuality("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/ab/library_capsule_2x.jpg?t=1")).toBe(2);
    expect(coverQuality("https://cdn.cloudflare.steamstatic.com/steam/apps/367520/library_600x900.jpg")).toBe(1);     // 300x450
    expect(coverQuality("https://cdn.cloudflare.steamstatic.com/steam/apps/367520/library_600x900_2x.jpg")).toBe(2);
    expect(coverQuality("https://thumbnails.libretro.com/Sony%20-%20PlayStation%203/Named_Boxarts/Demon's%20Souls%20(USA).png")).toBe(2);
  });
  test("Steam's asset table becomes real URLs: the 2x library capsule is the poster, the header is never one", () => {
    const art = assetsToArt({ asset_url_format: "steam/apps/4115450/${FILENAME}?t=1787142639", header: "7f88/header.jpg", library_capsule: "471e/library_capsule.jpg", library_capsule_2x: "471e/library_capsule_2x.jpg", library_hero: "1cd5/library_hero.jpg", main_capsule: "98af/capsule_616x353.jpg" });
    expect(art).toEqual({
      portrait: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4115450/471e/library_capsule_2x.jpg?t=1787142639",
      hero: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4115450/1cd5/library_hero.jpg?t=1787142639",
      cardWide: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4115450/98af/capsule_616x353.jpg?t=1787142639",
    });
    const headerOnly = assetsToArt({ asset_url_format: "steam/apps/1/${FILENAME}", header: "ab/header.jpg" });
    expect(headerOnly?.portrait).toBeNull(); expect(headerOnly?.hero).toContain("/ab/header.jpg"); expect(wideImage(headerOnly?.cardWide)).toBe(true);
    expect(assetsToArt({})).toBeNull();
  });
  test("the cache keeps real images, remembers failures, and never fetches twice", async () => {
    const calls: string[] = [];
    adeps.fetch = (async (u: any) => { calls.push(String(u)); return String(u).includes("good") ? new Response(PNG, { headers: { "content-type": "image/png" } }) : new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } }); }) as unknown as typeof fetch;
    const good = await cachedImage("https://art.gametdb.com/ps3/cover/US/good.jpg");
    expect(good?.type).toBe("image/png");
    expect(await cachedImage("https://art.gametdb.com/ps3/cover/US/good.jpg")).toEqual(good);
    expect(await cachedImage("https://art.gametdb.com/ps3/cover/US/bad.jpg")).toBeNull();
    expect(await cachedImage("https://art.gametdb.com/ps3/cover/US/bad.jpg")).toBeNull();
    expect(calls.filter(c => c.includes("good"))).toHaveLength(1); expect(calls.filter(c => c.includes("bad"))).toHaveLength(1);
  });
  test("a game with a dead cover gets one from the first source that has it, stored on the game; the poster route serves it, else a placeholder", async () => {
    const g = game();
    db.query("INSERT INTO titles (id, slug, name, sort_name, platforms_json) VALUES (900, 'demons-souls', 'Demon''s Souls', 'demons souls', '[\"ps3\"]')").run();
    db.query("INSERT INTO title_ids (scheme, value, title_id, source) VALUES ('serial', 'NPUB30910', 900, 't'), ('serial', 'BLUS30443', 900, 't')").run();
    stmts.setGameTitle.run(900, g.id);
    const fresh = stmts.gameById.get(g.id) as GameRow;
    adeps.fetch = (async (u: any) => (String(u).includes("BLUS30443") ? new Response(JPG, { headers: { "content-type": "image/jpeg" } }) : new Response("no", { status: 404 }))) as unknown as typeof fetch;
    const art = await resolveGameArt(fresh);
    expect(art).toMatchObject({ cover: "https://art.gametdb.com/ps3/coverHQ/US/BLUS30443.jpg", source: "gametdb" });
    expect((stmts.gameById.get(g.id) as GameRow).cover_url).toBe("https://art.gametdb.com/ps3/coverHQ/US/BLUS30443.jpg");
    const poster = await artApi.request(`/api/v1/art/game/${g.id}/poster`);
    expect(poster.headers.get("content-type")).toBe("image/jpeg");
    const missing = await artApi.request(`/api/v1/art/game/999999/poster`);
    expect(missing.headers.get("content-type")).toBe("image/svg+xml"); expect(missing.headers.get("x-ludarr-art")).toBe("placeholder");
    expect(kv.get(`art.game.${g.id}`)).not.toBeNull();
  });
  test("Steam by exact name (its year agreeing) wins when the game has no app id; the header fallback is not taken as a poster", async () => {
    const g = game();
    adeps.fetch = (async () => new Response(JPG, { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    adeps.steamSearch = async () => [{ appId: 1, name: "Demon's Souls", tinyImage: "", metascore: null, priceUsd: null }];
    adeps.steamDetails = async () => ({ release_date: { coming_soon: false, date: "Feb 5, 2009" } }) as never;
    adeps.steamArt = async () => ({ portrait: "https://cdn.cloudflare.steamstatic.com/steam/apps/1/library_600x900.jpg", hero: "https://cdn.cloudflare.steamstatic.com/steam/apps/1/library_hero.jpg", cardWide: "x" });
    expect(await resolveGameArt(g, true)).toMatchObject({ cover: expect.stringContaining("library_600x900"), banner: expect.stringContaining("library_hero"), source: "steam:1" });
    adeps.steamArt = async () => ({ portrait: null, hero: "https://cdn.cloudflare.steamstatic.com/steam/apps/1/header.jpg", cardWide: "x" });
    const g2 = stmts.upsertGame({ igdb_id: null, steam_appid: null, name: "Other Game", slug: "other", summary: null, storyline: null, release_year: 2009, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["ps3"]', game_modes_json: "[]", developer: null, publisher: null }) as GameRow;
    adeps.steamSearch = async () => [{ appId: 2, name: "Other Game", tinyImage: "", metascore: null, priceUsd: null }];
    const r = await resolveGameArt(g2, true);
    expect(r.cover).toBeNull(); expect(r.banner).toContain("header.jpg");
  });
  test("a Steam app that is no library game gets its library capsule as poster, or a placeholder with its name — never the header", async () => {
    adeps.fetch = (async () => new Response(JPG, { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    adeps.steamArt = async (id: number) => ({ portrait: id === 1 ? "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/ab/library_capsule_2x.jpg?t=1" : null, hero: "https://cdn.cloudflare.steamstatic.com/steam/apps/2/header.jpg", cardWide: "x" });
    expect(await steamPoster(1)).toContain("library_capsule_2x"); expect(await steamPoster(2)).toBeNull();
    expect((await artApi.request("/api/v1/art/steam/1/poster")).headers.get("content-type")).toBe("image/jpeg");
    const ph = await artApi.request("/api/v1/art/steam/2/poster?n=Phantom%20Blade%20Zero");
    expect(ph.headers.get("x-ludarr-art")).toBe("placeholder"); const svg = await ph.text(); expect(svg).toContain(">Phantom Blade</text>"); expect(svg).toContain(">Zero</text>");
  });
  test("a poor poster is swapped for a better one and a proper one is left alone; a wide header stored as the cover is never served as one", async () => {
    const urls: string[] = [];
    adeps.fetch = (async (u: any) => { urls.push(String(u)); return /BCJS30022|BLUS30443|library_capsule_2x/.test(String(u)) ? new Response(JPG, { headers: { "content-type": "image/jpeg" } }) : new Response("no", { status: 404 }); }) as unknown as typeof fetch;
    const row = (name: string, cover: string | null, steam: number | null = null) => stmts.upsertGame({ igdb_id: null, steam_appid: steam, name, slug: name.toLowerCase().replace(/\W+/g, "-"), summary: null, storyline: null, release_year: null, first_release_date: null, rating: null, cover_url: cover, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: steam ? '["win"]' : '["ps3"]', game_modes_json: "[]", developer: null, publisher: null }) as GameRow;
    // Japanese print on file (it loads), the catalog knows the US serial: the high-res US cover replaces it
    const ja = row("Demon's Souls", "https://art.gametdb.com/ps3/cover/JA/BCJS30022.jpg");
    db.query("INSERT INTO titles (id, slug, name, sort_name, platforms_json) VALUES (901, 'demons-souls-ja', 'Demon''s Souls', 'demons souls', '[\"ps3\"]')").run();
    db.query("INSERT INTO title_ids (scheme, value, title_id, source) VALUES ('serial', 'BCJS30022', 901, 't'), ('serial', 'BLUS30443', 901, 't')").run();
    stmts.setGameTitle.run(901, ja.id);
    expect((await resolveGameArt(stmts.gameById.get(ja.id) as GameRow)).cover).toBe("https://art.gametdb.com/ps3/coverHQ/US/BLUS30443.jpg");
    // the proper poster is kept without a single lookup
    const n = urls.length;
    const good = row("Dark Souls", "https://art.gametdb.com/ps3/coverHQ/US/BLUS30443.jpg");
    expect((await resolveGameArt(good)).cover).toBe("https://art.gametdb.com/ps3/coverHQ/US/BLUS30443.jpg");
    expect(urls.length).toBe(n);
    // a Steam header saved as the cover: the store's library capsule is taken instead; with nothing better, no poster rather than a stretched header
    adeps.steamArt = async (id: number) => ({ portrait: id === 7 ? "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/7/ab/library_capsule_2x.jpg?t=1" : null, hero: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/7/cd/header.jpg", cardWide: "x" });
    const hashed = row("Phantom Blade Zero", "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/7/cd/header.jpg", 7);
    expect((await resolveGameArt(hashed)).cover).toContain("library_capsule_2x");
    expect((stmts.gameById.get(hashed.id) as GameRow).cover_url).toContain("library_capsule_2x");
    const headerOnly = row("Castlevania: Belmont's Curse", "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/8/ef/header.jpg", 8);
    const r = await resolveGameArt(headerOnly);
    expect(r.cover).toBeNull(); expect(r.banner).toBeNull();   // the header 404s in this mock, so it is not kept as a banner either
    expect((await artApi.request(`/api/v1/art/game/${headerOnly.id}/poster`)).headers.get("x-ludarr-art")).toBe("placeholder");
    expect((await artApi.request(`/api/v1/art/game/${headerOnly.id}/banner`)).headers.get("content-type")).toBe("image/svg+xml");   // the banner 404s in this mock
  });
});

/* the art routes take no key and answer from ludarr's own address, where the page holds the API key: what they keep and
   serve must be a picture and nothing a browser could run */
describe("art fetched by its address is a picture, or it is not kept", () => {
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/').then(r=>r.text()).then(t=>top.postMessage(t,'*'))</script>${"<g/>".repeat(200)}</svg>`;
  const proxied = (u: string) => artApi.request(`/api/v1/art/url?u=${encodeURIComponent(u)}`);

  test("an SVG is never kept or served, whatever its source calls it", async () => {
    let calls = 0;
    adeps.fetch = (async () => { calls++; return new Response(SVG, { headers: { "content-type": "image/svg+xml" } }); }) as unknown as typeof fetch;
    expect(await cachedImage("https://art.gametdb.com/ps3/cover/US/script-a.svg")).toBeNull();
    const res = await proxied("https://art.gametdb.com/ps3/cover/US/script-b.svg");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<script");
    // the same document under a picture's type: the bytes decide, not the header
    adeps.fetch = (async () => { calls++; return new Response(SVG, { headers: { "content-type": "image/png" } }); }) as unknown as typeof fetch;
    expect(await cachedImage("https://art.gametdb.com/ps3/cover/US/script-c.png")).toBeNull();
    expect(await cachedImage("https://art.gametdb.com/ps3/cover/US/script-d.png")).toBeNull();
    expect(calls).toBe(4);
  });

  test("a host where anyone can put a file is not on the list", async () => {
    let calls = 0;
    adeps.fetch = (async () => { calls++; return new Response(PNG, { headers: { "content-type": "image/png" } }); }) as unknown as typeof fetch;
    expect(allowedUrl("https://raw.githubusercontent.com/someone/repo/main/evil.svg")).toBe(false);
    expect((await proxied("https://raw.githubusercontent.com/someone/repo/main/poster.png")).status).toBe(404);
    expect(calls).toBe(0);
  });

  test("a redirect is followed only to an allowed host", async () => {
    const seen: { url: string; redirect: unknown }[] = [];
    adeps.fetch = (async (u: any, init: any) => {
      seen.push({ url: String(u), redirect: init?.redirect });
      if (String(u).includes("/moved-out")) return new Response(null, { status: 302, headers: { location: "https://evil.example/poster.png" } });
      if (String(u).includes("/moved-in")) return new Response(null, { status: 301, headers: { location: "https://cdn.cloudflare.steamstatic.com/steam/apps/9/library_600x900_2x.jpg" } });
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    expect(await cachedImage("https://art.gametdb.com/moved-out.png")).toBeNull();
    expect(seen.map(s => s.url)).toEqual(["https://art.gametdb.com/moved-out.png"]);            // evil.example was never asked
    expect((await cachedImage("https://art.gametdb.com/moved-in.png"))?.type).toBe("image/png");
    expect(seen.every(s => s.redirect === "manual")).toBe(true);
  });

  test("what is kept is what the bytes are; a picture larger than the cap is not kept", async () => {
    const GIF = image([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), AVIF = image([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    expect(sniffCachedImage(PNG)).toBe("image/png"); expect(sniffCachedImage(JPG)).toBe("image/jpeg");
    expect(sniffCachedImage(GIF)).toBe("image/gif"); expect(sniffCachedImage(AVIF)).toBe("image/avif");
    // an AVIF that names another brand its own and avif among those it is compatible with; an ISO media file that is no AVIF
    expect(sniffCachedImage(image([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x61, 0x66]))).toBe("image/avif");
    expect(sniffCachedImage(image([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]))).toBeNull();
    expect(sniffCachedImage(new TextEncoder().encode(SVG))).toBeNull();
    expect(sniffCachedImage(new TextEncoder().encode("<html><script>alert(1)</script></html>"))).toBeNull();
    adeps.fetch = (async () => new Response(JPG, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    expect((await cachedImage("https://art.gametdb.com/ps3/cover/US/mislabelled.png"))?.type).toBe("image/jpeg");
    const big = new Uint8Array(ART_MAX_BYTES + 1); big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    adeps.fetch = (async () => new Response(big, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    expect(await cachedImage("https://art.gametdb.com/ps3/cover/US/huge.png")).toBeNull();
  });

  test("every art answer is inert: its type is taken as given, and opened as a page it runs and loads nothing", async () => {
    adeps.fetch = (async () => new Response(PNG, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const inert = (r: Response) => [r.headers.get("x-content-type-options"), /default-src 'none'/.test(r.headers.get("content-security-policy") ?? ""), /(^|;)\s*sandbox\s*(;|$)/.test(r.headers.get("content-security-policy") ?? "")];
    const kept = await proxied("https://art.gametdb.com/ps3/cover/US/inert.png");
    expect(kept.status).toBe(200); expect(kept.headers.get("content-type")).toBe("image/png");
    expect(inert(kept)).toEqual(["nosniff", true, true]);
    expect(inert(await artApi.request("/api/v1/art/game/999999/poster"))).toEqual(["nosniff", true, true]);   // the placeholder too
  });
});
