/**
 * A package as blocks (src/blocks.ts): what a launcher takes a game by, in a few requests instead of one per file.
 *  - each file cut at every MiB, each block named by its sha256; the index is tied to one list of files
 *  - the blocks asked for come back in the order asked, compressed only where that makes them smaller, and put together
 *    again they are the files
 *  - nothing but blocks of the package's own files, of the list the caller names, within what one request may ask
 *  - a file that is no longer the one indexed is not sent
 *  - an import indexes its package in the read it does anyway; the task indexes the packages that have none, one a run,
 *    never over a file that is not the one that was imported
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { db, stmts, upsertGame, type JobRow, type PackageRow } from "../src/db";
import { apiKey } from "../src/config";
import { app } from "../src/server";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";
import { recipes } from "../src/plugins/builtin/importers";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { pdeps } from "../src/process/deps";
import { rdeps as importDeps, runJob } from "../src/process/runner";
import { buildManifest, vdeps, type Manifest, type Validation } from "../src/process/validate";
import { BLOCK, BlockHasher, blkdeps, blockCount, blocksOf, blocksStatus, blocksTick, filesDigest, FRAME, indexPackage, MAX_RUNS, primeIndexes, resetBlocks, writeIndex } from "../src/blocks";
import { bytes, tools7z } from "./ways-fixtures";

for (const p of BUILTIN) registry.registerPlugin(p, "builtin");
registry.ensureSingletons();

const tmp = mkdtempSync(join(tmpdir(), "ludarr-blocks-"));
const saved = { dir: blkdeps.dir, now: blkdeps.now, compress: blkdeps.compress, sha256: vdeps.sha256, tools: pdeps.tools, log: pdeps.log, importers: importDeps.importers };
const made: number[] = [];
let indexDir = "";
beforeAll(() => { ensureDefaultRootFolder(); pdeps.log = () => {}; });
beforeEach(() => {
  // every test has its own folder of indexes, and nothing known from the one before
  indexDir = mkdtempSync(join(tmp, "idx-"));
  blkdeps.dir = () => indexDir; blkdeps.now = saved.now; blkdeps.compress = saved.compress; vdeps.sha256 = saved.sha256;
  resetBlocks();
  for (const id of made.splice(0)) db.query("DELETE FROM packages WHERE id=?").run(id);
  db.exec("DELETE FROM jobs WHERE state='running'");
});
afterAll(() => {
  Object.assign(blkdeps, { dir: saved.dir, now: saved.now, compress: saved.compress });
  vdeps.sha256 = saved.sha256; pdeps.tools = saved.tools; pdeps.log = saved.log; importDeps.importers = saved.importers;
  for (const id of made) db.query("DELETE FROM packages WHERE id=?").run(id);
  resetBlocks();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* a scanner holds it */ }
});

const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
/** bytes that shrink well (text), and bytes that do not (noise) */
const noise = (n: number) => { const b = Buffer.allocUnsafe(n); for (let o = 0; o < n; o += 65_536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65_536))); return b; };
const text = (n: number, word = "the quick brown fox jumps over the lazy dog. ") => Buffer.alloc(n, word);
type Files = Record<string, Uint8Array>;

