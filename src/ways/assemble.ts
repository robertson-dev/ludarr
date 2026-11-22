/**
 * ludarr — building a way to play (job kind 'assemble', spec {wayId, replace?, repin?, auto?, runId?}): a plan and
 * verified game files become an ordinary package that Ahoy installs and the launcher starts with an argv.
 *
 *   1 the way, its plan (which must be ready) and its game; the way is 'building'; its game file first: the way's own, or
 *     the game's copy on the server when it serves (judged where it is, never copied to be judged; taken by a hard link)
 *   2 the program as pinned (src/ways/program.ts), unpacked; its root (the plan's, or one lone top folder) → STAGING. A
 *     program built for this one game (a release kit, a source plan that reads the game file) is its kept build — none
 *     kept is NeedsBuild: the build job makes it in its own lane and queues this again, a build never runs in here
 *   3 the plan's needs: each one's system file (BIOS, firmware, keys), checked against its slot, copied to its place
 *   4 the game file: the way's file checked again (contentMatches) and placed at the content plan's place as {name} — a
 *     hard link from the content store when it ships and no setup step runs a program (nothing copied, nothing hashed
 *     again), else a copy hashed as it is written; a game folder as a tree of them; a file only the setup reads is handed
 *     to it read-only (a link in the scratch folder), never shipped
 *   5 the plan's files (and the way's own) without `after`, the setup steps (the plan's, then the way's own) — programs
 *     only in the build sandbox (src/ways/sandbox.ts), ini / remove / move here, all confined to STAGING — then the files
 *     written after setup
 *   6 checks: the exe and the placed file are there, nothing in STAGING is a link ludarr did not place, every name in it
 *     is one the launcher installs, no text the setup wrote names a path on this server (a wine Z: drive, the scratch
 *     folder)
 *   7 the manifest, from what is in STAGING (never from what anyone wrote about it): the package kind, launch with argv
 *     and env, the launcher it needs, keep and seed (which also lists the keep globs), the game's platform. A file ludarr
 *     placed is not read again while its stat is the one taken right after it was placed (src/process/validate.ts known).
 *     The launch is the start the admin set by hand (the way's overrides.launch, src/library/launch.ts) when its program
 *     and folder are in STAGING, stamped with its rev; otherwise the plan's with the way's own arguments and variables (and
 *     the history says the start set by hand was not applied). The plan's is kept as the start found, for Reset
 *   7b the plan's checks (the way's own in their place; src/ways/check.ts; the smoke start starts the start step 7 took, with
 *     the way's own arguments and variables), on a throwaway copy of the install folder: a
 *     failing check keeps the old package ("check: …"); one the server cannot run says so ("not started here: …") and the
 *     package is built; the report is a step of the job's trace ({kind: "check"}). They run once the manifest is taken:
 *     they leave STAGING as it was (that is checked), and a check's own link to a placed file would change that file's
 *     stat and have it read again for nothing
 *   8 the game's one package (finalizePackage, shared with imports); the way 'built'; a new pin stored on the plan
 *
 * Anything that fails leaves the game's current package as it is: the way is 'failed' with the reason — 'needs-files'
 * when a file is missing or is not the one the plan accepts, back to what it was when its program must be built for the
 * game first — and the job says why, as words and as a kind of failure (src/ways/errors.ts: the plan's, the file's, this
 * server's). Players' copies carry no repo, runtime, plan notes or AI wording: the manifest's source is the game's own
 * name with protocol 'way', notes empty.
 *
 * Every write ludarr itself makes into STAGING walks the path first and refuses a link anywhere on it, and STAGING
 * is the build user's only while one of its programs runs: a program that plants a link cannot make ludarr write
 * (or package) a file outside the package.
 */
import { scopeProblem } from "./emulator-scope";
import { constants } from "node:fs";
import { copyFile, cp, chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stmts, type GameRow, type JobRow, type PackageRow } from "../db";
import { ROM_MARKER } from "../platforms";
import { events } from "../events";
import { removeTree } from "../fsutil";
import { record } from "../library/history";
import { serializeLibraryGame } from "../library/games";
import { choiceOnDisk, launchLine, manifestLaunch, manifestMeta, notAppliedWords, startLine, type Start } from "../library/launch";
import { rootFolderFor, workDirFor } from "../library/rootfolders";
import { registerJobKind, type KindContext, type KindResult } from "../process/kinds";
import { cancelHooks, finalizePackage, replaceRefusal } from "../process/runner";
import { winPath } from "../process/scene";
import { buildManifest, slugify, type KnownFile, type Validation } from "../process/validate";
import { buildForWay, keptKitBuild, kitOf, placeKitBuild, wayBuildNeeded } from "./build";
import { roomWatch, runChecks } from "./check";
import { copyFacts, copyServes, judgeCopy, type CopyFacts, type CopyServes } from "./copy";
import { EnvError, failOf, NeedsBuild, NeedsFiles, PlanFault } from "./errors";
import { contentMatches, inputMatches, needMatches, needsMet, type FileFacts, type Verdict } from "./match";
import {
  acquireProgram, forgetPlaced, freshTarget, handOver, inside, linksWork, placeContent, refuseLinks, textOf, toolsDir,
  type Acquired, type Placed, type PlacedFile,
} from "./program";
import { runSandboxedStep, sandboxDirs, sandboxOrAllowed } from "./sandbox";
import {
  contentHashes, contentIdentity, contentRawHashes, currentPackage, gameFiles, getContent, getPlan, getWay, making, planPinned, planSpec, settleWaysOnCopy, systemFiles as systemFilesOf, updateWay, wayContent, wayOverrides, wstmts,
  type ContentRow, type PlanRow, type WayRow,
} from "./store";
import { LAUNCHER_FOR_WAYS, PACKAGE_KIND, type CheckReport, type CheckTraceStep, type ContentPlan, type FailInfo, type HashedStat, type JobSpec, type LaunchPlan, type MakeInput, type PinnedProgram, type PlanCheck, type PlanFile, type RuntimePlanSpec, type SetupStep } from "./types";
import { launcherPathProblem, placedName, placeholdersIn, safeRelPath } from "./validate";

import { serverPathInFile } from "../process/portability";

export { inside, placeContent, serverPathIn, type Placed, type PlacedFile } from "./program";

