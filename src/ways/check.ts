/**
 * ludarr — the plan's checks, run on the server once the package is put together and before it is offered (assemble,
 * after its own checks and before the manifest), and in the construct job's dry run: GPU-free steps on a throwaway copy
 * of the install folder (so nothing a check writes ships), and a short start under wine on a virtual display. A check
 * the server cannot run (a CPU it lacks, no graphics device the program can use) is 'env': it proves nothing either way,
 * and the package is built ("not started here: …").
 *
 *   runChecks(o)    every step of the check (the way's own in place of the plan's) as the build user, then the smoke start;
 *                   a step whose `needs` this server lacks is not run; `expect` is text one line of the output must hold
 *                   (lines cut to 4 KB, never a pattern) → CheckReport
 *   smokeStart(o)   the program under wine on its own display for a few seconds: did it keep running or end (its exit
 *                   code), the windows it opened, one screenshot (kept 30 days in <config>/ways/checks/), the last 40 lines
 *                   of what it printed (wine's errors too) → SmokeReport
 *   serverCan()     what this server can run: the CPU level from /proc/cpuinfo (AVX2, x86-64-v2/v3/v4), wine, OpenGL and
 *                   Vulkan (mesa's software devices count: llvmpipe, lavapipe) and mesh shaders, probed in the sandbox
 *                   under a virtual display once a day
 *
 * The throwaway copy: small files are copied (a check may change them), bigger ones are hard links (read-only to the
 * build user: a file with more than one link is never handed over, src/ways/sandbox.ts), and a kept game file that is
 * already the store's link is a symbolic link to it, so the check adds nothing to that file (not even a link, which
 * would change its ctime and make the manifest read 50 GB again).
 *
 * A step that cannot be started for the plan's reason (a value it needs is not there, a link it left behind) fails; one
 * this server cannot run is reported with code null and a tail that starts "not run here:".
 */
import { constants, readFileSync } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { configDir } from "../config";
import { fileChunks, removeTree } from "../fsutil";
import { rootFolders, workDirFor } from "../library/rootfolders";
import { pdeps } from "../process/deps";
import { winPath, wineserverPath } from "../process/scene";
import type { ExecResult, Toolbox } from "../process/tools";
import { keepFreeBytes } from "./content";
import { EnvError, PlanFault } from "./errors";
import {
  exitTrouble, handTo, readBuildFile, runSandboxedStep, sandboxDirs, sandboxExec, sandboxOrAllowed, stopUnder, WINE_WITHOUT_NETWORK, withSandboxUser, type LinkRef,
} from "./sandbox";
import type { CheckNeed, CheckReport, CheckStepReport, PlanCheck, RuntimePlanSpec, SmokeReport } from "./types";

/** what this server can run, probed in the sandbox (and from /proc/cpuinfo) */
export interface ServerCan {
  wine: boolean;
  gl: "none" | "software" | "hardware";
  vulkan: "none" | "software" | "hardware";
  meshShader: boolean;
  cpu: "x86-64" | "x86-64-v2" | "x86-64-v3" | "x86-64-v4" | null;
  /** the CheckNeed values this server meets */
  meets: CheckNeed[];
  probedAt: number;
  /** what the probe saw (the renderers, why something is missing), for the log */
  notes: string[];
}

/** swapped in tests: the CPU's flags, the toolbox, where a probe and the screenshots go, the clock, how files are placed */
export const ckdeps = {
  cpuinfo: (): string => { try { return readFileSync("/proc/cpuinfo", "utf8"); } catch { return ""; } },
  tools: (): Toolbox => pdeps.tools(),
  /** a folder the graphics probe works in (no job's: it takes a build user of its own) */
  probeDir: (): string | null => { const r = rootFolders()[0]; return r ? join(workDirFor(r), `probe-${process.pid}`) : null; },
  shotsDir: (): string => join(configDir(), "ways", "checks"),
  now: (): number => Date.now(),
  symlink: (target: string, path: string): Promise<void> => symlink(target, path, "file"),
  link: (from: string, to: string): Promise<void> => link(from, to),
  /** files up to this size are copied into the throwaway folder; bigger ones are linked */
  smallFile: 16 * 2 ** 20,
  /** what may be copied into it in all when this volume cannot link (more: the checks are not run here) */
  copyCap: 8 * 2 ** 30,
  /** how often a running check says how long it has taken */
  tickMs: 2000,
  /** how often a running step (a check's, a setup step's) looks at the library's free space */
  roomMs: 10_000,
};

/** words a program prints when it found no graphics device it can use: the smoke start proves nothing then */
export const DEVICE_TROUBLE = /vkCreateInstance|VK_ERROR_|no suitable (gpu|device)|DXGI_ERROR_UNSUPPORTED|failed to create (a )?(d3d|vulkan|opengl)/i;
/** a smoke screenshot's name (GET /api/v1/check-shot/:name serves only such names) */
export const SHOT_NAME = /^[a-z0-9-]+\.png$/;
const SHOT_DAYS = 30;
const DAY = 86_400_000;
const LINE_CAP = 4096;

