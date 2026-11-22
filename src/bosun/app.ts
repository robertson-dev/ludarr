/**
 * bosun — the connector's HTTP API (Hono). Everything under /v1 needs `Authorization: Bearer <token>`.
 *
 *   GET    /v1/status                     versions, what was detected, client reachability, disk
 *   GET    /v1/items                      every rtorrent + nzbget item as SbItem; { errors } per client that failed
 *   GET    /v1/items/:id                  rt:<HASH> | nz:<ID>
 *   POST   /v1/items                      { kind: torrent|magnet|nzb, data?: base64, uri?, name? } → { id, client, clientId, infoHash? }
 *   DELETE /v1/items/:id                  drop from the client; data stays on disk
 *   GET    /v1/fs/stat?path=              { path, size, isDir, mtime }
 *   GET    /v1/fs/ls?path=                { entries: [{ name, size, isDir, mtime }] }
 *   GET|HEAD /v1/fs/file?path=            the bytes, with Range support (fallback data plane through the tunnel)
 */
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { RtorrentClient } from "../rtorrent";
import type { NzbgetClient } from "../nzbget";
import { parseTorrent, parseMagnet } from "../bencode";
import { fromRtorrent, fromNzbget, itemId, parseItemId, type SbItem } from "../seedbox-items";
import { Roots, FsError, statPath, listDir, fileResponse } from "./fs";

