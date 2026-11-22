/**
 * ludarr API — carry runs: a repo carried all the way to a game members install (src/ways/carry.ts). Admin-only, like
 * every route: mounted after the auth middleware (src/server.ts). Errors are { error } in plain words with 400, 404 or 409.
 *
 *   GET  /api/v1/runs?gameId=&planId=&wayId=&open=1   { items: RunView[] } without their steps, newest first (open=1: the
 *                                                     runs that have not ended)
 *   GET  /api/v1/run/:id                              { item: RunView } with its steps
 *   POST /api/v1/run/:id/stop                         { item }: the run stops and the jobs it started are cancelled
 *   POST /api/v1/run/:id/retry                        { item }: looks again now — a run asking for its game file reads the inbox
 *                                                     and searches again from scratch; a run held by a cancel resumes
 *   POST /api/v1/run/:id/answer                       { gameId } | { newGame: true } | { go: true | false } → { item }: the game
 *                                                     the plan plays, a new game from the plan's draft, go ahead or not now
 *                                                     (not now stops the run and removes nothing)
 *   POST /api/v1/run/:id/tell                         { text } → 202 { item }: what the admin tells the AI, in their own words
 *                                                     (up to 2000 characters): what the plan has wrong, what to do instead. One
 *                                                     AI round reworks the plan as they say, outside the run's rounds, and the
 *                                                     run takes it up from the plan again; 409 when the run has ended, waits
 *                                                     for a go-ahead, or the AI importer is not set up
 *   POST /api/v1/way/:id/carry                        { replace? } → 202 { item }: "Make it playable": the way's open run, else a
 *                                                     new one (replace: it may build over a PC copy the game has — ask first)
 *   POST /api/v1/plan/:id/carry                       { gameId? } → 202 { item }: the plan's open run for that game, else a new one
 *   POST /api/v1/content/:id/free-duplicate           { freedBytes }: a kept file that is the same bytes as the game's copy is
 *                                                     made a hard link to the copy's file (409 when it is not a lossless
 *                                                     duplicate on one volume)
 *   GET  /api/v1/check-shot/:name                     a check's screenshot (image/png)
 *
 * The handlers never move a run themselves: they record what the admin asked for (an intent), and the run applies it on
 * its next step, taken at once.
 */
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { join } from "node:path";
import { configDir } from "../config";
import { db, stmts, type GameRow } from "../db";
import { logger } from "../log";
import { freeDuplicate } from "./copy";
import { advanceRun, crdeps, getRun, intend, pokeRuns, roomFreed, serializeRun, startRun, type RunRow } from "./carry";
import { EnvError } from "./errors";
import { currentPackage, getContent, getPlan, getWay } from "./store";
import type { RunAnswer, RunAsk } from "./types";

export const carryApi = new Hono();

const log = logger("carry");

/** swapped in tests */
export const cadeps = {
  freeDuplicate: (contentId: number) => freeDuplicate(contentId, { log: line => log.info(`freeing a kept duplicate (file ${contentId}): ${line}`) }),
  checksDir: () => join(configDir(), "ways", "checks"),
  /** is the AI importer set up (a key, enabled): the one a run's rounds are asked of */
  agentReady: (): boolean => crdeps.agentReady(),
};
/** a long answer (the lossless re-read of a 54 GB copy takes minutes): Bun's idle timeout must not cut it off (Hono hands
 *  Bun's server over as c.env) */
const noIdleTimeout = (c: Context) => { try { (c.env as { timeout?: (r: Request, s: number) => void } | undefined)?.timeout?.(c.req.raw, 0); } catch { /* not under Bun.serve */ } };

type Json = Record<string, unknown>;
const body = async (c: Context): Promise<Json> => { const b = await c.req.json().catch(() => null); return b && typeof b === "object" && !Array.isArray(b) ? b as Json : {}; };
const idParam = (c: Context, name = "id") => { const n = Number(c.req.param(name)); return Number.isInteger(n) && n > 0 ? n : 0; };
const intOf = (v: unknown): number | null => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isInteger(n) && n > 0 ? n : null; };
const ended = (r: RunRow) => r.state === "done" || r.state === "stopped";
const askOf = (r: RunRow): RunAsk | null => { try { return r.ask_json ? JSON.parse(r.ask_json) as RunAsk : null; } catch { return null; } };

