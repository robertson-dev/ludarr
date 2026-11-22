/**
 * ludarr API — activity.
 *
 *   GET    /api/v1/queue                         searches in flight, each with its download and import (and, for one that took
 *                                                  nothing, `refused`: the releases it found and why each was not taken)
 *   DELETE /api/v1/queue/:id?blocklist=1          cancel (and blocklist the release)
 *   POST   /api/v1/queue/:id/retry?fresh=1        search again (fresh = forget what was tried); a search waiting on the seedbox
 *                                                  (or stopped after 72 h of it): tried now, nothing searched again
 *   GET    /api/v1/download                       download rows (newest first; retryAt: a transfer the seedbox broke off is tried
 *                                                  again then);  POST /api/v1/download/:id/retry (also: try a waiting transfer now);
 *                                                  DELETE /api/v1/download/:id?purge=1
 *   POST   /api/v1/download/:id/arrival           { choice: "seedbox" | "now" | "wait" | "again" } — a download awaited in the
 *                                                  finished-downloads folder (src/arrivals.ts): import it from the seedbox instead,
 *                                                  import what has arrived (usenet), keep waiting, or download the same release
 *                                                  again — the choices the Queue offers it (`waiting.ask.choices`)
 *   GET    /api/v1/history?page=&pageSize=&gameId=
 *   GET    /api/v1/blocklist  ·  DELETE /api/v1/blocklist/:id  ·  DELETE /api/v1/blocklist
 *   GET    /api/v1/release?gameId=|term=&year=&aliases=&terms=&loose=1&protocol=&limit=&scope=console      interactive search
 *                                                  (aliases/terms repeat, one value each, ≤ 5 and ≤ 3; a game's own are used when none are given);
 *                                                  every release, each with `refusals` (why the automatic searcher would not
 *                                                  take it, in words; `certain` = none) and `allowed` (it would, profile and all)
 *   POST   /api/v1/release                        { guid, instanceId, gameId } → grab a release by hand
 *   GET    /api/v1/import  ·  GET /api/v1/import/:id (transcript, fingerprint, trace, lesson)  ·  POST /api/v1/import { path, gameId?, replace? }
 *   PATCH  /api/v1/import/:id/lesson { adopted }  ·  GET /api/v1/import/lessons
 *   GET    /api/v1/package  ·  /api/v1/package/:id  ·  GET|HEAD /api/v1/package/:id/files/*  ·  DELETE /api/v1/package/:id?purge=1
 *          (one package also says `blocks`: how a launcher can take it in a few requests, src/api/blocks.ts)
 */
import { Hono } from "hono";
import { CONSOLE_CATEGORIES, CONSOLE_PLATFORMS, consolePlatforms, hasPc, type PlatformId } from "../platforms";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { removeTree } from "../fsutil";
import { blocksOf } from "../blocks";
import { stmts, serializeRequest, serializeFetch, serializeJob, serializePackage, type RequestRow, type FetchRow, type JobRow, type PackageRow, type HistoryRow, type BlockRow, type GameRow } from "../db";
import { events } from "../events";
import { cancelRequest, retryRequest, installClass, orderCandidates, autoContext, automaticRefusals, profileRefusals, consoleFallback, gameBlocklist, isBlocked, mayVouch, RequestError, grabManually } from "../requests";
import { grab, retry as retryFetch, remove as removeFetch, FetchError, troubleOf } from "../fetch";
import { arrivalOf, ArrivalError, chooseArrival, choicesOf, type ArrivalChoice } from "../arrivals";
import { searchReleases, recall, SearchError } from "../search";
import type { ReleaseView } from "../releases";
import { serializeHistory } from "../library/history";
import { profileFor } from "../library/profiles";
import { Roots, FsError, fileResponse } from "../bosun/fs";
import { validateGameDraft } from "../ways/validate";
import { unbuildWays } from "../ways/store";
import { cancelJob } from "../process/runner";
import { simulateDecision, simulationCase } from "../process/simulation";
import { exercises, practiceImport, type Exercise } from "../process/import-exercise";
import { rootFolderFor, workDirFor } from "../library/rootfolders";
import { cxdeps } from "../ways/construct";
import { pdeps } from "../process/deps";

