/**
 * ludarr — database (bun:sqlite, WAL) in <config>/ludarr.db
 *
 *   games            the library: monitored titles with a profile and a root folder
 *   packages         the game files: one imported, verified copy per game (an *arr "file")
 *   requests         a search in flight for a game (matching → fetching → processing → ready)
 *   fetches          the queue: one row per grab, through the download client to this machine
 *   jobs             imports: a finished download → an installed game folder
 *   history          what happened to each game (grabbed, downloaded, imported, failed, deleted …)
 *   blocklist        releases that must never be grabbed again
 *   root_folders     where games live; profiles — what to grab and what counts as good enough
 *   titles/routes    the catalog (every game and every way to play it), see catalog/store.ts
 *   kv               settings and caches
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { formerName } from "./former";
import type { FailInfo } from "./ways/types";
import { PLATFORM_LABEL, platformChoices, wantedPlatform } from "./platforms";

/** <config>/ludarr.db — or the database a server made under the engine's old name, while that is the only one there */
export function databaseFile(dir: string): string {
  const now = join(dir, "ludarr.db"), old = join(dir, formerName("ludarr.db"));
  return !existsSync(now) && existsSync(old) ? old : now;
}
const dbPath = process.env.DB_PATH || databaseFile(process.env.LUDARR_CONFIG || process.env.CONFIG_DIR || ".");
if (dbPath !== ":memory:") { try { mkdirSync(join(dbPath, ".."), { recursive: true }); } catch { /* exists */ } }
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
// SQLite's automatic passive checkpoints allow imports, backups and API readers to overlap.
db.exec("PRAGMA wal_autocheckpoint = 1000;");

export function busyDatabase(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? "";
  return /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code);
}

