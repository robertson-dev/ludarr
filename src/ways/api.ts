/**
 * ludarr API — ways to play: runtime plans (how to get, set up and start one program), ways (a game played through a
 * plan), the game files and system files they need, and the jobs that take files in and build packages.
 *
 *   GET    /api/v1/plan                           every plan, with how many ways use it and whether its needs are met
 *   GET    /api/v1/plan/:id                       + its ways and each need slot with the file that fills it
 *   POST   /api/v1/plan                           { repo, name, kind, spec, platforms?, homepage? } → a draft (201, with warnings)
 *   PUT    /api/v1/plan/:id                       { name?, kind?, repo?, spec?, platforms?, homepage? } re-checked; a changed program,
 *                                                  kind or repo makes it a draft again, and a changed program or repo drops what
 *                                                  was pinned (409 for those while one of its ways is being built, and for the
 *                                                  program, tools or repo while a build of the plan is queued or running)
 *   DELETE /api/v1/plan/:id?force=1               409 while ways or system files use it, unless forced (then they go with it);
 *                                                  its carry runs stop and the jobs they started are cancelled
 *   POST   /api/v1/plan/:id/check                 the program's latest release now → { release, picks, pinned, newer, item }:
 *                                                  ready when the pattern picks a file, broken when it does not (or the pinned file changed);
 *                                                  a plan built from source with each game's file is ready once it validates
 *   POST   /api/v1/plan/:id/needs/:i/file?name=   a system file (BIOS, firmware, keys) as the raw body; refused unless it fits the need
 *   POST   /api/v1/plan/:id/needs/:i/path         { path } a file already on the server → 202 { job }
 *   GET    /api/v1/game/:id/ways                  the game's ways: plan, game file and its verdict, the game's copy and what it is to the
 *                                                  way, needs, what stands in the way of a build, the way's carry run
 *   POST   /api/v1/game/:id/ways                  { planId, content?, overrides?, force? } (an emulator way gets a content plan of
 *                                                  its own: this game's names, the plan's place and formats); 409 { error,
 *                                                  wrongGame: true } for a recomp or port plan whose game is not this one, unless
 *                                                  force; a way added is carried through (src/ways/carry.ts)
 *   PUT    /api/v1/way/:id                        { content?, overrides?, contentId? } (a file that does not fit: 409 with the reason);
 *                                                  overrides.launch (how the game starts, set by hand) is kept as it is: it changes
 *                                                  through PUT/DELETE /api/v1/game/:id/launch (src/api/launch.ts)
 *   DELETE /api/v1/way/:id                        the package it built stays; its carry runs stop
 *   POST   /api/v1/way/:id/build                  { replace?, repin? } → 202 { job }: the assemble; a make first when the way's file is made
 *                                                  from the game's copy or a kept dump, the program's build for this game first when the
 *                                                  plan builds it per game (each queues the assemble when it ends) — one press builds (409:
 *                                                  plan not ready, a need unmet, no game file, or a PC copy it would replace without replace)
 *   POST   /api/v1/way/:id/find-files             a search for the way's game file on the indexers → 202 { request, duplicate } (the
 *                                                  queue shows it; the catalog's and the dump list's serials for the game join the
 *                                                  way's, never one the admin took off; 409 when the way has its file, is being
 *                                                  built, its plan is not ready, it needs no file or PC data, or a file a search
 *                                                  brought that this way cannot tell apart either waits for a look)
 *   POST   /api/v1/way/:id/accept-file            { contentId } take a file by hand: its sha1 joins the way's own accepted hashes
 *   GET    /api/v1/content?gameId=|planId=        a game's game files, a plan's system files, or every kept file
 *   POST   /api/v1/content?gameId=&name=&platform=&wayId=   a game file as the raw body (attached to each of the game's ways it fits;
 *                                                  named for a way, it is that way's console's unless the file says otherwise)
 *   POST   /api/v1/content/path                   { path, gameId, wayId? } a file already on the server → 202 { job }
 *   GET    /api/v1/content/:id/check?wayId=       the file against one way (a system file: against its need)
 *   DELETE /api/v1/content/:id                    the only way a kept file is deleted
 *   GET    /api/v1/jobs?kind=                     the newest 100 jobs of every kind (import, construct, assemble, content, build, make)
 *   POST   /api/v1/jobs/:id/cancel                a queued job is cancelled, a running one stopped
 *
 * Mounted after the auth middleware (src/server.ts): every route wants the API key. After every plan, way or file
 * change the custom catalog source is ingested again, so the game's Ways to play follow at once.
 */
