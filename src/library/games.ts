/**
 * ludarr — the library: games the user added, with a profile, a root folder, a monitored flag and one
 * computed status (missing / searching / downloading / importing / available / unreleased / unmonitored).
 * Adding a game pulls its metadata from the source it was found in (Steam, IGDB, the catalog), or takes it as the
 * admin describes it (a game added by hand: source 'manual'). Every game can carry other names it goes by and extra
 * search terms; each name is searched and judged on its own, the terms only add queries.
 */
import { removeTree } from "../fsutil";
import { activeBuilds, customArtOf, db, stmts, serializeGame, serializeRequest, upsertGame, type ArtKind, type GameRow, type PackageRow, type RequestRow, type JobRow } from "../db";
import { events } from "../events";
import { logger } from "../log";
import * as registry from "../plugins/registry";
import type { LookupHit, MetadataSource } from "../plugins/types";
import { onboardSteamApps } from "../onboard";
import { IgdbClient, igdbToGameRow } from "../igdb";
import { getTitle, normName, queryTitles, slugify } from "../catalog/store";
import { activeSources } from "../catalog/worker";
import { checkGame } from "../crackwatch-sync";
import { follow, unfollow, type FollowRow } from "../discover";
import { createRequest, cancelRequest } from "../requests";
import { PLATFORM_LABEL, platformChoices, wantedPlatform, type PlatformId } from "../platforms";
import { cancelJob } from "../process/runner";
import { clearCustomArt, removeCustomArtFiles, storeCustomArt, fetchArtUrl, type ArtImage } from "../art";
import { validateGameDraft } from "../ways/validate";
import { requestWay } from "../ways/find";
import type { GameDraft } from "../ways/types";
import { classOfPackage, profileFor, profiles, wantsUpgrade } from "./profiles";
import { rootFolderFor, rootFolders } from "./rootfolders";
import { record } from "./history";
import { launchLine } from "./launch";

const log = logger("Library");
export class LibraryError extends Error {
  /** `extra` goes out with the error ({ existingId } for a game that is already in the library) */
  constructor(msg: string, public status = 400, public extra: Record<string, unknown> = {}) { super(msg); }
}

export type GameStatus = "unreleased" | "missing" | "searching" | "downloading" | "importing" | "available" | "unmonitored" | "failed";

const today = () => new Date().toISOString().slice(0, 10);
const list = (s: string | null | undefined): string[] => { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v : []; } catch { return []; } };
const yearOfIso = (iso: string | null | undefined): number | null => (iso && /^\d{4}/.test(iso) ? Number(iso.slice(0, 4)) : null);
const yearOf = (g: Pick<GameRow, "release_year" | "release_iso">): number | null => g.release_year ?? yearOfIso(g.release_iso);

/** a copy players can start: anything but a console dump (manifest kind 'rom'), which the launcher refuses */
function playable(pkg: PackageRow | null | undefined): boolean {
  if (!pkg) return false;
  try { return JSON.parse(pkg.manifest_json)?.kind !== "rom"; } catch { return true; }
}

/** a job that is getting a way to play ready for this game: its build, its game file being taken in or made, or its
 *  program built for this one game (a build job with a wayId); a plan's own build or the AI working one out is not */
function preparing(j: JobRow | null | undefined): boolean {
  if (!j || (j.state !== "queued" && j.state !== "running")) return false;
  if (j.kind === "assemble" || j.kind === "content" || j.kind === "make") return true;
  if (j.kind !== "build") return false;
  try { const id = Number(JSON.parse(j.spec_json ?? "null")?.wayId); return Number.isInteger(id) && id > 0; } catch { return false; }
}

/**
 * One status per game. `build` is the game's job in flight that gets a way to play ready (activeBuilds()): while a way is
 * being built, its game file taken in or made, or its program built for this game, a game without a copy players can start
 * shows 'importing' with the fixed detail 'preparing' — never the job's own message (it is admin-facing). The AI working
 * out a way (a construct job) never changes what members see.
 */
export function statusOf(g: GameRow, pkg: PackageRow | null | undefined, req: RequestRow | null | undefined, build?: JobRow | null): { status: GameStatus; detail: string } {
  if (preparing(build) && !playable(pkg)) return { status: "importing", detail: "preparing" };
  // a search for a way's game file (the admin's "Find it on my indexers") never changes a copy players can start
  if (req?.way_id != null && playable(pkg)) req = null;
  if (req && !pkg && ["requested", "matching"].includes(req.state)) return { status: "searching", detail: req.stage ?? "searching" };
  if (req?.state === "fetching") return { status: "downloading", detail: req.stage ?? "downloading" };
  if (req?.state === "processing") return { status: "importing", detail: req.stage ?? "importing" };
  if (pkg) return { status: "available", detail: `${(Number(pkg.size ?? 0) / 1e9).toFixed(1)} GB${pkg.version ? ` · v${pkg.version}` : ""}` };
  if ((g.monitored ?? 1) === 0) return { status: "unmonitored", detail: "not monitored" };
  if ((g.release_iso && g.release_iso > today()) || (g.coming_soon && !g.release_iso)) return { status: "unreleased", detail: g.release_text || g.release_iso || "coming soon" };
  if (req?.state === "failed") return { status: "failed", detail: req.message ?? req.stage ?? "failed" };
  return { status: "missing", detail: "no copy yet" };
}

export { classOfPackage };

/** the build job in flight for one game, if any */
const buildFor = (gameId: number): JobRow | null => activeBuilds().get(gameId) ?? null;

