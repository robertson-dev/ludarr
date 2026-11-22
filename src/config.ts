/**
 * ludarr — global settings (everything that is not a plugin instance): host, media management, search,
 * import, catalog. Each key: environment variable wins, then the value saved from Settings (kv), then the
 * default. Ahoy's AHOY_* / old names are accepted as fallbacks so an existing ahoy.env keeps working.
 * Every key here is read where it matters (no key is decorative); "restart" in the doc marks the few that
 * only apply at boot.
 */
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { db, kv } from "./db";
import { formerKey } from "./former";

export type Group = "host" | "media" | "search" | "import" | "catalog";
export interface ConfigKey {
  key: string; group: Group; label: string; doc: string; def?: string; secret?: boolean;
  type?: "text" | "number" | "checkbox" | "path" | "select"; options?: { value: string; label: string }[]; advanced?: boolean; aliases?: string[];
  /** only shown when another key has this value */
  showIf?: { field: string; equals: string };
  /** emptied in Settings, it stays empty — that is how its feature is turned off — instead of going back to the default */
  emptyOff?: boolean;
}

export const CONFIG_KEYS: ConfigKey[] = [
  // ── host ──
  { key: "AUTH_METHOD",             group: "host", label: "Authentication", doc: "Basic: the browser asks for the username and password below; API calls keep using the API key", def: "none", type: "select", options: [{ value: "none", label: "None (trusted network)" }, { value: "basic", label: "Basic (browser prompt)" }] },
  { key: "AUTH_USERNAME",           group: "host", label: "Username", doc: "", def: "", showIf: { field: "AUTH_METHOD", equals: "basic" } },
  { key: "AUTH_PASSWORD",           group: "host", label: "Password", doc: "", def: "", secret: true, showIf: { field: "AUTH_METHOD", equals: "basic" } },
  { key: "PORT",                    group: "host", label: "Port", doc: "the port ludarr listens on (restart to apply; inside Docker the template sets it)", def: "7979", type: "number" },
  { key: "LOG_LEVEL",               group: "host", label: "Log level", doc: "applies at once", def: "info", type: "select", options: [{ value: "debug", label: "Debug" }, { value: "info", label: "Info" }, { value: "warn", label: "Warning" }, { value: "error", label: "Error" }] },
  // ── media management ──
  // the folder the admin's own sync fills with the seedbox's finished downloads (src/synced.ts, src/arrivals.ts): set and there,
  // a finished download is found there by its name and imported in place, never transferred; empty, downloads go as before
  { key: "LUDARR_ARRIVALS",        group: "media", label: "Finished downloads land in", doc: "the folder on this server where everything you download ends up", def: "/arrivals", type: "path", emptyOff: true },
  { key: "LUDARR_STAGING", group: "media", label: "SSD staging folder", doc: "Optional mounted folder, e.g. /ssd. Ludarr transfers downloads here, unpacks and verifies them here, then publishes the finished package to the game root folder.", def: "", type: "path" },
  { key: "LUDARR_DOWNLOADS",       group: "media", label: "Downloads folder", doc: "where a download ludarr transfers itself lands before import — /downloads inside Docker", def: "./downloads", type: "path", aliases: ["AHOY_DOWNLOADS"] },
  { key: "LUDARR_WORK",            group: "media", label: "Work folder", doc: "scratch space for imports; empty = a .work folder inside the root folder, so the final move is a rename", def: "", type: "path", aliases: ["AHOY_WORK"], advanced: true },
  { key: "IMPORT_KEEP_DOWNLOAD",    group: "media", label: "Keep downloads after import", doc: "off: the raw download is deleted once the game is imported (in the finished-downloads folder, only the files ludarr took for it)", def: "0", type: "checkbox", aliases: ["PROCESS_KEEP_INPUT"] },
  { key: "IMPORT_PARALLEL",         group: "media", label: "Imports at once", doc: "imports running side by side (each in its own scratch folder, Wine prefix and display); one needs scratch space of about three times its download, so a further import only starts while the scratch disk can hold it as well — it waits in the queue otherwise", def: "1", type: "number", aliases: ["PROCESS_PARALLEL"], advanced: true },
  { key: "CONTENT_UPLOAD_MAX_GB",   group: "media", label: "Largest game file upload (GB)", doc: "the biggest ROM or disc image sent with a way to play's own Upload button, in one piece (restart to apply); the game page's Upload sends a game of any size in small pieces and is not bound by this", def: "16", type: "number", advanced: true },
  { key: "PULL_PARALLEL",           group: "media", label: "Transfers at once", doc: "downloads pulled from remote clients concurrently", def: "2", type: "number", advanced: true },
  { key: "PULL_SEGMENTS",           group: "media", label: "Segments per transfer", doc: "parallel segments per file when pulling over https / ftp", def: "4", type: "number", advanced: true },
  { key: "QUEUE_POLL_SEC",          group: "media", label: "Download client poll (seconds)", doc: "how often the download clients are asked for progress", def: "10", type: "number", aliases: ["FETCH_POLL_SEC"], advanced: true },
  { key: "LIBRARY_SHARE_PATH",      group: "media", label: "Library as your PC sees it", doc: "the library folder as your PC opens it (for example \\\\tower\\games\\ahoy): the asks show the inbox folder this way", def: "", type: "text", advanced: true },
  // ── search ──
  { key: "SEARCH_MAX_CANDIDATES",   group: "search", label: "Releases to try per search", doc: "how many releases a search may try before waiting for the next round", def: "4", type: "number", aliases: ["REQUEST_MAX_CANDIDATES"] },
  { key: "SEARCH_RECHECK_HOURS",    group: "search", label: "Re-search missing games every (hours)", doc: "also how often the automatic search for missing games runs", def: "6", type: "number", aliases: ["REQUEST_RECHECK_HOURS"] },
  { key: "RSS_SYNC_MIN",            group: "search", label: "RSS sync every (minutes)", doc: "how often every indexer's recent feed is read for the wanted games, so a release is caught the moment it is posted; 0 turns it off", def: "15", type: "number" },
  { key: "CRACKWATCH_SYNC_HOURS",   group: "search", label: "Crack status refresh (hours)", doc: "how often the library and the storefront feeds are checked against CrackWatch (isitcracked.com) for DRM and crack status; settled verdicts are rechecked weekly. The automatic search takes only a copy GazelleGames marks DRM-free (and, beside one, the repacks and GOG posts of it) of a game CrackWatch says is uncracked or not out — unless its only DRM is Steam's own (or none), it came out these last 90 days and is not an online game, and GazelleGames has a cracking group's or a repacker's release of it (or a Home Rip) with its year, posted since it came out: then it counts as cracked, its copies posted since are taken, and the grab's history line says why. It asks CrackWatch about a new Steam game before its first search and again once a 'not out yet' is older than the store's date, and a crack wakes the search that waits for it; 0 turns all of it off", def: "6", type: "number" },
  { key: "CRACKWATCH_UA",           group: "search", label: "CrackWatch user agent", doc: "sent to isitcracked.com, which renders its pages for tool agents only; change it if the site starts answering with its empty app shell", def: "", type: "text", advanced: true },
  { key: "DOWNLOAD_STALL_MIN",      group: "search", label: "Stalled download timeout (minutes)", doc: "a torrent that gains nothing for this long while no one sends it data is dropped and that post blocklisted (the same release's other posts are still tried). Only time that counts: none while it is paused or checked in its client, its tracker does not answer the seedbox, the seedbox's disk or link is full, or the client does not answer; a third of it while seeders are connected but send nothing, half while the seedbox's client is slow to answer. Usenet downloads are NZBGet's to judge. One that does not move at all is asked about after a day and stopped (kept) after three", def: "45", type: "number", aliases: ["FETCH_STALL_MIN"] },
  // ── import ──
  { key: "WINE_INSTALL_MINUTES",    group: "import", label: "Installer time limit (minutes)", doc: "for running a scene / repack installer unattended under wine (the AI importer's key and model live on the importer itself: Settings → Importers)", def: "90", type: "number", advanced: true },
  { key: "WAYS_PARALLEL",           group: "import", label: "Builds at once", doc: "ways to play (an emulator, port or recomp with its game file) built side by side; builds have their own lane, so they never hold up the imports of finished downloads (Imports at once) — both share the scratch disk", def: "1", type: "number", advanced: true },
  { key: "WAYS_CACHE_GB",           group: "import", label: "Program cache (GB)", doc: "emulator, port and recomp downloads kept on the server so the next build of the same release needs no download; the least recently used go first; 0 keeps none", def: "20", type: "number", advanced: true },
  { key: "CARRY_AI_ROUNDS",         group: "import", label: "AI repairs per game", doc: "how many times the AI may rework a plan while making one game playable; 0 lets ludarr carry games through only as far as it can without the AI", def: "3", type: "number", advanced: true },
  { key: "CARRY_AI_TOKENS_M",       group: "import", label: "AI budget per game (million tokens)", doc: "the most the AI may spend on making one game playable; a game that reaches it waits for you instead of spending more", def: "8", type: "number", advanced: true },
  { key: "INTAKE_PARALLEL",         group: "import", label: "Game files taken in at once", doc: "game files checked and kept side by side for the ways to play: downloads a search brought, the game's copy on the server, files dropped into a game's inbox", def: "1", type: "number", advanced: true },
  { key: "LONG_PARALLEL",           group: "import", label: "Long game-data jobs at once", doc: "game files made from another form of the game's data, and programs built for one game, side by side: each can take hours, and they never hold up builds or game files being taken in", def: "1", type: "number", advanced: true },
  { key: "LIBRARY_KEEP_FREE_GB",    group: "import", label: "Keep free on the library (GB)", doc: "making game files, taking them in and building for one game stop before the library volume falls below this much free space", def: "50", type: "number", advanced: true },
  // ── catalog ──
  { key: "GITHUB_TOKEN",            group: "catalog", label: "GitHub token", doc: "optional, no scopes needed: the catalog checks emulator / port releases on GitHub, 60 calls an hour without one", secret: true },
  { key: "CATALOG_RUNTIME_CHECK_HOURS", group: "catalog", label: "Check runtime releases every (hours)", doc: "", def: "6", type: "number", advanced: true },
  { key: "DISCOVER_REFRESH_MIN",    group: "catalog", label: "Storefront feeds refresh (minutes)", doc: "coming soon / new / top sellers", def: "60", type: "number", advanced: true },
  { key: "FOLLOW_CHECK_HOURS",      group: "catalog", label: "Re-read release dates every (hours)", doc: "for monitored unreleased games whose release is not imminent (within two days it is every 30 minutes)", def: "12", type: "number", advanced: true },
];
const BY_KEY = new Map(CONFIG_KEYS.map(k => [k.key, k]));
/** a saved setting: under its own name, or — on a server set up under the engine's old name — under that one */
const saved = (key: string) => { const old = formerKey(key); return kv.get("cfg." + key) ?? (old ? kv.get("cfg." + old) : null); };

