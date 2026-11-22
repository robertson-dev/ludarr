/**
 * ludarr — the content store: game files (a ROM, a single-file disc image), game folders (an app0 dump, a PS3 JB folder)
 * and system files (a BIOS, firmware, keys) kept on the server for the ways to play, each with its hashes
 * (src/ways/hash.ts).
 *
 *   <root folder>/.ahoy-content/<game slug | plan-<id>>/<stored name>     one folder per game, one per plan for its needs
 *   <root folder>/.ahoy-content/<game slug>/<folder>/ + <folder>.tree.tsv  a game folder, and its canonical listing
 *   <root folder>/.ahoy-content/.incoming/<uuid>                          a file or folder on its way in (same volume: the
 *                                                                         last step is a rename)
 *
 * An upload streams the request body into .incoming and hashes it in the same loop, so the answer follows the last
 * byte; it is refused past CONTENT_UPLOAD_MAX_GB. A file already on the server (a server path, the game's copy, a
 * download, an inbox entry, a made file) is taken in by a hard link when it is on the store's volume (moved, for an inbox
 * entry or a made file), and is hashed where it lies, once; only across volumes is it copied, hashed as it is copied. The
 * same bytes kept already are never written again: a file is linked into .incoming and hashed first, and a duplicate goes
 * before it is placed. Nothing is taken in while the library volume holds less than LIBRARY_KEEP_FREE_GB (plus what the
 * intake writes): an EnvError 'room' with the numbers, so a run tries again later. N64 dumps are stored big-endian (z64)
 * whatever the way, with the bytes' own hashes beside them, and the stored name takes the .z64 extension (such a dump is
 * copied, never linked). Names are reduced to a base name (storeName) and every path is realpath-checked to stay in the
 * store. A system file that does not fit its need is refused; a game file is kept either way and judged per way (the admin
 * can accept one by hand): one whose console is not known (an .iso) goes by itself only to a way that checks it by hash,
 * plays the game's only console, or is a PC way of a game on no console. What a game file's own bytes say it is
 * (src/ways/identity.ts: a serial, a disc id, a game code) is read as it is taken in and kept with it; a disc whose bytes
 * name its console is that console's file, whatever it was sent as. A kept file's stat when it was hashed is kept beside
 * its hashes (stat_json), so a later read trusts them only while the file is the same.
 *
 * A game folder is one row (shape 'folder'): its hashes are those of its canonical listing ("rel\tsize\tsha256\n" sorted),
 * kept beside it as <folder>.tree.tsv; a folder that is only what a way's game file is made from (an input) is named by a
 * listing of sizes and times instead of read through. A download a search brought for one way is a job of this kind too,
 * done by the content pass (src/ways/find.ts); so are the game's copy taken for a way (src/ways/copy.ts takeCopy) and an
 * entry of the game's inbox folder (intakeEntry: judged for each way, kept as its file or as what its make takes, or left
 * where it is with <entry>.not-taken.txt beside it saying why). Nothing here deletes a stored file except removeContent
 * (DELETE /api/v1/content/:id): packages come and go, the files they were built from stay.
 */
import { existsSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cfgNum, defaultDownloadsDir, downloadsDir, stagingHistory } from "../config";
import { stmts, type GameRow, type RootFolderRow } from "../db";
import { fileChunks, removeTree } from "../fsutil";
import { diskSpace, rootFolders } from "../library/rootfolders";
import { consolePlatforms, isConsole } from "../platforms";
import * as registry from "../plugins/registry";
import { arrivalsDir } from "../synced";
import { registerJobKind, type KindContext, type KindResult } from "../process/kinds";
import { extPlatform } from "./copy";
import { EnvError, NeedsFiles } from "./errors";
import { hashedStat, hashInPlace, hashTree, listingDigest, n64Order, sameStat, StreamHasher, type N64Order, type TreeFile } from "./hash";
import { DEFINITIVE, readFolderIdentity, readIdentity, type Identity } from "./identity";
import { completeness } from "./inspect";
import { contentMatches, inputMatches, takesMakeFile, needMatches, proven, type FileFacts, type Verdict } from "./match";
import { SANDBOX_UIDS } from "./sandbox";
import {
  assembling, contentFacts, getContent, getPlan, getWay, insertContent, planSpec, repointContent, sameStoredFile, settleWay, settleWaysOfPlan, settleWaysOnCopy, updateWay,
  wayContent, waysOfGame, waysOfPlan, waysUsingContent, wstmts, type ContentRow, type PlanRow, type WayRow,
} from "./store";
import type { Completeness, ContentPlan, FailInfo, Hashes, HashedStat, IntakeManifest, JobSpec, MadeInfo, MakeInput } from "./types";
import { launcherPathProblem, storeName } from "./validate";

export const STORE = ".ahoy-content";
const INCOMING = ".incoming";
const INBOX = ".ahoy-inbox";
/** decimal, as every size ludarr says and the GB settings mean (1 GB = 10^9 bytes) */
const GB = 1e9, MB = 1e6;

export class ContentError extends Error {
  constructor(msg: string, public status: 400 | 403 | 404 | 409 | 413 | 500 | 507 = 400) { super(msg); }
  /** what kind of failure it is (src/ways/errors.ts failOf): no room is this server's, a cancel is a cancel, the rest is
   *  about the file (the server's own state — no root folder, a file being built from — is an EnvError instead) */
  get fail(): FailInfo { return this.status === 507 ? { class: "env", kind: "room" } : this.message === "cancelled" ? { class: "cancelled" } : { class: "file" }; }
}

/** swapped in tests */
export const ctdeps = {
  rootFolders: (): RootFolderRow[] => rootFolders(),
  diskSpace: (p: string) => diskSpace(p),
  maxUploadBytes: () => Math.max(1, cfgNum("CONTENT_UPLOAD_MAX_GB", 16)) * GB,
  /** room every intake leaves free on the library volume (LIBRARY_KEEP_FREE_GB, read each time) */
  keepFree: (): number => keepFreeBytes(),
  /** how often (bytes written) a long ingest looks at the free space again */
  recheckBytes: 512 * 2 ** 20,
  /** the local side of each enabled download client's remote path mapping (<client path>=<ludarr path>), and the
   *  finished-downloads folder the admin's own sync fills here while it is on (src/synced.ts) */
  clientFolders: (): string[] => [...registry.instanceRows("downloadClient").filter(r => r.enabled).map(r => {
    try { return String(JSON.parse(r.settings_json).pathMap ?? "").split("=")[1]?.trim().replace(/[\\/]+$/, "") ?? ""; } catch { return ""; }
  }), arrivalsDir() ?? ""].filter(Boolean),
  /** the readers and the judges of what a way takes (src/ways/identity.ts, match.ts, inspect.ts) */
  readIdentity: (path: string, platform: string | null, name: string): Promise<Identity | null> => readIdentity(path, platform, name),
  readFolderIdentity: (dir: string, platform: string | null): Promise<Identity | null> => readFolderIdentity(dir, platform),
  inputMatches: (input: MakeInput, f: FileFacts): Verdict => inputMatches(input, f),
  completeness: (dir: string, c: Completeness, o: { progress?: (files: number, bytes: number) => void } = {}): Promise<{ ok: boolean; why: string | null }> => completeness(dir, c, { list: null, progress: o.progress }),
  /** the build programs' users: a file one of them owns was not put in an inbox by the admin */
  sandboxUids: (): number[] => SANDBOX_UIDS,
  /** a hard link (a share without them, or another volume, says EXDEV / EPERM: the bytes are copied instead) */
  link: (from: string, to: string): Promise<void> => link(from, to),
  /** a file's or folder's permission bits set (what is taken in by a link or a move loses world-write: noWorldWrite) */
  chmod: (p: string, mode: number): Promise<void> => chmod(p, mode),
  /** do two paths sit on one volume (a hard link can join them: taking a file in writes nothing) */
  sameVolume: async (a: string, b: string): Promise<boolean> => {
    const [x, y] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
    return !!x && !!y && x.dev === y.dev;
  },
  now: (): number => Date.now(),
};

/** what making game files, taking them in and building for one game leave free on the library volume (LIBRARY_KEEP_FREE_GB) */
export const keepFreeBytes = (): number => Math.max(0, cfgNum("LIBRARY_KEEP_FREE_GB", 50)) * GB;

/** whose file it is: a game's game file, or the system file for one of a plan's needs */
export type Target = { role: "game"; game: GameRow } | { role: "system"; plan: PlanRow; needIndex: number };

