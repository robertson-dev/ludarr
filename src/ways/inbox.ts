/**
 * ludarr — a game's inbox: <root folder>/.ahoy-inbox/<the game's folder>/, where the admin drops the game's data (a
 * file, a folder, an archive set) for a carry run that asked for it, over the share or on the server.
 *
 *   made        when a run asks for a file: root:users (gid 100) mode 0770, never world-writable, so no build program can
 *               drop a forged dump into it; a folder owned by anyone but root, nobody (99) or the users group is refused
 *   stable      an entry is taken once nothing anywhere in it has changed for 10 minutes (its size, how many files it holds,
 *               the newest change), or at once when <entry>.done is beside it: a copy that pauses is never taken half done
 *   sets        one archive set (name.part01.rar …, name.rar + .r00 …, name.001 …, name.7z.001 …, name.zip + .z01 …) is one
 *               entry, stable only when every volume is, named by its first volume
 *   refused     an entry written by a build program (owned by a sandbox user), with <entry>.not-taken.txt beside it saying so
 *   queued      a 'content' job {gameId, path, inbox: true, runId} per stable entry: the content job judges it for each of the
 *               game's ways and moves it into the store (src/ways/content.ts intakeEntry), or leaves it with a note
 *               (<entry>.not-taken.txt); an entry whose note is newer than anything in it is not tried again until it
 *               changes or is dropped again
 *
 * Dot folders and the sidecar files (*.not-taken.txt, *.done) are never entries; links are never followed or taken.
 */