/** swapped in tests, and the integrator's hook */
export const adeps = {
  /**
   * INTEGRATOR HOOK — the hand-over of the game's copy (step 1): a way with no game file whose game's copy on the server
   * (a kind 'rom' package) serves it as it is takes it as its file (src/ways/copy.ts takeCopy: a hard link into the
   * content store, hashed where it is, a copy only across volumes) and returns its row; the way's content_id is then set to
   * it. `content` is the way's content plan; `progress` (bytes of total) and `signal` let a long hand-over say how far it
   * is and stop when the build is cancelled. Wave 1: nothing.
   */
  contentFromPackage: async (_o: { way: WayRow; game: GameRow; pkg: PackageRow | null; log: (line: string) => void; content: ContentPlan; progress?: (bytes: number, total: number, step?: string) => void; signal?: AbortSignal }): Promise<ContentRow | null> => null,
  /** what the game's copy is to a way's content plan, and judging it where it is when nothing is known yet (src/ways/copy.ts) */
  copyServes: (gameId: number, c: ContentPlan): CopyServes => copyServes(gameId, c),
  judgeCopy: async (gameId: number): Promise<unknown> => judgeCopy(gameId),
  /** the copy as last judged (its pieces of game data, the main one's fields on top), or null */
  copyFacts: (gameId: number): CopyFacts | null => copyFacts(gameId),
  /** the make job making a way's game file, while it is queued or running */
  making: (wayId: number): JobRow | null => making(wayId),
  /** whether a kept file or folder of the game is what the way's make takes as its input (src/ways/match.ts) */
  inputMatches: (input: MakeInput, f: FileFacts): Verdict => inputMatches(input, f),
  /** the plan's checks on the put-together package (src/ways/check.ts) */
  runChecks: (o: Parameters<typeof runChecks>[0]): Promise<CheckReport> => runChecks(o),
};

/** the package is not built because of what the game has already: a PC copy, or another way's package (fail kind
 *  'replace': built only when the admin asks to replace it) */
class Refused extends Error {
  get fail(): FailInfo { return { class: "other", kind: "replace" }; }
}
/** a build ludarr queued by itself (spec.auto: a search's file, an imported dump, a carry run) never replaces another
 *  way's package (the admin builds that from the game page): the way stays as it was */
class NotReplacing extends Refused {}
function autoRefusal(spec: Extract<JobSpec, { kind: "assemble" }>, way: WayRow): string | null {
  if (!spec.auto || spec.replace) return null;
  const cur = currentPackage(way.game_id);
  return cur && cur.kind !== "rom" && cur.kind !== "native" && cur.pkg.id !== way.package_id ? "the game has another way to play built: build this one from the game page to replace it" : null;
}

