/**
 * The converters a make step names (src/ways/converters.ts): zarchive at the commit KytyPS5 pins, taken from the image's
 * own build or built from its repo in the job's folder, self-tested (pack, read back through ludarr's zar reader,
 * unpack, compare) and kept, so the next make builds nothing; a converter a plan pins is built the same way and its
 * failures are the plan's. The real build and the real zarchive run only in the image (the integrator's checks): here the
 * repo, the build and the converter's two commands are fakes through cvdeps.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { CONVERTER_IDS, KNOWN_CONVERTERS, ZARCHIVE_COMMIT, cvdeps, ensureConverter, prebuiltOf, selfTestFolder } from "../src/ways/converters";
import { EnvError, PlanFault, failOf } from "../src/ways/errors";
import type { SandboxedRun, SandboxedStepOpts } from "../src/ways/sandbox";
import type { PinnedTool } from "../src/ways/types";
import { dirLink, ok, tmp } from "./ways-fixtures";

const saved = { ...cvdeps };
afterEach(() => { Object.assign(cvdeps, saved); });

/** the zarchive commands as fakes: "<folder> <file.zar>" packs (here: the files as JSON), "<file.zar> <folder>" unpacks */
function fakeZarchive(o: { flip?: boolean; calls?: string[][] } = {}) {
  const calls = o.calls ?? [];
  cvdeps.step = async (run: SandboxedRun, s: SandboxedStepOpts) => {
    const argv = run.argv.map(a => a.replace(/\{prep\}/g, () => s.fill.prep()));
    calls.push(argv);
    const [from, to] = argv;
    if (from.endsWith(".zar")) {
      const files = JSON.parse(await readFile(from, "utf8")) as Record<string, string>;
      for (const [rel, b64] of Object.entries(files)) {
        const p = join(to, ...rel.split("/"));
        await mkdir(dirname(p), { recursive: true });
        const bytes = Buffer.from(b64, "base64");
        if (o.flip && rel === "data/blob.bin") bytes[5] ^= 1;
        await writeFile(p, bytes);
      }
    } else {
      const files: Record<string, string> = {};
      const walk = async (d: string) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else files[relative(from, p).split(/[\\/]/).join("/")] = (await readFile(p)).toString("base64"); } };
      await walk(from);
      await writeFile(to, JSON.stringify(files));
    }
    return ok();
  };
  // ludarr's reader, as it reads a .zar: sce_sys/param.json's title id and version
  cvdeps.readZar = async path => {
    const files = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    const param = JSON.parse(Buffer.from(files["sce_sys/param.json"], "base64").toString("utf8"));
    return { platform: "ps5", serial: param.titleId, version: param.contentVersion, shape: "zar" };
  };
  return calls;
}
function places() {
  const home = tmp("conv-home-"), image = tmp("conv-image-"), work = join(tmp("conv-work-"), "job-12");
  mkdirSync(work, { recursive: true });
  cvdeps.home = async () => home;
  cvdeps.imageDir = () => image;
  return { home, image, work };
}
const zarchive = (image: string) => { const p = prebuiltOf(KNOWN_CONVERTERS.zarchive); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "the image's zarchive"); return p; };

