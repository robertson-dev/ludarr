/**
 * ludarr — the content pass: one way to play's game file found on the indexers, and taken in only when it is proven to be
 * the game (a wrong game is far worse than no game). src/requests.ts runs it for a request that carries the way.
 *
 *   which way      requestWay(game): a game players cannot start yet (no copy, or a console dump) that has ways is searched
 *                  for through its best way whose plan is ready: one that can prove a file first, then one whose plan has
 *                  every file it needs, then a recomp before a port before an emulator. A way whose game file is PC data
 *                  is never searched for here.
 *   what to ask    the way's names for the original game (content.search) and the game's own names, in a console pass for
 *                  the way's console only, with the way's own extra queries (content.terms: a serial). A dump that names no
 *                  console (No-Intro / Redump names: "Legend of Zelda, The - Majora's Mask (USA)") only when the way can
 *                  prove the file once it is here, and only at a size its console's games come in; Demo / Kiosk / Beta /
 *                  Proto / Sample / Hack / Pirate / Unl / Bonus … tags only when the way's own description asks for them
 *                  (Dinosaur Planet is a prototype) — a description that says no to anything ("not the demo", "betas won't
 *                  boot", "retail only") asks for nothing; another disc than the first only when it asks for that disc; the
 *                  way's regions first and a release of other regions only never; neither the game's blocklist nor the
 *                  way's own (a release the way refused only for its form, under another version of its game file plan, is
 *                  looked at again: wayBlocked); never a release whose title says its data is sealed for the console (a PS5
 *                  "Full ISO", an NSP) when neither the way nor its make takes that form.
 *   looking first  before a way's search grabs a release, its own listing is read (a .torrent's file list, an NZB's
 *                  subjects: judgeListing): one that cannot hold the way's game file (nothing in a form the way or its make
 *                  takes, no archive whose inside could) is refused without a download. A listing that cannot be had is
 *                  judged as before.
 *   proving it     a hash the way accepts (the exact version its plan lists: nothing else is asked then); else, for a file
 *                  whose name carries no such tag and that is the disc the way takes, a serial (game id, game code) its
 *                  bytes carry that the way accepts, or the console's dump list, whose entry for the file's SHA-1 must be
 *                  this game as it was sold (src/catalog/providers/dats.ts). The list also refuses a file it knows as
 *                  another game, a demo, a beta or a bonus disc, even when its serial is the game's. A header's title
 *                  never proves anything. The catalog's serials for the game (PCSX2's index, retail entries only) are
 *                  copied into an emulator way's own content when it is made, and those and the dump list's when the admin
 *                  looks for its file (never one the admin took off), where the admin sees them.
 *   the download   takeDownload, a 'content' job with the download and the request: the one game file in it (the file, the
 *                  dump in its folder, or inside an archive unpacked in the build sandbox), checked, kept in the content
 *                  store — read once: where it lies and linked when the download is on the store's volume, else as it is
 *                  copied — made the way's file, and the way's build queued. A game folder (a way of kind 'folder') is
 *                  found by its marker file without walking its 100,000 files, and kept as a tree of links; game data the
 *                  way's make takes (a folder holding its marker, an archive it unpacks itself) is made into the way's file
 *                  in the same job (src/ways/make.ts runMake). A download that holds no file the way takes (another game,
 *                  version, console or disc, a tagged dump, a sealed file, an archive its archiver turns down) is refused
 *                  (NotTheGameFile, 'identity'; or 'form' when only its form was wrong): the request blocklists that
 *                  release for this way only and takes its next candidate, and the download is done with as an import's
 *                  is. A file that looks right but cannot be proven is kept for the admin (POST /way/:id/accept-file takes
 *                  it); until the admin accepts or removes it, the searches of the game's ways that cannot tell it apart
 *                  either fetch no other (heldFor). Any other failure (no room, a tool missing, the way being built) is
 *                  nobody's verdict on the release: the request tries the download again later.
 *   a preview      previewContentPass: what a way's pass would take now (with other names, formats, serials or versions),
 *                  and why each other release would not be taken — the AI's find tool; nothing is grabbed.
 *
 * The download is the content job's as it is an import's: once its file is kept (or refused), the seeding task looks
 * after it and the raw copy goes (IMPORT_KEEP_DOWNLOAD keeps it; a client's mapped folder is the client's).
 */
import { existsSync, type Dirent } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { cfgBool, cfgNum, downloadsDir } from "../config";
import { db, stmts, type GameRow, type JobRow } from "../db";
import { clientFor } from "../fetch";
import { removeTree } from "../fsutil";
import { CONSOLE_CATEGORIES, PLATFORM_LABEL, ROM_EXT, wantedPlatform, type PlatformId } from "../platforms";
import { datKept, datVerdict, entrySerials, gameEntries, loadDat, type Dat } from "../catalog/providers/dats";
import { gameAliases } from "../catalog/providers/custom";
import { automaticProblem, scopeProblem } from "./emulator-scope";
import { normName } from "../catalog/store";
import { activeSources } from "../catalog/worker";
import { profileFor, type Profile } from "../library/profiles";
import { rootFolderFor } from "../library/rootfolders";
import { enqueueJob, type KindContext, type KindResult } from "../process/kinds";
import { pdeps } from "../process/deps";
import { extractArchive } from "../process/recipes";
import { SECONDARY_PART } from "../process/classify";
import { ownsDownload } from "../process/runner";
import { certainlyThisGame, notAsSold, tokens, type ReleaseView } from "../releases";
import { searchReleases, type SearchOptions, type SearchResult } from "../search";
import { allowedRoots, attachToWays, ctdeps, ensureRoom, ingestFile, ingestTree, linksInto, ofText, removeContent, storedName } from "./content";
import { EnvError, NeedsFiles } from "./errors";
import { noteTrouble, steadyOrThrow } from "../remote";
import { hashInPlace } from "./hash";
import { DEFINITIVE, readFolderIdentity, readIdentity, readsFormat, SERIAL_PLATFORMS, serialKeys, serialWord, shownSerial, type Identity } from "./identity";
import { completeness } from "./inspect";
import { judgeArchive, MakeRefused, runMake, unpackRoom, volumesOf, type MakeOutcome } from "./make";
import { checksFiles, contentMatches, inputMatches, proven, takesMakeFile, sealedWhy, takenSealed, type FileFacts, type Verdict } from "./match";
import { discNumber, regionKey, regionRank, regionsOf } from "./names";
import { refuseLinks } from "./program";
import { claimUnpacked, markUnpacked, unpackKey } from "./unpack-cache";
import { closeJobFolder, handTo, sandboxed, spareJobFolder } from "./sandbox";
import {
  assembling, contentDigest, contentFacts, contentHashes, currentPackage, droppedSerials, getContent, getPlan, getWay, heldFiles, planNeeds, settleWay, updateWay,
  planSpec, wayContent, waysOfGame, wstmts, type ContentRow, type PlanRow, type WayRow,
} from "./store";
import type { Completeness, ContentPlan, FailInfo, Hashes, HashedStat, JobSpec, MakeInput, PassPreview, PlanKind } from "./types";
import { validateWayContent } from "./validate";

export { regionKey, regionRank, regionsOf };

/** swapped in tests: the catalog sources that are switched on, the search a preview runs, and what a content job calls
 *  that other modules own (the folder reader, the make, the judges of a make's input) */
export const fdeps = {
  activeSources: (): Set<string> => activeSources(),
  search: (name: string, year: number | null, opt?: SearchOptions): Promise<Pick<SearchResult, "ranked">> => searchReleases(name, year, opt),
  usenetAvailable: async (): Promise<boolean> => !!clientFor("usenet"),
  readFolderIdentity: (dir: string, platform: string | null): Promise<Identity | null> => readFolderIdentity(dir, platform),
  completeness: (dir: string, c: Completeness, o: { progress?: (files: number, bytes: number) => void } = {}): Promise<{ ok: boolean; why: string | null }> => completeness(dir, c, { list: null, progress: o.progress }),
  inputMatches: (input: MakeInput, f: FileFacts): Verdict => inputMatches(input, f),
  runMake: (ctx: KindContext, o: Parameters<typeof runMake>[1]): Promise<MakeOutcome> => runMake(ctx, o),
  /** where an archive of a download is unpacked: the job's folder on the library, or its folder on the downloads volume */
  unpackRoom: (work: string, unpack: number, o: { here: number; away: number }) => unpackRoom(work, unpack, o),
  /** a download's archive judged by its listing before it is unpacked (src/ways/make.ts judgeArchive) */
  judgeArchive: (o: Parameters<typeof judgeArchive>[0]) => judgeArchive(o),
  /** an archive unpacked in the build sandbox (src/process/recipes.ts), and how often what it has written is said */
  extract: (ctx: Parameters<typeof extractArchive>[0], archive: string, out: string): Promise<void> => extractArchive(ctx, archive, out),
  unpackEvery: 5000,
};

const KB = 1024, MB = 2 ** 20, GB = 2 ** 30;
const label = (p: string) => PLATFORM_LABEL[p as PlatformId] ?? p;
/** a size in words, decimal as every size ludarr says (the ranges above stay in their binary units: they are never said) */
const sizeText = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const list = (s: string | null | undefined): string[] => { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };

/* ─────────── which way a request searches for ─────────── */

/** the best way to play first, as the catalog ranks routes: a recomp, then a port, then an emulator */
const KIND_RANK: Record<PlanKind, number> = { recomp: 0, port: 1, emulator: 2 };

/** can this game file plan prove a file by itself: hashes, serials its console's files carry, or a dump list kept for it */
export function canProve(c: ContentPlan): boolean {
  return c.accept.hashes.length > 0 || provesByIdentity(c) || datKept(c.platform);
}
/** the plan lists serials or builds of a console whose files carry them where ludarr's readers find them */
const provesByIdentity = (c: ContentPlan): boolean =>
  SERIAL_PLATFORMS.has(c.platform) && ((c.accept.serials ?? []).length > 0 || (c.accept.builds ?? []).length > 0);

/**
 * The way a request for this game searches for, or null for the game's own search (exactly as before ways existed): only
 * while the game has no copy players can start (none, or a console dump), among its ways whose plan is ready — one that
 * can prove a file before one that cannot, then one whose plan has every file it needs (a recomp that waits for a data
 * pack builds nothing a player can start), then a recomp, a port, an emulator. A way that needs no game file is built as
 * it is. A game that was asked for in one version (games.want_platform) is searched for only through a way whose game
 * file is of that platform; with none, its own search looks for that version.
 */
export function requestWay(game: Pick<GameRow, "id"> & { want_platform?: string | null }): WayRow | null {
  const cur = currentPackage(game.id);
  if (cur && cur.kind !== "rom") return null;
  const only = wantedPlatform(game.want_platform);
  const picks = waysOfGame(game.id).flatMap(w => {
    const p = getPlan(w.plan_id);
    if (!p || p.status !== "ready" || automaticProblem(p, w)) return [];
    const c = wayContent(w, p);
    if (c?.platform === "pc") return [];
    if (only && c?.platform !== only) return [];
    return [{ w, p, proves: !c || canProve(c), needs: planNeeds(p).met }];
  });
  picks.sort((a, b) => Number(b.proves) - Number(a.proves) || Number(b.needs) - Number(a.needs) || KIND_RANK[a.p.kind] - KIND_RANK[b.p.kind] || a.w.id - b.w.id);
  return picks[0]?.w ?? null;
}

/** why a way's file cannot be searched for now (the route's 409), or null; a file a search brought that waits for a look
 *  is the way's to judge (heldFor) */
