/**
 * ludarr — imports: a finished download → an installed, verified game folder in a root folder.
 *
 *   queued → running (importers in priority order → verify + manifest → move) → done | failed
 *
 * One import at a time by default (IMPORT_PARALLEL); more run side by side when the scratch disk has room for
 * each of them (an import can need three times its download: unpacked, the disc moved aside, the install). The
 * transcript on the job row is the audit trail;
 * next to it the job keeps what the input looked like (fingerprint), every AI step in full (trace) and
 * the AI importer's lesson — what turns today's AI run into tomorrow's deterministic recipe.
 *
 * Jobs of the other kinds (src/process/kinds.ts: building a way, taking in game files, making them, the AI constructing a
 * plan) run here too, each kind in a lane of its own, so nothing long holds up what members wait for:
 *
 *   import  downloads to install                              IMPORT_PARALLEL
 *   ways    assembling a way, building a plan's program       WAYS_PARALLEL
 *   intake  taking game files in (a download, the copy, the inbox)   INTAKE_PARALLEL (intakeCap)
 *   long    making a game file, building a program for one game      LONG_PARALLEL (longCap)
 *   ai      the AI constructing or repairing a plan           one at a time
 *
 * All lanes share the scratch reservation (and keep LIBRARY_KEEP_FREE_GB free for the jobs that write game data), and
 * every lane but the imports' holds each job's lock key (kinds.ts lockKeyOf): two jobs on one way never run at once,
 * whatever their lanes. Such a job has no download: its input is a sentinel ('way:3'), which is never looked at,
 * fingerprinted or deleted. Its kind's module says how it runs; its ticks go out as 'build' events, its state changes as
 * 'job' events. A job's programs run as a build user of its own (src/ways/sandbox.ts takeSandboxUser), taken when it
 * starts and given back when it ends; with none free it waits in the queue.
 *
 * An import's programs (unpackers, an installer under wine, the AI importer's shell) are not in that sandbox yet: they run
 * as ludarr's own user. What they get is a small fixed environment with none of ludarr's keys (src/process/tools.ts
 * importEnv), and what they leave is packaged as files and folders only: a link is never followed (src/process/classify.ts
 * scan) and is removed before the folder is weighed, hashed and moved into the library.
 *
 * Every job that ends badly says why as a type (jobs.fail_json, src/ways/errors.ts failOf): what a carry run does next
 * depends on it, never on the words. A cancel records who asked (the admin, a carry run, ludarr itself); a job a restart
 * cut short and that may not run again unasked says so too.
 *
 * finalizePackage is where any job's verified folder becomes the game's one package (imports and built ways alike):
 * an import never replaces a built way unless asked to, a way never replaces a PC copy unless asked to, a package only
 * ever moves into a folder of its own, and the ways that had built a replaced package settle again (ready, or what they
 * now lack).
 */
import { mkdir, readdir, rename, cp, lstat, rm, stat, writeFile } from "node:fs/promises";
import { removeTree, reapUnder } from "../fsutil";
import { formerName } from "../former";
import { writeIndex } from "../blocks";
import { consolePlatforms, isConsole, type PlatformId } from "../platforms";
import { basename, dirname, join, resolve, sep } from "node:path";
import { stmts, serializeJob, serializePackage, type JobRow, type GameRow, type FetchRow, type PackageRow, type RootFolderRow } from "../db";
import { cfg, cfgBool, cfgNum, downloadsDir, workDir } from "../config";
import { events } from "../events";
import { parseTitle } from "../releases";
import { describeToolbox } from "./tools";
import { pdeps } from "./deps";
import * as registry from "../plugins/registry";
import type { ImportContext, Importer, ImportResult, TraceStepLike } from "../plugins/types";
import { inspect, buildManifest, slugify, type Manifest, type Validation } from "./validate";
import { asFound, autoOf, importStart, launchLine, manifestLaunch, manifestMeta, notAppliedWords, type LaunchAuto } from "../library/launch";
import { dropLinks, linksDropped, scan, snapshot, type Snapshot } from "./classify";
import { rootFolderFor, rootFolders, workDirFor } from "../library/rootfolders";
import { record } from "../library/history";
import { jobKinds, lockKeyOf, type KindContext, type KindDef } from "./kinds";
import { clearInterruptedWork, hasCheckpoints } from "./checkpoint";
import { db, busyDatabase, recordWhenAvailable } from "../db";
import { keepUnpacked } from "../ways/unpack-cache";
import { keepFreeBytes } from "../ways/content";
import { EnvError, failOf } from "../ways/errors";
import { forgetPlaced } from "../ways/program";
import { releaseSandboxUser, spareJobFolder, stopUnder, sweepJobFolders, takeSandboxUser } from "../ways/sandbox";
import { unbuildWays, wstmts } from "../ways/store";
import type { FailInfo, JobKind, JobSpec } from "../ways/types";
import { confirmingRun, messageOf, placeOf, rmdeps as remoteDeps, rootDown, rootOf, rootState, syncedRoot, transportTrouble, unwatchJob, verdictOf, watchJob, watchPath, type Watch } from "../remote";
import { arrivedWeight } from "../arrivals";

export { pdeps };

/**
 * Why a job that read the seedbox's mapped folder failed (src/remote.ts): when the folder was troubled while it ran (it does
 * not answer, it was remounted, a trouble was logged, the job's own error is the read path's, a file it could not find is
 * there, the download lost files meanwhile), the failure says nothing of the copy — 'env'/'remote', with the folder's words
 * first — whatever the error's own type; otherwise the job's own class, with what its end says of the input (missing, a child
 * program's words worth one confirming re-run) for the request. Its own end is kept either way (remote.ended).
 */
async function judgedFail(id: number, e: unknown, w: Watch | null, msg: string): Promise<{ fail: FailInfo; msg: string; transient: boolean }> {
  const own = failOf(e);
  if (!w) return { fail: own, msg, transient: false };
  const v = await verdictOf(w, e).catch(() => null);
  if (!v) return { fail: own, msg, transient: false };
  const ev = { ...v, ended: msg.slice(0, 400), ...(confirmingRun(id) ? { confirmed: true } : {}) };
  if (v.troubled) return { fail: { class: "env", kind: "remote", remote: ev }, msg: `${v.words} (it ended: ${msg})`, transient: true };
  return { fail: { ...own, remote: ev }, msg, transient: false };
}

/** where a queued job reads from: an import's download, a content or make job's path (null: nothing on disk, a sentinel) */
function inputOf(j: JobRow): string | null {
  if (kindOf(j) === "import") return j.input_path;
  try { const s = JSON.parse(j.spec_json ?? "null") as { path?: unknown } | null; return typeof s?.path === "string" ? s.path : null; } catch { return null; }
}

/** swappable in tests */
export const rdeps = {
  importers: (): { impl: string; name: string; importer: Importer }[] => registry.importers().map(x => ({ impl: x.row.impl, name: x.row.name, importer: x.importer })),
  /** the first look at an import's input (there, or why not: its own error) */
  statInput: (path: string) => stat(path),
  /** a finished folder renamed into place (a test makes it fail, as it does across volumes) */
  rename: (from: string, to: string) => rename(from, to),
  /** the build user a job's programs run as while it runs (null: none is free, the job waits), and giving it back */
  takeSandboxUser: (jobId: number): { user: string; uid: number } | null => takeSandboxUser(jobId),
  releaseSandboxUser: (jobId: number): void => releaseSandboxUser(jobId),
};

