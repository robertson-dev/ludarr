/**
 * ludarr — discovery: what is coming, what is new, what sells — from Steam's keyless store feeds.
 *
 *   feeds    GET store.steampowered.com/search/results/?filter=<f>&json=1   → HTML rows inside JSON
 *            popularcomingsoon = the store's "Popular Upcoming" tab (wishlist-weighted), popularnew =
 *            "New & Trending", topsellers = "Top Sellers". category1=998 keeps it to games.
 *   catalog  per-app details (appdetails) cached in the `catalog` table and refreshed slowly in the
 *            background, so the API answers instantly and Steam is never hammered.
 *   follows  "Track" a game that is not out yet; the worker requests it the day it releases.
 */
import { stmts, db, serializeGame, type GameRow, type RequestRow } from "./db";
import { kv } from "./db";
import { cfgNum } from "./config";
import { events } from "./events";
import { steamArtMany, steamDetails, type AppArt, type SteamAppDetails } from "./steam";
import { onboardSteamApps } from "./onboard";
import { createRequest } from "./requests";
import { logger } from "./log";
const dlog = logger("Discover");

/* ─────────────────────── release dates ─────────────────────── */

export type DatePrecision = "day" | "month" | "quarter" | "year" | "tba";
export interface ReleaseInfo { text: string; iso: string | null; sort: string | null; precision: DatePrecision }

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** "Oct 15, 2026" · "15 Oct, 2026" · "October 2026" · "Q4 2026" · "2026" · "Coming soon" → when, and how precisely */
export function parseReleaseText(raw: string | null | undefined): ReleaseInfo {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const t = text.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  let m: RegExpExecArray | null;
  if ((m = /^([a-z]{3})[a-z]* (\d{1,2}),? (\d{4})$/.exec(t)) || (m = /^(\d{1,2}) ([a-z]{3})[a-z]*,? (\d{4})$/.exec(t))) {
    const monthStr = /^\d/.test(m[1]) ? m[2] : m[1];
    const day = Number(/^\d/.test(m[1]) ? m[1] : m[2]);
    const mi = MONTHS.indexOf(monthStr.slice(0, 3));
    const y = Number(m[3]);
    if (mi >= 0 && day >= 1 && day <= 31) { const iso = `${y}-${pad(mi + 1)}-${pad(day)}`; return { text, iso, sort: iso, precision: "day" }; }
  }
  if ((m = /^([a-z]{3})[a-z]* (\d{4})$/.exec(t))) {
    const mi = MONTHS.indexOf(m[1]); const y = Number(m[2]);
    if (mi >= 0) return { text, iso: null, sort: `${y}-${pad(mi + 1)}-${pad(lastDay(y, mi + 1))}`, precision: "month" };
  }
  if ((m = /^q([1-4]) (\d{4})$/.exec(t))) {
    const q = Number(m[1]), y = Number(m[2]); const mm = q * 3;
    return { text, iso: null, sort: `${y}-${pad(mm)}-${pad(lastDay(y, mm))}`, precision: "quarter" };
  }
  if ((m = /^(early|spring|mid|summer|fall|autumn|late|winter|holiday) (\d{4})$/.exec(t))) {
    const y = Number(m[2]); const mm = { early: 4, spring: 5, mid: 7, summer: 8, fall: 11, autumn: 11, late: 12, winter: 12, holiday: 12 }[m[1]] ?? 12;
    return { text, iso: null, sort: `${y}-${pad(mm)}-${pad(lastDay(y, mm))}`, precision: "quarter" };
  }
  if ((m = /^(\d{4})$/.exec(t))) return { text, iso: null, sort: `${m[1]}-12-31`, precision: "year" };
  return { text, iso: null, sort: null, precision: "tba" };
}

export const daysUntil = (iso: string | null, now = Date.now()) =>
  iso ? Math.ceil((Date.parse(iso + "T00:00:00Z") - now) / 86_400_000) : null;

/* ─────────────────────── feed parsing ─────────────────────── */

export type Feed = "popularcomingsoon" | "popularnew" | "topsellers";
export interface FeedRow {
  appId: number; name: string; releaseText: string; reviewSummary: string | null; reviewPct: number | null; reviewCount: number | null;
  capsule: string | null; tagIds: number[]; free: boolean;
}

