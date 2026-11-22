/**
 * ludarr — making a way's game file from another form of the game's data (job kind 'make', spec {wayId, from, …}): the
 * content plan's recorded steps (unpack, pick, convert, run, remove, move) in the build sandbox, the input handed over
 * read-only and judged first, the product judged by its own bytes and kept, so the same data is never made twice.
 * A declared file input is opened by its recipe, including extraction/decryption when its tool supports it.
 *
 *   1 the input: the game's copy where it is (copyFacts), a kept file or folder, or a path (a download inside its content
 *     job, an inbox entry). Its digest (the manifest's sha256, the row's sha1, or its listing's) with the recipe, the
 *     converters' commits and the program's pin is the make key: a product made before under that key is reused, attached
 *     and done, without a step
 *   2 judged before any step, and before the program is fetched: an undeclared encrypted format is refused with the
 *     words; then make.input (shape, platform, formats, the serial, version, region and category its own data says,
 *     src/ways/match.ts inputMatches), the marker it must hold, and for a game folder that it is the whole game, not an
 *     update or a part (make.input.complete). An archive is judged by its listing and its marker taken out alone before
 *     it is unpacked: one without the game's folder, of another game or version, or of an update is refused without a byte
 *     written (the pick judges the unpacked folder again, strictly)
 *   3 room: the unpack and the product must fit above what the library keeps free (LIBRARY_KEEP_FREE_GB). When the library
 *     cannot hold both, the unpack ({prep}) goes on the downloads folder's volume instead (<downloads>/.ahoy-work/job-<id>,
 *     closed to every other job as the job's own folder is) — never a network or read-only mount, never the library's own
 *     disk, and only with SPARE_KEEP_FREE left there for the download clients — while the product ({out}) is still written
 *     in the job's folder on the library, so it is renamed into the store with no copy. Both volumes are looked at again
 *     every 10 s while the steps run; the folder on the downloads volume goes with the make (and at boot, if a restart cut
 *     it short)
 *   4 handed over read-only: a file by a hard link into the job's folder ({in}; the other volumes of a multi-volume archive
 *     linked beside it; its own path when no link can be made), a folder where it is — never a copy. An entry a build user
 *     wrote is refused; group and other write is cleared, and read for others given where it lacked (the build programs
 *     read it as others); its listing (path, size, time) is taken, and taken again after the steps: the data changing
 *     meanwhile fails the make
 *   5 the steps, each as the job's build user through runSandboxedStep (src/ways/sandbox.ts) with its phase, no network
 *     where the server can take it away, a timeout of its own, and no link left behind. unpack: the system's archiver
 *     (unrar, 7z, unar) into {prep}/<to> (a folder input is that folder itself, read-only); pick: the one folder (6 levels
 *     down at most) that holds the marker and its neighbours, judged again (identity, whole game) and named for the later
 *     steps; convert: a converter by name or pinned to a commit (src/ways/converters.ts), run from the job's folder; run: the
 *     program's own tool ({program} read-only) or one of the plan's tools; remove / move inside {prep}
 *   6 the product ({out}/<name>, {serial} and {version} from the game data's own identity) read by the identity readers
 *     and judged against the content plan: it must be the game, and proven by the serials, versions or build ids the plan
 *     lists ("what it made does not read as the game" is the recipe's fault). Kept by ingestMade (src/ways/content.ts:
 *     renamed into the store, hashed once) with MadeInfo, attached to the way; with then 'assemble' the build is queued
 *
 * Every long step says how far it is in bytes ("unpacking x.rar · 31.2 of ~83 GB", "packing the game folder · 3.1 of
 * 9.8 GB"), at least every few seconds. What went wrong is typed (src/ways/errors.ts): a refused input is MakeRefused
 * (class 'file': another file is needed; its `block` says whether the release is never the game, or only not in a form
 * this recipe takes), a recipe that fails is PlanFault ('unpack', 'convert' or 'make'), and this server's trouble —
 * no room, no sandbox or archiver, the data changing, memory, the CPU — is EnvError. A restart starts the make over.
 *
 *   runMake(ctx, o)    the make for one way (the job, and the content job of a download, inline)
 *   makeDry(o)         the construct job's try_make: 'plan' judges and picks without converting (archives by their
 *                      listing), 'full' runs every step when it fits the budget and keeps the product provisionally; with
 *                      no input at all, the recipe runs on a made-up folder (which also builds and tests its converter)
 *   dropProvisional(o) at the construct job's end: products of its dry runs whose recipe was not saved go
 *   madeFor(o)         the product made before for this input and recipe, if there is one
 */
