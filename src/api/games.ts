/**
 * ludarr API — the library.
 *
 *   GET    /api/v1/game?q=&status=&monitored=&profileId=&sort=name|added|release|status      (q matches the name and its aliases)
 *   GET    /api/v1/game/lookup?term=            "Add new": library games (by name or alias), then the catalog, Steam and IGDB
 *   GET    /api/v1/game/:id                     detail: files, history, imports, ways to play
 *   POST   /api/v1/game                         { source: steam|igdb|catalog, id, monitored?, profileId?, rootFolderId?, searchNow?, tags?, platform? }
 *                                               (platform: the version to look for when the game is on several — "arcade", "x360", "pc" …;
 *                                               one the game is on, else 400. Every game and lookup hit lists them: platformChoices / choices)
 *                                               { source: manual, game: GameDraft, posterUrl?, bannerUrl?, force?, monitored?, profileId?, rootFolderId?, searchNow?, tags? }
 *                                               → 201 { item }; 409 { error, existingId } when a game of that name and year (±1) is already in the library
 *   PUT    /api/v1/game/:id                     { monitored?, profileId?, rootFolderId?, tags?, platform? }   (platform: another version to
 *                                               look for, or null for no choice; a search under way for the old one stops, and a
 *                                               watched game without a copy is looked for again at once)
 *   PUT    /api/v1/game/:id/details             a game added by hand: any GameDraft field; any other game: { aliases?, searchTerms? } (400 naming any other field); force?
 *   PUT    /api/v1/game/:id/art/:kind           kind poster|banner|hero|logo: an image body (image/png|jpeg|webp or octet-stream; the bytes must be one, ≤ 15 MB) or JSON { url } (https, fetched once)
 *   DELETE /api/v1/game/:id/art/:kind           back to automatic art (hero and logo then have none)
 *   DELETE /api/v1/game/:id?deleteFiles=1
 *   POST   /api/v1/game/:id/search              search now (an upgrade search when the game has a copy and its profile allows upgrades;
 *                                                for a game players cannot start yet that has a way to play: that way's game file)
 *   POST   /api/v1/game/:id/refresh             re-read metadata and art from Steam / IGDB (400 for a game added by hand)
 *   GET    /api/v1/wanted/missing  ·  /api/v1/wanted/cutoff
 *   GET    /api/v1/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   GET    /api/v1/discover                     Steam storefront feeds (coming soon / new / top) for the Add page
 *   POST   /api/v1/discover/refresh
 *
 * The art writes live here, behind the API key: /api/v1/art (src/api/art.ts) is served without it and only ever reads.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { addGame, calendar, cutoffUnmet, deleteGame, gameDetail, listGames, lookup, refreshGame, resetGameArt, searchGame, setGameArt, updateDetails, updateGame, wantedMissing, LibraryError } from "../library/games";
import { RequestError } from "../requests";
import { discover, feedRows } from "../discover";
import { ArtError, fetchArtUrl, readImageBody } from "../art";
import { ART_KINDS, stmts, type ArtKind } from "../db";
import { PublicUrlError, readCapped } from "../net/public-url";

import { retainedDownloads, useDownload } from "../library/retained";
export const gamesApi = new Hono();
const status = (e: unknown): ContentfulStatusCode => (e instanceof LibraryError || e instanceof RequestError || e instanceof ArtError ? (e.status as ContentfulStatusCode) : 500);
const fail = (c: any, e: any) => c.json({ error: String(e?.message ?? e), ...(e instanceof LibraryError ? e.extra : {}) }, status(e));

gamesApi.get("/api/v1/game/lookup", async c => {
  try { return c.json({ items: await lookup(c.req.query("term") ?? "") }); } catch (e) { return fail(c, e); }
});
gamesApi.get("/api/v1/game", c => {
  const mon = c.req.query("monitored");
  return c.json({ items: listGames({ q: c.req.query("q") || undefined, status: c.req.query("status") || undefined, monitored: mon === undefined ? undefined : mon === "1" || mon === "true", profileId: Number(c.req.query("profileId")) || undefined, sort: c.req.query("sort") || undefined }) });
});
gamesApi.get("/api/v1/game/:id/downloads", c => {
  return c.json({ items: retainedDownloads(Number(c.req.param("id"))) });
});
gamesApi.post("/api/v1/game/:id/downloads/:fetch/use", async c => {
  try {
    const body = await c.req.json();
    const job = await useDownload(Number(c.req.param("id")), Number(c.req.param("fetch")), body.wayId ?? null);
    return c.json({ jobId: job.id });
  } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, (e?.status ?? 500) as ContentfulStatusCode); }
});
gamesApi.get("/api/v1/game/:id", c => {
  const g = gameDetail(Number(c.req.param("id")));
  return g ? c.json({ item: g }) : c.json({ error: "not found" }, 404);
});
gamesApi.post("/api/v1/game", async c => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json({ item: await addGame(body) }, 201); } catch (e) { return fail(c, e); }
});
gamesApi.put("/api/v1/game/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json({ item: await updateGame(Number(c.req.param("id")), body) }); } catch (e) { return fail(c, e); }
});
gamesApi.put("/api/v1/game/:id/details", async c => {
  const body = await c.req.json().catch(() => null);
  try { return c.json({ item: await updateDetails(Number(c.req.param("id")), body) }); } catch (e) { return fail(c, e); }
});

const artKind = (k: string): ArtKind => {
  if (!(ART_KINDS as readonly string[]).includes(k)) throw new LibraryError(`no such art: ${k} (it is one of ${ART_KINDS.join(", ")})`, 404);
  return k as ArtKind;
};
/** a JSON body of a few KB at most (the server takes multi-GB bodies for game files; this route never needs them): its
 *  declared length is checked first, then the bytes are counted while they stream in */
