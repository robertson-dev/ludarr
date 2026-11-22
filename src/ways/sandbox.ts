/**
 * ludarr — the build sandbox: where downloaded programs, a plan's setup steps, the steps that make a game file from
 * another form of its data, and the plan's checks run. A program from someone's repo, and the steps a plan asks for (the
 * AI may have written them), run as an unprivileged build user with an empty environment (none of ludarr's keys and
 * passwords reach them), with a home, a temp folder and a wine prefix of their own inside the job's scratch folder, and
 * no way into <config> (bootstrap makes it root-only, backups included).
 *
 * One build user per running job: the Docker image makes builder (uid 1500) and builder1 … builder7 (1501 to 1507), each
 * in a group of its own and none in 'users' (gid 100, the group Unraid's shares and the inbox folders belong to). The
 * runner takes one of builder1 … builder7 when a job starts (takeSandboxUser) and gives it back when the job ends
 * (releaseSandboxUser: whatever still runs as that user is stopped, and what it left in the temp folders goes). A job's
 * scratch folder (<root>/.work/job-<id>, and the folder a make may also have on the downloads folder's volume,
 * <downloads>/.ahoy-work/job-<id>) is root's and open only to that user's group, so the programs of one job never reach
 * another job's files, not even a folder handed to the other job's user. Everything that runs a program or hands over a
 * folder finds the job's user by the job id in the folder's path. 'builder' itself is never a job's: a folder of no job
 * (a look at a file outside any job, tests, dev boxes) runs as it, so stopping a job's user never stops one of those.
 *
 * The build user owns only what a step may write (handTo … "builder"), and everything is handed back to root, with no
 * group or other write left, before ludarr itself touches it again (handTo … "root"). A file with more than one link
 * (a kept game file ludarr placed by a hard link from the content store) is never handed over and never changed,
 * whoever asks: it is the store's own file. A folder holding such a link that ludarr did not place is not handed over
 * at all.
 *
 *   sandboxAvailable()            Linux, running as root, runuser on PATH, a 'builder' user (the Docker image makes one)
 *   sandboxExec(cmd, o)           cmd as the job's build user: runuser -u <user> -- env -i PATH=… HOME=<work>/home … cmd
 *   sandboxed(work)               the same as an Exec, for code that takes one (extractArchive, runUnderWine)
 *   handTo(dir, who, o)           a tree (no link is followed, no linked file touched) to the build user, or back to root
 *   sandboxOrAllowed()            may setup steps run programs here (the sandbox, or LUDARR_ALLOW_UNSANDBOXED=1)?
 *   runSandboxedStep(run, o)      one recorded step's program (a plan's setup step, a make step, a check step): its argv
 *                                 filled, its folder handed over for the run and back, what it left running stopped, its
 *                                 end judged (with a phase: PlanFault or EnvError, src/ways/errors.ts), a link it left
 *                                 behind refused
 *   takeSandboxUser(jobId)        the build user a job's programs run as (one per running job), null when all are in use;
 *   releaseSandboxUser(jobId)     the job ended: its user is cleared and free again
 *   closeJobFolder(path)          a job's folder made outside its scratch folder (a make's unpack on the downloads folder's
 *                                 volume) closed as the scratch folder is: root's, open to the job's user's group only
 *   sweepSpareWork(downloads, …)  what jobs that no longer run left in <downloads>/.ahoy-work (at boot, daily)
 *   sweepJobFolders(top, keep)    the same in any folder of jobs' folders (a root folder's work folder, at boot)
 *   noNetwork()                   can a step's program be cut off the network here (unshare -rn as the build user)? When
 *                                 it can, make and check steps run without one; builds and fetches keep it
 *   scrubWorldWritable()          nothing in the content stores and the packages, nor the folders they and the jobs' folders
 *                                 sit in, stays writable by others (at boot, daily)
 *   readBuildFile(path, max)      a file a build program wrote, read without following a link (ludarr is root)
 *   buildFileProblem(dir, rel)    whether what a build left at `rel` is a plain file of its own, reached through no link
 *
 * Without the sandbox (a dev box) the command runs as the current user with the same environment list and nothing
 * inherited from ludarr's own environment; assemble then refuses setup steps that run programs unless
 * LUDARR_ALLOW_UNSANDBOXED=1 (the tests set it with a fake exec).
 */
