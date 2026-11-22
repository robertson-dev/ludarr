/**
 * ludarr API — art, served without the API key (an <img> cannot send headers), only ever images, and only ever read:
 * art is set behind the key (PUT/DELETE /api/v1/game/:id/art/:kind in src/api/games.ts).
 *
 *   GET /api/v1/art/game/:id/poster      the game's own poster when the admin set one, else its cover (resolved from Steam / IGDB / GameTDB / libretro when missing), else a placeholder
 *   GET /api/v1/art/game/:id/banner      its own banner, else its wide art, else its own poster, else its cover, else a placeholder
 *   GET /api/v1/art/game/:id/hero        its own hero image (404 when it has none)
 *   GET /api/v1/art/game/:id/logo        its own logo (404 when it has none)
 *   GET /api/v1/art/title/:id/poster     a catalog title's cover (Add New), resolved the same way
 *   GET /api/v1/art/steam/:appid/poster  a Steam app's library capsule (Discover / Add New hits), else a placeholder (?n=<name>)
 *   GET /api/v1/art/url?u=<https url>    an image from an allowed host (Steam, GameTDB, IGDB, libretro), cached
 *
 * A game's own art is served with a short cache life; a client keeping it longer keys its copy by the game's customArtAt.
 */
import { Hono } from "hono";
import { formerName } from "../former";
import { db, stmts, type GameRow } from "../db";
import { cachedImage, customArtFile, placeholderSvg, resolveGameArt, resolveTitleArt, steamPoster, type CachedImage, type TitleArtRow } from "../art";

export const artApi = new Hono();

/** on everything served here: the browser takes the type as given (a file is never guessed into a page), and should one be
 *  opened as a page of its own, it loads nothing, runs nothing and is no part of ludarr's origin (these routes take no key) */
const INERT = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
/** an Ahoy from before the engine was renamed reads the placeholder mark under this name */
const OLD_MARK = formerName("x-ludarr-art");
const serve = (img: { path: string; type: string } | null, name: string, kind: "poster" | "banner") =>
  img ? new Response(Bun.file(img.path), { headers: { "content-type": img.type, "cache-control": "public, max-age=86400", ...INERT } })
      : new Response(placeholderSvg(name, kind), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600", "x-ludarr-art": "placeholder", [OLD_MARK]: "placeholder", ...INERT } });
const serveOwn = (img: CachedImage) =>
  new Response(Bun.file(img.path), { headers: { "content-type": img.type, "cache-control": "public, max-age=300", "x-ludarr-art": "custom", [OLD_MARK]: "custom", ...INERT } });

artApi.get("/api/v1/art/game/:id/:kind", async c => {
  const g = stmts.gameById.get(Number(c.req.param("id"))) as GameRow | undefined;
  const asked = c.req.param("kind");
  // hero and logo exist only as the game's own; any other name is the poster, as it always was
  if (asked === "hero" || asked === "logo") {
    const own = g ? await customArtFile(g, asked) : null;
    return own ? serveOwn(own) : c.json({ error: `no ${asked} for this game` }, 404);
  }
  const kind = asked === "banner" ? "banner" : "poster";
  if (!g) return serve(null, "?", kind);
  const own = await customArtFile(g, kind);
  if (own) return serveOwn(own);
  const art = await resolveGameArt(g);
  if (kind === "banner") {
    if (art.banner) return serve(await cachedImage(art.banner), g.name, kind);
    const ownPoster = await customArtFile(g, "poster");
    if (ownPoster) return serveOwn(ownPoster);
  }
  return serve(art.cover ? await cachedImage(art.cover) : null, g.name, kind);
});

artApi.get("/api/v1/art/title/:id/:kind", async c => {
  const t = db.query("SELECT id, name, cover_url, hero_url, platforms_json FROM titles WHERE id=?").get(Number(c.req.param("id"))) as TitleArtRow | undefined;
  const kind = c.req.param("kind") === "banner" ? "banner" : "poster";
  if (!t) return serve(null, "?", kind);
  const art = await resolveTitleArt(t);
  const url = kind === "banner" ? art.banner ?? art.cover : art.cover;
  return serve(url ? await cachedImage(url) : null, t.name, kind);
});

artApi.get("/api/v1/art/steam/:appid/poster", async c => {
  const appId = Number(c.req.param("appid"));
  const name = (stmts.catalogGet.get(appId) as { name?: string } | undefined)?.name ?? c.req.query("n") ?? String(appId);
  if (!Number.isInteger(appId) || appId <= 0) return serve(null, name, "poster");
  const url = await steamPoster(appId);
  return serve(url ? await cachedImage(url) : null, name, "poster");
});


artApi.get("/api/v1/art/url", async c => {
  const u = c.req.query("u") ?? "";
  const img = await cachedImage(u);
  return img ? serve(img, "", "poster") : c.json({ error: "no image there (or the host is not allowed)" }, 404);
});
