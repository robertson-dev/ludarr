/**
 * ludarr — building a plan's program on this server (job kind 'build', spec {planId, wayId?, then?}). Deterministic: the
 * steps were recorded when the plan was made (by the admin or the construct agent); no model runs.
 *
 *   source plan     a fresh checkout of program.ref with its submodules, the plan's apt packages installed (as ludarr,
 *                   from an allowlist), its steps run as the build user, the artifact folder packed into
 *                   <config>/ways/builds/<slug>-<commit>.tar and pinned {tag '<ref>@<commit>', asset, url 'build:…', size,
 *                   sha256}; the plan is ready (src/ways/program.ts takes the program from that file)
 *   its tools       the same at tools.ref ({tag} is the pinned program's tag) → <config>/ways/tools/<slug>/<commit>/ with
 *                   the outputs and tools.json {ref, commit}, where assembly runs them from
 *   per game        a plan whose build needs the game file is built once per way, with that way's verified file, and kept
 *                   beside the file in the game's content store folder (never in the shared builds folder: the result
 *                   holds the game's own data):
 *                     a source plan with program.content 'build' (sm64ex): kept as <slug>-<commit>-<recipe>-<sha1>.tar
 *                     a release kit (program.perGame, NX2navi): the kit as pinned, its pinned fetches, its steps (under
 *                     wine when it says so), the install folder it makes kept as a FOLDER
 *                     .builds/<slug>-<kit sha256 12>-<recipe 8>-<file sha256 12>/ with <same>.json beside it (each file's
 *                     sha256 and the stat it was hashed with), placed into a package by a tree of hard links
 *                   A per-game build never runs inside an assemble (it can take hours): the build job does it in its own
 *                   lane, and with then:'assemble' queues the way's assemble once it is kept; a changed kit, recipe or
 *                   file is built again, and an earlier build of the same plan for the same file is removed.
 *
 * Everything from the repo or the kit runs in the build sandbox (src/ways/sandbox.ts): git (https to public hosts only,
 * every submodule address checked first, no redirects), the steps, unpacking a fetch or a kept build. Only apt-get and tar
 * (packing) run as ludarr itself, with an environment of their own. The game file reaches the steps read-only, by a hard
 * link (or where it is kept), never as a copy. A step runs with {jobs} = the cores, at most 16 and at most one per 2.5 GB
 * of free memory, under `prlimit --as` (each process at most 80 % of the free memory, 32 GB at most) when prlimit is
 * there; a step the system kills for memory is this server's trouble (EnvError 'oom'), a step that fails is the plan's
 * (PlanFault 'build'). A long step says what it is on and the bytes written so far every 5 seconds, and stops when the
 * library would fall below what LIBRARY_KEEP_FREE_GB keeps free. A build that leaves a link in its output is refused,
 * like any package, and so is a kit's output that holds what players must not get (build caches, object and debug files,
 * a path of this server). What a build job made becomes the plan's (its pin, the plan ready) only while the plan still
 * asks for what the job read when it started; PUT /api/v1/plan/:id keeps its program, tools and repo as they are while
 * one runs.
 */
import { serverPathInFile } from "../process/portability";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { cpus, freemem } from "node:os";
import { dirname, join } from "node:path";
import { reingestCustom } from "../catalog/providers/custom";
import { stmts, type GameRow } from "../db";
import { fileChunks, removeTree, reapUnder } from "../fsutil";
import { assertPublicUrl } from "../net/public-url";
import { enqueueJob, registerJobKind, type KindContext, type KindResult } from "../process/kinds";
import { pdeps } from "../process/deps";
import { extractArchive } from "../process/recipes";
import { realExec, type Exec, type ExecResult } from "../process/tools";
import { keepFreeBytes } from "./content";
import { EnvError, failOf, NeedsBuild, NeedsFiles, PlanFault } from "./errors";
import { contentMatches } from "./match";
import { buildNeeds, buildNeedsKey, checkBuildNeedLeaks, prepareBuildNeeds, type BuildNeed } from "./build-needs";
import {
  acquireProgram, buildsDir, copyHashed, download, getCache, handOver, placeTree, prdeps, putCache, refuseLinks, toolsDir,
  type Acquired,
} from "./program";
import { buildFileProblem, handTo, sandboxDirs, sandboxed, sandboxExec, sandboxOrAllowed } from "./sandbox";
import {
  assembling, contentFacts, contentHashes, getContent, getPlan, getWay, planPinned, planSpec, settleWaysOfPlan, systemFiles, updatePlan, wayContent, wstmts,
  type ContentRow, type PlanRow, type WayRow,
} from "./store";
import type { FailInfo, HashedStat, JobSpec, KitBuild, PinnedProgram, ProgramSource, ToolBuild } from "./types";
import { aptAllowed, APT_ALLOWED, launcherPathProblem, safeRelPath, storeName } from "./validate";

/** the apt allowlist lives with the plan checks (src/ways/validate.ts), which refuse a converter that names another package */
export { aptAllowed, APT_ALLOWED };

/** how long one recorded build step may run */
export const BUILD_STEP_TIMEOUT_MS = 3 * 3600_000;
/** how long a whole build of the game from its kit may run */
export const KIT_BUILD_MAX_MS = 12 * 3600_000;
/** the largest file a kit's fetch may be */
export const KIT_FETCH_MAX_BYTES = 8 * 2 ** 30;
/** what ludarr's own commands find on PATH (apt-get, tar): nothing else of its environment goes with them */
const ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** git as the build user: https only, no redirects, no credential helpers or prompts */
const GIT_SAFE = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "advice.detachedHead=false"];
const GiB = 2 ** 30;

/** /proc/meminfo's MemAvailable (what can be had without swapping), else the free memory the system reports */
function memAvailable(): number {
  try { const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8")); if (m) return Number(m[1]) * 1024; } catch { /* not Linux */ }
  return freemem();
}
/** how many processes of this container the system has killed for want of memory so far (the cgroup's own count: v2
 *  memory.events, else v1 memory.oom_control), or null where the system does not say */
function oomKills(): number | null {
  for (const p of ["/sys/fs/cgroup/memory.events", "/sys/fs/cgroup/memory/memory.oom_control"]) {
    try { const m = /^oom_kill\s+(\d+)$/m.exec(readFileSync(p, "utf8")); if (m) return Number(m[1]); } catch { /* not there */ }
  }
  return null;
}

/** swapped in tests: commands that run as ludarr itself (apt-get, tar), and what the build sees of this server */
export const bdeps = {
  rootExec: realExec as Exec,
  /** apt-get update ran in this process (the container): it runs once per container run */
  aptUpdated: false,
  cores: (): number => cpus().length || 1,
  memAvailable: (): number => memAvailable(),
  which: (name: string): string | null => Bun.which(name),
  oomKills: (): number | null => oomKills(),
  /** how often a long step says what it is doing (and looks at the free space) */
  beatMs: 5000,
};

/** a build that cannot go on; what kind of failure it is (src/ways/errors.ts failOf) is the plan's build unless it says */
export class BuildError extends Error {
  constructor(msg: string, private readonly why: FailInfo = { class: "plan", phase: "build" }) { super(msg); }
  get fail(): FailInfo { return this.message === "cancelled" ? { class: "cancelled" } : { ...this.why }; }
}
const OTHER: FailInfo = { class: "other" };

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const gbText = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : mb(n));
/** a size in words, small ones in KB */
const sizeText = (n: number) => (n >= 1e6 ? gbText(n) : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** bytes done of a total, in the total's unit: "12.3 of 54.2 GB" */
const ofTotal = (done: number, total: number) => (total >= 1e9 ? `${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB` : `${(done / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`);
const nowSec = () => Math.floor(Date.now() / 1000);
const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ").slice(-300);
/** a path for a shell command, quoted */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sha256Of = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const errText = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e);
/** a time span in words ("40 s", "12 min", "2 h 5 min") */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* ─────────── what a step may use of this server ─────────── */

/**
 * The parallel jobs a build step gets ({jobs}: the cores, at most 16, at most one per 2.5 GB of free memory, at least one),
 * the address space each of its processes may take (80 % of the free memory, at most 32 GB), and prlimit when it is
 * there to hold them to it.
 */
export function stepLimits(): { jobs: number; asBytes: number; prlimit: string | null } {
  const mem = Math.max(0, Number(bdeps.memAvailable()) || 0);
  const jobs = Math.max(1, Math.min(Math.max(1, Math.floor(bdeps.cores())), 16, Math.floor(mem / (2.5 * GiB))));
  const asBytes = Math.min(32 * GiB, Math.floor(mem * 0.8));
  return { jobs, asBytes, prlimit: asBytes >= GiB ? bdeps.which("prlimit") : null };
}
export type StepLimits = ReturnType<typeof stepLimits>;
/** a step's command, held to the address-space cap when prlimit is there */
function limited(cmd: string[], l: StepLimits): string[] {
  return l.prlimit ? [l.prlimit, `--as=${l.asBytes}`, "--", ...cmd] : cmd;
}
/** whether a step that failed lost a process to the system for want of memory: the container's own kill count went up while
 *  it ran; where the system keeps no count, an exit of 137 or the shell's word for a killed process in its last lines (a
 *  compiler killed inside `make -j` ends the step with make's own exit, not 137) */
function oomKilled(r: ExecResult, oomBefore: number | null): boolean {
  if (r.code === 137) return true;
  const now = oomBefore === null ? null : bdeps.oomKills();
  if (oomBefore !== null && now !== null) return now > oomBefore;
  return /(^|\s)Killed(\s|$)/m.test((r.stderr || r.stdout).trim().split("\n").slice(-20).join("\n"));
}
/** why a step's run is a failure, as the error the caller throws: a timeout or a non-zero exit is the plan's (its
 *  recipe), a kill for memory (the container's kill count, 137) or an instruction the CPU lacks (SIGILL, 132) is this
 *  server's. `oomBefore`: the kill count as the step started (bdeps.oomKills) */
