/**
 * The carry run (src/ways/carry.ts), phase by phase, in a scripted world (tests/carry-world.ts): every outside call is a
 * fake through crdeps, and each job the run queues ends exactly as the test says. What a run must do with a child's end:
 * ok → on; a plan fault → a repair round; a refused file → back to the file; env → back off; an admin's cancel → held;
 * the run's own → nothing; a restart → the round again, once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db, kv, stmts, type JobRow } from "../src/db";
import { advanceRun, carryMemory, crdeps, ensureRuns, getRun, intend, pokeRuns, serializeRun, startRun, stopRun } from "../src/ways/carry";
import { getWay, planSpec, updatePlan, updateWay } from "../src/ways/store";
import type { JobSpec } from "../src/ways/types";
import { ENV_CHECK, GB, kytyCheck, kytyPlan, kytyUpgraded, MM_SHA1, PASS_CHECK, world, zeldaPlan, type World } from "./carry-world";

let w: World;
beforeEach(() => { w = world(); });
afterEach(() => { w.cleanup(); kv.del("cfg.CARRY_AI_ROUNDS"); kv.del("cfg.CARRY_AI_TOKENS_M"); });

/** a recomp with a check (so no upgrade round), its game, its way */
function recomp(name: string, o: { check?: boolean } = {}) {
  const p = w.plan(`Carry ${name}`, "recomp", zeldaPlan(o.check !== false));
  const g = w.game("The Legend of Zelda: Majora's Mask", ["N64"], { year: 2000 });
  const way = w.way(g, p);
  return { p, g, way };
}
const kidOf = (runId: number, kind: string): JobRow => { const j = w.live(runId); expect(j?.kind).toBe(kind); return j!; };
const texts = (runId: number) => w.steps(runId).map(s => s.text);

