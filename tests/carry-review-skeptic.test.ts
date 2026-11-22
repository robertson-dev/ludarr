/**
 * The carry run after the wave-3 review's skeptic (src/ways/carry.ts): what the review's fixes still let through. An
 * upgrade round that gave up is tried again on the next content plan; a ludarr error asked about keeps the time it said;
 * a program build for the game that refuses its file goes back to the file instead of asking for a retry nothing makes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, type GameRow, type JobRow } from "../src/db";
import { advanceRun, crdeps, pokeRuns, roomFreed, serializeRun } from "../src/ways/carry";
import { getPlan, updateWay } from "../src/ways/store";
import type { ContentPlan, JobSpec, RuntimePlanSpec } from "../src/ways/types";
import { GB, kytyPlan, kytyWay, world, type World } from "./carry-world";

let w: World;
const fetches: number[] = [];
beforeEach(() => { w = world(); });
afterEach(() => {
  for (const id of fetches.splice(0)) db.query("DELETE FROM fetches WHERE id=?").run(id);
  w.cleanup();
});

const live = (runId: number, kind: string): JobRow => { const j = w.live(runId); expect(j?.kind).toBe(kind); return j!; };
const kinds = (runId: number, kind: string) => w.children(runId).filter(j => j.kind === kind);

/** an N64 emulator with a check (no upgrade round): nothing it checks proves a file, so one can only be kept for a look */
const n64Emu = (): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^N64Emu-.*[.]zip$", channel: "stable" },
  launch: { exe: "n64emu.exe", argv: ["{content}"] },
  content: { kind: "rom", platform: "n64", what: "a Nintendo 64 game", search: ["any"], accept: { hashes: [], formats: ["z64", "n64", "v64"] }, place: "roms/{name}" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
  check: { steps: [], smoke: { seconds: 20, needs: "vulkan" } },
});
const banjo = (): ContentPlan => ({ kind: "rom", platform: "n64", what: "Banjo-Kazooie (Nintendo 64)", search: ["Banjo-Kazooie"], accept: { hashes: [], formats: ["z64", "n64", "v64"] }, place: "roms/{name}" });
function n64Game(name: string) {
  const p = w.plan(`N64 Emu ${name}`, "emulator", n64Emu());
  const g = w.game("Banjo-Kazooie", ["N64"], { year: 1998 });
  return { p, g, way: w.way(g, p, banjo()) };
}