import { chmod, lchown, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { constants, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { removeTree, reapUnder } from "../fsutil";
import { logger } from "../log";
import { pdeps } from "../process/deps";
import { runUnderWine } from "../process/scene";
import { realExec, type Exec, type ExecOpts, type ExecResult } from "../process/tools";
import { EnvError, PlanFault } from "./errors";
import type { FailInfo } from "./types";

export const BUILD_USER = "builder";
/** what a sandboxed program finds on PATH */
export const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";
/** what runuser itself gets (it runs as root for the moment it takes to drop to the build user): a PATH and nothing else */
const ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** the names of the sandbox's own environment ludarr may set to another value for one run (the smoke start's wine log) */
const OVERRIDABLE = new Set(["WINEDEBUG", "LANG"]);
/** Unraid's shares and the inbox folders belong to this group: no build user is ever in it */
const USERS_GID = 100;
const log = logger("Sandbox");

/** a build user: its name and its uid */
export interface SandboxUser { user: string; uid: number }
/** the build users jobs are handed, in that order (builder1 … builder7). 'builder' is not among them: it runs what belongs
 *  to no job, and a job's user is stopped by its uid when the job ends — that must never stop anything else */
export const POOL_USERS: readonly SandboxUser[] = [1, 2, 3, 4, 5, 6, 7].map(i => ({ user: `${BUILD_USER}${i}`, uid: 1500 + i }));
const DEFAULT_USER: SandboxUser = { user: BUILD_USER, uid: 1500 };
/** every build user the Docker image makes: the pool, and 'builder' */
export const SANDBOX_USERS: readonly SandboxUser[] = [...POOL_USERS, DEFAULT_USER];
/** the uids of the build users (src/ways/inbox.ts and content.ts refuse a file one of them wrote) */
export const SANDBOX_UIDS: number[] = SANDBOX_USERS.map(u => u.uid).sort((a, b) => a - b);

/** swapped in tests: how commands run, which platform and user this is, the user and group databases, ownership changes,
 *  the processes running now, the temp folders, the library's trees */
export const sbdeps = {
  exec: realExec as Exec,
  platform: (): string => process.platform,
  which: (name: string): string | null => Bun.which(name),
  uid: (): number => (typeof process.getuid === "function" ? process.getuid() : -1),
  passwd: (): string => { try { return readFileSync("/etc/passwd", "utf8"); } catch { return ""; } },
  group: (): string => { try { return readFileSync("/etc/group", "utf8"); } catch { return ""; } },
  chown: (path: string, uid: number, gid: number): Promise<void> => lchown(path, uid, gid),
  chmod: (path: string, mode: number): Promise<void> => chmod(path, mode),
  /** every live process with its real and effective uid (/proc/<pid>/status says it without any ptrace right) */
  procs: (): { pid: number; uid: number; euid: number }[] => procUids(),
  kill: (pid: number): void => { try { process.kill(pid, "SIGKILL"); } catch { /* gone already */ } },
  /** an entry's own stat (no link followed): the temp folders and the library are judged by it */
  lstat: (path: string) => lstat(path),
  /** the folders a program writes in when it ignores TMPDIR */
  tempDirs: (): string[] => ["/tmp", "/var/tmp", "/dev/shm", "/tmp/.X11-unix", "/tmp/.ICE-unix"],
  /** the content stores, the games being uploaded (src/uploads.ts) and the packages: what no build user may ever write into */
  libraryTrees: async (): Promise<string[]> => {
    const [{ rootFolders }, { stmts }, { STORE }, { UPLOADS }] = await Promise.all([import("../library/rootfolders"), import("../db"), import("./content"), import("../uploads")]);
    const trees = rootFolders().flatMap(r => [join(r.path, STORE), join(r.path, UPLOADS)]);
    for (const p of stmts.packagesAll.all() as { path: string | null }[]) if (p.path) trees.push(p.path);
    return [...new Set(trees)];
  },
  /** the folders those trees and the jobs' scratch folders sit in (the root folders, their work folders): looked at by
   *  themselves, not walked — a build user who could write one could rename a package, the store or another job's folder
   *  away and put one of its own in its place */
  libraryFolders: async (): Promise<string[]> => {
    const { rootFolders, workDirFor } = await import("../library/rootfolders");
    return [...new Set(rootFolders().flatMap(r => [r.path, workDirFor(r)]))];
  },
  log: (line: string): void => log.info(line),
  /** how long a killed process is given to let go of its files */
  settleMs: 1500,
};

function procUids(): { pid: number; uid: number; euid: number }[] {
  if (process.platform !== "linux") return [];
  const out: { pid: number; uid: number; euid: number }[] = [];
  let names: string[] = [];
  try { names = readdirSync("/proc"); } catch { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let status = "";
    try { status = readFileSync(`/proc/${n}/status`, "utf8"); } catch { continue; }
    if (/^State:\s+Z/m.test(status)) continue;                                  // a zombie holds nothing
    const m = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
    if (m) out.push({ pid: Number(n), uid: Number(m[1]), euid: Number(m[2]) });
  }
  return out;
}

/* ─────────── the build users ─────────── */

/** a user's uid and gid, from the user database */
export function userIds(name: string): { uid: number; gid: number } | null {
  for (const line of sbdeps.passwd().split(/\r?\n/)) {
    const f = line.split(":");
    if (f[0] !== name || f.length < 4) continue;
    const uid = Number(f[2]), gid = Number(f[3]);
    if (Number.isInteger(uid) && Number.isInteger(gid) && uid > 0) return { uid, gid };
  }
  return null;
}
/** the build user's uid and gid, from the user database */
export const builderIds = (): { uid: number; gid: number } | null => userIds(BUILD_USER);

/** is the user in group 'users' (its own group, or listed in it)? Such a user could write the inbox and the shares */
function inUsersGroup(name: string, gid: number): boolean {
  if (gid === USERS_GID) return true;
  for (const line of sbdeps.group().split(/\r?\n/)) {
    const f = line.split(":");
    if (f.length >= 4 && Number(f[2]) === USERS_GID && f[3].split(",").map(s => s.trim()).includes(name)) return true;
  }
  return false;
}
/** a build user this server has as the image makes it: that name with that uid, in no group the shares belong to */
function usable(u: SandboxUser): boolean {
  const ids = userIds(u.user);
  return !!ids && ids.uid === u.uid && !inUsersGroup(u.user, ids.gid);
}

/** Linux, ludarr running as root (runuser needs it), runuser on PATH, and the build user exists */
export function sandboxAvailable(): boolean {
  return sbdeps.platform() === "linux" && sbdeps.uid() === 0 && !!sbdeps.which("runuser") && !!builderIds();
}

/** may a setup step run a program here: in the sandbox, or on a box whose owner said so (LUDARR_ALLOW_UNSANDBOXED=1) */
export const sandboxOrAllowed = () => sandboxAvailable() || process.env.LUDARR_ALLOW_UNSANDBOXED === "1";

/** who holds which build user: "job:<id>" (the runner's jobs) or "dir:<folder>" (a probe that is no job) */
const holders = new Map<string, SandboxUser>();
/** users whose last job's leftovers are still being cleared: not handed out until that is done */
const clearing = new Set<number>();

/** stop every process that runs as `uid` (never root, never ludarr itself); how many there were */
function stopUser(uid: number): number {
  if (uid < 1000) return 0;
  let n = 0;
  for (const p of sbdeps.procs()) {
    if ((p.uid !== uid && p.euid !== uid) || p.pid === process.pid || p.pid <= 1) continue;
    sbdeps.kill(p.pid);
    n++;
  }
  return n;
}
const runningAs = (uid: number) => sbdeps.procs().some(p => p.uid === uid || p.euid === uid);

/** a build user of the pool no job holds and nothing runs as; a user something of an earlier job still runs as is stopped
 *  and taken next time */
function freeUser(): SandboxUser | null {
  const held = new Set([...holders.values()].map(u => u.uid));
  for (const u of POOL_USERS) {
    if (held.has(u.uid) || clearing.has(u.uid) || !usable(u)) continue;
    if (runningAs(u.uid)) { const n = stopUser(u.uid); sbdeps.log(`${u.user} still ran ${n} process(es) after its last job: stopped, and it is handed out once they are gone`); continue; }
    return u;
  }
  return null;
}

/**
 * The build user job `jobId`'s programs run as while it runs: the one it already holds, else a free one of the pool (none
 * of the seven is in use by another job, and nothing runs as it). Null when every one is in use: the runner leaves the job
 * queued and tries again on its next tick. Without the sandbox (a dev box) every job runs as 'builder'.
 */
export function takeSandboxUser(jobId: number): SandboxUser | null {
  const key = `job:${jobId}`;
  const had = holders.get(key);
  if (had) return had;
  if (!sandboxAvailable()) { holders.set(key, DEFAULT_USER); return DEFAULT_USER; }
  const u = freeUser();
  if (u) holders.set(key, u);
  return u;
}

/** the job ended: what still runs as its build user is stopped, what that user left in the temp folders is removed, and
 *  the user is free again once that is done */
export function releaseSandboxUser(jobId: number): void {
  const key = `job:${jobId}`, u = holders.get(key);
  if (!u) return;
  holders.delete(key);
  if (!sandboxAvailable() || [...holders.values()].some(h => h.uid === u.uid)) return;
  clearing.add(u.uid);
  stopUser(u.uid);
  void clearTemp(u.uid).catch(() => {}).finally(() => clearing.delete(u.uid));
}

/** the entries a build user left in the temp folders (an X display's lock, a wine socket, anything a program wrote
 *  outside its scratch folder) */
async function clearTemp(uid: number): Promise<number> {
  let n = 0;
  for (const dir of sbdeps.tempDirs()) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const p = join(dir, name);
      const st = await sbdeps.lstat(p).catch(() => null);
      if (!st || st.uid !== uid) continue;
      if (!(await removeTree(p).catch(() => [p])).length) n++;
    }
  }
  if (n) sbdeps.log(`removed ${n} temp entr${n === 1 ? "y" : "ies"} uid ${uid} left behind`);
  return n;
}

