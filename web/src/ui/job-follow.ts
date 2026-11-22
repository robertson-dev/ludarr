/**
 * Following one job while it is on screen: its full record (the log and the AI's steps) read at once, again every few
 * seconds while it is queued or running, on each of its 'job' events and after a lost connection comes back, and once
 * more a moment after it ends: the runner writes its last lines and steps just after the event that says it ended.
 * What its 'build' and 'job' events carry freshens the record in between. Free of React and of the event source, so the
 * engine's tests can drive it (tests/web-logic.test.ts); useJob (job-log.tsx) is its React side.
 */
import type { JobView } from "../api";
import { jobActive } from "../ways/logic";

/** what an event of the job carries that the page shows (events never carry the log or the steps) */
export const LIVE = ["state", "progress", "message", "tier", "updatedAt", "doneAt", "manifest", "lesson", "outputPath", "transcriptLines"] as const;

export interface FollowOpts {
  /** the job's full record (GET /api/v1/import/:id) */
  load: (id: number) => Promise<JobView>;
  subscribe: (l: (event: string, data: unknown) => void) => () => void;
  onConnection: (l: (ok: boolean) => void) => () => void;
  /** the record as it is now: `full` when it was read whole, not freshened by an event */
  onJob: (job: JobView, full: boolean) => void;
  onError: (message: string) => void;
  /** ms between reads while the job is queued or running */
  every?: number;
  /** ms after the job ends before the last read */
  settle?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
}

/** follow job `id` until the returned function is called */
export function followJob(id: number, o: FollowOpts): () => void {
  const every = o.every ?? 2000, settle = o.settle ?? 1500;
  const set = o.timers?.set ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = o.timers?.clear ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let alive = true, busy = false, again = false;
  let cur: JobView | null = null;
  /** whether the last full read found the job queued or running (null before the first) */
  let wasActive: boolean | null = null;
  let poll: unknown = null, last: unknown = null;
  const load = async (): Promise<void> => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const j = await o.load(id);
      if (!alive) return;
      cur = j;
      o.onJob(j, true);
      clear(poll); poll = null;
      const active = jobActive(j.state);
      if (active) poll = set(() => void load(), every);
      else if (wasActive && last == null) last = set(() => { last = null; void load(); }, settle);
      wasActive = active;
    } catch (e) {
      if (!alive) return;
      o.onError(String((e as Error)?.message ?? e));
      clear(poll);
      poll = set(() => void load(), Math.max(every, 5000));
    } finally {
      busy = false;
      if (again && alive) { again = false; void load(); }
    }
  };
  void load();
  const off = o.subscribe((ev, d) => {
    if ((ev !== "build" && ev !== "job") || !d || (d as JobView).id !== id) return;
    if (cur) {
      const next = { ...cur } as Record<string, unknown>;
      for (const k of LIVE) if ((d as JobView)[k] !== undefined) next[k] = (d as JobView)[k];
      cur = next as unknown as JobView;
      o.onJob(cur, false);
    }
    if (ev === "job") void load();             // a state change: the log and the steps have moved on as well
  });
  const offConn = o.onConnection(ok => { if (ok) void load(); });   // events missed while the connection was down
  return () => { alive = false; clear(poll); clear(last); off(); offConn(); };
}
