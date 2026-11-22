/**
 * ludarr — is this folder a game as it would sit on disk after a normal install?
 * Judges both tiers' output the same way, picks the launch executable, lists prerequisites,
 * and builds the manifest (per-file sha256) the launcher will trust. A file whose sha256 is already known (a hard link
 * ludarr placed from the content store, a copy it hashed as it wrote it) is not read again while its stat is exactly
 * the one taken right after it was placed: the same size, both times, the device and the inode (a 55 GB game file is
 * hashed once, when it is taken in, never again for every package built from it).
 */
import { lstat, open, readdir } from "node:fs/promises";
import { ROM_EXT, ROM_MARKER } from "../platforms";
import { serverPathInFile } from "./portability";
import { fileChunks } from "../fsutil";
import { BlockHasher } from "../blocks";
import { basename, join, posix } from "node:path";
import { CRACK_DIR, notDiscImages, packagingImages, scan, unrunInstaller, type FileInfo } from "./classify";
import { peInfo, type PeInfo } from "../library/pe";

export interface ManifestFile { path: string; size: number; sha256: string }
export interface Prerequisite { kind: string; path: string; args: string }
export interface Manifest {
  schema: 1;
  name: string;
  slug: string;
  version: string | null;
  /** argv (when present) is used as is by launchers that list the 'argv' feature; `{install}` in argv, cwd and env values is
   *  the absolute install folder. args stays the space-joined form for older launchers ('' when that would be wrong).
   *  rev: when the start was last set or reset by hand (ms, src/library/launch.ts): an opaque stamp, never shown to players */
  launch: { exe: string; args: string; cwd: string; argv?: string[]; env?: Record<string, string>; rev?: number };
  prerequisites: Prerequisite[];
  files: ManifestFile[];
  totalSize: number;
  source: { title: string; group: string | null; protocol: string | null; indexer: string | null } | null;
  tier: "deterministic" | "agent";
  /** "rom": a console dump — `launch.exe` is then the image / package / dump folder marker, for whatever runs it;
   *  "recomp" | "port" | "emulated": a way built from a runtime plan (src/ways), started by launch.exe with launch.argv */
  kind?: "native" | "rom" | "recomp" | "port" | "emulated";
  platform?: string | null;
  /** the oldest launcher that can install and start it (semver) */
  requires?: { launcher: string };
  /** globs the launcher keeps across updates and uninstalls (saves), and files it ships once and never resets (settings) */
  keep?: string[];
  seed?: string[];
  notes: string | null;
  createdAt: string;
}
export interface Validation {
  ok: boolean;
  root: string;                 // the game folder (after unwrapping single-folder nesting)
  problems: string[];
  exeCandidates: string[];         // the programs that may start the game, the likeliest first
  launch: string | null;
  /** why that program, in the admin's words (the job's log): the engine's program, the game's name, what the importer named */
  launchWhy?: string | null;
  prerequisites: Prerequisite[];
  totalSize: number;
  fileCount: number;
}

/** archives a copy is never left with: what they hold was to be unpacked */
const LEFT_ARCHIVE = /\.(rar|7z|part\d+\.rar|r\d\d|001)$/i;
/** disc images, by their name */
const DISC_IMAGE = /\.(iso|mdf|nrg|img)$/i;
/** names and folders of programs that are not the game (installers, redistributables, crash reporters, tools, the helpers an
 *  engine ships beside the game): never picked by ludarr, unless the copy's layout says the program is the engine's own (a
 *  Unity player named Crash….exe beside its Crash…_Data folder; a known helper, below, never is), and listed last, dimmed,
 *  in the admin's picker (src/library/launch.ts) */
export const NOT_LAUNCH_NAME = /unins|uninst|setup|install|redist|vcredist|vc_redist|dxsetup|dxwebsetup|directx|dotnet|ndp\d|crash|report|bugsplat|unitycrashhandler|oalinst|physx|launcher_helper|updater|update\.exe|cefsharp|ue4prereq|ue5prereq|prereq|helper|service|server\.exe|dedicated|benchmark|config\.exe|configtool|settings\.exe|editor\.exe|tools?\.exe|dxdiag|nwjc|chromedriver|easyanticheat|^squirrel\.exe$|qtwebengineprocess|^elevate\.exe$|^pythonw?[\d.]*\.exe$|^javaw?\.exe$|^zsync|^aria2c|^7z[a-z]{0,2}\.exe$|^autorun\.exe$|^instmsi[aw]?\.exe$|^wextract\.exe$/i;
export const NOT_LAUNCH_DIR = /(^|\/)(redist|_commonredist|commonredist|directx|vcredist|support|__support|__installer|installers?|prereqs?|prerequisites|dependencies|_redist|__redist|redistributables|engine\/extras|tools|sdk|docs?|manual|jre|runtime\/bin)(\/|$)/i;
/** a program in a folder that holds a group's crack ("Crack/rld-ra3k.exe", "RUNE/Game.exe"): what goes over the installed game,
 *  never what starts it — a disc whose installer was never run has nothing else (Red Alert 3, 2026-11-07) */
