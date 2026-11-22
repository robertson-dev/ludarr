import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { enqueueJob } from "../src/process/kinds";
import { runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import type { CallModel, ContentBlock, ModelRequest } from "../src/process/agent";
import type { ExecOpts, ExecResult } from "../src/process/tools";
import { ndeps } from "../src/net/public-url";
import { sbdeps } from "../src/ways/sandbox";
import { buildsDir, prdeps, toolsDir } from "../src/ways/program";
import { aptAllowed, bdeps, cloneRepo, keepTools, recipeKey, toolsRefs, wayBuildNeeded } from "../src/ways/build";
import { cxdeps } from "../src/ways/construct";
import { constructApi } from "../src/ways/construct-api";
import { waysApi } from "../src/ways/api";
import { getPlan, getWay, insertContent, insertPlan, insertWay, planPinned, planSpec, updateWay, wstmts, type PlanRow } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import type { PlanKind, ProgramSource, RuntimePlanSpec } from "../src/ways/types";
import { bytes, fake7z, ok, restoreDeps, sha1, sha256, tempConfig, tmp, tools7z } from "./ways-fixtures";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr, timedOut: false });

/** git and the build steps as the sandbox runs them (a dev box: the command as it is), on a checkout made of `files` */
function fakeBuild(o: { files?: (dir: string) => void; steps?: (cmd: string, cwd: string) => boolean; gitmodules?: string; calls: string[][] }) {
  return (c: string[], opts: ExecOpts): ExecResult | null => {
    if (c[0] === "git") {
      o.calls.push(c);
      let i = 1;
      while (c[i] === "-c") i += 2;
      let dir: string | null = null;
      if (c[i] === "-C") { dir = c[i + 1]; i += 2; }
      const sub = c[i];
      if (sub === "clone") { const dest = c[c.length - 1]; mkdirSync(dest, { recursive: true }); o.files?.(dest); if (o.gitmodules) writeFileSync(join(dest, ".gitmodules"), "[submodule]"); return ok(); }
      if (sub === "init") { mkdirSync(join(c[c.length - 1], ".git"), { recursive: true }); return ok(); }
      if (sub === "remote" || sub === "fetch") return ok();
      if (sub === "checkout") { o.files?.(dir!); if (o.gitmodules) writeFileSync(join(dir!, ".gitmodules"), "[submodule]"); return ok(); }
      if (sub === "rev-parse") return ok(`${COMMIT}\n`);
      if (sub === "config") return o.gitmodules ? ok(o.gitmodules) : fail("", 1);
      if (sub === "submodule") return ok();
      return fail(`unknown git ${sub}`);
    }
    if (c[0] === "bash" && c[1] === "-c") { o.calls.push(c); return o.steps?.(c[2], opts.cwd!) ? ok() : fail(`no such step: ${c[2]}`, 2); }
    return null;
  };
}

