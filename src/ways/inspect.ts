/**
 * ludarr — what a file or folder is, from small reads and listings only: a folder walked with lstat (links listed, never
 * followed), a file's format by its magic bytes, its identity by the readers (src/ways/identity.ts), an archive or a disc
 * image listed — a UDF image by ludarr's own reader, anything else by 7-Zip as the build user in the sandbox, never by
 * unpacking it. Used for intake, by the make (B3) and by the AI's inspect tool.
 *
 *   describeInput(path)                 shape, format, size, identity, sealed, the marker files found (≤ 4 folders deep),
 *                                       the members (≤ 400) and how they were listed, and why nothing was found
 *   extractMember(path, member, toDir)  one small member (≤ 16 MiB) out of a folder, a .zar, a UDF image or an archive
 *   completeness(dir, c)                is a game folder the whole game, not an update or a part (a count, a size, and the
 *                                       program's own list of the game's files)
 *
 * Formats recognised by their magic: ZIP, 7z, RAR, .nup, NSP (PFS0), XCI (HEAD at 0x100), PS4/PS5 packages, ISO 9660 (CD001
 * at sector 16, in 2048- or 2352-byte sectors), UDF (its anchor at sector 256, or NSR02/NSR03 at sector 17), a .zar (its
 * footer's magic in the last bytes), exFAT ("EXFAT   " at 3) and UFS2 (0x19540119 at 0x1055C) disk images — the last two
 * named only: ludarr cannot open them yet.
 *
 * ludarr runs as root and the build user is not trusted, so nothing here reads or writes through a link: a member is read
 * from a file lstat said is a plain one, opened so that a link swapped in is not followed (src/ways/readers/bytes.ts
 * openPlain), and written as a new file of ludarr's own (created exclusively, then renamed over its name), so a
 * link planted under that name, or a link given as the folder to write in, is never followed; a scratch folder is made by
 * mkdtemp (its name cannot be planted beforehand); and an input is handed to 7-Zip by a hard link only when that link could
 * not give a sandboxed program a way to change it.
 */
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, opendir, rename, rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pdeps } from "../process/deps";
import type { ExecResult } from "../process/tools";
import { identify, identifyFolder, type Identity } from "./identity";
import { sameVersion } from "./readers/titles";
import { be32, le32, MAX_READ, openPlain, raw, withBytes } from "./readers/bytes";
import { listUdf, readUdfMember } from "./readers/udf";
import { readZarMember } from "./readers/zar";
import { builderIds, handTo, SANDBOX_UIDS, sandboxAvailable, sandboxExec, type SandboxOpts } from "./sandbox";
import type { Completeness, InputDescription } from "./types";
import { noted } from "../transport";

/** swapped in tests: the 7-Zip program, how it runs (as the build user), how a folder is handed to the build user, and
 *  whether the sandbox's users are real here (on a dev box without them a link changes nothing for anyone) */
export const ideps = {
  sevenZip: (): string | null => pdeps.tools().sevenZip,
  exec: (cmd: string[], o: SandboxOpts): Promise<ExecResult> => sandboxExec(cmd, o),
  handTo: (dir: string, who: "builder" | "root"): Promise<void> => handTo(dir, who),
  sandboxed: (): boolean => sandboxAvailable(),
};

/** the most members a description lists */
export const MEMBERS_MAX = 400;
/** the most entries a folder walk looks at */
const WALK_MAX = 300_000;
/** markers are looked for this many folders deep */
const MARKER_DEPTH = 4;
/** the largest member taken out for a look */
export const MEMBER_MAX = 16 * 1024 * 1024;
/** the most entries a whole-game count walks (a PS5 game holds about 117,000 files) */
const COUNT_MAX = 2_000_000;