/** Progress and transcript writes can be retried on the next update; job state transitions cannot. */
export function recordWhenAvailable(write: () => void): boolean {
  try { write(); return true; }
  catch (error) { if (busyDatabase(error)) return false; throw error; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  igdb_id INTEGER UNIQUE,
  steam_appid INTEGER UNIQUE,
  name TEXT NOT NULL,
  slug TEXT,
  summary TEXT,
  storyline TEXT,
  release_year INTEGER,
  first_release_date INTEGER,        -- unix ts
  rating REAL,                        -- IGDB total_rating 0..100
  cover_url TEXT,
  banner_url TEXT,                    -- hi-res artwork for billboards
  screenshots_json TEXT DEFAULT '[]', -- [url,...]
  genres_json TEXT DEFAULT '[]',
  themes_json TEXT DEFAULT '[]',
  platforms_json TEXT DEFAULT '[]',
  game_modes_json TEXT DEFAULT '[]',
  developer TEXT,
  publisher TEXT,
  source TEXT DEFAULT 'steam',       -- 'steam' (keyless) or 'igdb'
  crew_visible INTEGER DEFAULT 1,     -- shown in crew lens
  onboarded_at INTEGER,               -- when added
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_games_slug ON games(slug);
CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS fetches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  guid TEXT,
  indexer_id INTEGER,
  indexer TEXT,
  title TEXT NOT NULL,
  protocol TEXT NOT NULL,             -- torrent | usenet
  size INTEGER,                       -- bytes, best known
  info_hash TEXT,                     -- torrents only, uppercase hex
  client TEXT NOT NULL,               -- rtorrent | nzbget
  client_id TEXT,                     -- info-hash / NZBID on the seedbox
  state TEXT NOT NULL DEFAULT 'submitted',
  progress REAL DEFAULT 0,            -- 0..1 of the current stage
  seedbox_path TEXT,                  -- where the payload landed on the seedbox
  seedbox_is_dir INTEGER DEFAULT 1,
  local_path TEXT,                    -- where it landed here
  message TEXT,                       -- last status / warning / error text
  release_json TEXT,                  -- the Prowlarr release as grabbed
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fetches_state ON fetches(state);
CREATE INDEX IF NOT EXISTS idx_fetches_hash ON fetches(info_hash);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER,
  fetch_id INTEGER REFERENCES fetches(id) ON DELETE SET NULL,
  game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  input_path TEXT NOT NULL,            -- what landed in AHOY_DOWNLOADS
  output_path TEXT,                    -- the finished package folder
  state TEXT NOT NULL DEFAULT 'queued',-- queued | running | done | failed | cancelled
  tier TEXT,                           -- deterministic | agent (whichever was last at work)
  progress REAL DEFAULT 0,
  message TEXT,
  transcript TEXT DEFAULT '',          -- everything the processor did, both tiers
  manifest_json TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  path TEXT NOT NULL,                  -- folder in the root folder (<root>/<slug>)
  name TEXT NOT NULL,
  version TEXT,
  size INTEGER,
  manifest_json TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'requested',  -- requested | matching | fetching | processing | ready | failed | cancelled
  stage TEXT,                               -- one human line for the UI
  progress REAL DEFAULT 0,                  -- 0..1 across the whole journey
  message TEXT,                             -- why it failed / warnings
  candidates_json TEXT,                     -- ranked releases to try, in order
  attempt INTEGER DEFAULT 0,                -- index of the candidate being tried
  release_json TEXT,                        -- the one currently in flight
  fetch_id INTEGER REFERENCES fetches(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  next_try_at INTEGER,                      -- when nothing suitable exists yet: look again then
  requested_by TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requests_state ON requests(state);
CREATE INDEX IF NOT EXISTS idx_requests_game ON requests(game_id);

CREATE TABLE IF NOT EXISTS catalog (
  steam_appid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  coming_soon INTEGER DEFAULT 0,
  release_text TEXT,
  release_iso TEXT,                         -- YYYY-MM-DD when the date is exact
  release_sort TEXT,                        -- YYYY-MM-DD for ordering even when approximate (quarter/year)
  genres_json TEXT DEFAULT '[]',
  short_description TEXT,
  metacritic INTEGER,
  header_image TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  auto_request INTEGER DEFAULT 1,           -- request it the day it is out
  release_iso TEXT,
  release_text TEXT,
  coming_soon INTEGER DEFAULT 1,
  checked_at INTEGER,
  requested_at INTEGER,
  request_id INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS root_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
  event TEXT NOT NULL,                 -- grabbed | downloaded | imported | importFailed | failed | deleted | upgraded | blocklisted
  release TEXT,
  source TEXT,                         -- indexer / client / importer name
  message TEXT,
  data_json TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_history_game ON history(game_id, id);

CREATE TABLE IF NOT EXISTS blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
  guid TEXT,
  title TEXT NOT NULL,
  indexer TEXT,
  reason TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_blocklist_game ON blocklist(game_id);
`);
/* columns added after the first release — idempotent */
for (const ddl of ["ALTER TABLE fetches ADD COLUMN rate INTEGER DEFAULT 0",
  "ALTER TABLE games ADD COLUMN coming_soon INTEGER DEFAULT 0", "ALTER TABLE games ADD COLUMN release_text TEXT", "ALTER TABLE games ADD COLUMN release_iso TEXT",
  "ALTER TABLE requests ADD COLUMN tried_json TEXT",
  // what a job's input looked like, every agent step in full, and what the agent says it learned (→ new recipes)
  "ALTER TABLE jobs ADD COLUMN publication_json TEXT", "ALTER TABLE jobs ADD COLUMN fingerprint_json TEXT", "ALTER TABLE jobs ADD COLUMN trace_json TEXT", "ALTER TABLE jobs ADD COLUMN lesson_json TEXT",
  // ludarr: library management on top of the ahoy rows
  "ALTER TABLE games ADD COLUMN monitored INTEGER DEFAULT 1", "ALTER TABLE games ADD COLUMN profile_id INTEGER", "ALTER TABLE games ADD COLUMN root_folder_id INTEGER",
  "ALTER TABLE games ADD COLUMN path TEXT", "ALTER TABLE games ADD COLUMN tags_json TEXT DEFAULT '[]'", "ALTER TABLE games ADD COLUMN added_at INTEGER", "ALTER TABLE games ADD COLUMN title_id INTEGER",
  "ALTER TABLE fetches ADD COLUMN client_instance_id INTEGER", "ALTER TABLE fetches ADD COLUMN indexer_instance_id INTEGER",
  "ALTER TABLE fetches ADD COLUMN imported_at INTEGER", "ALTER TABLE fetches ADD COLUMN cleaned_at INTEGER",
  "ALTER TABLE games ADD COLUMN drm TEXT", "ALTER TABLE games ADD COLUMN crack_status TEXT", "ALTER TABLE games ADD COLUMN crack_date TEXT", "ALTER TABLE games ADD COLUMN crack_group TEXT",
  "ALTER TABLE games ADD COLUMN crackwatch_slug TEXT", "ALTER TABLE games ADD COLUMN crackwatch_at INTEGER",
  "ALTER TABLE catalog ADD COLUMN drm TEXT", "ALTER TABLE catalog ADD COLUMN crack_status TEXT", "ALTER TABLE catalog ADD COLUMN crack_date TEXT", "ALTER TABLE catalog ADD COLUMN crack_group TEXT",
  "ALTER TABLE catalog ADD COLUMN crackwatch_slug TEXT", "ALTER TABLE catalog ADD COLUMN crackwatch_at INTEGER"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}
/* jobs that are not imports of a download (src/ways: building a way's package, the AI constructing a plan, taking in
   game files, building a source plan): what kind each is and what it was asked to do — idempotent */
for (const ddl of ["ALTER TABLE jobs ADD COLUMN kind TEXT DEFAULT 'import'", "ALTER TABLE jobs ADD COLUMN spec_json TEXT"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}
/* what a game is searched by besides its name (other names it goes by, the admin's extra queries) and the art set by hand
   ({poster?, banner?, hero?, logo?} each 'upload:<file>' in <config>/art/custom; a kind set here is never replaced by
   automatic art) — idempotent */
for (const ddl of ["ALTER TABLE games ADD COLUMN aliases_json TEXT DEFAULT '[]'", "ALTER TABLE games ADD COLUMN search_terms_json TEXT DEFAULT '[]'",
  "ALTER TABLE games ADD COLUMN art_json TEXT DEFAULT '{}'"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}
/* a search for one way to play's game file (src/ways/find.ts): the way it is for, and releases refused for one way only
   (a file one way turns down can still be another's) — idempotent */
for (const ddl of ["ALTER TABLE requests ADD COLUMN way_id INTEGER", "ALTER TABLE blocklist ADD COLUMN way_id INTEGER"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}
/* the carry run a job was started by (src/ways/carry.ts), and why a job ended badly (src/ways/errors.ts FailInfo, written by
   the runner from typed errors, so nothing classifies a failure by its words); a release a way's search refused under one
   version of that way's content plan (plan_digest) and whether it was another game ('identity') or only not in a form the
   way took then ('form') — idempotent */
for (const ddl of ["ALTER TABLE jobs ADD COLUMN run_id INTEGER", "ALTER TABLE jobs ADD COLUMN fail_json TEXT",
  "ALTER TABLE blocklist ADD COLUMN plan_digest TEXT", "ALTER TABLE blocklist ADD COLUMN class TEXT"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(run_id)");
/* what a search that took nothing found, and why each release was not taken (src/requests.ts nothingTaken: the first ten
   as [{title, indexer, size, protocol, why}]; cleared on a grab) — idempotent */
try { db.exec("ALTER TABLE requests ADD COLUMN refused_json TEXT"); } catch { /* already there */ }
/* the seedbox waited out instead of a copy given up (src/remote.ts): a request's wait on a seedbox that does not answer
   (requests.remote_json: since, tries, what is retried, the absences seen); a download's own (fetches.trouble_json, with
   retry_at: when its transfer is tried again), the last time its client answered with it (polled_at) and the seconds its
   download stood still in a way that counts as a stall (still_sec: never while the client is silent, the item waits in
   the client or the seedbox's link is full) — idempotent */
for (const ddl of ["ALTER TABLE requests ADD COLUMN remote_json TEXT", "ALTER TABLE fetches ADD COLUMN trouble_json TEXT",
  "ALTER TABLE fetches ADD COLUMN retry_at INTEGER", "ALTER TABLE fetches ADD COLUMN polled_at INTEGER", "ALTER TABLE fetches ADD COLUMN still_sec INTEGER DEFAULT 0",
  // when its download last moved in the client (unix s; null until a poll under these rules): one that stands still for days
  // is asked about, then stopped with the download kept (src/requests.ts)
  "ALTER TABLE fetches ADD COLUMN moved_at INTEGER"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}
/** games.source was never written before: every row took the column default 'steam', IGDB ones included. Only rows that
 *  are certainly wrong change (an IGDB id, no Steam id, still 'steam'), so running it again changes nothing. */
export function backfillGameSources(): number {
  return db.query("UPDATE games SET source='igdb' WHERE steam_appid IS NULL AND igdb_id IS NOT NULL AND source='steam'").run().changes;
}
backfillGameSources();
/* how a game starts, set by hand (src/library/launch.ts): games.launch_json is the admin's start for the game's imported PC
   copies (src/ways/types.ts LaunchChoice), packages.launch_auto_json the start the job that made a copy found before any
   start set by hand ({launch, requires}, what Reset gives back) — idempotent */
for (const ddl of ["ALTER TABLE games ADD COLUMN launch_json TEXT", "ALTER TABLE packages ADD COLUMN launch_auto_json TEXT"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}
/* the version of a game that was asked for (src/platforms.ts platformChoices): games.want_platform is a platform id ("arcade",
   "x360", "pc"), and the game's searches then take a copy for that platform only; null: no choice was made — idempotent */
try { db.exec("ALTER TABLE games ADD COLUMN want_platform TEXT"); } catch { /* already there */ }
/* downloads that come here through the admin's own sync (src/arrivals.ts): fetches.arrival_json is an arrival's state (since
   when it is awaited, the files it waits for, where it was found, its clocks, its hold on the files, the question put to the
   admin, a loss, its removal once imported); fetches.files_json what a torrent's own .torrent lists ([{p, s}]: paths inside
   its folder and sizes), the arrival's fallback when rTorrent cannot say; fetches.took_json exactly what was taken from the
   finished-downloads folder, file by file (src/arrivals.ts Taken: written once, when it is taken — the only files ludarr
   ever deletes there) — idempotent */
for (const ddl of ["ALTER TABLE fetches ADD COLUMN arrival_json TEXT", "ALTER TABLE fetches ADD COLUMN files_json TEXT", "ALTER TABLE fetches ADD COLUMN took_json TEXT"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}

export interface GameRow {
  id: number;
  igdb_id: number | null;
  steam_appid: number | null;
  name: string;
  slug: string | null;
  summary: string | null;
  storyline: string | null;
  release_year: number | null;
  first_release_date: number | null;
  rating: number | null;
  cover_url: string | null;
  banner_url: string | null;
  screenshots_json: string;
  genres_json: string;
  themes_json: string;
  platforms_json: string;
  game_modes_json: string;
  developer: string | null;
  publisher: string | null;
  /** where the game came from: 'steam' | 'igdb' | 'catalog' | 'manual' (added by hand) */
  source: string;
  crew_visible: number;
  onboarded_at: number | null;
  coming_soon: number | null;
  release_text: string | null;
  release_iso: string | null;
  monitored: number | null;
  profile_id: number | null;
  root_folder_id: number | null;
  path: string | null;
  tags_json: string | null;
  added_at: number | null;
  title_id: number | null;
  drm: string | null;             // CrackWatch: the protection ("Denuvo", "Steam" …)
  crack_status: string | null;    // cracked | uncracked | unreleased | unknown | untracked
  crack_date: string | null;
  crack_group: string | null;
  crackwatch_slug: string | null;
  crackwatch_at: number | null;   // when CrackWatch was last asked
  aliases_json?: string | null;       // other names it goes by: each is searched and judged on its own
  search_terms_json?: string | null;  // extra queries the admin wants asked (they never make a release the game)
  art_json?: string | null;           // art set by hand: {poster?, banner?, hero?, logo?: 'upload:<file>', at?: ms of the last change}
  launch_json?: string | null;        // how its imported PC copies start, set by hand (src/ways/types.ts LaunchChoice)
  want_platform?: string | null;      // the version that was asked for, a platform id (src/platforms.ts wantedPlatform)
  created_at: number;
  updated_at: number;
}

/** the art kinds a game can have set by hand */
export const ART_KINDS = ["poster", "banner", "hero", "logo"] as const;
export type ArtKind = (typeof ART_KINDS)[number];
/** a game's hand-set art: kind → stored file name (under <config>/art/custom), plus when it last changed */
export function customArtOf(r: Pick<GameRow, "art_json">): { files: Partial<Record<ArtKind, string>>; at: number | null } {
  let o: Record<string, unknown> = {};
  try { const v = JSON.parse(r.art_json ?? "{}"); if (v && typeof v === "object" && !Array.isArray(v)) o = v; } catch { /* none */ }
  const files: Partial<Record<ArtKind, string>> = {};
  for (const k of ART_KINDS) { const v = o[k]; if (typeof v === "string" && v.startsWith("upload:")) files[k] = v.slice(7); }
  return { files, at: typeof o.at === "number" ? o.at : null };
}

/** Row → JSON-friendly object with arrays parsed out. */
export function serializeGame(r: GameRow) {
  const j = (k: keyof GameRow): string[] => {
    try { return JSON.parse(r[k] as unknown as string ?? "[]") ?? []; } catch { return []; }
  };
  const art = customArtOf(r);
  return {
    id: r.id,
    igdbId: r.igdb_id,
    steamAppId: r.steam_appid,
    drm: r.drm ?? null, crackStatus: r.crack_status ?? null, crackDate: r.crack_date ?? null, crackGroup: r.crack_group ?? null,
    crackwatchUrl: r.crackwatch_slug ? `https://isitcracked.com/game/${r.crackwatch_slug}` : null,
    name: r.name,
    slug: r.slug,
    summary: r.summary,
    releaseYear: r.release_year,
    rating: r.rating,
    coverUrl: r.cover_url,
    bannerUrl: r.banner_url,
    screenshots: j("screenshots_json"),
    genres: j("genres_json"),
    themes: j("themes_json"),
    platforms: j("platforms_json"),
    // the versions it can be asked for (a choice only when there are several), and the one that was
    platformChoices: platformChoices(j("platforms_json")).map(id => ({ id, label: PLATFORM_LABEL[id] })),
    wantPlatform: wantedPlatform(r.want_platform),
    gameModes: j("game_modes_json"),
    developer: r.developer,
    publisher: r.publisher,
    crewVisible: !!r.crew_visible,
    onboardedAt: r.onboarded_at,
    comingSoon: !!r.coming_soon,
    releaseText: r.release_text ?? null,
    releaseIso: r.release_iso ?? null,
    monitored: r.monitored == null ? true : !!r.monitored,
    profileId: r.profile_id ?? null,
    rootFolderId: r.root_folder_id ?? null,
    path: r.path ?? null,
    tags: (() => { try { return JSON.parse(r.tags_json ?? "[]"); } catch { return []; } })() as string[],
    addedAt: r.added_at ?? r.created_at,
    titleId: r.title_id ?? null,
    source: r.source ?? "steam",
    aliases: j("aliases_json"),
    searchTerms: j("search_terms_json"),
    /** the kinds set by hand (automatic art never replaces them), and when that art last changed (a cache key) */
    customArt: ART_KINDS.filter(k => art.files[k]) as ArtKind[],
    customArtAt: art.at,
  };
}

/** arriving: done on the seedbox, waited for in the finished-downloads folder (src/arrivals.ts) instead of pulled */
export type FetchState = "submitted" | "downloading" | "seedbox_done" | "pulling" | "arriving" | "done" | "failed";

export interface FetchRow {
  imported_at: number | null;   // when its import finished (the seeding task then owns it)
  cleaned_at: number | null;    // when it was removed from its download client
  id: number;
  game_id: number | null;
  client_instance_id?: number | null;
  indexer_instance_id?: number | null;
  guid: string | null;
  indexer_id: number | null;
  indexer: string | null;
  title: string;
  protocol: string;
  size: number | null;
  info_hash: string | null;
  client: string;
  client_id: string | null;
  state: FetchState;
  progress: number;
  seedbox_path: string | null;
  seedbox_is_dir: number;
  local_path: string | null;
  message: string | null;
  release_json: string | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  /** the seedbox waited out (src/remote.ts FetchTrouble as JSON), and when the transfer is tried again (unix s) */
  trouble_json?: string | null;
  retry_at?: number | null;
  /** the last time its client answered with it (unix s), and the seconds it stood still in a way that counts as a stall */
  polled_at?: number | null;
  still_sec?: number | null;
  /** when its download last moved in the client (unix s; null: not polled under these rules yet) */
  moved_at?: number | null;
  /** its arrival through the finished-downloads folder (src/arrivals.ts Arrival as JSON), what its .torrent lists ([{p, s}]),
   *  and exactly what was taken from that folder (src/arrivals.ts Taken as JSON) */
  arrival_json?: string | null;
  files_json?: string | null;
  took_json?: string | null;
}

export function serializeFetch(r: FetchRow) {
  return {
    id: r.id,
    gameId: r.game_id,
    guid: r.guid,
    indexerId: r.indexer_id,
    indexer: r.indexer,
    title: r.title,
    protocol: r.protocol,
    size: r.size,
    infoHash: r.info_hash,
    client: r.client,
    clientId: r.client_id,
    clientInstanceId: r.client_instance_id ?? null,
    indexerInstanceId: r.indexer_instance_id ?? null,
    state: r.state,
    progress: Math.round((r.progress ?? 0) * 1000) / 1000,
    seedboxPath: r.seedbox_path,
    seedboxIsDir: !!r.seedbox_is_dir,
    localPath: r.local_path,
    message: r.message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    doneAt: r.done_at,
    /** when a transfer the seedbox broke off is tried again (unix s; null: not waiting) */
    retryAt: r.retry_at ?? null,
  };
}

export type RequestState = "requested" | "matching" | "fetching" | "processing" | "ready" | "failed" | "cancelled";
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface RequestRow {
  id: number; game_id: number; state: RequestState; stage: string | null; progress: number; message: string | null;
  candidates_json: string | null; attempt: number; release_json: string | null;
  fetch_id: number | null; job_id: number | null; package_id: number | null; next_try_at: number | null;
  requested_by: string | null; tried_json: string | null; created_at: number; updated_at: number; done_at: number | null;
  /** the way to play whose game file this search is for (src/ways/find.ts); null: a search for the game itself */
  way_id?: number | null;
  /** a search that took nothing: the releases it found and why each was not taken (src/requests.ts Refused[]), admin-only */
  refused_json?: string | null;
  /** a wait on a seedbox that does not answer (src/remote.ts RemoteWait as JSON): nothing is given up while it lasts */
  remote_json?: string | null;
  game_name?: string; cover_url?: string | null;      // from the JOIN in the requests* queries
}
export interface JobRow {
  publication_json?: string | null;
  id: number; request_id: number | null; fetch_id: number | null; game_id: number | null;
  input_path: string; output_path: string | null; state: JobState; tier: string | null; progress: number;
  message: string | null; transcript: string; manifest_json: string | null;
  fingerprint_json?: string | null; trace_json?: string | null; lesson_json?: string | null;
  /** 'import' | 'construct' | 'assemble' | 'content' | 'build' | 'make' (src/ways/types.ts JobKind); null on rows from before */
  kind?: string | null; spec_json?: string | null;
  /** the carry run that started it (src/ways/carry.ts), and why it ended badly (src/ways/types.ts FailInfo as JSON) */
  run_id?: number | null; fail_json?: string | null;
  created_at: number; updated_at: number; done_at: number | null;
  game_name?: string | null;      // from the JOIN in agentRuns
}
export interface RootFolderRow { id: number; path: string; name: string | null; created_at: number }
export interface ProfileRow { id: number; name: string; settings_json: string; created_at: number; updated_at: number }
export interface HistoryRow { id: number; game_id: number | null; event: string; release: string | null; source: string | null; message: string | null; data_json: string | null; created_at: number; game_name?: string | null }
/** way_id: refused for that way only; plan_digest: under which version of the way's content plan; class: 'identity' (another
 *  title, version, a patch, a sealed file) or 'form' (no file in a form the way took then) */
export interface BlockRow { id: number; game_id: number | null; guid: string | null; title: string; indexer: string | null; reason: string | null; created_at: number; game_name?: string | null; way_id?: number | null; plan_digest?: string | null; class?: "identity" | "form" | "source" | null }
export interface PackageRow {
  id: number; game_id: number | null; job_id: number | null; path: string; name: string; version: string | null;
  size: number | null; manifest_json: string; created_at: number;
  /** the start the job found before any start set by hand, {launch, requires} as JSON (src/library/launch.ts); null on rows
   *  from before, whose manifest is then that start until it is first changed */
  launch_auto_json?: string | null;
}

export function serializeRequest(r: RequestRow) {
  let release: { title: string; protocol: string; indexer: string | null; size: number | null; group: string | null } | null = null;
  try {
    const j = r.release_json ? JSON.parse(r.release_json) : null;
    if (j) release = { title: j.title, protocol: j.protocol, indexer: j.indexer ?? null, size: j.size ?? null, group: j.parsed?.group ?? null };
  } catch { /* ignore */ }
  let candidates = 0;
  try { candidates = r.candidates_json ? (JSON.parse(r.candidates_json) as unknown[]).length : 0; } catch { /* ignore */ }
  return {
    id: r.id, gameId: r.game_id, gameName: r.game_name ?? null, coverUrl: r.cover_url ?? null,
    state: r.state, stage: r.stage, progress: Math.round((r.progress ?? 0) * 1000) / 1000, message: r.message,
    release, attempt: r.attempt, candidates, fetchId: r.fetch_id, jobId: r.job_id, packageId: r.package_id,
    nextTryAt: r.next_try_at, createdAt: r.created_at, updatedAt: r.updated_at, doneAt: r.done_at,
  };
}
function parseJson(s: string | null | undefined): any { try { return s ? JSON.parse(s) : null; } catch { return null; } }
export function serializeJob(j: JobRow, withTranscript = false) {
  let manifest: unknown = null;
  try { manifest = j.manifest_json ? JSON.parse(j.manifest_json) : null; } catch { /* ignore */ }
  if (manifest && typeof manifest === "object") delete (manifest as { files?: unknown }).files;
  return {
    id: j.id, requestId: j.request_id, fetchId: j.fetch_id, gameId: j.game_id, inputPath: j.input_path, outputPath: j.output_path,
    state: j.state, tier: j.tier, progress: Math.round((j.progress ?? 0) * 1000) / 1000, message: j.message, manifest,
    transcript: withTranscript ? j.transcript : undefined, transcriptLines: (j.transcript ?? "").split("\n").filter(Boolean).length,
    lesson: parseJson(j.lesson_json), fingerprint: withTranscript ? parseJson(j.fingerprint_json) : undefined, trace: withTranscript ? parseJson(j.trace_json) : undefined,
    kind: j.kind ?? "import", spec: parseJson(j.spec_json),
    runId: j.run_id ?? null, fail: parseJson(j.fail_json) as FailInfo | null,
    createdAt: j.created_at, updatedAt: j.updated_at, doneAt: j.done_at,
  };
}
export function serializePackage(p: PackageRow, withFiles = false) {
  const m = JSON.parse(p.manifest_json);
  if (!withFiles) delete m.files;
  return { id: p.id, gameId: p.game_id, jobId: p.job_id, path: p.path, name: p.name, version: p.version, size: p.size, manifest: m, createdAt: p.created_at };
}

export const kv = {
  get(key: string): string | null {
    return (db.query("SELECT value FROM kv WHERE key=?").get(key) as any)?.value ?? null;
  },
  set(key: string, value: string) {
    db.query(
      "INSERT INTO kv(key,value,updated_at) VALUES(?,?,unixepoch()) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()"
    ).run(key, value);
  },
  del(key: string) {
    db.query("DELETE FROM kv WHERE key=?").run(key);
  },
};

/**
 * Named-bind shim: this Bun version only binds explicitly-prefixed "@key" keys,
 * and silently ignores unprefixed ones (→ NOT NULL failures). Prefix defensively.
 */
type Bind = string | number | bigint | boolean | null | Uint8Array;
const at = (v: Record<string, unknown>) => {
  const o: Record<string, Bind> = {};
  for (const [k, val] of Object.entries(v)) o["@" + k] = (val === undefined ? null : val) as Bind;
  return o;
};

const _gameCols = `
    (igdb_id,steam_appid,name,slug,summary,storyline,release_year,first_release_date,rating,
     cover_url,banner_url,screenshots_json,genres_json,themes_json,platforms_json,
     game_modes_json,developer,publisher,coming_soon,release_text,release_iso,source,updated_at)`;
const _gameVals = `
    VALUES (@igdb_id,@steam_appid,@name,@slug,@summary,@storyline,@release_year,@first_release_date,@rating,
            @cover_url,@banner_url,@screenshots_json,@genres_json,@themes_json,@platforms_json,
            @game_modes_json,@developer,@publisher,@coming_soon,@release_text,@release_iso,@source,unixepoch())`;
const _gameUpdate = `
    SET name=excluded.name, slug=COALESCE(games.slug, excluded.slug), summary=excluded.summary, storyline=excluded.storyline,
      release_year=excluded.release_year, first_release_date=excluded.first_release_date,
      rating=excluded.rating, cover_url=excluded.cover_url, banner_url=excluded.banner_url,
      screenshots_json=excluded.screenshots_json, genres_json=excluded.genres_json,
      themes_json=excluded.themes_json, platforms_json=excluded.platforms_json,
      game_modes_json=excluded.game_modes_json, developer=excluded.developer,
      publisher=excluded.publisher, coming_soon=excluded.coming_soon, release_text=excluded.release_text,
      release_iso=excluded.release_iso, updated_at=unixepoch()
    RETURNING *`;

const _upsertBySteam = db.query(`
    INSERT INTO games ${_gameCols}${_gameVals}
    ON CONFLICT(steam_appid) DO UPDATE ${_gameUpdate}`);
const _upsertByIgdb = db.query(`
    INSERT INTO games ${_gameCols}${_gameVals}
    ON CONFLICT(igdb_id) DO UPDATE ${_gameUpdate}`);

/** Pick the conflict target by which external id the row carries. A new row records where it came from (the store whose id
 *  it carries, unless the caller says); an existing row keeps its origin. */
export function upsertGame(v: Record<string, unknown>): GameRow {
  const stmt = v.steam_appid != null ? _upsertBySteam : _upsertByIgdb;
  const source = typeof v.source === "string" && v.source ? v.source : v.steam_appid != null ? "steam" : v.igdb_id != null ? "igdb" : "catalog";
  // the slug names the game's package folder and its install on every PC: a game keeps the one it has (a store rename never
  // moves it), and a new game takes one no other game has ("alone-in-the-dark", then "alone-in-the-dark-2008", then -2 …)
  const mine = (v.steam_appid != null ? db.query("SELECT id, slug FROM games WHERE steam_appid=?").get(v.steam_appid as number)
    : v.igdb_id != null ? db.query("SELECT id, slug FROM games WHERE igdb_id=?").get(v.igdb_id as number) : null) as { id: number; slug: string | null } | null;
  let slug = typeof v.slug === "string" && v.slug ? v.slug : null;
  if (mine?.slug) slug = mine.slug;
  else if (slug) slug = freeSlug(slug, typeof v.release_year === "number" ? v.release_year : null, mine?.id ?? null);
  return stmt.get(at({ coming_soon: 0, release_text: null, release_iso: null, ...v, slug, source })) as GameRow;
}

/** a slug no other game has: the one asked for, then with the year, then numbered */
export function freeSlug(base: string, year: number | null, self: number | null = null): string {
  const taken = (s: string) => !!db.query("SELECT 1 FROM games WHERE slug=? AND id IS NOT ?").get(s, self);
  for (const s of [base, year ? `${base}-${year}` : null]) if (s && !taken(s)) return s;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

const _insertFetch = db.query(`
    INSERT INTO fetches (game_id,guid,indexer_id,indexer,title,protocol,size,info_hash,client,client_id,state,release_json,client_instance_id,indexer_instance_id)
    VALUES (@game_id,@guid,@indexer_id,@indexer,@title,@protocol,@size,@info_hash,@client,@client_id,@state,@release_json,@client_instance_id,@indexer_instance_id)
    RETURNING *`);

export function insertFetch(v: {
  game_id: number | null; guid: string | null; indexer_id: number | null; indexer: string | null;
  title: string; protocol: string; size: number | null; info_hash: string | null;
  client: string; client_id: string | null; state: FetchState; release_json: string | null;
  client_instance_id?: number | null; indexer_instance_id?: number | null;
}): FetchRow {
  return _insertFetch.get(at({ client_instance_id: null, indexer_instance_id: null, ...v })) as FetchRow;
}

/** partial UPDATE on a request row: column list built by the caller (requests.ts), values bound positionally */
export function updateRequest(sets: string[], vals: (string | number | null)[], id: number) {
  db.query(`UPDATE requests SET ${sets.join(", ")}, updated_at=unixepoch() WHERE id=?`).run(...vals, id);
}

export const stmts = {
  upsertGame,
  updateRequest,
  allGames: db.query("SELECT * FROM games ORDER BY name COLLATE NOCASE"),
  gameById: db.query("SELECT * FROM games WHERE id=?"),
  gameByIgdb: db.query("SELECT * FROM games WHERE igdb_id=?"),
  gameBySteam: db.query("SELECT * FROM games WHERE steam_appid=?"),
  deleteGame: db.query("DELETE FROM games WHERE id=?"),
  setCrewVisible: db.query("UPDATE games SET crew_visible=?, updated_at=unixepoch() WHERE id=? RETURNING *"),
  setGameLibrary: db.query("UPDATE games SET monitored=?, profile_id=?, root_folder_id=?, tags_json=?, updated_at=unixepoch() WHERE id=? RETURNING *"),
  setGameAdded: db.query("UPDATE games SET added_at=COALESCE(added_at, unixepoch()), monitored=COALESCE(?, monitored, 1), profile_id=COALESCE(?, profile_id), root_folder_id=COALESCE(?, root_folder_id), updated_at=unixepoch() WHERE id=? RETURNING *"),
  setGamePath: db.query("UPDATE games SET path=?, updated_at=unixepoch() WHERE id=?"),
  setGameTitle: db.query("UPDATE games SET title_id=? WHERE id=?"),
  gamesMonitoredMissing: db.query("SELECT g.* FROM games g WHERE COALESCE(g.monitored,1)=1 AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.game_id=g.id) ORDER BY g.name COLLATE NOCASE"),
  gamesByRelease: db.query("SELECT * FROM games WHERE release_iso IS NOT NULL AND release_iso BETWEEN ? AND ? ORDER BY release_iso, name COLLATE NOCASE"),

  // ── root folders / profiles ──
  rootFolders: db.query("SELECT * FROM root_folders ORDER BY id"),
  rootFolder: db.query("SELECT * FROM root_folders WHERE id=?"),
  rootFolderByPath: db.query("SELECT * FROM root_folders WHERE path=?"),
  insertRootFolder: db.query("INSERT INTO root_folders (path, name) VALUES (?, ?) RETURNING *"),
  deleteRootFolder: db.query("DELETE FROM root_folders WHERE id=?"),
  profiles: db.query("SELECT * FROM profiles ORDER BY id"),
  profile: db.query("SELECT * FROM profiles WHERE id=?"),
  insertProfile: db.query("INSERT INTO profiles (name, settings_json) VALUES (?, ?) RETURNING *"),
  updateProfile: db.query("UPDATE profiles SET name=?, settings_json=?, updated_at=unixepoch() WHERE id=? RETURNING *"),
  deleteProfile: db.query("DELETE FROM profiles WHERE id=?"),
  gamesUsingProfile: db.query("SELECT COUNT(*) AS n FROM games WHERE profile_id=?"),
  gamesInRootFolder: db.query("SELECT COUNT(*) AS n FROM games WHERE root_folder_id=?"),

  // ── history / blocklist ──
  insertHistory: db.query("INSERT INTO history (game_id, event, release, source, message, data_json) VALUES (?,?,?,?,?,?) RETURNING *"),
  historyAll: db.query("SELECT h.*, g.name AS game_name FROM history h LEFT JOIN games g ON g.id=h.game_id ORDER BY h.id DESC LIMIT ? OFFSET ?"),
  historyCount: db.query("SELECT COUNT(*) AS n FROM history"),
  historyForGame: db.query("SELECT h.*, g.name AS game_name FROM history h LEFT JOIN games g ON g.id=h.game_id WHERE h.game_id=? ORDER BY h.id DESC LIMIT 100"),
  insertBlock: db.query("INSERT INTO blocklist (game_id, guid, title, indexer, reason) VALUES (?,?,?,?,?) RETURNING *"),
  /** a post that failed on its source (a dead post, a stall, a transfer that broke): that post only is blocked, by its guid —
   *  the same release's other posts stay open (class 'source'; the title is kept for the admin to read) */
  insertSourceBlock: db.query("INSERT INTO blocklist (game_id, guid, title, indexer, reason, class) VALUES (?,?,?,?,?,'source') RETURNING *"),
  blocklistAll: db.query("SELECT b.*, g.name AS game_name FROM blocklist b LEFT JOIN games g ON g.id=b.game_id ORDER BY b.id DESC LIMIT 500"),
  /** the game's own blocklist; a release refused for one way only (way_id) is not on it */
  blocklistForGame: db.query("SELECT guid, title, class FROM blocklist WHERE game_id=? AND way_id IS NULL"),
  /** what a search for one way's game file may not take: the game's own blocklist and that way's */
  blocklistForWay: db.query("SELECT guid, title FROM blocklist WHERE game_id=? AND (way_id IS NULL OR way_id=?)"),
  /** game, guid, title, indexer, reason, way, plan_digest, class (null, null where neither is known) */
  insertWayBlock: db.query("INSERT INTO blocklist (game_id, guid, title, indexer, reason, way_id, plan_digest, class) VALUES (?,?,?,?,?,?,?,?) RETURNING *"),
  deleteBlock: db.query("DELETE FROM blocklist WHERE id=?"),
  clearBlocklist: db.query("DELETE FROM blocklist"),

  insertFetch,
  allFetches: db.query("SELECT * FROM fetches ORDER BY id DESC LIMIT 200"),
  fetchById: db.query("SELECT * FROM fetches WHERE id=?"),
  fetchByHash: db.query("SELECT * FROM fetches WHERE info_hash=? AND state!='failed' ORDER BY id DESC LIMIT 1"),
  fetchesActive: db.query("SELECT * FROM fetches WHERE state IN ('submitted','downloading','seedbox_done','pulling','arriving') ORDER BY id"),
  fetchesByState: db.query("SELECT * FROM fetches WHERE state=? ORDER BY id"),
  setFetchState: db.query("UPDATE fetches SET state=?, progress=?, message=?, updated_at=unixepoch() WHERE id=?"),
  setFetchProgress: db.query("UPDATE fetches SET progress=?, updated_at=unixepoch() WHERE id=?"),
  setFetchSeedbox: db.query("UPDATE fetches SET seedbox_path=?, seedbox_is_dir=?, size=COALESCE(NULLIF(?,0), size), updated_at=unixepoch() WHERE id=?"),
  setFetchLocal: db.query("UPDATE fetches SET local_path=?, updated_at=unixepoch() WHERE id=?"),
  setFetchDone: db.query("UPDATE fetches SET state='done', progress=1, local_path=?, message=NULL, retry_at=NULL, trouble_json=NULL, done_at=unixepoch(), updated_at=unixepoch() WHERE id=?"),
  /** a transfer the seedbox broke off: back to `state` (seedbox_done) with the words, when it is tried again and the wait */
  setFetchRetry: db.query("UPDATE fetches SET state=?, progress=?, message=?, retry_at=?, trouble_json=?, updated_at=unixepoch() WHERE id=?"),
  /** the seedbox waited out on a download (src/remote.ts FetchTrouble as JSON; null: nothing waited on) */
  setFetchTrouble: db.query("UPDATE fetches SET trouble_json=? WHERE id=?"),
  /** the client answered with the item: when, and the stall seconds that count so far */
  setFetchPolled: db.query("UPDATE fetches SET polled_at=?, still_sec=? WHERE id=?"),
  /** the client answered without the item (it is looked for again): when — the client is not silent */
  setFetchAnswered: db.query("UPDATE fetches SET polled_at=? WHERE id=?"),
  /** when its download last moved in the client (a resumed wait starts its clock again) */
  setFetchMoved: db.query("UPDATE fetches SET moved_at=? WHERE id=?"),
  /** an arrival's state (src/arrivals.ts; null: none) */
  setFetchArrival: db.query("UPDATE fetches SET arrival_json=? WHERE id=?"),
  /** …written only over the state it was read as (`arrival_json IS ?`): a look never writes over an answer given meanwhile */
  setFetchArrivalIf: db.query("UPDATE fetches SET arrival_json=? WHERE id=? AND arrival_json IS ?"),
  /** an arrival taken (its path, its state, exactly what it took), only while it is still awaited as it was read */
  setFetchArrivedIf: db.query("UPDATE fetches SET state='done', progress=1, local_path=?, arrival_json=?, took_json=?, message=NULL, retry_at=NULL, trouble_json=NULL, done_at=unixepoch(), updated_at=unixepoch() WHERE id=? AND state='arriving' AND arrival_json IS ?"),
  /** what was taken from the finished-downloads folder recorded with the arrival's state, only over the state as it was read
   *  (a copy that came after its import from the seedbox) */
  setFetchTookIf: db.query("UPDATE fetches SET took_json=?, arrival_json=? WHERE id=? AND arrival_json IS ?"),
  /** a leftover the admin approved for removal: what is to go (fetches.took_json), nothing else of the row */
  setFetchTook: db.query("UPDATE fetches SET took_json=? WHERE id=?"),
  /** an arrival handed back to the transfer (its state, its words), only while it is still awaited as it was read */
  leaveArrivingIf: db.query("UPDATE fetches SET state=?, progress=1, message=?, retry_at=NULL, trouble_json=NULL, updated_at=unixepoch() WHERE id=? AND state='arriving' AND arrival_json IS ?"),
  /** a download the client finished, awaited in the finished-downloads folder from now: the state, its words and the arrival */
  setFetchArriving: db.query("UPDATE fetches SET state='arriving', progress=?, message=?, retry_at=NULL, trouble_json=NULL, arrival_json=?, updated_at=unixepoch() WHERE id=?"),
  /** what the download's .torrent lists ([{p, s}] as JSON) */
  setFetchFiles: db.query("UPDATE fetches SET files_json=? WHERE id=?"),
  /** the same release in its client again (a download the finished-downloads folder lost): its new id there, from the start */
  setFetchAgain: db.query("UPDATE fetches SET client_id=?, state='submitted', progress=0, message=?, seedbox_path=NULL, local_path=NULL, done_at=NULL, retry_at=NULL, trouble_json=NULL, still_sec=0, moved_at=NULL, polled_at=NULL, rate=0, arrival_json=?, created_at=unixepoch(), updated_at=unixepoch() WHERE id=?"),
  /** the newest download of one release (a usenet post has no info hash: the same post sent twice is found by its guid) */
  fetchByGuid: db.query("SELECT * FROM fetches WHERE guid=? AND state!='failed' ORDER BY id DESC LIMIT 1"),
  deleteFetch: db.query("DELETE FROM fetches WHERE id=?"),
  setFetchDownloading: db.query("UPDATE fetches SET state='downloading', progress=?, message=?, rate=?, updated_at=unixepoch() WHERE id=?"),
  setFetchPulling: db.query("UPDATE fetches SET progress=?, rate=?, updated_at=unixepoch() WHERE id=?"),
  setFetchImported: db.query("UPDATE fetches SET imported_at=unixepoch(), updated_at=unixepoch() WHERE id=?"),
  setFetchCleaned: db.query("UPDATE fetches SET cleaned_at=unixepoch(), message=?, updated_at=unixepoch() WHERE id=?"),
  fetchesToClean: db.query("SELECT * FROM fetches WHERE state='done' AND imported_at IS NOT NULL AND cleaned_at IS NULL AND client_id IS NOT NULL ORDER BY id"),

  // ── requests ──
  insertRequest: db.query("INSERT INTO requests (game_id, state, stage, requested_by) VALUES (?, 'requested', 'queued', ?) RETURNING *"),
  insertWayRequest: db.query("INSERT INTO requests (game_id, state, stage, requested_by, way_id) VALUES (?, 'requested', 'queued', ?, ?) RETURNING *"),
  /** the search in flight for one way's game file */
  requestActiveForWay: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.way_id=? AND r.id<>? AND r.state IN ('requested','matching','fetching','processing') ORDER BY r.id DESC LIMIT 1"),
  /** every search in flight for one way's game file but the one named */
  requestsActiveForWay: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.way_id=? AND r.id<>? AND r.state IN ('requested','matching','fetching','processing') ORDER BY r.id"),
  /** how many times a download's game file was checked for a way (src/requests.ts retries a check that could not be made); a
   *  check the seedbox broke off (fail kind 'remote') is no try of it */
  contentJobsForFetch: db.query("SELECT COUNT(*) AS n FROM jobs WHERE fetch_id=? AND kind='content' AND COALESCE(CASE WHEN json_valid(fail_json) THEN json_extract(fail_json, '$.kind') END, '') <> 'remote'"),
  requestById: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.id=?"),
  requestsAll: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id ORDER BY r.id DESC LIMIT 200"),
  requestsByState: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.state=? ORDER BY r.id"),
  requestsActive: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.state IN ('requested','matching','fetching','processing') ORDER BY r.id"),
  requestActiveForGame: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.game_id=? AND r.state IN ('requested','matching','fetching','processing','ready') ORDER BY r.id DESC LIMIT 1"),
  /** a game's newest search (of its own, or for one way's game file) whatever its state */
  lastRequestForGame: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.game_id=? ORDER BY r.id DESC LIMIT 1"),
  lastRequestForWay: db.query("SELECT r.*, g.name AS game_name, g.cover_url FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.way_id=? ORDER BY r.id DESC LIMIT 1"),
  deleteRequest: db.query("DELETE FROM requests WHERE id=?"),

  // ── jobs ──
  insertJob: db.query("INSERT INTO jobs (request_id, fetch_id, game_id, input_path) VALUES (?, ?, ?, ?) RETURNING *"),
  /** a job of another kind: input_path holds a sentinel ('way:<id>', 'make:way:<id>', 'plan:<id>', 'repo:<owner/name>', or the
   *  path it reads); the last value is the carry run that started it (null: none) */
  insertJobOf: db.query("INSERT INTO jobs (request_id, fetch_id, game_id, input_path, kind, spec_json, run_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"),
  jobsByKind: db.query("SELECT * FROM jobs WHERE COALESCE(kind, 'import')=? ORDER BY id DESC LIMIT 100"),
  /** a way being built, game files being taken in or made, a program built for one game; the assemble and content jobs
   *  come last, so activeBuilds() keeps one of them for a game that has one */
  activeBuildJobs: db.query("SELECT * FROM jobs WHERE (kind IN ('assemble','content','make') OR (kind='build' AND json_extract(spec_json, '$.wayId') IS NOT NULL)) AND state IN ('queued','running') AND game_id IS NOT NULL ORDER BY (kind IN ('assemble','content')), id"),
  /** why a job ended badly (src/ways/errors.ts failOf, as JSON) */
  setJobFail: db.query("UPDATE jobs SET fail_json=? WHERE id=?"),
  jobById: db.query("SELECT * FROM jobs WHERE id=?"),
  jobsAll: db.query("SELECT * FROM jobs ORDER BY id DESC LIMIT 100"),
  jobsByState: db.query("SELECT * FROM jobs WHERE state=? ORDER BY id"),
  setJob: db.query("UPDATE jobs SET state=?, tier=?, progress=?, message=?, updated_at=unixepoch() WHERE id=?"),
  setJobTranscript: db.query("UPDATE jobs SET transcript=?, updated_at=unixepoch() WHERE id=?"),
  setJobFingerprint: db.query("UPDATE jobs SET fingerprint_json=? WHERE id=?"),
  setJobTrace: db.query("UPDATE jobs SET trace_json=? WHERE id=?"),
  setJobLesson: db.query("UPDATE jobs SET lesson_json=? WHERE id=?"),
  agentRuns: db.query("SELECT j.*, g.name AS game_name FROM jobs j LEFT JOIN games g ON g.id=j.game_id WHERE j.tier='agent' OR j.lesson_json IS NOT NULL ORDER BY j.id DESC"),
  setJobDone: db.query("UPDATE jobs SET state='done', progress=1, message=?, output_path=?, manifest_json=?, done_at=unixepoch(), updated_at=unixepoch() WHERE id=?"),
  setJobFailed: db.query("UPDATE jobs SET state=?, message=?, done_at=unixepoch(), updated_at=unixepoch() WHERE id=?"),

  // ── catalog (Steam details cache for discovery) ──
  catalogUpsert: db.query(`INSERT INTO catalog (steam_appid,name,type,coming_soon,release_text,release_iso,release_sort,genres_json,short_description,metacritic,header_image,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(steam_appid) DO UPDATE SET name=excluded.name, type=excluded.type, coming_soon=excluded.coming_soon, release_text=excluded.release_text,
      release_iso=excluded.release_iso, release_sort=excluded.release_sort, genres_json=excluded.genres_json, short_description=excluded.short_description,
      metacritic=excluded.metacritic, header_image=excluded.header_image, updated_at=unixepoch()`),
  catalogTouch: db.query("INSERT INTO catalog (steam_appid,name,updated_at) VALUES (?,?,unixepoch()) ON CONFLICT(steam_appid) DO UPDATE SET updated_at=unixepoch()"),
  catalogGet: db.query("SELECT * FROM catalog WHERE steam_appid=?"),
  setGameCrack: db.query("UPDATE games SET drm=?, crack_status=?, crack_date=?, crack_group=?, crackwatch_slug=?, crackwatch_at=?, updated_at=unixepoch() WHERE id=?"),
  gamesForCrackwatch: db.query("SELECT * FROM games WHERE steam_appid IS NOT NULL ORDER BY crackwatch_at IS NOT NULL, crackwatch_at, id"),
  setCatalogCrack: db.query("UPDATE catalog SET drm=?, crack_status=?, crack_date=?, crack_group=?, crackwatch_slug=?, crackwatch_at=? WHERE steam_appid=?"),
  catalogForCrackwatch: db.query("SELECT steam_appid, name, crack_status, crackwatch_at FROM catalog WHERE type IS NULL OR type='game' ORDER BY updated_at DESC LIMIT 120"),

  // ── follows ("Track") ──
  insertFollow: db.query("INSERT INTO follows (game_id, release_iso, release_text, coming_soon, checked_at) VALUES (?,?,?,?,?) RETURNING *"),
  followById: db.query("SELECT f.*, g.name AS game_name, g.cover_url, g.steam_appid FROM follows f LEFT JOIN games g ON g.id=f.game_id WHERE f.id=?"),
  followByGame: db.query("SELECT * FROM follows WHERE game_id=?"),
  followsAll: db.query("SELECT f.*, g.name AS game_name, g.cover_url, g.steam_appid FROM follows f LEFT JOIN games g ON g.id=f.game_id ORDER BY COALESCE(f.release_iso,'9999') , f.id"),
  followsPending: db.query("SELECT * FROM follows WHERE requested_at IS NULL ORDER BY id"),
  setFollowChecked: db.query("UPDATE follows SET release_iso=?, release_text=?, coming_soon=?, checked_at=? WHERE id=?"),
  setFollowRequested: db.query("UPDATE follows SET requested_at=?, request_id=? WHERE id=?"),
  deleteFollow: db.query("DELETE FROM follows WHERE id=?"),

  // ── packages ──
  insertPackage: db.query("INSERT INTO packages (game_id, job_id, path, name, version, size, manifest_json) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"),
  packageById: db.query("SELECT * FROM packages WHERE id=?"),
  packagesAll: db.query("SELECT * FROM packages ORDER BY id DESC"),
  packageForGame: db.query("SELECT * FROM packages WHERE game_id=? ORDER BY id DESC LIMIT 1"),
  packageForJob: db.query("SELECT * FROM packages WHERE job_id=? ORDER BY id DESC LIMIT 1"),
  deletePackage: db.query("DELETE FROM packages WHERE id=?"),
  /** the start a copy's job found ({launch, requires} as JSON), written once with the row (src/process/runner.ts finalizePackage) */
  setPackageLaunchAuto: db.query("UPDATE packages SET launch_auto_json=? WHERE id=?"),
  /** a copy's manifest rewritten in place: only how it starts changes (src/library/launch.ts), never its files */
  setPackageManifest: db.query("UPDATE packages SET manifest_json=?, launch_auto_json=? WHERE id=? RETURNING *"),
  /** how the game's imported PC copies start, set by hand (null: as ludarr finds it) */
  setGameLaunch: db.query("UPDATE games SET launch_json=?, updated_at=unixepoch() WHERE id=?"),
};
/** the build jobs (a way being assembled, game files being taken in or made, a program built for one game) queued or
 *  running per game: per game the newest assemble or content job when there is one, else the newest make or per-game
 *  build — so a make or a per-game build never hides the assemble or content job members see as "preparing" (statusOf,
 *  src/library/games.ts, counts only those two until it counts the others too) */
export function activeBuilds(): Map<number, JobRow> {
  const out = new Map<number, JobRow>();
  for (const j of stmts.activeBuildJobs.all() as JobRow[]) if (j.game_id != null) out.set(j.game_id, j);
  return out;
}

export { db };
export default db;