const inCrackDir = (rel: string) => rel.split("/").slice(0, -1).some(d => CRACK_DIR.test(d));
const PREREQ_DIR = /(^|\/)(redist|_commonredist|commonredist|directx|vcredist|support|__installer|prereqs?|prerequisites|dependencies|_redist|__redist|redistributables)(\/|$)/i;

export function prereqKind(name: string): { kind: string; args: string } | null {
  const n = name.toLowerCase();
  if (/vc_?redist|vcredist|msvc/.test(n)) return { kind: "vcredist", args: "/quiet /norestart" };
  if (/dxsetup|dxwebsetup|directx/.test(n)) return { kind: "directx", args: "/silent" };
  if (/dotnet|ndp\d|netfx|windowsdesktop-runtime/.test(n)) return { kind: "dotnet", args: "/q /norestart" };
  if (/physx/.test(n)) return { kind: "physx", args: "/s" };
  if (/oalinst|openal/.test(n)) return { kind: "openal", args: "/s" };
  if (/ue4prereq|ue5prereq|ueprereq/.test(n)) return { kind: "unreal-prereq", args: "/quiet /norestart" };
  if (/xna/.test(n)) return { kind: "xna", args: "/quiet" };
  if (/\.msi$/.test(n)) return { kind: "msi", args: "/qn /norestart" };
  return null;
}

/** a folder holding nothing but one sub-folder is just packaging; descend. Only into a folder that is really there: a
 *  link to one is no game folder (what it points at would be validated, and the link itself moved into the library) */
export async function unwrapRoot(dir: string): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const real = entries.filter(n => !/^(\.|__macosx|thumbs\.db|desktop\.ini)/i.test(n));
    if (real.length !== 1) return dir;
    const only = join(dir, real[0]);
    if (!(await lstat(only)).isDirectory()) return dir;
    dir = only;
  }
  return dir;
}

/* ─────────── the program that starts the game ─────────── */

/** programs that are never the game, whatever the copy looks like: by the file's name or by the name its own header gives it
 *  (OriginalFilename, InternalName), compared lower-case without spaces or punctuation (VC_redist.x64.exe → vcredistx64) */
const HELPER_KEY = /^nwjc|chromedriver|notificationhelper|crashpadhandler|unitycrashhandler|crashreportclient|easyanticheat|qtwebengineprocess|cefsharpbrowsersubprocess|unrealcefsubprocess|^unins|vcredist|scriptinterpreter|^dxsetup|^dxwebsetup|^ue\d?prereq|^beservice|^zsync|^aria2c|^setup|^install|^instmsi|^(update|elevate|squirrel|autorun|wextract|javaw?|pythonw?\d*|7z[a-z]{0,2})$/;
/** … or by what its header says it is (FileDescription, ProductName): a disc's autorun menu ("Autorun program", which offers to
 *  install), a Java runtime's program ("OpenJDK Platform binary", "Java(TM) Platform SE binary") */
const HELPER_SAYS = /crash ?(handler|report)|error report|anti[- ]?cheat|redistributable|uninstall|prerequisites|autorun program|platform (se )?binary/i;
const keyOf = (s: string) => s.toLowerCase().replace(/\.(exe|dll)$/, "").replace(/[^a-z0-9]+/g, "");
/** how many programs' headers an import reads (the shallowest first); one past it ranks as a program whose header is unread */
const PE_READS = 1000;

/** a program's header as src/library/pe.ts reads it; undefined when it was not read */
export type PeOf = (rel: string) => PeInfo | undefined;

function knownHelper(rel: string, pe: PeInfo | undefined): boolean {
  const v = pe?.version ?? {};
  return [basename(rel), v.OriginalFilename, v.InternalName].some(n => !!n && HELPER_KEY.test(keyOf(n)))
    || [v.FileDescription, v.ProductName].some(t => !!t && HELPER_SAYS.test(t));
}

/** words of a name: case, accents, ™ ® © and apostrophes dropped (MARVEL Tōkon → marvel tokon, Queen's → queens) */
const words = (s: string) =>
  s.replace(/[™®©]/g, " ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(t => t.length > 1);
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };
/** the numbers of a name, as an entry of a series is told by them ("Red Alert 3", "Hades II"): one or two digits, a roman
 *  numeral of two letters or more; a version ("v1.0.3", "1.012") and a year are not */
const numbersOf = (s: string) => new Set(s.toLowerCase().replace(/\bv?\d+(?:\.\d+)+\b/g, " ").split(/[^a-z0-9]+/).map(t => ROMAN[t] ?? t).filter(t => /^\d{1,2}$/.test(t)).map(t => String(Number(t))));

