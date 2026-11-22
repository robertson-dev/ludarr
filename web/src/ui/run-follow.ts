/**
 * Following one carry run while it is on screen: read at once; again every two seconds while it follows a job or a
 * request of its own (that is when it has progress to show) and every half minute while it asks or is on hold (it looks
 * again by itself on its own clock); on each of its 'run' events, whose payload freshens the run at once, with a full read
 * when the state, the phase, the ask or what it follows changed (that is when new steps come); after a lost connection
 * comes back; and once more a moment after it ends. The progress ticks of the job it follows ('build' and 'job' events)
 * go to onTick as they come. Free of React and of the event source, so the engine's tests drive it
 * (tests/web-logic.test.ts); useRun (run-view.tsx) is its React side.
 */
import type { JobView, RunView } from "../api";
import { runOpen, runWorking } from "../ways/logic";

/** what a 'run' event carries that the page shows (an event never carries the steps) */
export const RUN_LIVE = ["phase", "state", "rail", "now", "ask", "budget", "nextAt", "updatedAt", "doneAt", "gameId", "gameName", "wayId", "check"] as const;

export interface RunFollowOpts {
  /** the run with its steps (GET /api/v1/run/:id) */
  load: (id: number) => Promise<RunView>;
  subscribe: (l: (event: string, data: unknown) => void) => () => void;
  onConnection: (l: (ok: boolean) => void) => () => void;
  /** the run as it is now: `full` when it was read whole, not freshened by an event */
  onRun: (run: RunView, full: boolean) => void;
  /** a progress tick or a state change of the job the run follows now */
  onTick?: (job: JobView) => void;
  /** a read failed; true stops the following (the server has no run routes, or no such run) */
  onError: (e: unknown) => boolean;
  /** ms between reads while it works on a job or a request of its own */
  every?: number;
  /** ms between reads while it asks or is on hold */
  idle?: number;
  /** ms after it ends before the last read */
  settle?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
}

/** a change that comes with new steps: the state, the phase, the ask, or the job or request it follows */
const moved = (a: RunView, b: RunView) =>
  a.state !== b.state || a.phase !== b.phase || (a.ask?.code ?? null) !== (b.ask?.code ?? null)
  || (a.now?.jobId ?? null) !== (b.now?.jobId ?? null) || (a.now?.requestId ?? null) !== (b.now?.requestId ?? null);

/** follow run `id` until `stop`; `reload` reads it again now (after a press that changed it) */
export function followRun(id: number, o: RunFollowOpts): { stop: () => void; reload: () => void } {
  const every = o.every ?? 2000, idle = o.idle ?? 30_000, settle = o.settle ?? 1500;
  const set = o.timers?.set ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = o.timers?.clear ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let alive = true, busy = false, again = false, stopped = false;
  let cur: RunView | null = null;
  /** whether the last full read found the run open (null before the first) */
  let wasOpen: boolean | null = null;
  let poll: unknown = null, last: unknown = null;
  const load = async (): Promise<void> => {
    if (!alive || stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const r = await o.load(id);
      if (!alive) return;
      cur = r;
      o.onRun(r, true);
      clear(poll); poll = null;
      const open = runOpen(r.state);
      if (open) poll = set(() => void load(), runWorking(r.state) ? every : idle);
      else if (wasOpen && last == null) last = set(() => { last = null; void load(); }, settle);
      wasOpen = open;
    } catch (e) {
      if (!alive) return;
      clear(poll); poll = null;
      if (o.onError(e)) { stopped = true; return; }
      poll = set(() => void load(), Math.max(every, 5000));
    } finally {
      busy = false;
      if (again && alive && !stopped) { again = false; void load(); }
    }
  };
  void load();
  const off = o.subscribe((ev, d) => {
    if (!d || typeof d !== "object") return;
    if (ev === "run") {
      if ((d as RunView).id !== id) return;
      if (!cur) { void load(); return; }
      const before = cur;
      const next = { ...cur } as Record<string, unknown>;
      for (const k of RUN_LIVE) if ((d as RunView)[k] !== undefined) next[k] = (d as RunView)[k];
      cur = next as unknown as RunView;
      o.onRun(cur, false);
      if (moved(before, cur)) void load();
      return;
    }
    if ((ev === "build" || ev === "job") && cur?.now?.jobId != null && (d as JobView).id === cur.now.jobId) o.onTick?.(d as JobView);
  });
  const offConn = o.onConnection(ok => { if (ok) void load(); });
  return { stop: () => { alive = false; clear(poll); clear(last); off(); offConn(); }, reload: () => void load() };
}
