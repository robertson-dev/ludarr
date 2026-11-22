/**
 * ludarr — scheduled tasks, like *arr's System → Tasks: each worker is a named task with an interval,
 * a last run, a duration and an error; any of them can be run now from the UI.
 */
import { logger } from "./log";

/** intervalSec may be a function so a setting changed in the UI applies to the next run without a restart */
export interface Task { name: string; label: string; intervalSec: number | (() => number); run: () => Promise<unknown> }
const every = (t: Task) => (typeof t.intervalSec === "function" ? t.intervalSec() : t.intervalSec);
interface State { lastRun: number | null; lastDuration: number | null; lastError: string | null; running: boolean; runs: number }

const log = logger("Tasks");
const tasks = new Map<string, Task & { state: State }>();
let timer: ReturnType<typeof setInterval> | null = null;

export function registerTask(t: Task) {
  tasks.set(t.name, { ...t, state: { lastRun: null, lastDuration: null, lastError: null, running: false, runs: 0 } });
}

export async function runTask(name: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t = tasks.get(name);
  if (!t) throw new Error(`no task named ${name}`);
  if (t.state.running) return { ok: false, ms: 0, error: "already running" };
  t.state.running = true;
  const t0 = Date.now();
  try {
    await t.run();
    t.state.lastError = null;
    return { ok: true, ms: Date.now() - t0 };
  } catch (e: any) {
    t.state.lastError = String(e?.message ?? e);
    log.warn(`${t.label}: ${t.state.lastError}`);
    return { ok: false, ms: Date.now() - t0, error: t.state.lastError };
  } finally {
    t.state.running = false;
    t.state.lastRun = Date.now();
    t.state.lastDuration = Date.now() - t0;
    t.state.runs++;
  }
}

export function listTasks() {
  return [...tasks.values()].map(t => ({
    name: t.name, label: t.label, intervalSec: every(t), running: t.state.running, runs: t.state.runs,
    lastRun: t.state.lastRun, lastDuration: t.state.lastDuration, lastError: t.state.lastError,
    nextRun: t.state.lastRun ? t.state.lastRun + every(t) * 1000 : Date.now(),
  }));
}

const BEAT_SLACK_MS = 950;
export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const t of tasks.values()) {
      if (t.state.running) continue;
      // due a scheduler's beat early: the beat is a second, so a task of N seconds would otherwise run every N+1 (a task of a
      // second, every two)
      if (t.state.lastRun == null || now - t.state.lastRun >= every(t) * 1000 - BEAT_SLACK_MS) void runTask(t.name);
    }
  }, 1000);
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }
