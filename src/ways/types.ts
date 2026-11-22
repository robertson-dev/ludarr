/**
 * ludarr — ways to play a game through a program that is not the game itself: a recomp, a port or an emulator.
 *
 *   RuntimePlan   how to get, set up and start one program (table runtime_plans; reusable across games)
 *   Way           one library game played through one plan, with the game file it needs (table ways)
 *   ContentFile   a game file kept on the server (ROM, disc image) with its hashes (table contents)
 *   CarryRun      a repo carried all the way to a game members install, with no click (table carry_runs, src/ways/carry.ts)
 *
 * A plan is data the deterministic tier runs (src/ways/assemble.ts) to build an ordinary package: the program, the
 * verified game file in its place, the plan's files and setup, and a manifest whose launch carries an argv. The AI
 * (the construct job) only writes or repairs plans; what it works out stays reusable without it.
 *
 * This file is the contract between the engine, the admin UI and the AI: change a shape only together with
 * src/ways/validate.ts and its tests.
 */
import type { PlatformId } from "../platforms";
import type { Identity } from "./identity";

export type HashAlgo = "sha1" | "md5" | "sha256" | "crc32" | "crc32c" | "xxh64" | "xxh3-64" | "xxh3-128";
export const HASH_ALGOS: HashAlgo[] = ["sha1", "md5", "sha256", "crc32", "crc32c", "xxh64", "xxh3-64", "xxh3-128"];
/** hex digits per algorithm */
export const HASH_HEX_LEN: Record<HashAlgo, number> = { sha1: 40, md5: 32, sha256: 64, crc32: 8, crc32c: 8, xxh64: 16, "xxh3-64": 16, "xxh3-128": 32 };
/** lowercase hex per algorithm */
export type Hashes = Partial<Record<HashAlgo, string>>;
export interface AcceptHash { algo: HashAlgo; value: string; label?: string }

export type PlanKind = "recomp" | "port" | "emulator";
export const PLAN_KINDS: PlanKind[] = ["recomp", "port", "emulator"];
export type PlanStatus = "draft" | "ready" | "broken";
export type WayStatus = "needs-files" | "ready" | "building" | "built" | "failed";
/** jobs.kind: 'import' is a downloaded release; 'build' runs a source plan's recorded steps without the AI (with a wayId,
 *  it builds the program for that one game); 'make' makes a way's game file from another form of the game's data by the
 *  content plan's recorded steps (src/ways/make.ts) */
export type JobKind = "import" | "construct" | "assemble" | "content" | "build" | "make";
/** the package kind a plan kind builds (Manifest.kind) */
export const PACKAGE_KIND: Record<PlanKind, "recomp" | "port" | "emulated"> = { recomp: "recomp", port: "port", emulator: "emulated" };
/** where a way's game file (or what it is made from) may come from, in this order unless make.from says otherwise: a file
 *  kept on the server, the game's copy on the server, the game's inbox folder, the indexers */
export type FileSource = "kept" | "copy" | "inbox" | "indexer";

/** how the program starts on the player's PC: install-folder-relative; argv items, cwd and env values may hold {install}
 *  (the absolute install folder, filled in by the launcher) and argv items {content} (the placed game file, or the placed
 *  game folder for a content plan of kind 'folder', filled in at assembly as "{install}/<place>") */
export interface LaunchPlan { exe: string; argv: string[]; cwd?: string; env?: Record<string, string> }

/** where the Windows program comes from */
export type ProgramSource =
  /** a GitHub / forgejo release asset: assetPattern is a case-insensitive regex source picking the Windows x64 file;
   *  perGame: the asset is a kit that builds the game from its file on the server, once per way (src/ways/build.ts) */
  | { kind: "release"; assetPattern: string; channel: "stable" | "nightly"; perGame?: KitBuild }
  /** a project's own update feed (src/catalog/github.ts: dolphin-emu.org) */
  | { kind: "feed"; feed: "dolphin:beta" | "dolphin:dev" }
  /** one fixed https file, checked against its sha256; perGame as for a release */
  | { kind: "url"; url: string; sha256: string; perGame?: KitBuild }
  /** built from the repo: `steps` run as the build user in a fresh checkout of `ref` (with submodules); `artifact` is the
   *  checkout-relative folder holding the built Windows program; `apt` names Debian -dev packages the build needs;
   *  content 'build' means the game file is needed at build time ({content} may appear in steps) and the build then
   *  runs once per way instead of once per plan */
  | { kind: "source"; ref: string; steps: string[]; artifact: string; apt?: string[]; content: "none" | "build" };