export type Lane = "import" | "ways" | "intake" | "long" | "ai";
const LANES: Lane[] = ["import", "ways", "intake", "long", "ai"];
const running = new Map<number, AbortController>();
/** which lane each running job counts against */
const lanes = new Map<number, Lane>();
/** what each running job of another kind holds (kinds.ts lockKeyOf): two jobs with one key never run at once */
const locks = new Map<number, string>();
/** the build user each job of another kind runs its programs as: taken when processTick lets it in, given back at its end */
const users = new Map<number, { user: string; uid: number }>();
/** who asked a running job to stop (the first to ask is the one recorded) */
const stopper = new Map<number, NonNullable<FailInfo["by"]>>();
/** scratch bytes each running import may still take (released once its scratch folder is gone) */
const reserved = new Map<number, number>();
/** the scratch a job was weighed with when processTick let it in: reserved the moment it starts, so the next job in
 *  the queue is weighed against it (an import refines it once it has looked at its input) */
const planned = new Map<number, number>();
export const activeJobs = () => running.size;
/** is job `id` running in this process now (what a sweep of the jobs' leftover folders must leave alone) */
export const jobRunning = (id: number): boolean => running.has(id);
export const jobNeedsWork = (id: number) => jobRunning(id) || ["queued", "running"].includes((stmts.jobById.get(id) as JobRow | undefined)?.state ?? "");
const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
/** what an import may need in scratch: the download unpacked, the disc moved aside, the install — three times the input, 2 GB at least */
export const scratchNeeded = (inputBytes: number) => Math.max(2e9, 3 * inputBytes);
/** what a job of another kind needs in scratch unless its kind says otherwise */
export const KIND_SCRATCH = 2e9;
const kindOf = (j: Pick<JobRow, "kind">): JobKind => ((j.kind ?? "import") as JobKind);
/** a build job's way (a program built for one game), from its spec */
function buildsForWay(j: Pick<JobRow, "spec_json">): boolean {
  try { const id = Number(JSON.parse(j.spec_json ?? "null")?.wayId); return Number.isInteger(id) && id > 0; } catch { return false; }
}
/** the lane a job runs in (see the file header) */
export function laneOf(j: Pick<JobRow, "kind" | "spec_json">): Lane {
  switch (kindOf(j)) {
    case "import": return "import";
    case "construct": return "ai";
    case "content": return "intake";
    case "make": return "long";
    case "build": return buildsForWay(j) ? "long" : "ways";
    default: return "ways";
  }
}
/** how many game files may be taken in side by side (INTAKE_PARALLEL: downloads, the game's copy, inbox entries) */
export const intakeCap = (): number => Math.max(1, Math.floor(cfgNum("INTAKE_PARALLEL", 1)));
/** how many long game-data jobs may run side by side (LONG_PARALLEL: makes, programs built for one game) */
export const longCap = (): number => Math.max(1, Math.floor(cfgNum("LONG_PARALLEL", 1)));
/** how many jobs each lane runs at once, as the settings say now (read on every tick: a change counts at once) */
export const laneCaps = (): Record<Lane, number> => ({
  import: cfgNum("IMPORT_PARALLEL", 1), ways: cfgNum("WAYS_PARALLEL", 1), intake: intakeCap(), long: longCap(), ai: 1,
});
/** the kinds that write game data where the library is: they wait while what LIBRARY_KEEP_FREE_GB keeps free would not be */
const KEEPS_FREE = new Set<JobKind>(["assemble", "build", "make", "content"]);

/** what a kind's module does when a job of that kind is cancelled before it ever ran (assemble puts its way back) */
export const cancelHooks = new Map<Exclude<JobKind, "import">, (job: JobRow) => void>();

/** why a job ended badly, on its row (written before the 'job' event that says it ended, so a reader of that event sees it) */
function recordFail(id: number, fail: FailInfo) {
  try { stmts.setJobFail.run(JSON.stringify(fail), id); } catch { /* recording never stops a job */ }
}

/**
 * Stop a job: a running one is aborted (it ends as 'cancelled'), a queued one is marked cancelled (with `message`) and
 * never starts. Returns whether there was anything to stop. `by` says who stopped it — the admin (the activity and job
 * routes), a carry run (stopping itself), ludarr itself — and goes into the job's FailInfo; when several ask, the first
 * is the one recorded.
 */
export function cancelJob(id: number, message = "cancelled", by: NonNullable<FailInfo["by"]> = "system"): boolean {
  const ac = running.get(id);
  if (ac) { if (!stopper.has(id)) stopper.set(id, by); ac.abort(); return true; }
  const j = stmts.jobById.get(id) as JobRow | undefined;
  if (j?.state !== "queued") return false;
  recordFail(id, { class: "cancelled", by });
  stmts.setJobFailed.run("cancelled", message, id);
  events.emit("job", serializeJob(stmts.jobById.get(id) as JobRow));
  const kind = kindOf(j);
  if (kind !== "import") { try { cancelHooks.get(kind)?.(j); } catch { /* the job is cancelled either way */ } }
  return true;
}

/**
 * A finished folder moved to `to`, which must not be there yet: a package never moves into another folder. When a rename
 * cannot do it (another volume, a file inside held open), a copy into a folder made for it, entry by entry, never merged
 * into one that exists. The folder itself is never cp's target: Bun's cp refuses any folder that is there, even the
 * empty one just made for it.
 */
export async function moveDir(from: string, to: string, jobId?: number) {
  if (await lstat(to).catch(() => null)) throw new Error(`${to} is already there: a package only moves into a folder of its own`);
  try { await rdeps.rename(from, to); return; } catch { /* another volume, or something holds a file open: copy instead */ }
  const parent = join(dirname(to), ".ludarr-publish");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (!(await lstat(parent)).isDirectory()) throw new Error("invalid package transfer folder");
  const incoming = join(parent, jobId == null ? crypto.randomUUID() : "job-" + jobId);
  if (await lstat(incoming).catch(() => null)) await removeTree(incoming);
  await mkdir(incoming);
  try {
    for (const name of await readdir(from)) await cp(join(from, name), join(incoming, name), { recursive: true, errorOnExist: true, force: false });
    if (await lstat(to).catch(() => null)) throw new Error(`${to} is already there`);
    await rename(incoming, to);
  } catch (e) { await removeTree(incoming).catch(() => {}); throw e; }
  await removeTree(from).catch(() => { /* a read-only source (a mounted client folder) stays: its client owns it */ });
}
/** whether a package row other than the ones named records this folder (a row keeps its folder's name until a rescan, even
 *  once the folder was deleted by hand) */
function folderRecorded(path: string, ...except: (number | null | undefined)[]): boolean {
  const p = resolve(path);
  return (stmts.packagesAll.all() as PackageRow[]).some(r => !except.includes(r.id) && resolve(r.path) === p);
}
/** only what ludarr pulled into its own downloads folder is deleted after import; a mounted client folder is the client's.
 *  The downloads folder itself is no download: removing it would take every other download with it */
export const ownsDownload = (input: string, downloads: string) => { const a = resolve(input), b = resolve(downloads); return a !== b && a.startsWith(b.endsWith(sep) ? b : b + sep); };

/**
 * The transcript and the trace of a job, flushed to its row at most every two seconds. The job's end is announced with
 * both written in full (`end`, right before the row says done or failed: a page that is showing the job reads it once
 * then), and what is written after that (the hand-off, the download's removal, the scratch folder) goes out with one more
 * 'job' event once the job has let go of everything (`settled`).
 */
