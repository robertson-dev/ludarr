/**
 * The HTTP front answers its own pages only: index.html carries the API key for the web UI, so nothing ludarr sends may
 * tell a browser that another site's script can read it (or call the API with a header of its own).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { apiKey } from "../src/config";
import { app } from "../src/server";

const ELSEWHERE = { origin: "http://some-page.example" };
const cors = (r: Response) => { const names: string[] = []; r.headers.forEach((_v, k) => { if (k.toLowerCase().startsWith("access-control-")) names.push(k); }); return names; };

beforeEach(() => { db.exec("DELETE FROM kv WHERE key LIKE 'cfg.%'"); });

describe("same origin only", () => {
  test("the page with the key in it is not readable from another site", async () => {
    const page = await app.request("/", { headers: ELSEWHERE });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`"apiKey":"${apiKey()}"`);            // the UI still gets its key, same-origin
    expect(cors(page)).toEqual([]);
    expect(cors(await app.request("/settings/general", { headers: ELSEWHERE }))).toEqual([]);   // the SPA fallback is the same page
  });

  test("a preflight from another site is not granted: no API call with X-Api-Key can follow it", async () => {
    const pre = await app.request("/api/v1/config", { method: "OPTIONS", headers: { ...ELSEWHERE, "access-control-request-method": "PUT", "access-control-request-headers": "x-api-key,content-type" } });
    expect(cors(pre)).toEqual([]);
    expect(pre.status).toBe(401);                                              // it is one more request without the key
    const art = await app.request("/api/v1/art/game/1/poster", { method: "OPTIONS", headers: { ...ELSEWHERE, "access-control-request-method": "GET" } });
    expect(cors(art)).toEqual([]);
  });

  test("no answer carries a cross-origin header: the API, the art, the liveness check", async () => {
    for (const path of ["/api/v1/system/status", "/api/health", "/api/v1/art/game/999999/poster", "/api/v1/nope"]) {
      const r = await app.request(path, { headers: { ...ELSEWHERE, "x-api-key": apiKey() } });
      expect([path, cors(r)]).toEqual([path, []]);
    }
  });

  test("programs with the key are served as before, whatever Origin they send or none", async () => {
    expect((await app.request("/api/v1/system/status", { headers: { "x-api-key": apiKey() } })).status).toBe(200);
    expect((await app.request("/api/v1/system/status", { headers: { ...ELSEWHERE, "x-api-key": apiKey() } })).status).toBe(200);
    expect((await app.request(`/api/v1/system/status?apikey=${apiKey()}`)).status).toBe(200);
    expect((await app.request("/api/v1/system/status")).status).toBe(401);
    expect((await app.request("/api/health")).status).toBe(200);
  });
});
