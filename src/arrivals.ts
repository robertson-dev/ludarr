/**
 * ludarr — downloads that reach this server through the admin's own sync, the way their Sonarr and Radarr take them.
 *
 * The finished-downloads folder (src/synced.ts: one setting, "Finished downloads land in" — downloads/finished, /arrivals in the
 * container) is where everything the download clients finish ends up: the admin's sync — an `rclone move` every few minutes,
 * one file at a time, keeping the seedbox's dates, writing `<name>.<random>.partial` until a file is whole — brings every
 * download there, torrents and usenet alike. The folder is shared (TV, films: the admin's Sonarr and Radarr import from it and
 * move what they import out of it), and nothing of the admin's empties it — an hourly cleanup of theirs exists but is off,
 * and may be switched on one day (the hold below is for it). While it is set and there, no finished download is pulled:
 * ludarr finds each of its own there by its NAME alone, never by a path on the seedbox, two levels deep — <folder>/<name>,
 * <folder>/<name>/<name> (nested in a folder of its own name), <folder>/<any folder>/<name> (a category's: ahoy/ for its
 * usenet downloads), a single file as <folder>/<name> or in <folder>/<name>/.
 *
 *   arriving    a download its client finished is waited for there (fetches.state 'arriving', its state in
 *               fetches.arrival_json; its clock starts when the client finished it). A torrent is its client's name for it
 *               and the files rTorrent lists (the ones it downloads; else what its .torrent lists): taken where every one of
 *               them is at its path and exact size, with nothing else in its own folders, no part of them still being
 *               written, and the same sizes and dates on two looks a minute apart. A usenet download is the folder named
 *               like NZBGet's NZB name or like the last folder of its FinalDir/DestDir, with no _unpack in it. Through the
 *               client's remote path mapping (the seedbox's mount, when it has one) ludarr reads what NZBGet's folder held
 *               and whether the sync is done with it (the sync moves each file: a folder gone or empty there is all of it
 *               carried): every file it held here at its size, the sync done, nothing in its folder being written — taken.
 *               Read before anything of it came here, that list is all of it: a file in its folder NZBGet's folder did not
 *               hold is someone else's. Without that word (no mount: at least 90 % of what NZBGet downloaded, else of the
 *               release's size, unchanged for 10 min on a clock that stands while the sync writes anything anywhere in the
 *               folder); a mount that does not answer: it waits. Two places that could be it, a folder it shares with
 *               something else, a file of its name at another size, a folder an earlier download of that name left files in
 *               (while anything that one took there, or its client listed, is still there at its size — however long ago —
 *               or nothing says what its files were): nothing is touched, and the stage and the health list say so. When it
 *               is taken, exactly what it is — every file, its path and its size — is written down (fetches.took_json), and
 *               which of those its client's own list has at that size (a torrent's files; what NZBGet's folder held on the
 *               seedbox): only those are ever deleted by ludarr itself, the rest is written down as unproven. Then the
 *               import reads it where it is (and copies it: the library is another volume, so the game is then stored
 *               twice) — and finds all of it there, or it is lost (below); more of it arriving while it is read sends it back
 *               to arriving.
 *   the hold    the hourly cleanup, when it is on, counts an hour from a file's date, and the sync keeps the seedbox's: a file
 *               can land already "an hour old". Each file of a download ludarr waits for or imports gets the present date
 *               the moment it shows (the folder's change event holds it at once; the looks — every second while anything is
 *               awaited — are the truth), its date is looked at every minute (one the sync set back is held again) and
 *               refreshed every 10 min while the download arrives, waits for its import or is imported, and until it is
 *               removed (below); one that is not removed is let go (history: "left in the finished-downloads folder"). A file
 *               whose date cannot be set is said, and tried again. After a restart every held download is refreshed before
 *               anything else runs.
 *   removed     the way Radarr and Sonarr move what they import out of the folder: once a download taken there is imported —
 *               the latest job its search ran on it (its import, a way's check of it) is done and read what was taken (a
 *               way's check proved the game file and its way was built), the search is over, and the game's copy in the
 *               library is there with every file of its manifest at its size — and nothing uses it any more (no search in
 *               flight on it, no job queued or running on it or reading inside it: the AI importer's wait, a carry run's look
 *               at an earlier download, an import by hand; no other download of ludarr's awaited or held where it lies — a
 *               wait that stopped, one whose client was deleted or one imported from the seedbox instead awaits nothing),
 *               exactly what was taken and its client's list shows to be its own goes: each file only at the path and the
 *               size written down when it was taken, as a plain file reached through real folders (one that changed, or was
 *               never part of it, stays and is said), then the folders that leaves empty, deepest first, inside the
 *               download's own folder only — never the finished-downloads folder itself, never a folder it shares (a
 *               category's like ahoy/, the folder it sits in), never one that holds anything else; nothing is ever removed
 *               recursively. What it took that nothing shows to be its own stays and is said (a usenet download whose NZBGet
 *               folder was never seen on the seedbox: all of it; a file that was in its folder before that folder was read
 *               there), and the leftovers list offers it. Nothing is deleted while the finished-downloads folder is not the
 *               one set now (emptied, set to another folder), not there, or an rclone mount of the seedbox (the seedbox's own
 *               files): the removal waits. History: "removed from the finished-downloads folder after its import (12 files,
 *               19.2 GB)". A delete that fails (EACCES, EBUSY, EPERM, a file Unraid keeps while something has it open) is
 *               tried again on the ladder (1, 2, 5 … 60 min, then hourly), files found already gone are looked at once more a
 *               minute later, and the hold stays on until it is done; one that keeps failing, or waits a day, is said in the
 *               health list, and nothing else waits on it. Its state is the arrival's (fetches.arrival_json rm): a restart
 *               carries on where it was, and a removal done twice deletes nothing more. Never removed: an import that
 *               failed, was cancelled, stopped short or is still being tried; a game whose copy is not there or does not
 *               check out; a download that was never taken from the folder (one imported from the seedbox instead, an import
 *               by hand from elsewhere). A copy that reaches the folder after its import from the seedbox (the admin's choice
 *               in the Queue) is looked for there for 72 h, and removed the same way only when it is exactly what its client
 *               listed — every file at its size, nothing else in its own folder, nothing being written, unchanged a minute
 *               later — otherwise it is left. ludarr's own removal is never a loss: nothing is called lost, awaited again or
 *               downloaded again for it. What ludarr left there before (downloads imported before this, or whose import
 *               failed, what nothing showed to be its own, what came into its folder after its removal) is listed by
 *               listLeftovers — never a place of its name with nothing that says what its files were — and removed by
 *               removeLeftovers only with the admin's OK, exactly as listed (a dry run unless told to go).
 *   the bounds  nothing there 30 min after the client finished: a health warning (is the sync running?); not all there
 *               after 2 h: a warning; after 6 h an error, a notification, and the Queue asks: import it from the seedbox
 *               instead (the admin's fallback, through the client's remote path mapping, with the seedbox's waits — while
 *               the seedbox still has it), import what has arrived (usenet), download it again, or keep waiting (asked again
 *               6 h on). 72 h on, the search stops with the download kept and nothing blocklisted. Its client deleted under
 *               Settings: its files are let go.
 *   lost        a file seen there and gone before the import, a torrent's file that never showed while the rest did and is
 *               gone from its client's folder on the seedbox (taken before ludarr looked), or a whole download that never
 *               showed and is no longer where its client keeps it on the seedbox (its folder there gone, or emptied by the
 *               sync's move): a usenet download is downloaded again by itself (the same release, no try spent, nothing
 *               blocklisted; tried on the seedbox's ladder, its NZB kept between tries; asked after 6 h); a torrent, or a
 *               usenet download lost twice, asks: import it from the seedbox (while a torrent still seeds there) or download
 *               it again (a torrent: its copy on the seedbox is deleted first, once the new download is in hand).
 *
 * Nothing in the finished-downloads folder is ever moved, and nothing in it is deleted but exactly what ludarr took for a
 * download it imported and its client's own list shows to be that download's (above) — and, with the admin's OK, what the
 * leftovers list showed. Only ludarr's own downloads are looked at or touched (the folder is shared: TV, films). And
 * nothing here is a verdict on the copy: an arrival never fails its download, so nothing is blocklisted and no other copy is
 * grabbed for it.
 * Players read "Downloading", without a rate or an estimate. The admin's words never name the folder's path or a seedbox
 * path: it is "the finished-downloads folder" (downloads/finished).
 */
import { readFileSync, watch as fsWatch } from "node:fs";
import { access, lstat, readdir, realpath, rmdir, stat, unlink, utimes, constants as FS } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { db, stmts, type FetchRow, type GameRow, type JobRow, type PackageRow } from "./db";
import { logger } from "./log";
import * as registry from "./plugins/registry";
import type { DownloadClient, Payload, Release } from "./plugins/types";
import type { SbClient, SbItem } from "./seedbox-items";
import { record } from "./library/history";
import { ASK_AFTER_SEC, clientMappings, FINISHED_FOLDER as HERE, inWords, ladderSec, probeRoot, rmdeps, rootState, STOP_AFTER_SEC, tail, WARN_AFTER_SEC, type Mapped, type RemoteHealth } from "./remote";
import { clientTrouble, codeOf, messageOf } from "./transport";
import { cfgBool, configSource } from "./config";
import { ARRIVALS_KEY, arrivalsDir, arrivalsSetting, overArrivals } from "./synced";

const log = logger("Arrivals");

/* ─────────── the state ─────────── */

/** a file a download holds: its path inside the folder it lands in (posix: `<name>/<path>`, or `<name>` alone; usenet: inside
 *  NZBGet's folder) and its size */
export interface ArrivalFile { p: string; s: number }
/** what the Queue asks the admin: it is late, it was lost, it cannot be told apart */
export type AskWhy = "late" | "lost" | "ambiguous";
/** the hold on a download's files: since when, the last refresh (ms), when it was let go (ms), a refresh the folder refused
 *  (its code), files gone at a refresh, and files whose date could not be set for another reason (the code, since, how many) */
export interface Hold { since: number; at: number; released: number | null; denied: string | null; gone: number; goneAt: number | null; failed: { code: string; at: number; n: number } | null }
export interface Arrival {
  /** when it began to be awaited: when its client finished it (unix s; when ludarr noticed, if the client did not say) */
  since: number;
  /** the client was asked once what it knows of it (its name, finish time) */
  told: boolean;
  viewAt: number | null;
  /** the name it is found by (src/synced.ts: never a path): a torrent's, as its client names it; a usenet download's
   *  folder's, the last folder of NZBGet's FinalDir/DestDir — and NZBGet's NZB name when that is another (either is looked for) */
  name: string;
  alt: string | null;
  /** how many files it waits for, and who listed them (the list itself is kept once, in fetches.files_json: this state is
   *  written at every look): rTorrent, the .torrent, or NZBGet's folder read through the remote path mapping */
  nfiles: number;
  from: "client" | "grab" | "seedbox" | null;
  /** usenet: what NZBGet downloaded (bytes; null: not known yet, 0: it did not say) */
  want: number | null;
  /** what it waits for, in bytes (a torrent: its files; usenet: what NZBGet downloaded, else its size) */
  total: number;
  /** where it is here: a torrent's <container>/<name>, a usenet download's folder; and a torrent's container */
  path: string | null;
  container: string | null;
  /** a torrent its client has not listed yet: its folder of its exact name here, held meanwhile */
  guess: string | null;
  /** when anything of it first showed here (unix s), and what is here now */
  seenAt: number | null;
  here: number;
  bytes: number;
  /** usenet: its names and sizes at the last look (a digest), and the seconds it has stayed so with nothing written anywhere in
   *  the folder */
  sig: string | null;
  quiet: number;
  /** a torrent: when every file was first seen whole (unix s), and their sizes and dates then (a digest) */
  wholeAt: number | null;
  wholeSig: string | null;
  /** the seedbox's side through the remote path mapping: when it was last looked at (unix s), and how many files of it are
   *  still there (0: the sync carried all of it; null: it could not be told) */
  side: { at: number; left: number | null } | null;
  /** usenet: NZBGet's folder was first read on the seedbox while nothing of it was here, so what it held is all of it — a file
   *  in its folder that is not on that list is someone else's (null: not read yet; false: some of it had come already) */
  listAll: boolean | null;
  /** what it was when it was taken: the import must find all of it */
  got: { files: number; bytes: number } | null;
  /** what it took when it was taken (or a copy that came after its import from the seedbox): when, how, where, how many files
   *  and bytes — the list itself, file by file, is kept once in fetches.took_json, and is this taking's only while they match */
  took: { at: number; how: TookHow; path: string; files: number; bytes: number } | null;
  /** its removal from the finished-downloads folder once it is imported (null: not looked at yet) */
  rm: Removal | null;
  /** what it waits on now, in words (the request's stage) */
  words: string;
  /** why it cannot go on by itself (nothing is touched meanwhile), in words */
  trouble: "ambiguous" | null;
  troubleWords: string | null;
  /** the question in the Queue, and when it comes again after "keep waiting" (unix s) */
  ask: { at: number; why: AskWhy } | null;
  askAgainAt: number | null;
  /** it left the finished-downloads folder before its import; how many times it was downloaded again since; the tries of that
   *  since the loss, and when the next one is; a torrent's copy erased from its client for the download again */
  lost: { at: number; why: string } | null;
  regrabs: number;
  tries: number;
  againAt: number | null;
  erased: boolean;
  /** the admin chose to import it from the seedbox instead (the remote path mapping) */
  via: "seedbox" | null;
  /** 72 h without it: stopped (Retry looks again) */
  stopped: boolean;
  /** its download client was deleted under Settings: nothing more can arrive for it */
  orphan: boolean;
  hold: Hold | null;
  /** the last look at what is left of it on the seedbox's side (unix s), and the last ask of the client for its files */
  mirrorAt: number | null;
  filesAt: number | null;
}

/** how a download's files were taken from the finished-downloads folder: it arrived and was taken by itself ("arrived"), the
 *  admin had it imported as it was ("now"), a copy that reached the folder after its import from the seedbox ("late"), or a
 *  download of ludarr's the admin approved for removal there ("leftover": removeLeftovers) */
export type TookHow = "arrived" | "now" | "late" | "leftover";

/**
 * Exactly what was taken (fetches.took_json, written once, when it was taken): the finished-downloads folder then (`root`),
 * where the download sat in it (`path`: its folder, or its single file), the folder that is all its own (`own`: removed once
 * nothing else is in it — null when its single file sits straight in the folder or in a category's), and each of its files
 * as [its path inside `path` (posix; "" for the single file itself), its size]: in `files` those its client's own list has at
 * that size (a torrent's files; what NZBGet's folder held on the seedbox) — the only files ludarr ever deletes there by itself
 * — and in `unproven` the rest it took with them (its import read them too), which nothing shows to be its own: they stay, and
 * the leftovers list offers them for the admin's OK.
 */
export interface Taken { v: 1; at: number; how: TookHow; root: string; path: string; own: string | null; files: [string, number][]; unproven?: [string, number][] }

/** a download's removal from the finished-downloads folder once it is imported (Arrival.rm) */
export interface Removal {
  /** due: removed at its next look (a failure is tried again on the ladder); waiting: it may go, but something holds it up
   *  for now (a job reads it, another download of its name is there, the game's copy could not be read); done: removed;
   *  left: nothing of it is deleted (`why`) */
  state: "due" | "waiting" | "done" | "left";
  why: string | null;
  /** the looks that failed, since when (unix s), the last failure's code, and when it is looked at next (unix s) */
  tries: number; since: number | null; code: string | null; nextAt: number | null;
  /** since when it has been waiting (unix s; null: it is not) — a day of it is said in the health list */
  waitAt?: number | null;
  /** removed so far (files, bytes); at the last look: files already gone, files that changed since it was taken (they
   *  stay), folders that stay (something else is in them) — and what stays, named (paths inside the finished-downloads
   *  folder, a few): its files that changed, what was never part of it */
  removed: number; bytes: number; gone: number; changed: number; kept: number;
  changedAt: string[]; others: string[];
  /** the look that found files already gone without ludarr having removed any (unix s): the next one confirms it */
  confirm: number | null;
  /** when it was done, or left (unix s) */
  at: number | null;
}

/** fields a state written before they existed lacks */
const DEFAULTS: Partial<Arrival> = { told: true, viewAt: null, alt: null, guess: null, wholeSig: null, side: null, listAll: null, got: null, took: null, rm: null, tries: 0, erased: false, orphan: false };
export const arrivalOf = (f: Pick<FetchRow, "arrival_json"> | null | undefined): Arrival | null => {
  try {
    const a = f?.arrival_json ? JSON.parse(f.arrival_json) : null;
    if (!a || typeof a.since !== "number") return null;
    // (missing fields appended: a state read and written back unchanged is the same text, so an unchanged look writes nothing)
    const out = { ...a } as Arrival;
    for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in out)) (out as unknown as Record<string, unknown>)[k] = v;
    if (out.hold && out.hold.failed === undefined) out.hold.failed = null;
    return out;
  } catch { return null; }
};
/** what an earlier arrival left for the next one (the times it was downloaded again) */
const priorOf = (f: Pick<FetchRow, "arrival_json">): { regrabs: number } => {
  try { const a = f.arrival_json ? JSON.parse(f.arrival_json) : null; return { regrabs: Number(a?.regrabs) || 0 }; } catch { return { regrabs: 0 }; }
};

