/** ludarr web — the API client: types and a typed fetch that sends the key the server injected into index.html. */

declare global {
  interface Window { ludarr?: { apiKey: string; version: string; urlBase: string } }
}

// outside a browser (the engine's tests render the pages) there is no window and no key
export const runtime = (typeof window === "undefined" ? undefined : window.ludarr) ?? { apiKey: "", version: "dev", urlBase: "" };
/** where the app is mounted ("" at the root); the server may leave it out */
export const urlBase = String(runtime.urlBase ?? "").replace(/[/]+$/, "");
export const apiKey = () => runtime.apiKey;

export class ApiError extends Error {
  constructor(msg: string, public status: number, public data: any = null) { super(msg); }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { "X-Api-Key": apiKey(), ...(rest.headers as Record<string, string> ?? {}) };
  if (json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${urlBase}${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new ApiError(res.ok ? "ludarr answered with something that is not JSON (is it restarting?)" : `HTTP ${res.status}`, res.status || 502); }
  if (!res.ok) throw new ApiError(data?.error ?? data?.detail ?? (Array.isArray(data?.errors) && data.errors.length ? data.errors.join("; ") : `HTTP ${res.status}`), res.status, data);
  return data as T;
}
export const get = <T,>(path: string) => api<T>(path);
/** a file the API serves (a screenshot) as a Blob, the key in the header: an <img> address would have to carry the key */
export async function getBlob(path: string): Promise<Blob> {
  const res = await fetch(`${urlBase}${path}`, { headers: { "X-Api-Key": apiKey() } });
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data);
  }
  return res.blob();
}
export const post = <T,>(path: string, json?: unknown) => api<T>(path, { method: "POST", json });
export const put = <T,>(path: string, json?: unknown) => api<T>(path, { method: "PUT", json });
export const patch = <T,>(path: string, json?: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });

/** the list of problems a 400 carries ({ errors: [...] }), else the one message */
export function errorList(e: unknown): string[] {
  const list = e instanceof ApiError && Array.isArray(e.data?.errors) ? (e.data.errors as unknown[]).map(String) : [];
  return list.length ? list : [String((e as Error)?.message ?? e)];
}

/** an endpoint this server does not have (a newer engine adds it): the server's catch-all answers 404 "no such endpoint" */
export const missingRoute = (e: unknown) => e instanceof ApiError && e.status === 404 && e.message === "no such endpoint";
export const NOT_YET = "Not available on this server yet.";

const routeProbes = new Map<string, Promise<boolean>>();
/**
 * Does the server have this route? Asked once per page load with an id that names nothing (0), so the request changes
 * nothing: a route that is there answers "no such …", one that is not answers "no such endpoint". Only for controls of
 * routes a later engine adds.
 */
export function hasRoute(method: string, path: string): Promise<boolean> {
  const key = `${method} ${path}`;
  let p = routeProbes.get(key);
  if (!p) {
    p = api(path, { method, json: method === "GET" ? undefined : {} }).then(() => true, e => !missingRoute(e));
    routeProbes.set(key, p);
  }
  return p;
}
/** remember that a route turned out to be missing (it answered "no such endpoint" when used) */
export const routeMissing = (method: string, path: string) => { routeProbes.set(`${method} ${path}`, Promise.resolve(false)); };

/**
 * Send a file as the raw request body with upload progress (fetch cannot report it over HTTP/1.1), the API key in the
 * header. The browser streams the file from disk, so a whole disc image never sits in memory.
 */
export function upload<T>(path: string, file: Blob, o: { method?: string; contentType?: string; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(o.method ?? "POST", `${urlBase}${path}`);
    x.setRequestHeader("X-Api-Key", apiKey());
    x.setRequestHeader("content-type", o.contentType ?? "application/octet-stream");
    x.upload.onprogress = e => o.onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
    x.onload = () => {
      let data: any = null;
      try { data = x.responseText ? JSON.parse(x.responseText) : null; } catch { /* below */ }
      if (x.status >= 200 && x.status < 300 && data !== null) resolve(data as T);
      // a body over the server's limit is refused before the API sees it, without a JSON answer
      else if (x.status === 413 && !data?.error) reject(new ApiError("the file is larger than this server takes (Settings → Media Management: Largest game file upload)", 413));
      else reject(new ApiError(data?.error ?? (x.status ? `HTTP ${x.status}` : "the upload failed"), x.status, data));
    };
    x.onerror = () => reject(new ApiError("the upload was cut off (is ludarr still running?)", 0));
    x.onabort = () => reject(new ApiError("cancelled", 0));
    if (o.signal) { if (o.signal.aborted) { reject(new ApiError("cancelled", 0)); return; } o.signal.addEventListener("abort", () => x.abort(), { once: true }); }
    x.send(file);
  });
}

