/** ludarr web — live updates without occupying the browser's HTTP request connections. */
import { useEffect } from "react";
import { apiKey, urlBase } from "./api";
import { openLiveEvents } from "./event-stream";

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
let disconnect: (() => void) | null = null;
export let connected = false;
const connListeners = new Set<(ok: boolean) => void>();
function connect() {
  if (disconnect || !listeners.size) return;
  const url = new URL(urlBase + "/api/v1/system/live", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("apikey", apiKey());
  disconnect = openLiveEvents(url.href,
    (event, data) => { for (const l of listeners) { try { l(event, data); } catch { /* one page cannot break the others */ } } },
    ok => { connected = ok; for (const l of connListeners) l(ok); },
  );
}
function stop() { const off = disconnect; disconnect = null; off?.(); }
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", connect);
}
export function subscribe(l: Listener): () => void {
  listeners.add(l); connect();
  return () => { listeners.delete(l); if (!listeners.size) stop(); };
}
export function onConnection(l: (ok: boolean) => void): () => void { connListeners.add(l); return () => { connListeners.delete(l); }; }

/** run `fn` (debounced) whenever one of the named events arrives */
export function useEvents(names: string[], fn: (event: string, data: unknown) => void, deps: unknown[] = []) {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    let last: [string, unknown] | null = null;
    const off = subscribe((event, data) => {
      if (!names.includes(event) && !(event === "hello" && names.length)) return;
      last = [event, data];
      if (t) return;
      t = setTimeout(() => { t = null; if (last) fn(last[0], last[1]); }, 400);
    });
    return () => { off(); if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