const jsonList = (s: string | null | undefined): string[] => { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };

export const activityApi = new Hono();
const status = (e: unknown): ContentfulStatusCode => (e instanceof RequestError || e instanceof FetchError || e instanceof SearchError || e instanceof ArrivalError ? (e.status as ContentfulStatusCode) : 500);
const fail = (c: any, e: any) => c.json({ error: String(e?.message ?? e) }, status(e));

/* ─────────── queue ─────────── */

/** a search's wait on the seedbox (src/remote.ts): its own (requests.remote_json), or its download's transfer (fetches
 *  trouble_json with retry_at) — what the Queue offers "Retry now" for; a stopped one stays in the Queue until it is resolved */
function waitingOf(r: RequestRow, f: FetchRow | undefined): { kind: string; since: number; stopped: boolean; nextTryAt: number | null; words: string; ask?: { why: string; choices: ArrivalChoice[] } | null } | null {
  // its download awaited in the finished-downloads folder (src/arrivals.ts), and the question the admin may answer (with the choices that
  // can be made now) — none while nothing is asked (a question put off by "keep waiting" comes back by itself)
  const a = f?.state === "arriving" ? arrivalOf(f) : null;
  if (a && !a.stopped) {
    const choices = choicesOf(f!, a);
    return { kind: "arrival", since: a.since, stopped: false, nextTryAt: null, words: a.words, ask: a.ask && choices.length ? { why: a.ask.why, choices } : null };
  }
  try {
    const w = r.remote_json ? JSON.parse(r.remote_json) : null;
    if (w && typeof w.since === "number" && (w.stopped || w.jobId != null || r.next_try_at != null)) return { kind: String(w.kind ?? ""), since: w.since, stopped: !!w.stopped, nextTryAt: r.next_try_at ?? null, words: String(w.words ?? "") };
  } catch { /* none */ }
  const t = f?.state === "seedbox_done" ? troubleOf(f) : null;
  if (t && (f!.retry_at || t.stopped)) return { kind: "pull", since: t.since, stopped: !!t.stopped, nextTryAt: f!.retry_at ?? null, words: t.words };
  return null;
}

activityApi.get("/api/v1/queue", c => {
  const items = (stmts.requestsAll.all() as RequestRow[]).filter(r => ["requested", "matching", "fetching", "processing"].includes(r.state) || (r.done_at && Date.now() / 1000 - r.done_at < 3600) || (r.state === "failed" && /"stopped":true/.test(r.remote_json ?? ""))).map(r => {
    const f = r.fetch_id ? (stmts.fetchById.get(r.fetch_id) as FetchRow | undefined) : undefined;
    const j = r.job_id ? (stmts.jobById.get(r.job_id) as JobRow | undefined) : undefined;
    let refused: unknown = null;
    try { refused = r.refused_json ? JSON.parse(r.refused_json) : null; } catch { /* none */ }
    return { ...serializeRequest(r), refused, waiting: waitingOf(r, f), download: f ? serializeFetch(f) : null, import: j ? serializeJob(j) : null };
  });
  return c.json({ items });
});
activityApi.delete("/api/v1/queue/:id", async c => {
  const id = Number(c.req.param("id"));
  const r = stmts.requestById.get(id) as RequestRow | undefined;
  if (!r) return c.json({ error: "not found" }, 404);
  if (c.req.query("blocklist") === "1" && r.release_json) {
    try { const rel = JSON.parse(r.release_json); stmts.insertBlock.run(r.game_id, rel.guid ?? null, rel.title, rel.indexer ?? null, "removed from the queue"); } catch { /* ignore */ }
  }
  // the job the search is following stops as the admin's cancel (a carry run then waits for the admin instead of starting
  // it again); cancelRequest stops the same job, which by then is stopped already, and the first to ask is the one kept
  const j = r.job_id ? (stmts.jobById.get(r.job_id) as JobRow | undefined) : undefined;
  if (j && ["requested", "matching", "fetching", "processing"].includes(r.state) && (j.request_id === r.id || (j.kind ?? "import") === "import")) cancelJob(j.id, "cancelled by the admin", "admin");
  try { await cancelRequest(id, true); return c.json({ deleted: id }); } catch (e) { return fail(c, e); }
});
activityApi.post("/api/v1/queue/:id/retry", c => {
  try { return c.json({ item: retryRequest(Number(c.req.param("id")), { fresh: c.req.query("fresh") === "1" }) }); } catch (e) { return fail(c, e); }
});