type Member = { path: string; size: number; dir: boolean };
const GB = 1024 ** 3, MB = 1024 ** 2;
/** a size in words, decimal as every size ludarr says */
const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n} bytes`);
const count = (n: number) => n.toLocaleString("en-US");
const aborted = (s?: AbortSignal) => { if (s?.aborted) throw new Error("cancelled"); };

/* ─────────── a folder ─────────── */

/** the files that say a folder holds a game, and how far up the game folder is from each */
const MARKERS: { tail: string; up: number }[] = [
  { tail: "sce_sys/param.json", up: 2 }, { tail: "sce_sys/param.sfo", up: 2 }, { tail: "ps3_game/param.sfo", up: 2 },
  { tail: "psp_game/param.sfo", up: 2 }, { tail: "exefs/main", up: 2 }, { tail: "eboot.bin", up: 1 },
];

interface Walk { members: Member[]; markers: string[]; games: string[]; bytes: number; files: number; entries: number; links: string[]; capped: boolean; listed: boolean; unread: number }

/** a folder's names (empty when it cannot be read), and whether reading it stopped partway */
async function namesOf(abs: string): Promise<{ names: string[]; whole: boolean }> {
  const d = await opendir(abs).catch(noted(abs));
  if (!d) return { names: [], whole: false };
  const names: string[] = [];
  try { for await (const ent of d) names.push(ent.name); }
  catch (e) { noted(abs)(e); return { names, whole: false }; }
  finally { await d.close().catch(() => { /* closed */ }); }
  return { names, whole: true };
}

/** a folder walked level by level with lstat: the first members, the marker files, the game folders they name, and sizes */
async function walkFolder(root: string, o: { signal?: AbortSignal; members?: number; progress?: (files: number, bytes: number) => void } = {}): Promise<Walk> {
  const w: Walk = { members: [], markers: [], games: [], bytes: 0, files: 0, entries: 0, links: [], capped: false, listed: true, unread: 0 };
  const want = o.members ?? MEMBERS_MAX;
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];
  let last = Date.now();
  while (queue.length) {
    aborted(o.signal);
    const { abs, rel, depth } = queue.shift()!;
    const { names, whole } = await namesOf(abs);
    if (!whole) w.unread++;
    names.sort();
    for (const name of names) {
      if (++w.entries > WALK_MAX) { w.capped = true; return w; }
      const p = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(abs, name)).catch(noted(join(abs, name)));
      if (!st) continue;
      const dir = st.isDirectory() && !st.isSymbolicLink();
      if (st.isSymbolicLink()) w.links.push(p);
      else if (st.isFile()) { w.files++; w.bytes += st.size; }
      if (w.members.length < want) w.members.push({ path: p, size: st.isFile() ? st.size : 0, dir });
      else w.listed = false;
      if (st.isFile() && depth < MARKER_DEPTH + 1) {
        const lower = p.toLowerCase();
        for (const m of MARKERS) {
          if (lower !== m.tail && !lower.endsWith(`/${m.tail}`)) continue;
          if (w.markers.length < 50) w.markers.push(p);
          if (m.tail !== "eboot.bin") {
            const parts = p.split("/");
            const game = parts.slice(0, parts.length - m.up).join("/");
            if (!w.games.includes(game)) w.games.push(game);
          }
          break;
        }
      }
      if (dir) queue.push({ abs: join(abs, name), rel: p, depth: depth + 1 });
      if (o.progress && Date.now() - last > 1000) { o.progress(w.files, w.bytes); last = Date.now(); }
    }
  }
  return w;
}

/* ─────────── a file's format ─────────── */

const ZAR_MAGIC = 0x169f52d6, UFS2_MAGIC = 0x19540119;

/** a file's format by its magic bytes (a few small reads), else by its name */
export async function fileFormat(path: string, name = path): Promise<string> {
  let format = "";
  await withBytes(path, async b => {
    const h = await b.at(0, 16);
    const s = raw(h);
    if (s.startsWith("PK\x03\x04") || s.startsWith("PK\x05\x06") || s.startsWith("PK\x07\x08")) format = "zip";
    else if (s.startsWith("7z\xbc\xaf\x27\x1c")) format = "7z";
    else if (s.startsWith("Rar!\x1a\x07")) format = "rar";
    else if (s.startsWith("NUP\x01")) format = "nup";
    else if (s.startsWith("PFS0")) format = "nsp";
    else if (s.startsWith("\x7fCNT") || s.startsWith("\x7fFIH")) format = "pkg";
    else if (s.slice(3, 11) === "EXFAT   ") format = "exfat";
    else if (raw(await b.at(0x100, 4)) === "HEAD") format = "xci";
    else {
      const ufs = await b.at(0x1055c, 4);
      if (ufs.length === 4 && (le32(ufs, 0) === UFS2_MAGIC || be32(ufs, 0) === UFS2_MAGIC)) format = "ufs";
      else if (b.size > 144 && be32(await b.at(b.size - 4, 4), 0) === ZAR_MAGIC) format = "zar";
      else if (raw((await b.at(16 * 2048 + 1, 5))) === "CD001" || raw(await b.at(16 * 2352 + 25, 5)) === "CD001" || raw(await b.at(16 * 2352 + 17, 5)) === "CD001") format = h[0] === 0 && h[1] === 0xff ? "bin" : "iso";
      else {
        const vsd = raw(await b.at(17 * 2048 + 1, 5));
        const anchor = await b.at(256 * 2048, 2);
        if (vsd === "NSR02" || vsd === "NSR03" || (anchor.length === 2 && anchor[0] === 2 && anchor[1] === 0)) format = "iso";
      }
    }
    return { identity: null, why: null };
  }, 16);
  if (format) return format;
  return (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase() || "unknown";
}

/** what a form ludarr recognises but cannot open is, for the admin */
const CANNOT_OPEN: Record<string, string> = { exfat: "an exFAT disk image", ufs: "a UFS2 disk image (a PS5 dump's .ffpkg)", pkg: "a PlayStation package" };

/* ─────────── listings by 7-Zip, as the build user ─────────── */

/** `7z l -slt -ba`'s blocks as members (the archive's own block, which carries its Type, left out) */
export function parseSlt(out: string, max = MEMBERS_MAX): Member[] {
  const members: Member[] = [];
  let cur: Record<string, string> = {};
  const flush = () => {
    if (cur.Path !== undefined && cur.Type === undefined && members.length < max) {
      members.push({ path: cur.Path.replace(/\\/g, "/"), size: Number(cur.Size) || 0, dir: cur.Folder === "+" || /^D/.test(cur.Attributes ?? "") });
    }
    cur = {};
  };
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim() || /^-{5,}$/.test(line.trim())) { flush(); continue; }
    const m = /^([A-Za-z ]+?) = (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "Path" && cur.Path !== undefined) flush();
    cur[m[1]] = m[2];
  }
  flush();
  return members;
}

/**
 * A scratch folder for a sandboxed look, made by mkdtemp (its name cannot be guessed, so nothing can be planted there
 * beforehand) and left for the build user to enter but not to write: inside the job's own scratch folder when it gives
 * one (the runner removes that whatever happens), else under the system's temp folder — and there too when the job's
 * inspect folder is a link someone planted.
 */
async function scratch(work?: string): Promise<{ dir: string; inWork: boolean; done: () => Promise<void> }> {
  let base: string | null = null;
  if (work) {
    const b = join(work, "inspect");
    await mkdir(b, { recursive: true }).catch(() => { /* judged below */ });
    const st = await lstat(b).catch(() => null);
    if (st?.isDirectory() && !st.isSymbolicLink()) base = b;
  }
  const dir = await mkdtemp(join(base ?? tmpdir(), base ? "look-" : "ludarr-inspect-"));
  await chmod(dir, 0o755).catch(() => { /* a file system without modes */ });
  return { dir, inWork: base != null, done: () => rm(dir, { recursive: true, force: true }).catch(() => { /* gone */ }) };
}

/**
 * Whether a file may be handed to the build user by a hard link: always on a box without the sandbox's users (nothing
 * changes hands there), and with them only a file no build user owns and none may write (no write for others, nor for a
 * build user's group) — a link puts the very file within a sandboxed program's reach, so a writable one could be changed
 * by it before ludarr takes it in.
 */
export function linkable(st: { mode: number; uid: number; gid: number }, sandbox: boolean, users: { uids: number[]; gids: number[] }): boolean {
  if (!sandbox) return true;
  if (users.uids.includes(st.uid)) return false;
  if (st.mode & 0o002) return false;
  if (st.mode & 0o020 && users.gids.includes(st.gid)) return false;
  return true;
}
const buildUsers = () => ({ uids: SANDBOX_UIDS, gids: [...new Set([...SANDBOX_UIDS, ...(builderIds() ? [builderIds()!.gid] : [])])] });

/** the input as the build user reaches it: a hard link inside the job's scratch folder (the runner removes that folder
 *  whatever happens) when the file may be linked (linkable), or its own path where no link can or may be made, or there is
 *  no job folder to put one in */
async function handedIn(path: string, dir: string, inWork: boolean): Promise<{ path: string; drop: () => Promise<void> }> {
  const own = { path, drop: async () => { /* nothing made */ } };
  if (!inWork) return own;
  const st = await lstat(path).catch(noted(path));
  const sandboxed = ideps.sandboxed();
  if (!st || !st.isFile() || !linkable(st, sandboxed, sandboxed ? buildUsers() : { uids: [], gids: [] })) return own;
  const at = join(dir, "in-" + basename(path).replace(/[^A-Za-z0-9._-]/g, "_"));
  try { await link(path, at); return { path: at, drop: () => unlink(at).catch(() => { /* gone */ }) }; }
  catch { return own; }
}

async function list7z(path: string, o: { work?: string; signal?: AbortSignal }): Promise<{ members: Member[] | null; why: string | null }> {
  const sz = ideps.sevenZip();
  if (!sz) return { members: null, why: "7-Zip is not here to list it" };
  const s = await scratch(o.work);
  const input = await handedIn(path, s.dir, s.inWork);
  try {
    const r = await ideps.exec([sz, "l", "-slt", "-ba", "--", input.path], { work: s.dir, timeoutMs: 120_000, signal: o.signal, maxOutput: 4_000_000 });
    if (r.code !== 0) return { members: null, why: `7-Zip could not list it (exit ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split(/\r?\n/).pop()}` : ""})` };
    return { members: parseSlt(r.stdout), why: null };
  } finally { await input.drop(); await s.done(); }
}