/* ─────────── types (mirrors of the server's serializers) ─────────── */

export type GameStatus = "unreleased" | "missing" | "searching" | "downloading" | "importing" | "available" | "unmonitored" | "failed";

export interface RequestView {
  id: number; gameId: number; gameName: string | null; coverUrl: string | null; state: string; stage: string | null; progress: number; message: string | null;
  release: { title: string; protocol: string; indexer: string | null; size: number | null; group: string | null } | null;
  attempt: number; candidates: number; fetchId: number | null; jobId: number | null; packageId: number | null; nextTryAt: number | null; createdAt: number; updatedAt: number; doneAt: number | null;
}
export interface FetchView {
  id: number; gameId: number | null; guid: string | null; indexerId: number | null; indexer: string | null; title: string; protocol: string; size: number | null; infoHash: string | null;
  client: string; clientId: string | null; clientInstanceId: number | null; indexerInstanceId: number | null; state: string; progress: number; seedboxPath: string | null; seedboxIsDir: boolean;
  localPath: string | null; message: string | null; rate?: number; createdAt: number; updatedAt: number; doneAt: number | null;
}
export interface JobView {
  id: number; requestId: number | null; fetchId: number | null; gameId: number | null; inputPath: string; outputPath: string | null; state: string; tier: string | null; progress: number;
  message: string | null; manifest: any; transcript?: string; transcriptLines?: number; lesson?: any; fingerprint?: any; trace?: TraceStep[]; createdAt: number; updatedAt: number; doneAt: number | null;
  /** import | construct | assemble | content | build | make, and what the job was asked to do */
  kind?: string; spec?: any;
  /** the carry run that started the job, and why it ended badly (a newer engine sends them) */
  runId?: number | null; fail?: FailInfo | null;
}
/** one recorded step of a job (jobs.trace_json): an AI run's brief, its words, or a tool call with its input and output;
 *  an assemble job's check ({kind: "check", report}) */
export interface TraceStep { turn: number; t: number; kind: string; text?: string; tool?: string; input?: Record<string, unknown>; output?: string; ms?: number; report?: CheckReport }
/** a release a search that took nothing found, and why it was not taken (GET /queue `refused`) */
export interface RefusedRelease { title: string; indexer: string; size: number; protocol: string; why: string[] }
/** a search's wait on the seedbox (GET /queue `waiting`): what it waits on, since when (unix s), whether it stopped after
 *  72 h (the download kept), when it is tried again, and why. kind "arrival": its download is awaited in the
 *  finished-downloads folder, and `ask` is the question the admin may answer (POST /download/:id/arrival with one of `choices`) */
export interface SeedboxWait { kind: string; since: number; stopped: boolean; nextTryAt: number | null; words: string; ask?: { why: "late" | "lost" | "ambiguous"; choices: ArrivalChoice[] } | null }
export type ArrivalChoice = "seedbox" | "now" | "wait" | "again";
export interface QueueItem extends RequestView { download: FetchView | null; import: JobView | null; refused?: RefusedRelease[] | null; waiting?: SeedboxWait | null }

export interface Game {
  id: number; igdbId: number | null; steamAppId: number | null; name: string; slug: string | null; summary: string | null; releaseYear: number | null; rating: number | null;
  drm: string | null; crackStatus: string | null; crackDate: string | null; crackGroup: string | null; crackwatchUrl: string | null;
  coverUrl: string | null; bannerUrl: string | null; screenshots: string[]; genres: string[]; themes: string[]; platforms: string[]; gameModes: string[];
  developer: string | null; publisher: string | null; comingSoon: boolean; releaseText: string | null; releaseIso: string | null;
  monitored: boolean; profileId: number | null; rootFolderId: number | null; path: string | null; tags: string[]; addedAt: number; titleId: number | null;
  /** steam | igdb | catalog | manual (a game added by hand has no source to refresh it from) */
  source: string; aliases: string[]; searchTerms: string[];
  /** the art kinds set by hand (automatic art never replaces them), and when that art last changed (the cache key) */
  customArt: string[]; customArtAt: number | null;
  status: GameStatus; statusDetail: string; hasFile: boolean;
  file: {
    id: number; path: string; size: number | null; version: string | null; launch: string | null; files: number | null; importer: string | null; release: string | null; group: string | null; format: string; addedAt: number; kind?: string; requiresLauncher?: string | null;
    /** the whole start, program and arguments (null for a console dump), and when it was last set or reset by hand (a newer engine sends them) */
    start?: string | null; launchRev?: number | null;
  } | null;
  cutoffUnmet: boolean; request: RequestView | null; profile: { id: number; name: string } | null; rootFolder: { id: number; path: string } | null; tracked: boolean;
}

