/**
 * ludarr — one item shape for whatever the seedbox client is.
 * Both the fetch pipeline (direct mode) and the bosun connector map rtorrent/nzbget rows through here,
 * so the pipeline's state machine never has to know which client it is talking to.
 */
import type { RtItem } from "./rtorrent";
import type { NzbItem } from "./nzbget";

export type SbClient = "rtorrent" | "nzbget";
export type SbState = "downloading" | "paused" | "done" | "failed";

export interface SbItem {
  id: string;              // "rt:<HASH>" | "nz:<NZBID>"
  client: SbClient;
  clientId: string;        // info-hash (uppercase) | NZBID as string
  name: string;
  state: SbState;
  progress: number;        // 0..1
  sizeBytes: number;
  doneBytes: number;
  downRate: number;
  path: string | null;     // where the payload lives on the seedbox once known
  isDir: boolean;
  message: string;         // client status text / error
  label: string;
  ratio?: number | null;       // torrents: upload / download
  finishedAt?: number | null;  // unix seconds when it completed (rTorrent's d.timestamp.finished, NZBGet's HistoryTime)
  peers?: number | null;       // torrents: peers connected (undefined: the client did not say — an older connector)
  seeders?: number | null;     // torrents: connected peers that have it all
  checking?: boolean;          // torrents: the client is hashing its data
  downloadedBytes?: number | null;  // usenet, finished: what NZBGet downloaded (its DownloadedSize; the par2 it did not need excluded)
}

export const itemId = (client: SbClient, clientId: string) => `${client === "rtorrent" ? "rt" : "nz"}:${clientId}`;

export function parseItemId(id: string): { client: SbClient; clientId: string } | null {
  const m = /^(rt|nz):(.+)$/.exec(id);
  if (!m) return null;
  return m[1] === "rt" ? { client: "rtorrent", clientId: m[2].toUpperCase() } : { client: "nzbget", clientId: m[2] };
}

export function fromRtorrent(it: RtItem): SbItem {
  return {
    id: itemId("rtorrent", it.hash), client: "rtorrent", clientId: it.hash, name: it.name,
    state: it.complete ? "done" : it.active ? "downloading" : "paused",
    progress: it.sizeBytes ? Math.min(1, it.completedBytes / it.sizeBytes) : 0,
    sizeBytes: it.sizeBytes, doneBytes: it.completedBytes, downRate: it.downRate,
    path: it.dataPath, isDir: it.multiFile, message: it.message, label: it.label, ratio: it.ratio, finishedAt: it.finishedAt,
    ...(it.peers != null ? { peers: it.peers, seeders: it.seeders ?? 0 } : {}), ...(it.hashing ? { checking: true } : {}),
  };
}

export function fromNzbget(it: NzbItem): SbItem {
  const id = String(it.id);
  const base = { id: itemId("nzbget", id), client: "nzbget" as const, clientId: id, name: it.name, sizeBytes: it.sizeBytes, downRate: 0, label: it.category, message: it.status };
  if (it.inHistory) {
    const ok = /^(SUCCESS|WARNING)/.test(it.status);
    return { ...base, state: ok ? "done" : "failed", progress: ok ? 1 : 0, doneBytes: ok ? it.sizeBytes : 0, path: ok ? (it.finalDir || it.destDir || null) : null, isDir: true, ...(ok && it.downloadedBytes > 0 ? { downloadedBytes: it.downloadedBytes } : {}), ...(it.historyTime ? { finishedAt: it.historyTime } : {}) };
  }
  const done = Math.max(0, it.sizeBytes - it.remainingBytes);
  return {
    ...base, state: /PAUSED/.test(it.status) ? "paused" : "downloading",
    progress: it.sizeBytes ? Math.max(0, Math.min(1, done / it.sizeBytes)) : 0, doneBytes: done, path: null, isDir: true,
  };
}
