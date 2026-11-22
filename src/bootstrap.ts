/**
 * ludarr — first boot and upgrades from Ahoy: an existing ahoy.env (PROWLARR_*, SEEDBOX_SSH_*, RTORRENT_*,
 * NZBGET_*, ANTHROPIC_*) becomes plugin instances once, so nothing has to be typed again; root folder and
 * profile defaults are created; games that came over keep their copies. First of all <config> is made root's alone.
 */
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { databaseFile, db, kv, stmts, type GameRow, type PackageRow } from "./db";
import { FORMER, formerName } from "./former";
import { logger } from "./log";
import * as registry from "./plugins/registry";
import { ensureDefaultRootFolder, rootFolders } from "./library/rootfolders";
import { ensureDefaultProfile, profiles } from "./library/profiles";
import { splitLogin } from "./plugins/builtin/clients";
import { configDir } from "./config";

const log = logger("Bootstrap");
const env = (k: string) => process.env[k] ?? "";
const ints = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean).join(",");

/**
 * <config> holds every key and password ludarr has (the database, its daily backups, ludarr.env), and programs
 * from other people's repos run on this machine as the build user (src/ways/sandbox.ts): so <config> is 0700 and
 * those files 0600, root's alone. The folder itself only when it was named (LUDARR_CONFIG / CONFIG_DIR — /config in
 * Docker), never a dev box's working folder. Nothing to do on Windows. Returns what it changed.
 */
export function lockConfig(dir = configDir(), dbFile = process.env.DB_PATH || databaseFile(configDir())): string[] {
  if (process.platform === "win32") return [];
  const done: string[] = [];
  const mode = (p: string, m: number) => { try { if (existsSync(p)) { chmodSync(p, m); done.push(p); } } catch (e: any) { log.warn(`could not make ${p} private: ${e?.message ?? e}`); } };
  if (process.env.LUDARR_CONFIG || process.env.CONFIG_DIR || dir !== configDir()) mode(dir, 0o700);
  if (dbFile && dbFile !== ":memory:") for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) mode(f, 0o600);
  for (const n of ["ludarr.env", formerName("ludarr.env")]) mode(join(dir, n), 0o600);
  const backups = join(dir, "backups");
  mode(backups, 0o700);
  for (const n of (() => { try { return readdirSync(backups); } catch { return [] as string[]; } })()) mode(join(backups, n), 0o600);
  return done;
}

/**
 * Download clients set up under the engine's old name relied on its default label and category. Those are written into
 * their settings once, so the renamed engine stamps its grabs as before; a client made from now on gets the new default.
 */
export function pinFormerDefaults(): number {
  if (kv.get("former.labels-pinned")) return 0;
  const fields: Record<string, string[]> = { seedbox: ["rtorrentLabel", "nzbgetCategory"], nzbget: ["category"], rtorrent: ["label"] };
  let pinned = 0;
  for (const r of registry.instanceRows("downloadClient")) {
    let s: Record<string, unknown>;
    try { s = JSON.parse(r.settings_json || "{}"); } catch { continue; }
    let changed = false;
    // absent: the default applied. Empty: the code fell back to the old name (not for rTorrent's own label, where empty means none)
    for (const f of fields[r.impl] ?? []) if (s[f] === undefined || (s[f] === "" && f !== "label")) { s[f] = FORMER; changed = true; }
    if (changed) { db.query("UPDATE plugin_instances SET settings_json=? WHERE id=?").run(JSON.stringify(s), r.id); pinned++; }
  }
  kv.set("former.labels-pinned", "1");
  if (pinned) log.info(`${pinned} download ${pinned === 1 ? "client keeps" : "clients keep"} the label and category they had before the rename`);
  return pinned;
}

export function bootstrap() {
  lockConfig();
  pinFormerDefaults();
  ensureDefaultRootFolder();
  ensureDefaultProfile();
  if (!kv.get("bootstrap.env-seeded")) { seedFromEnv(); kv.set("bootstrap.env-seeded", "1"); }
  moveTransferLogins();
  adoptGames();
}

/** a login written into a transfer URL (https://user:pass@box) moves into the user / password fields, where it is masked and never echoed */
export function moveTransferLogins(): number {
  let n = 0;
  for (const r of registry.instanceRows("downloadClient")) {
    let s: Record<string, unknown>;
    try { s = JSON.parse(r.settings_json); } catch { continue; }
    const raw = String(s.pullUrl ?? "");
    if (!/^[a-z]+:\/\/[^/]*@/i.test(raw)) continue;
    const { url, user, pass } = splitLogin(raw);
    registry.updateInstance(r.id, { settings: { pullUrl: url, pullUser: String(s.pullUser ?? "") || user, pullPass: String(s.pullPass ?? "") || pass } as never });
    log.info(`${r.name}: the transfer login moved out of the URL into its own fields`);
    n++;
  }
  return n;
}