export function findRefusal(w: WayRow, p: PlanRow): string | null {
  const wrong = scopeProblem(p, w.game_id);
  if (wrong) return wrong;
  if (assembling(w.id)) return "the way is being built";
  if (p.status !== "ready") return `the plan is ${p.status}${p.status_note ? ` (${p.status_note})` : ""}: check it before its game file is looked for`;
  const c = wayContent(w, p);
  if (!c) return "this way needs no game file: build it";
  if (c.platform === "pc") return "this way's game file is PC data: upload it, or pick it on the server";
  const file = w.content_id != null ? getContent(w.content_id) : null;
  if (file && existsSync(file.path) && contentMatches(c, contentFacts(file)).ok) return `the way has its game file already (${file.name})`;
  return null;
}

/** what keeps a way that has its game file from being built by itself now, or null (a running build is followed instead) */
export function buildBlocker(w: WayRow, p: PlanRow): string | null {
  if (p.status !== "ready") return `its plan is ${p.status}${p.status_note ? ` (${p.status_note})` : ""}: check the plan first`;
  const needs = planNeeds(p);
  if (!needs.met) return `it needs ${needs.missing.map(m => m.name).join(", ")} before it can be built: add it on the plan`;
  const cur = currentPackage(w.game_id);
  if (cur?.kind === "native") return "the game has a PC copy, and building this way would replace it: build it from the game page";
  if (cur && cur.kind !== "rom" && cur.pkg.id !== w.package_id) return "the game has another way to play built: build this one from the game page to replace it";
  return null;
}

/* ─────────── the serials a way accepts ─────────── */

const SAFE_SERIAL = /^[A-Za-z0-9_.-]{1,32}$/;
/** where the catalog keeps a console's serials: PS2 in PCSX2's game index (its retail routes; a demo's serial is its own) */
const SERIAL_SOURCE: Partial<Record<PlatformId, string>> = { ps2: "compat-pcsx2" };
/** the consoles whose dump-list serials a way takes in (discs: a cartridge's header is too easily kept by a hack) */
const SERIALS_FROM_DAT = new Set<PlatformId>(["ps1", "ps2", "gc", "wii"]);

const cq = {
  routeSerials: db.query("SELECT content_json FROM routes WHERE title_id=? AND source=? AND provenance='retail'"),
  gametdb: db.query("SELECT value, source FROM title_ids WHERE title_id=? AND scheme='gametdb'"),
  named: db.query("SELECT DISTINCT t.id, t.year, t.game_id FROM title_names n JOIN titles t ON t.id=n.title_id WHERE n.norm=?"),
};

/** a title's serials for the console, from the catalog sources that are switched on (a source switched off is not asked) */
function titleSerials(titleId: number, platform: PlatformId, active: Set<string>): string[] {
  const out: string[] = [];
  const source = SERIAL_SOURCE[platform];
  if (source && active.has(source)) for (const r of cq.routeSerials.all(titleId, source) as { content_json: string | null }[]) {
    let s: unknown = null;
    try { s = r.content_json ? (JSON.parse(r.content_json) as { accept?: { serials?: unknown } }).accept?.serials : null; } catch { /* none */ }
    if (Array.isArray(s)) for (const x of s) if (typeof x === "string" && SAFE_SERIAL.test(x) && !out.includes(x)) out.push(x);
  }
  if (platform === "gc" || platform === "wii") for (const r of cq.gametdb.all(titleId) as { value: string; source: string | null }[]) if (r.source && active.has(r.source) && SAFE_SERIAL.test(r.value) && !out.includes(r.value)) out.push(r.value);
  return out;
}

/**
 * The serials the catalog holds for the game on this console: its own title's, else those of the one title known by
 * exactly its name (or an alias) that no other library game holds and whose year, when it has one, is the game's — a
 * compatibility list knows no year, and sorts its titles by name. Two such titles: neither (which one is the game is not
 * certain).
 */
export function catalogSerials(game: GameRow, platform: PlatformId): string[] {
  if (!SERIAL_SOURCE[platform] && platform !== "gc" && platform !== "wii") return [];
  const active = fdeps.activeSources();
  if (game.title_id != null) { const own = titleSerials(game.title_id, platform, active); if (own.length) return own.slice(0, 50); }
  const year = game.release_year ?? (game.release_iso && /^\d{4}/.test(game.release_iso) ? Number(game.release_iso.slice(0, 4)) : null);
  const found = new Map<number, string[]>();
  for (const n of new Set([game.name, ...gameAliases(game)].map(normName).filter(Boolean))) {
    for (const t of cq.named.all(n) as { id: number; year: number | null; game_id: number | null }[]) {
      if (found.has(t.id) || (t.game_id != null && t.game_id !== game.id) || (t.year != null && year != null && Math.abs(t.year - year) > 1)) continue;
      const s = titleSerials(t.id, platform, active);
      if (s.length) found.set(t.id, s);
    }
  }
  return found.size === 1 ? [...found.values()][0].slice(0, 50) : [];
}

/** the forms two serials are compared in: a disc's game id (GZLE01) is its four-letter code too (GZLE, DL-DOL-GZLE-USA) */
const looseKeys = (platform: string, s: string) => serialKeys(platform, s).flatMap(k => (k.startsWith("ID:") ? [k, `CODE:${k.slice(3, 7)}`] : [k]));
/** are these the same serial, in any spelling (SLUS_216.78 = SLUS-21678; GZLE01 = DL-DOL-GZLE-USA) */
export const sameSerial = (platform: string, a: string, b: string): boolean => { const ka = looseKeys(platform, a); return looseKeys(platform, b).some(k => ka.includes(k)); };
/** the serials a way accepts with `add` joined (each once, in any spelling), never one in `dropped` */
function mergeSerials(platform: string, current: string[], add: string[], dropped: string[] = []): string[] {
  const out = [...current];
  for (const s of add) if (!out.some(x => sameSerial(platform, x, s)) && !dropped.some(d => sameSerial(platform, d, s))) out.push(s);
  return out.slice(0, 50);
}

/** a way's own game file plan with the catalog's serials for the game added (a new emulator way's, as it is made) */
export function withCatalogSerials(c: ContentPlan, game: GameRow): ContentPlan {
  if (c.accept.serials?.length) return c;
  const add = catalogSerials(game, c.platform);
  if (!add.length) return c;
  return { ...c, accept: { ...c.accept, serials: mergeSerials(c.platform, c.accept.serials ?? [], add) } };
}

/**
 * When the admin looks for a way's file (find-files): the serials the catalog and the console's dump list give the game
 * (the list's retail entries; discs only) added to an emulator way's own content, where the admin sees them — never one
 * the admin took off the way (a recomp's or a port's content is its plan's, and says which exact files it takes).
 * Returns how many were added.
 */
export async function refreshSerials(way: WayRow, game: GameRow, log: (line: string) => void = () => {}): Promise<number> {
  const plan = getPlan(way.plan_id);
  const content = plan ? wayContent(way, plan) : null;
  if (!plan || !content || !way.content_json || scopeProblem(plan, game.id) || planSpec(plan).content?.accept.serials?.length) return 0;
  const dat = SERIALS_FROM_DAT.has(content.platform) ? await loadDat(content.platform, log, { wait: false }).catch(() => null) : null;
  const add = [...catalogSerials(game, content.platform), ...(dat ? entrySerials(gameEntries(dat, contentNames(content, game)), content.platform) : [])];
  const before = content.accept.serials ?? [];
  const serials = mergeSerials(content.platform, before, add, droppedSerials(way));
  if (serials.length === before.length) return 0;
  const v = validateWayContent({ ...content, accept: { ...content.accept, serials } }, plan.kind);
  if (!v.ok || !v.value) return 0;
  updateWay(way.id, { content: v.value });
  settleWay(way.id);
  log(`${plan.name}: ${serials.length - before.length} serial(s) the catalog and the dump list give the game, added to what the way accepts`);
  return serials.length - before.length;
}

/** the admin's edit of a way's own content: a serial it took off is remembered, and no catalog or dump list puts it back
 *  (one it writes again is forgotten) */
export function recordDroppedSerials(w: WayRow, before: ContentPlan | null, after: ContentPlan | null): void {
  const platform = after?.platform ?? before?.platform ?? "";
  const was = before?.accept.serials ?? [], now = after?.accept.serials ?? [];
  const kept = (s: string) => now.some(x => sameSerial(platform, x, s));
  const dropped = [...droppedSerials(w).filter(d => !kept(d)), ...was.filter(s => !kept(s))];
  const value = dropped.length ? JSON.stringify([...new Set(dropped)].slice(-200)) : null;
  if (value !== (w.dropped_serials_json ?? null)) wstmts.setDroppedSerials.run(value, w.id);
}

/* ─────────── what a content pass asks ─────────── */

/** the names a way's game file is searched and judged by: the way's for the original game, then the game's own */
export function contentNames(c: ContentPlan, game: GameRow): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const n of [...c.search, ...gameAliases(game), game.name]) { const t = n.replace(/\s+/g, " ").trim(), k = t.toLowerCase(); if (t && !seen.has(k)) { seen.add(k); out.push(t); } }
  return out.slice(0, 12);
}

/** words that make a description say no to something, or limit it ("not the demo", "beta builds won't boot", "prototype
 *  dumps can't be used", "retail only", "hack-free"): such a description asks for no dump tag at all */
const REFUSING = /\b(no|not|non|never|nor|neither|none|without|except|excluding|excludes?|instead|rather|avoid(?:s|ed)?|only|retail|free|refuse[sd]?|reject(?:s|ed)?|unsupported|unplayable|broken|can'?t|cannot|won'?t|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|shouldn'?t|wouldn'?t|couldn'?t|mustn'?t|lacks?|fails?)\b/i;
/** the parts of a way's own description (its what and search names) that may ask for something: none that says no, the
 *  game's own names left out of that test ("Never Alone prototype build" says no to nothing) */