import { Hono, type Context } from "hono";
import "./hooks";   // the ways meet the rest of the engine (dump hand-off, catalog refresh, the assemble kind)
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config";
import { db, serializeJob, stmts, type GameRow, type JobRow } from "../db";
import { logger } from "../log";
import { latestRelease, RateLimited } from "../catalog/github";
import { dropPlanRuntime, reingestCustom } from "../catalog/providers/custom";
import { scopeProblem } from "./emulator-scope";
import { setRuntimeRelease } from "../catalog/store";
import type { RuntimeRelease } from "../catalog/types";
import { publicFetch, PublicUrlError } from "../net/public-url";
import { platformId, type PlatformId } from "../platforms";
import { enqueueJob } from "../process/kinds";
import { cancelJob } from "../process/runner";
import {
  attachToWays, checkContent, checkServerPath, ContentError, gameTarget, ingestUpload, namedWayPlatform, needAccept, needTarget, removeContent,
} from "./content";
import { secondCopyOf } from "./copy";
import { EnvError } from "./errors";
import { contentMatches, needMatches } from "./match";
import { findRefusal, heldFor, prepareContentPass, recordDroppedSerials, refreshSerials } from "./find";
import { createRequest, FOR_WAY, RequestError } from "../requests";
import { addWay, shipProblem } from "./attach";
import { copyView, crdeps, pokeRuns, runFor, startRun, stopRunsOfPlan, stopRunsOfWay, wayFileRoute } from "./carry";
import { sizeWords } from "./asks";
import {
  assembling, buildingFor, contentFacts, currentPackage, gameFiles, getContent, getPlan, getWay, insertPlan, making, planBuilds, planNeeds, planPinned, planSpec,
  planWaysCount, serializeContent, serializePlan, serializeWay, settleWay, settleWaysOfPlan, systemFiles, updatePlan, updateWay,
  wayContent, wayOverrides, waysOfGame, waysOfPlan, wstmts, type ContentRow, type PlanRow, type WayRow,
} from "./store";
import { PLAN_KINDS, type ContentPlan, type JobKind, type JobSpec, type PlanKind, type RuntimePlanSpec } from "./types";
import { CONTENT_PLATFORMS, normalizeRepo, storeName, validatePlanSpec, validateWayContent, validateWayOverrides } from "./validate";

export const waysApi = new Hono();
const log = logger("ways");

/** every release check goes through the public-address guard: a forgejo host is typed by whoever wrote the plan */
const guardedFetch = ((url: string | URL | Request, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  return publicFetch(url instanceof Request ? url.url : String(url), { method: init?.method, signal: init?.signal ?? undefined, headers });
}) as typeof fetch;

/** swapped in tests */
export const wdeps = {
  latestRelease: (repo: string, pattern: string | null, channel: string | null, f: typeof fetch) => latestRelease(repo, pattern, channel, f),
  fetch: guardedFetch,
  /** stops a job: a running one through its abort signal, a queued one marked cancelled (its kind's cancel hook runs); a carry
   *  run that started it is held until the admin resumes it */
  cancelRunning: (id: number) => cancelJob(id, "cancelled by the admin", "admin"),
  /** where a source plan's finished build is kept (src/ways/program.ts reads <config>/ways/builds/<pinned asset>) */
  buildsDir: () => join(configDir(), "ways", "builds"),
};

type Json = Record<string, unknown>;
const body = async (c: Context): Promise<Json> => { const b = await c.req.json().catch(() => null); return b && typeof b === "object" && !Array.isArray(b) ? b as Json : {}; };
const bad = (c: Context, error: string, extra: Json = {}) => c.json({ error, ...extra }, 400);
const fail = (c: Context, e: unknown) => {
  if (e instanceof ContentError) return c.json({ error: e.message }, e.status as ContentfulStatusCode);
  // the server's own state (no room on the library, no root folder, a way being built): the words, with 507 or 409
  if (e instanceof EnvError) return c.json({ error: e.message }, e.kind === "room" ? 507 : 409);
  return c.json({ error: String((e as Error)?.message ?? e) }, 500);
};
const idParam = (c: Context, name = "id") => { const n = Number(c.req.param(name)); return Number.isInteger(n) && n > 0 ? n : 0; };
const gameRow = (id: number) => (stmts.gameById.get(id) as GameRow | null) ?? null;
/** an upload can be a whole disc: Bun's idle timeout must not cut it off (Hono hands Bun's server over as c.env) */
const noIdleTimeout = (c: Context) => { try { (c.env as { timeout?: (r: Request, s: number) => void } | undefined)?.timeout?.(c.req.raw, 0); } catch { /* not under Bun.serve */ } };
const declaredSize = (c: Context) => { const n = Number(c.req.header("content-length")); return Number.isFinite(n) && n > 0 ? n : null; };

/* ─────────── shapes ─────────── */

/** a kept file as the admin sees it: whether it is on the disk, and whether it is a second copy of the game's copy that
 *  POST /content/:id/free-duplicate would free (src/ways/copy.ts secondCopyOf: stats only, the free compares the bytes) */
export const fileItem = (f: ContentRow) => ({ ...serializeContent(f), onDisk: existsSync(f.path), secondCopy: secondCopyOf(f) });

function needSlots(p: PlanRow) {
  const files = systemFiles(p.id);
  return planSpec(p).needs.map((n, i) => {
    const mine = files.filter(f => f.need_index === i);
    const fits = mine.find(f => needMatches(n, contentFacts(f)).ok) ?? null;
    const shown = fits ?? mine[0] ?? null;
    return { index: i, kind: n.kind, name: n.name, place: n.place, note: n.note ?? null, accept: n.accept ?? null, file: shown ? fileItem(shown) : null, ok: !!fits };
  });
}

export function planItem(p: PlanRow, detail = false) {
  const base = { ...serializePlan(p), waysCount: planWaysCount(p.id), needs: planNeeds(p) };
  if (!detail) return base;
  const names = new Map<number, string>();
  return {
    ...base, needSlots: needSlots(p),
    ways: waysOfPlan(p.id).map(w => {
      if (!names.has(w.game_id)) names.set(w.game_id, gameRow(w.game_id)?.name ?? `game ${w.game_id}`);
      return { id: w.id, gameId: w.game_id, gameName: names.get(w.game_id)!, status: w.status, statusNote: w.status_note, packageId: w.package_id };
    }),
  };
}

interface Blocker { code: "building" | "plan" | "needs" | "file"; error: string; missing?: { index: number; name: string; why: string | null }[] }

