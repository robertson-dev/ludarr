/**
 * What a build job makes is the plan's only while the plan asks for it (review 2: build-1 … build-4, admin-ui-10): a
 * build per game is kept by its recipe as well as its commit and file; a build job pins and readies a plan only while the
 * plan still says what the job read, and the plan's program, tools and repo wait while one runs; a source build of a
 * commit gives players no hash as its version; a path with '$' in it reaches a build step as it is; a per-game build shows
 * on its way (the only thing that stops the way while it is queued or running), and a second one is refused, as is one
 * asked for while the way itself is being built.
 *
 * The fakes are round trips: `tar -cf` (run as ludarr) writes the artifact folder as JSON and `7z x` (run in the sandbox)
 * makes exactly those files again, so a package's exe says which recipe built it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import type { ExecOpts, ExecResult } from "../src/process/tools";
import { ndeps } from "../src/net/public-url";
import { sbdeps } from "../src/ways/sandbox";
import { buildsDir } from "../src/ways/program";
import { bdeps, runSteps } from "../src/ways/build";
import { constructApi } from "../src/ways/construct-api";
import { waysApi } from "../src/ways/api";
import { getPlan, insertContent, insertPlan, insertWay, planPinned, planSpec, updatePlan, updateWay, wstmts, type PlanRow } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import type { PlanKind, RuntimePlanSpec } from "../src/ways/types";
import { restoreDeps, sha1, sha256, tempConfig, tmp, tools7z } from "./ways-fixtures";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const no = (stderr: string, code = 2): ExecResult => ({ code, stdout: "", stderr, timedOut: false });

let steps: string[] = [];
/** a step that waits until the test lets it go on (a build held mid-way) */
let gate: { entered: () => void; wait: Promise<void> } | null = null;

function filesOf(dir: string, base = dir, out: Record<string, string> = {}) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) filesOf(p, base, out);
    else out[relative(base, p).split("\\").join("/")] = readFileSync(p).toString("base64");
  }
  return out;
}

/** git, the build steps and 7z as the sandbox's exec sees them on a dev box (the command as it is) */
async function sandboxFake(c: string[], opts: ExecOpts): Promise<ExecResult> {
  if (c[0] === "git") {
    let i = 1;
    while (c[i] === "-c") i += 2;
    let dir: string | null = null;
    if (c[i] === "-C") { dir = c[i + 1]; i += 2; }
    const sub = c[i];
    const checkout = (d: string) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "Makefile"), "all:\n"); };
    if (sub === "clone") { checkout(c[c.length - 1]); return ok(); }
    if (sub === "init") { mkdirSync(join(c[c.length - 1], ".git"), { recursive: true }); return ok(); }
    if (sub === "remote") return ok();
    if (sub === "fetch") { writeFileSync(join(dir!, ".git", "FETCHED"), c[c.length - 1]); return ok(); }
    if (sub === "checkout") { checkout(dir!); return ok(); }
    if (sub === "rev-parse") { const f = join(dir!, ".git", "FETCHED"); return ok(`${existsSync(f) ? readFileSync(f, "utf8") : COMMIT}\n`); }
    if (sub === "config") return no("", 1);
    if (sub === "submodule") return ok();
    return no(`unknown git ${sub}`);
  }
  if (c[0] === "bash" && c[1] === "-c") {
    const cmd = c[2], cwd = opts.cwd!;
    steps.push(cmd);
    if (gate) { const g = gate; gate = null; g.entered(); await g.wait; }
    // per game: make BASEROM='<path>' VARIANT=x → build/pc/sm64.exe, made from the game file at that path
    let m = /^make BASEROM='([^']*)' VARIANT=(\w+)$/.exec(cmd);
    if (m) {
      if (!existsSync(m[1])) return no(`make: *** No rule to make target '${m[1]}'.  Stop.`);
      mkdirSync(join(cwd, "build", "pc"), { recursive: true });
      writeFileSync(join(cwd, "build", "pc", "sm64.exe"), `sm64 built with VARIANT=${m[2]}`.padEnd(9000, "."));
      return ok();
    }
    // a shared build: build VARIANT=x → dist/Game.exe
    m = /^build VARIANT=(\w+)$/.exec(cmd);
    if (m) {
      mkdirSync(join(cwd, "dist"), { recursive: true });
      writeFileSync(join(cwd, "dist", "Game.exe"), `Game built with VARIANT=${m[1]}`.padEnd(6000, "."));
      return ok();
    }
    return no(`bash: no such step: ${cmd}`);
  }
  if (c[0] === "7z" && c[1] === "x") {
    const out = c.find(a => a.startsWith("-o"))!.slice(2), archive = c[c.length - 1];
    let files: Record<string, string>;
    try { files = JSON.parse(readFileSync(archive, "utf8")).files; } catch { return no(`cannot open ${archive}`); }
    for (const [rel, b64] of Object.entries(files)) { const p = join(out, ...rel.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, Buffer.from(b64, "base64")); }
    return ok("Everything is Ok");
  }
  return no(`unknown ${c[0]}`, 127);
}

