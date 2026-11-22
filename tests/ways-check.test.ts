/**
 * The plan's checks on the server (src/ways/check.ts): GPU-free steps on a throwaway copy of the install folder (nothing a
 * check writes ships; a kept game file is pointed at, never linked again or handed over), `expect` as text a line holds
 * (lines cut to 4 KB), a step whose needs this server's CPU or graphics lack not run ('env'), the smoke start's exit
 * code, output tail, window titles and screenshot, and what the server can run from /proc/cpuinfo and a probe under a
 * virtual display. The programs are fakes: the sandbox's exec answers for them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkEnvWords, checkFailure, ckdeps, cpuLevel, forgetServerCan, present, readProbe, runChecks, serverCan, smokeStart } from "../src/ways/check";
import { pdeps } from "../src/process/deps";
import { resetSandbox, sbdeps } from "../src/ways/sandbox";
import type { PlanCheck, RuntimePlanSpec } from "../src/ways/types";
import type { ExecOpts, ExecResult } from "../src/process/tools";
import { EnvError } from "../src/ways/errors";
import { ok, restoreDeps, tmp, tools7z } from "./ways-fixtures";

const V3 = "processor\t: 0\nflags\t\t: fpu sse sse2 ssse3 cx16 lahf_lm popcnt sse4_1 sse4_2 avx avx2 bmi1 bmi2 f16c fma abm movbe xsave\n";
const OLD = "processor\t: 0\nflags\t\t: fpu sse sse2 ssse3 cx16 lahf_lm popcnt sse4_1 sse4_2\n";
const PROBE_OUT = [
  "== wine", "wine-8.0 (Debian 8.0~repack-4)",
  "== glx", "name of display: :99", "OpenGL vendor string: Mesa", "OpenGL renderer string: llvmpipe (LLVM 15.0.6, 256 bits)",
  "== vulkan", "Devices:", "GPU0:", "\tdeviceType = PHYSICAL_DEVICE_TYPE_CPU", "\tdeviceName = llvmpipe (LLVM 15.0.6, 256 bits)",
  "== mesh", "0", "== end",
].join("\n");

const saved = { ...ckdeps };
let calls: { cmd: string[]; opts: ExecOpts }[] = [];
let answer: (cmd: string[], opts: ExecOpts) => ExecResult | Promise<ExecResult> = () => ok();
/** the command a sandboxed exec runs (after runuser … env -i NAME=value …, when the sandbox is there) */
const program = (cmd: string[]) => { if (!/runuser$/.test(cmd[0] ?? "")) return cmd; let at = cmd.indexOf("-i") + 1; while (at < cmd.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd[at])) at++; return cmd.slice(at); };

beforeEach(() => {
  calls = [];
  answer = () => ok();
  sbdeps.platform = () => "win32";
  process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
  pdeps.tools = () => ({ ...tools7z, wine: "/usr/bin/wine", xvfb: "/usr/bin/xvfb-run", bash: "/bin/bash" });
  sbdeps.exec = async (cmd, opts = {}) => { calls.push({ cmd, opts }); return answer(program(cmd), opts); };
  ckdeps.tools = () => pdeps.tools();
  ckdeps.cpuinfo = () => V3;
  ckdeps.probeDir = () => join(tmp("check-probe-"), "probe-1");
  ckdeps.shotsDir = () => shots;
  ckdeps.symlink = async () => { throw Object.assign(new Error("no symlinks"), { code: "EPERM" }); };
});
let shots = "";
afterEach(() => { restoreDeps(); Object.assign(ckdeps, saved); forgetServerCan(); resetSandbox(); delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

/** the probe answers like a server with wine, llvmpipe and lavapipe; anything else goes to `then` */
function probing(then: (cmd: string[], opts: ExecOpts) => ExecResult | Promise<ExecResult> = () => ok()) {
  answer = (cmd, opts) => (cmd.includes("probe") ? ok(PROBE_OUT) : then(cmd, opts));
}

const spec = (check: PlanCheck | null, o: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "x", channel: "stable" }, launch: { exe: "Kyty.exe", argv: ["--play", "{content}"] }, content: null, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", check, ...o,
});
/** an install folder as assemble leaves it: the program, and the game file linked from the content store */
function install() {
  const store = tmp("check-store-"), staging = tmp("check-staging-"), work = join(tmp("check-work-"), "job-31");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(staging, "Kyty.exe"), "MZ".padEnd(64, "x"));
  writeFileSync(join(staging, "settings.ini"), "a=1");
  mkdirSync(join(staging, "game"));
  const kept = join(store, "PPSA01341-app0.zar");
  writeFileSync(kept, "z".repeat(4096));
  chmodSync(kept, 0o444);
  linkSync(kept, join(staging, "game", "PPSA01341-app0.zar"));
  return { store, staging, work, kept, placed: "game/PPSA01341-app0.zar" };
}

