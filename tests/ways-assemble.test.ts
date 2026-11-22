import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { events } from "../src/events";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { classOfPackage, wantsUpgrade, DEFAULT_PROFILE } from "../src/library/profiles";
import { adeps, inside, serverPathIn, setIni } from "../src/ways/assemble";
import { ckdeps } from "../src/ways/check";
import { getContent, getPlan, getWay, insertContent, insertPlan, insertWay, planPinned, updatePlan, updateWay } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import { enqueueJob, jobKinds } from "../src/process/kinds";
import { activeJobs, cancelJob, processTick, rdeps, replaceRefusal, resumeJobs, runJob } from "../src/process/runner";
import { buildManifest, inspectRom, type Validation } from "../src/process/validate";
import { runUnderWine } from "../src/process/scene";
import { pdeps } from "../src/process/deps";
import { sbdeps } from "../src/ways/sandbox";
import { prdeps, toolsDir } from "../src/ways/program";
import type { PlanKind, RuntimePlanSpec } from "../src/ways/types";
import { bytes, dirLink, fake7z, ok, releaseHost, restoreDeps, sha1, sha256, tempConfig, tmp, tools7z, zelda, type Call } from "./ways-fixtures";
import { copyFactsOf } from "./fakes-w3";

const ASSET = "Zelda64Recompiled-v1.2.2-Windows.zip", PCSX2 = "pcsx2-v2.8.2-windows-x64-Qt.7z";
const URL_ = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.2/${ASSET}`, PCSX2_URL = `https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/${PCSX2}`;
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(4000, 7)]), SEVEN = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, ...bytes(4000, 8)]);
const ARCHIVES: Record<string, Uint8Array> = { [URL_]: ZIP, [PCSX2_URL]: SEVEN };
const relFor = (asset: string, url: string, data: Uint8Array, tag: string) => ({ tag, name: tag, date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: asset, url, size: data.byteLength, digest: `sha256:${sha256(data)}` } });

/** Zelda 64: Recompiled as a plan: a pre-placed ROM, portable mode, saves kept */
const mmSpec = (sha: string, over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "Zelda64Recompiled.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "Majora's Mask, NTSC-U 1.0", search: ["The Legend of Zelda: Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha }], formats: ["z64"] }, normalize: "n64-z64", place: "mm.n64.us.1.0.z64" },
  files: [{ path: "portable.txt", text: "" }], setup: [], needs: [], keep: ["saves/**", "*.json"], seed: [], firstRun: null,
  notes: "PRIVATE-NOTES: the AI found the hash in main.cpp", ...over,
});
/** PCSX2 as an emulator plan: any PS2 disc image, the game file handed over in argv */
const emuSpec = (over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "windows-x64-Qt\\.7z$", channel: "stable" },
  launch: { exe: "pcsx2-qt.exe", argv: ["-batch", "--", "{content}"], env: { PCSX2_NOUPDATE: "1" } },
  content: { kind: "disc", platform: "ps2", what: "a PS2 disc image", search: ["ps2"], accept: { hashes: [], formats: ["iso"] }, normalize: null, place: "games/{name}" },
  files: [{ path: "portable.ini", text: "" }], setup: [], needs: [], keep: ["memcards/**", "inis/**"], seed: ["inis/PCSX2.ini"], firstRun: null, notes: "", ...over,
});
function pcsx2(out: string) {
  mkdirSync(join(out, "resources"), { recursive: true }); mkdirSync(join(out, "docs"), { recursive: true });
  writeFileSync(join(out, "pcsx2-qt.exe"), bytes(200_000, 3));
  writeFileSync(join(out, "pcsx2-qt.pdb"), bytes(5000, 4));
  writeFileSync(join(out, "resources", "fonts.ttf"), bytes(1000, 5));
  writeFileSync(join(out, "docs", "readme.txt"), "read me");
}

let seq = 0;
/** a game, its game file on disk and in the store, a ready plan and a way that has the file */
function fixture(o: { spec?: RuntimePlanSpec; kind?: PlanKind; rom?: Uint8Array; romName?: string; status?: "draft" | "ready" | "broken"; noFile?: boolean } = {}) {
  seq++;
  const game = upsertGame({ steam_appid: 996000 + seq, name: `Way Test ${seq}`, slug: `way-test-${seq}` }) as GameRow;
  const rom = o.rom ?? bytes(64 * 1024, 9);
  const dir = tmp("way-content-");
  const romPath = join(dir, o.romName ?? "Legend of Zelda, The - Majora's Mask (USA).z64");
  writeFileSync(romPath, rom);
  const kind = o.kind ?? "recomp";
  const raw = o.spec ?? mmSpec(sha1(rom));
  const checked = validatePlanSpec(raw, kind);
  if (!checked.ok) throw new Error(`fixture plan does not validate: ${checked.errors.join("; ")}`);
  const spec = checked.value!;
  const repo = kind === "emulator" ? "PCSX2/pcsx2" : "Zelda64Recomp/Zelda64Recomp";
  const plan = insertPlan({ name: `Plan ${seq}`, kind, repo, platforms: [spec.content?.platform ?? "pc"], spec, status: o.status ?? "ready" });
  const file = o.noFile ? null : insertContent({ gameId: game.id, platform: spec.content?.platform ?? null, name: basename(romPath), path: romPath, size: rom.byteLength, hashes: { sha1: sha1(rom), sha256: sha256(rom) }, source: "upload" });
  let way = insertWay({ gameId: game.id, planId: plan.id, status: "ready" });
  if (file) way = updateWay(way.id, { contentId: file.id })!;
  return { game, plan, way, file, rom, romPath };
}
async function build(wayId: number, o: { replace?: boolean; repin?: boolean } = {}): Promise<JobRow> {
  const way = getWay(wayId)!;
  const j = enqueueJob({ kind: "assemble", wayId, ...o }, { gameId: way.game_id });
  await runJob(j.id);
  return stmts.jobById.get(j.id) as JobRow;
}
const manifestOf = (p: PackageRow) => JSON.parse(p.manifest_json);
const pkgOf = (gameId: number) => (stmts.packageForGame.get(gameId) as PackageRow | null) ?? undefined;
/** a game's PC copy (or a console dump) as an import leaves it */
function packageFor(gameId: number, kind: "native" | "rom" = "native"): PackageRow {
  const dir = join(process.env.AHOY_LIBRARY!, `copy-${gameId}-${kind}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Game.exe"), "x");
  const m = { schema: 1, name: "G", slug: "g", version: null, launch: { exe: "Game.exe", args: "", cwd: "" }, prerequisites: [], files: [{ path: "Game.exe", size: 1, sha256: sha256("x") }], totalSize: 1, source: null, tier: "deterministic", kind, platform: null, notes: null, createdAt: "" };
  return stmts.insertPackage.get(gameId, null, dir, "G", null, 1, JSON.stringify(m)) as PackageRow;
}
async function settle(...ids: number[]) {
  for (let i = 0; i < 400; i++) {
    if (ids.every(id => !["queued", "running"].includes((stmts.jobById.get(id) as JobRow | undefined)?.state ?? "done")) && activeJobs() === 0) break;
    await Bun.sleep(25);
  }
  await Bun.sleep(50);
}

