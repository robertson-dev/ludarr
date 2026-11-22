/**
 * ludarr — a package as blocks: what lets a launcher take a game in a few requests instead of one per file.
 *
 * A package is its folder of files and a manifest that lists them. Sent file by file that is one request for every file
 * (34,000 for one game of the library, one after another), nothing compressed, every changed file whole on an update, and
 * the whole game read a second time to check it. Here the same package is also a list of blocks: each file cut at every
 * BLOCK bytes (1 MiB), each block named by its sha256. The folder in the library stays what it is, plain files: the ways
 * to play are built on them, so nothing is stored twice.
 *
 *   the index   <config>/blocks/<package id>.blk, written once per package, never inside the package's own folder:
 *                 header (64 bytes)   "AHOYBLK1", u32 block size, u32 files, u32 blocks, u32 0, f64 built at (ms),
 *                                     the file list's digest (32 bytes); numbers little-endian
 *                 blocks × 32 bytes   each block's sha256: files in the manifest's order, a file's blocks in order
 *                 files × 8 bytes     each file's mtime (f64 ms) when the index was written: the server's own, never sent
 *               The digest (filesDigest) ties an index to one list of files: a package whose files are not that list has
 *               no index until one is built for it. A start changed by hand changes no file, so the index stays.
 *   built       in the pass that reads every file for the manifest (an import: process/validate.ts buildManifest hands
 *               each file's block hashes over, process/runner.ts writes the index once the package is in the library), or
 *               by the task `blocks` for a package that has none (the library from before, a way put together from files
 *               ludarr placed without reading them): one read of the package, each file's sha256 held against the
 *               manifest's on the way, so no index is ever built over a file that is not the one that was imported.
 *   served      GET  /api/v1/package/:id/blocks   the header and the hashes
 *               POST /api/v1/package/:id/blocks   { digest, want: [[file, first block, count], …] } → those blocks in the
 *                    order asked, as frames: u8 kind (0 as it is, 1 one zstd frame, 255 an error's words, after which
 *                    the stream ends), u32 length, payload. A block travels compressed only when that makes it smaller.
 *               A file is read only while it is still the file that was indexed (its size and its mtime), and only inside
 *               the package's folder; the caller names files by their number in the manifest, never by a path.
 *
 * Every read goes through a file handle (fsutil.ts): the server answers everything else while blocks are read and sent.
 */
import { mkdir, open, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configDir } from "./config";
import { stmts, type PackageRow } from "./db";
import { fileChunks } from "./fsutil";
import { FsError, Roots } from "./bosun/fs";
import { logger } from "./log";

const log = logger("Blocks");

/** a block: this many bytes of a file (its last block is what is left) */
export const BLOCK = 1 << 20;
const MAGIC = "AHOYBLK1", HEADER = 64, HASH = 32;
/** the most one request may ask for: bytes of the files as they are, and runs */
export const MAX_REQUEST_BYTES = 256 * BLOCK, MAX_RUNS = 40_000;
/** a block smaller than this goes as it is; a compressed block must be at least this much smaller to be sent compressed */
const MIN_COMPRESS = 256, WORTH = 0.97;
/** after this many blocks of a file in a row that did not shrink, the next REST blocks of that file go untried */
const POOR = 4, REST = 63;
/** a package the task could not index is tried again after this long (a file of it is not the file that was imported) */
const RETRY_MS = 24 * 3600_000;
/** a file is still the one indexed while its time is the recorded one to within this (two ways of asking a file's time
 *  may round its nanoseconds differently; a file written again is seconds or years away) */
const SAME_TIME_MS = 1;

export const blkdeps = {
  dir: (): string => process.env.LUDARR_BLOCKS_DIR || join(configDir(), "blocks"),
  now: (): number => Date.now(),
  compress: (b: Uint8Array): Promise<Uint8Array> => Bun.zstdCompress(b, { level: 3 }) as Promise<Uint8Array>,
};

export class BlockError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

interface ListedFile { path: string; size: number; sha256: string }
export const blockCount = (size: number) => (size > 0 ? Math.ceil(size / BLOCK) : 0);

/** what ties an index to one list of files: their paths, sizes and sha256, in the manifest's order */
export function filesDigest(files: readonly ListedFile[]): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) h.update(`${f.path}\0${f.size}\0${f.sha256}\n`);
  return h.digest("hex");
}

