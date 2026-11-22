import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow, type RootFolderRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { ctdeps } from "../src/ways/content";
import { copyFacts, cpdeps } from "../src/ways/copy";
import { contentFromConsoleCopy, romHandOff } from "../src/ways/hooks";
import { finalizeHooks } from "../src/process/runner";
import { adeps } from "../src/ways/assemble";
import { getWay, insertPlan, insertWay, settleWay } from "../src/ways/store";
import type { Manifest } from "../src/process/validate";
import type { RuntimePlanSpec } from "../src/ways/types";
import { listingDigest } from "../src/ways/hash";

/** the integrator's wiring (src/ways/hooks.ts), as the v2 contract has it: a console dump is judged where it lies, read once
 *  when a way that checks it needs its hash, and becomes a ready way's game file by a hard link (never a copy) when its
 *  checks prove it; a way with no file takes its file from the game's copy by a link, or is told in the copy's words why not */
const real = { ...ctdeps }, realCp = { ...cpdeps }, realDat = { ...datdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-hooks-"));
const rootDir = join(tmp, "library");
mkdirSync(rootDir, { recursive: true });
const rootReal = realpathSync(rootDir);
const root: RootFolderRow = { id: 992_000, path: rootDir, name: null, created_at: 0 };
const made = { plans: [] as number[], games: [] as number[], pkgs: [] as number[] };
beforeAll(() => {
  ctdeps.rootFolders = () => [root]; ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); cpdeps.judgeSoon = () => {};
  datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats();
});
afterEach(() => { Object.assign(ctdeps, real, { rootFolders: () => [root], diskSpace: async () => ({ free: 1e15, total: 2e15 }) }); });
afterAll(() => {
  Object.assign(ctdeps, real); Object.assign(cpdeps, realCp); Object.assign(datdeps, realDat); forgetDats();
  db.query("DELETE FROM contents WHERE substr(path, 1, ?)=?").run(rootReal.length, rootReal);
  db.query("DELETE FROM jobs WHERE kind='assemble' AND input_path LIKE 'way:%'").run();
  for (const id of made.pkgs) db.query("DELETE FROM packages WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

let appid = 992_100;
function game(name: string): GameRow {
  const g = upsertGame({ steam_appid: ++appid, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
  made.games.push(g.id);
  return g;
}
const rom = (() => { const b = new Uint8Array(32768); let x = 7; for (let i = 0; i < b.length; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } b.set([0x80, 0x37, 0x12, 0x40], 0); return b; })();
const sha1 = (b: Uint8Array) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
const spec = (hash: string): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Recomp-.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "recomp.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "the US ROM", search: ["Some N64 Game"], accept: { hashes: [{ algo: "sha1", value: hash }], formats: ["z64"] }, normalize: "n64-z64", place: "rom.z64" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
});
/** a package for the game: a console copy of one file or of a folder dump, or a PC copy that holds a console file */
function romPackage(g: GameRow, form: "file" | "folder" | "native" = "file"): { pkg: PackageRow; manifest: Manifest; file: string } {
  const dir = join(rootDir, `${g.slug}-dump`);
  mkdirSync(dir, { recursive: true });
  let exe = "Some Game (USA).z64";
  if (form === "folder") { exe = "PS3_GAME"; mkdirSync(join(dir, exe), { recursive: true }); writeFileSync(join(dir, exe, "PARAM.SFO"), "x"); }
  else if (form === "native") { exe = "Emulator/emu.exe"; mkdirSync(join(dir, "Emulator", "roms"), { recursive: true }); writeFileSync(join(dir, exe), "MZ"); writeFileSync(join(dir, "Emulator", "roms", "Some Game (USA).z64"), rom); }
  else writeFileSync(join(dir, exe), rom);
  const files = form === "native" ? [{ path: "Emulator/emu.exe", size: 2, sha256: "1".repeat(64) }, { path: "Emulator/roms/Some Game (USA).z64", size: rom.length, sha256: new Bun.CryptoHasher("sha256").update(rom).digest("hex") }] : [];
  const manifest = { schema: 1, name: g.name, slug: g.slug!, version: null, launch: { exe, args: "", cwd: "" }, prerequisites: [], files, totalSize: rom.length, source: null, tier: "deterministic", kind: form === "native" ? "native" : "rom", platform: form === "native" ? null : "n64", notes: null, createdAt: "" } as Manifest;
  const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, rom.length, JSON.stringify(manifest)) as PackageRow;
  made.pkgs.push(pkg.id);
  return { pkg, manifest, file: form === "native" ? join(dir, "Emulator", "roms", "Some Game (USA).z64") : join(dir, exe) };
}
function readyWay(g: GameRow, hash = sha1(rom)) {
  const p = insertPlan({ name: `Recomp for ${g.name}`, kind: "recomp", repo: "some/recomp", platforms: ["n64"], spec: spec(hash), status: "ready" });
  made.plans.push(p.id);
  return insertWay({ gameId: g.id, planId: p.id });
}

test("importing the hooks wires them into the runner and the assembler", () => {
  // other test files swap these for stubs and put back what they saw; right after import they are ours
  expect([finalizeHooks.romImported === romHandOff || typeof finalizeHooks.romImported === "function", typeof adeps.contentFromPackage]).toEqual([true, "function"]);
});

describe("the dump hand-off", () => {
  test("an imported console dump becomes a ready way's game file by a hard link (the dump stays the game's copy) and the way is queued to build", async () => {
    const g = game("Hand Off One");
    const w = readyWay(g);
    const { pkg, manifest, file } = romPackage(g);
    const lines: string[] = [];
    await romHandOff({ gameId: g.id, pkg, manifest, log: l => lines.push(l) });
    const after = getWay(w.id)!;
    expect(after.content_id).not.toBeNull();
    const kept = db.query("SELECT * FROM contents WHERE id=?").get(after.content_id) as { source: string; path: string };
    expect(kept.source).toBe("package");
    expect(Bun.file(file).size).toBe(rom.length);                            // the dump stays the game's copy
    expect(lstatSync(kept.path).ino).toBe(lstatSync(file).ino);              // one file on disk, two names
    const job = db.query("SELECT * FROM jobs WHERE kind='assemble' AND input_path=?").get(`way:${w.id}`) as JobRow | null;
    expect(job?.state).toBe("queued");
    expect(lines.join(" ")).toContain("building it");
  });

  test("a dump that is not the version the way needs is read once, kept nowhere, and builds nothing", async () => {
    const g = game("Hand Off Two");
    const w = readyWay(g, "0".repeat(40));
    const { pkg, manifest } = romPackage(g);
    const lines: string[] = [];
    await romHandOff({ gameId: g.id, pkg, manifest, log: l => lines.push(l) });
    expect(getWay(w.id)!.content_id).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM jobs WHERE kind='assemble' AND input_path=?").get(`way:${w.id}`)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
    expect(lines.join(" ")).toContain("not the version");
    expect(copyFacts(g.id)!.entries[0].hashes.sha1).toBe(sha1(rom));        // what the read told is kept with the copy
  });

  test("a game with no ready way is left alone: the copy is judged, nothing is read through or written", async () => {
    const g = game("Hand Off Three");
    const { pkg, manifest } = romPackage(g);
    await romHandOff({ gameId: g.id, pkg, manifest, log: () => {} });
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
    expect(copyFacts(g.id)).toMatchObject({ kind: "rom", name: "Some Game (USA).z64", hashed: null });
  });
});

describe("a folder dump handed over", () => {
  test("a PS3 JB folder a folder way proves by its listing is linked in as a tree, named from the package's own list: nothing is read", async () => {
    const g = game("Hand Off Folder");
    const dir = join(rootDir, `${g.slug}-jb`);
    const files: Record<string, Uint8Array> = { "PS3_GAME/PARAM.SFO": new TextEncoder().encode("SFO"), "PS3_GAME/USRDIR/EBOOT.BIN": rom.slice(0, 4096), "PS3_GAME/USRDIR/data.pak": rom.slice(4096, 12288) };
    for (const [rel, b] of Object.entries(files)) { mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...rel.split("/")), b); }
    const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
    const listed = Object.entries(files).map(([path, b]) => ({ path, size: b.length, sha256: sha256(b) }));
    const listing = listingDigest(listed.map(f => ({ rel: f.path, size: f.size, tag: f.sha256 })));
    const manifest = { schema: 1, name: g.name, slug: g.slug!, version: null, launch: { exe: "PS3_GAME/PARAM.SFO", args: "", cwd: "" }, prerequisites: [], files: listed, totalSize: 0, source: null, tier: "deterministic", kind: "rom", platform: "ps3", notes: null, createdAt: "" } as Manifest;
    const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, 1, JSON.stringify(manifest)) as PackageRow;
    made.pkgs.push(pkg.id);
    const folderSpec = { ...spec("x"), content: { kind: "folder" as const, platform: "ps3" as const, what: "the PS3 game folder", search: ["x"], accept: { hashes: [{ algo: "sha1" as const, value: listing.hashes.sha1! }] }, marker: "PS3_GAME/PARAM.SFO", place: "game" } };
    const p = insertPlan({ name: `Folder way for ${g.name}`, kind: "recomp", repo: "some/folder", platforms: ["ps3"], spec: folderSpec, status: "ready" });
    made.plans.push(p.id);
    const w = insertWay({ gameId: g.id, planId: p.id });
    const lines: string[] = [], said: string[] = [];
    await romHandOff({ gameId: g.id, pkg, manifest, log: l => lines.push(l), progress: (_p, m) => said.push(m) });
    // linking a dump of many files in takes a while: it says so, with bytes of the whole
    expect(said.filter(m => m.startsWith("linking the dump into the store · ")).length).toBeGreaterThan(0);
    const kept = db.query("SELECT * FROM contents WHERE id=?").get(getWay(w.id)!.content_id) as { shape: string; path: string; hashes_json: string };
    expect(kept.shape).toBe("folder");
    expect(JSON.parse(kept.hashes_json)).toEqual(listing.hashes);
    expect(lstatSync(join(kept.path, "PS3_GAME", "USRDIR", "EBOOT.BIN")).ino).toBe(lstatSync(join(dir, "PS3_GAME", "USRDIR", "EBOOT.BIN")).ino);
    expect(lines.join("\n")).not.toContain("reading the dump");
    expect(lines.join("\n")).toContain("building it");
  });
});

