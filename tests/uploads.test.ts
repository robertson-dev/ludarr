/**
 * A game's files uploaded from the admin's own PC (src/uploads.ts):
 *  - an upload is a folder of its own on the library, filled piece by piece; a file is whole only once its last byte is in,
 *    and a piece that does not start where the file ends is answered with where it does
 *  - names are plain names inside the upload's folder, never a way out of it
 *  - what was announced is what is taken: no more files, no more bytes, nothing missing at the finish
 *  - whole, it is an ordinary import (the game's copy) or a content job (a way's game file); done, its own files go;
 *    failed, they stay for another try, the other way too
 *  - a search under way for the game stops once the admin's own copy is in the library
 *  - what nobody finished goes after a week, and with its game
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { apiKey } from "../src/config";
import { app } from "../src/server";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";
import { recipes } from "../src/plugins/builtin/importers";
import { deleteGame } from "../src/library/games";
import { classOfPackage, DEFAULT_PROFILE, wantsUpgrade } from "../src/library/profiles";
import { addRootFolder, ensureDefaultRootFolder, removeRootFolder, rootFolders } from "../src/library/rootfolders";
import { pdeps } from "../src/process/deps";
import { rdeps as importDeps, runJob } from "../src/process/runner";
import { atdeps } from "../src/ways/attach";
import { intakeEntry } from "../src/ways/content";
import { getContent, getWay, insertPlan, insertWay } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import {
  cleanPath, createUpload, finishUpload, getUpload, KEEP_DAYS, PART, removeUpload, retryUpload, sweepUploads, udeps, UploadError, uploadFiles, UPLOADS, uploadsOfGame,
  uploadsQuiet, whereFile, writePiece, type UploadRow,
} from "../src/uploads";
import { bytes, dirLink, ok, sha1, tools7z } from "./ways-fixtures";

for (const p of BUILTIN) registry.registerPlugin(p, "builtin");
registry.ensureSingletons();

const saved = { exec: pdeps.exec, tools: pdeps.tools, log: pdeps.log, importers: importDeps.importers, udeps: { ...udeps }, loadDat: atdeps.loadDat };
const madeGames: number[] = [];
let root = "";
beforeAll(() => {
  ensureDefaultRootFolder();
  root = rootFolders()[0].path;
  pdeps.log = () => {};
  pdeps.tools = () => ({ ...tools7z });
  importDeps.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: recipes.create({}, registry.pluginContext("importers")) }];
  atdeps.loadDat = async () => null;
});
beforeEach(() => { Object.assign(udeps, saved.udeps); udeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); });
afterAll(async () => {
  pdeps.exec = saved.exec; pdeps.tools = saved.tools; pdeps.log = saved.log; importDeps.importers = saved.importers; atdeps.loadDat = saved.loadDat;
  Object.assign(udeps, saved.udeps);
  for (const id of madeGames) { for (const u of uploadsOfGame(id)) await removeUpload(u.id).catch(() => {}); }
  db.exec("DELETE FROM uploads");
  for (const id of madeGames) { db.query("DELETE FROM requests WHERE game_id=?").run(id); db.query("DELETE FROM packages WHERE game_id=?").run(id); db.query("DELETE FROM jobs WHERE game_id=?").run(id); db.query("DELETE FROM games WHERE id=?").run(id); }
});

let appid = 995_000;
function game(name: string): GameRow {
  const g = upsertGame({ steam_appid: ++appid, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
  madeGames.push(g.id);
  return stmts.gameById.get(g.id) as GameRow;
}
/** bytes that say which file and where: a piece put at the wrong place shows */
const pattern = (n: number, seed: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff; return b; };
async function* chunks(b: Uint8Array, size = 64 * 1024) { for (let i = 0; i < b.byteLength; i += size) yield b.subarray(i, Math.min(b.byteLength, i + size)); }
/** a sender that goes away after `after` bytes */
async function* cut(b: Uint8Array, after: number) { yield b.subarray(0, after); throw new Error("connection reset"); }
const put = (id: number, path: string, whole: Uint8Array, offset = 0, end = whole.byteLength) =>
  writePiece(id, { path, size: whole.byteLength, offset, body: chunks(whole.subarray(offset, end)) });
const refusal = async (p: Promise<unknown>): Promise<UploadError> => { try { await p; } catch (e) { if (e instanceof UploadError) return e; throw e; } throw new Error("it was not refused"); };
const dataOf = (u: UploadRow) => join(u.dir, u.name);
/** until the job's end has reached its upload (an event, handled a moment later) */
async function settled(id: number, want: (u: UploadRow | null) => boolean = u => !u) {
  for (let i = 0; i < 300; i++) { if (want(getUpload(id))) { await uploadsQuiet(); return; } await Bun.sleep(10); }
  throw new Error(`upload ${id} did not settle: ${JSON.stringify(getUpload(id))}`);
}
/** a game as a folder holds it */
const GAME: Record<string, Uint8Array> = { "Hades.exe": bytes(2_000_000, 1), "data/level.pak": bytes(3_000_000, 2), "readme.txt": new TextEncoder().encode("enjoy") };
const total = (files: Record<string, Uint8Array>) => Object.values(files).reduce((n, b) => n + b.byteLength, 0);
async function sendAll(id: number, files: Record<string, Uint8Array>) { for (const [path, b] of Object.entries(files)) await put(id, path, b); }

