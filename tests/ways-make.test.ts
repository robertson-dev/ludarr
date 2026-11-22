/**
 * Making a way's game file (src/ways/make.ts): Demon's Souls' app0 folder (or a RAR of it) packed into one .zar by the
 * KytyPS5 way's recorded recipe — judged before any step (sealed, the identity, the whole game), handed over read-only,
 * made with a fake converter, the product judged by its own identity and kept as a 'made' row the way takes; the same
 * data never made twice; every failure typed. The readers (B2a), the store's ingest (B2b) and the converter's build are
 * fakes through mkdeps; the archivers and the converter run through the sandbox's exec, faked too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { enqueueJob, jobKinds, type KindContext } from "../src/process/kinds";
import { pdeps } from "../src/process/deps";
import { EnvError, NeedsFiles, PlanFault, failOf } from "../src/ways/errors";
import type { Identity } from "../src/ways/identity";
import { MakeRefused, canonicalJson, dropProvisional, madeFor, makeDry, makeKey, mkdeps, runMake, sfoBytes, toolsOf, volumesOf, type MakeInputRef } from "../src/ways/make";
import { getContent, getWay, insertContent, insertPlan, insertWay, type ContentRow, type PlanRow, type WayRow } from "../src/ways/store";
import { sbdeps, sweepSpareWork } from "../src/ways/sandbox";
import type { ContentPlan, InputDescription, JobSpec, MakeInput } from "../src/ways/types";
import { validatePlanSpec, validateWayContent } from "../src/ways/validate";
import { ok, restoreDeps, sha1, sha256, tmp, tools7z } from "./ways-fixtures";
import type { ExecOpts, ExecResult } from "../src/process/tools";
import type { Verdict } from "../src/ways/match";
import { copyFactsOf } from "./fakes-w3";

const DEMONS_SOULS = ["PPSA01340", "PPSA01341", "PPSA01342"], VERSIONS = ["01.005.000", "01.007.000"];
const KYTY = "chenxiao07/KytyPS5", KYTY_AT = "65ed19d996d4f0c4fc46305194a3dde27e36e39c";
const kytyPlan = (): any => ({
  program: { kind: "release", assetPattern: "^KytyPS5-v\\d+[.]zip$", channel: "stable" },
  launch: { exe: "KytyLauncher.exe", argv: ["--play"] },
  content: { kind: "disc", platform: "ps5", what: "a PS5 game packed from its app0 folder (.zar)", search: ["any"], accept: { hashes: [], formats: ["zar"] }, place: "game/{name}" },
  files: [], setup: [], needs: [], keep: ["user/**"], seed: [], firstRun: null, notes: "",
});
/** the Kyty recipe: the app0 folder, as it is or out of an archive, packed into one .zar with zarchive */
const kytyMake = (o: Record<string, unknown> = {}): any => ({
  from: ["kept", "copy", "inbox", "indexer"],
  input: { shape: "either", platform: "ps5", formats: ["rar", "7z", "zip"], marker: "sce_sys/param.json", also: ["eboot.bin"], serials: [...DEMONS_SOULS], versions: [...VERSIONS], category: "game", ...o },
  steps: [
    { unpack: { to: "x" } },
    { pick: { within: "{prep}/x", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } },
    { convert: { with: "zarchive", argv: ["{prep}/app0", "{out}"], timeoutSec: 7200 } },
  ],
  output: { shape: "file", name: "{serial}-app0.zar" },
});
const kytyContent = (make: any = kytyMake()): any => ({
  kind: "disc", platform: "ps5", what: "Demon's Souls (PlayStation 5)", search: ["Demon's Souls"], terms: ["PPSA01341"],
  accept: { hashes: [], formats: ["zar"], serials: [...DEMONS_SOULS], versions: [...VERSIONS], category: "game", evidence: [{ repo: KYTY, commit: KYTY_AT, path: "src/graphics/host_gpu/renderer/demonsSouls.h", lines: [13, 19], values: [...DEMONS_SOULS, ...VERSIONS] }] },
  place: "game/{name}", make,
});
const param = (serial = "PPSA01341", version = "01.007.000", patch = false) => JSON.stringify({ titleId: serial, contentId: `EP9000-${serial}_00-DEMONSSOULS00000`, contentVersion: version, ...(patch ? { originContentVersion: "01.000.000" } : {}), applicationCategoryType: 0 });
/** an app0 folder as a PS5 dumper writes it */
function app0(dir: string, o: { serial?: string; version?: string; patch?: boolean; files?: number } = {}) {
  mkdirSync(join(dir, "sce_sys"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "eboot.bin"), "ELF".padEnd(4096, "e"));
  writeFileSync(join(dir, "sce_sys", "param.json"), param(o.serial, o.version, o.patch));
  for (let i = 0; i < (o.files ?? 3); i++) writeFileSync(join(dir, "data", `chunk-${i}.bin`), String(i).repeat(2000));
  return dir;
}
const idOf = (p: string): Identity | null => {
  try { const j = JSON.parse(readFileSync(p, "utf8")); return { platform: "ps5", serial: j.titleId, version: j.contentVersion, category: j.originContentVersion ? "patch" : "game", shape: "folder" }; } catch { return null; }
};
const vkey = (v: string) => v.split(".").map(n => String(Number(n))).join(".").replace(/(\.0)+$/, "");
/** match.ts's inputMatches as B2a builds it, in small: shape, the identity's serial, version and category */
function fakeInputMatches(input: MakeInput, f: { shape?: string; identity?: Identity | null }): Verdict {
  if (input.shape !== "either" && f.shape && input.shape !== f.shape) return { ok: false, why: `a ${f.shape}, and this takes a ${input.shape}` };
  const id = f.identity;
  if (!id) return { ok: true, why: null, unchecked: "nothing read yet" };
  if (id.category && id.category !== (input.category ?? "game")) return { ok: false, why: `a ${id.category}, not the game` };
  if (input.serials?.length && id.serial && !input.serials.includes(id.serial)) return { ok: false, why: `another game (its serial is ${id.serial})` };
  if (input.versions?.length && id.version && !input.versions.some(v => vkey(v) === vkey(id.version!))) return { ok: false, why: `version ${id.version}, and this takes ${input.versions.join(" or ")}` };
  return { ok: true, why: null, serial: id.serial };
}

let seq = 0, root = "", conv = "", made: string[] = [], queued: JobSpec[] = [], execs: string[][] = [];
let exec: (cmd: string[], opts: ExecOpts) => ExecResult | Promise<ExecResult> = () => ok();
const savedMk = { ...mkdeps };

beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  root = tmp("make-root-");
  made = []; queued = []; execs = [];
  process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
  sbdeps.platform = () => "win32";                                            // a dev box: the programs are the fakes below
  sbdeps.exec = async (cmd, opts = {}) => { execs.push(cmd); return exec(cmd, opts); };
  pdeps.tools = () => ({ ...tools7z, unrar: "unrar", sevenZip: "7z", bash: "bash" });
  pdeps.log = () => {};
  exec = zarchive();
  // the converter as built: a program in a folder of its own
  conv = tmp("make-conv-");
  writeFileSync(join(conv, "zarchive"), "zarchive");
  mkdeps.ensureConverter = async () => ({ dir: conv, exe: join(conv, "zarchive"), commit: "d2c717730092c7bf8cbb033b12fd4001b7c4d932", name: "zarchive", files: ["zarchive"], known: true, tested: true, doing: "packing the game folder" });
  mkdeps.describeInput = async (path: string): Promise<InputDescription> => {
    const st = statSync(path);
    if (st.isDirectory()) return { shape: "folder", format: "folder", size: 0, identity: idOf(join(path, "sce_sys", "param.json")), sealed: false, markers: existsSync(join(path, "sce_sys", "param.json")) ? ["sce_sys/param.json"] : [], members: null, listing: "fs", why: null };
    return { shape: "file", format: path.split(".").pop() ?? "", size: st.size, identity: null, sealed: false, markers: [], members: null, listing: "7z", why: null };
  };
  mkdeps.readFolderIdentity = async dir => idOf(join(dir, "sce_sys", "param.json"));
  mkdeps.readIdentity = async path => (path.endsWith(".zar") ? JSON.parse(readFileSync(path, "utf8")).identity : null);
  mkdeps.inputMatches = fakeInputMatches;
  mkdeps.completeness = async () => ({ ok: true, why: null, files: 0, bytes: 0 });
  mkdeps.diskSpace = async () => ({ free: 4e12, total: 8e12 });
  mkdeps.keepFreeBytes = () => 50e9;
  mkdeps.enqueueJob = ((spec: JobSpec) => { queued.push(spec); return {} as JobRow; }) as typeof mkdeps.enqueueJob;
  mkdeps.wayBuildNeeded = () => false;
  mkdeps.tickMs = 5;
  // the store's ingest (B2b): renamed into the game's store folder, hashed, kept with its MadeInfo
  mkdeps.ingestMade = async (path, t, o) => {
    if (t.role !== "game") throw new Error("a game file");
    const dir = join(root, ".ahoy-content", t.game.slug ?? "game");
    mkdirSync(dir, { recursive: true });
    const to = join(dir, basename(path));
    renameSync(path, to);
    const bytes = readFileSync(to);
    o.progress?.(bytes.length, bytes.length);
    made.push(o.made.key);
    const row = insertContent({ gameId: t.game.id, platform: "ps5", name: basename(to), path: to, size: bytes.length, hashes: { sha1: sha1(bytes), sha256: sha256(bytes) }, source: "made", identity: JSON.parse(bytes.toString("utf8")).identity, made: o.made, shape: "file" });
    return { row, duplicate: false };
  };
});
afterEach(() => { restoreDeps(); Object.assign(mkdeps, savedMk); delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

/** the converter as a fake: "zarchive <folder> <file.zar>" writes the folder's listing (and the identity its param.json
 *  says) as the .zar, a little at a time */
function zarchive(o: { exit?: number; slow?: boolean; also?: (cmd: string[]) => void } = {}) {
  return async (cmd: string[], opts: ExecOpts): Promise<ExecResult> => {
    if (basename(cmd[0]) === "zarchive") {
      o.also?.(cmd);
      if (o.exit) return { code: o.exit, stdout: "", stderr: "reading\nzstd: error 11\nbad block", timedOut: false };
      const [from, to] = cmd.slice(1);
      const files = listAll(from);
      const out = JSON.stringify({ identity: idOf(join(from, "sce_sys", "param.json")) && { ...idOf(join(from, "sce_sys", "param.json")), shape: "zar" }, files });
      mkdirSync(dirname(to), { recursive: true });
      if (o.slow) for (let i = 0; i < out.length; i += Math.ceil(out.length / 6)) { appendFileSync(to, out.slice(i, i + Math.ceil(out.length / 6))); await Bun.sleep(15); }
      else writeFileSync(to, out);
      return ok("packed");
    }
    if (cmd[0] === "unrar" && cmd[1] === "x") {                               // unrar x -y -o+ -p- <in> <dest>/
      const dest = cmd[cmd.length - 1].replace(/[\\/]$/, "");
      app0(join(dest, "PPSA01341-app0"));
      return ok("All OK");
    }
    return ok();
  };
}
const listAll = (dir: string): string[] => { const out: string[] = []; const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push(relative(dir, p).split(/[\\/]/).join("/")); } }; walk(dir); return out.sort(); };

