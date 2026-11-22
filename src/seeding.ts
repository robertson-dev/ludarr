/**
 * ludarr — what becomes of a download after its import, the *arr way. A usenet download is removed from the
 * client right after the import, its files with it when they are reachable through the client's mapped folder.
 * A torrent keeps seeding until the download client's seed goals are met (a ratio and/or hours of seeding, per
 * client; a goal of 0 is no goal, 0 and 0 keeps it forever), then it is removed with its files. Only downloads
 * ludarr grabbed and imported are ever touched, and only their own folder under the mapping — never anything in the
 * finished-downloads folder (src/synced.ts), even when a mapping points there: src/arrivals.ts removes from there exactly what
 * ludarr took for a download it imported, and nothing else. An
 * item a client does not list is closed out (its files deleted through the mapping) only once it was missing at least 3
 * times over at least 15 minutes from a client that answered (src/remote.ts goneRule): one list without it — a client
 * mid-restart, a connector that could not reach it (`unavailable`) — deletes nothing.
 */
import { stat } from "node:fs/promises";
import { removeTree } from "./fsutil";
import { resolve, sep } from "node:path";
import { stmts, type FetchRow, type GameRow } from "./db";
import { logger } from "./log";
import * as registry from "./plugins/registry";
import type { DownloadClient } from "./plugins/types";
import type { SbClient, SbItem } from "./seedbox-items";
import { record } from "./library/history";
import { goneRule, inWords } from "./remote";
import { inArrivals } from "./synced";

const log = logger("Seeding");

/** swappable in tests */
export const sgdeps = {
  clientById: (id: number): DownloadClient | null => registry.downloadClientById(id),
  settingsOf: (id: number): Record<string, unknown> => { try { return JSON.parse(registry.instanceRow(id)?.settings_json ?? "{}"); } catch { return {}; } },
  nameOf: (id: number): string => registry.instanceRow(id)?.name ?? `client ${id}`,
  rm: async (p: string) => { await removeTree(p); },
  exists: (p: string) => stat(p).then(() => true, () => false),
  now: () => Date.now(),
};

export interface SeedGoals { ratio: number; hours: number }

/** the looks that found an imported download missing from its client (fetches.trouble_json missing: the first and the latest
 *  few), this one added */
function missingSeen(r: FetchRow, nowSec: number): number[] {
  let t: { missing?: number[] } = {};
  try { t = r.trouble_json ? JSON.parse(r.trouble_json) : {}; } catch { t = {}; }
  const x = t.missing ?? [];
  const missing = x.length < 5 ? [...x, nowSec] : [x[0], ...x.slice(-3), nowSec];
  stmts.setFetchTrouble.run(JSON.stringify({ since: missing[0], tries: 0, words: "missing from its download client", ...t, missing }), r.id);
  return missing;
}

/** why the torrent may go now, or null while it should keep seeding */
export function goalMet(goals: SeedGoals, item: { ratio?: number | null; finishedAt?: number | null }, nowSec: number): string | null {
  if (goals.ratio > 0 && item.ratio != null && item.ratio >= goals.ratio) return `ratio ${item.ratio.toFixed(2)} reached`;
  if (goals.hours > 0 && item.finishedAt && nowSec - item.finishedAt >= goals.hours * 3600) return `seeded for ${Math.round((nowSec - item.finishedAt) / 3600)} h`;
  return null;
}

/** the download's own folder as ludarr sees it through the client's mapped folder — never the mapped folder itself, never anything outside it */
export function mappedPath(s: Record<string, unknown>, localPath: string | null | undefined): string | null {
  const [from, to] = String(s.pathMap ?? "").split("=").map(x => x.trim().replace(/[\\/]+$/, ""));
  if (!from || !to || !localPath) return null;
  const a = resolve(localPath), b = resolve(to);
  return a !== b && a.startsWith(b + sep) ? a : null;
}

function cleaned(r: FetchRow, note: string) {
  stmts.setFetchCleaned.run(note, r.id);
  const g = r.game_id ? (stmts.gameById.get(r.game_id) as GameRow | undefined) : undefined;
  record(r.game_id ?? null, "cleaned", { gameName: g?.name ?? null, release: r.title, source: r.client, message: note });
  log.info(`#${r.id} ${r.title}: ${note}`);
}

/** one pass over every imported download that is still in its client. Returns how many were removed. */
export async function seedingTick(): Promise<number> {
  const rows = stmts.fetchesToClean.all() as FetchRow[];
  const byInstance = new Map<number, FetchRow[]>();
  for (const r of rows) if (r.client_instance_id) byInstance.set(r.client_instance_id, [...(byInstance.get(r.client_instance_id) ?? []), r]);
  const nowSec = Math.floor(sgdeps.now() / 1000);
  let n = 0;
  for (const [id, group] of byInstance) {
    const client = sgdeps.clientById(id);
    if (!client) continue;                                                   // the client is gone or disabled: the rows wait for it
    const settings = sgdeps.settingsOf(id);                                 // only for the mapped folder; the goals are the client's own
    const goals: SeedGoals = client.seedGoals ?? { ratio: 0, hours: 0 };
    let items: SbItem[], unavailable: SbClient[] = [];
    try { const snap = await client.items(); items = snap.items; unavailable = snap.unavailable ?? []; }
    catch (e: any) { log.warn(`${sgdeps.nameOf(id)}: ${e?.message ?? e}`); continue; }
    for (const r of group) {
      if (unavailable.includes(r.client as SbClient)) continue;             // the connector could not reach that client: unknown
      const it = items.find(i => i.client === r.client && i.clientId === r.client_id) ?? null;
      let why: string;
      if (!it) {
        // missing once is nothing (a client answering mid-restart): gone after 3 times over 15 minutes
        const seen = missingSeen(r, nowSec);
        if (!goneRule(seen)) continue;
        why = `gone from the download client (removed by hand?) — missing from its list ${seen.length} times over ${inWords(seen[seen.length - 1] - seen[0])}`;
      } else {
        if (r.trouble_json) stmts.setFetchTrouble.run(null, r.id);         // listed again: the misses so far count for nothing
        if (r.protocol === "usenet") why = "imported — removed from the download client";
        else if (goals.ratio <= 0 && goals.hours <= 0) continue;              // no seed goal: it seeds for good
        else { const met = goalMet(goals, it, nowSec); if (!met) continue; why = `${met} — removed from the download client`; }
      }
      if (it) {
        try { await client.remove({ client: r.client as SbClient, clientId: r.client_id! }, true); }
        catch (e: any) { log.warn(`#${r.id} removing from ${sgdeps.nameOf(id)} failed: ${e?.message ?? e}`); continue; }
      }
      const p = mappedPath(settings, r.local_path);
      if (p && !inArrivals(p) && (await sgdeps.exists(p))) {
        try { await sgdeps.rm(p); why += ", its files deleted through the mapped folder"; }
        catch (e: any) { why += ` (its files could not be deleted: ${e?.message ?? e})`; }
      }
      cleaned(r, why); n++;
    }
  }
  return n;
}
