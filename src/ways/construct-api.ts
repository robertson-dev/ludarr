/**
 * ludarr API — ways to play made from a repo, programs built from source, and games described for a manual add.
 *
 *   POST /api/v1/plan/construct                  { repo?, gameId?, planId?, note?, contentId? } → 202 { job }: ludarr's own list
 *                                                first, the AI importer for the rest (repo defaults to the plan's when planId is
 *                                                given); 409 when neither can cover the repo, saying which, and when a plan to
 *                                                rebuild or a note is given without the AI importer set up
 *   POST /api/v1/plan/:id/build                  { wayId? } → 202 { job }: a source plan built from its recorded steps, and its
 *                                                tools; a plan built once per game (a source build that reads the game file,
 *                                                or a release kit: program.perGame) needs wayId; 409 when there is nothing to
 *                                                build, a package is not on the build allowlist, there is no build sandbox, a
 *                                                build of the plan (of that way, for a plan built per game) is already queued
 *                                                or running, or the way named is being built itself ({ error, job })
 *   POST /api/v1/game/draft                      { name?, repo? } → { draft: GameDraft, from, fields, inLibrary }: what ludarr
 *                                                knows about the game, the AI's proposal for what is still empty
 *   GET  /api/v1/plan/construct/:jobId/shot/:n   the screenshot of a construct job's smoke start (try n), image/png
 *
 * A construct job is watched like any job: GET /api/v1/import/:id (transcript, trace, lesson with the tokens it spent) and the
 * 'build' events of its progress. Once it is done its manifest is a ConstructManifest (src/ways/types.ts): {planId, wayId?,
 * game?, runId} — the carry run that takes a new plan on — and, from a carry run's repair round (queued by the run, not
 * here), what changed and how ({changed, diff}), what it asks the admin for (ask), and the tokens. Mounted after the auth
 * middleware.
 */
import { Hono, type Context } from "hono";
import { serializeJob, stmts, type GameRow } from "../db";
import { enqueueJob } from "../process/kinds";
import { aptRefused, APT_ALLOWED } from "./build";
import { constructCheck, draftGame, DraftError } from "./construct";
import { shotFile } from "./construct-tools";
import { sandboxOrAllowed } from "./sandbox";
import { assembling, buildWayId, getContent, getPlan, getWay, planBuilds, planSpec } from "./store";
import { normalizeRepo } from "./validate";

export const constructApi = new Hono();

type Json = Record<string, unknown>;
const body = async (c: Context): Promise<Json> => { const b = await c.req.json().catch(() => null); return b && typeof b === "object" && !Array.isArray(b) ? b as Json : {}; };
const idOf = (v: unknown): number | null => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isInteger(n) && n > 0 ? n : null; };
/** a model call may take a while: Bun's idle timeout must not cut the request off (Hono hands Bun's server over as c.env) */
const noIdleTimeout = (c: Context) => { try { (c.env as { timeout?: (r: Request, s: number) => void } | undefined)?.timeout?.(c.req.raw, 0); } catch { /* not under Bun.serve */ } };

constructApi.post("/api/v1/plan/construct", async c => {
  const b = await body(c);
  const planId = idOf(b.planId);
  const plan = planId ? getPlan(planId) : null;
  if (planId && !plan) return c.json({ error: "no such plan" }, 404);
  const norm = normalizeRepo(b.repo ?? plan?.repo);
  if ("error" in norm) return c.json({ error: `repo: ${norm.error}` }, 400);
  const gameId = idOf(b.gameId);
  const game = gameId ? (stmts.gameById.get(gameId) as GameRow | null) ?? null : null;
  if (gameId && !game) return c.json({ error: "no such game" }, 404);
  const contentId = idOf(b.contentId);
  if (contentId) {
    const f = getContent(contentId);
    if (!f || f.role !== "game") return c.json({ error: "no such game file" }, 404);
    if (game && f.game_id !== game.id) return c.json({ error: "that file was kept for another game" }, 409);
  }
  if (b.note !== undefined && b.note !== null && (typeof b.note !== "string" || b.note.length > 2000)) return c.json({ error: "note: text up to 2000 characters" }, 400);
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  const can = constructCheck(norm.repo, game, { plan: !!plan, note: !!note });
  if (!can.ok) return c.json({ error: can.error }, 409);
  const job = enqueueJob({ kind: "construct", repo: norm.repo, gameId: game?.id ?? null, planId: plan?.id ?? null, note, contentId }, { gameId: game?.id ?? null });
  return c.json({ job: serializeJob(job) }, 202);
});

constructApi.post("/api/v1/plan/:id/build", async c => {
  const p = getPlan(idOf(c.req.param("id")) ?? 0);
  if (!p) return c.json({ error: "no such plan" }, 404);
  const spec = planSpec(p), prog = spec.program;
  // a release kit (or a fixed file that is one) builds the game from its file on the server, once per way
  const kit = (prog.kind === "release" || prog.kind === "url") && !!prog.perGame;
  if (prog.kind !== "source" && !spec.tools && !kit) return c.json({ error: "the plan has nothing to build: its program comes ready-made (a release, a feed or a fixed file)" }, 409);
  const refused = aptRefused([...(prog.kind === "source" ? prog.apt ?? [] : []), ...(spec.tools?.apt ?? [])]);
  if (refused.length) return c.json({ error: `${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not on the build allowlist (${APT_ALLOWED})` }, 409);
  if (!sandboxOrAllowed()) return c.json({ error: kit ? "building the game from its kit needs the build sandbox (ludarr's Docker image)" : "building from source needs the build sandbox (ludarr's Docker image)" }, 409);
  const wayId = idOf((await body(c)).wayId);
  const way = wayId ? getWay(wayId) : null;
  if (wayId && (!way || way.plan_id !== p.id)) return c.json({ error: "that way to play is not one of this plan's" }, 409);
  const perGame = (prog.kind === "source" && prog.content === "build") || kit;
  if (perGame && !way) return c.json({ error: "this plan is built once per game, with its game file: build one of its ways (pass wayId)" }, 409);
  // one build at a time: of that way, for a plan built per game (another game's build may wait in the queue), else of the plan
  const busy = planBuilds(p.id).find(j => !perGame || buildWayId(j) === null || buildWayId(j) === way!.id);
  if (busy) return c.json({ error: "a build of this plan is already queued or running", job: serializeJob(busy) }, 409);
  // the way's own build takes its program from the build kept for its game: this one waits until that ends
  const asm = way ? assembling(way.id) : null;
  if (asm) return c.json({ error: "the way is being built", job: serializeJob(asm) }, 409);
  const job = enqueueJob({ kind: "build", planId: p.id, ...(way ? { wayId: way.id } : {}) }, { gameId: way?.game_id ?? null });
  return c.json({ job: serializeJob(job) }, 202);
});

constructApi.post("/api/v1/game/draft", async c => {
  noIdleTimeout(c);
  try { return c.json(await draftGame(await body(c), { signal: c.req.raw.signal })); }
  catch (e) {
    if (e instanceof DraftError) return c.json({ error: e.message }, e.status);
    return c.json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

constructApi.get("/api/v1/plan/construct/:jobId/shot/:n", async c => {
  const jobId = idOf(c.req.param("jobId")), n = idOf(c.req.param("n"));
  if (!jobId || !n) return c.json({ error: "no such screenshot" }, 404);
  const f = Bun.file(shotFile(jobId, n));
  if (!(await f.exists())) return c.json({ error: "no such screenshot" }, 404);
  return new Response(f, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
});
