/**
 * ludarr — the game's copy on the server, judged where it is. The copy is the game data in the game's current package:
 * a console dump's own file (or the game folder its marker file sits in: a PS3 JB folder, a PS4 or PS5 app folder, an
 * exefs + romfs pair — a marker file is never "the dump's one file"), or, in any other package, the console game files it
 * holds (an emulator bundle's .nup, a disc a way placed), largest first. Each is looked at with small reads only: what its
 * bytes say (src/ways/identity.ts readIdentity / readFolderIdentity), its sha256 from the package's own file list (a
 * folder's listing digest from the same list), never a copy just to look at it — the live failure was a 54 GB ISO copied
 * and hashed at "1 % starting" only to be refused for its form.
 *
 *   copy_facts   one row per package: its game data as judged, kept while the package, each path, size and time are the
 *                same; the full hashes once a read told them (the hand-off, a take), with the stat they belong to
 *
 * What a way makes of it (copyServes) is honest, and says why in words the admin reads after "the game's copy … is":
 *   direct    it is the way's game file: taken by a hard link into the content store (a copy only across volumes) and
 *             hashed where it lies once, or the kept row of the same bytes reused without a read (takeCopy). A console
 *             file inside another kind of package (a PC copy, an emulator's bundle) was never imported as the game's dump:
 *             it is direct only when what the way checks proves it (a hash, a serial or a build its own bytes carry)
 *   make      the way's game file is made from it (src/ways/make.ts, a make job from the copy)
 *   no        never: sealed for the console ("the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data
 *             is encrypted for the console, and nothing can open it"), another form ("a .iso file, and this needs .zar or
 *             the folder it is made from"), another game, version or category
 *   unknown   not looked at yet (seconds): the judge is started in the background, and the ways settle when it ends
 *
 * A kept file with the copy's own bytes (content row 1: the 54 GB second copy of Demon's Souls, source 'package') is THE
 * copy's file: it is never taken in again, and freeDuplicate — only ever on the admin's word — makes it a hard link to the
 * package's file, which frees its bytes and loses nothing.
 */
import { existsSync, lstatSync, type Stats } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { db, type GameRow, type PackageRow } from "../db";
import { events } from "../events";
import { logger } from "../log";
import { ROM_MARKER } from "../platforms";
import type { Manifest, ManifestFile } from "../process/validate";
import { EnvError, NeedsFiles } from "./errors";
import { hashedStat, hashInPlace, listingDigest, n64Order, sameStat } from "./hash";
import { DEFINITIVE, readFolderIdentity, readIdentity, serialWord, shownSerial, type Identity } from "./identity";
import { checksFiles, contentMatches, inputMatches, takesMakeFile, proven, type FileFacts, type Verdict } from "./match";
import { assembling, canonicalJson, contentFacts, contentHashes, contentRawHashes, currentPackage, getContent, settleWaysOnCopy, waysUsingContent, wstmts, type ContentRow, type WayRow } from "./store";
import type { AcceptHash, Completeness, ContentPlan, CopyView, Hashes, HashedStat, MakeInput } from "./types";

const log = logger("ways");
/** decimal, as every size ludarr says (1 GB = 10^9 bytes) */
const GB = 1e9, MB = 1e6;
/** the content store (src/ways/content.ts), reached only when a copy is taken or freed: store.ts imports this module, and
 *  content.ts's own imports must not run before store.ts has made its tables */
const store = () => import("./content");

