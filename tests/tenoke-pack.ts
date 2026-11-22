/** builds TENOKE packages for tests: the inverse of src/process/tenoke.ts (literal-only Snappy, optional zlib / blocks) */
import { deflateSync } from "node:zlib";
import { encodeLength, unscramble } from "../src/process/tenoke";

const varint = (n: number): number[] => { const out: number[] = []; while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; } out.push(n); return out; };
/** a Snappy block made of literals only (plus, when asked, one copy tag so the match path is exercised) */
export function snappyLiteral(data: Buffer, withCopy = false): Buffer {
  const parts: Buffer[] = [Buffer.from(varint(data.length))];
  if (withCopy && data.length >= 16) {
    // literal of the first 8 bytes, then "copy 8 bytes from offset 8" (tag type 1: len 8 → (8-4)<<2 | 1, offset 8)
    parts.push(Buffer.from([((8 - 1) << 2) | 0]), data.subarray(0, 8), Buffer.from([((8 - 4) << 2) | 1, 8]));
    data = data.subarray(16);
    if (!data.length) return Buffer.concat(parts);
  }
  for (let p = 0; p < data.length; p += 0x10000) {
    const chunk = data.subarray(p, Math.min(p + 0x10000, data.length));
    const head = Buffer.alloc(5); head[0] = (63 << 2); head.writeUInt32LE(chunk.length - 1, 1);
    parts.push(head, chunk);
  }
  return Buffer.concat(parts);
}
const xorHead = (b: Buffer, key: number) => { const o = Buffer.from(b); if (o.length >= 4) o.writeUInt32LE((o.readUInt32LE(0) ^ key) >>> 0, 0); return o; };
const fileTime = (ms: number) => { const ft = BigInt(Math.round(ms)) * 10_000n + 116_444_736_000_000_000n; return [Number(ft & 0xffffffffn), Number(ft >> 32n)]; };

export interface PackEntry { name: string; dir: string; data?: Uint8Array; method?: 0 | 1 | 2; zlib?: boolean; key?: number; mtimeMs?: number; blockSize?: number; withCopy?: boolean }

export function packEntry(e: PackEntry, offset: number): Buffer {
  const data = Buffer.from(e.data ?? Buffer.alloc(0));
  const method = e.method ?? 0, key = e.key ?? 0;
  const enc = (b: Buffer) => (e.zlib ? deflateSync(b) : snappyLiteral(b, e.withCopy));
  let stored: Buffer;
  if (method === 0) stored = data;
  else if (method === 1) stored = xorHead(enc(data), key);
  else {
    const bs = e.blockSize ?? 0x1000000, parts: Buffer[] = [];
    for (let p = 0; p < data.length; p += bs) { const b = xorHead(enc(data.subarray(p, Math.min(p + bs, data.length))), key); const l = Buffer.alloc(4); l.writeUInt32LE(b.length, 0); parts.push(l, b); }
    stored = Buffer.concat(parts);
  }
  const strings = Buffer.concat([Buffer.from(e.name + "\0", "utf16le"), Buffer.from(e.dir + "\0", "utf16le")]);
  const rec = Buffer.alloc(0x44 + strings.length);
  const w = (i: number, v: number) => rec.writeUInt32LE(v >>> 0, i * 4);
  w(0, stored.length % 4294967296); w(1, Math.floor(stored.length / 4294967296));
  w(2, data.length % 4294967296); w(3, Math.floor(data.length / 4294967296));
  w(4, method); w(5, key); w(6, 2); w(7, offset); w(8, 0);
  w(9, 4 + rec.length + stored.length); w(10, 0); w(11, offset + 4 + rec.length); w(12, 0);
  const [lo, hi] = fileTime(e.mtimeMs ?? Date.UTC(2020, 1, 2, 12, 2));
  w(13, lo); w(14, hi); w(15, lo); w(16, hi);
  strings.copy(rec, 0x44);
  return Buffer.concat([encodeLength(rec.length), unscramble(rec), stored]);
}

/** a whole SETUP.bin: pakinfo, UNINSTALL.exe, then the entries (the game folder is `name`) */
export function tenokePack(o: { name: string; launch: string; entries: PackEntry[]; uninstaller?: Buffer }): Buffer {
  const info = Buffer.concat([Buffer.alloc(16), Buffer.from(o.launch + "\0", "utf16le"), Buffer.from("\0", "utf16le"), Buffer.from(o.name + "\0", "utf16le"), Buffer.alloc(4)]);
  info.writeUInt32LE(16, 0);
  const all: PackEntry[] = [
    { name: "pakinfo", dir: "", data: info, method: 1, key: 0x29 },
    { name: "UNINSTALL.exe", dir: o.name + "\\", data: o.uninstaller ?? Buffer.from("MZ uninstaller " + "x".repeat(3000)), method: 1, key: 0x4823 },
    ...o.entries.map(e => ({ ...e, dir: o.name + "\\" + (e.dir ? e.dir.replace(/\/$/, "") + "\\" : "") })),
  ];
  const parts: Buffer[] = [];
  let at = 0;
  for (const e of all) { const b = packEntry(e, at); parts.push(b); at += b.length; }
  return Buffer.concat(parts);
}