function recorder(id: number, transcript: string | null) {
  const lines: string[] = transcript ? [transcript.trimEnd()] : [];
  let lastFlush = 0;
  const flush = (force = false) => {
    if (!force && Date.now() - lastFlush < 2000) return;
    if (recordWhenAvailable(() => { stmts.setJobTranscript.run(lines.join("\n") + "\n", id); })) lastFlush = Date.now();
  };
  const trace: TraceStepLike[] = [];
  let lastTrace = 0;
  const flushTrace = (force = false) => {
    if (!trace.length || (!force && Date.now() - lastTrace < 2000)) return;
    lastTrace = Date.now();
    try { stmts.setJobTrace.run(JSON.stringify(trace), id); } catch { /* recording never stops a job */ }
  };
  const log = (s: string) => { lines.push(`${new Date().toISOString().slice(11, 19)} ${s}`); pdeps.log(`#${id} ${s}`); flush(); };
  const written = () => lines.length + trace.length;
  let atEnd = -1;
  const end = () => { flush(true); flushTrace(true); atEnd = written(); };
  const settled = () => {
    flush(true); flushTrace(true);
    if (atEnd < 0 || written() === atEnd) return;
    const row = stmts.jobById.get(id) as JobRow | undefined;
    if (row) events.emit("job", serializeJob(row));
  };
  return { log, flush, trace, flushTrace, end, settled };
}

const WAY_KINDS = new Set(["recomp", "port", "emulated"]);
/** the manifest kind of a stored package ('native' for imports from before kinds existed) */
export function packageKind(p: Pick<PackageRow, "manifest_json">): string {
  try { return String(JSON.parse(p.manifest_json)?.kind ?? "native"); } catch { return "native"; }
}
/** may a new package of this origin replace the game's current one? (the reason when it may not) */
export function replaceRefusal(current: Pick<PackageRow, "manifest_json"> | null | undefined, by: "import" | "way", replace = false): string | null {
  if (!current || replace) return null;
  const k = packageKind(current);
  if (by === "import" && WAY_KINDS.has(k)) return "the game has a built way; replace it from the game page";
  if (by === "way" && k === "native") return "the game already has a PC copy; build with replace to swap it for this way";
  return null;
}

/** hooks the integrator wires around a package that has just been stored */
export const finalizeHooks = {
  /**
   * A console dump (manifest kind 'rom') was just imported for a game: src/ways/hooks.ts romHandOff hands it to the ways
   * of the game it proves. It runs after the import is done (the game plays from then on), so its progress (bytes of the
   * whole as the dump is read or linked) goes out as the job's live progress without touching the done row. Errors are
   * logged, never fail the import.
   */
  romImported: async (_o: { gameId: number; pkg: PackageRow; manifest: Manifest; log: (line: string) => void; progress?: (p: number, message: string) => void }): Promise<void> => {},
};

export interface FinalizeOpts {
  jobId: number;
  gameId: number | null;
  root: RootFolderRow;
  slug: string;
  name: string;
  version: string | null;
  /** the verified folder that becomes the package (moved, not copied, when it is on the same volume) */
  from: string;
  manifest: Manifest;
  /** an import of a download, or a way built from a plan: they replace different things (replaceRefusal) */
  by: "import" | "way";
  replace?: boolean;
  log: (line: string) => void;
  /** the start the job found before a start set by hand took its place (src/library/launch.ts: what Reset gives back);
   *  absent: the manifest's own */
  launchAuto?: LaunchAuto;
}

/**
 * The verified folder becomes the game's one package: <root>/<slug> (or <slug>-<job>, then <slug>-<job>-1 … while that
 * is taken: never a folder that is already there or that another package row records, which can be another game's),
 * ahoy.json beside the files, a packages row (with the start the job found, for Reset: src/library/launch.ts), the game's
 * path. The package it replaces is deleted (row and folder, unless another row records that folder too) and the ways that
 * had built it settle again.
 * Refused — before anything moves — when the replacement policy says no; a folder nothing could record is removed again.
 */
type Publication = { options: Omit<FinalizeOpts, "log">; final: string; token: string; previousId: number | null };