/** the sha256 of each block of one file, from its bytes in whatever pieces they come */
export class BlockHasher {
  private h = new Bun.CryptoHasher("sha256");
  private fill = 0;
  private out: Uint8Array[] = [];
  push(chunk: Uint8Array) {
    for (let off = 0; off < chunk.byteLength;) {
      const take = Math.min(BLOCK - this.fill, chunk.byteLength - off);
      this.h.update(off === 0 && take === chunk.byteLength ? chunk : chunk.subarray(off, off + take));
      this.fill += take; off += take;
      if (this.fill === BLOCK) this.cut();
    }
  }
  private cut() { this.out.push(new Uint8Array(this.h.digest())); this.h = new Bun.CryptoHasher("sha256"); this.fill = 0; }
  /** the hashes, one after another (HASH bytes each) */
  end(): Uint8Array {
    if (this.fill) this.cut();
    const all = new Uint8Array(this.out.length * HASH);
    this.out.forEach((d, i) => all.set(d, i * HASH));
    return all;
  }
}

/* ─────────── the indexes on disk, and what is known of them ─────────── */

interface Ready { digest: string; blocks: number; files: number; builtAt: number; path: string }
const ready = new Map<number, Ready>();
const indexPath = (id: number) => join(blkdeps.dir(), `${id}.blk`);

async function readHeader(path: string): Promise<Ready | null> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(path, "r");
    const head = Buffer.alloc(HEADER);
    const { bytesRead } = await fh.read(head, 0, HEADER, 0);
    if (bytesRead !== HEADER || head.toString("latin1", 0, 8) !== MAGIC || head.readUInt32LE(8) !== BLOCK) return null;
    const files = head.readUInt32LE(12), blocks = head.readUInt32LE(16);
    if ((await fh.stat()).size !== HEADER + blocks * HASH + files * 8) return null;
    return { digest: head.toString("hex", 32, 64), blocks, files, builtAt: head.readDoubleLE(24), path };
  } catch { return null; }
  finally { await fh?.close().catch(() => { /* closed */ }); }
}

/** the indexes in the folder that are not known yet (after a start; one another process wrote) */
export async function primeIndexes(): Promise<void> {
  for (const name of await readdir(blkdeps.dir()).catch(() => [] as string[])) {
    const m = /^(\d+)\.blk$/.exec(name);
    if (!m || ready.has(Number(m[1]))) continue;
    const r = await readHeader(join(blkdeps.dir(), name));
    if (r) ready.set(Number(m[1]), r);
  }
}

/** a package's list of files as its manifest gives it, with the digest: kept for the last few packages asked about */
interface Listed { json: string; files: ListedFile[]; digest: string }
const listed = new Map<number, Listed>();
const LISTED_MAX = 8;
function listOf(p: Pick<PackageRow, "id" | "manifest_json">): Listed | null {
  const had = listed.get(p.id);
  if (had && had.json === p.manifest_json) { listed.delete(p.id); listed.set(p.id, had); return had; }
  let files: ListedFile[];
  try {
    const raw = JSON.parse(p.manifest_json)?.files;
    if (!Array.isArray(raw)) return null;
    files = raw.map((f: any) => ({ path: String(f?.path ?? ""), size: Number(f?.size), sha256: String(f?.sha256 ?? "") }));
    if (files.some(f => !f.path || !Number.isSafeInteger(f.size) || f.size < 0)) return null;
  } catch { return null; }
  const l = { json: p.manifest_json, files, digest: filesDigest(files) };
  listed.delete(p.id); listed.set(p.id, l);
  while (listed.size > LISTED_MAX) listed.delete(listed.keys().next().value as number);
  return l;
}

/** the index of a package as it is now: its file list's own, or none */
function liveIndex(p: Pick<PackageRow, "id" | "manifest_json">): { index: Ready; list: Listed } | null {
  const index = ready.get(p.id);
  if (!index) return null;
  const list = listOf(p);
  return list && list.digest === index.digest && list.files.length === index.files ? { index, list } : null;
}

/** what a package says of itself to a launcher: {size, count, digest} when it can be taken as blocks, else null */
export function blocksOf(p: Pick<PackageRow, "id" | "manifest_json">): { size: number; count: number; digest: string } | null {
  const l = liveIndex(p);
  return l ? { size: BLOCK, count: l.index.blocks, digest: l.index.digest } : null;
}

/**
 * Write a package's index from its files' block hashes (`hashes(path)`: a file's hashes one after another, or nothing when
 * they are not known). Nothing is written, and null comes back, when a file's hashes are missing or are not as many as its
 * size makes, or when a file is not on disk at that size: the task builds the index then, from the files themselves.
 */
