/**
 * ludarr — Metacritic: the best PC games of all time, of each year, and the ones players love.
 *
 *   browse   GET www.metacritic.com/browse/game/pc/all/<year|all-time>/<metascore|userscore>/?platform=pc&page=N
 *            The page is server-rendered: 50 cards with title, date, score and blurb. Lists are cached in kv for a day.
 *   match    Metacritic knows no Steam ids. Every title goes through the store's own search once and the answer is
 *            kept (a miss is retried after a week). A wrong game is worse than no game: the names must agree after
 *            normalising, or the store must confirm the very same Metascore. DLC and expansions fall away when the
 *            catalog learns their type.
 */
import { kv, stmts } from "./db";
import { cfgNum } from "./config";
import { normName } from "./catalog/store";
import { steamSearch, type SteamSearchHit } from "./steam";
import { enrichCatalog, JUNK, libraryContext, toItem, withPortraits, type CatalogRow, type DiscoverItem, type FeedRow } from "./discover";
import { logger } from "./log";
const mlog = logger("Metacritic");

/* ─────────────────────── the lists ─────────────────────── */

export type McList = "all" | "players" | `${number}`;
export interface McListInfo { key: McList; label: string; sub: string }
const FIRST_YEAR = 2008;

export function lists(now = mdeps.now()): McListInfo[] {
  const y = new Date(now).getUTCFullYear();
  const out: McListInfo[] = [
    { key: "all", label: "All time", sub: "the highest Metascores on PC, ever" },
    { key: "players", label: "Players' favourites", sub: "the highest user scores on PC" },
  ];
  for (let i = y; i >= FIRST_YEAR; i--) out.push({ key: `${i}`, label: `${i}`, sub: `the best reviewed games of ${i}` });
  return out;
}
export const isList = (k: string): k is McList => k === "all" || k === "players" || (/^\d{4}$/.test(k) && Number(k) >= FIRST_YEAR && Number(k) <= new Date(mdeps.now()).getUTCFullYear());

export const browseUrl = (key: McList, page = 1) =>
  `https://www.metacritic.com/browse/game/pc/all/${key === "all" || key === "players" ? "all-time" : key}/${key === "players" ? "userscore" : "metascore"}/?platform=pc&page=${page}`;
const PAGES: Record<string, number> = { all: 2 };                                   // 50 a page; two pages of all-time, one of everything else

/* ─────────────────────── parsing ─────────────────────── */

export interface McRow { rank: number; title: string; slug: string; releaseText: string; metascore: number | null; userscore: number | null; summary: string | null; image: string | null }

const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
const text = (s: string | undefined) => (s ? unescapeHtml(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "");

/** the cards of one browse page, in page order */
export function parseBrowseHtml(html: string): McRow[] {
  const out: McRow[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/data-testid="filter-results">([\s\S]*?)<\/a>\s*<\/div>/g)) {
    const card = m[1];
    const slug = /href="\/game\/([a-z0-9-]+)\/?"/.exec(card)?.[1];
    if (!slug || seen.has(slug)) continue;
    const h3 = /data-testid="product-title"[^>]*>([\s\S]*?)<\/h3>/.exec(card)?.[1] ?? "";
    const spans = [...h3.matchAll(/<span>([\s\S]*?)<\/span>/g)].map(s => text(s[1]));
    const rank = Number(/^(\d+)\./.exec(spans[0] ?? "")?.[1] ?? out.length + 1);
    const title = spans.length > 1 ? spans[spans.length - 1] : text(h3).replace(/^\d+\.\s*/, "");
    if (!title) continue;
    seen.add(slug);
    const metaLine = /uppercase mb-1">([\s\S]*?)<\/div>/.exec(card)?.[1] ?? "";
    const releaseText = text(/<span>([^<]*\d{4})<\/span>/.exec(metaLine)?.[1]) || "";
    const metascore = /title="Metascore (\d+) out of 100"/.exec(card)?.[1];
    const userscore = /title="User score ([\d.]+) out of 10"/.exec(card)?.[1];
    const summary = text(/line-clamp-2[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/.exec(card)?.[1]) || null;
    const image = unescapeHtml(/<img[^>]+src="(https:\/\/www\.metacritic\.com\/a\/img\/[^"]+)"/.exec(card)?.[1] ?? "") || null;
    out.push({ rank, title, slug, releaseText, metascore: metascore ? Number(metascore) : null, userscore: userscore ? Number(userscore) : null, summary, image });
  }
  return out;
}

/* ─────────────────────── fetching, cached ─────────────────────── */

