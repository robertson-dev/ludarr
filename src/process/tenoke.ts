/**
 * ludarr — TENOKE's SETUP.bin, read directly (no installer, no wine).
 *
 * What their SETUP.exe does with the file, taken from the installer itself (both the 2023 dialog build and the
 * 2024+ Direct2D build read the same container):
 *
 *   entry := len(4) · record(len) · data(stored)         repeated from offset 0 to the end of the file
 *
 *   len     — four bytes b0..b3 hide the record length: v = ~b0 | (b0^b1)<<8 | (b1^b2)<<16 | (b2^b3)<<24,
 *             length = v − 0x315e4 (0x48 ≤ length < 0x48 + 0x1ffb9, else the package is "damaged")
 *   record  — XORed with a fixed 24-byte key; as uint32s: [0..1] stored bytes, [2..3] real bytes, [4] method,
 *             [5] data key, [6] = 2, [7..8] own offset, [9..10] own total length, [11..12] data offset,
 *             [13..14] and [15..16] FILETIMEs, then from byte 0x44 two NUL-terminated UTF-16 strings:
 *             file name (empty for a folder) and folder path ("Game Name\Sub\"; the first component is the
 *             game folder the installer replaces with the chosen directory)
 *   method  — 0 stored; 1 one Snappy block (zlib stream when Snappy does not fit) for the whole file;
 *             2 a run of [u32 block length · block] where each block is Snappy-or-zlib of ≤ 16 MB.
 *             The first four bytes of every compressed block are XORed with the data key.
 *
 * Entry 0 is "pakinfo" (launch exe, game name), entry 1 the bundled UNINSTALL.exe; the installer writes
 * entries from the third one on. Timestamps are restored from the second FILETIME pair.
 */
import { mkdir, open, utimes, type FileHandle } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

const KEY = Buffer.from([0x29, 0x2a, 0x7e, 0x25, 0x5f, 0x40, 0x2a, 0xb7, 0xa2, 0x46, 0x36, 0x45, 0x5e, 0x25, 0x6b, 0x76, 0xb2, 0xc6, 0x25, 0x36, 0x46, 0x61, 0x4b, 0x26]);
const LEN_BIAS = 0x315e4, LEN_MIN = 0x48, LEN_SPAN = 0x1ffb9;
const BLOCK_MAX = 0x1000000;
/** the most a file stored as one block (method 1) may unpack to. The installer cuts files into 16 MB blocks (method 2);
 *  sixteen times that leaves room for a build that does not */
const WHOLE_MAX = 16 * BLOCK_MAX;

export interface TenokeEntry {
  index: number; name: string; dir: string[]; stored: number; raw: number; method: number; key: number;
  dataAt: number; mtimeMs: number | null; recordAt: number;
}
export interface TenokeInfo { launch: string; name: string }

export const recordLength = (b: Uint8Array): number => {
  const v = ((~b[0] & 0xff) | ((b[0] ^ b[1]) << 8) | ((b[1] ^ b[2]) << 16) | (((b[2] ^ b[3]) & 0xff) << 24)) >>> 0;
  const len = v - LEN_BIAS;
  return len >= LEN_MIN && len < LEN_MIN + LEN_SPAN ? len : -1;
};
export const unscramble = (rec: Buffer): Buffer => { const out = Buffer.from(rec); for (let i = 0; i < out.length; i++) out[i] ^= KEY[i % 24]; return out; };
/** the inverse pair, for building packages (tests, fixtures) */
export const encodeLength = (len: number): Buffer => {
  const v = (len + LEN_BIAS) >>> 0;
  const b0 = ~v & 0xff, b1 = b0 ^ ((v >>> 8) & 0xff), b2 = b1 ^ ((v >>> 16) & 0xff), b3 = b2 ^ ((v >>> 24) & 0xff);
  return Buffer.from([b0, b1, b2, b3]);
};

const wstr = (buf: Buffer, at: number): [string, number] => {
  let end = at;
  while (end + 1 < buf.length && (buf[end] | buf[end + 1]) !== 0) end += 2;
  return [buf.toString("utf16le", at, end), end + 2];
};
const fileTime = (lo: number, hi: number): number | null => {
  const ft = hi * 4294967296 + lo;
  if (!ft) return null;
  const ms = ft / 10_000 - 11_644_473_600_000;
  return ms > 0 && ms < 4e12 ? ms : null;
};