/** the game's copy judged in the background when nothing has looked at it yet (small reads; the next look has its verdict) */
const judging = new Set<number>();
function judgeSoon(gameId: number) {
  if (judging.has(gameId) || !currentPackage(gameId) || crdeps.copyFacts(gameId)) return;
  judging.add(gameId);
  void Promise.resolve().then(() => crdeps.judgeCopy(gameId)).catch(e => log.debug(`the copy of game ${gameId} was not judged: ${(e as Error)?.message ?? e}`)).finally(() => judging.delete(gameId));
}

/** everything that stops this way from being built right now (the PC-copy question is asked separately: it has an answer, replace) */
function buildBlockers(w: WayRow, p: PlanRow): Blocker[] {
  const wrong = scopeProblem(p, w.game_id);
  if (wrong) return [{ code: "plan", error: wrong }];
  const out: Blocker[] = [];
  const forGame = buildingFor(w);
  if (assembling(w.id)) out.push({ code: "building", error: "the way is being built" });
  else if (making(w.id)) out.push({ code: "building", error: "its game file is being made" });
  else if (forGame) out.push({ code: "building", error: "its program is being built for this game" });
  if (p.status !== "ready") {
    // a plan whose build needs the game file (sm64ex) has nothing to check before its first build, which is per game and
    // pins its commit; once a commit is pinned, a draft is one to check like any other
    const prog = planSpec(p).program;
    const perGame = p.status === "draft" && prog.kind === "source" && prog.content === "build" && !/@[0-9a-f]{40}$/.test(planPinned(p)?.tag ?? "");
    // while that first build is queued or running, the building blocker says it all
    if (!(perGame && forGame)) out.push({ code: "plan", error: p.status === "broken" ? `the plan is broken${p.status_note ? `: ${p.status_note}` : ""}` : perGame ? "the plan builds from source with each game's own file: build it from source for this game first" : "the plan has not been checked yet: check it first" });
  }
  const needs = planNeeds(p);
  if (!needs.met) out.push({ code: "needs", error: `needs ${needs.missing.map(m => m.name).join(", ")}`, missing: needs.missing });
  const c = wayContent(w, p);
  if (c) {
    const file = w.content_id != null ? getContent(w.content_id) : null;
    if (file) {
      const v = contentMatches(c, contentFacts(file));
      if (!v.ok) out.push({ code: "file", error: `the game file is ${v.why}` });
      else if (!existsSync(file.path)) out.push({ code: "file", error: "the game file is gone from the disk: take it in again" });
    } else {
      // no file of its own: what the game's copy is to it (judged in place, never copied to be judged), or a kept dump its
      // file is made from — one press of Build makes it first
      const r = wayFileRoute(w, c);
      if (r.kind === "looking") out.push({ code: "file", error: "looking at the game's copy" });
      else if (r.kind === "none") out.push({ code: "file", error: r.copy ? `there is no game file yet (${c.what}): the game's copy on the server (${r.copy.name}, ${sizeWords(r.copy.size)}) is ${r.copy.why.replace(/[.\s]+$/, "")}` : `there is no game file yet (${c.what})` });
    }
  }
  return out;
}

export function wayItem(w: WayRow) {
  const p = getPlan(w.plan_id);
  const file = w.content_id != null ? getContent(w.content_id) : null;
  const c = p ? wayContent(w, p) : null;
  // the way's build, its file being made, or the build of its program for this game (a plan built once per game), while
  // queued or running
  const job = assembling(w.id) ?? making(w.id) ?? buildingFor(w);
  const blockers = p ? buildBlockers(w, p) : [{ code: "plan" as const, error: "its plan is gone" }];
  const copy = c ? copyView(w.game_id, c) : null;
  const run = runFor(w.id);
  return {
    ...serializeWay(w, p),
    plan: p ? { id: p.id, slug: p.slug, name: p.name, kind: p.kind, status: p.status, statusNote: p.status_note, repo: p.repo } : null,
    file: file ? fileItem(file) : null,
    fileCheck: file && c ? contentMatches(c, contentFacts(file)) : null,
    /** the game's copy on the server, judged in place: what it is to this way ('direct' it is the file, 'make' the file is
     *  made from it, 'no' with the words why, 'unknown' while it is looked at) */
    copy,
    /** the game's console copy is the way's file (assembly takes it by a link); kept for older clients */
    fromConsoleCopy: !file && copy?.serves === "direct",
    needs: p ? planNeeds(p) : { met: true, missing: [] },
    blockers, canBuild: blockers.length === 0,
    /** what a build replaces: the kind of the game's current package (native needs replace) */
    replaces: currentPackage(w.game_id)?.kind ?? null,
    job: job ? serializeJob(job) : null,
    /** the way's carry run while it is open: where it is and what it asks */
    run: run ? { id: run.id, phase: run.phase, state: run.state, ask: run.ask_json ? JSON.parse(run.ask_json) : null } : null,
  };
}

/* ─────────── plans ─────────── */

const hostOf = (repo: string) => (repo.startsWith("forgejo:") ? "forgejo" : repo.startsWith("dolphin:") ? "feed" : "github");

/** the plan's own fields from a body: undefined = not given; { error } when a given one is wrong */
function readName(v: unknown): string | { error: string } {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return s && s.length <= 120 ? s : { error: "name: what the program is called (up to 120 characters)" };
}
function readPlatforms(v: unknown, spec: RuntimePlanSpec): string[] | { error: string } {
  if (v === undefined || v === null) return spec.content ? [spec.content.platform] : [];
  if (!Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== "string")) return { error: "platforms: a list of platform names" };
  const out: PlatformId[] = [];
  for (const x of v as string[]) { const id = platformId(x); if (!id) return { error: `platforms: "${x}" is not a platform ludarr knows` }; if (!out.includes(id)) out.push(id); }
  return out;
}
function readHomepage(v: unknown): string | null | { error: string } {
  if (v === undefined || v === null || v === "") return null;
  try {
    const u = new URL(String(v));
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || String(v).length > 300) throw new Error();
    return u.toString();
  } catch { return { error: "homepage: an http(s) address" }; }
}
const programRepoProblem = (spec: RuntimePlanSpec, host: string) =>
  spec.program.kind === "release" && host === "feed" ? "a release program needs a GitHub or forgejo repo (the feed is a program kind of its own)" : null;