/** a size in words: GB from a gigabyte up, MB below, KB for the small ones */
export const sizeWords = (n: number) => gb(n);
const gb = (n: number) => (n >= GB ? `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB` : n >= MB ? `${Math.round(n / MB)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** "12.3 of 54.2 GB": bytes of a total, for a long step's progress */
export const ofText = (b: number, total: number) => (total >= GB ? `${(b / GB).toFixed(1)} of ${(total / GB).toFixed(1)} GB` : total >= MB ? `${Math.round(b / MB)} of ${Math.round(total / MB)} MB` : `${Math.round(b / 1024)} of ${Math.max(1, Math.round(total / 1024))} KB`);
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
/** link errors that mean "not here" (another volume, a share without hard links): the bytes are copied instead */
const NO_LINK = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS", "EACCES", "EINVAL"]);

/* ─────────── where files go ─────────── */

/** the store folder's name for a target: the game's slug made safe (game-<id> without one), plan-<id> for a plan's needs */
export function folderName(t: Target): string {
  if (t.role === "system") return `plan-${t.plan.id}`;
  const slug = String(t.game.slug ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-+$/, "").slice(0, 80);
  return slug || `game-${t.game.id}`;
}

/** the game's own root folder, else the first one that is there */
function rootFor(t: Target): RootFolderRow {
  const roots = ctdeps.rootFolders();
  const pinned = t.role === "game" && t.game.root_folder_id ? roots.find(r => r.id === t.game.root_folder_id) : undefined;
  const root = pinned ?? roots.find(r => existsSync(r.path)) ?? roots[0];
  if (!root) throw new EnvError("tool", "no root folder — add one under Settings → Media management");
  return root;
}

/** the target's store folder and the incoming folder, made when missing; neither may be a link that leads elsewhere */
async function storeFor(t: Target): Promise<{ dir: string; incoming: string }> {
  const root = rootFor(t);
  const rootReal = await realpath(root.path).catch(() => null);
  if (!rootReal) throw new EnvError("tool", `the root folder ${root.path} is not there — is its volume mounted?`);
  const base = join(rootReal, STORE), dir = join(base, folderName(t)), incoming = join(base, INCOMING);
  await mkdir(dir, { recursive: true });
  await mkdir(incoming, { recursive: true });
  for (const p of [base, dir, incoming]) {
    const rp = await realpath(p);
    if (rp !== p) throw new EnvError("tool", `${p} leads to ${rp}: the content store must be a plain folder`);
  }
  return { dir, incoming };
}

/** a name in .incoming that says when it was put there: a hard link of a file being hashed ("link-"), or a tree being
 *  built of links or copies ("tree-"). A link or a moved file keeps its original's mtime (a dump from 2020), so its age is
 *  read from its name, never from its mtime. Nothing moved in from elsewhere ever waits in .incoming: a move goes straight
 *  into its store folder, so an inbox entry is never anywhere but where the admin put it, or kept */
const incomingName = (kind: "link" | "tree") => `${kind}-${Date.now()}-${crypto.randomUUID()}`;

/** what was cut off by a crash or a dropped connection, gone after a day: an upload's or a copy's partial file (its mtime
 *  moves as it is written), a link (its original keeps the bytes), a tree of ours. Another intake running at the same time
 *  (an upload, an import's hand-off, a make's product) never loses what it is working on: that is younger than a day */
async function sweepIncoming(dir: string) {
  const now = Date.now();
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, n);
    const s = await lstat(p).catch(() => null);
    if (!s) continue;
    const named = Number(/^(?:link|tree)-(\d{10,})-/.exec(n)?.[1]);
    if (now - (Number.isFinite(named) ? named : s.mtimeMs) <= 86_400_000) continue;
    if (s.isFile()) await unlink(p).catch(() => { /* still open: next time */ });
    else if (s.isDirectory() && n.startsWith("tree-")) await removeTree(p).catch(() => { /* next time */ });
  }
}

/** what ludarr keeps is its own: a file or folder taken in by a link or a move loses world-write (an SMB share writes an
 *  inbox entry 0777, a download client 0666), so no build program's user can change a kept game file — through a link in
 *  its staging folder, say — and no file can be planted in a kept game folder. The original keeps every other bit */
async function noWorldWrite(p: string): Promise<void> {
  const s = await lstat(p).catch(() => null);
  if (s && !s.isSymbolicLink() && s.mode & 0o002) await ctdeps.chmod(p, s.mode & 0o7775).catch(() => { /* a share that keeps its own modes */ });
}
/** the entries of a kept tree that anyone could write to (treeOf's `open`: folder-relative, with their modes and sizes) lose
 *  world-write, as noWorldWrite does for one file — an SMB drop of 117,000 files is a pass over every one of them, said
 *  about every second in bytes of the whole */
async function treeNoWorldWrite(root: string, open: [string, number, number][], progress?: (bytes: number, total: number) => void): Promise<void> {
  const total = open.reduce((n, [, , size]) => n + size, 0);
  let done = 0, last = ctdeps.now();
  progress?.(0, total);
  for (const [rel, mode, size] of open) {
    await ctdeps.chmod(rel ? join(root, ...rel.split("/")) : root, mode & 0o7775).catch(() => { /* a share that keeps its own modes */ });
    done += size;
    const now = ctdeps.now();
    if (now - last >= 1000) { last = now; progress?.(done, total); }
  }
  progress?.(done, total);
}

/** the library volume keeps LIBRARY_KEEP_FREE_GB free whatever is taken in: `need` is what this intake writes (0 for a
 *  link or a move) */
async function roomFor(dir: string, need: number) {
  const s = await ctdeps.diskSpace(dir).catch(() => null);
  if (!s) return;                                                           // the volume cannot say: go ahead, as an import does
  const keep = ctdeps.keepFree();
  if (s.free < need + keep)
    throw new EnvError("room", `not enough room: ${gb(s.free)} free on the library volume where the game files are kept, and this needs ${need ? `${gb(need)} plus ` : ""}the ${gb(keep)} kept free (Settings → General → Import → Keep free on the library)`);
}

/** room for `need` bytes on the volume of `dir` before something is written there (an unpack, a make's output): the library
 *  volume keeps LIBRARY_KEEP_FREE_GB free besides (`library`: the folder is on it), any other volume 1 GB */
export async function ensureRoom(dir: string, need: number, o: { library: boolean }): Promise<void> {
  if (o.library) return roomFor(dir, need);
  const s = await ctdeps.diskSpace(dir).catch(() => null);
  if (s && s.free < need + GB) throw new EnvError("room", `not enough room: ${gb(s.free)} free where the scratch folder is, and this needs ${gb(need)} plus 1 GB to spare`);
}

/** platforms a file's extension names without doubt (src/ways/copy.ts keeps the table) */
export { extPlatform };

/** the name a file is kept under: its own base name, with .z64 once an N64 dump is stored big-endian */
export function storedName(name: string, order: N64Order | null | undefined): string {
  const base = storeName(name);
  if (!order) return base;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base) + ".z64";
}

/** moves the finished file in under its name, or "<name> (2).ext" …: a file already there is never replaced */
async function placeExclusive(dir: string, name: string, tmp: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    try { const h = await open(candidate, "wx"); await h.close(); }        // claims the name; EEXIST means it is someone else's
    catch (e: any) { if (e?.code === "EEXIST") continue; throw e; }
    try { await rename(tmp, candidate); return candidate; }
    catch (e) { await unlink(candidate).catch(() => { /* our own empty claim */ }); throw e; }
  }
  throw new ContentError(`more than 999 files called ${name} for this game`, 409);
}
/** moves a finished folder in under its name, or "<name> (2)" …: nothing already there (or its listing) is replaced */
async function placeFolder(dir: string, name: string, tmp: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, i === 1 ? name : `${name} (${i})`);
    if (existsSync(candidate) || existsSync(`${candidate}.tree.tsv`)) continue;
    try { await rename(tmp, candidate); return candidate; }
    catch (e: any) { if (e?.code === "EEXIST" || e?.code === "ENOTEMPTY" || e?.code === "EPERM") continue; throw e; }
  }
  throw new ContentError(`more than 999 folders called ${name} for this game`, 409);
}

async function writeAll(fh: FileHandle, b: Uint8Array) {
  for (let off = 0; off < b.byteLength;) { const { bytesWritten } = await fh.write(b, off, b.byteLength - off); off += bytesWritten; }
}

/* ─────────── taking a file in ─────────── */

export interface IngestOpts {
  /** the file's own name (reduced to a safe base name) */
  name: string;
  source: ContentRow["source"];
  /** the console the file is for when the caller knows it; otherwise an N64 header or an unambiguous extension says */
  platform?: string | null;
  /** the console of the way the file is taken in for: its console when neither the bytes nor the extension say one */
  wayPlatform?: string | null;
  /** the size when known up front (Content-Length, a stat): the free space is checked against it first */
  expectedSize?: number | null;
  /** refused once more than this many bytes arrive */
  maxBytes?: number | null;
  /** judged once hashed, before the file is kept: a refusal discards it (system files must fit their need) */
  accept?: (f: FileFacts) => Verdict;
  signal?: AbortSignal;
  progress?: (bytes: number) => void;
  /** what a made file was made from (src/ways/make.ts) */
  made?: MadeInfo | null;
}
/** linked: the store's file is the original's own (a hard link or a move, no bytes written); stat: the kept file's when it
 *  was hashed; sourceStat: the original's, unchanged while it was copied (null when it changed or was not looked at) */
export interface Ingested { row: ContentRow; duplicate: boolean; linked?: boolean; stat?: HashedStat | null; sourceStat?: HashedStat | null }

/**
 * A file just hashed, kept: what its bytes say, the verdict, the same bytes kept already (`onDuplicate` lets go of ours),
 * or its row under its own name. `hashedAs`: the file's stat when it was hashed where it lies — the kept file must still be
 * that file (a write in between refuses it); `undo` puts back what was placed when anything after that fails (a moved
 * file goes back where it was, a link or a copy of ours goes).
 */
async function keep(tmp: string, t: Target, dir: string, o: { name: string; source: ContentRow["source"]; platform?: string | null; wayPlatform?: string | null; accept?: (f: FileFacts) => Verdict; made?: MadeInfo | null; identity?: Identity | null },
  r: { size: number; hashes: Hashes; rawHashes?: Hashes | null; normalized?: string | null; order?: N64Order | null }, how: { hashedAs: HashedStat | null; linked: boolean; onDuplicate: () => Promise<void>; undo: (placed: string) => Promise<void> }): Promise<Ingested> {
  const name = storedName(o.name, r.order);
  // what the bytes themselves say (a serial, a disc id, a game code): a disc whose bytes name its console is that
  // console's, whatever it was sent as
  const identity = t.role === "game" ? (o.identity !== undefined ? o.identity : await readIdentity(tmp, o.platform ?? (r.order ? "n64" : null) ?? extPlatform(name) ?? o.wayPlatform ?? null, name)) : null;
  const named = identity && DEFINITIVE.has(identity.platform) ? identity.platform : null;
  const platform = t.role === "system" ? null : (named ?? o.platform ?? (r.order ? "n64" : extPlatform(name)) ?? o.wayPlatform ?? null);
  const facts: FileFacts = { platform, name, size: r.size, hashes: r.hashes, rawHashes: r.rawHashes ?? null, identity };
  const verdict = o.accept?.(facts);
  if (verdict && !verdict.ok) throw new ContentError(verdict.why ?? "not the file this needs", 409);
  const owner = t.role === "game" ? { role: t.role, gameId: t.game.id } : { role: t.role, planId: t.plan.id, needIndex: t.needIndex };
  const same = sameStoredFile(r.hashes.sha1!, owner);
  if (same && identity && !same.identity_json) { wstmts.setContentIdentity.run(JSON.stringify(identity), same.id); same.identity_json = JSON.stringify(identity); }
  if (same && o.made && !same.made_json) { wstmts.setContentMade.run(JSON.stringify(o.made), same.id); same.made_json = JSON.stringify(o.made); }
  if (same && existsSync(same.path)) { await how.onDuplicate(); return { row: same, duplicate: true, linked: how.linked, stat: null }; }
  const placed = await placeExclusive(dir, name, tmp);
  try {
    const real = await realpath(placed);
    if (!inside(real, dir)) throw new ContentError("the stored file ended up outside its store folder", 500);
    if (how.linked) await noWorldWrite(real);
    const kept = hashedStat(await lstat(real));
    if (how.hashedAs && !sameStat(how.hashedAs, kept, { ctime: false })) throw new EnvError("changed", `${o.name} changed after it was hashed: it is looked at again later`);
    const row = same
      ? repointContent(same.id, { name: basename(real), path: real, rawHashes: r.rawHashes ?? null, normalized: r.normalized ?? null })
      : insertContent({
        gameId: t.role === "game" ? t.game.id : null, planId: t.role === "system" ? t.plan.id : null, needIndex: t.role === "system" ? t.needIndex : null,
        role: t.role, platform, name: basename(real), path: real, size: r.size, hashes: r.hashes, rawHashes: r.rawHashes ?? null,
        normalized: r.normalized ?? null, source: o.source, identity, shape: "file", made: o.made ?? null, stat: kept,
      });
    if (same) wstmts.setContentStat.run(JSON.stringify(kept), same.id);
    return { row: getContent(row.id) ?? row, duplicate: false, linked: how.linked, stat: kept };
  } catch (e) {
    await how.undo(placed);
    throw e;
  }
}

/** streams bytes into the store and records them; the same bytes already kept for the same game (or need) come back as that row */
export async function ingest(chunks: AsyncIterable<Uint8Array>, t: Target, o: IngestOpts): Promise<Ingested> {
  const { dir, incoming } = await storeFor(t);
  await sweepIncoming(incoming);
  await roomFor(dir, o.expectedSize ?? 0);
  const tmp = join(incoming, crypto.randomUUID());
  const fh = await open(tmp, "wx");
  let closed = false, kept = false;
  try {
    const h = await StreamHasher.create({ n64: t.role === "game" });
    let sinceCheck = 0;
    for await (const chunk of chunks) {
      if (o.signal?.aborted) throw new ContentError("cancelled", 409);
      const out = h.push(chunk);
      if (o.maxBytes != null && h.size > o.maxBytes) throw new ContentError(`larger than ${gb(o.maxBytes)}, the largest game file upload (Settings → Media management)`, 413);
      if (out.byteLength) await writeAll(fh, out);
      sinceCheck += chunk.byteLength;
      if (sinceCheck >= ctdeps.recheckBytes) { sinceCheck = 0; await roomFor(dir, 0); }
      o.progress?.(h.size);
    }
    const { tail, result } = h.end();
    if (tail.byteLength) await writeAll(fh, tail);
    await fh.close(); closed = true;
    if (!result.size) throw new ContentError("the file is empty", 400);
    const r = await keep(tmp, t, dir, o, result, { hashedAs: null, linked: false, onDuplicate: async () => { await unlink(tmp).catch(() => { /* swept later */ }); }, undo: async placed => { await unlink(placed).catch(() => { /* our own half-kept copy */ }); } });
    kept = true;
    return r;
  } catch (e) {
    if (!closed) await fh.close().catch(() => { /* already closed */ });
    if (!kept) await unlink(tmp).catch(() => { /* moved in, or never written */ });
    throw e;
  }
}

/** an upload: the request body as it streams in */
export async function ingestUpload(body: ReadableStream<Uint8Array> | null | undefined, t: Target, o: { name: string; platform?: string | null; wayPlatform?: string | null; size?: number | null; accept?: (f: FileFacts) => Verdict; signal?: AbortSignal }): Promise<Ingested> {
  if (!body) throw new ContentError("the request has no body: send the file's bytes", 400);
  const max = ctdeps.maxUploadBytes();
  if (o.size != null && o.size > max) throw new ContentError(`larger than ${gb(max)}, the largest game file upload (Settings → Media management)`, 413);
  return ingest(body as unknown as AsyncIterable<Uint8Array>, t, { ...o, source: "upload", expectedSize: o.size ?? null, maxBytes: max });
}

export interface FileIntakeOpts {
  /** the name it is kept under (default: the file's own) */
  name?: string;
  source: ContentRow["source"];
  platform?: string | null;
  wayPlatform?: string | null;
  /** link: a hard link on the store's volume, else a copy (the original stays its owner's); move: a rename on the store's
   *  volume, else a copy and the original removed once it is kept; copy: always a copy */
  mode: "link" | "move" | "copy";
  /** hashes an earlier read of this very file told, trusted while its size, mtime, device and inode are the same */
  known?: { hashes: Hashes; rawHashes?: Hashes | null; stat: HashedStat; normalized?: string | null } | null;
  /** what its bytes say, read where it lies already */
  identity?: Identity | null;
  accept?: (f: FileFacts) => Verdict;
  made?: MadeInfo | null;
  signal?: AbortSignal;
  /** bytes of total, and the step: "hashing" (read where it lies) or "copying" */
  progress?: (bytes: number, total: number, step: "hashing" | "copying") => void;
}

/**
 * A file already on the server taken into the store, hashed once: a hard link (or, for an inbox entry or a made file, a
 * move) when it is on the store's volume — no bytes written, read where it lies, or not at all when `known` hashes still
 * hold — and a copy only across volumes (hashed as it is copied; when the game keeps a file of the same size, the
 * original is read first and a duplicate is never copied). An N64 dump in another byte order is copied big-endian. The
 * same bytes kept already come back as that row, and the link goes (or the moved file is consumed) before anything is
 * placed. A move is read where the file lies and then renamed straight into its store folder: the admin's file is never
 * anywhere but where it was, or kept (a crash, or another intake's sweep of .incoming, can never lose it).
 */
export async function ingestFile(src: string, t: Target, o: FileIntakeOpts): Promise<Ingested> {
  const st = await lstat(src).catch(() => null);
  if (!st) throw new ContentError(`${basename(src)} is not there`, 404);
  if (st.isSymbolicLink() || !st.isFile()) throw new ContentError(`${basename(src)} is not a regular file`, 400);
  const name = o.name ?? basename(src);
  const { dir, incoming } = await storeFor(t);
  await sweepIncoming(incoming);
  let mode = o.mode;
  // an N64 dump that is not big-endian is stored as z64: its bytes are rewritten as they are copied
  if (mode !== "copy" && t.role === "game") {
    const order = n64Order(await head(src, 4));
    if (order === "v64" || order === "n64") mode = "copy";
  }
  /** the hashes of the file at `at` (the original, or our link to it): an earlier read's while it is the same file, else one
   *  read where it lies */
  const hashed = async (at: string): Promise<{ r: { size: number; hashes: Hashes; rawHashes?: Hashes | null; normalized?: string | null; order?: N64Order | null }; s: HashedStat }> => {
    const now = hashedStat(await lstat(at));
    if (o.known && sameStat(o.known.stat, now, { ctime: false }) && o.known.hashes.sha1) return { r: { size: now.size, hashes: o.known.hashes, rawHashes: o.known.rawHashes ?? null, normalized: o.known.normalized ?? null }, s: now };
    const h = await hashInPlace(at, { n64: t.role === "game", signal: o.signal, progress: (b, total) => o.progress?.(b, total, "hashing"), now: ctdeps.now });
    return { r: h.result, s: h.stat };
  };
  const keepAs = { name, source: o.source, platform: o.platform, wayPlatform: o.wayPlatform, accept: o.accept, made: o.made, identity: o.identity };
  if (mode === "move" && (await ctdeps.sameVolume(src, dir))) {
    await roomFor(dir, 0);
    const { r, s } = await hashed(src);
    // a dump the read found to be in another byte order after all (it changed): copied instead
    if (r.order === "v64" || r.order === "n64") return ingestFile(src, t, { ...o, mode: "copy" });
    try {
      return await keep(src, t, dir, keepAs, r, {
        hashedAs: s, linked: true,
        onDuplicate: async () => { await unlink(src).catch(() => { /* left where it was */ }); },
        undo: async placed => { await rename(placed, src).catch(() => { /* left in the store folder */ }); },
      });
    } catch (e: any) { if (!NO_LINK.has(e?.code)) throw e; }               // the rename crossed a volume after all: copied
  } else if (mode === "link") {
    await roomFor(dir, 0);
    const tmp = join(incoming, incomingName("link"));
    let placedIn = false;
    try { await ctdeps.link(src, tmp); placedIn = true; }
    catch (e: any) { if (!NO_LINK.has(e?.code)) throw e; }
    if (placedIn) {
      const putBack = async () => { await unlink(tmp).catch(() => { /* swept later */ }); };
      try {
        const { r, s } = await hashed(tmp);
        if (r.order === "v64" || r.order === "n64") { await putBack(); return ingestFile(src, t, { ...o, mode: "copy" }); }
        return await keep(tmp, t, dir, keepAs, r, {
          hashedAs: s, linked: true,
          onDuplicate: putBack,
          undo: async placed => { await unlink(placed).catch(() => { /* swept later */ }); },
        });
      } catch (e) { await putBack(); throw e; }
    }
  }
  // across volumes: a copy, hashed as it is copied — unless a kept file turns out to be these bytes: the hashes an earlier
  // read told say so without a read while the file is still the one it read (its size, time, device and inode); else, when
  // the game keeps a file of the same size, the original is read first (a duplicate is never copied)
  const told = o.known?.hashes.sha1 && sameStat(o.known.stat, hashedStat(st), { ctime: false }) ? o.known : null;
  if (t.role === "game" && (told || (wstmts.contentsForGame.all(t.game.id) as ContentRow[]).some(f => f.size === st.size && (f.shape ?? "file") === "file"))) {
    const h = told ? { sha1: told.hashes.sha1!, stat: hashedStat(st) } : await hashInPlace(src, { n64: true, signal: o.signal, progress: (b, total) => o.progress?.(b, total, "hashing"), now: ctdeps.now }).then(r => ({ sha1: r.result.hashes.sha1!, stat: r.stat }));
    const same = sameStoredFile(h.sha1, { role: "game", gameId: t.game.id });
    if (same && existsSync(same.path)) {
      if (o.mode === "move") await unlink(src).catch(() => { /* left where it was */ });
      return { row: same, duplicate: true, linked: false, stat: null, sourceStat: h.stat };
    }
  }
  const before = hashedStat(st);
  let last = 0;
  const r = await ingest(fileChunks(src), t, {
    name, source: o.source, platform: o.platform, wayPlatform: o.wayPlatform, expectedSize: st.size, maxBytes: null, accept: o.accept, signal: o.signal, made: o.made,
    progress: b => { const now = ctdeps.now(); if (now - last >= 1000 || b === st.size) { last = now; o.progress?.(b, st.size, "copying"); } },
  });
  const after = await lstat(src).catch(() => null);
  const sourceStat = after && sameStat(before, hashedStat(after)) ? hashedStat(after) : null;
  if (o.mode === "move") await unlink(src).catch(() => { /* left where it was */ });
  return { ...r, linked: false, sourceStat };
}

/**
 * Can `src` be taken in for `t` by a hard link? One link tried in the store's .incoming and removed at once. One device is
 * not enough to tell: Unraid's user shares are one device inside the container, and a link across their disks still
 * fails — a file judged in place there would be read again as it is copied in (src/ways/find.ts reads it once instead).
 */
export async function linksInto(src: string, t: Target): Promise<boolean> {
  const { incoming } = await storeFor(t);
  const probe = join(incoming, incomingName("link"));
  try { await ctdeps.link(src, probe); } catch { return false; }
  await unlink(probe).catch(() => { /* swept later: its name says when it was made */ });
  return true;
}

async function head(path: string, n: number): Promise<Uint8Array> {
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return new Uint8Array(0);
  try { const b = new Uint8Array(n); const { bytesRead } = await fh.read(b, 0, n, 0); return b.subarray(0, bytesRead); }
  finally { await fh.close().catch(() => { /* closed */ }); }
}

/** the folders a file on the server may be taken from, as real paths, read now (a folder changed in Settings counts at once) */
export async function allowedRoots(): Promise<string[]> {
  const out: string[] = [];
  for (const p of [downloadsDir(), defaultDownloadsDir(), ...stagingHistory(), ...ctdeps.rootFolders().map(r => r.path), ...ctdeps.clientFolders()]) {
    const rp = p ? await realpath(resolve(p)).catch(() => null) : null;
    if (rp && !out.includes(rp)) out.push(rp);
  }
  return out;
}

/** a file (or, with {folders: true}, a folder) on the server that may be taken in: absolute, a regular file or folder once
 *  links are followed, inside an allowed folder */
export async function checkServerPath(path: unknown, o: { folders?: boolean } = {}): Promise<{ real: string; size: number; folder: boolean }> {
  if (typeof path !== "string" || !path.trim()) throw new ContentError("path required", 400);
  if (!isAbsolute(path)) throw new ContentError("an absolute path on the server, please", 400);
  const real = await realpath(path).catch(() => null);
  if (!real) throw new ContentError("no such file on the server", 404);
  const st = await stat(real);
  if (st.isDirectory() && !o.folders) throw new ContentError("that is a folder: pick the game file inside it", 400);
  if (!st.isDirectory() && !st.isFile()) throw new ContentError("not a regular file", 400);
  const roots = await allowedRoots();
  if (!roots.some(r => inside(real, r))) throw new ContentError("outside the folders ludarr takes files from: the downloads folder, a root folder or a download client's mapped folder", 403);
  return { real, size: st.isDirectory() ? 0 : st.size, folder: st.isDirectory() };
}

/** a file already on the server, taken in where it is: a hard link on the store's volume (the original stays its owner's,
 *  untouched), a copy otherwise */
export async function ingestPath(path: string, t: Target, o: { source?: ContentRow["source"]; platform?: string | null; wayPlatform?: string | null; accept?: (f: FileFacts) => Verdict; signal?: AbortSignal; progress?: (bytes: number, total?: number, step?: "hashing" | "copying") => void } = {}): Promise<Ingested> {
  const { real } = await checkServerPath(path);
  return ingestFile(real, t, { name: basename(path), source: o.source ?? "path", platform: o.platform, wayPlatform: o.wayPlatform, mode: "link", accept: o.accept, signal: o.signal, progress: (b, total, s) => o.progress?.(b, total, s) });
}

/* ─────────── game folders, made files and the inbox ─────────── */

export interface TreeOpts {
  /** how the folder gets into the store: hard links or a move on the store's volume, a copy otherwise */
  mode: "link" | "move" | "copy";
  /** hash every file (a folder that ships as a way's game file), or name the folder by its listing of sizes and times only
   *  (a folder a way's game file is made from) */
  hash: boolean;
  source?: ContentRow["source"];
  signal?: AbortSignal;
  /** bytes of the whole about every second, and the step it is on: reading every file ("hashing"), then linking (a link
   *  writes nothing, but 117,000 of them take minutes on a share) or copying them in */
  progress?: (bytes: number, total: number, step?: TreeStep) => void;
  /** the files' sha256s already known (a package's list), trusted while each file's size is the same */
  known?: Map<string, { size: number; sha256: string; mtimeMs?: number | null }>;
  /** what the folder was made from (src/ways/make.ts) */
  made?: MadeInfo | null;
  /** what its own data says, read where it lies already */
  identity?: Identity | null;
  platform?: string | null;
  /** the name it is kept under (default: the folder's own) */
  name?: string;
  /** users none of whose files may be taken in (a make's product: still a build user's, it could be changed after it is
   *  kept) */
  refuseOwners?: number[];
  /** the walk that lists every file before anything is read or linked (117,000 lstats on a share take minutes), said
   *  about once a second: files and bytes so far */
  looking?: Looking;
}

/** the steps of taking a folder in: every file read ("hashing"), then linked or copied into the store, then, for what came
 *  in by a link or a move, world-write taken off every file ("protecting" it from changes) */
export type TreeStep = "hashing" | "linking" | "copying" | "protecting";

/** every file of a folder (links refused, at most 400,000 entries), with what a launcher could not place; `open`: the
 *  entries (folders too, "" the folder itself) anyone may write to, with their modes and sizes */
async function treeOf(dir: string, o: { ships: boolean; refuseOwners?: number[]; looking?: Looking }): Promise<{ files: TreeFile[]; open: [string, number, number][] }> {
  const files: TreeFile[] = [], open: [string, number, number][] = [];
  let count = 0, bytes = 0;
  const tell = everySecond(o.looking);
  const owners = new Set(o.refuseOwners ?? []);
  const owned = (r: string) => new Error(`${r || basename(dir)} is still a build program's user's: it is handed back to ludarr before it is kept`);
  const top = await lstat(dir);
  if (owners.has(top.uid)) throw owned("");
  if (top.mode & 0o002) open.push(["", top.mode, 0]);
  const visit = async (abs: string, rel: string) => {
    for (const n of (await readdir(abs)).sort()) {
      if (++count > 400_000) throw new ContentError("the folder holds more than 400,000 entries: not a game folder ludarr takes in", 400);
      const p = join(abs, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(p);
      if (st.isSymbolicLink()) throw new ContentError(`the folder holds a link (${r}): a game folder is taken in only as plain files and folders`, 400);
      if (owners.has(st.uid)) throw owned(r);
      if (o.ships) { const bad = launcherPathProblem(r); if (bad) throw new ContentError(`${r} ${bad}: players' PCs could not hold it`, 400); }
      if (st.mode & 0o002) open.push([r, st.mode, st.isFile() ? st.size : 0]);
      if (st.isDirectory()) await visit(p, r);
      else if (st.isFile()) { files.push({ rel: r, size: st.size, mtimeMs: st.mtimeMs }); bytes += st.size; tell?.(files.length, bytes); }
      else throw new ContentError(`the folder holds ${r}, which is neither a file nor a folder`, 400);
    }
  };
  await visit(dir, "");
  return { files, open };
}