/** a native helper built from the repo at the program's tag (an asset extractor run by setup) */
export interface ToolBuild { ref: string; steps: string[]; outputs: string[]; apt?: string[] }

/** where the program's own code names a value a content plan accepts: each of `values` must appear (without regard to
 *  case) within lines [first, last] of `path` in `repo` at `commit` — the construct job reads the file to check it */
export interface Evidence { repo: string; commit: string; path: string; lines: [number, number]; values: string[] }
/** the whole game, not an update or a part of it: checked on a game folder (or on what a game file is made from) before
 *  anything else. list.path names a file in the pinned program that lists the game's files one per line (Kyty:
 *  files-PPSA01341_01.007.000.files); share is the part of those paths that must exist (default 0.98) */
export interface Completeness { minBytes?: number; minFiles?: number; list?: { path: string; share?: number } }

/** the game data a way needs: one file (a cartridge dump, a single-file disc image, an archive the program reads as it
 *  is), or one folder (kind 'folder': an app0 dump, exefs + romfs, a PS3 JB folder). `make` says how it is made from another
 *  form of the game's data using its declared extraction/conversion tools */
export interface ContentPlan {
  kind: "rom" | "disc" | "folder";
  /** the original game's platform */
  platform: PlatformId;
  /** what the file must be, for the admin ("Majora's Mask, NTSC-U 1.0") */
  what: string;
  /** names to search the indexers by: the ORIGINAL game's names (never the port's) */
  search: string[];
  /** up to 5 extra queries asked as they are in this way's content pass (a serial: "PPSA01341") */
  terms?: string[];
  /** hashes are of the whole file after normalisation (a folder: of its canonical listing); empty = any file of the
   *  platform (emulator plans only). An empty or absent list accepts anything, so a list that is emptied widens */
  accept: {
    hashes: AcceptHash[]; formats?: string[]; regions?: string[]; serials?: string[];
    /** the game's own version as its data says it, compared by number ("01.007.000" = "1.07" = "1.7") */
    versions?: string[];
    /** what the data must be (default 'game'): a patch or an add-on is never the game */
    category?: "game" | "patch" | "addon";
    /** program build ids (hex, 8 digits or more, matched as a prefix): a Switch title's main NSO build id */
    builds?: string[];
    /** where the program's code names each accepted serial, version, hash and build */
    evidence?: Evidence[];
  };
  /** kind 'folder': the file that says the folder is the game (sce_sys/param.json), and files that sit beside it */
  marker?: string;
  also?: string[];
  /** kind 'folder': what makes the folder the whole game, not an update or a part */
  complete?: Completeness;
  /** the data comes only from the player's own console, through a tool only its owner can run: who makes it ("Eglantine
   *  on your Switch 2"); the run asks for it at once and keeps the search going */
  personalDump?: string | null;
  /** the game file is made from another form of the game's data by these steps (src/ways/make.ts) */
  make?: ContentMake | null;
  /** byte order fixed before hashing and placing (z64, big-endian) */
  normalize?: "n64-z64" | null;
  /** install-folder-relative destination; may contain {name} (the stored file's name, made safe); kind 'folder': the
   *  folder the game folder becomes, without {name} */
  place: string;
  /** false: the file is used on the server and not shipped in the package (a setup step with {content}, a source build
   *  that reads it, a per-game build); default true */
  ship?: boolean;
}

/** a converter ludarr knows by name, built from its own pinned commit (src/ways/converters.ts) */
export type ConverterId = "zarchive";
/** a converter from another public repo at a pinned commit, built in the sandbox like a plan's source build; the first
 *  output is the program a convert step runs; steps may hold {jobs} */