/** the copy's files and folders, lower-case, and each folder's file names: what its layout is read from */
interface Layout { files: Set<string>; dirs: Set<string>; inDir: Map<string, string[]> }
function layoutOf(files: FileInfo[]): Layout {
  const L: Layout = { files: new Set(), dirs: new Set(), inDir: new Map() };
  for (const f of files) {
    const r = f.rel.toLowerCase(), cut = r.lastIndexOf("/"), dir = cut < 0 ? "" : r.slice(0, cut);
    L.files.add(r);
    const names = L.inDir.get(dir);
    if (names) names.push(r.slice(cut + 1)); else L.inDir.set(dir, [r.slice(cut + 1)]);
    for (let i = r.indexOf("/"); i >= 0; i = r.indexOf("/", i + 1)) L.dirs.add(r.slice(0, i));
  }
  return L;
}

interface Engine { tier: 1 | 2; engine: string; by: string }
/**
 * The engine whose own program this is, read from the copy's layout and the program's header: tier 2 is an Unreal game's
 * program at the top of the copy (it starts the build under <Name>/Binaries), tier 1 the program of an engine; null for none.
 */
function engineOf(rel: string, pe: PeInfo | undefined, L: Layout): Engine | null {
  const r = rel.toLowerCase(), cut = r.lastIndexOf("/"), dir = cut < 0 ? "" : r.slice(0, cut);
  const stem = r.slice(cut + 1).replace(/\.exe$/, ""), Stem = basename(rel).replace(/\.exe$/i, "");
  const at = (n: string) => (dir ? `${dir}/${n}` : n);
  const v = pe?.version ?? {}, orig = (v.OriginalFilename ?? "").toLowerCase();
  const said = `${v.FileDescription ?? ""} ${v.ProductName ?? ""}`;
  const beside = (...names: string[]) => names.some(n => L.files.has(at(n)));
  // Unreal: <Name>.exe at the top beside <Name>/Binaries (or the engine's bootstrap, by its header) over the build it starts
  if (stem !== "engine" && L.dirs.has(at(`${stem}/binaries`))) return { tier: 2, engine: "Unreal", by: `it starts ${Stem}/Binaries` };
  if (/^bootstrappackagedgame/.test(orig)) return { tier: 2, engine: "Unreal", by: "its header names it the Unreal bootstrap" };
  if (/(^|\/)binaries\/(win64|win32|wingdk|winrt|windows)\/[^/]+$/.test(r) && !/(^|\/)engine\/binaries\//.test(r)) return { tier: 1, engine: "Unreal", by: "the build under Binaries" };
  // Unity: <Name>.exe beside <Name>_Data and its runtime (UnityPlayer.dll, or the data of an older, static player)
  const data = at(`${stem}_data`);
  if (L.dirs.has(data) && (beside("unityplayer.dll") || L.dirs.has(`${data}/managed`) || ["globalgamemanagers", "maindata", "data.unity3d", "resources.assets"].some(n => L.files.has(`${data}/${n}`))))
    return { tier: 1, engine: "Unity", by: `beside ${Stem}_Data` };
  // NW.js (RPG Maker MV/MZ): the engine's nw.exe under the game's name, beside nw.dll / package.json
  const nw = beside("nw.dll", "nw.pak", "nw_elf.dll");
  if ((orig === "nw.exe" || keyOf(v.InternalName ?? "") === "nwexe") && (nw || beside("package.json"))) return { tier: 1, engine: "NW.js", by: "its header names it nw.exe" };
  if (pe?.kind === "program" && pe.ui === "window" && nw && beside("package.json")) return { tier: 1, engine: "NW.js", by: "beside nw.dll and package.json" };
  // Electron: the app's program beside resources/app.asar (Update.exe, Squirrel and elevate are helpers)
  if (beside("resources/app.asar") || L.dirs.has(at("resources/app")) || orig === "electron.exe") return { tier: 1, engine: "Electron", by: "beside resources/app.asar" };
  // Ren'Py: <Name>.exe beside <Name>.py and renpy/ (lib/**/python.exe and zsync are helpers)
  if (beside(`${stem}.py`) && L.dirs.has(at("renpy"))) return { tier: 1, engine: "Ren'Py", by: `beside ${Stem}.py and renpy/` };
  // GameMaker: beside data.win
  if (beside("data.win")) return { tier: 1, engine: "GameMaker", by: "beside data.win" };
  // Godot: beside <Name>.pck, or the engine by its header (the game packed inside it); never <Name>.console.exe
  if (!stem.endsWith(".console") && (beside(`${stem}.pck`) || /\bgodot engine\b/i.test(said))) return { tier: 1, engine: "Godot", by: beside(`${stem}.pck`) ? `beside ${Stem}.pck` : "its header names Godot" };
  // LÖVE and Adventure Game Studio: the engine's program under the game's name, by its header
  if (orig === "love.exe") return { tier: 1, engine: "LÖVE", by: "its header names it love.exe" };
  if (orig === "acwin.exe") return { tier: 1, engine: "Adventure Game Studio", by: "its header names it acwin.exe" };
  // RPG Maker XP / VX / VX Ace (Game.exe beside Game.ini and the RGSS runtime), 2000 / 2003 (RPG_RT.exe beside RPG_RT.ldb)
  const rgss = (n: string) => /^rgss\w*\.dll$/.test(n) || /\.rgss(ad|2a|3a)$/.test(n);
  if (beside(`${stem}.ini`) && [...(L.inDir.get(dir) ?? []), ...(L.inDir.get(at("system")) ?? [])].some(rgss)) return { tier: 1, engine: "RPG Maker", by: `beside ${Stem}.ini and the RGSS runtime` };
  if (stem === "rpg_rt" && beside("rpg_rt.ldb", "rpg_rt.ini")) return { tier: 1, engine: "RPG Maker", by: "beside RPG_RT.ldb" };
  return null;
}

const BIT32 = /(^|\/)(win32|x86|i386|bin32|32bit)\/|(win32|x86|i386|32bit|(^|[^0-9])32)\.exe$/i;
const BIT64 = /(^|\/)(win64|x64|amd64|bin64|64bit)\/|(win64|x64|amd64|64bit|(^|[^0-9])64)\.exe$/i;

/** the copy's layout, as the helper judgement reads it, from its files' paths (the admin's picker, src/library/launch.ts) */
export const copyLayout = (paths: string[]) => layoutOf(paths.map(rel => ({ rel, size: 0, ext: posix.extname(rel).toLowerCase() })));
export type CopyLayout = Layout;
/**
 * Is this program one that never starts the game, as the importer judges it (chooseLaunch) — the admin's picker dims it and a
 * start set by hand on it is warned about (src/library/launch.ts): a known helper (by its name or by its header's), a program in
 * a redistributables / tools / crack folder, or one whose name reads like a helper's that the copy's layout does not make the
 * engine's own (a Unity player named Crash….exe beside its Crash…_Data is the game). `pe`: its header, when it was read.
 */
export function helperProgram(rel: string, pe: PeInfo | undefined, L: CopyLayout): boolean {
  if (NOT_LAUNCH_DIR.test(rel) || inCrackDir(rel) || knownHelper(rel, pe)) return true;
  const orig = pe?.version.OriginalFilename;
  return (NOT_LAUNCH_NAME.test(basename(rel)) || (!!orig && NOT_LAUNCH_NAME.test(orig))) && !engineOf(rel, pe, L);
}

export interface LaunchPick { launch: string | null; candidates: string[]; why: string | null }

/**
 * The program that starts the game, chosen from the copy's programs without the AI. Never a library, never a known helper
 * (by its name or its header's), never a program in a redistributables / tools / crack folder, and never one whose name reads
 * like a helper's unless the copy's layout says it is the engine's own program. The others rank by, in this order:
 *   1. the engine's own program, read from the layout: an Unreal game's program at the top, then the program of Unreal's
 *      build, Unity, NW.js (RPG Maker MV/MZ), Electron, Ren'Py, GameMaker, Godot, LÖVE, AGS or RPG Maker;
 *   2. a name that reads like the game's own over one taken only for its layout;
 *   3. one whose file name or header names the game (a word of it at least) over one that names nothing;
 *   4. a window program, then one whose header could not be read, then (rarely the game) a console program, and last a file
 *      that is no Windows program at all (too small to hold a header, or a header that says so: the launcher cannot start it);
 *   5. how much of the game's name the file's name and the header's ProductName / FileDescription hold (a header with another
 *      number than the game's names another entry: "Red Alert 2" for Red Alert 3), the top of the copy over depth, 64-bit over
 *      32-bit, a launcher below the game, the size last.
 * A copy whose programs sit each in a folder of its own, none at the top, is a bundle of several programs (a collection: a
 * launcher, the games, an extra). An engine's layout says what starts ONE of them, never which one is the game, so there the
 * engine comes after the name: the bundle's launcher first, when it has exactly one beside two or more other folders (it is
 * how the player chooses between them), else the program that names the game most fully. METAL GEAR SOLID 4 - Master
 * Collection (Launcher/, MGS1/, MGS4/, MGS4DB/) was started on its database viewer, an Unreal program (2026-11-12).
 * candidates: every program that may start the game, the likeliest first.
 */
export function chooseLaunch(files: FileInfo[], gameName: string, peOf: PeOf): LaunchPick {
  const L = layoutOf(files);
  const want = words(gameName), wantAll = want.join(""), wantNums = numbersOf(gameName);
  const wantName = want.filter(t => !/^(19|20)\d\d$/.test(t)).join("");        // the name written together, its year aside
  /** how much of the game's name a text holds: each word (a long one also inside a joined name: DaveTheDiver), the whole name;
   *  `most`: more than half its words, or the whole name written together (LordsOfTheFallen.exe for "Lords Of The Fallen™ 2014").
   *  A header (`header`) whose numbers are none of the game's names another entry: nothing */
  const nameIn = (text: string | undefined, header = false): { n: number; most: boolean } => {
    if (!text) return { n: 0, most: false };
    if (header) { const nums = numbersOf(text); if (nums.size && ![...nums].some(x => wantNums.has(x))) return { n: 0, most: false }; }
    const w = words(text), all = w.join("");
    const hits = want.filter(t => w.includes(t) || (t.length >= 4 && all.includes(t))).length;
    return { n: hits * 10 + (wantAll.length >= 4 && all.includes(wantAll) ? 10 : 0), most: hits * 2 > want.length || (wantName.length >= 4 && all.includes(wantName)) };
  };
  const sizes = new Map(files.map(f => [f.rel, f.size] as [string, number]));
  const cands: { rel: string; tier: number; flagged: boolean; ui: number; name: number; most: boolean; said: string | null; fine: number; engine: Engine | null }[] = [];
  for (const f of files) {
    if (f.ext !== ".exe" || NOT_LAUNCH_DIR.test(f.rel) || inCrackDir(f.rel)) continue;
    const pe = peOf(f.rel);
    if (pe?.kind === "dll" || knownHelper(f.rel, pe)) continue;                // a library cannot start; a known helper never is the game
    const engine = engineOf(f.rel, pe, L);
    const orig = pe?.version.OriginalFilename;
    const flagged = NOT_LAUNCH_NAME.test(basename(f.rel)) || (!!orig && NOT_LAUNCH_NAME.test(orig));
    if (flagged && !engine) continue;
    const stem = basename(f.rel).replace(/\.exe$/i, "");
    const v = pe?.version ?? {};
    const own = nameIn(stem), product = nameIn(v.ProductName, true), desc = nameIn(v.FileDescription, true);
    const header = product.n >= desc.n ? product : desc;
    const said = !own.n && header.n ? (product.n >= desc.n ? v.ProductName! : v.FileDescription!) : null;
    const ui = f.size < 64 || pe?.kind === "other" ? -1 : !pe ? 1 : pe.ui === "window" ? 2 : pe.ui === "console" ? 0 : 1;
    cands.push({ rel: f.rel, tier: engine?.tier ?? 0, flagged, ui, name: own.n + 0.8 * header.n, most: own.n ? own.most : header.most, said, fine: 0, engine });
  }
  const has64 = cands.some(c => BIT64.test(c.rel));
  for (const c of cands) {
    const stem = basename(c.rel).replace(/\.exe$/i, "");
    let s = c.name - (c.rel.split("/").length - 1) * 3 + Math.min(10, Math.log10(Math.max(1, sizes.get(c.rel) ?? 0)));
    if (/launcher/i.test(stem)) s -= 4;                                   // the game's own program usually beats a launcher
    if (/(^|\/)(bin|binaries|win64|x64|win32|x86)(\/|$)/i.test(c.rel)) s += 1;
    if (has64 && BIT32.test(c.rel) && !BIT64.test(c.rel)) s -= 3;
    if (/shipping/i.test(stem)) s += 3;
    c.fine = s;
  }
  const named = (c: { name: number }) => (c.name > 0 ? 1 : 0);
  const byPath = (a: { rel: string }, b: { rel: string }) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  // a bundle: every program in a folder of its own, in two folders or more, none at the top of the copy
  const topOf = (rel: string) => rel.slice(0, Math.max(0, rel.indexOf("/")));
  const folders = cands.length > 1 && cands.every(c => c.rel.includes("/")) ? new Set(cands.map(c => topOf(c.rel).toLowerCase())) : new Set<string>();
  const bundle = folders.size >= 2;
  if (bundle) cands.sort((a, b) => Number(a.flagged) - Number(b.flagged) || b.name - a.name || b.tier - a.tier || b.ui - a.ui || b.fine - a.fine || byPath(a, b));
  else cands.sort((a, b) => b.tier - a.tier || Number(a.flagged) - Number(b.flagged) || named(b) - named(a) || b.ui - a.ui || b.fine - a.fine || byPath(a, b));
  // its launcher: the one folder that holds one, beside two or more others
  const launcherLike = (c: { rel: string }) => /launcher/i.test(basename(c.rel)) || topOf(c.rel).toLowerCase() === "launcher";
  const doors = bundle ? cands.filter(launcherLike) : [];
  const door = folders.size >= 3 && new Set(doors.map(c => topOf(c.rel).toLowerCase())).size === 1
    ? [...doors].sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || b.ui - a.ui || b.fine - a.fine || byPath(a, b))[0] : null;
  if (door) { cands.splice(cands.indexOf(door), 1); cands.unshift(door); }
  const [best, next] = cands;
  if (!best) return { launch: null, candidates: [], why: null };
  const byName = best.said ? (best.most ? `its header names the game: ${best.said}` : `part of the game's name is in its header: ${best.said}`)
    : best.most ? "its name is the game's" : "part of its name is the game's";
  const others = door ? [...new Set(cands.slice(1).map(c => topOf(c.rel)))].filter(d => d.toLowerCase() !== topOf(door.rel).toLowerCase()).sort() : [];
  const why = door ? `the launcher of a copy that holds several programs (${others.slice(0, 4).join(", ")}${others.length > 4 ? " …" : ""})`
    : bundle && best.name > 0 ? byName
    : best.engine ? `the game's ${best.engine.engine} program (${best.engine.by})`
    : next && named(best) > named(next) ? byName
    : next && best.ui > next.ui ? `${best.ui === 2 ? "a window program: " : ""}${next.ui === 1 ? "the others' headers could not be read" : next.ui === 0 ? "the others are console programs" : "the others are not Windows programs"}`
    : best.name > 0 ? byName
    : !next ? "the copy's only program that is not a helper"
    : "nothing names the game: the program nearest the top, then the largest";
  return { launch: best.rel, candidates: cands.map(c => c.rel), why };
}

