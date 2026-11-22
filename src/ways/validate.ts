/**
 * ludarr — the checks every runtime plan, way override and manual game description passes before it is stored or run,
 * whoever wrote it (the admin, the AI). A plan becomes a program on every player's PC, so paths stay inside the install
 * folder, only .exe files start, placeholders are the known ones, hashes have the right length for their algorithm, and
 * text the server generated never ships its own paths. Returns a normalised copy (hashes lowercased, defaults filled).
 *
 * The content plan also says how a way's game data is proven and made: a game folder (kind 'folder' and its marker), the
 * versions, category and build ids it accepts with where the program's code names them, a make (recorded steps from another
 * form of the data, each field with its own placeholders), a per-game build from a release kit, and checks run on the
 * server. Three judgements are not part of checking one plan, because they compare two plans or read more than the shape:
 * acceptChanges / evidenceProblems (what a new content plan accepts that the old one did not, and whether the program's
 * code is cited for it), provingProblem (a recomp or port keeps something that proves its file) and firstRunOnPlayersPc
 * (the plan builds the game on the player's PC). Their callers run them when a plan is saved, never when one is loaded.
 */
import { CONSOLE_PLATFORMS, platformId, type PlatformId } from "../platforms";
import { CONVERTER_IDS } from "./converters";
import { REGION_NAMES, regionKey } from "./names";
import {
  HASH_ALGOS, HASH_HEX_LEN, PLAN_KINDS,
  type AcceptHash, type CheckNeed, type Completeness, type ContentMake, type ContentPlan, type ConverterId, type Evidence, type FileSource,
  type GameDraft, type KitBuild, type LaunchChoice, type MakeInput, type MakeStep, type NeedSlot, type PinnedTool, type PlanCheck, type PlanDecision,
  type PlanFile, type PlanKind, type ProgramSource, type RuntimePlanSpec, type SetupStep, type ToolBuild, type WayOverrides,
} from "./types";

export interface Checked<T> { ok: boolean; errors: string[]; warnings: string[]; value: T | null }

/** platforms a game file can come from: every console, the arcade (a ROM set), and PC data for ports of PC games
 *  (DIABDAT.MPQ) */
export const CONTENT_PLATFORMS: PlatformId[] = [...CONSOLE_PLATFORMS, "arcade", "pc"];
/** v1 keeps one file per game: formats made of several files are refused */
const MULTI_FILE_FORMATS = new Set(["cue", "gdi", "ccd", "m3u", "toc", "mds", "img", "sub"]);
const PLACEHOLDER = /\{([A-Za-z]+)\}/g;
export const placeholdersIn = (s: string): string[] => [...s.matchAll(PLACEHOLDER)].map(m => m[1]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * The Ahoy launcher's own rule for a manifest path or a keep / seed glob (launcher/src/engine.ts pathProblem, copied as
 * it is): why it would not stay inside the install folder on Windows, or null. Relative, no drive or stream (no ':'), no
 * '..' nor a name Windows reads as one (only dots and spaces), no empty folder name, no character Windows refuses in a
 * name (a glob may hold * and ?). Every launcher refuses a package that breaks it, so ludarr refuses it first.
 */
export function launcherPathProblem(p: unknown, opts: { glob?: boolean } = {}): string | null {
  if (typeof p !== "string" || !p) return "is empty";
  if (p.length > 1024) return "is too long";
  if ((opts.glob ? /[<>:"|\u0000-\u001f]/ : /[<>:"|?*\u0000-\u001f]/).test(p)) return "holds a character Windows does not allow in a path";
  if (/^[\\/]/.test(p)) return "is not inside the install folder";
  for (const seg of p.split(/[\\/]/)) {
    if (!seg) return "has an empty folder name";
    if (/^[. ]+$/.test(seg)) return "climbs out of the install folder";
  }
  return null;
}

/**
 * A path inside the install folder (or a checkout, or the package): relative, forward slashes, no '..', no drive letter,
 * no NUL, and nothing the launcher refuses (a ':', a control character, a name of only dots and spaces). `glob` also
 * allows * and ** segments (and ?, [ ], { }).
 */
export function safeRelPath(p: unknown, opts: { glob?: boolean; allowDot?: boolean } = {}): string | null {
  if (!str(p)) return "must be a text path";
  if (!p.length) return "is empty";
  if (p.length > 260) return "is longer than 260 characters";
  if (p.includes("\0")) return "holds a NUL character";
  if (p.includes("\\")) return "must use forward slashes";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "must be relative (no leading / or drive letter)";
  if (p === "." && opts.allowDot) return null;
  const segs = p.split("/");
  if (segs.some(s => s === "" )) return "has an empty segment (// or a trailing /)";
  if (segs.some(s => s === ".." || s === ".")) return "may not hold . or .. segments";
  if (!opts.glob && /[*?]/.test(p)) return "may not hold wildcards";
  if (/[<>"|]/.test(p)) return "holds a character Windows does not allow in a path";
  return launcherPathProblem(p, { glob: opts.glob });
}

/** GitHub 'owner/name' (from a github.com link, git@ address or the bare form), 'forgejo:host/owner/name' (codeberg.org
 *  links become that), or a feed id ('dolphin:beta'); anything else is refused */
export function normalizeRepo(input: unknown): { repo: string; host: "github" | "forgejo" | "feed" } | { error: string } {
  if (!str(input)) return { error: "a repo is required" };
  let s = input.trim().replace(/\s+/g, "");
  if (!s) return { error: "a repo is required" };
  if (/^dolphin:(beta|dev)$/i.test(s)) return { repo: s.toLowerCase(), host: "feed" };
  s = s.replace(/[#?].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, NAME = /^[A-Za-z0-9._-]{1,100}$/;
  const ok = (o: string, n: string) => OWNER.test(o) && NAME.test(n) && n !== "." && n !== "..";
  let m = s.match(/^forgejo:([a-z0-9.-]+(?::\d{1,5})?)\/([^/]+)\/([^/]+)$/i);
  if (m) {
    const host = m[1].toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(host)) return { error: `"${m[1]}" is not a host name` };
    if (!NAME.test(m[2]) || !ok("x", m[3])) return { error: "forgejo repos are written forgejo:host/owner/name" };
    return { repo: `forgejo:${host}/${m[2]}/${m[3]}`, host: "forgejo" };
  }
  m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/i) ?? s.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (m) return ok(m[1], m[2]) ? { repo: `${m[1]}/${m[2]}`, host: "github" } : { error: "that GitHub address does not name owner/name" };
  m = s.match(/^(?:https?:\/\/)?codeberg\.org\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (m) return NAME.test(m[1]) && ok("x", m[2]) ? { repo: `forgejo:codeberg.org/${m[1]}/${m[2]}`, host: "forgejo" } : { error: "that Codeberg address does not name owner/name" };
  m = s.match(/^([^/:]+)\/([^/]+)$/);
  if (m && ok(m[1], m[2])) return { repo: `${m[1]}/${m[2]}`, host: "github" };
  return { error: "not a repo: give a GitHub link or owner/name, or forgejo:host/owner/name for another forge" };
}

const utf8 = new TextEncoder();
const utf8Bytes = (s: string) => utf8.encode(s).length;
/** the longest start of `s` within `units` UTF-16 units and `bytes` UTF-8 bytes, never splitting a character */
function cutName(s: string, units: number, bytes: number): string {
  let out = "", used = 0;
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (out.length + ch.length > units || used + n > bytes) break;
    out += ch; used += n;
  }
  return out;
}

/** a game file's name as stored on the server: its own base name, without folders, control characters, leading dots or
 *  characters Windows refuses (each one becomes '_'), at most 180 characters and 200 bytes (a file system's name limit is
 *  255 bytes), its extension kept */
export function storeName(name: unknown): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\x00-\x1f\x7f]/g, "").replace(/[<>:"|?*]/g, "_").replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim();
  if (!clean) return "file";
  if (clean.length <= 180 && utf8Bytes(clean) <= 200) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
  return cutName(clean.slice(0, clean.length - ext.length), 180 - ext.length, 200 - utf8Bytes(ext)).trimEnd() + ext;
}

/** the name a game file gets inside a package ({name}): letters, digits, dot, dash and underscore only, so a launch
 *  argument can never carry shell syntax; `ext` replaces the extension (a .v64 dump stored as z64 is placed as .z64) */
export function placedName(name: unknown, ext?: string | null): string {
  let s = storeName(name).replace(/\s+/g, "_").replace(/[^A-Za-z0-9._-]/g, "");
  if (ext) s = s.replace(/\.[A-Za-z0-9]{1,8}$/, "") + "." + ext.replace(/^\./, "").toLowerCase();
  s = s.replace(/^[.-]+/, "");
  return s && s !== "." + (ext ?? "") ? s : "game" + (ext ? "." + ext.replace(/^\./, "").toLowerCase() : "");
}

function checkHashes(list: unknown, where: string, errors: string[]): AcceptHash[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { errors.push(`${where}: must be a list`); return []; }
  if (list.length > 40) errors.push(`${where}: at most 40 hashes`);
  const out: AcceptHash[] = [];
  list.forEach((h, i) => {
    if (!isObj(h)) { errors.push(`${where}[${i}]: must be {algo, value}`); return; }
    const algo = h.algo as AcceptHash["algo"];
    if (!HASH_ALGOS.includes(algo)) { errors.push(`${where}[${i}].algo: one of ${HASH_ALGOS.join(", ")}`); return; }
    const value = str(h.value) ? h.value.trim().toLowerCase().replace(/^0x/, "") : "";
    if (!new RegExp(`^[0-9a-f]{${HASH_HEX_LEN[algo]}}$`).test(value)) { errors.push(`${where}[${i}].value: ${algo} is ${HASH_HEX_LEN[algo]} hex digits`); return; }
    if (h.label !== undefined && (!str(h.label) || h.label.length > 80)) errors.push(`${where}[${i}].label: text up to 80 characters`);
    out.push(h.label ? { algo, value, label: String(h.label) } : { algo, value });
  });
  return out;
}

function checkFormats(list: unknown, where: string, errors: string[]): string[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.some(f => !str(f))) { errors.push(`${where}: a list of file extensions`); return undefined; }
  const out = list.map(f => String(f).trim().toLowerCase().replace(/^\./, ""));
  for (const f of out) {
    if (!/^[a-z0-9]{1,8}$/.test(f)) errors.push(`${where}: "${f}" is not a file extension`);
    else if (MULTI_FILE_FORMATS.has(f)) errors.push(`${where}: "${f}" is made of several files — v1 keeps one file per game: use a single-file image (chd, iso, rvz, z64 …)`);
  }
  return [...new Set(out)];
}

function checkStrings(list: unknown, where: string, errors: string[], o: { max: number; len: number; re?: RegExp }): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.some(x => !str(x))) { errors.push(`${where}: a list of text`); return []; }
  const out = list.map(x => String(x).trim()).filter(Boolean);
  if (out.length > o.max) errors.push(`${where}: at most ${o.max}`);
  for (const x of out) {
    if (x.length > o.len) errors.push(`${where}: "${x.slice(0, 40)}…" is longer than ${o.len} characters`);
    else if (o.re && !o.re.test(x)) errors.push(`${where}: "${x}" is not allowed`);
  }
  return out;
}

function checkPlaceholders(s: string, allowed: string[], where: string, errors: string[]) {
  for (const p of placeholdersIn(s)) if (!allowed.includes(p)) errors.push(`${where}: {${p}} is not a placeholder here (${allowed.length ? allowed.map(a => `{${a}}`).join(", ") : "none allowed"})`);
}

