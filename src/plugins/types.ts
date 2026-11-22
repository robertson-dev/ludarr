/**
 * ludarr — the plugin contract. Everything that touches the outside world is a plugin, built-in or
 * dropped into <config>/plugins/<name>/: indexers, download clients, metadata sources, importers (how a
 * download becomes an installed game), runtimes (emulators, recomp/port builds) and notifications.
 *
 * A plugin ships *definitions*; the user creates *instances* of them in Settings (an instance = a
 * definition + settings, e.g. "NZBGet on the seedbox"). Metadata, importer and runtime definitions are
 * singletons: one instance each, created automatically, that can be disabled or re-ordered.
 *
 * External plugins: a folder with package.json ("main" or index.ts/js) whose default export is a
 * `LudarrPlugin`. Bun loads TypeScript directly. `api` must match PLUGIN_API.
 */
import type { Provider as CatalogProvider } from "../catalog/types";
import type { PullHandle, PullJob } from "../pull";
import type { SbClient, SbItem } from "../seedbox-items";

export const PLUGIN_API = 1;

export type Protocol = "torrent" | "usenet";

/* ─────────── settings schema (drives the generated forms in the UI, like *arr's field definitions) ─────────── */

export type FieldType = "text" | "password" | "number" | "checkbox" | "select" | "textarea" | "path" | "url" | "tags";
export interface FieldOption { value: string | number; label: string }
export interface Field {
  name: string;
  label: string;
  type: FieldType;
  helpText?: string;
  placeholder?: string;
  required?: boolean;
  default?: string | number | boolean | string[];
  options?: FieldOption[];
  /** hidden behind "show advanced" */
  advanced?: boolean;
  /** only shown when another field has this value */
  showIf?: { field: string; equals: string | number | boolean };
}
export type Settings = Record<string, string | number | boolean | string[] | null | undefined>;

export interface TestResult { ok: boolean; detail: string }

/* ─────────── definitions ─────────── */

export interface DefinitionBase {
  /** stable id, unique within its kind: "prowlarr", "rtorrent", "steam" */
  impl: string;
  name: string;
  description?: string;
  fields: Field[];
  /** link to docs for the UI's "?" */
  infoLink?: string;
  /** singleton kinds: false = the instance is created disabled; it can be switched on under Settings */
  defaultEnabled?: boolean;
}

/* indexers */

export interface Release {
  guid: string;
  title: string;
  /** the indexer instance that found it (ludarr's) and the indexer inside it (Prowlarr's id, or 0) */
  instanceId: number;
  indexerId: number;
  indexer: string;
  size: number;
  age: number;                 // days
  publishDate: string;
  seeders: number | null;
  leechers: number | null;
  grabs: number | null;
  files: number | null;
  downloadUrl: string | null;
  magnetUrl: string | null;
  infoUrl: string | null;
  infoHash: string | null;     // uppercase hex when the indexer reports it
  protocol: Protocol | "unknown";
  categories: { id: number; name?: string }[];
  indexerFlags: string[];
  fileName: string | null;
  /** "private" | "public" | "semi-private" when known */
  privacy?: string;
}
export type Payload =
  | { kind: "magnet"; uri: string }
  | { kind: "torrent" | "nzb"; bytes: Uint8Array; filename: string };

export interface Indexer {
  test(): Promise<TestResult>;
  search(query: string, opt?: { categories?: number[]; limit?: number }): Promise<Release[]>;
  /** optional: what was posted lately (the RSS feed) — read on an interval for the wanted games */
  recent?(opt?: { categories?: number[]; limit?: number }): Promise<Release[]>;
  /** optional: the source's own health warnings, shown with ludarr's (an indexer in a failure backoff explains an empty search) */
  health?(): Promise<{ type: "error" | "warning" | "notice"; message: string }[]>;
  /** what a download client needs: a magnet, or the .torrent / .nzb bytes */
  download(release: Release): Promise<Payload>;
  /** privacy per inner indexer id, when the source knows (ranking prefers private trackers) */
  privacy?(): Promise<Map<number, string>>;
}
export interface IndexerDefinition extends DefinitionBase {
  kind: "indexer";
  protocols: Protocol[];
  create(settings: Settings, ctx: PluginContext): Indexer;
}