/** value of a global setting: env (own name, then aliases) → saved → default → "" */
export function cfg(key: string): string {
  const k = BY_KEY.get(key);
  for (const name of [key, ...(k?.aliases ?? [])]) if (process.env[name]) return process.env[name]!;
  return saved(key) ?? k?.def ?? "";
}
export function cfgNum(key: string, fallback: number): number { const v = cfg(key); const n = Number(v); return v !== "" && Number.isFinite(n) ? n : fallback; }
export const cfgBool = (key: string) => ["1", "true", "yes", "on"].includes(cfg(key).toLowerCase());
export const cfgList = (key: string) => cfg(key).split(",").map(s => s.trim()).filter(Boolean);
export const cfgInts = (key: string) => cfgList(key).map(Number).filter(Number.isInteger);

export function configSource(key: string): "env" | "saved" | "default" | "unset" {
  const k = BY_KEY.get(key);
  for (const name of [key, ...(k?.aliases ?? [])]) if (process.env[name]) return "env";
  if (saved(key) != null) return "saved";                               // (an emptied emptyOff key is saved empty)
  return k?.def ? "default" : "unset";
}

export function readConfig(group?: Group) {
  return CONFIG_KEYS.filter(k => !group || k.group === group).map(k => {
    const v = cfg(k.key);
    return { key: k.key, group: k.group, label: k.label, doc: k.doc, type: k.type ?? "text", options: k.options, advanced: !!k.advanced, secret: !!k.secret, showIf: k.showIf, source: configSource(k.key), value: k.secret ? (v ? "••••••••" : "") : v };
  });
}

