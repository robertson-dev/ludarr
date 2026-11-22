/**
 * The carry run's edges (src/ways/carry.ts), each one a way the run could loop, wait for nothing, spend what it was told
 * not to, or say what is not so: a build that refuses what a make or the copy gave is not handed the same file again; a
 * search that could not reach the indexers is no verdict on them; Resume after a stopped search searches again; AI repairs
 * switched off or out of tokens run no round; a game that came to play another way meanwhile is left alone; a plan is
 * readied by its check, or built from its source, before any AI round; a file refused under one content plan is judged
 * again under the next; only the run's own search is stopped with it; a 'run' event carries no path outside the library.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db, kv, stmts, type JobRow } from "../src/db";
import { events } from "../src/events";
import { carryApi } from "../src/ways/carry-api";
import { crdeps, intend, pokeRuns, serializeRun, startRun } from "../src/ways/carry";
import { getPlan, getWay, planSpec, updatePlan, updateWay } from "../src/ways/store";
import type { JobSpec, RunView, RuntimePlanSpec } from "../src/ways/types";
import { clockWords } from "../src/ways/asks";
import { GB, kytyCheck, kytyPlan, kytyUpgraded, kytyWay, MM_SHA1, nx2navi, nx2naviContent, PASS_CHECK, SEALED, world, zeldaPlan, type World } from "./carry-world";
import { step0For } from "../src/ways/construct";
import { copyFactsOf } from "./fakes-w3";

let w: World;
beforeEach(() => { w = world(); });
afterEach(() => { w.cleanup(); kv.del("cfg.CARRY_AI_ROUNDS"); kv.del("cfg.CARRY_AI_TOKENS_M"); });

const live = (runId: number, kind: string): JobRow => { const j = w.live(runId); expect(j?.kind).toBe(kind); return j!; };
const texts = (runId: number) => w.steps(runId).map(s => s.text);
const kinds = (runId: number, kind: string) => w.children(runId).filter(j => j.kind === kind);
const briefOf = (j: JobRow) => (w.spec(j) as Extract<JobSpec, { kind: "construct" }>).repair!;
const MM = "The Legend of Zelda: Majora's Mask";
function recomp(name: string, spec: RuntimePlanSpec = zeldaPlan(true), o: { status?: "ready" | "draft" | "broken" } = {}) {
  const p = w.plan(`Edge ${name}`, "recomp", spec, o);
  const g = w.game(MM, ["N64"], { year: 2000 });
  return { p, g, way: w.way(g, p) };
}
async function building(name: string) {
  const { p, g, way } = recomp(name);
  const file = w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
  const run = w.start({ wayId: way.id, by: "backfill" });
  await w.advance(run.id);
  return { p, g, way, file, run, asm: live(run.id, "assemble") };
}
const buildFault = (id: number) => w.end(id, { state: "failed", message: "build step 1 failed (exit 1)", fail: { class: "plan", phase: "build" } });
/** the Kyty way that makes its .zar only from what is kept (no copy, inbox or indexers), and a kept app0 dump it takes */
function kytyKept(name: string) {
  const p = w.plan(`KytyPS5 ${name}`, "emulator", kytyPlan());
  const g = w.game("Demon's Souls", ["PS5"]);
  const way = w.way(g, p, { ...kytyUpgraded(), make: { ...kytyUpgraded().make!, from: ["kept"] as "kept"[] } }, { check: kytyCheck });
  const dump = w.kept(g, "PPSA01341-app0", { source: "inbox", shape: "folder", platform: "ps5", size: 80 * GB });
  crdeps.inputMatches = (_i, row) => ({ ok: row.id === dump.id, why: row.id === dump.id ? null : "not the game folder" });
  return { p, g, way, dump };
}