/** text the server writes into a package must not carry the server's own paths (a wine drive, the scratch folder) */
function serverPathIn(text: string): string | null {
  if (/\bZ:[\\/]/i.test(text)) return "a wine Z: drive path";
  if (/(^|[\s"'=:(])\/(config|work|library|downloads|remote)\//.test(text) || /\.work\//.test(text)) return "a path on the server";
  return null;
}

const APT = /^[a-z0-9][a-z0-9+.-]{1,60}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** what the build allowlist takes, in words (for refusals) */
export const APT_ALLOWED = "Debian -dev packages, build-essential, pkg-config, cmake, ninja-build, meson, python3-*, libsdl2-*, libglew-* and zlib1g-dev";
const APT_EXACT = new Set(["build-essential", "pkg-config", "cmake", "ninja-build", "meson", "zlib1g-dev"]);
/** a Debian package a build may install: a -dev package, or one of the build tools the allowlist names */
export function aptAllowed(name: string): boolean {
  if (!/^[a-z0-9][a-z0-9+.-]{1,60}$/.test(name)) return false;
  return APT_EXACT.has(name) || name.endsWith("-dev") || /^python3-[a-z0-9]/.test(name) || /^libsdl2-[a-z0-9]/.test(name) || /^libglew/.test(name);
}

/* ─────────── the parts of the content model ─────────── */

/** a version as the game's data writes it: digits and dots (01.007.000) */
const VERSION = /^\d[\d.]{0,15}$/;
const BUILD_ID = /^[0-9a-f]{8,64}$/i;
const COMMIT = /^[0-9a-f]{40}$/;
const CATEGORIES = ["game", "patch", "addon"] as const;
type Category = (typeof CATEGORIES)[number];
const FILE_SOURCES: FileSource[] = ["kept", "copy", "inbox", "indexer"];
/** what a check step may need of the server */
export const CHECK_NEEDS: CheckNeed[] = ["avx2", "x86-64-v2", "x86-64-v3", "wine", "gl", "vulkan"];
const SMOKE_NEEDS = ["nothing", "gl", "vulkan", "d3d12"] as const;
const KIT_PLACEHOLDERS = ["program", "content", "needs", "out", "tools", "cpu", "jobs", "work"];
const KIT_UNPACK = ["zip", "tar", "tar.zst", "none"] as const;
/** the placeholders each make step's argv may hold ({program} only in a run step) */
const MAKE_ARGV = { convert: ["prep", "out", "in", "serial", "version"], run: ["prep", "out", "in", "serial", "version", "program"] };
/** what {serial} and {version} are checked with in a product's name: an identity's values are letters, digits, dot, dash
 *  and underscore */
const SAMPLE: Record<string, string> = { serial: "PPSA01341", version: "01.007.000" };
const DECISIONS = ["server-build", "upgrade", "widen", "game"] as const;

/** one name per region, whatever spelling was written ("U", "NTSC-U", "North America" → US): a word that names no region
 *  would skip every release that names one (src/ways/names.ts) */
function checkRegions(list: unknown, where: string, errors: string[]): string[] {
  return [...new Set(checkStrings(list, where, errors, { max: 10, len: 20 }).map(r => {
    const k = regionKey(r);
    if (!k) errors.push(`${where}: "${r}" is not a region (${REGION_NAMES.join(", ")}, or a spelling of one: USA, NTSC-J, PAL …)`);
    return k ?? r;
  }))];
}

function checkVersions(list: unknown, where: string, errors: string[]): string[] {
  const out = checkStrings(list, where, errors, { max: 8, len: 16 });
  for (const v of out) if (v.length <= 16 && !VERSION.test(v)) errors.push(`${where}: "${v}" is not a version (digits and dots, as the game's data writes it: 01.007.000)`);
  return uniq(out);
}

function checkBuilds(list: unknown, where: string, errors: string[]): string[] {
  const out = checkStrings(list, where, errors, { max: 4, len: 64 });
  for (const b of out) if (b.length <= 64 && !BUILD_ID.test(b)) errors.push(`${where}: "${b}" is not a build id (8 to 64 hex digits)`);
  return uniq(out.map(b => b.toLowerCase()));
}

function checkCategory(v: unknown, where: string, errors: string[]): Category | undefined {
  if (v === undefined || v === null) return undefined;
  if (!CATEGORIES.includes(v as Category)) { errors.push(`${where}: game, patch or addon (a patch or an add-on is never the game)`); return undefined; }
  return v as Category;
}

function checkRelPaths(list: unknown, where: string, errors: string[], max: number): string[] {
  const out = checkStrings(list, where, errors, { max, len: 260 });
  out.forEach((p, i) => { const e = safeRelPath(p); if (e) errors.push(`${where}[${i}]: ${e}`); });
  return out;
}

/** where the program's code names the accepted values: a readable repo, the full commit, a path in it, at most 300 lines,
 *  the values those lines hold */
function checkEvidence(list: unknown, where: string, errors: string[]): Evidence[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { errors.push(`${where}: a list of {repo, commit, path, lines, values}`); return []; }
  if (list.length > 20) errors.push(`${where}: at most 20`);
  const out: Evidence[] = [];
  list.forEach((e, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(e)) { errors.push(`${w}: must be {repo, commit, path, lines, values}`); return; }
    const repo = normalizeRepo(e.repo);
    if ("error" in repo) errors.push(`${w}.repo: ${repo.error}`);
    else if (repo.host === "feed") errors.push(`${w}.repo: a repo whose files can be read (GitHub owner/name, or forgejo:host/owner/name)`);
    const commit = str(e.commit) ? e.commit.trim().toLowerCase() : "";
    if (!COMMIT.test(commit)) errors.push(`${w}.commit: the full 40-digit commit the lines were read at`);
    const pe = safeRelPath(e.path);
    if (pe) errors.push(`${w}.path: ${pe}`);
    const lines = Array.isArray(e.lines) && e.lines.length === 2 ? e.lines.map(Number) : null;
    if (!lines || !lines.every(Number.isInteger) || lines[0] < 1 || lines[0] > lines[1] || lines[1] > 1e6) errors.push(`${w}.lines: [first, last], whole line numbers from 1, the first not after the last`);
    else if (lines[1] - lines[0] > 300) errors.push(`${w}.lines: at most 300 lines apart`);
    const values = checkStrings(e.values, `${w}.values`, errors, { max: 20, len: 100 });
    if (!values.length) errors.push(`${w}.values: the values those lines name (1 to 20)`);
    out.push({ repo: "error" in repo ? String(e.repo ?? "") : repo.repo, commit, path: String(e.path ?? ""), lines: lines && lines.length === 2 ? [lines[0], lines[1]] : [0, 0], values });
  });
  return out;
}

/** what makes game data the whole game: at least so many bytes or files, or most of the paths a file in the program lists */
function checkComplete(v: unknown, where: string, errors: string[]): Completeness | undefined {
  if (!isObj(v)) { errors.push(`${where}: {minBytes?, minFiles?, list?: {path, share?}}`); return undefined; }
  const out: Completeness = {};
  for (const k of ["minBytes", "minFiles"] as const) {
    if (v[k] === undefined || v[k] === null) continue;
    const n = Number(v[k]);
    if (!Number.isSafeInteger(n) || n < 0) errors.push(`${where}.${k}: a whole number, 0 or more`);
    else out[k] = n;
  }
  if (v.list !== undefined && v.list !== null) {
    if (!isObj(v.list)) errors.push(`${where}.list: {path, share?}`);
    else {
      const pe = safeRelPath(v.list.path);
      if (pe) errors.push(`${where}.list.path: ${pe} (a file in the program that lists the game's files)`);
      let share: number | undefined;
      if (v.list.share !== undefined && v.list.share !== null) {
        share = Number(v.list.share);
        if (!Number.isFinite(share) || share < 0.5 || share > 1) { errors.push(`${where}.list.share: between 0.5 and 1 (the part of the listed files that must be there)`); share = undefined; }
      }
      out.list = { path: String(v.list.path ?? ""), ...(share !== undefined ? { share } : {}) };
    }
  }
  if (!out.minBytes && !out.minFiles && !out.list) errors.push(`${where}: minBytes, minFiles or list (an empty check checks nothing)`);
  return out;
}

/* ─────────── a step's program ─────────── */

interface RunRules {
  /** the plan's tools; undefined: not known here, so a tool is only checked as a path */
  tools: ToolBuild | null | undefined;
  placeholders: string[];
  maxTimeout: number;
  /** a content plan is there ({content} can be given) */
  content: boolean;
}
/** a step's program: exactly one of exe (a path, or a bare Linux tool name when wine is false) and tool (one of
 *  tools.outputs), argv with the placeholders its field allows, a timeout */
function checkRun(r: Record<string, unknown>, w: string, o: RunRules, errors: string[]): { exe?: string; tool?: string; argv: string[]; wine: boolean; timeoutSec: number } {
  const hasExe = r.exe !== undefined && r.exe !== null && r.exe !== "", hasTool = r.tool !== undefined && r.tool !== null && r.tool !== "";
  if (hasExe === hasTool) errors.push(`${w}.run: exactly one of exe and tool`);
  const wine = r.wine === true;
  if (typeof r.wine !== "boolean") errors.push(`${w}.run.wine: true (a Windows program) or false`);
  if (hasExe) {
    const e = safeRelPath(r.exe);
    const bare = !wine && str(r.exe) && /^[a-z0-9._+-]{1,64}$/.test(r.exe);
    if (e && !bare) errors.push(`${w}.run.exe: ${e}`);
    if (wine && str(r.exe) && !/\.exe$/i.test(r.exe)) errors.push(`${w}.run.exe: wine runs .exe files`);
  }
  if (hasTool) {
    if (o.tools !== undefined) { if (!(o.tools?.outputs ?? []).includes(String(r.tool))) errors.push(`${w}.run.tool: must be one of tools.outputs`); }
    else { const e = safeRelPath(r.tool); if (e) errors.push(`${w}.run.tool: ${e}`); }
  }
  const argv = checkStrings(r.argv, `${w}.run.argv`, errors, { max: 50, len: 1000 });
  argv.forEach((a, j) => checkPlaceholders(a, o.placeholders, `${w}.run.argv[${j}]`, errors));
  if (o.placeholders.includes("content") && argv.some(a => placeholdersIn(a).includes("content")) && !o.content) errors.push(`${w}.run.argv: {content} needs a content plan`);
  const t = Number(r.timeoutSec);
  if (!Number.isInteger(t) || t < 1 || t > o.maxTimeout) errors.push(`${w}.run.timeoutSec: whole seconds, 1 to ${o.maxTimeout}`);
  return { ...(hasExe ? { exe: String(r.exe) } : { tool: String(r.tool) }), argv, wine, timeoutSec: Number.isInteger(t) ? t : 60 };
}

/* ─────────── making a game file ─────────── */

function checkMakeInput(v: unknown, platform: PlatformId | null, where: string, errors: string[]): MakeInput | null {
  if (!isObj(v)) { errors.push(`${where}: {shape, platform, formats?, marker?, also?, serials?, versions?, regions?, category?, complete?}`); return null; }
  const shape = v.shape;
  const shaped = shape === "file" || shape === "folder" || shape === "either";
  if (!shaped) errors.push(`${where}.shape: file, folder or either`);
  const p = str(v.platform) ? (platformId(v.platform) ?? (CONTENT_PLATFORMS.includes(v.platform as PlatformId) ? v.platform as PlatformId : null)) : null;
  if (!p || !CONTENT_PLATFORMS.includes(p)) errors.push(`${where}.platform: one of ${CONTENT_PLATFORMS.join(", ")}`);
  else if (platform && p !== platform) errors.push(`${where}.platform: game data is only re-shaped, so it is the same console's as the game file (${platform})`);
  let formats = checkFormats(v.formats, `${where}.formats`, errors);
  if (shape === "folder" && formats?.length) { errors.push(`${where}.formats: a folder input has no file format (its marker says what it is)`); formats = undefined; }
  // 'either' takes the folder or a file holding it: that file's formats are said as for a file input
  if ((shape === "file" || shape === "either") && !formats?.length) errors.push(`${where}.formats: what a file input may be ("zip", "7z", "nup" …)`);
  let marker: string | undefined;
  if (v.marker !== undefined && v.marker !== null && v.marker !== "") { const e = safeRelPath(v.marker); if (e) errors.push(`${where}.marker: ${e}`); else marker = String(v.marker); }
  else if (shape === "folder" || shape === "either") errors.push(`${where}.marker: the file that says a folder is the game (sce_sys/param.json)`);
  const also = checkRelPaths(v.also, `${where}.also`, errors, 10);
  if (also.length && (v.marker === undefined || v.marker === null || v.marker === "")) errors.push(`${where}.also: files beside the marker: name the marker too`);
  const serials = checkStrings(v.serials, `${where}.serials`, errors, { max: 50, len: 32, re: /^[A-Za-z0-9_.-]+$/ });
  const versions = checkVersions(v.versions, `${where}.versions`, errors);
  const regions = checkRegions(v.regions, `${where}.regions`, errors);
  const category = checkCategory(v.category, `${where}.category`, errors);
  const complete = v.complete !== undefined && v.complete !== null ? checkComplete(v.complete, `${where}.complete`, errors) : undefined;
  if (!shaped) return null;
  return {
    shape, platform: (p ?? platform ?? "pc") as PlatformId, ...(formats ? { formats } : {}), ...(marker ? { marker } : {}), ...(also.length ? { also } : {}),
    ...(serials.length ? { serials } : {}), ...(versions.length ? { versions } : {}), ...(regions.length ? { regions } : {}), ...(category ? { category } : {}),
    ...(complete ? { complete } : {}),
  };
}

function checkPinnedTool(v: Record<string, unknown>, where: string, errors: string[]): PinnedTool | null {
  const repo = normalizeRepo(v.repo);
  if ("error" in repo) errors.push(`${where}.repo: ${repo.error}`);
  else if (repo.host === "feed") errors.push(`${where}.repo: a GitHub owner/name, or forgejo:host/owner/name, to build it from`);
  const commit = str(v.commit) ? v.commit.trim().toLowerCase() : "";
  if (!COMMIT.test(commit)) errors.push(`${where}.commit: the full 40-digit commit it is built from`);
  const steps = checkStrings(v.steps, `${where}.steps`, errors, { max: 20, len: 2000 });
  if (!steps.length) errors.push(`${where}.steps: the build commands, in order (1 to 20)`);
  steps.forEach((s, i) => checkPlaceholders(s, ["jobs"], `${where}.steps[${i}]`, errors));
  const outputs = checkStrings(v.outputs, `${where}.outputs`, errors, { max: 20, len: 260 });
  if (!outputs.length) errors.push(`${where}.outputs: the built files (the first is the program a convert step runs)`);
  outputs.forEach((o, i) => { const e = safeRelPath(o); if (e) errors.push(`${where}.outputs[${i}]: ${e}`); });
  const apt = checkStrings(v.apt, `${where}.apt`, errors, { max: 40, len: 61 });
  const refused = apt.filter(a => !aptAllowed(a));
  if (refused.length) errors.push(`${where}.apt: ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not on the build allowlist (${APT_ALLOWED})`);
  if ("error" in repo) return null;
  return { repo: repo.repo, commit, steps, outputs, ...(apt.length ? { apt } : {}) };
}

function checkMakeSteps(list: unknown, input: MakeInput | null, where: string, errors: string[], tools: ToolBuild | null | undefined): MakeStep[] {
  if (!Array.isArray(list) || !list.length) { errors.push(`${where}: the steps, in order (1 to 20)`); return []; }
  if (list.length > 20) errors.push(`${where}: at most 20 steps`);
  const out: MakeStep[] = [];
  let writers = 0, readsIn = false;
  /** a path inside {prep}, written without placeholders */
  const prepPath = (p: unknown, w: string, glob = false): string => {
    const e = safeRelPath(p, { glob });
    if (e) errors.push(`${w}: ${e} (a path inside {prep})`);
    else if (placeholdersIn(String(p)).length) errors.push(`${w}: a path inside {prep}, written without placeholders`);
    return String(p ?? "");
  };
  const anyIn = (argv: string[], p: string) => argv.some(a => placeholdersIn(a).includes(p));
  list.forEach((s, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(s) || Object.keys(s).length !== 1) { errors.push(`${w}: exactly one of unpack, pick, convert, run, remove, move`); return; }
    if (isObj(s.unpack)) {
      // the input file, unpacked by the system's archiver
      if (input?.shape === "folder") errors.push(`${w}.unpack: the input is a folder: there is nothing to unpack`);
      readsIn = true;
      const to = prepPath(s.unpack.to, `${w}.unpack.to`);
      const only = checkStrings(s.unpack.only, `${w}.unpack.only`, errors, { max: 50, len: 260 });
      only.forEach((g, j) => { const e = safeRelPath(g, { glob: true }); if (e) errors.push(`${w}.unpack.only[${j}]: ${e}`); });
      out.push({ unpack: { to, ...(only.length ? { only } : {}) } });
    } else if (isObj(s.pick)) {
      const m = str(s.pick.within) ? /^\{(in|prep)\}(?:\/(.+))?$/.exec(s.pick.within) : null;
      if (!m) errors.push(`${w}.pick.within: {in} (the input) or {prep}, or a folder below either ({prep}/unpacked)`);
      else {
        if (m[2]) { const e = safeRelPath(m[2]); if (e) errors.push(`${w}.pick.within: ${e}`); else if (placeholdersIn(m[2]).length) errors.push(`${w}.pick.within: one placeholder, at the start`); }
        if (m[1] === "in") { readsIn = true; if (input?.shape === "file") errors.push(`${w}.pick.within: the input is a file: unpack it first and pick inside {prep}`); }
      }
      const me = safeRelPath(s.pick.marker);
      if (me) errors.push(`${w}.pick.marker: ${me}`);
      const also = checkRelPaths(s.pick.also, `${w}.pick.also`, errors, 10);
      const as = prepPath(s.pick.as, `${w}.pick.as`);
      out.push({ pick: { within: String(s.pick.within ?? ""), marker: String(s.pick.marker ?? ""), ...(also.length ? { also } : {}), as } });
    } else if (isObj(s.convert)) {
      const c = s.convert;
      let tool: ConverterId | PinnedTool | null = null;
      const named = `one of ${CONVERTER_IDS.join(", ")}, or a converter pinned to a commit ({repo, commit, steps, outputs})`;
      if (str(c.with)) { if (CONVERTER_IDS.includes(c.with as ConverterId)) tool = c.with as ConverterId; else errors.push(`${w}.convert.with: ${named}`); }
      else if (isObj(c.with)) tool = checkPinnedTool(c.with, `${w}.convert.with`, errors);
      else errors.push(`${w}.convert.with: ${named}`);
      const argv = checkStrings(c.argv, `${w}.convert.argv`, errors, { max: 50, len: 1000 });
      argv.forEach((a, j) => checkPlaceholders(a, MAKE_ARGV.convert, `${w}.convert.argv[${j}]`, errors));
      if (anyIn(argv, "in")) readsIn = true;
      if (anyIn(argv, "out")) writers++;
      const t = Number(c.timeoutSec);
      if (!Number.isInteger(t) || t < 1 || t > 14400) errors.push(`${w}.convert.timeoutSec: whole seconds, 1 to 14400`);
      out.push({ convert: { with: tool ?? CONVERTER_IDS[0], argv, timeoutSec: Number.isInteger(t) ? t : 600 } });
    } else if (isObj(s.run)) {
      const run = checkRun(s.run, w, { tools, placeholders: MAKE_ARGV.run, maxTimeout: 14400, content: true }, errors);
      if (anyIn(run.argv, "in")) readsIn = true;
      if (anyIn(run.argv, "out")) writers++;
      out.push({ run });
    } else if (s.remove !== undefined) {
      out.push({ remove: prepPath(s.remove, `${w}.remove`, true) });
    } else if (isObj(s.move)) {
      out.push({ move: { from: prepPath(s.move.from, `${w}.move.from`), to: prepPath(s.move.to, `${w}.move.to`) } });
    } else errors.push(`${w}: exactly one of unpack, pick, convert, run, remove, move`);
  });
  if (!writers) errors.push(`${where}: no step writes the product: one convert or run step puts it at {out}`);
  else if (writers > 1) errors.push(`${where}: only the step that makes the product writes {out} (${writers} steps do)`);
  if (!readsIn) errors.push(`${where}: no step reads the input (an unpack, a pick within {in}, or {in} in a step's argv)`);
  return out;
}

function checkMakeOutput(v: unknown, content: { kind: unknown; formats: string[] }, where: string, errors: string[]): ContentMake["output"] | null {
  if (!isObj(v)) { errors.push(`${where}: {shape, name}`); return null; }
  const shape = v.shape;
  if (shape !== "file" && shape !== "folder") { errors.push(`${where}.shape: file or folder`); return null; }
  if (content.kind === "rom" || content.kind === "disc" || content.kind === "folder") {
    const want = content.kind === "folder" ? "folder" : "file";
    if (shape !== want) errors.push(`${where}.shape: ${want}, as the way's game data is one ${want}`);
  }
  const name = str(v.name) ? v.name.trim() : "";
  if (!name) { errors.push(`${where}.name: the product's name in {out} ("{serial}-app0.zar")`); return { shape, name }; }
  const bad = placeholdersIn(name).filter(p => !(p in SAMPLE));
  if (bad.length) { errors.push(`${where}.name: {${bad[0]}} is not a placeholder here ({serial}, {version})`); return { shape, name }; }
  const filled = name.replace(/\{(serial|version)\}/g, (_m, k: string) => SAMPLE[k]);
  if (filled.length > 120 || placedName(filled) !== filled) errors.push(`${where}.name: letters, digits, dot, dash and underscore only, up to 120 (it becomes the file's name in the package)`);
  else if (shape === "file") {
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(filled)?.[1]?.toLowerCase();
    if (!ext) errors.push(`${where}.name: a file's name ends with its format (.zar)`);
    else if (content.formats.length && !content.formats.includes(ext)) errors.push(`${where}.name: a .${ext} file, and accept.formats (the product's formats) are ${content.formats.map(f => "." + f).join(", ")}`);
  }
  return { shape, name };
}

/**
 * A content plan's make: where its input may come from, what the input must be (judged before any step), 1 to 20 steps
 * whose fields hold only their own placeholders ({in} in convert and run argv — an unpack and a pick within {in} read the
 * input themselves —, {out} in the one step that writes the product, {program} only in a run step), paths inside {prep},
 * a converter by name or pinned to a commit, timeouts up to 4 hours, and a product whose name is a safe file name in a
 * format the plan accepts.
 */
export function checkMake(v: unknown, content: { kind: unknown; platform: PlatformId | null; formats: string[] }, where: string, errors: string[], tools?: ToolBuild | null): ContentMake | null {
  if (!isObj(v)) { errors.push(`${where}: {from?, input, steps, output}`); return null; }
  let from: FileSource[] | undefined;
  if (v.from !== undefined && v.from !== null) {
    if (!Array.isArray(v.from) || !v.from.length) errors.push(`${where}.from: a list of ${FILE_SOURCES.join(", ")}`);
    else {
      from = [];
      for (const f of v.from) {
        if (!FILE_SOURCES.includes(f as FileSource)) errors.push(`${where}.from: "${String(f)}" is not one of ${FILE_SOURCES.join(", ")}`);
        else if (!from.includes(f as FileSource)) from.push(f as FileSource);
      }
    }
  }
  const input = checkMakeInput(v.input, content.platform, `${where}.input`, errors);
  const steps = checkMakeSteps(v.steps, input, `${where}.steps`, errors, tools);
  const output = checkMakeOutput(v.output, content, `${where}.output`, errors);
  if (!input || !output) return null;
  return { ...(from?.length ? { from } : {}), input, steps, output };
}

/** a make's run steps that name a tool the plan does not build */
function makeToolProblems(m: ContentMake, tools: ToolBuild | null, where: string, errors: string[]) {
  m.steps.forEach((s, i) => { if ("run" in s && s.run.tool && !(tools?.outputs ?? []).includes(s.run.tool)) errors.push(`${where}.steps[${i}].run.tool: must be one of tools.outputs`); });
}

/* ─────────── a per-game build and the checks ─────────── */

/** a release kit's per-game build: pinned fetches, 1 to 30 steps with their placeholders, a CPU level the code is built
 *  for, a timeout per step of up to 6 hours, and the install folder inside {out} */
export function checkPerGame(v: unknown, errors: string[], where = "program.perGame"): KitBuild | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) { errors.push(`${where}: {fetch?, steps, wine?, cpu?, timeoutSec, artifact}`); return null; }
  const fetch: NonNullable<KitBuild["fetch"]> = [];
  if (v.fetch !== undefined && v.fetch !== null) {
    if (!Array.isArray(v.fetch)) errors.push(`${where}.fetch: a list of {url, sha256, size?, to, unpack?}`);
    else {
      if (v.fetch.length > 64) errors.push(`${where}.fetch: at most 64 files`);
      v.fetch.forEach((f, i) => {
        const w = `${where}.fetch[${i}]`;
        if (!isObj(f)) { errors.push(`${w}: must be {url, sha256, size?, to, unpack?}`); return; }
        let u: URL | null = null;
        try { u = str(f.url) ? new URL(f.url) : null; } catch { u = null; }
        if (!u || u.protocol !== "https:") errors.push(`${w}.url: an https address`);
        else if (u.username || u.password) errors.push(`${w}.url: may not carry a login`);
        const sha = str(f.sha256) ? f.sha256.trim().toLowerCase() : "";
        if (!/^[0-9a-f]{64}$/.test(sha)) errors.push(`${w}.sha256: the file's sha256 (64 hex digits): every file a build fetches is pinned`);
        let size: number | undefined;
        if (f.size !== undefined && f.size !== null) { size = Number(f.size); if (!Number.isSafeInteger(size) || size <= 0) { errors.push(`${w}.size: whole bytes`); size = undefined; } }
        const te = safeRelPath(f.to);
        if (te) errors.push(`${w}.to: ${te} (a path inside {tools})`);
        else if (placeholdersIn(String(f.to)).length) errors.push(`${w}.to: a path inside {tools}, written without placeholders`);
        const unpack = f.unpack === undefined || f.unpack === null ? undefined : String(f.unpack);
        const known = unpack !== undefined && (KIT_UNPACK as readonly string[]).includes(unpack);
        if (unpack !== undefined && !known) errors.push(`${w}.unpack: zip, tar, tar.zst or none`);
        fetch.push({ url: u ? u.toString() : String(f.url ?? ""), sha256: sha, ...(size !== undefined ? { size } : {}), to: String(f.to ?? ""), ...(known ? { unpack: unpack as (typeof KIT_UNPACK)[number] } : {}) });
      });
    }
  }
  const steps = checkStrings(v.steps, `${where}.steps`, errors, { max: 30, len: 2000 });
  if (!steps.length) errors.push(`${where}.steps: the build commands, in order (1 to 30)`);
  steps.forEach((s, i) => checkPlaceholders(s, KIT_PLACEHOLDERS, `${where}.steps[${i}]`, errors));
  if (v.wine !== undefined && v.wine !== null && typeof v.wine !== "boolean") errors.push(`${where}.wine: true (the steps run Windows tools) or false`);
  const cpu = v.cpu === undefined || v.cpu === null ? undefined : v.cpu;
  if (cpu !== undefined && cpu !== "x86-64-v2" && cpu !== "x86-64-v3") errors.push(`${where}.cpu: x86-64-v2 or x86-64-v3 (the level the code is built for, never the server's own)`);
  if (cpu === undefined && steps.some(s => placeholdersIn(s).includes("cpu"))) errors.push(`${where}.cpu: the steps pass {cpu}, so the plan names the level (x86-64-v2 or x86-64-v3)`);
  const t = Number(v.timeoutSec);
  if (!Number.isInteger(t) || t < 1 || t > 21600) errors.push(`${where}.timeoutSec: whole seconds per step, 1 to 21600`);
  const ae = safeRelPath(v.artifact, { allowDot: true });
  if (ae) errors.push(`${where}.artifact: ${ae} (the install folder inside {out}; "." for all of it)`);
  return {
    ...(fetch.length ? { fetch } : {}), steps, ...(v.wine === true ? { wine: true } : {}),
    ...(cpu === "x86-64-v2" || cpu === "x86-64-v3" ? { cpu } : {}), timeoutSec: Number.isInteger(t) ? t : 3600, artifact: String(v.artifact ?? ""),
  };
}

