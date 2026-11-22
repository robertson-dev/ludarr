/**
 * A game built from its file on the server by the program's release kit (program.perGame, DESIGN3 B3 item 4; AMEND M10,
 * M12): never inside an assemble (NeedsBuild), but by the build job in its own lane, which keeps the install folder as a
 * folder beside the game file and queues the way's assemble; the kit as pinned, every fetch held to its pin before any
 * step, the game file handed over read-only, the steps given {program} {content} {out} {tools} {cpu} {jobs} {work}, an
 * output with what players must not get refused, {jobs} and the address-space cap from the server's cores and memory, a
 * kill for memory this server's trouble. The fakes: the release host, the sandbox's exec (7z, tar, the steps), the
 * server's cores, memory and tools.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { events } from "../src/events";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { ndeps } from "../src/net/public-url";
import { enqueueJob, jobKinds } from "../src/process/kinds";
import { runJob } from "../src/process/runner";
import { vdeps } from "../src/process/validate";
import { pdeps } from "../src/process/deps";
import type { ExecOpts, ExecResult } from "../src/process/tools";
import { adeps } from "../src/ways/assemble";
import { bdeps, fileSum, keptKitBuild, kitOutputProblems, kitRecipe, stepLimits, tryKit, wayBuildNeeded, type KitRecord } from "../src/ways/build";
import { buildNeeds, prepareBuildNeeds } from "../src/ways/build-needs";
import { cacheDir, forgetLinkProbes, prdeps } from "../src/ways/program";
import { sbdeps } from "../src/ways/sandbox";
import { getPlan, getWay, insertContent, insertPlan, insertWay, planPinned, planSpec, systemFiles, updatePlan, updateWay } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import type { KitBuild, RuntimePlanSpec } from "../src/ways/types";
import { bytes, fake7z, ok, releaseHost, restoreDeps, sha1, sha256, tempConfig, tmp, tools7z } from "./ways-fixtures";

const KIT = "NX2navi-app-0.5.0.zip", KIT_URL = `https://github.com/someone/nx2navi/releases/download/v0.5.0/${KIT}`;
const KIT_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(3000, 3)]);
const TOOL = bytes(5000, 6), TOOL_URL = "https://repo.msys2.org/mingw/clang64/mingw-w64-clang-x86_64-clang-19.1.0-1-any.pkg.tar.zst";
const RELEASE = { tag: "v0.5.0", name: "v0.5.0", date: "2026-11-01", prerelease: false, page: "p", immutable: true, asset: { name: KIT, url: KIT_URL, size: KIT_ZIP.byteLength, digest: `sha256:${sha256(KIT_ZIP)}` } };
const NUP = bytes(40_000, 8);
const STEP = "make-game --rom {content} --out {out} --tools {tools} --kit {program} --work {work} -j{jobs} -march={cpu}";

const kitSpec = (kit: Partial<KitBuild> = {}, over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^NX2navi-app-.*[.]zip$", channel: "stable", perGame: { fetch: [{ url: TOOL_URL, sha256: sha256(TOOL), size: TOOL.byteLength, to: "clang", unpack: "tar.zst" }], steps: [STEP], cpu: "x86-64-v3", timeoutSec: 3600, artifact: "dist", ...kit } },
  launch: { exe: "ocarina.exe", argv: [] },
  content: { kind: "rom", platform: "switch", what: "The Legend of Zelda: Ocarina of Time (Switch 2), its .nup", search: ["The Legend of Zelda: Ocarina of Time"], accept: { hashes: [{ algo: "sha1", value: sha1(NUP) }], formats: ["nup"] }, normalize: null, place: "game.nup", ship: false },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...over,
});

let seq = 0;
function fixture(spec: RuntimePlanSpec = kitSpec()) {
  seq++;
  const game = upsertGame({ steam_appid: 992_000 + seq, name: `Kit Test ${seq}`, slug: `kit-test-${seq}` }) as GameRow;
  const store = join(tmp("kit-root-"), ".ahoy-content", `kit-test-${seq}`);
  mkdirSync(store, { recursive: true });
  const nupPath = join(store, "OoT.nup");
  writeFileSync(nupPath, NUP);
  const checked = validatePlanSpec(spec, "recomp");
  if (!checked.ok) throw new Error(`fixture plan does not validate: ${checked.errors.join("; ")}`);
  const plan = insertPlan({ name: `Kit Plan ${seq}`, kind: "recomp", repo: "someone/nx2navi", platforms: ["switch"], spec: checked.value!, status: "ready" });
  const st = lstatSync(nupPath);
  const file = insertContent({ gameId: game.id, platform: "switch", name: "OoT.nup", path: nupPath, size: NUP.byteLength, hashes: { sha1: sha1(NUP), sha256: sha256(NUP) }, source: "inbox", stat: { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, dev: st.dev, ino: st.ino } });
  const way = updateWay(insertWay({ gameId: game.id, planId: plan.id, status: "ready" }).id, { contentId: file.id })!;
  return { game, plan, way, file, store, nupPath };
}
const run = async (j: JobRow) => { await runJob(j.id); return stmts.jobById.get(j.id) as JobRow; };
const buildJob = (f: ReturnType<typeof fixture>, then = true) => enqueueJob({ kind: "build", planId: f.plan.id, wayId: f.way.id, ...(then ? { then: "assemble" as const } : {}) }, { gameId: f.game.id });
const failOf = (j: JobRow) => JSON.parse(j.fail_json ?? "null");

/** what the sandbox ran: every command (after runuser/env), with the address-space cap it ran under, if any */
let ran: { cmd: string[]; capped: string | null; opts: ExecOpts }[] = [];
/** a kit step as the fake runs it: the filled-in command, the folder it runs in, and how it was run (its signal) */
let step: (cmd: string, cwd: string, opts: ExecOpts) => ExecResult | Promise<ExecResult>;
/** wine setting up its prefix, as the fake answers it (capped: under prlimit) */
let wineboot: (capped: boolean) => ExecResult = () => ok();
/** the default step: it reads the game file at {content} and writes the install folder into {out}/dist */
function makeGame(extra: (dist: string, work: string) => void = () => {}) {
  return (cmd: string): ExecResult => {
    const m = /^make-game --rom '([^']+)' --out '([^']+)' --tools '([^']+)' --kit '([^']+)' --work '([^']+)' -j(\d+) -march=(\S+)$/.exec(cmd);
    if (!m) return { code: 2, stdout: "", stderr: `make-game: bad arguments: ${cmd}`, timedOut: false };
    const [, rom, out, tools, kit] = m;
    if (!existsSync(rom) || readFileSync(rom).byteLength !== NUP.byteLength) return { code: 3, stdout: "", stderr: "no game file", timedOut: false };
    if (!existsSync(join(tools, "clang", "bin", "clang.exe")) || !existsSync(join(kit, "NX2navi", "lift.exe"))) return { code: 4, stdout: "", stderr: "no toolchain", timedOut: false };
    mkdirSync(join(out, "dist", "assets"), { recursive: true });
    writeFileSync(join(out, "dist", "ocarina.exe"), bytes(30_000, 1));
    writeFileSync(join(out, "dist", "assets", "data.bin"), bytes(70_000, 2));
    extra(join(out, "dist"), join(out, ".."));
    return ok("built");
  };
}
function sandboxFake() {
  return fake7z({ [KIT]: out => { mkdirSync(join(out, "NX2navi"), { recursive: true }); writeFileSync(join(out, "NX2navi", "lift.exe"), bytes(2000, 1)); } }, {
    other: (c, opts) => {
      const capped = /prlimit$/.test(c[0]) ? c[1] : null;
      const k = capped ? c.slice(c.indexOf("--") + 1) : c;
      ran.push({ cmd: k, capped, opts });
      if (k[0] === "tar") { const dest = k[k.indexOf("-C") + 1]; mkdirSync(join(dest, "bin"), { recursive: true }); writeFileSync(join(dest, "bin", "clang.exe"), "clang"); return ok(); }
      if (k.includes("wineboot")) return wineboot(!!capped);
      // a step, under xvfb-run when the kit runs Windows tools
      const b = k.indexOf("bash");
      if (b >= 0 && k[b + 1] === "-c") return step(k[b + 2], opts.cwd!, opts);
      return null;
    },
  });
}
const steps = () => ran.filter(r => r.cmd.includes("bash")).map(r => r.cmd[r.cmd.indexOf("bash") + 2]);

