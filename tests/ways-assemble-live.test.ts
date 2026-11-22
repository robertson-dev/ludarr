/**
 * The live cases where they meet building and placing (DESIGN3's table of the three cases; AMEND "Live facts"):
 *
 *   Demon's Souls (game 21, KytyPS5's way 1): the game's copy is the sealed 54.2 GB retail disc image, kept a second time as
 *   content row 1, and the way takes one .zar of PPSA01341. The user pressed Build and saw it stuck at "1 % starting" while
 *   54 GB were copied and hashed for a refusal. Now a Build says why in seconds and takes, copies, reads, downloads and
 *   reserves nothing; a dump made into a .zar later is linked into the package and never read again.
 *   Ocarina of Time (game 48, NX2navi) is in tests/runner-lanes.test.ts (its running download beside the way's build) and
 *   tests/ways-kit-build.test.ts; Zelda 64: Recompiled's check the server cannot start is in tests/ways-assemble-checks.test.ts.
 *
 * The fakes: the copy's verdict (src/ways/copy.ts) and the hand-over, the release host, 7z in the sandbox, the link itself.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { events } from "../src/events";
import { ensureDefaultRootFolder, rootFolderFor } from "../src/library/rootfolders";
import { enqueueJob, jobKinds } from "../src/process/kinds";
import { runJob } from "../src/process/runner";
import { vdeps } from "../src/process/validate";
import { pdeps } from "../src/process/deps";
import { adeps } from "../src/ways/assemble";
import { forgetLinkProbes, pldeps, prdeps } from "../src/ways/program";
import { sbdeps } from "../src/ways/sandbox";
import { getWay, insertContent, insertPlan, insertWay, updateWay, wstmts, type ContentRow } from "../src/ways/store";
import { validatePlanSpec, validateWayContent } from "../src/ways/validate";
import type { ContentPlan, HashedStat, RuntimePlanSpec } from "../src/ways/types";
import { bytes, fake7z, releaseHost, restoreDeps, sha1, sha256, tempConfig, tools7z } from "./ways-fixtures";

const KYTY = "KytyPS5-v20261108.zip", KYTY_URL = `https://github.com/chenxiao07/KytyPS5/releases/download/v20261108/${KYTY}`;
const KYTY_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(3000, 4)]);
const RELEASE = { tag: "v20261108", name: "v20261108", date: "2026-11-08", prerelease: false, page: "p", immutable: false, asset: { name: KYTY, url: KYTY_URL, size: KYTY_ZIP.byteLength, digest: `sha256:${sha256(KYTY_ZIP)}` } };
/** the copy's own words (src/ways/copy.ts copyServes, DESIGN3's trace) */
const SEALED = "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it";
const ISO = "bbb-ps5-01342.iso", ISO_SIZE = 54.2e9, ISO_SHA = "5e".repeat(32);

/** the Windows release zip as KytyPS5 ships it: one top folder */
function kyty(out: string) {
  const top = join(out, "KytyPS5-v20261108");
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, "kyty_emulator.exe"), bytes(20_000, 1));
  writeFileSync(join(top, "KytyLauncher.exe"), bytes(5_000, 2));
  writeFileSync(join(top, "kyty_shader_precompile.exe"), bytes(10_000, 3));
}
/** plan 3 as it is live: an emulator plan, the launcher started with --play, its settings file seeded */
const kytySpec = (): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^KytyPS5-v\\d+[.]zip$", channel: "stable" },
  launch: { exe: "KytyLauncher.exe", argv: ["--play"] },
  content: { kind: "disc", platform: "ps5", what: "a PS5 game packed as one .zar", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"] }, normalize: null, place: "game/PPSA01341-app0.zar" },
  files: [{ path: "launcher-settings.json", text: "{\"game\":\"game\\\\PPSA01341-app0.zar\"}" }], setup: [], needs: [], keep: ["_SaveData/**"], seed: ["launcher-settings.json"], firstRun: null, notes: "",
});
/** way 1's own content as the live way has it: one .zar of PPSA01341, no make, no versions */
const way1Content = (): ContentPlan => ({ kind: "disc", platform: "ps5", what: "Demon's Souls (Europe, PPSA01341), its app0 folder packed as one .zar", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, normalize: null, place: "game/PPSA01341-app0.zar" });
/** the same with the make an upgrade round gives it: the app0 folder picked and packed with ZArchive */
const way1WithMake = (): ContentPlan => ({
  ...way1Content(),
  make: {
    input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", also: ["eboot.bin"], serials: ["PPSA01341"] },
    steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, { convert: { with: "zarchive", argv: ["{prep}/app0", "{out}"], timeoutSec: 7200 } }],
    output: { shape: "file", name: "{serial}-app0.zar" },
  },
});
const statOf = (path: string): HashedStat => { const s = lstatSync(path); return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, dev: s.dev, ino: s.ino }; };

