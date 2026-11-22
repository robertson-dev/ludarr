/**
 * ludarr — uploads: a game's files sent from the admin's own PC (one archive, an installer with its parts, a whole game
 * folder) for any game in the library, added by hand or not.
 *
 *   session   createUpload: a row and a folder of its own, <root folder>/.ahoy-uploads/<id>/<name>/ — on the library's
 *             volume, where the room is and where the import's scratch folder and the content store are
 *   pieces    writePiece: a piece of one file appended at `offset`. A file is <path>.ahoy-part until its last byte is in,
 *             then it takes its name. A piece sent at another offset than the bytes that are there is refused with how
 *             many there are (`received`), so a sender that lost its place just goes on from there (whereFile says the
 *             same without sending anything). One piece of a file is written at a time: a newer piece of the same file
 *             takes over from one whose sender went quiet, and a piece that brings nothing for STALL_MS ends by itself
 *   resume    the folder is the state (uploadFiles lists it). The same files picked again for the same game are the same
 *             session, and only what is missing is sent
 *   finish    finishUpload: every file whole, their number and bytes as announced → a job
 *               the game's copy      an ordinary import of the folder (src/process/runner.ts): unpacked, installed, checked,
 *                                    moved into the library — in place of the copy the game has, as any import
 *               a way's game file    a content job (src/ways/content.ts): judged for the way and kept in the store
 *   after     the job done: the upload's folder goes (it was ludarr's own copy; the admin has theirs). Failed or
 *             cancelled: the files stay for "Try again" (also the other way: as the copy, or for a way), and go once
 *             nothing touched them for KEEP_DAYS — as an upload nobody finished does
 *
 * Only files and folders are ever made here, each by its own name inside the upload's folder: a name with a separator, a
 * dot segment or a control character is refused before anything is written, and nothing is written through a folder that
 * leads elsewhere.
 */
import { lstat, mkdir, open, readdir, realpath, rename, truncate } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { db, serializeJob, stmts, type GameRow, type JobRow, type PackageRow, type RequestRow } from "./db";
import { events } from "./events";
import { removeTree } from "./fsutil";
import { logger } from "./log";
import { onGameChange } from "./library/games";
import { diskSpace, rootFolderFor, rootFolders } from "./library/rootfolders";
import { enqueueJob } from "./process/kinds";
import { cancelJob, replaceRefusal } from "./process/runner";
import { cancelRequest } from "./requests";
import { archiveSet, keepFreeBytes, sizeWords } from "./ways/content";
import { SANDBOX_UIDS } from "./ways/sandbox";
import { getWay } from "./ways/store";

const log = logger("uploads");

db.exec(`
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  name TEXT NOT NULL,                        -- what was picked: the archive's name, the folder's
  files INTEGER NOT NULL,                    -- how many files it is, as announced
  bytes INTEGER NOT NULL,                    -- and their bytes
  received INTEGER NOT NULL DEFAULT 0,
  way_id INTEGER,                            -- null: the game's copy; a way: its game file
  replace INTEGER NOT NULL DEFAULT 0,        -- the copy may take the place of a built way
  state TEXT NOT NULL DEFAULT 'uploading',   -- uploading | importing | failed | removing
  job_id INTEGER,
  dir TEXT NOT NULL DEFAULT '',              -- <root folder>/.ahoy-uploads/<id>
  message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  touched_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_uploads_game ON uploads(game_id);
`);

export interface UploadRow {
  id: number; game_id: number; name: string; files: number; bytes: number; received: number; way_id: number | null; replace: number;
  state: "uploading" | "importing" | "failed" | "removing"; job_id: number | null; dir: string; message: string | null; created_at: number; touched_at: number;
}

/** the folder every upload lives under, in its game's root folder */
export const UPLOADS = ".ahoy-uploads";
/** a file that is not whole yet */
export const PART = ".ahoy-part";
/** an upload nobody finished, or whose job failed, goes once nothing touched it for this long */
export const KEEP_DAYS = 7;
const MAX_FILES = 200_000;
/** a name on the disk holds 255 bytes, and a file that is not whole yet carries PART behind its own */
const MAX_NAME_BYTES = 255 - PART.length;
const ACTIVE = new Set(["queued", "running"]);
const posix = process.platform !== "win32";

export class UploadError extends Error {
  constructor(msg: string, public status: 400 | 404 | 409 | 413 | 507 = 400, public extra: Record<string, unknown> = {}) { super(msg); }
}

/** swapped in tests */
export const udeps = {
  diskSpace: (p: string) => diskSpace(p),
  keepFree: (): number => keepFreeBytes(),
  now: (): number => Date.now(),
  /** the build programs' users: a folder one of them made is never written into */
  sandboxUids: (): number[] => SANDBOX_UIDS,
  /** a piece that brings no byte for this long is over: its sender is gone without saying so (a laptop asleep, a line
   *  that dropped without a word), and the file is free for the piece that comes next */
  stallMs: 90_000,
  /** how long a newer piece of a file, or a removal, waits for the piece being written to let go of the file */
  yieldMs: 5_000,
};