export interface PinnedTool { repo: string; commit: string; steps: string[]; outputs: string[]; apt?: string[] }
/** what a game file is made from, judged before any step runs */
export interface MakeInput {
  shape: "file" | "folder" | "either";
  platform: PlatformId;
  /** a file input's extensions: "zip", "7z", "rar", "nup" … */
  formats?: string[];
  /** what must be inside (in the folder, or in the unpacked file) */
  marker?: string; also?: string[];
  serials?: string[]; versions?: string[]; regions?: string[]; category?: "game" | "patch" | "addon";
  /** the whole game, not an update or a part */
  complete?: Completeness;
}
/** one recorded step of a make, run in the build sandbox. Placeholders: {in} the input (read-only), {prep} a scratch
 *  folder, {out} the product, {serial} and {version} from the input's identity, {program} the pinned program (read-only) */
export type MakeStep =
  /** the input file unpacked into {prep}/<to> by the system's archiver, as the build user; only: members to take */
  | { unpack: { to: string; only?: string[] } }
  /** exactly one folder under `within` ({in} or {prep}, or a folder below either) holds marker (and also); it is judged
   *  again and named `as` (a name inside {prep}) for the later steps */
  | { pick: { within: string; marker: string; also?: string[]; as: string } }
  /** a converter run with argv ({prep} {out} {in} {serial} {version}) */
  | { convert: { with: ConverterId | PinnedTool; argv: string[]; timeoutSec: number } }
  /** the program's own tool (exe inside the program, or tool: one of the plan's tools.outputs); argv may also hold {program} */
  | { run: { exe?: string; tool?: string; argv: string[]; wine: boolean; timeoutSec: number } }
  /** inside {prep} */
  | { remove: string } | { move: { from: string; to: string } };
export interface ContentMake {
  from?: FileSource[];
  input: MakeInput;
  /** 1 to 20 */
  steps: MakeStep[];
  /** the product in {out}, which must then pass the content plan; name may hold {serial} and {version} */
  output: { shape: "file" | "folder"; name: string };
}
/** what a made game file was made from and how (contents.made_json): a product is reused, never made twice, while its key
 *  (input digest, recipe, tools, program) is the same */
export interface MadeInfo {
  from: { kind: FileSource; packageId?: number | null; contentId?: number | null; fetchId?: number | null; digest: string };
  /** the make recipe as canonical JSON */
  recipe: string;
  /** the converters' pinned commits */
  tools: string[];
  /** the pinned program's sha256 when a run step reads {program} */
  program?: string | null;
  key: string;
  at: number;
}

/** a build of the game from its file on the server, from the program's release asset (a recomp kit), once per way */
export interface KitBuild {
  /** files the steps need besides the kit, each pinned by its sha256 (at most 64) */
  fetch?: { url: string; sha256: string; size?: number; to: string; unpack?: "zip" | "tar" | "tar.zst" | "none" }[];
  /** 1 to 30 bash commands run as the build user; {program} {content} {needs} {out} {tools} {cpu} {jobs} {work} */
  steps: string[];
  /** the steps run Windows tools under wine (a prefix in the job's scratch folder) */
  wine?: boolean;
  /** the CPU level the code is built for (never the server's own) */
  cpu?: "x86-64-v2" | "x86-64-v3";
  /** per step, 1 to 21600 */
  timeoutSec: number;
  /** inside {out}: the install folder ("." = all of {out}) */
  artifact: string;
}

/** what a check step needs of the server: a CPU level or feature, wine, a GPU API; a step the server cannot run is not run
 *  (verdict 'env') */
export type CheckNeed = "avx2" | "x86-64-v2" | "x86-64-v3" | "wine" | "gl" | "vulkan";
/** GPU-free checks run on the server once the package is put together, on a throwaway copy of the install folder */
export interface PlanCheck {
  /** at most 6; argv may hold {stage} {content} {work}; expect: text one line of the output must contain (at most 200
   *  characters, matched as it is, never as a pattern); what: what the step shows, for the admin */
  steps: { run: { exe?: string; tool?: string; argv: string[]; wine: boolean; timeoutSec: number }; expect?: string; what: string; needs?: CheckNeed[] }[];
  /** the program started for a few seconds under wine on a virtual display; needs: what it draws with */
  smoke?: { seconds: number; title?: string; needs: "nothing" | "gl" | "vulkan" | "d3d12" } | null;
}
/** something a repair round (or the admin) decided about a plan, kept so a later run never asks it again; wayId: decided
 *  for that way only (a round about one game of an emulator plan), absent: for the plan */