let seq = 0;
/**
 * Game 21 as it is live: Demon's Souls, its package the sealed ISO (a console copy, 54.2 GB by its manifest; a few bytes
 * on disk here), content row 1 the same disc kept a second time (source 'package'), plan 3 ready, way 1 with its own
 * content and no file
 */
function demonsSouls(o: { content?: ContentPlan } = {}) {
  seq++;
  const game = upsertGame({ steam_appid: 989_000 + seq, name: "Demon's Souls", slug: `demons-souls-${seq}` }) as GameRow;
  const root = rootFolderFor(game)!.path;
  const copyDir = join(root, `demons-souls-copy-${seq}`);
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, ISO), bytes(64 * 1024, 7));
  const manifest = { schema: 1, name: game.name, slug: game.slug, version: null, launch: { exe: ISO, args: "", cwd: "" }, prerequisites: [], files: [{ path: ISO, size: ISO_SIZE, sha256: ISO_SHA }], totalSize: ISO_SIZE, source: { title: "Demons.Souls.PS5-BigBlueBox", group: "BigBlueBox", protocol: "torrent", indexer: null }, tier: "deterministic", notes: null, kind: "rom", platform: "ps5", createdAt: "" };
  const copy = stmts.insertPackage.get(game.id, null, copyDir, game.name, null, ISO_SIZE, JSON.stringify(manifest)) as PackageRow;
  const store = join(root, ".ahoy-content", `demons-souls-${seq}`);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, ISO), bytes(64 * 1024, 7));
  const row1 = insertContent({ gameId: game.id, platform: "ps5", name: ISO, path: join(store, ISO), size: ISO_SIZE, hashes: { sha256: ISO_SHA }, source: "package" });
  const plan = validatePlanSpec(kytySpec(), "emulator");
  if (!plan.ok) throw new Error(`the KytyPS5 plan does not validate: ${plan.errors.join("; ")}`);
  const own = validateWayContent(o.content ?? way1Content(), "emulator");
  if (!own.ok) throw new Error(`way 1's content does not validate: ${own.errors.join("; ")}`);
  const p = insertPlan({ name: `KytyPS5 (chenxiao07 Demon's Souls fork) ${seq}`, kind: "emulator", repo: "chenxiao07/KytyPS5", platforms: ["ps5"], spec: plan.value!, status: "ready", author: "ai" });
  const way = insertWay({ gameId: game.id, planId: p.id, content: own.value!, status: "needs-files" });
  return { game, plan: p, way, copy, row1, store };
}
/** a build of the way, with every 'build' message it said */
async function build(wayId: number): Promise<{ job: JobRow; said: string[] }> {
  const j = enqueueJob({ kind: "assemble", wayId }, { gameId: getWay(wayId)!.game_id });
  const said: string[] = [];
  const off = events.subscribe(e => { const d = e.data as { id?: number; message?: string } | null; if (e.event === "build" && d?.id === j.id && d.message) said.push(d.message); });
  try { await runJob(j.id); } finally { off(); }
  return { job: stmts.jobById.get(j.id) as JobRow, said };
}
const rowsOf = (gameId: number) => (wstmts.contentsForGame.all(gameId) as ContentRow[]).map(r => [r.id, r.size, r.path, r.source]);

let cfg: ReturnType<typeof tempConfig>;
let host: ReturnType<typeof releaseHost>;
let reads: string[] = [];
const realAdeps = { ...adeps }, realSha = vdeps.sha256, realLink = pldeps.link;
const EXDEV = async () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };
beforeAll(() => { cfg = tempConfig(); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  reads = [];
  pdeps.log = () => {};
  pdeps.tools = () => tools7z;
  sbdeps.platform = () => "win32";
  sbdeps.exec = fake7z({ [KYTY]: kyty });
  host = releaseHost({ [KYTY_URL]: KYTY_ZIP });
  prdeps.latestRelease = async () => RELEASE;
  Object.assign(adeps, realAdeps);
  adeps.contentFromPackage = async () => { throw new Error("the hand-over was asked to take the copy"); };
  vdeps.sha256 = async (path, onBytes, signal) => { reads.push(path); return realSha(path, onBytes, signal); };
  pldeps.link = realLink;
  forgetLinkProbes();
});
afterEach(() => { restoreDeps(); Object.assign(adeps, realAdeps); vdeps.sha256 = realSha; pldeps.link = realLink; forgetLinkProbes(); });

