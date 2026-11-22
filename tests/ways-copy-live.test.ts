/**
 * The game's copy in the live cases' own shapes (src/ways/copy.ts; DESIGN3 B2.3, the live snapshot of 2026-11-08 in
 * SP/arc/w3/live/specs.json): Demon's Souls (game 21, package 13 with its disc image in a subfolder, content row 1 the second
 * copy of it, way 1's [zar] content) is refused in the copy's own words with nothing read, linked or copied; Ocarina of Time
 * (game 48: no copy while its ordinary download runs, then the .nup inside the Lichii PC copy, package 42) is the NX2navi
 * way's file only once what the way checks proves it, and is then linked and read where it lies once with real progress;
 * Zelda 64: Recompiled's content takes a byte-swapped dump by one copy (rewritten big-endian), proven by its sha1. And the
 * copy's verdict stays honest: a hash of another algorithm never refuses a copy before its read; a game folder's marker
 * files and a whole-game check are looked at; a duplicate is never freed under a running build.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type PackageRow, type RootFolderRow } from "../src/db";
import { jobKinds, enqueueJob } from "../src/process/kinds";
import { ctdeps } from "../src/ways/content";
import { copyFacts, copyRelease, copyServes, cpdeps, freeDuplicate, judgeCopy, takeCopy } from "../src/ways/copy";
import { EnvError, NeedsFiles } from "../src/ways/errors";
import { hashFile } from "../src/ways/hash";
import { contentFromConsoleCopy } from "../src/ways/hooks";
import type { Identity } from "../src/ways/identity";
import { getContent, getPlan, getWay, insertContent, insertPlan, insertWay, settleWay, wayGaps, type WayRow } from "../src/ways/store";
import type { ContentPlan, PlanKind, RuntimePlanSpec } from "../src/ways/types";
import { n64Rom } from "./ways-images";

const realC = { ...ctdeps }, realCp = { ...cpdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-copy-live-"));
const lib = join(tmp, "library"); mkdirSync(lib, { recursive: true });
const root: RootFolderRow = { id: 997_000, path: lib, name: null, created_at: 0 };
const made = { games: [] as number[], plans: [] as number[] };
const reset = () => {
  Object.assign(ctdeps, realC, { rootFolders: () => [root], diskSpace: async () => ({ free: 1e15, total: 2e15 }) });
  Object.assign(cpdeps, realCp, { judgeSoon: () => {} });
};
beforeAll(reset);
afterEach(reset);
afterAll(() => {
  Object.assign(ctdeps, realC); Object.assign(cpdeps, realCp);
  for (const id of made.games) for (const t of ["contents", "packages", "jobs", "requests"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function game(name: string, platforms: string[]): GameRow {
  const g = upsertGame({ name, slug: `live-${++seq}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const sha1 = (b: Uint8Array) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
function bytes(n: number, seed: number) { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; }

/** a package as the import left it: its files under its folder, the manifest listing each with its sha256 */
function pkgOf(g: GameRow, files: Record<string, Uint8Array | number>, m: { kind: string; platform: string | null; launch: string; cwd?: string; source?: { title: string; group: string; indexer: string } }): { pkg: PackageRow; dir: string } {
  const dir = join(lib, `${g.slug}`);
  const listed: { path: string; size: number; sha256: string }[] = [];
  for (const [rel, b] of Object.entries(files)) {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    if (typeof b === "number") { const fd = openSync(p, "w"); ftruncateSync(fd, b); closeSync(fd); listed.push({ path: rel, size: b, sha256: sha256(new Uint8Array(b)) }); }
    else { writeFileSync(p, b); listed.push({ path: rel, size: b.length, sha256: sha256(b) }); }
  }
  const manifest = { schema: 1, name: g.name, slug: g.slug, version: null, launch: { exe: m.launch, args: "", cwd: m.cwd ?? "" }, prerequisites: [], files: listed, totalSize: 0,
    source: m.source ? { ...m.source, protocol: "torrent" } : null, tier: "deterministic", kind: m.kind, platform: m.platform, notes: null, createdAt: "" };
  const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, 1, JSON.stringify(manifest)) as PackageRow;
  return { pkg, dir };
}
function plan(name: string, kind: PlanKind, c: ContentPlan) {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^L-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: c, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name, kind, repo: `live/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${seq}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
}
const run = (spec: Record<string, unknown>, o: { messages?: string[] } = {}) => jobKinds.get("content")!.run({
  job: {} as never, spec: { kind: "content", ...spec } as never, work: tmp, staging: tmp, log: () => {}, progress: (_p, m) => { if (m) o.messages?.push(m); }, signal: new AbortController().signal,
});

/* ─────────── the live content plans, verbatim from the snapshot ─────────── */

/** way 1's own content (KytyPS5 on Demon's Souls), as emulatorWayContent made it */
const WAY1: ContentPlan = JSON.parse(`{"kind":"disc","platform":"ps5","what":"Demon's Souls (PlayStation 5)","search":["Demon's Souls"],"accept":{"hashes":[],"formats":["zar"],"serials":["PPSA01341"]},"normalize":null,"place":"game/PPSA01341-app0.zar"}`);
/** plan 2 (NX2navi): its identity only in `what`, no hashes, serials or builds */
const NX2NAVI: ContentPlan = { kind: "rom", platform: "switch", what: "Your own dump of The Legend of Zelda: Ocarina of Time for Nintendo Switch 2 with the 1.1.1 update, as one .nup file (program 0400486024DEC000, main build e0f3ccfa); other versions are refused", search: ["The Legend of Zelda: Ocarina of Time", "Zelda Ocarina of Time Switch 2"], accept: { hashes: [], formats: ["nup"] }, normalize: null, place: "dump/{name}" };
/** what B2a's UDF reader says of bbb-ps5-01342.iso */
const SEALED_DISC: Identity = { platform: "ps5", serial: "PPSA01342", region: "US", masterVersion: "01.00", shape: "bd-image", sealed: true, category: "game" };
/** what B2a's .nup reader says of package 42's .nup */
const NUP: Identity = { platform: "switch", serial: "0400486024DEC000", version: "v131072", build: "e0f3ccfa", shape: "nup", titles: ["0400486024DEC000"] };
const NUP_NAME = "The Legend of Zelda Ocarina of Time [0400486024DEC000][v131072].nup";
const DS_WORDS = "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it";

describe("Demon's Souls (game 21): the sealed disc image, content row 1, way 1", () => {
  test("judged in small reads (its image in a subfolder, beside its .nfo and .sfv): refused for way 1 in the copy's own words; row 1 learns what it is; a Build or a hand-over refuses before anything is read, linked or copied", async () => {
    const g = game("Demon's Souls", ["PS5"]);
    const iso = bytes(256 * 1024, 1);
    const { pkg, dir } = pkgOf(g, { "bbb-ps5-01342/bbb-ps5-01342.iso": iso, "bbb-ps5-01342/bbb-ps5-01342.nfo": bytes(900, 2), "bbb-ps5-01342/bbb-ps5-01342.sfv": bytes(60, 3), "bbb-ps5-01342/cover.jpg": bytes(5000, 4) },
      { kind: "rom", platform: "ps5", launch: "bbb-ps5-01342/bbb-ps5-01342.iso", cwd: "bbb-ps5-01342", source: { title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]", group: "BigBlueBox", indexer: "GazelleGames" } });
    const image = join(dir, "bbb-ps5-01342", "bbb-ps5-01342.iso");
    // content row 1: the old hand-over's second copy, every hash of it kept
    const store = join(lib, ".ahoy-content", g.slug!); mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "bbb-ps5-01342.iso"), iso);
    const all = (await hashFile(join(store, "bbb-ps5-01342.iso"))).hashes;
    const row1 = insertContent({ gameId: g.id, platform: "ps5", name: "bbb-ps5-01342.iso", path: join(store, "bbb-ps5-01342.iso"), size: iso.length, hashes: all, source: "package" });
    const way1 = insertWay({ gameId: g.id, planId: plan("KytyPS5 (chenxiao07 Demon's Souls fork)", "emulator", WAY1).id, content: WAY1 });
    let reads = 0;
    cpdeps.readIdentity = async (_p, platform) => { reads++; expect(platform).toBe("ps5"); return SEALED_DISC; };
    const facts = (await judgeCopy(g.id))!;
    // the image is the copy's one piece of game data; the .nfo, .sfv and the cover are not
    expect(facts.entries.map(e => e.rel)).toEqual(["bbb-ps5-01342/bbb-ps5-01342.iso"]);
    expect(facts.entries[0]).toMatchObject({ contentId: row1.id, sealed: true, platform: "ps5", format: "iso", sha256: sha256(iso), size: iso.length });
    expect(JSON.parse(getContent(row1.id)!.identity_json!)).toEqual(SEALED_DISC);
    for (let i = 0; i < 5; i++) expect(copyServes(g.id, WAY1)).toEqual({ serves: "no", why: DS_WORDS, block: "identity" });
    expect(reads).toBe(1);                                                   // judged once, answered from what was kept
    expect(copyRelease(g.id)).toEqual({ title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]", indexer: "GazelleGames" });
    expect(settleWay(way1.id)).toMatchObject({ status: "needs-files", status_note: `needs the game file (Demon's Souls (PlayStation 5)): the game's copy bbb-ps5-01342.iso is ${DS_WORDS}` });
    // a Build pressed anyway: assemble's hook refuses in those words, with no byte of progress
    const ticks: number[] = [];
    await expect(contentFromConsoleCopy({ way: way1, game: g, pkg, log: () => {}, content: WAY1, progress: b => ticks.push(b) })).rejects.toThrow(`the game's console copy bbb-ps5-01342.iso is ${DS_WORDS}`);
    // a run's hand-over job too: it says it is looking, then refuses, nothing more
    const messages: string[] = [];
    const e = await run({ gameId: g.id, wayId: way1.id, fromCopy: true }, { messages }).catch(x => x);
    expect(e).toBeInstanceOf(NeedsFiles);
    expect(messages).toEqual(["looking at the game's copy"]);
    expect(ticks).toEqual([]);
    expect(lstatSync(image).nlink).toBe(1);                                  // never linked
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 1 });   // row 1 alone
  });

  test("a way that took the disc image as it is would be handed content row 1 itself: nothing read, linked or copied (the sealed disc never is: a way naming .iso still refuses it)", async () => {
    const g = game("Demon's Souls Row One", ["PS5"]);
    const iso = bytes(64 * 1024, 5);
    const { dir } = pkgOf(g, { "bbb-ps5-01342/bbb-ps5-01342.iso": iso }, { kind: "rom", platform: "ps5", launch: "bbb-ps5-01342/bbb-ps5-01342.iso" });
    const store = join(lib, ".ahoy-content", g.slug!); mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "bbb-ps5-01342.iso"), iso);
    const row1 = insertContent({ gameId: g.id, platform: "ps5", name: "bbb-ps5-01342.iso", path: join(store, "bbb-ps5-01342.iso"), size: iso.length, hashes: (await hashFile(join(store, "bbb-ps5-01342.iso"))).hashes, source: "package" });
    cpdeps.readIdentity = async () => SEALED_DISC;
    const takesIso: ContentPlan = { ...WAY1, accept: { hashes: [], formats: ["iso"], serials: ["PPSA01342"] } };
    const w = insertWay({ gameId: g.id, planId: plan("Live Iso Taker", "emulator", takesIso).id, content: takesIso });
    await judgeCopy(g.id);
    // the retail disc as a PC drive reads it is encrypted for the console: no way takes it as it is, .iso named or not
    expect(copyServes(g.id, takesIso)).toMatchObject({ serves: "no", why: expect.stringContaining("encrypted for the console") });
    // a disc image a way can take as it is (here: the same bytes, read as an open disc) is handed content row 1 itself
    cpdeps.readIdentity = async () => ({ ...SEALED_DISC, sealed: false });
    db.query("DELETE FROM copy_facts WHERE game_id=?").run(g.id);
    db.query("UPDATE contents SET identity_json=NULL WHERE id=?").run(row1.id);   // what the first look taught row 1
    await judgeCopy(g.id);
    expect(copyServes(g.id, takesIso).serves).toBe("direct");
    const lines: string[] = [];
    const taken = (await takeCopy({ game: g, way: w, content: takesIso, log: l => lines.push(l), progress: () => { throw new Error("nothing is read"); } }))!;
    expect(taken.id).toBe(row1.id);
    expect(lines.join("\n")).toContain("is kept already as bbb-ps5-01342.iso: nothing is read or copied");
    expect(lstatSync(join(dir, "bbb-ps5-01342", "bbb-ps5-01342.iso")).nlink).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 1 });
  });
});

