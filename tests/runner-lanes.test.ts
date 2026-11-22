/**
 * The runner's lanes, lock keys, build users and typed ends (DESIGN3 B3 item 6; AMEND M3, M11, H2, H1 via SEAMS): each kind
 * in a lane of its own (ways, intake, long, ai beside the imports), every lane's cap read as the settings say now, one job
 * per lock key whatever the lanes, a build user taken when a job starts and given back when it ends, and every failure
 * written as its kind (jobs.fail_json) — a cancel with who asked, a restart that cut a job short. The jobs are held by fake
 * kinds until the test lets them go.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type RequestRow } from "../src/db";
import { ensureDefaultRootFolder, rootFolderFor, workDirFor } from "../src/library/rootfolders";
import { enqueueJob, jobKinds, type KindDef } from "../src/process/kinds";
import { activeJobs, cancelJob, finalizeHooks, laneOf, processTick, rdeps, resumeJobs, runJob } from "../src/process/runner";
import { inspectRom } from "../src/process/validate";
import { events } from "../src/events";
import { claimUnpacked, keepUnpacked, markUnpacked, unpackKey } from "../src/ways/unpack-cache";
import { resetSandbox, sandboxUserFor, sbdeps } from "../src/ways/sandbox";
import { restoreDeps } from "./ways-fixtures";
import { pdeps } from "../src/process/deps";
import { activityApi } from "../src/api/activity";
import { EnvError, NeedsBuild, NeedsFiles, PlanFault } from "../src/ways/errors";
import type { JobKind } from "../src/ways/types";

type Kind = Exclude<JobKind, "import">;
const KINDS: Kind[] = ["assemble", "build", "make", "content", "construct"];
const saved = new Map(KINDS.map(k => [k, jobKinds.get(k)]));
const realRdeps = { ...rdeps }, realPdeps = { ...pdeps };

/** a kind whose jobs run until the test lets each one go */
const gates = new Map<number, () => void>();
const gated = (): KindDef => ({ run: ctx => new Promise(r => { gates.set(ctx.job.id, () => r({ message: "done" })); }), scratch: () => 0 });
const state = (j: JobRow) => (stmts.jobById.get(j.id) as JobRow).state;
const failOf = (j: JobRow) => JSON.parse((stmts.jobById.get(j.id) as JobRow).fail_json ?? "null");
async function until(ok: () => boolean) { for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(10); expect(ok()).toBe(true); }
/** let jobs go: a job says 'running' before its kind has started (its scratch folder is made first), so each one's gate
 *  is waited for */
const go = async (...ids: number[]) => { for (const id of ids) { await until(() => gates.has(id)); gates.get(id)!(); } };
const ended = (...js: JobRow[]) => () => js.every(j => !["queued", "running"].includes(state(j)));

beforeEach(() => {
  db.exec("DELETE FROM jobs;");
  ensureDefaultRootFolder();
  pdeps.log = () => {};
  pdeps.diskSpace = async () => ({ free: 1e12, total: 2e12 });
  for (const k of KINDS) jobKinds.set(k, gated());
});
afterEach(async () => {
  // every job still held is let go, also one whose kind starts only now
  for (let i = 0; i < 400 && activeJobs() > 0; i++) { for (const f of gates.values()) f(); await Bun.sleep(10); }
  expect(activeJobs()).toBe(0);
  gates.clear();
  for (const [k, v] of saved) { if (v) jobKinds.set(k, v); else jobKinds.delete(k); }
  Object.assign(rdeps, realRdeps); Object.assign(pdeps, realPdeps);
  for (const k of ["WAYS_PARALLEL", "LONG_PARALLEL", "INTAKE_PARALLEL", "IMPORT_PARALLEL"]) delete process.env[k];
});

