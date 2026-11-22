/**
 * ludarr — what did we just download? A folder of game files, an archive (possibly multi-part),
 * a disc image, a GOG offline installer, or some other installer. The deterministic recipes
 * key off this; the agent gets it as context.
 */
import { lstat, open, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";
import { transportTrouble } from "../transport";

export interface FileInfo { rel: string; size: number; ext: string }
export type Shape = "folder" | "archive" | "iso" | "gog-installer" | "installer" | "empty" | "unknown";
export interface Classified {
  root: string; isDir: boolean; shape: Shape; files: FileInfo[]; totalSize: number;
  archives: string[];     // primary volumes only (first part of multi-part sets)
  isos: string[]; installers: string[]; exes: string[]; nfos: string[];
  /** the links it holds (and whatever else is neither a file nor a folder), by their path inside it: never followed,
   *  never part of the game */
  links: string[];
  why: string;
}

const ARCHIVE_EXT = /\.(rar|7z|zip|tar|tgz|gz|bz2|xz|zst|001|z01)$/i;
const ISO_EXT = /\.(iso|mdf|mds|nrg|img|cue|bin)$/i;
export const SECONDARY_PART = /(\.r\d\d|\.z\d\d|\.(?:0[0-9][2-9]|0[1-9]\d|[1-9]\d\d)|\.part(?!0*1\.rar$)\d+\.rar|\.7z\.(?!0*1$)\d+)$/i;
const GOG_SETUP = /^setup_.*\.exe$/i;
const INSTALLER_EXE = /^(setup|install|installer|autorun|start)[^\\/]*\.exe$/i;

/**
 * The files under `root` (or `root` itself when it is one file). Only what is really there: an entry is looked at by
 * itself (lstat), so a link is neither followed nor listed — an archive can carry one pointing anywhere on the server
 * ("data -> /", "saves -> /config"), and a walk through it would read, weigh and later hash whatever is behind it. The
 * same for what is neither a file nor a folder (a pipe, a device); `links` names both kinds. `root` itself is ludarr's
 * own path and may be a link.
 */
export async function scan(root: string, maxFiles = 50_000): Promise<{ isDir: boolean; files: FileInfo[]; links: string[] }> {
  const st = await stat(root);
  if (!st.isDirectory()) return { isDir: false, files: [{ rel: basename(root), size: st.size, ext: extname(root).toLowerCase() }], links: [] };
  const files: FileInfo[] = [];
  const links: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const name of await readdir(dir)) {
      if (files.length >= maxFiles || links.length >= maxFiles) return;
      const p = join(dir, name);
      // an entry that vanished between the listing and its stat is skipped; one the read path failed on (EIO, a timeout, a
      // stale handle on the seedbox's folder) is not: skipping it would give the download the wrong shape — it throws, and
      // the job is judged against the folder (src/remote.ts)
      const s = await lstat(p).catch(e => { if (transportTrouble(e, { words: false })) throw e; return null; });
      if (!s) continue;
      const r = rel ? posix.join(rel, name) : name;
      if (s.isDirectory()) await walk(p, r);
      else if (s.isFile()) files.push({ rel: r, size: s.size, ext: extname(name).toLowerCase() });
      else links.push(r);
    }
  };
  await walk(root, "");
  return { isDir: true, files, links };
}

/**
 * Every link under `dir` removed (the link itself: nothing is followed), and everything else that is neither a file nor a
 * folder; their paths inside `dir`. A package carries files only, and the import works on its folders as root: a link left
 * in one would have the next step write, unpack or package through it. `dir` itself is not touched. A link that cannot
 * be removed throws: nothing goes on over it.
 */
export async function dropLinks(dir: string): Promise<string[]> {
  const gone: string[] = [];
  const walk = async (at: string, rel: string) => {
    for (const name of await readdir(at).catch(() => [] as string[])) {
      const p = join(at, name), r = rel ? posix.join(rel, name) : name;
      const s = await lstat(p).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) { await walk(p, r); continue; }
      if (s.isFile()) continue;
      // unlink takes a link to a file or a folder alike; a Windows junction (a dev box) wants rmdir
      await unlink(p).catch(() => rmdir(p)).catch(e => { throw new Error(`${r} is a link and could not be removed (${e?.code ?? e?.message ?? e})`); });
      gone.push(r);
    }
  };
  await walk(dir, "");
  return gone;
}
/** the line an import logs when it removed links */
export const linksDropped = (gone: string[]) =>
  `removed ${gone.length} link${gone.length === 1 ? "" : "s"} (a game folder holds files only): ${gone.slice(0, 5).join(", ")}${gone.length > 5 ? " …" : ""}`;

