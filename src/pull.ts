/**
 * ludarr — remote client → this machine, driven by lftp.
 *
 * One transport URL covers sftp:// ftps:// ftp:// — whatever the seedbox host offers —
 * and lftp gives us segmented (pget -n) + resumable (-c / --continue) pulls for free.
 * The script goes in over stdin so credentials never appear on a command line.
 * Progress is measured on disk (allocated blocks, so sparse pget targets don't lie),
 * not scraped from lftp's output.
 */
import { stat, readdir, mkdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { codeOf, messageOf, transportTrouble } from "./transport";
/** `exact`: the client's size is the exact size of the files (a torrent's): a folder that weighs less is still arriving.
 *  `look`: the files were found missing before — a mapped folder that does not show them says so within minutes.
 *  `files`: the client's own word on what a torrent holds (paths inside its folder, sizes) — asked when a file listing shows
 *  less than the client has: a web server's index leaves entries out (src/pull-http.ts) */
export interface PullJob { staging?: string; fetchId?: number; remotePath: string; isDir: boolean; expectedBytes: number; exact?: boolean; look?: boolean; files?: () => Promise<{ path: string; size: number }[]> }
/** how to reach the remote files: sftp:// ftps:// ftp:// (or https://) with credentials in the URL */
export interface PullOpts { url: string; downloadsDir: string; pathStrip?: string; verifyTls?: boolean; segments?: number }
export interface PullResult { ok: boolean; localPath: string; bytes: number; error?: string }
export interface PullHandle {
  localPath: string;
  done: Promise<PullResult>;
  progress(): number;
  bytes(): number;
  cancel(): void;
  /** it waits by design (a mounted folder that has not shown the download yet, or is settling): no stall watchdog */
  waits?: boolean;
}

/** the slice of Bun.spawn we use — swappable in tests */
export interface SpawnLike {
  stdin: { write(s: string): unknown; end(): unknown };
  stderr: ReadableStream<Uint8Array> | null | number;
  exited: Promise<number>;
  kill(): void;
}
export type Spawner = (cmd: string[]) => SpawnLike;

const gone = (e: unknown) => codeOf(e) === "ENOENT" || codeOf(e) === "ENOTDIR";

/** what a folder (or file) weighs right now: bytes and entries, walked through whatever filesystem it is on. An entry that
 *  vanished between a listing and its stat counts as nothing; any other error (the mount failing: EIO, a timeout, a stale
 *  handle) is thrown, never counted as 0 — two equal readings of a half-visible folder must never look settled */
export async function measure(p: string): Promise<{ bytes: number; files: number }> {
  let s: Awaited<ReturnType<typeof stat>>;
  try { s = await stat(p); } catch (e) { if (gone(e)) return { bytes: 0, files: 0 }; throw e; }
  if (!s.isDirectory()) return { bytes: s.size, files: 1 };
  let bytes = 0, files = 0;
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(p, { withFileTypes: true }); } catch (e) { if (gone(e)) return { bytes: 0, files: 0 }; throw e; }
  for (const e of entries) {
    const m = await measure(join(p, e.name));
    bytes += m.bytes; files += m.files;
  }
  return { bytes, files };
}

/**
 * a finished download that should be visible under a mounted client folder (remote path mapping). The client says
 * it is complete, but the folder is read through a mount (whose listing may lag) or a sync (which may still be
 * copying): wait for it to appear, then for two measurements `settleMs` apart to agree before handing it to the
 * import — never a half-arrived folder: a reading the mount failed on is no reading, and a torrent that weighs less than
 * the client says (`job.exact`) is still arriving; a folder that loses files or bytes while it is measured (the hourly move
 * out of complete/ deleting what it copied) is never settled on what is left of it — it is going away. After `maxMs` (30
 * min; 2 min to appear on a `look`) it says why it is still waiting (the fetch worker judges that against the client:
 * src/fetch.ts — a mapping to check, a seedbox that does not answer, or files gone).
 */
