/**
 * ludarr — art: posters and banners for games and catalog titles, served by ludarr itself.
 *
 * Images are fetched once from their source, kept under <config>/art, and served from there (no hot-linking,
 * no CDN hiccups in the UI). A game without a proper poster gets one resolved from keyless sources in order:
 * Steam (by app id, else by exact name), IGDB when configured, GameTDB (every serial the catalog knows for
 * it, best region and resolution first), libretro's box-art repository (No-Intro names). A poster is judged,
 * not just loaded: a wide Steam header is never one, a Japanese or thumbnail-sized cover is a poor one that
 * a better source replaces. When nothing is found, a generated placeholder with the title is served instead —
 * an <img> in the UI never breaks.
 *
 * A game without a store id is matched by name, and a name alone can belong to another game: a Steam poster is taken
 * only when the store's own release year is within one of the game's, an IGDB one only when IGDB's first release date
 * is, and libretro's only for a console the game is on. Art the admin set by hand (an upload or a link fetched once,
 * kept under <config>/art/custom) belongs to the game: automatic art never replaces a kind that has it.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ART_KINDS, customArtOf, db, kv, stmts, type ArtKind, type GameRow } from "./db";
import { configDir } from "./config";
import { logger } from "./log";
import { normName } from "./catalog/store";
import { steamArt, steamDetails, steamSearch } from "./steam";
import { IgdbClient, imageUrl } from "./igdb";
import { platformId } from "./platforms";
import { PublicUrlError, publicFetch, readCapped } from "./net/public-url";
import * as registry from "./plugins/registry";

const log = logger("Art");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", Accept: "image/avif,image/webp,image/*,*/*;q=0.8" };

/** swappable in tests */
export const adeps = {
  fetch: fetch as typeof fetch,
  steamSearch, steamArt, steamDetails,
  igdb: (): IgdbClient | null => {
    const row = registry.instanceRows("metadata").find(r => r.impl === "igdb" && r.enabled);
    if (!row) return null;
    try { const s = JSON.parse(row.settings_json); const c = new IgdbClient(); c.configure(String(s.clientId ?? ""), String(s.clientSecret ?? ""), false); return c.configured() ? c : null; } catch { return null; }
  },
  now: () => Date.now(),
};

/* ─────────── the cache ─────────── */

const ART_DIR = () => join(configDir(), "art");
/** the hosts art is fetched from: the stores and box-art sites the sources above name. Never a host where anyone can put a
 *  file (raw.githubusercontent.com was one): what is fetched here is kept and served from ludarr's own address, without the key */
const HOSTS = [/(^|\.)steamstatic\.com$/i, /(^|\.)gametdb\.com$/i, /(^|\.)igdb\.com$/i, /^thumbnails\.libretro\.com$/i, /(^|\.)akamaihd\.net$/i, /(^|\.)steampowered\.com$/i];
export function allowedUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" && HOSTS.some(h => h.test(x.hostname)); } catch { return false; }
}

/* ─────────── what makes a poster ─────────── */

/** wide Steam art (headers, capsules, heroes, page backgrounds): fine as a banner, never a poster */
export const wideImage = (u: string | null | undefined): boolean =>
  !!u && /\/(header(_2x)?|capsule_\d+x\d+(_2x)?|hero_capsule(_2x)?|library_hero(_2x)?|page_bg[^/]*)\.jpg/i.test(u);