function checkNeedList(v: unknown, where: string, errors: string[]): CheckNeed[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { errors.push(`${where}: a list of ${CHECK_NEEDS.join(", ")}`); return []; }
  const out: CheckNeed[] = [];
  for (const n of v) {
    if (!CHECK_NEEDS.includes(n as CheckNeed)) errors.push(`${where}: "${String(n)}" is not one of ${CHECK_NEEDS.join(", ")}`);
    else if (!out.includes(n as CheckNeed)) out.push(n as CheckNeed);
  }
  return out;
}

/** checks run on the server: at most 6 steps run like a setup step (argv {stage} {content} {work}, at most 30 minutes
 *  each; expect: text one line of the output contains; needs: what the server must have), and a start of 1 to 60 seconds */
export function checkCheck(v: unknown, where: string, tools: ToolBuild | null | undefined, content: ContentPlan | null, errors: string[]): PlanCheck | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) { errors.push(`${where}: {steps, smoke?}`); return null; }
  if (v.steps !== undefined && v.steps !== null && !Array.isArray(v.steps)) errors.push(`${where}.steps: a list of {run, what, expect?, needs?}`);
  const list = Array.isArray(v.steps) ? v.steps : [];
  if (list.length > 6) errors.push(`${where}.steps: at most 6`);
  const steps: PlanCheck["steps"] = [];
  list.forEach((s, i) => {
    const w = `${where}.steps[${i}]`;
    if (!isObj(s) || !isObj(s.run)) { errors.push(`${w}: must be {run, what, expect?, needs?}`); return; }
    const run = checkRun(s.run, w, { tools, placeholders: ["stage", "content", "work"], maxTimeout: 1800, content: !!content }, errors);
    const what = str(s.what) ? s.what.trim() : "";
    if (!what) errors.push(`${w}.what: what the step shows ("the emulator reads the packed game")`);
    else if (what.length > 200) errors.push(`${w}.what: up to 200 characters`);
    let expect: string | undefined;
    if (s.expect !== undefined && s.expect !== null) {
      if (!str(s.expect) || !s.expect.trim()) errors.push(`${w}.expect: the text one line of the output contains`);
      else if (s.expect.length > 200) errors.push(`${w}.expect: up to 200 characters (it is matched as it is, never as a pattern)`);
      else expect = s.expect;
    }
    const needs = checkNeedList(s.needs, `${w}.needs`, errors);
    steps.push({ run, ...(expect !== undefined ? { expect } : {}), what, ...(needs.length ? { needs } : {}) });
  });
  let smoke: PlanCheck["smoke"] = null;
  if (v.smoke !== undefined && v.smoke !== null) {
    if (!isObj(v.smoke)) errors.push(`${where}.smoke: {seconds, title?, needs}`);
    else {
      const sec = Number(v.smoke.seconds);
      if (!Number.isInteger(sec) || sec < 1 || sec > 60) errors.push(`${where}.smoke.seconds: whole seconds, 1 to 60`);
      let title: string | undefined;
      if (v.smoke.title !== undefined && v.smoke.title !== null) {
        if (!str(v.smoke.title) || v.smoke.title.length > 200) errors.push(`${where}.smoke.title: text up to 200 characters (the window title it should show)`);
        else if (v.smoke.title.trim()) title = v.smoke.title.trim();
      }
      const needs = (SMOKE_NEEDS as readonly unknown[]).includes(v.smoke.needs) ? v.smoke.needs as (typeof SMOKE_NEEDS)[number] : null;
      if (!needs) errors.push(`${where}.smoke.needs: nothing, gl, vulkan or d3d12 (what the program draws with)`);
      smoke = { seconds: Number.isInteger(sec) ? sec : 10, ...(title ? { title } : {}), needs: needs ?? "nothing" };
    }
  }
  if (!list.length && !smoke) errors.push(`${where}: at least one step or a smoke start (an empty check checks nothing)`);
  return { steps, ...(smoke ? { smoke } : {}) };
}