export interface PlanDecision { at: number; what: "server-build" | "upgrade" | "widen" | "game"; outcome: string; by: "ai" | "admin"; wayId?: number }

/** run on the server after the program and files are in place; headless only, in the build sandbox */
export type SetupStep =
  /** exactly one of exe (install-folder-relative, or a bare Linux tool name when wine is false) and tool (one of
   *  tools.outputs); argv may hold {stage} (the folder being packaged), {work} (scratch) and {content} (the game file) */
  | { run: { exe?: string; tool?: string; argv: string[]; wine: boolean; timeoutSec: number } }
  | { ini: { path: string; section: string; key: string; value: string } }
  | { remove: string }
  | { move: { from: string; to: string } };

/** a file a program needs besides the game (a BIOS, firmware, keys): the admin supplies it once per plan; a way whose plan
 *  has an unmet need is never built */
export interface NeedSlot {
  kind: "bios" | "firmware" | "keys" | "other";
  /** true: consumed by program.perGame under {needs}/<place>, never placed in the player package */
  build?: boolean;
  name: string;
  place: string;
  accept?: { hashes?: AcceptHash[]; sizes?: number[]; formats?: string[] };
  note?: string;
}

/** a file written into the install folder; after 'setup' means once setup has run */
export interface PlanFile { path: string; text: string; after?: "setup" }

export interface RuntimePlanSpec {
  program: ProgramSource;
  /** folder inside the program that becomes the install folder; "" or absent = unwrap one lone top-level folder */
  root?: string;
  launch: LaunchPlan;
  /** recomp/port: the exact game data it accepts; emulator: a template (platform, place, formats) with no hashes */
  content: ContentPlan | null;
  files: PlanFile[];
  setup: SetupStep[];
  tools?: ToolBuild | null;
  needs: NeedSlot[];
  /** globs of saves and settings the launcher keeps across updates and uninstalls (portable programs keep them here) */
  keep: string[];
  /** globs of files shipped once and never reset by the launcher's verify (settings the program rewrites) */
  seed: string[];
  /** what a player sees on the first start (admin-facing); null = straight into the game */
  firstRun: string | null;
  /** admin-facing: how it works, where facts came from, anything odd */
  notes: string;
  /** checks run on the server before the package is offered */
  check?: PlanCheck | null;
  /** what repair rounds and the admin decided (at most 20) */
  decisions?: PlanDecision[];
}

/**
 * How a game starts, set by hand by the admin (the game page's "Starts with", src/library/launch.ts): the whole start, in
 * place of the one ludarr found or the plan's (and a way's argvExtra and env). exe is the copy's own file as its file
 * list spells it; argv items may hold {install}, and {content} on a way whose game file ships; cwd absent is the program's
 * folder, "{install}" the game's folder, anything else a folder of the copy; paths are the files and folders of the copy its
 * arguments and variables named as {install}/<path> when it was set (a new copy lacking one does not take it: its game file
 * moved, say); at is when it was set (ms), stamped into the manifest's launch as `rev` wherever it is applied.
 */
export interface LaunchChoice { exe: string; argv: string[]; cwd?: string; env?: Record<string, string>; paths?: string[]; at: number }

/** per-game additions over a plan (an emulator's per-game settings); check runs in place of the plan's, setup steps run
 *  after the plan's. launch is the admin's own start for this game: only the game page's route writes it (an AI round and
 *  the way's PUT keep it as it is) */
export interface WayOverrides { files?: PlanFile[]; argvExtra?: string[]; env?: Record<string, string>; check?: PlanCheck | null; setup?: SetupStep[]; launch?: LaunchChoice }

/** exactly the program players get; a changed file under the same tag fails loudly */
export interface PinnedProgram {
  tag: string;
  asset: string;
  url: string;
  size: number;
  sha256: string;
  /** the host's own digest for the asset when it gives one (GitHub: sha256) */
  digest?: string | null;
  /** GitHub's immutable-release flag when known */
  immutable?: boolean | null;
  pinnedAt: number;
}

/** what a game is, as the admin (or the AI) describes it for a manual add */
export interface GameDraft {
  name: string;
  aliases: string[];
  platforms: PlatformId[];
  year: number | null;
  releaseIso: string | null;
  summary: string | null;
  genres: string[];
  developer: string | null;
  publisher: string | null;
  searchTerms: string[];
}