/** 0 = not a poster, 1 = a poor one (wrong region, thumbnail-sized), 2 = a proper one */
export function coverQuality(u: string | null | undefined): 0 | 1 | 2 {
  if (!u || wideImage(u)) return 0;
  if (/gametdb\.com\/[^/]+\/[^/]+\/(JA|KO)\//.test(u)) return 1;        // the Japanese / Korean print of a western release
  if (/gametdb\.com\/[^/]+\/cover\//.test(u)) return 1;                 // the small cover; coverHQ is the one to have
  if (/igdb\.com\/.*\/t_(cover_big|cover_small|thumb|micro)\//.test(u)) return 1;
  if (/steamstatic\.com\/.*\/(library_capsule|library_600x900)\.jpg/.test(u)) return 1;   // 300x450; the _2x is 600x900
  return 2;
}

const failed = new Map<string, number>();                 // url → when it last failed (retried after a day)
const inflight = new Map<string, Promise<CachedImage | null>>();
export interface CachedImage { path: string; type: string }
/** what the cache keeps and serves: pictures only. No SVG: it is a document that can carry script, and it would run at
 *  ludarr's own address, where the page holds the API key (a file kept as .svg before this is no longer served) */
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const key = (url: string) => createHash("sha1").update(url).digest("hex").slice(0, 24);

/** what the bytes of a fetched image are, by their own signature (what the source calls them is never taken on faith):
 *  PNG, JPEG or WebP as for art set by hand, and the GIF and AVIF a store may answer with; null for anything else */
export function sniffCachedImage(b: Uint8Array): string | null {
  const known = sniffImage(b);
  if (known) return known;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  // AVIF: an ISO media file whose first box (ftyp) names the brand avif / avis, as its own or among those it is compatible with
  if (b.length >= 16 && ascii(4, 8) === "ftyp") {
    const end = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 256);
    for (let at = 8; at + 4 <= end; at += 4) if (at !== 12 && /^avi[fs]$/.test(ascii(at, at + 4))) return "image/avif";
  }
  return null;
}

/** the source's answer, its redirects followed by hand (three at most): each must lead to an allowed host again; null
 *  when one leads elsewhere */
async function fetchAllowed(url: string): Promise<Response | null> {
  let at = url;
  for (let hop = 0; hop <= 3; hop++) {
    const res = await adeps.fetch(at, { headers: UA, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to) return res;
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
    at = new URL(to, at).toString();
    if (!allowedUrl(at)) return null;
  }
  return null;
}

/** the image behind a URL, from disk or fetched once; null when the source has nothing usable */
export async function cachedImage(url: string): Promise<CachedImage | null> {
  if (!allowedUrl(url)) return null;
  const k = key(url);
  await mkdir(ART_DIR(), { recursive: true });
  for (const ext of Object.keys(TYPE)) {
    const p = join(ART_DIR(), `${k}.${ext}`);
    if (await stat(p).then(s => s.size > 0, () => false)) return { path: p, type: TYPE[ext] };
  }
  const at = failed.get(url);
  if (at && adeps.now() - at < 24 * 3600_000) return null;
  const pending = inflight.get(url);
  if (pending) return pending;
  const job = (async () => {
    try {
      const res = await fetchAllowed(url);
      if (!res?.ok) { try { await res?.body?.cancel(); } catch { /* nothing to drain */ } failed.set(url, adeps.now()); return null; }
      // read to the same cap as art set by hand, and kept only when the bytes themselves are a picture
      const bytes = await readCapped(res, ART_MAX_BYTES);
      const type = sniffCachedImage(bytes);
      if (!type || bytes.length < 400) { failed.set(url, adeps.now()); return null; }       // not a picture, or a 1-pixel "missing" image
      const p = join(ART_DIR(), `${k}.${EXT[type]}`);
      await Bun.write(p, bytes);
      return { path: p, type };
    } catch { failed.set(url, adeps.now()); return null; }
    finally { inflight.delete(url); }
  })();
  inflight.set(url, job);
  return job;
}

/* ─────────── placeholders ─────────── */

const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
function wrap(name: string, width: number): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width && line) { lines.push(line); line = w; } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 6);
}
/** a dark poster (2:3) or banner (16:9) with the title set in the middle — what the UI shows when there is no art */
export function placeholderSvg(name: string, kind: "poster" | "banner" = "poster"): string {
  const [w, h] = kind === "poster" ? [600, 900] : [1920, 620];
  const lines = wrap(name, kind === "poster" ? 16 : 30);
  const size = kind === "poster" ? 52 : 72;
  const y0 = h / 2 - ((lines.length - 1) * size * 1.15) / 2;
  const text = lines.map((l, i) => `<text x="50%" y="${Math.round(y0 + i * size * 1.15)}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="${size}" font-weight="500" fill="#8e94a0">${esc(l)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d2f36"/><stop offset="1" stop-color="#1b1c20"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><rect x="${w * 0.08}" y="${h * 0.06}" width="${w * 0.84}" height="${h * 0.88}" rx="18" fill="none" stroke="#3a3d45" stroke-width="4"/>${text}</svg>`;
}

/* ─────────── sources ─────────── */

interface Art { cover: string | null; banner: string | null; source: string | null }
const none: Art = { cover: null, banner: null, source: null };

/** how sure a name match must be: a library game is matched by name only when its year agrees (`year`, null = unknown,
 *  so nothing is taken); a catalog card (`loose`) keeps the plain exact-name match */
type NameCheck = { year: number | null } | "loose";
const yearsAgree = (check: NameCheck, year: number | null) => check === "loose" || (check.year != null && year != null && Math.abs(check.year - year) <= 1);

async function fromSteam(appId: number | null, name: string, check: NameCheck): Promise<Art> {
  let id = appId;
  if (!id) {
    if (check !== "loose" && check.year == null) return none;
    const hits = await adeps.steamSearch(name).catch(() => []);
    id = hits.find(h => normName(h.name) === normName(name))?.appId ?? null;
    if (id && check !== "loose") {
      // the store's own release year must agree, or it is another game of the same name
      const d = await adeps.steamDetails(id).catch(() => null);
      const y = Number(/\b(19[7-9]\d|20\d\d)\b/.exec(d?.release_date?.date ?? "")?.[1]) || null;
      if (!yearsAgree(check, y)) return none;
    }
  }
  if (!id) return none;
  const a = await adeps.steamArt(id).catch(() => null);
  if (!a) return none;
  // only box art is a poster; the header fallback is a wide capsule
  return { cover: a.portrait && !wideImage(a.portrait) ? a.portrait : null, banner: a.hero, source: `steam:${id}` };
}

async function fromIgdb(igdbId: number | null, name: string, check: NameCheck): Promise<Art> {
  const c = adeps.igdb();
  if (!c) return none;
  if (!igdbId && check !== "loose" && check.year == null) return none;
  const rows = await c.search(name, 8).catch(() => []);
  let g = igdbId ? rows.find(r => r.id === igdbId) ?? null : rows.find(r => normName(r.name) === normName(name)) ?? null;
  if (!g && igdbId) g = (await c.details([igdbId]).catch(() => []))[0] ?? null;
  if (!g) return none;
  // by name only: IGDB's first release date must agree with the game's year
  if (!igdbId && !yearsAgree(check, g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null)) return none;
  return { cover: g.cover?.image_id ? imageUrl(g.cover.image_id, "cover") : null, banner: g.artworks?.[0]?.image_id ? imageUrl(g.artworks[0].image_id, "banner") : g.screenshots?.[0]?.image_id ? imageUrl(g.screenshots[0].image_id, "shot") : null, source: `igdb:${g.id}` };
}

/**
 * GameTDB keeps covers per console and region, in two sizes (coverHQ, cover). Best first: the high-res western
 * print (US, then Europe) before the small one, the Japanese / Korean print after both, PSN serials last
 * (they rarely have a cover; the disc serial of the same game does).
 */
export function gametdbCandidates(ids: { scheme: string; value: string }[], platforms: string[]): string[] {
  const cands = new Map<string, number>();
  const REGION: Record<string, number> = { US: 0, EN: 1, JA: 3, KO: 3 };
  const add = (sys: string, region: string, serial: string, ext: string, psn: boolean) => {
    const base = (psn ? 100 : 0) + (REGION[region] >= 3 ? 20 : 0) + (REGION[region] ?? 2);
    cands.set(`https://art.gametdb.com/${sys}/coverHQ/${region}/${serial}.${ext}`, base);
    cands.set(`https://art.gametdb.com/${sys}/cover/${region}/${serial}.${ext}`, base + 10);
  };
  for (const { scheme, value } of ids) {
    if (scheme !== "serial" && scheme !== "titleid") continue;
    const v = value.replace("-", "").toUpperCase();
    // disc serials look like BLUS30443 / BLES00932, PSN ones like NPUB30910 / NPEB01234: the region letter sits third in both
    if (platforms.includes("ps3") && /^[A-Z]{4}\d{5}$/.test(v)) add("ps3", { U: "US", E: "EN", J: "JA", A: "EN", K: "KO", H: "EN" }[v[2]] ?? "US", v, "jpg", v.startsWith("NP"));
    if ((platforms.includes("wii") || platforms.includes("gc")) && /^[A-Z0-9]{6}$/.test(v)) add("wii", { E: "US", P: "EN", J: "JA", K: "KO" }[v[3]] ?? "US", v, "png", false);
  }
  return [...cands].sort((a, b) => a[1] - b[1]).map(([u]) => u);
}

const LIBRETRO: Record<string, string> = {
  ps1: "Sony - PlayStation", ps2: "Sony - PlayStation 2", ps3: "Sony - PlayStation 3", psp: "Sony - PlayStation Portable", vita: "Sony - PlayStation Vita",
  x360: "Microsoft - Xbox 360", xbox: "Microsoft - Xbox", n64: "Nintendo - Nintendo 64", snes: "Nintendo - Super Nintendo Entertainment System",
  nes: "Nintendo - Nintendo Entertainment System", gc: "Nintendo - GameCube", wii: "Nintendo - Wii", wiiu: "Nintendo - Wii U", nds: "Nintendo - Nintendo DS",
  "3ds": "Nintendo - Nintendo 3DS", gba: "Nintendo - Game Boy Advance", gb: "Nintendo - Game Boy", gbc: "Nintendo - Game Boy Color",
  genesis: "Sega - Mega Drive - Genesis", saturn: "Sega - Saturn", dc: "Sega - Dreamcast", dos: "DOS", arcade: "MAME",
};
/** "Legend of Zelda, The - Majora's Mask (USA) (Rev 1)" → the name as a person would say it, without the tags */
export function libretroName(file: string): string {
  return file.replace(/\.png$/i, "").replace(/\s*\([^)]*\)/g, "").replace(/\s*\[[^\]]*\]/g, "")
    .replace(/^(.*?), (The|A|An)( - |$)/, "$2 $1$3").trim();
}
const REGION_RANK = (f: string) => (/\(USA/.test(f) ? 0 : /\(World/.test(f) ? 1 : /\(Europe/.test(f) ? 2 : /\(Japan/.test(f) ? 4 : 3) + (/\((Beta|Proto|Demo|Sample|Unl)\b/.test(f) ? 10 : 0);

async function libretroListing(system: string): Promise<string[]> {
  const k = `art.libretro.${system}`;
  try { const c = JSON.parse(kv.get(k) ?? "null") as { at: number; names: string[] } | null; if (c && adeps.now() - c.at < 7 * 86_400_000) return c.names; } catch { /* refetch */ }
  const res = await adeps.fetch(`https://thumbnails.libretro.com/${encodeURIComponent(system)}/Named_Boxarts/`, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`libretro listing ${system}: HTTP ${res.status}`);
  const names = [...(await res.text()).matchAll(/href="([^"]+\.png)"/gi)].map(m => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } });
  kv.set(k, JSON.stringify({ at: adeps.now(), names }));
  return names;
}
export function pickLibretro(names: string[], game: string): string | null {
  const want = normName(game);
  const hits = names.filter(n => normName(libretroName(n)) === want).sort((a, b) => REGION_RANK(a) - REGION_RANK(b));
  return hits[0] ?? null;
}
/** the libretro systems of the platforms a game is on, however they are written ("N64", "Nintendo 64", "n64", "dos") */
export function libretroSystems(platforms: string[]): string[] {
  const keys = platforms.flatMap(p => [String(p).toLowerCase(), platformId(p) ?? ""]).filter(k => LIBRETRO[k]);
  return [...new Set(keys.map(k => LIBRETRO[k]))];
}
async function fromLibretro(name: string, platforms: string[]): Promise<Art> {
  for (const system of libretroSystems(platforms)) {
    try {
      const file = pickLibretro(await libretroListing(system), name);
      if (file) return { cover: `https://thumbnails.libretro.com/${encodeURIComponent(system)}/Named_Boxarts/${encodeURIComponent(file)}`, banner: null, source: `libretro:${system}` };
    } catch (e: any) { log.warn(`${e?.message ?? e}`); }
  }
  return none;
}

/** the poster of a Steam app that is not a library game (Add New, Discover): the store's library capsule, never its header */
export async function steamPoster(appId: number): Promise<string | null> {
  const a = await adeps.steamArt(appId).catch(() => null);
  return a?.portrait && !wideImage(a.portrait) ? a.portrait : null;
}

/* ─────────── resolution ─────────── */

const list = (s: string | null | undefined): string[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
const CHECK_EVERY = 7 * 86_400_000;
const ART_RULES = 2;                            // bump when the judging changes: posters judged under older rules get another look
const resolving = new Map<string, Promise<Art>>();

/** the first source with a poster better than what we have; the first banner seen fills a missing one */
async function firstUsable(cands: (() => Promise<Art>)[], have: number): Promise<Art> {
  let banner: string | null = null;
  for (const c of cands) {
    const a = await c().catch(() => none);
    if (!banner && a.banner && (await cachedImage(a.banner))) banner = a.banner;
    if (a.cover && coverQuality(a.cover) > have && (await cachedImage(a.cover))) return { ...a, banner: a.banner ?? banner };
  }
  return { ...none, banner };
}

/** judge the stored cover; look for a better one unless it is proper or was judged recently. `coverLocked`: the poster is
 *  the admin's own, so the sources are only asked for a banner (`current.banner` empty) */
async function lookFor(current: Art, checkedKey: string, force: boolean, sources: () => (() => Promise<Art>)[], coverLocked = false): Promise<{ have: 0 | 1 | 2; found: Art | null }> {
  const have = coverLocked ? 2 : current.cover && (await cachedImage(current.cover)) ? coverQuality(current.cover) : 0;
  if (!force) {
    if (have === 2 && !(coverLocked && !current.banner)) return { have, found: null };
    const [rules, at] = (kv.get(checkedKey) ?? "0:0").split(":").map(Number);
    if (rules === ART_RULES && adeps.now() - at < CHECK_EVERY) return { have, found: null };
  }
  const found = await firstUsable(sources(), have);
  kv.set(checkedKey, `${ART_RULES}:${adeps.now()}`);
  return { have, found };
}

const gametdbSource = (ids: { scheme: string; value: string }[], platforms: string[]) => async (): Promise<Art> => {
  for (const u of gametdbCandidates(ids, platforms)) if (await cachedImage(u)) return { cover: u, banner: null, source: "gametdb" };
  return none;
};

/**
 * The art for a library game: its poster when proper, otherwise the first source with a better one (stored on the game).
 * A kind the admin set by hand is never replaced: a game with its own poster only ever gets a missing banner looked up,
 * and one with its own banner keeps banner_url as it is.
 */
export function resolveGameArt(g: GameRow, force = false): Promise<Art> {
  const slot = `game:${g.id}`;
  const pending = resolving.get(slot);
  if (pending) return pending;
  const job = (async (): Promise<Art> => {
    const own = customArtOf(g).files;
    // with its own banner, the game has one for the lookups' purposes (banner_url itself is never written then)
    const current: Art = { cover: g.cover_url, banner: own.banner ? `upload:${own.banner}` : g.banner_url, source: null };
    if (own.poster && current.banner) return { cover: g.cover_url, banner: g.banner_url, source: null };
    const { have, found } = await lookFor(current, `art.game.${g.id}`, force, () => {
      const platforms = list(g.platforms_json);
      const ids = g.title_id ? (db.query("SELECT scheme, value FROM title_ids WHERE title_id=?").all(g.title_id) as { scheme: string; value: string }[]) : [];
      // without a store id, a name match must agree on the year too (or it may be another game's art)
      const check: NameCheck = { year: g.release_year ?? (Number(g.release_iso?.slice(0, 4)) || null) };
      return [() => fromSteam(g.steam_appid, g.name, check), () => fromIgdb(g.igdb_id, g.name, check), gametdbSource(ids, platforms), () => fromLibretro(g.name, platforms)];
    }, !!own.poster);
    const cover = own.poster ? null : found?.cover ?? null, banner = own.banner ? null : found?.banner ?? null;
    if (cover || banner) {
      db.query("UPDATE games SET cover_url=COALESCE(?, cover_url), banner_url=COALESCE(?, banner_url), updated_at=unixepoch() WHERE id=?").run(cover, banner, g.id);
      if (cover) log.info(`${g.name}: poster from ${found?.source}`);
    }
    return { cover: cover ?? (have ? g.cover_url : null), banner: banner ?? g.banner_url, source: cover ? found?.source ?? null : null };
  })().finally(() => resolving.delete(slot));
  resolving.set(slot, job);
  return job;
}

export interface TitleArtRow { id: number; name: string; cover_url: string | null; hero_url: string | null; platforms_json: string }
/** the art for a catalog title (Add New cards): same sources, stored on the title */
export function resolveTitleArt(t: TitleArtRow, force = false): Promise<Art> {
  const slot = `title:${t.id}`;
  const pending = resolving.get(slot);
  if (pending) return pending;
  const job = (async (): Promise<Art> => {
    const current: Art = { cover: t.cover_url, banner: t.hero_url, source: null };
    const { have, found } = await lookFor(current, `art.title.${t.id}`, force, () => {
      const ids = db.query("SELECT scheme, value FROM title_ids WHERE title_id=?").all(t.id) as { scheme: string; value: string }[];
      const steamId = Number(ids.find(i => i.scheme === "steam")?.value) || null;
      const platforms = list(t.platforms_json);
      return [() => fromSteam(steamId, t.name, "loose"), () => fromIgdb(null, t.name, "loose"), gametdbSource(ids, platforms), () => fromLibretro(t.name, platforms)];
    });
    if (found?.cover || found?.banner) db.query("UPDATE titles SET cover_url=COALESCE(?, cover_url), hero_url=COALESCE(?, hero_url) WHERE id=?").run(found.cover, found.banner, t.id);
    return { cover: found?.cover ?? (have ? t.cover_url : null), banner: found?.banner ?? t.hero_url, source: found?.cover ? found.source : null };
  })().finally(() => resolving.delete(slot));
  resolving.set(slot, job);
  return job;
}

/** the background task: library games whose cover is missing or dead get another look */
export async function resolveMissingArt(limit = 40): Promise<number> {
  let n = 0;
  for (const g of stmts.allGames.all() as GameRow[]) {
    if (n >= limit) break;
    const r = await resolveGameArt(g);
    if (r.source) n++;
  }
  return n;
}

/* ─────────── art set by hand ─────────── */

export class ArtError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
/** the largest image the admin can set: an upload, or what a link gives */
export const ART_MAX_BYTES = 15 * 1024 * 1024;
export type ArtType = "image/png" | "image/jpeg" | "image/webp";
export interface ArtImage { bytes: Uint8Array; type: ArtType }
const ART_EXT: Record<ArtType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const CUSTOM_DIR = () => join(ART_DIR(), "custom");
/** the only names stored here: game-<id>-<kind>.<ext>; anything else a row says is not served */
const CUSTOM_NAME = /^game-(\d+)-(poster|banner|hero|logo)\.(png|jpg|webp)$/;
const mediaType = (h: string | null | undefined) => { const t = (h ?? "").split(";")[0].trim().toLowerCase(); return t === "image/jpg" ? "image/jpeg" : t; };
const isArtType = (t: string): t is ArtType => t in ART_EXT;

/** what the bytes are by their own signature — a declared type is never taken on faith (an SVG could carry script) */
export function sniffImage(b: Uint8Array): ArtType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
function checkImage(bytes: Uint8Array): ArtImage {
  const type = sniffImage(bytes);
  if (!type) throw new ArtError("that is not a PNG, JPEG or WebP image");
  return { bytes, type };
}
/** a body read whole, refused past 15 MB (its declared length first, then counted while it streams in) */
async function readArtBytes(res: Response): Promise<Uint8Array> {
  try { return await readCapped(res, ART_MAX_BYTES); }
  catch (e) { if (e instanceof PublicUrlError) throw new ArtError(`the image is ${e.message}`, 413); throw e; }
}

/** an uploaded image: a PNG, JPEG or WebP body (sent as that type, or as plain bytes — the bytes decide), at most 15 MB */
export async function readImageBody(req: Request): Promise<ArtImage> {
  const declared = mediaType(req.headers.get("content-type"));
  if (!isArtType(declared) && declared !== "application/octet-stream") throw new ArtError("send the image as image/png, image/jpeg or image/webp, or JSON {url}", 415);
  const len = req.headers.get("content-length");
  return checkImage(await readArtBytes(new Response(req.body, len ? { headers: { "content-length": len } } : undefined)));
}

/** an image behind a link the admin typed: https only, fetched once from a public address (each redirect checked too) */
export async function fetchArtUrl(raw: string): Promise<ArtImage> {
  let res: Response;
  try { res = await publicFetch(String(raw ?? "").trim(), { headers: UA, signal: AbortSignal.timeout(30_000) }); }
  catch (e) {
    if (e instanceof PublicUrlError) throw new ArtError(`that link is refused: ${e.message}`);
    throw new ArtError(`that link could not be fetched: ${(e as Error)?.message ?? e}`, 502);
  }
  const declared = mediaType(res.headers.get("content-type"));
  if (!res.ok || !isArtType(declared)) {
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
    throw new ArtError(!res.ok ? `that link answered HTTP ${res.status}` : `that link is not a PNG, JPEG or WebP image (it says ${declared || "nothing"})`);
  }
  return checkImage(await readArtBytes(res));
}

function writeArtJson(gameId: number, change: (o: Record<string, unknown>) => void) {
  const g = stmts.gameById.get(gameId) as GameRow | undefined;
  if (!g) return;
  let o: Record<string, unknown> = {};
  try { const v = JSON.parse(g.art_json ?? "{}"); if (v && typeof v === "object" && !Array.isArray(v)) o = v; } catch { /* start over */ }
  change(o);
  o.at = adeps.now();                                  // a new cache key for whoever keeps copies of this art
  db.query("UPDATE games SET art_json=?, updated_at=unixepoch() WHERE id=?").run(JSON.stringify(o), gameId);
}
async function removeKind(gameId: number, kind: ArtKind, keep?: string) {
  for (const ext of Object.values(ART_EXT)) {
    const f = `game-${gameId}-${kind}.${ext}`;
    if (f !== keep) await rm(join(CUSTOM_DIR(), f), { force: true });
  }
}

/** keep an image as the game's own art of that kind: written beside the old one, then swapped in */
export async function storeCustomArt(gameId: number, kind: ArtKind, img: ArtImage): Promise<void> {
  const dir = CUSTOM_DIR();
  await mkdir(dir, { recursive: true });
  const file = `game-${gameId}-${kind}.${ART_EXT[img.type]}`;
  const tmp = join(dir, `.incoming-${randomUUID()}`);
  try { await Bun.write(tmp, img.bytes); await rename(tmp, join(dir, file)); }
  catch (e) { await rm(tmp, { force: true }); throw e; }
  await removeKind(gameId, kind, file);
  writeArtJson(gameId, o => { o[kind] = `upload:${file}`; });
}
/** back to automatic art for that kind */
export async function clearCustomArt(gameId: number, kind: ArtKind): Promise<void> {
  await removeKind(gameId, kind);
  writeArtJson(gameId, o => { delete o[kind]; });
}
/** a deleted game's own art goes with it */
export async function removeCustomArtFiles(gameId: number): Promise<void> {
  for (const kind of ART_KINDS) await removeKind(gameId, kind);
}
/** the file behind a game's own art of that kind, when it has one */
export async function customArtFile(g: GameRow, kind: ArtKind): Promise<CachedImage | null> {
  const f = customArtOf(g).files[kind];
  const m = f ? CUSTOM_NAME.exec(f) : null;
  if (!m || Number(m[1]) !== g.id || m[2] !== kind) return null;
  const p = join(CUSTOM_DIR(), f!);
  return (await stat(p).then(s => s.isFile() && s.size > 0, () => false)) ? { path: p, type: TYPE[m[3]] } : null;
}

/** housekeeping: how big the cache is */
export async function artCacheStats(): Promise<{ files: number; bytes: number }> {
  const dir = ART_DIR();
  let files = 0, bytes = 0;
  for (const f of await readdir(dir).catch(() => [] as string[])) { const s = await stat(join(dir, f)).catch(() => null); if (s?.isFile()) { files++; bytes += s.size; } }
  return { files, bytes };
}
