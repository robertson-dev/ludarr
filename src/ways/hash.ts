/**
 * ludarr — hashing game files and system files: every algorithm a plan may name (src/ways/types.ts HASH_ALGOS) in one
 * streaming pass, so an 8 GB disc image is read once. sha1, md5 and sha256 run on Bun's native hashers; crc32, crc32c
 * and the xxHash family run on hash-wasm (Bun has no crc32c or xxh3-128, and its own crc32 and xxHash take a whole
 * buffer only).
 *
 * N64 dumps come in three byte orders, and every published hash is of the big-endian one (z64). With {n64: true} the
 * first four bytes say which order a file is in: 80 37 12 40 is z64, 37 80 40 12 is v64 (16-bit words swapped), 40 12
 * 37 80 is n64 (32-bit words reversed). A v64 or n64 dump is turned into z64 bytes as it streams, with a carry of up to
 * three bytes across chunks: `hashes` are then of the z64 bytes and `rawHashes` of the bytes as they came in. Anything
 * else (and a z64 dump) passes through untouched and has no rawHashes.
 *
 * A file hashed where it lies (hashInPlace: the game's copy, a file linked into the store, a made file) is read once, with
 * progress in bytes of the whole about every second, and its stat is taken before and after: a file that changed while it
 * was read is read again, and refused when it changes once more (src/ways/types.ts HashedStat is what is kept with the
 * hashes, so a later read can trust them only while the file is the same). A game FOLDER is named by its canonical listing
 * ("rel\tsize\tsha256\n" for every file, sorted by rel): its sha1 and sha256 are a folder row's hashes (hashTree reads each
 * file once; a listing of sizes and times instead of contents names a folder that is only an input).
 */
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createCRC32, createXXHash128, createXXHash3, createXXHash64, type IHasher } from "hash-wasm";
import { fileChunks } from "../fsutil";
import { EnvError } from "./errors";
import type { HashAlgo, Hashes, HashedStat } from "./types";

export type N64Order = "z64" | "v64" | "n64";
export interface HashResult {
  size: number;
  /** of the bytes as stored: z64 for an N64 dump, the bytes as received otherwise */
  hashes: Hashes;
  /** of the bytes as received, when they were reordered */
  rawHashes?: Hashes;
  /** what was done to the bytes, for the admin ("n64 byte order v64 → z64"); null when nothing was */
  normalized?: string | null;
  /** the N64 byte order the file came in (null: not an N64 dump, or n64 detection off) */
  order?: N64Order | null;
}

/** the byte order of an N64 dump from its first four bytes, or null when they are not an N64 header */
export function n64Order(head: Uint8Array): N64Order | null {
  if (head.length < 4) return null;
  const [a, b, c, d] = head;
  if (a === 0x80 && b === 0x37 && c === 0x12 && d === 0x40) return "z64";
  if (a === 0x37 && b === 0x80 && c === 0x40 && d === 0x12) return "v64";
  if (a === 0x40 && b === 0x12 && c === 0x37 && d === 0x80) return "n64";
  return null;
}

/** one hasher per algorithm, fed the same bytes */
class HashSet {
  private constructor(private native: [HashAlgo, Bun.CryptoHasher][], private wasm: [HashAlgo, IHasher][]) {}
  static async create(): Promise<HashSet> {
    const [crc32, crc32c, xxh64, xxh3, xxh128] = await Promise.all([createCRC32(), createCRC32(0x82f63b78), createXXHash64(), createXXHash3(), createXXHash128()]);
    const wasm: [HashAlgo, IHasher][] = [["crc32", crc32], ["crc32c", crc32c], ["xxh64", xxh64], ["xxh3-64", xxh3], ["xxh3-128", xxh128]];
    for (const [, h] of wasm) h.init();
    return new HashSet([["sha1", new Bun.CryptoHasher("sha1")], ["md5", new Bun.CryptoHasher("md5")], ["sha256", new Bun.CryptoHasher("sha256")]], wasm);
  }
  update(b: Uint8Array) {
    if (!b.byteLength) return;
    for (const [, h] of this.native) h.update(b);
    for (const [, h] of this.wasm) h.update(b);
  }
  digest(): Hashes {
    const out: Hashes = {};
    for (const [algo, h] of this.native) out[algo] = h.digest("hex");
    for (const [algo, h] of this.wasm) out[algo] = h.digest("hex");
    return out;
  }
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (!a.byteLength) return b;
  if (!b.byteLength) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0); out.set(b, a.byteLength);
  return out;
};