const sec = () => Math.floor(adeps.now() / 1000);
const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
const clock = (unixSec: number) => { const d = new Date(unixSec * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const gone = (e: unknown) => codeOf(e) === "ENOENT" || codeOf(e) === "ENOTDIR";
const posix = (p: string) => p.split(sep).join("/");

/** a held file's date is refreshed this often (the cleanup's hour leaves 50 min to spare); one older than HELD_OLD_MS while
 *  held says the hold does not refresh */
export const REFRESH_MS = 10 * 60_000, HELD_OLD_MS = 30 * 60_000;
/** a held file's date is looked at this often between refreshes: one the sync set back (a second run renaming its copy over
 *  it, a date put right) is held again */
export const HOLD_CHECK_MS = 60_000;
/** an rclone part file unchanged this long is a leftover of a run that died: it says nothing */
export const DEAD_PART_MS = 30 * 60_000;
/** nothing here this long after its client finished: is the sync running? */
export const NOTHING_WARN_SEC = 30 * 60;
/** a torrent is whole when two looks this far apart found every file at the same size and date */
export const WHOLE_SEC = 60;
/** a usenet download without the seedbox's word must bring at least this share of what NZBGet downloaded */
export const USENET_SHARE = 0.9;
/** a download held this long after it arrived is said in the health list, with what its search waits for */
export const HELD_LONG_SEC = 24 * 3600;
/** the cleanup's hour and a few minutes: a download that should long be here, of which nothing is, was taken while
 *  ludarr was not looking (when nothing is left on the seedbox's side either) */
const CLEANUP_SEC = 65 * 60;
/** the seedbox's side is looked at this often */
const SIDE_SEC = 60;
/** a usenet download without the seedbox's word must stay unchanged this long, while nothing else is synced: two runs of a
 *  sync every 5 minutes (a download split across two runs is never taken between them) */
export const QUIET_SEC = 10 * 60;
/** the walk of the whole finished-downloads folder for a part file being written: at most this many entries and this long */
const ANYWHERE_ENTRIES = 200_000, ANYWHERE_MS = 10_000;

/** swappable in tests: the clock, the clients, what they say, the payloads, and the file system's dates */
export const adeps = {
  now: () => Date.now(),
  log: (line: string) => log.info(line),
  clientById: (id: number): DownloadClient | null => registry.downloadClientById(id),
  /** what the download's client says of it now (src/fetch.ts installs the real one into src/remote.ts) */
  view: (f: FetchRow) => rmdeps.clientView(f),
  /** the release's payload again, from the indexer that found it (a magnet when that is all it had) */
  payload: async (f: FetchRow): Promise<Payload> => {
    let rel: Release | null = null;
    try { rel = f.release_json ? JSON.parse(f.release_json) : null; } catch { /* none */ }
    if (!rel) throw new Error("the release it came from is not recorded");
    const ix = registry.indexerById(f.indexer_instance_id ?? rel.instanceId);
    if (ix) return ix.download(rel);
    if (rel.magnetUrl) return { kind: "magnet", uri: rel.magnetUrl };
    throw new Error("the indexer that found it is gone");
  },
  /** a file's dates set to `at` (the hold) */
  touch: (p: string, at: Date) => utimes(p, at, at),
  /** the removal once imported: a file deleted, an empty folder removed (never anything else), where a folder really is */
  unlink: (p: string): Promise<void> => unlink(p),
  rmdir: (p: string): Promise<void> => rmdir(p),
  realpath: (p: string): Promise<string> => realpath(p),
  /** the files under a folder on the seedbox's mount (relative paths and sizes; a download of a single file: that file):
   *  "absent" when it is not there, null when it could not be read (a timeout, a failed read, too many entries) */
  sideList: (dir: string): Promise<Map<string, number> | "absent" | null> => listSide(dir),
  /** the mount table (an rclone mount of the seedbox is never the finished-downloads folder) */
  mountInfo: (): string => { try { return readFileSync("/proc/self/mountinfo", "utf8"); } catch { return ""; } },
  /** a watch on a folder that tells what changed (a path inside it, when the system says) — null: none (the looks still come
   *  every second) */
  watch: (dir: string, changed: (name: string | null) => void): { close(): void } | null => {
    const on = (_e: string, name: string | Buffer | null) => changed(name == null ? null : String(name));
    try { return fsWatch(dir, { recursive: true }, on); }
    catch { try { return fsWatch(dir, on); } catch { return null; } }
  },
};

/** a folder on the seedbox's mount, walked once with a bound (a single file is listed as itself) */
async function listSide(dir: string): Promise<Map<string, number> | "absent" | null> {
  const out = new Map<string, number>();
  let seen = 0, failed = false;
  const walk = async (d: string, rel: string, top: boolean): Promise<"absent" | void> => {
    if (failed) return;
    let entries: Dirent[];
    try { entries = await readdir(d, { withFileTypes: true }); }
    catch (e) {
      if (top && codeOf(e) === "ENOTDIR") {
        // a download of a single file (a torrent's): the file is all of it
        let st: Awaited<ReturnType<typeof stat>> | null = null;
        try { st = await stat(d); } catch (x) { if (!gone(x)) { failed = true; return; } }
        if (st?.isFile()) { out.set(basename(d), st.size); return; }
      }
      if (top && gone(e)) return "absent";
      if (!gone(e)) failed = true;
      return;
    }
    for (const e of entries) {
      if (failed) return;
      if (++seen > 50_000) { failed = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== "_unpack") await walk(join(d, e.name), r, false); continue; }
      const st = await stat(join(d, e.name)).catch(x => { if (!gone(x)) failed = true; return null; });
      if (st?.isFile()) out.set(r, st.size);
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const r = await Promise.race([walk(dir, "", true).then(x => x ?? "done"), new Promise<"slow">(res => { timer = setTimeout(() => res("slow"), 30_000); })]);
  if (timer) clearTimeout(timer);
  if (r === "absent") return "absent";
  return r === "done" && !failed ? out : null;
}

/** the arrival's state written over what the row held when it was read (`raw`): never over a newer state (the admin's
 *  answer, a loss the import found) — false when the row had changed meanwhile */
const putIf = (id: number, raw: string | null, a: Arrival): boolean => stmts.setFetchArrivalIf.run(JSON.stringify(a), id, raw).changes > 0;
/** the arrival's state written as it is (the admin's answer, the request's word) */
const save = (id: number, a: Arrival) => stmts.setFetchArrival.run(JSON.stringify(a), id);

/* ─────────── what ludarr keeps in memory between looks ─────────── */

interface Mem {
  /** the files whose date was set (absolute paths), and when ludarr last set each (ms): a date older than that was set back */
  touched: Set<string>;
  heldAt: Map<string, number>;
  /** files found whole at the last look (relative paths): looked at again by name only, until the double look */
  whole: Set<string>;
  lookAt: number;
  nextAt: number;
  /** a part file was being written in its folders at the last look */
  writing: boolean;
  /** the files it waits for (read once from fetches.files_json), and their tree */
  files: ArrivalFile[] | null;
  tree: { of: ArrivalFile[]; root: Node } | null;
  /** usenet: the sizes of its files at the last look (a look stats only new names; all of them every 30 s) */
  sizes: Map<string, number> | null;
  sizesAt: number;
  /** what a change event in the finished-downloads folder is matched against: where its files land (a torrent: the folders
   *  that may hold it and its files there — before it was found, any folder at the top of `root` too; else the one folder that
   *  is all its own — before a usenet download's was found, any folder of one of its `names`, two levels deep in `root`) */
  expect: { containers: string[]; files: Map<string, number> | null; dir: string | null; root: string | null; names: string[] | null } | null;
  /** the payload of a download again, kept between its tries */
  payload: Payload | null;
  /** the last look at the held files' dates (ms), and the held files found gone (said once) */
  checkAt: number;
  went: Set<string>;
}
const mem = new Map<number, Mem>();
const memOf = (id: number): Mem => {
  let m = mem.get(id);
  if (!m) { m = { touched: new Set(), heldAt: new Map(), whole: new Set(), lookAt: 0, nextAt: 0, writing: false, files: null, tree: null, sizes: null, sizesAt: 0, expect: null, payload: null, checkAt: 0, went: new Set() }; mem.set(id, m); }
  return m;
};

/** the files an arrival waits for, once they were settled (from memory, else fetches.files_json); null: not yet */
function filesOf(f: Pick<FetchRow, "id" | "files_json">, a: Arrival): ArrivalFile[] | null {
  const m = memOf(f.id);
  if (m.files) return m.files;
  if (!a.from || !f.files_json) return null;
  try { const l = JSON.parse(f.files_json) as ArrivalFile[]; if (Array.isArray(l) && l.length) return (m.files = l); } catch { /* unreadable: asked again */ }
  return null;
}
/** tests (and a restart, in effect): forget what the looks kept in memory */
export function forgetArrivals(): void {
  mem.clear(); anywhere.clear(); for (const w of watchers.values()) w?.close(); watchers.clear();
  lastWake = 0; wakes = 0; if (wakeTimer) clearTimeout(wakeTimer); wakeTimer = null;
  lateSeen.clear(); lateAt = 0;
}

/* ─────────── begun by the download worker (src/fetch.ts) ─────────── */

/** a new arrival: its name is the last part of where its client keeps it (a torrent's name, NZBGet's folder's) — only ever
 *  that name, never the path, is looked for here */
function fresh(f: FetchRow, now: number): Arrival {
  return {
    since: now, told: false, viewAt: null, name: basename(String(f.seedbox_path ?? f.title).replace(/[\\/]+$/, "")), alt: null, nfiles: 0, from: null, want: null, total: 0,
    path: null, container: null, guess: null, seenAt: null, here: 0, bytes: 0, sig: null, quiet: 0, wholeAt: null, wholeSig: null, side: null, listAll: null, got: null, took: null, rm: null,
    words: `waiting for it to arrive in ${HERE}`, trouble: null, troubleWords: null, ask: null, askAgainAt: null, lost: null,
    regrabs: priorOf(f).regrabs, tries: 0, againAt: null, erased: false, via: null, stopped: false, orphan: false, hold: null, mirrorAt: null, filesAt: null,
  };
}

/** its client finished it while the finished-downloads folder is on: it is awaited there from now (never pulled) */
export function beginArrival(f: FetchRow): void {
  const a = fresh(f, sec());
  stmts.setFetchArriving.run(0, null, JSON.stringify(a), f.id);
  mem.delete(f.id);
  adeps.log(`#${f.id} done on the seedbox: waiting for ${a.name} in ${HERE} (it is not transferred)`);
}

/** the arrival a download carries on with when it reaches its import again: an import from the seedbox chosen in the Queue is
 *  transferred as before */
export const fromSeedbox = (f: Pick<FetchRow, "arrival_json">): boolean => arrivalOf(f)?.via === "seedbox";

/** what a download taken from the finished-downloads folder weighed when it was taken (src/process/runner.ts: its import must
 *  find all of it, and no more) — null when this input is not that download */
export function arrivedWeight(f: Pick<FetchRow, "arrival_json"> | null | undefined, input: string): { files: number; bytes: number } | null {
  const a = arrivalOf(f);
  return a?.got && a.path && resolve(a.path) === resolve(input) ? a.got : null;
}

/** the client's remote path mapping (the seedbox's mount here: the admin's fallback, and the seedbox's side of what the sync
 *  carries): null without one */
const mountOf = (f: Pick<FetchRow, "client_instance_id">): Mapped | null => rmdeps.roots().find(m => m.instanceId === f.client_instance_id && m.kind !== "synced") ?? null;
/** where a path on the seedbox is on the client's mount (null: not under it) */
function onMount(m: Pick<Mapped, "from" | "to">, seedboxPath: string | null | undefined): string | null {
  if (!seedboxPath || !m.from) return null;
  const p = seedboxPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === m.from) return m.to;
  return p.startsWith(m.from + "/") ? join(m.to, ...p.slice(m.from.length + 1).split("/")) : null;
}

const NAMES: Record<string, string> = { rtorrent: "rTorrent", nzbget: "NZBGet" };
const nameOf = (f: Pick<FetchRow, "client">) => NAMES[f.client] ?? f.client;

/** what the download's client says of it, asked once it answers (usenet: until it says what it downloaded): its name (a
 *  torrent's item name; NZBGet's NZB name, looked for beside its folder's), what NZBGet downloaded, and when it finished —
 *  the arrival's clock starts there when that is earlier */
async function askClient(f: FetchRow, a: Arrival, now: number): Promise<void> {
  const need = !a.told || (f.protocol === "usenet" && a.want == null);
  if (!need || (a.viewAt != null && now - a.viewAt < 60)) return;
  a.viewAt = now;
  const v = await adeps.view(f).catch(() => null);
  if (!v?.answered) return;
  const it = (v as { item?: SbItem | null }).item ?? null;
  if (!a.told) {
    a.told = true;
    const name = it?.name && !/[\\/]/.test(it.name) ? it.name : "";
    if (name && f.protocol === "torrent") a.name = name;
    else if (name && name !== a.name) a.alt = name;
    const fin = Number(it?.finishedAt) || 0;
    if (fin > 0 && fin < a.since) a.since = fin;
  }
  if (f.protocol === "usenet" && a.want == null) {
    a.want = it?.downloadedBytes ?? 0;
    a.total = a.want || it?.sizeBytes || f.size || 0;
  }
}

/** an earlier download (another post, another torrent) of the same name whose files may still be in this folder: nothing empties
 *  the finished-downloads folder but ludarr's own removal, so what one left there (its import failed, it was lost, it was
 *  taken before ludarr wrote down what it took) stays until it is gone — however long ago that was */
const earlierQ = db.query("SELECT id, title, guid, info_hash, protocol, arrival_json FROM fetches WHERE id != ? AND arrival_json IS NOT NULL AND json_valid(arrival_json) AND json_extract(arrival_json, '$.path') IS NOT NULL ORDER BY id DESC LIMIT 300");
/** (its lists, read only for one that lay there: they can be long) */
const listsQ = db.query("SELECT took_json, files_json FROM fetches WHERE id=?");
type EarlierRow = Pick<FetchRow, "id" | "title" | "guid" | "info_hash" | "protocol" | "arrival_json">;
async function earlierAt(f: FetchRow, path: string): Promise<{ id: number; title: string } | null> {
  for (const r of earlierQ.all(f.id) as EarlierRow[]) {
    if ((r.guid && r.guid === f.guid) || (r.info_hash && r.info_hash === f.info_hash)) continue;      // the same post, the same torrent
    const o = arrivalOf(r);
    if (!o?.path || !overlaps(o.path, path)) continue;
    const lists = listsQ.get(r.id) as Pick<FetchRow, "took_json" | "files_json"> | undefined;
    if (await mayHaveLeft({ ...r, ...lists }, o)) return { id: r.id, title: r.title };
  }
  return null;
}
/** may an earlier download still have files where it lay: one of what it took there (its last taking, or the leftovers the
 *  admin approved), else of what its client listed, still at its path and size — or nothing says what its files were */
async function mayHaveLeft(r: EarlierRow & Pick<FetchRow, "took_json" | "files_json">, o: Arrival): Promise<boolean> {
  const t = parseTaken(r.took_json);
  let at: [string, number][];
  if (t) at = [...t.files, ...(t.unproven ?? [])].map(([rel, s]) => [rel ? join(t.path, ...rel.split("/")) : t.path, s]);
  else {
    const l = clientList(r, o, o.name);
    if (!l?.length) return true;
    // a torrent's list is `<name>/<p>` beside where it lies; NZBGet's folder's is inside it (or one deeper, nested in a folder of
    // its name)
    const base = r.protocol === "torrent" ? dirname(o.path!) : o.path!;
    at = l.flatMap(x => {
      const segs = x.p.split("/");
      return r.protocol === "torrent" ? [[join(base, ...segs), x.s] as [string, number]] : [[join(base, ...segs), x.s] as [string, number], ...namesOf(o).map(n => [join(base, n, ...segs), x.s] as [string, number])];
    });
  }
  for (const [p, s] of at.slice(0, 20_000)) {
    const st = await lstat(p).catch(() => null);
    if (st?.isFile() && st.size === s) return true;
  }
  return false;
}

/** it cannot be told apart from something else there: nothing is touched, said, and asked (unless put off by "keep waiting") */
function ambiguous(a: Arrival, now: number, why: string): void {
  a.trouble = "ambiguous";
  a.troubleWords = `${why}: it cannot be told apart, so nothing there is touched`;
  a.words = `in ${HERE}, but ${a.troubleWords}`;
  if (!a.ask && (a.askAgainAt == null || now >= a.askAgainAt)) a.ask = { at: now, why: "ambiguous" };
}
function clearTrouble(a: Arrival, why: "ambiguous"): void {
  if (a.trouble !== why) return;
  a.trouble = null; a.troubleWords = null;
  if (a.ask?.why === why) a.ask = null;
}

/* ─────────── looking for a torrent ─────────── */

interface Node { files: Map<string, number>; dirs: Map<string, Node> }
function treeOf(files: ArrivalFile[]): Node {
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const f of files) {
    const parts = f.p.split("/").filter(Boolean);
    if (!parts.length) continue;
    let n = root;
    for (const d of parts.slice(0, -1)) { let x = n.dirs.get(d); if (!x) { x = { files: new Map(), dirs: new Map() }; n.dirs.set(d, x); } n = x; }
    n.files.set(parts[parts.length - 1], f.s);
  }
  return root;
}

/** what one candidate folder holds of a torrent: its files there at their exact size, files of its names at another size,
 *  rclone parts still being written beside them, and anything else its own folders hold (relative paths) */
interface Look { at: string; found: Map<string, number>; wrong: { p: string; s: number }[]; parts: string[]; others: string[]; dirs: number }

/** a part file that is someone's file still being written (its own one, in a folder others share: named like one of these
 *  files — rclone cuts long names, so the start of the name is what is compared) — not one left for dead (unchanged 30 min) */
async function livePart(dir: string, name: string, own: string[] | null, nowMs: number): Promise<boolean> {
  if (!name.endsWith(".partial")) return false;
  if (own && !own.some(n => name.startsWith(n.slice(0, 40)))) return false;
  const st = await stat(join(dir, name)).catch(() => null);
  return !!st && nowMs - st.mtimeMs < DEAD_PART_MS;
}

async function lookIn(base: string, tree: Node, shared: boolean, known: Set<string> | null, nowMs: number): Promise<Look> {
  const out: Look = { at: base, found: new Map(), wrong: [], parts: [], others: [], dirs: 0 };
  const walk = async (dir: string, node: Node, rel: string, top: boolean): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (gone(e)) return; throw e; }
    out.dirs++;
    const byName = new Map(entries.map(e => [e.name, e]));
    for (const [name, size] of node.files) {
      const e = byName.get(name);
      if (!e || e.isDirectory()) continue;
      const r = rel ? `${rel}/${name}` : name;
      if (known?.has(r)) { out.found.set(r, size); continue; }
      let st: Awaited<ReturnType<typeof stat>>;
      try { st = await stat(join(dir, name)); } catch (x) { if (gone(x)) continue; throw x; }
      if (!st.isFile()) continue;
      if (st.size === size) out.found.set(r, size); else out.wrong.push({ p: r, s: st.size });
    }
    // its own folders (every folder of its tree, and a candidate of its own name) hold its files and folders and the parts of
    // them being written — anything else there is another download's; a folder others share (the finished-downloads folder
    // itself, a category's) may hold anything
    const own = !top || !shared;
    const names = [...node.files.keys()];
    for (const e of entries) {
      if (node.files.has(e.name) || node.dirs.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.endsWith(".partial")) {
        if (await livePart(dir, e.name, top && shared ? names : null, nowMs)) out.parts.push(join(dir, e.name));
        if (own && !names.some(n => e.name.startsWith(n.slice(0, 40)))) out.others.push(r);
        continue;
      }
      if (own) out.others.push(r);
    }
    for (const [name, sub] of node.dirs) { const e = byName.get(name); if (e?.isDirectory()) await walk(join(dir, name), sub, rel ? `${rel}/${name}` : name, false); }
  };
  await walk(base, tree, "", true);
  return out;
}

/* ─────────── where a name is: two levels deep, nothing else ─────────── */

/** the folders at the top of the finished-downloads folder (none when it cannot be read: the look says why) */
async function topFolders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(e => { if (gone(e)) return [] as Dirent[]; throw e; });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}
const there = (p: string) => stat(p).then(() => true, () => false);
const isDir = (p: string) => stat(p).then(s => s.isDirectory(), () => false);

/** the folders a torrent may sit in (its entry, a folder or its single file, is `<that folder>/<name>`), each with whether others
 *  share it: the finished-downloads folder itself (<folder>/<name>), a folder there of its own name (the nested shape
 *  <folder>/<name>/<name>, a single file in <folder>/<name>/), and any other folder there that holds an entry of its name
 *  (<folder>/<category>/<name>) — two levels deep, never deeper, and found by its name alone */
async function containersOf(a: Pick<Arrival, "name" | "alt">, root: string): Promise<{ at: string; shared: boolean }[]> {
  const out = [{ at: root, shared: true }];
  if (!namesOf(a).includes(a.name)) return out;
  for (const d of await topFolders(root)) {
    const at = join(root, d);
    if (d === a.name) out.push({ at, shared: false });
    else if (await there(join(at, a.name))) out.push({ at, shared: true });
  }
  return out;
}

/** the folders named like a download, two levels deep: <folder>/<name> and <folder>/<any folder>/<name> (a category's: ahoy/
 *  for ludarr's usenet downloads). A folder of its name at the top is that one folder, never looked into for another (the
 *  nested shape <name>/<name> is it, whole) */
async function foldersNamed(root: string, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of await topFolders(root)) {
    const at = join(root, d);
    if (names.includes(d)) { out.push(at); continue; }
    for (const n of names) if (await isDir(join(at, n))) out.push(join(at, n));
  }
  return out;
}
/** the names a download is looked for by */
const namesOf = (a: Pick<Arrival, "name" | "alt">): string[] => [...new Set([a.name, a.alt].filter((n): n is string => !!n && !/[\\/]/.test(n) && n !== "." && n !== ".."))];
/** a place in the finished-downloads folder, in words: its path inside it (never the folder's own path) */
const inFolder = (root: string, p: string) => posix(relative(root, p)) || HERE;

/** the client's (or the .torrent's) list of a torrent's files, as paths inside the folder it lands in */
async function torrentFiles(f: FetchRow, a: Arrival, client: DownloadClient, now: number): Promise<ArrivalFile[] | null> {
  if (client.files && f.client_id && (a.filesAt == null || now - a.filesAt >= 60)) {
    a.filesAt = now;
    try {
      const list = await client.files({ client: f.client as SbClient, clientId: f.client_id });
      if (list.length) {
        a.from = "client";
        return f.seedbox_is_dir ? list.map(x => ({ p: `${a.name}/${x.path.replace(/\\/g, "/").replace(/^\/+/, "")}`, s: x.size })) : [{ p: a.name, s: list[0].size }];
      }
    } catch (e) { adeps.log(`#${f.id} ${nameOf(f)} did not list the torrent's files (${messageOf(e).slice(0, 160)}): asking again in a minute`); }
  }
  try {
    const own = f.files_json ? (JSON.parse(f.files_json) as ArrivalFile[]) : null;
    if (Array.isArray(own) && own.length && own.every(x => typeof x.p === "string" && Number.isFinite(x.s))) {
      a.from = "grab";
      // the .torrent's own name and the one the client gave it (they are the same unless the client renamed it)
      const top = own[0].p.split("/")[0];
      return top === a.name ? own : own.map(x => ({ p: a.name + x.p.slice(top.length), s: x.s }));
    }
  } catch { /* none kept */ }
  return null;
}

/** the sizes and dates of a torrent's files in its container (a date ludarr itself set counts as the same date) — null when
 *  one is not there */
async function sigOf(container: string, files: ArrivalFile[], m: Mem): Promise<string | null> {
  const parts: string[] = [];
  for (const x of files) {
    const p = join(container, ...x.p.split("/"));
    const st = await stat(p).catch(() => null);
    if (!st?.isFile()) return null;
    const held = m.heldAt.get(p);
    parts.push(`${x.p}:${st.size}:${held != null && Math.abs(st.mtimeMs - held) < 2 ? "h" : Math.round(st.mtimeMs)}`);
  }
  return Bun.hash(parts.join("|")).toString(36);
}

/** files of a torrent that never showed here while the rest did: carried by the sync and taken by the folder's cleanup before
 *  ludarr looked ("carried") when none of them is left where its client keeps it on the seedbox, read through the client's
 *  remote path mapping — believed only while the client's own folder for it is there on that mount (the sync moves files out
 *  of it and leaves the folder; without it, what is not there says nothing); "there" while one still is; null when that cannot
 *  be told (no mount, the client's folder not there, the mount does not answer) */
async function missingOnSeedbox(f: FetchRow, a: Arrival, missing: ArrivalFile[], now: number): Promise<"carried" | "there" | null> {
  const mount = mountOf(f);
  if (!mount || !missing.length || !f.seedbox_path) return null;
  if (a.side && now - a.side.at < SIDE_SEC) return a.side.left == null ? null : a.side.left > 0 ? "there" : "carried";
  // the client's path is the torrent's own folder (or its single file): its files are `<name>/<path>` beside it
  const own = f.seedbox_path.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = own.replace(/\/[^/]*$/, "");
  const ownHere = onMount(mount, own);
  let left: number | null = ownHere && (await rmdeps.stat(ownHere)) === "present" ? 0 : null;
  for (const x of left === 0 ? missing.slice(0, 20) : []) {
    const at = onMount(mount, `${base}/${x.p}`);
    if (!at) { left = null; break; }
    const s = await rmdeps.stat(at);
    if (s === "present") { left = (left ?? 0) + 1; break; }
    if (typeof s === "object") { left = null; break; }
  }
  // nothing of them there: believed only of a mount that answers now
  if (left === 0 && (await probeRoot(mount.to)).ok !== true) left = null;
  a.side = { at: now, left };
  return left == null ? null : left > 0 ? "there" : "carried";
}