/* ─────────── carry runs: a repo carried all the way to a game members install (src/ways/carry.ts) ─────────── */

export type RunPhase = "plan" | "game" | "file" | "build" | "check" | "done";
export type RunState = "active" | "waiting" | "asking" | "held" | "done" | "stopped";
/** what a repair round is asked to do: make the plan pass, move a build from players' PCs to the server, turn what the plan
 *  says in words into data, accept more versions or regions the program's code names, prove a held file, or fix a make,
 *  build or check recipe */
/** told: the admin said, in their own words, what the plan has wrong and what to do instead (POST /api/v1/run/:id/tell) */
export type RepairPhase = "plan" | "server-build" | "upgrade" | "widen" | "held-file" | "make" | "build" | "check" | "told";
/** a game file as a repair round and the admin see it */
export interface FileView { contentId: number | null; name: string; size: number; shape: "file" | "folder"; source: string; platform: string | null; identity: Identity | null; sha1: string | null; why: string | null }
/** the game's copy on the server, judged in place: 'direct' it is the way's file, 'make' the file is made from it */
export interface CopyView { packageId: number; name: string; size: number; shape: "file" | "folder"; identity: Identity | null; serves: "direct" | "make" | "no" | "unknown"; why: string }
export interface CheckStepReport { what: string; code: number | null; ok: boolean; tail: string; seconds: number }
/** screenshot: a PNG's file name in <config>/ways/checks/ (check.ts writes it; GET /api/v1/check-shot/:name serves it to the
 *  admin), or null */
export interface SmokeReport { verdict: "pass" | "fail" | "env"; alive: boolean; exitCode: number | null; titles: string[]; screenshot: string | null; outputTail: string; why: string }
/** 'env': the server cannot tell (no graphics device, a CPU it lacks), which proves nothing either way */
export interface CheckReport { verdict: "pass" | "fail" | "env" | "none"; steps: CheckStepReport[]; smoke: SmokeReport | null; text: string }
/** what a repair round is given about the failure it is asked to fix */
export interface RepairBrief {
  phase: RepairPhase; round: number; rounds: number; tokensLeft: number;
  failure: string; jobId: number | null; logTail: string[];
  file: FileView | null; copy: CopyView | null;
  searched: { names: string[]; looked: number; candidates: { title: string; size: number | null; why: string }[] } | null;
  check: CheckReport | null;
  earlier: { phase: RepairPhase; summary: string; outcome: string }[];
  /** phase told: the admin's words, the instruction for the round (the admin runs this server: they are not program output) */
  told?: string | null;
}
/** what the AI may ask the admin for (finish ok=false); the words shown are generated from it (src/ways/asks.ts) */
export interface AskSpec { need: "file" | "system-file" | "choice" | "other"; title: string; exact: string; accept?: { platform?: PlatformId; shape?: "file" | "folder" | "either"; formats?: string[]; serials?: string[]; versions?: string[]; regions?: string[] } }
export type AskCode = "file" | "held-file" | "game" | "needs" | "ai" | "budget" | "room" | "env" | "choice" | "go-ahead";
/** what a run asks the admin, while it keeps watching for the answer by itself */
export interface RunAsk {
  code: AskCode; title: string; need: string; tried: string[]; accept: AskSpec["accept"] | null;
  /** the inbox folder as the server sees it, and as the admin's PC opens it (Settings: Library as your PC sees it) */
  inbox: string | null; inboxShare: string | null;
  /** whether an upload can bring what is asked for (a single file within the upload limit) */
  canUpload: boolean;
  choices: { gameId: number; name: string; year: number | null; platforms: string[] }[]; heldContentId: number | null;
  watching: { nextSearchAt: number | null; inbox: boolean; every: string } | null; askedAt: number; byAi: string | null;
}
export interface RunStep { at: number; phase: RunPhase; who: "ludarr" | "ai" | "admin"; text: string; outcome: "ok" | "refused" | "failed" | "waiting" | "env" | "asked" | null; jobId?: number; requestId?: number; contentId?: number; proof?: string }
export interface RunView {
  id: number; planId: number; planName: string; gameId: number | null; gameName: string | null; wayId: number | null;
  phase: RunPhase; state: RunState;
  rail: { phase: Exclude<RunPhase, "done">; state: "done" | "active" | "waiting" | "asked" | "failed" | "env" | "todo"; summary: string | null }[];
  now: { text: string; progress: number | null; jobId: number | null; requestId: number | null } | null;
  ask: RunAsk | null; steps?: RunStep[];
  budget: { rounds: number; roundsUsed: number; tokens: number; tokensUsed: number };
  nextAt: number | null; startedBy: "construct" | "admin" | "way" | "backfill"; createdAt: number; updatedAt: number; doneAt: number | null;
}
/** what a dry run of a make found (the construct job's try_make) */
export interface MakeReport { ok: boolean; problems: string[]; warnings: string[]; input: { shape: string; identity: Identity | null; sealed: boolean } | null; picked: { path: string; identity: Identity | null } | null; product: { name: string; size: number; identity: Identity | null; contentId: number | null } | null; estimate: { bytes: number; minutes: number }; lines: string[] }
/** what a file or folder is, from small reads and listings (src/ways/inspect.ts) */
export interface InputDescription { shape: "file" | "folder"; format: string; size: number; identity: Identity | null; sealed: boolean; markers: string[]; members: { path: string; size: number; dir: boolean }[] | null; listing: "fs" | "udf" | "7z" | "none"; why: string | null }
/** what a content pass would take, without grabbing anything */
export interface PassPreview { names: string[]; platform: string; candidates: { title: string; size: number | null; indexer: string | null; take: boolean; why: string }[] }
/** why a job ended badly, written by the runner from typed errors (src/ways/errors.ts failOf): a run classifies a job's
 *  end by this, never by its words */
