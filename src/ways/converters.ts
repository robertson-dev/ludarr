/**
 * ludarr — the converters a make step may name (src/ways/make.ts): each one built once from its own repo at a pinned
 * commit, kept under <config>/ways/converters/<name>/<commit>/ with a converter.json, and self-tested before its first
 * use. The Docker image builds the ones ludarr knows at the same commits (its converters stage), so a server needs no
 * download and no build to use them; when that build is not there, the converter is built here in the build sandbox, as
 * a plan's own source build is (the checkout at the commit, the apt allowlist, its steps as the build user). A converter
 * from another public repo that a plan pins by its commit (a PinnedTool) is built the same way.
 *
 *   zarchive   Exzap/ZArchive @ d2c717730092c7bf8cbb033b12fd4001b7c4d932 (the commit KytyPS5 pins in its
 *              3rdparty/CMakeLists.txt; MIT-0): "zarchive <folder> <file.zar>" packs a game folder into one .zar,
 *              "zarchive <file.zar> <folder>" unpacks one, and an output that is already there is refused. Its self-test
 *              packs a small PS5-shaped folder, reads the .zar back through ludarr's own reader (src/ways/identity.ts),
 *              unpacks it and compares every byte
 *
 * A converter ludarr knows that cannot be built or fails its self-test is this server's trouble (EnvError 'tool' or
 * 'net', src/ways/errors.ts); one a plan pins is the plan's (PlanFault 'convert'). src/ways/validate.ts reads CONVERTER_IDS
 * when it checks a plan, so this module imports nothing heavy at its top: the build and sandbox code is loaded when a
 * converter is first needed.
 */
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { EnvError, PlanFault } from "./errors";
import type { Identity } from "./identity";
import type { SandboxedRun, SandboxedStepOpts } from "./sandbox";
import type { ConverterId, PinnedTool } from "./types";

/** the converters ludarr knows by name */
export const CONVERTER_IDS: ConverterId[] = ["zarchive"];

/** the commit of Exzap/ZArchive KytyPS5 builds its .zar files with (the Dockerfile's converters stage builds the same) */
export const ZARCHIVE_COMMIT = "d2c717730092c7bf8cbb033b12fd4001b7c4d932";
/** where the image keeps the converters it built (the Dockerfile's converters stage): <dir>/<name>/<commit>/<program> */
export const IMAGE_CONVERTERS = "/usr/local/lib/ludarr/converters";

/** a converter ludarr knows by name: its repo, commit, build, the program it runs (the first output), what a step with
 *  it is doing */
export interface KnownConverter {
  id: ConverterId; repo: string; commit: string; apt: string[]; steps: string[]; outputs: string[];
  /** what a make step that runs it is doing, for its progress line */
  doing: string;
}
export const KNOWN_CONVERTERS: Record<ConverterId, KnownConverter> = {
  zarchive: {
    id: "zarchive", repo: "Exzap/ZArchive", commit: ZARCHIVE_COMMIT, apt: ["libzstd-dev"],
    steps: ["cmake -S . -B b -DCMAKE_BUILD_TYPE=Release", "cmake --build b -j{jobs}"], outputs: ["b/zarchive"],
    doing: "packing the game folder",
  },
};
/** the image's own build of a known converter: <IMAGE_CONVERTERS>/<id>/<commit>/<its program's name> */
export const prebuiltOf = (k: KnownConverter): string => join(cvdeps.imageDir(), k.id, k.commit, basename(k.outputs[0]));

/** a built converter: its folder, the program a convert step runs, the commit it was built from, its name ("zarchive", or
 *  the repo of a pinned one), the files it is made of (relative to dir), whether ludarr knows it and whether it passed a
 *  self-test */
export interface Converter { dir: string; exe: string; commit: string; name: string; files: string[]; known: boolean; tested: boolean; doing: string }

/** what converter.json says about a built converter */
interface Kept { name: string; repo: string; commit: string; steps: string[]; outputs: string[]; apt: string[]; from: "image" | "built"; sha256: string; tested: boolean; at: number }

const ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** swapped in tests: where converters are kept, how a repo is fetched and built, how a self-test's program runs, the
 *  reader that reads a .zar back */