/** a torrent its client has not listed yet: the one folder of its exact name here (no earlier download's), held meanwhile —
 *  none while two could be it */
async function guessHold(f: FetchRow, a: Arrival, root: string, now: number, m: Mem): Promise<void> {
  const at = namesOf(a).includes(a.name) ? await foldersNamed(root, [a.name]) : [];
  a.guess = at.length === 1 && !(await earlierAt(f, at[0])) ? at[0] : null;
  m.expect = a.guess ? { containers: [], files: null, dir: a.guess, root: null, names: null } : null;
  if (!a.guess) return;
  const w = await walkItem(a.guess, adeps.now());
  if (!w?.files.size) return;
  a.seenAt ??= now;
  await holdNew(f, a, [...w.files.keys()].map(p => join(a.guess!, ...p.split("/"))));
}

/** a torrent: found by its name where it landed, its new files held, whole when every file is at its size and date twice a
 *  minute apart */
async function lookTorrent(f: FetchRow, a: Arrival, root: string, client: DownloadClient, now: number, m: Mem): Promise<"done" | "lost" | null> {
  let files = filesOf(f, a);
  if (!files) {
    const got = await torrentFiles(f, a, client, now);
    if (!got) {
      a.from = null;
      await guessHold(f, a, root, now, m);
      a.words = `on its way to ${HERE} — waiting for ${nameOf(f)} to list the torrent's files${a.guess ? ` (what is in ${inFolder(root, a.guess)} is kept from the cleanup meanwhile)` : ""}`;
      return null;
    }
    stmts.setFetchFiles.run(JSON.stringify(got), f.id);           // kept once: the state below is written at every look
    m.files = files = got;
    a.nfiles = got.length;
    a.total = got.reduce((s, x) => s + x.s, 0);
  }
  a.guess = null;
  if (!m.tree || m.tree.of !== files) m.tree = { of: files, root: treeOf(files) };
  const nowMs = adeps.now();
  const looks: (Look & { shared: boolean })[] = [];
  const cands = await containersOf(a, root);
  const wanted = new Map(files.map(x => [x.p, x.s]));
  m.expect = { containers: a.container ? [a.container] : cands.map(c => c.at), files: wanted, dir: null, root: a.container ? null : root, names: null };
  for (const c of cands) {
    const known = a.container && resolve(a.container) === resolve(c.at) && a.wholeAt == null ? m.whole : null;
    looks.push({ ...(await lookIn(c.at, m.tree.root, c.shared, known, nowMs)), shared: c.shared });
  }
  const counted = looks.filter(l => l.found.size > 0 && l.wrong.length === 0 && l.others.length === 0);
  const wrong = looks.find(l => l.wrong.length > 0);
  const crowded = looks.find(l => l.found.size > 0 && l.others.length > 0);
  if (counted.length > 1 || wrong || crowded) {
    ambiguous(a, now, counted.length > 1 ? `it is in two places in ${HERE} (${counted.map(l => inFolder(root, join(l.at, a.name))).join(" and ")})`
      : wrong ? `${HERE} has ${inFolder(root, join(wrong.at, ...wrong.wrong[0].p.split("/")))} at ${wrong.wrong[0].s} bytes, where ${nameOf(f)} says ${files.find(x => x.p === wrong.wrong[0].p)?.s ?? "?"}`
      : `${inFolder(root, crowded!.at)} holds files that are not ${a.name}'s beside it (${crowded!.others.slice(0, 3).join(", ")}${crowded!.others.length > 3 ? " …" : ""}): another download of that name left them?`);
    m.writing = false; m.expect = null;
    return null;
  }
  clearTrouble(a, "ambiguous");
  if (!counted.length) {
    // what was here and is not any more: taken by the folder's cleanup (or deleted) before the import
    if (a.here > 0) return lost(f, a, `${a.name} left ${HERE} before its import (${a.here} of its files had arrived)`);
    m.writing = looks.some(l => l.parts.length > 0);
    a.words = a.seenAt == null ? `on its way to ${HERE} — nothing of it there yet` : `on its way to ${HERE}`;
    return null;
  }
  const l = counted[0];
  if (a.container && resolve(a.container) !== resolve(l.at)) { a.here = 0; a.bytes = 0; m.whole.clear(); a.wholeAt = null; a.wholeSig = null; }
  a.container = l.at;
  a.path = join(l.at, a.name);
  m.expect = { containers: [l.at], files: wanted, dir: null, root: null, names: null };
  a.seenAt ??= now;
  if (l.found.size < a.here) return lost(f, a, `${a.here - l.found.size} of the files of ${a.name} left ${HERE} before its import (its cleanup took them?)`);
  // the moment a file shows, it is held: the cleanup counts its hour from the seedbox's date
  await holdNew(f, a, [...l.found.keys()].map(p => join(l.at, ...p.split("/"))));
  a.here = l.found.size;
  a.bytes = [...l.found.values()].reduce((s, x) => s + x, 0);
  m.writing = l.parts.length > 0;
  const all = l.found.size === files.length && l.parts.length === 0;
  if (!all) {
    a.wholeAt = null; a.wholeSig = null;
    m.whole = new Set(l.found.keys());
    a.words = `arriving in ${HERE}: ${a.here} of ${files.length} files, ${gb(a.bytes)} of ${gb(a.total)}`;
    // files that never showed while the rest is here and nothing is written: carried and taken before ludarr looked?
    if (!m.writing) {
      const missing = files.filter(x => !l.found.has(x.p));
      const v = await missingOnSeedbox(f, a, missing, now);
      if (v === "carried") return lost(f, a, `${missing.length} of the files of ${a.name} (${missing.slice(0, 2).map(x => tail(x.p)).join(", ")}${missing.length > 2 ? " …" : ""}) were carried by the sync but are not in ${HERE}: its cleanup took them before ludarr saw them`);
      if (v === "there") a.words += ` — the rest is still on the seedbox`;
    }
    return null;
  }
  // whole: the same sizes and dates a minute later (a file written in place keeps changing its date)
  const sig = await sigOf(l.at, files, m);
  if (sig == null) return null;                                  // one went away meanwhile: the next look says what
  if (a.wholeAt == null || sig !== a.wholeSig) {
    a.wholeAt = now; a.wholeSig = sig;
    m.whole.clear();                                             // the second look reads every file again
    a.words = `arrived in ${HERE}: making sure it is whole (${files.length} files, ${gb(a.total)})`;
    return null;
  }
  if (now - a.wholeAt < WHOLE_SEC) return null;
  return "done";
}

/* ─────────── looking for a usenet download ─────────── */

/** a folder's files (relative paths and sizes), whether a part is being written in it, whether NZBGet's _unpack is there —
 *  with `m`, only new names are looked at (all of them every 30 s) */
async function walkItem(root: string, nowMs: number, m?: Mem): Promise<{ files: Map<string, number>; parts: boolean; unpack: boolean } | null> {
  const full = !m?.sizes || nowMs - m.sizesAt >= 30_000;
  const cache = full ? null : m!.sizes;
  const files = new Map<string, number>();
  let parts = false, unpack = false, seen = 0;
  const walk = async (dir: string, rel: string, top: boolean): Promise<boolean> => {
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (gone(e)) return !top; throw e; }
    for (const e of entries) {
      if (++seen > 50_000) return true;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name === "_unpack") unpack = true; await walk(join(dir, e.name), r, false); continue; }
      if (await livePart(dir, e.name, null, nowMs)) { parts = true; continue; }
      if (e.name.endsWith(".partial")) continue;               // a leftover of a run that died
      const had = cache?.get(r);
      if (had != null) { files.set(r, had); continue; }
      const st = await stat(join(dir, e.name)).catch(x => { if (gone(x)) return null; throw x; });
      if (st?.isFile()) files.set(r, st.size);
    }
    return true;
  };
  const ok = await walk(root, "", true);
  if (!ok) return null;
  if (m) { m.sizes = files; if (full) m.sizesAt = nowMs; }
  return { files, parts, unpack };
}

/** is the sync writing anything anywhere in the folder (a part file younger than 30 min): looked at every 30 s at most — a
 *  folder too big or too slow to walk counts as being written to (it cannot be told that nothing is) */
const anywhere = new Map<string, { at: number; parts: boolean }>();
async function writingAnywhere(root: string, nowMs: number): Promise<boolean> {
  const c = anywhere.get(resolve(root));
  if (c && nowMs - c.at < 30_000) return c.parts;
  let found = false, capped = false, seen = 0;
  const t0 = Date.now();
  const walk = async (dir: string): Promise<void> => {
    if (found || capped) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const e of entries) {
      if (found || capped) return;
      if (++seen > ANYWHERE_ENTRIES || Date.now() - t0 > ANYWHERE_MS) { capped = true; return; }
      if (e.isDirectory()) await walk(join(dir, e.name));
      else if (await livePart(dir, e.name, null, nowMs)) found = true;
    }
  };
  await walk(root);
  anywhere.set(resolve(root), { at: nowMs, parts: found || capped });
  return found || capped;
}

/** the reference: what NZBGet's folder held on the seedbox (read through the mount), kept once in fetches.files_json */
function mergeRef(f: FetchRow, a: Arrival, m: Mem, listed: Map<string, number>): void {
  const ref = new Map((a.from === "seedbox" ? filesOf(f, a) ?? [] : []).map(x => [x.p, x.s]));
  let added = false;
  for (const [p, s] of listed) if (ref.get(p) !== s) { ref.set(p, s); added = true; }
  if (!added) return;
  const list = [...ref].map(([p, s]) => ({ p, s }));
  stmts.setFetchFiles.run(JSON.stringify(list), f.id);
  m.files = list;
  a.from = "seedbox";
  a.nfiles = list.length;
}

/** NZBGet's folder on the seedbox, through the client's remote path mapping (once a minute): "left" while the sync still has
 *  files of it to carry, "done" once it carried all of it (the folder gone or empty, on a mount that answers), "unknown" when
 *  that cannot be told, "none" without a mount for it */
async function usenetSide(f: FetchRow, a: Arrival, now: number, m: Mem): Promise<"none" | "unknown" | "left" | "done"> {
  const mount = mountOf(f);
  const at = mount ? onMount(mount, f.seedbox_path) : null;
  if (!mount || !at) return "none";
  const verdict = () => (a.side!.left == null ? "unknown" : a.side!.left > 0 ? "left" : "done");
  if (a.side && now - a.side.at < SIDE_SEC) return verdict();
  let left: number | null = null;
  if (rootState(mount.to)?.ok !== false) {
    const listed = await adeps.sideList(at);
    if (listed === "absent") left = 0;
    else if (listed) { mergeRef(f, a, m, listed); left = listed.size; }
  }
  // gone or empty there: believed only of a mount that answers now (one that dropped shows the empty folder underneath)
  if (left === 0 && (await probeRoot(mount.to)).ok !== true) left = null;
  a.side = { at: now, left };
  return verdict();
}

/** is anything of a usenet download here now: a whole file in the one folder named like it (found again: it may have come
 *  meanwhile) — a folder that cannot be read counts as one that holds something */
async function anyFileHere(root: string, names: string[], path: string | null): Promise<boolean> {
  for (const p of path ? [path] : await foldersNamed(root, names)) {
    const w = await walkItem(p, adeps.now()).catch(() => null);
    if (!w || w.files.size) return true;
  }
  return false;
}
/** is a file of a usenet download's folder here (its path inside it) one NZBGet's folder held, at whatever size — nested in a
 *  folder of its name, <name>/<p> here is <p> there */
function onList(ref: ArrivalFile[], nest: string[]): (p: string) => boolean {
  const held = new Set(ref.map(x => x.p));
  return p => held.has(p) || nest.some(n => p.startsWith(`${n}/`) && held.has(p.slice(n.length + 1)));
}

/** a usenet download: the one folder named like it (its folder's name, NZBGet's NZB name) two levels deep — two that could be
 *  it, and nothing is touched — taken once all of it is here (the seedbox's word through the client's mount, else 90 % and the
 *  quiet time). Nested in a folder of its name, NZBGet's folder is the inner one: its files are counted there. When NZBGet's
 *  folder was read before anything of it came (all of its list), a file in its folder that folder did not hold is someone
 *  else's: it cannot be told apart, and nothing is touched */