describe("an upload: a folder of its own, filled piece by piece", () => {
  test("it is made under the game's root folder, and a file takes its name only once its last byte is in", async () => {
    const g = game("Upload Pieces");
    const big = pattern(300_000, 7);
    const { row, resumed } = await createUpload(g.id, { name: "Upload Pieces", files: 2, bytes: big.byteLength + 5 });
    expect(resumed).toBe(false);
    expect(row).toMatchObject({ game_id: g.id, state: "uploading", files: 2, received: 0, way_id: null });
    expect(row.dir).toBe(join(root, UPLOADS, String(row.id)));
    expect(existsSync(dataOf(row))).toBe(true);

    expect(await put(row.id, "bin/game.dat", big, 0, 100_000)).toMatchObject({ received: 100_000, done: false });
    expect(existsSync(join(dataOf(row), "bin", "game.dat"))).toBe(false);
    expect(statSync(join(dataOf(row), "bin", `game.dat${PART}`)).size).toBe(100_000);
    expect(await uploadFiles(row)).toEqual([{ path: "bin/game.dat", size: 100_000, done: false }]);

    // a piece that does not start where the file ends: refused with where it does, nothing written
    const off = await refusal(put(row.id, "bin/game.dat", big, 150_000));
    expect([off.status, off.extra]).toEqual([409, { received: 100_000, done: false }]);
    const again = await refusal(put(row.id, "bin/game.dat", big, 0, 100_000));          // the same piece sent twice
    expect(again.extra).toEqual({ received: 100_000, done: false });
    expect(statSync(join(dataOf(row), "bin", `game.dat${PART}`)).size).toBe(100_000);

    expect(await put(row.id, "bin/game.dat", big, 100_000)).toMatchObject({ received: 300_000, done: true });
    expect(existsSync(join(dataOf(row), "bin", `game.dat${PART}`))).toBe(false);
    expect(Buffer.compare(readFileSync(join(dataOf(row), "bin", "game.dat")), big)).toBe(0);
    // a piece of a file that is whole already says so
    expect((await refusal(put(row.id, "bin/game.dat", big, 100_000))).extra).toEqual({ received: 300_000, done: true });
    expect(await put(row.id, "bin/game.dat", big, 300_000)).toMatchObject({ received: 300_000, done: true });

    expect(await put(row.id, "note.txt", new TextEncoder().encode("hello"))).toMatchObject({ received: 5, done: true });
    expect(getUpload(row.id)!.received).toBe(big.byteLength + 5);
    await removeUpload(row.id);
    expect(existsSync(row.dir)).toBe(false);
    expect(getUpload(row.id)).toBeNull();
  });

  test("a piece cut off on the way keeps what arrived, and the sender goes on from there", async () => {
    const g = game("Upload Cut Off");
    const b = pattern(200_000, 3);
    const { row } = await createUpload(g.id, { name: "cut.bin", files: 1, bytes: b.byteLength });
    const r = await writePiece(row.id, { path: "cut.bin", size: b.byteLength, offset: 0, body: cut(b, 70_000) });
    expect(r).toMatchObject({ received: 70_000, done: false });
    // the sender did not hear that: it sends from where it thinks it is, and is told where the file ends
    expect((await refusal(put(row.id, "cut.bin", b, 0))).extra).toEqual({ received: 70_000, done: false });
    expect(await put(row.id, "cut.bin", b, 70_000)).toMatchObject({ received: 200_000, done: true });
    expect(Buffer.compare(readFileSync(join(dataOf(row), "cut.bin")), b)).toBe(0);
    await removeUpload(row.id);
  });

  test("a file with no bytes is a file", async () => {
    const g = game("Upload Empty File");
    const { row } = await createUpload(g.id, { name: "Empty", files: 2, bytes: 3 });
    expect(await writePiece(row.id, { path: "empty.cfg", size: 0, offset: 0, body: null })).toMatchObject({ received: 0, done: true });
    expect(statSync(join(dataOf(row), "empty.cfg")).size).toBe(0);
    await removeUpload(row.id);
  });

  test("the same pick again is the same upload: only what is missing is sent", async () => {
    const g = game("Upload Resume");
    const a = pattern(120_000, 1), b = pattern(80_000, 2);
    const first = await createUpload(g.id, { name: "Resume Me", files: 2, bytes: 200_000 });
    await put(first.row.id, "a.bin", a);
    await put(first.row.id, "b.bin", b, 0, 30_000);
    const second = await createUpload(g.id, { name: "Resume Me", files: 2, bytes: 200_000 });
    expect([second.resumed, second.row.id]).toEqual([true, first.row.id]);
    expect(await uploadFiles(second.row)).toEqual([{ path: "a.bin", size: 120_000, done: true }, { path: "b.bin", size: 30_000, done: false }]);
    // another pick (another size) is another upload
    const other = await createUpload(g.id, { name: "Resume Me", files: 2, bytes: 200_001 });
    expect(other.row.id).not.toBe(first.row.id);
    await removeUpload(first.row.id); await removeUpload(other.row.id);
  });
});

