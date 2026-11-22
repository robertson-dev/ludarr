/** ludarr — health checks, shown in the UI's status bar and sent to Connect when something turns bad. */
import { readdir } from "node:fs/promises";
import { rootFolders, diskSpace } from "./library/rootfolders";
import * as registry from "./plugins/registry";
import { notify } from "./notify";
import { remoteHealth } from "./remote";
import { arrivalsHealth } from "./arrivals";
import { overArrivals } from "./synced";

export interface HealthItem { type: "error" | "warning" | "notice"; source: string; message: string; link?: string }

/** swappable in tests: where a new (or worse) item is sent */
export const hdeps = { notify };

let cache: { at: number; items: HealthItem[] } | null = null;
let lastKeys = new Set<string>();

export async function healthChecks(force = false): Promise<HealthItem[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.items;
  const items: HealthItem[] = [];
  const roots = rootFolders();
  if (!roots.length) items.push({ type: "error", source: "RootFolder", message: "No root folder: add one under Settings → Media management, or the import has nowhere to put games", link: "/settings/mediamanagement" });
  for (const r of roots) {
    const s = await diskSpace(r.path);
    if (s && s.free < 10e9) items.push({ type: "warning", source: "DiskSpace", message: `Root folder ${r.path} has only ${(s.free / 1e9).toFixed(1)} GB free`, link: "/settings/mediamanagement" });
    else if (!s) items.push({ type: "warning", source: "RootFolder", message: `Root folder ${r.path} is not accessible`, link: "/settings/mediamanagement" });
  }
  if (!registry.indexers().length) items.push({ type: "warning", source: "Indexer", message: "No indexer is enabled: searches cannot run", link: "/settings/indexers" });
  if (!registry.downloadClients().length) items.push({ type: "warning", source: "DownloadClient", message: "No download client is enabled: releases cannot be grabbed", link: "/settings/downloadclients" });
  // what the indexers say about themselves: Prowlarr marks failing or rate-limited indexers unavailable, which otherwise only shows as an empty search
  for (const { row, indexer } of registry.indexers()) {
    if (!indexer.health) continue;
    const list = await Promise.race([indexer.health(), new Promise<null>(r => setTimeout(() => r(null), 10_000))]).catch(() => null);
    if (list === null) { items.push({ type: "warning", source: "Indexer", message: `${row.name} did not answer its health check`, link: "/settings/indexers" }); continue; }
    for (const h of list) items.push({ type: h.type, source: "Indexer", message: `${row.name}: ${h.message}`, link: "/settings/indexers" });
  }
  // the seedbox: a mapped folder down for 2 h (a warning; 6 h an error, which notifies), downloads and imports waiting on it
  const seedbox = remoteHealth();
  // remote path mappings: the folder a client's downloads are read from must be there and answer (a dead mount is an empty or
  // hanging folder) — one line per folder, whichever clients map it, and none once the seedbox's own line says it
  const mapped = new Map<string, string[]>();
  for (const { row } of registry.downloadClients()) {
    let s: Record<string, unknown> = {}; try { s = JSON.parse(row.settings_json); } catch { /* unreadable settings are reported elsewhere */ }
    const [, to] = String(s.pathMap ?? "").split("=").map(x => x.trim().replace(/[\\/]+$/, ""));
    // (one onto the finished-downloads folder is no mount: its own line says so, src/arrivals.ts)
    if (to && !overArrivals(to)) mapped.set(to, [...(mapped.get(to) ?? []), row.name]);
  }
  for (const [to, names] of mapped) {
    if (seedbox.some(h => h.message.startsWith(`the seedbox folder ${to} (`))) continue;
    const entries = await Promise.race([readdir(to), new Promise<null>(r => setTimeout(() => r(null), 10_000))]).catch(() => null);
    if (entries === null) items.push({ type: "warning", source: "RemotePathMapping", message: `${names.join(", ")}: the mapped folder ${to} is not reachable — is the mount up?`, link: "/settings/downloadclients" });
    else if (!entries.length) items.push({ type: "notice", source: "RemotePathMapping", message: `${names.join(", ")}: the mapped folder ${to} is empty — is the mount up?`, link: "/settings/downloadclients" });
  }
  items.push(...seedbox);
  // the finished-downloads folder (src/arrivals.ts): the folder itself, the downloads that do not arrive, the holds on their files
  items.push(...(await arrivalsHealth().catch(() => [])));
  const agent = registry.instanceRows("importer").find(r => r.impl === "agent");
  const agentKey = (() => { try { return !!JSON.parse(agent?.settings_json ?? "{}").apiKey; } catch { return false; } })();
  if (!agent?.enabled || !agentKey) items.push({ type: "notice", source: "Importer", message: "The AI importer has no API key: downloads the automatic recipes cannot open will wait for one", link: "/settings/importers" });
  for (const p of registry.pluginRows()) if (p.error) items.push({ type: "warning", source: "Plugin", message: `Plugin ${p.id} failed to load: ${p.error}`, link: "/settings/plugins" });
  cache = { at: Date.now(), items };
  // a notification for each item that is new — or that turned worse (the same words, a warning become an error: the seedbox's
  // 6 h escalation says nothing new in its words)
  const keyOf = (i: HealthItem) => `${i.type}:${i.source}:${i.message}`;
  const keys = new Set(items.filter(i => i.type !== "notice").map(keyOf));
  for (const i of items) if (i.type !== "notice" && !lastKeys.has(keyOf(i))) void hdeps.notify("health", { title: `Health ${i.type}: ${i.source}`, message: i.message });
  lastKeys = keys;
  return items;
}
