/**
 * ludarr — reading files without stopping the server, and removing folders safely on the shares it lives on.
 *
 *   fileChunks(path)   a file's bytes in pieces, each read off the server's own thread: the one way a file on disk is read
 *                      whole (hashed, copied), so a game of any size is taken in while every request is still answered
 *
 * Unraid's user shares (shfs, a FUSE filesystem) keep a deleted-but-still-open file around as ".fuse_hidden…"
 * until the last handle closes; unlinking that entry only renames it again. node's fs.rm (Bun's in particular)
 * retries until the folder is empty, so one process that still has a file open in there — an Xvfb an importer
 * forgot, a wine helper — spins it forever, and the kernel never lets that thread go (job 24, 11 hours, a reboot).
 *
 *   removeTree(path)   one pass, never a retry: whatever cannot go is reported, not fought
 *   reapUnder(dir)     SIGKILL every process that still works out of dir (cwd, exe, open files, WINEPREFIX) — Linux
 */
import { lstat, open, readdir, unlink, rmdir, readlink, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * A file's bytes, in order, in pieces of at most `size` bytes (1 MiB). Each read is done off the server's own thread, so
 * whatever reads a file through this (a hash, a copy) leaves the server answering between two pieces.
 *
 * Bun.file(path).stream() does not: on Linux a loop over it keeps the thread until the file ends. Measured in the live
 * container on 2026-11-11 (Bun 1.4.4): while a file was read that way no timer fired and no request was answered, from
 * memory and from the disk alike, and the server stood still for the 2 minutes 44 it took to hash a 26 GB import (it
 * would be about 11 minutes for a 94 GB one). Read through a file handle, as here, every timer was on time and every
 * request answered, at the same speed. So nothing in the server reads a file on disk through Bun.file().stream()
 * (tests/file-reads.test.ts holds that).
 *
 * Every piece is a buffer of its own, the caller's to keep. `start`: the byte to begin at. Leaving the loop early (a
 * break, a throw) closes the file.
 */
export async function* fileChunks(path: string, o: { size?: number; start?: number } = {}): AsyncGenerator<Uint8Array, void, void> {
  const size = Math.max(1, Math.floor(o.size ?? 1 << 20));
  const fh = await open(path, "r");
  try {
    // a small file gets a buffer of its own size; a file that grows while it is read is still read to its end
    let left = Math.max(0, (await fh.stat()).size - (o.start ?? 0));
    for (let pos = Math.max(0, o.start ?? 0); ; ) {
      const want = left > 0 ? Math.min(size, left) : Math.min(size, 64 * 1024);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (!bytesRead) return;
      pos += bytesRead; left -= bytesRead;
      yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
    }
  } finally { await fh.close().catch(() => { /* closed */ }); }
}

/** removes a file or a whole tree; returns the entries that are still there afterwards (empty = gone) */
export async function removeTree(path: string, concurrency = 16): Promise<string[]> {
  const left: string[] = [];
  const st = await lstat(path).catch(() => null);
  if (!st) return left;
  if (!st.isDirectory()) {
    await unlink(path).catch(e => { if (e?.code !== "ENOENT") left.push(path); });
    return left;
  }
  const names = await readdir(path).catch(() => [] as string[]);
  for (let i = 0; i < names.length; i += concurrency) {
    const part = await Promise.all(names.slice(i, i + concurrency).map(n => removeTree(join(path, n), concurrency)));
    for (const p of part) left.push(...p);
  }
  await rmdir(path).catch(e => { if (e?.code !== "ENOENT") left.push(path); });
  return left;
}

export interface ProcRef { pid: number; pgid: number; name: string; paths: string[] }

/** every live process in /proc with the paths it holds: cwd, exe, open files, WINEPREFIX (Linux; empty elsewhere) */
export async function listProcs(procRoot = "/proc"): Promise<ProcRef[]> {
  if (process.platform !== "linux") return [];
  const out: ProcRef[] = [];
  for (const n of await readdir(procRoot).catch(() => [] as string[])) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n), dir = join(procRoot, n);
    const status = await readFile(join(dir, "status"), "utf8").catch(() => "");
    if (!status || /^State:\s+Z/m.test(status)) continue;                  // a zombie holds nothing
    const stat = await readFile(join(dir, "stat"), "utf8").catch(() => "");
    const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2] ?? "0") || 0;
    const name = /^Name:\s+(.*)$/m.exec(status)?.[1] ?? "";
    const paths: string[] = [];
    for (const l of ["cwd", "exe"]) { const t = await readlink(join(dir, l)).catch(() => ""); if (t) paths.push(t); }
    for (const fd of await readdir(join(dir, "fd")).catch(() => [] as string[])) {
      const t = await readlink(join(dir, "fd", fd)).catch(() => "");
      if (t.startsWith("/")) paths.push(t.replace(/ \(deleted\)$/, ""));
    }
    const env = await readFile(join(dir, "environ")).catch(() => null);
    if (env) for (const kv of env.toString("utf8").split("\0")) if (kv.startsWith("WINEPREFIX=")) paths.push(kv.slice(11));
    out.push({ pid, pgid, name, paths });
  }
  return out;
}

const under = (p: string, dir: string) => { const a = resolve(p), b = resolve(dir); return a === b || a.startsWith(b + sep); };

/** kills (SIGKILL) every process that still works out of dir, except this one; returns their pids */
export async function reapUnder(dir: string, deps: { procs?: () => Promise<ProcRef[]>; kill?: (pid: number, sig: NodeJS.Signals) => void; self?: number; wait?: number } = {}): Promise<number[]> {
  const procs = await (deps.procs ?? listProcs)();
  const self = deps.self ?? process.pid;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const hits = procs.filter(p => p.pid !== self && p.pid !== 1 && p.paths.some(x => under(x, dir)));
  const ownGroup = procs.find(p => p.pid === self)?.pgid ?? -1;
  for (const p of hits) {
    if (p.pgid > 1 && p.pgid !== ownGroup) { try { kill(-p.pgid, "SIGKILL"); } catch { /* gone */ } }
    try { kill(p.pid, "SIGKILL"); } catch { /* gone */ }
  }
  if (hits.length && (deps.wait ?? 1500) > 0) await new Promise(r => setTimeout(r, deps.wait ?? 1500));   // let the kernel close their files
  return hits.map(p => p.pid);
}