let cfg: ReturnType<typeof tempConfig>;
let calls: string[][];
let root: string[][];
let layouts: Record<string, (out: string) => void>;
let builder: ReturnType<typeof fakeBuild> | null;
const savedCx = { ...cxdeps }, savedB = { ...bdeps };
beforeAll(() => { cfg = tempConfig(); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  calls = []; root = []; layouts = {}; builder = null;
  pdeps.log = () => {};
  pdeps.tools = () => tools7z;
  sbdeps.platform = () => "win32";
  sbdeps.exec = fake7z(new Proxy({}, { get: (_t, k: string) => layouts[k] }) as Record<string, (out: string) => void>, { other: (c, opts) => builder?.(c, opts) ?? null });
  ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
  bdeps.aptUpdated = false;
  bdeps.rootExec = async cmd => {
    root.push(cmd);
    if (cmd[0] === "apt-get") return ok();
    if (cmd[0] === "tar") { const dest = cmd[cmd.indexOf("-cf") + 1], from = cmd[cmd.indexOf("-C") + 1]; writeFileSync(dest, `TAR of ${readdirSync(from).sort().join(",")}`); return ok(); }
    return fail(`unknown ${cmd[0]}`, 127);
  };
  process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
});
afterEach(() => { restoreDeps(); Object.assign(cxdeps, savedCx); Object.assign(bdeps, savedB); delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

const plain = (over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "source", ref: "v1.0", steps: ["cmake -B build", "cmake --build build && cp build/Game.exe dist/"], artifact: "dist", apt: ["libsdl2-dev"], content: "none" },
  launch: { exe: "Game.exe", argv: [] }, content: null, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...over,
});
function plan(name: string, spec: RuntimePlanSpec, kind: PlanKind = "port", o: { status?: "draft" | "ready"; repo?: string } = {}): PlanRow {
  const v = validatePlanSpec(spec, kind);
  if (!v.ok) throw new Error(`the test plan does not validate: ${v.errors.join("; ")}`);
  return insertPlan({ name, kind, repo: o.repo ?? "someone/srcport", platforms: ["pc"], spec: v.value!, status: o.status ?? "draft" });
}
const sourceSteps = (cmd: string, cwd: string) => {
  if (cmd === "cmake -B build") { mkdirSync(join(cwd, "build"), { recursive: true }); writeFileSync(join(cwd, "build", "Game.exe"), bytes(5000, 1)); return true; }
  if (cmd === "cmake --build build && cp build/Game.exe dist/") { mkdirSync(join(cwd, "dist", "data"), { recursive: true }); writeFileSync(join(cwd, "dist", "Game.exe"), readFileSync(join(cwd, "build", "Game.exe"))); writeFileSync(join(cwd, "dist", "data", "a.pak"), "pak"); return true; }
  return false;
};
async function run(j: JobRow): Promise<JobRow> { await runJob(j.id); return stmts.jobById.get(j.id) as JobRow; }
const post = (path: string, body: unknown = {}) => constructApi.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let seq = 0;
const game = (name: string): GameRow => upsertGame({ steam_appid: 982_000 + ++seq, name, slug: `build-${seq}` }) as GameRow;

