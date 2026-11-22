/**
 * ludarr — how a game's copy starts, and the admin's hand on it (the game page's "Starts with", the way card's line).
 *
 * A copy starts as its manifest's launch says (packages.manifest_json, and ahoy.json beside its files): the program, its
 * arguments (argv, and args for launchers before 0.10), the folder it starts in, its variables. ludarr finds that start —
 * the importer's pick, or a way's plan with the way's own arguments — and the admin may set it by hand:
 *
 *   intent   what the admin set (src/ways/types.ts LaunchChoice), kept where the next copy of the same origin reads it:
 *            the way's overrides.launch for a copy a way builds, games.launch_json for the game's imported PC copies
 *   result   the current copy's manifest, rewritten in place at once: same package, same files (nothing copied or hashed),
 *            launch.rev stamped with the time of the change, requires raised to what the start needs; a history line and
 *            the package event follow
 *   found    packages.launch_auto_json: the start the job found before any hand ({launch, requires}); Reset puts it back
 *
 * A new copy takes the intent when its program (and folder, and the files of the copy it named as {install}/…) is in it — a
 * way's build (src/ways/assemble.ts) and an import or upgrade (src/process/runner.ts) ask choiceOnDisk — and otherwise starts
 * as found and says the start set by hand was not applied, and why (the job's log, a history line, the game page). A rescan
 * never touches a manifest; a console dump has no start to set. A way's copy whose way is gone keeps the start set by hand on
 * it, said as such, and only Reset is offered. Players see none of this: the manifest carries only the start itself and the
 * opaque rev.
 *
 * What the package says about its files is quoted for the admin, as written and never generated: a program's version info
 * and whether it opens a window (src/library/pe.ts), a script's first comment and the program it runs, sentences naming a
 * file in the README-like files and in the scripts' comments, the plan's or the importer's notes. Read once per package,
 * bounded (64 KB a script, 1 MB a README, 300 programs).
 *
 * A start is a program (.exe). It may be a Windows command script (.bat, .cmd) only when the admin picks it by hand: a
 * game whose own script is how it starts (it loads a driver first, asks for administrator rights, starts two programs).
 * The script runs on each player's PC as it is written, so what it does there is said before it is picked (scriptDoes:
 * administrator rights, a service or driver, the registry, downloads …, each with the line that does it). Its arguments
 * are plain words only (SCRIPT_ARG), the copy needs Ahoy 0.11 (LAUNCHER_FOR_SCRIPTS), and ludarr itself never picks one.
 */