/** the assemble hooks as they are, put back before each test (a test swaps the copy's verdict, the checks …) */
const realAdeps = { ...adeps };
let cfg: ReturnType<typeof tempConfig>;
let host: ReturnType<typeof releaseHost>;
let calls: Call[];
let other: ((c: string[], opts: any) => any) | null;
let wineDir: string;
beforeAll(() => { cfg = tempConfig(); wineDir = tmp("way-wine-"); writeFileSync(join(wineDir, "wine"), ""); writeFileSync(join(wineDir, "wineserver"), ""); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  calls = []; other = null;
  pdeps.log = () => {};
  pdeps.tools = () => ({ ...tools7z, wine: join(wineDir, "wine"), xvfb: "xvfb-run" });
  sbdeps.platform = () => "win32";                                       // a dev box: no sandbox (run steps need the owner's say-so)
  sbdeps.exec = fake7z({ [ASSET]: zelda, [PCSX2]: pcsx2 }, { calls, other: (c, opts) => other?.(c, opts) ?? null });
  host = releaseHost(ARCHIVES);
  prdeps.latestRelease = async repo => (/pcsx2/i.test(repo) ? relFor(PCSX2, PCSX2_URL, SEVEN, "v2.8.2") : relFor(ASSET, URL_, ZIP, "v1.2.2"));
  Object.assign(adeps, realAdeps, { contentFromPackage: async () => null });
});
afterEach(() => { restoreDeps(); delete process.env.LUDARR_ALLOW_UNSANDBOXED; delete process.env.WAYS_PARALLEL; delete process.env.IMPORT_PARALLEL; delete process.env.LIBRARY_KEEP_FREE_GB; });