let cfg: ReturnType<typeof tempConfig>;
let host: ReturnType<typeof releaseHost>;
const savedB = { ...bdeps }, realSha = vdeps.sha256, realAdeps = { ...adeps };
let reads: string[] = [];
beforeAll(() => { cfg = tempConfig(); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  ran = []; reads = [];
  step = makeGame();
  wineboot = () => ok();
  bdeps.oomKills = () => null;                                         // the same on every box: no cgroup count unless a test gives one
  pdeps.log = () => {};
  pdeps.tools = () => tools7z;
  pdeps.diskSpace = async () => ({ free: 500e9, total: 1000e9 });
  sbdeps.platform = () => "win32";
  sbdeps.exec = sandboxFake();
  process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
  host = releaseHost({ [KIT_URL]: KIT_ZIP, [TOOL_URL]: TOOL });
  prdeps.latestRelease = async () => RELEASE;
  bdeps.cores = () => 8;
  bdeps.memAvailable = () => 16 * 2 ** 30;
  bdeps.which = (n: string) => (n === "zstd" ? "/usr/bin/zstd" : null);
  Object.assign(adeps, realAdeps, { contentFromPackage: async () => null });
  vdeps.sha256 = async (path, onBytes, signal) => { reads.push(path); return realSha(path, onBytes, signal); };
  forgetLinkProbes();
});
afterEach(() => { restoreDeps(); Object.assign(bdeps, savedB); vdeps.sha256 = realSha; delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

describe("a game built from its kit", () => {
  test("never inside an assemble: none kept → NeedsBuild, and wayBuildNeeded says so first", async () => {
    const f = fixture();
    expect(wayBuildNeeded(f.plan, f.way)).toBe(true);
    const j = await run(enqueueJob({ kind: "assemble", wayId: f.way.id }, { gameId: f.game.id }));
    expect(j).toMatchObject({ state: "failed", message: "its program has to be built for this game first (a build job does that, then the way is built)" });
    expect(failOf(j)).toEqual({ class: "other", kind: "needs-build" });
    expect(getWay(f.way.id)).toMatchObject({ status: "ready", status_note: j.message });
    expect(host.seen).toEqual([]);                                     // nothing was downloaded for it
    expect(steps()).toEqual([]);
  });

  test("the build job: the kit and its fetches, the game file read-only, the steps given every placeholder, the install folder kept beside the file; then the way's assemble links it in and reads nothing again", async () => {
    const f = fixture();
    const b = await run(buildJob(f));
    expect([b.state, b.message]).toEqual(["done", expect.stringMatching(/^built Kit Test \d+ from the v0\.5\.0 kit, kept beside its game file; the way is built next$/)]);
    expect(host.seen).toEqual([KIT_URL, TOOL_URL]);
    // the one step, every placeholder filled: {content} is a hard link of the game file in the scratch folder
    const [cmd] = steps();
    const m = /--rom '([^']+)' --out '([^']+)' --tools '([^']+)' --kit '([^']+)' --work '([^']+)' -j(\d+) -march=(\S+)$/.exec(cmd)!;
    const work = join(m[2], "..");
    expect(m[1]).toBe(join(work, "in", "OoT.nup"));
    expect([m[2], m[3], m[4], m[5]]).toEqual([join(work, "out"), join(work, "tools"), join(work, "program"), join(work, "scratch")]);
    expect([m[6], m[7]]).toEqual(["6", "x86-64-v3"]);                    // 8 cores, 16 GB free: 6 at once (2.5 GB each)
    const tar = ran.find(r => r.cmd[0] === "tar")!;
    expect(tar.cmd.slice(0, 3)).toEqual(["tar", "--zstd", "-xf"]);
    // kept as a folder (with its record) beside the game file, by the kit's sha256, the recipe and the file's sha256
    const builds = join(f.store, ".builds");
    const name = `${f.plan.slug}-${sha256(KIT_ZIP).slice(0, 12)}-${kitRecipe((planSpec(getPlan(f.plan.id)!).program as { perGame: KitBuild }).perGame)}-${sha256(NUP).slice(0, 12)}`;
    expect(readdirSync(builds).sort()).toEqual([name, `${name}.json`]);
    const rec = JSON.parse(readFileSync(join(builds, `${name}.json`), "utf8")) as KitRecord;
    expect(rec).toMatchObject({ kit: sha256(KIT_ZIP), tag: "v0.5.0", file: sha256(NUP), size: 100_000 });
    expect(rec.files.map(x => [x.rel, x.sha256])).toEqual([["assets/data.bin", sha256(bytes(70_000, 2))], ["ocarina.exe", sha256(bytes(30_000, 1))]]);
    // the kit it used is the plan's now, and nothing more is needed for this way
    expect(planPinned(getPlan(f.plan.id)!)).toMatchObject({ tag: "v0.5.0", asset: KIT, sha256: sha256(KIT_ZIP) });
    expect(wayBuildNeeded(getPlan(f.plan.id)!, getWay(f.way.id)!)).toBe(false);
    expect(keptKitBuild(getPlan(f.plan.id)!, f.file)!.dir).toBe(join(builds, name));
    // the assemble the build queued: the kept build linked into the package, its files not read again
    const next = (stmts.jobsByKind.all("assemble") as JobRow[]).find(j => j.state === "queued")!;
    expect(JSON.parse(next.spec_json!)).toEqual({ kind: "assemble", wayId: f.way.id, auto: false, runId: null });
    ran = []; host.seen.length = 0;
    const a = await run(next);
    expect(a.state).toBe("done");
    expect(steps()).toEqual([]);
    expect(host.seen).toEqual([]);                                      // the kit is not even downloaded: its build is kept
    const pkg = stmts.packageForGame.get(f.game.id) as PackageRow;
    expect(lstatSync(join(pkg.path, "ocarina.exe")).ino).toBe(lstatSync(join(builds, name, "ocarina.exe")).ino);
    expect(reads.filter(p => /ocarina\.exe$|data\.bin$/.test(p))).toEqual([]);
    const man = JSON.parse(pkg.manifest_json);
    expect(man).toMatchObject({ version: "0.5.0", kind: "recomp", launch: { exe: "ocarina.exe" } });
    expect(man.files.map((x: { path: string }) => x.path).sort()).toEqual(["assets/data.bin", "ocarina.exe"]);    // the .nup is consumed, not shipped
    // a second build of the same kit, recipe and file is the kept one: no fetch, no step
    ran = []; host.seen.length = 0;
    const again = await run(buildJob(f, false));
    expect(again.state).toBe("done");
    expect(steps()).toEqual([]);
    expect(again.transcript).toMatch(/kept on the server: nothing to build/);
  });

  test("a fetch that is not the file the plan pins fails the build before any step runs, and nothing is kept", async () => {
    const f = fixture();
    rmSync(cacheDir(), { recursive: true, force: true });               // nothing kept on the server from an earlier build
    host.files[TOOL_URL] = bytes(5000, 7);                             // the host serves other bytes under that address
    const b = await run(buildJob(f));
    expect(b.state).toBe("failed");
    expect(b.message).toBe(`mingw-w64-clang-x86_64-clang-19.1.0-1-any.pkg.tar.zst is not the file the plan pins (its sha256 is ${sha256(bytes(5000, 7)).slice(0, 12)}…, the plan says ${sha256(TOOL).slice(0, 12)}…): nothing was built`);
    expect(failOf(b)).toEqual({ class: "plan", phase: "fetch" });
    expect(steps()).toEqual([]);
    expect(existsSync(join(f.store, ".builds"))).toBe(false);
    expect((stmts.jobsByKind.all("assemble") as JobRow[]).length).toBe(0);
    expect(wayBuildNeeded(getPlan(f.plan.id)!, getWay(f.way.id)!)).toBe(true);
  });

  test("an install folder that holds what players must not get is refused with the paths (M10); the plan's keep list lets one through", async () => {
    step = makeGame((dist, work) => {
      mkdirSync(join(dist, "build-cache"), { recursive: true });
      writeFileSync(join(dist, "build-cache", "lifted.o"), bytes(2_500_000, 1));
      writeFileSync(join(dist, "ocarina.pdb"), bytes(500, 1));
      writeFileSync(join(dist, "settings.ini"), `[paths]\nroot = ${work.replace(/\\/g, "/")}/program\n`);
    });
    const f = fixture();
    const b = await run(buildJob(f));
    expect(b.state).toBe("failed");
    expect(failOf(b)).toEqual({ class: "plan", phase: "build" });
    expect(b.message).toBe("the build's install folder holds what the build leaves behind: build-cache/ (2.5 MB), ocarina.pdb (1 KB); and paths of this server: settings.ini names the build's scratch folder — remove them in the kit's steps (a file players need goes in the plan's keep list)");
    expect(existsSync(join(f.store, ".builds"))).toBe(false);
    // a junk file the plan's keep list names is the plan's to ship
    const dir = tmp("kit-junk-");
    writeFileSync(join(dir, "ocarina.exe"), "x"); writeFileSync(join(dir, "ocarina.pdb"), "x");
    expect(await kitOutputProblems(dir, { work: tmp("w-"), store: tmp("s-"), keep: ["*.pdb"] })).toBeNull();
    expect(await kitOutputProblems(dir, { work: tmp("w-"), store: tmp("s-"), keep: [] })).toMatch(/what the build leaves behind: ocarina\.pdb/);
  });

  test("a compiled server profile path fails before the build is cached or offered", async () => {
    step = makeGame(dist => {
      const exe = Buffer.alloc(2_000_000);
      exe.write("MZ"); exe.write("Z:/library/.work/job-125/scratch/ac/profile\0", 1_500_000);
      writeFileSync(join(dist, "ocarina.exe"), exe);
    });
    const f = fixture();
    const b = await run(buildJob(f));
    expect(b.state).toBe("failed");
    expect(b.message).toContain("ocarina.exe names a wine Z: drive path");
    expect(existsSync(join(f.store, ".builds"))).toBe(false);
    expect((stmts.jobsByKind.all("assemble") as JobRow[]).length).toBe(0);
  });

  test("{jobs} from the cores and the free memory, and each step held to 80 % of it under prlimit (M12)", async () => {
    const at = (cores: number, gib: number, prlimit: string | null) => { bdeps.cores = () => cores; bdeps.memAvailable = () => gib * 2 ** 30; bdeps.which = (n: string) => (n === "prlimit" ? prlimit : n === "zstd" ? "/usr/bin/zstd" : null); return stepLimits(); };
    expect(at(32, 10, "/usr/bin/prlimit")).toEqual({ jobs: 4, asBytes: Math.floor(10 * 2 ** 30 * 0.8), prlimit: "/usr/bin/prlimit" });
    expect(at(2, 64, "/usr/bin/prlimit")).toEqual({ jobs: 2, asBytes: 32 * 2 ** 30, prlimit: "/usr/bin/prlimit" });
    expect(at(24, 100, null)).toEqual({ jobs: 16, asBytes: 32 * 2 ** 30, prlimit: null });
    expect(at(8, 1, "/usr/bin/prlimit")).toMatchObject({ jobs: 1, prlimit: null });      // too little to cap: none
    // a build's step runs under the cap, with that many jobs
    at(32, 10, "/usr/bin/prlimit");
    const f = fixture();
    expect((await run(buildJob(f, false))).state).toBe("done");
    const s = ran.find(r => r.cmd[0] === "bash")!;
    expect(s.capped).toBe(`--as=${Math.floor(10 * 2 ** 30 * 0.8)}`);
    expect(s.cmd[2]).toMatch(/ -j4 -march=x86-64-v3$/);
    expect(s.opts.env).toMatchObject({ MAKEFLAGS: "-j4", CMAKE_BUILD_PARALLEL_LEVEL: "4" });
  });

  test("a step the system kills for memory is this server's trouble (env 'oom'); one that fails is the plan's; one past its time too", async () => {
    step = () => ({ code: 137, stdout: "", stderr: "Killed", timedOut: false });
    const f = fixture();
    const oom = await run(buildJob(f));
    expect(failOf(oom)).toEqual({ class: "env", kind: "oom" });
    expect(oom.message).toMatch(/^build step 1 was stopped by the system for want of memory \(exit 137\)/);
    step = () => ({ code: 132, stdout: "", stderr: "Illegal instruction", timedOut: false });
    expect(failOf(await run(buildJob(f)))).toEqual({ class: "env", kind: "cpu" });
    step = () => ({ code: 2, stdout: "", stderr: "lift: unknown opcode", timedOut: false });
    const bad = await run(buildJob(f));
    expect([bad.message, failOf(bad)]).toEqual(["build step 1 failed (exit 2): lift: unknown opcode", { class: "plan", phase: "build" }]);
    step = () => ({ code: -1, stdout: "", stderr: "", timedOut: true });
    expect((await run(buildJob(f))).message).toBe("build step 1 ran out of time (3600 s)");
    expect(existsSync(join(f.store, ".builds"))).toBe(false);
  });

  test("a build that would leave the library below what is kept free does not start (env 'room')", async () => {
    pdeps.diskSpace = async () => ({ free: 10e9, total: 100e9 });
    const f = fixture();
    const b = await run(buildJob(f));
    expect(failOf(b)).toEqual({ class: "env", kind: "room" });
    expect(b.message).toBe("not enough room: 10.0 GB free on the library, and 50.0 GB is kept free there (Settings → General → Import → Keep free on the library)");
    expect(host.seen).toEqual([]);
  });

  test("tried before the game file is here (the AI's dry run): the kit, every fetch held to its pin, the steps before the first one that reads {content}", async () => {
    const f = fixture(kitSpec({ steps: ["prepare --tools {tools} --kit {program}", STEP] }));
    step = cmd => (cmd.startsWith("prepare ") ? ok() : { code: 9, stdout: "", stderr: "should not run", timedOut: false });
    const r = await tryKit(f.plan, { work: tmp("kit-try-"), log: () => {} });
    expect(r).toMatchObject({ fetched: 1, ran: 1, waitsForFile: true, pinned: { tag: "v0.5.0", sha256: sha256(KIT_ZIP) } });
    expect(steps().map(s => s.split(" ")[0])).toEqual(["prepare"]);
    expect(planPinned(getPlan(f.plan.id)!)).toBeNull();                // a dry run pins nothing
  });
});