export interface FailInfo {
  class: "env" | "plan" | "file" | "cancelled" | "restart" | "other";
  /** an env failure's kind (src/ways/errors.ts EnvKind) */
  kind?: string;
  phase?: "make" | "build" | "check" | "setup" | "fetch" | "place" | "intake" | "convert" | "unpack";
  /** who cancelled it */
  by?: "admin" | "run" | "system";
  /** a job that read the seedbox's mapped folder: what its end says about that folder (src/remote.ts verdictOf) — troubled
   *  (then class 'env', kind 'remote'), its input missing, or a child program's words that call for one confirming re-run */
  remote?: {
    root: string; troubled: boolean; trouble?: string | null; words?: string; absent?: boolean; io?: boolean;
    /** its own end is a verdict on the copy (a checksum, a password); the folder only answered slowly meanwhile */
    copy?: boolean; slow?: boolean;
    /** what the input weighed at its start, and what was left at its end when that was less; its own end in its words */
    start?: { files: number; bytes: number } | null; left?: { files: number; bytes: number } | null; ended?: string;
    /** the job was a confirming re-run: its end is taken as it is */
    confirmed?: boolean;
  };
}

/** what a construct job leaves in its manifest (jobs.manifest_json): the plan it saved or reworked, the way, the game it
 *  plays when there is no way yet, the carry run it belongs to (a new plan's run, or the run whose repair round it was),
 *  and from a repair round what changed (the top-level fields, and each one's before and after: at most 4 KB of JSON in
 *  all), what it asks the admin for when it could not do it (the run asks that), and the tokens it spent */
export interface ConstructManifest {
  planId: number;
  wayId?: number | null;
  game?: GameDraft | null;
  runId?: number | null;
  changed?: string[];
  diff?: { field: string; before: unknown; after: unknown }[];
  ask?: AskSpec | null;
  tokens?: number;
}

/** the assemble job's check, kept as one step of its trace (jobs.trace_json; src/ways/assemble.ts writes it after runChecks):
 *  a carry run reads the last such step into facts.check and its rail, and the admin's job view shows it */
export interface CheckTraceStep { kind: "check"; report: CheckReport; t?: number }
/** what the admin answers a run's ask with (POST /api/v1/run/:id/answer): the library game the plan plays, a new game from
 *  the plan's own draft, or go ahead / not now for a held run (go:false stops the run and deletes nothing) */