describe("lanes", () => {
  test("the carry and the request follow one content job even if two fetches reported the same path", () => {
    const spec = { kind: "content" as const, gameId: null, wayId: 13, path: "/arrivals/release", fetchId: 91 };
    const first = enqueueJob({ ...spec, earlier: true });
    expect(enqueueJob({ ...spec, fetchId: 98 }).id).toBe(first.id);
    expect(enqueueJob({ ...spec, wayId: 14 }).id).not.toBe(first.id);
    expect(enqueueJob({ ...spec, path: "/arrivals/other" }).id).not.toBe(first.id);
  });

  test("only a complete unpack is reused, and changing a later volume invalidates it", async () => {
    const top = mkdtempSync(join(tmpdir(), "ludarr-checkpoint-")), a = join(top, "job-1"), b = join(top, "job-2");
    const slot = "unpacked-0-0", first = join(top, "game.rar"), next = join(top, "game.r00");
    mkdirSync(join(a, slot), {recursive:true}); writeFileSync(join(a, slot, "game"), "done");
    writeFileSync(first, "first"); writeFileSync(next, "second");
    const key = await unpackKey(13, [first, next]);
    await keepUnpacked(a);
    expect(await claimUnpacked(b, slot, key)).toBe(false);
    await markUnpacked(a, slot, key); await keepUnpacked(a);
    writeFileSync(next, "changed volume");
    expect(await claimUnpacked(b, slot, await unpackKey(13, [first, next]))).toBe(false);
    expect(await claimUnpacked(b, slot, key)).toBe(true);
    expect(await Bun.file(join(b, slot, "game")).text()).toBe("done");
  });

  test("a make and a game's own build run beside an assemble with every cap at 1; intake and the AI have lanes of their own; a cap is read as it is now", async () => {
    process.env.WAYS_PARALLEL = "1"; process.env.LONG_PARALLEL = "1"; process.env.INTAKE_PARALLEL = "1";
    const a1 = enqueueJob({ kind: "assemble", wayId: 101 }), a2 = enqueueJob({ kind: "assemble", wayId: 102 });
    const m = enqueueJob({ kind: "make", wayId: 201, from: "kept" }), kb = enqueueJob({ kind: "build", planId: 5, wayId: 202 });
    const pb = enqueueJob({ kind: "build", planId: 6 });
    const c1 = enqueueJob({ kind: "content", gameId: null, path: "/inbox/a" }), c2 = enqueueJob({ kind: "content", gameId: null, path: "/inbox/b" });
    const x1 = enqueueJob({ kind: "construct", repo: "a/b" }), x2 = enqueueJob({ kind: "construct", repo: "c/d" });
    expect([a1, m, kb, pb, c1, x1].map(laneOf)).toEqual(["ways", "long", "long", "ways", "intake", "ai"]);
    await processTick();
    expect([a1, a2, m, kb, pb, c1, c2, x1, x2].map(state)).toEqual(["running", "queued", "running", "queued", "queued", "running", "queued", "running", "queued"]);
    // a setting changed: the next tick lets one more file in
    process.env.INTAKE_PARALLEL = "2";
    await processTick();
    expect(state(c2)).toBe("running");
    // the AI's lane takes one at a time, whatever the settings say
    process.env.WAYS_PARALLEL = "9";
    await processTick();
    expect([state(x2), state(a2), state(pb)]).toEqual(["queued", "running", "running"]);
    await go(x1.id);
    await until(ended(x1));
    await processTick();
    expect(state(x2)).toBe("running");
  });

  test("two jobs with one lock key never run at once, whatever their lanes: a way's make, assemble, file intake and program build take turns", async () => {
    process.env.WAYS_PARALLEL = "5"; process.env.LONG_PARALLEL = "5"; process.env.INTAKE_PARALLEL = "5";
    const make = enqueueJob({ kind: "make", wayId: 7, from: "copy" });
    const asm = enqueueJob({ kind: "assemble", wayId: 7 });
    const take = enqueueJob({ kind: "content", gameId: null, wayId: 7, fromCopy: true });
    const prog = enqueueJob({ kind: "build", planId: 3, wayId: 7 });
    const other = enqueueJob({ kind: "assemble", wayId: 8 });
    await processTick();
    expect([make, asm, take, prog, other].map(state)).toEqual(["running", "queued", "queued", "queued", "running"]);
    for (const [now, next] of [[make, asm], [asm, take], [take, prog]] as const) {
      await go(now.id);
      await until(ended(now));
      await processTick();
      expect(state(next)).toBe("running");
      expect([asm, take, prog].filter(j => j !== next && state(j) === "running")).toEqual([]);
    }
  });
});

