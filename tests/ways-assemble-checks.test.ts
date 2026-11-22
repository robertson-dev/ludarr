/**
 * The plan's checks inside an assemble (DESIGN3 B3 item 3 "checks"; SEAMS "The check"; AMEND M4): run once the package is
 * put together, on a throwaway copy (src/ways/check.ts, faked here): a failing check keeps the old package and ends the job
 * as the plan's check fault ("check: …"), one the server cannot run builds the package and says so in the job's message,
 * the report is a {kind: "check"} step of the job's trace; a way's own check replaces the plan's and its setup steps run
 * after the plan's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { enqueueJob } from "../src/process/kinds";
import { runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { adeps } from "../src/ways/assemble";
import { prdeps } from "../src/ways/program";
import { sbdeps } from "../src/ways/sandbox";
import { getWay, insertContent, insertPlan, insertWay, updateWay } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import type { CheckReport, PlanCheck, RuntimePlanSpec } from "../src/ways/types";
import { bytes, fake7z, releaseHost, restoreDeps, sha1, sha256, tempConfig, tmp, tools7z, zelda } from "./ways-fixtures";

const ASSET = "Zelda64Recompiled-v1.2.2-Windows.zip";
const URL_ = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.2/${ASSET}`;
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(4000, 7)]);
const RELEASE = { tag: "v1.2.2", name: "v1.2.2", date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: ASSET, url: URL_, size: ZIP.byteLength, digest: `sha256:${sha256(ZIP)}` } };
const SELFTEST: PlanCheck = { steps: [{ run: { exe: "Zelda64Recompiled.exe", argv: ["--selftest"], wine: true, timeoutSec: 60 }, what: "its self-test" }] };
const spec = (sha: string, over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "Zelda64Recompiled.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "Majora's Mask", search: ["Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha }], formats: ["z64"] }, normalize: null, place: "mm.z64" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", check: SELFTEST, ...over,
});

let seq = 0;
function fixture(over: (sha: string) => Partial<RuntimePlanSpec> = () => ({})) {
  seq++;
  const game = upsertGame({ steam_appid: 990_000 + seq, name: `Check Test ${seq}`, slug: `check-test-${seq}` }) as GameRow;
  const rom = bytes(32 * 1024, seq);
  const romPath = join(tmp("check-rom-"), "mm.z64");
  writeFileSync(romPath, rom);
  const checked = validatePlanSpec(spec(sha1(rom), over(sha1(rom))), "recomp");
  if (!checked.ok) throw new Error(`fixture plan does not validate: ${checked.errors.join("; ")}`);
  const plan = insertPlan({ name: `Check Plan ${seq}`, kind: "recomp", repo: "Zelda64Recomp/Zelda64Recomp", platforms: ["n64"], spec: checked.value!, status: "ready" });
  const file = insertContent({ gameId: game.id, platform: "n64", name: basename(romPath), path: romPath, size: rom.byteLength, hashes: { sha1: sha1(rom), sha256: sha256(rom) }, source: "upload" });
  const way = updateWay(insertWay({ gameId: game.id, planId: plan.id, status: "ready" }).id, { contentId: file.id })!;
  return { game, plan, way };
}
const build = async (wayId: number) => { const j = enqueueJob({ kind: "assemble", wayId }, { gameId: getWay(wayId)!.game_id }); await runJob(j.id); return stmts.jobById.get(j.id) as JobRow; };
const pkgOf = (gameId: number) => (stmts.packageForGame.get(gameId) as PackageRow | null) ?? null;
const traceOf = (j: JobRow) => JSON.parse(j.trace_json ?? "[]") as { kind: string; report: CheckReport }[];
const report = (verdict: CheckReport["verdict"], o: Partial<CheckReport> = {}): CheckReport => ({ verdict, steps: [], smoke: null, text: "", ...o });

let cfg: ReturnType<typeof tempConfig>;
let asked: { check: PlanCheck | null | undefined; placed: string | null; staging: string }[] = [];
const realAdeps = { ...adeps };
beforeAll(() => { cfg = tempConfig(); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  asked = [];
  pdeps.log = () => {};
  pdeps.tools = () => tools7z;
  sbdeps.platform = () => "win32";
  sbdeps.exec = fake7z({ [ASSET]: zelda });
  releaseHost({ [URL_]: ZIP });
  prdeps.latestRelease = async () => RELEASE;
  Object.assign(adeps, realAdeps, { contentFromPackage: async () => null });
});
afterEach(() => restoreDeps());
const checksSay = (r: CheckReport, also?: (staging: string) => void) => {
  adeps.runChecks = async o => { asked.push({ check: o.check, placed: o.placed, staging: o.staging }); also?.(o.staging); return r; };
};

describe("the plan's checks", () => {
  test("they pass: the package is built, and the report is a {kind: 'check'} step of the job's trace", async () => {
    const f = fixture();
    checksSay(report("pass", { steps: [{ what: "its self-test", code: 0, ok: true, tail: "self-test: ok", seconds: 2 }], text: "its self-test passed" }));
    const j = await build(f.way.id);
    expect(j.state).toBe("done");
    expect(asked).toEqual([{ check: SELFTEST, placed: "mm.z64", staging: expect.stringMatching(/staging$/) }]);
    expect(traceOf(j).filter(s => s.kind === "check")).toEqual([{ kind: "check", report: expect.objectContaining({ verdict: "pass" }), t: expect.any(Number) } as any]);
    expect(pkgOf(f.game.id)).not.toBeNull();
  });

  test("one fails: the game keeps the package it had, the way is 'failed', and the job ends as the plan's check fault", async () => {
    const f = fixture();
    checksSay(report("pass"));
    expect((await build(f.way.id)).state).toBe("done");
    const before = pkgOf(f.game.id)!;
    checksSay(report("fail", { steps: [{ what: "its self-test", code: 1, ok: false, tail: "assert failed: texture cache", seconds: 3 }], text: "its self-test failed" }));
    const j = await build(f.way.id);
    expect(j).toMatchObject({ state: "failed", message: "check: its self-test failed (exit 1): assert failed: texture cache" });
    expect(JSON.parse(j.fail_json!)).toEqual({ class: "plan", phase: "check" });
    expect(pkgOf(f.game.id)!.id).toBe(before.id);
    expect(existsSync(join(before.path, "mm.z64"))).toBe(true);
    expect(getWay(f.way.id)).toMatchObject({ status: "failed", status_note: j.message });
    expect(traceOf(j).at(-1)!.report.verdict).toBe("fail");
    // a smoke start that fails says so the same way
    checksSay(report("fail", { smoke: { verdict: "fail", alive: false, exitCode: 3, titles: [], screenshot: null, outputTail: "", why: "it closed at once" } }));
    expect((await build(f.way.id)).message).toBe("check: starting it failed (exit 3): it closed at once");
  });

  test("a step the server could not run is never named as the one that failed (the AI's repair round would chase it)", async () => {
    const f = fixture();
    const notHere = { what: "the shader compiler reads the packed game", code: null, ok: false, tail: "not run here: the server's CPU lacks AVX2", seconds: 0 };
    checksSay(report("fail", { steps: [notHere, { what: "its self-test", code: 3, ok: false, tail: "assert failed: save folder", seconds: 2 }] }));
    const j = await build(f.way.id);
    expect(j).toMatchObject({ state: "failed", message: "check: its self-test failed (exit 3): assert failed: save folder" });
    expect(JSON.parse(j.fail_json!)).toEqual({ class: "plan", phase: "check" });
    // nor when what failed is the start, after a step that could not run here
    checksSay(report("fail", { steps: [notHere], smoke: { verdict: "fail", alive: false, exitCode: 3, titles: [], screenshot: null, outputTail: "", why: "it closed at once" } }));
    expect((await build(f.way.id)).message).toBe("check: starting it failed (exit 3): it closed at once");
  });

  test("the server cannot run one: the package is built, and the job's message says it was not started here", async () => {
    const f = fixture();
    checksSay(report("env", { smoke: { verdict: "env", alive: false, exitCode: null, titles: [], screenshot: null, outputTail: "", why: "the server has no graphics device" } }));
    const j = await build(f.way.id);
    expect(j.state).toBe("done");
    expect(j.message).toMatch(/^built: \d+ files, .* launch Zelda64Recompiled\.exe; not started here: the server has no graphics device$/);
    expect(j.transcript).toMatch(/not started here: the server has no graphics device/);
    expect(traceOf(j).at(-1)!.report.verdict).toBe("env");
  });

  test("a plan with no checks runs none, and says so in the trace", async () => {
    const f = fixture(() => ({ check: null }));
    checksSay(report("fail"));
    const j = await build(f.way.id);
    expect(j.state).toBe("done");
    expect(asked).toEqual([]);
    expect(traceOf(j).at(-1)).toMatchObject({ kind: "check", report: { verdict: "none", text: "the plan has no checks" } });
  });

  test("checks run on a copy: one that changes the package itself is refused", async () => {
    const f = fixture();
    checksSay(report("pass"), staging => writeFileSync(join(staging, "check.log"), "left behind"));
    const j = await build(f.way.id);
    expect(j).toMatchObject({ state: "failed", message: "check: the checks changed the package (check.log): they run on a copy of it" });
    expect(pkgOf(f.game.id)).toBeNull();
  });

  test("one that puts another file in a file's place, same size and same times, is refused too", async () => {
    const f = fixture();
    checksSay(report("pass"), staging => {
      const exe = join(staging, "Zelda64Recompiled.exe"), st = statSync(exe);
      const other = readFileSync(exe);
      other[0] ^= 0xff;
      rmSync(exe);
      writeFileSync(exe, other);
      utimesSync(exe, st.atime, st.mtime);
    });
    const j = await build(f.way.id);
    expect(j).toMatchObject({ state: "failed", message: "check: the checks changed the package (Zelda64Recompiled.exe): they run on a copy of it" });
    expect(pkgOf(f.game.id)).toBeNull();
  });
});

describe("a way's own check and setup (M4)", () => {
  test("its check runs in place of the plan's, and its setup steps after the plan's", async () => {
    const f = fixture(() => ({ setup: [{ ini: { path: "settings.ini", section: "Game", key: "Mode", value: "plan" } }] }));
    const own: PlanCheck = { steps: [{ run: { exe: "Zelda64Recompiled.exe", argv: ["--selftest", "--fast"], wine: true, timeoutSec: 30 }, what: "its quick self-test" }] };
    updateWay(f.way.id, { overrides: { check: own, setup: [{ ini: { path: "settings.ini", section: "Game", key: "Mode", value: "way" } }, { ini: { path: "settings.ini", section: "Game", key: "Extra", value: "1" } }] } });
    checksSay(report("pass"));
    expect((await build(f.way.id)).state).toBe("done");
    expect(asked.map(a => a.check)).toEqual([own]);
    const ini = readFileSync(join(pkgOf(f.game.id)!.path, "settings.ini"), "utf8");
    expect(ini).toBe("[Game]\r\nMode = way\r\nExtra = 1\r\n");                  // the plan's step, then the way's over it
  });

  test("a way without a check of its own takes the plan's", async () => {
    const f = fixture();
    updateWay(f.way.id, { overrides: { check: null } });
    checksSay(report("pass"));
    expect((await build(f.way.id)).state).toBe("done");
    expect(asked.map(a => a.check)).toEqual([SELFTEST]);
  });
});