const q = {
  byId: db.query("SELECT * FROM uploads WHERE id=?"),
  byJob: db.query("SELECT * FROM uploads WHERE job_id=?"),
  ofGame: db.query("SELECT * FROM uploads WHERE game_id=? ORDER BY id DESC"),
  all: db.query("SELECT * FROM uploads ORDER BY id DESC"),
  same: db.query("SELECT * FROM uploads WHERE game_id=? AND name=? AND files=? AND bytes=? AND state='uploading' AND dir<>'' ORDER BY id DESC LIMIT 1"),
  insert: db.query("INSERT INTO uploads (game_id, name, files, bytes, way_id, replace) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"),
  setDir: db.query("UPDATE uploads SET dir=? WHERE id=?"),
  setFor: db.query("UPDATE uploads SET way_id=?, replace=?, touched_at=unixepoch() WHERE id=?"),
  setReceived: db.query("UPDATE uploads SET received=?, touched_at=unixepoch() WHERE id=?"),
  setState: db.query("UPDATE uploads SET state=?, job_id=?, message=?, touched_at=unixepoch() WHERE id=?"),
  remove: db.query("DELETE FROM uploads WHERE id=?"),
};

export const getUpload = (id: number): UploadRow | null => (q.byId.get(id) as UploadRow | null) ?? null;
export const uploadsOfGame = (gameId: number): UploadRow[] => q.ofGame.all(gameId) as UploadRow[];
export const allUploads = (): UploadRow[] => q.all.all() as UploadRow[];

export function serializeUpload(u: UploadRow) {
  const job = u.job_id != null ? (stmts.jobById.get(u.job_id) as JobRow | undefined) : undefined;
  return {
    id: u.id, gameId: u.game_id, name: u.name, files: u.files, bytes: u.bytes, received: Math.min(u.received, u.bytes), wayId: u.way_id, replace: !!u.replace,
    state: u.state, jobId: u.job_id, job: job ? { id: job.id, kind: job.kind ?? "import", state: job.state, progress: Math.round((job.progress ?? 0) * 1000) / 1000, message: job.message } : null,
    message: u.message, createdAt: u.created_at, touchedAt: u.touched_at,
    /** when its files go by themselves (an upload that waits: unfinished, or its job failed) */
    expiresAt: u.state === "uploading" || u.state === "failed" ? u.touched_at + KEEP_DAYS * 86_400 : null,
  };
}
export type UploadView = ReturnType<typeof serializeUpload>;

/** told at most once a second per upload while its pieces come in; a change of state at once */
const told = new Map<number, number>();
function tell(u: UploadRow | null, now = false) {
  if (!u) return;
  const t = udeps.now();
  if (!now && t - (told.get(u.id) ?? 0) < 1000) return;
  told.set(u.id, t);
  events.emit("upload", serializeUpload(u));
}

/* ─────────── names ─────────── */

/** a control character (or DEL) anywhere in a name */
const hasControl = (s: string) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; };

/** the upload's own folder name: what was picked, as one plain name no longer than a disk takes */
function folderNameOf(name: string): string {
  let out = "";
  for (const ch of name) { const c = ch.charCodeAt(0); out += c < 32 || c === 127 || '/\\<>:"|?*'.includes(ch) ? " " : ch; }
  out = out.replace(/\s+/g, " ").trim().replace(/^[. ]+/, "");
  // cut by bytes, at a whole character (a name in another script takes up to four bytes a letter)
  let cut = "", n = 0;
  for (const ch of out) { const b = Buffer.byteLength(ch); if (n + b > 200) break; cut += ch; n += b; }
  return cut.replace(/[. ]+$/, "");
}

/** a file's path inside the upload, as its parts: plain names only */
export function cleanPath(path: unknown): string[] {
  if (typeof path !== "string" || !path) throw new UploadError("path= is required: the file's path inside the upload (bin/game.exe)");
  if (path.length > 4096) throw new UploadError("the file's path is too long");
  if (path.includes("\\")) throw new UploadError(`${path}: a path inside the upload is written with forward slashes`);
  const parts = path.split("/");
  if (parts.length > 64) throw new UploadError(`${path}: too many folders deep`);
  for (const p of parts) {
    if (!p || p === "." || p === "..") throw new UploadError(`${path}: not a plain path inside the upload`);
    if (hasControl(p)) throw new UploadError("a file's name holds a control character");
    if (Buffer.byteLength(p) > MAX_NAME_BYTES) throw new UploadError(`${path}: a name in it is longer than the server's disk takes (${MAX_NAME_BYTES} bytes)`);
    if (p.toLowerCase().endsWith(PART)) throw new UploadError(`${path}: a name ending in ${PART} is ludarr's own for a file that is not whole yet`);
  }
  return parts;
}

