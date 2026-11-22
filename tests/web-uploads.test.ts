/**
 * The admin UI's sender for a game uploaded from this PC (web/src/uploads.ts), held against the server's own module
 * (src/uploads.ts) with no HTTP in between:
 *  - what was picked becomes one upload: a folder by its name, one file by its own, loose files by the game's
 *  - every file arrives whole, in pieces, a few side by side, and the job is queued
 *  - a line that drops asks nothing of the admin: the piece is sent again, from where the server says the file ends
 *  - a pause keeps what arrived; the same pick again (another tab, another day) sends only what is missing
 *  - a refusal the server would repeat is not tried again
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { createUpload, finishUpload, getUpload, removeUpload, serializeUpload, udeps, UploadError, uploadFiles, uploadsOfGame, uploadsQuiet, whereFile, writePiece } from "../src/uploads";
import { ApiError, type JobView } from "../web/src/api";
import {
  consolesOf, continueUpload, forgetUpload, looksLikeConsoleData, pauseUpload, PIECE, shapePick, startUpload, subscribeUploads, timeLeft, uploadsBusy, uploadsNow,
  type Io, type Picked, type UploadState, type UploadView,
} from "../web/src/uploads";

const games: number[] = [];
const savedU = { ...udeps };
beforeAll(() => { ensureDefaultRootFolder(); udeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); });
afterAll(async () => {
  Object.assign(udeps, savedU);
  for (const id of games) { for (const u of uploadsOfGame(id)) await removeUpload(u.id).catch(() => {}); }
  await uploadsQuiet();
  for (const id of games) { db.query("DELETE FROM jobs WHERE game_id=?").run(id); db.query("DELETE FROM games WHERE id=?").run(id); }
});
let appid = 996_000;
function game(name: string): GameRow {
  const g = upsertGame({ steam_appid: ++appid, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
  games.push(g.id);
  return stmts.gameById.get(g.id) as GameRow;
}
const pattern = (n: number, seed: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff; return b; };
const pick = (files: Record<string, Uint8Array>, fallback = "The Game"): Picked =>
  shapePick(Object.entries(files).map(([path, b]) => ({ path, size: b.byteLength, file: new Blob([b as unknown as BlobPart]) })), fallback);

/** the server's module as the page reaches the API: a refusal is an ApiError with the server's status and extra fields */
const refused = (e: unknown) => (e instanceof UploadError ? new ApiError(e.message, e.status, { error: e.message, ...e.extra }) : e);
interface Wire {
  pieces: [string, number][]; before?: (path: string, offset: number, n: number) => Promise<void> | void; after?: (path: string, offset: number, n: number) => Promise<void> | void; create?: () => void; slept: number[]; asked?: string[];
  /** the line is down for this call (as a browser says it: a fetch that failed is a TypeError, not an answer) */
  down?: (call: "create" | "files" | "where" | "finish" | "finished") => boolean;
}
const offline = () => new TypeError("Failed to fetch");
function io(w: Wire): Io {
  return {
    create: async (gameId, body) => { if (w.down?.("create")) throw offline(); w.create?.(); try { const r = await createUpload(gameId, body); return { item: serializeUpload(r.row) as UploadView, resumed: r.resumed }; } catch (e) { throw refused(e); } },
    files: async id => { if (w.down?.("files")) throw offline(); const u = getUpload(id); if (!u) throw new ApiError("no such upload", 404); return { item: serializeUpload(u) as UploadView, files: await uploadFiles(u) }; },
    where: async (id, path) => { if (w.down?.("where")) throw offline(); (w.asked ??= []).push(path); try { return await whereFile(id, path); } catch (e) { throw refused(e); } },
    piece: async (id, path, size, offset, body, o) => {
      const n = w.pieces.push([path, offset]);
      await w.before?.(path, offset, n);
      if (o.signal.aborted) throw new ApiError("cancelled", 0);
      let r;
      try { r = await writePiece(id, { path, size, offset, body: body.stream() as unknown as AsyncIterable<Uint8Array> }); } catch (e) { throw refused(e); }
      o.onProgress(body.size);
      await w.after?.(path, offset, n);
      return { received: r.received, done: r.done };
    },
    finish: async id => {
      if (w.down?.("finish")) throw offline();
      let r;
      try { r = await finishUpload(id); } catch (e) { throw refused(e); }
      if (w.down?.("finished")) throw offline();                               // it got through; its answer did not
      return { item: serializeUpload(r.row) as UploadView, job: { id: r.job.id } as JobView };
    },
    remove: async id => removeUpload(id),
    sleep: async ms => { w.slept.push(ms); },
    now: () => Date.now(),
  };
}
/** every phase an upload of this tab went through, and its last state */
function follow(key: number) {
  const phases: string[] = [];
  let last: UploadState | null = null;
  const off = subscribeUploads(() => {
    const u = uploadsNow().find(x => x.key === key);
    if (!u) return;
    last = u;
    if (phases.at(-1) !== u.phase) phases.push(u.phase);
  });
  const until = async (phase: string) => {
    for (let i = 0; i < 1000; i++) { if (phases.includes(phase)) return last!; await Bun.sleep(5); }
    throw new Error(`never ${phase}: ${phases.join(" → ")} (${JSON.stringify(last)})`);
  };
  return { phases, until, off, get last() { return last; } };
}
const onServer = (id: number, path: string) => { const u = getUpload(id)!; return readFileSync(join(u.dir, u.name, ...path.split("/"))); };
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