/** a game's disc copied as it is, never installed: an autorun.inf, or an installer (setup.exe, install.exe), at the top of the
 *  copy beside the installer's payload there — cabinets (EA's Core_0.cab …, InstallShield's Data1.cab) or a Windows Installer
 *  package (.msi). Red Alert 3's RELOADED disc started on its autorun menu, which offers Install (2026-11-07); CoD4's Razor1911
 *  disc on the Windows Installer redistributable (2026-11-09). The AI importer, which runs installers, takes such a copy. */
function uninstalledDisc(files: FileInfo[]): string | null {
  const top = files.filter(f => !f.rel.includes("/"));
  const autorun = top.find(f => /^autorun\.inf$/i.test(f.rel));
  const setup = top.find(f => /^(setup|install)\.exe$/i.test(f.rel));
  const payload = top.filter(f => /\.(cab|msi)$/i.test(f.rel) && f.size >= 1_000_000);
  if (!payload.length || !(autorun || setup)) return null;
  return `this is the game's disc, not the installed game: ${(autorun ?? setup)!.rel} beside ${payload.slice(0, 2).map(f => f.rel).join(", ")}${payload.length > 2 ? ` (+${payload.length - 2})` : ""} — it has to be installed`;
}

/** a program's header for the picker: a file that could not be read at all is one whose header is unread (undefined), not one
 *  that is no program (src/library/pe.ts reads both as "other") */