function askingTexts(c: ContentPlan, game?: GameRow | null): string[] {
  const own = game ? [game.name, ...gameAliases(game)].filter(Boolean).sort((a, b) => b.length - a.length) : [];
  const bare = (t: string) => own.reduce((s, n) => s.split(n.toLowerCase()).join(" "), t.toLowerCase().replace(/[’‘`]/g, "'"));
  return [c.what, ...c.search].filter(t => !REFUSING.test(bare(t)));
}

/** the words a way's own description uses (its what and search names) when it says no to nothing, leaving out the game's
 *  own names (a game called "Prototype" asks for no prototype): a dump tag in them is one the way wants ("Dinosaur Planet
 *  prototype ROM") */
export function askedWords(c: ContentPlan, game?: GameRow | null): string[] {
  const own = new Set(game ? [game.name, ...gameAliases(game)].flatMap(tokens) : []);
  const out = new Set<string>();
  for (const text of askingTexts(c, game)) for (const t of tokens(text)) if (!own.has(t)) out.add(t);
  return [...out];
}

/** the disc the way's own description asks for ("disc 2 of the game"), or null for the game's first disc */
export function askedDisc(c: ContentPlan, game?: GameRow | null): number | null {
  for (const t of askingTexts(c, game)) { const m = /\bdis[ck][\s_-]*0*(\d{1,2})\b/i.exec(t); if (m && Number(m[1]) > 1) return Number(m[1]); }
  return null;
}

export interface ContentPass {
  way: WayRow; plan: PlanRow; content: ContentPlan;
  /** the names to search and judge by, the words its description asks for */
  names: string[]; asked: string[];
  /** the disc the way asks for; null: the game's first */
  disc: number | null;
  /** can the way prove a file once it is here (a dump that names no console may then be taken) */
  proves: boolean;
  dat: Dat | null;
}

/**
 * What a way's content pass works with: its game file plan, its names, what it asks for, and the console's dump list as it
 * is kept on the server (`wait: false`, a search: a missing or old list is fetched in the background, never waited for).
 * It changes nothing. Null when the way's game file plan is gone.
 */
export async function prepareContentPass(way: WayRow, game: GameRow, log: (line: string) => void = () => {}, opts: { wait?: boolean } = {}): Promise<ContentPass | null> {
  const plan = getPlan(way.plan_id);
  const content = plan ? wayContent(way, plan) : null;
  if (!plan || !content || scopeProblem(plan, game.id)) return null;
  const dat = await loadDat(content.platform, log, { wait: opts.wait !== false }).catch(() => null);
  const names = contentNames(content, game);
  const proves = content.accept.hashes.length > 0 || provesByIdentity(content) || (!!dat && gameEntries(dat, names).length > 0);
  return { way, plan, content, names, asked: askedWords(content, game), disc: askedDisc(content, game), proves, dat };
}

/** the search a content pass runs (src/requests.ts sends it through its searcher) */
export function contentQuery(pass: ContentPass, game: GameRow): { name: string; year: number | null; opts: SearchOptions } {
  const year = game.release_year ?? (game.release_iso && /^\d{4}/.test(game.release_iso) ? Number(game.release_iso.slice(0, 4)) : null);
  const p = pass.content.platform;
  return {
    name: pass.names[0] ?? game.name, year,
    opts: { thorough: true, aliases: pass.names.slice(1), terms: [...new Set([...list(game.search_terms_json), ...(pass.content.terms ?? [])])], categories: CONSOLE_CATEGORIES, platforms: [p], known: [p], unnamed: pass.proves, asked: pass.asked },
  };
}

/**
 * What a way's content pass would take from the indexers now — with other names, formats, serials or versions when given
 * (the AI asks "would this find it?") — and why each release it would not take is passed over. Nothing is grabbed, nothing
 * is written: the same search, blocklist and judging a request runs.
 */
export async function previewContentPass(way: WayRow, o: { names?: string[]; formats?: string[]; serials?: string[]; versions?: string[] } = {}): Promise<PassPreview> {
  const game = stmts.gameById.get(way.game_id) as GameRow | undefined;
  if (!game) throw new Error("the way's game is gone");
  const base = await prepareContentPass(way, game, () => {}, { wait: false });
  if (!base) throw new Error("the way needs no game file, or its plan is gone");
  const clean = (xs: string[] | undefined) => (xs ?? []).map(x => String(x).trim()).filter(Boolean).slice(0, 20);
  const content: ContentPlan = {
    ...base.content,
    ...(clean(o.names).length ? { search: clean(o.names) } : {}),
    accept: {
      ...base.content.accept,
      ...(o.formats ? { formats: clean(o.formats).map(f => f.replace(/^\./, "").toLowerCase()) } : {}),
      ...(o.serials ? { serials: clean(o.serials) } : {}),
      ...(o.versions ? { versions: clean(o.versions) } : {}),
    },
  };
  const pass: ContentPass = { ...base, content, names: contentNames(content, game), asked: askedWords(content, game), disc: askedDisc(content, game), proves: base.proves || canProve(content) };
  const q = contentQuery(pass, game);
  const ranked = (await fdeps.search(q.name, q.year, q.opts)).ranked;
  const x = { profile: profileFor(game), preferUsenet: await fdeps.usenetAvailable(), blocked: wayBlocked(game.id, way.id, content), tried: new Set<string>() };
  const max = Math.max(1, cfgNum("SEARCH_MAX_CANDIDATES", 4));
  const order = judgeContent(ranked, pass, x).map(r => r.guid);
  const shown = [...ranked].sort((a, b) => (order.indexOf(a.guid) + 1 || 1e9) - (order.indexOf(b.guid) + 1 || 1e9)).slice(0, 40);
  return {
    names: pass.names, platform: content.platform,
    candidates: shown.map(r => {
      const at = order.indexOf(r.guid);
      const why = at >= 0 ? (at < max ? `it would be tried ${at === 0 ? "first" : `as candidate ${at + 1}`}` : `it would be tried after the first ${max}`) : contentRefusal(r, pass, x) ?? "not taken";
      return { title: r.title, size: r.size ?? null, indexer: r.indexer ?? null, take: at >= 0 && at < max, why };
    }),
  };
}

/* ─────────── which candidates a content pass takes ─────────── */

/** the sizes a console's game files come in, a little either way (a release may be packed): anything else is not one */
export const SIZE_RANGE: Partial<Record<PlatformId, [number, number]>> = {
  nes: [8 * KB, 8 * MB], snes: [64 * KB, 16 * MB], n64: [512 * KB, 128 * MB], gb: [8 * KB, 16 * MB], gbc: [8 * KB, 16 * MB], gba: [64 * KB, 64 * MB],
  nds: [1 * MB, 1 * GB], "3ds": [16 * MB, 8 * GB], genesis: [64 * KB, 16 * MB], gc: [16 * MB, 2 * GB], wii: [16 * MB, 10 * GB], wiiu: [256 * MB, 32 * GB],
  ps1: [1 * MB, 3 * GB], ps2: [16 * MB, 10 * GB], psp: [1 * MB, 2 * GB], dc: [16 * MB, 2 * GB], saturn: [1 * MB, 3 * GB], xbox: [128 * MB, 10 * GB], x360: [128 * MB, 16 * GB],
  ps3: [1 * GB, 64 * GB], ps4: [1 * GB, 200 * GB], ps5: [1 * GB, 200 * GB], switch: [64 * MB, 64 * GB],
};

const hasWord = (title: string, words: string[]) => words.some(w => title.toLowerCase().includes(w.toLowerCase()));

/** a release title that says its data is sealed for the console, for a way that takes neither it nor makes from it: a
 *  PlayStation 4 or 5 disc image ("Full ISO", ".iso") or package, a Switch NSP or XCI (a scene "NSW" release is one) */
export function sealedTitle(title: string, c: ContentPlan): string | null {
  const takes = new Set([...(c.accept.formats ?? []), ...(c.make?.input.formats ?? [])].map(f => f.toLowerCase()));
  if (c.platform === "ps4" || c.platform === "ps5") {
    if (!takes.has("iso") && (/\bfull[\s._-]*iso\b/i.test(title) || /\.iso\s*$/i.test(title)))
      return `a ${label(c.platform)} disc image: the disc holds the game encrypted for the console, and nothing can open it`;
    if (!takes.has("pkg") && /\b(f?pkg)\b/i.test(title)) return `a ${label(c.platform)} package (PKG): its game data is encrypted for the console`;
  }
  if (c.platform === "switch" && !["nsp", "xci", "nsz", "xcz"].some(f => takes.has(f)) && (/\b(nsp|xci|nsz|xcz)\b/i.test(title) || /(^|[\s._-])NSW([\s._-]|$)/.test(title)))
    return "an NSP or XCI: its game data is encrypted for the console";
  return null;
}

/** why a content pass would not take a release, or null when it would (judgeContent's test, in words) */
export function contentRefusal(r: ReleaseView, pass: Pick<ContentPass, "content" | "proves" | "names"> & Partial<Pick<ContentPass, "disc">>, x: { profile: Profile; blocked: Set<string>; tried: Set<string>; now?: number }): string | null {
  const now = x.now ?? Date.now();
  const c = pass.content, profile = x.profile;
  const range = SIZE_RANGE[c.platform];
  const wanted = [...new Set((c.accept.regions ?? []).map(regionKey).filter((k): k is string => !!k))];
  if (!certainlyThisGame(r)) return r.flags.wrongKind ?? "not certainly this game by its title";
  if (r.parsed.junk.length) return `its title marks it as ${r.parsed.junk.join(", ")}`;
  if (!(r.downloadUrl || r.magnetUrl)) return "it has no download link";
  if (r.flags.platform ? r.flags.platform !== c.platform : !pass.proves) return r.flags.platform ? `a ${label(r.flags.platform)} release, and this way plays ${label(c.platform)} games` : "it names no console, and this way cannot prove a file by itself";
  if (x.blocked.has(r.guid) || x.blocked.has(r.title)) return "it is on the blocklist for the game or this way";
  if (x.tried.has(r.guid)) return "this search tried it already";
  const disc = discNumber(r.title);
  if (disc != null && disc > 1 && disc !== (pass.disc ?? null)) return `disc ${disc} of the game`;
  if (r.score < profile.minScore) return `it scores ${r.score}, below the profile's ${profile.minScore}`;
  if (range && (r.size ? r.size < range[0] || r.size > range[1] : !r.flags.platform)) return r.size ? `${sizeText(r.size)} is not a size ${label(c.platform)} games come in` : "no size is given, and nothing in its title names the console";
  if (profile.protocol === "usenet" && r.protocol !== "usenet") return "the profile takes usenet only";
  if (profile.protocol === "torrent" && r.protocol !== "torrent") return "the profile takes torrents only";
  if (profile.maxSizeGb != null && r.size && r.size > profile.maxSizeGb * GB) return `larger than the profile's ${profile.maxSizeGb} GB`;
  // a torrent posted hours ago with no seeders yet is still being announced (src/requests.ts justPosted)
  if (r.protocol === "torrent" && r.seeders != null && r.seeders < Math.max(1, profile.minSeeders) && !(profile.minSeeders === 0 && now - Date.parse(r.publishDate ?? "") < 12 * 3600_000)) return `${r.seeders} seeder${r.seeders === 1 ? "" : "s"}`;
  if (profile.mustContain.length && !hasWord(r.title, profile.mustContain)) return "its title lacks the profile's required words";
  if (hasWord(r.title, profile.mustNotContain)) return "its title holds a word the profile refuses";
  if (r.parsed.group && profile.blockedGroups.some(g => g.toLowerCase() === r.parsed.group!.toLowerCase())) return `the profile refuses the group ${r.parsed.group}`;
  const sealed = sealedTitle(r.title, c);
  if (sealed) return sealed;
  if (regionRank(regionsOf(r.title, new Set(pass.names.flatMap(tokens))), wanted) == null) return `another region than the way takes (${wanted.join(", ")})`;
  return null;
}

/**
 * The candidates a content pass may grab, best first: certainly the game under one of the way's names (a dump that names
 * no console only for a way that proves files — the search judged it so — and only at a size the console's games come
 * in), not junk, not another disc than the one the way takes, grabbable, not blocked for the game or this way nor tried
 * by this request, as the profile allows (protocol, size, seeders, words, groups, score), never sealed for the console in a
 * form the way does not take; then the way's regions first (other regions never), the profile's preferred groups and
 * protocol, the score. The profile's console-dump switch is about a dump kept as the game's copy: a way's game file is
 * built into the way, and is looked for either way.
 */
export function judgeContent(ranked: ReleaseView[], pass: Pick<ContentPass, "content" | "proves" | "names"> & Partial<Pick<ContentPass, "disc">>, x: { profile: Profile; preferUsenet: boolean; blocked: Set<string>; tried: Set<string>; now?: number }): ReleaseView[] {
  const c = pass.content, profile = x.profile;
  const wanted = [...new Set((c.accept.regions ?? []).map(regionKey).filter((r): r is string => !!r))];
  const nameWords = new Set(pass.names.flatMap(tokens));
  const rank = new Map<ReleaseView, number>();
  const ok = ranked.filter(r => {
    if (contentRefusal(r, pass, x) != null) return false;
    rank.set(r, regionRank(regionsOf(r.title, nameWords), wanted) ?? 0);
    return true;
  });
  const usenetFirst = profile.protocol === "prefer-usenet" && x.preferUsenet, torrentFirst = profile.protocol === "prefer-torrent";
  const preferred = (r: ReleaseView) => (r.parsed.group && profile.preferredGroups.some(g => g.toLowerCase() === r.parsed.group!.toLowerCase()) ? 0 : 1);
  return ok.sort((a, b) => rank.get(a)! - rank.get(b)! || preferred(a) - preferred(b)
    || ((usenetFirst || torrentFirst) && a.protocol !== b.protocol ? (a.protocol === (usenetFirst ? "usenet" : "torrent") ? -1 : 1) : 0)
    || b.score - a.score);
}

/* ─────────── judging one file against a way ─────────── */

/** what a file is for one way: proven (the way takes it by itself: `by`), refused (another game, version, console or disc,
 *  a tagged dump: `why` reads after the file's name, "<name> is …" when `is`, "<name>: …" otherwise), or nothing either way */
export interface FileVerdict { verdict: "proven" | "unproven" | "refused"; why: string; by: "hash" | "serial" | "build" | "list" | null; is?: boolean }

/** the bracketed tags of a release's title, as the words a file inside it may carry too */
const tagsOf = (title: string) => (title.match(/[\[(][^\])]*[\])]/g) ?? []).join(" ");
/**
 * Why a file's name (or, for a disc, its bytes) says it is not the file the way takes: a tag that says it was not sold as
 * the game (unless the way asks for it), or another disc than the one the way takes; null when it says nothing such. A file
 * that came in a release (`release`, its title) may carry only the tags that release itself carried: "(Beta).z64" in a
 * folder called "Beta Quest (USA)" is a beta lying beside the game, whatever the game is called; without one, the game's
 * own names spare a tag word as the search does ("Jampack Demo Disc (USA) (Demo)" is that game).
 */
export function fileTag(name: string, pass: Pick<ContentPass, "names" | "asked" | "disc">, identity?: Identity | null, release?: string | null, manual = false): string | null {
  const sold = !manual && notAsSold(name, release != null ? tagsOf(release) : pass.names.join(" "), pass.asked);
  if (sold) return sold;
  const disc = identity?.disc != null && identity.disc > 1 ? identity.disc : discNumber(name);
  if (disc != null && disc > 1 && disc !== pass.disc) return `disc ${disc} of the game, and this way takes ${pass.disc ? `disc ${pass.disc}` : "its first disc"}`;
  return null;
}

/** a file of a console whose bytes always say what they are, in a format its reader sees into, whose bytes say nothing:
 *  no game of that console (a PC disc, another console's DVD, a renamed file); null otherwise */
export function silentFile(c: ContentPlan, name: string, identity: Identity | null | undefined): string | null {
  if (identity || !DEFINITIVE.has(c.platform) || !readsFormat(name)) return null;
  return `nothing in it reads as a ${label(c.platform)} ${c.kind === "disc" ? "disc" : "game"}`;
}

/**
 * One file (its facts: hashes, identity) against a way: an accepted hash proves it (the exact version the plan lists,
 * whatever its name says); otherwise a name tag or another disc refuses it, the dump list refuses what it knows as anything
 * but the game as it was sold, and an accepted serial or the list's retail entry proves it. A header's title never does.
 * What nothing proves is refused when its bytes are no game of the way's console at all (silentFile; `stored`: a file
 * already kept was read as it came in, so its missing identity says nothing more now), and otherwise kept for the admin.
 */
export function judgeFile(pass: Pick<ContentPass, "content" | "names" | "asked" | "disc" | "dat">, name: string, facts: FileFacts, release?: string | null, opts: { stored?: boolean; manual?: boolean } = {}): FileVerdict {
  const c = pass.content, identity = facts.identity ?? null;
  const v = contentMatches(c, facts);
  if (!v.ok) return { verdict: "refused", why: v.why ?? "not the file this way takes", by: null, is: true };
  if (v.matched) return { verdict: "proven", why: `its ${v.matched.algo} is one the way accepts${v.matched.label ? ` (${v.matched.label})` : ""}`, by: "hash" };
  const tag = fileTag(name, pass, identity, release, opts.manual);
  if (tag) return { verdict: "refused", why: tag, by: null };
  const d = pass.dat ? datVerdict(pass.dat, facts.hashes, facts.rawHashes, pass.names, pass.asked, { disc: pass.disc }) : null;
  // the dump list knows these bytes as another game, a demo, a beta, a bonus disc or another disc: refused, serial or not
  if (d?.kind === "other") return { verdict: "refused", why: d.why ?? "the dump list knows it as another game", by: null };
  const shown = shownSerial(identity);
  if (v.serial) return { verdict: "proven", why: `its ${serialWord(c.platform)} ${shown} is one the way accepts`, by: "serial" };
  if (v.build) return { verdict: "proven", why: `its main program's build ${v.build.slice(0, 8)}… is one the way accepts`, by: "build" };
  if (d?.kind === "game") return { verdict: "proven", why: `the dump list knows it as ${d.entry!.name}`, by: "list" };
  const silent = opts.stored ? null : silentFile(c, name, identity);
  if (silent) return { verdict: "refused", why: silent, by: null };
  const header = identity?.internalName ? `its header says "${identity.internalName}"${shown ? ` (${serialWord(c.platform)} ${shown})` : ""}` : shown ? `its ${serialWord(c.platform)} is ${shown}` : "nothing in it says which game it is";
  return { verdict: "unproven", why: `${header}, and nothing the way accepts proves it is the game${v.unchecked ? ` (${v.unchecked})` : ""}${d?.kind === "unknown" ? `; ${d.why}` : ""}`, by: null };
}
const said = (name: string, j: FileVerdict) => (j.verdict === "refused" ? (j.is ? `${name} is ${j.why}` : `${name}: ${j.why}`) : j.why);

/**
 * The files a search brought for the game's ways of this console that nothing could prove (each waits for the admin),
 * as this way sees them: one it proves becomes its file now; one it turns down is no file for it; one it cannot tell
 * apart either holds its search (no search fetches another such file while one waits). Returns the file that holds the
 * way's search, or null (with `attached` when one became its file).
 */
export function heldFor(pass: ContentPass): { holds: ContentRow | null; attached: ContentRow | null } {
  const way = getWay(pass.way.id) ?? pass.way;
  for (const f of heldFiles(way.game_id, pass.content.platform)) {
    const j = judgeFile(pass, f.name, contentFacts(f), null, { stored: true });
    if (j.verdict === "refused") continue;
    if (j.verdict === "proven") {
      if (assembling(way.id)) return { holds: null, attached: null };
      updateWay(way.id, { contentId: f.id });
      settleWay(way.id);
      return { holds: null, attached: f };
    }
    return { holds: f, attached: null };
  }
  return { holds: null, attached: null };
}

/* ─────────── taking the game file from a download ─────────── */

/** what a content job that read a download says: the file proven and kept (and the build it queued, or why none), or kept
 *  for the admin because nothing could prove it; a download it refuses fails the job instead (NotTheGameFile). `made`: the
 *  way's file was made from what the download held (its make ran in the same job) */
export interface TakeOutcome {
  outcome: "proven" | "kept";
  wayId: number;
  contentId: number;
  file: string;
  by?: FileVerdict["by"];
  assembleJobId?: number | null;
  why?: string | null;
  made?: boolean;
}

/** what a content job's failure says when the download holds no file the way takes — the release is the way's to refuse
 *  (src/requests.ts blocklists it for that way); any other failure is no verdict on the release */
export const NOT_THE_FILE = "not the game file: ";
/** cls: 'identity' the download holds another title, version, a patch or a sealed file (never fetched again for the way);
 *  'form' it holds nothing in a form the way takes now (fetched again once the way's game file plan changes) */
export class NotTheGameFile extends Error {
  constructor(why: string, public cls: "identity" | "form" = "identity") { super(NOT_THE_FILE + why); }
  /** a verdict on the file (src/ways/errors.ts failOf); kind 'form' when only its form was refused */
  get fail(): FailInfo { return this.cls === "form" ? { class: "file", kind: "form" } : { class: "file" }; }
}
export const refusedDownload = (message: string | null | undefined): boolean => !!message?.startsWith(NOT_THE_FILE);
/** a proven file for a way whose build is queued or running: taken once that build ends (the request tries again) */
export const WAY_BUSY = "the way is being built: its game file is taken once that build ends";

const ARCHIVE = /\.(zip|7z|rar|001)$/i;
/** a console's game files as the content store keeps them, by extension */
const DUMP_EXT: Partial<Record<PlatformId, string[]>> = {
  n64: ["z64", "n64", "v64"], snes: ["sfc", "smc"], nes: ["nes", "fds", "unf"], gb: ["gb"], gbc: ["gbc", "gb"], gba: ["gba"], nds: ["nds"], "3ds": ["3ds", "cia", "cci"],
  genesis: ["md", "gen", "bin", "smd"], gc: ["iso", "gcm", "rvz", "wia", "ciso", "gcz"], wii: ["iso", "wbfs", "rvz", "wia", "ciso", "gcz"],
  ps1: ["bin", "iso", "img", "chd", "ecm", "pbp"], ps2: ["iso", "bin", "img", "chd", "cso", "zso"], psp: ["iso", "cso", "pbp"], dc: ["cdi", "chd"],
  saturn: ["chd", "iso", "bin"], xbox: ["iso", "xiso"], x360: ["iso"], wiiu: ["wux", "wud", "wua"], switch: ["nsp", "xci", "nsz", "xcz"], vita: ["vpk"],
};
const extOf = (n: string) => (n.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
/** the extensions a way's game file comes in (its formats; an N64 dump in any byte order) */
function dumpExts(c: ContentPlan): Set<string> {
  if (c.kind === "folder") return new Set();
  const formats = c.accept.formats ?? [];
  if (formats.length) return new Set([...formats, ...(c.platform === "n64" ? ["z64", "n64", "v64"] : [])]);
  return new Set(DUMP_EXT[c.platform] ?? (ROM_EXT.source.match(/\(([^)]*)\)/)?.[1] ?? "").split("|"));
}
/** what a way's make takes as a file (its input formats: an archive, a .nup …), taken as it is, never unpacked here */
const inputExts = (c: ContentPlan): Set<string> => new Set(c.make && c.make.input.shape !== "folder" ? (c.make.input.formats ?? []).map(f => f.toLowerCase()) : []);
/** the files that say a folder is the way's game folder (kind 'folder') or what its make takes */
function markersOf(c: ContentPlan): { marker: string; also: string[]; role: "product" | "input" }[] {
  const out: { marker: string; also: string[]; role: "product" | "input" }[] = [];
  if (c.kind === "folder" && c.marker) out.push({ marker: c.marker, also: c.also ?? [], role: "product" });
  if (c.make?.input.marker && c.make.input.shape !== "file") out.push({ marker: c.make.input.marker, also: c.make.input.also ?? [], role: "input" });
  return out;
}
const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

interface Found { path: string; name: string; size: number }
interface FoundFolder extends Found { role: "product" | "input"; marker: string }
interface Scanned { dumps: Found[]; inputs: Found[]; folders: FoundFolder[]; archives: Found[] }

/** a folder holds marker (and its also-files) as plain files: one lstat each, never a walk */
async function holds(dir: string, m: { marker: string; also: string[] }): Promise<boolean> {
  for (const rel of [m.marker, ...m.also]) {
    const at = join(dir, ...rel.split("/"));
    const st = await lstat(at).catch(e => { noteTrouble(at, e); return null; });
    if (!st?.isFile()) return false;
  }
  return true;
}

/** the game files, what a way's make takes (files, and folders holding its marker), and the archives (first volumes) under a
 *  path, a few folders deep, links never followed. Every folder is looked at for a marker by one lstat before it is walked,
 *  whatever the file walk has seen: the files are walked up to 5,000, but a folder that holds a marker is still found — a
 *  game folder of 117,000 files whose sce_sys sorts last, or one that sorts after a big folder beside it. At most 20,000
 *  folders are looked at */
async function scan(root: string, exts: Set<string>, ins: Set<string>, markers: { marker: string; also: string[]; role: "product" | "input" }[]): Promise<Scanned> {
  const out: Scanned = { dumps: [], inputs: [], folders: [], archives: [] };
  let files = 0, dirs = 0;
  const onFile = (p: string, size: number) => {
    const name = basename(p), e = extOf(name);
    if (exts.has(e)) out.dumps.push({ path: p, name, size });
    else if (ins.has(e) || (ins.has("rar") && /\.part0*1\.rar$/i.test(name))) { if (!SECONDARY_PART.test(name)) out.inputs.push({ path: p, name, size }); }
    else if (ARCHIVE.test(name) && !SECONDARY_PART.test(name)) out.archives.push({ path: p, name, size });
  };
  const visitDir = async (p: string, depth: number) => {
    if (++dirs > 20_000) return;
    for (const m of markers) if (await holds(p, m)) { out.folders.push({ path: p, name: basename(p), size: 0, role: m.role, marker: m.marker }); return; }
    if (depth >= 4) return;
    // a folder that cannot be read is recorded as the seedbox folder's trouble when it is on it (src/remote.ts): a refusal
    // made from what such a walk did not see is then no refusal (steadyOrThrow)
    const entries = (await readdir(p, { withFileTypes: true }).catch(e => { noteTrouble(p, e); return [] as Dirent[]; })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of entries) {
      const at = join(p, d.name);
      // a share that does not say what an entry is: its lstat does
      const st = d.isDirectory() || d.isFile() || d.isSymbolicLink() ? null : await lstat(at).catch(e => { noteTrouble(at, e); return null; });
      if (d.isSymbolicLink() || st?.isSymbolicLink()) continue;
      if (d.isDirectory() || st?.isDirectory()) await visitDir(at, depth + 1);
      else if ((d.isFile() || st?.isFile()) && ++files <= 5000) { const f = st ?? (await lstat(at).catch(e => { noteTrouble(at, e); return null; })); if (f?.isFile()) onFile(at, f.size); }
    }
  };
  const st = await lstat(root).catch(e => { noteTrouble(root, e); return null; });
  if (!st || st.isSymbolicLink()) return out;
  if (st.isDirectory()) await visitDir(root, 0);
  else if (st.isFile()) onFile(root, st.size);
  return out;
}

/** the scratch a download's content job needs: its archives unpacked (three times their size, as an import counts), and,
 *  for a way whose game file is made from what it holds, the made file (about the download's own size) */
export async function downloadScratch(path: string, wayId: number | null = null): Promise<number> {
  const st = await stat(path).catch(() => null);
  if (!st) return 0;
  const way = wayId != null ? getWay(wayId) : null;
  const plan = way ? getPlan(way.plan_id) : null;
  const makes = !!(way && plan && wayContent(way, plan)?.make);
  if (st.isFile()) return (ARCHIVE.test(path) || SECONDARY_PART.test(path) ? 3 * st.size : 0) + (makes ? st.size : 0);
  let packed = 0, all = 0, seen = 0;
  const visit = async (p: string, depth: number) => {
    if (++seen > 5000) return;
    const s = await lstat(p).catch(() => null);
    if (!s || s.isSymbolicLink()) return;
    if (s.isDirectory()) { if (depth < 4) for (const n of await readdir(p).catch(() => [] as string[])) await visit(join(p, n), depth + 1); return; }
    all += s.size;
    if (ARCHIVE.test(p) || SECONDARY_PART.test(p)) packed += s.size;
  };
  await visit(path, 0);
  return 3 * packed + (makes ? all : 0);
}

/** an archive its archiver ran on and turned down (corrupt, cut short, locked with a password): the release's fault */
class Unpackable extends Error {}

/** an archive unpacked in the build sandbox (its program never runs as ludarr) into a folder of the job's scratch, once
 *  there is room for what it holds (the library volume keeps LIBRARY_KEEP_FREE_GB free besides). The archiver says nothing
 *  until it ends, so how much it has written so far is said every few seconds, from the scratch volume's free space */
async function unpack(a: Found, out: string, ctx: KindContext, game: GameRow, expected: number | null, packed: number): Promise<void> {
  await mkdir(out, { recursive: true });
  const lib = rootFolderFor(game);
  await ensureRoom(out, a.size, { library: !!lib && (await ctdeps.sameVolume(out, lib.path)) });
  const note = expected ? `about ${sizeText(expected)} unpacked` : `the archive is ${sizeText(packed)}`;
  ctx.log(`unpacking ${a.name} (${note})`);
  ctx.progress(0.03, `unpacking ${a.name}`);
  const start = await ctdeps.diskSpace(out).catch(() => null);
  const timer = setInterval(() => {
    void ctdeps.diskSpace(out).catch(() => null).then(now => {
      const written = start && now ? Math.max(0, start.free - now.free) : null;
      ctx.progress(0.03 + 0.02 * Math.min(1, (written ?? 0) / Math.max(1, expected ?? a.size)), written != null ? `unpacking ${a.name} · ${sizeText(written)} written so far (${note})` : `unpacking ${a.name}`);
    });
  }, fdeps.unpackEvery);
  await handTo(out, "builder");
  try { await fdeps.extract({ exec: sandboxed(ctx.work), tools: pdeps.tools(), log: ctx.log, signal: ctx.signal }, a.path, out); }
  catch (e: any) {
    // a missing archiver, a timeout or a full disk is this server's, and is tried again later; an archive the archiver
    // turned down holds no file the way can take
    const msg = String(e?.message ?? e);
    if (/^(?:7z|unrar|unar) failed on /.test(msg) && !/timed out|space/i.test(msg) && !ctx.signal.aborted) throw new Unpackable(`${a.name} cannot be unpacked: ${msg}`);
    throw e;
  }
  finally { clearInterval(timer); await handTo(out, "root"); }
  await refuseLinks(out, `${a.name}`);
}

/** the game files in a download: itself, the ones in its folder, else the ones inside its archives (an archive in an
 *  archive too); what a way's make takes (an archive it unpacks itself is never unpacked here: no second unpack), and the
 *  game folders and make inputs a folder or an unpacked archive holds */
async function gameFilesIn(src: string, c: ContentPlan, ctx: KindContext, game: GameRow): Promise<Scanned> {
  const exts = dumpExts(c), ins = inputExts(c), markers = markersOf(c);
  const found = await scan(src, exts, ins, markers);
  let archives = found.archives;
  for (let level = 0; !found.dumps.length && !found.inputs.length && !found.folders.length && archives.length && level < 2; level++) {
    const next: Found[] = [];
    for (const [i, a] of archives.slice(0, 3).entries()) {
      if (ctx.signal.aborted) throw new Error("cancelled");
      // judged by its listing first, as the make judges an archive it unpacks: one its listing rules out (another game or
      // version, no game folder, a part of the game) is refused before any room is asked for or a byte is unpacked
      const judged = c.make?.input.marker && c.make.input.shape !== "file"
        ? await fdeps.judgeArchive({ path: a.path, content: c, work: ctx.work, gameId: game.id, signal: ctx.signal, log: ctx.log, progress: ctx.progress })
        : null;
      const size = judged?.bytes ? Math.max(judged.bytes, a.size) : a.size;
      // on the library when it holds the unpack and what is kept from it (the way's make: its product too); else on the
      // downloads folder's volume, and only what is kept is written on the library (a copy into the store, or the product)
      const slot = `unpacked-${level}-${i}`;
      const volumes = level === 0 ? await volumesOf(a.path) : [];
      const paths = [a.path, ...volumes];
      const key = level === 0 && ctx.spec.kind === "content" && ctx.spec.wayId ? await unpackKey(ctx.spec.wayId, paths) : null;
      let out: string | null = null;
      if (key) {
        for (const dir of [ctx.work, spareJobFolder(downloadsDir(), ctx.job.id)]) {
          if (await claimUnpacked(dir, slot, key)) {
            await closeJobFolder(dir);
            ctx.log(`using the completed extraction of ${a.name}`);
            out = join(dir, slot);
            break;
          }
        }
      }
      if (!out) {
        const where = await fdeps.unpackRoom(ctx.work, size, { here: c.make ? size : 0, away: size });
        if ("why" in where) throw new EnvError("room", where.why);
        if (where.away) ctx.log(`unpacking ${a.name} on the downloads folder's volume (${where.dir}): the library has no room for it beside what is kept from it`);
        out = join(where.dir, slot);
        let packed = a.size;
        for (const volume of volumes) packed += (await lstat(volume)).size;
        await unpack(a, out, ctx, game, judged?.bytes ?? null, packed);
        if (key && ctx.spec.kind === "content" && ctx.spec.wayId && key === await unpackKey(ctx.spec.wayId, [a.path, ...await volumesOf(a.path)])) await markUnpacked(where.dir, slot, key);
      }
      const r = await scan(out, exts, ins, markers);
      found.dumps.push(...r.dumps); found.inputs.push(...r.inputs); found.folders.push(...r.folders); next.push(...r.archives);
    }
    archives = next;
  }
  return found;
}

interface Checked extends FileVerdict { file: Found; facts: FileFacts | null; hashed?: { stat: HashedStat; rawHashes: Hashes | null; normalized: string | null } | null; row?: ContentRow | null; duplicate?: boolean }

/** the store's volume and a file's (a download's own, or one unpacked from it in the job's folder): a file there is linked
 *  in and read where it lies; else it is copied, hashed as it is copied (a file is hashed once either way) */
async function linkable(src: string, game: GameRow): Promise<boolean> {
  const root = rootFolderFor(game);
  return !!root && ctdeps.sameVolume(src, root.path);
}

/** one file of a download (from the release titled `release`) against the way: refused (another game, version, console or
 *  disc, a tagged dump), proven, or nothing either way; what can be told before the file is read through is told first, and
 *  it is read once: where it lies (`link`), or as it is copied into the store */
async function checkFile(f: Found, pass: ContentPass, release: string | null, k: { link: boolean; game: GameRow; ctx: KindContext }): Promise<Checked> {
  const c = pass.content;
  const refused = (why: string, is = false): Checked => ({ file: f, verdict: "refused", why, by: null, is, facts: null });
  const manual = k.ctx.spec.kind === "content" && k.ctx.spec.manualSelection;
  const range = !manual && SIZE_RANGE[c.platform];
  if (range && f.size < range[0]) return refused(`${sizeText(f.size)}, too small for a ${label(c.platform)} game`, true);
  if (range && f.size > range[1]) return refused(`${sizeText(f.size)}, too large for a ${label(c.platform)} game`, true);
  const identity: Identity | null = await readIdentity(f.path, c.platform, f.name);
  const named = identity && DEFINITIVE.has(identity.platform) ? identity.platform : null;
  if (named && named !== c.platform) return refused(`a ${label(named)} game, and this way plays ${label(c.platform)} games`, true);
  // sealed by its own bytes (a retail PS5 disc as a PC drive reads it, an NSP): refused before it is read through or copied
  // in to be judged — whatever the way's formats say, only a Switch NSP or XCI the way names is taken as it is (an
  // emulator opens it with its player's own keys), as contentMatches judges it
  if (identity?.sealed && !takenSealed(identity, "file", c.accept.formats ?? [], extOf(f.name))) return refused(sealedWhy(identity), identity.shape !== "nsp" && identity.shape !== "xci");
  // a way without hashes refuses a tagged name, another disc or another serial before the file is read through (its
  // format is judged once it is: an N64 dump is stored big-endian, as .z64); an accepted hash beats a name's tag
  if (!c.accept.hashes.length) {
    const tag = fileTag(f.name, pass, identity, release, manual);
    if (tag) return refused(tag);
    if ((c.accept.serials ?? []).length) {
      const v = contentMatches(c.platform === "n64" ? { ...c, accept: { ...c.accept, formats: undefined } } : c, { platform: named ?? c.platform, name: f.name, size: f.size, hashes: {}, identity });
      if (!v.ok) return refused(v.why ?? "another game", true);
    }
  }
  const say = (b: number, total: number) => k.ctx.progress(0.05 + 0.5 * Math.min(1, b / Math.max(1, total)), `checking ${f.name} · ${ofText(b, total)}`);
  // read where it lies only when it is then linked in: a store that cannot link it (one device, but no hard links across
  // the share's disks) copies it, and the copy is its one read
  if (k.link && (await linksInto(f.path, { role: "game", game: k.game }))) {
    const h = await hashInPlace(f.path, { n64: true, signal: k.ctx.signal, progress: say });
    const facts: FileFacts = { platform: named ?? c.platform, name: storedName(f.name, h.result.order), size: h.result.size, hashes: h.result.hashes, rawHashes: h.result.rawHashes ?? null, identity };
    return { file: f, facts, hashed: { stat: h.stat, rawHashes: h.result.rawHashes ?? null, normalized: h.result.normalized ?? null }, ...judgeFile(pass, f.name, facts, release, { manual }) };
  }
  // across volumes the file is read once, as it is copied in: judged on what was kept (dropped again when refused)
  const kept = await ingestFile(f.path, { role: "game", game: k.game }, { name: f.name, source: "indexer", platform: named ?? c.platform, wayPlatform: c.platform, mode: "copy", identity, signal: k.ctx.signal, progress: (b, total) => say(b, total) });
  const facts: FileFacts = { ...contentFacts(kept.row), platform: named ?? kept.row.platform ?? c.platform };
  return { file: f, facts, row: kept.row, duplicate: kept.duplicate, ...judgeFile(pass, f.name, facts, release, { manual }) };
}

/** the raw download, once its file is kept: the seeding task looks after the client's copy; ludarr's own copy goes */
async function dropDownload(src: string, log: (l: string) => void) {
  if (!ownsDownload(src, downloadsDir())) { log("download left in place: it is the client's folder, not ludarr's"); return; }
  if (cfgBool("IMPORT_KEEP_DOWNLOAD")) return;
  const left = await removeTree(src).catch(e => { log(`could not remove the download: ${e?.message ?? e}`); return [] as string[]; });
  log(left.length ? `raw download only partly removed (${left.length} entries still held open)` : "raw download removed");
}

/** a download a way's search is done with (its file kept, refused, or its way gone): the seeding task removes the
 *  client's copy as it does an import's, and ludarr's own copy goes */
export async function releaseDownload(fetchId: number | null | undefined, path: string | null | undefined, log: (l: string) => void = () => {}): Promise<void> {
  if (fetchId != null) stmts.setFetchImported.run(fetchId);
  if (path && existsSync(path)) await dropDownload(path, log);
}

/** a download a content job refuses for its way (takeDownload's refuse): let go of (`letGo`: done with) only when what was
 *  read is a verdict — read from the seedbox's folder while that was troubled it is no refusal at all (EnvError 'remote',
 *  from steadyOrThrow), and one whose own words say the read may have failed (7z ran out of time listing it, a read error)
 *  keeps the download for the request's one confirming run; NotTheGameFile either way */
export async function refuseDownload(jobId: number, why: string, cls: "identity" | "form", letGo: () => Promise<void>, log: (l: string) => void): Promise<never> {
  if ((await steadyOrThrow(jobId, why)) === "steady") await letGo();
  else log(`${why} — what was read may have been cut short by the seedbox: the download is kept, and looked at once more`);
  throw new NotTheGameFile(why, cls);
}

/** a content job's download once it is done with: released (the seeding task looks after the client's copy, ludarr's own
 *  copy goes) — unless it is an earlier download a carry run offered the way (spec.earlier), which is only ever read: it
 *  stays as it was, whether the way took it or not, and its fetch is not marked imported */
async function doneWith(s: Extract<JobSpec, { kind: "content" }>, path: string, log: (l: string) => void): Promise<void> {
  if (s.earlier) { log("the earlier download stays as it was: it was only read"); return; }
  await releaseDownload(s.fetchId, path, log);
}

/** the way's build after its file landed: queued (or the running one followed), or why it cannot be built by itself */
function buildAfter(way: WayRow, plan: PlanRow, game: GameRow, requestId: number | null | undefined): { job: JobRow | null; blocker: string | null } {
  const fresh = getWay(way.id) ?? way;
  const blocker = buildBlocker(fresh, plan);
  const job = blocker ? null : assembling(way.id) ?? enqueueJob({ kind: "assemble", wayId: way.id, auto: true }, { gameId: game.id, requestId: requestId ?? null });
  return { job, blocker };
}

/**
 * A download a request's search brought for one way (job kind 'content' with fetchId): its game file found, checked
 * against the way, kept in the content store and, proven, made the way's file with the way's build queued. A download whose
 * game data is what the way's make takes (a game folder, an archive holding one) is made into the way's file in the same
 * job (src/ways/make.ts runMake: no second unpack, no input row). A download that holds no file the way takes throws
 * NotTheGameFile (the request blocklists the release for this way and moves on), and is done with; anything else that
 * goes wrong throws as it is, the download kept (the request tries it again later, or the run repairs the recipe).
 */
export async function takeDownload(ctx: KindContext, s: Extract<JobSpec, { kind: "content" }>): Promise<KindResult> {
  const way = s.wayId != null ? getWay(s.wayId) : null;
  if (!way) throw new Error("the way to play is gone");
  const game = stmts.gameById.get(way.game_id) as GameRow | undefined;
  if (!game) throw new Error("the way's game is gone");
  if (!s.path) throw new Error("the job names no download");
  const src = await realpath(resolve(s.path)).catch(() => null);
  if (!src) throw new Error(`the download is gone: ${s.path}`);
  if (!(await allowedRoots()).some(r => within(src, r))) throw new Error("the download is outside the folders ludarr takes files from");
  const pass = await prepareContentPass(way, game, ctx.log, { wait: true });
  if (!pass) throw new Error("the way needs no game file, or its plan is gone");
  const c = pass.content;
  const release = s.fetchId != null ? ((stmts.fetchById.get(s.fetchId) as { title?: string } | undefined)?.title ?? null) : null;
  /** the download holds no file this way takes: done with (a wrong game's bytes are never wanted again), then refused — unless
   *  it was read from the seedbox's folder while that was troubled: what such a read did not find says nothing of the
   *  download (an EnvError 'remote': the request looks again later, nothing refused, nothing done with). A refusal whose own
   *  words say the read may have failed (7z ran out of time listing it, a read error) keeps the download: the request runs
   *  the check once more before the refusal counts (src/remote.ts steadyOrThrow 'suspect') */
  const refuse = (why: string, cls: "identity" | "form" = "identity"): Promise<never> => refuseDownload(ctx.job.id, why, cls, async () => { ctx.log(s.earlier ? "the earlier download stays as it was: it was only read" : "download retained for manual use from the game page"); }, ctx.log);
  ctx.log(`looking for the ${label(c.platform)} game file of ${pass.plan.name} (${c.what}) in ${basename(src)}`);
  ctx.progress(0.02, "looking at the download");
  const wanted = [...new Set((c.accept.regions ?? []).map(regionKey).filter((r): r is string => !!r))];
  const nameWords = new Set(pass.names.flatMap(tokens));
  // untagged names first, then the way's regions: a beta or a demo beside the game in one folder is never what is looked at first
  let found: Scanned;
  try { found = await gameFilesIn(src, c, ctx, game); }
  catch (e) {
    if (e instanceof Unpackable) return refuse(e.message);
    // an archive its own listing rules out (another game or version, no game folder, a part of the game): refused with the
    // make's words and class, before anything was unpacked
    if (e instanceof MakeRefused) return refuse(e.message, e.block);
    throw e;
  }
  const files = found.dumps.map(f => ({ f, tagged: fileTag(f.name, pass, null, release) ? 1 : 0, at: regionRank(regionsOf(f.name, nameWords), wanted) ?? wanted.length + 1 }))
    .sort((a, b) => a.tagged - b.tagged || a.at - b.at || a.f.name.localeCompare(b.f.name)).map(x => x.f);
  const folders = found.folders.filter(f => f.role === "product");
  if (!files.length && folders.length) return takeFolder(ctx, s, { way, game, pass, src, release, folder: folders[0], refuse });
  if (!files.length && c.make && (found.inputs.length || found.folders.some(f => f.role === "input"))) return makeFrom(ctx, s, { way, game, pass, src, found, refuse });
  if (!files.length) return refuse(`no ${label(c.platform)} game file in the download (${[...dumpExts(c)].map(e => "." + e).join(", ")}${c.make ? `, nor ${takesText(c)}` : ""})`, "form");
  if (files.filter(f => /\(track ?\d+\)/i.test(f.name)).length > 1) return refuse("a disc of several tracks: this way keeps one game file (a single-file image is needed)", "form");
  const results: Checked[] = [];
  for (const [i, f] of files.slice(0, 8).entries()) {
    if (ctx.signal.aborted) throw new Error("cancelled");
    ctx.progress(0.05 + 0.5 * (i / Math.min(8, files.length)), `checking ${f.name}`);
    // whether it can be linked in is a matter of the file's own volume: one unpacked from an archive sits in the job's own
    // folder (on the library, when it has the room), wherever the download itself is — the seedbox's mount, say
    const r = await checkFile(f, pass, release, { link: await linkable(f.path, game), game, ctx });
    ctx.log(`${f.name}: ${r.verdict === "proven" ? `the game file — ${r.why}` : r.verdict === "refused" ? `refused — ${r.why}` : `cannot be proven — ${r.why}`}`);
    results.push(r);
    if (r.verdict === "proven") break;
  }
  const pick = results.find(r => r.verdict === "proven") ?? results.find(r => r.verdict === "unproven");
  // copies made only to be judged (another volume) that are not the pick go again
  for (const r of results) if (r !== pick && r.row && !r.duplicate) await removeContent(r.row.id).catch(e => ctx.log(`a copy kept to be judged could not be removed: ${e?.message ?? e}`));
  if (!pick || !pick.facts) return refuse(results.length === 1 ? said(results[0].file.name, results[0]) : `none of its files is the game file: ${results.map(r => said(r.file.name, r)).join("; ")}`);
  // proven, while the way is queued or being built (the admin's build): taken once that build ends
  if (pick.verdict === "proven" && assembling(way.id)) throw new Error(WAY_BUSY);

  // kept: linked where it lies (the download stays the client's until the seeding task removes it) with the hashes the
  // check took, or the copy the check made; never read a second time
  ctx.progress(0.6, "keeping the game file");
  let row: ContentRow;
  if (pick.row) row = pick.row;
  else {
    const r = await ingestFile(pick.file.path, { role: "game", game }, {
      name: pick.file.name, source: "indexer", platform: pick.facts.platform, wayPlatform: c.platform, mode: "link", identity: pick.facts.identity ?? null, signal: ctx.signal,
      known: pick.hashed ? { hashes: pick.facts.hashes, rawHashes: pick.hashed.rawHashes, stat: pick.hashed.stat, normalized: pick.hashed.normalized } : null,
      progress: (b, total, step) => ctx.progress(0.6 + 0.35 * Math.min(1, b / Math.max(1, total)), `keeping the game file · ${step === "copying" ? "copying" : "hashing"} · ${ofText(b, total)}`),
    });
    row = r.row;
  }
  if (contentHashes(row).sha1 !== pick.facts.hashes.sha1) throw new Error(`${pick.file.name} changed while it was being kept`);

  if (pick.verdict === "unproven") {
    await steadyOrThrow(ctx.job.id);                                     // kept for a look only from a steady read
    await doneWith(s, src, ctx.log);
    settleWay(way.id);
    const out: TakeOutcome = { outcome: "kept", wayId: way.id, contentId: row.id, file: row.name, why: pick.why };
    return { message: `kept ${row.name} for a look: ${pick.why}`, manifest: out as unknown as Record<string, unknown> };
  }
  // proven: the way's game file now (and that of any other way of the game it fits), then the way's build
  const a = attachToWays(row, { wayId: way.id });
  const fresh = getWay(way.id) ?? way;
  if (!a.attached.includes(way.id) && fresh.content_id !== row.id) {
    // a build of the way was queued while the file was being kept: the file stays in the store, and the retry takes it
    if (assembling(way.id)) throw new Error(WAY_BUSY);
    throw new Error(`${row.name} was not taken: ${a.checks.find(x => x.wayId === way.id)?.why ?? "the way did not take it"}`);
  }
  await doneWith(s, src, ctx.log);
  const { job, blocker } = buildAfter(fresh, pass.plan, game, s.requestId);
  ctx.log(job ? `${row.name} is the game file of ${pass.plan.name} now: building it (job #${job.id})` : `${row.name} is the game file of ${pass.plan.name} now; not built: ${blocker}`);
  const out: TakeOutcome = { outcome: "proven", wayId: way.id, contentId: row.id, file: row.name, by: pick.by, assembleJobId: job?.id ?? null, why: blocker };
  return { message: job ? `${row.name}: the game file, ${pick.why}; building it` : `${row.name}: the game file, ${pick.why}; ${blocker}`, manifest: out as unknown as Record<string, unknown> };
}

interface TakeCtx { way: WayRow; game: GameRow; pass: ContentPass; src: string; refuse: (why: string, cls?: "identity" | "form") => Promise<never> }

/** a download that holds the way's game folder (a content plan of kind 'folder'): judged by what its own data says, kept as a
 *  tree of links (or copied across volumes) with every file hashed once, and the way's build queued */
async function takeFolder(ctx: KindContext, s: Extract<JobSpec, { kind: "content" }>, k: TakeCtx & { release: string | null; folder: FoundFolder }): Promise<KindResult> {
  const c = k.pass.content;
  const identity = await fdeps.readFolderIdentity(k.folder.path, c.platform);
  const facts: FileFacts = { platform: identity && DEFINITIVE.has(identity.platform) ? identity.platform : c.platform, name: k.folder.name, size: 0, hashes: {}, identity, shape: "folder" };
  if (identity?.sealed) return k.refuse(`${k.folder.name}: encrypted for the console, and nothing can open it`);
  const v = contentMatches(c.accept.hashes.length ? { ...c, accept: { ...c.accept, hashes: [] } } : c, facts);
  if (!v.ok) return k.refuse(`${k.folder.name} is ${v.why}`);
  const looking = (files: number, bytes: number) => ctx.progress(0.08, `looking at ${k.folder.name} · ${files.toLocaleString("en-US")} files (${sizeText(bytes)}) so far`);
  if (c.complete) { const w = await fdeps.completeness(k.folder.path, c.complete, { progress: looking }); if (!w.ok) return k.refuse(`${k.folder.name} is ${w.why ?? "an update or a part of the game, not the whole game"}`); }
  if (assembling(k.way.id)) throw new Error(WAY_BUSY);
  ctx.log(`${k.folder.name}: the game folder (it holds ${k.folder.marker}) — taking it in`);
  const say = (b: number, total: number, step?: string) => ctx.progress(0.1 + 0.8 * Math.min(1, b / Math.max(1, total)), `${step === "protecting" ? "protecting the game folder from changes" : "keeping the game folder"} · ${ofText(b, total)}`);
  const kept = await ingestTree(k.folder.path, { role: "game", game: k.game }, { mode: (await linkable(k.folder.path, k.game)) ? "link" : "copy", hash: true, source: "indexer", signal: ctx.signal, progress: say, looking, identity, platform: facts.platform });
  const row = kept.row;
  // judged with its listing's hashes now: refused (what was taken in for this goes again; a folder kept before with these
  // very files stays), or proven — a serial or build its own data carries, a hash of its listing — or, when nothing proves
  // it is the game, kept for a look as an unproven file is (a wrong game is far worse than none: the admin accepts it)
  const full = contentMatches(c, contentFacts(row));
  if (!full.ok) {
    if (!kept.duplicate) await removeContent(row.id).catch(() => { /* kept for a look */ });
    return k.refuse(`${k.folder.name} is ${full.why ?? "not the game folder this way takes"}`);
  }
  if (!proven(full)) {
    await steadyOrThrow(ctx.job.id);                                     // kept for a look only from a steady read
    await doneWith(s, k.src, ctx.log);
    settleWay(k.way.id);
    const shown = shownSerial(identity);
    const why = `${shown ? `its ${serialWord(c.platform)} is ${shown}` : "nothing in it says which game it is"}, and nothing the way accepts proves it is the game${full.unchecked ? ` (${full.unchecked})` : ""}`;
    ctx.log(`${row.name}: kept for a look — ${why}`);
    const out: TakeOutcome = { outcome: "kept", wayId: k.way.id, contentId: row.id, file: row.name, why };
    return { message: `kept ${row.name} for a look: ${why}`, manifest: out as unknown as Record<string, unknown> };
  }
  const a = attachToWays(row, { wayId: k.way.id });
  const mine = a.checks.find(x => x.wayId === k.way.id);
  if (!a.attached.includes(k.way.id) && getWay(k.way.id)?.content_id !== row.id) {
    if (mine && !mine.ok) { if (!kept.duplicate) await removeContent(row.id).catch(() => { /* kept for a look */ }); return k.refuse(`${k.folder.name} is ${mine.why}`); }
    throw new Error(`${row.name} was not taken: ${mine?.why ?? "the way did not take it"}`);
  }
  await doneWith(s, k.src, ctx.log);
  const { job, blocker } = buildAfter(getWay(k.way.id) ?? k.way, k.pass.plan, k.game, s.requestId);
  const by = full.matched ? "hash" : full.serial ? "serial" : full.build ? "build" : null;
  const out: TakeOutcome = { outcome: "proven", wayId: k.way.id, contentId: row.id, file: row.name, by, assembleJobId: job?.id ?? null, why: blocker };
  return { message: job ? `${row.name}: the game folder; building it` : `${row.name}: the game folder; ${blocker}`, manifest: out as unknown as Record<string, unknown> };
}

/** a download whose game data is what the way's make takes: made into the way's file in this same job (src/ways/make.ts
 *  judges it fully first: a sealed input, another game or version, a part of the game is refused before any step) */
async function makeFrom(ctx: KindContext, s: Extract<JobSpec, { kind: "content" }>, k: TakeCtx & { found: Scanned }): Promise<KindResult> {
  const c = k.pass.content;
  const inp = c.make!.input;
  if (c.make!.from?.length && !c.make!.from.includes("indexer")) return k.refuse(`what ${k.pass.plan.name} makes its game file from comes only from ${c.make!.from.join(", ")}, not from the indexers`, "form");
  // a game folder before an archive, the largest archive first
  const candidates: Found[] = [...k.found.folders.filter(f => f.role === "input"), ...[...k.found.inputs].sort((a, b) => b.size - a.size)];
  const input = candidates[0];
  const isFolder = k.found.folders.some(f => f.path === input.path);
  const identity = isFolder ? await fdeps.readFolderIdentity(input.path, c.platform) : await readIdentity(input.path, c.platform, input.name);
  if (identity?.sealed && !takesMakeFile(inp, isFolder ? "folder" : "file", input.name)) return k.refuse(`${input.name}: this recipe does not process its encrypted format`, "form");
  const facts: FileFacts = { platform: identity && DEFINITIVE.has(identity.platform) ? identity.platform : inp.platform, name: input.name, size: input.size, hashes: {}, identity, shape: isFolder ? "folder" : "file" };
  const v = fdeps.inputMatches(inp, facts);
  if (!v.ok) return k.refuse(`${input.name} is ${v.why ?? "not what this way's game file is made from"}`);
  // a download is no one's word on what it holds: it is made into the way's file only when something proves the result is
  // the game — the title id the make's input lists, read from its own data (inside an archive, the make reads its marker
  // before it unpacks), or the way's own checks of the file it makes (its hashes, serials or builds); a file nothing
  // proves is kept for a look, never built, and so is never a file made from such data. Refused as its form: once the
  // way's plan can prove it, the release is looked at again
  if (!proven(v) && !checksFiles(c) && !(!isFolder && (inp.serials ?? []).length)) {
    const shown = shownSerial(identity);
    return k.refuse(`${input.name}: ${shown ? `its ${serialWord(c.platform)} is ${shown}` : "nothing in it says which game it is"}, and nothing the way accepts proves it is the game, so nothing is made from it`, "form");
  }
  if (assembling(k.way.id)) throw new Error(WAY_BUSY);
  ctx.log(`${input.name}: what ${k.pass.plan.name} makes its game file from — making it here`);
  let made: MakeOutcome;
  try { made = await fdeps.runMake(ctx, { way: k.way, plan: k.pass.plan, content: c, input: { from: "indexer", path: input.path, fetchId: s.fetchId ?? null } }); }
  catch (e) {
    // the input turned out to be no game data the way takes (sealed, another game or version, a part): the release is
    // refused, as another game unless the make said only its form was wrong
    if (e instanceof NeedsFiles || e instanceof NotTheGameFile) return k.refuse(e instanceof NotTheGameFile ? e.message.slice(NOT_THE_FILE.length) : e.message, e instanceof NotTheGameFile ? e.cls : e instanceof MakeRefused ? e.block : "identity");
    throw e;
  }
  const row = made.product;
  const fresh = getWay(k.way.id) ?? k.way;
  if (fresh.content_id !== row.id) {
    const a = attachToWays(row, { wayId: k.way.id });
    if (!a.attached.includes(k.way.id)) throw new Error(`what was made (${row.name}) was not taken: ${a.checks.find(x => x.wayId === k.way.id)?.why ?? "the way did not take it"}`);
  }
  await doneWith(s, k.src, ctx.log);
  const { job, blocker } = buildAfter(getWay(k.way.id) ?? k.way, k.pass.plan, k.game, s.requestId);
  const why = made.reused ? "made before from the same game data: reused" : `made from ${input.name}`;
  const out: TakeOutcome = { outcome: "proven", wayId: k.way.id, contentId: row.id, file: row.name, by: null, assembleJobId: job?.id ?? null, why: blocker ?? why, made: true };
  return { message: job ? `${row.name}: the game file, ${why}; building it` : `${row.name}: the game file, ${why}; ${blocker}`, manifest: out as unknown as Record<string, unknown> };
}

/* ─────────── what a release holds, looked at before it is grabbed ─────────── */

/** one file a release says it holds (a torrent's file list, an NZB's subjects) */
export interface Listed { path: string; size: number }

/** a bencoded value, read only as far as a file list needs (bounds checked, depth limited) */
function bdecode(b: Uint8Array): unknown {
  let i = 0;
  const latin = (u: Uint8Array) => Buffer.from(u).toString("latin1");
  const read = (depth: number): unknown => {
    if (depth > 64 || i >= b.length) throw new Error("bad torrent");
    const c = b[i];
    if (c === 0x69) { const e = b.indexOf(0x65, i); if (e < 0) throw new Error("bad torrent"); const n = Number(latin(b.subarray(i + 1, e))); i = e + 1; return n; }
    if (c === 0x6c) { i++; const out: unknown[] = []; while (i < b.length && b[i] !== 0x65) out.push(read(depth + 1)); i++; return out; }
    if (c === 0x64) { i++; const out = new Map<string, unknown>(); while (i < b.length && b[i] !== 0x65) { const k = read(depth + 1); out.set(latin(k as Uint8Array), read(depth + 1)); } i++; return out; }
    if (c >= 0x30 && c <= 0x39) { const colon = b.indexOf(0x3a, i); if (colon < 0) throw new Error("bad torrent"); const len = Number(latin(b.subarray(i, colon))); if (!Number.isFinite(len) || colon + 1 + len > b.length) throw new Error("bad torrent"); const s = b.subarray(colon + 1, colon + 1 + len); i = colon + 1 + len; return s; }
    throw new Error("bad torrent");
  };
  return read(0);
}

/** how many files a release's listing may name and still be read: one past this says nothing (null: the release is judged
 *  as it always was), so a loose game folder of 117,000 files whose sce_sys sorts last is never refused for what its first
 *  files are */
export const LISTING_MAX = 200_000;

/** the files a .torrent lists (paths inside the torrent's own folder, and sizes), or null when its bytes are not one or it
 *  names more files than `max` */
export function torrentListing(bytes: Uint8Array, max = LISTING_MAX): Listed[] | null {
  try {
    const top = bdecode(bytes);
    const info = top instanceof Map ? top.get("info") : null;
    if (!(info instanceof Map)) return null;
    const utf8 = (u: unknown) => (u instanceof Uint8Array ? Buffer.from(u).toString("utf8") : "");
    const name = utf8(info.get("name.utf-8") ?? info.get("name"));
    const files = info.get("files");
    if (!Array.isArray(files)) return [{ path: name, size: Number(info.get("length") ?? 0) }];
    if (files.length > max) return null;
    return files.map(f => {
      const m = f instanceof Map ? f : new Map();
      const parts = (m.get("path.utf-8") ?? m.get("path")) as unknown[] | undefined;
      return { path: [name, ...(Array.isArray(parts) ? parts.map(utf8) : [])].filter(Boolean).join("/"), size: Number(m.get("length") ?? 0) };
    });
  } catch { return null; }
}

const unentity = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
/** the files an .nzb posts (each <file>'s subject: the quoted name in it, and the bytes of its segments), or null when its
 *  text is not one, or it posts more files than `max`; an obfuscated post names nothing useful, and is judged as if nothing
 *  were listed */
export function nzbListing(text: string, max = LISTING_MAX): Listed[] | null {
  if (!/<nzb[\s>]/i.test(text)) return null;
  const out: Listed[] = [];
  for (const m of text.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/gi)) {
    if (out.length >= max) return null;
    const subject = unentity(/\bsubject\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? /\bsubject\s*=\s*'([^']*)'/i.exec(m[1])?.[1] ?? "");
    const name = /"([^"]+)"/.exec(subject)?.[1] ?? subject.replace(/\s*yEnc.*$/i, "").replace(/^\[[^\]]*\]\s*-?\s*/, "").trim();
    // an obfuscated post: a subject that names no file (no quoted name, or one with no extension: random letters) says
    // nothing of what the post holds, so the whole listing says nothing — never a refusal by the subjects' random words
    if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) return null;
    let size = 0;
    for (const sm of m[2].matchAll(/<segment\b[^>]*\bbytes\s*=\s*"(\d+)"/gi)) size += Number(sm[1]);
    out.push({ path: name, size });
  }
  return out;
}