import { lstat, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { db, serializePackage, stmts, type GameRow, type JobRow, type PackageRow } from "../db";
import { events } from "../events";
import { NOT_LAUNCH_DIR, NOT_LAUNCH_NAME, copyLayout, helperProgram, type Manifest, type ManifestFile } from "../process/validate";
import { getContent, getPlan, getWay, planSpec, updateWay, wayContent, wayOverrides, type PlanRow, type WayRow } from "../ways/store";
import { LAUNCHER_FOR_SCRIPTS, LAUNCHER_FOR_WAYS, type LaunchChoice, type RuntimePlanSpec } from "../ways/types";
import { checkLaunchChoice, launcherPathProblem, placedName, placeholdersIn, SCRIPT_ARG, SCRIPT_ARG_WORDS, SCRIPT_EXT, SCRIPT_VAR, START_SCRIPT, validateWayOverrides } from "../ways/validate";
import { record } from "./history";
import { peInfo, type PeInfo } from "./pe";

export class LaunchError extends Error {
  constructor(msg: string, public status: 400 | 404 | 409 | 500 = 400, public errors: string[] = []) { super(msg); }
}
/** how the copy's ahoy.json is put in place (the tests stand in for the disk) */
export const ldeps = {
  writeFile: (path: string, data: string | Uint8Array, o: { flag: string }) => writeFile(path, data, o),
  rename: (from: string, to: string) => rename(from, to),
};

/** a start as a copy carries it, before it is written into a manifest: the program, its arguments ({content} already the
 *  placed file), the folder it starts in (absent: the program's), its variables */
export interface Start { exe: string; argv: string[]; cwd?: string; env?: Record<string, string> }
/** the start a copy's job found, and the launcher it needed: what Reset gives back */
export interface LaunchAuto { launch: Manifest["launch"]; requires: { launcher: string } | null }
/** who a start comes from: set by hand, the plan (a way's copy), ludarr's own pick, the AI importer's */
export type StartBy = "hand" | "plan" | "ludarr" | "ai";
export interface Words { text: string; source: string }

const WAY_KINDS = new Set(["recomp", "port", "emulated"]);
const SCRIPT = /\.(cmd|bat|ps1|vbs)$/i;
const README = /(^|\/)(readme[^/]*|[^/]+\.(md|txt))$/i;
const SCRIPT_WORDS = "Ahoy starts programs and Windows command scripts (.bat, .cmd), no other script and no shortcut. Pick the program it starts.";
/** said whenever a script is what starts a game: what the admin takes on for every player */
const SCRIPT_RUNS_WORDS = "is a script: on each player's PC it runs through the Windows command shell and does whatever it says there, with that player's rights. Read it before you pick it";
const INSTALL = "{install}";
/** the example folder the preview fills {install} with */
export const EXAMPLE_ROOT = "C:\\Games\\Ahoy";

/* ─────────── small shared rules ─────────── */

const lower = (s: string) => s.toLowerCase();
const depth = (p: string) => p.split("/").length - 1;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (posix.dirname(p) === "." ? "" : posix.dirname(p));
const hasPlaceholder = (s: string) => placeholdersIn(s).length > 0;

/** the paths inside the game's folder a value names as {install}/<path> (slashes as the copy writes them, none at the end) */
export function installRefs(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\{install\}[\\/]([^\s"';,]*)/g)) { const rel = m[1].replace(/\\/g, "/").replace(/\/+$/, ""); if (rel) out.push(rel); }
  return out;
}
/** the first {install}/<path> of a start's arguments and variables a copy lacks, as words ("argument 2 names game/x.zar"):
 *  the paths it named in the copy it was set on (`paths`), or every one when it keeps no such list; null when none is gone */
async function namedButGone(s: Pick<LaunchChoice, "argv" | "env" | "paths">, has: (rel: string) => boolean | Promise<boolean>): Promise<string | null> {
  const wanted = s.paths ? new Set(s.paths.map(lower)) : null;
  const named: [string, string][] = [...s.argv.map((a, i): [string, string] => [`argument ${i + 1}`, a]), ...Object.entries(s.env ?? {}).map(([k, v]): [string, string] => [`the variable ${k}`, v])];
  for (const [what, value] of named) {
    for (const rel of installRefs(value)) {
      if (wanted && !wanted.has(lower(rel))) continue;
      if (!(await has(rel))) return `${what} names ${rel}`;
    }
  }
  return null;
}
/** where a start comes from in the words a history line ends with */
export const asFound = (by: StartBy): string => (by === "plan" ? "as the plan says" : by === "ai" ? "as the AI importer found it" : "as ludarr found it");

/** one argument the way Windows programs read their command line back (the launcher's own quoteArg) */
export function quoteArg(a: string): string {
  if (a !== "" && !/[\s"]/.test(a)) return a;
  let out = '"', slashes = 0;
  for (const ch of a) {
    if (ch === "\\") { slashes++; continue; }
    out += ch === '"' ? "\\".repeat(slashes * 2 + 1) + '"' : "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}
/** the arguments a manifest's launch passes: argv, else the old space-joined args */
export const argvOf = (l: { argv?: string[]; args?: string } | null | undefined): string[] =>
  !l ? [] : Array.isArray(l.argv) ? l.argv.map(String) : typeof l.args === "string" && l.args ? l.args.split(" ").filter(Boolean) : [];
/** the whole start on one line, as the admin reads it: the program and every argument */
export const startLine = (exe: string, argv: string[]) => [exe, ...argv.map(quoteArg)].join(" ");
export const launchLine = (l: { exe: string; argv?: string[]; args?: string } | null | undefined) => (l ? startLine(l.exe, argvOf(l)) : "");

/** the launch a manifest carries for a start (the same shape buildManifest writes): args joined when simple, the program's
 *  folder when none is named, argv only when given, env only when it has variables */
export function manifestLaunch(s: { exe: string; argv?: string[]; cwd?: string; env?: Record<string, string> }): Manifest["launch"] {
  const simple = !s.argv || s.argv.every(a => a !== "" && !/\s/.test(a) && !hasPlaceholder(a));
  return {
    exe: s.exe, args: s.argv && simple ? s.argv.join(" ") : "", cwd: s.cwd ?? dirOf(s.exe),
    ...(s.argv ? { argv: [...s.argv] } : {}), ...(s.env && Object.keys(s.env).length ? { env: { ...s.env } } : {}),
  };
}
/** what Ahoy needs to start it: 0.10 or newer for an argument that would not survive the old space-joined args (a space, a
 *  placeholder), a variable, or a placeholder in the folder (src/ways/assemble.ts's rule for what a start needs) */
export function startNeeds(s: { exe?: string; argv?: string[]; cwd?: string; env?: Record<string, string> }): string | null {
  const simple = (s.argv ?? []).every(a => a !== "" && !/\s/.test(a) && !hasPlaceholder(a));
  const ways = !simple || Object.keys(s.env ?? {}).length > 0 || hasPlaceholder(s.cwd ?? "") ? LAUNCHER_FOR_WAYS : null;
  // a script is started only by an Ahoy that knows how (an older one refuses it, and says it needs the newer)
  return s.exe && START_SCRIPT.test(s.exe) ? newerLauncher(ways, LAUNCHER_FOR_SCRIPTS) : ways;
}
const cmpVersion = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
/** the newer of two launcher versions (null: none needed) */
export const newerLauncher = (a: string | null | undefined, b: string | null | undefined): string | null => (!a ? b ?? null : !b ? a : cmpVersion(a, b) >= 0 ? a : b);

/** the same start (program, arguments, folder, variables), whatever its stamp and the order of its variables */
export function sameLaunch(a: Manifest["launch"], b: Manifest["launch"]): boolean {
  const key = (l: Manifest["launch"]) => JSON.stringify([l.exe, l.args ?? "", l.cwd ?? "", l.argv ?? null, Object.entries(l.env ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))]);
  return key(a) === key(b);
}

/* ─────────── the launcher's keep / seed globs (launcher/src/engine.ts globMatcher, as it is) ─────────── */

function segRegex(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") { while (seg[i + 1] === "*") i++; out += "[^/]*"; }
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = seg.indexOf("}", i), body = end > i ? seg.slice(i + 1, end) : "";
      if (body.includes(",") && !body.includes("{")) { out += `(?:${body.split(",").map(segRegex).join("|")})`; i = end; }
      else out += "\\{";
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}
function globRegex(glob: string): RegExp {
  const segs = glob.replace(/\\/g, "/").split("/");
  let out = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") out += last ? ".*" : "(?:[^/]*/)*";
    else out += segRegex(seg) + (last ? "" : "/");
  });
  return new RegExp(`^${out}$`, "i");
}
/** keep / seed globs as one test over install-relative paths, exactly as the launcher reads them */
export function globMatcher(globs: readonly unknown[] | null | undefined): (rel: string) => boolean {
  const res = (globs ?? []).filter((g): g is string => typeof g === "string" && launcherPathProblem(g, { glob: true }) === null).map(globRegex);
  if (!res.length) return () => false;
  return rel => { const r = rel.replace(/\\/g, "/"); return res.some(re => re.test(r)); };
}

/* ─────────── the game's copy ─────────── */

interface Copy {
  game: GameRow; pkg: PackageRow; m: Manifest; kind: string;
  from: "way" | "import"; way: WayRow | null; plan: PlanRow | null; spec: RuntimePlanSpec | null;
  files: ManifestFile[]; byLower: Map<string, ManifestFile>; folders: Map<string, string>;
  /** the way's game file inside the copy ({content}), when it ships and is there */
  placed: string | null;
  isKept: (rel: string) => boolean;
}
const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
const wayOfPackage = db.query("SELECT * FROM ways WHERE package_id=? ORDER BY id DESC LIMIT 1");
/** a job that is replacing the game's copy: an import, a way's build, its game file taken in or made, its program built */
const replacing = db.query(`SELECT * FROM jobs WHERE game_id=? AND state IN ('queued','running')
  AND (COALESCE(kind, 'import') IN ('import', 'assemble', 'make', 'content') OR (kind='build' AND json_extract(spec_json, '$.wayId') IS NOT NULL)) ORDER BY id DESC LIMIT 1`);
/** why the game's copy cannot be changed right now (it is being rebuilt), or null */
export const busyWhy = (gameId: number): string | null => (replacing.get(gameId) as JobRow | null) ? "the game's copy is being rebuilt" : null;

/** the start a game's imported PC copies are set to start with (null: as ludarr finds it) */
export function gameChoice(g: Pick<GameRow, "launch_json">): LaunchChoice | null {
  const errors: string[] = [];
  const raw = parse<unknown>(g.launch_json, null);
  return raw ? checkLaunchChoice(raw, "launch", { content: false }, errors) : null;
}
/** what a copy's job found (the manifest as it is, for a copy no start was ever set by hand on) */
export function autoOf(pkg: Pick<PackageRow, "launch_auto_json">, m: Manifest): LaunchAuto {
  const a = parse<LaunchAuto | null>(pkg.launch_auto_json, null);
  if (a?.launch?.exe) return { launch: a.launch, requires: a.requires?.launcher ? { launcher: a.requires.launcher } : null };
  const { rev: _rev, ...launch } = m.launch;
  return { launch, requires: m.requires?.launcher ? { launcher: m.requires.launcher } : null };
}

/** the folder a way's game file sits at in its package ({content}), as its build placed it: from the way's game file, else
 *  from where the plan's argv passes {content} in the copy's own argv; only when the copy holds it */
function placedOf(way: WayRow, plan: PlanRow, spec: RuntimePlanSpec, m: Manifest, has: (rel: string) => boolean): string | null {
  const c = wayContent(way, plan);
  if (!c || c.ship === false) return null;
  const tries: string[] = [];
  if (c.kind === "folder") tries.push(c.place);
  else if (way.content_id != null) { const f = getContent(way.content_id); if (f) tries.push(c.place.replace(/\{name\}/g, () => placedName(f.name))); }
  const argv = argvOf(m.launch);
  spec.launch.argv.forEach((a, i) => {
    if (!a.includes("{content}") || typeof argv[i] !== "string") return;
    const [pre, post] = a.split("{content}", 2);
    const v = argv[i];
    if (v.startsWith(pre) && v.endsWith(post ?? "")) { const mid = v.slice(pre.length, v.length - (post ?? "").length); if (mid.startsWith(`${INSTALL}/`)) tries.push(mid.slice(INSTALL.length + 1)); }
  });
  return tries.find(t => has(t)) ?? null;
}

function copyOf(gameId: number): Copy {
  const game = stmts.gameById.get(gameId) as GameRow | undefined;
  if (!game) throw new LaunchError("no such game", 404);
  const pkg = stmts.packageForGame.get(gameId) as PackageRow | undefined;
  if (!pkg) throw new LaunchError("the game has no copy yet", 404);
  const m = parse<Manifest | null>(pkg.manifest_json, null);
  if (!m?.launch) throw new LaunchError("the copy's manifest cannot be read", 409);
  const kind = m.kind ?? "native";
  const from = WAY_KINDS.has(kind) ? "way" : "import";
  const way = from === "way" ? ((wayOfPackage.get(pkg.id) as WayRow | null) ?? null) : null;
  const plan = way ? getPlan(way.plan_id) : null;
  const spec = plan ? planSpec(plan) : null;
  const files = Array.isArray(m.files) ? m.files : [];
  const byLower = new Map(files.map(f => [lower(f.path), f] as [string, ManifestFile]));
  const folders = new Map<string, string>();
  for (const f of files) { let d = dirOf(f.path); while (d) { if (folders.has(lower(d))) break; folders.set(lower(d), d); d = dirOf(d); } }
  const has = (rel: string) => byLower.has(lower(rel)) || folders.has(lower(rel));
  const placed = way && plan && spec ? placedOf(way, plan, spec, m, has) : null;
  const isKept = globMatcher([...(m.keep ?? []), ...(m.seed ?? [])]);
  return { game, pkg, m, kind, from, way, plan, spec, files, byLower, folders, placed, isKept };
}
/** why the copy's start cannot be set at all (a console dump, a way's copy whose way is gone), or null */
function notEditable(c: Copy): string | null {
  if (c.kind === "rom") return "a console dump: a way to play starts it";
  if (c.from === "way" && !c.way) return "the way to play that built this copy is gone: build a way to play again, or import a new copy, to change how the game starts";
  if (c.from === "way" && !c.spec) return "the plan of the way that built this copy is gone: build a way to play again, or import a new copy, to change how the game starts";
  return null;
}
/** the copy starts otherwise than its job found (its program, arguments, folder, variables or the launcher it needs) */
const differsFromFound = (m: Manifest, auto: LaunchAuto) => !sameLaunch(m.launch, auto.launch) || (m.requires?.launcher ?? null) !== (auto.requires?.launcher ?? null);
/** the start set by hand for this copy's origin */
const intentOf = (c: Copy): LaunchChoice | null => (c.from === "way" ? (c.way ? wayOverrides(c.way).launch ?? null : null) : gameChoice(c.game));

/** the folder a start's cwd names, as a path in the copy ("" the game's folder), and whether it is the program's own */
function folderOf(exe: string, cwd: string | undefined): { kind: "program" | "game" | "folder"; folder: string } {
  if (cwd === undefined) return { kind: "program", folder: dirOf(exe) };
  const rel = cwd === INSTALL ? "" : cwd.startsWith(`${INSTALL}/`) ? cwd.slice(INSTALL.length + 1) : cwd;
  if (lower(rel) === lower(dirOf(exe))) return { kind: "program", folder: dirOf(exe) };
  return rel ? { kind: "folder", folder: rel } : { kind: "game", folder: "" };
}
/** a manifest's cwd as a start's (absent: the program's folder) */
function cwdOfLaunch(l: Manifest["launch"]): string | undefined {
  const cwd = l.cwd ?? "";
  if (!cwd) return undefined;
  if (cwd === INSTALL) return dirOf(l.exe) ? INSTALL : undefined;
  const rel = cwd.startsWith(`${INSTALL}/`) ? cwd.slice(INSTALL.length + 1) : cwd;
  return lower(rel) === lower(dirOf(l.exe)) ? undefined : rel;
}

/* ─────────── what the package says about its files ─────────── */

/** a script's own words: its first comment, and the commands it runs (the first ten lines whose command is a program) */
interface ScriptInfo { comment: string | null; commands: ScriptCommand[]; /** what a command script does on a PC beyond starting a program (scriptDoes) */ does: string[] }
/** what was read of a package: its programs' headers, its README-like files and scripts as sentences, each script's own words,
 *  and the sentences already found naming each file (by its name) */
interface Described { pe: Map<string, Promise<PeInfo>>; texts: { source: string; sentences: string[] }[]; scripts: Map<string, ScriptInfo>; named: Map<string, Words[]> }
const described = new Map<string, Promise<Described>>();
const DESCRIBED_KEEP = 16;
const PROGRAMS_READ = 300;

/** the first `max` bytes of a regular file of the copy as text (UTF-8, or UTF-16 with its byte-order mark); null for
 *  anything else (a link, a folder, a file gone) */
async function headText(root: string, rel: string, max: number): Promise<string | null> {
  if (rel.split("/").some(s => !s || s === "." || s === "..")) return null;
  const abs = join(root, ...rel.split("/"));
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile()) return null;
  const fh = await open(abs, "r").catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(Math.min(max, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);
    if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
    return b.toString("utf8").replace(/^\uFEFF/, "");
  } catch { return null; } finally { await fh.close().catch(() => {}); }
}

/** the HTML a README may hold (only these: a usage line's <path to the game> or <folder> is words, not a tag) */
const HTML_TAG = /<\/?(?:a|abbr|b|big|blockquote|br|center|code|del|details|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|ol|p|picture|pre|s|samp|small|source|span|strike|strong|sub|summary|sup|table|tbody|td|th|thead|tr|tt|u|ul|var)(?:\s[^<>]*)?\/?>/gi;
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
/** markdown out of one line of prose: headings, quotes, list markers, links, emphasis, code ticks and HTML tags — a code span
 *  is kept as written (a usage line's <path>, a name's __underscores__) */
function plain(s: string): string {
  let t = s.trim();
  if (t.startsWith("|")) t = t.replace(/^\|/, "").replace(/\|$/, "").replace(/\s*\|\s*/g, " · ");
  t = t.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
  // the code spans set aside while the markdown and the tags go, then put back as they are
  const code: string[] = [];
  t = t.replace(/(`+)(.+?)\1/g, (_m, _ticks: string, inner: string) => `\uE000${code.push(inner.trim()) - 1}\uE001`);
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/`+/g, "").replace(HTML_TAG, "");
  return oneLine(t.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => code[Number(i)] ?? ""));
}
const sentencesIn = (para: string): string[] => para.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/).map(s => s.trim()).filter(Boolean);
/** a README's prose as sentences: paragraphs (a blank line, a heading, a list item or a table row starts one) joined, each
 *  split at its sentence ends; a fenced code line is a sentence of its own */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let para: string[] = [], fence = false;
  const flush = () => { if (para.length) { out.push(...sentencesIn(plain(para.join(" ")))); para = []; } };
  for (const raw of text.split(/\r?\n/).slice(0, 20_000)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) { const p = oneLine(line); if (p) out.push(p); continue; }
    if (!line) { flush(); continue; }
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(line)) flush();
    para.push(line);
  }
  flush();
  return out;
}

