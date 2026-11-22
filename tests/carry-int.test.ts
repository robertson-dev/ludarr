/**
 * What the live trace found after the fix rounds (integrator): a question the AI hands the admin while the run looks for the
 * way's file must not stop the run watching — a whole game folder dropped into the inbox meanwhile is taken by itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { carryTick, crdeps, getRun, serializeRun } from "../src/ways/carry";
import { GB, kytyCheck, kytyPlan, kytyUpgraded, MM_SHA1, world, zeldaPlan, type World } from "./carry-world";

let w: World;
beforeEach(() => { w = world(); });
afterEach(() => w.cleanup());

const kidOf = (runId: number, kind: string) => w.children(runId).filter(j => j.kind === kind).at(-1)!;

describe("no room: asked at once when the library is plainly short, backed off when it is not", () => {
  function building(name: string) {
    const p = w.plan(`Carry Int ${name}`, "recomp", zeldaPlan(true));
    const g = w.game("The Legend of Zelda: Majora's Mask", ["N64"], { year: 2000 });
    const way = w.way(g, p);
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    return w.start({ wayId: way.id, by: "backfill" });
  }
  const room = { state: "failed" as const, message: "not enough room: 3 GB free", fail: { class: "env" as const, kind: "room" } };
  test("plainly short (10 GB free against about 50 GB): the first failure asks, with the numbers, and looks again hourly", async () => {
    const run = building("Short");
    await w.advance(run.id);
    w.end(w.live(run.id)!.id, room);
    const r = await w.advance(run.id);
    expect([r.state, serializeRun(r).ask?.code]).toEqual(["asking", "room"]);
    expect(r.next_at).toBe(Math.floor(w.clock.t / 1000) + 3600);
    expect(w.children(run.id).filter(j => j.kind === "assemble").length).toBe(1);
  });
  test("room there again by the time the run looks (another job's scratch freed): backed off as before, asked after three", async () => {
    crdeps.diskFree = async () => 500e9;
    const run = building("Transient");
    await w.advance(run.id);
    w.end(w.live(run.id)!.id, room);
    let r = await w.advance(run.id);
    expect([r.state, r.ask_json]).toEqual(["waiting", null]);
    for (let i = 0; i < 2; i++) {
      w.clock.t = r.next_at! * 1000;
      r = await w.advance(run.id);
      w.end(w.live(run.id)!.id, room);
      r = await w.advance(run.id);
    }
    expect([r.state, serializeRun(r).ask?.code]).toEqual(["asking", "room"]);
    expect(w.children(run.id).filter(j => j.kind === "assemble").length).toBe(3);
  });
});

describe("a question the AI asks while the way's file is looked for", () => {
  test("keeps the run watching: an app0 folder dropped into the inbox meanwhile is taken, with no click", async () => {
    const p = w.plan("KytyPS5 Asks Choice", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"]);
    const way = w.way(g, p, { ...kytyUpgraded(), make: { ...kytyUpgraded().make!, from: ["kept", "copy", "inbox"] } }, { check: kytyCheck });
    w.romPackage(g, "PPSA01341-app0", { size: 80 * GB, platform: "ps5" });
    w.copy.serves.set(g.id, { serves: "make", why: "the game folder" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    w.end(kidOf(run.id, "make").id, { state: "failed", message: "what it made does not read as the game", fail: { class: "plan", phase: "make" } });
    await w.advance(run.id);
    w.round(kidOf(run.id, "construct").id, { ask: { need: "other", title: "Making the game file keeps failing", exact: "the packed file holds no sce_sys/param.json" } });
    let r = await w.advance(run.id);
    expect([r.state, serializeRun(r).ask?.code, r.phase]).toEqual(["asking", "choice", "file"]);
    // it looks again by itself: the ticker picks it up in two minutes
    expect(r.next_at).not.toBeNull();
    w.inbox.next.push("/library/.ahoy-inbox/demons-souls/PPSA01341-app0");
    w.clock.t += 130_000;
    await carryTick();
    expect(w.inbox.queued.map(q => q.path)).toContain("/library/.ahoy-inbox/demons-souls/PPSA01341-app0");
    r = getRun(run.id)!;
    expect(w.children(run.id).filter(j => j.kind === "construct").length).toBe(1);   // no second round meanwhile
  });
});
