/**
 * ludarr — the searcher: a monitored game without a copy → a ready, imported one.
 *
 *   requested ─► matching ─► fetching ─► processing ─► ready
 *       │            │           │            │
 *       └────────────┴───────────┴────────────┴──► failed   (or cancelled)
 *
 * A request is one search in flight for a game. The matcher asks every indexer, orders candidates by the
 * game's profile (formats best first, protocol preference) and grabs the first. Every later failure
 * (payload, client, transfer, import) blocklists the release and moves on to the next candidate until
 * they run out. Row changes are published on the event bus for the UI.
 *
 * What it takes by itself is only what is certainly the game (a wrong game is far worse than none): nothing in its name
 * stands in the way (src/releases.ts nameRefusals), it is not far smaller than the other copies, it was not posted before
 * the game existed, and CrackWatch does not say the game is still uncracked (automaticRefusals) — a game whose only DRM is
 * Steam's own (or none), out these last 90 days and not an online game, counts as cracked once GazelleGames has a cracking
 * group's or a repacker's release of it (or a Home Rip) with its year, posted since it came out, and the grab's history line
 * says so; copies posted before it came out still wait (autoContext). A new Steam game CrackWatch was never asked about is
 * looked up once first. A search that takes nothing says why (requests.refused_json, the stage and
 * the message) and looks again later; a refusal blocklists nothing. The same release posted twice counts once: its other
 * posts follow the round's releases, and the candidate list made at search time is checked against the blocklist again at
 * each grab — a post that failed on its source (a dead post, a stall) blocks that post only, so the next post of the release
 * is tried; a copy that was refused (its import failed, the admin removed it) blocks its title, every post of it. A list made
 * under older rules (RULES) has each title judged again at its grab. A game that is on PC falls back to a console dump only
 * for a console it is known to be on, and not while CrackWatch says it is uncracked (consoleFallback).
 *
 * A game players cannot start yet (no copy, or a console dump) that has a way to play whose plan is ready is searched for
 * through that way (requests.way_id; src/ways/find.ts picks the best and runs its content pass): the way's console only,
 * its download taken in by a 'content' job that proves the game file and queues the way's build, and the request is ready
 * once that build is. A download the way refuses is blocklisted for that way only and the next candidate is tried; one
 * nothing can prove is kept for the admin; a check that could not be made (no room, a tool missing, the way being built)
 * is tried again later, a few times, and blocklists nothing; a make that failed on the download (the recipe's fault: the
 * carry run repairs it) ends the search with the download kept, and blocklists nothing either. A way deleted mid-search
 * ends its branch: the download goes and the request is the game's own search again. An admin's "Find it on my indexers"
 * is such a search for the way they picked (requested_by 'find-files'); of two searches of the game for one way, the
 * admin's, the further along or the older goes first and the other waits.
 *
 * A way's search looks before it grabs: the release's own listing (a .torrent's file list, an NZB's subjects) that cannot
 * hold the way's game file is refused without a download (src/ways/find.ts judgeListing), and the payload it was read from
 * is the one the grab sends (the indexer is asked once). Every release refused for a way is blocklisted with the version
 * of the way's game file plan it was refused under (plan_digest) and why ('identity': another title, version, or a file
 * whose own bytes say it is sealed — never again; 'form': nothing in a form the way took then, a sealed form a listing
 * names among them — looked at again once the plan takes another form, as after a carry run's upgrade gives it a make).
 *
 * The seedbox's trouble is never the copy's (src/remote.ts). A job that read the seedbox's mapped folder while it did not
 * answer, was remounted or failed a read (its fail kind 'remote'), a download client that did not answer a grab, a
 * transfer it broke off: the request waits — 1, 2, 5, 10, 20, 30, 60 min, then hourly, each retry once the folder answered
 * steadily — and runs the same job, sends the same grab, resumes the same transfer; nothing is tried, blocklisted or
 * fetched in its place, and the stage says why in plain words (players read "Preparing"). A download that is not in the
 * folder is looked for again (at 1, 3, 7 and 15 min): gone for good — a failure of its source, that post only — only when
 * it was missing each time AND its client no longer has it; while the client still has it, the wait asks about the mapping.
 * A child program's I/O words get one confirming re-run. A health warning after 2 h, an error and the stage asking after
 * 6 h; 72 h on, the request stops with the download kept and nothing blocklisted (remote_json stopped: Retry resumes it).
 *
 * The finished-downloads folder (src/synced.ts, src/arrivals.ts): the download is awaited where the admin's own sync brings
 * it and imported there, in place. One that left that folder before its import (its own cleanup took it) is lost, never gone from the seedbox:
 * nothing is blocklisted, nothing else is grabbed, and the search follows the same download again.
 */
import { existsSync } from "node:fs";
import { automaticProblem, needsTitleReport } from "./ways/emulator-scope";
import { CONSOLE_CATEGORIES, CONSOLE_PLATFORMS, PLATFORM_LABEL, consolePlatforms, hasPc, isConsole, wantedPlatform, type PlatformId } from "./platforms";
import { db, stmts, serializeRequest, type RequestRow, type GameRow, type FetchRow, type JobRow, type PackageRow } from "./db";
import { cfgNum } from "./config";
import { events } from "./events";
import { logger } from "./log";
import { grab, remove as removeFetch, retry as retryFetch, clientFor, FetchError, stallNoteOf, troubleOf } from "./fetch";
import { searchReleases, type SearchOptions, type SearchResult } from "./search";
import { cancelJob } from "./process/runner";
import { enqueueJob } from "./process/kinds";
import { classOfPackage, profileFor, wantsUpgrade, type InstallClass, type Profile } from "./library/profiles";
import { record } from "./library/history";
import * as registry from "./plugins/registry";
import type { Payload } from "./plugins/types";
import { certainlyThisGame, isCrackGroup, isRepacker, nameQueries, nameRefusals, rankForNames, type ReleaseView } from "./releases";
import type { Ensured } from "./ways/recipes";
import { SIZE_RANGE, buildBlocker, contentQuery, heldFor, judgeContent, judgeListing, listingOf, prepareContentPass, refusedDownload, releaseDownload, requestWay, wayBlocked, type Listed, type TakeOutcome } from "./ways/find";
import { contentMatches } from "./ways/match";
import { assembling, contentDigest, contentFacts, currentPackage, getContent, getPlan, getWay, wayContent, type PlanRow, type WayRow } from "./ways/store";
import type { FailInfo } from "./ways/types";
import { FINISHED_FOLDER, FROZEN_ASK_SEC, goneRule, inWords, ladderSec, lookSec, placeOf, rmdeps as remoteDeps, rootOf, rootState, rootSteady, STOP_AFTER_SEC, syncedRoot, tail, waitStage, type ClientView, type RemoteWait, type Trouble, type Weight } from "./remote";
import { arrivalOf, arrivalStage, fromSeedbox, markLost, rearrive, resumeArrival, seedboxMissed } from "./arrivals";

const log = logger("Search");

export class RequestError extends Error {
  constructor(msg: string, public status = 400) { super(msg); }
}

/** another search still on this download (grab hands back the download a post already has, whatever game it was taken for) */
const otherSearchQ = db.query("SELECT r.id, g.name AS game_name FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.fetch_id=? AND r.id<>? AND r.state IN ('requested','matching','fetching','processing') ORDER BY r.id LIMIT 1");
const otherSearchOn = (fetchId: number, me: number) => (otherSearchQ.get(fetchId, me) as { id: number; game_name: string | null } | null) ?? null;
/** this search lets go of its download: removed — unless another search is still on it, whose download it is too (cancelling
 *  or stalling one search never takes the download from under the other) */
async function dropFetch(me: number, fetchId: number, purge: boolean): Promise<void> {
  const other = otherSearchOn(fetchId, me);
  if (other) { rdeps.log(`#${me} lets go of download #${fetchId}; it stays: search #${other.id} is still on it`); return; }
  await removeFetch(fetchId, purge);
}

/** what the searcher needs from a search: the ranked releases */
type Searcher = (name: string, year: number | null, opt?: SearchOptions) => Promise<Pick<SearchResult, "ranked">>;

/** swappable in tests */
export const rdeps = {
  search: searchReleases as Searcher,
  grab,
  /** usenet is preferred only when a client can actually take an NZB */
  usenetAvailable: async (): Promise<boolean> => !!clientFor("usenet"),
  agentReady: (): boolean => { const a = registry.instanceRows("importer").find(r => r.impl === "agent"); try { return !!a?.enabled && !!JSON.parse(a.settings_json).apiKey; } catch { return false; } },
  log: (...a: unknown[]) => log.log(...a),
  now: () => Date.now(),
  /** what a release holds by its own listing, before it is grabbed (null: the listing cannot be had — a magnet, an indexer
   *  that does not answer — and the release is judged as it always was); the payload is kept for the grab that follows */
  peek: async (r: ReleaseView): Promise<Listed[] | null> => {
    try { const payload = await rdeps.payload(r); if (!payload) return null; keepPeeked(r.guid, payload); return listingOf(payload); } catch { return null; }
  },
  /** a release's payload (its .torrent, .nzb or magnet) from the indexer that found it, or null when that indexer is gone */
  payload: async (r: ReleaseView): Promise<Payload | null> => {
    const indexer = registry.indexerById(r.instanceId);
    return indexer ? indexer.download(r) : null;
  },
  /** CrackWatch, asked about one game (src/crackwatch-sync.ts checkGame: it stores the verdict; null when it could not be
   *  asked) — before the first search of a new Steam game it has no verdict for */
  crackCheck: async (g: GameRow): Promise<unknown> => (await import("./crackwatch-sync")).checkGame(g),
  /** how long that lookup may take before the search goes on without it */
  crackWaitMs: 8000,
  /** the way a game asked for in a console's version gets through that console's emulator, by itself (src/ways/recipes.ts) */
  ensureWay: async (g: GameRow, platform: PlatformId): Promise<Ensured> => (await import("./ways/recipes")).ensureWay(g, platform),
};

/** the payloads (.torrent, .nzb) a way's search read listings from, kept a few minutes for the grab that follows: an indexer
 *  counts every fetch of a release's payload as a grab (Prowlarr's grab limits), so it is asked once */
const peeked = new Map<string, { payload: Payload; at: number }>();
const PEEK_KEEP_MS = 10 * 60_000;
function keepPeeked(guid: string, payload: Payload): void {
  const now = Date.now();
  for (const [k, v] of peeked) if (now - v.at > PEEK_KEEP_MS) peeked.delete(k);
  peeked.set(guid, { payload, at: now });
}
function takePeeked(guid: string): Payload | undefined {
  const v = peeked.get(guid);
  peeked.delete(guid);
  return v && Date.now() - v.at <= PEEK_KEEP_MS ? v.payload : undefined;
}

/** a search an admin aimed at one way to play ("Find it on my indexers"): it stays that way's */
export const FOR_WAY = "find-files";

/* ─────────────────────── policy ─────────────────────── */

/** how likely the importer is to turn this into a game folder without running anything */
export function installClass(r: ReleaseView): InstallClass {
  if (r.flags?.platform && r.flags.platform !== "pc") return "rom";          // a console dump is unpacked as it is
  const f = (r.parsed.format ?? "").toLowerCase();
  const t = r.title.toLowerCase();
  if (/home rip|drm.?free/.test(f)) return "clean";
  if (/\b(gog|humble|drm.?free|itch\.io|itch)\b/.test(t) || /gog/i.test(r.parsed.edition ?? "")) return "clean";
  if (/full iso/.test(f)) return "iso";
  if (/gamedox/.test(f)) return "installer";
  if (r.parsed.repack) return "repack";
  if (r.parsed.scene) return "iso";
  return "unknown";
}

/** a download's progress as a share 0..1: a value over 1 is a percent (a folder-watch pull reported 88 for 88 %, which the
 *  transfer leg turned into 31.3 and the apps showed as 3130 %) */
const share = (v: number | null | undefined) => { const x = Number(v ?? 0); const f = x > 1 ? x / 100 : x; return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0; };

/** is this release certainly *this* game — the test lives with the ranking (src/releases.ts), so ranking a release
 *  under several names can apply it without an import cycle; it stays importable from here */
export { certainlyThisGame };

/** a torrent posted in the last few hours with no seeders yet is the uploader still announcing, not a dead torrent — the stall watchdog catches the real ones */
const FRESH_TORRENT_SEC = 12 * 3600;
export function justPosted(r: ReleaseView): boolean {
  const t = Date.parse(r.publishDate ?? "");
  return Number.isFinite(t) && rdeps.now() - t < FRESH_TORRENT_SEC * 1000;
}

const has = (title: string, words: string[]) => words.some(w => title.toLowerCase().includes(w.toLowerCase()));