carryApi.get("/api/v1/runs", c => {
  const conds: string[] = [], vals: number[] = [];
  for (const [q, col] of [["gameId", "game_id"], ["planId", "plan_id"], ["wayId", "way_id"]] as const) {
    const raw = c.req.query(q);
    if (raw === undefined || raw === "") continue;
    const n = intOf(raw);
    if (!n) return c.json({ error: `${q}: a number` }, 400);
    conds.push(`${col}=?`); vals.push(n);
  }
  if (c.req.query("open") === "1") conds.push("state NOT IN ('done','stopped')");
  const rows = db.query(`SELECT * FROM carry_runs ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 200`).all(...vals) as RunRow[];
  return c.json({ items: rows.map(r => serializeRun(r)) });
});

carryApi.get("/api/v1/run/:id", c => {
  const r = getRun(idParam(c));
  return r ? c.json({ item: serializeRun(r, true) }) : c.json({ error: "no such run" }, 404);
});

/** an intent recorded, then the run's next step taken at once: the item as that step left it */
async function applied(id: number, intent: Parameters<typeof intend>[1]) {
  intend(id, intent);
  const after = await advanceRun(id, { steps: 1 });
  return serializeRun(after ?? getRun(id)!, true);
}

carryApi.post("/api/v1/run/:id/stop", async c => {
  const r = getRun(idParam(c));
  if (!r) return c.json({ error: "no such run" }, 404);
  if (ended(r)) return c.json({ error: `the run has ${r.state === "done" ? "finished" : "stopped"} already` }, 409);
  return c.json({ item: await applied(r.id, { kind: "stop", why: "you stopped it" }) });
});

carryApi.post("/api/v1/run/:id/retry", async c => {
  const r = getRun(idParam(c));
  if (!r) return c.json({ error: "no such run" }, 404);
  if (ended(r)) return c.json({ error: `the run has ${r.state === "done" ? "finished" : "stopped"}: make it playable again to start a new one` }, 409);
  return c.json({ item: await applied(r.id, { kind: "retry" }) });
});

carryApi.post("/api/v1/run/:id/answer", async c => {
  const r = getRun(idParam(c));
  if (!r) return c.json({ error: "no such run" }, 404);
  const b = await body(c);
  const keys = Object.keys(b);
  let answer: RunAnswer | null = null;
  if (keys.length === 1 && keys[0] === "gameId" && intOf(b.gameId)) answer = { gameId: intOf(b.gameId)! };
  else if (keys.length === 1 && keys[0] === "newGame" && b.newGame === true) answer = { newGame: true };
  else if (keys.length === 1 && keys[0] === "go" && typeof b.go === "boolean") answer = { go: b.go };
  if (!answer) return c.json({ error: "send one of { gameId }, { newGame: true } or { go: true | false }" }, 400);
  if (ended(r)) return c.json({ error: `the run has ${r.state === "done" ? "finished" : "stopped"}` }, 409);
  const a = askOf(r);
  if ("go" in answer && !(r.state === "held" && a?.code === "go-ahead")) return c.json({ error: "the run is not waiting for a go-ahead" }, 409);
  if ("newGame" in answer && a?.code !== "game") return c.json({ error: "the run is not asking which game it plays" }, 409);
  if ("gameId" in answer) {
    if (!stmts.gameById.get(answer.gameId)) return c.json({ error: "no such game" }, 404);
    // a game answers "which game" (the plan's, or the one an emulator should play) — never a question the AI asked
    if (a?.code !== "game" && !(a?.code === "choice" && !a.byAi)) return c.json({ error: "the run is not asking which game it plays" }, 409);
  }
  return c.json({ item: await applied(r.id, { kind: "answer", answer }) });
});