/** the folder the upload's files are in; an upload whose folder was never recorded has none */
function dataDir(u: UploadRow): string {
  if (!u.dir) throw new UploadError("this upload has no folder on the server: remove it and send it again", 409);
  return join(u.dir, folderNameOf(u.name) || `upload-${u.id}`);
}
const inside = (p: string, dir: string) => p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/* ─────────── what is there ─────────── */

export interface UploadFile { path: string; size: number; done: boolean }

/** every file of the upload that is there, whole or in part (links and anything else are never ours: passed over) */
export async function uploadFiles(u: UploadRow): Promise<UploadFile[]> {
  const out: UploadFile[] = [];
  if (!u.dir) return out;
  const walk = async (dir: string, rel: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(join(dir, e.name), r); continue; }
      if (!e.isFile()) continue;
      const st = await lstat(join(dir, e.name)).catch(() => null);
      if (!st) continue;
      const part = e.name.endsWith(PART);
      out.push({ path: part ? r.slice(0, -PART.length) : r, size: st.size, done: !part });
    }
  };
  await walk(dataDir(u), "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** what each upload holds, counted once from its folder and kept as its pieces come in */
const tally = new Map<number, { files: number; bytes: number }>();
async function tallyOf(u: UploadRow): Promise<{ files: number; bytes: number }> {
  let t = tally.get(u.id);
  if (!t) {
    const files = await uploadFiles(u);
    t = tally.get(u.id) ?? { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
    tally.set(u.id, t);
  }
  return t;
}

/* ─────────── a session ─────────── */

export interface CreateBody { name?: unknown; files?: unknown; bytes?: unknown; wayId?: unknown; replace?: unknown }

const whole = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : null);

/** the game's way an upload is for (null: the game's copy), or why not */
function wayFor(game: GameRow, wayId: unknown): number | null {
  if (wayId === undefined || wayId === null || wayId === "") return null;
  const id = whole(wayId);
  const w = id ? getWay(id) : null;
  if (!w || w.game_id !== game.id) throw new UploadError(`${game.name} has no such way to play`, 404);
  return w.id;
}

/** a copy uploaded for a game that plays through a built way takes its place only when the admin says so */
function replaceCheck(game: GameRow, wayId: number | null, replace: boolean) {
  if (wayId != null) return;
  const current = (stmts.packageForGame.get(game.id) as PackageRow | undefined) ?? null;
  if (replaceRefusal(current, "import", replace))
    throw new UploadError(`${game.name} plays through a way to play that ludarr built: a copy uploaded here takes its place only when you say so`, 409, { needsReplace: true });
}

/** why <root folder>/.ahoy-uploads is not ludarr's own plain folder (a link, or one a build program made), or null */
async function baseTrouble(base: string): Promise<string | null> {
  const st = await lstat(base).catch(() => null);
  if (!st) return `${base} is not there`;
  if (st.isSymbolicLink() || !st.isDirectory()) return `${base} is not a plain folder: ludarr writes no upload through it`;
  if (posix && udeps.sandboxUids().includes(st.uid)) return `${base} was made by a build program: ludarr writes no upload into it`;
  return null;
}

/** <root folder>/.ahoy-uploads as a plain folder of ludarr's own, made when missing */
async function baseFor(game: GameRow): Promise<string> {
  const root = rootFolderFor(game);
  if (!root) throw new UploadError("no root folder: add one under Settings → Media management", 409);
  const real = await realpath(root.path).catch(() => null);
  if (!real) throw new UploadError(`the root folder ${root.path} is not there: is its volume mounted?`, 409);
  const base = join(real, UPLOADS);
  await mkdir(base, { recursive: true });
  const why = await baseTrouble(base);
  if (why) throw new UploadError(why, 409);
  return base;
}

/** the row and its folder's name in one step: a row is never left without the folder it belongs to */
const insertWithDir = db.transaction((base: string, gameId: number, name: string, files: number, bytes: number, wayId: number | null, replace: number): UploadRow => {
  const row = q.insert.get(gameId, name, files, bytes, wayId, replace) as UploadRow;
  q.setDir.run(join(base, String(row.id)), row.id);
  return q.byId.get(row.id) as UploadRow;
});

/**
 * A new upload for the game, or the one already under way for the very same pick (its name, how many files, their bytes):
 * then nothing is made, and the sender goes on with what is missing.
 */
export async function createUpload(gameId: number, b: CreateBody): Promise<{ row: UploadRow; resumed: boolean }> {
  const game = stmts.gameById.get(gameId) as GameRow | undefined;
  if (!game) throw new UploadError("no such game", 404);
  const name = typeof b.name === "string" ? folderNameOf(b.name) : "";
  if (!name) throw new UploadError("name is required: what is being uploaded (the archive's name, the folder's)");
  const files = whole(b.files), bytes = whole(b.bytes);
  if (!files || files > MAX_FILES) throw new UploadError(`files: how many files the upload is (1 to ${MAX_FILES.toLocaleString("en-US")}; zip a folder of more than that first)`);
  if (!bytes) throw new UploadError("bytes: the size of all its files together");
  const wayId = wayFor(game, b.wayId);
  const replace = b.replace === true;
  replaceCheck(game, wayId, replace);
  const same = q.same.get(gameId, name, files, bytes) as UploadRow | null;
  if (same) {
    q.setFor.run(wayId, replace ? 1 : 0, same.id);
    return { row: getUpload(same.id)!, resumed: true };
  }
  const base = await baseFor(game);
  const space = await udeps.diskSpace(base);
  const keep = udeps.keepFree();
  if (space && space.free < bytes + keep)
    throw new UploadError(`the library has ${sizeWords(space.free)} free: this upload is ${sizeWords(bytes)}, and ludarr keeps ${sizeWords(keep)} free there (Settings → Media management)`, 507);
  let row: UploadRow;
  for (let tries = 0; ; tries++) {
    row = insertWithDir(base, gameId, name, files, bytes, wayId, replace ? 1 : 0);
    try { await mkdir(row.dir); }                        // new with the row: a folder of that number already there is not ours
    catch (e: any) {
      q.remove.run(row.id);
      // left by an earlier database (its numbers began again): never touched here — the next number is taken instead
      if (e?.code === "EEXIST" && tries < 100) continue;
      throw new UploadError(`could not make the upload's folder ${row.dir}: ${e?.message ?? e}`, 409);
    }
    try { await mkdir(dataDir(row)); }
    catch (e: any) {
      q.remove.run(row.id);
      await removeTree(row.dir).catch(() => {});         // made a moment ago, and empty
      throw new UploadError(`could not make the upload's folder ${row.dir}: ${e?.message ?? e}`, 409);
    }
    break;
  }
  tally.set(row.id, { files: 0, bytes: 0 });
  log.info(`upload ${row.id} for ${game.name}: ${name} (${files} file${files === 1 ? "" : "s"}, ${sizeWords(bytes)})${wayId != null ? ` for way ${wayId}` : ""}`);
  tell(row, true);
  return { row, resumed: false };
}

/* ─────────── pieces ─────────── */

/** a piece being written: `stop` ends it at once (a newer piece of the same file, a removal, a sender gone quiet) and
 *  `ended` resolves once it has let go of the file */
interface Writer { upload: number; stop: (why: string) => void; ended: Promise<void> }
/** the files being written right now, by "<upload>:<path>": one piece of a file at a time */
const writing = new Map<string, Writer>();
/** uploads being removed: nothing more is written into them */
const closing = new Set<number>();
const writersOf = (id: number): Writer[] => [...writing.values()].filter(w => w.upload === id);
const within = <T>(p: Promise<T>, ms: number): Promise<boolean> => new Promise(resolve => {
  const t = setTimeout(() => resolve(false), ms);
  void p.then(() => { clearTimeout(t); resolve(true); }, () => { clearTimeout(t); resolve(true); });
});

export interface Piece { path: unknown; size: unknown; offset: unknown; body: AsyncIterable<Uint8Array> | null | undefined; signal?: AbortSignal }

async function writeAll(fh: Awaited<ReturnType<typeof open>>, chunk: Uint8Array) {
  let off = 0;
  while (off < chunk.byteLength) { const { bytesWritten } = await fh.write(chunk, off, chunk.byteLength - off); off += bytesWritten; }
}

/** the file's two names on the disk, inside the upload's own folder */
function placeOf(u: UploadRow, path: unknown): { rel: string; final: string; part: string; data: string } {
  const parts = cleanPath(path);
  const data = dataDir(u), rel = parts.join("/");
  const final = join(data, ...parts);
  if (!inside(final, data)) throw new UploadError(`${rel}: not a path inside the upload`);
  return { rel, final, part: final + PART, data };
}

/** how much of a file is on the server: nothing is written. What a sender asks after a line dropped, before it goes on */
export async function whereFile(id: number, path: unknown): Promise<{ received: number; done: boolean }> {
  const u = getUpload(id);
  if (!u) throw new UploadError("no such upload", 404);
  const { final, part } = placeOf(u, path);
  const there = await lstat(final).catch(() => null);
  if (there?.isFile()) return { received: there.size, done: true };
  const st = await lstat(part).catch(() => null);
  return { received: st?.isFile() ? st.size : 0, done: false };
}

/**
 * A piece of one file, appended at `offset`. `received` is how many bytes of the file are there afterwards; `done` once it
 * is whole. Refused with 409 and `received` when the piece does not start where the file ends (a retry of a piece that
 * did arrive, a piece sent twice): the sender goes on from `received`. A piece of a file whose earlier piece is still
 * being written takes over from it (that one's sender is gone, or it would not be sending again); 409 `{ busy: true }`
 * only when the earlier one does not let go in time — the sender waits and tries again.
 */
export async function writePiece(id: number, p: Piece): Promise<{ received: number; done: boolean; upload: UploadView }> {
  const u = getUpload(id);
  if (!u) throw new UploadError("no such upload", 404);
  if (u.state !== "uploading") throw new UploadError(u.state === "importing" ? "this upload is whole and being taken in" : u.state === "removing" ? "this upload is being removed" : "this upload is whole: its job failed (try it again, or remove it)", 409);
  const { rel, final, part, data } = placeOf(u, p.path);
  const size = whole(p.size), offset = whole(p.offset) ?? 0;
  if (size == null) throw new UploadError("size= is required: the whole file's size in bytes");
  if (size > u.bytes) throw new UploadError(`${rel} is larger than the whole upload was said to be`, 413);
  if (offset > size) throw new UploadError("offset= is past the file's end");
  const key = `${id}:${rel}`;
  const before = writing.get(key);
  if (before) {
    before.stop("a newer piece of the file came in");
    if (!(await within(before.ended, udeps.yieldMs)) || writing.has(key)) throw new UploadError(`${rel} is still being written by an earlier request: try again in a moment`, 409, { busy: true });
  }
  // how this piece is told to end, from here on: by a newer piece, by the upload's removal, or by its own quiet sender
  const STOP = Symbol("stop");
  const end = { why: null as string | null, wake: (_v: typeof STOP): void => {}, letGo: (): void => {} };
  const halt = new Promise<typeof STOP>(r => { end.wake = r; });
  const me: Writer = { upload: id, stop: why => { if (!end.why) { end.why = why; end.wake(STOP); } }, ended: new Promise<void>(r => { end.letGo = r; }) };
  writing.set(key, me);
  try {
    const t = await tallyOf(u);
    if (closing.has(id)) throw new UploadError("this upload was removed", 404);
    if (end.why) throw new UploadError(`${rel}: a newer piece of it came in`, 409, { busy: true });
    const there = await lstat(final).catch(() => null);
    if (there) {
      if (!there.isFile()) throw new UploadError(`${rel}: a folder of that name is in the upload`, 409);
      if (there.size !== size) throw new UploadError(`${rel} is in the upload already with another size (${sizeWords(there.size)}): remove the upload and send it again`, 409);
      if (offset === size) return { received: size, done: true, upload: serializeUpload(u) };
      throw new UploadError(`${rel} is whole already`, 409, { received: size, done: true });
    }
    const st = await lstat(part).catch(() => null);
    if (st && !st.isFile()) throw new UploadError(`${rel}: not a file of this upload`, 409);
    const have = st?.size ?? 0;
    if (offset !== have) throw new UploadError(`${rel}: ${have} bytes of it are here, the piece starts at ${offset}`, 409, { received: have, done: false });
    const parent = dirname(final);
    if (!st) {
      if (t.files >= u.files) throw new UploadError(`the upload was said to be ${u.files} file${u.files === 1 ? "" : "s"}, and ${rel} would be one more`, 409);
      await mkdir(parent, { recursive: true }).catch(e => { throw new UploadError(`${rel}: its folder could not be made (${e?.code ?? e?.message ?? e})`, 409); });
    }
    // the folder the file goes in is the upload's own, by its real path: never one that leads elsewhere (a link put where
    // a folder of the upload was would have the piece written, as ludarr itself, wherever it points)
    if (posix) {
      const real = await realpath(parent).catch(() => null);
      if (real !== parent || !(real === data || inside(real, data))) throw new UploadError(`${rel}: its folder on the server leads elsewhere, so nothing is written there`, 409);
    }
    const fh = await open(part, "a").catch(e => {
      throw new UploadError(e?.code === "ENOSPC" ? "the library is full: nothing more can be written" : `${rel} could not be written on the server (${e?.code ?? e?.message ?? e})`, e?.code === "ENOSPC" ? 507 : 400);
    });
    if (!st) t.files++;
    let written = 0;
    /** the piece ran over what was announced (nothing of it is kept), or the library is full */
    let over: UploadError | null = null;
    const it = p.body ? p.body[Symbol.asyncIterator]() : null;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => me.stop("its sender went away");
    p.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (it) {
        if (end.why || p.signal?.aborted) break;
        quiet = setTimeout(() => me.stop(`nothing came for ${Math.round(udeps.stallMs / 1000)} s`), udeps.stallMs);
        const next = it.next();
        const got = await Promise.race([next, halt]);
        clearTimeout(quiet); quiet = null;
        if (got === STOP) { next.catch(() => { /* the read it was waiting on */ }); break; }
        if (got.done) break;
        const chunk = got.value;
        if (!chunk.byteLength) continue;
        if (offset + written + chunk.byteLength > size) { over = new UploadError(`${rel}: more bytes than the file's size`, 400); break; }
        if (t.bytes + chunk.byteLength > u.bytes) { over = new UploadError("more bytes than the whole upload was said to be", 413); break; }
        await writeAll(fh, chunk);
        written += chunk.byteLength;
        t.bytes += chunk.byteLength;
      }
    } catch (e: any) {
      if (e?.code === "ENOSPC") over = new UploadError("the library is full: nothing more can be written", 507);
      // the sender went away mid-piece: what arrived stays, and it goes on from there
      else log.debug(`upload ${id}: a piece of ${rel} was cut off after ${written} bytes: ${e?.message ?? e}`);
    } finally {
      if (quiet) clearTimeout(quiet);
      p.signal?.removeEventListener("abort", onAbort);
      // whatever the sender still has to say is not read: the stream is let go, without waiting on it
      if (it?.return) void Promise.resolve().then(() => it.return!()).catch(() => { /* already over */ });
      await fh.close().catch(() => {});
      if (over && over.status !== 507 && written) {
        // back to where the piece began (by its path: a handle opened to append cannot cut the file everywhere)
        await truncate(part, offset).then(() => { t.bytes -= written; written = 0; }, e => log.warn(`upload ${id}: ${rel} could not be cut back to ${offset} bytes: ${e?.message ?? e}`));
      }
      if (!closing.has(id)) q.setReceived.run(Math.min(t.bytes, u.bytes), id);
    }
    if (over) throw over;
    if (closing.has(id)) throw new UploadError("this upload was removed", 404);
    if (end.why) log.debug(`upload ${id}: a piece of ${rel} ended after ${written} bytes: ${end.why}`);
    const received = offset + written;
    const done = received === size;
    if (done) await rename(part, final);
    const now = getUpload(id);
    tell(now);
    return { received, done, upload: serializeUpload(now ?? u) };
  } finally {
    if (writing.get(key) === me) writing.delete(key);
    end.letGo();
  }
}

