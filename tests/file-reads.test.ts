/**
 * Reading a file on disk never stops the server (src/fsutil.ts fileChunks):
 *  - a file is read whole, in order, in pieces that are the caller's to keep, from any byte on
 *  - while a file is read for its sha256 (every import does that for every file of the game), timers still fire: on
 *    Linux a loop over Bun.file(path).stream() keeps the thread until the file ends, so the server answered nothing for
 *    as long as a game was hashed (2 minutes 44 for a 26 GB import, seen live on 2026-11-11)
 *  - nothing in the server reads a file on disk through Bun.file().stream() again
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileChunks } from "../src/fsutil";
import { vdeps } from "../src/process/validate";
import { hashFile } from "../src/ways/hash";
import { fileSum } from "../src/ways/build";

const dir = mkdtempSync(join(tmpdir(), "ludarr-reads-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a scanner holds it: the temp folder goes later */ } });
const bytes = (n: number, seed = 7) => { const b = Buffer.allocUnsafe(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >>> 16; } return b; };
const put = (name: string, b: Uint8Array) => { const p = join(dir, name); writeFileSync(p, b); return p; };
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const all = async (it: AsyncIterable<Uint8Array>) => { const out: Uint8Array[] = []; for await (const c of it) out.push(c); return out; };

describe("a file read in pieces", () => {
  test("whole, in order, no piece larger than asked for", async () => {
    const data = bytes(3 * 1024 * 1024 + 4321);
    const p = put("a.bin", data);
    const chunks = await all(fileChunks(p));
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    expect(chunks.map(c => c.byteLength)).toEqual([1 << 20, 1 << 20, 1 << 20, 4321]);
    const small = await all(fileChunks(p, { size: 1000 }));
    expect(Math.max(...small.map(c => c.byteLength))).toBe(1000);
    expect(Buffer.concat(small).equals(data)).toBe(true);
  });

  test("every piece is a buffer of its own: an earlier one is not written over by a later read", async () => {
    const data = bytes(5000);
    const chunks = await all(fileChunks(put("own.bin", data), { size: 1024 }));
    expect(chunks.length).toBe(5);
    chunks.forEach((c, i) => expect(Buffer.from(c).equals(data.subarray(i * 1024, i * 1024 + c.byteLength))).toBe(true));
    expect(new Set(chunks.map(c => c.buffer)).size).toBe(chunks.length);
  });

  test("from a byte on; an empty file and a start past the end give nothing; a file that is not there is an error", async () => {
    const data = bytes(10_000);
    const p = put("from.bin", data);
    expect(Buffer.concat(await all(fileChunks(p, { start: 9000 }))).equals(data.subarray(9000))).toBe(true);
    expect(await all(fileChunks(p, { start: 10_000 }))).toEqual([]);
    expect(await all(fileChunks(p, { start: 99_999 }))).toEqual([]);
    expect(await all(fileChunks(put("empty.bin", new Uint8Array())))).toEqual([]);
    expect(all(fileChunks(join(dir, "nothing-here.bin")))).rejects.toThrow();
  });

  test("a small file gets a buffer of its own size, not a megabyte", async () => {
    const [only] = await all(fileChunks(put("tiny.bin", bytes(37))));
    expect(only!.byteLength).toBe(37);
    expect(only!.buffer.byteLength).toBe(37);
  });

  test("left early, the file is closed and can be read again from its start", async () => {
    const data = bytes(4096);
    const p = put("early.bin", data);
    for await (const c of fileChunks(p, { size: 100 })) { expect(c.byteLength).toBe(100); break; }
    expect(Buffer.concat(await all(fileChunks(p))).equals(data)).toBe(true);
  });
});

describe("what reads a game's files", () => {
  test("gives the same sums as the bytes do", async () => {
    const data = bytes(2 * 1024 * 1024 + 99, 3);
    const p = put("sums.bin", data);
    expect(await vdeps.sha256(p)).toBe(sha(data));
    expect((await hashFile(p)).hashes.sha256).toBe(sha(data));
    expect(await fileSum(p)).toEqual({ size: data.byteLength, sha256: sha(data) });
    let told = 0;
    await vdeps.sha256(p, n => { told += n; });
    expect(told).toBe(data.byteLength);
  });

  test("a cancel stops the reading, before the first piece and between two", async () => {
    const p = put("cancel.bin", bytes(3 * 1024 * 1024));
    const before = new AbortController();
    before.abort();
    expect(vdeps.sha256(p, undefined, before.signal)).rejects.toThrow("cancelled");
    const during = new AbortController();
    let seen = 0;
    expect(vdeps.sha256(p, n => { seen += n; during.abort(); }, during.signal)).rejects.toThrow("cancelled");
    await Bun.sleep(50);
    expect(seen).toBe(1 << 20);
  });

  test("timers still fire while a file is hashed", async () => {
    const p = put("big.bin", bytes(96 * 1024 * 1024, 11));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 2);
    try {
      await Bun.sleep(10);
      ticks = 0;
      const t0 = performance.now();
      await vdeps.sha256(p);
      const ms = performance.now() - t0;
      // with the thread kept until the file ends, not one tick lands in here
      expect(ticks).toBeGreaterThanOrEqual(Math.min(5, Math.floor(ms / 10)));
      expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  });
});

describe("the server's own code", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const files = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []; });
  /** the seedbox connector hashes its own program once as it starts: a process of its own, with nothing to answer yet */
  const ALLOWED = new Set(["bosun/main.ts"]);

  /** the lines of a source text that call .stream() (comments aside): today that is only ever a file on disk */
  const streamCalls = (text: string): string[] => text.split(/\r?\n/).flatMap((line, i) => {
    const code = line.trim();
    if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return [];
    return /\.stream\(\)/.test(code) ? [`${i + 1}: ${code.slice(0, 120)}`] : [];
  });

  test("the look finds such a read, in each way it was written", () => {
    expect(streamCalls("  const reader = Bun.file(path).stream().getReader();")).toHaveLength(1);
    expect(streamCalls("for await (const chunk of Bun.file(p).stream() as unknown as AsyncIterable<Uint8Array>) {")).toHaveLength(1);
    expect(streamCalls("const f = Bun.file(p);\nconst r = f.stream();")).toHaveLength(1);
    expect(streamCalls(" * Bun.file(path).stream() does not\n// Bun.file(p).stream()\nfor await (const c of fileChunks(p)) {}")).toEqual([]);
  });

  test("reads no file on disk through Bun.file().stream(): a file is read through fileChunks", () => {
    const found: string[] = [];
    for (const p of files(SRC)) {
      const rel = p.slice(SRC.length + 1).replace(/\\/g, "/");
      if (!ALLOWED.has(rel)) found.push(...streamCalls(readFileSync(p, "utf8")).map(l => `${rel}:${l}`));
    }
    expect(found).toEqual([]);
  });
});