/** a file copied by streaming it, its bytes counted as they are written (a 30 GB file copied in one call says nothing for
 *  minutes), and fed to `hash` when one is given (the copy is then its one read); a cancel stops it */
async function copyOut(src: string, dst: string, o: { signal?: AbortSignal; onBytes?: (n: number) => void; hash?: Bun.CryptoHasher } = {}): Promise<void> {
  const fh = await open(dst, "wx");
  try {
    for await (const chunk of fileChunks(src)) {
      if (o.signal?.aborted) throw new ContentError("cancelled", 409);
      o.hash?.update(chunk);
      await writeAll(fh, chunk);
      o.onBytes?.(chunk.byteLength);
    }
  } finally { await fh.close().catch(() => { /* closed */ }); }
}

/** a tree of hard links to (or copies of) every file of `from`, built at `to`, with progress in bytes of the whole about
 *  every second, linking as well as copying; `sums`: each copied file's sha256, taken from the bytes as they are copied (a
 *  file that changed while it was read refuses the folder, as hashTree does) */
async function linkTree(from: string, to: string, files: TreeFile[], copy: boolean, o: { signal?: AbortSignal; progress?: (bytes: number, total: number, step?: TreeStep) => void; sums?: Map<string, string> }): Promise<void> {
  const total = files.reduce((n, f) => n + f.size, 0);
  const step: TreeStep = copy ? "copying" : "linking";
  let done = 0, last = ctdeps.now();
  const tell = () => { const now = ctdeps.now(); if (now - last >= 1000) { last = now; o.progress?.(done, total, step); } };
  o.progress?.(0, total, step);
  await mkdir(to, { recursive: true });
  for (const f of files) {
    if (o.signal?.aborted) throw new ContentError("cancelled", 409);
    const src = join(from, ...f.rel.split("/")), dst = join(to, ...f.rel.split("/"));
    await mkdir(dirname(dst), { recursive: true });
    if (copy && o.sums) {
      const before = hashedStat(await lstat(src));
      const h = new Bun.CryptoHasher("sha256");
      await copyOut(src, dst, { signal: o.signal, hash: h, onBytes: n => { done += n; tell(); } });
      if (before.size !== f.size || !sameStat(before, hashedStat(await lstat(src)))) throw new EnvError("changed", `${f.rel} changed while it was being read: it is looked at again later`);
      o.sums.set(f.rel, h.digest("hex"));
    } else if (copy) await copyOut(src, dst, { signal: o.signal, onBytes: n => { done += n; tell(); } });
    else { await ctdeps.link(src, dst); done += f.size; tell(); }
  }
  o.progress?.(done, total, step);
}