describe("building a way", () => {
  test("a recomp: program from its lone folder, the verified ROM in place, the plan's files, a manifest from what is in STAGING", async () => {
    const f = fixture();
    const seen: string[] = [];
    const off = events.subscribe(e => seen.push(e.event));
    const job = await build(f.way.id);
    off();
    expect(job).toMatchObject({ state: "done", kind: "assemble", input_path: `way:${f.way.id}` });
    const pkg = pkgOf(f.game.id)!;
    expect(job.output_path).toBe(pkg.path);
    const m = manifestOf(pkg);
    expect(m).toMatchObject({
      kind: "recomp", name: f.game.name, slug: f.game.slug, version: "1.2.2", platform: "n64", tier: "deterministic", notes: null,
      source: { title: f.game.name, group: null, protocol: "way", indexer: null }, requires: { launcher: "0.10.0" }, keep: ["saves/**", "*.json"],
      launch: { exe: "Zelda64Recompiled.exe", args: "", cwd: "", argv: [] },
    });
    expect(m.launch.env).toBeUndefined();
    // what the plan keeps is seeded too: a kept file on a player's PC is never fetched or verified again
    expect(m.seed).toEqual(["saves/**", "*.json"]);
    expect(m.files.map((x: { path: string }) => x.path).sort()).toEqual(["Zelda64Recompiled.exe", "Zelda64Recompiled.pdb", "assets/ui.rml", "mm.n64.us.1.0.z64", "portable.txt"]);
    expect(readFileSync(join(pkg.path, "mm.n64.us.1.0.z64"))).toEqual(Buffer.from(f.rom));
    expect(readFileSync(join(pkg.path, "ahoy.json"), "utf8")).toBe(JSON.stringify(m, null, 2));
    // players' copies say nothing about the engine: no repo, plan, release address or the AI's notes
    const shipped = readFileSync(join(pkg.path, "ahoy.json"), "utf8");
    for (const s of ["Zelda64Recomp/", "PRIVATE-NOTES", f.plan.name, "github.com", ASSET]) expect([s, shipped.includes(s)]).toEqual([s, false]);
    expect(getWay(f.way.id)).toMatchObject({ status: "built", package_id: pkg.id, status_note: null });
    expect(planPinned(getPlan(f.plan.id)!)).toMatchObject({ tag: "v1.2.2", asset: ASSET, sha256: sha256(ZIP), size: ZIP.byteLength });
    for (const e of ["build", "job", "package", "game"]) expect(seen).toContain(e);
    expect(db.query("SELECT event, source FROM history WHERE game_id=?").all(f.game.id)).toEqual([{ event: "imported", source: "way" }]);
    expect(classOfPackage(pkg)).toBe("way");
    // a second build of the same pin downloads nothing and takes the old package's place
    host.seen.length = 0;
    const again = await build(f.way.id);
    expect(again.state).toBe("done");
    expect(host.seen).toEqual([]);
    expect(existsSync(pkg.path)).toBe(false);
    expect(getWay(f.way.id)).toMatchObject({ status: "built", package_id: pkgOf(f.game.id)!.id });
  });

  test("an emulator: {content} becomes {install}/<placed file>, the way's argv and env join the plan's, args only when plain", async () => {
    const f = fixture({ kind: "emulator", spec: emuSpec(), rom: bytes(3000, 1), romName: "God of War II (USA).iso" });
    updateWay(f.way.id, { overrides: { argvExtra: ["-fullscreen"], env: { PCSX2_EXTRA: "{install}/inis" } } });
    expect((await build(f.way.id)).state).toBe("done");
    const pkg = pkgOf(f.game.id)!;
    const m = manifestOf(pkg);
    expect(m).toMatchObject({ kind: "emulated", platform: "ps2", keep: ["memcards/**", "inis/**"], seed: ["inis/PCSX2.ini", "memcards/**", "inis/**"], requires: { launcher: "0.10.0" } });
    expect(m.launch).toEqual({ exe: "pcsx2-qt.exe", args: "", cwd: "", argv: ["-batch", "--", "{install}/games/God_of_War_II_USA.iso", "-fullscreen"], env: { PCSX2_NOUPDATE: "1", PCSX2_EXTRA: "{install}/inis" } });
    expect(existsSync(join(pkg.path, "games", "God_of_War_II_USA.iso"))).toBe(true);
    // plain arguments still reach launchers that only read args
    const g = fixture({ spec: mmSpec("", { content: null, files: [], keep: [], launch: { exe: "Zelda64Recompiled.exe", argv: ["--skip-update-check"] } }) });
    expect((await build(g.way.id)).state).toBe("done");
    expect(manifestOf(pkgOf(g.game.id)!).launch).toMatchObject({ args: "--skip-update-check", argv: ["--skip-update-check"] });
    expect(manifestOf(pkgOf(g.game.id)!).requires).toEqual({ launcher: "0.10.0" });
    // nothing the old launcher cannot do: no requirement
    const h = fixture({ spec: mmSpec("", { content: null, files: [], keep: [] }) });
    expect((await build(h.way.id)).state).toBe("done");
    expect(manifestOf(pkgOf(h.game.id)!).requires).toBeUndefined();
  });

  test("a plan that is not ready is not built, and nothing is downloaded", async () => {
    const f = fixture({ status: "draft" });
    const job = await build(f.way.id);
    expect(job).toMatchObject({ state: "failed", message: expect.stringMatching(/^the plan is draft/) });
    expect(getWay(f.way.id)!.status).toBe("failed");
    expect(host.seen).toEqual([]);
  });

  test("a game file the plan does not accept leaves the way waiting for files and the game's copy as it was", async () => {
    const f = fixture({ spec: mmSpec("1".repeat(40)) });
    const dump = packageFor(f.game.id, "rom");
    const job = await build(f.way.id);
    expect(job.state).toBe("failed");
    expect(job.message).toMatch(/is not the version this needs \(its sha1 is /);
    expect(getWay(f.way.id)).toMatchObject({ status: "needs-files", status_note: job.message });
    expect(pkgOf(f.game.id)!.id).toBe(dump.id);
    expect(existsSync(dump.path)).toBe(true);
    expect(host.seen).toEqual([]);                                      // told before any download
    // the file on disk must still be the one that was checked
    const g = fixture();
    writeFileSync(g.romPath, bytes(10));
    expect((await build(g.way.id)).message).toMatch(/gone from the server, or changed on disk/);
    expect(getWay(g.way.id)!.status).toBe("needs-files");
  });

  test("no game file: the way waits; the game's copy is judged where it is first, and one that serves is taken by the hand-over", async () => {
    const f = fixture({ noFile: true });
    expect((await build(f.way.id)).message).toBe("no game file yet: upload one, or pick one on the server");
    expect(getWay(f.way.id)!.status).toBe("needs-files");
    // the game's copy on the server, not judged yet: it is looked at where it is (small reads), never taken to be judged
    packageFor(f.game.id, "rom");
    let verdict: "unknown" | "direct" | "make" | "no" = "unknown";
    const looked: number[] = [];
    let handed = 0;
    adeps.copyServes = () => ({ serves: verdict, why: verdict === "no" ? "a .iso file, and this needs .z64" : "looking at the game's copy" });
    adeps.judgeCopy = async gameId => { looked.push(gameId); verdict = "no"; return null; };
    adeps.contentFromPackage = async () => { handed++; return null; };
    const refused = await build(f.way.id);
    expect(refused).toMatchObject({ state: "failed", message: "the game's copy on the server is a .iso file, and this needs .z64" });
    expect(JSON.parse(refused.fail_json!)).toEqual({ class: "file" });
    expect([looked, handed]).toEqual([[f.game.id], 0]);
    expect(getWay(f.way.id)!.status).toBe("needs-files");
    expect(host.seen).toEqual([]);                                      // told before any download
    // a copy the way's file is made from: a make job does that first
    verdict = "make";
    expect((await build(f.way.id)).message).toBe("its game file is made from the game's copy first (a make job does that, then the way is built)");
    expect(handed).toBe(0);
    // a copy that serves as it is: the hand-over takes it (with the content plan, its progress and the job's signal), and
    // it becomes the way's file once the content plan accepts it
    verdict = "direct";
    let asked: any = null;
    adeps.contentFromPackage = async o => { asked = o; o.progress?.(5e9, 10e9); return insertContent({ gameId: o.game.id, platform: "n64", name: "dump.z64", path: f.romPath, size: f.rom.byteLength, hashes: { sha1: sha1(f.rom), sha256: sha256(f.rom) }, source: "package" }); };
    expect((await build(f.way.id)).state).toBe("done");
    expect(asked.content).toMatchObject({ platform: "n64", place: "mm.n64.us.1.0.z64" });
    expect(typeof asked.progress).toBe("function");
    expect(asked.signal).toBeInstanceOf(AbortSignal);
    expect(getContent(getWay(f.way.id)!.content_id!)).toMatchObject({ source: "package", name: "dump.z64" });
  });

  test("the game's copy of any kind: a console file inside a PC copy that serves the way is taken by the hand-over; a PC copy with no console game data in it says nothing of the way's file", async () => {
    const f = fixture({ noFile: true });
    packageFor(f.game.id, "native");
    // a PC game's own copy: nothing a console plays is in it, so the way waits for its file in the usual words
    adeps.copyServes = () => ({ serves: "no", why: "it holds no game file a console plays", block: null });
    adeps.copyFacts = () => ({ ...copyFactsOf({ packageId: 1, kind: "native", rel: "", path: "/x", shape: "folder", size: 1 }), entries: [] });
    let handed = 0;
    adeps.contentFromPackage = async () => { handed++; return null; };
    expect(await build(f.way.id, { replace: true })).toMatchObject({ state: "failed", message: "no game file yet: upload one, or pick one on the server" });
    expect(handed).toBe(0);
    // a console file inside it that the way takes as it is: the hand-over takes it (with the step it is on), then the build
    adeps.copyServes = () => ({ serves: "direct", why: "the game file this way takes", block: null });
    adeps.copyFacts = () => copyFactsOf({ packageId: 1, kind: "native", rel: "Game/mm.z64", path: f.romPath, shape: "file", size: f.rom.byteLength });
    let steps: (string | undefined)[] = [];
    adeps.contentFromPackage = async o => {
      handed++;
      o.progress?.(1, 2, "hashing the game's copy");
      steps.push("called");
      return insertContent({ gameId: o.game.id, platform: "n64", name: "mm.z64", path: f.romPath, size: f.rom.byteLength, hashes: { sha1: sha1(f.rom), sha256: sha256(f.rom) }, source: "package" });
    };
    expect((await build(f.way.id, { replace: true })).state).toBe("done");
    expect([handed, steps]).toEqual([1, ["called"]]);
    // a PC copy whose console file is not the way's: told in the copy's words, nothing taken
    const g = fixture({ noFile: true });
    packageFor(g.game.id, "native");
    adeps.copyServes = () => ({ serves: "no", why: "a .nup file in the game's PC copy that nothing this way checks can prove is the game", block: null });
    adeps.copyFacts = () => copyFactsOf({ packageId: 1, kind: "native", rel: "x.nup", path: "/x.nup", shape: "file", size: 1 });
    expect(await build(g.way.id, { replace: true })).toMatchObject({ state: "failed", message: "the game's copy on the server is a .nup file in the game's PC copy that nothing this way checks can prove is the game" });
    expect(handed).toBe(1);
  });

  test("an unmet need stops the build before any download; a met one is placed", async () => {
    const f = fixture({ spec: mmSpec("", { content: null, files: [], keep: [], needs: [{ kind: "bios", name: "PS2 BIOS", place: "bios/scph39001.bin", accept: { sizes: [4096] } }] }) });
    const job = await build(f.way.id);
    expect(job.message).toBe("needs PS2 BIOS — add it on the plan");
    expect(getWay(f.way.id)!.status).toBe("needs-files");
    expect(host.seen).toEqual([]);
    const bios = join(tmp("bios-"), "scph39001.bin");
    writeFileSync(bios, bytes(4096, 6));
    insertContent({ planId: f.plan.id, needIndex: 0, role: "system", name: "scph39001.bin", path: bios, size: 4096, hashes: {}, source: "upload" });
    expect((await build(f.way.id)).state).toBe("done");
    expect(readFileSync(join(pkgOf(f.game.id)!.path, "bios", "scph39001.bin"))).toEqual(Buffer.from(bytes(4096, 6)));
  });

  test("setup steps that run programs need the build sandbox, and nothing is downloaded without it", async () => {
    const f = fixture({ spec: mmSpec(sha1(bytes(64 * 1024, 9)), { setup: [{ run: { exe: "Zelda64Recompiled.exe", argv: ["--extract"], wine: true, timeoutSec: 60 } }] }) });
    expect((await build(f.way.id)).message).toBe("setup steps need the build sandbox");
    expect(host.seen).toEqual([]);
  });

  test("setup: a wine step runs headless in the sandbox's environment; ini, remove and move stay in STAGING; files after setup come last", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    process.env.LUDARR_TEST_SECRET = "s3cret";
    const seenRun: { cmd: string[]; env: Record<string, string>; inheritEnv?: boolean; afterFileThere: boolean }[] = [];
    let killed = 0;
    other = (c, opts) => {
      if (c[0] === "xvfb-run") {
        seenRun.push({ cmd: c, env: opts.env, inheritEnv: opts.inheritEnv, afterFileThere: existsSync(join(opts.cwd, "inis", "after.ini")) });
        mkdirSync(join(opts.cwd, "inis"), { recursive: true });
        writeFileSync(join(opts.cwd, "inis", "PCSX2.ini"), "[UI]\r\nSettingsVersion = 1\r\nSetupWizardIncomplete = true\r\n\r\n[EmuCore]\r\nEnableCheats = false\r\n");
        return ok();
      }
      if (c[0] === join(wineDir, "wineserver") && c[1] === "-k") { killed++; return ok(); }
      return null;
    };
    try {
      const spec = emuSpec({
        setup: [
          { run: { exe: "pcsx2-qt.exe", argv: ["-portable", "-testconfig", "--out={stage}"], wine: true, timeoutSec: 60 } },
          { ini: { path: "inis/PCSX2.ini", section: "ui", key: "setupwizardincomplete", value: "false" } },
          { ini: { path: "inis/PCSX2.ini", section: "UI", key: "StartFullscreen", value: "true" } },
          { remove: "*.pdb" },
          { move: { from: "docs/readme.txt", to: "readme.txt" } },
        ],
        files: [{ path: "portable.ini", text: "" }, { path: "inis/after.ini", text: "[X]\r\nY = 1\r\n", after: "setup" }],
      });
      const f = fixture({ kind: "emulator", spec, rom: bytes(3000, 1), romName: "gow2.iso" });
      const job = await build(f.way.id);
      expect(job.message).toMatch(/^built:/);
      const run = seenRun[0];
      const pkg = pkgOf(f.game.id)!;
      expect(run.cmd.slice(0, 5)).toEqual(["xvfb-run", "-a", "-s", "-screen 0 1280x1024x24", join(wineDir, "wine")]);
      expect(basename(run.cmd[5])).toBe("pcsx2-qt.exe");
      expect(run.cmd.slice(6, 8)).toEqual(["-portable", "-testconfig"]);
      expect(run.cmd[8]).toMatch(/^--out=.*staging$/);
      expect(run.inheritEnv).toBe(false);
      // (Bun's toMatchObject writes its matchers back into the object it checks: plain checks on a copy here)
      const env = { ...run.env };
      expect(Object.values(env).some(v => String(v).includes("s3cret"))).toBe(false);
      expect(env.WINEPREFIX).toMatch(/job-\d+[\\/]wine$/);
      expect([env.WINEDEBUG, env.WINEDLLOVERRIDES, env.LANG]).toEqual(["-all", "mscoree,mshtml=", "C.UTF-8"]);
      expect(run.afterFileThere).toBe(false);                            // written after setup, never seen by it
      expect(killed).toBe(1);                                            // the prefix's wineserver went down with the step
      const ini = readFileSync(join(pkg.path, "inis", "PCSX2.ini"), "utf8");
      expect(ini).toBe("[UI]\r\nSettingsVersion = 1\r\nSetupWizardIncomplete = false\r\nStartFullscreen = true\r\n\r\n[EmuCore]\r\nEnableCheats = false\r\n");
      expect(existsSync(join(pkg.path, "pcsx2-qt.pdb"))).toBe(false);
      expect(existsSync(join(pkg.path, "readme.txt"))).toBe(true);
      expect(existsSync(join(pkg.path, "docs", "readme.txt"))).toBe(false);
      expect(readFileSync(join(pkg.path, "inis", "after.ini"), "utf8")).toBe("[X]\r\nY = 1\r\n");
    } finally { delete process.env.LUDARR_TEST_SECRET; }
  });

  test("text the setup wrote that names this server (a wine Z: path, the scratch folder, also in UTF-16) fails the build", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    const spec = emuSpec({ setup: [{ run: { exe: "pcsx2-qt.exe", argv: ["-testconfig"], wine: true, timeoutSec: 60 } }] });
    const writes: ((cwd: string) => void)[] = [
      cwd => writeFileSync(join(cwd, "PCSX2.ini"), "[Folders]\r\nBios = Z:\\library\\.work\\job-9\\staging\\bios\r\n"),
      cwd => writeFileSync(join(cwd, "PCSX2.ini"), `[Folders]\nBios = ${join(cwd, "bios")}\n`),
      cwd => writeFileSync(join(cwd, "user.reg"), Buffer.from("\ufeff[Software]\r\n\"Path\"=\"Z:\\\\x\"\r\n", "utf16le")),
    ];
    const reasons: string[] = [];
    for (const w of writes) {
      other = (c, opts) => { if (c[0] === "xvfb-run") { w(opts.cwd); return ok(); } return c[1] === "-k" ? ok() : null; };
      const f = fixture({ kind: "emulator", spec, rom: bytes(3000, 1), romName: "g.iso" });
      const job = await build(f.way.id);
      expect(job.state).toBe("failed");
      reasons.push(job.message!);
      expect(pkgOf(f.game.id)).toBeUndefined();
    }
    expect(reasons[0]).toBe("PCSX2.ini holds a wine Z: drive path — written by the setup, it would point nowhere on a player's PC");
    expect(reasons[1]).toMatch(/^PCSX2\.ini holds the build's scratch folder/);
    expect(reasons[2]).toMatch(/^user\.reg holds a wine Z: drive path/);
    expect(serverPathIn("C:\\Games\\x", "/library/.work/job-1")).toBeNull();
  });

  test("a link the setup leaves in STAGING fails the build, and nothing is written through it", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    const outside = tmp("way-outside-");
    other = (c, opts) => { if (c[0] === "xvfb-run") { dirLink(outside, join(opts.cwd, "inis")); return ok(); } return c[1] === "-k" ? ok() : null; };
    const spec = emuSpec({ setup: [{ run: { exe: "pcsx2-qt.exe", argv: [], wine: true, timeoutSec: 60 } }], files: [{ path: "portable.ini", text: "" }, { path: "inis/after.ini", text: "x", after: "setup" }] });
    const f = fixture({ kind: "emulator", spec, rom: bytes(3000, 1), romName: "g.iso" });
    const job = await build(f.way.id);
    expect(job.message).toBe("setup step 1 holds a link (inis), and a package carries files only");
    expect(existsSync(join(outside, "after.ini"))).toBe(false);
  });

  test("a setup step that fails or runs out of time fails the build with what it said", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    const spec = emuSpec({ setup: [{ run: { exe: "pcsx2-qt.exe", argv: [], wine: true, timeoutSec: 5 } }] });
    other = c => (c[0] === "xvfb-run" ? { code: 3, stdout: "", stderr: "err: no display\nfatal: gave up", timedOut: false } : c[1] === "-k" ? ok() : null);
    expect((await build(fixture({ kind: "emulator", spec, rom: bytes(10), romName: "a.iso" }).way.id)).message).toBe("setup step 1 failed (exit 3): err: no display | fatal: gave up");
    other = c => (c[0] === "xvfb-run" ? { code: -1, stdout: "", stderr: "", timedOut: true } : c[1] === "-k" ? ok() : null);
    expect((await build(fixture({ kind: "emulator", spec, rom: bytes(10), romName: "b.iso" }).way.id)).message).toBe("setup step 1 ran out of time (5 s)");
  });

  test("a setup step is stopped when the library falls below what LIBRARY_KEEP_FREE_GB keeps free while it runs (EnvError 'room')", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    process.env.LIBRARY_KEEP_FREE_GB = "50";
    const roomMs = ckdeps.roomMs;
    try {
      let free = 900e9;
      pdeps.diskSpace = async () => ({ free, total: 2000e9 });
      ckdeps.roomMs = 20;
      const spec = emuSpec({ setup: [{ run: { exe: "pcsx2-qt.exe", argv: [], wine: true, timeoutSec: 60 } }] });
      // the step's program writes and writes: the library's free space drops while it runs, until it is stopped
      other = (c, opts) => {
        if (c[0] !== "xvfb-run") return c[1] === "-k" ? ok() : null;
        return new Promise(res => {
          const drop = setTimeout(() => { free = 40e9; }, 30);
          const t = setTimeout(() => res(ok()), 3000);
          opts.signal?.addEventListener("abort", () => { clearTimeout(t); clearTimeout(drop); res({ code: 143, stdout: "", stderr: "", timedOut: false }); }, { once: true });
        });
      };
      const f = fixture({ kind: "emulator", spec, rom: bytes(10), romName: "a.iso" });
      const t0 = Date.now();
      const job = await build(f.way.id);
      expect(Date.now() - t0).toBeLessThan(2500);                              // stopped, not run to its end
      expect(job.state).toBe("failed");
      expect(job.message).toMatch(/^not enough room: the library fell to 40 GB free while setup step 1 ran, below the 50 GB it keeps free/);
      expect(JSON.parse(job.fail_json!)).toEqual({ class: "env", kind: "room" });
      expect(pkgOf(f.game.id)).toBeUndefined();
    } finally { ckdeps.roomMs = roomMs; }
  });

  test("a tool step needs the plan's tools built (the build job builds them first); built, they run from the scratch folder on the game file handed over read-only (a link, never a copy), not shipped", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    const rom = bytes(64 * 1024, 9);
    const spec = mmSpec(sha1(rom), {
      content: { ...mmSpec(sha1(rom)).content!, ship: false },
      tools: { ref: "{tag}", steps: ["make extract"], outputs: ["bin/extract"] },
      setup: [{ run: { tool: "bin/extract", argv: ["{content}", "{stage}/oot.o2r"], wine: false, timeoutSec: 60 } }],
    });
    const f = fixture({ spec, rom });
    const first = await build(f.way.id);
    expect(first.message).toBe("needs its tools built");
    expect(JSON.parse(first.fail_json!)).toEqual({ class: "other", kind: "needs-build" });      // the run queues the build job for them
    const built = join(toolsDir(), f.plan.slug, "abc123");
    mkdirSync(join(built, "bin"), { recursive: true });
    writeFileSync(join(built, "bin", "extract"), "#!/bin/sh");
    writeFileSync(join(built, "tools.json"), JSON.stringify({ ref: "v1.2.2", commit: "abc123" }));
    let got: string[] = [];
    other = (c, opts) => {
      if (c[0].replace(/\\/g, "/").endsWith("tools/bin/extract")) { got = c; expect(readFileSync(c[1])).toEqual(Buffer.from(rom)); writeFileSync(c[2], "o2r"); expect(opts.cwd).toMatch(/staging$/); return ok(); }
      return null;
    };
    expect((await build(f.way.id)).state).toBe("done");
    expect(got[1].replace(/\\/g, "/")).toMatch(/job-\d+\/in\/Legend_of_Zelda_The_-_Majoras_Mask_USA\.z64$/);
    const m = manifestOf(pkgOf(f.game.id)!);
    expect(m.files.map((x: { path: string }) => x.path)).toContain("oot.o2r");
    expect(m.files.some((x: { path: string }) => x.path.endsWith(".z64"))).toBe(false);   // consumed, not shipped
  });
});