export async function finalizePackage(o: FinalizeOpts, saved?: Publication): Promise<{ pkg: PackageRow; final: string; previous: PackageRow | null }> {
  const previous = o.gameId ? ((stmts.packageForGame.get(o.gameId) as PackageRow | undefined) ?? null) : null;
  const refusal = replaceRefusal(previous, o.by, o.replace);
  if (refusal) throw new Error(refusal);
  const lib = resolve(o.root.path);
  await mkdir(lib, { recursive: true });
  let final = join(lib, o.slug);
  // a name is taken while a folder holds it, and while another package row records it (its folder deleted by hand, no
  // rescan yet): that row's next import would remove the folder of that name as its previous copy
  if (saved) {
    final = saved.final;
    if (saved.previousId !== (previous?.id ?? null)) throw new Error("the game's published copy changed during the interrupted transfer");
  } else {
    for (let n = 0; (await lstat(final).catch(() => null)) || folderRecorded(final, previous?.id); n++) final = join(lib, `${o.slug}-${o.jobId}${n ? `-${n}` : ""}`);
    const { log, ...options } = o;
    saved = { options, final, token: crypto.randomUUID(), previousId: previous?.id ?? null };
    db.query("UPDATE jobs SET publication_json=? WHERE id=?").run(JSON.stringify(saved), o.jobId);
  }
  const marker = ".ludarr-transfer-" + saved.token;
  const oldMarker = formerName(marker);                                          // an import interrupted before the engine was renamed
  const landed = (await lstat(join(final, marker)).catch(() => null))?.isFile() === true || (await lstat(join(final, oldMarker)).catch(() => null))?.isFile() === true;
  if (!landed) {
    const mark = join(o.from, marker);
    if (!(await lstat(mark).catch(() => null))) await writeFile(mark, "", { flag: "wx" });
    await moveDir(o.from, final, o.jobId);
  }
  let pkg: PackageRow, unbuilt = 0;
  try {
    // a file of its own, never written through what is there: a file ludarr placed by a hard link is the content store's
    // own file, and a write through it would replace the kept game data with the manifest
    const at = join(final, "ahoy.json");
    await rm(at, { force: true });
    await writeFile(at, JSON.stringify(o.manifest, null, 2), { flag: "wx" });
    const recordPackage = db.transaction(() => {
      const row = stmts.insertPackage.get(o.gameId, o.jobId, final, o.name, o.version, o.manifest.totalSize, JSON.stringify(o.manifest)) as PackageRow;
      stmts.setPackageLaunchAuto.run(JSON.stringify(o.launchAuto ?? autoOf({ launch_auto_json: null }, o.manifest)), row.id);
      if (o.gameId) stmts.setGamePath.run(final, o.gameId);
      if (previous) {
        unbuilt = unbuildWays(previous.id, "its package was replaced").length;
        stmts.deletePackage.run(previous.id);
      }
      db.query("UPDATE jobs SET publication_json=NULL WHERE id=?").run(o.jobId);
      return stmts.packageById.get(row.id) as PackageRow;
    });
    for (;;) {
      try { pkg = recordPackage.immediate(); break; }
      catch (e) {
        if (!busyDatabase(e)) throw e;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (e) {
    // nothing records this folder (its game was deleted meanwhile, say): it goes rather than stay in the library unmapped
    const left = await removeTree(final).catch(() => [final]);
    if (left.length) o.log(`could not remove ${final} after the failure: ${left.length} entries still held open`);
    throw e;
  }
  await rm(join(final, marker), { force: true }).catch(() => {});
  await rm(join(final, oldMarker), { force: true }).catch(() => {});
  if (previous) {
    if (unbuilt) o.log(`${unbuilt} way${unbuilt === 1 ? "" : "s"} to play built the replaced copy: no longer built`);
    // one copy per game: the previous one goes (an upgrade, a hand import over an old copy, a way over a dump); a row
    // whose folder was already gone from disk only loses its row — the folder of that name is the new package now
    // rows from before a recorded name counted as taken can share one folder: another package's folder is never removed
    if (previous.path !== final && folderRecorded(previous.path, previous.id)) o.log(`previous copy's folder ${previous.path} is another package's too: left in place`);
    else if (previous.path !== final) await removeTree(previous.path).then(left => o.log(left.length ? `previous copy ${previous.path} only partly removed: ${left.length} entries still held open` : `previous copy removed: ${previous.path}`), e => o.log(`could not remove the previous copy ${previous.path}: ${e?.message ?? e}`));
    events.emit("package", { id: previous.id, deleted: true });
  }
  events.emit("package", serializePackage(pkg));
  return { pkg, final, previous };
}

async function finishTransfer(row: JobRow, log: (line: string) => void): Promise<boolean> {
  if (!row.publication_json) return false;
  const saved: Publication = JSON.parse(row.publication_json);
  log("resuming publication of the verified game to its library");
  await finalizePackage({ ...saved.options, log }, saved);
  reconcilePublished(row);
  events.emit("job", serializeJob(stmts.jobById.get(row.id) as JobRow));
  return true;
}

export async function runJob(id: number): Promise<void> {
  const row = stmts.jobById.get(id) as JobRow | undefined;
  if (!row || row.state !== "queued") {
    planned.delete(id);
    if (users.delete(id)) giveBack(id);                                      // let in, then cancelled before it started
    return;
  }
  if (kindOf(row) !== "import") return runKindJob(row);
  const ac = new AbortController();
  running.set(id, ac);
  lanes.set(id, "import");
  reserved.set(id, planned.get(id) ?? 0);
  planned.delete(id);
  const { log, trace, flushTrace, end, settled } = recorder(id, row.transcript);
  let tier = "deterministic";
  let last = { at: 0, progress: -1, message: "" };
  const set = (progress: number, message: string) => {
    const p = Math.min(1, progress);
    const now = Date.now();
    if (message === last.message && Math.abs(p - last.progress) < 0.005 && now - last.at < 1000) return;
    if (!recordWhenAvailable(() => { stmts.setJob.run("running", tier, p, message, id); })) return;
    last = { at: now, progress: p, message };
    events.emit("job", serializeJob(stmts.jobById.get(id) as JobRow));
  };
  const input = row.input_path;
  const game = row.game_id ? (stmts.gameById.get(row.game_id) as GameRow | undefined) : undefined;
  const root = rootFolderFor(game);
  const work = root ? join(workDirFor(root), `job-${id}`) : "";
  const staging = join(work, "staging");
  // nothing an importer started may outlive the job: a forgotten Xvfb or wine helper keeps files open, and an open file
  // on a FUSE share (Unraid's user shares) cannot be removed — so first the processes, then one bounded pass over the tree
  const reap = async (when: string) => {
    if (!work) return;
    const pids = await reapUnder(work).catch(() => [] as number[]);
    if (pids.length) log(`stopped ${pids.length} process(es) still running in the scratch folder ${when}: ${pids.join(", ")}`);
  };
  let resumeAfterLock = false;
  const scrub = async () => {
    if (!work) return;
    await reap("at the end");
    const left = await removeTree(work).catch(() => [work]);
    if (left.length) log(`scratch folder not fully removed — ${left.length} entr${left.length === 1 ? "y is" : "ies are"} still held open (${basename(left[0])}); it is cleared on the next start`);
  };
  // upload: the input is what the admin uploaded for the game (src/uploads.ts), which removes it once this job is done
  let spec: { replace?: boolean; upload?: number; earlier?: boolean } | null = null;
  try { spec = row.spec_json ? JSON.parse(row.spec_json) : null; } catch { /* an import without a spec */ }
  const replace = spec?.replace === true;

  // a download read from the seedbox's mapped folder: the folder is watched from here, so a failure is judged against it
  let remoteWatch: Watch | null = null;
  try {
    stmts.setJob.run("running", tier, 0.02, "looking at what landed", id);
    if (await finishTransfer(row, log)) return;
    set(0.02, "looking at what landed");
    remoteWatch = await watchPath(input).catch(() => null);
    watchJob(id, remoteWatch);
    if (!root) throw new Error("no root folder — add one under Settings → Media management");
    // a look the read path failed (EIO, a timeout, a stale handle on the seedbox's folder) is no "gone": it throws with its
    // code, and the job is judged against the folder
    if (!(await rdeps.statInput(input).catch(e => { if (transportTrouble(e, { words: false })) throw e; return null; }))) throw new Error(`input is gone: ${input}`);
    // a game whose copy is a built way keeps it: an import would only replace it when asked to (from the game page)
    const current = row.game_id ? (stmts.packageForGame.get(row.game_id) as PackageRow | undefined) : undefined;
    const refusal = replaceRefusal(current, "import", replace);
    if (refusal) throw new Error(refusal);
    const fetchRow = row.fetch_id ? (stmts.fetchById.get(row.fetch_id) as FetchRow | undefined) : undefined;
    let release: any = null;
    try { release = fetchRow?.release_json ? JSON.parse(fetchRow.release_json) : null; } catch { /* ignore */ }
    const releaseTitle: string = release?.title ?? fetchRow?.title ?? basename(input);
    const parsed = parseTitle(releaseTitle);
    const name = game?.name ?? releaseTitle;
    const slug = game?.slug || slugify(name);
    // a copy the admin uploaded says so in its manifest (protocol 'upload'): no search replaces it by itself (src/library/profiles.ts)
    const source = { title: releaseTitle, group: parsed.group, protocol: fetchRow?.protocol ?? (spec?.upload != null ? "upload" : null), indexer: fetchRow?.indexer ?? null };
    // a console dump is what the RELEASE said it was (a PC port of a console game is a PC game): unpacked as it is, never installed, never handed to the AI importer.
    // The game's own consoles only matter when a PC import finds nothing to launch — a dump for one of them is then kept as it is.
    let gamePlats: string[] = []; try { gamePlats = JSON.parse(game?.platforms_json ?? "[]"); } catch { /* none */ }
    const relPlatform = (release?.flags?.platform ?? null) as PlatformId | null;
    const romPlatform: PlatformId | null = isConsole(relPlatform) ? relPlatform : null;
    const consoles = consolePlatforms(gamePlats);
    if (romPlatform) log(`console dump (${romPlatform}): it will be unpacked as it is`);
    let pkgPlatform: string | null = romPlatform;
    const tools = pdeps.tools();
    const fingerprint: Record<string, unknown> = { release: { ...source, size: release?.size ?? null }, input: await snapshot(input).catch(() => null), importers: [] as unknown[] };
    const saveFingerprint = () => { try { stmts.setJobFingerprint.run(JSON.stringify(fingerprint), id); } catch { /* recording never stops a job */ } };
    saveFingerprint();
    // what the download weighed when the import began: one that loses files while it is read (the hourly move out of
    // complete/ deleting each volume it copied) is the seedbox's trouble, never the copy's
    const startWeight = fingerprint.input as Snapshot | null;
    if (remoteWatch && startWeight) remoteWatch.start = { files: startWeight.files, bytes: startWeight.bytes };
    // a download in the finished-downloads folder (src/arrivals.ts) is weighed as its arrival weighed it (the sync's part files never
    // count), and what it was when it was taken is the measure: the import never runs on less (the folder's cleanup took files
    // meanwhile — lost, never the copy's) nor on more (the sync was still bringing it — awaited again)
    if (remoteWatch && syncedRoot(input)) {
      const fetch = row.fetch_id ? (stmts.fetchById.get(row.fetch_id) as FetchRow | undefined) : undefined;
      const got = arrivedWeight(fetch, input);
      const now = await remoteDeps.weigh(input).catch(() => null);
      remoteWatch.start = got ?? now ?? remoteWatch.start;
      if (got && now && (now.files < got.files || now.bytes < got.bytes))
        throw new EnvError("remote", `${basename(input)} lost files in the finished-downloads folder before its import began (${now.files} of its ${got.files} files): did its cleanup take them?`);
      if (got && now && (now.files > got.files || now.bytes > got.bytes))
        throw new EnvError("remote", `more of ${basename(input)} arrived in the finished-downloads folder after it was taken (${now.files} files now, ${got.files} then): the sync was still bringing it`);
    }
    // the confirming re-run of a wait (a child program's I/O words met once already): what the importers say is taken as it is
    const confirming = !!remoteWatch && confirmingRun(id);
    log(`import for "${name}" from ${releaseTitle}`);
    log(`toolbox: ${describeToolbox(tools)}`);
    if (row.transcript) { await reap("before resuming"); await clearInterruptedWork(work); }
    await mkdir(staging, { recursive: true });

    // importers say what they do but not how far along they are: show the step and the bytes written so far
    let doing = "unpacking", busy = false, watching = true;
    const inputBytes = (fingerprint.input as Snapshot | null)?.bytes ?? 0;
    reserved.set(id, scratchNeeded(inputBytes));
    const watch = setInterval(async () => {
      if (busy || !watching) return;
      busy = true;
      try {
        const { files } = await scan(work, 200_000).catch(() => ({ files: [] as { size: number }[] }));
        const written = files.reduce((a, f) => a + f.size, 0);
        if (written > 0 && watching && tier !== "agent") set(0.02 + 0.45 * (1 - Math.exp(-written / Math.max(1, inputBytes))), `${doing} · ${(written / 1e9).toFixed(1)} GB so far`);
      } finally { busy = false; }
    }, 10_000);
    const importLog = (line: string) => { log(line); if (/\bwine\b/i.test(line)) doing = "running the installer"; else if (/innoextract/i.test(line)) doing = "unpacking the installer"; else if (/extract|unpack|7z|unar|unrar/i.test(line)) doing = "unpacking"; };

    const chain = rdeps.importers();
    if (!chain.length) throw new Error("no importer is enabled — turn one on under Settings → Importers");
    const previous: ImportContext["previous"] = [];
    let result: ImportResult | null = null;
    let version: string | null = parsed.version ?? (/(?:^|[_.\s(-])v?(\d+\.\d+(?:\.\d+){0,3})(?=[_\s)-]|\.(?:exe|zip|7z|rar)$)/i.exec(basename(input))?.[1] ?? null);
    let skippedAgent = false;
    try {
      for (const imp of chain) {
        if (imp.impl === "agent" && romPlatform) continue;                  // nothing to install: the AI importer has no job here
        const ctx: ImportContext = {
          input, staging, work, gameName: name, releaseTitle, group: parsed.group, log: importLog, platform: romPlatform, consoles,
          progress: (p, m) => set(0.02 + p * 0.5, m), signal: ac.signal, previous, trace: step => { trace.push(step); flushTrace(); },
        };
        if (!(await imp.importer.probe(ctx))) { if (imp.impl === "agent") skippedAgent = true; continue; }
        tier = imp.impl === "agent" ? "agent" : "deterministic";
        if (imp.impl === "agent") set(0.55, "the AI importer is working on it");
        let r: ImportResult;
        try { r = await imp.importer.run(ctx); }
        catch (e) {
          // an importer that threw stops like one that gave up — the next one (the AI importer, or the hold for its key) takes
          // over — unless the job is cancelled, or the seedbox's folder was troubled or lost the input: then the job ends
          // here and is judged against the folder (a second importer would only read the same troubled folder)
          if (ac.signal.aborted) throw e;
          if (remoteWatch) { const v = await verdictOf(remoteWatch, e).catch(() => null); if (!v || v.troubled || v.absent || (v.io && !confirming)) throw e; }
          r = { ok: false, shape: "unknown", reason: messageOf(e) };
        }
        (fingerprint.importers as unknown[]).push({ importer: imp.impl, ok: r.ok, shape: r.shape, stopped: r.reason, steps: r.steps ?? [] });
        if (r.ok && r.platform) pkgPlatform = r.platform;
        if (r.lesson) stmts.setJobLesson.run(JSON.stringify(r.lesson), id);
        saveFingerprint();
        if (r.ok) { result = r; break; }
        log(`${imp.name} stopped: ${r.reason}`);
        // stopped by the seedbox's folder (troubled while it read, or the input gone from it), or on words that may be a failed
        // read of it (a read error, a timeout, an unexpected end) the first time: the job ends here and is judged against the
        // folder — the next importer (the AI's, which costs) would only read the same folder; the confirming re-run goes on
        if (remoteWatch) { const v = await verdictOf(remoteWatch, new Error(r.reason ?? "")).catch(() => null); if (v?.troubled || v?.absent || (v?.io && !confirming)) throw new Error(r.reason ?? `${imp.name} stopped`); }
        previous.push({ importer: imp.impl, shape: r.shape, problems: r.validation?.problems ?? [r.reason ?? "unknown"] });
        if (!fingerprint.handedOver) { fingerprint.handedOver = await snapshot(staging).catch(() => null); saveFingerprint(); }
        if (ac.signal.aborted) throw new Error("cancelled");
      }
    } finally { watching = false; clearInterval(watch); flushTrace(true); }
    await reap("after the importers");
    if (!result) {
      const why = previous.at(-1)?.problems.join("; ") ?? "no importer could handle it";
      throw new Error(skippedAgent ? `${why} — the AI importer could take over once it has an API key` : why);
    }
    // read from the finished-downloads folder: an import that went through while its input lost files (the folder's cleanup) or gained some
    // (the sync still bringing it) was made from less than the download — judged against the folder, never kept
    if (remoteWatch?.start && syncedRoot(input)) {
      const was = remoteWatch.start, left = await remoteDeps.weigh(input).catch(() => null);
      if (left && (left.files !== was.files || left.bytes !== was.bytes))
        throw new EnvError("remote", left.files < was.files || left.bytes < was.bytes
          ? `${basename(input)} lost files in the finished-downloads folder while it was being read (${left.files} of its ${was.files} files): did its cleanup take them?`
          : `more of ${basename(input)} arrived in the finished-downloads folder while it was being read (${left.files} files, ${was.files} when it began): the sync was still bringing it`);
    }

    // what becomes the package is files and folders, nothing else: the staging folder must still be the folder made for
    // this job (an installer, or the AI importer's shell, could have left a link in its place), and a link inside it is
    // removed — no manifest lists one, and the folder moves into the library as it stands
    if (!(await lstat(staging).catch(() => null))?.isDirectory()) throw new Error("the importer left a link (or nothing) where its staging folder was");
    const links = await dropLinks(staging);
    if (links.length) log(linksDropped(links));

    let validation: Validation | null = result.validation ?? null;
    if (!validation?.ok) validation = await inspect(staging, { name, launchExe: result.launchExe ?? null });
    if (!validation.ok) throw new Error(`${tier === "agent" ? "the AI importer" : "the importer"} reported success but the validator disagrees: ${validation.problems.join("; ")}`);
    version = result.version ?? version;

    // how the game's PC copies start when it was set by hand (src/library/launch.ts): taken when its program is in this copy
    const hand = pkgPlatform ? null : await importStart(row.game_id, validation.root);
    const used = hand && "start" in hand ? hand.start : null;
    const notApplied = hand && "why" in hand ? notAppliedWords(hand.choice, hand.why, { exe: validation.launch!, argv: [] }, asFound(tier === "agent" ? "ai" : "ludarr")) : null;
    if (notApplied) log(notApplied);
    if (!used && validation.launch && validation.launchWhy) log(`launch ${validation.launch}: ${validation.launchWhy}`);   // why ludarr picked that program
    set(0.86, "verifying files");
    // each file's block hashes come out of the same read (src/blocks.ts): the package can be sent as blocks at once
    const blockHashes = new Map<string, Uint8Array>();
    const manifest = await buildManifest(used ? { ...validation, launch: used.exe } : validation, { name, slug, version, source, tier: tier as "deterministic" | "agent", notes: result.notes ?? null, kind: pkgPlatform ? "rom" : "native", platform: pkgPlatform, ...(used ? manifestMeta(used, null) : {}) }, (d, t) => set(0.86 + 0.12 * (t ? d / t : 1), "verifying files"), { blocks: blockHashes });
    if (used && hand) manifest.launch = { ...manifest.launch, rev: hand.choice.at };
    set(0.99, "moving into the root folder");
    const { pkg, final, previous: previousPkg } = await finalizePackage({ jobId: id, gameId: row.game_id, root, slug, name, version, from: validation.root, manifest, by: "import", replace, log, ...(used ? { launchAuto: { launch: manifestLaunch({ exe: validation.launch! }), requires: null } } : {}) });
    // when a file's hashes are missing or a file moved differently than it was read, the task `blocks` builds the index later
    await writeIndex(pkg, path => blockHashes.get(path)).then(r => { if (r) log(`${r.blocks} blocks indexed: launchers take this copy in a few requests`); }, e => log(`the block index was not written (${e?.message ?? e}): it is built in the background`));
    const summary = `ready: ${manifest.files.length} files, ${(manifest.totalSize / 1e9).toFixed(2)} GB, launch ${launchLine(manifest.launch)}${used ? " (set by hand)" : ""}${tier === "agent" ? " (AI importer)" : ""}`;
    log(summary);
    end();
    stmts.setJobDone.run(summary, final, JSON.stringify(manifest), id);
    if (row.fetch_id && !spec?.earlier) stmts.setFetchImported.run(row.fetch_id);                 // from here the seeding task looks after the download
    events.emit("job", serializeJob(stmts.jobById.get(id) as JobRow));
    record(row.game_id, previousPkg ? "upgraded" : "imported", { gameName: name, release: releaseTitle, source: tier === "agent" ? "AI importer" : "recipes", message: summary, data: { packageId: pkg.id, path: final, size: manifest.totalSize } });
    if (notApplied) record(row.game_id, "edited", { gameName: name, release: releaseTitle, source: "import", message: notApplied, data: { packageId: pkg.id } });
    if (manifest.kind === "rom" && row.game_id) {
      // the import is done and the row says so: the hand-off's bytes go out as live 'build' ticks of the job (at most one a
      // second), and one 'job' event with the row as it is once it is over
      let told = 0, ticks = 0;
      const progress = (p: number, message: string) => {
        if (Date.now() - told < 1000) return;
        told = Date.now(); ticks++;
        const done = stmts.jobById.get(id) as JobRow | undefined;
        if (done) events.emit("build", { ...serializeJob(done), progress: Math.max(0, Math.min(1, p)), message: `handing the dump to a way to play: ${message}` });
      };
      await finalizeHooks.romImported({ gameId: row.game_id, pkg, manifest, log, progress }).catch(e => log(`handing the dump to a way to play failed: ${e?.message ?? e}`));
      if (ticks) events.emit("job", serializeJob(stmts.jobById.get(id) as JobRow));
    }
    if (spec?.earlier) log("the download was selected for reuse and stays in place");
    else if (syncedRoot(input)) log("download left in place for now: it is in the finished-downloads folder — once its search is done with it and the copy checks out, ludarr deletes the files it took there that its download client listed as this download's");
    else if (spec?.upload != null) log("the upload's own files are removed now: the game is in the library");
    else if (!ownsDownload(input, downloadsDir())) log("download left in place: it is the client's folder, not ludarr's");
    else if (!cfgBool("IMPORT_KEEP_DOWNLOAD")) { const left = await removeTree(input).catch(e => { log(`could not remove the download: ${e?.message ?? e}`); return [] as string[]; }); log(left.length ? `raw download only partly removed (${left.length} entries still held open)` : "raw download removed"); }
  } catch (e: any) {
    if (busyDatabase(e) && !ac.signal.aborted) { resumeAfterLock = true; throw e; }
    const cancelled = ac.signal.aborted;
    let msg = cancelled ? "cancelled" : String(e?.message ?? e);
    log(`${cancelled ? "cancelled" : "failed"}: ${msg}`);
    // read from the seedbox's folder: judged against it — a troubled folder is the seedbox's trouble, not the copy's
    const judged = cancelled ? null : await judgedFail(id, e, remoteWatch, msg);
    if (judged?.transient) { msg = judged.msg; log(`the seedbox, not the copy: ${msg}`); }
    end();
    recordFail(id, cancelled ? { class: "cancelled", by: stopper.get(id) ?? "system" } : judged!.fail);
    stmts.setJobFailed.run(cancelled ? "cancelled" : "failed", msg, id);
    events.emit("job", serializeJob(stmts.jobById.get(id) as JobRow));
    if (!cancelled && !judged?.transient) record(row.game_id, "importFailed", { gameName: game?.name ?? null, release: basename(input), message: msg });
  } finally {
    running.delete(id);                     // first: a slow teardown must never hold the queue
    lanes.delete(id);
    stopper.delete(id);
    unwatchJob(id);
    if (!resumeAfterLock) await scrub();                          // scratch only — the download stays
    reserved.delete(id);                    // … and only now is its scratch space free for the next import
    settled();
  }
}

/** a queued job's message says why it waits (once: the row changes only when the words do) */
function waitingNote(j: JobRow, why: string) {
  if (j.message === why) return;
  stmts.setJob.run("queued", j.tier, 0, why, j.id);
  events.emit("job", serializeJob(stmts.jobById.get(j.id) as JobRow));
}
const NO_BUILD_USER = "waiting for a build user to be free (every one is running another job's programs)";
/** a build user for the job, or null (none free, or the pool could not say: the job waits for the next tick) */
function takeUser(id: number): { user: string; uid: number } | null {
  try { return rdeps.takeSandboxUser(id); }
  catch (e: any) { pdeps.log(`#${id} no build user could be taken: ${e?.message ?? e}`); return null; }
}
/** the job's build user back to the pool (a failure there never holds up the job's end) */
function giveBack(id: number) {
  try { rdeps.releaseSandboxUser(id); } catch (e: any) { pdeps.log(`#${id} its build user could not be given back: ${e?.message ?? e}`); }
}

/**
 * A job of another kind (src/process/kinds.ts): its kind's module runs it in a scratch folder of its own (staging
 * inside, <root>/.work/job-<id>: the sandbox finds the job's build user by that name), with a log, progress and an abort
 * signal, as the build user it was given. Nothing here looks at its input: it has none.
 */
async function runKindJob(row: JobRow): Promise<void> {
  const id = row.id;
  const kind = kindOf(row) as Exclude<JobKind, "import">;
  // the build user its programs run as: the one processTick took for it, or one now (a job run directly); none free → it
  // stays queued and the next tick tries again
  const user = users.get(id) ?? takeUser(id);
  users.delete(id);
  if (!user) { planned.delete(id); waitingNote(row, NO_BUILD_USER); return; }
  const ac = new AbortController();
  running.set(id, ac);
  lanes.set(id, laneOf(row));
  locks.set(id, lockKeyOf(row));
  reserved.set(id, planned.get(id) ?? KIND_SCRATCH);
  planned.delete(id);
  const { log, trace, flushTrace, end, settled } = recorder(id, row.transcript);
  // every kind starts deterministic; a construct job says when the AI takes over (ctx.tier), and its row says so from then
  let tier: "deterministic" | "agent" = "deterministic";
  let last = { at: 0, progress: -1, message: "" };
  const tick = (progress: number, message: string) => {
    const p = Math.max(0, Math.min(1, progress));
    const now = Date.now();
    if (message === last.message && Math.abs(p - last.progress) < 0.005 && now - last.at < 1000) return;
    if (!recordWhenAvailable(() => { stmts.setJob.run("running", tier, p, message, id); })) return;
    last = { at: now, progress: p, message };
    events.emit("build", serializeJob(stmts.jobById.get(id) as JobRow));
  };
  const game = row.game_id ? (stmts.gameById.get(row.game_id) as GameRow | undefined) : undefined;
  const root = rootFolderFor(game);
  const work = root ? join(workDirFor(root), `job-${id}`) : "";
  const staging = join(work, "staging");
  // the folder a make may also have had on the downloads folder's volume (its unpack, when the library lacked room)
  const spare = spareJobFolder(downloadsDir(), id);
  let retainExtraction = false;
  const preserve = async (dir: string) => {
    await keepUnpacked(dir).catch(e => log(`could not retain the completed extraction: ${e.message}`));
  };
  let resumeAfterLock = false;
  const scrub = async () => {
    if (!work) return;
    // what is left running is stopped first — by the paths it holds, and by the job's own build user (a container's root
    // cannot read a build user's folders, so the path alone misses those) — and only then is the folder removed, before
    // the user is given back
    const n = await stopUnder(work).catch(() => 0);
    if (n) log(`stopped ${n} process(es) still running in the scratch folder at the end`);
    if (retainExtraction) await preserve(work);
    const left = await removeTree(work).catch(() => [work]);
    if (left.length) log(`scratch folder not fully removed — ${left.length} entr${left.length === 1 ? "y is" : "ies are"} still held open (${basename(left[0])}); it is cleared on the next start`);
    if (await lstat(spare).catch(() => null)) {
      await stopUnder(spare).catch(() => 0);
      if (retainExtraction) await preserve(spare);
      const more = await removeTree(spare).catch(() => [spare]);
      if (more.length) log(`its folder on the downloads folder's volume was not fully removed (${more.length} entr${more.length === 1 ? "y" : "ies"} still held open); it goes with the next sweep`);
    }
  };
  // a job that reads the seedbox's mapped folder (a download taken in, game data made from one): watched from its start
  let remoteWatch: Watch | null = null;
  try {
    stmts.setJob.run("running", tier, 0.01, "starting", id);
    if (await finishTransfer(row, log)) return;
    last = { at: Date.now(), progress: 0.01, message: "starting" };
    events.emit("job", serializeJob(stmts.jobById.get(id) as JobRow));
    const def = jobKinds.get(kind);
    if (!def) throw new Error("this kind of job is not available");
    if (!root) throw new Error("no root folder — add one under Settings → Media management");
    let spec: JobSpec;
    try { spec = JSON.parse(row.spec_json ?? ""); } catch { throw new Error("the job does not say what to do (no spec)"); }
    if (!spec || typeof spec !== "object" || spec.kind !== kind) throw new Error("the job does not say what to do (no spec)");
    remoteWatch = await watchPath(inputOf(row), { weigh: true }).catch(() => null);
    watchJob(id, remoteWatch);
    if (kind === "content") {
      await preserve(work);
      await preserve(spare);
      if (await lstat(spare).catch(() => null)) await clearInterruptedWork(spare);
    }
    // a job resumed after a restart starts from an empty scratch folder: what its last start left there (an unpacked game
    // is 100,000 files, minutes on a share) is cleared saying so, never under a silent "starting"
    if (await lstat(work).catch(() => null)) {
      const t0 = Date.now(), words = "clearing what this job's last start left in its scratch folder";
      tick(0.01, words);
      const beat = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); tick(0.01, `${words} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`); }, 2000);
      try { await clearInterruptedWork(work); } finally { clearInterval(beat); }
    }
    await mkdir(staging, { recursive: true });
    const ctx: KindContext = {
      job: row, spec, work, staging, log, progress: (p, m) => tick(p, m ?? last.message), signal: ac.signal,
      trace: step => { trace.push(step as TraceStepLike); flushTrace(); },
      tier: t => {
        if (t === tier) return;
        tier = t;
        recordWhenAvailable(() => { stmts.setJob.run("running", tier, last.progress, last.message, id); });
        events.emit("build", serializeJob(stmts.jobById.get(id) as JobRow));
      },
    };
    // a kind that returns has finished its work (it watches the signal itself): a cancel that came too late to stop it
    // does not make a built package look cancelled
    const r = await def.run(ctx);
    const pkg = r.packageId ? (stmts.packageById.get(r.packageId) as PackageRow | undefined) : undefined;
    log(r.message);
    end();
    stmts.setJobDone.run(r.message, pkg?.path ?? null, pkg?.manifest_json ?? (r.manifest ? JSON.stringify(r.manifest) : null), id);
    events.emit("job", serializeJob(stmts.jobById.get(id) as JobRow));
  } catch (e: any) {
    if (busyDatabase(e) && !ac.signal.aborted) { resumeAfterLock = true; throw e; }
    const cancelled = ac.signal.aborted;
    let msg = cancelled ? "cancelled" : String(e?.message ?? e);
    log(`${cancelled ? "cancelled" : "failed"}: ${msg}`);
    // what kind of failure it was, from the error's type (src/ways/errors.ts): a carry run reads this, never the words — and,
    // for a job that read the seedbox's folder, from the folder: troubled while it ran, it is the seedbox's ('env'/'remote')
    const judged = cancelled ? null : await judgedFail(id, e, remoteWatch, msg);
    retainExtraction = kind === "content" && (judged?.fail.class === "env" || judged?.fail.class === "plan");
    if (judged?.transient) { msg = judged.msg; log(`the seedbox, not the game data: ${msg}`); }
    end();
    recordFail(id, cancelled ? { class: "cancelled", by: stopper.get(id) ?? "system" } : judged!.fail);
    stmts.setJobFailed.run(cancelled ? "cancelled" : "failed", msg, id);
    events.emit("job", serializeJob(stmts.jobById.get(id) as JobRow));
  } finally {
    running.delete(id);
    lanes.delete(id);
    locks.delete(id);
    stopper.delete(id);
    unwatchJob(id);
    if (!resumeAfterLock) await scrub();
    if (work) forgetPlaced(work);                        // the links it placed are not anyone's to keep any more
    giveBack(id);                                        // only once nothing of its programs is left in its scratch folder
    reserved.delete(id);
    settled();
  }
}