/** a game, the KytyPS5 plan and the game's way with the make recipe */
function kyty(make: any = kytyMake()): { game: GameRow; plan: PlanRow; way: WayRow; content: ContentPlan } {
  seq++;
  const game = upsertGame({ steam_appid: 998000 + seq, name: `Demon's Souls ${seq}`, slug: `demons-souls-${seq}` }) as GameRow;
  const spec = validatePlanSpec(kytyPlan(), "emulator");
  if (!spec.ok) throw new Error(spec.errors.join("; "));
  const plan = insertPlan({ name: `KytyPS5 ${seq}`, kind: "emulator", repo: KYTY, platforms: ["ps5"], spec: spec.value!, status: "ready" });
  const c = validateWayContent(kytyContent(make), "emulator");
  if (!c.ok) throw new Error(c.errors.join("; "));
  const way = insertWay({ gameId: game.id, planId: plan.id, content: c.value!, status: "needs-files" });
  return { game, plan, way, content: c.value! };
}
/** a folder (or file) kept for the game, as the inbox's intake leaves it */
function kept(gameId: number, path: string, o: { shape?: "file" | "folder"; identity?: Identity | null } = {}): ContentRow {
  const shape = o.shape ?? (statSync(path).isDirectory() ? "folder" : "file");
  const size = shape === "file" ? statSync(path).size : listAll(path).reduce((a, r) => a + statSync(join(path, r)).size, 0);
  return insertContent({ gameId, platform: "ps5", name: basename(path), path, size, hashes: { sha1: sha1(path), sha256: sha256(path) }, source: "inbox", shape, identity: o.identity ?? null });
}
interface Ctx extends KindContext { lines: string[]; messages: string[] }
function ctxFor(spec: JobSpec, gameId: number, o: { transcript?: string } = {}): Ctx {
  const job = enqueueJob(spec, { gameId });
  const row = { ...(stmts.jobById.get(job.id) as JobRow), transcript: o.transcript ?? "" };
  const work = join(root, ".work", `job-${job.id}`);
  mkdirSync(join(work, "staging"), { recursive: true });
  const lines: string[] = [], messages: string[] = [];
  return { job: row, spec, work, staging: join(work, "staging"), log: l => lines.push(l), progress: (_p, m) => { if (m) messages.push(m); }, signal: new AbortController().signal, lines, messages };
}
const runJobKind = (ctx: KindContext) => jobKinds.get("make")!.run(ctx);
const zarCalls = () => execs.filter(c => basename(c[0]) === "zarchive");

