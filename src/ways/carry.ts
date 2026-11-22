/**
 * ludarr — the carry run: a repo carried all the way to a game members install, with no click. One resumable row per
 * (plan, game), advanced by a ticker from the world as it is (the plan, the game, its file, the build, the check), so a
 * restart loses nothing; it never holds a job lane itself, it starts ordinary jobs and requests and follows them. The AI is
 * called only as bounded repair rounds (construct jobs with a repair brief) whose outcome is plan or way data the next
 * step replays.
 *
 *   plan    the plan checked and ready; once, a build players' PCs would run is moved to the server (a round)
 *   game    the way, else the game it plays attached or added (names AND platform), else asked; a game that already plays
 *           another way (a PC copy, another way's build) is held, asking whether to build this way in its place
 *   file    once per content plan, a round turns what the plan says in words into data (upgrade); then the way's file, a kept
 *           file, a kept dump it is made from, the game's copy of any kind (taken by a link, or made from), the inbox, an
 *           earlier download still on the server (only read), a held file, the indexers — in that order unless
 *           content.make.from says otherwise; nothing usable: a round widens what it accepts with evidence, then it asks,
 *           and keeps watching (the search goes on, the inbox is read every 2 minutes)
 *   build   needs met, a per-way build when the program is built for each game, then the assemble (the plan's checks run in it)
 *   check   the assemble's check report read into the run; done
 *
 * Every child's end is classified by the job's fail_json (src/ways/errors.ts): ok → on; a plan fault → a repair round in
 * that phase; a refused file → back to the file; env → back off (30 min, 2 h, 8 h, 24 h, then an ask, still retried
 * daily); cancelled by the admin → held until Resume; by the run → nothing; a restart → the round started again once. A
 * failure ledger keyed by (kind, input, recipe) never runs a failed key again until something changes it. Every write is
 * compare-and-set on the row's version; the API records an intent and pokes the run, and the run applies it.
 *
 * Admin-facing only: the run's routes and its 'run' events (Ahoy drops 'run'); players see the ordinary statuses
 * ("Preparing" while a make or a build runs, "Looking" while the way's search runs).
 */
import { automaticProblem, needsTitleReport, scopeProblem } from "./emulator-scope";
import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { cfgNum } from "../config";
import { FORMER } from "../former";
import { db, stmts, type FetchRow, type GameRow, type JobRow, type PackageRow, type RequestRow } from "../db";
import { events } from "../events";
import { logger } from "../log";
import { latestRelease } from "../catalog/github";
import { diskSpace, rootFolderFor, rootFolders } from "../library/rootfolders";
import { PLATFORM_LABEL, type PlatformId } from "../platforms";
import { enqueueJob } from "../process/kinds";
import { cancelJob } from "../process/runner";
import { cancelRequest, createRequest, FOR_WAY, rdeps as requestDeps, retryRequest } from "../requests";
import { addGameFor, addWay, libraryMatch, matchGame, onPlatform, type GameMatch } from "./attach";
import { askFor, sizeWords, type AskFacts, type TriedFacts } from "./asks";
import { buildNeedBytes, wayBuildNeeded } from "./build";
import { ENV_TROUBLE } from "./construct-tools";
import { rmdeps as remoteDeps, rootOf, rootState, type ClientView } from "../remote";
import { allowedRoots, keepFreeBytes, keptFileFor } from "./content";
import { copyFacts, copyRelease, copyServes, judgeCopy, secondCopyOf, type CopyFacts, type CopyServes } from "./copy";
import { previewContentPass, wayBlocked } from "./find";
import { upgradeGaps } from "./gaps";
import { ownRecipe } from "./recipes";
import { ensureInbox, inboxDir, intakeInbox } from "./inbox";
import { contentMatches, inputMatches, proven, type Verdict } from "./match";
import {
  assembling, buildingFor, buildWayId, canonicalJson, contentFacts, contentHashes, contentIdentity, currentPackage, gameFiles, getContent, getPlan, getWay, heldFiles, making,
  planBuilds, planNeeds, planPinned, planSpec, settleWay, updateWay, wayContent, wayOverrides, waysOfGame, waysOfPlan, wstmts, type ContentRow, type PlanRow, type WayRow,
} from "./store";
import type {
  AskCode, AskSpec, CheckReport, CheckTraceStep, ConstructManifest, ContentPlan, CopyView, FailInfo, FileSource, FileView, GameDraft, IntakeManifest,
  JobSpec, MakeInput, RepairBrief, RepairPhase, RunAnswer, RunAsk, RunPhase, RunState, RunStep, RunView,
} from "./types";
import { firstRunOnPlayersPc, validatePlanSpec } from "./validate";

const log = logger("carry");

db.exec(`
CREATE TABLE IF NOT EXISTS carry_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES runtime_plans(id) ON DELETE CASCADE,
  game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
  way_id INTEGER REFERENCES ways(id) ON DELETE SET NULL,
  phase TEXT NOT NULL DEFAULT 'plan',
  state TEXT NOT NULL DEFAULT 'active',
  step_json TEXT,                          -- the child being followed: {job, kind, what, phase, key?, repair? …}
  ask_json TEXT,                           -- RunAsk | null
  facts_json TEXT NOT NULL DEFAULT '{}',   -- what it learned (the draft, the copy, decisions, the failure ledger …)
  steps_json TEXT NOT NULL DEFAULT '[]',   -- RunStep[], newest last
  rounds INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  reissued INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,      -- every write is compare-and-set on it
  next_at INTEGER,
  started_by TEXT NOT NULL DEFAULT 'backfill',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  done_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_open ON carry_runs(plan_id, COALESCE(game_id, 0)) WHERE state NOT IN ('done','stopped');
CREATE INDEX IF NOT EXISTS idx_runs_way ON carry_runs(way_id);
`);

export interface RunRow {
  id: number; plan_id: number; game_id: number | null; way_id: number | null;
  phase: RunPhase; state: RunState;
  step_json: string | null; ask_json: string | null; facts_json: string; steps_json: string;
  rounds: number; tokens: number; reissued: number; version: number;
  next_at: number | null; started_by: RunView["startedBy"];
  created_at: number; updated_at: number; done_at: number | null;
}

/** how many AI repair rounds one run may use (CARRY_AI_ROUNDS; 0: none) */
export const aiRounds = (): number => Math.max(0, Math.floor(cfgNum("CARRY_AI_ROUNDS", 3)));
/** how many tokens one run's AI rounds may spend (CARRY_AI_TOKENS_M, in millions) */
export const aiTokens = (): number => Math.max(0, cfgNum("CARRY_AI_TOKENS_M", 8)) * 1e6;

export interface StartRun {
  /** the plan, or the way (which names the plan and the game) */
  planId?: number; gameId?: number | null; wayId?: number | null; draft?: GameDraft | null;
  by: RunView["startedBy"]; jobId?: number | null;
  /** the admin's "Make it playable" over a PC copy the game already has */
  replace?: boolean;
  /** start held, asking the admin whether to go ahead (the backfill: a plan whose game is not in the library) */
  held?: boolean;
}

/* ─────────── what the run calls outside itself (swapped in tests) ─────────── */

export const crdeps = {
  now: (): number => Date.now(),
  /* the plan */
  checkPlanNow: async (p: PlanRow): Promise<PlanRow> => (await (await import("./api")).checkPlanNow(p)).plan,
  latestRelease: (repo: string, pattern: string | null, channel: string | null) => latestRelease(repo, pattern, channel),
  /* the game */
  matchGame: (plan: PlanRow, draft: GameDraft | null): Promise<GameMatch> => matchGame(plan, draft),
  libraryMatch: (plan: PlanRow, draft: GameDraft | null): GameRow | null => libraryMatch(plan, draft),
  addGameFor: (m: Extract<GameMatch, { kind: "add" }>, c: ContentPlan, draft: GameDraft | null, planName: string): Promise<GameRow> => addGameFor(m, c, draft, planName),
  addWay: (game: GameRow, plan: PlanRow) => addWay(game, plan),
  /** the curated list's game for a repo (step 0), for a plan saved without its construct job's draft */
  curatedGame: async (repo: string): Promise<GameDraft | null> => { try { return (await import("./construct")).step0For(repo, null)?.game ?? null; } catch { return null; } },
  /* the game's copy */
  copyFacts: (gameId: number): CopyFacts | null => copyFacts(gameId),
  judgeCopy: (gameId: number): Promise<CopyFacts | null> => judgeCopy(gameId),
  copyServes: (gameId: number, c: ContentPlan): CopyServes => copyServes(gameId, c),
  /* files */
  inputMatches: (input: MakeInput, row: ContentRow): Verdict => inputMatches(input, { ...contentFacts(row), shape: row.shape ?? "file" }),
  gameFiles: (gameId: number): ContentRow[] => gameFiles(gameId),
  heldFiles: (gameId: number, platform: string): ContentRow[] => heldFiles(gameId, platform),
  keptFileFor: (c: ContentPlan, game: GameRow): ContentRow | null => keptFileFor(c, game),
  exists: (path: string): boolean => existsSync(path),
  /** an earlier download on the seedbox's folder that is not there now: why it is waited for (the folder down or not looked
   *  at yet, a look it could not answer, its client silent or still having it), or null — its client no longer has it (or it
   *  is not on the seedbox's folder at all): passed by */
  seedboxMissing: (d: EarlierDownload): Promise<string | null> => seedboxMissing(d),
  inboxDir: (game: GameRow): string | null => inboxDir(game),
  intakeInbox: (game: GameRow, runId: number) => intakeInbox(game, { runId }),
  ensureInbox: (game: GameRow) => ensureInbox(game),
  previewContentPass: (way: WayRow) => previewContentPass(way),
  /** the releases a way's own blocklist refuses under its content plan as it is now (src/ways/find.ts wayBlocked) */
  wayBlocked: (gameId: number, wayId: number, c: ContentPlan): Set<string> => wayBlocked(gameId, wayId, c),
  /** the game's earlier downloads still on the server (a fetch that landed, was never imported and was not cleaned away,
   *  inside the folders ludarr takes files from), newest first */
  earlierDownloads: (gameId: number): EarlierDownload[] | Promise<EarlierDownload[]> => earlierDownloads(gameId),
  /** the largest second copy of a game's copy kept in the content store on the library's volume (any game's), which
   *  src/ways/copy.ts freeDuplicate frees losslessly */
  duplicateOf: (gameId: number): KeptDuplicate | null => duplicateOf(gameId),
  /** the folders a file on the server may be taken from, as real paths (src/ways/content.ts allowedRoots) */
  allowedRoots: (): Promise<string[]> => allowedRoots(),
  /** whether a kept file is a second copy freeDuplicate would free (src/ways/copy.ts; stats only) */
  secondCopyOf: (row: ContentRow): { bytes: number } | null => secondCopyOf(row),
  keepFree: (): number => keepFreeBytes(),
  diskFree: async (game: GameRow): Promise<number | null> => { const r = rootFolderFor(game); return r ? (await diskSpace(r.path))?.free ?? null : null; },
  /* jobs and requests */
  wayBuildNeeded: (plan: PlanRow, way: WayRow): boolean => wayBuildNeeded(plan, way),
  enqueueJob: (spec: JobSpec, o: { gameId?: number | null; requestId?: number | null; runId?: number | null }): JobRow => enqueueJob(spec, o),
  cancelJob: (id: number, message: string): boolean => cancelJob(id, message, "run"),
  createRequest: (gameId: number, wayId: number) => createRequest({ gameId, wayId, by: FOR_WAY }).request,
  retryRequest: (id: number) => retryRequest(id, { fresh: true }),
  cancelRequest: (id: number) => cancelRequest(id, false),
  /* the AI */
  agentReady: (): boolean => requestDeps.agentReady(),
  constructTokens: async (jobId: number): Promise<number> => { try { return (await import("./construct")).constructTokens(jobId); } catch { return 0; } },
  log: (line: string) => log.info(line),
};

/* ─────────── what a run keeps ─────────── */

/** the job being followed (one at a time; the way's search is a request the file phase reads) */
interface Child {
  job: number;
  kind: string;
  what: string;
  phase: RunPhase;
  /** a repair round's phase */
  repair?: RepairPhase;
  /** the failure ledger's key of what it runs */
  key?: string;
  /** a job the run did not start (the admin's Build, a search's build), followed all the same */
  adopted?: boolean;
  /** the content digest when a round started (upgrade, widen) */
  digest?: string;
  /** the held file a round was asked about */
  held?: number;
  /** a round outside the rounds budget (the first failure with real game data): not counted, so not given back */
  free?: boolean;
  at: number;
}
/** written before a job is queued, so two advances never queue two */
interface Claim { claim: string; at: number }
/** class 'asked': a repair round could not fix it and asked the admin — not run or repaired again until something changes */
interface LedgerEntry { kind: string; class: FailInfo["class"] | "asked"; why: string; at: number; n: number; jobId: number | null; phase?: RepairPhase }
interface RoundNote { phase: RepairPhase; jobId: number; summary: string; outcome: string; at: number }
export type Intent = { kind: "stop"; why: string } | { kind: "retry" } | { kind: "answer"; answer: RunAnswer } | { kind: "tell"; text: string };
interface Facts {
  draft?: GameDraft | null; jobId?: number | null; replace?: boolean;
  /** held, asking whether to build this way over what the game already plays (its go builds with replace) */
  replaceAsk?: boolean;
  /** the way this run attached or followed (a way deleted under the run stops it; it is never added back) */
  wayId?: number | null;
  /** the plan check made for this spec digest */
  checked?: string | null;
  serverBuild?: string | null;
  /** content digests whose upgrade round ended (before and after it) */
  upgraded?: string[];
  /** the gaps the upgrade round now under way was shown, and those a finished one was shown (and could not all fill): a
   *  later edit whose gaps are all among them calls for no new round */
  upgradeAsking?: string[] | null;
  upgradeSeen?: string[];
  upgradeSkipped?: string | null;
  widened?: string | null;
  heldAsked?: number | null;
  /** the copy's verdict said, and its release kept off the way's searches, by package and content digest */
  copySeen?: string | null;
  copyBlocked?: string | null;
  copyJudgeFailedAt?: number | null;
  ledger?: Record<string, LedgerEntry>;
  /** a step this server could not run, backing off; need: for no room, about the free bytes it needs on the library (the
   *  hourly look queues it again only once that much is free); now: the admin (or freed room) asked for a try at once */
  env?: { key: string; n: number; why: string; until: number; kind: string; what: string; need?: number | null; now?: boolean; since?: number;
    /** the seedbox's: its step runs once more to confirm what it ended on (a read that may have failed) — its spec says so */
    confirm?: boolean } | null;
  rooms?: number;
  /** files a build refused (not taken again by this run while the content plan says what it said then: refusedUnder) */
  refusedFiles?: number[];
  refusedUnder?: string | null;
  refusedWhy?: Record<string, string>;
  /** what a job key gave the way (a make's product, the copy taken in): refused by the build, that key is not run again */
  produced?: Record<string, number>;
  /** the way's search the run made itself (a stop or an end cancels only that one, never a member's or the admin's) */
  requestOwn?: number | null;
  fileLandedAt?: number | null; freeRoundUsed?: boolean;
  check?: CheckReport | null;
  lastSearch?: RepairBrief["searched"];
  requestId?: number | null; requestMadeAt?: number | null;
  rounds?: RoundNote[];
  lastFailure?: { phase: RepairPhase; failure: string; jobId: number | null } | null;
  rearmedAt?: number | null; extraRounds?: number;
  /** tokens the admin's own asks added to the run's budget (each "tell" brings a round and its tokens) */
  extraTokens?: number;
  /** what the admin told the AI, waiting for its round to start; about: what the run was asking for when they said it */
  told?: { text: string; at: number; about?: string | null } | null;
  intents?: Intent[];
  seenAssemble?: number;
  inboxAt?: number | null;
  reissuedJob?: number | null;
  /** where the run ended, and the note when it ended before building */
  endedIn?: RunPhase | null; doneNote?: string | null;
  /** the admin asked for a new game from the plan's draft */
  newGame?: boolean;
  /** what a repair round asked the admin for, and under which content digest (its words ride along until it changes) */
  aiAsk?: { spec: AskSpec; phase: RepairPhase; digest: string } | null;
  /** the newest job when the run started: an older job's end is no news to it */
  sinceJob?: number;
  /** per-way builds that ended ok in this run (never built again for the same key) */
  builtKeys?: string[];
}

const J = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
const factsOf = (r: RunRow): Facts => J<Facts>(r.facts_json, {});
const childOf = (r: RunRow): Child | Claim | null => J<Child | Claim | null>(r.step_json, null);
const askOf = (r: RunRow): RunAsk | null => J<RunAsk | null>(r.ask_json, null);
/** (a step recorded under the engine's old name reads as the engine's) */
const stepsOf = (r: RunRow): RunStep[] => J<RunStep[]>(r.steps_json, []).map(s => ((s.who as string) === FORMER ? { ...s, who: "ludarr" as const } : s));
const isClaim = (c: Child | Claim | null): c is Claim => !!c && "claim" in c;
const ACTIVE_REQUEST = ["requested", "matching", "fetching", "processing"];

const rq = {
  byId: db.query("SELECT * FROM carry_runs WHERE id=?"),
  openFor: db.query("SELECT * FROM carry_runs WHERE plan_id=? AND COALESCE(game_id, 0)=COALESCE(?, 0) AND state NOT IN ('done','stopped') ORDER BY id DESC LIMIT 1"),
  anyFor: db.query("SELECT * FROM carry_runs WHERE plan_id=? AND COALESCE(game_id, 0)=COALESCE(?, 0) ORDER BY id DESC LIMIT 1"),
  anyForPlan: db.query("SELECT * FROM carry_runs WHERE plan_id=? ORDER BY id DESC LIMIT 1"),
  openOfWay: db.query("SELECT * FROM carry_runs WHERE way_id=? AND state NOT IN ('done','stopped') ORDER BY id DESC LIMIT 1"),
  openOfWayAll: db.query("SELECT * FROM carry_runs WHERE way_id=? AND state NOT IN ('done','stopped') ORDER BY id"),
  openOfPlan: db.query("SELECT id FROM carry_runs WHERE plan_id=? AND state NOT IN ('done','stopped') ORDER BY id"),
  due: db.query("SELECT id FROM carry_runs WHERE state NOT IN ('done','stopped') AND next_at IS NOT NULL AND next_at<=? ORDER BY next_at, id LIMIT ?"),
  insert: db.query(`INSERT INTO carry_runs (plan_id, game_id, way_id, phase, state, ask_json, facts_json, steps_json, next_at, started_by)
    VALUES (?, ?, ?, 'plan', ?, ?, ?, ?, ?, ?) RETURNING *`),
  liveChildren: db.query("SELECT * FROM jobs WHERE run_id=? AND state IN ('queued','running') ORDER BY id"),
  latestAssemble: db.query("SELECT * FROM jobs WHERE kind='assemble' AND json_extract(spec_json, '$.wayId')=? ORDER BY id DESC LIMIT 1"),
  // the game's own search that is under way: looking, downloading, or taking its download in (a job of its queued or
  // running) — one only parked (its import failed and waits for the AI importer) brings nothing more, and is not waited for
  ordinaryActive: db.query(`SELECT r.*, g.name AS game_name FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.game_id=? AND r.way_id IS NULL
    AND (r.state IN ('matching','fetching') OR (r.state='processing' AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=r.job_id AND j.state IN ('queued','running'))))
    ORDER BY r.id DESC LIMIT 1`),
  wayRequest: db.query("SELECT r.*, g.name AS game_name FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.way_id=? AND r.state IN ('requested','matching','fetching','processing') ORDER BY r.id DESC LIMIT 1"),
  requestById: db.query("SELECT r.*, g.name AS game_name FROM requests r LEFT JOIN games g ON g.id=r.game_id WHERE r.id=?"),
  blockedForWay: db.query("SELECT title, reason FROM blocklist WHERE game_id=? AND way_id=? ORDER BY id DESC"),
  blockedSame: db.query("SELECT 1 AS x FROM blocklist WHERE game_id=? AND way_id=? AND title=? AND COALESCE(plan_digest, '')=? LIMIT 1"),
  contentOfWay: db.query("SELECT * FROM jobs WHERE kind='content' AND state IN ('queued','running') AND json_extract(spec_json, '$.wayId')=? ORDER BY id DESC LIMIT 1"),
};
export const getRun = (id: number) => (rq.byId.get(id) as RunRow | null) ?? null;
const gameRow = (id: number | null | undefined) => (id != null ? (stmts.gameById.get(id) as GameRow | null) ?? null : null);
const jobRow = (id: number | null | undefined) => (id != null ? (stmts.jobById.get(id) as JobRow | null) ?? null : null);
const requestRow = (id: number | null | undefined) => (id != null ? (rq.requestById.get(id) as RequestRow | null) ?? null : null);

/* ─────────── small words and keys ─────────── */

/** a value as canonical JSON (src/ways/store.ts: keys sorted at every depth) — the one every plan_digest is taken of */
const canon = (v: unknown): string => canonicalJson(v ?? null);
/** a digest of a value as canonical JSON (keys sorted): ledger keys and the plan_digest of a way's blocklist rows (the same
 *  as src/ways/store.ts contentDigest for a content plan, so a search's 'form' rows and the run's agree) */