const facts = (c: ContentRow): FileFacts => ({ platform: c.platform, name: c.name, size: c.size, hashes: contentHashes(c), rawHashes: contentRawHashes(c), identity: contentIdentity(c), shape: c.shape === "folder" ? "folder" : "file" });
const gbText = (n: number) => `${(n / 1e9).toFixed(2)} GB`;
/** bytes done of a total, in the total's unit: "12.3 of 54.2 GB" */
const ofTotal = (done: number, total: number) => (total >= 1e9 ? `${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB` : `${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB`);
const JUNK = /^(__macosx|\.ds_store|thumbs\.db|desktop\.ini)$/i;
const errText = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e);
/** a time span in words ("40 s", "12 min") */
const span = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`; };

/**
 * Whether a file ludarr keeps (the game file, a kept build) may be placed into STAGING as a hard link: no setup step of
 * the plan or the way runs a program. A program's folder is the build user's while it runs, and nothing it could write
 * may be the store's own file; such a plan's files are copied, hashed as they are written.
 */
export const linksAllowed = (setup: SetupStep[]): boolean => !setup.some(s => "run" in s);
/** the setup steps a way runs: the plan's, then the way's own */
const setupOf = (pspec: RuntimePlanSpec, w: WayRow): SetupStep[] => [...pspec.setup, ...(wayOverrides(w).setup ?? [])];
/** the checks a way runs: its own in place of the plan's */
const checkOf = (pspec: RuntimePlanSpec, w: WayRow): PlanCheck | null => wayOverrides(w).check ?? pspec.check ?? null;
/** whether the plan's program is built for each game (a release kit, or a source plan whose build reads the game file) */
const perGame = (pspec: RuntimePlanSpec) => !!kitOf(pspec.program) || (pspec.program.kind === "source" && pspec.program.content === "build");

/* ─────────── ini ─────────── */

/** set `key` in `[section]` (both matched without regard to case, as Windows does), keeping every other line as it is */
export function setIni(text: string, section: string, key: string, value: string): string {
  const eol = text.includes("\r\n") || !text.includes("\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const want = section.trim().toLowerCase(), k = key.trim().toLowerCase();
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[(.*)\]\s*$/.exec(lines[i]);
    if (m) { if (start >= 0) { end = i; break; } if (m[1].trim().toLowerCase() === want) start = i; continue; }
    if (start < 0) continue;
    const kv = /^(\s*)([^=;#\s][^=]*?)(\s*)=(\s*)(.*)$/.exec(lines[i]);
    if (kv && kv[2].trim().toLowerCase() === k) { lines[i] = `${kv[1]}${kv[2]}${kv[3]}=${kv[4]}${value}`; return lines.join(eol) + eol; }
  }
  if (start >= 0) {
    let at = end;
    while (at > start + 1 && lines[at - 1].trim() === "") at--;
    lines.splice(at, 0, `${key} = ${value}`);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`[${section}]`, `${key} = ${value}`);
  }
  return lines.join(eol) + eol;
}

/* ─────────── confined writes, what the setup wrote ─────────── */

async function placeCopy(root: string, rel: string, from: string) { await copyFile(from, await freshTarget(root, rel), constants.COPYFILE_EXCL); }
async function placeText(root: string, rel: string, text: string) { await writeFile(await freshTarget(root, rel), text, { flag: "wx" }); }

type Tree = Map<string, { size: number; mtime: number }>;
async function treeOf(root: string): Promise<Tree> {
  const out: Tree = new Map();
  const walk = async (dir: string, rel: string) => {
    for (const n of await readdir(dir).catch(() => [] as string[])) {
      const p = join(dir, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p, r);
      else out.set(r, { size: st.size, mtime: st.mtimeMs });
    }
  };
  await walk(root, "");
  return out;
}

/** every entry of a tree (the tree itself as ""), as "<device>:<inode>:<size>:<mtime>": a file put in another's place, a
 *  write, a resize or a swapped folder all change it */
async function stampsOf(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const stamp = (st: { dev: number; ino: number; size: number; mtimeMs: number }, dir: boolean) => `${st.dev}:${st.ino}:${dir ? 0 : st.size}:${dir ? 0 : st.mtimeMs}`;
  const top = await lstat(root).catch(() => null);
  if (top) out.set("", stamp(top, true));
  const walk = async (dir: string, rel: string) => {
    for (const n of await readdir(dir).catch(() => [] as string[])) {
      const p = join(dir, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      out.set(r, stamp(st, st.isDirectory()));
      if (st.isDirectory()) await walk(p, r);
    }
  };
  await walk(root, "");
  return out;
}

/* ─────────── tools ─────────── */

/** the plan's built helpers for this program: <config>/ways/tools/<slug>/<commit>/ whose tools.json names the ref */
async function findTools(plan: PlanRow, pinned: PinnedProgram, ref: string): Promise<string | null> {
  const want = ref.replace(/\{tag\}/g, pinned.tag);
  const base = join(toolsDir(), plan.slug);
  for (const commit of await readdir(base).catch(() => [] as string[])) {
    const dir = join(base, commit);
    try {
      const meta = JSON.parse(await readFile(join(dir, "tools.json"), "utf8")) as { ref?: string; commit?: string };
      if (meta.ref === want || meta.commit === want) return dir;
    } catch { /* not a finished build */ }
  }
  return null;
}

/* ─────────── the job ─────────── */

registerJobKind("assemble", {
  run: ctx => assemble(ctx),
  /** the program downloaded and unpacked (about three times its size); the game file only when it is copied: a hard link
   *  (the game file placed, the game's copy taken, a file the setup reads) writes nothing; a kept build likewise; a copy
   *  that is not the way's file as it is (it is made into it first, or never serves) is not taken at all */
  scratch: async (_job, spec) => {
    if (spec.kind !== "assemble") return 2e9;
    const way = getWay(spec.wayId), plan = way ? getPlan(way.plan_id) : null;
    if (!way || !plan) return 2e9;
    const pspec = planSpec(plan), content = wayContent(way, plan), setup = setupOf(pspec, way);
    const file = way.content_id ? getContent(way.content_id) : null;
    const copy = !file && way ? currentPackage(way.game_id) : null;
    const serves = copy && content ? adeps.copyServes(way.game_id, content).serves : null;
    // a console copy not looked at yet may be taken as it is; any other kind only once a look found the piece it takes
    const takes = serves === "direct" || (serves === "unknown" && copy?.kind === "rom");
    // the piece taken (a console file inside a PC copy is smaller than the copy), else the copy's own size
    const piece = copy && takes ? adeps.copyFacts(way.game_id)?.size ?? null : null;
    const game = file?.size ?? (copy && takes ? piece ?? copy.pkg.size ?? 0 : 0);
    const root = rootFolderFor(stmts.gameById.get(way.game_id) as GameRow | undefined);
    // the volume is asked where the jobs work (made here when no job has run yet)
    const work = root ? workDirFor(root) : null;
    if (work) await mkdir(work, { recursive: true }).catch(() => {});
    const links = work ? await linksWork(work).catch(() => false) : false;
    const kept = file && kitOf(pspec.program) ? keptKitBuild(plan, file) : null;
    const program = kept ? (links && linksAllowed(setup) ? 0 : kept.record.size) : 3 * (planPinned(plan)?.size ?? 300e6);
    const ships = !!content && content.ship !== false;
    const place = ships && !(links && linksAllowed(setup)) ? game : 0;
    const takeCopy = !file && !!copy && takes && !links ? game : 0;
    return Math.max(2e9, program + place + takeCopy);
  },
});
/** a build cancelled before it ran (after a restart its way may still say 'building'): the way is back where it was */
cancelHooks.set("assemble", (job: JobRow) => {
  let spec: JobSpec | null = null;
  try { spec = JSON.parse(job.spec_json ?? "null"); } catch { /* none */ }
  if (spec?.kind !== "assemble") return;
  const w = getWay(spec.wayId);
  if (w?.status === "building") updateWay(w.id, { status: w.package_id ? "built" : "ready", statusNote: "the build was cancelled" });
});

export async function assemble(ctx: KindContext): Promise<KindResult> {
  const spec = ctx.spec as Extract<JobSpec, { kind: "assemble" }>;
  ctx.progress(0.01, "looking at the way and its game file");
  const way = getWay(spec.wayId);
  if (!way) throw new Error("the way to play is gone");
  const plan = getPlan(way.plan_id);
  if (!plan) throw new Error("the way's plan is gone");
  const game = stmts.gameById.get(way.game_id) as GameRow | undefined;
  if (!game) throw new Error("the way's game is gone");
  const wrong = scopeProblem(plan, game.id);
  if (wrong) throw new Error(wrong);
  const before = { status: way.status, note: way.status_note };
  const log = ctx.log;
  /** a cancel is honoured between steps, and never after the package has been stored */
  const stop = () => { if (ctx.signal.aborted) throw new Error("cancelled"); };
  try {
    // 1 — the plan must be ready (a check or an edit makes it so); the way is building from here
    if (plan.status !== "ready") throw new PlanFault(undefined, `the plan is ${plan.status}${plan.status_note ? ` (${plan.status_note})` : ""}: check it before building`);
    const refusal = replaceRefusal((stmts.packageForGame.get(game.id) as PackageRow | undefined) ?? null, "way", !!spec.replace);
    if (refusal) throw new Refused(refusal);                                            // told now, not after a download (finalize checks again)
    const auto = autoRefusal(spec, way);
    if (auto) throw new NotReplacing(auto);
    updateWay(way.id, { status: "building", statusNote: null });
    const pspec = planSpec(plan), content = wayContent(way, plan), overrides = wayOverrides(way);
    const setup = setupOf(pspec, way), check = checkOf(pspec, way);
    log(`building "${game.name}" with ${plan.name}${spec.repin ? " (taking the newest release)" : ""}`);

    // what can be told before anything is downloaded: the sandbox for programs, the needs, the game file, a program that
    // must be built for this game first
    if (setup.some(s => "run" in s) && !sandboxOrAllowed()) throw new EnvError("tool", "setup steps need the build sandbox");
    const systemFiles = systemFilesOf(plan.id);
    const needs = needsMet(pspec, systemFiles.map(c => ({ ...facts(c), needIndex: c.need_index })));
    if (!needs.met) throw new NeedsFiles(`needs ${needs.missing.map(m => m.name + (m.why ? ` (${m.why})` : "")).join(", ")} — add it on the plan`);
    const file = content ? await gameFile(way, game, content, ctx) : null;
    if (perGame(pspec) && file && wayBuildNeeded(plan, getWay(way.id) ?? way)) throw new NeedsBuild("its program has to be built for this game first (a build job does that, then the way is built)");

    // 2 — the program: the plan's as pinned, or the one kept for this game
    ctx.progress(0.1, "getting the program");
    const getting = { work: ctx.work, repin: !!spec.repin, signal: ctx.signal, log, progress: (p: number, m: string) => ctx.progress(0.1 + 0.3 * p, m) };
    const linkOk = linksAllowed(setup);
    const acq: Acquired = kitOf(pspec.program) && file ? await placeKitBuild(plan, file, { work: ctx.work, link: linkOk, signal: ctx.signal, log, progress: getting.progress })
      : pspec.program.kind === "source" && pspec.program.content === "build" && file ? await buildForWay(plan, way, file, { ...getting, keptOnly: true })
      : await acquireProgram(plan, getting);
    stop();
    await intoStaging(acq, pspec, ctx.staging);
    const staging = ctx.staging;

    // 3 — system files
    ctx.progress(0.42, "placing the files it needs");
    for (const [i, n] of pspec.needs.entries()) {
      if (n.build) continue;
      const f = systemFiles.find(c => c.need_index === i && needMatches(n, facts(c)).ok)!;
      await placeCopy(staging, n.place, f.path);
      log(`${n.name}: ${f.name} → ${n.place}`);
    }

    // 4 — the game file
    let placed: string | null = null, contentPath: string | null = null, placement: Placed | null = null;
    if (content && file) {
      if (content.ship !== false) {
        placed = content.kind === "folder" ? content.place : content.place.replace(/\{name\}/g, placedName(file.name));
        const err = safeRelPath(placed);
        if (err) throw new PlanFault(undefined, `the game file's place ${placed}: ${err}`);
        ctx.progress(0.45, linkOk ? "linking the game file into the package" : "placing the game file");
        placement = await placeContent(staging, placed, file, {
          link: linkOk, log, signal: ctx.signal, scope: ctx.work,
          progress: (done, total, how) => ctx.progress(0.45 + 0.05 * (total ? done / total : 1), how === "link" ? "linking the game file into the package" : `placing the game file · ${ofTotal(done, total)}`),
        });
        contentPath = placement.abs;
      } else if (setup.some(s => "run" in s && s.run.argv.some(a => placeholdersIn(a).includes("content")))) {
        // consumed by the setup, never shipped: handed to it read-only (a link in the scratch folder), never copied
        contentPath = (await handOver(file, ctx.work, { log })).path;
        log(`game file: ${file.name}, for the setup only`);
      }
    }

    // 5 — files, setup, files after setup
    stop();
    const files = mergeFiles(pspec.files, overrides.files ?? []);
    for (const f of files.filter(f => f.after !== "setup")) { await placeText(staging, f.path, f.text); log(`file ${f.path}`); }
    const beforeSetup = await treeOf(staging);
    let toolsAt: string | null = null;
    for (const [i, step] of setup.entries()) {
      const at = 0.5 + 0.3 * (i / Math.max(1, setup.length)), label = `setting up (${i + 1} of ${setup.length})`;
      ctx.progress(at, label);
      if ("run" in step && step.run.tool && !toolsAt) toolsAt = await copyTools(plan, acq.pinned, pspec, ctx.work);
      await runSetupStep(step, i, { staging, work: ctx.work, contentPath, toolsAt, signal: ctx.signal, log, heartbeat: since => ctx.progress(at, `${label} · ${since}`) });
      stop();
    }
    for (const f of files.filter(f => f.after === "setup")) { await placeText(staging, f.path, f.text); log(`file ${f.path} (after setup)`); }

    // 6 — checks
    ctx.progress(0.82, "checking the package");
    const exe = await present(staging, pspec.launch.exe);
    if (!exe) throw new PlanFault(undefined, `the program has no ${pspec.launch.exe} (the plan's launch)`);
    if (pspec.launch.cwd) { const st = await lstat(join(staging, ...pspec.launch.cwd.split("/"))).catch(() => null); if (!st?.isDirectory()) throw new PlanFault(undefined, `the plan's launch folder ${pspec.launch.cwd} is not in the program`); }
    if (placed) {
      const st = await lstat(join(staging, ...placed.split("/"))).catch(() => null);
      if (!(file?.shape === "folder" ? st?.isDirectory() : st?.isFile())) throw new PlanFault("setup", `the game file is not at ${placed} after setup`);
    }
    await refuseLinks(staging, "the package");                                       // the links ludarr placed pass, any other link fails
    const afterSetup = await treeOf(staging);
    // every name in the package must be one the launcher installs (a ':' or a name of dots is legal here, never on Windows)
    for (const rel of afterSetup.keys()) {
      const why = launcherPathProblem(rel);
      if (why) throw new PlanFault("setup", `the package would hold ${JSON.stringify(rel)}, which ${why}: no player's PC could install it`);
    }
    // the package's own manifest goes beside its files as ahoy.json: nothing in the package may have that name (a game file
    // placed there by a hard link would even have the manifest written into the content store's own file)
    const own = [...afterSetup.keys()].find(rel => /^ahoy\.json$/i.test(rel));
    if (own) throw new PlanFault(undefined, `the package would hold ${own}, the name of the package's own manifest: the program, the game file's place and the plan's files must not use it`);
    for (const [rel, s] of afterSetup) {
      const was = beforeSetup.get(rel);
      if (was && was.size === s.size && was.mtime === s.mtime) continue;               // untouched by the setup
      const why = await serverPathInFile(join(staging, ...rel.split("/")), s.size, ctx.work);
      if (why) throw new PlanFault("setup", `${rel} holds ${why} — written by the setup, it would point nowhere on a player's PC`);
    }

    // 7 — the manifest (the placed path goes in as it is: a '$' in it is no replacement pattern). It starts as the plan says
    // with the way's own arguments and variables — or as the admin set it by hand, when that start's program (and folder)
    // is in this build (src/library/launch.ts); a start set by hand that is not stays the way's, and the history says so
    const argv = [...pspec.launch.argv, ...(overrides.argvExtra ?? [])].map(a => (placed ? a.replace(/\{content\}/g, () => `{install}/${placed}`) : a));
    const env = { ...(pspec.launch.env ?? {}), ...(overrides.env ?? {}) };
    const placeholder = (s: string) => placeholdersIn(s).length > 0;
    const needsLauncher = argv.length > 0 || Object.keys(env).length > 0 || placeholder(pspec.launch.cwd ?? "") || pspec.keep.length > 0 || pspec.seed.length > 0;
    const planStart: Start = { exe, argv, ...(pspec.launch.cwd ? { cwd: pspec.launch.cwd } : {}), env };
    const choice = overrides.launch ?? null;
    const hand = choice ? await choiceOnDisk(choice, { root: staging, placed, keep: pspec.keep, seed: pspec.seed }) : null;
    const used = hand && "start" in hand ? hand.start : planStart;
    const notApplied = choice && hand && "why" in hand ? notAppliedWords(choice, hand.why, planStart, "as the plan says") : null;
    if (notApplied) log(notApplied);
    else if (choice) log(`it starts as set by hand: ${startLine(used.exe, used.argv)}`);
    const meta = manifestMeta(used, needsLauncher ? LAUNCHER_FOR_WAYS : null);
    const scanned = await treeOf(staging);
    const validation: Validation = { ok: true, root: staging, problems: [], exeCandidates: [used.exe], launch: used.exe, prerequisites: [], totalSize: [...scanned.values()].reduce((a, f) => a + f.size, 0), fileCount: scanned.size };
    const slug = game.slug || slugify(game.name);
    // the program's release as the package's version ("v1.2.2" → "1.2.2"); a fixed file has none. A source build's tag is
    // '<ref>@<commit>': players get the ref when it is a tag or a branch, and nothing when it is a commit (never a hash)
    const ref = acq.pinned.tag.replace(/@[0-9a-f]{7,40}$/i, "");
    const version = pspec.program.kind === "url" || (pspec.program.kind === "source" && /^[0-9a-f]{40}$/i.test(ref)) ? null : ref.replace(/^v(?=\d)/i, "").slice(0, 60);
    // a kept file the package also ships (a settings file the player edits) is the player's once it is on disk: the
    // manifest seeds it too, so no launcher fetches or verifies it again over the player's own
    const seed = [...new Set([...pspec.seed, ...pspec.keep])];
    ctx.progress(0.85, "verifying the package");
    // what ludarr placed itself, with its sha256 when that is known (a link to a file whose stat is the one it was hashed
    // with, a copy hashed as it was written): not read again while its stat is the one taken right after it was placed
    const known = await knownFiles(staging, [...(placement?.files ?? []), ...(acq.files ?? [])]);
    if (known.size) log(`${known.size} file${known.size === 1 ? "" : "s"} placed by ludarr keep their sha256: not read again`);
    const manifest = await buildManifest(validation, {
      name: game.name, slug, version, source: { title: game.name, group: null, protocol: "way", indexer: null }, tier: "deterministic", notes: null,
      kind: PACKAGE_KIND[plan.kind], platform: content?.platform ?? null, ...meta, keep: pspec.keep, seed,
    }, (d, t) => ctx.progress(0.85 + 0.08 * (t ? d / t : 1), `verifying the package · ${ofTotal(d, t)}`), { known, signal: ctx.signal });
    // a start set by hand carries its stamp; the plan's start is what Reset gives back
    if (used !== planStart) manifest.launch = { ...manifest.launch, rev: choice!.at };
    const launchAuto = used !== planStart ? { launch: manifestLaunch(planStart), requires: needsLauncher ? { launcher: LAUNCHER_FOR_WAYS } : null } : undefined;
    if (placed && file) {
      await sameGameFile(file, placed, placement, manifest.files);
      await keepHashedStat(file, placed, placement, manifest.files, log);
    }

    // 7b — the plan's checks, on a throwaway copy of the install folder
    let checkClause: string | null = null;
    if (check && (check.steps.length || check.smoke)) {
      ctx.progress(0.94, "checking that it runs");
      // what STAGING is before the checks, file by file: the same files (device and inode), sizes and times after them, or
      // the build is refused (a check's own link to a placed file moves its ctime, so that is not compared)
      const pre = await stampsOf(staging);
      // the smoke start starts what players will start: the start actually used, with the way's arguments and variables
      const report = await adeps.runChecks({ staging, work: ctx.work, spec: { ...pspec, launch: smokeLaunch(used, used === planStart) }, check, placed, signal: ctx.signal, log, progress: (p, m) => ctx.progress(0.94 + 0.03 * Math.max(0, Math.min(1, p)), m), jobId: ctx.job.id });
      stop();
      const step: CheckTraceStep = { kind: "check", report, t: Date.now() };
      ctx.trace?.(step);
      const post = await stampsOf(staging);
      const changed = [...post].find(([rel, s]) => pre.get(rel) !== s)?.[0] ?? [...pre.keys()].find(rel => !post.has(rel));
      if (changed) throw new PlanFault("check", `check: the checks changed the package (${changed || "the folder itself"}): they run on a copy of it`);
      if (report.verdict === "fail") throw new PlanFault("check", checkFailure(report));
      if (report.verdict === "env") { checkClause = `not started here: ${envWhy(report)}`; log(checkClause); }
      else log(report.verdict === "pass" ? `checks passed${report.text ? `: ${report.text}` : ""}` : "no checks ran");
    } else ctx.trace?.({ kind: "check", report: { verdict: "none", steps: [], smoke: null, text: "the plan has no checks" }, t: Date.now() } satisfies CheckTraceStep);

    // 8 — the game's package
    stop();
    const root = rootFolderFor(game);
    if (!root) throw new Error("no root folder — add one under Settings → Media management");
    ctx.progress(0.98, "moving into the root folder");
    // another way's build that ended meanwhile (two at once) is not replaced by one ludarr queued by itself either
    const late = autoRefusal(spec, way);
    if (late) throw new NotReplacing(late);
    const { pkg, final, previous } = await finalizePackage({ jobId: ctx.job.id, gameId: game.id, root, slug, name: game.name, version, from: staging, manifest, by: "way", replace: !!spec.replace, log, ...(launchAuto ? { launchAuto } : {}) });
    wstmts.setWayBuilt.run(pkg.id, way.id);
    // the pin is the plan's only while the plan still says what this build read (an edit meanwhile is checked afresh)
    if (acq.fresh && !wstmts.setPinnedIf.run(JSON.stringify(acq.pinned), plan.id, plan.spec_json, plan.repo).changes)
      log("the plan was changed during the build: what this build took is not pinned on it");
    const summary = `built: ${manifest.files.length} files, ${gbText(manifest.totalSize)}, launch ${launchLine(manifest.launch)}${checkClause ? `; ${checkClause}` : ""}`;
    record(game.id, previous ? "upgraded" : "imported", { gameName: game.name, release: plan.name, source: "way", message: summary, data: { packageId: pkg.id, path: final, size: manifest.totalSize, wayId: way.id } });
    if (notApplied) record(game.id, "edited", { gameName: game.name, release: plan.name, source: "way", message: notApplied, data: { packageId: pkg.id, wayId: way.id } });
    const fresh = stmts.gameById.get(game.id) as GameRow | undefined;
    if (fresh) events.emit("game", serializeLibraryGame(fresh));
    return { message: summary, packageId: pkg.id };
  } catch (e: any) {
    if (ctx.signal.aborted) updateWay(way.id, { status: before.status === "building" ? (getWay(way.id)?.package_id ? "built" : "ready") : before.status, statusNote: "the build was cancelled" });
    // not built because of what the game has, or because its program is built for this game first: the way is as it was
    else if (e instanceof NotReplacing || failOf(e).kind === "needs-build") updateWay(way.id, { status: before.status === "building" || before.status === "failed" ? "ready" : before.status, statusNote: String(e.message) });
    else updateWay(way.id, { status: e instanceof NeedsFiles ? "needs-files" : "failed", statusNote: String(e?.message ?? e) });
    throw e;
  } finally { forgetPlaced(ctx.work); }
}