/**
 * The disc images of a copy that the game could still be inside: what a recipe unpacks, and what the validator will not
 * have left behind — the two ask this one question. Together they hold a quarter of the copy's bytes or more, or one sits
 * at the top of the copy with 100 MB or more (as a .zip there). A small image inside an installed game is the game's own
 * data: METAL GEAR SOLID 4 - Master Collection keeps the PlayStation Metal Gear Solid as six 3 MB .img files for the
 * emulator it ships, and both its downloads were installed, cracked and then refused for them (2026-11-11).
 */
export function packagingImages(images: FileInfo[], totalSize: number): FileInfo[] {
  const held = images.reduce((a, f) => a + f.size, 0);
  if (images.length && held >= totalSize * 0.25) return images;
  return images.filter(f => !f.rel.includes("/") && f.size >= 100_000_000);
}

const CD_SYNC = Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]);
/** where a volume descriptor's name stands in an image of 2048-byte sectors, and of raw sectors (mode 1, mode 2) */
const VOLUME_AT = [0x8001, 0x9311, 0x9319];
/** is this file a disc image by what it holds: raw CD sectors (their sync pattern at its start) or an ISO 9660 / UDF
 *  volume? One that cannot be read counts as one (its name is all there is to go by) */
async function holdsDisc(path: string): Promise<boolean> {
  try {
    const fh = await open(path, "r");
    try {
      const head = Buffer.alloc(12);
      if ((await fh.read(head, 0, 12, 0)).bytesRead === 12 && head.equals(CD_SYNC)) return true;
      const name = Buffer.alloc(5);
      for (const at of VOLUME_AT) if ((await fh.read(name, 0, 5, at)).bytesRead === 5 && /^(CD001|BEA01|NSR0[23])$/.test(name.toString("latin1"))) return true;
      return false;
    } finally { await fh.close(); }
  } catch { return true; }
}
/** how many .img files are opened to see what they are (the largest first; a smaller one is too small to matter) */
const IMG_READS = 64;
/**
 * The .img files of a copy that are no disc images: ".img" is what many programs call their own files (Grand Theft Auto
 * keeps its models in models/gta3.img). Each is opened once and its first bytes read; only files of 1 MB or more are
 * looked at, the largest first.
 */
export async function notDiscImages(root: string, files: FileInfo[]): Promise<Set<string>> {
  const out = new Set<string>();
  const imgs = files.filter(f => f.ext === ".img" && f.size >= 1_000_000).sort((a, b) => b.size - a.size).slice(0, IMG_READS);
  for (const f of imgs) if (!(await holdsDisc(join(root, ...f.rel.split("/"))))) out.add(f.rel);
  return out;
}

/** .bin next to a .cue is a disc image; a lone .bin is game data */
function isDiscImage(f: FileInfo, all: FileInfo[]): boolean {
  if (!ISO_EXT.test(f.rel)) return false;
  if (f.ext === ".bin") return all.some(o => o.ext === ".cue" && posix.dirname(o.rel) === posix.dirname(f.rel));
  if (f.ext === ".cue" || f.ext === ".mds") return false;      // descriptors, not payload
  return true;
}