describe("what was picked, as an upload", () => {
  test("a folder is named by itself, its files by their paths inside it", () => {
    const p = pick({ "My Game/bin/game.exe": pattern(10, 1), "My Game/data/a.pak": pattern(20, 2), "My Game/readme.txt": pattern(5, 3) });
    expect([p.name, p.bytes, p.files.map(f => f.path)]).toEqual(["My Game", 35, ["bin/game.exe", "data/a.pak", "readme.txt"]]);
    // a dropped folder's paths start with a slash, a Windows path uses backslashes
    const q = shapePick([{ path: "/My Game/a.bin", size: 1, file: new Blob(["a"]) }, { path: "My Game\\sub\\b.bin", size: 1, file: new Blob(["b"]) }], "x");
    expect([q.name, q.files.map(f => f.path)]).toEqual(["My Game", ["a.bin", "sub/b.bin"]]);
  });
  test("one file is named by itself; loose files, or a folder beside files, by the game", () => {
    expect(pick({ "Hades.v1.38.zip": pattern(9, 1) }).name).toBe("Hades.v1.38.zip");
    const loose = pick({ "setup.exe": pattern(3, 1), "setup-1.bin": pattern(4, 2) }, "Hades");
    expect([loose.name, loose.files.map(f => f.path)]).toEqual(["Hades", ["setup-1.bin", "setup.exe"]]);
    const mixed = pick({ "Crack/steam_api.dll": pattern(3, 1), "game.iso": pattern(4, 2) }, "Hades");
    expect([mixed.name, mixed.files.map(f => f.path)]).toEqual(["Hades", ["Crack/steam_api.dll", "game.iso"]]);
    // the same file picked twice is one file
    expect(shapePick([{ path: "a.zip", size: 1, file: new Blob(["a"]) }, { path: "a.zip", size: 1, file: new Blob(["a"]) }], "x").files).toHaveLength(1);
  });
  test("a console's game data is told from a PC game by its files", () => {
    expect(looksLikeConsoleData(pick({ "Zelda (USA).z64": pattern(4, 1) }))).toBe(true);
    expect(looksLikeConsoleData(pick({ "BLUS30490/PS3_GAME/USRDIR/EBOOT.BIN": pattern(4, 1), "BLUS30490/PS3_DISC.SFB": pattern(4, 1) }))).toBe(true);
    expect(looksLikeConsoleData(pick({ "Game/Game.exe": pattern(4, 1), "Game/data.pak": pattern(4, 1) }))).toBe(false);
    expect(looksLikeConsoleData(pick({ "Game.iso": pattern(4, 1) }))).toBe(false);          // a PC disc as well
    expect(looksLikeConsoleData(pick({ "Game.zip": pattern(4, 1) }))).toBe(false);
  });
  test("the consoles a pick names", () => {
    expect(consolesOf(pick({ "Zelda (USA).z64": pattern(4, 1) }))).toEqual(["n64"]);
    expect(consolesOf(pick({ "BLUS30490/PS3_GAME/USRDIR/EBOOT.BIN": pattern(4, 1), "BLUS30490/PS3_DISC.SFB": pattern(4, 1) }))).toEqual(["ps3"]);
    expect(consolesOf(pick({ "Game.iso": pattern(4, 1) }))).toEqual([]);
  });
  test("time left, in words", () => {
    expect(timeLeft(1000, 0, 0)).toBeNull();
    expect(timeLeft(1000, 1000, 10)).toBeNull();
    expect(timeLeft(1000, 500, 100)).toBe("under a minute left");
    expect(timeLeft(1_000_000, 0, 1000)).toBe("17 min left");
    expect(timeLeft(10_000_000, 0, 1000)).toBe("2 h 47 min left");
  });
});