/* ─────────── whole: the job ─────────── */

/** what the job is given: the one file, an archive set's first volume, or the upload's folder */
async function inputOf(u: UploadRow, forWay: boolean): Promise<string> {
  const data = dataDir(u);
  const top = await readdir(data, { withFileTypes: true });
  if (top.length === 1 && top[0].isFile()) return join(data, top[0].name);
  if (forWay && top.length > 1 && top.every(e => e.isFile())) {
    // the volumes of one archive set and nothing else: the way's game file is the set, named by its first volume
    for (const e of top) {
      const set = await archiveSet(join(data, e.name));
      if (set && set.parts.length === top.length && basename(set.parts[0]) === e.name) return set.parts[0];
    }
  }
  return data;
}

function startJob(u: UploadRow, input: string): JobRow {
  if (u.way_id != null) return enqueueJob({ kind: "content", gameId: u.game_id, path: input, wayId: u.way_id, upload: u.id }, { gameId: u.game_id });
  const j = stmts.insertJobOf.get(null, null, u.game_id, input, "import", JSON.stringify({ replace: !!u.replace, upload: u.id }), null) as JobRow;
  events.emit("job", serializeJob(j));
  return j;
}

/** the uploads being handed to a job right now: one hand-over at a time each (two presses never queue two jobs) */
const handing = new Set<number>();
async function handOver<T>(id: number, fn: () => Promise<T>): Promise<T> {
  if (handing.has(id)) throw new UploadError("this upload is being taken in already", 409);
  handing.add(id);
  try { return await fn(); } finally { handing.delete(id); }
}