/** `notImages`: files named like a disc image that are none by what they hold (notDiscImages) */
export function classify(root: string, isDir: boolean, files: FileInfo[], links: string[] = [], o: { notImages?: ReadonlySet<string> } = {}): Classified {
  const totalSize = files.reduce((a, f) => a + f.size, 0);
  const depth = (rel: string) => rel.split("/").length - 1;
  const shallow = files.filter(f => depth(f.rel) <= 2);
  const archives = shallow.filter(f => ARCHIVE_EXT.test(f.rel) && !SECONDARY_PART.test(f.rel)).map(f => f.rel);
  const images = shallow.filter(f => isDiscImage(f, files) && !o.notImages?.has(f.rel));
  const isos = images.map(f => f.rel);
  const exes = files.filter(f => f.ext === ".exe").map(f => f.rel);
  const nfos = files.filter(f => /\.(nfo|txt|md|diz)$/i.test(f.rel) && f.size < 200_000).map(f => f.rel);
  const gog = exes.filter(e => GOG_SETUP.test(basename(e)) && files.some(b => /\.bin$/i.test(b.rel) && basename(b.rel).toLowerCase().startsWith(basename(e).toLowerCase().replace(/\.exe$/, "") + "-")));
  const gogSingle = exes.filter(e => GOG_SETUP.test(basename(e)) && depth(e) === 0 && files.filter(f => f.size > 1_000_000).length <= 1);
  const installers = exes.filter(e => INSTALLER_EXE.test(basename(e)) && depth(e) <= 1);
  const otherExes = exes.filter(e => !INSTALLER_EXE.test(basename(e)) && !/unins|redist|vcredist|dxsetup|dotnet/i.test(e));
  const base = { root, isDir, files, totalSize, archives, isos, installers, exes, nfos, links };

  if (!files.length) return { ...base, shape: "empty", why: "nothing inside" };
  if (gog.length || gogSingle.length) return { ...base, shape: "gog-installer", installers: [...new Set([...gog, ...gogSingle])], why: "GOG offline installer (setup_*.exe + .bin parts)" };
  if (isos.length && !otherExes.length) return { ...base, shape: "iso", why: `disc image: ${isos.join(", ")}` };
  // an archive set is "the release" when it holds most of the bytes; a small zip next to a game's exe is just data
  const packedBytes = files.filter(f => (ARCHIVE_EXT.test(f.rel) || SECONDARY_PART.test(f.rel)) && depth(f.rel) <= 2).reduce((a, f) => a + f.size, 0);
  const archivesDominate = archives.length > 0 && (otherExes.length === 0 || packedBytes >= totalSize * 0.5);
  if (archivesDominate) return { ...base, shape: "archive", why: `archive(s): ${archives.slice(0, 5).join(", ")}${archives.length > 5 ? " …" : ""}` };
  // beside programs of its own, a copy is a disc image only while the game could still be inside one: a small image in an
  // installed game is the game's data, and is left as it is
  const packaging = packagingImages(images, totalSize).map(f => f.rel);
  if (packaging.length) return { ...base, isos: packaging, shape: "iso", why: `disc image: ${packaging.join(", ")}` };
  if (installers.length && otherExes.length === 0) return { ...base, shape: "installer", why: `only an installer: ${installers.join(", ")}` };
  if (otherExes.length) return { ...base, shape: "folder", why: `game files with ${otherExes.length} executable(s)` };
  return { ...base, shape: "unknown", why: "no archive, image, installer or executable found" };
}

/** a folder that holds a group's crack, by its name: the group's ("RUNE", "Razor1911") or "Crack" — what goes over the installed
 *  game (src/process/scene.ts crackDirs), never the game itself (src/process/validate.ts never starts a program in one) */
export const CRACK_DIR = /^(rune|codex|tenoke|flt|fairlight|skidrow|plaza|doge|cpy|hoodlum|reloaded|razor1911|rzr|empress|darksiders|prophet|tinyiso|dinobytes|simplex|chronos|ali213|3dm|steampunks|hi2u|delusional|goldberg|anomaly|i_know|p2p|crack|cracked|crackfix|cracks|nosteam|steamless)$/i;

/** installer payload names: setup-1.bin, data1.bin, fg-01.bin, disk2.dat, setup_game_1.0-1.bin — not a game's own LINKDATA.BIN */
const PAYLOAD_PART = /^((setup|data|install|fg|disk|disc)([-_ .][^/]*|\d[^/]*)?|[^/]*-\d+)\.(bin|dat)$/i;
export interface UnrunInstaller { exe: string; dir: string; parts: string[]; share: number }
const SETUP_EXE = /^(setup|install|installer)[^\\/]*\.exe$/i;

/**
 * setup.exe next to .bin/.dat parts that hold most of the bytes: the game is still inside its installer.
 * Scene ISOs look like this (setup.exe + setup-1.bin + the group's crack folder, which has an .exe of its own,
 * so the shape alone reads as "folder"). Returns the installer and its parts, or null.
 */
