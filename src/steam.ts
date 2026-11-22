/**
 * ludarr — Steam catalog provider (primary, ZERO credentials).
 *
 * Public, keyless endpoints:
 *   search:  GET https://store.steampowered.com/api/storesearch/?term=&cc=&l=
 *   details: GET https://store.steampowered.com/api/appdetails?appids=&cc=&l=
 *
 * Covers virtually the entire PC catalogue — the exact population ahoy serves —
 * with official art, screenshots, genres, metacritic, dev/publisher.
 * Politeness: sequential + small delay; Steam throttles abusive bursts only.
 */

const STORE_HOST = "https://store.steampowered.com";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`STEAM_HTTP_${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

export interface SteamSearchHit {
  appId: number;
  name: string;
  tinyImage: string;
  metascore: string | null;
  priceUsd: number | null; // cents, 0 = free
}

export async function steamSearch(term: string, cc = "us", l = "en"): Promise<SteamSearchHit[]> {
  const q = term.trim();
  if (!q) return [];
  const url = `${STORE_HOST}/api/storesearch/?term=${encodeURIComponent(q)}&cc=${cc}&l=${l}`;
  const j = await getJson<{ total: number; items: any[] }>(url);
  return j.items.map(it => ({
    appId: it.id,
    name: it.name,
    tinyImage: it.tiny_image,
    metascore: it.metascore ?? null,
    priceUsd: typeof it.price === "object" && it.price?.final != null ? it.price.final : null,
  }));
}

export interface SteamAppDetails {
  type: string;
  name: string;
  steam_appid: number;
  short_description?: string;
  about_the_game?: string;
  header_image?: string;
  capsule_image?: string;
  screenshots?: { id: number; path_full: string; path_thumbnail: string }[];
  movies?: { id: number; name: string; thumbnail: string; highlight?: boolean; webm?: Record<string, string>; mp4?: Record<string, string>; hls_h264?: string; dash_h264?: string; dash_av1?: string }[];
  genres?: { id: string; description: string }[];
  categories?: { id: number; description: string }[];
  release_date?: { coming_soon: boolean; date: string };
  developers?: string[];
  publishers?: string[];
  platforms?: { windows: boolean; mac: boolean; linux: boolean };
  metacritic?: { score: number };
  is_free?: boolean;
}

export async function steamDetails(appId: number, cc = "us", l = "en"): Promise<SteamAppDetails | null> {
  const url = `${STORE_HOST}/api/appdetails?appids=${appId}&cc=${cc}&l=${l}`;
  // appdetails occasionally hiccup/throttles under bursts — one polite retry
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const j = await getJson<Record<string, { success: boolean; data?: SteamAppDetails }>>(url);
      const entry = j[String(appId)];
      if (entry?.success && entry.data) return entry.data;
    } catch { /* fall through to retry */ }
    if (attempt === 0) await sleep(800);
  }
  return null;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);

const htmlStrip = (s: string) =>
  s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').trim();

/** appdetails payload → games-table row (shape-compatible with igdbToGameRow). */
export function steamToGameRow(d: SteamAppDetails) {
  const platforms = Object.entries(d.platforms ?? {}).filter(([, on]) => on)
    .map(([k]) => ({ windows: "win", mac: "mac", linux: "lin" } as const)[k as "windows"] ?? k);
  const year = d.release_date?.date && !d.release_date?.coming_soon
    ? new Date(d.release_date.date.replace(/(\d)(st|nd|rd|th)\b/i, "$1")).getUTCFullYear()
    : null;
  return {
    igdb_id: null,
    steam_appid: d.steam_appid,
    name: d.name,
    slug: slugify(d.name),
    summary: d.short_description ?? null,
    storyline: d.about_the_game ? htmlStrip(d.about_the_game) : null,
    release_year: Number.isFinite(year as number) ? year : null,
    first_release_date: null,
    rating: d.metacritic?.score ?? null,
    cover_url: d.header_image ?? d.capsule_image ?? null,
    banner_url: d.header_image ?? null,
    screenshots_json: JSON.stringify((d.screenshots ?? []).map(s => s.path_full)),
    genres_json: JSON.stringify((d.genres ?? []).map(g => g.description)),
    themes_json: JSON.stringify([]),
    platforms_json: JSON.stringify(platforms),
    game_modes_json: JSON.stringify([]),
    developer: (d.developers ?? []).join(", ") || null,
    publisher: (d.publishers ?? []).join(", ") || null,
    coming_soon: d.release_date?.coming_soon ? 1 : 0,
    release_text: d.release_date?.date || null,
    release_iso: steamReleaseIso(d.release_date?.date),
  };
}

/** "Oct 15, 2026" / "15 Oct, 2026" → "2026-10-15"; anything less precise → null */
export function steamReleaseIso(text: string | null | undefined): string | null {
  const t = (text ?? "").trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const m = /^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4})$/.exec(t) ?? /^(\d{1,2}) ([A-Za-z]{3})[a-z]*,? (\d{4})$/.exec(t);
  if (!m) return null;
  const mon = months.indexOf((/^\d/.test(m[1]) ? m[2] : m[1]).toLowerCase());
  const day = Number(/^\d/.test(m[1]) ? m[1] : m[2]);
  if (mon < 0 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Sequential onboard helper — keeps us well inside Steam's politeness envelope. */
export async function steamDetailsMany(appIds: number[], delayMs = 300): Promise<(SteamAppDetails | null)[]> {
  const out: (SteamAppDetails | null)[] = [];
  for (const id of appIds) {
    try { out.push(await steamDetails(id)); } catch { out.push(null); }
    if (delayMs) await sleep(delayMs);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Art. Steam's store API (keyless) lists every asset an app has, with the hashed paths newer apps use:
 *   library_capsule(_2x)  → portrait BOX ART, 600x900   (posters)
 *   library_hero(_2x)     → wide hero                   (detail heroes)
 *   main_capsule(_2x)     → 616x353 card                (row cards)
 * One call covers many apps. When the API has nothing (delisted apps), the legacy CDN paths are
 * HEAD-probed, and the store header is the last resort — a wide image, never used as a poster.
 ------------------------------------------------------------------------- */
const CDN_BASES = ["https://cdn.cloudflare.steamstatic.com", "https://shared.akamai.steamstatic.com"];
const ASSET_BASE = "https://shared.akamai.steamstatic.com/store_item_assets/";

export interface AppArt {
  portrait: string | null;   // box art (null when Steam has none — the header is not one)
  hero: string;              // wide hero (may be header fallback)
  cardWide: string;          // 616x353 capsule (header fallback)
}

export interface SteamAssets { asset_url_format?: string; library_capsule?: string; library_capsule_2x?: string; library_hero?: string; library_hero_2x?: string; main_capsule?: string; main_capsule_2x?: string; header?: string; header_2x?: string }

/** GetItems' asset table → full URLs; the format is "steam/apps/<id>/${FILENAME}?t=…" and each asset carries its hash */
export function assetsToArt(assets: SteamAssets, fallbackHeader?: string | null): AppArt | null {
  const fmt = assets.asset_url_format;
  if (!fmt) return null;
  const url = (file?: string) => (file ? ASSET_BASE + fmt.replace("${FILENAME}", file) : null);
  const header = url(assets.header_2x ?? assets.header) ?? fallbackHeader ?? null;
  const hero = url(assets.library_hero_2x ?? assets.library_hero) ?? header;
  const card = url(assets.main_capsule_2x ?? assets.main_capsule) ?? header;
  if (!hero || !card) return null;
  return { portrait: url(assets.library_capsule_2x ?? assets.library_capsule), hero, cardWide: card };
}

/** the asset tables of many apps in one call (≤ 50 per request); apps the store does not know are left out */
export async function steamAssets(appIds: number[]): Promise<Map<number, SteamAssets>> {
  const out = new Map<number, SteamAssets>();
  for (let i = 0; i < appIds.length; i += 50) {
    const batch = appIds.slice(i, i + 50);
    const input = JSON.stringify({ ids: batch.map(appid => ({ appid })), context: { language: "english", country_code: "US" }, data_request: { include_assets: true } });
    const j = await getJson<{ response?: { store_items?: { appid?: number; assets?: SteamAssets }[] } }>(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(input)}`);
    for (const it of j.response?.store_items ?? []) if (it.appid && it.assets?.asset_url_format) out.set(it.appid, it.assets);
  }
  return out;
}