/* ─────────── how a game's copy starts (GET /game/:id/launch, src/library/launch.ts) ─────────── */

/** where a start comes from: set by hand, the plan (a way's copy), ludarr's own pick, the AI importer's */
export type StartBy = "hand" | "plan" | "ludarr" | "ai";
/** what the package says about a file, quoted as written, with where it says it (version info, README.md, a script …) */
export interface LaunchWords { text: string; source: string }
export interface LaunchStart {
  exe: string; argv: string[]; line: string; cwd: string | null; env: Record<string, string>;
  startsIn: { kind: "program" | "game" | "folder"; folder: string };
  by: StartBy; needsAhoy: string | null; rev: number | null;
}
/** a start as the editor holds it: cwd null is the program's folder, "{install}" the game's, else a folder of the copy */
export interface LaunchFields { exe: string; argv: string[]; cwd: string | null; env: Record<string, string> }
export interface LaunchProgram {
  path: string; size: number; current: boolean; kind: "program" | "dll" | "other" | null; ui: "window" | "console" | null;
  /** an installer or a helper, as the importer judges it: by its name, its folder, its header and the copy's layout (listed last, dimmed) */
  helper: boolean; starts: boolean;
  /** why it cannot be picked, or null */
  refused: string | null; words: LaunchWords[];
}
export interface LaunchScript {
  path: string; size: number; comment: string | null; runs: string | null; program: string | null;
  /** a .bat or .cmd, which can itself be picked as the start (unless `refused` says why not); it starts the copy now; what
   *  it does on a player's PC beyond starting a program, each with the line that does it (a newer engine sends these) */
  startable?: boolean; refused?: string | null; current?: boolean; does?: string[];
}
export interface LaunchView {
  gameId: number; name: string; slug: string; packageId: number; kind: string; from: "way" | "import"; wayId: number | null;
  editable: boolean; why: string | null; busy: string | null;
  /** Reset can be asked: a start is set by hand, or the copy starts otherwise than found (a newer engine sends it) */
  resettable?: boolean;
  start: LaunchStart | null; auto: LaunchStart | null;
  /** notApplied: why the start set by hand is not this copy's, null when that is not known */
  set: (LaunchFields & { at: number; line: string; cwd?: string | null; env?: Record<string, string>; paths?: string[] }) | null; applied: boolean; notApplied: string | null;
  fields: LaunchFields | null;
  /** the copy's start as it is now, in the editor's form (Save is offered once the fields differ from it) */
  now?: LaunchFields | null;
  programs: LaunchProgram[]; scripts: LaunchScript[]; files: number; folders: string[];
  placeholders: { install: string; content: string | null };
  settingsWindow: Record<string, string>;
}
/** what Save would say of a start (POST /game/:id/launch/check) */
export interface LaunchCheck { errors: string[]; warnings: string[]; line: string | null; needsAhoy: string | null }
export interface LaunchFileHit { path: string; size: number; kind: "program" | "script" | "file" }
export interface GameDetail extends Game {
  history: { id: number; event: string; release: string | null; source: string | null; message: string | null; at: number }[];
  jobs: { id: number; kind?: string; state: string; tier: string | null; message: string | null; createdAt: number; doneAt: number | null }[];
  files: { id: number; path: string; size: number | null; version: string | null; format: string; createdAt: number }[];
  routes: Route[];
  catalogTitle: { id: number; slug: string } | null;
}
export interface Route {
  id: number; kind: string; platform: string; provenance: string; label: string | null; status: string | null; statusNote: string | null; statusAt: number | null;
  runtime: { id: string; name: string; kind: string | null; latest: { tag: string; date: string | null; asset: { name: string; url: string; size: number } | null; page: string | null } | null } | null;
  content: any; needs: any[]; features: string[]; launch: any; link: string | null; source: string; updatedAt: number;
}
export interface LookupHit {
  id: { scheme: string; value: string }; name: string; year: number | null; platforms: string[]; cover: string | null; summary: string | null; releaseIso?: string | null;
  source: string; gameId: number | null; status: GameStatus | null; kinds?: string[];
}
export interface Release {
  guid: string; title: string; instanceId: number; indexerId: number; indexer: string; size: number; age: number; publishDate: string; seeders: number | null; leechers: number | null;
  grabs: number | null; downloadUrl: string | null; magnetUrl: string | null; infoUrl: string | null; protocol: string; score: number; reasons: string[];
  parsed: { group: string | null; format: string | null; repack: boolean; scene: boolean; version: string | null; junk: string[]; platform: string | null };
  match: { ok: boolean; core: number; optional: number }; flags?: Record<string, unknown>;
  format: string; certain: boolean; allowed: boolean; blocked: boolean;
  /** why the automatic searcher would not take it, in plain words (`certain` = none) */
  refusals?: string[];
  /** the name (the game's own or another it goes by) this release was judged under */
  matchedName?: string;
}
/** GET /api/v1/release */
export interface ReleaseSearch {
  game: { name: string; gameId: number | null; year: number | null; aliases?: string[]; terms?: string[] };
  items: Release[]; total: number; searched: string[]; errors: { indexer: string; error: string }[]; elapsedMs: number;
}
export interface HistoryItem { id: number; gameId: number | null; gameName: string | null; event: string; label: string; release: string | null; source: string | null; message: string | null; data: any; at: number }
export interface BlockItem { id: number; gameId: number | null; gameName: string | null; guid: string | null; title: string; indexer: string | null; reason: string | null; at: number }