const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function parseFeedHtml(html: string): FeedRow[] {
  const out: FeedRow[] = [];
  const seen = new Set<number>();
  for (const m of html.matchAll(/<a href="[^"]*"[^>]*data-ds-appid="(\d+)"([^>]*)>([\s\S]*?)<\/a>/g)) {
    const appId = Number(m[1]);
    if (seen.has(appId)) continue;
    seen.add(appId);
    const attrs = m[2], body = m[3];
    const name = unescapeHtml(/<span class="title">([^<]*)<\/span>/.exec(body)?.[1] ?? "").trim();
    if (!name) continue;
    const releaseText = (/search_released[^>]*>\s*([^<]*?)\s*</.exec(body)?.[1] ?? "").trim();
    const tip = /search_review_summary[^>]*data-tooltip-html="([^"]*)"/.exec(body)?.[1];
    let reviewSummary: string | null = null, reviewPct: number | null = null, reviewCount: number | null = null;
    if (tip) {
      const plain = unescapeHtml(tip).replace(/<br\s*\/?>/gi, "\n");
      reviewSummary = plain.split("\n")[0].trim() || null;
      const pm = /(\d+)% of the ([\d,]+) user reviews/.exec(plain);
      if (pm) { reviewPct = Number(pm[1]); reviewCount = Number(pm[2].replace(/,/g, "")); }
    }
    const capsule = /<img[^>]+src="([^"]+)"/.exec(body)?.[1] ?? null;
    let tagIds: number[] = [];
    try { tagIds = JSON.parse(/data-ds-tagids="(\[[^"]*\])"/.exec(attrs)?.[1] ?? "[]"); } catch { /* ignore */ }
    const free = /data-price-final="0"/.test(body);
    out.push({ appId, name, releaseText, reviewSummary, reviewPct, reviewCount, capsule, tagIds, free });
  }
  return out;
}

const SIMILAR_URL = (appId: number) => `https://store.steampowered.com/recommended/morelike/app/${appId}/?cc=us&l=en`;
const FEED_URL = (f: Feed, count: number, tags?: number) =>
  `https://store.steampowered.com/search/results/?filter=${f}&infinite=1&count=${count}&json=1&cc=us&l=en&category1=998&os=win&ndl=1${tags ? `&tags=${tags}` : ""}`;