const JOB_DIR = /^job-(\d+)$/;
/** the job folder a path is in (<work folder>/job-<id>, the outermost one), and its job id */
function jobFolderOf(path: string): { id: number; dir: string } | null {
  const parts = resolve(path).split(/[\\/]+/);
  for (let i = 0; i < parts.length; i++) {
    const m = JOB_DIR.exec(parts[i]);
    if (m) return { id: Number(m[1]), dir: parts.slice(0, i + 1).join(sep) || sep };
  }
  return null;
}
const under = (p: string, dir: string) => { const a = resolve(p), b = resolve(dir); return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep); };

/** the build user a job (or a probe) holds for the folder `path` is in, or null when nobody holds one for it */
function heldUserFor(path: string): SandboxUser | null {
  for (const [key, u] of holders) if (key.startsWith("dir:") && under(path, key.slice(4))) return u;
  const job = jobFolderOf(path);
  return (job && holders.get(`job:${job.id}`)) || null;
}
/** the build user the programs working in `path` run as: the user of the job whose folder it is in (or of the probe that
 *  holds it), else 'builder' */
export const sandboxUserFor = (path: string): SandboxUser => heldUserFor(path) ?? DEFAULT_USER;

/** `fn` with a build user of its own for `dir` (a probe that belongs to no job); null when every user is in use */
export async function withSandboxUser<T>(dir: string, fn: (u: SandboxUser) => Promise<T>): Promise<T | null> {
  const key = `dir:${resolve(dir)}`;
  const u = sandboxAvailable() ? freeUser() : DEFAULT_USER;
  if (!u) return null;
  holders.set(key, u);
  try { return await fn(u); }
  finally {
    holders.delete(key);
    if (sandboxAvailable() && ![...holders.values()].some(h => h.uid === u.uid)) { clearing.add(u.uid); stopUser(u.uid); await clearTemp(u.uid).catch(() => 0); clearing.delete(u.uid); }
  }
}

/** tests: no user held, no probe answer kept */
export function resetSandbox(): void { holders.clear(); clearing.clear(); netProbe = null; }

/* ─────────── running a program ─────────── */

/** the folders a sandboxed program may write in, inside the job's scratch folder */
export const sandboxDirs = (work: string) => ({ home: join(work, "home"), tmp: join(work, "tmp"), wine: join(work, "wine"), scratch: join(work, "scratch") });

/** the environment a sandboxed program gets, as NAME=value items: the fixed list first (`override` may give WINEDEBUG and
 *  LANG another value), then `extra` names it lacks */
export function sandboxEnv(work: string, extra: Record<string, string> = {}, override: Record<string, string> = {}): string[] {
  const d = sandboxDirs(work);
  const base: [string, string][] = [["PATH", SANDBOX_PATH], ["HOME", d.home], ["LANG", "C.UTF-8"], ["TMPDIR", d.tmp], ["WINEPREFIX", d.wine], ["WINEDEBUG", "-all"]];
  for (const [k, v] of Object.entries(override)) {
    const at = base.findIndex(([n]) => n === k);
    if (OVERRIDABLE.has(k) && at >= 0 && !String(v).includes("\0")) base[at] = [k, String(v)];
  }
  const have = new Set(base.map(([k]) => k));
  for (const [k, v] of Object.entries(extra)) if (ENV_KEY.test(k) && !have.has(k) && !String(v).includes("\0")) { base.push([k, String(v)]); have.add(k); }
  return base.map(([k, v]) => `${k}=${v}`);
}