/** why a check failed, in the words the job ends with ("check: …"): a step this server could not run ("not run here: …")
 *  is never the one named, or the repair round would rework a check that only lacked this server's CPU or device */
function checkFailure(r: CheckReport): string {
  const s = r.steps.find(x => !x.ok && !x.tail.startsWith("not run here"));
  if (s) return `check: ${s.what} failed${s.code !== null ? ` (exit ${s.code})` : ""}${s.tail ? `: ${s.tail}` : ""}`;
  if (r.smoke && r.smoke.verdict === "fail") return `check: starting it failed${r.smoke.exitCode !== null ? ` (exit ${r.smoke.exitCode})` : ""}: ${r.smoke.why}`;
  return `check: ${r.text || "it failed"}`;
}
/** why a check could not tell anything on this server (no graphics device, a CPU it lacks) */
function envWhy(r: CheckReport): string {
  const why = (r.smoke?.verdict === "env" ? r.smoke.why : "") || r.text || "the server cannot run it";
  return why.replace(/^not (started|run) here:\s*/i, "");
}

/**
 * The sha256 of each file ludarr placed, by where it is in STAGING now (a setup step may have moved it): found by its
 * device and inode, with the stat taken right after it was placed — buildManifest takes it only while that stat holds.
 */
async function knownFiles(staging: string, placed: PlacedFile[]): Promise<Map<string, KnownFile>> {
  const byInode = new Map(placed.filter(f => f.sha256).map(f => [`${f.dev}:${f.ino}`, f]));
  const known = new Map<string, KnownFile>();
  if (!byInode.size) return known;
  const walk = async (dir: string, at: string) => {
    for (const n of await readdir(dir).catch(() => [] as string[])) {
      const p = join(dir, n), rel = at ? `${at}/${n}` : n;
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) { await walk(p, rel); continue; }
      const f = st.isFile() ? byInode.get(`${st.dev}:${st.ino}`) : undefined;
      if (f) known.set(rel, { sha256: f.sha256!, size: f.size, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs, dev: f.dev, ino: f.ino });
    }
  };
  await walk(staging, "");
  return known;
}