export const ddeps = {
  fetchFeed: async (f: Feed, count: number, tags?: number): Promise<string> => {
    const res = await fetch(FEED_URL(f, count, tags), { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36", Accept: "application/json" }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`STEAM_FEED_${res.status}`);
    return ((await res.json()) as { results_html?: string }).results_html ?? "";
  },
  fetchSimilar: async (appId: number): Promise<string> => {
    const res = await fetch(SIMILAR_URL(appId), { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36", Accept: "text/html", Cookie: "birthtime=0; wants_mature_content=1" }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`STEAM_SIMILAR_${res.status}`);
    return res.text();
  },
  details: steamDetails,
  createRequest,
  onboard: onboardSteamApps,
  art: steamArtMany as (ids: number[]) => Promise<Map<number, AppArt>>,
  now: () => Date.now(),
  log: (...a: unknown[]) => dlog.log(...a),
};

const FEED_TTL_MS = () => cfgNum("DISCOVER_REFRESH_MIN", 60) * 60_000;
const feedKey = (f: Feed, tags?: number) => `discover.feed.${f}${tags ? `.tag${tags}` : ""}`;

/** cached feed rows; refreshed when stale (or forced). Never throws when a stale copy exists. */
export async function feedRows(f: Feed, count = 50, force = false, tags?: number): Promise<{ rows: FeedRow[]; at: number; stale: boolean }> {
  let cached: { at: number; rows: FeedRow[] } | null = null;
  try { cached = JSON.parse(kv.get(feedKey(f, tags)) ?? "null"); } catch { /* ignore */ }
  const fresh = cached && ddeps.now() - cached.at < FEED_TTL_MS();
  if (fresh && !force) return { rows: cached!.rows, at: cached!.at, stale: false };
  try {
    const rows = parseFeedHtml(await ddeps.fetchFeed(f, count, tags));
    if (rows.length) { kv.set(feedKey(f, tags), JSON.stringify({ at: ddeps.now(), rows })); return { rows, at: ddeps.now(), stale: false }; }
  } catch (e: any) { ddeps.log(`feed ${f} failed: ${e?.message ?? e}`); }
  return cached ? { rows: cached.rows, at: cached.at, stale: true } : { rows: [], at: 0, stale: true };
}

/* ─────────────────────── catalog (per-app details cache) ─────────────────────── */

export interface CatalogRow {
  steam_appid: number; name: string; type: string | null; coming_soon: number; release_text: string | null; release_iso: string | null;
  release_sort: string | null; genres_json: string; short_description: string | null; metacritic: number | null; header_image: string | null; drm?: string | null; crack_status?: string | null; crack_date?: string | null; crack_group?: string | null;
  updated_at: number;
}

export function catalogUpsertFromDetails(d: SteamAppDetails): CatalogRow {
  const rel = parseReleaseText(d.release_date?.date);
  const comingSoon = d.release_date?.coming_soon ? 1 : 0;
  stmts.catalogUpsert.run(
    d.steam_appid, d.name, d.type ?? null, comingSoon, rel.text || null, rel.iso, rel.sort,
    JSON.stringify((d.genres ?? []).map(g => g.description)), d.short_description ?? null, d.metacritic?.score ?? null, d.header_image ?? null,
  );
  return stmts.catalogGet.get(d.steam_appid) as CatalogRow;
}

const CATALOG_TTL_SEC = 24 * 3600;

/** refresh details for apps whose cache is missing or old — sequential and polite, a handful per call */
export async function enrichCatalog(appIds: number[], max = 12, delayMs = 350): Promise<number> {
  const now = Math.floor(ddeps.now() / 1000);
  let done = 0;
  for (const id of appIds) {
    if (done >= max) break;
    const row = stmts.catalogGet.get(id) as CatalogRow | undefined;
    if (row && now - row.updated_at < CATALOG_TTL_SEC) continue;
    try {
      const d = await ddeps.details(id);
      if (d) catalogUpsertFromDetails(d);
      else stmts.catalogTouch.run(id, `app ${id}`);            // not on the store any more: remember we looked
    } catch (e: any) { ddeps.log(`details ${id}: ${e?.message ?? e}`); }
    done++;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return done;
}

/* ─────────────────────── the discovery view ─────────────────────── */

export interface DiscoverItem {
  appId: number; name: string; img: string; portrait: string | null;   // img: the wide header (cards); portrait: the 600x900 library capsule, when Steam has one
  drm: string | null; crackStatus: string | null; crackDate: string | null; crackGroup: string | null;   // from CrackWatch, when the feed entry is tracked there
  releaseText: string | null; releaseIso: string | null; releaseSort: string | null; daysUntil: number | null; comingSoon: boolean;
  reviewSummary: string | null; reviewPct: number | null; reviewCount: number | null; metacritic: number | null;
  genres: string[]; summary: string | null; free: boolean;
  inLibrary: boolean; gameId: number | null; followed: boolean; requestState: string | null;
}
export interface DiscoverSection { key: string; title: string; sub: string; items: DiscoverItem[]; updatedAt: number; stale: boolean }

/** the header from appdetails (hashed path, exists for every app) beats the feed's small capsule; never guess CDN paths */
const bestArt = (r: FeedRow, cat: CatalogRow | undefined) => cat?.header_image ?? r.capsule ?? "";

export function toItem(r: FeedRow, cat: CatalogRow | undefined, lib: Map<number, GameRow>, follows: Set<number>, reqState: Map<number, string>): DiscoverItem {
  const rel = cat?.release_text != null ? { text: cat.release_text, iso: cat.release_iso, sort: cat.release_sort } : (() => { const p = parseReleaseText(r.releaseText); return { text: p.text || null, iso: p.iso, sort: p.sort }; })();
  const game = lib.get(r.appId);
  const comingSoon = cat ? cat.coming_soon === 1 : !!(rel.sort && rel.sort >= new Date(ddeps.now()).toISOString().slice(0, 10)) || /coming soon|tba|to be announced/i.test(rel.text ?? "");
  return {
    appId: r.appId, name: cat?.name ?? r.name,
    img: bestArt(r, cat), portrait: null,
    drm: cat?.drm ?? null, crackStatus: cat?.crack_status ?? null, crackDate: cat?.crack_date ?? null, crackGroup: cat?.crack_group ?? null,
    releaseText: rel.text, releaseIso: rel.iso, releaseSort: rel.sort, daysUntil: daysUntil(rel.iso, ddeps.now()), comingSoon,
    reviewSummary: r.reviewSummary, reviewPct: r.reviewPct, reviewCount: r.reviewCount, metacritic: cat?.metacritic ?? null,
    genres: cat ? JSON.parse(cat.genres_json || "[]") : [], summary: cat?.short_description ?? null, free: r.free,
    inLibrary: !!game, gameId: game?.id ?? null, followed: game ? follows.has(game.id) : false, requestState: game ? reqState.get(game.id) ?? null : null,
  };
}

const isoDaysAgo = (days: number) => new Date(ddeps.now() - days * 86_400_000).toISOString().slice(0, 10);

const SECTIONS: { key: string; feed: Feed; title: string; sub: string; limit: number; keep?: (i: DiscoverItem) => boolean }[] = [
  { key: "coming_soon", feed: "popularcomingsoon", title: "COMING SOON", sub: "most wanted on the storefront · track one and the ship fetches it on release day", limit: 24,
    keep: i => i.releaseSort == null || i.releaseSort >= isoDaysAgo(1) },                 // released yesterday still counts as "out now"
  { key: "new", feed: "popularnew", title: "NEW & TRENDING", sub: "out in the last three months and climbing", limit: 24,
    keep: i => i.releaseSort != null && i.releaseSort >= isoDaysAgo(90) && i.releaseSort <= isoDaysAgo(-1) },
  { key: "top", feed: "topsellers", title: "TOP SELLERS", sub: "what everyone is playing", limit: 24 },
];

let lastEagerEnrich = 0;

export async function discover(): Promise<{ sections: DiscoverSection[] }> {
  const lib = new Map((stmts.allGames.all() as GameRow[]).filter(g => g.steam_appid != null).map(g => [g.steam_appid!, g] as [number, GameRow]));
  const follows = new Set((stmts.followsAll.all() as { game_id: number }[]).map(f => f.game_id));
  const reqState = new Map<number, string>();
  for (const r of (stmts.requestsAll.all() as RequestRow[]).slice().reverse()) reqState.set(r.game_id, r.state);
  const sections: DiscoverSection[] = [];
  for (const s of SECTIONS) {
    const { rows, at, stale } = await feedRows(s.feed, 50);
    const items = rows
      .map(r => toItem(r, stmts.catalogGet.get(r.appId) as CatalogRow | undefined, lib, follows, reqState))
      .filter(i => !/\b(demo|playtest|soundtrack|dlc|server|dedicated)\b/i.test(i.name))
      .filter(i => !s.keep || s.keep(i))
      .slice(0, s.limit);
    if (s.key === "coming_soon") items.sort((a, b) => (a.releaseSort ?? "9999").localeCompare(b.releaseSort ?? "9999"));
    sections.push({ key: s.key, title: s.title, sub: s.sub, items, updatedAt: at, stale });
  }
  // posters: the store lists every app's library capsule in one call per 50 (memoized), never a header cropped to 2:3
  try {
    const arts = await ddeps.art([...new Set(sections.flatMap(s => s.items.map(i => i.appId)))]);
    for (const s of sections) for (const i of s.items) i.portrait = arts.get(i.appId)?.portrait ?? null;
  } catch (e: any) { ddeps.log(`posters: ${e?.message ?? e}`); }
  // details missing for what is on screen? fill them in the background, at most every couple of minutes
  const missing = sections.flatMap(s => s.items).filter(i => !stmts.catalogGet.get(i.appId)).map(i => i.appId);
  if (missing.length && ddeps.now() - lastEagerEnrich > 120_000) {
    lastEagerEnrich = ddeps.now();
    void enrichCatalog([...new Set(missing)], 40).catch(() => {});
  }
  return { sections };
}

/** background: keep feeds warm and details filled for what the rows show */
let ticks = 0;
export async function discoverTick(): Promise<void> {
  const ids: number[] = [];
  for (const s of SECTIONS) ids.push(...(await feedRows(s.feed, 50)).rows.slice(0, s.limit).map(r => r.appId));
  const n = await enrichCatalog([...new Set(ids)], ticks++ === 0 ? 60 : 12);     // first pass fills the rows, later passes keep them fresh
  if (n) ddeps.log(`catalog: refreshed ${n} app(s)`);
  await ddeps.art([...new Set(ids)]).catch(() => {});                              // warm the posters the rows will ask for
}

/* ─────────────────────── follows ("Track") ─────────────────────── */

export interface FollowRow { id: number; game_id: number; auto_request: number; release_iso: string | null; release_text: string | null; coming_soon: number; checked_at: number | null; requested_at: number | null; request_id: number | null; created_at: number; game_name?: string; cover_url?: string | null; steam_appid?: number | null }

export function serializeFollow(f: FollowRow) {
  return {
    id: f.id, gameId: f.game_id, gameName: f.game_name ?? null, coverUrl: f.cover_url ?? null, steamAppId: f.steam_appid ?? null,
    autoRequest: !!f.auto_request, releaseIso: f.release_iso, releaseText: f.release_text, daysUntil: daysUntil(f.release_iso, ddeps.now()),
    comingSoon: !!f.coming_soon, checkedAt: f.checked_at, requestedAt: f.requested_at, requestId: f.request_id, createdAt: f.created_at,
  };
}

export class FollowError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

/** a game without a Steam id carries its own date (set by hand, or taken from the catalog): out once that day has come,
 *  and with no date at all it is coming only when its row says so */
function ownDate(game: GameRow, today: string): { iso: string | null; text: string | null; comingSoon: boolean } {
  const iso = game.release_iso ?? null;
  return { iso, text: game.release_text ?? iso, comingSoon: iso ? iso > today : game.coming_soon === 1 };
}

export async function follow(opt: { gameId?: number; appId?: number }): Promise<{ follow: ReturnType<typeof serializeFollow>; game: ReturnType<typeof serializeGame>; duplicate: boolean }> {
  let game: GameRow | undefined;
  if (opt.gameId != null) game = stmts.gameById.get(opt.gameId) as GameRow | undefined;
  else if (opt.appId != null) {
    game = stmts.gameBySteam.get(opt.appId) as GameRow | undefined;
    if (!game) { const r = await ddeps.onboard([opt.appId]); game = r.saved[0]; }
  }
  if (!game) throw new FollowError("gameId or appId required — and the game must exist", opt.gameId != null ? 404 : 400);
  const existing = stmts.followByGame.get(game.id) as FollowRow | undefined;
  if (existing) return { follow: serializeFollow(stmts.followById.get(existing.id) as FollowRow), game: serializeGame(game), duplicate: true };
  let rel: ReleaseInfo = { text: "", iso: null, sort: null, precision: "tba" }, comingSoon = 1;
  if (game.steam_appid != null) {
    const cat = stmts.catalogGet.get(game.steam_appid) as CatalogRow | undefined;
    const d = cat && ddeps.now() / 1000 - cat.updated_at < CATALOG_TTL_SEC ? null : await ddeps.details(game.steam_appid).catch(() => null);
    const c = d ? catalogUpsertFromDetails(d) : cat;
    if (c) { rel = { text: c.release_text ?? "", iso: c.release_iso, sort: c.release_sort, precision: "day" }; comingSoon = c.coming_soon; }
  } else {
    const own = ownDate(game, new Date(ddeps.now()).toISOString().slice(0, 10));
    rel = { text: own.text ?? "", iso: own.iso, sort: own.iso, precision: own.iso ? "day" : "tba" };
    comingSoon = own.comingSoon ? 1 : 0;
  }
  const row = stmts.insertFollow.get(game.id, rel.iso, rel.text || null, comingSoon, Math.floor(ddeps.now() / 1000)) as FollowRow;
  const out = stmts.followById.get(row.id) as FollowRow;
  events.emit("follow" as any, serializeFollow(out));
  ddeps.log(`#${row.id} tracking ${game.name} (${rel.text || "no date"}${comingSoon ? "" : ", already out"})`);
  return { follow: serializeFollow(out), game: serializeGame(game), duplicate: false };
}

export function unfollow(gameId: number) {
  const f = stmts.followByGame.get(gameId) as FollowRow | undefined;
  if (!f) throw new FollowError("not tracking that game", 404);
  stmts.deleteFollow.run(f.id);
  events.emit("follow" as any, { id: f.id, gameId, deleted: true });
}

/** the day a tracked game is out, request it; dates are re-read from Steam every 12h in case they move */
export async function followsTick(): Promise<{ requested: number }> {
  const now = Math.floor(ddeps.now() / 1000);
  const today = new Date(ddeps.now()).toISOString().slice(0, 10);
  let requested = 0;
  for (const f of stmts.followsPending.all() as FollowRow[]) {
    const game = stmts.gameById.get(f.game_id) as GameRow | undefined;
    if (!game) { stmts.deleteFollow.run(f.id); continue; }
    let comingSoon = f.coming_soon === 1, iso = f.release_iso, text = f.release_text;
    const imminent = f.release_iso != null && Math.abs(Date.parse(f.release_iso + "T00:00:00Z") / 1000 - now) < 2 * 86_400;
    const staleAfter = imminent ? 30 * 60 : cfgNum("FOLLOW_CHECK_HOURS", 12) * 3600;
    if (game.steam_appid != null && (!f.checked_at || now - f.checked_at > staleAfter)) {
      const d = await ddeps.details(game.steam_appid).catch(() => null);
      if (d) { const c = catalogUpsertFromDetails(d); comingSoon = c.coming_soon === 1; iso = c.release_iso; text = c.release_text; }
      stmts.setFollowChecked.run(iso, text, comingSoon ? 1 : 0, now, f.id);
      if (iso !== f.release_iso) ddeps.log(`#${f.id} ${game.name}: release date now ${text}`);
    } else if (game.steam_appid == null) {
      // no store to ask: the game's own row is the date, read again every tick (an edit moves the follow with it)
      const own = ownDate(game, today);
      if (own.iso !== f.release_iso || own.text !== f.release_text || (own.comingSoon ? 1 : 0) !== f.coming_soon) {
        stmts.setFollowChecked.run(own.iso, own.text, own.comingSoon ? 1 : 0, now, f.id);
        if (own.iso !== f.release_iso) ddeps.log(`#${f.id} ${game.name}: release date now ${own.text ?? "not set"}`);
      }
      comingSoon = own.comingSoon; iso = own.iso; text = own.text;
    }
    const out = !comingSoon || (iso != null && iso <= today);
    if (!out || !f.auto_request) continue;
    try {
      const { request } = await ddeps.createRequest({ gameId: game.id, by: "tracker" });
      stmts.setFollowRequested.run(now, request.id, f.id);
      requested++;
      events.emit("follow" as any, serializeFollow(stmts.followById.get(f.id) as FollowRow));
      ddeps.log(`#${f.id} ${game.name} is out — requested (#${request.id})`);
    } catch (e: any) { ddeps.log(`#${f.id} ${game.name}: request failed: ${e?.message ?? e}`); }
  }
  return { requested };
}

let timers: ReturnType<typeof setInterval>[] = [];
export function startDiscoverWorker() {
  if (timers.length) return;
  timers.push(setInterval(() => { discoverTick().catch(e => ddeps.log("discover tick:", e?.message ?? e)); }, 10 * 60_000));
  timers.push(setInterval(() => { followsTick().catch(e => ddeps.log("follows tick:", e?.message ?? e)); }, 30 * 60_000));   // cheap: only imminent games hit Steam each time
  setTimeout(() => { discoverTick().catch(() => {}); followsTick().catch(() => {}); }, 5_000);
  ddeps.log("worker up — feeds every 10 min, tracked releases every 30 min (Steam re-read every 12h, every 30 min within two days of release)");
}
export function stopDiscoverWorker() { for (const t of timers) clearInterval(t); timers = []; }

export { db };

/* ─────────────────────── one app, for the Ahoy launcher's game page ─────────────────────── */

/** Steam now serves trailers as HLS / DASH manifests; older apps still carry plain mp4 / webm files */
export interface Trailer { name: string; thumb: string; hls: string | null; mp4: string | null; webm: string | null }
export interface AppDetail extends DiscoverItem {
  developers: string[]; publishers: string[]; about: string | null; screenshots: string[]; trailers: Trailer[];
  hero: string | null; header: string | null; platforms: string[];
}
const https = (u: string | undefined | null) => (u ? u.replace(/^http:/, "https:") : null);
const trailersOf = (d: SteamAppDetails | null | undefined): Trailer[] =>
  (d?.movies ?? []).map(m => ({ name: m.name, thumb: https(m.thumbnail) ?? "", hls: https(m.hls_h264), mp4: https(m.mp4?.max ?? m.mp4?.["480"]), webm: https(m.webm?.max ?? m.webm?.["480"]), highlight: !!m.highlight }))
    .filter(t => t.hls || t.mp4 || t.webm).sort((a, b) => Number(b.highlight) - Number(a.highlight)).map(({ highlight: _h, ...t }) => t);
const detailMemo = new Map<number, { at: number; d: SteamAppDetails | null }>();
const FEEDS_FOR_REVIEWS: Feed[] = ["popularnew", "topsellers", "popularcomingsoon"];

/** everything the launcher shows for a Steam app that may not be in the library yet: details, art, verdict, library state */
export async function appDetail(appId: number): Promise<AppDetail | null> {
  const memo = detailMemo.get(appId);
  let d = memo && ddeps.now() - memo.at < 6 * 3600_000 ? memo.d : undefined;
  if (d === undefined) { d = await ddeps.details(appId).catch(() => null); detailMemo.set(appId, { at: ddeps.now(), d }); }
  const cat = d ? catalogUpsertFromDetails(d) : (stmts.catalogGet.get(appId) as CatalogRow | undefined);
  if (!d && !cat) return null;
  let feed: FeedRow | undefined;                                                   // review numbers come from the cached feeds, when one lists it
  for (const f of FEEDS_FOR_REVIEWS) { feed = (await feedRows(f, 50).catch(() => ({ rows: [] as FeedRow[] }))).rows.find(r => r.appId === appId); if (feed) break; }
  const row: FeedRow = feed ?? { appId, name: d?.name ?? cat!.name, releaseText: d?.release_date?.date ?? cat?.release_text ?? "", reviewSummary: null, reviewPct: null, reviewCount: null, capsule: d?.header_image ?? cat?.header_image ?? null, tagIds: [], free: !!d?.is_free };
  const g = stmts.gameBySteam.get(appId) as GameRow | undefined;
  const lib = new Map<number, GameRow>(); if (g) lib.set(appId, g);
  const follows = new Set((stmts.followsAll.all() as { game_id: number }[]).map(f => f.game_id));
  const reqState = new Map<number, string>();
  if (g) for (const r of stmts.requestsAll.all() as RequestRow[]) if (r.game_id === g.id) reqState.set(g.id, r.state);
  const item = toItem(row, cat, lib, follows, reqState);
  const art = (await ddeps.art([appId]).catch(() => new Map<number, AppArt>())).get(appId);
  return {
    ...item, portrait: art?.portrait ?? item.portrait, free: !!(d?.is_free ?? row.free),
    hero: art?.hero ?? d?.header_image ?? cat?.header_image ?? null, header: d?.header_image ?? cat?.header_image ?? null,
    developers: d?.developers ?? [], publishers: d?.publishers ?? [], about: d?.about_the_game ?? null,
    screenshots: (d?.screenshots ?? []).map(s => https(s.path_full)!), trailers: trailersOf(d), platforms: d?.platforms ? Object.entries(d.platforms).filter(([, v]) => v).map(([k]) => k) : [],
  };
}

/* ─────────────────────── more rows for the launcher: genres, and what just became playable ─────────────────────── */

/** Steam tag ids for the genre rows (the store's own "top sellers" filtered by one tag) */
export const GENRES: { tag: number; label: string }[] = [
  { tag: 19, label: "Action" }, { tag: 21, label: "Adventure" }, { tag: 122, label: "RPG" }, { tag: 9, label: "Strategy" },
  { tag: 599, label: "Simulation" }, { tag: 1695, label: "Open world" }, { tag: 1667, label: "Horror" }, { tag: 1685, label: "Co-op" },
  { tag: 699, label: "Racing" }, { tag: 701, label: "Sports" }, { tag: 1664, label: "Puzzle" }, { tag: 492, label: "Indie" },
];

export function libraryContext() {
  const lib = new Map((stmts.allGames.all() as GameRow[]).filter(g => g.steam_appid != null).map(g => [g.steam_appid!, g] as [number, GameRow]));
  const follows = new Set((stmts.followsAll.all() as { game_id: number }[]).map(f => f.game_id));
  const reqState = new Map<number, string>();
  for (const r of (stmts.requestsAll.all() as RequestRow[]).slice().reverse()) reqState.set(r.game_id, r.state);
  return { lib, follows, reqState };
}
export const JUNK = /\b(demo|playtest|soundtrack|dlc|server|dedicated)\b/i;

export async function withPortraits(items: DiscoverItem[]): Promise<DiscoverItem[]> {
  try {
    const arts = await ddeps.art([...new Set(items.map(i => i.appId))]);
    for (const i of items) i.portrait = arts.get(i.appId)?.portrait ?? null;
  } catch (e: any) { ddeps.log(`posters: ${e?.message ?? e}`); }
  return items;
}

/** one genre: the store's top sellers carrying that tag */
export async function discoverGenre(tag: number, limit = 16): Promise<{ items: DiscoverItem[]; updatedAt: number; stale: boolean }> {
  if (!GENRES.some(g => g.tag === tag)) throw new Error("not one of the genre rows");
  const ctx = libraryContext();
  const { rows, at, stale } = await feedRows("topsellers", 50, false, tag);
  const items = rows.map(r => toItem(r, stmts.catalogGet.get(r.appId) as CatalogRow | undefined, ctx.lib, ctx.follows, ctx.reqState)).filter(i => !JUNK.test(i.name)).slice(0, limit);
  return { items: await withPortraits(items), updatedAt: at, stale };
}

/** games whose protection was broken lately (CrackWatch, through the catalog): the moment a wished-for game becomes gettable */
export async function recentlyPlayable(limit = 16): Promise<{ items: DiscoverItem[] }> {
  const ctx = libraryContext();
  const rows = db.query("SELECT * FROM catalog WHERE crack_status='cracked' AND crack_date IS NOT NULL AND (type IS NULL OR type='game') ORDER BY crack_date DESC, updated_at DESC LIMIT ?").all(limit * 2) as CatalogRow[];
  const items = rows.map(cat => toItem({ appId: cat.steam_appid, name: cat.name, releaseText: cat.release_text ?? "", reviewSummary: null, reviewPct: null, reviewCount: null, capsule: cat.header_image, tagIds: [], free: false }, cat, ctx.lib, ctx.follows, ctx.reqState))
    .filter(i => !JUNK.test(i.name)).slice(0, limit);
  return { items: await withPortraits(items) };
}

/* ─────────────────────── more like this (the store's own "More like this" page, keyless) ─────────────────────── */

/** the capsules of store.steampowered.com/recommended/morelike/app/<id>/ — the name comes from the link until the catalog knows better */
export function parseSimilarHtml(html: string): FeedRow[] {
  const out: FeedRow[] = [];
  const seen = new Set<number>();
  for (const m of html.matchAll(/<a[^>]*class="similar_grid_capsule"([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1], body = m[2];
    const appId = Number(/data-ds-appid="(\d+)"/.exec(attrs)?.[1]);
    if (!appId || seen.has(appId)) continue;
    seen.add(appId);
    const name = decodeURIComponent(/\/app\/\d+\/([^/?"]+)/.exec(attrs)?.[1] ?? "").replace(/_/g, " ").trim() || `app ${appId}`;
    const capsule = /<img[^>]+src="([^"]+)"/.exec(body)?.[1] ?? null;
    let tagIds: number[] = [];
    try { tagIds = JSON.parse(/data-ds-tagids="(\[[^"]*\])"/.exec(attrs)?.[1] ?? "[]"); } catch { /* ignore */ }
    out.push({ appId, name, releaseText: "", reviewSummary: null, reviewPct: null, reviewCount: null, capsule, tagIds, free: false });
  }
  return out;
}

const SIMILAR_TTL_MS = 7 * 86_400_000;
let lastSimilarEnrich = 0;

/** games the store puts next to this one; cached a week, the catalog fills names and dates as it learns them */
export async function similarTo(appId: number, limit = 12): Promise<{ items: DiscoverItem[]; updatedAt: number; stale: boolean }> {
  const key = `discover.similar.${appId}`;
  let cached: { at: number; rows: FeedRow[] } | null = null;
  try { cached = JSON.parse(kv.get(key) ?? "null"); } catch { /* ignore */ }
  let rows = cached?.rows ?? [], at = cached?.at ?? 0, stale = false;
  if (!cached || ddeps.now() - cached.at > SIMILAR_TTL_MS) {
    try {
      const got = parseSimilarHtml(await ddeps.fetchSimilar(appId));
      if (got.length) { rows = got; at = ddeps.now(); kv.set(key, JSON.stringify({ at, rows })); }
      else stale = true;
    } catch (e: any) { ddeps.log(`similar ${appId}: ${e?.message ?? e}`); stale = true; }
  }
  const ctx = libraryContext();
  const items: DiscoverItem[] = [];
  for (const r of rows) {
    if (r.appId === appId) continue;
    const cat = stmts.catalogGet.get(r.appId) as CatalogRow | undefined;
    if (cat?.type && cat.type !== "game") continue;
    const it = toItem(r, cat, ctx.lib, ctx.follows, ctx.reqState);
    if (JUNK.test(it.name)) continue;
    items.push(it);
    if (items.length >= limit) break;
  }
  const missing = items.filter(i => !stmts.catalogGet.get(i.appId)).map(i => i.appId);
  if (missing.length && ddeps.now() - lastSimilarEnrich > 60_000) { lastSimilarEnrich = ddeps.now(); void enrichCatalog(missing, 12).catch(() => {}); }
  return { items: await withPortraits(items), updatedAt: at, stale };
}