async function lookUsenet(f: FetchRow, a: Arrival, root: string, now: number, m: Mem): Promise<"done" | "lost" | null> {
  const names = namesOf(a);
  const found = names.length ? await foldersNamed(root, names) : [];
  if (found.length > 1) {
    ambiguous(a, now, `it is in two places in ${HERE} (${found.map(p => inFolder(root, p)).join(" and ")})`);
    m.writing = false; m.expect = null;
    return null;
  }
  // found somewhere else than before (the first place went away): what it counted there is not counted here
  if (found.length && a.path && resolve(found[0]) !== resolve(a.path)) { a.here = 0; a.bytes = 0; a.sig = null; a.quiet = 0; m.sizes = null; }
  const path = found[0] ?? a.path;
  const nowMs = adeps.now();
  // the files an earlier download of that name left in its folder are never taken for this one's
  const other = path ? await earlierAt(f, path) : null;
  if (path && other) {
    ambiguous(a, now, `${inFolder(root, path)} may still hold what an earlier download of that name left there (${other.title})`);
    m.writing = false; m.expect = null;
    return null;
  }
  a.path = path;
  // (a file landing in a folder of its name is held the moment the folder says so, before a look has found the folder)
  m.expect = path ? { containers: [], files: null, dir: path, root: null, names: null } : { containers: [], files: null, dir: null, root, names };
  const w = path ? await walkItem(path, nowMs, m) : null;
  const read = a.from === "seedbox";
  const side = await usenetSide(f, a, now, m);
  // NZBGet's folder read on the seedbox for the first time: what it held is all of it only when nothing of it had come here yet
  // (looked at once more after that read: a file the sync carried meanwhile is here by then)
  if (!read && a.from === "seedbox") a.listAll = !(await anyFileHere(root, names, path));
  if (!path || !w || !w.files.size) {
    clearTrouble(a, "ambiguous");
    if (a.here > 0) return lost(f, a, `${a.name} left ${HERE} before its import (${a.here} of its files had arrived)`);
    m.writing = !!w?.parts;
    a.words = a.seenAt == null ? `on its way to ${HERE} — nothing of it there yet` : `on its way to ${HERE}`;
    return null;
  }
  const ref = a.from === "seedbox" ? filesOf(f, a) : null;
  // nested in a folder of its name (<folder>/<name>/<name>): what NZBGet's folder held as <p> is <name>/<p> here
  const nest = resolve(dirname(path)) === resolve(root) ? names : [];
  // with all of NZBGet's list, a file in its folder that folder did not hold is someone else's: nothing is touched
  if (ref && a.listAll) {
    const listed = onList(ref, nest);
    const others = [...w.files.keys()].filter(p => !listed(p) && !p.split("/").includes("_unpack")).sort();
    if (others.length) {
      ambiguous(a, now, `${inFolder(root, path)} holds files NZBGet's folder on the seedbox did not (${others.slice(0, 3).join(", ")}${others.length > 3 ? " …" : ""})`);
      m.writing = false; m.expect = null;
      return null;
    }
  }
  clearTrouble(a, "ambiguous");
  a.seenAt ??= now;
  const bytes = [...w.files.values()].reduce((s, x) => s + x, 0);
  if (w.files.size < a.here || bytes < a.bytes) return lost(f, a, `files of ${a.name} left ${HERE} before its import (its cleanup took them?)`);
  await holdNew(f, a, [...w.files.keys()].map(p => join(path, ...p.split("/"))));
  a.here = w.files.size; a.bytes = bytes;
  if (!a.total) a.total = f.size ?? 0;
  m.writing = w.parts;
  const sig = Bun.hash([...w.files].sort(([x], [z]) => (x < z ? -1 : x > z ? 1 : 0)).map(([p, s]) => `${p}:${s}`).join("|")).toString(36);
  const dt = m.lookAt ? Math.max(0, Math.min(60, (nowMs - m.lookAt) / 1000)) : 0;
  let paused = false;
  if (sig !== a.sig) { a.sig = sig; a.quiet = 0; }
  else if (w.parts || w.unpack) a.quiet = 0;
  else if (await writingAnywhere(root, nowMs)) paused = true;    // the sync writes another file: its next one may be this one's
  else a.quiet += dt;
  const sizeHere = (p: string) => w.files.get(p) ?? nest.map(n => w.files.get(`${n}/${p}`)).find(s => s != null);
  const missing = ref ? ref.filter(x => sizeHere(x.p) !== x.s) : [];
  const here = `${a.here} file${a.here === 1 ? "" : "s"}, ${gb(a.bytes)}${a.want ? ` of the ${gb(a.want)} NZBGet downloaded` : ""}`;
  if (w.unpack) { a.words = `arriving in ${HERE} (${here}) — NZBGet's unpack folder is in it, so it is not finished`; return null; }
  if (side === "unknown") { a.words = `arriving in ${HERE} (${here}) — waiting for the seedbox's folder to answer, to tell whether the sync has carried all of it`; return null; }
  if (side === "left") { a.words = `arriving in ${HERE} (${here}) — the sync is still carrying it: ${a.side!.left} file${a.side!.left === 1 ? "" : "s"} of it still on the seedbox`; return null; }
  if (side === "done" && missing.length) {
    // the sync carried all of it, and a file it carried is not here: the folder's cleanup took it before ludarr saw it
    if (!w.parts) return lost(f, a, `${missing.length} of the files of ${a.name} (${missing.slice(0, 2).map(x => tail(x.p)).join(", ")}${missing.length > 2 ? " …" : ""}) were carried by the sync but are not in ${HERE}: its cleanup took them before ludarr saw them`);
    a.words = `arriving in ${HERE} (${here}) — ${missing.length} of its files still to come`;
    return null;
  }
  // every file NZBGet's folder held is here and the sync is done with it: taken — once nothing in its folder is being written
  if (side === "done" && ref) {
    if (w.parts) { a.words = `arriving in ${HERE} (${here}) — a file in it is still being written`; return null; }
    return "done";
  }
  // without that word: a share of what NZBGet downloaded (else of the release's size), and the quiet time
  if (a.want == null) { a.words = `arriving in ${HERE} (${here}) — waiting for NZBGet to say how much it downloaded`; return null; }
  const base = a.want > 0 ? a.want : (f.size ?? 0);
  if (base > 0 && a.bytes < USENET_SHARE * base) { a.words = `arriving in ${HERE}: ${here}${a.want ? "" : ` (of the release's ${gb(base)})`}`; return null; }
  if (a.quiet >= QUIET_SEC) return "done";
  a.words = paused ? `arriving in ${HERE}: ${here} — the sync is copying other files, so the ${inWords(QUIET_SEC)} quiet time stands still`
    : `arriving in ${HERE}: ${here} — taken once nothing in it changed for ${inWords(QUIET_SEC)} (${Math.floor(a.quiet / 60)} min so far)`;
  return null;
}

/* ─────────── lost: downloaded again, or asked ─────────── */

/** where a history line about an arrival comes from (Activity → History) */
const SOURCE = "finished-downloads folder";

function lost(f: FetchRow, a: Arrival, why: string): "lost" {
  a.lost = { at: sec(), why };
  a.ask = null; a.tries = 0; a.againAt = null;
  adeps.log(`#${f.id} lost: ${why}`);
  record(f.game_id, "downloadFailed", { release: f.title, source: SOURCE, message: `${why} — ${f.protocol === "usenet" && a.regrabs < 1 ? "the same release is downloaded again (nothing else is grabbed, nothing blocklisted)" : "the Queue asks what to do; nothing was blocklisted"}` });
  return "lost";
}

/** the request's import found its input gone from the finished-downloads folder (src/requests.ts): the download is awaited
 *  again, lost */
export function markLost(f: FetchRow, why: string): void {
  const a = arrivalOf(f) ?? fresh(f, sec());
  a.stopped = false; a.via = null; a.here = 0; a.bytes = 0; a.wholeAt = null; a.wholeSig = null; a.sig = null; a.quiet = 0; a.got = null; a.side = null; a.took = null; a.rm = null;
  lost(f, a, why);
  if (a.hold && a.hold.released == null) { a.hold.released = adeps.now(); }
  stmts.setFetchArriving.run(0, `lost: ${why}`, JSON.stringify(a), f.id);
  mem.delete(f.id);
}

/** the request's import found more of its download in the finished-downloads folder than when it was taken (the sync was still
 *  bringing it): awaited again — not lost, its hold goes on — and taken once all of it is there */
export function rearrive(f: FetchRow, why: string): void {
  const a = arrivalOf(f) ?? fresh(f, sec());
  a.stopped = false; a.via = null; a.got = null; a.took = null; a.rm = null; a.wholeAt = null; a.wholeSig = null; a.sig = null; a.quiet = 0; a.side = null; a.ask = null;
  a.words = `${why} — waiting for the rest of it`;
  stmts.setFetchArriving.run(0, why, JSON.stringify(a), f.id);
  const m = mem.get(f.id);
  if (m) { m.nextAt = 0; m.whole.clear(); m.sizes = null; }
  adeps.log(`#${f.id} awaited again in ${HERE}: ${why}`);
}

/** an import from the seedbox the admin chose found nothing there (the sync carried it): never "gone" — it is awaited in the
 *  finished-downloads folder again, and the Queue asks again (src/fetch.ts) */
export function seedboxMissed(f: FetchRow, why: string): void {
  const a = arrivalOf(f) ?? fresh(f, sec());
  const now = sec();
  a.via = null; a.stopped = false; a.side = null; a.askAgainAt = null;
  a.ask = { at: now, why: a.lost ? "lost" : "late" };
  a.words = `it is not on the seedbox (${why.slice(0, 160)}): the sync carried it? — looked for in ${HERE} again`;
  stmts.setFetchArriving.run(0, a.words, JSON.stringify(a), f.id);
  mem.delete(f.id);
  adeps.log(`#${f.id} not on the seedbox after all: awaited in ${HERE} again`);
}

/** what rTorrent says when asked to erase a torrent it no longer has: it is erased already */
const ERASED = /could not find info-?hash/i;

/**
 * The same release downloaded again: a usenet post appended anew under a key of its own (`<guid>#2`, so NZBGet's answer for
 * the first append is never taken for it), a torrent removed from its client with its data, then added again. The payload
 * comes first (kept between tries): nothing is erased before the download again is in hand, and a torrent erased once is
 * never erased again (`put` writes that at once: a failed add, or a restart, goes on from there). No try of the release is
 * spent and nothing is blocklisted: the copy was fine, the finished-downloads folder lost it.
 */
async function again(f: FetchRow, a: Arrival, by: "auto" | "admin", put: () => void): Promise<void> {
  const client = f.client_instance_id ? adeps.clientById(f.client_instance_id) : null;
  if (!client) throw new ArrivalError("its download client was deleted under Settings: it cannot be downloaded again", 409);
  let rel: { guid?: string } | null = null;
  try { rel = f.release_json ? JSON.parse(f.release_json) : null; } catch { /* none */ }
  const n = a.regrabs + 1;
  const m = memOf(f.id);
  const why = a.lost?.why ?? `${HERE} lost it`;
  try {
    const payload = m.payload ?? (await adeps.payload(f));
    m.payload = payload;
    if (f.protocol === "torrent" && f.client_id && !a.erased) {
      try { await client.remove({ client: f.client as SbClient, clientId: f.client_id }, true); }
      catch (e) { if (!ERASED.test(messageOf(e))) throw e; }
      a.erased = true;
      put();
      adeps.log(`#${f.id} ${f.title}: removed from ${nameOf(f)} with its data, to download it again`);
    }
    const key = rel?.guid ? (f.protocol === "usenet" ? `${rel.guid}#${n + 1}` : rel.guid) : undefined;
    const added = await client.add(payload, { title: f.title, protocol: f.protocol as "torrent" | "usenet", ...(key ? { key } : {}) });
    m.payload = null;
    stmts.setFetchAgain.run(added.clientId, `downloading it again: ${why}`, JSON.stringify({ regrabs: n }), f.id);
    mem.delete(f.id);
    adeps.log(`#${f.id} ${f.title}: downloaded again (${by === "auto" ? "by itself, once" : "the admin's choice"}) as ${f.client} ${added.clientId}`);
    record(f.game_id, "grabbed", { release: f.title, source: SOURCE, message: `downloaded again: ${why} — the same release, nothing else grabbed` });
  } catch (e) {
    if (e instanceof ArrivalError) throw e;
    const t = clientTrouble(e), said = (t ?? messageOf(e)).slice(0, 160);
    if (by === "auto") {
      // tried again on the seedbox's ladder (1, 2, 5, 10, 20, 30, 60 min, then hourly), the NZB kept
      a.tries = (a.tries ?? 0) + 1;
      const wait = ladderSec(a.tries - 1);
      a.againAt = sec() + wait;
      a.words = `${why} — downloading it again did not work yet (${said}): trying again in ${inWords(wait)}`;
    } else {
      a.words = `${why} — downloading it again did not work (${said})${a.erased ? "; its copy on the seedbox is already deleted" : ""}`;
      throw new ArrivalError(`it could not be downloaded again: ${(t ?? messageOf(e)).slice(0, 200)}`, t ? 503 : 400);
    }
  }
}

/* ─────────── one look at one download ─────────── */

/** is anything of the download still where its client keeps it on the seedbox — read through the client's remote path mapping,
 *  on a mount that answers: "present" (a file of it is there: the sync has not carried it — it is on its way, or the sync does
 *  not reach it), "absent" (its folder gone, or emptied: the sync moves each file and leaves the folders, so all of it was
 *  carried), null when that cannot be told (no mount, it does not answer, it could not be read) */
async function leftOnSeedbox(f: FetchRow): Promise<"present" | "absent" | null> {
  const mount = mountOf(f);
  if (!mount || rootState(mount.to)?.ok !== true) return null;
  const at = onMount(mount, f.seedbox_path);
  if (!at) return null;
  const listed = await adeps.sideList(at);
  if (listed == null) return null;
  if (listed !== "absent" && listed.size > 0) return "present";
  // gone or empty there: believed only of a mount that answers now (one that dropped shows the empty folder underneath)
  return (await probeRoot(mount.to)).ok === true ? "absent" : null;
}

/** asked once it is 6 h late (unless the admin put the question off) */
function askIfLate(a: Arrival, now: number): void {
  if (!a.ask && now - a.since >= ASK_AFTER_SEC && (a.askAgainAt == null || now >= a.askAgainAt)) a.ask = { at: now, why: "late" };
}

let wakes = 0;
async function arrive(f0: FetchRow): Promise<void> {
  const m = memOf(f0.id);
  const nowMs = adeps.now();
  if (nowMs < m.nextAt) return;
  // the row as it is now (an answer in the Queue, a loss the import found, may have changed it since the list was read)
  const f = stmts.fetchById.get(f0.id) as FetchRow | undefined;
  if (!f || f.state !== "arriving") return;
  const a = arrivalOf(f);
  if (!a) { beginArrival(f); return; }                            // an arriving row without its state: begun now
  if (a.via === "seedbox" || a.stopped) return;
  const now = sec();
  let raw = f.arrival_json ?? null;
  const put = () => { if (putIf(f.id, raw, a)) raw = JSON.stringify(a); };
  const client = f.client_instance_id ? adeps.clientById(f.client_instance_id) : null;
  const t0 = Date.now(), w0 = wakes;
  try {
    // the bound: 72 h without it (a lost one: 72 h after it was lost) — it stops, kept, nothing blocklisted; Retry looks again
    const from = Math.max(a.since, a.lost?.at ?? 0);
    if (now - from >= STOP_AFTER_SEC) {
      a.stopped = true;
      a.words = a.orphan ? `its download client was deleted under Settings, and it did not arrive in ${inWords(now - from)}`
        : a.lost ? `${a.lost.why} — nothing was done about it in ${inWords(now - from)}` : `${a.name} did not arrive in ${HERE} in ${inWords(now - from)}`;
      if (a.hold && a.hold.released == null) release(f, a, "it stopped waiting");
      adeps.log(`#${f.id} stopped waiting for it in ${HERE} after ${inWords(now - from)}`);
      return;
    }
    // its client was deleted under Settings: nothing more can arrive for it (nothing tells which files are its own) — its
    // files are let go, it is said, and it stops at the bound; never failed (that would give the copy up)
    if (!client) {
      a.orphan = true; a.ask = null;
      a.words = "its download client was deleted under Settings, so nothing more can arrive for it — cancel the search (Activity → Queue); it stops by itself 3 days after it finished";
      if (a.hold && a.hold.released == null) release(f, a, "its download client was deleted");
      m.expect = null;
      return;
    }
    a.orphan = false;
    const root = arrivalsDir();
    if (!root) {
      // the setting emptied: the download goes the way it would without it (transferred as before)
      if (!arrivalsSetting()) {
        if (stmts.leaveArrivingIf.run("seedbox_done", `${HERE} is no longer set: transferring it as before`, f.id, raw).changes > 0) adeps.log(`#${f.id} no finished-downloads folder any more: back to the transfer`);
        return;
      }
      // set, and not there (unmounted, a path that does not exist): it waits — the sync may have moved it off the seedbox
      // already — said in the health list, and asked at 6 h like any late one
      a.words = `waiting for ${HERE}, which is not there`;
      m.expect = null;
      askIfLate(a, now);
      return;
    }
    await askClient(f, a, now);
    if (a.lost) {
      const auto = f.protocol === "usenet" && a.regrabs < 1;
      if (auto && (a.againAt == null || now >= a.againAt)) {
        try { await again(f, a, "auto", put); if ((stmts.fetchById.get(f.id) as FetchRow | undefined)?.state !== "arriving") return; }
        catch (e) { a.regrabs = 1; a.words = `${a.lost.why}; it could not be downloaded again by itself (${messageOf(e)})`; }
      }
      // a usenet download is downloaded again by itself for 6 h; then (and at once for a torrent) the Queue asks
      if (auto && a.regrabs < 1 && now - a.lost.at < ASK_AFTER_SEC) return;
      if ((!a.ask || a.ask.why !== "lost") && (a.askAgainAt == null || now >= a.askAgainAt)) a.ask = { at: now, why: "lost" };
      if (!a.tries || !auto) a.words = a.erased ? `${a.lost.why}; its copy on the seedbox was deleted to download it again` : a.lost.why;
      return;
    }
    const r = f.protocol === "torrent" ? await lookTorrent(f, a, root, client, now, m) : await lookUsenet(f, a, root, now, m);
    if (r === "lost") return;
    if (r === "done") {
      // what it weighs now (as the import will weigh it), and file by file what that is: the import must find all of it, and
      // no more — and of those files, the ones its client's own list has at those sizes are all that is ever deleted of it there
      // once it is imported (the rest is written down as unproven, and stays)
      const got = await rmdeps.weigh(a.path!).catch(() => null);
      const list = got ? await listTaken(a.path!).catch(() => null) : null;
      if (!got || !list || !weighsAs(list, got)) { a.words = `arrived in ${HERE}, but it could not be weighed: looking again`; return; }
      a.words = `arrived in ${HERE}`; a.ask = null; a.trouble = null; a.troubleWords = null;
      a.got = got;
      const took = taking(f, a, root, list, "arrived", now, listedOf(f, a, root, a.path!));
      a.took = anchorOf(took); a.rm = null;
      // taken only as it was read: an answer in the Queue meanwhile wins
      if (stmts.setFetchArrivedIf.run(a.path, JSON.stringify(a), JSON.stringify(took), f.id, raw).changes > 0) {
        raw = JSON.stringify(a);
        adeps.log(`#${f.id} arrived in ${HERE}: ${inFolder(root, a.path!)} (${list.length} file${list.length === 1 ? "" : "s"}, ${gb(got.bytes)}) — imported from there, where it is`);
      }
      return;
    }
    // nothing here long after the client finished it: taken while ludarr was not looking, when it is not where its client
    // keeps it on the seedbox either (the sync moved it) — never said of a download that may still be on its way, nor of a
    // torrent whose files its client never listed (what is there cannot be told as its own)
    if (a.seenAt == null && !a.trouble && !(f.protocol === "torrent" && !a.from) && now - a.since >= QUIET_SEC + CLEANUP_SEC && (a.mirrorAt == null || now - a.mirrorAt >= 600)) {
      a.mirrorAt = now;
      if ((await leftOnSeedbox(f)) === "absent") {
        lost(f, a, `nothing of ${a.name} reached ${HERE}, and nothing of it is left on the seedbox: the sync carried it and the folder's cleanup took it while ludarr was not looking?`);
        return;
      }
    }
    askIfLate(a, now);
  } catch (e) {
    // the finished-downloads folder could not be read: said, and looked at again (never a verdict on the download)
    a.words = `${HERE} could not be read (${messageOf(e).slice(0, 160)}): looking again`;
  } finally {
    m.lookAt = nowMs;
    // the next look: in a second (four times what this one took), a wake that came meanwhile at once — and a torrent found
    // whole is looked at again once its minute is over
    m.nextAt = wakes !== w0 ? 0 : nowMs + Math.min(60_000, Math.max(1000, 4 * (Date.now() - t0)));
    if (f.protocol === "torrent" && a.wholeAt != null && m.nextAt > 0) m.nextAt = Math.max(m.nextAt, (a.wholeAt + WHOLE_SEC) * 1000);
    if (JSON.stringify(a) !== raw) put();
  }
}

/* ─────────── the hold ─────────── */

/** the files of a held download (absolute paths): a torrent's own files, everything in a usenet download's folder (or in the
 *  folder a torrent its client has not listed yet is guessed in) — null when the folder could not be read */
async function heldFiles(f: FetchRow, a: Arrival, every = false): Promise<string[] | null> {
  const list = f.protocol === "torrent" && a.container ? filesOf(f, a) : null;
  if (list) {
    const all = list.map(x => join(a.container!, ...x.p.split("/")));
    if (f.state !== "arriving" || every) return all;
    // still arriving: the files seen so far (the looks hold each new one at first sight)
    const m = mem.get(f.id);
    return m ? all.filter(p => m.touched.has(p)) : [];
  }
  const dir = a.path ?? a.guess;
  if (!dir) return [];
  const w = await walkItem(dir, adeps.now()).catch(() => null);
  return w ? [...w.files.keys()].map(p => join(dir, ...p.split("/"))) : null;
}

/** the present date on each of these files: those it was set on, those gone, those that failed (another error than a refusal),
 *  and a folder that refuses (EPERM, EROFS, EACCES: the rest is not tried) */
async function touchAll(paths: string[], at: number): Promise<{ ok: string[]; gone: string[]; failed: { p: string; code: string }[]; denied: string | null }> {
  const out = { ok: [] as string[], gone: [] as string[], failed: [] as { p: string; code: string }[], denied: null as string | null };
  const when = new Date(at);
  for (const p of paths) {
    try { await adeps.touch(p, when); out.ok.push(p); }
    catch (e) {
      const c = codeOf(e);
      if (c === "ENOENT" || c === "ENOTDIR") out.gone.push(p);
      else if (c === "EPERM" || c === "EROFS" || c === "EACCES") { out.denied = c; break; }
      else out.failed.push({ p, code: c || "EIO" });
    }
  }
  return out;
}

/** what a touch did, kept: the files whose date was set are held (and when), a refusal and other failures said — a file
 *  whose date could not be set is not counted as held, so the next look tries it again */
function noteTouch(f: FetchRow, a: Arrival, m: Mem, r: Awaited<ReturnType<typeof touchAll>>, at: number, name: string): void {
  for (const p of r.ok) { m.touched.add(p); m.heldAt.set(p, at); m.went.delete(p); }
  const h = a.hold!;
  if (r.denied) { if (!h.denied) adeps.log(`#${f.id} ${HERE} refuses new dates (${r.denied}): its cleanup may take ${name} before the import`); h.denied = r.denied; }
  else if (r.ok.length) h.denied = null;
  if (r.failed.length) {
    if (!h.failed) adeps.log(`#${f.id} the dates of ${r.failed.length} file(s) of ${name} could not be set (${r.failed[0].code}): tried again`);
    h.failed = { code: r.failed[0].code, at: h.failed?.at ?? at, n: r.failed.length };
  } else if (!r.denied && r.ok.length) h.failed = null;
}

/** the files of a download that showed since the last look: held at once */
async function holdNew(f: FetchRow, a: Arrival, paths: string[]): Promise<void> {
  const m = memOf(f.id);
  const now = adeps.now();
  const fresh = paths.filter(p => !m.touched.has(p));
  if (!fresh.length) return;
  if (!a.hold || a.hold.released != null) a.hold = { since: a.hold?.since ?? now, at: now, released: null, denied: a.hold?.denied ?? null, gone: a.hold?.gone ?? 0, goneAt: a.hold?.goneAt ?? null, failed: a.hold?.failed ?? null };
  noteTouch(f, a, m, await touchAll(fresh, now), now, a.name);
}

/** the hold let go, once: what is there of it stays — nothing of it is deleted (said in the history) */
function release(f: FetchRow, a: Arrival, why: string): void {
  if (!a.hold || a.hold.released != null) return;
  a.hold.released = adeps.now();
  const m = mem.get(f.id);
  m?.touched.clear(); m?.heldAt.clear(); m?.went.clear();
  adeps.log(`#${f.id} ${f.title}: left in ${HERE} (${why}) — nothing of it there is deleted`);
  record(f.game_id, "left", { release: f.title, source: SOURCE, message: `left in ${HERE} (${why}): ludarr deletes nothing of it there` });
}
/** the hold ended by the removal: nothing is left of it to hold (the removal's own history line says what went) */
function unhold(f: Pick<FetchRow, "id">, a: Arrival): void {
  if (a.hold && a.hold.released == null) a.hold.released = adeps.now();
  const m = mem.get(f.id);
  m?.touched.clear(); m?.heldAt.clear(); m?.went.clear();
}
/** taken there and imported — or not yet looked at: the removal decides (the hold stays on until it is removed, or left) */
const awaitsRemoval = (f: Pick<FetchRow, "state">, a: Arrival): boolean => f.state === "done" && !!a.took && (!a.rm || a.rm.state === "due" || a.rm.state === "waiting");

/** the downloads that may be held: awaited, held now, or the download of a search in flight */
const heldQ = db.query(`SELECT f.*,
    EXISTS (SELECT 1 FROM requests r WHERE r.fetch_id=f.id AND r.state IN ('fetching','processing')) AS used_by_request
  FROM fetches f WHERE f.arrival_json IS NOT NULL AND json_valid(f.arrival_json) AND (
    f.state='arriving' OR (json_extract(f.arrival_json, '$.hold') IS NOT NULL AND json_extract(f.arrival_json, '$.hold.released') IS NULL)
    OR EXISTS (SELECT 1 FROM requests r WHERE r.fetch_id=f.id AND r.state IN ('fetching','processing')))
  ORDER BY f.id`);
/** one of them, as it is now */
const heldOneQ = db.query(`SELECT f.*,
    EXISTS (SELECT 1 FROM requests r WHERE r.fetch_id=f.id AND r.state IN ('fetching','processing')) AS used_by_request
  FROM fetches f WHERE f.id=?`);
/** the jobs in the queue or running, and what each reads */
const jobInputsQ = db.query("SELECT input_path, spec_json, kind FROM jobs WHERE state IN ('queued','running')");
/** the latest arrivals (one a job reads that nothing else holds: an import by hand, a carry run's earlier download) */
const recentArrivalsQ = db.query("SELECT f.*, 0 AS used_by_request FROM fetches f WHERE f.arrival_json IS NOT NULL ORDER BY f.id DESC LIMIT 500");
type HeldRow = FetchRow & { used_by_request: number };

const inside = (p: string, dir: string) => { const x = resolve(p), y = resolve(dir); return x === y || x.startsWith(y.endsWith(sep) ? y : y + sep); };
const overlaps = (p: string, q: string) => inside(p, q) || inside(q, p);

/** a job's spec (null: none, or unreadable) */
const specOf = (j: Pick<JobRow, "spec_json">): Record<string, unknown> | null => {
  try { const v = JSON.parse(j.spec_json ?? "null"); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
};
/** what a job reads: an import's download, another kind's path (a sentinel, 'way:3', is none) */
const jobInput = (j: Pick<JobRow, "input_path" | "spec_json" | "kind">): string | null => {
  const p = (j.kind ?? "import") === "import" ? j.input_path : specOf(j)?.path;
  return typeof p === "string" && p ? p : null;
};
/** what every job in the queue or running reads, wherever that is */
function readingNow(): string[] {
  return (jobInputsQ.all() as Pick<JobRow, "input_path" | "spec_json" | "kind">[]).map(jobInput).filter((p): p is string => !!p);
}
/** what the jobs in the queue or running read inside the finished-downloads folder (paths) */
function jobInputs(): string[] {
  const synced = rmdeps.roots().filter(m => m.kind === "synced");
  return synced.length ? readingNow().filter(p => synced.some(m => inside(p, m.to))) : [];
}

/**
 * Is a download's hold on: while it is awaited (not stopped, not lost, not taken from the seedbox instead, its client not
 * deleted, not one that cannot be told apart — nothing of those is touched); once it arrived, while the search it is the
 * download of is in flight (its import queued or running, a wait on it, the hold for the AI importer) — or while any job in the
 * queue or running reads it (an import by hand, a way's intake of an earlier download).
 */
function heldNow(f: HeldRow, a: Arrival, ins: string[]): boolean {
  const at = a.path ?? a.guess;
  if (!at) return false;
  if (ins.some(p => overlaps(p, at))) return true;
  if (f.state === "arriving") return !a.stopped && !a.lost && a.via !== "seedbox" && !a.orphan && a.trouble !== "ambiguous";
  return f.state === "done" && !!f.used_by_request && !!f.local_path && overlaps(f.local_path, at);
}

/**
 * One pass of the hold: every download held gets its files' dates refreshed every 10 min (`boot`: all of them now — the hour
 * may have run on while ludarr was down), and looked at every minute in between (a date set back is set again); one nothing
 * holds any more is let go, once (what is there of it stays) — unless it was taken there and imported: then the removal
 * decides (removalPass), and the hold stays on until it is removed or left. A file of an arrived download that is not there
 * at a refresh went away: said (and, while it is awaited, lost; once it arrived, its import finds it short) — never one of a
 * download that is imported (its removal takes them).
 */
export async function holdPass(o: { boot?: boolean } = {}): Promise<void> {
  const ins = jobInputs();
  const ids = new Set<number>((heldQ.all() as HeldRow[]).map(r => r.id));
  if (ins.length) for (const r of recentArrivalsQ.all() as HeldRow[]) {
    const a = arrivalOf(r);
    const at = a?.path ?? a?.guess;
    if (at && !ids.has(r.id) && ins.some(p => overlaps(p, at))) ids.add(r.id);
  }
  for (const id of ids) {
    // the row as it is now, and written back only over what was read here (an answer in the Queue meanwhile wins)
    const f = heldOneQ.get(id) as HeldRow | undefined;
    const a = f ? arrivalOf(f) : null;
    if (!f || !a || (!a.path && !a.guess)) continue;
    const raw = f.arrival_json ?? null;
    const now = adeps.now();
    if (!heldNow(f, a, ins)) {
      if (!awaitsRemoval(f, a)) {
        release(f, a, f.state === "arriving" ? (a.trouble === "ambiguous" ? "it cannot be told apart" : "it is no longer awaited") : "nothing uses it any more");
        if (JSON.stringify(a) !== raw) putIf(f.id, raw, a);
        continue;
      }
      if (!a.hold || a.hold.released != null) continue;          // (nothing held: the removal goes on without a hold)
    }
    if (!a.hold || a.hold.released != null) {
      if (a.hold?.released != null) adeps.log(`#${f.id} ${f.title}: held again (a job reads it)`);
      a.hold = { since: now, at: 0, released: null, denied: a.hold?.denied ?? null, gone: a.hold?.gone ?? 0, goneAt: a.hold?.goneAt ?? null, failed: a.hold?.failed ?? null };
      // used again (a search took it up again, a job reads it): once that is over, its removal is looked at anew
      if (a.rm?.state === "left") a.rm = null;
    }
    const m = memOf(f.id);
    const due = o.boot || now - a.hold.at >= REFRESH_MS;
    if (due || now - m.checkAt >= HOLD_CHECK_MS) {
      m.checkAt = now;
      const files = await heldFiles(f, a, o.boot);
      if (files == null) {
        // its folder could not be read: no refresh is counted (the next pass tries again), and said while it lasts
        a.hold.failed = { code: "EIO", at: a.hold.failed?.at ?? now, n: a.hold.failed?.n ?? 0 };
      } else {
        // a refresh sets every file; a look between refreshes sets only a date older than the one ludarr set (set back)
        let todo = files;
        if (!due) {
          todo = [];
          for (const p of files) {
            if (m.went.has(p)) continue;
            if (!m.touched.has(p)) { todo.push(p); continue; }               // not held yet (its date could not be set): tried again
            const st = await stat(p).catch(() => null);
            if (st && st.mtimeMs < (m.heldAt.get(p) ?? a.hold.at) - 2000) todo.push(p);
          }
          if (todo.length) adeps.log(`#${f.id} ${todo.length} held file(s) of ${f.title} had an older date again (${tail(todo[0])}${todo.length > 1 ? " …" : ""}): held again`);
        }
        const r = await touchAll(todo, now);
        if (due) a.hold.at = now;
        noteTouch(f, a, m, r, now, f.title);
        // a file of a download still arriving that is not there may simply not have come yet: only one seen before went away
        // (each counted once); one of a download that is imported is its removal's (ludarr's own, or the folder's cleanup
        // ahead of it): never a loss
        if (f.state === "done" && f.imported_at != null && a.took) for (const p of r.gone) { m.touched.delete(p); m.heldAt.delete(p); m.went.add(p); }
        const went = r.gone.filter(p => (f.state !== "arriving" || m.touched.has(p)) && !m.went.has(p));
        for (const p of went) m.went.add(p);
        if (went.length) {
          a.hold.gone += went.length; a.hold.goneAt = now;
          for (const p of went) { m.touched.delete(p); m.heldAt.delete(p); }
          adeps.log(`#${f.id} ${went.length} held file${went.length === 1 ? "" : "s"} of ${f.title} left ${HERE} (${tail(went[0])}${went.length > 1 ? " …" : ""})`);
          if (f.state === "arriving" && !a.lost) { lost(f, a, `${went.length} of the files of ${a.name} left ${HERE} before its import (its cleanup took them?)`); a.here = 0; a.bytes = 0; }
        }
      }
    }
    if (JSON.stringify(a) !== raw) putIf(f.id, raw, a);
  }
  for (const id of [...mem.keys()]) if (!stmts.fetchById.get(id)) mem.delete(id);
}

/* ─────────── removed once imported ─────────── */

/** a removal held up (a job reads it, another download of its name is there, the game's copy could not be read) is looked at
 *  again this often; files found already gone are looked at once more this much later (seconds) */
const REMOVAL_WAIT_SEC = 60, CONFIRM_SEC = 60;
/** a removal that failed this many looks in a row is said in the health list */
export const REMOVAL_WARN_TRIES = 3;
/** a copy that reaches the folder after its import from the seedbox is looked for this long after the import (seconds) */
export const LATE_SEC = STOP_AFTER_SEC;
/** the game's copy in the library is checked file by file up to this many files (more: an even sample of as many, and its
 *  largest) */
const COPY_CHECK_FILES = 20_000;

/** every file of a download where it lies, as the import weighs it (src/remote.ts: a link is followed, rclone's part files
 *  are not counted), as [its path inside it, its size] — "" for a download of a single file; null when it could not be read
 *  whole (an error, over 50,000 entries, a minute) */
async function listTaken(path: string): Promise<[string, number][] | null> {
  const out: [string, number][] = [];
  let seen = 0, failed = false;
  const walk = async (q: string, rel: string, top: boolean): Promise<void> => {
    if (failed) return;
    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(q); } catch (e) { if (top || !gone(e)) failed = true; return; }
    if (!st.isDirectory()) { out.push([rel, st.size]); return; }
    let names: string[];
    try { names = await readdir(q); } catch (e) { if (top || !gone(e)) failed = true; return; }
    for (const n of names.sort()) {
      if (failed) return;
      if (n.endsWith(".partial")) continue;
      if (++seen > 50_000) { failed = true; return; }
      await walk(join(q, n), rel ? `${rel}/${n}` : n, false);
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const done = await Promise.race([walk(path, "", true).then(() => true), new Promise<boolean>(res => { timer = setTimeout(() => res(false), 60_000); })]);
  if (timer) clearTimeout(timer);
  return done && !failed ? out : null;
}
/** the list holds what the weighing found: the same files, the same bytes */
const weighsAs = (list: [string, number][], w: { files: number; bytes: number }): boolean => list.length === w.files && list.reduce((s, x) => s + x[1], 0) === w.bytes;

/** what is taken, as it is written down: the folder that is all the download's own is a torrent's folder of its name it sits
 *  in (<folder>/<name>/<name>, a single file in <folder>/<name>/), else its own folder — none for a single file straight in
 *  the finished-downloads folder or in a category's (never that folder, never a category's). `listed`: which of its files its
 *  client's own list has at that size (the rest is written down as unproven); without it, every file is its own (a late copy
 *  that is exactly its client's list, leftovers the admin approved) */
function taking(f: Pick<FetchRow, "protocol">, a: Pick<Arrival, "path" | "container" | "name">, root: string, files: [string, number][], how: TookHow, now: number, listed?: Listed): Taken {
  const base = resolve(root), path = resolve(a.path!), c = a.container ? resolve(a.container) : null;
  const single = files.length === 1 && files[0][0] === "";
  const own = f.protocol === "torrent" && c && c !== base && dirname(c) === base && basename(c) === a.name && inside(path, c) ? c : single ? null : path;
  return { v: 1, at: now, how, root: base, path, own, files: listed ? files.filter(([p, s]) => listed(p, s)) : files, unproven: listed ? files.filter(([p, s]) => !listed(p, s)) : [] };
}
/** is a file of a download (its path inside where it lies, its size) on its client's own list at that size */
type Listed = (rel: string, size: number) => boolean;
/** what of a download its client's own list shows to be its own — a torrent's files (rTorrent's list, or its .torrent's), what
 *  NZBGet's folder held on the seedbox (nested in a folder of its name, <name>/<p> here is <p> there) — none for a usenet
 *  download whose folder was never read there: nothing tells its files from anything else in the folder */
function listedOf(f: Pick<FetchRow, "id" | "protocol" | "files_json">, a: Arrival, root: string, path: string): Listed {
  const l = filesOf(f, a);
  if (!l) return () => false;
  if (f.protocol === "torrent") {
    // `<name>/<p>` beside where it lies (a single file: `<name>`) — inside it, `<p>` ("" for the file itself)
    const at = new Map(l.filter(x => x.p === a.name || x.p.startsWith(`${a.name}/`)).map(x => [x.p === a.name ? "" : x.p.slice(a.name.length + 1), x.s] as const));
    return (rel, size) => at.get(rel) === size;
  }
  if (a.from !== "seedbox") return () => false;
  const held = new Map(l.map(x => [x.p, x.s] as const));
  const nest = resolve(dirname(path)) === resolve(root) ? namesOf(a) : [];
  return (rel, size) => held.get(rel) === size || nest.some(n => rel.startsWith(`${n}/`) && held.get(rel.slice(n.length + 1)) === size);
}
/** what the arrival keeps of a taking: enough to tell the list in fetches.took_json is this taking's (every file it took) */
const anchorOf = (t: Taken): NonNullable<Arrival["took"]> => {
  const all = [...t.files, ...(t.unproven ?? [])];
  return { at: t.at, how: t.how, path: t.path, files: all.length, bytes: all.reduce((s, x) => s + x[1], 0) };
};
/** fetches.took_json read back (null: none, or not one) */
function parseTaken(s: string | null | undefined): Taken | null {
  try {
    const t = s ? (JSON.parse(s) as Taken) : null;
    if (!t || t.v !== 1 || typeof t.root !== "string" || typeof t.path !== "string" || (t.own != null && typeof t.own !== "string") || !Array.isArray(t.files)) return null;
    if (t.unproven != null && !Array.isArray(t.unproven)) return null;
    const pair = (x: unknown) => Array.isArray(x) && typeof x[0] === "string" && Number.isFinite(x[1]);
    return t.files.every(pair) && (t.unproven ?? []).every(pair) ? t : null;
  } catch { return null; }
}
/** what this arrival took (fetches.took_json), only when it is this taking's — its time, how, place, files and bytes as the
 *  arrival says: a list from an earlier taking is never followed */
function takenFor(f: Pick<FetchRow, "took_json">, a: Pick<Arrival, "took">): Taken | null {
  const t = parseTaken(f.took_json), k = a.took;
  if (!t || !k) return null;
  const x = anchorOf(t);
  return x.at === k.at && x.how === k.how && resolve(x.path) === resolve(k.path) && x.files === k.files && x.bytes === k.bytes ? t : null;
}

/** the jobs a download's search ran on it — its import, a way's check of it — the latest first (a carry run's look at an
 *  earlier download only reads it: never one of them) */
const searchJobsQ = db.query(`SELECT id, kind, state, input_path, spec_json, manifest_json, game_id FROM jobs
  WHERE (fetch_id=? OR (json_valid(spec_json) AND json_extract(spec_json, '$.fetchId')=?)) AND COALESCE(kind, 'import') IN ('import', 'content')
  ORDER BY id DESC LIMIT 50`);
type SearchJob = Pick<JobRow, "id" | "kind" | "state" | "input_path" | "spec_json" | "manifest_json" | "game_id">;
/** the download's latest search */
const searchOfQ = db.query("SELECT id, state, package_id, game_id FROM requests WHERE fetch_id=? ORDER BY id DESC LIMIT 1");
/** a search in flight on the download, a job queued or running on it */
const busyQ = db.query(`SELECT
    EXISTS (SELECT 1 FROM requests WHERE fetch_id=? AND state IN ('requested','matching','fetching','processing')) AS search,
    EXISTS (SELECT 1 FROM jobs WHERE state IN ('queued','running') AND (fetch_id=? OR (json_valid(spec_json) AND json_extract(spec_json, '$.fetchId')=?))) AS job`);
/** other downloads of ludarr's that may still need what lies in the folder: awaited there, or arrived and held for an import
 *  that is not done (one imported is no claim: its own removal takes the same files). A wait that stopped (72 h: only Retry
 *  takes it up again), one whose client was deleted, or one the admin had imported from the seedbox instead awaits nothing
 *  there: no claim */
const claimsQ = db.query(`SELECT id, state, arrival_json FROM fetches WHERE id != ? AND arrival_json IS NOT NULL AND json_valid(arrival_json) AND (
    (state='arriving' AND COALESCE(json_extract(arrival_json, '$.stopped'), 0)=0 AND COALESCE(json_extract(arrival_json, '$.orphan'), 0)=0
      AND COALESCE(json_extract(arrival_json, '$.via'), '')!='seedbox')
    OR (imported_at IS NULL AND json_extract(arrival_json, '$.hold') IS NOT NULL AND json_extract(arrival_json, '$.hold.released') IS NULL))`);

/** another download of ludarr's awaited or held where this one lies — or, not found yet, looked for by the name of a folder
 *  this one lies in: its words (null: none) */
function claimedBy(id: number, root: string, path: string): string | null {
  const top = posix(relative(root, path)).split("/").slice(0, 2);
  for (const r of claimsQ.all(id) as Pick<FetchRow, "id" | "state" | "arrival_json">[]) {
    const o = arrivalOf(r);
    if (!o) continue;
    if ([o.path, o.guess, o.took?.path].some(p => !!p && overlaps(p, path))) return `another download of ludarr's is ${r.state === "arriving" ? "awaited" : "held"} there (#${r.id})`;
    if (r.state === "arriving" && !o.path && namesOf(o).some(n => top.includes(n))) return `another download of ludarr's of that name is awaited (#${r.id})`;
  }
  return null;
}

/** what a way's check of a download kept (its manifest: proven, or kept for a look) */
const outcomeOf = (j: Pick<JobRow, "manifest_json">): string | null => { try { return (JSON.parse(j.manifest_json ?? "null") as { outcome?: string } | null)?.outcome ?? null; } catch { return null; } };

/** the game's copy in the library as its manifest lists it: its folder there and every file of it at its size ("ok"; a copy of
 *  very many files: an even sample of them, and its largest) — "missing" (its folder or a file is not there), "changed" (a
 *  file at another size, a manifest that lists nothing), "linked" (the copy, or a link in it, lies in the finished-downloads
 *  folder `root`: removing what was taken would break it), "unreadable" (the volume could not say) */
async function copyChecksOut(pkg: Pick<PackageRow, "path" | "manifest_json">, root: string): Promise<"ok" | "missing" | "changed" | "linked" | "unreadable"> {
  let files: { path?: unknown; size?: unknown }[] = [];
  try { const m = JSON.parse(pkg.manifest_json) as { files?: unknown }; files = Array.isArray(m?.files) ? m.files : []; } catch { return "changed"; }
  if (!files.length) return "changed";
  const realRoot = await adeps.realpath(root).catch(() => resolve(root));
  const into = (p: string) => inside(p, realRoot) || inside(p, root);
  const dir = await adeps.realpath(pkg.path).catch(e => (gone(e) ? null : ("unreadable" as const)));
  if (dir === "unreadable") return "unreadable";
  if (!dir || !(await stat(dir).then(s => s.isDirectory(), () => false))) return "missing";
  if (into(dir)) return "linked";
  const every = Math.ceil(files.length / COPY_CHECK_FILES);
  const pick = every <= 1 ? files : [...files.filter((_, i) => i % every === 0), ...[...files].sort((x, y) => Number(y.size) - Number(x.size)).slice(0, 100)];
  for (const x of pick) {
    if (typeof x.path !== "string" || !Number.isFinite(x.size)) return "changed";
    const p = join(pkg.path, ...x.path.split("/"));
    const l = await lstat(p).catch(e => (gone(e) ? null : ("unreadable" as const)));
    if (l === "unreadable") return "unreadable";
    if (!l) return "missing";
    // a link in the copy is followed — but one into the finished-downloads folder makes the copy the download's
    if (l.isSymbolicLink()) { const to = await adeps.realpath(p).catch(() => null); if (!to) return "missing"; if (into(to)) return "linked"; }
    const st = l.isSymbolicLink() ? await stat(p).catch(() => null) : l;
    if (!st?.isFile()) return "missing";
    if (st.size !== x.size) return "changed";
  }
  return "ok";
}

type Verdict = { ok: true } | { ok: false; final: boolean; why: string };
/**
 * May what a download took from the finished-downloads folder go: nothing uses it any more (no search in flight on it, no
 * job queued or running on it or reading inside it, no other download of ludarr's awaited or held where it lies), it was
 * imported — the latest job its search ran on it is done and read what was taken (a copy that came after its import from the
 * seedbox: the import read the seedbox's), a way's check of it proved the game file and its way was built, its search ended
 * with it — and the game's copy in the library checks out. `final`: that will not change by itself (it is left); otherwise
 * it is looked at again.
 */
async function mayGo(f: FetchRow, t: Taken, ins: string[]): Promise<Verdict> {
  const wait = (why: string): Verdict => ({ ok: false, final: false, why });
  const leave = (why: string): Verdict => ({ ok: false, final: true, why });
  const busy = busyQ.get(f.id, f.id, f.id) as { search: number; job: number };
  if (busy.search) return wait("its search still uses it");
  if (busy.job || ins.some(p => overlaps(p, t.path))) return wait("a job still reads it");
  const other = claimedBy(f.id, t.root, t.path);
  if (other) return wait(other);
  // the admin's "Keep downloads after import" (Settings → Media Management) keeps this one too: it is left, and says why
  if (cfgBool("IMPORT_KEEP_DOWNLOAD")) return leave("Keep downloads after import is on");
  const j = (searchJobsQ.all(f.id, f.id) as SearchJob[]).find(x => !specOf(x)?.earlier);
  if (!j) return leave("it was never imported");
  if (j.state === "cancelled") return leave("its import was cancelled");
  if (j.state !== "done") return leave("its import did not go through");
  const input = jobInput(j);
  if (t.how !== "late" && !(input && overlaps(input, t.path))) return leave("its import read another copy of it");
  if (f.imported_at == null) return leave("it was not imported");
  const r = searchOfQ.get(f.id) as { id: number; state: string; package_id: number | null; game_id: number } | undefined;
  if ((j.kind ?? "import") === "content") {
    if (outcomeOf(j) !== "proven") return leave("the way's check did not prove the game file in it");
    if (r?.state !== "ready" || r.package_id == null) return leave("its way was not built from it");
  } else if (r && r.state !== "ready") return leave("its search ended without it");
  // the game's copy in the library: there, every file of its manifest at its size
  const gameId = f.game_id ?? j.game_id ?? r?.game_id ?? null;
  const pkg = gameId != null ? (stmts.packageForGame.get(gameId) as PackageRow | undefined) : undefined;
  if (!pkg) return leave("the game has no copy in the library");
  const c = await copyChecksOut(pkg, t.root);
  if (c === "unreadable") return wait("the game's copy in the library could not be read");
  if (c !== "ok") return leave(c === "missing" ? "the game's copy in the library is not all there" : c === "linked" ? "the game's copy in the library links into the finished-downloads folder" : "the game's copy in the library is not what its import made");
  return { ok: true };
}

/** what one sweep did — or, dry, would do: files removed and their bytes, files already gone, files that changed since they
 *  were taken (another size, not a plain file, reached through a link: they stay), files that could not be deleted (the first
 *  code); folders removed, folders that stay (something else is in them), folders that hold only what Unraid keeps of a file
 *  something still has open (.fuse_hidden: tried again); what stays, named (paths inside the finished-downloads folder, a
 *  few): its files that changed, and what else is in the folders that stay — dry: the files and folders that would go */
export interface Swept {
  removed: number; bytes: number; gone: number; changed: number; failed: number; code: string | null;
  dirs: number; kept: number; busy: number;
  changedAt: string[]; others: string[];
  would?: { files: string[]; dirs: string[] };
}
/** at most this many of what stays is named */
const NAMED = 5;
/** a record that would reach outside its own place: nothing of it is touched */
class Unsafe extends Error {}
/** nothing may be deleted where it lies now (the message says why): the removal waits */
class NotNow extends Error {}
/** may anything be deleted in `root` now: only while it is the finished-downloads folder as set now, that folder is there, and
 *  it is not an rclone mount of the seedbox (that is the seedbox's own folder: a torrent's files there are still seeding) —
 *  null: it may; else why not, in words (never a path) */
function notNow(root: string): string | null {
  const dir = arrivalsDir();
  if (!dir) return arrivalsSetting() ? `${HERE} is not there` : `${HERE} is not set`;
  if (!samePath(resolve(dir), resolve(root))) return `${HERE} is set to another folder now`;
  if (rcloneMount(adeps.mountInfo(), resolve(dir))) return `${HERE} is an rclone mount of the seedbox`;
  return null;
}
/** two paths inside one folder, the same (the case is the system's on Windows) */
const samePath = (x: string, y: string): boolean => { const a = posix(x), b = posix(y); return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; };

/**
 * Exactly what was taken goes: each file only at its path and its size, as a plain file reached through real folders inside
 * the finished-downloads folder as it was then (one that changed stays and is counted); then the folders that leaves empty,
 * deepest first, inside the download's own folder only — never the finished-downloads folder itself or what holds it, never
 * a folder it shares (a category's, the folder it sits in), never one that holds anything else, and never through a link.
 * Nothing is removed recursively: a folder goes only when the system finds it empty. A file or folder already gone is no
 * failure (a sweep done twice deletes nothing more). Only `files` go: what it took that is `unproven` stays (and is not named
 * among what else keeps a folder). `dry`: nothing is touched, and what would go is said. Throws Unsafe for a record that
 * reaches outside its place, NotNow while that place is not the finished-downloads folder as set now (or is an rclone mount of
 * the seedbox), and the folder's own error when it cannot be read.
 */
async function sweep(t: Taken, o: { dry?: boolean } = {}): Promise<Swept> {
  const root = resolve(t.root), path = resolve(t.path), own = t.own ? resolve(t.own) : null;
  const strictly = (p: string, dir: string) => p !== dir && inside(p, dir);
  if (!isAbsolute(t.root) || !strictly(path, root) || (own && (!strictly(own, root) || !inside(path, own)))) throw new Unsafe("what it took does not lie inside the finished-downloads folder");
  // its own folder is where it lies, or the folder of its very name it is nested in — never a folder above that (a category's)
  if (own && own !== path && !(dirname(path) === own && basename(own) === basename(path))) throw new Unsafe("its own folder is written down as a folder it only sits in");
  const why = notNow(root);
  if (why) throw new NotNow(why);
  const notMine = new Set((t.unproven ?? []).map(([rel]) => (rel ? join(path, ...rel.split("/")) : path)));
  const set = arrivalsSetting();
  const here = set ? resolve(set) : null;
  const realRoot = await adeps.realpath(root);
  const reals = new Map<string, Promise<true | false | "gone" | string>>();
  /** a folder reached through real folders only: true; false (a link on the way); "gone"; or the error's code */
  const realDir = (d: string) => {
    let x = reals.get(d);
    if (!x) { x = adeps.realpath(d).then(r => samePath(relative(realRoot, r), relative(root, d)), e => (gone(e) ? ("gone" as const) : codeOf(e) || "EIO")); reals.set(d, x); }
    return x;
  };
  const out: Swept = { removed: 0, bytes: 0, gone: 0, changed: 0, failed: 0, code: null, dirs: 0, kept: 0, busy: 0, changedAt: [], others: [], ...(o.dry ? { would: { files: [], dirs: [] } } : {}) };
  const fail = (code: string) => { out.failed++; out.code ??= code; };
  const named = (list: string[], p: string) => { const n = posix(relative(root, p)); if (list.length < NAMED && !list.includes(n)) list.push(n); };
  const going = new Set<string>(), changed = new Set<string>(), all: string[] = [];
  const stays = (p: string) => { out.changed++; changed.add(p); named(out.changedAt, p); };
  for (const [rel, size] of t.files) {
    const segs = rel ? rel.split("/") : [];
    if (segs.some(s => !s || s === "." || s === ".." || /[\\/]/.test(s))) { out.changed++; continue; }
    const p = segs.length ? join(path, ...segs) : path;
    if (!inside(p, path)) { out.changed++; continue; }
    all.push(p);
    const d = await realDir(dirname(p));
    if (d === "gone") { out.gone++; continue; }
    if (d === false) { stays(p); continue; }
    if (d !== true) { fail(d); continue; }
    let st: Awaited<ReturnType<typeof lstat>>;
    try { st = await lstat(p); } catch (e) { if (gone(e)) out.gone++; else fail(codeOf(e) || "EIO"); continue; }
    if (!st.isFile() || st.size !== size) { stays(p); continue; }
    if (o.dry) { going.add(p); out.would!.files.push(posix(relative(root, p))); out.removed++; out.bytes += size; continue; }
    try { await adeps.unlink(p); out.removed++; out.bytes += size; }
    catch (e) { if (gone(e)) out.gone++; else fail(codeOf(e) || "EIO"); }
  }
  if (!own) return out;
  // the folders that leaves empty, deepest first: every folder between a file and the download's own folder, and that one
  const dirs = new Set<string>();
  for (const p of all) for (let d = dirname(p); inside(d, own); d = dirname(d)) { dirs.add(d); if (d === own) break; }
  /** a folder that stays: what in it was never part of the download is named */
  const keep = (d: string, names: string[]) => { out.kept++; for (const n of names) { const q = join(d, n); if (!dirs.has(q) && !changed.has(q) && !going.has(q) && !notMine.has(q)) named(out.others, q); } };
  for (const d of [...dirs].sort((x, y) => y.length - x.length)) {
    if (!strictly(d, root) || (here && inside(here, d))) continue;          // never the folder, nor what holds it
    const r = await realDir(d);
    if (r === "gone") continue;
    if (r !== true) { out.kept++; continue; }                              // never removed through a link
    if (o.dry) {
      const names = await readdir(d).catch(() => null);
      if (names && names.every(n => going.has(join(d, n)))) { going.add(d); out.would!.dirs.push(posix(relative(root, d))); out.dirs++; } else keep(d, names ?? []);
      continue;
    }
    try { await adeps.rmdir(d); out.dirs++; }
    catch (e) {
      if (gone(e)) continue;
      const c = codeOf(e);
      if (c === "ENOTEMPTY" || c === "EEXIST") {
        const names = await readdir(d).catch(() => [] as string[]);
        if (names.length && names.every(n => n.startsWith(".fuse_hidden"))) out.busy++; else keep(d, names);
      } else fail(c || "EIO");
    }
  }
  return out;
}

/** what the history says of a removal that is done */
function removedWords(t: Taken, r: Removal): string {
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  let s = r.removed === 0 ? `nothing of it was left to remove from ${HERE} after its import`
    : t.how === "late" ? `a copy of it that reached ${HERE} after its import from the seedbox was removed (${files(r.removed)}, ${gb(r.bytes)})`
    : `removed from ${HERE} after its import (${files(r.removed)}, ${gb(r.bytes)})`;
  if (r.gone) s += r.removed === 0 ? `: its ${files(r.gone)} ${r.gone === 1 ? "was" : "were"} already gone` : `; ${r.gone} ${r.gone === 1 ? "was" : "were"} already gone`;
  const few = (l: string[] | undefined, n: number) => (l?.length ? ` (${l.join(", ")}${n > l.length ? " …" : ""})` : "");
  if (r.changed) s += `; ${files(r.changed)} changed since ${r.changed === 1 ? "it was" : "they were"} taken and stay${r.changed === 1 ? "s" : ""}${few(r.changedAt, r.changed)}`;
  // what it took that nothing shows to be its own stays (the leftovers list offers it for the admin's OK)
  const u = t.unproven ?? [];
  if (u.length) s += `; ${files(u.length)} it took ${u.length === 1 ? "is" : "are"} not known to be its own and stay${u.length === 1 ? "s" : ""}${few(u.slice(0, NAMED).map(([rel]) => posix(relative(t.root, rel ? join(t.path, ...rel.split("/")) : t.path))), u.length)}`;
  if (r.kept) s += r.others?.length || !u.length ? `; its folder stays: something else is still in it${few(r.others, r.others?.length === NAMED ? NAMED + 1 : 0)}` : `; its folder stays with ${u.length === 1 ? "it" : "them"}`;
  return s;
}

/** a line for the history, once it is written (removed, or left) */
type Said = { event: "removed" | "left"; words: string };
const blankRemoval = (): Removal => ({ state: "due", why: null, tries: 0, since: null, code: null, nextAt: null, waitAt: null, removed: 0, bytes: 0, gone: 0, changed: 0, kept: 0, changedAt: [], others: [], confirm: null, at: null });

/**
 * One look at a download's removal (its state is the arrival's: rm), when its time comes: removed when it may go (the hold
 * ends with it), left when it never will (nothing deleted; the hold let go), looked at again in a minute when something
 * holds it up; a delete that failed is tried again on the ladder (1, 2, 5 … 60 min, then hourly), and files already gone when
 * ludarr removed none are looked at once more first.
 */
async function removeOne(f: FetchRow, a: Arrival, ins: string[]): Promise<Said | null> {
  const now = sec();
  const r = a.rm ?? blankRemoval();
  if (r.state === "done" || r.state === "left" || (r.nextAt != null && now < r.nextAt)) return null;
  a.rm = r;
  const left = (why: string): Said => {
    r.state = "left"; r.why = why; r.at = now; r.nextAt = null; r.waitAt = null;
    unhold(f, a);
    return { event: "left", words: `left in ${HERE} (${why}): ludarr deletes nothing of it there` };
  };
  const failed = (code: string): null => {
    if (r.tries === 0 || r.code !== code) adeps.log(`#${f.id} ${f.title}: its files in ${HERE} could not all be deleted after its import (${code}): tried again`);
    r.state = "due"; r.tries++; r.since ??= now; r.code = code; r.nextAt = now + ladderSec(r.tries - 1); r.waitAt = null;
    r.why = `it could not all be deleted (${code}): trying again in ${inWords(r.nextAt - now)}`;
    return null;
  };
  // held up for now: looked at again in a minute (a day of it is said in the health list)
  const waiting = (why: string): null => { r.state = "waiting"; r.why = why; r.waitAt ??= now; r.nextAt = now + REMOVAL_WAIT_SEC; return null; };
  const t = takenFor(f, a);
  if (!t) return left("what it took there was not written down");
  const v = await mayGo(f, t, ins);
  if (!v.ok) return v.final ? left(v.why) : waiting(v.why);
  // only what its client's own list shows to be its own is ever deleted: without any of that, nothing of it is
  if (!t.files.length) return left(f.protocol !== "usenet" ? "none of the files it took are on its client's list" : a.from !== "seedbox" ? "its files there cannot be told from anything else: NZBGet's folder was not seen on the seedbox before the sync carried it" : "none of the files it took were in NZBGet's folder on the seedbox");
  let s: Swept;
  try { s = await sweep(t); }
  catch (e) {
    if (e instanceof Unsafe) return left(e.message);
    if (e instanceof NotNow) return waiting(e.message);
    return failed(codeOf(e) || "EIO");                           // the finished-downloads folder could not be read
  }
  // (what an earlier look removed is gone now too: never counted as gone by itself)
  const before = r.removed;
  r.removed += s.removed; r.bytes += s.bytes; r.gone = Math.max(0, s.gone - before); r.changed = s.changed; r.kept = s.kept;
  r.changedAt = s.changedAt; r.others = s.others;
  if (s.failed || s.busy) return failed(s.code ?? "EBUSY");
  // files already gone, none of it removed by ludarr: looked at once more before it counts (a folder that answered wrong)
  if (r.gone && r.removed === 0 && r.confirm == null) {
    r.state = "due"; r.confirm = now; r.nextAt = now + CONFIRM_SEC; r.why = "files of it were already gone: looked at once more"; r.waitAt = null;
    return null;
  }
  r.state = "done"; r.at = now; r.nextAt = null; r.why = null; r.code = null; r.waitAt = null;
  unhold(f, a);
  return { event: "removed", words: removedWords(t, r) };
}

/** downloads taken from the finished-downloads folder whose removal is not settled and whose search is over */
const removalQ = db.query(`SELECT f.* FROM fetches f WHERE f.state='done' AND f.arrival_json IS NOT NULL AND json_valid(f.arrival_json)
    AND json_extract(f.arrival_json, '$.took') IS NOT NULL AND COALESCE(json_extract(f.arrival_json, '$.rm.state'), '') NOT IN ('done', 'left')
    AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.fetch_id=f.id AND r.state IN ('requested','matching','fetching','processing'))
  ORDER BY f.id`);

/**
 * One pass of the removal: each download taken there whose search is over is looked at when its time comes (removeOne). Its
 * state is written only over what was read (an answer, a loss meanwhile wins: it is looked at again), and its history line
 * only once that is written. One download's trouble is its own: the next one is looked at all the same.
 */
export async function removalPass(): Promise<void> {
  const rows = removalQ.all() as FetchRow[];
  if (!rows.length) return;
  const ins = readingNow();
  for (const row of rows) {
    const f = stmts.fetchById.get(row.id) as FetchRow | undefined;
    const a = f ? arrivalOf(f) : null;
    if (!f || !a?.took || f.state !== "done") continue;
    const raw = f.arrival_json ?? null;
    let said: Said | null = null;
    try { said = await removeOne(f, a, ins); }
    catch (e) { adeps.log(`#${f.id} its removal from ${HERE} could not be looked at (${messageOf(e).slice(0, 160)}): looked at again`); continue; }
    if (JSON.stringify(a) === raw || !putIf(f.id, raw, a) || !said) continue;
    adeps.log(`#${f.id} ${f.title}: ${said.words}`);
    record(f.game_id, said.event, { release: f.title, source: SOURCE, message: said.words });
  }
}

/* ─────────── a copy that comes after its import from the seedbox ─────────── */

/** downloads imported from the seedbox instead (the admin's choice in the Queue) whose copy may still reach the
 *  finished-downloads folder: looked for there until 72 h after their import */
const lateQ = db.query(`SELECT * FROM fetches WHERE state='done' AND imported_at IS NOT NULL AND imported_at >= ? AND arrival_json IS NOT NULL
  AND json_valid(arrival_json) AND json_extract(arrival_json, '$.via')='seedbox' AND json_extract(arrival_json, '$.took') IS NULL ORDER BY id`);
/** what the last look at a late copy saw: where, its files' sizes and dates (a digest), and when (unix s) */
const lateSeen = new Map<number, { path: string; sig: string; at: number }>();
let lateAt = 0;

/** a late torrent: the one place of its name holding exactly its client's list — every file at its size, nothing else in its
 *  own folders, no part being written (null: none, two, or not exactly that) */
async function lateTorrent(a: Arrival, root: string, ref: ArrivalFile[]): Promise<{ path: string; container: string; files: Map<string, number> } | null> {
  const tree = treeOf(ref), nowMs = adeps.now();
  const looks: Look[] = [];
  for (const c of await containersOf(a, root)) { const l = await lookIn(c.at, tree, c.shared, null, nowMs); if (l.found.size || l.wrong.length) looks.push(l); }
  if (looks.length !== 1) return null;
  const l = looks[0];
  if (l.found.size !== ref.length || l.wrong.length || l.others.length || l.parts.length) return null;
  const files = new Map(ref.map(x => [x.p === a.name ? "" : x.p.slice(a.name.length + 1), x.s] as const));
  return { path: join(l.at, a.name), container: l.at, files };
}
/** a late usenet download: the one folder of its name holding exactly what NZBGet's folder held (as the client's mount showed
 *  it) — every file at its size, nothing else, nothing being written, no _unpack (null: none, two, or not exactly that) */
async function lateUsenet(a: Arrival, root: string, ref: ArrivalFile[]): Promise<{ path: string; container: string; files: Map<string, number> } | null> {
  const names = namesOf(a);
  const found = names.length ? await foldersNamed(root, names) : [];
  if (found.length !== 1) return null;
  const path = found[0];
  const w = await walkItem(path, adeps.now());
  if (!w || w.parts || w.unpack) return null;
  // nested in a folder of its name (<folder>/<name>/<name>): what NZBGet's folder held as <p> is <name>/<p> here
  const nest = resolve(dirname(path)) === resolve(root) ? names : [];
  const files = new Map<string, number>();
  for (const x of ref) {
    const at = w.files.has(x.p) ? x.p : nest.map(n => `${n}/${x.p}`).find(q => w.files.has(q));
    if (at == null || w.files.get(at) !== x.s) return null;
    files.set(at, x.s);
  }
  return files.size === w.files.size ? { path, container: dirname(path), files } : null;
}
/** the sizes and dates of a download's files where it lies (a digest; null: one is not there as a plain file) */
async function datesOf(path: string, files: Map<string, number>): Promise<string | null> {
  const parts: string[] = [];
  for (const rel of [...files.keys()].sort()) {
    const st = await stat(rel ? join(path, ...rel.split("/")) : path).catch(() => null);
    if (!st?.isFile()) return null;
    parts.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
  }
  return Bun.hash(parts.join("|")).toString(36);
}

/**
 * A download the admin had imported from the seedbox instead may still reach the finished-downloads folder afterwards (the
 * sync was late, not gone). Looked for once a minute, 72 h after its import: taken — written down like an arrival, then removed
 * by the removal pass like any imported download — only when the one place of its name holds exactly what its client listed
 * (a torrent: rTorrent's list or its .torrent's; usenet: NZBGet's folder as the client's mount showed it), every file at its
 * size, nothing else in its own folder, nothing being written, unchanged a minute later, no other download of ludarr's
 * awaited or held there, no job reading it. Anything else is left (listLeftovers lists it for the admin).
 */
export async function latePass(): Promise<void> {
  const nowMs = adeps.now();
  if (nowMs - lateAt < 60_000) return;
  lateAt = nowMs;
  const root = arrivalsDir();
  if (!root) return;
  const now = sec();
  const rows = lateQ.all(now - LATE_SEC) as FetchRow[];
  for (const id of [...lateSeen.keys()]) if (!rows.some(r => r.id === id)) lateSeen.delete(id);
  for (const row of rows) {
    const f = stmts.fetchById.get(row.id) as FetchRow | undefined;
    const a = f ? arrivalOf(f) : null;
    if (!f || !a || a.via !== "seedbox" || a.took) { lateSeen.delete(row.id); continue; }
    try {
      const ref = clientList(f, a, a.name);
      const found = !ref?.length ? null : f.protocol === "torrent" ? await lateTorrent(a, root, ref) : await lateUsenet(a, root, ref);
      if (!found || claimedBy(f.id, root, found.path) || readingNow().some(p => overlaps(p, found.path))) { lateSeen.delete(f.id); continue; }
      const sig = await datesOf(found.path, found.files);
      const seen = lateSeen.get(f.id);
      if (!sig || !seen || seen.sig !== sig || seen.path !== found.path) { if (sig) lateSeen.set(f.id, { path: found.path, sig, at: now }); else lateSeen.delete(f.id); continue; }
      if (now - seen.at < WHOLE_SEC) continue;
      // whole, and the same a minute on: written down file by file — exactly its client's list — for the removal
      const list = await listTaken(found.path).catch(() => null);
      lateSeen.delete(f.id);
      if (!list || list.length !== found.files.size || list.some(([p, s]) => found.files.get(p) !== s)) continue;
      const took = taking(f, { path: found.path, container: found.container, name: a.name }, root, list, "late", now);
      const raw = f.arrival_json ?? null;
      a.took = anchorOf(took); a.rm = null;
      if (stmts.setFetchTookIf.run(JSON.stringify(took), JSON.stringify(a), f.id, raw).changes > 0)
        adeps.log(`#${f.id} ${f.title}: a copy of it reached ${HERE} after its import from the seedbox (${inFolder(root, found.path)}, ${list.length} file${list.length === 1 ? "" : "s"}), exactly what its client listed`);
    } catch (e) { lateSeen.delete(row.id); adeps.log(`#${row.id} ${HERE} could not be looked at for a late copy (${messageOf(e).slice(0, 160)}): looked at again`); }
  }
}

/* ─────────── the task ─────────── */

let ticking = false, rerun = false, awaiting = false;
/** the task (every second while anything is awaited, else every 5 s): each download awaited is looked at, then the hold's pass,
 *  then the removal's (and, once a minute, the look for copies that came after their import from the seedbox) */
export async function arrivalsTick(): Promise<void> {
  if (ticking) { rerun = true; return; }
  ticking = true;
  try {
    do {
      rerun = false;
      const rows = stmts.fetchesByState.all("arriving") as FetchRow[];
      for (const f of rows) await arrive(f);
      awaiting = rows.length > 0;
      await holdPass();
      await latePass().catch(e => adeps.log(`the look for late copies failed: ${messageOf(e)}`));
      await removalPass().catch(e => adeps.log(`the removal pass failed: ${messageOf(e)}`));
    } while (rerun);
  } finally { ticking = false; }
}
/** how often the task runs now: every second while anything is awaited (a file may land any moment, already "an hour old") */
export const arrivalsEverySec = (): number => (awaiting ? 1 : 5);

/** at boot, before anything else runs: every held download's files get the present date (the hour may have run on while
 *  ludarr was down) */
export async function resumeArrivals(): Promise<void> {
  await holdPass({ boot: true }).catch(e => adeps.log(`the hold could not be refreshed at boot: ${messageOf(e)}`));
}

/** a file the folder's change event names: held at once when it is one an awaited download waits for (at its size: a torrent's
 *  listed file in a folder that may hold it, anything in a usenet download's own folder — or, before that folder was found,
 *  in a folder of its name) — never one of a download that cannot be told apart, never a part file, never again a file whose
 *  date ludarr itself just set (its own change) */
async function onChange(dir: string, name: string): Promise<void> {
  if (name.endsWith(".partial")) return;
  const full = resolve(dir, name);
  for (const m of mem.values()) {
    const e = m.expect;
    if (!e) continue;
    const top = e.root && inside(full, e.root) ? posix(relative(e.root, full)).split("/") : null;
    let size: number | null | undefined;
    if (e.dir && inside(full, e.dir)) size = null;
    else if (e.files) {
      const at = top && top.length > 1 ? [...e.containers, join(e.root!, top[0])] : e.containers;
      for (const c of at) { const rel = posix(relative(c, full)); if (!rel.startsWith("..") && e.files.has(rel)) { size = e.files.get(rel)!; break; } }
    } else if (e.names && top && ((top.length >= 2 && e.names.includes(top[0])) || (top.length >= 3 && e.names.includes(top[1])))) size = null;
    if (size === undefined) continue;
    const st = await stat(full).catch(() => null);
    if (!st?.isFile() || (size != null && st.size !== size)) continue;
    const held = m.heldAt.get(full);
    if (held != null && Math.abs(st.mtimeMs - held) < 2000) continue;
    const at = adeps.now();
    try { await adeps.touch(full, new Date(at)); m.touched.add(full); m.heldAt.set(full, at); } catch { /* the look holds it, or says why not */ }
  }
}

const watchers = new Map<string, { close(): void } | null>();
let lastWake = 0, wakeTimer: ReturnType<typeof setTimeout> | null = null;
/** a change in the finished-downloads folder (the sync renamed a file into place, or wrote one): while anything is awaited, the
 *  file it names is held at once when it is an awaited download's, and every awaited download is looked at within a second —
 *  at most once a second, however busy the sync is (a wake during a look gets its own look) */
function wake(dir: string, name: string | null): void {
  if (!awaiting) return;
  if (name) void onChange(dir, name).catch(() => {});
  if (wakeTimer) return;
  const wait = Math.max(0, 1000 - (Date.now() - lastWake));
  wakeTimer = setTimeout(() => {
    wakeTimer = null; lastWake = Date.now(); wakes++;
    for (const m of mem.values()) m.nextAt = 0;
    void arrivalsTick().catch(() => {});
  }, wait);
}
/** the watch on the finished-downloads folder (a change wakes the looks within a second); kept in step with the setting */
export function watchSynced(): void {
  const dir = arrivalsDir();
  const want = new Set(dir ? [resolve(dir)] : []);
  for (const [k, w] of watchers) if (!want.has(k)) { w?.close(); watchers.delete(k); }
  for (const k of want) if (!watchers.has(k)) watchers.set(k, adeps.watch(k, name => wake(k, name)));
}

/* ─────────── what the request says (src/requests.ts) and what the admin may choose ─────────── */

/** a choice the admin cannot make now */
export class ArrivalError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
/** seedbox: import it from the seedbox instead · now: import what has arrived (usenet) · wait: keep waiting · again: download
 *  the same release again */
export type ArrivalChoice = "seedbox" | "now" | "wait" | "again";

/**
 * The answers the Queue offers to the question an arrival asks (none while nothing is asked, nor for a download whose client
 * was deleted): "from the seedbox" only with a remote path mapping, and only while the seedbox has it — a torrent until its
 * copy there was erased for a download again, a usenet download while nothing of it reached the finished-downloads folder and
 * NZBGet's folder there was not found carried; "import what has arrived" for a usenet download part of which is here.
 */
export function choicesOf(f: Pick<FetchRow, "protocol" | "client_instance_id">, a: Arrival): ArrivalChoice[] {
  const why = a.ask?.why;
  if (!why || a.orphan) return [];
  const mount = !!mountOf(f);
  const torrent = f.protocol === "torrent";
  const seedbox = mount && (torrent ? !a.erased : a.here === 0 && a.side?.left !== 0);
  const out: (ArrivalChoice | false)[] =
    why === "late" ? [torrent ? seedbox && "seedbox" : a.here > 0 ? "now" : seedbox && "seedbox", "wait", "again"]
    : why === "lost" ? ["again", torrent && seedbox && "seedbox", "wait"]
    : [seedbox && "seedbox", "wait"];
  return out.filter((x): x is ArrivalChoice => !!x);
}
const CHOICE_WORDS: Record<ArrivalChoice, string> = { seedbox: "import it from the seedbox instead", now: "import what has arrived", again: "download it again", wait: "keep waiting" };
const inChoices = (c: ArrivalChoice[]) => { const w = c.map(x => CHOICE_WORDS[x]); return w.length > 1 ? `${w.slice(0, -1).join(", ")} or ${w[w.length - 1]}` : w[0] ?? ""; };

/** the request's stage and progress while its download arrives (the admin's words: players read "Downloading", no rate) */
export function arrivalStage(f: FetchRow): { stage: string; progress: number } {
  const a = arrivalOf(f);
  if (!a) return { stage: `on its way to ${HERE}`, progress: 0.5 };
  const share = a.total > 0 ? Math.min(1, a.bytes / a.total) : 0;
  let stage = a.words;
  const c = choicesOf(f, a);
  if (a.ask && c.length) stage = `${a.words}${a.ask.why === "late" ? ` — it has not fully arrived since ${clock(a.since)}` : ""}: ${inChoices(c)} (Activity → Queue)`;
  else if (!a.ask && a.askAgainAt != null && sec() < a.askAgainAt) stage = `${a.words} — you chose to keep waiting (asked again at ${clock(a.askAgainAt)})`;
  return { stage, progress: 0.5 + 0.35 * share };
}

/**
 * The admin's answer to the Queue's question (POST /api/v1/download/:id/arrival):
 *   seedbox  import it from the seedbox instead — through the client's remote path mapping (the mount), with every wait the
 *            seedbox's trouble gets; its files here are let go
 *   now      import what has arrived (a usenet download): taken as it is
 *   wait     keep waiting: the question comes again in 6 h; a loss is forgotten and it is looked for again
 *   again    download the same release again (a torrent: removed from its client with its data, once the new one is in hand)
 */
export async function chooseArrival(id: number, choice: ArrivalChoice): Promise<FetchRow> {
  const f = stmts.fetchById.get(id) as FetchRow | undefined;
  if (!f) throw new ArrivalError("not found", 404);
  const a = arrivalOf(f);
  if (!a || f.state !== "arriving") throw new ArrivalError(`this download is not awaited in ${HERE}`, 409);
  const now = sec();
  const m = mem.get(id);
  if (choice === "seedbox") {
    if (!mountOf(f)) throw new ArrivalError("the seedbox's folder is not mounted here for this download client (Settings → Download Clients), so there is nothing to import it from", 409);
    if (f.protocol === "usenet" && a.here > 0) throw new ArrivalError(`it is arriving in ${HERE} already (the sync moves it off the seedbox): import what has arrived, or keep waiting`, 409);
    if (f.protocol === "torrent" && a.erased) throw new ArrivalError("its copy on the seedbox was deleted to download it again", 409);
    a.via = "seedbox"; a.ask = null; a.stopped = false;
    release(f, a, "it is imported from the seedbox instead");
    save(id, a);
    stmts.setFetchRetry.run("seedbox_done", 1, "importing it from the seedbox instead (your choice in the Queue)", null, null, id);
    adeps.log(`#${id} the admin chose to import it from the seedbox instead`);
  } else if (choice === "now") {
    if (f.protocol !== "usenet") throw new ArrivalError("a torrent is imported once every one of its files is there", 409);
    const w = a.path && !a.trouble ? await walkItem(a.path, adeps.now()).catch(() => null) : null;
    if (!w?.files.size) throw new ArrivalError(`nothing of it has arrived in ${HERE} yet`, 409);
    a.here = w.files.size; a.bytes = [...w.files.values()].reduce((s, x) => s + x, 0);
    const root = arrivalsDir();
    const got = root ? await rmdeps.weigh(a.path!).catch(() => null) : null;
    const list = got ? await listTaken(a.path!).catch(() => null) : null;
    if (!root || !got || !list || !weighsAs(list, got)) throw new ArrivalError(`it could not be weighed in ${HERE}: try again`, 409);
    a.got = got;
    const took = taking(f, a, root, list, "now", now, listedOf(f, a, root, a.path!));
    a.took = anchorOf(took); a.rm = null;
    a.words = "imported as it is (your choice in the Queue)"; a.ask = null;
    if (stmts.setFetchArrivedIf.run(a.path, JSON.stringify(a), JSON.stringify(took), id, f.arrival_json ?? null).changes === 0) throw new ArrivalError("it changed meanwhile — look at the Queue again", 409);
    adeps.log(`#${id} the admin chose to import what has arrived: ${inFolder(root, a.path!)} (${a.here} files, ${gb(a.bytes)})`);
  } else if (choice === "wait") {
    a.ask = null; a.askAgainAt = now + ASK_AFTER_SEC; a.stopped = false;
    if (a.lost) { a.lost = null; a.here = 0; a.bytes = 0; a.seenAt = null; a.mirrorAt = now; a.side = null; }
    save(id, a);
    if (m) m.nextAt = 0;
  } else if (choice === "again") {
    a.lost ??= { at: now, why: "you chose to download it again" };
    a.ask = null;
    try { await again(f, a, "admin", () => save(id, a)); }
    finally { const cur = stmts.fetchById.get(id) as FetchRow | undefined; if (cur?.state === "arriving") save(id, a); }
  } else throw new ArrivalError("choose seedbox, now, wait or again");
  return stmts.fetchById.get(id) as FetchRow;
}

/** Retry from the Queue: an arrival that stopped (72 h) is waited for again from now; one that waits is looked at now */
export function resumeArrival(f: FetchRow): void {
  const a = arrivalOf(f);
  if (!a) { beginArrival(f); return; }
  if (a.stopped) { a.stopped = false; a.since = sec(); a.told = true; a.ask = null; a.askAgainAt = null; a.mirrorAt = null; if (a.lost) a.lost = { ...a.lost, at: a.since }; }
  save(f.id, a);
  // (one the admin chose to take from the seedbox instead is not awaited here again)
  if (f.state !== "arriving" && a.via !== "seedbox") stmts.setFetchArriving.run(0, null, JSON.stringify(a), f.id);
  const m = mem.get(f.id);
  if (m) m.nextAt = 0;
}

/* ─────────── health ─────────── */

const requestStageQ = db.query("SELECT stage FROM requests WHERE fetch_id=? AND state IN ('fetching','processing') ORDER BY id DESC LIMIT 1");

/**
 * The finished-downloads folder and what waits on it, for the health list (the words stay the same while nothing changes: a
 * time, never a running count — a new item notifies). The folder set and missing (when it was set by hand, or downloads wait
 * on it: the default with no such folder here is the feature off, with nothing to say), not a folder, not writable (the hold
 * must set dates) or an rclone mount of the seedbox, and a download client's remote path that points into it: an error. A
 * download with nothing here 30 min after its client finished: a warning (a torrent its client has not listed: that said);
 * one not all here after 2 h: a warning, an error at 6 h. A download that cannot be told apart (a notice while the admin
 * chose to keep waiting), a loss (an error after 6 h), a download whose client was deleted: said. A hold the folder refuses,
 * dates that could not be set, held files that went away: errors; held files older than 30 min: a warning; a download held
 * a day after it arrived: a warning with what its search waits for. Never the folder's path: the admin knows it as
 * downloads/finished.
 */
export async function arrivalsHealth(nowSec: number = sec()): Promise<RemoteHealth[]> {
  const out: RemoteHealth[] = [];
  const link = "/activity/queue", set = "/settings/mediamanagement", source = "FinishedDownloads";
  const arriving = stmts.fetchesByState.all("arriving") as FetchRow[];
  const dir = arrivalsSetting();
  if (dir) {
    const st = await stat(dir).catch(() => null);
    const off = "new downloads are transferred from the seedbox as before";
    if (!st) {
      if (configSource(ARRIVALS_KEY) !== "default" || arriving.length) out.push({ type: "error", source, message: `${HERE} is missing: ${off} — mount that folder into the container, or empty "Finished downloads land in"`, link: set });
    } else if (!st.isDirectory()) out.push({ type: "error", source, message: `${HERE} is not a folder: ${off}`, link: set });
    else if (rcloneMount(adeps.mountInfo(), resolve(dir))) out.push({ type: "error", source, message: `${HERE} is an rclone mount of the seedbox: it must be the folder your own sync fills on this server`, link: set });
    else if (!(await access(dir, FS.W_OK).then(() => true, () => false))) out.push({ type: "error", source, message: `${HERE} is not writable: ludarr refreshes the dates of the downloads it imports there so the folder's cleanup leaves them until the import is done`, link: set });
  }
  // a download client's remote path onto the folder: it is not the seedbox's folder (src/remote.ts leaves it out meanwhile)
  const on = arrivalsDir();
  for (const m of on ? clientMappings() : []) {
    if (overArrivals(m.to, on)) out.push({ type: "error", source, message: `${m.client}'s remote path points into ${HERE}, which is not the seedbox: it is ignored (and importing from the seedbox instead is not offered) until it is the seedbox's own folder as mounted here, or empty`, link: "/settings/downloadclients" });
  }
  for (const f of arriving) {
    const a = arrivalOf(f);
    if (!a || a.stopped || a.via === "seedbox") continue;
    const long = nowSec - a.since;
    const deferred = !a.ask && a.askAgainAt != null && nowSec < a.askAgainAt;
    const put = deferred ? ` — you chose to keep waiting (asked again at ${clock(a.askAgainAt!)})` : " — see Activity → Queue";
    if (a.orphan) out.push({ type: "error", source, message: `${f.title}: its download client was deleted under Settings, so nothing more can arrive for it — cancel its search (Activity → Queue)`, link });
    else if (a.lost) out.push({ type: deferred ? "notice" : nowSec - a.lost.at >= ASK_AFTER_SEC ? "error" : "warning", source, message: `${f.title} left ${HERE} before its import (${clock(a.lost.at)})${f.protocol === "usenet" && a.regrabs < 1 && !a.ask ? ": it is downloaded again" : put}`, link });
    else if (a.trouble) out.push({ type: deferred ? "notice" : long >= ASK_AFTER_SEC ? "error" : "warning", source, message: `${f.title}: ${a.troubleWords}${put}`, link });
    else if (f.protocol === "torrent" && !a.from && long >= NOTHING_WARN_SEC) out.push({ type: deferred ? "notice" : long >= ASK_AFTER_SEC ? "error" : "warning", source, message: `${nameOf(f)} has not listed the files of ${f.title} since it finished (${clock(a.since)}): without that list ludarr cannot tell them in ${HERE}${a.guess ? ` (what is in ${tail(a.guess)} is kept meanwhile)` : ""}`, link });
    else if (a.seenAt == null && long >= NOTHING_WARN_SEC) out.push({ type: deferred ? "notice" : long >= ASK_AFTER_SEC ? "error" : "warning", source, message: `${f.title} finished on the seedbox at ${clock(a.since)} and nothing of it has reached ${HERE} since — is the sync running?`, link });
    else if (long >= WARN_AFTER_SEC) out.push({ type: deferred ? "notice" : long >= ASK_AFTER_SEC ? "error" : "warning", source, message: `${f.title} has not fully arrived in ${HERE} since ${clock(a.since)}${deferred ? put : ""}`, link });
  }
  for (const f of heldQ.all() as HeldRow[]) {
    const a = arrivalOf(f);
    if (!a?.hold || a.hold.released != null) continue;
    if (a.hold.denied) out.push({ type: "error", source, message: `${HERE} refuses new dates on the files of ${f.title} (${a.hold.denied}): its cleanup may delete them before the import`, link: set });
    if (a.hold.failed) out.push({ type: "error", source, message: `ludarr could not set the dates of ${a.hold.failed.n || "the"} file${a.hold.failed.n === 1 ? "" : "s"} of ${f.title} in ${HERE} since ${clock(Math.floor(a.hold.failed.at / 1000))} (${a.hold.failed.code}): its cleanup may delete them before the import — it keeps trying`, link: set });
    if (a.hold.gone && a.hold.goneAt) out.push({ type: "error", source, message: `files of ${f.title} were deleted from ${HERE} while ludarr held them (${clock(Math.floor(a.hold.goneAt / 1000))})`, link });
    // only files the hold already set a date on say whether it refreshes (one that just landed is held at the next look)
    const m = mem.get(f.id);
    const sample = m ? ((await heldFiles(f, a).catch(() => null)) ?? []).filter(p => m.touched.has(p)).slice(0, 20) : [];
    let oldest = Infinity;
    for (const p of sample) { const st = await stat(p).catch(() => null); if (st) oldest = Math.min(oldest, st.mtimeMs); }
    if (oldest < nowSec * 1000 - HELD_OLD_MS) out.push({ type: "warning", source, message: `files of ${f.title} in ${HERE} are older than 30 minutes although ludarr holds them: their dates are not being refreshed`, link });
    // a download that arrived and is still held a day on (its search waits: for the AI importer's key, an answer …) — not one
    // that is imported and only waits for its removal (said below when that keeps failing, or is held up a day)
    if (f.state === "done" && !(f.imported_at != null && awaitsRemoval(f, a)) && nowSec * 1000 - a.hold.since >= HELD_LONG_SEC * 1000) {
      const r = requestStageQ.get(f.id) as { stage: string | null } | undefined;
      out.push({ type: "warning", source, message: `${f.title} has been kept in ${HERE} since ${new Date(a.hold.since).toLocaleDateString()} (its files' dates are refreshed so the folder's cleanup leaves them): its search ${r?.stage ? `waits — ${r.stage}` : "is not done with it"}; once it is imported, ludarr removes it from there`, link });
    }
  }
  // a removal that keeps failing, or held up for a day (another download of its name awaited there, a job reading it, the
  // setting changed …) — said without a path: nothing else waits on it
  for (const f of removalQ.all() as FetchRow[]) {
    const r = arrivalOf(f)?.rm;
    if (r?.state === "waiting" && r.waitAt != null && nowSec - r.waitAt >= HELD_LONG_SEC) out.push({ type: "warning", source, message: `${f.title}: ludarr has been waiting since ${new Date(r.waitAt * 1000).toLocaleDateString()} to delete its own download from ${HERE} (${r.why})`, link: "/activity/queue" });
    if (r?.state !== "due" || !r.code || r.tries < REMOVAL_WARN_TRIES) continue;
    out.push({ type: "warning", source, message: `${f.title} is imported, but ludarr could not delete its own download from ${HERE} (${r.code} since ${clock(r.since ?? nowSec)}): it keeps trying, and nothing else waits on it`, link: "/activity/history" });
  }
  return out;
}

/** is this folder (or what it sits on) an rclone FUSE mount */
function rcloneMount(text: string, at0: string): boolean {
  const path = at0.replace(/\\/g, "/");
  let best: { at: string; fstype: string } | null = null;
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    const dash = f.indexOf("-");
    if (f.length < 10 || dash < 6) continue;
    const at = f[4].replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (!(path === at || path.startsWith(at.endsWith("/") ? at : `${at}/`))) continue;
    if (!best || at.length >= best.at.length) best = { at, fstype: f[dash + 1] ?? "" };
  }
  return !!best && /rclone/i.test(best.fstype);
}

/* ─────────── what ludarr left there before: listed, and removed only with the admin's OK ─────────── */

/** a download's name as its client knew it: the last part of where it kept it (a torrent's, NZBGet's folder's) */
const rowName = (f: Pick<FetchRow, "seedbox_path" | "title">): string => basename(String(f.seedbox_path ?? f.title).replace(/[\\/]+$/, ""));

/** what a download's client listed of it, file by file, as paths inside the folder it lands in (null: nothing to go by): a
 *  torrent's list as rTorrent gave it, or as its .torrent has it (named as its client names it); a usenet download's NZBGet
 *  folder as the client's mount showed it */
function clientList(f: Pick<FetchRow, "protocol" | "files_json">, a: Pick<Arrival, "from"> | null, name: string): ArrivalFile[] | null {
  let l: ArrivalFile[] | null = null;
  try {
    const v = f.files_json ? (JSON.parse(f.files_json) as ArrivalFile[]) : null;
    l = Array.isArray(v) && v.length && v.every(x => typeof x?.p === "string" && !!x.p && Number.isFinite(x?.s)) ? v : null;
  } catch { l = null; }
  if (!l) return null;
  if (f.protocol === "usenet") return a?.from === "seedbox" ? l : null;
  if (a?.from === "client" || a?.from === "grab") return l;                // the list its arrival looked for: named so already
  const top = l[0].p.split("/")[0];
  return top === name ? l : l.map(x => ({ p: name + x.p.slice(top.length), s: x.s }));
}

/** a download of ludarr's still in the finished-downloads folder whose search is over */
export interface Leftover {
  fetchId: number;
  state: string;
  title: string;
  game: string | null;
  /** its import went through (`importState` "imported", or "replaced": the game's copy is no longer the one it made); else
   *  "failed", "cancelled", or "none" (none ran on it) */
  imported: boolean;
  importState: "imported" | "replaced" | "failed" | "cancelled" | "none";
  /** what it is matched against: what was taken there, file by file ("taken"); what its client listed, file by file
   *  ("client"); the import's own record of what it read — its number of files, their bytes, its largest files ("import");
   *  once nothing of what it took is there and its client's list matches nothing, what is left in its own folder ("folder") */
  against: "taken" | "client" | "import" | "folder" | null;
  /** where it is, inside the finished-downloads folder */
  place: string;
  /** its files there that are exactly what was taken (or listed), inside the finished-downloads folder, and their bytes */
  files: { p: string; s: number }[];
  bytes: number;
  /** of `files`, those nothing shows to be its own (paths inside the finished-downloads folder): what it took that its client's
   *  list does not have, and whatever is left in its own folder — removed with the rest on the admin's OK, so they are named */
  unproven: string[];
  /** why any of it is unsafe — nothing of it is removed while one holds: two places, files of its names at other sizes, a
   *  file being written, its search or a job still on it, another download of ludarr's there, nothing to go by */
  unsafe: string[];
  /** what would stay, and why: other files in its folder (and so the folder), a folder others share, files no longer there */
  stays: string[];
  /** the removal would delete exactly `files`, then the folders that leaves empty inside its own folder */
  removable: boolean;
}

/** where a leftover was found and how it compares (paths: absolute for the place and its own folder; `files` inside the place;
 *  the rest inside the finished-downloads folder) */
interface Found {
  against: "taken" | "client" | "import" | "folder";
  place: string; own: string | null;
  files: [string, number][];
  /** of `files`, those nothing shows to be its own (their paths inside the place) */
  unproven: Set<string>;
  differ: string[]; others: string[]; missing: number; parts: boolean;
  two: string[] | null; shared: boolean; mismatch: string | null;
}
const noFound = (against: Found["against"], place: string): Found => ({ against, place, own: null, files: [], unproven: new Set(), differ: [], others: [], missing: 0, parts: false, two: null, shared: false, mismatch: null });

/** every file and link under a folder (absolute paths; part files too), at most 50,000 */
async function everything(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [] as Dirent[])) {
      if (out.length >= 50_000) return;
      if (e.isDirectory()) await walk(join(d, e.name)); else out.push(join(d, e.name));
    }
  };
  await walk(dir);
  return out;
}

