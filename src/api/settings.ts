/**
 * ludarr API — settings.
 *
 *   GET    /api/v1/config[?group=host|media|search|import|catalog]   global settings with their source
 *   PUT    /api/v1/config                     { KEY: value, … }
 *   GET    /api/v1/config/host                api key, auth, version
 *   POST   /api/v1/config/apikey              rotate the API key
 *
 *   GET    /api/v1/{indexer|downloadclient|metadata|importer|runtime|notification}            instances
 *   GET    /api/v1/{kind}/schema               definitions (what can be added) with their fields
 *   POST   /api/v1/{kind}                      { impl, name, enabled, priority, settings, tags }
 *   PUT    /api/v1/{kind}/:id                  same body, partial
 *   DELETE /api/v1/{kind}/:id
 *   POST   /api/v1/{kind}/test                 { impl, settings, id? } → { ok, detail }
 *   POST   /api/v1/{kind}/:id/test
 *
 *   GET/POST/PUT/DELETE /api/v1/profile[/:id]       GET /api/v1/profile/schema (formats, kinds, protocols)
 *   GET/POST/DELETE     /api/v1/rootfolder[/:id]        GET /api/v1/rootfolder/:id/unmapped  folders no game accounts for
 *   GET    /api/v1/plugin                      loaded plugins and their state;  PUT /api/v1/plugin/:id { enabled }
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiKey, cfg, readConfig, resetApiKey, writeConfig, type Group } from "../config";
import { setLogLevel, type Level } from "../log";
import * as registry from "../plugins/registry";
import { KINDS, type Kind, type Settings } from "../plugins/types";
import { createProfile, deleteProfile, INSTALL_CLASSES, profiles, updateProfile, ProfileError } from "../library/profiles";
import { addRootFolder, removeRootFolder, rootFolders, serializeRootFolder, RootFolderError } from "../library/rootfolders";
import { unmappedFolders } from "../library/rescan";
import { readyClients } from "../fetch";
import { VERSION } from "../version";

export const settingsApi = new Hono();
const status = (e: unknown): ContentfulStatusCode => (e instanceof registry.PluginError || e instanceof ProfileError || e instanceof RootFolderError ? (e.status as ContentfulStatusCode) : 500);
const fail = (c: any, e: any) => c.json({ error: String(e?.message ?? e) }, status(e));

/* ─────────── global settings ─────────── */

settingsApi.get("/api/v1/config", c => c.json({ config: readConfig((c.req.query("group") as Group) || undefined) }));
settingsApi.put("/api/v1/config", async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const r = writeConfig(body);
  if (r.errors.length) return c.json({ ...r, config: readConfig() }, 400);
  if (r.changed.includes("LOG_LEVEL")) setLogLevel(cfg("LOG_LEVEL") as Level);
  return c.json({ ...r, config: readConfig() });
});
settingsApi.get("/api/v1/config/host", c => c.json({ apiKey: apiKey(), authMethod: cfg("AUTH_METHOD") || "none", port: cfg("PORT"), version: VERSION }));
settingsApi.post("/api/v1/config/apikey", c => c.json({ apiKey: resetApiKey() }));

/* ─────────── plugin instances: one set of routes per kind ─────────── */

const ROUTES: [string, Kind][] = [["indexer", "indexer"], ["downloadclient", "downloadClient"], ["metadata", "metadata"], ["importer", "importer"], ["runtime", "runtime"], ["notification", "notification"]];
type InstanceBody = { impl: string; name?: string; enabled?: boolean; priority?: number; settings?: Settings; tags?: string[]; id?: number };
const emptyBody = (): InstanceBody => ({ impl: "" });

