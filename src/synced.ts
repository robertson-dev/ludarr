/**
 * ludarr — the finished-downloads folder: the folder on this server where everything the download clients finish ends up.
 * On the user's server that is downloads/finished: their own sync (an rclone move of the seedbox's finished folder every few
 * minutes, the one their Sonarr and Radarr import from) brings every download there, torrents and usenet alike.
 *
 * One global setting, LUDARR_ARRIVALS ("Finished downloads land in", Settings → Media Management), /arrivals by default:
 * the container's mount of downloads/finished (deploy/unraid.py). It is on when it is set and that folder is there — a finished
 * download is then never transferred: src/arrivals.ts finds it there by its name and imports it in place. Emptied, or with
 * no such folder, downloads go as before.
 *
 * Only the settings and the database are read here: the monitor (src/remote.ts), the download worker (src/fetch.ts), the
 * content intake and src/arrivals.ts all use it.
 */
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { arrivalsSetting, CONFIG_KEYS } from "./config";
import { db, kv } from "./db";
import { logger } from "./log";

/** the setting's key (src/config.ts: read there by arrivalsSetting, the folder as set — "" when it is not: off) */
export const ARRIVALS_KEY = "LUDARR_ARRIVALS";
export { arrivalsSetting };

/** the finished-downloads folder while the feature is on — set, and a folder there; null: off, downloads go as before */
export function arrivalsDir(): string | null {
  const p = arrivalsSetting();
  if (!p) return null;
  try { return statSync(p).isDirectory() ? p : null; } catch { return null; }
}

const inside = (p: string, dir: string) => { const a = resolve(p), b = resolve(dir); return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep); };
/** a folder here that is the finished-downloads folder, is in it or holds it (`dir`: that folder, by default while it is on) —
 *  a download client's remote path there is not the seedbox's own folder: src/remote.ts leaves it out while the folder is on,
 *  and the health list says so (src/arrivals.ts) */
export function overArrivals(p: string | null | undefined, dir: string | null = arrivalsDir()): boolean {
  return !!p && !!dir && (inside(p, dir) || inside(dir, p));
}
/** a path in the finished-downloads folder as set (there or not): the seeding task never deletes anything in it, whatever a
 *  download client's mapped folder says (src/seeding.ts) — only src/arrivals.ts removes from there, and only exactly what
 *  ludarr took for a download it imported */
export function inArrivals(p: string | null | undefined): boolean {
  const dir = arrivalsSetting();
  return !!p && !!dir && inside(p, dir);
}

/**
 * At boot, once: a folder set the old way — a download client's "Synced folder", `<the seedbox folder>=<the folder here>`
 * (2026-11-09, never deployed) — becomes the setting: the folder here of the first enabled client that had one, unless the
 * setting was saved already (it is not saved when it is the default anyway). Both old per-client settings (that one and its
 * quiet time) are removed from every client. Returns the folder taken over (null: none) and how many clients were cleaned.
 */
export function migrateSyncMap(): { moved: string | null; cleaned: number } {
  type Row = { id: number; name: string; enabled: number; settings_json: string };
  let rows: Row[];
  try { rows = db.query("SELECT id, name, enabled, settings_json FROM plugin_instances WHERE kind='downloadClient' ORDER BY enabled DESC, priority, id").all() as Row[]; }
  catch { return { moved: null, cleaned: 0 }; }                       // (no clients table yet: nothing was ever saved)
  let found: { to: string; client: string } | null = null, cleaned = 0;
  for (const r of rows) {
    let s: Record<string, unknown> | null = null;
    try { s = JSON.parse(r.settings_json); } catch { /* unreadable: left as it is */ }
    if (!s || typeof s !== "object" || !("syncMap" in s || "arrivalQuietMin" in s)) continue;
    const raw = String(s.syncMap ?? "").trim(), at = raw.indexOf("=");
    const to = at < 0 ? "" : raw.slice(at + 1).trim().replace(/[\\/]+$/, "");
    if (to && r.enabled && !found) found = { to, client: r.name };
    delete s.syncMap; delete s.arrivalQuietMin;
    db.query("UPDATE plugin_instances SET settings_json=?, updated_at=unixepoch() WHERE id=?").run(JSON.stringify(s), r.id);
    cleaned++;
  }
  let moved: string | null = null;
  if (found && kv.get("cfg." + ARRIVALS_KEY) == null) {
    moved = found.to;
    if (found.to !== CONFIG_KEYS.find(k => k.key === ARRIVALS_KEY)?.def) kv.set("cfg." + ARRIVALS_KEY, found.to);
  }
  if (cleaned) logger("Settings").info(`the download clients' old per-client folder setting is gone (${cleaned} client${cleaned === 1 ? "" : "s"})${moved ? `: ${found!.client}'s folder (${moved}) is now "Finished downloads land in"` : found ? `: "Finished downloads land in" was set already (${arrivalsSetting() || "empty"}), ${found.client}'s folder (${found.to}) is not taken over` : ""}`);
  return { moved, cleaned };
}