/** the scratch a queued job needs: an import three times its input; another kind what its module says (0 is 0), 2 GB when
 *  it says nothing usable */
async function needOf(j: JobRow): Promise<number> {
  if (laneOf(j) === "import") {
    const { files } = await scan(j.input_path, 5000).catch(() => ({ files: [] as { size: number }[] }));
    return scratchNeeded(files.reduce((a, f) => a + f.size, 0));
  }
  const def: KindDef | undefined = jobKinds.get(kindOf(j) as Exclude<JobKind, "import">);
  if (!def?.scratch) return KIND_SCRATCH;
  try {
    const n = Number(await def.scratch(j, JSON.parse(j.spec_json ?? "null") as JobSpec));
    return Number.isFinite(n) && n >= 0 ? n : KIND_SCRATCH;
  } catch { return KIND_SCRATCH; }
}

/** a job in words, for why it waits */
function whatJob(j: Pick<JobRow, "kind">): [string, string] {
  switch (kindOf(j)) {
    case "import": return ["import", "import"];
    case "make": return ["make", "job"];
    case "content": return ["intake", "job"];
    case "assemble": case "build": return ["build", "job"];
    default: return ["job", "job"];
  }
}

/**
 * May this queued job start next to the ones running? Only when the scratch volume can hold its need on top of what
 * the running jobs have reserved, and — for a job that writes game data — what LIBRARY_KEEP_FREE_GB keeps free besides
 * (the scratch folder is on the library's volume unless LUDARR_WORK says otherwise). With nothing running it always
 * may: a lone job that does not fit fails on its own with a clear error instead of waiting forever.
 */