async function queue(u: UploadRow): Promise<{ row: UploadRow; job: JobRow }> {
  const game = stmts.gameById.get(u.game_id) as GameRow | undefined;
  if (!game) throw new UploadError("the game this upload was for is gone: remove the upload", 409);
  if (u.way_id != null && getWay(u.way_id)?.game_id !== game.id) throw new UploadError("the way to play this upload was for is gone: take it in as the game's copy, or for another way", 409);
  replaceCheck(game, u.way_id, !!u.replace);
  const input = await inputOf(u, u.way_id != null);
  // looked at again after the last wait: removed or handed over meanwhile, it is not queued
  const now = getUpload(u.id);
  if (!now || (now.state !== "uploading" && now.state !== "failed")) throw new UploadError(now ? "this upload is being taken in already" : "this upload was removed", now ? 409 : 404);
  const job = startJob(u, input);
  q.setState.run("importing", job.id, null, u.id);
  const row = getUpload(u.id)!;
  log.info(`upload ${u.id} (${u.name}) for ${game.name} is whole: job ${job.id} takes it in ${u.way_id != null ? `for way ${u.way_id}` : "as the game's copy"}`);
  tell(row, true);
  return { row, job };
}

/** every file is in: checked against what was announced, then handed to its job */
export function finishUpload(id: number): Promise<{ row: UploadRow; job: JobRow }> {
  return handOver(id, async () => {
    const u = getUpload(id);
    if (!u) throw new UploadError("no such upload", 404);
    if (u.state !== "uploading") throw new UploadError(u.state === "importing" ? "this upload is being taken in already" : u.state === "removing" ? "this upload is being removed" : "this upload's job failed: try it again, or remove it", 409);
    if (writersOf(id).length) throw new UploadError("a piece of it is still coming in", 409);
    const files = await uploadFiles(u);
    const partial = files.filter(f => !f.done);
    if (partial.length) throw new UploadError(`${partial.length} file${partial.length === 1 ? " is" : "s are"} not whole yet: ${partial.slice(0, 3).map(f => f.path).join(", ")}${partial.length > 3 ? " …" : ""}`, 409);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (files.length !== u.files || bytes !== u.bytes)
      throw new UploadError(`the upload was said to be ${u.files} file${u.files === 1 ? "" : "s"} of ${sizeWords(u.bytes)}; ${files.length} of ${sizeWords(bytes)} ${files.length === 1 ? "is" : "are"} here`, 409);
    tally.set(u.id, { files: files.length, bytes });
    q.setReceived.run(bytes, u.id);
    return queue(getUpload(id)!);
  });
}