describe("zarchive, the converter KytyPS5's .zar files are made with", () => {
  test("it is pinned to the commit KytyPS5 builds with, and validate.ts's list names it", () => {
    expect(CONVERTER_IDS).toEqual(["zarchive"]);
    expect(KNOWN_CONVERTERS.zarchive).toMatchObject({ repo: "Exzap/ZArchive", commit: "d2c717730092c7bf8cbb033b12fd4001b7c4d932", apt: ["libzstd-dev"], outputs: ["b/zarchive"] });
    expect(ZARCHIVE_COMMIT).toBe(KNOWN_CONVERTERS.zarchive.commit);
  });

  test("the image's own build is taken, self-tested through the zar reader, and kept: the next make builds and tests nothing", async () => {
    const { home, image, work } = places();
    zarchive(image);
    const calls = fakeZarchive();
    let built = 0;
    cvdeps.cloneRepo = async () => { built++; return { commit: ZARCHIVE_COMMIT, submodules: [] }; };
    const lines: string[] = [];
    const c = await ensureConverter("zarchive", { work, log: l => lines.push(l) });
    expect(c).toMatchObject({ name: "zarchive", commit: ZARCHIVE_COMMIT, known: true, tested: true, doing: "packing the game folder", files: ["b/zarchive"] });
    expect(c.exe).toBe(join(home, "zarchive", ZARCHIVE_COMMIT, "b", "zarchive"));
    expect(readFileSync(c.exe, "utf8")).toBe("the image's zarchive");
    expect(calls.map(a => a.map(x => x.split(/[\\/]/).pop()))).toEqual([["in", "test.zar"], ["test.zar", "back"]]);
    const kept = JSON.parse(readFileSync(join(home, "zarchive", ZARCHIVE_COMMIT, "converter.json"), "utf8"));
    expect(kept).toMatchObject({ from: "image", tested: true, commit: ZARCHIVE_COMMIT });
    expect(lines.join("\n")).toMatch(/self-test passed/);
    expect(built).toBe(0);
    const again = await ensureConverter("zarchive", { work, log: () => {} });
    expect(again.exe).toBe(c.exe);
    expect(calls.length).toBe(2);                                             // kept: nothing ran again
    // a kept program that changed is not trusted: taken and tested again
    writeFileSync(c.exe, "changed");
    await ensureConverter("zarchive", { work, log: () => {} });
    expect(calls.length).toBe(4);
  });

  test("the self-test folder is a PS5 game folder in small: eboot.bin, sce_sys/param.json (PPSA99999 at 01.000.000), and a block that does not compress", () => {
    const f = selfTestFolder();
    expect(Object.keys(f).sort()).toEqual(["data/blob.bin", "eboot.bin", "sce_sys/param.json"]);
    expect(JSON.parse(new TextDecoder().decode(f["sce_sys/param.json"]))).toMatchObject({ titleId: "PPSA99999", contentVersion: "01.000.000" });
    expect(f["data/blob.bin"].length).toBe(200 * 1024);
  });

  test("it fails its self-test when ludarr's zar reader disagrees with what it packed (this server's: EnvError 'tool')", async () => {
    const { image, work } = places();
    zarchive(image);
    fakeZarchive();
    cvdeps.readZar = async () => ({ platform: "ps5", serial: "PPSA00000", version: "01.000.000" });
    const e = await ensureConverter("zarchive", { work, log: () => {} }).catch(x => x);
    expect(e).toBeInstanceOf(EnvError);
    expect(failOf(e)).toEqual({ class: "env", kind: "tool" });
    expect(e.message).toBe("the zarchive converter failed its self-test: the .zar it made does not read back as the folder it packed (PPSA99999 at 01.000.000): ludarr's reader says PPSA00000 at 01.000.000");
    cvdeps.readZar = async () => null;                                         // a reader that reads nothing disagrees too
    expect((await ensureConverter("zarchive", { work, log: () => {} }).catch(x => x)).message).toMatch(/ludarr's reader says nothing$/);
  });

  test("it fails its self-test when what it unpacks is not what it packed", async () => {
    const { image, work } = places();
    zarchive(image);
    fakeZarchive({ flip: true });
    const e = await ensureConverter("zarchive", { work, log: () => {} }).catch(x => x);
    expect(e.message).toBe("the zarchive converter failed its self-test: data/blob.bin came back changed");
  });

  test("without the image's build it is built from its repo at the commit, in the job's folder, as the build user", async () => {
    const { work } = places();
    fakeZarchive();
    const seen: { clone?: string[]; apt?: string[]; steps?: string[]; cwd?: string; back?: string } = {};
    cvdeps.sandboxOk = async () => true;
    cvdeps.cores = () => 4;
    cvdeps.cloneRepo = async (repo, ref, dest) => { seen.clone = [repo, ref, dest]; mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "CMakeLists.txt"), "project(ZArchive)"); return { commit: ref, submodules: [] }; };
    cvdeps.aptMissing = async names => names;
    cvdeps.aptInstall = async names => { seen.apt = names; };
    // the build put its program elsewhere than b/zarchive: found by its name
    cvdeps.runSteps = async (steps, o) => { seen.steps = steps; seen.cwd = o.cwd; mkdirSync(join(o.cwd, "b", "src"), { recursive: true }); writeFileSync(join(o.cwd, "b", "src", "zarchive"), "built"); };
    cvdeps.handBack = async dir => { seen.back = dir; };
    const c = await ensureConverter("zarchive", { work, log: () => {} });
    expect(seen.clone).toEqual(["Exzap/ZArchive", ZARCHIVE_COMMIT, join(work, "converters", "zarchive", "src")]);
    expect(seen.apt).toEqual(["libzstd-dev"]);
    expect(seen.steps).toEqual(["cmake -S . -B b -DCMAKE_BUILD_TYPE=Release", "cmake --build b -j4"]);
    expect([seen.cwd, seen.back]).toEqual([join(work, "converters", "zarchive", "src"), join(work, "converters", "zarchive", "src")]);
    expect(readFileSync(c.exe, "utf8")).toBe("built");
    expect(c.tested).toBe(true);
    expect(JSON.parse(readFileSync(join(c.dir, "converter.json"), "utf8")).from).toBe("built");
  });

  test("a known converter that cannot be fetched or built is this server's trouble; two makes needing it at once build it once", async () => {
    const { work } = places();
    fakeZarchive();
    cvdeps.sandboxOk = async () => true;
    cvdeps.aptMissing = async () => [];
    cvdeps.cloneRepo = async () => { throw new Error("fetching d2c717730092 failed (exit 128): could not resolve host"); };
    const e = await ensureConverter("zarchive", { work, log: () => {} }).catch(x => x);
    expect(failOf(e)).toEqual({ class: "env", kind: "net" });
    let clones = 0;
    cvdeps.cloneRepo = async (_r, ref, dest) => { clones++; await new Promise(r => setTimeout(r, 20)); mkdirSync(dest, { recursive: true }); return { commit: ref, submodules: [] }; };
    cvdeps.runSteps = async (_s, o) => { mkdirSync(join(o.cwd, "b"), { recursive: true }); writeFileSync(join(o.cwd, "b", "zarchive"), "built"); };
    cvdeps.handBack = async () => {};
    const [a, b] = await Promise.all([ensureConverter("zarchive", { work, log: () => {} }), ensureConverter("zarchive", { work, log: () => {} })]);
    expect(a.exe).toBe(b.exe);
    expect(clones).toBe(1);
    const fresh = tmp("conv-home2-");
    cvdeps.home = async () => fresh;                                            // nothing kept yet
    cvdeps.runSteps = async () => { throw new Error("converter step 2 failed (exit 2): zstd.h: No such file or directory"); };
    const failed = await ensureConverter("zarchive", { work: join(tmp("conv-w2-"), "job-13"), log: () => {} }).catch(x => x);
    expect([failOf(failed), failed.message]).toEqual([{ class: "env", kind: "tool" }, "the zarchive converter did not build: converter step 2 failed (exit 2): zstd.h: No such file or directory"]);
    expect(failOf(await ensureConverter("zarchive", { log: () => {} }).catch(x => x))).toEqual({ class: "env", kind: "tool" });   // no job's folder
  });
});