/** the job's folder is root's and open to its build user's group only (rwxr-x---): another job's user cannot even look
 *  into it, and its own user cannot rename what ludarr keeps in it. `loose`: a folder that is no job's (a probe's) is
 *  closed the same way. The folder it sits in (<root>/.work) loses write for others when it has it without the sticky bit
 *  (Unraid's "New Permissions" makes whole shares 0777): there, any build user could rename another job's folder away and
 *  put one of its own in its place, with a staging folder ludarr would then package */
async function claimJobFolder(path: string, ids: { uid: number; gid: number }, o: { loose?: boolean } = {}): Promise<void> {
  const top = jobFolderOf(path)?.dir ?? (o.loose ? resolve(path) : null);
  if (!top) return;
  await mkdir(top, { recursive: true });
  await sbdeps.chown(top, 0, ids.gid);
  await sbdeps.chmod(top, 0o750);
  const parent = dirname(top);
  const st = parent !== top ? await sbdeps.lstat(parent).catch(() => null) : null;
  if (st?.isDirectory() && (st.mode & 0o002) && !(st.mode & 0o1000)) {
    await sbdeps.chmod(parent, st.mode & 0o7777 & ~0o002);
    sbdeps.log(`${parent} was writable by others: no longer (a build program could have swapped another job's folder)`);
  }
}

/**
 * A folder of job `path`'s made outside its scratch folder (a make's unpack on the downloads folder's volume:
 * <downloads>/.ahoy-work/job-<id>/…) closed as the scratch folder is, before anything is written in it: the job folder in
 * its path root's and open to the job's build user's group only, and the folder it sits in without write for others. A
 * no-op without the sandbox, or for a path that is in no job's folder.
 */
export async function closeJobFolder(path: string): Promise<void> {
  if (!sandboxAvailable() || !jobFolderOf(path)) return;
  const ids = userIds(sandboxUserFor(path).user);
  if (ids) await claimJobFolder(path, ids);
}

/** where jobs keep what does not fit the library: a folder of the downloads folder's own (another volume) */
export const SPARE_WORK = ".ahoy-work";
/** job `jobId`'s folder there */
export const spareJobFolder = (downloads: string, jobId: number) => join(resolve(downloads), SPARE_WORK, `job-${jobId}`);

/**
 * What jobs left in <downloads>/.ahoy-work and no longer need: each job-<id> folder whose job is not running (a restart
 * cut it short; a resumed job makes a fresh one), and what an earlier sweep set aside. A folder is first renamed aside, so
 * a job that starts meanwhile makes its own new one, then removed (anything still running in it stopped first). How many
 * went.
 */
export async function sweepSpareWork(downloads: string, running: (jobId: number) => boolean, log: (line: string) => void = sbdeps.log): Promise<number> {
  return sweepJobFolders(join(resolve(downloads), SPARE_WORK), running, log);
}

/**
 * The same in any folder of jobs' folders (a root folder's work folder too): each job-<id> folder whose job `keep` does
 * not keep (its job ended, or is no more) and what an earlier sweep set aside go — renamed aside first, so a job that
 * starts meanwhile makes a new one. How many went.
 */
export async function sweepJobFolders(top: string, keep: (jobId: number) => boolean, log: (line: string) => void = sbdeps.log): Promise<number> {
  let n = 0;
  for (const name of await readdir(top).catch(() => [] as string[])) {
    const m = JOB_DIR.exec(name), p = join(top, name);
    if (!m && !name.startsWith("swept-")) continue;
    const st = await sbdeps.lstat(p).catch(() => null);
    if (!st?.isDirectory()) continue;
    // asked last, with nothing awaited before the rename: a job that has started by now keeps its folder, and one that
    // starts after it makes a new one
    if (m && keep(Number(m[1]))) continue;
    let gone = p;
    if (m) {
      gone = join(top, `swept-${m[1]}-${Date.now()}`);
      try { await rename(p, gone); } catch { continue; }                   // in use again, or gone already
    }
    await reapUnder(gone).catch(() => []);
    if (!(await removeTree(gone).catch(() => [gone])).length) n++;
  }
  if (n) log(`removed ${n} folder${n === 1 ? "" : "s"} jobs that no longer run left in ${top}`);
  return n;
}

/** home, temp, wine prefix and scratch folders made and owned by the build user (wine refuses a prefix it does not own) */
async function ensureDirs(work: string, ids: { uid: number; gid: number } | null): Promise<void> {
  if (ids) await claimJobFolder(work, ids, { loose: true });
  for (const dir of Object.values(sandboxDirs(work))) {
    await mkdir(dir, { recursive: true });
    if (ids) await sbdeps.chown(dir, ids.uid, ids.gid);
  }
}

export interface SandboxOpts {
  work: string; timeoutMs?: number; signal?: AbortSignal; cwd?: string; env?: Record<string, string>; maxOutput?: number;
  /** ludarr's own values for the sandbox's names (WINEDEBUG=err+all for a smoke start) */
  override?: Record<string, string>;
  /** cut the program off the network when this server can (noNetwork()) */
  noNetwork?: boolean;
}