describe("Ocarina of Time on game 48 (NX2navi), its ordinary download running", () => {
  test("the download's import goes on beside the way's build from its kit (lanes of their own, no key in common), and the way's assemble waits for that build", async () => {
    process.env.WAYS_PARALLEL = "1"; process.env.LONG_PARALLEL = "1"; process.env.IMPORT_PARALLEL = "1";
    const game48 = upsertGame({ steam_appid: 991_048, name: "The Legend of Zelda: Ocarina of Time", slug: "the-legend-of-zelda-ocarina-of-time-switch-2" }) as GameRow;
    const input = mkdtempSync(join(tmpdir(), "lanes-oot-"));
    writeFileSync(join(input, "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp.nsp"), "x");
    let importGoes: () => void = () => {};
    rdeps.importers = () => [{ impl: "recipes", name: "held", importer: { probe: async () => true, run: () => new Promise(r => { importGoes = () => r({ ok: false, shape: "folder", reason: "the test let it go" } as never); }) } }];
    const download = stmts.insertJob.get(null, null, game48.id, input) as JobRow;
    const kitBuild = enqueueJob({ kind: "build", planId: 2, wayId: 48 }, { gameId: game48.id });
    const assemble = enqueueJob({ kind: "assemble", wayId: 48 }, { gameId: game48.id });
    expect([download, kitBuild, assemble].map(laneOf)).toEqual(["import", "long", "ways"]);
    await processTick();
    expect([download, kitBuild, assemble].map(state)).toEqual(["running", "running", "queued"]);
    await go(kitBuild.id);
    await until(ended(kitBuild));
    await processTick();
    expect([state(download), state(assemble)]).toEqual(["running", "running"]);
    importGoes();
    await go(assemble.id);
    await until(ended(download, assemble));
    expect([state(download), state(assemble)]).toEqual(["failed", "done"]);
  });
});

describe("build users", () => {
  test("a pool that cannot answer leaves the job queued, saying that it waits", async () => {
    rdeps.takeSandboxUser = () => { throw new Error("the pool's own record cannot be read"); };
    const j = enqueueJob({ kind: "assemble", wayId: 77 });
    await processTick();
    expect(stmts.jobById.get(j.id)).toMatchObject({ state: "queued", message: "waiting for a build user to be free (every one is running another job's programs)" });
    stmts.setJobFailed.run("cancelled", "test over", j.id);
  });

  test("each job's programs run as a build user of its own: none free → it waits, saying so; each is given back once, when its job ends", async () => {
    process.env.WAYS_PARALLEL = "5";
    const free = ["builder", "builder2"], held = new Map<number, string>(), back: number[] = [];
    rdeps.takeSandboxUser = id => { const u = free.shift(); if (!u) return null; held.set(id, u); return { user: u, uid: 1500 + held.size }; };
    rdeps.releaseSandboxUser = id => { back.push(id); const u = held.get(id); if (u) { held.delete(id); free.push(u); } };
    const a = enqueueJob({ kind: "assemble", wayId: 11 }), b = enqueueJob({ kind: "assemble", wayId: 12 }), c = enqueueJob({ kind: "assemble", wayId: 13 });
    await processTick();
    expect([a, b, c].map(state)).toEqual(["running", "running", "queued"]);
    expect((stmts.jobById.get(c.id) as JobRow).message).toBe("waiting for a build user to be free (every one is running another job's programs)");
    await go(a.id);
    await until(ended(a));
    // given back in the job's last step, once its scratch folder is gone (its row says done a moment before); a job of an
    // earlier test that is still in its last step may give its user back meanwhile, so only this test's jobs are counted
    const mine = () => back.filter(id => [a.id, b.id, c.id].includes(id));
    await until(() => mine().length > 0);
    expect(mine()).toEqual([a.id]);
    await processTick();
    expect(state(c)).toBe("running");
    await go(b.id, c.id);
    await until(ended(b, c));
    await until(() => mine().length >= 3);
    expect(mine().sort()).toEqual([a.id, b.id, c.id].sort());
    // a job run by itself takes one too, and gives it back
    const d = enqueueJob({ kind: "assemble", wayId: 14 });
    const running = runJob(d.id);
    await until(() => gates.has(d.id));
    expect(held.has(d.id)).toBe(true);
    await go(d.id);
    await running;
    expect(back.filter(id => id === d.id)).toEqual([d.id]);
  });
});