/** a kept game folder's listing (<name>.tree.tsv beside it: "rel\tsize\tsha256" a line, src/ways/content.ts), or null */
async function folderListing(row: ContentRow): Promise<Map<string, string> | null> {
  const text = await readFile(`${row.path}.tree.tsv`, "utf8").catch(() => null);
  if (!text) return null;
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const [rel, , sha] = line.split("\t");
    if (rel && sha && /^[0-9a-f]{64}$/i.test(sha)) m.set(rel, sha.toLowerCase());
  }
  return m.size ? m : null;
}

/**
 * The package's game file is still the one that was checked: its sha256 in the manifest is the kept row's. When it is not,
 * the setup changed it (it differs from what was placed), or the store's own file is not the bytes it was taken in with.
 */
async function sameGameFile(file: ContentRow, placed: string, placement: Placed | null, files: { path: string; sha256: string }[]): Promise<void> {
  const inManifest = new Map(files.map(f => [f.path, f.sha256]));
  if (file.shape === "folder") {
    const listing = await folderListing(file);
    if (!listing) return;
    for (const [rel, sha] of listing) {
      const now = inManifest.get(`${placed}/${rel}`);
      if (now && now !== sha) throw new NeedsFiles(`the game folder ${file.name} is not what was taken in (${rel} changed): take it in again`);
    }
    return;
  }
  const sha = contentHashes(file).sha256, now = inManifest.get(placed);
  if (!sha || !now || now === sha) return;
  // a link is the store's own file (no program ran beside it), and a copy hashed as it was written that still is what it
  // was: the store's file is not what it was taken in as. A copy that changed since: the setup changed it
  const at = placement?.files[0];
  if (at?.linked || (at?.sha256 && at.sha256 === now)) throw new NeedsFiles(`the game file ${file.name} on the server is not the one that was checked (its sha256 changed since it was taken in): take it in again`);
  throw new PlanFault("setup", "the game file changed during setup");
}