/* ─────────── downloads (the raw rows) ─────────── */

activityApi.get("/api/v1/download", c => c.json({ items: (stmts.allFetches.all() as FetchRow[]).map(serializeFetch) }));
activityApi.post("/api/v1/download/:id/retry", c => { try { return c.json({ item: retryFetch(Number(c.req.param("id"))) }); } catch (e) { return fail(c, e); } });
activityApi.post("/api/v1/download/:id/arrival", async c => {
  const body = await c.req.json<{ choice?: string }>().catch(() => ({} as { choice?: string }));
  const choice = String(body.choice ?? "");
  if (!["seedbox", "now", "wait", "again"].includes(choice)) return c.json({ error: "choice must be seedbox, now, wait or again" }, 400);
  try { return c.json({ item: serializeFetch(await chooseArrival(Number(c.req.param("id")), choice as ArrivalChoice)) }); } catch (e) { return fail(c, e); }
});
activityApi.delete("/api/v1/download/:id", async c => { try { await removeFetch(Number(c.req.param("id")), c.req.query("purge") === "1"); return c.json({ deleted: Number(c.req.param("id")) }); } catch (e) { return fail(c, e); } });

/* ─────────── history / blocklist ─────────── */

activityApi.get("/api/v1/history", c => {
  const gameId = Number(c.req.query("gameId"));
  if (gameId) return c.json({ items: (stmts.historyForGame.all(gameId) as HistoryRow[]).map(serializeHistory), total: null });
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query("pageSize") ?? 50)));
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  return c.json({ items: (stmts.historyAll.all(pageSize, (page - 1) * pageSize) as HistoryRow[]).map(serializeHistory), total: (stmts.historyCount.get() as { n: number }).n, page, pageSize });
});
activityApi.get("/api/v1/blocklist", c => c.json({ items: (stmts.blocklistAll.all() as BlockRow[]).map(b => ({ id: b.id, gameId: b.game_id, gameName: b.game_name ?? null, guid: b.guid, title: b.title, indexer: b.indexer, reason: b.reason, at: b.created_at })) }));
activityApi.delete("/api/v1/blocklist/:id", c => { stmts.deleteBlock.run(Number(c.req.param("id"))); return c.json({ deleted: Number(c.req.param("id")) }); });
activityApi.delete("/api/v1/blocklist", c => { stmts.clearBlocklist.run(); return c.json({ cleared: true }); });

/* ─────────── interactive search ─────────── */