/** a package in the library: its folder, its manifest, its row */
function pkgOf(name: string, files: Files, over: (m: Manifest) => void = () => {}): PackageRow {
  const dir = mkdtempSync(join(tmp, "pkg-"));
  for (const [rel, b] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), b); }
  const list = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, b]) => ({ path, size: b.byteLength, sha256: sha(b) }));
  const m: Manifest = { schema: 1, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), version: null, launch: { exe: list[0]?.path ?? "", args: "", cwd: "" }, prerequisites: [], files: list,
    totalSize: list.reduce((n, f) => n + f.size, 0), source: null, tier: "deterministic", notes: null, createdAt: new Date().toISOString() };
  over(m);
  const row = stmts.insertPackage.get(null, null, dir, name, null, m.totalSize, JSON.stringify(m)) as PackageRow;
  made.push(row.id);
  return stmts.packageById.get(row.id) as PackageRow;
}
const filesOf = (p: PackageRow) => (JSON.parse(p.manifest_json) as Manifest).files;
const api = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "X-Api-Key": apiKey(), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
/** a stream of frames, read to its end */
async function framesOf(res: Response): Promise<{ kind: number; payload: Buffer }[]> {
  const all = Buffer.from(await res.arrayBuffer());
  const out: { kind: number; payload: Buffer }[] = [];
  for (let at = 0; at < all.length;) {
    const kind = all[at]!, len = all.readUInt32LE(at + 1);
    out.push({ kind, payload: all.subarray(at + 5, at + 5 + len) });
    at += 5 + len;
  }
  return out;
}
const plain = (f: { kind: number; payload: Buffer }) => (f.kind === FRAME.zstd ? Buffer.from(Bun.zstdDecompressSync(f.payload)) : f.payload);
const want = (p: PackageRow, runs: number[][]) => api("POST", `/api/v1/package/${p.id}/blocks`, { digest: blocksOf(p)?.digest, want: runs });

const GAME: Files = {
  "bin/game.exe": noise(2 * BLOCK + 12_345),               // noise: two whole blocks and a part
  "data/script.txt": text(3 * BLOCK),                      // text: exactly three blocks
  "data/empty.dat": new Uint8Array(),
  "readme.txt": new TextEncoder().encode("enjoy"),         // 5 bytes: too small to be worth compressing
};

describe("a file as blocks", () => {
  test("each MiB has its own sha256, in whatever pieces the bytes come", () => {
    const data = bytes(2 * BLOCK + 777, 5);
    const expected = [data.subarray(0, BLOCK), data.subarray(BLOCK, 2 * BLOCK), data.subarray(2 * BLOCK)].map(sha).join("");
    for (const piece of [1 << 16, 999_983, BLOCK, BLOCK + 1, data.byteLength]) {
      const h = new BlockHasher();
      for (let i = 0; i < data.byteLength; i += piece) h.push(data.subarray(i, Math.min(data.byteLength, i + piece)));
      expect(Buffer.from(h.end()).toString("hex")).toBe(expected);
    }
    expect(new BlockHasher().end().byteLength).toBe(0);                                  // an empty file has no block
    const whole = new BlockHasher(); whole.push(data.subarray(0, 2 * BLOCK));
    expect(whole.end().byteLength).toBe(64);                                             // two exact blocks, not a third empty one
    expect([0, 1, BLOCK, BLOCK + 1, 3 * BLOCK].map(blockCount)).toEqual([0, 1, 1, 2, 3]);
  });

  test("the digest of a file list is that list's: a path, a size, a sum or the order changes it", () => {
    const a = [{ path: "a", size: 1, sha256: "x" }, { path: "b", size: 2, sha256: "y" }];
    const d = filesDigest(a);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(filesDigest(JSON.parse(JSON.stringify(a)))).toBe(d);
    for (const other of [[{ ...a[0]!, path: "A" }, a[1]!], [{ ...a[0]!, size: 3 }, a[1]!], [a[0]!, { ...a[1]!, sha256: "z" }], [a[1]!, a[0]!], [a[0]!]]) expect(filesDigest(other)).not.toBe(d);
  });
});