/**
 * A kept game file the manifest had to read through its link (its row has no stat its hashes are trusted by: a row from
 * before stats were kept, or one hashed under another stat) that is still the bytes it was taken in with: its stat now
 * goes with the row (src/ways/types.ts HashedStat), so the next build does not read it again. Only when the stat did not
 * move from right after the link to now, ctime included — then the bytes read are the bytes of that stat.
 */
async function keepHashedStat(file: ContentRow, placed: string, placement: Placed | null, files: { path: string; sha256: string }[], log: (line: string) => void): Promise<void> {
  const at = placement?.files[0];
  if (file.shape === "folder" || !at?.linked || at.sha256) return;           // a copy is hashed as it is written; a trusted link was not read
  const sha = contentHashes(file).sha256;
  if (!sha || files.find(f => f.path === placed)?.sha256 !== sha) return;
  const now = await lstat(file.path).catch(() => null);
  if (!now || now.ino !== at.ino || now.dev !== at.dev || now.size !== at.size || now.mtimeMs !== at.mtimeMs || now.ctimeMs !== at.ctimeMs) return;
  const stat: HashedStat = { size: now.size, mtimeMs: now.mtimeMs, ctimeMs: now.ctimeMs, dev: now.dev, ino: now.ino };
  try { wstmts.setContentStat.run(JSON.stringify(stat), file.id); log(`${file.name}: read once more and still the file that was taken in; its sha256 is trusted from now on while it is unchanged`); }
  catch { /* the next build reads it again */ }
}

/** what the game's copy cannot be for this way, from its package's manifest alone (its launch names the dump: one file, or a
 *  folder dump's marker file), or null when only its bytes can tell */