export type FieldType = "text" | "password" | "number" | "checkbox" | "select" | "textarea" | "path" | "url" | "tags";
export interface Field { name: string; label: string; type: FieldType; helpText?: string; placeholder?: string; required?: boolean; default?: unknown; options?: { value: string | number; label: string }[]; advanced?: boolean; showIf?: { field: string; equals: unknown }; readOnly?: boolean }
export type Settings = Record<string, unknown>;
export interface Definition { impl: string; name: string; description: string | null; fields: Field[]; infoLink: string | null; plugin: string; protocols: string[] | null }
export interface Instance { id: number; kind: string; impl: string; name: string; enabled: boolean; priority: number; settings: Settings; tags: string[]; implName: string; missing: boolean; pluginEnabled: boolean; createdAt: number; updatedAt: number }

export interface Profile {
  id: number; name: string; formats: string[]; cutoff: string; upgrade: boolean; protocol: string; kinds: string[]; maxSizeGb: number | null; minSeeders: number;
  mustContain: string[]; mustNotContain: string[]; preferredGroups: string[]; blockedGroups: string[]; minScore: number;
  consoleFallback: boolean;
}
export interface RootFolder { id: number; path: string; name: string | null; accessible: boolean; freeSpace: number | null; totalSpace: number | null; games: number; createdAt: number }
export interface ConfigItem { key: string; group: string; label: string; doc: string; type: string; options?: { value: string; label: string }[]; advanced: boolean; secret: boolean; source: string; value: string; showIf?: { field: string; equals: unknown } }
export interface HealthItem { type: "error" | "warning" | "notice"; source: string; message: string; link?: string }
export interface TaskView { name: string; label: string; intervalSec: number; running: boolean; runs: number; lastRun: number | null; lastDuration: number | null; lastError: string | null; nextRun: number }
export interface LogLine { id: number; level: string; logger: string; message: string; at: number }
export interface PluginView { id: string; name: string | null; version: string | null; description: string | null; author: string | null; source: string; builtin: boolean; enabled: boolean; error: string | null; loadedAt: number | null; definitions: { kind: string; impl: string; name: string }[] }
export interface SystemStatus { appName: string; version: string; startTime: string; uptime: number; runtime: string; os: string; arch: string; docker: boolean; paths: { config: string; downloads: string; rootFolders: string[] }; counts: Record<string, number> }
export interface DiscoverItem { appId: number; name: string; img: string | null; portrait: string | null; drm: string | null; crackStatus: string | null; crackDate: string | null; crackGroup: string | null; releaseText: string | null; releaseIso: string | null; releaseSort?: string | null; daysUntil: number | null; comingSoon: boolean; reviewSummary: string | null; reviewPct: number | null; reviewCount: number | null; metacritic: number | null; genres: string[]; summary: string | null; free: boolean; inLibrary: boolean; gameId: number | null; followed: boolean; requestState: string | null }
export interface DiscoverSection { key: string; title: string; sub: string; items: DiscoverItem[]; updatedAt: number; stale: boolean }
/** a Metacritic list entry, matched to a Steam app (only the dead web/src/ahoy copy still uses these) */
export interface BestItem extends DiscoverItem { rank: number; userScore: number | null; mcSlug: string }
export interface BestListInfo { key: string; label: string; sub: string }
export interface BestList extends BestListInfo { items: BestItem[]; updatedAt: number; stale: boolean; pending: number; total: number }