describe("what this server can run (serverCan)", () => {
  test("the CPU's level from /proc/cpuinfo's flags", () => {
    expect(cpuLevel(V3)).toMatchObject({ level: "x86-64-v3", avx2: true });
    expect(cpuLevel(OLD)).toMatchObject({ level: "x86-64-v2", avx2: false });
    expect(cpuLevel("flags : fpu sse sse2\n")).toMatchObject({ level: "x86-64", avx2: false });
    expect(cpuLevel(V3.replace("flags\t\t: ", "flags\t\t: avx512f avx512bw avx512cd avx512dq avx512vl "))).toMatchObject({ level: "x86-64-v4" });
    expect(cpuLevel("")).toMatchObject({ level: null, avx2: false });
  });
  test("the probe's words: llvmpipe and lavapipe are software devices, a GPU is hardware, mesh shaders counted", () => {
    expect(readProbe(PROBE_OUT)).toMatchObject({ wine: true, gl: "software", vulkan: "software", meshShader: false });
    const gpu = PROBE_OUT.replace("PHYSICAL_DEVICE_TYPE_CPU", "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU").replace("llvmpipe (LLVM 15.0.6, 256 bits)\n== mesh\n0", "AMD Radeon RX 7800\n== mesh\n3").replace("OpenGL renderer string: llvmpipe (LLVM 15.0.6, 256 bits)", "OpenGL renderer string: AMD Radeon RX 7800 (radeonsi)");
    expect(readProbe(gpu)).toMatchObject({ gl: "hardware", vulkan: "hardware", meshShader: true });
    expect(readProbe("== wine\n== glx\nError: unable to open display\n== vulkan\nERROR_INITIALIZATION_FAILED\n== mesh\n0\n== end")).toMatchObject({ wine: false, gl: "none", vulkan: "none" });
  });
  test("probed in the sandbox under a virtual display once a day; the CPU's needs from the flags", async () => {
    probing();
    const can = await serverCan();
    expect(can).toMatchObject({ wine: true, gl: "software", vulkan: "software", meshShader: false, cpu: "x86-64-v3" });
    expect(can.meets.sort()).toEqual(["avx2", "gl", "vulkan", "wine", "x86-64-v2", "x86-64-v3"]);
    expect(can.notes).toContain("OpenGL: llvmpipe (LLVM 15.0.6, 256 bits)");
    const probe = calls.find(c => c.cmd.includes("probe"))!;
    expect(probe.cmd.slice(0, 4)).toEqual(["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 640x480x24"]);
    await serverCan();
    expect(calls.filter(c => c.cmd.includes("probe")).length).toBe(1);        // kept for a day
    ckdeps.cpuinfo = () => OLD;
    expect((await serverCan({ fresh: true })).meets).not.toContain("avx2");
  });
});

