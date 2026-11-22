/**
 * ludarr — catalog storage: titles, the ids and names they are known by, routes, runtimes, provider runs.
 *
 * Providers hand in full snapshots (`ingest`). Each contribution is resolved to a title — by a shared id
 * first (Steam app id, console serial, ROM hash, registry key), then by normalised name (+ year when both
 * sides know it) — or creates one. Metadata from a higher-ranked provider wins; others only fill gaps.
 * Routes are keyed by (provider, provider's key); whatever a provider stops reporting is removed.
 */
import { db } from "../db";
import {
  STATUS_ORDER, statusRank, type Contribution, type ExtId, type Platform, type Provider, type RouteInput, type RuntimeInput,
  type RuntimeRelease, type Status, type TitleInput, type TitleMeta,
} from "./types";

db.exec(`
CREATE TABLE IF NOT EXISTS titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_name TEXT NOT NULL,
  platforms_json TEXT NOT NULL DEFAULT '[]',   -- original platforms
  year INTEGER,
  release_iso TEXT,
  summary TEXT, developer TEXT, publisher TEXT,
  genres_json TEXT NOT NULL DEFAULT '[]',
  cover_url TEXT, hero_url TEXT, logo_url TEXT,
  screenshots_json TEXT NOT NULL DEFAULT '[]',
  meta_source TEXT, meta_rank INTEGER NOT NULL DEFAULT -1,
  game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,   -- in the library
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_titles_sort ON titles(sort_name);

CREATE TABLE IF NOT EXISTS title_ids (
  scheme TEXT NOT NULL, value TEXT NOT NULL,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  source TEXT,
  PRIMARY KEY (scheme, value)
);
CREATE INDEX IF NOT EXISTS idx_title_ids_title ON title_ids(title_id);

CREATE TABLE IF NOT EXISTS title_names (
  norm TEXT NOT NULL,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  PRIMARY KEY (norm, title_id)
);

CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- recomp | port | emulator
  platforms_json TEXT NOT NULL DEFAULT '[]',
  homepage TEXT, repo TEXT, asset_pattern TEXT, channel TEXT DEFAULT 'stable',
  notes TEXT, launch_json TEXT,
  latest_json TEXT,                    -- RuntimeRelease, refreshed from GitHub
  checked_at INTEGER,
  source TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- native | recomp | port | emulated
  platform TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'retail',
  runtime_id TEXT,
  label TEXT,
  status TEXT, status_rank INTEGER NOT NULL DEFAULT 99, status_note TEXT, status_at INTEGER,
  content_json TEXT, needs_json TEXT NOT NULL DEFAULT '[]', features_json TEXT NOT NULL DEFAULT '[]',
  launch_json TEXT, link TEXT,
  source TEXT NOT NULL, source_key TEXT NOT NULL,
  seen_run INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE (source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_routes_title ON routes(title_id);
CREATE INDEX IF NOT EXISTS idx_routes_kind ON routes(kind, platform);

CREATE TABLE IF NOT EXISTS catalog_sources (
  id TEXT PRIMARY KEY,
  last_run INTEGER, last_ok INTEGER, last_error TEXT,
  titles INTEGER DEFAULT 0, routes INTEGER DEFAULT 0, took_ms INTEGER,
  run_seq INTEGER NOT NULL DEFAULT 0
);
`);

/* ─────────────────────── names ─────────────────────── */

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16" };

