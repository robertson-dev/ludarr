/**
 * The checks with the live cases' shapes and what ludarr must never do with them (src/ways/check.ts): a game folder
 * placed by links is pointed at from the throwaway copy, never copied (tens of thousands of small files); a check that
 * runs for minutes keeps saying so; what the smoke start's programs leave is read without following a link (a link or a
 * second name could be any of root's files, which would reach the report, the AI's next brief and the admin's screen)
 * and a "screenshot" that is no PNG is not kept; NX2navi's self-test needs x86-64-v3 and wine; Zelda 64: Recompiled's
 * smoke start draws with Vulkan, which mesa's software device gives. The programs are fakes: the sandbox's exec answers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ckdeps, forgetServerCan, runChecks, smokeStart } from "../src/ways/check";
import { pdeps } from "../src/process/deps";
import { resetSandbox, sbdeps } from "../src/ways/sandbox";
import type { PlanCheck, RuntimePlanSpec } from "../src/ways/types";
import type { ExecOpts, ExecResult } from "../src/process/tools";
import { dirLink, ok, restoreDeps, tmp, tools7z } from "./ways-fixtures";

const V2 = "processor\t: 0\nflags\t\t: fpu sse sse2 ssse3 cx16 lahf_lm popcnt sse4_1 sse4_2\n";
const V3 = "processor\t: 0\nflags\t\t: fpu sse sse2 ssse3 cx16 lahf_lm popcnt sse4_1 sse4_2 avx avx2 bmi1 bmi2 f16c fma abm movbe xsave\n";
/** a server with wine, mesa's llvmpipe and lavapipe and no GPU: what the image gives */
const PROBE_OUT = ["== wine", "wine-8.0 (Debian 8.0~repack-4)", "== glx", "OpenGL renderer string: llvmpipe (LLVM 15.0.6, 256 bits)",
  "== vulkan", "GPU0:", "\tdeviceType = PHYSICAL_DEVICE_TYPE_CPU", "\tdeviceName = llvmpipe (LLVM 15.0.6, 256 bits)", "== mesh", "0", "== end"].join("\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image")]);

const saved = { ...ckdeps };
let calls: { cmd: string[]; opts: ExecOpts }[] = [];
let answer: (cmd: string[], opts: ExecOpts) => ExecResult | Promise<ExecResult> = () => ok();
let shots = "";
const program = (cmd: string[]) => { if (!/runuser$/.test(cmd[0] ?? "")) return cmd; let at = cmd.indexOf("-i") + 1; while (at < cmd.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd[at])) at++; return cmd.slice(at); };

beforeEach(() => {
  calls = [];
  sbdeps.platform = () => "win32";
  process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
  pdeps.tools = () => ({ ...tools7z, wine: "/usr/bin/wine", xvfb: "/usr/bin/xvfb-run", bash: "/bin/bash" });
  sbdeps.exec = async (cmd, opts = {}) => { calls.push({ cmd, opts }); return answer(program(cmd), opts); };
  answer = cmd => (cmd.includes("probe") ? ok(PROBE_OUT) : ok());
  ckdeps.tools = () => pdeps.tools();
  ckdeps.cpuinfo = () => V3;
  ckdeps.probeDir = () => join(tmp("check-probe-"), "probe-1");
  shots = tmp("check-shots-");
  ckdeps.shotsDir = () => shots;
});
afterEach(() => { restoreDeps(); Object.assign(ckdeps, saved); forgetServerCan(); resetSandbox(); delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

const spec = (check: PlanCheck | null, o: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "x", channel: "stable" }, launch: { exe: "Game.exe", argv: [] }, content: null, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", check, ...o,
});