async function headerOf(path: string): Promise<PeInfo | undefined> {
  const info = await vdeps.peInfo(path);
  if (info.kind !== "other") return info;
  try { const fh = await open(path, "r"); try { await fh.read(Buffer.alloc(2), 0, 2, 0); } finally { await fh.close(); } return info; } catch { return undefined; }
}

/**
 * Game.exe beside Game_Data/ is a Unity build, and a Unity build needs its runtime: UnityPlayer.dll next to the
 * exe (2017+), or Game_Data/Managed + the engine's data files (older, statically linked players). A scene
 * group's crack folder mirrors the layout with a patched exe and a couple of dlls but none of that.
 */
function unityWithoutRuntime(launch: string, files: FileInfo[]): string | null {
  const dir = posix.dirname(launch), stem = basename(launch).replace(/\.exe$/i, "");
  const at = (rel: string) => (dir === "." ? rel : `${dir}/${rel}`).toLowerCase();
  const data = at(`${stem}_Data/`);
  const rels = files.map(f => f.rel.toLowerCase());
  if (!rels.some(r => r.startsWith(data))) return null;                 // not a Unity layout
  const engine = [at("UnityPlayer.dll"), data + "globalgamemanagers", data + "maindata", data + "data.unity3d", data + "resources.assets"];
  if (rels.some(r => engine.includes(r) || r.startsWith(data + "managed/"))) return null;
  return `${launch} is a Unity game with no Unity runtime beside it (no UnityPlayer.dll, no ${stem}_Data/Managed or game data) — that is a crack / patch folder, not the installed game`;
}