describe("a converter a plan pins", () => {
  const packer: PinnedTool = { repo: "someone/packer", commit: "a".repeat(40), steps: ["make -j{jobs}"], outputs: ["out/packer", "out/packer.dat"], apt: [] };
  test("it is built from its repo at its commit, its outputs kept; it has no self-test: what it makes is judged by its own bytes", async () => {
    const { home, work } = places();
    cvdeps.sandboxOk = async () => true;
    cvdeps.cores = () => 32;
    cvdeps.aptMissing = async () => [];
    const steps: string[][] = [];
    cvdeps.cloneRepo = async (_r, ref, dest) => { mkdirSync(dest, { recursive: true }); return { commit: ref, submodules: [] }; };
    cvdeps.runSteps = async (s, o) => { steps.push(s); mkdirSync(join(o.cwd, "out"), { recursive: true }); writeFileSync(join(o.cwd, "out", "packer"), "p"); writeFileSync(join(o.cwd, "out", "packer.dat"), "d"); };
    cvdeps.handBack = async () => {};
    const lines: string[] = [];
    const c = await ensureConverter(packer, { work, log: l => lines.push(l) });
    expect(c).toMatchObject({ name: "someone-packer", known: false, tested: false, commit: "a".repeat(40) });
    expect(c.exe).toBe(join(c.dir, "out", "packer"));
    expect(c.dir.startsWith(join(home, "someone-packer", packer.commit + "-"))).toBe(true);
    expect(steps).toEqual([["make -j16"]]);                                    // {jobs}: the cores, at most 16
    expect(readFileSync(join(c.dir, "out", "packer.dat"), "utf8")).toBe("d");
    expect(lines.join("\n")).toMatch(/has no self-test here/);
  });
  test("a repaired wrapper gets its helper from a new build at the same upstream commit", async () => {
    const { home, work } = places();
    cvdeps.sandboxOk = async () => true;
    cvdeps.aptMissing = async () => [];
    cvdeps.cloneRepo = async (_repo, ref, dest) => { mkdirSync(dest, { recursive: true }); return { commit: ref, submodules: [] }; };
    cvdeps.handBack = async () => {};
    let builds = 0;
    cvdeps.runSteps = async (_steps, o) => {
      builds++;
      mkdirSync(join(o.cwd, "out"), { recursive: true });
      writeFileSync(join(o.cwd, "out", "packer"), "wrapper");
      writeFileSync(join(o.cwd, "out", "packer.dat"), String(builds));
    };
    const wrapper = { ...packer, outputs: ["out/packer"] };
    const opts = { work, log: () => {} };
    const old = await ensureConverter(wrapper, opts);
    const legacy = join(home, "someone-packer", packer.commit);
    renameSync(old.dir, legacy);
    expect((await ensureConverter(wrapper, opts)).dir).toBe(legacy);
    const [fixed, other] = await Promise.all([ensureConverter(packer, opts), ensureConverter(packer, opts)]);
    expect(other.dir).toBe(fixed.dir);
    expect(fixed.files).toEqual(packer.outputs);
    expect(readFileSync(join(fixed.dir, "out", "packer.dat"), "utf8")).toBe("2");
    const changed = await ensureConverter({ ...packer, steps: ["make release"] }, opts);
    expect(changed.dir).not.toBe(fixed.dir);
    expect((await ensureConverter(packer, opts)).dir).toBe(fixed.dir);
    expect(builds).toBe(3);
  });
  test("its failures are the plan's (PlanFault 'convert'): an output missing, a build that fails", async () => {
    const { work } = places();
    cvdeps.sandboxOk = async () => true;
    cvdeps.aptMissing = async () => [];
    cvdeps.cloneRepo = async (_r, ref, dest) => { mkdirSync(dest, { recursive: true }); return { commit: ref, submodules: [] }; };
    cvdeps.handBack = async () => {};
    cvdeps.runSteps = async () => {};
    const e = await ensureConverter(packer, { work, log: () => {} }).catch(x => x);
    expect(e).toBeInstanceOf(PlanFault);
    expect([failOf(e), e.message]).toEqual([{ class: "plan", phase: "convert" }, "the someone-packer converter's build left no out/packer"]);
    cvdeps.runSteps = async () => { throw new Error("converter step 1 failed (exit 2): no rule to make target"); };
    expect((await ensureConverter(packer, { work, log: () => {} }).catch(x => x)).message).toBe("the someone-packer converter did not build: converter step 1 failed (exit 2): no rule to make target");
  });
});

