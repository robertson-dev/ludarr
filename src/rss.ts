/**
 * ludarr — RSS sync, the *arr way of catching a release the moment it is posted. Every indexer's recent feed
 * (a query-less search) is read on an interval. A feed item that is certainly one of the wanted games — a
 * monitored game that is missing or below its profile's cutoff, with no search already open — starts a search
 * for that game, and the search decides with the full profile rules (the feed item is among what it finds). One that is
 * certainly a game whose search waits to look again (for a crack, most likely: the group's release that says a game
 * CrackWatch calls uncracked is cracked is such an item) has that search look now, as a crack seen by CrackWatch does.
 * Each feed item is judged once; the searcher's own re-check interval covers everything else.
 */
import { db, kv, stmts, type GameRow } from "./db";
import { cfgNum } from "./config";
import { logger } from "./log";
import * as registry from "./plugins/registry";
import type { Indexer, Release } from "./plugins/types";
import type { ProwlarrRelease } from "./prowlarr";
import { certainlyThisGame, nameQueries, rankForNames } from "./releases";
import { createRequest, retryRequest } from "./requests";
import { cutoffUnmet, wantedMissing, type LibraryGame } from "./library/games";

const log = logger("RSS");
const SEEN_KEY = "rss.seen";
const SEEN_FOR_MS = 7 * 86_400_000;
const ACTIVE = new Set(["requested", "matching", "fetching", "processing"]);

/** swappable in tests */
export const rssdeps = {
  indexers: (): { name: string; indexer: Indexer }[] => registry.indexers().map(x => ({ name: x.row.name, indexer: x.indexer })),
  wanted: (): LibraryGame[] => [...wantedMissing(), ...cutoffUnmet()],
  /** the searches of monitored games that wait to look again (requested, their next look ahead; not a wait on the seedbox) */
  waiting: (nowSec: number): { id: number; gameId: number; name: string; aliases: string[] }[] =>
    (db.query("SELECT r.id, r.game_id, g.name, g.aliases_json FROM requests r JOIN games g ON g.id = r.game_id WHERE r.state = 'requested' AND r.next_try_at > ? AND r.remote_json IS NULL AND COALESCE(g.monitored, 1) = 1 ORDER BY r.id")
      .all(nowSec) as { id: number; game_id: number; name: string; aliases_json: string | null }[])
      .map(r => ({ id: r.id, gameId: r.game_id, name: r.name, aliases: (() => { try { const a = JSON.parse(r.aliases_json ?? "[]"); return Array.isArray(a) ? a.filter((x: unknown) => typeof x === "string") : []; } catch { return []; } })() })),
  gameRow: (id: number): GameRow | undefined => stmts.gameById.get(id) as GameRow | undefined,
  createRequest,
  retryRequest: (id: number): unknown => retryRequest(id),
  now: () => Date.now(),
  log: (s: string) => log.info(s),
};

function loadSeen(now: number): Map<string, number> {
  try {
    const raw = JSON.parse(kv.get(SEEN_KEY) ?? "{}") as Record<string, number>;
    return new Map(Object.entries(raw).filter(([, at]) => now - at < SEEN_FOR_MS));
  } catch { return new Map(); }
}

/** is this feed item certainly this game — the same test the searcher applies to its own results, under each of the
 *  game's names (its search terms only add queries, so they never make a feed item the game) */
export function isFor(rel: Release, game: { name: string; year: number | null; aliases?: string[] }): boolean {
  const [view] = rankForNames(nameQueries(game.name, game.year, game.aliases ?? []), [rel as unknown as ProwlarrRelease]);
  return !!view && certainlyThisGame(view);
}

const yearOf = (g: GameRow | undefined): number | null => g?.release_year ?? (g?.release_iso ? Number(g.release_iso.slice(0, 4)) || null : null);

/** read every feed once; start a search for each wanted game a new item certainly belongs to, and have a waiting search of a
 *  game it certainly belongs to look now. Returns how many searches started or looked now. */
export async function rssSync(): Promise<number> {
  if (cfgNum("RSS_SYNC_MIN", 15) <= 0) return 0;
  const now = rssdeps.now();
  const wanted = rssdeps.wanted().filter(g => g.monitored && !(g.request && ACTIVE.has(g.request.state)));
  const waiting = rssdeps.waiting(Math.floor(now / 1000));
  const sources = rssdeps.indexers().filter(s => typeof s.indexer.recent === "function");
  if ((!wanted.length && !waiting.length) || !sources.length) return 0;
  const seen = loadSeen(now);
  const started = new Set<number>();
  const woken = new Set<number>();
  let fresh = 0;
  for (const s of sources) {
    let items: Release[] = [];
    try { items = await s.indexer.recent!({ limit: 100 }); }
    catch (e: any) { log.warn(`${s.name}: ${e?.message ?? e}`); continue; }
    for (const rel of items) {
      const key = `${rel.instanceId}:${rel.guid}`;
      if (seen.has(key)) continue;
      seen.set(key, now); fresh++;
      // a search that waits to look again (for a crack: the group's release that lifts the wait is such an item) looks now
      const wait = waiting.find(w => !woken.has(w.id) && isFor(rel, { name: w.name, year: yearOf(rssdeps.gameRow(w.gameId)), aliases: w.aliases }));
      if (wait) {
        woken.add(wait.id);
        try { rssdeps.retryRequest(wait.id); rssdeps.log(`${wait.name}: "${rel.title}" just showed up on ${rel.indexer} — its waiting search looks now`); }
        catch (e: any) { log.warn(`${wait.name}: its waiting search could not look now: ${e?.message ?? e}`); }
        continue;
      }
      const game = wanted.find(g => !started.has(g.id) && isFor(rel, { name: g.name, year: yearOf(rssdeps.gameRow(g.id)), aliases: g.aliases ?? [] }));
      if (!game) continue;
      const r = rssdeps.createRequest({ gameId: game.id, by: game.cutoffUnmet ? "upgrade" : "rss" });
      started.add(game.id);
      if (!r.duplicate) rssdeps.log(`${game.name}: "${rel.title}" just showed up on ${rel.indexer} — searching`);
    }
  }
  kv.set(SEEN_KEY, JSON.stringify(Object.fromEntries(seen)));
  if (fresh) log.debug(`${fresh} new feed item(s) across ${sources.length} indexer(s), ${started.size} search(es) started, ${woken.size} waiting search(es) woken`);
  return started.size + woken.size;
}