const isErr = (v: unknown): v is { error: string } => !!v && typeof v === "object" && "error" in (v as object);

waysApi.get("/api/v1/plan", c => c.json({ items: (wstmts.plansAll.all() as PlanRow[]).map(p => planItem(p)) }));

waysApi.get("/api/v1/plan/:id", c => {
  const p = getPlan(idParam(c));
  return p ? c.json({ item: planItem(p, true) }) : c.json({ error: "no such plan" }, 404);
});

waysApi.post("/api/v1/plan", async c => {
  const b = await body(c);
  const name = readName(b.name);
  if (isErr(name)) return bad(c, name.error);
  if (!PLAN_KINDS.includes(b.kind as PlanKind)) return bad(c, `kind: one of ${PLAN_KINDS.join(", ")}`);
  const kind = b.kind as PlanKind;
  const repo = normalizeRepo(b.repo);
  if ("error" in repo) return bad(c, `repo: ${repo.error}`);
  const checked = validatePlanSpec(b.spec, kind);
  if (!checked.ok || !checked.value) return bad(c, "the plan has problems", { errors: checked.errors, warnings: checked.warnings });
  const spec = checked.value;
  const mismatch = programRepoProblem(spec, repo.host);
  if (mismatch) return bad(c, mismatch);
  const platforms = readPlatforms(b.platforms, spec);
  if (isErr(platforms)) return bad(c, platforms.error);
  const homepage = readHomepage(b.homepage);
  if (isErr(homepage)) return bad(c, homepage.error);
  const p = insertPlan({ name, kind, repo: repo.repo, homepage, platforms, spec, status: "draft" });
  reingestCustom();
  return c.json({ item: planItem(p, true), warnings: checked.warnings }, 201);
});

waysApi.put("/api/v1/plan/:id", async c => {
  const cur = getPlan(idParam(c));
  if (!cur) return c.json({ error: "no such plan" }, 404);
  const b = await body(c);
  if (b.kind !== undefined && !PLAN_KINDS.includes(b.kind as PlanKind)) return bad(c, `kind: one of ${PLAN_KINDS.join(", ")}`);
  const kind = (b.kind as PlanKind | undefined) ?? cur.kind;
  const name = b.name !== undefined ? readName(b.name) : undefined;
  if (isErr(name)) return bad(c, name.error);
  let repo = cur.repo;
  if (b.repo !== undefined) { const r = normalizeRepo(b.repo); if ("error" in r) return bad(c, `repo: ${r.error}`); repo = r.repo; }
  let spec = planSpec(cur), warnings: string[] = [];
  if (b.spec !== undefined || kind !== cur.kind) {
    const checked = validatePlanSpec(b.spec ?? spec, kind);
    if (!checked.ok || !checked.value) return bad(c, "the plan has problems", { errors: checked.errors, warnings: checked.warnings });
    spec = checked.value; warnings = checked.warnings;
  }
  const mismatch = programRepoProblem(spec, hostOf(repo));
  if (mismatch) return bad(c, mismatch);
  const platforms = b.platforms !== undefined ? readPlatforms(b.platforms, spec) : undefined;
  if (isErr(platforms)) return bad(c, platforms.error);
  const homepage = b.homepage !== undefined ? readHomepage(b.homepage) : undefined;
  if (isErr(homepage)) return bad(c, homepage.error);
  const specChanged = JSON.stringify(spec) !== JSON.stringify(planSpec(cur));
  // a build that is running took the program it pinned from what the plan said when it started: the program and where it
  // comes from wait until it ends
  const programChanged = JSON.stringify(spec.program) !== JSON.stringify(planSpec(cur).program) || repo !== cur.repo;
  if (programChanged && waysOfPlan(cur.id).some(w => assembling(w.id))) return c.json({ error: "a way of this plan is being built: change its program or repo once the build ends" }, 409);
  // a build job of the plan reads its program, its tools and its repo when it starts, and pins what it built from them
  const toolsChanged = JSON.stringify(spec.tools ?? null) !== JSON.stringify(planSpec(cur).tools ?? null);
  if ((programChanged || toolsChanged) && planBuilds(cur.id).length) return c.json({ error: "a build of this plan is queued or running: change its program, tools or repo once it ends" }, 409);
  // what the build gets changed: the plan is checked again before anything is built from it (a rename changes nothing)
  const rebuilt = specChanged || kind !== cur.kind || repo !== cur.repo;
  const p = updatePlan(cur.id, {
    name, kind, repo, homepage, platforms, ...(specChanged ? { spec } : {}), ...(rebuilt ? { status: "draft", statusNote: null } : {}),
  })!;
  if (specChanged || kind !== cur.kind) settleWaysOfPlan(p.id);
  reingestCustom();
  pokeRuns({ planId: p.id });
  return c.json({ item: planItem(p, true), warnings });
});