import { readFileSync, statSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { stmts, type GameRow, type PackageRow } from "../db";
import { downloadsDir } from "../config";
import { removeTree } from "../fsutil";
import { diskSpace, rootFolderFor, rootFolders, workDirFor } from "../library/rootfolders";
import { enqueueJob, registerJobKind, type KindContext, type KindResult } from "../process/kinds";
import { pdeps } from "../process/deps";
import { winPath } from "../process/scene";
import { wayBuildNeeded } from "./build";
import { present } from "./check";
import { attachToWays, ingestMade, keepFreeBytes, removeContent, type Target } from "./content";
import { copyFacts, copyServes, judgeCopy } from "./copy";
import { ensureConverter, KNOWN_CONVERTERS, type Converter } from "./converters";
import { EnvError, NeedsFiles, PlanFault } from "./errors";
import { readFolderIdentity, readIdentity, type Identity } from "./identity";
import { noted } from "../transport";
import { completeness, describeInput, extractMember, listFallback, listJudges, PART } from "./inspect";
import { contentMatches, inputMatches, takesMakeFile, proven, type FileFacts, type Verdict } from "./match";
import { acquireProgram, ProgramError, toolsDir } from "./program";
import { checkpointPath, completed, publishStage, restoreStage, clearInterruptedWork } from "../process/checkpoint";
import { buildFileProblem, closeJobFolder, handTo, linkProblem, readBuildFile, runSandboxedStep, sandboxDirs, sandboxExec, sandboxOrAllowed, sandboxUserFor, userIds, SANDBOX_UIDS, SPARE_WORK, spareJobFolder, stepFailure, stopUnder } from "./sandbox";
import {
  assembling, contentFacts, contentHashes, contentIdentity, contentMade, getContent, getPlan, getWay, planPinned, planSpec, wayContent, wstmts,
  type ContentRow, type PlanRow, type WayRow,
} from "./store";
import type { ContentMake, ContentPlan, ConverterId, InputDescription, JobSpec, MadeInfo, MakeInput, MakeReport, MakeStep, PinnedProgram, PinnedTool } from "./types";
import { placedName } from "./validate";

/** where a make's input is: the game's copy (read in place), a kept file, or a path (an inbox entry, a download; digest:
 *  its sha256 when the caller has it, so the key needs no read of it) */
export type MakeInputRef =
  | { from: "copy"; packageId: number }
  | { from: "kept"; contentId: number }
  | { from: "inbox" | "indexer"; path: string; fetchId?: number | null; digest?: string | null };
/** the product, kept and attached to the way; reused: it was made before from the same data by the same recipe */
export interface MakeOutcome { product: ContentRow; reused: boolean }

/** an input the make does not take (sealed, another title or version, a patch, a part of the game, no game folder in it,
 *  written by a build program): another file is needed. block: 'identity' — that data is never the game (a release that
 *  brought it is blocked for good); 'form' — it is not in a form this recipe takes (a changed recipe may take it) */
export class MakeRefused extends NeedsFiles {
  constructor(msg: string, public block: "identity" | "form") { super(msg); this.name = "MakeRefused"; }
}

/** swapped in tests: the readers, the copy, the store, the converters, the program, the clock */
export const mkdeps = {
  describeInput: (path: string): Promise<InputDescription> => describeInput(path),
  readIdentity: (path: string, platform: string | null): Promise<Identity | null> => readIdentity(path, platform),
  readFolderIdentity: (dir: string, platform: string | null): Promise<Identity | null> => readFolderIdentity(dir, platform),
  completeness: (dir: string, c: NonNullable<MakeInput["complete"]>, o: { list?: string[] | null; identity?: Pick<Identity, "serial" | "version"> | null }) => completeness(dir, c, o),
  extractMember: (path: string, member: string, toDir: string, o: { signal?: AbortSignal; work?: string }) => extractMember(path, member, toDir, o),
  inputMatches: (input: MakeInput, f: FileFacts): Verdict => inputMatches(input, f),
  contentMatches: (c: ContentPlan, f: FileFacts): Verdict => contentMatches(c, f),
  copyFacts: (gameId: number) => copyFacts(gameId),
  judgeCopy: (gameId: number) => judgeCopy(gameId),
  copyServes: (gameId: number, c: ContentPlan) => copyServes(gameId, c),
  ingestMade: (path: string, t: Target, o: { made: MadeInfo; signal?: AbortSignal; progress?: (bytes: number, total: number) => void }) => ingestMade(path, t, o),
  attachToWays: (row: ContentRow, o: { wayId?: number | null }) => attachToWays(row, o),
  removeContent: (id: number) => removeContent(id),
  keepFreeBytes: (): number => keepFreeBytes(),
  diskSpace: (p: string) => diskSpace(p),
  /** the downloads folder (/downloads in Docker): where an unpack goes when the library cannot hold it */
  downloadsDir: (): string => downloadsDir(),
  /** the mount a path is on (its file system type and options), from the mount table; null where there is none to read */
  mountOf: (path: string): { at: string; fstype: string; options: string[] } | null => mountOf(path),
  ensureConverter: (c: Parameters<typeof ensureConverter>[0], o: Parameters<typeof ensureConverter>[1]) => ensureConverter(c, o),
  acquireProgram: (plan: PlanRow, o: Parameters<typeof acquireProgram>[1]) => acquireProgram(plan, o),
  enqueueJob: (spec: JobSpec, o: { gameId?: number | null; runId?: number | null }) => enqueueJob(spec, o),
  wayBuildNeeded: (plan: PlanRow, way: WayRow) => wayBuildNeeded(plan, way),
  assembling: (wayId: number) => assembling(wayId),
  link: (from: string, to: string) => link(from, to),
  /** what the hand-over judges an entry by, and how it clears group and other write */
  lstat: (path: string) => lstat(path),
  /** ludarr's own folders, whose entries the hand-over may change the modes of: each root folder (its stores, its inbox,
   *  its packages), each work folder, and the jobs' folders on the downloads folder's volume; anything else (a download
   *  client's folder, an earlier download, the seedbox's read-only mount) keeps its modes */
  workerIds: (path: string) => userIds(sandboxUserFor(path).user),
  ownFolders: (): string[] => [...new Set([...rootFolders().flatMap(r => [r.path, workDirFor(r)]), join(downloadsDir(), SPARE_WORK)].map(p => resolve(p)))],
  chmod: (path: string, mode: number) => chmod(path, mode),
  /** which platform this is (modes mean what they say only on Linux) */
  platform: (): string => process.platform,
  /** what a build program wrote that ludarr reads (an archive's listing), read without following a link */
  readBuildFile: (path: string, max: number) => readBuildFile(path, max),
  now: (): number => Date.now(),
  /** how often a running step's progress is looked at, and the free space */
  tickMs: 2000,
  roomMs: 10_000,
};

const GBd = 1e9;
const gb = (n: number) => `${(Math.max(0, n) / GBd).toFixed(n >= 100 * GBd ? 0 : 1)} GB`;
const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const msgOf = (e: unknown) => String((e as { message?: unknown })?.message ?? e);
const isCancel = (e: unknown, signal?: AbortSignal) => !!signal?.aborted || msgOf(e) === "cancelled";
const JUNK = /^(__macosx|\.ds_store|thumbs\.db|desktop\.ini)$/i;
/** what {serial} and {version} may become: the identity's own value, letters, digits, dot, dash and underscore only */
const clean = (v: string | null | undefined) => { const s = (v ?? "").replace(/[^A-Za-z0-9._-]/g, ""); return s || null; };

/* ─────────── the make key ─────────── */

/** JSON with every object's keys in order: the same recipe always reads the same */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).filter(k => (v as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
/** the converters' and tools' pinned commits a recipe runs (part of its key) */
export function toolsOf(make: ContentMake, planTools: string | null = null): string[] {
  const out: string[] = [];
  for (const s of make.steps) {
    if ("convert" in s) {
      const w = s.convert.with;
      out.push(typeof w === "string" ? `${w}@${KNOWN_CONVERTERS[w]?.commit ?? "?"}` : `${(w as PinnedTool).repo}@${(w as PinnedTool).commit}`);
    } else if ("run" in s && s.run.tool) out.push(`tools@${planTools ?? "?"}`);
  }
  return [...new Set(out)].sort();
}
/** whether a step runs the pinned program's own code: an .exe inside it, a path into it, or {program} in its argv */
const runsProgram = (s: MakeStep) => "run" in s && (!!s.run.wine || (!!s.run.exe && s.run.exe.includes("/")) || s.run.argv.some(a => a.includes("{program}")));
/** whether the make needs the pinned program: a step runs its code, a tool of the plan's (looked up by its pin), or the
 *  whole-game check reads the program's file list */
const needsProgram = (make: ContentMake) => make.steps.some(s => runsProgram(s) || ("run" in s && !!s.run.tool)) || !!make.input.complete?.list;

/** the make key: the same input digest, recipe, tools and (when a step runs it) program pin make the same product */
export function makeKey(o: { digest: string; make: ContentMake; tools: string[]; program: string | null }): { key: string; recipe: string } {
  const recipe = canonicalJson(o.make);
  const program = o.make.steps.some(runsProgram) ? o.program : null;
  const key = new Bun.CryptoHasher("sha256").update(canonicalJson({ input: o.digest, recipe, tools: o.tools, program })).digest("hex");
  return { key, recipe };
}

/* ─────────── the input ─────────── */

interface Input {
  ref: MakeInputRef;
  path: string; shape: "file" | "folder"; name: string;
  /** its bytes (a file's, with the other volumes of its archive; a folder's files') */
  size: number;
  /** the other volumes of a multi-volume archive, beside it (name.part02.rar …): handed over, linked and listed with it */
  volumes: string[];
  /** what the key is made from: "sha256:…", "sha1:…", "list:…" (a folder's listing) or "stat:…" (a file's name, size, time) */
  digest: string;
  identity: Identity | null;
  gameId: number | null;
  from: MadeInfo["from"];
  /** a made-up folder for a dry run (M14): nothing made from it is kept */
  synthetic: boolean;
}

export { volumesOf } from "../process/volumes";
import { volumesOf } from "../process/volumes";

interface Listing { lines: string[]; files: number; bytes: number; digest: string }
/** every entry of a file or folder by (path, size, time), sorted, links never followed (a link is refused); a file's
 *  other volumes (`also`) are listed with it */
async function listingOf(path: string, o: { signal?: AbortSignal; progress?: (n: number) => void; also?: string[] } = {}): Promise<Listing> {
  const lines: string[] = [];
  let files = 0, bytes = 0, last = 0;
  const top = await lstat(path);
  if (top.isSymbolicLink()) throw new MakeRefused(`${basename(path)} is a link, and game data is taken as it is, never through one`, "form");
  if (top.isFile()) {
    for (const p of [path, ...(o.also ?? [])]) {
      const st = p === path ? top : await lstat(p);
      if (!st.isFile()) throw new MakeRefused(`${basename(p)} is not a file`, "form");
      lines.push(`${basename(p)}\t${st.size}\t${Math.round(st.mtimeMs)}`);
      files++; bytes += st.size;
    }
    return { lines, files, bytes, digest: sha256Text(lines.join("\n")) };
  }
  const walk = async (p: string, rel: string) => {
    if (o.signal?.aborted) throw new Error("cancelled");
    for (const n of (await readdir(p)).sort()) {
      const full = join(p, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(full);
      if (st.isSymbolicLink()) throw new MakeRefused(`${r} in ${basename(path)} is a link, and game data is taken as files only`, "form");
      if (st.isDirectory()) { lines.push(`${r}/\t0\t0`); await walk(full, r); continue; }
      if (!st.isFile()) throw new MakeRefused(`${r} in ${basename(path)} is not a file`, "form");
      lines.push(`${r}\t${st.size}\t${Math.round(st.mtimeMs)}`);
      files++; bytes += st.size;
      if (o.progress && Date.now() - last >= 1000) { last = Date.now(); o.progress(files); }
    }
  };
  await walk(path, "");
  return { lines, files, bytes, digest: sha256Text(lines.join("\n")) };
}
const sha256Text = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** the other volumes of a file input's archive and their bytes (none for a folder) */
async function volumesWith(path: string, shape: "file" | "folder"): Promise<{ volumes: string[]; bytes: number }> {
  if (shape !== "file") return { volumes: [], bytes: 0 };
  const volumes = await volumesOf(path);
  let bytes = 0;
  for (const v of volumes) bytes += (await lstat(v).catch(() => null))?.size ?? 0;
  return { volumes, bytes };
}
/** a digest of one file that also names its other volumes (the first volume's own hash says nothing about the rest) */
const withVolumes = (digest: string, vols: Listing | null) => (vols ? `${digest}+${vols.digest}` : digest);

/** the input a ref names, with what is known of it without reading it (the copy's and the row's facts) */
async function resolveInput(ref: MakeInputRef, o: { gameId: number | null; signal?: AbortSignal; log: (l: string) => void; progress?: (n: number) => void }): Promise<Input> {
  if (ref.from === "copy") {
    const pkg = stmts.packageById.get(ref.packageId) as PackageRow | undefined;
    if (!pkg?.game_id) throw new NeedsFiles("the game's copy is gone from the server");
    const facts = mkdeps.copyFacts(pkg.game_id) ?? await mkdeps.judgeCopy(pkg.game_id);
    if (!facts || facts.packageId !== ref.packageId) throw new NeedsFiles("the game's copy changed since this was queued: it is looked at again");
    const v = await volumesWith(facts.path, facts.shape);
    const vl = v.volumes.length ? await listingOf(v.volumes[0], { also: v.volumes.slice(1) }) : null;
    const digest = withVolumes(facts.sha256 ? `sha256:${facts.sha256}` : `list:${(await listingOf(facts.path, { signal: o.signal, progress: o.progress })).digest}`, vl);
    return { ref, path: facts.path, shape: facts.shape, name: basename(facts.path), size: facts.size + v.bytes, volumes: v.volumes, digest, identity: facts.identity, gameId: pkg.game_id, from: { kind: "copy", packageId: pkg.id, digest }, synthetic: false };
  }
  if (ref.from === "kept") {
    const row = getContent(ref.contentId);
    if (!row || !(await lstat(row.path).catch(() => null))) throw new NeedsFiles("the kept game data this was to be made from is gone");
    const sha1 = contentHashes(row).sha1, sha256 = contentHashes(row).sha256;
    const shape = row.shape === "folder" ? "folder" : "file";
    const v = await volumesWith(row.path, shape);
    const vl = v.volumes.length ? await listingOf(v.volumes[0], { also: v.volumes.slice(1) }) : null;
    const digest = withVolumes(sha256 ? `sha256:${sha256}` : sha1 ? `sha1:${sha1}` : `list:${(await listingOf(row.path, { signal: o.signal, progress: o.progress })).digest}`, vl);
    return { ref, path: row.path, shape, name: row.name, size: row.size + v.bytes, volumes: v.volumes, digest, identity: contentIdentity(row), gameId: row.game_id, from: { kind: "kept", contentId: row.id, digest }, synthetic: false };
  }
  const st = await lstat(ref.path).catch(() => null);
  if (!st) throw new NeedsFiles(`${basename(ref.path)} is gone`);
  if (st.isSymbolicLink()) throw new MakeRefused(`${basename(ref.path)} is a link, and game data is taken as it is, never through one`, "form");
  const shape = st.isDirectory() ? "folder" : "file";
  const v = await volumesWith(ref.path, shape);
  const listing = ref.digest && !v.volumes.length ? null : await listingOf(ref.path, { signal: o.signal, progress: o.progress, also: v.volumes });
  const digest = ref.digest ? withVolumes(`sha256:${ref.digest}`, v.volumes.length ? listing : null) : st.isFile() ? `stat:${listing!.digest}` : `list:${listing!.digest}`;
  return {
    ref, path: ref.path, shape, name: basename(ref.path), size: st.isFile() ? st.size + v.bytes : listing?.bytes ?? 0, volumes: v.volumes, digest,
    identity: null, gameId: o.gameId, from: { kind: ref.from, fetchId: ref.fetchId ?? null, digest }, synthetic: false,
  };
}

/** what a sealed input is, in the words the admin reads */
function sealedWords(id: Identity | null, name: string): string {
  const v = id?.masterVersion ?? id?.version;
  const facts = [id?.region, id?.serial, v ? v.replace(/^0+(?=\d)/, "") : null].filter(Boolean).join(", ");
  const what = id?.shape === "bd-image" ? "the retail disc as a PC drive reads it" : id?.shape === "pkg" ? "a console install package" : "game data for the console";
  return `${name} is ${what}${facts ? ` (${facts})` : ""}: its game data is encrypted for the console, and nothing can open it`;
}
/** a verdict's refusal: another title, version or a patch is never the game; anything else is about its form */
const blockOf = (why: string | null): "identity" | "form" => (/another game|another title|version|patch|add-on|addon|sealed|encrypted/i.test(why ?? "") ? "identity" : "form");

/* ─────────── a make in progress ─────────── */

interface Run {
  resumeKey?: string;
  mode: "job" | "plan" | "full";
  content: ContentPlan; make: ContentMake; platform: string;
  plan: PlanRow | null;
  /** <work>/make: everything this make writes; cwd: the steps' folder (the build user's while one runs) */
  base: string; cwd: string; prep: string; out: string; tools: string;
  program: string | null; programSha: string | null; planTools: string | null; pinned: PinnedProgram | null;
  input: Input; inPath: string;
  /** names inside {prep} that are folders of the read-only input (nothing on disk) */
  aliases: Map<string, string>;
  serial: string | null; version: string | null; identity: Identity | null;
  picked: { path: string; identity: Identity | null; bytes: number } | null;
  productName: string | null;
  /** the archive's members in 'plan' mode (nothing unpacked): what {prep}/<to> would hold */
  virtual: Map<string, Map<string, number>>;
  before: Listing | null;
  signal: AbortSignal; log: (line: string) => void; progress: (p: number, message: string) => void;
  /** how far it is (the last progress said): the clear-up at its end is said at the same place */
  at: number;
  warnings: string[];
  floor: number;
  /** marker paths the input's description found (a pick that finds none of them looks in the wrong place) */
  markersSeen: string[];
  converters: Map<string, string>;
  /** a folder input that is the game folder itself (its whole-game check is made before any step) */
  rootIsGame: boolean;
  /** the job's folder on the downloads folder's volume that holds {prep} (the library could not hold the unpack), or null:
   *  {prep} is in the job's own folder */
  away: string | null;
  /** what an archive unpacks to, by its listing (the pre-judge read it), or null when that is not known */
  unpackBytes: number | null;
}

/** a fresh folder `base`, or base-2, base-3 … when it is there */
async function freshDir(base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const p = i === 1 ? base : `${base}-${i}`;
    if (!(await lstat(p).catch(() => null))) { await mkdir(p, { recursive: true }); return p; }
  }
}

async function newRun(o: { mode: Run["mode"]; work: string; content: ContentPlan; plan: PlanRow | null; input: Input; signal: AbortSignal; log: (l: string) => void; progress: (p: number, m: string) => void }): Promise<Run> {
  const base = await freshDir(join(o.work, "make"));
  const cwd = join(base, "run");
  const r: Run = {
    mode: o.mode, content: o.content, make: o.content.make!, platform: o.content.platform, plan: o.plan,
    base, cwd, prep: join(cwd, "prep"), out: join(cwd, "out"), tools: join(base, "tools"),
    program: null, programSha: null, planTools: null, pinned: o.plan ? planPinned(o.plan) : null, input: o.input, inPath: o.input.path,
    aliases: new Map(), serial: clean(o.input.identity?.serial), version: clean(o.input.identity?.version), identity: o.input.identity,
    picked: null, productName: null, virtual: new Map(), before: null, signal: o.signal, log: o.log, at: 0,
    progress: (p, m) => { r.at = p; o.progress(p, m); },
    warnings: [], floor: mkdeps.keepFreeBytes(), markersSeen: [], converters: new Map(), rootIsGame: false, away: null, unpackBytes: null,
  };
  for (const d of [r.prep, r.out, r.tools]) await mkdir(d, { recursive: true });
  return r;
}
const say = (r: Run, line: string) => r.log(line);

/* ─────────── judging the input ─────────── */

/** the input judged before any step (see the file header, 2) */
async function judgeInput(r: Run, o: { complete: boolean }): Promise<InputDescription> {
  const input = r.input, mi = r.make.input;
  const d = await mkdeps.describeInput(input.path);
  const identity = d.identity ?? input.identity;
  r.identity = identity ?? r.identity;
  r.serial ??= clean(identity?.serial); r.version ??= clean(identity?.version);
  r.markersSeen = d.markers ?? [];
  if ((d.sealed || identity?.sealed) && !takesMakeFile(mi, input.shape, input.name)) {
    const copy = input.ref.from === "copy" && input.gameId ? mkdeps.copyServes(input.gameId, r.content) : null;
    throw new MakeRefused(copy?.serves === "no" && copy.why ? `the game's copy (${input.name}) is ${copy.why}` : sealedWords(identity, input.name), "identity");
  }
  const shape = input.shape;
  if (mi.shape !== "either" && mi.shape !== shape) throw new MakeRefused(`${input.name} is a ${shape}, and this is made from ${mi.shape === "folder" ? "the game folder" : "one file"}`, "form");
  const v = mkdeps.inputMatches(mi, { platform: identity?.platform ?? r.platform, name: input.name, size: input.size, hashes: {}, identity, shape });
  if (!v.ok) throw new MakeRefused(`${input.name} is ${v.why ?? "not what this is made from"}`, blockOf(v.why));
  say(r, `${input.name} (${input.shape}, ${gb(input.size)}): ${identity?.serial ? `${identity.serial}${identity.version ? ` ${identity.version}` : ""}${identity.category ? `, ${identity.category}` : ""}` : "no identity read yet"}${d.format ? ` · ${d.format}` : ""}`);
  // the marker: in a folder found by a walk, in an archive by its listing (a listing cut short says nothing)
  if (mi.marker) {
    const want = [mi.marker, ...(mi.also ?? [])];
    if (shape === "folder") {
      const found = await gameFolders(input.path, mi.marker, mi.also ?? [], 6, r.signal);
      if (!found.length) throw new MakeRefused(`nothing in ${input.name} holds ${want.join(" and ")}: it is not the game's folder`, "form");
      r.rootIsGame = found.length === 1 && found[0] === input.path;
      if (o.complete && mi.complete && r.rootIsGame) await wholeGame(r, input.path, input.name);
    } else if (d.members && d.listing !== "none") {
      const paths = d.members.filter(m => !m.dir).map(m => m.path.replace(/\\/g, "/"));
      const holds = paths.some(p => p === mi.marker || p.endsWith(`/${mi.marker}`));
      if (!holds && d.members.length < 400) throw new MakeRefused(`nothing in ${input.name} is ${mi.marker}: it does not hold the game's folder`, "form");
    }
  }
  return d;
}

/** the lines of the program's list of the game's files (make.input.complete.list), or null when this run has no program
 *  (a try: said as a warning; a make: the plan's fault) */
async function programList(r: Run, c: NonNullable<MakeInput["complete"]>): Promise<string[] | null> {
  if (!c.list) return null;
  if (!r.program) {
    if (r.mode !== "job") { r.warnings.push(`whether it is the whole game is judged by the program's ${c.list.path}, and this try has no program (try_plan first)`); return null; }
    throw new PlanFault("make", "the whole-game check reads a file of the program, and the program is not here");
  }
  const text = await readFile(join(r.program, ...c.list.path.split("/")), "utf8").catch(() => null);
  if (text === null) throw new PlanFault("make", `the program has no ${c.list.path} (the file listing the game's files)`);
  // paths are the game folder's own (Kyty's lists are; a leading app0/ is dropped, as src/ways/inspect.ts listedPath does)
  return text.split(/\r?\n/).map(l => l.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^app0\//i, "")).filter(l => l && !l.startsWith("#"));
}

/** a refusal for not being the whole game, said once ("<name> is an update or a part of the game, not the whole game: …") */
const notWhole = (name: string, why: string | null): string =>
  !why ? `${name} is ${PART}` : why.startsWith(PART) ? `${name} is ${why}` : `${name} is not taken as the whole game: ${why}`;

/** the folder is the whole game, not an update or a part (make.input.complete; list: the program's own file list, which
 *  judges only the title and version it is for — another version is judged by its size: src/ways/inspect.ts listJudges) */
async function wholeGame(r: Run, dir: string, name: string, id: Identity | null = r.identity): Promise<void> {
  const c0 = r.make.input.complete;
  if (!c0 || r.input.synthetic) return;
  const j = listJudges(c0, id);
  if (!j.judges) say(r, j.note);
  const c = j.judges ? c0 : listFallback(c0);
  const list = await programList(r, c);
  if (c.list && !list && !c.minBytes && !c.minFiles) return;
  // a walk of a game's 100,000 files and the program's list: said as it goes, never a silent minute
  const stop = ticker(r, 0.05, `checking ${name} is the whole game`);
  const v = await mkdeps.completeness(dir, list ? c : { ...c, list: undefined }, { list, identity: id ?? undefined }).finally(stop);
  if (v.note) say(r, v.note);
  if (!v.ok) throw new MakeRefused(notWhole(name, v.why), "identity");
  say(r, `${name} is the whole game${list ? ` (the program's list of its files: ${c.list!.path})` : ""}`);
}

/** the folders under `dir` (≤ depth levels down) holding `marker` and every `also` beside it; a folder that holds them is
 *  not searched further, and every folder's marker is looked at before it is walked (a dump of 100,000 files is found at
 *  once). What it cannot read is reported (src/transport.ts noted): a walk of the seedbox's folder that missed the marker
 *  through a failed read refuses nothing (src/remote.ts steadyOrThrow) */
async function gameFolders(dir: string, marker: string, also: string[], depth: number, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  let seen = 0;
  const holds = async (d: string) => {
    for (const f of [marker, ...also]) { const at = join(d, ...f.split("/")); if (!(await mkdeps.lstat(at).catch(noted(at)))?.isFile()) return false; }
    return true;
  };
  const walk = async (d: string, level: number) => {
    if (signal?.aborted) throw new Error("cancelled");
    if (++seen > 20_000) return;
    if (await holds(d)) { out.push(d); return; }
    if (level >= depth) return;
    for (const n of ((await readdir(d).catch(noted(d))) ?? []).sort()) {
      const p = join(d, n);
      const st = await mkdeps.lstat(p).catch(noted(p));
      if (st?.isDirectory()) await walk(p, level + 1);
    }
  };
  await walk(dir, 0);
  return out;
}

/** the same in an archive's listing (nothing unpacked): the folders, relative to its root ("" the root itself) */
function gameFoldersIn(files: Map<string, number>, marker: string, also: string[], depth: number): string[] {
  const out: string[] = [];
  for (const p of files.keys()) {
    if (!(p === marker || p.endsWith(`/${marker}`))) continue;
    const dir = p === marker ? "" : p.slice(0, p.length - marker.length - 1);
    if (dir && dir.split("/").length > depth) continue;
    if (also.every(a => files.has(dir ? `${dir}/${a}` : a))) out.push(dir);
  }
  return [...new Set(out)].filter(d => !out.some(o => o !== d && d.startsWith(o ? `${o}/` : "") && o.length < d.length)).sort();
}

/* ─────────── room, hand-over, the listing ─────────── */

/** what the downloads folder keeps free when a make unpacks there: its download clients write there too, and a full one
 *  stops every download */
export const SPARE_KEEP_FREE = 20e9;
/** file systems a make never unpacks onto: network shares and FUSE mounts of remote stores (/remote is the seedbox over
 *  SFTP, rclone) */
const NETWORK_FS = /^(nfs4?|cifs|smb3?|smbfs|9p|afs|ceph|glusterfs|lustre|davfs|fuse\.(rclone|sshfs|s3fs|gcsfuse|goofys|davfs2|curlftpfs|smbnetfs|ftpfs))$/i;

/** the mount a path is on: the longest mount point above it in the mount table (Linux), or null */
function mountOf(path: string): { at: string; fstype: string; options: string[] } | null {
  let text = "";
  try { text = readFileSync("/proc/self/mounts", "utf8"); } catch { return null; }
  const p = resolve(path);
  let best: { at: string; fstype: string; options: string[] } | null = null;
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f.length < 4) continue;
    const at = f[1].replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (!(p === at || p.startsWith(at.endsWith("/") ? at : `${at}/`))) continue;
    if (!best || at.length >= best.at.length) best = { at, fstype: f[2], options: f[3].split(",") };
  }
  return best;
}

/** are two folders on one volume: the same device, and (behind a union mount such as Unraid's user shares, where every
 *  share has one device) the same size and free space */
async function sameVolume(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  if (!sa || !sb) return false;
  if (sa.dev !== sb.dev) return false;
  const [da, db] = await Promise.all([mkdeps.diskSpace(a).catch(() => null), mkdeps.diskSpace(b).catch(() => null)]);
  if (!da || !db) return true;
  return da.total === db.total && Math.abs(da.free - db.free) < 1e9;
}

/**
 * The downloads folder as the place for an unpack of `need` bytes: its path and free space, or why it cannot be one (none
 * there, read-only, a network mount, the library's own disk, too full, or not writable — `probe` writes and removes a
 * file to tell; the runner's scratch gate looks without writing).
 */
async function spareFor(base: string, need: number, o: { probe: boolean }): Promise<{ dir: string; free: number } | { why: string }> {
  const dir = resolve(mkdeps.downloadsDir());
  if (!(await stat(dir).catch(() => null))?.isDirectory()) return { why: `there is no downloads folder at ${dir}` };
  const m = mkdeps.mountOf(dir);
  if (m?.options.includes("ro")) return { why: `the downloads folder (${dir}) is mounted read-only` };
  if (m && NETWORK_FS.test(m.fstype)) return { why: `the downloads folder (${dir}) is a network mount (${m.fstype})` };
  if (await sameVolume(dir, base)) return { why: `the downloads folder (${dir}) is on the library's own disk` };
  const s = await mkdeps.diskSpace(dir).catch(() => null);
  if (!s) return { why: `the free space of the downloads folder (${dir}) cannot be read` };
  if (s.free - SPARE_KEEP_FREE < need) return { why: `the downloads folder (${dir}) has ${gb(Math.max(0, s.free - SPARE_KEEP_FREE))} free above the ${gb(SPARE_KEEP_FREE)} it keeps for the download clients, and the unpack needs about ${gb(need)}` };
  if (o.probe) {
    const top = join(dir, SPARE_WORK), probe = join(top, `.probe-${process.pid}-${mkdeps.now()}`);
    try { await mkdir(top, { recursive: true }); await writeFile(probe, "", { flag: "wx" }); }
    catch (e) { return { why: `the downloads folder (${dir}) cannot be written (${(e as { code?: string })?.code ?? msgOf(e)})` }; }
    finally { await rm(probe, { force: true }).catch(() => {}); }
  }
  return { dir, free: s.free };
}

/** the job id of a folder inside a job's folder (<…>/job-<id>/…), the outermost one */
const jobIdOf = (p: string): number | null => { const m = /[\\/]job-(\d+)(?=[\\/]|$)/.exec(resolve(p)); return m ? Number(m[1]) : null; };

/**
 * Where a job may unpack about `unpack` bytes of an archive (a content job's download it unpacks itself, not as a make's
 * input): its own folder `work` on the library when the library holds the unpack plus `here` more written there after it
 * above LIBRARY_KEEP_FREE_GB; else the job's folder on the downloads folder's volume (the same rules as a make's {prep}:
 * see the file header, 3) when the library still holds the `away` bytes written there after it — or why neither can, in
 * words with the numbers. The folder away is the one the runner removes when the job ends.
 */
export async function unpackRoom(work: string, unpack: number, o: { here: number; away: number }): Promise<{ dir: string; away: boolean } | { why: string }> {
  const floor = mkdeps.keepFreeBytes();
  const space = await mkdeps.diskSpace(work).catch(() => null);
  if (!space) return { dir: work, away: false };
  const left = space.free - floor;
  if (left >= unpack + o.here) return { dir: work, away: false };
  const keep = `above the ${gb(floor)} it keeps free (Settings → General → Import)`;
  const id = jobIdOf(work);
  const spare = id != null ? await spareFor(work, unpack, { probe: true }) : { why: "the job has no folder of its own" };
  if (!("dir" in spare))
    return { why: `not enough room: unpacking ${gb(unpack)} and keeping what it holds needs about ${gb(unpack + o.here)} on the library, and ${gb(Math.max(0, left))} is free there ${keep}; the downloads folder cannot take the unpack: ${spare.why}` };
  if (left < o.away)
    return { why: `not enough room: what it keeps (about ${gb(o.away)}) is written on the library, and ${gb(Math.max(0, left))} is free there ${keep}; the unpack (about ${gb(unpack)}) would go on the downloads folder (${spare.dir}, ${gb(spare.free)} free)` };
  const away = spareJobFolder(spare.dir, id!);
  await mkdir(away, { recursive: true });
  await closeJobFolder(away);
  return { dir: away, away: true };
}

/** {prep} moved to the downloads folder's volume: the job's folder there (a leftover of its own from before a restart set
 *  aside first), closed to every other job, an empty prep in it */
async function prepAway(r: Run, dl: string): Promise<void> {
  const id = jobIdOf(r.base);
  const away = id != null ? spareJobFolder(dl, id) : join(dl, SPARE_WORK, `make-${process.pid}-${mkdeps.now()}`);
  if (await lstat(away).catch(() => null)) {
    await clearInterruptedWork(away);
  }
  await mkdir(join(away, "prep"), { recursive: true });
  await closeJobFolder(away);
  await rm(r.prep, { recursive: true, force: true }).catch(() => {});
  r.away = away;
  r.prep = join(away, "prep");
}

/** what the unpack and the product take: an archive's listing when it was read, else the input's size */
function makeNeeds(r: Run): { unpack: number; product: number } {
  const unpacks = r.make.steps.some(s => "unpack" in s) && r.input.shape === "file";
  const unpack = unpacks ? Math.max(r.input.size, r.unpackBytes ?? 0) : 0;
  return { unpack, product: unpacks ? unpack : r.input.size };
}

/**
 * The steps' writes must fit above what the library keeps free (EnvError 'room' before anything is written). An unpack the
 * library cannot hold beside the product goes on the downloads folder's volume (see the file header, 3); the room words
 * name each volume and its numbers.
 */
async function roomBefore(r: Run): Promise<void> {
  const { unpack, product } = makeNeeds(r);
  const space = await mkdeps.diskSpace(r.base).catch(() => null);
  if (!space) return;
  const left = space.free - r.floor;
  if (left >= unpack + product) return;
  const keep = `above the ${gb(r.floor)} it keeps free (Settings → General → Import)`;
  if (!unpack || r.mode !== "job")
    throw new EnvError("room", `not enough room: making the game data needs about ${gb(unpack + product)} on the library, and ${gb(Math.max(0, left))} is free ${keep}`);
  const spare = await spareFor(r.base, unpack, { probe: left >= product });
  if ("dir" in spare) {
    if (left < product)
      throw new EnvError("room", `not enough room: what it makes (about ${gb(product)}) is written on the library, and ${gb(Math.max(0, left))} is free there ${keep}; the unpack (about ${gb(unpack)}) would go on the downloads folder (${spare.dir}, ${gb(spare.free)} free)`);
    await prepAway(r, spare.dir);
    say(r, `{prep} is on the downloads folder's volume (${r.away}, ${gb(spare.free)} free): the library has ${gb(Math.max(0, left))} free ${keep}, and unpacking takes about ${gb(unpack)} beside the ${gb(product)} it makes there`);
    return;
  }
  if (left < product)
    throw new EnvError("room", `not enough room: what it makes (about ${gb(product)}) is written on the library, and ${gb(Math.max(0, left))} is free there ${keep}; the unpack (about ${gb(unpack)}) cannot go elsewhere: ${spare.why}`);
  throw new EnvError("room", `not enough room: making the game data unpacks about ${gb(unpack)} and writes about ${gb(product)} on the library, and ${gb(Math.max(0, left))} is free there ${keep}; the downloads folder cannot take the unpack: ${spare.why}`);
}

/** the input handed over read-only (see the file header, 4) */
async function handOver(r: Run): Promise<void> {
  const input = r.input;
  let looked = 0, cleared = 0, opened = 0;
  const uids = new Set(SANDBOX_UIDS);
  const linux = mkdeps.platform() === "linux";
  // modes are changed only where they are ludarr's to change: an earlier download or a client's folder (the seedbox's
  // read-only mount) keeps its modes, and is refused in words when the build programs cannot read it
  const own = mkdeps.ownFolders();
  const ours = (p: string) => { const a = resolve(p); return own.some(d => a === d || a.startsWith(d.endsWith(sep) ? d : d + sep)); };
  let last = 0;
  const visit = async (p: string, rel: string) => {
    if (r.signal.aborted) throw new Error("cancelled");
    const st = await mkdeps.lstat(p);
    looked++;
    if (Date.now() - last >= 1000) { last = Date.now(); r.progress(0.02, `handing the game data over read-only · ${looked.toLocaleString("en-US")} entries looked at`); }
    if (st.isSymbolicLink()) throw new MakeRefused(`${rel || input.name} is a link, and game data is taken as files only`, "form");
    if (!st.isFile() && !st.isDirectory()) throw new MakeRefused(`${rel || input.name} is not a file`, "form");
    if (uids.has(st.uid)) throw new MakeRefused(`${rel || input.name} was written by a build program, not by you: it is not taken`, "identity");
    const mode = st.mode & 0o7777;
    // no write for the build programs (they are 'others' to everything here), and read for them: a game file closed to
    // others (a download client's 0600) is opened for reading rather than left for the admin to fix
    let want = mode & ~0o022;
    if (linux) want |= st.isDirectory() ? 0o005 : 0o004;
    if (want !== mode) {
      if (!ours(p)) {
        // not ludarr's: read where it is, as it is (the listing before and after the steps tells any change); a build
        // program that cannot read it gets nothing to make from
        const reads = st.isDirectory() ? 0o005 : 0o004;
        if (linux && (mode & reads) !== reads) throw new EnvError("tool", `the build programs cannot read ${rel || input.name}: it is closed to others (mode ${mode.toString(8).padStart(4, "0")}), and it lies outside ludarr's own folders, whose modes ludarr does not change`);
      } else {
        try { await mkdeps.chmod(p, want); }
        catch (e) { throw new EnvError("tool", `${rel || input.name} cannot be made read-only for the build programs (${(e as { code?: string })?.code ?? msgOf(e)})`); }
        if (mode & 0o022) cleared++;
        if (want & ~mode) opened++;
      }
    }
    if (st.isDirectory()) for (const n of await readdir(p)) await visit(join(p, n), rel ? `${rel}/${n}` : n);
  };
  r.progress(0.02, "handing the game data over read-only");
  for (const v of [input.path, ...input.volumes]) await visit(v, v === input.path ? "" : basename(v));
  say(r, `the game data is read-only for the build programs: ${looked.toLocaleString("en-US")} entr${looked === 1 ? "y" : "ies"} looked at${cleared ? `, ${cleared} had write for group or others (cleared)` : ""}${opened ? `, ${opened} could not be read by them (opened for reading)` : ""}`);
  if (input.shape === "file") {
    // {in}: the same file by a second name in the job's folder (never a copy), each volume of an archive beside the first;
    // its own path (and its volumes where they are) when no link can be made
    const dir = join(r.base, "in");
    await mkdir(dir, { recursive: true });
    const made: string[] = [];
    try {
      for (const v of [input.path, ...input.volumes]) { const at = join(dir, placedName(basename(v))); await mkdeps.link(v, at); made.push(at); }
      r.inPath = made[0];
      say(r, `{in}: ${input.name}${input.volumes.length ? ` and its ${input.volumes.length} other volume${input.volumes.length === 1 ? "" : "s"}` : ""}, linked into the job's folder`);
    } catch (e) {
      for (const at of made) await rm(at, { force: true }).catch(() => {});
      r.inPath = input.path;
      say(r, `{in}: ${input.name} where it is (no link here: ${(e as { code?: string })?.code ?? msgOf(e)})`);
    }
  }
  // a folder (or a file no link could be made of) is read where it is: every folder on the way must let others through
  if (linux && r.inPath === input.path) {
    const worker = mkdeps.workerIds(r.base);
    for (let d = dirname(input.path); ; d = dirname(d)) {
      const st = await mkdeps.lstat(d).catch(() => null);
      const execute = worker && st?.uid === worker.uid ? 0o100 : worker && st?.gid === worker.gid ? 0o010 : 0o001;
      if (st && !(st.mode & execute)) throw new EnvError("tool", `the build programs cannot reach the game data: ${d} is closed to this build user (mode ${(st.mode & 0o7777).toString(8).padStart(4, "0")})`);
      if (dirname(d) === d) break;
    }
  }
  r.before = await listingOf(input.path, { signal: r.signal, also: input.volumes, progress: n => r.progress(0.03, `listing the game data before it is made · ${n.toLocaleString("en-US")} files`) });
}

/** the input is as it was before the steps (EnvError 'changed': it is looked at again later) */
async function unchanged(r: Run): Promise<void> {
  if (!r.before) return;
  const now = await listingOf(r.input.path, { signal: r.signal, also: r.input.volumes, progress: n => r.progress(0.85, `checking the game data did not change · ${n.toLocaleString("en-US")} files`) }).catch(() => null);
  if (!now || now.digest !== r.before.digest) {
    const was = new Set(r.before.lines), is = new Set(now?.lines ?? []);
    const first = now?.lines.find(l => !was.has(l))?.split("\t")[0] ?? r.before.lines.find(l => !is.has(l))?.split("\t")[0];
    throw new EnvError("changed", `the game data changed while it was being made${first ? ` (${first})` : ""}: it is made again once it stays as it is`);
  }
}

/* ─────────── watching a long step ─────────── */

/** a folder's size so far: walked again only when the last walk was quick next to the time since (a tree of 100,000
 *  files is not walked every two seconds) */
function treeSizer(dir: string): () => Promise<number> {
  let last = 0, lastAt = 0, took = 0;
  return async () => {
    if (Date.now() - lastAt < 3 * took) return last;
    const t0 = Date.now();
    let n = 0;
    const walk = async (p: string) => {
      for (const e of await readdir(p).catch(() => [] as string[])) {
        const st = await lstat(join(p, e)).catch(() => null);
        if (!st) continue;
        if (st.isDirectory()) await walk(join(p, e)); else n += st.size;
      }
    };
    await walk(dir);
    took = Date.now() - t0; lastAt = Date.now(); last = n;
    return n;
  };
}
const fileSizer = (file: string) => async () => (await stat(file).catch(() => null))?.size ?? 0;

/**
 * `fn` (a step's program) with its progress said every tick ("<what> · 3.1 of 9.8 GB · 2:41") and the free space looked at
 * every 10 s: below what the library keeps free the step is stopped (EnvError 'room').
 */
async function watched<T>(r: Run, w: { band: [number, number]; total: number; measure: () => Promise<number>; words: (bytes: number) => string }, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  r.signal.addEventListener("abort", onAbort, { once: true });
  const t0 = mkdeps.now();
  let short: { free: number; where: "library" | "downloads" } | null = null, busy = false, roomBusy = false;
  const tell = async () => {
    if (busy) return;
    busy = true;
    try {
      const bytes = await w.measure().catch(() => 0);
      const p = w.total > 0 ? Math.min(0.99, bytes / w.total) : 0;
      r.progress(w.band[0] + (w.band[1] - w.band[0]) * p, `${w.words(bytes)} · ${clock(mkdeps.now() - t0)}`);
    } finally { busy = false; }
  };
  const room = async () => {
    if (roomBusy) return;
    roomBusy = true;
    try {
      const s = await mkdeps.diskSpace(r.base).catch(() => null);
      if (s && s.free < r.floor) { short = { free: s.free, where: "library" }; ac.abort(); return; }
      const d = r.away ? await mkdeps.diskSpace(r.away).catch(() => null) : null;
      if (d && d.free < SPARE_KEEP_FREE) { short = { free: d.free, where: "downloads" }; ac.abort(); }
    } finally { roomBusy = false; }
  };
  void tell();
  const t1 = setInterval(() => { void tell(); }, mkdeps.tickMs);
  const t2 = setInterval(() => { void room(); }, mkdeps.roomMs);
  try {
    const res = await fn(ac.signal);
    if (short) throw roomError(r, short);
    return res;
  } catch (e) {
    if (short) throw roomError(r, short);
    throw e;
  } finally {
    clearInterval(t1); clearInterval(t2);
    r.signal.removeEventListener("abort", onAbort);
  }
}
const roomError = (r: Run, s: { free: number; where: "library" | "downloads" }) => new EnvError("room", s.where === "downloads"
  ? `not enough room: the downloads folder fell to ${gb(s.free)} free while the game data was unpacked there (${r.away}), below the ${gb(SPARE_KEEP_FREE)} it keeps for the download clients: stopped, and tried again later`
  : `not enough room: the library fell to ${gb(s.free)} free while the game data was being made, below the ${gb(r.floor)} it keeps free (Settings → General → Import): stopped, and tried again later`);

/* ─────────── paths inside {prep} ─────────── */

/** the absolute path of `rel` inside {prep}, refusing a link on the way (`create` makes the folders that are missing). A
 *  path that is read goes through the names that stand for the input's own folders; one that is written (`write`) never
 *  does: nothing is ever written into the input */
async function inPrep(r: Run, rel: string, o: { create?: boolean; write?: boolean } = {}): Promise<string> {
  const segs = rel.split("/");
  for (let n = segs.length; n > 0; n--) {
    const target = r.aliases.get(segs.slice(0, n).join("/"));
    if (target && o.write) throw new PlanFault("make", `{prep}/${rel} is the input's own folder, which is read-only`);
    if (target) return join(target, ...segs.slice(n));
  }
  let cur = r.prep;
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i]);
    const st = await lstat(cur).catch(() => null);
    if (st?.isSymbolicLink()) throw new PlanFault("make", `${segs.slice(0, i + 1).join("/")} in {prep} is a link, and nothing is written through one`);
    if (i < segs.length - 1 && !st && o.create) await mkdir(cur);
  }
  return cur;
}
/** the folder a pick looks in: {in}, {prep} or a folder below either */
async function within(r: Run, w: string): Promise<string> {
  const m = /^\{(in|prep)\}(?:\/(.+))?$/.exec(w);
  if (!m) throw new PlanFault("make", `a pick looks within {in} or {prep}, and this one says ${w}`);
  if (m[1] === "in") {
    if (r.input.shape !== "folder") throw new PlanFault("make", "a pick within {in} needs a folder input: unpack the file first");
    return m[2] ? join(r.inPath, ...m[2].split("/")) : r.inPath;
  }
  return m[2] ? inPrep(r, m[2]) : r.prep;
}

