/**
 * The server takes bodies of up to CONTENT_UPLOAD_MAX_GB for game files, so every other body is capped where it is read:
 * JSON routes at 1 MB (32 MB for a plan or a way: the largest plan the validator takes, every character of its text
 * written as JSON's 6-byte "\u0001", is about 29 MB), counted while the body streams in; the image route's JSON {url} at
 * 64 KB. The uploads — a game file, a system file, an image — keep caps of their own and are not cut off by the JSON cap.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, upsertGame, type GameRow } from "../src/db";
import { apiKey } from "../src/config";
import { app } from "../src/server";
import { validatePlanSpec } from "../src/ways/validate";

const MiB = 1 << 20;
const key = { "x-api-key": apiKey() };
/** a chunked body (no Content-Length) of `total` bytes, 1 MiB at a time, counting what the server pulls */
function stream(total: number, first?: Uint8Array) {
  let sent = 0;
  const chunk = new Uint8Array(MiB).fill(0x20);
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (sent >= total) { c.close(); return; } c.enqueue(sent === 0 && first ? first : chunk); sent += MiB; },
  });
  return { body, pulled: () => sent / MiB };
}
const made: number[] = [];
// the image stored below goes to <config>/art: a temporary <config>, never the working folder
let configBefore: string | undefined;
beforeAll(() => { configBefore = process.env.LUDARR_CONFIG; process.env.LUDARR_CONFIG = mkdtempSync(join(tmpdir(), "ludarr-cap-")); });
afterAll(() => {
  for (const id of made) db.query("DELETE FROM games WHERE id=?").run(id);
  if (configBefore === undefined) delete process.env.LUDARR_CONFIG; else process.env.LUDARR_CONFIG = configBefore;
});
let appid = 994_400;
const game = (name: string) => { const g = upsertGame({ steam_appid: ++appid, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") }) as GameRow; made.push(g.id); return g; };
const send = (path: string, method: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request(path, { method, headers: { ...key, ...headers }, body, duplex: "half" } as RequestInit);

describe("JSON bodies are refused past their cap while they stream in", () => {
  test("the image route's JSON {url}: 413 after at most a few MB of a 64 MB body", async () => {
    const g = game("Cap Art Json");
    const s = stream(64 * MiB);
    const res = await send(`/api/v1/game/${g.id}/art/poster`, "PUT", s.body, { "content-type": "application/json" });
    expect(res.status).toBe(413);
    expect(s.pulled()).toBeLessThanOrEqual(4);
  });
  test("a JSON route: 413 after at most a few MB of a 32 MB body", async () => {
    for (const [path, method] of [["/api/v1/game", "POST"], ["/api/v1/config", "PUT"], ["/api/v1/content/path", "POST"], ["/api/v1/import", "POST"]]) {
      const s = stream(32 * MiB);
      const res = await send(path, method, s.body, { "content-type": "application/json" });
      expect({ path, status: res.status }).toEqual({ path, status: 413 });
      expect(s.pulled()).toBeLessThanOrEqual(4);
    }
  });
  test("a declared length over the cap is refused before anything is read", async () => {
    const s = stream(4 * MiB);
    const res = await app.request("/api/v1/game", { method: "POST", headers: { ...key, "content-type": "application/json", "content-length": String(4 * MiB) }, body: s.body, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(s.pulled()).toBeLessThanOrEqual(1);
  });
  test("a plan may be several MB (its files may be 50 × 64 KB), but not without end", async () => {
    const files = Array.from({ length: 45 }, (_, i) => ({ path: `config/file-${i}.ini`, text: `[section]\nkey=${"x".repeat(60_000)}\n` }));
    const spec = {
      program: { kind: "release", assetPattern: "^Cap-v.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "Cap.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "the cap test ROM", search: ["Cap Test Game"], accept: { hashes: [{ algo: "sha1", value: "a".repeat(40) }], formats: ["z64"] }, normalize: "n64-z64", place: "rom.z64" },
      files, setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
    };
    const body = JSON.stringify({ name: "Cap Big Plan", kind: "recomp", repo: "captest/cap-big-plan", spec });
    expect(body.length).toBeGreaterThan(2 * MiB);
    const res = await send("/api/v1/plan", "POST", body, { "content-type": "application/json" });
    const j = await res.json() as { item?: { id: number }; error?: string };
    expect([res.status, j.error ?? null]).toEqual([201, null]);
    expect((await app.request(`/api/v1/plan/${j.item!.id}`, { method: "DELETE", headers: key })).status).toBe(200);
    const s = stream(96 * MiB);
    expect((await send("/api/v1/plan", "POST", s.body, { "content-type": "application/json" })).status).toBe(413);
    expect(s.pulled()).toBeLessThanOrEqual(36);
  });
  test("the largest plan the validator takes gets through, even with every character of its text written in 6 bytes", async () => {
    // what the validator counts is characters: 50 files of 65 536, 30 setup steps of 50 arguments of 1000, and so on — and
    // JSON.stringify writes a control character as "\u0001"
    const c = (n: number) => "\u0001".repeat(n);
    const many = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
    const hashes = many(40, i => ({ algo: "sha1", value: i.toString(16).padStart(40, "0"), label: c(80) }));
    const spec = {
      program: { kind: "source", ref: "v1.0.0", steps: many(50, () => c(2000)), artifact: "build/game.exe", apt: many(40, i => `lib${i}-dev`), content: "build" },
      root: "game",
      content: { kind: "rom", platform: "n64", what: c(300), search: many(10, () => c(200)), accept: { hashes, formats: ["z64"], regions: ["USA", "North America", "Europe", "Japan", "World", "Korea", "Asia", "Australia", "Brazil", "Taiwan"], serials: many(50, i => `NUS-${i}`) }, normalize: "n64-z64", place: "rom/game.z64" },
      tools: { ref: "v1.0.0", steps: many(50, () => c(2000)), outputs: many(20, i => `tools/t${i}.exe`), apt: many(40, i => `tool${i}`) },
      launch: { exe: "Game.exe", argv: many(50, () => c(1000)), cwd: "bin", env: Object.fromEntries(many(30, i => [`VAR_${i}`, c(1000)])) },
      files: many(50, i => ({ path: `files/f${i}.txt`, text: c(65_536) })),
      setup: many(30, () => ({ run: { exe: "setup/tool.exe", wine: true, argv: many(50, () => c(1000)), timeoutSec: 60 } })),
      needs: many(10, i => ({ kind: "bios", name: c(120), place: `bios/b${i}.bin`, accept: { hashes }, note: c(500) })),
      keep: many(30, i => `saves/s${i}/**`), seed: many(30, i => `config/c${i}.ini`), firstRun: c(500), notes: c(4000),
    };
    expect(validatePlanSpec(spec, "recomp").errors).toEqual([]);
    const body = JSON.stringify({ name: "Cap Largest Plan", kind: "recomp", repo: "captest/cap-largest-plan", spec });
    expect(body.length).toBeGreaterThan(28 * MiB);                     // an 8 MB cap refused it
    const res = await send("/api/v1/plan", "POST", body, { "content-type": "application/json" });
    const j = await res.json() as { item?: { id: number }; error?: string };
    expect([res.status, j.error ?? null]).toEqual([201, null]);
    expect((await app.request(`/api/v1/plan/${j.item!.id}`, { method: "DELETE", headers: key })).status).toBe(200);
  }, 60_000);
  test("under Bun.serve with the upload limit main.ts sets, a large chunked JSON body is cut off early", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120, maxRequestBodySize: 16 * 2 ** 30 });
    try {
      const s = stream(300 * MiB);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/game`, { method: "POST", headers: { ...key, "content-type": "application/json" }, body: s.body, duplex: "half" } as RequestInit)
        .catch(() => null);
      if (res) expect(res.status).toBe(413);
      expect(s.pulled()).toBeLessThan(64);
    } finally { server.stop(true); }
  }, 60_000);
});

describe("the uploads keep their own caps", () => {
  test("a game file or a system file larger than the JSON cap reaches its route (which answers for itself)", async () => {
    // no such game / plan: the route says so — the body was not cut off as JSON on the way
    for (const path of ["/api/v1/content?gameId=987654&name=Big.iso", "/api/v1/plan/987654/needs/0/file?name=bios.bin"]) {
      const s = stream(3 * MiB);
      const res = await send(path, "POST", s.body, { "content-type": "application/octet-stream" });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });
  test("an image larger than the JSON cap is taken", async () => {
    const g = game("Cap Art Image");
    const png = new Uint8Array(MiB).fill(7); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const s = stream(3 * MiB, png);
    const res = await send(`/api/v1/game/${g.id}/art/poster`, "PUT", s.body, { "content-type": "image/png" });
    expect(res.status).toBe(200);
    expect(s.pulled()).toBe(3);
  });
});
