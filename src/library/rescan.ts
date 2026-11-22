/**
 * ludarr — the library on disk against the database, like *arr's "Rescan": a copy that was deleted by hand
 * stops counting (its game is missing again and, when monitored, gets searched), and a folder in a root folder
 * that belongs to no game is listed so it can be imported by hand. A root folder that cannot be read, or reads
 * empty while copies are recorded in it (an unmounted volume), is left alone rather than emptied out, and a copy counts as
 * deleted only when its folder is not there (ENOENT): a look the volume failed (EIO, a timeout, a stale handle on a busy
 * array) says nothing, and the copy stays.
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { stmts, type GameRow, type PackageRow, type RootFolderRow } from "../db";
import { events } from "../events";
import { logger } from "../log";
import { record } from "./history";
import { rootFolders } from "./rootfolders";
import { unbuildWays } from "../ways/store";

const log = logger("Rescan");

/** swappable in tests */
export const rsdeps = {
  /** true / false (not there: ENOENT, ENOTDIR) / null (the volume could not say) */
  exists: (p: string): Promise<boolean | null> => stat(p).then(() => true, (e: { code?: string }) => (e?.code === "ENOENT" || e?.code === "ENOTDIR" ? false : null)),
  list: (p: string) => readdir(p, { withFileTypes: true }),
  rootFolders: (): RootFolderRow[] => rootFolders(),
};

const under = (p: string, dir: string) => { const a = resolve(p), b = resolve(dir); return a === b || a.startsWith(b + sep); };

export async function rescanLibrary(): Promise<{ missing: number; skipped: string[] }> {
  const roots = rsdeps.rootFolders();
  const pkgs = stmts.packagesAll.all() as PackageRow[];
  const judgeable = new Map<number, boolean>();
  const skipped: string[] = [];
  for (const r of roots) {
    const entries = await rsdeps.list(r.path).catch(() => null);
    const hasCopies = pkgs.some(p => under(p.path, r.path));
    const ok = !!entries && !(hasCopies && entries.length === 0);
    judgeable.set(r.id, ok);
    if (!ok) skipped.push(r.path);
  }
  let missing = 0;
  for (const p of pkgs) {
    const root = roots.find(r => under(p.path, r.path));
    if (root && !judgeable.get(root.id)) continue;                           // cannot tell: the volume may just be down
    const there = await rsdeps.exists(p.path);
    if (there !== false) { if (there === null) skipped.push(p.path); continue; }   // there, or the volume could not say
    stmts.deletePackage.run(p.id);
    unbuildWays(p.id, "its copy is gone from disk");                       // the package event below refreshes the catalog
    const g = p.game_id ? (stmts.gameById.get(p.game_id) as GameRow | undefined) : undefined;
    if (p.game_id) stmts.setGamePath.run(null, p.game_id);
    record(p.game_id ?? null, "deleted", { gameName: g?.name ?? p.name, release: p.name, source: "rescan", message: `the copy at ${p.path} is gone from disk` });
    events.emit("package", { id: p.id, deleted: true });
    log.info(`${g?.name ?? p.name}: the copy at ${p.path} is gone from disk`);
    missing++;
  }
  if (skipped.length) log.warn(`not judged — unreadable, or empty while copies are recorded there: ${skipped.join(", ")}`);
  return { missing, skipped };
}

export interface UnmappedFolder { name: string; path: string; modifiedAt: number | null }

/** folders in a root folder that no package accounts for (a hand-made copy, a leftover): candidates for a hand import */
export async function unmappedFolders(root: RootFolderRow): Promise<UnmappedFolder[]> {
  const known = new Set((stmts.packagesAll.all() as PackageRow[]).map(p => resolve(p.path)));
  const out: UnmappedFolder[] = [];
  for (const e of await rsdeps.list(root.path).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const full = join(root.path, e.name);
    if (known.has(resolve(full))) continue;
    const s = await stat(full).catch(() => null);
    out.push({ name: e.name, path: full, modifiedAt: s ? Math.floor(s.mtimeMs / 1000) : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
