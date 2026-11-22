/**
 * ludarr — logging: console, a ring buffer for the UI (System → Logs) and a capped table so the last
 * days survive a restart. Loggers are named like *arr's ("Fetch", "Import", "Plugin:prowlarr").
 */
import { db } from "./db";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
export interface LogLine { id: number; level: Level; logger: string; message: string; at: number }

let seq = 0;
const ring: LogLine[] = [];
const RING = 2000;
let minLevel: Level = (process.env.LOG_LEVEL as Level) || "info";
export function setLogLevel(l: Level) { minLevel = l; }
export function logLevel() { return minLevel; }

db.exec(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, logger TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at);`);
const insert = db.query("INSERT INTO logs (level, logger, message, at) VALUES (?, ?, ?, ?)");
const trim = db.query("DELETE FROM logs WHERE id < (SELECT MAX(id) FROM logs) - 20000");
let sinceTrim = 0;

const listeners = new Set<(l: LogLine) => void>();

export function write(level: Level, logger: string, message: string) {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line: LogLine = { id: ++seq, level, logger, message, at: Date.now() };
  ring.push(line);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  const stamp = new Date(line.at).toISOString().slice(11, 19);
  const out = `${stamp} ${level.padEnd(5)} [${logger}] ${message}`;
  if (level === "error") console.error(out); else if (level === "warn") console.warn(out); else console.log(out);
  try {
    insert.run(level, logger, message.slice(0, 4000), Math.floor(line.at / 1000));
    if (++sinceTrim > 500) { sinceTrim = 0; trim.run(); }
  } catch { /* logging never breaks the app */ }
  for (const l of listeners) { try { l(line); } catch { /* ignore */ } }
}

export function logger(name: string) {
  return {
    debug: (m: string) => write("debug", name, m),
    info: (m: string) => write("info", name, m),
    warn: (m: string) => write("warn", name, m),
    error: (m: string) => write("error", name, m),
    /** console.log-style: joins arguments (the engine's `deps.log` hooks are shaped like this) */
    log: (...a: unknown[]) => write("info", name, a.map(x => (typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(" ")),
  };
}

export function recentLogs(opt: { level?: Level; logger?: string; limit?: number; before?: number } = {}): LogLine[] {
  const min = opt.level ? ORDER[opt.level] : 0;
  let rows = ring.filter(l => ORDER[l.level] >= min && (!opt.logger || l.logger.toLowerCase().includes(opt.logger.toLowerCase())) && (!opt.before || l.id < opt.before));
  if (rows.length < (opt.limit ?? 200) && ring.length < RING) {
    // early after a restart the ring is short: fill from the table
    const stored = db.query(`SELECT id, level, logger, message, at FROM logs WHERE at < ? ORDER BY id DESC LIMIT ?`).all(Math.floor((ring[0]?.at ?? Date.now()) / 1000), (opt.limit ?? 200)) as { id: number; level: Level; logger: string; message: string; at: number }[];
    rows = [...rows, ...stored.map(s => ({ ...s, id: -s.id, at: s.at * 1000 })).filter(l => ORDER[l.level] >= min && (!opt.logger || l.logger.toLowerCase().includes(opt.logger.toLowerCase())))];
  }
  return rows.slice(-(opt.limit ?? 200)).reverse();
}

export function onLog(l: (line: LogLine) => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
