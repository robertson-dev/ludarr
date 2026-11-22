/**
 * The console dump hand-off (src/ways/hooks.ts) and where a game file whose console is not known may go by itself, as the
 * v2 contract has it (DESIGN3 B2.7, AMEND M15d): an imported dump is judged where it lies (src/ways/copy.ts, small reads),
 * read once only when a way that checks it needs its hash, and linked into the content store (a hard link: the dump stays
 * the game's copy, nothing is copied) only for the ways it proves — nothing is written for a dump no way takes; a way that
 * checks no hashes takes nothing but can be built from the copy; a way added later is told what the copy is from what was
 * read of it; a file sent for a way is that way's console's, and a PC way of a game on no console takes a file no platform
 * is known for (review findings e2e-1, ways-api-2, ways-api-3).
 */
import { generalTemplate } from "./emulator-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import { enqueueJob } from "../src/process/kinds";
import { finalizeHooks, rdeps, runJob } from "../src/process/runner";
import { inspectRom, type Manifest } from "../src/process/validate";
import { waysApi } from "../src/ways/api";
import { adeps } from "../src/ways/assemble";
import { ctdeps } from "../src/ways/content";
import { copyFacts, copyServes, cpdeps } from "../src/ways/copy";
import { contentFromConsoleCopy, romHandOff } from "../src/ways/hooks";
import { prdeps } from "../src/ways/program";
import { getContent, getWay, insertPlan, insertWay, updateWay } from "../src/ways/store";
import type { ContentPlan, PlanKind, PlanStatus, RuntimePlanSpec } from "../src/ways/types";

const realC = { ...ctdeps }, realCp = { ...cpdeps }, realDat = { ...datdeps }, realImporters = rdeps.importers, realHook = finalizeHooks.romImported;
const tmp = mkdtempSync(join(tmpdir(), "ways-handoff-"));
const made = { games: [] as number[], plans: [] as number[] };
let root = "";
beforeAll(() => {
  ensureDefaultRootFolder();
  root = rootFolders()[0].path;
  ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
  cpdeps.judgeSoon = () => {};                                             // each test judges its copy where it says
  datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats();
  finalizeHooks.romImported = romHandOff;
});
afterEach(() => { rdeps.importers = realImporters; });
afterAll(() => {
  Object.assign(ctdeps, realC); Object.assign(cpdeps, realCp); Object.assign(datdeps, realDat); forgetDats();
  finalizeHooks.romImported = realHook;
  for (const id of made.games) {
    db.query("DELETE FROM jobs WHERE game_id=?").run(id);
    db.query("DELETE FROM contents WHERE game_id=?").run(id);
    db.query("DELETE FROM packages WHERE game_id=?").run(id);
    db.query("DELETE FROM games WHERE id=?").run(id);
  }
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function game(name: string, platforms: string[]): GameRow {
  const g = upsertGame({ name, slug: `handoff-${++seq}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function random(n: number, seed: number) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}
const sha1 = (b: Uint8Array) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
/** an N64 dump in its big-endian byte order (hashed as it is) */
const n64Dump = (seed: number) => { const b = random(32_768, seed); b.set([0x80, 0x37, 0x12, 0x40], 0); return b; };
/** `search`: the game a port's plan plays (POST /game/:id/ways adds a recomp or port plan only to that game) */
const content = (platform: string, formats: string[], hashes: string[], place = "games/{name}", search = ["x"]): ContentPlan => ({
  kind: platform === "n64" ? "rom" : "disc", platform: platform as ContentPlan["platform"], what: `a ${platform} file`, search,
  accept: { hashes: hashes.map(value => ({ algo: "sha1" as const, value })), formats }, normalize: null, place,
});
const spec = (c: ContentPlan, kind: PlanKind): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Handoff-.*[.]zip$", channel: "stable" },
  launch: { exe: "run.exe", argv: kind === "emulator" ? ["{content}"] : [] },
  content: kind === "emulator" ? generalTemplate(c) : c,
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
});
function plan(name: string, kind: PlanKind, c: ContentPlan, status: PlanStatus = "ready") {
  const p = insertPlan({ name, kind, repo: `handoff/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: [c.platform], spec: spec(c, kind), status });
  made.plans.push(p.id);
  return p;
}
/** a way as POST /game/:id/ways makes it: an emulator way gets this game's own content plan, without hashes */
function way(g: GameRow, p: ReturnType<typeof plan>, own?: ContentPlan) {
  return insertWay({ gameId: g.id, planId: p.id, content: own ?? null });
}
/** the game's console copy, as an import leaves it: one file in a package folder, the manifest naming its console and the
 *  file's own sha256 (as buildManifest writes it) */
function romPackage(g: GameRow, file: string, bytes: Uint8Array, platform: string | null): { pkg: PackageRow; manifest: Manifest; path: string } {
  const dir = join(root, `${g.slug}-copy`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), bytes);
  const manifest = { schema: 1, name: g.name, slug: g.slug!, version: null, launch: { exe: file, args: "", cwd: "" }, prerequisites: [], files: [{ path: file, size: bytes.length, sha256: sha256(bytes) }], totalSize: bytes.length, source: null, tier: "deterministic", kind: "rom", platform, notes: null, createdAt: "" } as unknown as Manifest;
  const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, bytes.length, JSON.stringify(manifest)) as PackageRow;
  return { pkg, manifest, path: join(dir, file) };
}
const assembleJobs = (gameId: number) => (db.query("SELECT * FROM jobs WHERE kind='assemble' AND game_id=? ORDER BY id").all(gameId) as JobRow[]).map(j => JSON.parse(j.spec_json!).wayId as number);
const keptRows = (gameId: number) => db.query("SELECT id, platform, source, path FROM contents WHERE game_id=? ORDER BY id").all(gameId) as { id: number; platform: string | null; source: string; path: string }[];

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await waysApi.request(path, init);
  return { status: r.status, body: await r.json() };
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const upload = (g: GameRow, bytes: BodyInit, name: string, extra = "") => call(`/api/v1/content?gameId=${g.id}&name=${encodeURIComponent(name)}${extra}`, { method: "POST", body: bytes });