/** the values a step's argv may name (a name inside {prep} that stands for the input's folder becomes that folder) */
function fillFor(r: Run, wine: boolean): Record<string, () => string> {
  const at = (p: string) => (wine ? winPath(p) : p);
  const f: Record<string, () => string> = {
    in: () => at(r.inPath), prep: () => at(r.prep),
    out: () => at(join(r.out, productName(r))),
    serial: () => r.serial ?? "{serial}", version: () => r.version ?? "{version}",
    program: () => (r.program ? at(r.program) : "{program}"),
  };
  [...r.aliases.values()].forEach((target, i) => { f[`alias${i}`] = () => at(target); });
  return f;
}
function rewriteArgv(r: Run, argv: string[]): string[] {
  const names = [...r.aliases.keys()];
  return argv.map(a => {
    for (const [i, as] of names.entries()) {
      const head = `{prep}/${as}`;
      if (a === head || a.startsWith(`${head}/`)) return `{alias${i}}${a.slice(head.length)}`;
    }
    return a;
  });
}
/** the product's name with the game data's own serial and version */
function productName(r: Run): string {
  if (r.productName) return r.productName;
  const raw = r.make.output.name;
  for (const k of ["serial", "version"] as const) if (raw.includes(`{${k}}`) && !r[k]) throw new MakeRefused(`nothing in ${r.input.name} says its ${k}, which the made file's name holds`, "form");
  const name = raw.replace(/\{serial\}/g, () => r.serial!).replace(/\{version\}/g, () => r.version!);
  if (placedName(name) !== name) throw new PlanFault("make", `the made file's name ${name} is not a safe file name`);
  r.productName = name;
  return name;
}
const unfilledWords = (n: number) => (p: string) =>
  p === "serial" || p === "version" ? `make step ${n} needs the game data's ${p}, and nothing in it says it`
    : p === "program" ? `make step ${n} needs the program, and it is not here` : `make step ${n} needs {${p}}, and it cannot be given here`;