/** cartridge dumps are small by nature (an NES game is tens of KB): when the payload is one, the size floor is 16 KB, not 5 MB */
const CARTRIDGE = /\.(sfc|smc|nes|fds|gb|gbc|gba|z64|n64|v64|md|gen|nds)$/i;
const sizeText = (n: number) => (n < 1_000_000 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`);

/** a console dump: nothing to launch on a PC — the payload is a disc image, a package or a cartridge dump, or a folder dump (PS3 JB, Home Rip); archives must be gone, images stay */
export async function inspectRom(dir: string): Promise<Validation> {
  const root = await unwrapRoot(dir);
  // A game folder's marker can follow hundreds of thousands of assets in directory order.
  const { files } = await vdeps.scan(root, Infinity);
  const problems: string[] = [];
  const totalSize = files.reduce((a, f) => a + f.size, 0);
  if (!files.length) problems.push("the folder is empty");
  const leftovers = files.filter(f => /\.(rar|7z|zip|part\d+\.rar|r\d\d|001)$/i.test(f.rel));
  if (leftovers.length) problems.push(`archives still inside: ${leftovers.slice(0, 4).map(f => f.rel).join(", ")}${leftovers.length > 4 ? ` (+${leftovers.length - 4})` : ""}`);
  const hasCue = files.some(f => f.ext === ".cue");
  const payload = files.filter(f => ROM_EXT.test(f.rel) && (f.ext !== ".bin" || hasCue)).sort((a, b) => b.size - a.size);
  const marker = files.find(f => ROM_MARKER.test(f.rel));
  const launch = marker?.rel ?? payload[0]?.rel ?? null;
  if (!launch) problems.push("no console image, package or ROM found (expected a disc image, a package, a cartridge or a game folder such as PS5 app0 with sce_sys/param.json)");
  const floor = launch && CARTRIDGE.test(launch) ? 16 * 1024 : 5_000_000;
  if (totalSize < floor && files.length) problems.push(`suspiciously small (${sizeText(totalSize)})`);
  return { ok: problems.length === 0, root, problems, exeCandidates: [], launch, prerequisites: [], totalSize, fileCount: files.length };
}

export async function inspect(dir: string, hints: { name: string; launchExe?: string | null; work?: string }): Promise<Validation> {
  const root = await unwrapRoot(dir);
  const { files } = await vdeps.scan(root, Infinity);
  const problems: string[] = [];
  const totalSize = files.reduce((a, f) => a + f.size, 0);
  if (!files.length) problems.push("the folder is empty");
  // an archive is always a leftover; a disc image only while the game could still be inside it (classify.ts
  // packagingImages: a small image in an installed game is the game's data), and a .img only when it is a disc image at all
  const notImages = await notDiscImages(root, files);
  const leftovers = [
    ...files.filter(f => LEFT_ARCHIVE.test(f.rel) || (f.ext === ".zip" && !f.rel.includes("/") && (f.size >= totalSize * 0.25 || f.size >= 100_000_000))),
    ...packagingImages(files.filter(f => DISC_IMAGE.test(f.rel) && !notImages.has(f.rel)), totalSize),
  ];
  if (leftovers.length) problems.push(`archives / disc images still inside: ${leftovers.slice(0, 4).map(f => f.rel).join(", ")}${leftovers.length > 4 ? ` (+${leftovers.length - 4})` : ""}`);
  if (hints.work) for (const f of files) {
    const why = await serverPathInFile(join(root, ...f.rel.split("/")), f.size, hints.work);
    if (why) problems.push(`${f.rel} holds ${why}: it would point nowhere on a player's PC`);
  }
  const exes = files.filter(f => f.ext === ".exe");
  // each program's own header (a window or a console program, a library, what it says it is): the shallowest first, bounded;
  // a file too small to hold one is not opened (an empty name, a pipe)
  const pe = new Map<string, PeInfo | undefined>();
  const read = exes.filter(f => f.size >= 64 && !NOT_LAUNCH_DIR.test(f.rel) && !inCrackDir(f.rel)).sort((a, b) => a.rel.split("/").length - b.rel.split("/").length).slice(0, PE_READS);
  for (const f of read) pe.set(f.rel, await headerOf(join(root, ...f.rel.split("/"))));
  const pick = chooseLaunch(files, hints.name, rel => pe.get(rel));
  const cands = pick.candidates;
  // the program the importer named (the AI importer's choice) is kept as it is
  const named = hints.launchExe ? files.find(f => f.rel.toLowerCase() === hints.launchExe!.replace(/\\/g, "/").toLowerCase()) : undefined;
  const launch: string | null = named ? named.rel : pick.launch;
  const launchWhy = named ? "the program the importer named" : pick.why;
  if (!launch) {
    if (exes.length) problems.push(`only installer-like executables found (${exes.slice(0, 3).map(f => basename(f.rel)).join(", ")}) — this is not an installed game`);
    else problems.push("no executable to launch");
  }
  if (totalSize < 5_000_000 && files.length) problems.push(`suspiciously small (${(totalSize / 1e6).toFixed(1)} MB)`);
  const pending = unrunInstaller(files);
  if (pending) problems.push(`the game is still inside its installer: ${pending.exe} + ${pending.parts.slice(0, 3).map(p => basename(p)).join(", ")} hold ${Math.round(pending.share * 100)}% of the bytes — it has to be run`);
  const disc = pending ? null : uninstalledDisc(files);
  if (disc) problems.push(disc);
  if (launch) { const u = unityWithoutRuntime(launch, files); if (u) problems.push(u); }
  const prerequisites: Prerequisite[] = [];
  for (const f of files) {
    if (!/\.(exe|msi)$/i.test(f.rel)) continue;
    if (!PREREQ_DIR.test(f.rel) && !/vc_?redist|vcredist|dxsetup|dxwebsetup|physx|oalinst|ue4prereq|ue5prereq/i.test(basename(f.rel))) continue;
    const k = prereqKind(basename(f.rel));
    if (k) prerequisites.push({ kind: k.kind, path: f.rel, args: k.args });
  }
  return { ok: problems.length === 0, root, problems, exeCandidates: cands, launch, launchWhy, prerequisites, totalSize, fileCount: files.length };
}