/** run `cmd` as the job's build user with nothing but the sandbox environment (see the file header) */
export async function sandboxExec(cmd: string[], o: SandboxOpts): Promise<ExecResult> {
  const on = sandboxAvailable();
  const who = sandboxUserFor(o.work);
  const ids = on ? userIds(who.user) : null;
  if (on && !ids) return { code: 127, stdout: "", stderr: `the build user ${who.user} is not on this server`, timedOut: false };
  await ensureDirs(o.work, ids);
  const env = sandboxEnv(o.work, o.env, o.override);
  const opts: ExecOpts = { inheritEnv: false, cwd: o.cwd, timeoutMs: o.timeoutMs, signal: o.signal, maxOutput: o.maxOutput };
  const cut = o.noNetwork && on && (await noNetwork()) ? [sbdeps.which("unshare") ?? "unshare", "-rn"] : [];
  if (ids) return sbdeps.exec([sbdeps.which("runuser")!, "-u", who.user, "--", "env", "-i", ...env, ...cut, ...cmd], { ...opts, env: { PATH: ROOT_PATH } });
  return sbdeps.exec(cmd, { ...opts, env: Object.fromEntries(env.map(kv => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])) });
}

/** sandboxExec as an Exec (the extra env a caller passes is added to the sandbox's own list, never over it) */
export function sandboxed(work: string, extra: { noNetwork?: boolean; override?: Record<string, string> } = {}): Exec {
  return (cmd, opts = {}) => sandboxExec(cmd, { work, timeoutMs: opts.timeoutMs, signal: opts.signal, cwd: opts.cwd, env: opts.env, maxOutput: opts.maxOutput, ...extra });
}

let netProbe: Promise<boolean> | null = null;
/**
 * Can a program be cut off the network here: `unshare -rn` (a user namespace of its own with a network namespace that
 * has nothing in it) as the build user. Asked once; a container whose runtime refuses new namespaces answers no, and its
 * make and check steps keep the network (the build user can still reach the LAN there: a known limit).
 */
export function noNetwork(): Promise<boolean> {
  if (!sandboxAvailable()) return Promise.resolve(false);
  netProbe ??= (async () => {
    const unshare = sbdeps.which("unshare");
    if (!unshare) { sbdeps.log("make and check steps keep the network: unshare is not on this server"); return false; }
    const r = await sbdeps.exec([sbdeps.which("runuser")!, "-u", BUILD_USER, "--", unshare, "-rn", "true"], { inheritEnv: false, env: { PATH: ROOT_PATH }, timeoutMs: 15_000, maxOutput: 2000 }).catch(() => null);
    const ok = r?.code === 0;
    sbdeps.log(ok ? "make and check steps run without a network (unshare -rn)" : `make and check steps keep the network: unshare -rn is refused here${r ? ` (exit ${r.code}${(r.stderr || r.stdout).trim() ? `: ${(r.stderr || r.stdout).trim().split("\n").pop()!.slice(0, 160)}` : ""})` : ""}`);
    return ok;
  })();
  return netProbe;
}

/* ─────────── handing a folder over ─────────── */

/** a file by its device and inode (what a hard link shares with the file it links to) */
export interface LinkRef { dev: number | bigint; ino: number | bigint }
const linkKey = (s: LinkRef) => `${String(s.dev)}:${String(s.ino)}`;
const linkSet = (refs: Iterable<LinkRef> | null | undefined) => new Set([...(refs ?? [])].map(linkKey));

export interface HandOpts {
  /** the files ludarr placed by hard link (the content store's): left as they are, the only links a tree may hold */
  skip?: Iterable<LinkRef> | null;
  log?: (line: string) => void;
}

/** a regular file with more than one link that ludarr did not place, in `dir` (its path inside it), or null */
async function strangerLink(dir: string, keep: Set<string>): Promise<string | null> {
  const walk = async (p: string, rel: string): Promise<string | null> => {
    const st = await lstat(p).catch(() => null);
    if (!st) return null;
    if (st.isFile()) return st.nlink > 1 && !keep.has(linkKey(st)) ? rel || "." : null;
    if (!st.isDirectory()) return null;
    for (const n of await readdir(p).catch(() => [] as string[])) { const hit = await walk(join(p, n), rel ? `${rel}/${n}` : n); if (hit) return hit; }
    return null;
  };
  return walk(dir, "");
}

/**
 * Hand a tree to the job's build user (so a step can write in it) or back to root. Links are never followed (lchown,
 * and a link's target is never walked). Going back to root also clears group/other write and the set-id bits, so a
 * build-user process that outlived its step cannot change what ludarr packages next. A regular file with more than one
 * link, or one ludarr placed (`skip`), is never chowned or chmodded either way: it is a kept file of the content store,
 * and the build user must not be able to write it. A tree holding a multi-linked file ludarr did not place is not handed
 * to the build user at all. A no-op without the sandbox.
 */
export async function handTo(dir: string, who: "builder" | "root", o: HandOpts = {}): Promise<void> {
  if (!sandboxAvailable()) return;
  const ids = who === "builder" ? userIds(sandboxUserFor(dir).user) : { uid: 0, gid: 0 };
  if (!ids) return;
  const keep = linkSet(o.skip);
  if (who === "builder") {
    const hit = await strangerLink(dir, keep);
    if (hit) throw new Error(`${hit} is a hard link to a file ludarr did not place: a folder holding one is not handed to a build program`);
    // the job's folder is closed to every other job's user before anything in it is theirs to write
    await claimJobFolder(dir, ids);
  }
  let left = 0;
  const first: string[] = [];
  const walk = async (p: string, rel: string) => {
    const st = await lstat(p).catch(() => null);
    if (!st) return;
    if (st.isFile() && (st.nlink > 1 || keep.has(linkKey(st)))) { left++; if (first.length < 3) first.push(rel || "."); return; }
    await sbdeps.chown(p, ids.uid, ids.gid);
    if (st.isSymbolicLink()) return;
    if (who === "root") await sbdeps.chmod(p, st.mode & 0o755);
    if (st.isDirectory()) for (const n of await readdir(p).catch(() => [] as string[])) await walk(join(p, n), rel ? `${rel}/${n}` : n);
  };
  await walk(dir, "");
  if (left && who === "builder") o.log?.(`${left} linked file${left === 1 ? "" : "s"} left as ${left === 1 ? "it is" : "they are"} (${first.join(", ")}${left > first.length ? " …" : ""}): a kept game file is never handed to a build program`);
}