/** words of `unit` bytes reversed in place (v64: 2, n64: 4) */
function swapWords(b: Uint8Array, unit: 2 | 4): Uint8Array {
  const out = new Uint8Array(b.byteLength);
  if (unit === 2) for (let i = 0; i < b.byteLength; i += 2) { out[i] = b[i + 1]; out[i + 1] = b[i]; }
  else for (let i = 0; i < b.byteLength; i += 4) { out[i] = b[i + 3]; out[i + 1] = b[i + 2]; out[i + 2] = b[i + 1]; out[i + 3] = b[i]; }
  return out;
}

/**
 * Bytes in as they arrive, bytes out as they are to be stored (z64 order for a reordered N64 dump), hashes at the end.
 * The upload and copy loops write what push() and end() hand back.
 */
export class StreamHasher {
  private head: Uint8Array = new Uint8Array(0);
  private decided = false;
  private carry: Uint8Array = new Uint8Array(0);
  private raw: HashSet | null = null;
  order: N64Order | null = null;
  size = 0;
  private constructor(private out: HashSet, private n64: boolean, private spare: HashSet | null) {}

  static async create(opts: { n64?: boolean } = {}): Promise<StreamHasher> {
    // the second set only hashes the bytes as received, once an N64 dump turns out to need reordering
    const [out, spare] = await Promise.all([HashSet.create(), opts.n64 ? HashSet.create() : Promise.resolve(null)]);
    return new StreamHasher(out, !!opts.n64, spare);
  }

  private decide(first: Uint8Array) {
    this.decided = true;
    this.order = this.n64 ? n64Order(first) : null;
    if (this.order === "v64" || this.order === "n64") this.raw = this.spare;
  }

  /** the next bytes as received; returns the bytes to store for them (possibly fewer: a partial word waits for the next chunk) */
  push(chunk: Uint8Array): Uint8Array {
    this.size += chunk.byteLength;
    if (!this.decided) {
      if (!this.n64) this.decide(chunk);
      else {
        this.head = concat(this.head, chunk);
        if (this.head.byteLength < 4) return new Uint8Array(0);
        this.decide(this.head);
        chunk = this.head;
        this.head = new Uint8Array(0);
      }
    }
    if (!this.raw) { this.out.update(chunk); return chunk; }
    this.raw.update(chunk);
    const unit = this.order === "v64" ? 2 : 4;
    const data = concat(this.carry, chunk);
    const whole = data.byteLength - (data.byteLength % unit);
    this.carry = data.slice(whole);
    const swapped = swapWords(data.subarray(0, whole), unit);
    this.out.update(swapped);
    return swapped;
  }

  /** the last bytes to store and the hashes; a dump whose length is not a whole number of words keeps its last bytes as they are */
  end(): { tail: Uint8Array; result: HashResult } {
    let tail: Uint8Array = new Uint8Array(0);
    if (!this.decided) {                       // under four bytes in all: nothing to reorder
      this.decide(new Uint8Array(0));
      tail = this.head;
      this.out.update(tail);
    } else if (this.raw && this.carry.byteLength) {
      tail = this.carry;
      this.out.update(tail);
    }
    const hashes = this.out.digest();
    const result: HashResult = { size: this.size, hashes, order: this.order, normalized: null };
    if (this.raw) { result.rawHashes = this.raw.digest(); result.normalized = `n64 byte order ${this.order} → z64`; }
    return { tail, result };
  }
}

/** the hashes of a stream of chunks (sync or async); see StreamHasher for {n64} */
export async function hashStream(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, opts: { n64?: boolean } = {}): Promise<HashResult> {
  const h = await StreamHasher.create(opts);
  for await (const c of chunks as AsyncIterable<Uint8Array>) h.push(c);
  return h.end().result;
}

/** the hashes of a file on disk, read once */
export async function hashFile(path: string, opts: { n64?: boolean } = {}): Promise<HashResult> {
  return hashStream(fileChunks(path), opts);
}

/* ─────────── a file read where it lies, and the stat its hashes belong to ─────────── */

/** the parts of a stat that say a file is still the one that was hashed (src/ways/types.ts HashedStat) */
export const hashedStat = (s: Pick<Stats, "size" | "mtimeMs" | "ctimeMs" | "dev" | "ino">): HashedStat => ({ size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, dev: s.dev, ino: s.ino });
/** is this the same file, unchanged (ctime too, unless `ctime: false`: adding a hard link moves a file's ctime) */
export const sameStat = (a: HashedStat | null | undefined, b: HashedStat | null | undefined, o: { ctime?: boolean } = {}): boolean =>
  !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino && (o.ctime === false || a.ctimeMs === b.ctimeMs);

