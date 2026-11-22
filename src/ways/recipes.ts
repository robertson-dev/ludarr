/**
 * ludarr — a recipe for every console: the emulator its games are played with, and the way a game gets through it by
 * itself.
 *
 *   RECIPE_FOR   one emulator per console (and the arcade), picked for starting a game unattended on a Windows PC: a
 *                release ludarr can fetch, a command line that takes the game, a portable mode, no first-run wizard that
 *                cannot be answered ahead. The emulators themselves are src/catalog/providers/emulators.ts EMULATORS; what
 *                ludarr writes into each (settings, saves kept, where a BIOS goes) is src/ways/construct.ts STEP0_FACTS.
 *                The table supplies general recipes. Experimental consoles require a title-specific choice.
 *   ensureWay    a game that is asked for in a console's version (games.want_platform), or whose console dump arrived,
 *                gets a way to play through that console's emulator with no click: a ready emulator plan for the console
 *                is checked against its original target. Experimental platforms consult game reports and upstream releases.
 *                For other consoles the recipe's own general plan comes first, else its plan is made by a
 *                construct job from ludarr's own list — never by the AI (listOnly) — which saves the plan, adds the
 *                game's way and starts its carry run. A recipe ludarr cannot finish by itself (RPCS3: its system software
 *                is installed into it) is left to the admin. One that failed is not tried again for a day; a plan the
 *                admin removed is not made again.
 *   ownRecipe    a plan made from the list is data already: a carry run spends no AI round on it.
 *
 * What an emulator still needs from the admin (a BIOS, keys) is a need of its plan: the run asks for it once, and every
 * game of that console is built as soon as it is there.
 */
import { EMULATORS } from "../catalog/providers/emulators";
import type { RuntimeInput } from "../catalog/types";
import { db, type GameRow } from "../db";
import { logger } from "../log";
import { consolePlatforms, PLATFORM_LABEL, platformId, type PlatformId } from "../platforms";
import { emulatorScope, needsTitleReport } from "./emulator-scope";
import { lastResearch, researchEmulator, type EmulatorResearch } from "./emulator-research";
import { enqueueJob } from "../process/kinds";
import { currentPackage, getPlan, planPinned, planSpec, settleWay, wayContent, waysOfGame, wstmts, type PlanRow, type WayRow } from "./store";

const log = logger("recipes");

/** the emulator (EMULATORS id) each console's games are played with */
export const RECIPE_FOR: Partial<Record<PlatformId, string>> = {
  ps1: "duckstation", ps2: "pcsx2", ps3: "rpcs3", ps4: "shadps4", psp: "ppsspp",
  gc: "dolphin", wii: "dolphin", wiiu: "cemu", switch: "eden", "3ds": "azahar", nds: "melonds",
  n64: "rmg", snes: "ares", nes: "mesen", gba: "mgba", gbc: "mgba", gb: "mgba",
  xbox: "xemu", x360: "xenia-canary", dc: "flycast", saturn: "ymir", genesis: "ares", arcade: "mame",
};

/** the emulator ludarr uses for a console's games, or null when it has none */
export function recipeFor(platform: PlatformId | null | undefined): RuntimeInput | null {
  const id = platform ? RECIPE_FOR[platform] : null;
  return id ? EMULATORS.find(e => e.id === id) ?? null : null;
}

/** the repo a plan made from the list is saved under (Dolphin's builds come from its feed; its plan names its repo) */
export const planRepoOf = (e: RuntimeInput): string | null => (e.repo?.startsWith("dolphin:") ? "dolphin-emu/dolphin" : e.repo ?? null);

/** an emulator plan made from ludarr's own list (no AI wrote it): its recipe says all there is to say */
export function ownRecipe(plan: Pick<PlanRow, "kind" | "author" | "repo">): boolean {
  if (plan.kind !== "emulator" || plan.author !== "user") return false;
  const repo = plan.repo.toLowerCase();
  return EMULATORS.some(e => planRepoOf(e)?.toLowerCase() === repo);
}

export type Ensured =
  /** the game has a way of that console (made: it was added just now) */
  | { state: "there"; wayId: number; made: boolean }
  /** the recipe's plan is being made: the way follows when it is saved */
  | { state: "waiting"; emulator: string; jobId: number }
  | { state: "none"; why: string };

/** how long a recipe that could not be made is left alone */
const RETRY_SEC = 86_400;
/** how long a queued plan is waited for before whoever asked goes on without it */
const WAIT_SEC = 20 * 60;