/**
 * Save settings: only known keys; an empty string clears the saved value (env still wins) — or, for a key whose feature
 * an empty value turns off (emptyOff), is saved as such, and its default clears it; a redacted secret is left alone.
 * Combinations that would do nothing are refused or completed: Basic auth needs a username and a password; a username
 * and password with authentication off turn it on.
 */
export function writeConfig(patch: Record<string, unknown>): { rejected: string[]; changed: string[]; errors: string[] } {
  const rejected: string[] = [], changed: string[] = [], errors: string[] = [];
  const next = (key: string) => (key in patch ? norm(patch[key], BY_KEY.get(key)) : cfg(key));
  const norm = (raw: unknown, k?: ConfigKey) => { const v = raw === true ? "1" : raw === false ? "0" : String(raw ?? "").trim(); return k?.secret && v === "••••••••" ? cfg(k.key) : v; };
  for (const key of Object.keys(patch)) if (!BY_KEY.has(key)) rejected.push(key);
  if ("LUDARR_STAGING" in patch && next("LUDARR_STAGING") !== cfg("LUDARR_STAGING")) {
    const p = next("LUDARR_STAGING");
    if (db.query("SELECT 1 FROM jobs WHERE state IN ('queued','running') UNION ALL SELECT 1 FROM fetches WHERE state='pulling' LIMIT 1").get()) errors.push("Change the staging folder after current imports and transfers finish");
    if (p) try {
      if (!isAbsolute(p) || resolve(p) === parse(resolve(p)).root || !statSync(p).isDirectory()) throw new Error();
      for (const dir of ["downloads", "work"]) prepareStage(p, dir);
    } catch { errors.push("Select an existing writable staging folder using its absolute path inside Ludarr"); }
  }
  // validation across keys
  const method = next("AUTH_METHOD");
  if (method === "basic" && (!next("AUTH_USERNAME") || !next("AUTH_PASSWORD"))) errors.push("Basic authentication needs both a username and a password");
  if (!(method === "none" || method === "basic")) errors.push("Authentication must be none or basic");
  for (const k of CONFIG_KEYS) if (k.type === "number" && k.key in patch && norm(patch[k.key], k) !== "" && !Number.isFinite(Number(norm(patch[k.key], k)))) errors.push(`${k.label} must be a number`);
  if (errors.length) return { rejected, changed, errors };
  // a username + password saved while authentication is off: the user means to turn it on
  if (!("AUTH_METHOD" in patch) && method === "none" && ("AUTH_USERNAME" in patch || "AUTH_PASSWORD" in patch) && next("AUTH_USERNAME") && next("AUTH_PASSWORD")) patch = { ...patch, AUTH_METHOD: "basic" };
  for (const [key, raw] of Object.entries(patch)) {
    const k = BY_KEY.get(key);
    if (!k) continue;
    const v = raw === true ? "1" : raw === false ? "0" : String(raw ?? "").trim();
    if (k.secret && v === "••••••••") continue;
    const want = k.emptyOff ? (v === (k.def ?? "") ? null : v) : v || null;      // null: nothing saved (the default)
    if (want === saved(key)) continue;
    if (key === "LUDARR_STAGING" && stagingDir()) {
      const saved = new Set(stagingHistory());
      saved.add(join(stagingDir(), "downloads"));
      kv.set("media.staging.history", JSON.stringify([...saved]));
    }
    if (want != null) kv.set("cfg." + key, want); else { kv.del("cfg." + key); const old = formerKey(key); if (old) kv.del("cfg." + old); }
    changed.push(key);
  }
  return { rejected, changed, errors };
}