/** "The Legend of Zelda™: Majora’s Mask" → "legend of zelda majoras mask"; "Final Fantasy VII" → "final fantasy 7" */
export function normName(s: string): string {
  const words = s.replace(/[™®©]/g, "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
    .map(w => ROMAN[w] ?? w);
  if (words[0] === "the" && words.length > 1) words.shift();
  return words.join(" ");
}

export function slugify(s: string): string {
  return normName(s).replace(/ /g, "-").slice(0, 80) || "title";
}

/* ─────────────────────── statements ─────────────────────── */

const q = {
  byId: db.query("SELECT title_id FROM title_ids WHERE scheme=? AND value=?"),
  byName: db.query("SELECT t.id, t.year, t.platforms_json, t.game_id FROM title_names n JOIN titles t ON t.id=n.title_id WHERE n.norm=?"),
  slugTaken: db.query("SELECT 1 FROM titles WHERE slug=?"),
  insertTitle: db.query("INSERT INTO titles (slug, name, sort_name) VALUES (?, ?, ?) RETURNING id"),
  title: db.query("SELECT * FROM titles WHERE id=?"),
  addId: db.query("INSERT OR IGNORE INTO title_ids (scheme, value, title_id, source) VALUES (?, ?, ?, ?)"),
  addName: db.query("INSERT OR IGNORE INTO title_names (norm, title_id) VALUES (?, ?)"),
  upsertRoute: db.query(`INSERT INTO routes (title_id, kind, platform, provenance, runtime_id, label, status, status_rank, status_note, status_at,
      content_json, needs_json, features_json, launch_json, link, source, source_key, seen_run, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(source, source_key) DO UPDATE SET title_id=excluded.title_id, kind=excluded.kind, platform=excluded.platform,
      provenance=excluded.provenance, runtime_id=excluded.runtime_id, label=excluded.label, status=excluded.status,
      status_rank=excluded.status_rank, status_note=excluded.status_note, status_at=excluded.status_at,
      content_json=excluded.content_json, needs_json=excluded.needs_json, features_json=excluded.features_json,
      launch_json=excluded.launch_json, link=excluded.link, seen_run=excluded.seen_run, updated_at=unixepoch()`),
  dropStale: db.query("DELETE FROM routes WHERE source=? AND (seen_run IS NULL OR seen_run<>?)"),
  upsertRuntime: db.query(`INSERT INTO runtimes (id, name, kind, platforms_json, homepage, repo, asset_pattern, channel, notes, launch_json, source, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, platforms_json=excluded.platforms_json, homepage=excluded.homepage,
      repo=excluded.repo, asset_pattern=excluded.asset_pattern, channel=excluded.channel, notes=excluded.notes, launch_json=excluded.launch_json,
      source=excluded.source, updated_at=unixepoch()`),
  setRuntimeRelease: db.query("UPDATE runtimes SET latest_json=?, checked_at=unixepoch() WHERE id=?"),
  runtimesAll: db.query("SELECT * FROM runtimes ORDER BY kind, name"),
  runtime: db.query("SELECT * FROM runtimes WHERE id=?"),
  sourceRow: db.query("SELECT * FROM catalog_sources WHERE id=?"),
  sourceSeq: db.query("INSERT INTO catalog_sources (id, run_seq) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET run_seq=run_seq+1 RETURNING run_seq"),
  sourceDone: db.query("UPDATE catalog_sources SET last_run=unixepoch(), last_ok=unixepoch(), last_error=NULL, titles=?, routes=?, took_ms=? WHERE id=?"),
  sourceFailed: db.query("INSERT INTO catalog_sources (id, last_run, last_error) VALUES (?, unixepoch(), ?) ON CONFLICT(id) DO UPDATE SET last_run=unixepoch(), last_error=excluded.last_error"),
  sourcesAll: db.query("SELECT * FROM catalog_sources"),
};

export interface TitleRow {
  id: number; slug: string; name: string; sort_name: string; platforms_json: string; year: number | null; release_iso: string | null;
  summary: string | null; developer: string | null; publisher: string | null; genres_json: string;
  cover_url: string | null; hero_url: string | null; logo_url: string | null; screenshots_json: string;
  meta_source: string | null; meta_rank: number; game_id: number | null; created_at: number; updated_at: number;
}
export interface RouteRow {
  id: number; title_id: number; kind: string; platform: string; provenance: string; runtime_id: string | null; label: string | null;
  status: string | null; status_rank: number; status_note: string | null; status_at: number | null;
  content_json: string | null; needs_json: string; features_json: string; launch_json: string | null; link: string | null;
  source: string; source_key: string; created_at: number; updated_at: number;
}
export interface RuntimeRow {
  id: string; name: string; kind: string; platforms_json: string; homepage: string | null; repo: string | null; asset_pattern: string | null;
  channel: string | null; notes: string | null; launch_json: string | null; latest_json: string | null; checked_at: number | null; source: string | null; updated_at: number;
}

const json = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };
const union = <T>(a: T[], b: T[] = []) => [...new Set([...a, ...b])];