/** why `dir` cannot be packaged or used after a step: a link (symbolic, or a hard link ludarr did not place), or
 *  something that is not a file or a folder; null when it holds only files and folders (and the links ludarr placed:
 *  hard links by device and inode, symbolic ones by their path, in a check's throwaway folder) */
export async function linkProblem(dir: string, what: string, skip?: Iterable<LinkRef> | null, symlinks?: Iterable<string> | null): Promise<string | null> {
  const keep = linkSet(skip);
  const pointers = new Set([...(symlinks ?? [])].map(p => resolve(p)));
  const walk = async (p: string, rel: string): Promise<string | null> => {
    for (const n of await readdir(p)) {
      const full = join(p, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(full);
      if (st.isSymbolicLink() && pointers.has(resolve(full))) continue;
      if (st.isSymbolicLink()) return `${what} holds a link (${r}), and a package carries files only`;
      if (st.isDirectory()) { const hit = await walk(full, r); if (hit) return hit; }
      else if (!st.isFile()) return `${what} holds something that is not a file (${r})`;
      else if (st.nlink > 1 && !keep.has(linkKey(st))) return `${what} holds a hard link (${r}), and a package carries files of its own only`;
    }
    return null;
  };
  return walk(dir, "");
}

/* ─────────── one recorded step's program ─────────── */

/** a program a recorded step starts: exactly one of exe and tool (the caller finds which file that is) */
export interface SandboxedRun { exe?: string; tool?: string; argv: string[]; wine: boolean; timeoutSec: number }
export interface SandboxedStepOpts {
  /** the program to start, as the caller found it: an absolute path, or a bare Linux tool name on the sandbox's PATH */
  exe: string;
  /** the folder the step works in: the build user's while it runs, root's again after it, and refused if it then holds a link */
  cwd: string;
  /** folders outside cwd the step writes in too (a make's {prep} on the downloads folder's volume): handed over and back
   *  with cwd, and refused alike when they then hold a link */
  also?: string[] | null;
  /** what each {placeholder} in argv becomes, in one pass: a '$' in a value is no replacement pattern, and a filled-in value
   *  is never filled again. A value that is the placeholder itself ("{content}") means it cannot be given here */
  fill: Record<string, () => string>;
  /** the job's scratch folder: the sandbox's home, temp and wine prefix are in it, and what the step leaves running there
   *  is stopped */
  work: string;
  signal: AbortSignal;
  log: (line: string) => void;
  /** a wine run starts in this folder (default cwd; the caller passes the program's own folder when it is inside cwd); its
   *  prefix is the sandbox's own, in work */
  wine?: { cwd?: string };
  /** the step's name in its log line ("setup 3") and in what it throws ("setup step 3") */
  name: { log: string; error: string };
  /** what to say when a placeholder's value cannot be given (the step is refused before anything runs) */
  unfilled?: (placeholder: string) => string;
  /** the phase the step belongs to: when given, a non-zero exit, a timeout, a value that cannot be given or a link left
   *  behind is thrown as PlanFault(phase), and an out-of-memory kill (exit 137, "Killed") or an illegal-instruction exit
   *  (SIGILL, 0xC000001D under wine) as EnvError('oom' | 'cpu'), and so is a wine step on a server without wine
   *  (EnvError('tool')) (src/ways/errors.ts); without it, as a plain Error (the setup steps before wave 3) */
  phase?: FailInfo["phase"];
  /** the files ludarr placed in cwd by hard link (the content store's): never handed to the build user, and the only
   *  links the step may leave behind */
  skip?: Iterable<LinkRef> | null;
  /** the symbolic links ludarr placed in cwd (a check's throwaway folder points at the store's files) */
  symlinks?: Iterable<string> | null;
  /** Called after a known archiver exits and its children are stopped, before the slow ownership walk. */
  archiveExited?: (result: ExecResult) => Promise<void>;
  /** false: the program's result comes back whatever its exit, for the caller to judge (a check); a cancel, a value that
   *  cannot be given and a link left behind still throw */
  judge?: boolean;
  /** cut the program off the network when this server can (default: make, unpack, convert and check steps that are no
   *  wine runs, WINE_WITHOUT_NETWORK) */
  noNetwork?: boolean;
}

/** the phases whose programs need no network: game data is re-shaped and checked from what is on the server */
const NO_NETWORK_PHASES = new Set<FailInfo["phase"]>(["make", "unpack", "convert", "check"]);
/** whether a Windows program under wine runs without a network too. Not yet: inside `unshare -r` it sees itself as root,
 *  and wine there is not proven in the image (the integrator's check); until it is, wine steps keep the network, as
 *  every step did before */
export const WINE_WITHOUT_NETWORK = false;
/** bash's own words for a child it saw killed (an out-of-memory kill): "bash: line 1:  1234 Killed   ./x" — the shell's
 *  name and line number first, so a program printing "3 Killed" at the start of a line is not taken for it */
const KILLED = /(?:^|\n)[^\n:]+: line \d+: +\d+ Killed\b/;
const outputTail = (r: ExecResult) => (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ").slice(-300);

/** what ended a program that this server, not the plan, is to blame for: memory ran out (exit 137, or bash saw it
 *  killed), or the CPU lacks an instruction it used (SIGILL = exit 132; a Windows program's 0xC000001D under wine) */
export function exitTrouble(res: ExecResult, wine: boolean): "oom" | "cpu" | null {
  if (res.timedOut) return null;
  if (res.code === 137 || KILLED.test((res.stderr || "").slice(-2000))) return "oom";
  if (res.code === 132 || (wine && (res.code === 29 || res.code === 0xc000001d || res.code === -1073741795))) return "cpu";
  return null;
}

/**
 * How a step's program ended, as what is thrown (null: it ended well). With a phase: an out-of-memory kill or an
 * instruction the CPU lacks is EnvError (this server's), a timeout or another non-zero exit PlanFault (the recipe's);
 * without one, plain Errors with the same words.
 */
export function stepFailure(res: ExecResult, o: { name: string; timeoutSec: number; wine: boolean; phase?: FailInfo["phase"] }): Error | null {
  const tail = outputTail(res);
  const fault = (msg: string) => (o.phase ? new PlanFault(o.phase, msg) : new Error(msg));
  const trouble = o.phase ? exitTrouble(res, o.wine) : null;
  if (trouble === "oom") return new EnvError("oom", `${o.name} was stopped: the server ran out of memory (exit ${res.code})${tail ? `: ${tail}` : ""}`);
  if (trouble === "cpu") return new EnvError("cpu", `${o.name} stopped on an instruction this server's CPU does not have (exit ${res.code})${tail ? `: ${tail}` : ""}`);
  if (res.timedOut) return fault(`${o.name} ran out of time (${o.timeoutSec} s)${tail ? `: ${tail}` : ""}`);
  if (res.code !== 0) return fault(`${o.name} failed (exit ${res.code})${tail ? `: ${tail}` : ""}`);
  return null;
}

/**
 * Run one recorded step's program in the sandbox: argv filled, the step's folder handed to the job's build user for the
 * run and back to root after it, whatever the step left running stopped, then a cancel, a timeout or a non-zero exit
 * thrown with the last lines it printed, and a link it left in its folder refused. The plan's setup steps
 * (src/ways/assemble.ts) and the make and check steps run through it. It does not ask whether programs may run here: the
 * caller checks sandboxOrAllowed() first, as the setup steps do (without the sandbox the program runs as ludarr's user).
 */
export async function runSandboxedStep(run: SandboxedRun, o: SandboxedStepOpts): Promise<ExecResult> {
  const fault = (msg: string) => (o.phase ? new PlanFault(o.phase, msg) : new Error(msg));
  const keys = Object.keys(o.fill).filter(k => /^[A-Za-z0-9_]+$/.test(k));
  const re = keys.length ? new RegExp(`\\{(${keys.join("|")})\\}`, "g") : null;
  const missing: string[] = [];
  const argv = re ? run.argv.map(a => a.replace(re, (_m, k: string) => { const v = o.fill[k](); if (v === `{${k}}`) missing.push(k); return v; })) : [...run.argv];
  if (missing.length) throw fault(o.unfilled ? o.unfilled(missing[0]) : `${o.name.error} needs {${missing[0]}}, and it cannot be given here`);
  if (run.wine && o.phase) { const t = pdeps.tools(); if (!t.wine || !t.xvfb) throw new EnvError("tool", `${o.name.error} runs a Windows program, and wine or its virtual display is not on this server`); }
  o.log(`${o.name.log}: ${run.wine ? "wine " : ""}${run.tool ?? run.exe} ${argv.join(" ")}`.trimEnd());
  const exec = sandboxed(o.work, { noNetwork: o.noNetwork ?? (!!o.phase && NO_NETWORK_PHASES.has(o.phase) && (!run.wine || WINE_WITHOUT_NETWORK)) });
  const timeoutMs = run.timeoutSec * 1000;
  // the job's own build user, when it holds one: whatever runs as it once the step is over is the step's
  const own = sandboxAvailable() ? heldUserFor(o.work) : null;
  const also = (o.also ?? []).filter(d => !under(d, o.cwd));
  await handTo(o.cwd, "builder", { skip: o.skip, log: o.log });
  for (const d of also) await handTo(d, "builder", { skip: o.skip, log: o.log });
  let res: ExecResult | undefined;
  try {
    res = run.wine
      ? await runUnderWine(exec, o.exe, argv, { prefix: sandboxDirs(o.work).wine, cwd: o.wine?.cwd ?? o.cwd, timeoutMs, tools: pdeps.tools(), signal: o.signal })
      : await exec([o.exe, ...argv], { cwd: o.cwd, timeoutMs, signal: o.signal, maxOutput: 8000 });
  } finally {
    const pids = await reapUnder(o.work).catch(() => [] as number[]);
    // with one build user per job, whatever still runs as it is the step's (a daemon it started, a helper it forgot):
    // /proc tells a process's uid without the ptrace right a container lacks to read its working folder
    const more = own ? stopUser(own.uid) : 0;
    if (more) await new Promise(r => setTimeout(r, sbdeps.settleMs));
    if (pids.length || more) o.log(`${o.name.log}: stopped ${pids.length + more} process(es) it left running`);
    try {
      if (o.archiveExited && res && !o.signal.aborted) await o.archiveExited(res);
    } finally {
      await handTo(o.cwd, "root", { skip: o.skip, log: o.log });
      for (const d of also) await handTo(d, "root", { skip: o.skip, log: o.log });
    }
  }
  if (o.signal.aborted) throw new Error("cancelled");
  if (o.judge !== false) { const f = stepFailure(res, { name: o.name.error, timeoutSec: run.timeoutSec, wine: run.wine, phase: o.phase }); if (f) throw f; }
  for (const d of [o.cwd, ...also]) {
    const links = await linkProblem(d, o.name.error, o.skip, o.symlinks);
    if (links) throw fault(links);
  }
  return res;
}

/** stop what still runs out of a job's scratch folder: by the paths it holds, and everything that runs as the job's own
 *  build user (the one way to see a build user's processes where reading their folders needs a ptrace right); how many */
export async function stopUnder(work: string): Promise<number> {
  const pids = await reapUnder(work).catch(() => [] as number[]);
  const own = sandboxAvailable() ? heldUserFor(work) : null;
  const more = own ? stopUser(own.uid) : 0;
  // the kernel closes a killed process's files a moment later: a folder removed before that keeps its files on Unraid's
  // shares (".fuse_hidden…"), and with them a link to a kept game file
  if (more) await new Promise(r => setTimeout(r, sbdeps.settleMs));
  return pids.length + more;
}

/* ─────────── the library stays ludarr's ─────────── */

/**
 * Every entry under the content stores and the packages that others could write loses that write (Unraid's "New
 * Permissions" makes whole shares 0777), and one a build user owns, or its group may write, goes back to root: no
 * program of any repo can change a kept game file or a package. The folders those sit in — each root folder and its work
 * folder — get the same, by themselves (not walked): write there would let a program rename a package, the store or
 * another job's folder away and put its own in its place. Links are never followed. At boot and once a day
 * (src/main.ts); what it changed is logged. A no-op without the sandbox (no build users here).
 */
export async function scrubWorldWritable(o: { trees?: string[]; folders?: string[]; log?: (line: string) => void; signal?: AbortSignal } = {}): Promise<{ looked: number; fixed: number }> {
  const out = { looked: 0, fixed: 0 };
  if (!sandboxAvailable()) return out;
  const say = o.log ?? sbdeps.log;
  const uids = new Set(SANDBOX_UIDS);
  const gids = new Set(SANDBOX_USERS.map(u => userIds(u.user)?.gid).filter((g): g is number => typeof g === "number" && g !== 0 && g !== USERS_GID));
  /** one entry made ludarr's: no write for others, none for a build user's group, a build user's own back to root */
  const fix = async (p: string, st: Awaited<ReturnType<typeof sbdeps.lstat>>): Promise<boolean> => {
    const mode = st.mode & 0o7777;
    let want = mode & ~0o002;
    if (gids.has(st.gid)) want &= ~0o020;
    if (uids.has(st.uid)) { await sbdeps.chown(p, 0, 0); want &= ~0o6022; }
    if (want === mode && !uids.has(st.uid)) return false;
    if (want !== mode) await sbdeps.chmod(p, want);
    return true;
  };
  for (const tree of o.trees ?? await sbdeps.libraryTrees()) {
    let fixed = 0;
    const first: string[] = [];
    const walk = async (p: string, rel: string) => {
      if (o.signal?.aborted) return;
      const st = await sbdeps.lstat(p).catch(() => null);
      if (!st || st.isSymbolicLink()) return;
      out.looked++;
      if (await fix(p, st)) {
        fixed++;
        if (first.length < 3) first.push(rel || ".");
      }
      if (st.isDirectory()) for (const n of await readdir(p).catch(() => [] as string[])) await walk(join(p, n), rel ? `${rel}/${n}` : n);
    };
    await walk(tree, "");
    out.fixed += fixed;
    if (fixed) say(`${tree}: ${fixed} entr${fixed === 1 ? "y was" : "ies were"} writable by others or by a build program, and no longer are (${first.join(", ")}${fixed > first.length ? " …" : ""})`);
  }
  // the folders those trees and the jobs' folders sit in, each by itself (a sticky one, like /tmp, already keeps others'
  // entries from being renamed); 'users' (gid 100) keep their write, so the share's own users still write the library
  for (const dir of o.folders ?? (o.trees ? [] : await sbdeps.libraryFolders())) {
    if (o.signal?.aborted) break;
    const st = await sbdeps.lstat(dir).catch(() => null);
    if (!st?.isDirectory() || (st.mode & 0o1000)) continue;
    out.looked++;
    if (await fix(dir, st)) { out.fixed++; say(`${dir} was writable by others or by a build program, and no longer is`); }
  }
  return out;
}

/**
 * A file a build program wrote, read by ludarr (root) without following a link — a link there could point at any file of
 * root's, which would then end up in a report, a screenshot the admin is shown, or a prompt — and only when it has one name
 * (a hard link could be another file of the server's): its last `max` bytes, or null when it is no such file.
 */
export async function readBuildFile(path: string, max: number): Promise<Buffer | null> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.nlink !== 1) return null;
  const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!fh) return null;
  try {
    const now = await fh.stat();
    if (!now.isFile() || now.nlink !== 1 || (now.ino && st.ino && now.ino !== st.ino)) return null;   // replaced meanwhile
    const len = Math.max(0, Math.min(now.size, max));
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) { const { bytesRead } = await fh.read(buf, got, len - got, now.size - len + got); if (!bytesRead) break; got += bytesRead; }
    return buf.subarray(0, got);
  } finally { await fh.close().catch(() => {}); }
}