describe("a package's index", () => {
  test("built from its files: a header, then every block's sha256 in the manifest's order; the package says it has one", async () => {
    const p = pkgOf("Indexed", GAME);
    expect(blocksOf(p)).toBeNull();
    expect((await (await api("GET", `/api/v1/package/${p.id}`)).json() as any).item.blocks).toBeNull();
    expect((await api("GET", `/api/v1/package/${p.id}/blocks`)).status).toBe(404);

    expect(await indexPackage(p)).toEqual({ ok: true, blocks: 7, bytes: 2 * BLOCK + 12_345 + 3 * BLOCK + 5 });
    const files = filesOf(p);
    expect(files.map(f => f.path)).toEqual(["bin/game.exe", "data/empty.dat", "data/script.txt", "readme.txt"]);
    expect(blocksOf(p)).toEqual({ size: BLOCK, count: 7, digest: filesDigest(files) });
    expect((await (await api("GET", `/api/v1/package/${p.id}`)).json() as any).item.blocks).toEqual({ size: BLOCK, count: 7, digest: filesDigest(files) });

    const res = await api("GET", `/api/v1/package/${p.id}/blocks`);
    expect(res.status).toBe(200);
    const idx = Buffer.from(await res.arrayBuffer());
    expect(idx.byteLength).toBe(64 + 7 * 32);                                            // the files' times, the server's own, are not sent
    expect(idx.toString("latin1", 0, 8)).toBe("AHOYBLK1");
    expect([idx.readUInt32LE(8), idx.readUInt32LE(12), idx.readUInt32LE(16)]).toEqual([BLOCK, 4, 7]);
    expect(idx.toString("hex", 32, 64)).toBe(filesDigest(files));
    const exe = Buffer.from(GAME["bin/game.exe"]!), script = Buffer.from(GAME["data/script.txt"]!);
    const expected = [exe.subarray(0, BLOCK), exe.subarray(BLOCK, 2 * BLOCK), exe.subarray(2 * BLOCK), script.subarray(0, BLOCK), script.subarray(BLOCK, 2 * BLOCK), script.subarray(2 * BLOCK), Buffer.from("enjoy")].map(sha).join("");
    expect(idx.toString("hex", 64)).toBe(expected);
    // on disk: one file per package, with the files' times behind the hashes
    expect(readdirSync(indexDir)).toEqual([`${p.id}.blk`]);
    expect(statSync(join(indexDir, `${p.id}.blk`)).size).toBe(64 + 7 * 32 + 4 * 8);
  });

  test("it is that file list's: a start changed by hand keeps it, other files do not; it is found again after a restart", async () => {
    const p = pkgOf("Tied", GAME);
    await indexPackage(p);
    const m = JSON.parse(p.manifest_json) as Manifest;
    // the start changes: no file does
    let row = stmts.setPackageManifest.get(JSON.stringify({ ...m, launch: { ...m.launch, exe: "readme.txt", rev: 5 } }), null, p.id) as PackageRow;
    expect(blocksOf(row)?.count).toBe(7);
    // a restart: nothing known, then read from the folder
    resetBlocks();
    expect(blocksOf(row)).toBeNull();
    await primeIndexes();
    expect(blocksOf(row)?.count).toBe(7);
    // a file of the list is another: this index is not that list's
    row = stmts.setPackageManifest.get(JSON.stringify({ ...m, files: m.files.map(f => (f.path === "readme.txt" ? { ...f, sha256: sha(Buffer.from("other")) } : f)) }), null, p.id) as PackageRow;
    expect(blocksOf(row)).toBeNull();
    expect((await api("GET", `/api/v1/package/${p.id}/blocks`)).status).toBe(404);
    expect((await api("POST", `/api/v1/package/${p.id}/blocks`, { digest: filesDigest(m.files), want: [[0, 0, 1]] })).status).toBe(404);
  });

  test("no index over a file that is not the one that was imported, nor over one that is missing", async () => {
    const p = pkgOf("Changed", GAME);
    writeFileSync(join(p.path, "readme.txt"), "ENJOY");                                  // the same size, other bytes
    expect(await indexPackage(p)).toEqual({ ok: false, why: "readme.txt is not the file that was imported" });
    expect(blocksOf(p)).toBeNull();
    expect(readdirSync(indexDir)).toEqual([]);
    const q = pkgOf("Missing", GAME);
    rmSync(join(q.path, "data", "script.txt"));
    expect(await indexPackage(q)).toEqual({ ok: false, why: "data/script.txt is not in the package's folder" });
  });
});