/** a leftover by what was taken: its place is known, each file looked at where it was (what it took that nothing shows to be its
 *  own is said so) — null once none of it is there */
async function byTaken(t: Taken, root: string): Promise<Found | null> {
  if (resolve(t.root) !== resolve(root)) return null;                      // taken from a folder that is not this one
  const path = resolve(t.path), x = noFound("taken", path);
  x.own = t.own ? resolve(t.own) : null;
  const mine = new Set<string>();
  const all: [string, number, boolean][] = [...t.files.map(([p, s]) => [p, s, true] as [string, number, boolean]), ...(t.unproven ?? []).map(([p, s]) => [p, s, false] as [string, number, boolean])];
  for (const [rel, s, own] of all) {
    const p = rel ? join(path, ...rel.split("/")) : path;
    mine.add(resolve(p));
    const st = await lstat(p).catch(() => null);
    if (!st) { x.missing++; continue; }
    if (st.isFile() && st.size === s) { x.files.push([rel, s]); if (!own) x.unproven.add(rel); } else x.differ.push(posix(relative(root, p)));
  }
  if (!x.files.length && !x.differ.length) return null;
  const dir = x.own ?? (all.length === 1 && all[0][0] === "" ? null : path);
  // anything else in its own folder stays; a part being written there makes it unsafe — one left for dead (an rclone run that
  // died) only stays
  const nowMs = adeps.now();
  if (dir) for (const p of await everything(dir)) {
    if (mine.has(resolve(p))) continue;
    if (p.endsWith(".partial") && (await livePart(dirname(p), basename(p), null, nowMs))) x.parts = true;
    else x.others.push(posix(relative(root, p)));
  }
  x.shared = !x.own;
  return x;
}