/* ─────────────────────── resolution ─────────────────────── */

export function uniqueSlug(name: string, year?: number | null, platform?: string): string {
  const base = slugify(name);
  for (const s of [base, year ? `${base}-${year}` : null, platform ? `${base}-${platform}` : null].filter(Boolean) as string[])
    if (!q.slugTaken.get(s)) return s;
  for (let i = 2; ; i++) if (!q.slugTaken.get(`${base}-${i}`)) return `${base}-${i}`;
}

/** the ids a store gives its own listings: a contribution with one is a store's entry for one game */
const STORE_SCHEMES = new Set<string>(["steam", "igdb", "gog"]);

/**
 * Which existing title a contribution is about, or null for a new one. By name, a title a library game holds is never
 * another library game's, and a store's listing is taken for one only when both know their year and the years agree:
 * a remake or reboot of the same name with no date yet would otherwise become the held game. Lists with no store id
 * (the compatibility lists) still reach a held title by name alone.
 */
export function findTitle(t: TitleInput): number | null {
  for (const id of t.ids) {
    const hit = q.byId.get(id.scheme, id.value) as { title_id: number } | undefined;
    if (hit) return hit.title_id;
  }
  const store = t.ids.some(i => STORE_SCHEMES.has(i.scheme));
  for (const n of union([t.name], t.aliases)) {
    const norm = normName(n);
    if (!norm) continue;
    let cands = (q.byName.all(norm) as { id: number; year: number | null; platforms_json: string; game_id: number | null }[])
      .filter(c => !(t.year && c.year && Math.abs(t.year - c.year) > 1))
      .filter(c => c.game_id == null || (t.gameId != null ? c.game_id === t.gameId : !store || !!(t.year && c.year)));
    if (cands.length > 1 && t.platforms?.length) {
      const same = cands.filter(c => json<string[]>(c.platforms_json, []).some(p => t.platforms!.includes(p as Platform)));
      if (same.length) cands = same;
    }
    if (cands.length) return Math.min(...cands.map(c => c.id));
  }
  return null;
}

const META_COLS: [keyof TitleMeta, string, boolean][] = [
  ["summary", "summary", false], ["developer", "developer", false], ["publisher", "publisher", false], ["genres", "genres_json", true],
  ["cover", "cover_url", false], ["hero", "hero_url", false], ["logo", "logo_url", false], ["screenshots", "screenshots_json", true],
];

/** resolve (or create) the title and fold the contribution's ids, names and metadata into it */
export function upsertTitle(t: TitleInput, provider: Pick<Provider, "id" | "metaRank">): number {
  let id = findTitle(t);
  if (id == null) id = (q.insertTitle.get(uniqueSlug(t.name, t.year, t.platforms?.[0]), t.name, normName(t.name)) as { id: number }).id;
  const row = q.title.get(id) as TitleRow;
  const wins = provider.metaRank > row.meta_rank;
  const set: Record<string, unknown> = {};
  if (wins) { set.name = t.name; set.sort_name = normName(t.name); set.meta_source = provider.id; set.meta_rank = provider.metaRank; }
  const platforms = union(json<string[]>(row.platforms_json, []), t.platforms ?? []);
  if (platforms.length !== json<string[]>(row.platforms_json, []).length) set.platforms_json = JSON.stringify(platforms);
  if (t.year && (wins || !row.year)) set.year = t.year;
  if (t.releaseIso && (wins || !row.release_iso)) set.release_iso = t.releaseIso;
  for (const [key, col, isList] of META_COLS) {
    const v = t.meta?.[key];
    const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
    if (empty) continue;
    const current = (row as unknown as Record<string, unknown>)[col];
    const currentEmpty = current == null || current === "" || current === "[]";
    if (wins || currentEmpty) set[col] = isList ? JSON.stringify(v) : v;
  }
  if (t.gameId && !row.game_id) set.game_id = t.gameId;
  const cols = Object.keys(set);
  if (cols.length) db.query(`UPDATE titles SET ${cols.map(c => `${c}=?`).join(", ")}, updated_at=unixepoch() WHERE id=?`).run(...(cols.map(c => set[c]) as any[]), id);
  for (const x of t.ids) q.addId.run(x.scheme, x.value, id, provider.id);
  for (const n of union([t.name], t.aliases)) { const norm = normName(n); if (norm) q.addName.run(norm, id); }
  return id;
}