/* ─────────── the steps ─────────── */

/** how much of the progress each step is worth: the unpack and the step that writes the product carry the data */
function bands(r: Run, from: number, to: number): [number, number][] {
  const w = r.make.steps.map(s => ("unpack" in s ? 6 : ("convert" in s || "run" in s) && JSON.stringify(s).includes("{out}") ? 8 : 0.3));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  let at = from;
  return w.map(x => { const b: [number, number] = [at, at + (to - from) * (x / total)]; at = b[1]; return b; });
}

async function runSteps(r: Run, o: { stopBefore?: "convert" | null } = {}): Promise<{ stopped: number | null }> {
  const b = bands(r, 0.06, 0.84);
  for (const [i, s] of r.make.steps.entries()) {
    const n = i + 1;
    if (r.signal.aborted) throw new Error("cancelled");
    if (o.stopBefore && ("convert" in s || "run" in s)) return { stopped: n };
    if ("unpack" in s) await unpackStep(r, n, s.unpack, b[i]);
    else if ("pick" in s) await pickStep(r, n, s.pick);
    else if ("convert" in s) await convertStep(r, n, s.convert, b[i]);
    else if ("run" in s) await runStep(r, n, s.run, b[i]);
    else if ("remove" in s) await removeStep(r, n, s.remove);
    else if ("move" in s) await moveStep(r, n, s.move);
  }
  return { stopped: null };
}

/** an archive's member list, as 7z reads it (path → size; folders left out) */
async function membersOf(r: Run): Promise<Map<string, number>> {
  const t = pdeps.tools();
  if (!t.sevenZip || !t.bash) throw new EnvError("tool", `nothing on this server can list ${r.input.name} (7z)`);
  const out = join(sandboxDirs(r.base).scratch, "members.txt");
  await rm(out, { force: true }).catch(() => {});
  const res = await sandboxExec([t.bash, "-c", `"$1" l -slt -ba -- "$2" > "$3"`, "list", t.sevenZip, r.inPath, out], { work: r.base, cwd: r.base, timeoutMs: 600_000, signal: r.signal, maxOutput: 4000, noNetwork: true });
  if (r.signal.aborted) throw new Error("cancelled");
  await stopUnder(r.base).catch(() => 0);
  // written by the build user: read without following a link (one there could point at any file of root's)
  const text = (await mkdeps.readBuildFile(out, 512 * 2 ** 20))?.toString("utf8") ?? "";
  // 7z's exit 1 is a warning (the listing is whole); a fatal error or the time running out leaves at most a part of it,
  // which must never read as "the game's folder is not in it"
  if (res.timedOut || (res.code !== 0 && res.code !== 1)) {
    if (!text) throw new MakeRefused(`${r.input.name} cannot be opened as an archive (7z ${res.timedOut ? "ran out of time" : `exit ${res.code}`})`, "form");
    throw new MakeRefused(`${r.input.name} could be listed only in part (7z ${res.timedOut ? "ran out of time" : `exit ${res.code}`}: ${(res.stderr || res.stdout).trim().split("\n").pop()?.slice(0, 160) ?? ""}): a volume may be missing or the archive is damaged`, "form");
  }
  const files = new Map<string, number>();
  for (const block of text.split(/\r?\n\r?\n/)) {
    const path = /^Path = (.+)$/m.exec(block)?.[1]?.trim().replace(/\\/g, "/");
    if (!path) continue;
    const dir = /^Folder = \+$/m.test(block) || /^Attributes = D/m.test(block);
    if (!dir) files.set(path, Number(/^Size = (\d+)$/m.exec(block)?.[1] ?? 0));
  }
  return files;
}

/** unpack: the input file into {prep}/<to> by the system's archiver (see the file header, 5) */
async function unpackStep(r: Run, n: number, s: { to: string; only?: string[] }, band: [number, number]): Promise<void> {
  if (r.input.shape === "folder") {
    // a folder needs no unpacking: <to> is the folder itself, read-only, and nothing is written
    r.aliases.set(s.to, r.inPath);
    say(r, `make ${n}: ${r.input.name} is a folder already: {prep}/${s.to} is that folder (read-only)`);
    return;
  }
  if (r.mode === "plan") {
    const members = await membersOf(r);
    r.virtual.set(s.to, members);
    say(r, `make ${n}: ${r.input.name} lists ${members.size.toLocaleString("en-US")} files (${gb([...members.values()].reduce((a, x) => a + x, 0))}); not unpacked in a plan's try`);
    return;
  }
  const dest = await inPrep(r, s.to, { create: true, write: true });
  if (await lstat(dest).catch(() => null)) throw new PlanFault("unpack", `make step ${n}: {prep}/${s.to} is there already`);
  const saved = r.resumeKey ? await checkpointPath(r.away ?? dirname(r.base), "unpack:" + r.resumeKey + ":" + n) : null;
  const restore = async (p: string) => {
    const problem = await linkProblem(p, "completed extraction");
    if (problem) throw new PlanFault("unpack", problem);
    await restoreStage(p, dest, r.signal);
  };
  if (saved && await completed(saved)) {
    say(r, `resuming make step ${n} from the completed extraction of ${r.input.name}`);
    await restore(saved);
    return;
  }
  await mkdir(dest, { recursive: true });
  const t = pdeps.tools();
  const rar = /\.(rar|r\d\d)$/i.test(r.input.name);
  const tries: { exe: string; argv: (list: string | null) => string[]; ok: number[]; lists: boolean }[] = [];
  if (rar && t.unrar) tries.push({ exe: t.unrar, argv: l => ["x", "-y", "-o+", "-p-", "{in}", ...(l ? [`@${l}`] : []), "{dest}/"], ok: [0], lists: true });
  if (t.sevenZip) tries.push({ exe: t.sevenZip, argv: l => ["x", "-y", "-bd", "-bb0", "-o{dest}", "{in}", ...(l ? [`@${l}`] : [])], ok: [0, 1], lists: true });
  if (rar && t.unar) tries.push({ exe: t.unar, argv: () => ["-q", "-f", "-o", "{dest}", "{in}"], ok: [0], lists: false });
  if (!tries.length) throw new EnvError("tool", `no archiver on this server unpacks ${r.input.name} (${rar ? "unrar, 7z or unar" : "7z"})`);
  // only: exactly the members the globs match, as a list file the archiver reads
  let list: string | null = null, wanted: string[] | null = null;
  if (s.only?.length) {
    const members = await membersOf(r);
    const globs = s.only.map(g => new Bun.Glob(g));
    wanted = [...members.keys()].filter(p => globs.some(g => g.match(p)));
    if (!wanted.length) throw new PlanFault("unpack", `make step ${n}: nothing in ${r.input.name} matches ${s.only.join(", ")}`);
    list = join(r.base, "lists", `only-${n}.txt`);
    await mkdir(dirname(list), { recursive: true });
    await writeFile(list, wanted.join("\n") + "\n");
  }
  const total = r.input.size;
  let last = "";
  for (const a of tries) {
    const fill: Record<string, () => string> = { in: () => r.inPath, dest: () => dest };
    const res = await watched(r, { band, total, measure: treeSizer(dest), words: bytes => `unpacking ${r.input.name} · ${gb(bytes)} of ~${gb(total)}` },
      signal => runSandboxedStep({ exe: a.exe, argv: a.argv(a.lists ? list : null), wine: false, timeoutSec: 4 * 3600 }, {
        exe: a.exe, cwd: r.cwd, also: r.away ? [r.prep] : null, fill, work: r.base, signal, log: r.log, phase: "unpack", judge: false,
        archiveExited: saved ? async result => {
          if (result.timedOut || result.code !== 0) return;
          if (wanted && !a.lists) {
            const bad = await linkProblem(dest, "completed extraction");
            if (bad) throw new PlanFault("unpack", bad);
            await keepOnly(dest, new Set(wanted));
          }
          await publishStage(dest, saved);
        } : undefined,
        name: { log: `make ${n}`, error: `make step ${n} (unpacking ${r.input.name})` },
      }));
    const trouble = stepFailure(res, { name: `make step ${n} (unpacking ${r.input.name})`, timeoutSec: 4 * 3600, wine: false, phase: "unpack" });
    if (trouble instanceof EnvError || (trouble && res.timedOut)) throw trouble;    // out of time: no second archiver for hours more
    if (!res.timedOut && a.ok.includes(res.code)) { last = ""; break; }
    last = `${basename(a.exe)} exit ${res.code}${res.timedOut ? " (out of time)" : ""}: ${(res.stderr || res.stdout).trim().split("\n").slice(-2).join(" | ").slice(-240)}`;
    r.log(`make ${n}: ${last}`);
    await removeTree(dest).catch(() => []);
    await mkdir(dest, { recursive: true });
  }
  if (last) throw new PlanFault("unpack", `make step ${n} could not unpack ${r.input.name}: ${last}`);
  if (saved && await completed(saved)) await restore(saved);
  else if (wanted && tries.every(a => !a.lists)) await keepOnly(dest, new Set(wanted));
  say(r, `make ${n}: unpacked ${r.input.name} into {prep}/${s.to}`);
}