/** `blocks`: fed the same bytes, for the file's block hashes (src/blocks.ts BlockHasher) */
async function sha256(path: string, onBytes?: (n: number) => void, signal?: AbortSignal, blocks?: { push(chunk: Uint8Array): void }): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  if (signal?.aborted) throw new Error("cancelled");
  for await (const chunk of fileChunks(path)) {
    h.update(chunk);
    blocks?.push(chunk);
    onBytes?.(chunk.length);
    if (signal?.aborted) throw new Error("cancelled");
  }
  return h.digest("hex");
}

/** swapped in tests: how a file of the package is read for its sha256 (a test counts the reads), and a program's header */
export const vdeps = { sha256, peInfo, scan };

/** a file whose sha256 is known, with its stat right after it was placed: honoured only while the file's stat is still
 *  exactly that one — size, mtime, ctime, device and inode (a write, a chmod, a chown or a new link changes one of them) */
export interface KnownFile { sha256: string; size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }
const unchanged = (st: { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }, k: KnownFile) =>
  st.size === k.size && st.mtimeMs === k.mtimeMs && st.ctimeMs === k.ctimeMs && st.dev === k.dev && st.ino === k.ino;

export const slugify = (s: string) =>
  s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "game";

/**
 * The manifest the launcher trusts: every file of the package with its sha256. An import passes name/source/tier and
 * gets what it always got. A way (src/ways/assemble.ts) also passes the launch it was planned with — argv (used as is
 * by launchers that know it), env, cwd — and what the launcher must be able to do (requires), the saves it keeps (keep)
 * and the settings it ships once (seed); each lands in the manifest only when given. `known` gives the sha256 of files
 * placed by ludarr itself (by their path in the package): each is taken without reading the file while its stat is
 * still the one recorded with it, and the file is read like any other otherwise. A cancel stops the reading.
 * `blocks`: filled with the block hashes of every file that was read (by its path in the package), for the package's block
 * index (src/blocks.ts): the same read gives both, so a game is not read twice to be sent as blocks. A file that was not
 * read (a known one) is not in it.
 */