export function parseRecord(rec: Buffer, index: number, recordAt: number, dataAt: number): TenokeEntry {
  if (rec.length < 0x44) throw new Error("record too short");
  const r = (i: number) => rec.readUInt32LE(i * 4);
  const [name, p] = wstr(rec, 0x44);
  const [path] = wstr(rec, p);
  const dir = path.split(/[\\/]/).filter(Boolean);
  // the file name is one name: with a separator in it, it would be more folders, and ".." among them a way out of the
  // folder the game is written into (the folder path is split and checked; the name was once only compared whole)
  if (/[\\/]/.test(name) || name === "." || name === "..") throw new Error(`entry ${index} escapes the target (${path}${name})`);
  for (const seg of dir) if (seg === "..") throw new Error(`entry ${index} escapes the target (${path}${name})`);
  const method = r(4);
  if (method > 2) throw new Error(`entry ${index} (${name}) uses storage method ${method}`);
  const stored = r(1) * 4294967296 + r(0), raw = r(3) * 4294967296 + r(2);
  // a whole-file block is read and unpacked in memory: one that claims more than the installer ever packs that way is
  // refused before a buffer of that size is made for it
  if (method === 1 && (raw > WHOLE_MAX || stored > WHOLE_MAX + WHOLE_MAX / 4)) throw new Error(`entry ${index} (${name}) claims ${raw} bytes in one block`);
  return {
    index, name, dir, stored, raw, method, key: r(5),
    dataAt, mtimeMs: fileTime(r(15), r(16)) ?? fileTime(r(13), r(14)), recordAt,
  };
}

/** where an entry is written: inside `target`, or it throws. The names were checked when the record was read; this is
 *  the same rule asked of the path itself, right before anything is made there */
export function entryPath(target: string, e: Pick<TenokeEntry, "index" | "name" | "dir">): string {
  const root = resolve(target), dest = resolve(root, ...e.dir.slice(1), ...(e.name ? [e.name] : []));
  if (dest !== root && !dest.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`entry ${e.index} escapes the target (${[...e.dir, e.name].join("/")})`);
  if (e.name && dest === root) throw new Error(`entry ${e.index} names the target itself`);
  return dest;
}

/* ─────────────────────────── Snappy (raw block) ─────────────────────────── */

/** the uncompressed length a Snappy block announces, and where its tags start; null when there is no sane preamble */
export function snappyLength(src: Buffer): { n: number; at: number } | null {
  let p = 0, n = 0, shift = 0;
  for (;;) {
    if (p >= src.length || shift > 28) return null;
    const b = src[p++];
    n |= (b & 0x7f) << shift;
    if (b < 0x80) break;
    shift += 7;
  }
  return { n: n >>> 0, at: p };
}
/** decode one Snappy block into `out`; false when the bytes are not a Snappy block of exactly out.length */
export function snappyInto(src: Buffer, out: Buffer): boolean {
  const head = snappyLength(src);
  if (!head || head.n !== out.length) return false;
  let p = head.at, o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const t = tag & 3;
    if (t === 0) {
      let len = tag >>> 2;
      if (len >= 60) {
        const nb = len - 59;
        if (p + nb > src.length) return false;
        len = src.readUIntLE(p, nb); p += nb;
      }
      len += 1;
      if (p + len > src.length || o + len > out.length) return false;
      src.copy(out, o, p, p + len); p += len; o += len;
    } else {
      let len: number, off: number;
      if (t === 1) { if (p >= src.length) return false; len = ((tag >>> 2) & 7) + 4; off = ((tag & 0xe0) << 3) | src[p]; p += 1; }
      else if (t === 2) { if (p + 2 > src.length) return false; len = (tag >>> 2) + 1; off = src.readUInt16LE(p); p += 2; }
      else { if (p + 4 > src.length) return false; len = (tag >>> 2) + 1; off = src.readUInt32LE(p); p += 4; }
      if (off === 0 || off > o || o + len > out.length) return false;
      const from = o - off;
      if (off >= len) out.copy(out, o, from, from + len);
      else for (let i = 0; i < len; i++) out[o + i] = out[from + i];
      o += len;
    }
  }
  return o === out.length;
}

/**
 * One compressed block as the installer stores it: key-XORed head, Snappy first, zlib second. `raw` is what a
 * whole-file block must give; for a run of blocks it is the most that is still missing (the installer cuts at
 * 16 MB, the block's own preamble says where this one ends).
 */
function decodeBlock(block: Buffer, key: number, raw: number, exact = true): Buffer {
  if (block.length >= 4) block.writeUInt32LE((block.readUInt32LE(0) ^ key) >>> 0, 0);
  const head = snappyLength(block);
  if (head && head.n > 0 && (exact ? head.n === raw : head.n <= raw)) {
    const out = Buffer.allocUnsafe(head.n);
    if (snappyInto(block, out)) return out;
  }
  let z: Buffer;
  // never more than the block may give: a few bytes of zlib can claim gigabytes
  try { z = inflateSync(block, { maxOutputLength: Math.max(1, raw) }); } catch (e: any) { throw new Error(`block is neither Snappy nor zlib (${e?.message ?? e})`); }
  if (exact ? z.length !== raw : z.length === 0 || z.length > raw) throw new Error(`zlib block gave ${z.length} bytes, expected ${exact ? "" : "at most "}${raw}`);
  return z;
}

/* ─────────────────────────── reading a package ─────────────────────────── */

async function readAt(fh: FileHandle, at: number, n: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(n);
  let got = 0;
  while (got < n) {
    const r = await fh.read(buf, got, n - got, at + got);
    if (r.bytesRead === 0) throw new Error(`unexpected end of package at ${at + got}`);
    got += r.bytesRead;
  }
  return buf;
}