/** a release's payload (src/plugins/types.ts Payload) as the files it holds: a torrent's list, an NZB's subjects; null for a
 *  magnet or anything unreadable (such a release is judged as it always was) */
export function listingOf(payload: { kind: string; bytes?: Uint8Array; uri?: string }): Listed[] | null {
  if (payload.kind === "torrent" && payload.bytes) return torrentListing(payload.bytes);
  if (payload.kind === "nzb" && payload.bytes) return nzbListing(Buffer.from(payload.bytes).toString("utf8"));
  return null;
}

const ARCHIVE_ANY = /\.(zip|7z|rar|001|r\d\d|z\d\d|tar|gz|tgz|bz2|xz|zst)$/i;
/** forms whose game data is encrypted for the console, and a PlayStation 4 or 5 disc image */
const SEALED_EXT = new Set(["nsp", "xci", "nsz", "xcz", "pkg"]);
const sealedForm = (e: string, c: ContentPlan) => SEALED_EXT.has(e) || (e === "iso" && (c.platform === "ps4" || c.platform === "ps5"));
/** the forms a way takes in words ("a .zar, or the game folder it is made from") */
function takesText(c: ContentPlan): string {
  const product = c.kind === "folder" ? `the game folder${c.marker ? ` (holding ${c.marker})` : ""}` : [...dumpExts(c)].map(e => "." + e).join(", ");
  const inp = c.make?.input;
  if (!inp) return product;
  const forms = [inp.shape !== "file" ? `the folder it is made from${inp.marker ? ` (holding ${inp.marker})` : ""}` : null, inp.shape !== "folder" && (inp.formats ?? []).length ? `${(inp.formats ?? []).map(f => "." + f).join(", ")} it is made from` : null].filter(Boolean);
  return forms.length ? `${product}, or ${forms.join(", or ")}` : product;
}

