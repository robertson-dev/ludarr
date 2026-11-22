import { db, stmts, type GameRow } from "../db";
import { EMULATORS } from "../catalog/providers/emulators";
import { normName } from "../catalog/store";
import { platformId, type PlatformId } from "../platforms";
import { copyFacts } from "./copy";
import { gameNames } from "./names";
import { planPinned, planSpec, type PlanRow, type WayRow } from "./store";
import type { ContentPlan } from "./types";

const experimental = new Set<PlatformId>(["ps5", "switch", "switch2", "xbox", "x360", "xone", "xsx"]);
export const needsTitleReport = (platform: PlatformId) => experimental.has(platform);

type Scope = { kind: "general" | "title" } | { kind: "refused"; why: string };
type Owner = { game_id: number; name: string };

/** Known general-purpose upstreams can supply one template even when the admin constructed it from a game page. */
export function generalUpstream(repo: string, content: ContentPlan | null): boolean {
  return !!content && !needsTitleReport(content.platform) && EMULATORS.some(e =>
    e.platforms.some(p => p === content.platform) && e.repo?.toLowerCase() === repo.toLowerCase());
}

export function ownerOf(plan: PlanRow): Owner | null {
  const saved = db.query("SELECT game_id, name FROM emulator_plan_targets WHERE plan_id=?").get(plan.id) as Owner | null;
  if (saved || plan.author !== "ai" || !plan.job_id || generalUpstream(plan.repo, planSpec(plan).content)) return saved;
  // Older AI plans did not record scope separately. Read the original construct, never the projected way.
  return db.query(`SELECT g.id AS game_id, g.name FROM jobs j JOIN games g ON g.id=json_extract(j.spec_json,'$.gameId')
    WHERE j.id=? AND j.kind='construct' AND json_valid(j.spec_json)`).get(plan.job_id) as Owner | null;
}

export function templateScope(c: ContentPlan | null, game: GameRow, owner: Owner | null): Scope {
  if (!c) return { kind: "refused", why: "the emulator plan has no game platform" };
  if (owner && owner.game_id !== game.id) return { kind: "refused", why: `this emulator build was made for ${owner.name}` };
  const names = gameNames(game).map(normName);
  const terms = c.search.filter(s => !platformId(s) && !/^(?:any|all|games?|roms?|any game|any rom|\*)$/i.test(s.trim()));
  if (terms.length && !terms.some(s => names.includes(normName(s)))) return { kind: "refused", why: `this emulator plan targets ${terms[0]}` };
  if (terms.length || owner) return { kind: "title" };
  const serials = [...(c.accept.serials ?? []), ...(c.make?.input.serials ?? [])].map(s => s.toUpperCase());
  if (serials.length && copyFacts(game.id)?.entries.some(e => e.identity?.platform === c.platform && serials.includes(e.identity.serial?.toUpperCase() ?? ""))) {
    return { kind: "title" };
  }
  if (c.accept.hashes.length || c.accept.serials?.length || c.accept.builds?.length || c.accept.versions?.length ||
      c.make?.input.serials?.length || c.make?.input.versions?.length || c.terms?.length ||
      /\b(?:PPSA|CUSA)\d{5}\b|\b0[14][0-9a-f]{14}\b/i.test(JSON.stringify(c))) {
    return { kind: "refused", why: "this emulator plan restricts game data without identifying the supported game" };
  }
  const description = normName(c.what);
  const words = description.replace(/^(?:a|an|all|any|the) /, "").split(" ");
  const afterPlatform = [3, 2, 1].find(n => platformId(words.slice(0, n).join(" ")) === c.platform);
  const first = words[afterPlatform ?? 0];
  if (!/^(?:game|games|rom|roms|disc|image|dump|folder|cartridge|iso|file|package|retail|decrypted|dumped)$/.test(first ?? "") && !platformId(c.what)) {
    if (names.includes(description)) return { kind: "title" };
    return { kind: "refused", why: "the emulator template does not identify a general input or this game" };
  }
  return { kind: "general" };
}

export function emulatorScope(plan: PlanRow, game: GameRow): Scope {
  const c = planSpec(plan).content;
  if (c && (c.platform === "switch" || c.platform === "switch2")) {
    const generations = (JSON.parse(game.platforms_json || "[]") as string[]).map(platformId)
      .filter(p => p === "switch" || p === "switch2");
    if (generations.length && !generations.includes(c.platform)) return { kind: "refused", why: "the game and this emulator target different Switch generations" };
  }
  return templateScope(c, game, ownerOf(plan));
}

/** An older automatic attachment is never evidence that a generic build supports an experimental title. */
export function automaticProblem(plan: PlanRow, way: WayRow): string | null {
  const wrong = scopeProblem(plan, way.game_id);
  if (wrong || plan.kind !== "emulator" || way.manual_choice === 1) return wrong;
  const c = planSpec(plan).content;
  if (!c || !needsTitleReport(c.platform)) return null;
  const game = stmts.gameById.get(way.game_id) as GameRow;
  if (emulatorScope(plan, game).kind === "title") return null;
  const row = db.query("SELECT result FROM emulator_research WHERE game_id=? AND platform=?").get(game.id,c.platform) as { result: string } | null;
  const report = row ? JSON.parse(row.result) : null;
  if (report?.repo?.toLowerCase() === plan.repo.toLowerCase() && (!report.assetUrl || report.assetUrl === planPinned(plan)?.url)) return null;
  return `No compatibility report links this build to ${game.name}.`;
}

export function scopeProblem(plan: PlanRow, gameId: number): string | null {
  if (plan.kind !== "emulator") return null;
  const game = stmts.gameById.get(gameId) as GameRow | null;
  if (!game) return "the game is gone";
  const scope = emulatorScope(plan, game);
  return scope.kind === "refused" ? scope.why : null;
}