export interface InPlaceOpts {
  n64?: boolean;
  signal?: AbortSignal;
  /** bytes read so far, of the whole: about once a second (`every` ms of `now`), and at the start and the end */
  progress?: (bytes: number, total: number) => void;
  now?: () => number;
  every?: number;
}

/**
 * The hashes of a file read where it lies (never copied to be hashed), and its stat: taken before the read and again after
 * it. A file that changed while it was read is read once more; one that changes again is refused (EnvError 'changed': the
 * run looks again later). A cancel stops the read ("cancelled").
 */
export async function hashInPlace(path: string, o: InPlaceOpts = {}): Promise<{ result: HashResult; stat: HashedStat }> {
  const now = o.now ?? Date.now, every = o.every ?? 1000;
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = hashedStat(await lstat(path));
    const h = await StreamHasher.create({ n64: o.n64 });
    let last = now();
    o.progress?.(0, before.size);
    for await (const chunk of fileChunks(path)) {
      if (o.signal?.aborted) throw new Error("cancelled");
      h.push(chunk);
      const t = now();
      if (t - last >= every) { last = t; o.progress?.(h.size, before.size); }
    }
    const { result } = h.end();
    const after = hashedStat(await lstat(path));
    o.progress?.(result.size, after.size);
    if (sameStat(before, after) && result.size === after.size) return { result, stat: after };
  }
  throw new EnvError("changed", `${basename(path)} changed while it was being read: it is looked at again later`);
}

/* ─────────── game folders ─────────── */

/** one file of a game folder, as its listing names it */
export interface TreeFile { rel: string; size: number; mtimeMs: number }
/**
 * A folder's canonical listing and its hashes: one line "rel\t<size>\t<tag>\n" per file, sorted by rel (as strings compare),
 * where tag is the file's sha256 (a folder named by its contents) or its mtime (a folder named by its sizes and times only).
 * The text is kept beside a folder row as <name>.tree.tsv.
 */
export function listingDigest(lines: { rel: string; size: number; tag: string }[]): { text: string; hashes: Hashes } {
  const sorted = [...lines].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const text = sorted.map(l => `${l.rel}\t${l.size}\t${l.tag}\n`).join("");
  return { text, hashes: { sha1: new Bun.CryptoHasher("sha1").update(text).digest("hex"), sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") } };
}

/**
 * Every file of a folder read once for its sha256 (`known`: a file whose size and time are still those recorded is not
 * read again — the game's copy, whose package lists every file's sha256), with progress in bytes of the whole about every
 * second. A file that changes while it is read refuses the folder (EnvError 'changed').
 */
export async function hashTree(dir: string, files: TreeFile[], o: Omit<InPlaceOpts, "n64"> & { known?: Map<string, { size: number; sha256: string; mtimeMs?: number | null }> } = {}): Promise<{ rel: string; size: number; sha256: string }[]> {
  const now = o.now ?? Date.now, every = o.every ?? 1000;
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0, last = now();
  o.progress?.(0, total);
  const out: { rel: string; size: number; sha256: string }[] = [];
  for (const f of files) {
    if (o.signal?.aborted) throw new Error("cancelled");
    const k = o.known?.get(f.rel);
    if (k && k.size === f.size && (k.mtimeMs == null || k.mtimeMs === f.mtimeMs) && /^[0-9a-f]{64}$/.test(k.sha256)) { out.push({ rel: f.rel, size: f.size, sha256: k.sha256 }); done += f.size; continue; }
    const path = join(dir, ...f.rel.split("/"));
    const before = hashedStat(await lstat(path));
    const h = new Bun.CryptoHasher("sha256");
    for await (const chunk of fileChunks(path)) {
      if (o.signal?.aborted) throw new Error("cancelled");
      h.update(chunk);
      done += chunk.byteLength;
      const t = now();
      if (t - last >= every) { last = t; o.progress?.(done, total); }
    }
    const after = hashedStat(await lstat(path));
    if (!sameStat(before, after)) throw new EnvError("changed", `${f.rel} changed while it was being read: it is looked at again later`);
    out.push({ rel: f.rel, size: f.size, sha256: h.digest("hex") });
  }
  o.progress?.(done, total);
  return out;
}