describe("one package per game", () => {
  test("a way never replaces a PC copy unless asked; asked, the copy goes", async () => {
    const f = fixture();
    const pc = packageFor(f.game.id, "native");
    const job = await build(f.way.id);
    expect(job.message).toBe("the game already has a PC copy; build with replace to swap it for this way");
    expect(host.seen).toEqual([]);
    expect(pkgOf(f.game.id)!.id).toBe(pc.id);
    expect((await build(f.way.id, { replace: true })).state).toBe("done");
    expect(existsSync(pc.path)).toBe(false);
    expect(stmts.packageById.get(pc.id)).toBeNull();
    // a console dump makes way for the playable way without being asked
    const g = fixture();
    const dump = packageFor(g.game.id, "rom");
    expect((await build(g.way.id)).state).toBe("done");
    expect(existsSync(dump.path)).toBe(false);
  });

  test("an import never replaces a built way unless asked; asked, the ways that built the old package go back to ready", async () => {
    const f = fixture();
    expect((await build(f.way.id)).state).toBe("done");
    const wayPkg = pkgOf(f.game.id)!;
    const input = tmp("way-import-");
    writeFileSync(join(input, "Game.exe"), bytes(1000, 1));
    writeFileSync(join(input, "data.pak"), bytes(6_000_000, 2));
    rdeps.importers = () => [{ impl: "recipes", name: "copy", importer: { probe: async () => true, run: async (ctx: any) => { cpSync(ctx.input, ctx.staging, { recursive: true }); return { ok: true, shape: "folder" as const, reason: null, launchExe: "Game.exe" }; } } }];
    const refused = stmts.insertJob.get(null, null, f.game.id, input) as JobRow;
    await runJob(refused.id);
    expect(stmts.jobById.get(refused.id)).toMatchObject({ state: "failed", message: "the game has a built way; replace it from the game page" });
    expect(pkgOf(f.game.id)!.id).toBe(wayPkg.id);
    const asked = stmts.insertJobOf.get(null, null, f.game.id, input, "import", JSON.stringify({ replace: true }), null) as JobRow;
    await runJob(asked.id);
    expect((stmts.jobById.get(asked.id) as JobRow).state).toBe("done");
    expect(getWay(f.way.id)).toMatchObject({ status: "ready", package_id: null, status_note: "its package was replaced" });
    expect(existsSync(wayPkg.path)).toBe(false);
    expect(replaceRefusal(null, "import")).toBeNull();
  });

  test("an imported console dump reaches the integrator's hook with its package (and a failing hook never fails the import)", async () => {
    const g = upsertGame({ steam_appid: 997001, name: "Dump Game", slug: "dump-game" }) as GameRow;
    const input = tmp("way-dump-");
    writeFileSync(join(input, "Dump Game (USA).z64"), bytes(64 * 1024, 3));
    rdeps.importers = () => [{ impl: "recipes", name: "copy", importer: { probe: async () => true, run: async (ctx: any) => {
      cpSync(ctx.input, ctx.staging, { recursive: true });
      return { ok: true, shape: "folder" as const, reason: null, platform: "n64", validation: await inspectRom(ctx.staging) };
    } } }];
    const seen: { gameId: number; kind: string }[] = [];
    const { finalizeHooks } = await import("../src/process/runner");
    const saved = finalizeHooks.romImported;
    finalizeHooks.romImported = async o => { seen.push({ gameId: o.gameId, kind: String(o.manifest.kind) }); throw new Error("no content store here"); };
    try {
      const j = stmts.insertJob.get(null, null, g.id, input) as JobRow;
      await runJob(j.id);
      expect((stmts.jobById.get(j.id) as JobRow).state).toBe("done");
      expect(seen).toEqual([{ gameId: g.id, kind: "rom" }]);
      expect((stmts.jobById.get(j.id) as JobRow).transcript).toMatch(/handing the dump to a way to play failed: no content store here/);
    } finally { finalizeHooks.romImported = saved; }
  });

  test("a failed build leaves the game's package as it was; the way says why", async () => {
    const f = fixture();
    expect((await build(f.way.id)).state).toBe("done");
    const before = pkgOf(f.game.id)!;
    updatePlan(f.plan.id, { spec: { ...mmSpec(sha1(f.rom)), launch: { exe: "Missing.exe", argv: [] } } });
    const job = await build(f.way.id);
    expect(job.message).toBe("the program has no Missing.exe (the plan's launch)");
    expect(pkgOf(f.game.id)!.id).toBe(before.id);
    expect(existsSync(join(before.path, "Zelda64Recompiled.exe"))).toBe(true);
    expect(getWay(f.way.id)).toMatchObject({ status: "failed", package_id: before.id, status_note: job.message });
  });
});