describe("the blocks asked for", () => {
  test("come back in the order asked, compressed only where that makes them smaller, and are the files again", async () => {
    const p = pkgOf("Sent", GAME);
    await indexPackage(p);
    const files = filesOf(p);
    const res = await want(p, [[0, 0, 3], [2, 0, 3], [3, 0, 1]]);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-blocks")).toBe("7");
    const fr = await framesOf(res);
    expect(fr.map(f => f.kind)).toEqual([0, 0, 0, 1, 1, 1, 0]);                         // noise as it is, text compressed, five bytes as they are
    expect(fr.slice(3, 6).every(f => f.payload.byteLength < BLOCK / 100)).toBe(true);
    const got = fr.map(plain);
    expect(Buffer.concat(got.slice(0, 3)).equals(Buffer.from(GAME["bin/game.exe"]!))).toBe(true);
    expect(Buffer.concat(got.slice(3, 6)).equals(Buffer.from(GAME["data/script.txt"]!))).toBe(true);
    expect(got[6]!.toString()).toBe("enjoy");
    // each block is the one the index names
    const idx = Buffer.from(await (await api("GET", `/api/v1/package/${p.id}/blocks`)).arrayBuffer());
    got.forEach((b, i) => expect(sha(b)).toBe(idx.toString("hex", 64 + i * 32, 96 + i * 32)));
    expect(files[1]!.size).toBe(0);                                                      // the empty file has nothing to ask for

    // any part, in any order
    const some = (await framesOf(await want(p, [[2, 2, 1], [0, 1, 2], [2, 0, 1]]))).map(plain);
    expect(some.map(b => b.byteLength)).toEqual([BLOCK, BLOCK, 12_345, BLOCK]);
    expect(some[1]!.equals(Buffer.from(GAME["bin/game.exe"]!).subarray(BLOCK, 2 * BLOCK))).toBe(true);
    expect(some[2]!.equals(Buffer.from(GAME["bin/game.exe"]!).subarray(2 * BLOCK))).toBe(true);
  });

  test("a file that does not shrink is not tried block after block: a few, then one in a while", async () => {
    const p = pkgOf("Noise", { "big.pak": noise(80 * BLOCK) });
    await indexPackage(p);
    let tried = 0;
    blkdeps.compress = b => { tried++; return saved.compress(b); };
    const fr = await framesOf(await want(p, [[0, 0, 80]]));
    expect(fr.length).toBe(80);
    expect(fr.every(f => f.kind === FRAME.raw && f.payload.byteLength === BLOCK)).toBe(true);
    expect(tried).toBe(5);                                                               // blocks 0 to 3, then block 67 (63 go untried between)
    expect(Buffer.concat(fr.map(f => f.payload)).equals(readFileSync(join(p.path, "big.pak")))).toBe(true);
  });

  test("refused: no such package, another list of files, anything that is not blocks of this package's files", async () => {
    const p = pkgOf("Strict", GAME);
    expect((await api("POST", "/api/v1/package/999999/blocks", { digest: "x", want: [[0, 0, 1]] })).status).toBe(404);
    expect((await api("POST", `/api/v1/package/${p.id}/blocks`, { digest: "x", want: [[0, 0, 1]] })).status).toBe(404);   // not indexed yet
    await indexPackage(p);
    const digest = blocksOf(p)!.digest;
    const other = await api("POST", `/api/v1/package/${p.id}/blocks`, { digest: "0".repeat(64), want: [[0, 0, 1]] });
    expect(other.status).toBe(409);
    expect((await other.json() as any).digest).toBe(digest);                             // the caller reads the package again
    for (const bad of [undefined, [], "all", [[0, 0]], [[0, 0, 0]], [[0, 0, 4]], [[0, 3, 1]], [[4, 0, 1]], [[-1, 0, 1]], [[0, 0.5, 1]], [[1, 0, 1]], [["0", 0, 1]], [[0, 0, 1, 1]], [{ file: 0 }], [[0, 0, 2 ** 53]]]) {
      const r = await api("POST", `/api/v1/package/${p.id}/blocks`, { digest, want: bad });
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect((await api("POST", `/api/v1/package/${p.id}/blocks`, { digest, want: Array.from({ length: MAX_RUNS + 1 }, () => [3, 0, 1]) })).status).toBe(413);
    expect((await api("POST", `/api/v1/package/${p.id}/blocks`, "not json at all")).status).toBe(409);
    // without the key: nothing
    expect((await app.request(`/api/v1/package/${p.id}/blocks`)).status).toBe(401);
    expect((await app.request(`/api/v1/package/${p.id}/blocks`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("one request asks for no more than 256 MiB", async () => {
    const dir = mkdtempSync(join(tmp, "pkg-"));
    writeFileSync(join(dir, "zeros.bin"), ""); truncateSync(join(dir, "zeros.bin"), 257 * BLOCK);
    const h = new Bun.CryptoHasher("sha256"); const z = Buffer.alloc(BLOCK); for (let i = 0; i < 257; i++) h.update(z);
    const m = { schema: 1, name: "Zeros", slug: "zeros", version: null, launch: { exe: "zeros.bin", args: "", cwd: "" }, prerequisites: [], files: [{ path: "zeros.bin", size: 257 * BLOCK, sha256: h.digest("hex") }], totalSize: 257 * BLOCK, source: null, tier: "deterministic", notes: null, createdAt: "" };
    const row = stmts.insertPackage.get(null, null, dir, "Zeros", null, m.totalSize, JSON.stringify(m)) as PackageRow;
    made.push(row.id);
    const p = stmts.packageById.get(row.id) as PackageRow;
    expect((await indexPackage(p)).ok).toBe(true);
    expect((await want(p, [[0, 0, 257]])).status).toBe(413);
    expect((await want(p, [[0, 0, 200], [0, 200, 57]])).status).toBe(413);              // however it is cut into runs
    const ok = await want(p, [[0, 0, 256]]);
    expect(ok.status).toBe(200);
    const reader = ok.body!.getReader();
    await reader.read();
    expect(blocksStatus().sending).toBe(1);
    await reader.cancel();                                                               // a caller that goes away: the reading stops, the file is let go
    expect(blocksStatus().sending).toBe(0);
  });

  test("a file that is no longer the one indexed is not sent: what came before it is, then the stream says why and ends", async () => {
    const p = pkgOf("Edited", GAME);
    await indexPackage(p);
    writeFileSync(join(p.path, "data", "script.txt"), text(3 * BLOCK, "another text altogether, of the same length.. "));
    utimesSync(join(p.path, "data", "script.txt"), new Date(), new Date(Date.now() + 5000));
    const fr = await framesOf(await want(p, [[0, 0, 1], [2, 0, 3], [3, 0, 1]]));
    expect(fr.map(f => f.kind)).toEqual([0, FRAME.error]);
    expect(fr[1]!.payload.toString()).toContain("data/script.txt is not the file that was indexed any more");
    // a file that is gone
    rmSync(join(p.path, "readme.txt"));
    const gone = await framesOf(await want(p, [[3, 0, 1]]));
    expect(gone.map(f => f.kind)).toEqual([FRAME.error]);
  });
});

describe("an import indexes its package in the read it does anyway", () => {
  test("the manifest's pass gives every file's block hashes: the index written from them is the one built from the files", async () => {
    const p = pkgOf("Pass", GAME);
    const reads: string[] = [];
    const real = vdeps.sha256;
    vdeps.sha256 = (path, onBytes, signal, blocks) => { reads.push(path); return real(path, onBytes, signal, blocks); };
    const v: Validation = { ok: true, root: p.path, problems: [], exeCandidates: ["bin/game.exe"], launch: "bin/game.exe", prerequisites: [], totalSize: 0, fileCount: 4 };
    const hashes = new Map<string, Uint8Array>();
    const m = await buildManifest(v, { name: "Pass", version: null, source: null, tier: "deterministic" }, undefined, { blocks: hashes });
    expect(reads.length).toBe(4);                                                        // each file read once
    expect([...hashes.keys()].sort()).toEqual(["bin/game.exe", "data/empty.dat", "data/script.txt", "readme.txt"]);
    expect(m.files).toEqual(filesOf(p));
    expect(await writeIndex(p, path => hashes.get(path))).toEqual({ blocks: 7 });
    const fromPass = readFileSync(join(indexDir, `${p.id}.blk`)).subarray(32, 64 + 7 * 32);
    resetBlocks(); rmSync(join(indexDir, `${p.id}.blk`));
    await indexPackage(p);
    expect(readFileSync(join(indexDir, `${p.id}.blk`)).subarray(32, 64 + 7 * 32).equals(fromPass)).toBe(true);
    // hashes that are missing (a file ludarr placed without reading it) or too few: nothing is written
    resetBlocks(); rmSync(join(indexDir, `${p.id}.blk`));
    expect(await writeIndex(p, path => (path === "readme.txt" ? undefined : hashes.get(path)))).toBeNull();
    expect(await writeIndex(p, path => (path === "bin/game.exe" ? hashes.get(path)!.subarray(0, 64) : hashes.get(path)))).toBeNull();
    expect(readdirSync(indexDir)).toEqual([]);
    expect(blocksOf(p)).toBeNull();
  });

  test("a game imported from a folder can be taken as blocks the moment it is in the library", async () => {
    pdeps.tools = () => ({ ...tools7z });
    importDeps.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: recipes.create({}, registry.pluginContext("importers")) }];
    const g = upsertGame({ steam_appid: 996_101, name: "Block Import", slug: "block-import" });
    const src = mkdtempSync(join(tmp, "dl-"));
    const files: Files = { "Block Import.exe": bytes(2_000_000, 1), "data/level.pak": bytes(3_000_000, 2), "data/words.txt": text(1_500_000) };
    for (const [rel, b] of Object.entries(files)) { mkdirSync(dirname(join(src, rel)), { recursive: true }); writeFileSync(join(src, rel), b); }
    const j = stmts.insertJob.get(null, null, g.id, src) as JobRow;
    try {
      await runJob(j.id);
      const done = stmts.jobById.get(j.id) as JobRow;
      expect([done.state, done.message?.slice(0, 5)]).toEqual(["done", "ready"]);
      expect(done.transcript).toContain("blocks indexed");
      const p = stmts.packageForGame.get(g.id) as PackageRow;
      const list = filesOf(p);
      expect(blocksOf(p)).toEqual({ size: BLOCK, count: list.reduce((n, f) => n + blockCount(f.size), 0), digest: filesDigest(list) });
      const fr = await framesOf(await want(p, list.map((f, i) => [i, 0, blockCount(f.size)])));
      let at = 0;
      for (const f of list) {
        const n = blockCount(f.size);
        expect(sha(Buffer.concat(fr.slice(at, at + n).map(plain)))).toBe(f.sha256);     // the blocks are the file the manifest lists
        at += n;
      }
      expect(fr.length).toBe(at);
    } finally {
      const p = stmts.packageForGame.get(g.id) as PackageRow | undefined;
      if (p) { db.query("DELETE FROM packages WHERE id=?").run(p.id); rmSync(p.path, { recursive: true, force: true }); }
      db.query("DELETE FROM jobs WHERE id=?").run(j.id); db.query("DELETE FROM history WHERE game_id=?").run(g.id); db.query("DELETE FROM games WHERE id=?").run(g.id);
    }
  });
});

describe("the task: the packages that have no index get one", () => {
  const others = () => { for (const p of stmts.packagesAll.all() as PackageRow[]) if (!made.includes(p.id)) db.query("DELETE FROM packages WHERE id=?").run(p.id); };

  test("one a run, the newest first; never while a job runs; what is left is said", async () => {
    others();
    const a = pkgOf("Older", GAME), b = pkgOf("Newer", { "g.exe": bytes(BLOCK + 5, 3) });
    expect(blocksStatus()).toMatchObject({ packages: 2, ready: 0, working: null, waiting: [{ id: b.id, name: "Newer" }, { id: a.id, name: "Older" }], refused: [] });
    const job = db.query("INSERT INTO jobs (input_path, state) VALUES ('x', 'running') RETURNING id").get() as { id: number };
    await blocksTick();
    expect(blocksStatus().ready).toBe(0);                                                // an import reads the same disks: it goes first
    db.query("DELETE FROM jobs WHERE id=?").run(job.id);
    await blocksTick();
    expect([blocksOf(b)?.count, blocksOf(a)]).toEqual([2, null]);
    await blocksTick();
    expect(blocksOf(a)?.count).toBe(7);
    expect(blocksStatus()).toMatchObject({ packages: 2, ready: 2, blocks: 9, sending: 0, waiting: [], refused: [] });
    const before = readdirSync(indexDir).map(n => statSync(join(indexDir, n)).mtimeMs);
    await blocksTick();                                                                  // nothing left: nothing is read or written again
    expect(readdirSync(indexDir).map(n => statSync(join(indexDir, n)).mtimeMs)).toEqual(before);
  });

  test("a package with a file that is not the one imported stays file by file: said once, tried again a day later", async () => {
    others();
    const p = pkgOf("Tampered", GAME);
    writeFileSync(join(p.path, "readme.txt"), "ENJOY");
    let reads = 0;
    const warned: string[] = [];
    const realWarn = console.warn, realLog = console.log;
    console.warn = console.log = (...a: unknown[]) => { if (String(a.join(" ")).includes("stays file by file")) warned.push(a.join(" ")); };
    try {
      let now = Date.now();
      blkdeps.now = () => now;
      await blocksTick();
      expect(blocksOf(p)).toBeNull();
      expect(blocksStatus().refused).toEqual([{ id: p.id, name: "Tampered", why: "readme.txt is not the file that was imported" }]);
      await blocksTick(); await blocksTick();
      now += 25 * 3600_000;
      writeFileSync(join(p.path, "readme.txt"), "enjoy");                                // put right meanwhile
      await blocksTick();
      expect(blocksOf(p)?.count).toBe(7);
      expect(blocksStatus().refused).toEqual([]);
      reads = warned.length;
    } finally { console.warn = realWarn; console.log = realLog; }
    expect(reads).toBe(1);
  });

  test("the index of a package that is gone goes; one whose files changed is built again", async () => {
    others();
    const gone = pkgOf("Gone", { "g.exe": bytes(1000, 1) }), stays = pkgOf("Stays", { "g.exe": bytes(1000, 2), "more.txt": text(5000) });
    await blocksTick(); await blocksTick();
    expect(readdirSync(indexDir).sort()).toEqual([`${gone.id}.blk`, `${stays.id}.blk`].sort());
    db.query("DELETE FROM packages WHERE id=?").run(gone.id);
    writeFileSync(join(indexDir, "999.blk.1.2.part"), "left by a run that died");
    await blocksTick();
    expect(readdirSync(indexDir)).toEqual([`${stays.id}.blk`]);
    // the package's files are others now (a copy rebuilt in place): its index is not theirs, and the next run builds theirs
    writeFileSync(join(stays.path, "more.txt"), text(7000));
    const m = JSON.parse(stays.manifest_json) as Manifest;
    const row = stmts.setPackageManifest.get(JSON.stringify({ ...m, files: m.files.map(f => (f.path === "more.txt" ? { path: f.path, size: 7000, sha256: sha(text(7000)) } : f)) }), null, stays.id) as PackageRow;
    expect(blocksOf(row)).toBeNull();
    await blocksTick();
    expect(blocksOf(row)).toEqual({ size: BLOCK, count: 2, digest: filesDigest((JSON.parse(row.manifest_json) as Manifest).files) });
    expect((await framesOf(await want(row, [[1, 0, 1]]))).map(plain)[0]!.equals(text(7000))).toBe(true);
  });
});