export function waitForLocal(localPath: string, job: PullJob, opts: { pollMs?: number; maxMs?: number; settleMs?: number; exists?: (p: string) => Promise<boolean>; measure?: (p: string) => Promise<{ bytes: number; files: number }> } = {}): PullHandle {
  const pollMs = opts.pollMs ?? 15_000, maxMs = opts.maxMs ?? 30 * 60_000, settleMs = opts.settleMs ?? 20_000;
  const appearMs = job.look ? Math.min(maxMs, 2 * 60_000) : maxMs;
  const exists = opts.exists ?? (async (p: string) => { try { await stat(p); return true; } catch (e) { if (gone(e)) return false; throw e; } });
  const weigh = opts.measure ?? measure;
  let cancelled = false, timer: ReturnType<typeof setTimeout> | null = null, wake: (() => void) | null = null, seen = 0;
  const sleep = (ms: number) => new Promise<void>(r => { wake = r; timer = setTimeout(r, ms); });
  const done = (async (): Promise<PullResult> => {
    const t0 = Date.now();
    let trouble: string | null = null;
    for (;;) {
      if (cancelled) return { ok: false, localPath, bytes: seen, error: "cancelled" };
      let there = false;
      try { there = await exists(localPath); trouble = null; } catch (e) { trouble = transportTrouble(e) ?? messageOf(e); }
      if (there) break;
      if (Date.now() - t0 >= appearMs) return { ok: false, localPath, bytes: 0, error: trouble ? `the mapped folder did not answer while ${localPath} was looked for: ${trouble}` : `${localPath} never appeared under the mapped folder — is the mount up?` };
      await sleep(pollMs);
    }
    let last: { bytes: number; files: number } | null = null, most: { bytes: number; files: number } | null = null;
    while (!cancelled) {
      let now: { bytes: number; files: number } | null = null;
      try { now = await weigh(localPath); trouble = null; } catch (e) { trouble = transportTrouble(e) ?? messageOf(e); }
      if (now) {
        seen = now.bytes;
        // a folder that loses what it held is going away (moved out of complete/): never handed on with part of it — a
        // torrent's still arrives (its client's size says when it is whole)
        if (most && !job.exact && (now.files < most.files || now.bytes < most.bytes)) return { ok: false, localPath, bytes: seen, error: `${localPath} went away from the mapped folder while it was measured (${now.files} of ${most.files} files left): moved away?` };
        if (!most || now.bytes >= most.bytes) most = now;
        const short = !!job.exact && job.expectedBytes > 0 && now.bytes < job.expectedBytes;
        if (last && !short && now.bytes === last.bytes && now.files === last.files && now.files > 0) return { ok: true, localPath, bytes: now.bytes };
      }
      if (Date.now() - t0 >= maxMs) {
        const error = trouble ? `the mapped folder failed while ${localPath} was measured: ${trouble}`
          : job.exact && job.expectedBytes > 0 && seen < job.expectedBytes ? `${localPath} kept changing: ${seen} of the ${job.expectedBytes} bytes the client has are visible so far`
          : `${localPath} kept changing for hours — is something still writing it?`;
        return { ok: false, localPath, bytes: seen, error };
      }
      last = now;
      await sleep(settleMs);
    }
    return { ok: false, localPath, bytes: seen, error: "cancelled" };
  })();
  return { localPath, done, waits: true, progress: () => (job.expectedBytes > 0 ? Math.min(1, seen / job.expectedBytes) : 0),   // a share 0..1, like every other pull (requests.ts maps it onto the transfer leg)
  bytes: () => seen, cancel() { cancelled = true; if (timer) clearTimeout(timer); wake?.(); } };
}

export function transportUrl(raw: string): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return /^(sftp|ftps?|https?):$/.test(u.protocol) ? u : null;
  } catch { return null; }
}
export const lftpAvailable = () => !!Bun.which("lftp");

/** seedbox absolute path → path as the transport sees it (chrooted FTP needs the home prefix dropped) */
export function remotePath(seedboxPath: string, pathStrip = ""): string {
  const strip = pathStrip.replace(/\/+$/, "");
  let p = seedboxPath.replace(/\\/g, "/");
  if (strip && p === strip) p = "/";
  else if (strip && p.startsWith(strip + "/")) p = p.slice(strip.length);
  return p || "/";
}