/** a leftover by what is left in its own folder, once nothing of what it took there is (the rest of a download that came after
 *  its removal, a file renamed into place while it was removed): every plain file there, none of them shown to be its own — a
 *  part being written makes it unsafe; never through a link */
async function byFolder(t: Taken, root: string): Promise<Found | null> {
  if (!t.own || resolve(t.root) !== resolve(root)) return null;
  const own = resolve(t.own);
  const real = await adeps.realpath(own).catch(() => null), realRoot = await adeps.realpath(root).catch(() => null);
  if (!real || !realRoot || !samePath(relative(realRoot, real), relative(root, own))) return null;
  const x = noFound("folder", own);
  x.own = own;
  const nowMs = adeps.now();
  for (const p of await everything(own)) {
    if (p.endsWith(".partial") && (await livePart(dirname(p), basename(p), null, nowMs))) { x.parts = true; continue; }
    const st = await lstat(p).catch(() => null);
    if (!st) continue;
    const rel = posix(relative(own, p));
    if (st.isFile() && !p.endsWith(".partial")) { x.files.push([rel, st.size]); x.unproven.add(rel); }
    else x.others.push(posix(relative(root, p)));                       // a link, a part left for dead: it stays, and so does the folder
  }
  return x.files.length || x.parts ? x : null;
}