/** a comment line of a script, as its words (null: not a comment) */
function commentText(line: string, ext: string): string | null {
  const l = line.trim().replace(/^@/, "");
  if (ext === "ps1") return l.startsWith("#") && !l.startsWith("#requires") ? l.replace(/^#+\s?/, "") : null;
  if (ext === "vbs") return /^('|rem\b)/i.test(l) ? l.replace(/^('|rem\b)\s?/i, "") : null;
  return /^(rem\b|::)/i.test(l) ? l.replace(/^(rem\b|::)\s?/i, "") : null;
}
/** a command a script runs: the line as the admin reads it (the program by its name), the program's name, the program as a
 *  path in the copy (null: a drive, a variable or the system names it, or it climbs out), and its arguments */
export interface ScriptCommand { line: string; name: string; path: string | null; args: string }
/** the script's own folder as a script names it: %~dp0 (which ends in a backslash of its own), $PSScriptRoot */
const SCRIPT_DIR = /^(?:%~dp0[\\/]?|\$PSScriptRoot(?:[\\/]|$)|\$\{PSScriptRoot\}(?:[\\/]|$))/i;
/** a path a script names, as a path in the copy: from the script's own folder (`dir`: %~dp0, $PSScriptRoot) or from the
 *  folder it is in now (`at`, null when not known: a bare name, .\, a relative path — the script's own folder when it is
 *  double-clicked); null for a drive, the root, a variable, or a path that climbs out of the game's folder */