/* ─────────── ways to play (src/ways/types.ts, src/ways/api.ts) ─────────── */

/** what the admin (or the AI importer) says a game is, for an add by hand or an edit of its details */
export interface GameDraft {
  name: string; aliases: string[]; platforms: string[]; year: number | null; releaseIso: string | null; summary: string | null;
  genres: string[]; developer: string | null; publisher: string | null; searchTerms: string[];
}
export type PlanKind = "recomp" | "port" | "emulator";
export type PlanStatus = "draft" | "ready" | "broken";
export type WayStatus = "needs-files" | "ready" | "building" | "built" | "failed";
export interface AcceptHash { algo: string; value: string; label?: string }
/** what a game file is made from, and how (src/ways/types.ts ContentMake): only the parts the pages read */
export interface ContentMake {
  from?: string[];
  input: { shape: "file" | "folder" | "either"; platform: string; formats?: string[]; marker?: string; also?: string[]; serials?: string[]; versions?: string[]; regions?: string[] };
  steps: Record<string, unknown>[];
  output: { shape: "file" | "folder"; name: string };
}
export interface ContentPlan {
  kind: "rom" | "disc" | "folder"; platform: string; what: string; search: string[];
  accept: { hashes: AcceptHash[]; formats?: string[]; regions?: string[]; serials?: string[]; versions?: string[]; builds?: string[]; category?: string };
  normalize?: "n64-z64" | null; place: string; ship?: boolean;
  marker?: string; also?: string[]; personalDump?: string | null; make?: ContentMake | null;
}
export interface NeedSlot { kind: "bios" | "firmware" | "keys" | "other"; name: string; place: string; accept?: { hashes?: AcceptHash[]; sizes?: number[]; formats?: string[] }; note?: string }
export type ProgramSource =
  | { kind: "release"; assetPattern: string; channel: "stable" | "nightly" }
  | { kind: "feed"; feed: string }
  | { kind: "url"; url: string; sha256: string }
  | { kind: "source"; ref: string; steps: string[]; artifact: string; apt?: string[]; content: "none" | "build" };