function maps() {
  const pkgs = new Map<number, PackageRow>();
  for (const p of db.query("SELECT * FROM packages WHERE game_id IS NOT NULL ORDER BY id").all() as PackageRow[]) pkgs.set(p.game_id!, p);
  const reqs = new Map<number, RequestRow>();
  for (const r of db.query("SELECT r.*, g.name AS game_name FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.state IN ('requested','matching','fetching','processing') OR r.id IN (SELECT MAX(id) FROM requests GROUP BY game_id) ORDER BY r.id").all() as RequestRow[]) {
    const cur = reqs.get(r.game_id);
    if (!cur || ["requested", "matching", "fetching", "processing"].includes(r.state) || r.id > cur.id) reqs.set(r.game_id, r);
  }
  const follows = new Map<number, FollowRow>();
  for (const f of db.query("SELECT * FROM follows").all() as FollowRow[]) follows.set(f.game_id, f);
  const profs = new Map(profiles().map(p => [p.id, p]));
  const roots = new Map(rootFolders().map(r => [r.id, r]));
  return { pkgs, reqs, follows, profs, roots, builds: activeBuilds() };
}

export function serializeLibraryGame(g: GameRow, m = maps()) {
  const pkg = m.pkgs.get(g.id) ?? null;
  const req = m.reqs.get(g.id) ?? null;
  const prof = (g.profile_id && m.profs.get(g.profile_id)) || [...m.profs.values()][0] || null;
  const root = (g.root_folder_id && m.roots.get(g.root_folder_id)) || [...m.roots.values()][0] || null;
  const { status, detail } = statusOf(g, pkg, req, m.builds.get(g.id) ?? null);
  let manifest: { launch?: { exe: string; args?: string; argv?: string[]; rev?: number }; files?: unknown[]; tier?: string; kind?: string; requires?: { launcher?: string }; source?: { title?: string; group?: string | null } } | null = null;
  try { manifest = pkg ? JSON.parse(pkg.manifest_json) : null; } catch { /* ignore */ }
  const cutoffUnmet = !!pkg && !!prof && wantsUpgrade(prof, classOfPackage(pkg));
  const kind = manifest?.kind ?? "native";
  return {
    ...serializeGame(g), status, statusDetail: detail, hasFile: !!pkg,
    file: pkg ? {
      id: pkg.id, path: pkg.path, size: pkg.size, version: pkg.version, launch: manifest?.launch?.exe ?? null, files: manifest?.files?.length ?? null, importer: manifest?.tier ?? null, release: manifest?.source?.title ?? null, group: manifest?.source?.group ?? null, format: classOfPackage(pkg), addedAt: pkg.created_at,
      // what the copy is (native | rom | recomp | port | emulated) and the launcher it needs, so a client can tell a dump it
      // cannot start, and an Ahoy that is too old, before anything is downloaded
      kind, requiresLauncher: manifest?.requires?.launcher ?? null,
      // the whole start, program and arguments (admin; a console dump has none), and when it was last set or reset by hand
      // (src/library/launch.ts: an opaque stamp a client compares with the one it installed, never shown to players)
      start: kind !== "rom" && manifest?.launch?.exe ? launchLine(manifest.launch) : null,
      launchRev: typeof manifest?.launch?.rev === "number" ? manifest.launch.rev : null,
    } : null,
    cutoffUnmet, request: req ? serializeRequest(req) : null,
    profile: prof ? { id: prof.id, name: prof.name } : null, rootFolder: root ? { id: root.id, path: root.path } : null,
    tracked: m.follows.has(g.id),
  };
}
export type LibraryGame = ReturnType<typeof serializeLibraryGame>;