function scriptPath(token: string, dir: string, at: string | null): string | null {
  let t = token.trim().replace(/^["']+|["']+$/g, "");
  let from: string | null = at;
  if (SCRIPT_DIR.test(t)) { t = t.replace(SCRIPT_DIR, ""); from = dir; }
  else if (/^[A-Za-z]:|^[\\/]|[%$]/.test(t)) return null;
  if (from === null) return null;
  const out: string[] = [];
  for (const p of [...(from ? from.split("/") : []), ...t.split(/[\\/]+/)]) {
    if (!p || p === ".") continue;
    if (p === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(p);
  }
  return out.join("/");
}
const CD = /^(cd|chdir|pushd|set-location|sl|push-location)(?:\s+\/d)?(?:\s+-(?:literal)?path)?\s+(.+?)\s*$/i;

/** what a command script does on the PC it runs on, beyond starting a program: each kind once, in words, with the first
 *  line that does it (the strongest sign first: "sc create" before a mere .sys name). What the admin reads before a script
 *  becomes how a game starts on every player's PC; a script that does none of it says nothing here */
const SCRIPT_DOES: { words: string; signs: RegExp[] }[] = [
  { words: "asks for administrator rights on the player's PC (Windows asks the player each time)", signs: [/-verb\s+runas\b/i, /\brunas(\.exe)?\s/i, /\bnet\s+session\b/i, /\bfltmc\b/i] },
  { words: "installs or starts a Windows service or driver", signs: [/\bsc(\.exe)?\s+create\b/i, /\bsc(\.exe)?\s+(start|config)\b/i, /\b(pnputil|devcon)\b/i, /\bnet\s+start\b/i, /\.sys\b/i] },
  { words: "changes the Windows registry", signs: [/\breg(\.exe)?\s+(add|delete|import)\b/i, /\bregedit\b/i] },
  { words: "changes Windows security or system settings", signs: [/\b(Add-MpPreference|Set-MpPreference)\b/i, /\bnetsh\b/i, /\bbcdedit\b/i] },
  { words: "downloads from the network", signs: [/\b(curl|wget|bitsadmin|Invoke-WebRequest|iwr|Start-BitsTransfer)\b/i, /certutil\b.*-urlcache/i, /\bDownload(File|String)\b/i] },
  { words: "adds a scheduled task", signs: [/\bschtasks\b/i, /\bRegister-ScheduledTask\b/i] },
  { words: "deletes folders", signs: [/\b(del|erase|rd|rmdir)\b[^\r\n]*\s\/s\b/i, /\bRemove-Item\b[^\r\n]*-Recurse/i, /\bformat\s+[a-z]:/i] },
  { words: "runs PowerShell", signs: [/\b(powershell|pwsh)(\.exe)?\b/i] },
];
export function scriptDoes(text: string): string[] {
  const lines = text.split(/\r?\n/).slice(0, 2000).map(l => l.trim()).filter(l => l && !/^(@?rem\b|::)/i.test(l));
  const out: string[] = [];
  for (const d of SCRIPT_DOES) {
    for (const sign of d.signs) {
      const line = lines.find(l => sign.test(l));
      if (line) { out.push(`${d.words}: ${line.replace(/^@/, "").slice(0, 140)}`); break; }
    }
  }
  return out;
}
/** a script's own words: its first comment block, every comment paragraph (for the sentences naming a file), and the
 *  programs it starts (the lines whose command is a program or another script), each resolved from the script's folder
 *  (`dir`, a folder of the copy) and the folder a cd / pushd / Set-Location moved it to */
export function readScript(text: string, ext: string, dir = ""): { comment: string | null; paragraphs: string[]; commands: ScriptCommand[] } {
  const lines = text.split(/\r?\n/).slice(0, 400);
  /** each comment paragraph with the line it starts on, and its lines as written */
  const blocks: { text: string; line: number; lines: string[] }[] = [];
  const commands: ScriptCommand[] = [];
  let block: string[] = [], startedAt = 0, inBlock = false;
  let at: string | null = dir;
  const was: (string | null)[] = [];
  const flush = () => { if (block.length) { const p = block.join(" ").replace(/\s+/g, " ").trim(); if (p) blocks.push({ text: p, line: startedAt, lines: block }); block = []; } };
  const add = (t: string, i: number) => { if (!block.length) startedAt = i; block.push(t); };
  lines.forEach((raw, i) => {
    // a PowerShell block comment <# … #>
    if (ext === "ps1" && (inBlock || /^\s*<#/.test(raw))) {
      inBlock = !/#>\s*$/.test(raw);
      const t = raw.replace(/^\s*<#/, "").replace(/#>\s*$/, "").trim();
      if (t && !/^\.[A-Z]+$/.test(t)) add(t, i);
      if (!inBlock) flush();
      return;
    }
    const c = commentText(raw, ext);
    if (c !== null) { if (c.trim()) add(c.trim(), i); return; }
    flush();
    const l = raw.trim().replace(/^@/, "");
    const cd = CD.exec(l);
    if (cd) { if (/^(pushd|push-location)$/i.test(cd[1])) was.push(at); at = scriptPath(cd[2], dir, at); return; }
    if (/^(popd|pop-location)\b/i.test(l)) { at = was.length ? was.pop()! : null; return; }
    if (commands.length < 10) { const r = commandOf(raw, dir, at); if (r) commands.push(r); }
  });
  flush();
  // its own first comment: a block near the top (after @echo off, param(…) and the like)
  const top = blocks.find(b => b.line < 30);
  // its first sentence: up to the first line that ends one (a block can run on with a page of usage lines)
  let first: string | null = null;
  if (top) {
    const upTo = top.lines.findIndex(l => /[.!?:]$/.test(l.trim()));
    const lead = (upTo >= 0 ? top.lines.slice(0, upTo + 1) : top.lines).join(" ").replace(/\s+/g, " ").trim();
    first = sentencesIn(lead)[0] ?? lead;
  }
  return { comment: first ? cut(first) : null, paragraphs: blocks.map(b => b.text), commands };
}
const PROGRAM_TOKEN = /^(?:"([^"]+)"|'([^']+)'|(\S+))/;
/** the command a script runs, as far as the copy goes: the first whose program is that very file of the copy (by its path,
 *  as the script resolves it; the line then names it by that path), or that hands the shell or the system program a file of
 *  the copy (powershell -File run-windows.ps1); null when none does (a script that only opens Explorer, or whose program is
 *  in a variable or not where it says, says nothing of what starts the game). `file` is the copy's file it starts */
function runsOf(s: ScriptInfo, c: { byLower: Map<string, ManifestFile> }): { line: string; file: string | null } | null {
  const names = new Set([...c.byLower.values()].map(f => lower(base(f.path))));
  const named = (t: string) => names.has(lower(t.replace(/^["']+|["']+$/g, "").replace(/^.*[\\/]/, "")));
  for (const cmd of s.commands) {
    const f = cmd.path ? c.byLower.get(lower(cmd.path)) : undefined;
    if (f) return { line: `${f.path}${cmd.args ? ` ${cmd.args}` : ""}`.slice(0, 200), file: f.path };
    if (cmd.args.split(/\s+/).some(named)) return { line: cmd.line, file: null };
  }
  return null;
}
/** the program a script line starts, and the line as the admin reads it (the program by its name, the script's own folder
 *  taken out of its arguments); `dir` the script's folder, `at` the folder the script is in now */
function commandOf(raw: string, dir = "", at: string | null = dir): ScriptCommand | null {
  let l = raw.trim().replace(/^@/, "");
  if (!l || /^(if|echo|set|setlocal|endlocal|goto|exit|pause|cd|pushd|popd|title|chcp|for|param|\$|\(|\)|\{|\}|:)/i.test(l)) return null;
  l = l.replace(/^call\s+/i, "").replace(/^start\s+(?:"[^"]*"\s+)?(?:\/\w+\s+)*/i, "").replace(/^&\s*/, "").replace(/^Start-Process\s+(?:-FilePath\s+)?/i, "");
  const m = PROGRAM_TOKEN.exec(l);
  if (!m) return null;
  const token = m[1] ?? m[2] ?? m[3] ?? "";
  if (!/\.(exe|com|cmd|bat|ps1|vbs)$/i.test(token)) return null;
  const name = token.replace(/^.*[\\/]/, "").replace(/^%~dp0/i, "");
  // a path from the script's own folder handed over is said as the copy's path (the folder noise taken out)
  const inCopy = (anchor: string, p: string) => scriptPath(anchor + p, dir, at) ?? p.replace(/^[\\/]+/, "");
  const args = l.slice(m[0].length)
    .replace(/"(%~dp0|\$PSScriptRoot(?:[\\/]|(?="))|\$\{PSScriptRoot\}(?:[\\/]|(?=")))([^"]*)"/gi, (_m, a: string, p: string) => inCopy(a, p))
    .replace(/(%~dp0|\$PSScriptRoot[\\/]|\$\{PSScriptRoot\}[\\/])(\S*)/gi, (_m, a: string, p: string) => inCopy(a, p))
    .replace(/\s+(%\*|@args|\$args)\s*$/i, "").replace(/\s+/g, " ").trim();
  return { line: `${name}${args ? ` ${args}` : ""}`.slice(0, 200), name, path: scriptPath(token, dir, at), args };
}

function describe(pkg: PackageRow, files: ManifestFile[]): Promise<Described> {
  const key = `${pkg.id}:${pkg.path}`;
  let d = described.get(key);
  if (!d) {
    d = (async (): Promise<Described> => {
      // the README-like files first (README* before the rest), then the scripts' own comments
      const texts: Described["texts"] = [];
      const readmes = files.filter(x => README.test(x.path) && depth(x.path) <= 1)
        .sort((a, b) => Number(!/(^|\/)readme/i.test(a.path)) - Number(!/(^|\/)readme/i.test(b.path)) || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path)).slice(0, 40);
      for (const f of readmes) {
        const text = await headText(pkg.path, f.path, 1024 * 1024);
        if (text) texts.push({ source: f.path, sentences: sentencesOf(text) });
      }
      const scripts = new Map<string, ScriptInfo>();
      for (const f of files.filter(x => SCRIPT.test(x.path)).slice(0, 100)) {
        const text = await headText(pkg.path, f.path, 64 * 1024);
        if (text === null) continue;
        const ext = lower(f.path.slice(f.path.lastIndexOf(".") + 1));
        const s = readScript(text, ext, dirOf(f.path));
        scripts.set(f.path, { comment: s.comment, commands: s.commands, does: START_SCRIPT.test(f.path) ? scriptDoes(text) : [] });
        const sentences = s.paragraphs.flatMap(p => sentencesIn(p));
        if (sentences.length) texts.push({ source: base(f.path), sentences });
      }
      return { pe: new Map(), texts, scripts, named: new Map() };
    })();
    described.set(key, d);
    while (described.size > DESCRIBED_KEEP) described.delete(described.keys().next().value!);
    d.catch(() => described.delete(key));
  }
  return d;
}
function peOf(d: Described, pkg: PackageRow, rel: string): Promise<PeInfo> {
  let p = d.pe.get(rel);
  if (!p) {
    p = rel.split("/").some(s => !s || s === "." || s === "..") ? Promise.resolve({ kind: "other", ui: null, version: {} } as PeInfo) : peInfo(join(pkg.path, ...rel.split("/")));
    d.pe.set(rel, p);
  }
  return p;
}
const cut = (s: string) => (s.length > 200 ? `${s.slice(0, 199).trimEnd()}…` : s);
/** a sentence cut to 200 characters around the file's name, so the quote always shows it */
function cutAround(s: string, name: string): string {
  if (s.length <= 200) return s;
  const at = s.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0 || at + name.length <= 190) return cut(s);
  const from = Math.max(0, Math.min(at - 80, s.length - 197));
  let piece = s.slice(from, from + 197);
  // whole words only, at both ends
  if (from > 0) piece = piece.replace(/^\S*\s+/, "");
  if (from + 197 < s.length) piece = piece.replace(/\s+\S*$/, "");
  return `${from > 0 ? "…" : ""}${piece.trim()}${from + 197 < s.length ? "…" : ""}`;
}
/** every sentence of `texts` naming the file (its name as a whole word, case ignored), at most 20, each once; a plain
 *  substring test first, so a long README costs one scan per name. Kept per text set (`memo`) by the file's name */
function sentencesNaming(name: string, texts: Described["texts"], memo?: Map<string, Words[]>): Words[] {
  const key = lower(name);
  const known = memo?.get(key);
  if (known) return known;
  const whole = new RegExp(`(?<![A-Za-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "i");
  const hits: Words[] = [];
  for (const t of texts) {
    for (const s of t.sentences) {
      if (hits.length >= 20) break;
      if (!s.toLowerCase().includes(key) || !whole.test(s)) continue;
      const text = cutAround(s, name);
      if (!hits.some(h => h.text === text)) hits.push({ text, source: t.source });
    }
  }
  memo?.set(key, hits);
  return hits;
}
/** at most three sentences naming the file from `texts` (the README-like files, then the scripts' comments); one holding the
 *  current arguments first */
function quotesFor(rel: string, texts: Described["texts"], argv: string[], memo?: Map<string, Words[]>): Words[] {
  const hits = sentencesNaming(base(rel), texts, memo);
  const holds = (w: Words) => argv.length > 0 && argv.every(a => w.text.toLowerCase().includes(a.toLowerCase()));
  return [...hits.filter(holds), ...hits.filter(w => !holds(w))].slice(0, 3);
}
/** the words of the package's notes (a way's plan, the importer's) as one more text */
function notesText(c: Copy): Described["texts"][number] | null {
  const notes = c.from === "way" ? c.spec?.notes ?? "" : c.m.notes ?? "";
  if (!notes.trim()) return null;
  return { source: c.from === "way" ? "the plan's notes" : "the importer's notes", sentences: sentencesOf(notes) };
}
const STARTS = /\b(starts?|launch(?:es)?|runs?)\s+(?:the\s+)?game\b|\bplay\b/i;
const SETTINGS_WORDS = String.raw`(?:settings|setup|configuration|config|options)\s+(?:window|dialog|screen|program|tool)`;
const SETTINGS = new RegExp(String.raw`\b${SETTINGS_WORDS}\b`, "i");
/** whether these words say the program itself opens a settings window: its own version info, or a sentence where it is what
 *  opens one ("Double-click X … for the settings window", "X opens its settings window", "The settings window: X") — never
 *  a sentence that only names both ("X plays with the options the settings window saved") */
function opensSettings(rel: string, w: Words): boolean {
  if (!SETTINGS.test(w.text)) return false;
  if (w.source === "version info") return true;
  const x = String.raw`(?<![\w.-])(?:[\w.-]+[\\/])*${base(rel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\w])`;
  const article = String.raw`(?:(?:the|its|a)\s+)?(?:own\s+)?`;
  return [
    String.raw`\b(?:double-?click(?:ing)?|run(?:ning)?|start(?:ing)?|open(?:ing)?|launch(?:ing)?)\s+(?:the\s+)?${x}.{0,60}?\b(?:for|opens?|shows?|brings up|to (?:open|get|see|change))\s+${article}${SETTINGS_WORDS}`,
    String.raw`${x}.{0,40}?\b(?:opens?|shows?|brings up|is|was)\s+${article}${SETTINGS_WORDS}`,
    String.raw`${SETTINGS_WORDS}\s*(?::|=|\(|-|—|\bis\b)\s*(?:the\s+)?${x}`,
  ].some(re => new RegExp(re, "i").test(w.text));
}

export interface ProgramItem {
  path: string; size: number; current: boolean;
  /** what its header says: a program (and whether it opens a window), a library, not a Windows program; null when not read */
  kind: PeInfo["kind"] | null; ui: PeInfo["ui"];
  /** named or placed like an installer, a redistributable or a helper (listed last, dimmed) */
  helper: boolean;
  /** the package's words call it a start */
  starts: boolean;
  /** why it cannot be picked (a library, not a Windows program, a file players keep), or null */
  refused: string | null;
  words: Words[];
}
export interface ScriptItem {
  path: string; size: number; comment: string | null; runs: string | null; program: string | null;
  /** a command script (.bat, .cmd) that can be picked as the start (null), or why not; null too for a script of a kind
   *  that never can (`startable` false) */
  startable: boolean; refused: string | null;
  /** it is what starts the copy now */
  current: boolean;
  /** what it does on a player's PC beyond starting a program, each with the line that does it */
  does: string[];
}

/* ─────────── the view ─────────── */

export interface StartView {
  exe: string; argv: string[]; line: string; cwd: string | null; env: Record<string, string>;
  /** where it starts: the program's folder, the game's folder, or a folder of the copy */
  startsIn: { kind: "program" | "game" | "folder"; folder: string };
  by: StartBy; needsAhoy: string | null; rev: number | null;
}
export interface LaunchView {
  gameId: number; name: string; slug: string; packageId: number; kind: string; from: "way" | "import"; wayId: number | null;
  /** false with why: a console dump, a way's copy whose way is gone */
  editable: boolean; why: string | null;
  /** Reset can be asked: a start is set by hand for the copy's origin, or the copy starts otherwise than found (a way's copy
   *  whose way is gone keeps the start set by hand on it) */
  resettable: boolean;
  /** the game's copy is being rebuilt: nothing can be saved until it is done */
  busy: string | null;
  start: StartView | null; auto: StartView | null;
  /** the start set by hand for this copy's origin, whether this copy starts with it, and why not */
  set: (LaunchChoice & { line: string }) | null; applied: boolean; notApplied: string | null;
  /** the fields the editor starts from: the current start, with {content} for the way's game file */
  fields: { exe: string; argv: string[]; cwd: string | null; env: Record<string, string> } | null;
  /** the copy's start as it is now, in the same form (what Save compares the editor's fields with) */
  now: { exe: string; argv: string[]; cwd: string | null; env: Record<string, string> } | null;
  programs: ProgramItem[]; scripts: ScriptItem[]; files: number; folders: string[];
  placeholders: { install: string; content: string | null };
  /** the program the package's words say opens a settings window when started with no arguments (warning text), by path */
  settingsWindow: Record<string, string>;
}

function startView(l: Manifest["launch"], by: StartBy, requires: string | null): StartView {
  const argv = argvOf(l);
  const cwd = cwdOfLaunch(l);
  return {
    exe: l.exe, argv, line: startLine(l.exe, argv), cwd: l.cwd ?? null, env: { ...(l.env ?? {}) },
    startsIn: folderOf(l.exe, cwd), by, needsAhoy: requires, rev: typeof l.rev === "number" ? l.rev : null,
  };
}
const foundBy = (c: Copy): StartBy => (c.from === "way" ? "plan" : c.m.tier === "agent" ? "ai" : "ludarr");

/** GET /game/:id/launch — the copy's start, where it comes from, the start set by hand, and what the picker lists */
export async function launchView(gameId: number): Promise<LaunchView> {
  const c = copyOf(gameId);
  const why = notEditable(c);
  const head = { gameId, name: c.game.name, slug: c.game.slug ?? "", packageId: c.pkg.id, kind: c.kind, from: c.from, wayId: c.way?.id ?? null };
  const busy = busyWhy(gameId);
  const empty = { programs: [], scripts: [], files: c.files.length, folders: [], placeholders: { install: `${EXAMPLE_ROOT}\\${c.game.slug ?? "game"}`, content: null }, settingsWindow: {} };
  if (c.kind === "rom") return { ...head, editable: false, why, resettable: false, busy, start: null, auto: null, set: null, applied: false, notApplied: null, fields: null, now: null, ...empty };
  const d = await describe(c.pkg, c.files);
  const set = intentOf(c);
  const applied = !!set && c.m.launch.rev === set.at;
  const auto = autoOf(c.pkg, c.m);
  const differs = differsFromFound(c.m, auto);
  // set by hand: the start set by hand for the copy's origin, or a start stamped by a hand that is not the one found (its
  // way gone, the copy keeps the start set by hand on it)
  const by = applied || (typeof c.m.launch.rev === "number" && differs) ? "hand" : foundBy(c);
  const start = startView(c.m.launch, by, c.m.requires?.launcher ?? null);
  const autoView = startView(auto.launch, foundBy(c), auto.requires?.launcher ?? null);
  // why a start set by hand is not this copy's, in the words Save would refuse it with; none known: said once by the page
  const misfit = set ? await choiceInCopy(set, c, d) : null;
  const notApplied = set && !applied ? misfit : null;
  // the fields: the start set by hand as the admin wrote it when the copy starts with it, else the copy's own start with the
  // way's game file said as {content} again (so nothing set earlier is lost on the first save)
  const argv = start.argv.map(a => (c.placed ? a.split(`${INSTALL}/${c.placed}`).join("{content}") : a));
  const cwd = cwdOfLaunch(c.m.launch);
  const now = { exe: start.exe, argv, cwd: cwd === undefined ? null : cwd, env: start.env };
  // a start set by hand that fits this copy (applied, or not yet) is what the editor starts from; one that does not fit
  // leaves the copy's own start to start from
  const fields = set && (applied || !misfit) ? { exe: set.exe, argv: [...set.argv], cwd: set.cwd ?? null, env: { ...(set.env ?? {}) } } : now;

  const notes = notesText(c);
  const current = lower(c.m.launch.exe);
  // the cheap order reads names only; once a program's header is read, it is a helper as the importer judges it (validate.ts
  // helperProgram): the engine's own program is never dimmed (a Unity player named Crash….exe), a helper known by its header is
  const helperOf = (p: string) => NOT_LAUNCH_NAME.test(base(p)) || NOT_LAUNCH_DIR.test(p);
  const layout = copyLayout(c.files.map(f => f.path));
  // the cheap order first (the current program, not a helper, top-level, larger), then the first PROGRAMS_READ are read
  const exes = c.files.filter(f => /\.exe$/i.test(f.path))
    .sort((a, b) => Number(lower(b.path) === current) - Number(lower(a.path) === current) || Number(helperOf(a.path)) - Number(helperOf(b.path)) || depth(a.path) - depth(b.path) || b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, PROGRAMS_READ);
  const settingsWindow: Record<string, string> = {};
  const programs: ProgramItem[] = await Promise.all(exes.map(async f => {
    const onDisk = !!(await lstat(join(c.pkg.path, ...f.path.split("/"))).catch(() => null))?.isFile();
    const pe = await peOf(d, c.pkg, f.path);
    const words: Words[] = [];
    if (pe.version.FileDescription) words.push({ text: cut(pe.version.FileDescription), source: "version info" });
    else if (pe.version.ProductName) words.push({ text: cut(pe.version.ProductName), source: "version info" });
    if (pe.version.Comments) words.push({ text: cut(pe.version.Comments), source: "version info" });
    const args = lower(f.path) === current ? start.argv : [];
    const quotes = [...quotesFor(f.path, d.texts, args, d.named), ...(notes ? quotesFor(f.path, [notes], args).slice(0, 1) : [])];
    words.push(...quotes);
    const opens = settingsWords(f.path, pe, d, notes);
    if (opens) settingsWindow[f.path] = `${opens.source}: "${opens.text}"`;
    const refused = !onDisk ? "not on the disk now: the copy is not whole" : pe.kind === "dll" ? "a library (DLL), not a program" : pe.kind === "other" ? "not a Windows program" : c.isKept(f.path) ? "one of the files players keep: the launcher never updates it" : null;
    return { path: f.path, size: f.size, current: lower(f.path) === current, kind: pe.kind, ui: pe.kind === "program" ? pe.ui : null, helper: helperProgram(f.path, pe, layout), starts: quotes.some(q => STARTS.test(q.text)), refused, words };
  }));
  programs.sort((a, b) => Number(b.current) - Number(a.current) || Number(!!a.refused) - Number(!!b.refused) || Number(a.helper) - Number(b.helper) || Number(b.starts) - Number(a.starts)
    || depth(a.path) - depth(b.path) || b.size - a.size || a.path.localeCompare(b.path));
  // a script's program is offered when it is that very file of the copy, and one that can be picked
  const pickable = new Set(programs.filter(p => !p.refused).map(p => lower(p.path)));
  const scripts: ScriptItem[] = c.files.filter(f => SCRIPT.test(f.path)).sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path)).slice(0, 100).map(f => {
    const s = d.scripts.get(f.path);
    const run = s ? runsOf(s, c) : null;
    const program = run?.file && pickable.has(lower(run.file)) ? run.file : null;
    const startable = START_SCRIPT.test(f.path);
    const refused = !startable ? null : launcherPathProblem(f.path) ? `its path ${launcherPathProblem(f.path)}` : c.isKept(f.path) ? "one of the files players keep: the launcher never updates it" : null;
    return { path: f.path, size: f.size, comment: s?.comment ?? null, runs: run?.line ?? null, program, startable, refused, current: lower(f.path) === current, does: s?.does ?? [] };
  });
  const folders = [...c.folders.values()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, 500);
  return {
    ...head, editable: !why, why, resettable: !!set || differs, busy, start, auto: autoView,
    set: set ? { ...set, line: startLine(set.exe, set.argv) } : null, applied, notApplied, fields, now,
    programs, scripts, files: c.files.length, folders,
    placeholders: { install: `${EXAMPLE_ROOT}\\${c.game.slug ?? "game"}`, content: c.placed }, settingsWindow,
  };
}

/** GET /game/:id/launch/files?q= — files of the copy whose path holds `q` (any part, case ignored), at most 200 */
export function launchFiles(gameId: number, q: string): { items: { path: string; size: number; kind: "program" | "script" | "file" }[]; total: number; matched: number } {
  const c = copyOf(gameId);
  const t = lower(q.trim().replace(/\\/g, "/"));
  const hits = c.files.filter(f => !t || lower(f.path).includes(t));
  return {
    items: hits.slice(0, 200).map(f => ({ path: f.path, size: f.size, kind: /\.exe$/i.test(f.path) ? "program" as const : SCRIPT.test(f.path) ? "script" as const : "file" as const })),
    total: c.files.length, matched: hits.length,
  };
}

/** GET /package/:id/launch — a package's start as it is now (what the launcher asks at Play): cheap, the row only */
export function packageLaunch(id: number): { launch: Manifest["launch"]; rev: number | null; requires: { launcher: string } | null; kind: string } | null {
  const p = stmts.packageById.get(id) as PackageRow | undefined;
  const m = p ? parse<Manifest | null>(p.manifest_json, null) : null;
  if (!m?.launch) return null;
  return { launch: m.launch, rev: typeof m.launch.rev === "number" ? m.launch.rev : null, requires: m.requires?.launcher ? { launcher: m.requires.launcher } : null, kind: m.kind ?? "native" };
}

/* ─────────── checking a start against the copy ─────────── */

/** why a start set by hand does not apply to this copy (null: it does): the checks a new copy's job makes (choiceOnDisk) and
 *  Save's own, on the copy's file list and the disk — its program in the list, not one players keep, on the disk and a
 *  Windows program; its folder; the way's game file for {content}; the files of the copy it named when it was set */
async function choiceInCopy(s: LaunchChoice, c: Copy, d: Described): Promise<string | null> {
  const f = c.byLower.get(lower(s.exe));
  if (!f) return `its program ${s.exe} is not in this copy`;
  if (c.isKept(f.path)) return `its program ${f.path} is one of the files players keep in this copy`;
  if (!(await lstat(join(c.pkg.path, ...f.path.split("/"))).catch(() => null))?.isFile()) return `its program ${f.path} is not on the disk now: the copy is not whole`;
  if (START_SCRIPT.test(f.path)) { if (s.argv.some(a => !SCRIPT_ARG.test(a))) return `its script ${f.path} takes plain arguments only`; }
  else {
    const pe = await peOf(d, c.pkg, f.path);
    if (pe.kind !== "program") return `its program ${f.path} is ${pe.kind === "dll" ? "a library (DLL), not a program" : "not a Windows program"}`;
  }
  if (s.cwd && s.cwd !== INSTALL) { const rel = s.cwd.startsWith(`${INSTALL}/`) ? s.cwd.slice(INSTALL.length + 1) : s.cwd; if (!c.folders.has(lower(rel))) return `the folder it starts in, ${rel}, is not in this copy`; }
  if (s.argv.some(a => a.includes("{content}")) && !c.placed) return "it passes the game file ({content}), and this copy has none";
  const gone = await namedButGone(s, rel => c.byLower.has(lower(rel)) || c.folders.has(lower(rel)));
  return gone ? `${gone}, which is not in this copy` : null;
}
/** the files and folders of the copy a start names as {install}/<path>, spelled as the copy spells them: what a new copy must
 *  have for it to start so (a path the copy does not have, a log the program writes, holds nothing back) */
function pathsIn(s: Pick<LaunchChoice, "argv" | "env">, c: Copy): string[] {
  const out = new Set<string>();
  for (const v of [...s.argv, ...Object.values(s.env ?? {})]) for (const rel of installRefs(v)) { const p = c.byLower.get(lower(rel))?.path ?? c.folders.get(lower(rel)); if (p) out.add(p); }
  return [...out].slice(0, 100);
}
/** what the package says of a program opening its settings window: its version info, then any sentence naming it (not only
 *  the three quoted), then the notes — the first that says the program itself opens one */
function settingsWords(rel: string, pe: PeInfo, d: Described, notes: Described["texts"][number] | null): Words | null {
  const words: Words[] = [
    ...[pe.version.FileDescription, pe.version.ProductName, pe.version.Comments].filter((t): t is string => !!t).map(t => ({ text: cut(t), source: "version info" })),
    ...sentencesNaming(base(rel), d.texts, d.named), ...(notes ? sentencesNaming(base(rel), [notes]) : []),
  ];
  return words.find(w => opensSettings(rel, w)) ?? null;
}

/** the arguments a start passes, each argument checked: the placeholders it may hold, a path in the game's folder that climbs
 *  out (refused) or names nothing of the copy (a warning) */
function checkArgs(input: unknown, c: Copy, errors: string[], warnings: string[], script = false): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some(a => typeof a !== "string")) { errors.push("the arguments: a list of text"); return []; }
  if (input.length > 50) errors.push("at most 50 arguments");
  const shipped = c.from === "way" && !!c.placed;
  const out: string[] = [];
  (input as string[]).forEach((raw, i) => {
    const a = raw.trim();
    if (!a) return;
    const n = `argument ${i + 1}`;
    if (a.length > 1000) { errors.push(`${n} is longer than 1000 characters`); return; }
    if (a.includes("\0")) { errors.push(`${n} holds a NUL character`); return; }
    // a script's arguments are read by the command shell: plain words only, nothing it would expand or run
    if (script) { if (SCRIPT_ARG.test(a)) out.push(a); else errors.push(`${n}: ${SCRIPT_ARG_WORDS}`); return; }
    for (const p of placeholdersIn(a)) {
      if (p === "install") continue;
      if (p === "content") {
        if (c.from !== "way") errors.push(`${n}: {content} is a way's game file, and this copy was not built by a way`);
        else if (!shipped) errors.push(`${n}: {content} is the way's game file, and this copy holds none`);
        continue;
      }
      errors.push(`${n}: {${p}} is not a placeholder here (${shipped ? "{install}, {content}" : "{install}"})`);
    }
    // an option with more after a space is two arguments typed into one (an option's value after = or : is one)
    if (/^[-/]/.test(a) && /\s/.test(a) && !/^\S*[=:]/.test(a)) warnings.push(`${n} looks like more than one argument: put each in its own row`);
    for (const rel of installRefs(a)) {
      if (rel.split("/").some(s => s === "..")) { errors.push(`${n}: ${rel} climbs out of the game's folder`); continue; }
      if (!c.byLower.has(lower(rel)) && !c.folders.has(lower(rel))) warnings.push(`${n}: ${rel} is not a file or folder of the game's copy`);
    }
    out.push(a);
  });
  return out;
}
/** the folder a start starts in: absent (the program's), the game's ({install}), or a folder of the copy (spelled as the copy
 *  spells it); one that is the program's own is said as absent */
function checkCwd(input: unknown, exe: string | null, c: Copy, errors: string[], warnings: string[]): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "string") { errors.push("the folder it starts in: a folder of the game's copy"); return undefined; }
  const v = input.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (v === INSTALL) {
    if (exe && !dirOf(exe)) return undefined;
    warnings.push("it starts in the game's folder, not the program's own: files of the copy may name paths relative to the program's folder");
    return INSTALL;
  }
  const rel = v.startsWith(`${INSTALL}/`) ? v.slice(INSTALL.length + 1) : v;
  if (hasPlaceholder(rel)) { errors.push("the folder it starts in may hold {install} only at its start"); return undefined; }
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith("/")) { errors.push("the folder it starts in must be inside the game's folder (no drive, no leading /)"); return undefined; }
  if (rel.split("/").some(s => s === "..")) { errors.push(`the folder it starts in, ${rel}, climbs out of the game's folder`); return undefined; }
  const why = launcherPathProblem(rel);
  if (why) { errors.push(`the folder it starts in, ${rel}, ${why}`); return undefined; }
  const spelled = c.folders.get(lower(rel));
  if (!spelled) { errors.push(`${rel} is not a folder of the game's copy`); return undefined; }
  if (exe && lower(spelled) === lower(dirOf(exe))) return undefined;
  warnings.push(`it starts in ${spelled}, not the program's own folder: files of the copy may name paths relative to the program's folder`);
  return spelled;
}
function checkEnv(input: unknown, errors: string[]): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) { errors.push("the variables: {NAME: value}"); return undefined; }
  const ent = Object.entries(input as Record<string, unknown>);
  if (ent.length > 30) errors.push("at most 30 variables");
  const out: Record<string, string> = {};
  for (const [k, v] of ent) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) { errors.push(`${k || "(empty)"} is not a variable name (letters, digits and _, not starting with a digit)`); continue; }
    if (typeof v !== "string" || v.length > 1000 || v.includes("\0")) { errors.push(`the variable ${k}: text up to 1000 characters`); continue; }
    for (const p of placeholdersIn(v)) if (p !== "install") errors.push(`the variable ${k}: {${p}} is not a placeholder here ({install})`);
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** a start the admin sends, checked against the copy as it is now: the program a file of its list, on the disk and a Windows
 *  program (no script, no library, nothing players keep); the arguments, folder and variables as the launcher takes them */