describe("the make job", () => {
  test("a kept app0 folder is packed into one .zar, judged by its own identity, kept as a 'made' row the way takes; the build is queued", async () => {
    const k = kyty();
    const folder = app0(join(tmp("make-inbox-"), "PPSA01341-app0"));
    const input = kept(k.game.id, folder);
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id, then: "assemble", auto: true, runId: 7 }, k.game.id);
    const r = await runJobKind(ctx);
    expect(r.message).toMatch(/^made PPSA01341-app0\.zar \(\d+\.\d GB\); the build is queued$/);
    const way = getWay(k.way.id)!;
    const product = getContent(way.content_id!)!;
    expect(product).toMatchObject({ name: "PPSA01341-app0.zar", source: "made", game_id: k.game.id });
    expect(JSON.parse(product.made_json!)).toMatchObject({ from: { kind: "kept", contentId: input.id, digest: `sha256:${sha256(folder)}` }, tools: ["zarchive@d2c717730092c7bf8cbb033b12fd4001b7c4d932"], program: null });
    expect(r.manifest).toMatchObject({ wayId: k.way.id, contentId: product.id, reused: false });
    expect(queued).toEqual([{ kind: "assemble", wayId: k.way.id, auto: true, runId: 7 }]);
    // the converter read the input folder where it is (named app0, nothing linked or copied) and wrote {out}
    const [call] = zarCalls();
    expect(call[1]).toBe(folder);
    expect(call[2]).toMatch(/[\\/]make[\\/]run[\\/]out[\\/]PPSA01341-app0\.zar$/);
    expect(JSON.parse(readFileSync(product.path, "utf8")).files).toEqual(["data/chunk-0.bin", "data/chunk-1.bin", "data/chunk-2.bin", "eboot.bin", "sce_sys/param.json"]);
    expect(ctx.lines.some(l => /the game data is read-only for the build programs: \d+ entries looked at/.test(l))).toBe(true);
    expect(existsSync(join(ctx.work, "make"))).toBe(false);                     // the scratch is gone, the product is in the store
  });

  test("the same game data by the same recipe is never made twice: the second make reuses the product without a step", async () => {
    const k = kyty();
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    const spec: JobSpec = { kind: "make", wayId: k.way.id, from: "kept", contentId: input.id, then: "assemble" };
    await runJobKind(ctxFor(spec, k.game.id));
    expect(zarCalls().length).toBe(1);
    const again = await runJobKind(ctxFor(spec, k.game.id));
    expect(zarCalls().length).toBe(1);                                         // nothing ran
    expect(again.message).toBe("made before from the same game data: PPSA01341-app0.zar is reused; the build is queued");
    expect(again.manifest).toMatchObject({ reused: true });
    expect(made.length).toBe(1);
    expect(madeFor({ plan: k.plan, content: k.content, input: { from: "kept", contentId: input.id } })?.name).toBe("PPSA01341-app0.zar");
    // a changed recipe is another key: made again
    const changed = { ...k.content, make: { ...k.content.make!, steps: k.content.make!.steps.map(s => ("convert" in s ? { convert: { ...s.convert, timeoutSec: 3600 } } : s)) } };
    expect(makeKey({ digest: "sha256:x", make: changed.make!, tools: toolsOf(changed.make!), program: null }).key).not.toBe(makeKey({ digest: "sha256:x", make: k.content.make!, tools: toolsOf(k.content.make!), program: null }).key);
  });

  test("the make key is the input's digest, the recipe as canonical JSON, the converters' commits and the program only when a step runs it", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }], z: undefined })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const m = kytyContent().make;
    const a = makeKey({ digest: "sha256:aa", make: m, tools: toolsOf(m), program: "p1" });
    expect(a.key).toBe(makeKey({ digest: "sha256:aa", make: JSON.parse(JSON.stringify(m)), tools: toolsOf(m), program: "p2" }).key);   // no step runs the program
    expect(a.key).not.toBe(makeKey({ digest: "sha256:ab", make: m, tools: toolsOf(m), program: "p1" }).key);
    expect(a.recipe).toBe(canonicalJson(m));
  });

  test("an archive of the folder is unpacked by the system's archiver as the build user, from a link of it in the job's folder, saying how far it is", async () => {
    const k = kyty();
    const rar = join(tmp("make-dl-"), "PPSA01341-app0.rar");
    writeFileSync(rar, "Rar!".padEnd(8192, "r"));
    const input = kept(k.game.id, rar);
    exec = zarchive({ slow: true });
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id);
    await runJobKind(ctx);
    const unrar = execs.find(c => c[0] === "unrar")!;
    expect(unrar.slice(0, 5)).toEqual(["unrar", "x", "-y", "-o+", "-p-"]);
    expect(unrar[5]).toBe(join(ctx.work, "make", "in", "PPSA01341-app0.rar"));   // {in}: the same file by a second name
    expect(unrar[6]).toBe(`${join(ctx.work, "make", "run", "prep", "x")}/`);
    expect(ctx.messages.some(m => /^unpacking PPSA01341-app0\.rar · \d+\.\d GB of ~\d+\.\d GB · \d+:\d\d$/.test(m))).toBe(true);
    expect(ctx.messages.some(m => /^packing the game folder · \d+\.\d GB of \d+\.\d GB · \d+:\d\d$/.test(m))).toBe(true);
    expect(ctx.messages.some(m => /^checking what it made · /.test(m))).toBe(true);
    expect(zarCalls()[0][1].replace(/\\/g, "/")).toBe(join(ctx.work, "make", "run", "prep", "app0").replace(/\\/g, "/"));   // picked inside {prep}, renamed there
    expect(getContent(getWay(k.way.id)!.content_id!)!.name).toBe("PPSA01341-app0.zar");
    expect(statSync(rar).nlink).toBe(1);                                       // the link went with the scratch folder
  });

  test("what a make unpacked and wrote is cleared up saying so (an unpacked game is 100,000 files), never under its last message", async () => {
    const k = kyty();
    const rar = join(tmp("make-dl-"), "PPSA01341-app0.rar");
    writeFileSync(rar, "Rar!".padEnd(8192, "r"));
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, rar).id }, k.game.id);
    await runJobKind(ctx);
    const attached = ctx.messages.lastIndexOf("attaching the made game file");
    expect(attached).toBeGreaterThanOrEqual(0);
    expect(ctx.messages.slice(attached + 1).some(m => /^clearing up what the make unpacked and wrote/.test(m))).toBe(true);
    expect(existsSync(join(ctx.work, "make"))).toBe(false);
    // a step that fails clears up the same way, saying so
    const k2 = kyty();
    exec = zarchive({ exit: 1 });
    const ctx2 = ctxFor({ kind: "make", wayId: k2.way.id, from: "kept", contentId: kept(k2.game.id, rar).id }, k2.game.id);
    expect(await runJobKind(ctx2).then(() => null, e => e)).toBeInstanceOf(PlanFault);
    expect(ctx2.messages.at(-1)).toMatch(/^clearing up what the make unpacked and wrote/);
    expect(existsSync(join(ctx2.work, "make"))).toBe(false);
  });

  test("an archiver that cannot open the archive gives way to the next; none that can is the recipe's 'unpack' fault", async () => {
    const k = kyty();
    const rar = join(tmp("make-dl-"), "PPSA01341-app0.rar");
    writeFileSync(rar, "Rar!");
    const input = kept(k.game.id, rar);
    const base = zarchive();
    exec = async (cmd, opts) => {
      if (cmd[0] === "unrar") return { code: 3, stdout: "", stderr: "CRC failed in the encrypted file", timedOut: false };
      if (cmd[0] === "7z" && cmd[1] === "x") { const dest = cmd.find(a => a.startsWith("-o"))!.slice(2); app0(join(dest, "PPSA01341-app0")); return ok(); }
      return base(cmd, opts);
    };
    await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id));
    expect(execs.map(c => c[0]).filter(c => c === "unrar" || c === "7z")).toEqual(["unrar", "7z"]);
    exec = async () => ({ code: 2, stdout: "", stderr: "ERROR: Data Error", timedOut: false });
    const k2 = kyty();
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k2.way.id, from: "kept", contentId: kept(k2.game.id, rar).id }, k2.game.id)).catch(x => x);
    expect(e).toBeInstanceOf(PlanFault);
    expect(failOf(e)).toEqual({ class: "plan", phase: "unpack" });
    expect(e.message).toMatch(/^make step 1 could not unpack PPSA01341-app0\.rar: 7z exit 2: ERROR: Data Error$/);
  });

  test("a declared encrypted file is passed to its recipe and a tool failure is repairable, not a wrong-game refusal", async () => {
    const k = kyty({ ...kytyMake({ shape: "file", formats: ["pkg"], marker: undefined, also: undefined }), steps: [{ run: { exe: "7z", argv: ["x", "{in}", "-o{out}"], wine: false, timeoutSec: 60 } }] });
    const path = join(tmp("make-pkg-"), "game.pkg"); writeFileSync(path, "PKG".padEnd(4096, "x"));
    const input = kept(k.game.id, path);
    mkdeps.describeInput = async () => ({ shape: "file", format: "pkg", size: 4096, identity: { platform: "ps5", serial: "PPSA01341", version: "01.007.000", shape: "pkg", sealed: true, category: "game" }, sealed: true, markers: [], members: null, listing: "none", why: null });
    exec = () => ({ code: 1, stdout: "", stderr: "extractor requires a matching key", timedOut: false });
    const error = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id)).catch(x => x);
    expect(execs.length).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(PlanFault);
    expect(error.message).toContain("extractor requires a matching key");
    expect(existsSync(path)).toBe(true);
    db.query("UPDATE contents SET size=?, identity_json=? WHERE id=?").run(3e9, JSON.stringify({ platform: "ps5", shape: "pkg", sealed: true }), input.id);
    expect(await jobKinds.get("make")!.scratch!({} as JobRow, { kind: "make", wayId: k.way.id, from: "kept", contentId: input.id })).toBe(3e9);
  });

  test("a sealed input is refused with the words before any step", async () => {
    const k = kyty();
    const iso = join(tmp("make-copy-"), "bbb-ps5-01342.iso");
    writeFileSync(iso, "UDF".padEnd(4096, "u"));
    const input = kept(k.game.id, iso);
    mkdeps.describeInput = async () => ({ shape: "file", format: "udf", size: 4096, identity: { platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", region: "US", shape: "bd-image", sealed: true, category: "game" }, sealed: true, markers: [], members: null, listing: "udf", why: null });
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id)).catch(x => x);
    expect(e).toBeInstanceOf(MakeRefused);
    expect(e).toBeInstanceOf(NeedsFiles);
    expect([e.message, e.block, failOf(e)]).toEqual(["bbb-ps5-01342.iso is the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it", "identity", { class: "file" }]);
    expect(execs).toEqual([]);
  });

  test("the game's copy is made from where it is, and a sealed copy is refused in the copy's own words", async () => {
    const k = kyty();
    const pkgDir = join(root, "demons-souls-copy");
    const folder = app0(join(pkgDir, "PPSA01341-app0"));
    const pkg = stmts.insertPackage.get(k.game.id, null, pkgDir, "copy", null, 1, JSON.stringify({ kind: "rom", platform: "ps5" })) as { id: number };
    mkdeps.copyFacts = () => copyFactsOf({ packageId: pkg.id, rel: "PPSA01341-app0", path: folder, shape: "folder", size: 10_000, mtime: 1, sha256: "c".repeat(64), identity: idOf(join(folder, "sce_sys", "param.json")), markers: ["sce_sys/param.json"], judgedAt: 1 });
    await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "copy", packageId: pkg.id }, k.game.id));
    expect(JSON.parse(getContent(getWay(k.way.id)!.content_id!)!.made_json!).from).toEqual({ kind: "copy", packageId: pkg.id, digest: `sha256:${"c".repeat(64)}` });
    expect(zarCalls()[0][1]).toBe(folder);
    // the copy as it is live: a retail disc; the words are copyServes'
    const k2 = kyty();
    const pkg2 = stmts.insertPackage.get(k2.game.id, null, pkgDir, "copy", null, 1, JSON.stringify({ kind: "rom", platform: "ps5" })) as { id: number };
    mkdeps.copyFacts = () => copyFactsOf({ packageId: pkg2.id, rel: "bbb-ps5-01342.iso", path: folder, shape: "folder", size: 1, mtime: 1, sha256: "d".repeat(64), identity: null, markers: [], judgedAt: 1 });
    mkdeps.describeInput = async () => ({ shape: "file", format: "udf", size: 1, identity: { platform: "ps5", serial: "PPSA01342", sealed: true, shape: "bd-image" }, sealed: true, markers: [], members: null, listing: "udf", why: null });
    mkdeps.copyServes = () => ({ serves: "no", why: "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it" });
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k2.way.id, from: "copy", packageId: pkg2.id }, k2.game.id)).catch(x => x);
    expect(e.message).toBe("the game's copy (PPSA01341-app0) is the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it");
  });

  test("an update or a part of the game is refused before any step (make.input.complete), with the program's own words", async () => {
    const k = kyty(kytyMake({ complete: { minFiles: 90000 } }));
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-patch")));
    mkdeps.completeness = async (_d, c) => ({ ok: false, why: `an update or a part of the game, not the whole game: 5 files, and the whole game has at least ${c.minFiles}`, files: 5, bytes: 0 });
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id)).catch(x => x);
    expect([e.message, e.block]).toEqual(["PPSA01341-patch is an update or a part of the game, not the whole game: 5 files, and the whole game has at least 90000", "identity"]);
    expect(execs).toEqual([]);
  });

  test("two folders holding the marker are refused with both paths; when only one is the game (the other a patch) it is taken", async () => {
    const k = kyty({ ...kytyMake(), steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, kytyMake().steps[2]] });
    const rel = tmp("make-release-");
    app0(join(rel, "Demons.Souls-app0"));
    app0(join(rel, "Demons.Souls-app0-copy"));
    const both = kept(k.game.id, rel);
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: both.id }, k.game.id)).catch(x => x);
    expect(e.message).toBe(`2 folders in ${basename(rel)} hold sce_sys/param.json and eboot.bin and each could be the game: ${basename(rel)}/Demons.Souls-app0 (PPSA01341 01.007.000) and ${basename(rel)}/Demons.Souls-app0-copy (PPSA01341 01.007.000) — ludarr takes one game at a time`);
    const rel2 = tmp("make-release-");
    app0(join(rel2, "Demons.Souls-app0"));
    app0(join(rel2, "Demons.Souls-patch"), { patch: true });
    const k2 = kyty({ ...kytyMake(), steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, kytyMake().steps[2]] });
    await runJobKind(ctxFor({ kind: "make", wayId: k2.way.id, from: "kept", contentId: kept(k2.game.id, rel2).id }, k2.game.id));
    expect(zarCalls().at(-1)![1]).toBe(join(rel2, "Demons.Souls-app0"));
  });

  test("another version of the game is refused, whatever folder it is in", async () => {
    const k = kyty();
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0"), { version: "01.000.000" }));
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id)).catch(x => x);
    expect([e.message, e.block]).toEqual(["PPSA01341-app0 is version 01.000.000, and this takes 01.005.000 or 01.007.000", "identity"]);
  });

  test("a step that fails is the recipe's fault, in the step's own words", async () => {
    const k = kyty();
    exec = zarchive({ exit: 1 });
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id)).catch(x => x);
    expect(e).toBeInstanceOf(PlanFault);
    expect([e.message, failOf(e)]).toEqual(["make step 3 failed (exit 1): reading | zstd: error 11 | bad block", { class: "plan", phase: "convert" }]);
  });

  test("what it made must read as the game: a product whose identity says another game is the recipe's fault", async () => {
    const k = kyty();
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    mkdeps.readIdentity = async () => ({ platform: "ps5", serial: "PPSA09999", version: "01.007.000", shape: "zar" });
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id)).catch(x => x);
    expect([e.message, failOf(e)]).toEqual(["what it made does not read as the game: PPSA01341-app0.zar is another game (its title id is PPSA09999, and this takes PPSA01340, PPSA01341, PPSA01342)", { class: "plan", phase: "make" }]);
    mkdeps.readIdentity = async () => null;                                    // a reader that reads nothing proves nothing
    const k2 = kyty();
    const e2 = await runJobKind(ctxFor({ kind: "make", wayId: k2.way.id, from: "kept", contentId: kept(k2.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0"))).id }, k2.game.id)).catch(x => x);
    expect(e2.message).toBe("what it made does not read as the game: nothing in PPSA01341-app0.zar says which game it is (nothing in it reads as a PlayStation 5 game; its version cannot be read)");
    expect(made).toEqual([]);
  });

  test("no room above what the library keeps free: refused before anything is written (this server's)", async () => {
    const k = kyty();
    mkdeps.diskSpace = async () => ({ free: 52e9, total: 8e12 });
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    db.query("UPDATE contents SET size=? WHERE id=?").run(30e9, input.id);
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id)).catch(x => x);
    expect(e).toBeInstanceOf(EnvError);
    expect([failOf(e), e.message]).toEqual([{ class: "env", kind: "room" }, "not enough room: making the game data needs about 30.0 GB on the library, and 2.0 GB is free above the 50.0 GB it keeps free (Settings → General → Import)"]);
    expect(zarCalls()).toEqual([]);
  });

  test("the library falling below what it keeps free while a step runs stops the step (this server's)", async () => {
    const k = kyty();
    let free = 4e12;
    mkdeps.diskSpace = async () => ({ free, total: 8e12 });
    mkdeps.roomMs = 5;
    exec = async (cmd, opts) => {
      if (basename(cmd[0]) === "zarchive") { free = 10e9; await new Promise<void>(r => { const t = setInterval(() => { if (opts.signal?.aborted) { clearInterval(t); r(); } }, 2); }); return { code: 137, stdout: "", stderr: "", timedOut: false }; }
      return ok();
    };
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id)).catch(x => x);
    expect(failOf(e)).toEqual({ class: "env", kind: "room" });
    expect(e.message).toMatch(/^not enough room: the library fell to 10\.0 GB free while the game data was being made/);
  });

  test("the game data changing while it is made fails the make, to be made again once it stays as it is", async () => {
    const k = kyty();
    const folder = app0(join(tmp("make-inbox-"), "PPSA01341-app0"));
    exec = zarchive({ also: () => appendFileSync(join(folder, "data", "chunk-1.bin"), "still copying") });
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, folder).id }, k.game.id)).catch(x => x);
    expect([failOf(e), e.message]).toEqual([{ class: "env", kind: "changed" }, "the game data changed while it was being made (data/chunk-1.bin): it is made again once it stays as it is"]);
    expect(made).toEqual([]);
  });

  test("the input is handed over read-only: write for group and others is cleared, an entry a build program wrote is refused", async () => {
    const k = kyty();
    const folder = app0(join(tmp("make-inbox-"), "PPSA01341-app0"));
    mkdeps.ownFolders = () => [resolve(dirname(folder))];                       // a kept row lies in ludarr's own store
    const chmods: [string, number][] = [];
    mkdeps.chmod = async (p, m) => { chmods.push([p, m]); };
    mkdeps.lstat = async p => { const st = lstatSync(p); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: (st.mode & ~0o777) | (st.isDirectory() ? 0o777 : 0o666), uid: 99 }); };
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, folder).id }, k.game.id);
    await runJobKind(ctx);
    expect(chmods.length).toBe(8);                                              // 3 folders and 5 files
    expect(chmods.every(([, m]) => (m & 0o022) === 0)).toBe(true);
    expect(chmods).toContainEqual([join(folder, "eboot.bin"), 0o644]);
    expect(ctx.lines.some(l => l.includes("8 had write for group or others (cleared)"))).toBe(true);
    mkdeps.lstat = async p => { const st = lstatSync(p); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: p.endsWith("eboot.bin") ? 1503 : 0 }); };
    const k2 = kyty();
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k2.way.id, from: "kept", contentId: kept(k2.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0"))).id }, k2.game.id)).catch(x => x);
    expect([e.message, e.block]).toEqual(["eboot.bin was written by a build program, not by you: it is not taken", "identity"]);
  });

  test("a way whose program is built for each game gets that build queued next, not the assemble", async () => {
    const k = kyty();
    mkdeps.wayBuildNeeded = () => true;
    const r = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0"))).id, then: "assemble", runId: 3 }, k.game.id));
    expect(queued).toEqual([{ kind: "build", planId: k.plan.id, wayId: k.way.id, then: "assemble", runId: 3 }]);
    expect(r.message).toMatch(/its program is built for this game next, then the way$/);
  });

  test("a make whose way is already being assembled does not queue a second build or assemble (it is adopted)", async () => {
    const k = kyty();
    mkdeps.assembling = () => ({ id: 4242 } as JobRow);                        // an assemble is already queued or running for this way
    const spec = (): JobSpec => ({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0"))).id, then: "assemble", auto: true, runId: 3 });
    const r = await runJobKind(ctxFor(spec(), k.game.id));
    expect(queued).toEqual([]);                                                // no duplicate assemble
    expect(r.message).toMatch(/its build is queued already$/);
    // nor a per-game build: the assemble already in flight will do it
    queued = [];
    mkdeps.wayBuildNeeded = () => true;
    const r2 = await runJobKind(ctxFor(spec(), k.game.id));
    expect(queued).toEqual([]);                                                // no duplicate build either
    expect(r2.message).toMatch(/its build is queued already$/);
  });

  test("a job cut off by a restart checks completed stages and says so; its scratch is what it will write", async () => {
    const k = kyty();
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id, { transcript: "[12:00:01] make 3: zarchive …" });
    await runJobKind(ctx);
    expect(ctx.lines[0]).toBe("resuming after restart: checking completed extraction and conversion stages");
    expect(ctx.messages[0]).toBe("checking saved stages");
    db.query("UPDATE contents SET size=? WHERE id=?").run(30e9, input.id);
    expect(await jobKinds.get("make")!.scratch!({} as JobRow, { kind: "make", wayId: k.way.id, from: "kept", contentId: input.id })).toBe(30e9);   // a folder: no unpack
    expect(jobKinds.get("make")!.resumable).toBe(true);
  });

  test("runMake is the same code for the content job of a download (inline): the product is attached, the caller queues what follows", async () => {
    const k = kyty();
    const dl = join(tmp("make-download-"), "Demons.Souls.PS5-DUMP");
    app0(join(dl, "PPSA01341-app0"));
    const ctx = ctxFor({ kind: "content", gameId: k.game.id, fetchId: 9, wayId: k.way.id }, k.game.id);
    const out = await runMake(ctx, { way: k.way, plan: k.plan, content: k.content, input: { from: "indexer", path: dl, fetchId: 9 } as MakeInputRef });
    expect([out.reused, out.product.name, getWay(k.way.id)!.content_id]).toEqual([false, "PPSA01341-app0.zar", out.product.id]);
    expect(JSON.parse(out.product.made_json!).from).toMatchObject({ kind: "indexer", fetchId: 9 });
    expect(queued).toEqual([]);
  });
});

