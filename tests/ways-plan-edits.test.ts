/**
 * Editing a plan around its pin and its builds, and cancelling a build through the API (review findings ways-api-4,
 * ways-api-5, ways-api-6 / e2e-5, ways-build-4): a pin belongs to the program and the repo it was taken from, a build
 * that is running keeps the program it started with and pins it only while the plan still says the same, and the API's
 * cancel goes through the runner so a build's way is put back.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { ndeps } from "../src/net/public-url";
import { enqueueJob } from "../src/process/kinds";
import { resumeJobs, runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { waysApi, wdeps } from "../src/ways/api";
import { adeps } from "../src/ways/assemble";
import { acquireProgram, prdeps } from "../src/ways/program";
import { sbdeps } from "../src/ways/sandbox";
import { getPlan, getWay, insertContent, insertPlan, insertWay, planPinned, updateWay, wstmts } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import { bytes, fake7z, releaseHost, restoreDeps, sha1, sha256, tempConfig, tools7z, zelda } from "./ways-fixtures";

const A = "Zelda64Recompiled-v1.2.2-Windows.zip", F = "Zelda64Recompiled-v1.3.0-fork-Windows.zip";
const OLD = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.2/${A}`;
const FORK = `https://github.com/someone/Zelda64Recomp-fork/releases/download/v1.3.0-fork/${F}`;
const ZIP_OLD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(4000, 1)]), ZIP_FORK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(5000, 2)]);
const rom = (() => { const b = bytes(64 * 1024, 5); b.set([0x80, 0x37, 0x12, 0x40], 0); return b; })();
const raw = (pattern = "^Zelda64Recompiled-v.*-Windows[.]zip$", argv: string[] = []) => ({
  program: { kind: "release", assetPattern: pattern, channel: "stable" }, launch: { exe: "Zelda64Recompiled.exe", argv },
  content: { kind: "rom", platform: "n64", what: "MM", search: ["Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha1(rom) }], formats: ["z64"] }, normalize: "n64-z64", place: "mm.z64" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
});
const pinOld = () => ({ tag: "v1.2.2", asset: A, url: OLD, size: ZIP_OLD.byteLength, sha256: sha256(ZIP_OLD), digest: null, immutable: true, pinnedAt: 1 });

const realW = { ...wdeps }, realAdeps = { ...adeps };
const made = { games: [] as number[], plans: [] as number[] };
let cfg: ReturnType<typeof tempConfig>;
beforeAll(() => { cfg = tempConfig(); ensureDefaultRootFolder(); });
afterEach(() => { restoreDeps(); Object.assign(wdeps, realW); Object.assign(adeps, realAdeps); });
afterAll(() => {
  for (const id of made.games) { db.query("DELETE FROM jobs WHERE game_id=?").run(id); db.query("DELETE FROM packages WHERE game_id=?").run(id); db.query("DELETE FROM games WHERE id=?").run(id); }
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  cfg.restore();
});

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await waysApi.request(path, init);
  return { status: r.status, body: await r.json() };
}
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
let seq = 0;
function game(name: string): GameRow {
  const g = upsertGame({ name, slug: `plan-edits-${++seq}`, platforms_json: JSON.stringify(["n64"]) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function readyPlan(name: string, repo = "Zelda64Recomp/Zelda64Recomp") {
  const p = insertPlan({ name, kind: "recomp", repo, platforms: ["n64"], spec: validatePlanSpec(raw(), "recomp").value!, status: "ready" });
  made.plans.push(p.id);
  return p;
}
/** a game whose way has its verified ROM, through the plan given */
function wayWithFile(g: GameRow, planId: number) {
  const dir = mkdtempSync(join(tmpdir(), "plan-edits-rom-")), romPath = join(dir, "mm.z64");
  writeFileSync(romPath, rom);
  const file = insertContent({ gameId: g.id, platform: "n64", name: "mm.z64", path: romPath, size: rom.byteLength, hashes: { sha1: sha1(rom), sha256: sha256(rom) }, source: "upload" });
  return updateWay(insertWay({ gameId: g.id, planId, status: "ready" }).id, { contentId: file.id })!;
}
const quietTools = () => { pdeps.log = () => {}; pdeps.tools = () => ({ ...tools7z }); sbdeps.platform = () => "win32"; sbdeps.exec = fake7z({ [A]: zelda, [F]: zelda }); };

