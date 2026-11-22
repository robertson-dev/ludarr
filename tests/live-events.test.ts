import { expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { app } from "../src/server";
import { apiKey } from "../src/config";
import { events } from "../src/events";

test("many admin connections receive live events while API calls remain available, then release listeners", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
  const base = `http://127.0.0.1:${server.port}`, sockets: WebSocket[] = [];
  const before = events.listeners(), messages: any[][] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const received: any[] = []; messages.push(received);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(base.replace("http:", "ws:") + "/api/v1/system/live?apikey=" + encodeURIComponent(apiKey()));
        sockets.push(ws);
        ws.onerror = reject;
        ws.onmessage = e => { const msg = JSON.parse(String(e.data)); received.push(msg); if (msg.event === "hello") resolve(); };
      });
    }
    expect(events.listeners()).toBe(before + 8);
    const response = await fetch(base + "/api/v1/system/status", { headers: { "X-Api-Key": apiKey() }, signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    events.emit("build", { id: 230, progress: 0.98 });
    for (let i = 0; i < 100 && messages.some(m => !m.some(e => e.event === "build")); i++) await Bun.sleep(5);
    for (const m of messages) expect(m.find(e => e.event === "build")?.data).toEqual({ id: 230, progress: 0.98 });
    await Promise.all(sockets.map(ws => new Promise<void>(resolve => { ws.onclose = () => resolve(); ws.close(); })));
    for (let i = 0; i < 100 && events.listeners() !== before; i++) await Bun.sleep(5);
    expect(events.listeners()).toBe(before);
  } finally { for (const ws of sockets) ws.close(); await server.stop(true); }
});

test("the live endpoint requires authentication and refuses a foreign browser origin", async () => {
  expect((await app.request("/api/v1/system/live")).status).toBe(401);
  for (const origin of ["https://elsewhere.test", "null"]) {
    const r = await app.request("http://ludarr/api/v1/system/live", {
      headers: { "X-Api-Key": apiKey(), host: "ludarr", origin },
    });
    expect(r.status).toBe(403);
  }
});