/* ─────────── paths ─────────── */

/** <config>: database, plugins, backups, logs. /config in Docker. */
export const configDir = () => process.env.LUDARR_CONFIG || process.env.CONFIG_DIR || ".";
function prepareStage(root: string, child: string) {
  const p = join(root, child);
  try { mkdirSync(p); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  if (!statSync(p).isDirectory()) throw new Error(`${p} must be a directory`);
  accessSync(p, constants.W_OK);
  return p;
}
export const stagingDir = () => cfg("LUDARR_STAGING");
export function stagingHistory(): string[] { return JSON.parse(kv.get("media.staging.history") ?? "[]"); }
export const defaultDownloadsDir = () => cfg("LUDARR_DOWNLOADS") || "./downloads";
export const downloadsDir = () => stagingDir() ? prepareStage(stagingDir(), "downloads") : defaultDownloadsDir();
/** empty means "inside the root folder" — see library/rootfolders.ts */
export const workDir = () => stagingDir() ? prepareStage(stagingDir(), "work") : cfg("LUDARR_WORK");
/** the finished-downloads folder as set, its trailing separators cut ("" when it is not set: off — src/synced.ts says whether
 *  it is on, a folder there) */
export const arrivalsSetting = (): string => cfg("LUDARR_ARRIVALS").trim().replace(/[\\/]+$/, "");

/* ─────────── host secrets kept out of the editable list ─────────── */

export function apiKey(): string {
  let k = kv.get("host.apiKey");
  if (!k) { k = crypto.randomUUID().replace(/-/g, ""); kv.set("host.apiKey", k); }
  return k;
}
export function resetApiKey(): string { const k = crypto.randomUUID().replace(/-/g, ""); kv.set("host.apiKey", k); return k; }