/** what an archiver that takes no list unpacked beyond `wanted` goes */
async function keepOnly(dir: string, wanted: Set<string>): Promise<void> {
  const walk = async (p: string, rel: string) => {
    for (const n of await readdir(p).catch(() => [] as string[])) {
      const full = join(p, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(full).catch(() => null);
      if (st?.isDirectory()) { await walk(full, r); if (!(await readdir(full).catch(() => ["x"])).length) await rm(full, { recursive: true, force: true }); }
      else if (!wanted.has(r)) await rm(full, { force: true });
    }
  };
  await walk(dir, "");
}

/** the size of a folder's files (links never followed), saying how far it is when it takes a while */
async function bytesIn(dir: string, tell?: (files: number, bytes: number) => void): Promise<number> {
  let n = 0, files = 0, last = Date.now();
  const walk = async (p: string) => {
    for (const e of await readdir(p).catch(() => [] as string[])) {
      const st = await lstat(join(p, e)).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(join(p, e));
      else { n += st.size; files++; }
      if (tell && Date.now() - last >= 1000) { last = Date.now(); tell(files, n); }
    }
  };
  await walk(dir);
  return n;
}

/** pick: the one folder that is the game (see the file header, 5) */
async function pickStep(r: Run, n: number, s: { within: string; marker: string; also?: string[]; as: string }): Promise<void> {
  const also = s.also ?? [];
  const want = [s.marker, ...also].join(" and ");
  const vm = /^\{prep\}\/(.+)$/.exec(s.within);
  const vkey = vm ? [...r.virtual.keys()].find(k => vm[1] === k || vm[1].startsWith(`${k}/`)) : undefined;
  if (vkey !== undefined) return pickVirtual(r, n, s, vkey, vm![1]);
  const base = await within(r, s.within);
  if (!(await lstat(base).catch(() => null))?.isDirectory()) throw new PlanFault("make", `make step ${n}: ${s.within} is not a folder`);
  const found = await gameFolders(base, s.marker, also, 6, r.signal);
  const name = (p: string) => relative(r.input.shape === "folder" && p.startsWith(r.inPath) ? dirname(r.inPath) : r.cwd, p).split(sep).join("/") || ".";
  if (!found.length) {
    // the description saw the marker, so the recipe looks in the wrong place; else the data does not hold the game folder
    if (r.markersSeen.some(m => m === s.marker || m.endsWith(`/${s.marker}`))) throw new PlanFault("make", `make step ${n}: no folder within ${s.within} holds ${want}, though the game data has ${s.marker}: the step looks in the wrong place`);
    throw new MakeRefused(`nothing in ${r.input.name} holds ${want}: it does not hold the game's folder`, "form");
  }
  const judged = await Promise.all(found.map(async p => ({ p, id: await mkdeps.readFolderIdentity(p, r.platform).catch(() => null) })));
  const fits = judged.filter(j => !j.id?.sealed && folderVerdict(r, j.id, basename(j.p)).ok);
  const one = fits.length === 1 ? fits[0] : found.length === 1 ? judged[0] : null;
  if (!one) {
    const listing = judged.map(j => `${name(j.p)}${j.id?.serial ? ` (${j.id.serial}${j.id.version ? ` ${j.id.version}` : ""}${j.id.category && j.id.category !== "game" ? `, ${j.id.category}` : ""})` : ""}`).join(" and ");
    throw new MakeRefused(`${found.length} folders in ${r.input.name} hold ${want}${fits.length ? " and each could be the game" : ", and none is the game this takes"}: ${listing} — ludarr takes one game at a time`, fits.length ? "form" : "identity");
  }
  await judgePicked(r, one.p, one.id, name(one.p));
  // `as`: a folder inside {prep} is renamed there; one inside the read-only input is only named, with nothing on disk
  const inInput = r.input.shape === "folder" && (one.p === r.inPath || one.p.startsWith(r.inPath + sep));
  if (inInput) { r.aliases.set(s.as, one.p); say(r, `make ${n}: picked ${name(one.p)} as {prep}/${s.as} (read where it is)`); }
  else {
    const to = await inPrep(r, s.as, { create: true, write: true });
    if (resolve(to) !== resolve(one.p)) {
      if (await lstat(to).catch(() => null)) throw new PlanFault("make", `make step ${n}: {prep}/${s.as} is there already`);
      if (resolve(to).startsWith(resolve(one.p) + sep)) throw new PlanFault("make", `make step ${n}: {prep}/${s.as} is inside the folder it names`);
      await rename(one.p, to);
    }
    r.picked!.path = to;
    say(r, `make ${n}: picked ${name(one.p)} as {prep}/${s.as}`);
  }
}

/** a picked folder's identity against make.input, as a folder (its form was judged with the input) */
function folderVerdict(r: Run, id: Identity | null, name: string): Verdict {
  const mi = r.make.input;
  return mkdeps.inputMatches({ ...mi, shape: "folder", formats: undefined, complete: undefined }, { platform: id?.platform ?? r.platform, name, size: 0, hashes: {}, identity: id, shape: "folder" });
}

/** the picked folder judged again: not sealed, the game make.input takes, the whole game */
async function judgePicked(r: Run, path: string, id: Identity | null, shown: string): Promise<void> {
  if (id?.sealed) throw new MakeRefused(sealedWords(id, shown), "identity");
  const v = folderVerdict(r, id, shown);
  if (!v.ok) throw new MakeRefused(`${shown} is ${v.why ?? "not the game this takes"}`, blockOf(v.why));
  if (r.mode !== "plan" || r.input.shape === "folder") await wholeGame(r, path, shown, id ?? r.identity);
  r.identity = id ?? r.identity;
  r.serial = clean(id?.serial) ?? r.serial;
  r.version = clean(id?.version) ?? r.version;
  const bytes = r.mode === "plan" && r.input.shape !== "folder" ? 0 : await bytesIn(path, (files, b) => r.progress(0.06, `measuring the game folder · ${files.toLocaleString("en-US")} files, ${gb(b)}`));
  r.picked = { path, identity: id, bytes };
}

/** a plan's try: the pick on an archive's listing, the marker read by extracting it alone */
async function pickVirtual(r: Run, n: number, s: { within: string; marker: string; also?: string[]; as: string }, key: string, sub: string): Promise<void> {
  const members = r.virtual.get(key)!;
  const rest = sub === key ? "" : sub.slice(key.length + 1);
  const scoped = new Map<string, number>();
  for (const [p, size] of members) if (!rest || p.startsWith(`${rest}/`)) scoped.set(rest ? p.slice(rest.length + 1) : p, size);
  const found = gameFoldersIn(scoped, s.marker, s.also ?? [], 6);
  const want = [s.marker, ...(s.also ?? [])].join(" and ");
  if (!found.length) throw new MakeRefused(`nothing in ${r.input.name} holds ${want}: it does not hold the game's folder`, "form");
  const judged: { dir: string; id: Identity | null }[] = [];
  try {
    for (const [i, dir] of found.slice(0, 4).entries()) judged.push({ dir, id: await markerIdentity(r, i, [rest, dir, s.marker].filter(Boolean).join("/"), s.marker) });
  } finally { await removeTree(join(r.base, "inspect")).catch(() => []); }
  const fits = judged.filter(j => !j.id?.sealed && folderVerdict(r, j.id, j.dir || r.input.name).ok);
  const one = fits.length === 1 ? fits[0] : found.length === 1 ? judged[0] : null;
  if (!one) throw new MakeRefused(`${found.length} folders in ${r.input.name} hold ${want}: ${judged.map(j => j.dir || "its root").join(" and ")} — ludarr takes one game at a time`, fits.length ? "form" : "identity");
  const shown = one.dir || `the root of ${r.input.name}`;
  await judgePicked(r, one.dir, one.id, shown);
  // the whole game by the listing, as the job judges it before it unpacks (the folder itself is judged once it is)
  await wholeByListing(r, scoped, one.dir, shown, one.id);
  const bytes = inListing(scoped, one.dir).bytes;
  r.picked = { path: [rest, one.dir].filter(Boolean).join("/") || ".", identity: one.id, bytes };
  say(r, `make ${n}: would pick ${shown}${one.id?.serial ? ` (${one.id.serial}${one.id.version ? ` ${one.id.version}` : ""})` : ""}, ${gb(bytes)}`);
}

/** the whole game by an archive's listing: its files and bytes inside the game folder `dir`, and the share of the
 *  program's list of the game's files it holds (names compared without regard to case: the check on the unpacked folder
 *  is the strict one) */
async function wholeByListing(r: Run, scoped: Map<string, number>, dir: string, shown: string, id: Identity | null): Promise<void> {
  const c0 = r.make.input.complete;
  if (!c0) return;
  // the program's list judges only the title and version it is for (src/ways/inspect.ts listJudges)
  const j = listJudges(c0, id);
  if (!j.judges) say(r, j.note);
  const c = j.judges ? c0 : listFallback(c0);
  const has = inListing(scoped, dir);
  const short: string[] = [];
  if (c.minFiles && has.files < c.minFiles) short.push(`${has.files.toLocaleString("en-US")} files, and the whole game has at least ${c.minFiles.toLocaleString("en-US")}`);
  if (c.minBytes && has.bytes < c.minBytes) short.push(`${gb(has.bytes)}, and the whole game is at least ${gb(c.minBytes)}`);
  const list = await programList(r, c);
  if (list?.length) {
    const share = c.list?.share ?? 0.98;
    const present = list.filter(l => has.paths.has(l.toLowerCase())).length;
    if (present / list.length < share) short.push(`it holds ${present.toLocaleString("en-US")} of the ${list.length.toLocaleString("en-US")} files the program lists (${c.list!.path}), and needs ${Math.round(share * 100)} % of them`);
  }
  if (short.length) throw new MakeRefused(`${shown} in ${r.input.name} is ${PART}: ${short.join("; ")}`, "identity");
}

/** the identity of an archive member's marker, taken out alone into <base>/inspect/<i> (a link there proves nothing) */
async function markerIdentity(r: Run, i: number, member: string, marker: string): Promise<Identity | null> {
  const to = join(r.base, "inspect", String(i));
  const dir = join(to, ...dirname(marker).split("/").filter(d => d && d !== "."));
  await mkdir(dir, { recursive: true });
  const got = await mkdeps.extractMember(r.inPath, member, dir, { signal: r.signal, work: r.base }).catch(e => { if (isCancel(e, r.signal)) throw new Error("cancelled"); return null; });
  if (!got) return null;
  const want = join(to, ...marker.split("/"));
  if (resolve(got) !== resolve(want)) await rename(got, want).catch(() => {});
  if (await buildFileProblem(to, marker)) return null;
  return mkdeps.readFolderIdentity(to, r.platform).catch(() => null);
}

/** how many files and bytes of an archive's listing are inside folder `dir` ("" the root), and their paths below it */
function inListing(files: Map<string, number>, dir: string): { files: number; bytes: number; paths: Set<string> } {
  const prefix = dir ? `${dir}/` : "";
  const out = { files: 0, bytes: 0, paths: new Set<string>() };
  for (const [p, size] of files) if (!prefix || p.startsWith(prefix)) { out.files++; out.bytes += size; out.paths.add(p.slice(prefix.length).toLowerCase()); }
  return out;
}

/**
 * Before an archive is unpacked (a make job, or a try that runs every step), its game folder is judged from its listing
 * and its marker taken out alone: an archive that holds no game folder, holds another game, another version, an update or
 * a part of the game is refused without a byte written — an 83 GB unpack is never spent on a release the pick would
 * refuse. What cannot be judged here (an archive 7z cannot list, a marker it cannot take out) is judged at the pick, as
 * before. Counted leniently (names compared without regard to case): the pick's own check after the unpack is the strict one.
 */
async function prejudgeArchive(r: Run): Promise<void> {
  if (r.mode === "plan" || r.input.shape !== "file" || r.input.synthetic) return;
  const steps = r.make.steps;
  const ui = steps.findIndex(s => "unpack" in s);
  if (ui < 0) return;
  const un = (steps[ui] as Extract<MakeStep, { unpack: unknown }>).unpack;
  if (un.only?.length) return;                                                   // a part of it is taken: judged once it is
  const pick = steps.slice(ui + 1).find((s): s is Extract<MakeStep, { pick: unknown }> => "pick" in s)?.pick;
  const sub = pick ? /^\{prep\}\/(.+)$/.exec(pick.within)?.[1] : undefined;
  if (!pick || !sub || !(sub === un.to || sub.startsWith(`${un.to}/`))) return;
  const stop = ticker(r, 0.04, `looking inside ${r.input.name} before it is unpacked`);
  let members: Map<string, number>;
  try { members = await membersOf(r); }
  catch (e) {
    // an archive 7z cannot list (or no 7z here, where unrar still unpacks it) is judged at the pick, as before
    stop();
    if (isCancel(e, r.signal)) throw new Error("cancelled");
    say(r, `${r.input.name} could not be listed before it is unpacked (${msgOf(e)}): it is judged once it is`);
    return;
  }
  r.unpackBytes = [...members.values()].reduce((a, b) => a + b, 0) || null;
  try {
    if (!members.size) { say(r, `${r.input.name} lists no files: it is judged once it is unpacked`); return; }
    const rest = sub === un.to ? "" : sub.slice(un.to.length + 1);
    const one = await judgeMembers(r, members, rest, pick.marker, pick.also ?? []);
    if (one?.id) { r.identity = one.id; r.serial = clean(one.id.serial) ?? r.serial; r.version = clean(one.id.version) ?? r.version; }
  } finally {
    stop();
    await removeTree(join(r.base, "inspect")).catch(() => []);
  }
}

/**
 * An archive's listing judged as the pick would judge the folder it unpacks to (`rest`: the folder of the listing the pick
 * looks within, "" its root): the folders holding `marker` (and `also`), each one's marker taken out alone and read, and
 * the game folder judged — none there ('form'), another game or version, several games, an update or a part by its file
 * count and bytes (MakeRefused). The folder that is the game ({dir, id, bytes}), or null when it can only be told once it is
 * unpacked (a marker that says nothing, more folders than are looked at).
 */
async function judgeMembers(r: Run, members: Map<string, number>, rest: string, marker: string, also: string[]): Promise<{ dir: string; id: Identity | null; bytes: number } | null> {
  const scoped = new Map<string, number>();
  for (const [p, size] of members) if (!rest || p.startsWith(`${rest}/`)) scoped.set(rest ? p.slice(rest.length + 1) : p, size);
  const want = [marker, ...also].join(" and ");
  const found = gameFoldersIn(scoped, marker, also, 6);
  if (!found.length) throw new MakeRefused(`nothing in ${r.input.name} holds ${want}: it does not hold the game's folder`, "form");
  const judged: { dir: string; id: Identity | null }[] = [];
  for (const [i, dir] of found.slice(0, 4).entries()) judged.push({ dir, id: await markerIdentity(r, i, [rest, dir, marker].filter(Boolean).join("/"), marker) });
  const shownOf = (dir: string) => dir || `the root of ${r.input.name}`;
  const listed = () => judged.map(j => `${shownOf(j.dir)}${j.id?.serial ? ` (${j.id.serial}${j.id.version ? ` ${j.id.version}` : ""}${j.id.category && j.id.category !== "game" ? `, ${j.id.category}` : ""})` : ""}`).join(" and ");
  // as the pick judges them: a folder whose marker says nothing is not refused for it
  const fits = judged.filter(j => !j.id?.sealed && folderVerdict(r, j.id, shownOf(j.dir)).ok);
  const allRead = judged.every(j => j.id) && found.length <= 4;
  if (allRead && !fits.length) {
    // every game folder in it says what it is, and none is the game this takes
    const one = judged[0];
    if (judged.length === 1) {
      if (one.id!.sealed) throw new MakeRefused(sealedWords(one.id, shownOf(one.dir)), "identity");
      const v = folderVerdict(r, one.id, shownOf(one.dir));
      throw new MakeRefused(`${shownOf(one.dir)} in ${r.input.name} is ${v.why ?? "not the game this takes"}`, blockOf(v.why));
    }
    throw new MakeRefused(`${found.length} folders in ${r.input.name} hold ${want}, and none is the game this takes: ${listed()}`, "identity");
  }
  if (allRead && fits.length > 1) throw new MakeRefused(`${found.length} folders in ${r.input.name} hold ${want} and each could be the game: ${listed()} — ludarr takes one game at a time`, "form");
  const one = fits.length === 1 ? fits[0] : found.length === 1 ? judged[0] : null;
  if (!one) { say(r, `${found.length} folders in ${r.input.name} hold ${want}: the one that is the game is picked once it is unpacked`); return null; }
  // the whole game, by the listing (the pick checks it again on the folder itself)
  await wholeByListing(r, scoped, one.dir, shownOf(one.dir), one.id);
  say(r, `${r.input.name} holds ${shownOf(one.dir)}${one.id?.serial ? ` (${one.id.serial}${one.id.version ? ` ${one.id.version}` : ""})` : ""}: judged from its listing before it is unpacked`);
  return { dir: one.dir, id: one.id, bytes: inListing(scoped, one.dir).bytes };
}

/**
 * A download's archive judged by its listing before the content pass unpacks it (src/ways/find.ts gameFilesIn, for a way
 * whose make takes the game folder the archive holds): as a make job judges an archive before its unpack step (the
 * folder holding make.input's marker found in the listing, its marker taken out alone and read, the folder judged:
 * another game or version, several games, no game folder, an update or a part by its file count and bytes), so a release
 * its own listing rules out is refused — MakeRefused, with the make's words and class — before a byte is unpacked or any
 * room is asked for. What cannot be told here (no 7z, an archive it cannot list in time, a marker it cannot take out, a
 * folder whose marker says nothing) is null: the archive is unpacked and judged as before. The program's own file list is
 * not at hand here (the make judges by it once the folder is unpacked).
 */
export async function judgeArchive(o: { path: string; content: ContentPlan; work: string; gameId: number | null; signal: AbortSignal; log: (line: string) => void; progress: (p: number, m: string) => void }): Promise<{ dir: string; identity: Identity | null; bytes: number } | null> {
  const make = o.content.make;
  if (!make?.input.marker || make.input.shape === "file") return null;
  const st = await lstat(o.path).catch(() => null);
  if (!st?.isFile()) return null;
  const v = await volumesWith(o.path, "file");
  const input: Input = {
    ref: { from: "indexer", path: o.path, fetchId: null }, path: o.path, shape: "file", name: basename(o.path), size: st.size + v.bytes, volumes: v.volumes,
    digest: "", identity: null, gameId: o.gameId, from: { kind: "indexer", fetchId: null, digest: "" }, synthetic: false,
  };
  const r = await newRun({ mode: "plan", work: o.work, content: o.content, plan: null, input, signal: o.signal, log: o.log, progress: o.progress });
  try {
    const stop = ticker(r, 0.03, `looking inside ${input.name} before it is unpacked`);
    let members: Map<string, number>;
    try { members = await membersOf(r); }
    catch (e) {
      if (isCancel(e, r.signal)) throw new Error("cancelled");
      say(r, `${input.name} could not be listed before it is unpacked (${msgOf(e)}): it is judged once it is`);
      return null;
    } finally { stop(); }
    if (!members.size) return null;
    const stop2 = ticker(r, 0.04, `looking at the game folder in ${input.name} before it is unpacked`);
    try { const one = await judgeMembers(r, members, "", make.input.marker, make.input.also ?? []); return one && { dir: one.dir, identity: one.id, bytes: one.bytes }; }
    finally { stop2(); }
  } finally {
    await removeTree(r.base).catch(() => []);
  }
}

/** the step's words said again every few seconds with the time it has taken, until the returned stop is called */
function ticker(r: Run, p: number, words: string): () => void {
  const t0 = mkdeps.now();
  r.progress(p, words);
  const t = setInterval(() => r.progress(p, `${words} · ${clock(mkdeps.now() - t0)}`), mkdeps.tickMs);
  return () => clearInterval(t);
}

/** a converter's files copied where the build user can run them (it cannot reach <config>) */
async function converterIn(r: Run, c: Converter): Promise<string> {
  const had = r.converters.get(c.dir);
  if (had) return had;
  const to = join(r.tools, c.name, String(r.converters.size + 1));
  for (const f of c.files) {
    const p = join(to, ...f.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await copyFile(join(c.dir, ...f.split("/")), p);
    await chmod(p, 0o755).catch(() => {});
  }
  const exe = join(to, ...relative(c.dir, c.exe).split(sep));
  r.converters.set(c.dir, exe);
  return exe;
}

/** convert: a converter on the picked data (see the file header, 5) */
async function convertStep(r: Run, n: number, s: { with: ConverterId | PinnedTool; argv: string[]; timeoutSec: number }, band: [number, number]): Promise<void> {
  const conv = await mkdeps.ensureConverter(s.with, { work: r.base, signal: r.signal, log: r.log, progress: (_p, m) => r.progress(band[0], m) });
  const exe = await converterIn(r, conv);
  const writes = s.argv.some(a => a.includes("{out}"));
  const target = writes ? join(r.out, productName(r)) : r.prep;
  const total = r.picked?.bytes || r.input.size;
  await watched(r, { band, total, measure: writes ? fileSizer(target) : treeSizer(r.prep), words: bytes => `${conv.doing} · ${gb(bytes)} of ${gb(total)}` },
    signal => runSandboxedStep({ exe, argv: rewriteArgv(r, s.argv), wine: false, timeoutSec: s.timeoutSec }, {
      exe, cwd: r.cwd, also: r.away ? [r.prep] : null, fill: fillFor(r, false), work: r.base, signal, log: r.log, phase: "convert", unfilled: unfilledWords(n),
      name: { log: `make ${n}`, error: `make step ${n}` },
    }));
  say(r, `make ${n}: ${conv.name} done${writes ? ` (${gb((await stat(target).catch(() => null))?.size ?? 0)} written)` : ""}`);
}

/** the plan's own built tools for its pinned program (<config>/ways/tools/<slug>/<commit>/ whose tools.json names the ref) */
async function planToolsFor(plan: PlanRow, pinned: PinnedProgram | null): Promise<{ dir: string; commit: string } | null> {
  const t = planSpec(plan).tools;
  if (!t || !pinned) return null;
  const want = t.ref.replace(/\{tag\}/g, pinned.tag);
  const base = join(toolsDir(), plan.slug);
  for (const commit of await readdir(base).catch(() => [] as string[])) {
    try {
      const meta = JSON.parse(await readFile(join(base, commit, "tools.json"), "utf8")) as { ref?: string; commit?: string };
      if (meta.ref === want || meta.commit === want) return { dir: join(base, commit), commit: meta.commit ?? commit };
    } catch { /* not a finished build */ }
  }
  return null;
}

/** run: the program's own tool, or one of the plan's tools (see the file header, 5) */
async function runStep(r: Run, n: number, s: { exe?: string; tool?: string; argv: string[]; wine: boolean; timeoutSec: number }, band: [number, number]): Promise<void> {
  let exe: string, inProgram = false;
  if (s.tool) {
    const kept = r.plan ? await planToolsFor(r.plan, r.pinned) : null;
    if (!kept) throw new PlanFault("make", `make step ${n} runs ${s.tool}, one of the plan's tools, and they are not built for its program yet`);
    const to = join(r.tools, "plan", ...s.tool.split("/"));
    if (!(await lstat(to).catch(() => null))) {
      const from = join(kept.dir, ...s.tool.split("/"));
      if (!(await lstat(from).catch(() => null))?.isFile()) throw new PlanFault("make", `make step ${n}: the plan's tools have no ${s.tool}`);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      await chmod(to, 0o755).catch(() => {});
    }
    exe = to;
  } else {
    const rel = s.exe!;
    const local = s.wine || rel.includes("/") || (!!r.program && !!(await lstat(join(r.program, rel)).catch(() => null)));
    if (local) {
      if (!r.program) throw new PlanFault("make", `make step ${n} runs ${rel} from the program, and the program is not here`);
      const found = await present(r.program, rel);
      if (!found) throw new PlanFault("make", `make step ${n}: the program has no ${rel}`);
      exe = join(r.program, ...found.split("/"));
      inProgram = true;
    } else exe = rel;                                                             // a Linux tool on the sandbox's PATH
  }
  const writes = s.argv.some(a => a.includes("{out}"));
  const target = writes ? join(r.out, productName(r)) : r.prep;
  const total = r.picked?.bytes || r.input.size;
  const shown = basename(s.tool ?? s.exe ?? "the tool");
  await watched(r, { band, total, measure: writes ? fileSizer(target) : treeSizer(r.prep), words: bytes => `${writes ? `making the game file with ${shown}` : `running ${shown}`} · ${gb(bytes)} written` },
    signal => runSandboxedStep({ ...s, argv: rewriteArgv(r, s.argv) }, {
      exe, cwd: r.cwd, also: r.away ? [r.prep] : null, fill: fillFor(r, s.wine), work: r.base, signal, log: r.log, phase: "make", unfilled: unfilledWords(n),
      ...(inProgram ? { wine: { cwd: dirname(exe) } } : {}),
      name: { log: `make ${n}`, error: `make step ${n}` },
    }));
  say(r, `make ${n}: ${shown} done`);
}

async function removeStep(r: Run, n: number, glob: string): Promise<void> {
  if (r.mode === "plan") { say(r, `make ${n}: would remove ${glob} in {prep}`); return; }
  const found: string[] = [];
  for await (const rel of new Bun.Glob(glob).scan({ cwd: r.prep, onlyFiles: false, dot: true, followSymlinks: false })) found.push(rel.replace(/\\/g, "/"));
  for (const rel of found.sort((a, b) => b.length - a.length)) {
    const abs = join(r.prep, ...rel.split("/"));
    let p = r.prep, safe = true;
    for (const seg of rel.split("/").slice(0, -1)) { p = join(p, seg); if ((await lstat(p).catch(() => null))?.isSymbolicLink()) { safe = false; break; } }
    if (safe) await removeTree(abs);
  }
  say(r, `make ${n}: removed ${found.length ? found.length : "nothing (no match)"} for ${glob}`);
}

async function moveStep(r: Run, n: number, m: { from: string; to: string }): Promise<void> {
  if (r.mode === "plan") { say(r, `make ${n}: would move ${m.from} to ${m.to} in {prep}`); return; }
  if (r.aliases.has(m.from)) throw new PlanFault("make", `make step ${n}: {prep}/${m.from} is the input's own folder, which is read-only`);
  const from = await inPrep(r, m.from, { write: true });
  if (!(await lstat(from).catch(() => null))) throw new PlanFault("make", `make step ${n}: there is no {prep}/${m.from} to move`);
  const to = await inPrep(r, m.to, { create: true, write: true });
  if (await lstat(to).catch(() => null)) throw new PlanFault("make", `make step ${n}: {prep}/${m.to} is there already`);
  await rename(from, to);
  say(r, `make ${n}: moved {prep}/${m.from} to {prep}/${m.to}`);
}

/* ─────────── the product ─────────── */

/** what the steps made, read by its own bytes and judged against the content plan (see the file header, 6) */
async function productOf(r: Run): Promise<{ path: string; name: string; size: number; identity: Identity | null; shape: "file" | "folder" }> {
  const name = productName(r);
  const path = join(r.out, name);
  const st = await lstat(path).catch(() => null);
  if (!st) throw new PlanFault("make", `the steps made no ${name} in {out}`);
  const shape = r.make.output.shape;
  if (shape === "file" ? !st.isFile() : !st.isDirectory()) throw new PlanFault("make", `the steps made ${name} as a ${st.isDirectory() ? "folder" : "file"}, and the recipe makes one ${shape}`);
  const bad = await linkProblem(r.out, "what it made");
  if (bad) throw new PlanFault("make", bad);
  const size = shape === "file" ? st.size : await bytesIn(path);
  if (!size) throw new PlanFault("make", `${name} is empty`);
  const identity = shape === "file" ? await mkdeps.readIdentity(path, r.platform).catch(() => null) : await mkdeps.readFolderIdentity(path, r.platform).catch(() => null);
  if (!r.content.accept.hashes.length) {
    const v = mkdeps.contentMatches(r.content, { platform: identity?.platform ?? r.platform, name, size, hashes: {}, identity, shape });
    if (!v.ok) throw new PlanFault("make", `what it made does not read as the game: ${name} is ${v.why}`);
    const c = r.content.accept;
    if (((c.serials ?? []).length || (c.versions ?? []).length || (c.builds ?? []).length) && !proven(v))
      throw new PlanFault("make", `what it made does not read as the game: nothing in ${name} says which game it is${v.unchecked ? ` (${v.unchecked})` : ""}`);
  }
  say(r, `made ${name} (${gb(size)})${identity?.serial ? `: it reads as ${identity.serial}${identity.version ? ` ${identity.version}` : ""}` : ""}`);
  return { path, name, size, identity, shape };
}

/** a made row of the game kept under this key, still on disk as it was, and still the way's kind of file */
function madeRow(gameId: number | null, key: string, content: ContentPlan): ContentRow | null {
  if (gameId == null) return null;
  const row = (wstmts.contentByMadeKey.get(gameId, key) as ContentRow | null) ?? null;
  if (!row) return null;
  try { const st = statSync(row.path); if ((row.shape === "folder" ? !st.isDirectory() : !st.isFile() || st.size !== row.size)) return null; } catch { return null; }
  return mkdeps.contentMatches(content, { ...contentFacts(row), shape: row.shape === "folder" ? "folder" : "file" }).ok ? row : null;
}

/** the program's install folder (the plan's root, or the lone top folder) in an unpacked program */
async function programRoot(dir: string, root: string | undefined): Promise<string> {
  if (root) {
    const p = join(dir, ...root.split("/"));
    if (!(await lstat(p).catch(() => null))?.isDirectory()) throw new PlanFault("make", `the program has no folder ${root} (the plan's root)`);
    return p;
  }
  const names = (await readdir(dir).catch(() => [] as string[])).filter(n => !JUNK.test(n));
  if (names.length === 1 && (await lstat(join(dir, names[0])).catch(() => null))?.isDirectory()) return join(dir, names[0]);
  return dir;
}
/** the pinned program, unpacked read-only in the job's folder (a step runs its tool, or the whole-game check reads its list) */
async function getProgram(r: Run, plan: PlanRow): Promise<void> {
  r.progress(0.04, "getting the program");
  try {
    const acq = await mkdeps.acquireProgram(plan, { work: join(r.base, "program"), signal: r.signal, log: r.log, progress: (_p, m) => r.progress(0.04, m) });
    r.program = await programRoot(acq.dir, planSpec(plan).root);
    r.programSha = acq.pinned.sha256;
    r.pinned = acq.pinned;
    r.planTools = (await planToolsFor(plan, acq.pinned))?.commit ?? null;
  } catch (e) {
    if (isCancel(e, r.signal)) throw new Error("cancelled");
    if (e instanceof EnvError || e instanceof PlanFault) throw e;
    // ludarr's own download: the network, the host's own trouble or GitHub's limit are this server's; anything else the
    // program's pin says (a file gone, changed under its tag) is the plan's
    const m = msgOf(e), code = String((e as { code?: unknown })?.code ?? "");
    const net = /^E(CONN|TIMEDOUT|AI_AGAIN|NOTFOUND|HOSTUNREACH|NETUNREACH|PIPE)/.test(code) || /GitHub's hourly limit|HTTP (5\d\d|429)\b/.test(m)
      || ((e as Error)?.name === "TypeError" && /fetch|network|socket|connect/i.test(m));
    if (net) throw new EnvError("net", `the program could not be downloaded: ${m}`);
    if (e instanceof ProgramError) throw new PlanFault("fetch", `the program: ${m}`);
    throw e;
  }
}

/* ─────────── the make for one way ─────────── */

/**
 * Make way `way`'s game file from `input` (see the file header): the job runs it, and the content job of a download
 * runs it inline (src/ways/find.ts). The product is kept and attached to the way; the caller queues what comes next.
 */
export async function runMake(ctx: KindContext, o: { way: WayRow; plan: PlanRow; content: ContentPlan; input: MakeInputRef }): Promise<MakeOutcome> {
  const make = o.content.make;
  if (!make) throw new Error("the way's game file is not made: its content plan has no make");
  if (!sandboxOrAllowed()) throw new EnvError("tool", "making a game file runs archivers and converters, and those run only in the build sandbox (ludarr's Docker image)");
  const game = stmts.gameById.get(o.way.game_id) as GameRow | undefined;
  if (!game) throw new Error("the way's game is gone");
  ctx.progress(0.01, "looking at the game data");
  const input = await resolveInput(o.input, { gameId: game.id, signal: ctx.signal, log: ctx.log, progress: n => ctx.progress(0.01, `looking at the game data · ${n.toLocaleString("en-US")} files`) });
  const r = await newRun({ mode: "job", work: ctx.work, content: o.content, plan: o.plan, input, signal: ctx.signal, log: ctx.log, progress: ctx.progress });
  try {
    // judged before anything is fetched or run: a sealed copy, another game or version, a form the recipe does not take or
    // data without the game's folder is refused in seconds, without the program's download
    r.progress(0.015, `judging ${input.name}`);
    await judgeInput(r, { complete: false });
    if (needsProgram(make)) await getProgram(r, o.plan);
    else r.programSha = planPinned(o.plan)?.sha256 ?? null;
    const tools = toolsOf(make, r.planTools);
    const { key, recipe } = makeKey({ digest: input.digest, make, tools, program: r.programSha });
    r.resumeKey = key;
    const before = madeRow(game.id, key, o.content);
    if (before) {
      ctx.log(`made before from the same game data by the same recipe: ${before.name} is reused`);
      const a = mkdeps.attachToWays(before, { wayId: o.way.id });
      if (!a.attached.includes(o.way.id) && getWay(o.way.id)?.content_id !== before.id) ctx.log(`${before.name} was not attached: ${a.checks.find(c => c.wayId === o.way.id)?.why ?? "the way is being built"}`);
      return { product: before, reused: true };
    }
    // the whole game, not an update or a part, before any step (a folder that is the game folder; an archive by its listing)
    if (r.rootIsGame && make.input.complete) await wholeGame(r, input.path, input.name);
    const output = await checkpointPath(ctx.work, "output:" + key);
    const names = await completed(output) ? await readdir(output) : [];
    if (names.length) {
      const [name] = names;
      if (!name || placedName(name) !== name) throw new PlanFault("make", "invalid saved product name");
      r.productName = name;
      r.out = output;
      ctx.log("resuming verification of the completed conversion");
    } else {
      if (await completed(output)) await rm(output, { recursive: true });
      await handOver(r);
      const n = r.make.steps.findIndex(step => "unpack" in step) + 1;
      const unpackKey = "unpack:" + key + ":" + n;
      const spare = spareJobFolder(resolve(mkdeps.downloadsDir()), ctx.job.id);
      const primarySaved = n > 0 && await completed(await checkpointPath(ctx.work, unpackKey));
      const spareSaved = n > 0 && !primarySaved && await completed(spare) && await completed(await checkpointPath(spare, unpackKey));
      if (spareSaved) await prepAway(r, resolve(mkdeps.downloadsDir()));
      if (!primarySaved && !spareSaved) {
        await prejudgeArchive(r);
        await roomBefore(r);
      }
      await runSteps(r);
      await unchanged(r);
      const name = productName(r);
      const path = join(r.out, name);
      const stage = join(r.base, "completed-product");
      await mkdir(stage);
      await rename(path, join(stage, name));
      await publishStage(stage, output);
      r.out = output;
    }
    const p = await productOf(r);
    const made: MadeInfo = { from: input.from, recipe, tools, program: make.steps.some(runsProgram) ? r.programSha : null, key, at: Math.floor(mkdeps.now() / 1000) };
    r.progress(0.86, "checking what it made");
    let last = 0;
    const { row, duplicate } = await mkdeps.ingestMade(p.path, { role: "game", game }, {
      made, signal: ctx.signal,
      progress: (b, t) => { if (Date.now() - last >= 1000) { last = Date.now(); r.progress(0.86 + 0.12 * (t ? b / t : 1), `checking what it made · ${gb(b)} of ${gb(t)}`); } },
    });
    if (o.content.accept.hashes.length) {
      const v = mkdeps.contentMatches(o.content, { ...contentFacts(row), shape: p.shape });
      if (!v.ok) { if (!duplicate) await mkdeps.removeContent(row.id).catch(() => null); throw new PlanFault("make", `what it made does not read as the game: ${p.name} is ${v.why}`); }
    }
    r.progress(0.99, "attaching the made game file");
    const a = mkdeps.attachToWays(row, { wayId: o.way.id });
    ctx.log(a.attached.includes(o.way.id) ? `${row.name} is the way's game file now` : `${row.name} is kept; ${a.checks.find(c => c.wayId === o.way.id)?.why ?? "the way is being built, so it takes it next time"}`);
    return { product: row, reused: false };
  } finally {
    // what the steps unpacked and wrote goes with the make — an unpacked game is 100,000 files, minutes on a share — said
    // as it goes, never under the last step's words
    const stop = ticker(r, r.at, "clearing up what the make unpacked and wrote");
    try {
      await stopUnder(r.base).catch(() => 0);
      await removeTree(r.base).catch(() => []);
      if (r.away) {
        await stopUnder(r.away).catch(() => 0);
        const left = await removeTree(r.away).catch(() => [r.away!]);
        if (left.length) ctx.log(`the unpack on the downloads folder's volume was not fully removed (${left.length} entr${left.length === 1 ? "y" : "ies"} still held open): it goes with the next sweep`);
      }
    } finally { stop(); }
  }
}

/** the input a make job's spec names */
function refOf(s: Extract<JobSpec, { kind: "make" }>, game: GameRow): MakeInputRef {
  if (s.from === "kept") { if (s.contentId == null) throw new Error("the make names no kept file to make it from"); return { from: "kept", contentId: s.contentId }; }
  if (s.from === "copy") {
    const id = s.packageId ?? (stmts.packageForGame.get(game.id) as PackageRow | undefined)?.id;
    if (id == null) throw new NeedsFiles("the game has no copy on the server to make it from");
    return { from: "copy", packageId: id };
  }
  if (!s.path) throw new Error("the make names no file to make it from");
  return { from: s.from, path: s.path, fetchId: s.fetchId ?? null };
}

/** what the job will write on the library (the runner's scratch gate weighs the library): the unpacked input (when it
 *  unpacks a file, and the library can hold it beside the product: else the unpack goes on the downloads folder's volume,
 *  and only the product is the library's) and the product (about the input's size); an input the make refuses in seconds
 *  (a sealed copy or kept file) holds no room for writes it will never make */
async function makeScratch(spec: JobSpec): Promise<number> {
  if (spec.kind !== "make") return 2e9;
  try {
    const way = getWay(spec.wayId), plan = way ? getPlan(way.plan_id) : null;
    const content = way && plan ? wayContent(way, plan) : null;
    const make = content?.make;
    let size = 0, file = true;
    if (spec.from === "kept" && spec.contentId != null) {
      const row = getContent(spec.contentId);
      if (row && contentIdentity(row)?.sealed && !(make && takesMakeFile(make.input, row.shape === "folder" ? "folder" : "file", row.name))) return 2e9;
      size = row?.size ?? 0; file = row?.shape !== "folder";
    } else if (spec.from === "copy" && way) {
      const f = mkdeps.copyFacts(way.game_id);
      if ((f?.identity?.sealed && !(make && takesMakeFile(make.input, f.shape, f.name))) || (content && mkdeps.copyServes(way.game_id, content).serves === "no")) return 2e9;
      size = f?.size ?? 0; file = f?.shape !== "folder";
    }
    else if (spec.path) { const st = statSync(spec.path); size = st.isFile() ? st.size : 0; file = st.isFile(); }
    const unpack = !!make?.steps.some(s => "unpack" in s) && file;
    if (!unpack) return Math.max(2e9, size);
    const game = way ? stmts.gameById.get(way.game_id) as GameRow | undefined : undefined;
    const root = game ? rootFolderFor(game) : null;
    const lib = root ? await mkdeps.diskSpace(workDirFor(root)).catch(() => null) ?? await mkdeps.diskSpace(root.path).catch(() => null) : null;
    const left = lib ? lib.free - mkdeps.keepFreeBytes() : null;
    if (root && left != null && left < 2 * size && left >= size && "dir" in await spareFor(workDirFor(root), size, { probe: false })) return Math.max(2e9, size);
    return Math.max(2e9, 2 * size);
  } catch { return 2e9; }
}

async function makeJob(ctx: KindContext): Promise<KindResult> {
  const s = ctx.spec as Extract<JobSpec, { kind: "make" }>;
  // a job that ran before (its transcript has lines) was cut off by a restart: its scratch folder is gone, so it starts over
  if (ctx.job.transcript?.trim()) { ctx.log("resuming after restart: checking completed extraction and conversion stages"); ctx.progress(0.01, "checking saved stages"); }
  const way = getWay(s.wayId);
  if (!way) throw new Error("the way to play is gone");
  const plan = getPlan(way.plan_id);
  if (!plan) throw new Error("the way's plan is gone");
  const game = stmts.gameById.get(way.game_id) as GameRow | undefined;
  if (!game) throw new Error("the way's game is gone");
  const content = wayContent(way, plan);
  if (!content?.make) throw new Error("the way's game file is not made: its content plan has no make (any more)");
  const out = await runMake(ctx, { way, plan, content, input: refOf(s, game) });
  const made = contentMade(out.product);
  let next = "";
  if (s.then === "assemble") {
    const w = getWay(way.id);
    // the admin's 'replace the PC copy' (or a run's) rides on to what comes next
    const replace = s.replace ? { replace: true } : {};
    if (w && mkdeps.assembling(w.id)) next = "; its build is queued already";   // adopted, not queued a second time
    else if (w && mkdeps.wayBuildNeeded(plan, w)) { mkdeps.enqueueJob({ kind: "build", planId: plan.id, wayId: w.id, then: "assemble", ...(s.auto !== undefined ? { auto: s.auto } : {}), ...replace, runId: s.runId ?? null }, { gameId: game.id, runId: s.runId ?? null }); next = "; its program is built for this game next, then the way"; }
    else if (w) { mkdeps.enqueueJob({ kind: "assemble", wayId: w.id, auto: s.auto, ...replace, runId: s.runId ?? null }, { gameId: game.id, runId: s.runId ?? null }); next = "; the build is queued"; }
  }
  const what = out.reused ? `made before from the same game data: ${out.product.name} is reused` : `made ${out.product.name} (${gb(out.product.size)})`;
  return { message: `${what}${next}`, manifest: { wayId: way.id, contentId: out.product.id, reused: out.reused, key: made?.key ?? null } };
}

registerJobKind("make", {
  resumable: true,
  scratch: (_job, spec) => makeScratch(spec),
  run: ctx => makeJob(ctx),
});

/* ─────────── the dry run (try_make) ─────────── */

/** a param.sfo with these entries (strings as UTF-8, numbers as 32-bit integers), as the PS3, PS4, PSP and Vita write it */
export function sfoBytes(entries: Record<string, string | number>): Uint8Array {
  const keys = Object.keys(entries).sort();
  const enc = new TextEncoder();
  const keyBytes = enc.encode(keys.join("\0") + "\0");
  const keyLen = Math.ceil(keyBytes.length / 4) * 4;
  const datas = keys.map(k => { const v = entries[k]; if (typeof v === "number") { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return { b, fmt: 0x0404, len: 4, max: 4 }; } const s = enc.encode(String(v) + "\0"); return { b: s, fmt: 0x0204, len: s.length, max: Math.ceil(s.length / 4) * 4 }; });
  const keyStart = 0x14 + 16 * keys.length, dataStart = keyStart + keyLen;
  const total = dataStart + datas.reduce((a, d) => a + d.max, 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  out.set([0x00, 0x50, 0x53, 0x46], 0);
  dv.setUint32(4, 0x0101, true); dv.setUint32(8, keyStart, true); dv.setUint32(12, dataStart, true); dv.setUint32(16, keys.length, true);
  let ko = 0, doff = 0;
  keys.forEach((k, i) => {
    const e = 0x14 + 16 * i;
    dv.setUint16(e, ko, true); dv.setUint16(e + 2, datas[i].fmt, true); dv.setUint32(e + 4, datas[i].len, true); dv.setUint32(e + 8, datas[i].max, true); dv.setUint32(e + 12, doff, true);
    out.set(datas[i].b, dataStart + doff);
    ko += enc.encode(k).length + 1; doff += datas[i].max;
  });
  out.set(keyBytes, keyStart);
  return out;
}

const DEFAULT_SERIAL: Record<string, string> = { ps5: "PPSA00001", ps4: "CUSA00001", ps3: "BLUS00001", psp: "ULUS00001", vita: "PCSE00001", switch: "0100000000010000" };
const REGION_PREFIX: Record<string, string> = { EU: "EP", US: "UP", JP: "JP", AS: "HP", KR: "KP" };
const filler = (n: number, seed: number) => { const b = new Uint8Array(n); let x = seed >>> 0; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };

/** the marker of a made-up game folder: a Kyty-shaped param.json, a param.sfo, or bytes */
function markerBytes(marker: string, platform: string, id: { serial: string; version: string; region: string }): Uint8Array {
  const contentId = `${REGION_PREFIX[id.region] ?? "UP"}9000-${id.serial}_00-LUDARRMADEUP0000`;
  if (/param\.json$/i.test(marker))
    return new TextEncoder().encode(JSON.stringify({ titleId: id.serial, contentId, contentVersion: id.version, applicationCategoryType: 0, attribute: 0, localizedParameters: { defaultLanguage: "en-US", "en-US": { titleName: "ludarr try" } } }, null, 2));
  if (/param\.sfo$/i.test(marker)) {
    const category = platform === "ps3" ? "DG" : platform === "psp" ? "UG" : "gd";
    return sfoBytes({ TITLE_ID: id.serial, DISC_ID: id.serial, APP_VER: id.version, VERSION: id.version, DISC_VERSION: id.version, CATEGORY: category, CONTENT_ID: contentId, TITLE: "ludarr try" });
  }
  return filler(64 * 1024, 11);
}

/**
 * A made-up input for a dry run when there is no real one (M14): the game folder make.input describes — its marker (a
 * param.json or param.sfo carrying the first accepted serial and version), the files beside it, a few small filler files —
 * as a folder, or packed as one archive when the recipe takes a file. Null (with why) when it cannot be made here.
 */
async function madeUpInput(r0: { base: string; work: string; content: ContentPlan; make: ContentMake; signal: AbortSignal; log: (l: string) => void }): Promise<{ input: Input; facts: string } | { why: string }> {
  const mi = r0.make.input, c = r0.content;
  const serial = mi.serials?.[0] ?? c.accept.serials?.[0] ?? DEFAULT_SERIAL[c.platform] ?? "TEST00001";
  const version = mi.versions?.[0] ?? c.accept.versions?.[0] ?? "01.000.000";
  const region = mi.regions?.[0] ?? c.accept.regions?.[0] ?? "US";
  const root = join(r0.base, "made-up", "game");
  const pick = r0.make.steps.find((s): s is Extract<MakeStep, { pick: unknown }> => "pick" in s)?.pick;
  const sub = pick ? /^\{in\}\/(.+)$/.exec(pick.within)?.[1] : undefined;
  const gameDir = sub ? join(root, ...sub.split("/")) : root;
  const marker = mi.marker ?? pick?.marker ?? null;
  const files: Record<string, Uint8Array> = {};
  if (marker) files[marker] = markerBytes(marker, c.platform, { serial, version, region });
  for (const a of [...(mi.also ?? []), ...(pick?.also ?? [])]) files[a] ??= filler(64 * 1024, a.length);
  for (let i = 0; i < 3; i++) files[`data/filler-${i}.bin`] = filler(256 * 1024, 100 + i);
  for (const [rel, bytes] of Object.entries(files)) {
    const p = join(gameDir, ...rel.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  const facts = `${serial} ${version}, ${Object.keys(files).length} files`;
  // a folder unless the recipe takes only a file ('either' takes the folder itself: its unpack step names it)
  if (mi.shape !== "file") {
    const size = Object.values(files).reduce((a, b) => a + b.length, 0);
    return { input: { ref: { from: "indexer", path: root }, path: root, shape: "folder", name: "made-up game folder", size, volumes: [], digest: "made-up", identity: null, gameId: null, from: { kind: "indexer", digest: "made-up" }, synthetic: true }, facts };
  }
  // a file: the folder packed as one archive in a form the recipe takes and 7z can write
  const fmt = (mi.formats ?? []).find(f => ["zip", "7z", "tar"].includes(f));
  const t = pdeps.tools();
  if (!fmt || !t.sevenZip) return { why: `the recipe takes ${(mi.formats ?? []).map(f => "." + f).join(", ")}, and ludarr cannot make one of those to try it on${t.sevenZip ? "" : " (7z is not here)"}` };
  const archive = join(r0.base, "made-up", `game.${fmt}`);
  await handTo(join(r0.base, "made-up"), "builder");
  try {
    const res = await sandboxExec([t.sevenZip, "a", `-t${fmt}`, "-bd", "-bb0", archive, "."], { work: r0.base, cwd: root, timeoutMs: 120_000, signal: r0.signal, maxOutput: 4000 });
    if (res.code !== 0 && res.code !== 1) return { why: `7z could not pack the made-up folder (exit ${res.code})` };
  } finally { await handTo(join(r0.base, "made-up"), "root"); }
  const size = (await stat(archive).catch(() => null))?.size ?? 0;
  return { input: { ref: { from: "indexer", path: archive }, path: archive, shape: "file", name: basename(archive), size, volumes: [], digest: "made-up", identity: null, gameId: null, from: { kind: "indexer", digest: "made-up" }, synthetic: true }, facts };
}

export interface MakeDryOpts {
  /** the construct job's scratch folder for this try */
  work: string;
  content: ContentPlan;
  /** the game data to try it on; null: a made-up folder from make.input */
  input: MakeInputRef | null;
  mode: "plan" | "full";
  signal: AbortSignal;
  log: (line: string) => void;
  /** what the try may write and how long it may take ('full' runs only within it) */
  budget: { bytes: number; minutes: number };
  /** the program, unpacked (the construct job's try_plan has it), for a step that runs the program's own tool */
  program?: string | null;
  /** that program's pinned sha256: a product a step of the program made is kept under the key the make job will look for */
  programSha?: string | null;
  /** the game a product is kept for when the input names none (a path) */
  gameId?: number | null;
  progress?: (p: number, message: string) => void;
}

/** what writing `bytes` takes, in minutes, at a pace a NAS array keeps (about 60 MB/s) */
const minutesFor = (bytes: number) => Math.max(1, Math.ceil(bytes / 60e6 / 60));

/**
 * A dry run for the construct job (its try_make): 'plan' judges the input and picks the game folder (an archive by its
 * listing and the marker extracted alone) and stops before the first convert or run step; 'full' runs every step when
 * the estimate fits the budget and keeps the product as a provisional 'made' row, so the deterministic make reuses it
 * (dropProvisional removes it at the job's end unless the saved recipe is this one). With no input, the recipe runs on a
 * made-up folder (which builds and tests its converter too); nothing made from it is kept.
 */
export async function makeDry(o: MakeDryOpts): Promise<MakeReport> {
  const rep: MakeReport = { ok: false, problems: [], warnings: [], input: null, picked: null, product: null, estimate: { bytes: 0, minutes: 0 }, lines: [] };
  const make = o.content.make;
  if (!make) { rep.problems.push("the content plan has no make to try"); return rep; }
  const progress = o.progress ?? (() => {});
  const base0 = await freshDir(join(o.work, "try-make"));
  let r: Run | null = null;
  try {
    let input: Input;
    if (!o.input) {
      if (!sandboxOrAllowed()) { rep.warnings.push("not tried: the recipe runs archivers and converters, which happens only in the build sandbox (ludarr's Docker image)"); rep.ok = true; return rep; }
      const made = await madeUpInput({ base: base0, work: o.work, content: o.content, make, signal: o.signal, log: o.log });
      if ("why" in made) { rep.warnings.push(`not tried: ${made.why}`); rep.ok = true; return rep; }
      input = made.input;
      rep.lines.push(`tried on a made-up folder (${made.facts}): there is no game data on the server yet`);
    } else input = await resolveInput(o.input, { gameId: o.gameId ?? null, signal: o.signal, log: o.log });
    const mode: Run["mode"] = input.synthetic ? "full" : o.mode;
    r = await newRun({ mode, work: base0, content: o.content, plan: null, input, signal: o.signal, log: l => { rep.lines.push(l); o.log(l); }, progress });
    r.warnings = rep.warnings;
    if (o.program) r.program = o.program;
    r.programSha = o.programSha ?? null;
    if (input.synthetic && make.input.complete) rep.warnings.push("whether it is the whole game is not tried on a made-up folder");
    const d = await judgeInput(r, { complete: !input.synthetic });
    rep.input = { shape: input.shape, identity: r.identity, sealed: !!(d.sealed || r.identity?.sealed) };
    const unpacks = make.steps.some(s => "unpack" in s) && input.shape === "file";
    rep.estimate = { bytes: (unpacks ? input.size : 0) + input.size, minutes: minutesFor((unpacks ? input.size : 0) + input.size) };
    const stepNeedsProgram = make.steps.findIndex(s => runsProgram(s) || ("run" in s && !!s.run.tool));
    if (mode === "full" && !input.synthetic && (rep.estimate.bytes > o.budget.bytes || rep.estimate.minutes > o.budget.minutes)) {
      rep.warnings.push(`the whole recipe would write about ${gb(rep.estimate.bytes)} and take about ${rep.estimate.minutes} min, more than this try may (${gb(o.budget.bytes)}, ${o.budget.minutes} min): it was tried up to its first convert or run step`);
      r.mode = "plan";
    }
    if (r.mode === "full" && stepNeedsProgram >= 0 && !r.program) {
      rep.warnings.push(`step ${stepNeedsProgram + 1} runs the program's own tool, and this try has no program: it was tried up to that step (try_plan first, then try_make)`);
      r.mode = "plan";
    }
    if (r.mode === "plan") {
      const s = await runSteps(r, { stopBefore: "convert" });
      if (r.picked) rep.picked = { path: r.picked.path, identity: r.picked.identity };
      if (r.picked?.bytes) rep.estimate = { bytes: (unpacks ? input.size : 0) + r.picked.bytes, minutes: minutesFor((unpacks ? input.size : 0) + r.picked.bytes) };
      rep.lines.push(s.stopped ? `stopped before step ${s.stopped} (a plan's try converts nothing)` : "every step was tried");
    } else {
      if (!input.synthetic) { await handOver(r); await prejudgeArchive(r); }
      await runSteps(r);
      await unchanged(r);
      if (r.picked) rep.picked = { path: r.picked.path, identity: r.picked.identity };
      const p = await productOf(r);
      rep.product = { name: p.name, size: p.size, identity: p.identity, contentId: null };
      const gameId = input.gameId ?? o.gameId ?? null;
      const game = gameId != null ? stmts.gameById.get(gameId) as GameRow | undefined : undefined;
      if (input.synthetic) rep.lines.push("nothing made from a made-up folder is kept");
      else if (!game) rep.warnings.push("what it made is not kept: the try names no game");
      else {
        // kept provisionally: the make reuses it when this recipe is saved; dropProvisional removes it otherwise
        const tools = toolsOf(make, r.planTools);
        const { key, recipe } = makeKey({ digest: input.digest, make, tools, program: r.programSha });
        const made: MadeInfo = { from: input.from, recipe, tools, program: make.steps.some(runsProgram) ? r.programSha : null, key, at: Math.floor(mkdeps.now() / 1000) };
        const { row } = await mkdeps.ingestMade(p.path, { role: "game", game }, { made, signal: o.signal, progress: (b, t) => progress(0.9, `checking what it made · ${gb(b)} of ${gb(t)}`) });
        rep.product.contentId = row.id;
        rep.lines.push(`kept as ${row.name} (row ${row.id}) until the plan is saved: a make with this recipe reuses it`);
      }
    }
  } catch (e) {
    if (isCancel(e, o.signal)) throw new Error("cancelled");
    rep.problems.push(e instanceof EnvError ? `this server's, not the recipe's: ${msgOf(e)}` : msgOf(e));
  } finally {
    if (r) await stopUnder(r.base).catch(() => 0);
    await removeTree(base0).catch(() => []);
  }
  rep.ok = rep.problems.length === 0;
  return rep;
}

/**
 * At the construct job's end: each provisional product of its dry runs (contentIds) stays only when the content plan
 * that was saved makes it under the same key (the same input, recipe, converters and program); the others are removed.
 */
export async function dropProvisional(o: { contentIds: number[]; content: ContentPlan | null; programSha?: string | null; log?: (line: string) => void }): Promise<{ kept: number[]; removed: number[] }> {
  const out = { kept: [] as number[], removed: [] as number[] };
  for (const id of o.contentIds) {
    const row = getContent(id);
    const made = row ? contentMade(row) : null;
    if (!row || !made) continue;
    const make = o.content?.make;
    const again = make ? makeKey({ digest: made.from.digest, make, tools: toolsOf(make, made.tools.find(t => t.startsWith("tools@"))?.slice(6) ?? null), program: o.programSha ?? made.program ?? null }).key : null;
    if (again === made.key) { out.kept.push(id); continue; }
    try { await mkdeps.removeContent(id); out.removed.push(id); o.log?.(`removed ${row.name}: what a try made with a recipe the plan did not keep`); }
    catch (e) { o.log?.(`${row.name} stays (${msgOf(e)})`); }
  }
  return out;
}

/** the product made before for this input and recipe, if there is one (a carry run asks before it queues a make; the
 *  make itself reuses it anyway) */
export function madeFor(o: { plan: PlanRow; content: ContentPlan; input: MakeInputRef }): ContentRow | null {
  const make = o.content.make;
  if (!make) return null;
  let digest: string | null = null, gameId: number | null = null;
  if (o.input.from === "copy") {
    const pkg = stmts.packageById.get(o.input.packageId) as PackageRow | undefined;
    const f = pkg?.game_id ? mkdeps.copyFacts(pkg.game_id) : null;
    if (f?.sha256 && f.packageId === o.input.packageId) { digest = `sha256:${f.sha256}`; gameId = pkg!.game_id; }
  } else if (o.input.from === "kept") {
    const row = getContent(o.input.contentId);
    const h = row ? contentHashes(row) : null;
    if (row && (h?.sha256 || h?.sha1)) { digest = h.sha256 ? `sha256:${h.sha256}` : `sha1:${h.sha1}`; gameId = row.game_id; }
  } else if (o.input.digest) digest = `sha256:${o.input.digest}`;
  if (!digest || gameId == null) return null;
  const { key } = makeKey({ digest, make, tools: toolsOf(make, null), program: planPinned(o.plan)?.sha256 ?? null });
  return madeRow(gameId, key, o.content);
}