for (const [route, kind] of ROUTES) {
  settingsApi.get(`/api/v1/${route}/schema`, c => c.json({ definitions: registry.definitionsFor(kind).map(d => ({ impl: d.impl, name: d.name, description: d.description ?? null, fields: d.fields, infoLink: d.infoLink ?? null, plugin: d.plugin, protocols: (d as { protocols?: string[] }).protocols ?? null })) }));
  settingsApi.get(`/api/v1/${route}`, c => c.json({ items: registry.instanceRows(kind).map(registry.serializeInstance) }));
  settingsApi.post(`/api/v1/${route}/test`, async c => {
    const body = await c.req.json<InstanceBody>().catch(emptyBody);
    try { return c.json(await registry.testSettings(kind, body.impl, body.settings ?? {}, body.id)); } catch (e) { return fail(c, e); }
  });
  settingsApi.post(`/api/v1/${route}`, async c => {
    const body = await c.req.json<InstanceBody>().catch(emptyBody);
    try { const r = registry.createInstance(kind, body.impl, body); afterChange(kind); return c.json({ item: registry.serializeInstance(r) }, 201); } catch (e) { return fail(c, e); }
  });
  settingsApi.post(`/api/v1/${route}/:id/test`, async c => {
    const r = registry.instanceRow(Number(c.req.param("id")));
    if (!r || r.kind !== kind) return c.json({ error: "not found" }, 404);
    try { return c.json(await registry.testSettings(kind, r.impl, {}, r.id)); } catch (e) { return fail(c, e); }
  });
  settingsApi.put(`/api/v1/${route}/:id`, async c => {
    const body = await c.req.json<InstanceBody>().catch(emptyBody);
    try { const r = registry.updateInstance(Number(c.req.param("id")), body); afterChange(kind); return c.json({ item: registry.serializeInstance(r) }); } catch (e) { return fail(c, e); }
  });
  settingsApi.delete(`/api/v1/${route}/:id`, c => {
    try { registry.deleteInstance(Number(c.req.param("id"))); afterChange(kind); return c.json({ deleted: Number(c.req.param("id")) }); } catch (e) { return fail(c, e); }
  });
}
function afterChange(kind: Kind) { if (kind === "downloadClient") readyClients(); }

/* ─────────── profiles ─────────── */

settingsApi.get("/api/v1/profile/schema", c => c.json({ formats: INSTALL_CLASSES, kinds: ["native", "recomp", "port", "emulated"], protocols: ["any", "prefer-usenet", "prefer-torrent", "usenet", "torrent"] }));
settingsApi.get("/api/v1/profile", c => c.json({ items: profiles() }));
settingsApi.post("/api/v1/profile", async c => { try { return c.json({ item: createProfile(await c.req.json()) }, 201); } catch (e) { return fail(c, e); } });
settingsApi.put("/api/v1/profile/:id", async c => { try { return c.json({ item: updateProfile(Number(c.req.param("id")), await c.req.json()) }); } catch (e) { return fail(c, e); } });
settingsApi.delete("/api/v1/profile/:id", c => { try { deleteProfile(Number(c.req.param("id"))); return c.json({ deleted: Number(c.req.param("id")) }); } catch (e) { return fail(c, e); } });

/* ─────────── root folders ─────────── */

settingsApi.get("/api/v1/rootfolder", async c => c.json({ items: await Promise.all(rootFolders().map(serializeRootFolder)) }));
settingsApi.post("/api/v1/rootfolder", async c => {
  const body = await c.req.json<{ path?: string; name?: string }>().catch(() => ({} as { path?: string; name?: string }));
  try { return c.json({ item: await serializeRootFolder(addRootFolder(String(body.path ?? ""), body.name)) }, 201); } catch (e) { return fail(c, e); }
});
settingsApi.get("/api/v1/rootfolder/:id/unmapped", async c => {
  const r = rootFolders().find(x => x.id === Number(c.req.param("id")));
  return r ? c.json({ items: await unmappedFolders(r) }) : c.json({ error: "no such root folder" }, 404);
});
settingsApi.delete("/api/v1/rootfolder/:id", c => { try { removeRootFolder(Number(c.req.param("id"))); return c.json({ deleted: Number(c.req.param("id")) }); } catch (e) { return fail(c, e); } });

/* ─────────── plugins ─────────── */

settingsApi.get("/api/v1/plugin", c => c.json({
  items: registry.pluginRows().map(p => ({ id: p.id, name: p.name, version: p.version, description: p.description, author: p.author, source: p.source, builtin: p.source === "builtin", enabled: !!p.enabled, error: p.error, loadedAt: p.loaded_at, definitions: JSON.parse(p.definitions_json) })),
  folder: `${cfg("LUDARR_CONFIG") || process.env.LUDARR_CONFIG || "."}/plugins`, api: 1, kinds: KINDS,
}));
settingsApi.put("/api/v1/plugin/:id", async c => {
  const id = c.req.param("id");
  if (!registry.pluginRow(id)) return c.json({ error: "no such plugin" }, 404);
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));
  if (body.enabled !== undefined) { registry.setPluginEnabled(id, body.enabled); registry.clearCache(); }
  return c.json({ item: registry.pluginRow(id) });
});
