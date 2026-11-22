/**
 * The run API (src/ways/carry-api.ts): behind the key; plain words with 400, 404 and 409; the handlers record an intent
 * and the run applies it; "Make it playable" comes back with the open run; the backfill gives one run per (plan, game).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiKey } from "../src/config";
import { db, stmts } from "../src/db";
import { app } from "../src/server";
import { cadeps, carryApi } from "../src/ways/carry-api";
import { ensureRuns, getRun, startRun, stopRun } from "../src/ways/carry";
import { getPlan } from "../src/ways/store";
import { MM_SHA1, mmDraft, world, zeldaPlan, type World } from "./carry-world";

let w: World;
const realCa = { ...cadeps };
beforeEach(() => { w = world(); });
afterEach(() => { w.cleanup(); Object.assign(cadeps, realCa); });

const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await carryApi.request(path, init);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
function wayOf(name: string) {
  const p = w.plan(name, "recomp", zeldaPlan(true));
  const g = w.game("The Legend of Zelda: Majora's Mask", ["N64"]);
  return { p, g, way: w.way(g, p) };
}

describe("behind the key", () => {
  test("every run route wants the key", async () => {
    const routes: [string, string][] = [
      ["GET", "/api/v1/runs"], ["GET", "/api/v1/run/1"], ["POST", "/api/v1/run/1/stop"], ["POST", "/api/v1/run/1/retry"], ["POST", "/api/v1/run/1/answer"], ["POST", "/api/v1/run/1/tell"],
      ["POST", "/api/v1/way/1/carry"], ["POST", "/api/v1/plan/1/carry"], ["POST", "/api/v1/content/1/free-duplicate"], ["GET", "/api/v1/check-shot/a.png"],
    ];
    for (const [method, path] of routes) expect([method, path, (await app.request(path, { method })).status]).toEqual([method, path, 401]);
    expect((await app.request("/api/v1/runs", { headers: { "x-api-key": apiKey() } })).status).toBe(200);
  });
});

describe("the routes", () => {
  test("no such run, way, plan, game or file: 404 with words", async () => {
    for (const [method, path] of [["GET", "/api/v1/run/999999"], ["POST", "/api/v1/run/999999/stop"], ["POST", "/api/v1/run/999999/retry"], ["POST", "/api/v1/run/999999/answer"]] as const)
      expect(await call(path, send(method, {}))).toEqual({ status: 404, body: { error: "no such run" } });
    expect(await call("/api/v1/way/999999/carry", send("POST", {}))).toEqual({ status: 404, body: { error: "no such way" } });
    expect(await call("/api/v1/plan/999999/carry", send("POST", {}))).toEqual({ status: 404, body: { error: "no such plan" } });
    const { p } = wayOf("Api Carry 404");
    expect(await call(`/api/v1/plan/${p.id}/carry`, send("POST", { gameId: 999999 }))).toEqual({ status: 404, body: { error: "no such game" } });
    expect(await call("/api/v1/content/999999/free-duplicate", send("POST"))).toEqual({ status: 404, body: { error: "no such file" } });
    for (const name of ["../x.png", "A.png", "x.jpg", "missing.png"]) expect((await call(`/api/v1/check-shot/${encodeURIComponent(name)}`)).status).toBe(404);
  });

  test("Make it playable: the way's open run comes back (202), replace recorded; a built way is refused", async () => {
    const { way, p } = wayOf("Api Carry Way");
    const a = await call(`/api/v1/way/${way.id}/carry`, send("POST", {}));
    expect(a.status).toBe(202);
    expect(a.body.item).toMatchObject({ wayId: way.id, planId: p.id, state: "active", startedBy: "admin", steps: [{ text: "you asked to make it playable", who: "admin" }] });
    const b = await call(`/api/v1/way/${way.id}/carry`, send("POST", { replace: true }));
    expect([b.status, b.body.item.id]).toEqual([202, a.body.item.id]);
    expect(JSON.parse(getRun(a.body.item.id)!.facts_json).replace).toBe(true);
    expect((await call(`/api/v1/way/${way.id}/carry`, send("POST", { replace: "yes" }))).status).toBe(400);
    const pkg = stmts.insertPackage.get(way.game_id, null, "/z", "x", null, 1, JSON.stringify({ schema: 1, kind: "recomp", files: [] })) as { id: number };
    db.query("UPDATE ways SET status='built', package_id=? WHERE id=?").run(pkg.id, way.id);
    expect(await call(`/api/v1/way/${way.id}/carry`, send("POST", {}))).toEqual({ status: 409, body: { error: "the way is built: members can install it" } });
    db.query("DELETE FROM packages WHERE id=?").run(pkg.id);
    // a plan's carry: its open run for that game, the same one twice
    const c = await call(`/api/v1/plan/${p.id}/carry`, send("POST", { gameId: way.game_id }));
    expect([c.status, c.body.item.id]).toEqual([202, a.body.item.id]);
  });

  test("the list filters by game, plan, way and open; one run has its steps", async () => {
    const one = wayOf("Api Runs One"), two = wayOf("Api Runs Two");
    const r1 = startRun({ wayId: one.way.id, by: "backfill" }), r2 = startRun({ wayId: two.way.id, by: "backfill" });
    stopRun(r2.id, "test");
    const all = (await call(`/api/v1/runs?planId=${one.p.id}`)).body.items;
    expect(all.map((x: { id: number }) => x.id)).toEqual([r1.id]);
    expect(all[0].steps).toBeUndefined();
    expect((await call(`/api/v1/runs?wayId=${two.way.id}`)).body.items.map((x: { id: number; state: string }) => [x.id, x.state])).toEqual([[r2.id, "stopped"]]);
    expect((await call(`/api/v1/runs?wayId=${two.way.id}&open=1`)).body.items).toEqual([]);
    expect((await call(`/api/v1/runs?gameId=${one.g.id}&open=1`)).body.items.map((x: { id: number }) => x.id)).toEqual([r1.id]);
    expect((await call("/api/v1/runs?gameId=abc")).status).toBe(400);
    const one1 = (await call(`/api/v1/run/${r1.id}`)).body.item;
    expect(one1).toMatchObject({ id: r1.id, phase: "plan", state: "active", budget: { rounds: 3, roundsUsed: 0, tokens: 8e6, tokensUsed: 0 }, rail: [{ phase: "plan", state: "active" }, { phase: "game", state: "todo" }, { phase: "file", state: "todo" }, { phase: "build", state: "todo" }, { phase: "check", state: "todo" }] });
    expect(one1.steps.length).toBe(1);
  });

  test("stop, and look again: an ended run says so with 409", async () => {
    const { way } = wayOf("Api Stop");
    const run = startRun({ wayId: way.id, by: "backfill" });
    const s = await call(`/api/v1/run/${run.id}/stop`, send("POST"));
    expect(s.body.item).toMatchObject({ state: "stopped" });
    expect(s.body.item.steps.at(-1).text).toBe("stopped: you stopped it");
    expect(await call(`/api/v1/run/${run.id}/stop`, send("POST"))).toEqual({ status: 409, body: { error: "the run has stopped already" } });
    expect((await call(`/api/v1/run/${run.id}/retry`, send("POST"))).status).toBe(409);
    // a run held by the admin's cancel resumes on retry
    const other = wayOf("Api Resume");
    const held = startRun({ wayId: other.way.id, by: "backfill" });
    db.query("UPDATE carry_runs SET state='held', next_at=NULL, version=version+1 WHERE id=?").run(held.id);
    const r = await call(`/api/v1/run/${held.id}/retry`, send("POST"));
    expect(r.body.item).toMatchObject({ state: "active" });
    expect(r.body.item.steps.at(-1)).toMatchObject({ who: "admin", text: "you pressed Resume: carrying on" });
  });
});

describe("answers", () => {
  /** plan 1: a step-0 plan saved without a game, its game not in the library */
  function heldPlan(name: string) {
    const job = stmts.insertJobOf.get(null, null, null, "repo:Zelda64Recomp/Zelda64Recomp", "construct", JSON.stringify({ kind: "construct", repo: "Zelda64Recomp/Zelda64Recomp" }), null) as { id: number };
    const p = w.plan(name, "recomp", zeldaPlan(true), { repo: "Zelda64Recomp/Zelda64Recomp", jobId: job.id });
    stmts.setJobDone.run("plan ready", null, JSON.stringify({ planId: p.id, game: mmDraft() }), job.id);
    return p;
  }

  test("the backfill twice: one held run per plan, asking to go ahead; go on, then not now elsewhere", async () => {
    const p = heldPlan("Api Held");
    await ensureRuns();
    await ensureRuns();
    const items = (await call(`/api/v1/runs?planId=${p.id}`)).body.items;
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ state: "held", ask: { code: "go-ahead", title: "Make The Legend of Zelda: Majora's Mask playable?" }, gameName: "The Legend of Zelda: Majora's Mask" });
    const id = items[0].id;
    expect(await call(`/api/v1/run/${id}/answer`, send("POST", { go: "yes" }))).toEqual({ status: 400, body: { error: "send one of { gameId }, { newGame: true } or { go: true | false }" } });
    expect(await call(`/api/v1/run/${id}/answer`, send("POST", { go: true, gameId: 1 }))).toMatchObject({ status: 400 });
    expect(await call(`/api/v1/run/${id}/answer`, send("POST", { newGame: true }))).toEqual({ status: 409, body: { error: "the run is not asking which game it plays" } });
    const go = await call(`/api/v1/run/${id}/answer`, send("POST", { go: true }));
    expect(go.body.item).toMatchObject({ state: "active", ask: null });
    expect(go.body.item.steps.at(-1)).toMatchObject({ who: "admin", text: "you said go ahead" });
    expect(await call(`/api/v1/run/${id}/answer`, send("POST", { go: true }))).toEqual({ status: 409, body: { error: "the run is not waiting for a go-ahead" } });
    // not now: stopped, nothing removed
    const q = heldPlan("Api Not Now");
    await ensureRuns();
    const qid = (await call(`/api/v1/runs?planId=${q.id}`)).body.items[0].id;
    const no = await call(`/api/v1/run/${qid}/answer`, send("POST", { go: false }));
    expect(no.body.item).toMatchObject({ state: "stopped" });
    expect(getPlan(q.id)).not.toBeNull();
  });

  test("which game: a library game, or a new one from the plan's draft", async () => {
    const p = w.plan("Api Which Game", "recomp", zeldaPlan(true));
    const run = startRun({ planId: p.id, by: "construct" });
    const ask = { code: "game", title: "Which game does Api Which Game play?", need: "x", tried: [], accept: null, inbox: null, inboxShare: null, canUpload: false, choices: [], heldContentId: null, watching: null, askedAt: 1, byAi: null };
    db.query("UPDATE carry_runs SET phase='game', state='asking', ask_json=?, version=version+1 WHERE id=?").run(JSON.stringify(ask), run.id);
    expect(await call(`/api/v1/run/${run.id}/answer`, send("POST", { gameId: 999999 }))).toEqual({ status: 404, body: { error: "no such game" } });
    const g = w.game("The Legend of Zelda: Majora's Mask", ["N64"]);
    const r = await call(`/api/v1/run/${run.id}/answer`, send("POST", { gameId: g.id }));
    expect(r.body.item).toMatchObject({ state: "active", gameId: g.id, phase: "game", ask: null });
    expect(r.body.item.steps.at(-1)).toMatchObject({ who: "admin", text: "you answered: The Legend of Zelda: Majora's Mask" });
    // a new game from the draft
    const p2 = w.plan("Api New Game", "recomp", zeldaPlan(true));
    const run2 = startRun({ planId: p2.id, by: "construct" });
    db.query("UPDATE carry_runs SET phase='game', state='asking', ask_json=?, version=version+1 WHERE id=?").run(JSON.stringify(ask), run2.id);
    const n = await call(`/api/v1/run/${run2.id}/answer`, send("POST", { newGame: true }));
    expect(n.body.item).toMatchObject({ state: "active", phase: "game" });
    expect(JSON.parse(getRun(run2.id)!.facts_json).newGame).toBe(true);
  });
});

describe("the second copy, and the check's screenshot", () => {
  test("free-duplicate: B2b's answer, its 409 words passed on", async () => {
    const { g } = wayOf("Api Free");
    const row = w.kept(g, "copy.iso", { source: "package", sha1: MM_SHA1 });
    cadeps.freeDuplicate = async id => { expect(id).toBe(row.id); return { freedBytes: 58_196_590_592 }; };
    expect(await call(`/api/v1/content/${row.id}/free-duplicate`, send("POST"))).toEqual({ status: 200, body: { freedBytes: 58_196_590_592 } });
    cadeps.freeDuplicate = async () => { throw Object.assign(new Error("the kept file is not the copy's bytes: nothing was changed"), { status: 409 }); };
    expect(await call(`/api/v1/content/${row.id}/free-duplicate`, send("POST"))).toEqual({ status: 409, body: { error: "the kept file is not the copy's bytes: nothing was changed" } });
  });

  test("check-shot serves a check's screenshot as image/png", async () => {
    const dir = join(w.dir, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job-12-smoke.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    cadeps.checksDir = () => dir;
    const r = await carryApi.request("/api/v1/check-shot/job-12-smoke.png");
    expect([r.status, r.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });
});