/**
 * A game folder kept as one row (shape 'folder'): links refused, every path one a player's PC can hold (for a folder that
 * ships), hashed where it lies first (or named by its sizes and times), then a duplicate of a kept folder is dropped before
 * anything is written; else it is linked (or moved: one rename, straight into its store folder) into the store on the
 * same volume — no bytes written — or copied across volumes, and its listing is kept beside it as <folder>.tree.tsv. A
 * folder that ships and is copied is read once, as it is copied (a kept folder of its very size makes it read first, so a
 * duplicate is still never written). Every step reports bytes of the whole about every second, with the step it is on
 * (TreeStep).
 */
export async function ingestTree(dir: string, t: Target, o: TreeOpts): Promise<Ingested> {
  if (t.role !== "game") throw new ContentError("a game folder is a game's, never a plan's need", 400);
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory() || st.isSymbolicLink()) throw new ContentError(`${basename(dir)} is not a folder`, 400);
  const { files, open } = await treeOf(dir, { ships: o.hash, refuseOwners: o.refuseOwners, looking: o.looking });
  if (!files.length) throw new ContentError(`${basename(dir)} is an empty folder`, 400);
  const total = files.reduce((n, f) => n + f.size, 0);
  const { dir: store, incoming } = await storeFor(t);
  await sweepIncoming(incoming);
  // a folder that is copied in (another volume; or one device whose shares hold no hard links between them, which one link
  // tried tells — a file read where it lies there would be read again by the copy) is read once, as it is copied, and
  // named from those bytes — unless the game keeps a folder of its very size: that one is read first, so a duplicate is
  // never written. Every other folder is named before anything moves: its contents (a folder that ships) or its sizes and
  // times (an input)
  const linksHere = o.mode === "link" ? await linksInto(join(dir, ...files[0].rel.split("/")), t) : false;
  const copied = o.mode === "copy" || (o.mode === "link" && !linksHere) || (o.mode === "move" && !(await ctdeps.sameVolume(dir, store)));
  const unknown = files.some(f => { const k = o.known?.get(f.rel); return !(k && k.size === f.size && (k.mtimeMs == null || k.mtimeMs === f.mtimeMs)); });
  const asCopied = o.hash && copied && unknown && !(wstmts.contentsForGame.all(t.game.id) as ContentRow[]).some(r => r.shape === "folder" && r.size === total);
  const sums = o.hash && !asCopied ? await hashTree(dir, files, { signal: o.signal, progress: (b, n) => o.progress?.(b, n, "hashing"), known: o.known, now: ctdeps.now }) : null;
  const named = (tags: (f: TreeFile) => string) => listingDigest(files.map(f => ({ rel: f.rel, size: f.size, tag: tags(f) })));
  let listing = asCopied ? null : sums ? listingDigest(sums.map(f => ({ rel: f.rel, size: f.size, tag: f.sha256 }))) : named(f => String(Math.round(f.mtimeMs)));
  const keptAs = (l: { hashes: Hashes }) => { const same = wstmts.contentBySha256.get(t.game.id, l.hashes.sha256!) as ContentRow | null; return same && same.shape === "folder" && existsSync(same.path) ? same : null; };
  const same = listing ? keptAs(listing) : null;
  if (same) {
    if (o.mode === "move") await removeTree(dir).catch(() => [] as string[]);
    return { row: same, duplicate: true, linked: o.mode !== "copy" };
  }
  const name = storeName(o.name ?? basename(dir));
  const lt = { signal: o.signal, progress: o.progress };
  let linked = o.mode !== "copy", placed: string | null = null, tmp: string | null = null;
  try {
    if (o.mode === "move" && !copied) {
      // one rename into the store folder: the folder is never anywhere but where the admin put it, or kept
      await roomFor(store, 0);
      try { placed = await placeFolder(store, name, dir); }
      catch (e: any) { if (e?.code !== "EXDEV") throw e; }
    }
    if (!placed && o.mode === "link" && linksHere) {
      await roomFor(store, 0);
      tmp = join(incoming, incomingName("tree"));
      try { await linkTree(dir, tmp, files, false, lt); }
      catch (e: any) { if (!NO_LINK.has(e?.code)) throw e; await removeTree(tmp); tmp = null; }
      if (tmp) { placed = await placeFolder(store, name, tmp); tmp = null; }
    }
    if (!placed) {
      // across volumes, or a share without hard links: copied, after the free space is checked
      linked = false;
      await roomFor(store, total);
      tmp = join(incoming, incomingName("tree"));
      const got = asCopied ? new Map<string, string>() : undefined;
      await linkTree(dir, tmp, files, true, { ...lt, sums: got });
      if (got) {
        // named from the bytes it was copied as: a folder the game keeps with these very files is that folder, and our
        // copy goes (a moved one's original with it, as when it is found before)
        listing = named(f => got.get(f.rel)!);
        const kept = keptAs(listing);
        if (kept) {
          await removeTree(tmp).catch(() => [] as string[]); tmp = null;
          if (o.mode === "move") await removeTree(dir).catch(() => [] as string[]);
          return { row: kept, duplicate: true, linked: false };
        }
      }
      placed = await placeFolder(store, name, tmp); tmp = null;
    }
    if (!listing) throw new Error("the folder was taken in without its listing");
    if (linked) await treeNoWorldWrite(placed, open, o.progress ? (b, n) => o.progress!(b, n, "protecting") : undefined);
    await writeFile(`${placed}.tree.tsv`, listing.text);
    const identity = o.identity !== undefined ? o.identity : await ctdeps.readFolderIdentity(placed, o.platform ?? null);
    const platform = identity && DEFINITIVE.has(identity.platform) ? identity.platform : (o.platform ?? identity?.platform ?? null);
    const row = insertContent({ gameId: t.game.id, role: "game", platform, name: basename(placed), path: placed, size: total, hashes: listing.hashes, source: o.source ?? "path", identity, shape: "folder", made: o.made ?? null, stat: null });
    if (o.mode === "move" && !linked) await removeTree(dir).catch(() => [] as string[]);
    return { row, duplicate: false, linked };
  } catch (e) {
    // nothing half-made stays: a folder moved in goes back where it was, a tree of ours goes
    if (placed) await unlink(`${placed}.tree.tsv`).catch(() => { /* none */ });
    if (placed && existsSync(placed)) {
      if (o.mode === "move" && linked && !existsSync(dir)) await rename(placed, dir).catch(() => { /* left in the store's folders */ });
      else await removeTree(placed).catch(() => [] as string[]);
    } else if (tmp && existsSync(tmp)) await removeTree(tmp).catch(() => [] as string[]);
    throw e;
  }
}