describe("the dry run (makeDry, the construct job's try_make)", () => {
  const budget = { bytes: 500e9, minutes: 600 };
  test("'plan' on an archive: judged by its listing and its marker read alone, stopped before the convert, with estimates", async () => {
    const k = kyty();
    const sevenz = join(tmp("make-try-"), "Demons.Souls.7z");
    writeFileSync(sevenz, "7z".padEnd(5000, "z"));
    const input = kept(k.game.id, sevenz);
    exec = async (cmd: string[]) => {
      if (cmd[0] === "bash" && cmd[3] === "list") {
        writeFileSync(cmd[6], ["Path = Demons.Souls/PPSA01341-app0", "Folder = +", "", "Path = Demons.Souls/PPSA01341-app0/eboot.bin", "Folder = -", "Size = 3000000000", "", "Path = Demons.Souls/PPSA01341-app0/sce_sys/param.json", "Folder = -", "Size = 300", "", "Path = Demons.Souls/README.txt", "Folder = -", "Size = 20", ""].join("\n"));
        return ok();
      }
      return ok();
    };
    const extracted: string[] = [];
    mkdeps.extractMember = async (_p, member, toDir) => { extracted.push(member); mkdirSync(toDir, { recursive: true }); writeFileSync(join(toDir, basename(member)), param()); return join(toDir, basename(member)); };
    const rep = await makeDry({ work: join(root, ".work", "job-90"), content: k.content, input: { from: "kept", contentId: input.id }, mode: "plan", signal: new AbortController().signal, log: () => {}, budget });
    expect(rep.problems).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(extracted).toEqual(["Demons.Souls/PPSA01341-app0/sce_sys/param.json"]);
    expect(rep.picked).toEqual({ path: "Demons.Souls/PPSA01341-app0", identity: { platform: "ps5", serial: "PPSA01341", version: "01.007.000", category: "game", shape: "folder" } });
    expect(rep.estimate.bytes).toBe(5000 + 3_000_000_300);
    expect(rep.lines).toContain("stopped before step 3 (a plan's try converts nothing)");
    expect(zarCalls()).toEqual([]);
    expect(rep.warnings).toEqual([]);
  });

  test("'plan' on an archive of an update: refused by its listing, in the words the make job would use", async () => {
    const k = kyty(kytyMake({ complete: { minFiles: 90000, minBytes: 50e9 } }));
    const sevenz = join(tmp("make-try-"), "Demons.Souls.Update.7z");
    writeFileSync(sevenz, "7z".padEnd(5000, "z"));
    const input = kept(k.game.id, sevenz);
    exec = async (cmd: string[]) => {
      if (cmd[0] === "bash" && cmd[3] === "list") writeFileSync(cmd[6], ["Path = PPSA01341-patch/eboot.bin", "Folder = -", "Size = 3000000000", "", "Path = PPSA01341-patch/sce_sys/param.json", "Folder = -", "Size = 300", ""].join("\n"));
      return ok();
    };
    mkdeps.extractMember = async (_p, member, toDir) => { writeFileSync(join(toDir, basename(member)), param()); return join(toDir, basename(member)); };
    const rep = await makeDry({ work: join(root, ".work", "job-97"), content: k.content, input: { from: "kept", contentId: input.id }, mode: "plan", signal: new AbortController().signal, log: () => {}, budget });
    expect([rep.ok, rep.problems]).toEqual([false, ["PPSA01341-patch in Demons.Souls.Update.7z is an update or a part of the game, not the whole game: 2 files, and the whole game has at least 90,000; 3.0 GB, and the whole game is at least 50.0 GB"]]);
  });

  test("with no game data on the server, the recipe runs on a made-up folder (building and testing its converter on the way), and nothing is kept", async () => {
    const k = kyty();
    const ensured: unknown[] = [];
    const real = mkdeps.ensureConverter;
    mkdeps.ensureConverter = async (c, o) => { ensured.push(c); return real(c, o); };
    const rep = await makeDry({ work: join(root, ".work", "job-91"), content: k.content, input: null, mode: "plan", signal: new AbortController().signal, log: () => {}, budget });
    expect(rep.problems).toEqual([]);
    expect(rep.lines[0]).toBe("tried on a made-up folder (PPSA01340 01.005.000, 5 files): there is no game data on the server yet");
    expect(rep.product).toMatchObject({ name: "PPSA01340-app0.zar", contentId: null, identity: { serial: "PPSA01340", version: "01.005.000" } });
    expect(rep.lines).toContain("nothing made from a made-up folder is kept");
    expect(ensured).toEqual(["zarchive"]);
    expect(made).toEqual([]);
    expect(zarCalls().length).toBe(1);
  });

  test("a made-up PS4 folder carries a param.sfo the readers read", () => {
    const sfo = sfoBytes({ TITLE_ID: "CUSA00001", APP_VER: "01.07", CATEGORY: "gd" });
    expect(String.fromCharCode(...sfo.slice(0, 4))).toBe("\0PSF");
    const dv = new DataView(sfo.buffer);
    const keys = dv.getUint32(8, true), data = dv.getUint32(12, true), n = dv.getUint32(16, true);
    expect(n).toBe(3);
    const entry = (i: number) => { const e = 0x14 + 16 * i; const k = new TextDecoder().decode(sfo.slice(keys + dv.getUint16(e, true))).split("\0")[0]; const len = dv.getUint32(e + 4, true); return [k, new TextDecoder().decode(sfo.slice(data + dv.getUint32(e + 12, true), data + dv.getUint32(e + 12, true) + len - 1))]; };
    expect([entry(0), entry(1), entry(2)]).toEqual([["APP_VER", "01.07"], ["CATEGORY", "gd"], ["TITLE_ID", "CUSA00001"]]);
  });

  test("'full' keeps the product provisionally; at the job's end it stays only for the recipe that was saved", async () => {
    const k = kyty();
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    const rep = await makeDry({ work: join(root, ".work", "job-92"), content: k.content, input: { from: "kept", contentId: input.id }, mode: "full", signal: new AbortController().signal, log: () => {}, budget });
    expect(rep.ok).toBe(true);
    const id = rep.product!.contentId!;
    expect(getContent(id)).toMatchObject({ source: "made", name: "PPSA01341-app0.zar" });
    expect(getWay(k.way.id)!.content_id).toBeNull();                            // a try attaches nothing
    expect(await dropProvisional({ contentIds: [id], content: k.content })).toEqual({ kept: [id], removed: [] });
    // the job would now reuse it
    await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id));
    expect(zarCalls().length).toBe(1);
    const other = { ...k.content, make: { ...k.content.make!, output: { shape: "file" as const, name: "{serial}-{version}.zar" } } };
    const r2 = await makeDry({ work: join(root, ".work", "job-93"), content: other, input: { from: "kept", contentId: input.id }, mode: "full", signal: new AbortController().signal, log: () => {}, budget });
    expect(await dropProvisional({ contentIds: [r2.product!.contentId!], content: k.content })).toEqual({ kept: [], removed: [r2.product!.contentId!] });
    expect(getContent(r2.product!.contentId!)).toBeNull();
  });

  test("'full' beyond the try's budget is tried up to its first convert step, and says so", async () => {
    const k = kyty();
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    db.query("UPDATE contents SET size=? WHERE id=?").run(80e9, input.id);
    const rep = await makeDry({ work: join(root, ".work", "job-94"), content: k.content, input: { from: "kept", contentId: input.id }, mode: "full", signal: new AbortController().signal, log: () => {}, budget: { bytes: 20e9, minutes: 30 } });
    expect(rep.ok).toBe(true);
    expect(rep.warnings[0]).toBe("the whole recipe would write about 80.0 GB and take about 23 min, more than this try may (20.0 GB, 30 min): it was tried up to its first convert or run step");
    expect(rep.picked?.identity?.serial).toBe("PPSA01341");
    expect(zarCalls()).toEqual([]);
  });

  test("a refused input is a problem in the report, in the same words the make would use", async () => {
    const k = kyty();
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0"), { serial: "PPSA09999" }));
    const rep = await makeDry({ work: join(root, ".work", "job-95"), content: k.content, input: { from: "kept", contentId: input.id }, mode: "plan", signal: new AbortController().signal, log: () => {}, budget });
    expect([rep.ok, rep.problems]).toEqual([false, ["PPSA01341-app0 is another game (its serial is PPSA09999)"]]);
  });

  test("a try of a recipe that runs the program's own tool keeps its product under the key the make job looks for: the job reuses it", async () => {
    const make = { ...kytyMake(), steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, { run: { exe: "tools/pack", argv: ["{prep}/app0", "{out}"], wine: false, timeoutSec: 600 } }] };
    const k = kyty(make);
    const prog = tmp("make-prog-");
    mkdirSync(join(prog, "tools"), { recursive: true });
    writeFileSync(join(prog, "tools", "pack"), "the program's own packer");
    writeFileSync(join(prog, "KytyLauncher.exe"), "MZ");
    const pinned = { tag: "v20261108", asset: "KytyPS5-v20261108.zip", url: "https://example.invalid/KytyPS5-v20261108.zip", size: 1, sha256: "f".repeat(64), pinnedAt: 1 };
    mkdeps.acquireProgram = async () => ({ dir: prog, pinned, fresh: false });
    const base = zarchive();
    let packs = 0;
    exec = async (cmd, opts) => { if (basename(cmd[0]) === "pack") { packs++; return base(["zarchive", ...cmd.slice(1)], opts); } return base(cmd, opts); };
    const input = kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0")));
    const rep = await makeDry({ work: join(root, ".work", "job-96"), content: k.content, input: { from: "kept", contentId: input.id }, mode: "full", signal: new AbortController().signal, log: () => {}, budget, program: prog, programSha: pinned.sha256 });
    expect([rep.ok, rep.problems, packs]).toEqual([true, [], 1]);
    expect(await dropProvisional({ contentIds: [rep.product!.contentId!], content: k.content, programSha: pinned.sha256 })).toEqual({ kept: [rep.product!.contentId!], removed: [] });
    const r = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id));
    expect([packs, r.manifest?.reused]).toEqual([1, true]);                       // made once, by the try
  });
});

