import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type RootFolderRow } from "../src/db";
import { downloadsDir, writeConfig } from "../src/config";
import { EnvError } from "../src/ways/errors";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";
import { jobKinds, enqueueJob } from "../src/process/kinds";
import {
  allowedRoots, attachToWays, checkServerPath, ContentError, ctdeps, gameTarget, ingestPath, ingestUpload, keepFreeBytes, needAccept, needTarget, removeContent, STORE,
} from "../src/ways/content";
import { getContent, getWay, insertContent, insertPlan, insertWay, settleWay, updateWay } from "../src/ways/store";
import type { RuntimePlanSpec } from "../src/ways/types";

for (const p of BUILTIN) registry.registerPlugin(p, "builtin");

const real = { ...ctdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-content-"));
const rootDir = join(tmp, "library"), outside = join(tmp, "elsewhere");
mkdirSync(rootDir, { recursive: true }); mkdirSync(outside, { recursive: true });
/** the store records real paths: the temp folder can itself be reached through a link or a short name */
const rootReal = realpathSync(rootDir);
const root: RootFolderRow = { id: 991_000, path: rootDir, name: null, created_at: 0 };
const made = { plans: [] as number[], games: [] as number[] };

beforeAll(() => { ctdeps.rootFolders = () => [root]; ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); });
afterEach(() => { Object.assign(ctdeps, real, { rootFolders: () => [root], diskSpace: async () => ({ free: 1e15, total: 2e15 }) }); });
afterAll(() => {
  Object.assign(ctdeps, real);
  db.query("DELETE FROM contents WHERE substr(path, 1, ?)=?").run(rootReal.length, rootReal);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

let appid = 991_100;
function game(name: string): GameRow {
  const g = upsertGame({ steam_appid: ++appid, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
  made.games.push(g.id);
  return g;
}
function random(n: number, seed = 1) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}
function n64(size = 8192) {
  const z64 = random(size, 42); z64.set([0x80, 0x37, 0x12, 0x40], 0);
  const v64 = new Uint8Array(size);
  for (let i = 0; i < size; i += 2) { v64[i] = z64[i + 1]; v64[i + 1] = z64[i]; }
  return { z64, v64 };
}
const sha1 = (b: Uint8Array) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
const stream = (b: Uint8Array, piece = 1000) => new ReadableStream<Uint8Array>({
  start(c) { for (let i = 0; i < b.length; i += piece) c.enqueue(b.slice(i, i + piece)); c.close(); },
});
const store = (g: GameRow) => join(rootReal, STORE, g.slug!);
const incoming = () => readdirSync(join(rootReal, STORE, ".incoming"));
async function refused(p: Promise<unknown>): Promise<ContentError> {
  try { await p; } catch (e) { if (e instanceof ContentError) return e; throw e; }
  throw new Error("expected a refusal");
}
/** the server's own state (no room, no plain store folder): an EnvError, so a carry run looks again later */
async function envRefused(p: Promise<unknown>): Promise<EnvError> {
  try { await p; } catch (e) { if (e instanceof EnvError) return e; throw e; }
  throw new Error("expected the server to say no");
}
const spec = (o: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Contentrecomp-.*[.]zip$", channel: "stable" },
  launch: { exe: "Recomp.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "the test ROM", search: ["Content Test"], accept: { hashes: [{ algo: "sha1", value: sha1(n64().z64) }], formats: ["z64"] }, normalize: "n64-z64", place: "rom.z64" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...o,
});
function plan(name: string, s = spec(), kind: "recomp" | "port" | "emulator" = "recomp") {
  const p = insertPlan({ name, kind, repo: "test/content-plan", platforms: ["n64"], spec: s, status: "ready" });
  made.plans.push(p.id);
  return p;
}

describe("content store: uploads", () => {
  test("streamed in, hashed in the same pass, renamed into the game's folder; nothing left on its way in", async () => {
    const g = game("Content Upload One");
    const bytes = random(50_000, 9);
    const r = await ingestUpload(stream(bytes), gameTarget(g.id), { name: "Some Game (USA).iso" });
    expect(r.duplicate).toBe(false);
    expect(r.row.path).toBe(join(store(g), "Some Game (USA).iso"));
    expect(readFileSync(r.row.path).equals(Buffer.from(bytes))).toBe(true);
    expect(JSON.parse(r.row.hashes_json).sha1).toBe(sha1(bytes));
    expect(r.row).toMatchObject({ game_id: g.id, role: "game", source: "upload", size: 50_000, platform: null, raw_hashes_json: null });
    expect(incoming()).toEqual([]);
  });

  test("an N64 dump in another byte order is kept big-endian under .z64, whatever the way; the bytes as sent keep their hashes", async () => {
    const g = game("Content Byteswap");
    const { z64, v64 } = n64();
    const r = await ingestUpload(stream(v64, 333), gameTarget(g.id), { name: "Majora.v64" });
    expect(r.row.name).toBe("Majora.z64");
    expect(readFileSync(r.row.path).equals(Buffer.from(z64))).toBe(true);
    expect(JSON.parse(r.row.hashes_json).sha1).toBe(sha1(z64));
    expect(JSON.parse(r.row.raw_hashes_json!).sha1).toBe(sha1(v64));
    expect(r.row.platform).toBe("n64");
    expect(r.row.normalized).toBe("n64 byte order v64 → z64");
  });

  test("a name with folders in it is reduced to its base name: nothing lands outside the game's folder", async () => {
    const g = game("Content Traversal");
    for (const [name, kept] of [["../../other-game/baserom.z64", "baserom.z64"], ["..\\..\\x.sfc", "x.sfc"], ["/etc/passwd", "passwd"], ["...hidden.gba", "hidden.gba"]]) {
      const r = await ingestUpload(stream(random(100, 500 + name.charCodeAt(1) + name.length * 7)), gameTarget(g.id), { name });
      expect([name, r.row.path]).toEqual([name, join(store(g), kept)]);
    }
    expect(existsSync(join(rootReal, STORE, "other-game"))).toBe(false);
  });

  test("past the largest upload: refused, and the partial file is gone", async () => {
    const g = game("Content Too Big");
    ctdeps.maxUploadBytes = () => 10_000;
    expect((await refused(ingestUpload(stream(random(20_000)), gameTarget(g.id), { name: "big.iso" }))).status).toBe(413);
    expect((await refused(ingestUpload(stream(random(10)), gameTarget(g.id), { name: "big.iso", size: 20_000 }))).status).toBe(413);  // a declared size is refused before a byte is read
    expect(incoming()).toEqual([]);
    expect(stmts.gameById.get(g.id)).toBeTruthy();
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
  });

  test("not enough room: refused before writing when the size is known, and as the free space runs out mid-upload — the library keeps LIBRARY_KEEP_FREE_GB free", async () => {
    const g = game("Content No Room");
    ctdeps.keepFree = () => 1e9;
    ctdeps.diskSpace = async () => ({ free: 1e9 + 5_000, total: 1e12 });
    const e = await envRefused(ingestUpload(stream(random(10_000)), gameTarget(g.id), { name: "a.iso", size: 10_000 }));
    expect(e.kind).toBe("room");
    expect(e.message).toMatch(/^not enough room: .* free on the library volume where the game files are kept, and this needs 10 KB plus the 1\.0 GB kept free \(Settings → General → Import → Keep free on the library\)$/);
    let free = 2e9;
    ctdeps.diskSpace = async () => ({ free: (free -= 400_000), total: 1e12 });
    ctdeps.recheckBytes = 1000;
    ctdeps.keepFree = () => 2e9 - 1_000_000;                      // room for about one more megabyte
    expect((await envRefused(ingestUpload(stream(random(200_000), 1000), gameTarget(g.id), { name: "b.iso" }))).kind).toBe("room");
    expect(incoming()).toEqual([]);
  });

  test("the setting is read each time: LIBRARY_KEEP_FREE_GB changed in Settings counts at once, even for a link that writes nothing", async () => {
    const g = game("Content Keep Free");
    try {
      writeConfig({ LIBRARY_KEEP_FREE_GB: "3" });
      expect(keepFreeBytes()).toBe(3e9);
      ctdeps.diskSpace = async () => ({ free: 2e9, total: 1e12 });
      const dl = join(downloadsDir(), "ways-content-keep"); mkdirSync(dl, { recursive: true });
      writeFileSync(join(dl, "small.iso"), random(1000, 3));
      expect((await envRefused(ingestPath(join(dl, "small.iso"), gameTarget(g.id)))).message).toContain("the 3.0 GB kept free");
      writeConfig({ LIBRARY_KEEP_FREE_GB: "1" });
      expect((await ingestPath(join(dl, "small.iso"), gameTarget(g.id))).row.size).toBe(1000);
    } finally { db.query("DELETE FROM kv WHERE key=?").run("cfg.LIBRARY_KEEP_FREE_GB"); }
  });

  test("the same bytes twice: one file; another file under a taken name gets its own name", async () => {
    const g = game("Content Twice");
    const a = random(3000, 1), b = random(3000, 2);
    const first = await ingestUpload(stream(a), gameTarget(g.id), { name: "disc.iso" });
    const again = await ingestUpload(stream(a), gameTarget(g.id), { name: "copy of disc.iso" });
    expect(again).toMatchObject({ duplicate: true, row: { id: first.row.id } });
    const other = await ingestUpload(stream(b), gameTarget(g.id), { name: "disc.iso" });
    expect(other.row.name).toBe("disc (2).iso");
    expect(readdirSync(store(g)).sort()).toEqual(["disc (2).iso", "disc.iso"]);
    expect(readFileSync(first.row.path).equals(Buffer.from(a))).toBe(true);                // the first file was never replaced
  });

  test("a kept file gone from the disk: the same bytes again bring its row back to life, and the ways keep it", async () => {
    const g = game("Content Revived");
    const p = plan("Content Revived Plan");
    const w = insertWay({ gameId: g.id, planId: p.id });
    const first = await ingestUpload(stream(n64().v64), gameTarget(g.id), { name: "rom.v64" });
    attachToWays(first.row);
    rmSync(first.row.path);
    const again = await ingestUpload(stream(n64().z64), gameTarget(g.id), { name: "rom (again).z64" });
    expect(again).toMatchObject({ duplicate: false, row: { id: first.row.id, name: "rom (again).z64", raw_hashes_json: null, normalized: null } });
    expect(existsSync(again.row.path)).toBe(true);
    expect(getWay(w.id)!.content_id).toBe(first.row.id);
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 1 });
  });

  test("a store folder that is a link to somewhere else is refused: the server's state, not the file's", async () => {
    const g = game("Content Linked");
    mkdirSync(join(rootReal, STORE), { recursive: true });
    try { symlinkSync(outside, store(g), "junction"); } catch { return; }       // no links on this box: nothing to prove
    const e = await envRefused(ingestUpload(stream(random(100)), gameTarget(g.id), { name: "x.iso" }));
    expect(e.kind).toBe("tool");
    expect(e.message).toContain("the content store must be a plain folder");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("no root folder, or one whose volume is gone, is the server's state (EnvError 'tool'), not a refusal of the file", async () => {
    const g = game("Content No Root");
    ctdeps.rootFolders = () => [];
    expect((await envRefused(ingestUpload(stream(random(100)), gameTarget(g.id), { name: "x.iso" }))).message).toBe("no root folder — add one under Settings → Media management");
    ctdeps.rootFolders = () => [{ id: 991_999, path: join(tmp, "unmounted"), name: null, created_at: 0 }];
    expect((await envRefused(ingestUpload(stream(random(100)), gameTarget(g.id), { name: "x.iso" }))).message).toMatch(/is not there — is its volume mounted\?$/);
  });

  test("an empty body is refused", async () => {
    const g = game("Content Empty");
    expect((await refused(ingestUpload(stream(new Uint8Array(0)), gameTarget(g.id), { name: "x.iso" }))).status).toBe(400);
    expect((await refused(ingestUpload(null, gameTarget(g.id), { name: "x.iso" }))).status).toBe(400);
  });
});

describe("content store: files already on the server", () => {
  test("taken only from the downloads folder, a root folder or a client's mapped folder — realpath-checked", async () => {
    const dl = join(downloadsDir(), "ways-content"); mkdirSync(dl, { recursive: true });
    writeFileSync(join(dl, "game.iso"), random(10));
    writeFileSync(join(outside, "secret.db"), "x");
    expect((await checkServerPath(join(dl, "game.iso"))).size).toBe(10);
    expect((await refused(checkServerPath(join(outside, "secret.db")))).status).toBe(403);
    expect((await refused(checkServerPath("relative/game.iso"))).status).toBe(400);
    expect((await refused(checkServerPath(join(dl, "nope.iso")))).status).toBe(404);
    expect((await refused(checkServerPath(dl))).message).toContain("a folder");
    let linked = false;
    try { symlinkSync(outside, join(dl, "escape"), "junction"); linked = true; } catch { /* no links on this box */ }
    if (linked) expect((await refused(checkServerPath(join(dl, "escape", "secret.db")))).status).toBe(403);   // a link inside downloads that leads out
    // a download client's mapped folder counts once the client is set up, and stops counting when it is switched off
    const mount = join(tmp, "seedbox-mount"); mkdirSync(mount, { recursive: true }); writeFileSync(join(mount, "rom.z64"), random(10));
    const inst = registry.createInstance("downloadClient", "rtorrent", { name: "mapped", settings: { url: "https://box.example/rpc", pathMap: `/home/u/downloads=${mount}` } });
    try {
      expect((await checkServerPath(join(mount, "rom.z64"))).size).toBe(10);
      registry.updateInstance(inst.id, { enabled: false });
      expect((await refused(checkServerPath(join(mount, "rom.z64")))).status).toBe(403);
    } finally { registry.deleteInstance(inst.id); }
    expect(await allowedRoots()).toContain(rootReal);
  });

  test("never moved: the original stays where it is; on the store's volume it is linked in (no bytes written), hashed where it lies", async () => {
    const g = game("Content From Path");
    const dl = join(downloadsDir(), "ways-content"); mkdirSync(dl, { recursive: true });
    const src = join(dl, "Tetris (World).gb"); const bytes = random(4096, 4);
    writeFileSync(src, bytes);
    const r = await ingestPath(src, gameTarget(g.id));
    expect(existsSync(src)).toBe(true);
    expect(r.row).toMatchObject({ source: "path", name: "Tetris (World).gb", platform: "gb" });
    expect(readFileSync(r.row.path).equals(Buffer.from(bytes))).toBe(true);
    expect(r.linked).toBe(true);
    expect(lstatSync(r.row.path).ino).toBe(lstatSync(src).ino);
    expect(JSON.parse(r.row.stat_json!)).toMatchObject({ size: 4096, ino: lstatSync(src).ino });
    expect(JSON.parse(r.row.hashes_json).sha1).toBe(sha1(bytes));
    expect(incoming()).toEqual([]);
  });

  test("the same bytes already kept: the link goes again before anything is placed (.incoming stays empty)", async () => {
    const g = game("Content From Path Twice");
    const dl = join(downloadsDir(), "ways-content-twice"); mkdirSync(dl, { recursive: true });
    const bytes = random(5000, 44);
    writeFileSync(join(dl, "a.gba"), bytes); writeFileSync(join(dl, "b.gba"), bytes);
    const first = await ingestPath(join(dl, "a.gba"), gameTarget(g.id));
    const again = await ingestPath(join(dl, "b.gba"), gameTarget(g.id));
    expect(again).toMatchObject({ duplicate: true, row: { id: first.row.id } });
    expect(readdirSync(store(g))).toEqual(["a.gba"]);
    expect(incoming()).toEqual([]);
    expect(lstatSync(join(dl, "b.gba")).nlink).toBe(1);                     // our link to it is gone
  });

  test("an N64 dump in another byte order is copied (rewritten big-endian), never linked", async () => {
    const g = game("Content From Path V64");
    const dl = join(downloadsDir(), "ways-content-v64"); mkdirSync(dl, { recursive: true });
    const { z64, v64 } = n64();
    writeFileSync(join(dl, "swap.v64"), v64);
    const r = await ingestPath(join(dl, "swap.v64"), gameTarget(g.id));
    expect(r).toMatchObject({ linked: false, row: { name: "swap.z64", normalized: "n64 byte order v64 → z64" } });
    expect(readFileSync(r.row.path).equals(Buffer.from(z64))).toBe(true);
    expect(lstatSync(join(dl, "swap.v64")).nlink).toBe(1);
  });

  test("the content job: takes the file in, hashes it, attaches it to the ways it fits and says so", async () => {
    const def = jobKinds.get("content");
    expect(def).toBeTruthy();
    expect(await def!.scratch!({} as JobRow, { kind: "content", gameId: 1 })).toBe(0);
    const g = game("Content Job Game");
    const p = plan("Content Job Recomp");
    const w = insertWay({ gameId: g.id, planId: p.id });
    const dl = join(downloadsDir(), "ways-content"); mkdirSync(dl, { recursive: true });
    const { v64 } = n64();
    writeFileSync(join(dl, "job.v64"), v64);
    const job = enqueueJob({ kind: "content", gameId: g.id, path: join(dl, "job.v64") }, { gameId: g.id });
    const lines: string[] = [];
    const res = await def!.run({ job, spec: JSON.parse(job.spec_json!), work: tmp, staging: tmp, log: l => lines.push(l), progress: () => {}, signal: new AbortController().signal });
    expect(res.message).toContain("kept job.z64");
    const way = getWay(w.id)!;
    expect(way.content_id).not.toBeNull();
    expect(way.status).toBe("ready");
    expect(lines.join("\n")).toContain("this is its game file now");
    db.query("DELETE FROM jobs WHERE id=?").run(job.id);
  });
});

describe("content store: system files and removal", () => {
  const bios = random(4096, 77);
  const needSpec = () => spec({ needs: [{ kind: "bios", name: "Test BIOS", place: "bios/test.bin", accept: { hashes: [{ algo: "sha1", value: sha1(bios) }], sizes: [4096] } }] });

  test("a system file must be the one its need asks for: a wrong one is not kept", async () => {
    const p = plan("Content Needs Plan", needSpec());
    const t = needTarget(p.id, 0);
    const e = await refused(ingestUpload(stream(random(4096, 5)), t, { name: "scph.bin", accept: needAccept(t) }));
    expect(e.status).toBe(409);
    expect(e.message).toContain("not the Test BIOS this needs");
    expect(existsSync(join(rootReal, STORE, `plan-${p.id}`)) ? readdirSync(join(rootReal, STORE, `plan-${p.id}`)) : []).toEqual([]);
    const ok = await ingestUpload(stream(bios), t, { name: "scph.bin", accept: needAccept(t) });
    expect(ok.row).toMatchObject({ role: "system", plan_id: p.id, need_index: 0, game_id: null, platform: null });
    expect(ok.row.path).toBe(join(rootReal, STORE, `plan-${p.id}`, "scph.bin"));
    expect(() => needTarget(p.id, 3)).toThrow("needs 0 to 0");
  });

  test("a way with an unmet need waits for it; the need filled, it is ready", async () => {
    const p = plan("Content Needs Ways", needSpec());
    const g = game("Content Needs Game");
    const file = await ingestUpload(stream(n64().z64), gameTarget(g.id), { name: "rom.z64" });
    const w = insertWay({ gameId: g.id, planId: p.id });
    updateWay(w.id, { contentId: file.row.id });
    expect(settleWay(w.id)).toMatchObject({ status: "needs-files", status_note: "needs Test BIOS" });
    const t = needTarget(p.id, 0);
    await ingestUpload(stream(bios), t, { name: "bios.bin", accept: needAccept(t) });
    expect(settleWay(w.id)!.status).toBe("ready");
  });

  test("removing a file deletes it and the row; the ways that used it need a file again", async () => {
    const p = plan("Content Remove Plan");
    const g = game("Content Remove Game");
    const file = await ingestUpload(stream(n64().z64), gameTarget(g.id), { name: "rom.z64" });
    const w = insertWay({ gameId: g.id, planId: p.id });
    const { attached } = attachToWays(file.row);
    expect(attached).toEqual([w.id]);
    expect(getWay(w.id)!.status).toBe("ready");
    const r = await removeContent(file.row.id);
    expect(existsSync(file.row.path)).toBe(false);
    expect(getContent(file.row.id)).toBeNull();
    expect(r.ways.map(x => [x.id, x.status, x.content_id])).toEqual([[w.id, "needs-files", null]]);
    // a file a way that is being built uses is not removed: the server's state (EnvError 'busy'), said so with a 409
    const busy = await ingestUpload(stream(n64().z64), gameTarget(g.id), { name: "rom.z64" });
    attachToWays(busy.row);
    const job = enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id });
    try { expect((await envRefused(removeContent(busy.row.id))).kind).toBe("busy"); }
    finally { db.query("DELETE FROM jobs WHERE id=?").run(job.id); }
    // a row that points outside every content store never takes a file with it
    const stray = join(outside, "keep-me.iso"); writeFileSync(stray, "x");
    const row = insertContent({ gameId: g.id, name: "keep-me.iso", path: stray, size: 1, hashes: { sha1: "0".repeat(40) }, source: "path" });
    await removeContent(row.id);
    expect(existsSync(stray)).toBe(true);
    expect((await refused(removeContent(row.id))).status).toBe(404);
  });

  test("a new file attaches to a way without one, never over a matching file the way already has (unless named)", async () => {
    const g = game("Content Attach Rules");
    // a PS2 game: an .iso names no console, so it goes by itself only to the way for the game's one console
    db.query("UPDATE games SET platforms_json=? WHERE id=?").run(JSON.stringify(["ps2"]), g.id);
    const emu = plan("Content Attach Emu", spec({ content: { kind: "disc", platform: "ps2", what: "a PS2 disc", search: ["x"], accept: { hashes: [], formats: ["iso"] }, normalize: null, place: "games/{name}" } }), "emulator");
    const w = insertWay({ gameId: g.id, planId: emu.id });
    const a = await ingestUpload(stream(random(2000, 31)), gameTarget(g.id), { name: "a.iso" });
    expect(attachToWays(a.row).attached).toEqual([w.id]);
    const b = await ingestUpload(stream(random(2000, 32)), gameTarget(g.id), { name: "b.iso" });
    expect(attachToWays(b.row)).toMatchObject({ attached: [], checks: [{ wayId: w.id, ok: true }] });
    expect(getWay(w.id)!.content_id).toBe(a.row.id);
    expect(attachToWays(b.row, { wayId: w.id }).attached).toEqual([w.id]);
    const zip = await ingestUpload(stream(random(2000, 33)), gameTarget(g.id), { name: "c.zip" });
    expect(attachToWays(zip.row).checks[0]).toMatchObject({ ok: false, why: "a .zip file, and this needs .iso" });
  });
});