waysApi.delete("/api/v1/plan/:id", async c => {
  const p = getPlan(idParam(c));
  if (!p) return c.json({ error: "no such plan" }, 404);
  const ways = waysOfPlan(p.id), files = systemFiles(p.id);
  if (ways.some(w => assembling(w.id))) return c.json({ error: "a way of this plan is being built" }, 409);
  if ((ways.length || files.length) && c.req.query("force") !== "1")
    return c.json({ error: `${ways.length} way${ways.length === 1 ? "" : "s"} and ${files.length} system file${files.length === 1 ? "" : "s"} belong to this plan: remove them first, or delete with ?force=1`, ways: ways.length, files: files.length }, 409);
  try { for (const f of files) await removeContent(f.id); } catch (e) { return fail(c, e); }
  // its carry runs stop first, so the jobs they started (a make, a build) are cancelled rather than left running for nothing
  stopRunsOfPlan(p.id, "the plan was removed");
  wstmts.deletePlan.run(p.id);                                             // its ways go with it (the packages they built stay)
  dropPlanRuntime(p.slug);
  reingestCustom();
  return c.json({ deleted: p.id, ways: ways.map(w => w.id), files: files.map(f => f.id) });
});

const hexOfDigest = (d: unknown) => (typeof d === "string" ? d.trim().toLowerCase().replace(/^sha256:/, "") : null);

/** why a plan's program could not be checked now, with the status the route answers */
export class PlanCheckError extends Error { constructor(msg: string, public status: 400 | 429 | 502) { super(msg); } }
export interface PlanChecked {
  release: { tag: string; asset: string | null; size: number | null; date: string | null; digest: string | null; page: string | null } | null;
  picks: boolean; pinned: ReturnType<typeof planPinned>; newer: boolean; plan: PlanRow;
}

/**
 * The program's latest release now (POST /plan/:id/check, and a carry run whose plan is not ready yet): ready when the
 * pattern picks a file, broken when it does not or the pinned file changed under its tag. A source plan is ready once its
 * build is there; one built with each game's own file (content 'build') once it validates — its first build is per game,
 * and a draft plan's way would never be searched for, so it could never get the file that build needs.
 */
export async function checkPlanNow(p: PlanRow): Promise<PlanChecked> {
  const spec = planSpec(p), prog = spec.program, pinned = planPinned(p);
  let rel: RuntimeRelease | null = null;
  try {
    if (prog.kind === "release") rel = await wdeps.latestRelease(p.repo, prog.assetPattern, prog.channel, wdeps.fetch);
    else if (prog.kind === "feed") rel = await wdeps.latestRelease(prog.feed, null, null, wdeps.fetch);
    else if (prog.kind === "url") {
      let res = await wdeps.fetch(prog.url, { method: "HEAD", signal: AbortSignal.timeout(20_000) });
      if (res.status === 405 || res.status === 501) { res = await wdeps.fetch(prog.url, { signal: AbortSignal.timeout(20_000) }); await res.body?.cancel().catch(() => {}); }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(prog.url).host}`);
      const file = decodeURIComponent(new URL(prog.url).pathname.split("/").pop() || "") || "file";
      rel = { tag: "fixed file", name: null, date: res.headers.get("last-modified"), prerelease: false, page: null, asset: { name: file, url: prog.url, size: Number(res.headers.get("content-length")) || 0 } };
    } else if (prog.content === "build") {
      // built once per game with that game's file: ready to be built per game once the plan holds together
      const v = validatePlanSpec(spec, p.kind);
      const next = updatePlan(p.id, v.ok ? { status: "ready", statusNote: null } : { status: "draft", statusNote: `the plan has problems: ${v.errors.join("; ")}` })!;
      return { release: null, picks: v.ok, pinned, newer: false, plan: next };
    } else {
      // a source plan has no release to look at: it is ready once its build is there (under the name acquireProgram reads)
      const built = !!pinned && existsSync(join(wdeps.buildsDir(), storeName(pinned.asset)));
      const next = updatePlan(p.id, built ? { status: "ready", statusNote: null } : { status: "draft", statusNote: "builds from source: ready once its build has run" })!;
      return { release: null, picks: built, pinned, newer: false, plan: next };
    }
  } catch (e) {
    if (e instanceof RateLimited) throw new PlanCheckError("GitHub's hourly limit: set a GitHub token in Settings → General", 429);
    if (e instanceof PublicUrlError) throw new PlanCheckError(`the plan's address is refused: ${e.message}`, 400);
    throw new PlanCheckError(`the release check failed: ${(e as Error)?.message ?? e}`, 502);
  }
  const asset = rel?.asset ?? null;
  const digest = hexOfDigest((asset as { digest?: unknown } | null)?.digest);
  let status: "ready" | "broken" = asset ? "ready" : "broken";
  let note: string | null = !rel ? `no release found for ${p.repo}` : !asset ? `the plan's asset pattern picks nothing in ${rel.tag}` : null;
  // the file pinned for this tag must still be the same file: GitHub's own size and sha256 say so without a download
  if (asset && pinned && rel && pinned.tag === rel.tag && pinned.asset === asset.name &&
      ((asset.size > 0 && pinned.size > 0 && asset.size !== pinned.size) || (digest && pinned.sha256 && digest !== pinned.sha256.toLowerCase()))) {
    status = "broken"; note = "the release file changed since it was pinned; check the plan";
  }
  const next = updatePlan(p.id, { status, statusNote: note })!;
  if (rel) setRuntimeRelease(`plan:${p.slug}`, rel);
  return {
    release: rel ? { tag: rel.tag, asset: asset?.name ?? null, size: asset?.size ?? null, date: rel.date, digest, page: rel.page } : null,
    picks: !!asset, pinned, newer: !!pinned && !!asset && !!rel && (pinned.tag !== rel.tag || pinned.asset !== asset.name), plan: next,
  };
}