export interface PlanSpec {
  program: ProgramSource; root?: string;
  launch: { exe: string; argv: string[]; cwd?: string; env?: Record<string, string> };
  content: ContentPlan | null; files: { path: string; text: string; after?: "setup" }[]; setup: Record<string, any>[];
  tools?: { ref: string; steps: string[]; outputs: string[]; apt?: string[] } | null;
  needs: NeedSlot[]; keep: string[]; seed: string[]; firstRun: string | null; notes: string;
}
export interface PinnedProgram { tag: string; asset: string; url: string; size: number; sha256: string; digest?: string | null; immutable?: boolean | null; pinnedAt: number }
export interface NeedsMet { met: boolean; missing: { index: number; name: string; why: string | null }[] }
export interface Plan {
  id: number; slug: string; name: string; kind: PlanKind; repo: string; homepage: string | null; platforms: string[]; spec: PlanSpec;
  pinned: PinnedProgram | null; status: PlanStatus; statusNote: string | null; author: "user" | "ai"; jobId: number | null;
  createdAt: number; updatedAt: number; waysCount: number; needs: NeedsMet;
}
/** a kept file: a game file (role game) or a file one of a plan's needs asks for (role system); its path stays on the server */
export interface ContentFile {
  id: number; gameId: number | null; planId: number | null; needIndex: number | null; role: "game" | "system"; platform: string | null; name: string; size: number;
  hashes: Record<string, string>; rawHashes: Record<string, string> | null; normalized: string | null; source: string; createdAt: number; onDisk: boolean;
  /** what its own bytes say it is, a game folder or one file, and what it was made from (a newer engine sends them) */
  identity?: Identity | null; shape?: "file" | "folder"; made?: MadeInfo | null;
  /**
   * the same bytes as the game's copy on the server, kept a second time in their own space on the copy's volume: freeing
   * it (POST /content/:id/free-duplicate) makes it a link to the copy's file and gives back `bytes`; null when it is not
   * (or no longer) such a copy. Absent from an engine that does not tell (the page then goes by the copy's name and size)
   */
  secondCopy?: { bytes: number } | null;
}
/** what a made game file was made from (contents.made_json) */
export interface MadeInfo { from: { kind: string; packageId?: number | null; contentId?: number | null; fetchId?: number | null; digest: string }; recipe: string; tools: string[]; program?: string | null; key: string; at: number }
/** what a game file's own bytes say (src/ways/identity.ts) */
export interface Identity {
  platform: string; serial?: string; discId?: string; gameCode?: string; internalName?: string; region?: string; version?: string; disc?: number;
  category?: "game" | "patch" | "addon" | "app"; contentId?: string; masterVersion?: string; shape?: "bd-image" | "folder" | "zar" | "pkg" | "nup" | "iso";
  sealed?: boolean; build?: string; titles?: string[];
}
export interface NeedSlotView { index: number; kind: string; name: string; place: string; note: string | null; accept: NeedSlot["accept"] | null; file: ContentFile | null; ok: boolean }
export interface PlanDetail extends Plan {
  needSlots: NeedSlotView[];
  ways: { id: number; gameId: number; gameName: string; status: WayStatus; statusNote: string | null; packageId: number | null }[];
}
export interface Verdict { ok: boolean; why: string | null; matched?: AcceptHash }
export interface Blocker { code: "building" | "plan" | "needs" | "file" | string; error: string; missing?: { index: number; name: string; why: string | null }[] }
export interface Way {
  id: number; gameId: number; planId: number; planName: string | null; planKind: PlanKind | null; content: ContentPlan | null; ownContent: boolean;
  /** launch: how the game starts, set by hand on the game page (Starts with) */
  overrides: { files?: unknown[]; argvExtra?: string[]; env?: Record<string, string>; launch?: { exe: string; argv: string[]; cwd?: string; env?: Record<string, string>; at: number } };
  contentId: number | null; packageId: number | null;
  status: WayStatus; statusNote: string | null; createdAt: number; updatedAt: number;
  plan: { id: number; slug: string; name: string; kind: PlanKind; status: PlanStatus; statusNote: string | null; repo: string } | null;
  file: ContentFile | null; fileCheck: Verdict | null; fromConsoleCopy: boolean; needs: NeedsMet;
  blockers: Blocker[]; canBuild: boolean; replaces: string | null; job: JobView | null;
  /** the game's copy on the server as this way sees it, and the way's carry run: absent from an engine without runs */
  copy?: CopyView | null;
  run?: WayRun | null;
}
/** a way's carry run as the way listing carries it */
export interface WayRun { id: number; phase: RunPhase; state: RunState; ask: RunAsk | null }
/** what a content upload tells: the kept file, whether the same bytes were kept already, and how it fits each way */
export interface UploadResult { item: ContentFile; duplicate: boolean; attached?: number[]; checks?: { wayId: number; plan: string; ok: boolean; why: string | null }[]; plan?: PlanDetail }

/* ─────────── carry runs: a repo carried all the way to a game members install (src/ways/types.ts, src/ways/carry-api.ts) ─────────── */