const msgOf = (e: unknown) => String((e as { message?: unknown })?.message ?? e);
const gb = (n: number) => `${(n / 1e9).toFixed(n < 10e9 ? 1 : 0)} GB`;
const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
/** `fn` with its words said again every few seconds with the time it has taken ("… · 1:42"), so a step that runs for
 *  minutes never looks stuck */
async function ticking<T>(progress: ((p: number, message: string) => void) | undefined, p: number, words: string, fn: () => Promise<T>): Promise<T> {
  if (!progress) return fn();
  const t0 = ckdeps.now();
  progress(p, words);
  const t = setInterval(() => progress(p, `${words} · ${clock(ckdeps.now() - t0)}`), ckdeps.tickMs);
  try { return await fn(); } finally { clearInterval(t); }
}
/**
 * A running step of a plan's (a check, a setup step) watched for room: every ckdeps.roomMs the free space of the volume
 * `dir` is on, and once it falls below what LIBRARY_KEEP_FREE_GB keeps free the step is stopped through `signal` and
 * short() is the EnvError('room') to throw in its place — a plan's program never fills the library past the setting, as a
 * make's or a build's never does. done() ends the watch.
 */
export function roomWatch(dir: string, what: string, outer: AbortSignal): { signal: AbortSignal; short: () => EnvError | null; done: () => void } {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (outer.aborted) ac.abort(); else outer.addEventListener("abort", onAbort, { once: true });
  let short: EnvError | null = null, busy = false;
  const t = setInterval(async () => {
    if (busy || short) return;
    busy = true;
    try {
      const keep = keepFreeBytes();
      const s = keep > 0 ? await pdeps.diskSpace(dir).catch(() => null) : null;
      if (s && s.free < keep) {
        short = new EnvError("room", `not enough room: the library fell to ${gb(Math.max(0, s.free))} free while ${what} ran, below the ${gb(keep)} it keeps free (Settings → General → Import): stopped, and tried again later`);
        ac.abort();
      }
    } catch { /* a look at the free space never stops a step by itself */ } finally { busy = false; }
  }, ckdeps.roomMs);
  return { signal: ac.signal, short: () => short, done: () => { clearInterval(t); outer.removeEventListener("abort", onAbort); } };
}
/** a PNG's first eight bytes: a screenshot is kept only when it is one */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ─────────── what this server can run ─────────── */