activityApi.get("/api/v1/release", async c => {
  const t0 = Date.now();
  let name = c.req.query("term")?.trim() ?? "";
  let year: number | null = Number(c.req.query("year")) || null;
  let game: GameRow | undefined;
  // the other names a game goes by, the admin's extra queries and its platforms: a saved game's own, unless the request
  // lists them (?aliases=…&aliases=…&terms=…&platforms=…, one value each — how "Test the search" asks for a game not saved yet)
  const asked = validateGameDraft({ ...(c.req.queries("aliases") ? { aliases: c.req.queries("aliases") } : {}), ...(c.req.queries("terms") ? { searchTerms: c.req.queries("terms") } : {}), ...(c.req.queries("platforms") ? { platforms: c.req.queries("platforms") } : {}) }, { partial: true });
  if (!asked.ok || !asked.value) return c.json({ error: asked.errors.join("; ") }, 400);
  let aliases = asked.value.aliases, terms = asked.value.searchTerms;
  let plats: string[] | undefined = asked.value.platforms;
  if (c.req.query("gameId")) {
    game = stmts.gameById.get(Number(c.req.query("gameId"))) as GameRow | undefined;
    if (!game) return c.json({ error: "no such game" }, 404);
    name = game.name; year = game.release_year ?? (game.release_iso ? Number(game.release_iso.slice(0, 4)) : null);
    aliases ??= jsonList(game.aliases_json); terms ??= jsonList(game.search_terms_json); plats ??= jsonList(game.platforms_json);
  }
  if (!name) return c.json({ error: "term or gameId required" }, 400);
  const limit = Math.min(Number(c.req.query("limit") ?? 60) || 60, 200);
  try {
    const profile = profileFor(game);
    // a saved game, or a draft that names its platforms, is judged as its automatic search will judge it
    const judged = !!game || plats !== undefined;
    const platforms = plats ?? [];
    const want = consolePlatforms(platforms);
    const consoleGame = judged && !hasPc(platforms) && want.length > 0;
    const scope = c.req.query("scope");                                          // "console": the console pass by itself
    const base = { loose: c.req.query("loose") === "1", protocol: c.req.query("protocol"), aliases: aliases ?? [], terms: terms ?? [] };
    const consolePass = (platforms: PlatformId[]) => searchReleases(name, year, { ...base, categories: CONSOLE_CATEGORIES, platforms, known: want });
    // the PC pass always comes first — a console game can have a PC port or a recompilation, and that is the copy to have
    let res = scope === "console" ? await consolePass(want.length ? want : CONSOLE_PLATFORMS) : await searchReleases(name, year, base);
    // what the automatic searcher does next: nothing on PC it would take → the console dumps follow, for the consoles it would
    // look at (src/requests.ts consoleFallback); the game's dates, CrackWatch's verdict and what the profile could take are what
    // the automatic searcher reads too (a draft: its year)
    const now = Date.now(), facts = game ?? (year ? { release_year: year } : null);
    const blocked = game ? gameBlocklist(game.id) : new Set<string>();
    const takeable = (r: ReleaseView) => profileRefusals(r, profile, { blocked }).length === 0;
    const vouch = mayVouch(profile, blocked);
    const pc = autoContext(res.ranked, facts, now, takeable, vouch);
    const consoles = scope !== "console" && judged && (profile.consoleFallback || consoleGame) && !res.ranked.some(r => takeable(r) && automaticRefusals(r, pc).length === 0) ? consoleFallback(platforms, pc) : null;
    if (consoles) {
      const more = await consolePass(consoles).catch(() => null);
      if (more) res = { ...res, searched: [...res.searched, ...more.searched.map(t => `${t} (console)`)], raw: res.raw + more.raw, ranked: [...res.ranked, ...more.ranked], errors: [...res.errors, ...more.errors] };
    }
    const allowed = new Set(orderCandidates(res.ranked, profile, { preferUsenet: true, blocked, game: facts, now }).map(r => `${r.instanceId}:${r.guid}`));
    const ctx = autoContext(res.ranked, facts, now, takeable, vouch);
    return c.json({
      game: { name, gameId: game?.id ?? null, year, aliases: base.aliases, terms: base.terms, platforms: [...(hasPc(platforms) ? ["pc"] : []), ...want] }, query: res.query, queries: res.queries, searched: res.searched, raw: res.raw, total: res.ranked.length, errors: res.errors, elapsedMs: Date.now() - t0,
      items: res.ranked.slice(0, limit).map(r => {
        const refusals = automaticRefusals(r, ctx);
        return { ...r, format: installClass(r), refusals, certain: refusals.length === 0, allowed: allowed.has(`${r.instanceId}:${r.guid}`), blocked: isBlocked(blocked, r) };
      }),
    });
  } catch (e) { return fail(c, e); }
});
activityApi.post("/api/v1/release", async c => {
  const body = await c.req.json<{ guid?: string; instanceId?: number; gameId?: number }>().catch(() => ({} as { guid?: string; instanceId?: number; gameId?: number }));
  const release = body.guid && body.instanceId != null ? recall(Number(body.instanceId), body.guid) : null;
  if (!release) return c.json({ error: "pass {guid, instanceId} from a recent search" }, body.guid ? 404 : 400);
  const gameId = body.gameId != null ? Number(body.gameId) : null;
  if (gameId != null && !stmts.gameById.get(gameId)) return c.json({ error: "no such game" }, 404);
  try {
    if (gameId != null) { const r = await grabManually(release, gameId); return c.json(r, 201); }
    const { fetch, duplicate } = await grab(release, null);
    return c.json({ download: fetch, duplicate }, duplicate ? 200 : 201);
  } catch (e) { return fail(c, e); }
});