waysApi.post("/api/v1/plan/:id/check", async c => {
  const p = getPlan(idParam(c));
  if (!p) return c.json({ error: "no such plan" }, 404);
  try {
    const r = await checkPlanNow(p);
    pokeRuns({ planId: p.id });
    return c.json({ release: r.release, picks: r.picks, pinned: r.pinned, newer: r.newer, item: planItem(r.plan, true) });
  } catch (e) {
    if (e instanceof PlanCheckError) return c.json({ error: e.message }, e.status);
    return fail(c, e);
  }
});

waysApi.post("/api/v1/plan/:id/needs/:i/file", async c => {
  try {
    const t = needTarget(c.req.param("id"), c.req.param("i"));
    const name = c.req.query("name")?.trim();
    if (!name) return bad(c, "name= is required (the file's name)");
    noIdleTimeout(c);
    const r = await ingestUpload(c.req.raw.body, t, { name, size: declaredSize(c), accept: needAccept(t), signal: c.req.raw.signal });
    settleWaysOfPlan(t.plan.id);
    pokeRuns({ planId: t.plan.id });
    return c.json({ item: fileItem(r.row), duplicate: r.duplicate, plan: planItem(getPlan(t.plan.id)!, true) }, r.duplicate ? 200 : 201);
  } catch (e) { return fail(c, e); }
});

waysApi.post("/api/v1/plan/:id/needs/:i/path", async c => {
  try {
    const t = needTarget(c.req.param("id"), c.req.param("i"));
    const { real } = await checkServerPath((await body(c)).path);
    const job = enqueueJob({ kind: "content", gameId: null, path: real, planId: t.plan.id, needIndex: t.needIndex });
    pokeRuns({ planId: t.plan.id });
    return c.json({ job: serializeJob(job) }, 202);
  } catch (e) { return fail(c, e); }
});

/* ─────────── ways ─────────── */

waysApi.get("/api/v1/game/:id/ways", c => {
  const g = gameRow(idParam(c));
  if (!g) return c.json({ error: "no such game" }, 404);
  // the game's copy not looked at yet: judged in the background (meanwhile its ways say "looking at the game's copy")
  judgeSoon(g.id);
  const research = db.query("SELECT platform, result FROM emulator_research WHERE game_id=? ORDER BY checked_at DESC").all(g.id) as { platform: string; result: string }[];
  return c.json({ items: waysOfGame(g.id).filter(w => { const plan = getPlan(w.plan_id); return plan && !scopeProblem(plan, g.id); }).map(wayItem), research: research.map(r => ({ platform: r.platform, ...JSON.parse(r.result) })) });
});

waysApi.post("/api/v1/game/:id/ways", async c => {
  const g = gameRow(idParam(c));
  if (!g) return c.json({ error: "no such game" }, 404);
  const b = await body(c);
  const p = Number.isInteger(Number(b.planId)) ? getPlan(Number(b.planId)) : null;
  if (!p) return c.json({ error: "no such plan" }, 404);
  const r = await addWay(g, p, { content: b.content, overrides: b.overrides, force: b.force === true });
  if ("error" in r) {
    const extra: Record<string, unknown> = {};
    if (r.wrongGame) extra.wrongGame = true;
    if (r.existingId != null) extra.existingId = r.existingId;
    if (r.errors) extra.errors = r.errors;
    return c.json({ error: r.error, ...extra }, r.status);
  }
  // a way the admin adds is carried through too: its file looked for, made, built and checked with no other click
  try { startRun({ wayId: r.way.id, by: "way" }); } catch (e) { log.warn(`way ${r.way.id}: no carry run: ${(e as Error)?.message ?? e}`); }
  return c.json({ item: wayItem(getWay(r.way.id)!), warnings: r.warnings }, 201);
});

waysApi.put("/api/v1/way/:id", async c => {
  const w = getWay(idParam(c));
  if (!w) return c.json({ error: "no such way" }, 404);
  const p = getPlan(w.plan_id);
  if (!p) return c.json({ error: "the way's plan is gone" }, 409);
  if (assembling(w.id)) return c.json({ error: "the way is being built" }, 409);
  const b = await body(c), spec = planSpec(p), warnings: string[] = [];
  let content: ContentPlan | null | undefined;
  if (b.content !== undefined) {
    if (b.content === null) content = null;
    else {
      const v = validateWayContent(b.content, p.kind);
      if (!v.ok) return bad(c, "the way's game file plan has problems", { errors: v.errors });
      content = v.value; warnings.push(...v.warnings);
    }
  }
  let overrides = undefined as ReturnType<typeof validateWayOverrides>["value"] | undefined;
  if (b.overrides !== undefined) {
    // how the game starts set by hand is kept as it is (the game page's Starts with changes it, after checking it against
    // the copy): what a client read and sends back changes nothing of it, and an emptied overrides keeps it too
    const isObject = !!b.overrides && typeof b.overrides === "object" && !Array.isArray(b.overrides);
    const { launch: _kept, ...given } = isObject ? b.overrides as Json : {};
    const v = validateWayOverrides(isObject ? given : b.overrides, spec);
    if (!v.ok || !v.value) return bad(c, "the way's overrides have problems", { errors: v.errors });
    const hand = wayOverrides(w).launch;
    overrides = hand ? { ...v.value, launch: hand } : v.value;
  }
  const effective = content !== undefined ? (content ?? spec.content) : wayContent(w, p);
  const ship = shipProblem(effective, spec, (overrides ?? wayOverrides(w)).argvExtra);
  if (ship) return bad(c, ship);
  let contentId: number | null | undefined;
  if (b.contentId !== undefined) {
    if (b.contentId === null) contentId = null;
    else {
      const f = getContent(Number(b.contentId));
      if (!f || f.role !== "game") return c.json({ error: "no such game file" }, 404);
      if (f.game_id !== w.game_id) return c.json({ error: "that file was kept for another game" }, 409);
      if (!effective) return c.json({ error: "this way needs no game file" }, 409);
      const v = contentMatches(effective, contentFacts(f));
      if (!v.ok) return c.json({ error: `the file is ${v.why}`, verdict: v }, 409);
      contentId = f.id;
    }
  }
  // a serial the admin took off the way is never put back by the catalog or a dump list
  if (content !== undefined) recordDroppedSerials(w, wayContent(w, p), content ?? spec.content);
  let next = updateWay(w.id, { content, overrides, contentId })!;
  // a changed game file plan the attached file no longer fits: the file is let go
  if (content !== undefined && contentId === undefined && next.content_id != null) {
    const f = getContent(next.content_id), plan = wayContent(next, p);
    if (!f || !plan || !contentMatches(plan, contentFacts(f)).ok) next = updateWay(w.id, { contentId: null })!;
  }
  settleWay(next.id);
  reingestCustom();
  pokeRuns({ wayId: next.id });
  return c.json({ item: wayItem(getWay(next.id)!), warnings });
});