async function smallJson(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(len) && len > 65_536) throw new LibraryError("the JSON body is too large", 413);
  let bytes: Uint8Array = new Uint8Array(0);
  try { bytes = await readCapped(new Response(req.body), 65_536); }
  catch (e) { if (e instanceof PublicUrlError) throw new LibraryError("the JSON body is too large", 413); /* unreadable: below */ }
  try { const v = JSON.parse(new TextDecoder().decode(bytes)); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* below */ }
  throw new LibraryError("send JSON { url }");
}
gamesApi.put("/api/v1/game/:id/art/:kind", async c => {
  try {
    const kind = artKind(c.req.param("kind"));
    const id = Number(c.req.param("id"));
    if (!stmts.gameById.get(id)) throw new LibraryError("no such game", 404);
    const json = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";
    let img;
    if (json) {
      const { url } = await smallJson(c.req.raw);
      if (typeof url !== "string" || !url.trim()) throw new LibraryError("send { url } with an https link to the image");
      img = await fetchArtUrl(url);
    } else img = await readImageBody(c.req.raw);
    return c.json({ item: await setGameArt(id, kind, img) });
  } catch (e) { return fail(c, e); }
});
gamesApi.delete("/api/v1/game/:id/art/:kind", async c => {
  try { return c.json({ item: await resetGameArt(Number(c.req.param("id")), artKind(c.req.param("kind"))) }); } catch (e) { return fail(c, e); }
});
gamesApi.delete("/api/v1/game/:id", async c => {
  try { await deleteGame(Number(c.req.param("id")), { deleteFiles: c.req.query("deleteFiles") === "1" }); return c.json({ deleted: Number(c.req.param("id")) }); } catch (e) { return fail(c, e); }
});
gamesApi.post("/api/v1/game/:id/refresh", async c => {
  try { return c.json({ item: await refreshGame(Number(c.req.param("id"))) }); } catch (e) { return fail(c, e); }
});
gamesApi.post("/api/v1/game/:id/search", c => {
  try { const r = searchGame(Number(c.req.param("id"))); return c.json(r, r.duplicate ? 200 : 201); } catch (e) { return fail(c, e); }
});

gamesApi.get("/api/v1/wanted/missing", c => c.json({ items: wantedMissing() }));
gamesApi.get("/api/v1/wanted/cutoff", c => c.json({ items: cutoffUnmet() }));

gamesApi.get("/api/v1/calendar", c => {
  const start = c.req.query("start") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const end = c.req.query("end") ?? new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  return c.json({ start, end, items: calendar(start, end) });
});

gamesApi.get("/api/v1/discover", async c => c.json(await discover()));
gamesApi.post("/api/v1/discover/refresh", async c => {
  const r = await Promise.all((["popularcomingsoon", "popularnew", "topsellers"] as const).map(f => feedRows(f, 50, true)));
  return c.json({ refreshed: r.map((x, i) => ({ feed: ["popularcomingsoon", "popularnew", "topsellers"][i], rows: x.rows.length, stale: x.stale })) });
});
