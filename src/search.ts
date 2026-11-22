/**
 * ludarr — release search shared by the API (interactive search) and the automatic searcher: build the
 * queries for a title, ask every enabled indexer, rank. Remembers what it returned so a grab only needs
 * {instanceId, guid} (indexers have no "get release" call).
 */
import * as registry from "./plugins/registry";
import type { Indexer, Release } from "./plugins/types";
import { nameQueries, queryPlan, rankForNames, type GameQuery, type ReleaseView } from "./releases";
import type { PlatformId } from "./platforms";

/** swappable in tests */
export const sdeps = {
  indexers: (): { id: number; name: string; indexer: Indexer }[] => registry.indexers().map(x => ({ id: x.row.id, name: x.row.name, indexer: x.indexer })),
};

const recent = new Map<string, { r: ReleaseView; at: number }>();
const RECENT_TTL_MS = 60 * 60 * 1000;
const RECENT_MAX = 5000;

export function remember(r: ReleaseView) {
  recent.set(`${r.instanceId}:${r.guid}`, { r, at: Date.now() });
  if (recent.size > RECENT_MAX) for (const k of [...recent.keys()].slice(0, recent.size - RECENT_MAX)) recent.delete(k);
}
export function recall(instanceId: number, guid: string): ReleaseView | null {
  const hit = recent.get(`${instanceId}:${guid}`);
  return hit && Date.now() - hit.at < RECENT_TTL_MS ? hit.r : null;
}

export class SearchError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

let privacyCache: { at: number; map: Map<number, string> } | null = null;
/** privacy per (Prowlarr) indexer id, merged across instances — the ranking prefers private trackers */
export async function indexerPrivacy(): Promise<Map<number, string>> {
  if (privacyCache && Date.now() - privacyCache.at < 10 * 60 * 1000) return privacyCache.map;
  const map = new Map<number, string>();
  for (const x of sdeps.indexers()) {
    try { for (const [k, v] of (await x.indexer.privacy?.()) ?? []) map.set(k, v); } catch { /* an indexer that is down keeps the old map */ }
  }
  privacyCache = { at: Date.now(), map };
  return map;
}

/** `query` is the game's own name's; `queries` holds it and one per alias, in the order releases are judged by */
export interface SearchResult { query: GameQuery; queries: GameQuery[]; searched: string[]; raw: number; ranked: ReleaseView[]; errors: { indexer: string; error: string }[] }

export interface SearchOptions {
  loose?: boolean; protocol?: string; thorough?: boolean; categories?: number[]; platforms?: PlatformId[];
  /** a console pass: the consoles the game is known to be on (a dump named only by a retro console's tag is taken for one
   *  of them only); absent = no such limit */
  known?: PlatformId[];
  /** other names the game goes by: each is asked, and each release is judged under every name with the full rules */
  aliases?: string[];
  /** the admin's extra queries, sent as typed; what they find is judged against the names only */
  terms?: string[];
  /** a way's own console pass (src/ways/find.ts): dumps that name no console are taken as the pass's console, and tags the
   *  way's description asks for are allowed (src/releases.ts DumpPass) */
  unnamed?: boolean;
  asked?: string[];
}

/**
 * The game's own name's longer queries, and the aliases' heads, only run when what came before was thin (unless
 * `thorough`); the aliases' full names and the search terms are always asked, so everything the admin listed is tried.
 */
export async function searchReleases(name: string, year: number | null, opt: SearchOptions = {}): Promise<SearchResult> {
  const sources = sdeps.indexers();
  if (!sources.length) throw new SearchError("no indexer is enabled — add one under Settings → Indexers", 400);
  const qs = nameQueries(name, year, opt.aliases ?? []);
  const plan = queryPlan(name, year, opt.aliases ?? [], opt.terms ?? []);
  const privacy = await indexerPrivacy();
  const raw: Release[] = [];
  const searched: string[] = [];
  const errors: { indexer: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const [i, { text: term, kind }] of plan.entries()) {
    // a broad query ("Castlevania") can fill an indexer's page before the title we want shows up:
    // the automatic searcher asks every query, the interactive list skips the optional ones once it has enough to show
    const optional = kind === "head" || (kind === "name" && i > 0);
    if (optional && !opt.thorough && rankForNames(qs, raw, { platforms: opt.platforms, known: opt.known, unnamed: opt.unnamed, asked: opt.asked }).length >= 8) continue;
    searched.push(term);
    await Promise.all(sources.map(async s => {
      try {
        for (const r of await s.indexer.search(term, opt.categories ? { categories: opt.categories } : undefined)) {
          const key = `${r.instanceId}:${r.guid}`;
          if (!seen.has(key)) { seen.add(key); raw.push(r); }
        }
      } catch (e: any) { errors.push({ indexer: s.name, error: String(e?.message ?? e) }); }
    }));
  }
  if (!raw.length && errors.length && errors.length >= sources.length) throw new SearchError(`every indexer failed: ${errors.map(e => `${e.indexer}: ${e.error}`).join("; ")}`, 502);
  let ranked = rankForNames(qs, raw, { loose: !!opt.loose, privacy, platforms: opt.platforms, known: opt.known, unnamed: opt.unnamed, asked: opt.asked });
  if (opt.protocol === "torrent" || opt.protocol === "usenet") ranked = ranked.filter(r => r.protocol === opt.protocol);
  for (const r of ranked) remember(r);
  return { query: qs[0], queries: qs, searched, raw: raw.length, ranked, errors };
}