export const cvdeps = {
  home: async (): Promise<string> => join((await import("../config")).configDir(), "ways", "converters"),
  /** where the image keeps its own builds (IMAGE_CONVERTERS) */
  imageDir: (): string => IMAGE_CONVERTERS,
  cloneRepo: async (repo: string, ref: string, dest: string, o: { work: string; signal?: AbortSignal; log?: (line: string) => void }) => (await import("./build")).cloneRepo(repo, ref, dest, o),
  /** the packages of `names` that are not installed (apt-get runs only for those: no network for what the image has) */
  aptMissing: async (names: string[]): Promise<string[]> => {
    if (!names.length) return [];
    const { bdeps } = await import("./build");
    const r = await bdeps.rootExec(["dpkg-query", "-W", "-f=${Package} ${db:Status-Status}\\n", "--", ...names], { inheritEnv: false, env: { PATH: process.platform === "win32" ? process.env.PATH ?? "" : ROOT_PATH }, timeoutMs: 30_000, maxOutput: 20_000 }).catch(() => null);
    const installed = new Set((r?.stdout ?? "").split("\n").map(l => l.trim().split(/\s+/)).filter(f => f[1] === "installed").map(f => f[0].split(":")[0]));
    return names.filter(n => !installed.has(n));
  },
  aptInstall: async (names: string[], o: { signal?: AbortSignal; log: (line: string) => void }) => (await import("./build")).aptInstall(names, o),
  runSteps: async (steps: string[], o: { work: string; cwd: string; signal?: AbortSignal; log: (line: string) => void; progress?: (p: number, m: string) => void; what?: string }) => (await import("./build")).runSteps(steps, o),
  handBack: async (dir: string) => (await import("./sandbox")).handTo(dir, "root"),
  /** what the build left running (by its folder and by the job's build user) is stopped before its outputs are taken */
  stopLeft: async (work: string): Promise<number> => (await import("./sandbox")).stopUnder(work),
  /** why an output of the build is not a plain file of its own (a link on the way could point at any file of root's) */
  outputProblem: async (dir: string, rel: string): Promise<string | null> => (await import("./sandbox")).buildFileProblem(dir, rel),
  sandboxOk: async (): Promise<boolean> => (await import("./sandbox")).sandboxOrAllowed(),
  step: async (run: SandboxedRun, o: SandboxedStepOpts) => (await import("./sandbox")).runSandboxedStep(run, o),
  readZar: async (path: string): Promise<Identity | null> => (await import("./identity")).readIdentity(path, "ps5"),
  cores: (): number => cpus().length || 1,
  now: (): number => Date.now(),
  /** how often a build that is running says how long it has taken */
  tickMs: 2000,
};

export interface ConverterOpts {
  signal?: AbortSignal;
  log: (line: string) => void;
  progress?: (p: number, message: string) => void;
  /** the job's scratch folder: a converter is built, and self-tested, as that job's build user in it */
  work?: string;
}

const sha256Of = async (path: string) => new Bun.CryptoHasher("sha256").update(new Uint8Array(await readFile(path))).digest("hex");
const isFile = async (p: string) => !!(await lstat(p).catch(() => null))?.isFile();
const msgOf = (e: unknown) => String((e as { message?: unknown })?.message ?? e);
const repoSlug = (repo: string) => repo.toLowerCase().replace(/^forgejo:/, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 80) || "converter";
/** a known converter's trouble is this server's; a pinned one's is the plan's */
const trouble = (known: boolean, kind: "tool" | "net", msg: string): Error => (known ? new EnvError(kind, msg) : new PlanFault("convert", msg));
const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
/** `fn` with the last thing it said said again every few seconds, with the time it has taken ("… · 1:42"): a build of
 *  minutes never looks stuck */
async function ticking<T>(progress: ConverterOpts["progress"], fn: (tell: (p: number, m: string) => void) => Promise<T>): Promise<T> {
  if (!progress) return fn(() => {});
  const t0 = cvdeps.now();
  let last = { p: 0, m: "" };
  const tell = (p: number, m: string) => { last = { p, m }; progress(p, m); };
  const t = setInterval(() => { if (last.m) progress(last.p, `${last.m} · ${clock(cvdeps.now() - t0)}`); }, cvdeps.tickMs);
  try { return await fn(tell); } finally { clearInterval(t); }
}

function buildInputs(spec: PinnedTool): string {
  return JSON.stringify([spec.repo, spec.commit, spec.steps, spec.outputs, [...(spec.apt ?? [])].sort()]);
}

/** Concurrent jobs share a build only when they requested the same converter recipe. */
const building = new Map<string, Promise<Converter>>();