export const digestOf = (v: unknown): string => new Bun.CryptoHasher("sha256").update(canon(v)).digest("hex");
const short = (v: unknown) => digestOf(v).slice(0, 16);
const label = (p: string | null | undefined) => (p ? PLATFORM_LABEL[p as PlatformId] ?? p : "");
const clock = (unixSec: number) => { const d = new Date(unixSec * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
/** when something happens, said with its day unless it is today: "at 16:23", "tomorrow at 16:23", "on 10 Nov at 16:23" */
export function atClock(unixSec: number, nowSec: number = Math.floor(crdeps.now() / 1000)): string {
  const d = new Date(unixSec * 1000), n = new Date(nowSec * 1000);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(n)) return `at ${clock(unixSec)}`;
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  if (day(d) === day(next)) return `tomorrow at ${clock(unixSec)}`;
  return `on ${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} at ${clock(unixSec)}`;
}
const clean = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
const nowMs = () => crdeps.now();
const sec = () => Math.floor(nowMs() / 1000);
const ROUND_WORDS: Record<RepairPhase, string> = {
  plan: "make the plan pass", "server-build": "move the build players' PCs would run to the server", upgrade: "turn what the plan says in words into data",
  widen: "accept the other versions and regions the program's code names", "held-file": "tell whether the file the indexers brought is the game",
  make: "fix the recipe that makes the game data", build: "fix the build", check: "fix the check", told: "rework the plan as you said",
};
/** what one "tell" adds to a run's token budget: the admin asked for that round */
const TOLD_TOKENS = 2e6;
/** the tokens a run may spend on AI rounds: the setting, and what the admin's own asks added */
const tokenBudget = (f: { extraTokens?: number }): number => aiTokens() + (f.extraTokens ?? 0);
/** what a run has left of it now (null: no such run): nothing while AI repairs are switched off, unless the admin asked */
export function runTokensLeft(id: number): number | null {
  const r = getRun(id);
  if (!r) return null;
  const f = factsOf(r);
  if (aiRounds() <= 0 && !(f.extraTokens ?? 0)) return 0;
  return Math.max(0, tokenBudget(f) - r.tokens);
}
/** rounds that improve a plan that works: when the AI cannot run them the run goes on without them */
const IMPROVES: ReadonlySet<RepairPhase> = new Set(["server-build", "upgrade", "widen"]);

/* clocks, in seconds */
const WAIT_EVERY = 60, FILE_EVERY = 120, ROOM_EVERY = 3600, AI_EVERY = 600, DAY = 86_400, NEEDS_EVERY = 3600, OTHER_RETRY = 1800, REARM_EVERY = 30 * DAY, REPLACE_EVERY = 600;
const ENV_LADDER = [1800, 7200, 28_800, 86_400];
/** a make or a per-way build is retried on env at most twice a day */
const LONG_ENV_LADDER = [43_200, 86_400];
/** the seedbox's folder troubled while a job read it (env kind 'remote', src/remote.ts): its own short ladder — 5, 15, 30
 *  min, then hourly — that is no try of the step; asked about after 6 h of it, and still tried every hour */
const REMOTE_LADDER = [300, 900, 1800, 3600];
const REMOTE_ASK_AFTER = 6 * 3600, REMOTE_STOP_AFTER = 72 * 3600;
const MAX_STEPS = 200;

/* ─────────── writes: compare-and-set on the version ─────────── */

interface Patch {
  phase?: RunPhase; state?: RunState; step?: Child | Claim | null; ask?: RunAsk | null; facts?: Facts; steps?: RunStep[];
  rounds?: number; tokens?: number; reissued?: number; next_at?: number | null; game_id?: number | null; way_id?: number | null; done_at?: number | null;
}

/** the newest steps, older 'waiting' notes folded away first */
function capSteps(all: RunStep[]): RunStep[] {
  if (all.length <= MAX_STEPS) return all;
  const out = [...all];
  for (let i = 0; i < out.length && out.length > MAX_STEPS; ) { if (out[i].outcome === "waiting") out.splice(i, 1); else i++; }
  return out.slice(-MAX_STEPS);
}

/** write `patch` over `row` when no one else wrote the row since it was read: the new row, or null (read it again) */
function save(row: RunRow, patch: Patch, o: { quiet?: boolean } = {}): RunRow | null {
  const sets: string[] = [], vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => { sets.push(`${col}=?`); vals.push(v); };
  if (patch.phase !== undefined) set("phase", patch.phase);
  if (patch.state !== undefined) set("state", patch.state);
  if (patch.step !== undefined) set("step_json", patch.step ? JSON.stringify(patch.step) : null);
  if (patch.ask !== undefined) set("ask_json", patch.ask ? JSON.stringify(patch.ask) : null);
  if (patch.facts !== undefined) set("facts_json", JSON.stringify(patch.facts));
  if (patch.steps?.length) set("steps_json", JSON.stringify(capSteps([...stepsOf(row), ...patch.steps])));
  if (patch.rounds !== undefined) set("rounds", patch.rounds);
  if (patch.tokens !== undefined) set("tokens", patch.tokens);
  if (patch.reissued !== undefined) set("reissued", patch.reissued);
  if (patch.next_at !== undefined) set("next_at", patch.next_at);
  if (patch.game_id !== undefined) set("game_id", patch.game_id);
  if (patch.way_id !== undefined) set("way_id", patch.way_id);
  if (patch.done_at !== undefined) set("done_at", patch.done_at);
  if (!sets.length) return row;
  const r = db.query(`UPDATE carry_runs SET ${sets.join(", ")}, version=version+1, updated_at=unixepoch() WHERE id=? AND version=?`).run(...vals, row.id, row.version);
  if (!r.changes) return null;
  const next = getRun(row.id)!;
  if (!o.quiet) emitRun(next);
  return next;
}
/** a server path in words (POSIX: the server is Linux); never one inside an address (https://host/path) */
const SERVER_PATH = /(?<![\w.~:/-])\/(?:[\w.@+'-]+\/)+[\w.@+'-]*/g;
/** the run as a 'run' event shows it: it goes to every client of /system/events, so a path outside the library (a
 *  download's, the config's) is cut to its last part; the run's own routes show it whole */
function eventView(r: RunRow): RunView {
  const v = serializeRun(r);
  const roots = rootFolders().map(f => f.path.replace(/\\/g, "/").replace(/\/+$/, "")).filter(Boolean);
  const cut = (s: string) => s.replace(SERVER_PATH, p => (roots.some(root => p === root || p.startsWith(`${root}/`)) ? p : `…/${basename(p)}`));
  return {
    ...v,
    now: v.now ? { ...v.now, text: cut(v.now.text) } : null,
    ask: v.ask ? { ...v.ask, need: cut(v.ask.need), tried: v.ask.tried.map(cut), byAi: v.ask.byAi ? cut(v.ask.byAi) : null } : null,
    rail: v.rail.map(x => ({ ...x, summary: x.summary ? cut(x.summary) : null })),
  };
}
const emitRun = (r: RunRow) => { try { events.emit("run", eventView(r)); } catch (e: any) { log.warn(`run ${r.id}: ${e?.message ?? e}`); } };
const note = (r: RunRow, text: string, more: Partial<RunStep> = {}): RunStep => ({ at: sec(), phase: r.phase, who: "ludarr", text, outcome: null, ...more });

/* ─────────── the outcome of one step ─────────── */

interface Out { again: boolean }
const AGAIN: Out = { again: true }, STAY: Out = { again: false };
/** a write that went through: stay; one that lost a race: look again from the row as it is now */
const wrote = (r: RunRow | null): Out => (r ? STAY : AGAIN);
/** a write after which the next step follows at once (or a lost race: look again) */
const goOn = (_r: RunRow | null): Out => AGAIN;

/* ─────────── starting, finding, poking, stopping ─────────── */

/**
 * The open run of (plan, game), or a new one. A way names both; a run of a plan that has no game yet is re-keyed to the
 * game once one is named (an admin's way for it). Idempotent: two starts give one run.
 */
export function startRun(o: StartRun): RunRow {
  let planId = o.planId ?? 0, gameId = o.gameId ?? null;
  const wayId = o.wayId ?? null;
  if (wayId != null) {
    const w = getWay(wayId);
    if (!w) throw new Error("no such way");
    planId = w.plan_id; gameId = w.game_id;
    const linked = getPlan(planId);
    const invalid = linked && o.by === "backfill" && automaticProblem(linked, w);
    if (invalid) throw new Error(invalid);
  }
  const plan = getPlan(planId);
  if (!plan) throw new Error("no such plan");
  const wrong = gameId != null && scopeProblem(plan, gameId);
  if (wrong) throw new Error(wrong);
  const open = (rq.openFor.get(planId, gameId) as RunRow | null)
    ?? (gameId != null ? (rq.openFor.get(planId, null) as RunRow | null) : null);
  if (open && (open.game_id === gameId || open.phase === "plan" || open.phase === "game")) {
    for (let i = 0; i < 3; i++) {
      const cur = i === 0 ? open : getRun(open.id);
      if (!cur || cur.state === "done" || cur.state === "stopped") break;
      const f = factsOf(cur);
      const patch: Patch = { facts: { ...(o.replace ? withoutErrors(f) : f), ...(o.draft && !f.draft ? { draft: o.draft } : {}), ...(o.replace ? { replace: true, replaceAsk: false } : {}), ...(o.jobId && !f.jobId ? { jobId: o.jobId } : {}), ...(wayId != null ? { wayId } : {}) } };
      if (cur.game_id == null && gameId != null) patch.game_id = gameId;
      if (wayId != null && cur.way_id == null) patch.way_id = wayId;
      if (cur.state !== "held") patch.next_at = sec();
      else if (o.by === "admin" || o.by === "way") {
        // the admin's "Make it playable", or a way the admin added for it, is a go-ahead (and a Resume); with replace, over
        // what the game already plays: from the plan again, so a build players' PCs would run still moves to the server
        Object.assign(patch, { state: "active", ask: null, next_at: sec(), ...(o.replace && f.replaceAsk ? { phase: "plan" as const } : {}), steps: [{ ...note(cur, o.by === "way" ? "you added a way to play: carrying it through" : "you asked to make it playable: carrying it through"), who: "admin" as const }] });
      }
      try { const r = save(cur, patch); if (r) return r; }
      catch { return cur; }                                               // another open run holds that game: this one stays as it is
    }
    return getRun(open.id) ?? open;
  }
  const newest = (db.query("SELECT MAX(id) AS id FROM jobs").get() as { id: number | null } | null)?.id ?? 0;
  const facts: Facts = { draft: o.draft ?? null, jobId: o.jobId ?? null, sinceJob: newest, ...(o.replace ? { replace: true } : {}), ...(wayId != null ? { wayId } : {}) };
  const game = gameRow(gameId);
  const c = planSpec(plan).content;
  const asked = o.held ? askFor("go-ahead", { plan, game: game ?? (o.draft ? { name: o.draft.name } : null), content: c, now: sec() }) : null;
  const first: RunStep = {
    at: sec(), phase: "plan", who: o.by === "admin" ? "admin" : "ludarr", outcome: o.held ? "asked" : null,
    text: o.by === "construct" ? `${plan.name} was saved: carrying it through` : o.by === "admin" ? "you asked to make it playable" : o.by === "way" ? "a way to play was added: carrying it through"
      : o.held ? `${plan.name} is not carried through until you say so` : "carrying it through",
  };
  try {
    const row = rq.insert.get(planId, gameId, wayId, o.held ? "held" : "active", asked ? JSON.stringify(asked) : null, JSON.stringify(facts), JSON.stringify([first]), o.held ? null : sec(), o.by) as RunRow;
    emitRun(row);
    crdeps.log(`run ${row.id}: ${plan.name}${game ? ` for ${game.name}` : ""} (${o.by})${o.held ? " — held until the admin says go" : ""}`);
    return row;
  } catch (e) {
    // the same start twice at once: the index keeps one open run per (plan, game)
    const again = rq.openFor.get(planId, gameId) as RunRow | null;
    if (again) return again;
    throw e;
  }
}

/** the open run of a way, if any: by its way, else by its plan and game */
export function runFor(wayId: number): RunRow | null {
  const own = rq.openOfWay.get(wayId) as RunRow | null;
  if (own) return own;
  const w = getWay(wayId);
  return w ? ((rq.openFor.get(w.plan_id, w.game_id) as RunRow | null) ?? null) : null;
}

/** advance these runs soon instead of at their next look (a held run moves only on an answer) */
export function pokeRuns(o: { gameId?: number; wayId?: number; planId?: number; jobId?: number; runId?: number }): void {
  const conds: string[] = [], vals: number[] = [];
  if (o.runId != null) { conds.push("id=?"); vals.push(o.runId); }
  if (o.gameId != null) { conds.push("game_id=?"); vals.push(o.gameId); }
  if (o.wayId != null) { conds.push("way_id=?"); vals.push(o.wayId); }
  if (o.planId != null) { conds.push("plan_id=?"); vals.push(o.planId); }
  if (o.jobId != null) { conds.push("(id IN (SELECT run_id FROM jobs WHERE id=? AND run_id IS NOT NULL) OR json_extract(step_json, '$.job')=?)"); vals.push(o.jobId, o.jobId); }
  if (!conds.length) return;
  const now = sec();
  try {
    db.query(`UPDATE carry_runs SET next_at=?, version=version+1 WHERE state NOT IN ('done','stopped','held') AND (next_at IS NULL OR next_at>?) AND (${conds.join(" OR ")})`).run(now, now, ...vals);
  } catch (e: any) { log.warn(`poke: ${e?.message ?? e}`); }
}

/** stop a run and the jobs it started (cancelled by the run: a make's or a build's assemble never follows) */
export function stopRun(id: number, why: string): RunRow | null {
  for (let i = 0; i < 5; i++) {
    const row = getRun(id);
    if (!row) return null;
    if (row.state === "done" || row.state === "stopped") return row;
    const f = factsOf(row);
    const r = save(row, { state: "stopped", step: null, ask: null, next_at: null, done_at: sec(), facts: { ...f, intents: [], endedIn: row.phase }, steps: [note(row, `stopped: ${clean(why)}`)] });
    if (!r) continue;
    for (const j of rq.liveChildren.all(id) as JobRow[]) { try { crdeps.cancelJob(j.id, `cancelled: the carry run stopped (${clean(why)})`); } catch { /* it ends by itself */ } }
    // the way's search the run made goes too (a member's or the admin's own search it followed runs on)
    cancelOwnRequest(f);
    crdeps.log(`run ${id} stopped: ${why}`);
    return r;
  }
  return getRun(id);
}

/** the way's search the run made itself, cancelled while it is still looking */
function cancelOwnRequest(f: Facts) {
  const req = requestRow(f.requestOwn ?? null);
  if (req && ACTIVE_REQUEST.includes(req.state)) void Promise.resolve().then(() => crdeps.cancelRequest(req.id)).catch(() => {});
}

/** stop the open runs of a plan (it is being removed, so the jobs they started go too); how many were stopped */
export function stopRunsOfPlan(planId: number, why: string): number {
  const ids = (rq.openOfPlan.all(planId) as { id: number }[]).map(r => r.id);
  for (const id of ids) stopRun(id, why);
  return ids.length;
}

/** stop the open runs of a way (it was removed); how many were stopped */
export function stopRunsOfWay(wayId: number, why: string): number {
  const w = getWay(wayId);
  const rows = [...(rq.openOfWayAll.all(wayId) as RunRow[]), ...(w ? [rq.openFor.get(w.plan_id, w.game_id) as RunRow | null].filter((x): x is RunRow => !!x) : [])];
  const ids = [...new Set(rows.map(r => r.id))];
  for (const id of ids) stopRun(id, why);
  return ids.length;
}

/* ─────────── what the API and the UI see ─────────── */

const ORDER: Exclude<RunPhase, "done">[] = ["plan", "game", "file", "build", "check"];

/** the game's copy on the server as a way sees it (CopyView), or null when the game has none for a console way: any kind
 *  of package may hold the game's data (a console copy's own dump, or a console file inside a PC copy or an emulator's
 *  bundle); one a look found none in is no copy for it, and one not looked at yet is shown (as being looked at) only when
 *  it is a console copy — any other is looked at in the background, and shown once it holds game data */
export function copyView(gameId: number, c: ContentPlan | null): CopyView | null {
  const cur = currentPackage(gameId);
  if (!cur || c?.platform === "pc") return null;
  const facts = crdeps.copyFacts(gameId);
  if (facts ? Array.isArray(facts.entries) && facts.entries.length === 0 : cur.kind !== "rom") return null;
  let launch = "";
  try { launch = String((JSON.parse(cur.pkg.manifest_json) as { launch?: { exe?: string } }).launch?.exe ?? ""); } catch { /* none */ }
  const v: CopyServes = c ? crdeps.copyServes(gameId, c) : { serves: "unknown", why: "looking at the game's copy" };
  return {
    packageId: cur.pkg.id, name: facts ? basename(facts.rel || facts.path) : basename(launch || cur.pkg.name), size: facts?.size ?? cur.pkg.size ?? 0,
    shape: facts?.shape ?? "file", identity: facts?.identity ?? null, serves: v.serves, why: v.why,
  };
}

/** a game file as a repair round and the admin see it */
export function fileView(row: ContentRow, why: string | null = null): FileView {
  return { contentId: row.id, name: row.name, size: row.size, shape: row.shape ?? "file", source: row.source, platform: row.platform, identity: contentIdentity(row), sha1: contentHashes(row).sha1 ?? null, why };
}

/** what one press of Build does for a way whose file is not attached: the copy is the file, a make from the copy or a
 *  kept dump, or why there is none yet */
export type WayFileRoute =
  | { kind: "file"; row: ContentRow }
  | { kind: "copy"; copy: CopyView }
  | { kind: "make-copy"; copy: CopyView }
  | { kind: "make-kept"; row: ContentRow }
  | { kind: "looking"; copy: CopyView }
  | { kind: "none"; copy: CopyView | null; why: string | null };
export function wayFileRoute(w: WayRow, c: ContentPlan): WayFileRoute {
  const file = w.content_id != null ? getContent(w.content_id) : null;
  if (file && contentMatches(c, contentFacts(file)).ok && crdeps.exists(file.path)) return { kind: "file", row: file };
  const copy = copyView(w.game_id, c);
  if (copy?.serves === "direct") return { kind: "copy", copy };
  if (copy?.serves === "make" && c.make) return { kind: "make-copy", copy };
  if (c.make) {
    for (const row of crdeps.gameFiles(w.game_id)) {
      if (row.role !== "game" || row.source === "made" || row.source === "indexer" || !crdeps.exists(row.path)) continue;
      if (crdeps.inputMatches(c.make.input, row).ok) return { kind: "make-kept", row };
    }
  }
  if (copy?.serves === "unknown") return { kind: "looking", copy };
  return { kind: "none", copy, why: copy ? copy.why : null };
}

function railOf(row: RunRow, f: Facts, plan: PlanRow | null, game: GameRow | null, way: WayRow | null): RunView["rail"] {
  const ended = row.state === "done" ? ORDER.indexOf((f.endedIn ?? "check") as Exclude<RunPhase, "done">) : -1;
  const cur = row.phase === "done" ? ORDER.length : ORDER.indexOf(row.phase as Exclude<RunPhase, "done">);
  const a = askOf(row);
  const file = way?.content_id != null ? getContent(way.content_id) : null;
  const summaries: Record<Exclude<RunPhase, "done">, string | null> = {
    plan: plan ? `${plan.name}${planPinned(plan)?.tag ? ` (${planPinned(plan)!.tag})` : ""}: ${plan.status}${f.serverBuild ? `; ${f.serverBuild}` : ""}` : null,
    game: game ? `${game.name}${way ? `: a way through ${plan?.name ?? "the plan"}` : ""}` : null,
    file: file ? file.name : null,
    build: way?.status === "built" ? "built" : null,
    check: f.check ? (f.check.text || f.check.verdict) : null,
  };
  return ORDER.map((p, i) => {
    let state: RunView["rail"][number]["state"];
    if (row.state === "done") state = ended >= 0 && i > ended ? "todo" : p === "check" && f.check?.verdict === "env" ? "env" : "done";
    else if (i < cur) state = "done";
    else if (i > cur) state = "todo";
    else state = row.state === "active" ? "active" : row.state === "waiting" ? "waiting" : row.state === "asking" ? "asked" : row.state === "held" ? (a ? "asked" : "waiting") : "failed";
    let summary = summaries[p];
    if (i === cur && row.state !== "done") summary = a ? a.title : row.state === "stopped" ? (stepsOf(row).at(-1)?.text ?? "stopped") : summary;
    if (row.state === "done" && i === ended && f.doneNote) summary = f.doneNote;
    return { phase: p, state, summary };
  });
}

/** the API's view of a run (detail: with its steps) */
export function serializeRun(row: RunRow, detail = false): RunView {
  const f = factsOf(row);
  const plan = getPlan(row.plan_id), game = gameRow(row.game_id), way = row.way_id != null ? getWay(row.way_id) : null;
  const child = childOf(row);
  let now: RunView["now"] = null;
  if (child && !isClaim(child)) {
    const j = jobRow(child.job);
    const live = !!j && (j.state === "running" || j.state === "queued");
    // its own words while it runs, and while it waits in the queue the runner's why (room, a build user, a restart);
    // progress only once it has started (a step still queued at "0 %" says nothing of what it waits for)
    const running = live && j!.state === "running";
    const text = live && j!.message ? j!.message : live && !running ? `${child.what} — waiting for its turn` : child.what;
    now = { text, progress: running ? Math.round((j!.progress ?? 0) * 1000) / 1000 : null, jobId: child.job, requestId: null };
  } else if (f.env && f.env.until > sec() && row.state === "waiting") {
    now = { text: f.env.kind === "remote" ? `${f.env.what} waits for the seedbox (${clean(f.env.why)}): trying again ${atClock(f.env.until)}` : `${f.env.what} could not run on this server (${clean(f.env.why)}): trying again ${atClock(f.env.until)}`, progress: null, jobId: null, requestId: null };
  } else if (row.phase === "file" && (row.state === "waiting" || row.state === "asking")) {
    const r = requestRow(f.requestId);
    if (r && ACTIVE_REQUEST.includes(r.state)) now = { text: r.stage ?? "looking on the indexers", progress: Math.round((r.progress ?? 0) * 1000) / 1000, jobId: r.job_id ?? null, requestId: r.id };
  }
  // waiting with nothing of its own under way (an inbox entry still arriving, a step to be tried again later): why, in the
  // words of the step that says so
  if (!now && row.state === "waiting") {
    const last = stepsOf(row).at(-1);
    if (last && (last.outcome === "waiting" || last.outcome === "failed")) now = { text: last.text, progress: null, jobId: null, requestId: null };
  }
  return {
    id: row.id, planId: row.plan_id, planName: plan?.name ?? `plan ${row.plan_id}`, gameId: row.game_id, gameName: game?.name ?? f.draft?.name ?? null, wayId: row.way_id,
    phase: row.phase, state: row.state, rail: railOf(row, f, plan, game, way), now, ask: askOf(row), ...(detail ? { steps: stepsOf(row) } : {}),
    budget: { rounds: aiRounds() + (f.extraRounds ?? 0), roundsUsed: row.rounds, tokens: tokenBudget(f), tokensUsed: row.tokens },
    nextAt: row.next_at, startedBy: row.started_by, createdAt: row.created_at, updatedAt: row.updated_at, doneAt: row.done_at,
  };
}

/* ─────────── the ticker ─────────── */

/** advances of one run never interleave: a second waits for the first */
const inFlight = new Map<number, Promise<void>>();
let ticking = false;
/** all a run keeps in memory (a restart loses only this): the advances in flight and the ticker's own flag */
export const carryMemory = { reset: () => { inFlight.clear(); ticking = false; inboxPaths.clear(); inboxTrouble.clear(); chainedBuilds.clear(); } };

/** advance one run now (a few steps while each says to go on at once); the row as it is after */
export async function advanceRun(id: number, o: { steps?: number } = {}): Promise<RunRow | null> {
  // each call waits for the newest one in flight (a chain): two callers waiting on the same one would both go on at once
  const prev = inFlight.get(id) ?? Promise.resolve();
  const p = prev.catch(() => {}).then(async () => {
    for (let i = 0; i < (o.steps ?? 10); i++) {
      const row = getRun(id);
      if (!row) return;
      let out: Out;
      try { out = await step(row); }
      catch (e: any) {
        // a fault of ludarr's own: said once, looked at again in five minutes
        const msg = String(e?.message ?? e);
        log.warn(`run ${id}: ${msg}`);
        const cur = getRun(id);
        if (cur && cur.state !== "done" && cur.state !== "stopped") {
          const text = `ludarr could not go on: ${clean(msg)}; it looks again in 5 minutes`;
          save(cur, { next_at: sec() + 300, ...(stepsOf(cur).at(-1)?.text === text ? {} : { steps: [note(cur, text, { outcome: "failed" })] }) });
        }
        return;
      }
      if (!out.again) return;
    }
  });
  inFlight.set(id, p);
  try { await p; } finally { if (inFlight.get(id) === p) inFlight.delete(id); }
  return getRun(id);
}

/** advance the runs that are due, oldest first, at most 20 per tick (single-flight) */
export async function carryTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const { id } of rq.due.all(sec(), 20) as { id: number }[]) await advanceRun(id);
  } finally { ticking = false; }
}

