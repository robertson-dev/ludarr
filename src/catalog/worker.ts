/**
 * ludarr — catalog worker: runs each enabled metadata source when it is due (one at a time), and keeps
 * every runtime's latest Windows release fresh from GitHub.
 */
import { cfgNum } from "../config";
import { events } from "../events";
import { logger } from "../log";
import * as registry from "../plugins/registry";
import type { MetadataSource } from "../plugins/types";
import { ingest, recordFailure, runtimeRows, setRuntimeRelease, sourceRows, upsertRuntime } from "./store";
import { latestRelease, RateLimited } from "./github";

const log = logger("Catalog");
export const cdeps = {
  fetch: fetch as typeof fetch,
  log: (...a: unknown[]) => log.log(...a),
  sources: (): { id: number; name: string; source: MetadataSource }[] => registry.metadataSources().map(x => ({ id: x.row.id, name: x.row.name, source: x.source })),
  runtimes: () => registry.runtimeInputs(),
};

const running = new Set<string>();

export async function runSource(p: MetadataSource): Promise<{ titles: number; routes: number } | { error: string }> {
  const ready = p.ready?.() ?? true;
  if (ready !== true) { recordFailure(p.id, ready); return { error: ready }; }
  if (running.has(p.id)) return { error: "already running" };
  running.add(p.id);
  const t0 = Date.now();
  try {
    for (const r of p.runtimes?.() ?? []) upsertRuntime(r, p.id);
    const items = await p.collect({ log: l => cdeps.log(`${p.id}: ${l}`), fetch: cdeps.fetch });
    const r = ingest(p, items, p.runtimes?.() ?? [], Date.now() - t0);   // some sources learn their runtimes while collecting
    cdeps.log(`${p.id}: ${r.titles} titles, ${r.routes} routes in ${Date.now() - t0} ms`);
    events.emit("catalog", { source: p.id, ...r });
    return r;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    recordFailure(p.id, msg);
    cdeps.log(`${p.id} failed: ${msg}`);
    return { error: msg };
  } finally { running.delete(p.id); }
}

export function sourceById(id: string): MetadataSource | null { return cdeps.sources().find(s => s.source.id === id)?.source ?? null; }
/** the enabled sources' ids: what the catalog shows and keeps fresh; a disabled source's titles and routes stay stored but out of sight */
export const activeSources = () => new Set(cdeps.sources().map(s => s.source.id));

/** runtime definitions (emulators, ports …) → the runtimes table */
export function syncRuntimes() {
  for (const r of cdeps.runtimes()) upsertRuntime(r, "runtimes");
}

/** GitHub releases for runtimes not checked for a while; stops at the rate limit and tries again next tick */
export async function refreshRuntimes(force = false): Promise<{ checked: number; error?: string }> {
  const maxAge = cfgNum("CATALOG_RUNTIME_CHECK_HOURS", 6) * 3600;
  const now = Math.floor(Date.now() / 1000);
  const active = activeSources();
  if (cdeps.runtimes().length) active.add("runtimes");
  let checked = 0;
  for (const r of runtimeRows()) {
    if (r.source && !active.has(r.source)) continue;                                     // a disabled source's runtimes are not polled
    if (!r.repo || r.channel === "seed" || (!force && r.checked_at && now - r.checked_at < maxAge)) continue;
    try { setRuntimeRelease(r.id, await latestRelease(r.repo, r.asset_pattern, r.channel, cdeps.fetch)); checked++; }
    catch (e: any) {
      if (e instanceof RateLimited) return { checked, error: e.message };
      cdeps.log(`release check for ${r.id} failed: ${e?.message ?? e}`);
    }
  }
  return { checked };
}

let ticking = false;
export async function catalogTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    syncRuntimes();
    const last = new Map(sourceRows().map(s => [s.id, s.last_run ?? 0]));
    const now = Math.floor(Date.now() / 1000);
    for (const { source } of cdeps.sources()) if (now - (last.get(source.id) ?? 0) >= source.every * 60) await runSource(source);
    await refreshRuntimes();
  } finally { ticking = false; }
}