const artMemo = new Map<number, AppArt>();
const allFallback = new Set<number>();   // apps where everything failed — worth another look when the caller can hand us the store's header

async function legacyArt(appId: number, fallbackHeader?: string | null): Promise<AppArt> {
  const head = async (path: string): Promise<boolean> => {
    for (const base of CDN_BASES) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 4000);
        const r = await fetch(base + path, { method: "HEAD", signal: ac.signal });
        clearTimeout(t);
        if (r.ok) return true;
      } catch { /* next base */ }
    }
    return false;
  };
  const [p2x, p600, hero, cap] = await Promise.all([
    head(`/steam/apps/${appId}/library_600x900_2x.jpg`),
    head(`/steam/apps/${appId}/library_600x900.jpg`),
    head(`/steam/apps/${appId}/library_hero.jpg`),
    head(`/steam/apps/${appId}/capsule_616x353.jpg`),
  ]);
  const header = fallbackHeader || `${CDN_BASES[0]}/steam/apps/${appId}/header.jpg`;
  if (!p2x && !p600 && !hero && !cap) allFallback.add(appId); else allFallback.delete(appId);
  return {
    portrait: p2x ? `${CDN_BASES[0]}/steam/apps/${appId}/library_600x900_2x.jpg` : p600 ? `${CDN_BASES[0]}/steam/apps/${appId}/library_600x900.jpg` : null,
    hero: hero ? `${CDN_BASES[0]}/steam/apps/${appId}/library_hero.jpg` : header,
    cardWide: cap ? `${CDN_BASES[0]}/steam/apps/${appId}/capsule_616x353.jpg` : header,
  };
}

/** the art of many apps, one store call per 50 — fills the memo `steamArt` reads */
export async function steamArtMany(appIds: number[], headers: Map<number, string | null> = new Map()): Promise<Map<number, AppArt>> {
  const want = [...new Set(appIds)].filter(id => !artMemo.has(id) || allFallback.has(id));
  let assets = new Map<number, SteamAssets>();
  try { assets = await steamAssets(want); } catch { /* every app falls back to the legacy probe below */ }
  for (const id of want) {
    const a = assets.get(id);
    const art = (a && assetsToArt(a, headers.get(id))) ?? await legacyArt(id, headers.get(id));
    if (a) allFallback.delete(id);
    artMemo.set(id, art);
  }
  return new Map(appIds.map(id => [id, artMemo.get(id)!]));
}

/**
 * `fallbackHeader` is the store's own header_image (hashed path) — the only art that exists for titles
 * the store API does not list, where every guessed CDN path 404s.
 */
export async function steamArt(appId: number, fallbackHeader?: string | null): Promise<AppArt> {
  const memo = artMemo.get(appId);
  if (memo && !(fallbackHeader && allFallback.has(appId))) return memo;   // a dead-CDN memo is retried once a real header is known
  return (await steamArtMany([appId], new Map([[appId, fallbackHeader ?? null]]))).get(appId)!;
}