describe("what a build says while it runs, and whose trouble a failure is (the user's 'stuck on 1 %'; M2, M12)", () => {
  /** the 'build' messages a job sends while it runs */
  const listen = (jobId: number) => {
    const out: string[] = [];
    const off = events.subscribe(e => { const d = e.data as { id?: number; message?: string } | null; if (e.event === "build" && d?.id === jobId && d.message) out.push(d.message); });
    return { out, off };
  };

  test("a long step says every few seconds which step it is on, what it has written so far and for how long", async () => {
    bdeps.beatMs = 20;
    let free = 500e9;
    pdeps.diskSpace = async () => ({ free, total: 1000e9 });
    step = async cmd => { for (let i = 0; i < 8; i++) { free -= 1e9; await Bun.sleep(20); } return makeGame()(cmd); };
    const f = fixture();
    const j = buildJob(f, false);
    const heard = listen(j.id);
    try { expect((await run(j)).state).toBe("done"); } finally { heard.off(); }
    expect(heard.out.filter(m => /^building the game \(step 1 of 1\) · [\d.]+ (GB|MB) written · \d+ s$/.test(m)).length).toBeGreaterThan(1);
    expect(heard.out).toContain("checking what the build made · 0.0 of 0.1 MB");
  });

  test("a library that falls below what is kept free stops the running step (env 'room'), and nothing is kept or queued", async () => {
    bdeps.beatMs = 20;
    let free = 500e9, stopped = false;
    pdeps.diskSpace = async () => ({ free, total: 1000e9 });
    step = (_cmd, _cwd, opts) => new Promise(done => {
      free = 20e9;                                                       // the build fills the library
      const t = setTimeout(() => done(ok()), 5000);
      opts.signal?.addEventListener("abort", () => { stopped = true; clearTimeout(t); done({ code: -1, stdout: "", stderr: "", timedOut: false }); }, { once: true });
    });
    const f = fixture();
    const b = await run(buildJob(f));
    expect(stopped).toBe(true);
    expect(failOf(b)).toEqual({ class: "env", kind: "room" });
    expect(b.message).toBe("not enough room: 20.0 GB free on the library, and 50.0 GB is kept free there (Settings → General → Import → Keep free on the library)");
    expect(existsSync(join(f.store, ".builds"))).toBe(false);
    expect((stmts.jobsByKind.all("assemble") as JobRow[]).length).toBe(0);
  });

  test("a process the system kills for memory is told by the container's own kill count, never by what the build printed", async () => {
    const f = fixture();
    let kills = 3;
    bdeps.oomKills = () => kills;
    // a compiler killed inside `make -j`: the step ends with make's own exit, and the count went up
    step = () => { kills++; return { code: 2, stdout: "", stderr: "clang: error: unable to execute command: Killed\nmake: *** [Makefile:12: lifted.o] Error 1", timedOut: false }; };
    const oom = await run(buildJob(f));
    expect(failOf(oom)).toEqual({ class: "env", kind: "oom" });
    expect(oom.message).toMatch(/^build step 1 was stopped by the system for want of memory \(exit 2\): it runs again when the server has more free/);
    // the same word with the count unchanged: the plan's own failure
    step = () => ({ code: 2, stdout: "", stderr: "lift: Killed by its own watchdog", timedOut: false });
    expect(failOf(await run(buildJob(f)))).toEqual({ class: "plan", phase: "build" });
    // where the system keeps no count, the shell's word for a killed process says it
    bdeps.oomKills = () => null;
    step = () => ({ code: 2, stdout: "", stderr: "clang: error: unable to execute command: Killed\nmake: *** [Makefile:12: lifted.o] Error 1", timedOut: false });
    expect(failOf(await run(buildJob(f)))).toEqual({ class: "env", kind: "oom" });
    expect(existsSync(join(f.store, ".builds"))).toBe(false);
  });

  test("a pinned fetch the host no longer has (HTTP 404) is the plan's to fix; a host that breaks off is this server's network", async () => {
    const f = fixture();
    rmSync(cacheDir(), { recursive: true, force: true });               // nothing kept on the server from an earlier build
    const tool = host.files[TOOL_URL];
    delete host.files[TOOL_URL];
    const gone = await run(buildJob(f));
    expect(failOf(gone)).toEqual({ class: "plan", phase: "fetch" });
    expect(gone.message).toBe("fetching mingw-w64-clang-x86_64-clang-19.1.0-1-any.pkg.tar.zst failed: the download answered HTTP 404 (the host has no such file: the plan's address for it is wrong, or the file is gone)");
    host.files[TOOL_URL] = tool;
    const real = ndeps.fetch;
    ndeps.fetch = async (url: string, init?: RequestInit) => { if (url === TOOL_URL) throw new Error("socket hang up"); return real(url, init); };
    const net = await run(buildJob(f));
    expect(failOf(net)).toEqual({ class: "env", kind: "net" });
    expect(net.message).toBe("fetching mingw-w64-clang-x86_64-clang-19.1.0-1-any.pkg.tar.zst failed: the download failed: socket hang up");
    expect(steps()).toEqual([]);
  });

  test("wine that cannot start under the memory cap on this server: ludarr finds it out itself and the steps run without the cap", async () => {
    pdeps.tools = () => ({ ...tools7z, wine: "/usr/bin/wine", xvfb: "xvfb-run" });
    bdeps.which = (n: string) => (n === "prlimit" ? "/usr/bin/prlimit" : n === "zstd" ? "/usr/bin/zstd" : null);
    wineboot = capped => (capped ? { code: 1, stdout: "", stderr: "wine: failed to reserve range 00007ff000000000-00007ffffffe0000", timedOut: false } : ok());
    const f = fixture(kitSpec({ wine: true }));
    const b = await run(buildJob(f, false));
    expect(b.state).toBe("done");
    expect(b.transcript).toMatch(/wine does not start under the memory cap on this server \(each process at most [\d.]+ GB: exit 1\), and starts without it: the build's steps run without the cap/);
    const s = ran.find(r => r.cmd.includes("bash"))!;
    expect([s.capped, s.cmd[0]]).toEqual([null, "xvfb-run"]);
    // where wine starts under the cap, the steps keep it
    ran = [];
    wineboot = () => ok();
    expect((await run(buildJob(fixture(kitSpec({ wine: true })), false))).state).toBe("done");
    expect(ran.find(r => r.cmd.includes("bash"))!.capped).toMatch(/^--as=\d+$/);
    // where wine starts neither way: this server's trouble (no wine to run the kit's tools), and no step runs
    ran = [];
    wineboot = () => ({ code: 1, stdout: "", stderr: "wine: could not load kernel32.dll", timedOut: false });
    const bad = await run(buildJob(fixture(kitSpec({ wine: true })), false));
    expect(failOf(bad)).toEqual({ class: "env", kind: "tool" });
    expect(bad.message).toBe("wine could not set up its prefix (exit 1): wine: could not load kernel32.dll");
    expect(steps()).toEqual([]);
  });

  test("hashing what the build made tells the bytes of total inside one big file too", async () => {
    const p = join(tmp("kit-sum-"), "romfs.bin");
    writeFileSync(p, bytes(3 * 1024 * 1024, 5));
    const seen: number[] = [];
    expect(await fileSum(p, n => seen.push(n))).toEqual({ size: 3 * 1024 * 1024, sha256: sha256(bytes(3 * 1024 * 1024, 5)) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(3 * 1024 * 1024);
    expect(seen.every((n, i) => i === 0 || n > seen[i - 1])).toBe(true);
  });

  test("a plan changed while its kit build ran: the build is kept for what it was made from, and the way is not put together from it", async () => {
    const f = fixture();
    expect((await run(buildJob(f, false))).state).toBe("done");          // the kit is pinned on the plan from here
    // another game's way of the same plan, with a file of its own
    const g = upsertGame({ steam_appid: 992_900 + seq, name: `Kit Test Other ${seq}`, slug: `kit-test-other-${seq}` }) as GameRow;
    const nup2 = bytes(40_000, 9), p2 = join(f.store, "OoT-other.nup");
    writeFileSync(p2, nup2);
    const st = lstatSync(p2);
    const file2 = insertContent({ gameId: g.id, platform: "switch", name: "OoT-other.nup", path: p2, size: nup2.byteLength, hashes: { sha1: sha1(nup2), sha256: sha256(nup2) }, source: "inbox", stat: { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, dev: st.dev, ino: st.ino } });
    const own = { ...kitSpec().content!, accept: { hashes: [{ algo: "sha1" as const, value: sha1(nup2) }], formats: ["nup"] } };
    const w2 = updateWay(insertWay({ gameId: g.id, planId: f.plan.id, content: own, status: "ready" }).id, { contentId: file2.id })!;
    const inner = makeGame();
    step = cmd => { updatePlan(f.plan.id, { spec: kitSpec({ steps: [STEP, "strip --all {out}"] }) }); return inner(cmd); };
    const b = await run(enqueueJob({ kind: "build", planId: f.plan.id, wayId: w2.id, then: "assemble" }, { gameId: g.id }));
    expect(b.state).toBe("done");
    expect(b.transcript).toMatch(/the plan's program changed during the build: what it built is kept, and the way is not put together from it/);
    expect(b.message).toMatch(/the plan's program, tools or repo changed during the build, so what it built is not the plan's$/);
    expect((stmts.jobsByKind.all("assemble") as JobRow[]).filter(j => j.state === "queued")).toEqual([]);
  });

  test("an install folder holding a file named like the package's own manifest is refused", async () => {
    step = makeGame(dist => writeFileSync(join(dist, "ahoy.json"), "{}"));
    const b = await run(buildJob(fixture()));
    expect(failOf(b)).toEqual({ class: "plan", phase: "build" });
    expect(b.message).toMatch(/^the build's install folder holds a file named like the package's own manifest: ahoy\.json — remove them in the kit's steps/);
  });

  test("the scratch a kit build reserves: the kit and its fetches unpacked, and an install folder about the game file's size", async () => {
    const f = fixture();
    const scratch = jobKinds.get("build")!.scratch!;
    db.query("UPDATE contents SET size=? WHERE id=?").run(26e9, f.file.id);
    expect(await scratch({} as JobRow, { kind: "build", planId: f.plan.id, wayId: f.way.id })).toBe(20e9 + 3 * TOOL.byteLength + 3 * 300e6 + 26e9);
    expect(await scratch({} as JobRow, { kind: "build", planId: f.plan.id })).toBe(20e9 + 3 * TOOL.byteLength + 3 * 300e6);
  });

  test("Ocarina of Time (game 48) before its .nup lands: nothing is built — the game file comes first", () => {
    const f = fixture();
    db.query("UPDATE ways SET content_id=NULL WHERE id=?").run(f.way.id);
    expect(wayBuildNeeded(getPlan(f.plan.id)!, getWay(f.way.id)!)).toBe(false);
  });
});

describe("the build job's other kinds of failure", () => {
  test("a build job for a kit plan without a way says which game it needs", async () => {
    const f = fixture();
    const j = await run(enqueueJob({ kind: "build", planId: f.plan.id }, { gameId: f.game.id }));
    expect(j).toMatchObject({ state: "failed", message: "this plan builds the game with each game's own file: build one of its ways" });
    expect(failOf(j)).toEqual({ class: "other" });
    // a way whose file is gone: the file's
    db.query("UPDATE ways SET content_id=NULL WHERE id=?").run(f.way.id);
    const k = await run(buildJob(f));
    expect(failOf(k)).toEqual({ class: "file" });
    expect(k.message).toBe(`Kit Test ${seq} has no game file yet: add one before building`);
    expect(basename(f.nupPath)).toBe("OoT.nup");
  });
});

describe("a build for one game checks the room it will write before it starts (NX2navi wrote 26 GB three times before)", () => {
  test("too little room above what is kept free for the build's own output: refused at once, nothing fetched or run, with the numbers", async () => {
    const f = fixture();
    db.query("UPDATE contents SET size=? WHERE id=?").run(25e9, f.file.id);    // the live .nup is 25 GB
    const { keepFreeBytes } = await import("../src/ways/content");
    pdeps.diskSpace = async () => ({ free: keepFreeBytes() + 10e9, total: 1900e9 });
    const b = await run(buildJob(f));
    expect(failOf(b)).toEqual({ class: "env", kind: "room" });
    expect(b.message).toBe(`not enough room: building ${f.plan.name} for ${f.game.name} writes about 27.5 GB on the library, and 10.0 GB is free there above the 50.0 GB it keeps free (Settings → General → Import → Keep free on the library)`);
    expect(host.seen).toEqual([]);                                     // not even the kit was fetched
    expect(steps()).toEqual([]);
  });

  test("what a build writes: the largest build of the plan kept beside a game file, else the game file and a tenth more; a kept build for the pin writes nothing", async () => {
    const build = await import("../src/ways/build");
    const f = fixture();
    expect(build.buildNeedBytes(f.plan, f.way, { size: 25e9, path: f.nupPath })).toBe(27.5e9);
    // built once (plenty of room): its record says what a build of this plan writes
    expect((await run(buildJob(f, false))).state).toBe("done");
    const rec = readdirSync(join(f.store, ".builds")).find(n => n.endsWith(".json"))!;
    const size = (JSON.parse(readFileSync(join(f.store, ".builds", rec), "utf8")) as KitRecord).size;
    expect(build.buildNeedBytes(f.plan, f.way, { size: 25e9, path: f.nupPath })).toBe(Math.round(size * 1.05));
    // the build kept for the pinned kit: nothing to write, so a short library does not stop it
    const { keepFreeBytes } = await import("../src/ways/content");
    pdeps.diskSpace = async () => ({ free: keepFreeBytes() + 1, total: 1900e9 });
    const again = await run(buildJob(f, false));
    expect([again.state, failOf(again)]).toEqual(["done", null]);
  });
});


describe("server-only kit inputs", () => {
  const KEY = "ab".repeat(32);
  const DATA = new TextEncoder().encode(`master_key_00 = ${KEY}\n`);
  const NEED = { kind: "keys" as const, name: "prod.keys", place: "prod.keys", build: true };
  const spec = () => kitSpec({ steps: [STEP, "read-needs {needs} {out}"] }, { needs: [NEED] });
  function supply(f: ReturnType<typeof fixture>, data = DATA) {
    const path = join(tmp("kit-private-"), "prod.keys");
    writeFileSync(path, data);
    return insertContent({ role: "system", planId: f.plan.id, needIndex: 0, platform: "switch", name: "prod.keys", path, size: data.length, hashes: { sha1: sha1(data), sha256: sha256(data) }, source: "upload" });
  }
  function withInput(action: (needs: string, dist: string) => void) {
    const build = makeGame();
    step = cmd => {
      const m = /^read-needs '([^']+)' '([^']+)'$/.exec(cmd);
      if (!m) return build(cmd);
      expect(readFileSync(join(m[1], "prod.keys"))).toEqual(Buffer.from(DATA));
      action(m[1], join(m[2], "dist"));
      return ok();
    };
  }
  test("uses an existing matching upload, cleans its private copy, and assembles without shipping it", async () => {
    const donor = fixture(spec()), key = supply(donor), f = fixture(spec());
    expect(systemFiles(f.plan.id).map(x => x.id)).toEqual([key.id]);
    let privateDir = "";
    withInput(needs => { privateDir = needs; expect(join(needs, "prod.keys")).not.toBe(key.path); });
    const built = await run(buildJob(f));
    expect([built.state, built.message]).toEqual(["done", expect.any(String)]);
    expect(privateDir).not.toBe("");
    expect(existsSync(privateDir)).toBe(false);
    expect(existsSync(key.path)).toBe(true);
    const next = (stmts.jobsByKind.all("assemble") as JobRow[]).find(j => j.state === "queued")!;
    expect((await run(next)).state).toBe("done");
    const pkg = stmts.packageForGame.get(f.game.id) as PackageRow;
    expect(JSON.parse(pkg.manifest_json).files.map((f: { path: string }) => f.path).sort()).toEqual(["assets/data.bin", "ocarina.exe"]);
    expect(built.transcript).not.toContain(KEY);
    // A newly supplied key is a different recipe, even when the kit and game are unchanged.
    supply(f, new TextEncoder().encode(`master_key_00 = ${"cd".repeat(32)}\n`));
    expect(keptKitBuild(getPlan(f.plan.id)!, f.file)).toBeNull();
  });
  test("ambiguous uploads are not guessed, and missing inputs stop before fetching a kit", async () => {
    supply(fixture(spec()));
    supply(fixture(spec()), new TextEncoder().encode("a different upload"));
    const f = fixture(spec());
    expect(systemFiles(f.plan.id)).toEqual([]);
    const result = await run(buildJob(f));
    expect(result.state).toBe("failed");
    expect(result.message).toContain("prod.keys");
    expect(host.seen).toEqual([]);
    expect(steps()).toEqual([]);
  });
  test("changed bytes on disk cannot be used under an old stored hash", async () => {
    const f = fixture(spec()), key = supply(f);
    writeFileSync(key.path, DATA.map(x => x ^ 1));
    const result = await run(buildJob(f));
    expect(result.state).toBe("failed");
    expect(result.message).toContain("changed on disk");
    expect(steps()).toEqual([]);
  });
  test.each(["renamed", "embedded"])("rejects %s key material in the output", async mode => {
    const f = fixture(spec()); supply(f);
    let privateDir = "";
    withInput((needs, dist) => {
      privateDir = needs;
      writeFileSync(join(dist, "accidental.txt"), mode === "renamed" ? DATA : `settings\nmaster_key = ${KEY}\n`);
    });
    const result = await run(buildJob(f));
    expect(result.state).toBe("failed");
    expect(failOf(result)).toEqual({ class: "plan", phase: "build" });
    expect(result.message).toMatch(/server-only input|console key material/);
    expect(result.message).not.toContain(KEY);
    expect(existsSync(privateDir)).toBe(false);
    expect(keptKitBuild(getPlan(f.plan.id)!, f.file)).toBeNull();
  });
  test("cleans private copies when a build step fails", async () => {
    const f = fixture(spec()); supply(f);
    let privateDir = "";
    withInput(needs => { privateDir = needs; throw new Error("builder failed"); });
    expect((await run(buildJob(f))).state).toBe("failed");
    expect(privateDir).not.toBe("");
    expect(existsSync(privateDir)).toBe(false);
  });
  test("refuses an existing private-input directory before writing into it", async () => {
    const f = fixture(spec()); supply(f);
    const dir = tmp("existing-private-");
    writeFileSync(join(dir, "prod.keys"), "leave this alone");
    await expect(prepareBuildNeeds(buildNeeds(spec(), systemFiles(f.plan.id)), dir)).rejects.toThrow();
    expect(readFileSync(join(dir, "prod.keys"), "utf8")).toBe("leave this alone");
  });
  test("validates private input paths and requires a consuming kit", () => {
    const valid = validatePlanSpec(spec(), "recomp");
    expect(valid.ok).toBe(true);
    expect(valid.value!.needs[0].build).toBe(true);
    expect(validatePlanSpec(kitSpec({}, { needs: [NEED] }), "recomp").ok).toBe(false);
    expect(validatePlanSpec(kitSpec({ steps: [STEP, "read {needs}"] }), "recomp").ok).toBe(false);
    for (const place of ["../outside", "/absolute", "prod.keys/child", "PROD.KEYS"]) {
      expect(validatePlanSpec({ ...spec(), needs: [NEED, { ...NEED, place }] }, "recomp").ok).toBe(false);
    }
  });
});