async function checkChoice(body: unknown, c: Copy): Promise<{ choice: Omit<LaunchChoice, "at"> | null; errors: string[]; warnings: string[] }> {
  const errors: string[] = [], warnings: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { choice: null, errors: ["send {exe, argv, cwd?, env?}"], warnings };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter(k => !["exe", "argv", "cwd", "env"].includes(k));
  if (unknown.length) errors.push(`not a part of a start: ${unknown.join(", ")} (they are exe, argv, cwd, env)`);
  let exe: string | null = null;
  if (typeof b.exe !== "string" || !b.exe.trim()) errors.push("pick the program it starts");
  else {
    const asked = b.exe.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    const f = c.byLower.get(lower(asked));
    if (SCRIPT_EXT.test(asked) && !START_SCRIPT.test(asked)) {
      const s = f ? (await describe(c.pkg, c.files)).scripts.get(f.path) : null;
      const run = s ? runsOf(s, c) : null;
      errors.push(`${base(asked)}: ${SCRIPT_WORDS}${run ? ` This one runs: ${run.line}.` : ""}`);
    } else if (!f) errors.push(`${asked} is not a file of the game's copy`);
    else if (START_SCRIPT.test(f.path)) {
      // a command script, picked by hand: a file of the copy on the disk, not one players keep; what it does is said below
      const why = launcherPathProblem(f.path);
      if (why) errors.push(`${f.path} ${why}`);
      else if (c.isKept(f.path)) errors.push(`${f.path} is one of the files players keep (the copy's keep or seed list): the launcher never updates or checks it, so it cannot be what starts the game`);
      else if (!(await lstat(join(c.pkg.path, ...f.path.split("/"))).catch(() => null))?.isFile()) errors.push(`${f.path} is not on the disk now: the copy is not whole`);
      else exe = f.path;
    }
    else {
      const why = launcherPathProblem(f.path);
      if (why) errors.push(`${f.path} ${why}`);
      else if (!/\.exe$/i.test(f.path)) errors.push(`${f.path} is not a program: Ahoy starts Windows programs (.exe)`);
      else if (c.isKept(f.path)) errors.push(`${f.path} is one of the files players keep (the copy's keep or seed list): the launcher never updates or checks it, so it cannot be what starts the game`);
      else {
        const st = await lstat(join(c.pkg.path, ...f.path.split("/"))).catch(() => null);
        if (!st?.isFile()) errors.push(`${f.path} is not on the disk now: the copy is not whole`);
        else {
          const pe = await peOf(await describe(c.pkg, c.files), c.pkg, f.path);
          if (pe.kind === "dll") errors.push(`${f.path} is a library (DLL), not a program`);
          else if (pe.kind === "other") errors.push(`${f.path} is not a Windows program`);
          else exe = f.path;
        }
      }
    }
  }
  const script = !!exe && START_SCRIPT.test(exe);
  const argv = checkArgs(b.argv, c, errors, warnings, script || (typeof b.exe === "string" && START_SCRIPT.test(b.exe.trim())));
  const cwd = checkCwd(b.cwd, exe, c, errors, warnings);
  const env = checkEnv(b.env, errors);
  if (script && env && Object.keys(env).some(k => k.toUpperCase() === SCRIPT_VAR)) errors.push(`the variable ${SCRIPT_VAR} is the launcher's own for a script (it holds the script's path)`);
  if (exe && script) {
    const info = (await describe(c.pkg, c.files)).scripts.get(exe);
    const run = info ? runsOf(info, c) : null;
    warnings.push(`${base(exe)} ${SCRIPT_RUNS_WORDS}`);
    for (const does of info?.does ?? []) warnings.push(`it ${does}`);
    // one that starts a program of the copy: that program, picked with those arguments, needs no script
    if (run) warnings.push(`it runs ${run.line}: picking that program with those arguments starts the game without a script`);
  } else if (exe) {
    // a helper as the importer judges it (validate.ts helperProgram): by its name, its folder, its header, the copy's layout
    if (helperProgram(exe, await peOf(await describe(c.pkg, c.files), c.pkg, exe), copyLayout(c.files.map(f => f.path)))) warnings.push(`${base(exe)} looks like an installer or a helper, not the game`);
    if (!argv.length) {
      const d = await describe(c.pkg, c.files);
      const w = settingsWords(exe, await peOf(d, c.pkg, exe), d, notesText(c));
      if (w) warnings.push(`with no arguments it may open its settings window rather than the game — ${w.source}: "${cut(w.text)}"`);
    }
  }
  if (errors.length || !exe) return { choice: null, errors, warnings };
  return { choice: { exe, argv, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) }, errors, warnings };
}