let cfg: ReturnType<typeof tempConfig>;
const savedB = { ...bdeps };
beforeAll(() => { cfg = tempConfig(); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  steps = []; gate = null;
  pdeps.log = () => {};
  pdeps.tools = () => tools7z;
  sbdeps.platform = () => "win32";                      // a dev box: the command runs as it is…
  process.env.LUDARR_ALLOW_UNSANDBOXED = "1";           // …which the owner allowed
  sbdeps.exec = (cmd, opts = {}) => sandboxFake(cmd, opts);
  ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
  bdeps.aptUpdated = false;
  bdeps.rootExec = async cmd => {
    if (cmd[0] === "apt-get") return ok();
    if (cmd[0] === "tar") { writeFileSync(cmd[cmd.indexOf("-cf") + 1], JSON.stringify({ files: filesOf(cmd[cmd.indexOf("-C") + 1]) })); return ok(); }
    return no(`unknown ${cmd[0]}`, 127);
  };
});
afterEach(() => { restoreDeps(); Object.assign(bdeps, savedB); delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

let seq = 0;
const game = (name: string): GameRow => upsertGame({ steam_appid: 773_000 + ++seq, name, slug: `guards-${seq}` }) as GameRow;
function plan(name: string, spec: RuntimePlanSpec, kind: PlanKind = "port", repo = "someone/srcport"): PlanRow {
  const v = validatePlanSpec(spec, kind);
  if (!v.ok) throw new Error(`the test plan does not validate: ${v.errors.join("; ")}`);
  return insertPlan({ name, kind, repo, platforms: ["pc"], spec: v.value!, status: "draft" });
}
const ROM = new Uint8Array(16 * 1024).fill(7);
const perGame = (variant: string, ref = "v1.0"): RuntimePlanSpec => ({
  program: { kind: "source", ref, steps: [`make BASEROM={content} VARIANT=${variant}`], artifact: "build/pc", content: "build" },
  launch: { exe: "sm64.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "Super Mario 64, US", search: ["Super Mario 64"], accept: { hashes: [{ algo: "sha1", value: sha1(ROM) }] }, normalize: null, place: "baserom.us.z64", ship: false },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
});
const shared = (variant: string, ref = "v1.0", over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "source", ref, steps: [`build VARIANT=${variant}`], artifact: "dist", content: "none" },
  launch: { exe: "Game.exe", argv: [] }, content: null, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...over,
});
const req = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function runFrom(res: Response): Promise<JobRow> {
  const b = await res.json() as any;
  expect([res.status, b.error ?? null]).toEqual([202, null]);
  await runJob(b.job.id);
  return stmts.jobById.get(b.job.id) as JobRow;
}
const exeOf = (gameId: number, exe: string) => readFileSync(join((stmts.packageForGame.get(gameId) as PackageRow).path, exe), "utf8").replace(/\.+$/, "");
/** a game with its verified ROM kept in a content store folder, and a way of `p` that uses it */
function gameWithRom(p: PlanRow, name: string) {
  const g = game(name);
  const store = join(tmp("guards-root-"), ".ahoy-content", g.slug!);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "sm64.z64"), ROM);
  const file = insertContent({ gameId: g.id, platform: "n64", name: "sm64.z64", path: join(store, "sm64.z64"), size: ROM.byteLength, hashes: { sha1: sha1(ROM), sha256: sha256(ROM) }, source: "upload" });
  const w = updateWay(insertWay({ gameId: g.id, planId: p.id }).id, { contentId: file.id })!;
  return { g, store, file, w };
}
const wayView = async (gameId: number) => ((await (await req(waysApi, "GET", `/api/v1/game/${gameId}/ways`)).json()) as any).items[0];