describe("the live cases, and what is never spent on them", () => {
  test("Demon's Souls: the 54.2 GB US disc image on the server and its kept second copy (row 1) are refused in seconds, before the program is fetched, with nothing read, linked or run", async () => {
    // way 1's content as the upgrade round leaves it: the app0 folder (loose or in an archive) packed into one .zar, judged
    // whole by Kyty's own list of the game's files
    const k = kyty(kytyMake({ complete: { list: { path: "tools/local/static-precompile/files-PPSA01341_01.007.000.files" } } }));
    const dir = join(root, "Demon's Souls");
    mkdirSync(dir, { recursive: true });
    const iso = join(dir, "bbb-ps5-01342.iso");
    writeFileSync(iso, "UDF");                                                 // a stand-in: the live file is 54.2 GB
    const pkg = stmts.insertPackage.get(k.game.id, null, dir, "Demon's Souls", null, 1, JSON.stringify({ kind: "rom", platform: "ps5", launch: { exe: "bbb-ps5-01342.iso" } })) as { id: number };
    const sealed: Identity = { platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", region: "US", shape: "bd-image", sealed: true, category: "game" };
    const words = "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it";
    mkdeps.copyFacts = () => copyFactsOf({ packageId: pkg.id, rel: "bbb-ps5-01342.iso", path: iso, shape: "file", size: 54.2e9, mtime: 1, sha256: "e".repeat(64), identity: sealed, markers: [], judgedAt: 1 });
    mkdeps.copyServes = () => ({ serves: "no", why: words });
    mkdeps.describeInput = async () => ({ shape: "file", format: "udf", size: 54.2e9, identity: sealed, sealed: true, markers: ["bd/param.json"], members: null, listing: "udf", why: null });
    let fetched = 0;
    mkdeps.acquireProgram = async () => { fetched++; throw new Error("the program is never fetched for a sealed input"); };
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "copy", packageId: pkg.id, then: "assemble", auto: true }, k.game.id);
    const e = await runJobKind(ctx).catch(x => x);
    expect([e.message, e.block, failOf(e)]).toEqual([`the game's copy (bbb-ps5-01342.iso) is ${words}`, "identity", { class: "file" }]);
    expect([fetched, execs.length, existsSync(join(ctx.work, "make", "in")), queued.length]).toEqual([0, 0, false, 0]);
    // it holds no room for writes it never makes (the live assemble reserved 108 GB for its refusal)
    expect(await jobKinds.get("make")!.scratch!({} as JobRow, { kind: "make", wayId: k.way.id, from: "copy", packageId: pkg.id })).toBe(2e9);
    // content row 1: the same disc kept a second time by the old hand-over (source 'package'), with its sha256: not read again
    const row1 = insertContent({ gameId: k.game.id, platform: "ps5", name: "bbb-ps5-01342.iso", path: iso, size: 54.2e9, hashes: { sha256: "e".repeat(64) }, source: "package", identity: sealed });
    const e1 = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: row1.id }, k.game.id)).catch(x => x);
    expect([e1.message, e1.block]).toEqual([`bbb-ps5-01342.iso is ${words}`, "identity"]);
    expect([fetched, execs.length]).toEqual([0, 0]);
    expect(await jobKinds.get("make")!.scratch!({} as JobRow, { kind: "make", wayId: k.way.id, from: "kept", contentId: row1.id })).toBe(2e9);
  });

  test("a restarted make uses the completed unpack, then the completed conversion", async () => {
    const k = kyty();
    const archive = join(tmp("make-resume-"), "Demons.Souls.PS5-DUMP.rar");
    writeFileSync(archive, "Rar!".padEnd(4096, "r"));
    const input = kept(k.game.id, archive);
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id);
    const { clearInterruptedWork } = await import("../src/process/checkpoint");
    let unpacks = 0, converts = 0;
    const base = zarchive();
    exec = async (cmd, opts) => {
      if (cmd[0] === "unrar" && cmd[1] === "x") unpacks++;
      if (basename(cmd[0]) === "zarchive" && ++converts === 1) throw new Error("interrupted during conversion");
      return base(cmd, opts);
    };
    await expect(runJobKind(ctx)).rejects.toThrow();
    await clearInterruptedWork(ctx.work);
    const ingest = mkdeps.ingestMade;
    mkdeps.ingestMade = async () => { throw new Error("interrupted during verification"); };
    try { await expect(runJobKind(ctx)).rejects.toThrow("interrupted during verification"); }
    finally { mkdeps.ingestMade = ingest; }
    await clearInterruptedWork(ctx.work);
    await runJobKind(ctx);
    expect(unpacks).toBe(1);
    expect(converts).toBe(2);
    expect(getWay(k.way.id)?.content_id).toBeTruthy();
  });

  test("a RAR set in volumes (name.part01.rar …) is one input: every volume is linked beside the first, the archiver finds them all, the key names them", async () => {
    const k = kyty();
    const rel = tmp("make-set-");
    const parts = [1, 2, 3].map(n => join(rel, `Demons.Souls.PS5-DUMP.part0${n}.rar`));
    parts.forEach((p, i) => writeFileSync(p, `Rar! part ${i + 1}`.padEnd(4096, "r")));
    writeFileSync(join(rel, "Demons.Souls.PS5-DUMP.nfo"), "nfo");
    const input = kept(k.game.id, parts[0]);
    const base = zarchive();
    let beside: string[] = [];
    exec = async (cmd, opts) => { if (cmd[0] === "unrar" && cmd[1] === "x") beside = readdirSync(dirname(cmd[5])).sort(); return base(cmd, opts); };
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id);
    await runJobKind(ctx);
    expect(beside).toEqual(["Demons.Souls.PS5-DUMP.part01.rar", "Demons.Souls.PS5-DUMP.part02.rar", "Demons.Souls.PS5-DUMP.part03.rar"]);
    expect(ctx.lines).toContain("{in}: Demons.Souls.PS5-DUMP.part01.rar and its 2 other volumes, linked into the job's folder");
    const product = getContent(getWay(k.way.id)!.content_id!)!;
    expect(JSON.parse(product.made_json!).from.digest).toMatch(/^sha256:[0-9a-f]{64}\+[0-9a-f]{64}$/);   // the first volume's hash, and the others' listing
    for (const p of parts) expect(statSync(p).nlink).toBe(1);                   // the links went with the scratch folder
    expect(await volumesOf(join(rel, "Demons.Souls.PS5-DUMP.part02.rar"))).toEqual([]);   // only the first volume starts a set
  });

  test("an archive is judged by its listing and its marker before it is unpacked: no game folder, another version or an update is refused without the unpack", async () => {
    const listing = (entries: [string, number][]) => entries.map(([p, size]) => (p.endsWith("/") ? `Path = ${p.slice(0, -1)}\nFolder = +\n` : `Path = ${p}\nFolder = -\nSize = ${size}\n`)).join("\n");
    const run = async (o: { entries: [string, number][]; version?: string; make?: any; listExit?: number; partial?: boolean }) => {
      const k = kyty(o.make ?? kytyMake());
      const rar = join(tmp("make-pre-"), "Demons.Souls.PS5.rar");
      writeFileSync(rar, "Rar!".padEnd(4096, "r"));
      const input = kept(k.game.id, rar);
      execs = [];
      const base = zarchive();
      exec = async (cmd, opts) => {
        if (cmd[0] === "bash" && cmd[3] === "list") {
          if (o.partial) { writeFileSync(cmd[6], listing(o.entries)); return { code: 2, stdout: "", stderr: "ERROR: Unexpected end of archive", timedOut: false }; }
          if (o.listExit) return { code: o.listExit, stdout: "", stderr: "ERROR: Can not open the file as archive", timedOut: false };
          writeFileSync(cmd[6], listing(o.entries));
          return ok();
        }
        return base(cmd, opts);
      };
      mkdeps.extractMember = async (_p, member, toDir) => { writeFileSync(join(toDir, basename(member)), param("PPSA01341", o.version ?? "01.007.000")); return join(toDir, basename(member)); };
      const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id);
      const r = await runJobKind(ctx).catch(x => x);
      return { r, ctx, unpacked: execs.some(c => c[0] === "unrar") };
    };
    const game = (n = 3): [string, number][] => [["PPSA01341-app0/", 0], ["PPSA01341-app0/eboot.bin", 3000], ["PPSA01341-app0/sce_sys/", 0], ["PPSA01341-app0/sce_sys/param.json", 300], ...Array.from({ length: n }, (_, i) => [`PPSA01341-app0/data/chunk-${i}.bin`, 2000] as [string, number])];
    const none = await run({ entries: [["Demons.Souls.mkv", 4e9]] });
    expect([none.r.message, none.r.block, none.unpacked]).toEqual(["nothing in Demons.Souls.PS5.rar holds sce_sys/param.json and eboot.bin: it does not hold the game's folder", "form", false]);
    const old = await run({ entries: game(), version: "01.000.000" });
    expect([old.r.message, old.r.block, old.unpacked]).toEqual(["PPSA01341-app0 in Demons.Souls.PS5.rar is version 01.000.000, and this takes 01.005.000 or 01.007.000", "identity", false]);
    const part = await run({ entries: game(3), make: kytyMake({ complete: { minFiles: 90000 } }) });
    expect([part.r.message, part.r.block, part.unpacked]).toEqual(["PPSA01341-app0 in Demons.Souls.PS5.rar is an update or a part of the game, not the whole game: 5 files, and the whole game has at least 90,000", "identity", false]);
    const good = await run({ entries: game() });
    expect([good.unpacked, good.r.message]).toEqual([true, expect.stringMatching(/^made PPSA01341-app0\.zar/)]);
    expect(good.ctx.lines).toContain("Demons.Souls.PS5.rar holds PPSA01341-app0 (PPSA01341 01.007.000): judged from its listing before it is unpacked");
    // one 7z cannot list is judged once it is unpacked, as before
    const unlisted = await run({ entries: [], listExit: 2 });
    expect(unlisted.unpacked).toBe(true);
    expect(unlisted.ctx.lines.some(l => /could not be listed before it is unpacked/.test(l))).toBe(true);
    // and a listing cut short (a fatal error after some entries) never reads as "no game folder in it"
    const cut = await run({ entries: [["PPSA01341-app0/data/chunk-0.bin", 2000]], partial: true });
    expect(cut.unpacked).toBe(true);
    expect(cut.ctx.lines.some(l => /could be listed only in part \(7z exit 2: ERROR: Unexpected end of archive\)/.test(l))).toBe(true);
  });

  test("game data in ludarr's own folders the build programs cannot read (an inbox drop of 0600) is opened for reading, not left for the admin to fix; a closed folder on the way is said in words", async () => {
    const k = kyty();
    const folder = app0(join(tmp("make-closed-"), "PPSA01341-app0"));
    mkdeps.ownFolders = () => [resolve(dirname(folder))];
    const chmods: [string, number][] = [];
    mkdeps.platform = () => "linux";
    mkdeps.chmod = async (p, m) => { chmods.push([p, m]); };
    const statAs = (mode: (p: string, dir: boolean) => number) => async (p: string) => { const st = lstatSync(p); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: (st.mode & ~0o777) | mode(p, st.isDirectory()), uid: 0 }); };
    mkdeps.lstat = statAs((p, dir) => (p === folder || p.startsWith(folder + sep) ? (dir ? 0o700 : 0o600) : 0o755));
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, folder).id }, k.game.id);
    await runJobKind(ctx);
    expect(chmods).toContainEqual([join(folder, "eboot.bin"), 0o604]);
    expect(chmods).toContainEqual([join(folder, "sce_sys"), 0o705]);
    expect(ctx.lines.some(l => l.includes("8 could not be read by them (opened for reading)"))).toBe(true);
    // The job directory is root:builder1 0750. Its own worker can traverse it.
    const gid = lstatSync(dirname(folder)).gid;
    mkdeps.workerIds = () => ({ uid: 1501, gid });
    mkdeps.lstat = statAs((p, dir) => p === dirname(folder) ? 0o750 : dir ? 0o755 : 0o644);
    const other = kyty();
    await runJobKind(ctxFor({ kind: "make", wayId: other.way.id, from: "kept", contentId: kept(other.game.id, folder).id }, other.game.id));
    const k2 = kyty();
    const folder2 = app0(join(tmp("make-closed-"), "PPSA01341-app0"));
    mkdeps.lstat = statAs((p, dir) => (p === dirname(folder2) ? 0o700 : dir ? 0o755 : 0o644));
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k2.way.id, from: "kept", contentId: kept(k2.game.id, folder2).id }, k2.game.id)).catch(x => x);
    expect([failOf(e), e.message]).toEqual([{ class: "env", kind: "tool" }, `the build programs cannot reach the game data: ${dirname(folder2)} is closed to this build user (mode 0700)`]);
  });
});