export async function writeIndex(p: Pick<PackageRow, "id" | "path" | "manifest_json">, hashes: (path: string) => Uint8Array | undefined): Promise<{ blocks: number } | null> {
  const list = listOf(p);
  if (!list) return null;
  const root = resolve(p.path);
  const counts = list.files.map(f => blockCount(f.size));
  const blocks = counts.reduce((a, n) => a + n, 0);
  if (blocks > 0xffff_ffff || list.files.length > 0xffff_ffff) return null;
  const out = Buffer.alloc(HEADER + blocks * HASH + list.files.length * 8);
  out.write(MAGIC, 0, "latin1");
  out.writeUInt32LE(BLOCK, 8); out.writeUInt32LE(list.files.length, 12); out.writeUInt32LE(blocks, 16);
  const builtAt = blkdeps.now();
  out.writeDoubleLE(builtAt, 24);
  Buffer.from(list.digest, "hex").copy(out, 32);
  let at = HEADER;
  const times = HEADER + blocks * HASH;
  for (const [i, f] of list.files.entries()) {
    const h = counts[i] ? hashes(f.path) : new Uint8Array();
    if (!h || h.byteLength !== counts[i]! * HASH) return null;
    const st = await stat(join(root, ...f.path.split("/"))).catch(() => null);
    if (!st?.isFile() || st.size !== f.size) return null;
    out.set(h, at); at += h.byteLength;
    out.writeDoubleLE(st.mtimeMs, times + i * 8);
  }
  await mkdir(blkdeps.dir(), { recursive: true });
  const path = indexPath(p.id), tmp = `${path}.${process.pid}.${builtAt}.part`;
  try { await writeFile(tmp, out); await rename(tmp, path); }
  catch (e) { await rm(tmp, { force: true }).catch(() => { /* gone */ }); throw e; }
  ready.set(p.id, { digest: list.digest, blocks, files: list.files.length, builtAt, path });
  mtimes.delete(p.id);
  return { blocks };
}

/** each file's mtime as the index recorded it (its last section), for the last few packages served */
const mtimes = new Map<number, { builtAt: number; at: Float64Array }>();
async function mtimesOf(id: number, index: Ready): Promise<Float64Array> {
  const had = mtimes.get(id);
  if (had && had.builtAt === index.builtAt) return had.at;
  const fh = await open(index.path, "r");
  try {
    const buf = Buffer.alloc(index.files * 8);
    const { bytesRead } = await fh.read(buf, 0, buf.byteLength, HEADER + index.blocks * HASH);
    if (bytesRead !== buf.byteLength) throw new BlockError("the block index is cut short", 500);
    const at = new Float64Array(index.files);
    for (let i = 0; i < index.files; i++) at[i] = buf.readDoubleLE(i * 8);
    mtimes.delete(id); mtimes.set(id, { builtAt: index.builtAt, at });
    while (mtimes.size > LISTED_MAX) mtimes.delete(mtimes.keys().next().value as number);
    return at;
  } finally { await fh.close().catch(() => { /* closed */ }); }
}

/* ─────────── serving ─────────── */

const jsonAnswer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** GET: the header and the hashes of a package's index (not the server's own last section) */
export function indexResponse(p: PackageRow, head = false): Response {
  const l = liveIndex(p);
  if (!l) return jsonAnswer(404, { error: "this package has no block index" });
  const size = HEADER + l.index.blocks * HASH;
  return new Response(head ? null : Bun.file(l.index.path).slice(0, size), {
    headers: { "content-type": "application/octet-stream", "content-length": String(size), etag: `"${l.index.digest}"`, "cache-control": "no-store" },
  });
}

type Run = [file: number, first: number, count: number];
function parseWant(want: unknown, files: readonly ListedFile[]): { runs: Run[]; blocks: number; bytes: number } {
  if (!Array.isArray(want) || !want.length) throw new BlockError("want: a list of [file, first block, count]");
  if (want.length > MAX_RUNS) throw new BlockError(`more than ${MAX_RUNS} runs in one request`, 413);
  const runs: Run[] = [];
  let blocks = 0, bytes = 0;
  for (const w of want) {
    if (!Array.isArray(w) || w.length !== 3 || !w.every(x => Number.isSafeInteger(x) && x >= 0)) throw new BlockError("want: each entry is [file, first block, count], whole numbers");
    const [fi, first, count] = w as Run;
    const f = files[fi];
    if (!f) throw new BlockError(`want: there is no file ${fi} in this package`);
    if (count < 1 || first + count > blockCount(f.size)) throw new BlockError(`want: file ${fi} has ${blockCount(f.size)} block(s)`);
    blocks += count;
    bytes += Math.min(f.size, (first + count) * BLOCK) - first * BLOCK;
    if (bytes > MAX_REQUEST_BYTES) throw new BlockError(`more than ${MAX_REQUEST_BYTES / BLOCK} MiB in one request`, 413);
    runs.push([fi, first, count]);
  }
  return { runs, blocks, bytes };
}