describe("the checks (runChecks)", () => {
  const kyty: PlanCheck = {
    steps: [
      { run: { exe: "Kyty.exe", argv: ["--param", "{content}", "--out", "{work}"], wine: true, timeoutSec: 600 }, expect: "params read", what: "the emulator reads the packed game" },
      { run: { exe: "Kyty.exe", argv: ["--bench"], wine: true, timeoutSec: 600 }, what: "the shader compiler runs", needs: ["avx2"] },
    ],
  };

  test("a step runs on a throwaway copy: what it writes never reaches the install folder, and {content} is the game file in that copy", async () => {
    const i = install();
    ckdeps.smallFile = 1024;                                                   // the game file is a big one here
    let seenArgs: string[] = [];
    probing((cmd, opts) => {
      if (!cmd.includes("/usr/bin/wine")) return ok();
      if (cmd.includes("--param")) seenArgs = cmd;
      writeFileSync(join(opts.cwd!, "shader.cache"), "written by the check");   // the program writes beside itself
      return ok("loading\nparams read: PPSA01341 01.007.000\ndone");
    });
    const lines: string[] = [];
    const r = await runChecks({ staging: i.staging, work: i.work, spec: spec(kyty), placed: i.placed, signal: new AbortController().signal, log: l => lines.push(l), jobId: 31 });
    expect(r.verdict).toBe("pass");
    expect(r.steps.map(s => [s.ok, s.code])).toEqual([[true, 0], [true, 0]]);
    const content = seenArgs[seenArgs.indexOf("--param") + 1];
    expect(content).toMatch(/[\\/]check[\\/]install[\\/]game[\\/]PPSA01341-app0\.zar$/);
    expect(readdirSync(i.staging).sort()).toEqual(["Kyty.exe", "game", "settings.ini"]);   // nothing the check wrote ships
    expect(existsSync(join(i.work, "check"))).toBe(false);                    // the throwaway copy is gone
    expect(lstatSync(i.kept).nlink).toBe(2);                                  // the store file: its link from the package only
    expect(r.text).toBe("passed: the emulator reads the packed game (exit 0, 0 s); passed: the shader compiler runs (exit 0, 0 s)");
    expect(lines.some(l => /a throwaway copy of the install folder \(\d+ big files? linked/.test(l))).toBe(true);
  });

  test("a step whose needs this server's CPU lacks is not run: 'env', and the package still builds", async () => {
    const i = install();
    ckdeps.cpuinfo = () => OLD;
    probing((cmd) => (cmd.includes("/usr/bin/wine") ? ok("params read") : ok()));
    const r = await runChecks({ staging: i.staging, work: i.work, spec: spec(kyty), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("env");
    expect(r.steps[1]).toMatchObject({ code: null, ok: false, tail: "not run here: the server's CPU lacks AVX2" });
    expect(calls.filter(c => program(c.cmd).includes("--bench")).length).toBe(0);
    expect(checkEnvWords(r)).toBe("not run here: the server's CPU lacks AVX2");
    expect(checkFailure(r)).toBeNull();
  });

  test("a step that fails, or prints no line holding `expect`, fails the check with its words", async () => {
    const i = install();
    probing(cmd => (cmd.includes("--param") ? { code: 3, stdout: "loading", stderr: "shader 12: unsupported opcode\nfatal", timedOut: false } : ok()));
    const r = await runChecks({ staging: i.staging, work: i.work, spec: spec({ steps: [kyty.steps[0]] }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("fail");
    expect(checkFailure(r)).toBe("check: the emulator reads the packed game failed (exit 3): loading | shader 12: unsupported opcode | fatal");
    probing(cmd => (cmd.includes("--param") ? ok("loading\nall good") : ok()));
    const r2 = await runChecks({ staging: i.staging, work: i.work, spec: spec({ steps: [kyty.steps[0]] }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r2.verdict).toBe("fail");
    expect(r2.steps[0].tail.split("\n")[0]).toBe('no line of its output holds "params read"');
  });

  test("a step is stopped when the library falls below what LIBRARY_KEEP_FREE_GB keeps free while it runs (EnvError 'room')", async () => {
    const i = install();
    process.env.LIBRARY_KEEP_FREE_GB = "50";
    try {
      let free = 900e9;
      pdeps.diskSpace = async () => ({ free, total: 2000e9 });
      ckdeps.roomMs = 20;
      let started = 0;
      probing((cmd, opts) => {
        if (!cmd.includes("--fill")) return ok();
        started++;
        // the program writes and writes: the library's free space drops while it runs, until it is stopped
        return new Promise<ExecResult>(res => {
          const drop = setTimeout(() => { free = 40e9; }, 30);
          const t = setTimeout(() => res(ok("filled")), 3000);
          opts.signal?.addEventListener("abort", () => { clearTimeout(t); clearTimeout(drop); res({ code: 143, stdout: "", stderr: "", timedOut: false }); }, { once: true });
        });
      });
      const fill: PlanCheck = { steps: [
        { run: { exe: "sh", argv: ["-c", "--fill"], wine: false, timeoutSec: 600 }, what: "the shader cache is built" },
        { run: { exe: "sh", argv: ["-c", "--after"], wine: false, timeoutSec: 600 }, what: "the next step" },
      ] };
      const t0 = Date.now();
      const err = await runChecks({ staging: i.staging, work: i.work, spec: spec(fill), placed: i.placed, signal: new AbortController().signal, log: () => {} }).then(() => null, e => e);
      expect(Date.now() - t0).toBeLessThan(2500);                              // stopped, not run to its end
      expect(err).toBeInstanceOf(EnvError);
      expect(err).toMatchObject({ kind: "room" });
      expect(err.message).toMatch(/^not enough room: the library fell to 40 GB free while check 1 \(the shader cache is built\) ran, below the 50 GB it keeps free/);
      expect(started).toBe(1);
      expect(calls.some(c => program(c.cmd).includes("--after"))).toBe(false); // nothing more runs on a full library
      expect(existsSync(join(i.work, "check"))).toBe(false);                  // what it wrote is gone
    } finally { delete process.env.LIBRARY_KEEP_FREE_GB; }
  });

  test("`expect` is plain text in one output line, and a line is looked at up to 4 KB only", async () => {
    const i = install();
    const step = (expectText: string) => spec({ steps: [{ run: { exe: "Kyty.exe", argv: ["--param", "{content}"], wine: true, timeoutSec: 60 }, expect: expectText, what: "reads it" }] });
    probing(() => ok(`${"x".repeat(5000)} params read\n(a+)+$ matched`));
    const far = await runChecks({ staging: i.staging, work: i.work, spec: step("params read"), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(far.verdict).toBe("fail");                                          // beyond 4 KB of its line
    const literal = await runChecks({ staging: i.staging, work: i.work, spec: step("(a+)+$"), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(literal.verdict).toBe("pass");                                      // matched as text, never as a pattern
  });

  test("a way's own check runs in place of the plan's; no check is 'none'", async () => {
    const i = install();
    probing(cmd => (cmd.includes("--own") ? ok("own check") : { code: 9, stdout: "", stderr: "plan's check ran", timedOut: false }));
    const own: PlanCheck = { steps: [{ run: { exe: "Kyty.exe", argv: ["--own"], wine: true, timeoutSec: 60 }, what: "the way's own" }] };
    const r = await runChecks({ staging: i.staging, work: i.work, spec: spec(kyty), check: own, placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect([r.verdict, r.steps.map(s => s.what)]).toEqual(["pass", ["the way's own"]]);
    expect(await runChecks({ staging: i.staging, work: i.work, spec: spec(null), placed: null, signal: new AbortController().signal, log: () => {} })).toEqual({ verdict: "none", steps: [], smoke: null, text: "no checks" });
  });

  test("on a volume that cannot link, big files are copied (saying how far) up to a cap; past it the checks are not run here", async () => {
    const i = install();
    ckdeps.smallFile = 16;
    ckdeps.link = async () => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); };
    probing(cmd => (cmd.includes("--param") ? ok("params read") : ok()));
    const one = { steps: [kyty.steps[0]] };
    const r = await runChecks({ staging: i.staging, work: i.work, spec: spec(one), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("pass");
    ckdeps.copyCap = 100;
    const r2 = await runChecks({ staging: i.staging, work: i.work, spec: spec(one), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r2.verdict).toBe("env");
    expect(r2.steps[0].tail).toBe("not run here: the install folder's game/PPSA01341-app0.zar (0.0 GB) cannot be linked into a throwaway copy for the checks here (EXDEV), and copying that much for a check is not done");
    expect(checkEnvWords(r2)).toBe(r2.steps[0].tail);
  });

  test("the store's game file is pointed at from the throwaway copy, so the check adds no link to it (its ctime stays)", async () => {
    const i = install();
    ckdeps.smallFile = 1024;
    const pointers: [string, string][] = [];
    ckdeps.symlink = async (target, path) => { pointers.push([target, path]); writeFileSync(path, readFileSync(target)); };
    let during = 0;
    probing(cmd => { if (cmd.includes("--param")) during = lstatSync(i.kept).nlink; return ok("params read"); });
    const before = lstatSync(i.kept).ctimeMs;
    const r = await runChecks({ staging: i.staging, work: i.work, spec: spec({ steps: [kyty.steps[0]] }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("pass");
    expect(pointers.map(([t]) => t)).toEqual([join(i.staging, "game", "PPSA01341-app0.zar")]);
    expect(during).toBe(2);
    expect(lstatSync(i.kept).ctimeMs).toBe(before);
  });
});

describe("the smoke start (smokeStart)", () => {
  beforeEach(() => { shots = tmp("check-shots-"); });
  /** the smoke script's files, written as a program under wine would leave them */
  function smoke(o: { titles?: string; code?: string; out?: string; shot?: boolean; shotBytes?: Buffer } = {}) {
    probing((cmd, opts) => {
      if (cmd[6]?.startsWith("dir=$1")) {
        const [titles, shot, out, codef] = cmd.slice(9, 13);
        writeFileSync(titles, o.titles ?? "Demon's Souls\nDemon's Souls\n");
        if (o.shot !== false) writeFileSync(shot, o.shotBytes ?? FAKE_PNG);
        writeFileSync(out, o.out ?? "0024:err:module:import_dll Library vulkan-1.dll loaded\nrendering");
        writeFileSync(codef, o.code ?? "running");
        expect(opts.env?.WINEDEBUG).toBe("err+all");                           // the smoke start alone gets wine's errors
      }
      return ok();
    });
  }
  /** a PNG as `import` writes one: its eight-byte signature, then (here) anything */
  const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake image")]);
  const sp = (smokeDef: PlanCheck["smoke"]) => spec({ steps: [], smoke: smokeDef });

  test("it reports whether the program kept running, its windows, one screenshot (kept for the admin) and what it printed", async () => {
    const i = install();
    smoke();
    const old = join(shots, "job-1-old.png"), recent = join(shots, "job-2-recent.png");
    writeFileSync(old, "x"); writeFileSync(recent, "x");
    utimesSync(old, new Date(Date.now() - 40 * 86_400_000), new Date(Date.now() - 40 * 86_400_000));
    utimesSync(recent, new Date(Date.now() - 10 * 86_400_000), new Date(Date.now() - 10 * 86_400_000));
    const r = await smokeStart({ staging: i.staging, work: i.work, spec: sp({ seconds: 8, title: "demon", needs: "vulkan" }), placed: i.placed, signal: new AbortController().signal, log: () => {}, jobId: 58 });
    expect(r).toMatchObject({ verdict: "pass", alive: true, exitCode: null, titles: ["Demon's Souls"] });
    expect(r.why).toBe('a window titled "Demon\'s Souls" showed up');
    expect(r.screenshot).toMatch(/^job-58-[a-z0-9]+\.png$/);
    expect(readFileSync(join(shots, r.screenshot!)).equals(FAKE_PNG)).toBe(true);
    expect(r.outputTail).toBe("0024:err:module:import_dll Library vulkan-1.dll loaded\nrendering");
    expect(existsSync(old)).toBe(false);                                      // older than 30 days
    expect(existsSync(recent)).toBe(true);
    const run = calls.find(c => program(c.cmd)[6]?.startsWith("dir=$1"))!;
    expect(program(run.cmd).slice(13, 18)).toEqual(["/usr/bin/wine", program(run.cmd)[14], "8", join(i.staging, "Kyty.exe"), "--play"]);
    expect(program(run.cmd)[18]).toMatch(/\\game\\PPSA01341-app0\.zar$/);      // {content} as the launcher fills it
  });

  test("it fails when the program ends with an error, or the window it should open never shows up", async () => {
    const i = install();
    smoke({ code: "1", titles: "" });
    const r = await smokeStart({ staging: i.staging, work: i.work, spec: sp({ seconds: 5, needs: "nothing" }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r).toMatchObject({ verdict: "fail", alive: false, exitCode: 1, why: "it ended within 5 s with exit 1" });
    smoke({ titles: "Kyty launcher" });
    const r2 = await smokeStart({ staging: i.staging, work: i.work, spec: sp({ seconds: 5, title: "Demon's Souls", needs: "nothing" }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r2).toMatchObject({ verdict: "fail", why: 'no window titled "Demon\'s Souls" showed up in 5 s' });
  });

  test("a device the program could not get proves nothing ('env'); a server without one for what it draws with is not asked to start it", async () => {
    const i = install();
    smoke({ code: "1", out: "vkCreateInstance failed: VK_ERROR_INCOMPATIBLE_DRIVER" });
    const r = await smokeStart({ staging: i.staging, work: i.work, spec: sp({ seconds: 5, needs: "vulkan" }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("env");
    expect(r.why).toBe("not started here: the server has no graphics device it can use (vkCreateInstance failed: VK_ERROR_INCOMPATIBLE_DRIVER)");
    calls = [];
    answer = cmd => (cmd.includes("probe") ? ok(PROBE_OUT.replace(/== vulkan[\s\S]*== mesh/, "== vulkan\nERROR_INITIALIZATION_FAILED\n== mesh")) : ok());
    forgetServerCan();
    const r2 = await smokeStart({ staging: i.staging, work: i.work, spec: sp({ seconds: 5, needs: "d3d12" }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r2).toMatchObject({ verdict: "env", why: "not started here: the server has no graphics device (Direct3D 12 needs Vulkan)" });
    expect(calls.filter(c => program(c.cmd)[6]?.startsWith("dir=$1")).length).toBe(0);
  });

  test("runChecks starts the program on its throwaway copy and the report carries the smoke start", async () => {
    const i = install();
    smoke({ titles: "Ocarina of Time" });
    const r = await runChecks({ staging: i.staging, work: i.work, spec: sp({ seconds: 5, title: "Ocarina", needs: "gl" }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("pass");
    expect(r.smoke?.verdict).toBe("pass");
    const run = calls.find(c => program(c.cmd)[6]?.startsWith("dir=$1"))!;
    expect(program(run.cmd)[16]).toMatch(/[\\/]check[\\/]install[\\/]Kyty\.exe$/);
    expect(r.text).toBe('started: a window titled "Ocarina of Time" showed up');
  });
});

describe("a kept game file in a check under the sandbox (C2)", () => {
  test("handed to the build user and back for a check, the store's file is never chowned or chmodded", async () => {
    const i = install();
    const seen: string[] = [];
    sbdeps.platform = () => "linux";
    sbdeps.uid = () => 0;
    sbdeps.which = n => (n === "runuser" ? "/usr/sbin/runuser" : null);
    sbdeps.passwd = () => "root:x:0:0::/root:/bin/sh\nbuilder:x:1500:1500::/home/builder:/bin/sh\n";
    sbdeps.chown = async p => { seen.push(p); };
    sbdeps.chmod = async p => { seen.push(p); };
    ckdeps.smallFile = 1024;
    probing(cmd => (cmd.includes("--param") ? ok("params read") : ok()));
    const kept = lstatSync(i.kept);
    const r = await runChecks({ staging: i.staging, work: i.work, spec: spec({ steps: [{ run: { exe: "Kyty.exe", argv: ["--param", "{content}"], wine: true, timeoutSec: 60 }, expect: "params read", what: "reads it" }] }), placed: i.placed, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("pass");
    expect(seen.length).toBeGreaterThan(0);
    const same = (p: string) => { try { const s = lstatSync(p); return s.ino === kept.ino && s.dev === kept.dev; } catch { return false; } };
    expect(seen.filter(same)).toEqual([]);
    expect(seen).not.toContain(join(i.staging, "game", "PPSA01341-app0.zar"));
    expect(lstatSync(i.kept).mode & 0o222).toBe(0);
  });
});


test.skipIf(process.platform === "win32")("a cached executable can run through the engine's throwaway symbolic link", async () => {
  const i = install();
  linkSync(join(i.staging, "Kyty.exe"), join(i.store, "cached.exe"));
  const before = lstatSync(join(i.staging, "Kyty.exe"));
  ckdeps.symlink = saved.symlink;
  let ran = false;
  probing(cmd => { if (cmd.includes("--selftest")) ran = true; return ok("selftest: passed"); });
  const check: PlanCheck = { steps: [{ run: { exe: "kyty.EXE", argv: ["--selftest"], wine: true, timeoutSec: 30 }, expect: "selftest: passed", what: "cached program self-test" }] };
  const result = await runChecks({ ...i, spec: spec(check), signal: new AbortController().signal, log: () => {} });
  expect(result.verdict).toBe("pass");
  expect(ran).toBe(true);
  const after = lstatSync(join(i.staging, "Kyty.exe"));
  expect([after.nlink, after.ctimeMs, after.size]).toEqual([before.nlink, before.ctimeMs, before.size]);
});

test.skipIf(process.platform === "win32")("executable lookup follows only explicitly allowed mirror links", async () => {
  const dir = tmp("check-link-lookup-");
  writeFileSync(join(dir, "program.exe"), "MZ");
  const link = join(dir, "mirror.exe");
  symlinkSync(join(dir, "program.exe"), link);
  expect(await present(dir, "mirror.exe")).toBeNull();
  expect(await present(dir, "MIRROR.EXE", [link])).toBe("mirror.exe");
  expect(await present(dir, "mirror.exe", [join(dir, "another.exe")])).toBeNull();
});