describe("what a converter's build leaves is taken carefully", () => {
  test("an output reached through a link the build made is never copied (it could be any file of root's): this server's trouble for zarchive, the plan's for a pinned one", async () => {
    const { work } = places();
    fakeZarchive();
    cvdeps.sandboxOk = async () => true;
    cvdeps.aptMissing = async () => [];
    cvdeps.handBack = async () => {};
    let stopped = 0;
    cvdeps.stopLeft = async () => { stopped++; return 0; };
    const rootOnly = tmp("conv-root-only-");
    writeFileSync(join(rootOnly, "zarchive"), "root's own file");
    writeFileSync(join(rootOnly, "packer"), "root's own file");
    cvdeps.cloneRepo = async (_r, ref, dest) => { mkdirSync(dest, { recursive: true }); return { commit: ref, submodules: [] }; };
    cvdeps.runSteps = async (_s, o) => { dirLink(rootOnly, join(o.cwd, "b")); dirLink(rootOnly, join(o.cwd, "out")); };
    const e = await ensureConverter("zarchive", { work, log: () => {} }).catch(x => x);
    expect(failOf(e)).toEqual({ class: "env", kind: "tool" });
    expect(e.message).toBe("the zarchive converter's build left b/zarchive as something ludarr does not take: b is a link, and nothing is taken through one");
    expect(stopped).toBe(1);                                                    // what it left running stopped first
    const packer: PinnedTool = { repo: "someone/packer", commit: "b".repeat(40), steps: ["make"], outputs: ["out/packer"], apt: [] };
    const p = await ensureConverter(packer, { work, log: () => {} }).catch(x => x);
    expect([failOf(p), p.message]).toEqual([{ class: "plan", phase: "convert" }, "the someone-packer converter's build left out/packer as something ludarr does not take: out is a link, and nothing is taken through one"]);
  });

  test("a build that takes minutes keeps saying what it is doing and for how long", async () => {
    const { work } = places();
    fakeZarchive();
    cvdeps.sandboxOk = async () => true;
    cvdeps.aptMissing = async () => [];
    cvdeps.handBack = async () => {};
    cvdeps.stopLeft = async () => 0;
    cvdeps.tickMs = 5;
    cvdeps.cloneRepo = async (_r, ref, dest) => { mkdirSync(dest, { recursive: true }); return { commit: ref, submodules: [] }; };
    cvdeps.runSteps = async (_s, o) => { o.progress?.(0, "building the converter (step 2 of 2)"); await new Promise(r => setTimeout(r, 60)); mkdirSync(join(o.cwd, "b"), { recursive: true }); writeFileSync(join(o.cwd, "b", "zarchive"), "built"); };
    const said: string[] = [];
    await ensureConverter("zarchive", { work, log: () => {}, progress: (_p, m) => said.push(m) });
    expect(said).toContain("building the converter (step 2 of 2) — the zarchive converter");
    expect(said.some(m => /^building the converter \(step 2 of 2\) — the zarchive converter · \d+:\d\d$/.test(m))).toBe(true);
  });
});

describe("the image", () => {
  test("its converters stage builds ZArchive at the same commit, and the runtime keeps it where ludarr looks", async () => {
    const df = await Bun.file("Dockerfile").text();
    expect(df).toMatch(new RegExp(`ARG ZARCHIVE_COMMIT=${ZARCHIVE_COMMIT}`));
    expect(df).toMatch(/FROM oven\/bun:1 AS converters/);
    expect(df).toMatch(/https:\/\/github\.com\/Exzap\/ZArchive\.git/);
    expect(df).toMatch(/\/out\/zarchive\/\$ZARCHIVE_COMMIT\/zarchive/);
    expect(df).toMatch(/COPY --from=converters \/out\/ \/usr\/local\/lib\/ludarr\/converters\//);
    const runtime = df.slice(df.lastIndexOf("\nFROM "));
    for (const pkg of ["zstd", "libzstd-dev", "mesa-vulkan-drivers", "libvulkan1", "libgl1-mesa-dri", "libglx-mesa0", "mesa-utils", "vulkan-tools"]) expect(runtime).toMatch(new RegExp(`\\s${pkg}(\\s|$)`));
  });
});