describe("taking the game file from the game's copy", () => {
  test("a single-file dump is linked in for the way", async () => {
    const g = game("Copy In One");
    const w = readyWay(g);
    const { pkg, file } = romPackage(g);
    const row = await contentFromConsoleCopy({ way: settleWay(w.id)!, game: g, pkg, log: () => {}, content: spec(sha1(rom)).content! });
    expect(row?.source).toBe("package");
    expect(row?.game_id).toBe(g.id);
    expect(lstatSync(row!.path).ino).toBe(lstatSync(file).ino);
  });
  test("a folder dump never stands in for a single game file: refused in the copy's words, before anything is read", async () => {
    const g = game("Copy In Two");
    const w = readyWay(g);
    const { pkg } = romPackage(g, "folder");
    await expect(contentFromConsoleCopy({ way: settleWay(w.id)!, game: g, pkg, log: () => {}, content: spec(sha1(rom)).content! })).rejects.toThrow(/^the game's console copy .* is a game folder \(holding PS3_GAME\/PARAM\.SFO\), and this needs \.z64$/);
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
  });
  test("a PC copy that holds no console game file is no game file; one that holds the way's file gives it (an emulator bundle's ROM)", async () => {
    const g = game("Copy In Three");
    const w = readyWay(g);
    const { pkg } = romPackage(g);
    db.query("UPDATE packages SET manifest_json=? WHERE id=?").run(JSON.stringify({ schema: 1, kind: "native", launch: { exe: "game.exe" }, files: [{ path: "game.exe", size: 2, sha256: "2".repeat(64) }] }), pkg.id);
    const native = stmts.packageById.get(pkg.id) as PackageRow;
    expect(await contentFromConsoleCopy({ way: settleWay(w.id)!, game: g, pkg: native, log: () => {}, content: spec(sha1(rom)).content! })).toBeNull();
    // a PC copy (an emulator bundle) that holds the ROM: that file of it is the way's, linked in
    const g2 = game("Copy In Four");
    const w2 = readyWay(g2);
    const bundle = romPackage(g2, "native");
    const row = await contentFromConsoleCopy({ way: settleWay(w2.id)!, game: g2, pkg: bundle.pkg, log: () => {}, content: spec(sha1(rom)).content! });
    expect(row).toMatchObject({ source: "package", name: "Some Game (USA).z64" });
    expect(lstatSync(row!.path).ino).toBe(lstatSync(bundle.file).ino);
  });
});