describe("room: the unpack on the downloads folder's volume when the library cannot hold it (the live Demon's Souls RAR)", () => {
  const RAR = 54_255_919_283;
  const listing = (entries: [string, number][]) => entries.map(([p, size]) => (p.endsWith("/") ? `Path = ${p.slice(0, -1)}\nFolder = +\n` : `Path = ${p}\nFolder = -\nSize = ${size}\n`)).join("\n");
  /** its listing: the app0 folder, 56 GB */
  const APP0: [string, number][] = [["PPSA01341-app0/", 0], ["PPSA01341-app0/eboot.bin", 3e9], ["PPSA01341-app0/sce_sys/", 0], ["PPSA01341-app0/sce_sys/param.json", 300], ...[0, 1, 2].map(i => [`PPSA01341-app0/data/chunk-${i}.bin`, Math.round(53e9 / 3)] as [string, number])];
  /**
   * The live shapes: the RAR on the seedbox's mount (rclone, read-only; another volume, so it is read where it lies), the
   * library on the cache pool (76 GB free by default, 50 GB kept free: 26 GB usable) and the downloads folder on the array
   * (34 TB free) — one union mount, one device, two sizes, as Unraid's user shares are.
   */
  function live(o: { libraryFree?: number; downloadsFree?: number; downloadsMount?: { fstype: string; options: string[] }; sameDisk?: boolean } = {}) {
    const k = kyty();
    const remote = tmp("make-remote-");
    const rar = join(remote, "downloads", "Demons.Souls.PS5.PPSA01341.rar");
    mkdirSync(dirname(rar), { recursive: true });
    writeFileSync(rar, "Rar!".padEnd(8192, "r"));
    const input = kept(k.game.id, rar);
    db.query("UPDATE contents SET size=? WHERE id=?").run(RAR, input.id);
    const dl = tmp("make-downloads-");
    const under = (p: string, dir: string) => resolve(p) === resolve(dir) || resolve(p).startsWith(resolve(dir) + sep);
    mkdeps.downloadsDir = () => dl;
    mkdeps.mountOf = p => (under(p, remote) ? { at: remote, fstype: "fuse.rclone", options: ["ro", "nosuid", "nodev"] }
      : under(p, dl) ? { at: dl, ...(o.downloadsMount ?? { fstype: "fuse.shfs", options: ["rw", "nosuid"] }) } : { at: root, fstype: "fuse.shfs", options: ["rw", "nosuid"] });
    const space = { library: o.libraryFree ?? 76e9, downloads: o.downloadsFree ?? 34e12 };
    mkdeps.diskSpace = async p => (!o.sameDisk && under(p, dl) ? { free: space.downloads, total: 77e12 } : { free: space.library, total: 1.9e12 });
    mkdeps.link = async () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };
    const base = zarchive();
    exec = async (cmd, opts) => {
      if (cmd[0] === "bash" && cmd[3] === "list") { writeFileSync(cmd[6], listing(APP0)); return ok(); }
      return base(cmd, opts);
    };
    mkdeps.extractMember = async (_p, member, toDir) => { writeFileSync(join(toDir, basename(member)), param()); return join(toDir, basename(member)); };
    return { k, rar, input, dl, space, spec: { kind: "make", wayId: k.way.id, from: "kept", contentId: input.id } as JobSpec };
  }
  const spareOf = (dl: string, id: number) => join(resolve(dl), ".ahoy-work", `job-${id}`);

  test("the library has 26 GB above what it keeps: nothing is unpacked, and the words name both volumes and their numbers", async () => {
    const x = live();
    const ctx = ctxFor(x.spec, x.k.game.id);
    const e = await runJobKind(ctx).catch(err => err);
    expect(failOf(e)).toEqual({ class: "env", kind: "room" });
    expect(e.message).toBe(`not enough room: what it makes (about 56.0 GB) is written on the library, and 26.0 GB is free there above the 50.0 GB it keeps free (Settings → General → Import); the unpack (about 56.0 GB) would go on the downloads folder (${resolve(x.dl)}, 34000 GB free)`);
    expect(execs.some(c => c[0] === "unrar")).toBe(false);
    expect(existsSync(join(x.dl, ".ahoy-work"))).toBe(false);                 // nothing written there to find that out
  });

  test("with the 54 GB duplicate freed (130 GB free): {prep} goes on the downloads folder's volume, {out} stays in the job's folder on the library, and both are gone after", async () => {
    const x = live({ libraryFree: 130e9 });
    const ctx = ctxFor(x.spec, x.k.game.id);
    const r = await runJobKind(ctx);
    expect(r.message).toMatch(/^made PPSA01341-app0\.zar/);
    const away = spareOf(x.dl, ctx.job.id);
    const unrar = execs.find(c => c[0] === "unrar")!;
    expect(unrar[5]).toBe(x.rar);                                            // read where it lies (no link to another volume)
    expect(unrar[6]).toBe(`${join(away, "prep", "x")}/`);
    const [zar] = zarCalls();
    expect(zar[1].replace(/\\/g, "/")).toBe(join(away, "prep", "app0").replace(/\\/g, "/"));   // picked there, renamed there
    expect(zar[2]).toBe(join(ctx.work, "make", "run", "out", "PPSA01341-app0.zar"));
    expect(ctx.lines).toContain(`{prep} is on the downloads folder's volume (${away}, 34000 GB free): the library has 80.0 GB free above the 50.0 GB it keeps free (Settings → General → Import), and unpacking takes about 56.0 GB beside the 56.0 GB it makes there`);
    expect(ctx.messages.some(m => /^unpacking Demons\.Souls\.PS5\.PPSA01341\.rar · \d+\.\d GB of ~\d+\.\d GB · \d+:\d\d$/.test(m))).toBe(true);
    expect(getContent(getWay(x.k.way.id)!.content_id!)!.name).toBe("PPSA01341-app0.zar");
    expect([existsSync(away), existsSync(join(ctx.work, "make"))]).toEqual([false, false]);
  });

  test("a library with room keeps {prep} where it always was: nothing moves", async () => {
    const x = live({ libraryFree: 4e12 });
    const ctx = ctxFor(x.spec, x.k.game.id);
    await runJobKind(ctx);
    expect(execs.find(c => c[0] === "unrar")![6]).toBe(`${join(ctx.work, "make", "run", "prep", "x")}/`);
    expect(existsSync(join(x.dl, ".ahoy-work"))).toBe(false);
  });

  test("never on a network or read-only mount, nor on the library's own disk: the words say which", async () => {
    const said = async (o: Parameters<typeof live>[0]) => {
      const x = live({ libraryFree: 130e9, ...o });
      const e = await runJobKind(ctxFor(x.spec, x.k.game.id)).catch(err => err);
      expect([failOf(e), execs.some(c => c[0] === "unrar")]).toEqual([{ class: "env", kind: "room" }, false]);
      execs = [];
      return [e.message as string, resolve(x.dl)] as const;
    };
    const head = "not enough room: making the game data unpacks about 56.0 GB and writes about 56.0 GB on the library, and 80.0 GB is free there above the 50.0 GB it keeps free (Settings → General → Import); the downloads folder cannot take the unpack: ";
    const [net, d1] = await said({ downloadsMount: { fstype: "fuse.rclone", options: ["rw"] } });
    expect(net).toBe(`${head}the downloads folder (${d1}) is a network mount (fuse.rclone)`);
    const [ro, d2] = await said({ downloadsMount: { fstype: "xfs", options: ["ro", "relatime"] } });
    expect(ro).toBe(`${head}the downloads folder (${d2}) is mounted read-only`);
    const [same, d3] = await said({ sameDisk: true });
    expect(same).toBe(`${head}the downloads folder (${d3}) is on the library's own disk`);
    const [full, d4] = await said({ downloadsFree: 60e9 });
    expect(full).toBe(`${head}the downloads folder (${d4}) has 40.0 GB free above the 20.0 GB it keeps for the download clients, and the unpack needs about 56.0 GB`);
  });

  test("the downloads folder falling below what it keeps for the download clients while the unpack runs stops it (this server's)", async () => {
    const x = live({ libraryFree: 130e9 });
    mkdeps.roomMs = 5;
    const base = zarchive();
    exec = async (cmd, opts) => {
      if (cmd[0] === "bash" && cmd[3] === "list") { writeFileSync(cmd[6], listing(APP0)); return ok(); }
      if (cmd[0] === "unrar") { x.space.downloads = 10e9; await new Promise<void>(r => { const t = setInterval(() => { if (opts.signal?.aborted) { clearInterval(t); r(); } }, 2); }); return { code: 255, stdout: "", stderr: "", timedOut: false }; }
      return base(cmd, opts);
    };
    const ctx = ctxFor(x.spec, x.k.game.id);
    const e = await runJobKind(ctx).catch(err => err);
    expect(failOf(e)).toEqual({ class: "env", kind: "room" });
    expect(e.message).toBe(`not enough room: the downloads folder fell to 10.0 GB free while the game data was unpacked there (${spareOf(x.dl, ctx.job.id)}), below the 20.0 GB it keeps for the download clients: stopped, and tried again later`);
    expect(existsSync(spareOf(x.dl, ctx.job.id))).toBe(false);
  });

  test("the runner's scratch gate weighs only what goes on the library: the product alone when the unpack goes on the downloads folder's volume", async () => {
    const x = live({ libraryFree: 130e9 });
    const lib = stmts.insertRootFolder.get(root, null) as { id: number };
    db.query("UPDATE games SET root_folder_id=? WHERE id=?").run(lib.id, x.k.game.id);
    try {
      const gate = () => jobKinds.get("make")!.scratch!({} as JobRow, x.spec);
      expect(await gate()).toBe(RAR);
      x.space.library = 4e12;                                                  // the library holds both: both are its
      expect(await gate()).toBe(2 * RAR);
      x.space.library = 130e9;
      mkdeps.mountOf = () => ({ at: x.dl, fstype: "nfs4", options: ["rw"] });  // no other volume to unpack on
      expect(await gate()).toBe(2 * RAR);
    } finally {
      db.query("UPDATE games SET root_folder_id=NULL WHERE id=?").run(x.k.game.id);
      db.query("DELETE FROM root_folders WHERE id=?").run(lib.id);
    }
  });

  test("a leftover of the job's own on the downloads folder (a restart cut it short) is set aside first; the sweep removes what jobs that no longer run left, never a running job's", async () => {
    const x = live({ libraryFree: 130e9 });
    const ctx = ctxFor(x.spec, x.k.game.id);
    const stale = join(spareOf(x.dl, ctx.job.id), "prep", "x", "PPSA01341-app0");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "eboot.bin"), "half an unpack from before the restart");
    await runJobKind(ctx);
    expect(existsSync(join(x.dl, ".ahoy-work"))).toBe(true);
    expect(readdirSync(join(x.dl, ".ahoy-work")).filter(n => !n.startsWith("."))).toEqual([]);   // its own folder went with the make, the leftover too
    const top = join(x.dl, ".ahoy-work");
    for (const d of ["job-901/prep/x", "job-902/prep/x", "swept-5-1/prep", "not-a-job"]) mkdirSync(join(top, ...d.split("/")), { recursive: true });
    expect(await sweepSpareWork(x.dl, id => id === 902, () => {})).toBe(2);
    expect(readdirSync(top).filter(n => !n.startsWith(".")).sort()).toEqual(["job-902", "not-a-job"]);
  });

  test("what the make queues next carries the admin's replace (the assemble, or the program built for this game first)", async () => {
    const k = kyty();
    const spec = (): JobSpec => ({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, app0(join(tmp("make-inbox-"), "PPSA01341-app0"))).id, then: "assemble", auto: true, replace: true, runId: 7 });
    await runJobKind(ctxFor(spec(), k.game.id));
    expect(queued).toEqual([{ kind: "assemble", wayId: k.way.id, auto: true, replace: true, runId: 7 }]);
    queued = [];
    db.query("UPDATE ways SET content_id=NULL WHERE id=?").run(k.way.id);
    mkdeps.wayBuildNeeded = () => true;
    await runJobKind(ctxFor(spec(), k.game.id));
    expect(queued).toEqual([{ kind: "build", planId: k.plan.id, wayId: k.way.id, then: "assemble", auto: true, replace: true, runId: 7 }]);
  });
});