/**
 * What a release's own listing says before anything is downloaded: it may hold the way's game file (a file in a form the
 * way takes, what its make takes, a folder holding the marker, or an archive whose inside cannot be seen from here), or it
 * cannot. Both refusals are of the form ('form'): nothing in it is in a form the way takes, or what it holds is in a form
 * whose game data is sealed for the console (an NSP, a PS5 disc image) that the way takes neither as it is nor to make its
 * file from. A name is not the bytes: should the way's plan come to take that form (a disc image found to be a dumped
 * folder's), the release is looked at again; a sealed verdict from a file's own bytes is another matter (checkFile).
 * An empty listing says nothing (judged as before).
 */
export function judgeListing(c: ContentPlan, files: Listed[]): { ok: boolean; why: string | null; cls?: "identity" | "form" } {
  if (!files.length) return { ok: true, why: null };
  const exts = c.kind === "folder" ? new Set<string>() : dumpExts(c), ins = inputExts(c);
  const markers = markersOf(c).map(m => m.marker.toLowerCase());
  const takes = new Set([...(c.accept.formats ?? []), ...(c.make?.input.formats ?? [])].map(f => f.toLowerCase()));
  let archive = false;
  const sealed: string[] = [];
  for (const f of files) {
    const p = f.path.replace(/\\/g, "/"), lower = p.toLowerCase(), e = extOf(p);
    if (exts.has(e) && !(sealedForm(e, c) && !takes.has(e))) return { ok: true, why: null };
    if (ins.has(e)) return { ok: true, why: null };
    if (markers.some(m => lower === m || lower.endsWith("/" + m))) return { ok: true, why: null };
    if (ARCHIVE_ANY.test(p)) archive = true;
    if (sealedForm(e, c) && !takes.has(e)) sealed.push(basename(p));
  }
  if (archive) return { ok: true, why: null };
  if (sealed.length && sealed.every(p => /\.(nsp|xci)$/i.test(p))) return { ok: false, cls: "form", why: `it holds ${sealed[0]}${sealed.length > 1 ? ` and ${sealed.length - 1} more like it` : ""}, which this plan does not process as game input` };
  if (sealed.length) return { ok: false, cls: "form", why: `it holds ${sealed[0]}${sealed.length > 1 ? ` and ${sealed.length - 1} more like it` : ""}, whose game data is encrypted for the console: nothing can open it` };
  const shown = files.slice(0, 3).map(f => basename(f.path.replace(/\\/g, "/"))).join(", ");
  return { ok: false, cls: "form", why: `it holds no ${takesText(c)} (its ${files.length} file${files.length === 1 ? "" : "s"}: ${shown}${files.length > 3 ? " …" : ""})` };
}