describe("Demon's Souls: the copy on the server is the sealed retail disc", () => {
  test("a Build press is refused in seconds with the copy's own words: nothing taken, copied, read, downloaded or reserved for it", async () => {
    const d = demonsSouls();
    let judged = 0;
    adeps.copyServes = () => ({ serves: "no", why: SEALED });
    adeps.judgeCopy = async () => { judged++; return null; };
    const t0 = Date.now();
    const { job, said } = await build(d.way.id);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(job).toMatchObject({ state: "failed", message: `the game's copy on the server is ${SEALED}` });
    expect(JSON.parse(job.fail_json!)).toEqual({ class: "file" });
    expect(getWay(d.way.id)).toMatchObject({ status: "needs-files", status_note: job.message, content_id: null });
    expect(judged).toBe(0);                                              // judged already: its verdict was known
    expect(host.seen).toEqual([]);                                       // not even the program was downloaded
    expect(reads).toEqual([]);                                           // nothing was hashed
    expect(said[0]).toBe("looking at the way and its game file");        // its first word says what it does
    // content row 1 is as it was: the second copy is kept, and nothing was copied again beside it
    expect(rowsOf(d.game.id)).toEqual([[d.row1.id, ISO_SIZE, d.row1.path, "package"]]);
    expect((stmts.packageForGame.get(d.game.id) as PackageRow).id).toBe(d.copy.id);
  });

  test("its scratch: nothing reserved for a copy that never serves, even where hard links do not work (it would wait for 108 GB)", async () => {
    const d = demonsSouls();
    const scratch = jobKinds.get("assemble")!.scratch!;
    pldeps.link = EXDEV;
    forgetLinkProbes();
    adeps.copyServes = () => ({ serves: "no", why: SEALED });
    expect(await scratch({} as JobRow, { kind: "assemble", wayId: d.way.id })).toBe(2e9);
    adeps.copyServes = () => ({ serves: "make", why: "" });
    expect(await scratch({} as JobRow, { kind: "assemble", wayId: d.way.id })).toBe(2e9);
    // a copy that is the way's file as it is: taken and placed by copies where links do not work (and the program)
    adeps.copyServes = () => ({ serves: "direct", why: "" });
    expect(await scratch({} as JobRow, { kind: "assemble", wayId: d.way.id })).toBe(3 * 300e6 + 2 * ISO_SIZE);
  });

  test("the ISO itself as the way's file (what the old hand-over kept): refused by its form, read and copied by nothing", async () => {
    const d = demonsSouls();
    updateWay(d.way.id, { contentId: d.row1.id });
    const { job } = await build(d.way.id);
    expect(job).toMatchObject({ state: "failed", message: `the game file ${ISO} is a .iso file, and this needs .zar` });
    expect([reads, host.seen]).toEqual([[], []]);
    expect(rowsOf(d.game.id)).toEqual([[d.row1.id, ISO_SIZE, d.row1.path, "package"]]);
  });

  test("a copy not looked at yet whose look fails is still refused by what its manifest names, before anything is taken", async () => {
    const d = demonsSouls();
    adeps.copyServes = () => ({ serves: "unknown", why: "looking at the game's copy" });
    adeps.judgeCopy = async () => { throw new Error("the disc reader stopped"); };
    const { job } = await build(d.way.id);
    expect(job).toMatchObject({ state: "failed", message: "the game's copy on the server is a .iso file, and this needs .zar" });
    expect(job.transcript).toMatch(/the game's copy could not be looked at where it is \(the disc reader stopped\)/);
    expect([reads, host.seen]).toEqual([[], []]);
  });

  test("with a dump it can make the .zar from (an inbox drop kept as an input), the build waits for the make; one already making it is named", async () => {
    const d = demonsSouls({ content: way1WithMake() });
    const app0 = join(d.store, "PPSA01341-app0");
    mkdirSync(join(app0, "sce_sys"), { recursive: true });
    writeFileSync(join(app0, "eboot.bin"), "eboot");
    writeFileSync(join(app0, "sce_sys", "param.json"), "{\"titleId\":\"PPSA01341\",\"contentVersion\":\"01.007.000\"}");
    insertContent({ gameId: d.game.id, platform: "ps5", name: "PPSA01341-app0", path: app0, size: 44, hashes: { sha256: "c".repeat(64) }, source: "inbox", shape: "folder" });
    adeps.copyServes = () => ({ serves: "no", why: SEALED });
    adeps.inputMatches = (input, f) => ({ ok: input.shape === "folder" && f.shape === "folder", why: null });
    const first = (await build(d.way.id)).job;
    expect(first).toMatchObject({ state: "failed", message: "its game file is made from PPSA01341-app0 first (a make job does that, then the way is built)" });
    expect(JSON.parse(first.fail_json!)).toEqual({ class: "file" });
    adeps.making = () => ({ id: 4242 }) as JobRow;
    expect((await build(d.way.id)).job.message).toBe("its game file is being made (job 4242)");
    expect(host.seen).toEqual([]);
  });

  test("a game folder attached to a way that takes one .zar is never placed", async () => {
    const d = demonsSouls();
    const app0 = join(d.store, "PPSA01341-app0");
    mkdirSync(join(app0, "sce_sys"), { recursive: true });
    writeFileSync(join(app0, "eboot.bin"), "eboot");
    const row = insertContent({ gameId: d.game.id, platform: "ps5", name: "PPSA01341-app0", path: app0, size: 5, hashes: { sha256: "c".repeat(64) }, source: "path", shape: "folder" });
    updateWay(d.way.id, { contentId: row.id });
    const { job } = await build(d.way.id);
    expect(job).toMatchObject({ state: "failed", message: "the game file PPSA01341-app0 is a folder, and this way takes one file" });
    expect(host.seen).toEqual([]);
  });

  test("once a dump is made into one .zar, it is linked into the package and never read again; the emulator's own settings ship with it", async () => {
    const d = demonsSouls();
    const zar = bytes(512 * 1024, 3), zarPath = join(d.store, "PPSA01341-app0.zar");
    writeFileSync(zarPath, zar);
    const made = insertContent({ gameId: d.game.id, platform: "ps5", name: "PPSA01341-app0.zar", path: zarPath, size: zar.byteLength, hashes: { sha1: sha1(zar), sha256: sha256(zar) }, source: "made", stat: statOf(zarPath), made: { from: { kind: "kept", contentId: d.row1.id, digest: "d".repeat(64) }, recipe: "{}", tools: ["d2c717730092c7bf8cbb033b12fd4001b7c4d932"], key: "e".repeat(64), at: 0 } });
    updateWay(d.way.id, { contentId: made.id });
    adeps.copyServes = () => ({ serves: "no", why: SEALED });
    const { job, said } = await build(d.way.id);
    expect(job.state).toBe("done");
    expect(said).toContain("linking the game file into the package");
    const pkg = stmts.packageForGame.get(d.game.id) as PackageRow;
    const placed = join(pkg.path, "game", "PPSA01341-app0.zar");
    expect([lstatSync(placed).ino, lstatSync(placed).nlink >= 2]).toEqual([lstatSync(zarPath).ino, true]);
    expect(reads.some(p => p.endsWith(".zar"))).toBe(false);
    const m = JSON.parse(pkg.manifest_json);
    expect(m).toMatchObject({ kind: "emulated", platform: "ps5", launch: { exe: "KytyLauncher.exe", argv: ["--play"] }, seed: ["launcher-settings.json", "_SaveData/**"] });
    expect(m.files.find((x: { path: string }) => x.path === "game/PPSA01341-app0.zar").sha256).toBe(sha256(zar));
    expect(m.files.map((x: { path: string }) => x.path)).toContain("launcher-settings.json");
    // the made file and the kept second copy stay in the store; the way's package took the game's place
    expect([existsSync(zarPath), existsSync(d.row1.path)]).toEqual([true, true]);
    expect(pkg.id).not.toBe(d.copy.id);
    expect(getWay(d.way.id)).toMatchObject({ status: "built", package_id: pkg.id });
  });
});

describe("a made .zar on a share without hard links", () => {
  test("it is copied once with real progress, hashed as it is written, and not read again for the manifest", async () => {
    pldeps.link = EXDEV;
    const d = demonsSouls();
    const zar = bytes(3 * 1024 * 1024, 6), zarPath = join(d.store, "PPSA01341-app0.zar");
    writeFileSync(zarPath, zar);
    const made = insertContent({ gameId: d.game.id, platform: "ps5", name: "PPSA01341-app0.zar", path: zarPath, size: zar.byteLength, hashes: { sha1: sha1(zar), sha256: sha256(zar) }, source: "made", stat: statOf(zarPath) });
    updateWay(d.way.id, { contentId: made.id });
    adeps.copyServes = () => ({ serves: "no", why: SEALED });
    const { job, said } = await build(d.way.id);
    expect(job.state).toBe("done");
    expect(said).toContain("placing the game file · 0 of 3 MB");
    expect(said).toContain("placing the game file · 3 of 3 MB");
    expect(reads.some(p => p.endsWith(".zar"))).toBe(false);
    const pkg = stmts.packageForGame.get(d.game.id) as PackageRow;
    expect(lstatSync(join(pkg.path, "game", "PPSA01341-app0.zar")).ino).not.toBe(lstatSync(zarPath).ino);
  });
});