function checkDecisions(list: unknown, errors: string[]): PlanDecision[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { errors.push("decisions: a list of {at, what, outcome, by}"); return []; }
  if (list.length > 20) errors.push("decisions: at most 20 (keep the latest)");
  const out: PlanDecision[] = [];
  list.forEach((d, i) => {
    const w = `decisions[${i}]`;
    if (!isObj(d)) { errors.push(`${w}: must be {at, what, outcome, by}`); return; }
    const at = Number(d.at);
    if (!Number.isSafeInteger(at) || at < 0) errors.push(`${w}.at: when, in whole seconds since 1970`);
    if (!(DECISIONS as readonly unknown[]).includes(d.what)) errors.push(`${w}.what: server-build, upgrade, widen or game`);
    const outcome = str(d.outcome) ? d.outcome.trim() : "";
    if (!outcome || outcome.length > 500) errors.push(`${w}.outcome: what was decided, up to 500 characters`);
    if (d.by !== "ai" && d.by !== "admin") errors.push(`${w}.by: ai or admin`);
    const way = d.wayId === undefined || d.wayId === null ? null : Number(d.wayId);
    if (way !== null && (!Number.isSafeInteger(way) || way < 1)) errors.push(`${w}.wayId: the way it was decided for (an id), or nothing`);
    out.push({ at: Number.isSafeInteger(at) ? at : 0, what: d.what as PlanDecision["what"], outcome, by: d.by === "admin" ? "admin" : "ai", ...(way !== null && Number.isSafeInteger(way) && way > 0 ? { wayId: way } : {}) });
  });
  return out;
}

const NOT_PER_GAME = "program.perGame: only a release asset or a fixed file (url) is a kit that builds the game per way";

function checkProgram(p: unknown, errors: string[], warnings: string[]): ProgramSource | null {
  if (!isObj(p)) { errors.push("program: must say where the program comes from ({kind: release | feed | url | source, …})"); return null; }
  switch (p.kind) {
    case "release": {
      const pat = str(p.assetPattern) ? p.assetPattern.trim() : "";
      if (!pat) { errors.push("program.assetPattern: a regex picking the Windows x64 file"); return null; }
      if (pat.length > 300) errors.push("program.assetPattern: up to 300 characters");
      try { new RegExp(pat, "i"); } catch (e) { errors.push(`program.assetPattern: does not compile (${(e as Error).message})`); }
      if (/^\^?\.\*\$?$/.test(pat)) errors.push("program.assetPattern: matches every file; name the Windows asset");
      const channel = p.channel === undefined ? "stable" : p.channel;
      if (channel !== "stable" && channel !== "nightly") errors.push("program.channel: stable or nightly");
      if (channel === "nightly") warnings.push("the program follows nightly builds: players get whatever was newest when it was pinned");
      const perGame = checkPerGame(p.perGame, errors);
      return { kind: "release", assetPattern: pat, channel: channel === "nightly" ? "nightly" : "stable", ...(perGame ? { perGame } : {}) };
    }
    case "feed": {
      if (p.feed !== "dolphin:beta" && p.feed !== "dolphin:dev") { errors.push("program.feed: dolphin:beta or dolphin:dev"); return null; }
      if (p.perGame !== undefined && p.perGame !== null) errors.push(NOT_PER_GAME);
      return { kind: "feed", feed: p.feed };
    }
    case "url": {
      let u: URL | null = null;
      try { u = str(p.url) ? new URL(p.url) : null; } catch { u = null; }
      if (!u || u.protocol !== "https:") errors.push("program.url: an https address");
      else if (u.username || u.password) errors.push("program.url: may not carry a login");
      const sha = str(p.sha256) ? p.sha256.trim().toLowerCase() : "";
      if (!/^[0-9a-f]{64}$/.test(sha)) errors.push("program.sha256: the file's sha256 (64 hex digits)");
      const perGame = checkPerGame(p.perGame, errors);
      return u ? { kind: "url", url: u.toString(), sha256: sha, ...(perGame ? { perGame } : {}) } : null;
    }
    case "source": {
      const ref = str(p.ref) ? p.ref.trim() : "";
      if (!/^[A-Za-z0-9._\/{}-]{1,100}$/.test(ref) || ref.includes("..")) errors.push("program.ref: a tag, branch or commit");
      const steps = checkStrings(p.steps, "program.steps", errors, { max: 50, len: 2000 });
      if (!steps.length) errors.push("program.steps: the build commands, in order");
      const artErr = safeRelPath(p.artifact, { allowDot: true });
      if (artErr) errors.push(`program.artifact: ${artErr}`);
      const apt = checkStrings(p.apt, "program.apt", errors, { max: 40, len: 61, re: APT });
      const content = p.content === undefined ? "none" : p.content;
      if (content !== "none" && content !== "build") errors.push("program.content: none, or build (the game file is needed to build)");
      steps.forEach((s, i) => checkPlaceholders(s, content === "build" ? ["content"] : [], `program.steps[${i}]`, errors));
      if (p.perGame !== undefined && p.perGame !== null) errors.push(NOT_PER_GAME);
      return { kind: "source", ref, steps, artifact: String(p.artifact ?? ""), ...(apt.length ? { apt } : {}), content: content === "build" ? "build" : "none" };
    }
    default:
      errors.push("program.kind: release, feed, url or source");
      return null;
  }
}

