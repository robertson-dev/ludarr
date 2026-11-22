/**
 * ludarr — plugin registry: which definitions exist (from built-in and external plugins) and which
 * instances the user configured. Instances live in `plugin_instances`; created objects are cached until
 * their settings change. Metadata / importer / runtime definitions are singletons and get their row
 * automatically, so a new built-in or plugin shows up in Settings without any clicking.
 */
import { db, kv } from "../db";
import { cfg, configDir, downloadsDir, workDir } from "../config";
import { logger } from "../log";
import {
  definitionsOf, KINDS, SINGLETON_KINDS, type Definition, type DownloadClient, type Field, type Importer, type Indexer, type Kind,
  type MetadataSource, type Notifier, type LudarrPlugin, type PluginContext, type Settings, type TestResult,
} from "./types";

db.exec(`
CREATE TABLE IF NOT EXISTS plugin_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  impl TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 50,
  settings_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_plugin_instances_kind ON plugin_instances(kind, priority);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT, version TEXT, description TEXT, author TEXT,
  source TEXT NOT NULL,                -- builtin | <folder>
  enabled INTEGER NOT NULL DEFAULT 1,
  definitions_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  loaded_at INTEGER
);`);

export interface InstanceRow { id: number; kind: Kind; impl: string; name: string; enabled: number; priority: number; settings_json: string; tags_json: string; created_at: number; updated_at: number }
export interface PluginRow { id: string; name: string | null; version: string | null; description: string | null; author: string | null; source: string; enabled: number; definitions_json: string; error: string | null; loaded_at: number | null }

const q = {
  all: db.query("SELECT * FROM plugin_instances ORDER BY kind, priority, id"),
  byKind: db.query("SELECT * FROM plugin_instances WHERE kind=? ORDER BY priority, id"),
  byId: db.query("SELECT * FROM plugin_instances WHERE id=?"),
  byImpl: db.query("SELECT * FROM plugin_instances WHERE kind=? AND impl=?"),
  insert: db.query("INSERT INTO plugin_instances (kind, impl, name, enabled, priority, settings_json, tags_json) VALUES (?,?,?,?,?,?,?) RETURNING *"),
  update: db.query("UPDATE plugin_instances SET name=?, enabled=?, priority=?, settings_json=?, tags_json=?, updated_at=unixepoch() WHERE id=? RETURNING *"),
  del: db.query("DELETE FROM plugin_instances WHERE id=?"),
  upsertPlugin: db.query(`INSERT INTO plugins (id, name, version, description, author, source, definitions_json, error, loaded_at) VALUES (?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, description=excluded.description, author=excluded.author, source=excluded.source,
      definitions_json=excluded.definitions_json, error=excluded.error, loaded_at=unixepoch()`),
  plugins: db.query("SELECT * FROM plugins ORDER BY source='builtin' DESC, id"),
  plugin: db.query("SELECT * FROM plugins WHERE id=?"),
  setPluginEnabled: db.query("UPDATE plugins SET enabled=? WHERE id=?"),
  setPluginError: db.query("UPDATE plugins SET error=? WHERE id=?"),
};

const log = logger("Plugins");
const definitions = new Map<Kind, Map<string, { def: Definition; plugin: string }>>(KINDS.map(k => [k, new Map()]));
const cache = new Map<number, { key: string; obj: unknown }>();
let order = 0;
const registrationOrder = new Map<string, number>();     // "kind:impl" → order of registration, for singleton priority

export class PluginError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

/* ─────────── definitions ─────────── */

export function registerPlugin(p: LudarrPlugin, source: string) {
  const defs = definitionsOf(p);
  for (const d of defs) {
    const map = definitions.get(d.kind)!;
    if (map.has(d.impl) && map.get(d.impl)!.plugin !== p.id) log.warn(`${p.id}: ${d.kind} "${d.impl}" is already provided by ${map.get(d.impl)!.plugin}; overriding`);
    map.set(d.impl, { def: d, plugin: p.id });
    if (!registrationOrder.has(`${d.kind}:${d.impl}`)) registrationOrder.set(`${d.kind}:${d.impl}`, ++order);
  }
  q.upsertPlugin.run(p.id, p.name, p.version, p.description ?? null, p.author ?? null, source, JSON.stringify(defs.map(d => ({ kind: d.kind, impl: d.impl, name: d.name }))), null);
}
export function recordPluginFailure(id: string, source: string, error: string) {
  q.upsertPlugin.run(id, null, null, null, null, source, "[]", error);
}

export function definition(kind: Kind, impl: string): Definition | undefined { return definitions.get(kind)?.get(impl)?.def; }
export function definitionsFor(kind: Kind) { return [...definitions.get(kind)!.values()].map(x => ({ ...x.def, plugin: x.plugin })); }
export const pluginRows = () => q.plugins.all() as PluginRow[];
export const pluginRow = (id: string) => q.plugin.get(id) as PluginRow | undefined;
export const setPluginEnabled = (id: string, on: boolean) => q.setPluginEnabled.run(on ? 1 : 0, id);
export const pluginEnabled = (id: string) => (pluginRow(id)?.enabled ?? 1) === 1;

