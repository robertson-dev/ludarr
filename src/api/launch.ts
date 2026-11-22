/**
 * ludarr API — how a game's copy starts (src/library/launch.ts).
 *
 *   GET    /api/v1/game/:id/launch            the copy (packageId, kind, from: way | import, wayId), how it starts now (start: the
 *                                             whole line, where it starts, by: hand | plan | ludarr | ai, needsAhoy) and as its job
 *                                             found it (auto), the start set by hand (set) and whether this copy starts with it
 *                                             (applied, notApplied: why not), the editor's fields, the picker's programs (what
 *                                             each one's header and the package's own words say) and scripts (their first
 *                                             comment, what they run), the file count, the folders, the placeholders; editable
 *                                             false with why for a console dump or a way's copy whose way is gone;
 *                                             resettable when Reset can be asked; busy while the copy is being rebuilt
 *                                             (404: no such game, or no copy yet)
 *   GET    /api/v1/game/:id/launch/files?q=   { items: [{path, size, kind: program | script | file}], total, matched }: the copy's
 *                                             files whose path holds q (case ignored), at most 200
 *   PUT    /api/v1/game/:id/launch            { exe, argv?, cwd?, env? } → { item, warnings }: kept for the next copy of its origin
 *                                             (the way's overrides.launch, or the game's for its PC copies) and applied to the
 *                                             current copy at once (manifest and ahoy.json, launch.rev, requires); 400
 *                                             { error, errors } with each problem in words; 409 while the copy is being rebuilt,
 *                                             for a console dump, or a way's copy whose way is gone; 500 when ahoy.json cannot be
 *                                             written (nothing changed, said in words)
 *   POST   /api/v1/game/:id/launch/check      { exe, argv?, cwd?, env? } → { errors, warnings, line, needsAhoy }: what Save would say,
 *                                             in the same words, changing nothing (the editor asks it as the admin types)
 *   DELETE /api/v1/game/:id/launch            → { item }: the start set by hand goes and the copy starts as found again, also on a
 *                                             way's copy whose way is gone (404 when nothing was set by hand; 409 while the copy
 *                                             is being rebuilt or for a console dump; 500 as above)
 *   GET    /api/v1/package/:id/launch         → { launch, rev, requires, kind }: the package's start as it is now — what the launcher
 *                                             asks at Play to take a start changed in place (cheap: the row only; 404 when gone)
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { checkLaunch, LaunchError, launchFiles, launchView, packageLaunch, resetLaunch, setLaunch } from "../library/launch";

export const launchApi = new Hono();
const id = (s: string) => { const n = Number(s); return Number.isInteger(n) && n > 0 ? n : 0; };
const fail = (c: any, e: unknown) => {
  if (e instanceof LaunchError) return c.json({ error: e.message, ...(e.errors.length ? { errors: e.errors } : {}) }, e.status as ContentfulStatusCode);
  return c.json({ error: String((e as Error)?.message ?? e) }, 500);
};

launchApi.get("/api/v1/game/:id/launch", async c => {
  try { return c.json({ item: await launchView(id(c.req.param("id"))) }); } catch (e) { return fail(c, e); }
});
launchApi.get("/api/v1/game/:id/launch/files", c => {
  try { return c.json(launchFiles(id(c.req.param("id")), c.req.query("q") ?? "")); } catch (e) { return fail(c, e); }
});
launchApi.put("/api/v1/game/:id/launch", async c => {
  const body = await c.req.json().catch(() => null);
  try { return c.json(await setLaunch(id(c.req.param("id")), body)); } catch (e) { return fail(c, e); }
});
launchApi.post("/api/v1/game/:id/launch/check", async c => {
  const body = await c.req.json().catch(() => null);
  try { return c.json(await checkLaunch(id(c.req.param("id")), body)); } catch (e) { return fail(c, e); }
});
launchApi.delete("/api/v1/game/:id/launch", async c => {
  try { return c.json(await resetLaunch(id(c.req.param("id")))); } catch (e) { return fail(c, e); }
});
launchApi.get("/api/v1/package/:id/launch", c => {
  const r = packageLaunch(id(c.req.param("id")));
  return r ? c.json(r) : c.json({ error: "not found" }, 404);
});