/** a way's (or a plan's) game file */
export function checkContent(c: unknown, kind: PlanKind, errors: string[], warnings: string[], where = "content"): ContentPlan | null {
  if (c === null || c === undefined) return null;
  if (!isObj(c)) { errors.push(`${where}: must be {kind, platform, what, search, accept, place}`); return null; }
  if (c.kind !== "rom" && c.kind !== "disc" && c.kind !== "folder") errors.push(`${where}.kind: rom, disc or folder (one file, or one folder of game data)`);
  const folder = c.kind === "folder";
  const platform = str(c.platform) ? (platformId(c.platform) ?? (CONTENT_PLATFORMS.includes(c.platform as PlatformId) ? c.platform as PlatformId : null)) : null;
  if (!platform || !CONTENT_PLATFORMS.includes(platform)) errors.push(`${where}.platform: one of ${CONTENT_PLATFORMS.join(", ")}`);
  const what = str(c.what) ? c.what.trim() : "";
  if (!what) errors.push(`${where}.what: say what the file must be ("Majora's Mask, NTSC-U 1.0")`);
  else if (what.length > 300) errors.push(`${where}.what: up to 300 characters`);
  const search = checkStrings(c.search, `${where}.search`, errors, { max: 10, len: 200 });
  if (!search.length) errors.push(`${where}.search: the original game's names to search the indexers by`);
  const terms = checkStrings(c.terms, `${where}.terms`, errors, { max: 5, len: 100 });
  const acc = isObj(c.accept) ? c.accept : {};
  if (c.accept !== undefined && !isObj(c.accept)) errors.push(`${where}.accept: must be {hashes, formats?, regions?, serials?}`);
  const hashes = checkHashes(acc.hashes, `${where}.accept.hashes`, errors);
  let formats = checkFormats(acc.formats, `${where}.accept.formats`, errors);
  if (folder && formats?.length) { errors.push(`${where}.accept.formats: a folder game has no file format (its marker says what it is)`); formats = undefined; }
  const regions = checkRegions(acc.regions, `${where}.accept.regions`, errors);
  const serials = checkStrings(acc.serials, `${where}.accept.serials`, errors, { max: 50, len: 32, re: /^[A-Za-z0-9_.-]+$/ });
  const versions = checkVersions(acc.versions, `${where}.accept.versions`, errors);
  const category = checkCategory(acc.category, `${where}.accept.category`, errors);
  const builds = checkBuilds(acc.builds, `${where}.accept.builds`, errors);
  const evidence = checkEvidence(acc.evidence, `${where}.accept.evidence`, errors);
  // a game folder: the file that says it is the game, the files beside it, and what makes it the whole game
  let marker: string | undefined;
  let also: string[] = [];
  let complete: Completeness | undefined;
  if (folder) {
    if (c.marker === undefined || c.marker === null || c.marker === "") errors.push(`${where}.marker: the file inside the folder that says it is the game (sce_sys/param.json, PS3_GAME/PARAM.SFO, exefs/main)`);
    else { const e = safeRelPath(c.marker); if (e) errors.push(`${where}.marker: ${e}`); else marker = String(c.marker); }
    also = checkRelPaths(c.also, `${where}.also`, errors, 10);
    if (c.complete !== undefined && c.complete !== null) complete = checkComplete(c.complete, `${where}.complete`, errors);
  } else {
    if ((c.marker !== undefined && c.marker !== null) || (c.also !== undefined && c.also !== null)) errors.push(`${where}.marker: only a folder game has a marker (the file inside it that says it is the game)`);
    if (c.complete !== undefined && c.complete !== null) errors.push(`${where}.complete: only a folder game is checked for being whole (a game file made from a folder says it in make.input.complete)`);
  }
  let personalDump: string | null = null;
  if (c.personalDump !== undefined && c.personalDump !== null) {
    if (!str(c.personalDump) || c.personalDump.length > 200) errors.push(`${where}.personalDump: who makes it, up to 200 characters ("Eglantine on your Switch 2")`);
    else personalDump = c.personalDump.trim() || null;
  }
  const normalize = c.normalize === undefined || c.normalize === null ? null : c.normalize;
  if (normalize !== null && normalize !== "n64-z64") errors.push(`${where}.normalize: n64-z64 or nothing`);
  if (normalize === "n64-z64" && platform && platform !== "n64") errors.push(`${where}.normalize: n64-z64 is for Nintendo 64 files only`);
  const placeErr = safeRelPath(c.place);
  if (placeErr) errors.push(`${where}.place: ${placeErr}`);
  else if (folder && placeholdersIn(String(c.place)).length) errors.push(`${where}.place: a folder game's place is the folder it becomes, written without {name}`);
  else checkPlaceholders(String(c.place), ["name"], `${where}.place`, errors);
  const ship = c.ship === undefined ? true : c.ship;
  if (typeof ship !== "boolean") errors.push(`${where}.ship: true or false`);
  if (kind === "emulator" && hashes.length) errors.push(`${where}.accept.hashes: an emulator plan accepts any game of its platform — put per-game hashes on the way`);
  if (kind !== "emulator" && !hashes.length) warnings.push("the game file cannot be verified (no accepted hashes): any file of the platform will do");
  // made from another form of the game's data: the product's formats are what the plan accepts
  let make: ContentMake | null = null;
  if (c.make !== undefined && c.make !== null) {
    make = checkMake(c.make, { kind: c.kind, platform, formats: formats ?? [] }, `${where}.make`, errors);
    if (!folder && !(formats ?? []).length) errors.push(`${where}.accept.formats: a made file says its format here (the product's: zar, chd …)`);
  }
  return {
    kind: c.kind === "disc" ? "disc" : c.kind === "folder" ? "folder" : "rom", platform: (platform ?? "pc") as PlatformId, what, search,
    accept: {
      hashes, ...(formats ? { formats } : {}), ...(regions.length ? { regions } : {}), ...(serials.length ? { serials } : {}),
      ...(versions.length ? { versions } : {}), ...(category ? { category } : {}), ...(builds.length ? { builds } : {}), ...(evidence.length ? { evidence } : {}),
    },
    normalize: normalize === "n64-z64" ? "n64-z64" : null, place: String(c.place ?? ""), ...(ship === false ? { ship: false } : {}),
    ...(terms.length ? { terms } : {}), ...(marker ? { marker } : {}), ...(also.length ? { also } : {}), ...(complete ? { complete } : {}),
    ...(personalDump ? { personalDump } : {}), ...(make ? { make } : {}),
  };
}

function checkFiles(list: unknown, where: string, errors: string[]): PlanFile[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { errors.push(`${where}: a list of {path, text}`); return []; }
  if (list.length > 50) errors.push(`${where}: at most 50 files`);
  const out: PlanFile[] = [];
  list.forEach((f, i) => {
    if (!isObj(f)) { errors.push(`${where}[${i}]: must be {path, text}`); return; }
    const pe = safeRelPath(f.path);
    if (pe) errors.push(`${where}[${i}].path: ${pe}`);
    if (!str(f.text)) errors.push(`${where}[${i}].text: the file's text`);
    else {
      if (f.text.length > 65536) errors.push(`${where}[${i}].text: up to 64 KB`);
      const sp = serverPathIn(f.text);
      if (sp) errors.push(`${where}[${i}].text: holds ${sp} — it would ship to players' PCs`);
    }
    if (f.after !== undefined && f.after !== "setup") errors.push(`${where}[${i}].after: "setup" or nothing`);
    out.push({ path: String(f.path ?? ""), text: String(f.text ?? ""), ...(f.after === "setup" ? { after: "setup" as const } : {}) });
  });
  return out;
}

function checkTools(t: unknown, errors: string[]): ToolBuild | null {
  if (t === undefined || t === null) return null;
  if (!isObj(t)) { errors.push("tools: must be {ref, steps, outputs}"); return null; }
  const ref = str(t.ref) ? t.ref.trim() : "";
  if (!/^[A-Za-z0-9._\/{}-]{1,100}$/.test(ref) || ref.includes("..")) errors.push("tools.ref: '{tag}' (the program's tag) or a git ref");
  const steps = checkStrings(t.steps, "tools.steps", errors, { max: 50, len: 2000 });
  if (!steps.length) errors.push("tools.steps: the build commands, in order");
  const outputs = checkStrings(t.outputs, "tools.outputs", errors, { max: 20, len: 260 });
  if (!outputs.length) errors.push("tools.outputs: the built files setup runs");
  outputs.forEach((o, i) => { const e = safeRelPath(o); if (e) errors.push(`tools.outputs[${i}]: ${e}`); });
  const apt = checkStrings(t.apt, "tools.apt", errors, { max: 40, len: 61, re: APT });
  return { ref, steps, outputs, ...(apt.length ? { apt } : {}) };
}

function checkSetup(list: unknown, tools: ToolBuild | null, content: ContentPlan | null, errors: string[], where = "setup"): SetupStep[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { errors.push(`${where}: a list of steps`); return []; }
  if (list.length > 30) errors.push(`${where}: at most 30 steps`);
  const out: SetupStep[] = [];
  list.forEach((s, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(s) || Object.keys(s).length !== 1) { errors.push(`${w}: exactly one of run, ini, remove, move`); return; }
    if (isObj(s.run)) {
      out.push({ run: checkRun(s.run, w, { tools, placeholders: ["stage", "work", "content"], maxTimeout: 3600, content: !!content }, errors) });
    } else if (isObj(s.ini)) {
      const n = s.ini;
      const e = safeRelPath(n.path);
      if (e) errors.push(`${w}.ini.path: ${e}`);
      if (!str(n.section) || !n.section.trim() || n.section.length > 100) errors.push(`${w}.ini.section: a section name`);
      if (!str(n.key) || !n.key.trim() || n.key.length > 100) errors.push(`${w}.ini.key: a key name`);
      if (!str(n.value) || n.value.length > 1000) errors.push(`${w}.ini.value: text up to 1000 characters`);
      else { const sp = serverPathIn(n.value); if (sp) errors.push(`${w}.ini.value: holds ${sp}`); }
      out.push({ ini: { path: String(n.path ?? ""), section: String(n.section ?? ""), key: String(n.key ?? ""), value: String(n.value ?? "") } });
    } else if (s.remove !== undefined) {
      const e = safeRelPath(s.remove, { glob: true });
      if (e) errors.push(`${w}.remove: ${e}`);
      out.push({ remove: String(s.remove) });
    } else if (isObj(s.move)) {
      const a = safeRelPath(s.move.from), b = safeRelPath(s.move.to);
      if (a) errors.push(`${w}.move.from: ${a}`);
      if (b) errors.push(`${w}.move.to: ${b}`);
      out.push({ move: { from: String(s.move.from ?? ""), to: String(s.move.to ?? "") } });
    } else errors.push(`${w}: exactly one of run, ini, remove, move`);
  });
  return out;
}