waysApi.delete("/api/v1/way/:id", c => {
  const w = getWay(idParam(c));
  if (!w) return c.json({ error: "no such way" }, 404);
  if (assembling(w.id)) return c.json({ error: "the way is being built" }, 409);
  stopRunsOfWay(w.id, "the way was removed");
  wstmts.deleteWay.run(w.id);
  reingestCustom();
  return c.json({ deleted: w.id });
});

waysApi.post("/api/v1/way/:id/build", async c => {
  const w = getWay(idParam(c));
  if (!w) return c.json({ error: "no such way" }, 404);
  const p = getPlan(w.plan_id);
  if (!p) return c.json({ error: "the way's plan is gone" }, 409);
  const b = await body(c), replace = b.replace === true, repin = b.repin === true;
  const blockers = buildBlockers(w, p);
  if (blockers.length) return c.json({ error: blockers.map(x => x.error).join("; "), blockers }, 409);
  const cur = currentPackage(w.game_id);
  if (cur?.kind === "native" && !replace) return c.json({ error: "the game has a PC copy, and building this way replaces it: build with replace to go ahead", current: "native" }, 409);
  // one press builds: the way's file made first when it is made from the game's copy or a kept dump, the program built
  // for this game first when the plan builds it per game — each queues the way's assemble when it ends
  const content = wayContent(w, p);
  const route = content ? wayFileRoute(w, content) : null;
  let spec: JobSpec;
  const over = replace ? { replace: true } : {};
  if (route?.kind === "make-copy") spec = { kind: "make", wayId: w.id, from: "copy", packageId: route.copy.packageId, then: "assemble", ...over };
  else if (route?.kind === "make-kept") spec = { kind: "make", wayId: w.id, from: "kept", contentId: route.row.id, then: "assemble", ...over };
  else if (crdeps.wayBuildNeeded(p, w)) spec = { kind: "build", planId: p.id, wayId: w.id, then: "assemble", ...over };
  else spec = { kind: "assemble", wayId: w.id, ...(replace ? { replace: true } : {}), ...(repin ? { repin: true } : {}) };
  const job = enqueueJob(spec, { gameId: w.game_id });
  pokeRuns({ wayId: w.id });
  return c.json({ job: serializeJob(job) }, 202);
});

/* the admin's "Find it on my indexers": a search for this way's game file, through the request machinery (src/ways/find.ts);
   the serials the catalog and the dump list give the game join the way's first (shown on the way), and a file a search
   brought earlier that this way proves becomes its file (the request then builds it) */
waysApi.post("/api/v1/way/:id/find-files", async c => {
  const w = getWay(idParam(c));
  if (!w) return c.json({ error: "no such way" }, 404);
  const p = getPlan(w.plan_id);
  if (!p) return c.json({ error: "the way's plan is gone" }, 409);
  const why = findRefusal(w, p);
  if (why) return c.json({ error: why }, 409);
  const g = gameRow(w.game_id);
  if (!g) return c.json({ error: "no such game" }, 404);
  await refreshSerials(w, g);
  const pass = await prepareContentPass(getWay(w.id) ?? w, g, () => {}, { wait: false });
  const held = pass ? heldFor(pass).holds : null;
  if (held) return c.json({ error: `${held.name} came from the indexers and waits for a look: accept it for the way, or remove it to search again` }, 409);
  try {
    const r = createRequest({ gameId: w.game_id, wayId: w.id, by: FOR_WAY });
    pokeRuns({ wayId: w.id });
    return c.json({ request: r.request, duplicate: r.duplicate }, 202);
  } catch (e) {
    if (e instanceof RequestError) return c.json({ error: e.message }, e.status as ContentfulStatusCode);
    return fail(c, e);
  }
});

