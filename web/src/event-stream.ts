/** Live updates use a WebSocket: an SSE stream per tab can occupy all six HTTP/1 connections,
 * leaving API calls queued forever. Keep retries here so a lost connection never accumulates sockets. */
export type LiveMessage = { event: string; data: unknown };
export interface LiveSocket {
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}
export function openLiveEvents(
  url: string,
  receive: (event: string, data: unknown) => void,
  connection: (connected: boolean) => void,
  io: {
    socket: (url: string) => LiveSocket;
    later: (fn: () => void, ms: number) => () => void;
  } = {
    socket: url => new WebSocket(url) as unknown as LiveSocket,
    later: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  },
): () => void {
  let stopped = false, backoff = 1000;
  let socket: LiveSocket | null = null, cancelRetry: (() => void) | null = null;
  const connect = () => {
    if (stopped || socket) return;
    cancelRetry = null;
    const retry = () => {
      connection(false);
      cancelRetry = io.later(connect, backoff);
      backoff = Math.min(30_000, backoff * 2);
    };
    let current: LiveSocket;
    try { current = io.socket(url); } catch { retry(); return; }
    socket = current;
    current.onmessage = e => {
      if (stopped || socket !== current) return;
      let message: LiveMessage;
      try { message = JSON.parse(e.data); } catch { return; }
      if (!message || typeof message.event !== "string") return;
      if (message.event === "hello") { backoff = 1000; connection(true); }
      receive(message.event, message.data);
    };
    current.onclose = () => {
      if (stopped || socket !== current) return;
      socket = null;
      retry();
    };
    current.onerror = () => { if (socket === current) current.close(); };
  };
  connect();
  return () => {
    stopped = true;
    cancelRetry?.(); cancelRetry = null;
    const current = socket; socket = null;
    current?.close();
    connection(false);
  };
}