function checkNeeds(list: unknown, errors: string[]): NeedSlot[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { errors.push("needs: a list of {kind, name, place}"); return []; }
  if (list.length > 10) errors.push("needs: at most 10");
  const out: NeedSlot[] = [];
  list.forEach((n, i) => {
    const w = `needs[${i}]`;
    if (!isObj(n)) { errors.push(`${w}: must be {kind, name, place}`); return; }
    if (!["bios", "firmware", "keys", "other"].includes(String(n.kind))) errors.push(`${w}.kind: bios, firmware, keys or other`);
    if (!str(n.name) || !n.name.trim() || n.name.length > 120) errors.push(`${w}.name: what the file is`);
    if (n.build !== undefined && typeof n.build !== "boolean") errors.push(`${w}.build: true (used by the server build only) or false`);
    const e = safeRelPath(n.place);
    if (e) errors.push(`${w}.place: ${e} (where the file goes in the install folder)`);
    const acc = isObj(n.accept) ? n.accept : undefined;
    const hashes = acc ? checkHashes(acc.hashes, `${w}.accept.hashes`, errors) : [];
    const formats = acc ? checkFormats(acc.formats, `${w}.accept.formats`, errors) : undefined;
    let sizes: number[] | undefined;
    if (acc?.sizes !== undefined) {
      if (!Array.isArray(acc.sizes) || acc.sizes.some(x => !Number.isInteger(x) || (x as number) <= 0)) errors.push(`${w}.accept.sizes: whole byte counts`);
      else sizes = acc.sizes as number[];
    }
    if (n.note !== undefined && (!str(n.note) || n.note.length > 500)) errors.push(`${w}.note: text up to 500 characters`);
    out.push({
      kind: (["bios", "firmware", "keys", "other"].includes(String(n.kind)) ? n.kind : "other") as NeedSlot["kind"], name: String(n.name ?? "").trim(), place: String(n.place ?? ""),
      ...(acc ? { accept: { ...(hashes.length ? { hashes } : {}), ...(sizes ? { sizes } : {}), ...(formats ? { formats } : {}) } } : {}),
      ...(n.build === true ? { build: true } : {}),
      ...(str(n.note) ? { note: n.note } : {}),
    });
  });
  return out;
}

function checkGlobs(list: unknown, where: string, errors: string[]): string[] {
  const out = checkStrings(list, where, errors, { max: 30, len: 260 });
  out.forEach((g, i) => { const e = safeRelPath(g, { glob: true }); if (e) errors.push(`${where}[${i}]: ${e}`); });
  return out;
}

/** a runtime plan as stored; `kind` is the plan's kind (it changes what the content may say) */
export function validatePlanSpec(input: unknown, kind: PlanKind): Checked<RuntimePlanSpec> {
  const errors: string[] = [], warnings: string[] = [];
  if (!PLAN_KINDS.includes(kind)) errors.push(`kind: one of ${PLAN_KINDS.join(", ")}`);
  if (!isObj(input)) return { ok: false, errors: ["the plan must be an object"], warnings, value: null };
  const s = input;
  const program = checkProgram(s.program, errors, warnings);
  let root = "";
  if (s.root !== undefined && s.root !== null && s.root !== "") { const e = safeRelPath(s.root); if (e) errors.push(`root: ${e}`); else root = String(s.root); }
  const content = checkContent(s.content, kind, errors, warnings);
  if (kind === "emulator" && !content) errors.push("content: an emulator plan says which platform's games it plays and where the game file goes");
  const tools = checkTools(s.tools, errors);
  // launch
  const l = isObj(s.launch) ? s.launch : null;
  if (!l) errors.push("launch: {exe, argv, cwd?, env?}");
  const exe = l && str(l.exe) ? l.exe : "";
  const exeErr = safeRelPath(exe);
  if (exeErr) errors.push(`launch.exe: ${exeErr}`);
  else if (/\.(bat|cmd|ps1|vbs|lnk)$/i.test(exe)) errors.push("launch.exe: v1 starts .exe files only (a script would run through a shell)");
  else if (!/\.exe$/i.test(exe)) errors.push("launch.exe: a Windows .exe inside the install folder");
  const argv = checkStrings(l?.argv, "launch.argv", errors, { max: 50, len: 1000 });
  const shipped = !!content && content.ship !== false;
  argv.forEach((a, i) => checkPlaceholders(a, shipped ? ["install", "content"] : ["install"], `launch.argv[${i}]`, errors));
  let cwd: string | undefined;
  if (l?.cwd !== undefined && l.cwd !== null && l.cwd !== "") { const e = safeRelPath(l.cwd); if (e) errors.push(`launch.cwd: ${e}`); else cwd = String(l.cwd); }
  let env: Record<string, string> | undefined;
  if (l?.env !== undefined && l.env !== null) {
    if (!isObj(l.env)) errors.push("launch.env: {NAME: value}");
    else {
      const ent = Object.entries(l.env);
      if (ent.length > 30) errors.push("launch.env: at most 30 variables");
      env = {};
      for (const [k, v] of ent) {
        if (!ENV_KEY.test(k)) errors.push(`launch.env: "${k}" is not a variable name`);
        if (!str(v) || v.length > 1000) { errors.push(`launch.env.${k}: text up to 1000 characters`); continue; }
        checkPlaceholders(v, ["install"], `launch.env.${k}`, errors);
        env[k] = v;
      }
    }
  }
  const files = checkFiles(s.files, "files", errors);
  const setup = checkSetup(s.setup, tools, content, errors);
  const needs = checkNeeds(s.needs, errors);
  const keep = checkGlobs(s.keep, "keep", errors), seed = checkGlobs(s.seed, "seed", errors);
  const portable = files.some(f => /^portable(\.txt|\.ini)?$/i.test(f.path.split("/").pop() ?? "")) || argv.some(a => /^-{1,2}portable$/i.test(a));
  if (portable && !keep.length) errors.push("keep: a portable program keeps saves in its install folder — list them (saves/**, *.json …) so updates and uninstalls keep them");
  // a game file that is not shipped is used on the server: a setup step, a source build or a per-game build reads it
  const perGame = program && (program.kind === "release" || program.kind === "url") ? program.perGame ?? null : null;
  const setupReads = setup.some(st => "run" in st && st.run.argv.some(a => placeholdersIn(a).includes("content")));
  const sourceReads = program?.kind === "source" && program.content === "build";
  if (content && content.ship === false && !setupReads && !sourceReads && !perGame)
    errors.push("content.ship: false means the file is used on the server and not shipped, but nothing uses it: a setup step with {content}, a source build that reads it (program.content build) or a per-game build (program.perGame)");
  if (program?.kind === "source" && program.content === "build" && !content) errors.push("program.content: build needs a content plan (the file the build uses)");
  if (perGame && !content) errors.push("program.perGame: builds the game from its file, so the plan needs a content plan");
  const privateNeeds = needs.filter(n => n.build);
  if (privateNeeds.length && !perGame) errors.push("needs.build: server build inputs require program.perGame");
  if (privateNeeds.length && !perGame?.steps.some(s => placeholdersIn(s).includes("needs"))) errors.push("needs.build: the kit must read its inputs through {needs}");
  if (perGame?.steps.some(s => placeholdersIn(s).includes("needs")) && !privateNeeds.length) errors.push("program.perGame.steps: {needs} requires at least one need with build: true");
  const privatePlaces = privateNeeds.map(n => n.place.toLowerCase());
  if (privatePlaces.some((p, i) => privatePlaces.some((q, j) => i !== j && (p === q || p.startsWith(q + "/"))))) errors.push("needs.build: input paths must not overlap");
  if (content?.make) makeToolProblems(content.make, tools, "content.make", errors);
  let firstRun: string | null = null;
  if (s.firstRun !== undefined && s.firstRun !== null) { if (!str(s.firstRun) || s.firstRun.length > 500) errors.push("firstRun: text up to 500 characters, or null"); else firstRun = s.firstRun.trim() || null; }
  let notes = "";
  if (s.notes !== undefined && s.notes !== null) { if (!str(s.notes) || s.notes.length > 4000) errors.push("notes: text up to 4000 characters"); else notes = s.notes; }
  const check = checkCheck(s.check, "check", tools, content, errors);
  const decisions = checkDecisions(s.decisions, errors);
  const value: RuntimePlanSpec | null = program && !errors.length ? {
    program, ...(root ? { root } : {}),
    launch: { exe, argv, ...(cwd ? { cwd } : {}), ...(env && Object.keys(env).length ? { env } : {}) },
    content, files, setup, ...(tools ? { tools } : {}), needs, keep, seed, firstRun, notes,
    ...(check ? { check } : {}), ...(decisions.length ? { decisions } : {}),
  } : null;
  return { ok: errors.length === 0, errors, warnings, value };
}

/** the scripts and shortcuts a plan's start may never name: a script runs through a shell, which reads its arguments as commands */
export const SCRIPT_EXT = /\.(bat|cmd|ps1|vbs|lnk|url)$/i;
/** the one kind of script a start may be: a Windows command script, and only when the admin sets it by hand on the game
 *  page (a game whose own script is how it starts: one that loads a driver first, sets the machine up, starts two programs).
 *  Never a plan's start, never one ludarr or the AI importer picks */
export const START_SCRIPT = /\.(bat|cmd)$/i;
/** what an argument handed to such a script may hold: the command shell reads everything else as its own (a space ends an
 *  argument, % expands a variable, & starts another command), so nothing else is ever handed to it */
export const SCRIPT_ARG = /^[A-Za-z0-9_.,:=+/\\@-]+$/;
export const SCRIPT_ARG_WORDS = "a script's arguments pass through the Windows command shell, so each one is letters, digits and . _ - + = , : / \\ @ only (no space, no quote, no %, no &, no {install})";
/** the variable the launcher hands a start script's own path in: never one of the game's */
export const SCRIPT_VAR = "AHOY_START";

/**
 * The shape of a start set by hand (src/ways/types.ts LaunchChoice), wherever it is stored: a way's overrides.launch or
 * games.launch_json. The program a relative .exe path (no script, no shortcut); at most 50 arguments of up to 1000
 * characters with {install} (and {content} where `content` says the game file ships); the working folder absent, the
 * game's folder ({install}), {install}/<folder> or <folder>; at most 30 variables with {install} in their values; `paths`
 * (the files of the copy it named when it was set) at most 100 paths inside the game's folder; `at` when it was set.
 * Whether the files are in the copy is src/library/launch.ts's to check, against the copy itself.
 */