/** a start set by hand as this copy carries it: {content} becomes the way's placed game file */
function resolveFor(s: Omit<LaunchChoice, "at">, placed: string | null): Start {
  return { exe: s.exe, argv: s.argv.map(a => (placed ? a.replace(/\{content\}/g, () => `${INSTALL}/${placed}`) : a)), ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.env ? { env: { ...s.env } } : {}) };
}

/* ─────────── changing the copy in place ─────────── */

/** why a file could not be written, in words */
const IO_WORDS: Record<string, string> = {
  ENOSPC: "the disk is full", EDQUOT: "the disk quota is used up", EACCES: "it may not be written there", EPERM: "it may not be written there",
  EROFS: "the disk is read-only", EBUSY: "the file is in use", EMFILE: "too many files are open", ENOENT: "the copy's folder is gone",
};
/** the copy's ahoy.json put in place whole: written beside it under a name of its own, then renamed over it — never written
 *  through a link (it may be a hard link into the content store), and the old one stays as it was when the new one cannot be
 *  written (nothing is left behind) */
async function placeManifest(dir: string, data: string | Uint8Array): Promise<void> {
  const tmp = join(dir, `.ahoy.json.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await ldeps.writeFile(tmp, data, { flag: "wx" });
    await ldeps.rename(tmp, join(dir, "ahoy.json"));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    const code = (e as NodeJS.ErrnoException)?.code ?? "";
    throw new LaunchError(`the copy's ahoy.json could not be written (${IO_WORDS[code] ?? (code || String((e as Error)?.message ?? e))}): how the game starts is unchanged`, 500);
  }
}