function writeRoute(titleId: number, r: RouteInput, source: string, run: number) {
  const status: Status | null = r.status && STATUS_ORDER.includes(r.status) ? r.status : null;
  q.upsertRoute.run(titleId, r.kind, r.platform, r.provenance ?? "retail", r.runtime ?? null, r.label ?? null,
    status, status ? statusRank(status) : 99, r.statusNote ?? null, r.statusAt ?? null,
    r.content ? JSON.stringify(r.content) : null, JSON.stringify(r.needs ?? []), JSON.stringify(r.features ?? []),
    r.launch ? JSON.stringify(r.launch) : null, r.link ?? null, source, r.key, run);
}

export function upsertRuntime(r: RuntimeInput, source: string) {
  q.upsertRuntime.run(r.id, r.name, r.kind, JSON.stringify(r.platforms), r.homepage ?? null, r.repo ?? null, r.assetPattern ?? null,
    r.channel ?? "stable", r.notes ?? null, r.launch ? JSON.stringify(r.launch) : null, source);
  if (r.latest !== undefined) q.setRuntimeRelease.run(r.latest ? JSON.stringify(r.latest) : null, r.id);
}
export const setRuntimeRelease = (id: string, rel: RuntimeRelease | null) => q.setRuntimeRelease.run(rel ? JSON.stringify(rel) : null, id);
export const runtimeRows = () => q.runtimesAll.all() as RuntimeRow[];
export const runtimeRow = (id: string) => q.runtime.get(id) as RuntimeRow | undefined;

/** a provider's full snapshot: titles + routes merged in, routes it no longer reports removed */
export function ingest(provider: Pick<Provider, "id" | "metaRank">, items: Contribution[], runtimes: RuntimeInput[] = [], tookMs = 0) {
  const run = (q.sourceSeq.get(provider.id) as { run_seq: number }).run_seq;
  const titles = new Set<number>();
  let routes = 0;
  db.transaction(() => {
    for (const rt of runtimes) upsertRuntime(rt, provider.id);
    for (const c of items) {
      if (!c.title.name?.trim()) continue;
      const id = upsertTitle(c.title, provider);
      titles.add(id);
      for (const r of c.routes) { writeRoute(id, r, provider.id, run); routes++; }
    }
    q.dropStale.run(provider.id, run);
    q.sourceDone.run(titles.size, routes, tookMs, provider.id);
  })();
  return { titles: titles.size, routes };
}

export function recordFailure(providerId: string, error: string) { q.sourceFailed.run(providerId, error.slice(0, 1000)); }
export interface SourceRow { id: string; last_run: number | null; last_ok: number | null; last_error: string | null; titles: number; routes: number; took_ms: number | null }
export const sourceRows = () => q.sourcesAll.all() as SourceRow[];

/* ─────────────────────── reading ─────────────────────── */

export function serializeRuntime(r: RuntimeRow) {
  return {
    id: r.id, name: r.name, kind: r.kind, platforms: json<string[]>(r.platforms_json, []), homepage: r.homepage, repo: r.repo,
    channel: r.channel, notes: r.notes, launch: json(r.launch_json, null), latest: json<RuntimeRelease | null>(r.latest_json, null),
    checkedAt: r.checked_at,
  };
}