/**
 * The converter built (once) and ready to run: kept under <config>/ways/converters/ and passed its self-test. From the
 * image's own build when it has this commit, else built in the build sandbox in `work` (a known converter's build that
 * fails is this server's, EnvError; a pinned one's is the plan's, PlanFault 'convert').
 */
export async function ensureConverter(c: ConverterId | PinnedTool, o: ConverterOpts): Promise<Converter> {
  const known = typeof c === "string" ? KNOWN_CONVERTERS[c] ?? null : null;
  if (typeof c === "string" && !known) throw trouble(false, "tool", `${c} is not a converter ludarr knows (${CONVERTER_IDS.join(", ")})`);
  const spec: PinnedTool = known ? { repo: known.repo, commit: known.commit, steps: known.steps, outputs: known.outputs, apt: known.apt } : c as PinnedTool;
  const name = known ? known.id : repoSlug(spec.repo);
  const legacy = join(await cvdeps.home(), name, spec.commit);
  const inputs = buildInputs(spec);
  const key = new Bun.CryptoHasher("sha256").update(inputs).digest("hex");
  const dir = known ? legacy : legacy + "-" + key;
  const ready = await keptConverter(dir, name, known, inputs);
  if (ready) return ready;
  if (!known) {
    const previous = await keptConverter(legacy, name, known, inputs);
    if (previous) return previous;
  }
  const busy = building.get(dir);
  if (busy) {
    o.log(`waiting for the ${name} converter another job is building`);
    return ticking(o.progress, tell => { tell(0.05, `waiting for the ${name} converter another job is building`); return busy; });
  }
  // getting the source, building it and testing it take minutes: what it is doing is said again every few seconds
  const p = ticking(o.progress, tell => makeConverter(dir, name, spec, known, { ...o, progress: o.progress ? tell : undefined }));
  building.set(dir, p);
  try { return await p; } finally { building.delete(dir); }
}

/** a converter kept before and still whole (its program's sha256 as recorded) */
async function keptConverter(dir: string, name: string, known: KnownConverter | null, inputs: string): Promise<Converter | null> {
  let kept: Kept;
  try { kept = JSON.parse(await readFile(join(dir, "converter.json"), "utf8")) as Kept; } catch { return null; }
  if (!Array.isArray(kept?.outputs) || !kept.outputs.length || !Array.isArray(kept.steps)
      || (kept.apt != null && !Array.isArray(kept.apt)) || buildInputs(kept) !== inputs || (known && !kept.tested)) return null;
  for (const out of kept.outputs) if (!(await isFile(join(dir, ...out.split("/"))))) return null;
  const exe = join(dir, ...kept.outputs[0].split("/"));
  if ((await sha256Of(exe).catch(() => "")) !== kept.sha256) return null;
  return { dir, exe, commit: kept.commit, name, files: kept.outputs, known: !!known, tested: kept.tested, doing: known?.doing ?? "converting the game data" };
}