export function checkLaunchChoice(input: unknown, where: string, o: { content: boolean }, errors: string[]): LaunchChoice | null {
  if (!isObj(input)) { errors.push(`${where}: {exe, argv, cwd?, env?, at}`); return null; }
  const before = errors.length;
  const exe = str(input.exe) ? input.exe : "";
  const exeErr = safeRelPath(exe);
  if (exeErr) errors.push(`${where}.exe: ${exeErr}`);
  else if (SCRIPT_EXT.test(exe) && !START_SCRIPT.test(exe)) errors.push(`${where}.exe: Ahoy starts programs and Windows command scripts (.bat, .cmd), no other script and no shortcut`);
  else if (!/\.(exe|bat|cmd)$/i.test(exe)) errors.push(`${where}.exe: a Windows .exe (or a .bat or .cmd script) inside the game's folder`);
  const script = !exeErr && START_SCRIPT.test(exe);
  const argv = checkStrings(input.argv, `${where}.argv`, errors, { max: 50, len: 1000 });
  argv.forEach((a, i) => {
    if (a.includes("\0")) errors.push(`${where}.argv[${i}]: holds a NUL character`);
    else if (script) { if (!SCRIPT_ARG.test(a)) errors.push(`${where}.argv[${i}]: ${SCRIPT_ARG_WORDS}`); }
    else checkPlaceholders(a, o.content ? ["install", "content"] : ["install"], `${where}.argv[${i}]`, errors);
  });
  let cwd: string | undefined;
  if (input.cwd !== undefined && input.cwd !== null && input.cwd !== "") {
    if (!str(input.cwd)) errors.push(`${where}.cwd: a folder of the game`);
    else if (input.cwd !== "{install}") {
      const rel = input.cwd.startsWith("{install}/") ? input.cwd.slice("{install}/".length) : input.cwd;
      const e = placeholdersIn(rel).length ? "may hold {install} only at its start" : safeRelPath(rel);
      if (e) errors.push(`${where}.cwd: ${e}`);
      else cwd = input.cwd;
    } else cwd = input.cwd;
  }
  let env: Record<string, string> | undefined;
  if (input.env !== undefined && input.env !== null) {
    if (!isObj(input.env)) errors.push(`${where}.env: {NAME: value}`);
    else {
      const ent = Object.entries(input.env);
      if (ent.length > 30) errors.push(`${where}.env: at most 30 variables`);
      env = {};
      for (const [k, v] of ent) {
        if (!ENV_KEY.test(k)) errors.push(`${where}.env: "${k}" is not a variable name`);
        else if (script && k.toUpperCase() === SCRIPT_VAR) errors.push(`${where}.env: ${SCRIPT_VAR} is the launcher's own for a script (the script's path)`);
        else if (!str(v) || v.length > 1000 || v.includes("\0")) errors.push(`${where}.env.${k}: text up to 1000 characters`);
        else { checkPlaceholders(v, ["install"], `${where}.env.${k}`, errors); env[k] = v; }
      }
    }
  }
  let paths: string[] | undefined;
  if (input.paths !== undefined && input.paths !== null) {
    if (!Array.isArray(input.paths) || input.paths.length > 100 || input.paths.some(p => !str(p) || !!safeRelPath(p))) errors.push(`${where}.paths: the files and folders of the copy it names, as paths inside the game's folder`);
    else paths = [...new Set(input.paths as string[])];
  }
  const at = typeof input.at === "number" && Number.isFinite(input.at) && input.at > 0 ? input.at : 0;
  if (!at) errors.push(`${where}.at: when it was set (ms)`);
  if (errors.length > before) return null;
  return { exe, argv, ...(cwd ? { cwd } : {}), ...(env && Object.keys(env).length ? { env } : {}), ...(paths?.length ? { paths } : {}), at };
}

/** per-game additions on a way, checked against its plan: files, extra launch arguments, environment, its own check (in
 *  place of the plan's) and setup steps (after the plan's). `launch` (the start set by hand) is the admin's: it is taken
 *  only with `admin` (the game page's route, src/library/launch.ts), and refused from anyone else (an AI round, a way added) */
export function validateWayOverrides(input: unknown, spec: RuntimePlanSpec, o: { admin?: boolean } = {}): Checked<WayOverrides> {
  const errors: string[] = [], warnings: string[] = [];
  if (input === undefined || input === null) return { ok: true, errors, warnings, value: {} };
  if (!isObj(input)) return { ok: false, errors: ["overrides: {files?, argvExtra?, env?, check?, setup?}"], warnings, value: null };
  let launch: LaunchChoice | null = null;
  if (input.launch !== undefined && input.launch !== null) {
    if (!o.admin) errors.push("overrides.launch: how the game starts is set by hand on the game page (Starts with), not here");
    else launch = checkLaunchChoice(input.launch, "overrides.launch", { content: !!spec.content && spec.content.ship !== false }, errors);
  }
  const files = checkFiles(input.files, "overrides.files", errors);
  const argvExtra = checkStrings(input.argvExtra, "overrides.argvExtra", errors, { max: 20, len: 1000 });
  const shipped = !!spec.content && spec.content.ship !== false;
  argvExtra.forEach((a, i) => checkPlaceholders(a, shipped ? ["install", "content"] : ["install"], `overrides.argvExtra[${i}]`, errors));
  let env: Record<string, string> | undefined;
  if (input.env !== undefined && input.env !== null) {
    if (!isObj(input.env)) errors.push("overrides.env: {NAME: value}");
    else {
      env = {};
      for (const [k, v] of Object.entries(input.env)) {
        if (!ENV_KEY.test(k)) errors.push(`overrides.env: "${k}" is not a variable name`);
        else if (!str(v) || v.length > 1000) errors.push(`overrides.env.${k}: text up to 1000 characters`);
        else { checkPlaceholders(v, ["install"], `overrides.env.${k}`, errors); env[k] = v; }
      }
    }
  }
  const check = checkCheck(input.check, "overrides.check", spec.tools ?? null, spec.content, errors);
  const setup = checkSetup(input.setup, spec.tools ?? null, spec.content, errors, "overrides.setup");
  const value: WayOverrides = {
    ...(files.length ? { files } : {}), ...(argvExtra.length ? { argvExtra } : {}), ...(env && Object.keys(env).length ? { env } : {}),
    ...(check ? { check } : {}), ...(setup.length ? { setup } : {}), ...(launch ? { launch } : {}),
  };
  return { ok: errors.length === 0, errors, warnings, value: errors.length ? null : value };
}

/** a way's own content plan: the plan's (recomp/port) or one made for this game (emulator), checked the same way; `tools`
 *  (the plan's) when known, so a make's run step can only name a tool the plan builds */
export function validateWayContent(input: unknown, kind: PlanKind, o: { tools?: ToolBuild | null } = {}): Checked<ContentPlan> {
  const errors: string[] = [], warnings: string[] = [];
  // a way's content may carry hashes even for an emulator plan: they are this game's
  const c = checkContent(input, kind === "emulator" ? "port" : kind, errors, warnings, "content");
  if (c?.make && o.tools !== undefined) makeToolProblems(c.make, o.tools, "content.make", errors);
  return { ok: errors.length === 0, errors, warnings, value: errors.length ? null : c };
}

/* ─────────── what a new content plan accepts, and whether the program says so ─────────── */

/** a version as numbers: leading zeros and trailing zero parts dropped ("01.007.000" = "1.07" = "1.7") */
export function versionKey(v: string): string {
  const parts = String(v).trim().split(".").map(p => (/^\d+$/.test(p) ? String(Number(p)) : p.toLowerCase()));
  while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
  return parts.join(".");
}
/** a serial in the form compared: upper case, no separators ("ppsa-01341" = "PPSA01341") */
const serialKey = (s: string) => s.toUpperCase().replace(/[-_.\s]/g, "");

/** one way a new content plan accepts more than the old one: values added to a list, a list emptied (= anything), another
 *  category, a make input that takes more forms, or a weaker check that the data is the whole game (field "complete" or
 *  "make.input.complete": added says what was weakened, emptied that the check is gone) */
export interface AcceptChange { field: string; added: string[]; emptied: boolean }
type Lists = { serials?: string[]; versions?: string[]; builds?: string[]; hashes?: AcceptHash[]; regions?: string[]; formats?: string[] };
const LIST_RULES: { name: keyof Lists; noun: string; key: (v: string) => string; covers?: (prev: string, next: string) => boolean }[] = [
  { name: "serials", noun: "serial", key: serialKey },
  { name: "versions", noun: "version", key: versionKey },
  // an accepted build id is a prefix: a longer one under it accepts less, a shorter one more
  { name: "builds", noun: "build", key: v => v.toLowerCase(), covers: (p, n) => n.startsWith(p) },
  { name: "hashes", noun: "hash", key: v => v.toLowerCase() },
  { name: "regions", noun: "region", key: v => (regionKey(v) ?? v).toUpperCase() },
  { name: "formats", noun: "format", key: v => v.toLowerCase().replace(/^\./, "") },
];
const NOUN: Record<string, string> = Object.fromEntries(LIST_RULES.map(r => [r.name, r.noun]));
/** a list's values; a hash as algo:value, so the same digits in another algorithm are another value */
const valuesOf = (l: Lists | null, name: keyof Lists): string[] => {
  const v = l?.[name];
  if (!Array.isArray(v)) return [];
  return name === "hashes" ? (v as AcceptHash[]).map(h => `${h.algo}:${String(h.value).toLowerCase()}`) : (v as string[]).map(String);
};

/** prev null: nothing was accepted before, so every value next lists is new; an empty list accepts anything, so a list
 *  that had values and has none now is emptied, and values listed where there were none only narrow it. skip: lists that
 *  say nothing here (a folder has no file formats) */
function listChanges(prefix: string, prev: Lists | null, next: Lists, fresh: boolean, out: AcceptChange[], skip: (keyof Lists)[] = []) {
  for (const r of LIST_RULES) {
    if (skip.includes(r.name)) continue;
    const field = `${prefix}.${r.name}`;
    const shown = (v: string) => (r.name === "hashes" ? v.slice(v.indexOf(":") + 1) : v);
    const N = valuesOf(next, r.name);
    if (fresh) { if (N.length) out.push({ field, added: uniq(N.map(shown)), emptied: false }); continue; }
    const P = valuesOf(prev, r.name);
    if (!P.length) continue;
    if (!N.length) { out.push({ field, added: [], emptied: true }); continue; }
    const pk = P.map(r.key);
    const added = N.filter(v => { const k = r.key(v); return !pk.some(p => (r.covers ? r.covers(p, k) : p === k)); });
    if (added.length) out.push({ field, added: uniq(added.map(shown)), emptied: false });
  }
}
function categoryChange(field: string, prev: string | undefined, next: string | undefined, fresh: boolean, out: AcceptChange[]) {
  const n = next ?? "game";
  if (fresh ? n !== "game" : n !== (prev ?? "game")) out.push({ field, added: [n], emptied: false });
}
const shapesOf = (s: MakeInput["shape"]): string[] => (s === "either" ? ["file", "folder"] : [s]);

/** a new make's input against what the plan accepted: its serials, versions and regions beyond the plan's are new (a list
 *  the plan left empty took any value, and a list the input leaves out leaves the product's own check in charge); every
 *  format it takes is a new form */
function newMakeChanges(accept: Lists | null, ni: MakeInput, out: AcceptChange[]) {
  for (const r of LIST_RULES) {
    const field = `make.input.${r.name}`;
    const N = valuesOf(ni, r.name);
    if (!N.length) continue;
    if (r.name === "formats") { out.push({ field, added: uniq(N), emptied: false }); continue; }
    const P = valuesOf(accept, r.name);
    if (!P.length) continue;
    const pk = P.map(r.key);
    const added = N.filter(v => !pk.includes(r.key(v)));
    if (added.length) out.push({ field, added: uniq(added), emptied: false });
  }
}

/** the check that the data is the whole game, weaker in `next` than in `prev`: gone (emptied), or the bounds it lowered */
function completeChange(field: string, prev: Completeness | undefined, next: Completeness | undefined, out: AcceptChange[]) {
  if (!prev) return;
  if (!next) { out.push({ field, added: [], emptied: true }); return; }
  const weaker: string[] = [];
  for (const k of ["minBytes", "minFiles"] as const) {
    const p = prev[k] ?? 0, n = next[k] ?? 0;
    if (n < p) weaker.push(`${k} ${p} → ${n}`);
  }
  const share = (l: Completeness["list"]) => l?.share ?? 0.98;
  if (prev.list && !next.list) weaker.push(`no file list (was ${prev.list.path})`);
  else if (prev.list && next.list && share(next.list) < share(prev.list)) weaker.push(`list share ${share(prev.list)} → ${share(next.list)}`);
  if (weaker.length) out.push({ field, added: weaker, emptied: false });
}

/**
 * What `next` accepts that `prev` did not: values added to its serials, versions, builds, hashes (any algorithm), regions
 * and formats; a list that had values and is now empty or absent (= any); a changed category; a weaker check that the data
 * is the whole game; and the same over make.input, where a shape that takes more forms (file or folder → either) counts
 * too. prev null (a fresh plan): every value next lists. A make that is new is compared with what the plan accepted (its
 * serials, versions and regions beyond the plan's; every format it takes); its shape is a form, not a widening. A list
 * shortened, but not emptied, only narrows; formats say nothing of a folder.
 */
