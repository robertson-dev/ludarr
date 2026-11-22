/**
 * Content model v2 intake (src/ways/content.ts; DESIGN3 B2.4, SEAMS "the inbox"): a game folder kept as one row named by its
 * canonical listing (linked, moved or copied in; links refused; a duplicate dropped before anything is written), a made
 * file moved in and hashed once, an entry judged for each way (the way's file, what its make takes, or neither with the
 * reason), an archive set kept whole, and the inbox's content job (a build program's files refused, a note left beside an
 * entry nobody takes).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, upsertGame, type GameRow, type RootFolderRow } from "../src/db";
import { jobKinds } from "../src/process/kinds";
import { archiveSet, ContentError, ctdeps, ingestMade, ingestTree, intakeEntry, removeContent, STORE } from "../src/ways/content";
import { EnvError } from "../src/ways/errors";
import { listingDigest } from "../src/ways/hash";
import { contentMade, getContent, getWay, insertPlan, insertWay } from "../src/ways/store";
import type { ContentPlan, IntakeManifest, MadeInfo, RuntimePlanSpec } from "../src/ways/types";

const real = { ...ctdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-tree-"));
const lib = join(tmp, "library"); mkdirSync(lib, { recursive: true });
const libReal = realpathSync(lib);
const root: RootFolderRow = { id: 996_000, path: lib, name: null, created_at: 0 };
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
  const g = upsertGame({ name, slug: `tree-${++seq}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function bytes(n: number, seed: number) { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; }
const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
/** an app0 folder as a PS5 dump tool leaves it */
function app0(at: string, seed = 1): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = { "sce_sys/param.json": new TextEncoder().encode(`{"titleId":"PPSA01341","seed":${seed}}`), "eboot.bin": bytes(2048, seed), "data/level1.bin": bytes(8192, seed + 1), "data/level2.bin": bytes(4096, seed + 2) };
  for (const [rel, b] of Object.entries(files)) { mkdirSync(join(at, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(at, ...rel.split("/")), b); }
  return files;
}
const storeOf = (g: GameRow) => join(libReal, STORE, g.slug!);
const incoming = () => (existsSync(join(libReal, STORE, ".incoming")) ? readdirSync(join(libReal, STORE, ".incoming")) : []);
const rowsOf = (g: GameRow) => db.query("SELECT * FROM contents WHERE game_id=? ORDER BY id").all(g.id) as { id: number; shape: string; source: string; path: string; name: string; size: number; hashes_json: string }[];
const plan = (name: string, c: ContentPlan) => {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^T-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: c, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name, kind: "emulator", repo: `tree/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
};
const folderWay = (): ContentPlan => ({ kind: "folder", platform: "ps5", what: "the PS5 game folder", search: ["x"], accept: { hashes: [] }, marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game" });
const zarWay = (): ContentPlan => ({ kind: "disc", platform: "ps5", what: "a .zar", search: ["x"], accept: { hashes: [], formats: ["zar"] }, place: "games/{name}",
  make: { input: { shape: "either", platform: "ps5", formats: ["rar", "7z", "zip"], marker: "sce_sys/param.json", also: ["eboot.bin"] }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { shape: "file", name: "{serial}.zar" } } });

describe("a game folder kept as one row", () => {
  test("linked in: no bytes written, every file hashed once, named by its canonical listing, the listing kept beside it", async () => {
    const g = game("Tree Link");
    const src = join(tmp, "src-link", "PPSA01341-app0");
    const files = app0(src);
    const seen: number[] = [];
    const r = await ingestTree(src, { role: "game", game: g }, { mode: "link", hash: true, source: "path", progress: b => seen.push(b) });
    expect(r).toMatchObject({ duplicate: false, linked: true, row: { shape: "folder", name: "PPSA01341-app0", source: "path", size: Object.values(files).reduce((n, b) => n + b.length, 0), stat_json: null } });
    const listing = listingDigest(Object.entries(files).map(([rel, b]) => ({ rel, size: b.length, tag: sha256(b) })));
    expect(JSON.parse(r.row.hashes_json)).toEqual(listing.hashes);
    expect(readFileSync(`${r.row.path}.tree.tsv`, "utf8")).toBe(listing.text);
    expect(listing.text.split("\n")[0]).toBe(`data/level1.bin\t8192\t${sha256(files["data/level1.bin"])}`);
    // the store's files are the originals' own (hard links), and the originals stay where they are
    expect(lstatSync(join(r.row.path, "eboot.bin")).ino).toBe(lstatSync(join(src, "eboot.bin")).ino);
    expect(existsSync(join(src, "sce_sys", "param.json"))).toBe(true);
    expect(seen.at(-1)).toBe(r.row.size);
    expect(incoming()).toEqual([]);
  });

  test("the same folder again: dropped before anything is written (.incoming stays empty); a moved duplicate is consumed", async () => {
    const g = game("Tree Twice");
    const a = join(tmp, "src-twice-a", "app0"), b = join(tmp, "src-twice-b", "app0");
    app0(a, 7); app0(b, 7);
    const first = await ingestTree(a, { role: "game", game: g }, { mode: "link", hash: true });
    const again = await ingestTree(b, { role: "game", game: g }, { mode: "move", hash: true });
    expect(again).toMatchObject({ duplicate: true, row: { id: first.row.id } });
    expect(incoming()).toEqual([]);
    expect(readdirSync(storeOf(g)).sort()).toEqual(["app0", "app0.tree.tsv"]);
    expect(existsSync(b)).toBe(false);
  });

  test("moved in (an inbox entry): one rename, the entry gone from where it was; an input folder is named by its sizes and times, never read", async () => {
    const g = game("Tree Move");
    const src = join(tmp, "src-move", "PPSA01341-app0");
    const files = app0(src, 3);
    const r = await ingestTree(src, { role: "game", game: g }, { mode: "move", hash: false, source: "inbox" });
    expect(r.row).toMatchObject({ shape: "folder", source: "inbox" });
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(join(r.row.path, "eboot.bin")).equals(Buffer.from(files["eboot.bin"]))).toBe(true);
    // sizes and times, not contents: no file was read through to name it
    expect(readFileSync(`${r.row.path}.tree.tsv`, "utf8")).toMatch(/^data\/level1\.bin\t8192\t\d+\n/);
  });

  test("links, paths a player's PC cannot hold, and an empty folder are refused; across volumes it is copied and room is checked first", async () => {
    const g = game("Tree Refused");
    const linked = join(tmp, "src-linked"); mkdirSync(linked, { recursive: true }); writeFileSync(join(linked, "a.bin"), "x");
    let made = false;
    try { symlinkSync(join(linked, "a.bin"), join(linked, "b.bin")); made = true; } catch { /* no links on this box */ }
    if (made) await expect(ingestTree(linked, { role: "game", game: g }, { mode: "link", hash: true })).rejects.toThrow("the folder holds a link (b.bin)");
    const empty = join(tmp, "src-empty"); mkdirSync(empty, { recursive: true });
    await expect(ingestTree(empty, { role: "game", game: g }, { mode: "link", hash: true })).rejects.toThrow("is an empty folder");
    // a share without hard links: copied, after the free space is checked
    const src = join(tmp, "src-copy", "app0"); app0(src, 9);
    ctdeps.link = async () => { const e = new Error("x") as Error & { code: string }; e.code = "EXDEV"; throw e; };
    ctdeps.diskSpace = async () => ({ free: 1000, total: 1e12 });
    const room = await ingestTree(src, { role: "game", game: g }, { mode: "link", hash: true }).catch(e => e);
    expect(room).toBeInstanceOf(EnvError);
    expect((room as EnvError).kind).toBe("room");
    ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
    const r = await ingestTree(src, { role: "game", game: g }, { mode: "link", hash: true });
    expect(r.linked).toBe(false);
    expect(lstatSync(join(r.row.path, "eboot.bin")).ino).not.toBe(lstatSync(join(src, "eboot.bin")).ino);
    expect(incoming()).toEqual([]);
  });

  test("removed: the tree and its listing go (inside the store only)", async () => {
    const g = game("Tree Remove");
    const src = join(tmp, "src-rm", "app0"); app0(src, 11);
    const r = await ingestTree(src, { role: "game", game: g }, { mode: "link", hash: true });
    await removeContent(r.row.id);
    expect(existsSync(r.row.path)).toBe(false);
    expect(existsSync(`${r.row.path}.tree.tsv`)).toBe(false);
    expect(existsSync(join(src, "eboot.bin"))).toBe(true);                   // the original was never the store's to remove
  });
});

describe("what a make produced", () => {
  const madeInfo = (key: string): MadeInfo => ({ from: { kind: "copy", packageId: 1, digest: "d".repeat(64) }, recipe: "{}", tools: ["d2c71773"], key, at: 1 });
  test("a file moved in from the job's scratch (a rename: written once), hashed once with progress, kept as 'made' with what it was made from", async () => {
    const g = game("Made File");
    const out = join(tmp, "work-1", "out"); mkdirSync(out, { recursive: true });
    const zar = bytes(500_000, 21);
    writeFileSync(join(out, "PPSA01341.zar"), zar);
    const ino = lstatSync(join(out, "PPSA01341.zar")).ino;
    const seen: number[] = [];
    const r = await ingestMade(join(out, "PPSA01341.zar"), { role: "game", game: g }, { made: madeInfo("k1"), progress: b => seen.push(b) });
    expect(r.row).toMatchObject({ source: "made", platform: "ps5", name: "PPSA01341.zar", shape: "file" });
    expect(lstatSync(r.row.path).ino).toBe(ino);                             // the very file the make wrote
    expect(existsSync(join(out, "PPSA01341.zar"))).toBe(false);
    expect(contentMade(getContent(r.row.id)!)).toMatchObject({ key: "k1", tools: ["d2c71773"] });
    expect(JSON.parse(r.row.stat_json!)).toMatchObject({ size: zar.length, ino });
    expect(seen.at(-1)).toBe(zar.length);
    expect((db.query("SELECT id FROM contents WHERE game_id=? AND source='made' AND json_extract(made_json, '$.key')=?").get(g.id, "k1") as { id: number }).id).toBe(r.row.id);
  });
  test("a folder product (a make whose output is a folder) is kept as a tree, moved in", async () => {
    const g = game("Made Folder");
    const out = join(tmp, "work-2", "out", "game"); app0(out, 23);
    const r = await ingestMade(out, { role: "game", game: g }, { made: madeInfo("k2") });
    expect(r.row).toMatchObject({ source: "made", shape: "folder" });
    expect(existsSync(out)).toBe(false);
  });
});

describe("an entry judged for each of the game's ways", () => {
  test("a game folder: kept and attached to the folder way; noted for the way that takes only a .zar it cannot make from it", async () => {
    const g = game("Intake Folder");
    const fw = insertWay({ gameId: g.id, planId: plan("Intake Folder Way", folderWay()).id, content: folderWay() });
    const zw = insertWay({ gameId: g.id, planId: plan("Intake Zar Only", { ...zarWay(), make: null }).id, content: { ...zarWay(), make: null } });
    const src = join(tmp, "inbox-folder", "PPSA01341-app0"); app0(src, 31);
    const r = await intakeEntry(src, g, { source: "path", move: false });
    expect(r.row).toMatchObject({ shape: "folder", source: "path" });
    expect(r.attached).toEqual([fw.id]);
    expect(r.inputFor).toEqual([]);
    expect(r.notes).toEqual(["Intake Zar Only: a folder, and this needs one .zar file"]);
    expect(getWay(fw.id)!.content_id).toBe(r.row!.id);
    expect(getWay(zw.id)!.content_id).toBeNull();
  });

  test("what a way's make takes: kept as an input row (named by its sizes and times), for the run to make from — nothing attached", async () => {
    const g = game("Intake Input");
    ctdeps.inputMatches = () => ({ ok: true, why: null });
    const zw = insertWay({ gameId: g.id, planId: plan("Intake Kyty", zarWay()).id, content: zarWay() });
    const src = join(tmp, "inbox-input", "PPSA01341-app0"); app0(src, 41);
    const r = await intakeEntry(src, g, { source: "inbox", move: true });
    expect(r).toMatchObject({ attached: [], inputFor: [zw.id], notes: [] });
    expect(r.row).toMatchObject({ shape: "folder", source: "inbox" });
    expect(existsSync(src)).toBe(false);
    expect(getWay(zw.id)!.content_id).toBeNull();
  });

  test("neither: nothing is written, and the notes say why for each way", async () => {
    const g = game("Intake Neither");
    ctdeps.inputMatches = () => ({ ok: false, why: "another game (its serial is PPSA09999, and this takes PPSA01341)" });
    insertWay({ gameId: g.id, planId: plan("Intake Neither Kyty", zarWay()).id, content: zarWay() });
    const iso = join(tmp, "inbox-neither"); mkdirSync(iso, { recursive: true }); writeFileSync(join(iso, "Game.iso"), bytes(4096, 51));
    const r = await intakeEntry(join(iso, "Game.iso"), g, { source: "inbox", move: true });
    expect(r).toEqual({ row: null, attached: [], inputFor: [], notes: ["Intake Neither Kyty: neither its game file (a .iso file, and this needs .zar) nor what it is made from (a .iso file, and its make takes .rar, .7z, .zip)"] });
    expect(existsSync(join(iso, "Game.iso"))).toBe(true);
    expect(rowsOf(g)).toEqual([]);
    // a folder its make would take but for another game: the serial's words
    const src = join(tmp, "inbox-other", "app0"); app0(src, 52);
    expect((await intakeEntry(src, g, { source: "inbox", move: true })).notes).toEqual(["Intake Neither Kyty: neither its game file (a folder, and this needs one .zar file) nor what it is made from (another game (its serial is PPSA09999, and this takes PPSA01341))"]);
    expect(existsSync(src)).toBe(true);
  });

  test("a file every way turns down once it is read through goes back where it was", async () => {
    const g = game("Intake Give Back", ["n64"]);
    const c: ContentPlan = { kind: "rom", platform: "n64", what: "the US ROM", search: ["x"], accept: { hashes: [{ algo: "sha1", value: "0".repeat(40) }], formats: ["z64"] }, place: "rom.z64" };
    insertWay({ gameId: g.id, planId: plan("Intake Hash Way", c).id, content: c });
    const dir = join(tmp, "inbox-give-back"); mkdirSync(dir, { recursive: true });
    const rom = bytes(8192, 61); rom.set([0x80, 0x37, 0x12, 0x40], 0);
    writeFileSync(join(dir, "Game (USA).z64"), rom);
    const r = await intakeEntry(join(dir, "Game (USA).z64"), g, { source: "inbox", move: true });
    expect(r.row).toBeNull();
    expect(r.notes[0]).toMatch(/^Intake Hash Way: not the version this needs \(its sha1 is /);
    expect(readFileSync(join(dir, "Game (USA).z64")).equals(Buffer.from(rom))).toBe(true);
    expect(rowsOf(g)).toEqual([]);
  });

  test("a multi-volume archive is one entry: every volume taken together, hashed once in order, kept whole", async () => {
    const g = game("Intake Set");
    ctdeps.inputMatches = () => ({ ok: true, why: null });
    const zw = insertWay({ gameId: g.id, planId: plan("Intake Set Kyty", zarWay()).id, content: zarWay() });
    const dir = join(tmp, "inbox-set"); mkdirSync(dir, { recursive: true });
    const parts = [bytes(3000, 71), bytes(3000, 72), bytes(1000, 73)];
    ["Demons.Souls.part1.rar", "Demons.Souls.part2.rar", "Demons.Souls.part3.rar"].forEach((n, i) => writeFileSync(join(dir, n), parts[i]));
    writeFileSync(join(dir, "Other.part1.rar"), bytes(10, 74));
    expect((await archiveSet(join(dir, "Demons.Souls.part1.rar")))!.parts.map(p => p.split(/[\\/]/).pop())).toEqual(["Demons.Souls.part1.rar", "Demons.Souls.part2.rar", "Demons.Souls.part3.rar"]);
    expect(await archiveSet(join(dir, "Other.part1.rar"))).toBeNull();       // one volume is no set
    const r = await intakeEntry(join(dir, "Demons.Souls.part1.rar"), g, { source: "inbox", move: true });
    expect(r.inputFor).toEqual([zw.id]);
    expect(r.row).toMatchObject({ name: "Demons.Souls.part1.rar", size: 7000, shape: "file" });
    const whole = new Uint8Array(7000); whole.set(parts[0], 0); whole.set(parts[1], 3000); whole.set(parts[2], 6000);
    expect(JSON.parse(r.row!.hashes_json).sha256).toBe(sha256(whole));
    expect(readdirSync(join(r.row!.path, "..")).sort()).toEqual(["Demons.Souls.part1.rar", "Demons.Souls.part2.rar", "Demons.Souls.part3.rar"]);
    expect(readdirSync(dir)).toEqual(["Other.part1.rar"]);
    // removed: the whole set goes
    await removeContent(r.row!.id);
    expect(existsSync(join(r.row!.path, ".."))).toBe(false);
  });
});

describe("the inbox's content job", () => {
  const inboxOf = (g: GameRow) => { const d = join(libReal, ".ahoy-inbox", g.slug!); mkdirSync(d, { recursive: true }); return d; };
  const run = (spec: Record<string, unknown>) => jobKinds.get("content")!.run({ job: {} as never, spec: { kind: "content", ...spec } as never, work: tmp, staging: tmp, log: () => {}, progress: () => {}, signal: new AbortController().signal });

  test("an entry taken: moved into the store, the manifest says what became of it; one nobody takes stays, with its reasons beside it", async () => {
    const g = game("Inbox Job");
    ctdeps.inputMatches = () => ({ ok: true, why: null });
    const zw = insertWay({ gameId: g.id, planId: plan("Inbox Kyty", zarWay()).id, content: zarWay() });
    const box = inboxOf(g);
    app0(join(box, "PPSA01341-app0"), 81);
    const r = await run({ gameId: g.id, path: join(box, "PPSA01341-app0"), inbox: true });
    const m = r.manifest as unknown as IntakeManifest;
    expect(m).toMatchObject({ inbox: true, entry: "PPSA01341-app0", attached: [], inputFor: [zw.id] });
    expect(getContent(m.contentId!)).toMatchObject({ source: "inbox", shape: "folder" });
    expect(r.message).toBe("PPSA01341-app0: kept: a way's game file is made from it");
    expect(readdirSync(box)).toEqual([]);
    // nobody takes a .iso: it stays, with a note beside it, and the job's message is its first line
    writeFileSync(join(box, "Disc.iso"), bytes(2048, 82));
    const left = await run({ gameId: g.id, path: join(box, "Disc.iso"), inbox: true });
    expect((left.manifest as unknown as IntakeManifest).contentId).toBeNull();
    expect(left.message).toBe("Inbox Kyty: neither its game file (a .iso file, and this needs .zar) nor what it is made from (a .iso file, and its make takes .rar, .7z, .zip)");
    expect(readFileSync(join(box, "Disc.iso.not-taken.txt"), "utf8")).toBe(`${left.message}\n`);
    expect(existsSync(join(box, "Disc.iso"))).toBe(true);
  });

  test("files a build program wrote are refused, never taken: 'written by a build program, not by you'", async () => {
    const g = game("Inbox Sandbox");
    insertWay({ gameId: g.id, planId: plan("Inbox Sandbox Kyty", zarWay()).id, content: zarWay() });
    const box = inboxOf(g);
    app0(join(box, "forged-app0"), 91);
    const uid = lstatSync(join(box, "forged-app0", "eboot.bin")).uid;
    ctdeps.sandboxUids = () => [uid];                                       // on this box every file's owner is "the build user"
    const r = await run({ gameId: g.id, path: join(box, "forged-app0"), inbox: true });
    expect(r.message).toMatch(/^forged-app0 was not taken: .* was written by a build program, not by you$/);
    expect(existsSync(join(box, "forged-app0", "eboot.bin"))).toBe(true);
    expect(existsSync(join(box, "forged-app0.not-taken.txt"))).toBe(true);
    expect(rowsOf(g)).toEqual([]);
  });

  test("only an entry inside a game's inbox folder is taken this way", async () => {
    const g = game("Inbox Outside");
    const elsewhere = join(libReal, "not-an-inbox"); mkdirSync(elsewhere, { recursive: true }); writeFileSync(join(elsewhere, "x.zar"), "x");
    const e = await run({ gameId: g.id, path: join(elsewhere, "x.zar"), inbox: true }).catch(x => x);
    expect(e).toBeInstanceOf(ContentError);
    expect((e as ContentError).message).toBe("not an entry of a game's inbox folder");
  });

  test("a folder picked on the server is judged the same way, and never moved", async () => {
    const g = game("Path Folder");
    const fw = insertWay({ gameId: g.id, planId: plan("Path Folder Way", folderWay()).id, content: folderWay() });
    const src = join(libReal, "picked", "PPSA01341-app0"); app0(src, 101);
    const r = await run({ gameId: g.id, path: src });
    expect(r.message).toMatch(/^kept PPSA01341-app0, the game file of 1 way$/);
    expect(getWay(fw.id)!.content_id).not.toBeNull();
    expect(existsSync(join(src, "eboot.bin"))).toBe(true);
  });
});
