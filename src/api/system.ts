/**
 * ludarr API — system.
 *
 *   GET  /api/v1/system/status       version, uptime, paths, counts
 *   GET  /api/v1/health              [{ type, source, message, link }]
 *   GET  /api/v1/system/task         scheduled tasks;   POST /api/v1/system/task/:name   run now
 *   GET  /api/v1/log?level=&logger=&limit=&before=
 *   GET  /api/v1/system/backup       list;  POST /api/v1/system/backup   make one;  DELETE /api/v1/system/backup/:name
 *   GET  /api/v1/system/events       Server-Sent Events: request | job | package | fetch | follow | catalog | log
 */
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { db, stmts } from "../db";
import { configDir, downloadsDir } from "../config";
import { logger, onLog, recentLogs, type Level } from "../log";
import { events } from "../events";
import { healthChecks } from "../health";
import { listTasks, runTask } from "../tasks";
import { rootFolders } from "../library/rootfolders";
import { activeJobs } from "../process/runner";
import { activePulls } from "../fetch";
import { VERSION } from "../version";
import { FORMER } from "../former";

export const systemApi = new Hono();
const log = logger("System");
const started = Date.now();

systemApi.get("/api/v1/system/status", c => c.json({
  appName: "ludarr", version: VERSION, startTime: new Date(started).toISOString(), uptime: Math.round((Date.now() - started) / 1000),
  runtime: `bun ${Bun.version}`, os: process.platform, arch: process.arch, docker: !!process.env.LUDARR_CONFIG,
  paths: { config: configDir(), downloads: downloadsDir(), rootFolders: rootFolders().map(r => r.path) },
  counts: {
    games: (db.query("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n,
    imported: (db.query("SELECT COUNT(DISTINCT game_id) AS n FROM packages").get() as { n: number }).n,
    missing: (stmts.gamesMonitoredMissing.all() as unknown[]).length,
    queue: (stmts.requestsActive.all() as unknown[]).length, imports: activeJobs(), transfers: activePulls(),
    catalogTitles: (db.query("SELECT COUNT(*) AS n FROM titles").get() as { n: number }).n,
  },
}));

systemApi.get("/api/v1/health", async c => c.json({ items: await healthChecks(c.req.query("force") === "1") }));

systemApi.get("/api/v1/system/task", c => c.json({ items: listTasks() }));
systemApi.post("/api/v1/system/task/:name", async c => {
  try { const r = await runTask(c.req.param("name")); return c.json(r, r.ok ? 200 : 500); }
  catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 404); }
});

systemApi.get("/api/v1/log", c => c.json({ items: recentLogs({ level: (c.req.query("level") as Level) || undefined, logger: c.req.query("logger") || undefined, limit: Number(c.req.query("limit") ?? 200), before: c.req.query("before") ? Number(c.req.query("before")) : undefined }) }));

/* ─────────── backups ─────────── */

const backupDir = () => join(configDir(), "backups");
/** a backup is a full copy of the database, keys and passwords included: the folder is root's alone (0700), each file 0600 */
async function backupFolder() {
  await mkdir(backupDir(), { recursive: true });
  await chmod(backupDir(), 0o700).catch(() => { /* Windows: no such modes */ });
}
/** a backup's name; the ones made under the engine's old name are listed and thinned out with the rest */
const BACKUP_NAME = new RegExp(`^(ludarr|${FORMER})-.*\\.db$`);
async function listBackups() {
  await backupFolder();
  const out = [];
  for (const name of await readdir(backupDir())) {
    if (!BACKUP_NAME.test(name)) continue;
    const s = await stat(join(backupDir(), name));
    out.push({ name, size: s.size, at: Math.floor(s.mtimeMs / 1000) });
  }
  return out.sort((a, b) => b.at - a.at);
}
export async function makeBackup(keep = 7): Promise<string> {
  await backupFolder();
  const name = `ludarr-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.db`;
  db.exec(`VACUUM INTO '${join(backupDir(), name).replace(/'/g, "''")}'`);
  await chmod(join(backupDir(), name), 0o600).catch(() => { /* Windows: no such modes */ });
  for (const b of (await listBackups()).slice(keep)) await rm(join(backupDir(), b.name), { force: true });
  log.info(`backup written: ${name}`);
  return name;
}
systemApi.get("/api/v1/system/backup", async c => c.json({ items: await listBackups(), folder: backupDir() }));
systemApi.post("/api/v1/system/backup", async c => { try { return c.json({ name: await makeBackup() }, 201); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 500); } });
systemApi.delete("/api/v1/system/backup/:name", async c => {
  const name = c.req.param("name");
  if (!/^ludarr-[\w.-]+\.db$/.test(name)) return c.json({ error: "no such backup" }, 404);
  await rm(join(backupDir(), name), { force: true });
  return c.json({ deleted: name });
});

/* ─────────── live events ─────────── */

/** The admin uses WebSockets so its live updates do not fill the browser's six HTTP/1 connections.
 * The SSE route below remains available to Ahoy and older clients. Authentication runs in server.ts. */
systemApi.get("/api/v1/system/live", (c, next) => {
  const origin = c.req.header("origin");
  if (origin) {
    try {
      const u = new URL(origin);
      if (!["http:", "https:"].includes(u.protocol) || u.host !== c.req.header("host"))
        return c.json({ error: "cross-origin live updates are not allowed" }, 403);
    } catch { return c.json({ error: "invalid origin" }, 403); }
  }
  return next();
}, upgradeWebSocket(() => {
  let off: (() => void)[] = [];
  const cleanup = () => { for (const f of off) f(); off = []; };
  return {
    onOpen(_event, ws) {
      const send = (event: string, data: unknown) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ event, data }));
      };
      send("hello", { version: VERSION, at: Date.now() });
      off.push(events.subscribe(e => send(e.event, e.data)));
      off.push(onLog(l => { if (l.level !== "debug") send("log", l); }));
      const ping = setInterval(() => send("ping", Date.now()), 25_000);
      off.push(() => clearInterval(ping));
    },
    onClose: cleanup,
    onError: cleanup,
  };
}));

systemApi.get("/api/v1/system/events", c => {
  const enc = new TextEncoder();
  let off: (() => void)[] = [];
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => { try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ } };
      send("hello", { version: VERSION, at: Date.now() });
      off.push(events.subscribe(e => send(e.event, e.data)));
      off.push(onLog(l => { if (l.level !== "debug") send("log", l); }));
      const ping = setInterval(() => send("ping", Date.now()), 25_000);
      off.push(() => clearInterval(ping));
    },
    cancel() { for (const f of off) f(); off = []; },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" } });
});