/** a download of the game that landed earlier (a fetch done), its file on disk */
function fetchOf(g: GameRow, title: string): { id: number; path: string } {
  const dir = join(w.dir, "downloads");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${title}.zip`);
  writeFileSync(path, "zip");
  const r = db.query("INSERT INTO fetches (game_id, title, protocol, client, state, local_path, size) VALUES (?,?,?,?,?,?,?) RETURNING id").get(g.id, title, "torrent", "rtorrent", "done", path, 16 * 2 ** 20) as { id: number };
  fetches.push(r.id);
  return { id: r.id, path };
}

describe("an upgrade round that gave up", () => {
  test("is tried again once the content plan changes: only a round that finished counts its gaps as seen", async () => {
    const p = w.plan("KytyPS5 Gave Up", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"], { year: 2020 });
    const way = w.way(g, p, kytyWay());
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const round = live(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("upgrade");
    // the model ran out of turns: nothing was looked at to the end, nothing changed
    w.round(round.id, { fail: { class: "other", kind: "ai-turns" }, failMessage: "the AI used all its turns before it finished" });
    await w.advance(run.id);
    expect(kinds(run.id, "construct").length).toBe(1);                   // let go for this content plan
    // the content plan changes (a search term): the gaps the round never got through (the .zar's make) get a round now
    updateWay(way.id, { content: { ...kytyWay(), terms: ["PPSA01341"] } });
    w.clock.t += 120_000;
    await w.advance(run.id);
    const rounds = kinds(run.id, "construct");
    expect(rounds.length).toBe(2);
    expect((w.spec(rounds[1]) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("upgrade");
  });
});

describe("a ludarr error asked about", () => {
  test("keeps the time it said it tries again at while other things wake the run, and tries again then", async () => {
    const { g, way } = n64Game("Said Once");
    w.kept(g, "banjo.z64", { platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const oops = (id: number) => w.end(id, { state: "failed", message: "the way's file store did not answer", fail: { class: "other" } });
    oops(live(run.id, "assemble").id);
    let r = await w.advance(run.id);
    w.clock.t = r.next_at! * 1000;                                         // thirty minutes later: once more
    r = await w.advance(run.id);
    oops(live(run.id, "assemble").id);
    r = await w.advance(run.id);
    const said = serializeRun(r).ask!;
    expect([r.state, said.code]).toEqual(["asking", "env"]);
    const at = r.next_at!, steps = w.steps(run.id).length;
    // three hours later something of the game's ends and wakes the run: what it asked, and when it tries again, stand
    w.clock.t += 3 * 3_600_000;
    pokeRuns({ gameId: g.id });
    r = await w.advance(run.id);
    expect(serializeRun(r).ask!.need).toBe(said.need);
    expect(r.next_at).toBe(at);
    expect(w.steps(run.id).length).toBe(steps);
    // at the time it said: tried again by itself
    w.clock.t = at * 1000;
    r = await w.advance(run.id);
    expect(kinds(run.id, "assemble").length).toBe(3);
  });
});

describe("a program build for the game that refuses its game file", () => {
  test("goes back to the file with that file refused: it never asks for a retry by the server that nothing would make", async () => {
    const { g, way } = n64Game("Build Refuses");
    const file = w.kept(g, "banjo.z64", { platform: "n64" });
    crdeps.wayBuildNeeded = () => true;                                    // the program is built for each game
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const build = live(run.id, "build");
    w.end(build.id, { state: "failed", message: "the game file is not in the content store", fail: { class: "file" } });
    const r = await w.advance(run.id);
    expect(serializeRun(r).ask?.code ?? null).not.toBe("env");
    expect(r.phase).toBe("file");
    expect(JSON.parse(r.facts_json).refusedFiles).toEqual([file.id]);
    expect(w.requests.made.length).toBe(1);                                // it looks for another game file
    // refused at the build's end: never said to be the game file again on the way back
    const steps = w.steps(run.id), at = steps.findIndex(s => s.text.startsWith("refused: the game file is not in the content store"));
    expect(at).toBeGreaterThan(-1);
    expect(steps.slice(at).some(s => s.text.startsWith("the game file: banjo.z64"))).toBe(false);
  });

  test("an edit of the way's check meanwhile (which the program's build does not read) neither builds that file again nor sends the run back and forth", async () => {
    const { g, way } = n64Game("Build Refuses Edited");
    const file = w.kept(g, "banjo.z64", { platform: "n64" });
    crdeps.wayBuildNeeded = () => true;
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    w.end(live(run.id, "build").id, { state: "failed", message: "the game file is not in the content store", fail: { class: "file" } });
    await w.advance(run.id);
    // the way's own check is edited (an AI round, the admin): the content plan's digest changes, the build's key does not
    updateWay(way.id, { overrides: { check: { steps: [], smoke: { seconds: 30, needs: "vulkan" } } } as never });
    const before = w.steps(run.id).length;
    w.clock.t += 120_000;
    const r = await w.advance(run.id);
    expect(kinds(run.id, "build").length).toBe(1);
    expect(w.steps(run.id).length - before).toBeLessThanOrEqual(3);
    expect(r.phase).toBe("file");
    expect(JSON.parse(r.facts_json).refusedFiles).toEqual([file.id]);
  });
});

describe("an earlier download that ludarr itself cannot take in", () => {
  test("never holds up the search: tried twice, then passed by with its words, and the indexers are searched meanwhile", async () => {
    const { g, way } = n64Game("Earlier Error");
    fetchOf(g, "Banjo-Kazooie.N64-GRP");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const oops = (id: number) => w.end(id, { state: "failed", message: "the download is outside the folders ludarr takes files from", fail: { class: "other" } });
    oops(live(run.id, "content").id);
    let r = await w.advance(run.id);
    expect(w.requests.made.length).toBe(1);                                // the indexers are searched while it waits to be tried again
    // half an hour later it is tried once more, and fails the same way
    w.clock.t += 31 * 60_000;
    r = await w.advance(run.id);
    oops(live(run.id, "content").id);
    r = await w.advance(run.id);
    expect(serializeRun(r).ask?.code ?? null).not.toBe("env");
    expect([r.phase, r.state]).toEqual(["file", "waiting"]);
    // the next day: not read a third time; the search the run made goes on
    w.clock.t += 25 * 3_600_000;
    r = await w.advance(run.id);
    expect(kinds(run.id, "content").length).toBe(2);
    expect(w.requests.made.length).toBe(1);
  });
});

describe("room freed for a game", () => {
  test("wakes its run that asked for room on its build, even after something else woke it meanwhile: the run still asks, and freeing room takes it on at once", async () => {
    const { g, way } = n64Game("Room Woken");
    w.kept(g, "banjo.z64", { platform: "n64" });
    crdeps.diskFree = async () => 10 * GB;
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    for (let i = 0; i < 3; i++) {
      w.end(live(run.id, "assemble").id, { state: "failed", message: "not enough room on the library: 10 GB free, 54 GB needed with what it keeps free", fail: { class: "env", kind: "room" } });
      const r = await w.advance(run.id);
      if (r.state === "asking") break;                   // plainly short: asked at the first failure
      if (i < 2) { w.clock.t = r.next_at! * 1000; await w.advance(run.id); }
    }
    expect([w.run(run.id).state, serializeRun(w.run(run.id)).ask?.code]).toEqual(["asking", "room"]);
    // five minutes later something else of the game's ends and wakes the run: it looks, and still asks for room
    w.clock.t += 5 * 60_000;
    pokeRuns({ gameId: g.id });
    const r = await w.advance(run.id);
    expect([r.state, serializeRun(r).ask?.code]).toEqual(["asking", "room"]);
    // the admin frees room (a kept duplicate): the run builds again at once, not at the end of its hour
    expect(roomFreed(g.id)).toBe(1);
    await w.advance(run.id);
    expect(kinds(run.id, "assemble").length).toBe(2);                         // asked at the first: one failed, one after the free
  });
});

describe("advances of one run", () => {
  test("never interleave, however many ask for one at once (the ticker and two presses of the admin's)", async () => {
    const { g, way } = n64Game("Three At Once");
    w.romPackage(g, "banjo.z64", { size: 16 * 2 ** 20, platform: "n64" });  // a copy not looked at yet: each look judges it
    let inside = 0, most = 0;
    crdeps.judgeCopy = async () => { inside++; most = Math.max(most, inside); await Bun.sleep(5); inside--; return null; };
    const run = w.start({ wayId: way.id, by: "backfill" });
    await Promise.all([advanceRun(run.id), advanceRun(run.id), advanceRun(run.id)]);
    expect(most).toBe(1);
  });
});

describe("an assemble that says the plan is not ready", () => {
  test("has the plan checked again, even when nothing in it changed: never an assemble queued over and over for a plan left a draft", async () => {
    // a plan built from source with each game's file (sm64ex): ready once it validates, which its check says
    const perGame: RuntimePlanSpec = {
      program: { kind: "source", ref: "master", steps: ["make BASEROM={content}"], artifact: "build/pc", content: "build" },
      launch: { exe: "sm64.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "Super Mario 64, US", search: ["Super Mario 64"], accept: { hashes: [{ algo: "sha1", value: "9bef1128717f958171a4afac3ed78ee2bb4e86ce" }] }, normalize: "n64-z64", place: "baserom.us.z64", ship: false },
      files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", check: { steps: [], smoke: { seconds: 10, needs: "gl" } },
    };
    const p = w.plan("Skeptic sm64ex", "port", perGame, { status: "draft" });
    const g = w.game("Super Mario 64", ["N64"]);
    const way = w.way(g, p);
    w.kept(g, "baserom.us.z64", { sha1: "9bef1128717f958171a4afac3ed78ee2bb4e86ce", platform: "n64" });
    let checks = 0;
    const fake = crdeps.checkPlanNow;
    crdeps.checkPlanNow = async pl => { checks++; return fake(pl); };
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    expect([checks, getPlan(p.id)!.status]).toEqual([1, "ready"]);
    const asm = live(run.id, "assemble");
    // made a draft again while the build waited, its spec as it was (the admin changed the plan's kind, say)
    db.query("UPDATE runtime_plans SET status='draft', status_note=NULL WHERE id=?").run(p.id);
    w.end(asm.id, { state: "failed", message: "the plan is draft: check it before building", fail: { class: "plan" } });
    await w.advance(run.id);
    // checked again, so ready again before the next build: not a draft built (and refused) once more
    expect([checks, getPlan(p.id)!.status]).toEqual([2, "ready"]);
    expect(kinds(run.id, "construct")).toEqual([]);
  });
});