/* ─────────── imports ─────────── */

activityApi.get("/api/v1/import/lessons", c => {
  const runs = (stmts.agentRuns.all() as JobRow[]).map(j => {
    const v = serializeJob(j, true);
    const steps = Array.isArray(v.trace) ? v.trace.filter((s: { kind?: string }) => s.kind === "tool").length : 0;
    return { ...v, gameName: j.game_name ?? null, trace: undefined, transcript: undefined, toolSteps: steps };
  });
  return c.json({ items: runs, open: runs.filter(r => r.lesson && !r.lesson.adopted).length });
});
activityApi.get("/api/v1/import", c => c.json({ items: (stmts.jobsAll.all() as JobRow[]).map(j => serializeJob(j)) }));
activityApi.get("/api/v1/import/:id", c => {
  const j = stmts.jobById.get(Number(c.req.param("id"))) as JobRow | undefined;
  return j ? c.json({ item: serializeJob(j, true) }) : c.json({ error: "not found" }, 404);
});
/** The importer on a miniature release. The scripted reference runs locally without a model. */
let practicing = false;
activityApi.post("/api/v1/simulation/import", async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || !exercises.includes(body.exercise) || !["reference", "model"].includes(body.caller) ||
      (body.instruction !== undefined && (typeof body.instruction !== "string" || body.instruction.length > 2000)))
    return c.json({ error: "Choose an exercise and a caller. Instructions can be up to 2,000 characters." }, 400);
  if (practicing) return c.json({ error: "An import exercise is already running." }, 409);
  const ai = body.caller === "model" ? cxdeps.ai() : null;
  if (body.caller === "model" && !ai) return c.json({ error: "Configure the AI importer to test the current model." }, 409);
  practicing = true;
  try {
    const item = await practiceImport(body.exercise as Exercise, { instruction: body.instruction, signal: c.req.raw.signal,
      ...(ai ? { model: ai.model, caller: cxdeps.caller(ai, { retries: 0, timeoutMs: 90000 }) } : {}) });
    return c.json({ item });
  } finally { practicing = false; }
});

/** Reconsider one recorded decision. A trial only calls the configured model. */
const simulating = new Set<number>();
activityApi.post("/api/v1/import/:id/simulate", async c => {
  const j = stmts.jobById.get(Number(c.req.param("id"))) as JobRow | undefined;
  if (!j) return c.json({ error: "Job not found." }, 404);
  if (!["done", "failed", "cancelled"].includes(j.state)) return c.json({ error: "Wait for this job to finish." }, 409);
  if (!simulationCase(j).brief && j.state !== "failed") return c.json({ error: "This job has no recorded AI decisions or failure." }, 409);
  const raw: unknown = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error: "Expected a simulation request." }, 400);
  const { turn, instruction = "" } = raw as { turn?: number; instruction?: string };
  if ((turn !== undefined && (!Number.isSafeInteger(turn) || turn <= 0)) || typeof instruction !== "string" || instruction.length > 2000)
    return c.json({ error: "Choose a valid turn and an instruction of up to 2,000 characters." }, 400);
  const ai = cxdeps.ai();
  if (!ai) return c.json({ error: "Configure the AI importer under Settings → Importers to simulate a decision." }, 409);
  if (simulating.has(j.id)) return c.json({ error: "A simulation for this job is already running." }, 409);
  const game = j.game_id ? stmts.gameById.get(j.game_id) as GameRow | null : null;
  const root = rootFolderFor(game);
  const work = join(root ? workDirFor(root) : "/work", `job-${j.id}`);
  const tools = pdeps.tools();
  const name = game?.name || "this game";
  const fallback = (j.kind ?? "import") === "import"
    ? { mode: "import" as const, gameName: name, input: j.input_path, staging: join(work, "staging"), work, tools, lessons: [] }
    : { mode: "construct" as const, tools, lessons: [] };
  simulating.add(j.id);
  try {
    const item = await simulateDecision({ job: { ...j, game_name: name }, turn, instruction, fallback,
      model: ai.model, callModel: cxdeps.caller(ai, { retries: 0, timeoutMs: 90000 }), signal: c.req.raw.signal });
    return c.json({ item });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, e instanceof RangeError ? 400 : 502);
  } finally { simulating.delete(j.id); }
});