/** a file (or folder) a make produced, moved from the job's scratch folder into the store (the same volume: a rename, no
 *  bytes written) and hashed once with progress ("checking what it made"), kept as source 'made' with what it was made from */
export async function ingestMade(path: string, t: Target, o: { made: MadeInfo; signal?: AbortSignal; progress?: (bytes: number, total: number) => void; platform?: string | null; identity?: Identity | null }): Promise<Ingested> {
  const st = await lstat(path).catch(() => null);
  if (!st || st.isSymbolicLink()) throw new ContentError(`what the make produced (${basename(path)}) is not there`, 400);
  // a product is moved in, owner and all: one a build program's user still owns could be changed after it is kept (the
  // make hands {out} back to ludarr first; this is the check that it did)
  const builders = ctdeps.sandboxUids();
  if (st.isDirectory()) return ingestTree(path, t, { mode: "move", hash: true, source: "made", made: o.made, signal: o.signal, progress: o.progress, platform: o.platform, identity: o.identity, refuseOwners: builders });
  if (builders.includes(st.uid)) throw new Error(`${basename(path)} is still a build program's user's: it is handed back to ludarr before it is kept`);
  return ingestFile(path, t, { source: "made", mode: "move", made: o.made, platform: o.platform ?? extPlatform(basename(path)), identity: o.identity, signal: o.signal, progress: (b, total) => o.progress?.(b, total) });
}

const reEscape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The volumes of a multi-volume archive whose first volume is `first` (it comes first, then the others in their order):
 * name.part01.rar …, name.rar + name.r00 …, name.zip + name.z01 …, name.7z.001 …, name.001 …; null when `first` is not
 * the first volume of a set of two or more. The kind is what the set is an archive of (rar, zip, 7z, or the bare 001).
 */
export async function archiveSet(first: string): Promise<{ parts: string[]; kind: string; stem: string } | null> {
  const dir = dirname(first), name = basename(first);
  let m: RegExpExecArray | null;
  let member: RegExp, kind: string, stem: string, order: (n: string) => number;
  if ((m = /^(.*)\.part0*1\.rar$/i.exec(name))) {
    stem = m[1]; kind = "rar"; member = new RegExp(`^${reEscape(stem)}\\.part(\\d+)\\.rar$`, "i");
    order = n => Number(member.exec(n)?.[1] ?? 0);
  } else if ((m = /^(.*)\.(7z|zip|rar)\.0*1$/i.exec(name))) {
    stem = m[1]; kind = m[2].toLowerCase(); member = new RegExp(`^${reEscape(stem)}\\.${m[2]}\\.(\\d+)$`, "i");
    order = n => Number(member.exec(n)?.[1] ?? 0);
  } else if ((m = /^(.*)\.001$/i.exec(name))) {
    stem = m[1]; kind = "001"; member = new RegExp(`^${reEscape(stem)}\\.(\\d{3,})$`, "i");
    order = n => Number(member.exec(n)?.[1] ?? 0);
  } else if ((m = /^(.*)\.rar$/i.exec(name))) {
    stem = m[1]; kind = "rar"; member = new RegExp(`^${reEscape(stem)}\\.(rar|r\\d\\d)$`, "i");
    order = n => (/\.rar$/i.test(n) ? -1 : Number(n.slice(-2)));
  } else if ((m = /^(.*)\.zip$/i.exec(name))) {
    stem = m[1]; kind = "zip"; member = new RegExp(`^${reEscape(stem)}\\.(zip|z\\d\\d)$`, "i");
    order = n => (/\.zip$/i.test(n) ? -1 : Number(n.slice(-2)));
  } else return null;
  const names = (await readdir(dir).catch(() => [] as string[])).filter(n => member.test(n));
  if (names.length < 2 || !names.includes(name)) return null;
  return { parts: names.sort((a, b) => order(a) - order(b)).map(n => join(dir, n)), kind, stem };
}

/** a multi-volume archive taken in as one file row: every volume moved (or linked) together into <stem>.parts/ in the
 *  game's store folder, hashed once in volume order where it lies (the hashes of the whole set); the row's file is its
 *  first volume, so an archiver opening it finds the others beside it */
async function ingestSet(set: { parts: string[]; stem: string }, t: Target & { role: "game" }, o: { mode: "link" | "move"; source: ContentRow["source"]; signal?: AbortSignal; progress?: (bytes: number, total: number, step?: TreeStep) => void }): Promise<Ingested> {
  const stats = await Promise.all(set.parts.map(p => lstat(p)));
  if (stats.some(x => x.isSymbolicLink() || !x.isFile())) throw new ContentError(`a volume of ${basename(set.parts[0])} is not a regular file`, 400);
  const total = stats.reduce((n, x) => n + x.size, 0);
  const { dir, incoming } = await storeFor(t);
  await sweepIncoming(incoming);
  await roomFor(dir, 0);
  // the whole set read once, in order, before anything moves
  const h = await StreamHasher.create();
  let done = 0, last = ctdeps.now();
  o.progress?.(0, total, "hashing");
  for (const [i, p] of set.parts.entries()) {
    for await (const chunk of fileChunks(p)) {
      if (o.signal?.aborted) throw new ContentError("cancelled", 409);
      h.push(chunk); done += chunk.byteLength;
      const now = ctdeps.now();
      if (now - last >= 1000) { last = now; o.progress?.(done, total, "hashing"); }
    }
    if (!sameStat(hashedStat(stats[i]), hashedStat(await lstat(p)))) throw new EnvError("changed", `${basename(p)} changed while it was being read: it is looked at again later`);
  }
  const { result } = h.end();
  o.progress?.(done, total, "hashing");
  const same = sameStoredFile(result.hashes.sha1!, { role: "game", gameId: t.game.id });
  if (same && existsSync(same.path)) {
    if (o.mode === "move") for (const p of set.parts) await unlink(p).catch(() => { /* left where it was */ });
    return { row: same, duplicate: true, linked: true };
  }
  // kept in <stem>.parts/ in the game's store folder: moved volumes go straight there (never through .incoming, so neither
  // a crash nor another intake's sweep can lose the admin's files); links are made in a tree of ours first; a volume that
  // cannot be linked or moved (another volume) is copied with progress, once the room for what is left is checked
  const name = storeName(`${set.stem}.parts`);
  const moved: [string, string][] = [], copiedTo: string[] = [];
  const ours = o.mode !== "move";
  let at: string | null = null, toCopy = 0, copyDone = 0, copyLast = ctdeps.now();
  try {
    if (ours) { at = join(incoming, incomingName("tree")); await mkdir(at, { recursive: true }); }
    else at = await claimFolder(dir, name);
    for (const [i, p] of set.parts.entries()) {
      const to = join(at, basename(p));
      try {
        if (o.mode === "move") { await rename(p, to); moved.push([to, p]); } else await ctdeps.link(p, to);
      } catch (e: any) {
        if (!NO_LINK.has(e?.code)) throw e;
        if (!toCopy) { toCopy = stats.slice(i).reduce((n, x) => n + x.size, 0); await roomFor(dir, toCopy); }
        copiedTo.push(to);
        await copyOut(p, to, { signal: o.signal, onBytes: n => { copyDone += n; const now = ctdeps.now(); if (now - copyLast >= 1000) { copyLast = now; o.progress?.(copyDone, toCopy, "copying"); } } });
      }
    }
    if (toCopy) o.progress?.(copyDone, toCopy, "copying");
    const placed = ours ? await placeFolder(dir, name, at) : at;
    at = placed;
    const copiedNames = new Set(copiedTo.map(c => basename(c)));
    for (const p of set.parts) if (!copiedNames.has(basename(p))) await noWorldWrite(join(placed, basename(p)));
    const first = join(placed, basename(set.parts[0]));
    const row = insertContent({ gameId: t.game.id, role: "game", platform: null, name: basename(first), path: first, size: total, hashes: result.hashes, source: o.source, identity: null, shape: "file", stat: null });
    // a move across volumes copied the volumes: the originals go once the set is kept
    if (o.mode === "move" && copiedTo.length) for (const p of set.parts) if (existsSync(p)) await unlink(p).catch(() => { /* left where it was */ });
    return { row, duplicate: false, linked: !copiedTo.length };
  } catch (e) {
    // the admin's volumes go back where they were; what is ours goes (a volume that could not be put back stays kept)
    let back = true;
    for (const [to, from] of moved) await rename(to, from).catch(() => { back = false; });
    if (ours && at) await removeTree(at).catch(() => [] as string[]);
    else if (at) { for (const c of copiedTo) await unlink(c).catch(() => { /* never written */ }); if (back) await rmdir(at).catch(() => { /* not empty */ }); }
    throw e;
  }
}

/** a new empty folder in `dir` called `name`, or "<name> (2)" …: one no other intake has (mkdir refuses a name taken) */
async function claimFolder(dir: string, name: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, i === 1 ? name : `${name} (${i})`);
    if (existsSync(`${candidate}.tree.tsv`)) continue;
    try { await mkdir(candidate); return candidate; }
    catch (e: any) { if (e?.code === "EEXIST") continue; throw e; }
  }
  throw new ContentError(`more than 999 folders called ${name} for this game`, 409);
}

/** what became of a file or folder handed to the game: the row it became (null: nobody took it and it stays where it is),
 *  the ways it is now the file of, the ways whose make takes it as input, and why each other way did not take it */
export interface IntakeResult { row: ContentRow | null; attached: number[]; inputFor: number[]; notes: string[] }

