import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { waitForLocal, type PullHandle, type PullJob } from "./pull";

/** Wait for the client's finished copy, then transfer regular files to Ludarr's own volume. */
export function stageMapped(source: string, job: PullJob, parent: string): PullHandle {
  const wait = waitForLocal(source, job);
  const stop = new AbortController();
  const name = basename(source);
  if (!name || name === "." || name === "..") throw new Error("the client returned no download name");
  const localPath = join(parent, name);
  const partial = join(parent, ".partial-" + name);
  let bytes = 0, copying = false;
  async function copy(src: string, dest: string) {
    stop.signal.throwIfAborted();
    const st = await lstat(src);
    if (st.isDirectory()) {
      await mkdir(dest);
      for (const entry of await readdir(src)) await copy(join(src, entry), join(dest, entry));
    } else if (st.isFile()) {
      const stream = createReadStream(src);
      stream.on("data", chunk => { bytes += Buffer.byteLength(chunk); });
      await pipeline(stream, createWriteStream(dest, { flags: "wx" }), { signal: stop.signal });
      const after = await lstat(src);
      if (!after.isFile() || after.size !== st.size || after.mtimeMs !== st.mtimeMs || (await lstat(dest)).size !== st.size) throw new Error("the client file changed during transfer");
    } else throw new Error("the client folder contains a link or special file");
  }
  const done = wait.done.then(async ready => {
    if (!ready.ok) return { ...ready, localPath };
    copying = true;
    await mkdir(parent, { recursive: true });
    if (await lstat(localPath).catch(() => null)) return { ok: true, bytes: ready.bytes, localPath };
    await rm(partial, { force: true, recursive: true });
    await copy(source, partial);
    if (job.exact && job.expectedBytes > 0 && bytes < job.expectedBytes) throw new Error("incomplete mapped download");
    await rename(partial, localPath);
    return { ok: true, bytes, localPath };
  }).catch(error => ({ ok: false, bytes, localPath, error: String(error?.message ?? error) }));
  return { localPath, done, get waits() { return !copying; }, bytes: () => bytes,
    progress: () => job.expectedBytes > 0 ? Math.min(1, bytes / job.expectedBytes) : 0,
    cancel() { stop.abort(); wait.cancel(); } };
}