describe("sending: every file whole on the server, then the job", () => {
  test("a folder with a file larger than one piece arrives byte for byte, and the import is queued", async () => {
    const g = game("Web Upload Whole");
    const big = pattern(PIECE + 1_500_000, 5);
    const files = { "Game/Game.exe": pattern(300_000, 1), "Game/data/big.pak": big, "Game/data/small.pak": pattern(70_000, 2), "Game/empty.cfg": new Uint8Array(0), "Game/readme.txt": pattern(12, 3) };
    const w: Wire = { pieces: [], slept: [] };
    const key = startUpload(io(w), g, pick(files));
    const f = follow(key);
    const end = await f.until("handed");
    f.off();
    expect(f.phases).toEqual(["starting", "sending", "finishing", "handed"].filter(p => f.phases.includes(p)));
    expect(end).toMatchObject({ gameId: g.id, name: "Game", files: 5, phase: "handed", sent: end.bytes, error: null, current: null, more: 0 });
    expect(uploadsNow().find(u => u.key === key)).toBeUndefined();          // the server shows it from here
    expect(uploadsBusy()).toBe(false);
    // the big file went in two pieces, in order
    expect(w.pieces.filter(p => p[0] === "data/big.pak")).toEqual([["data/big.pak", 0], ["data/big.pak", PIECE]]);
    const u = getUpload(end.uploadId!)!;
    expect(u).toMatchObject({ state: "importing", received: end.bytes, job_id: end.jobId });
    for (const [path, b] of Object.entries(files)) expect(same(onServer(u.id, path.slice(5)), b)).toBe(true);
    expect(stmts.jobById.get(end.jobId!) as JobRow).toMatchObject({ kind: "import", state: "queued", game_id: g.id });
    await removeUpload(u.id); await uploadsQuiet();
  });

  test("a line that drops: the piece is sent again, and one that did arrive is not sent twice", async () => {
    const g = game("Web Upload Drops");
    const a = pattern(400_000, 7), b = pattern(250_000, 8);
    const w: Wire = { pieces: [], slept: [] };
    let cut = 0, lost = 0;
    // a.bin: the line drops twice before the server sees anything
    w.before = path => { if (path === "a.bin" && cut++ < 2) throw new ApiError("the upload was cut off (is ludarr still running?)", 0); };
    // b.bin: its bytes arrive, the answer does not
    w.after = path => { if (path === "b.bin" && lost++ < 1) throw new ApiError("the upload was cut off (is ludarr still running?)", 0); };
    const key = startUpload(io(w), g, pick({ "a.bin": a, "b.bin": b }));
    const f = follow(key);
    const end = await f.until("handed");
    f.off();
    expect(w.slept).toEqual(expect.arrayContaining([1000, 2000]));               // waited, a little longer each time
    // b.bin: sent once; after the line dropped the sender asks where the file ends, hears it is whole, and sends nothing again
    expect(w.pieces.filter(p => p[0] === "b.bin")).toEqual([["b.bin", 0]]);
    expect(w.asked).toEqual(expect.arrayContaining(["a.bin", "b.bin"]));
    expect(same(onServer(end.uploadId!, "a.bin"), a)).toBe(true);
    expect(same(onServer(end.uploadId!, "b.bin"), b)).toBe(true);
    expect(getUpload(end.uploadId!)!.state).toBe("importing");
    await removeUpload(end.uploadId!); await uploadsQuiet();
  });

  test("a pause keeps what arrived, and Continue sends the rest", async () => {
    const g = game("Web Upload Pause");
    const files = { "a.bin": pattern(100_000, 1), "b.bin": pattern(100_000, 2), "c.bin": pattern(100_000, 3), "d.bin": pattern(100_000, 4), "e.bin": pattern(100_000, 5), "f.bin": pattern(100_000, 6) };
    const w: Wire = { pieces: [], slept: [] };
    let key = 0;
    // once three files are there, the admin pauses
    w.after = (_p, _o, n) => { if (n === 3) pauseUpload(key); };
    key = startUpload(io(w), g, pick(files, "Paused Game"));
    const f = follow(key);
    const paused = await f.until("paused");
    expect(paused.uploadId).not.toBeNull();
    await Bun.sleep(30);                                                          // nothing goes on being sent
    const there = await uploadFiles(getUpload(paused.uploadId!)!);
    expect(there.filter(x => x.done).length).toBeGreaterThanOrEqual(3);
    expect(there.filter(x => x.done).length).toBeLessThan(6);
    expect(getUpload(paused.uploadId!)!.state).toBe("uploading");
    const sentBefore = w.pieces.length;
    w.after = undefined;
    continueUpload(key);
    const end = await f.until("handed");
    f.off();
    // only what was missing went up again
    expect(w.pieces.length - sentBefore).toBe(6 - there.filter(x => x.done).length);
    for (const [path, b] of Object.entries(files)) expect(same(onServer(end.uploadId!, path), b)).toBe(true);
    await removeUpload(end.uploadId!); await uploadsQuiet();
  });

  test("the same pick again, from a tab that knows nothing: the same upload, and only what is missing is sent", async () => {
    const g = game("Web Upload Again");
    const files = { "Again/one.bin": pattern(200_000, 1), "Again/two.bin": pattern(200_000, 2), "Again/three.bin": pattern(200_000, 3) };
    const first: Wire = { pieces: [], slept: [] };
    let key = 0;
    first.after = (_p, _o, n) => { if (n === 1) pauseUpload(key); };
    key = startUpload(io(first), g, pick(files));
    const f1 = follow(key);
    const paused = await f1.until("paused");
    f1.off();
    forgetUpload(key);                                                            // the tab is closed
    expect(uploadsNow().find(u => u.key === key)).toBeUndefined();
    const before = (await uploadFiles(getUpload(paused.uploadId!)!)).filter(x => x.done).map(x => x.path);
    expect(before.length).toBeGreaterThanOrEqual(1);

    const second: Wire = { pieces: [], slept: [] };
    const key2 = startUpload(io(second), g, pick(files));
    const f2 = follow(key2);
    const end = await f2.until("handed");
    f2.off();
    expect(end.uploadId).toBe(paused.uploadId);
    for (const p of before) expect(second.pieces.some(x => x[0] === p)).toBe(false);
    for (const [path, b] of Object.entries(files)) expect(same(onServer(end.uploadId!, path.slice(6)), b)).toBe(true);
    await removeUpload(end.uploadId!); await uploadsQuiet();
  });

  test("the line is down for every call for a while — the start, the look, the pieces, the question, the hand-over: it goes on by itself", async () => {
    const g = game("Web Upload Line Down");
    const files = { "a.bin": pattern(60_000, 1), "b.bin": pattern(40_000, 2) };
    const w: Wire = { pieces: [], slept: [] };
    const left: Record<string, number> = { create: 2, files: 2, where: 2, finish: 1, finished: 1 };
    w.down = call => (left[call] ?? 0) > 0 && left[call]-- > 0;
    let cut = 0;
    w.before = () => { if (cut++ < 2) throw offline(); };
    const key = startUpload(io(w), g, pick(files, "Line Down"));
    const f = follow(key);
    const end = await f.until("handed");
    f.off();
    expect(f.phases).not.toContain("failed");
    expect(Object.values(left)).toEqual([0, 0, 0, 0, 0]);                      // every one of them was down, and waited out
    // the hand-over got through once, its answer was lost, and asking again found it handed over: the same job
    const u = getUpload(end.uploadId!)!;
    expect(u).toMatchObject({ state: "importing", job_id: end.jobId });
    expect((db.query("SELECT COUNT(*) AS n FROM jobs WHERE game_id=?").get(g.id) as { n: number }).n).toBe(1);
    for (const [path, b] of Object.entries(files)) expect(same(onServer(u.id, path), b)).toBe(true);
    await removeUpload(u.id); await uploadsQuiet();
  });

  test("a file an earlier piece has not let go of yet is waited for, not given up on", async () => {
    const g = game("Web Upload Busy");
    const a = pattern(50_000, 4);
    const w: Wire = { pieces: [], slept: [] };
    let busy = 0;
    w.before = () => { if (busy++ < 2) throw new ApiError("a.bin is still being written by an earlier request: try again in a moment", 409, { busy: true }); };
    const key = startUpload(io(w), g, pick({ "a.bin": a }));
    const f = follow(key);
    const end = await f.until("handed");
    f.off();
    expect(w.slept.length).toBe(2);
    expect(same(onServer(end.uploadId!, "a.bin"), a)).toBe(true);
    await removeUpload(end.uploadId!); await uploadsQuiet();
  });

  test("each file has its own tries: three files sent side by side do not share one budget", async () => {
    const g = game("Web Upload Budget");
    const files = { "a.bin": pattern(1000, 1), "b.bin": pattern(1000, 2), "c.bin": pattern(1000, 3) };
    const w: Wire = { pieces: [], slept: [] };
    const failed = new Map<string, number>();
    // the server is away for 15 tries of every file: 45 failures in all, more than any one file may have
    w.before = path => { const n = (failed.get(path) ?? 0) + 1; failed.set(path, n); if (n <= 15) throw new ApiError("the upload was cut off (is ludarr still running?)", 0); };
    const key = startUpload(io(w), g, pick(files, "Budget"));
    const f = follow(key);
    const end = await f.until("handed");
    f.off();
    expect(w.slept.length).toBe(45);
    for (const [path, b] of Object.entries(files)) expect(same(onServer(end.uploadId!, path), b)).toBe(true);
    await removeUpload(end.uploadId!); await uploadsQuiet();
  });

  test("a refusal the server would repeat stops the upload with its words, and is not tried again", async () => {
    const g = game("Web Upload Refused");
    udeps.diskSpace = async () => ({ free: 1e9, total: 1e12 });
    udeps.keepFree = () => 50e9;
    const w: Wire = { pieces: [], slept: [] };
    let creates = 0;
    w.create = () => { creates++; };
    try {
      const key = startUpload(io(w), g, pick({ "big.zip": pattern(1000, 1) }));
      const f = follow(key);
      const end = await f.until("failed");
      f.off();
      expect(end.error).toMatch(/^the library has 1\.0 GB free: this upload is 1 KB, and ludarr keeps 50 GB free there/);
      expect([creates, w.pieces.length, w.slept.length]).toEqual([1, 0, 0]);
      forgetUpload(key);
    } finally { udeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); udeps.keepFree = savedU.keepFree; }

    // an upload removed on the server while it is being sent: the next piece is refused for good
    const h = game("Web Upload Gone");
    const w2: Wire = { pieces: [], slept: [] };
    let key2 = 0;
    w2.after = async (_p, _o, n) => { if (n === 1) { const u = uploadsNow().find(x => x.key === key2)!; await removeUpload(u.uploadId!); } };
    key2 = startUpload(io(w2), h, pick({ "a.bin": pattern(10, 1), "b.bin": pattern(10, 2), "c.bin": pattern(10, 3), "d.bin": pattern(10, 4), "e.bin": pattern(10, 5) }, "Gone"));
    const f2 = follow(key2);
    const end2 = await f2.until("failed");
    f2.off();
    expect(["no such upload", "this upload was removed"]).toContain(end2.error!);
    expect(w2.slept).toEqual([]);
    forgetUpload(key2);
    await uploadsQuiet();
  });
});
