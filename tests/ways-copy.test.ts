/**
 * The game's copy on the server, judged where it lies (src/ways/copy.ts; DESIGN3 B2.3, AMEND B2b, SEAMS "the game's copy"):
 * small reads and the package's own list, never a copy to look at it; an honest verdict in the copy's own words (sealed,
 * another form, another game or version; a .iso never serves a .zar way as it is); the copy taken by a hard link and hashed
 * where it lies once with real progress, or the kept row of the same bytes reused without a read; and the second copy freed
 * by a link, losslessly, only when asked.
 */
import { generalTemplate } from "./emulator-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, copyFileSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type PackageRow, type RootFolderRow } from "../src/db";
import { ctdeps } from "../src/ways/content";
import { copyFacts, copyRelease, copyScratch, copyServes, copyView, cpdeps, freeDuplicate, judgeCopy, markerRoot, takeCopy } from "../src/ways/copy";
import { NeedsFiles } from "../src/ways/errors";
import type { Identity } from "../src/ways/identity";
import { getContent, getPlan, getWay, insertContent, insertPlan, insertWay, settleWay, wayGaps } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";
import { n64Rom } from "./ways-images";

const realC = { ...ctdeps }, realCp = { ...cpdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-copy-"));
const lib = join(tmp, "library"); mkdirSync(lib, { recursive: true });
const root: RootFolderRow = { id: 995_000, path: lib, name: null, created_at: 0 };
const made = { games: [] as number[], plans: [] as number[] };
beforeAll(() => { ctdeps.rootFolders = () => [root]; ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); cpdeps.judgeSoon = () => {}; });
afterEach(() => { Object.assign(ctdeps, realC, { rootFolders: () => [root], diskSpace: async () => ({ free: 1e15, total: 2e15 }) }); Object.assign(cpdeps, realCp, { judgeSoon: () => {} }); });
afterAll(() => {
  Object.assign(ctdeps, realC); Object.assign(cpdeps, realCp);
  for (const id of made.games) for (const t of ["contents", "packages", "jobs"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function game(name: string, platforms: string[]): GameRow {
  const g = upsertGame({ name, slug: `copy-${++seq}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
const sha1 = (b: Uint8Array) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
function bytes(n: number, seed: number) { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; }

/** a package for the game: files under its folder, its manifest listing each with its sha256 (as buildManifest does) */
function pkgOf(g: GameRow, files: Record<string, Uint8Array | number>, m: { kind?: string; platform?: string | null; launch: string; source?: string }): { pkg: PackageRow; dir: string } {
  const dir = join(lib, `${g.slug}-pkg-${++seq}`);
  const listed: { path: string; size: number; sha256: string }[] = [];
  for (const [rel, b] of Object.entries(files)) {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    if (typeof b === "number") { const fd = openSync(p, "w"); ftruncateSync(fd, b); closeSync(fd); listed.push({ path: rel, size: b, sha256: "0".repeat(64) }); }
    else { writeFileSync(p, b); listed.push({ path: rel, size: b.length, sha256: sha256(b) }); }
  }
  const manifest = { schema: 1, name: g.name, slug: g.slug, version: null, launch: { exe: m.launch, args: "", cwd: "" }, prerequisites: [], files: listed, totalSize: 0, source: m.source ? { title: m.source, group: null, protocol: "torrent", indexer: "T" } : null, tier: "deterministic", kind: m.kind ?? "rom", platform: m.platform ?? null, notes: null, createdAt: "" };
  const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, 1, JSON.stringify(manifest)) as PackageRow;
  return { pkg, dir };
}
const kyty = (o: Partial<ContentPlan> = {}): ContentPlan => ({
  kind: "disc", platform: "ps5", what: "Demon's Souls (PS5), as KytyPS5 takes it", search: ["Demon's Souls"],
  accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, place: "games/{name}", ...o,
});
/** Kyty after its upgrade round: the .zar is made from the app0 folder (loose, or packed) */
const kytyMake = (): ContentPlan => kyty({
  make: { input: { shape: "either", platform: "ps5", formats: ["rar", "7z", "zip"], marker: "sce_sys/param.json", also: ["eboot.bin"] },
    steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 7200 } }], output: { shape: "file", name: "{serial}.zar" } },
});
/** what B2a's UDF reader says of the live bbb-ps5-01342.iso */
const SEALED_DISC: Identity = { platform: "ps5", serial: "PPSA01342", region: "US", masterVersion: "01.00", shape: "bd-image", sealed: true, category: "game" };
const plan = (name: string, c: ContentPlan, kind: "recomp" | "port" | "emulator" = "emulator") => {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^C-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: kind === "emulator" ? generalTemplate(c) : c, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name, kind, repo: `copy/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
};

describe("judged where it lies", () => {
  test("the Demon's Souls copy: a sealed retail disc in exact words, judged in small reads; a .iso never serves the .zar way; content row 1 is the copy's own file", async () => {
    const g = game("Copy Demon's Souls", ["ps5"]);
    const iso = bytes(256 * 1024, 1);
    const { pkg } = pkgOf(g, { "bbb-ps5-01342.iso": iso }, { platform: "ps5", launch: "bbb-ps5-01342.iso", source: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]" });
    // the second copy kept by the old hand-over (content row 1): the same bytes in the store
    const store = join(lib, ".ahoy-content", g.slug!); mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "bbb-ps5-01342.iso"), iso);
    const row1 = insertContent({ gameId: g.id, platform: "ps5", name: "bbb-ps5-01342.iso", path: join(store, "bbb-ps5-01342.iso"), size: iso.length, hashes: { sha1: sha1(iso), sha256: sha256(iso) }, source: "package" });
    let reads = 0;
    cpdeps.readIdentity = async (p, platform) => { reads++; expect(platform).toBe("ps5"); return SEALED_DISC; };
    expect(copyServes(g.id, kyty())).toEqual({ serves: "unknown", why: "looking at the game's copy", block: null });
    const facts = (await judgeCopy(g.id))!;
    expect(reads).toBe(1);
    expect(facts).toMatchObject({ packageId: pkg.id, kind: "rom", shape: "file", name: "bbb-ps5-01342.iso", format: "iso", platform: "ps5", sealed: true, contentId: row1.id, sha256: sha256(iso) });
    // the kept row learns what the copy's bytes say, and is never taken in again
    expect(JSON.parse(getContent(row1.id)!.identity_json!)).toMatchObject({ serial: "PPSA01342", sealed: true });
    const words = "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it";
    expect(copyServes(g.id, kyty())).toEqual({ serves: "no", why: words, block: "identity" });
    expect(copyServes(g.id, kytyMake())).toEqual({ serves: "no", why: words, block: "identity" });   // sealed: never a make's input either
    expect(copyView(g.id, kyty())).toEqual({ packageId: pkg.id, name: "bbb-ps5-01342.iso", size: iso.length, shape: "file", identity: SEALED_DISC, serves: "no", why: words });
    expect(copyRelease(g.id)).toEqual({ title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]", indexer: "T" });
    // a way of the game says so, and its build is off: there is nothing it could build from
    const w = insertWay({ gameId: g.id, planId: plan("Copy Kyty", kyty()).id, content: kyty() });
    expect(wayGaps(w, getPlan(w.plan_id)!)).toEqual([`needs the game file (Demon's Souls (PS5), as KytyPS5 takes it): the game's copy bbb-ps5-01342.iso is ${words}`]);
    expect(settleWay(w.id)!.status).toBe("needs-files");
    // nothing was copied or hashed to judge it: still one kept file, and the copy's own
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 1 });
  });

  test("the words for every other no: another form (with what the make takes), another console, another game", async () => {
    const g = game("Copy Plain Iso", ["ps5"]);
    pkgOf(g, { "Game.iso": bytes(4096, 2) }, { platform: "ps5", launch: "Game.iso" });
    cpdeps.readIdentity = async () => null;                                   // nothing the readers can tell
    await judgeCopy(g.id);
    expect(copyServes(g.id, kyty({ accept: { hashes: [], formats: ["zar"] } }))).toMatchObject({ serves: "no", why: "a .iso file, and this needs .zar", block: "form" });
    expect(copyServes(g.id, kytyMake())).toMatchObject({ serves: "no", why: "a .iso file, and this needs .zar or the folder it is made from (holding sce_sys/param.json), loose or as .rar, .7z or .zip", block: "form" });
    // a GameCube disc for a PS2 way: its own console's
    const gc = game("Copy Two Consoles", ["gc", "ps2"]);
    pkgOf(gc, { "RE4.iso": bytes(4096, 3) }, { platform: "gc", launch: "RE4.iso" });
    await judgeCopy(gc.id);
    expect(copyServes(gc.id, { kind: "disc", platform: "ps2", what: "x", search: [], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}" })).toMatchObject({ serves: "no", why: "a gc file, and this needs a ps2 one", block: "identity" });
    // another game, by the serial its bytes carry
    cpdeps.readIdentity = async () => ({ platform: "ps5", serial: "PPSA09999", shape: "zar" });
    const z = game("Copy Other Zar", ["ps5"]);
    pkgOf(z, { "Other.zar": bytes(4096, 4) }, { platform: "ps5", launch: "Other.zar" });
    await judgeCopy(z.id);
    expect(copyServes(z.id, kyty())).toMatchObject({ serves: "no", why: expect.stringMatching(/^another game \(its title id is PPSA09999, and this takes PPSA01341\)/), block: "identity" });
    // no copy at all
    expect(copyServes(game("Copy None", ["ps5"]).id, kyty())).toMatchObject({ serves: "no", why: "there is no copy of the game on the server" });
  });

  test("an NZSE ROM package is the recomp's file as it is ('direct'), its hash read as it is taken; the copy's facts are kept only while its file is the same", async () => {
    const g = game("Copy Majora", ["n64"]);
    const rom = n64Rom({ code: "NZSE", name: "ZELDA MAJORA", seed: 5 });
    const { dir } = pkgOf(g, { "Majora (USA).z64": rom }, { platform: "n64", launch: "Majora (USA).z64" });
    const c: ContentPlan = { kind: "rom", platform: "n64", what: "Majora's Mask, NTSC-U 1.0", search: ["Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha1(rom) }], formats: ["z64"] }, normalize: "n64-z64", place: "mm.z64" };
    const facts = (await judgeCopy(g.id))!;
    expect(facts.identity).toMatchObject({ platform: "n64", gameCode: "NZSE" });
    expect(copyServes(g.id, c)).toMatchObject({ serves: "direct", why: "the game file this way takes if its sha1 is one the way accepts: that is read as the copy is taken" });
    // a sha256 plan is told by the package's own list, without a read
    expect(copyServes(g.id, { ...c, accept: { ...c.accept, hashes: [{ algo: "sha256", value: sha256(rom) }] } })).toMatchObject({ serves: "direct", why: "the game file this way takes (its sha256 is one the way accepts)" });
    expect(copyServes(g.id, { ...c, accept: { ...c.accept, hashes: [{ algo: "sha256", value: "f".repeat(64) }] } })).toMatchObject({ serves: "no", why: expect.stringMatching(/^not the version this needs/) });
    // the file changed: the facts are not trusted any more, and the copy is looked at again
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "Majora (USA).z64"), later, later);
    expect(copyFacts(g.id)).toBeNull();
    expect(copyServes(g.id, c).serves).toBe("unknown");
  });

  test("a PS5 app0 folder package is what the way's make takes ('make'); a PS4 app0 folder whose launch is sce_sys/param.sfo is a folder, never a file hand-over", async () => {
    const g = game("Copy App0", ["ps5"]);
    const { pkg } = pkgOf(g, { "PPSA01341-app0/sce_sys/param.json": new TextEncoder().encode("{}"), "PPSA01341-app0/eboot.bin": bytes(2048, 6), "PPSA01341-app0/data/a.bin": bytes(4096, 7) }, { platform: "ps5", launch: "PPSA01341-app0/sce_sys/param.json" });
    cpdeps.readFolderIdentity = async () => ({ platform: "ps5", serial: "PPSA01341", version: "01.007.000", shape: "folder", category: "game" });
    let asked: unknown = null;
    cpdeps.inputMatches = (input, f) => { asked = { input: input.shape, shape: f.shape, serial: f.identity?.serial }; return { ok: true, why: null }; };
    const facts = (await judgeCopy(g.id))!;
    expect(facts).toMatchObject({ packageId: pkg.id, rel: "PPSA01341-app0", shape: "folder", files: 3, size: 2 + 2048 + 4096, markers: ["sce_sys/param.json", "eboot.bin"] });
    expect(facts.hashes.sha256).toMatch(/^[0-9a-f]{64}$/);                   // its listing's digest, from the package's own list
    expect(copyServes(g.id, kytyMake())).toEqual({ serves: "make", why: "what this way's game file is made from", block: null });
    expect(asked).toEqual({ input: "either", shape: "folder", serial: "PPSA01341" });
    expect(copyServes(g.id, kyty())).toMatchObject({ serves: "no", why: "a game folder (holding sce_sys/param.json and eboot.bin), and this needs .zar", block: "form" });
    // make.from without the copy: the make never takes it from there
    const fromInbox = kytyMake(); fromInbox.make!.from = ["inbox", "indexer"];
    expect(copyServes(g.id, fromInbox)).toMatchObject({ serves: "no", why: "what its make takes comes only from inbox and indexer, not from the game's copy" });
    // PS4: the marker file is never "the dump's one file"
    const ps4 = game("Copy PS4 App0", ["ps4"]);
    pkgOf(ps4, { "sce_sys/param.sfo": bytes(512, 8), "eboot.bin": bytes(1024, 9) }, { platform: "ps4", launch: "sce_sys/param.sfo" });
    cpdeps.readFolderIdentity = async () => ({ platform: "ps4", serial: "CUSA00001", shape: "folder" });
    const f4 = (await judgeCopy(ps4.id))!;
    expect(f4).toMatchObject({ rel: "", shape: "folder", files: 2 });
    expect(copyServes(ps4.id, { kind: "disc", platform: "ps4", what: "a PS4 PKG", search: [], accept: { hashes: [], formats: ["pkg"] }, place: "g/{name}" })).toMatchObject({ serves: "no", why: "a game folder (holding sce_sys/param.sfo and eboot.bin), and this needs .pkg" });
    // where the marker files say the game folder is
    expect(["PS3_GAME/USRDIR/EBOOT.BIN", "Game/PS3_GAME/PARAM.SFO", "PSP_GAME/PARAM.SFO", "CUSA1/sce_sys/param.sfo", "x/exefs/main", "a/app.pkg", "Game.iso"].map(markerRoot)).toEqual(["", "Game", "", "CUSA1", "x", null, null]);
  });

  test("any package's console game files count, largest first: a PC copy (an emulator bundle) that holds the .nup is the copy", async () => {
    const g = game("Copy Ocarina Switch 2", ["switch"]);
    pkgOf(g, { "Emulator (Lichii)/lichii.exe": bytes(1024, 10), "The Legend of Zelda Ocarina of Time [0400486024DEC000][v131072].nup": bytes(8192, 11) }, { kind: "native", launch: "Emulator (Lichii)/lichii.exe" });
    cpdeps.readIdentity = async (_p, _platform, name) => (name.endsWith(".nup") ? { platform: "switch", serial: "0400486024DEC000", version: "v131072", build: "e0f3ccfa", shape: "nup", titles: ["0400486024DEC000"] } : null);
    const facts = (await judgeCopy(g.id))!;
    expect(facts.entries.map(e => [e.name, e.shape, e.platform])).toEqual([["The Legend of Zelda Ocarina of Time [0400486024DEC000][v131072].nup", "file", "switch"]]);
    const nx2navi: ContentPlan = { kind: "rom", platform: "switch", what: "program 0400486024DEC000, main build e0f3ccfa", search: ["Ocarina of Time"], accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"] }, place: "game.nup" };
    expect(copyServes(g.id, nx2navi).serves).toBe("direct");
    // a PC way's data is never taken from the copy
    expect(copyServes(g.id, { ...nx2navi, platform: "pc" })).toMatchObject({ serves: "no", why: "PC game data is never taken from the game's copy" });
  });

  test("a copy nobody has looked at yet is looked at in the background, and the game's ways settle when it ends", async () => {
    const g = game("Copy Soon", ["ps2"]);
    pkgOf(g, { "Soon.iso": bytes(4096, 12) }, { platform: "ps2", launch: "Soon.iso" });
    const c: ContentPlan = { kind: "disc", platform: "ps2", what: "a PS2 disc", search: [], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}" };
    const w = insertWay({ gameId: g.id, planId: plan("Copy Soon Emu", c).id, content: c });
    cpdeps.judgeSoon = realCp.judgeSoon;
    expect(settleWay(w.id)).toMatchObject({ status: "needs-files", status_note: "looking at the game's copy" });
    for (let i = 0; i < 50 && !copyFacts(g.id); i++) await Bun.sleep(10);
    expect(copyFacts(g.id)).not.toBeNull();
    expect(getWay(w.id)).toMatchObject({ status: "ready", status_note: null });
  });
});

describe("taken by a link, hashed where it lies once", () => {
  const sega = (): ContentPlan => ({ kind: "disc", platform: "ps2", what: "a PS2 disc", search: [], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}" });
  async function setup(name: string, data: Uint8Array | number, c: ContentPlan = sega()) {
    const g = game(name, [c.platform]);
    const { dir } = pkgOf(g, { "Disc.iso": data }, { platform: c.platform, launch: "Disc.iso" });
    const w = insertWay({ gameId: g.id, planId: plan(`${name} Emu`, c).id, content: c });
    await judgeCopy(g.id);
    return { g, w, c, file: join(dir, "Disc.iso") };
  }

  test("a hard link (nlink 2, no new bytes), its hashes read once with the stat they belong to; a second take reads nothing", async () => {
    const data = bytes(300_000, 13);
    const { g, w, c, file } = await setup("Copy Link", data, { ...sega(), accept: { hashes: [{ algo: "sha1", value: sha1(data) }], formats: ["iso"] } });
    const lines: string[] = [];
    const row = (await takeCopy({ game: g, way: w, content: c, log: l => lines.push(l) }))!;
    expect(row).toMatchObject({ source: "package", platform: "ps2", size: data.length });
    expect(lstatSync(row.path).ino).toBe(lstatSync(file).ino);
    expect(lstatSync(file).nlink).toBe(2);
    expect(readFileSync(row.path).equals(Buffer.from(data))).toBe(true);
    expect(JSON.parse(row.hashes_json).sha1).toBe(sha1(data));
    expect(JSON.parse(row.stat_json!)).toMatchObject({ size: data.length, ino: lstatSync(file).ino, dev: lstatSync(file).dev });
    expect(lines.join("\n")).toContain("by a hard link, hashed where it lies");
    // the copy's facts know the row now: the next take is that row, with nothing read or linked
    expect(copyFacts(g.id)!.entries[0]).toMatchObject({ contentId: row.id, hashes: { sha1: sha1(data) } });
    const again: string[] = [];
    expect((await takeCopy({ game: g, way: w, content: c, log: l => again.push(l) }))!.id).toBe(row.id);
    expect(again.join("\n")).toContain("is kept already as Disc.iso: nothing is read or copied");
    expect(lstatSync(file).nlink).toBe(2);
  });

  test("a big file's progress moves as its bytes are read (a fake clock), in bytes of the whole and the step it is on", async () => {
    const size = 160 * 2 ** 20;
    const { g, w, c } = await setup("Copy Big", size);
    let t = 0;
    ctdeps.now = () => (t += 1500);
    const seen: { b: number; total: number; step?: string }[] = [];
    await takeCopy({ game: g, way: w, content: c, log: () => {}, progress: (b, total, step) => seen.push({ b, total, step }) });
    expect(seen.length).toBeGreaterThan(100);
    expect(new Set(seen.map(s => s.b)).size).toBeGreaterThan(100);
    expect(seen.every((s, i) => s.total === size && s.step === "hashing the game's copy" && (i === 0 || s.b >= seen[i - 1].b))).toBe(true);
    expect(seen.at(-1)!.b).toBe(size);
  });

  test("the content job hands the copy over with messages that change as the bytes go by", async () => {
    const size = 96 * 2 ** 20;
    const { g, w } = await setup("Copy Job", size);
    let t = 0;
    ctdeps.now = () => (t += 1500);
    const def = (await import("../src/process/kinds")).jobKinds.get("content")!;
    const messages: string[] = [];
    const r = await def.run({ job: {} as never, spec: { kind: "content", gameId: g.id, wayId: w.id, fromCopy: true }, work: tmp, staging: tmp, log: () => {}, progress: (_p, m) => { if (m) messages.push(m); }, signal: new AbortController().signal });
    expect(r.message).toBe("Disc.iso is the game file of Copy Job Emu now (taken from the game's copy)");
    const hashing = messages.filter(m => m.startsWith("hashing the game's copy · "));
    expect(new Set(hashing).size).toBeGreaterThan(20);
    expect(hashing.at(-1)).toBe("hashing the game's copy · 101 of 101 MB");
    expect(await def.scratch!({} as never, { kind: "content", gameId: g.id, wayId: w.id, fromCopy: true })).toBe(0);   // a link writes nothing
  });

  test("a take is cancelled: the link it made goes, nothing is kept", async () => {
    const { g, w, c, file } = await setup("Copy Cancel", 64 * 2 ** 20);
    const ac = new AbortController();
    let n = 0;
    ctdeps.now = (() => { let t = 0; return () => (t += 1500); })();
    await expect(takeCopy({ game: g, way: w, content: c, log: () => {}, signal: ac.signal, progress: () => { if (++n === 3) ac.abort(); } })).rejects.toThrow("cancelled");
    expect(lstatSync(file).nlink).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
  });

  test("a copy whose read refuses it (its hash is another version's) leaves nothing behind, and every way knows its hash from then on", async () => {
    const data = bytes(50_000, 14);
    const c = { ...sega(), accept: { hashes: [{ algo: "sha1" as const, value: "0".repeat(40) }], formats: ["iso"] } };
    const { g, w, file } = await setup("Copy Refused", data, c);
    await expect(takeCopy({ game: g, way: w, content: c, log: () => {} })).rejects.toBeInstanceOf(NeedsFiles);
    await expect(takeCopy({ game: g, way: w, content: c, log: () => {} })).rejects.toThrow(/^the game's console copy Disc\.iso is not the version this needs/);
    expect(lstatSync(file).nlink).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
    expect(copyServes(g.id, c)).toMatchObject({ serves: "no", why: `not the version this needs (its sha1 is ${sha1(data)})` });
  });

  test("a copy the way's make takes, or one in another form, is refused before anything is linked or read", async () => {
    const { g, w, file } = await setup("Copy Not Direct", bytes(2048, 15), kyty({ accept: { hashes: [], formats: ["zar"] } }));
    cpdeps.readIdentity = async () => null;
    await judgeCopy(g.id);
    await expect(takeCopy({ game: g, way: w, content: kyty({ accept: { hashes: [], formats: ["zar"] } }), log: () => {} })).rejects.toThrow("the game's console copy Disc.iso is a .iso file, and this needs .zar");
    cpdeps.inputMatches = () => ({ ok: true, why: null });
    const viaMake = kytyMake(); viaMake.make!.input = { shape: "file", platform: "ps5", formats: ["iso"] };
    await expect(takeCopy({ game: g, way: w, content: viaMake, log: () => {} })).rejects.toThrow("its game file is made from the game's console copy Disc.iso first");
    expect(lstatSync(file).nlink).toBe(1);
  });

  test("across volumes the copy is copied, with progress, and hashed as it is copied; no room: the server's words", async () => {
    const data = bytes(200_000, 16);
    const { g, w, c } = await setup("Copy Across", data);
    // a share without hard links (Unraid's "support Hard Links" off), or another volume: the link fails with EXDEV
    const steps = new Set<string>();
    ctdeps.link = async () => { const e = new Error("cross-device link") as Error & { code: string }; e.code = "EXDEV"; throw e; };
    {
      ctdeps.diskSpace = async () => ({ free: 1, total: 2e15 });
      await expect(takeCopy({ game: g, way: w, content: c, log: () => {} })).rejects.toThrow(/^not enough room/);
      ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
      const row = (await takeCopy({ game: g, way: w, content: c, log: () => {}, progress: (_b, _t, s) => { if (s) steps.add(s); } }))!;
      expect(lstatSync(row.path).nlink).toBe(1);
      expect(readFileSync(row.path).equals(Buffer.from(data))).toBe(true);
      expect([...steps]).toEqual(["copying the game's copy"]);
    }
  }, 30_000);
});

describe("the second copy freed by a link (on the admin's word)", () => {
  test("content row 1: the same bytes as the copy's file, on one volume — replaced by a hard link to it, never a moment without the file", async () => {
    const g = game("Copy Free", ["ps5"]);
    const iso = bytes(400_000, 17);
    const { dir } = pkgOf(g, { "bbb.iso": iso }, { platform: "ps5", launch: "bbb.iso" });
    const store = join(lib, ".ahoy-content", g.slug!); mkdirSync(store, { recursive: true });
    copyFileSync(join(dir, "bbb.iso"), join(store, "bbb.iso"));
    const row = insertContent({ gameId: g.id, platform: "ps5", name: "bbb.iso", path: join(store, "bbb.iso"), size: iso.length, hashes: { sha1: sha1(iso), sha256: sha256(iso) }, source: "package" });
    expect(lstatSync(row.path).ino).not.toBe(lstatSync(join(dir, "bbb.iso")).ino);
    const lines: string[] = [];
    expect(await freeDuplicate(row.id, { log: l => lines.push(l) })).toEqual({ freedBytes: iso.length });
    expect(lstatSync(row.path).ino).toBe(lstatSync(join(dir, "bbb.iso")).ino);
    expect(readFileSync(row.path).equals(Buffer.from(iso))).toBe(true);
    expect(JSON.parse(getContent(row.id)!.stat_json!)).toMatchObject({ ino: lstatSync(join(dir, "bbb.iso")).ino });
    expect(lines.join("\n")).toContain("to be sure it is the same bytes");
    // twice: nothing left to free
    await expect(freeDuplicate(row.id)).rejects.toThrow("the kept file is the copy's own file already: nothing to free");
  });

  test("anything less than lossless is refused with the reason: other bytes, no package listing them, other names", async () => {
    const g = game("Copy Free Refused", ["ps5"]);
    const iso = bytes(10_000, 18), other = bytes(10_000, 19);
    const { dir } = pkgOf(g, { "a.iso": iso }, { platform: "ps5", launch: "a.iso" });
    const store = join(lib, ".ahoy-content", g.slug!); mkdirSync(store, { recursive: true });
    // the package's list says these bytes, but its file is other bytes now: the read says so, nothing is freed
    writeFileSync(join(store, "a.iso"), iso);
    writeFileSync(join(dir, "a.iso"), other);
    const row = insertContent({ gameId: g.id, platform: "ps5", name: "a.iso", path: join(store, "a.iso"), size: iso.length, hashes: { sha1: sha1(iso), sha256: sha256(iso) }, source: "package" });
    await expect(freeDuplicate(row.id)).rejects.toThrow(/^the copy's file is not the same bytes now/);
    expect(readFileSync(row.path).equals(Buffer.from(iso))).toBe(true);
    // a file no package lists
    writeFileSync(join(store, "b.iso"), other);
    const stray = insertContent({ gameId: g.id, platform: "ps5", name: "b.iso", path: join(store, "b.iso"), size: other.length, hashes: { sha1: sha1(other), sha256: "e".repeat(64) }, source: "upload" });
    await expect(freeDuplicate(stray.id)).rejects.toThrow("no copy of the game on the server lists these bytes: nothing to free");
    await expect(freeDuplicate(999_999_999)).rejects.toThrow("no such file");
  });
});

describe("the scratch a take needs", () => {
  test("nothing when the copy can be linked; its size across volumes; nothing for a kept row of the same bytes", async () => {
    const g = game("Copy Scratch", ["ps2"]);
    pkgOf(g, { "S.iso": bytes(12_345, 20) }, { platform: "ps2", launch: "S.iso" });
    await judgeCopy(g.id);
    expect(await copyScratch(g.id)).toBe(0);
    ctdeps.sameVolume = async () => false;
    expect(await copyScratch(g.id)).toBe(12_345);
    expect(await copyScratch(null)).toBe(0);
  });
});