/* download clients */

/** which program inside the client holds the item: a connector can front both a torrent and a usenet client */
export type ItemRef = { client: SbClient; clientId: string };
export interface AddedItem extends ItemRef { infoHash?: string | null }
export interface ItemsSnapshot { items: SbItem[]; /** programs that did not answer this time (their items are not stale, just unknown) */ unavailable?: SbClient[] }
export interface DownloadClient {
  test(): Promise<TestResult>;
  /** submit a payload; the returned ref is how `items()` will refer to it. `key`: the release's guid — an add sent again
   *  after an answer that never came must find what the first one made, never add it twice */
  add(payload: Payload, opt: { title: string; protocol: Protocol; key?: string }): Promise<AddedItem>;
  /** one snapshot of everything the client holds (only what ludarr submitted matters) */
  items(): Promise<ItemsSnapshot>;
  remove(ref: ItemRef, deleteData: boolean): Promise<void>;
  /** optional: when an imported torrent may be removed (ratio and/or hours of seeding; 0 = no goal, both 0 = never) */
  seedGoals?: { ratio: number; hours: number };
  /**
   * get a finished item onto this machine: a transfer handle, or `{ local }` when the path is already
   * readable here (a client on the same host, a mapped volume).
   */
  pull(item: { path: string; isDir: boolean; sizeBytes: number }, job: PullJob): PullHandle | { local: string };
  /** optional: the files a torrent holds — paths inside its own folder, sizes in bytes (what an arrival in the
   *  finished-downloads folder waits for: src/arrivals.ts; and what a transfer whose file listing shows less than the
   *  client has fetches by path: `job.files`, src/pull-http.ts) */
  files?(ref: ItemRef): Promise<{ path: string; size: number }[]>;
  /** optional: a hook run at startup (install a connector, log in …) */
  ready?(): Promise<void>;
}
export interface DownloadClientDefinition extends DefinitionBase {
  kind: "downloadClient";
  protocols: Protocol[];
  create(settings: Settings, ctx: PluginContext): DownloadClient;
}

/* metadata (the catalog): where games and their routes come from, and "Add new" lookups */

export interface LookupHit {
  /** id in the source's own scheme, so the game can be added: { scheme, value } */
  id: { scheme: string; value: string };
  name: string;
  year: number | null;
  platforms: string[];
  cover: string | null;
  summary: string | null;
  /** release date when the source knows it (YYYY-MM-DD) */
  releaseIso?: string | null;
}
export interface MetadataSource extends CatalogProvider {
  /** optional: "Add new" search (Steam store search, IGDB search …) */
  lookup?(term: string, ctx: PluginContext): Promise<LookupHit[]>;
  test?(): Promise<TestResult>;
}
export interface MetadataDefinition extends DefinitionBase {
  kind: "metadata";
  create(settings: Settings, ctx: PluginContext): MetadataSource;
}

/* importers: a finished download → an installed game folder (the processing pipeline, in priority order) */

export interface ImportContext {
  input: string;            // the download (read-only)
  staging: string;          // where the installed game must end up
  work: string;             // scratch
  gameName: string;
  releaseTitle: string;
  group: string | null;
  log: (line: string) => void;
  progress: (p: number, message: string) => void;
  signal: AbortSignal;
  /** what earlier importers left behind (shape, problems) so a later one can pick up where they stopped */
  previous: { importer: string; shape: string; problems: string[] }[];
  /** a console id ("ps5", "switch" …) when the release itself was taken as a console dump — unpacked as it is, never installed; absent for a PC release */
  platform?: string | null;
  /** the consoles the game is on: when nothing names the release's platform and no PC game comes out, a dump for one of these is accepted as it is */
  consoles?: string[];
  /** full step recording (the AI importer's every command and output) */
  trace?: (step: TraceStepLike) => void;
}
export type TraceStepLike = { turn: number; t: number; kind: string; text?: string; tool?: string; input?: Record<string, unknown>; output?: string; ms?: number };
export interface ImportResult {
  ok: boolean;
  shape: string;
  reason: string | null;
  launchExe?: string | null;
  version?: string | null;
  notes?: string | null;
  /** the validator's verdict on STAGING when the importer ran it (saves a second pass) */
  validation?: import("../process/validate").Validation | null;
  /** set when what came out is a console dump (its console id), whether the release said so or the content did */
  platform?: string | null;
  /** what it did, one line each */
  steps?: string[];
  /** the AI importer's lesson, when there is one */
  lesson?: unknown;
}
export interface Importer {
  /** quick look: is this something I handle? (false lets the next importer try without running anything) */
  probe(ctx: ImportContext): Promise<boolean>;
  run(ctx: ImportContext): Promise<ImportResult>;
  test?(): Promise<TestResult>;
}
export interface ImporterDefinition extends DefinitionBase {
  kind: "importer";
  create(settings: Settings, ctx: PluginContext): Importer;
}