function stepFailure(r: ExecResult, what: string, timeoutSec: number, oomBefore: number | null = null): Error | null {
  const t = tail(r);
  if (r.timedOut) return new PlanFault("build", `${what} ran out of time (${timeoutSec} s)${t ? `: ${t}` : ""}`);
  if (r.code === 0) return null;
  if (oomKilled(r, oomBefore)) return new EnvError("oom", `${what} was stopped by the system for want of memory (exit ${r.code}): it runs again when the server has more free${t ? ` (${t})` : ""}`);
  if (r.code === 132) return new EnvError("cpu", `${what} stopped on an instruction this server's processor does not have (exit 132)${t ? `: ${t}` : ""}`);
  return new PlanFault("build", `${what} failed (exit ${r.code})${t ? `: ${t}` : ""}`);
}

/**
 * A long step's heartbeat: every bdeps.beatMs (5 s) what it is on, how long it has run and what it has written so far (the
 * drop in the free space of the volume it writes on), and on every second beat whether the library would fall below what
 * LIBRARY_KEEP_FREE_GB keeps free — then `signal` stops the step and short() says why. done() ends it.
 */
async function heartbeat(o: { work: string; label: string; keep: number; signal?: AbortSignal; say?: (message: string) => void; bytes?: boolean }) {
  const t0 = Date.now(), free0 = o.bytes === false ? null : await freeOn(o.work);
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (o.signal?.aborted) stop.abort(); else o.signal?.addEventListener("abort", onAbort, { once: true });
  let short: EnvError | null = null, beats = 0, busy = false;
  const beat = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const free = o.bytes === false && !o.keep ? null : await freeOn(o.work);
      const written = free0 !== null && free !== null ? Math.max(0, free0 - free) : null;
      o.say?.(`${o.label} · ${written !== null ? `${gbText(written)} written · ` : ""}${span(Date.now() - t0)}`);
      if (++beats % 2 === 0 && !short && free !== null && o.keep > 0 && free < o.keep) { short = noRoom(free, o.keep); stop.abort(); }
    } catch { /* a heartbeat never stops a step */ } finally { busy = false; }
  }, bdeps.beatMs);
  return { signal: stop.signal, short: () => short, done: () => { clearInterval(beat); o.signal?.removeEventListener("abort", onAbort); } };
}

/* ─────────── apt ─────────── */

export const aptRefused = (names: string[]): string[] => names.filter(n => !aptAllowed(n));

/** builds running side by side take turns with apt (dpkg has one lock) */
let aptTurn: Promise<unknown> = Promise.resolve();

/** the packages a plan's build needs, installed as ludarr (apt-get update first, once per container run) */
export async function aptInstall(names: string[], o: { signal?: AbortSignal; log: (line: string) => void }): Promise<void> {
  const want = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  if (!want.length) return;
  const refused = aptRefused(want);
  if (refused.length) throw new BuildError(`${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not on the build allowlist (${APT_ALLOWED})`);
  const env = { PATH: process.platform === "win32" ? process.env.PATH ?? "" : ROOT_PATH, DEBIAN_FRONTEND: "noninteractive", LANG: "C.UTF-8" };
  const run = (cmd: string[]) => bdeps.rootExec(cmd, { env, inheritEnv: false, timeoutMs: 30 * 60_000, signal: o.signal, maxOutput: 20_000 });
  const mine = aptTurn.then(async () => {
    if (!bdeps.aptUpdated) {
      o.log("apt-get update");
      const u = await run(["apt-get", "-o", "DPkg::Lock::Timeout=300", "update"]);
      if (u.code !== 0) throw new BuildError(`apt-get update failed (exit ${u.code}${u.timedOut ? ", timed out" : ""}): ${tail(u)}`, { class: "env", kind: "net" });
      bdeps.aptUpdated = true;
    }
    o.log(`installing the build packages: ${want.join(" ")}`);
    const r = await run(["apt-get", "-o", "DPkg::Lock::Timeout=300", "install", "-y", "--no-install-recommends", "--", ...want]);
    if (r.code !== 0) throw new BuildError(`apt-get install failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${tail(r)}`);
  });
  aptTurn = mine.catch(() => {});
  await mine;
}

/* ─────────── git ─────────── */

/** the https address a repo is cloned from */
export function cloneUrl(repo: string): string {
  const forge = /^forgejo:([^/]+)\/([^/]+)\/([^/]+)$/.exec(repo);
  if (forge) return `https://${forge[1]}/${forge[2]}/${forge[3]}.git`;
  if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return `https://github.com/${repo}.git`;
  throw new BuildError(`${repo} cannot be cloned (a GitHub owner/name or a forgejo:host/owner/name repo)`);
}