describe("a file the build refused is not made or taken again for it", () => {
  test("a make's product the build refuses: the same make (cached, it would hand over the same file) is not run again; the run asks", async () => {
    const { g, way } = kytyKept("Edge Product");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const { assemble } = w.made(live(run.id, "make").id, { name: "PPSA01341-app0.zar" });
    await w.advance(run.id);
    expect(JSON.parse(w.run(run.id).step_json!)).toMatchObject({ job: assemble.id });
    w.end(assemble.id, { state: "failed", message: "the game file is not the version this needs", fail: { class: "file" } });
    const r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    const a = serializeRun(r).ask!;
    expect(a.code).toBe("file");
    expect(a.tried).toContain("Making the game data from PPSA01341-app0 failed: the build refused what it gave: the game file is not the version this needs. It is not tried again until the plan or the game data changes.");
    // the plan takes its data only from what is kept: the ask says the indexers are not searched, and why
    expect(a.tried).toContain("The indexers are not searched now: KytyPS5 Edge Product takes its game data only from files kept on the server.");
    expect(a.watching).toMatchObject({ nextSearchAt: null });
    for (let i = 0; i < 3; i++) { w.clock.t += 130_000; await w.advance(run.id); }
    expect([kinds(run.id, "make").length, kinds(run.id, "assemble").length]).toEqual([1, 1]);
    expect(g.id).toBeGreaterThan(0);
  });

  test("the copy taken in that the build refuses is not taken in again", async () => {
    const { g, way } = recomp("Copy Refused");
    w.romPackage(g, "mm.z64", { size: 32 * 2 ** 20, platform: "n64" });
    w.copy.serves.set(g.id, { serves: "direct", why: "the game file this way takes" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const take = live(run.id, "content");
    const kept = w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64", source: "package" });
    updateWay(way.id, { contentId: kept.id });
    w.end(take.id, { message: "the game's copy is the game file now (linked, hashed in place)" });
    await w.advance(run.id);
    w.end(live(run.id, "assemble").id, { state: "failed", message: "the game file is not the one this needs", fail: { class: "file" } });
    for (let i = 0; i < 3; i++) { w.clock.t += 130_000; await w.advance(run.id); }
    expect(kinds(run.id, "content").length).toBe(1);
    // the indexers have nothing either (and no AI to widen): the ask names the refused file and the copy, each with why
    w.ai.ready = false;
    w.setRequest(w.requests.made[0], { state: "requested", stage: "no usable copy yet — searching again in 6h", next_try_at: Math.floor(w.clock.t / 1000) + 6 * 3600 });
    const r = await w.advance(run.id);
    const a = serializeRun(r).ask!;
    expect(a.code).toBe("file");
    expect(a.tried).toContain("mm.z64, kept on the server, is refused by the build: the game file is not the one this needs.");
    expect(a.tried).toContain("Taking the copy on the server (mm.z64) failed: the build refused what it gave: the game file is not the one this needs. It is not tried again until the plan or the game data changes.");
  });

  test("a file refused under one content plan is taken again once the plan says something else", async () => {
    const { p, way, file, run, asm } = await building("Refused Then Changed");
    w.end(asm.id, { state: "failed", message: "the game file is not the version this needs", fail: { class: "file" } });
    let r = await w.advance(run.id);
    expect(r.phase).toBe("file");
    // a round (or the admin) changes what the plan says: the same file is judged again, and built
    updatePlan(p.id, { spec: { ...planSpec(p), content: { ...planSpec(p).content!, what: "Majora's Mask, NTSC-U 1.0 (either revision)" } } });
    pokeRuns({ runId: run.id });
    r = await w.advance(run.id);
    expect(getWay(way.id)!.content_id).toBe(file.id);
    const again = live(run.id, "assemble");
    expect(again.id).not.toBe(asm.id);
    w.built(again.id, PASS_CHECK);
    expect((await w.advance(run.id)).state).toBe("done");
  });
});

describe("the indexers", () => {
  test("a search that could not reach the indexers is no verdict on them: no widening round, the run waits saying so", async () => {
    const { way } = recomp("Search Error");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const req = w.requests.made[0];
    const soon = Math.floor(w.clock.t / 1000) + 600;
    w.setRequest(req, { state: "requested", stage: "the indexer search failed — trying again soon", message: "Prowlarr: connection refused", next_try_at: soon });
    const r = await w.advance(run.id);
    expect(kinds(run.id, "construct")).toEqual([]);
    expect(r.state).toBe("waiting");
    expect(texts(run.id).at(-1)).toBe(`the indexer search failed (Prowlarr: connection refused): looking again at ${clockWords(soon)}`);
    expect(getWay(way.id)).not.toBeNull();
  });

  test("a dump only its owner makes is asked for at once, and the indexers are not searched for it: the ask says why", async () => {
    const p = w.plan("KytyPS5 Edge Owner", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, { ...kytyUpgraded(), personalDump: "a PS5 dumper on your console" }, { check: kytyCheck });
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    // no search fetches copies the way would refuse one after another (Astral Chain's NSP and XCI, 2026-11-12)
    expect(w.requests.made).toEqual([]);
    w.clock.t += 130_000;
    r = await w.advance(run.id);
    expect(w.requests.made).toEqual([]);
    expect(serializeRun(r).ask!.tried).toContain("The indexers are not searched now: only its owner can make this game data (a PS5 dumper on your console), and they hold it in no form ludarr takes.");
    expect(kinds(run.id, "construct")).toEqual([]);
  });

  test("Resume after the admin stopped the way's search: a new search, not held again at once", async () => {
    const { way } = recomp("Resume Search");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    w.setRequest(w.requests.made[0], { state: "cancelled", stage: "cancelled" });
    let r = await w.advance(run.id);
    expect(r.state).toBe("held");
    intend(run.id, { kind: "retry" });
    r = await w.advance(run.id);
    expect(r.state).not.toBe("held");
    expect(w.requests.made.length).toBe(2);
    expect(getWay(way.id)).not.toBeNull();
  });

  test("a make repaired after a search's download failed on the recipe: the search starts over at once with the new recipe", async () => {
    const p = w.plan("KytyPS5 Edge Search Make", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, kytyUpgraded(), { check: kytyCheck });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const req = w.requests.made[0];
    // the search's content job: a RAR'd app0 folder whose make failed on the recipe
    const job = crdeps.enqueueJob({ kind: "content", gameId: g.id, wayId: way.id, requestId: req }, { gameId: g.id, requestId: req });
    w.end(job.id, { state: "failed", message: "make step 2 failed (exit 1): zarchive: bad argument", fail: { class: "plan", phase: "convert" } });
    w.setRequest(req, { state: "requested", stage: "the game file could not be checked — trying again in 30 min", job_id: job.id, next_try_at: Math.floor(w.clock.t / 1000) + 1800 });
    await w.advance(run.id);
    const round = live(run.id, "construct");
    expect(briefOf(round)).toMatchObject({ phase: "make", jobId: job.id });
    const next = { ...kytyUpgraded(), make: { ...kytyUpgraded().make!, steps: [kytyUpgraded().make!.steps[0], { convert: { with: "zarchive" as const, argv: ["{prep}/app0", "{out}"], timeoutSec: 9000 } }] } };
    w.round(round.id, { edit: () => updateWay(way.id, { content: next }), changed: ["content"] });
    await w.advance(run.id);
    expect(w.requests.retried).toEqual([req]);
  });
});

describe("the AI's budget", () => {
  test("the one free round never spends past the token budget", async () => {
    kv.set("cfg.CARRY_AI_TOKENS_M", "0.001");
    const { run, asm } = await building("No Tokens");
    db.query("UPDATE carry_runs SET tokens=5000, version=version+1 WHERE id=?").run(run.id);
    buildFault(asm.id);
    const r = await w.advance(run.id);
    expect(kinds(run.id, "construct")).toEqual([]);
    expect(serializeRun(r).ask).toMatchObject({ code: "budget" });
  });

  test("the free round the model could not answer is given back to the run, not to the budget", async () => {
    const { run, asm } = await building("Free Back");
    buildFault(asm.id);
    let r = await w.advance(run.id);
    const round = live(run.id, "construct");
    expect([r.rounds, JSON.parse(r.facts_json).freeRoundUsed]).toEqual([0, true]);
    w.end(round.id, { state: "failed", message: "the model call failed: 529 overloaded", fail: { class: "env", kind: "net" } });
    r = await w.advance(run.id);
    expect([r.state, r.rounds, JSON.parse(r.facts_json).freeRoundUsed]).toEqual(["waiting", 0, false]);
  });

  test("out of rounds after a plan fault: the ask promises no try on a new release (that is only for a build or a check)", async () => {
    kv.set("cfg.CARRY_AI_ROUNDS", "1");
    const { p, way } = recomp("Broken Plan", zeldaPlan(true), { status: "broken" });
    crdeps.checkPlanNow = async pl => { db.query("UPDATE runtime_plans SET status='broken', status_note=? WHERE id=?").run("the release pattern picks no file", pl.id); return getPlan(pl.id)!; };
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    w.round(live(run.id, "construct").id, { changed: [] });
    const r = await w.advance(run.id);
    expect(serializeRun(r).ask).toMatchObject({ code: "budget", need: `ludarr's AI tried 1 time to make ${p.name} work for ${MM}; the last try failed at make the plan pass: the release pattern picks no file. It stops so it does not spend more: raise 'AI repairs per game' in Settings → General → Import, or change the plan.` });
  });

  test("a question the AI asked is never answered with a game", async () => {
    const { p, g } = recomp("AI Choice");
    const run = startRun({ planId: p.id, by: "construct" });
    const ask = { code: "choice", title: "A GitHub token is needed", need: "x", tried: [], accept: null, inbox: null, inboxShare: null, canUpload: false, choices: [], heldContentId: null, watching: null, askedAt: 1, byAi: "the releases API answers 403 without a token" };
    db.query("UPDATE carry_runs SET state='asking', ask_json=?, version=version+1 WHERE id=?").run(JSON.stringify(ask), run.id);
    const res = await carryApi.request(`/api/v1/run/${run.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId: g.id }) });
    expect([res.status, (await res.json() as { error: string }).error]).toEqual([409, "the run is not asking which game it plays"]);
    intend(run.id, { kind: "answer", answer: { gameId: g.id } });
    const r = await w.advance(run.id, 1);
    expect(r.game_id).toBeNull();
    expect(texts(run.id).at(-1)).toBe("your answer came after the run had moved on: nothing changed");
  });
});

describe("an improvement round that asks", () => {
  test("a widen round that asks the admin a choice: the run goes on, and the file's ask carries the AI's exact line", async () => {
    const { way } = recomp("Widen Asks");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const req = w.requests.made[0];
    const later = Math.floor(w.clock.t / 1000) + 6 * 3600;
    w.setRequest(req, { state: "requested", stage: "no usable copy yet — searching again in 6h", next_try_at: later });
    await w.advance(run.id);
    const round = live(run.id, "construct");
    expect(briefOf(round).phase).toBe("widen");
    const exact = "the code takes any revision, but its README calls the others untested: accept them only if you want to";
    w.round(round.id, { ask: { need: "choice", title: "Accept the other revisions?", exact } });
    const r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    expect(serializeRun(r).ask).toMatchObject({ code: "file", byAi: exact });
    expect(texts(run.id)).toContain(`the AI (widen) asks: Accept the other revisions? — ${exact}`);
  });
});

describe("cancels", () => {
  test("a job ludarr itself cancelled (a search stopped, a game removed): the run looks at the world again at once, no error ask", async () => {
    const { run, asm } = await building("System Cancel");
    w.end(asm.id, { state: "cancelled", message: "cancelled", fail: { class: "cancelled", by: "system" } });
    const r = await w.advance(run.id);
    expect(r.state).not.toBe("held");
    // the world (the file is there) says build: built again at once, not in 30 minutes
    expect(live(run.id, "assemble").id).not.toBe(asm.id);
  });

  test("an old job cancelled with no word of who did it is held, never undone (it may be the admin's)", async () => {
    const { run, asm } = await building("Old Cancel");
    w.end(asm.id, { state: "cancelled", message: "cancelled", fail: null });
    const r = await w.advance(run.id);
    expect([r.state, w.live(run.id)]).toEqual(["held", null]);
  });

  test("a round the admin cancelled: held, and what it spent still counts", async () => {
    const { run, asm } = await building("Round Cancel");
    buildFault(asm.id);
    await w.advance(run.id);
    const round = live(run.id, "construct");
    w.ai.tokens.set(round.id, 77_000);
    w.end(round.id, { state: "cancelled", message: "cancelled by the admin", fail: { class: "cancelled", by: "admin" } });
    const r = await w.advance(run.id);
    expect([r.state, r.tokens]).toEqual(["held", 77_000]);
  });
});

describe("the plan", () => {
  test("a plan built per game that is not marked ready is checked (and so readied) before its way is searched for", async () => {
    const perGame: RuntimePlanSpec = {
      program: { kind: "source", ref: "master", steps: ["make BASEROM={content}"], artifact: "build/pc", content: "build" },
      launch: { exe: "sm64.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "Super Mario 64, US", search: ["Super Mario 64"], accept: { hashes: [{ algo: "sha1", value: "9bef1128717f958171a4afac3ed78ee2bb4e86ce" }] }, normalize: "n64-z64", place: "baserom.us.z64", ship: false },
      files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", check: { steps: [], smoke: { seconds: 10, needs: "gl" } },
    };
    const p = w.plan("Edge sm64ex", "port", perGame, { status: "draft" });
    const g = w.game("Super Mario 64", ["N64"]);
    const way = w.way(g, p);
    let checks = 0;
    const fake = crdeps.checkPlanNow;
    crdeps.checkPlanNow = async pl => { checks++; return fake(pl); };
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    // a way's search refuses a plan that is not ready: without the check it would be refused every day
    expect([checks, getPlan(p.id)!.status, w.requests.made.length]).toEqual([1, "ready", 1]);
  });

  test("a source plan whose build has not run is built from its source first — no AI round for it — then carried on", async () => {
    const spec: RuntimePlanSpec = { ...zeldaPlan(true), program: { kind: "source", ref: "v1.0", steps: ["make"], artifact: "dist", content: "none" } };
    const { p, way } = recomp("From Source", spec, { status: "draft" });
    crdeps.checkPlanNow = async pl => { db.query("UPDATE runtime_plans SET status='draft', status_note='builds from source: ready once its build has run' WHERE id=?").run(pl.id); return getPlan(pl.id)!; };
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    const b = live(run.id, "build");
    expect(w.spec(b)).toEqual({ kind: "build", planId: p.id, runId: run.id });
    expect([r.phase, kinds(run.id, "construct").length]).toEqual(["plan", 0]);
    // the build job pins and readies the plan (src/ways/build.ts settlePlan)
    db.query("UPDATE runtime_plans SET status='ready', status_note=NULL WHERE id=?").run(p.id);
    w.end(b.id, { message: "built edge-from-source.tar (12 MB) at v1.0" });
    r = await w.advance(run.id);
    expect(r.phase).toBe("file");
    expect(kinds(run.id, "build").length).toBe(1);
  });

  test("an address the plan names that is refused is the plan's to fix: a round, not a back-off", async () => {
    const { way } = recomp("Refused Address", zeldaPlan(true), { status: "draft" });
    crdeps.checkPlanNow = async () => { throw Object.assign(new Error("the plan's address is refused: 10.0.0.7 is a private address"), { status: 400 }); };
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    expect(briefOf(live(run.id, "construct"))).toMatchObject({ phase: "plan", failure: "the plan's address is refused: 10.0.0.7 is a private address" });
  });
});

describe("what else the game has", () => {
  test("a PC copy lands while the way is searched for: held with the question, the run's own search stopped and forgotten, nothing fetched; the copy removed, it carries on by itself", async () => {
    const { p, g, way } = recomp("PC Copy Meanwhile");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const req = w.requests.made[0];
    expect(JSON.parse(w.run(run.id).facts_json).requestOwn).toBe(req);
    const pc = stmts.insertPackage.get(g.id, null, "/pc", g.name, null, 1, JSON.stringify({ schema: 1, files: [], launch: { exe: "Game/mm.exe", args: "", cwd: "" } })) as { id: number };
    try {
      w.clock.t += 130_000;
      let r = await w.advance(run.id);
      expect([r.state, r.phase]).toEqual(["held", "file"]);
      expect(serializeRun(r).ask).toMatchObject({ code: "go-ahead", title: `Build ${MM} with ${p.name}?` });
      expect(serializeRun(r).ask!.need).toStartWith(`${MM} already plays through its PC copy (mm.exe). Should ludarr build ${p.name} for it instead?`);
      await Bun.sleep(5);
      expect([w.requests.cancelled, w.children(run.id)]).toEqual([[req], []]);
      expect(JSON.parse(r.facts_json)).toMatchObject({ replaceAsk: true, requestOwn: null, requestId: null });
      // the PC copy goes (the admin removed it): the next look carries the run on, with a search of its own again
      db.query("DELETE FROM packages WHERE id=?").run(pc.id);
      w.clock.t += 600_000;
      r = await w.advance(run.id);
      expect(texts(run.id)).toContain(`${MM} no longer plays another way: carrying it through`);
      expect([r.state, r.phase, w.requests.made.length]).toEqual(["waiting", "file", 2]);
      expect(serializeRun(r).ask).toBeNull();
    } finally { db.query("DELETE FROM packages WHERE id=?").run(pc.id); }
  });

  test("a game that already has a PC copy: no AI round is spent moving its build to the server until the admin says go; then that round runs first, and the build replaces the copy", async () => {
    const spec: RuntimePlanSpec = { ...zeldaPlan(true), firstRun: "On the first start NX2navi builds the game from your dump on your PC (10 to 25 minutes) and downloads its tools." };
    const { p, g, way } = recomp("Already Plays", spec);
    const pc = stmts.insertPackage.get(g.id, null, "/pc", g.name, null, 1, JSON.stringify({ schema: 1, files: [] })) as { id: number };
    try {
      const run = w.start({ wayId: way.id, by: "backfill" });
      let r = await w.advance(run.id);
      expect([r.state, kinds(run.id, "construct").length]).toEqual(["held", 0]);
      expect(serializeRun(r).ask!.code).toBe("go-ahead");
      intend(run.id, { kind: "answer", answer: { go: true } });
      r = await w.advance(run.id, 1);
      expect([r.state, r.phase]).toEqual(["active", "plan"]);
      expect(JSON.parse(r.facts_json)).toMatchObject({ replace: true, replaceAsk: false });
      expect(texts(run.id).at(-1)).toBe(`you said build ${p.name} for it: carrying it through, in place of what it plays now`);
      r = await w.advance(run.id);
      expect(briefOf(live(run.id, "construct")).phase).toBe("server-build");
      // the round moved it to the server: the file (its own kept dump here), then the assemble with replace
      w.round(live(run.id, "construct").id, { changed: ["program", "firstRun"], edit: () => updatePlan(p.id, { spec: { ...spec, firstRun: null } }) });
      w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
      r = await w.advance(run.id);
      expect(w.spec(live(run.id, "assemble"))).toEqual({ kind: "assemble", wayId: way.id, replace: true, runId: run.id });
    } finally { db.query("DELETE FROM packages WHERE id=?").run(pc.id); }
  });

  test("the admin's Make it playable over a PC copy: the make hands over the file, and the run builds it with replace", async () => {
    const { g, way, dump } = kytyKept("Edge Replace");
    const pc = stmts.insertPackage.get(g.id, null, "/pc", g.name, null, 1, JSON.stringify({ schema: 1, files: [] })) as { id: number };
    try {
      const run = w.start({ wayId: way.id, by: "admin", replace: true });
      await w.advance(run.id);
      const make = live(run.id, "make");
      // no then: a make's own assemble would not build over the PC copy
      expect(w.spec(make)).toEqual({ kind: "make", wayId: way.id, from: "kept", contentId: dump.id, auto: true, runId: run.id });
      const product = w.kept(g, "PPSA01341-app0.zar", { made: true, platform: "ps5", size: 22 * GB });
      db.query("UPDATE contents SET identity_json=? WHERE id=?").run(JSON.stringify({ platform: "ps5", serial: "PPSA01341", version: "01.007.000", shape: "zar" }), product.id);
      updateWay(way.id, { contentId: product.id });
      w.end(make.id, { message: "made PPSA01341-app0.zar (22.0 GB)" });
      await w.advance(run.id);
      expect(w.spec(live(run.id, "assemble"))).toEqual({ kind: "assemble", wayId: way.id, replace: true, runId: run.id });
    } finally { db.query("DELETE FROM packages WHERE id=?").run(pc.id); }
  });
});

describe("the brief, the inbox, the events", () => {
  test("the upgrade round's brief already has the copy's verdict: the copy is judged in place first", async () => {
    const p = w.plan("KytyPS5 Edge Brief", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, kytyWay());
    const pkg = w.romPackage(g, "bbb-ps5-01342.iso", { size: 54.2 * GB, platform: "ps5" });
    crdeps.judgeCopy = async gameId => {
      w.copy.judged.push(gameId);
      w.copy.facts.set(gameId, copyFactsOf({ packageId: pkg, rel: "bbb-ps5-01342.iso", path: "/library/x/bbb-ps5-01342.iso", shape: "file", size: 54.2 * GB, mtime: 1, sha256: null, identity: { platform: "ps5", serial: "PPSA01342", sealed: true }, markers: [], judgedAt: 1 }));
      w.copy.serves.set(gameId, { serves: "no", why: SEALED });
      return w.copy.facts.get(gameId)!;
    };
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const brief = briefOf(live(run.id, "construct"));
    expect(brief.phase).toBe("upgrade");
    expect(brief.copy).toMatchObject({ name: "bbb-ps5-01342.iso", serves: "no", why: SEALED });
    expect(w.copy.judged).toEqual([g.id]);
  });

  test("an inbox folder that cannot be used is not offered: the ask says why", async () => {
    const p = w.plan("KytyPS5 Edge Inbox", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, { ...kytyUpgraded(), personalDump: "a PS5 dumper on your console" }, { check: kytyCheck });
    const why = "the inbox folder belongs to user 4242: ludarr takes files only from a folder of root or of the users group";
    crdeps.ensureInbox = async () => ({ dir: "/library/.ahoy-inbox/demons-souls", why });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    await Bun.sleep(5);
    w.clock.t += 130_000;
    const r = await w.advance(run.id);
    const a = serializeRun(r).ask!;
    expect([a.code, a.inbox, a.watching?.inbox]).toEqual(["file", null, false]);
    expect(a.tried).toContain(`The inbox folder cannot be used: ${why}.`);
    expect(a.need).toContain("Pick it on the server:");
  });

  test("a 'run' event cuts a path outside the library to its last part; the run's own route shows it whole", async () => {
    const root = stmts.insertRootFolder.get("/library-carry-edge", null) as { id: number };
    const seen: RunView[] = [];
    const off = events.subscribe(e => { if (e.event === "run") seen.push(e.data as RunView); });
    try {
      const { run, asm } = await building("Event Paths");
      w.end(asm.id, { state: "failed", message: "check: the self-test failed (exit 1)", fail: { class: "plan", phase: "check" } });
      await w.advance(run.id);
      const exact = "the log says /downloads/complete/Majora/mm.z64 is missing, and the game is at /library-carry-edge/mm/mm.z64 (see https://github.com/Zelda64Recomp/Zelda64Recomp/issues/1)";
      w.round(live(run.id, "construct").id, { ask: { need: "other", title: "Where is the game?", exact } });
      await w.advance(run.id);
      const last = seen.filter(v => v.id === run.id).at(-1)!;
      expect(last.ask!.byAi).toBe("the log says …/mm.z64 is missing, and the game is at /library-carry-edge/mm/mm.z64 (see https://github.com/Zelda64Recomp/Zelda64Recomp/issues/1)");
      expect(serializeRun(w.run(run.id)).ask!.byAi).toBe(exact);
    } finally { off(); db.query("DELETE FROM root_folders WHERE id=?").run(root.id); }
  });

  test("an inbox entry that fails on a step with no held file to ask about: a round on the plan", async () => {
    const { way } = recomp("Intake Fault");
    w.inbox.next = ["/library/.ahoy-inbox/mm/mm.zip"];
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    w.end(live(run.id, "content").id, { state: "failed", message: "the archive could not be read", fail: { class: "plan", phase: "intake" } });
    await w.advance(run.id);
    expect(briefOf(live(run.id, "construct")).phase).toBe("plan");
  });
});

describe("what the admin tells the AI", () => {
  const send = (body?: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const tell = async (id: number, body?: unknown) => { const r = await carryApi.request(`/api/v1/run/${id}/tell`, send(body)); return { status: r.status, body: await r.json() as any }; };
  const view = async (id: number) => (await (await carryApi.request(`/api/v1/run/${id}`)).json() as { item: RunView }).item;

  test("their words start one round of their own, outside the run's rounds, and the run takes the reworked plan up from the plan again", async () => {
    const { p, way } = recomp("Told");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const before = await view(run.id);
    const text = "It takes any US dump, not only 1.0: the README says so under Installing.\nDrop the hash list.";
    const t = await tell(run.id, { text });
    expect(t.status).toBe(202);
    expect(t.body.item.steps.at(-1)).toMatchObject({ who: "admin", text: expect.stringMatching(/^you told the AI: It takes any US dump, not only 1\.0: the README says so under Installing\. Drop the hash list/) });
    await w.advance(run.id);
    const round = live(run.id, "construct");
    expect(briefOf(round)).toMatchObject({ phase: "told", told: text });
    const during = await view(run.id);
    expect(during.budget).toMatchObject({ rounds: before.budget.rounds + 1, tokens: before.budget.tokens + 2e6 });
    expect(texts(run.id).at(-1)).toMatch(/^the AI, round \d+ of \d+ \(told\): rework the plan as you said — It takes any US dump/);
    // the round reworks the plan: the run starts over from the plan with it, its search started again
    const searches = w.requests.retried.length;
    w.round(round.id, { edit: () => updatePlan(p.id, { spec: { ...planSpec(getPlan(p.id)!), notes: "any US dump, as the admin said" } }), changed: ["content", "notes"] });
    const r = await w.advance(run.id);
    expect(texts(run.id).join("\n")).toMatch(/the AI reworked the plan as you said: /);
    expect(["done", "stopped"]).not.toContain(r.state);
    expect(w.requests.retried.length).toBe(searches + 1);
    // no second round by itself: the upgrade the old plan would have been asked for is not asked of what the admin's round wrote
    expect(kinds(run.id, "construct").length).toBe(1);
  });

  test("a round that cannot do it asks, in the AI's words; AI repairs switched off do not keep the admin's own ask from running", async () => {
    kv.set("cfg.CARRY_AI_ROUNDS", "0");
    const { way } = recomp("Told Off");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    expect(kinds(run.id, "construct")).toEqual([]);                       // nothing by itself
    expect((await tell(run.id, { text: "Run its Setup with the NSP and the keys" })).status).toBe(202);
    await w.advance(run.id);
    const round = live(run.id, "construct");
    expect(briefOf(round).phase).toBe("told");
    expect(briefOf(round).tokensLeft).toBe(8e6 + 2e6);                    // the run's own budget, and what the ask brought
    const exact = "ludarr does not run a step that decrypts a console copy: run the project's Setup on your PC and upload the folder it installs";
    w.round(round.id, { ask: { need: "other", title: "One step is yours", exact } });
    const r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    expect(JSON.stringify(serializeRun(r).ask)).toContain(exact);
  });

  test("refused in words: nothing said, too long, no such run, an ended run, a run waiting for a go-ahead, no AI importer", async () => {
    const { way, p } = recomp("Told No");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    expect(await tell(run.id, {})).toEqual({ status: 400, body: { error: "say what the plan has wrong, and what to do instead ({ text })" } });
    expect(await tell(run.id, { text: "   " })).toMatchObject({ status: 400 });
    expect(await tell(run.id, { text: "x".repeat(2001) })).toEqual({ status: 400, body: { error: "up to 2000 characters" } });
    expect(await tell(999999, { text: "x" })).toEqual({ status: 404, body: { error: "no such run" } });
    w.ai.ready = false;
    expect(await tell(run.id, { text: "x" })).toEqual({ status: 409, body: { error: "the AI importer is not set up (Settings → Importers): there is no one to tell" } });
    w.ai.ready = true;
    const held = w.start({ planId: p.id, gameId: null, by: "backfill", held: true });
    expect(await tell(held.id, { text: "x" })).toEqual({ status: 409, body: { error: "the run waits for your go-ahead: answer that first" } });
    await carryApi.request(`/api/v1/run/${run.id}/stop`, send());
    expect(await tell(run.id, { text: "x" })).toEqual({ status: 409, body: { error: "the run has stopped: start it again (Make it playable), then say it" } });
    expect(kinds(run.id, "construct")).toEqual([]);
  });
});

describe("searches that would fetch nothing the way takes", () => {
  test("an emulator from ludarr's own list: a search that found nothing usable asks for the file, with no AI round to widen it", async () => {
    const spec = step0For("flyinghead/flycast", null, "dc")!.spec as unknown as RuntimePlanSpec;
    const p = w.plan("Flycast", "emulator", spec, { repo: "flyinghead/flycast" });
    const g = w.game("Marvel vs. Capcom: Clash of Super Heroes", ["Arcade", "DC"], { year: 1998 });
    const run = w.start({ wayId: w.way(g, p).id, by: "way" });
    await w.advance(run.id);
    const req = w.requests.made[0];
    w.setRequest(req, { state: "requested", stage: "no usable copy yet — searching again in 6h", next_try_at: Math.floor(w.clock.t / 1000) + 6 * 3600 });
    const r = await w.advance(run.id);
    expect(kinds(run.id, "construct")).toEqual([]);
    expect(r.state).toBe("asking");
    expect(serializeRun(r).ask).toMatchObject({ code: "file" });
  });

  test("game data only its owner can make: the indexers are never searched, and a search the run had started is stopped when the plan comes to say so", async () => {
    // from the start
    const p = w.plan("NX2navi Owner", "recomp", nx2navi());
    const g = w.game("The Legend of Zelda: Ocarina of Time", ["Switch 2"], { year: 2026 });
    const way = w.way(g, p, nx2naviContent());
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    for (let i = 0; i < 4 && w.live(run.id); i++) { const j = w.live(run.id)!; if (j.kind === "construct") w.round(j.id, {}); r = await w.advance(run.id); }
    expect(w.requests.made).toEqual([]);
    expect(r.state).toBe("asking");
    expect(JSON.stringify(serializeRun(r).ask)).toContain("only its owner can make this game data (Eglantine on your Switch 2), and they hold it in no form ludarr takes");
    // told while it asks: what it was asking for goes along, so the round knows what the words are about
    intend(run.id, { kind: "tell", text: "The .nup is in the game's own copy: take it from there" });
    await w.advance(run.id);
    expect(briefOf(live(run.id, "construct"))).toMatchObject({ phase: "told", failure: expect.stringMatching(/needs its game data: NX2navi Owner plays/) });
    // a way that searched, and whose plan then says only its owner can make the data
    const two = recomp("Owner Later");
    const run2 = w.start({ wayId: two.way.id, by: "backfill" });
    await w.advance(run2.id);
    const mine = w.requests.made.at(-1)!;
    expect(w.request(mine).state).not.toBe("cancelled");
    updateWay(two.way.id, { content: { ...zeldaPlan(true).content!, personalDump: "you, with your own console" } });
    await w.advance(run2.id);
    await Promise.resolve();
    expect(w.requests.cancelled).toContain(mine);
    expect(texts(run2.id)).toContain("the indexers are no longer searched: only its owner can make this game data (you, with your own console)");
  });
});
