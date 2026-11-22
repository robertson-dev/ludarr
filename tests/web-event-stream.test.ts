import { describe, expect, test } from "bun:test";
import { openLiveEvents, type LiveSocket } from "../web/src/event-stream";

function harness() {
  const sockets: (LiveSocket & { closed: boolean; emit: (event: string, data?: unknown) => void })[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const events: [string, unknown][] = [], states: boolean[] = [];
  const stop = openLiveEvents("ws://ludarr/api/v1/system/live?apikey=test", (e, d) => events.push([e, d]), c => states.push(c), {
    socket: () => {
      const s = { onmessage: null, onclose: null, onerror: null, closed: false,
        close() { this.closed = true; this.onclose?.(); },
        emit(event: string, data?: unknown) { this.onmessage?.({ data: JSON.stringify({ event, data }) }); },
      } as (typeof sockets)[number];
      sockets.push(s); return s;
    },
    later: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
  });
  return { sockets, timers, events, states, stop };
}
describe("admin live updates", () => {
  test("delivers progress and connection state without an HTTP event stream", () => {
    const h = harness();
    h.sockets[0].emit("hello", { version: "test" });
    h.sockets[0].emit("build", { id: 230, progress: 0.98 });
    expect(h.states).toEqual([true]);
    expect(h.events[1]).toEqual(["build", { id: 230, progress: 0.98 }]);
    h.stop();
    expect(h.sockets[0].closed).toBe(true);
    expect(h.timers).toHaveLength(0);
  });
  test("a connection failure retries once, backs off, and resets after reconnecting", () => {
    const h = harness();
    h.sockets[0].onerror?.();
    h.sockets[0].onclose?.();
    expect(h.timers.map(t => t.ms)).toEqual([1000]);
    h.timers[0].fn();
    h.sockets[1].close();
    expect(h.timers[1].ms).toBe(2000);
    h.timers[1].fn();
    h.sockets[2].emit("hello");
    h.sockets[0].emit("job", { stale: true });
    expect(h.events).toEqual([["hello", undefined]]);
    h.sockets[2].close();
    expect(h.timers[2].ms).toBe(1000);
    h.stop();
    expect(h.timers[2].cancelled).toBe(true);
    h.timers[2].fn();
    expect(h.sockets).toHaveLength(3);
  });
  test("closing a page releases its connection and rejects malformed messages", () => {
    const h = harness();
    h.sockets[0].onmessage?.({ data: "bad json" });
    h.sockets[0].onmessage?.({ data: "null" });
    expect(h.events).toEqual([]);
    h.stop();
    h.sockets[0].emit("hello");
    expect(h.events).toEqual([]);
    expect(h.states).toEqual([false]);
  });
});
