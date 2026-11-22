import { constants } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { removeTree } from "../fsutil";

const folder = ".resume";
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function privateFolder(path: string): Promise<boolean> {
  const st = await lstat(path).catch(e => { if (missing(e)) return null; throw e; });
  return !!st?.isDirectory() && (process.platform !== "linux" || (st.uid === process.getuid!() && !(st.mode & 0o077)));
}

/** Only the job runner can publish completed stages. A partial tree has no published name. */
export async function checkpointPath(work: string, key: string): Promise<string> {
  const dir = join(work, folder);
  await mkdir(dir, { mode: 0o700, recursive: true });
  if (!await privateFolder(dir) || await realpath(dir) !== await realpath(work).then(w => join(w, folder)))
    throw new Error("the job checkpoint folder is not a private directory");
  return join(dir, new Bun.CryptoHasher("sha256").update(key).digest("hex"));
}
export async function completed(path: string): Promise<boolean> {
  return (await lstat(path).catch(e => { if (missing(e)) return null; throw e; }))?.isDirectory() === true;
}
export async function publishStage(source: string, saved: string) {
  if (await realpath(source) !== resolve(source) || !(await lstat(source)).isDirectory()) throw new Error("the completed stage is not a plain directory");
  for (let i = 0; ; i++) {
    try { await rename(source, saved); return; }
    catch (e) {
      if (process.platform !== "win32" || i >= 8 || !["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await new Promise(resolve => setTimeout(resolve, 50 * (i + 1)));
    }
  }
}

/** Each subsequent step gets its own writable files. SSD filesystems can clone the data blocks. */
export async function restoreStage(saved: string, dest: string, signal?: AbortSignal) {
  await mkdir(dest, { recursive: true });
  if (!(await lstat(dest)).isDirectory()) throw new Error("invalid extraction destination");
  for (const entry of await readdir(saved, { withFileTypes: true })) {
    signal?.throwIfAborted();
    const src = join(saved, entry.name), target = join(dest, entry.name);
    if (entry.isDirectory()) await restoreStage(src, target, signal);
    else if (entry.isFile()) {
      const prior = await lstat(target).catch(e => { if (missing(e)) return null; throw e; });
      if (prior && !prior.isFile()) throw new Error(`cannot overlay a non-file: ${target}`);
      if (prior) await removeTree(target);
      await cp(src, target, { mode: constants.COPYFILE_FICLONE, preserveTimestamps: true, force: false, errorOnExist: true });
    } else throw new Error("completed extraction contains a link or special file");
  }
}

export async function hasCheckpoints(work: string) {
  const dir = join(work, folder);
  return await privateFolder(dir) && (await readdir(dir, { withFileTypes: true })).some(e => e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name));
}

export async function clearInterruptedWork(work: string) {
  for (const name of await readdir(work).catch(e => { if (missing(e)) return []; throw e; })) {
    const p = join(work, name);
    if (name === folder && await privateFolder(p)) continue;
    const left = await removeTree(p);
    if (left.length) throw new Error(`could not clear interrupted work at ${p}`);
  }
}