export const mdeps = {
  fetchPage: async (url: string): Promise<string> => {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`METACRITIC_${res.status}`);
    return res.text();
  },
  search: steamSearch as (term: string) => Promise<SteamSearchHit[]>,
  now: () => Date.now(),
  log: (...a: unknown[]) => mlog.log(...a),
  resolveDelayMs: 300,                                                             // between store lookups; tests set 0
};

const LIST_TTL_MS = () => Math.max(1, cfgNum("METACRITIC_REFRESH_HOURS", 24)) * 3600_000;
const listKey = (k: McList) => `metacritic.list.${k}`;
const inflight = new Map<string, Promise<{ rows: McRow[]; at: number; stale: boolean }>>();

/** one list's rows; refreshed when stale, never throws while a stale copy exists */
export async function listRows(key: McList, force = false): Promise<{ rows: McRow[]; at: number; stale: boolean }> {
  let cached: { at: number; rows: McRow[] } | null = null;
  try { cached = JSON.parse(kv.get(listKey(key)) ?? "null"); } catch { /* ignore */ }
  if (cached && !force && mdeps.now() - cached.at < LIST_TTL_MS()) return { rows: cached.rows, at: cached.at, stale: false };
  const going = inflight.get(key);
  if (going) return going;
  const p = (async () => {
    try {
      const rows: McRow[] = [];
      for (let page = 1; page <= (PAGES[key] ?? 1); page++) {
        let got: McRow[];
        try { got = parseBrowseHtml(await mdeps.fetchPage(browseUrl(key, page))); }
        catch (e) { if (page === 1) throw e; mdeps.log(`list ${key} page ${page}: ${(e as any)?.message ?? e} — keeping page ${page - 1}`); break; }
        if (!got.length) break;
        const base = rows.length;
        rows.push(...got.map((r, i) => ({ ...r, rank: base + i + 1 })));
      }
      if (rows.length) { kv.set(listKey(key), JSON.stringify({ at: mdeps.now(), rows })); return { rows, at: mdeps.now(), stale: false }; }
      mdeps.log(`list ${key}: the page had no cards (markup changed?)`);
    } catch (e: any) { mdeps.log(`list ${key} failed: ${e?.message ?? e}`); }
    return cached ? { rows: cached.rows, at: cached.at, stale: true } : { rows: [], at: 0, stale: true };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ─────────────────────── Metacritic title → Steam app ─────────────────────── */

interface Resolved { appId: number | null; name: string | null; at: number }
const appKey = (slug: string) => `metacritic.app.${slug}`;
const MISS_RETRY_MS = 7 * 86_400_000;
export const resolvedApp = (slug: string): Resolved | null => { try { return JSON.parse(kv.get(appKey(slug)) ?? "null"); } catch { return null; } };
const needsResolve = (r: McRow, now: number) => { const x = resolvedApp(r.slug); return !x || (x.appId == null && now - x.at > MISS_RETRY_MS); };

/** what may follow the title and still be the same game: "Special Edition", "Enhanced", "(2010) Edition", "Remastered", "Complete Edition" */
const EDITION = /^(the )?((19|20)\d{2}( edition)?|((19|20)\d{2} )?(enhanced|special|definitive|anniversary|legendary|complete|ultimate|remastered|remaster|game of the year|goty|deluxe|directors cut)( edition)?)$/;

/** "Cart Life (2013)" → "Cart Life" — Metacritic disambiguates with a year; the store does not */
const plainTitle = (t: string) => t.replace(/\s*\((19|20)\d{2}\)\s*$/, "").trim();

/**
 * which store hit is this Metacritic title? The normalised names must be the same; failing that, a hit may carry
 * the title as a prefix only if the store quotes the very same Metascore for it (the store lists Metacritic's own
 * number, so an equal score is a confirmation, not a coincidence). Anything else is a guess, and guesses are refused.
 */
export function pickSteamHit(row: McRow, hits: SteamSearchHit[]): SteamSearchHit | null {
  const want = normName(plainTitle(row.title));
  if (!want) return null;
  const clean = hits.filter(h => !JUNK.test(h.name));
  const sameScore = (h: SteamSearchHit) => row.metascore != null && h.metascore != null && Number(h.metascore) === row.metascore;
  const exact = clean.filter(h => normName(h.name) === want);
  if (exact.length) return exact.find(sameScore) ?? exact[0];
  const rest = (h: SteamSearchHit) => (normName(h.name).startsWith(want + " ") ? normName(h.name).slice(want.length + 1) : null);
  const editions = clean.filter(h => EDITION.test(rest(h) ?? "-"));                  // the store sells the classic as a newer edition of the same game
  if (editions.length) return editions.find(sameScore) ?? editions[0];
  const confirmed = clean.filter(h => sameScore(h) && rest(h) != null && !/^\d/.test(rest(h)!));   // "Half-Life 2" is not "Half-Life"
  return confirmed.length === 1 ? confirmed[0] : null;
}

const resolving = new Set<string>();

/** look up the store for the rows that still lack an answer, politely, a bounded number per call */
export async function resolveRows(rows: McRow[], max = 50, delayMs = 300): Promise<number> {
  let done = 0;
  for (const r of rows) {
    if (done >= max) break;
    if (!needsResolve(r, mdeps.now()) || resolving.has(r.slug)) continue;
    resolving.add(r.slug);
    try {
      const hits = await mdeps.search(plainTitle(r.title));
      const hit = pickSteamHit(r, hits);
      kv.set(appKey(r.slug), JSON.stringify({ appId: hit?.appId ?? null, name: hit?.name ?? null, at: mdeps.now() } satisfies Resolved));
      if (!hit) mdeps.log(`no store match for "${r.title}"${hits.length ? ` (nearest: ${hits.slice(0, 2).map(h => h.name).join(" / ")})` : ""}`);
    } catch (e: any) { mdeps.log(`search "${r.title}": ${e?.message ?? e}`); }
    finally { resolving.delete(r.slug); }
    done++;
    if (delayMs) await new Promise(res => setTimeout(res, delayMs));
  }
  return done;
}

/* ─────────────────────── the rows the launcher shows ─────────────────────── */

export interface BestItem extends DiscoverItem { rank: number; userScore: number | null; mcSlug: string }
export interface BestList { key: McList; label: string; sub: string; items: BestItem[]; updatedAt: number; stale: boolean; pending: number; total: number }

let lastEnrich = 0;
const background = new Set<McList>();

/** one list as launcher items: every title the store knows, in Metacritic's order, with its score */
export async function bestOf(key: McList, limit = 60): Promise<BestList> {
  const info = lists().find(l => l.key === key);
  if (!info) throw new Error("not one of the Metacritic lists");
  const { rows, at, stale } = await listRows(key);
  const ctx = libraryContext();
  const now = mdeps.now();
  const items: BestItem[] = [];
  const missing: number[] = [];
  let pending = 0;
  for (const r of rows) {
    if (needsResolve(r, now)) { pending++; continue; }
    const appId = resolvedApp(r.slug)?.appId;
    if (appId == null) continue;
    const cat = stmts.catalogGet.get(appId) as CatalogRow | undefined;
    if (!cat) missing.push(appId);
    else if (cat.type && cat.type !== "game") continue;                                  // an expansion the store sells on its own
    const feed: FeedRow = { appId, name: cat?.name ?? resolvedApp(r.slug)?.name ?? r.title, releaseText: r.releaseText, reviewSummary: null, reviewPct: null, reviewCount: null, capsule: cat?.header_image ?? null, tagIds: [], free: false };
    const item = toItem(feed, cat, ctx.lib, ctx.follows, ctx.reqState);
    if (JUNK.test(item.name)) continue;
    items.push({ ...item, metacritic: r.metascore ?? item.metacritic, summary: item.summary ?? r.summary, rank: r.rank, userScore: r.userscore, mcSlug: r.slug });
    if (items.length >= limit) break;
  }
  // what is not resolved yet gets resolved now, in the background; details for what is on screen follow the same way
  if (pending && !background.has(key)) {
    background.add(key);
    void resolveRows(rows, 60, mdeps.resolveDelayMs).catch(() => {}).finally(() => background.delete(key));
  }
  if (missing.length && now - lastEnrich > 120_000) { lastEnrich = now; void enrichCatalog([...new Set(missing)], 40).catch(() => {}); }
  return { key, label: info.label, sub: info.sub, items: await withPortraits(items) as BestItem[], updatedAt: at, stale, pending, total: rows.length };
}

/** background: keep the lists people open first warm, and work through the store lookups a few at a time */
export async function metacriticTick(): Promise<void> {
  const y = new Date(mdeps.now()).getUTCFullYear();
  let budget = 40;
  for (const key of ["all", "players", `${y}`, `${y - 1}`] as McList[]) {
    if (budget <= 0) break;
    const { rows } = await listRows(key);
    budget -= await resolveRows(rows, budget, mdeps.resolveDelayMs);
    const ids = rows.map(r => resolvedApp(r.slug)?.appId).filter((x): x is number => x != null);
    await enrichCatalog(ids, 12).catch(() => {});
  }
}