/* ─────────── describing an input ─────────── */

/** What `path` is (see the file header). A link is described as a link and never followed. Never throws for what the
 *  input holds; a cancel ends it with "cancelled". */
export async function describeInput(path: string, o: { work?: string; signal?: AbortSignal; platform?: string | null; progress?: (files: number, bytes: number) => void } = {}): Promise<InputDescription> {
  const st = await lstat(path).catch(noted(path));
  const none = (shape: "file" | "folder", format: string, why: string, sz = 0): InputDescription => ({ shape, format, size: sz, identity: null, sealed: false, markers: [], members: null, listing: "none", why });
  if (!st) return none("file", "missing", "it is not there");
  if (st.isSymbolicLink()) return none("file", "link", "it is a link, and ludarr never follows one");
  if (st.isDirectory()) {
    const w = await walkFolder(path, { signal: o.signal, progress: o.progress });
    let read = await identifyFolder(path, o.platform);
    let why = read.why;
    if (!read.identity && w.games.length === 1 && w.games[0]) {
      const inner = await identifyFolder(join(path, ...w.games[0].split("/")), o.platform);
      if (inner.identity) { read = inner; why = `the game folder inside is ${w.games[0]}`; }
      else why = `the game folder inside (${w.games[0]}) says nothing that can be relied on: ${inner.why}`;
    } else if (!read.identity && w.games.length > 1) why = `it holds ${w.games.length} game folders (${w.games.slice(0, 4).map(g => g || "its top").join(", ")}${w.games.length > 4 ? " …" : ""})`;
    const notes = [why, w.links.length ? `it holds ${w.links.length === 1 ? "a link" : `${w.links.length} links`} (${w.links.slice(0, 3).join(", ")}), which ludarr never follows` : null,
      w.capped ? `it holds more than ${count(WALK_MAX)} entries: its size counts the first ${count(WALK_MAX)}` : null,
      w.unread ? `${w.unread === 1 ? "a folder" : `${w.unread} folders`} in it could not be read: its size counts what could` : null].filter(Boolean);
    return {
      shape: "folder", format: "folder", size: w.bytes, identity: read.identity, sealed: false, markers: w.markers,
      members: w.members, listing: "fs", why: notes.length ? notes.join("; ") : null,
    };
  }
  if (!st.isFile()) return none("file", "other", "it is neither a file nor a folder");
  const name = basename(path);
  const format = await fileFormat(path, name);
  if (CANNOT_OPEN[format] && format !== "pkg") return none("file", format, `${CANNOT_OPEN[format]}: a form ludarr cannot open yet`, st.size);
  // the readers pick by extension: a file is read as the form its magic says, whatever it is called
  const asName = ["zar", "nup", "nsp", "xci", "iso", "zip", "7z", "rar"].includes(format) ? `input.${format}` : name;
  const read = format === "pkg" ? { identity: null, why: `${CANNOT_OPEN.pkg}: a form ludarr cannot open yet` } : await identify(path, o.platform, asName);
  const identity = read.identity;
  let members: Member[] | null = null, listing: InputDescription["listing"] = "none", why = read.why;
  if (format === "iso") {
    const u = await listUdf(path, MEMBERS_MAX);
    if (u.members.length) { members = u.members; listing = "udf"; }
    else {
      const z = await list7z(path, o);
      if (z.members) { members = z.members; listing = "7z"; }
    }
  } else if (format === "zip" || format === "7z" || format === "rar") {
    const z = await list7z(path, o);
    if (z.members) { members = z.members; listing = "7z"; why = null; } else why = z.why;
  }
  return {
    shape: "file", format, size: st.size, identity, sealed: !!identity?.sealed, markers: read.markers ?? [],
    members, listing, why: identity ? null : why,
  };
}