const SEALED_FORMS = new Set(["nsp", "xci", "nsz", "xcz", "pkg"]);
const formatOf = (name: string) => (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
/** the first of these folder-relative files a folder does not hold as a plain file (a link or a folder of that name is not
 *  it), or null */
async function missingFrom(dir: string, rels: string[]): Promise<string | null> {
  for (const r of rels) if ((await lstat(join(dir, ...r.split("/"))).catch(() => null))?.isFile() !== true) return r;
  return null;
}

/** what of a make input's whole-game check intake can judge: the counts its plan gives. The program's own list of the
 *  game's files is read from the pinned program, which only the make has (src/ways/make.ts judges the input with it before
 *  any step), so intake leaves the list to the make — refusing for it would refuse every dump; null: nothing to count */
function countsOf(c: Completeness | undefined): Completeness | null {
  if (!c) return null;
  const { list: _list, ...counts } = c;
  return counts.minFiles != null || counts.minBytes != null ? counts : null;
}

/** a long walk of an entry (every file looked at by lstat) said about once a second: how many files, how many bytes so far */
export type Looking = (files: number, bytes: number) => void;
function everySecond(fn: Looking | undefined): Looking | undefined {
  if (!fn) return undefined;
  let last = ctdeps.now();
  return (files, bytes) => { const now = ctdeps.now(); if (now - last >= 1000) { last = now; fn(files, bytes); } };
}

/** a file or folder against one way: its game file as it is, or what its make takes, or neither (why) */
async function judgeForWay(path: string, shape: "file" | "folder", name: string, size: number, c: ContentPlan, identity: Identity | null, looking?: Looking): Promise<{ product: Verdict; input: Verdict | null }> {
  const platform = identity && DEFINITIVE.has(identity.platform) ? identity.platform : (shape === "file" ? extPlatform(name) : null) ?? identity?.platform ?? c.platform;
  const f: FileFacts = { platform, name, size, hashes: {}, identity, shape };
  const sealed = identity?.sealed === true || (shape === "file" && SEALED_FORMS.has(formatOf(name)));
  // the game file as it is (its hash, when the way lists one, is read once it is kept)
  let product: Verdict;
  if ((c.kind === "folder") !== (shape === "folder")) product = { ok: false, why: c.kind === "folder" ? `a .${formatOf(name) || "?"} file, and this needs the game folder${c.marker ? ` (holding ${c.marker})` : ""}` : `a folder, and this needs one ${(c.accept.formats ?? []).map(x => "." + x).join(" or ") || "game"} file` };
  else if (sealed && !(c.accept.formats ?? []).includes(formatOf(name))) product = { ok: false, why: "encrypted for the console: nothing can open it" };
  else {
    product = contentMatches(c.accept.hashes.length ? { ...c, accept: { ...c.accept, hashes: [] } } : c, f);
    // a game folder holds its marker and every file the way names beside it, as plain files
    const gone = product.ok && shape === "folder" && c.marker ? await missingFrom(path, [c.marker, ...(c.also ?? [])]) : null;
    if (gone) product = { ok: false, why: `a folder without ${gone}` };
    if (product.ok && shape === "folder" && c.complete) { const w = await ctdeps.completeness(path, c.complete, { progress: looking }); if (!w.ok) product = { ok: false, why: w.why ?? "an update or a part of the game, not the whole game" }; }
  }
  // what the way's make takes
  let input: Verdict | null = null;
  const inp = c.make?.input;
  const inputGone = inp && shape === "folder" && inp.marker ? await missingFrom(path, [inp.marker, ...(inp.also ?? [])]) : null;
  if (inp && (!c.make!.from?.length || c.make!.from.some(x => x === "inbox" || x === "kept"))) {
    if (sealed && !takesMakeFile(inp, shape, name)) input = { ok: false, why: "this recipe does not process its encrypted format" };
    else if (inp.shape === "file" && shape === "folder") input = { ok: false, why: "a folder, and its make takes one file" };
    else if (inp.shape === "folder" && shape === "file") input = { ok: false, why: `a file, and its make takes the game folder${inp.marker ? ` (holding ${inp.marker})` : ""}` };
    else if (shape === "file" && (inp.formats ?? []).length && !(inp.formats ?? []).includes(formatOf(name))) input = { ok: false, why: `a .${formatOf(name) || "?"} file, and its make takes ${(inp.formats ?? []).map(x => "." + x).join(", ")}` };
    else if (inputGone) input = { ok: false, why: `a folder without ${inputGone}` };
    else {
      input = ctdeps.inputMatches(inp, { ...f, platform: identity && DEFINITIVE.has(identity.platform) ? identity.platform : inp.platform });
      const counts = shape === "folder" ? countsOf(inp.complete) : null;
      if (input.ok && counts) { const w = await ctdeps.completeness(path, counts, { progress: looking }); if (!w.ok) input = { ok: false, why: w.why ?? "an update or a part of the game, not the whole game" }; }
    }
  }
  return { product, input };
}

/**
 * A file or folder handed to the game (an inbox entry, a server path, a download) judged for each of the game's ways: one
 * that is a way's game file is kept (linked or moved in, hashed once) and attached where it fits; one that is what a way's
 * make takes is kept as an input row (the carry run queues the make); neither: nothing is written and the notes say why,
 * one line per way. The same bytes kept already are never written again.
 */
export async function intakeEntry(path: string, game: GameRow, o: { source: "inbox" | "path" | "indexer" | "upload"; move: boolean;
  /** taken in for this way (the admin named it): where its own judging takes the entry, it becomes its game file, also in
   *  place of the one it has — as a single file taken in for a way does (attachToWays) */
  wayId?: number | null; signal?: AbortSignal; log?: (line: string) => void; progress?: (bytes: number, total: number, step?: TreeStep) => void; looking?: Looking }): Promise<IntakeResult> {
  const say = o.log ?? (() => {});
  const name = basename(path);
  const st = await lstat(path).catch(() => null);
  if (!st) throw new ContentError(`${name} is not there any more`, 404);
  if (st.isSymbolicLink()) return { row: null, attached: [], inputFor: [], notes: [`${name} is a link: put the file or folder itself there`] };
  const shape: "file" | "folder" | null = st.isDirectory() ? "folder" : st.isFile() ? "file" : null;
  if (!shape) return { row: null, attached: [], inputFor: [], notes: [`${name} is neither a file nor a folder`] };
  const ways = waysOfGame(game.id).flatMap(w => { const p = getPlan(w.plan_id); const c = p ? wayContent(w, p) : null; return p && c ? [{ w, p, c }] : []; });
  if (!ways.length) return { row: null, attached: [], inputFor: [], notes: [`${game.name} has no way to play that takes game data`] };
  // a multi-volume archive is one entry: judged by its first volume, as an archive of its kind, kept whole
  const set = shape === "file" ? await archiveSet(path) : null;
  const judgedName = set ? `${set.stem}.${set.kind}` : name;
  const size = set ? (await Promise.all(set.parts.map(p => lstat(p)))).reduce((n, x) => n + x.size, 0) : shape === "file" ? st.size : 0;
  // what it is, read where it lies (small reads), once per console a way plays
  const ids = new Map<string, Identity | null>();
  const idFor = async (platform: string) => {
    if (!ids.has(platform)) ids.set(platform, shape === "file" ? await ctdeps.readIdentity(path, platform, name) : await ctdeps.readFolderIdentity(path, platform));
    return ids.get(platform) ?? null;
  };
  const verdicts: { w: WayRow; p: PlanRow; c: ContentPlan; product: Verdict; input: Verdict | null }[] = [];
  const looking = everySecond(o.looking);
  for (const x of ways) verdicts.push({ ...x, ...(await judgeForWay(path, shape, judgedName, size, x.c, set ? null : await idFor(x.c.platform), looking)) });
  const products = verdicts.filter(v => v.product.ok), inputs = verdicts.filter(v => !v.product.ok && v.input?.ok);
  const noteOf = (v: (typeof verdicts)[number]) => `${v.p.name}: ${v.input && !v.input.ok && v.c.make ? `neither its game file (${v.product.why}) nor what it is made from (${v.input.why})` : v.product.why ?? v.input?.why ?? "not taken"}`;
  if (!products.length && !inputs.length) return { row: null, attached: [], inputFor: [], notes: verdicts.map(noteOf) };
  const t: Target = { role: "game", game };
  const identity = set ? null : await idFor((products[0] ?? inputs[0]).c.platform);
  const mode = o.move ? "move" : "link";
  say(`${name}: ${products.length ? `the game file of ${products.map(v => v.p.name).join(", ")}` : `what ${inputs.map(v => v.p.name).join(", ")} make${inputs.length === 1 ? "s" : ""} its game file from`}: taking it in`);
  const r = set
    ? await ingestSet(set, t as Target & { role: "game" }, { mode, source: o.source, signal: o.signal, progress: o.progress })
    : shape === "folder"
    ? await ingestTree(path, t, { mode, hash: products.length > 0, source: o.source, signal: o.signal, progress: o.progress, looking: o.looking, identity, platform: (products[0] ?? inputs[0]).c.platform })
    : await ingestFile(path, t, { source: o.source, mode, platform: identity && DEFINITIVE.has(identity.platform) ? identity.platform : null, wayPlatform: (products[0] ?? inputs[0]).c.platform, identity, signal: o.signal, progress: (b, total, s) => o.progress?.(b, total, s) });
  // attached only where the way's own judging took it: a way that turned it down for its marker or as a part of the game
  // (what contentMatches alone cannot see) never gets it because another way took it
  const a = products.length ? attachToWays(r.row, { only: products.map(v => v.w.id), wayId: o.wayId != null && products.some(v => v.w.id === o.wayId) ? o.wayId : null }) : { attached: [] as number[], checks: [] as FileCheck[] };
  for (const c of a.checks) if (!c.ok) say(`${c.plan}: ${c.why}`);
  const inputFor = inputs.map(v => v.w.id);
  // a way whose hash the full read turned down says so in its own words; one that keeps the file it has says that
  const checks = new Map(a.checks.map(c => [c.wayId, c] as const));
  const out = verdicts.filter(v => !a.attached.includes(v.w.id) && !inputFor.includes(v.w.id)).map(v => {
    const c = checks.get(v.w.id);
    if (v.product.ok && c && !c.ok) return `${v.p.name}: ${c.why}`;
    if (v.product.ok && c?.ok) return `${v.p.name}: it fits, and the way keeps the game file it has${assembling(v.w.id) ? " (it is being built)" : ""}`;
    return noteOf(v);
  });
  // what every way turned down once it was read through is not kept: it goes back where it was, and stays there
  if (!r.duplicate && !a.attached.length && !inputFor.length && !a.checks.some(c => c.ok)) {
    await giveBack(r.row, path, set?.parts ?? null, mode).catch(e => say(`${name} could not be put back where it was: ${e?.message ?? e}`));
    return { row: null, attached: [], inputFor: [], notes: out };
  }
  return { row: r.row, attached: a.attached, inputFor, notes: out };
}

/** a kept file, folder or archive set that nobody took after all: a move is undone (it goes back where it came from), a
 *  link or a copy of ours goes */
async function giveBack(row: ContentRow, from: string, parts: string[] | null, mode: "move" | "link"): Promise<void> {
  if (mode === "link") { await removeContent(row.id); return; }
  if (parts) {
    for (const p of parts) await rename(join(dirname(row.path), basename(p)), p);
    await removeTree(dirname(row.path));
  } else if (row.shape === "folder") {
    await rename(row.path, from);
    await unlink(`${row.path}.tree.tsv`).catch(() => { /* none */ });
  } else await rename(row.path, from);
  wstmts.deleteContent.run(row.id);
}

/* ─────────── what a file is for ─────────── */

export function gameTarget(gameId: unknown): Target {
  if (gameId === undefined || gameId === null || gameId === "") throw new ContentError("gameId is required (the game the file is for)", 400);
  const g = Number.isInteger(Number(gameId)) ? (stmts.gameById.get(Number(gameId)) as GameRow | null) : null;
  if (!g) throw new ContentError("no such game", 404);
  return { role: "game", game: g };
}
export function needTarget(planId: unknown, index: unknown): Target & { role: "system" } {
  const p = Number.isInteger(Number(planId)) ? getPlan(Number(planId)) : null;
  if (!p) throw new ContentError("no such plan", 404);
  const i = Number(index), needs = planSpec(p).needs;
  if (!Number.isInteger(i) || i < 0 || i >= needs.length) throw new ContentError(`the plan has ${needs.length ? `needs 0 to ${needs.length - 1}` : "no needs"}`, 404);
  return { role: "system", plan: p, needIndex: i };
}
/** a system file must be the one its need asks for */
export const needAccept = (t: Target & { role: "system" }) => (f: FileFacts) => needMatches(planSpec(t.plan).needs[t.needIndex], f);
/** the console of the way a game file is taken in for, when the admin names one of the game's ways */
export function namedWayPlatform(wayId: number | null | undefined, gameId: number): string | null {
  const w = wayId != null ? (wstmts.wayById.get(Number(wayId)) as WayRow | null) : null;
  const p = w && w.game_id === gameId ? getPlan(w.plan_id) : null;
  return w && p ? wayContent(w, p)?.platform ?? null : null;
}

export interface FileCheck { wayId: number; plan: string; ok: boolean; why: string | null }

const jsonList = (s: string | null | undefined): string[] => { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };

/**
 * A game file judged for a way nobody took it in for. A file whose console is not known (an .iso, a .chd could be any
 * console's; no extension names PC data) goes only to a way that checks it by hash, to a console's way when that is the
 * game's only console, or to a PC way when the game is on no console at all; for any other way the check says which
 * platform it must be.
 */
export function fitsUnasked(c: ContentPlan, f: FileFacts, game: Pick<GameRow, "platforms_json"> | null | undefined): Verdict {
  const v = contentMatches(c, f);
  if (!v.ok || f.platform || c.accept.hashes.length) return v;
  const consoles = consolePlatforms(jsonList(game?.platforms_json));
  const forConsole = isConsole(c.platform);
  if (forConsole ? consoles.length === 1 && consoles[0] === c.platform : consoles.length === 0) return v;
  return { ok: false, why: `a file of no known ${forConsole ? "console" : "platform"}, and this needs a ${c.platform} one: take it in for this way, or with its platform` };
}

/** a kept game file the admin gave (an upload, a file picked on the server, an entry put in the game's inbox), not one that
 *  came with a download (the console copy an import made, taken in by the hand-off or by a build) */
export const adminGave = (f: Pick<ContentRow, "source">) => f.source === "upload" || f.source === "path" || f.source === "inbox";

/**
 * The kept game file a new way takes by itself (POST /api/v1/game/:id/ways, and the way a construct job makes): the
 * admin's own file for it (`own`) when it fits; else one kept for the game that fits, whose console is known or that
 * fitsUnasked lets go there, and — when it came with a download (an imported dump) — only for a way that checks it by hash.
 */
export function keptFileFor(c: ContentPlan, game: GameRow, own: ContentRow | null = null): ContentRow | null {
  if (own && own.role === "game" && own.game_id === game.id && existsSync(own.path) && contentMatches(c, contentFacts(own)).ok) return own;
  const kept = wstmts.contentsForGame.all(game.id) as ContentRow[];
  // the admin's own files; one that came with a download (an imported dump, a search's file) only when the way's check proves it
  return kept.find(f => { if (f.role !== "game" || !existsSync(f.path)) return false; const v = fitsUnasked(c, contentFacts(f), game); return v.ok && (adminGave(f) || proven(v)); }) ?? null;
}

/**
 * A game file that just landed, against each of the game's ways: it is attached to every way that has no matching file
 * yet (and to `wayId` when that one names it), and each way's status follows. A way that already has a matching file
 * keeps it; one being built is left alone; a file whose console is not known goes only where fitsUnasked lets it.
 */
export function attachToWays(row: ContentRow, opts: { wayId?: number | null; only?: number[] } = {}): { attached: number[]; checks: FileCheck[] } {
  const attached: number[] = [], checks: FileCheck[] = [];
  if (row.role !== "game" || row.game_id == null) return { attached, checks };
  const facts = contentFacts(row);
  const game = stmts.gameById.get(row.game_id) as GameRow | null;
  for (const w of waysOfGame(row.game_id)) {
    if (opts.only && !opts.only.includes(w.id)) continue;                   // a way that judged the file itself and turned it down
    const p = getPlan(w.plan_id);
    const c = p ? wayContent(w, p) : null;
    if (!p || !c) continue;                                                 // a way that needs no game file
    const v = opts.wayId === w.id ? contentMatches(c, facts) : fitsUnasked(c, facts, game);
    checks.push({ wayId: w.id, plan: p.name, ok: v.ok, why: v.why });
    if (v.ok && !assembling(w.id) && (w.content_id == null || opts.wayId === w.id || !keepsMatchingFile(w, p))) { updateWay(w.id, { contentId: row.id }); attached.push(w.id); }
    settleWay(w.id);
  }
  return { attached, checks };
}
function keepsMatchingFile(w: WayRow, p: PlanRow): boolean {
  const cur = w.content_id != null ? getContent(w.content_id) : null, c = wayContent(w, p);
  return !!cur && !!c && existsSync(cur.path) && contentMatches(c, contentFacts(cur)).ok;
}

/**
 * The only way a stored file (or folder) is deleted: the row and what it keeps (only ever inside a content store: a folder
 * with its .tree.tsv), then the ways that used it settle (a built way keeps its package; a rebuild needs a file again).
 */
export async function removeContent(id: number): Promise<{ row: ContentRow; ways: WayRow[] }> {
  const row = getContent(id);
  if (!row) throw new ContentError("no such file", 404);
  const ways = row.role === "game" ? waysUsingContent(id) : row.plan_id != null ? waysOfPlan(row.plan_id) : [];
  if (ways.some(w => assembling(w.id))) throw new EnvError("busy", "a way that uses this file is being built");
  const st = await lstat(row.path).catch(() => null);
  const inStore = row.path.split(/[\\/]/).includes(STORE);
  if (st?.isFile() && inStore && /\.parts$/i.test(basename(dirname(row.path))) && dirname(dirname(row.path)).split(/[\\/]/).includes(STORE)) {
    // an archive set: every volume sits beside its first in <stem>.parts/
    const left = await removeTree(dirname(row.path));
    if (left.length) throw new ContentError(`could not remove all of ${row.name}: ${left.length} entr${left.length === 1 ? "y is" : "ies are"} still held open`, 500);
  } else if (st?.isFile() && inStore) {
    try { await unlink(row.path); }
    catch (e: any) { if (e?.code !== "ENOENT") throw new ContentError(`could not remove ${row.path}: ${e?.message ?? e}`, 500); }
  } else if (st?.isDirectory() && !st.isSymbolicLink() && inStore && row.shape === "folder") {
    const left = await removeTree(row.path);
    if (left.length) throw new ContentError(`could not remove all of ${row.name}: ${left.length} entr${left.length === 1 ? "y is" : "ies are"} still held open`, 500);
    await unlink(`${row.path}.tree.tsv`).catch(() => { /* none */ });
  }
  wstmts.deleteContent.run(id);
  // a kept file of the game's copy said which ways that copy stands in for: with it gone, they settle too
  if (row.role === "game" && row.source === "package" && row.game_id != null) settleWaysOnCopy(row.game_id);
  return { row, ways: ways.map(w => settleWay(w.id)).filter((w): w is WayRow => !!w) };
}

/** a file's verdict for one way (game files) or for its need (system files) */
export function checkContent(row: ContentRow, wayId?: number | null): Verdict & { against: string } {
  if (row.role === "system") {
    const p = row.plan_id != null ? getPlan(row.plan_id) : null;
    const need = p && row.need_index != null ? planSpec(p).needs[row.need_index] : null;
    if (!need) return { ok: false, why: "its need is gone from the plan", against: "need" };
    return { ...needMatches(need, contentFacts(row)), against: `need ${row.need_index}` };
  }
  const w = wayId != null ? wstmts.wayById.get(Number(wayId)) as WayRow | null : null;
  if (!w) throw new ContentError("pass the wayId of one of this game's ways", 400);
  if (w.game_id !== row.game_id) throw new ContentError("that way is another game's", 409);
  const p = getPlan(w.plan_id), c = p ? wayContent(w, p) : null;
  if (!c) return { ok: false, why: "this way needs no game file", against: `way ${w.id}` };
  return { ...contentMatches(c, contentFacts(row)), against: `way ${w.id}` };
}

/* ─────────── the job that takes in a file already on the server ─────────── */

/** what a content job works for: a plan's need when it names one, else its game */
function jobTarget(s: Extract<JobSpec, { kind: "content" }>): Target {
  if (s.planId != null) return needTarget(s.planId, s.needIndex);
  return gameTarget(s.gameId);
}

/** a long step's progress, said about once a second: "<step> · 12.3 of 54.2 GB". A new step is said at once, and moves the
 *  job's progress on from where the last one left it (reading a folder, then linking it in, never sends the bar back) */
function reporter(ctx: KindContext, from: number, to: number) {
  let last = 0, said = "", base = from, p = from;
  return (step: string) => (b: number, total: number) => {
    const now = ctdeps.now();
    if (step !== said) { if (said) base = p; said = step; last = Number.NEGATIVE_INFINITY; }
    if (now - last < 1000 && b < total) return;
    last = now;
    p = Math.max(p, base + (to - base) * 0.9 * Math.min(1, b / Math.max(1, total)));
    ctx.progress(p, `${step} · ${ofText(b, total)}`);
  };
}
/** a job's walk of an entry in words, about once a second: "looking at PPSA01341-app0 · 41,200 files (31.4 GB) so far" */
const lookingAt = (ctx: KindContext, entry: string): Looking => (files, bytes) => ctx.progress(0.01, `looking at ${entry} · ${files.toLocaleString("en-US")} file${files === 1 ? "" : "s"} (${gb(bytes)}) so far`);

/** what a step of taking a file or folder in is called in a job's message, with what it is done to */
const stepText = (s: TreeStep | "hashing" | "copying" | undefined, what: string) =>
  s === "protecting" ? `protecting ${what} from changes` : `${s === "linking" ? "linking" : s === "copying" ? "copying" : "hashing"} ${what}`;

/** the game's copy taken for one way (a carry run's hand-over): a hard link and a hash where it lies, or the kept row of
 *  the same bytes; refused with the copy's own words when it is not the way's file */
async function takeFromCopy(ctx: KindContext, s: Extract<JobSpec, { kind: "content" }>): Promise<KindResult> {
  const way = s.wayId != null ? getWay(s.wayId) : null;
  if (!way) throw new Error("the way to play is gone");
  const plan = getPlan(way.plan_id), c = plan ? wayContent(way, plan) : null;
  if (!plan || !c) throw new Error("the way needs no game file, or its plan is gone");
  const game = stmts.gameById.get(way.game_id) as GameRow | undefined;
  if (!game) throw new Error("the way's game is gone");
  if (assembling(way.id)) throw new EnvError("busy", "the way is being built: its game file is taken once that build ends");
  ctx.progress(0.01, "looking at the game's copy");
  const say = reporter(ctx, 0.02, 0.98);
  const { takeCopy } = await import("./copy");
  const row = await takeCopy({ game, way, content: c, log: ctx.log, signal: ctx.signal, progress: (b, total, step) => say(step ?? "hashing the game's copy")(b, total), looking: lookingAt(ctx, "the game's copy") });
  if (!row) throw new NeedsFiles("the game has no copy on the server any more");
  // the way the hand-over is for, only: another way takes the copy when the copy is its file (the kept row then, nothing
  // read), never because this one did — a way that checks nothing is never handed a dump nobody proved for it
  const a = attachToWays(row, { wayId: way.id, only: [way.id] });
  const mine = a.checks.find(x => x.wayId === way.id);
  if (!a.attached.includes(way.id) && getWay(way.id)?.content_id !== row.id) throw new NeedsFiles(`${row.name} was not taken: ${mine?.why ?? "the way did not take it"}`);
  ctx.log(`${row.name} is the game file of ${plan.name} now`);
  return { message: `${row.name} is the game file of ${plan.name} now (taken from the game's copy)`, manifest: { fromCopy: true, wayId: way.id, contentId: row.id } };
}

/** a small text file of ludarr's own at `path` (the note beside an inbox entry): written as a new file beside it (a dot
 *  name the inbox scan passes over) and renamed over the name, so whatever was put there under that name — a hard link to
 *  another file, a link root would follow — is replaced, never written through */
async function writeOwn(path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}`);
  const fh = await open(tmp, "wx");
  try { await fh.writeFile(text); } finally { await fh.close().catch(() => { /* closed */ }); }
  try { await rename(tmp, path); } catch (e) { await unlink(tmp).catch(() => { /* never made */ }); throw e; }
}

/** files inside an inbox entry that a build program's user owns: it was not the admin who put them there */
async function sandboxWritten(path: string, looking?: Looking): Promise<string | null> {
  const uids = new Set(ctdeps.sandboxUids());
  const tell = everySecond(looking);
  let seen = 0, files = 0, bytes = 0;
  const visit = async (p: string, rel: string): Promise<string | null> => {
    if (++seen > 400_000) return null;
    const st = await lstat(p).catch(() => null);
    if (!st) return null;
    if (uids.has(st.uid)) return rel || basename(p);
    if (st.isFile()) { files++; bytes += st.size; tell?.(files, bytes); }
    if (st.isDirectory() && !st.isSymbolicLink()) for (const n of await readdir(p).catch(() => [] as string[])) { const hit = await visit(join(p, n), rel ? `${rel}/${n}` : n); if (hit) return hit; }
    return null;
  };
  return visit(path, "");
}

/** an entry of the game's inbox folder: judged for each way and moved into the store, or left with a note beside it */
async function takeInboxEntry(ctx: KindContext, s: Extract<JobSpec, { kind: "content" }>): Promise<KindResult> {
  const t = gameTarget(s.gameId);
  if (t.role !== "game") throw new ContentError("no such game", 404);
  if (!s.path) throw new Error("this job names no inbox entry");
  const real = await realpath(s.path).catch(() => null);
  if (!real) throw new ContentError(`${basename(s.path)} is not in the inbox any more`, 404);
  const roots = await Promise.all(ctdeps.rootFolders().map(r => realpath(r.path).catch(() => null)));
  // <root>/.ahoy-inbox/<game folder>/<entry>: an entry inside a game's inbox folder, never the inbox or a game's folder itself
  const within = (r: string | null) => !!r && inside(real, join(r, INBOX)) && relative(join(r, INBOX), real).split(/[\\/]/).filter(Boolean).length >= 2;
  if (!roots.some(within)) throw new ContentError("not an entry of a game's inbox folder", 403);
  const entry = basename(real);
  const leave = async (notes: string[]): Promise<KindResult> => {
    await writeOwn(`${real}.not-taken.txt`, notes.join("\n") + "\n").catch(e => ctx.log(`could not write ${entry}.not-taken.txt: ${e?.message ?? e}`));
    const out: IntakeManifest = { inbox: true, entry, contentId: null, attached: [], inputFor: [], notes };
    for (const n of notes) ctx.log(n);
    return { message: notes[0] ?? `${entry} was not taken`, manifest: out as unknown as Record<string, unknown> };
  };
  // every volume of an archive set is moved with its first: each is checked, not only the one named
  const set = (await lstat(real).catch(() => null))?.isFile() ? await archiveSet(real) : null;
  ctx.progress(0.01, `looking at ${entry}`);
  const looking = lookingAt(ctx, entry);
  for (const p of set?.parts ?? [real]) {
    const by = await sandboxWritten(p, looking);
    if (by) return leave([`${entry} was not taken: ${p === real ? by : basename(p)} was written by a build program, not by you`]);
  }
  const say = reporter(ctx, 0.02, 0.98);
  const r = await intakeEntry(real, t.game, { source: "inbox", move: true, signal: ctx.signal, log: ctx.log, progress: (b, total, step) => say(stepText(step, entry))(b, total), looking });
  if (!r.row) return leave(r.notes.length ? r.notes : [`${entry} is no game data any way of ${t.game.name} takes`]);
  await unlink(`${real}.not-taken.txt`).catch(() => { /* none */ });
  const out: IntakeManifest = { inbox: true, entry, contentId: r.row.id, attached: r.attached, inputFor: r.inputFor, notes: r.notes };
  const what = r.attached.length ? `the game file of ${r.attached.length} way${r.attached.length === 1 ? "" : "s"}` : r.inputFor.length ? "kept: a way's game file is made from it" : "kept";
  return { message: `${r.row.name}: ${what}`, manifest: out as unknown as Record<string, unknown> };
}

/** a folder picked on the server for the game (never moved: it stays its owner's), or what the admin uploaded for it when
 *  that is a folder or an archive set (src/uploads.ts: linked into the store, then the upload's own folder goes) */
async function takePathFolder(ctx: KindContext, t: Target & { role: "game" }, real: string, source: "path" | "upload" = "path", wayId: number | null = null): Promise<KindResult> {
  ctx.log(source === "upload" ? `taking in the upload ${basename(real)} for ${t.game.name}` : `taking in the folder ${real} for ${t.game.name}`);
  ctx.progress(0.01, `looking at ${basename(real)}`);
  const say = reporter(ctx, 0.02, 0.98);
  const r = await intakeEntry(real, t.game, { source, move: false, wayId, signal: ctx.signal, log: ctx.log, progress: (b, total, step) => say(stepText(step, basename(real)))(b, total), looking: lookingAt(ctx, basename(real)) });
  if (!r.row) throw new NeedsFiles(`${basename(real)} was not taken: ${r.notes.join("; ")}`);
  for (const n of r.notes) ctx.log(n);
  const kept = `kept ${r.row.name}${r.attached.length ? `, the game file of ${r.attached.length} way${r.attached.length === 1 ? "" : "s"}` : r.inputFor.length ? ", what a way's game file is made from" : ""}`;
  // taken in for one way: the message says when the entry is not that way's (kept for another, or as what another makes
  // its file from), so it never reads as a file the way now has
  const named = wayId != null && !r.attached.includes(wayId) && !r.inputFor.includes(wayId) ? getWay(wayId) : null;
  const plan = named ? getPlan(named.plan_id) : null;
  const why = plan ? r.notes.find(n => n.startsWith(`${plan.name}: `))?.slice(plan.name.length + 2) ?? "it was not taken for it" : null;
  return { message: plan ? `${kept} — not the file ${plan.name} needs: ${why}` : kept, manifest: { contentId: r.row.id, attached: r.attached, inputFor: r.inputFor, notes: r.notes } };
}

registerJobKind("content", {
  resumable: true,
  // what the job writes on the library volume: nothing for a link or a move (the game's copy, an inbox entry, a file on
  // the store's volume), the file's size for a copy across volumes; a download a search brought for a way may be an
  // archive, unpacked in the scratch folder first, and made into the way's file (src/ways/find.ts says how much that takes)
  scratch: async (_job, spec) => {
    if (spec.kind !== "content") return 0;
    if (spec.fetchId != null) return (await import("./find")).downloadScratch(spec.path ?? "", spec.wayId ?? null);
    if (spec.fromCopy) return (await import("./copy")).copyScratch(spec.gameId);
    if (spec.inbox || !spec.path) return 0;
    const st = await stat(spec.path).catch(() => null);
    if (!st?.isFile()) return 0;
    const root = ctdeps.rootFolders().find(r => existsSync(r.path));
    return root && (await ctdeps.sameVolume(spec.path, root.path)) ? 0 : st.size;
  },
  async run(ctx) {
    const s = ctx.spec as Extract<JobSpec, { kind: "content" }>;
    // a download a search brought for one way: its game file found, checked and kept by the content pass
    if (s.fetchId != null) return (await import("./find")).takeDownload(ctx, s);
    if (s.fromCopy) return takeFromCopy(ctx, s);
    if (s.inbox) return takeInboxEntry(ctx, s);
    if (!s.path) throw new Error("this job names no file to take in");
    const t = jobTarget(s);
    const { real, size, folder } = await checkServerPath(s.path, { folders: t.role === "game" });
    // what the admin uploaded for one way is that way's, a folder as a file (a folder picked on the server is judged for every way, as it was)
    if (folder && t.role === "game") return s.upload != null ? takePathFolder(ctx, t, real, "upload", s.wayId ?? null) : takePathFolder(ctx, t, real);
    // an archive set the admin uploaded is one game file, named by its first volume: judged and kept whole
    if (s.upload != null && t.role === "game" && (await archiveSet(real))) return takePathFolder(ctx, t, real, "upload", s.wayId ?? null);
    ctx.log(`taking in ${s.upload != null ? `the upload ${basename(real)}` : s.path} (${gb(size)}) for ${t.role === "game" ? t.game.name : `${t.plan.name}: ${planSpec(t.plan).needs[t.needIndex].name}`}`);
    ctx.progress(0.01, "taking the file in");
    const say = reporter(ctx, 0.02, 0.99);
    const r = await ingestPath(s.path, t, {
      signal: ctx.signal, accept: t.role === "system" ? needAccept(t) : undefined,
      wayPlatform: t.role === "game" ? namedWayPlatform(s.wayId, t.game.id) : null,
      ...(s.upload != null ? { source: "upload" as const } : {}),
      progress: (b, total, step) => say(step === "hashing" ? "hashing the file where it lies" : "copying")(b, total ?? size),
    });
    const sha1 = r.row.hashes_json ? (JSON.parse(r.row.hashes_json) as { sha1?: string }).sha1 : null;
    ctx.log(r.duplicate ? `the same file is already kept as ${r.row.name}` : `kept as ${r.row.name}${r.row.normalized ? ` (${r.row.normalized})` : ""}${r.linked ? " by a hard link (nothing copied)" : ""} · sha1 ${sha1}`);
    const kept = r.duplicate ? `already kept as ${r.row.name}` : `kept ${r.row.name} (${gb(r.row.size)})`;
    if (t.role !== "game") { settleWaysOfPlan(t.plan.id); return { message: kept }; }
    const a = attachToWays(r.row, { wayId: s.wayId ?? null });
    for (const c of a.checks) ctx.log(`${c.plan}: ${c.ok ? (a.attached.includes(c.wayId) ? "this is its game file now" : "it fits") : c.why}`);
    // taken in for one way: the message says when the file is not that way's, so it never reads as a file the way now has
    const named = s.wayId != null ? a.checks.find(c => c.wayId === s.wayId) : undefined;
    return { message: named && !named.ok ? `${kept} — not the file ${named.plan} needs: ${named.why}` : kept };
  },
});