/* ─────────── build-1 ─────────── */

describe("a build per game is kept by its recipe too", () => {
  test("after its steps change, the same game file is built again with the new steps, and the old recipe's build goes", async () => {
    const p = plan("sm64ex", perGame("one"));                                     // ref v1.0: a fixed tag, the same commit every time
    const { g, store, w } = gameWithRom(p, "Super Mario 64");
    expect((await runFrom(await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: w.id }))).state).toBe("done");
    expect(steps).toEqual([expect.stringMatching(/VARIANT=one$/)]);
    expect((await runFrom(await req(waysApi, "POST", `/api/v1/way/${w.id}/build`, {}))).state).toBe("done");
    expect(exeOf(g.id, "sm64.exe")).toBe("sm64 built with VARIANT=one");
    const first = readdirSync(join(store, ".builds"));
    expect(first).toEqual([expect.stringMatching(new RegExp(`^sm64ex-${COMMIT.slice(0, 12)}-[0-9a-f]{8}-${sha1(ROM).slice(0, 12)}\\.tar$`))]);

    // the admin changes a build flag: the pin goes, the plan is a draft; its first build for this game is due again
    expect((await req(waysApi, "PUT", `/api/v1/plan/${p.id}`, { spec: perGame("two") })).status).toBe(200);
    expect(getPlan(p.id)).toMatchObject({ status: "draft", pinned_json: null });
    steps = [];
    const again = await runFrom(await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: w.id }));
    expect(again.state).toBe("done");
    expect(steps).toEqual([expect.stringMatching(/VARIANT=two$/)]);              // built, not taken from the old recipe's tar
    expect(getPlan(p.id)!.status).toBe("ready");
    expect((await runFrom(await req(waysApi, "POST", `/api/v1/way/${w.id}/build`, {}))).state).toBe("done");
    expect(exeOf(g.id, "sm64.exe")).toBe("sm64 built with VARIANT=two");
    // one kept build for the file: the new recipe's
    const now = readdirSync(join(store, ".builds"));
    expect(now.length).toBe(1);
    expect(now[0]).not.toBe(first[0]);
  });

  test("a build kept under a name from before recipes were in it is never taken, and goes once the file is built again", async () => {
    const p = plan("sm64ex old", perGame("two"));
    const { g, store, w } = gameWithRom(p, "Super Mario 64 old");
    mkdirSync(join(store, ".builds"), { recursive: true });
    const old = `sm64ex-old-${COMMIT.slice(0, 12)}-${sha1(ROM).slice(0, 12)}.tar`;
    writeFileSync(join(store, ".builds", old), JSON.stringify({ files: { "sm64.exe": Buffer.from("sm64 built with VARIANT=zero".padEnd(9000, ".")).toString("base64") } }));
    // another plan's build for the same file is not this plan's to remove
    const theirs = `sm64ex-old-2-${COMMIT.slice(0, 12)}-abcdef01-${sha1(ROM).slice(0, 12)}.tar`;
    writeFileSync(join(store, ".builds", theirs), "{}");
    expect((await runFrom(await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: w.id }))).state).toBe("done");
    expect(steps).toEqual([expect.stringMatching(/VARIANT=two$/)]);
    expect((await runFrom(await req(waysApi, "POST", `/api/v1/way/${w.id}/build`, {}))).state).toBe("done");
    expect(exeOf(g.id, "sm64.exe")).toBe("sm64 built with VARIANT=two");
    const left = readdirSync(join(store, ".builds"));
    expect(left).not.toContain(old);
    expect(left).toContain(theirs);
    expect(left.length).toBe(2);
  });
});

/* ─────────── build-2 ─────────── */