carryApi.post("/api/v1/run/:id/tell", async c => {
  const r = getRun(idParam(c));
  if (!r) return c.json({ error: "no such run" }, 404);
  const raw = (await body(c)).text;
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").trim() : "";
  if (!text) return c.json({ error: "say what the plan has wrong, and what to do instead ({ text })" }, 400);
  if (text.length > 2000) return c.json({ error: "up to 2000 characters" }, 400);
  if (ended(r)) return c.json({ error: `the run has ${r.state === "done" ? "finished" : "stopped"}: start it again (Make it playable), then say it` }, 409);
  if (r.state === "held") return c.json({ error: "the run waits for your go-ahead: answer that first" }, 409);
  if (!cadeps.agentReady()) return c.json({ error: "the AI importer is not set up (Settings → Importers): there is no one to tell" }, 409);
  return c.json({ item: await applied(r.id, { kind: "tell", text }) }, 202);
});

carryApi.post("/api/v1/way/:id/carry", async c => {
  const w = getWay(idParam(c));
  if (!w) return c.json({ error: "no such way" }, 404);
  if (!getPlan(w.plan_id)) return c.json({ error: "the way's plan is gone" }, 409);
  const b = await body(c);
  if (b.replace !== undefined && typeof b.replace !== "boolean") return c.json({ error: "replace: true or false" }, 400);
  const cur = currentPackage(w.game_id);
  if (w.status === "built" && w.package_id != null && cur?.pkg.id === w.package_id) return c.json({ error: "the way is built: members can install it" }, 409);
  try {
    const run = startRun({ wayId: w.id, by: "admin", replace: b.replace === true });
    pokeRuns({ runId: run.id });
    return c.json({ item: serializeRun(getRun(run.id) ?? run, true) }, 202);
  } catch (e) { return c.json({ error: String((e as Error)?.message ?? e) }, 409); }
});

carryApi.post("/api/v1/plan/:id/carry", async c => {
  const p = getPlan(idParam(c));
  if (!p) return c.json({ error: "no such plan" }, 404);
  const b = await body(c);
  let game: GameRow | null = null;
  if (b.gameId !== undefined && b.gameId !== null) {
    const id = intOf(b.gameId);
    if (!id) return c.json({ error: "gameId: a number" }, 400);
    game = (stmts.gameById.get(id) as GameRow | null) ?? null;
    if (!game) return c.json({ error: "no such game" }, 404);
  }
  try {
    // no game named: the plan's open run, whatever game it found
    const open = game ? null : (db.query("SELECT * FROM carry_runs WHERE plan_id=? AND state NOT IN ('done','stopped') ORDER BY id DESC LIMIT 1").get(p.id) as RunRow | null);
    const run = startRun({ planId: p.id, gameId: game?.id ?? open?.game_id ?? null, by: "admin" });
    pokeRuns({ runId: run.id });
    return c.json({ item: serializeRun(getRun(run.id) ?? run, true) }, 202);
  } catch (e) { return c.json({ error: String((e as Error)?.message ?? e) }, 409); }
});

carryApi.post("/api/v1/content/:id/free-duplicate", async c => {
  const f = getContent(idParam(c));
  if (!f) return c.json({ error: "no such file" }, 404);
  noIdleTimeout(c);
  try {
    const out = await cadeps.freeDuplicate(f.id);
    // the room it gave back is the library's: every run that asked for room (any game's) looks again now
    roomFreed(f.game_id ?? undefined);
    return c.json(out);
  } catch (e) {
    // the server's own state (a way using the file is being built; no room to re-read): 409, or 507 for room
    if (e instanceof EnvError) return c.json({ error: e.message }, e.kind === "room" ? 507 : 409);
    const status = Number((e as { status?: unknown })?.status);
    const code = ([400, 404, 409] as const).find(s => s === status);
    return c.json({ error: String((e as Error)?.message ?? e) }, (code ?? 500) as ContentfulStatusCode);
  }
});

carryApi.get("/api/v1/check-shot/:name", async c => {
  const name = c.req.param("name");
  if (!/^[a-z0-9-]+\.png$/.test(name)) return c.json({ error: "no such screenshot" }, 404);
  const f = Bun.file(join(cadeps.checksDir(), name));
  if (!(await f.exists())) return c.json({ error: "no such screenshot" }, 404);
  return new Response(f, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
});