describe("a pin belongs to the program and the repo it came from", () => {
  test("a new repo drops the old repo's pin: the next build takes the new repo's release (ways-api-4)", async () => {
    const p = readyPlan("Plan Edits Repo");
    wstmts.setPinned.run(JSON.stringify(pinOld()), p.id);
    const put = await call(`/api/v1/plan/${p.id}`, send("PUT", { repo: "https://github.com/someone/Zelda64Recomp-fork" }));
    expect(put.status).toBe(200);
    expect(put.body.item).toMatchObject({ repo: "someone/Zelda64Recomp-fork", status: "draft", pinned: null });
    quietTools();
    const host = releaseHost({ [OLD]: ZIP_OLD, [FORK]: ZIP_FORK });
    prdeps.latestRelease = async repo => (repo === "someone/Zelda64Recomp-fork"
      ? { tag: "v1.3.0-fork", name: "fork", date: "2026-11-01", prerelease: false, page: null, asset: { name: F, url: FORK, size: ZIP_FORK.byteLength } }
      : null) as any;
    const acq = await acquireProgram(getPlan(p.id)!, { work: mkdtempSync(join(tmpdir(), "plan-edits-work-")), log: () => {} });
    expect(host.seen).toEqual([FORK]);
    expect(acq).toMatchObject({ fresh: true, pinned: { tag: "v1.3.0-fork", url: FORK } });
    // the same repo written again (or another field) keeps the pin
    wstmts.setPinned.run(JSON.stringify(pinOld()), p.id);
    expect((await call(`/api/v1/plan/${p.id}`, send("PUT", { repo: "someone/Zelda64Recomp-fork", name: "Plan Edits Repo II" }))).body.item.pinned).toMatchObject({ url: OLD });
  });

  test("while a way of the plan is being built, its program and repo cannot change; a rename can (ways-api-5)", async () => {
    const p = readyPlan("Plan Edits Busy");
    const g = game("Plan Edits Busy Game");
    const w = wayWithFile(g, p.id);
    const job = enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id });
    try {
      const program = await call(`/api/v1/plan/${p.id}`, send("PUT", { spec: raw("^Zelda64Recompiled-v.*-Windows-x64[.]zip$") }));
      expect(program.status).toBe(409);
      expect((await call(`/api/v1/plan/${p.id}`, send("PUT", { repo: "someone/elsewhere" }))).status).toBe(409);
      expect(getPlan(p.id)).toMatchObject({ repo: "Zelda64Recomp/Zelda64Recomp", status: "ready", spec_json: p.spec_json });
      expect((await call(`/api/v1/plan/${p.id}`, send("PUT", { name: "Plan Edits Busy, renamed" }))).status).toBe(200);
    } finally { stmts.setJobFailed.run("cancelled", "test over", job.id); }
  });

  test("a build pins what it took only while the plan still says what the build read (ways-api-5)", async () => {
    quietTools();
    adeps.contentFromPackage = async () => null;
    let release!: () => void, asked!: () => void;
    const gate = new Promise<void>(r => { release = r; }), downloading = new Promise<void>(r => { asked = r; });
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    ndeps.fetch = (async (url: string) => {
      if (url !== OLD) return new Response("nope", { status: 404 });
      asked(); await gate;                                                    // the admin edits the plan while this download runs
      return new Response(new Uint8Array(ZIP_OLD), { headers: { "content-length": String(ZIP_OLD.byteLength) } });
    }) as any;
    prdeps.latestRelease = async () => ({ tag: "v1.2.2", name: "v1.2.2", date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: A, url: OLD, size: ZIP_OLD.byteLength, digest: `sha256:${sha256(ZIP_OLD)}` } }) as any;
    const p = readyPlan("Plan Edits Mid Build");
    const g = game("Plan Edits Mid Build Game");
    const w = wayWithFile(g, p.id);
    const job = enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id });
    const running = runJob(job.id);
    await downloading;
    const put = await call(`/api/v1/plan/${p.id}`, send("PUT", { spec: raw("^Zelda64Recompiled-v.*-Windows[.]zip$", ["--fullscreen"]) }));
    expect(put.status).toBe(200);                                            // not the program: allowed, and the plan is a draft again
    release();
    await running;
    const j = stmts.jobById.get(job.id) as JobRow;
    expect(j.state).toBe("done");
    expect(j.transcript).toContain("the plan was changed during the build: what this build took is not pinned on it");
    expect(planPinned(getPlan(p.id)!)).toBeNull();
    // a build nobody edited around pins as before
    const q = readyPlan("Plan Edits Quiet Build");
    releaseHost({ [OLD]: ZIP_OLD });
    const w2 = wayWithFile(game("Plan Edits Quiet Game"), q.id);
    const j2 = enqueueJob({ kind: "assemble", wayId: w2.id }, { gameId: w2.game_id });
    await runJob(j2.id);
    expect((stmts.jobById.get(j2.id) as JobRow).state).toBe("done");
    expect(planPinned(getPlan(q.id)!)).toMatchObject({ tag: "v1.2.2", asset: A });
  });
});