/** a torrent leftover by its client's list: the places of its name that hold any of it (two: nothing is touched) */
async function byTorrentList(name: string, ref: ArrivalFile[], root: string): Promise<Found | null> {
  const tree = treeOf(ref), nowMs = adeps.now();
  const looks: (Look & { shared: boolean })[] = [];
  for (const c of await containersOf({ name, alt: null }, root)) { const l = await lookIn(c.at, tree, c.shared, null, nowMs); if (l.found.size || l.wrong.length) looks.push({ ...l, shared: c.shared }); }
  if (!looks.length) return null;
  const x = noFound("client", join(looks[0].at, name));
  if (looks.length > 1) { x.two = looks.map(l => inFolder(root, join(l.at, name))).sort(); return x; }
  const l = looks[0], under = (rel: string) => posix(relative(root, join(l.at, ...rel.split("/"))));
  x.files = [...l.found].map(([p, s]) => [p === name ? "" : p.slice(name.length + 1), s]);
  x.differ = l.wrong.map(w => under(w.p));
  x.others = l.others.map(under);
  x.missing = ref.length - l.found.size - l.wrong.length;
  x.parts = l.parts.length > 0;
  const own = taking({ protocol: "torrent" }, { path: x.place, container: l.at, name }, root, x.files, "leftover", 0).own;
  x.own = own; x.shared = !own;
  return x;
}

