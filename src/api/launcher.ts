/**
 * ludarr API — the desktop launcher build, published from <config>/launcher/:
 *
 *   GET /api/v1/launcher       the newest Ahoy-*.exe there: { file, version, size, url } or { file: null }
 *   GET /launcher/:file        the file itself (outside /api: a plain link in the browser downloads it)
 */
import { Hono } from "hono";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../config";

export const launcherApi = new Hono();
const DIR = () => join(configDir(), "launcher");
const SAFE = /^[A-Za-z0-9._-]+\.exe$/;

export async function latestLauncher(): Promise<{ file: string; version: string | null; size: number; url: string } | null> {
  const names = (await readdir(DIR()).catch(() => [] as string[])).filter(n => SAFE.test(n));
  let best: { file: string; version: string | null; size: number; mtime: number } | null = null;
  for (const n of names) {
    const s = await stat(join(DIR(), n)).catch(() => null);
    if (!s?.isFile()) continue;
    if (!best || s.mtimeMs > best.mtime) best = { file: n, version: /(\d+\.\d+\.\d+)/.exec(n)?.[1] ?? null, size: s.size, mtime: s.mtimeMs };
  }
  return best ? { file: best.file, version: best.version, size: best.size, url: `/launcher/${best.file}` } : null;
}

launcherApi.get("/api/v1/launcher", async c => c.json((await latestLauncher()) ?? { file: null }));
launcherApi.get("/launcher/:file", async c => {
  const name = c.req.param("file");
  if (!SAFE.test(name)) return c.json({ error: "no such file" }, 404);
  const f = Bun.file(join(DIR(), name));
  if (!(await f.exists())) return c.json({ error: "no such file" }, 404);
  return new Response(f, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "content-length": String(f.size) } });
});