describe("an upload: plain names inside its own folder", () => {
  test("a path that is not a plain path inside the upload is refused before anything is written", async () => {
    for (const bad of ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "a//b", "a/./b", "..", "a\\b.txt", "C:\\evil.txt", "bad\u0000name", "line\nbreak", `x${PART}`, `dir${PART.toUpperCase()}/f`, ""])
      expect(() => cleanPath(bad)).toThrow(UploadError);
    expect(cleanPath("bin/Game Data/level 1.pak")).toEqual(["bin", "Game Data", "level 1.pak"]);
    expect(cleanPath("ünï/コード.bin")).toEqual(["ünï", "コード.bin"]);

    const g = game("Upload Names");
    const { row } = await createUpload(g.id, { name: "Names", files: 3, bytes: 100 });
    const before = readdirSync(join(root, UPLOADS)).sort();
    for (const bad of ["../evil.txt", "../../evil.txt", "a/../../../evil.txt", "a\\..\\evil.txt"]) {
      const e = await refusal(writePiece(row.id, { path: bad, size: 4, offset: 0, body: chunks(bytes(4, 9)) }));
      expect(e.status).toBe(400);
    }
    expect(readdirSync(join(root, UPLOADS)).sort()).toEqual(before);
    expect(readdirSync(row.dir)).toEqual(["Names"]);
    expect(await uploadFiles(row)).toEqual([]);
    expect(existsSync(join(root, "evil.txt"))).toBe(false);
    // a file where a folder is, and a folder where a file is
    await put(row.id, "a/b.txt", bytes(4, 1));
    expect((await refusal(put(row.id, "a", bytes(4, 1)))).status).toBe(409);
    expect((await refusal(put(row.id, "a/b.txt/c.txt", bytes(4, 1)))).status).toBe(409);
    await removeUpload(row.id);
  });

  test("the upload's own name is one plain folder name, whatever was picked", async () => {
    const g = game("Upload Folder Name");
    const { row } = await createUpload(g.id, { name: "../..\\Weird: Name\u0007.zip", files: 1, bytes: 10 });
    expect(readdirSync(row.dir)).toHaveLength(1);
    expect(readdirSync(row.dir)[0]).not.toMatch(/[\\/]/);
    expect(dataOf(row).startsWith(row.dir)).toBe(true);
    expect((await refusal(createUpload(g.id, { name: "...", files: 1, bytes: 10 }))).status).toBe(400);
    expect((await refusal(createUpload(g.id, { name: "", files: 1, bytes: 10 }))).status).toBe(400);
    await removeUpload(row.id);
  });
});

describe("an upload: what was announced is what is taken", () => {
  test("no more bytes than the file's size, no more than the whole upload's, no more files", async () => {
    const g = game("Upload Bounds");
    const { row } = await createUpload(g.id, { name: "Bounds", files: 2, bytes: 1000 });
    const f = pattern(600, 5);
    await put(row.id, "one.bin", f, 0, 200);
    // a piece that runs past the file's own size: the file is as it was
    const past = await refusal(writePiece(row.id, { path: "one.bin", size: 600, offset: 200, body: chunks(pattern(500, 6)) }));
    expect(past.status).toBe(400);
    expect(statSync(join(dataOf(row), `one.bin${PART}`)).size).toBe(200);
    await put(row.id, "one.bin", f, 200);
    // a file larger than the whole upload was said to be
    expect((await refusal(writePiece(row.id, { path: "two.bin", size: 5000, offset: 0, body: chunks(bytes(5000, 1)) }))).status).toBe(413);
    // more bytes than the whole upload: two.bin may hold 400
    expect((await refusal(writePiece(row.id, { path: "two.bin", size: 900, offset: 0, body: chunks(bytes(900, 1), 100) }))).status).toBe(413);
    expect(statSync(join(dataOf(row), `two.bin${PART}`)).size).toBe(0);
    // a third file
    expect((await refusal(put(row.id, "three.bin", bytes(10, 1)))).status).toBe(409);
    expect(getUpload(row.id)!.received).toBe(600);
    await removeUpload(row.id);
  });

  test("it is not whole until every file is, and as many as were announced", async () => {
    const g = game("Upload Finish Checks");
    const { row } = await createUpload(g.id, { name: "Finish", files: 2, bytes: 300 });
    await put(row.id, "a.bin", bytes(100, 1));
    await put(row.id, "b.bin", bytes(200, 2), 0, 50);
    const partial = await refusal(finishUpload(row.id));
    expect([partial.status, partial.message]).toEqual([409, "1 file is not whole yet: b.bin"]);
    await removeUpload(row.id);
    const short = await createUpload(g.id, { name: "Finish", files: 3, bytes: 300 });
    await put(short.row.id, "a.bin", bytes(100, 1));
    expect((await refusal(finishUpload(short.row.id))).message).toMatch(/^the upload was said to be 3 files of .+; 1 of .+ is here$/);
    await removeUpload(short.row.id);
  });

  test("an upload the library has no room for is refused before a byte is sent", async () => {
    const g = game("Upload No Room");
    udeps.diskSpace = async () => ({ free: 60e9, total: 1e12 });
    udeps.keepFree = () => 50e9;
    const e = await refusal(createUpload(g.id, { name: "Too big", files: 1, bytes: 20e9 }));
    expect([e.status, e.message]).toEqual([507, "the library has 60 GB free: this upload is 20 GB, and ludarr keeps 50 GB free there (Settings → Media management)"]);
    expect((await createUpload(g.id, { name: "Fits", files: 1, bytes: 9e9 })).row.state).toBe("uploading");
    expect((await refusal(createUpload(999_999_999, { name: "x", files: 1, bytes: 1 }))).status).toBe(404);
    expect((await refusal(createUpload(g.id, { name: "x", files: 0, bytes: 1 }))).status).toBe(400);
    expect((await refusal(createUpload(g.id, { name: "x", files: 1, bytes: 0 }))).status).toBe(400);
    expect((await refusal(createUpload(g.id, { name: "x", files: 1, bytes: 1, wayId: 123_456 }))).status).toBe(404);
  });
});