/** an upload whose job failed, taken in again: as it was, or the other way (`wayId`: a way's game file; null: the game's copy) */
export function retryUpload(id: number, b: { wayId?: unknown; replace?: unknown } = {}): Promise<{ row: UploadRow; job: JobRow }> {
  return handOver(id, async () => {
    const u = getUpload(id);
    if (!u) throw new UploadError("no such upload", 404);
    if (u.state !== "failed") throw new UploadError(u.state === "uploading" ? "this upload is not whole yet" : "this upload is being taken in", 409);
    const game = stmts.gameById.get(u.game_id) as GameRow | undefined;
    if (!game) throw new UploadError("the game this upload was for is gone: remove the upload", 409);
    const wayId = b.wayId === undefined ? u.way_id : wayFor(game, b.wayId);
    const replace = b.replace === undefined ? !!u.replace : b.replace === true;
    q.setFor.run(wayId, replace ? 1 : 0, id);
    return queue(getUpload(id)!);
  });
}

/* ─────────── after the job, and removal ─────────── */

/** the uploads being removed right now (the row first, then the files): each once, whoever asks */
const dropping = new Map<number, Promise<void>>();
function drop(u: UploadRow, why: string): Promise<void> {
  const under = dropping.get(u.id);
  if (under) return under;
  const p = (async () => {
    q.remove.run(u.id);
    closing.add(u.id);
    // every piece on its way in is told to stop and lets go of its file first (an open file cannot be deleted everywhere,
    // and on a FUSE share it leaves a hidden one behind)
    const writers = writersOf(u.id);
    for (const w of writers) w.stop("the upload is being removed");
    if (writers.length && !(await within(Promise.all(writers.map(w => w.ended)), udeps.yieldMs))) log.warn(`upload ${u.id}: a piece of it did not let go of its file in time`);
    tally.delete(u.id); told.delete(u.id);
    if (u.dir) {
      const left = await removeTree(u.dir).catch(() => [u.dir]);
      if (left.length) log.warn(`upload ${u.id}: ${left.length} entr${left.length === 1 ? "y" : "ies"} of ${u.dir} could not be removed yet`);
    }
    log.info(`upload ${u.id} (${u.name}) removed: ${why}`);
    events.emit("upload", { id: u.id, gameId: u.game_id, deleted: true });
  })().finally(() => { dropping.delete(u.id); closing.delete(u.id); });
  dropping.set(u.id, p);
  return p;
}
/** resolves once no upload's files are being removed (the tests wait on it) */
export const uploadsQuiet = async (): Promise<void> => { while (dropping.size) await Promise.all([...dropping.values()]); };