/** the copy's manifest with this launch and requires: ahoy.json put in place (placeManifest), then the row, together with
 *  the intent (`also`) — the old ahoy.json is put back when the row cannot be written */
async function rewrite(c: Copy, launch: Manifest["launch"], requires: string | null, auto: LaunchAuto, also: () => void): Promise<PackageRow> {
  const next: Manifest = { ...c.m, launch };
  if (requires) next.requires = { launcher: requires }; else delete next.requires;
  const folder = await lstat(c.pkg.path).catch(() => null);
  if (!folder?.isDirectory()) throw new LaunchError("the copy's folder is gone from the disk: a rescan or a new copy settles it", 409);
  const at = join(c.pkg.path, "ahoy.json");
  const before = await readFile(at).catch(() => null);
  await placeManifest(c.pkg.path, JSON.stringify(next, null, 2));
  try {
    let row: PackageRow | null = null;
    db.transaction(() => {
      row = stmts.setPackageManifest.get(JSON.stringify(next), JSON.stringify(auto), c.pkg.id) as PackageRow | null;
      if (!row) throw new LaunchError("the game's copy was replaced meanwhile: look again", 409);
      also();
    })();
    events.emit("package", serializePackage(row!));
    return row!;
  } catch (e) {
    if (before) await placeManifest(c.pkg.path, before).catch(() => {});
    else await rm(at, { force: true }).catch(() => {});
    throw e;
  }
}
/** the copy can be changed now (Reset: also a way's copy whose way or plan is gone, which keeps the start set by hand on it) */
function guard(c: Copy, o: { reset?: boolean } = {}) {
  const why = notEditable(c);
  if (why && !(o.reset && c.kind !== "rom")) throw new LaunchError(why, 409);
  const busy = busyWhy(c.game.id);
  if (busy) throw new LaunchError(`${busy}: change how it starts once that is done`, 409);
}