describe("the dump hand-off", () => {
  test("an imported dump gives an emulator way no file and no build: nobody checked it is the game (e2e-1)", async () => {
    const g = game("Banjo Probe", ["n64"]);
    const emu = plan("Handoff N64 Emulator", "emulator", content("n64", ["z64"], []));
    const w = await call(`/api/v1/game/${g.id}/ways`, post({ planId: emu.id }));
    expect(w.status).toBe(201);
    expect(w.body.item.content.accept.hashes).toEqual([]);
    // a member's request brought another game's demo; the import keeps it as the game's console copy
    const input = mkdtempSync(join(tmp, "dl-"));
    writeFileSync(join(input, "Diddy Kong Racing (USA) (Demo).z64"), n64Dump(11));
    rdeps.importers = () => [{ impl: "recipes", name: "copy", importer: { probe: async () => true, run: async (ctx: any) => {
      cpSync(ctx.input, ctx.staging, { recursive: true });
      return { ok: true, shape: "folder" as const, reason: null, platform: "n64", validation: await inspectRom(ctx.staging) };
    } } }];
    const j = stmts.insertJob.get(null, null, g.id, input) as JobRow;
    await runJob(j.id);
    const done = stmts.jobById.get(j.id) as JobRow;
    expect(done.state).toBe("done");
    expect(JSON.parse(done.manifest_json!).kind).toBe("rom");
    expect(getWay(w.body.item.id)).toMatchObject({ content_id: null, status: "ready" });
    expect(assembleJobs(g.id)).toEqual([]);
    expect(done.transcript).toContain("checks no hashes, so the dump is not built into it by itself");
    expect(done.transcript).not.toContain("reading the dump");                // nobody needs its hash: it is never read through
    // what the admin sees agrees: ready, because the admin's Build would take the console copy, and nothing attached
    const item = (await call(`/api/v1/game/${g.id}/ways`)).body.items[0];
    expect(item).toMatchObject({ status: "ready", statusNote: null, contentId: null, fromConsoleCopy: true, canBuild: true, blockers: [] });
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
  });

  test("one build, for the best way that checks the dump, which is linked into the store, never copied; a draft plan's way and an emulator way take nothing (ways-api-3)", async () => {
    const g = game("Handoff Three Ways", ["n64"]);
    const dump = n64Dump(21), hash = sha1(dump);
    const c = content("n64", ["z64"], [hash], "rom.z64");
    const port = way(g, plan("Handoff Port", "port", c));
    const recomp = way(g, plan("Handoff Recomp", "recomp", c));
    const emu = way(g, plan("Handoff Emulator", "emulator", c), content("n64", ["z64"], []));
    const draft = way(g, plan("Handoff Draft Recomp", "recomp", c, "draft"));
    const { pkg, manifest, path } = romPackage(g, "Handoff (USA).z64", dump, "n64");
    const lines: string[] = [];
    await romHandOff({ gameId: g.id, pkg, manifest, log: l => lines.push(l) });
    expect(assembleJobs(g.id)).toEqual([recomp.id]);                       // a recomp before a port, and only one build
    const file = getWay(recomp.id)!.content_id!;
    const row = getContent(file)!;
    expect(row).toMatchObject({ source: "package", platform: "n64" });
    // one kept file, a hard link to the dump: the same bytes on disk once
    expect(keptRows(g.id).length).toBe(1);
    expect(lstatSync(row.path).ino).toBe(lstatSync(path).ino);
    expect(lstatSync(path).nlink).toBe(2);
    expect(JSON.parse(row.stat_json!)).toMatchObject({ size: dump.length, ino: lstatSync(path).ino });
    expect(getWay(port.id)).toMatchObject({ content_id: file, status: "ready" });
    expect(getWay(emu.id)).toMatchObject({ content_id: null, status: "ready" });         // the console copy serves it, when built by hand
    expect(getWay(draft.id)!.content_id).toBeNull();                         // a draft plan's way is never handed the dump
    expect(lines).toContain("the dump became the game file of Handoff Recomp: building it");
    expect(lines.filter(l => l.startsWith("reading the dump where it lies")).length).toBe(1);   // read once for both ways
  });

  test("a game that already has a built way gets the file on its checked ways, but no build", async () => {
    const g = game("Handoff Built", ["n64"]);
    const dump = n64Dump(31), c = content("n64", ["z64"], [sha1(dump)], "rom.z64");
    const recomp = way(g, plan("Handoff Built Recomp", "recomp", c));
    const built = way(g, plan("Handoff Built Port", "port", c));
    const dir = join(root, `${g.slug}-built`); mkdirSync(dir, { recursive: true });
    const portPkg = stmts.insertPackage.get(g.id, null, dir, g.name, "1", 1, JSON.stringify({ kind: "port", launch: { exe: "run.exe" }, files: [], totalSize: 1 })) as PackageRow;
    updateWay(built.id, { status: "built", packageId: portPkg.id });
    const { pkg, manifest } = romPackage(g, "Built (USA).z64", dump, "n64");
    const lines: string[] = [];
    await romHandOff({ gameId: g.id, pkg, manifest, log: l => lines.push(l) });
    expect(getWay(recomp.id)!.content_id).not.toBeNull();
    expect(assembleJobs(g.id)).toEqual([]);
    expect(lines.join(" ")).toContain("already has a built way to play, so nothing is built");
  });

  test("the dump keeps its console: a GameCube disc is no game file for a PS2 way, even with the hash it lists — told without reading it, nothing written (ways-api-2)", async () => {
    const g = game("Handoff Two Consoles", ["ps2", "gc"]);
    const disc = random(65_536, 41);
    const ps2 = way(g, plan("Handoff PS2 Port", "port", content("ps2", ["iso"], [sha1(disc)])));
    const { pkg, manifest } = romPackage(g, "Resident Evil 4 (USA) (Disc 1).iso", disc, "gc");
    const lines: string[] = [];
    await romHandOff({ gameId: g.id, pkg, manifest, log: l => lines.push(l) });
    expect(keptRows(g.id)).toEqual([]);
    expect(getWay(ps2.id)!.content_id).toBeNull();
    expect(assembleJobs(g.id)).toEqual([]);
    expect(lines.join(" ")).toContain("the dump is no game file for Handoff PS2 Port: a gc file, and this needs a ps2 one");
    expect(lines.join(" ")).not.toContain("reading the dump");
    expect(copyServes(g.id, content("ps2", ["iso"], [sha1(disc)]))).toMatchObject({ serves: "no", why: "a gc file, and this needs a ps2 one" });
  });

  test("a dump the hand-off refused is never kept; a way added later is told what it is from the one read of it, and takes it when its hash is the one", async () => {
    const g = game("Handoff Later Way", ["n64"]);
    const beta = n64Dump(101);
    way(g, plan("Handoff Later Recomp", "recomp", content("n64", ["z64"], ["a".repeat(40)], "rom.z64")));
    const { pkg, manifest } = romPackage(g, "Later Game (USA) (Beta).z64", beta, "n64");
    const lines: string[] = [];
    await romHandOff({ gameId: g.id, pkg, manifest, log: l => lines.push(l) });
    expect(lines.join(" ")).toContain("the dump is no game file for Handoff Later Recomp");
    expect(keptRows(g.id)).toEqual([]);
    // the one read is remembered with the copy: its sha1 is known now
    expect(copyFacts(g.id)!.entries[0].hashes.sha1).toBe(sha1(beta));
    // an emulator way added afterwards: nobody checked the copy is the game, so it is not its file (a Build takes it then)
    const emu = (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan("Handoff Later Emulator", "emulator", content("n64", ["z64"], [])).id }))).body.item;
    expect(emu).toMatchObject({ contentId: null, fromConsoleCopy: true });
    // a way whose hash it is: the copy is its file (by that hash, known without another read), taken by a link when built
    const port = (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan("Handoff Later Port", "port", content("n64", ["z64"], [sha1(beta)], "rom.z64", [g.name])).id }))).body.item;
    expect(port).toMatchObject({ contentId: null, fromConsoleCopy: true, canBuild: true, status: "ready" });
    expect(copyServes(g.id, content("n64", ["z64"], [sha1(beta)]))).toMatchObject({ serves: "direct", why: "the game file this way takes (its sha1 is one the way accepts)" });
    expect(assembleJobs(g.id)).toEqual([]);
  });

  test("a way built from the console copy takes the dump with the copy's console, by a hard link", async () => {
    const g = game("Handoff Copy Console", ["gc"]);
    const disc = random(4096, 51);
    const w = way(g, plan("Handoff GC Emulator", "emulator", content("gc", ["iso"], [])), content("gc", ["iso"], []));
    const { pkg, path } = romPackage(g, "Some Game (USA).iso", disc, "gc");
    const row = await contentFromConsoleCopy({ way: w, game: g, pkg, log: () => {}, content: content("gc", ["iso"], []) });
    expect(row).toMatchObject({ platform: "gc", source: "package" });
    expect(lstatSync(row!.path).ino).toBe(lstatSync(path).ino);
  });
});