export function serializeRoute(r: RouteRow, runtimes?: Map<string, RuntimeRow>) {
  const rt = r.runtime_id ? runtimes?.get(r.runtime_id) ?? runtimeRow(r.runtime_id) : undefined;
  return {
    id: r.id, kind: r.kind, platform: r.platform, provenance: r.provenance, label: r.label,
    status: r.status, statusNote: r.status_note, statusAt: r.status_at,
    runtime: rt ? { id: rt.id, name: rt.name, kind: rt.kind, latest: json<RuntimeRelease | null>(rt.latest_json, null) } : r.runtime_id ? { id: r.runtime_id, name: r.runtime_id, kind: null, latest: null } : null,
    content: json(r.content_json, null), needs: json(r.needs_json, []), features: json<string[]>(r.features_json, []),
    launch: json(r.launch_json, null) ?? (rt ? json(rt.launch_json, null) : null), link: r.link, source: r.source, updatedAt: r.updated_at,
  };
}

const KIND_ORDER = ["native", "recomp", "port", "emulated"];
/** best way to play first: retail before leaks, native → recomp → port → emulated, then by compatibility */
export function routeOrder(a: RouteRow, b: RouteRow): number {
  return (a.provenance === "retail" ? 0 : 1) - (b.provenance === "retail" ? 0 : 1)
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || a.status_rank - b.status_rank
    || (b.status_at ?? 0) - (a.status_at ?? 0)
    || b.updated_at - a.updated_at;
}

export function summarizeTitle(t: TitleRow, routes: RouteRow[]) {
  const sorted = [...routes].sort(routeOrder);
  const best = sorted[0];
  return {
    id: t.id, slug: t.slug, name: t.name, year: t.year, releaseIso: t.release_iso, platforms: json<string[]>(t.platforms_json, []),
    cover: t.cover_url, hero: t.hero_url, logo: t.logo_url, gameId: t.game_id,
    kinds: [...new Set(sorted.map(r => r.kind))], provenances: [...new Set(sorted.map(r => r.provenance))],
    best: best ? { kind: best.kind, platform: best.platform, label: best.label, status: best.status, provenance: best.provenance } : null,
    routeCount: routes.length,
  };
}

export function detailTitle(t: TitleRow, routes: RouteRow[], ids: ExtId[] = [], runtimes?: Map<string, RuntimeRow>) {
  return {
    ...summarizeTitle(t, routes), summary: t.summary, developer: t.developer, publisher: t.publisher, genres: json<string[]>(t.genres_json, []),
    screenshots: json<string[]>(t.screenshots_json, []), metaSource: t.meta_source, ids,
    routes: [...routes].sort(routeOrder).map(r => serializeRoute(r, runtimes)), updatedAt: t.updated_at,
  };
}
export type TitleSummary = ReturnType<typeof summarizeTitle>;
export type TitleDetail = ReturnType<typeof detailTitle>;

export interface TitleQuery {
  q?: string; kind?: string; platform?: string; provenance?: string; runtime?: string; status?: string; library?: boolean;
  sort?: "name" | "year" | "updated" | "status"; limit?: number; offset?: number; all?: boolean;
  /** only titles with a route from one of these sources (the enabled ones); their other routes are left out too */
  sources?: Set<string>;
}

const fromSources = (routes: RouteRow[], sources?: Set<string>) => (sources ? routes.filter(r => sources.has(r.source)) : routes);