/* ─────────── fix round C: a list judges its own version, an archive judged by its listing, a client's download kept as it is ─────────── */

/** the KytyPS5 way as the upgrade round may leave it when the program says "any version": no versions in accept */
function kytyAnyVersion(make: any) {
  seq++;
  const game = upsertGame({ steam_appid: 997000 + seq, name: `Demon's Souls ${seq}`, slug: `demons-souls-any-${seq}` }) as GameRow;
  const spec = validatePlanSpec(kytyPlan(), "emulator");
  if (!spec.ok) throw new Error(spec.errors.join("; "));
  const plan = insertPlan({ name: `KytyPS5 any ${seq}`, kind: "emulator", repo: KYTY, platforms: ["ps5"], spec: spec.value!, status: "ready" });
  const content = kytyContent(make);
  delete content.accept.versions;
  const c = validateWayContent(content, "emulator");
  if (!c.ok) throw new Error(c.errors.join("; "));
  const way = insertWay({ gameId: game.id, planId: plan.id, content: c.value!, status: "needs-files" });
  return { game, plan, way, content: c.value! };
}
const LIST = "tools/local/static-precompile/files-PPSA01341_01.007.000.files";
/** the program as it is pinned, with Kyty's list of the 1.07 game's files (98 paths, none of which a small dump has) */
function kytyProgram(): string {
  const prog = tmp("make-prog-");
  mkdirSync(join(prog, ...dirname(LIST).split("/")), { recursive: true });
  writeFileSync(join(prog, ...LIST.split("/")), Array.from({ length: 98 }, (_, i) => `app0/data/file-${i}.bin`).join("\n"));
  writeFileSync(join(prog, "KytyLauncher.exe"), "MZ");
  mkdeps.acquireProgram = async () => ({ dir: prog, pinned: { tag: "v20261108", asset: "KytyPS5-v20261108.zip", url: "https://example.invalid/KytyPS5-v20261108.zip", size: 1, sha256: "f".repeat(64), pinnedAt: 1 }, fresh: false });
  return prog;
}