/* ─────────── one step ─────────── */

interface Ctx { row: RunRow; f: Facts; plan: PlanRow; game: GameRow | null; way: WayRow | null; judged?: boolean }
const ctxOf = (row: RunRow, plan: PlanRow, f: Facts = factsOf(row)): Ctx => ({ row, f, plan, game: gameRow(row.game_id), way: row.way_id != null ? getWay(row.way_id) : null });

async function step(row: RunRow): Promise<Out> {
  if (row.state === "done" || row.state === "stopped") return STAY;
  const bound = row.game_id != null && getPlan(row.plan_id);
  const existingWay = row.way_id != null ? getWay(row.way_id) : null;
  const wrong = bound && (existingWay ? automaticProblem(bound, existingWay) : scopeProblem(bound, row.game_id!));
  if (wrong) { stopRun(row.id, wrong); return STAY; }
  const f = factsOf(row);
  if (f.intents?.length) return applyIntent(row, f, f.intents[0]);
  if (row.state === "held" && !f.replaceAsk) return row.next_at != null ? wrote(save(row, { next_at: null }, { quiet: true })) : STAY;
  const plan = getPlan(row.plan_id);
  if (!plan) { stopRun(row.id, "the plan was removed"); return STAY; }
  if (row.state === "held") return replaceWatch(ctxOf(row, plan, f));
  const child = childOf(row);
  const live = () => (rq.liveChildren.all(row.id) as JobRow[])[0] ?? null;
  const adopt = (j: JobRow) => adoptJob(ctxOf(row, plan, f), j);
  if (isClaim(child)) {
    // a claim with no job written down: a job of the run's queued meanwhile is the one; an old claim alone is let go
    const j = live();
    if (j) return adopt(j);
    if (sec() - child.at > 120) return goOn(save(row, { step: null }, { quiet: true }));
    return wrote(save(row, { next_at: sec() + 30 }, { quiet: true }));
  }
  if (child) return followChild(ctxOf(row, plan, f), child);
  // a job of the run whose start was not written down (a restart between the two writes): followed
  const j = live();
  if (j) return adopt(j);
  // backing off a step this server could not run
  if (f.env && f.env.until > sec() && row.state === "waiting") return wrote(save(row, { next_at: f.env.until }, { quiet: true }));
  const x = ctxOf(row, plan, f);
  if (row.state === "asking" && askOf(row)?.code === "budget") { const out = await rearm(x); if (out) return out; }
  // asking for room: the step is queued again only once about the room it needs is free — every try before that would
  // fail at once (a failed job and a fresh ask each hour). Looked at again every hour, quietly; freed room (roomFreed) and
  // the admin's Look again try it at once
  if (row.state === "asking" && askOf(row)?.code === "room" && f.env?.kind === "room" && f.env.need != null && !f.env.now && f.env.until <= sec()) {
    const free = x.game ? await crdeps.diskFree(x.game).catch(() => null) : null;
    // the need is an estimate (the job's own check is exact): within a tenth of it, the step is tried
    if (free != null && free < f.env.need * 0.9) return wrote(save(row, { next_at: sec() + ROOM_EVERY, facts: { ...f, env: { ...f.env, until: sec() + ROOM_EVERY } } }, { quiet: true }));
  }
  // what the admin told the AI goes first: its round reworks the plan before anything else is tried under the old one
  if (f.told) return toldStep(x);
  switch (row.phase) {
    case "plan": return planPhase(x);
    case "game": return gamePhase(x);
    case "file": return filePhase(x);
    case "build": return buildPhase(x);
    case "check": return checkPhase(x);
    default: return STAY;
  }
}

/** a job followed as the run's child, in the phase it belongs to (a make's assemble is the build's) */
function adoptJob(x: Ctx, j: JobRow): Out {
  const row = x.row;
  // a plan's own build (no way: its program from source) belongs to the plan phase
  const phase: RunPhase = j.kind === "build" && buildWayId(j) == null ? "plan" : j.kind === "assemble" || j.kind === "build" ? "build" : j.kind === "make" || j.kind === "content" ? "file" : row.phase;
  const key = j.kind === "assemble" && x.way ? assembleKey(x.plan, x.way) : undefined;
  return wrote(save(row, {
    phase, step: { job: j.id, kind: j.kind ?? "job", what: whatJob(j, row), phase, at: sec(), adopted: j.run_id !== row.id, ...(key ? { key } : {}) },
    state: row.state === "asking" && phase === row.phase ? "asking" : "waiting", ...(phase !== row.phase || row.state !== "asking" ? { ask: null } : {}), next_at: sec() + WAIT_EVERY,
  }));
}

/** what a job of the run's is doing, in words */
function whatJob(j: JobRow, row: RunRow): string {
  const g = gameRow(row.game_id)?.name ?? "the game";
  switch (j.kind) {
    case "assemble": return `building ${g}`;
    case "make": return `making ${g}'s game data`;
    case "content": return `taking in ${g}'s game data`;
    case "build": return buildWayId(j) == null ? "building the program from its source" : `building the program for ${g}`;
    case "construct": return "the AI is working on it";
    default: return j.message ?? "under way";
  }
}

/** move to `phase`, the ask cleared, with a step saying why */
function toPhase(x: Ctx, phase: RunPhase, text: string | null, more: Partial<RunStep> = {}, facts?: Facts): Out {
  const patch: Patch = { phase, state: "active", ask: null, next_at: sec(), ...(facts ? { facts } : {}) };
  if (text) patch.steps = [{ ...note(x.row, text, { outcome: "ok" }), ...more }];
  return goOn(save(x.row, patch));
}

/** the run is done: built (the check read, its step naming the job that built it), or with a note before anything was
 *  fetched */
function finish(x: Ctx, text: string, doneNote: string | null, facts: Facts = x.f, more: Partial<RunStep> = {}): Out {
  const r = save(x.row, { phase: "done", state: "done", ask: null, step: null, next_at: null, done_at: sec(), facts: { ...facts, endedIn: doneNote ? x.row.phase : "check", doneNote, intents: [] }, steps: [note(x.row, text, { outcome: "ok", ...more })] });
  if (r) crdeps.log(`run ${r.id}: ${text}`);
  // done before building (the game plays another way): the search it made stops fetching for nothing
  if (r && doneNote) cancelOwnRequest(facts);
  return wrote(r);
}

/** ask the admin; `nextIn`: the run's own clock for what it still watches (null: only an answer moves it) */
function ask(x: Ctx, code: AskCode, facts: AskFacts, nextIn: number | null, o: { facts?: Facts; step?: Child | null } = {}): Out {
  const old = askOf(x.row);
  const a = askFor(code, { plan: x.plan, game: x.game ?? (x.f.draft ? { name: x.f.draft.name } : null), now: sec(), ...facts, askedAt: old?.code === code ? old.askedAt : sec() });
  const next = nextIn == null ? null : sec() + nextIn;
  const same = !!old && canon(old) === canon(a);
  if (same && x.row.state === "asking" && !o.facts && o.step === undefined) return wrote(save(x.row, { next_at: next }, { quiet: true }));
  const patch: Patch = { state: "asking", ask: a, next_at: next, ...(o.facts ? { facts: o.facts } : {}), ...(o.step !== undefined ? { step: o.step } : {}) };
  const newAsk = !old || old.code !== code || old.title !== a.title || old.need !== a.need || x.row.state !== "asking";
  if (newAsk) patch.steps = [note(x.row, `asked: ${a.title}`, { outcome: "asked" })];
  return wrote(save(x.row, patch));
}

/* ─────────── the failure ledger ─────────── */

/** what the ledger says of a key: free to run, a file that is not it, a plan fault to repair, a ludarr error asked about,
 *  one to try once more now, or one to wait for (backing off) */
function ledgerSays(f: Facts, key: string): "free" | "file" | "plan" | "other" | "retry" | "wait" | "asked" {
  const l = f.ledger?.[key];
  if (!l) return "free";
  if (l.class === "asked") return "asked";
  if (l.class === "env") return f.env?.key !== key || sec() >= (f.env?.until ?? 0) ? "free" : "wait";
  if (l.class === "file") return "file";
  if (l.class === "plan") return "plan";
  // a ludarr error: once more after 30 minutes; asked about after that, and still tried again once a day (as the ask says)
  if (l.class === "other" || l.class === "restart") return l.n >= 2 ? (sec() >= l.at + DAY ? "retry" : "other") : sec() >= l.at + OTHER_RETRY ? "retry" : "wait";
  return "free";
}
const withLedger = (f: Facts, key: string, e: LedgerEntry): Facts => ({ ...f, ledger: { ...(f.ledger ?? {}), [key]: e } });
/** a ludarr error asked about (its second failure): the time it is tried again is the ledger's (a day after its last
 *  failure), said and kept as it is whatever wakes the run meanwhile — a look in between neither moves it nor asks again */
function errorAsk(x: Ctx, l: LedgerEntry | undefined, what: string): Out {
  const at = Math.max(sec() + 60, (l?.at ?? sec()) + DAY);
  return ask(x, "env", { failure: l?.why ?? null, what, nextAt: at }, at - sec());
}
/** a step that backs off (the ledger says to wait): looked at again once it may run. A run that asks (for room, for the
 *  server) keeps asking meanwhile: what it asked stands, and freeing room (roomFreed) or an answer still finds it */
const backingOff = (x: Ctx, l: LedgerEntry | undefined): Out =>
  wrote(save(x.row, { state: x.row.state === "asking" ? "asking" : "waiting", next_at: Math.max(sec() + 60, x.f.env?.until ?? (l ? l.at + OTHER_RETRY : sec() + OTHER_RETRY)) }, { quiet: true }));
/** the ludarr errors in the ledger let go (the admin's go-ahead to build over what the game plays: the build the replace
 *  question stopped is not left waiting out an error) */
const withoutErrors = (f: Facts): Facts => (f.ledger ? { ...f, ledger: Object.fromEntries(Object.entries(f.ledger).filter(([, l]) => l.class !== "other")) } : f);
const withoutLedger = (f: Facts, key: string | undefined): Facts => { if (!key || !f.ledger?.[key]) return f; const l = { ...f.ledger }; delete l[key]; return { ...f, ledger: l }; };

/* ─────────── starting a job ─────────── */

/** queue a job as the run's child: a claim first (two advances never queue two), then the job, then the step */
function startJob(x: Ctx, spec: JobSpec, what: string, o: { key?: string; repair?: RepairPhase; digest?: string; held?: number; free?: boolean; facts?: Facts; rounds?: number; text?: string; who?: RunStep["who"]; keepAsk?: boolean } = {}): Out {
  const claimed = save(x.row, { step: { claim: spec.kind, at: sec() } }, { quiet: true });
  if (!claimed) return AGAIN;
  // the step the seedbox's folder held up: its confirming run says so (what it ends with then is taken as it is), and a run
  // that asked about the seedbox keeps asking while the step is tried again (no ask that comes and goes every hour)
  const seedbox = !!o.key && x.f.env?.key === o.key && x.f.env.kind === "remote";
  const job = crdeps.enqueueJob(seedbox && x.f.env?.confirm && (spec.kind === "content" || spec.kind === "make") ? { ...spec, confirm: true } : spec, { gameId: x.game?.id ?? null, runId: x.row.id });
  const child: Child = { job: job.id, kind: spec.kind, what, phase: x.row.phase, at: sec(), ...(o.key ? { key: o.key } : {}), ...(o.repair ? { repair: o.repair } : {}), ...(o.digest ? { digest: o.digest } : {}), ...(o.held != null ? { held: o.held } : {}), ...(o.free ? { free: true } : {}) };
  const keep = (!!o.keepAsk || seedbox) && x.row.state === "asking";
  afterQueue(claimed, {
    step: child, state: keep ? "asking" : "waiting", ...(keep ? {} : { ask: null }), next_at: sec() + WAIT_EVERY,
    ...(o.facts ? { facts: o.facts } : {}), ...(o.rounds !== undefined ? { rounds: o.rounds } : {}),
    steps: [note(x.row, o.text ?? what, { who: o.who ?? "ludarr", outcome: "waiting", jobId: job.id })],
  });
  return STAY;
}
/** the write after a job was queued: a lost race leaves the job to be adopted by its run_id on the next look */
function afterQueue(row: RunRow, patch: Patch) {
  if (save(row, patch)) return;
  const cur = getRun(row.id);
  if (cur && (!childOf(cur) || isClaim(childOf(cur)))) save(cur, { ...patch, steps: patch.steps });
}

/* ─────────── repair rounds ─────────── */

/** the brief a repair round is given */
function brief(x: Ctx, phase: RepairPhase, failure: string, jobId: number | null, file: FileView | null, told: string | null = null): RepairBrief {
  const c = x.way ? wayContent(x.way, x.plan) : planSpec(x.plan).content;
  const job = jobRow(jobId);
  // the program's own output (untrusted: the round's brief fences it), each line cut so one endless line cannot swell the job
  const logTail = job ? String(job.transcript ?? "").split("\n").filter(Boolean).slice(-40).map(l => (l.length > 500 ? `${l.slice(0, 500)} …` : l)) : [];
  return {
    phase, round: x.row.rounds + 1, rounds: aiRounds() + (x.f.extraRounds ?? 0), tokensLeft: Math.max(0, tokenBudget(x.f) - x.row.tokens), ...(told ? { told } : {}),
    failure: failure.length > 2000 ? `${failure.slice(0, 2000)} …` : failure, jobId, logTail, file, copy: x.game ? copyView(x.game.id, c) : null, searched: x.f.lastSearch ?? null, check: x.f.check ?? null,
    earlier: (x.f.rounds ?? []).map(r => ({ phase: r.phase, summary: r.summary, outcome: r.outcome })),
  };
}

/**
 * Ask the AI to fix or improve the plan in `phase`. Without the AI, or past the budget, a repair asks the admin; an
 * improvement (server-build, upgrade, widen) is skipped and the run goes on. The first plan, make or build failure after
 * real game data landed gets one round outside the budget.
 */
function repair(x: Ctx, phase: RepairPhase, failure: string, o: { jobId?: number | null; file?: FileView | null; digest?: string; held?: number; skip?: () => Out; told?: string } = {}): Out {
  const improves = IMPROVES.has(phase);
  const lastFailure = { phase, failure, jobId: o.jobId ?? null };
  if (!crdeps.agentReady()) {
    if (o.skip) return o.skip();
    return ask(x, "ai", { failure, content: x.way ? wayContent(x.way, x.plan) : planSpec(x.plan).content }, AI_EVERY, { facts: { ...x.f, lastFailure }, step: null });
  }
  // one round outside the rounds budget for the first failure with the real game data — never when AI repairs are switched
  // off (0: ludarr goes only as far as it can without the AI), and never past the token budget
  const free = !improves && aiRounds() > 0 && !!x.f.fileLandedAt && !x.f.freeRoundUsed && ["plan", "make", "build", "check"].includes(phase) && x.row.tokens < tokenBudget(x.f);
  const max = aiRounds() + (x.f.extraRounds ?? 0);
  if (!free && (x.row.rounds >= max || x.row.tokens >= tokenBudget(x.f))) {
    if (o.skip) return o.skip();
    return ask(x, "budget", { failure, phase: ROUND_WORDS[phase], rounds: x.row.rounds, roundsSetting: aiRounds(), rearms: rearmsLater(x, phase) }, DAY, { facts: { ...x.f, lastFailure }, step: null });
  }
  const spec: JobSpec = { kind: "construct", repo: x.plan.repo, planId: x.plan.id, gameId: x.game?.id ?? null, runId: x.row.id, repair: brief(x, phase, failure, o.jobId ?? null, o.file ?? null, o.told ?? null) };
  const n = x.row.rounds + (free ? 0 : 1);
  const text = `the AI, ${free ? "an extra round (the first failure with the real game data)" : `round ${n} of ${max}`} (${phase}): ${ROUND_WORDS[phase]} — ${clean(o.told ?? failure).slice(0, 300)}`;
  return startJob(x, spec, `the AI is working on it: ${ROUND_WORDS[phase]}`, {
    repair: phase, digest: o.digest, held: o.held, free, rounds: n, text, who: "ai",
    facts: { ...x.f, lastFailure, ...(free ? { freeRoundUsed: true } : {}) },
  });
}

/** will a run out of budget after a fault in `phase` try once more by itself when the program has a new release (the
 *  budget ask says so only then) */
function rearmsLater(x: Ctx, phase: RepairPhase): boolean {
  const prog = planSpec(x.plan).program;
  return aiRounds() > 0 && ["build", "check"].includes(phase) && (prog.kind === "release" || prog.kind === "feed") && !(x.f.rearmedAt && sec() - x.f.rearmedAt < REARM_EVERY);
}

/** an asking 'budget' run tries once more by itself when the program has a new release — at most once in 30 days, only
 *  after a build or check fault, and never with AI repairs switched off */