async function makeConverter(dir: string, name: string, spec: PinnedTool, known: KnownConverter | null, o: ConverterOpts): Promise<Converter> {
  if (!o.work) throw trouble(true, "tool", `the ${name} converter is built and tested in a job's scratch folder, and none was given`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const exeRel = spec.outputs[0];
  let from: Kept["from"];
  if (known && (await isFile(prebuiltOf(known)))) {
    // the image built this commit: taken as it is (a copy: <config> is root's alone)
    o.log(`${name}: the image's own build of ${spec.repo} at ${spec.commit.slice(0, 12)}`);
    await mkdir(dirname(join(dir, ...exeRel.split("/"))), { recursive: true });
    await copyFile(prebuiltOf(known), join(dir, ...exeRel.split("/")));
    from = "image";
  } else {
    await buildConverter(dir, name, spec, known, o);
    from = "built";
  }
  const exe = join(dir, ...exeRel.split("/"));
  await chmod(exe, 0o755).catch(() => {});
  const conv: Converter = { dir, exe, commit: spec.commit, name, files: spec.outputs, known: !!known, tested: false, doing: known?.doing ?? "converting the game data" };
  if (known?.id === "zarchive") {
    o.progress?.(0.95, `testing the ${name} converter`);
    try { await zarchiveSelfTest(conv, { ...o, work: o.work }); }
    catch (e) {
      if (e instanceof EnvError || msgOf(e) === "cancelled") throw e;
      throw trouble(true, "tool", `the ${name} converter failed its self-test: ${msgOf(e)}`);
    }
    conv.tested = true;
    o.log(`${name}: self-test passed (packed a folder, read it back, unpacked it, every byte the same)`);
  } else if (!known) o.log(`${name}: built; a converter a plan pins has no self-test here — what it makes is judged by its own bytes`);
  const kept: Kept = { name, repo: spec.repo, commit: spec.commit, steps: spec.steps, outputs: spec.outputs, apt: spec.apt ?? [], from, sha256: await sha256Of(exe), tested: conv.tested, at: Math.floor(cvdeps.now() / 1000) };
  await writeFile(join(dir, "converter.json.part"), JSON.stringify(kept, null, 2));
  await rename(join(dir, "converter.json.part"), join(dir, "converter.json"));
  return conv;
}

/** a converter built from its repo at its commit as the job's build user, its outputs kept in `dir` */
async function buildConverter(dir: string, name: string, spec: PinnedTool, known: KnownConverter | null, o: ConverterOpts & { work?: string }): Promise<void> {
  const work = o.work!;
  if (!(await cvdeps.sandboxOk())) throw trouble(!!known, "tool", `building the ${name} converter needs the build sandbox (ludarr's Docker image)`);
  const src = join(work, "converters", name, "src");
  await rm(src, { recursive: true, force: true });
  await mkdir(dirname(src), { recursive: true });
  o.progress?.(0.05, `getting the ${name} converter's source`);
  try { await cvdeps.cloneRepo(spec.repo, spec.commit, src, { work, signal: o.signal, log: o.log }); }
  catch (e) { if (o.signal?.aborted) throw new Error("cancelled"); throw trouble(!!known, "net", `the ${name} converter's source (${spec.repo} at ${spec.commit.slice(0, 12)}) could not be fetched: ${msgOf(e)}`); }
  const missing = await cvdeps.aptMissing(spec.apt ?? []);
  if (missing.length) {
    o.progress?.(0.15, `installing what the ${name} converter is built with`);
    try { await cvdeps.aptInstall(missing, { signal: o.signal, log: o.log }); }
    catch (e) { throw trouble(!!known, "net", `the packages the ${name} converter is built with could not be installed: ${msgOf(e)}`); }
  }
  const jobs = String(Math.max(1, Math.min(16, cvdeps.cores())));
  try {
    await cvdeps.runSteps(spec.steps.map(s => s.replace(/\{jobs\}/g, jobs)), { work, cwd: src, signal: o.signal, log: o.log, what: "converter", progress: (p, m) => o.progress?.(0.2 + 0.7 * p, `${m} — the ${name} converter`) });
  } catch (e) {
    if (o.signal?.aborted) throw new Error("cancelled");
    throw trouble(!!known, "tool", `the ${name} converter did not build: ${msgOf(e)}`);
  } finally {
    // nothing the build started may still be running (and changing its folder) while its outputs are taken
    await cvdeps.stopLeft(work).catch(() => 0);
    await cvdeps.handBack(src).catch(() => {});
  }
  for (const [i, out] of spec.outputs.entries()) {
    let rel = out;
    // a known converter's program is found by its name when its build put it elsewhere than recorded
    if (!(await isFile(join(src, ...out.split("/")))) && known && i === 0) {
      const hit = await findByName(src, basename(out), 4);
      if (hit) rel = relative(src, hit).split(sep).join("/");
    }
    // taken only as a plain file of the build's own, reached through no link: a link (or a second name) there could be
    // any file of root's, which would then be copied where every build program can read it
    const bad = await cvdeps.outputProblem(src, rel);
    if (bad) throw trouble(!!known, "tool", /^there is no /.test(bad) ? `the ${name} converter's build left no ${out}` : `the ${name} converter's build left ${out} as something ludarr does not take: ${bad}`);
    const to = join(dir, ...out.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(src, ...rel.split("/")), to);
  }
  o.log(`${name}: built from ${spec.repo} at ${spec.commit.slice(0, 12)}`);
}

/** the first regular file called `name` under `dir` (no link followed), at most `depth` folders down */
async function findByName(dir: string, name: string, depth: number): Promise<string | null> {
  for (const n of (await readdir(dir).catch(() => [] as string[])).sort()) {
    const p = join(dir, n);
    const st = await lstat(p).catch(() => null);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isFile() && n === name) return p;
    if (st.isDirectory() && depth > 0 && n !== ".git") { const hit = await findByName(p, name, depth - 1); if (hit) return hit; }
  }
  return null;
}

