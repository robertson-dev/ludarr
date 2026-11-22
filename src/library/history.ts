/** ludarr — what happened to a game, as a timeline; the events that matter also go out to Connect. */
import { stmts, type HistoryRow } from "../db";
import { notify } from "../notify";
import type { NotifyEvent } from "../plugins/types";

/** edited: how the game's copy starts was set or reset by hand, or a start set by hand was not in a new copy (src/library/launch.ts) */
/** left: a download in the finished-downloads folder ludarr held for its import was let go, and nothing of it there is deleted
 *  (its import did not go through, it was imported from the seedbox instead …); removed: what ludarr took there for a download
 *  it imported was deleted from that folder (or, with the admin's OK, a download of ludarr's it had left there before) —
 *  src/arrivals.ts */
export type HistoryEvent = "grabbed" | "downloaded" | "downloadFailed" | "imported" | "importFailed" | "failed" | "upgraded" | "deleted" | "blocklisted" | "added" | "cleaned" | "cracked" | "edited" | "left" | "removed";
const NOTIFY: Partial<Record<HistoryEvent, NotifyEvent>> = { grabbed: "grab", imported: "download", upgraded: "upgrade", failed: "failed", deleted: "delete" };
const TITLE: Record<HistoryEvent, string> = { cleaned: "Removed from the download client", cracked: "Cracked",
  grabbed: "Grabbed", downloaded: "Downloaded", downloadFailed: "Download failed", imported: "Imported", importFailed: "Import failed",
  failed: "Failed", upgraded: "Upgraded", deleted: "Deleted", blocklisted: "Blocklisted", added: "Added", edited: "Edited",
  left: "Left in the finished-downloads folder", removed: "Removed from the finished-downloads folder",
};

export function record(gameId: number | null, event: HistoryEvent, o: { gameName?: string | null; release?: string | null; source?: string | null; message?: string | null; data?: Record<string, unknown> } = {}) {
  // a job that ends just after its game was deleted still says what happened, without the game it no longer has
  if (gameId != null && !stmts.gameById.get(gameId)) gameId = null;
  const row = stmts.insertHistory.get(gameId, event, o.release ?? null, o.source ?? null, o.message ?? null, o.data ? JSON.stringify(o.data) : null) as HistoryRow;
  const ev = NOTIFY[event];
  if (ev) void notify(ev, { gameId, gameName: o.gameName ?? null, title: `${TITLE[event]}: ${o.gameName ?? o.release ?? "game"}`, message: [o.release, o.message].filter(Boolean).join("\n") || TITLE[event], release: o.release ?? null, data: o.data });
  return row;
}

export function serializeHistory(h: HistoryRow) {
  let data: unknown = null;
  try { data = h.data_json ? JSON.parse(h.data_json) : null; } catch { /* ignore */ }
  return { id: h.id, gameId: h.game_id, gameName: h.game_name ?? null, event: h.event, label: TITLE[h.event as HistoryEvent] ?? h.event, release: h.release, source: h.source, message: h.message, data, at: h.created_at };
}
