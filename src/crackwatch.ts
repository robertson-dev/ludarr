/**
 * ludarr — an unofficial client for CrackWatch (isitcracked.com): which PC games are cracked, since when, by
 * whom, what DRM they carry, and what is coming up. The site is a single-page app; its public pages are served
 * fully rendered to tool agents (a browser agent gets the empty shell), so this reads those pages and nothing
 * else: no login, no database key, no downloads. Pages are cached (lists for half an hour, game pages for six
 * hours, the sitemap for a day) and requests are spaced out, so a whole library check is a handful of fetches.
 *
 * Nothing here downloads a game: it answers "is there anything to look for yet?" — a Denuvo title that is not
 * cracked has no release worth searching for, and the day it is cracked is the day to search.
 */
import { kv } from "./db";
import { cfg } from "./config";
import { logger } from "./log";
import { normName } from "./catalog/store";

const log = logger("CrackWatch");
export const CW_BASE = "https://isitcracked.com";
const DEFAULT_UA = "curl/8.4.0 ludarr/0.1 (unofficial CrackWatch client)";   // the site renders for tool agents; "curl" is the token it looks for
const TTL = { list: 30 * 60_000, game: 6 * 3600_000, sitemap: 24 * 3600_000 };

/** swappable in tests */
export const cwdeps = { fetch: fetch as typeof fetch, now: () => Date.now(), spacingMs: 700 };

/** hypervisor = playable through a hypervisor bypass (DenuvOwO-style), which the site counts apart from a crack */
export type CwStatus = "cracked" | "uncracked" | "unreleased" | "hypervisor" | "unknown";
export interface CwCard { slug: string; title: string; status: CwStatus; days: number | null; cover: string | null; url: string }
export interface CwUpcoming { slug: string; title: string; releaseDate: string | null; cover: string | null; url: string }
export interface CwGame {
  slug: string; title: string; status: CwStatus; statusText: string | null;
  releaseDate: string | null; crackDate: string | null; daysToCrack: number | null;
  drm: string | null; group: string | null; cover: string | null; description: string | null; stores: string[]; url: string;
}
export type CwListKind = "all" | "cracked" | "uncracked" | "denuvo" | "hypervisor";

/* ─────────── fetching: polite, cached ─────────── */