/**
 * The admin's own copy is in the library: a search for the game still under way stops (it would only bring another copy to
 * put in its place). A search for a way's game file is another matter and runs on.
 */
async function stopSearch(u: UploadRow) {
  const r = stmts.requestActiveForGame.get(u.game_id) as RequestRow | undefined;
  if (!r || r.state === "ready" || r.way_id != null) return;
  try {
    await cancelRequest(r.id, false);
    log.info(`upload ${u.id} (${u.name}) is the game's copy now: its search (#${r.id}) was stopped`);
  } catch (e: any) { log.warn(`upload ${u.id}: the search under way for its game could not be stopped: ${e?.message ?? e}`); }
}

/** a content job that kept a file which is not the one its way needs is done, and says so in its message ("kept X — not
 *  the file Y needs: …", src/ways/content.ts): the upload stays, to be taken in for another way or as the game's copy */
const misfit = (job: JobRow) => (job.kind ?? "import") === "content" && /\bnot the file\b.+\bneeds\b/i.test(job.message ?? "");

/** an upload whose job has ended: its files go when the job took it in, and stay for another try when it did not */
export async function settleUpload(id: number): Promise<void> {
  const u = getUpload(id);
  if (!u) return dropping.get(id);                         // being removed already: over once its files are gone
  if (u.state !== "importing" && u.state !== "removing") return;
  const job = u.job_id != null ? (stmts.jobById.get(u.job_id) as JobRow | undefined) : undefined;
  if (job && ACTIVE.has(job.state)) {
    // the admin removed it and its job still runs (queued again by a restart, say): the job is stopped again, and the
    // files go once it has — never while it reads them
    if (u.state === "removing") cancelJob(job.id, "the upload was removed", "admin");
    const after = stmts.jobById.get(job.id) as JobRow | undefined;
    if (after && ACTIVE.has(after.state)) return;
    return settleUpload(id);
  }
  if (u.state === "removing") return drop(u, "removed by the admin");
  if (job?.state === "done" && !misfit(job)) {
    if (u.way_id == null) await stopSearch(u);
    return drop(u, `job ${job.id} took it in`);
  }
  q.setState.run("failed", u.job_id, job ? (job.message ?? job.state) : "the job that was taking it in is gone", u.id);
  tell(getUpload(id), true);
}