/** swapped in tests; the real ones are loaded when used (the construct job and the carry run both read this module) */
export const rcdeps = {
  now: (): number => Date.now(),
  research: researchEmulator,
  step0: async (repo: string, game: GameRow, platform: PlatformId): Promise<{ missing: string[]; refused: string | null } | null> => (await import("./construct")).step0For(repo, game, platform),
  addWay: async (game: GameRow, plan: PlanRow): Promise<{ way: WayRow } | { error: string }> => (await import("./attach")).addWay(game, plan, { automatic: true }),
  startRun: async (wayId: number): Promise<void> => { (await import("./carry")).startRun({ wayId, by: "way" }); },
};

const jq = {
  recent: db.query("SELECT id, state, spec_json, message, created_at, done_at FROM jobs WHERE kind='construct' ORDER BY id DESC LIMIT 300"),
  romCopies: db.query("SELECT DISTINCT game_id FROM packages WHERE game_id IS NOT NULL"),
};
interface JobLine { id: number; state: string; spec_json: string | null; message: string | null; created_at: number | null; done_at: number | null }

/** the construct jobs ludarr queued for this recipe by itself (for any game: one plan serves them all), newest first */
function recipeJobs(repo: string, platform: PlatformId): JobLine[] {
  return (jq.recent.all() as JobLine[]).filter(j => {
    try {
      const s = JSON.parse(j.spec_json ?? "null") as { repo?: string; repair?: unknown; platform?: string | null; listOnly?: boolean } | null;
      return !!s && s.listOnly === true && !s.repair && String(s.repo ?? "").toLowerCase() === repo.toLowerCase() && (s.platform ?? platform) === platform;
    } catch { return false; }
  });
}

const none = (why: string): Ensured => ({ state: "none", why });

/**
 * Concurrent requests and import handoffs share a selection for the same game and console. Emulator research
 * reads compatibility metadata. Game data is handled separately by the carry run.
 */
const selecting = new Map<string, Promise<Ensured>>();
export function ensureWay(game: GameRow, platform: PlatformId): Promise<Ensured> {
  const key = `${game.id}:${platform}`;
  const existing = selecting.get(key);
  if (existing) return existing;
  const work = selectWay(game, platform).finally(() => selecting.delete(key));
  selecting.set(key, work);
  return work;
}

async function titleReport(game: GameRow, platform: PlatformId): Promise<EmulatorResearch> {
  const cached = lastResearch(game.id, platform);
  const now = Math.floor(rcdeps.now() / 1000);
  if (cached && now - cached.at < (cached.result.incomplete ? 900 : RETRY_SEC)) return cached.result;
  const result = await rcdeps.research(game, platform);
  db.query("INSERT OR REPLACE INTO emulator_research(game_id, platform, checked_at, result) VALUES (?,?,?,?)")
    .run(game.id, platform, now, JSON.stringify(result));
  log.log(`${game.name}: ${result.reason}${result.link ? " " + result.link : ""}`);
  return result;
}