interface GitOpts { work: string; signal?: AbortSignal; log?: (line: string) => void }
function git(args: string[], o: GitOpts & { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
  return sandboxExec(["git", ...GIT_SAFE, ...args], {
    work: o.work, cwd: o.cwd, signal: o.signal, timeoutMs: o.timeoutMs ?? 30 * 60_000, maxOutput: 20_000,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
  });
}
async function gitOk(args: string[], o: GitOpts & { cwd?: string; timeoutMs?: number }, what: string): Promise<ExecResult> {
  const r = await git(args, o);
  if (o.signal?.aborted) throw new BuildError("cancelled");
  if (r.code !== 0) throw new BuildError(`${what} failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${tail(r)}`);
  return r;
}

/** a submodule's address, resolved like git resolves it (relative to the repo it belongs to), and checked: https to a public host */
async function submoduleUrl(raw: string, parentUrl: string): Promise<string> {
  const url = /^\.\.?\//.test(raw) ? new URL(raw, parentUrl.replace(/\/*$/, "/")).toString() : raw;
  if (!/^https:\/\//i.test(url)) throw new BuildError(`a submodule is fetched from ${url.slice(0, 120)}: only https addresses are cloned`);
  try { await assertPublicUrl(url); } catch (e) { throw new BuildError(`a submodule's address is refused: ${(e as Error).message}`); }
  return url;
}

/** the submodules of a checkout, each address checked before git fetches it, level by level (at most four deep) */
async function initSubmodules(dir: string, url: string, o: GitOpts, prefix = "", depth = 0): Promise<string[]> {
  if (!(await lstat(join(dir, ".gitmodules")).catch(() => null))?.isFile()) return [];
  if (depth >= 4) throw new BuildError("the submodules are nested more than four deep");
  const r = await git(["-C", dir, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(url|path)$"], o);
  const mods = new Map<string, { url?: string; path?: string }>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^submodule\.(.+)\.(url|path)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const e = mods.get(m[1]) ?? {};
    e[m[2] as "url" | "path"] = m[3].trim();
    mods.set(m[1], e);
  }
  if (!mods.size) return [];
  const checked: { path: string; url: string }[] = [];
  for (const [name, e] of mods) {
    if (!e.url || !e.path) throw new BuildError(`submodule ${name} has no ${e.url ? "path" : "address"}`);
    const pe = safeRelPath(e.path);
    if (pe) throw new BuildError(`submodule ${name}: its path ${pe}`);
    checked.push({ path: e.path, url: await submoduleUrl(e.url, url) });
  }
  o.log?.(`submodules${prefix ? ` of ${prefix}` : ""}: ${checked.map(c => c.path).join(", ")}`);
  const upd = await git(["-C", dir, "submodule", "update", "--init", "--depth", "1"], o);
  if (upd.code !== 0) {
    // a host that will not hand out a commit by itself at depth 1: the submodules' whole history then
    o.log?.(`a shallow submodule fetch failed (${tail(upd)}); fetching them whole`);
    await gitOk(["-C", dir, "submodule", "update", "--init"], o, "fetching the submodules");
  }
  const out: string[] = [];
  for (const c of checked) {
    out.push(prefix ? `${prefix}/${c.path}` : c.path);
    out.push(...await initSubmodules(join(dir, ...c.path.split("/")), c.url, o, prefix ? `${prefix}/${c.path}` : c.path, depth + 1));
  }
  return out;
}

/**
 * A fresh checkout of `repo` at `ref` (a tag, a branch or a full commit; null = the default branch) in `dest`, with its
 * submodules, as the build user. Returns the commit it is at.
 */
export async function cloneRepo(repo: string, ref: string | null, dest: string, o: GitOpts): Promise<{ commit: string; submodules: string[] }> {
  if (ref !== null && (!/^[A-Za-z0-9._\/-]{1,100}$/.test(ref) || ref.includes("..") || ref.startsWith("-"))) throw new BuildError(`"${ref}" is not a tag, branch or commit`);
  const url = cloneUrl(repo);
  try { await assertPublicUrl(url); }
  catch (e) {
    const msg = (e as Error).message;
    // a host name that does not resolve now is this server's network trouble; an address that is not public is the plan's
    if (/does not resolve/.test(msg)) throw new EnvError("net", `the repo's host cannot be reached now: ${msg}`);
    throw new BuildError(`the repo's address is refused: ${msg}`);
  }
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await handTo(dest, "builder");
  o.log?.(`cloning ${repo}${ref ? ` at ${ref}` : ""}`);
  if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
    await gitOk(["init", "-q", dest], o, "git init");
    await gitOk(["-C", dest, "remote", "add", "origin", url], o, "git remote");
    await gitOk(["-C", dest, "fetch", "--depth", "1", "origin", ref], o, `fetching ${ref.slice(0, 12)}`);
    await gitOk(["-C", dest, "checkout", "-q", "--detach", "FETCH_HEAD"], o, "git checkout");
  } else {
    await gitOk(["clone", "--depth", "1", "--single-branch", ...(ref ? ["--branch", ref] : []), "--", url, dest], o, `cloning ${repo}`);
  }
  const head = await gitOk(["-C", dest, "rev-parse", "HEAD"], o, "git rev-parse");
  const commit = head.stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new BuildError("git did not say which commit it checked out", OTHER);
  const submodules = await initSubmodules(dest, url, o);
  return { commit: commit.toLowerCase(), submodules };
}

/* ─────────── steps, packing ─────────── */

export interface StepsOpts { work: string; cwd: string; signal?: AbortSignal; log: (line: string) => void; progress?: (p: number, message: string) => void; content?: string | null; what?: string }

/** recorded build steps, one bash command each, as the build user in the checkout ({content}: the game file, quoted) —
 *  only in the build sandbox (or where its owner said so): they come from someone's repo, or the AI wrote them. A step
 *  says every 5 seconds how long it has run and what it has written, and stops when the library would fall below what is
 *  kept free */
export async function runSteps(steps: string[], o: StepsOpts): Promise<void> {
  if (!sandboxOrAllowed()) throw new EnvError("tool", "building from source needs the build sandbox (ludarr's Docker image)");
  const bash = pdeps.tools().bash ?? "bash";
  const limits = stepLimits();
  const jobs = String(limits.jobs);
  const what = o.what ?? "build";
  const keep = keepFreeBytes();
  for (const [i, step] of steps.entries()) {
    // the path goes in as it is: a '$' in it is no replacement pattern
    const cmd = step.replace(/\{content\}/g, () => (o.content ? shq(o.content) : "{content}"));
    if (cmd.includes("{content}")) throw new BuildError(`${what} step ${i + 1} needs the game file, and there is none here`);
    o.log(`${what} ${i + 1}/${steps.length}: ${step}`);
    const at = i / Math.max(1, steps.length), label = `${what === "build" ? "building" : `building the ${what}`} (step ${i + 1} of ${steps.length})`;
    o.progress?.(at, label);
    const hb = await heartbeat({ work: o.work, label, keep, signal: o.signal, say: m => o.progress?.(at, m) });
    const oom = bdeps.oomKills();
    let r: ExecResult;
    try { r = await sandboxExec(limited([bash, "-c", cmd], limits), { work: o.work, cwd: o.cwd, signal: hb.signal, timeoutMs: BUILD_STEP_TIMEOUT_MS, maxOutput: 8000, env: { MAKEFLAGS: `-j${jobs}`, CMAKE_BUILD_PARALLEL_LEVEL: jobs } }); }
    finally { hb.done(); }
    if (o.signal?.aborted) throw new BuildError("cancelled");
    const short = hb.short();
    if (short) throw short;
    if (r.timedOut) { const t = tail(r); throw new PlanFault("build", `${what} step ${i + 1} ran out of time${t ? `: ${t}` : ""}`); }
    const bad = stepFailure(r, `${what} step ${i + 1}`, BUILD_STEP_TIMEOUT_MS / 1000, oom);
    if (bad) throw bad;
  }
}

/** size and sha256 of a file, read once (the bytes so far told as it goes; a cancel stops it between chunks) */
export async function fileSum(path: string, onBytes?: (done: number) => void, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
  const h = new Bun.CryptoHasher("sha256");
  let size = 0;
  if (signal?.aborted) throw new BuildError("cancelled");
  for await (const chunk of fileChunks(path)) {
    size += chunk.byteLength; h.update(chunk);
    onBytes?.(size);
    if (signal?.aborted) throw new BuildError("cancelled");
  }
  return { size, sha256: h.digest("hex") };
}

/** a built folder packed into one tar file (as ludarr, after the build user has handed it back), refused when it holds a link */
export async function packTar(dir: string, dest: string, o: { signal?: AbortSignal; log: (line: string) => void }): Promise<{ size: number; sha256: string }> {
  await refuseLinks(dir, "the build", { allow: () => false });
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part-${process.pid}-${Date.now()}`;
  const env = { PATH: process.platform === "win32" ? process.env.PATH ?? "" : ROOT_PATH, LANG: "C.UTF-8" };
  const r = await bdeps.rootExec(["tar", "--format=posix", "--numeric-owner", "--owner=0", "--group=0", "-C", dir, "-cf", part, "."], { env, inheritEnv: false, timeoutMs: 3600_000, signal: o.signal, maxOutput: 8000 });
  if (r.code !== 0 || !(await stat(part).catch(() => null))?.isFile()) { await rm(part, { force: true }).catch(() => {}); throw new BuildError(`packing the build failed (exit ${r.code}): ${tail(r)}`, OTHER); }
  const sum = await fileSum(part);
  await rename(part, dest);
  o.log(`packed ${dest.split(/[\\/]/).pop()} (${mb(sum.size)}, sha256 ${sum.sha256.slice(0, 12)}…)`);
  return sum;
}

/** the checkout-relative artifact folder, which must be a folder inside the checkout; only the .git folders are dropped
 *  from it (.git/config names the repo): everything else in it ships, so an artifact "." ships the whole checkout */
async function artifactIn(src: string, artifact: string): Promise<string> {
  const dir = artifact === "." || artifact === "" ? src : join(src, ...artifact.split("/"));
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new BuildError(`the build left no folder ${artifact} (the plan's artifact)`);
  const walk = async (d: string) => {
    for (const n of await readdir(d).catch(() => [] as string[])) {
      const p = join(d, n);
      if (n === ".git") { await rm(p, { recursive: true, force: true }); continue; }
      const s = await lstat(p).catch(() => null);
      if (s?.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  return dir;
}

/* ─────────── a source program, its tools ─────────── */

export interface Built { dir: string; commit: string; src: string }

/** a source program built in `work`: checkout, packages, steps, the artifact folder handed back to ludarr */
export async function buildSource(o: { repo: string; program: Extract<ProgramSource, { kind: "source" }>; ref?: string | null; work: string; signal?: AbortSignal; log: (line: string) => void; progress?: (p: number, m: string) => void; content?: string | null }): Promise<Built> {
  const src = join(o.work, "src");
  o.progress?.(0.02, "getting the source");
  const { commit } = await cloneRepo(o.repo, o.ref ?? o.program.ref, src, { work: o.work, signal: o.signal, log: o.log });
  if (o.program.apt?.length) { o.progress?.(0.08, "installing the build packages"); await aptInstall(o.program.apt, { signal: o.signal, log: o.log }); }
  try {
    await runSteps(o.program.steps, { work: o.work, cwd: src, signal: o.signal, log: o.log, content: o.content, progress: (p, m) => o.progress?.(0.1 + 0.8 * p, m) });
  } finally { await handTo(src, "root"); }
  return { dir: await artifactIn(src, o.program.artifact), commit, src };
}

/** a plan's native helpers built at `ref` in `work`; their outputs must all be there */
export async function buildTools(o: { repo: string; tools: ToolBuild; ref: string; work: string; signal?: AbortSignal; log: (line: string) => void; progress?: (p: number, m: string) => void }): Promise<Built> {
  const src = join(o.work, "tools-src");
  const { commit } = await cloneRepo(o.repo, o.ref, src, { work: o.work, signal: o.signal, log: o.log });
  if (o.tools.apt?.length) await aptInstall(o.tools.apt, { signal: o.signal, log: o.log });
  try {
    await runSteps(o.tools.steps, { work: o.work, cwd: src, signal: o.signal, log: o.log, what: "tools", progress: o.progress });
  } finally { await handTo(src, "root"); }
  for (const out of o.tools.outputs) {
    const st = await lstat(join(src, ...out.split("/"))).catch(() => null);
    if (!st?.isFile()) throw new BuildError(`the tools build left no ${out}`);
  }
  return { dir: src, commit, src };
}

/** the ref a plan's tools are built at, and the one assembly looks them up by: tools.ref with {tag} the program's pinned tag;
 *  a source program's tag is '<ref>@<commit>', and its tools are cloned at that commit */
export function toolsRefs(tools: ToolBuild, tag: string): { clone: string; lookup: string } {
  const lookup = tools.ref.replace(/\{tag\}/g, tag);
  const commit = /@([0-9a-f]{40})$/.exec(tag)?.[1];
  return { clone: tools.ref.includes("{tag}") && commit ? tools.ref.replace(/\{tag\}/g, commit) : lookup, lookup };
}

/** a source program's build kept for the plan: <builds>/<slug>-<commit short>.tar, and the pin that names it */
export async function keepBuild(plan: Pick<PlanRow, "slug">, built: Built, ref: string, o: { signal?: AbortSignal; log: (line: string) => void }): Promise<PinnedProgram> {
  const name = storeName(`${plan.slug}-${built.commit.slice(0, 7)}.tar`);
  const sum = await packTar(built.dir, join(buildsDir(), name), o);
  return { tag: `${ref}@${built.commit}`, asset: name, url: `build:${name}`, size: sum.size, sha256: sum.sha256, digest: null, immutable: null, pinnedAt: nowSec() };
}

/** a build packed earlier (a dry run's, before its folder became an install folder) kept for the plan the same way */
export async function keepPacked(plan: Pick<PlanRow, "slug">, packed: { path: string; size: number; sha256: string }, commit: string, ref: string): Promise<PinnedProgram> {
  const name = storeName(`${plan.slug}-${commit.slice(0, 7)}.tar`);
  const dest = join(buildsDir(), name), part = `${dest}.part-${process.pid}-${Date.now()}`;
  await mkdir(buildsDir(), { recursive: true });
  await copyFile(packed.path, part);
  const sum = await fileSum(part);
  if (sum.sha256 !== packed.sha256) { await rm(part, { force: true }); throw new BuildError("the dry run's build changed before it was kept", OTHER); }
  await rename(part, dest);
  return { tag: `${ref}@${commit}`, asset: name, url: `build:${name}`, size: sum.size, sha256: sum.sha256, digest: null, immutable: null, pinnedAt: nowSec() };
}

/** a plan's built helpers kept where assembly runs them from: <tools>/<slug>/<commit>/ with tools.json {ref, commit} */
export async function keepTools(plan: Pick<PlanRow, "slug">, built: Built, lookupRef: string, outputs: string[]): Promise<string> {
  const to = join(toolsDir(), storeName(plan.slug), built.commit);
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  for (const out of outputs) {
    // the build's output is taken only when it is a plain file of its own: a link there (one the build planted at its
    // declared output, pointing at a file of root's) is refused, never followed — root copies out nothing it was tricked into
    const bad = await buildFileProblem(built.dir, out);
    if (bad) { await rm(to, { recursive: true, force: true }); throw new BuildError(`the tools build's ${out} is not a file of its own: ${bad}`); }
    const target = join(to, ...out.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(built.dir, ...out.split("/")), target);
  }
  await writeFile(join(to, "tools.json"), JSON.stringify({ ref: lookupRef, commit: built.commit, outputs, builtAt: nowSec() }, null, 2));
  return to;
}

/* ─────────── a build per way: what is kept, and whether one is needed ─────────── */

const SHORT = 12;
/** what a build per game is made from besides its commit and its game file: the recorded steps, the packages and the
 *  artifact folder, as a short hash (a changed recipe never takes a build kept from another) */
export const recipeKey = (prog: Extract<ProgramSource, { kind: "source" }>) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify({ steps: prog.steps, apt: prog.apt ?? [], artifact: prog.artifact })).digest("hex").slice(0, 8);
/** <slug>-<commit>-<recipe>-<sha1>.tar: the file's sha1 last, so the builds of one plan for one file are found by it */
const buildName = (slug: string, commit: string, recipe: string, sha1: string) => storeName(`${slug}-${commit.slice(0, SHORT)}-${recipe}-${sha1.slice(0, SHORT)}.tar`);

/** a release kit's recipe as a short hash: what it fetches, its steps, wine, the CPU level and the install folder (its
 *  per-step time is not in it: it changes nothing a build makes) */
export const kitRecipe = (kit: KitBuild, inputs: BuildNeed[] = []): string =>
  sha256Of(JSON.stringify({ fetch: (kit.fetch ?? []).map(f => ({ url: f.url, sha256: f.sha256, to: f.to, unpack: f.unpack ?? null })), steps: kit.steps, wine: !!kit.wine, cpu: kit.cpu ?? null, artifact: kit.artifact, ...(inputs.length ? { inputs: buildNeedsKey(inputs) } : {}) })).slice(0, 8);
/** the plan's kit, when its program is a release asset or a fixed file that builds the game per way */
export const kitOf = (prog: ProgramSource): KitBuild | null => (prog.kind === "release" || prog.kind === "url" ? prog.perGame ?? null : null);
/** the sha256 of the kit a build of the plan would use now: the pinned asset's, or a fixed file's own */
const kitShaOf = (plan: PlanRow, prog: ProgramSource): string | null => planPinned(plan)?.sha256 || (prog.kind === "url" ? prog.sha256 : null);
/** the game file's digest a kept build is keyed by: its sha256 (a folder's: of its canonical listing) */
const fileDigest = (file: ContentRow): string | null => contentHashes(file).sha256 ?? null;
const kitBuildName = (slug: string, kitSha: string, recipe: string, fileSha: string) => storeName(`${slug}-${kitSha.slice(0, SHORT)}-${recipe}-${fileSha.slice(0, SHORT)}`);
/** a game file's store folder (the builds made from it are kept there), refused when the file is not in the store */
function storeDirOf(file: ContentRow): string {
  const dir = dirname(file.path);
  if (!dir.split(/[\\/]/).includes(".ahoy-content")) throw new BuildError("the game file is not in the content store", { class: "file" });
  return dir;
}

/** what is kept with a build of the game from its kit: its key, and each file with the sha256 and the stat it was hashed with */
export interface KitRecord { kit: string; tag: string; recipe: string; file: string; builtAt: number; size: number; files: { rel: string; size: number; sha256: string; stat: HashedStat }[] }
function readKitRecord(dir: string, key: { kit: string; recipe: string; file: string }): KitRecord | null {
  try {
    const rec = JSON.parse(readFileSync(`${dir}.json`, "utf8")) as KitRecord;
    if (rec.kit !== key.kit || rec.recipe !== key.recipe || rec.file !== key.file || !Array.isArray(rec.files)) return null;
    return statSync(dir).isDirectory() ? rec : null;
  } catch { return null; }
}
/** the build of the game from its kit kept for this file, for the kit and recipe the plan names now, or null */
export function keptKitBuild(plan: PlanRow, file: ContentRow): { dir: string; record: KitRecord } | null {
  const prog = planSpec(plan).program, kit = kitOf(prog);
  const kitSha = kit ? kitShaOf(plan, prog) : null, fileSha = fileDigest(file);
  if (!kit || !kitSha || !fileSha) return null;
  let base: string;
  try { base = storeDirOf(file); } catch { return null; }
  const inputs = buildNeeds(planSpec(plan), systemFiles(plan.id));
  if (inputs.some(i => !i.file || !existsSync(i.file.path))) return null;
  const recipe = kitRecipe(kit, inputs);
  const dir = join(base, ".builds", kitBuildName(plan.slug, kitSha, recipe, fileSha));
  const record = readKitRecord(dir, { kit: kitSha, recipe, file: fileSha });
  return record ? { dir, record } : null;
}
/** the pinned commit of a plan built per game from source ('<ref>@<commit>'), or null before its first build */
const pinnedCommit = (plan: PlanRow) => /@([0-9a-f]{40})$/.exec(planPinned(plan)?.tag ?? "")?.[1] ?? null;
/** the source build kept for this file at the plan's pinned commit and recipe, or null */
export function keptSourceBuild(plan: PlanRow, file: ContentRow): string | null {
  const prog = planSpec(plan).program;
  if (prog.kind !== "source" || prog.content !== "build") return null;
  const sha1 = contentHashes(file).sha1, commit = pinnedCommit(plan);
  if (!sha1 || !commit) return null;
  let base: string;
  try { base = storeDirOf(file); } catch { return null; }
  const kept = join(base, ".builds", buildName(plan.slug, commit, recipeKey(prog), sha1));
  try { return statSync(kept).isFile() ? kept : null; } catch { return null; }
}

/**
 * Whether way `way`'s program must be built for this game before it can be assembled: the plan builds per game (a source
 * plan whose build reads the game file, or a release kit: program.perGame), the way has its game file, and no build is kept
 * for the pinned program, the recipe and that file. Then the build job runs first (src/ways/carry.ts and the Build route
 * queue it with then:'assemble'), and an assemble that is asked meanwhile ends with NeedsBuild. Synchronous and cheap.
 */
export function wayBuildNeeded(plan: PlanRow, way: WayRow): boolean {
  const prog = planSpec(plan).program;
  const kit = kitOf(prog), source = prog.kind === "source" && prog.content === "build";
  if (!kit && !source) return false;
  const file = way.content_id != null ? getContent(way.content_id) : null;
  if (!file) return false;                                     // the game file comes first: there is nothing to build with yet
  return kit ? !keptKitBuild(plan, file) : !keptSourceBuild(plan, file);
}

/* ─────────── a release kit: fetches, steps, what it makes ─────────── */

/** what a kit fetch is unpacked as when the plan does not say: by the file's name */
function unpackOf(f: NonNullable<KitBuild["fetch"]>[number], name: string): "zip" | "tar" | "tar.zst" | "none" {
  if (f.unpack) return f.unpack;
  if (/\.zip$/i.test(name)) return "zip";
  if (/\.(tar\.zst|tzst)$/i.test(name)) return "tar.zst";
  if (/\.tar$/i.test(name)) return "tar";
  return "none";
}

/** one file a kit's steps need: from the cache when it holds it, else downloaded; held to its pinned sha256 (and size)
 *  before anything runs, then unpacked as the build user into {tools}/<to> */
async function fetchKitFile(f: NonNullable<KitBuild["fetch"]>[number], i: number, n: number, o: { work: string; tools: string; signal?: AbortSignal; log: (line: string) => void; progress: (message: string) => void }): Promise<void> {
  const name = storeName(decodeURIComponent(new URL(f.url).pathname.split("/").pop() || `file-${i + 1}`));
  const dl = join(o.work, "dl");
  await mkdir(dl, { recursive: true });
  const file = join(dl, `fetch-${i + 1}-${name}`);
  let sum: { size: number; sha256: string } | null = null;
  const cached = await getCache(f.sha256, f.size ?? null);
  const label = `fetching what the build needs (${i + 1} of ${n})`;
  if (cached) {
    const total = (await stat(cached).catch(() => null))?.size ?? 0;
    let last = 0;
    sum = await copyHashed(cached, file, o.signal, done => { if (Date.now() - last >= 1000) { last = Date.now(); o.progress(`${label} · ${name}, kept on the server · ${ofTotal(done, total)}`); } }).catch(() => null);
    if (o.signal?.aborted) throw new BuildError("cancelled");
    if (sum && sum.sha256 === f.sha256) o.log(`fetch ${i + 1} of ${n}: ${name}, kept on the server (sha256 ${f.sha256.slice(0, 12)}…)`);
    else { o.log(`the kept copy of ${name} is damaged: fetching it again`); await rm(cached, { force: true }).catch(() => {}); sum = null; }
  }
  if (!sum) {
    o.log(`fetch ${i + 1} of ${n}: ${name} from ${new URL(f.url).host}`);
    o.progress(`${label} · ${name}`);
    try { sum = await download(f.url, file, { signal: o.signal, what: name, progress: (_p, m) => o.progress(`${label} · ${m.replace(/^downloading /, "")}`) }, KIT_FETCH_MAX_BYTES); }
    catch (e) {
      if (o.signal?.aborted) throw new BuildError("cancelled");
      // a host that does not answer is this server's trouble for now; a file the host does not have (the pinned address
      // is wrong, or the file is gone), an address that is not public, or a file past the cap is the plan's
      const gone = /\bHTTP (404|410)\b/.test(errText(e));
      if (!gone && failOf(e).class === "env") throw new EnvError("net", `fetching ${name} failed: ${errText(e)}`);
      throw new PlanFault("fetch", `fetching ${name} failed: ${errText(e)}${gone ? " (the host has no such file: the plan's address for it is wrong, or the file is gone)" : ""}`);
    }
    if (f.size != null && sum.size !== f.size) { await rm(file, { force: true }); throw new PlanFault("fetch", `${name} is ${sum.size} bytes, and the plan pins ${f.size}: nothing was built`); }
    if (sum.sha256 !== f.sha256) { await rm(file, { force: true }); throw new PlanFault("fetch", `${name} is not the file the plan pins (its sha256 is ${sum.sha256.slice(0, 12)}…, the plan says ${f.sha256.slice(0, 12)}…): nothing was built`); }
    await putCache(file, sum.sha256, sum.size, o.log);
  }
  const how = unpackOf(f, name);
  const dest = join(o.tools, ...f.to.split("/"));
  if (how === "none") {
    await mkdir(dirname(dest), { recursive: true });
    if (await lstat(dest).catch(() => null)) throw new PlanFault("fetch", `fetch ${i + 1} (${name}) goes to ${f.to}, and something is there already`);
    await rename(file, dest);
    return;
  }
  await mkdir(dest, { recursive: true });
  await handTo(dest, "builder");
  const exec = sandboxed(o.work);
  if (how === "tar.zst" && !bdeps.which("zstd")) throw new EnvError("tool", `${name} is packed with zstd, and zstd is not installed on this server`);
  // what it is on while it unpacks, and what it has written so far
  const hb = await heartbeat({ work: o.work, label: `${label} · unpacking ${name}`, keep: 0, signal: o.signal, say: o.progress });
  try {
    if (how === "zip") {
      try { await extractArchive({ exec, tools: prdeps.tools(), log: o.log, signal: o.signal }, file, dest); }
      catch (e) { if (o.signal?.aborted) throw new BuildError("cancelled"); throw new PlanFault("fetch", `${name} could not be unpacked as a zip: ${errText(e)}`); }
    } else {
      const r = await exec(["tar", ...(how === "tar.zst" ? ["--zstd"] : []), "-xf", file, "-C", dest], { timeoutMs: 3600_000, signal: o.signal, maxOutput: 8000 });
      if (o.signal?.aborted) throw new BuildError("cancelled");
      if (r.code !== 0) throw new PlanFault("fetch", `${name} could not be unpacked as ${how} (exit ${r.code})${tail(r) ? `: ${tail(r)}` : ""}`);
    }
  } finally { hb.done(); }
  await rm(file, { force: true }).catch(() => {});
}

/** the placeholders of a kit step, each value quoted for bash */
function fillKit(step: string, fill: Record<string, string>): string {
  return step.replace(/\{(program|content|needs|out|tools|cpu|jobs|work)\}/g, (_m, k: string) => (k === "cpu" || k === "jobs" ? fill[k] : shq(fill[k])));
}

/** the library's free space, when it can be told */
const freeOn = async (dir: string): Promise<number | null> => (await pdeps.diskSpace(dir).catch(() => null))?.free ?? null;
/** not enough room: what LIBRARY_KEEP_FREE_GB keeps free would not be */
const noRoom = (free: number, keep: number) => new EnvError("room", `not enough room: ${gbText(free)} free on the library, and ${gbText(keep)} is kept free there (Settings → General → Import → Keep free on the library)`);

/**
 * About how much a build of `plan`'s program for one game writes on the library (a release kit's per-game build, or a
 * source build that reads the game file): the largest build of this plan already kept beside a game file (a kit build's
 * record, a source build's kept tar), with a twentieth more; else the game file's own size and a tenth more (NX2navi's
 * build from a 25 GB .nup writes about 26 GB). What a build checks for before its first step, and what a carry run's room
 * ask counts for a build (src/ways/carry.ts roomNeed).
 */
export function buildNeedBytes(plan: Pick<PlanRow, "slug">, _way: Pick<WayRow, "id"> | null, file: Pick<ContentRow, "size" | "path">): number {
  let kept = 0;
  try {
    const dir = join(dirname(file.path), ".builds"), prefix = `${storeName(plan.slug)}-`;
    for (const n of readdirSync(dir)) {
      if (!n.startsWith(prefix)) continue;
      try {
        if (n.endsWith(".json")) { const rec = JSON.parse(readFileSync(join(dir, n), "utf8")) as Partial<KitRecord>; if (typeof rec.size === "number") kept = Math.max(kept, rec.size); }
        else if (n.endsWith(".tar")) kept = Math.max(kept, statSync(join(dir, n)).size);
      } catch { /* a record that cannot be read says nothing */ }
    }
  } catch { /* no builds kept yet */ }
  return kept > 0 ? Math.round(kept * 1.05) : Math.round(Math.max(0, file.size) * 1.1);
}

/** the build's own writes fit above what the library keeps free (EnvError 'room' before its first step, with the numbers):
 *  a build that would fill the library is never started only to be stopped once it has written gigabytes */
async function roomForBuild(work: string, need: number, what: string): Promise<void> {
  const keep = keepFreeBytes(), free = await freeOn(work);
  if (free === null) return;
  if (free - keep < need) throw new EnvError("room", `not enough room: ${what} writes about ${gbText(need)} on the library, and ${gbText(Math.max(0, free - keep))} is free there above the ${gbText(keep)} it keeps free (Settings → General → Import → Keep free on the library)`);
}
/** "building <plan> for <game>", for the room words */
const buildingWords = (plan: Pick<PlanRow, "name">, way: Pick<WayRow, "game_id">): string => {
  const g = stmts.gameById.get(way.game_id) as GameRow | undefined;
  return `building ${plan.name}${g ? ` for ${g.name}` : ""}`;
};

interface KitStepsOpts { work: string; cwd: string; fill: Record<string, string>; signal?: AbortSignal; log: (line: string) => void; progress: (p: number, message: string) => void; deadline: number; from: number; to: number; limits: StepLimits }
/** a kit's steps as the build user, one bash command each (under xvfb when the kit runs Windows tools under wine): each
 *  within its time and the whole build's, saying every 5 seconds what step it is on and what it has written so far, and
 *  stopped when the library would fall below what is kept free */
async function runKitSteps(kit: KitBuild, o: KitStepsOpts): Promise<void> {
  const bash = pdeps.tools().bash ?? "bash";
  const xvfb = kit.wine ? pdeps.tools().xvfb : null;
  const limits = o.limits;
  const n = kit.steps.length;
  const keep = keepFreeBytes();
  for (const [i, step] of kit.steps.entries()) {
    if (o.signal?.aborted) throw new BuildError("cancelled");
    const left = o.deadline - Date.now();
    if (left <= 0) throw new PlanFault("build", `the build ran past ${span(KIT_BUILD_MAX_MS)} (step ${i + 1} of ${n} was not reached)`);
    const timeoutMs = Math.min(kit.timeoutSec * 1000, left);
    const cmd = fillKit(step, o.fill);
    o.log(`build ${i + 1}/${n}: ${step}`);
    const label = `building the game (step ${i + 1} of ${n})`;
    const base = o.from + (o.to - o.from) * (i / n);
    o.progress(base, label);
    const t0 = Date.now();
    // a stop of its own when the room runs out, next to the job's cancel
    const hb = await heartbeat({ work: o.work, label, keep, signal: o.signal, say: m => o.progress(base, m) });
    const oom = bdeps.oomKills();
    let r: ExecResult;
    try {
      const run = [bash, "-c", cmd];
      r = await sandboxExec(limited(xvfb ? [xvfb, "-a", "-s", "-screen 0 1280x1024x24", ...run] : run, limits), {
        work: o.work, cwd: o.cwd, signal: hb.signal, timeoutMs, maxOutput: 8000,
        env: { MAKEFLAGS: `-j${limits.jobs}`, CMAKE_BUILD_PARALLEL_LEVEL: String(limits.jobs) },
      });
    } finally {
      hb.done();
      const pids = await reapUnder(o.work).catch(() => [] as number[]);
      if (pids.length) o.log(`build ${i + 1}: stopped ${pids.length} process(es) it left running`);
    }
    if (o.signal?.aborted) throw new BuildError("cancelled");
    const short = hb.short();
    if (short) throw short;
    const bad = stepFailure(r, `build step ${i + 1}`, Math.round(timeoutMs / 1000), oom);
    if (bad) throw bad;
    o.log(`build ${i + 1}/${n} done in ${span(Date.now() - t0)}`);
  }
}

/** files and folders of a build players must not get (a plan can still ship one by naming it in its keep list) */
const JUNK_DIR = /^(build-cache|cmakefiles)$/i;
const JUNK_FILE = /\.(o|obj|pdb|ilk)$/i;
/**
 * What a kit's install folder holds that no package may: a name the launcher refuses, the name of the package's own
 * manifest (ahoy.json at its top), what a build leaves behind (build caches, object and debug files) unless the plan's
 * keep list names it, and text or compiled executable defaults naming this server's paths (a wine drive, the build's
 * scratch folder, the content store). In words, or null when there is nothing.
 */
export async function kitOutputProblems(dir: string, o: { work: string; store: string; keep: string[] }): Promise<string | null> {
  const kept = o.keep.map(g => new Bun.Glob(g));
  const keeps = (rel: string) => kept.some(g => g.match(rel) || g.match(`${rel}/`));
  const names: string[] = [], junk: { rel: string; size: number }[] = [], paths: string[] = [];
  const own = (await readdir(dir)).filter(n => /^ahoy\.json$/i.test(n));
  const sizeOf = async (p: string): Promise<number> => {
    const st = await lstat(p).catch(() => null);
    if (!st) return 0;
    if (!st.isDirectory()) return st.size;
    let n = 0;
    for (const c of await readdir(p).catch(() => [] as string[])) n += await sizeOf(join(p, c));
    return n;
  };
  const walk = async (d: string, at: string) => {
    for (const name of (await readdir(d)).sort()) {
      const p = join(d, name), rel = at ? `${at}/${name}` : name;
      const st = await lstat(p);
      const why = launcherPathProblem(rel);
      if (why) { names.push(`${rel} (${why})`); continue; }
      if (st.isDirectory()) {
        if (JUNK_DIR.test(name) && !keeps(rel)) { junk.push({ rel: `${rel}/`, size: await sizeOf(p) }); continue; }
        await walk(p, rel);
        continue;
      }
      if (JUNK_FILE.test(name) && !keeps(rel)) { junk.push({ rel, size: st.size }); continue; }
      if (!st.isFile()) continue;
      const w = await serverPathInFile(p, st.size, o.work, o.store);
      if (w) paths.push(`${rel} names ${w}`);
    }
  };
  await walk(dir, "");
  const list = (xs: string[]) => (xs.length > 6 ? `${xs.slice(0, 6).join(", ")} and ${xs.length - 6} more` : xs.join(", "));
  const parts: string[] = [];
  if (own.length) parts.push(`a file named like the package's own manifest: ${own.join(", ")}`);
  if (names.length) parts.push(`names no player's PC could install: ${list(names)}`);
  if (junk.length) parts.push(`what the build leaves behind: ${list(junk.map(j => `${j.rel} (${sizeText(j.size)})`))}`);
  if (paths.length) parts.push(`paths of this server: ${list(paths)}`);
  return parts.length ? `the build's install folder holds ${parts.join("; and ")} — remove them in the kit's steps (a file players need goes in the plan's keep list)` : null;
}

/** the kit's install folder kept as a folder beside the game file: moved there (a rename on the same volume), each file
 *  hashed once with the stat taken around it, its record written beside it */
async function keepKitBuild(art: string, keepDir: string, key: { kit: string; tag: string; recipe: string; file: string }, o: { signal?: AbortSignal; log: (line: string) => void; progress: (message: string) => void }): Promise<KitRecord> {
  await mkdir(dirname(keepDir), { recursive: true });
  const part = `${keepDir}.part-${process.pid}-${Date.now()}`;
  try { await rename(art, part); }
  catch {
    // another volume: the folder is copied over, file by file
    o.log("the build is on another volume than the game file: copying it beside the file");
    await placeTree(art, part, { link: false, scope: dirname(keepDir), signal: o.signal, progress: (done, total) => o.progress(`keeping the build · ${ofTotal(done, total)}`) });
  }
  try {
    const files: KitRecord["files"] = [];
    const list: string[] = [];
    const walk = async (d: string, at: string) => {
      for (const name of (await readdir(d)).sort()) {
        const p = join(d, name), rel = at ? `${at}/${name}` : name;
        const st = await lstat(p);
        if (st.isDirectory()) await walk(p, rel);
        else list.push(rel);
      }
    };
    await walk(part, "");
    let total = 0;
    for (const rel of list) total += (await lstat(join(part, ...rel.split("/")))).size;
    let done = 0, last = 0;
    // the bytes of total as it goes, inside a file too (a game's 26 GB data file is minutes of reading)
    const tell = (at: number) => { if (Date.now() - last >= 1000) { last = Date.now(); o.progress(`checking what the build made · ${ofTotal(at, total)}`); } };
    o.progress(`checking what the build made · ${ofTotal(0, total)}`);
    for (const rel of list) {
      const p = join(part, ...rel.split("/"));
      for (let attempt = 0; ; attempt++) {
        if (o.signal?.aborted) throw new BuildError("cancelled");
        const before = await lstat(p);
        const sum = await fileSum(p, n => tell(done + n), o.signal);
        const after = await lstat(p);
        const same = before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino && sum.size === after.size;
        if (same) {
          files.push({ rel, size: sum.size, sha256: sum.sha256, stat: { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, dev: after.dev, ino: after.ino } });
          done += sum.size;
          break;
        }
        if (attempt >= 1) throw new EnvError("changed", `${rel} kept changing while the build was being kept`);
      }
      tell(done);
    }
    const record: KitRecord = { kit: key.kit, tag: key.tag, recipe: key.recipe, file: key.file, builtAt: nowSec(), size: done, files };
    await rm(`${keepDir}.json`, { force: true }).catch(() => {});
    if (await lstat(keepDir).catch(() => null)) await removeTree(keepDir);
    await rename(part, keepDir);
    await writeFile(`${keepDir}.json`, JSON.stringify(record));
    return record;
  } catch (e) { await removeTree(part).catch(() => {}); throw e; }
}

/**
 * The game built from its file on the server by the program's release kit (program.perGame), for one way: the kit as
 * pinned (the newest release when the plan has none yet: the build job pins it then), its pinned fetches (each checked
 * before anything runs), the game file handed over read-only, its steps as the build user, the install folder checked
 * and kept as a folder beside the game file (an earlier build of the plan for the same file goes). A build kept already
 * for the same kit, recipe and file is taken as it is. Returns what acquireProgram returns: dir is the kept folder (read
 * it, never write in it; an assemble places it with placeKitBuild).
 */
export async function buildKitForWay(plan: PlanRow, way: WayRow, file: ContentRow, o: { work: string; signal?: AbortSignal; log: (line: string) => void; progress?: (p: number, m: string) => void }): Promise<Acquired> {
  const spec = planSpec(plan), kit = kitOf(spec.program);
  if (!kit) throw new BuildError("this plan's program is not a kit that builds the game per way", OTHER);
  const inputs = buildNeeds(spec, systemFiles(plan.id));
  if (inputs.some(i => !i.file)) throw new NeedsFiles(`needs ${inputs.filter(i => !i.file).map(i => i.need.name).join(", ")} for the server build`);
  const fileSha = fileDigest(file);
  if (!fileSha) throw new BuildError("the game file has no sha256 to keep its build by", { class: "file" });
  const store = storeDirOf(file);
  if (!sandboxOrAllowed()) throw new EnvError("tool", "building the game needs the build sandbox (ludarr's Docker image)");
  const progress = (p: number, m: string) => o.progress?.(Math.max(0, Math.min(0.99, p)), m);
  const deadline = Date.now() + KIT_BUILD_MAX_MS;
  const keep = keepFreeBytes(), free = await freeOn(o.work);
  if (free !== null && keep > 0 && free < keep) throw noRoom(free, keep);
  // what the build writes fits on the library before anything is fetched or run (unless the build for the kit it is
  // pinned to is kept already: then nothing is written)
  const pinSha = kitShaOf(plan, spec.program);
  const keptNow = pinSha ? readKitRecord(join(store, ".builds", kitBuildName(plan.slug, pinSha, kitRecipe(kit, inputs), fileSha)), { kit: pinSha, recipe: kitRecipe(kit, inputs), file: fileSha }) : null;
  if (!keptNow) await roomForBuild(o.work, buildNeedBytes(plan, way, file) + inputs.reduce((n, i) => n + (i.file?.size ?? 0), 0), buildingWords(plan, way));

  // 1 — the kit as pinned
  progress(0.01, "getting the kit");
  const acq = await acquireProgram(plan, { work: o.work, signal: o.signal, log: o.log, progress: (p, m) => progress(0.01 + 0.07 * p, m) });
  const recipe = kitRecipe(kit, inputs), keepDir = join(store, ".builds", kitBuildName(plan.slug, acq.pinned.sha256, recipe, fileSha));
  const key = { kit: acq.pinned.sha256, tag: acq.pinned.tag, recipe, file: fileSha };
  const already = readKitRecord(keepDir, key);
  if (already) {
    o.log(`the build of the game from the ${acq.pinned.tag} kit for this game file is kept on the server: nothing to build`);
    return { dir: keepDir, pinned: acq.pinned, fresh: acq.fresh };
  }

  // 2 — what the steps need, each file held to its pin before anything runs
  const tools = join(o.work, "tools");
  await mkdir(tools, { recursive: true });
  const fetches = kit.fetch ?? [];
  for (const [i, f] of fetches.entries()) {
    progress(0.08 + 0.07 * (i / Math.max(1, fetches.length)), `fetching what the build needs (${i + 1} of ${fetches.length})`);
    await fetchKitFile(f, i, fetches.length, { work: o.work, tools, signal: o.signal, log: o.log, progress: m => progress(0.08 + 0.07 * (i / fetches.length), m) });
  }

  // 3 — the game file, read-only; 4 — the steps
  const content = await handOver(file, o.work, { log: o.log });
  const out = join(o.work, "out");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  // the parallel jobs and the memory cap, once for the whole build (the {jobs} its steps are given and MAKEFLAGS agree)
  let limits = stepLimits();
  const needs = join(o.work, "build-needs");
  await prepareBuildNeeds(inputs, needs, o.signal);
  const fill = { program: acq.dir, content: content.path, needs, out, tools, cpu: kit.cpu ?? "", jobs: String(limits.jobs), work: sandboxDirs(o.work).scratch };
  o.log(`building ${file.name} with the ${acq.pinned.tag} kit (${kit.steps.length} step${kit.steps.length === 1 ? "" : "s"}${kit.wine ? ", Windows tools under wine" : ""}${kit.cpu ? `, for ${kit.cpu}` : ""}, ${fill.jobs} at once${limits.prlimit ? `, each process at most ${gbText(limits.asBytes)}` : ""})`);
  try {
    for (const d of [acq.dir, out, tools]) await handTo(d, "builder");
    if (kit.wine) limits = await wineboot(o.work, acq.dir, limits, { signal: o.signal, log: o.log, progress: m => progress(0.15, m) });
    await runKitSteps(kit, { work: o.work, cwd: acq.dir, fill, signal: o.signal, log: o.log, progress, deadline, from: 0.15, to: 0.85, limits });
  } finally {
    await rm(needs, { recursive: true, force: true });
    for (const d of [acq.dir, out, tools]) await handTo(d, "root");
  }

  // 5 — the install folder: checked, then kept beside the game file
  const art = kit.artifact === "." ? out : join(out, ...kit.artifact.split("/"));
  if (!(await lstat(art).catch(() => null))?.isDirectory()) throw new PlanFault("build", `the build left no folder ${kit.artifact} in {out} (the kit's artifact)`);
  await refuseLinks(art, "the build", { allow: () => false });
  progress(0.86, "checking what the build made");
  await checkBuildNeedLeaks(art, inputs);
  const problems = await kitOutputProblems(art, { work: o.work, store, keep: spec.keep });
  if (problems) throw new PlanFault("build", problems);
  const record = await keepKitBuild(art, keepDir, key, { signal: o.signal, log: o.log, progress: m => progress(0.9, m) });
  o.log(`kept: ${record.files.length} files, ${gbText(record.size)}, beside the game file`);
  // earlier builds of this plan for the same file (another kit or recipe) are not needed any more
  const earlier = new RegExp(`^${escapeRe(storeName(plan.slug))}-[0-9a-f]{${SHORT}}-[0-9a-f]{8}-${fileSha.slice(0, SHORT)}(\\.json)?$`);
  const mine = keepDir.split(/[\\/]/).pop()!;
  for (const n of await readdir(dirname(keepDir)).catch(() => [] as string[])) {
    if (n === mine || n === `${mine}.json` || !earlier.test(n)) continue;
    await removeTree(join(dirname(keepDir), n)).catch(() => {});
  }
  return { dir: keepDir, pinned: acq.pinned, fresh: acq.fresh };
}

/**
 * A wine prefix for the build, made once before its steps (in the job's scratch folder, the build user's), under the
 * steps' memory cap. Wine reserves much of its address space as it starts, so on some servers it cannot start under an
 * address-space cap at all: when it fails under the cap and starts without it, that is ludarr's own finding (logged), and
 * the steps run without the cap — a recipe is never blamed for it. Returns the limits the steps run with.
 */
async function wineboot(work: string, cwd: string, limits: StepLimits, o: { signal?: AbortSignal; log: (line: string) => void; progress?: (message: string) => void }): Promise<StepLimits> {
  const wine = pdeps.tools().wine;
  if (!wine) throw new EnvError("tool", "the kit runs Windows tools, and wine is not installed on this server");
  const xvfb = pdeps.tools().xvfb;
  const cmd = [wine, "wineboot", "--init"];
  const boot = async (l: StepLimits) => {
    const hb = await heartbeat({ work, label: "setting up wine for the build", keep: 0, signal: o.signal, say: o.progress, bytes: false });
    try { return await sandboxExec(limited(xvfb ? [xvfb, "-a", "-s", "-screen 0 1280x1024x24", ...cmd] : cmd, l), { work, cwd, signal: o.signal, timeoutMs: 15 * 60_000, maxOutput: 4000 }); }
    finally { hb.done(); await reapUnder(work).catch(() => [] as number[]); }
  };
  o.progress?.("setting up wine for the build");
  let r = await boot(limits), out = limits;
  if (r.code !== 0 && limits.prlimit && !o.signal?.aborted) {
    const open = await boot({ ...limits, prlimit: null });
    if (open.code === 0) {
      o.log(`wine does not start under the memory cap on this server (each process at most ${gbText(limits.asBytes)}: exit ${r.code}), and starts without it: the build's steps run without the cap`);
      out = { ...limits, prlimit: null };
    }
    r = open;
  }
  if (o.signal?.aborted) throw new BuildError("cancelled");
  if (r.code !== 0) throw new EnvError("tool", `wine could not set up its prefix (exit ${r.code})${tail(r) ? `: ${tail(r)}` : ""}`);
  o.log("wine prefix ready");
  return out;
}

/**
 * The kept build of the game from its kit, for an assemble: placed into <work>/program by a tree of hard links when
 * `link` allows it (the store's own files, read-only, never copied), copies otherwise; each linked file carries its
 * sha256 when its stat is the one it was hashed with, so the manifest reads nothing again. No build kept → NeedsBuild.
 */
export async function placeKitBuild(plan: PlanRow, file: ContentRow, o: { work: string; link: boolean; signal?: AbortSignal; log: (line: string) => void; progress?: (p: number, m: string) => void }): Promise<Acquired> {
  const kept = keptKitBuild(plan, file);
  if (!kept) throw new NeedsBuild("its program has to be built for this game first (a build job does that, then the way is built)");
  const prog = planSpec(plan).program;
  const pinned = planPinned(plan) ?? (prog.kind === "url"
    ? { tag: "url", asset: storeName(decodeURIComponent(new URL(prog.url).pathname.split("/").pop() || "program")), url: prog.url, size: 0, sha256: prog.sha256, digest: null, immutable: null, pinnedAt: nowSec() }
    : null);
  if (!pinned) throw new NeedsBuild("its program has to be built for this game first (a build job does that, then the way is built)");
  const dest = join(o.work, "program");
  await rm(dest, { recursive: true, force: true });
  const byRel = new Map(kept.record.files.map(f => [f.rel, f]));
  o.log(`program: the build of the game from the ${kept.record.tag} kit, kept on the server (${kept.record.files.length} files, ${gbText(kept.record.size)})`);
  const placed = await placeTree(kept.dir, dest, {
    link: o.link, scope: o.work, signal: o.signal, log: o.log,
    trusted: (rel, st) => { const r = byRel.get(rel); return r && r.stat.size === st.size && r.stat.mtimeMs === st.mtimeMs && r.stat.dev === st.dev && r.stat.ino === st.ino ? r.sha256 : null; },
    progress: (done, total, how) => o.progress?.(total ? done / total : 1, how === "link" ? `linking the program into the package · ${ofTotal(done, total)}` : `placing the program · ${ofTotal(done, total)}`),
  });
  return { dir: dest, pinned, fresh: false, files: placed.files };
}

/**
 * Up to the first step that reads the game file, without one: the kit as pinned (or the newest), every fetch held to its
 * pin, and the steps before {content} first appears — so a kit can be tried before the game file is here (the AI's dry
 * run). Nothing is kept.
 */
export async function tryKit(plan: PlanRow, o: { work: string; signal?: AbortSignal; log: (line: string) => void; progress?: (p: number, m: string) => void }): Promise<{ pinned: PinnedProgram; fetched: number; ran: number; waitsForFile: boolean }> {
  const kit = kitOf(planSpec(plan).program);
  if (!kit) throw new BuildError("this plan's program is not a kit that builds the game per way", OTHER);
  if (!sandboxOrAllowed()) throw new EnvError("tool", "building the game needs the build sandbox (ludarr's Docker image)");
  const progress = (p: number, m: string) => o.progress?.(Math.max(0, Math.min(0.99, p)), m);
  const acq = await acquireProgram(plan, { work: o.work, signal: o.signal, log: o.log, progress: (p, m) => progress(0.05 * p, m) });
  const tools = join(o.work, "tools");
  await mkdir(tools, { recursive: true });
  const fetches = kit.fetch ?? [];
  for (const [i, f] of fetches.entries()) await fetchKitFile(f, i, fetches.length, { work: o.work, tools, signal: o.signal, log: o.log, progress: m => progress(0.05 + 0.2 * (i / fetches.length), m) });
  const firstContent = kit.steps.findIndex(s => s.includes("{content}") || s.includes("{needs}"));
  const steps = firstContent < 0 ? kit.steps : kit.steps.slice(0, firstContent);
  const out = join(o.work, "out");
  await mkdir(out, { recursive: true });
  let limits = stepLimits();
  const fill = { program: acq.dir, content: "", out, tools, cpu: kit.cpu ?? "", jobs: String(limits.jobs), work: sandboxDirs(o.work).scratch };
  if (steps.length) {
    for (const d of [acq.dir, out, tools]) await handTo(d, "builder");
    try {
      if (kit.wine) limits = await wineboot(o.work, acq.dir, limits, { signal: o.signal, log: o.log, progress: m => progress(0.25, m) });
      await runKitSteps({ ...kit, steps }, { work: o.work, cwd: acq.dir, fill, signal: o.signal, log: o.log, progress, deadline: Date.now() + KIT_BUILD_MAX_MS, from: 0.25, to: 0.95, limits });
    } finally { for (const d of [acq.dir, out, tools]) await handTo(d, "root"); }
  }
  return { pinned: acq.pinned, fetched: fetches.length, ran: steps.length, waitsForFile: firstContent >= 0 };
}

/**
 * The program of a plan whose build needs the game file (program.content 'build'), for one way: kept from an earlier
 * build of the same commit, recipe and file, else built now with the way's verified file (handed over read-only, never
 * copied) and kept beside it in the game's content store folder (.builds/). The pinned commit is built when the plan has
 * one, else program.ref as it is now. `keptOnly` (an assemble): only a kept build is taken, and none kept is NeedsBuild —
 * a build never runs inside an assemble. Returns what src/ways/program.ts's acquireProgram returns, so assembly goes on
 * from it the same way.
 */
export async function buildForWay(plan: PlanRow, way: WayRow, file: ContentRow, o: { work: string; signal?: AbortSignal; log: (line: string) => void; progress?: (p: number, m: string) => void; keptOnly?: boolean }): Promise<Acquired> {
  const prog = planSpec(plan).program;
  if (prog.kind !== "source" || prog.content !== "build") throw new BuildError("this plan's program is not built per game", OTHER);
  const sha1 = contentHashes(file).sha1;
  if (!sha1) throw new BuildError("the game file has no sha1 to keep its build by", { class: "file" });
  const storeDir = storeDirOf(file);
  const cache = join(storeDir, ".builds");
  const commitPinned = pinnedCommit(plan);
  if (o.keptOnly && !keptSourceBuild(plan, file)) throw new NeedsBuild("its program has to be built for this game first (a build job does that, then the way is built)");
  const src = join(o.work, "src");
  let commit = commitPinned, cloned = false;
  if (!commit) {
    o.progress?.(0.02, "getting the source");
    commit = (await cloneRepo(plan.repo, prog.ref, src, { work: o.work, signal: o.signal, log: o.log })).commit;
    cloned = true;
  }
  const name = buildName(plan.slug, commit, recipeKey(prog), sha1);
  const kept = join(cache, name);
  const pin = (sum: { size: number; sha256: string }): PinnedProgram => ({ tag: `${prog.ref}@${commit}`, asset: name, url: `build:${name}`, size: sum.size, sha256: sum.sha256, digest: null, immutable: null, pinnedAt: nowSec() });

  if ((await stat(kept).catch(() => null))?.isFile()) {
    o.log(`program: the build of ${prog.ref} at ${commit.slice(0, SHORT)} for this game file is kept on the server`);
    o.progress?.(0.3, "unpacking the kept build");
    const dl = join(o.work, "dl"), out = join(o.work, "program");
    await mkdir(dl, { recursive: true });
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    const copy = join(dl, name);
    await copyFile(kept, copy);
    const sum = await fileSum(copy);
    await handTo(out, "builder");
    try { await extractArchive({ exec: sandboxed(o.work), tools: prdeps.tools(), log: o.log, signal: o.signal }, copy, out); }
    finally { await handTo(out, "root"); }
    await refuseLinks(out, "the kept build", { allow: () => false });
    return { dir: out, pinned: pin(sum), fresh: false };
  }
  if (o.keptOnly) throw new NeedsBuild("its program has to be built for this game first (a build job does that, then the way is built)");

  if (!sandboxOrAllowed()) throw new EnvError("tool", "building from source needs the build sandbox (ludarr's Docker image)");
  // what the build writes fits on the library before anything is cloned or run
  await roomForBuild(o.work, buildNeedBytes(plan, way, file), buildingWords(plan, way));
  if (!cloned) await cloneRepo(plan.repo, commit, src, { work: o.work, signal: o.signal, log: o.log });
  if (prog.apt?.length) await aptInstall(prog.apt, { signal: o.signal, log: o.log });
  // the build reads the game file where ludarr hands it over: a hard link (or where it is kept), read-only, never a copy
  const content = await handOver(file, o.work, { log: o.log });
  o.log(`building ${prog.ref} at ${commit.slice(0, SHORT)} with ${file.name}`);
  try {
    await runSteps(prog.steps, { work: o.work, cwd: src, signal: o.signal, log: o.log, content: content.path, progress: (p, m) => o.progress?.(0.05 + 0.85 * p, m) });
  } finally { await handTo(src, "root"); }
  const dir = await artifactIn(src, prog.artifact);
  o.progress?.(0.92, "keeping the build");
  const sum = await packTar(dir, kept, o);
  // earlier builds of this plan for the same file (another commit or recipe; a name from before recipes were in it) are
  // not needed any more; another plan's builds are not this plan's to remove
  const earlier = new RegExp(`^${escapeRe(storeName(plan.slug))}-[0-9a-f]{${SHORT}}-(?:[0-9a-f]{8}-)?${sha1.slice(0, SHORT)}\\.tar$`);
  for (const n of await readdir(cache).catch(() => [] as string[])) {
    if (n !== name && earlier.test(n)) await rm(join(cache, n), { force: true }).catch(() => {});
  }
  return { dir, pinned: pin(sum), fresh: false };
}

/* ─────────── the job ─────────── */

/** the job's way and its verified game file (a build per game needs both) */
function wayAndFile(wayId: number, plan: PlanRow): { way: WayRow; game: GameRow; file: ContentRow } {
  const way = getWay(wayId);
  if (!way || way.plan_id !== plan.id) throw new BuildError("that way to play is not one of this plan's", OTHER);
  const game = stmts.gameById.get(way.game_id) as GameRow | undefined;
  if (!game) throw new BuildError("the way's game is gone", OTHER);
  const c = wayContent(way, plan);
  const file = way.content_id != null ? getContent(way.content_id) : null;
  if (!c || !file) throw new NeedsFiles(`${game.name} has no game file yet: add one before building`);
  const v = contentMatches(c, contentFacts(file));
  if (!v.ok) throw new NeedsFiles(`the game file ${file.name} is ${v.why}`);
  if (!existsSync(file.path)) throw new NeedsFiles(`the game file ${file.name} is gone from the server`);
  return { way, game, file };
}

/** the tag a plan's tools are built for: the pinned program's, else the newest release's (the build of a way pins it) */
async function programTag(plan: PlanRow): Promise<string> {
  const pinned = planPinned(plan);
  if (pinned) return pinned.tag;
  const prog = planSpec(plan).program;
  if (prog.kind === "url") throw new BuildError("a fixed-file program has no tag to build its tools at: set tools.ref to a tag or commit");
  if (prog.kind === "source") throw new BuildError("build the program first (its tools are built at the commit it is built from)");
  const rel = await prdeps.latestRelease(prog.kind === "feed" ? prog.feed : plan.repo, prog.kind === "release" ? prog.assetPattern : null, prog.kind === "release" ? prog.channel : "stable");
  if (!rel) throw new BuildError(`${plan.repo} has no release to build the tools for`);
  return rel.tag;
}

/** the plan as it is now, when it still asks for what this build read as the job started (its program, tools and repo) */
function stillAsked(plan: PlanRow): PlanRow | null {
  const now = getPlan(plan.id);
  if (!now || now.repo !== plan.repo) return null;
  const a = planSpec(now), b = planSpec(plan);
  return JSON.stringify(a.program) === JSON.stringify(b.program) && JSON.stringify(a.tools ?? null) === JSON.stringify(b.tools ?? null) ? now : null;
}

/**
 * What a source build made becomes the plan's only while the plan still asks for it: the pin (when there is a new one;
 * a pin belongs to the program and repo it was built from), then the plan is ready unless it was edited meanwhile (an
 * edit makes it a draft, to be checked again). Nothing is awaited between the look and the writes.
 */
function settlePlan(plan: PlanRow, pin: PinnedProgram | null, log: (line: string) => void): "ready" | "edited" | "changed" {
  const now = stillAsked(plan);
  if (!now) { log("the plan's program, tools or repo changed during the build: what this build made is not pinned on it"); return "changed"; }
  if (pin) wstmts.setPinned.run(JSON.stringify(pin), plan.id);
  if (now.spec_json !== plan.spec_json) { log("the plan was edited during the build: it stays a draft until it is checked"); return "edited"; }
  updatePlan(plan.id, { status: "ready", statusNote: null });
  return "ready";
}
const EDITED = " (the plan was edited during the build: check it)";

export async function build(ctx: KindContext): Promise<KindResult> {
  const s = ctx.spec as Extract<JobSpec, { kind: "build" }>;
  const plan = getPlan(s.planId);
  if (!plan) throw new BuildError("the plan is gone", OTHER);
  const spec = planSpec(plan), prog = spec.program, kit = kitOf(prog);
  const log = ctx.log, signal = ctx.signal;
  const done: string[] = [];
  let superseded = false;
  if (prog.kind !== "source" && !spec.tools && !kit) throw new BuildError("the plan has nothing to build: its program comes ready-made (a release, a feed or a fixed file)", { class: "plan" });
  if (!sandboxOrAllowed()) throw new EnvError("tool", "building from source needs the build sandbox (ludarr's Docker image)");
  const apt = [...(prog.kind === "source" ? prog.apt ?? [] : []), ...(spec.tools?.apt ?? [])];
  const refused = aptRefused(apt);
  if (refused.length) throw new BuildError(`${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not on the build allowlist (${APT_ALLOWED})`);

  if (kit) {
    if (s.wayId == null) throw new BuildError("this plan builds the game with each game's own file: build one of its ways", OTHER);
    const { way, game, file } = wayAndFile(s.wayId, plan);
    log(`building ${game.name} from ${plan.name}'s kit, with its game file ${file.name}`);
    const acq = await buildKitForWay(plan, way, file, { work: ctx.work, signal, log, progress: (p, m) => ctx.progress(0.95 * p, m) });
    // the kit this build used is the plan's from now on (a new pin only while the plan still asks for what it read), so
    // the way's assemble finds this build
    if (acq.fresh) {
      if (wstmts.setPinnedIf.run(JSON.stringify(acq.pinned), plan.id, plan.spec_json, plan.repo).changes) log(`the plan now builds from the ${acq.pinned.tag} kit (pinned)`);
      else { superseded = true; log("the plan was changed during the build: the kit it used is not pinned on it"); }
    } else if (!stillAsked(plan)) {
      // its kit, recipe or repo changed meanwhile: the build is kept for what it was made from, and the way is not put
      // together from it (that would only end in a build for the changed plan)
      superseded = true;
      log("the plan's program changed during the build: what it built is kept, and the way is not put together from it");
    }
    done.push(`built ${game.name} from the ${acq.pinned.tag} kit, kept beside its game file`);
  } else if (prog.kind === "source" && prog.content === "build") {
    if (s.wayId == null) throw new BuildError("this plan is built once per game, with its game file: build one of its ways", OTHER);
    const { way, game, file } = wayAndFile(s.wayId, plan);
    log(`building ${plan.name} for ${game.name}`);
    const acq = await buildForWay(plan, way, file, { work: ctx.work, signal, log, progress: (p, m) => ctx.progress(0.9 * p, m) });
    // the commit it was built at is the plan's from now on (every game's build is of the same source), and it is ready
    const pinned = /@[0-9a-f]{40}$/.test(planPinned(plan)?.tag ?? "");
    const settled = settlePlan(plan, pinned ? null : { ...acq.pinned, asset: `${plan.slug}-per-game`, url: "build:per-game", size: 0, sha256: "" }, log);
    superseded = settled === "changed";
    done.push(`built for ${game.name} (${mb(acq.pinned.size)}), kept beside its game file${settled === "edited" ? EDITED : ""}`);
  } else if (prog.kind === "source") {
    log(`building ${plan.name} from ${plan.repo} at ${prog.ref}`);
    const built = await buildSource({ repo: plan.repo, program: prog, work: ctx.work, signal, log, progress: (p, m) => ctx.progress(0.8 * p, m) });
    // a program saved meanwhile (a construct job's) keeps its own build: this one never takes that file's name
    if (!stillAsked(plan)) { superseded = true; done.push(`built at ${prog.ref}, not kept`); }
    else {
      ctx.progress(0.85, "keeping the build");
      const pin = await keepBuild(plan, built, prog.ref, { signal, log });
      const settled = settlePlan(plan, pin, log);
      superseded = settled === "changed";
      done.push(`built ${pin.asset} (${mb(pin.size)}) at ${prog.ref}${settled === "edited" ? EDITED : ""}`);
    }
  }
  const fresh = spec.tools && !superseded ? stillAsked(plan) : null;
  if (spec.tools && !superseded && !fresh) superseded = true;
  if (spec.tools && fresh) {
    const tag = await programTag(fresh);
    const refs = toolsRefs(spec.tools, tag);
    log(`building the tools at ${refs.clone}`);
    const built = await buildTools({ repo: plan.repo, tools: spec.tools, ref: refs.clone, work: ctx.work, signal, log, progress: (p, m) => ctx.progress(0.85 + 0.1 * p, m) });
    // kept only for the tools and the program the plan still asks for
    if (!stillAsked(plan)) superseded = true;
    else { await keepTools(fresh, built, refs.lookup, spec.tools.outputs); done.push(`tools built at ${refs.lookup}`); }
  }
  if (superseded) done.push("the plan's program, tools or repo changed during the build, so what it built is not the plan's");
  settleWaysOfPlan(plan.id);
  try { reingestCustom(); } catch (e: any) { log(`the catalog was not refreshed: ${e?.message ?? e}`); }
  // then: the way is put together from what was just built (as the run or the admin asked: auto, replace), unless the plan
  // changed under the build or the way is being built already
  if (s.then === "assemble" && s.wayId != null && !superseded) {
    const way = getWay(s.wayId);
    if (way && !assembling(way.id)) {
      const runId = s.runId ?? ctx.job.run_id ?? null;
      const next = enqueueJob({ kind: "assemble", wayId: way.id, auto: s.auto ?? runId != null, ...(s.replace ? { replace: true } : {}), runId }, { gameId: way.game_id, runId });
      log(`the way is put together next (job ${next.id})`);
      done.push("the way is built next");
    }
  }
  return { message: done.join("; ") };
}

registerJobKind("build", {
  run: ctx => build(ctx),
  // a checkout, its build tree and the packed result: big projects (Ship of Harkinian) take several GB; a kit's build
  // also holds the kit and its fetches, unpacked, and the install folder it makes from the game's data, about the game
  // file's size (the game file itself is handed over by a link: nothing)
  scratch: (_job, spec) => {
    if (spec.kind !== "build") return 20e9;
    const plan = getPlan(spec.planId), kit = plan ? kitOf(planSpec(plan).program) : null;
    if (!plan || !kit) return 20e9;
    const fetched = (kit.fetch ?? []).reduce((a, f) => a + (f.size ?? 0), 0);
    const way = spec.wayId != null ? getWay(spec.wayId) : null;
    const file = way?.content_id != null ? getContent(way.content_id) : null;
    return 20e9 + 3 * fetched + 3 * (planPinned(plan)?.size ?? 300e6) + (file?.size ?? 0);
  },
});