export function listGames(opt: { q?: string; status?: string; monitored?: boolean; profileId?: number; sort?: string } = {}): LibraryGame[] {
  const m = maps();
  let rows = (stmts.allGames.all() as GameRow[]).map(g => serializeLibraryGame(g, m));
  if (opt.q) { const q = opt.q.toLowerCase(); rows = rows.filter(g => g.name.toLowerCase().includes(q) || g.aliases.some(a => a.toLowerCase().includes(q))); }
  if (opt.status) rows = rows.filter(g => g.status === opt.status);
  if (opt.monitored !== undefined) rows = rows.filter(g => g.monitored === opt.monitored);
  if (opt.profileId) rows = rows.filter(g => g.profile?.id === opt.profileId);
  const by = opt.sort ?? "name";
  rows.sort((a, b) => by === "added" ? (b.addedAt ?? 0) - (a.addedAt ?? 0) : by === "release" ? String(b.releaseIso ?? "").localeCompare(String(a.releaseIso ?? "")) : by === "status" ? a.status.localeCompare(b.status) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return rows;
}

export function gameDetail(id: number) {
  const g = stmts.gameById.get(id) as GameRow | undefined;
  if (!g) return null;
  const base = serializeLibraryGame(g);
  const history = (stmts.historyForGame.all(id) as import("../db").HistoryRow[]).map(h => ({ id: h.id, event: h.event, release: h.release, source: h.source, message: h.message, at: h.created_at }));
  const jobs = (db.query("SELECT * FROM jobs WHERE game_id=? ORDER BY id DESC LIMIT 5").all(id) as JobRow[]).map(j => ({ id: j.id, kind: j.kind ?? "import", state: j.state, tier: j.tier, message: j.message, createdAt: j.created_at, doneAt: j.done_at }));
  const files = (db.query("SELECT * FROM packages WHERE game_id=? ORDER BY id DESC").all(id) as PackageRow[]).map(p => ({ id: p.id, path: p.path, size: p.size, version: p.version, format: classOfPackage(p), createdAt: p.created_at }));
  const title = g.title_id ? getTitle(g.title_id, activeSources()) : null;
  return { ...base, history, jobs, files, routes: title?.routes ?? [], catalogTitle: title ? { id: title.id, slug: title.slug } : null };
}

/* ─────────── changes other parts follow ─────────── */

type ChangeHook = (gameId: number, how: "added" | "changed" | "deleted") => void;
const changeHooks = new Set<ChangeHook>();
/** called after a game's own fields change (added, details or art edited, deleted) — the custom catalog source re-ingests
 *  from it; returns the unsubscribe */
export function onGameChange(fn: ChangeHook): () => void { changeHooks.add(fn); return () => { changeHooks.delete(fn); }; }
function changed(gameId: number, how: "added" | "changed" | "deleted") {
  for (const fn of changeHooks) { try { fn(gameId, how); } catch (e: any) { log.warn(`after a change to game ${gameId}: ${e?.message ?? e}`); } }
}

/* ─────────── add ─────────── */

export interface AddBody {
  source: "steam" | "igdb" | "catalog" | "manual";
  /** the version to look for, when the game is on several platforms: a platform id or name ("arcade", "X360"; src/platforms.ts) */
  platform?: string | null;
  /** steam app id, IGDB id or catalog title id (not for 'manual') */
  id?: string | number;
  /** 'manual': the game as the admin describes it (src/ways/types.ts GameDraft; checked by validateGameDraft) */
  game?: unknown;
  /** 'manual': art fetched once from an https link and kept as the game's own (it is then never replaced automatically) */
  posterUrl?: string | null; bannerUrl?: string | null;
  /** 'manual': add it although a game of the same name and year is already in the library */
  force?: boolean;
  monitored?: boolean; profileId?: number | null; rootFolderId?: number | null; searchNow?: boolean; tags?: string[];
}

function igdbClient(): IgdbClient | null {
  const row = registry.instanceRows("metadata").find(r => r.impl === "igdb" && r.enabled);
  if (!row) return null;
  try { const s = JSON.parse(row.settings_json); const c = new IgdbClient(); c.configure(String(s.clientId ?? ""), String(s.clientSecret ?? ""), false); return c.configured() ? c : null; } catch { return null; }
}

/** the library game a store id names: the game with that Steam or IGDB id, else the game that holds the catalog title
 *  carrying it (a game added by hand and linked to the store's title is that store's game) */
function gameOfStoreId(scheme: string, value: string | number): GameRow | undefined {
  if (scheme !== "steam" && scheme !== "igdb") return undefined;
  const id = Number(value);
  const own = (scheme === "steam" ? stmts.gameBySteam.get(id) : stmts.gameByIgdb.get(id)) as GameRow | undefined;
  if (own) return own;
  const t = db.query("SELECT t.game_id FROM title_ids i JOIN titles t ON t.id=i.title_id WHERE i.scheme=? AND i.value=? AND t.game_id IS NOT NULL").get(scheme, Number.isFinite(id) ? String(id) : String(value)) as { game_id: number } | null;
  return t ? (stmts.gameById.get(t.game_id) as GameRow | undefined) : undefined;
}

async function materialize(body: AddBody): Promise<GameRow> {
  if (body.source === "steam") {
    const appId = Number(body.id);
    const known = gameOfStoreId("steam", appId);
    if (known) return known;
    const r = await onboardSteamApps([appId]);
    if (!r.saved[0]) throw new LibraryError(`Steam app ${appId} was not found`, 404);
    return r.saved[0];
  }
  if (body.source === "igdb") {
    const igdbId = Number(body.id);
    const known = gameOfStoreId("igdb", igdbId);
    if (known) return known;
    const client = igdbClient();
    if (!client) throw new LibraryError("IGDB is not configured (Settings → Metadata)", 400);
    const g = (await client.details([igdbId]))[0];
    if (!g) throw new LibraryError(`IGDB game ${igdbId} was not found`, 404);
    return upsertGame(igdbToGameRow(g));
  }
  if (body.source === "catalog") {
    const t = getTitle(Number(body.id));
    if (!t) throw new LibraryError("no such catalog title", 404);
    if (t.gameId) { const known = stmts.gameById.get(t.gameId) as GameRow | undefined; if (known) return known; }
    // a catalog-only game added before the title remembered it: the same row again, never a second one
    const before = db.query("SELECT * FROM games WHERE title_id=? AND source='catalog' ORDER BY id LIMIT 1").get(t.id) as GameRow | null;
    if (before) { claimTitle(t.id, before.id); return before; }
    const steam = t.ids.find(i => i.scheme === "steam");
    if (steam) return materialize({ ...body, source: "steam", id: steam.value });
    const igdb = t.ids.find(i => i.scheme === "igdb");
    if (igdb && igdbClient()) return materialize({ ...body, source: "igdb", id: igdb.value });
    const row = db.query(`INSERT INTO games (name, slug, summary, release_year, release_iso, cover_url, banner_url, screenshots_json, genres_json, platforms_json, developer, publisher, source, title_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'catalog',?) RETURNING *`).get(t.name, t.slug, t.summary, t.year, t.releaseIso, t.cover, t.hero, JSON.stringify(t.screenshots), JSON.stringify(t.genres), JSON.stringify(t.platforms), t.developer, t.publisher, t.id) as GameRow;
    claimTitle(t.id, row.id);
    return row;
  }
  throw new LibraryError("source must be steam, igdb, catalog or manual");
}

/** the catalog title knows its library game (lookups show it as in the library; a second add finds it) — never taken
 *  from another game that already has it */
function claimTitle(titleId: number, gameId: number) {
  db.query("UPDATE titles SET game_id=? WHERE id=? AND game_id IS NULL").run(gameId, titleId);
}

function placement(body: Pick<AddBody, "profileId" | "rootFolderId">) {
  const prof = body.profileId ? profiles().find(p => p.id === body.profileId) : null;
  const root = body.rootFolderId ? rootFolders().find(r => r.id === body.rootFolderId) : null;
  if (body.profileId && !prof) throw new LibraryError("no such profile", 404);
  if (body.rootFolderId && !root) throw new LibraryError("no such root folder", 404);
  return { prof, root };
}

export async function addGame(body: AddBody): Promise<LibraryGame> {
  if (body?.source === "manual") return addManualGame(body);
  const g = await materialize(body);
  return finishAdd(g, body, placement(body));
}

/**
 * The version a game is asked for, checked: one of the platforms the game is on (any platform a copy can be fetched for when
 * it names none), as its id; null or "" for no choice. Anything else is refused: a search for a version the game never had
 * finds nothing, for good.
 */
export function wantedFor(g: Pick<GameRow, "platforms_json" | "name">, raw: unknown): PlatformId | null {
  if (raw == null || raw === "") return null;
  const id = wantedPlatform(typeof raw === "string" ? raw : null);
  const on = platformChoices(list(g.platforms_json));
  if (!id || (on.length > 0 && !on.includes(id))) throw new LibraryError(on.length ? `${g.name} is on ${on.map(p => PLATFORM_LABEL[p]).join(", ")}: the version to look for is one of those` : "no such platform");
  return id;
}

/** what every add does once the row exists: library settings, the catalog link, history, tracking or a search */
async function finishAdd(g: GameRow, body: AddBody, { prof, root }: ReturnType<typeof placement>): Promise<LibraryGame> {
  const wasNew = !g.added_at;
  // the version that was asked for is kept before the first search, which then looks for that one; a game that was here
  // already keeps the version it is being looked for in
  if (body.platform !== undefined && (wasNew || !g.want_platform)) db.query("UPDATE games SET want_platform=? WHERE id=?").run(wantedFor(g, body.platform), g.id);
  const monitored = body.monitored !== false;
  stmts.setGameAdded.run(monitored ? 1 : 0, prof?.id ?? profileFor(g).id ?? null, root?.id ?? rootFolderFor(g)?.id ?? null, g.id);
  if (body.monitored !== undefined || body.tags) stmts.setGameLibrary.run(monitored ? 1 : 0, prof?.id ?? g.profile_id ?? profileFor(g).id, root?.id ?? g.root_folder_id ?? rootFolderFor(g)?.id ?? null, JSON.stringify(body.tags ?? list(g.tags_json)), g.id);
  // link to the catalog title when one carries the same Steam id, so the game page can show every way to play it
  if (g.steam_appid && !g.title_id) {
    const hit = db.query("SELECT title_id FROM title_ids WHERE scheme='steam' AND value=?").get(String(g.steam_appid)) as { title_id: number } | undefined;
    if (hit) stmts.setGameTitle.run(hit.title_id, g.id);
  }
  const fresh = stmts.gameById.get(g.id) as GameRow;
  if (wasNew) record(g.id, "added", { gameName: g.name, message: body.source });
  const st = statusOf(fresh, stmts.packageForGame.get(g.id) as PackageRow | undefined, null, buildFor(g.id)).status;
  if (monitored && st === "unreleased") await follow({ gameId: g.id }).catch(e => log.warn(`${g.name}: could not track the release: ${e?.message ?? e}`));
  if (monitored && body.searchNow !== false && st === "missing") createRequest({ gameId: g.id, by: "add" });
  events.emit("game" as never, serializeLibraryGame(fresh));
  changed(g.id, wasNew ? "added" : "changed");
  log.info(`${wasNew ? "added" : "updated"} ${g.name} (${body.source})`);
  return serializeLibraryGame(fresh);
}

/* ─────────── games added by hand ─────────── */

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16" };
/**
 * When two names are one name (the duplicate guard, other names): the catalog's normName for Latin text — case, accents,
 * punctuation, a leading "the" and roman numerals do not count — with the letters of every other script kept as they are.
 * normName keeps only a–z and 0–9 ("Ведьмак 3" and "Дикая Охота 3" are both "3" there, "ドラゴンクエスト" is nothing), so it
 * only links catalog titles. Outside Latin a mark makes another letter (ド is not ト), so only Latin letters lose theirs.
 */
export function nameKey(s: string): string {
  const words = s.replace(/[™®©]/g, "").normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim().split(" ").filter(Boolean)
    .map(w => ROMAN[w] ?? w);
  if (words[0] === "the" && words.length > 1) words.shift();
  return words.join(" ");
}

/** other names, each once: none that is the game's own name again, none that is nothing but punctuation */
function cleanAliases(name: string, aliases: string[]): string[] {
  const seen = new Set([nameKey(name)]);
  return aliases.filter(a => { const n = nameKey(a); if (!n || seen.has(n)) return false; seen.add(n); return true; });
}
/** search terms, each once (the first spelling of a repeated one is kept) */
function cleanTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms.filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** a library game (of any source) that is this one: the same normalised name — the game's own or one it goes by — and
 *  a year at most one off (an unknown year on either side does not tell them apart) */
function duplicateOf(name: string, aliases: string[], year: number | null, exceptId?: number): GameRow | null {
  const want = new Set([name, ...aliases].map(nameKey).filter(Boolean));
  for (const g of stmts.allGames.all() as GameRow[]) {
    if (g.id === exceptId) continue;
    if (![g.name, ...list(g.aliases_json)].some(n => want.has(nameKey(String(n))))) continue;
    const y = yearOf(g);
    if (year != null && y != null && Math.abs(year - y) > 1) continue;
    return g;
  }
  return null;
}
function refuseDuplicate(name: string, aliases: string[], year: number | null, exceptId?: number) {
  const dup = duplicateOf(name, aliases, year, exceptId);
  if (!dup) return;
  const y = yearOf(dup);
  throw new LibraryError(`"${dup.name}"${y ? ` (${y})` : ""} is already in the library — send force to add it anyway`, 409, { existingId: dup.id });
}

/** a letter of a script other than Latin */
const OTHER_SCRIPT = /[^\P{L}\p{Script=Latin}]/u;
/** the catalog title of exactly this name and year (±1) that no library game holds yet, or null (no year, none, or several).
 *  A name with letters of another script is never linked: the catalog's names keep a–z and 0–9 only, so "Ведьмак 3" would
 *  be linked by its digits alone */
function catalogTitleFor(name: string, year: number | null): number | null {
  if (year == null || OTHER_SCRIPT.test(name)) return null;
  const near = (db.query("SELECT DISTINCT t.id, t.year, t.game_id FROM title_names n JOIN titles t ON t.id=n.title_id WHERE n.norm=?").all(normName(name)) as { id: number; year: number | null; game_id: number | null }[])
    .filter(t => t.year != null && Math.abs(t.year - year) <= 1);
  return near.length === 1 && near[0].game_id == null ? near[0].id : null;
}
/** does the title still go by this name and year — the test catalogTitleFor links a title by? */
function namedBy(t: { id: number; year: number | null }, name: string, year: number | null): boolean {
  if (year == null || t.year == null || Math.abs(t.year - year) > 1 || OTHER_SCRIPT.test(name)) return false;
  return !!db.query("SELECT 1 FROM title_names WHERE title_id=? AND norm=?").get(t.id, normName(name));
}
/**
 * A game added by hand whose name or year changed: is it still its catalog title's game? A title another source knows stays
 * linked only while it still goes by the game's name and year; otherwise it is let go — its store ids would go on naming this
 * game, and a Steam add of "Hades" would land on the game renamed "Hadean Lands" — and the title of the new name and year,
 * when there is exactly one, is linked instead. The title the custom source made for the game's ways (meta_source 'custom',
 * named by the registry id 'game:<id>', src/catalog/providers/custom.ts) is the game's own: it follows the game's name, and stays.
 */
function relinkTitle(g: GameRow) {
  const year = yearOf(g);
  const key = `game:${g.id}`;
  const t = g.title_id == null ? null : db.query("SELECT id, year, meta_source FROM titles WHERE id=?").get(g.title_id) as { id: number; year: number | null; meta_source: string | null } | null;
  const own = !!t && t.meta_source === "custom" && !!db.query("SELECT 1 FROM title_ids WHERE scheme='registry' AND value=? AND title_id=?").get(key, t.id);
  if (t && (own || namedBy(t, g.name, year))) return;
  if (t) {
    db.query("UPDATE titles SET game_id=NULL WHERE id=? AND game_id=?").run(t.id, g.id);
    // the custom source looks a game's title up by this id: left pointing at the old title, it would link it again
    db.query("DELETE FROM title_ids WHERE scheme='registry' AND value=? AND title_id=?").run(key, t.id);
  }
  if (g.title_id != null) stmts.setGameTitle.run(null, g.id);
  const next = catalogTitleFor(g.name, year);
  if (next) { stmts.setGameTitle.run(next, g.id); claimTitle(next, g.id); }
}

/** a slug no other game has: the name's, then with its year, then numbered */
function uniqueGameSlug(name: string, year: number | null): string {
  const base = slugify(name);
  const taken = (s: string) => !!db.query("SELECT 1 FROM games WHERE slug=?").get(s);
  for (const s of [base, year ? `${base}-${year}` : null]) if (s && !taken(s)) return s;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

/** year and release date must tell the same story: the searcher asks with the year and the tracker fires on the date */
function checkYear(year: number | null, releaseIso: string | null) {
  const y = yearOfIso(releaseIso);
  if (year != null && y != null && y !== year) throw new LibraryError(`the year (${year}) and the release date (${releaseIso}) disagree`);
}

async function addManualGame(body: AddBody): Promise<LibraryGame> {
  const checked = validateGameDraft(body.game ?? null);
  if (!checked.ok || !checked.value) throw new LibraryError(checked.errors.join("; ") || "the game must be described");
  const d = checked.value as Partial<GameDraft> & { name: string };
  const releaseIso = d.releaseIso ?? null;
  checkYear(d.year ?? null, releaseIso);
  const year = d.year ?? yearOfIso(releaseIso);
  const aliases = cleanAliases(d.name, d.aliases ?? []);
  const where = placement(body);
  if (body.force !== true) refuseDuplicate(d.name, aliases, year);
  // art links are fetched before anything is written: a link that gives no image refuses the add instead of leaving a
  // game without the art that was asked for
  const art: [ArtKind, ArtImage][] = [];
  for (const [kind, url] of [["poster", body.posterUrl], ["banner", body.bannerUrl]] as const) {
    if (url === undefined || url === null || url === "") continue;
    if (typeof url !== "string") throw new LibraryError(`${kind}Url: an https link to an image`);
    art.push([kind, await fetchArtUrl(url)]);
  }
  // asked again with nothing awaited before the insert: the same game added twice at once got past the first ask while
  // its art was loading
  if (body.force !== true) refuseDuplicate(d.name, aliases, year);
  const row = db.query(`INSERT INTO games (name, slug, summary, release_year, release_iso, genres_json, platforms_json, developer, publisher, source, aliases_json, search_terms_json, coming_soon)
    VALUES (?,?,?,?,?,?,?,?,?,'manual',?,?,0) RETURNING *`).get(
    d.name, uniqueGameSlug(d.name, year), d.summary ?? null, year, releaseIso, JSON.stringify(d.genres ?? []), JSON.stringify(d.platforms ?? []),
    d.developer ?? null, d.publisher ?? null, JSON.stringify(aliases), JSON.stringify(cleanTerms(d.searchTerms ?? []))) as GameRow;
  const titleId = catalogTitleFor(d.name, year);
  if (titleId) { stmts.setGameTitle.run(titleId, row.id); claimTitle(titleId, row.id); }
  for (const [kind, img] of art) {
    try { await storeCustomArt(row.id, kind, img); }
    catch (e: any) { log.warn(`${d.name}: could not keep the ${kind}: ${e?.message ?? e}`); }
  }
  return finishAdd(stmts.gameById.get(row.id) as GameRow, body, where);
}

/* ─────────── edit ─────────── */

export async function updateGame(id: number, body: { monitored?: boolean; profileId?: number | null; rootFolderId?: number | null; tags?: string[]; platform?: string | null }): Promise<LibraryGame> {
  const g = stmts.gameById.get(id) as GameRow | undefined;
  if (!g) throw new LibraryError("no such game", 404);
  const monitored = body.monitored ?? (g.monitored ?? 1) === 1;
  // another version is asked for: what is being looked for (or fetched) was for the old one and stops, and a game that is
  // watched and has no copy is looked for again at once, in the new one
  let again = false;
  if (body.platform !== undefined) {
    const want = wantedFor(g, body.platform);
    if (want !== wantedPlatform(g.want_platform)) {
      db.query("UPDATE games SET want_platform=? WHERE id=?").run(want, id);
      const active = stmts.requestActiveForGame.get(id) as RequestRow | undefined;
      if (active && active.state !== "ready") await cancelRequest(active.id, true);
      again = !stmts.packageForGame.get(id);
      log.info(`${g.name}: the version to look for is ${want ? PLATFORM_LABEL[want] : "not chosen"}`);
    }
  }
  if (body.profileId && !profiles().some(p => p.id === body.profileId)) throw new LibraryError("no such profile", 404);
  if (body.rootFolderId && !rootFolders().some(r => r.id === body.rootFolderId)) throw new LibraryError("no such root folder", 404);
  stmts.setGameLibrary.run(monitored ? 1 : 0, body.profileId === undefined ? g.profile_id : body.profileId, body.rootFolderId === undefined ? g.root_folder_id : body.rootFolderId, JSON.stringify(body.tags ?? list(g.tags_json)), id);
  const fresh = stmts.gameById.get(id) as GameRow;
  const st = statusOf(fresh, stmts.packageForGame.get(id) as PackageRow | undefined, null, buildFor(id)).status;
  if (monitored && st === "unreleased") await follow({ gameId: id }).catch(() => {});
  if (!monitored) { try { unfollow(id); } catch { /* was not tracked */ } }
  if (again && monitored && st === "missing") createRequest({ gameId: id, by: "manual" });
  events.emit("game" as never, serializeLibraryGame(fresh));
  return serializeLibraryGame(stmts.gameById.get(id) as GameRow);
}

const DETAIL_FIELDS = ["name", "aliases", "platforms", "year", "releaseIso", "summary", "genres", "developer", "publisher", "searchTerms"] as const;
/** what a game from a store or the catalog keeps editable: how it is searched (the rest comes from its source) */
const SEARCH_FIELDS = ["aliases", "searchTerms"];
const SOURCE_WORD: Record<string, string> = { steam: "Steam", igdb: "IGDB", catalog: "the catalog" };

/**
 * PUT /game/:id/details — a game added by hand: any field of its description; any other game: the other names it goes
 * by and its search terms only (everything else comes from its source, and a refresh would undo the edit). A field this
 * route does not know is refused rather than ignored.
 */
export async function updateDetails(id: number, body: unknown): Promise<LibraryGame> {
  const g = stmts.gameById.get(id) as GameRow | undefined;
  if (!g) throw new LibraryError("no such game", 404);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new LibraryError("send the fields to change as an object");
  const { force, ...fields } = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  const unknown = keys.filter(k => !(DETAIL_FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw new LibraryError(`not a field of a game's details: ${unknown.join(", ")} (they are ${DETAIL_FIELDS.join(", ")})`);
  if (!keys.length) throw new LibraryError("nothing to change: send the fields to change");
  const manual = g.source === "manual";
  if (!manual) {
    const locked = keys.filter(k => !SEARCH_FIELDS.includes(k));
    if (locked.length) throw new LibraryError(`${locked.join(", ")} ${locked.length === 1 ? "comes" : "come"} from ${SOURCE_WORD[g.source] ?? g.source}: on this game only aliases and searchTerms can be changed`);
  }
  const checked = validateGameDraft(fields, { partial: true });
  if (!checked.ok || !checked.value) throw new LibraryError(checked.errors.join("; "));
  const v = checked.value;
  const has = (k: string) => k in fields;
  const name = v.name ?? g.name;
  const releaseIso = has("releaseIso") ? v.releaseIso ?? null : g.release_iso;
  // the year follows the date when only the date is given; an explicit year must agree with it
  const year = has("year") ? (v.year ?? yearOfIso(releaseIso)) : has("releaseIso") ? (yearOfIso(releaseIso) ?? g.release_year) : g.release_year;
  if (manual) checkYear(has("year") ? v.year ?? null : year, releaseIso);
  const aliases = has("aliases") || has("name") ? cleanAliases(name, has("aliases") ? v.aliases ?? [] : list(g.aliases_json)) : null;
  if (manual && (has("name") || has("year") || has("releaseIso")) && force !== true) refuseDuplicate(name, aliases ?? list(g.aliases_json), year, id);
  const sets: string[] = [], vals: (string | number | null)[] = [];
  const set = (col: string, val: string | number | null) => { sets.push(`${col}=?`); vals.push(val); };
  if (has("name")) set("name", name);                      // the slug stays: installed copies are kept under it
  if (aliases) set("aliases_json", JSON.stringify(aliases));
  if (has("searchTerms")) set("search_terms_json", JSON.stringify(cleanTerms(v.searchTerms ?? [])));
  if (has("platforms")) set("platforms_json", JSON.stringify(v.platforms ?? []));
  if (has("year") || has("releaseIso")) set("release_year", year);
  if (has("releaseIso")) set("release_iso", releaseIso);
  if (has("summary")) set("summary", v.summary ?? null);
  if (has("genres")) set("genres_json", JSON.stringify(v.genres ?? []));
  if (has("developer")) set("developer", v.developer ?? null);
  if (has("publisher")) set("publisher", v.publisher ?? null);
  db.query(`UPDATE games SET ${sets.join(", ")}, updated_at=unixepoch() WHERE id=?`).run(...vals, id);
  // under another name or year it may be another catalog title's game (before changed() below has the catalog ingest again)
  if (manual && (has("name") || has("year") || has("releaseIso"))) relinkTitle(stmts.gameById.get(id) as GameRow);
  const fresh = stmts.gameById.get(id) as GameRow;
  const monitored = (fresh.monitored ?? 1) === 1;
  if (monitored && (has("year") || has("releaseIso")) && statusOf(fresh, stmts.packageForGame.get(id) as PackageRow | undefined, null, buildFor(id)).status === "unreleased")
    await follow({ gameId: id }).catch(e => log.warn(`${fresh.name}: could not track the release: ${e?.message ?? e}`));
  events.emit("game" as never, serializeLibraryGame(fresh));
  changed(id, "changed");
  return serializeLibraryGame(fresh);
}

/** PUT /game/:id/art/:kind — the game's own art of that kind (automatic art never replaces it) */
export async function setGameArt(id: number, kind: ArtKind, img: ArtImage): Promise<LibraryGame> {
  if (!stmts.gameById.get(id)) throw new LibraryError("no such game", 404);
  await storeCustomArt(id, kind, img);
  return artChanged(id);
}
/** DELETE /game/:id/art/:kind — back to automatic art */
export async function resetGameArt(id: number, kind: ArtKind): Promise<LibraryGame> {
  const g = stmts.gameById.get(id) as GameRow | undefined;
  if (!g) throw new LibraryError("no such game", 404);
  if (!customArtOf(g).files[kind]) throw new LibraryError(`${g.name} has no ${kind} of its own`, 404);
  await clearCustomArt(id, kind);
  return artChanged(id);
}
function artChanged(id: number): LibraryGame {
  const fresh = stmts.gameById.get(id) as GameRow;
  events.emit("game" as never, serializeLibraryGame(fresh));
  changed(id, "changed");
  return serializeLibraryGame(fresh);
}

export async function deleteGame(id: number, opt: { deleteFiles?: boolean } = {}) {
  const g = stmts.gameById.get(id) as GameRow | undefined;
  if (!g) throw new LibraryError("no such game", 404);
  const active = stmts.requestActiveForGame.get(id) as RequestRow | undefined;
  if (active && active.state !== "ready") await cancelRequest(active.id, true).catch(() => {});
  // everything still being made for the game stops first: a way being built, a game file being taken in, an import — the
  // request's (cancelled above already) or one the admin started by hand, which has no request. One that finished after the
  // game was gone would leave a package folder no game owns, and a queued import would run for no game at all.
  for (const j of db.query("SELECT id FROM jobs WHERE game_id=? AND state IN ('queued','running')").all(id) as { id: number }[]) cancelJob(j.id);
  // then the rows, with nothing awaited between them: a build that stores its package meanwhile is either among these or
  // finds the game gone. The files go afterwards.
  const pkgs = db.query("SELECT * FROM packages WHERE game_id=?").all(id) as PackageRow[];
  for (const p of pkgs) stmts.deletePackage.run(p.id);
  try { unfollow(id); } catch { /* not tracked */ }
  record(null, "deleted", { gameName: g.name, message: opt.deleteFiles ? "files deleted" : "files kept" });
  stmts.deleteGame.run(id);
  if (opt.deleteFiles) {
    for (const p of pkgs) await removeTree(p.path).then(left => { if (left.length) log.warn(`${p.path}: ${left.length} entries still held open were not deleted`); }, e => log.warn(`could not delete ${p.path}: ${e?.message ?? e}`));
  }
  await removeCustomArtFiles(id).catch(e => log.warn(`${g.name}: could not remove its own art: ${e?.message ?? e}`));
  events.emit("game" as never, { id, deleted: true });
  changed(id, "deleted");
  log.info(`deleted ${g.name}${opt.deleteFiles ? " and its files" : ""}`);
}

/** the Refresh button: re-read metadata and art from the game's source (Steam today; a catalog-only game keeps what it has) */
export async function refreshGame(id: number): Promise<LibraryGame> {
  const g = stmts.gameById.get(id) as GameRow | undefined;
  if (!g) throw new LibraryError("no such game", 404);
  if (g.source === "manual") throw new LibraryError("a game added by hand has no source to refresh it from", 400);
  if (g.steam_appid) {
    const r = await onboardSteamApps([g.steam_appid]);
    if (!r.saved[0]) throw new LibraryError(`Steam no longer answers for app ${g.steam_appid}`, 502);
  } else if (g.igdb_id) {
    const client = igdbClient();
    if (!client) throw new LibraryError("IGDB is not configured (Settings → Metadata)", 400);
    const d = (await client.details([g.igdb_id]))[0];
    if (!d) throw new LibraryError(`IGDB no longer answers for game ${g.igdb_id}`, 502);
    upsertGame(igdbToGameRow(d));
  } else throw new LibraryError("this game came from the catalog; there is no source to refresh it from", 400);
  if (g.steam_appid) await checkGame(stmts.gameById.get(id) as GameRow).catch(() => null);      // DRM and crack status alongside
  const fresh = stmts.gameById.get(id) as GameRow;
  events.emit("game" as never, serializeLibraryGame(fresh));
  changed(id, "changed");
  return serializeLibraryGame(fresh);
}

/** the Search button: a missing game is searched; a game with a copy is searched for a better one (when its profile allows
 *  upgrades) — a console dump players cannot start, of a game with a way to play, is searched for that way's game file */
export function searchGame(id: number) {
  const g = stmts.gameById.get(id) as GameRow | undefined;
  if (!g) throw new LibraryError("no such game", 404);
  const pkg = stmts.packageForGame.get(id) as PackageRow | undefined;
  if (pkg && !(classOfPackage(pkg) === "rom" && requestWay(g))) {
    const prof = profileFor(g);
    if (!prof.upgrade) throw new LibraryError(`${g.name} already has a copy and upgrades are off in the "${prof.name}" profile`, 409);
    if (classOfPackage(pkg) === "uploaded") throw new LibraryError(`${g.name} has the copy you uploaded: it is replaced only by a release you pick yourself (Interactive Search) or by another upload`, 409);
    if (!wantsUpgrade(prof, classOfPackage(pkg))) throw new LibraryError(`${g.name} already has a ${classOfPackage(pkg)} copy, which meets the profile's cutoff`, 409);
    return createRequest({ gameId: id, by: "upgrade" });
  }
  return createRequest({ gameId: id, by: "manual" });
}

/* ─────────── wanted / calendar ─────────── */

export function wantedMissing(): LibraryGame[] { return listGames().filter(g => g.status === "missing" || g.status === "failed"); }

/** the automatic searcher: every monitored, released game without a copy — and every copy below its profile's cutoff — gets a search */
export function searchMissing(): number {
  let n = 0, up = 0;
  for (const g of wantedMissing()) {
    if (g.status === "failed" && g.request?.doneAt && Date.now() / 1000 - g.request.doneAt < 86_400) continue;   // give a failed one a day before trying again
    const r = createRequest({ gameId: g.id, by: "auto" });
    if (!r.duplicate) n++;
  }
  for (const g of cutoffUnmet()) {
    if (!g.monitored || g.request && ["requested", "matching", "fetching", "processing"].includes(g.request.state)) continue;
    const r = createRequest({ gameId: g.id, by: "upgrade" });
    if (!r.duplicate) up++;
  }
  if (n || up) log.info(`searching for ${n} missing game${n === 1 ? "" : "s"} and ${up} upgrade${up === 1 ? "" : "s"}`);
  return n + up;
}
export function cutoffUnmet(): LibraryGame[] { return listGames().filter(g => g.cutoffUnmet); }

export function calendar(start: string, end: string) {
  const m = maps();
  return (stmts.gamesByRelease.all(start, end) as GameRow[]).map(g => serializeLibraryGame(g, m));
}

/* ─────────── add new: lookups ─────────── */

/** choices: the versions it can be asked for (src/platforms.ts platformChoices), each with its name; one or none is no choice */
export interface LookupResult extends LookupHit { source: string; gameId: number | null; status: GameStatus | null; kinds?: string[]; choices?: { id: PlatformId; label: string }[] }

/** how a library game is named in a lookup: by its store id when it has one (so the store's own hit for it folds in), else
 *  its catalog title, else the game itself */
function libraryId(g: GameRow): { scheme: string; value: string } {
  if (g.steam_appid) return { scheme: "steam", value: String(g.steam_appid) };
  if (g.igdb_id) return { scheme: "igdb", value: String(g.igdb_id) };
  if (g.source === "catalog" && g.title_id) return { scheme: "catalog", value: String(g.title_id) };
  return { scheme: "game", value: String(g.id) };
}

/** library games whose name or one of whose other names holds the term: exact first, then starting with it, then a word
 *  starting with it, then anything containing it */
function libraryMatches(term: string, limit = 12): GameRow[] {
  const want = nameKey(term);
  if (!want) return [];
  const rank = (n: string) => (n === want ? 0 : n.startsWith(want) ? 1 : ` ${n}`.includes(` ${want}`) ? 2 : n.includes(want) ? 3 : 9);
  return (stmts.allGames.all() as GameRow[])
    .map(g => ({ g, r: Math.min(...[g.name, ...list(g.aliases_json)].map(n => rank(nameKey(String(n))))) }))
    .filter(x => x.r < 9)
    .sort((a, b) => a.r - b.r || a.g.name.localeCompare(b.g.name, undefined, { sensitivity: "base" }))
    .slice(0, limit).map(x => x.g);
}

export async function lookup(term: string): Promise<LookupResult[]> {
  const t = term.trim();
  if (!t) return [];
  const out: LookupResult[] = [];
  const seen = new Set<string>();
  const inLibrary = new Set<number>();            // library games already listed: no second hit for the same game
  const builds = activeBuilds();
  const statusOfGame = (g: GameRow) => statusOf(g, stmts.packageForGame.get(g.id) as PackageRow | undefined, stmts.requestActiveForGame.get(g.id) as RequestRow | undefined, builds.get(g.id) ?? null).status;
  const push = (source: string, h: LookupHit, known?: GameRow): LookupResult | null => {
    const key = `${h.id.scheme}:${h.id.value}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const k = known ?? gameOfStoreId(h.id.scheme, h.id.value);
    if (k && inLibrary.has(k.id) && source !== "library") return null;
    if (k) inLibrary.add(k.id);
    const r: LookupResult = { ...h, source, gameId: k?.id ?? null, status: k ? statusOfGame(k) : null, choices: platformChoices(h.platforms ?? []).map(id => ({ id, label: PLATFORM_LABEL[id] })) };
    out.push(r);
    return r;
  };
  // the library first: a game added by hand is found by its name and by every name it goes by
  for (const g of libraryMatches(t)) {
    push("library", { id: libraryId(g), name: g.name, year: yearOf(g), platforms: list(g.platforms_json), cover: g.cover_url, summary: g.summary, releaseIso: g.release_iso }, g);
  }
  // then the catalog: it answers instantly and knows console titles too
  for (const c of queryTitles({ q: t, limit: 12, sources: activeSources() }).titles) {
    const known = c.gameId ? (stmts.gameById.get(c.gameId) as GameRow | undefined) : undefined;
    const steam = db.query("SELECT value FROM title_ids WHERE title_id=? AND scheme='steam'").get(c.id) as { value: string } | undefined;
    const hit: LookupHit = steam
      ? { id: { scheme: "steam", value: steam.value }, name: c.name, year: c.year, platforms: c.platforms, cover: c.cover, summary: null, releaseIso: c.releaseIso }
      : { id: { scheme: "catalog", value: String(c.id) }, name: c.name, year: c.year, platforms: c.platforms, cover: c.cover, summary: null, releaseIso: c.releaseIso };
    // a title that belongs to a library game is that game, whatever store id it carries (a game added by hand holds it)
    const r = push("catalog", hit, known);
    if (r) r.kinds = c.kinds;
  }
  const sources: { name: string; source: MetadataSource }[] = registry.metadataSources().filter(x => x.source.lookup).map(x => ({ name: x.row.impl, source: x.source }));
  await Promise.all(sources.map(async s => {
    try { for (const h of await s.source.lookup!(t, registry.pluginContext("catalog"))) push(s.name, h); }
    catch (e: any) { log.warn(`${s.name} lookup failed: ${e?.message ?? e}`); }
  }));
  return out.slice(0, 40);
}