async function roomFor(j: JobRow): Promise<{ ok: true; need: number } | { ok: false; why: string }> {
  const need = await needOf(j);
  if (running.size === 0) return { ok: true, need };
  const game = j.game_id ? (stmts.gameById.get(j.game_id) as GameRow | undefined) : undefined;
  const root = rootFolderFor(game);
  if (!root) return { ok: true, need };
  if (j.publication_json) return { ok: true, need: 0 };
  const space = await pdeps.diskSpace(workDirFor(root)).catch(() => null) ?? await pdeps.diskSpace(root.path).catch(() => null);
  if (!space) return { ok: true, need };
  const held = [...reserved.values()].reduce((a, b) => a + b, 0);
  const left = space.free - held;
  const keep = KEEPS_FREE.has(kindOf(j)) ? keepFreeBytes() : 0;
  if (left >= need + keep) return { ok: true, need };
  // Completed stages already occupy part of this job's reservation. Let the job check the
  // space needed by its remaining step against the actual work volume.
  if (left > keep && await hasCheckpoints(join(workDirFor(root), "job-" + j.id))) return { ok: true, need: Math.min(need, left - keep) };
  const [what, others] = whatJob(j);
  return { ok: false, why: `waiting for scratch space: this ${what} needs about ${gb(need)}${keep ? ` and ${gb(keep)} kept free on the library` : ""}, ${gb(Math.max(0, left))} will be free once the ${running.size === 1 ? `running ${others} has` : `${running.size} running ${others}s have`} what ${running.size === 1 ? "it" : "they"} may need` };
}