describe("the build job", () => {
  test("a source plan: a checkout at its ref, its packages from the allowlist, its steps, the artifact packed and pinned; the plan is ready and its way builds from it", async () => {
    builder = fakeBuild({ calls, files: d => writeFileSync(join(d, "CMakeLists.txt"), "project(x)"), steps: sourceSteps });
    const p = plan("Src Port", plain());
    const res = await post(`/api/v1/plan/${p.id}/build`);
    expect(res.status).toBe(202);
    const j = await run(stmts.jobById.get((await res.json() as any).job.id) as JobRow);
    expect(j.state).toBe("done");
    // a second build: apt-get update does not run again in the same container
    const again = await run(stmts.jobById.get((await (await post(`/api/v1/plan/${p.id}/build`)).json() as any).job.id) as JobRow);
    expect(again.state).toBe("done");
    expect(j.message).toMatch(/^built src-port-0123456\.tar \(0\.0 MB\) at v1\.0$/);
    const pinned = planPinned(getPlan(p.id)!)!;
    const tar = join(buildsDir(), "src-port-0123456.tar");
    expect(readFileSync(tar, "utf8")).toBe("TAR of Game.exe,data");
    expect(pinned).toMatchObject({ tag: `v1.0@${COMMIT}`, asset: "src-port-0123456.tar", url: "build:src-port-0123456.tar", size: readFileSync(tar).byteLength, sha256: sha256(readFileSync(tar)) });
    expect(getPlan(p.id)).toMatchObject({ status: "ready", status_note: null });
    // the clone went to the plan's ref; apt-get update ran once for both builds; tar as ludarr, from the artifact folder
    const clones = calls.filter(c => c[0] === "git" && c.includes("clone"));
    expect(clones[0]).toEqual(expect.arrayContaining(["--depth", "1", "--branch", "v1.0", "--", "https://github.com/someone/srcport.git"]));
    expect(clones[0]).toEqual(expect.arrayContaining(["protocol.allow=never", "protocol.https.allow=always", "http.followRedirects=false"]));
    expect(root.filter(c => c[0] === "apt-get" && c.includes("update")).length).toBe(1);
    expect(root).toContainEqual(["apt-get", "-o", "DPkg::Lock::Timeout=300", "install", "-y", "--no-install-recommends", "--", "libsdl2-dev"]);
    expect(root.find(c => c[0] === "tar")).toEqual(expect.arrayContaining(["--format=posix", "--numeric-owner"]));
    // W2a's check calls a built source plan ready; assembly takes the program from the build, and players see the ref only
    const check = await waysApi.request(`/api/v1/plan/${p.id}/check`, { method: "POST" });
    expect((await check.json() as any).item.status).toBe("ready");
    layouts["src-port-0123456.tar"] = out => { mkdirSync(join(out, "data"), { recursive: true }); writeFileSync(join(out, "Game.exe"), bytes(5000, 1)); writeFileSync(join(out, "data", "a.pak"), "pak"); };
    const g = game("Source Game");
    const w = insertWay({ gameId: g.id, planId: p.id, status: "ready" });
    const asm = await run(enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id }));
    expect(asm.state).toBe("done");
    const pkg = stmts.packageForGame.get(g.id) as PackageRow;
    const m = JSON.parse(pkg.manifest_json);
    expect(m).toMatchObject({ kind: "port", version: "1.0", launch: { exe: "Game.exe" } });
    expect(pkg.manifest_json).not.toContain(COMMIT);
  });

  test("the allowlist: Debian -dev packages and the named build tools, nothing else; a plan asking for more is not built", async () => {
    for (const name of ["libsdl2-dev", "build-essential", "pkg-config", "cmake", "ninja-build", "meson", "zlib1g-dev", "python3-pip", "python3-venv", "libsdl2-net-2.0-0", "libglew-dev", "libglew2.2", "libpng-dev", "nlohmann-json3-dev", "libespeak-ng-dev"])
      expect([name, aptAllowed(name)]).toEqual([name, true]);
    for (const name of ["curl", "sudo", "openssh-server", "wine", "-dev", "libfoo-dev=1.2", "../evil-dev", "foo-dev/unstable", "Libfoo-dev", "python3", "netcat-openbsd", "docker.io", "a"])
      expect([name, aptAllowed(name)]).toEqual([name, false]);
    const p = plan("Asks Too Much", plain({ program: { kind: "source", ref: "v1.0", steps: ["make"], artifact: "dist", apt: ["libsdl2-dev", "curl", "sudo"], content: "none" } }));
    const res = await post(`/api/v1/plan/${p.id}/build`);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toMatch(/^curl, sudo are not on the build allowlist \(Debian -dev packages/);
    builder = fakeBuild({ calls, steps: sourceSteps });
    const j = await run(enqueueJob({ kind: "build", planId: p.id }));
    expect(j).toMatchObject({ state: "failed", message: expect.stringMatching(/curl, sudo are not on the build allowlist/) });
    expect(root).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("the route says when there is nothing to build, a plan builds per game, or there is no sandbox", async () => {
    const rel = plan("Release Plan", plain({ program: { kind: "release", assetPattern: "x\\.zip$", channel: "stable" } }));
    expect((await post(`/api/v1/plan/${rel.id}/build`)).status).toBe(409);
    expect((await (await post(`/api/v1/plan/${rel.id}/build`)).json() as any).error).toMatch(/nothing to build/);
    const perGame = plan("Per Game", perGameSpec(), "port");
    expect((await (await post(`/api/v1/plan/${perGame.id}/build`)).json() as any).error).toMatch(/built once per game, with its game file: build one of its ways/);
    delete process.env.LUDARR_ALLOW_UNSANDBOXED;
    const src = plan("No Sandbox", plain());
    const r = await post(`/api/v1/plan/${src.id}/build`);
    expect(r.status).toBe(409);
    expect((await r.json() as any).error).toBe("building from source needs the build sandbox (ludarr's Docker image)");
    expect((await post("/api/v1/plan/999999/build")).status).toBe(404);
  });

  test("tools: built at the program's pinned tag and kept where assembly finds them (tools.json {ref, commit})", async () => {
    builder = fakeBuild({ calls, files: d => writeFileSync(join(d, "Makefile"), "all:"), steps: (cmd, cwd) => { if (cmd !== "make -C tools") return false; mkdirSync(join(cwd, "tools"), { recursive: true }); writeFileSync(join(cwd, "tools", "extract"), "#!/bin/sh"); return true; } });
    const p = plan("With Tools", plain({ program: { kind: "release", assetPattern: "^SoH-.*-Win64[.]zip$", channel: "stable" }, tools: { ref: "{tag}", steps: ["make -C tools"], outputs: ["tools/extract"] } }), "port", { repo: "HarbourMasters/Shipwright" });
    wstmts.setPinned.run(JSON.stringify({ tag: "9.3.1", asset: "SoH-9.3.1-Win64.zip", url: "https://x/SoH.zip", size: 1, sha256: "a".repeat(64), pinnedAt: 1 }), p.id);
    const j = await run(enqueueJob({ kind: "build", planId: p.id }));
    expect(j).toMatchObject({ state: "done", message: "tools built at 9.3.1" });
    expect(calls.find(c => c.includes("clone"))).toEqual(expect.arrayContaining(["--branch", "9.3.1", "https://github.com/HarbourMasters/Shipwright.git"]));
    const dir = join(toolsDir(), "with-tools", COMMIT);
    expect(readFileSync(join(dir, "tools", "extract"), "utf8")).toBe("#!/bin/sh");
    expect(JSON.parse(readFileSync(join(dir, "tools.json"), "utf8"))).toMatchObject({ ref: "9.3.1", commit: COMMIT, outputs: ["tools/extract"] });
    // a source program's tag is '<ref>@<commit>': its tools are cloned at that commit and looked up by the tag
    expect(toolsRefs({ ref: "{tag}", steps: ["x"], outputs: ["y"] }, `main@${COMMIT}`)).toEqual({ clone: COMMIT, lookup: `main@${COMMIT}` });
    expect(toolsRefs({ ref: "v2", steps: ["x"], outputs: ["y"] }, "9.3.1")).toEqual({ clone: "v2", lookup: "v2" });
  });
});

describe("keeping a plan's tools", () => {
  test("an output that is a link to a file the build did not make is refused, not copied (a planted link to a root secret)", async () => {
    const built = tmp("tools-built-");
    const secret = join(tmp("tools-secret-"), "importers.json");
    writeFileSync(secret, '{"key":"s3cret"}');
    mkdirSync(join(built, "tools"), { recursive: true });
    // the build plants a hard link (nlink > 1) at its declared output, pointing at a root-only file outside the build
    linkSync(secret, join(built, "tools", "extract"));
    const p = insertPlan({ name: "Linky Tools", kind: "port", repo: "a/b", platforms: ["switch"], spec: validatePlanSpec(plain(), "port").value!, status: "ready" });
    await expect(keepTools(p, { dir: built, commit: COMMIT, src: built }, "9.3.1", ["tools/extract"])).rejects.toThrow(/tools\/extract has more than one name \(a hard link\)|tools\/extract is a link/);
    expect(existsSync(join(toolsDir(), "linky-tools", COMMIT, "tools", "extract"))).toBe(false);   // the secret was not copied out
  });
});

describe("cloning", () => {
  test("every submodule address is checked before git fetches it: https to a public host only; a relative one is resolved against the repo", async () => {
    const work = tmp("clone-work-");
    const at = (gitmodules: string) => { calls = []; builder = fakeBuild({ calls, gitmodules }); return cloneRepo("someone/srcport", "v1.0", join(work, "src"), { work }); };
    expect((await at("submodule.rt.url ../N64ModernRuntime.git\nsubmodule.rt.path lib/rt\n")).submodules).toEqual(["lib/rt"]);
    expect(calls.some(c => c.includes("submodule") && c.includes("update"))).toBe(true);
    await expect(at("submodule.x.url http://github.com/a/b.git\nsubmodule.x.path x\n")).rejects.toThrow(/only https addresses are cloned/);
    await expect(at("submodule.x.url file:///etc/passwd\nsubmodule.x.path x\n")).rejects.toThrow(/only https addresses are cloned/);
    await expect(at("submodule.x.url https://192.168.1.20/a/b.git\nsubmodule.x.path x\n")).rejects.toThrow(/a submodule's address is refused: 192\.168\.1\.20 is not a public address/);
    await expect(at("submodule.x.url https://github.com/a/b.git\nsubmodule.x.path ../../escape\n")).rejects.toThrow(/its path may not hold/);
    // nothing was updated for a refused one
    expect(calls.some(c => c.includes("submodule") && c.includes("update"))).toBe(false);
    ndeps.lookup = async () => [{ address: "10.0.0.2", family: 4 }];
    await expect(cloneRepo("forgejo:git.internal.example/a/b", null, join(work, "src2"), { work })).rejects.toThrow(/the repo's address is refused/);
    await expect(cloneRepo("someone/srcport", "--upload-pack=evil", join(work, "src3"), { work })).rejects.toThrow(/is not a tag, branch or commit/);
  });
});

/* ─────────── a build per way ─────────── */

const ROM = bytes(16 * 1024, 5);
function perGameSpec(): RuntimePlanSpec {
  return {
    program: { kind: "source", ref: "master", steps: ["make BASEROM={content}"], artifact: "build/pc", content: "build" },
    launch: { exe: "sm64.exe", argv: [] },
    content: { kind: "rom", platform: "n64", what: "Super Mario 64, US", search: ["Super Mario 64"], accept: { hashes: [{ algo: "sha1", value: sha1(ROM) }] }, normalize: "n64-z64", place: "baserom.us.z64", ship: false },
    files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
  };
}
/** the recipe part of a per-game build's kept name, from the plan as stored */
const keyOf = (p: PlanRow) => recipeKey(planSpec(getPlan(p.id)!).program as Extract<ProgramSource, { kind: "source" }>);

describe("a plan built once per game", () => {
  test("the build job builds it with the way's verified file and keeps it beside the file (never in the shared builds); assembly only takes the kept build", async () => {
    let made = 0;
    builder = fakeBuild({ calls, files: d => writeFileSync(join(d, "Makefile"), "all:"), steps: (cmd, cwd) => {
      const m = /^make BASEROM='(.+)'$/.exec(cmd);
      if (!m || !existsSync(m[1]) || readFileSync(m[1]).byteLength !== ROM.byteLength) return false;     // the build reads the game file, handed over read-only
      made++;
      mkdirSync(join(cwd, "build", "pc"), { recursive: true });
      writeFileSync(join(cwd, "build", "pc", "sm64.exe"), bytes(9000, 2));
      return true;
    } });
    const p = plan("sm64ex", perGameSpec(), "port", { status: "ready", repo: "sm64pc/sm64ex" });
    wstmts.setPinned.run(JSON.stringify({ tag: `master@${COMMIT}`, asset: "sm64ex-per-game", url: "build:per-game", size: 0, sha256: "", pinnedAt: 1 }), p.id);
    // W2a's check keeps such a plan ready: its commit is pinned
    expect((await (await waysApi.request(`/api/v1/plan/${p.id}/check`, { method: "POST" })).json() as any).item.status).toBe("ready");
    const g = game("Super Mario 64");
    const store = join(tmp("build-root-"), ".ahoy-content", "super-mario-64");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "Super Mario 64 (USA).z64"), ROM);
    const file = insertContent({ gameId: g.id, platform: "n64", name: "Super Mario 64 (USA).z64", path: join(store, "Super Mario 64 (USA).z64"), size: ROM.byteLength, hashes: { sha1: sha1(ROM), sha256: sha256(ROM) }, source: "upload" });
    const w = updateWay(insertWay({ gameId: g.id, planId: p.id, status: "ready" }).id, { contentId: file.id })!;
    // an assemble never builds the program itself (that can take hours in the ways lane): none kept → NeedsBuild, and the
    // carry run or the Build route queues the build job instead
    expect(wayBuildNeeded(getPlan(p.id)!, getWay(w.id)!)).toBe(true);
    const early = await run(enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id }));
    expect(early).toMatchObject({ state: "failed", message: "its program has to be built for this game first (a build job does that, then the way is built)" });
    expect(JSON.parse(early.fail_json!)).toEqual({ class: "other", kind: "needs-build" });
    expect(made).toBe(0);
    expect(getWay(w.id)).toMatchObject({ status: "ready", status_note: early.message });
    // the build job (its own lane), which queues the way's assemble when it is done
    const b = await run(enqueueJob({ kind: "build", planId: p.id, wayId: w.id, then: "assemble" }, { gameId: g.id }));
    expect(b.state).toBe("done");
    expect(made).toBe(1);
    // the pinned commit was checked out, not whatever master is now
    expect(calls.some(c => c[0] === "git" && c.includes("fetch") && c.includes(COMMIT))).toBe(true);
    // kept by its commit, its recipe and its file
    const keptName = `sm64ex-${COMMIT.slice(0, 12)}-${keyOf(p)}-${sha1(ROM).slice(0, 12)}.tar`;
    const kept = join(store, ".builds", keptName);
    expect(existsSync(kept)).toBe(true);
    expect((existsSync(buildsDir()) ? readdirSync(buildsDir()) : []).filter(n => n.startsWith("sm64ex"))).toEqual([]);
    expect(wayBuildNeeded(getPlan(p.id)!, getWay(w.id)!)).toBe(false);
    const next = (stmts.jobsByKind.all("assemble") as JobRow[]).find(j => j.state === "queued" && JSON.parse(j.spec_json!).wayId === w.id)!;
    expect(JSON.parse(next.spec_json!)).toEqual({ kind: "assemble", wayId: w.id, auto: false, runId: null });
    layouts[keptName] = out => { writeFileSync(join(out, "sm64.exe"), bytes(9000, 2)); };
    calls.length = 0;
    const first = await run(next);
    expect(first.state).toBe("done");
    expect(calls.filter(c => c[0] === "git" || c[0] === "bash")).toEqual([]);         // the kept build, unpacked: nothing built
    const pkg = stmts.packageForGame.get(g.id) as PackageRow;
    const m = JSON.parse(pkg.manifest_json);
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(["sm64.exe"]);                         // the ROM is in the build, not the package
    expect(m.version).toBe("master");
    // the second build of the same commit and file takes the kept build too: no checkout, no build steps
    calls.length = 0;
    const second = await run(enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id }));
    expect(second.state).toBe("done");
    expect(made).toBe(1);
    expect(calls.filter(c => c[0] === "git" || c[0] === "bash")).toEqual([]);
    expect(getWay(w.id)).toMatchObject({ status: "built" });
  });

  test("a per-game plan written by hand (no commit pinned) becomes ready once the build job has built it for one of its ways", async () => {
    builder = fakeBuild({ calls, steps: (cmd, cwd) => { if (!cmd.startsWith("make BASEROM=")) return false; mkdirSync(join(cwd, "build", "pc"), { recursive: true }); writeFileSync(join(cwd, "build", "pc", "sm64.exe"), bytes(10)); return true; } });
    const p = plan("sm64ex by hand", perGameSpec(), "port", { repo: "sm64pc/sm64ex" });
    // the check readies it once it validates: its first build is per game, and a draft plan's way is never searched for
    expect((await (await waysApi.request(`/api/v1/plan/${p.id}/check`, { method: "POST" })).json() as any).item.status).toBe("ready");
    const g = game("Super Mario 64 again");
    const store = join(tmp("build-root-"), ".ahoy-content", "sm64-again");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "sm64.z64"), ROM);
    const file = insertContent({ gameId: g.id, platform: "n64", name: "sm64.z64", path: join(store, "sm64.z64"), size: ROM.byteLength, hashes: { sha1: sha1(ROM), sha256: sha256(ROM) }, source: "upload" });
    const w = updateWay(insertWay({ gameId: g.id, planId: p.id }).id, { contentId: file.id })!;
    expect((await post(`/api/v1/plan/${p.id}/build`)).status).toBe(409);                      // which game's file? it needs the way
    const res = await post(`/api/v1/plan/${p.id}/build`, { wayId: w.id });
    expect(res.status).toBe(202);
    const j = await run(stmts.jobById.get((await res.json() as any).job.id) as JobRow);
    expect(j.state).toBe("done");
    expect(j.message).toMatch(/built for Super Mario 64 again .*kept beside its game file/);
    const after = getPlan(p.id)!;
    expect(after.status).toBe("ready");
    expect(planPinned(after)).toMatchObject({ tag: `master@${COMMIT}`, url: "build:per-game" });
    expect(readdirSync(join(store, ".builds"))).toEqual([`sm64ex-by-hand-${COMMIT.slice(0, 12)}-${keyOf(p)}-${sha1(ROM).slice(0, 12)}.tar`]);
    expect((await (await waysApi.request(`/api/v1/plan/${p.id}/check`, { method: "POST" })).json() as any).item.status).toBe("ready");
  });
});