async function rearm(x: Ctx): Promise<Out | null> {
  const last = x.f.lastFailure;
  if (aiRounds() <= 0) return null;
  if (!last || !["build", "check"].includes(last.phase)) return null;
  if (x.f.rearmedAt && sec() - x.f.rearmedAt < REARM_EVERY) return null;
  const prog = planSpec(x.plan).program;
  if (prog.kind !== "release" && prog.kind !== "feed") return null;
  let tag: string | null = null;
  try { tag = (await crdeps.latestRelease(prog.kind === "feed" ? prog.feed : x.plan.repo, prog.kind === "release" ? prog.assetPattern : null, prog.kind === "release" ? prog.channel : null))?.tag ?? null; }
  catch { return null; }
  const pinned = planPinned(x.plan)?.tag ?? null;
  if (!tag || tag === pinned) return null;
  return goOn(save(x.row, { state: "active", ask: null, next_at: sec(), facts: { ...x.f, rearmedAt: sec(), extraRounds: (x.f.extraRounds ?? 0) + 1 }, steps: [note(x.row, `${x.plan.name} has a new release (${tag}): the AI tries once more`, { outcome: null })] }));
}

/* ─────────── following a child ─────────── */

const ENDED = new Set(["done", "failed", "cancelled"]);

/** why a job ended badly: its fail_json, else (a job from before) its words; null when it ended ok */
export function failInfoOf(j: JobRow): FailInfo | null {
  if (j.state === "done") return null;
  const own = J<FailInfo | null>(j.fail_json ?? null, null);
  if (own && own.class) return own;
  const m = String(j.message ?? "");
  // an old job's words say only that the run cancelled it, or not: one that may be the admin's holds rather than being undone
  if (j.state === "cancelled") return { class: "cancelled", by: /carry run/i.test(m) ? "run" : "admin" };
  if (/interrupted by a restart/i.test(m)) return { class: "restart" };
  if (/^check:/i.test(m)) return { class: "plan", phase: "check" };
  if (/\bmake step\b/i.test(m)) return { class: "plan", phase: "make" };
  if (/\b(setup step|setup \d+|build step)\b/i.test(m)) return { class: "plan", phase: "build" };
  if (ENV_TROUBLE.test(m)) return { class: "env", kind: /not enough room/i.test(m) ? "room" : "tool" };
  if (/^(the game file|its game file|the game's console copy|there is no game file|needs the game file|no game file)/i.test(m)) return { class: "file" };
  return { class: "other" };
}

/** the repair round a plan fault calls for */
function repairPhaseOf(info: FailInfo, kind: string): RepairPhase {
  switch (info.phase) {
    case "make": case "unpack": case "convert": return "make";
    case "build": case "setup": return "build";
    case "check": return "check";
    case "intake": return "held-file";
    default: return kind === "make" ? "make" : kind === "build" || kind === "assemble" ? "build" : "plan";
  }
}

async function followChild(x: Ctx, child: Child): Promise<Out> {
  const j = jobRow(child.job);
  if (!j) return goOn(save(x.row, { step: null }, { quiet: true }));
  if (!ENDED.has(j.state)) {
    const state: RunState = x.row.state === "asking" ? "asking" : "waiting";
    return wrote(save(x.row, { state, next_at: sec() + WAIT_EVERY }, { quiet: x.row.state === state }));
  }
  const y: Ctx = { ...x, f: j.kind === "assemble" ? { ...x.f, seenAssemble: Math.max(x.f.seenAssemble ?? 0, j.id) } : x.f };
  if (j.kind === "construct" || child.repair) return roundEnded(y, child, j);
  return jobEnded(y, child, j);
}

/** a job's end, classified by its fail_json */
async function jobEnded(x: Ctx, child: Child, j: JobRow): Promise<Out> {
  const info = failInfoOf(j);
  const msg = clean(j.message) || j.state;
  if (!info) {
    // ok: the next step, from the world as it is now
    let f = withoutLedger(x.f, child.key);
    if (f.env?.key === child.key) f = { ...f, env: null };
    if (j.kind === "make" || j.kind === "content") f = { ...f, rooms: 0 };
    // what it gave the way (a product, the copy taken in): should the build refuse that file, the same key is not run again
    // for it (a make from the same input, cached, would only hand the same file to the same build)
    if ((j.kind === "make" || j.kind === "content") && child.key && x.way) {
      const gave = getWay(x.way.id)?.content_id ?? null;
      if (gave != null) f = { ...f, produced: Object.fromEntries([...Object.entries(f.produced ?? {}).filter(([k]) => k !== child.key), [child.key, gave] as [string, number]].slice(-20)) };
    }
    if (j.kind === "build" && child.key) f = { ...f, builtKeys: [...new Set([...(f.builtKeys ?? []), child.key])].slice(-20) };
    // an earlier download taken in that left the way without its file (kept for a look: nothing proves it is the game) is
    // not read again under this content plan — the same bytes would only come to the same end; the held file is asked about
    if (j.kind === "content" && child.key?.startsWith("earlier:") && x.way && !wayHasFile(x)) f = withLedger(f, child.key, { kind: "content", class: "file", why: msg, at: sec(), n: 1, jobId: j.id });
    if (j.kind === "assemble") {
      const check = checkOf(j);
      return goOn(save(x.row, { step: null, phase: "check", state: "active", facts: { ...f, ...(check ? { check } : {}) }, next_at: sec(), steps: [note(x.row, /^built\b/i.test(msg) ? msg : `built: ${msg}`, { outcome: "ok", jobId: j.id })] }));
    }
    let text = msg, outcome: RunStep["outcome"] = "ok";
    if (j.kind === "content") {
      const m = J<Partial<IntakeManifest> | null>(j.manifest_json, null);
      if (m?.inbox && m.contentId == null) { text = `not taken from the inbox: ${clean(m.notes?.[0] ?? msg)}`; outcome = "refused"; }
    }
    return goOn(save(x.row, { step: null, state: "active", facts: f, next_at: sec(), steps: [note(x.row, text, { outcome, jobId: j.id })] }));
  }
  const key = child.key ?? `${j.kind}:${j.id}`;
  const kind = j.kind ?? "job";
  // an intake fault is the held file's question only when the indexers left one; otherwise the plan's
  const c = x.way ? wayContent(x.way, x.plan) : null;
  const rphase = (): RepairPhase => { const p = repairPhaseOf(info, kind); return p === "held-file" && !(x.game && c && crdeps.heldFiles(x.game.id, c.platform).length) ? "plan" : p; };
  const entry = (cls: FailInfo["class"], n = 1): LedgerEntry => ({ kind, class: cls, why: msg, at: sec(), n, jobId: j.id, ...(cls === "plan" ? { phase: rphase() } : {}) });
  // cancelled by the run, or by ludarr itself (a game removed, a search stopped): the world says what comes next
  if (info.class === "cancelled" && info.by !== "admin") return goOn(save(x.row, { step: null, state: "active", facts: x.f, next_at: sec() }, { quiet: true }));
  if (info.class === "cancelled" && info.by === "admin")
    return wrote(save(x.row, { step: null, state: "held", ask: null, facts: x.f, next_at: null, steps: [{ ...note(x.row, `you cancelled job ${j.id}: press Resume to carry on`, { outcome: "waiting", jobId: j.id }), who: "admin" }] }));
  if (info.class === "restart") return jobAgain(x, child, j, msg);
  if (info.class === "env") return backOff(x, key, kind, info.kind ?? "tool", msg, j);
  // a step that read the seedbox's folder and ended on words that may be a failed read of it (a make step or a 7z listing
  // that ran out of time, a read error): run once more before it counts against the recipe or the file — no repair round
  // spent on a recipe that was fine; the confirming run's end is taken as it is
  if (info.remote?.io && !info.remote.confirmed && (j.kind === "make" || j.kind === "content") && ["plan", "file", "other"].includes(info.class)) return confirmOnce(x, key, kind, msg);
  // an assemble that would not start because the plan is not ready (an edit or a check made it a draft, or broken, while
  // the build waited in the queue) says nothing of its recipe: the plan is checked again first, no round spent on it —
  // checked even when its spec is the one checked before (a change of its kind makes it a draft too): the plan phase
  // would otherwise take a plan built per game for ready as it is, and queue the same refused build again and again
  if (info.class === "plan" && !info.phase && kind === "assemble" && (getPlan(x.plan.id) ?? x.plan).status !== "ready")
    return goOn(save(x.row, { step: null, phase: "plan", state: "active", facts: { ...x.f, checked: null }, next_at: sec(), steps: [note(x.row, `refused: ${msg}`, { outcome: "refused", jobId: j.id })] }));
  if (info.class === "plan") {
    const f = withLedger(x.f, key, entry("plan"));
    const r = save(x.row, { step: null, facts: f, steps: [note(x.row, `failed: ${msg}`, { outcome: "failed", jobId: j.id })] });
    if (!r) return AGAIN;
    const file = x.way?.content_id != null ? getContent(x.way.content_id) : null;
    return repair({ ...x, row: r, f }, rphase(), msg, { jobId: j.id, file: file ? fileView(file) : null });
  }
  if (info.class === "file") {
    // a need of the plan's missing (its BIOS removed, an edit that asks for one, while the build waited) is no fault of the
    // game file: the build phase asks for the need, and the game file stays the way's
    if (kind === "assemble" && !planNeeds(getPlan(x.plan.id) ?? x.plan).met)
      return goOn(save(x.row, { step: null, phase: "build", state: "active", facts: x.f, next_at: sec(), steps: [note(x.row, `refused: ${msg}`, { outcome: "refused", jobId: j.id })] }));
    let f = withLedger(x.f, key, entry("file"));
    // the way's file refused by what was built from it: the way's own build, or its program's build for this game
    if ((kind === "assemble" || (kind === "build" && buildWayId(j) != null)) && x.way?.content_id != null) f = withRefused(x, f, x.way.content_id, msg);
    const back: RunPhase = x.row.phase === "build" || x.row.phase === "check" ? "file" : x.row.phase;
    return goOn(save(x.row, { step: null, phase: back, state: "active", facts: f, next_at: sec(), steps: [note(x.row, `refused: ${msg}`, { outcome: "refused", jobId: j.id })] }));
  }
  // the way's program is built for this game first, then the assemble — unless this run built it for the same key already
  // and the assemble still asks for it: building it again would only do the same (hours, gigabytes), so it is a ludarr
  // error like any other (once more after 30 minutes, then asked in its words)
  if (info.class === "other" && info.kind === "needs-build" && x.way && !(x.f.builtKeys ?? []).includes(buildKey(x.plan, x.way))) {
    const r = save(x.row, { step: null, facts: withoutLedger(x.f, key) }, { quiet: true });
    if (!r) return AGAIN;
    // (the admin's run over a PC copy queues the assemble itself, with replace: a build's own assemble would not replace)
    return startJob({ ...x, row: r, f: factsOf(r) }, { kind: "build", planId: x.plan.id, wayId: x.way.id, ...(x.f.replace ? {} : { then: "assemble" as const }), runId: x.row.id }, `building ${x.plan.name}'s program for ${x.game?.name ?? "the game"}`, { key: buildKey(x.plan, x.way) });
  }
  // a ludarr error (or ludarr's own stop): tried once more after 30 minutes under the same key, then asked
  const n = (x.f.ledger?.[key]?.n ?? 0) + 1;
  const f = withLedger(x.f, key, entry("other", n));
  // refused for what the game plays already (a PC copy, another way's build, there since the build was queued): the world
  // is looked at again now — that is the admin's replace question to answer, not an error to wait out
  if (info.kind === "replace" && n < 2) return goOn(save(x.row, { step: null, state: "active", facts: f, next_at: sec(), steps: [note(x.row, `refused: ${msg}`, { outcome: "refused", jobId: j.id })] }));
  // an earlier download ludarr could not take in is one place of several the file may come from: the run goes on at once
  // with the next (the indexers), tries it once more later, and then passes it by — never an ask that holds up the search
  if (child.key?.startsWith("earlier:"))
    return goOn(save(x.row, { step: null, state: "active", facts: f, next_at: sec(), steps: [note(x.row, n < 2 ? `failed: ${msg}; trying again ${atClock(sec() + OTHER_RETRY)}` : `failed again: ${msg}; it is not tried again until the plan changes`, { outcome: "failed", jobId: j.id })] }));
  if (n >= 2) return ask({ ...x, f }, "env", { failure: msg, what: whatOf(kind, x), nextAt: sec() + DAY }, DAY, { facts: f, step: null });
  return wrote(save(x.row, { step: null, state: "waiting", facts: f, next_at: sec() + OTHER_RETRY, steps: [note(x.row, `failed: ${msg}; trying again ${atClock(sec() + OTHER_RETRY)}`, { outcome: "failed", jobId: j.id })] }));
}

/** the way's own file is there and fits its content plan as it is now */
function wayHasFile(x: Ctx): boolean {
  const w = x.way ? getWay(x.way.id) : null;
  const c = w ? wayContent(w, x.plan) : null;
  const file = w?.content_id != null ? getContent(w.content_id) : null;
  return !!file && !!c && crdeps.exists(file.path) && contentMatches(c, contentFacts(file)).ok;
}

const whatOf = (kind: string, x: Ctx): string => {
  const g = x.game?.name ?? "the game";
  switch (kind) {
    case "make": return `Making ${g}'s game data`;
    case "build": return x.game ? `Building ${x.plan.name} for ${g}` : `Building ${x.plan.name}`;
    case "assemble": return `Building ${g}`;
    case "content": return `Taking in ${g}'s game data`;
    case "construct": return "The AI's round";
    case "plan": return `Checking ${x.plan.name}`;
    default: return `A step for ${g}`;
  }
};

/** a step this server could not run: tried again after 30 min, 2 h, 8 h, 24 h (a make or a per-way build: 12 h, 24 h), then
 *  an ask still retried every day; no room asks at once when the library is plainly short of the need (else after three
 *  tries) and looks again every hour */
async function backOff(x: Ctx, key: string, kind: string, envKind: string, why: string, job: JobRow | null = null): Promise<Out> {
  if (envKind === "remote") return waitForSeedbox(x, key, kind, why);
  const ladder = kind === "make" || kind === "build" ? LONG_ENV_LADDER : ENV_LADDER;
  const n = (x.f.env?.key === key ? x.f.env.n : 0) + 1;
  const rooms = envKind === "room" ? (x.f.rooms ?? 0) + 1 : x.f.rooms ?? 0;
  const what = whatOf(kind, x);
  let f: Facts = withLedger({ ...x.f, rooms }, key, { kind, class: "env", why, at: sec(), n, jobId: null });
  // no room: asked at once when the library is plainly short of what the step needs (the same bar the hourly look retries
  // at: step()), so the admin hears of it the first time, not a day and a half and three failed jobs later
  const need = envKind === "room" ? roomNeed(x, job) : 0;
  const free = envKind === "room" && x.game ? await crdeps.diskFree(x.game).catch(() => null) : null;
  if (envKind === "room" && (rooms >= 3 || (free != null && free < need * 0.9))) {
    f = { ...f, env: { key, n, why, until: sec() + ROOM_EVERY, kind: envKind, what, need } };
    const duplicate = x.game ? crdeps.duplicateOf(x.game.id) : null;
    return ask({ ...x, f }, "room", { failure: why, content: x.way ? wayContent(x.way, x.plan) : null, room: free != null ? { need, free, what, keepFree: crdeps.keepFree(), duplicate: duplicate ? { contentId: duplicate.contentId, name: duplicate.name, size: duplicate.size, game: duplicate.gameId !== x.game?.id ? duplicate.gameName : null } : null } : null }, ROOM_EVERY, { facts: f, step: null });
  }
  if (n > ladder.length) {
    f = { ...f, env: { key, n, why, until: sec() + DAY, kind: envKind, what } };
    return ask({ ...x, f }, "env", { failure: why, what, nextAt: sec() + DAY }, DAY, { facts: f, step: null });
  }
  const until = sec() + ladder[n - 1];
  f = { ...f, env: { key, n, why, until, kind: envKind, what } };
  return wrote(save(x.row, { step: null, state: "waiting", ask: null, facts: f, next_at: until, steps: [note(x.row, `${what} could not run on this server: ${why}; trying again ${atClock(until)}`, { outcome: "env" })] }));
}

/** a step the seedbox's folder broke off (it did not answer, it was remounted while the step read it): nothing is wrong with
 *  the step or its game data — tried again after 5, 15, 30 min, then hourly, without counting against the run's ladders; after
 *  6 h of it the admin is asked (and it is still tried every hour); after 72 h it is no longer tried by itself */
function waitForSeedbox(x: Ctx, key: string, kind: string, why: string): Out {
  const what = whatOf(kind, x);
  const prev = x.f.env?.key === key && x.f.env.kind === "remote" ? x.f.env : null;
  const n = (prev?.n ?? 0) + 1, since = prev?.since ?? sec();
  // three days of it, like a search's wait: no more tries by itself — Look again (once the seedbox answers) tries at once
  if (sec() - since >= REMOTE_STOP_AFTER) {
    const f: Facts = { ...withLedger(x.f, key, { kind, class: "env", why, at: sec(), n, jobId: null }), env: { key, n, why, until: sec() + 365 * DAY, kind: "remote", what, since } };
    return ask({ ...x, f }, "env", { failure: `the seedbox has not let this run since ${atClock(since)} (3 days): ${why}`, what, nextAt: null, seedbox: true }, null, { facts: f, step: null });
  }
  const until = sec() + REMOTE_LADDER[Math.min(n - 1, REMOTE_LADDER.length - 1)];
  const f: Facts = { ...withLedger(x.f, key, { kind, class: "env", why, at: sec(), n, jobId: null }), env: { key, n, why, until, kind: "remote", what, since } };
  if (sec() - since >= REMOTE_ASK_AFTER) return ask({ ...x, f }, "env", { failure: `the seedbox has not let this run since ${atClock(since)}: ${why}`, what, nextAt: until, seedbox: true }, 3600, { facts: f, step: null });
  return wrote(save(x.row, { step: null, state: "waiting", ask: null, facts: f, next_at: until, steps: [note(x.row, `${what} waits for the seedbox: ${why}; trying again ${atClock(until)}`, { outcome: "env" })] }));
}

/** a step that read the seedbox's folder and ended on words that may be a failed read of it: run once more soon (its spec
 *  says it is the confirming run), counting against nothing; what it ends with then is taken as it is */
function confirmOnce(x: Ctx, key: string, kind: string, why: string): Out {
  const what = whatOf(kind, x);
  const until = sec() + REMOTE_LADDER[0];
  const f: Facts = { ...withLedger(x.f, key, { kind, class: "env", why, at: sec(), n: 1, jobId: null }), env: { key, n: 1, why, until, kind: "remote", what, since: sec(), confirm: true } };
  return wrote(save(x.row, { step: null, state: x.row.state === "asking" ? "asking" : "waiting", facts: f, next_at: until, steps: [note(x.row, `${what} ended on what may be a failed read of the seedbox folder (${why}): it runs once more before that counts; trying again ${atClock(until)}`, { outcome: "env" })] }));
}

/** about how much free room on the library the step that ran out of it needs: what it writes there (a make, or a download
 *  or inbox entry made into the way's file: its product, about the size of what it is made from — the unpacked input goes
 *  on a volume with room; the copy taken in; a build: the way's file, placed by a copy when no link can be made) and what
 *  the library keeps free (LIBRARY_KEEP_FREE_GB) */
function roomNeed(x: Ctx, j: JobRow | null): number {
  const spec = j ? J<JobSpec | null>(j.spec_json ?? null, null) : null;
  const copy = x.game ? crdeps.copyFacts(x.game.id) : null;
  const sizeAt = (p: string | null | undefined) => { try { const st = p ? statSync(p) : null; return st?.isFile() ? st.size : 0; } catch { return 0; } };
  let bytes: number;
  if (spec?.kind === "make") bytes = spec.contentId != null ? getContent(spec.contentId)?.size ?? 0 : spec.from === "copy" ? copy?.size ?? 0 : sizeAt(spec.path);
  // a download: the size its fetch recorded (a stat over a mounted seedbox folder is not needed for that)
  else if (spec?.kind === "content") bytes = spec.fromCopy ? copy?.size ?? 0 : (spec.fetchId != null ? ((stmts.fetchById.get(spec.fetchId) as { size?: number | null } | null)?.size ?? 0) : 0) || sizeAt(spec.path);
  else {
    const row = x.way?.content_id != null ? getContent(x.way.content_id) : null;
    const file = row?.size ?? 0;
    // a per-game build writes about the game's data again, and a little more (NX2navi: a 25.0 GB .nup, a 26.0 GB build):
    // build.ts's own estimate, the one the build checks before its first step
    bytes = spec?.kind === "build" && spec.wayId != null && row ? buildNeedBytes(x.plan, x.way, row) : file;
  }
  return bytes + crdeps.keepFree();
}

/** a job a restart ended (an AI round is not resumed by itself): queued again once, no round counted */
function jobAgain(x: Ctx, child: Child, j: JobRow, msg: string): Out {
  const key = child.key ?? `${j.kind}:${j.id}`;
  if (x.f.reissuedJob === j.id || x.row.reissued >= 3) {
    // interrupted again: a ludarr error like any other
    const f = withLedger(x.f, key, { kind: j.kind ?? "job", class: "other", why: msg, at: sec(), n: 1, jobId: j.id });
    return wrote(save(x.row, { step: null, state: "waiting", facts: f, next_at: sec() + OTHER_RETRY, steps: [note(x.row, `${msg}; trying again ${atClock(sec() + OTHER_RETRY)}`, { outcome: "failed", jobId: j.id })] }));
  }
  const spec = J<JobSpec | null>(j.spec_json ?? null, null);
  if (!spec) return goOn(save(x.row, { step: null }, { quiet: true }));
  const claimed = save(x.row, { step: { claim: spec.kind, at: sec() }, facts: x.f }, { quiet: true });
  if (!claimed) return AGAIN;
  const again = crdeps.enqueueJob(spec, { gameId: j.game_id, runId: x.row.id });
  afterQueue(claimed, {
    step: { ...child, job: again.id, at: sec() }, state: "waiting", reissued: x.row.reissued + 1, next_at: sec() + WAIT_EVERY, facts: { ...x.f, reissuedJob: again.id },
    steps: [note(x.row, `${msg}: started again (job ${again.id})`, { outcome: "waiting", jobId: again.id, who: child.repair ? "ai" : "ludarr" })],
  });
  return STAY;
}

/** the check report: the LAST check step of an assemble job's trace */
function checkOf(j: JobRow): CheckReport | null {
  const trace = J<unknown[]>(j.trace_json ?? null, []);
  for (let i = trace.length - 1; i >= 0; i--) {
    const s = trace[i] as Partial<CheckTraceStep> | null;
    if (s && s.kind === "check" && s.report) return s.report;
  }
  return null;
}

/** a repair round's end */
async function roundEnded(x: Ctx, child: Child, j: JobRow): Promise<Out> {
  const phase = child.repair ?? "plan";
  const m = J<ConstructManifest | null>(j.manifest_json, null);
  const spent = Math.max(await crdeps.constructTokens(j.id), Number(m?.tokens ?? 0) || 0);
  const tokens = x.row.tokens + spent;
  const summary = clean(j.message).slice(0, 400) || j.state;
  const info = failInfoOf(j);
  if (info?.class === "restart") {
    const r = save(x.row, { tokens }, { quiet: true });
    if (!r) return AGAIN;
    return jobAgain({ ...x, row: r }, child, j, clean(j.message));
  }
  if (info?.class === "cancelled") {
    // what a cancelled round spent still counts against the budget
    const r = spent ? save(x.row, { tokens }, { quiet: true }) : x.row;
    if (!r) return AGAIN;
    return jobEnded({ ...x, row: r }, child, j);
  }
  const changed = m?.changed ?? [];
  const outcome = info ? `failed: ${summary}` : m?.ask ? `asked: ${clean(m.ask.exact).slice(0, 200)}` : changed.length ? `changed ${changed.join(", ")}` : "changed nothing";
  let f: Facts = { ...x.f, rounds: [...(x.f.rounds ?? []), { phase, jobId: j.id, summary, outcome, at: sec() }].slice(-20) };
  const said = (text: string, out: RunStep["outcome"]): RunStep => ({ ...note(x.row, text, { outcome: out, jobId: j.id }), who: "ai", ...(changed.length ? { proof: changed.join(", ") } : {}) });
  // the model could not be reached: the round is given back (a counted one to the budget, the free one to the run) and
  // tried later
  if (info?.class === "env") {
    const given: Facts = child.free ? { ...f, freeRoundUsed: false } : f;
    const r = save(x.row, { tokens, rounds: child.free ? x.row.rounds : Math.max(0, x.row.rounds - 1), facts: given }, { quiet: true });
    if (!r) return AGAIN;
    return backOff({ ...x, row: r, f: given }, `round:${phase}`, "construct", info.kind ?? "net", summary);
  }
  // reread: the round may have changed the plan or the way
  const plan = getPlan(x.plan.id) ?? x.plan;
  const way = x.way ? getWay(x.way.id) : null;
  const digestNow = contentDigest(plan, way);
  if (info) {
    // the round failed: an improvement is let go; a repair is looked at again from its phase (the budget bounds it). A
    // round that gave up (out of turns, out of time) did not see its gaps through: a later content plan asks again
    f = decided(f, phase, child, digestNow, outcome, false, summary);
    return goOn(save(x.row, { step: null, state: "active", tokens, facts: f, next_at: sec(), steps: [said(`the AI's round (${phase}) failed: ${summary}`, "failed")] }));
  }
  if (m?.ask && !IMPROVES.has(phase)) {
    // the failure the round was about is not repaired or run again until something changes it
    const failed = x.f.lastFailure?.jobId ?? null;
    const ledger = Object.fromEntries(Object.entries(f.ledger ?? {}).map(([k, l]) => [k, failed != null && l.jobId === failed ? { ...l, class: "asked" as const, why: clean(m.ask!.exact) } : l]));
    f = { ...f, ledger, aiAsk: { spec: m.ask, phase, digest: digestNow } };
    if (phase === "held-file") f = decided(f, phase, child, digestNow, outcome, true, summary);
    const r = save(x.row, { step: null, tokens, facts: f, steps: [said(`the AI asks: ${clean(m.ask.title)}`, "asked")] }, { quiet: true });
    if (!r) return AGAIN;
    if (phase === "held-file") return goOn(r);                             // the held file's own ask, with the AI's line
    return askFromAi({ ...x, row: r, f, plan, way }, m.ask);
  }
  f = decided(f, phase, child, digestNow, outcome, true, summary);
  // an improvement round that asked (a choice only the admin makes, a file only the owner has): the run goes on without it,
  // and its exact line rides along on the file's ask while the content plan is as it was
  if (phase === "told") {
    // the plan (or this game's way) is as the admin said now: the run takes it up from the plan again — its check, its
    // file from every place, its search started over — and no upgrade round is spent on what the admin's round wrote
    if (changed.length) {
      const r = requestRow(x.f.requestId) ?? (way ? (rq.wayRequest.get(way.id) as RequestRow | null) : null);
      if (r) { try { crdeps.retryRequest(r.id); } catch (e: any) { log.warn(`run ${x.row.id}: the search was not started over: ${e?.message ?? e}`); } }
    }
    f = { ...withoutErrors(f), widened: null, aiAsk: null, checked: null, upgradeSkipped: null, inboxAt: null, upgraded: [...new Set([...(f.upgraded ?? []), digestNow])] };
    return goOn(save(x.row, { step: null, state: "active", ask: null, ...(changed.length ? { phase: "plan" as const } : {}), tokens, facts: f, next_at: sec(), steps: [said(changed.length ? `the AI reworked the plan as you said: ${summary}` : `the AI (told): ${summary}`, "ok")] }));
  }
  const improveAsk = !!m?.ask && IMPROVES.has(phase);
  if (improveAsk) f = { ...f, aiAsk: { spec: m!.ask!, phase, digest: digestNow } };
  if ((phase === "widen" || phase === "make") && changed.length) {
    // what it accepts, or how its file is made from what a search brings, changed: the way's search starts over with it now
    const r = requestRow(x.f.requestId) ?? (way ? (rq.wayRequest.get(way.id) as RequestRow | null) : null);
    if (r) { try { crdeps.retryRequest(r.id); } catch (e: any) { log.warn(`run ${x.row.id}: the search was not started over: ${e?.message ?? e}`); } }
  }
  const text = improveAsk ? `the AI (${phase}) asks: ${clean(m!.ask!.title)} — ${clean(m!.ask!.exact).slice(0, 300)}` : `the AI (${phase}): ${summary}`;
  return goOn(save(x.row, { step: null, state: "active", ask: null, tokens, facts: f, next_at: sec(), steps: [said(text, improveAsk ? "asked" : "ok")] }));
}

/** a round's decision kept in the run, so it is not asked again for the same plan (`finished`: the round ended with its
 *  answer — its gaps were seen through — rather than giving up) */
function decided(f: Facts, phase: RepairPhase, child: Child, digestNow: string, outcome: string, finished = true, summary = ""): Facts {
  switch (phase) {
    case "server-build": {
      if (/^changed .*\b(program|perGame)\b/.test(outcome)) return { ...f, serverBuild: "moved to the server" };
      // the round's own words (its job's message), else what happened, said as a sentence
      const words = clean(summary).replace(/^kept on players' PCs:?\s*/i, "") || (/^failed\b/.test(outcome) ? outcome : "");
      return { ...f, serverBuild: words ? `kept on players' PCs: ${words}` : "kept on players' PCs" };
    }
    case "upgrade": return { ...f, upgraded: [...new Set([...(f.upgraded ?? []), ...(child.digest ? [child.digest] : []), digestNow])], upgradeSkipped: null, upgradeSeen: finished ? [...new Set([...(f.upgradeSeen ?? []), ...(f.upgradeAsking ?? [])])].slice(-40) : f.upgradeSeen ?? [], upgradeAsking: null };
    case "widen": return { ...f, widened: child.digest ?? digestNow };
    case "held-file": return { ...f, heldAsked: child.held ?? f.heldAsked ?? null };
    default: return f;
  }
}

/** the AI could not do it and asks: the words made here from the facts, its exact line beside them. A file it asks for
 *  sends the run back to the file phase (the way's file, when a build or check was about it, not taken again), whose ask
 *  carries the AI's line */
function askFromAi(x: Ctx, a: AskSpec): Out {
  const c = x.way ? wayContent(x.way, x.plan) : planSpec(x.plan).content;
  if (a.need === "file") {
    const fromBuild = (x.row.phase === "build" || x.row.phase === "check") && x.way?.content_id != null;
    const f: Facts = fromBuild ? withRefused(x, x.f, x.way!.content_id!, clean(a.exact)) : x.f;
    return goOn(save(x.row, { phase: "file", state: "active", ask: null, facts: f, next_at: sec() }, { quiet: true }));
  }
  if (a.need === "system-file") {
    const missing = planNeeds(x.plan).missing[0];
    return ask(x, "needs", { need: missing ? planSpec(x.plan).needs[missing.index] ?? null : null, byAi: a }, NEEDS_EVERY);
  }
  // asked while the way's file is looked for: it keeps watching, as the file ask does (an inbox drop, a file picked on the
  // server or a copy that lands is taken while the admin reads the question); from another phase an edit or Look again moves it
  return ask(x, "choice", { byAi: a, content: c }, x.row.phase === "file" ? FILE_EVERY : null);
}

/* ─────────── intents from the API ─────────── */

/** record what the admin asked for (stop, look again, an answer) and poke the run, which applies it on its next step */
export function intend(id: number, intent: Intent): RunRow | null {
  for (let i = 0; i < 5; i++) {
    const row = getRun(id);
    if (!row) return null;
    if (row.state === "done" || row.state === "stopped") return row;
    const f = factsOf(row);
    const r = save(row, { facts: { ...f, intents: [...(f.intents ?? []), intent] }, next_at: sec() }, { quiet: true });
    if (r) return r;
  }
  return getRun(id);
}

async function applyIntent(row: RunRow, f: Facts, it: Intent): Promise<Out> {
  const rest: Facts = { ...f, intents: (f.intents ?? []).slice(1) };
  const admin = (text: string, outcome: RunStep["outcome"] = "ok"): RunStep => ({ ...note(row, text, { outcome }), who: "admin" });
  const late = () => wrote(save(row, { facts: rest, steps: [admin("your answer came after the run had moved on: nothing changed", "refused")] }));
  if (it.kind === "stop") {
    if (!save(row, { facts: rest }, { quiet: true })) return AGAIN;
    stopRun(row.id, it.why);
    return STAY;
  }
  const plan = getPlan(row.plan_id);
  if (!plan) { stopRun(row.id, "the plan was removed"); return STAY; }
  const a = askOf(row);
  if (it.kind === "tell") {
    const words = clean(it.text).slice(0, 300);
    if (row.state === "held") return wrote(save(row, { facts: rest, steps: [admin(`you told the AI what to change, but the run waits for your go-ahead first: nothing changed (${words})`, "refused")] }));
    if (!crdeps.agentReady()) return wrote(save(row, { facts: rest, steps: [admin(`you told the AI what to change, but the AI importer is not set up (Settings → Importers): nothing changed (${words})`, "refused")] }));
    // one round, and its tokens, outside what the run had: the admin asked for it
    const told: Facts = { ...rest, told: { text: it.text, at: sec(), about: a ? `${a.title}: ${a.need}` : null }, aiAsk: null, extraRounds: (rest.extraRounds ?? 0) + 1, extraTokens: (rest.extraTokens ?? 0) + TOLD_TOKENS };
    return goOn(save(row, { state: "active", ask: null, next_at: sec(), facts: told, steps: [admin(`you told the AI: ${words}`)] }));
  }
  if (it.kind === "retry") {
    let f2: Facts = { ...rest, inboxAt: null };
    if (f2.env) f2 = { ...f2, env: { ...f2.env, until: sec(), now: true } };
    // a ludarr error asked about: tried again now
    for (const [k, l] of Object.entries(f2.ledger ?? {})) if (l.class === "other" || l.class === "env" || l.class === "restart" || l.class === "asked") f2 = withoutLedger(f2, k);
    if (f2.aiAsk) f2 = { ...f2, aiAsk: null };
    if (row.state === "held" && !a) {
      // held by a cancel: a search of the way's that was stopped is made again (the run would only find it stopped)
      if (requestRow(f2.requestId)?.state === "cancelled") f2 = { ...f2, requestId: null, requestMadeAt: null, requestOwn: null };
      return goOn(save(row, { state: "active", facts: f2, next_at: sec(), steps: [admin("you pressed Resume: carrying on")] }));
    }
    if (a?.code === "file" && row.way_id != null) {
      const r = requestRow(f2.requestId) ?? (rq.wayRequest.get(row.way_id) as RequestRow | null);
      if (r && ACTIVE_REQUEST.includes(r.state)) { try { crdeps.retryRequest(r.id); } catch { /* a search in flight looks by itself */ } }
      else f2 = { ...f2, requestMadeAt: null };
    }
    const keep = !!a && ["game", "choice", "go-ahead", "held-file"].includes(a.code);
    return goOn(save(row, { ...(keep ? {} : { state: "active", ask: null }), facts: f2, next_at: sec(), steps: [admin("you asked it to look again now")] }));
  }
  const ans = it.answer;
  if ("go" in ans) {
    if (row.state !== "held" || a?.code !== "go-ahead") return late();
    const replacing = !!rest.replaceAsk;
    if (!ans.go) {
      if (!save(row, { facts: rest }, { quiet: true })) return AGAIN;
      stopRun(row.id, replacing ? "you said not now: nothing was removed, and the game plays as it did" : "you said not now: nothing was removed (remove the plan to be done with it)");
      return STAY;
    }
    // build it over what the game plays now: from the plan again (a build players' PCs would run moves to the server first),
    // then its file, its build and the assemble with replace — with no more clicks
    if (replacing) return goOn(save(row, { state: "active", ask: null, phase: "plan", facts: { ...withoutErrors(rest), replace: true, replaceAsk: false }, next_at: sec(), steps: [admin(`you said build ${plan.name} for it: carrying it through, in place of what it plays now`)] }));
    return goOn(save(row, { state: "active", ask: null, facts: rest, next_at: sec(), steps: [admin("you said go ahead")] }));
  }
  if ("newGame" in ans) {
    if (a?.code !== "game") return late();
    return goOn(save(row, { state: "active", ask: null, phase: "game", facts: { ...rest, newGame: true }, next_at: sec(), steps: [admin("you asked for a new game from the plan")] }));
  }
  const g = gameRow(ans.gameId);
  // a game answers "which game" (the plan's, or an emulator's pick) — never a question the AI asked
  if (!g || !(a?.code === "game" || (a?.code === "choice" && !a.byAi))) return late();
  const other = rq.openFor.get(row.plan_id, g.id) as RunRow | null;
  if (other && other.id !== row.id) {
    if (!save(row, { facts: rest }, { quiet: true })) return AGAIN;
    stopRun(row.id, `another run carries ${plan.name} for ${g.name}`);
    pokeRuns({ runId: other.id });
    return STAY;
  }
  return goOn(save(row, { state: "active", ask: null, phase: "game", game_id: g.id, facts: rest, next_at: sec(), steps: [admin(`you answered: ${g.name}`)] }));
}

/** what the admin told the AI (POST /api/v1/run/:id/tell): one round reworks the plan as they say. What the run was asking
 *  for, or what last failed, goes along so the round knows what the words are about */
function toldStep(x: Ctx): Out {
  const told = x.f.told!;
  const about = told.about ?? x.f.lastFailure?.failure ?? "";
  const f: Facts = { ...x.f, told: null };
  const none = () => wrote(save(x.row, { facts: f, steps: [note(x.row, "the AI could not be asked now (its importer is not set up, or the run's AI budget is spent): what you told it was not used", { outcome: "refused" })] }));
  return repair({ ...x, f }, "told", about, { told: told.text, skip: none });
}

/* ─────────── PLAN ─────────── */

/** a per-game source plan (its build reads each game's file) that validates is ready to be built per game */
export function perGameReady(p: PlanRow): boolean {
  const prog = planSpec(p).program;
  return prog.kind === "source" && prog.content === "build" && validatePlanSpec(planSpec(p), p.kind).ok;
}
const planReady = (p: PlanRow) => p.status === "ready" || perGameReady(p);
/** was it decided before for this plan (a round, the admin): a new run does not ask it again */
const decidedInPlan = (p: PlanRow, what: "server-build" | "upgrade" | "widen" | "game") => (planSpec(p).decisions ?? []).some(d => d.what === what);

async function planPhase(x: Ctx): Promise<Out> {
  let plan = x.plan;
  // a plan not marked ready is checked once per spec: a release that picks a file, a source build that is there, a plan
  // built per game that holds together (its check marks it ready: a way's search refuses a plan that is not)
  if (plan.status !== "ready") {
    const key = `check:${short(planSpec(plan))}:${plan.repo}`;
    if (x.f.checked !== key) {
      try { plan = await crdeps.checkPlanNow(plan); }
      catch (e: any) {
        const msg = clean(e?.message ?? String(e));
        // an address the plan names that is refused is the plan's to fix, not the network's to wait for
        if (Number(e?.status) !== 400) return backOff(x, key, "plan", "net", msg);
        const r = save(x.row, { facts: { ...x.f, checked: key }, steps: [note(x.row, `${plan.name} could not be checked: ${msg}`, { outcome: "failed" })] });
        if (!r) return AGAIN;
        return repair({ ...x, row: r, f: factsOf(r) }, "plan", msg);
      }
      const f: Facts = { ...withoutLedger(x.f, key), checked: key, ...(x.f.env?.key === key ? { env: null } : {}) };
      const r = save(x.row, { facts: f, steps: [note(x.row, planReady(plan) ? `${plan.name} is ready${planPinned(plan)?.tag ? ` (${planPinned(plan)!.tag})` : ""}` : `${plan.name} is ${plan.status}${plan.status_note ? `: ${plan.status_note}` : ""}`, { outcome: planReady(plan) ? "ok" : "failed" })] });
      if (!r) return AGAIN;
      if (planReady(plan)) return AGAIN;
      return notReady({ ...x, row: r, f, plan });
    }
    if (!planReady(plan)) return notReady(x);
  }
  // once: a build players' PCs would run is moved to the server — not for a game that already plays another way (the game
  // phase asks first whether to build this way over it: no AI round is spent on it unless the admin says go)
  const reason = firstRunOnPlayersPc(planSpec(plan));
  const known = x.way ?? (x.game ? (wstmts.wayFor.get(x.game.id, plan.id) as WayRow | null) : null);
  const playsAlready = !!x.game && !!playsAnother(x, known ?? { game_id: x.game.id, package_id: null });
  if (reason && !x.f.serverBuild && !decidedInPlan(plan, "server-build") && !playsAlready) {
    return repair(x, "server-build", reason, { skip: () => goOn(save(x.row, { facts: { ...x.f, serverBuild: `kept on players' PCs (the AI is not there to move it): ${reason}` }, steps: [note(x.row, `the build stays on players' PCs for now: ${reason}`)] })) });
  }
  return toPhase(x, "game", null);
}

/** a plan its check left not ready: a source plan whose own build has not run is built first (its recorded steps in the
 *  sandbox, as POST /plan/:id/build runs them — deterministic, no AI), else a round makes it pass */
function notReady(x: Ctx): Out {
  const plan = x.plan, spec = planSpec(plan), prog = spec.program;
  const why = plan.status_note ?? `the plan is ${plan.status}`;
  if (prog.kind !== "source" || prog.content === "build") return repair(x, "plan", why);
  const running = planBuilds(plan.id).find(j => buildWayId(j) == null);
  if (running) return adoptJob(x, running);
  const key = `planbuild:${plan.id}:${short(prog)}:${short(spec.tools ?? null)}`;
  // built once already and still not ready: building it again would only do the same
  if ((x.f.builtKeys ?? []).includes(key)) return repair(x, "plan", why);
  const said = ledgerSays(x.f, key), l = x.f.ledger?.[key];
  if (said === "free" || said === "retry") return startJob(x, { kind: "build", planId: plan.id, runId: x.row.id }, `building ${plan.name} from its source`, { key });
  if (said === "wait") return backingOff(x, l);
  if (said === "plan") return repair(x, l!.phase ?? "build", l!.why, { jobId: l!.jobId });
  if (said === "asked") return askFromAi(x, x.f.aiAsk?.spec ?? { need: "other", title: `${plan.name} waits for you`, exact: l!.why });
  return errorAsk(x, l, whatOf("build", x));
}

/* ─────────── GAME ─────────── */

/** the run's game set (a run of a plan without one is re-keyed); another open run of that pair carries it instead */
function setGame(x: Ctx, g: GameRow, text: string, who: RunStep["who"] = "ludarr"): Out {
  const other = rq.openFor.get(x.plan.id, g.id) as RunRow | null;
  const elsewhere = () => { stopRun(x.row.id, `another run carries ${x.plan.name} for ${g.name}`); if (other) pokeRuns({ runId: other.id }); return STAY; };
  if (other && other.id !== x.row.id) return elsewhere();
  try { return goOn(save(x.row, { game_id: g.id, facts: { ...x.f, newGame: false }, next_at: sec(), steps: [{ ...note(x.row, text, { outcome: "ok" }), who }] })); }
  catch { return elsewhere(); }
}

/** library games of a platform whose only copy is a console dump (an emulator plan's choice) */
function dumpOnlyGames(platform: PlatformId, plan: PlanRow): RunAsk["choices"] {
  const out: RunAsk["choices"] = [];
  for (const g of stmts.allGames.all() as GameRow[]) {
    const cur = currentPackage(g.id);
    if (!cur || cur.kind !== "rom") continue;
    const plats = J<string[]>(g.platforms_json, []);
    if ((cur.platform !== platform && !onPlatform(plats, platform)) || scopeProblem(plan, g.id)) continue;
    out.push({ gameId: g.id, name: g.name, year: g.release_year ?? null, platforms: plats });
  }
  return out.slice(0, 50);
}

async function gamePhase(x: Ctx): Promise<Out> {
  // a way the run had is gone: the admin removed it, and the run never adds it back
  if (x.f.wayId != null && !getWay(x.f.wayId)) { stopRun(x.row.id, "the way was removed"); return STAY; }
  if (x.way) return wayKnown(x, x.way);
  const c = planSpec(x.plan).content;
  if (x.row.game_id != null) {
    const g = x.game;
    if (!g) { stopRun(x.row.id, "the game was removed"); return STAY; }
    const w = wstmts.wayFor.get(g.id, x.plan.id) as WayRow | null;
    if (w) return goOn(save(x.row, { way_id: w.id, facts: { ...x.f, wayId: w.id } }, { quiet: true }));
    const added = await crdeps.addWay(g, x.plan);
    if ("way" in added) return goOn(save(x.row, { way_id: added.way.id, facts: { ...x.f, wayId: added.way.id }, next_at: sec(), steps: [note(x.row, `a way to play ${g.name} through ${x.plan.name}: added${added.warnings.length ? ` (${added.warnings[0]})` : ""}`, { outcome: "ok" })] }));
    if (added.existingId) return goOn(save(x.row, { way_id: added.existingId, facts: { ...x.f, wayId: added.existingId } }, { quiet: true }));
    if (added.wrongGame) {
      const r = save(x.row, { game_id: null, steps: [note(x.row, added.error, { outcome: "refused" })] });
      if (!r) return AGAIN;
      return ask({ ...x, row: r, game: null }, "game", { content: c, choices: [] }, null);
    }
    return repair(x, "plan", `the way could not be added: ${added.error}${added.errors?.length ? ` (${added.errors.join("; ")})` : ""}`);
  }
  if (x.plan.kind === "emulator") {
    const plat = (c?.platform ?? null) as PlatformId | null;
    const choices = plat ? dumpOnlyGames(plat, x.plan) : [];
    if (!choices.length) return finish(x, `${x.plan.name} is an emulator: it plays many games`, `an emulator plays many games: add it to a game to make that one playable${plat ? ` (no library game of ${label(plat)} has only a console copy)` : ""}`);
    return ask(x, "choice", { content: c, choices }, null);
  }
  if (!c) return finish(x, `${x.plan.name} needs no game file`, `${x.plan.name} names no game file, so nothing says which library game it plays: add it to a game to make that one playable`);
  if (x.f.newGame) {
    const m: Extract<GameMatch, { kind: "add" }> = { kind: "add", body: { source: "manual", monitored: true, searchNow: false }, why: "the admin asked for a new game" };
    try { return setGame(x, await crdeps.addGameFor(m, c, x.f.draft ?? null, x.plan.name), "added to the library as a new game", "admin"); }
    catch (e: any) { return ask(x, "game", { content: c, choices: [] }, null, { facts: { ...x.f, newGame: false } }); }
  }
  const m = await crdeps.matchGame(x.plan, x.f.draft ?? null);
  // nothing moved the run while the stores were asked (a stop, an answer): no game is added to the library from an old look
  if (getRun(x.row.id)?.version !== x.row.version) return AGAIN;
  switch (m.kind) {
    case "attach": return setGame(x, m.game, `${x.plan.name} plays ${m.game.name} (${label(c.platform)}): attached`);
    case "add":
      try { const g = await crdeps.addGameFor(m, c, x.f.draft ?? null, x.plan.name); return setGame(x, g, `${g.name} (${label(c.platform)}): added to the library (${m.why})`); }
      catch (e: any) { return ask(x, "game", { content: c, choices: [] }, null); }
    case "ask": return ask(x, "game", { content: c, choices: m.candidates.map(g => ({ gameId: g.id, name: g.name, year: g.release_year ?? null, platforms: J<string[]>(g.platforms_json, []) })) }, null);
    case "none": return ask(x, "game", { content: c, choices: [] }, null);
  }
}

/** the way is there: a game that already plays another way is asked about before anything is fetched or built (unless the
 *  admin asked to replace) */
function wayKnown(x: Ctx, w: WayRow): Out {
  const cur = currentPackage(w.game_id);
  const facts: Facts = { ...x.f, wayId: w.id };
  const built = w.status === "built" && w.package_id != null && cur?.pkg.id === w.package_id;
  if (built) return toPhase({ ...x, way: w }, "build", null, {}, facts);
  const other = playsAnother(x, w);
  if (other) return holdForReplace({ ...x, way: w }, w, other, facts);
  return toPhase({ ...x, way: w }, "file", null, {}, facts);
}

/** what the game already plays through besides this way: what is said of it, what it plays through, and what a build of
 *  this way would take the place of */
interface Plays { text: string; through: string; replaces: string }
/** the game already plays another way — a PC copy, or another way's package — so nothing is fetched or built for this one
 *  until the admin says to build it over that (the replace question; "Make it playable" with replace): what it is, or null.
 *  This way's own older package (a rebuild that failed) is not another way, nor is a console copy (game data, not a game
 *  members play). */
function playsAnother(x: Ctx, w: Pick<WayRow, "game_id" | "package_id">): Plays | null {
  if (x.f.replace) return null;
  const cur = currentPackage(w.game_id);
  const g = x.game?.name ?? "The game";
  if (cur?.kind === "native") {
    let exe = "";
    try { exe = basename(String((JSON.parse(cur.pkg.manifest_json) as { launch?: { exe?: string } }).launch?.exe ?? "").replace(/\\/g, "/")); } catch { /* none said */ }
    return { text: `${g} has a PC copy`, through: `its PC copy${exe ? ` (${exe})` : ""}`, replaces: "the PC copy" };
  }
  if (cur && cur.kind !== "rom" && cur.pkg.id !== w.package_id) {
    const by = waysOfGame(w.game_id).find(o => o.package_id === cur.pkg.id);
    const name = by ? getPlan(by.plan_id)?.name ?? null : null;
    return { text: `${g} already plays another way`, through: name ? `the way built through ${name}` : "another way built for it", replaces: name ? `the ${name} build` : "that build" };
  }
  return null;
}

/**
 * The game already plays another way: the run is held, asking whether to build this way in its place (go: carried on with
 * replace, from the plan, with no more clicks; not now: stopped, nothing removed). The run's own search stops meanwhile,
 * and every 10 minutes the run looks whether the game still plays that way — when it no longer does (its PC copy removed),
 * the run carries on by itself.
 */
function holdForReplace(x: Ctx, w: WayRow, other: Plays, facts: Facts = x.f): Out {
  const c = wayContent(w, x.plan);
  const copy = x.game && c ? copyView(x.game.id, c) : null;
  // a console file in it that nothing the plan checks proves yet (no block: its bytes may still be the way's file)
  const unproven = !!copy && copy.serves === "no" && !!x.game && !!c && crdeps.copyServes(x.game.id, c).block === null;
  const old = askOf(x.row);
  const a = askFor("go-ahead", { plan: x.plan, game: x.game, content: c, now: sec(), replace: { through: other.through, replaces: other.replaces, copy, unproven }, askedAt: old?.code === "go-ahead" ? old.askedAt : sec() });
  // the run's own search: stopped (a member's or the admin's runs on), and forgotten, so a go makes a new one
  cancelOwnRequest(facts);
  const own = facts.requestOwn != null && facts.requestOwn === facts.requestId;
  const f: Facts = { ...facts, replaceAsk: true, ...(facts.requestOwn != null ? { requestOwn: null, ...(own ? { requestId: null, requestMadeAt: null } : {}) } : {}) };
  const same = x.row.state === "held" && !!old && old.code === a.code && old.title === a.title && old.need === a.need;
  if (same) return wrote(save(x.row, { next_at: sec() + REPLACE_EVERY, facts: f }, { quiet: true }));
  return wrote(save(x.row, { state: "held", ask: a, step: null, next_at: sec() + REPLACE_EVERY, facts: f, steps: [note(x.row, `asked: ${a.title} (${other.text})`, { outcome: "asked" })] }));
}

/** a run held for the replace question: carried on by itself once the game no longer plays another way; else looked at
 *  again in 10 minutes (an answer moves it at once) */
function replaceWatch(x: Ctx): Out {
  const w = x.way;
  if (w && x.game && playsAnother(x, w)) return wrote(save(x.row, { next_at: sec() + REPLACE_EVERY }, { quiet: true }));
  const g = x.game?.name ?? "the game";
  return goOn(save(x.row, { state: "active", ask: null, next_at: sec(), facts: { ...x.f, replaceAsk: false }, steps: [note(x.row, `${g} no longer plays another way: carrying it through`, { outcome: "ok" })] }));
}

/** the build players' PCs would run is still to be moved to the server (its round waited while the game played another
 *  way): the plan phase runs it first */
const serverBuildDue = (x: Ctx): boolean => !!firstRunOnPlayersPc(planSpec(x.plan)) && !x.f.serverBuild && !decidedInPlan(x.plan, "server-build");

/* ─────────── FILE ─────────── */

/** a digest of what a way's content plan (and its check) say: an upgrade round runs once per digest */
export function contentDigest(plan: PlanRow, way: WayRow | null): string {
  const spec = planSpec(plan);
  const c = way ? wayContent(way, plan) : spec.content;
  const check = (way ? wayOverrides(way).check : undefined) ?? spec.check ?? null;
  return short({ c, check });
}

/** the files a build refused, under the content plan as it is now (the plan said something else since: judged again) */
function refusedNow(x: Ctx): Set<number> {
  if (!x.way || !x.f.refusedFiles?.length) return new Set();
  if (x.f.refusedUnder && x.f.refusedUnder !== contentDigest(x.plan, x.way)) return new Set();
  return new Set(x.f.refusedFiles);
}
/** a file a build (or a round about the build) refused, kept with its words under the content plan's digest */
function withRefused(x: Ctx, f: Facts, id: number, why: string): Facts {
  const digest = x.way ? contentDigest(x.plan, x.way) : null;
  const same = !f.refusedUnder || f.refusedUnder === digest;
  return { ...f, refusedFiles: [...new Set([...(same ? f.refusedFiles ?? [] : []), id])], refusedUnder: digest, refusedWhy: { ...(same ? f.refusedWhy ?? {} : {}), [String(id)]: clean(why) } };
}

/** the way's file when it is there and fits; a kept one that fits becomes it */
function haveFile(x: Ctx, c: ContentPlan): ContentRow | null {
  const w = x.way!;
  const refused = refusedNow(x);
  const file = w.content_id != null ? getContent(w.content_id) : null;
  if (file && !refused.has(file.id) && crdeps.exists(file.path) && contentMatches(c, contentFacts(file)).ok) return file;
  const kept = x.game ? crdeps.keptFileFor(c, x.game) : null;
  if (kept && !refused.has(kept.id)) { updateWay(w.id, { contentId: kept.id }); settleWay(w.id); return kept; }
  return null;
}

type Source = "kept" | "copy" | "inbox" | "earlier" | "held" | "indexer";
/** where a way's file (or what it is made from) is looked for, in order (content.make.from when it lists any): what the
 *  indexers brought before (the game's earlier downloads still on the server, then a file kept for a look) comes before
 *  a new search */
function sourcesOf(c: ContentPlan): Source[] {
  const from = (c.make?.from ?? []).filter((s): s is FileSource => ["kept", "copy", "inbox", "indexer"].includes(s));
  const out: Source[] = [];
  for (const s of from.length ? from : (["kept", "copy", "inbox", "indexer"] as FileSource[])) { if (s === "indexer") out.push("earlier", "held"); out.push(s); }
  return out;
}

/** a download of the game that landed on the server earlier (a fetch done and not cleaned away) */
export interface EarlierDownload { fetchId: number; title: string; path: string; size: number | null; guid: string | null }
/** a download a search still takes in (its import or its content job queued or running, or the search it landed for about
 *  to queue that job) is that search's, not an earlier one: it is never read beside the job that takes it in; one a search
 *  only parked (an import that failed and waits for the AI importer) is offered like any other */
const earlierQ = db.query(`SELECT f.id, f.title, f.local_path, f.size, f.guid FROM fetches f
  WHERE f.game_id=? AND f.state='done' AND f.local_path IS NOT NULL AND f.cleaned_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM requests r JOIN fetches current ON current.id=r.fetch_id WHERE current.game_id=f.game_id AND (current.id=f.id OR current.local_path=f.local_path) AND r.state IN ('requested','matching','fetching'))
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.state IN ('queued','running') AND (j.fetch_id=f.id OR json_extract(j.spec_json, '$.fetchId')=f.id OR (j.game_id=f.game_id AND j.input_path=f.local_path)))
  ORDER BY f.id DESC LIMIT 20`);
/** an earlier download on the seedbox's folder that is not there now, as the request's judge sees one (src/requests.ts
 *  judgeAbsent): the folder must answer, the file be looked for once more, and its client no longer have it (a usenet
 *  download is only a record in NZBGet's history once its folder is gone) before it is passed by */
async function seedboxMissing(d: EarlierDownload): Promise<string | null> {
  const m = rootOf(d.path);
  if (!m) return null;
  // in the finished-downloads folder (src/arrivals.ts): not there is gone from here (its own cleanup took it), whatever the seedbox still
  // has — passed by, never waited for
  if (m.kind === "synced") return null;
  const s = rootState(m.to);
  if (s?.ok !== true) return `waiting for the seedbox folder to answer: the earlier download ${d.title} is on it`;
  const there = await remoteDeps.stat(d.path);
  if (there === "present") return `the seedbox folder shows the earlier download ${d.title} only now: looking again`;
  if (typeof there === "object") return `the seedbox folder could not say whether the earlier download ${d.title} is there (${there.code}): looking again`;
  const f = stmts.fetchById.get(d.fetchId) as FetchRow | undefined;
  const view: ClientView = f ? await remoteDeps.clientView(f).catch(() => ({ answered: false, has: false })) : { answered: false, has: false };
  if (!view.answered) return `the earlier download ${d.title} is not in the seedbox folder, and its download client is not answering: waiting for it`;
  if (view.has && !view.lost && f?.protocol !== "usenet") return `the seedbox folder does not show the earlier download ${d.title}, though its download client still has it (check the remote path mapping): waiting for it`;
  return null;
}
async function earlierDownloads(gameId: number): Promise<EarlierDownload[]> {
  const rows = earlierQ.all(gameId) as { id: number; title: string; local_path: string; size: number | null; guid: string | null }[];
  if (!rows.length) return [];
  const roots = await crdeps.allowedRoots().catch(() => [] as string[]);
  const inside = (p: string) => roots.some(r => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
  const out: EarlierDownload[] = [];
  for (const r of rows) {
    // a path not on the disk (yet) is judged as written: nothing there can be a link out (the route skips a missing one)
    const real = await realpath(resolve(r.local_path)).catch(() => resolve(r.local_path));
    if (inside(real)) out.push({ fetchId: r.id, title: r.title, path: r.local_path, size: r.size, guid: r.guid });
  }
  return out;
}

/** a second copy of a game's copy kept in the content store (the same bytes on the same volume under another inode — a
 *  link to the copy's own file would free nothing): what src/ways/copy.ts freeDuplicate frees losslessly. Any game's: room
 *  on the library is room for every game on it */
export interface KeptDuplicate { contentId: number; name: string; size: number; gameId: number | null; gameName: string | null }
const keptGameFilesQ = db.query("SELECT * FROM contents WHERE role='game' AND COALESCE(shape, 'file')='file' ORDER BY size DESC LIMIT 500");
function duplicateOf(gameId: number): KeptDuplicate | null {
  const found: KeptDuplicate[] = [];
  const of = (row: ContentRow, size: number): KeptDuplicate => ({ contentId: row.id, name: row.name, size, gameId: row.game_id, gameName: row.game_id != null ? gameRow(row.game_id)?.name ?? null : null });
  // the game's own: a kept file its copy's facts say has the copy's bytes, on the copy's volume under another inode
  for (const e of crdeps.copyFacts(gameId)?.entries ?? []) {
    if (e.contentId == null || e.shape !== "file") continue;
    const row = getContent(e.contentId);
    if (!row || (row.shape ?? "file") !== "file") continue;
    try {
      const a = statSync(e.path), b = statSync(row.path);
      if (a.dev === b.dev && a.ino !== b.ino && a.size === b.size) found.push(of(row, row.size));
    } catch { /* one of them is gone */ }
  }
  // any game's, on the library's volume (src/ways/copy.ts secondCopyOf: what freeDuplicate frees)
  const root = rootFolderFor(gameRow(gameId));
  let dev: number | null = null;
  try { dev = root ? statSync(root.path).dev : null; } catch { /* no root on disk: any volume */ }
  for (const row of keptGameFilesQ.all() as ContentRow[]) {
    if (found.some(d => d.contentId === row.id)) continue;
    const second = crdeps.secondCopyOf(row);
    if (!second) continue;
    if (dev != null) { try { if (statSync(row.path).dev !== dev) continue; } catch { continue; } }
    found.push(of(row, second.bytes));
  }
  return found.sort((a, b) => b.size - a.size)[0] ?? null;
}

const makeKey = (from: string, id: number, c: ContentPlan) => `make:${from}:${id}:${short(c.make ?? null)}`;
const buildKey = (plan: PlanRow, way: WayRow) => `build:${way.id}:${way.content_id ?? 0}:${short(planSpec(plan).program)}:${short(wayContent(way, plan))}`;
const assembleKey = (plan: PlanRow, way: WayRow) => `assemble:${way.id}:${way.content_id ?? 0}:${short(planSpec(plan))}:${short(wayContent(way, plan))}:${short(wayOverrides(way))}:${planPinned(plan)?.sha256 || planPinned(plan)?.tag || ""}`;

/** the upgrade round, once per content digest (the file phase never searches before it ended) */
async function upgradeStep(x: Ctx): Promise<Out | null> {
  const w = x.way!;
  const spec = planSpec(x.plan);
  const digest = contentDigest(x.plan, w);
  if ((x.f.upgraded ?? []).includes(digest)) return null;
  // a recomp's or a port's plan says it for every game: an upgrade decided on it is not asked again
  if (x.plan.kind !== "emulator" && decidedInPlan(x.plan, "upgrade")) return null;
  // an emulator from ludarr's own list is data already (its formats, its settings, what it needs): no round is spent on
  // turning it into data, game after game (it draws with a graphics device, so the server checks nothing of it either way)
  if (ownRecipe(x.plan)) return goOn(save(x.row, { facts: { ...x.f, upgraded: [...(x.f.upgraded ?? []), digest] } }, { quiet: true }));
  const canRound = crdeps.agentReady() && x.row.rounds < aiRounds() + (x.f.extraRounds ?? 0) && x.row.tokens < tokenBudget(x.f);
  if (x.f.upgradeSkipped === digest && !canRound) return null;
  const gaps = upgradeGaps({ ...spec, check: wayOverrides(w).check ?? spec.check ?? null }, wayContent(w, x.plan), x.plan.kind);
  if (!gaps.length) return goOn(save(x.row, { facts: { ...x.f, upgraded: [...(x.f.upgraded ?? []), digest] } }, { quiet: true }));
  // every gap left is one an upgrade round of this run was shown already and could not fill (a check this program cannot
  // run without a GPU, say): a later edit of the content plan (an accepted file, a search term) calls for no new round
  const seen = new Set(x.f.upgradeSeen ?? []);
  if (seen.size && gaps.every(gp => seen.has(gp))) return goOn(save(x.row, { facts: { ...x.f, upgraded: [...(x.f.upgraded ?? []), digest] } }, { quiet: true }));
  // the game's copy judged first (small reads, seconds), so the round's brief says what is on the server
  if (canRound && x.game && !x.judged && currentPackage(x.game.id) && !crdeps.copyFacts(x.game.id) && !(x.f.copyJudgeFailedAt && sec() - x.f.copyJudgeFailedAt < 3600)) {
    x.judged = true;
    try { await crdeps.judgeCopy(x.game.id); }
    catch {
      const r = save(x.row, { facts: { ...x.f, copyJudgeFailedAt: sec() } }, { quiet: true });
      if (!r) return AGAIN;
      x.row = r; x.f = factsOf(r);
    }
  }
  x.f = { ...x.f, upgradeAsking: gaps };
  return repair(x, "upgrade", gaps.join("; "), {
    digest,
    skip: () => goOn(save(x.row, { facts: { ...x.f, upgradeSkipped: digest }, ...(x.f.upgradeSkipped === digest ? {} : { steps: [note(x.row, `the plan is used as it is for now (the AI is not there to add what it lacks: ${gaps[0]})`)] }) }, { quiet: x.f.upgradeSkipped === digest })),
  });
}

interface RouteState { tried: TriedFacts; waiting: string | null; searchedNothing: boolean; request: RequestRow | null; download: RequestRow | null }
/** the reason the run writes on the way's blocklist row for the game's own copy's release */
const COPY_BLOCK = "the game's own copy on the server";

/** the copy's release title on the way's blocklist (once), so no search fetches the same bytes again — as the copy's verdict
 *  says (block: its class; null: never — the bytes may still be the way's file, from another place or once proven) */
function blockCopyRelease(x: Ctx, c: ContentPlan, copy: CopyView, facts: CopyFacts | null, block?: CopyServes["block"]): Facts {
  const key = `${copy.packageId}:${short(c)}`;
  if (x.f.copyBlocked === key) return x.f;
  if (block === null) return { ...x.f, copyBlocked: key };
  const cur = currentPackage(x.game!.id);
  const title = J<{ source?: { title?: string | null } }>(cur?.pkg.manifest_json ?? null, {}).source?.title ?? null;
  if (title) {
    const id = facts?.identity ?? copy.identity;
    const serials = (c.accept.serials ?? []).map(s => s.toUpperCase().replace(/[-_]/g, ""));
    const other = !!id?.serial && serials.length > 0 && !serials.includes(String(id.serial).toUpperCase().replace(/[-_]/g, ""));
    const cls = block ?? ((id?.sealed && id.shape !== "nsp" && id.shape !== "xci") || other || id?.category === "patch" ? "identity" : "form");
    // one row per release and content plan (a lost race writes it again otherwise)
    try { if (!rq.blockedSame.get(x.game!.id, x.way!.id, title, digestOf(c))) stmts.insertWayBlock.run(x.game!.id, null, title, null, `${COPY_BLOCK}: ${clean(copy.why)}`, x.way!.id, digestOf(c), cls); }
    catch (e: any) { log.warn(`run ${x.row.id}: the copy's release was not blocked: ${e?.message ?? e}`); }
  }
  return { ...x.f, copyBlocked: key };
}

async function filePhase(x: Ctx): Promise<Out> {
  const w = x.way;
  if (!w) return toPhase(x, "game", null);
  if (x.f.wayId != null && !getWay(x.f.wayId)) { stopRun(x.row.id, "the way was removed"); return STAY; }
  const g = x.game;
  if (!g) { stopRun(x.row.id, "the game was removed"); return STAY; }
  if (!planReady(x.plan)) return toPhase(x, "plan", `${x.plan.name} is ${x.plan.status} again`);
  const c = wayContent(w, x.plan);
  if (!c) return toPhase(x, "build", `${x.plan.name} needs no game file`);
  // a job of the way already under way (the admin's Build press, a search's download being taken in): followed, never a second
  const busy = making(w.id) ?? assembling(w.id) ?? buildingFor(w) ?? ((rq.contentOfWay.get(w.id) as JobRow | null) ?? null);
  if (busy) return adoptJob(x, busy);
  // the game came to play another way meanwhile (a PC copy imported, another way built): nothing more is fetched for this
  // one until the admin says to build it in that one's place
  const other = playsAnother(x, w);
  if (other) return holdForReplace(x, w, other);
  // a build players' PCs would run moves to the server before anything is fetched for it (the admin said to build it over
  // what the game played, after its round was skipped for that)
  if (serverBuildDue(x)) return toPhase(x, "plan", null);
  // what the plan says in words, made data first
  const up = await upgradeStep(x);
  if (up) return up;
  // the way's file, or a kept one
  const file = haveFile(x, c);
  if (file) {
    const v = contentMatches(c, contentFacts(file));
    return toPhase(x, "build", `the game file: ${file.name}${proven(v) ? ` (${v.matched ? `its ${v.matched.algo} matched` : `${v.serial} matched`})` : ""}`, { contentId: file.id }, { ...x.f, fileLandedAt: x.f.fileLandedAt ?? sec() });
  }
  const st: RouteState = { tried: { kept: [], failed: [] }, waiting: null, searchedNothing: false, request: null, download: null };
  const copyNow = crdeps.copyFacts(g.id);
  const sources = sourcesOf(c);
  // a search of the run's own for data only its owner can make (the plan said so since it began): stopped — it would fetch
  // copies the way refuses, one after another
  if (c.personalDump && x.f.requestOwn != null) {
    const mine = requestRow(x.f.requestOwn);
    if (mine && ACTIVE_REQUEST.includes(mine.state)) void Promise.resolve().then(() => crdeps.cancelRequest(mine.id)).catch(() => {});
    const s = save(x.row, { facts: { ...x.f, requestId: null, requestMadeAt: null, requestOwn: null }, steps: [note(x.row, `the indexers are no longer searched: only its owner can make this game data (${clean(c.personalDump).slice(0, 200)})`)] });
    if (!s) return AGAIN;
    x.row = s; x.f = factsOf(s);
  }
  for (const src of sources) {
    const out = await route(x, src, c, st, copyNow);
    if (out) return out;
  }
  // the plan takes its game data only from some places (content.make.from): the ask says the indexers are not searched, and why
  if (!sources.includes("indexer")) {
    const from = sources.map((s): string | null => (s === "kept" ? "files kept on the server" : s === "copy" ? "the game's copy" : s === "inbox" ? "the inbox" : null)).filter((s): s is string => !!s);
    st.tried.indexers = { looked: 0, reason: null, nextAt: null, not: `${x.plan.name} takes its game data only from ${from.length > 1 ? `${from.slice(0, -1).join(", ")} and ${from.at(-1)}` : from[0] ?? "what is given to it"}` };
  }
  // nothing usable now
  if (st.waiting && !c.personalDump) {
    const state: RunState = x.row.state === "asking" ? "asking" : "waiting";
    const repeat = stepsOf(x.row).at(-1)?.text === st.waiting;
    return wrote(save(x.row, { state, next_at: sec() + FILE_EVERY, ...(repeat ? {} : { steps: [note(x.row, st.waiting, { outcome: "waiting", ...(st.request ? { requestId: st.request.id } : {}) })] }) }, { quiet: repeat && x.row.state === state }));
  }
  // the indexers searched and nothing usable: once, the AI widens what it accepts with evidence from the program's code
  // (an emulator from ludarr's own list takes any game of its console in the forms it reads: there is nothing to widen,
  // and its round would only read the emulator's code for hours — Flycast's ran out of its 120 minutes, 2026-11-11)
  if (st.searchedNothing && !x.f.widened && !c.personalDump && !ownRecipe(x.plan)) {
    const digest = contentDigest(x.plan, w);
    let lastSearch = x.f.lastSearch ?? null;
    try {
      const p = await crdeps.previewContentPass(w);
      lastSearch = { names: p.names, looked: p.candidates.length, candidates: p.candidates.slice(0, 20).map(k => ({ title: k.title, size: k.size, why: k.why })) };
    } catch { /* the search's own words stand in */ }
    const y: Ctx = { ...x, f: { ...x.f, lastSearch } };
    const tried = st.tried;
    const onServer = !!tried.copy || (tried.kept ?? []).length > 0 || (tried.failed ?? []).length > 0 || (tried.earlier ?? []).length > 0;
    if (lastSearch && lastSearch.looked === 0 && !onServer) {
      // the indexers had no release at all, and the server holds nothing the plan turned down: what it accepts is not what
      // stands in the way, so no AI round is spent widening it — the file is asked for
      const f: Facts = { ...y.f, widened: digest };
      const s = save(x.row, { facts: f, steps: [note(x.row, `the indexers had no release at all for ${clean(c.what)}, and nothing on the server was turned down: nothing to widen what the plan accepts against`)] }, { quiet: true });
      if (!s) return AGAIN;
      return fileAsk({ ...y, row: s, f }, c, { st });
    }
    return repair(y, "widen", `the indexers have nothing usable for ${clean(c.what)}`, { digest, skip: () => fileAsk(y, c, { st, facts: { ...y.f, widened: digest } }) });
  }
  return fileAsk(x, c, { st });
}

/** one route of the file phase: a job started or an ask (Out), or null to go on to the next, what it found noted in `st` */
async function route(x: Ctx, src: Source, c: ContentPlan, st: RouteState, copyNow: CopyFacts | null): Promise<Out | null> {
  const g = x.game!, w = x.way!;
  const tried = st.tried;
  // the admin's run over a PC copy queues the assemble itself, with replace (a make's own assemble would not replace)
  const thenAssemble = x.f.replace ? {} : { then: "assemble" as const };
  const blocked = (key: string, what: string, kind: string, phase: RepairPhase, file?: FileView): Out | null | "skip" => {
    // what this key gave the way was refused by the build: the same input and recipe would only give the same file again
    const gave = x.f.produced?.[key];
    if (gave != null && refusedNow(x).has(gave)) { tried.failed!.push({ what, why: `the build refused what it gave: ${x.f.refusedWhy?.[String(gave)] ?? "not the game file"}` }); return "skip"; }
    const said = ledgerSays(x.f, key);
    const l = x.f.ledger?.[key];
    if (said === "free" || said === "retry") return null;
    if (said === "file" || said === "asked") { tried.failed!.push({ what, why: l!.why }); return "skip"; }
    // a step the seedbox's folder held up holds the route: what it reads (an earlier download) is waited for, never passed
    // by for another copy from the indexers — whatever wakes the run meanwhile
    if (said === "wait" && x.f.env?.key === key && x.f.env.kind === "remote") return backingOff(x, l);
    if (said === "wait") { st.waiting = st.waiting ?? `${whatOf(kind, x)} waits to be tried again`; return "skip"; }
    if (said === "plan") return repair(x, l!.phase ?? phase, l!.why, { jobId: l!.jobId, file: file ?? null });
    return errorAsk(x, l, whatOf(kind, x));
  };
  switch (src) {
    case "kept": {
      // a kept dump the way's file is made from
      for (const row of crdeps.gameFiles(g.id)) {
        if (row.role !== "game" || row.source === "made" || row.source === "indexer" || !crdeps.exists(row.path)) continue;
        if (contentMatches(c, contentFacts(row)).ok) {
          // a file that fits which haveFile did not take (a build refused it, or nothing proves it is the game): said, never
          // taken by itself
          const refusal = refusedNow(x).has(row.id) ? x.f.refusedWhy?.[String(row.id)] ?? "not the game file" : null;
          tried.kept!.push({ name: row.name, why: refusal ? `refused by the build: ${refusal}` : "a file that fits, and nothing proves it is the game: accept it on the way if it is" });
          continue;
        }
        const same = !!copyNow?.sha256 && (contentHashes(row).sha256 === copyNow.sha256 || contentHashes(row).sha256 === copyNow.sha256?.toLowerCase());
        const why = contentMatches(c, contentFacts(row)).why ?? "not the game file";
        if (!c.make) { tried.kept!.push({ name: row.name, why, same }); continue; }
        const v = crdeps.inputMatches(c.make.input, row);
        if (!v.ok) { tried.kept!.push({ name: row.name, why: v.why ?? why, same }); continue; }
        const key = makeKey("kept", row.id, c);
        const b = blocked(key, `Making the game data from ${row.name}`, "make", "make", fileView(row));
        if (b === "skip") continue;
        if (b) return b;
        return startJob(x, { kind: "make", wayId: w.id, from: "kept", contentId: row.id, ...thenAssemble, auto: true, runId: x.row.id }, `making the game data from ${row.name}`, { key, facts: { ...x.f, fileLandedAt: x.f.fileLandedAt ?? sec() } });
      }
      return null;
    }
    case "copy": {
      // any kind of package may hold the game's data (a console copy's dump, a console file inside a PC copy)
      const cur = currentPackage(g.id);
      if (!cur) return null;
      let v = crdeps.copyServes(g.id, c);
      if (v.serves === "unknown") {
        if (x.judged || (x.f.copyJudgeFailedAt && sec() - x.f.copyJudgeFailedAt < 3600)) { st.waiting = st.waiting ?? "looking at the game's copy"; return null; }
        x.judged = true;
        try { await crdeps.judgeCopy(g.id); }
        catch (e: any) {
          const r = save(x.row, { facts: { ...x.f, copyJudgeFailedAt: sec() }, steps: [note(x.row, `the game's copy could not be looked at: ${clean(e?.message ?? String(e))}`, { outcome: "failed" })] }, { quiet: true });
          if (!r) return AGAIN;
          x.row = r; x.f = factsOf(r);
          st.waiting = st.waiting ?? "looking at the game's copy";
          return null;
        }
        v = crdeps.copyServes(g.id, c);
        if (v.serves === "unknown") { st.waiting = st.waiting ?? "looking at the game's copy"; return null; }
      }
      // a package with no game data a console plays in it (a PC game's own copy) is no copy for this way: nothing is said
      const view = copyView(g.id, c);
      if (!view) return null;
      if (v.serves === "direct") {
        const key = `copy:${cur.pkg.id}:${short(c)}`;
        const b = blocked(key, `Taking the copy on the server (${view.name})`, "content", "plan");
        if (b === "skip") return null;
        if (b) return b;
        return startJob(x, { kind: "content", gameId: g.id, wayId: w.id, fromCopy: true, runId: x.row.id }, `taking the game's copy (${view.name}, ${sizeWords(view.size)}) as the game file`, { key, facts: { ...x.f, fileLandedAt: x.f.fileLandedAt ?? sec() } });
      }
      if (v.serves === "make" && c.make) {
        const key = makeKey("copy", cur.pkg.id, c);
        const b = blocked(key, `Making the game data from the copy on the server (${view.name})`, "make", "make");
        if (b === "skip") return null;
        if (b) return b;
        return startJob(x, { kind: "make", wayId: w.id, from: "copy", packageId: cur.pkg.id, ...thenAssemble, auto: true, runId: x.row.id }, `making the game data from the game's copy (${view.name}, ${sizeWords(view.size)})`, { key, facts: { ...x.f, fileLandedAt: x.f.fileLandedAt ?? sec() } });
      }
      // no: said once with the copy's own words, and its release kept off the way's searches; nothing is copied
      tried.copy = { name: view.name, size: view.size, why: v.why };
      const seen = `${cur.pkg.id}:${short(c)}:${v.why}`;
      if (x.f.copySeen !== seen) {
        const judged = crdeps.copyFacts(g.id) ?? copyNow;
        const f = { ...blockCopyRelease(x, c, view, judged, v.block), copySeen: seen };
        const id = judged?.identity;
        const proof = id ? [id.serial, id.masterVersion ?? id.version, id.region, id.sealed ? "sealed" : null].filter(Boolean).join(", ") : undefined;
        const r = save(x.row, { facts: f, steps: [note(x.row, `The copy on the server (${view.name}, ${sizeWords(view.size)}) is ${clean(v.why)}: nothing is copied from it`, { outcome: "refused", ...(proof ? { proof } : {}) })] });
        if (!r) return AGAIN;
        x.row = r; x.f = f;
      }
      return null;
    }
    case "inbox": {
      // read every two minutes (at once when the admin asks to look again: inboxAt cleared)
      if (x.f.inboxAt && sec() - x.f.inboxAt < FILE_EVERY - 10) return null;
      const r = await crdeps.intakeInbox(g, x.row.id);
      const f: Facts = { ...x.f, inboxAt: sec() };
      const job = r.jobs.length ? jobRow(r.jobs[0]) : null;
      if (job) {
        const text = `${basename(job.input_path)} landed in the inbox: taking it in`;
        const saved = save(x.row, { step: { job: job.id, kind: "content", what: text, phase: "file", at: sec(), key: `inbox:${job.input_path}` }, state: "waiting", ask: null, next_at: sec() + WAIT_EVERY, facts: { ...f, fileLandedAt: f.fileLandedAt ?? sec() }, steps: [note(x.row, text, { outcome: "waiting", jobId: job.id })] });
        if (!saved) return AGAIN;                                          // the job carries the run's id: it is adopted on the next look
        return STAY;
      }
      if (r.waiting) st.waiting = st.waiting ?? "a file is arriving in the inbox: it is taken once nothing in it changed for 10 minutes";
      const saved = save(x.row, { facts: f }, { quiet: true });
      if (saved) { x.row = saved; x.f = f; }
      return null;
    }
    case "earlier": {
      // the game's earlier downloads still on the server (an import that failed, a search's that is still seeding): each is
      // offered to the way once under its content plan (one ledger key per download and content digest), before the
      // indexers are searched again; a download is only read, never moved, written or removed (the content job's earlier)
      const digest = contentDigest(x.plan, w);
      const copyTitle = copyRelease(g.id)?.title ?? null;
      const refused = crdeps.wayBlocked(g.id, w.id, c);
      // only the way's own refusals count here: a release the game's import could not unpack says nothing of it as data
      const own = new Set((rq.blockedForWay.all(g.id, w.id) as { title: string }[]).map(r => r.title));
      for (const d of await crdeps.earlierDownloads(g.id)) {
        if (!d.path) continue;
        if (!crdeps.exists(d.path)) {
          // on the seedbox's folder: not there now is the folder's trouble until its client says otherwise (src/remote.ts) —
          // waited for, never passed by for a new download; only one its client no longer has is passed by
          const text = await crdeps.seedboxMissing(d);
          if (text) {
            const repeat = stepsOf(x.row).at(-1)?.text === text;
            return wrote(save(x.row, { state: x.row.state === "asking" ? "asking" : "waiting", next_at: sec() + FILE_EVERY, ...(repeat ? {} : { steps: [note(x.row, text, { outcome: "waiting" })] }) }, { quiet: repeat }));
          }
          continue;
        }
        if (copyTitle && d.title === copyTitle) continue;                       // the copy's own release: judged as the copy
        if (own.has(d.title) && (refused.has(d.title) || (!!d.guid && refused.has(d.guid)))) { (tried.earlier ??= []).push({ title: d.title, why: "refused for this way before" }); continue; }
        const key = `earlier:${d.fetchId}:${digest}`;
        // ludarr itself could not take it in, twice: passed by (the ask says so), never an ask that holds up the indexers
        const l = x.f.ledger?.[key];
        if (l && (l.class === "other" || l.class === "restart") && l.n >= 2) { tried.failed!.push({ what: `Taking the game data from the earlier download ${d.title}`, why: l.why }); continue; }
        const b = blocked(key, `Taking the game data from the earlier download ${d.title}`, "content", "make");
        if (b === "skip") continue;
        if (b) return b;
        return startJob(x, { kind: "content", gameId: g.id, wayId: w.id, path: d.path, fetchId: d.fetchId, earlier: true, runId: x.row.id },
          `taking the game data from an earlier download (${d.title}${d.size ? `, ${sizeWords(d.size)}` : ""})`, { key, facts: { ...x.f, fileLandedAt: x.f.fileLandedAt ?? sec() } });
      }
      return null;
    }
    case "held": {
      const held = crdeps.heldFiles(g.id, c.platform).find(h => contentMatches(c, contentFacts(h)).ok);
      if (!held) return null;
      const id = contentIdentity(held);
      const facts = id ? [id.serial ?? id.discId ?? id.gameCode, id.region, id.version].filter(Boolean).join(", ") || null : null;
      const byAi = x.f.aiAsk?.phase === "held-file" ? x.f.aiAsk.spec : null;
      const asked = () => ask(x, "held-file", { content: c, held: { contentId: held.id, name: held.name, facts }, byAi }, FILE_EVERY, x.f.heldAsked === held.id ? {} : { facts: { ...x.f, heldAsked: held.id } });
      if (x.f.heldAsked !== held.id) return repair(x, "held-file", `${held.name} came from the indexers, and nothing proves it is ${clean(c.what)}`, { held: held.id, file: fileView(held, "nothing proves it is the game"), skip: asked });
      return asked();
    }
    case "indexer": {
      const owned = currentPackage(g.id);
      if (x.plan.kind === "emulator" && w.manual_choice === 0 && needsTitleReport(c.platform) && owned?.kind === "rom" && owned.platform === c.platform) {
        tried.indexers = { looked: 0, reason: null, nextAt: null, not: "the imported game is already on the server; this automatic emulator setup uses the existing copy" };
        return null;
      }
      // the game's own download already running: waited for, never a second beside it
      const ord = rq.ordinaryActive.get(g.id) as RequestRow | null;
      if (ord) {
        st.download = ord;
        const title = J<{ title?: string } | null>(ord.release_json, null)?.title ?? null;
        tried.download = { title };
        tried.indexers = { looked: 0, reason: null, nextAt: null, not: `a download of ${g.name} is already running` };
        st.waiting = st.waiting ?? `waiting for the download of ${g.name} that is already running`;
        return null;
      }
      // data only its owner can make is on no indexer in a form ludarr takes: no search of the way's own is started — it
      // would fetch copies the way refuses, one after another (Astral Chain's NSP and XCI, 2026-11-12)
      if (c.personalDump) {
        tried.indexers = { looked: 0, reason: null, nextAt: null, not: `only its owner can make this game data (${clean(c.personalDump).slice(0, 200)}), and they hold it in no form ludarr takes` };
        return null;
      }
      const mine = requestRow(x.f.requestId);
      const r = (rq.wayRequest.get(w.id) as RequestRow | null) ?? (mine && ACTIVE_REQUEST.includes(mine.state) ? mine : null);
      if (r) {
        st.request = r;
        if (r.id !== x.f.requestId) { const s = save(x.row, { facts: { ...x.f, requestId: r.id } }, { quiet: true }); if (s) { x.row = s; x.f = factsOf(s); } }
        // the content job of the way's own search failed on the recipe that makes the file: a repair, never an ask
        const job = jobRow(r.job_id);
        if (job && job.kind === "content" && job.state === "failed") {
          const info = failInfoOf(job);
          const key = `search:${job.id}`;
          if (info?.class === "plan" && !x.f.ledger?.[key]) {
            const f = withLedger(x.f, key, { kind: "content", class: "plan", why: clean(job.message), at: sec(), n: 1, jobId: job.id, phase: "make" });
            const s = save(x.row, { facts: f, steps: [note(x.row, `the game data a search brought could not be made: ${clean(job.message)}`, { outcome: "failed", jobId: job.id })] }, { quiet: true });
            if (!s) return AGAIN;
            return repair({ ...x, row: s, f }, "make", clean(job.message), { jobId: job.id });
          }
        }
        if (r.state === "requested" && r.next_try_at != null && r.next_try_at > sec() && !r.candidates_json) {
          // the search could not reach the indexers, or another search looks for this game's file: nothing is known of the
          // indexers yet (no widening on that, and the ask says so)
          const stage = r.stage ?? "";
          if (/search failed|another search/i.test(stage)) {
            const why = /another search/i.test(stage) ? `another search looks for ${g.name}'s game file` : `the indexer search failed${r.message ? ` (${clean(r.message)})` : ""}`;
            tried.indexers = { looked: 0, reason: null, nextAt: r.next_try_at, not: `${why}; looking again ${atClock(r.next_try_at)}` };
            st.waiting = st.waiting ?? `${why}: looking again ${atClock(r.next_try_at)}`;
            return null;
          }
          st.searchedNothing = true;
          tried.indexers = { ...lookedAt(g.id, w.id), nextAt: r.next_try_at };
          return null;
        }
        tried.indexers = { ...lookedAt(g.id, w.id), nextAt: r.next_try_at ?? null, searching: true };
        st.waiting = st.waiting ?? (r.state === "requested" ? "searching the indexers for its game file" : clean(r.stage) || "a search for its game file is under way");
        return null;
      }
      // the last search ended: its end read; a new one made (at most once a day once one has run)
      if (mine) {
        if (mine.state === "failed" && /plan is not ready/i.test(mine.stage ?? "")) return toPhase(x, "plan", `the search could not run: ${clean(mine.message)}`);
        if (mine.state === "cancelled") return wrote(save(x.row, { state: "held", ask: null, next_at: null, steps: [{ ...note(x.row, `the search for ${g.name}'s game data was stopped: press Resume to carry on`, { outcome: "waiting", requestId: mine.id }), who: "admin" }] }));
        // it stopped waiting for the seedbox (72 h of it, its download kept): the admin's Retry picks it up — never a new search
        // that would fetch another copy of what is on the seedbox already
        if (mine.state === "failed" && stoppedWait(mine)) {
          const not = "the last search stopped waiting for the seedbox (its download is kept): Retry it under Activity → Queue";
          tried.indexers = { ...lookedAt(g.id, w.id), nextAt: null, not };
          st.waiting = st.waiting ?? not;
          return null;
        }
        st.searchedNothing = true;
        if (sec() - (x.f.requestMadeAt ?? 0) < DAY) { tried.indexers = { ...lookedAt(g.id, w.id), nextAt: (x.f.requestMadeAt ?? sec()) + DAY }; return null; }
      }
      // nothing moved the run while it looked (an answer, a stop, a removed way): a search starts only from the run as it is,
      // so a stop never leaves one behind that no run follows
      if (getRun(x.row.id)?.version !== x.row.version) return AGAIN;
      try {
        // a search of the game's own that only waits becomes the way's (requests.ts): that one is not the run's to stop
        const before = (stmts.requestActiveForGame.get(g.id) as RequestRow | null)?.id ?? null;
        const req = crdeps.createRequest(g.id, w.id);
        const f: Facts = { ...x.f, requestId: req.id, requestMadeAt: sec(), requestOwn: req.id !== before ? req.id : null };
        const s = save(x.row, { facts: f, steps: [note(x.row, `searching the indexers for ${g.name} (${label(c.platform)})`, { outcome: "waiting", requestId: req.id })] });
        if (!s) return AGAIN;
        x.row = s; x.f = f;
        st.request = requestRow(req.id);
        st.searchedNothing = false;
        st.waiting = st.waiting ?? "searching the indexers for its game file";
        tried.indexers = { ...lookedAt(g.id, w.id), nextAt: st.request?.next_try_at ?? null, searching: true };
      } catch (e: any) {
        tried.indexers = { looked: 0, reason: null, nextAt: null, not: clean(e?.message ?? String(e)) };
      }
      return null;
    }
  }
}

/** a search that stopped waiting for the seedbox (src/requests.ts stopWaiting: remote_json stopped) */
const stoppedWait = (r: RequestRow): boolean => { try { return !!(JSON.parse(r.remote_json ?? "null") as { stopped?: boolean } | null)?.stopped; } catch { return false; } };

/** how many releases the way's searches looked at and refused, and the newest reason */
function lookedAt(gameId: number, wayId: number): { looked: number; reason: string | null } {
  // the copy's own release is kept off the searches by the run itself: no release the indexers were looked at for
  const rows = (rq.blockedForWay.all(gameId, wayId) as { title: string; reason: string | null }[]).filter(r => !String(r.reason ?? "").startsWith(COPY_BLOCK));
  return { looked: new Set(rows.map(r => r.title)).size, reason: rows[0] ? `${rows[0].title}: ${clean(rows[0].reason)}` : null };
}

/** ask for the game file, and keep watching: the inbox every 2 minutes, the way's search (kept alive, made again at most
 *  once a day) */
function fileAsk(x: Ctx, c: ContentPlan | null, o: { byAi?: AskSpec; st?: RouteState; facts?: Facts } = {}): Out {
  const g = x.game;
  const f = o.facts ?? x.f;
  const r = o.st?.request ?? requestRow(f.requestId);
  const live = r && ACTIVE_REQUEST.includes(r.state) ? r : null;
  const nextSearchAt = o.st?.download ? null : live ? live.next_try_at ?? sec() : f.requestMadeAt ? f.requestMadeAt + DAY : null;
  // the inbox only when the plan takes its data from one (content.make.from); made root:users 0770 in the background, and a
  // folder that cannot be used (a link, a stranger's, open to every user) is not offered: the ask says why instead
  const wants = g && (!c || sourcesOf(c).includes("inbox")) ? inboxOf(g) : null;
  if (g && wants) void Promise.resolve().then(() => crdeps.ensureInbox(g)).then(r => { inboxTrouble.set(g.id, r?.why ?? null); }).catch((e: any) => { inboxTrouble.set(g.id, clean(e?.message ?? String(e))); });
  const trouble = g && wants ? inboxTrouble.get(g.id) ?? null : null;
  const inbox = trouble ? null : wants;
  const tried: TriedFacts = { ...(o.st?.tried ?? {}), ...(trouble ? { inbox: trouble } : {}) };
  // the AI's line: a file it asked for, or what an improvement round asked the admin, while the content plan is as it was then
  const ai = f.aiAsk && (f.aiAsk.spec.need === "file" || IMPROVES.has(f.aiAsk.phase)) && x.way && f.aiAsk.digest === contentDigest(x.plan, x.way) ? f.aiAsk.spec : null;
  return ask(x, "file", { content: c, tried, inbox, byAi: o.byAi ?? ai, watching: { nextSearchAt, inbox: !!inbox, every: "2 minutes" } }, FILE_EVERY, o.facts ? { facts: o.facts } : {});
}
/** why a game's inbox cannot be used, as the last look found it (null: it can) */
const inboxTrouble = new Map<number, string | null>();
const inboxPaths = new Map<number, string | null>();
function inboxOf(g: GameRow): string | null {
  if (!inboxPaths.has(g.id)) { try { inboxPaths.set(g.id, crdeps.inboxDir(g)); } catch { inboxPaths.set(g.id, null); } }
  return inboxPaths.get(g.id) ?? null;
}

/* ─────────── BUILD ─────────── */

async function buildPhase(x: Ctx): Promise<Out> {
  const w = x.way;
  if (!w) return toPhase(x, "game", null);
  const g = x.game;
  if (!g) { stopRun(x.row.id, "the game was removed"); return STAY; }
  if (!planReady(x.plan)) return toPhase(x, "plan", `${x.plan.name} is ${x.plan.status} again`);
  const cur = currentPackage(g.id);
  if (w.status === "built" && w.package_id != null && cur?.pkg.id === w.package_id) return toPhase(x, "check", null);
  const c = wayContent(w, x.plan);
  if (c && !haveFile(x, c)) {
    const file = w.content_id != null ? getContent(w.content_id) : null;
    const why = !file ? "the way has no game file" : refusedNow(x).has(file.id) ? `the build refused ${file.name}` : !crdeps.exists(file.path) ? `${file.name} is gone from the disk` : `${file.name} does not fit the plan as it is now`;
    return toPhase(x, "file", `${why}: looking for its game file again`);
  }
  const needs = planNeeds(x.plan);
  if (!needs.met) return ask(x, "needs", { need: planSpec(x.plan).needs[needs.missing[0].index] ?? null, content: c }, NEEDS_EVERY);
  const other = playsAnother(x, w);
  if (other) return holdForReplace(x, w, other);
  // a job of the way already under way (the admin's Build, a search's build, a make's assemble): followed
  const busy = assembling(w.id) ?? making(w.id) ?? buildingFor(w);
  if (busy) return wrote(save(x.row, { step: { job: busy.id, kind: busy.kind ?? "job", what: busy.kind === "make" ? "making the game data" : busy.kind === "build" ? `building ${x.plan.name}'s program for ${g.name}` : `building ${g.name} through ${x.plan.name}`, phase: "build", at: sec(), adopted: busy.run_id !== x.row.id, ...(busy.kind === "assemble" ? { key: assembleKey(x.plan, w) } : {}) }, state: "waiting", ask: null, next_at: sec() + WAIT_EVERY }));
  // the way's newest assemble that ended since the run last looked counts as the run's own (a search's build, the admin's)
  // (an assemble from before the run is no news to it: live, job 59's ".iso, and this needs .zar" must not refuse a new .zar)
  const last = rq.latestAssemble.get(w.id) as JobRow | null;
  if (last && last.id > Math.max(x.f.seenAssemble ?? 0, x.f.sinceJob ?? 0) && ENDED.has(last.state)) {
    const f: Facts = { ...x.f, seenAssemble: last.id };
    if (last.state === "done") { const check = checkOf(last); return goOn(save(x.row, { facts: { ...f, ...(check ? { check } : {}) } }, { quiet: true })); }
    return jobEnded({ ...x, f }, { job: last.id, kind: "assemble", what: `building ${g.name}`, phase: "build", at: sec(), adopted: true, key: assembleKey(x.plan, w) }, last);
  }
  // the program built for this game first, when the plan builds it per game and no kept build fits
  if (crdeps.wayBuildNeeded(x.plan, w) && !(x.f.builtKeys ?? []).includes(buildKey(x.plan, w))) {
    const key = buildKey(x.plan, w);
    const said = ledgerSays(x.f, key), l = x.f.ledger?.[key];
    if (said === "asked") return askFromAi(x, x.f.aiAsk?.spec ?? { need: "other", title: `${x.plan.name} waits for you`, exact: l!.why });
    if (said === "plan") return repair(x, "build", l!.why, { jobId: l!.jobId });
    if (said === "wait") return backingOff(x, l);
    // the build refused this game file: another one is looked for, never an ask for a retry by the server that nothing
    // would make. The file is refused under the content plan as it is now: the build's key does not change with an edit it
    // does not read (the check), so the same file is not taken back to the same refusal
    if (said === "file") return toPhase(x, "file", `the program's build for ${g.name} refused the game file: looking for another`, {}, w.content_id != null ? withRefused(x, x.f, w.content_id, l!.why) : x.f);
    if (said === "other") return errorAsk(x, l, whatOf("build", x));
    return startJob(x, { kind: "build", planId: x.plan.id, wayId: w.id, ...(x.f.replace ? {} : { then: "assemble" as const }), runId: x.row.id }, `building ${x.plan.name}'s program for ${g.name}`, { key });
  }
  const key = assembleKey(x.plan, w);
  const said = ledgerSays(x.f, key), l = x.f.ledger?.[key];
  if (said === "asked") return askFromAi(x, x.f.aiAsk?.spec ?? { need: "other", title: `${x.plan.name} waits for you`, exact: l!.why });
  if (said === "plan") return repair(x, l!.phase ?? "build", l!.why, { jobId: l!.jobId });
  if (said === "wait") return backingOff(x, l);
  if (said === "other") return errorAsk(x, l, whatOf("assemble", x));
  if (said === "file") return toPhase(x, "file", "the build refused the game file: looking for another");
  const spec: JobSpec = x.f.replace ? { kind: "assemble", wayId: w.id, replace: true, runId: x.row.id } : { kind: "assemble", wayId: w.id, auto: true, runId: x.row.id };
  return startJob(x, spec, `building ${g.name} through ${x.plan.name}`, { key });
}

/* ─────────── CHECK ─────────── */

function checkPhase(x: Ctx): Out {
  const w = x.way, g = x.game;
  if (!w || !g) return toPhase(x, "game", null);
  const cur = currentPackage(g.id);
  if (!(w.status === "built" && w.package_id != null && cur?.pkg.id === w.package_id)) return toPhase(x, "build", null);
  const job = jobRow((stmts.packageById.get(w.package_id!) as PackageRow | null)?.job_id ?? null);
  const check = (job ? checkOf(job) : null) ?? x.f.check ?? null;
  const f: Facts = { ...x.f, check };
  const clause = !check ? "" : check.verdict === "env" ? `; ${clean(check.text) || "not started here: the server has no graphics device"}` : check.verdict === "pass" ? `; checked: ${clean(check.text) || "it passed"}` : "";
  // the job that built it on the step (the admin's page reads the check from it, whoever queued that build)
  return finish({ ...x, f }, `built: ${g.name} is ready for members to install${clause}`, null, f, job ? { jobId: job.id } : {});
}

/* ─────────── the backfill ─────────── */

/** the game a plan saved without a way plays, as its construct job (or the curated list) drafted it */
async function draftOf(p: PlanRow): Promise<GameDraft | null> {
  const m = J<{ game?: GameDraft | null } | null>(jobRow(p.job_id)?.manifest_json ?? null, null);
  if (m?.game?.name) return m.game;
  return crdeps.curatedGame(p.repo);
}

/**
 * A run for every way with no live package and every recomp or port plan with no way (main.ts: at boot and once a day). A
 * run that ended (done or stopped) is not started again here — only by a new way, a new plan or the admin. A plan whose
 * game is not in the library starts held, asking whether to go ahead. The games of the runs it starts have their copy
 * judged in the background. How many were started.
 */
export async function ensureRuns(): Promise<number> {
  let n = 0;
  const games = new Set<number>();
  for (const w of wstmts.waysAll.all() as WayRow[]) {
    const cur = currentPackage(w.game_id);
    if (w.status === "built" && w.package_id != null && cur?.pkg.id === w.package_id) continue;
    if (rq.anyFor.get(w.plan_id, w.game_id)) continue;
    try { startRun({ wayId: w.id, by: "backfill" }); n++; games.add(w.game_id); }
    catch (e: any) { log.warn(`backfill: way ${w.id}: ${e?.message ?? e}`); }
  }
  for (const p of wstmts.plansAll.all() as PlanRow[]) {
    if (p.kind === "emulator" || waysOfPlan(p.id).length || rq.anyForPlan.get(p.id)) continue;
    try {
      const draft = await draftOf(p);
      const game = crdeps.libraryMatch(p, draft);
      startRun({ planId: p.id, gameId: game?.id ?? null, draft, by: "backfill", held: !game });
      n++;
      if (game) games.add(game.id);
    } catch (e: any) { log.warn(`backfill: plan ${p.id}: ${e?.message ?? e}`); }
  }
  // judged one after another in the background (small reads each, but a whole library at boot would all hit the share at once)
  let judging = Promise.resolve();
  for (const id of games) if (currentPackage(id) && !crdeps.copyFacts(id)) judging = judging.then(() => crdeps.judgeCopy(id)).then(() => {}, () => {});
  if (n) crdeps.log(`backfill: ${n} run${n === 1 ? "" : "s"} started`);
  return n;
}

/** room was freed on the library (the admin freed a kept duplicate, of any game): every run that asked for room looks
 *  again now — room on the library is room for every game on it */
export function roomFreed(_gameId?: number): number {
  let n = 0;
  for (const r of db.query("SELECT * FROM carry_runs WHERE state='asking'").all() as RunRow[]) {
    if (askOf(r)?.code !== "room") continue;
    if (intend(r.id, { kind: "retry" })) n++;
  }
  return n;
}

/** the way and its file a build was queued for after the admin's press (in memory: a restart allows one more) */
const chainedBuilds = new Map<number, number | null>();
/**
 * The admin's Build on a way whose program is built for each game, while its file was still the game's copy: the assemble
 * took the copy in, then stopped for that build (NeedsBuild). The build is queued, the assemble after it (with the press's
 * replace), so one press builds. A way an open run follows (not held) is left to it: the run reads the same end and queues
 * the same build; a search's assemble is the search's.
 */
function buildAfterPress(spec: Record<string, unknown> | null | undefined): void {
  const way = Number(spec?.wayId) > 0 ? getWay(Number(spec!.wayId)) : null;
  const plan = way ? getPlan(way.plan_id) : null;
  if (!way || !plan) return;
  const run = runFor(way.id);
  if (run && run.state !== "held") return;
  if (buildingFor(way) || assembling(way.id) || !crdeps.wayBuildNeeded(plan, way)) return;
  // once for a way's file: should the build it queued not satisfy the assemble, it is not built again and again
  if (chainedBuilds.get(way.id) === way.content_id) { crdeps.log(`way ${way.id}: its program was built for this game file once already and the build still asks for it: not built again`); return; }
  chainedBuilds.set(way.id, way.content_id);
  const job = crdeps.enqueueJob({ kind: "build", planId: plan.id, wayId: way.id, then: "assemble", ...(spec?.replace === true ? { replace: true } : {}), ...(spec?.auto === true ? { auto: true } : {}) }, { gameId: way.game_id });
  crdeps.log(`way ${way.id}: its program is built for ${(gameRow(way.game_id)?.name ?? "the game")} first, then the way (job ${job.id})`);
}

/* ─────────── what wakes a run ─────────── */

events.subscribe(e => {
  try {
    if (e.event === "job") {
      const d = e.data as { id?: number; kind?: string; state?: string; runId?: number | null; requestId?: number | null; gameId?: number | null; spec?: Record<string, unknown> | null; manifest?: Record<string, unknown> | null; fail?: FailInfo | null } | null;
      if (!d || !d.state || !ENDED.has(d.state)) return;
      if (d.kind === "assemble" && d.state === "failed" && d.runId == null && d.requestId == null && d.fail?.class === "other" && d.fail.kind === "needs-build") buildAfterPress(d.spec);
      if (d.runId != null) pokeRuns({ runId: d.runId });
      if (d.id != null) pokeRuns({ jobId: d.id });
      const wayId = Number(d.spec?.wayId);
      if (Number.isInteger(wayId) && wayId > 0) pokeRuns({ wayId });
      if (d.gameId != null) pokeRuns({ gameId: d.gameId });
      if (d.kind === "content" && Number(d.spec?.planId) > 0) pokeRuns({ planId: Number(d.spec!.planId) });
      // a new plan a construct job saved (not a repair round) is carried through even when its start was missed
      if (d.kind === "construct" && d.state === "done" && !d.spec?.runId && !d.spec?.repair) {
        const m = d.manifest as Partial<ConstructManifest> | null;
        if (m && Number(m.planId) > 0 && !m.runId && getPlan(Number(m.planId))) {
          const gameId = Number(d.spec?.gameId) > 0 ? Number(d.spec!.gameId) : null;
          const way = Number(m.wayId) > 0 ? getWay(Number(m.wayId)) : null;
          startRun({ planId: Number(m.planId), gameId: way ? null : gameId, wayId: way?.id ?? null, draft: (m.game as GameDraft | null) ?? null, by: "construct", jobId: d.id ?? null });
        }
      }
    } else if (e.event === "request") {
      const d = e.data as { gameId?: number; state?: string } | null;
      if (d?.gameId != null && d.state && ["ready", "failed", "cancelled", "requested"].includes(d.state)) pokeRuns({ gameId: d.gameId });
    } else if (e.event === "package") {
      const d = e.data as { gameId?: number | null } | null;
      if (d?.gameId != null) pokeRuns({ gameId: d.gameId });
    }
  } catch (err: any) { log.warn(`a run was not woken: ${err?.message ?? err}`); }
});
