/**
 * The content store keeps what it is given safe (src/ways/content.ts; DESIGN3 B2.4, AMEND H5, SEAMS "the inbox" and
 * "progress"): a file or folder moved in (an inbox entry, a made product) goes straight into its store folder and is never
 * left in .incoming, where another intake's sweep could lose it; the sweep removes only what is ours and older than a day
 * by the time its name says it was put there (a link keeps its original's old mtime); what comes in by a link or a move
 * loses world-write, so no build program's user can change a kept game file; an entry is attached only to the ways whose
 * own judging took it; an inbox job takes only an entry inside a game's inbox folder; and every long step says its bytes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, upsertGame, type GameRow, type RootFolderRow } from "../src/db";
import { jobKinds } from "../src/process/kinds";
import { ContentError, ctdeps, gameTarget, ingestFile, ingestMade, ingestTree, ingestUpload, intakeEntry, STORE } from "../src/ways/content";
import { EnvError } from "../src/ways/errors";
import { getWay, insertPlan, insertWay } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";

const real = { ...ctdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-safety-"));
const lib = join(tmp, "library"); mkdirSync(lib, { recursive: true });
const libReal = realpathSync(lib);
const root: RootFolderRow = { id: 998_000, path: lib, name: null, created_at: 0 };
const made = { games: [] as number[], plans: [] as number[] };
const reset = () => Object.assign(ctdeps, real, { rootFolders: () => [root], diskSpace: async () => ({ free: 1e15, total: 2e15 }) });
beforeAll(reset);
afterEach(reset);
afterAll(() => {
  Object.assign(ctdeps, real);
  for (const id of made.games) db.query("DELETE FROM contents WHERE game_id=?").run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function game(name: string, platforms = ["ps5"]): GameRow {
  const g = upsertGame({ name, slug: `safety-${++seq}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function bytes(n: number, seed: number) { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; }
const incomingDir = join(libReal, STORE, ".incoming");
const incoming = () => (existsSync(incomingDir) ? readdirSync(incomingDir) : []);
const inboxOf = (g: GameRow) => { const d = join(libReal, ".ahoy-inbox", g.slug!); mkdirSync(d, { recursive: true }); return d; };
const DAYS = 86_400_000;
const old = (p: string, days = 3) => { const t = new Date(Date.now() - days * DAYS); utimesSync(p, t, t); };
function app0(at: string, seed = 1) {
  const files: Record<string, Uint8Array> = { "sce_sys/param.json": new TextEncoder().encode(`{"titleId":"PPSA01341","s":${seed}}`), "eboot.bin": bytes(2048, seed), "data/a.bin": bytes(300_000, seed + 1), "data/b.bin": bytes(200_000, seed + 2) };
  for (const [rel, b] of Object.entries(files)) { mkdirSync(join(at, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(at, ...rel.split("/")), b); }
  return files;
}
function plan(name: string, c: ContentPlan) {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^Sf-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: c, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name, kind: "emulator", repo: `safety/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
}
const folderWay = (o: Partial<ContentPlan> = {}): ContentPlan => ({ kind: "folder", platform: "ps5", what: "the PS5 game folder", search: ["x"], accept: { hashes: [] }, marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game", ...o });
const run = (spec: Record<string, unknown>, messages: { p: number; m: string }[] = []) => jobKinds.get("content")!.run({
  job: {} as never, spec: { kind: "content", ...spec } as never, work: tmp, staging: tmp, log: () => {}, progress: (p, m) => { if (m) messages.push({ p, m }); }, signal: new AbortController().signal,
});

describe("nothing in flight is swept, and nothing moved in waits in .incoming", () => {
  test("a PKG selected on the server is retained as recipe input when the folder plan declares its extractor", async () => {
    const g = game("Safety PKG", ["ps4"]);
    const c: ContentPlan = { kind: "folder", platform: "ps4", what: "P.T. folder", search: ["P.T."], accept: { hashes: [], serials: ["CUSA01127"] }, marker: "chunk1.psarc", place: "game",
      make: { input: { shape: "file", platform: "ps4", formats: ["pkg"] }, steps: [{ run: { exe: "extractor/PT.PkgExtract.exe", argv: ["{in}", "{out}"], wine: true, timeoutSec: 3600 } }], output: { shape: "folder", name: "game" } } };
    const w = insertWay({ gameId: g.id, planId: plan("Safety PKG Port", c).id, content: c });
    const path = join(inboxOf(g), "PT.pkg"); writeFileSync(path, bytes(4096, 11));
    const result = await intakeEntry(path, g, { source: "path", move: false, wayId: w.id });
    expect(result.inputFor).toEqual([w.id]);
    expect(result.attached).toEqual([]);
    expect(result.row).toMatchObject({ name: "PT.pkg", role: "game" });
    expect(existsSync(path)).toBe(true);
  });
  test("the sweep removes only what is ours and a day old by the time its name says: never a fresh link with its original's old mtime, never a folder that is not a tree of ours", async () => {
    const g = game("Safety Sweep");
    mkdirSync(incomingDir, { recursive: true });
    const plant = (name: string, dir = false) => { const p = join(incomingDir, name); if (dir) { mkdirSync(join(p, "x"), { recursive: true }); writeFileSync(join(p, "x", "f"), "f"); } else writeFileSync(p, "x"); old(p); return name; };
    const freshLink = plant(`link-${Date.now()}-a`);                        // being hashed by another intake right now
    const staleLink = plant(`link-${Date.now() - 2 * DAYS}-b`);
    const staleUpload = plant(crypto.randomUUID());                         // an upload cut off two days ago
    const staleTree = plant(`tree-${Date.now() - 2 * DAYS}-c`, true);
    const freshTree = plant(`tree-${Date.now()}-d`, true);
    const strange = plant(`someone-elses-${crypto.randomUUID()}`, true);    // not a tree of ours: never removed
    await ingestUpload(new Response(bytes(1000, 1)).body, gameTarget(g.id), { name: "x.iso" });   // any intake sweeps first
    expect(incoming().sort()).toEqual([freshLink, freshTree, strange].sort());
    expect([staleLink, staleUpload, staleTree].some(n => incoming().includes(n))).toBe(false);
    for (const n of incoming()) rmSync(join(incomingDir, n), { recursive: true, force: true });
  });

  test("a moved file (an inbox entry with an old mtime) is read where it lies and renamed straight into its store folder: while it is read it is still where the admin put it, and .incoming never holds it", async () => {
    const g = game("Safety Move", ["ps2"]);
    const box = inboxOf(g), entry = join(box, "Game (USA).iso");
    const data = bytes(3 * 2 ** 20, 2);
    writeFileSync(entry, data); old(entry);
    let t = 0; ctdeps.now = () => (t += 1500);
    const during: { atSource: boolean; incoming: string[] }[] = [];
    const r = await ingestFile(entry, gameTarget(g.id), { source: "inbox", mode: "move", progress: () => during.push({ atSource: existsSync(entry), incoming: incoming() }) });
    expect(during.length).toBeGreaterThan(1);
    expect(during.every(d => d.atSource && d.incoming.length === 0)).toBe(true);
    expect(existsSync(entry)).toBe(false);
    expect(readFileSync(r.row.path).equals(Buffer.from(data))).toBe(true);
    expect(r).toMatchObject({ linked: true, duplicate: false, row: { source: "inbox" } });
  });

  test("a moved folder goes in by one rename (never through .incoming); a folder linked in waits there only under a dated name", async () => {
    const g = game("Safety Move Folder");
    const box = inboxOf(g), entry = join(box, "PPSA01341-app0");
    app0(entry, 3);
    const seen: string[][] = [];
    const r = await ingestTree(entry, gameTarget(g.id), { mode: "move", hash: true, source: "inbox", progress: () => seen.push(incoming()) });
    expect(seen.flat()).toEqual([]);
    expect(existsSync(entry)).toBe(false);
    expect(existsSync(join(r.row.path, "eboot.bin"))).toBe(true);
    // linked in (a folder picked on the server): its links are built under a name that says when, then placed
    const src = join(libReal, "picked", "PPSA01341-app0"); app0(src, 4);
    const names: string[] = [];
    await ingestTree(src, gameTarget(g.id), { mode: "link", hash: true, source: "path", progress: (_b, _t, step) => { if (step === "linking") names.push(...incoming()); } });
    expect(names.length).toBeGreaterThan(0);
    expect(names.every(n => /^tree-\d{13}-/.test(n))).toBe(true);
    expect(incoming()).toEqual([]);
  });

  test("an archive set moved in: every volume goes straight into <stem>.parts in the store, and nothing waits in .incoming", async () => {
    const g = game("Safety Set");
    const zar: ContentPlan = { kind: "disc", platform: "ps5", what: "a .zar", search: ["x"], accept: { hashes: [], formats: ["zar"] }, place: "g/{name}",
      make: { input: { shape: "either", platform: "ps5", formats: ["rar"], marker: "sce_sys/param.json" }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { shape: "file", name: "{serial}.zar" } } };
    insertWay({ gameId: g.id, planId: plan("Safety Set Kyty", zar).id, content: zar });
    ctdeps.inputMatches = () => ({ ok: true, why: null });
    const box = inboxOf(g);
    ["DS.part1.rar", "DS.part2.rar"].forEach((n, i) => { writeFileSync(join(box, n), bytes(400_000, 10 + i)); old(join(box, n)); });
    const during: string[][] = [];
    const r = await intakeEntry(join(box, "DS.part1.rar"), g, { source: "inbox", move: true, progress: () => during.push(incoming()) });
    expect(r.row).toMatchObject({ name: "DS.part1.rar", size: 800_000 });
    expect(during.flat()).toEqual([]);
    expect(incoming()).toEqual([]);
    expect(readdirSync(join(r.row!.path, "..")).sort()).toEqual(["DS.part1.rar", "DS.part2.rar"]);
    expect(readdirSync(box)).toEqual([]);
  });
});

describe("what comes in by a link or a move is ludarr's own", () => {
  test("world-write goes from a moved folder's folders and files and from a linked file; a copy is written without it", async () => {
    const g = game("Safety Modes", ["ps2"]);
    const calls: [string, number][] = [];
    ctdeps.chmod = async (p, mode) => { calls.push([realpathSync(p), mode]); };
    // an SMB share writes the entry 0777 / 0666
    const box = inboxOf(g), entry = join(box, "PPSA01341-app0");
    app0(entry, 5);
    for (const p of [entry, join(entry, "sce_sys"), join(entry, "data")]) chmodSync(p, 0o777);
    for (const p of ["sce_sys/param.json", "eboot.bin", "data/a.bin", "data/b.bin"]) chmodSync(join(entry, ...p.split("/")), 0o666);
    const r = await ingestTree(entry, gameTarget(g.id), { mode: "move", hash: false, source: "inbox" });
    const kept = new Map(calls);
    for (const rel of ["", "sce_sys", "data", "sce_sys/param.json", "eboot.bin", "data/a.bin", "data/b.bin"]) {
      const p = rel ? join(r.row.path, ...rel.split("/")) : r.row.path;
      expect(kept.has(p)).toBe(true);
      expect(kept.get(p)! & 0o002).toBe(0);
    }
    // a file linked in from the downloads folder (a client writes 0666)
    calls.length = 0;
    const dl = join(libReal, "dl"); mkdirSync(dl, { recursive: true });
    writeFileSync(join(dl, "Disc.iso"), bytes(5000, 6)); chmodSync(join(dl, "Disc.iso"), 0o666);
    const linked = await ingestFile(join(dl, "Disc.iso"), gameTarget(g.id), { source: "path", mode: "link" });
    expect(calls.map(c => c[0])).toEqual([realpathSync(linked.row.path)]);
    expect(calls[0][1] & 0o002).toBe(0);
    // across volumes it is copied: written by ludarr, nothing to take away
    calls.length = 0;
    ctdeps.link = async () => { const e = new Error("x") as Error & { code: string }; e.code = "EXDEV"; throw e; };
    writeFileSync(join(dl, "Other.iso"), bytes(5000, 7)); chmodSync(join(dl, "Other.iso"), 0o666);
    expect((await ingestFile(join(dl, "Other.iso"), gameTarget(g.id), { source: "path", mode: "link" })).linked).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("a make's product is kept only once it is ludarr's", () => {
  test("a product (a file or a folder) still owned by a build program's user is refused, and stays where the make left it", async () => {
    const g = game("Safety Made Owner");
    const out = join(tmp, "work-made", "out"); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "PPSA01341.zar"), bytes(4096, 40));
    const folder = join(out, "game"); app0(folder, 41);
    const uid = lstatSync(join(out, "PPSA01341.zar")).uid;
    ctdeps.sandboxUids = () => [uid];                                       // on this box every file's owner is "the build user"
    const made = { from: { kind: "copy" as const, packageId: 1, digest: "d".repeat(64) }, recipe: "{}", tools: [], key: "k-owner", at: 1 };
    await expect(ingestMade(join(out, "PPSA01341.zar"), gameTarget(g.id), { made })).rejects.toThrow("PPSA01341.zar is still a build program's user's: it is handed back to ludarr before it is kept");
    await expect(ingestMade(folder, gameTarget(g.id), { made })).rejects.toThrow(/is still a build program's user's/);
    expect(existsSync(join(out, "PPSA01341.zar"))).toBe(true);
    expect(existsSync(join(folder, "eboot.bin"))).toBe(true);
    ctdeps.sandboxUids = () => [];
    expect((await ingestMade(join(out, "PPSA01341.zar"), gameTarget(g.id), { made })).row).toMatchObject({ source: "made" });
  });
});

describe("an entry judged for each way is attached only where that way's judging took it", () => {
  test("a way whose whole-game check, or whose marker files, turn the folder down never gets it because another way took it", async () => {
    const g = game("Safety Only");
    const whole = insertWay({ gameId: g.id, planId: plan("Safety Whole Game", folderWay({ complete: { minFiles: 1000 } })).id, content: folderWay({ complete: { minFiles: 1000 } }) });
    const trophy = insertWay({ gameId: g.id, planId: plan("Safety Trophy", folderWay({ also: ["eboot.bin", "sce_sys/trophy.dat"] })).id, content: folderWay({ also: ["eboot.bin", "sce_sys/trophy.dat"] }) });
    const plain = insertWay({ gameId: g.id, planId: plan("Safety Plain", folderWay()).id, content: folderWay() });
    ctdeps.completeness = async (_dir, c) => (c.minFiles === 1000 ? { ok: false, why: "an update or a part of the game, not the whole game" } : { ok: true, why: null });
    const src = join(libReal, "only", "PPSA01341-app0"); app0(src, 7);
    const r = await intakeEntry(src, g, { source: "path", move: false });
    expect(r.attached).toEqual([plain.id]);
    expect(getWay(whole.id)!.content_id).toBeNull();
    expect(getWay(trophy.id)!.content_id).toBeNull();
    expect(r.notes.sort()).toEqual(["Safety Trophy: a folder without sce_sys/trophy.dat", "Safety Whole Game: an update or a part of the game, not the whole game"]);
  });
});

describe("the inbox job", () => {
  test("only an entry inside a game's inbox folder is taken: never the inbox, nor a game's whole inbox folder", async () => {
    const g = game("Safety Inbox Depth");
    const box = inboxOf(g);
    app0(join(box, "PPSA01341-app0"), 8);
    for (const p of [box, join(libReal, ".ahoy-inbox")]) {
      const e = await run({ gameId: g.id, path: p, inbox: true }).catch(x => x);
      expect(e).toBeInstanceOf(ContentError);
      expect((e as ContentError).message).toBe("not an entry of a game's inbox folder");
    }
    expect(existsSync(join(box, "PPSA01341-app0", "eboot.bin"))).toBe(true);
  });
});

describe("every long step says its bytes", () => {
  test("a folder picked on the server: read, then linked in, each step said with bytes of the whole as it goes; the job's progress never goes back", async () => {
    const g = game("Safety Steps");
    insertWay({ gameId: g.id, planId: plan("Safety Steps Way", folderWay()).id, content: folderWay() });
    const src = join(libReal, "steps", "PPSA01341-app0");
    app0(src, 9);
    for (let i = 0; i < 40; i++) writeFileSync(join(src, "data", `x${i}.bin`), bytes(20_000, 100 + i));
    let t = 0; ctdeps.now = () => (t += 1500);
    const messages: { p: number; m: string }[] = [];
    const r = await run({ gameId: g.id, path: src }, messages);
    expect(r.message).toBe("kept PPSA01341-app0, the game file of 1 way");
    const hashing = messages.filter(x => x.m.startsWith("hashing PPSA01341-app0 · ")), linking = messages.filter(x => x.m.startsWith("linking PPSA01341-app0 · "));
    expect(hashing.length).toBeGreaterThan(3);
    expect(linking.length).toBeGreaterThan(3);
    expect(messages.findIndex(x => x.m.startsWith("linking"))).toBeGreaterThan(messages.findIndex(x => x.m.startsWith("hashing")));
    expect(linking.at(-1)!.m).toBe(hashing.at(-1)!.m.replace("hashing", "linking"));          // both end at the whole
    expect(messages.every((x, i) => i === 0 || x.p >= messages[i - 1].p)).toBe(true);
  });

  test("an archive set on another volume: its volumes copied with progress, once the room for all of them is checked", async () => {
    const g = game("Safety Set Copy");
    const zar: ContentPlan = { kind: "disc", platform: "ps5", what: "a .zar", search: ["x"], accept: { hashes: [], formats: ["zar"] }, place: "g/{name}",
      make: { input: { shape: "file", platform: "ps5", formats: ["rar"] }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { shape: "file", name: "{serial}.zar" } } };
    insertWay({ gameId: g.id, planId: plan("Safety Set Copy Kyty", zar).id, content: zar });
    ctdeps.inputMatches = () => ({ ok: true, why: null });
    ctdeps.link = async () => { const e = new Error("x") as Error & { code: string }; e.code = "EXDEV"; throw e; };
    const dir = join(libReal, "elsewhere-set"); mkdirSync(dir, { recursive: true });
    ["Big.part1.rar", "Big.part2.rar", "Big.part3.rar"].forEach((n, i) => writeFileSync(join(dir, n), bytes(2 * 2 ** 20, 20 + i)));
    // not room for all three on the library besides what it keeps free: refused before a byte is copied
    ctdeps.keepFree = () => 0;
    ctdeps.diskSpace = async () => ({ free: 5 * 2 ** 20, total: 1e12 });
    const room = await intakeEntry(join(dir, "Big.part1.rar"), g, { source: "path", move: false }).catch(x => x);
    expect(room).toBeInstanceOf(EnvError);
    expect((room as EnvError).kind).toBe("room");
    expect(incoming()).toEqual([]);
    ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
    let t = 0; ctdeps.now = () => (t += 1500);
    const steps: { b: number; total: number; step?: string }[] = [];
    const r = await intakeEntry(join(dir, "Big.part1.rar"), g, { source: "path", move: false, progress: (b, total, step) => steps.push({ b, total, step }) });
    expect(r.row).toMatchObject({ size: 6 * 2 ** 20 });
    const copying = steps.filter(s => s.step === "copying");
    expect(copying.length).toBeGreaterThan(3);
    expect(copying.at(-1)).toMatchObject({ b: 6 * 2 ** 20, total: 6 * 2 ** 20 });
    expect(readdirSync(dir).sort()).toEqual(["Big.part1.rar", "Big.part2.rar", "Big.part3.rar"]);   // linked in or copied: never moved
  });
});
