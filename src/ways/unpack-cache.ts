import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { removeTree } from "../fsutil";

const cacheDir = (work: string) => join(dirname(work), ".content-unpacks");
const marker = (work: string, slot: string) => join(work, ".complete-" + slot);
const existsDir = async (p: string) => (await lstat(p).catch(() => null))?.isDirectory() === true;
const trusted = (st: {mode: number; uid: number}) => process.platform !== "linux" || (st.uid === process.getuid!() && !(st.mode & 0o022));
const privateDir = async (p: string) => {
  const st = await lstat(p).catch(() => null);
  return !!st && st.isDirectory() && trusted(st) && (process.platform !== "linux" || !(st.mode & 0o077));
};
const slotName = /^unpacked-0-[0-2]$/;
const digest = /^[0-9a-f]{64}$/;

/** Bind a complete top-level extraction to this way and to every volume of its source. */
export async function unpackKey(way: number, paths: string[]) {
  const hash = createHash("sha256");
  for (const p of paths) {
    const st = await lstat(p);
    if (!st.isFile()) throw Error("Archive volume is no longer a file");
    hash.update(JSON.stringify([way, p, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs]));
  }
  return hash.digest("hex");
}

export async function markUnpacked(work: string, slot: string, key: string) {
  if (!slotName.test(slot) || !digest.test(key)) return;
  await writeFile(marker(work, slot), key, { mode: 0o600 });
}

/** A waiting extraction stays behind a private directory. Only the current job gets its tree. */
export async function claimUnpacked(work: string, slot: string, key: string) {
  if (!slotName.test(slot) || !digest.test(key)) return false;
  const saved = join(cacheDir(work), key);
  if (!await privateDir(cacheDir(work)) || !await existsDir(saved)) return false;
  await mkdir(work, { recursive: true });
  // Record before rename so a restart in between cannot lose a successfully claimed tree.
  await markUnpacked(work, slot, key);
  try { await rename(saved, join(work, slot)); return true; }
  catch (e) {
    await rm(marker(work, slot), { force: true });
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return false;
  }
}

/** Called after stopping the job's workers and before discarding scratch. An interrupted extraction has no marker. */
export async function keepUnpacked(work: string) {
  for (const name of await readdir(work).catch(() => [] as string[])) {
    if (!name.startsWith(".complete-")) continue;
    const slot = name.slice(".complete-".length);
    if (!slotName.test(slot)) continue;
    const file = marker(work, slot);
    const m = await lstat(file);
    if (!m.isFile() || m.nlink !== 1 || !trusted(m)) continue;
    const key = await readFile(file, "utf8");
    const source = join(work, slot);
    if (!digest.test(key) || !await existsDir(source)) continue;
    await mkdir(cacheDir(work), { mode: 0o700, recursive: true });
    if (!await privateDir(cacheDir(work))) continue;
    const dest = join(cacheDir(work), key);
    if (await existsDir(dest)) continue;
    await utimes(source, new Date(), new Date());
    await rename(source, dest);
  }
}

/** Unclaimed retries expire after one day. A claimed directory is already back in its job. */
export async function expireUnpacks(top: string) {
  const cache = join(top, ".content-unpacks");
  if (!await privateDir(cache)) return;
  for (const name of await readdir(cache).catch(() => [] as string[])) {
    if (!digest.test(name) && !name.startsWith(".expired-")) continue;
    const p = join(cache, name);
    const st = await lstat(p).catch(() => null);
    if (!st?.isDirectory() || Date.now() - st.mtimeMs < 86400_000) continue;
    const gone = join(cache, ".expired-" + randomUUID());
    if (await rename(p, gone).then(() => true, () => false)) await removeTree(gone);
  }
}