export function queryTitles(f: TitleQuery) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const routeCond: string[] = [];
  const routeArgs: (string | number)[] = [];
  if (f.kind) { routeCond.push("r.kind=?"); routeArgs.push(f.kind); }
  if (f.platform) { routeCond.push("r.platform=?"); routeArgs.push(f.platform); }
  if (f.provenance) { routeCond.push("r.provenance=?"); routeArgs.push(f.provenance); }
  if (f.runtime) { routeCond.push("r.runtime_id=?"); routeArgs.push(f.runtime); }
  if (f.status && STATUS_ORDER.includes(f.status as Status)) { routeCond.push("r.status_rank<=?"); routeArgs.push(statusRank(f.status as Status)); }
  if (f.sources) { const list = [...f.sources]; routeCond.push(list.length ? `r.source IN (${list.map(() => "?").join(",")})` : "0"); routeArgs.push(...list); }
  if (routeCond.length || !f.all) { where.push(`EXISTS (SELECT 1 FROM routes r WHERE r.title_id=t.id${routeCond.map(c => ` AND ${c}`).join("")})`); args.push(...routeArgs); }
  let relevance: { sql: string; args: string[] } | null = null;
  if (f.q?.trim()) {
    const norm = normName(f.q);
    where.push("(t.id IN (SELECT title_id FROM title_names WHERE norm LIKE ?) OR t.id IN (SELECT title_id FROM title_ids WHERE value=?))");
    args.push(`%${norm}%`, f.q.trim());
    // exact name, then names starting with it, then a word starting with it, then anything containing it
    relevance = { sql: "(SELECT MIN(CASE WHEN n.norm=? THEN 0 WHEN n.norm LIKE ? THEN 1 WHEN n.norm LIKE ? THEN 2 ELSE 3 END) FROM title_names n WHERE n.title_id=t.id)", args: [norm, `${norm}%`, `% ${norm}%`] };
  }
  if (f.library) where.push("t.game_id IS NOT NULL");
  const order = f.sort === "year" ? "t.year IS NULL, t.year DESC, t.sort_name"
    : f.sort === "updated" ? "t.updated_at DESC"
    : f.sort === "status" ? "(SELECT MIN(status_rank) FROM routes r WHERE r.title_id=t.id), t.sort_name"
    : !f.sort && relevance ? `${relevance.sql}, t.sort_name` : "t.sort_name";
  const orderArgs = !f.sort && relevance ? relevance.args : [];
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(500, Math.max(1, f.limit ?? 60));
  const offset = Math.max(0, f.offset ?? 0);
  const total = (db.query(`SELECT COUNT(*) AS n FROM titles t ${sqlWhere}`).get(...args) as { n: number }).n;
  const rows = db.query(`SELECT t.* FROM titles t ${sqlWhere} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, ...orderArgs, limit, offset) as TitleRow[];
  const routes = routesFor(rows.map(r => r.id));
  return { total, offset, limit, titles: rows.map(t => summarizeTitle(t, fromSources(routes.get(t.id) ?? [], f.sources))) };
}

function routesFor(ids: number[]): Map<number, RouteRow[]> {
  const out = new Map<number, RouteRow[]>();
  if (!ids.length) return out;
  for (const r of db.query(`SELECT * FROM routes WHERE title_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as RouteRow[]) {
    const list = out.get(r.title_id) ?? [];
    list.push(r); out.set(r.title_id, list);
  }
  return out;
}

export function getTitle(idOrSlug: string | number, sources?: Set<string>) {
  const t = (typeof idOrSlug === "number" || /^\d+$/.test(String(idOrSlug))
    ? db.query("SELECT * FROM titles WHERE id=?").get(Number(idOrSlug))
    : db.query("SELECT * FROM titles WHERE slug=?").get(String(idOrSlug))) as TitleRow | undefined;
  if (!t) return null;
  const routes = fromSources(routesFor([t.id]).get(t.id) ?? [], sources);
  const ids = db.query("SELECT scheme, value FROM title_ids WHERE title_id=? ORDER BY scheme").all(t.id) as ExtId[];
  const runtimes = new Map(runtimeRows().map(r => [r.id, r]));
  return detailTitle(t, routes, ids, runtimes);
}

/** counts for filters: per kind, content platform, provenance, runtime, status */
export function facets(sources?: Set<string>) {
  const list = sources ? [...sources] : null;
  const only = list ? ` AND source IN (${list.length ? list.map(() => "?").join(",") : "''"})` : "";
  const args = list ?? [];
  const count = (col: string) => Object.fromEntries((db.query(`SELECT ${col} AS k, COUNT(DISTINCT title_id) AS n FROM routes WHERE ${col} IS NOT NULL${only} GROUP BY ${col} ORDER BY n DESC`).all(...args) as { k: string; n: number }[]).map(r => [r.k, r.n]));
  return {
    titles: (db.query(`SELECT COUNT(DISTINCT title_id) AS n FROM routes WHERE 1${only}`).get(...args) as { n: number }).n,
    kinds: count("kind"), platforms: count("platform"), provenances: count("provenance"), runtimes: count("runtime_id"), statuses: count("status"),
  };
}