describe("the API's cancel goes through the runner (ways-api-6, e2e-5)", () => {
  test("a build queued again after a restart, cancelled through the API: its way is put back", async () => {
    const p = readyPlan("Plan Edits Cancel");
    const g = game("Plan Edits Cancel Game");
    const w = wayWithFile(g, p.id);
    const job = enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id });
    // it was running when the server stopped: the way says building, and the restart queues the job again
    stmts.setJob.run("running", "deterministic", 0.3, "getting the program", job.id);
    updateWay(w.id, { status: "building", statusNote: null });
    resumeJobs();
    expect((stmts.jobById.get(job.id) as JobRow).state).toBe("queued");
    const r = await call(`/api/v1/jobs/${job.id}/cancel`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ id: job.id, state: "cancelled", message: "cancelled by the admin" });
    expect(getWay(w.id)).toMatchObject({ status: "ready", status_note: "the build was cancelled" });
    const ways = (await call(`/api/v1/game/${g.id}/ways`)).body.items;
    expect(ways[0]).toMatchObject({ status: "ready", job: null, canBuild: true });
  });
});

describe("a source plan's build is looked for under the name the build reads (ways-build-4)", () => {
  test("the check finds a build stored under storeName of the pinned asset", async () => {
    const builds = mkdtempSync(join(tmpdir(), "plan-edits-builds-"));
    wdeps.buildsDir = () => builds;
    const s = validatePlanSpec({ ...raw(), program: { kind: "source", ref: "v1.0", steps: ["make"], artifact: "out" } }, "recomp");
    expect(s.errors).toEqual([]);
    const p = insertPlan({ name: "Plan Edits Source", kind: "recomp", repo: "someone/source-plan", platforms: ["n64"], spec: s.value!, status: "draft" });
    made.plans.push(p.id);
    wstmts.setPinned.run(JSON.stringify({ tag: "v1.0", asset: ".nightly build.tar", url: "", size: 3, sha256: "e".repeat(64), pinnedAt: 1 }), p.id);
    mkdirSync(builds, { recursive: true });
    writeFileSync(join(builds, "nightly build.tar"), "abc");                // what acquireProgram reads: storeName(".nightly build.tar")
    const r = await call(`/api/v1/plan/${p.id}/check`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ picks: true, item: { status: "ready" } });
  });
});