/** a usenet leftover by NZBGet's folder as its client's mount showed it: the one folder of its names (two: nothing is touched) */
async function byUsenetList(names: string[], ref: ArrivalFile[], root: string): Promise<Found | null> {
  const found = await foldersNamed(root, names);
  if (!found.length) return null;
  const x = noFound("client", found[0]);
  if (found.length > 1) { x.two = found.map(p => inFolder(root, p)).sort(); return x; }
  const w = await walkItem(found[0], adeps.now());
  if (!w) return null;
  const nest = resolve(dirname(found[0])) === resolve(root) ? names : [];
  const matched = new Set<string>();
  for (const r of ref) {
    const at = w.files.has(r.p) ? r.p : nest.map(n => `${n}/${r.p}`).find(q => w.files.has(q));
    if (at == null) { x.missing++; continue; }
    matched.add(at);
    if (w.files.get(at) === r.s) x.files.push([at, r.s]); else x.differ.push(posix(relative(root, join(found[0], ...at.split("/")))));
  }
  if (!x.files.length && !x.differ.length) return null;
  x.others = [...w.files.keys()].filter(p => !matched.has(p)).map(p => posix(relative(root, join(found[0], ...p.split("/")))));
  x.parts = w.parts || w.unpack;
  x.own = found[0];
  return x;
}

/** what a download's import read, as the import's own record has it (jobs.fingerprint_json: its files, bytes, largest files) */
const importReadQ = db.query("SELECT fingerprint_json FROM jobs WHERE fetch_id=? AND COALESCE(kind, 'import')='import' AND fingerprint_json IS NOT NULL ORDER BY id DESC LIMIT 1");

/** a leftover by its import's own record (no list of its files kept): the place of its name whose files are exactly as many,
 *  as heavy, and hold its largest at their sizes — the rest of the record cannot tell it file by file, so anything else in
 *  that place makes it not that download */
async function byImport(f: Pick<FetchRow, "id" | "protocol">, name: string, names: string[], root: string): Promise<Found | null> {
  type Read = { files?: number; bytes?: number; largest?: { rel?: string; size?: number }[] };
  let rec: Read | null = null;
  try { rec = (JSON.parse((importReadQ.get(f.id) as { fingerprint_json: string } | undefined)?.fingerprint_json ?? "null") as { input?: Read | null } | null)?.input ?? null; } catch { rec = null; }
  // the places of its name: a torrent's entry in each folder that may hold it, a usenet download's folder
  const places: { p: string; container: string }[] = [];
  if (f.protocol === "torrent") { for (const c of await containersOf({ name, alt: null }, root)) if (await there(join(c.at, name))) places.push({ p: join(c.at, name), container: c.at }); }
  else for (const p of await foldersNamed(root, names)) places.push({ p, container: dirname(p) });
  // nothing says what its files were (no list from its client, no record of its import): a place of its name is not shown to
  // be ludarr's at all — it may well be the admin's own — and is never listed
  if (!places.length || !rec || !Number.isFinite(rec.files) || !Number.isFinite(rec.bytes)) return null;
  const x = noFound("import", places[0].p);
  const fits: { p: string; container: string; list: [string, number][] }[] = [];
  let seen: string | null = null;
  for (const c of places) {
    const list = await listTaken(c.p).catch(() => null);
    if (!list) continue;
    const bytes = list.reduce((s, y) => s + y[1], 0);
    // (a folder nested in one of its name, <folder>/<name>/<name>: what the import read as <p> is <name>/<p> here)
    const top = `${basename(c.p)}/`, nested = list.length > 0 && list.every(([p]) => p.startsWith(top));
    const at = new Map(list.map(([p, s]) => [p === "" ? basename(c.p) : nested ? p.slice(top.length) : p, s] as const));
    if (list.length === rec.files && bytes === rec.bytes && (rec.largest ?? []).every(y => typeof y.rel === "string" && at.get(y.rel) === y.size)) fits.push({ ...c, list });
    else seen ??= `${list.length} file${list.length === 1 ? "" : "s"}, ${gb(bytes)} there; its import read ${rec.files}, ${gb(rec.bytes!)}`;
  }
  // the nested shape is one download seen twice: <folder>/<name> holding only <name> (a folder, or its single file) is read as
  // itself (its files under <name>/) and as <folder>/<name>/<name> — the inner one, in a folder of its own name, is it, as an
  // arrival takes it (2026-11-10: every older torrent of ludarr's in downloads/finished has this shape and was "in 2 places")
  const one = <T extends { p: string; container: string }>(l: T[]): T[] => l.filter(c => !l.some(o => o !== c && samePath(resolve(o.container), resolve(c.p))));
  const fit = one(fits), at = one(places);
  if (fit.length > 1) { x.two = fit.map(c => inFolder(root, c.p)).sort(); return x; }
  if (!fit.length) { if (at.length > 1) x.two = at.map(c => inFolder(root, c.p)).sort(); else x.mismatch = `a place of its name holds other files than its import read (${seen ?? "it could not be read"})`; return x; }
  const c = fit[0];
  x.place = c.p; x.files = c.list;
  x.own = taking(f, { path: c.p, container: c.container, name }, root, c.list, "leftover", 0).own;
  x.shared = !x.own;
  return x;
}

/** downloads of ludarr's whose search is over (imported, failed, its copy since replaced), the newest first */
const leftoverRowsQ = db.query("SELECT * FROM fetches WHERE state IN ('done', 'failed') ORDER BY id DESC");
/** a stopped wait on the download: Retry would take it up again */
const stoppedSearchQ = db.query("SELECT 1 FROM requests WHERE fetch_id=? AND state='failed' AND remote_json LIKE '%\"stopped\":true%' LIMIT 1");

/** its import, as the leftovers list says it: the latest job its search ran on it, and whether the game's copy is still the one
 *  it made */
function importStateOf(f: FetchRow): Leftover["importState"] {
  const j = (searchJobsQ.all(f.id, f.id) as SearchJob[]).find(x => !specOf(x)?.earlier);
  if (!j) return "none";
  if (j.state === "cancelled") return "cancelled";
  if (j.state !== "done" || f.imported_at == null) return j.state === "failed" ? "failed" : "none";
  const r = searchOfQ.get(f.id) as { state: string; package_id: number | null } | undefined;
  if ((j.kind ?? "import") === "content" && (outcomeOf(j) !== "proven" || r?.state !== "ready")) return "failed";
  const made = (j.kind ?? "import") === "import" ? (stmts.packageForJob.get(j.id) as PackageRow | undefined) : r?.package_id != null ? (stmts.packageById.get(r.package_id) as PackageRow | undefined) : undefined;
  return made ? "imported" : "replaced";
}

/** one download's leftover, and what its removal would follow (null: nothing of it there, or its search is not over) */
async function leftoverOf(f: FetchRow, root: string, ins: string[]): Promise<{ l: Leftover; plan: Taken | null } | null> {
  if (f.state !== "done" && f.state !== "failed") return null;
  const busy = busyQ.get(f.id, f.id, f.id) as { search: number; job: number };
  if (busy.search) return null;                                              // its search is not over: not a leftover
  const a = arrivalOf(f);
  if (a && f.imported_at != null && awaitsRemoval(f, a)) return null;       // imported: ludarr removes it by itself
  const name = a?.name ?? rowName(f);
  const names = namesOf(a ?? { name, alt: null });
  if (!names.length) return null;
  const mine = a ? takenFor(f, a) : null;
  const before = parseTaken(f.took_json);
  const t = mine ?? (before?.how === "leftover" ? before : null);
  let x: Found | null = t ? await byTaken(t, root) : null;
  // nothing of what it took is there (or nothing was written down): what its client listed — and for one taken there before,
  // what is left in its own folder (what came after its removal)
  if (!x) {
    const ref = clientList(f, a, name);
    if (ref?.length) x = f.protocol === "torrent" ? await byTorrentList(name, ref, root) : await byUsenetList(names, ref, root);
    else if (!t) x = await byImport(f, name, names, root);
  }
  if (!x && t) x = await byFolder(t, root);
  if (!x) return null;
  const words = x.against === "taken" ? "what was taken" : x.against === "client" ? "what its client listed" : "what its import read";
  const unsafe: string[] = [], stays: string[] = [];
  const few = (l: string[]) => `${l.slice(0, 3).join(", ")}${l.length > 3 ? " …" : ""}`;
  if (x.two) unsafe.push(`it could be in ${x.two.length} places (${few(x.two)}): nothing of it is touched`);
  if (x.mismatch) unsafe.push(x.mismatch);
  if (x.differ.length) unsafe.push(`${x.differ.length} file${x.differ.length === 1 ? "" : "s"} of its names ${x.differ.length === 1 ? "is" : "are"} not at the size of ${words} (${few(x.differ)})`);
  if (x.parts) unsafe.push("a file in its folder is still being written");
  if (busy.job || ins.some(p => overlaps(p, x!.place))) unsafe.push("a job still reads it");
  const other = claimedBy(f.id, root, x.place);
  if (other) unsafe.push(other);
  if (stoppedSearchQ.get(f.id)) unsafe.push("its search stopped waiting, and Retry would import it: cancel that search first (Activity → Queue)");
  if (x.others.length) stays.push(`${x.others.length} other file${x.others.length === 1 ? "" : "s"} in its folder stay${x.others.length === 1 ? "s" : ""} (${few(x.others)}), and so does the folder`);
  if (x.shared && x.files.length) stays.push("it sits in a folder others share: only its own files go");
  if (x.missing) stays.push(`${x.missing} of its files ${x.missing === 1 ? "is" : "are"} no longer there`);
  const g = f.game_id != null ? (stmts.gameById.get(f.game_id) as GameRow | undefined) : undefined;
  const importState = importStateOf(f);
  const at = (rel: string) => posix(relative(root, rel ? join(x!.place, ...rel.split("/")) : x!.place));
  const files = x.files.map(([rel, s]) => ({ p: at(rel), s }));
  const removable = !unsafe.length && files.length > 0;
  // what the admin's OK removes is exactly what is listed here: those files, then the folders that leaves empty in its own
  const plan: Taken | null = !removable ? null : { v: 1, at: sec(), how: "leftover", root: resolve(root), path: resolve(x.place), own: x.own, files: x.files };
  return {
    l: { fetchId: f.id, state: f.state, title: f.title, game: g?.name ?? null, imported: importState === "imported" || importState === "replaced", importState, against: x.against,
      place: inFolder(root, x.place), files, bytes: files.reduce((s, y) => s + y.s, 0), unproven: x.files.filter(([rel]) => x!.unproven.has(rel)).map(([rel]) => at(rel)), unsafe, stays, removable },
    plan,
  };
}

/** the finished-downloads folder the leftovers are listed in and removed from — never one that is not there, nor an rclone mount
 *  of the seedbox (that is the seedbox's own folder) */
function leftoversRoot(): string {
  const root = arrivalsDir();
  if (!root) throw new ArrivalError(`${HERE} is not there`, 409);
  if (rcloneMount(adeps.mountInfo(), resolve(root))) throw new ArrivalError(`${HERE} is an rclone mount of the seedbox: nothing of ludarr's there is listed or removed`, 409);
  return root;
}

/** the names at the top of the finished-downloads folder and one level in (a download of ludarr's is looked for only when one
 *  of its names is among them) */
async function namesHere(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of await readdir(root, { withFileTypes: true })) {
    out.add(e.name);
    if (e.isDirectory()) for (const n of await readdir(join(root, e.name)).catch(() => [] as string[])) out.add(n);
  }
  return out;
}

/**
 * ludarr's own downloads still in the finished-downloads folder whose search is over — imported, failed, or their copy since
 * replaced — found there by the same name rules as an arrival (two levels deep, never deeper), each matched against what was
 * taken there (file by file), else what its client listed (file by file), else its import's own record of what it read (its
 * number of files, their bytes, its largest files); one taken there whose files are all gone, by what is left in its own
 * folder. A place of its name with nothing that says what its files were is never listed. What nothing shows to be its own is
 * named (`unproven`). Read only: nothing is touched, held or written. `ids`: only these.
 */
export async function listLeftovers(o: { ids?: number[] } = {}): Promise<Leftover[]> {
  const root = leftoversRoot();
  const here = await namesHere(root);
  const ins = readingNow();
  const rows = o.ids ? o.ids.map(id => stmts.fetchById.get(id) as FetchRow | undefined).filter((f): f is FetchRow => !!f) : (leftoverRowsQ.all() as FetchRow[]);
  const out: Leftover[] = [];
  for (const f of rows) {
    const a = arrivalOf(f);
    if (!namesOf(a ?? { name: rowName(f), alt: null }).some(n => here.has(n))) continue;
    const x = await leftoverOf(f, root, ins).catch(e => { adeps.log(`#${f.id} could not be looked for in ${HERE}: ${messageOf(e)}`); return null; });
    if (x) out.push(x.l);
  }
  // the same files listed for two downloads (the same release fetched twice): said on both
  for (const l of out) {
    const same = out.filter(o2 => o2 !== l && o2.place === l.place).map(o2 => `#${o2.fetchId}`);
    if (same.length) l.stays.push(`the same place is listed for ${same.join(", ")} too`);
  }
  return out;
}

/** what removeLeftovers did for one download (or, dry, would do) */
export interface LeftoverRemoval { fetchId: number; dry: boolean; removed: boolean; words: string; files: string[]; dirs: string[] }

/**
 * The admin's OK for these downloads (fetch ids from listLeftovers): each is looked at again and removed by the same rules as
 * the removal once imported — exactly the files the list shows for it (what was taken, or what its client listed, or the
 * files that matched its import's record, or what is left in its own folder) at their paths and sizes, as plain files reached
 * through real folders, then the folders that leaves empty inside its own folder only; never the finished-downloads folder, a
 * folder it shares or one holding anything else; nothing while two places could be it, a file of its names is at another size,
 * something is being written, its search or a job is still on it, or another download of ludarr's is there. A dry run unless
 * `yes`: then what goes is written down first (fetches.took_json, so a removal cut short goes on by the same list), and the
 * history says what went.
 */
export async function removeLeftovers(ids: number[], o: { yes?: boolean } = {}): Promise<LeftoverRemoval[]> {
  const root = leftoversRoot();
  const dry = !o.yes, ins = readingNow(), out: LeftoverRemoval[] = [];
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  for (const id of [...new Set(ids)]) {
    const f = stmts.fetchById.get(id) as FetchRow | undefined;
    const x = f ? await leftoverOf(f, root, ins).catch(() => null) : null;
    const no = (words: string): LeftoverRemoval => ({ fetchId: id, dry, removed: false, words, files: [], dirs: [] });
    if (!f || !x) { out.push(no(`nothing of it is in ${HERE}, or its search is not over`)); continue; }
    if (!x.l.removable || !x.plan) { out.push(no(`not removed: ${x.l.unsafe.join("; ") || "nothing of it matches"}`)); continue; }
    let s: Swept;
    try {
      if (!dry) stmts.setFetchTook.run(JSON.stringify(x.plan), id);
      s = await sweep(x.plan, { dry });
    } catch (e) { out.push(no(`not removed: ${e instanceof Unsafe || e instanceof NotNow ? e.message : `${HERE} could not be read (${codeOf(e) || messageOf(e)})`}`)); continue; }
    const tail2 = `${s.gone ? `; ${s.gone} already gone` : ""}${s.changed ? `; ${files(s.changed)} changed since and stay${s.changedAt.length ? ` (${s.changedAt.join(", ")})` : ""}` : ""}${s.kept ? `; its folder stays: something else is still in it${s.others.length ? ` (${s.others.join(", ")})` : ""}` : ""}${s.failed ? `; ${files(s.failed)} could not be deleted (${s.code}): run it again` : ""}${s.busy ? "; a folder is still held open: run it again" : ""}`;
    if (dry) { out.push({ fetchId: id, dry, removed: false, words: `would remove ${files(s.removed)} (${gb(s.bytes)})${s.dirs ? ` and ${s.dirs} folder${s.dirs === 1 ? "" : "s"}` : ""}${tail2}`, files: s.would?.files ?? [], dirs: s.would?.dirs ?? [] }); continue; }
    const words = `removed from ${HERE} with your OK: ludarr's own download, left there before (${files(s.removed)}, ${gb(s.bytes)})${tail2}`;
    adeps.log(`#${id} ${f.title}: ${words}`);
    if (s.removed || s.dirs) record(f.game_id, "removed", { release: f.title, source: SOURCE, message: words });
    out.push({ fetchId: id, dry, removed: s.removed > 0 || s.dirs > 0, words, files: [], dirs: [] });
  }
  return out;
}