describe("the throwaway copy of an install folder", () => {
  test("a game folder placed by links (a PS4/PS3 dump: thousands of small files) is pointed at, file by file, and nothing of it is copied", async () => {
    const store = tmp("check-store-"), staging = tmp("check-staging-"), work = join(tmp("check-work-"), "job-70");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(staging, "Emu.exe"), "MZ");
    writeFileSync(join(staging, "emu.ini"), "x=1");
    mkdirSync(join(store, "CUSA00001-app0", "sce_sys"), { recursive: true });
    mkdirSync(join(staging, "games", "CUSA00001", "sce_sys"), { recursive: true });
    const rels = ["eboot.bin", "sce_sys/param.sfo", ...Array.from({ length: 40 }, (_, i) => `sce_sys/chunk-${i}.dat`)];
    for (const rel of rels) {
      writeFileSync(join(store, "CUSA00001-app0", ...rel.split("/")), `data of ${rel}`);
      chmodSync(join(store, "CUSA00001-app0", ...rel.split("/")), 0o444);
      linkSync(join(store, "CUSA00001-app0", ...rel.split("/")), join(staging, "games", "CUSA00001", ...rel.split("/")));
    }
    const pointed: string[] = [];
    ckdeps.symlink = async (target, path) => { pointed.push(target); writeFileSync(path, "a pointer"); };
    let seenInstall: string[] = [];
    answer = (cmd, opts) => { if (cmd.includes("probe")) return ok(PROBE_OUT); if (cmd.includes("--check")) seenInstall = readdirSync(opts.cwd!); return ok("all files there"); };
    const lines: string[] = [];
    const r = await runChecks({ staging, work, spec: spec({ steps: [{ run: { exe: "Emu.exe", argv: ["--check", "{content}"], wine: true, timeoutSec: 60 }, expect: "all files there", what: "the emulator finds the game" }] }), placed: "games/CUSA00001", signal: new AbortController().signal, log: l => lines.push(l) });
    expect(r.verdict).toBe("pass");
    expect(pointed.length).toBe(rels.length);                                   // every file of the game folder pointed at
    expect(pointed.every(p => p.startsWith(join(staging, "games")))).toBe(true);
    expect(seenInstall.sort()).toEqual(["Emu.exe", "emu.ini", "games"]);
    expect(lines.some(l => l.includes(`(${rels.length} big files linked, 0.0 GB copied)`))).toBe(true);   // only the program's two small files were copied
    for (const rel of rels) expect(lstatSync(join(store, "CUSA00001-app0", ...rel.split("/"))).nlink).toBe(2);
  });
});