/** removed by the admin: at once, or — while its job runs — once the job has stopped */
export async function removeUpload(id: number): Promise<{ removed: boolean }> {
  const u = getUpload(id);
  if (!u) throw new UploadError("no such upload", 404);
  const job = u.job_id != null ? (stmts.jobById.get(u.job_id) as JobRow | undefined) : undefined;
  if ((u.state === "importing" || u.state === "removing") && job && ACTIVE.has(job.state)) {
    if (u.state !== "removing") { q.setState.run("removing", u.job_id, null, u.id); tell(getUpload(id), true); }
    await settleUpload(id);                               // stops the job: a queued one is cancelled at once, a running one says when it has stopped
    return { removed: !getUpload(id) };
  }
  await drop(u, "removed by the admin");
  return { removed: true };
}

/**
 * Housekeeping (at start and hourly): uploads whose job ended while nobody was told, uploads nothing touched for KEEP_DAYS
 * (unfinished, or failed), uploads of games that are gone, and folders under .ahoy-uploads that no upload owns once they
 * are that old too.
 */
export async function sweepUploads(): Promise<{ settled: number; expired: number; orphans: number }> {
  let settled = 0, expired = 0, orphans = 0;
  const old = Math.floor(udeps.now() / 1000) - KEEP_DAYS * 86_400;
  for (const u of allUploads()) {
    if (!stmts.gameById.get(u.game_id)) { if (u.job_id != null) cancelJob(u.job_id, "its game was deleted"); await drop(u, "its game is gone"); expired++; continue; }
    if (u.state === "importing" || u.state === "removing") {
      const before = u.state;
      await settleUpload(u.id);
      if (getUpload(u.id)?.state !== before) settled++;
    } else if (u.touched_at < old || !u.dir) { await drop(u, u.dir ? `nothing touched it for ${KEEP_DAYS} days` : "it never got a folder"); expired++; }
  }
  const owned = new Set(allUploads().map(u => u.dir));
  for (const r of rootFolders()) {
    const base = join(r.path, UPLOADS);
    // only ludarr's own plain folder is looked into: a link put in its place leads to someone else's folders
    if (await baseTrouble(base)) continue;
    for (const e of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      const p = join(base, e.name);
      if (!e.isDirectory() || !/^\d+$/.test(e.name) || owned.has(p)) continue;
      const real = await realpath(p).catch(() => p);
      if (owned.has(real)) continue;
      const st = await lstat(p).catch(() => null);
      if (!st || !st.isDirectory() || st.mtimeMs / 1000 > old) continue;
      await removeTree(p).catch(() => {});
      orphans++;
    }
  }
  if (settled || expired || orphans) log.info(`uploads swept: ${settled} settled, ${expired} expired, ${orphans} folder${orphans === 1 ? "" : "s"} nobody owned`);
  return { settled, expired, orphans };
}

// a job's end reaches its upload at once
events.subscribe(e => {
  if (e.event !== "job") return;
  const d = e.data as { id?: number; state?: string } | null;
  if (!d?.id || !d.state || ACTIVE.has(d.state)) return;
  const u = q.byJob.get(d.id) as UploadRow | null;
  if (u) void settleUpload(u.id).catch(err => log.warn(`upload ${u.id}: ${err?.message ?? err}`));
});
// a game deleted takes its uploads along (its jobs were cancelled with it)
onGameChange((gameId, how) => {
  if (how !== "deleted") return;
  for (const u of uploadsOfGame(gameId)) void drop(u, "its game was deleted").catch(err => log.warn(`upload ${u.id}: ${err?.message ?? err}`));
});