describe("an upload that is whole becomes the game's copy", () => {
  test("a game folder: imported like any download, then the upload's own files go", async () => {
    const g = game("Upload Folder Import");
    const { row } = await createUpload(g.id, { name: "Hades (my copy)", files: 3, bytes: total(GAME) });
    await sendAll(row.id, GAME);
    const { row: whole, job } = await finishUpload(row.id);
    expect(whole).toMatchObject({ state: "importing", job_id: job.id });
    expect(job).toMatchObject({ kind: "import", game_id: g.id, state: "queued", input_path: dataOf(row) });
    expect(JSON.parse(job.spec_json!)).toEqual({ replace: false, upload: row.id });
    // while it is being taken in, nothing more is written into it
    expect((await refusal(put(row.id, "late.bin", bytes(4, 1)))).status).toBe(409);
    await runJob(job.id);
    const done = stmts.jobById.get(job.id) as JobRow;
    expect([done.state, done.message?.slice(0, 14)]).toEqual(["done", "ready: 3 files"]);
    expect(done.transcript).toContain("the upload's own files are removed now");
    await settled(row.id);
    expect(existsSync(row.dir)).toBe(false);
    const pkg = stmts.packageForGame.get(g.id) as PackageRow;
    expect(pkg.path.startsWith(root)).toBe(true);
    expect(existsSync(join(pkg.path, "Hades.exe"))).toBe(true);
    expect(JSON.parse(pkg.manifest_json).source).toMatchObject({ title: "Hades (my copy)", protocol: "upload" });
    // the copy the admin uploaded is theirs: no upgrade search replaces it, whatever the profile's cutoff
    expect(classOfPackage(pkg)).toBe("uploaded");
    expect(wantsUpgrade({ id: 1, ...DEFAULT_PROFILE, upgrade: true }, "uploaded")).toBe(false);
    expect(wantsUpgrade({ id: 1, ...DEFAULT_PROFILE, upgrade: true }, "unknown")).toBe(true);
  });

  test("one archive: the job is given the file itself, and unpacks it", async () => {
    const g = game("Upload Zip Import");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(50_000, 4)]);
    const { row } = await createUpload(g.id, { name: "Hades.v1.38.zip", files: 1, bytes: zip.byteLength });
    await put(row.id, "Hades.v1.38.zip", zip);
    const { job } = await finishUpload(row.id);
    expect(job.input_path).toBe(join(dataOf(row), "Hades.v1.38.zip"));
    pdeps.exec = async (cmd: string[]) => {
      if (cmd[0] === "7z" && cmd[1] === "x") {
        const out = cmd.find(a => a.startsWith("-o"))!.slice(2);
        for (const [p, b] of Object.entries(GAME)) { mkdirSync(join(out, p, ".."), { recursive: true }); writeFileSync(join(out, p), b); }
        return ok("Everything is Ok");
      }
      return ok();
    };
    try { await runJob(job.id); } finally { pdeps.exec = saved.exec; }
    expect((stmts.jobById.get(job.id) as JobRow).state).toBe("done");
    await settled(row.id);
    expect(existsSync(row.dir)).toBe(false);
    const pkg = stmts.packageForGame.get(g.id) as PackageRow;
    expect([pkg.version, existsSync(join(pkg.path, "data", "level.pak"))]).toEqual(["1.38", true]);
  });

  test("an import that fails keeps the files: tried again, or removed", async () => {
    const g = game("Upload Failed Import");
    const { row } = await createUpload(g.id, { name: "Not a game", files: 1, bytes: 5 });
    await put(row.id, "notes.txt", new TextEncoder().encode("hello"));
    const { job } = await finishUpload(row.id);
    await runJob(job.id);
    expect((stmts.jobById.get(job.id) as JobRow).state).toBe("failed");
    await settled(row.id, u => u?.state === "failed");
    const failed = getUpload(row.id)!;
    expect(failed.message).toBe((stmts.jobById.get(job.id) as JobRow).message);
    expect(existsSync(join(dataOf(row), "notes.txt"))).toBe(true);
    expect((await refusal(finishUpload(row.id))).status).toBe(409);
    const again = await retryUpload(row.id);
    expect(again.job.id).not.toBe(job.id);
    expect(again.row).toMatchObject({ state: "importing", job_id: again.job.id, message: null });
    // removed while its job waits in the queue: the job is cancelled, the files go
    expect(await removeUpload(row.id)).toEqual({ removed: true });
    await uploadsQuiet();
    expect((stmts.jobById.get(again.job.id) as JobRow).state).toBe("cancelled");
    expect(existsSync(row.dir)).toBe(false);
  });

  test("a search under way for the game stops once the admin's own copy is in; a way's file search runs on", async () => {
    const g = game("Upload Stops Search");
    const rid = (db.query("INSERT INTO requests (game_id, state, stage) VALUES (?, 'requested', 'queued') RETURNING id").get(g.id) as { id: number }).id;
    const { row } = await createUpload(g.id, { name: "Stops Search", files: 3, bytes: total(GAME) });
    await sendAll(row.id, GAME);
    const { job } = await finishUpload(row.id);
    await runJob(job.id);
    await settled(row.id);
    expect((db.query("SELECT state FROM requests WHERE id=?").get(rid) as { state: string }).state).toBe("cancelled");

    const h = game("Upload Keeps Way Search");
    const wayReq = (db.query("INSERT INTO requests (game_id, state, stage, way_id) VALUES (?, 'requested', 'queued', 77) RETURNING id").get(h.id) as { id: number }).id;
    const second = await createUpload(h.id, { name: "Keeps", files: 3, bytes: total(GAME) });
    await sendAll(second.row.id, GAME);
    const j2 = (await finishUpload(second.row.id)).job;
    await runJob(j2.id);
    await settled(second.row.id);
    expect((db.query("SELECT state FROM requests WHERE id=?").get(wayReq) as { state: string }).state).toBe("requested");
  });

  test("a game that plays through a built way keeps it unless the admin says replace", async () => {
    const g = game("Upload Over A Way");
    stmts.insertPackage.get(g.id, null, join(root, "upload-over-a-way-pkg"), g.name, null, 1, JSON.stringify({ schema: 1, files: [], kind: "recomp" }));
    const e = await refusal(createUpload(g.id, { name: "PC copy", files: 1, bytes: 10 }));
    expect([e.status, e.extra]).toEqual([409, { needsReplace: true }]);
    const { row } = await createUpload(g.id, { name: "PC copy", files: 1, bytes: 10, replace: true });
    expect(row.replace).toBe(1);
    await removeUpload(row.id);
  });
});

