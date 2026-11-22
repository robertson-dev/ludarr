/**
 * Every control in the admin UI must do something: each /api/v1 address the UI (web/src) calls is a route the server
 * mounts, with the method the UI uses where the call says it. Routes a later engine adds are listed in COMING; the UI
 * shows them only when the server answers (hasRoute) or says "not available on this server yet" when it does not, and
 * each listed one must still be called by the UI.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { app } from "../src/server";

const WEB = join(import.meta.dir, "..", "web", "src");
/** dead copies the UI does not import (CLAUDE.md): the old Ahoy web and the launcher download card */
const DEAD = [/^ahoy\//, /^ui\/launcher-download\.tsx$/];
/**
 * routes a later engine adds that the UI already calls (it shows them only when the server answers, and takes a 404 "no
 * such endpoint" quietly): the carry runs' API as SEAMS.md "The run API" sets it out, which src/ways/carry-api.ts mounts
 * (the integrator removes these once it is merged)
 */
/** none now: the carry run's routes (src/ways/carry-api.ts) are mounted */
const COMING: string[] = [];

interface Call { file: string; method: string; path: string; raw: string }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

/** a literal's text with each ${…} replaced by one marker, cut at the query */
function shape(raw: string): string {
  let out = "", i = 0;
  while (i < raw.length) {
    if (raw[i] === "$" && raw[i + 1] === "{") {
      let depth = 1, j = i + 2;
      while (j < raw.length && depth) { if (raw[j] === "{") depth++; else if (raw[j] === "}") depth--; j++; }
      out += "\u0000"; i = j; continue;
    }
    if (raw[i] === "?") break;
    out += raw[i++];
  }
  return out.split("/").map(seg => (seg === "\u0000" ? ":param" : seg.includes("\u0000") ? (seg.replace(/\u0000/g, "") || ":param") : seg)).join("/");
}

/** the method a call uses, from the code just before (and, for api(), just after) the address */
function methodOf(before: string, after: string): string {
  const call = before.match(/\b(getBlob|get|post|put|patch|del|upload|api)\s*(?:<[^()]*?>)?\s*\(\s*$/);
  if (call) {
    if (call[1] === "get" || call[1] === "getBlob") return "GET";
    if (call[1] === "post") return "POST";
    if (call[1] === "put") return "PUT";
    if (call[1] === "patch") return "PATCH";
    if (call[1] === "del") return "DELETE";
    const m = after.slice(0, 300).match(/method:\s*"(\w+)"/);
    return m ? m[1] : call[1] === "upload" ? "POST" : "GET";
  }
  const probe = before.match(/\b(?:hasRoute|routeMissing)\(\s*"(\w+)",\s*$/);
  return probe ? probe[1] : "ANY";
}

function uiCalls(): Call[] {
  const calls: Call[] = [];
  for (const f of walk(WEB)) {
    const rel = relative(WEB, f).replace(/\\/g, "/");
    if (DEAD.some(d => d.test(rel))) continue;
    const src = readFileSync(f, "utf8");
    // one pattern per quote: a template literal may hold quotes inside its ${…}
    const res = [/`(?:\$\{urlBase\})?(\/api\/v1\/[^`]*)`/g, /"(?:\$\{urlBase\})?(\/api\/v1\/[^"\n]*)"/g, /'(?:\$\{urlBase\})?(\/api\/v1\/[^'\n]*)'/g];
    for (const re of res) for (const m of src.matchAll(re)) {
      const at = m.index ?? 0;
      calls.push({ file: rel, method: methodOf(src.slice(Math.max(0, at - 200), at), src.slice(at + m[0].length)), path: shape(m[1]), raw: m[1] });
    }
  }
  return calls;
}

const routes = (app.routes as { method: string; path: string }[]).filter(r => r.path !== "*" && r.path !== "/*" && r.path !== "/api/*");
const segs = (p: string) => p.replace(/\/+$/, "").split("/");
function matches(routePath: string, uiPath: string): boolean {
  const r = segs(routePath), u = segs(uiPath);
  for (let i = 0; i < r.length; i++) {
    if (r[i] === "*") return u.length > i;
    if (i >= u.length) return false;
    if (u[i] === ":param" || r[i].startsWith(":")) continue;
    if (r[i] !== u[i]) return false;
  }
  return r.length === u.length;
}
const mounted = (c: Pick<Call, "method" | "path">) => routes.some(r => (c.method === "ANY" || r.method === c.method || r.method === "ALL") && matches(r.path, c.path));
const coming = (c: Pick<Call, "method" | "path">) => COMING.some(k => { const [m, p] = k.split(" "); return (c.method === "ANY" || c.method === m) && matches(p, c.path); });

describe("the admin UI's API calls", () => {
  const calls = uiCalls();
  test("are found (the scan reads the UI)", () => {
    expect(calls.length).toBeGreaterThan(60);
    expect(calls.some(c => c.method === "POST" && c.path === "/api/v1/game")).toBe(true);
    expect(calls.some(c => c.method === "PUT" && c.path === "/api/v1/game/:param/art/:param")).toBe(true);
  });
  test("each goes to a route the server mounts, with its method, or to one listed as coming", () => {
    const lost = calls.filter(c => !mounted(c) && !coming(c)).map(c => `${c.method} ${c.path}  (${c.file}: ${c.raw})`);
    expect(lost).toEqual([]);
  });
  test("each route listed as coming is still called by the UI (the list never keeps a stale entry)", () => {
    for (const k of COMING) {
      const [m, p] = k.split(" ");
      expect({ k, called: calls.some(c => c.method === m && matches(p, c.path)) }).toEqual({ k, called: true });
    }
  });
  test("the smoke start's screenshot is asked for at the route that serves it (admin-ui-16)", () => {
    const shot = calls.filter(c => c.path === "/api/v1/plan/construct/:param/shot/:param");
    expect(shot.length).toBeGreaterThan(0);
    for (const c of shot) expect({ c: c.raw, mounted: mounted({ method: "GET", path: c.path }) }).toEqual({ c: c.raw, mounted: true });
  });
  test("no address carries the API key, except the live connection's (a browser WebSocket cannot send a header)", () => {
    const carrying = walk(WEB).map(f => relative(WEB, f).replace(/\\/g, "/")).filter(rel => !DEAD.some(d => d.test(rel)))
      .flatMap(rel => readFileSync(join(WEB, rel), "utf8").split("\n").filter(l => /[?&]apikey=|searchParams\.set\(["\']apikey["\']/i.test(l) && !/help="/.test(l)).map(l => `${rel}: ${l.trim()}`));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toMatch(/^events\.ts: .*searchParams\.set\("apikey", apiKey\(\)\)/);
  });
  test("the check's screenshot is asked for with GET, through the API client that sends the key in the header", () => {
    const shot = calls.filter(c => c.path === "/api/v1/check-shot/:param");
    expect(shot.map(c => c.method)).toEqual(["GET"]);
    // listed as coming until the run routes are merged, mounted after (this holds either way)
    const c = { method: "GET", path: "/api/v1/check-shot/:param" };
    expect(mounted(c) || coming(c)).toBe(true);
  });
  test("the scan tells a missing route from a mounted one", () => {
    expect(mounted({ method: "POST", path: "/api/v1/plan/:param/check" })).toBe(true);
    expect(mounted({ method: "GET", path: "/api/v1/plan/:param/check" })).toBe(false);
    expect(mounted({ method: "POST", path: "/api/v1/plans" })).toBe(false);
    expect(shape("/api/v1/game/${g.id}/art/${kind}")).toBe("/api/v1/game/:param/art/:param");
    expect(shape("/api/v1/art/game/${gameId}/poster${ver(v)}")).toBe("/api/v1/art/game/:param/poster");
    expect(shape("/api/v1/release?gameId=${gameId}${loose ? \"&loose=1\" : \"\"}")).toBe("/api/v1/release");
  });
});