/* ─────────── one member out ─────────── */

/** a member path made safe: slashes, no climbing out, no absolute path */
function memberPath(member: string): string {
  const parts = member.replace(/\\/g, "/").split("/").filter(p => p && p !== ".");
  if (!parts.length || parts.some(p => p === ".." || p.includes("\0")) || /^[A-Za-z]:/.test(member)) throw new Error(`${member} is not a path inside the input`);
  return parts.join("/");
}
const outName = (member: string) => basename(member).replace(/[^A-Za-z0-9._ -]/g, "_") || "member";
const tooBig = (rel: string, n: number) => new Error(`${rel} is ${size(n)}: only files up to 16 MB are taken out for a look`);

/**
 * A plain file's bytes (at most `max`), opened without following a link (openPlain: a link swapped in after the look is
 * not followed); `single`: refused when another name links to the same file (a file a build program could have linked in
 * from elsewhere). Throws with the reason.
 */
async function plainBytes(path: string, rel: string, max: number, o: { single?: boolean } = {}): Promise<Uint8Array> {
  const opened = await openPlain(path).catch(e => `it could not be opened (${(e as Error)?.message ?? e})`);
  if (typeof opened === "string") throw new Error(`${rel}: ${opened}`);
  const { fh, st } = opened;
  try {
    if (o.single && st.nlink > 1) throw new Error(`${rel} is linked from elsewhere, so it is not taken out`);
    if (st.size > max) throw tooBig(rel, st.size);
    const b = new Uint8Array(st.size);
    let got = 0;
    while (got < b.length) {
      const { bytesRead } = await fh.read(b, got, Math.min(MAX_READ * 16, b.length - got), got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return b.subarray(0, got);
  } finally { await fh.close().catch(() => { /* closed */ }); }
}

/**
 * `bytes` written as `name` in the folder `dir` without following a link: `dir` must be a folder (not a link to one), and
 * the bytes go into a new file of ludarr's own — created exclusively, so a link or file planted under any name there is
 * never written through — renamed over `name` at the end (a link planted as `name` is replaced, never followed). Its path.
 */
async function writeOut(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true }).catch(() => { /* judged below */ });
  const st = await lstat(dir).catch(noted(dir));
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error("the folder to take it out into is a link or not a folder, so nothing is written there");
  const out = join(dir, name);
  const tmp = join(dir, `.${name}.${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.part`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try { await fh.writeFile(bytes); }
  catch (e) { await fh.close().catch(() => { /* closed */ }); await unlink(tmp).catch(() => { /* gone */ }); throw e; }
  await fh.close();
  try { await rename(tmp, out); }
  catch (e) { await unlink(tmp).catch(() => { /* gone */ }); throw new Error(`${name} could not be put in place: ${(e as Error)?.message ?? e}`); }
  return out;
}

/**
 * One small member of a folder, a .zar, a UDF image or an archive, written into `toDir` (its name kept): its path. At
 * most 16 MiB; a folder's member is reached without following a link; an archive's is taken out by 7-Zip as the build
 * user into a folder of its own, then read from there as a plain file of its own. Nothing is ever written through a link
 * (writeOut). Throws with the reason.
 */
export async function extractMember(path: string, member: string, toDir: string, o: { signal?: AbortSignal; work?: string } = {}): Promise<string> {
  const rel = memberPath(member);
  const name = outName(rel);
  const st = await lstat(path).catch(noted(path));
  if (!st) throw new Error("the input is not there");
  if (st.isSymbolicLink()) throw new Error("the input is a link, and ludarr never follows one");
  if (st.isDirectory()) {
    let at = path;
    for (const p of rel.split("/")) {
      at = join(at, p);
      const s = await lstat(at).catch(noted(at));
      if (!s) throw new Error(`it holds no ${rel}`);
      if (s.isSymbolicLink()) throw new Error(`${rel} goes through a link, and ludarr never follows one`);
    }
    const f = await lstat(at);
    if (!f.isFile()) throw new Error(`${rel} is not a file`);
    if (f.size > MEMBER_MAX) throw tooBig(rel, f.size);
    return writeOut(toDir, name, await plainBytes(at, rel, MEMBER_MAX));
  }
  const format = await fileFormat(path, basename(path));
  if (format === "zar") return writeOut(toDir, name, await readZarMember(path, rel, MEMBER_MAX));
  if (format === "iso") {
    const u = await readUdfMember(path, rel, MEMBER_MAX).catch(e => e as Error);
    if (!(u instanceof Error)) return writeOut(toDir, name, u);
    if (/more than the/.test(u.message)) throw new Error(`${rel}: only files up to 16 MB are taken out for a look`);
  }
  // anything else 7-Zip opens: listed first (its size), then taken out as the build user
  const sz = ideps.sevenZip();
  if (!sz) throw new Error("7-Zip is not here to take it out");
  const listed = await list7z(path, o);
  const hit = listed.members?.find(m => m.path.toLowerCase() === rel.toLowerCase());
  if (!hit) throw new Error(listed.why ?? `it holds no ${rel}`);
  if (hit.dir) throw new Error(`${rel} is a folder`);
  // 7-Zip reads a name that starts with @ as a list of names to take
  if (hit.path.startsWith("@")) throw new Error(`${rel}: a name 7-Zip would read as a list of names, so it is not taken out`);
  if (hit.size > MEMBER_MAX) throw tooBig(rel, hit.size);
  const s = await scratch(o.work);
  const input = await handedIn(path, s.dir, s.inWork);
  const into = join(s.dir, "out");
  await mkdir(into, { recursive: true });
  try {
    await ideps.handTo(into, "builder");
    const r = await ideps.exec([sz, "e", "-y", "-bd", "-bb0", "-spd", `-o${into}`, "--", input.path, hit.path], { work: s.dir, timeoutMs: 300_000, signal: o.signal, maxOutput: 20_000 });
    await ideps.handTo(into, "root");
    if (r.code !== 0) throw new Error(`7-Zip could not take ${rel} out (exit ${r.code})`);
    // what the build user wrote is read as a plain file of its own (no link, no second name), never moved as it is
    const bytes = await plainBytes(join(into, basename(hit.path)), rel, MEMBER_MAX, { single: true })
      .catch(e => { throw new Error(/is not there|not a file|a link/.test(String((e as Error)?.message)) ? `7-Zip did not leave ${rel} as a plain file` : (e as Error).message); });
    return await writeOut(toDir, name, bytes);
  } finally { await input.drop(); await s.done(); }
}

/* ─────────── the whole game ─────────── */

/** a line of a program's file list as a path compared with the folder's (the game's own "/app0/" and slashes dropped) */
const listedPath = (line: string) => line.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/^app0\//i, "").toLowerCase();

/** how a refusal for not being the whole game begins (callers say it once: "<name> is " + PART) */
export const PART = "an update or a part of the game, not the whole game";

/** the title and version a program's file list is for, by its file name, or null for each it does not name (Kyty's
 *  static-precompile lists are named files-<TITLE>_<NN.NNN.NNN>.files: files-PPSA01341_01.007.000.files) */
export function listFor(path: string): { title: string | null; version: string | null } {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const title = /(?:^|[^A-Za-z0-9])([A-Za-z]{4}\d{5}|[0-9A-Fa-f]{16})(?=$|[^A-Za-z0-9])/.exec(name)?.[1]?.toUpperCase() ?? null;
  const version = /(?:^|[^0-9.])(\d{2}\.\d{3}\.\d{3}|\d{2}\.\d{2})(?=$|[^0-9]|\.[A-Za-z])/.exec(name)?.[1] ?? null;
  return { title, version };
}

/**
 * Whether a program's file list (Completeness.list) judges a dump whose own identity is `id`. A list names the files of
 * one title at one version (Kyty's own header: "A file it lists that an edition does not have is not opened"), so it
 * judges that title at that version only; a dump of another title or version is judged by minFiles and minBytes alone,
 * and `note` says so in plain words. A dump whose title or version is not known (or a list whose name says neither) is
 * judged by the list, as before.
 */
export function listJudges(c: Completeness, id: Pick<Identity, "serial" | "version"> | null | undefined): { judges: true } | { judges: false; note: string } {
  if (!c.list) return { judges: true };
  const named = listFor(c.list.path);
  const serial = id?.serial ? String(id.serial).toUpperCase().replace(/[-_]/g, "") : null;
  const otherTitle = !!named.title && !!serial && named.title !== serial;
  const otherVersion = !!named.version && !!id?.version && !sameVersion(named.version, String(id.version));
  if (!otherTitle && !otherVersion) return { judges: true };
  const listName = c.list.path.replace(/\\/g, "/").split("/").pop();
  const isFor = [named.title, named.version].filter(Boolean).join(" ");
  const dump = [serial, id?.version].filter(Boolean).join(" ");
  const how = c.minFiles != null || c.minBytes != null ? "by its size" : `by how many of the list's files it holds (at least ${Math.round(OTHER_SHARE * 100)} %: an update holds only a few)`;
  return { judges: false, note: `the program's file list (${listName}) is for ${isFor}; this dump is ${dump}, so it is judged ${how}` };
}

/** what a dump of another title or version than its file list's must still hold of that list when the plan gives no size
 *  for the whole game: an edition or a version keeps most of a game's file names, an update only the few it changes */
export const OTHER_SHARE = 0.25;
/** the whole-game check for a dump the program's list does not judge (listJudges said no): by the plan's minFiles and
 *  minBytes when it gives them, else by a quarter of the list's files (OTHER_SHARE) */
export function listFallback(c: Completeness): Completeness {
  if (!c.list || c.minFiles != null || c.minBytes != null) return { ...c, list: undefined };
  return { ...c, list: { ...c.list, share: Math.min(c.list.share ?? 0.98, OTHER_SHARE) } };
}

/**
 * Whether a game folder is the whole game, not an update or a part (H4): at least minFiles files and minBytes bytes (links
 * are never followed nor counted), and — when the content plan names the program's own list of the game's files — that
 * list's paths there, at least `share` of them (default 0.98). `list` is that list's lines, read from the pinned program by
 * the caller; a plan that names a list the caller could not give is not taken as complete, and neither is a folder part of
 * which could not be read. `progress` hears the count every second.
 */
export async function completeness(dir: string, c0: Completeness, o: { list?: string[] | null; identity?: Pick<Identity, "serial" | "version"> | null; signal?: AbortSignal; progress?: (files: number, bytes: number) => void } = {}): Promise<Whole> {
  // a list judges only the title and version it is for: the folder's own identity says which it is (read here when the
  // caller did not say)
  if (!c0.list) return countWhole(dir, c0, o);
  const id = o.identity !== undefined ? o.identity : (await identifyFolder(dir).catch(() => null))?.identity ?? null;
  const j = listJudges(c0, id);
  if (j.judges) return countWhole(dir, c0, o);
  return { ...(await countWhole(dir, listFallback(c0), o)), note: j.note };
}
/** what completeness found: the folder's files and bytes, the list's paths there, and why it is not the whole game; note:
 *  why the program's list did not judge it (another title or version) */
export interface Whole { ok: boolean; why: string | null; files: number; bytes: number; listed?: number; present?: number; note?: string }
async function countWhole(dir: string, c: Completeness, o: { list?: string[] | null; signal?: AbortSignal; progress?: (files: number, bytes: number) => void }): Promise<Whole> {
  const st = await lstat(dir).catch(noted(dir));
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return { ok: false, why: "it is not a folder, so it cannot be the whole game", files: 0, bytes: 0 };
  const paths = c.list ? new Set<string>() : null;
  let files = 0, bytes = 0, last = Date.now(), entries = 0, unread = 0;
  const queue: { abs: string; rel: string }[] = [{ abs: dir, rel: "" }];
  while (queue.length && entries <= COUNT_MAX) {
    aborted(o.signal);
    const { abs, rel } = queue.shift()!;
    const { names, whole } = await namesOf(abs);
    if (!whole) unread++;
    for (const n of names) {
      if (++entries > COUNT_MAX) break;
      const p = rel ? `${rel}/${n}` : n;
      const s = await lstat(join(abs, n)).catch(noted(join(abs, n)));
      if (!s || s.isSymbolicLink()) continue;
      if (s.isDirectory()) queue.push({ abs: join(abs, n), rel: p });
      else if (s.isFile()) { files++; bytes += s.size; paths?.add(p.toLowerCase()); }
      if (o.progress && Date.now() - last > 1000) { o.progress(files, bytes); last = Date.now(); }
    }
  }
  o.progress?.(files, bytes);
  if (entries > COUNT_MAX) return { ok: false, why: `it holds more than ${count(COUNT_MAX)} entries, more than any game: it is not one game folder`, files, bytes };
  if (unread) return { ok: false, why: `${unread === 1 ? "a folder" : `${count(unread)} folders`} in it could not be read, so it cannot be told whether this is the whole game`, files, bytes };
  const holds = `it holds ${count(files)} files (${size(bytes)})`;
  const part = "an update or a part of the game, not the whole game";
  if (c.minFiles != null && files < c.minFiles) return { ok: false, why: `${part}: ${holds}, and the whole game holds at least ${count(c.minFiles)} files`, files, bytes };
  if (c.minBytes != null && bytes < c.minBytes) return { ok: false, why: `${part}: ${holds}, and the whole game is at least ${size(c.minBytes)}`, files, bytes };
  if (c.list) {
    if (!o.list) return { ok: false, why: `the program's list of the game's files (${c.list.path}) could not be read, so it cannot be told whether this is the whole game`, files, bytes };
    const want = [...new Set(o.list.map(listedPath).filter(l => l && !l.startsWith("#")))];
    const present = want.filter(l => paths!.has(l)).length;
    const share = c.list.share ?? 0.98;
    if (!want.length) return { ok: false, why: `the program's list of the game's files (${c.list.path}) is empty`, files, bytes, listed: 0, present: 0 };
    if (present / want.length < share) {
      return { ok: false, why: `${part}: ${Math.floor((present / want.length) * 100)}% of the ${count(want.length)} files the program lists for it are there (the whole game has ${Math.round(share * 100)}%)`, files, bytes, listed: want.length, present };
    }
    return { ok: true, why: null, files, bytes, listed: want.length, present };
  }
  return { ok: true, why: null, files, bytes };
}