describe("an upload that is whole becomes a way's game file", () => {
  const rom = (() => { const b = pattern(16_384, 11); b.set([0x80, 0x37, 0x12, 0x40], 0); return b; })();
  function way(g: GameRow) {
    const spec = validatePlanSpec({
      program: { kind: "release", assetPattern: "^Uptest-v.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "Uptest.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "the test ROM", search: [g.name], accept: { hashes: [{ algo: "sha1", value: sha1(rom) }], formats: ["z64"] }, normalize: "n64-z64", place: "rom.z64" },
      files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" }, "recomp").value!;
    const plan = insertPlan({ name: `${g.name} recomp`, kind: "recomp", repo: `uptest/${g.slug}`, platforms: ["n64"], spec, status: "ready" });
    return insertWay({ gameId: g.id, planId: plan.id, status: "needs-files" });
  }

  test("the way's file: kept in the store as an upload, attached, and the upload's own files go", async () => {
    const g = game("Upload Way File");
    const w = way(g);
    const { row } = await createUpload(g.id, { name: "my dump.z64", files: 1, bytes: rom.byteLength, wayId: w.id });
    expect(row.way_id).toBe(w.id);
    await put(row.id, "my dump.z64", rom);
    const { job } = await finishUpload(row.id);
    expect(job).toMatchObject({ kind: "content", game_id: g.id });
    expect(JSON.parse(job.spec_json!)).toMatchObject({ kind: "content", gameId: g.id, wayId: w.id, upload: row.id, path: join(dataOf(row), "my dump.z64") });
    await runJob(job.id);
    const done = stmts.jobById.get(job.id) as JobRow;
    expect([done.state, done.message]).toEqual(["done", "kept my dump.z64 (16 KB)"]);
    const contentId = getWay(w.id)!.content_id!;
    expect(getContent(contentId)).toMatchObject({ source: "upload", game_id: g.id });
    await settled(row.id);
    expect(existsSync(row.dir)).toBe(false);
    expect(existsSync(getContent(contentId)!.path)).toBe(true);          // the store's own file stays
  });

  test("taken in for one way, a file becomes that way's also in place of the one it has; unasked, the way keeps its own", async () => {
    const g = game("Upload Way Replaces");
    const a = (() => { const b = pattern(16_384, 21); b.set([0x80, 0x37, 0x12, 0x40], 0); return b; })();
    const b2 = (() => { const b = pattern(16_384, 22); b.set([0x80, 0x37, 0x12, 0x40], 0); return b; })();
    const c = (() => { const b = pattern(16_384, 23); b.set([0x80, 0x37, 0x12, 0x40], 0); return b; })();
    const spec = validatePlanSpec({
      program: { kind: "release", assetPattern: "^Uptest-v.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "Uptest.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "the test ROM", search: [g.name], accept: { hashes: [a, b2, c].map(x => ({ algo: "sha1", value: sha1(x) })), formats: ["z64"] }, normalize: "n64-z64", place: "rom.z64" },
      files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" }, "recomp").value!;
    const plan = insertPlan({ name: `${g.name} recomp`, kind: "recomp", repo: `uptest/${g.slug}`, platforms: ["n64"], spec, status: "ready" });
    const w = insertWay({ gameId: g.id, planId: plan.id, status: "needs-files" });
    const dir = join(root, "upload-way-replaces-src"); mkdirSync(dir, { recursive: true });
    const file = (name: string, bytes_: Uint8Array) => { writeFileSync(join(dir, name), bytes_); return join(dir, name); };
    const first = await intakeEntry(file("a.z64", a), g, { source: "upload", move: false, wayId: w.id });
    expect(first.attached).toEqual([w.id]);
    expect(getWay(w.id)!.content_id).toBe(first.row!.id);
    // another file of the game, taken in for this way: its file now
    const second = await intakeEntry(file("b.z64", b2), g, { source: "upload", move: false, wayId: w.id });
    expect(second.attached).toEqual([w.id]);
    expect(getWay(w.id)!.content_id).toBe(second.row!.id);
    // a third, taken in for no way in particular: kept, and the way keeps the one it has
    const third = await intakeEntry(file("c.z64", c), g, { source: "upload", move: false });
    expect(third.attached).toEqual([]);
    expect(getWay(w.id)!.content_id).toBe(second.row!.id);
  });

  test("a file that is not the way's stays as an upload: it can be taken in as the game's copy instead", async () => {
    const g = game("Upload Way Misfit");
    const w = way(g);
    const other = pattern(16_384, 99);
    const { row } = await createUpload(g.id, { name: "other.z64", files: 1, bytes: other.byteLength, wayId: w.id });
    await put(row.id, "other.z64", other);
    const { job } = await finishUpload(row.id);
    await runJob(job.id);
    expect((stmts.jobById.get(job.id) as JobRow).state).toBe("done");
    await settled(row.id, u => u?.state === "failed");
    expect(getUpload(row.id)!.message).toMatch(/not the file .+ needs: /);
    expect(getWay(w.id)!.content_id).toBeNull();
    expect(existsSync(join(dataOf(row), "other.z64"))).toBe(true);
    const again = await retryUpload(row.id, { wayId: null });
    expect(again.row.way_id).toBeNull();
    expect(again.job).toMatchObject({ kind: "import", input_path: join(dataOf(row), "other.z64") });
    await removeUpload(row.id);
  });
});

describe("an upload whose sender went quiet, or sends twice", () => {
  /** a sender that sends `first` and then nothing more, without a word (a laptop asleep): the read never ends */
  async function* quiet(first: Uint8Array) { yield first; await new Promise<void>(() => {}); }

  test("a piece that brings nothing more ends by itself, keeps what came, and lets go of the file", async () => {
    const g = game("Upload Quiet Sender");
    const b = pattern(100_000, 5);
    const { row } = await createUpload(g.id, { name: "quiet.bin", files: 1, bytes: b.byteLength });
    udeps.stallMs = 60;
    const t0 = Date.now();
    const r = await writePiece(row.id, { path: "quiet.bin", size: b.byteLength, offset: 0, body: quiet(b.subarray(0, 40_000)) });
    expect(r).toMatchObject({ received: 40_000, done: false });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await whereFile(row.id, "quiet.bin")).toEqual({ received: 40_000, done: false });
    // the file is free: the next piece goes on from there
    expect(await put(row.id, "quiet.bin", b, 40_000)).toMatchObject({ received: 100_000, done: true });
    expect(await whereFile(row.id, "quiet.bin")).toEqual({ received: 100_000, done: true });
    expect(await whereFile(row.id, "never.bin")).toEqual({ received: 0, done: false });
    expect((await refusal(whereFile(row.id, "../quiet.bin"))).status).toBe(400);
    expect(Buffer.compare(readFileSync(join(dataOf(row), "quiet.bin")), b)).toBe(0);
    await removeUpload(row.id);
  });

  test("a newer piece of the same file takes over from the one still open, at once", async () => {
    const g = game("Upload Takes Over");
    const b = pattern(100_000, 6);
    const { row } = await createUpload(g.id, { name: "over.bin", files: 1, bytes: b.byteLength });
    // the first sender's line dropped without a word after 30 KB: its request stays open on the server (the wait is long)
    const first = writePiece(row.id, { path: "over.bin", size: b.byteLength, offset: 0, body: quiet(b.subarray(0, 30_000)) });
    for (let i = 0; i < 200 && (await whereFile(row.id, "over.bin")).received < 30_000; i++) await Bun.sleep(5);
    // the sender comes back from where it thinks it is: told where the file ends (the first piece has let go)
    const stale = await refusal(put(row.id, "over.bin", b, 0));
    expect([stale.status, stale.extra]).toEqual([409, { received: 30_000, done: false }]);
    expect(await first).toMatchObject({ received: 30_000, done: false });
    expect(await put(row.id, "over.bin", b, 30_000)).toMatchObject({ received: 100_000, done: true });
    expect(Buffer.compare(readFileSync(join(dataOf(row), "over.bin")), b)).toBe(0);
    await removeUpload(row.id);
  });

  test("an upload removed while a piece is still open: the piece ends, and the folder goes whole", async () => {
    const g = game("Upload Removed Mid Piece");
    const b = pattern(100_000, 7);
    const { row } = await createUpload(g.id, { name: "mid.bin", files: 1, bytes: b.byteLength });
    const open = writePiece(row.id, { path: "mid.bin", size: b.byteLength, offset: 0, body: quiet(b.subarray(0, 10_000)) }).catch(e => e);
    for (let i = 0; i < 200 && !existsSync(join(dataOf(row), `mid.bin${PART}`)); i++) await Bun.sleep(5);
    expect(await removeUpload(row.id)).toEqual({ removed: true });
    await uploadsQuiet();
    expect(existsSync(row.dir)).toBe(false);
    const ended = await open;
    expect(ended).toBeInstanceOf(UploadError);
    expect((ended as UploadError).status).toBe(404);
  });

  test("finished twice at once, it is handed over once", async () => {
    const g = game("Upload Finished Twice");
    const { row } = await createUpload(g.id, { name: "Twice", files: 1, bytes: 4 });
    await put(row.id, "a.bin", bytes(4, 1));
    const ends = await Promise.allSettled([finishUpload(row.id), finishUpload(row.id)]);
    expect(ends.map(e => e.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((db.query("SELECT COUNT(*) AS n FROM jobs WHERE game_id=?").get(g.id) as { n: number }).n).toBe(1);
    await removeUpload(row.id); await uploadsQuiet();
  });
});

describe("an upload removed while it is being taken in", () => {
  test("its job is stopped first, again after a restart, and the files go only then", async () => {
    const g = game("Upload Removed While Importing");
    const { row } = await createUpload(g.id, { name: "Removing", files: 3, bytes: total(GAME) });
    await sendAll(row.id, GAME);
    const { job } = await finishUpload(row.id);
    // the job is at work (in another life of the process: nothing here can stop it)
    stmts.setJob.run("running", "deterministic", 0.3, "unpacking", job.id);
    expect(await removeUpload(row.id)).toEqual({ removed: false });
    expect(getUpload(row.id)!.state).toBe("removing");
    expect(existsSync(join(dataOf(row), "Hades.exe"))).toBe(true);
    // asked again: still not under the job's feet
    expect(await removeUpload(row.id)).toEqual({ removed: false });
    expect(existsSync(join(dataOf(row), "Hades.exe"))).toBe(true);
    // ludarr restarts: the job is queued again, as every import cut short is — and is not run for an upload that was removed
    stmts.setJob.run("queued", "deterministic", 0, "resuming after restart", job.id);
    expect(await sweepUploads()).toMatchObject({ settled: 1 });
    await uploadsQuiet();
    expect((stmts.jobById.get(job.id) as JobRow).state).toBe("cancelled");
    expect([getUpload(row.id), existsSync(row.dir)]).toEqual([null, false]);
    expect(stmts.packageForGame.get(g.id)).toBeFalsy();
  });
});

describe("an upload's folder: its own number, its own names", () => {
  test("a folder of that number left by an earlier database is never touched: the next number is taken", async () => {
    const g = game("Upload Number Taken");
    const probe = await createUpload(g.id, { name: "Probe", files: 1, bytes: 4 });
    await removeUpload(probe.row.id); await uploadsQuiet();
    const stale = join(root, UPLOADS, String(probe.row.id + 1));
    mkdirSync(join(stale, "Someone Else"), { recursive: true });
    writeFileSync(join(stale, "Someone Else", "keep.bin"), "keep");
    const { row } = await createUpload(g.id, { name: "Mine", files: 1, bytes: 4 });
    expect(row.id).toBe(probe.row.id + 2);
    expect(readFileSync(join(stale, "Someone Else", "keep.bin"), "utf8")).toBe("keep");
    expect(getUpload(probe.row.id + 1)).toBeNull();
    await removeUpload(row.id); await uploadsQuiet();
    expect(existsSync(stale)).toBe(true);
  });

  test("names no longer than a disk takes: a file's with the mark of a file not whole yet, the upload's own in any script", async () => {
    expect(cleanPath(`${"a".repeat(241)}.bin`)).toHaveLength(1);                       // 245 bytes: with the mark, 255
    expect(() => cleanPath(`${"a".repeat(242)}.bin`)).toThrow(UploadError);
    expect(() => cleanPath(`dir/${"é".repeat(123)}.bin`)).toThrow(UploadError);        // 250 bytes in 127 letters
    const g = game("Upload Long Name");
    const { row } = await createUpload(g.id, { name: "ゲーム".repeat(60), files: 1, bytes: 4 });
    const made = readdirSync(row.dir);
    expect(made).toHaveLength(1);
    expect(Buffer.byteLength(made[0])).toBeLessThanOrEqual(200);
    expect(made[0].startsWith("ゲーム")).toBe(true);
    await put(row.id, "a.bin", bytes(4, 1));
    await removeUpload(row.id);
  });

  test("the sweep looks only into ludarr's own folder: one that is a link leads to someone else's", async () => {
    const other = addRootFolder(mkdtempSync(join(tmpdir(), "ahoy-upl-root-")));
    const elsewhere = mkdtempSync(join(tmpdir(), "ahoy-upl-elsewhere-"));
    const longAgo = Math.floor(Date.now() / 1000) - (KEEP_DAYS + 3) * 86_400;
    mkdirSync(join(elsewhere, "4711"), { recursive: true });
    writeFileSync(join(elsewhere, "4711", "theirs.bin"), "theirs");
    utimesSync(join(elsewhere, "4711"), longAgo, longAgo);
    dirLink(elsewhere, join(other.path, UPLOADS));
    try {
      expect(await sweepUploads()).toMatchObject({ orphans: 0 });
      expect(readFileSync(join(elsewhere, "4711", "theirs.bin"), "utf8")).toBe("theirs");
    } finally { removeRootFolder(other.id); }
  });
});

describe("uploads: housekeeping", () => {
  test("one nobody finished goes after a week untouched, with a folder no upload owns; a fresh one stays", async () => {
    const g = game("Upload Sweep");
    const old = await createUpload(g.id, { name: "Old", files: 1, bytes: 10 });
    const fresh = await createUpload(g.id, { name: "Fresh", files: 1, bytes: 10 });
    const longAgo = Math.floor(Date.now() / 1000) - (KEEP_DAYS + 1) * 86_400;
    db.query("UPDATE uploads SET touched_at=? WHERE id=?").run(longAgo, old.row.id);
    const orphanOld = join(root, UPLOADS, "9990001"), orphanNew = join(root, UPLOADS, "9990002"), notOurs = join(root, UPLOADS, "keep-me");
    for (const d of [orphanOld, orphanNew, notOurs]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "x"), "x"); }
    utimesSync(orphanOld, longAgo, longAgo); utimesSync(notOurs, longAgo, longAgo);
    const r = await sweepUploads();
    expect(r).toMatchObject({ expired: 1, orphans: 1 });
    expect([getUpload(old.row.id), existsSync(old.row.dir)]).toEqual([null, false]);
    expect([getUpload(fresh.row.id)?.state, existsSync(fresh.row.dir)]).toEqual(["uploading", true]);
    expect([existsSync(orphanOld), existsSync(orphanNew), existsSync(notOurs)]).toEqual([false, true, true]);
    await removeUpload(fresh.row.id);
  });

  test("an upload whose job ended while nobody was told is settled by the sweep", async () => {
    const g = game("Upload Sweep Settles");
    const { row } = await createUpload(g.id, { name: "Settle", files: 1, bytes: 4 });
    await put(row.id, "a.bin", bytes(4, 1));
    const { job } = await finishUpload(row.id);
    stmts.setJobFailed.run("failed", "the importer gave up", job.id);          // no event: ludarr was down
    expect(getUpload(row.id)!.state).toBe("importing");
    expect(await sweepUploads()).toMatchObject({ settled: 1 });
    expect(getUpload(row.id)).toMatchObject({ state: "failed", message: "the importer gave up" });
    await removeUpload(row.id);
  });

  test("a game deleted takes its uploads along", async () => {
    const g = game("Upload Game Deleted");
    const { row } = await createUpload(g.id, { name: "Gone", files: 1, bytes: 4 });
    await put(row.id, "a.bin", bytes(4, 1));
    await deleteGame(g.id);
    await settled(row.id);
    expect(existsSync(row.dir)).toBe(false);
  });
});

describe("uploads API", () => {
  const key = { "x-api-key": apiKey() };
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await app.request(path, { ...init, headers: { ...key, ...(init.headers as Record<string, string> ?? {}) }, duplex: "half" } as RequestInit);
    return { status: r.status, body: (await r.json()) as any };
  };
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("a whole upload over the API: made, sent in pieces larger than any JSON body, listed, finished", async () => {
    const g = game("Upload Api");
    const big = pattern(2_500_000, 21);                                         // over the 1 MB cap every other body has
    const small = new TextEncoder().encode("enjoy");
    expect((await app.request(`/api/v1/game/${g.id}/upload`, json("POST", { name: "x", files: 1, bytes: 1 }))).status).toBe(401);
    const made = await call(`/api/v1/game/${g.id}/upload`, json("POST", { name: "Api Game", files: 3, bytes: big.byteLength + small.byteLength + 3_000_000 }));
    expect(made.status).toBe(201);
    const id = made.body.item.id as number;
    expect(made.body.item).toMatchObject({ gameId: g.id, name: "Api Game", state: "uploading", received: 0, wayId: null, job: null });
    expect(made.body.item.expiresAt).toBe(made.body.item.touchedAt + KEEP_DAYS * 86_400);

    const file = (path: string, size: number, offset: number) => `/api/v1/upload/${id}/file?path=${encodeURIComponent(path)}&size=${size}&offset=${offset}`;
    const first = await call(file("data/big.pak", big.byteLength, 0), { method: "PUT", body: big.subarray(0, 2_000_000) });
    expect([first.status, first.body.received, first.body.done]).toEqual([200, 2_000_000, false]);
    const wrong = await call(file("data/big.pak", big.byteLength, 0), { method: "PUT", body: big.subarray(0, 10) });
    expect([wrong.status, wrong.body.received]).toEqual([409, 2_000_000]);
    expect((await call(file("data/big.pak", big.byteLength, 2_000_000), { method: "PUT", body: big.subarray(2_000_000) })).body).toMatchObject({ received: big.byteLength, done: true });
    expect((await call(file("readme.txt", small.byteLength, 0), { method: "PUT", body: small })).body.done).toBe(true);
    expect((await call(file("Api Game.exe", 3_000_000, 0), { method: "PUT", body: bytes(3_000_000, 1) })).body.done).toBe(true);
    expect((await call(file("../evil", 1, 0), { method: "PUT", body: bytes(1, 1) })).status).toBe(400);

    const seen = await call(`/api/v1/upload/${id}`);
    expect(seen.body.files).toEqual([{ path: "Api Game.exe", size: 3_000_000, done: true }, { path: "data/big.pak", size: big.byteLength, done: true }, { path: "readme.txt", size: 5, done: true }]);
    expect((await call(`/api/v1/upload?gameId=${g.id}`)).body.items.map((u: { id: number }) => u.id)).toEqual([id]);
    // the same pick again: the same upload
    const same = await call(`/api/v1/game/${g.id}/upload`, json("POST", { name: "Api Game", files: 3, bytes: big.byteLength + small.byteLength + 3_000_000 }));
    expect([same.status, same.body.resumed, same.body.item.id]).toEqual([200, true, id]);

    const fin = await call(`/api/v1/upload/${id}/finish`, { method: "POST" });
    expect(fin.status).toBe(202);
    expect(fin.body.item).toMatchObject({ state: "importing", jobId: fin.body.job.id, job: { id: fin.body.job.id, kind: "import", state: "queued" }, expiresAt: null });
    await runJob(fin.body.job.id);
    await settled(id);
    expect((await call(`/api/v1/upload/${id}`)).status).toBe(404);
    expect((stmts.packageForGame.get(g.id) as PackageRow | undefined)?.name).toBe("Upload Api");
  });

  test("refusals carry what the page needs: a copy over a built way, an upload that is gone", async () => {
    const g = game("Upload Api Refusals");
    stmts.insertPackage.get(g.id, null, join(root, "upload-api-refusals-pkg"), g.name, null, 1, JSON.stringify({ schema: 1, files: [], kind: "port" }));
    const r = await call(`/api/v1/game/${g.id}/upload`, json("POST", { name: "x", files: 1, bytes: 1 }));
    expect([r.status, r.body.needsReplace]).toEqual([409, true]);
    expect((await call("/api/v1/upload/999999/finish", { method: "POST" })).status).toBe(404);
    expect((await call("/api/v1/upload/999999", { method: "DELETE" })).status).toBe(404);
    expect((await call("/api/v1/upload/999999/file?path=a&size=1&offset=0", { method: "PUT", body: bytes(1, 1) })).status).toBe(404);
  });
});