/** POST /game/:id/launch/check — what Save would say of a start, in the same words, changing nothing (the editor asks it as
 *  the admin types); `line` is the start as it would run, `needsAhoy` the launcher it would need */
export async function checkLaunch(gameId: number, body: unknown): Promise<{ errors: string[]; warnings: string[]; line: string | null; needsAhoy: string | null }> {
  const c = copyOf(gameId);
  const why = notEditable(c);
  if (why) return { errors: [why], warnings: [], line: null, needsAhoy: null };
  const { choice, errors, warnings } = await checkChoice(body, c);
  if (!choice) return { errors, warnings, line: null, needsAhoy: null };
  const start = resolveFor(choice, c.placed);
  return { errors, warnings, line: startLine(start.exe, start.argv), needsAhoy: newerLauncher(autoOf(c.pkg, c.m).requires?.launcher, startNeeds(start)) };
}

/** PUT /game/:id/launch — the start set by hand: checked against the copy, kept where the next copy of its origin reads it,
 *  and applied to the current copy at once */
export async function setLaunch(gameId: number, body: unknown): Promise<{ item: LaunchView; warnings: string[] }> {
  const c = copyOf(gameId);
  guard(c);
  const { choice, errors, warnings } = await checkChoice(body, c);
  if (!choice || errors.length) throw new LaunchError("how the game starts has problems", 400, errors);
  const at = Math.max(Date.now(), (c.m.launch.rev ?? 0) + 1);
  // the files of this copy it names go with it: a new copy that lacks one does not take it
  const paths = pathsIn(choice, c);
  const full: LaunchChoice = { ...choice, ...(paths.length ? { paths } : {}), at };
  // the intent, checked as it is stored (the way's through its overrides' own rule, the admin's alone)
  let store: () => void;
  if (c.from === "way") {
    const v = validateWayOverrides({ launch: full }, c.spec!, { admin: true });
    if (!v.ok || !v.value?.launch) throw new LaunchError("how the game starts has problems", 400, v.errors);
    const launch = v.value.launch, wayId = c.way!.id;
    store = () => { const now = getWay(wayId); updateWay(wayId, { overrides: { ...(now ? wayOverrides(now) : {}), launch } }); };
  } else {
    const errs: string[] = [];
    const v = checkLaunchChoice(full, "launch", { content: false }, errs);
    if (!v) throw new LaunchError("how the game starts has problems", 400, errs);
    store = () => stmts.setGameLaunch.run(JSON.stringify(v), gameId);
  }
  const start = resolveFor(choice, c.placed);
  const auto = autoOf(c.pkg, c.m);
  const before = launchLine(c.m.launch);
  await rewrite(c, { ...manifestLaunch(start), rev: at }, newerLauncher(auto.requires?.launcher, startNeeds(start)), auto, store);
  const now = startLine(start.exe, start.argv);
  record(gameId, "edited", { gameName: c.game.name, source: "the admin", message: `start set by hand: ${now}${before && before !== now ? ` (was ${before})` : ""}`, data: { packageId: c.pkg.id, rev: at } });
  return { item: await launchView(gameId), warnings };
}

/** DELETE /game/:id/launch — the start set by hand goes, and the copy starts as found again (404 when nothing was set) */
export async function resetLaunch(gameId: number): Promise<{ item: LaunchView }> {
  const c = copyOf(gameId);
  guard(c, { reset: true });
  const set = intentOf(c);
  const auto = autoOf(c.pkg, c.m);
  const differs = differsFromFound(c.m, auto);
  if (!set && !differs) throw new LaunchError("the start was not set by hand", 404);
  const clear = () => {
    if (c.from === "import") { stmts.setGameLaunch.run(null, gameId); return; }
    const now = c.way ? getWay(c.way.id) : null;
    if (now) { const { launch: _gone, ...rest } = wayOverrides(now); updateWay(now.id, { overrides: rest }); }
  };
  if (differs) await rewrite(c, { ...auto.launch, rev: Math.max(Date.now(), (c.m.launch.rev ?? 0) + 1) }, auto.requires?.launcher ?? null, auto, clear);
  else clear();
  record(gameId, "edited", { gameName: c.game.name, source: "the admin", message: `start reset to ${launchLine(auto.launch)}, ${asFound(foundBy(c))}`, data: { packageId: c.pkg.id } });
  return { item: await launchView(gameId) };
}

/* ─────────── a new copy: the start set by hand, when it is in it ─────────── */

/** a path in `root` whatever its case (as Windows finds it), as the folder spells it; null when it is not there (or not a
 *  file / a folder as asked) */
async function presentIn(root: string, rel: string, want: "file" | "dir" | "any"): Promise<string | null> {
  let dir = root;
  const out: string[] = [];
  for (const part of rel.split("/")) {
    if (!part || part === "." || part === "..") return null;
    const names = await readdir(dir).catch(() => [] as string[]);
    const hit = names.find(n => n === part) ?? names.find(n => lower(n) === lower(part));
    if (!hit) return null;
    out.push(hit);
    dir = join(dir, hit);
  }
  const st = await lstat(dir).catch(() => null);
  return st && (want === "file" ? st.isFile() : want === "dir" ? st.isDirectory() : st.isFile() || st.isDirectory()) ? out.join("/") : null;
}

/**
 * The start set by hand as a new copy (the folder `root` that becomes its package) carries it: its program there (case
 * ignored, spelled as the copy spells it), a Windows program and not one of the files players keep, its folder there, the
 * way's game file in its place for {content}, and the files of the copy it named when it was set ({install}/<path>: a game
 * file moved or renamed in the new copy would make it start wrong). Otherwise why it does not apply, in words for the job's
 * log and the history.
 */
export async function choiceOnDisk(s: LaunchChoice, o: { root: string; placed: string | null; keep?: string[]; seed?: string[] }): Promise<{ start: Start } | { why: string }> {
  const exe = await presentIn(o.root, s.exe, "file");
  if (!exe) return { why: `its program ${s.exe} is not in it` };
  if (globMatcher([...(o.keep ?? []), ...(o.seed ?? [])])(exe)) return { why: `its program ${exe} is one of the files players keep` };
  if (START_SCRIPT.test(exe)) { if (s.argv.some(a => !SCRIPT_ARG.test(a))) return { why: `its script ${exe} takes plain arguments only` }; }
  else {
    const pe = await peInfo(join(o.root, ...exe.split("/")));
    if (pe.kind !== "program") return { why: `its program ${exe} is ${pe.kind === "dll" ? "a library (DLL), not a program" : "not a Windows program"}` };
  }
  let cwd: string | undefined = s.cwd;
  if (cwd && cwd !== INSTALL) {
    const rel = cwd.startsWith(`${INSTALL}/`) ? cwd.slice(INSTALL.length + 1) : cwd;
    const dir = await presentIn(o.root, rel, "dir");
    if (!dir) return { why: `the folder it starts in, ${rel}, is not in it` };
    cwd = lower(dir) === lower(dirOf(exe)) ? undefined : dir;
  } else if (cwd === INSTALL && !dirOf(exe)) cwd = undefined;
  if (s.argv.some(a => a.includes("{content}")) && !o.placed) return { why: "it passes the game file ({content}), and the copy has none" };
  const gone = await namedButGone(s, async rel => !!(await presentIn(o.root, rel, "any")));
  if (gone) return { why: `${gone}, which is not in it` };
  return { start: resolveFor({ ...s, exe, ...(cwd ? { cwd } : { cwd: undefined }) }, o.placed) };
}

/** what buildManifest takes for a start (src/process/validate.ts): its arguments, folder, variables and the launcher it needs
 *  (`base`: what the copy needs anyway) */
export function manifestMeta(s: Start, baseNeeds: string | null): { launchArgs: string; argv: string[]; env?: Record<string, string>; cwd?: string; requires: { launcher: string } | null } {
  const l = manifestLaunch(s);
  const need = newerLauncher(baseNeeds, startNeeds(s));
  return { launchArgs: l.args, argv: s.argv, ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), requires: need ? { launcher: need } : null };
}

/**
 * An import or upgrade of the game (src/process/runner.ts): the start set by hand for its PC copies, as the new copy in
 * `root` carries it — or why it does not apply. null when none is set.
 */
export async function importStart(gameId: number | null, root: string): Promise<{ choice: LaunchChoice; start: Start } | { choice: LaunchChoice; why: string } | null> {
  if (gameId == null) return null;
  const g = stmts.gameById.get(gameId) as GameRow | undefined;
  const choice = g ? gameChoice(g) : null;
  if (!choice) return null;
  const r = await choiceOnDisk(choice, { root, placed: null });
  return "start" in r ? { choice, start: r.start } : { choice, why: r.why };
}

/** the words for a start set by hand that a new copy does not take (the job's log and the game's history) */
export function notAppliedWords(choice: LaunchChoice, why: string, used: { exe: string; argv: string[] }, as: string): string {
  return `the start set by hand (${startLine(choice.exe, choice.argv)}) is not applied to the new copy: ${why}; it starts with ${startLine(used.exe, used.argv)}, ${as}`;
}