/**
 * Start what may start: each queued job, oldest first, when its lane has a free slot, no running job holds its lock key
 * (every lane but the imports'), a build user is free for it and the scratch volume has room. A job that cannot start
 * stays queued, with a message saying why when that is not just its turn.
 */
export async function processTick(): Promise<void> {
  const caps = laneCaps();
  const busy = (lane: Lane) => { let n = 0; for (const l of lanes.values()) if (l === lane) n++; return n; };
  if (LANES.every(l => busy(l) >= caps[l])) return;
  for (const j of stmts.jobsByState.all("queued") as JobRow[]) {
    const lane = laneOf(j);
    if (busy(lane) >= caps[lane]) continue;                                // another lane may still have room
    // one job per way / plan / path at a time, whatever the lane: an assemble of a way never runs beside its make
    if (lane !== "import" && [...locks.values()].includes(lockKeyOf(j))) continue;
    // nothing starts reading the seedbox's folder while it does not answer: a 75 GB read never begins on a folder that is
    // down or being remounted (src/remote.ts; the job waits in the queue saying so)
    const seed = rootOf(inputOf(j));
    if (seed && rootDown(seed.to)) { waitingNote(j, `waiting for ${placeOf(seed.to)}, which ${rootState(seed.to)?.why ?? "does not answer"}`); continue; }
    let user: { user: string; uid: number } | null = null;
    if (lane !== "import") {
      user = takeUser(j.id);
      if (!user) { waitingNote(j, NO_BUILD_USER); continue; }
    }
    const room = await roomFor(j);
    if (!room.ok) {
      if (user) giveBack(j.id);
      waitingNote(j, room.why);
      continue;                                                              // a smaller one further down the queue may still fit
    }
    if (user) users.set(j.id, user);
    planned.set(j.id, room.need);
    void runJob(j.id).catch(error => {
      pdeps.log(`job #${j.id} could not record its result: ${messageOf(error)}`);
      if (busyDatabase(error)) void recoverBusyJob(j.id).catch(e => pdeps.log(`job #${j.id}: ${messageOf(e)}`));
    });
    await new Promise(r => setTimeout(r, 0));                                // let it take its place and reserve its scratch before the next is weighed
  }
}

