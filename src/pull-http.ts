/**
 * ludarr — native HTTP(S) pull engine: segmented, resumable, no external binary.
 *
 * Used in bosun mode. The source says where bytes come from — the seedbox's own https file listing
 * (fast) or the connector's /v1/fs/file through the SSH tunnel — both speak Range. Each file is split
 * into N segments fetched concurrently and written in place at their offsets; progress is checkpointed
 * to a `<file>.ahoy-part` sidecar so a restart picks up where it left off. Directories are mirrored
 * file by file; files already complete on disk are skipped.
 */
import { mkdir, open, stat, readFile, writeFile, unlink } from "node:fs/promises";
import { join, posix, dirname } from "node:path";
import type { PullJob, PullHandle, PullResult } from "./pull";

export interface RemoteEntry { name: string; size: number; isDir: boolean }
export interface HttpSource {
  stat(path: string): Promise<{ size: number; isDir: boolean }>;
  list(path: string): Promise<RemoteEntry[]>;
  request(path: string): Promise<{ url: string; headers?: Record<string, string> }>;
}
export interface HttpPullOpts {
  downloadsDir: string;
  segments?: number;            // per file (default 4)
  minSegmentBytes?: number;     // never split below this (default 8 MiB)
  retries?: number;             // per segment (default 5)
  idleMs?: number;              // a segment's connection that sends nothing for this long is dropped and retried (default 2 min)
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface Seg { start: number; end: number; done: number }        // [start, end); done = bytes written from start
interface PartState { size: number; segs: Seg[] }
interface PlannedFile { remote: string; local: string; size: number; rel: string }   // rel: its path inside a download that is a folder

export const PART_EXT = ".ahoy-part";

export function startHttpPull(job: PullJob, src: HttpSource, opts: HttpPullOpts): PullHandle {
  const base = posix.basename(job.remotePath.replace(/\\/g, "/").replace(/\/+$/, ""));
  const name = !base || base === "." || base === ".." ? "download" : base;
  const localPath = join(opts.downloadsDir, name);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));   // runtime-agnostic: the launcher runs this under Node
  const ac = new AbortController();
  let settled = 0;     // bytes of files fully on disk
  let inflight = 0;    // bytes so far of the file in progress
  let walked = false;  // the plan came from a folder's listing (a single file has none)
  const total = () => settled + inflight;

  const done: Promise<PullResult> = run().catch((e: any) => ({
    ok: false, localPath, bytes: total(), error: ac.signal.aborted ? "cancelled" : String(e?.message ?? e),
  }));

  return {
    localPath, done,
    progress: () => (job.expectedBytes > 0 ? Math.min(1, total() / job.expectedBytes) : 0),
    bytes: total,
    cancel: () => ac.abort(),
  };

  async function run(): Promise<PullResult> {
    const files = await plan();
    for (const f of files) await take(f);
    // the client's size is exact (a torrent's): a listing that showed fewer bytes left files out, and that is no finished
    // transfer — unless the client's own list of the torrent's files says all of them are here (wholeByClient)
    if (job.exact && job.expectedBytes > 0 && total() < job.expectedBytes && !(await wholeByClient(files)))
      return { ok: false, localPath, bytes: total(), error: `the transfer fetched ${total()} of the ${job.expectedBytes} bytes the client has: the file listing leaves some of the download out` };
    return { ok: true, localPath, bytes: total() };
  }

  /** one file onto the disk: skipped when it is here whole, resumed from its sidecar, else fetched */
  async function take(f: PlannedFile) {
    if (ac.signal.aborted) throw new Error("cancelled");
    await mkdir(dirname(f.local), { recursive: true });
    const have = await stat(f.local).catch(() => null);
    const part = await readPart(f.local);
    if (have?.isFile() && have.size === f.size && !part) { settled += f.size; return; }
    await downloadFile(f, part);
    settled += f.size;
    inflight = 0;
  }

  /**
   * A torrent whose listing showed fewer bytes than its client has. A web server's index leaves entries out by design (nginx
   * never lists a name that starts with a dot, Apache's stock IndexIgnore hides those and README*) and serves them all the
   * same, so a listing alone cannot say the download is short: the files the client itself says the torrent holds (job.files)
   * are asked for by their paths. True once every one of them is here at its size (the client's total also counts files it
   * was told not to download). False when the client cannot say, names a path that is none inside the download (never
   * fetched), or has a file at another size than the listing showed. A hidden file the server will not serve either ends the
   * transfer in words that name it: trying again would list the same and fail the same (src/fetch.ts fails it at once).
   */
  async function wholeByClient(listed: PlannedFile[]): Promise<boolean> {
    if (!job.files || !walked) return false;
    let own: { path: string; size: number }[];
    try { own = await job.files(); } catch { return false; }
    if (!Array.isArray(own) || !own.length) return false;
    const have = new Map(listed.map(f => [f.rel, f.size]));
    const rest: PlannedFile[] = [];
    for (const o of own) {
      const parts = String(o?.path ?? "").replace(/^\/+/, "").split("/"), size = Number(o?.size);
      if (parts.some(p => !p || p === "." || p === ".." || p.includes("\\")) || !Number.isSafeInteger(size) || size < 0) return false;
      const rel = parts.join("/");
      if (have.has(rel)) { if (have.get(rel) !== size) return false; continue; }
      have.set(rel, size);
      rest.push({ remote: posix.join(job.remotePath, rel), local: join(localPath, ...parts), size, rel });
    }
    for (const f of rest) {
      try { await take(f); }
      catch (e: any) {
        const refused = /^HTTP (4\d\d) /.exec(String(e?.message ?? ""))?.[1];
        if (refused && !ac.signal.aborted && f.rel.split("/").some(p => p.startsWith(".")))
          throw new Error(`the file listing does not show ${f.rel} and the server does not serve it either (HTTP ${refused}): this download cannot be fetched whole over the Transfer URL — map the client's folder, or use an sftp:// Transfer URL`);
        throw e;
      }
    }
    return true;
  }

  async function plan(): Promise<PlannedFile[]> {
    if (!job.isDir) {
      const s = await src.stat(job.remotePath);
      if (!s.isDir) return [{ remote: job.remotePath, local: localPath, size: s.size, rel: "" }];
    }
    walked = true;
    return walk(job.remotePath, localPath, "");
  }

  async function walk(rp: string, lp: string, rel: string): Promise<PlannedFile[]> {
    const out: PlannedFile[] = [];
    await mkdir(lp, { recursive: true });
    for (const e of await src.list(rp)) {
      // whatever the source lists, a file lands inside this download's own folder
      if (!e.name || e.name === "." || e.name === ".." || /[\/\\]/.test(e.name)) throw new Error(`the listing of ${rp} names "${e.name}", which is no file name: nothing was fetched`);
      const r = posix.join(rp, e.name), l = join(lp, e.name), at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDir) out.push(...await walk(r, l, at));
      else out.push({ remote: r, local: l, size: e.size, rel: at });
    }
    return out;
  }

  async function readPart(local: string): Promise<PartState | null> {
    try {
      const p = JSON.parse(await readFile(local + PART_EXT, "utf8")) as PartState;
      return Array.isArray(p.segs) && typeof p.size === "number" ? p : null;
    } catch { return null; }
  }

  async function downloadFile(f: PlannedFile, part: PartState | null) {
    const partFile = f.local + PART_EXT;
    if (f.size === 0) { await writeFile(f.local, new Uint8Array()); await unlink(partFile).catch(() => {}); return; }
    let state: PartState;
    if (part && part.size === f.size && part.segs.some(s => s.done > 0)) state = part;
    else {
      const n = Math.max(1, Math.min(opts.segments ?? 4, Math.floor(f.size / (opts.minSegmentBytes ?? 8 * 1024 * 1024)) || 1));
      const per = Math.ceil(f.size / n);
      state = { size: f.size, segs: Array.from({ length: n }, (_, i) => ({ start: i * per, end: Math.min(f.size, (i + 1) * per), done: 0 })).filter(s => s.end > s.start) };
      await (await open(f.local, "w")).close();          // create / truncate
    }
    const save = () => writeFile(partFile, JSON.stringify(state));
    const sum = () => state.segs.reduce((a, s) => a + s.done, 0);
    inflight = sum();
    await save();
    let lastSave = Date.now();
    const onProgress = async () => {
      inflight = sum();
      if (Date.now() - lastSave > 2000) { lastSave = Date.now(); await save(); }
    };
    try {
      await Promise.all(state.segs.map(seg => runSegment(f, seg, state.segs.length, onProgress)));
    } finally {
      await save();                                       // the sidecar always reflects what is on disk
    }
    if (ac.signal.aborted) throw new Error("cancelled");
    if (sum() !== f.size) throw new Error(`short download: ${sum()}/${f.size} bytes of ${f.remote}`);
    await unlink(partFile).catch(() => {});
  }

  async function runSegment(f: PlannedFile, seg: Seg, nSegs: number, onProgress: () => Promise<void>) {
    const retries = opts.retries ?? 5, idleMs = opts.idleMs ?? 120_000;
    for (let attempt = 0; seg.done < seg.end - seg.start; attempt++) {
      if (ac.signal.aborted) return;
      // a connection that stands still (a seedbox whose link is full, a proxy that hangs) is dropped after idleMs and the
      // segment retried from where it stopped — a transfer never hangs on one silent socket
      const live = new AbortController();
      const stop = () => live.abort();
      ac.signal.addEventListener("abort", stop, { once: true });
      let idle: ReturnType<typeof setTimeout> | null = null;
      const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => live.abort(), idleMs); };
      try {
        const from = seg.start + seg.done, to = seg.end - 1;
        const { url, headers } = await src.request(f.remote);
        arm();
        const res = await fetchImpl(url, { headers: { ...headers, range: `bytes=${from}-${to}` }, signal: live.signal });
        if (res.status === 200) {
          if (from !== 0 || nSegs > 1) {
            await res.body?.cancel().catch(() => {});
            throw new Error("server ignored Range (set PULL_SEGMENTS=1 if it never supports it)");
          }
        } else if (res.status !== 206) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${res.status} for ${f.remote}`);
        }
        if (!res.body) throw new Error("empty body");
        const fh = await open(f.local, "r+");
        try {
          const reader = res.body.getReader();
          let pos = from;
          for (;;) {
            const { value, done } = await reader.read();
            arm();
            if (done) break;
            if (!value?.length) continue;
            const room = seg.end - pos;
            const chunk = value.length > room ? value.subarray(0, room) : value;
            await fh.write(chunk, 0, chunk.length, pos);
            pos += chunk.length;
            seg.done = pos - seg.start;
            await onProgress();
            if (pos >= seg.end || ac.signal.aborted) { await reader.cancel().catch(() => {}); break; }
          }
        } finally { await fh.close(); }
        if (seg.done < seg.end - seg.start) throw new Error(`connection ended early at byte ${seg.start + seg.done} of ${f.remote}`);
      } catch (e) {
        if (ac.signal.aborted) return;
        if (attempt >= retries) throw live.signal.aborted ? new Error(`the connection stood still for ${Math.round(idleMs / 1000)} s at byte ${seg.start + seg.done} of ${f.remote}`) : e;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      } finally {
        if (idle) clearTimeout(idle);
        ac.signal.removeEventListener("abort", stop);
      }
    }
  }
}