let lastAt = 0;
let chain: Promise<unknown> = Promise.resolve();
async function page(path: string, ttl: number): Promise<string> {
  const key = `crackwatch.page.${path}`;
  try {
    const c = JSON.parse(kv.get(key) ?? "null") as { at: number; html: string } | null;
    if (c && cwdeps.now() - c.at < ttl) return c.html;
  } catch { /* refetch */ }
  const run = chain.then(async () => {
    const wait = lastAt + cwdeps.spacingMs - cwdeps.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = cwdeps.now();
    const res = await cwdeps.fetch(CW_BASE + path, { headers: { "User-Agent": cfg("CRACKWATCH_UA") || DEFAULT_UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) throw new CwError("not tracked by CrackWatch", 404);
    if (!res.ok) throw new CwError(`CrackWatch answered HTTP ${res.status}`, 502);
    const html = await res.text();
    if (!path.endsWith(".xml") && isShell(html)) throw new CwError("CrackWatch served its empty app shell instead of the page (the user agent is not treated as a tool; set CRACKWATCH_UA)", 502);
    kv.set(key, JSON.stringify({ at: cwdeps.now(), html }));
    return html;
  });
  chain = run.catch(() => {});
  return run;
}
export class CwError extends Error { constructor(msg: string, public status = 502) { super(msg); } }
/** the SPA shell has no rendered body: no h1, no cards, a few KB */
export const isShell = (html: string) => !/<h1[\s>]/i.test(html) && !/href="\/game\//.test(html);

/* ─────────── parsing (pure, tested against saved pages) ─────────── */

const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
const strip = (s: string) => unescape(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "Oct 15, 2026" → "2026-10-15"; "TBD" / "—" → null */
export function cwDate(s: string | null | undefined): string | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s ?? "");
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  return mon ? `${m[3]}-${String(mon).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}
const statusOf = (s: string): CwStatus => (/uncracked/i.test(s) ? "uncracked" : /unreleased/i.test(s) ? "unreleased" : /hypervisor|bypass/i.test(s) ? "hypervisor" : /cracked/i.test(s) ? "cracked" : "unknown");
/** the stat cards: a small uppercase label, then the value in a <p> */
const field = (html: string, label: string): string | null => {
  const m = new RegExp(`>${label}</span></div>\\s*<div[^>]*>\\s*<p[^>]*>([^<]*)</p>`).exec(html);
  const v = m ? strip(m[1]) : null;
  return v && !/^(tbd|tba|n\/a|-|—)$/i.test(v) ? v : null;
};

export function parseGamePage(html: string, slug: string): CwGame {
  const title = strip(/<h1[^>]*>(.*?)<\/h1>/s.exec(html)?.[1] ?? "") || strip(/<title>(.*?)<\/title>/s.exec(html)?.[1] ?? "").replace(/\s+Crack Status.*$/i, "");
  if (!title) throw new CwError("not a CrackWatch game page", 502);
  // the badge under the title: "<span class="inline-block uppercase …">Cracked</span></span><span …>Cracked on release day</span>"
  const badge = /<span class="inline-block uppercase[^"]*">([^<]*)<\/span>\s*<\/span>\s*(?:<span[^>]*>([^<]*)<\/span>)?/.exec(html);
  const status = statusOf(badge?.[1] ?? /\bbg-status-(uncracked|cracked|unreleased|hypervisor)\b/.exec(html)?.[1] ?? "");
  const statusText = badge?.[2] ? strip(badge[2]) : null;
  const releaseDate = cwDate(field(html, "Release Date"));
  const crackDate = cwDate(field(html, "Crack Date"));
  const days = releaseDate && crackDate ? Math.round((Date.parse(crackDate) - Date.parse(releaseDate)) / 86_400_000) : null;
  const desc = /<h2[^>]*>\s*Description\s*<\/h2>.*?<p[^>]*>(.*?)<\/p>/s.exec(html);
  const stores = [...new Set([...html.matchAll(/href="(https?:\/\/(?!isitcracked\.com|cdn\.isitcracked\.com)[^"]+)"[^>]*rel="[^"]*sponsored/g)].map(m => unescape(m[1])))];
  return {
    slug, title, status, statusText, releaseDate, crackDate, daysToCrack: days,
    drm: field(html, "DRM Protection"), group: field(html, "Scene Group"),
    cover: /property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? null,
    description: desc ? strip(desc[1]) : null, stores, url: `${CW_BASE}/game/${slug}`,
  };
}

const CARD = /<a class="group block[^"]*" href="\/game\/([^"]+)">(.*?)<\/a>/gs;

/** the cards of a list page (/games, /games/cracked, /games/uncracked, /denuvo, /hypervisor, /group/<name>): status, D+N, title */
export function parseCards(html: string): CwCard[] {
  const out: CwCard[] = [];
  for (const m of html.matchAll(CARD)) {
    const slug = m[1], body = m[2];
    const title = strip(/<h2[^>]*>(.*?)<\/h2>/s.exec(body)?.[1] ?? "") || strip(/alt="([^"]*?) Crack Status/.exec(body)?.[1] ?? "");
    if (!title) continue;
    const badge = /class="[^"]*\bstatus-(un)?cracked\b[^"]*"[^>]*>.*?<span>([^<]*)<\/span>/s.exec(body);
    const days = /D\+(\d+)/.exec(body);
    const cover = /<img src="(https?:[^"]+)"/.exec(body)?.[1] ?? null;
    out.push({ slug, title, status: statusOf(badge?.[2] ?? (badge?.[1] === "un" ? "uncracked" : badge ? "cracked" : "")), days: days ? Number(days[1]) : null, cover, url: `${CW_BASE}/game/${slug}` });
  }
  return out;
}

/** the upcoming calendar: a month/day badge per card; the year comes from the page title ("… — October 2026"), rolling over at a new year */
export function parseUpcoming(html: string): CwUpcoming[] {
  const t = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  const tm = /([A-Za-z]+)\s+(\d{4})/.exec(t);
  let year = tm ? Number(tm[2]) : new Date().getUTCFullYear();
  const startMon = tm ? MONTHS[tm[1].slice(0, 3).toLowerCase()] ?? 1 : 1;
  const out: CwUpcoming[] = [];
  for (const m of html.matchAll(CARD)) {
    const slug = m[1], body = m[2];
    const title = strip(/<h2[^>]*>(.*?)<\/h2>/s.exec(body)?.[1] ?? "") || strip(/alt="([^"]*?) Crack Status/.exec(body)?.[1] ?? "");
    const d = /<span[^>]*>([A-Za-z]{3})<\/span>\s*<span[^>]*>(\d{1,2})<\/span>/.exec(body);
    let releaseDate: string | null = null;
    if (d && MONTHS[d[1].toLowerCase()]) {
      const mon = MONTHS[d[1].toLowerCase()];
      if (mon < startMon && out.length) year = Math.max(year, (tm ? Number(tm[2]) : year) + 1);
      releaseDate = `${year}-${String(mon).padStart(2, "0")}-${d[2].padStart(2, "0")}`;
    }
    if (title) out.push({ slug, title, releaseDate, cover: /<img src="(https?:[^"]+)"/.exec(body)?.[1] ?? null, url: `${CW_BASE}/game/${slug}` });
  }
  return out;
}

/** every tracked game's slug, from the sitemap */
export const parseSitemap = (xml: string): string[] => [...new Set([...xml.matchAll(/<loc>https?:\/\/isitcracked\.com\/game\/([^<]+)<\/loc>/g)].map(m => m[1].trim()))];
export const parseGroups = (html: string): string[] => [...new Set([...html.matchAll(/href="\/group\/([^"]+)"/g)].map(m => m[1]))];

/* ─────────── the API ─────────── */

export const cwGame = async (slug: string): Promise<CwGame> => parseGamePage(await page(`/game/${encodeURIComponent(slug)}`, TTL.game), slug);
export async function cwList(kind: CwListKind): Promise<CwCard[]> {
  const path = kind === "all" ? "/games" : kind === "cracked" || kind === "uncracked" ? `/games/${kind}` : `/${kind}`;
  return parseCards(await page(path, TTL.list));
}
export const cwGroup = async (name: string): Promise<CwCard[]> => parseCards(await page(`/group/${encodeURIComponent(name)}`, TTL.list));
export const cwGroups = async (): Promise<string[]> => parseGroups(await page("/groups", TTL.list));
export const cwUpcoming = async (): Promise<CwUpcoming[]> => parseUpcoming(await page("/upcoming", TTL.list));
export const cwSlugs = async (): Promise<string[]> => parseSitemap(await page("/sitemap.xml", TTL.sitemap));

/** letters and digits only: "Castlevania: Belmont's Curse" and the site's slug "castlevania-belmont-s-curse" both become "castlevaniabelmontscurse" */
export const cwKey = (s: string) => normName(s.replace(/-/g, " ")).replace(/\s+/g, "");

/** the tracked game with this title, if any: an exact slug first, then the sitemap by letters-and-digits name */
export async function cwFind(title: string): Promise<CwGame | null> {
  const want = normName(title);
  if (!want) return null;
  const guess = want.replace(/\s+/g, "-"), key = cwKey(title);
  const slugs = await cwSlugs();
  const slug = slugs.find(s => s === guess) ?? slugs.find(s => cwKey(s) === key) ?? null;
  if (!slug) return null;
  try { return await cwGame(slug); }
  catch (e: any) { if (e instanceof CwError && e.status === 404) return null; log.warn(`${slug}: ${e?.message ?? e}`); throw e; }
}