describe("a game file whose console is not known (ways-api-2)", () => {
  async function twoConsoleGame(name: string) {
    const g = game(name, ["ps2", "gc"]);
    const ps2 = (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan(`${name} PCSX2`, "emulator", content("ps2", ["iso", "chd"], [])).id }))).body.item;
    const gc = (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan(`${name} Dolphin`, "emulator", content("gc", ["iso", "rvz"], [])).id }))).body.item;
    return { g, ps2: ps2.id as number, gc: gc.id as number };
  }

  test("sent for a way, the file is that way's console's: a disc sent for the GameCube way never becomes the PS2 way's", async () => {
    const { g, ps2, gc } = await twoConsoleGame("Handoff Upload For Way");
    const r = await upload(g, random(4096, 61), "Resident Evil 4 (USA).iso", `&wayId=${gc}`);
    expect(r.status).toBe(201);
    expect(r.body.item.platform).toBe("gc");
    expect(r.body.attached).toEqual([gc]);
    expect(r.body.checks.find((c: { wayId: number }) => c.wayId === ps2)).toMatchObject({ ok: false, why: "a gc file, and this needs a ps2 one" });
    expect(getWay(ps2)!.content_id).toBeNull();
  });

  test("sent for no way and no console, it is kept with a check saying which console each way needs", async () => {
    const { g, ps2, gc } = await twoConsoleGame("Handoff Upload Unknown");
    const r = await upload(g, random(4096, 71), "Mystery Disc.iso");
    expect(r.status).toBe(201);
    expect(r.body.item.platform).toBeNull();
    expect(r.body.attached).toEqual([]);
    expect(r.body.checks.map((c: { wayId: number; ok: boolean; why: string }) => [c.wayId, c.ok, c.why])).toEqual([
      [ps2, false, "a file of no known console, and this needs a ps2 one: take it in for this way, or with its platform"],
      [gc, false, "a file of no known console, and this needs a gc one: take it in for this way, or with its platform"],
    ]);
    // a way added later does not pick it up by itself either
    const late = (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan("Handoff Late PCSX2", "emulator", content("ps2", ["iso"], [])).id }))).body.item;
    expect(late.contentId).toBeNull();
  });

  test("the way for a game's only console takes it, and a way that checks by hash takes its file whatever it says", async () => {
    const g = game("Handoff One Console", ["pc", "ps2"]);
    const ps2 = (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan("Handoff Only PCSX2", "emulator", content("ps2", ["iso"], [])).id }))).body.item;
    expect((await upload(g, random(4096, 81), "Only Console (USA).iso")).body.attached).toEqual([ps2.id]);
    // PC data for a port of a PC game: no extension names a console, the hash says it is the file
    const pcGame = game("Handoff Port Data", ["pc"]);
    const mpq = random(4096, 91);
    const port = way(pcGame, plan("Handoff Port Of PC", "port", content("pc", ["mpq"], [sha1(mpq)], "DIABDAT.MPQ")));
    expect((await upload(pcGame, mpq, "DIABDAT.MPQ")).body.attached).toEqual([port.id]);
  });

  test("a PC way that checks no hashes takes its data sent for no way when the game is on no console, and not otherwise", async () => {
    const pcGame = game("Handoff Hashless Port", ["pc"]);
    const port = (await call(`/api/v1/game/${pcGame.id}/ways`, post({ planId: plan("Handoff Hashless DevilutionX", "port", content("pc", ["mpq"], [], "DIABDAT.MPQ", [pcGame.name])).id }))).body.item;
    const r = await upload(pcGame, random(4096, 111), "DIABDAT.MPQ");
    expect(r.body.attached).toEqual([port.id]);
    expect(getWay(port.id)!.content_id).toBe(r.body.item.id);
    // a game on a console too: an .iso of no known platform could be either's, so the PC way is told how to take it
    const mixed = game("Handoff Hashless Mixed", ["pc", "ps2"]);
    const pcWay = (await call(`/api/v1/game/${mixed.id}/ways`, post({ planId: plan("Handoff Hashless Mixed Port", "port", content("pc", ["iso"], [], "game.iso", [mixed.name])).id }))).body.item;
    const m = await upload(mixed, random(4096, 121), "Mixed Disc.iso");
    expect(m.body.attached).toEqual([]);
    expect(m.body.checks).toEqual([{ wayId: pcWay.id, plan: "Handoff Hashless Mixed Port", ok: false, why: "a file of no known platform, and this needs a pc one: take it in for this way, or with its platform" }]);
  });
});