describe("a run carries a way through", () => {
  test("a way with a fitting file: the assemble, then done, the check read from its trace", async () => {
    const { g, way } = recomp("Fit");
    const file = w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    expect([r.phase, r.state]).toEqual(["build", "waiting"]);
    expect(getWay(way.id)!.content_id).toBe(file.id);
    const asm = kidOf(run.id, "assemble");
    expect(w.spec(asm)).toEqual({ kind: "assemble", wayId: way.id, auto: true, runId: run.id });
    expect(asm.run_id).toBe(run.id);
    w.built(asm.id, PASS_CHECK);
    r = await w.advance(run.id);
    expect([r.phase, r.state]).toEqual(["done", "done"]);
    const view = serializeRun(r, true);
    expect(view.rail.map(x => x.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(view.steps!.at(-1)!.text).toBe("built: The Legend of Zelda: Majora's Mask is ready for members to install; checked: the game's own self-test passed");
    expect(texts(run.id)).toContain("the game file: mm.z64 (its sha1 matched)");
  });

  test("the game's copy is the file: taken by a content job (a link), then built", async () => {
    const { g, way } = recomp("Copy Direct");
    const pkg = w.romPackage(g, "mm.z64", { size: 32 * 2 ** 20, platform: "n64" });
    w.copy.serves.set(g.id, { serves: "direct", why: "the game file this way takes" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    const take = kidOf(run.id, "content");
    expect(w.spec(take)).toEqual({ kind: "content", gameId: g.id, wayId: way.id, fromCopy: true, runId: run.id });
    expect(r.state).toBe("waiting");
    expect(serializeRun(r).now).toMatchObject({ jobId: take.id, text: "taking the game's copy (mm.z64, 34 MB) as the game file — waiting for its turn", progress: null });
    // the content job links it into the store and makes it the way's file
    const kept = w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64", source: "package" });
    updateWay(way.id, { contentId: kept.id });
    w.end(take.id, { message: "the game's copy is the game file now (linked, hashed in place)" });
    r = await w.advance(run.id);
    const asm = kidOf(run.id, "assemble");
    w.built(asm.id, PASS_CHECK);
    r = await w.advance(run.id);
    expect(r.state).toBe("done");
    expect(pkg).toBeGreaterThan(0);
  });

  test("the copy is what the file is made from: a make from the copy, its assemble followed, done with an env check", async () => {
    const p = w.plan("KytyPS5 Make", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, kytyUpgraded(), { check: kytyCheck });
    const pkg = w.romPackage(g, "PPSA01341-app0", { size: 80 * GB, platform: "ps5" });
    w.copy.serves.set(g.id, { serves: "make", why: "the game folder its file is packed from" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    const make = kidOf(run.id, "make");
    expect(w.spec(make)).toEqual({ kind: "make", wayId: way.id, from: "copy", packageId: pkg, then: "assemble", auto: true, runId: run.id });
    expect(r.state).toBe("waiting");
    const { assemble } = w.made(make.id, { name: "PPSA01341-app0.zar" });
    r = await w.advance(run.id);
    expect([r.phase, r.state]).toEqual(["build", "waiting"]);
    expect(JSON.parse(r.step_json!)).toMatchObject({ job: assemble.id, kind: "assemble" });
    w.built(assemble.id, ENV_CHECK);
    r = await w.advance(run.id);
    expect(r.state).toBe("done");
    const view = serializeRun(r);
    expect(view.rail.at(-1)).toEqual({ phase: "check", state: "env", summary: "not started here: the server has no graphics device" });
    expect(texts(run.id).at(-1)).toBe("built: Demon's Souls is ready for members to install; not started here: the server has no graphics device");
  });

  test("a game with a PC copy members play: held before anything is fetched, asking whether to build over it; not now stops it, nothing removed", async () => {
    const { g, way } = recomp("Native");
    const pkg = stmts.insertPackage.get(g.id, null, "/x", g.name, null, 1, JSON.stringify({ schema: 1, files: [] })) as { id: number };
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    expect([r.state, r.phase]).toEqual(["held", "game"]);
    const title = "Build The Legend of Zelda: Majora's Mask with Carry Native?";
    expect(serializeRun(r).ask).toMatchObject({
      code: "go-ahead", title,
      need: "The Legend of Zelda: Majora's Mask already plays through its PC copy. Should ludarr build Carry Native for it instead? Building it replaces the PC copy: its files are removed, and members install the Carry Native build in its place. Nothing changes until you say so.",
    });
    expect(serializeRun(r).rail.find(x => x.phase === "game")).toEqual({ phase: "game", state: "asked", summary: title });
    expect(w.children(run.id)).toEqual([]);
    // it looks every 10 minutes whether the game still plays that way: it does, so it stays held, and asks nothing new
    expect(r.next_at).toBe(Math.floor(w.clock.t / 1000) + 600);
    const asked = w.steps(run.id).length;
    w.clock.t += 600_000;
    r = await w.advance(run.id);
    expect([r.state, w.children(run.id), w.steps(run.id).length]).toEqual(["held", [], asked]);
    intend(run.id, { kind: "answer", answer: { go: false } });
    r = await w.advance(run.id, 1);
    expect(r.state).toBe("stopped");
    expect(texts(run.id).at(-1)).toBe("stopped: you said not now: nothing was removed, and the game plays as it did");
    expect(stmts.packageById.get(pkg.id)).not.toBeNull();
    db.query("DELETE FROM packages WHERE id=?").run(pkg.id);
  });

  test("a need the plan lacks is asked for; a system file landing carries it on", async () => {
    const spec = { ...zeldaPlan(true), needs: [{ kind: "bios" as const, name: "Carry BIOS", place: "bios.bin", accept: { formats: ["bin"], sizes: [524288] } }] };
    const p = w.plan("Carry Needs", "recomp", spec);
    const g = w.game("The Legend of Zelda: Majora's Mask", ["N64"]);
    const way = w.way(g, p);
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    const r = await w.advance(run.id);
    expect([r.phase, r.state]).toEqual(["build", "asking"]);
    expect(serializeRun(r).ask).toMatchObject({ code: "needs", title: "Carry Needs needs Carry BIOS", need: "Carry Needs needs Carry BIOS (a .bin file of 524 KB): add it once on the plan; every game it plays uses it." });
  });
});

describe("repair rounds", () => {
  async function failingBuild(name: string) {
    const { p, g, way } = recomp(name);
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    return { p, g, way, run, asm: kidOf(run.id, "assemble") };
  }

  test("a check fault: a repair round in 'check' with the failing job, the plan reworked, built again, done", async () => {
    const { p, run, asm } = await failingBuild("Check Fault");
    w.end(asm.id, { state: "failed", message: "check: the game's own self-test failed (exit 1): boom", fail: { class: "plan", phase: "check" } });
    let r = await w.advance(run.id);
    const round = kidOf(run.id, "construct");
    const spec = w.spec(round) as Extract<JobSpec, { kind: "construct" }>;
    expect(spec).toMatchObject({ kind: "construct", repo: p.repo, planId: p.id, runId: run.id, repair: { phase: "check", failure: "check: the game's own self-test failed (exit 1): boom", jobId: asm.id, round: 1, rounds: 3 } });
    // the first failure with the real game data is a round outside the budget
    expect(r.rounds).toBe(0);
    expect(texts(run.id).at(-1)).toContain("the AI, an extra round (the first failure with the real game data) (check)");
    w.round(round.id, { edit: () => updatePlan(p.id, { spec: { ...planSpec(p), check: { steps: [], smoke: { seconds: 10, needs: "vulkan" } } } }), changed: ["check"], tokens: 120_000 });
    r = await w.advance(run.id);
    expect(r.tokens).toBe(120_000);
    const again = kidOf(run.id, "assemble");
    expect(again.id).not.toBe(asm.id);
    w.built(again.id, ENV_CHECK);
    r = await w.advance(run.id);
    expect(r.state).toBe("done");
  });

  test("no AI: the admin is asked to set it up, and the run carries on by itself once it is there", async () => {
    w.ai.ready = false;
    const { run, asm } = await failingBuild("No AI");
    w.end(asm.id, { state: "failed", message: "setup step 2 failed (exit 2): no such file", fail: { class: "plan", phase: "setup" } });
    let r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    expect(serializeRun(r).ask).toMatchObject({ code: "ai", title: "The AI importer is not set up", need: "Working this out needs the AI importer, which is not set up: add its key under Settings → Importers. ludarr carries on by itself once it is there. (What stopped it: setup step 2 failed (exit 2): no such file.)" });
    expect(r.next_at).toBe(Math.floor(w.clock.t / 1000) + 600);
    // ten minutes later the AI is there: the round starts with no click
    w.ai.ready = true;
    w.clock.t += 600_000;
    r = await w.advance(run.id);
    expect(kidOf(run.id, "construct")).toBeTruthy();
    expect(r.state).toBe("waiting");
  });

  test("the budget, and the one free round after real game data landed: past it, the admin is asked", async () => {
    kv.set("cfg.CARRY_AI_ROUNDS", "1");
    const { run, asm } = await failingBuild("Budget");
    const failBuild = (id: number) => w.end(id, { state: "failed", message: "build step 1 failed (exit 1)", fail: { class: "plan", phase: "build" } });
    failBuild(asm.id);
    let r = await w.advance(run.id);
    let round = kidOf(run.id, "construct");
    expect(r.rounds).toBe(0);                                                // the free round
    w.round(round.id, { changed: [] });
    r = await w.advance(run.id);
    // nothing changed: the failed build is never run again as it was; the next round is a counted one
    round = kidOf(run.id, "construct");
    expect(r.rounds).toBe(1);
    expect(w.children(run.id).filter(j => j.kind === "assemble").length).toBe(1);
    w.round(round.id, { changed: [] });
    r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    expect(serializeRun(r).ask).toMatchObject({ code: "budget", need: "ludarr's AI tried 1 time to make Carry Budget work for The Legend of Zelda: Majora's Mask; the last try failed at fix the build: build step 1 failed (exit 1). It stops so it does not spend more: raise 'AI repairs per game' in Settings → General → Import, or change the plan. It tries once more by itself when the program has a new release." });
    expect(w.children(run.id).filter(j => j.kind === "assemble").length).toBe(1);
    // a new release of the program: one more round by itself (at most once in 30 days)
    crdeps.latestRelease = async () => ({ tag: "v9.9.9", name: null, date: null, prerelease: false, page: null, asset: null });
    w.clock.t += 86_400_000;
    r = await w.advance(run.id);
    expect(kidOf(run.id, "construct")).toBeTruthy();
    expect(serializeRun(r).budget).toMatchObject({ rounds: 2, roundsUsed: 2 });
  });

  test("rounds set to 0: AI repairs are switched off — no round at all, not the free one, not on a new release — said in those words", async () => {
    kv.set("cfg.CARRY_AI_ROUNDS", "0");
    const { run, asm } = await failingBuild("Rounds Off");
    // 0 lets ludarr carry games through only as far as it can without the AI (the setting's own words): the first fault asks
    w.end(asm.id, { state: "failed", message: "build step 1 failed (exit 1)", fail: { class: "plan", phase: "build" } });
    let r = await w.advance(run.id);
    expect(w.children(run.id).filter(j => j.kind === "construct")).toEqual([]);
    expect(serializeRun(r).ask).toMatchObject({ code: "budget", title: "AI repairs are switched off", need: "AI repairs are switched off (Settings → General → Import → AI repairs per game), and this needs one: build step 1 failed (exit 1)." });
    // a new release of the program does not bring one either
    crdeps.latestRelease = async () => ({ tag: "v9.9.9", name: null, date: null, prerelease: false, page: null, asset: null });
    w.clock.t += 86_400_000;
    r = await w.advance(run.id);
    expect([r.state, w.children(run.id).filter(j => j.kind === "construct").length]).toEqual(["asking", 0]);
  });

  test("a round a restart interrupted is started again once, with no round counted", async () => {
    const { run, asm } = await failingBuild("Restart");
    w.end(asm.id, { state: "failed", message: "check: no (exit 1)", fail: { class: "plan", phase: "check" } });
    let r = await w.advance(run.id);
    const first = kidOf(run.id, "construct");
    const rounds = r.rounds;
    w.end(first.id, { state: "failed", message: "interrupted by a restart — start it again", fail: { class: "restart" } });
    r = await w.advance(run.id);
    const second = kidOf(run.id, "construct");
    expect(second.id).not.toBe(first.id);
    expect(w.spec(second)).toEqual(w.spec(first));                          // the same round, the same brief
    expect([r.rounds, r.reissued]).toEqual([rounds, 1]);
    // interrupted again: not reissued a second time — tried later like any error
    w.end(second.id, { state: "failed", message: "interrupted by a restart — start it again", fail: { class: "restart" } });
    r = await w.advance(run.id);
    expect(w.live(run.id)).toBeNull();
    expect([r.state, r.reissued]).toEqual(["waiting", 1]);
  });

  test("a job from before fail_json is read by its words", async () => {
    const { run, asm } = await failingBuild("Old Words");
    w.end(asm.id, { state: "failed", message: "check: the self-test failed (exit 3)", fail: null });
    await w.advance(run.id);
    const round = kidOf(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("check");
  });
});

describe("a child's end, classified", () => {
  async function building(name: string) {
    const { g, way } = recomp(name);
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    return { g, way, run, asm: kidOf(run.id, "assemble") };
  }

  test("env backs off 30 min → 2 h → 8 h → 24 h, then asks, still trying every day", async () => {
    const { run } = await building("Env");
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const asm = kidOf(run.id, "assemble");
      w.end(asm.id, { state: "failed", message: "wine / xvfb-run are not available here", fail: { class: "env", kind: "tool" } });
      const r = await w.advance(run.id);
      expect(r.state).toBe("waiting");
      waits.push(r.next_at! - Math.floor(w.clock.t / 1000));
      expect(w.live(run.id)).toBeNull();
      // before the wait is over nothing runs
      await w.advance(run.id);
      expect(w.live(run.id)).toBeNull();
      w.clock.t = r.next_at! * 1000;
      await w.advance(run.id);
    }
    expect(waits).toEqual([1800, 7200, 28_800, 86_400]);
    w.end(kidOf(run.id, "assemble").id, { state: "failed", message: "wine / xvfb-run are not available here", fail: { class: "env", kind: "tool" } });
    const r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    const a = serializeRun(r).ask!;
    expect(a.code).toBe("env");
    expect(a.need).toMatch(/^Building The Legend of Zelda: Majora's Mask could not run on this server: wine \/ xvfb-run are not available here\. ludarr tries again by itself (tomorrow )?at \d\d:\d\d, and every day after that\.$/);
    // a day later it tries again by itself
    w.clock.t += 86_400_000;
    await w.advance(run.id);
    expect(kidOf(run.id, "assemble")).toBeTruthy();
  });

  test("no room, the library plainly short: the admin is asked at once with the space it needs, hourly", async () => {
    const { run } = await building("Room");
    for (let i = 0; i < 3; i++) {
      w.end(kidOf(run.id, "assemble").id, { state: "failed", message: "not enough room: 3 GB free", fail: { class: "env", kind: "room" } });
      const r = await w.advance(run.id);
      if (r.state === "asking") break;                   // plainly short: asked at the first failure
      if (i < 2) { w.clock.t = r.next_at! * 1000; await w.advance(run.id); }
    }
    const r = getRun(run.id)!;
    // the step that ran out of room in words (a build, not a make), and what it needs: the way's file (a few bytes here) and
    // what the library keeps free
    expect(serializeRun(r).ask).toMatchObject({ code: "room", need: "Building The Legend of Zelda: Majora's Mask needs about 50 GB free on the library: what it writes, and the 50 GB ludarr keeps free (Settings → General → Import → Keep free on the library); 10 GB are free. ludarr tries again every hour." });
    expect(r.next_at).toBe(Math.floor(w.clock.t / 1000) + 3600);
  });

  test("cancelled by the admin: held with Resume; Resume carries on", async () => {
    const { run, asm } = await building("Cancel Admin");
    w.end(asm.id, { state: "cancelled", message: "cancelled by the admin", fail: { class: "cancelled", by: "admin" } });
    let r = await w.advance(run.id);
    expect([r.state, r.next_at]).toEqual(["held", null]);
    expect(texts(run.id).at(-1)).toBe(`you cancelled job ${asm.id}: press Resume to carry on`);
    // nothing undoes the admin's cancel: the ticker leaves it be
    pokeRuns({ runId: run.id });
    r = await w.advance(run.id);
    expect([r.state, w.live(run.id)]).toEqual(["held", null]);
    intend(run.id, { kind: "retry" });
    r = await w.advance(run.id, 1);
    expect(r.state).toBe("active");
    await w.advance(run.id);
    expect(kidOf(run.id, "assemble").id).not.toBe(asm.id);
  });

  test("cancelled by the run itself: nothing more than looking again", async () => {
    const { run, asm } = await building("Cancel Run");
    w.end(asm.id, { state: "cancelled", message: "cancelled: the carry run stopped", fail: { class: "cancelled", by: "run" } });
    const r = await w.advance(run.id);
    expect(r.state).not.toBe("held");
    expect(kidOf(run.id, "assemble").id).not.toBe(asm.id);
  });

  test("a refused file: back to the file phase, that file never taken again by the run", async () => {
    const { run, asm, way } = await building("Refused");
    const file = getWay(way.id)!.content_id!;
    w.end(asm.id, { state: "failed", message: "the game file is not the version this needs", fail: { class: "file" } });
    const r = await w.advance(run.id);
    expect(r.phase).toBe("file");
    expect(JSON.parse(r.facts_json).refusedFiles).toEqual([file]);
    expect(w.children(run.id).filter(j => j.kind === "assemble").length).toBe(1);
  });

  test("a ludarr error: tried once more after 30 minutes, then the admin is asked with its words", async () => {
    const { run, asm } = await building("Other");
    w.end(asm.id, { state: "failed", message: "SQLITE_BUSY: database is locked", fail: { class: "other" } });
    let r = await w.advance(run.id);
    expect([r.state, r.next_at! - Math.floor(w.clock.t / 1000)]).toEqual(["waiting", 1800]);
    w.clock.t += 1800_000;
    r = await w.advance(run.id);
    const again = kidOf(run.id, "assemble");
    w.end(again.id, { state: "failed", message: "SQLITE_BUSY: database is locked", fail: { class: "other" } });
    r = await w.advance(run.id);
    expect(serializeRun(r).ask).toMatchObject({ code: "env" });
    expect(serializeRun(r).ask!.need).toStartWith("Building The Legend of Zelda: Majora's Mask could not run on this server: SQLITE_BUSY: database is locked.");
  });

  test("a build that needs the program built for this game first: that build, then the assemble", async () => {
    const { run, asm, way } = await building("Needs Build");
    w.end(asm.id, { state: "failed", message: "its program is built for this game first", fail: { class: "other", kind: "needs-build" } });
    await w.advance(run.id);
    const b = kidOf(run.id, "build");
    expect(w.spec(b)).toEqual({ kind: "build", planId: getWay(way.id)!.plan_id, wayId: way.id, then: "assemble", runId: run.id });
  });
});

describe("the failure ledger", () => {
  test("a failed make is never run again as it was; a new recipe runs; a refused input is not taken again and the run asks", async () => {
    const p = w.plan("KytyPS5 Ledger", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    // the plan takes its game data from what is kept, the game's copy and the inbox (not the indexers)
    const noIndexer = { ...kytyUpgraded(), make: { ...kytyUpgraded().make!, from: ["kept", "copy", "inbox"] as ("kept" | "copy" | "inbox")[] } };
    const way = w.way(g, p, noIndexer, { check: kytyCheck });
    w.romPackage(g, "PPSA01341-app0", { size: 80 * GB, platform: "ps5" });
    w.copy.serves.set(g.id, { serves: "make", why: "the game folder its file is packed from" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const make = kidOf(run.id, "make");
    w.end(make.id, { state: "failed", message: "make step 2 failed (exit 1): zarchive: cannot open", fail: { class: "plan", phase: "convert" } });
    let r = await w.advance(run.id);
    const round = kidOf(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("make");
    // the round changes the recipe: a new key, a new make
    const next = { ...noIndexer, make: { ...noIndexer.make, steps: [noIndexer.make.steps[0], { convert: { with: "zarchive" as const, argv: ["{prep}/app0", "{out}"], timeoutSec: 9000 } }] } };
    w.round(round.id, { edit: () => updateWay(way.id, { content: next }), changed: ["content"] });
    r = await w.advance(run.id);
    const make2 = kidOf(run.id, "make");
    expect(make2.id).not.toBe(make.id);
    // the input itself is refused (an update, not the whole game): not taken again, and nothing else is there: asked
    w.end(make2.id, { state: "failed", message: "an update or a part of the game, not the whole game", fail: { class: "file" } });
    r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    const a = serializeRun(r).ask!;
    expect(a.code).toBe("file");
    expect(a.tried).toContain("Making the game data from the copy on the server (PPSA01341-app0) failed: an update or a part of the game, not the whole game. It is not tried again until the plan or the game data changes.");
    // looking again later: still no make for that key
    const makes = () => w.children(run.id).filter(j => j.kind === "make").length;
    w.clock.t += 130_000;
    await w.advance(run.id);
    w.clock.t += 130_000;
    await w.advance(run.id);
    expect(makes()).toBe(2);
  });
});

describe("requests, restarts, races", () => {
  test("a member's search for the same way is followed, never a second one", async () => {
    const { g, way } = recomp("Member Search");
    const member = stmts.insertWayRequest.get(g.id, "auto", way.id) as { id: number };
    const run = w.start({ wayId: way.id, by: "backfill" });
    const r = await w.advance(run.id);
    expect(r.state).toBe("waiting");
    expect(JSON.parse(r.facts_json).requestId).toBe(member.id);
    expect(w.requests.made).toEqual([]);
    expect(serializeRun(r).now).toMatchObject({ requestId: member.id });
  });

  test("a run survives a restart mid-wait: nothing it needs is in memory", async () => {
    const { g, way } = recomp("Restart Wait");
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const asm = kidOf(run.id, "assemble");
    carryMemory.reset();                                                    // the process started again
    w.built(asm.id, PASS_CHECK);
    const r = await w.advance(run.id);
    expect(r.state).toBe("done");
  });

  test("a job queued but not written down (a crash between the two writes) is followed, never queued twice", async () => {
    const { g, way } = recomp("Crash Between");
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    // the claim written, the job queued, then the process died
    const row = getRun(run.id)!;
    db.query("UPDATE carry_runs SET phase='build', step_json=?, version=version+1 WHERE id=?").run(JSON.stringify({ claim: "assemble", at: Math.floor(w.clock.t / 1000) }), run.id);
    const lost = crdeps.enqueueJob({ kind: "assemble", wayId: way.id, auto: true, runId: run.id }, { gameId: g.id, runId: run.id });
    expect(row.id).toBe(run.id);
    const r = await w.advance(run.id);
    expect(JSON.parse(r.step_json!)).toMatchObject({ job: lost.id });
    expect(w.children(run.id).length).toBe(1);
  });

  test("compare-and-set: two advances racing queue one job; an intent written meanwhile is never lost", async () => {
    const { g, way } = recomp("Race");
    w.romPackage(g, "mm.z64", { size: 32 * 2 ** 20, platform: "n64" });
    let open!: () => void;
    const gate = new Promise<void>(res => { open = res; });
    let judged = 0;
    crdeps.judgeCopy = async () => { judged++; await gate; w.copy.serves.set(g.id, { serves: "direct", why: "the game file" }); return null; };
    const run = w.start({ wayId: way.id, by: "backfill" });
    const a = advanceRun(run.id);
    await Bun.sleep(5);
    carryMemory.reset();                                                    // the second advance does not wait for the first
    const b = advanceRun(run.id);
    await Bun.sleep(5);
    expect(judged).toBe(2);
    open();
    await Promise.all([a, b]);
    expect(w.children(run.id).filter(j => j.kind === "content").length).toBe(1);
    // an intent written while an advance holds an old row: the advance's write loses, the intent stands
    let release!: () => void;
    const slow = new Promise<void>(res => { release = res; });
    const run2 = recomp("Race Two");
    w.romPackage(run2.g, "mm.z64", { size: 1, platform: "n64" });
    crdeps.judgeCopy = async () => { await slow; w.copy.serves.set(run2.g.id, { serves: "direct", why: "the game file" }); return null; };
    const r2 = w.start({ wayId: run2.way.id, by: "backfill" });
    const c = advanceRun(r2.id);
    await Bun.sleep(5);
    intend(r2.id, { kind: "stop", why: "you stopped it" });
    release();
    await c;
    await w.advance(r2.id);
    expect(getRun(r2.id)!.state).toBe("stopped");
    expect(w.children(r2.id).filter(j => j.state === "queued").length).toBe(0);
  });

  test("stopRun cancels what the run started, and its way's search", async () => {
    const p = w.plan("KytyPS5 Stop", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, kytyUpgraded(), { check: kytyCheck });
    w.romPackage(g, "PPSA01341-app0", { size: 80 * GB, platform: "ps5" });
    w.copy.serves.set(g.id, { serves: "make", why: "the game folder" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const make = kidOf(run.id, "make");
    const extra = crdeps.enqueueJob({ kind: "assemble", wayId: way.id, auto: true, runId: run.id }, { gameId: g.id, runId: run.id });
    // the search the run made itself
    const req = stmts.insertWayRequest.get(g.id, "find-files", way.id) as { id: number };
    db.query("UPDATE carry_runs SET facts_json=json_set(facts_json, '$.requestId', ?, '$.requestOwn', ?) WHERE id=?").run(req.id, req.id, run.id);
    stopRun(run.id, "you stopped it");
    expect(getRun(run.id)!.state).toBe("stopped");
    for (const id of [make.id, extra.id]) expect(w.job(id)).toMatchObject({ state: "cancelled", message: "cancelled: the carry run stopped (you stopped it)" });
    await Bun.sleep(5);
    expect(w.requests.cancelled).toEqual([req.id]);
  });

  test("stopRun leaves a search it only followed alone (a member's, or the admin's own Find it on my indexers)", async () => {
    const { g, way } = recomp("Stop Member Search");
    const member = stmts.insertWayRequest.get(g.id, "auto", way.id) as { id: number };
    const run = w.start({ wayId: way.id, by: "backfill" });
    const r = await w.advance(run.id);
    expect(JSON.parse(r.facts_json)).toMatchObject({ requestId: member.id });
    expect(JSON.parse(r.facts_json).requestOwn ?? null).toBeNull();
    stopRun(run.id, "you stopped it");
    await Bun.sleep(5);
    expect(w.requests.cancelled).toEqual([]);
  });
});

describe("the backfill", () => {
  test("twice: one run per (plan, game); a way built is left alone; an ended run is not started again", async () => {
    const { g, way } = recomp("Backfill");
    const other = recomp("Backfill Built");
    const pkg = stmts.insertPackage.get(other.g.id, null, "/y", "x", null, 1, JSON.stringify({ schema: 1, kind: "recomp", files: [] })) as { id: number };
    db.query("UPDATE ways SET status='built', package_id=? WHERE id=?").run(pkg.id, other.way.id);
    await ensureRuns();
    await ensureRuns();
    const runs = db.query("SELECT * FROM carry_runs WHERE way_id IN (?, ?)").all(way.id, other.way.id) as { way_id: number; started_by: string }[];
    expect(runs.map(r => [r.way_id, r.started_by])).toEqual([[way.id, "backfill"]]);
    const run = startRun({ wayId: way.id, by: "backfill" });
    stopRun(run.id, "test");
    await ensureRuns();
    expect((db.query("SELECT COUNT(*) AS n FROM carry_runs WHERE way_id=?").get(way.id) as { n: number }).n).toBe(1);
    db.query("DELETE FROM packages WHERE id=?").run(pkg.id);
    expect(g.id).toBeGreaterThan(0);
  });
});

describe("what the run finds when it starts", () => {
  test("an assemble that failed before the run started is no news to it (the live job 59: '.iso, and this needs .zar')", async () => {
    const { g, way } = recomp("Old Failure");
    const old = crdeps.enqueueJob({ kind: "assemble", wayId: way.id }, { gameId: g.id });
    stmts.setJobFailed.run("failed", "the game's console copy bbb-ps5-01342.iso is a .iso file, and this needs .zar", old.id);
    const file = w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    const r = await w.advance(run.id);
    expect([r.phase, r.state]).toEqual(["build", "waiting"]);
    expect(JSON.parse(r.facts_json).refusedFiles ?? []).toEqual([]);
    expect(w.live(run.id)).toMatchObject({ kind: "assemble" });
    expect(getWay(way.id)!.content_id).toBe(file.id);
  });

  test("a make the admin's Build press queued is followed, never a second one", async () => {
    const p = w.plan("KytyPS5 Pressed", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, kytyUpgraded(), { check: kytyCheck });
    const pkg = w.romPackage(g, "PPSA01341-app0", { size: 80 * GB, platform: "ps5" });
    w.copy.serves.set(g.id, { serves: "make", why: "the game folder" });
    const pressed = crdeps.enqueueJob({ kind: "make", wayId: way.id, from: "copy", packageId: pkg, then: "assemble" }, { gameId: g.id });
    const run = w.start({ wayId: way.id, by: "backfill" });
    const r = await w.advance(run.id);
    expect(JSON.parse(r.step_json!)).toMatchObject({ job: pressed.id, kind: "make", adopted: true });
    expect(w.children(run.id)).toEqual([]);
    expect((db.query("SELECT COUNT(*) AS n FROM jobs WHERE kind='make' AND json_extract(spec_json, '$.wayId')=?").get(way.id) as { n: number }).n).toBe(1);
  });

  test("the admin's Make it playable, or a way added, lifts a hold", async () => {
    const p = w.plan("Carry Held Lift", "recomp", zeldaPlan(true));
    const held = startRun({ planId: p.id, by: "backfill", held: true });
    expect(held.state).toBe("held");
    const again = startRun({ planId: p.id, by: "backfill" });
    expect([again.id, again.state]).toEqual([held.id, "held"]);              // the backfill does not lift it
    const lifted = startRun({ planId: p.id, by: "admin" });
    expect([lifted.id, lifted.state, lifted.ask_json]).toEqual([held.id, "active", null]);
    expect(texts(held.id).at(-1)).toBe("you asked to make it playable: carrying it through");
  });
});

describe("a round that asks", () => {
  test("the failure it was about waits for the admin with the AI's line; Look again lets it run again", async () => {
    const p = w.plan("KytyPS5 Asks", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, { ...kytyUpgraded(), make: { ...kytyUpgraded().make!, from: ["kept", "copy", "inbox"] } }, { check: kytyCheck });
    w.romPackage(g, "PPSA01341-app0", { size: 80 * GB, platform: "ps5" });
    w.copy.serves.set(g.id, { serves: "make", why: "the game folder" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    w.end(kidOf(run.id, "make").id, { state: "failed", message: "make step 1 failed (exit 2): two folders hold sce_sys/param.json", fail: { class: "plan", phase: "make" } });
    await w.advance(run.id);
    const round = kidOf(run.id, "construct");
    w.round(round.id, { ask: { need: "file", title: "One app0 folder is needed", exact: "the copy holds the game and its update side by side: put the game's own app0 folder in the inbox" } });
    let r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    let a = serializeRun(r).ask!;
    expect([a.code, a.byAi]).toEqual(["file", "the copy holds the game and its update side by side: put the game's own app0 folder in the inbox"]);
    expect(a.tried).toContain("Making the game data from the copy on the server (PPSA01341-app0) failed: the copy holds the game and its update side by side: put the game's own app0 folder in the inbox. It is not tried again until the plan or the game data changes.");
    // two minutes later: still asking, no round, no make, the AI's line still there
    w.clock.t += 130_000;
    r = await w.advance(run.id);
    a = serializeRun(r).ask!;
    expect([r.state, a.byAi, w.live(run.id)]).toEqual(["asking", "the copy holds the game and its update side by side: put the game's own app0 folder in the inbox", null]);
    expect(w.children(run.id).filter(j => j.kind === "construct").length).toBe(1);
    // the admin looks again: the make runs again
    intend(run.id, { kind: "retry" });
    r = await w.advance(run.id);
    expect(kidOf(run.id, "make")).toBeTruthy();
  });
});