export function unrunInstaller(files: FileInfo[]): UnrunInstaller | null {
  const total = files.reduce((a, f) => a + f.size, 0);
  if (!total) return null;
  const exes = files.filter(f => f.ext === ".exe" && f.rel.split("/").length <= 2 && SETUP_EXE.test(basename(f.rel)))
    .sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || (/^setup\.exe$/i.test(basename(b.rel)) ? 1 : 0) - (/^setup\.exe$/i.test(basename(a.rel)) ? 1 : 0));
  for (const e of exes) {
    const dir = posix.dirname(e.rel);
    const parts = files.filter(f => posix.dirname(f.rel) === dir && PAYLOAD_PART.test(basename(f.rel)) && f.size >= 1_000_000);
    const bytes = parts.reduce((a, f) => a + f.size, 0) + e.size;
    if (parts.length && bytes >= total * 0.5) return { exe: e.rel, dir, parts: parts.map(f => f.rel), share: bytes / total };
  }
  return null;
}

export async function classifyPath(root: string): Promise<Classified> {
  const { isDir, files, links } = await scan(root);
  return classify(root, isDir, files, links, { notImages: isDir ? await notDiscImages(root, files) : undefined });
}

/**
 * What a download looked like, in the terms a recipe could test: layout, heaviest extensions, the first bytes
 * of the biggest files ("ArC\x01" = FreeArc payload, "MZ" = exe, "Rar!" …). Recorded on every job so that what
 * the agent handles today can become a deterministic recipe tomorrow.
 */
export interface Snapshot {
  shape: Shape; why: string; files: number; bytes: number;
  layout: string[];
  byExt: { ext: string; files: number; bytes: number }[];
  largest: { rel: string; size: number; magic: string }[];
  installers: string[]; archives: string[]; isos: string[]; nfos: string[];
  unrunInstaller: string | null;
}

const human = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;

async function magic(path: string): Promise<string> {
  try {
    const f = Bun.file(path);
    const head = new Uint8Array(await f.slice(0, 8).arrayBuffer());
    let s = Array.from(head, b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "\\x" + b.toString(16).padStart(2, "0"))).join("");
    if (f.size > 0x8006) {
      const v = new TextDecoder().decode(await f.slice(0x8001, 0x8006).arrayBuffer());
      if (v === "CD001") s += " (ISO 9660)"; else if (v === "BEA01") s += " (UDF)";
    }
    return s;
  } catch { return ""; }
}

export async function snapshot(root: string): Promise<Snapshot | null> {
  const c = await classifyPath(root).catch(() => null);
  if (!c) return null;
  const groups = new Map<string, { dir: boolean; files: number; bytes: number }>();
  for (const f of c.files) {
    const seg = f.rel.split("/");
    const key = seg.length <= 2 ? f.rel : seg.slice(0, 2).join("/");
    const g = groups.get(key) ?? { dir: seg.length > 2, files: 0, bytes: 0 };
    g.files++; g.bytes += f.size; groups.set(key, g);
  }
  const layout = [...groups].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 40)
    .map(([k, g]) => g.dir ? `${k}/ (${g.files} files, ${human(g.bytes)})` : `${k} (${human(g.bytes)})`);
  if (groups.size > 40) layout.push(`… ${groups.size - 40} more`);
  const exts = new Map<string, { files: number; bytes: number }>();
  for (const f of c.files) { const e = exts.get(f.ext || "(none)") ?? { files: 0, bytes: 0 }; e.files++; e.bytes += f.size; exts.set(f.ext || "(none)", e); }
  const byExt = [...exts].map(([ext, e]) => ({ ext, ...e })).sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  const big = [...c.files].sort((a, b) => b.size - a.size).slice(0, 12);
  const largest = await Promise.all(big.map(async f => ({ rel: f.rel, size: f.size, magic: await magic(c.isDir ? join(root, f.rel) : root) })));
  const u = unrunInstaller(c.files);
  return {
    shape: c.shape, why: c.why, files: c.files.length, bytes: c.totalSize, layout, byExt, largest,
    installers: c.installers.slice(0, 10), archives: c.archives.slice(0, 10), isos: c.isos.slice(0, 10), nfos: c.nfos.slice(0, 10),
    unrunInstaller: u ? `${u.exe} + ${u.parts.length} part(s), ${Math.round(u.share * 100)}% of the bytes` : null,
  };
}