describe("a console copy the hand-off refused (e2e-2)", () => {
  // a build takes the game file from the console copy (other files stub this out)
  let stubbed: typeof adeps.contentFromPackage;
  beforeAll(() => { stubbed = adeps.contentFromPackage; adeps.contentFromPackage = contentFromConsoleCopy; });
  afterAll(() => { adeps.contentFromPackage = stubbed; });
  /** an import of one dump for the game, as POST /api/v1/import makes it: the game's console copy */
  async function importDump(g: GameRow, file: string, bytes: Uint8Array) {
    const input = mkdtempSync(join(tmp, "dl-"));
    writeFileSync(join(input, file), bytes);
    rdeps.importers = () => [{ impl: "recipes", name: "copy", importer: { probe: async () => true, run: async (ctx: any) => {
      cpSync(ctx.input, ctx.staging, { recursive: true });
      return { ok: true, shape: "folder" as const, reason: null, platform: "n64", validation: await inspectRom(ctx.staging) };
    } } }];
    const j = stmts.insertJob.get(null, null, g.id, input) as JobRow;
    await runJob(j.id);
    const done = stmts.jobById.get(j.id) as JobRow;
    expect([done.state, done.message]).toEqual(["done", expect.stringMatching(/^ready:/)]);
    return done;
  }
  const queuedBuilds = (wayId: number) => (db.query("SELECT spec_json FROM jobs WHERE kind='assemble' AND state='queued'").all() as { spec_json: string }[]).filter(r => JSON.parse(r.spec_json).wayId === wayId).length;
  const portWay = async (g: GameRow, name: string, dump: Uint8Array) =>
    (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan(name, "port", content("n64", ["z64"], [sha1(dump)], "rom.z64", [g.name])).id }))).body.item;
  const wayView = async (g: GameRow, wayId: number) => (await call(`/api/v1/game/${g.id}/ways`)).body.items.find((i: { id: number }) => i.id === wayId);

  test("a way that checks by hash offers no build from it, a build never makes it the way's file, and the right dump still reaches the way", async () => {
    const g = game("Handoff Refused Copy", ["n64"]);
    const right = n64Dump(201), wrong = n64Dump(202);
    const w = (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan("Handoff Refused Port", "port", content("n64", ["z64"], [sha1(right)], "rom.z64", [g.name])).id }))).body.item;
    const first = await importDump(g, "Refused Copy (USA).z64", wrong);
    expect(first.transcript).toContain("the dump is no game file for Handoff Refused Port");
    expect(keptRows(g.id)).toEqual([]);                                      // nothing written for a dump no way takes
    // what the page shows agrees with what a build would do: no build from that copy
    const item = (await call(`/api/v1/game/${g.id}/ways`)).body.items[0];
    expect(item).toMatchObject({ status: "needs-files", contentId: null, fromConsoleCopy: false, canBuild: false });
    expect(item.blockers.map((b: { code: string }) => b.code)).toEqual(["file"]);
    expect((await call(`/api/v1/way/${w.id}/build`, post({}))).status).toBe(409);
    // a build queued anyway (before the hand-off, say) stops on the copy, with the copy's own words, and keeps it off the way
    const b = enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id });
    await runJob(b.id);
    expect(stmts.jobById.get(b.id)).toMatchObject({ state: "failed", message: expect.stringMatching(/^the game's copy on the server is not the version this needs/) });
    expect(getWay(w.id)).toMatchObject({ content_id: null, status: "needs-files" });
    expect(keptRows(g.id)).toEqual([]);
    // the right dump arrives: it is handed over to the way (by a link), and the way's build is queued
    await importDump(g, "Refused Copy (USA) (Rev 1).z64", right);
    const file = getWay(w.id)!.content_id;
    expect(file).not.toBeNull();
    expect(getContent(file!)).toMatchObject({ source: "package" });
    expect(lstatSync(getContent(file!)!.path).nlink).toBe(2);
    expect(queuedBuilds(w.id)).toBe(1);
  });

  test("a dump imported before the way was added is judged where it lies: the way offers its build, which reads the copy's hash then", async () => {
    const g = game("Handoff Copy Unseen", ["n64"]);
    const dump = n64Dump(211);
    const done = await importDump(g, "Unseen (USA).z64", dump);              // no way then: nothing was handed over or kept
    expect(done.transcript).not.toContain("reading the dump");
    expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
    expect(copyFacts(g.id)).toMatchObject({ kind: "rom", shape: "file", name: "Unseen (USA).z64", platform: "n64" });
    const w = (await call(`/api/v1/game/${g.id}/ways`, post({ planId: plan("Handoff Unseen Port", "port", content("n64", ["z64"], [sha1(dump)], "rom.z64", [g.name])).id }))).body.item;
    expect(w).toMatchObject({ contentId: null, fromConsoleCopy: true, canBuild: true, status: "ready" });
    expect(copyServes(g.id, content("n64", ["z64"], [sha1(dump)]))).toMatchObject({ serves: "direct", why: expect.stringMatching(/if its sha1 is one the way accepts: that is read as the copy is taken$/) });
  });

  test("a way ready on a copy nobody read needs its file, in the copy's own words, once the hand-off refuses the next dump", async () => {
    const g = game("Handoff Copy Replaced", ["n64"]);
    await importDump(g, "Replaced (USA).z64", n64Dump(221));                 // before the way: nothing handed over or kept
    const w = await portWay(g, "Handoff Replaced Port", n64Dump(220));
    expect(w).toMatchObject({ status: "ready", fromConsoleCopy: true, canBuild: true });
    const second = await importDump(g, "Replaced (USA) (Rev 9).z64", n64Dump(222));
    expect(second.transcript).toContain("the dump is no game file for Handoff Replaced Port");
    expect(await wayView(g, w.id)).toMatchObject({
      status: "needs-files", statusNote: `needs the game file (a n64 file): the game's copy Replaced (USA) (Rev 9).z64 is not the version this needs (its sha1 is ${sha1(n64Dump(222))})`,
      contentId: null, fromConsoleCopy: false, canBuild: false,
    });
    expect(queuedBuilds(w.id)).toBe(0);
  });

  test("a build that reads the copy and refuses it: the copy's hash, read once, tells the game's other ways too, and nothing stays in the store", async () => {
    const g = game("Handoff Copy Refused Build", ["n64"]);
    const dump = n64Dump(231), other = n64Dump(232);
    await importDump(g, "Refused Build (USA).z64", dump);
    const refuses = await portWay(g, "Handoff Refused Build X", other), alsoNot = await portWay(g, "Handoff Refused Build Y", other);
    const takes = await portWay(g, "Handoff Refused Build Z", dump);
    expect([refuses.status, alsoNot.status, takes.status]).toEqual(["ready", "ready", "ready"]);      // its hash is not read yet
    const b = (await call(`/api/v1/way/${refuses.id}/build`, post({}))).body.job;
    await runJob(b.id);
    expect(stmts.jobById.get(b.id)).toMatchObject({ state: "failed", message: expect.stringMatching(/^the game's console copy .*\.z64 is not the version this needs/) });
    expect(keptRows(g.id)).toEqual([]);                                      // the link it made to read it is gone again
    expect(await wayView(g, refuses.id)).toMatchObject({ status: "needs-files", canBuild: false });
    expect(await wayView(g, alsoNot.id)).toMatchObject({ status: "needs-files", statusNote: expect.stringMatching(/^needs the game file \(a n64 file\): the game's copy Refused Build \(USA\)\.z64 is not the version this needs/), fromConsoleCopy: false, canBuild: false });
    expect(await wayView(g, takes.id)).toMatchObject({ status: "ready", fromConsoleCopy: true, canBuild: true });
  });

  test("a build that takes the copy: linked in and read where it lies once; the game's other ways the copy is no file for need theirs", async () => {
    const g = game("Handoff Copy Taken Build", ["n64"]);
    const dump = n64Dump(241), other = n64Dump(242);
    await importDump(g, "Taken Build (USA).z64", dump);
    const takes = await portWay(g, "Handoff Taken Build X", dump), not = await portWay(g, "Handoff Taken Build Y", other);
    expect([takes.status, not.status]).toEqual(["ready", "ready"]);
    // the build takes the copy as its file, then stops at the program (no release here: nothing is downloaded)
    const real = prdeps.latestRelease;
    prdeps.latestRelease = async () => null;
    try {
      const b = (await call(`/api/v1/way/${takes.id}/build`, post({}))).body.job;
      await runJob(b.id);
      expect(stmts.jobById.get(b.id)).toMatchObject({ state: "failed" });
      expect((stmts.jobById.get(b.id) as JobRow).transcript).toContain("by a hard link, hashed where it lies");
    } finally { prdeps.latestRelease = real; }
    const kept = getContent(getWay(takes.id)!.content_id!)!;
    expect(kept).toMatchObject({ source: "package" });
    expect(lstatSync(kept.path).nlink).toBe(2);
    expect(await wayView(g, not.id)).toMatchObject({ status: "needs-files", statusNote: expect.stringMatching(/^needs the game file \(a n64 file\): the game's copy Taken Build \(USA\)\.z64 is not the version this needs/), fromConsoleCopy: false, canBuild: false });
  });

  test("the copy's verdict is its own bytes': a kept file removed changes nothing, and a new dump is judged afresh", async () => {
    const g = game("Handoff Copy Removed", ["n64"]);
    const right = n64Dump(250);
    const w = await portWay(g, "Handoff Removed Port", right);
    await importDump(g, "Removed (USA).z64", n64Dump(251));                  // refused by the hand-off: nothing kept
    expect(await wayView(g, w.id)).toMatchObject({ status: "needs-files", canBuild: false });
    expect(keptRows(g.id)).toEqual([]);
    // an upload of the very same bytes is kept (the admin's own file) and removed again: the copy is still not the version
    const up = await upload(g, n64Dump(251), "Removed (USA).z64");
    expect(up.status).toBe(201);
    expect((await call(`/api/v1/content/${up.body.item.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await wayView(g, w.id)).toMatchObject({ status: "needs-files", fromConsoleCopy: false, canBuild: false });
    // the right dump: a new package, judged afresh, handed to the way
    await importDump(g, "Removed (USA) (Rev 1).z64", right);
    expect(getWay(w.id)!.content_id).not.toBeNull();
  });
});