export interface BosunCtx {
  token: string;
  version: string;
  selfHash: () => string | null;
  startedAt: number;
  host: string;
  user: string;
  rtorrent: RtorrentClient | null;
  nzbget: NzbgetClient | null;
  rtOpts: { label?: string; dir?: string };
  nzbCategory: string;
  roots: Roots;
  downloadsDir: string;
  webBase: string | null;
  webRoot: string | null;
  rtorrentScgi: string | null;
  nzbgetUrl: string | null;
  diskFree?: (dir: string) => Promise<{ free: number; total: number } | null>;
  tools?: Record<string, string | null>;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createBosunApp(ctx: BosunCtx) {
  const app = new Hono();

  app.use("/v1/*", async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!tok || !safeEqual(tok, ctx.token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.onError((e, c) => {
    if (e instanceof FsError) return c.json({ error: e.message }, e.status);
    return c.json({ error: String((e as any)?.message ?? e) }, 500);
  });
  app.notFound(c => c.json({ error: "not found" }, 404));

  const probe = async (client: { version(): Promise<string> } | null, configured: string | null) => {
    if (!client) return { configured: false, ok: false, version: null, detail: "not detected" };
    try { return { configured: true, ok: true, version: await client.version(), detail: configured }; }
    catch (e: any) { return { configured: true, ok: false, version: null, detail: `${configured}: ${e?.message ?? e}` }; }
  };

  app.get("/v1/status", async c => {
    const [rtorrent, nzbget, disk] = await Promise.all([
      probe(ctx.rtorrent, ctx.rtorrentScgi), probe(ctx.nzbget, ctx.nzbgetUrl),
      ctx.diskFree ? ctx.diskFree(ctx.downloadsDir).catch(() => null) : Promise.resolve(null),
    ]);
    return c.json({
      ok: true, version: ctx.version, hash: ctx.selfHash(), uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      host: ctx.host, user: ctx.user, downloadsDir: ctx.downloadsDir, webBase: ctx.webBase, webRoot: ctx.webRoot,
      roots: ctx.roots.list(), rtorrent, nzbget, disk, tools: ctx.tools ?? {},
    });
  });

  async function allItems(): Promise<{ items: SbItem[]; errors: Record<string, string> }> {
    const errors: Record<string, string> = {};
    const [rt, nz] = await Promise.all([
      ctx.rtorrent ? ctx.rtorrent.list().catch(e => { errors.rtorrent = String(e?.message ?? e); return []; }) : [],
      ctx.nzbget ? ctx.nzbget.snapshot().catch(e => { errors.nzbget = String(e?.message ?? e); return []; }) : [],
    ]);
    if (!ctx.rtorrent) errors.rtorrent = "not detected";
    if (!ctx.nzbget) errors.nzbget = "not detected";
    return { items: [...rt.map(fromRtorrent), ...nz.map(fromNzbget)], errors };
  }

  app.get("/v1/items", async c => c.json(await allItems()));

  app.get("/v1/items/:id", async c => {
    const ref = parseItemId(c.req.param("id"));
    if (!ref) return c.json({ error: "bad id" }, 400);
    const { items } = await allItems();
    const item = items.find(i => i.client === ref.client && i.clientId === ref.clientId);
    return item ? c.json({ item }) : c.json({ error: "not found" }, 404);
  });

  app.post("/v1/items", async c => {
    const body = await c.req.json<{ kind?: string; data?: string; uri?: string; name?: string }>().catch(() => ({} as any));
    if (body.kind === "torrent" || body.kind === "magnet") {
      if (!ctx.rtorrent) return c.json({ error: "rtorrent not detected on this box" }, 503);
      let hash: string, name: string | undefined, size: number | undefined;
      if (body.kind === "magnet") {
        const m = body.uri ? parseMagnet(body.uri) : null;
        if (!m) return c.json({ error: "unparsable magnet" }, 400);
        hash = m.infoHash; name = m.name ?? undefined;
        if (!(await ctx.rtorrent.get(hash))) await ctx.rtorrent.addMagnet(body.uri!, ctx.rtOpts);
      } else {
        if (!body.data) return c.json({ error: "data (base64 .torrent) required" }, 400);
        const bytes = Buffer.from(body.data, "base64");
        let meta: ReturnType<typeof parseTorrent>;
        try { meta = parseTorrent(bytes); } catch (e: any) { return c.json({ error: `bad torrent: ${e?.message ?? e}` }, 400); }
        hash = meta.infoHash; name = meta.name; size = meta.length;
        if (!(await ctx.rtorrent.get(hash))) await ctx.rtorrent.addTorrent(bytes, ctx.rtOpts);
      }
      return c.json({ id: itemId("rtorrent", hash), client: "rtorrent", clientId: hash, infoHash: hash, name, size }, 201);
    }
    if (body.kind === "nzb") {
      if (!ctx.nzbget) return c.json({ error: "nzbget not detected on this box" }, 503);
      if (!body.data) return c.json({ error: "data (base64 .nzb) required" }, 400);
      const id = await ctx.nzbget.add(body.name || "ahoy.nzb", Buffer.from(body.data, "base64"), ctx.nzbCategory);
      return c.json({ id: itemId("nzbget", String(id)), client: "nzbget", clientId: String(id), name: body.name }, 201);
    }
    return c.json({ error: "kind must be torrent | magnet | nzb" }, 400);
  });

  app.delete("/v1/items/:id", async c => {
    const ref = parseItemId(c.req.param("id"));
    if (!ref) return c.json({ error: "bad id" }, 400);
    if (ref.client === "rtorrent") {
      if (!ctx.rtorrent) return c.json({ error: "rtorrent not detected" }, 503);
      await ctx.rtorrent.erase(ref.clientId);
    } else {
      if (!ctx.nzbget) return c.json({ error: "nzbget not detected" }, 503);
      const it = await ctx.nzbget.get(Number(ref.clientId));
      if (it) await ctx.nzbget.remove(it.id, it.inHistory);
    }
    return c.json({ deleted: c.req.param("id") });
  });

  const pathParam = (c: { req: { query(k: string): string | undefined } }) => c.req.query("path") ?? "";

  app.get("/v1/fs/stat", async c => c.json(await statPath(await ctx.roots.resolve(pathParam(c)))));
  app.get("/v1/fs/ls", async c => c.json({ entries: await listDir(await ctx.roots.resolve(pathParam(c))) }));
  app.on(["GET", "HEAD"], "/v1/fs/file", async c => fileResponse(c.req.raw, await ctx.roots.resolve(pathParam(c))));

  return app;
}
