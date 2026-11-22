/**
 * ludarr — the readers' one way into a file: small reads at fixed places, never the whole file. Each read is at most
 * 64 KiB and a file gets a fixed number of them (128 for a look at what it is), every offset and length checked against the
 * file's size. A read past the budget, or past the end, gives fewer bytes (none) instead of throwing, so a reader that runs
 * out simply finds nothing and says so.
 */
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { Identity } from "../identity";

/** the most one read takes */
export const MAX_READ = 64 * 1024;
/** the reads a look at a file may take */
export const MAX_READS = 128;

/** what a reader found: the identity (null when nothing can be relied on), why it found nothing, and the files that told it */
export interface Read { identity: Identity | null; why: string | null; markers?: string[] }
export const nothing = (why: string): Read => ({ identity: null, why });
/** the reason a look that ran out of reads gives */
export const OUT_OF_READS = "it needs more reads than a quick look allows";
/** nothing found in `b`: the budget named as the reason when it ran out, else `why` */
export const nothingIn = (b: Bytes, why: string): Read => nothing(b.exhausted ? OUT_OF_READS : why);

/** a file opened for small reads at fixed offsets */
export class Bytes {
  /** reads made so far */
  reads = 0;
  /** a read was turned down because the budget was spent */
  exhausted = false;
  constructor(private fh: FileHandle, readonly size: number, readonly budget = MAX_READS) {}

  /** up to `len` bytes at `off` (at most 64 KiB, fewer at the end of the file or once the budget is spent) */
  async at(off: number, len: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || off >= this.size || len <= 0) return new Uint8Array(0);
    if (this.reads >= this.budget) { this.exhausted = true; return new Uint8Array(0); }
    this.reads++;
    const n = Math.min(len, this.size - off, MAX_READ);
    const b = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const { bytesRead } = await this.fh.read(b, got, n - got, off + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return got === n ? b : b.subarray(0, got);
  }

  /** `len` bytes at `off` in as many reads as that takes (each one counted); fewer when the file or the budget ends */
  async span(off: number, len: number): Promise<Uint8Array> {
    if (len <= MAX_READ) return this.at(off, len);
    if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len <= 0) return new Uint8Array(0);
    const n = Math.max(0, Math.min(len, this.size - off));
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const part = await this.at(off + got, Math.min(MAX_READ, n - got));
      if (!part.length) break;
      out.set(part, got);
      got += part.length;
    }
    return got === n ? out : out.subarray(0, got);
  }
}

/** a read-only open that refuses a link where the system can tell (O_NOFOLLOW on Linux; Windows has no such flag) */
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/**
 * A plain file opened for reading, never through a link: lstat says it is a regular file, and the open itself refuses a
 * link where the system can (O_NOFOLLOW: a link swapped in after the lstat is not followed) and must still find a regular
 * file. (Inode numbers are not compared: on a FUSE share they are the file system's to give.) Its handle and what fstat
 * says of it, or the reason it is not one; an open that fails throws.
 */
export async function openPlain(path: string): Promise<{ fh: FileHandle; st: Stats } | string> {
  const st = await lstat(path).catch(() => null);
  if (!st) return "it is not there";
  if (st.isSymbolicLink()) return "it is a link, and ludarr never follows one";
  if (!st.isFile()) return "it is not a file";
  const fh = await open(path, READ_NOFOLLOW);
  const now = await fh.stat().catch(() => null);
  if (!now || !now.isFile()) {
    await fh.close().catch(() => { /* closed */ });
    return "it changed while it was being opened";
  }
  return { fh, st: now };
}

/**
 * Run `fn` over the file at `path`, opened for reading (openPlain: a link is never followed and anything but a regular
 * file says nothing); whatever `fn` throws is a reason, never an error past the reader.
 */
export async function withBytes(path: string, fn: (b: Bytes) => Promise<Read>, budget = MAX_READS): Promise<Read> {
  let fh: FileHandle | null = null;
  try {
    const opened = await openPlain(path);
    if (typeof opened === "string") return nothing(opened);
    fh = opened.fh;
    return await fn(new Bytes(fh, opened.st.size, budget));
  } catch (e) {
    return nothing(`it could not be read (${(e as Error)?.message ?? e})`);
  } finally {
    await fh?.close().catch(() => { /* closed */ });
  }
}

/* ─────────── numbers in bytes ─────────── */

export const le16 = (b: Uint8Array, o: number) => (o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0);
export const le32 = (b: Uint8Array, o: number) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0);
export const be16 = (b: Uint8Array, o: number) => (o + 2 <= b.length ? (b[o] << 8) | b[o + 1] : 0);
export const be32 = (b: Uint8Array, o: number) => (o + 4 <= b.length ? ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0 : 0);
/** a 64-bit number, or NaN when it is past what a JS number holds exactly (no real offset or size is) */
export function le64(b: Uint8Array, o: number): number {
  if (o + 8 > b.length) return NaN;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : NaN;
}
export function be64(b: Uint8Array, o: number): number {
  if (o + 8 > b.length) return NaN;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, false);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : NaN;
}
/** the bytes as they are, for magic words and codes that must match exactly */
export const raw = (b: Uint8Array) => String.fromCharCode(...b);
export const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
/** a JSON document's text: a byte order mark and the NULs a fixed-size field pads it with are dropped */
export function jsonText(b: Uint8Array): string {
  let end = b.length;
  while (end > 0 && (b[end - 1] === 0 || b[end - 1] === 0x20 || b[end - 1] === 0x0a || b[end - 1] === 0x0d || b[end - 1] === 0x09)) end--;
  let s = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, end));
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}
/** JSON.parse that says nothing instead of throwing; only an object counts */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}