describe("jobs of other kinds", () => {
  test("a kind nobody registered fails plainly", async () => {
    const saved = jobKinds.get("construct");
    jobKinds.delete("construct");
    try {
      const j = enqueueJob({ kind: "construct", repo: "a/b" });
      await runJob(j.id);
      expect(stmts.jobById.get(j.id)).toMatchObject({ state: "failed", message: "this kind of job is not available" });
    } finally { if (saved) jobKinds.set("construct", saved); }
  });

  test("builds have their own lane (WAYS_PARALLEL) next to imports, and one job per way or plan at a time", async () => {
    const savedBuild = jobKinds.get("build");
    let openImport!: () => void, openBuild!: () => void;
    const importGate = new Promise<void>(r => { openImport = r; }), buildGate = new Promise<void>(r => { openBuild = r; });
    jobKinds.set("build", { run: async () => { await buildGate; return { message: "built" }; } });
    rdeps.importers = () => [{ impl: "recipes", name: "gated", importer: { probe: async () => true, run: async (ctx: any) => { await importGate; cpSync(ctx.input, ctx.staging, { recursive: true }); return { ok: true, shape: "folder" as const, reason: null, launchExe: "Game.exe" }; } } }];
    const input = tmp("lane-");
    writeFileSync(join(input, "Game.exe"), bytes(1000, 1)); writeFileSync(join(input, "data.pak"), bytes(6_000_000, 2));
    const ids: number[] = [];
    try {
      process.env.IMPORT_PARALLEL = "1"; process.env.WAYS_PARALLEL = "1";
      const imp = stmts.insertJob.get(null, null, null, input) as JobRow;
      const b1 = enqueueJob({ kind: "build", planId: 901 }), b2 = enqueueJob({ kind: "build", planId: 902 }), b1again = enqueueJob({ kind: "build", planId: 901 });
      ids.push(imp.id, b1.id, b2.id, b1again.id);
      await processTick();
      expect(activeJobs()).toBe(2);                                       // the import and one build: each lane has its own count
      expect((stmts.jobById.get(b2.id) as JobRow).state).toBe("queued");
      process.env.WAYS_PARALLEL = "3";
      await processTick();
      expect((stmts.jobById.get(b2.id) as JobRow).state).toBe("running");
      expect((stmts.jobById.get(b1again.id) as JobRow).state).toBe("queued");   // the same plan waits for its other job
      expect(activeJobs()).toBe(3);
    } finally {
      openImport(); openBuild();
      await settle(...ids.slice(0, 3));
      await processTick();
      await settle(...ids);
      if (savedBuild) jobKinds.set("build", savedBuild); else jobKinds.delete("build");
    }
    expect(ids.map(id => (stmts.jobById.get(id) as JobRow).state)).toEqual(["done", "done", "done", "done"]);
    // their ticks are 'build' events and they never had an input to look at
    expect((stmts.jobById.get(ids[1]) as JobRow).input_path).toBe("plan:901");
  });

  test("a kind's own scratch estimate counts in the reservation both lanes share", async () => {
    const savedBuild = jobKinds.get("build");
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    jobKinds.set("build", { run: async () => { await gate; return { message: "built" }; }, scratch: (_j, spec) => (spec.kind === "build" && spec.planId === 2 ? 50e9 : 1e9) });
    const savedSpace = pdeps.diskSpace;
    pdeps.diskSpace = async () => ({ free: 10e9, total: 100e9 });
    process.env.WAYS_PARALLEL = "5";
    process.env.LIBRARY_KEEP_FREE_GB = "0";
    const small = enqueueJob({ kind: "build", planId: 1 }), big = enqueueJob({ kind: "build", planId: 2 });
    try {
      await processTick();
      expect((stmts.jobById.get(small.id) as JobRow).state).toBe("running");
      expect(stmts.jobById.get(big.id)).toMatchObject({ state: "queued", message: "waiting for scratch space: this build needs about 50.0 GB, 9.0 GB will be free once the running job has what it may need" });
      // what LIBRARY_KEEP_FREE_GB keeps free on the library counts for a job that writes game data
      process.env.LIBRARY_KEEP_FREE_GB = String(8.5e9 / 1e9);
      const third = enqueueJob({ kind: "build", planId: 3 });
      await processTick();
      expect(stmts.jobById.get(third.id)).toMatchObject({ state: "queued", message: "waiting for scratch space: this build needs about 1.0 GB and 8.5 GB kept free on the library, 9.0 GB will be free once the running job has what it may need" });
      stmts.setJobFailed.run("cancelled", "test over", third.id);
    } finally {
      open();
      await settle(small.id);
      pdeps.diskSpace = savedSpace;
      if (savedBuild) jobKinds.set("build", savedBuild); else jobKinds.delete("build");
      stmts.setJobFailed.run("cancelled", "test over", big.id);
    }
  });

  test("after a restart imports, builds and file intakes are queued again; the AI's construction is not run again unasked", () => {
    const savedConstruct = jobKinds.get("construct");
    jobKinds.delete("construct");
    try {
      const imp = stmts.insertJob.get(null, null, null, "/nowhere") as JobRow;
      const asm = enqueueJob({ kind: "assemble", wayId: 1 }), content = enqueueJob({ kind: "content", gameId: null, path: "/x" }), con = enqueueJob({ kind: "construct", repo: "a/b" });
      for (const j of [imp, asm, content, con]) stmts.setJob.run("running", null, 0.5, "busy", j.id);
      resumeJobs();
      for (const j of [imp, asm, content]) expect(stmts.jobById.get(j.id)).toMatchObject({ state: "queued", message: "resuming after restart" });
      expect(stmts.jobById.get(con.id)).toMatchObject({ state: "failed", message: "interrupted by a restart — start it again" });
      // a registered kind that says it may not be repeated
      jobKinds.set("construct", { run: async () => ({ message: "" }), resumable: false });
      const con2 = enqueueJob({ kind: "construct", repo: "c/d" });
      stmts.setJob.run("running", null, 0.5, "busy", con2.id);
      resumeJobs();
      expect((stmts.jobById.get(con2.id) as JobRow).state).toBe("failed");
    } finally { if (savedConstruct) jobKinds.set("construct", savedConstruct); else jobKinds.delete("construct"); }
  });

  test("cancel: a queued job never starts (its way is put back), a running one is stopped, a finished one is left alone", async () => {
    const f = fixture();
    updateWay(f.way.id, { status: "building" });                         // as a restart leaves it
    const j = enqueueJob({ kind: "assemble", wayId: f.way.id }, { gameId: f.game.id });
    expect(cancelJob(j.id)).toBe(true);
    expect((stmts.jobById.get(j.id) as JobRow).state).toBe("cancelled");
    expect(getWay(f.way.id)).toMatchObject({ status: "ready", status_note: "the build was cancelled" });
    await processTick();
    expect((stmts.jobById.get(j.id) as JobRow).state).toBe("cancelled");
    const savedBuild = jobKinds.get("build");
    jobKinds.set("build", { run: async ctx => { await new Promise<void>(r => ctx.signal.addEventListener("abort", () => r())); throw new Error("stopped"); } });
    try {
      const b = enqueueJob({ kind: "build", planId: 77 });
      const running = runJob(b.id);
      await Bun.sleep(20);
      expect(cancelJob(b.id)).toBe(true);
      await running;
      expect(stmts.jobById.get(b.id)).toMatchObject({ state: "cancelled", message: "cancelled" });
      expect(cancelJob(b.id)).toBe(false);
    } finally { if (savedBuild) jobKinds.set("build", savedBuild); else jobKinds.delete("build"); }
    // a build cancelled while it runs puts its way back where it was
    const g = fixture();
    let started!: () => void;
    const begun = new Promise<void>(r => { started = r; });
    prdeps.latestRelease = async () => { started(); await Bun.sleep(200); return relFor(ASSET, URL_, ZIP, "v1.2.2"); };
    const k = enqueueJob({ kind: "assemble", wayId: g.way.id }, { gameId: g.game.id });
    const run = runJob(k.id);
    await begun;
    expect(getWay(g.way.id)!.status).toBe("building");
    cancelJob(k.id);
    await run;
    expect((stmts.jobById.get(k.id) as JobRow).state).toBe("cancelled");
    expect(getWay(g.way.id)).toMatchObject({ status: "ready", status_note: "the build was cancelled" });
  });
});