/** a release's title as the dedupe and the blocklist compare it: its letters and digits, one space between each run of them
 *  ("Outer.Wilds-CODEX" = "Outer Wilds CODEX"; "v1.1.2" is not "v1.12") */
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** the rules a candidate list was made under (requests.candidates_json, each candidate's `judged`): a list made under older
 *  ones — a search in flight when ludarr was updated — has each title judged again at its grab */
export const RULES = "2026-11-10.2";
const normalized = new WeakMap<Set<string>, Set<string>>();
/** is a release on the blocklist (`blocked`: guids and titles) — by its guid, its title, or its title written another way */
export function isBlocked(blocked: Set<string> | undefined, r: { guid: string; title: string }): boolean {
  if (!blocked?.size) return false;
  if (blocked.has(r.guid) || blocked.has(r.title)) return true;
  let norm = normalized.get(blocked);
  if (!norm) { norm = new Set([...blocked].map(normTitle).filter(Boolean)); normalized.set(blocked, norm); }
  const n = normTitle(r.title);
  return !!n && norm.has(n);
}

/* ─────────── what the automatic searcher will not take, and why ─────────── */

const DAY = 86_400_000;
/** a console dump (it names a console): the rules below are the PC pass's — a dump's size, date and DRM say nothing (a Mac
 *  or Android build in a PC pass is judged by them like any PC release, and refused by its kind anyway) */
const dumpView = (v: ReleaseView) => isConsole(v.flags?.platform);
const sizeText = (n: number) => (n >= 1e8 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
/** the title of a store copy (GOG, "DRM Free"), as uploaders write it: anyone can write it, so it counts only beside a copy a
 *  curated tracker marks DRM-free (curatedDrmFree) */
const DRM_FREE = /(?<![a-z0-9])gog(?![a-z0-9])|drm[\s._-]?free/i;
/** a copy a curated tracker marks DRM-free: GazelleGames' "DRM Free" format, or its "Home Rip" of a "[GOG Edition YYYY]" — a
 *  "-GOG" group or "DRM-Free" in a free-text name is what a fake of a Denuvo game says too (review, 2026-11-09) */
const curatedDrmFree = (v: ReleaseView) => /drm[\s._-]?free/i.test(v.parsed.format ?? "") || (/home rip/i.test(v.parsed.format ?? "") && /\[\s*gog\s+edition\b/i.test(v.title));

/**
 * What CrackWatch's DRM field says protects a game, as the crack rule reads it (the field as the site writes it: "Steam",
 * "Denuvo + Steam", "Ricochet + Battle.net", "Theia + PSN"). 'steam': Steam's own DRM and nothing else (the Steamworks stub,
 * which the scene cracks on release day), an anti-cheat for online play or Epic's online services beside it ("Steam + Easy
 * Anti-Cheat", "Steam + EOS"), a protection the field says was removed ("Steam (Denuvo removed)"), another store's copy that
 * has none ("Steam / GOG"); 'none': no DRM, a store named or not ("DRM-Free (GOG)", "No DRM (Steam)"); 'strong': a protection
 * that holds (STRONG_DRM), Steam named beside it or not; 'unknown': no field, or a name the rule does not know. Strong and
 * unknown DRM wait for CrackWatch's "cracked": what it names beside an uncracked game is a protection (the adversarial set's
 * Black Ops 7 fake: "Ricochet + Battle.net"; MARVEL Tōkon, "Theia + PSN", took RUNE eleven days), and neither the live library
 * nor the corpus ever had an uncracked game with one, so waiting there refuses no right copy.
 */
export type DrmKind = "steam" | "none" | "strong" | "unknown";
/** Denuvo, Arxan, VMProtect; a store's or a launcher's online check (EA app / Origin, Ubisoft Connect / Uplay, Battle.net, the
 *  Microsoft Store / UWP / Xbox app); always-online */
const STRONG_DRM = /denuvo|arxan|vmprotect|(?<![a-z0-9])(?:ea|origin|uwp)(?![a-z0-9])|ubisoft|uplay|battle[\s.]*net|always[\s-]*online|online[\s-]*(?:only|required|activation|check)|microsoft[\s-]*store|windows[\s-]*store|xbox/i;
const STRONG_DRM_ALL = new RegExp(STRONG_DRM.source, "gi");
/** no DRM, a store named beside it or not; GOG's own copies have none */
const NO_DRM = /^(?:none|gog)$|no[\s-]*drm|no[\s-]*protection|drm[\s._-]*free/i;
/** the words Steam's own DRM is written with: "Steam", "Steamworks", "Steam DRM", "SteamStub v3", "Steam CEG", "Steam API" */
const STEAM_WORDS = new Set(["steam", "steamworks", "steamstub", "ceg", "drm", "stub", "api"]);
/** what rides beside Steam and protects nothing a copy needs: an anti-cheat for online play, Epic's online services */
const BESIDE_STEAM = /^(?:vac|valve anti[\s-]*cheat|eac|easy[\s-]*anti[\s-]*cheat(?:\s*\(eos\))?|battl?eye|eos|epic online services)$/i;
/** one part of the field: what it names */
function drmPart(p: string): DrmKind | "beside" {
  if (/\bremoved\b/i.test(p)) {                                               // "Denuvo (removed)": what is left of the part
    const rest = p.replace(STRONG_DRM_ALL, " ").replace(/\bremoved\b/gi, " ").replace(/[()[\]]/g, " ").trim();
    return rest ? drmPart(rest) : "steam";
  }
  if (NO_DRM.test(p)) return "none";
  if (STRONG_DRM.test(p)) return "strong";
  if (BESIDE_STEAM.test(p)) return "beside";
  const w = p.toLowerCase().split(/[^a-z0-9]+/).filter(x => x && !/^v\d+$/.test(x));
  return w.some(x => x.startsWith("steam") || x === "ceg") && w.every(x => STEAM_WORDS.has(x)) ? "steam" : "unknown";
}
export function drmKind(drm: string | null | undefined): DrmKind {
  const parts = (drm ?? "").split(/\s*(?:[+/,&;|]|(?<![a-z0-9])(?:and|with)(?![a-z0-9]))\s*/i).map(p => p.trim()).filter(Boolean).map(drmPart);
  if (!parts.length) return "unknown";
  if (parts.includes("strong")) return "strong";
  if (parts.every(k => k === "none")) return "none";
  return parts.includes("steam") && parts.every(k => k === "steam" || k === "none" || k === "beside") ? "steam" : "unknown";
}

/** what the game being searched for says about its copies: its store date, IGDB's first date, its year, CrackWatch's verdict,
 *  its genres and modes (an online game) */
export type GameFacts = Partial<Pick<GameRow, "release_iso" | "release_year" | "first_release_date" | "crack_status" | "drm" | "genres_json" | "game_modes_json">>;
/** one size per release (the first post of each normalized title), sorted, with where each title sits */
interface SizeList { sizes: number[]; keys: string[]; at: Map<string, number> }
/** a release beside the rest of the search it came from (src/releases.ts judges each one alone) */
export interface AutoContext {
  /** the other copies of the game in the same search: the PC releases nothing in their names stands in the way of */
  copies: ReleaseView[];
  /** the copies' sizes: those the profile could take now (the size rule's median), and all of them (a real copy no one seeds
   *  still says how big the game is) */
  sizes: { takeable: SizeList; all: SizeList };
  /** the game's year (release_year, else its store date's) */
  year: number | null;
  /** the earliest moment the game is known to exist (ms): its store date, IGDB's first release, 1 January of the year a copy's
   *  tag gives (within two years of the game's — GazelleGames writes the first release's year, so an Epic-first or early access
   *  game is older than its Steam date — read off any copy whose name is the game's, one refused for that year too); null when
   *  nothing says */
  earliest: number | null;
  /** the game came out within the last two years (or is not out): a post more than a week before it is another game's; an older
   *  game's store date is often a later release (Steam), and its launch was posted up to two years before it */
  recent: boolean;
  /** CrackWatch's verdict when it says no copy can be real yet (uncracked, unreleased), its sync is on and the copies do not say
   *  otherwise (`cracked`); else null. `storeOut`: the store's date has passed (a "not out yet" from before it is stale);
   *  `kind`: what its DRM field says protects the game (drmKind); `miss`: why the copies found do not say it is cracked, when
   *  they could have (crackedAnyway), in words for the admin */
  crack: { status: string; drm: string | null; storeOut: boolean; kind: DrmKind; miss: string | null } | null;
  /** why the game counts as cracked though CrackWatch says it is not, in words for the admin (crackedAnyway): `by` the group
   *  or repacker (or the Home Rip), `title` its copy, `out` the store's date (ms) — copies posted before it are no part of it
   *  (beforeCracked) — and `says` what CrackWatch says; null when nothing says so, or CrackWatch does not stand in the way */
  cracked: { by: string; title: string; why: string; out: number; says: string } | null;
  /** a copy a curated tracker marks DRM-free is among the copies: the game has a DRM-free build, and its repacks are made from it */
  drmFree: boolean;
  now: number;
}
function sizeList(views: ReleaseView[]): SizeList {
  const first = new Map<string, number>();
  for (const o of views) { const k = normTitle(o.title); if (o.size > 0 && !first.has(k)) first.set(k, o.size); }
  const order = [...first].sort((a, b) => a[1] - b[1]);
  return { sizes: order.map(e => e[1]), keys: order.map(e => e[0]), at: new Map(order.map((e, i) => [e[0], i])) };
}
/** is a copy refused by its name for its year tag alone (2 years off): its tag still says when the game first came out */
const yearOnly = (v: ReleaseView) => v.flags?.yearOff === 2 && nameRefusals({ ...v, flags: { ...v.flags, yearOff: null } }).length === 0;
/**
 * The search a release came from, as the list rules read it. `takeable`: the copies the profile could take now (the size
 * rule's median counts those only, so a copy is not refused for the size of bundles no one seeds). `vouch`: the copies that may
 * say the game is cracked though CrackWatch says not (mayVouch: not a copy the search refused as bad, nothing the profile rules
 * out).
 */
export function autoContext(ranked: ReleaseView[], game?: GameFacts | null, now: number = rdeps.now(), takeable: (v: ReleaseView) => boolean = () => true, vouch: (v: ReleaseView) => boolean = () => true): AutoContext {
  const pc = ranked.filter(o => !dumpView(o));
  const copies = pc.filter(o => nameRefusals(o).length === 0);
  const year = game?.release_year ?? (game?.release_iso ? Number(game.release_iso.slice(0, 4)) || null : null);
  const dates: number[] = [];
  const iso = Date.parse(game?.release_iso ?? "");
  if (Number.isFinite(iso)) dates.push(iso);
  if (game?.first_release_date && game.first_release_date > 0) dates.push(game.first_release_date * 1000);
  if (year) for (const o of pc) if (o.parsed.year && Math.abs(o.parsed.year - year) <= 2 && (copies.includes(o) || yearOnly(o))) dates.push(Date.UTC(o.parsed.year, 0, 1));
  const earliest = dates.length ? Math.min(...dates) : null;
  const status = game?.crack_status ?? null;
  const crack = (status === "uncracked" || status === "unreleased") && cfgNum("CRACKWATCH_SYNC_HOURS", 6) > 0
    ? { status, drm: game?.drm ?? null, storeOut: Number.isFinite(iso) && iso <= now, kind: drmKind(game?.drm), miss: null } : null;
  const ctx: AutoContext = {
    copies, sizes: { takeable: sizeList(copies.filter(takeable)), all: sizeList(copies) }, year, earliest,
    recent: earliest == null || earliest > now - 730 * DAY, crack, cracked: null, drmFree: copies.some(curatedDrmFree), now,
  };
  const { cracked, miss } = crackedAnyway(ctx, game, vouch);
  return cracked ? { ...ctx, crack: null, cracked } : crack && miss ? { ...ctx, crack: { ...crack, miss } } : ctx;
}

/** the first index whose size is at least `x` (`strict`: more than `x`) */
function seek(sizes: number[], x: number, strict = false): number {
  let lo = 0, hi = sizes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (strict ? sizes[m] <= x : sizes[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
/** the median size of the other releases: each once, the release itself and anything within 2 % of its size (its reposts)
 *  left out; null when none is left */
function medianOthers(list: SizeList, key: string, size: number): number | null {
  const n = list.sizes.length, lo = seek(list.sizes, size * 0.98), hi = seek(list.sizes, size * 1.02, true);
  const own = list.at.get(key);
  const skip = own != null && (own < lo || own >= hi) ? own : -1;
  const left = lo - (skip >= 0 && skip < lo ? 1 : 0), m = left + (n - hi) - (skip >= hi ? 1 : 0);
  if (m <= 0) return null;
  const nth = (r: number) => {
    if (r < left) return list.sizes[skip >= 0 && skip < lo && r >= skip ? r + 1 : r];
    const i = hi + (r - left);
    return list.sizes[skip >= hi && i >= skip ? i + 1 : i];
  };
  return m % 2 ? nth((m - 1) / 2) : (nth(m / 2 - 1) + nth(m / 2)) / 2;
}
/** the biggest other release */
function largestOther(list: SizeList, key: string): number | null {
  const n = list.sizes.length;
  if (!n) return null;
  return list.keys[n - 1] !== key ? list.sizes[n - 1] : n > 1 ? list.sizes[n - 2] : null;
}
/** far smaller than the other copies of the same search: under a tenth of the median of those the profile could take (RA3's
 *  0.46 GB v1.012 update and its 37 MB fakes beside the 10.7 GB game, 2026-11-09), or under a hundredth of the biggest copy,
 *  seeded or not, so a few small posts with clean names cannot outvote the game's real size (review, 2026-11-09) */
function farSmaller(v: ReleaseView, ctx: AutoContext): string | null {
  if (!(v.size > 0)) return null;
  const key = normTitle(v.title);
  const mid = medianOthers(ctx.sizes.takeable, key, v.size);
  const ref = mid != null && v.size < 0.1 * mid ? mid : (() => { const top = largestOther(ctx.sizes.all, key); return top != null && v.size < 0.01 * top ? top : null; })();
  return ref != null ? `far smaller than the other copies (${sizeText(v.size)} against ${sizeText(ref)}): an update or a fake` : null;
}
/** a post date before 1990 or an age of over 20000 days is an indexer's placeholder (0001-01-01, 1970-01-01), not a date */
const OLDEST_POST = Date.UTC(1990, 0, 1);
/** when a release was posted: its date, else its age; null when it says neither */
function postedAt(v: ReleaseView, now: number): number | null {
  const t = Date.parse(v.publishDate ?? "");
  if (Number.isFinite(t)) return t >= OLDEST_POST ? t : null;
  return v.age > 0 && v.age < 20000 ? now - v.age * DAY : null;
}
/** posted before the game existed — by more than a week for a game out these last two years, by more than two years for an
 *  older one (its store date is often a later release: RA3's launch posts came 70 days before its Steam date) — with no year
 *  of its own that says it is this game's: MW4's "MacOSX" copy was posted in 2018 (2026-11-09); a scene group a few days
 *  early is fine */
function postedBefore(v: ReleaseView, ctx: AutoContext): string | null {
  if (ctx.earliest == null) return null;
  if (v.parsed.year && ctx.year && Math.abs(v.parsed.year - ctx.year) <= 1) return null;
  const at = postedAt(v, ctx.now);
  if (at == null || at >= ctx.earliest - (ctx.recent ? 7 : 730) * DAY) return null;
  return `posted ${Math.round((ctx.earliest - at) / DAY)} days before the game came out`;
}
/* ─────────── the copies that say a game CrackWatch calls uncracked is cracked ─────────── */

/** how long after its store date CrackWatch can be behind on a game with Steam's own DRM (Probably Stolen: still "uncracked"
 *  12 days after TENOKE's release, 2026-11-09): one still "uncracked" long after is one whose protection holds (an online game:
 *  Dead by Daylight is "uncracked" (Steam) since 2016) */
const BEHIND_DAYS = 90;
/** a group posts a release up to a day or two before the store's date (Stupid Never Dies: RUNE's post came 25 h before it) */
const EARLY_DAYS = 2;
/** the tracker whose staff check what goes up (a group's release against the scene's own records, a rip that it runs), by the
 *  indexer's name — the admin's, never an uploader's: GazelleGames. A copy that says a game is cracked is believed from there
 *  only: anyone can post any name to usenet or a public tracker, every fake grabbed so far came from usenet, and a tracker can
 *  date an old release's re-post as new (FileList.io's 2007 "Call.of.Duty.4.Modern.Warfare-Razor1911", dated 2024) */
const CURATED = /gazelle|^ggn$/i;
const onCurated = (v: ReleaseView) => [v.indexer, ...(v.alsoOn ?? [])].some(n => CURATED.test(n ?? ""));
/** an online game, by Steam's genres or IGDB's modes: what holds it is the server, which no copy cracks */
const ONLINE = /massively multiplayer|(?<![a-z])mmo/i;
/**
 * May the copies overrule CrackWatch's verdict (`c`) at all: {out} (the store's date, ms) when they may, else why not (`miss`:
 * null when the verdict simply holds). Only a game whose DRM is Steam's own or none (drmKind), out by its store's date — not by
 * IGDB's first date, which is any platform's (a console launch) — within BEHIND_DAYS of it, and not an online game.
 */
export function crackGate(c: { kind: DrmKind }, game: GameFacts | null | undefined, now: number): { out: number } | { miss: string | null } {
  if (c.kind !== "steam" && c.kind !== "none") return { miss: null };
  const out = Date.parse(game?.release_iso ?? "");
  if (!Number.isFinite(out) || out > now) return { miss: null };
  if (now - out > BEHIND_DAYS * DAY) return { miss: `out ${Math.round((now - out) / DAY)} days ago: CrackWatch is not that far behind` };
  if (ONLINE.test(`${game?.genres_json ?? ""} ${game?.game_modes_json ?? ""}`)) return { miss: "an online game: what holds it is the server" };
  return { out };
}
/** a name as its words: letters and digits, one space around each run */
const plainWords = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
/** who made a copy, as the crack rule reads it (`rank`: a group's release first, then a repacker's, a Home Rip, any copy):
 *  - a cracking group (src/releases.ts isCrackGroup) signing it at its end, "Game-TENOKE (2026) [Windows / …]" — not a word the
 *    game's name ends with ("Anomaly Collapse-ANOMALY" is ANOMALY's, "Rune Factory: Guardians of Azuma-RUNE" RUNE's) — or named
 *    by its title another way ("[TENOKE]", "- TENOKE"; parseTitle), not a word of the game's name;
 *  - a repacker it names (isRepacker), not a word of the game's name ("Vampire: The Masquerade" names no Masquerade repack);
 *  - GazelleGames' Home Rip: a rip of the store's copy that runs, by the tracker's rules;
 *  - for a game with no DRM, any copy: there is nothing to crack.
 *  null: none of them */
function makerOf(v: ReleaseView, kind: DrmKind): { by: string; of: string; rank: number } | null {
  const name = plainWords(v.matchedName ?? "");
  const own = (g: string) => name.includes(plainWords(g));
  const sig = /-([A-Za-z0-9_]{2,14})$/.exec(v.title.replace(/(\s*[\[(][^\])]*[\])])+\s*$/, "").trim())?.[1];
  if (sig && isCrackGroup(sig) && !name.endsWith(plainWords(sig))) return { by: sig, of: `${sig}'s release`, rank: 0 };
  const g = v.parsed.group;
  if (g && v.parsed.scene && isCrackGroup(g) && !own(g)) return { by: g, of: `${g}'s release`, rank: 0 };
  if (g && v.parsed.repack && isRepacker(g) && !own(g)) return { by: g, of: `${g}'s repack`, rank: 1 };
  if (/home rip/i.test(v.parsed.format ?? "")) return { by: "a Home Rip", of: "the Home Rip", rank: 2 };
  return kind === "none" ? { by: "a copy", of: "the copy", rank: 3 } : null;
}
/**
 * Why a game counts as cracked though CrackWatch says it is not (uncracked, or still not out once the store's date has passed),
 * or why the copies found do not say so (`miss`, for the admin). The copies may overrule the verdict at all (crackGate): Steam's
 * own DRM (the Steamworks stub, cracked on release day) or none, out by the store's date within BEHIND_DAYS, not an online game.
 * Then one copy says it: one a cracking group or a repacker made, or a Home Rip (makerOf) — on GazelleGames, whose staff check it
 * (CURATED), with the game's year, posted since the store's date (from EARLY_DAYS before), not far smaller than the other copies,
 * and one the search may believe (`vouch`: not refused as a bad copy, nothing the profile rules out). Probably Stolen,
 * 2026-11-09: CrackWatch said "uncracked" (Steam) while TENOKE's release was on GazelleGames and four other trackers beside
 * FitGirl's repack. A lone post anywhere else (a usenet "-RUNE" for an MMO, a public tracker's repack of an online game), an old
 * namesake's release dated as new, a post from before the game was out: none of them says it. Any other DRM waits for
 * CrackWatch (drmKind): a fake is signed with a group's name too ("Black.Myth.Wukong-RUNE"). The copy named is a group's before a
 * repacker's before a Home Rip, the first posted.
 */
function crackedAnyway(ctx: AutoContext, game: GameFacts | null | undefined, vouch: (v: ReleaseView) => boolean): { cracked: AutoContext["cracked"]; miss: string | null } {
  const c = ctx.crack;
  if (!c) return { cracked: null, miss: null };
  const gate = crackGate(c, game, ctx.now);
  if (!("out" in gate)) return { cracked: null, miss: gate.miss };
  const out = gate.out;
  const sized = { ...ctx, sizes: { takeable: ctx.sizes.all, all: ctx.sizes.all } };        // what the profile could take says nothing here
  let best: { v: ReleaseView; by: string; rank: number; at: number } | null = null;
  let miss: string | null = null;
  for (const v of ctx.copies) {
    const who = makerOf(v, c.kind);
    if (!who) continue;
    const at = postedAt(v, ctx.now);
    const no = !onCurated(v) ? `${who.of} is not on GazelleGames, whose staff check it`
      : !(v.parsed.year && ctx.year && Math.abs(v.parsed.year - ctx.year) <= 1) ? `GazelleGames gives ${who.of} ${v.parsed.year ? `the year ${v.parsed.year}` : "no year"}: another game?`
      : at == null ? `${who.of} has no post date`
      : at < out - EARLY_DAYS * DAY ? `${who.of} was posted before the game came out`
      : at > ctx.now + DAY ? `${who.of} is dated days ahead`
      : farSmaller(v, sized) ? `${who.of} is far smaller than the other copies`
      : !vouch(v) ? `${who.of} is one this search refuses (blocklisted, or the profile rules it out)`
      : null;
    if (no || at == null) { miss ??= no; continue; }
    if (!best || who.rank < best.rank || (who.rank === best.rank && at < best.at)) best = { v, by: who.by, rank: who.rank, at };
  }
  if (!best) return { cracked: null, miss };
  const says = c.status === "unreleased" ? "CrackWatch still lists the game as not out" : "CrackWatch says not cracked";
  const did = best.rank <= 1 ? `${best.by} released it` : best.rank === 2 ? "GazelleGames has a Home Rip of it" : "GazelleGames has it";
  return { cracked: { by: best.by, title: best.v.title, out, says, why: `${says}, but ${did}: ${c.kind === "none" ? "the game has no DRM" : "Steam's own DRM only"}` }, miss: null };
}
/** a copy CrackWatch's verdict does not hold back: one a curated tracker marks DRM-free — and beside one, the game has a DRM-free
 *  build, so the trusted repackers' builds and the posts named for that store too */
const crackFree = (v: ReleaseView, ctx: AutoContext) => curatedDrmFree(v) || (ctx.drmFree && (isRepacker(v.parsed.group) || DRM_FREE.test(v.title)));
/** CrackWatch says no copy can be real yet and the copies do not say otherwise (autoContext's `cracked`): only a copy crackFree
 *  lets by can be. A game with Steam's own DRM or none waits for a copy that says it is cracked (and says why the copies found
 *  do not), any other for CrackWatch */
function waitsForCrack(v: ReleaseView, ctx: AutoContext): string | null {
  if (!ctx.crack || crackFree(v, ctx)) return null;
  const { status, drm, storeOut, kind, miss } = ctx.crack;
  const yet = miss ? `: ${miss}` : kind === "steam" || kind === "none" ? ", and no cracking group or repacker has released it since it came out" : null;
  if (status === "unreleased") return storeOut ? `CrackWatch has no verdict on the release yet (it still lists the game as not out)${yet ?? ""}` : "CrackWatch says the game is not out yet: a copy now would be a fake";
  return yet ? `CrackWatch says the game is not cracked yet${drm ? ` (${drm})` : ""}${yet}` : `CrackWatch says the game is not cracked yet${drm ? ` (${drm})` : ""}: a copy now would be a fake`;
}
/** the game counts as cracked only because of its copies (autoContext's `cracked`): a copy posted before the store's date, or
 *  with no post date, is no part of that and waits as every copy did — a group's early post on GazelleGames excepted, from
 *  EARLY_DAYS before (a pre-release fake: "DreamWorks.Shrek.2.Remastered-RUNE", posted 5 days before the store date) */
function beforeCracked(v: ReleaseView, ctx: AutoContext): string | null {
  const k = ctx.cracked;
  if (!k || crackFree(v, ctx)) return null;
  const at = postedAt(v, ctx.now);
  if (at != null && (at >= k.out || (at >= k.out - EARLY_DAYS * DAY && onCurated(v)))) return null;
  return `${at == null ? "no post date" : "posted before the game came out"}: only copies posted since say it is cracked (${k.says})`;
}
/** a console dump far too small for its console: under a tenth of the smallest size the console's games come in (src/ways/find.ts
 *  SIZE_RANGE) — "Call.of.Duty.Modern.Warfare.4.PS5-DUPLEX", 40 MB; a store's re-release of an older game is small, and kept
 *  ("Majoras.Mask.WiiU-PACT", the Virtual Console's 45 MB) */
function dumpSize(v: ReleaseView, _ctx?: AutoContext): string | null {
  const p = v.flags?.platform as PlatformId | null | undefined;
  const range = p ? SIZE_RANGE[p] : undefined;
  return range && v.size > 0 && v.size < range[0] / 10 ? `${sizeText(v.size)} is far too small for a ${PLATFORM_LABEL[p!]} game` : null;
}

/**
 * Every reason the automatic searcher would not take this release, in plain words; empty: it may (the profile has its own
 * say, profileRefusals). Its name and kind (src/releases.ts nameRefusals), then what the rest of the search says: for a PC
 * release, far smaller than the other copies, posted before the game existed, a game CrackWatch says is not cracked; for a
 * console dump of the game's own search, a size the console's games never come in, posted before the game existed.
 * `ctx` is autoContext of the search the release came from.
 */
export function automaticRefusals(v: ReleaseView, ctx: AutoContext): string[] {
  const out = nameRefusals(v);
  for (const rule of dumpView(v) ? [dumpSize, postedBefore] : [farSmaller, postedBefore, waitsForCrack, beforeCracked]) { const why = rule(v, ctx); if (why) out.push(why); }
  return out;
}

/** why the profile leaves a release out, in plain words; empty: the profile takes it */
export function profileRefusals(r: ReleaseView, profile: Profile, opt: { blocked?: Set<string> } = {}): string[] {
  const out: string[] = [];
  if (r.score < profile.minScore) out.push(`scores ${r.score}, under the profile's ${profile.minScore}`);
  if (!(r.downloadUrl || r.magnetUrl)) out.push("no download link");
  const cls = installClass(r);
  if (!profile.formats.includes(cls)) out.push(`a format the profile does not take (${cls})`);
  if (isBlocked(opt.blocked, r)) out.push("blocklisted");
  if (profile.protocol === "usenet" && r.protocol !== "usenet") out.push("the profile takes usenet only");
  if (profile.protocol === "torrent" && r.protocol !== "torrent") out.push("the profile takes torrents only");
  if (profile.maxSizeGb != null && r.size && r.size > profile.maxSizeGb * 1024 ** 3) out.push(`over the profile's ${profile.maxSizeGb} GB`);
  if (r.protocol === "torrent" && r.seeders != null && !(r.seeders >= Math.max(1, profile.minSeeders) || (profile.minSeeders === 0 && justPosted(r))))
    out.push(r.seeders === 0 ? "no seeders" : `${r.seeders} seeders, under the profile's ${profile.minSeeders}`);
  if (profile.mustContain.length && !has(r.title, profile.mustContain)) out.push("none of the words the profile requires");
  if (has(r.title, profile.mustNotContain)) out.push("a word the profile rules out");
  if (r.parsed.group && profile.blockedGroups.some(g => g.toLowerCase() === r.parsed.group!.toLowerCase())) out.push(`${r.parsed.group} is a blocked group`);
  return out;
}

/** the copies that may say a game is cracked though CrackWatch says not (autoContext's `vouch`): not one refused as a bad copy
 *  (its title on the game's blocklist: an import that failed on it, the admin's removal — a fake caught once stays caught; a post
 *  blocked for its source only, a dead post, still says the release exists), not one of a group the profile blocks, and none
 *  with a word the profile rules out. A dead torrent or a post tried already may still say it. */
export function mayVouch(profile: Profile | null | undefined, blocked?: Set<string>): (v: ReleaseView) => boolean {
  return v => !isBlocked(blocked, { guid: "\u0000", title: v.title })
    && !(profile && (has(v.title, profile.mustNotContain) || (!!v.parsed.group && profile.blockedGroups.some(g => g.toLowerCase() === v.parsed.group!.toLowerCase()))));
}

/** what the profile allows of what the automatic searcher may take (automaticRefusals), best first; `blocked` = guids/titles
 *  that must not be tried again, `tried` = guids this search tried already; `game` and `now` are what the date and CrackWatch
 *  rules read (absent: they say nothing) */
export function orderCandidates(ranked: ReleaseView[], profile: Profile, opt: { preferUsenet: boolean; blocked?: Set<string>; tried?: Set<string>; game?: GameFacts | null; now?: number }): ReleaseView[] {
  const rank = new Map(profile.formats.map((f, i) => [f, i]));
  const takeable = (r: ReleaseView) => profileRefusals(r, profile, opt).length === 0 && !opt.tried?.has(r.guid);
  const ctx = autoContext(ranked, opt.game, opt.now, takeable, mayVouch(profile, opt.blocked));
  const ok = ranked.filter(r => takeable(r) && automaticRefusals(r, ctx).length === 0);
  const usenetFirst = profile.protocol === "prefer-usenet" && opt.preferUsenet;
  const torrentFirst = profile.protocol === "prefer-torrent";
  const preferred = (r: ReleaseView) => (r.parsed.group && profile.preferredGroups.some(g => g.toLowerCase() === r.parsed.group!.toLowerCase()) ? 0 : 1);
  return ok.sort((a, b) => {
    const ca = rank.get(installClass(a))!, cb = rank.get(installClass(b))!;
    if (ca !== cb) return ca - cb;
    if (preferred(a) !== preferred(b)) return preferred(a) - preferred(b);
    if ((usenetFirst || torrentFirst) && a.protocol !== b.protocol) return (a.protocol === (usenetFirst ? "usenet" : "torrent")) ? -1 : 1;
    return b.score - a.score;
  });
}

/**
 * The same release posted again (another post of one usenet release, the same name on another tracker) counts once: its first
 * post in the order given (the profile's — format, preferred group, protocol, then score) holds its place, so a repost never
 * takes one of a round's `max` tries (MW4's fake was posted twice and took two of four, 2026-11-09). The other posts follow the
 * releases kept (at most `max` of them): a post that failed on its source (a dead post, a stall) blocks that post only, and
 * the next post of it is tried after the other releases; a copy that was refused blocks its title, and they are passed by.
 */
export function onePerRelease(cands: ReleaseView[], max = Infinity): ReleaseView[] {
  const key = (c: ReleaseView) => normTitle(c.title) || `${c.instanceId}:${c.guid}`;
  const kept = new Map<string, ReleaseView>();
  const later: ReleaseView[] = [];
  for (const c of cands) {
    const k = key(c);
    if (!kept.has(k)) { if (kept.size < max) kept.set(k, c); }
    else if (later.length < max) later.push(c);
  }
  return [...kept.values(), ...later];
}

/** the consoles the game's own search falls back to when its PC pass takes nothing, or null when it does not. A game that is
 *  on PC (a Steam game, or one whose platforms name the PC) has its PC copy to wait for: a dump only for a console it is known
 *  to be on, never while CrackWatch says the PC game is not cracked, and never when the PC pass found copies of it that were
 *  refused for now (MW4 would take a 40 MB "PS5" post, 2026-11-09); a game not on PC: the consoles it is on, or any */
export function consoleFallback(plats: string[], pc: AutoContext): PlatformId[] | null {
  const want = consolePlatforms(plats);
  if (!hasPc(plats)) return want.length ? want : CONSOLE_PLATFORMS;
  return want.length && !pc.crack && !pc.copies.length ? want : null;
}

/** why a candidate of a list made under older rules (RULES) would not be taken now, by its title, or null: judged again under
 *  the game's names in the pass it came from */
function rejudged(rel: ReleaseView, game: GameRow): string | null {
  const year = game.release_year ?? (game.release_iso ? Number(game.release_iso.slice(0, 4)) || null : null);
  let plats: string[] = []; try { plats = JSON.parse(game.platforms_json ?? "[]"); } catch { /* none */ }
  const dump = isConsole(rel.flags?.platform);
  const want = consolePlatforms(plats);
  if (dump && hasPc(plats) && !want.length) return "a console dump of a game that is on PC";
  const v = rankForNames(nameQueries(game.name, year, listOf(game.aliases_json)), [rel], dump ? { platforms: want.length ? want : CONSOLE_PLATFORMS, known: want } : {})[0];
  return v ? nameRefusals(v)[0] ?? null : "no name the game goes by matches it";
}

/* ─────────────────────── lifecycle ─────────────────────── */

const row = (id: number) => stmts.requestById.get(id) as RequestRow | undefined;

function update(id: number, patch: Partial<Record<keyof RequestRow, unknown>> & { done?: boolean }): RequestRow | undefined {
  const cur = row(id);
  if (!cur) return undefined;
  const { done, ...cols } = patch;
  const changed = Object.entries(cols).filter(([k, v]) => (cur as any)[k] !== v);
  if (!changed.length && !done) return cur;
  const sets = changed.map(([k]) => `${k}=?`);
  const vals = changed.map(([, v]) => v as string | number | null);
  if (done) sets.push("done_at=unixepoch()");
  stmts.updateRequest(sets, vals, id);
  const next = row(id)!;
  events.emit("request", serializeRequest(next));
  return next;
}

/** a request that ends without a copy, saying why in a plain sentence */
function failed(r: RequestRow, stage: string, message: string) {
  const out = update(r.id, { state: "failed", stage, message, done: true });
  record(r.game_id, "failed", { gameName: r.game_name, message });
  return out;
}

/** start a search for a game (the Search button, the automatic searcher, a tracked release day); `wayId`: for that way's
 *  game file (the admin's "Find it on my indexers") */
export function createRequest(opt: { gameId: number; by?: string; wayId?: number | null }): { request: ReturnType<typeof serializeRequest>; duplicate: boolean } {
  const game = stmts.gameById.get(opt.gameId) as GameRow | undefined;
  if (!game) throw new RequestError("no such game", 404);
  if (opt.wayId != null) return requestForWay(game, opt.wayId);
  const dup = stmts.requestActiveForGame.get(game.id) as RequestRow | undefined;
  if (dup && dup.state !== "ready") return { request: serializeRequest(dup), duplicate: true };
  const held = stoppedWait(stmts.lastRequestForGame.get(game.id) as RequestRow | undefined, opt.by);
  if (held) return held;
  // a game players cannot start yet that has a way to play: the search is for that way's game file
  const way = requestWay(game);
  const r = (way ? stmts.insertWayRequest.get(game.id, opt.by ?? null, way.id) : stmts.insertRequest.get(game.id, opt.by ?? null)) as RequestRow;
  const out = update(r.id, { stage: "queued", progress: 0.01 })!;
  rdeps.log(`#${r.id} ${game.name}: ${out.state}${way ? ` (the game file of way ${way.id})` : ""}`);
  return { request: serializeRequest(out), duplicate: false };
}

/** the searches nobody asked for just now: a stopped wait is left to the admin (a fresh one would fetch another copy) */
const AUTOMATIC = new Set(["auto", "rss", "tracker", "upgrade"]);
/**
 * The game's (or the way's) newest search stopped waiting for the seedbox (72 h of it, the download kept): a new search
 * would fetch another copy of what is on the seedbox already. A search someone asked for (the Search button, a player's Try
 * again, the admin's "Find it on my indexers") picks that wait up again instead; one nobody asked for (the automatic
 * searcher, RSS, a release day) leaves it for the admin. Null: no such wait, search as usual.
 */
function stoppedWait(last: RequestRow | undefined, by: string | null | undefined): { request: ReturnType<typeof serializeRequest>; duplicate: boolean } | null {
  if (!last || last.state !== "failed" || !waitOf(last)?.stopped) return null;
  if (AUTOMATIC.has(by ?? "")) return { request: serializeRequest(last), duplicate: true };
  rdeps.log(`#${last.id} a new search of ${last.game_name ?? "the game"} picks up its stopped wait on the seedbox`);
  return { request: retryRequest(last.id), duplicate: true };
}

/** the admin's search for one way's game file: one per way; a search of the game's own that is only waiting becomes it */
function requestForWay(game: GameRow, wayId: number) {
  const way = getWay(wayId);
  if (!way || way.game_id !== game.id) throw new RequestError("no such way", 404);
  const dup = stmts.requestActiveForWay.get(way.id, 0) as RequestRow | undefined;
  if (dup) return { request: serializeRequest(dup), duplicate: true };
  const held = stoppedWait(stmts.lastRequestForWay.get(way.id) as RequestRow | undefined, FOR_WAY);
  if (held) return held;
  const waiting = stmts.requestActiveForGame.get(game.id) as RequestRow | undefined;
  const out = waiting?.state === "requested" && waiting.requested_by !== FOR_WAY
    ? update(waiting.id, { way_id: way.id, requested_by: FOR_WAY, stage: "queued", progress: 0.01, message: null, next_try_at: null, candidates_json: null, attempt: 0 })!
    : update((stmts.insertWayRequest.get(game.id, FOR_WAY, way.id) as RequestRow).id, { stage: "queued", progress: 0.01 })!;
  rdeps.log(`#${out.id} ${game.name}: looking for the game file of way ${way.id}`);
  return { request: serializeRequest(out), duplicate: false };
}

/** a release picked by hand in the interactive search: grab it and let the normal flow carry it to an import */
export async function grabManually(rel: ReleaseView, gameId: number) {
  const game = stmts.gameById.get(gameId) as GameRow | undefined;
  if (!game) throw new RequestError("no such game", 404);
  const active = stmts.requestActiveForGame.get(gameId) as RequestRow | undefined;
  const own = active && active.state !== "ready" ? active : null;
  // one download has one search: a copy another search is downloading is refused — before anything of this game's own search
  // is touched (a refused pick once left the game with its search cancelled and its download forgotten)
  const refuseShared = (fetchId: number) => {
    const other = otherSearchOn(fetchId, own?.id ?? 0);
    if (other) throw new RequestError(`this very copy is already being downloaded for another search${other.game_name ? ` (${other.game_name})` : ""}: wait for it, or cancel that search first`, 409);
  };
  const had = rel.guid ? (stmts.fetchByGuid.get(rel.guid) as FetchRow | undefined) : undefined;
  if (had) refuseShared(had.id);
  const { fetch: f, duplicate } = await rdeps.grab(rel, gameId);
  if (duplicate) refuseShared(f.id);                                        // the same torrent under another post: known once its payload is read
  const r = stmts.insertRequest.get(gameId, "manual") as RequestRow;
  const out = update(r.id, { state: "fetching", attempt: 0, candidates_json: JSON.stringify([rel]), release_json: JSON.stringify(rel), fetch_id: f.id, stage: "sent to the download client", progress: 0.05 })!;
  // the pick is taken: only now the game's own search goes (as it is by now: the grab took a moment), and its download with
  // it — unless that is the very one picked, which the new search is on by now (cancelRequest leaves a download another
  // search holds)
  const prev = own ? row(own.id) : undefined;
  if (prev && prev.state !== "ready") await cancelRequest(prev.id, true);
  record(gameId, "grabbed", { gameName: game.name, release: rel.title, source: rel.indexer, message: `${rel.protocol} · ${installClass(rel)} · picked by hand`, data: { guid: rel.guid, size: rel.size, protocol: rel.protocol } });
  return { request: serializeRequest(out), download: f, duplicate };
}

const fmtRate = (bps: number | null | undefined) => (bps && bps > 200_000 ? ` · ${(bps / 1e6).toFixed(bps > 10e6 ? 0 : 1)} MB/s` : "");

const clock = (unixSec: number) => { const d = new Date(unixSec * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** what a search may not take again: the game's blocklist, and for one way's search the way's own too (src/ways/find.ts
 *  wayBlocked: a release refused only for its form under another version of the way's plan is looked at again) */
function blockedFor(gameId: number, way?: { id: number; content: ContentPlanOf } | null): Set<string> {
  return way ? wayBlocked(gameId, way.id, way.content) : gameBlocklist(gameId);
}
/** the game's own blocklist as a search reads it (guids and titles): a post that failed on its source (class 'source': a dead
 *  post, a stall) by its guid only — the same release's other posts may be fine — anything else by its guid and its title */
export function gameBlocklist(gameId: number): Set<string> {
  const out = new Set<string>();
  for (const b of stmts.blocklistForGame.all(gameId) as { guid: string | null; title: string; class: string | null }[]) {
    if (b.guid) out.add(b.guid);
    if (b.class !== "source") out.add(b.title);
  }
  return out;
}
type ContentPlanOf = ReturnType<typeof wayContent>;

/** the way a request searches for, with its game file plan as it is now */
function wayOf(r: Pick<RequestRow, "way_id">): { way: WayRow; content: ContentPlanOf } | null {
  const way = r.way_id != null ? getWay(r.way_id) : null;
  const plan = way ? getPlan(way.plan_id) : null;
  return way && plan ? { way, content: wayContent(way, plan) } : null;
}

/**
 * A release refused for one way: blocklisted for that way only, with the version of its game file plan it was refused
 * under and why ('identity': another title, version, a patch or a sealed file; 'form': nothing in a form the way took).
 * The carry run blocks the game's own copy's release this way too (src/ways/carry.ts), so no search fetches those bytes
 * again.
 */
export function blockReleaseForWay(o: { gameId: number; wayId: number; guid?: string | null; title: string; indexer?: string | null; reason: string; cls: "identity" | "form" }): void {
  const w = wayOf({ way_id: o.wayId });
  stmts.insertWayBlock.run(o.gameId, o.guid ?? null, o.title, o.indexer ?? null, o.reason, o.wayId, contentDigest(w?.content ?? null), o.cls);
  const g = stmts.gameById.get(o.gameId) as GameRow | undefined;
  record(o.gameId, "blocklisted", { gameName: g?.name ?? null, release: o.title, source: o.indexer ?? null, message: o.reason });
}

/** how a content job's refusal of a download is blocklisted: its fail says when only the form was refused (old jobs: as
 *  another game) */
function refusalClass(j: JobRow): "identity" | "form" {
  try { const f = j.fail_json ? (JSON.parse(j.fail_json) as FailInfo) : null; return f?.class === "file" && f.kind === "form" ? "form" : "identity"; } catch { return "identity"; }
}
/** a content job that failed on the recipe the way makes its file by (a make, an unpack, a convert): the download is fine */
function recipeFault(j: JobRow): boolean {
  try { const f = j.fail_json ? (JSON.parse(j.fail_json) as FailInfo) : null; return f?.class === "plan"; } catch { return false; }
}

/** the way a request searches for: the admin's pick, else the game's best (src/ways/find.ts requestWay); "gone" when the
 *  admin's way is, "busy" when another search already holds that way's file: the admin's, one that got further, or an
 *  older one (of two that only wait, the older goes first, so neither waits on the other for good) */
function wayFor(r: RequestRow, game: GameRow): WayRow | "gone" | "busy" | null {
  if (r.requested_by === FOR_WAY) { const w = r.way_id != null ? getWay(r.way_id) : null; return w && w.game_id === game.id ? w : "gone"; }
  const w = requestWay(game);
  if (!w) return null;
  const others = stmts.requestsActiveForWay.all(w.id, r.id) as RequestRow[];
  if (others.some(o => o.requested_by === FOR_WAY || o.state !== "requested" || o.id < r.id)) return "busy";
  if (r.way_id !== w.id) update(r.id, { way_id: w.id });
  return w;
}
/** is the way a request searches for still there (deleted mid-search: its branch ends) */
const wayStillThere = (r: RequestRow) => { const w = r.way_id != null ? getWay(r.way_id) : null; return !!w && w.game_id === r.game_id; };

async function matchRequest(r: RequestRow) {
  let game = stmts.gameById.get(r.game_id) as GameRow | undefined;
  if (!game) return update(r.id, { state: "failed", stage: "the game is gone from the library", done: true });
  const way = wayFor(r, game);
  if (way === "gone") return failed(r, "the way to play is gone", "the way to play this search was for is gone");
  if (way === "busy") {
    const hours = recheckHours(r);
    return update(r.id, { state: "requested", stage: `another search looks for this game's file — searching again in ${hours}h`, progress: 0.02, message: null, next_try_at: Math.floor(rdeps.now() / 1000) + hours * 3600 });
  }
  if (way) return matchWay(r, game, way);
  if (r.way_id != null) update(r.id, { way_id: null });                     // its way is gone or can no longer be used: the game's own search
  // a copy arrived another way (a hand import, another search) while this one was waiting: nothing left to do
  const have = stmts.packageForGame.get(game.id) as PackageRow | undefined;
  const profile = profileFor(game);
  const upgrade = r.requested_by === "upgrade";
  if (have && !upgrade) return update(r.id, { state: "ready", stage: "imported", progress: 1, package_id: have.id, message: null, done: true });
  if (upgrade && !have) return update(r.id, { state: "failed", stage: "nothing to upgrade: the game has no copy", done: true });
  if (upgrade && !wantsUpgrade(profile, classOfPackage(have!))) return update(r.id, { state: "ready", stage: "the copy already meets the profile's cutoff", progress: 1, package_id: have!.id, done: true });
  // a console's version (or the arcade's) was asked for: that console's emulator gets the game a way first, by itself
  // (src/ways/recipes.ts), and the search is then that way's — its file judged as a file of that console. While the
  // emulator is being set up the search waits a minute at a time; with no recipe it goes on as the game's own
  const asked = upgrade ? null : wantedPlatform(game.want_platform);
  if (asked && asked !== "pc") {
    const made = await rdeps.ensureWay(game, asked).catch((e: any) => { rdeps.log(`#${r.id} ${game!.name}: no way was made by itself: ${e?.message ?? e}`); return null; });
    if (made?.state === "there" && made.made) {
      const mine = wayFor(r, game);
      if (mine && mine !== "gone" && mine !== "busy") return matchWay(r, game, mine);
    } else if (made?.state === "waiting") {
      return update(r.id, { state: "requested", stage: `setting up ${made.emulator} for the ${PLATFORM_LABEL[asked]} version`, progress: 0.02, message: null, next_try_at: Math.floor(rdeps.now() / 1000) + 60 });
    }
  }
  game = await crackwatchFirst(r, game);
  update(r.id, { state: "matching", stage: upgrade ? "searching for a better copy" : "searching the indexers", progress: 0.02, message: null });
  let ranked: ReleaseView[];
  const year = game.release_year ?? (game.release_iso ? Number(game.release_iso.slice(0, 4)) : null);   // unreleased games still have a year
  // every name the game goes by is asked and judged on its own; the admin's search terms only add queries
  const names = { aliases: listOf(game.aliases_json), terms: listOf(game.search_terms_json) };
  // the version that was asked for, when one was (games.want_platform): a console's (or the arcade's) is looked for by
  // itself, with no PC pass before it; the PC's never falls back to a dump
  const only = upgrade ? null : wantedPlatform(game.want_platform);
  const dumpOnly = only != null && only !== "pc";
  try { ranked = dumpOnly ? [] : (await rdeps.search(game.name, year, { thorough: true, ...names })).ranked; }
  catch (e: any) {
    rdeps.log(`#${r.id} search failed: ${e?.message ?? e}`);
    return update(r.id, { state: "requested", stage: "the indexer search failed — trying again soon", message: String(e?.message ?? e), next_try_at: Math.floor(rdeps.now() / 1000) + 600 });
  }
  const tried = new Set<string>(triedOf(r));
  const blocked = blockedFor(game.id);
  // the game itself is what the date and CrackWatch rules read
  const judged = { blocked, game, now: rdeps.now() };
  let cands = orderCandidates(ranked, profile, { ...judged, tried, preferUsenet: await rdeps.usenetAvailable() });
  // CrackWatch says the game is not cracked and its copies say it is (autoContext's `cracked`): each copy that verdict would
  // have held back carries why, for the admin (the log, the grab's history line)
  const pcCtx = cands.length && autoContext([], game, judged.now).crack ? autoContext(ranked, game, judged.now, undefined, mayVouch(profile, blocked)) : null;
  const crackedWhy = (c: ReleaseView) => (pcCtx?.cracked && !dumpView(c) && !crackFree(c, pcCtx) ? pcCtx.cracked.why : undefined);
  // an upgrade only takes a strictly better format than the copy on disk
  const curRank = upgrade ? profile.formats.indexOf(classOfPackage(have!)) : -1;
  if (upgrade) cands = cands.filter(c => profile.formats.indexOf(installClass(c)) < curRank);
  // no PC copy to be had: the best dump for a console the game is on (consoleFallback says which, if any), unpacked as it is
  let consoleRanked: ReleaseView[] = [];
  let plats: string[] = []; try { plats = JSON.parse(game.platforms_json ?? "[]"); } catch { /* none */ }
  const consoles = dumpOnly ? [only!] : !cands.length && !upgrade && !only && profile.consoleFallback ? consoleFallback(plats, autoContext(ranked, game, judged.now)) : null;
  if (consoles) {
    const want = dumpOnly ? [only!] : consolePlatforms(plats);
    update(r.id, { stage: dumpOnly ? `looking for the ${PLATFORM_LABEL[only!]} version` : "no PC version found — looking for a console dump", progress: 0.03 });
    try {
      consoleRanked = (await rdeps.search(game.name, year, { thorough: true, ...names, categories: CONSOLE_CATEGORIES, platforms: consoles, known: want })).ranked;
      cands = orderCandidates(consoleRanked, profile, { ...judged, tried, preferUsenet: await rdeps.usenetAvailable() });
      if (cands.length) rdeps.log(`#${r.id} ${game.name}: no PC version — ${cands.length} console dump(s) (${[...new Set(cands.map(c => c.flags.platform))].join(", ")})`);
    } catch (e: any) { rdeps.log(`#${r.id} console search failed: ${e?.message ?? e}`); }
  }
  cands = onePerRelease(cands, cfgNum("SEARCH_MAX_CANDIDATES", 4));
  if (!cands.length) return nothingTaken(r, [ranked, consoleRanked], { ...judged, profile, tried, notBetter: upgrade ? c => profile.formats.indexOf(installClass(c)) >= curRank : null });
  const why = crackedWhy(cands[0]);
  rdeps.log(`#${r.id} ${game.name}: ${cands.length} candidate(s), first: ${cands[0].title}${why ? ` — ${why} (${pcCtx!.cracked!.title})` : ""}`);
  update(r.id, { candidates_json: JSON.stringify(cands.map(c => ({ ...c, judged: RULES, cracked: crackedWhy(c) }))), attempt: 0, next_try_at: null, refused_json: null });
  await tryCandidate(r.id);
}

/** one release a search found and did not take, and why (requests.refused_json; the admin's, never the players') */
export interface Refused { title: string; indexer: string; size: number; protocol: string; why: string[] }

/**
 * A search that takes nothing says why: every release it found, with every reason it was not taken (the first ten are kept
 * in requests.refused_json until the next grab), and a stage that sums it up — waiting for a crack (CrackWatch), copies
 * found that are none of them certainly this game, or no usable copy yet — with the first reason as the message. Refusing
 * blocklists nothing: the rules are applied again at every search. The next search is the usual one.
 */
function nothingTaken(r: RequestRow, passes: ReleaseView[][], x: { blocked: Set<string>; game: GameRow; now: number; profile: Profile; tried: Set<string>; notBetter: ((c: ReleaseView) => boolean) | null }) {
  const hours = recheckHours(r);
  const refused: Refused[] = [];
  const seen = new Set<string>();
  let byRules = 0;
  // the copies the profile could take, as orderCandidates read them (the size rule's median)
  const takeable = (v: ReleaseView) => profileRefusals(v, x.profile, { blocked: x.blocked }).length === 0 && !x.tried.has(v.guid);
  // CrackWatch's verdict as the PC pass read it: its copies may say the game is cracked anyway (autoContext's `cracked`)
  let crack: AutoContext["crack"] | undefined;
  const vouch = mayVouch(x.profile, x.blocked);
  for (const list of passes) {
    const ctx = autoContext(list, x.game, x.now, takeable, vouch);
    if (crack === undefined) crack = ctx.crack;
    for (const v of list) {
      const key = `${v.instanceId}:${v.guid}`;
      if (seen.has(key)) continue;                                           // the console pass finds the PC releases again
      seen.add(key);
      const auto = automaticRefusals(v, ctx);
      if (auto.length) byRules++;
      const why = [...auto, ...profileRefusals(v, x.profile, { blocked: x.blocked }), ...(x.tried.has(v.guid) ? ["tried already"] : [])];
      if (!why.length && x.notBetter?.(v)) why.push("no better than the copy there");
      refused.push({ title: v.title, indexer: v.indexer, size: v.size, protocol: v.protocol, why });
    }
  }
  const n = refused.length;
  if (crack === undefined) crack = autoContext([], x.game, x.now).crack;
  const upgrade = r.requested_by === "upgrade";
  const plain = !upgrade && (crack || (n > 0 && byRules === n));           // the rules, not the profile, stood in the way
  // every copy found tried or blocklisted already: the copies this search could use are used up
  const usedUp = n > 0 && refused.every(f => f.why.length > 0 && f.why.every(w => w === "blocklisted" || w === "tried already"));
  const copies = `${n} ${n === 1 ? "copy" : "copies"} found`;
  const stage = upgrade ? "no better copy yet" : crack ? "waiting for a crack"
    : plain ? `${copies}, none certainly this game`
    : usedUp || (!n && (x.tried.size || x.blocked.size)) ? "no usable copy yet"
    : n ? `${copies}, none taken` : "nothing suitable yet";
  // the message gives the first reason, whichever rule gave it, before the release's name (the queue shows the start of it);
  // waiting for a crack, CrackWatch's — with a copy that only the crack stands in the way of, or by itself
  const isCw = (w: string) => w.startsWith("CrackWatch");
  const onlyCw = crack ? refused.find(f => f.why.length > 0 && f.why.every(isCw)) : undefined;
  const cwWhy = crack ? refused.flatMap(f => f.why).find(isCw) : undefined;
  const first = onlyCw ?? (cwWhy ? undefined : refused.find(f => f.why.length));
  const message = first ? `${first.why[0]} — ${first.title}` : cwWhy ?? null;
  const top = refused.find(f => f.why.length);
  if (n) rdeps.log(`#${r.id} ${r.game_name ?? x.game.name}: ${stage}${top ? ` — ${top.title}: ${top.why.join("; ")}` : ""}`);
  return update(r.id, {
    state: "requested", stage: `${stage} — searching again in ${hours}h`, message,
    refused_json: n ? JSON.stringify(refused.slice(0, 10)) : null, progress: 0.02, next_try_at: Math.floor(rdeps.now() / 1000) + hours * 3600,
  });
}

/**
 * A Steam game out for less than a year (or not out yet) that CrackWatch has never been asked about is looked up once, for a
 * few seconds, before it is searched: a new game with no crack has no real copy to find (MW4 was searched 15 s after it was
 * added, with no verdict, 2026-11-09). A lookup that fails or does not answer in time changes nothing: the search goes on.
 * CrackWatch turned off (CRACKWATCH_SYNC_HOURS 0) is never asked. A "not out yet" given before the store's date that has passed
 * since is asked again too, at most hourly: release day's search would otherwise wait for the sync's next look (review,
 * 2026-11-09). Returns the game as it is now.
 */
async function crackwatchFirst(r: RequestRow, game: GameRow): Promise<GameRow> {
  if (cfgNum("CRACKWATCH_SYNC_HOURS", 6) <= 0) return game;
  const now = rdeps.now(), out = Date.parse(game.release_iso ?? "");
  const stale = game.crack_status === "unreleased" && Number.isFinite(out) && out <= now && (game.crackwatch_at ?? 0) * 1000 < now - 3600_000;
  if (!stale && (game.crack_status != null || game.steam_appid == null)) return game;
  if (!stale && !((game.coming_soon ?? 0) === 1 || (Number.isFinite(out) && out > now - 365 * DAY))) return game;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">(res => { timer = setTimeout(() => res("late"), rdeps.crackWaitMs); });
  try {
    const v = await Promise.race([rdeps.crackCheck(game), late]);
    if (v === "late") rdeps.log(`#${r.id} ${game.name}: CrackWatch did not answer within ${rdeps.crackWaitMs / 1000} s — searching anyway`);
    else if (v == null) rdeps.log(`#${r.id} ${game.name}: CrackWatch could not be asked — searching anyway`);
  } catch (e: any) {
    rdeps.log(`#${r.id} ${game.name}: CrackWatch could not be asked (${e?.message ?? e}) — searching anyway`);
  } finally { clearTimeout(timer); }
  return (stmts.gameById.get(game.id) as GameRow | undefined) ?? game;
}

/**
 * A search for one way's game file (src/ways/find.ts). Its build there: ready at once. A way that needs no file, or has
 * a file that fits: built (or its running build followed). A file from the indexers waiting for the admin that this way
 * proves: its file now, built; one it cannot tell apart either: nothing more is fetched. Otherwise the way's content
 * pass: its console, its names, its blocklist, its regions first (the dump list as the server keeps it: a search never
 * waits for one to download).
 */
async function matchWay(r: RequestRow, game: GameRow, way: WayRow) {
  const plan = getPlan(way.plan_id);
  if (!plan) return failed(r, "the way to play is gone", "the way's plan is gone");
  const wrong = automaticProblem(plan, way);
  if (wrong) return failed(r, "incompatible emulator plan", wrong);
  const cur = currentPackage(game.id);
  if (way.package_id != null && cur?.pkg.id === way.package_id) return update(r.id, { state: "ready", stage: "imported", progress: 1, package_id: cur.pkg.id, message: null, done: true });
  if (plan.status !== "ready") return failed(r, "the way's plan is not ready", `the plan ${plan.name} is ${plan.status}: check it before its game file is looked for`);
  const running = assembling(way.id);
  if (running) return update(r.id, { state: "processing", job_id: running.id, stage: "building", progress: 0.9, message: null });
  const content = wayContent(way, plan);
  const file = way.content_id != null ? getContent(way.content_id) : null;
  if (!content || (file && existsSync(file.path) && contentMatches(content, contentFacts(file)).ok)) return buildWay(r, game, way, plan);
  if (r.requested_by !== FOR_WAY && plan.kind === "emulator" && way.manual_choice === 0 && needsTitleReport(content.platform) && cur?.kind === "rom" && cur.platform === content.platform) {
    return update(r.id, { state: "ready", stage: "game data imported; emulator setup uses the existing copy", progress: 1, package_id: cur.pkg.id, done: true });
  }
  update(r.id, { state: "matching", stage: `searching the indexers for the game file of ${plan.name}`, progress: 0.02, message: null });
  let ranked: ReleaseView[];
  let pass: Awaited<ReturnType<typeof prepareContentPass>>;
  try {
    pass = await prepareContentPass(way, game, line => rdeps.log(`#${r.id} ${line}`), { wait: false });
    if (!pass) return buildWay(r, game, way, plan);
    const held = heldFor(pass);
    if (held.attached) { rdeps.log(`#${r.id} ${game.name}: ${held.attached.name}, kept earlier, is the game file of ${plan.name}`); return buildWay(r, game, getWay(way.id) ?? way, plan); }
    if (held.holds) return failed(r, "a game file waits for a look", `${held.holds.name} came from the indexers and nothing could prove it is the game: accept it for the way on the game page, or remove it to search again`);
    const q = contentQuery(pass, game);
    ranked = (await rdeps.search(q.name, q.year, q.opts)).ranked;
  } catch (e: any) {
    rdeps.log(`#${r.id} search failed: ${e?.message ?? e}`);
    return update(r.id, { state: "requested", stage: "the indexer search failed — trying again soon", message: String(e?.message ?? e), next_try_at: Math.floor(rdeps.now() / 1000) + 600 });
  }
  const tried = new Set<string>(triedOf(r));
  const blocked = blockedFor(game.id, { id: way.id, content: pass.content });
  const cands = onePerRelease(judgeContent(ranked, pass, { profile: profileFor(game), preferUsenet: await rdeps.usenetAvailable(), blocked, tried, now: rdeps.now() }), cfgNum("SEARCH_MAX_CANDIDATES", 4));
  if (!cands.length) {
    const hours = recheckHours(r);
    return update(r.id, { state: "requested", stage: `${tried.size || blocked.size ? "no usable copy yet" : "nothing suitable yet"} — searching again in ${hours}h`, message: null, progress: 0.02, next_try_at: Math.floor(rdeps.now() / 1000) + hours * 3600 });
  }
  rdeps.log(`#${r.id} ${game.name}: ${cands.length} candidate(s) for the game file of ${plan.name}, first: ${cands[0].title}`);
  update(r.id, { candidates_json: JSON.stringify(cands.map(c => ({ ...c, judged: RULES }))), attempt: 0, next_try_at: null });
  await tryCandidate(r.id);
}

/** a way with its game file: its build queued (or the running one followed), or why it cannot be built by itself */
function buildWay(r: RequestRow, game: GameRow, way: WayRow, plan: PlanRow) {
  const running = assembling(way.id);
  if (running) return update(r.id, { state: "processing", job_id: running.id, stage: "building", progress: 0.9, message: null });
  const why = buildBlocker(way, plan);
  if (why) return failed(r, "the way cannot be built by itself", why);
  const job = enqueueJob({ kind: "assemble", wayId: way.id, auto: true }, { gameId: game.id, requestId: r.id });
  rdeps.log(`#${r.id} ${game.name}: building ${plan.name} (job #${job.id})`);
  return update(r.id, { state: "processing", job_id: job.id, stage: "waiting to build", progress: 0.9, message: null });
}

const triedOf = (r: RequestRow): string[] => { try { return r.tried_json ? JSON.parse(r.tried_json) : []; } catch { return []; } };
const listOf = (s: string | null | undefined): string[] => { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
const remember = (r: RequestRow, guid: string | null | undefined) => guid ? JSON.stringify([...new Set([...triedOf(r), guid])]) : r.tried_json;
/** a release-day search looks every hour for three days; everything else every SEARCH_RECHECK_HOURS */
const recheckHours = (r: RequestRow) => (r.requested_by === "tracker" && rdeps.now() / 1000 - r.created_at < 3 * 86_400 ? 1 : cfgNum("SEARCH_RECHECK_HOURS", 6));
const GIVE_UP_AFTER_SEC = 7 * 86_400;

/** grab the candidate at `attempt`, moving on when a grab fails; false when none are left */
async function tryCandidate(id: number): Promise<boolean> {
  const r = row(id);
  if (!r) return false;
  let cands: ReleaseView[] = [];
  try { cands = r.candidates_json ? JSON.parse(r.candidates_json) : []; } catch { /* ignore */ }
  let last = r.message;
  // a way's search reads a release's own listing first: one that cannot hold the way's game file is never downloaded
  const forWay = r.way_id != null ? wayOf(r) : null;
  const game = forWay ? undefined : (stmts.gameById.get(r.game_id) as GameRow | undefined);
  for (let i = r.attempt; i < cands.length; i++) {
    const rel = cands[i];
    // the list was made when the search ran: what failed since is on the blocklist now (live, the second post of a fake
    // whose first post had just been blocklisted was grabbed next, 2026-11-09) — passed by, as tried; a post blocked for its
    // source only (a dead post) leaves the same release's other posts open
    if (isBlocked(blockedFor(r.game_id, forWay ? { id: forWay.way.id, content: forWay.content } : null), rel)) {
      rdeps.log(`#${id} candidate ${i + 1}/${cands.length} passed by: blocklisted since the search (${rel.title})`);
      update(id, { attempt: i + 1, tried_json: remember(row(id)!, rel.guid) });
      continue;
    }
    // a list made under older rules (a search in flight when ludarr was updated): each title is judged again (a refusal is
    // no try and blocklists nothing)
    const stale = game && (rel as ReleaseView & { judged?: string }).judged !== RULES ? rejudged(rel, game) : null;
    if (stale) {
      rdeps.log(`#${id} candidate ${i + 1}/${cands.length} passed by: ${stale} (${rel.title}; its list was made under older rules)`);
      update(id, { attempt: i + 1 });
      continue;
    }
    if (forWay?.content) {
      const files = await rdeps.peek(rel).catch(() => null);
      const look = files ? judgeListing(forWay.content, files) : { ok: true, why: null };
      if (!look.ok) {
        last = `${rel.title}: ${look.why}`;
        rdeps.log(`#${id} candidate ${i + 1}/${cands.length} refused before download: ${look.why}`);
        blockReleaseForWay({ gameId: r.game_id, wayId: forWay.way.id, guid: rel.guid, title: rel.title, indexer: rel.indexer, reason: `not the game file: ${look.why}`, cls: look.cls ?? "form" });
        update(id, { attempt: i + 1, message: last, tried_json: remember(row(id)!, rel.guid) });
        continue;
      }
    }
    // taken though CrackWatch said the game was not cracked (matchRequest's crackedWhy): CrackWatch's verdict as it is now. One the
    // copies can no longer overrule (its DRM now names a protection, the game is out too long, …) passes the candidate by (no try,
    // nothing blocklisted); a verdict gone (CrackWatch says cracked now) leaves the copy taken for itself, the old reason dropped
    let cracked = (rel as ReleaseView & { cracked?: string }).cracked;
    const fresh = cracked && game ? (stmts.gameById.get(r.game_id) as GameRow | undefined) : undefined;     // as the sync left it since
    if (cracked && fresh) {
      const now = rdeps.now(), verdict = autoContext([], fresh, now).crack;
      const gate = verdict ? crackGate(verdict, fresh, now) : null;
      if (gate && !("out" in gate)) {
        rdeps.log(`#${id} candidate ${i + 1}/${cands.length} passed by: CrackWatch now says the game is not ${verdict!.status === "unreleased" ? "out" : "cracked"}${verdict!.drm ? ` (${verdict!.drm})` : ""}${gate.miss ? `: ${gate.miss}` : ""}, and its copies no longer say otherwise (${rel.title})`);
        update(id, { attempt: i + 1 });
        continue;
      }
      if (!verdict) cracked = undefined;
    }
    try {
      const { fetch: f, duplicate } = await rdeps.grab(rel, r.game_id, forWay ? takePeeked(rel.guid) : undefined);
      // the post is already being downloaded for another search (two entries of one game, a namesake): one download has one
      // search — this one passes it by for now (no try, nothing blocklisted) and looks again at its next search
      const other = duplicate ? otherSearchOn(f.id, id) : null;
      if (other) {
        last = `${rel.title}: another search${other.game_name ? ` (${other.game_name})` : ""} is already downloading this very copy`;
        rdeps.log(`#${id} candidate ${i + 1}/${cands.length} passed by: search #${other.id} is already on its download #${f.id} (${rel.title})`);
        update(id, { attempt: i + 1, message: last });
        continue;
      }
      update(id, { state: "fetching", attempt: i, release_json: JSON.stringify(rel), fetch_id: f.id, job_id: null, stage: "sent to the download client", progress: 0.05, message: null, refused_json: null, remote_json: null, next_try_at: null });
      // taken though CrackWatch says the game is not cracked: the line says why
      record(r.game_id, "grabbed", { gameName: r.game_name, release: rel.title, source: rel.indexer, message: `${rel.protocol} · ${installClass(rel)}${cracked ? ` · ${cracked}` : ""}`, data: { guid: rel.guid, size: rel.size, protocol: rel.protocol } });
      return true;
    } catch (e: any) {
      // the download client did not answer (its RPC timed out, a 5xx, a dropped connection): the client's trouble, not the
      // release's — the same candidate is sent again later, nothing marked tried, nothing blocklisted, nothing else grabbed
      if (e instanceof FetchError && e.transient) return grabLater(row(id)!, i, `${rel.title}: ${e.message}`);
      last = `${rel.title}: ${e?.message ?? e}`;
      rdeps.log(`#${id} candidate ${i + 1}/${cands.length} failed: ${last}`);
      update(id, { attempt: i + 1, message: last, tried_json: remember(row(id)!, rel.guid) });
    }
  }
  // out of candidates: a young request keeps looking (new copies show up for days after a release); an old one gives up
  const cur = row(id)!;
  if (rdeps.now() / 1000 - cur.created_at < GIVE_UP_AFTER_SEC) {
    const hours = recheckHours(cur);
    update(id, { state: "requested", stage: `no usable copy yet — searching again in ${hours}h`, message: last, progress: 0.02, attempt: 0, candidates_json: null, release_json: null, fetch_id: null, job_id: null, next_try_at: Math.floor(rdeps.now() / 1000) + hours * 3600 });
    return false;
  }
  update(id, { state: "failed", stage: cands.length ? "every candidate release failed" : "no release found", message: last, done: true });
  record(cur.game_id, "failed", { gameName: cur.game_name, message: last ?? (cands.length ? "every candidate release failed" : "no release found") });
  return false;
}

/** a download that failed on its source, not on what it holds: a dead or taken-down usenet post, a stall, a record or a file
 *  that went away, a transfer that broke — the same release's other posts may be fine (Hollow Knight's second GGn torrent of
 *  the same title was the one imported after the first's "input is gone", 2026-11-09) */
const SOURCE_FAIL = /^nzbget: (?:FAILURE\/(?:HEALTH|PAR|FETCH|MOVE|SCAN|DISKSPACE|SPACE)|DELETED\/(?:HEALTH|DUPE|COPY|GOOD))\b|^stalled\b|vanished|not found in the download client|without a local path|reported no path|did not say where|download client is gone|transfer (?:could not start|failed)|never appeared under|kept changing|\blftp\b|no transfer URL|input is gone|the download is gone|gone from the seedbox|tracker no longer has/i;

/** the current release did not work out: blocklist it (for the request's way only, when its way turned the file down —
 *  as another game, or only for its form; not at all when `block` is false: nothing was wrong with it) and try the next
 *  candidate. A failure of its source (`source`) blocks that post only, by its guid: the same release's other posts are tried
 *  next; a copy that was refused (an import that failed on it, the admin's removal) blocks its title, every post of it */
function advance(r: RequestRow, why: string, forWay = false, block = true, cls: "identity" | "form" = "identity", source = SOURCE_FAIL.test(why)) {
  rdeps.log(`#${r.id} moving on: ${why}`);
  let rel: { guid?: string; title?: string; indexer?: string } | null = null;
  try { rel = r.release_json ? JSON.parse(r.release_json) : null; } catch { /* ignore */ }
  if (rel?.title && block) {
    if (forWay && r.way_id != null) blockReleaseForWay({ gameId: r.game_id, wayId: r.way_id, guid: rel.guid ?? null, title: rel.title, indexer: rel.indexer ?? null, reason: why, cls });
    else {
      (source && rel.guid ? stmts.insertSourceBlock : stmts.insertBlock).run(r.game_id, rel.guid ?? null, rel.title, rel.indexer ?? null, why);
      record(r.game_id, "blocklisted", { gameName: r.game_name, release: rel.title, source: rel.indexer, message: source && rel.guid ? `${why} — this post only` : why });
    }
  }
  update(r.id, { attempt: r.attempt + 1, message: why, fetch_id: null, job_id: null, tried_json: remember(r, rel?.guid), remote_json: null, next_try_at: null });
  return tryCandidate(r.id);
}

/**
 * The way a request searched for was deleted (its plan, its game file plan gone with it): the branch ends. Its job stops,
 * its download goes (one in flight is taken off the client; one that landed is done with as an import's), and the request
 * is the game's own search again — the admin's search for that way simply fails.
 */
async function leaveWay(r: RequestRow) {
  const j = r.job_id ? (stmts.jobById.get(r.job_id) as JobRow | undefined) : undefined;
  if (j && j.request_id === r.id && (j.state === "queued" || j.state === "running")) cancelJob(j.id);
  const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
  if (f && otherSearchOn(f.id, r.id)) { /* another search is still on it: its download too */ }
  else if (f?.state === "done") await releaseDownload(f.id, f.local_path).catch(() => {});
  else if (f) await removeFetch(f.id, true).catch(() => {});
  rdeps.log(`#${r.id} the way to play it searched for is gone${f ? `: ${f.title} dropped` : ""}`);
  if (r.requested_by === FOR_WAY) return failed(r, "the way to play is gone", "the way to play this search was for is gone");
  return update(r.id, { state: "requested", stage: "queued", way_id: null, progress: 0.01, message: "the way to play it searched for is gone: searching for the game itself", attempt: 0, candidates_json: null, release_json: null, fetch_id: null, job_id: null, tried_json: null, next_try_at: null });
}

async function mirrorFetch(r: RequestRow) {
  if (r.way_id != null && !wayStillThere(r)) return leaveWay(r);
  const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
  if (!f) return advance(r, "the download record vanished");
  const now = Math.floor(rdeps.now() / 1000);
  switch (f.state) {
    case "submitted": case "downloading": {
      // the stall clock is the fetch worker's (src/fetch.ts still_sec): it runs only while a torrent has no one to download
      // from — never while the client is silent, while the item waits in it, or while the seedbox's link is full
      const still = f.state === "downloading" ? f.still_sec ?? 0 : 0, note = stallNoteOf(f.id);
      const since = f.moved_at ?? null, frozen = since != null ? now - since : 0;
      if (still >= cfgNum("DOWNLOAD_STALL_MIN", 45) * 60) {          // nothing for most of an hour from no one: a dead post → next candidate
        await dropFetch(r.id, f.id, true).catch(() => {});
        // said in the time it really stood still (the clock counts only a part of it while seeders send nothing)
        return advance(r, `stalled — no progress for ${since != null && frozen > still ? inWords(frozen) : `${Math.round(still / 60)} min`}${note && note !== "no progress" ? ` (${note})` : (f.progress ?? 0) === 0 ? " (no seeders?)" : ""}`);
      }
      // a download that has not moved at all for a day (paused or queued in its client, a box too choked to reach its peers,
      // a lapsed news server — none of which is a stall): asked about; three days on, the search stops with the download kept
      // and nothing blocklisted (Retry, or a search of the game, waits on it again)
      if (since != null && frozen >= STOP_AFTER_SEC) return stopWaiting(r, { since, tries: 0, mode: "retry", kind: "download", trouble: "frozen", words: `${f.title} has not moved in the download client since ${clock(since)}${note && note !== "no progress" ? ` (${note})` : ""}`, jobId: null, input: null, absent: [], reruns: 0 });
      const ask = since != null && frozen >= FROZEN_ASK_SEC ? `; it has not moved since ${clock(since)} — ludarr keeps waiting and nothing was thrown away: Remove (with blocklist) gives this copy up` : "";
      // the client not answering, or answering without it: no rate (it would be the last one seen, and Ahoy's estimate for
      // players would freeze on it) — and what it said
      const silent = f.polled_at && now - f.polled_at > 300 ? ` — the download client has not answered since ${clock(f.polled_at)} (nothing counts as a stall while it is silent)` : "";
      const t = troubleOf(f);
      const missing = !silent && t?.missing?.length ? ` — ${t.words}` : "";
      if (f.state === "submitted") return update(r.id, { stage: `queued in the download client${silent || missing}${ask}`, progress: 0.05 });
      const waits = !silent && !missing && note && note !== "no progress" && !/seeders? connected|no peers/.test(note) ? ` — ${note}` : "";
      return update(r.id, { stage: `downloading${silent || missing ? "" : fmtRate((f as any).rate)}${silent || missing || waits}${ask}`, progress: 0.05 + 0.45 * share(f.progress) });
    }
    case "seedbox_done": {
      // a transfer the seedbox broke off waits for its next try (it resumes); after 72 h of that the search stops, keeping
      // the download and blocklisting nothing. Said as a wait, never as a leg under way (Ahoy would read "finished
      // downloading" as the transfer being next, and show players a time left that never moves)
      const t = troubleOf(f);
      if (t?.stopped) return stopWaiting(r, { since: t.since, tries: t.tries, mode: "retry", kind: "pull", trouble: "transfer", words: t.words, jobId: null, input: f.seedbox_path, absent: [], reruns: 0 });
      if (t && f.retry_at) return update(r.id, { stage: `waiting to transfer: ${waitStage({ since: t.since, words: t.words }, now, f.retry_at)}`, progress: 0.5 });
      return update(r.id, { stage: "finished downloading — transferring next", progress: 0.5 });
    }
    case "pulling": return update(r.id, { stage: `transferring to ludarr${fmtRate((f as any).rate)}`, progress: 0.5 + 0.35 * share(f.progress) });
    // the admin's own sync brings it into the finished-downloads folder (src/arrivals.ts): the stage says how far it got, never
    // with a rate (Ahoy would make an estimate of it); 72 h without it, the search stops with the download kept
    case "arriving": {
      const a = arrivalOf(f);
      if (a?.stopped) return stopWaiting(r, { since: a.since, tries: 0, mode: "retry", kind: "arrival", trouble: "arrival", words: a.words, jobId: null, input: null, absent: [], reruns: 0 });
      const x = arrivalStage(f);
      return update(r.id, { stage: x.stage, progress: x.progress });
    }
    case "done": {
      if (!f.local_path) return advance(r, "the transfer finished without a local path");
      record(r.game_id, "downloaded", { gameName: r.game_name, release: f.title, source: f.client, data: { path: f.local_path, size: f.size } });
      // a way's game file: the content pass takes it from the download, proves it and builds the way (src/ways/find.ts)
      if (r.way_id != null) {
        const job = enqueueJob({ kind: "content", gameId: r.game_id, wayId: r.way_id, requestId: r.id, fetchId: f.id, path: f.local_path }, { gameId: r.game_id, requestId: r.id, fetchId: f.id });
        return update(r.id, { state: "processing", job_id: job.id, stage: "checking the game file", progress: 0.85 });
      }
      const job = stmts.insertJob.get(r.id, f.id, r.game_id, f.local_path) as JobRow;
      return update(r.id, { state: "processing", job_id: job.id, stage: "importing", progress: 0.85 });
    }
    // a download the client finished that failed after (its transfer here) failed on its source
    case "failed": return advance(r, f.message ?? "the download failed", false, true, "identity", !!f.seedbox_path || SOURCE_FAIL.test(f.message ?? ""));
  }
}

/* ─────────── waiting out the seedbox (src/remote.ts) ─────────── */

const waitOf = (r: Pick<RequestRow, "remote_json"> | null | undefined): RemoteWait | null => {
  try { const w = r?.remote_json ? JSON.parse(r.remote_json) : null; return w && typeof w.since === "number" ? (w as RemoteWait) : null; } catch { return null; }
};
const failInfo = (j: JobRow): FailInfo | null => { try { return j.fail_json ? (JSON.parse(j.fail_json) as FailInfo) : null; } catch { return null; } };
const gbText = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
/** the row as it is now — or null when something changed it while this tick awaited the seedbox (a look, the client's word):
 *  the admin cancelled, retried or removed it meanwhile, and nothing is done from what was read before */
function still(r: RequestRow): RequestRow | null {
  const n = row(r.id);
  return n && n.state === r.state && n.job_id === r.job_id && n.fetch_id === r.fetch_id && (n.remote_json ?? null) === (r.remote_json ?? null) && n.attempt === r.attempt ? n : null;
}
/** the heavier of two weighings (the most a download was seen to hold) */
const heavier = (a?: Weight | null, b?: Weight | null): Weight | null => (!a ? b ?? null : !b ? a : b.bytes > a.bytes || (b.bytes === a.bytes && b.files > a.files) ? b : a);

/** what the judge says of a failure on the seedbox's folder: its trouble (wait: retry the job, or look for its input first),
 *  the input gone for good, or nothing about the seedbox (the copy's: today's rules, in `ended`'s words when the folder's
 *  words led the job's message) */
/** (rearrive: its download is awaited in the finished-downloads folder again — more of it arrived after it was taken, or an import from
 *  the seedbox chosen in the Queue found it carried off the seedbox (`missed`)) */
interface Judged { v: "transient" | "gone" | "lost" | "rearrive" | "ok"; trouble?: Trouble; words?: string; mode?: "retry" | "look"; absent?: number[]; rerun?: boolean; copy?: boolean; weight?: Weight | null; ended?: string; missed?: boolean }

/**
 * A job that read the seedbox's mapped folder failed: whose trouble was it? From what its run recorded (FailInfo.remote,
 * src/process/runner.ts) and what the download's client says now:
 *   the folder troubled while it ran                        → the seedbox's: run it again once the folder answers steadily —
 *                                                             unless it ended on the copy's own words (a checksum, a
 *                                                             password) a second time: then the copy's; a download that
 *                                                             lost files meanwhile is looked for first (moved away?)
 *   its input missing on a folder that answered             → the client still has it, or does not answer: the seedbox's
 *                                                             (look again); the client lost it too, or it is a usenet
 *                                                             download only NZBGet's history remembers: one absence — gone
 *                                                             after 3 over 15 min, else look again
 *   a child program's I/O words ("Read error", "unexpected end", a timeout) → one confirming re-run; the second time (the
 *                                                             confirming run itself), the copy's
 *   anything else                                            → the copy's: today's rules
 */
async function judgeJob(r: RequestRow, j: JobRow, w: RemoteWait | null): Promise<Judged> {
  const info = failInfo(j), ev = info?.remote;
  if (!info || !ev) return { v: "ok" };
  const weight = ev.start ?? null;
  const place = placeOf(ev.root ?? rootOf(j.input_path)?.to);
  if (info.class === "env" && info.kind === "remote") {
    if (ev.copy && (w?.copyEnds ?? 0) >= 1) return { v: "ok", ended: ev.ended };
    // more of a download in the finished-downloads folder than when it was taken: the sync was still bringing it — awaited there again
    if (ev.trouble === "arrival" && hasArrival(r)) return { v: "rearrive", words: ev.words ?? "more of it arrived in the finished-downloads folder while it was read", weight };
    return { v: "transient", trouble: (ev.trouble as Trouble) ?? "mount-down", words: ev.words ?? `${place} had trouble while it was read`, mode: ev.trouble === "changed" || ev.trouble === "arrival" ? "look" : "retry", copy: !!ev.copy, weight };
  }
  if (ev.absent) return { ...(await judgeAbsent(r, j.input_path, w)), weight };
  if (ev.io && !ev.confirmed && (w?.reruns ?? 0) < 1) return { v: "transient", trouble: "suspect", words: `it ended on what may be a failed read of ${place} (${clean(ev.ended ?? j.message).slice(0, 160)}): running it once more to tell ${place === FINISHED_FOLDER ? "the folder" : "the seedbox"} from the copy`, mode: "retry", rerun: true, weight };
  return { v: "ok" };
}
const clean = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
/** the request's download is one awaited in the finished-downloads folder (src/arrivals.ts) */
const hasArrival = (r: RequestRow): boolean => { const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined; return !!arrivalOf(f); };

/** the input is not in the seedbox's folder (which answers), or only part of it is: the client decides whether that is the
 *  folder's trouble (it still has it, or does not answer) or an absence that counts toward the gone rule. A usenet download
 *  NZBGet finished is only a record in its history once its folder is gone — the user's hourly move out of complete/ takes it
 *  for good — so its absence counts too, said as what it most likely is */
async function judgeAbsent(r: RequestRow, input: string, w: RemoteWait | null, o: { partial?: boolean } = {}): Promise<Judged> {
  // the finished-downloads folder: what is not there (or only partly) left it — its own cleanup took it, or it was deleted. Lost here,
  // never "gone from the seedbox" (the seedbox may well still have it): src/arrivals.ts gets it back or asks the admin
  if (syncedRoot(input)) return { v: "lost", words: o.partial ? `files of ${tail(input)} left the finished-downloads folder before its import was done (did its cleanup take them?)` : `${tail(input)} left the finished-downloads folder before its import was done (did its cleanup take it?)` };
  const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
  const view: ClientView = f ? await remoteDeps.clientView(f).catch(() => ({ answered: false, has: false })) : { answered: false, has: false };
  const name = view.name ?? f?.client ?? "the download client", file = tail(input);
  const where = o.partial ? `${file} is only partly in the seedbox folder` : `${file} is not in the seedbox folder`;
  if (!view.answered) return { v: "transient", trouble: "client-silent", words: `${where}, and ${name} is not answering`, mode: "look" };
  const moved = view.has && !view.lost && f?.protocol === "usenet";
  if (view.has && !view.lost && !moved) return { v: "transient", trouble: "not-listed", words: `the seedbox folder lost sight of ${file}; ${name} still has it${view.size ? ` (${gbText(view.size)})` : ""}`, mode: "look" };
  const absent = [...(w?.absent ?? []), Math.floor(rdeps.now() / 1000)];
  const why = moved ? `${name} finished it, so it was moved away (the hourly move out of complete/?)` : `${name} no longer has it`;
  // an import from the seedbox the admin chose instead of the finished-downloads folder: not there is the sync having carried it — never
  // gone, never a bad copy: awaited in the finished-downloads folder again
  if (goneRule(absent) && f && fromSeedbox(f)) return { v: "rearrive", missed: true, words: `${file} was ${o.partial ? "only partly" : "not"} in the seedbox folder ${absent.length} times over ${inWords(absent[absent.length - 1] - absent[0])}, and ${why}` };
  if (goneRule(absent)) return { v: "gone", words: `${file} was ${o.partial ? "only partly" : "not"} in the seedbox folder ${absent.length} times over ${inWords(absent[absent.length - 1] - absent[0])}, and ${why}` };
  const moving = o.partial ? `${file} is only partly in the seedbox folder` : `${file} is no longer in the seedbox folder`;
  return { v: "transient", trouble: moved ? "moved" : "absent", words: `${moved ? `${moving}: ${name} finished it, so it was moved away (the hourly move out of complete/?)` : `${where} and ${name} no longer lists it`}; another copy is tried once it stays away for 15 min`, mode: "look", absent };
}

/** a wait begun (or carried on) for a failed job: what the judge said, the job it is about, its tries, absences, confirming
 *  re-runs and copy's words so far, and the most its input was seen to weigh */
function waitFor(r: RequestRow, j: JobRow | null, x: Judged, kind: RemoteWait["kind"], input: string | null): RemoteWait {
  const prev = waitOf(r), now = Math.floor(rdeps.now() / 1000);
  return {
    since: prev?.since ?? now, tries: prev?.tries ?? 0, mode: x.mode ?? "retry", kind, trouble: x.trouble ?? "mount-down", words: x.words ?? "the seedbox had trouble",
    jobId: j?.id ?? null, input: input ?? prev?.input ?? null, absent: x.absent ?? prev?.absent ?? [], reruns: (prev?.reruns ?? 0) + (x.rerun ? 1 : 0),
    copyEnds: (prev?.copyEnds ?? 0) + (x.copy ? 1 : 0), weight: heavier(prev?.weight, x.weight),
  };
}

/** the wait in the request's stage (the admin's words; players read "Preparing"): with the remote path mapping to check once
 *  a client has had a file the folder does not show for half an hour. A grab is "sent once more" — Ahoy reads "again in N h"
 *  as a search that found nothing */
function waitLine(w: RemoteWait, now: number, next: number | null): string {
  const hint = w.trouble === "not-listed" && now - w.since >= 1800 && !/check the remote path mapping/.test(w.words) ? " — check the remote path mapping (Settings → Download clients)" : "";
  return waitStage({ ...w, words: w.words + hint }, now, next, w.kind === "grab" ? "sending it once more" : w.mode === "look" ? "looking again" : "trying again");
}

/**
 * A request that waits on the seedbox. At its time: a look for the input (it is there again: run the job; still missing: the
 * client and the gone rule decide), or the job run again — once the folder answered steadily (twice, 35 s apart), unless
 * the admin asked to try now, and only on the whole download (one that weighs less than a job saw it weigh is looked at as
 * one that is gone, never re-run on what is left of it). Waits come at 1, 2, 5, 10, 20, 30, 60 min, then hourly (looks at
 * 1, 3, 7, 15 min); none of them counts as a try of the release. 72 h on, it stops: the download is kept, nothing blocklisted.
 */
async function seedboxWait(r: RequestRow, w: RemoteWait): Promise<unknown> {
  const now = Math.floor(rdeps.now() / 1000);
  if (now - w.since >= STOP_AFTER_SEC) return stopWaiting(r, w);
  // a new wait, or a new turn of one (a re-run that failed again): its next time from the ladder, said (the stage carries
  // the words; the message is left to the job's own)
  if (r.remote_json !== JSON.stringify(w) || r.next_try_at == null) {
    const next = now + nextWait(w);
    rdeps.log(`#${r.id} waiting on the seedbox: ${w.words} — trying again in ${inWords(next - now)}`);
    return update(r.id, { stage: waitLine(w, now, next), message: null, next_try_at: next, remote_json: JSON.stringify(w) });
  }
  if (!w.now && r.next_try_at > now) return update(r.id, { stage: waitLine(w, now, r.next_try_at) });
  const root = rootOf(w.input)?.to ?? null;
  // the folder must answer first (the monitor probes it every 30 s while anything waits)
  const s = root ? rootState(root) : null;
  if (root && !w.now && s?.ok !== true) {
    const why = w.trouble === "mount-down" && s ? "" : `; ${placeOf(root)} ${s ? (s.why ?? "does not answer") : "has not been looked at yet"}`;
    return update(r.id, { stage: waitLine({ ...w, words: w.words + why }, now, now + 30), next_try_at: now + 30 });
  }
  if (w.mode === "look" && w.input) {
    const there = await remoteDeps.stat(w.input);
    if (!still(r)) return;
    if (typeof there === "object") return relook(r, { ...w, trouble: "io", words: `${placeOf(root)} could not say whether ${tail(w.input)} is there (${there.code})` });
    if (there === "absent") {
      const x = await judgeAbsent(r, w.input, w);
      if (!still(r)) return;
      if (x.v === "lost") return arrivalLost(r, x.words!);
      if (x.v === "rearrive") return arrivalAgain(r, x);
      if (x.v === "gone") return goneFor(r, w, x.words!);
      return relook(r, { ...w, trouble: x.trouble!, words: x.words!, absent: x.absent ?? w.absent });
    }
    w = { ...w, mode: "retry" };                                        // it is there again
  }
  // a download that weighs less than a job saw it weigh is not all there (half moved away): looked at as one that is gone
  if (w.weight && w.input && (w.kind === "import" || w.kind === "content")) {
    const left = await remoteDeps.weigh(w.input).catch(() => null);
    if (!still(r)) return;
    if (left && (left.files < w.weight.files || left.bytes < w.weight.bytes)) {
      const x = await judgeAbsent(r, w.input, w, { partial: true });
      if (!still(r)) return;
      if (x.v === "lost") return arrivalLost(r, x.words!);
      if (x.v === "rearrive") return arrivalAgain(r, x);
      if (x.v === "gone") return goneFor(r, w, x.words!);
      return relook(r, { ...w, mode: "look", trouble: x.trouble!, words: x.words!, absent: x.absent ?? w.absent });
    }
  }
  if (root && !w.now && !rootSteady(root)) return update(r.id, { stage: waitLine({ ...w, words: `${w.words}; ${placeOf(root)} answers again, and is tried once it has answered steadily` }, now, now + 30), next_try_at: now + 30, remote_json: JSON.stringify(w) });
  return rerun(r, { ...w, absent: [] });
}

/** the wait before the next turn: the looks for a file the client no longer lists come at 1, 3, 7 and 15 min (the gone rule's
 *  span); everything else on the ladder — 1, 2, 5, 10, 20, 30, 60 min, then hourly */
const nextWait = (w: RemoteWait) => (w.mode === "look" && (w.trouble === "absent" || w.trouble === "moved") ? lookSec(Math.max(1, w.absent.length)) : ladderSec(w.tries));

/** another look later, the wait kept */
function relook(r: RequestRow, w: RemoteWait) {
  const out = { ...w, tries: w.tries + 1, now: false };
  const now = Math.floor(rdeps.now() / 1000), next = now + nextWait({ ...out, tries: w.tries });
  return update(r.id, { stage: waitLine(out, now, next), message: null, next_try_at: next, remote_json: JSON.stringify(out) });
}

/** the wait's work done again: the import, the way's check, the held import's look, the grab */
async function rerun(r: RequestRow, w: RemoteWait) {
  const next: RemoteWait = { ...w, jobId: null, tries: w.tries + 1, now: false };
  const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
  switch (w.kind) {
    case "import": {
      if (!w.input) break;
      const job = stmts.insertJob.get(r.id, f?.id ?? null, r.game_id, w.input) as JobRow;
      rdeps.log(`#${r.id} the seedbox answers again — import #${job.id} tries again (${w.words})`);
      return update(r.id, { state: "processing", job_id: job.id, stage: "importing", progress: 0.85, message: null, next_try_at: null, remote_json: JSON.stringify(next) });
    }
    case "content": {
      if (!w.input || r.way_id == null) break;
      const job = enqueueJob({ kind: "content", gameId: r.game_id, wayId: r.way_id, requestId: r.id, fetchId: f?.id ?? null, path: w.input }, { gameId: r.game_id, requestId: r.id, fetchId: f?.id ?? null });
      rdeps.log(`#${r.id} the seedbox answers again — the game file is checked again (job #${job.id})`);
      return update(r.id, { state: "processing", job_id: job.id, stage: "checking the game file", progress: 0.85, message: null, next_try_at: null, remote_json: JSON.stringify(next) });
    }
    case "grab": {
      update(r.id, { state: "matching", next_try_at: null, remote_json: JSON.stringify(next) });
      return tryCandidate(r.id);
    }
    case "hold": case "check":
      // the input is there again: the hold (or the check's retry) carries on as before
      return update(r.id, { next_try_at: null, remote_json: null, message: null });
  }
  return update(r.id, { next_try_at: null, remote_json: null });
}

/** gone for good from the seedbox (the gone rule): a failure of the post's source — that post only is blocklisted (for a
 *  way: nothing), and the next candidate is tried */
function goneFor(r: RequestRow, w: RemoteWait, words: string) {
  const forWay = w.kind === "content" || w.kind === "check";
  return advance(r, `gone from the seedbox: ${words}`, forWay, !forWay, "identity", true);
}

/** its download left the finished-downloads folder before its import was done (that folder's own cleanup took it): no failure of the
 *  copy — nothing is blocklisted and nothing else is grabbed. The search follows its download again, which is awaited anew
 *  (src/arrivals.ts: a usenet download is downloaded again by itself, once; otherwise the Queue asks the admin) */
function arrivalLost(r: RequestRow, words: string) {
  const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
  if (!f) return failed(r, "the download left the finished-downloads folder", `${words} — and its download record is gone: search again`);
  markLost(f, words);
  rdeps.log(`#${r.id} its download left the finished-downloads folder before the import: ${words}`);
  return update(r.id, { state: "fetching", job_id: null, stage: `${words} — it is awaited again`, progress: 0.5, message: null, remote_json: null, next_try_at: null });
}

/** its download is awaited in the finished-downloads folder again (src/arrivals.ts): more of it arrived after it was taken (the sync was
 *  still bringing it), or an import from the seedbox chosen in the Queue found it carried off the seedbox — no failure of the
 *  copy: nothing is blocklisted, nothing else is grabbed, and the search follows its download again */
function arrivalAgain(r: RequestRow, x: Judged) {
  const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
  const words = x.words ?? "it is awaited in the finished-downloads folder again";
  if (!f) return failed(r, "the download record is gone", `${words} — and its download record is gone: search again`);
  if (x.missed) seedboxMissed(f, words); else rearrive(f, words);
  rdeps.log(`#${r.id} its download is awaited in the finished-downloads folder again: ${words}`);
  return update(r.id, { state: "fetching", job_id: null, stage: `${words} — it is awaited in the finished-downloads folder again`, progress: 0.5, message: null, remote_json: null, next_try_at: null });
}

/** the bound: 72 h of a seedbox that does not answer (or a download that does not move) — the request stops, its download
 *  kept, nothing blocklisted; Retry, or a search of the game, picks the wait up again (retryRequest, createRequest) */
function stopWaiting(r: RequestRow, w: RemoteWait) {
  const stopped: RemoteWait = { ...w, stopped: true, now: false };
  rdeps.log(`#${r.id} stopped waiting for the seedbox after ${inWords(Math.floor(rdeps.now() / 1000) - w.since)}: ${w.words}`);
  // (a wait on an import read from the finished-downloads folder is said of that folder, not the seedbox)
  const synced = !!syncedRoot(w.input);
  const message = w.kind === "arrival"
    ? `${w.words} — waiting since ${clock(w.since)}; the download is kept and nothing was blocklisted: Retry looks for it in the finished-downloads folder again`
    : `${w.words} — waiting since ${clock(w.since)}; the download is kept and nothing was blocklisted: Retry once ${synced ? "the finished-downloads folder" : "the seedbox"} answers again`;
  const stage = w.kind === "download" ? "waited 3 days for the download to move" : w.kind === "arrival" ? "waited 3 days for it to arrive in the finished-downloads folder" : synced ? "waited 3 days for the finished-downloads folder" : "waited 3 days for the seedbox";
  const out = update(r.id, { state: "failed", stage, message, next_try_at: null, remote_json: JSON.stringify(stopped), done: true });
  record(r.game_id, "failed", { gameName: r.game_name, message });
  return out;
}

/** the download client did not answer the grab: the same candidate after the ladder's wait (nothing tried, nothing
 *  blocklisted); 72 h on, the request stops like any wait */
function grabLater(r: RequestRow, attempt: number, why: string): boolean {
  const now = Math.floor(rdeps.now() / 1000);
  const prev = waitOf(r);
  const w: RemoteWait = { since: prev?.since ?? now, tries: prev?.tries ?? 0, mode: "retry", kind: "grab", trouble: "client-silent", words: `the download client did not answer (${why.slice(0, 200)})`, jobId: null, input: null, absent: [], reruns: 0 };
  if (now - w.since >= STOP_AFTER_SEC) { stopWaiting(r, w); return false; }
  const next = now + ladderSec(w.tries);
  rdeps.log(`#${r.id} ${w.words} — sending it again in ${inWords(next - now)}`);
  update(r.id, { state: "requested", attempt, stage: waitLine(w, now, next), message: null, next_try_at: next, remote_json: JSON.stringify(w), progress: 0.03 });
  return false;
}

/** a mapped input that is not there (or the folder cannot say): a wait that looks for it again; gone after the rule */
async function missingInput(r: RequestRow, j: JobRow, kind: RemoteWait["kind"], there: "absent" | { code: string }) {
  const x: Judged = there === "absent" ? await judgeAbsent(r, j.input_path, waitOf(r)) : { v: "transient", trouble: "io", words: `${placeOf(rootOf(j.input_path)?.to)} could not say whether ${tail(j.input_path)} is there (${there.code})`, mode: "look" };
  const cur = still(r);
  if (!cur) return;
  if (x.v === "lost") return arrivalLost(cur, x.words!);
  if (x.v === "rearrive") return arrivalAgain(cur, x);
  if (x.v === "gone") return goneFor(cur, waitOf(cur) ?? waitFor(cur, j, x, kind, j.input_path), x.words!);
  return seedboxWait(cur, waitFor(cur, j, x, kind, j.input_path));
}

/**
 * The recipes gave up and the AI importer is not ready: keep the download, say so, and pick it up the
 * moment it is (the moment a key is saved under Settings → Importers). Blocklisting the release would
 * throw away a perfectly good copy just because ludarr cannot open it yet. A download on the seedbox's folder that is not
 * there right now is looked for again (src/remote.ts): only one gone for good moves the search on.
 */
const NEEDS_AGENT = /AI importer could take over|model API HTTP 40[13]/;
const KEY_REJECTED = /model API HTTP 40[13]/;
async function holdForAgent(r: RequestRow, j: JobRow) {
  const w = waitOf(r);
  if (w && !w.stopped && w.jobId === j.id) return seedboxWait(r, w);
  if (rootOf(j.input_path)) {
    const there = await remoteDeps.stat(j.input_path);
    const cur = still(r);
    if (!cur) return;
    if (there !== "present") return missingInput(cur, j, "hold", there);
  } else if (!existsSync(j.input_path)) return advance(r, `it needs the AI importer and the download is gone (${j.message})`);
  const now = Math.floor(rdeps.now() / 1000);
  if (KEY_REJECTED.test(j.message ?? "")) {                            // wrong key / wrong base URL: no point hammering it
    if (!r.next_try_at) return update(r.id, { stage: "the AI importer's key was rejected — check it under Settings → Importers (trying again in 30 min)", progress: 0.85, message: j.message, next_try_at: now + 30 * 60 });
    if (r.next_try_at > now) return;
  }
  if (rdeps.agentReady()) {
    const job = stmts.insertJob.get(r.id, j.fetch_id, r.game_id, j.input_path) as JobRow;
    rdeps.log(`#${r.id} the AI importer is ready now — import #${job.id} takes over from #${j.id}`);
    return update(r.id, { job_id: job.id, stage: "importing", progress: 0.85, message: null, next_try_at: null });
  }
  return update(r.id, { stage: "downloaded, but it needs the AI importer — add an API key under Settings → Importers", progress: 0.85, message: j.message });
}

/** a re-run whose failure was not the seedbox's ends its wait: what waited is over (its clock, its tries and confirming
 *  re-runs are no next wait's; the health list and the monitor stop counting it) */
function waitOver(r: RequestRow): RequestRow {
  return r.remote_json ? update(r.id, { remote_json: null, next_try_at: null }) ?? r : r;
}

async function mirrorJob(r: RequestRow) {
  const j = r.job_id ? (stmts.jobById.get(r.job_id) as JobRow | undefined) : undefined;
  if (!j) return advance(r, "the import job vanished");
  if (r.way_id != null && j.kind === "content" && !wayStillThere(r)) return leaveWay(r);
  // a job the bound took out of the queue (72 h on a folder that did not answer), its wait picked up again (Retry): the
  // wait runs it anew — its cancel is no cancel of the search
  const held = waitOf(r);
  if (held && !held.stopped && held.jobId === j.id && j.state === "cancelled") return seedboxWait(r, held);
  if (r.way_id != null && (j.kind === "content" || j.kind === "assemble")) return mirrorWayJob(r, j);
  switch (j.state) {
    case "queued": return heldInQueue(r, j, "waiting for the importer");
    case "running": return update(r.id, { stage: j.message || "importing", progress: 0.85 + 0.15 * (j.progress ?? 0) });
    case "done": {
      const pkg = stmts.packageForJob.get(j.id) as PackageRow | undefined;
      return update(r.id, { state: "ready", stage: "imported", progress: 1, package_id: pkg?.id ?? null, message: null, remote_json: null, next_try_at: null, done: true });
    }
    case "failed": {
      // a wait on the seedbox already under way for this very failure: it goes on (its time, its looks, its bound)
      const w = waitOf(r);
      if (w && !w.stopped && w.jobId === j.id) return seedboxWait(r, w);
      // a way was built for the game while this import ran (an import never replaces a way's package): the game can be
      // played, and the release is not to blame, so nothing is blocklisted and no other release is fetched
      const have = stmts.packageForGame.get(r.game_id) as PackageRow | undefined;
      if (have && classOfPackage(have) === "way") return update(r.id, { state: "ready", stage: "imported", progress: 1, package_id: have.id, message: null, remote_json: null, done: true });
      // read from the seedbox's folder: the seedbox's trouble is waited out whatever the job's words, a file gone for good
      // blocks that post only
      const x = await judgeJob(r, j, w);
      const cur = still(r);
      if (!cur) return;
      if (x.v === "lost") return arrivalLost(cur, x.words!);
      if (x.v === "rearrive") return arrivalAgain(cur, x);
      if (x.v === "transient") return seedboxWait(cur, waitFor(cur, j, x, "import", j.input_path));
      if (x.v === "gone") return goneFor(cur, waitFor(cur, j, x, "import", j.input_path), x.words!);
      const rest = waitOver(cur);
      if (NEEDS_AGENT.test(j.message ?? "")) return holdForAgent(rest, j);
      return advance(rest, `import failed: ${x.ended ?? j.message ?? "unknown error"}`);
    }
    case "cancelled": return update(r.id, { state: "cancelled", stage: "cancelled", done: true });
  }
}

/** a job still in the queue: its own word when the runner holds it for the seedbox's folder (which does not answer) — and the
 *  bound of a wait applies there too: 72 h of it, and the job is taken out of the queue and the request stops (the download
 *  kept, nothing blocklisted; Retry puts it back) */
function heldInQueue(r: RequestRow, j: JobRow, idle: string) {
  const held = !!j.message && /seedbox folder|finished-downloads folder/.test(j.message);
  if (!held) return update(r.id, { stage: idle, progress: 0.85 });
  const now = Math.floor(rdeps.now() / 1000);
  const w = waitOf(r);
  const since = w && !w.stopped ? w.since : j.created_at;
  if (now - since >= STOP_AFTER_SEC) {
    cancelJob(j.id);
    const kind: RemoteWait["kind"] = j.kind === "content" ? "content" : "import";
    return stopWaiting(r, { ...(w ?? { tries: 0, mode: "retry", absent: [], reruns: 0 }), since, kind, trouble: "mount-down", words: j.message!, jobId: j.id, input: w?.input ?? j.input_path } as RemoteWait);
  }
  return update(r.id, { stage: j.message!, progress: 0.85 });
}

const outcomeOf = (j: JobRow): TakeOutcome | null => { try { const m = j.manifest_json ? JSON.parse(j.manifest_json) : null; return m && (m.outcome === "proven" || m.outcome === "kept") ? m as TakeOutcome : null; } catch { return null; } };

/** how many times a download's game file is checked before the request gives up on a check that cannot be made, and the
 *  wait before each next try (minutes, times the tries so far) */
const CHECK_TRIES = 3, CHECK_BACKOFF_MIN = 10;

/**
 * A content job that could not look at the download (no room for the file, a tool missing, the way being built): the
 * release is not to blame, so nothing is blocklisted. The download is checked again after a wait, a few times; then the
 * request fails saying why, the download kept. A download on the seedbox's folder that is not there right now is looked for
 * again instead (src/remote.ts): only one gone for good moves the search on.
 */
async function retryCheck(r: RequestRow, j: JobRow) {
  const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
  if (f?.local_path && rootOf(f.local_path)) {
    const there = await remoteDeps.stat(f.local_path);
    const cur = still(r);
    if (!cur) return;
    if (there !== "present") return missingInput(cur, { ...j, input_path: f.local_path }, "check", there);
  } else if (!f?.local_path || !existsSync(f.local_path)) return advance(r, `the download is gone (${j.message ?? "unknown error"})`, true, false);
  const tries = (stmts.contentJobsForFetch.get(f!.id) as { n: number }).n;
  if (tries >= CHECK_TRIES) return failed(r, "the game file could not be checked", `${j.message ?? "unknown error"} — the download is kept: search again once that is fixed`);
  const now = Math.floor(rdeps.now() / 1000), wait = CHECK_BACKOFF_MIN * tries;
  if (!r.next_try_at) return update(r.id, { stage: `the game file could not be checked — trying again in ${wait} min`, progress: 0.85, message: j.message, next_try_at: now + wait * 60 });
  if (r.next_try_at > now) return;
  const job = enqueueJob({ kind: "content", gameId: r.game_id, wayId: r.way_id, requestId: r.id, fetchId: f!.id, path: f!.local_path! }, { gameId: r.game_id, requestId: r.id, fetchId: f!.id });
  return update(r.id, { job_id: job.id, stage: "checking the game file", progress: 0.85, message: null, next_try_at: null });
}

/**
 * A way's search past its download: the content job that takes the game file in, then the way's build it queued. A
 * download the way refuses blocklists the release for that way and the next candidate is tried; a check that could not be
 * made is tried again (retryCheck); one nothing could prove is kept for the admin and the search ends (its release
 * blocklisted for the way, so it is never fetched again); the build's end is the request's — a build that would have
 * replaced another way's package (built meanwhile) leaves the game with that one, ready. A check the seedbox broke off (its
 * folder troubled while the job read it: the job's fail kind 'remote') is waited out like an import's, and counts as no try;
 * one that ended on words that may be a failed read (a make's step or a 7z listing that ran out of time) is run once more
 * before its refusal or its recipe's fault counts.
 */
async function mirrorWayJob(r: RequestRow, j: JobRow) {
  const building = j.kind === "assemble";
  switch (j.state) {
    case "queued": return building ? update(r.id, { stage: "waiting to build", progress: 0.9 }) : heldInQueue(r, j, "waiting to check the game file");
    case "running": return update(r.id, { stage: building ? "building" : "checking the game file", progress: building ? 0.9 + 0.1 * (j.progress ?? 0) : 0.85 + 0.05 * (j.progress ?? 0) });
    case "cancelled": return update(r.id, { state: "cancelled", stage: "cancelled", done: true });
    case "failed": {
      if (building) {
        const cur = currentPackage(r.game_id);
        if (cur && cur.kind !== "rom") return update(r.id, { state: "ready", stage: "imported", progress: 1, package_id: cur.pkg.id, message: j.message ?? null, done: true });
        return failed(r, "the build failed", `the way to play was not built: ${j.message ?? "unknown error"}`);
      }
      const w = waitOf(r);
      if (w && !w.stopped && w.jobId === j.id) return seedboxWait(r, w);
      const x = await judgeJob(r, j, w);
      const cur = still(r);
      if (!cur) return;
      if (x.v === "lost") return arrivalLost(cur, x.words!);
      if (x.v === "rearrive") return arrivalAgain(cur, x);
      if (x.v === "transient") return seedboxWait(cur, waitFor(cur, j, x, "content", j.input_path));
      if (x.v === "gone") return goneFor(cur, waitFor(cur, j, x, "content", j.input_path), x.words!);
      const rest = waitOver(cur);
      if (refusedDownload(j.message)) return advance(rest, j.message!, true, true, refusalClass(j));
      // the way's make failed on the download: its recipe's fault, not the release's (the carry run repairs the recipe and
      // searches again; the download is kept, and nothing is blocklisted)
      if (recipeFault(j)) return failed(rest, "the game file could not be made from the download", `${j.message ?? "the make failed"} — the download is kept`);
      return retryCheck(rest, j);
    }
    case "done": {
      if (r.remote_json) update(r.id, { remote_json: null });
      if (building) {
        const pkg = stmts.packageForJob.get(j.id) as PackageRow | undefined;
        return update(r.id, { state: "ready", stage: "imported", progress: 1, package_id: pkg?.id ?? null, message: null, done: true });
      }
      const out = outcomeOf(j);
      if (!out) return advance(r, "the game file check said nothing", true);
      if (out.outcome === "kept") {
        let rel: { guid?: string; title?: string; indexer?: string } | null = null;
        try { rel = r.release_json ? JSON.parse(r.release_json) : null; } catch { /* ignore */ }
        if (rel?.title && r.way_id != null) blockReleaseForWay({ gameId: r.game_id, wayId: r.way_id, guid: rel.guid ?? null, title: rel.title, indexer: rel.indexer ?? null, reason: `kept ${out.file} for a look`, cls: "identity" });
        return failed(r, "kept the game file for a look", `kept ${out.file}: ${out.why ?? "nothing proves it is the game"} — accept it on the game page if it is the game`);
      }
      if (out.assembleJobId) return update(r.id, { job_id: out.assembleJobId, stage: "waiting to build", progress: 0.9, message: null });
      // the file is the way's, but the way cannot be built by itself: the admin's search has done what it was asked
      if (r.requested_by === FOR_WAY) return update(r.id, { state: "ready", stage: `found the game file: ${out.why ?? "build the way from the game page"}`, progress: 1, message: out.why ?? null, done: true });
      return failed(r, "found the game file", `${out.file} is the way's game file, and ${out.why ?? "the way could not be built by itself"}`);
    }
  }
}

let ticking = false;
export async function requestsTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Math.floor(rdeps.now() / 1000);
    for (const r of stmts.requestsByState.all("requested") as RequestRow[]) {
      if (r.next_try_at && r.next_try_at > now) continue;
      // a grab the download client did not answer: the same candidate again (no new search)
      const w = waitOf(r);
      if (w?.kind === "grab" && !w.stopped && r.candidates_json) { await seedboxWait(r, w); break; }
      await matchRequest(r);
      break;                                   // one search per tick keeps the indexers happy
    }
    for (const r of stmts.requestsByState.all("fetching") as RequestRow[]) await mirrorFetch(r);
    for (const r of stmts.requestsByState.all("processing") as RequestRow[]) await mirrorJob(r);
  } finally { ticking = false; }
}

/**
 * Try a search again. A request that waits on the seedbox — or stopped waiting after 72 h of it — is tried now (the folder
 * need not have answered steadily first), its wait's clock begun again when it had stopped; a stopped wait is resumed
 * whoever asks (the Queue's Retry or "Search again", a search of the game): its download is kept, and a fresh search would
 * fetch another copy of what is already on the seedbox. Otherwise a failed search is searched again (`fresh`: what it tried
 * is forgotten).
 */
export function retryRequest(id: number, opt: { fresh?: boolean } = {}) {
  const r = row(id);
  if (!r) throw new RequestError("not found", 404);
  const w = waitOf(r);
  const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
  const live = !!w && !w.stopped && ["requested", "fetching", "processing"].includes(r.state);
  if (w && ((w.stopped && r.state === "failed") || (live && !opt.fresh))) {
    const now = Math.floor(rdeps.now() / 1000);
    if (w.kind === "pull") {
      if (f) retryFetch(f.id);
      return serializeRequest(update(id, { state: "fetching", stage: "finished downloading — trying the transfer again now", message: null, next_try_at: null, remote_json: null, done_at: null })!);
    }
    // a download awaited in the finished-downloads folder that stopped after 72 h: awaited again from now
    if (w.kind === "arrival") {
      if (f) resumeArrival(f);
      return serializeRequest(update(id, { state: "fetching", stage: "looking for it in the finished-downloads folder again", message: null, next_try_at: null, remote_json: null, done_at: null })!);
    }
    // a download that did not move: waited on again from now (its client still has it)
    if (w.kind === "download") {
      if (f) stmts.setFetchMoved.run(now, f.id);
      return serializeRequest(update(id, { state: "fetching", stage: "downloading", message: null, next_try_at: null, remote_json: null, done_at: null })!);
    }
    const again: RemoteWait = w.stopped ? { ...w, stopped: false, since: now, tries: 0, absent: [], now: true } : { ...w, now: true };
    const state = w.stopped ? (w.kind === "grab" ? "requested" : "processing") : r.state;
    return serializeRequest(update(id, { state, stage: "trying again now", message: null, next_try_at: now, remote_json: JSON.stringify(again), done_at: w.stopped ? null : r.done_at })!);
  }
  // a transfer that waits out the seedbox: tried now
  if (!opt.fresh && r.state === "fetching" && f?.state === "seedbox_done" && (f.retry_at || troubleOf(f)?.stopped)) { retryFetch(f.id); return serializeRequest(update(id, { stage: "finished downloading — trying the transfer again now" })!); }
  // a download awaited in the finished-downloads folder: looked for now
  if (!opt.fresh && r.state === "fetching" && f?.state === "arriving") { retryFetch(f.id); return serializeRequest(update(id, { stage: "looking for it in the finished-downloads folder now" })!); }
  // a waiting request is simply asked to look now (what it already tried stays tried — unless asked to forget it)
  if (r.state === "requested" && r.next_try_at && !opt.fresh) return serializeRequest(update(id, { stage: "queued", next_try_at: null })!);
  if (r.state !== "failed" && r.state !== "cancelled" && !(r.state === "requested" && opt.fresh)) throw new RequestError(`cannot retry a search that is ${r.state}`, 409);
  return serializeRequest(update(id, { state: "requested", stage: "queued", progress: 0.01, message: null, attempt: 0, candidates_json: null, release_json: null, fetch_id: null, job_id: null, next_try_at: null, tried_json: null, remote_json: null })!);
}

/** stop whatever is in flight (the download client keeps what it has) and drop the row; a build it only followed (the
 *  admin's own) runs on. A search that stopped waiting on a transfer lets that download go with it (nothing else would ever
 *  try it again) */
export async function cancelRequest(id: number, drop: boolean): Promise<void> {
  const r = row(id);
  if (!r) throw new RequestError("not found", 404);
  if (["requested", "matching", "fetching", "processing"].includes(r.state)) {
    const j = r.job_id ? (stmts.jobById.get(r.job_id) as JobRow | undefined) : undefined;
    if (j && (j.request_id === r.id || (j.kind ?? "import") === "import")) cancelJob(j.id);
    // (one whose files already arrived in the finished-downloads folder keeps its record: src/fetch.ts remove refuses it)
    if (r.fetch_id) await dropFetch(r.id, r.fetch_id, false).catch(() => {});
    update(id, { state: "cancelled", stage: "cancelled", done: true });
  } else if (r.state === "failed" && waitOf(r)?.stopped && r.fetch_id) {
    const f = stmts.fetchById.get(r.fetch_id) as FetchRow | undefined;
    if (f && f.state !== "done" && f.state !== "failed") await dropFetch(r.id, f.id, false).catch(() => {});
  }
  if (drop) { stmts.deleteRequest.run(id); events.emit("request", { id, deleted: true }); }
}

/** searches that were mid-match when the process died go back to the queue */
export function resumeRequests() {
  for (const r of stmts.requestsByState.all("matching") as RequestRow[]) update(r.id, { state: "requested", stage: "queued", next_try_at: null });
}