describe("Ocarina of Time (game 48) and NX2navi", () => {
  test("no copy while its ordinary download runs; then the .nup in the Lichii PC copy is no file NX2navi takes by itself until what it checks proves it; proven, it is linked and read where it lies once, with progress", async () => {
    const g = game("The Legend of Zelda: Ocarina of Time", ["Switch 2"]);
    const w = insertWay({ gameId: g.id, planId: plan("NX2navi", "recomp", NX2NAVI).id });
    // job 60 is still downloading "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp": nothing on the server yet
    expect(copyServes(g.id, NX2NAVI)).toEqual({ serves: "no", why: "there is no copy of the game on the server", block: null });
    // the import made package 42: a PC copy (the Lichii emulator) holding the dump
    const nup = bytes(6 * 2 ** 20, 7);
    const { dir } = pkgOf(g, { "Emulator (Lichii nx2 build 88)/lichii.exe": bytes(40_000, 8), "Emulator (Lichii nx2 build 88)/nx2_switches.txt": bytes(1659, 9), "SHADERS/vulkan.fork-v53.bin": bytes(300_000, 10), [NUP_NAME]: nup },
      { kind: "native", platform: null, launch: "Emulator (Lichii nx2 build 88)/lichii.exe", cwd: "Emulator (Lichii nx2 build 88)", source: { title: "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp", group: "nogrp", indexer: "PreToMe" } });
    cpdeps.readIdentity = async (_p, _platform, name) => (name.endsWith(".nup") ? NUP : null);
    const facts = (await judgeCopy(g.id))!;
    expect(facts.entries.map(e => [e.name, e.platform])).toEqual([[NUP_NAME, "switch"]]);          // the shader cache is no game file
    // the plan as it is: its identity only in prose — the .nup is not taken on its name alone, and nothing is blocklisted
    const plain = copyServes(g.id, NX2NAVI);
    expect(plain).toEqual({ serves: "no", why: "a .nup file in the game's PC copy that nothing this way checks can prove is the game", block: null });
    expect(wayGaps(w, getPlan(w.plan_id)!)[0]).toBe(`needs the game file (${NX2NAVI.what}): the game's copy ${NUP_NAME} is ${plain.why}`);
    // after the upgrade round turns its program id into accept data: proven by the dump's own title id
    const upgraded: ContentPlan = { ...NX2NAVI, accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"] } };
    expect(copyServes(g.id, upgraded)).toEqual({ serves: "direct", why: "the game file this way takes (its title id 0400486024DEC000 is one the way accepts)", block: null });
    // another title's dump would be refused in its words (and its release never fetched again)
    expect(copyServes(g.id, { ...upgraded, accept: { ...upgraded.accept, serials: ["0100000000010000"] } })).toMatchObject({ serves: "no", block: "identity", why: expect.stringMatching(/^another game \(its title id is 0400486024DEC000/) });
    // taken: one hard link, read where it lies once, the message's bytes moving as they are read
    const w2 = insertWay({ gameId: g.id, planId: plan("NX2navi upgraded", "recomp", upgraded).id });
    let t = 0; ctdeps.now = () => (t += 1500);
    const seen: { b: number; step?: string }[] = [];
    const row = (await takeCopy({ game: g, way: w2 as WayRow, content: upgraded, log: () => {}, progress: (b, total, step) => { expect(total).toBe(nup.length); seen.push({ b, step }); } }))!;
    expect(row).toMatchObject({ source: "package", platform: "switch", name: NUP_NAME, size: nup.length });
    expect(lstatSync(row.path).ino).toBe(lstatSync(join(dir, NUP_NAME)).ino);
    expect(lstatSync(join(dir, NUP_NAME)).nlink).toBe(2);
    expect(new Set(seen.map(s => s.b)).size).toBeGreaterThan(3);
    expect(seen.every((s, i) => s.step === "hashing the game's copy" && (i === 0 || s.b >= seen[i - 1].b))).toBe(true);
    expect(seen.at(-1)!.b).toBe(nup.length);
    expect(JSON.parse(row.hashes_json).sha256).toBe(sha256(nup));
  });
});

describe("a hand-over is for its own way", () => {
  test("the run's hand-over job gives the copy's file to the way it is for, never to a way of the game that checks nothing", async () => {
    const g = game("Ocarina Hand-over", ["Switch 2"]);
    pkgOf(g, { "Emulator/lichii.exe": bytes(4000, 30), [NUP_NAME]: bytes(300_000, 31) }, { kind: "native", platform: null, launch: "Emulator/lichii.exe" });
    cpdeps.readIdentity = async (_p, _platform, name) => (name.endsWith(".nup") ? NUP : null);
    const upgraded: ContentPlan = { ...NX2NAVI, accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"] } };
    const proven = insertWay({ gameId: g.id, planId: plan("Hand-over NX2navi", "recomp", upgraded).id });
    const unchecked = insertWay({ gameId: g.id, planId: plan("Hand-over Switch Emulator", "emulator", NX2NAVI).id, content: NX2NAVI });
    await judgeCopy(g.id);
    const r = await run({ gameId: g.id, wayId: proven.id, fromCopy: true });
    expect(r.manifest).toMatchObject({ fromCopy: true, wayId: proven.id });
    expect(getWay(proven.id)!.content_id).toBe((r.manifest as { contentId: number }).contentId);
    expect(getWay(unchecked.id)!.content_id).toBeNull();
    expect(copyServes(g.id, NX2NAVI).serves).toBe("no");                    // what it checks still proves nothing
  });
});

describe("Zelda 64: Recompiled's content", () => {
  test("a byte-swapped Majora's Mask dump as the game's copy: 'direct' until its sha1 is read; taken by one copy rewritten big-endian (never linked), proven by its sha1", async () => {
    const g = game("Majora's Mask", ["N64"]);
    const z64 = n64Rom({ code: "NZSE", name: "ZELDA MAJORA'S MASK", seed: 11 }), v64 = n64Rom({ code: "NZSE", name: "ZELDA MAJORA'S MASK", seed: 11, order: "v64" });
    const { dir } = pkgOf(g, { "Majora's Mask (USA).v64": v64 }, { kind: "rom", platform: "n64", launch: "Majora's Mask (USA).v64" });
    const xxh = (await hashFile(join(dir, "Majora's Mask (USA).v64"), { n64: true })).hashes["xxh3-64"]!;
    // plan 1's content as it is in the snapshot, with this made-up dump's hashes in place of the real ROM's
    const zelda: ContentPlan = { kind: "rom", platform: "n64", what: "Majora's Mask NTSC-U 1.0 ROM", search: ["The Legend of Zelda: Majora's Mask"], accept: { hashes: [{ algo: "xxh3-64", value: xxh }, { algo: "sha1", value: sha1(z64) }], formats: ["z64", "v64", "n64"], regions: ["US"] }, normalize: "n64-z64", place: "mm.n64.us.1.0.z64" };
    const w = insertWay({ gameId: g.id, planId: plan("Zelda 64: Recompiled", "recomp", zelda).id });
    await judgeCopy(g.id);
    expect(copyServes(g.id, zelda)).toMatchObject({ serves: "direct", why: "the game file this way takes if its xxh3-64 or sha1 is one the way accepts: that is read as the copy is taken" });
    const steps = new Set<string>();
    const row = (await takeCopy({ game: g, way: w, content: zelda, log: () => {}, progress: (_b, _t, s) => { if (s) steps.add(s); } }))!;
    expect(row).toMatchObject({ name: "Majora's Mask (USA).z64", normalized: "n64 byte order v64 → z64" });
    expect(readFileSync(row.path).equals(Buffer.from(z64))).toBe(true);
    expect([...steps]).toEqual(["copying the game's copy"]);
    expect(lstatSync(join(dir, "Majora's Mask (USA).v64")).nlink).toBe(1);
  });
});

describe("the copy's verdict stays honest", () => {
  test("a hash of another algorithm (another version's) never refuses the copy before it is read: the take reads it, and that hash proves it", async () => {
    const g = game("Live Two Versions", ["ps2"]);
    const disc = bytes(80_000, 12);
    pkgOf(g, { "Disc.iso": disc }, { kind: "rom", platform: "ps2", launch: "Disc.iso" });
    // version 1.0 by its sha1 (this copy), version 1.1 by its sha256 (not this copy): the list gives only the sha256
    const c: ContentPlan = { kind: "disc", platform: "ps2", what: "the US disc, 1.0 or 1.1", search: ["x"], accept: { hashes: [{ algo: "sha1", value: sha1(disc) }, { algo: "sha256", value: "a".repeat(64) }], formats: ["iso"] }, place: "g/{name}" };
    const w = insertWay({ gameId: g.id, planId: plan("Live Two Versions Emu", "emulator", c).id, content: c });
    await judgeCopy(g.id);
    expect(copyServes(g.id, c)).toMatchObject({ serves: "direct", block: null });
    const row = (await takeCopy({ game: g, way: w, content: c, log: () => {} }))!;
    expect(JSON.parse(row.hashes_json).sha1).toBe(sha1(disc));
    // a copy that is neither: refused once its read says so, in the version's words
    const g2 = game("Live Neither Version", ["ps2"]);
    pkgOf(g2, { "Disc.iso": bytes(80_000, 13) }, { kind: "rom", platform: "ps2", launch: "Disc.iso" });
    const w2 = insertWay({ gameId: g2.id, planId: plan("Live Neither Emu", "emulator", c).id, content: c });
    await judgeCopy(g2.id);
    expect(copyServes(g2.id, c).serves).toBe("direct");
    await expect(takeCopy({ game: g2, way: w2, content: c, log: () => {} })).rejects.toThrow(/is not the version this needs/);
    expect(copyServes(g2.id, c)).toMatchObject({ serves: "no", block: "identity" });
  });

  test("a game folder's marker and the files beside it are looked at where they are, for the folder way and for the make", async () => {
    const g = game("Live App0 Without Eboot", ["ps5"]);
    pkgOf(g, { "PPSA01341-app0/sce_sys/param.json": new TextEncoder().encode("{}"), "PPSA01341-app0/data/a.bin": bytes(4096, 14) }, { kind: "rom", platform: "ps5", launch: "PPSA01341-app0/sce_sys/param.json" });
    cpdeps.readFolderIdentity = async () => ({ platform: "ps5", serial: "PPSA01341", shape: "folder" });
    cpdeps.inputMatches = () => ({ ok: true, why: null });
    await judgeCopy(g.id);
    const folderWay: ContentPlan = { kind: "folder", platform: "ps5", what: "the PS5 game folder", search: ["x"], accept: { hashes: [], serials: ["PPSA01341"] }, marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game" };
    expect(copyServes(g.id, folderWay)).toEqual({ serves: "no", why: "a game folder without eboot.bin, and this needs the game folder (holding sce_sys/param.json)", block: "form" });
    const zar: ContentPlan = { ...WAY1, make: { input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", also: ["eboot.bin"] }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { shape: "file", name: "{serial}.zar" } } };
    expect(copyServes(g.id, zar)).toMatchObject({ serves: "no", why: "a game folder without eboot.bin, and this needs .zar or the folder it is made from (holding sce_sys/param.json)", block: "form" });
    // with its eboot.bin it is what the make takes (the folder changed: it is looked at again first)
    writeFileSync(join(lib, g.slug!, "PPSA01341-app0", "eboot.bin"), bytes(2048, 15));
    expect(copyServes(g.id, zar).serves).toBe("unknown");
    await judgeCopy(g.id);
    expect(copyServes(g.id, zar).serves).toBe("make");
  });

  test("a game folder that is only a part of the game is refused by the take before anything is linked, and every way with that check is told so from then on", async () => {
    const g = game("Live Patch Folder", ["ps5"]);
    const { dir } = pkgOf(g, { "PPSA01341-patch/sce_sys/param.json": new TextEncoder().encode("{}"), "PPSA01341-patch/eboot.bin": bytes(1024, 16) }, { kind: "rom", platform: "ps5", launch: "PPSA01341-patch/sce_sys/param.json" });
    cpdeps.readFolderIdentity = async () => ({ platform: "ps5", serial: "PPSA01341", shape: "folder" });
    const whole = { minFiles: 1000 };
    const c: ContentPlan = { kind: "folder", platform: "ps5", what: "the whole PS5 game folder", search: ["x"], accept: { hashes: [], serials: ["PPSA01341"] }, marker: "sce_sys/param.json", place: "game", complete: whole };
    const w = insertWay({ gameId: g.id, planId: plan("Live Whole Folder", "emulator", c).id, content: c });
    await judgeCopy(g.id);
    expect(copyServes(g.id, c).serves).toBe("direct");                       // the walk is the take's (copyServes reads nothing)
    let walks = 0;
    ctdeps.completeness = async () => { walks++; return { ok: false, why: "an update or a part of the game, not the whole game (2 files, and the whole game has 1,000 or more)" }; };
    await expect(takeCopy({ game: g, way: w, content: c, log: () => {} })).rejects.toThrow("the game's console copy PPSA01341-patch is an update or a part of the game, not the whole game (2 files, and the whole game has 1,000 or more)");
    expect(lstatSync(join(dir, "PPSA01341-patch", "eboot.bin")).nlink).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
    expect(copyServes(g.id, c)).toMatchObject({ serves: "no", block: "identity", why: expect.stringMatching(/^an update or a part of the game/) });
    // kept across a judge of the unchanged copy; a way with another check (or none) is not told it
    await judgeCopy(g.id);
    expect(copyServes(g.id, c).serves).toBe("no");
    expect(copyServes(g.id, { ...c, complete: undefined }).serves).toBe("direct");
    expect(walks).toBe(1);
  });

  test("the second copy is never freed while a way that uses it is being built", async () => {
    const g = game("Live Free Busy", ["ps5"]);
    const iso = bytes(30_000, 17);
    const { dir } = pkgOf(g, { "bbb.iso": iso }, { kind: "rom", platform: "ps5", launch: "bbb.iso" });
    const store = join(lib, ".ahoy-content", g.slug!); mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "bbb.iso"), iso);
    const row = insertContent({ gameId: g.id, platform: "ps5", name: "bbb.iso", path: join(store, "bbb.iso"), size: iso.length, hashes: { sha1: sha1(iso), sha256: sha256(iso) }, source: "package" });
    const c: ContentPlan = { kind: "disc", platform: "ps5", what: "x", search: ["x"], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}" };
    const w = insertWay({ gameId: g.id, planId: plan("Live Free Busy Emu", "emulator", c).id, content: c });
    db.query("UPDATE ways SET content_id=? WHERE id=?").run(row.id, w.id);
    const job = enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id });
    try {
      const e = await freeDuplicate(row.id).catch(x => x);
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).kind).toBe("busy");
      expect(lstatSync(row.path).ino).not.toBe(lstatSync(join(dir, "bbb.iso")).ino);
    } finally { db.query("DELETE FROM jobs WHERE id=?").run(job.id); }
    expect(await freeDuplicate(row.id)).toEqual({ freedBytes: iso.length });
  });

  test("assemble's hook passes the step it is on with the bytes ('hashing the game's copy')", async () => {
    const g = game("Live Hook Steps", ["ps2"]);
    const { pkg } = pkgOf(g, { "Disc.iso": bytes(200_000, 18) }, { kind: "rom", platform: "ps2", launch: "Disc.iso" });
    const c: ContentPlan = { kind: "disc", platform: "ps2", what: "x", search: ["x"], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}" };
    const w = insertWay({ gameId: g.id, planId: plan("Live Hook Emu", "emulator", c).id, content: c });
    await judgeCopy(g.id);
    const steps = new Set<string>();
    const progress = ((_b: number, _t: number, step?: string) => { if (step) steps.add(step); }) as (b: number, t: number) => void;
    const row = await contentFromConsoleCopy({ way: w, game: g, pkg, log: () => {}, content: c, progress });
    expect(row).toMatchObject({ source: "package" });
    expect([...steps]).toEqual(["hashing the game's copy"]);
    expect(copyFacts(g.id)!.entries[0].contentId).toBe(row!.id);
  });
});
