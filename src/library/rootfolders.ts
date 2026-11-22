/** ludarr — root folders: where imported games live. The first one is the default; a game can pin another. */
import { mkdirSync, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stmts, type GameRow, type RootFolderRow } from "../db";
import { workDir } from "../config";
import { provideRootFolders } from "../plugins/registry";

export class RootFolderError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

export const rootFolders = () => stmts.rootFolders.all() as RootFolderRow[];
export const rootFolder = (id: number) => stmts.rootFolder.get(id) as RootFolderRow | undefined;

/** on a fresh database: the games volume from the environment (LUDARR_GAMES, or Ahoy's AHOY_LIBRARY), else nothing */
export function ensureDefaultRootFolder() {
  if (rootFolders().length) return;
  const p = process.env.LUDARR_GAMES || process.env.AHOY_LIBRARY || (process.env.LUDARR_CONFIG ? "/games" : "");
  if (!p) return;
  try { mkdirSync(p, { recursive: true }); stmts.insertRootFolder.run(resolve(p), null); } catch { /* not writable: the health check will say so */ }
}

export function addRootFolder(path: string, name?: string | null): RootFolderRow {
  const p = resolve(path.trim());
  if (!p) throw new RootFolderError("a path is required");
  if (stmts.rootFolderByPath.get(p)) throw new RootFolderError("that root folder already exists", 409);
  try { mkdirSync(p, { recursive: true }); } catch (e: any) { throw new RootFolderError(`cannot create ${p}: ${e?.message ?? e}`); }
  if (!existsSync(p)) throw new RootFolderError(`${p} does not exist`);
  return stmts.insertRootFolder.get(p, name?.trim() || null) as RootFolderRow;
}

export function removeRootFolder(id: number) {
  const r = rootFolder(id);
  if (!r) throw new RootFolderError("no such root folder", 404);
  const n = (stmts.gamesInRootFolder.get(id) as { n: number }).n;
  if (n) throw new RootFolderError(`${n} game${n === 1 ? " uses" : "s use"} this root folder`, 409);
  stmts.deleteRootFolder.run(id);
}

/** the folder a game's import lands in: its own root folder, else the first */
export function rootFolderFor(game?: Pick<GameRow, "root_folder_id"> | null): RootFolderRow | null {
  return (game?.root_folder_id ? rootFolder(game.root_folder_id) : null) ?? rootFolders()[0] ?? null;
}

/** scratch space for imports: the configured work folder, else .work inside the root folder (same volume → the final move is a rename) */
export function workDirFor(root: RootFolderRow): string {
  return workDir() || join(root.path, ".work");
}

export async function diskSpace(path: string): Promise<{ free: number; total: number } | null> {
  try { const s = await statfs(path); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; }
  catch { return null; }
}

export async function serializeRootFolder(r: RootFolderRow) {
  const space = await diskSpace(r.path);
  return { id: r.id, path: r.path, name: r.name, accessible: existsSync(r.path), freeSpace: space?.free ?? null, totalSpace: space?.total ?? null, games: (stmts.gamesInRootFolder.get(r.id) as { n: number }).n, createdAt: r.created_at };
}

provideRootFolders(() => rootFolders().map(r => r.path));