function copyNameRefusal(pkg: PackageRow, c: ContentPlan): string | null {
  let launch = "";
  try { launch = String(JSON.parse(pkg.manifest_json)?.launch?.exe ?? ""); } catch { return null; }
  if (!launch) return null;
  if (ROM_MARKER.test(launch)) return c.kind === "folder" ? null : "a game folder dumped from a console, and this way takes one file";
  if (c.kind === "folder") return `one file (${basename(launch)}), and this way takes the game's folder`;
  const formats = c.accept.formats ?? [];
  const e = (/\.([A-Za-z0-9]{1,8})$/.exec(launch)?.[1] ?? "").toLowerCase();
  return formats.length && !formats.includes(e) ? `a .${e || "?"} file, and this needs ${formats.map(x => "." + x).join(", ")}` : null;
}

/** the way's game file, checked against its content plan again (a wrong game is far worse than none). With none yet: one
 *  being made, or a kept file the way's make takes, is made first; else the game's copy on the server when it serves as it
 *  is, judged where it is first, then taken (src/ways/copy.ts) */
async function gameFile(way: WayRow, game: GameRow, content: ContentPlan, ctx: KindContext): Promise<ContentRow> {
  const log = ctx.log;
  let file = way.content_id ? getContent(way.content_id) : null;
  if (!file) {
    const j = adeps.making(way.id);
    if (j) throw new NeedsFiles(`its game file is being made (job ${j.id})`);
    // a kept file (an inbox drop, an earlier make's input) that the way's make takes: the make job makes the file first
    const make = content.make;
    const input = make ? gameFiles(game.id).find(r => r.source !== "made" && adeps.inputMatches(make.input, facts(r)).ok) : undefined;
    if (input) throw new NeedsFiles(`its game file is made from ${input.name} first (a make job does that, then the way is built)`);
    // the game's copy, of any kind: a console copy's dump, or a console file inside a PC copy or an emulator's bundle
    const cur = currentPackage(game.id);
    if (cur) {
      let serves = adeps.copyServes(game.id, content);
      if (serves.serves === "unknown") {
        ctx.progress(0.02, "looking at the game's copy");
        try { await adeps.judgeCopy(game.id); } catch (e) { log(`the game's copy could not be looked at where it is (${errText(e)}): the hand-over takes it and the way's plan judges what it took`); }
        serves = adeps.copyServes(game.id, content);
        // still not judged: what its manifest alone says it is (a folder dump, another form) is told before anything is
        // taken; a copy a make may take as its input is left to the make
        const why = serves.serves === "unknown" && !content.make && cur.kind === "rom" ? copyNameRefusal(cur.pkg, content) : null;
        if (why) throw new NeedsFiles(`the game's copy on the server is ${why}`);
      }
      if (serves.serves === "make") throw new NeedsFiles("its game file is made from the game's copy first (a make job does that, then the way is built)");
      // a copy with no console game data in it (a PC game's own copy) says nothing of the way's file: the words below do
      const holdsData = cur.kind === "rom" || (adeps.copyFacts(game.id)?.entries.length ?? 0) > 0;
      if (serves.serves === "no" && holdsData) throw new NeedsFiles(`the game's copy on the server is ${serves.why}`);
      // the copy is the way's file as it is ('direct'; or, for a console copy, not known after a look that failed, when what
      // the hand-over takes is judged below): taken by a hard link (a copy only across volumes) and hashed where it is
      const row = serves.serves === "direct" || (serves.serves === "unknown" && cur.kind === "rom") ? await (async () => {
        ctx.progress(0.03, "taking the game file from the game's copy");
        return adeps.contentFromPackage({
          way, game, pkg: cur.pkg, log, content, signal: ctx.signal,
          // the step it is on ("hashing the game's copy", "copying the game's copy") when the hand-over says it
          progress: (done, total, step) => ctx.progress(0.03 + 0.06 * (total ? Math.min(1, done / total) : 0), `${step ?? "taking the game file from the game's copy"} · ${ofTotal(done, total)}`),
        });
      })() : null;
      if (row) {
        // the copy is kept for the game now, so the game's other ways that check by hash know whether it is their file
        settleWaysOnCopy(game.id);
        // the copy becomes the way's file only when it is the one the way takes: a refused copy stays kept for the game
        // (so the way knows it is not its file) but is never the way's
        const v = contentMatches(content, facts(row));
        if (!v.ok) throw new NeedsFiles(`the game's console copy ${row.name} is ${v.why}`);
        updateWay(way.id, { contentId: row.id });
        file = row;
      }
    }
  }
  if (!file) throw new NeedsFiles("no game file yet: upload one, or pick one on the server");
  // a game folder for a way that takes one file, or one file for a way that takes a game folder, is never placed
  if ((content.kind === "folder") !== (file.shape === "folder")) throw new NeedsFiles(`the game file ${file.name} is ${file.shape === "folder" ? "a folder, and this way takes one file" : "one file, and this way takes the game's folder"}`);
  const v = contentMatches(content, facts(file));
  if (!v.ok) throw new NeedsFiles(`the game file ${file.name} is ${v.why}`);
  const st = await stat(file.path).catch(() => null);
  const there = file.shape === "folder" ? !!st?.isDirectory() : !!st?.isFile() && st.size === file.size;
  if (!there) throw new NeedsFiles(`the game file ${file.name} is gone from the server, or changed on disk`);
  log(`game file ${file.name}: ${v.matched ? `${v.matched.algo} matches${v.matched.label ? ` (${v.matched.label})` : ""}` : v.serial ? `its serial is ${v.serial}` : "accepted (the plan lists no hashes)"}`);
  return file;
}

/** the program's root (the plan's folder, or one lone top folder) becomes STAGING */
async function intoStaging(acq: Acquired, pspec: RuntimePlanSpec, staging: string) {
  let src = acq.dir;
  if (pspec.root) {
    const p = join(acq.dir, ...pspec.root.split("/"));
    if (!(await lstat(p).catch(() => null))?.isDirectory()) throw new PlanFault(undefined, `the program has no folder ${pspec.root} (the plan's root)`);
    src = p;
  } else {
    const names = (await readdir(acq.dir)).filter(n => !JUNK.test(n));
    if (names.length === 1 && (await lstat(join(acq.dir, names[0]))).isDirectory()) src = join(acq.dir, names[0]);
  }
  await rm(staging, { recursive: true, force: true });
  await rename(src, staging);
}

/** the start the smoke start makes (src/ways/check.ts reads cwd as a folder of the install folder, none: its root): the
 *  plan's folder as the plan names it, a start set by hand in the folder players start it in (absent: the program's own) */
function smokeLaunch(s: Start, plan: boolean): LaunchPlan {
  let cwd = s.cwd;
  if (!plan) cwd = cwd === undefined ? (s.exe.includes("/") ? s.exe.slice(0, s.exe.lastIndexOf("/")) : undefined) : cwd === "{install}" ? undefined : cwd.startsWith("{install}/") ? cwd.slice("{install}/".length) : cwd;
  return { exe: s.exe, argv: [...s.argv], ...(cwd ? { cwd } : {}), ...(s.env && Object.keys(s.env).length ? { env: { ...s.env } } : {}) };
}

