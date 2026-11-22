import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, hashStream, n64Order, StreamHasher } from "../src/ways/hash";
import { HASH_ALGOS, HASH_HEX_LEN } from "../src/ways/types";

const enc = new TextEncoder();
const hex = (n: number | bigint, digits: number) => n.toString(16).padStart(digits, "0");
const whole = (algo: "sha1" | "md5" | "sha256", b: Uint8Array) => new Bun.CryptoHasher(algo).update(b).digest("hex");

/** a buffer cut into pieces of the given sizes, over and over */
function* pieces(b: Uint8Array, sizes: number[]) {
  let i = 0, k = 0;
  while (i < b.length) { const n = sizes[k++ % sizes.length]; yield b.subarray(i, i + n); i += n; }
}
function random(n: number, seed = 7) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}
/** a fake big-endian N64 dump and the same bytes in the other two orders */
function n64Dumps(size = 64 * 1024 + 4) {
  const z64 = random(size, 99);
  z64.set([0x80, 0x37, 0x12, 0x40], 0);
  const v64 = new Uint8Array(size), n64 = new Uint8Array(size);
  for (let i = 0; i < size; i += 2) { v64[i] = z64[i + 1]; v64[i + 1] = z64[i]; }
  for (let i = 0; i < size; i += 4) { n64[i] = z64[i + 3]; n64[i + 1] = z64[i + 2]; n64[i + 2] = z64[i + 1]; n64[i + 3] = z64[i]; }
  return { z64, v64, n64 };
}

describe("hashing: every algorithm in one pass", () => {
  test("the published check values", async () => {
    const digits = await hashStream([enc.encode("123456789")]);
    expect(digits.hashes.crc32).toBe("cbf43926");
    expect(digits.hashes.crc32c).toBe("e3069283");
    const empty = await hashStream([]);
    expect(empty.size).toBe(0);
    expect(empty.hashes.xxh64).toBe("ef46db3751d8e999");
    expect(empty.hashes["xxh3-64"]).toBe("2d06800538d394c2");
    expect(empty.hashes["xxh3-128"]).toBe("99aa06d3014798d86001c324468d497f");
    expect(empty.hashes.sha1).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(empty.rawHashes).toBeUndefined();
  });

  test("streamed in odd pieces it agrees with Bun's whole-buffer hashes, every algorithm at its length", async () => {
    const b = random(1_000_003);
    const r = await hashStream(pieces(b, [1, 7, 4096, 65_537, 3, 100_000]));
    expect(r.size).toBe(b.length);
    expect(r.hashes.sha1).toBe(whole("sha1", b));
    expect(r.hashes.md5).toBe(whole("md5", b));
    expect(r.hashes.sha256).toBe(whole("sha256", b));
    expect(r.hashes.crc32).toBe(hex(Bun.hash.crc32(b), 8));
    expect(r.hashes.xxh64).toBe(hex(Bun.hash.xxHash64(b), 16));
    expect(r.hashes["xxh3-64"]).toBe(hex(Bun.hash.xxHash3(b), 16));
    for (const a of HASH_ALGOS) expect([a, r.hashes[a]?.length]).toEqual([a, HASH_HEX_LEN[a]]);
    const again = await hashStream([b]);                                     // pieces never change a hash, 128-bit and crc32c included
    expect(again.hashes).toEqual(r.hashes);
  });

  test("an async stream and a file on disk hash the same", async () => {
    const b = random(300_000, 3);
    const dir = mkdtempSync(join(tmpdir(), "ways-hash-"));
    writeFileSync(join(dir, "x.bin"), b);
    const fromFile = await hashFile(join(dir, "x.bin"));
    async function* slow() { for (const p of pieces(b, [12_345])) { await Promise.resolve(); yield p; } }
    expect((await hashStream(slow())).hashes).toEqual(fromFile.hashes);
    expect(fromFile.size).toBe(300_000);
  });
});

describe("hashing: N64 byte order", () => {
  test("the first four bytes tell the order", () => {
    const { z64, v64, n64 } = n64Dumps(16);
    expect([n64Order(z64), n64Order(v64), n64Order(n64)]).toEqual(["z64", "v64", "n64"]);
    expect(n64Order(new Uint8Array([0x80, 0x37]))).toBeNull();
    expect(n64Order(enc.encode("PK\x03\x04"))).toBeNull();
  });

  test("a v64 or n64 dump hashes as its z64 bytes, in any pieces; the bytes as received are kept beside", async () => {
    const { z64, v64, n64 } = n64Dumps();
    const big = await hashStream([z64]);
    for (const [order, bytes] of [["v64", v64], ["n64", n64]] as const) {
      for (const sizes of [[1], [3], [5, 2], [4096], [7, 1, 2, 3]]) {
        const r = await hashStream(pieces(bytes, sizes), { n64: true });
        expect([order, sizes, r.hashes.sha1]).toEqual([order, sizes, big.hashes.sha1]);
        expect(r.hashes["xxh3-64"]).toBe(big.hashes["xxh3-64"]);
        expect(r.rawHashes?.sha1).toBe(whole("sha1", bytes));
        expect(r.order).toBe(order);
        expect(r.normalized).toBe(`n64 byte order ${order} → z64`);
      }
    }
  });

  test("the bytes handed back for storing are the z64 dump", async () => {
    const { z64, n64 } = n64Dumps(1024);
    const h = await StreamHasher.create({ n64: true });
    const out: Uint8Array[] = [];
    for (const p of pieces(n64, [3, 10, 1, 64])) out.push(h.push(p));
    const { tail, result } = h.end();
    out.push(tail);
    expect(Buffer.concat(out).equals(Buffer.from(z64))).toBe(true);
    expect(result.size).toBe(1024);
  });

  test("a z64 dump, a file that is no N64 dump, and detection switched off pass through untouched", async () => {
    const { z64, v64 } = n64Dumps(4096);
    const asIs = await hashStream(pieces(z64, [5]), { n64: true });
    expect(asIs.order).toBe("z64"); expect(asIs.rawHashes).toBeUndefined(); expect(asIs.normalized).toBeNull();
    expect(asIs.hashes.sha1).toBe(whole("sha1", z64));
    const iso = random(4096, 5);
    const other = await hashStream([iso], { n64: true });
    expect(other.order).toBeNull(); expect(other.hashes.sha1).toBe(whole("sha1", iso));
    const off = await hashStream([v64]);
    expect(off.order).toBeNull(); expect(off.hashes.sha1).toBe(whole("sha1", v64));
    const tiny = await hashStream([new Uint8Array([0x37, 0x80])], { n64: true });
    expect(tiny.size).toBe(2); expect(tiny.hashes.sha1).toBe(whole("sha1", new Uint8Array([0x37, 0x80])));
  });

  test("a dump that is not a whole number of words keeps its last bytes as they are", async () => {
    const { v64 } = n64Dumps(1026);
    const odd = new Uint8Array(1027); odd.set(v64); odd[1026] = 0xab;
    const h = await StreamHasher.create({ n64: true });
    const out = [h.push(odd)];
    const { tail, result } = h.end();
    out.push(tail);
    const stored = Buffer.concat(out);
    expect(stored.length).toBe(1027);
    expect(stored[1026]).toBe(0xab);
    expect(result.rawHashes?.sha1).toBe(whole("sha1", odd));
  });
});