/** lftp double-quoted argument: backslashes and quotes escaped */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** the name a download takes in the downloads folder: the last part of its remote path — never none, "." or ".." (a client
 *  that reports its own root as the item's path would make the downloads folder itself the download) */
export function localName(remote: string): string {
  const name = posix.basename(remote.replace(/\\/g, "/").replace(/\/+$/, ""));
  return !name || name === "." || name === ".." ? "download" : name;
}
export function localPathFor(job: PullJob, opts: Pick<PullOpts, "downloadsDir" | "pathStrip">): string {
  return join(opts.downloadsDir, localName(remotePath(job.remotePath, opts.pathStrip)));
}

export function lftpScript(u: URL, job: PullJob, opts: PullOpts): string {
  const seg = opts.segments || 8;
  const verify = opts.verifyTls !== false;
  const auth = u.username ? `${u.username}${u.password ? ":" + u.password : ""}@` : "";
  const host = `${u.protocol}//${auth}${u.hostname}${u.port ? ":" + u.port : ""}`;
  const remote = remotePath(job.remotePath, opts.pathStrip);
  const local = localPathFor(job, opts);
  const localDir = posix.dirname(local.replace(/\\/g, "/"));
  return [
    "set cmd:interactive no",
    "set cmd:fail-exit yes",
    "set sftp:auto-confirm yes",
    `set ssl:verify-certificate ${verify ? "yes" : "no"}`,
    "set net:timeout 30",
    "set net:max-retries 5",
    "set net:reconnect-interval-base 5",
    "set net:reconnect-interval-max 60",
    "set xfer:clobber on",
    `set pget:default-n ${seg}`,
    `open ${q(host)}`,
    job.isDir
      ? `mirror --continue --use-pget-n=${seg} --parallel=2 --no-perms ${q(remote)} ${q(local)}`
      : `pget -c -n ${seg} -O ${q(localDir)} ${q(remote)}`,
    "quit",
  ].join("\n") + "\n";
}

/** bytes actually on disk (allocated blocks when the fs reports them, else logical size) */
export async function diskBytes(path: string): Promise<number> {
  const st = await stat(path);
  const real = (s: typeof st) => (s.blocks && s.blocks > 0 ? Math.min(s.size, s.blocks * 512) : s.size);
  if (!st.isDirectory()) return real(st);
  let total = 0;
  for (const ent of await readdir(path, { withFileTypes: true })) {
    const p = join(path, ent.name);
    if (ent.isDirectory()) total += await diskBytes(p);
    else if (ent.isFile()) total += real(await stat(p));
  }
  return total;
}

const realSpawn: Spawner = cmd => Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "pipe" }) as unknown as SpawnLike;

export function startPull(job: PullJob, opts: PullOpts, spawn: Spawner = realSpawn): PullHandle {
  const localPath = localPathFor(job, opts);
  let bytes = 0, cancelled = false, proc: SpawnLike | null = null;

  const done = (async (): Promise<PullResult> => {
    const u = transportUrl(opts.url);
    if (!u) return { ok: false, localPath, bytes: 0, error: "no transfer URL (sftp://host) on this download client" };
    const bin = Bun.which("lftp");
    if (!bin && spawn === realSpawn) return { ok: false, localPath, bytes: 0, error: "lftp not installed on this host" };
    await mkdir(opts.downloadsDir, { recursive: true });
    proc = spawn([bin ?? "lftp"]);
    proc.stdin.write(lftpScript(u, job, opts));
    proc.stdin.end();
    const stderrP = proc.stderr && typeof proc.stderr !== "number" ? new Response(proc.stderr).text() : Promise.resolve("");
    const poll = setInterval(() => { diskBytes(localPath).then(b => { bytes = b; }).catch(() => {}); }, 2000);
    const code = await proc.exited;
    clearInterval(poll);
    bytes = await diskBytes(localPath).catch(() => bytes);
    const err = (await stderrP).trim().split("\n").filter(Boolean).slice(-4).join(" | ");
    if (cancelled) return { ok: false, localPath, bytes, error: "cancelled" };
    if (code !== 0) return { ok: false, localPath, bytes, error: `lftp exit ${code}${err ? ": " + err : ""}` };
    return { ok: true, localPath, bytes };
  })();

  return {
    localPath,
    done,
    progress: () => (job.expectedBytes > 0 ? Math.min(1, bytes / job.expectedBytes) : 0),
    bytes: () => bytes,
    cancel: () => { cancelled = true; proc?.kill(); },
  };
}
