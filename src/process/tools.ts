/**
 * ludarr — processing toolbox: run external programs (7z, innoextract, wine …) with a timeout and
 * capped output, and find out which of them this host has. `Exec` is injectable so the recipes and
 * the agent can be tested without any of the binaries present.
 */
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }
/** inheritEnv false: the program gets only `env` (the build sandbox: no secret from ludarr's own environment reaches it) */
export interface ExecOpts { cwd?: string; timeoutMs?: number; maxOutput?: number; env?: Record<string, string>; signal?: AbortSignal; inheritEnv?: boolean }
export type Exec = (cmd: string[], opts?: ExecOpts) => Promise<ExecResult>;

const cap = (s: string, max: number) =>
  s.length > max ? s.slice(0, Math.floor(max / 2)) + `\n…[${s.length - max} chars trimmed]…\n` + s.slice(-Math.floor(max / 2)) : s;

export const realExec: Exec = async (cmd, opts = {}) => {
  // on Linux the command leads its own process group (setsid execs in place), so an abort or a timeout can take the
  // whole tree with it: an installer under wine spawns helpers that outlive it and would otherwise keep our pipes open
  const grouped = process.platform === "linux" && !!Bun.which("setsid");
  let p: ReturnType<typeof Bun.spawn>;
  try {
    const env = opts.inheritEnv === false ? { ...(opts.env ?? {}) } : { ...process.env, ...(opts.env ?? {}) };
    p = Bun.spawn(grouped ? ["setsid", ...cmd] : cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
  } catch (e: any) {
    return { code: 127, stdout: "", stderr: `cannot start ${cmd[0]}: ${e?.message ?? e}`, timedOut: false };
  }
  let timedOut = false, stopped = false;
  const stop = () => {
    stopped = true;
    if (grouped) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } }
    try { p.kill("SIGKILL"); } catch { /* already gone */ }
  };
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs) : null;
  opts.signal?.addEventListener("abort", stop, { once: true });
  const max = opts.maxOutput ?? 200_000;
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n / 2) + `\n… [${s.length - n} chars dropped] …\n` + s.slice(-n / 2) : s);
  const outcome = Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  // a stopped tree may leave a pipe open somewhere: ten seconds after the stop we return with what there is
  const grace = new Promise<[string, string, number]>(r => { const tick = setInterval(() => { if (stopped) { clearInterval(tick); setTimeout(() => r(["", "", -1]), 10_000); } }, 250); outcome.finally(() => clearInterval(tick)); });
  const [stdout, stderr, code] = await Promise.race([outcome, grace]);
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", stop);
  return { code, stdout: cap(stdout, max), stderr: cap(stderr, max), timedOut };
};

/* ─────────── what an import's programs are given ─────────── */

/** what an import's programs find on PATH on the server: the image's own folders, /usr/local/bin first (the wine wrapper
 *  is there). A dev box that is not Linux keeps its own PATH: its tools sit wherever they were installed */
export const IMPORT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** the only names an import's programs take from ludarr's own environment: how the server writes text and what time it
 *  keeps (an unpacker names and dates files by them), and on a Windows dev box what the system needs to start anything */
const IMPORT_KEEP = ["LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const IMPORT_KEEP_WIN = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP"];

/**
 * The whole environment of a program an import starts (an unpacker, an installer under wine, the AI importer's shell): a
 * PATH, a home of its own in the job's scratch folder, the server's locale and time zone, and what the caller adds for
 * this one program (a wine prefix, INPUT/STAGING/WORK). Nothing else of ludarr's environment: the download is someone
 * else's program, and the indexer, seedbox and AI keys ludarr was started with are not its to read. No TMPDIR either:
 * the image's wine does not start with one set.
 */
export function importEnv(work: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.platform === "linux" ? IMPORT_PATH : process.env.PATH ?? "", HOME: join(work, "home") };
  for (const k of [...IMPORT_KEEP, ...(process.platform === "win32" ? IMPORT_KEEP_WIN : [])]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

/** `inner` as an import runs its programs: with importEnv and nothing inherited (the home folder is made first) */
export function importExec(work: string, inner: Exec = realExec): Exec {
  return async (cmd, opts = {}) => {
    const env = importEnv(work, opts.env);
    await mkdir(env.HOME, { recursive: true }).catch(() => { /* the program then runs without one */ });
    return inner(cmd, { ...opts, env, inheritEnv: false });
  };
}

/** portable tools dropped next to the backend (backend/tools, git-ignored) win over PATH — handy on a dev box */
export const TOOLS_DIR = resolve(import.meta.dir, "../../tools");

/** backend/tools, then Bun.which, then the usual bin dirs (a thin PATH inside containers / cron) */
export function findTool(...names: string[]): string | null {
  for (const n of names) {
    for (const p of [join(TOOLS_DIR, n), join(TOOLS_DIR, n + ".exe")]) { try { if (statSync(p).isFile()) return p; } catch { /* next */ } }
    const w = Bun.which(n);
    if (w) return w;
    for (const d of [TOOLS_DIR, "/usr/local/bin", "/usr/bin", "/bin", join(homedir(), "bin"), join(homedir(), ".local/bin"), "C:/Program Files/7-Zip"]) {
      for (const p of [join(d, n), join(d, n + ".exe")]) {
        try { if (statSync(p).isFile()) return p; } catch { /* next */ }
      }
    }
  }
  return null;
}

export interface Toolbox {
  sevenZip: string | null; unar: string | null; unrar: string | null; innoextract: string | null;
  wine: string | null; xvfb: string | null; bash: string | null;
  /** helpers/dlgdrive.c: drives a GUI-only installer's dialog under wine (fill the directory, clear checkboxes, press Install, wait) */
  dlgdrive: string | null;
}
export function toolbox(): Toolbox {
  return {
    sevenZip: findTool("7z", "7zz", "7za"), unar: findTool("unar"), unrar: findTool("unrar"), innoextract: findTool("innoextract"),
    wine: findTool("wine", "wine64"), xvfb: findTool("xvfb-run"), bash: findTool("bash"), dlgdrive: findTool("dlgdrive.exe"),
  };
}
export const describeToolbox = (t: Toolbox) =>
  Object.entries(t).map(([k, v]) => `${k}: ${v ?? "missing"}`).join(", ");