/** an exe the plan names, matched without regard to case (Windows does not care, the manifest must name the real file) */
async function present(root: string, rel: string): Promise<string | null> {
  const exact = await lstat(join(root, ...rel.split("/"))).catch(() => null);
  if (exact?.isFile()) return rel;
  let dir = root;
  const out: string[] = [];
  for (const part of rel.split("/")) {
    const hit = (await readdir(dir).catch(() => [] as string[])).find(n => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    out.push(hit);
    dir = join(dir, hit);
  }
  return (await lstat(dir).catch(() => null))?.isFile() ? out.join("/") : null;
}

/** the plan's files with the way's own over them (same path: the way's wins) */
function mergeFiles(plan: PlanFile[], own: PlanFile[]): PlanFile[] {
  const by = new Map<string, PlanFile>();
  for (const f of [...plan, ...own]) by.set(f.path, f);
  return [...by.values()];
}

/** the plan's built helpers, copied where the build user can run them (it cannot reach <config>); not built yet → the
 *  build job builds them first (NeedsBuild) */
async function copyTools(plan: PlanRow, pinned: PinnedProgram, pspec: RuntimePlanSpec, work: string): Promise<string> {
  const t = pspec.tools;
  const dir = t ? await findTools(plan, pinned, t.ref) : null;
  if (!t || !dir) throw new NeedsBuild("needs its tools built");
  const to = join(work, "tools");
  await cp(dir, to, { recursive: true });
  for (const o of t.outputs) {
    const p = join(to, ...o.split("/"));
    if (!(await lstat(p).catch(() => null))?.isFile()) throw new NeedsBuild(`needs its tools built (${o} is missing from the build)`);
    await chmod(p, 0o755).catch(() => {});
  }
  return to;
}

interface StepCtx {
  staging: string; work: string; contentPath: string | null; toolsAt: string | null; signal: AbortSignal; log: (line: string) => void;
  /** told every 5 seconds while a step's program runs, with the time it has run */
  heartbeat?: (since: string) => void;
}

async function runSetupStep(step: SetupStep, i: number, s: StepCtx): Promise<void> {
  const n = i + 1;
  if ("ini" in step) {
    const { path, section, key, value } = step.ini;
    const abs = await inside(s.staging, path, { create: true });
    const st = await lstat(abs).catch(() => null);
    if (st && !st.isFile()) throw new PlanFault("setup", `setup step ${n}: ${path} is not a file`);
    const buf = st ? await readFile(abs) : Buffer.alloc(0);
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) throw new PlanFault("setup", `setup step ${n}: ${path} is UTF-16, which the ini step does not edit`);
    const next = setIni(buf.toString("utf8"), section, key, value);
    if (st) await unlink(abs);
    await writeFile(abs, next, { flag: "wx" });
    s.log(`setup ${n}: ${path} [${section}] ${key} = ${value}`);
    return;
  }
  if ("remove" in step) {
    const matches: string[] = [];
    for await (const rel of new Bun.Glob(step.remove).scan({ cwd: s.staging, onlyFiles: false, dot: true, followSymlinks: false })) matches.push(rel.replace(/\\/g, "/"));
    for (const rel of matches.sort((a, b) => b.length - a.length)) {
      const abs = await inside(s.staging, rel, { found: true }).catch(() => null);
      if (abs) await removeTree(abs);
    }
    s.log(`setup ${n}: removed ${matches.length ? `${matches.length} (${matches.slice(0, 4).join(", ")}${matches.length > 4 ? " …" : ""})` : "nothing (no match)"} for ${step.remove}`);
    return;
  }
  if ("move" in step) {
    const from = await inside(s.staging, step.move.from);
    const st = await lstat(from).catch(() => null);
    if (!st) throw new PlanFault("setup", `setup step ${n}: there is no ${step.move.from} to move`);
    const to = await inside(s.staging, step.move.to, { create: true });
    if (await lstat(to).catch(() => null)) throw new PlanFault("setup", `setup step ${n}: ${step.move.to} is already there`);
    await rename(from, to);
    s.log(`setup ${n}: moved ${step.move.from} → ${step.move.to}`);
    return;
  }
  const r = step.run;
  if (!sandboxOrAllowed()) throw new EnvError("tool", "setup steps need the build sandbox");
  let exe: string, inStage = false;
  if (r.tool) {
    if (!s.toolsAt) throw new NeedsBuild("needs its tools built");
    exe = join(s.toolsAt, ...r.tool.split("/"));
  } else {
    const rel = r.exe!;
    const local = r.wine || rel.includes("/") || !!(await lstat(join(s.staging, rel)).catch(() => null));
    if (local) {
      const found = await present(s.staging, rel);
      if (!found) throw new PlanFault("setup", `setup step ${n}: the program has no ${rel}`);
      exe = await inside(s.staging, found);
      inStage = true;
    } else exe = rel;                                                               // a Linux tool found on the sandbox's PATH
  }
  const d = sandboxDirs(s.work);
  const at = (p: string) => (r.wine ? winPath(p) : p);
  // one pass, each value as it is: a '$' in a path is no replacement pattern, and a filled-in path is never filled again
  const fill: Record<string, () => string> = { stage: () => at(s.staging), work: () => at(d.scratch), content: () => (s.contentPath ? at(s.contentPath) : "{content}") };
  const t0 = Date.now();
  const beat = s.heartbeat ? setInterval(() => s.heartbeat!(span(Date.now() - t0)), 5000) : null;
  // below what the library keeps free the step is stopped (EnvError 'room': the build is tried again once there is room)
  const room = roomWatch(s.work, `setup step ${n}`, s.signal);
  try {
    await runSandboxedStep(r, {
      exe, cwd: s.staging, fill, work: s.work, signal: room.signal, log: s.log,
      ...(inStage ? { wine: { cwd: dirname(exe) } } : {}),
      name: { log: `setup ${n}`, error: `setup step ${n}` },
      unfilled: () => `setup step ${n} needs the game file, and the way has none`,
      phase: "setup",
    });
  } catch (e) {
    throw room.short() ?? e;
  } finally { if (beat) clearInterval(beat); room.done(); }
}

/** the steps above, for the construct agent's dry run (src/ways/construct-tools.ts try_plan): the same code, so a plan that
 *  passes there is set up here exactly as it was tried */
export const assembleParts = { intoStaging, present, mergeFiles, runSetupStep, treeOf, textOf, placeCopy, placeText };
export type { StepCtx };