/** the x86-64 level and AVX2 from /proc/cpuinfo's flags (the first CPU's: they are all the same) */
export function cpuLevel(cpuinfo: string): { level: ServerCan["cpu"]; avx2: boolean; flags: Set<string> } {
  const line = /^flags\s*:\s*(.*)$/m.exec(cpuinfo)?.[1] ?? "";
  const flags = new Set(line.split(/\s+/).filter(Boolean));
  const all = (xs: string[]) => xs.every(x => flags.has(x));
  const v2 = all(["cx16", "lahf_lm", "popcnt", "sse4_1", "sse4_2", "ssse3"]);
  const v3 = v2 && all(["avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "abm", "movbe", "xsave"]);
  const v4 = v3 && all(["avx512f", "avx512bw", "avx512cd", "avx512dq", "avx512vl"]);
  return { level: v4 ? "x86-64-v4" : v3 ? "x86-64-v3" : v2 ? "x86-64-v2" : flags.size ? "x86-64" : null, avx2: flags.has("avx2"), flags };
}
const LEVELS = ["x86-64", "x86-64-v2", "x86-64-v3", "x86-64-v4"];
const atLeast = (have: ServerCan["cpu"], want: string) => !!have && LEVELS.indexOf(have) >= LEVELS.indexOf(want);

/** the graphics probe: wine's version, glxinfo -B, vulkaninfo --summary and whether any device has mesh shaders */
const PROBE_SCRIPT = [
  `wine=$1`,
  `echo "== wine"; [ -n "$wine" ] && "$wine" --version 2>&1 | head -n 3`,
  `echo "== glx"; glxinfo -B 2>&1 | head -n 40`,
  `echo "== vulkan"; vulkaninfo --summary 2>&1 | head -n 80`,
  `echo "== mesh"; vulkaninfo 2>/dev/null | grep -c VK_EXT_mesh_shader`,
  `echo "== end"`,
  `exit 0`,
].join("\n");

/** what the probe's output says about wine, OpenGL, Vulkan and mesh shaders */
export function readProbe(out: string): Pick<ServerCan, "wine" | "gl" | "vulkan" | "meshShader"> & { notes: string[] } {
  const part = (name: string) => out.split(`== ${name}`)[1]?.split(/\n== /)[0] ?? "";
  const notes: string[] = [];
  const wine = /^wine-\d/m.test(part("wine"));
  const renderer = /OpenGL renderer string:\s*(.+)/.exec(part("glx"))?.[1]?.trim() ?? null;
  const gl: ServerCan["gl"] = !renderer ? "none" : /llvmpipe|softpipe|swrast|software rasterizer/i.test(renderer) ? "software" : "hardware";
  if (renderer) notes.push(`OpenGL: ${renderer}`);
  const vk = part("vulkan");
  const types = [...vk.matchAll(/deviceType\s*=\s*PHYSICAL_DEVICE_TYPE_(\w+)/g)].map(m => m[1]);
  const names = [...vk.matchAll(/deviceName\s*=\s*(.+)/g)].map(m => m[1].trim());
  const vulkan: ServerCan["vulkan"] = types.some(t => t !== "CPU") ? "hardware" : types.length || names.some(n => /llvmpipe|lavapipe/i.test(n)) ? "software" : "none";
  if (names.length) notes.push(`Vulkan: ${names.join(", ")}`);
  const meshShader = Number(/^\s*(\d+)/m.exec(part("mesh"))?.[1] ?? 0) > 0;
  return { wine, gl, vulkan, meshShader, notes };
}

let can: ServerCan | null = null;
let probing: Promise<ServerCan> | null = null;

/** what this server can run (probed once a day; `fresh` probes again now) */
export async function serverCan(o: { fresh?: boolean } = {}): Promise<ServerCan> {
  if (!o.fresh && can && ckdeps.now() - can.probedAt < DAY) return can;
  probing ??= probeServer().finally(() => { probing = null; });
  can = await probing;
  return can;
}
/** tests: forget what was probed */
export function forgetServerCan(): void { can = null; probing = null; }

async function probeServer(): Promise<ServerCan> {
  const cpu = cpuLevel(ckdeps.cpuinfo());
  const out: ServerCan = { wine: false, gl: "none", vulkan: "none", meshShader: false, cpu: cpu.level, meets: [], probedAt: ckdeps.now(), notes: [] };
  const tools = ckdeps.tools();
  const dir = ckdeps.probeDir();
  if (!sandboxOrAllowed()) out.notes.push("the graphics are looked at only in the build sandbox");
  else if (!tools.xvfb || !tools.bash) out.notes.push("no virtual display (xvfb-run) or bash here");
  else if (!dir) out.notes.push("no root folder to probe in");
  else {
    const r = await withSandboxUser(dir, async () => {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      try { return await sandboxExec([tools.xvfb!, "-a", "-s", "-screen 0 640x480x24", tools.bash!, "-c", PROBE_SCRIPT, "probe", tools.wine ?? ""], { work: dir, cwd: dir, timeoutMs: 120_000, maxOutput: 60_000 }); }
      finally { await stopUnder(dir).catch(() => 0); await removeTree(dir).catch(() => []); }
    }).catch((e: unknown) => { out.notes.push(`the probe failed: ${msgOf(e)}`); return null; });
    if (r) {
      const seen = readProbe(r.stdout);
      Object.assign(out, { wine: seen.wine && !!tools.wine && !!tools.xvfb, gl: seen.gl, vulkan: seen.vulkan, meshShader: seen.meshShader });
      out.notes.push(...seen.notes);
    } else if (!out.notes.length) out.notes.push("every build user is busy: probed again on the next check");
  }
  if (cpu.avx2) out.meets.push("avx2");
  if (atLeast(cpu.level, "x86-64-v2")) out.meets.push("x86-64-v2");
  if (atLeast(cpu.level, "x86-64-v3")) out.meets.push("x86-64-v3");
  if (out.wine) out.meets.push("wine");
  if (out.gl !== "none") out.meets.push("gl");
  if (out.vulkan !== "none") out.meets.push("vulkan");
  // a probe that could not run is asked again soon, not in a day
  if (out.notes.some(n => /busy|failed/.test(n))) out.probedAt = ckdeps.now() - DAY + 10 * 60_000;
  return out;
}

/** why this server cannot meet `need`, in words */
export function lacks(need: CheckNeed, c: ServerCan): string {
  switch (need) {
    case "avx2": return "the server's CPU lacks AVX2";
    case "x86-64-v2": case "x86-64-v3": return `the server's CPU is not ${need} (it is ${c.cpu ?? "of a level ludarr could not read"})`;
    case "wine": return "wine is not on this server";
    case "gl": return "the server has no OpenGL device";
    case "vulkan": return "the server has no Vulkan device";
  }
}

/* ─────────── shared with the make ─────────── */

/** a program a plan names, found in `root` without regard to case (Windows does not care; the real name is used) */
export async function present(root: string, rel: string, allowedLinks: Iterable<string> | null = []): Promise<string | null> {
  // Only the engine's throwaway mirror may supply links; ordinary package lookups still reject them.
  const links = new Set(Array.from(allowedLinks ?? [], p => resolve(p)));
  const fileAt = async (path: string) => {
    const st = await lstat(path).catch(() => null);
    return !!st?.isFile() || !!(st?.isSymbolicLink() && links.has(resolve(path)) && (await stat(path).catch(() => null))?.isFile());
  };
  if (await fileAt(join(root, ...rel.split("/")))) return rel;
  let dir = root;
  const out: string[] = [];
  for (const part of rel.split("/")) {
    const hit = (await readdir(dir).catch(() => [] as string[])).find(n => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    out.push(hit);
    dir = join(dir, hit);
  }
  return (await fileAt(dir)) ? out.join("/") : null;
}

/** the launcher's way with an argument: {install} becomes the install folder, and a value it went into gets backslashes */
function fillInstall(s: string, install: string): string {
  return s.includes("{install}") ? s.replace(/\{install\}/g, () => install).replace(/\//g, "\\") : s;
}

/** a fresh folder `base`, or base-2, base-3 … when it is there */
async function freshDir(base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const p = i === 1 ? base : `${base}-${i}`;
    if (!(await lstat(p).catch(() => null))) { await mkdir(p, { recursive: true }); return p; }
  }
}

/* ─────────── the throwaway install folder ─────────── */

/** a big file copied in chunks, saying how far it is (a copy of gigabytes is never one silent call) */
async function copyCounted(src: string, dst: string, signal: AbortSignal, tell: (bytes: number) => void): Promise<void> {
  const fh = await open(dst, "wx");
  let done = 0;
  try {
    if (signal.aborted) throw new Error("cancelled");
    for await (const chunk of fileChunks(src)) {
      for (let off = 0; off < chunk.byteLength;) { const { bytesWritten } = await fh.write(chunk, off, chunk.byteLength - off); off += bytesWritten; }
      done += chunk.byteLength;
      tell(done);
      if (signal.aborted) throw new Error("cancelled");
    }
  } finally { await fh.close(); }
}

interface Mirror { links: LinkRef[]; symlinks: string[]; copied: number; linked: number }

/**
 * `from` laid out again in `to` for a check: a file that is already a link (the content store's game file, or each file of
 * a game folder placed by links) a symbolic link to it, whatever its size; other small files copied (a check may change
 * them); bigger ones hard-linked. When this volume cannot link, bigger files are copied up to ckdeps.copyCap in all; more
 * than that and the checks are not run here (EnvError 'tool').
 */
async function throwaway(from: string, to: string, o: { signal: AbortSignal; progress?: (p: number, m: string) => void }): Promise<Mirror> {
  const m: Mirror = { links: [], symlinks: [], copied: 0, linked: 0 };
  let copyBudget = ckdeps.copyCap, last = Date.now(), entries = 0;
  const walk = async (src: string, dst: string, rel: string) => {
    if (o.signal.aborted) throw new Error("cancelled");
    const st = await lstat(src);
    if (++entries && Date.now() - last >= 1000) { last = Date.now(); o.progress?.(0, `checking the package: a throwaway copy of the install folder · ${entries.toLocaleString("en-US")} entries, ${gb(m.copied)} copied`); }
    if (st.isDirectory()) {
      await mkdir(dst, { recursive: true });
      for (const n of await readdir(src)) await walk(join(src, n), join(dst, n), rel ? `${rel}/${n}` : n);
      return;
    }
    if (!st.isFile()) throw new PlanFault("check", `the install folder holds something that is not a file (${rel}): it is not checked`);
    if (st.nlink > 1) {
      // the store's own file: pointed at, so nothing about it changes (a hard link would change its ctime) and nothing is
      // copied (a game folder placed by links is tens of thousands of them, most of them small)
      try { await ckdeps.symlink(src, dst); m.symlinks.push(dst); m.linked++; return; } catch { /* no symbolic links here */ }
    }
    if (st.size <= ckdeps.smallFile && st.nlink === 1) { await copyFile(src, dst, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); m.copied += st.size; return; }
    try { await ckdeps.link(src, dst); const s2 = await lstat(dst); m.links.push({ dev: s2.dev, ino: s2.ino }); m.linked++; return; }
    catch (e) {
      if (st.size > copyBudget) throw new EnvError("tool", `the install folder's ${rel} (${gb(st.size)}) cannot be linked into a throwaway copy for the checks here (${(e as { code?: string })?.code ?? "no hard links on this volume"}), and copying that much for a check is not done`);
      copyBudget -= st.size;
      await copyCounted(src, dst, o.signal, b => { if (Date.now() - last >= 1000) { last = Date.now(); o.progress?.(0, `checking the package: copying ${rel} for the checks (no links here) · ${gb(b)} of ${gb(st.size)}`); } });
      m.copied += st.size;
    }
  };
  await walk(from, to, "");
  return m;
}

/* ─────────── the checks ─────────── */

export interface ChecksOpts {
  /** the install folder as it would ship (nothing in it is changed) */
  staging: string;
  /** the job's scratch folder (the throwaway copy and the checks' own home and wine prefix go in it) */
  work: string;
  spec: RuntimePlanSpec;
  /** the check to run in place of the plan's (a way's own, WayOverrides.check); undefined: the plan's */
  check?: PlanCheck | null;
  /** the game file's (or folder's) place in the install folder, or null when none was placed */
  placed: string | null;
  signal: AbortSignal;
  log: (line: string) => void;
  progress?: (p: number, message: string) => void;
  jobId?: number | null;
}

/** the last lines of what a program printed, at most 20 lines and 2000 characters */
function tailOf(r: ExecResult): string {
  const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  return lines.slice(-20).join("\n").slice(-2000);
}

/** the plan's checks (see the file header) */
export async function runChecks(o: ChecksOpts): Promise<CheckReport> {
  const check = o.check !== undefined ? o.check : o.spec.check ?? null;
  if (!check || (!check.steps.length && !check.smoke)) return { verdict: "none", steps: [], smoke: null, text: "no checks" };
  const steps: CheckStepReport[] = [];
  const kinds: ("pass" | "fail" | "env")[] = [];
  const note = (r: CheckStepReport, kind: "pass" | "fail" | "env") => { steps.push(r); kinds.push(kind); o.log(`check: ${r.what}: ${kind === "pass" ? "passed" : kind === "env" ? r.tail : `failed${r.code !== null ? ` (exit ${r.code})` : ""}${r.tail ? `: ${r.tail.split("\n").slice(-3).join(" | ")}` : ""}`}`); };
  if (!sandboxOrAllowed()) {
    for (const s of check.steps) note({ what: s.what, code: null, ok: false, tail: "not run here: a check runs a program, and programs run only in the build sandbox", seconds: 0 }, "env");
    const smoke = check.smoke ? envSmoke("not started here: a program starts only in the build sandbox") : null;
    return report(steps, kinds, smoke);
  }
  const can = await ticking(o.progress, 0, "checking: what this server can run (looked at once a day)", () => serverCan());
  const dir = await freshDir(join(o.work, "check"));
  const install = join(dir, "install");
  o.progress?.(0, "checking the package: a throwaway copy of the install folder");
  let mirror: Mirror;
  try { mirror = await throwaway(o.staging, install, { signal: o.signal, progress: o.progress }); }
  catch (e) {
    if (msgOf(e) === "cancelled" || o.signal.aborted) throw new Error("cancelled");
    if (e instanceof EnvError) {
      for (const s of check.steps) note({ what: s.what, code: null, ok: false, tail: `not run here: ${e.message}`, seconds: 0 }, "env");
      await removeTree(dir).catch(() => []);
      return report(steps, kinds, check.smoke ? envSmoke(`not started here: ${e.message}`) : null);
    }
    throw e;
  }
  o.log(`check: a throwaway copy of the install folder (${mirror.linked} big file${mirror.linked === 1 ? "" : "s"} linked, ${gb(mirror.copied)} copied)`);
  try {
    const at = (p: string, wine: boolean) => (wine ? winPath(p) : p);
    for (const [i, s] of check.steps.entries()) {
      if (o.signal.aborted) throw new Error("cancelled");
      const share = i / Math.max(1, check.steps.length + (check.smoke ? 1 : 0)), words = `checking: ${s.what} (${i + 1} of ${check.steps.length})`;
      o.progress?.(share, words);
      const lack = (s.needs ?? []).filter(n => !can.meets.includes(n));
      if (lack.length) { note({ what: s.what, code: null, ok: false, tail: `not run here: ${lacks(lack[0], can)}`, seconds: 0 }, "env"); continue; }
      const r = s.run;
      let exe: string, inInstall = false;
      if (r.tool) {
        const p = join(o.work, "tools", ...r.tool.split("/"));
        if (!(await lstat(p).catch(() => null))?.isFile()) { note({ what: s.what, code: null, ok: false, tail: `needs its tools built (${r.tool} is not there)`, seconds: 0 }, "fail"); continue; }
        exe = p;
      } else {
        const rel = r.exe!;
        const local = r.wine || rel.includes("/") || !!(await lstat(join(install, rel)).catch(() => null));
        if (local) {
          const found = await present(install, rel, mirror.symlinks);
          if (!found) { note({ what: s.what, code: null, ok: false, tail: `the install folder has no ${rel}`, seconds: 0 }, "fail"); continue; }
          exe = join(install, ...found.split("/"));
          inInstall = true;
        } else exe = rel;
      }
      const fill: Record<string, () => string> = {
        stage: () => at(install, r.wine), work: () => at(sandboxDirs(dir).scratch, r.wine),
        content: () => (o.placed ? at(join(install, ...o.placed.split("/")), r.wine) : "{content}"),
      };
      const t0 = Date.now();
      // below what the library keeps free the step is stopped, and the build waits for room (nothing more runs)
      const room = roomWatch(dir, `check ${i + 1} (${s.what})`, o.signal);
      let res: ExecResult;
      try {
        res = await ticking(o.progress, share, words, () => runSandboxedStep(r, {
          exe, cwd: install, fill, work: dir, signal: room.signal, log: o.log, phase: "check", judge: false, skip: mirror.links, symlinks: mirror.symlinks,
          ...(inInstall ? { wine: { cwd: dirname(exe) } } : {}),
          name: { log: `check ${i + 1}`, error: `check ${i + 1} (${s.what})` },
          unfilled: p => `check ${i + 1} needs {${p}}, and no game file was placed for it`,
        }));
      } catch (e) {
        const short = room.short();
        if (short) throw short;
        if (o.signal.aborted || msgOf(e) === "cancelled") throw new Error("cancelled");
        const env = e instanceof EnvError;
        note({ what: s.what, code: null, ok: false, tail: env ? `not run here: ${msgOf(e)}` : msgOf(e), seconds: Math.round((Date.now() - t0) / 1000) }, env ? "env" : "fail");
        continue;
      } finally { room.done(); }
      const seconds = Math.round((Date.now() - t0) / 1000);
      const trouble = exitTrouble(res, r.wine);
      if (trouble) { note({ what: s.what, code: res.code, ok: false, tail: `not run here: ${trouble === "oom" ? "the server ran out of memory" : "the server's CPU lacks an instruction it uses"} (exit ${res.code})\n${tailOf(res)}`.trim(), seconds }, "env"); continue; }
      const lines = `${res.stdout}\n${res.stderr}`.split(/\r?\n/).map(l => l.slice(0, LINE_CAP));
      const seen = !s.expect || lines.some(l => l.includes(s.expect!));
      const ok = res.code === 0 && !res.timedOut && seen;
      const why = res.timedOut ? `it ran out of time (${r.timeoutSec} s)` : res.code === 0 && !seen ? `no line of its output holds "${s.expect}"` : "";
      note({ what: s.what, code: res.code, ok, tail: [why, tailOf(res)].filter(Boolean).join("\n").slice(-2000), seconds }, ok ? "pass" : "fail");
    }
    let smoke: SmokeReport | null = null;
    if (check.smoke) {
      const share = check.steps.length / (check.steps.length + 1);
      smoke = await smokeStart({ staging: install, work: dir, spec: o.spec, placed: o.placed, smoke: check.smoke, signal: o.signal, log: o.log, jobId: o.jobId, skip: mirror.links, symlinks: mirror.symlinks, can, progress: o.progress ? (_p, m) => o.progress!(share, m) : undefined });
    }
    return report(steps, kinds, smoke);
  } finally {
    await stopUnder(dir).catch(() => 0);
    await removeTree(dir).catch(() => []);
  }
}

const envSmoke = (why: string): SmokeReport => ({ verdict: "env", alive: false, exitCode: null, titles: [], screenshot: null, outputTail: "", why });

/** the report's verdict and words: a step or smoke start that failed fails it; else one the server could not run makes it
 *  'env' (it proves nothing either way); else it passed */
function report(steps: CheckStepReport[], kinds: ("pass" | "fail" | "env")[], smoke: SmokeReport | null): CheckReport {
  const all = [...kinds, ...(smoke ? [smoke.verdict] : [])];
  const verdict: CheckReport["verdict"] = !all.length ? "none" : all.includes("fail") ? "fail" : all.includes("env") ? "env" : "pass";
  const lines = steps.map((s, i) => kinds[i] === "pass" ? `passed: ${s.what} (exit ${s.code}, ${s.seconds} s)`
    : kinds[i] === "env" ? `${s.tail.split("\n")[0]} (${s.what})`
    : `failed: ${s.what}${s.code !== null ? ` (exit ${s.code})` : ""}${s.tail ? `: ${s.tail.split("\n").slice(-3).join(" | ").slice(-300)}` : ""}`);
  if (smoke) lines.push(`${smoke.verdict === "pass" ? "started" : smoke.verdict === "env" ? "not started here" : "the start failed"}: ${smoke.why}`);
  return { verdict, steps, smoke, text: lines.join("; ") };
}

/** what a failed check says, for the job that throws it: "check: <what> failed (exit N): <tail>" (null when it did not fail) */
export function checkFailure(r: CheckReport): string | null {
  if (r.verdict !== "fail") return null;
  const s = r.steps.find(x => !x.ok && !x.tail.startsWith("not run here"));
  if (s) return `check: ${s.what} failed${s.code !== null ? ` (exit ${s.code})` : ""}${s.tail ? `: ${s.tail.split("\n").slice(-3).join(" | ").slice(-300)}` : ""}`;
  return r.smoke?.verdict === "fail" ? `check: the program's start failed: ${r.smoke.why}` : null;
}
/** what a check the server could not run says, for the job's message: "not started here: <why>" (null otherwise) */
export function checkEnvWords(r: CheckReport): string | null {
  if (r.verdict !== "env") return null;
  if (r.smoke?.verdict === "env") return r.smoke.why.startsWith("not started here") ? r.smoke.why : `not started here: ${r.smoke.why}`;
  const s = r.steps.find(x => x.tail.startsWith("not run here"));
  return s ? s.tail.split("\n")[0] : "not checked here";
}

/* ─────────── the smoke start ─────────── */

/* the program under wine on its own display: started, watched until it ends or the seconds are up, then its windows'
   titles and one screenshot; what it printed (wine's errors too) goes to a file, its exit code to another ("running"
   when it was still running at the end) */
const SMOKE_SCRIPT = [
  `dir=$1; titles=$2; shot=$3; out=$4; codef=$5; wine=$6; ws=$7; secs=$8; exe=$9; shift 9`,
  `cd "$dir" || exit 3`,
  `"$wine" wineboot -i >/dev/null 2>&1`,
  `"$wine" "$exe" "$@" >"$out" 2>&1 &`,
  `pid=$!`,
  `end=$(( $(date +%s) + secs ))`,
  `while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 1; done`,
  `{ xdotool search --onlyvisible --name '.+' getwindowname %@ 2>/dev/null || xwininfo -root -tree 2>/dev/null | sed -n 's/^ *0x[0-9a-f]* "\\(.*\\)": .*/\\1/p'; } > "$titles"`,
  // ImageMagick's import reads the display itself (xwd, in x11-apps, is only a fallback)
  `import -window root -resize '1024x1024>' png:"$shot" 2>/dev/null || { xwd -root -silent 2>/dev/null | convert xwd:- -resize '1024x1024>' png:"$shot" 2>/dev/null; }`,
  `if kill -0 "$pid" 2>/dev/null; then echo running > "$codef"; kill "$pid" 2>/dev/null; else wait "$pid"; echo "$?" > "$codef"; fi`,
  `[ -n "$ws" ] && "$ws" -k 2>/dev/null`,
  `exit 0`,
].join("\n");

export interface SmokeOpts {
  /** the install folder to start the program in: one nothing ships from (runChecks passes its throwaway copy) */
  staging: string;
  work: string;
  spec: RuntimePlanSpec;
  placed: string | null;
  /** how long to watch it (default: the smoke's own seconds, else 10; 1 to 60) */
  seconds?: number;
  /** the smoke start to make (a way's own check's); undefined: the plan's */
  smoke?: PlanCheck["smoke"];
  signal: AbortSignal;
  log: (line: string) => void;
  jobId?: number | null;
  /** files ludarr linked into staging: never handed to the build user, and allowed to stay links */
  skip?: Iterable<LinkRef> | null;
  symlinks?: Iterable<string> | null;
  /** what the server can run, when the caller has it already */
  can?: ServerCan;
  /** what it is doing, said again every few seconds while the program runs */
  progress?: (p: number, message: string) => void;
}

/** the screenshots older than 30 days go */
async function pruneShots(dir: string): Promise<void> {
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (!SHOT_NAME.test(n)) continue;
    const st = await stat(join(dir, n)).catch(() => null);
    if (st && ckdeps.now() - st.mtimeMs > SHOT_DAYS * DAY) await unlink(join(dir, n)).catch(() => {});
  }
}

/** start the program for a few seconds and report what it did (see the file header) */
export async function smokeStart(o: SmokeOpts): Promise<SmokeReport> {
  const def = o.smoke !== undefined ? o.smoke : o.spec.check?.smoke ?? null;
  const needs = def?.needs ?? "nothing";
  const seconds = Math.max(1, Math.min(60, Math.round(o.seconds ?? def?.seconds ?? 10)));
  if (!sandboxOrAllowed()) return envSmoke("not started here: a program starts only in the build sandbox");
  const tools = ckdeps.tools();
  if (!tools.wine || !tools.xvfb || !tools.bash) return envSmoke("not started here: wine or its virtual display is not on this server");
  const can = o.can ?? await serverCan();
  if ((needs === "gl" && can.gl === "none") || ((needs === "vulkan" || needs === "d3d12") && can.vulkan === "none"))
    return envSmoke(`not started here: the server has no graphics device${needs === "gl" ? "" : needs === "d3d12" ? " (Direct3D 12 needs Vulkan)" : " with Vulkan"}`);
  const launch = o.spec.launch;
  const exe = await present(o.staging, launch.exe, o.symlinks);
  if (!exe) return { verdict: "fail", alive: false, exitCode: null, titles: [], screenshot: null, outputTail: "", why: `the install folder has no ${launch.exe}` };
  const install = winPath(o.staging);
  const argv = launch.argv.map(a => fillInstall(o.placed ? a.replace(/\{content\}/g, () => `{install}/${o.placed}`) : a, install));
  if (argv.some(a => a.includes("{content}"))) return envSmoke("not started: the launch passes the game file, and none was placed");
  const env: Record<string, string> = { WINEDLLOVERRIDES: "mscoree,mshtml=" };
  for (const [k, v] of Object.entries(launch.env ?? {})) env[k] = fillInstall(v, install);
  const dir = await freshDir(join(o.work, "smoke"));
  const scratch = sandboxDirs(dir).scratch;
  const files = { titles: join(scratch, "smoke-titles.txt"), shot: join(scratch, "smoke.png"), out: join(scratch, "smoke-output.txt"), code: join(scratch, "smoke-exit.txt") };
  const cwd = launch.cwd ? join(o.staging, ...launch.cwd.split("/")) : o.staging;
  o.log(`smoke start: ${exe} for ${seconds} s (${needs === "nothing" ? "no graphics device asked for" : `it draws with ${needs}`})`);
  await handTo(o.staging, "builder", { skip: o.skip, log: o.log });                 // the program writes its settings where it is
  let res: ExecResult;
  try {
    const cmd = [tools.xvfb, "-a", "-s", "-screen 0 1280x720x24", tools.bash, "-c", SMOKE_SCRIPT, "smoke", cwd, files.titles, files.shot, files.out, files.code, tools.wine, wineserverPath(tools.wine) ?? "", String(seconds), join(o.staging, ...exe.split("/")), ...argv];
    res = await ticking(o.progress, 0, `checking: starting the program for ${seconds} s`, () => sandboxExec(cmd,
      { work: dir, cwd, env, override: { WINEDEBUG: "err+all" }, timeoutMs: (seconds + 120) * 1000, signal: o.signal, maxOutput: 8000, noNetwork: WINE_WITHOUT_NETWORK }));
  } finally {
    await stopUnder(dir).catch(() => 0);
    await handTo(o.staging, "root", { skip: o.skip, log: o.log });
  }
  if (o.signal.aborted) throw new Error("cancelled");
  if (res.timedOut) { await removeTree(dir).catch(() => []); return { verdict: "fail", alive: false, exitCode: null, titles: [], screenshot: null, outputTail: "", why: "the start did not come back in time" }; }
  // what the programs left in the build user's own folder is read without following a link: a link there could point at
  // any of root's files, which would then reach the report, the AI's next brief or the admin's screen
  const text = async (p: string, max: number) => (await readBuildFile(p, max))?.toString("utf8") ?? "";
  const titles = [...new Set((await text(files.titles, 64 * 1024)).split(/\r?\n/).map(t => t.trim().slice(0, 200)).filter(Boolean))].slice(0, 20);
  const output = (await text(files.out, 256 * 1024)).split(/\r?\n/).map(l => l.slice(0, 300)).filter(l => l.trim());
  const outputTail = output.slice(-40).join("\n");
  const codeText = (await text(files.code, 64)).trim();
  const alive = codeText === "running";
  const exitCode = alive || !/^-?\d+$/.test(codeText) ? null : Number(codeText);
  let screenshot: string | null = null;
  const png = await readBuildFile(files.shot, 16 * 2 ** 20);
  if (png && png.length > PNG.length && png.subarray(0, PNG.length).equals(PNG)) {
    const shots = ckdeps.shotsDir();
    await mkdir(shots, { recursive: true });
    const name = `job-${o.jobId ?? 0}-${ckdeps.now().toString(36)}.png`;
    await writeFile(join(shots, name), png, { flag: "wx" });
    screenshot = name;
    await pruneShots(shots);
  }
  await removeTree(dir).catch(() => []);
  // what it did, judged: a device it could not get proves nothing; an expected window that showed up proves it started
  const device = output.find(l => DEVICE_TROUBLE.test(l)) ?? null;
  const want = def?.title?.trim().toLowerCase() ?? null;
  const titled = want ? titles.some(t => t.toLowerCase().includes(want)) : null;
  const base = { alive, exitCode, titles, screenshot, outputTail };
  if (titled === true) return { ...base, verdict: "pass", why: `a window titled "${titles.find(t => t.toLowerCase().includes(want!))}" showed up` };
  if (device) return { ...base, verdict: "env", why: `not started here: the server has no graphics device it can use (${device.trim().slice(0, 160)})` };
  if (!alive && exitCode !== 0) return { ...base, verdict: "fail", why: `it ended within ${seconds} s with exit ${exitCode ?? "unknown"}` };
  if (titled === false) return { ...base, verdict: "fail", why: `no window titled "${def!.title}" showed up in ${seconds} s` };
  return { ...base, verdict: "pass", why: alive ? `it was still running after ${seconds} s${titles.length ? ` (${titles.slice(0, 3).map(t => `"${t}"`).join(", ")})` : ""}` : "it ended by itself (exit 0)" };
}