const frameHead = (kind: number, length: number) => { const b = Buffer.allocUnsafe(5); b[0] = kind; b.writeUInt32LE(length, 1); return b; };
export const FRAME = { raw: 0, zstd: 1, error: 255 } as const;

/** streams being sent now (blocksStatus) */
let sending = 0;

/** the blocks of the runs asked, in order, each as a frame's head and then its payload; an error is the last frame */
async function* frames(root: string, files: readonly ListedFile[], times: Float64Array, runs: readonly Run[], what: string): AsyncGenerator<Uint8Array, void, void> {
  sending++;
  try {
    const roots = await Roots.of([root]);
    for (const [fi, first, count] of runs) {
      const f = files[fi]!;
      let fh: FileHandle | null = null;
      try {
        // the file as it really lies (a link that leads out of the package's folder is refused), and still the one indexed
        fh = await open(await roots.resolve(join(root, ...f.path.split("/"))), "r");
        const st = await fh.stat();
        if (!st.isFile() || st.size !== f.size || Math.abs(st.mtimeMs - times[fi]!) > SAME_TIME_MS) throw new BlockError(`${f.path} is not the file that was indexed any more`, 409);
        let poor = 0, rest = 0;
        for (let i = first; i < first + count; i++) {
          const off = i * BLOCK, len = Math.min(BLOCK, f.size - off);
          const buf = Buffer.allocUnsafe(len);
          for (let got = 0; got < len;) {
            const { bytesRead } = await fh.read(buf, got, len - got, off + got);
            if (!bytesRead) throw new BlockError(`${f.path} ends before its size`, 409);
            got += bytesRead;
          }
          let kind: number = FRAME.raw, payload: Uint8Array = buf;
          if (len >= MIN_COMPRESS && rest > 0) rest--;
          else if (len >= MIN_COMPRESS) {
            const z = await blkdeps.compress(buf);
            if (z.byteLength < len * WORTH) { kind = FRAME.zstd; payload = z; poor = 0; }
            else if (++poor >= POOR) { poor = POOR - 1; rest = REST; }
          }
          yield frameHead(kind, payload.byteLength);
          yield payload;
        }
      } finally { await fh?.close().catch(() => { /* closed */ }); }
    }
  } catch (e: any) {
    const msg = e instanceof FsError ? `a file of the package cannot be read (${e.message})` : String(e?.message ?? e);
    log.warn(`${what}: sending blocks stopped: ${msg}`);
    const words = Buffer.from(msg.slice(0, 500), "utf8");
    yield frameHead(FRAME.error, words.byteLength);
    yield words;
  } finally { sending--; }
}

/** POST: the blocks asked for, as one stream */
export async function blocksResponse(p: PackageRow, body: unknown): Promise<Response> {
  const l = liveIndex(p);
  if (!l) return jsonAnswer(404, { error: "this package has no block index" });
  const b = (body && typeof body === "object" ? body : {}) as { digest?: unknown; want?: unknown };
  if (b.digest !== l.index.digest) return jsonAnswer(409, { error: "this package's files are not the ones asked for", digest: l.index.digest });
  let want: ReturnType<typeof parseWant>;
  try { want = parseWant(b.want, l.list.files); }
  catch (e) { if (e instanceof BlockError) return jsonAnswer(e.status, { error: e.message }); throw e; }
  let times: Float64Array;
  try { times = await mtimesOf(p.id, l.index); }
  catch (e: any) { return jsonAnswer(500, { error: String(e?.message ?? e) }); }
  const it = frames(resolve(p.path), l.list.files, times, want.runs, `${p.name} (package ${p.id})`);
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { value, done } = await it.next();
        if (done) c.close(); else c.enqueue(value);
      } catch (e) { c.error(e); }
    },
    async cancel() { await it.return(undefined).catch(() => { /* closed */ }); },
  });
  return new Response(stream, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-blocks": String(want.blocks) } });
}

/* ─────────── building an index from a package's files ─────────── */

/**
 * One read of the package: every file's blocks hashed, and its sha256 held against the manifest's on the way. An index is
 * written only when every file is the file the manifest lists (so a launcher that checks blocks ends up with exactly what
 * one that checks files does); otherwise the package stays file by file, and why is said.
 */