export type RunAnswer = { gameId: number } | { newGame: true } | { go: boolean };
/** what a content job that took an inbox entry leaves as its manifest: the row it became (null: nobody took it, and the
 *  entry stays where it is with <entry>.not-taken.txt beside it saying why), the ways it is now the file of, the ways whose
 *  make takes it as input, and why each other way did not take it */
export interface IntakeManifest { inbox: true; entry: string; contentId: number | null; attached: number[]; inputFor: number[]; notes: string[] }
/** a kept file's stat when its hashes were taken (contents.stat_json): a later read trusts those hashes only while the size,
 *  both times, the device and the inode are all the same (a hard link or a rewrite in place changes one of them) */
export interface HashedStat { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }

/** jobs.spec_json by kind; runId: the carry run that started the job (jobs.run_id) */
export type JobSpec =
  /** auto: queued by ludarr itself (a search's file, an imported dump), never by the admin: it replaces no other way's package */
  | { kind: "assemble"; wayId: number; replace?: boolean; repin?: boolean; auto?: boolean; runId?: number | null }
  /** fetchId: the download a request's search brought for way wayId (src/ways/find.ts takes its game file); fromCopy: the
   *  game's copy on the server taken for way wayId by a link; inbox: path is an entry of the game's inbox folder
   *  (src/ways/inbox.ts), judged for each of the game's ways and moved into the store (content.ts intakeEntry, source
   *  'inbox') — the inbox's entries are taken in by content jobs, side by side up to INTAKE_PARALLEL */
  | { kind: "content"; gameId: number | null; path?: string; wayId?: number | null; requestId?: number | null; planId?: number | null; needIndex?: number | null; fetchId?: number | null; fromCopy?: boolean; inbox?: boolean; runId?: number | null;
      /** with fetchId: a download that landed earlier (a carry run offers it to the way): only read — the fetch is not marked
       *  imported and the download is never removed, whatever the way makes of it */
      earlier?: boolean;
      /** An admin explicitly selected this release. Judge its contents even when its name or size was filtered. */
      manualSelection?: boolean;
      /** the confirming run of one that ended on what may be a failed read of the seedbox's folder: its end is taken as it is */
      confirm?: boolean;
      /** path is what the admin uploaded for the game (src/uploads.ts: one file, an archive set's first volume, or its
       *  folder): kept as an upload, and the upload's own folder goes once the job is done */
      upload?: number | null }
  /** repair: a repair round of a carry run (src/ways/construct.ts); platform: the console whose games the plan is for,
   *  when the emulator plays several (the version that was asked for); listOnly: queued by ludarr itself for its own
   *  recipe (src/ways/recipes.ts): made from its own list or not at all, never by the AI */
  | { kind: "construct"; repo: string; gameId?: number | null; planId?: number | null; note?: string | null; contentId?: number | null; runId?: number | null; repair?: RepairBrief | null; platform?: PlatformId | null; listOnly?: boolean; titleResearch?: boolean; assetUrl?: string }
  /** with a wayId: the program built for that game (a source plan whose build reads the game file, or a release kit);
   *  then: the way's assemble is queued once it is built, with auto and replace as given here (auto defaults to whether
   *  a carry run asked for the build) */
  | { kind: "build"; planId: number; wayId?: number | null; then?: "assemble"; runId?: number | null; auto?: boolean; replace?: boolean }
  /** way wayId's game file made from another form of the game's data: from a kept file (contentId), the game's copy
   *  (packageId), or a path (an inbox entry, a download: fetchId, requestId); then: the way's assemble (or its per-way
   *  build first) is queued once it is made, with auto and replace as given here */
  | { kind: "make"; wayId: number; from: FileSource; contentId?: number | null; packageId?: number | null; path?: string | null; fetchId?: number | null; requestId?: number | null; then?: "assemble"; auto?: boolean; replace?: boolean; runId?: number | null; confirm?: boolean };

/** the minimum Ahoy launcher that understands argv, env, {install}, keep and seed */
export const LAUNCHER_FOR_WAYS = "0.10.0";
/** the oldest Ahoy that starts a game through a Windows command script (.bat, .cmd): it hands the script to the command
 *  shell without the shell ever reading the script's path as commands, and takes only arguments the shell reads as plain words */
export const LAUNCHER_FOR_SCRIPTS = "0.11.0";
