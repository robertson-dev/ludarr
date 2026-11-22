/**
 * The parts of the carry-through contract that are real code from the start: why a job ended (src/ways/errors.ts), what
 * a job holds while it runs and which run started it (src/process/kinds.ts), the columns jobs, the blocklist and the
 * content store gained, the settings the new parts read, one recorded step's program in the sandbox
 * (src/ways/sandbox.ts runSandboxedStep), and the carry_runs table.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeBuilds, db, serializeJob, stmts, upsertGame, type BlockRow, type JobRow } from "../src/db";
import { writeConfig } from "../src/config";
import { enqueueJob, jobKinds, lockKeyOf } from "../src/process/kinds";
import { statusOf } from "../src/library/games";
import { pdeps } from "../src/process/deps";
import { cancelJob, intakeCap, longCap } from "../src/process/runner";
import { sharePath } from "../src/ways/asks";
import { aiRounds, aiTokens } from "../src/ways/carry";
import { ContentError, keepFreeBytes } from "../src/ways/content";
import { CONVERTER_IDS } from "../src/ways/converters";
import { EnvError, NeedsFiles, PlanFault, failOf } from "../src/ways/errors";
import { NotTheGameFile } from "../src/ways/find";
import "../src/ways/make";
import { runSandboxedStep, sbdeps, type SandboxedStepOpts } from "../src/ways/sandbox";
import { contentMade, insertContent, insertPlan, making, serializeContent, wstmts, type ContentRow } from "../src/ways/store";
import type { ConstructManifest, MadeInfo } from "../src/ways/types";
import { dirLink, ok, restoreDeps, tmp, tools7z } from "./ways-fixtures";

const jobsMade: number[] = [];
afterEach(() => { for (const id of jobsMade.splice(0)) db.query("DELETE FROM jobs WHERE id=?").run(id); });
const job = (...a: Parameters<typeof enqueueJob>) => { const j = enqueueJob(...a); jobsMade.push(j.id); return j; };

describe("why a job ended (failOf)", () => {
  test("the typed errors say what they are; a child program's words never make a failure the server's", () => {
    expect(failOf(new EnvError("room", "not enough room: 3 GB free"))).toEqual({ class: "env", kind: "room" });
    expect(failOf(new PlanFault("make", "make step 2 failed (exit 1)"))).toEqual({ class: "plan", phase: "make" });
    expect(failOf(new PlanFault(undefined, "the plan does not build"))).toEqual({ class: "plan" });
    expect(failOf(new NeedsFiles("no game file yet"))).toEqual({ class: "file" });
    expect(failOf(new NotTheGameFile("another game (its serial is PPSA01342)"))).toEqual({ class: "file" });
    expect(failOf(new ContentError("the file is empty", 400))).toEqual({ class: "file" });
    expect(failOf(new ContentError("not enough room: 3 GB free where the game files are kept", 507))).toEqual({ class: "env", kind: "room" });
    expect(failOf(new ContentError("cancelled", 409))).toEqual({ class: "cancelled" });
    expect(failOf(Object.assign(new Error("interrupted"), { fail: { class: "restart" } }))).toEqual({ class: "restart" });
    expect(failOf(Object.assign(new Error("x"), { fail: { class: "nonsense" } }))).toEqual({ class: "other" });
    expect(failOf(new DOMException("The operation was aborted.", "AbortError"))).toEqual({ class: "cancelled" });
    expect(failOf(new Error("cancelled"))).toEqual({ class: "cancelled" });
    expect(failOf(new Error("setup step 1 failed (exit 1): socket timed out"))).toEqual({ class: "other" });
    expect(failOf("boom")).toEqual({ class: "other" });
    expect(failOf(null)).toEqual({ class: "other" });
  });
  test("they are errors with their own words", () => {
    const e = new EnvError("cpu", "not run here: the server's CPU lacks AVX2");
    expect(e).toBeInstanceOf(Error);
    expect([e.message, e.kind, e.name]).toEqual(["not run here: the server's CPU lacks AVX2", "cpu", "EnvError"]);
    expect(new PlanFault("check", "check: the self-test failed").phase).toBe("check");
    expect(new NeedsFiles("needs the BIOS")).toBeInstanceOf(Error);
  });
});

describe("what a job holds while it runs (lockKeyOf)", () => {
  const row = (kind: string | null, spec: unknown, input: string): Pick<JobRow, "kind" | "spec_json" | "input_path"> => ({ kind, spec_json: spec === undefined ? null : JSON.stringify(spec), input_path: input });
  test("every job that works on one way holds that way; a plan's own build holds the plan; the rest hold their input", () => {
    expect(lockKeyOf(row("assemble", { kind: "assemble", wayId: 3 }, "way:3"))).toBe("way:3");
    expect(lockKeyOf(row("make", { kind: "make", wayId: 3, from: "copy" }, "make:way:3"))).toBe("way:3");
    expect(lockKeyOf(row("content", { kind: "content", gameId: 1, wayId: 3, fetchId: 9, path: "/downloads/x" }, "/downloads/x"))).toBe("way:3");
    expect(lockKeyOf(row("content", { kind: "content", gameId: 1, path: "/downloads/x" }, "/downloads/x"))).toBe("/downloads/x");
    expect(lockKeyOf(row("build", { kind: "build", planId: 7, wayId: 3 }, "plan:7"))).toBe("way:3");
    expect(lockKeyOf(row("build", { kind: "build", planId: 7 }, "plan:7"))).toBe("plan:7");
    expect(lockKeyOf(row("construct", { kind: "construct", repo: "a/b", gameId: 1 }, "repo:a/b"))).toBe("repo:a/b");
    expect(lockKeyOf(row("import", undefined, "/downloads/Game-GRP"))).toBe("/downloads/Game-GRP");
    expect(lockKeyOf({ kind: null, spec_json: "{not json", input_path: "/downloads/x" })).toBe("/downloads/x");
  });
});

describe("jobs a run starts, and why they ended", () => {
  test("a make job holds make:way:<id>; the run that started a job is kept, from the options or from its spec", () => {
    const a = job({ kind: "make", wayId: 99_101, from: "copy", packageId: 5 }, { runId: 77 });
    expect([a.input_path, a.kind, a.run_id]).toEqual(["make:way:99101", "make", 77]);
    expect(job({ kind: "assemble", wayId: 99_101, auto: true, runId: 78 }).run_id).toBe(78);
    expect(job({ kind: "assemble", wayId: 99_101 }).run_id).toBeNull();
    expect(serializeJob(a)).toMatchObject({ kind: "make", runId: 77, fail: null });
    stmts.setJobFail.run(JSON.stringify(failOf(new EnvError("room", "no room"))), a.id);
    expect(serializeJob(stmts.jobById.get(a.id) as JobRow).fail).toEqual({ class: "env", kind: "room" });
  });

  test("a make, or a program built for one game, is one of the game's build jobs; a plan's own build is not", () => {
    const g = upsertGame({ steam_appid: 990_771, name: "Contract Prep Game", slug: "contract-prep-game" });
    const mk = job({ kind: "make", wayId: 99_102, from: "kept", contentId: 1 }, { gameId: g.id });
    expect(activeBuilds().get(g.id)?.id).toBe(mk.id);
    job({ kind: "build", planId: 99_103 }, { gameId: g.id });
    expect(activeBuilds().get(g.id)?.id).toBe(mk.id);
    const per = job({ kind: "build", planId: 99_103, wayId: 99_102 }, { gameId: g.id });
    expect(activeBuilds().get(g.id)?.id).toBe(per.id);
    for (const id of [mk.id, per.id]) stmts.setJobFailed.run("failed", "x", id);
    expect(activeBuilds().has(g.id)).toBe(false);
    db.query("DELETE FROM games WHERE id=?").run(g.id);
  });

  test("a newer make or per-game build never hides the assemble members see as preparing", () => {
    const g = upsertGame({ steam_appid: 990_775, name: "Contract Status Game", slug: "contract-status-game" });
    const asm = job({ kind: "assemble", wayId: 99_106 }, { gameId: g.id });
    job({ kind: "build", planId: 99_107, wayId: 99_108 }, { gameId: g.id });
    job({ kind: "make", wayId: 99_108, from: "kept", contentId: 1 }, { gameId: g.id });
    expect(activeBuilds().get(g.id)?.id).toBe(asm.id);
    expect(statusOf(g, null, null, activeBuilds().get(g.id))).toEqual({ status: "importing", detail: "preparing" });
    db.query("DELETE FROM games WHERE id=?").run(g.id);
  });

  test("a job is cancelled by someone (the admin, a run, ludarr); a construct job's manifest has one shape", () => {
    const j = job({ kind: "assemble", wayId: 99_109 });
    expect(cancelJob(j.id, "the run was stopped", "run")).toBe(true);
    expect(stmts.jobById.get(j.id)).toMatchObject({ state: "cancelled", message: "the run was stopped" });
    expect(cancelJob(j.id, "again", "admin")).toBe(false);
    const repaired: ConstructManifest = { planId: 3, wayId: 1, runId: 7, changed: ["content"], diff: [{ field: "content", before: { accept: { serials: ["PPSA01341"] } }, after: { accept: { serials: ["PPSA01340", "PPSA01341"] } } }], tokens: 51_000 };
    const asked: ConstructManifest = { planId: 2, runId: 8, ask: { need: "file", title: "The .nup", exact: "one .nup of the game with its 1.1.1 update" } };
    expect([repaired.changed, asked.ask?.need]).toEqual([["content"], "file"]);
  });

  test("making() follows a way's make while it is queued or running; the make kind is there", async () => {
    const j = job({ kind: "make", wayId: 99_104, from: "inbox", path: "/library/.ahoy-inbox/x/app0" });
    expect(making(99_104)?.id).toBe(j.id);
    stmts.setJobFailed.run("failed", "x", j.id);
    expect(making(99_104)).toBeNull();
    expect(jobKinds.has("make")).toBe(true);
    expect(jobKinds.get("make")!.resumable).toBe(true);
    await expect(jobKinds.get("make")!.run({ job: { transcript: "" }, spec: { kind: "make", wayId: 99_104, from: "kept", contentId: 1 }, log: () => {}, progress: () => {} } as never)).rejects.toThrow("the way to play is gone");
    expect(CONVERTER_IDS).toEqual(["zarchive"]);
  });
});

describe("the blocklist and the content store", () => {
  test("a release refused for a way keeps the content plan it was refused under, and whether it was another game", () => {
    const g = upsertGame({ steam_appid: 990_772, name: "Contract Block Game", slug: "contract-block-game" });
    const b = stmts.insertWayBlock.get(g.id, "guid-x", "Contract Block (Full ISO)", "T", "a PS5 disc image holds the game encrypted", 99_105, "d".repeat(64), "form") as BlockRow;
    expect([b.way_id, b.plan_digest, b.class]).toEqual([99_105, "d".repeat(64), "form"]);
    const old = stmts.insertWayBlock.get(g.id, "guid-y", "Contract Block (USA)", "T", "not the game file", 99_105, null, null) as BlockRow;
    expect([old.plan_digest, old.class]).toEqual([null, null]);
    db.query("DELETE FROM games WHERE id=?").run(g.id);
  });

  test("a game folder and a made file are kept with their shape and how they were made, found by sha256 and by make key", () => {
    const g = upsertGame({ steam_appid: 990_773, name: "Contract Store Game", slug: "contract-store-game" });
    const made: MadeInfo = { from: { kind: "copy", packageId: 13, digest: "e".repeat(64) }, recipe: '{"steps":[]}', tools: ["zarchive@d2c717730092c7bf8cbb033b12fd4001b7c4d932"], key: "c".repeat(64), at: 1_762_600_000 };
    const zar = insertContent({ gameId: g.id, platform: "ps5", name: "PPSA01341-app0.zar", path: "/x/PPSA01341-app0.zar", size: 10, hashes: { sha1: "1".repeat(40), sha256: "2".repeat(64) }, source: "made", made });
    const tree = insertContent({ gameId: g.id, platform: "ps5", name: "app0", path: "/x/app0", size: 20, hashes: { sha256: "3".repeat(64) }, rawHashes: { sha256: "4".repeat(64) }, source: "inbox", shape: "folder" });
    const iso = insertContent({ gameId: g.id, platform: "ps5", name: "bbb-ps5-01342.iso", path: "/x/bbb.iso", size: 30, hashes: { sha256: "5".repeat(64) }, source: "package" });
    expect([zar.shape, tree.shape, iso.shape]).toEqual(["file", "folder", "file"]);
    expect(contentMade(zar)).toEqual(made);
    expect(contentMade(iso)).toBeNull();
    expect(serializeContent(tree)).toMatchObject({ shape: "folder", made: null, source: "inbox" });
    expect(serializeContent(zar)).toMatchObject({ shape: "file", made: { key: "c".repeat(64) }, source: "made" });
    expect((wstmts.contentByMadeKey.get(g.id, "c".repeat(64)) as ContentRow).id).toBe(zar.id);
    expect(wstmts.contentByMadeKey.get(g.id, "f".repeat(64))).toBeNull();
    expect((wstmts.contentBySha256.get(g.id, "3".repeat(64)) as ContentRow).id).toBe(tree.id);
    expect((wstmts.contentBySha256.get(g.id, "4".repeat(64)) as ContentRow).id).toBe(tree.id);     // the bytes as they came in
    expect((wstmts.contentBySha256.get(g.id, "5".repeat(64)) as ContentRow).id).toBe(iso.id);
    expect(wstmts.contentBySha256.get(-1, "5".repeat(64))).toBeNull();                             // another game's file is not this game's copy
    for (const r of [zar, tree, iso]) wstmts.deleteContent.run(r.id);
    db.query("DELETE FROM games WHERE id=?").run(g.id);
  });

  test("the carry runs table: one open run per plan and game", () => {
    const p = insertPlan({ name: "Contract Run Plan", kind: "recomp", repo: "some/contract", platforms: ["n64"], spec: { program: { kind: "url", url: "https://example.com/x.zip", sha256: "a".repeat(64) }, launch: { exe: "x.exe", argv: [] }, content: null, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" } });
    const g = upsertGame({ steam_appid: 990_774, name: "Contract Run Game", slug: "contract-run-game" });
    const add = (state = "active") => db.query("INSERT INTO carry_runs (plan_id, game_id, state) VALUES (?, ?, ?) RETURNING *").get(p.id, g.id, state) as { id: number; version: number; phase: string; facts_json: string };
    const first = add();
    expect([first.version, first.phase, first.facts_json]).toEqual([0, "plan", "{}"]);
    expect(() => add()).toThrow();                                                     // a second open run of (plan, game)
    db.query("UPDATE carry_runs SET state='done' WHERE id=?").run(first.id);
    expect(add().id).toBeGreaterThan(first.id);                                        // a run that ended does not hold the place
    db.query("DELETE FROM games WHERE id=?").run(g.id);
    expect(db.query("SELECT COUNT(*) AS n FROM carry_runs WHERE plan_id=?").get(p.id)).toEqual({ n: 0 });   // they go with the game
    wstmts.deletePlan.run(p.id);
  });
});

describe("the settings the new parts read", () => {
  const KEYS = ["CARRY_AI_ROUNDS", "CARRY_AI_TOKENS_M", "INTAKE_PARALLEL", "LONG_PARALLEL", "LIBRARY_KEEP_FREE_GB", "LIBRARY_SHARE_PATH"];
  afterEach(() => { for (const k of KEYS) db.query("DELETE FROM kv WHERE key=?").run(`cfg.${k}`); });
  test("defaults, saved values, and the floor that keeps a lane open", () => {
    const read = () => [aiRounds(), aiTokens(), intakeCap(), longCap(), keepFreeBytes(), sharePath()];
    expect(read()).toEqual([3, 8e6, 1, 1, 50e9, null]);
    expect(writeConfig({ CARRY_AI_ROUNDS: "0", CARRY_AI_TOKENS_M: "2.5", INTAKE_PARALLEL: "3", LONG_PARALLEL: "0", LIBRARY_KEEP_FREE_GB: "10", LIBRARY_SHARE_PATH: "\\\\tower\\games\\ahoy" }).errors).toEqual([]);
    expect(read()).toEqual([0, 2.5e6, 3, 1, 10e9, "\\\\tower\\games\\ahoy"]);
    expect(writeConfig({ LONG_PARALLEL: "many" }).errors).toEqual(["Long game-data jobs at once must be a number"]);
  });
});

describe("one recorded step's program (runSandboxedStep)", () => {
  afterEach(() => restoreDeps());
  const signal = new AbortController().signal;
  const step = (o: Partial<SandboxedStepOpts> & Pick<SandboxedStepOpts, "cwd" | "work">): SandboxedStepOpts => ({
    exe: "/opt/pack", fill: {}, signal, log: () => {}, name: { log: "make 2", error: "make step 2" }, ...o,
  });
  const setup = () => {
    sbdeps.platform = () => "win32";                                                   // a dev box: no sandbox
    const work = tmp("sbx-step-"), cwd = join(work, "prep");
    mkdirSync(cwd, { recursive: true });
    return { work, cwd };
  };

  test("argv is filled once, and the step is named in its log line and in what it throws", async () => {
    const { work, cwd } = setup();
    const calls: { cmd: string[]; cwd?: string }[] = [];
    let answer = ok("packed");
    sbdeps.exec = async (cmd, opts) => { calls.push({ cmd, cwd: opts?.cwd }); return answer; };
    const lines: string[] = [];
    const o = step({ cwd, work, log: l => lines.push(l), fill: { in: () => "/work/in/{out}", out: () => "/work/out/x.zar" } });
    const r = await runSandboxedStep({ exe: "pack", argv: ["{in}", "{out}", "--keep={in}"], wine: false, timeoutSec: 5 }, o);
    expect(r.stdout).toBe("packed");
    expect(calls[0]).toEqual({ cmd: ["/opt/pack", "/work/in/{out}", "/work/out/x.zar", "--keep=/work/in/{out}"], cwd });   // a filled-in value is never filled again
    expect(lines[0]).toBe("make 2: pack /work/in/{out} /work/out/x.zar --keep=/work/in/{out}");
    answer = { code: 1, stdout: "", stderr: "reading\nzstd: error 11\nbad block", timedOut: false };
    await expect(runSandboxedStep({ exe: "pack", argv: [], wine: false, timeoutSec: 5 }, o)).rejects.toThrow("make step 2 failed (exit 1): reading | zstd: error 11 | bad block");
    answer = { code: -1, stdout: "", stderr: "", timedOut: true };
    await expect(runSandboxedStep({ exe: "pack", argv: [], wine: false, timeoutSec: 5 }, o)).rejects.toThrow("make step 2 ran out of time (5 s)");
  });

  test("a value that cannot be given refuses the step before anything runs", async () => {
    const { work, cwd } = setup();
    let ran = 0;
    sbdeps.exec = async () => { ran++; return ok(); };
    const o = step({ cwd, work, fill: { content: () => "{content}" }, unfilled: p => `make step 2 needs the game file ({${p}})` });
    await expect(runSandboxedStep({ exe: "pack", argv: ["{content}"], wine: false, timeoutSec: 5 }, o)).rejects.toThrow("make step 2 needs the game file ({content})");
    await expect(runSandboxedStep({ exe: "pack", argv: ["{content}"], wine: false, timeoutSec: 5 }, { ...o, unfilled: undefined })).rejects.toThrow("make step 2 needs {content}, and it cannot be given here");
    expect(ran).toBe(0);
    await runSandboxedStep({ exe: "pack", argv: ["--no-content"], wine: false, timeoutSec: 5 }, o);   // a placeholder argv does not use is never asked for
    expect(ran).toBe(1);
  });

  test("a link the step leaves in its folder is refused", async () => {
    const { work, cwd } = setup();
    const outside = tmp("sbx-outside-");
    writeFileSync(join(outside, "secret.txt"), "x");
    sbdeps.exec = async () => { dirLink(outside, join(cwd, "lnk")); return ok(); };
    await expect(runSandboxedStep({ exe: "pack", argv: [], wine: false, timeoutSec: 5 }, step({ cwd, work }))).rejects.toThrow("make step 2 holds a link (lnk), and a package carries files only");
  });

  test("a wine run starts in the folder it is given, with the sandbox's own prefix", async () => {
    const { work, cwd } = setup();
    pdeps.tools = () => ({ ...tools7z, wine: "/usr/bin/wine", xvfb: "xvfb-run" });
    const calls: { cmd: string[]; cwd?: string; env?: Record<string, string> }[] = [];
    sbdeps.exec = async (cmd, opts) => { calls.push({ cmd, cwd: opts?.cwd, env: opts?.env }); return ok(); };
    await runSandboxedStep({ exe: "tools/pack.exe", argv: ["{prep}"], wine: true, timeoutSec: 5 }, step({ exe: join(cwd, "tools", "pack.exe"), cwd, work, wine: { cwd: join(cwd, "tools") }, fill: { prep: () => "Z:\\prep" } }));
    const run = calls.find(c => c.cmd.includes("/usr/bin/wine"))!;
    expect(run.cmd.slice(-2)).toEqual([join(cwd, "tools", "pack.exe"), "Z:\\prep"]);
    expect(run.cwd).toBe(join(cwd, "tools"));
    expect(run.env?.WINEPREFIX).toBe(join(work, "wine"));
  });
});