export type RunPhase = "plan" | "game" | "file" | "build" | "check" | "done";
export type RunState = "active" | "waiting" | "asking" | "held" | "done" | "stopped";
/** a phase's state on the run's rail */
export type RailState = "done" | "active" | "waiting" | "asked" | "failed" | "env" | "todo";
export type AskCode = "file" | "held-file" | "game" | "needs" | "ai" | "budget" | "room" | "env" | "choice" | "go-ahead";
/** the forms an ask takes (src/ways/types.ts AskSpec accept) */
export interface AskAccept { platform?: string; shape?: "file" | "folder" | "either"; formats?: string[]; serials?: string[]; versions?: string[]; regions?: string[] }
/** what a run asks the admin, while it keeps watching for the answer by itself */
export interface RunAsk {
  code: AskCode; title: string; need: string; tried: string[]; accept: AskAccept | null;
  /** the inbox folder as the server sees it, and as the admin's PC opens it (Settings: Library as your PC sees it) */
  inbox: string | null; inboxShare: string | null;
  /** whether an upload can bring what is asked for (a single file within the upload limit) */
  canUpload: boolean;
  choices: { gameId: number; name: string; year: number | null; platforms: string[] }[]; heldContentId: number | null;
  watching: { nextSearchAt: number | null; inbox: boolean; every: string } | null; askedAt: number; byAi: string | null;
}
export interface RunStep {
  at: number; phase: RunPhase; who: "ludarr" | "ai" | "admin"; text: string; outcome: "ok" | "refused" | "failed" | "waiting" | "env" | "asked" | null;
  jobId?: number; requestId?: number; contentId?: number; proof?: string;
}
export interface RunView {
  id: number; planId: number; planName: string; gameId: number | null; gameName: string | null; wayId: number | null;
  phase: RunPhase; state: RunState;
  rail: { phase: Exclude<RunPhase, "done">; state: RailState; summary: string | null }[];
  now: { text: string; progress: number | null; jobId: number | null; requestId: number | null } | null;
  ask: RunAsk | null; steps?: RunStep[];
  budget: { rounds: number; roundsUsed: number; tokens: number; tokensUsed: number };
  nextAt: number | null; startedBy: "construct" | "admin" | "way" | "backfill"; createdAt: number; updatedAt: number; doneAt: number | null;
  /** the check the run read from its build (an engine may send it; else the page reads it from the build's job) */
  check?: CheckReport | null;
}
/** what the admin answers a run's ask with (POST /api/v1/run/:id/answer) */
export type RunAnswer = { gameId: number } | { newGame: true } | { go: boolean };
/** the game's copy on the server, judged in place: 'direct' it is the way's file, 'make' the file is made from it */
export interface CopyView { packageId: number; name: string; size: number; shape: "file" | "folder"; identity: Identity | null; serves: "direct" | "make" | "no" | "unknown"; why: string }
export interface CheckStepReport { what: string; code: number | null; ok: boolean; tail: string; seconds: number }
/** screenshot: a PNG's file name the engine serves at GET /api/v1/check-shot/:name, or null */
export interface SmokeReport { verdict: "pass" | "fail" | "env"; alive: boolean; exitCode: number | null; titles: string[]; screenshot: string | null; outputTail: string; why: string }
/** 'env': the server cannot tell (no graphics device, a CPU it lacks), which proves nothing either way */
export interface CheckReport { verdict: "pass" | "fail" | "env" | "none"; steps: CheckStepReport[]; smoke: SmokeReport | null; text: string }
/** why a job ended badly (src/ways/types.ts FailInfo) */
export interface FailInfo { class: "env" | "plan" | "file" | "cancelled" | "restart" | "other"; kind?: string; phase?: string; by?: "admin" | "run" | "system" }
/** what a construct job leaves in its manifest (src/ways/types.ts ConstructManifest) */
export interface ConstructManifest {
  planId: number; wayId?: number | null; game?: Partial<GameDraft> | null; runId?: number | null;
  changed?: string[]; diff?: { field: string; before: unknown; after: unknown }[]; ask?: unknown; tokens?: number;
}

/* ─────────── formatting ─────────── */

// one formatter for the pages and the rules behind them (ways/logic.ts imports nothing from here but types)
export { fmtSize } from "./ways/logic";
export const fmtRate = (bps: number | null | undefined) => !bps ? "" : bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`;
export function timeAgo(sec: number | null | undefined, ms = false): string {
  if (!sec) return "—";
  const t = ms ? sec : sec * 1000;
  const d = Math.max(0, Date.now() - t);
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)} h ago`;
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)} d ago`;
  return new Date(t).toLocaleDateString();
}
export const fmtDate = (sec: number | null | undefined, ms = false) => !sec ? "—" : new Date(ms ? sec : sec * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const fmtDur = (msv: number | null | undefined) => msv == null ? "—" : msv < 1000 ? `${msv} ms` : msv < 90_000 ? `${(msv / 1000).toFixed(1)} s` : `${Math.round(msv / 60_000)} min`;
export const sentence = (s: string | null | undefined) => !s ? "" : s.charAt(0).toUpperCase() + s.slice(1);