/**
 * Jobs that were running when the process died: back to the queue (the work dir is rebuilt), except a kind that may
 * not run again unasked (the AI constructing a plan): that one fails and says so.
 */
async function recoverBusyJob(id: number) {
  // A finished publication already has a durable package, even if its final job update was interrupted.
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const row = stmts.jobById.get(id) as JobRow | undefined;
      if (!row || row.state !== "running" || running.has(id)) return;
      if (reconcilePublished(row)) return;
      if (kindOf(row) === "construct") stmts.setJobFailed.run("failed", "database busy while saving the job result", id);
      else stmts.setJob.run("queued", row.tier, 0, "resuming after the database became available", id);
      return;
    } catch (error) { if (!busyDatabase(error)) throw error; }
  }
}

function reconcilePublished(row: JobRow): boolean {
  const pkg = stmts.packageForJob.get(row.id) as PackageRow | null;
  if (!pkg) return false;
  db.transaction(() => {
    if (kindOf(row) === "import" && row.fetch_id && !JSON.parse(row.spec_json ?? "{}")?.earlier) stmts.setFetchImported.run(row.fetch_id);
    if (kindOf(row) === "assemble") {
      const spec = JSON.parse(row.spec_json ?? "{}");
      if (spec.wayId) wstmts.setWayBuilt.run(pkg.id, spec.wayId);
    }
    stmts.setJobDone.run("package published", pkg.path, pkg.manifest_json, row.id);
  }).immediate();
  return true;
}

export function resumeJobs() {
  for (const j of stmts.jobsByState.all("running") as JobRow[]) {
    if (reconcilePublished(j)) continue;
    const kind = kindOf(j);
    const def = kind === "import" ? undefined : jobKinds.get(kind);
    const resumable = kind === "import" || (def ? def.resumable !== false : kind !== "construct");
    if (resumable) stmts.setJob.run("queued", j.tier, 0, "resuming after restart", j.id);
    else { recordFail(j.id, { class: "restart" }); stmts.setJobFailed.run("failed", "interrupted by a restart — start it again", j.id); }
  }
  const work = workDir();
  pdeps.log(`import worker up — ${describeToolbox(pdeps.tools())}${work ? ` (work folder ${work})` : ""}`);
  void sweepWorkFolders().catch(() => 0);
}

/**
 * What jobs that will not run again left in the library's work folders goes: a restart cut them short (a construct round
 * is not run again), a cancel came while they were queued, or their own clear-up could not finish — a make's unpacked
 * game is tens of GB the library would otherwise never get back. A queued or running job's folder stays (a queued one
 * clears its own when it starts). At boot.
 */
export async function sweepWorkFolders(log: (line: string) => void = pdeps.log): Promise<number> {
  const keep = jobNeedsWork;
  let n = 0;
  for (const top of new Set(rootFolders().map(r => workDirFor(r)))) n += await sweepJobFolders(top, keep, log).catch(() => 0);
  return n;
}