describe("how a job ended (fail_json)", () => {
  test("every failure says what kind it was, from the error's type, never from its words", async () => {
    const cases: [unknown, unknown][] = [
      [new PlanFault("build", "build step 2 failed (exit 1): socket timed out"), { class: "plan", phase: "build" }],
      [new EnvError("room", "not enough room"), { class: "env", kind: "room" }],
      [new NeedsFiles("no game file yet: upload one, or pick one on the server"), { class: "file" }],
      [new NeedsBuild("its program has to be built for this game first"), { class: "other", kind: "needs-build" }],
      [new Error("the network is down: socket hang up"), { class: "other" }],
    ];
    for (const [i, [err, fail]] of cases.entries()) {
      jobKinds.set("build", { run: async () => { throw err; } });
      const j = enqueueJob({ kind: "build", planId: 900 + i });
      await runJob(j.id);
      expect([state(j), failOf(j)]).toEqual(["failed", fail]);
    }
    jobKinds.set("build", { run: async () => ({ message: "built" }) });
    const fine = enqueueJob({ kind: "build", planId: 999 });
    await runJob(fine.id);
    expect([state(fine), failOf(fine)]).toEqual(["done", null]);
  });

  test("a cancel says who asked — the admin, a carry run, ludarr itself — and the first to ask is the one kept", async () => {
    jobKinds.set("build", { run: ctx => new Promise((_r, reject) => ctx.signal.addEventListener("abort", () => reject(new PlanFault("build", "stopped")))) });
    const live = enqueueJob({ kind: "build", planId: 950 });
    const running = runJob(live.id);
    await Bun.sleep(20);
    expect(cancelJob(live.id, "cancelled by the admin", "admin")).toBe(true);
    cancelJob(live.id, "the run was stopped", "run");
    await running;
    expect([state(live), failOf(live)]).toEqual(["cancelled", { class: "cancelled", by: "admin" }]);
    const queued = enqueueJob({ kind: "build", planId: 951 });
    expect(cancelJob(queued.id, "the run was stopped", "run")).toBe(true);
    expect(stmts.jobById.get(queued.id)).toMatchObject({ state: "cancelled", message: "the run was stopped" });
    expect(failOf(queued)).toEqual({ class: "cancelled", by: "run" });
    const mine = enqueueJob({ kind: "build", planId: 952 });
    cancelJob(mine.id);
    expect(failOf(mine)).toEqual({ class: "cancelled", by: "system" });
  });

  test("a job a restart cut short that may not run again unasked says so ({class: restart}); one that runs again carries no failure", () => {
    jobKinds.set("construct", { run: async () => ({ message: "" }), resumable: false });
    const con = enqueueJob({ kind: "construct", repo: "x/y" }), asm = enqueueJob({ kind: "assemble", wayId: 999 });
    for (const j of [con, asm]) stmts.setJob.run("running", null, 0.5, "busy", j.id);
    resumeJobs();
    expect([state(con), failOf(con)]).toEqual(["failed", { class: "restart" }]);
    expect([state(asm), failOf(asm)]).toEqual(["queued", null]);
    stmts.setJobFailed.run("cancelled", "test over", asm.id);
  });

  test("an import that fails says so too", async () => {
    rdeps.importers = () => [];
    const input = mkdtempSync(join(tmpdir(), "lanes-import-"));
    writeFileSync(join(input, "Game.exe"), "x");
    const j = stmts.insertJob.get(null, null, null, input) as JobRow;
    await runJob(j.id);
    expect(stmts.jobById.get(j.id)).toMatchObject({ state: "failed", message: "no importer is enabled — turn one on under Settings → Importers" });
    expect(failOf(j)).toEqual({ class: "other" });
  });

  test("removing a search from the activity queue cancels the job it follows as the admin's", async () => {
    const g = upsertGame({ steam_appid: 991_001, name: "Queue Cancel", slug: "queue-cancel" }) as GameRow;
    const r = stmts.insertRequest.get(g.id, "test") as RequestRow;
    const j = stmts.insertJob.get(r.id, null, g.id, "/nowhere") as JobRow;
    db.query("UPDATE requests SET state='processing', job_id=? WHERE id=?").run(j.id, r.id);
    const res = await activityApi.request(`/api/v1/queue/${r.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(stmts.jobById.get(j.id)).toMatchObject({ state: "cancelled", message: "cancelled by the admin" });
    expect(failOf(j)).toEqual({ class: "cancelled", by: "admin" });
  });
});

describe("a job's end", () => {
  afterEach(() => { restoreDeps(); resetSandbox(); delete process.env.LUDARR_DOWNLOADS; });

  test("what still runs as the job's build user is stopped before its scratch folder goes, its folder on the downloads folder's volume goes too, and only then is the user given back", async () => {
    // a Linux container as the Docker image makes it: root, runuser, the build users (the pool is builder1 … builder7)
    const passwd = ["root:x:0:0::/root:/bin/sh", "builder:x:1500:1500::/home/builder:/bin/sh", ...[1, 2, 3, 4, 5, 6, 7].map(i => `builder${i}:x:${1500 + i}:${1500 + i}::/home/builder${i}:/bin/sh`)].join("\n");
    Object.assign(sbdeps, {
      platform: () => "linux", uid: () => 0, which: (n: string) => (n === "runuser" ? "/usr/sbin/runuser" : null), passwd: () => passwd, group: () => "users:x:100:\n",
      chown: async () => {}, chmod: async () => {}, tempDirs: () => [], settleMs: 1, log: () => {},
    });
    const dl = mkdtempSync(join(tmpdir(), "lanes-dl-"));
    process.env.LUDARR_DOWNLOADS = dl;
    let work = "", spare = "", procs: { pid: number; uid: number; euid: number }[] = [];
    const seen: string[] = [];
    sbdeps.procs = () => procs;
    sbdeps.kill = pid => { seen.push(`stopped ${pid}, the scratch folder ${existsSync(work) ? "still there" : "gone"}`); procs = procs.filter(p => p.pid !== pid); };
    rdeps.releaseSandboxUser = id => { seen.push(`given back, the scratch folder ${existsSync(work) ? "still there" : "gone"}, the downloads one ${existsSync(spare) ? "still there" : "gone"}`); realRdeps.releaseSandboxUser(id); };
    jobKinds.set("make", {
      scratch: () => 0,
      run: async ctx => {
        work = ctx.work;
        spare = join(dl, ".ahoy-work", `job-${ctx.job.id}`);
        mkdirSync(join(spare, "prep", "x"), { recursive: true });
        writeFileSync(join(spare, "prep", "x", "eboot.bin"), "half an unpack");
        // a helper the step started outlives it, running as the job's own user (a container's root cannot read its folders)
        const own = sandboxUserFor(ctx.work).uid;
        procs = [{ pid: 4321, uid: own, euid: own }, { pid: 77, uid: 1500, euid: 1500 }];
        return { message: "made" };
      },
    });
    const j = enqueueJob({ kind: "make", wayId: 301, from: "kept" });
    await runJob(j.id);
    expect(state(j)).toBe("done");
    expect(seen).toEqual(["stopped 4321, the scratch folder still there", "given back, the scratch folder gone, the downloads one gone"]);
    expect(procs.map(p => p.pid)).toEqual([77]);                             // what runs as 'builder' is no job's: left alone
  });

  test("a dump's hand-off after its import says its bytes as the job's live progress, and never touches the done row", async () => {
    const g = upsertGame({ steam_appid: 991_777, name: "Handoff Progress", slug: "handoff-progress" }) as GameRow;
    const input = mkdtempSync(join(tmpdir(), "lanes-dump-"));
    writeFileSync(join(input, "Handoff Progress (USA).z64"), new Uint8Array(64 * 1024).fill(7));
    rdeps.importers = () => [{ impl: "recipes", name: "copy", importer: { probe: async () => true, run: async (ctx: any) => {
      cpSync(ctx.input, ctx.staging, { recursive: true });
      return { ok: true, shape: "folder" as const, reason: null, platform: "n64", validation: await inspectRom(ctx.staging) };
    } } }];
    let id = -1;
    const seen: { event: string; state: string; message: string; progress: number }[] = [];
    const off = events.subscribe(e => { const d = e.data as JobRow & { state: string }; if ((e.event === "build" || e.event === "job") && d?.id === id) seen.push({ event: e.event, state: d.state, message: String(d.message), progress: Number(d.progress) }); });
    const saved = finalizeHooks.romImported;
    finalizeHooks.romImported = async o => {
      o.progress?.(0.5, "reading the dump where it lies · 32 KB of 64 KB");
      o.progress?.(0.9, "said again too soon: not sent");
      o.log("the dump is the game file of a way");
    };
    try {
      const j = stmts.insertJob.get(null, null, g.id, input) as JobRow;
      id = j.id;
      await runJob(j.id);
      const done = stmts.jobById.get(j.id) as JobRow;
      expect([done.state, done.message]).toEqual(["done", expect.stringMatching(/^ready:/)]);
      const ticks = seen.filter(s => s.event === "build");
      expect(ticks).toEqual([{ event: "build", state: "done", message: "handing the dump to a way to play: reading the dump where it lies · 32 KB of 64 KB", progress: 0.5 }]);
      expect(seen.at(-1)).toMatchObject({ event: "job", state: "done", message: expect.stringMatching(/^ready:/) });
    } finally { off(); finalizeHooks.romImported = saved; }
  });
});

describe("a job's scratch folder", () => {
  test("what a restart left in a resumed job's folder is cleared saying so, never under a silent '1 % starting'", async () => {
    const j = enqueueJob({ kind: "make", wayId: 301, from: "kept" });
    const work = join(workDirFor(rootFolderFor(null)!), `job-${j.id}`);
    // the restart cut it short while it unpacked: its scratch folder still holds what it wrote
    mkdirSync(join(work, "make", "run", "prep", "x"), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(work, "make", "run", "prep", "x", `part-${i}.bin`), "x");
    const said: string[] = [];
    const off = events.subscribe(e => { const d = e.data as { id?: number; message?: string | null }; if ((e.event === "build" || e.event === "job") && d?.id === j.id && d.message) said.push(d.message); });
    try {
      void runJob(j.id);
      await go(j.id);
      await until(ended(j));
    } finally { off(); }
    const clearing = said.findIndex(m => /^clearing what this job's last start left in its scratch folder/.test(m));
    expect(clearing).toBeGreaterThan(said.indexOf("starting"));
    expect(existsSync(join(work, "make"))).toBe(false);
  });

  test("at boot, what jobs that will not run again left in the library's work folder goes; a queued job's folder stays for its own start", async () => {
    const top = workDirFor(rootFolderFor(null)!);
    const leftover = (id: number) => { const d = join(top, `job-${id}`, "make", "run", "prep"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "part.bin"), "x"); return join(top, `job-${id}`); };
    // cancelled while it was queued after a restart: it never runs again
    const cancelled = enqueueJob({ kind: "make", wayId: 311, from: "kept" });
    cancelJob(cancelled.id, "stopped by its run", "run");
    // running when the process died: a make is queued again, a construct round is not (it fails, and says so)
    jobKinds.set("construct", { ...gated(), resumable: false });
    const make = enqueueJob({ kind: "make", wayId: 312, from: "kept" }), round = enqueueJob({ kind: "construct", repo: "a/b" });
    for (const j of [make, round]) stmts.setJob.run("running", "deterministic", 0.4, "unpacking", j.id);
    const dirs = { cancelled: leftover(cancelled.id), make: leftover(make.id), round: leftover(round.id), gone: leftover(990_000 + cancelled.id) };
    mkdirSync(join(top, "probe-1"), { recursive: true });                     // not a job's: left alone
    resumeJobs();
    expect([state(make), state(round)]).toEqual(["queued", "failed"]);
    await until(() => !existsSync(dirs.cancelled) && !existsSync(dirs.round) && !existsSync(dirs.gone));
    expect(existsSync(dirs.make)).toBe(true);                                 // its own start clears it, saying so
    expect(existsSync(join(top, "probe-1"))).toBe(true);
    cancelJob(make.id);
  });
});
