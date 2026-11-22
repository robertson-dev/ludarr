/**
 * ludarr — in-process event bus feeding the SSE stream (/api/events).
 * Workers publish row changes; the API fans them out to every open browser tab.
 */
/** 'build': progress ticks of jobs that are not imports (a way being built, the AI constructing a plan, game files taken
 *  in); Ahoy ignores it, so those ticks never make it refetch the library — state changes still go out as 'job'.
 *  'run': a carry run changed (src/ways/carry.ts, admin-only: the run without its steps) */
/** 'upload': an upload of a game's files changed (src/uploads.ts: its bytes, its job — or { id, gameId, deleted }) */
export type EventName = "request" | "job" | "package" | "fetch" | "follow" | "catalog" | "game" | "build" | "run" | "upload";
export interface AhoyEvent { event: EventName; data: unknown; at: number }
type Listener = (e: AhoyEvent) => void;

const listeners = new Set<Listener>();
const recent: AhoyEvent[] = [];
const KEEP = 200;

export const events = {
  emit(event: EventName, data: unknown) {
    const e: AhoyEvent = { event, data, at: Date.now() };
    recent.push(e);
    if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
    for (const l of listeners) { try { l(e); } catch { /* a dead subscriber must not break the others */ } }
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  listeners: () => listeners.size,
  recent: () => [...recent],
};