/* runtimes: emulators and recomp / port builds the catalog can offer */

import type { RuntimeInput } from "../catalog/types";
export interface RuntimeDefinition extends DefinitionBase {
  kind: "runtime";
  /** the runtimes this plugin knows (release source, launch spec, what they need) */
  runtimes(settings: Settings, ctx: PluginContext): RuntimeInput[];
}

/* notifications ("Connect") */

/** download = a game was imported and is ready (what *arr calls "on download / on import") */
export type NotifyEvent = "grab" | "download" | "failed" | "upgrade" | "delete" | "health" | "test";
export interface Notification {
  gameId?: number | null;
  gameName?: string | null;
  title: string;
  message: string;
  release?: string | null;
  data?: Record<string, unknown>;
}
export interface Notifier {
  send(event: NotifyEvent, n: Notification): Promise<void>;
  test(): Promise<TestResult>;
}
export interface NotificationDefinition extends DefinitionBase {
  kind: "notification";
  create(settings: Settings, ctx: PluginContext): Notifier;
}

export type Definition = IndexerDefinition | DownloadClientDefinition | MetadataDefinition | ImporterDefinition | RuntimeDefinition | NotificationDefinition;
export type Kind = Definition["kind"];
export const KINDS: Kind[] = ["indexer", "downloadClient", "metadata", "importer", "runtime", "notification"];
/** kinds whose definitions get exactly one instance, created automatically */
export const SINGLETON_KINDS: Kind[] = ["metadata", "importer", "runtime"];

/* ─────────── what a plugin gets ─────────── */

export interface PluginLogger { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug(msg: string): void }
export interface PluginContext {
  /** the instance being created (undefined for a settings test or a runtime plugin) */
  instanceId?: number;
  /** namespaced key/value storage that survives restarts */
  store: { get(key: string): string | null; set(key: string, value: string): void; del(key: string): void };
  log: PluginLogger;
  fetch: typeof fetch;
  /** the main settings that plugins commonly need */
  paths: { config: string; downloads: string; work: string; rootFolders: string[] };
  /** a global setting (host/media management), read-only */
  config: (key: string) => string;
}

export interface LudarrPlugin {
  api: typeof PLUGIN_API;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  indexers?: IndexerDefinition[];
  downloadClients?: DownloadClientDefinition[];
  metadata?: MetadataDefinition[];
  importers?: ImporterDefinition[];
  runtimes?: RuntimeDefinition[];
  notifications?: NotificationDefinition[];
}

/** the helper plugins import: validates the shape at load time */
export function definePlugin(p: LudarrPlugin): LudarrPlugin {
  if (p.api !== PLUGIN_API) throw new Error(`plugin ${p.id}: api ${p.api} is not supported (this ludarr speaks ${PLUGIN_API})`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) throw new Error(`plugin id "${p.id}" must be lowercase letters, digits and dashes`);
  return p;
}

export function definitionsOf(p: LudarrPlugin): Definition[] {
  return [...(p.indexers ?? []), ...(p.downloadClients ?? []), ...(p.metadata ?? []), ...(p.importers ?? []), ...(p.runtimes ?? []), ...(p.notifications ?? [])];
}