export async function buildManifest(
  v: Validation,
  meta: {
    name: string; slug?: string; version: string | null; source: Manifest["source"]; tier: Manifest["tier"]; notes?: string | null; launchArgs?: string; kind?: Manifest["kind"]; platform?: string | null;
    argv?: string[]; env?: Record<string, string>; cwd?: string; requires?: { launcher: string } | null; keep?: string[]; seed?: string[];
  },
  onProgress?: (done: number, total: number) => void,
  o: { known?: ReadonlyMap<string, KnownFile>; signal?: AbortSignal; blocks?: Map<string, Uint8Array> } = {},
): Promise<Manifest> {
  if (!v.ok || !v.launch) throw new Error(`cannot build a manifest for an invalid package: ${v.problems.join("; ")}`);
  // Every file in the finished copy must reach the launcher, including files beyond the discovery scan.
  const { files } = await vdeps.scan(v.root, Infinity);
  const total = files.reduce((a, f) => a + f.size, 0);
  let done = 0, lastReport = 0;
  const report = () => { const now = Date.now(); if (now - lastReport >= 250) { lastReport = now; onProgress?.(done, total); } };
  const out: ManifestFile[] = [];
  for (const f of files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    const abs = join(v.root, f.rel);
    const k = o.known?.get(f.rel);
    const st = k ? await lstat(abs).catch(() => null) : null;
    if (k && st?.isFile() && unchanged(st, k)) {
      done += f.size; report();
      out.push({ path: f.rel, size: f.size, sha256: k.sha256 });
      continue;
    }
    const cut = o.blocks ? new BlockHasher() : undefined;
    const hash = await vdeps.sha256(abs, n => { done += n; report(); }, o.signal, cut);
    if (cut) o.blocks!.set(f.rel, cut.end());
    out.push({ path: f.rel, size: f.size, sha256: hash });
  }
  onProgress?.(done, total);
  const cwd = meta.cwd ?? (posix.dirname(v.launch) === "." ? "" : posix.dirname(v.launch));
  return {
    schema: 1, name: meta.name, slug: meta.slug ?? slugify(meta.name), version: meta.version,
    launch: { exe: v.launch, args: meta.launchArgs ?? "", cwd, ...(meta.argv ? { argv: [...meta.argv] } : {}), ...(meta.env && Object.keys(meta.env).length ? { env: { ...meta.env } } : {}) },
    prerequisites: v.prerequisites, files: out, totalSize: total, source: meta.source, tier: meta.tier, notes: meta.notes ?? null,
    kind: meta.kind ?? "native", platform: meta.platform ?? null,
    ...(meta.requires ? { requires: { launcher: meta.requires.launcher } } : {}),
    ...(meta.keep?.length ? { keep: [...meta.keep] } : {}), ...(meta.seed?.length ? { seed: [...meta.seed] } : {}),
    createdAt: new Date().toISOString(),
  };
}

export type { FileInfo };
