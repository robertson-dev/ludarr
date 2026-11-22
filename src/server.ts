/**
 * ludarr — HTTP: the API under /api/v1 (X-Api-Key, like every *arr) and the web UI (public/, built from
 * web/) with the API key injected into index.html so the UI can talk to the API. Optional basic auth in
 * front of everything (Settings → General). Same-origin only: no answer carries a CORS header, so the page
 * with the key in it can be read by the UI itself and by no other site's script.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import { apiKey, cfg } from "./config";
import { logger } from "./log";
import { VERSION } from "./version";
import { systemApi } from "./api/system";
import { settingsApi } from "./api/settings";
import { gamesApi } from "./api/games";
import { activityApi } from "./api/activity";
import { catalogApi } from "./api/catalog";
import { artApi } from "./api/art";
import { crackwatchApi } from "./api/crackwatch";
import { launchApi } from "./api/launch";
import { waysApi } from "./ways/api";
import { constructApi } from "./ways/construct-api";
import { carryApi } from "./ways/carry-api";
import { uploadsApi } from "./api/uploads";
import { blocksApi } from "./api/blocks";

const log = logger("Http");
export const app = new Hono();
const PUBLIC = join(import.meta.dir, "..", "public");

/* No cross-origin headers on anything: the web UI is served from this same address, and every other client (the Ahoy
   server, the launchers' own processes) is a program, not a page, and needs none. With them, any page open in a browser
   on the LAN could read index.html (the API key is written into it for the UI) and then drive the whole API. */
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  if (c.req.path.startsWith("/api/") && !c.req.path.endsWith("/events")) log.debug(`${c.req.method} ${c.req.path} → ${c.res.status} in ${Date.now() - t0} ms`);
});

function basicOk(header: string | undefined): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), "base64").toString().split(":");
  return !!cfg("AUTH_USERNAME") && user === cfg("AUTH_USERNAME") && rest.join(":") === cfg("AUTH_PASSWORD");
}

/* unauthenticated liveness for Docker / Unraid: says nothing but "up" */
app.get("/api/health", c => c.json({ ok: true, version: VERSION }));
/* art is served without the key: an <img> cannot send headers, and it only ever answers with images */
app.route("/", artApi);

/* auth: the API wants the key (header or ?apikey=); basic auth, when on, guards the UI and also unlocks the API */
app.use("*", async (c, next) => {
  if (c.req.path === "/api/health" || c.req.path.startsWith("/api/v1/art/")) return next();
  const basic = cfg("AUTH_METHOD") === "basic";
  const authed = basic && basicOk(c.req.header("authorization"));
  if (c.req.path.startsWith("/api/")) {
    const given = c.req.header("x-api-key") || c.req.query("apikey");
    if (given === apiKey() || authed) return next();
    return c.json({ error: "Unauthorized: send the API key in X-Api-Key (Settings → General)" }, 401);
  }
  if (basic && !authed) return new Response("ludarr: sign in", { status: 401, headers: { "www-authenticate": 'Basic realm="ludarr"' } });
  return next();
});

/* request bodies: the server takes game files of up to CONTENT_UPLOAD_MAX_GB (src/main.ts), so every other body is capped
   here, counted while it streams in: 1 MB, or 32 MB for a plan or a way. The plan validator counts characters (50 files
   of 64 K of them, 30 setup steps of 50 arguments of 1000 …) and JSON writes a character in up to 6 bytes ("\u0001"):
   the largest plan it takes is about 29 MB (tests/body-cap.test.ts). The uploads keep their routes' own caps: a game
   file, a system file, an image (15 MB; its JSON {url} 64 KB), a piece of an uploaded game (never more than its file's
   announced size, nor than the whole upload's: src/uploads.ts) */
const UPLOADS: [string, RegExp][] = [
  ["POST", /^\/api\/v1\/content$/],
  ["PUT", /^\/api\/v1\/upload\/[^/]+\/file$/],
  ["POST", /^\/api\/v1\/plan\/[^/]+\/needs\/[^/]+\/file$/],
  ["PUT", /^\/api\/v1\/game\/[^/]+\/art\/[^/]+$/],
];
const PLAN_BODIES = /^\/api\/v1\/(plan(\/[^/]+)?|game\/[^/]+\/ways|way\/[^/]+)$/;
const jsonCap = bodyLimit({ maxSize: 1 << 20, onError: c => c.json({ error: "the request body is larger than 1 MB" }, 413) });
const planCap = bodyLimit({ maxSize: 32 << 20, onError: c => c.json({ error: "the request body is larger than 32 MB" }, 413) });
app.use("/api/*", (c, next) => {
  if (UPLOADS.some(([method, path]) => c.req.method === method && path.test(c.req.path))) return next();
  return (PLAN_BODIES.test(c.req.path) ? planCap : jsonCap)(c, next);
});

app.route("/", systemApi);
app.route("/", settingsApi);
app.route("/", gamesApi);
app.route("/", activityApi);
app.route("/", catalogApi);
app.route("/", crackwatchApi);
app.route("/", launchApi);
app.route("/", uploadsApi);
app.route("/", blocksApi);
app.route("/", waysApi);
app.route("/", constructApi);
app.route("/", carryApi);
app.get("/api/health", c => c.json({ ok: true, version: VERSION }));    // unauthenticated liveness for Docker
app.all("/api/*", c => c.json({ error: "no such endpoint" }, 404));

/* the web UI: hashed assets straight from disk, index.html with the runtime config injected, SPA fallback */
app.use("/assets/*", serveStatic({ root: "./public" }));
app.use("/favicon.svg", serveStatic({ root: "./public" }));
const pageCache = new Map<string, { at: number; html: string }>();
async function pageHtml(file: string): Promise<string> {
  const c = pageCache.get(file);
  if (c && Date.now() - c.at < 10_000) return c.html;
  const f = Bun.file(join(PUBLIC, file));
  const html = (await f.exists()) ? await f.text() : `<!doctype html><html><head><meta charset="utf-8"><title>ludarr</title></head><body style="font-family:sans-serif;background:#202020;color:#ccc;padding:40px"><h1>ludarr ${VERSION}</h1><p>The web UI is not built yet (run <code>bun run build:web</code>). The API is up at <code>/api/v1</code>.</p></body></html>`;
  pageCache.set(file, { at: Date.now(), html });
  return html;
}
const indexHtml = () => pageHtml("index.html");
const withRuntime = (html: string) => html.replace("</head>", `<script>window.ludarr=${JSON.stringify({ apiKey: apiKey(), version: VERSION })}</script></head>`);
app.get("*", async c => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "no such endpoint" }, 404);
  return c.html(withRuntime(await indexHtml()), 200, { "cache-control": "no-cache, must-revalidate" });
});