describe("a program's file list judges only the version it is for (the live v1.004 dump against Kyty's 1.07 list)", () => {
  test("a 01.004.000 dump is not refused by the 01.007.000 list: it is judged by what it holds, and the log says so; a 01.007.000 dump that lacks the list's files is refused, said once", async () => {
    kytyProgram();
    mkdeps.completeness = savedMk.completeness;                                   // the real whole-game check
    const make = kytyMake({ versions: undefined, complete: { list: { path: LIST } } });
    const k = kytyAnyVersion(make);
    // the live v1.004 dump holds 42 % of the files Kyty's 1.07 list names (41,737 of 98,368)
    const v104 = app0(join(tmp("make-v104-"), "PPSA01341-app0"), { version: "01.004.000" });
    for (let i = 0; i < 42; i++) writeFileSync(join(v104, "data", `file-${i}.bin`), "x");
    const old = kept(k.game.id, v104);
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: old.id }, k.game.id);
    const r = await runJobKind(ctx);
    expect(r.message).toMatch(/^made PPSA01341-app0\.zar/);
    expect(ctx.lines).toContain("the program's file list (files-PPSA01341_01.007.000.files) is for PPSA01341 01.007.000; this dump is PPSA01341 01.004.000, so it is judged by how many of the list's files it holds (at least 25 %: an update holds only a few)");
    // the version the list is for: judged by it, as before, and the refusal says "an update or a part" once
    const k2 = kytyAnyVersion(make);
    const same = kept(k2.game.id, app0(join(tmp("make-v107-"), "PPSA01341-app0"), { version: "01.007.000" }));
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k2.way.id, from: "kept", contentId: same.id }, k2.game.id)).catch(x => x);
    expect([e.message, e.block]).toEqual(["PPSA01341-app0 is an update or a part of the game, not the whole game: 0% of the 98 files the program lists for it are there (the whole game has 98%)", "identity"]);
  });

  test("by an archive's listing too: the v1.004 RAR is judged from its listing before it is unpacked, the 1.07 list not applied to it", async () => {
    kytyProgram();
    const listing = (entries: [string, number][]) => entries.map(([p, size]) => (p.endsWith("/") ? `Path = ${p.slice(0, -1)}\nFolder = +\n` : `Path = ${p}\nFolder = -\nSize = ${size}\n`)).join("\n");
    const make = kytyMake({ versions: undefined, complete: { list: { path: LIST } } });
    const k = kytyAnyVersion(make);
    const rar = join(tmp("make-v104rar-"), "Demons.Souls.v1.004.PS5.PPSA01341.rar");
    writeFileSync(rar, "Rar!".padEnd(4096, "r"));
    const input = kept(k.game.id, rar);
    const base = zarchive();
    exec = async (cmd, opts) => {
      if (cmd[0] === "bash" && cmd[3] === "list") {
        writeFileSync(cmd[6], listing([["PPSA01341-app0/", 0], ["PPSA01341-app0/eboot.bin", 3000], ["PPSA01341-app0/sce_sys/", 0], ["PPSA01341-app0/sce_sys/param.json", 300], ["PPSA01341-app0/data/chunk-0.bin", 2000],
          ...Array.from({ length: 42 }, (_, i): [string, number] => [`PPSA01341-app0/data/file-${i}.bin`, 1])]));
        return ok();
      }
      return base(cmd, opts);
    };
    mkdeps.extractMember = async (_p, member, toDir) => { writeFileSync(join(toDir, basename(member)), param("PPSA01341", "01.004.000")); return join(toDir, basename(member)); };
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: input.id }, k.game.id);
    await runJobKind(ctx).catch(x => x);
    expect(ctx.lines).toContain("Demons.Souls.v1.004.PS5.PPSA01341.rar holds PPSA01341-app0 (PPSA01341 01.004.000): judged from its listing before it is unpacked");
    expect(ctx.lines.some(l => l.startsWith("the program's file list (files-PPSA01341_01.007.000.files) is for PPSA01341 01.007.000; this dump is PPSA01341 01.004.000"))).toBe(true);
    expect(execs.some(c => c[0] === "unrar")).toBe(true);                         // judged fit: then unpacked
  });
});

describe("a download's archive judged by its listing before the content pass unpacks it (judgeArchive)", () => {
  const listing = (entries: [string, number][]) => entries.map(([p, size]) => (p.endsWith("/") ? `Path = ${p.slice(0, -1)}\nFolder = +\n` : `Path = ${p}\nFolder = -\nSize = ${size}\n`)).join("\n");
  /** the folder recipe (AMEND's): the app0 folder itself picked and packed; an archive of it is unpacked by the content pass */
  const folderMake = (o: Record<string, unknown> = {}) => ({
    ...kytyMake(o), input: { ...kytyMake(o).input, shape: "folder", formats: undefined },
    steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, { convert: { with: "zarchive", argv: ["{prep}/app0", "{out}"], timeoutSec: 7200 } }],
  });
  async function judge(entries: [string, number][] | null, version = "01.007.000", make: any = folderMake()) {
    const k = kyty(make);
    const rar = join(tmp("make-judge-"), "Demons.Souls.PS5.rar");
    writeFileSync(rar, "Rar!".padEnd(4096, "r"));
    exec = async cmd => {
      if (cmd[0] === "bash" && cmd[3] === "list") {
        if (!entries) return { code: 2, stdout: "", stderr: "ERROR: Can not open the file as archive", timedOut: false };
        writeFileSync(cmd[6], listing(entries));
        return ok();
      }
      return ok();
    };
    mkdeps.extractMember = async (_p, member, toDir) => { writeFileSync(join(toDir, basename(member)), param("PPSA01341", version)); return join(toDir, basename(member)); };
    const work = join(root, ".work", `job-${9000 + seq}`);
    mkdirSync(work, { recursive: true });
    const lines: string[] = [];
    const { judgeArchive } = await import("../src/ways/make");
    const r = await judgeArchive({ path: rar, content: k.content, work, gameId: k.game.id, signal: new AbortController().signal, log: l => lines.push(l), progress: () => {} }).catch(x => x);
    return { r, lines, unpacked: execs.some(c => c[0] === "unrar") };
  }
  const game = (n = 3): [string, number][] => [["PPSA01341-app0/", 0], ["PPSA01341-app0/eboot.bin", 3000], ["PPSA01341-app0/sce_sys/", 0], ["PPSA01341-app0/sce_sys/param.json", 300], ...Array.from({ length: n }, (_, i) => [`PPSA01341-app0/data/chunk-${i}.bin`, 2000] as [string, number])];

  test("no game folder, another version, a part of the game: refused from the listing alone, with the make's words and class; nothing is unpacked", async () => {
    const none = await judge([["Demons.Souls.mkv", 4e9]]);
    expect([none.r.message, none.r.block, none.unpacked]).toEqual(["nothing in Demons.Souls.PS5.rar holds sce_sys/param.json and eboot.bin: it does not hold the game's folder", "form", false]);
    const old = await judge(game(), "01.000.000");
    expect([old.r.message, old.r.block]).toEqual(["PPSA01341-app0 in Demons.Souls.PS5.rar is version 01.000.000, and this takes 01.005.000 or 01.007.000", "identity"]);
    const part = await judge(game(3), "01.007.000", folderMake({ complete: { minFiles: 90000 } }));
    expect([part.r.message, part.r.block]).toEqual(["PPSA01341-app0 in Demons.Souls.PS5.rar is an update or a part of the game, not the whole game: 5 files, and the whole game has at least 90,000", "identity"]);
  });

  test("the game's folder in it: its folder, identity and bytes; an archive 7z cannot list says nothing (it is unpacked as before)", async () => {
    const good = await judge(game());
    expect(good.r).toEqual({ dir: "PPSA01341-app0", identity: expect.objectContaining({ serial: "PPSA01341", version: "01.007.000" }), bytes: 3000 + 300 + 3 * 2000 });
    expect(good.lines).toContain("Demons.Souls.PS5.rar holds PPSA01341-app0 (PPSA01341 01.007.000): judged from its listing before it is unpacked");
    const unlisted = await judge(null);
    expect(unlisted.r).toBeNull();
    expect(unlisted.lines.some(l => l.startsWith("Demons.Souls.PS5.rar could not be listed before it is unpacked"))).toBe(true);
  });
});

describe("the hand-over never changes a download that is not ludarr's (the seedbox's read-only mount)", () => {
  test("outside ludarr's own folders: read as it is (no chmod, so a read-only mount's EROFS is never met); one the build programs cannot read is refused in words", async () => {
    mkdeps.platform = () => "linux";
    const chmods: string[] = [];
    mkdeps.chmod = async p => { chmods.push(p); throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }); };
    mkdeps.ownFolders = () => [resolve(root)];
    const statAs = (mode: (dir: boolean) => number) => async (p: string) => { const st = lstatSync(p); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: (st.mode & ~0o777) | mode(st.isDirectory()), uid: 0 }); };
    // an earlier download on the seedbox's mount: 0777 folders and 0666 files, as an rclone mount shows them
    mkdeps.lstat = statAs(dir => (dir ? 0o777 : 0o666));
    const k = kyty();
    const remote = app0(join(tmp("make-remote-"), "PPSA01341-app0"));
    const ctx = ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, remote).id }, k.game.id);
    const r = await runJobKind(ctx);
    expect(r.message).toMatch(/^made PPSA01341-app0\.zar/);
    expect(chmods).toEqual([]);
    // closed to others, and not ludarr's to open: said in words, nothing changed
    mkdeps.lstat = statAs(dir => (dir ? 0o700 : 0o600));
    const k2 = kyty();
    const closed = app0(join(tmp("make-remote-"), "PPSA01341-app0"));
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k2.way.id, from: "kept", contentId: kept(k2.game.id, closed).id }, k2.game.id)).catch(x => x);
    expect([failOf(e), e.message]).toEqual([{ class: "env", kind: "tool" }, "the build programs cannot read PPSA01341-app0: it is closed to others (mode 0700), and it lies outside ludarr's own folders, whose modes ludarr does not change"]);
    expect(chmods).toEqual([]);
  });

  test("inside ludarr's own folders a chmod the volume refuses is the server's trouble, in words (never a bare error)", async () => {
    mkdeps.platform = () => "linux";
    mkdeps.chmod = async () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); };
    const folder = app0(join(tmp("make-own-"), "PPSA01341-app0"));
    mkdeps.ownFolders = () => [resolve(dirname(folder))];
    mkdeps.lstat = async p => { const st = lstatSync(p); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: (st.mode & ~0o777) | (st.isDirectory() ? 0o777 : 0o666), uid: 0 }); };
    const k = kyty();
    const e = await runJobKind(ctxFor({ kind: "make", wayId: k.way.id, from: "kept", contentId: kept(k.game.id, folder).id }, k.game.id)).catch(x => x);
    expect([failOf(e), e.message]).toEqual([{ class: "env", kind: "tool" }, "PPSA01341-app0 cannot be made read-only for the build programs (EPERM)"]);
  });
});