export function acceptChanges(prev: ContentPlan | null, next: ContentPlan): AcceptChange[] {
  const out: AcceptChange[] = [];
  listChanges("accept", prev?.accept ?? null, next.accept, !prev, out, next.kind === "folder" ? ["formats"] : []);
  categoryChange("accept.category", prev?.accept?.category, next.accept.category, !prev, out);
  // a game folder's check may move to the make that packs it (folder → one made file): it is then checked there
  if (prev) completeChange("complete", prev.complete, next.complete ?? next.make?.input.complete, out);
  const pi = prev?.make?.input ?? null, ni = next.make?.input ?? null;
  if (ni && !prev) {
    listChanges("make.input", null, ni, true, out);
    categoryChange("make.input.category", undefined, ni.category, true, out);
  } else if (ni && !pi) {
    newMakeChanges(prev?.accept ?? null, ni, out);
    categoryChange("make.input.category", prev?.accept?.category, ni.category, false, out);
  } else if (ni && pi) {
    listChanges("make.input", pi, ni, false, out, ni.shape === "folder" ? ["formats"] : []);
    categoryChange("make.input.category", pi.category, ni.category, false, out);
    const added = shapesOf(ni.shape).filter(s => !shapesOf(pi.shape).includes(s));
    if (added.length) out.push({ field: "make.input.shape", added, emptied: false });
    completeChange("make.input.complete", pi.complete, ni.complete, out);
  }
  return out;
}

/** a cited value names `value`: the same text without regard to case (a version by number, a serial without separators, a
 *  region by any of its spellings, a format with or without its dot) */
function cites(list: string, cited: string, value: string): boolean {
  const a = cited.trim().toLowerCase(), b = value.trim().toLowerCase();
  if (a === b) return true;
  if (list === "versions") return versionKey(a) === versionKey(b);
  if (list === "serials") return serialKey(a) === serialKey(b);
  if (list === "regions") { const k = regionKey(a); return !!k && k === regionKey(b); }
  if (list === "formats") return a.replace(/^\./, "") === b.replace(/^\./, "");
  if (list === "hashes") return a.replace(/^0x/, "") === b;
  return false;
}

/** the forms a make's input may come in: ludarr's own archiver opens them and no program's code names them, so they need
 *  no evidence (the input and then the product are judged by their own data before anything is taken) */
const FORM_FIELDS = new Set(["make.input.formats", "make.input.shape"]);

/**
 * What keeps a new content plan from being saved: each value it accepts that the old one did not must be among the values
 * of some evidence entry of the new plan (the construct job then reads each cited file at its commit), except the forms a
 * make's input comes in; a list emptied (= any) and a weaker check that the data is the whole game always need the admin.
 * Empty when nothing is wrong.
 */
export function evidenceProblems(prev: ContentPlan | null, next: ContentPlan): string[] {
  const cited = (next.accept?.evidence ?? []).flatMap(e => e.values ?? []);
  const problems: string[] = [];
  for (const ch of acceptChanges(prev, next)) {
    const list = ch.field.slice(ch.field.lastIndexOf(".") + 1);
    if (list === "complete") {
      problems.push(`${ch.field}: ${ch.emptied ? "the check that the data is the whole game was removed" : `the check that the data is the whole game is weaker (${ch.added.join(", ")})`}, so an update or a part of the game would pass: that needs the admin: ask with a choice`);
      continue;
    }
    if (ch.emptied) { problems.push(`${ch.field}: accepting any ${NOUN[list] ?? list} needs the admin: ask with a choice`); continue; }
    if (FORM_FIELDS.has(ch.field)) continue;
    for (const v of ch.added) if (!cited.some(c => cites(list, c, v))) problems.push(`${ch.field}: ${v} was added without evidence — cite the repo file and lines that name it`);
  }
  return problems;
}

/** why a recomp's or port's content plan proves nothing (no hash, serial or build id to tell its file by), or null; an
 *  emulator plays any game of its platform, so its plan is never asked */
export function provingProblem(spec: Pick<RuntimePlanSpec, "content">, kind: PlanKind): string | null {
  const c = spec.content;
  if (kind === "emulator" || !c) return null;
  if (c.accept.hashes.length || (c.accept.serials ?? []).length || (c.accept.builds ?? []).length) return null;
  return "content.accept: nothing proves the game file — a recomp or port keeps at least one of hashes, serials and builds (a wrong game is far worse than none)";
}

/* ─────────── a plan that builds the game on the player's PC ─────────── */

const MAKES_GAME = /\b(build|builds|built|building|compile|compiles|compiled|compiling|recompile[sd]?|recompiling|lifts?|lifted|lifting)\b/gi;
const GETS_TOOLS = /\b(download|downloads|downloaded|downloading|fetch|fetches|fetched|fetching|install|installs|installed|installing)\b.*\b(tools?|toolchains?|compilers?|sdks?|msys2|mingw|clang|llvm)\b|\b(tools?|toolchains?|compilers?|sdks?|msys2)\b.*\b(downloaded|fetched|installed)\b/i;
const PLAYER_SIDE = /\b(player'?s|players'|user'?s|your|their)\s+(own\s+)?(pc|computer|machine|system)\b|\b(on|at|during)\s+(the\s+)?(first|initial)\s+(start|run|launch|boot)\b|\bfirst[- ](start|run|launch)\b|\blocally\b/i;
/** the words just before the verb say it does not happen ("nothing is built", "never compiled", "isn't built", "cannot be
 *  built") */
const NEGATED = /\b(never|not|cannot|no longer|nothing|without)\s+(\S+\s+){0,2}$|n't\s+(\S+\s+){0,2}$/i;
const SERVER_SIDE = /\b(on|by)\s+(the|this|ludarr'?s)\s+server\b/i;
const SHADERS = /\bshaders?\b|\bpipeline caches?\b/i;
/** where a clause ends: a verb's object is looked for inside its own clause */
const CLAUSE = /[,;:()—–]/;
/** what is the game itself (or its program), not its shaders */
const GAME_THING = /\b(game|games|program|binary|binaries|executable|exe|port|recomp|code|engine)\b/i;
/** a clause that starts by pointing back at what the sentence named before ("they cannot be built") */
const POINTS_BACK = /^\s*(they|these|those|it|this|which|both)\b/i;
/** where the last shader (or pipeline cache) word in `s` starts, or -1 */
const lastShaders = (s: string): number => { let at = -1; for (const m of s.matchAll(new RegExp(SHADERS.source, "gi"))) at = m.index!; return at; };
/**
 * The verb at `at` is about the shaders (or a pipeline cache): one of them is within three words of it in its clause
 * ("compiles shaders", "the shaders are compiled"); or they are the clause's subject, named before the verb with nothing of
 * the game after them ("Shader caches are per GPU and are compiled on first run"); or the clause points back at them ("…
 * made on the player's PC — they cannot be built at package time"). "builds the game and its shaders" and "Shaders and the
 * game are compiled" still make the game.
 */
function aboutShaders(s: string, at: number, len: number): boolean {
  const clauses = s.slice(0, at).split(CLAUSE);
  const own = clauses.pop() ?? "";
  const before = own.trim().split(/\s+/).slice(-3).join(" ");
  const after = (s.slice(at + len).split(CLAUSE)[0] ?? "").trim().split(/\s+/).slice(0, 3).join(" ");
  if (SHADERS.test(before) || SHADERS.test(after)) return true;
  const subject = lastShaders(own);
  if (subject >= 0 && !GAME_THING.test(own.slice(subject))) return true;
  if (POINTS_BACK.test(own)) {
    const earlier = clauses.join(" ");
    const named = lastShaders(earlier);
    if (named >= 0 && !GAME_THING.test(earlier.slice(named))) return true;
  }
  return false;
}

/**
 * Why the plan makes the game on the player's PC — its first start (firstRun) builds, compiles or fetches build tools, or
 * its notes say so of the player's PC — or null. A carry run then asks the AI once to move that build to the server.
 */
export function firstRunOnPlayersPc(spec: Pick<RuntimePlanSpec, "firstRun" | "notes">): string | null {
  const said = (field: "firstRun" | "notes", text: string | null | undefined): string | null => {
    for (const raw of String(text ?? "").split(/(?<=[.!?;])\s+|\n+/)) {
      const s = raw.trim();
      if (!s || SERVER_SIDE.test(s)) continue;
      // every build or compile verb in the sentence: one that is not about the shaders and not negated makes the game
      const making = [...s.matchAll(MAKES_GAME)].some(m => !aboutShaders(s, m.index!, m[0].length) && !NEGATED.test(s.slice(0, m.index)));
      const at = s.search(GETS_TOOLS);
      const tools = at >= 0 && !NEGATED.test(s.slice(0, at));
      if (!making && !tools) continue;
      // the first start is the player's by definition; notes must say where
      if (field === "notes" && !PLAYER_SIDE.test(s)) continue;
      return `${field} says the game is made on the player's PC: "${s.length > 200 ? `${s.slice(0, 199)}…` : s}"`;
    }
    return null;
  };
  return said("firstRun", spec.firstRun) ?? said("notes", spec.notes);
}

/* ─────────── manual games ─────────── */

/** a game described by hand (or drafted by the AI) for a manual add or an edit of its details */
export function validateGameDraft(input: unknown, opts: { partial?: boolean } = {}): Checked<Partial<GameDraft>> {
  const errors: string[] = [], warnings: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["the game must be an object"], warnings, value: null };
  const d = input, out: Partial<GameDraft> = {};
  const has = (k: string) => d[k] !== undefined;
  if (has("name") || !opts.partial) {
    const name = str(d.name) ? d.name.trim().replace(/\s+/g, " ") : "";
    if (!name) errors.push("name: the game's name");
    else if (name.length > 200) errors.push("name: up to 200 characters");
    else out.name = name;
  }
  if (has("aliases")) {
    const al = checkStrings(d.aliases, "aliases", errors, { max: 5, len: 200 });
    const seen = new Set<string>([(out.name ?? "").toLowerCase()]);
    out.aliases = al.filter(a => { const k = a.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (has("searchTerms")) out.searchTerms = checkStrings(d.searchTerms, "searchTerms", errors, { max: 3, len: 120 });
  if (has("platforms")) {
    const raw = checkStrings(d.platforms, "platforms", errors, { max: 10, len: 40 });
    const ids: PlatformId[] = [];
    for (const p of raw) { const id = platformId(p); if (!id) errors.push(`platforms: "${p}" is not a platform ludarr knows`); else if (!ids.includes(id)) ids.push(id); }
    out.platforms = ids;
  }
  if (has("year")) {
    if (d.year === null || d.year === "") out.year = null;
    else { const y = Number(d.year); if (!Number.isInteger(y) || y < 1970 || y > 2100) errors.push("year: a year between 1970 and 2100"); else out.year = y; }
  }
  if (has("releaseIso")) {
    if (d.releaseIso === null || d.releaseIso === "") out.releaseIso = null;
    else if (!str(d.releaseIso) || !/^\d{4}-\d{2}-\d{2}$/.test(d.releaseIso) || Number.isNaN(Date.parse(d.releaseIso))) errors.push("releaseIso: a date as YYYY-MM-DD");
    else out.releaseIso = d.releaseIso;
  }
  if (has("summary")) {
    if (d.summary === null || d.summary === "") out.summary = null;
    else if (!str(d.summary) || d.summary.length > 4000) errors.push("summary: text up to 4000 characters");
    else out.summary = d.summary.trim();
  }
  if (has("genres")) out.genres = checkStrings(d.genres, "genres", errors, { max: 12, len: 60 });
  for (const k of ["developer", "publisher"] as const) {
    if (!has(k)) continue;
    if (d[k] === null || d[k] === "") out[k] = null;
    else if (!str(d[k]) || (d[k] as string).length > 200) errors.push(`${k}: text up to 200 characters`);
    else out[k] = (d[k] as string).trim();
  }
  return { ok: errors.length === 0, errors, warnings, value: errors.length ? null : out };
}