async function selectWay(game: GameRow, platform: PlatformId): Promise<Ensured> {
  if (platform === "switch" || platform === "switch2") {
    const editions = consolePlatforms(JSON.parse(game.platforms_json || "[]")).filter(p => p === "switch" || p === "switch2");
    if (editions.length && !editions.includes(platform)) return none(`${game.name} is listed for a different Switch generation.`);
  }
  const existing = waysOfGame(game.id).filter(w => {
    const p = getPlan(w.plan_id);
    if (!p || wayContent(w, p)?.platform !== platform) return false;
    if (p.kind !== "emulator" || emulatorScope(p, game).kind !== "refused") return true;
    settleWay(w.id);
    return false;
  });
  const label = PLATFORM_LABEL[platform] ?? platform;
  const e = recipeFor(platform);
  const repo = e ? planRepoOf(e) : null;
  // a plan that plays that console's games: the recipe's own first, else one the admin has for it (their own emulator)
  const plans = (wstmts.plansAll.all() as PlanRow[]).filter(p =>
    p.kind === "emulator" && planSpec(p).content?.platform === platform && emulatorScope(p, game).kind !== "refused");
  const specific = plans.filter(p => emulatorScope(p, game).kind === "title" && p.status === "ready");
  const needsReport = needsTitleReport(platform);
  const have = existing.find(w => w.manual_choice === 1 || !needsReport || getPlan(w.plan_id)?.kind !== "emulator" || specific.some(p => p.id === w.plan_id));
  if (have) return { state: "there", wayId: have.id, made: false };
  const report = needsReport && !specific.length ? await titleReport(game, platform) : null;
  if (report && !report.repo) return none(report.reason);
  const selectedRepo = report?.repo ?? repo;
  const own = plans.filter(p => !!selectedRepo && p.repo.toLowerCase() === selectedRepo.toLowerCase() &&
    (!report?.assetUrl || planPinned(p)?.url === report.assetUrl));
  const ready = (needsReport ? [...specific, ...own] : [...own, ...specific, ...plans]).find(p => p.status === "ready");
  if (ready) {
    const linked = existing.find(w => w.plan_id === ready.id);
    if (linked) return { state: "there", wayId: linked.id, made: false };
    const added = await rcdeps.addWay(game, ready);
    if ("error" in added) return none(`${ready.name}: ${added.error}`);
    try { await rcdeps.startRun(added.way.id); }
    catch (err: any) { log.warn(`${game.name}: the carry run of its ${label} way did not start now (${err?.message ?? err}): the next look over the ways starts it`); }
    log.log(`${game.name}: a way to play its ${label} version through ${ready.name}`);
    return { state: "there", wayId: added.way.id, made: true };
  }
  if (report?.repo) {
    const previous = db.query(`SELECT id,state,created_at,done_at,message FROM jobs WHERE kind='construct' AND game_id=?
      AND json_extract(spec_json,'$.platform')=? AND json_extract(spec_json,'$.titleResearch')=1
      AND lower(json_extract(spec_json,'$.repo'))=lower(?) ORDER BY id DESC LIMIT 1`).get(game.id, platform, report.repo) as JobLine | null;
    const now = Math.floor(rcdeps.now() / 1000);
    if (previous && ["queued","running"].includes(previous.state)) return { state: "waiting", emulator: report.repo, jobId: previous.id };
    if (previous && now - (previous.done_at ?? previous.created_at ?? 0) < RETRY_SEC) return none(previous.message ?? report.reason);
    const st = await rcdeps.step0(report.repo, game, platform);
    const listOnly = !!st && !st.refused && !st.missing.length && !report.assetUrl;
    const job = enqueueJob({ kind: "construct", repo: report.repo, gameId: game.id, platform, titleResearch: true, listOnly,
      ...(report.assetUrl ? { assetUrl: report.assetUrl } : {}),
      ...(!listOnly ? { note: `Find the Windows setup for ${game.name} on ${label}. ${report.reason} ${report.link ?? ""} ${report.assetUrl ?? ""}` } : {}),
    }, { gameId: game.id });
    return { state: "waiting", emulator: report.repo, jobId: job.id };
  }
  if (!e || !e.repo) return none(`ludarr has no emulator of its own for ${label} games`);
  // a plan of the recipe's that is not ready is the admin's to look at: no second one is made beside it
  if (own.length) return none(`${own[0].name} is ${own[0].status}${own[0].status_note ? ` (${own[0].status_note})` : ""}`);
  const now = Math.floor(rcdeps.now() / 1000);
  // being made already (for this game or another: the plan is every game's), made before and removed, or tried today
  const jobs = recipeJobs(e.repo, platform);
  const active = jobs.find(j => j.state === "queued" || j.state === "running");
  if (active) return now - (active.created_at ?? now) < WAIT_SEC ? { state: "waiting", emulator: e.name, jobId: active.id } : none(`${e.name} is still being set up`);
  const last = jobs[0];
  if (last?.state === "done") return none(`${e.name} was set up before, and its plan is gone: it is not made again by itself`);
  if (last && now - (last.done_at ?? last.created_at ?? 0) < RETRY_SEC) return none(`${e.name} could not be set up${last.message ? ` (${String(last.message).slice(0, 200)})` : ""}: it is tried again in a day`);
  const st0 = await rcdeps.step0(e.repo, game, platform);
  if (!st0) return none(`ludarr has no emulator of its own for ${label} games`);
  if (st0.refused) return none(st0.refused);
  if (st0.missing.length) return none(`${e.name} is not set up by ludarr itself (${st0.missing.join("; ")}): make its plan on the Ways page`);
  const job = enqueueJob({ kind: "construct", repo: e.repo, gameId: game.id, platform, listOnly: true }, { gameId: game.id });
  log.log(`${game.name}: setting up ${e.name} for its ${label} version (job ${job.id})`);
  return { state: "waiting", emulator: e.name, jobId: job.id };
}

/**
 * Every game whose copy on the server is a console dump with no way of that console gets one (main.ts: at boot and once a
 * day, before the carry runs are looked over): the games that were fetched before ludarr had a recipe for their console.
 * How many ways were added or are being made.
 */
export async function ensureWaysOfCopies(): Promise<number> {
  let n = 0;
  for (const { game_id } of jq.romCopies.all() as { game_id: number }[]) {
    const cur = currentPackage(game_id);
    if (!cur || cur.kind !== "rom") continue;
    const platform = platformId(cur.platform);
    const game = db.query("SELECT * FROM games WHERE id=?").get(game_id) as GameRow | null;
    if (!platform || !game) continue;
    try { const r = await ensureWay(game, platform); if ((r.state === "there" && r.made) || r.state === "waiting") n++; }
    catch (err: any) { log.warn(`${game.name}: no way was made for its console copy: ${err?.message ?? err}`); }
  }
  return n;
}