/* ─────────── the zarchive self-test ─────────── */

/** the files of the folder the self-test packs: a PS5 game folder in small (what Kyty and ludarr's reader look for) */
export function selfTestFolder(): Record<string, Uint8Array> {
  const enc = new TextEncoder();
  const pattern = (n: number, seed: number) => { const b = new Uint8Array(n); let x = seed >>> 0; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
  const blob = new Uint8Array(200 * 1024);
  blob.set(pattern(128 * 1024, 7));                                             // a block that does not compress, then one of zeros
  const param = { titleId: "PPSA99999", contentId: "UP9999-PPSA99999_00-LUDARRSELFTEST00", contentVersion: "01.000.000", applicationCategoryType: 0, attribute: 0, localizedParameters: { defaultLanguage: "en-US", "en-US": { titleName: "ludarr self-test" } } };
  return { "eboot.bin": pattern(40 * 1024, 3), "sce_sys/param.json": enc.encode(JSON.stringify(param, null, 2)), "data/blob.bin": blob };
}
/** a version compared by its numbers ("01.000.000" = "1.0" = "1") */
const versionKey = (v: string | null | undefined) => (v ?? "").split(/[^\d]+/).filter(Boolean).map(n => String(Number(n))).join(".").replace(/(\.0)+$/, "");

/**
 * Pack a small PS5-shaped folder, read the .zar back through ludarr's own reader (it must say PPSA99999 at 1.00, as
 * the folder does), unpack it and compare every byte: the converter does what Kyty expects, and the reader that judges
 * every .zar ludarr makes agrees with it.
 */
async function zarchiveSelfTest(c: Converter, o: ConverterOpts & { work: string }): Promise<void> {
  const t = join(o.work, "converters", "zarchive-test");
  await rm(t, { recursive: true, force: true });
  const files = selfTestFolder();
  for (const [rel, bytes] of Object.entries(files)) {
    const p = join(t, "in", ...rel.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  const tool = join(t, "tool", basename(c.exe));
  await mkdir(dirname(tool), { recursive: true });
  await copyFile(c.exe, tool);
  await chmod(tool, 0o755).catch(() => {});
  const signal = o.signal ?? new AbortController().signal;
  const run = (argv: string[], what: string) => cvdeps.step({ exe: tool, argv, wine: false, timeoutSec: 300 }, {
    exe: tool, cwd: t, fill: { prep: () => t }, work: o.work, signal, log: o.log, phase: "convert", name: { log: `zarchive self-test (${what})`, error: `the zarchive self-test's ${what}` },
  });
  await run(["{prep}/in", "{prep}/test.zar"], "pack");
  const zar = join(t, "test.zar");
  const st = await lstat(zar).catch(() => null);
  if (!st?.isFile() || st.size === 0) throw new Error("packing left no test.zar");
  const id = await cvdeps.readZar(zar).catch(() => null);
  if (!id || id.serial?.toUpperCase() !== "PPSA99999" || versionKey(id.version) !== "1")
    throw new Error(`the .zar it made does not read back as the folder it packed (PPSA99999 at 01.000.000): ludarr's reader says ${id ? `${id.serial ?? "no serial"} at ${id.version ?? "no version"}` : "nothing"}`);
  await run(["{prep}/test.zar", "{prep}/back"], "unpack");
  const back = await listTree(join(t, "back"));
  const want = Object.keys(files).sort();
  if (JSON.stringify(back) !== JSON.stringify(want)) throw new Error(`unpacking gave back ${back.join(", ") || "nothing"}, and the folder held ${want.join(", ")}`);
  for (const rel of want) {
    const got = new Uint8Array(await readFile(join(t, "back", ...rel.split("/"))));
    if (Buffer.compare(Buffer.from(got), Buffer.from(files[rel])) !== 0) throw new Error(`${rel} came back changed`);
  }
  await rm(t, { recursive: true, force: true }).catch(() => {});
}

/** the files under `dir`, relative, sorted (no link followed) */
async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, rel: string) => {
    for (const n of await readdir(p).catch(() => [] as string[])) {
      const full = join(p, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(full).catch(() => null);
      if (st?.isDirectory()) await walk(full, r);
      else if (st?.isFile()) out.push(r);
    }
  };
  await walk(dir, "");
  return out.sort();
}