/** why `rel` inside `dir` is not a plain file of the build's own (a link on the way to it, a link or several names at the
 *  end, nothing there), or null: what a build left is taken out of its folder only when it is */
export async function buildFileProblem(dir: string, rel: string): Promise<string | null> {
  let at = dir;
  const segs = rel.split("/").filter(Boolean);
  for (const [i, s] of segs.entries()) {
    at = join(at, s);
    const st = await lstat(at).catch(() => null);
    if (!st) return `there is no ${rel}`;
    if (st.isSymbolicLink()) return `${segs.slice(0, i + 1).join("/")} is a link, and nothing is taken through one`;
    if (i < segs.length - 1 && !st.isDirectory()) return `${segs.slice(0, i + 1).join("/")} is not a folder`;
    if (i === segs.length - 1 && (!st.isFile() || st.nlink !== 1)) return st.isFile() ? `${rel} has more than one name (a hard link)` : `${rel} is not a file`;
  }
  return segs.length ? null : `there is no ${rel}`;
}

/** whether a path's entry was written by a build program (owned by one of the build users) — the inbox and intake refuse
 *  such an entry */
export function writtenByBuildUser(path: string): boolean {
  try { return SANDBOX_UIDS.includes(lstatSync(path).uid); } catch { return false; }
}