/* ─────────── a construct job that builds from source ─────────── */

describe("the construct agent and a source plan", () => {
  test("try_plan builds it in its dry run; the finished plan keeps that build in the shared builds, pinned '<ref>@<commit>', ready", async () => {
    builder = fakeBuild({ calls, files: d => writeFileSync(join(d, "CMakeLists.txt"), "project(x)"), steps: sourceSteps });
    cxdeps.ai = () => ({ key: "sk", base: "https://api.anthropic.com", model: "m", maxTurns: 6, maxMinutes: 5 });
    const spec = plain();
    let n = 0;
    const turns: ContentBlock[][] = [
      [{ type: "tool_use", id: "a", name: "try_plan", input: { kind: "port", spec } }],
      [{ type: "tool_use", id: "b", name: "finish", input: { ok: true, kind: "port", name: "Src Port", platforms: ["pc"], spec, summary: "built from source", lesson: { recognize: "cmake, no releases", steps: ["cmake -B build"] } } }],
    ];
    const seen: ModelRequest[] = [];
    pdeps.callModel = (async (req: ModelRequest) => { seen.push(JSON.parse(JSON.stringify(req))); return { content: turns[n++] ?? [], stop_reason: "tool_use" }; }) as CallModel;
    const j = await run(enqueueJob({ kind: "construct", repo: "someone/srcport" }));
    expect(j.state).toBe("done");
    expect(JSON.stringify(seen[1].messages.at(-1))).toMatch(/try_plan #1: PASS[\s\S]*program: built at 0123456789ab/);
    const p = getPlan(JSON.parse(j.manifest_json!).planId)!;
    expect(p).toMatchObject({ status: "ready", author: "ai" });
    expect(planPinned(p)).toMatchObject({ tag: `v1.0@${COMMIT}`, asset: "src-port-0123456.tar" });
    expect(readFileSync(join(buildsDir(), "src-port-0123456.tar"), "utf8")).toBe("TAR of Game.exe,data");
  });
});