export async function indexPackage(p: PackageRow, o: { signal?: AbortSignal } = {}): Promise<{ ok: true; blocks: number; bytes: number } | { ok: false; why: string }> {
  const list = listOf(p);
  if (!list) return { ok: false, why: "its manifest lists no files" };
  const root = resolve(p.path);
  const roots = await Roots.of([root]);
  const hashes = new Map<string, Uint8Array>();
  let bytes = 0;
  for (const f of list.files) {
    const real = await roots.resolve(join(root, ...f.path.split("/"))).catch(() => null);
    if (!real) return { ok: false, why: `${f.path} is not in the package's folder` };
    const whole = new Bun.CryptoHasher("sha256"), cut = new BlockHasher();
    let size = 0;
    for await (const chunk of fileChunks(real)) {
      if (o.signal?.aborted) throw new Error("cancelled");
      whole.update(chunk); cut.push(chunk); size += chunk.byteLength;
    }
    if (size !== f.size || whole.digest("hex") !== f.sha256) return { ok: false, why: `${f.path} is not the file that was imported` };
    hashes.set(f.path, cut.end());
    bytes += size;
  }
  const r = await writeIndex(p, path => hashes.get(path));
  return r ? { ok: true, blocks: r.blocks, bytes } : { ok: false, why: "a file changed while the package was read" };
}

const refused = new Map<number, { digest: string; at: number; why: string }>();
let working: { id: number; name: string; since: number } | null = null;

/** index files whose package is gone */
async function sweepIndexes(): Promise<void> {
  const have = new Set((stmts.packagesAll.all() as PackageRow[]).map(p => p.id));
  for (const name of await readdir(blkdeps.dir()).catch(() => [] as string[])) {
    const m = /^(\d+)\.blk$/.exec(name);
    const stale = m ? !have.has(Number(m[1])) : /\.part$/.test(name) && !name.includes(`.${process.pid}.`);
    if (!stale) continue;
    await rm(join(blkdeps.dir(), name), { force: true }).catch(() => { /* next time */ });
    if (m) { ready.delete(Number(m[1])); mtimes.delete(Number(m[1])); listed.delete(Number(m[1])); refused.delete(Number(m[1])); }
  }
}

/**
 * The task: one package without an index gets one, the newest first (the games asked for last are installed next). One a
 * run, and none while a job runs: an import reads the same disks, and is not kept waiting behind the whole library.
 */
export async function blocksTick(): Promise<void> {
  await primeIndexes();
  await sweepIndexes();
  if ((stmts.jobsByState.all("running") as unknown[]).length) return;
  for (const p of stmts.packagesAll.all() as PackageRow[]) {
    if (liveIndex(p)) continue;
    const no = refused.get(p.id), digest = listOf(p)?.digest ?? "";
    if (no && no.digest === digest && blkdeps.now() - no.at < RETRY_MS) continue;
    working = { id: p.id, name: p.name, since: blkdeps.now() };
    try {
      const r = await indexPackage(p).catch((e: any) => ({ ok: false as const, why: String(e?.message ?? e) }));
      const secs = Math.max(1, Math.round((blkdeps.now() - working.since) / 1000));
      if (r.ok) { refused.delete(p.id); log.info(`${p.name}: can be sent as blocks now (${r.blocks} blocks, ${(r.bytes / 1e9).toFixed(2)} GB read in ${secs} s)`); }
      else { refused.set(p.id, { digest, at: blkdeps.now(), why: r.why }); log.warn(`${p.name} (package ${p.id}) stays file by file: ${r.why}`); }
    } finally { working = null; }
    return;
  }
}

/** how far the library is: for the admin, and for whoever checks a deploy */
export function blocksStatus() {
  const all = stmts.packagesAll.all() as PackageRow[];
  const done = all.filter(p => liveIndex(p));
  return {
    packages: all.length, ready: done.length, blocks: done.reduce((n, p) => n + (ready.get(p.id)?.blocks ?? 0), 0), sending,
    working: working ? { id: working.id, name: working.name, since: working.since } : null,
    waiting: all.filter(p => !liveIndex(p) && !refused.has(p.id)).map(p => ({ id: p.id, name: p.name })),
    refused: all.filter(p => !liveIndex(p) && refused.has(p.id)).map(p => ({ id: p.id, name: p.name, why: refused.get(p.id)!.why })),
  };
}

/** tests: forget everything known (the folder is the test's own) */
export function resetBlocks() { ready.clear(); listed.clear(); mtimes.clear(); refused.clear(); working = null; sending = 0; }