import { chmod, chown, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { db, type GameRow, type JobRow } from "../db";
import { logger } from "../log";
import { rootFolderFor } from "../library/rootfolders";
import { enqueueJob } from "../process/kinds";
import { folderName } from "./content";
import { SANDBOX_UIDS } from "./sandbox";

const log = logger("inbox");

/** the folder name every game's inbox lives under, in its root folder */
export const INBOX = ".ahoy-inbox";
/** how long nothing in an entry must change before it is taken */
export const STABLE_MS = 10 * 60_000;
/** the share's own owners on Unraid: root, nobody (99), the users group (100) */
const SHARE_UIDS = new Set([0, 99]), SHARE_GID = 100;
/** the most entries an inbox folder's walk looks at (a PS5 game folder holds ~117,000 files) */
const WALK_CAP = 500_000;
/** how many lstats a walk keeps in flight: the share (Unraid's shfs) answers each one slowly, a few at once fast enough */
const WALK_PARALLEL = 16;

/** swapped in tests */
export const ibdeps = {
  now: () => Date.now(),
  lstat: (p: string) => lstat(p),
  stat: (p: string) => stat(p),
  readdir: (p: string) => readdir(p, { withFileTypes: true }),
  mkdir: (p: string) => mkdir(p, { recursive: true }),
  chown: (p: string, uid: number, gid: number) => chown(p, uid, gid),
  chmod: (p: string, mode: number) => chmod(p, mode),
  writeNote: (p: string, text: string) => Bun.write(p, text),
  /** does the server keep owners (Linux): on a Windows dev box chown means nothing */
  posix: () => process.platform !== "win32",
  /** the queued or running content job taking in this path, if any */
  intakeFor: (path: string): JobRow | null => (db.query("SELECT * FROM jobs WHERE kind='content' AND input_path=? AND state IN ('queued','running') ORDER BY id DESC LIMIT 1").get(path) as JobRow | null) ?? null,
  enqueue: (gameId: number, path: string, runId: number | null) => enqueueJob({ kind: "content", gameId, path, inbox: true, runId }, { gameId, runId }),
  sandboxUids: (): number[] => SANDBOX_UIDS,
};

/** the game's inbox folder, or null when there is no root folder */
export function inboxDir(game: GameRow): string | null {
  const root = rootFolderFor(game);
  return root ? join(root.path, INBOX, folderName({ role: "game", game })) : null;
}

/** a folder made (or found) root:users 0770: never world-writable, never a link; why not, when it cannot be one */
async function ensureFolder(dir: string): Promise<string | null> {
  const before = await ibdeps.lstat(dir).catch(() => null);
  if (before?.isSymbolicLink()) return `${dir} is a link: ludarr takes nothing from it`;
  if (before && !before.isDirectory()) return `${dir} is not a folder`;
  if (!before) await ibdeps.mkdir(dir);
  if (!ibdeps.posix()) return null;
  const st = await ibdeps.lstat(dir);
  if (ibdeps.sandboxUids().includes(st.uid)) return `${dir} was made by a build program, not by you: ludarr takes nothing from it`;
  if (!SHARE_UIDS.has(st.uid) && st.gid !== SHARE_GID) return `${dir} belongs to user ${st.uid}: ludarr takes files only from a folder of root or of the users group`;
  try { if (!before || st.uid === (process.getuid?.() ?? -1)) await ibdeps.chown(dir, 0, SHARE_GID); }
  catch (e: any) { log.warn(`${dir}: could not give it to root:users: ${e?.message ?? e}`); }
  try { if ((st.mode & 0o777) !== 0o770) await ibdeps.chmod(dir, 0o770); }
  catch (e: any) { log.warn(`${dir}: could not make it 0770: ${e?.message ?? e}`); }
  const after = await ibdeps.lstat(dir);
  if (after.mode & 0o002) return `${dir} is open to every user of the server: ludarr takes nothing from it until it is not`;
  return null;
}

/** the game's inbox, made when it is not there yet (a run that asks for a file shows it); its path, or null without a
 *  root folder; `why` when it cannot be used */
export async function ensureInbox(game: GameRow): Promise<{ dir: string | null; why: string | null }> {
  const dir = inboxDir(game);
  if (!dir) return { dir: null, why: "no root folder: add one under Settings → Media management" };
  try {
    const parent = join(dir, "..");
    const p = await ensureFolder(parent);
    if (p) return { dir, why: p };
    return { dir, why: await ensureFolder(dir) };
  } catch (e: any) { return { dir, why: `could not make ${dir}: ${e?.message ?? e}` }; }
}

/* ─────────── what is in it ─────────── */

const SIDECAR = /\.(not-taken\.txt|done)$/i;
/** the volumes of an archive set, as [set name, volume number] (the first volume is 1) */
function volumeOf(name: string): [string, number] | null {
  let m = /^(.*)\.part0*(\d+)\.rar$/i.exec(name);
  if (m) return [`${m[1]}.rar`, Number(m[2])];
  m = /^(.*)\.r(\d{2,3})$/i.exec(name);
  if (m) return [`${m[1]}.rar`, Number(m[2]) + 2];
  if (/\.rar$/i.test(name)) return [name, 1];
  m = /^(.*)\.(7z|zip|rar|tar)\.(\d{3})$/i.exec(name);
  if (m) return [`${m[1]}.${m[2]}`, Number(m[3])];
  m = /^(.*)\.z(\d{2})$/i.exec(name);
  if (m) return [`${m[1]}.zip`, Number(m[2]) + 1];
  if (/\.zip$/i.test(name)) return [name, 1 << 20];                      // a split zip's last volume is the .zip itself
  m = /^(.*)\.(\d{3})$/.exec(name);
  if (m) return [m[1], Number(m[2])];
  return null;
}

export interface InboxEntry {
  /** the path a content job is given: the entry itself, or a set's first volume */
  path: string;
  name: string;
  /** every path that belongs to it (a set's volumes) */
  parts: string[];
  dir: boolean;
}

/** the entries of an inbox folder: files and folders (no dot entries, no sidecars, no links), archive sets as one */
export async function inboxEntries(dir: string): Promise<{ entries: InboxEntry[]; skipped: string[] }> {
  const all = await ibdeps.readdir(dir).catch(() => []);
  const entries: InboxEntry[] = [], skipped: string[] = [];
  const sets = new Map<string, { n: number; name: string }[]>();
  for (const d of all) {
    const name = String(d.name);
    if (name.startsWith(".") || SIDECAR.test(name)) continue;
    if (d.isSymbolicLink()) { skipped.push(`${name} is a link: ludarr never follows one`); continue; }
    if (d.isDirectory()) { entries.push({ path: join(dir, name), name, parts: [join(dir, name)], dir: true }); continue; }
    if (!d.isFile()) continue;
    const v = volumeOf(name);
    if (v) { const s = sets.get(v[0]) ?? []; s.push({ n: v[1], name }); sets.set(v[0], s); continue; }
    entries.push({ path: join(dir, name), name, parts: [join(dir, name)], dir: false });
  }
  for (const [setName, vols] of sets) {
    vols.sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
    // a split zip is opened by its .zip (its last volume), every other set by its first volume; one volume alone that is no
    // numbered part (a plain .zip, a plain .rar) is a file like any other
    const opener = /\.zip$/i.test(setName) ? vols.find(v => /\.zip$/i.test(v.name)) ?? vols[0] : vols[0];
    entries.push({ path: join(dir, opener.name), name: vols.length > 1 ? setName : opener.name, parts: vols.map(v => join(dir, v.name)), dir: false });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, skipped };
}

/** what an entry looks like now: how many files, how many bytes, the newest change anywhere in it; null when it is gone,
 *  'cap' when it holds more than the walk looks at */
async function signature(e: InboxEntry): Promise<{ sig: string; newest: number; links: number } | null | "cap"> {
  let files = 0, bytes = 0, newest = 0, links = 0, gone = false, capped = false;
  // every path still to look at, read from `head` on (never shifted: a game folder queues ~117,000 of them)
  const queue: { p: string; top: boolean }[] = e.parts.map(p => ({ p, top: true }));
  let head = 0, active = 0;
  const one = async (p: string, top: boolean): Promise<void> => {
    const st = await ibdeps.lstat(p).catch(() => null);
    if (!st) { if (top) gone = true; return; }
    newest = Math.max(newest, st.mtimeMs, st.ctimeMs);
    if (st.isSymbolicLink()) { links++; return; }
    if (st.isDirectory()) {
      for (const d of await ibdeps.readdir(p).catch(() => [])) {
        if (queue.length >= WALK_CAP) { capped = true; return; }
        queue.push({ p: join(p, String(d.name)), top: false });
      }
      return;
    }
    files++; bytes += st.size;
  };
  // a few at a time; the counts are sums and the newest a maximum, so the order they come back in changes nothing
  await new Promise<void>(done => {
    const pump = () => {
      while (!capped && head < queue.length && active < WALK_PARALLEL) {
        const n = queue[head++];
        active++;
        void one(n.p, n.top).catch(() => {}).finally(() => { active--; pump(); });
      }
      if (active === 0 && (capped || head >= queue.length)) done();
    };
    pump();
  });
  if (capped) return "cap";
  if (gone) return null;
  return { sig: `${files}:${bytes}:${Math.floor(newest)}:${links}`, newest, links };
}

/** when each entry was first seen looking as it does now (in memory: a restart only starts the ten minutes again) */
const seenAs = new Map<string, { sig: string; since: number }>();
export const inboxMemory = { reset: () => seenAs.clear() };

/**
 * Look at what has landed in the game's inbox and queue a content job for each entry that is ready: stable for ten
 * minutes (or marked done), not written by a build program, not already being taken in, and not refused before unless
 * it changed since. Returns how many were queued, the jobs, and a note for each entry not queued and why.
 */
export async function intakeInbox(game: GameRow, o: { runId?: number | null } = {}): Promise<{ queued: number; jobs: number[]; notes: string[]; waiting: number }> {
  const out = { queued: 0, jobs: [] as number[], notes: [] as string[], waiting: 0 };
  const dir = inboxDir(game);
  if (!dir) { out.notes.push("there is no root folder, so there is no inbox"); return out; }
  const top = await ibdeps.lstat(dir).catch(() => null);
  if (!top) return out;                                                     // not made yet: nothing landed
  // the game's folder, then the inbox folder above it: neither may be a link, a stranger's, or open to every user
  const why = (await ensureFolder(dir)) ?? (await ensureFolder(join(dir, "..")));
  if (why) { out.notes.push(why); return out; }
  const { entries, skipped } = await inboxEntries(dir);
  out.notes.push(...skipped);
  const now = ibdeps.now();
  for (const e of entries) {
    try {
      const st = await ibdeps.lstat(e.path);
      if (ibdeps.posix() && ibdeps.sandboxUids().includes(st.uid)) {
        const note = `${e.path}.not-taken.txt`;
        if (!(await ibdeps.lstat(note).catch(() => null))) await ibdeps.writeNote(note, "written by a build program, not by you: ludarr does not take it\n");
        out.notes.push(`${e.name}: written by a build program, not by you`);
        continue;
      }
      if (ibdeps.intakeFor(e.path)) { out.notes.push(`${e.name}: being taken in`); continue; }
      const sig = await signature(e);
      if (sig === null) continue;                                           // gone while it was looked at
      if (sig === "cap") { out.notes.push(`${e.name}: holds more than ${WALK_CAP} files, more than ludarr looks through`); continue; }
      if (sig.links) { out.notes.push(`${e.name}: holds a link, which ludarr never takes`); }
      // a note newer than anything in the entry: refused as it is; changed or dropped again, it is tried again
      const refused = await ibdeps.lstat(`${e.path}.not-taken.txt`).catch(() => null);
      if (refused && refused.mtimeMs >= sig.newest) { out.notes.push(`${e.name}: not taken (see ${e.name}.not-taken.txt); change it or drop it again to try again`); continue; }
      // <entry>.done beside it (an archive set's beside its first volume, or named for the set) — only one made after the
      // last change in the entry: one left from an earlier drop of the same name would take a half-copied entry
      const marker = (await ibdeps.lstat(`${e.path}.done`).catch(() => null)) ?? (e.parts.length > 1 ? await ibdeps.lstat(join(dir, `${e.name}.done`)).catch(() => null) : null);
      const done = !!marker && marker.mtimeMs >= Math.floor(sig.newest);
      const was = seenAs.get(e.path);
      if (!was || was.sig !== sig.sig) seenAs.set(e.path, { sig: sig.sig, since: now });
      const since = seenAs.get(e.path)!.since;
      if (!done && now - since < STABLE_MS) { out.waiting++; out.notes.push(`${e.name}: still arriving, or copied less than 10 minutes ago`); continue; }
      const job = ibdeps.enqueue(game.id, e.path, o.runId ?? null);
      seenAs.delete(e.path);
      out.queued++; out.jobs.push(job.id);
      log.info(`${game.name}: ${e.name} landed in the inbox — taking it in (job #${job.id})`);
    } catch (err: any) {
      out.notes.push(`${e.name}: ${err?.message ?? err}`);
    }
  }
  return out;
}