async function readEntry(fh: FileHandle, at: number, size: number, index: number): Promise<TenokeEntry | null> {
  if (at + 24 > size) return null;
  const len = recordLength(await readAt(fh, at, 4));
  if (len < 0) throw new Error(`entry ${index} at ${at}: not a TENOKE record`);
  if (at + 4 + len > size) throw new Error(`entry ${index} at ${at}: record runs past the end`);
  const e = parseRecord(unscramble(await readAt(fh, at + 4, len)), index, at, at + 4 + len);
  if (e.dataAt + e.stored > size) throw new Error(`entry ${index} (${e.name}): data runs past the end`);
  return e;
}

async function entryBytes(fh: FileHandle, e: TenokeEntry): Promise<Buffer> {
  if (e.method === 0) return readAt(fh, e.dataAt, e.stored);
  if (e.method === 1) return decodeBlock(await readAt(fh, e.dataAt, e.stored), e.key, e.raw);
  const out = Buffer.allocUnsafe(e.raw);
  let o = 0;
  await blocks(fh, e, b => { b.copy(out, o); o += b.length; });
  return out;
}

/** method 2: walk the blocks, decoded one at a time */
async function blocks(fh: FileHandle, e: TenokeEntry, sink: (b: Buffer) => void | Promise<void>): Promise<void> {
  let at = e.dataAt, left = e.raw;
  const end = e.dataAt + e.stored;
  while (left > 0) {
    if (at + 4 > end) throw new Error(`${e.name}: blocks end ${left} bytes short`);
    const n = (await readAt(fh, at, 4)).readUInt32LE(0);
    at += 4;
    if (n === 0 || at + n > end) throw new Error(`${e.name}: block of ${n} bytes does not fit`);
    const b = decodeBlock(await readAt(fh, at, n), e.key, Math.min(BLOCK_MAX, left), false);
    at += n; left -= b.length;
    await sink(b);
  }
}

/** parse the first entry: the package manifest, or null when the file is not a TENOKE package */
export async function tenokePackage(path: string): Promise<(TenokeInfo & { size: number }) | null> {
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  if (size < 64) return null;
  const fh = await open(path, "r");
  try {
    const first = await readEntry(fh, 0, size, 0).catch(() => null);
    if (!first || first.name !== "pakinfo" || first.method !== 1 || first.raw > 65536) return null;
    const info = await entryBytes(fh, first);
    let p = 16; const s: string[] = [];
    for (let i = 0; i < 3 && p < info.length; i++) { const [v, q] = wstr(info, p); s.push(v); p = q; }
    return { launch: s[0]?.replace(/\\/g, "/") ?? "", name: s[2] ?? "", size };
  } catch { return null; } finally { await fh.close(); }
}

export interface ExtractProgress { files: number; bytes: number; entry: TenokeEntry }

/**
 * Write every file of the package into `target` (the game folder; the package's own top folder is dropped).
 * Returns what was written. Throws on the first malformed entry: the caller falls back to the installer.
 */
export async function extractTenoke(path: string, target: string, opts: { signal?: AbortSignal; progress?: (p: ExtractProgress) => void; skipUninstaller?: boolean } = {}): Promise<{ files: number; bytes: number; folders: number; info: TenokeInfo }> {
  const pkg = await tenokePackage(path);
  if (!pkg) throw new Error(`${path} is not a TENOKE package`);
  const fh = await open(path, "r");
  let files = 0, bytes = 0, folders = 0;
  try {
    let at = 0, index = 0;
    for (;;) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      const e = await readEntry(fh, at, pkg.size, index);
      if (!e) break;
      at = e.dataAt + e.stored; index++;
      if (e.index === 0) continue;                                                    // pakinfo
      if (e.index === 1 && /^uninstall\.exe$/i.test(e.name) && opts.skipUninstaller !== false) continue;
      const dest = entryPath(target, e);
      if (!e.name) { await mkdir(dest, { recursive: true }); folders++; continue; }
      await mkdir(dirname(dest), { recursive: true });
      const out = await open(dest, "w");
      try {
        if (e.method === 2) await blocks(fh, e, async b => { await out.write(b); });
        else if (e.method === 1) await out.write(await entryBytes(fh, e));
        else {                                                                        // stored: stream it through
          let p = e.dataAt; const end = e.dataAt + e.stored;
          while (p < end) { const n = Math.min(8 * 1024 * 1024, end - p); await out.write(await readAt(fh, p, n)); p += n; }
        }
      } finally { await out.close(); }
      if (e.mtimeMs) await utimes(dest, new Date(e.mtimeMs), new Date(e.mtimeMs)).catch(() => {});
      files++; bytes += e.method === 0 ? e.stored : e.raw;
      opts.progress?.({ files, bytes, entry: e });
    }
  } finally { await fh.close(); }
  return { files, bytes, folders, info: pkg };
}