waysApi.post("/api/v1/way/:id/accept-file", async c => {
  const w = getWay(idParam(c));
  if (!w) return c.json({ error: "no such way" }, 404);
  const p = getPlan(w.plan_id);
  if (!p) return c.json({ error: "the way's plan is gone" }, 409);
  if (assembling(w.id)) return c.json({ error: "the way is being built" }, 409);
  const f = getContent(Number((await body(c)).contentId));
  if (!f || f.role !== "game") return c.json({ error: "no such game file" }, 404);
  if (f.game_id !== w.game_id) return c.json({ error: "that file was kept for another game" }, 409);
  const base = wayContent(w, p);
  if (!base) return c.json({ error: "this way needs no game file" }, 409);
  const facts = contentFacts(f), sha1 = facts.hashes.sha1;
  if (!sha1) return c.json({ error: "the file has no sha1 to accept it by" }, 409);
  if (base.platform && facts.platform && base.platform !== facts.platform) return c.json({ error: `a ${facts.platform} file, and this way plays ${base.platform} games` }, 409);
  const ext = (f.name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
  const formats = base.accept.formats?.length && !base.accept.formats.includes(ext) ? [...base.accept.formats, ext] : base.accept.formats;
  const hashes = base.accept.hashes.some(h => h.algo === "sha1" && h.value === sha1) ? base.accept.hashes : [...base.accept.hashes, { algo: "sha1" as const, value: sha1, label: "accepted by admin" }];
  const v = validateWayContent({ ...base, accept: { ...base.accept, hashes, ...(formats ? { formats } : {}) } }, p.kind);
  if (!v.ok || !v.value) return bad(c, "the file cannot be accepted", { errors: v.errors });
  updateWay(w.id, { content: v.value, contentId: f.id });
  settleWay(w.id);
  reingestCustom();
  pokeRuns({ wayId: w.id });
  return c.json({ item: wayItem(getWay(w.id)!), verdict: contentMatches(v.value, facts) });
});

/* ─────────── game files ─────────── */

waysApi.get("/api/v1/content", c => {
  const gameId = Number(c.req.query("gameId")), planId = Number(c.req.query("planId"));
  const rows = gameId ? gameFiles(gameId) : planId ? systemFiles(planId) : db.query("SELECT * FROM contents ORDER BY id DESC LIMIT 500").all() as ContentRow[];
  return c.json({ items: rows.map(fileItem) });
});

/** the way named by ?wayId= / {wayId}, which must be one of this game's */
function wayOfGame(raw: unknown, gameId: number): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const w = getWay(Number(raw));
  if (!w) throw new ContentError("no such way", 404);
  if (w.game_id !== gameId) throw new ContentError("that way is another game's", 409);
  return w.id;
}
const readPlatform = (raw: unknown): string | null => {
  if (raw === undefined || raw === null || raw === "") return null;
  const id = platformId(String(raw));
  if (!id || !CONTENT_PLATFORMS.includes(id)) throw new ContentError(`platform: one of ${CONTENT_PLATFORMS.join(", ")}`, 400);
  return id;
};

waysApi.post("/api/v1/content", async c => {
  try {
    const t = gameTarget(c.req.query("gameId"));
    if (t.role !== "game") throw new ContentError("no such game", 404);
    const name = c.req.query("name")?.trim();
    if (!name) return bad(c, "name= is required (the file's name)");
    const platform = readPlatform(c.req.query("platform"));
    const wayId = wayOfGame(c.req.query("wayId"), t.game.id);
    noIdleTimeout(c);
    // a file sent for a way is that way's console's when neither its bytes nor its extension say another
    const r = await ingestUpload(c.req.raw.body, t, { name, platform, wayPlatform: namedWayPlatform(wayId, t.game.id), size: declaredSize(c), signal: c.req.raw.signal });
    const { attached, checks } = attachToWays(r.row, { wayId });
    pokeRuns({ gameId: t.game.id });
    return c.json({ item: fileItem(r.row), duplicate: r.duplicate, attached, checks }, r.duplicate ? 200 : 201);
  } catch (e) { return fail(c, e); }
});

waysApi.post("/api/v1/content/path", async c => {
  try {
    const b = await body(c);
    const t = gameTarget(b.gameId);
    if (t.role !== "game") throw new ContentError("no such game", 404);
    const wayId = wayOfGame(b.wayId, t.game.id);
    const { real } = await checkServerPath(b.path);
    const job = enqueueJob({ kind: "content", gameId: t.game.id, path: real, wayId }, { gameId: t.game.id });
    pokeRuns({ gameId: t.game.id });
    return c.json({ job: serializeJob(job) }, 202);
  } catch (e) { return fail(c, e); }
});

waysApi.get("/api/v1/content/:id/check", c => {
  const f = getContent(idParam(c));
  if (!f) return c.json({ error: "no such file" }, 404);
  try { return c.json(checkContent(f, c.req.query("wayId") ? Number(c.req.query("wayId")) : null)); } catch (e) { return fail(c, e); }
});

waysApi.delete("/api/v1/content/:id", async c => {
  try {
    const { row, ways } = await removeContent(idParam(c));
    if (row.game_id != null) pokeRuns({ gameId: row.game_id });
    return c.json({ deleted: row.id, ways: ways.map(wayItem) });
  } catch (e) { return fail(c, e); }
});

/* ─────────── jobs ─────────── */

const JOB_KINDS: JobKind[] = ["import", "construct", "assemble", "content", "build", "make"];

waysApi.get("/api/v1/jobs", c => {
  const kind = c.req.query("kind");
  if (kind && !JOB_KINDS.includes(kind as JobKind)) return bad(c, `kind: one of ${JOB_KINDS.join(", ")}`);
  const rows = (kind ? stmts.jobsByKind.all(kind) : stmts.jobsAll.all()) as JobRow[];
  return c.json({ items: rows.map(j => serializeJob(j)) });
});

waysApi.post("/api/v1/jobs/:id/cancel", c => {
  const j = stmts.jobById.get(idParam(c)) as JobRow | null;
  if (!j) return c.json({ error: "no such job" }, 404);
  if (j.state === "queued") {
    // the runner marks it cancelled, says so and runs its kind's cancel hook (a build puts its way back)
    wdeps.cancelRunning(j.id);
    return c.json({ item: serializeJob(stmts.jobById.get(j.id) as JobRow) });
  }
  if (j.state === "running") { wdeps.cancelRunning(j.id); return c.json({ item: serializeJob(j), stopping: true }, 202); }
  return c.json({ error: `the job is ${j.state}` }, 409);
});