/* ─────────── settings helpers ─────────── */

export function withDefaults(fields: Field[], s: Settings): Settings {
  const out: Settings = {};
  for (const f of fields) {
    const v = s[f.name];
    // a default fills a field that was never set; a field the user emptied stays empty (for text that is a meaning of its own: "no filter", "no label")
    const unset = v === undefined || v === null || (v === "" && !["text", "url", "textarea", "path"].includes(f.type));
    out[f.name] = unset ? (f.default as Settings[string]) ?? (f.type === "checkbox" ? false : f.type === "tags" ? [] : "") : v;
    if (f.type === "number" && typeof out[f.name] === "string") out[f.name] = Number(out[f.name]);
    if (f.type === "checkbox" && typeof out[f.name] === "string") out[f.name] = ["1", "true", "on", "yes"].includes(String(out[f.name]).toLowerCase());
  }
  return out;
}
export function validate(fields: Field[], s: Settings): string[] {
  const problems: string[] = [];
  for (const f of fields) {
    const v = s[f.name];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (f.required && empty && f.default === undefined) problems.push(`${f.label} is required`);
    if (f.type === "number" && !empty && !Number.isFinite(Number(v))) problems.push(`${f.label} must be a number`);
    if (f.type === "url" && !empty && !/^https?:\/\//i.test(String(v))) problems.push(`${f.label} must start with http:// or https://`);
  }
  return problems;
}
/** secrets are never sent to the UI as such; a masked value coming back means "unchanged" */
export const MASK = "••••••••";
export function redact(fields: Field[], s: Settings): Settings {
  const out = { ...s };
  for (const f of fields) if (f.type === "password" && out[f.name]) out[f.name] = MASK;
  return out;
}
function unmask(fields: Field[], incoming: Settings, current: Settings): Settings {
  const out = { ...incoming };
  for (const f of fields) if (f.type === "password" && out[f.name] === MASK) out[f.name] = current[f.name];
  return out;
}

/* ─────────── instances ─────────── */

const parse = (s: string | null | undefined, fallback: unknown) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export function instanceRows(kind?: Kind): InstanceRow[] { return (kind ? q.byKind.all(kind) : q.all.all()) as InstanceRow[]; }
export function instanceRow(id: number): InstanceRow | undefined { return q.byId.get(id) as InstanceRow | undefined; }

export function serializeInstance(r: InstanceRow) {
  const d = definition(r.kind, r.impl);
  const settings = parse(r.settings_json, {}) as Settings;
  return {
    id: r.id, kind: r.kind, impl: r.impl, name: r.name, enabled: !!r.enabled, priority: r.priority,
    settings: d ? redact(d.fields, withDefaults(d.fields, settings)) : settings,
    tags: parse(r.tags_json, []) as string[], implName: d?.name ?? r.impl, missing: !d, pluginEnabled: d ? pluginEnabled(definitions.get(r.kind)!.get(r.impl)!.plugin) : false,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createInstance(kind: Kind, impl: string, body: { name?: string; enabled?: boolean; priority?: number; settings?: Settings; tags?: string[] }): InstanceRow {
  const d = definition(kind, impl);
  if (!d) throw new PluginError(`no ${kind} named "${impl}"`, 404);
  if (SINGLETON_KINDS.includes(kind) && q.byImpl.get(kind, impl)) throw new PluginError(`${d.name} already exists; it can only be configured`, 409);
  const settings = withDefaults(d.fields, body.settings ?? {});
  const problems = body.enabled === false ? [] : validate(d.fields, settings);     // a disabled instance may be incomplete
  if (problems.length) throw new PluginError(problems.join("; "));
  return q.insert.get(kind, impl, (body.name ?? d.name).trim() || d.name, body.enabled === false ? 0 : 1, body.priority ?? 50, JSON.stringify(settings), JSON.stringify(body.tags ?? [])) as InstanceRow;
}

export function updateInstance(id: number, body: { name?: string; enabled?: boolean; priority?: number; settings?: Settings; tags?: string[] }): InstanceRow {
  const r = instanceRow(id);
  if (!r) throw new PluginError("no such instance", 404);
  const d = definition(r.kind, r.impl);
  const current = parse(r.settings_json, {}) as Settings;
  const settings = d ? withDefaults(d.fields, unmask(d.fields, { ...current, ...(body.settings ?? {}) }, current)) : { ...current, ...(body.settings ?? {}) };
  const enabled = body.enabled === undefined ? !!r.enabled : body.enabled;
  const problems = d && enabled ? validate(d.fields, settings) : [];               // a disabled instance may be incomplete
  if (problems.length) throw new PluginError(problems.join("; "));
  cache.delete(id);
  return q.update.get(body.name?.trim() || r.name, body.enabled === undefined ? r.enabled : body.enabled ? 1 : 0, body.priority ?? r.priority,
    JSON.stringify(settings), JSON.stringify(body.tags ?? parse(r.tags_json, [])), id) as InstanceRow;
}

export function deleteInstance(id: number) {
  const r = instanceRow(id);
  if (!r) throw new PluginError("no such instance", 404);
  if (SINGLETON_KINDS.includes(r.kind)) throw new PluginError("built-in sources can be disabled, not deleted");
  cache.delete(id);
  q.del.run(id);
}

/** metadata / importer / runtime definitions get their single instance automatically */
export function ensureSingletons() {
  for (const kind of SINGLETON_KINDS) {
    for (const { def } of definitions.get(kind)!.values()) {
      if (q.byImpl.get(kind, def.impl)) continue;
      const priority = registrationOrder.get(`${kind}:${def.impl}`) ?? 50;
      q.insert.get(kind, def.impl, def.name, def.defaultEnabled === false ? 0 : 1, priority, JSON.stringify(withDefaults(def.fields, {})), "[]");
    }
  }
}

/* ─────────── created objects ─────────── */

export function pluginContext(pluginId: string, instanceId?: number): PluginContext {
  const prefix = `plugin.${pluginId}.${instanceId ?? "x"}.`;
  return {
    instanceId,
    store: { get: k => kv.get(prefix + k), set: (k, v) => kv.set(prefix + k, v), del: k => kv.del(prefix + k) },
    log: logger(`Plugin:${pluginId}`),
    fetch,
    // read when used, not when the instance is built: a folder changed in Settings applies to the next transfer
    paths: { get config() { return configDir(); }, get downloads() { return downloadsDir(); }, get work() { return workDir(); }, get rootFolders() { return rootFolderPaths(); } },
    config: cfg,
  };
}
/** set by rootfolders.ts once it is loaded (avoids a circular import) */
let rootFolderPaths: () => string[] = () => [];
export function provideRootFolders(fn: () => string[]) { rootFolderPaths = fn; }

function build<T>(r: InstanceRow): T {
  const entry = definitions.get(r.kind)!.get(r.impl);
  if (!entry) throw new PluginError(`${r.kind} "${r.impl}" (${r.name}) is not available — its plugin is missing`, 500);
  const key = `${r.settings_json}|${r.updated_at}`;
  const hit = cache.get(r.id);
  if (hit && hit.key === key) return hit.obj as T;
  const d = entry.def as Exclude<Definition, { kind: "runtime" }>;
  const settings = withDefaults(d.fields, parse(r.settings_json, {}) as Settings);
  const obj = d.create(settings, pluginContext(entry.plugin, r.id));
  cache.set(r.id, { key, obj });
  return obj as T;
}
const enabledRows = (kind: Kind) => instanceRows(kind).filter(r => r.enabled && definitions.get(kind)!.has(r.impl) && pluginEnabled(definitions.get(kind)!.get(r.impl)!.plugin));

export const indexers = () => enabledRows("indexer").map(r => ({ row: r, indexer: build<Indexer>(r) }));
export const downloadClients = () => enabledRows("downloadClient").map(r => ({ row: r, client: build<DownloadClient>(r), protocols: (definition("downloadClient", r.impl) as { protocols: string[] }).protocols }));
export const metadataSources = () => enabledRows("metadata").map(r => ({ row: r, source: build<MetadataSource>(r) }));
export const importers = () => enabledRows("importer").map(r => ({ row: r, importer: build<Importer>(r) }));
export const notifiers = () => enabledRows("notification").map(r => ({ row: r, notifier: build<Notifier>(r) }));
export function runtimeInputs() {
  const out = [];
  for (const r of enabledRows("runtime")) {
    const entry = definitions.get("runtime")!.get(r.impl)!;
    const d = entry.def as Extract<Definition, { kind: "runtime" }>;
    out.push(...d.runtimes(withDefaults(d.fields, parse(r.settings_json, {}) as Settings), pluginContext(entry.plugin, r.id)));
  }
  return out;
}
export function indexerById(id: number): Indexer | null { const r = instanceRow(id); return r && r.kind === "indexer" ? build<Indexer>(r) : null; }
export function downloadClientById(id: number): DownloadClient | null { const r = instanceRow(id); return r && r.kind === "downloadClient" ? build<DownloadClient>(r) : null; }

/** try a definition with (unsaved) settings, or a saved instance */
export async function testSettings(kind: Kind, impl: string, settings: Settings, instanceId?: number): Promise<TestResult> {
  const entry = definitions.get(kind)!.get(impl);
  if (!entry) throw new PluginError(`no ${kind} named "${impl}"`, 404);
  const d = entry.def;
  if (d.kind === "runtime") return { ok: true, detail: `${d.runtimes(withDefaults(d.fields, settings), pluginContext(entry.plugin)).length} runtimes` };
  const current = instanceId ? (parse(instanceRow(instanceId)?.settings_json, {}) as Settings) : {};
  const merged = withDefaults(d.fields, unmask(d.fields, { ...current, ...settings }, current));
  const problems = validate(d.fields, merged);
  if (problems.length) return { ok: false, detail: problems.join("; ") };
  const obj = d.create(merged, pluginContext(entry.plugin, instanceId)) as { test?: () => Promise<TestResult> };
  if (!obj.test) return { ok: true, detail: "nothing to test" };
  try { return await obj.test(); } catch (e: any) { return { ok: false, detail: String(e?.message ?? e) }; }
}

export function clearCache() { cache.clear(); }
