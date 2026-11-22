/**
 * ludarr API — CrackWatch (isitcracked.com), unofficial, read-only:
 *
 *   GET /api/v1/crackwatch/games?kind=all|cracked|uncracked|denuvo|hypervisor   the site's list pages (first page, newest first)
 *   GET /api/v1/crackwatch/upcoming                                              the release calendar
 *   GET /api/v1/crackwatch/groups                                                scene groups the site tracks
 *   GET /api/v1/crackwatch/group/:name                                           a group's cracks
 *   GET /api/v1/crackwatch/game/:slug                                            one game: status, dates, DRM, group, cover, description, stores
 *   GET /api/v1/crackwatch/lookup?title=                                         the tracked game with this title (slug, then normalised name), 404 when none
 *   GET /api/v1/crackwatch/slugs                                                 every tracked slug (from the sitemap)
 */
import { Hono } from "hono";
import { CwError, cwFind, cwGame, cwGroup, cwGroups, cwList, cwSlugs, cwUpcoming, type CwListKind } from "../crackwatch";

export const crackwatchApi = new Hono();
const KINDS: CwListKind[] = ["all", "cracked", "uncracked", "denuvo", "hypervisor"];
const fail = (c: { json: (b: unknown, s?: number) => Response }, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, (e instanceof CwError ? e.status : 502) as 404 | 502);

crackwatchApi.get("/api/v1/crackwatch/games", async c => {
  const kind = (c.req.query("kind") ?? "all") as CwListKind;
  if (!KINDS.includes(kind)) return c.json({ error: `kind must be one of ${KINDS.join(", ")}` }, 400);
  try { return c.json({ kind, items: await cwList(kind) }); } catch (e) { return fail(c, e); }
});
crackwatchApi.get("/api/v1/crackwatch/upcoming", async c => { try { return c.json({ items: await cwUpcoming() }); } catch (e) { return fail(c, e); } });
crackwatchApi.get("/api/v1/crackwatch/groups", async c => { try { return c.json({ items: await cwGroups() }); } catch (e) { return fail(c, e); } });
crackwatchApi.get("/api/v1/crackwatch/group/:name", async c => { try { return c.json({ group: c.req.param("name"), items: await cwGroup(c.req.param("name")) }); } catch (e) { return fail(c, e); } });
crackwatchApi.get("/api/v1/crackwatch/game/:slug", async c => { try { return c.json({ item: await cwGame(c.req.param("slug")) }); } catch (e) { return fail(c, e); } });
crackwatchApi.get("/api/v1/crackwatch/lookup", async c => {
  const title = c.req.query("title") ?? "";
  if (!title.trim()) return c.json({ error: "title required" }, 400);
  try { const g = await cwFind(title); return g ? c.json({ item: g }) : c.json({ error: "not tracked by CrackWatch" }, 404); } catch (e) { return fail(c, e); }
});
crackwatchApi.get("/api/v1/crackwatch/slugs", async c => { try { return c.json({ items: await cwSlugs() }); } catch (e) { return fail(c, e); } });