/** a build job of the plan, held in its first step until `go()` */
async function heldBuild(p: PlanRow, body: unknown = {}) {
  let entered!: () => void, release!: () => void;
  const inStep = new Promise<void>(r => { entered = r; });
  gate = { entered: () => entered(), wait: new Promise<void>(r => { release = r; }) };
  const res = await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, body);
  expect(res.status).toBe(202);
  const id = (await res.json() as any).job.id as number;
  const running = runJob(id);
  await inStep;
  return { id, go: async () => { release(); await running; return stmts.jobById.get(id) as JobRow; } };
}

describe("a build job and the plan it builds", () => {
  test("while it runs, the plan's program, tools and repo stay as they are (409); other fields can change", async () => {
    const p = plan("Src Port", shared("one"));
    const b = await heldBuild(p);
    const program = await req(waysApi, "PUT", `/api/v1/plan/${p.id}`, { spec: shared("two") });
    expect(program.status).toBe(409);
    expect((await program.json() as any).error).toBe("a build of this plan is queued or running: change its program, tools or repo once it ends");
    expect((await req(waysApi, "PUT", `/api/v1/plan/${p.id}`, { repo: "someone/fork" })).status).toBe(409);
    expect((await req(waysApi, "PUT", `/api/v1/plan/${p.id}`, { spec: shared("one", "v1.0", { tools: { ref: "{tag}", steps: ["make tools"], outputs: ["tools/x"] } }) })).status).toBe(409);
    expect((await req(waysApi, "PUT", `/api/v1/plan/${p.id}`, { name: "Src Port renamed" })).status).toBe(200);
    expect((await b.go()).state).toBe("done");
    expect(getPlan(p.id)).toMatchObject({ status: "ready", name: "Src Port renamed" });
    expect(planSpec(getPlan(p.id)!).program).toMatchObject({ steps: ["build VARIANT=one"] });
  });

  test("an edit made during the build (not the program): what it built is pinned, the plan stays a draft until it is checked", async () => {
    const p = plan("Src Port Edited", shared("one"));
    const b = await heldBuild(p);
    expect((await req(waysApi, "PUT", `/api/v1/plan/${p.id}`, { spec: shared("one", "v1.0", { keep: ["saves/**"] }) })).status).toBe(200);
    const j = await b.go();
    expect(j.state).toBe("done");
    expect(j.message).toMatch(/the plan was edited during the build: check it/);
    const after = getPlan(p.id)!;
    expect(after.status).toBe("draft");
    expect(planPinned(after)).toMatchObject({ tag: `v1.0@${COMMIT}`, asset: "src-port-edited-0123456.tar" });
    // the pin is the build's own (its file was written under the pin's name): a check makes the plan ready, and it builds
    expect(((await (await req(waysApi, "POST", `/api/v1/plan/${p.id}/check`)).json()) as any).item.status).toBe("ready");
    const g = game("Src Edited Game");
    const w = insertWay({ gameId: g.id, planId: p.id, status: "ready" });
    expect((await runFrom(await req(waysApi, "POST", `/api/v1/way/${w.id}/build`, {}))).state).toBe("done");
    expect(exeOf(g.id, "Game.exe")).toBe("Game built with VARIANT=one");
  });

  test("a program saved meanwhile by another job is not overwritten: the build is neither kept nor pinned, the plan not made ready", async () => {
    const p = plan("Src Port Replaced", shared("one"));
    const b = await heldBuild(p);
    // what a construct job's save does to the plan while this build runs (PUT is refused, but a save is not a PUT)
    updatePlan(p.id, { spec: validatePlanSpec(shared("two"), "port").value! });
    const j = await b.go();
    expect(j.state).toBe("done");
    expect(j.message).toMatch(/not kept; the plan's program, tools or repo changed during the build, so what it built is not the plan's/);
    expect(getPlan(p.id)).toMatchObject({ status: "draft", pinned_json: null });
    expect(existsSync(join(buildsDir(), "src-port-replaced-0123456.tar"))).toBe(false);
  });

  test("a build per game: an edit of its steps meanwhile leaves the plan unpinned and a draft", async () => {
    const p = plan("sm64ex edited", perGame("one"));
    const { w } = gameWithRom(p, "Super Mario 64 edited");
    const b = await heldBuild(p, { wayId: w.id });
    updatePlan(p.id, { spec: validatePlanSpec(perGame("two"), "port").value! });
    const j = await b.go();
    expect(j.state).toBe("done");
    expect(j.message).toMatch(/what it built is not the plan's/);
    expect(getPlan(p.id)).toMatchObject({ status: "draft", pinned_json: null });
  });
});

/* ─────────── build-3 ─────────── */

describe("the version players see", () => {
  const REF = "3a7f9c2e8b1d4f6a0c5e7b9d1f3a5c7e9b0d2f4a";                             // a commit, starting with a digit
  test("a source build of a commit has no version (never the hash); one of a tag has the tag", async () => {
    const byCommit = plan("Commit Port", shared("one", REF));
    expect((await runFrom(await req(constructApi, "POST", `/api/v1/plan/${byCommit.id}/build`, {}))).state).toBe("done");
    expect(planPinned(getPlan(byCommit.id)!)!.tag).toBe(`${REF}@${REF}`);
    const g = game("Commit Game");
    const w = insertWay({ gameId: g.id, planId: byCommit.id, status: "ready" });
    expect((await runFrom(await req(waysApi, "POST", `/api/v1/way/${w.id}/build`, {}))).state).toBe("done");
    const pkg = stmts.packageForGame.get(g.id) as PackageRow;
    expect(JSON.parse(pkg.manifest_json).version).toBeNull();
    expect(pkg.version).toBeNull();
    expect(pkg.manifest_json).not.toContain(REF);

    const byTag = plan("Tag Port", shared("one", "v2.3.1"));
    expect((await runFrom(await req(constructApi, "POST", `/api/v1/plan/${byTag.id}/build`, {}))).state).toBe("done");
    const g2 = game("Tag Game");
    const w2 = insertWay({ gameId: g2.id, planId: byTag.id, status: "ready" });
    expect((await runFrom(await req(waysApi, "POST", `/api/v1/way/${w2.id}/build`, {}))).state).toBe("done");
    expect(JSON.parse((stmts.packageForGame.get(g2.id) as PackageRow).manifest_json).version).toBe("2.3.1");
  });
});

/* ─────────── build-4 ─────────── */

describe("a build step's {content}", () => {
  test("the game file's path goes in as it is: '$&', '$$' and \"$'\" in it are no replacement patterns", async () => {
    const seen: string[] = [];
    sbdeps.exec = async c => { if (c[0] === "bash") seen.push(c[2]); return ok(); };
    const work = tmp("guards-steps-");
    for (const path of ["/srv/games$&x/c/sm64.z64", "/srv/games$$x/c/sm64.z64", "/srv/g$'x/c/sm64.z64", "/srv/g$`x/c/sm64.z64"]) {
      seen.length = 0;
      await runSteps(["make BASEROM={content} VARIANT=one"], { work, cwd: work, content: path, log: () => {} });
      expect(seen).toEqual([`make BASEROM='${path.replace(/'/g, `'\\''`)}' VARIANT=one`]);     // single-quoted for bash, as it was
    }
    await expect(runSteps(["make BASEROM={content}"], { work, cwd: work, content: null, log: () => {} })).rejects.toThrow(/needs the game file, and there is none here/);
  });
});

/* ─────────── admin-ui-10 ─────────── */

describe("a plan built once per game, on its ways", () => {
  test("its blocker asks for the first build only while no commit is pinned; once one is, the draft is checked like any other", async () => {
    const p = plan("sm64ex blockers", perGame("one"));
    const { g } = gameWithRom(p, "Super Mario 64 blockers");
    expect((await wayView(g.id)).blockers.map((b: { error: string }) => b.error)).toContain("the plan builds from source with each game's own file: build it from source for this game first");
    wstmts.setPinned.run(JSON.stringify({ tag: `v1.0@${COMMIT}`, asset: `${p.slug}-per-game`, url: "build:per-game", size: 0, sha256: "", pinnedAt: 1 }), p.id);
    const errors = (await wayView(g.id)).blockers.map((b: { error: string }) => b.error);
    expect(errors).toContain("the plan has not been checked yet: check it first");
    expect(errors.join(" ")).not.toContain("build it from source for this game first");
  });

  test("the way's first build shows on the way while it is queued, and the same build is refused a second time; another game's may wait", async () => {
    const p = plan("sm64ex twice", perGame("one"));
    const a = gameWithRom(p, "Super Mario 64 A"), b = gameWithRom(p, "Super Mario 64 B");
    const first = await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: a.w.id });
    expect(first.status).toBe(202);
    const job = (await first.json() as any).job;
    const view = await wayView(a.g.id);
    expect(view.job).toMatchObject({ id: job.id, kind: "build", state: "queued" });
    expect(view.blockers).toContainEqual({ code: "building", error: "its program is being built for this game" });
    expect(view.canBuild).toBe(false);
    const again = await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: a.w.id });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "a build of this plan is already queued or running", job: { id: job.id } });
    // the other game's way of the same plan: its own build, queued behind (the runner takes one build of a plan at a time)
    expect((await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: b.w.id })).status).toBe(202);
    expect((await wayView(b.g.id)).job).toMatchObject({ kind: "build", state: "queued" });
    // once it ran, the way shows no job and the plan is ready
    await runJob(job.id);
    const done = await wayView(a.g.id);
    expect(done.job).toBeNull();
    expect(getPlan(p.id)!.status).toBe("ready");
  });

  test("while the way's first build is queued or running, that build is all that stops the way: nothing asks for it again", async () => {
    const p = plan("sm64ex waiting", perGame("one"));
    const { g, w } = gameWithRom(p, "Super Mario 64 waiting");
    const first = "the plan builds from source with each game's own file: build it from source for this game first";
    expect((await wayView(g.id)).blockers).toEqual([{ code: "plan", error: first }]);
    const building = [{ code: "building", error: "its program is being built for this game" }];
    const queued = await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: w.id });
    expect(queued.status).toBe(202);
    const id = (await queued.json() as any).job.id as number;
    expect(await wayView(g.id)).toMatchObject({ job: { id, state: "queued" }, blockers: building, canBuild: false });
    // cancelled before it ran: the first build is asked for again
    expect((await req(waysApi, "POST", `/api/v1/jobs/${id}/cancel`)).status).toBe(200);
    expect(await wayView(g.id)).toMatchObject({ job: null, blockers: [{ code: "plan", error: first }] });
    const b = await heldBuild(p, { wayId: w.id });
    expect(await wayView(g.id)).toMatchObject({ job: { id: b.id, state: "running" }, blockers: building, canBuild: false });
    expect((await b.go()).state).toBe("done");
    expect(await wayView(g.id)).toMatchObject({ job: null, blockers: [], canBuild: true });
  });

  test("the way's own build queued: its program's build for that game waits (409 with the way's job), and the way's waits for that", async () => {
    const p = plan("sm64ex both", perGame("one"));
    const { g, w } = gameWithRom(p, "Super Mario 64 both");
    expect((await runFrom(await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: w.id }))).state).toBe("done");
    const asm = await req(waysApi, "POST", `/api/v1/way/${w.id}/build`, {});
    expect(asm.status).toBe(202);
    const job = (await asm.json() as any).job;
    const again = await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: w.id });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "the way is being built", job: { id: job.id, kind: "assemble" } });
    expect(stmts.jobsByKind.all("build").length).toBe(1);                         // only the first build: none was queued
    await runJob(job.id);
    expect(stmts.packageForGame.get(g.id)).toBeTruthy();
    // the way built: its program's build for the game can be asked for again, and while it is queued the way's waits
    const rebuild = await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, { wayId: w.id });
    expect(rebuild.status).toBe(202);
    const refused = await req(waysApi, "POST", `/api/v1/way/${w.id}/build`, {});
    expect(refused.status).toBe(409);
    expect((await refused.json() as any).blockers).toEqual([{ code: "building", error: "its program is being built for this game" }]);
  });

  test("a plan built once for all its ways: one build at a time", async () => {
    const p = plan("Src Port Once", shared("one"));
    const first = await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, {});
    expect(first.status).toBe(202);
    const again = await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, {});
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toBe("a build of this plan is already queued or running");
    await runJob((await first.json() as any).job.id);
    expect((await req(constructApi, "POST", `/api/v1/plan/${p.id}/build`, {})).status).toBe(202);
  });
});