/** environment → instances, once */
function seedFromEnv() {
  const made: string[] = [];
  const add = (kind: registry.InstanceRow["kind"], impl: string, name: string, settings: Record<string, unknown>, priority = 50) => {
    if (registry.instanceRows(kind).some(r => r.impl === impl)) return;
    try { registry.createInstance(kind, impl, { name, settings: settings as never, priority }); made.push(`${kind} ${name}`); }
    catch (e: any) { log.warn(`could not create ${name} from the environment: ${e?.message ?? e}`); }
  };
  if (env("PROWLARR_URL") && env("PROWLARR_API_KEY"))
    add("indexer", "prowlarr", "Prowlarr", { url: env("PROWLARR_URL"), apiKey: env("PROWLARR_API_KEY"), categories: ints(env("PROWLARR_CATEGORIES") || "4000"), indexerIds: ints(env("PROWLARR_INDEXERS")) });
  if (env("SEEDBOX_SSH_HOST")) {
    // an Ahoy install already runs the connector on this box with its own config: use the same values so the two never restart it on each other
    add("downloadClient", "seedbox", "Seedbox", {
      sshHost: env("SEEDBOX_SSH_HOST"), sshPort: Number(env("SEEDBOX_SSH_PORT") || 22), sshUser: env("SEEDBOX_SSH_USER"), sshPass: env("SEEDBOX_SSH_PASS"), sshKey: env("SEEDBOX_SSH_KEY"),
      webUser: env("SEEDBOX_WEB_USER") || env("RTORRENT_USER"), webPass: env("SEEDBOX_WEB_PASS") || env("RTORRENT_PASS"),
      rtorrentLabel: env("RTORRENT_LABEL") || "ahoy", rtorrentDir: env("RTORRENT_DIR"), nzbgetCategory: env("NZBGET_CATEGORY") || "ahoy",
      nzbgetUrl: env("NZBGET_URL"), nzbgetUser: env("NZBGET_USER"), nzbgetPass: env("NZBGET_PASS"), port: Number(env("BOSUN_PORT") || 17867), binary: env("BOSUN_BINARY"),
    }, 10);
  } else {
    const pull = splitLogin(env("SEEDBOX_PULL_URL"));
    const transfer = { pullUrl: pull.url, pullUser: pull.user, pullPass: pull.pass, pathStrip: env("SEEDBOX_PATH_STRIP"), verifyTls: env("SEEDBOX_PULL_VERIFY_TLS") !== "0" };
    if (env("RTORRENT_URL")) add("downloadClient", "rtorrent", "rTorrent", { url: env("RTORRENT_URL"), user: env("RTORRENT_USER"), pass: env("RTORRENT_PASS"), label: env("RTORRENT_LABEL") || "ludarr", dir: env("RTORRENT_DIR"), ...transfer });
    if (env("NZBGET_URL")) add("downloadClient", "nzbget", "NZBGet", { url: env("NZBGET_URL"), user: env("NZBGET_USER"), pass: env("NZBGET_PASS"), category: env("NZBGET_CATEGORY") || "ludarr", ...transfer });
  }
  if (env("ANTHROPIC_API_KEY")) {
    const agent = registry.instanceRows("importer").find(r => r.impl === "agent");
    if (agent) { registry.updateInstance(agent.id, { settings: { apiKey: env("ANTHROPIC_API_KEY"), baseUrl: env("ANTHROPIC_BASE_URL") || "https://api.anthropic.com", model: env("AGENT_MODEL") || "claude-opus-5-5", maxTurns: Number(env("AGENT_MAX_TURNS") || 60), maxMinutes: Number(env("AGENT_MAX_MINUTES") || 120) } }); made.push("importer AI (key from the environment)"); }
  }
  if (env("IGDB_CLIENT_ID") && env("IGDB_CLIENT_SECRET")) {
    const igdb = registry.instanceRows("metadata").find(r => r.impl === "igdb");
    if (igdb) { registry.updateInstance(igdb.id, { settings: { clientId: env("IGDB_CLIENT_ID"), clientSecret: env("IGDB_CLIENT_SECRET") } }); made.push("metadata IGDB"); }
  }
  // the AI importer stays disabled until it has a key, so a missing key reads as "not configured" rather than failing imports
  const agent = registry.instanceRows("importer").find(r => r.impl === "agent");
  if (agent) { let key = ""; try { key = JSON.parse(agent.settings_json).apiKey ?? ""; } catch { /* none */ } if (!key) registry.updateInstance(agent.id, { enabled: false }); }
  if (made.length) log.info(`created from the environment: ${made.join(", ")}`);
}

/** games from Ahoy: monitored, on the first profile and root folder, with their imported copy as path */
function adoptGames() {
  const root = rootFolders()[0];
  const prof = profiles()[0];
  const rows = db.query("SELECT * FROM games WHERE added_at IS NULL").all() as GameRow[];
  for (const g of rows) {
    stmts.setGameAdded.run(1, prof?.id ?? null, root?.id ?? null, g.id);
    const pkg = stmts.packageForGame.get(g.id) as PackageRow | undefined;
    if (pkg) stmts.setGamePath.run(pkg.path, g.id);
  }
  if (rows.length) log.info(`adopted ${rows.length} game${rows.length === 1 ? "" : "s"} into the library`);
}