/* ─────────── what a way's search may not take again ─────────── */

const bq = { forWay: db.query("SELECT guid, title, way_id, plan_digest, class, reason FROM blocklist WHERE game_id=? AND (way_id IS NULL OR way_id=?)") };
/** a way's refusal written before refusals had a class (no class, no digest) whose words say only the release's form was
 *  wrong, as the content pass wrote them then ("no PlayStation 5 game file in the download (.zar)", "a disc of several
 *  tracks"): such a row is a form refusal of a plan from before (the live KytyPS5 way's "no .zar" rows) */
// Older Switch format refusals were incorrectly permanent identity failures. Rejudge only those exact
// engine-written reasons after a plan changes; wrong-title/hash/version failures and global blocks stay blocked.
const OLD_SWITCH_FORM = /^(?:not the game file: .+ is a Switch (?:package \(NSP\)|game card image \(XCI\))(?: \([^\r\n]*\))?: its game data is encrypted for the console, and ludarr never decrypts it|the game's own copy on the server: a \.(?:nsp|xci) file(?: \([^\r\n]*\))?, whose game data is encrypted for the console: nothing can open it)$/;
const OLD_FORM = /^not the game file: (?:no .+ game file in the download|a disc of several tracks)/;
/**
 * The releases a search for one way's game file may not take: the game's own blocklist and the way's, except a release the
 * way refused only for its form under another version of its game file plan ('form' rows of another digest, and old form
 * refusals by their words): once the plan takes another form (it gained a make, a format), that release is looked at
 * again — its listing first, so a release still in no form the way takes is never downloaded again for it.
 */
export function wayBlocked(gameId: number, wayId: number, content: ContentPlan | null): Set<string> {
  const digest = contentDigest(content);
  const out = new Set<string>();
  for (const b of bq.forWay.all(gameId, wayId) as { guid: string | null; title: string; way_id: number | null; plan_digest: string | null; class: string | null; reason: string | null }[]) {
    const form = b.class === "form" || (b.class === "identity" && OLD_SWITCH_FORM.test(b.reason ?? "")) || (b.class == null && b.plan_digest == null && OLD_FORM.test(b.reason ?? ""));
    if (b.way_id != null && form && b.plan_digest !== digest) continue;
    if (b.guid) out.add(b.guid);
    if (b.class !== "source") out.add(b.title);                // a post that failed on its source: that post only (src/requests.ts)
  }
  return out;
}