/** import something already on disk (a manual download) without a search */
activityApi.post("/api/v1/import", async c => {
  const body = await c.req.json<{ path?: string; gameId?: number; replace?: boolean }>().catch(() => ({} as { path?: string; gameId?: number; replace?: boolean }));
  if (!body.path) return c.json({ error: "path required" }, 400);
  if (!(await stat(body.path).catch(() => null))) return c.json({ error: "no such path" }, 404);
  // replace: the admin chose to put this copy in place of a built way to play (an import never does that on its own)
  const j = (body.replace === true
    ? stmts.insertJobOf.get(null, null, body.gameId ?? null, body.path, "import", JSON.stringify({ replace: true }), null)
    : stmts.insertJob.get(null, null, body.gameId ?? null, body.path)) as JobRow;
  events.emit("job", serializeJob(j));
  return c.json({ item: serializeJob(j) }, 201);
});
activityApi.patch("/api/v1/import/:id/lesson", async c => {
  const j = stmts.jobById.get(Number(c.req.param("id"))) as JobRow | undefined;
  if (!j) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ adopted?: string | null }>().catch(() => ({} as { adopted?: string | null }));
  let lesson: Record<string, unknown> = {};
  try { lesson = j.lesson_json ? JSON.parse(j.lesson_json) : {}; } catch { /* start over */ }
  if (body.adopted) lesson.adopted = String(body.adopted).slice(0, 500); else delete lesson.adopted;
  stmts.setJobLesson.run(JSON.stringify(lesson), j.id);
  return c.json({ item: serializeJob(stmts.jobById.get(j.id) as JobRow) });
});

/* ─────────── packages: the imported copies, served to clients ─────────── */

activityApi.get("/api/v1/package", c => c.json({ items: (stmts.packagesAll.all() as PackageRow[]).map(p => serializePackage(p)) }));
activityApi.get("/api/v1/package/:id", c => {
  const p = stmts.packageById.get(Number(c.req.param("id"))) as PackageRow | undefined;
  // blocks: {size, count, digest} when the package can be taken as blocks (src/blocks.ts), else null
  return p ? c.json({ item: { ...serializePackage(p, true), blocks: blocksOf(p) } }) : c.json({ error: "not found" }, 404);
});
activityApi.on(["GET", "HEAD"], "/api/v1/package/:id/files/*", async c => {
  const p = stmts.packageById.get(Number(c.req.param("id"))) as PackageRow | undefined;
  if (!p) return c.json({ error: "not found" }, 404);
  const rel = decodeURIComponent(c.req.path.replace(/^\/api\/v1\/package\/\d+\/files\//, ""));
  if (!rel || rel.includes("..")) return c.json({ error: "bad path" }, 400);
  try {
    const root = resolve(p.path);
    const roots = await Roots.of([root]);
    return await fileResponse(c.req.raw, await roots.resolve(join(root, rel)));
  } catch (e) {
    if (e instanceof FsError) return c.json({ error: e.message }, e.status as ContentfulStatusCode);
    return c.json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
activityApi.delete("/api/v1/package/:id", async c => {
  const p = stmts.packageById.get(Number(c.req.param("id"))) as PackageRow | undefined;
  if (!p) return c.json({ error: "not found" }, 404);
  if (c.req.query("purge") === "1") await removeTree(p.path);
  stmts.deletePackage.run(p.id);
  unbuildWays(p.id, "its copy was removed");                               // the ways settle; the event refreshes the catalog
  events.emit("package", { id: p.id, deleted: true });
  return c.json({ deleted: p.id });
});