describe("a check that takes a while", () => {
  test("it keeps saying what it is running and for how long", async () => {
    const staging = tmp("check-staging-"), work = join(tmp("check-work-"), "job-71");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(staging, "ocarina.exe"), "MZ");
    ckdeps.tickMs = 5;
    answer = async cmd => { if (cmd.includes("probe")) return ok(PROBE_OUT); await new Promise(r => setTimeout(r, 60)); return ok("selftest: ok"); };
    const said: string[] = [];
    const r = await runChecks({ staging, work, spec: spec({ steps: [{ run: { exe: "ocarina.exe", argv: ["--selftest"], wine: true, timeoutSec: 600 }, expect: "selftest: ok", what: "the game's self-test" }] }), placed: null, signal: new AbortController().signal, log: () => {}, progress: (_p, m) => said.push(m) });
    expect(r.verdict).toBe("pass");
    expect(said).toContain("checking: the game's self-test (1 of 1)");
    expect(said.some(m => /^checking: the game's self-test \(1 of 1\) · \d+:\d\d$/.test(m))).toBe(true);
  });
});

describe("what the smoke start's programs leave behind", () => {
  function install() {
    const staging = tmp("check-staging-"), work = join(tmp("check-work-"), "job-72");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(staging, "Game.exe"), "MZ");
    return { staging, work };
  }
  const smokeFiles = (cmd: string[]) => { const [titles, shot, out, code] = cmd.slice(9, 13); return { titles, shot, out, code }; };

  test("a file the program made a second name of root's (a hard link), or a link, is never read into the report", async () => {
    const i = install();
    const secret = join(tmp("check-root-"), "settings.json");
    writeFileSync(secret, '{"anthropicKey":"sk-ant-SECRET"}');
    answer = cmd => {
      if (cmd.includes("probe")) return ok(PROBE_OUT);
      if (cmd[6]?.startsWith("dir=$1")) {
        const f = smokeFiles(cmd);
        writeFileSync(f.titles, "Game");
        linkSync(secret, f.out);                                                 // the program's output is root's file
        dirLink(tmp("check-elsewhere-"), f.code);                                // the exit code file is a link
        writeFileSync(f.shot, PNG);
      }
      return ok();
    };
    const r = await smokeStart({ staging: i.staging, work: i.work, spec: spec({ steps: [], smoke: { seconds: 5, needs: "nothing" } }), placed: null, signal: new AbortController().signal, log: () => {} });
    expect(r.outputTail).toBe("");
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(r.exitCode).toBeNull();
    expect(r.titles).toEqual(["Game"]);
    expect(r.screenshot).toMatch(/^job-0-[a-z0-9]+\.png$/);
  });

  test("a screenshot that is not a PNG is not kept for the admin's screen", async () => {
    const i = install();
    answer = cmd => {
      if (cmd.includes("probe")) return ok(PROBE_OUT);
      if (cmd[6]?.startsWith("dir=$1")) { const f = smokeFiles(cmd); writeFileSync(f.titles, "Game"); writeFileSync(f.out, "ok"); writeFileSync(f.code, "running"); writeFileSync(f.shot, "<html><script>alert(1)</script></html>"); }
      return ok();
    };
    const r = await smokeStart({ staging: i.staging, work: i.work, spec: spec({ steps: [], smoke: { seconds: 5, needs: "nothing" } }), placed: null, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("pass");
    expect(r.screenshot).toBeNull();
    expect(readdirSync(shots)).toEqual([]);
  });
});

describe("the live cases' checks", () => {
  // NX2navi's server build pins x86-64-v3; its check is the built game's own self-test under wine
  const nx2navi: PlanCheck = { steps: [{ run: { exe: "ocarina.exe", argv: ["--selftest"], wine: true, timeoutSec: 600 }, expect: "selftest passed", what: "the game's self-test", needs: ["x86-64-v3", "wine"] }] };
  function built() {
    const staging = tmp("check-nx-"), work = join(tmp("check-work-"), "job-73");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(staging, "ocarina.exe"), "MZ");
    return { staging, work };
  }

  test("NX2navi on a server whose CPU is x86-64-v2 is not run there: 'env', in words, and the package still builds", async () => {
    const b = built();
    ckdeps.cpuinfo = () => V2;
    const r = await runChecks({ staging: b.staging, work: b.work, spec: spec(nx2navi), placed: null, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("env");
    expect(r.steps[0]).toMatchObject({ code: null, ok: false, tail: "not run here: the server's CPU is not x86-64-v3 (it is x86-64-v2)" });
    expect(calls.filter(c => program(c.cmd).includes("--selftest")).length).toBe(0);
  });

  test("NX2navi on an x86-64-v3 server with wine runs its self-test under wine", async () => {
    const b = built();
    answer = cmd => (cmd.includes("probe") ? ok(PROBE_OUT) : cmd.includes("--selftest") ? ok("selftest passed: 412 checks") : ok());
    const r = await runChecks({ staging: b.staging, work: b.work, spec: spec(nx2navi), placed: null, signal: new AbortController().signal, log: () => {} });
    expect(r.verdict).toBe("pass");
    const run = calls.find(c => program(c.cmd).includes("--selftest"))!;
    expect(program(run.cmd).some(a => /wine/.test(a))).toBe(true);
  });

  test("Zelda 64: Recompiled's start draws with Vulkan: mesa's software device counts, so it is started, not skipped", async () => {
    const b = built();
    writeFileSync(join(b.staging, "Zelda64Recompiled.exe"), "MZ");
    answer = cmd => {
      if (cmd.includes("probe")) return ok(PROBE_OUT);
      if (cmd[6]?.startsWith("dir=$1")) { const [titles, shot, out, code] = cmd.slice(9, 13); writeFileSync(titles, "Zelda 64: Recompiled"); writeFileSync(shot, PNG); writeFileSync(out, "RT64: using llvmpipe"); writeFileSync(code, "running"); }
      return ok();
    };
    const r = await smokeStart({ staging: b.staging, work: b.work, spec: spec(null, { launch: { exe: "Zelda64Recompiled.exe", argv: [] } }), smoke: { seconds: 8, title: "Zelda", needs: "vulkan" }, placed: null, signal: new AbortController().signal, log: () => {} });
    expect(r).toMatchObject({ verdict: "pass", alive: true, titles: ["Zelda 64: Recompiled"] });
    // and on a server with no Vulkan at all it is "not started here", never a failure
    forgetServerCan();
    answer = cmd => (cmd.includes("probe") ? ok(PROBE_OUT.replace(/== vulkan[\s\S]*== mesh/, "== vulkan\nERROR_INITIALIZATION_FAILED\n== mesh")) : ok());
    const none = await smokeStart({ staging: b.staging, work: b.work, spec: spec(null, { launch: { exe: "Zelda64Recompiled.exe", argv: [] } }), smoke: { seconds: 8, title: "Zelda", needs: "vulkan" }, placed: null, signal: new AbortController().signal, log: () => {} });
    expect(none).toMatchObject({ verdict: "env", why: "not started here: the server has no graphics device with Vulkan" });
  });
});