describe("the pieces", () => {
  test("a built way is its own install class and never wants an upgrade", () => {
    for (const kind of ["recomp", "port", "emulated"]) expect(classOfPackage({ manifest_json: JSON.stringify({ kind, source: { title: "Zelda", protocol: "way" } }) })).toBe("way");
    expect(wantsUpgrade({ id: 1, ...DEFAULT_PROFILE, upgrade: true, cutoff: "clean" }, "way")).toBe(false);
    expect(wantsUpgrade({ id: 1, ...DEFAULT_PROFILE, upgrade: true, cutoff: "clean" }, "iso")).toBe(true);
  });

  test("buildManifest: an import's manifest is as it was; argv, env, cwd, requires, keep and seed appear only when given", async () => {
    const dir = tmp("mf-");
    writeFileSync(join(dir, "Game.exe"), "x");
    const v: Validation = { ok: true, root: dir, problems: [], exeCandidates: ["Game.exe"], launch: "Game.exe", prerequisites: [], totalSize: 1, fileCount: 1 };
    const imp = await buildManifest(v, { name: "G", version: null, source: null, tier: "deterministic" });
    expect(Object.keys(imp).sort()).toEqual(["createdAt", "files", "kind", "launch", "name", "notes", "platform", "prerequisites", "schema", "slug", "source", "tier", "totalSize", "version"]);
    expect(imp.launch).toEqual({ exe: "Game.exe", args: "", cwd: "" });
    const way = await buildManifest(v, { name: "G", version: "1", source: null, tier: "deterministic", kind: "port", argv: ["-a"], env: { A: "1" }, cwd: "bin", requires: { launcher: "0.10.0" }, keep: ["saves/**"], seed: ["x.ini"] });
    expect(way).toMatchObject({ kind: "port", launch: { exe: "Game.exe", args: "", cwd: "bin", argv: ["-a"], env: { A: "1" } }, requires: { launcher: "0.10.0" }, keep: ["saves/**"], seed: ["x.ini"] });
  });

  test("inspectRom: a cartridge dump may be small (16 KB floor); a disc image may not", async () => {
    const cart = tmp("rom-"); writeFileSync(join(cart, "Super Mario World (USA).sfc"), bytes(32 * 1024));
    expect((await inspectRom(cart)).ok).toBe(true);
    const tiny = tmp("rom-"); writeFileSync(join(tiny, "x.nes"), bytes(8 * 1024));
    expect((await inspectRom(tiny)).problems).toEqual(["suspiciously small (8.0 KB)"]);
    const disc = tmp("rom-"); writeFileSync(join(disc, "game.iso"), bytes(32 * 1024));
    expect((await inspectRom(disc)).problems).toEqual(["suspiciously small (32.0 KB)"]);
  });

  test("runUnderWine runs xvfb + wine with the prefix through the caller's exec, then stops the prefix's wineserver through it too", async () => {
    const seen: { cmd: string[]; env?: Record<string, string> }[] = [];
    const exec = async (cmd: string[], opts: any = {}) => { seen.push({ cmd, env: opts.env }); return ok(); };
    const tools = { ...tools7z, wine: join(wineDir, "wine"), xvfb: "/usr/bin/xvfb-run" };
    await runUnderWine(exec, "/s/x.exe", ["-a", "b c"], { prefix: "/w/wine", cwd: "/s", timeoutMs: 1000, tools, env: { EXTRA: "1" } });
    expect(seen[0].cmd).toEqual(["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 1280x1024x24", join(wineDir, "wine"), "/s/x.exe", "-a", "b c"]);
    expect(seen[0].env).toEqual({ WINEPREFIX: "/w/wine", WINEDEBUG: "-all", WINEDLLOVERRIDES: "mscoree,mshtml=", EXTRA: "1" });
    expect(seen[1].cmd).toEqual([join(wineDir, "wineserver"), "-k"]);
    expect((await runUnderWine(exec, "x.exe", [], { prefix: "/w", timeoutMs: 1, tools: tools7z })).code).toBe(127);
  });

  test("ini: a key is set in its section without regard to case, every other line kept; a missing section or key is added", () => {
    expect(setIni("[UI]\r\nSettingsVersion = 1\r\nSetupWizardIncomplete=true\r\n", "ui", "setupwizardincomplete", "false")).toBe("[UI]\r\nSettingsVersion = 1\r\nSetupWizardIncomplete=false\r\n");
    expect(setIni("[A]\nx = 1\n\n[B]\ny = 2\n", "A", "z", "3")).toBe("[A]\nx = 1\nz = 3\n\n[B]\ny = 2\n");
    expect(setIni("[A]\nx = 1\n", "C", "k", "v")).toBe("[A]\nx = 1\n\n[C]\nk = v\n");
    expect(setIni("", "Analytics", "PermissionAsked", "True")).toBe("[Analytics]\r\nPermissionAsked = True\r\n");
    expect(setIni("[A]\nkey = a=b\n", "A", "key", "c=d")).toBe("[A]\nkey = c=d\n");
  });

  test("inside: a path stays inside the folder and is never followed through a link", async () => {
    const root = tmp("inside-"), outside = tmp("inside-out-");
    mkdirSync(join(root, "a"));
    dirLink(outside, join(root, "l"));
    expect(await inside(root, "a/b/c.txt", { create: true })).toBe(join(root, "a", "b", "c.txt"));
    expect(existsSync(join(root, "a", "b"))).toBe(true);
    await expect(inside(root, "l/x.txt", { create: true })).rejects.toThrow("l is a link, and nothing is written through one");
    await expect(inside(root, "../x")).rejects.toThrow(/may not hold/);
    await expect(inside(root, "/etc/passwd")).rejects.toThrow(/must be relative/);
  });
});