/** platforms a file's extension names without doubt (an .iso or a .chd could be anything) */
const EXT_PLATFORM: Record<string, string> = {
  z64: "n64", n64: "n64", v64: "n64", sfc: "snes", smc: "snes", nes: "nes", fds: "nes", gba: "gba", gbc: "gbc", gb: "gb", nds: "nds",
  "3ds": "3ds", cia: "3ds", md: "genesis", gen: "genesis", cdi: "dc", gcm: "gc", wbfs: "wii", wia: "wii", nsp: "switch", xci: "switch",
  nsz: "switch", xcz: "switch", vpk: "vita", wux: "wiiu", wud: "wiiu", wua: "wiiu", zar: "ps5", nup: "switch",
};
export const extPlatform = (name: string): string | null => EXT_PLATFORM[(name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase()] ?? null;

db.exec(`
CREATE TABLE IF NOT EXISTS copy_facts (
  package_id INTEGER PRIMARY KEY REFERENCES packages(id) ON DELETE CASCADE,
  game_id INTEGER,
  rel TEXT NOT NULL,
  shape TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  sha256 TEXT,
  facts_json TEXT NOT NULL,
  judged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copy_facts_game ON copy_facts(game_id);
`);

/** one piece of game data in the game's copy, as judged where it lies */
export interface CopyEntry {
  /** package-relative ("" = the package folder itself, a folder dump at its root) */
  rel: string; path: string; name: string; shape: "file" | "folder"; size: number; mtime: number;
  /** the file's extension ("iso"), or "folder" */
  format: string;
  /** from the package's own file list (a folder: its listing digest); null when the list says nothing */
  sha256: string | null;
  /** what is known of its hashes: the list's sha256, the full set once a read told them (with `hashed`, the stat they belong
   *  to), or a kept row's of the same bytes */
  hashes: Hashes; rawHashes: Hashes | null; hashed: HashedStat | null;
  identity: Identity | null;
  /** files a folder holds that say what it is (sce_sys/param.json, eboot.bin …) */
  markers: string[];
  /** the console it is for: what its bytes say beyond doubt, else the package's word, else its extension */
  platform: string | null;
  /** encrypted for the console (a retail disc as a PC drive reads it, an NSP, a PKG): nothing can open it */
  sealed: boolean;
  /** a kept game file with these very bytes (never taken in again) */
  contentId: number | null;
  /** a folder's file count */
  files: number | null;
  /** why it cannot be used at all (gone from the server, a link), or null */
  why: string | null;
  /** a game folder a take found to be only a part of the game, by the whole-game check it failed (canonical JSON of the
   *  way's Completeness → the words): every way with that check is told so without another walk */
  incomplete?: Record<string, string>;
}
/** what the game's copy is, judged in place, kept while its package, paths, sizes and times are unchanged; the top-level
 *  entry fields are its main piece (the dump of a console copy, else the largest) */
export interface CopyFacts extends CopyEntry {
  packageId: number;
  /** the package's kind (rom, native, emulated …) */
  kind: string;
  judgedAt: number;
  /** every piece of game data in it, the main one first (empty: it holds none a console plays) */
  entries: CopyEntry[];
}
/** whether the copy serves a way's content plan: 'direct' it is the file, 'make' the file is made from it, 'no' never
 *  (why says exactly why), 'unknown' not judged yet; `block`: how a release of these bytes is blocklisted for the way
 *  ('identity' another title, version or a sealed copy — never again; 'form' only not in a form the way takes now) */
export interface CopyServes { serves: "direct" | "make" | "no" | "unknown"; why: string; block?: "identity" | "form" | null }
/** the verdict with the piece of the copy it is about */
export interface CopyVerdict extends CopyServes { facts: CopyFacts | null; entry: CopyEntry | null; hashLater?: boolean }

/** swapped in tests: the readers, the judges (src/ways/match.ts) and the clock */
export const cpdeps = {
  readIdentity: (path: string, platform: string | null, name: string): Promise<Identity | null> => readIdentity(path, platform, name),
  readFolderIdentity: (dir: string, platform: string | null): Promise<Identity | null> => readFolderIdentity(dir, platform),
  contentMatches: (c: ContentPlan, f: FileFacts): Verdict => contentMatches(c, f),
  inputMatches: (input: MakeInput, f: FileFacts): Verdict => inputMatches(input, f),
  now: (): number => Date.now(),
  /** a copy nobody has looked at yet is judged in the background (the ways settle when it ends) */
  judgeSoon: (gameId: number): void => judgeSoon(gameId),
};

const q = {
  newestPackage: db.query("SELECT id, path FROM packages WHERE game_id=? ORDER BY id DESC LIMIT 1"),
  factsFor: db.query("SELECT * FROM copy_facts WHERE package_id=?"),
  upsert: db.query(`INSERT OR REPLACE INTO copy_facts (package_id, game_id, rel, shape, size, mtime, sha256, facts_json, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  forGame: db.query("DELETE FROM copy_facts WHERE game_id=? AND package_id<>?"),
  packagesOfGame: db.query("SELECT * FROM packages WHERE game_id=? ORDER BY id DESC"),
};
interface FactsRow { package_id: number; game_id: number | null; rel: string; shape: string; size: number; mtime: number; sha256: string | null; facts_json: string; judged_at: number }

const sizeText = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : n >= MB ? `${Math.round(n / MB)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const extOf = (name: string) => (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
const hex64 = (s: unknown): string | null => (typeof s === "string" && /^[0-9a-f]{64}$/i.test(s) ? s.toLowerCase() : null);
const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };

/* ─────────── which pieces of a package are game data ─────────── */

/** files that say a folder is a game dump (platforms.ts ROM_MARKER, and a PS5 app folder's sce_sys/param.json) */
const FOLDER_MARKER = new RegExp(`${ROM_MARKER.source}|(^|/)sce_sys/param\\.json$`, "i");
/** console game files by themselves, as any package may hold them (an emulator bundle, a way's placed disc); extensions
 *  that are as often a PC game's own data (.bin, .elf, .dol, .cue) are left to a console copy's own dump */
const COPY_EXT = new Set(["iso", "pkg", "chd", "rvz", "wbfs", "wia", "gcz", "gcm", "nsp", "xci", "nsz", "xcz", "3ds", "cia", "nds", "gba", "gbc", "gb", "z64", "n64", "v64",
  "sfc", "smc", "nes", "fds", "pbp", "cso", "vpk", "xex", "wux", "wud", "wua", "md", "gen", "cdi", "gdi", "nup", "zar"]);
/** forms whose game data is encrypted for the console whatever a reader finds (a PS5 or PS4 disc image says so itself) */
const SEALED_EXT = new Set(["nsp", "xci", "nsz", "xcz", "pkg"]);
const MAX_ENTRIES = 8;

/** the package-relative folder a marker file says is the game folder ("" = the package folder), or null when the path
 *  names no marker (an app.pkg is a file of its own, never a folder) */
export function markerRoot(rel: string): string | null {
  const m = FOLDER_MARKER.exec(rel);
  if (!m) return null;
  if (/app\.pkg$/i.test(m[0])) return null;
  const segs = rel.slice(0, m.index).split("/").filter(Boolean);
  // a PS3 or PSP dump is the folder that holds PS3_GAME / PSP_GAME
  if (segs.length && /^(ps3_game|psp_game)$/i.test(segs[segs.length - 1])) segs.pop();
  return segs.join("/");
}

/** the pieces of game data a package holds, the main one first: a console copy's dump; any package's console game files */
function piecesOf(pkg: Pick<PackageRow, "path">, m: Manifest, kind: string): { rel: string; shape: "file" | "folder" }[] {
  const out: { rel: string; shape: "file" | "folder" }[] = [];
  const seen = new Set<string>();
  const add = (rel: string, shape: "file" | "folder") => { const k = `${shape}:${rel.toLowerCase()}`; if (!seen.has(k) && out.length < MAX_ENTRIES) { seen.add(k); out.push({ rel, shape }); } };
  const launch = String(m.launch?.exe ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (kind === "rom" && launch) {
    const root = markerRoot(launch);
    if (root != null) add(root, "folder");
    else {
      // a launch that is a folder (a dump named by its folder): the game folder it is, or the one holding PS3_GAME/PSP_GAME
      const st = lstatSync(join(pkg.path, ...launch.split("/")), { throwIfNoEntry: false });
      if (st?.isDirectory()) { const segs = launch.split("/"); if (/^(ps3_game|psp_game)$/i.test(segs[segs.length - 1])) segs.pop(); add(segs.join("/"), "folder"); }
      else add(launch, "file");
    }
  }
  const files = Array.isArray(m.files) ? m.files : [];
  for (const f of [...files].filter(x => COPY_EXT.has(extOf(x.path ?? ""))).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))) add(String(f.path), "file");
  if (kind !== "rom") for (const f of files) { const r = markerRoot(String(f.path ?? "")); if (r != null) add(r, "folder"); }
  return out;
}

/** a folder's files from the package's list, relative to the folder */
function listed(m: Manifest, root: string): ManifestFile[] {
  const files = Array.isArray(m.files) ? m.files : [];
  if (!root) return files;
  const pre = root + "/";
  return files.filter(f => typeof f.path === "string" && f.path.startsWith(pre)).map(f => ({ ...f, path: f.path.slice(pre.length) }));
}

/** the sha256 the package's own list gives each file of a folder piece (relative to the folder): a tree of links taken from
 *  it is named without reading the files again */
export function listedSums(manifestJson: string | null | undefined, rel: string): Map<string, { size: number; sha256: string }> {
  const m = parse<Manifest | null>(manifestJson, null);
  return new Map(m ? listed(m, rel).filter(f => hex64(f.sha256)).map(f => [String(f.path), { size: Number(f.size) || 0, sha256: hex64(f.sha256)! }] as const) : []);
}

/** a folder's files from the disk (a package whose list says nothing about it), links left out; at most 200,000 */
async function walked(dir: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const visit = async (abs: string, rel: string) => {
    for (const n of await readdir(abs).catch(() => [] as string[])) {
      if (out.length >= 200_000) return;
      const p = join(abs, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(p).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) await visit(p, r); else if (st.isFile()) out.push({ path: r, size: st.size });
    }
  };
  await visit(dir, "");
  return out;
}

const platformOf = (identity: Identity | null, hint: string | null, name: string): string | null =>
  identity && DEFINITIVE.has(identity.platform) ? identity.platform : (hint ?? extPlatform(name) ?? identity?.platform ?? null);

async function firstBytes(path: string, n: number): Promise<Uint8Array> {
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return new Uint8Array(0);
  try { const b = new Uint8Array(n); const { bytesRead } = await fh.read(b, 0, n, 0); return b.subarray(0, bytesRead); }
  finally { await fh.close().catch(() => { /* closed */ }); }
}

/** one piece, looked at where it lies */
async function judgeEntry(gameId: number, pkg: Pick<PackageRow, "path">, m: Manifest, rel: string, shape: "file" | "folder", prev: CopyEntry | undefined): Promise<CopyEntry> {
  const path = rel ? join(pkg.path, ...rel.split("/")) : pkg.path;
  const name = basename(rel || pkg.path);
  const hint = m.platform ?? null;
  const base: CopyEntry = { rel, path, name, shape, size: 0, mtime: 0, format: shape === "folder" ? "folder" : extOf(name), sha256: null, hashes: {}, rawHashes: null, hashed: null,
    identity: null, markers: [], platform: hint ?? (shape === "file" ? extPlatform(name) : null), sealed: false, contentId: null, files: null, why: null };
  const st = await lstat(path).catch(() => null);
  if (!st) return { ...base, why: "gone from the server" };
  if (st.isSymbolicLink()) return { ...base, why: "a link, which is never taken as game data" };
  if (shape === "file" && !st.isFile()) return { ...base, why: "not a regular file" };
  if (shape === "folder" && !st.isDirectory()) return { ...base, why: "not a folder" };
  const e: CopyEntry = { ...base, mtime: st.mtimeMs };
  if (shape === "file") {
    e.size = st.size;
    e.identity = await cpdeps.readIdentity(path, hint ?? extPlatform(name), name);
    const sha = hex64(listed(m, "").find(f => f.path === rel)?.sha256);
    e.sha256 = sha;
    // the list's sha256 is of the bytes as they are; an N64 dump in another byte order is matched by its z64 bytes' hashes
    const n64 = (e.identity?.platform ?? hint ?? extPlatform(name)) === "n64" ? n64Order(await firstBytes(path, 4)) : null;
    if (sha) { if (n64 === "v64" || n64 === "n64") e.rawHashes = { sha256: sha }; else e.hashes = { sha256: sha }; }
  } else {
    let files = listed(m, rel).map(f => ({ path: String(f.path), size: Number(f.size) || 0, sha256: hex64(f.sha256) }));
    if (!files.length) files = (await walked(path)).map(f => ({ ...f, sha256: null }));
    e.size = files.reduce((n, f) => n + f.size, 0);
    e.files = files.length;
    e.markers = files.map(f => f.path).filter(p => FOLDER_MARKER.test(p) || /^eboot\.bin$/i.test(p)).slice(0, 20);
    if (files.length && files.every(f => f.sha256)) {
      const d = listingDigest(files.map(f => ({ rel: f.path, size: f.size, tag: f.sha256! })));
      e.hashes = d.hashes;
      e.sha256 = d.hashes.sha256 ?? null;
    }
    e.identity = await cpdeps.readFolderIdentity(path, hint);
  }
  e.platform = platformOf(e.identity, hint, name);
  e.sealed = e.identity?.sealed === true || (shape === "file" && SEALED_EXT.has(e.format));
  // what an earlier read told about these very bytes
  const unchanged = !!prev && prev.rel === rel && prev.shape === shape && prev.size === e.size && prev.mtime === e.mtime;
  if (unchanged && prev!.hashed && sameStat(prev!.hashed, hashedStat(st), { ctime: false })) {
    e.hashes = { ...e.hashes, ...prev!.hashes }; e.rawHashes = prev!.rawHashes ?? e.rawHashes; e.hashed = prev!.hashed;
  }
  if (unchanged && prev!.incomplete) e.incomplete = prev!.incomplete;
  // a kept file of the same bytes is the copy's file: its hashes are the copy's, and it learns what the copy's bytes say
  const sha = e.sha256 ?? e.rawHashes?.sha256 ?? null;
  const kept = sha ? (wstmts.contentBySha256.get(gameId, sha) as ContentRow | null) : null;
  if (kept && (kept.shape ?? "file") === shape && kept.size === e.size && existsSync(kept.path)) {
    e.contentId = kept.id;
    e.hashes = { ...contentHashes(kept), ...e.hashes };
    e.rawHashes = contentRawHashes(kept) ?? e.rawHashes;
    if (!kept.identity_json && e.identity) wstmts.setContentIdentity.run(JSON.stringify(e.identity), kept.id);
  }
  return e;
}

/* ─────────── judging, and what was judged ─────────── */

const memo = new Map<number, { at: number; facts: CopyFacts }>();

/** is a judged piece still the same on disk (cheap: one lstat) */
function stillSame(e: CopyEntry): boolean {
  const st = lstatSync(e.path, { throwIfNoEntry: false });
  if (e.why) return !st || st.isSymbolicLink() || (e.shape === "file" ? !st.isFile() : !st.isDirectory());
  if (!st || st.isSymbolicLink()) return false;
  if (e.shape === "folder") return st.isDirectory() && st.mtimeMs === e.mtime;
  return st.isFile() && st.size === e.size && st.mtimeMs === e.mtime;
}

/** the copy's facts as last judged, or null (nothing judged yet, or the package, a path, a size or a time changed since) */
export function copyFacts(gameId: number): CopyFacts | null {
  const pkg = q.newestPackage.get(gameId) as { id: number; path: string } | null;
  if (!pkg) return null;
  const row = q.factsFor.get(pkg.id) as FactsRow | null;
  if (!row) return null;
  let facts = memo.get(pkg.id)?.at === row.judged_at ? memo.get(pkg.id)!.facts : null;
  if (!facts) { facts = parse<CopyFacts | null>(row.facts_json, null); if (!facts) return null; memo.set(pkg.id, { at: row.judged_at, facts }); }
  if (facts.packageId !== pkg.id || !facts.entries.every(stillSame)) return null;
  return facts;
}

function save(gameId: number, facts: CopyFacts): void {
  const main = facts.entries[0];
  const at = Math.max(cpdeps.now(), (memo.get(facts.packageId)?.at ?? 0) + 1);
  facts.judgedAt = at;
  q.upsert.run(facts.packageId, gameId, main?.rel ?? "", main?.shape ?? "file", main?.size ?? 0, Math.round(main?.mtime ?? 0), main?.sha256 ?? null, JSON.stringify(facts), at);
  q.forGame.run(gameId, facts.packageId);
  memo.set(facts.packageId, { at, facts });
}

const judging = new Map<number, Promise<CopyFacts | null>>();

/** judge the game's copy where it lies: small reads, seconds. One judge per game at a time (callers share it). Ends with the
 *  game's ways that have no file settled, and a 'game' event when what the copy is changed */
export function judgeCopy(gameId: number): Promise<CopyFacts | null> {
  const running = judging.get(gameId);
  if (running) return running;
  const p = judgeNow(gameId).finally(() => judging.delete(gameId));
  judging.set(gameId, p);
  return p;
}

async function judgeNow(gameId: number): Promise<CopyFacts | null> {
  const cur = currentPackage(gameId);
  if (!cur) return null;
  let m: Manifest;
  try { m = JSON.parse(cur.pkg.manifest_json) as Manifest; } catch { m = { launch: { exe: "" }, files: [] } as unknown as Manifest; }
  const before = parse<CopyFacts | null>((q.factsFor.get(cur.pkg.id) as FactsRow | null)?.facts_json, null);
  const entries: CopyEntry[] = [];
  for (const piece of piecesOf(cur.pkg, m, cur.kind)) entries.push(await judgeEntry(gameId, cur.pkg, m, piece.rel, piece.shape, before?.entries.find(x => x.rel === piece.rel && x.shape === piece.shape)));
  const main = entries[0];
  const facts: CopyFacts = {
    ...(main ?? { rel: "", path: cur.pkg.path, name: basename(cur.pkg.path), shape: "folder" as const, size: 0, mtime: 0, format: "folder", sha256: null, hashes: {}, rawHashes: null, hashed: null, identity: null,
      markers: [], platform: cur.platform, sealed: false, contentId: null, files: null, why: null }),
    packageId: cur.pkg.id, kind: cur.kind, judgedAt: 0, entries,
  };
  save(gameId, facts);
  settleWaysOnCopy(gameId);
  const changed = JSON.stringify(before?.entries ?? null) !== JSON.stringify(entries);
  if (changed) await gameEvent(gameId);
  return facts;
}

async function gameEvent(gameId: number) {
  try {
    const { serializeLibraryGame } = await import("../library/games");
    const g = db.query("SELECT * FROM games WHERE id=?").get(gameId) as GameRow | null;
    if (g) events.emit("game", serializeLibraryGame(g));
  } catch (e: any) { log.warn(`the game's page was not refreshed after its copy was judged: ${e?.message ?? e}`); }
}

const soon = new Set<number>();
let draining = false;
/** when each game's copy was last looked at in the background: a copy whose file keeps changing (still being written) is
 *  looked at again at most every 10 seconds, and is 'unknown' meanwhile */
const lastLook = new Map<number, number>();
/** judge a copy nobody has looked at yet, in the background, one at a time */
function judgeSoon(gameId: number): void {
  if (judging.has(gameId)) return;
  const now = Date.now();
  if (now - (lastLook.get(gameId) ?? 0) < 10_000) return;
  lastLook.set(gameId, now);
  soon.add(gameId);
  if (draining) return;
  draining = true;
  setTimeout(async () => {
    try {
      while (soon.size) {
        const id = soon.values().next().value as number;
        soon.delete(id);
        await judgeCopy(id).catch(e => log.warn(`the game's copy (game ${id}) could not be looked at: ${e?.message ?? e}`));
      }
    } finally { draining = false; }
  }, 0);
}

/* ─────────── what the copy is to a way ─────────── */

const listWords = (xs: string[], last = "or") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${last} ${xs[xs.length - 1]}`);
const dotted = (formats: string[] | undefined) => (formats ?? []).map(f => "." + f.replace(/^\./, "").toLowerCase());
/** "1.00" for "01.00": a version as people write it */
const shownVersion = (v: string | null | undefined) => (v && /^\d+(\.\d+)*$/.test(v) ? v.replace(/^0+(?=\d)/, "") : v ?? null);

/** what a way takes, in words: its product, and what its make takes */
function takesWords(c: ContentPlan): string {
  const product = c.kind === "folder" ? `the game folder${c.marker ? ` (holding ${c.marker})` : ""}` : dotted(c.accept.formats).length ? listWords(dotted(c.accept.formats)) : `a ${c.platform} game file`;
  const inp = c.make?.input;
  if (!inp) return product;
  const holding = inp.marker ? ` (holding ${inp.marker})` : "";
  const packed = dotted(inp.formats);
  if (inp.shape === "folder") return `${product} or the folder it is made from${holding}`;
  if (inp.shape === "file") return packed.length ? `${product} or a ${listWords(packed)} file it is made from` : product;
  return `${product} or the folder it is made from${holding}${packed.length ? `, loose or as ${listWords(packed)}` : ""}`;
}

/** a sealed piece, in words */
function sealedWords(e: CopyEntry): string {
  const id = e.identity;
  const facts = [id?.region, shownSerial(id), shownVersion(id?.masterVersion ?? id?.version)].filter(Boolean).join(", ");
  const said = facts ? ` (${facts})` : "";
  if (id?.shape === "bd-image" || (e.format === "iso" && (e.platform === "ps5" || e.platform === "ps4")))
    return `the retail disc as a PC drive reads it${said}: its game data is encrypted for the console, and nothing can open it`;
  if (e.shape === "file" && (e.format === "nsp" || e.format === "xci")) return `a .${e.format} file${said}: this plan does not process that encrypted format`;
  if (e.shape === "file" && SEALED_EXT.has(e.format)) return `a .${e.format} file${said}, whose game data is encrypted for the console: nothing can open it`;
  return `encrypted for the console${said}: nothing can open it`;
}

const factsOf = (e: CopyEntry): FileFacts => ({ platform: e.platform, name: e.name, size: e.size, hashes: e.hashes, rawHashes: e.rawHashes, identity: e.identity, shape: e.shape });
const what = (e: CopyEntry) => (e.shape === "folder" ? `a game folder${e.markers.length ? ` (holding ${e.markers.slice(0, 2).join(" and ")})` : ""}` : `a .${e.format || "?"} file`);

/** `near`: the piece is in the form this leg takes, but lacks a file it must hold (the most telling words of a form refusal) */
interface Leg { ok: boolean; why: string | null; kind?: "form" | "identity" | "sealed" | "source"; hashLater?: boolean; v?: Verdict; near?: boolean }

/** the first of these folder-relative files a folder does not hold as a plain file (one lstat each), or null */
function missingIn(dir: string, rels: string[]): string | null {
  for (const r of rels) if (lstatSync(join(dir, ...r.split("/")), { throwIfNoEntry: false })?.isFile() !== true) return r;
  return null;
}

/** is the piece the way's game file, as it is */
function directLeg(e: CopyEntry, c: ContentPlan): Leg {
  if (c.platform && e.platform && c.platform !== e.platform) return { ok: false, kind: "identity", why: `a ${e.platform} ${e.shape === "folder" ? "game folder" : "file"}, and this needs a ${c.platform} one` };
  const folderWay = c.kind === "folder";
  if (folderWay !== (e.shape === "folder")) return { ok: false, kind: "form", why: `${what(e)}, and this needs ${takesWords(c)}` };
  // a game folder way's marker and the files beside it, looked at where they are (the copy's list of markers is only a
  // sample of what it holds); a whole-game check a take already failed is told without another walk
  const gone = folderWay && c.marker ? missingIn(e.path, [c.marker, ...(c.also ?? [])]) : null;
  if (gone) return { ok: false, kind: "form", near: true, why: `a game folder without ${gone}, and this needs ${takesWords(c)}` };
  const part = folderWay && c.complete ? e.incomplete?.[canonicalJson(c.complete)] : null;
  if (part) return { ok: false, kind: "identity", why: part };
  const formats = (c.accept.formats ?? []).map(f => f.toLowerCase());
  const takesAsIs = !folderWay && formats.includes(e.format);
  if (e.sealed && !takesAsIs) return { ok: false, kind: "sealed", why: sealedWords(e) };
  if (!folderWay && formats.length && !takesAsIs) return { ok: false, kind: "form", why: `${what(e)}, and this needs ${takesWords(c)}` };
  // a hash only a full read can tell is left to the take (it reads the copy where it lies, once): when no accepted hash's
  // algorithm is known yet, or the known ones do not match while another algorithm (another version's) still might
  const has = (h: AcceptHash) => !!(e.hashes[h.algo] || e.rawHashes?.[h.algo]);
  const knownHashes = c.accept.hashes.filter(has);
  const bare: ContentPlan = { ...c, accept: { ...c.accept, hashes: [] } };
  let later = c.accept.hashes.length > 0 && !knownHashes.length;
  let probe = later ? bare : c;
  if (!later && knownHashes.length < c.accept.hashes.length) {
    const told: ContentPlan = { ...c, accept: { ...c.accept, hashes: knownHashes } };
    if (cpdeps.contentMatches(told, factsOf(e)).ok) probe = told;
    else { later = true; probe = bare; }
  }
  const v = cpdeps.contentMatches(probe, factsOf(e));
  if (!v.ok) return { ok: false, kind: "identity", why: v.why ?? "not the game file this needs" };
  return { ok: true, why: null, hashLater: later, v };
}

/** is the piece what the way's make takes (null: the way has no make) */
function makeLeg(e: CopyEntry, c: ContentPlan): Leg | null {
  const mk = c.make;
  if (!mk) return null;
  if (mk.from?.length && !mk.from.includes("copy")) return { ok: false, kind: "source", why: `what its make takes comes only from ${listWords(mk.from, "and")}, not from the game's copy` };
  const inp = mk.input;
  if (inp.platform && e.platform && inp.platform !== e.platform) return { ok: false, kind: "identity", why: `a ${e.platform} ${e.shape === "folder" ? "game folder" : "file"}, and this makes its game file from a ${inp.platform} one` };
  if (e.sealed && !takesMakeFile(inp, e.shape, e.name)) return { ok: false, kind: "sealed", why: sealedWords(e) };
  if (inp.shape === "file" && e.shape === "folder") return { ok: false, kind: "form", why: `${what(e)}, and this needs ${takesWords(c)}` };
  if (inp.shape === "folder" && e.shape === "file") return { ok: false, kind: "form", why: `${what(e)}, and this needs ${takesWords(c)}` };
  if (e.shape === "file" && dotted(inp.formats).length && !(inp.formats ?? []).map(f => f.toLowerCase()).includes(e.format)) return { ok: false, kind: "form", why: `${what(e)}, and this needs ${takesWords(c)}` };
  const gone = e.shape === "folder" && inp.marker ? missingIn(e.path, [inp.marker, ...(inp.also ?? [])]) : null;
  if (gone) return { ok: false, kind: "form", near: true, why: `a game folder without ${gone}, and this needs ${takesWords(c)}` };
  const v = cpdeps.inputMatches(inp, factsOf(e));
  if (!v.ok) return { ok: false, kind: "identity", why: v.why ?? "not what this way's game file is made from" };
  return { ok: true, why: null, v };
}

/** how a package of this kind is called when a piece of it is named ("the game's PC copy") */
const kindWord = (kind: string) => (kind === "native" ? "PC copy" : kind === "rom" ? "console copy" : "copy");

function entryVerdict(e: CopyEntry, c: ContentPlan, kind: string): { serves: CopyServes["serves"]; why: string; block: CopyServes["block"]; hashLater?: boolean } {
  if (e.why) return { serves: "no", why: e.why, block: null };
  const d = directLeg(e, c);
  // a console game file inside another kind of package (a PC copy, an emulator's bundle) was never imported as the game's
  // own dump: it is the way's file only when what the way checks proves it (a hash, or a serial or build its own bytes
  // carry), or a hash the take's one read will tell — a wrong game is far worse than none
  const unproven = d.ok && kind !== "rom" && !d.hashLater && !(d.v && proven(d.v));
  if (d.ok && !unproven) {
    const why = d.v?.matched ? `the game file this way takes (its ${d.v.matched.algo} is one the way accepts)`
      : d.v?.serial ? `the game file this way takes (its ${serialWord(c.platform)} ${shownSerial(e.identity) ?? d.v.serial} is one the way accepts)`
      : d.hashLater ? `the game file this way takes if its ${listWords([...new Set(c.accept.hashes.map(h => h.algo))])} is one the way accepts: that is read as the copy is taken`
      : "a game file this way takes as it is";
    return { serves: "direct", why, block: null, hashLater: d.hashLater };
  }
  const mk = makeLeg(e, c);
  // the same doubt for what a make takes from such a package: made into the way's file only when its own data proves it
  // (a serial the make's input lists) or the made file must prove itself (the way's hashes, serials or builds)
  const makeUnproven = !!mk?.ok && kind !== "rom" && !(mk.v && proven(mk.v)) && !checksFiles(c);
  if (mk?.ok && !makeUnproven) return { serves: "make", why: "what this way's game file is made from", block: null };
  if (unproven || makeUnproven) return { serves: "no", why: `${what(e)} in the game's ${kindWord(kind)} that nothing this way checks can prove is the game`, block: null };
  // never: the most telling words first — sealed, then another game or version, then the form
  if (d.kind === "sealed" || mk?.kind === "sealed") return { serves: "no", why: sealedWords(e), block: e.format === "nsp" || e.format === "xci" ? "form" : "identity" };
  if (d.kind === "identity") return { serves: "no", why: d.why!, block: "identity" };
  if (mk?.kind === "identity") return { serves: "no", why: mk.why!, block: "identity" };
  // the make would take it, but not from the game's copy (make.from): the same bytes may still come another way
  if (mk?.kind === "source") return { serves: "no", why: mk.why!, block: null };
  return { serves: "no", why: (mk?.near ? mk.why : null) ?? d.why ?? mk?.why ?? `${what(e)}, and this needs ${takesWords(c)}`, block: "form" };
}

const RANK: Record<CopyServes["serves"], number> = { direct: 0, make: 1, no: 2, unknown: 3 };

/** what the game's copy is to a way's content plan, with the piece of it the verdict is about (the best one) */
export function copyVerdict(gameId: number, c: ContentPlan): CopyVerdict {
  if (c.platform === "pc") return { serves: "no", why: "PC game data is never taken from the game's copy", block: null, facts: null, entry: null };
  const facts = copyFacts(gameId);
  if (!facts) {
    if (!q.newestPackage.get(gameId)) return { serves: "no", why: "there is no copy of the game on the server", block: null, facts: null, entry: null };
    cpdeps.judgeSoon(gameId);
    return { serves: "unknown", why: "looking at the game's copy", block: null, facts: null, entry: null };
  }
  let best: CopyVerdict | null = null;
  for (const e of facts.entries) {
    const v = entryVerdict(e, c, facts.kind);
    if (!best || RANK[v.serves] < RANK[best.serves]) best = { ...v, facts, entry: e };
    if (best.serves === "direct") break;
  }
  return best ?? { serves: "no", why: "it holds no game file a console plays", block: null, facts, entry: null };
}

/** what the game's copy is to a way's content plan ('unknown' before it has been looked at: the look starts by itself) */
export function copyServes(gameId: number, c: ContentPlan): CopyServes {
  const v = copyVerdict(gameId, c);
  return { serves: v.serves, why: v.why, block: v.block ?? null };
}

/** the copy as the admin and the AI see it for one way (null: the game has no copy, or nothing in it is game data) */
export function copyView(gameId: number, c: ContentPlan): CopyView | null {
  const v = copyVerdict(gameId, c);
  if (v.serves === "unknown") {
    const pkg = q.newestPackage.get(gameId) as { id: number; path: string } | null;
    return pkg ? { packageId: pkg.id, name: basename(pkg.path), size: 0, shape: "file", identity: null, serves: "unknown", why: v.why } : null;
  }
  if (!v.facts || !v.entry) return null;
  return { packageId: v.facts.packageId, name: v.entry.name, size: v.entry.size, shape: v.entry.shape, identity: v.entry.identity, serves: v.serves, why: v.why };
}

/** the release the game's copy came from (its package's source), for a way's blocklist: a way the copy is no file for never
 *  fetches the same bytes again */
export function copyRelease(gameId: number): { title: string; indexer: string | null } | null {
  const cur = currentPackage(gameId);
  if (!cur) return null;
  const src = parse<{ source?: { title?: unknown; indexer?: unknown } | null }>(cur.pkg.manifest_json, {}).source;
  return typeof src?.title === "string" && src.title.trim() ? { title: src.title, indexer: typeof src.indexer === "string" ? src.indexer : null } : null;
}

/** how the copy's piece is called in a refusal ("the game's console copy X", or "X in the game's copy") */
const copyLabel = (f: CopyFacts, e: CopyEntry) => (f.kind === "rom" ? `the game's console copy ${e.name}` : `${e.name} in the game's copy`);

/** what a read told about a piece (its full hashes and the stat they belong to; the kept row of its bytes), kept with the
 *  copy's facts so every way's verdict knows it */
export function recordCopyHashes(gameId: number, rel: string, o: { hashes: Hashes; rawHashes?: Hashes | null; stat: HashedStat | null; contentId?: number | null }): void {
  const facts = copyFacts(gameId);
  if (!facts) return;
  let hit = false;
  facts.entries = facts.entries.map(e => {
    if (e.rel !== rel) return e;
    hit = true;
    return { ...e, hashes: { ...e.hashes, ...o.hashes }, rawHashes: o.rawHashes ?? e.rawHashes, hashed: o.stat ?? e.hashed, contentId: o.contentId !== undefined ? o.contentId : e.contentId };
  });
  if (!hit) return;
  Object.assign(facts, facts.entries[0]);
  save(gameId, facts);
}

/** a game folder of the copy that a take found to be only a part of the game, by this whole-game check: kept with the copy's
 *  facts, so every way with that check says so without walking the folder again */
function recordIncomplete(gameId: number, rel: string, complete: Completeness, why: string): void {
  const facts = copyFacts(gameId);
  if (!facts) return;
  let hit = false;
  facts.entries = facts.entries.map(e => (e.rel === rel && e.shape === "folder" ? ((hit = true), { ...e, incomplete: { ...e.incomplete, [canonicalJson(complete)]: why } }) : e));
  if (!hit) return;
  Object.assign(facts, facts.entries[0]);
  save(gameId, facts);
}

/** the scratch a take of the copy needs: nothing when it is linked (the store and the copy on one volume), its size else */
export async function copyScratch(gameId: number | null | undefined): Promise<number> {
  const facts = gameId != null ? copyFacts(gameId) : null;
  if (!facts?.entries.length) return 0;
  const e = facts.entries[0];
  if (e.contentId != null) return 0;
  const { ctdeps } = await store();
  const root = ctdeps.rootFolders().find(r => existsSync(r.path));
  return root && (await ctdeps.sameVolume(e.path, root.path)) ? 0 : e.size;
}

/* ─────────── taking the copy ─────────── */

export interface TakeCopyOpts {
  game: GameRow; way: WayRow; content: ContentPlan; log: (line: string) => void;
  /** bytes of total, and the step it is on ("hashing the game's copy") */
  progress?: (bytes: number, total: number, step?: string) => void;
  /** a game folder's walk before anything is read or linked (every file looked at by lstat): files and bytes so far */
  looking?: (files: number, bytes: number) => void;
  signal?: AbortSignal;
}

/**
 * The copy taken as the way's game file: the kept row of the same bytes when there is one (nothing read); else a hard link
 * into the game's store folder (a copy only across volumes, with progress), hashed where it lies once — or not at all when
 * an earlier read of these very bytes told their hashes. A piece the way cannot take (another form, sealed, another game
 * or version, what its make takes) is refused with the copy's own words (NeedsFiles) before anything is linked or read;
 * one whose hash a full read refuses leaves nothing behind (its hashes are kept with the copy's facts). Null: the game has
 * no copy.
 */
export async function takeCopy(o: TakeCopyOpts): Promise<ContentRow | null> {
  let v = copyVerdict(o.game.id, o.content);
  if (v.serves === "unknown") { await judgeCopy(o.game.id); v = copyVerdict(o.game.id, o.content); }
  if (!v.facts || !v.entry) return null;
  const facts = v.facts, e = v.entry;
  if (v.serves === "make") throw new NeedsFiles(`its game file is made from ${copyLabel(facts, e)} first`);
  if (v.serves !== "direct") throw new NeedsFiles(`${copyLabel(facts, e)} is ${v.why}`);
  const t = { role: "game" as const, game: o.game };
  const { ingestFile, ingestTree, removeContent } = await store();
  // the same bytes kept before (content row 1): that row, nothing read or copied
  if (e.contentId != null) {
    const kept = getContent(e.contentId);
    const st = kept ? await lstat(kept.path).catch(() => null) : null;
    if (kept && st && (kept.shape === "folder" ? st.isDirectory() : st.isFile() && st.size === kept.size)) {
      o.log(`${copyLabel(facts, e)} is kept already as ${kept.name}: nothing is read or copied`);
      return checked(kept, false);
    }
  }
  let row: ContentRow, duplicate: boolean;
  if (e.shape === "folder") {
    // the whole game, not an update or a part of it, before anything is linked (the folder way's own check)
    const complete = o.content.kind === "folder" ? o.content.complete ?? null : null;
    if (complete) {
      const w = await (await store()).ctdeps.completeness(e.path, complete, { progress: o.looking });
      if (!w.ok) {
        const why = w.why ?? "an update or a part of the game, not the whole game";
        recordIncomplete(o.game.id, e.rel, complete, why);
        settleWaysOnCopy(o.game.id);
        throw new NeedsFiles(`${copyLabel(facts, e)} is ${why}`);
      }
    }
    const known = listedSums(currentPackage(o.game.id)?.pkg.manifest_json, e.rel);
    o.log(`taking ${copyLabel(facts, e)} (${e.files ?? "?"} files, ${sizeText(e.size)}) by a tree of hard links`);
    const r = await ingestTree(e.path, t, { mode: "link", hash: true, source: "package", known, signal: o.signal, identity: e.identity, platform: e.platform, looking: o.looking,
      progress: (b, total, s) => o.progress?.(b, total, s === "linking" ? "linking the game's copy" : s === "copying" ? "copying the game's copy" : s === "protecting" ? "protecting the game's copy from changes" : "hashing the game's copy") });
    if (!r.linked) o.log("the store is on another volume: the game folder was copied");
    row = r.row; duplicate = r.duplicate;
  } else {
    const trusted = e.hashed && Object.keys(e.hashes).length > 1 ? { hashes: e.hashes, rawHashes: e.rawHashes, stat: e.hashed } : null;
    o.log(`taking ${copyLabel(facts, e)} (${sizeText(e.size)}) by a hard link${trusted ? ": its hashes are known, nothing is read" : ", hashed where it lies"}`);
    const r = await ingestFile(e.path, t, { name: e.name, source: "package", platform: e.platform, wayPlatform: o.content.platform, mode: "link", known: trusted, identity: e.identity, signal: o.signal,
      progress: (b, total, s) => o.progress?.(b, total, s === "copying" ? "copying the game's copy" : "hashing the game's copy") });
    row = r.row; duplicate = r.duplicate;
    if (!r.linked) o.log("the store is on another volume: the copy was copied, and hashed as it was");
    recordCopyHashes(o.game.id, e.rel, { hashes: contentHashes(row), rawHashes: contentRawHashes(row), stat: r.linked ? r.stat ?? null : r.sourceStat ?? null, contentId: row.id });
  }
  return checked(row, !duplicate);

  /** the kept row against the way, now that its hashes are known: refused, nothing taken stays behind */
  async function checked(r: ContentRow, ours: boolean): Promise<ContentRow> {
    const m = cpdeps.contentMatches(o.content, contentFacts(r));
    if (m.ok) return r;
    if (ours) {
      await removeContent(r.id).catch(err => o.log(`the refused copy could not be removed from the store: ${err?.message ?? err}`));
      recordCopyHashes(o.game.id, e.rel, { hashes: contentHashes(r), rawHashes: contentRawHashes(r), stat: null, contentId: null });
    }
    settleWaysOnCopy(o.game.id);
    throw new NeedsFiles(`${copyLabel(facts, e)} is ${m.why ?? "not the game file this needs"}`);
  }
}

/* ─────────── freeing the second copy ─────────── */

/**
 * A kept game file that is the same bytes as a file of the game's copy, replaced by a hard link to that file: its bytes
 * are freed and nothing is lost. Lossless only: the copy's file must be listed by its package with this file's sha256, be
 * a plain file of the same size on the same volume, and read (now, unless a read since its last change told its hashes) as
 * these very bytes; the file is replaced by a rename over it, so there is never a moment without it. Never runs by itself
 * (POST /api/v1/content/:id/free-duplicate, on the admin's word). 409 with the reason otherwise.
 */
/**
 * Whether kept file `row` is a second copy of the game's copy that freeDuplicate would free: a kept game file (one file)
 * whose sha256 a package of the game lists, on the same volume as that package's file but under another inode, with no
 * other name (nothing built from it shares it). Only stats, no read: freeDuplicate still compares the bytes before it
 * frees anything. What the admin's kept-files list and the way card show as "Free … (keeps one copy)".
 */
export function secondCopyOf(row: ContentRow): { bytes: number } | null {
  if (row.role !== "game" || row.game_id == null || (row.shape ?? "file") !== "file") return null;
  const sha = contentHashes(row).sha256;
  if (!sha) return null;
  const b = lstatSync(row.path, { throwIfNoEntry: false });
  if (!b?.isFile() || b.nlink > 1 || b.size !== row.size) return null;
  for (const pkg of q.packagesOfGame.all(row.game_id) as PackageRow[]) {
    const f = (parse<Manifest | null>(pkg.manifest_json, null)?.files ?? []).find(x => hex64(x.sha256) === sha);
    if (!f) continue;
    const a = lstatSync(join(pkg.path, ...String(f.path).split("/")), { throwIfNoEntry: false });
    return a?.isFile() && a.size === row.size && a.dev === b.dev && a.ino !== b.ino ? { bytes: row.size } : null;
  }
  return null;
}

export async function freeDuplicate(contentId: number, o: { signal?: AbortSignal; progress?: (bytes: number, total: number) => void; log?: (line: string) => void } = {}): Promise<{ freedBytes: number }> {
  const { ContentError } = await store();
  const row = getContent(contentId);
  if (!row) throw new ContentError("no such file", 404);
  if (row.role !== "game" || row.game_id == null) throw new ContentError("only a kept game file can be freed this way", 409);
  if (row.shape === "folder") throw new ContentError("a kept game folder is not freed this way", 409);
  // a build placing the file now would keep the bytes it linked: the file is freed once that build ends
  if (waysUsingContent(row.id).some(w => assembling(w.id))) throw new EnvError("busy", "a way that uses this file is being built: free it once that build ends");
  const sha = contentHashes(row).sha256;
  if (!sha) throw new ContentError("the kept file's sha256 is not known: nothing proves it is the copy's bytes", 409);
  // the file of the game's copy with these bytes, by its package's own list
  let src: { pkg: PackageRow; rel: string; path: string } | null = null;
  for (const pkg of q.packagesOfGame.all(row.game_id) as PackageRow[]) {
    const m = parse<Manifest | null>(pkg.manifest_json, null);
    const f = (m?.files ?? []).find(x => hex64(x.sha256) === sha);
    if (f) { src = { pkg, rel: f.path, path: join(pkg.path, ...String(f.path).split("/")) }; break; }
  }
  if (!src) throw new ContentError("no copy of the game on the server lists these bytes: nothing to free", 409);
  const [a, b] = await Promise.all([lstat(src.path).catch(() => null), lstat(row.path).catch(() => null)]);
  if (!a?.isFile()) throw new ContentError(`the copy's file ${basename(src.path)} is gone from the server`, 409);
  if (!b?.isFile()) throw new ContentError(`the kept file ${row.name} is gone from the server`, 409);
  if (a.size !== row.size || b.size !== row.size) throw new ContentError(`the copy's file is ${sizeText(a.size)} and the kept one ${sizeText(b.size)}: not the same bytes`, 409);
  if (a.dev === b.dev && a.ino === b.ino) throw new ContentError("the kept file is the copy's own file already: nothing to free", 409);
  if (a.dev !== b.dev) throw new ContentError("the copy and the kept file are on different volumes: a hard link cannot join them", 409);
  if (b.nlink > 1) throw new ContentError(`the kept file has ${b.nlink - 1} other name${b.nlink > 2 ? "s" : ""} on the server (a package built from it): replacing it frees nothing`, 409);
  // the copy's bytes read once (lossless): unless a read since its last change told them
  const facts = copyFacts(row.game_id);
  const told = facts?.entries.find(e => e.rel === src!.rel && e.shape === "file" && e.hashed && sameStat(e.hashed, hashedStat(a), { ctime: false }) && e.hashes.sha256);
  let theirs = told?.hashes.sha256 ?? null;
  if (!theirs) {
    o.log?.(`reading ${basename(src.path)} where it lies (${sizeText(a.size)}) to be sure it is the same bytes`);
    const r = await hashInPlace(src.path, { signal: o.signal, progress: o.progress });
    theirs = r.result.hashes.sha256 ?? null;
    if (facts) recordCopyHashes(row.game_id, src.rel, { hashes: r.result.hashes, rawHashes: r.result.rawHashes ?? null, stat: r.stat });
  }
  if (theirs !== sha) throw new ContentError(`the copy's file is not the same bytes now (its sha256 is ${theirs}): nothing is freed`, 409);
  const tmp = join(dirname(row.path), `.free-${crypto.randomUUID()}`);
  try { await (await store()).ctdeps.link(src.path, tmp); }
  catch (e: any) { throw new ContentError(`this share cannot hold hard links (${e?.code ?? e?.message ?? e}): nothing is freed`, 409); }
  try {
    const t = await lstat(tmp);
    if (t.ino !== a.ino || t.dev !== a.dev) throw new ContentError("the link did not land on the copy's file: nothing is freed", 409);
    await rename(tmp, row.path);
  } catch (e) { await unlink(tmp).catch(() => { /* not there */ }); throw e; }
  const now = await lstat(row.path);
  wstmts.setContentStat.run(JSON.stringify(hashedStat(now as Stats)), row.id);
  o.log?.(`${row.name} is a hard link to the copy's file now: ${sizeText(row.size)} freed`);
  return { freedBytes: row.size };
}
