/**
 * ludarr — which library game a plan plays, and its way. A wrong game is far worse than no game, so a name alone never
 * attaches: the plan's names (its content plan's search names and the AI's draft of the game, never the program's own
 * name) AND its platform must match a library game.
 *
 *   one match                 attach to it
 *   several                   the one whose name is exactly the plan's; still several: ask the admin
 *   a match with no platforms ask (a name alone never attaches)
 *   none in the library       the one store or catalog hit of that name on that platform is added; none: the game is added
 *                             by hand from the draft, on the plan's platform. A store hit the library already holds under
 *                             another platform is another game (Ocarina of Time on the N64 in 1998 and on the Switch 2 in
 *                             2026): it is added beside it, never attached to it
 *
 * addWay is the body of POST /api/v1/game/:id/ways, shared by the route and the carry run, so a way the run adds is
 * checked exactly as the admin's: a recomp or a port only for the game its plan plays (unless forced), an emulator way
 * with this game's own content plan (and the catalog's serials), the overrides, a file kept out of the package, the
 * dump list fetched in the background, a kept file that fits taken at once.
 */
import { stmts, type GameRow } from "../db";
import { gameAliases, reingestCustom } from "../catalog/providers/custom";
import { loadDat } from "../catalog/providers/dats";
import { addGame, lookup, LibraryError, nameKey, type AddBody, type LookupResult } from "../library/games";
import { consolePlatforms, hasPc, PLATFORM_LABEL, platformId, type PlatformId } from "../platforms";
import { scopeProblem } from "./emulator-scope";
import { keptFileFor } from "./content";
import { withCatalogSerials } from "./find";
import { gameNames, sameGame } from "./names";
import { getWay, insertWay, planSpec, settleWay, updateWay, wayContent, wstmts, type PlanRow, type WayRow } from "./store";
import type { ContentPlan, GameDraft, RuntimePlanSpec, WayOverrides } from "./types";
import { placeholdersIn, validateWayContent, validateWayOverrides } from "./validate";


/** swapped in tests: the store and catalog lookup, the add, and the console's dump list fetched for a new way */
export const atdeps = {
  lookup: (term: string): Promise<LookupResult[]> => lookup(term),
  addGame: (body: AddBody) => addGame(body),
  libraryGames: (): GameRow[] => stmts.allGames.all() as GameRow[],
  loadDat: (platform: PlatformId) => loadDat(platform, () => {}, { wait: false }),
};

export type GameMatch =
  | { kind: "attach"; game: GameRow }
  | { kind: "add"; body: AddBody; why: string }
  | { kind: "ask"; candidates: GameRow[]; why: string }
  | { kind: "none"; why: string };

const list = (s: string | null | undefined): string[] => { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };

export const platformOf = platformId;

/** Older recomp templates stored both Switch generations as "switch". Their description can still identify Switch 2. */
function targetPlatform(c: ContentPlan): PlatformId {
  return c.platform === "switch" && /\bswitch\s*2\b/i.test(c.what) ? "switch2" : c.platform;
}
/** the platforms a game is on, as ids */
export function platformsOf(names: string[]): PlatformId[] {
  return [...new Set(names.map(platformOf).filter((p): p is PlatformId => !!p))];
}
/** is a game (by its stored platform names) on `platform`: a console by its id, the PC by any PC name */
export function onPlatform(names: string[], platform: PlatformId): boolean {
  if (platform === "pc") return hasPc(names);
  const ids = platformsOf(names);
  return ids.includes(platform) || consolePlatforms(names).includes(platform);
}

/** the names a plan's game goes by: its content plan's search names and the draft's, never the program's own name */
export function planGameNames(plan: Pick<PlanRow, "name">, c: ContentPlan | null, draft: GameDraft | null): string[] {
  const own = plan.name;
  const out: string[] = [], seen = new Set<string>();
  for (const n of [...(c?.search ?? []), ...(draft ? [draft.name, ...draft.aliases] : [])]) {
    const t = String(n ?? "").replace(/\s+/g, " ").trim();
    const k = nameKey(t);
    if (!t || !k || seen.has(k)) continue;
    // the program's own name is never the game's ("Zelda 64: Recompiled" plays Majora's Mask)
    if (sameGame([t], [own]) || nameKey(t).replace(/ /g, "") === nameKey(own).replace(/ /g, "")) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** library games the plan's names and platform both point at */
function libraryCandidates(names: string[], platform: PlatformId): { on: GameRow[]; unknown: GameRow[] } {
  const on: GameRow[] = [], unknown: GameRow[] = [];
  for (const g of atdeps.libraryGames()) {
    if (!sameGame(gameNames(g), names)) continue;
    const plats = list(g.platforms_json);
    if (!plats.length) { unknown.push(g); continue; }
    if (onPlatform(plats, platform)) on.push(g);
  }
  return { on, unknown };
}

/** the library game the plan plays, when its names and platform name exactly one (no lookup outside the library) */
export function libraryMatch(plan: PlanRow, draft: GameDraft | null): GameRow | null {
  const c = planSpec(plan).content;
  if (!c || plan.kind === "emulator") return null;
  const names = planGameNames(plan, c, draft);
  if (!names.length) return null;
  const { on } = libraryCandidates(names, targetPlatform(c));
  if (on.length === 1) return on[0];
  const exact = on.filter(g => gameNames(g).some(n => names.some(x => nameKey(x) === nameKey(n))));
  return exact.length === 1 ? exact[0] : null;
}

/** a draft of the game to add by hand: the AI's (or the curated list's), else the plan's own names, on its platform */
export function draftFor(c: ContentPlan, names: string[], draft: GameDraft | null): GameDraft | null {
  const platform = targetPlatform(c);
  const platforms = [platform];
  if (draft) return { ...draft, platforms: draft.platforms.includes(platform) ? draft.platforms : [...draft.platforms, platform] };
  if (!names.length) return null;
  return { name: names[0], aliases: names.slice(1, 6), platforms, year: null, releaseIso: null, summary: null, genres: [], developer: null, publisher: null, searchTerms: [] };
}

/** the library game a plan plays, the game to add, or why it must be asked */
export async function matchGame(plan: PlanRow, draft: GameDraft | null): Promise<GameMatch> {
  const c = planSpec(plan).content;
  if (plan.kind === "emulator") return { kind: "none", why: "an emulator plays many games: add it to a game to make that one playable" };
  if (!c) return { kind: "none", why: `${plan.name} names no game file, so nothing says which game it plays` };
  const names = planGameNames(plan, c, draft);
  if (!names.length) return { kind: "none", why: `${plan.name} names no game a player could be shown` };
  const { on, unknown } = libraryCandidates(names, targetPlatform(c));
  if (on.length === 1) return { kind: "attach", game: on[0] };
  if (on.length > 1) {
    const exact = on.filter(g => gameNames(g).some(n => names.some(x => nameKey(x) === nameKey(n))));
    if (exact.length === 1) return { kind: "attach", game: exact[0] };
    // the ones named exactly first
    return { kind: "ask", candidates: [...exact, ...on.filter(g => !exact.includes(g))], why: `${on.length} library games of ${PLATFORM_LABEL[c.platform] ?? c.platform} go by that name` };
  }
  if (unknown.length) return { kind: "ask", candidates: unknown, why: `a library game of that name says nothing of its platforms, and a name alone never attaches a plan` };
  // nothing in the library: a store or catalog hit of that name on that platform, else the game by hand
  const hits = (await atdeps.lookup(names[0]).catch(() => [] as LookupResult[]))
    .filter(h => h.source !== "library" && h.gameId == null && sameGame([h.name], names) && onPlatform(h.platforms ?? [], targetPlatform(c))
      && (h.id.scheme === "steam" || h.id.scheme === "igdb" || h.id.scheme === "catalog"));
  const exact = hits.filter(h => names.some(n => nameKey(n) === nameKey(h.name)));
  const pick = hits.length === 1 ? hits[0] : exact.length === 1 ? exact[0] : null;
  if (pick) return { kind: "add", body: { source: pick.id.scheme as AddBody["source"], id: pick.id.value, monitored: true, searchNow: false }, why: `${pick.name}${pick.year ? ` (${pick.year})` : ""} from ${pick.source === "catalog" ? "the catalog" : pick.source}` };
  const d = draftFor(c, names, draft);
  if (!d) return { kind: "none", why: `${plan.name} names no game a player could be shown` };
  return { kind: "add", body: { source: "manual", game: d, monitored: true, searchNow: false }, why: hits.length > 1 ? `several games of that name on ${PLATFORM_LABEL[c.platform] ?? c.platform}: added by hand from the plan` : "added by hand from the plan" };
}

/**
 * The game a match says to add, in the library: a store or catalog add that cannot be made (IGDB not set up, the hit
 * gone) is made by hand from the draft instead; a game of that name already in the library (409) is that game only when
 * it is on the plan's platform, else this one is added beside it (another platform's release is another library game).
 */
export async function addGameFor(m: Extract<GameMatch, { kind: "add" }>, c: ContentPlan, draft: GameDraft | null, planName: string): Promise<GameRow> {
  const row = (id: number | undefined): GameRow | null => (id ? (stmts.gameById.get(id) as GameRow | null) ?? null : null);
  const plats = (g: GameRow) => list(g.platforms_json);
  /** a game added by hand; one of the same name and year already there is it only when it is on the plan's platform */
  const byHand = async (body: AddBody): Promise<GameRow> => {
    try {
      const added = row((await atdeps.addGame(body)).id);
      if (!added) throw new Error("the game was not added");
      return added;
    } catch (e) {
      const existing = e instanceof LibraryError && e.status === 409 ? row(Number(e.extra.existingId)) : null;
      if (!existing) throw e;
      if (onPlatform(plats(existing), targetPlatform(c))) return existing;
      const again = row((await atdeps.addGame({ ...body, force: true })).id);
      if (!again) throw new Error("the game was not added");
      return again;
    }
  };
  const manual = (): AddBody => {
    const d = draftFor(c, planGameNames({ name: planName }, c, draft), draft);
    if (!d) throw new Error("nothing names the game to add");
    return { source: "manual", game: d, monitored: true, searchNow: false };
  };
  if (m.body.source === "manual") return byHand(m.body);
  let added: GameRow | null = null;
  try { added = row((await atdeps.addGame(m.body)).id); }
  catch { added = null; }                                                  // IGDB not set up, the hit gone: by hand instead
  // a store's game that is not on the plan's platform after all (the library already held it) is no game for it
  if (added && (!plats(added).length || onPlatform(plats(added), targetPlatform(c)))) return added;
  return byHand(manual());
}

/* ─────────── a way ─────────── */

export type AddedWay =
  | { way: WayRow; warnings: string[] }
  | { error: string; status: 400 | 404 | 409; wrongGame?: boolean; existingId?: number; errors?: string[] };

/** an emulator plan's content plan is a template (platform, place, formats): this game's own version of it */
export function emulatorContent(tpl: ContentPlan, g: GameRow): ContentPlan {
  return {
    ...tpl, what: `${g.name} (${PLATFORM_LABEL[tpl.platform] ?? tpl.platform})`, search: [g.name, ...gameAliases(g)].slice(0, 10),
    accept: { ...tpl.accept }, place: tpl.place || "games/{name}",
  };
}

/** a way whose own content keeps its file out of the package cannot have the launch hand that file over */
export function shipProblem(content: ContentPlan | null, spec: RuntimePlanSpec, argvExtra: string[] = []): string | null {
  if (!content || content.ship !== false) return null;
  return [...spec.launch.argv, ...argvExtra].some(a => placeholdersIn(a).includes("content")) ? "content.ship: false keeps the file out of the package, but the launch passes {content}" : null;
}

/** a way for `game` through `plan`, checked as POST /game/:id/ways checks one (content: the way's own content plan;
 *  undefined or null for an emulator's own version of its template) */
export async function addWay(game: GameRow, plan: PlanRow, o: { content?: unknown; overrides?: unknown; force?: boolean; automatic?: boolean } = {}): Promise<AddedWay> {
  const wrong = scopeProblem(plan, game.id);
  if (wrong) return { error: wrong, status: 409, wrongGame: true };
  const existing = wstmts.wayFor.get(game.id, plan.id) as WayRow | null;
  if (existing) return { error: "this game already has a way through that plan", status: 409, existingId: existing.id };
  const spec = planSpec(plan), warnings: string[] = [];
  // a recomp or a port plays the one game its plan names (the construct route refuses the same pairing): another game's
  // way through it would take that game's file, and it is added anyway only when the admin says so
  if ((plan.kind === "recomp" || plan.kind === "port") && spec.content && o.force !== true && !sameGame(gameNames(game), spec.content.search))
    return { error: `${plan.name} plays ${spec.content.search[0]}, and ${game.name} does not look like that game`, status: 409, wrongGame: true };
  let content: ContentPlan | null = null;
  // an emulator way's own content takes the serials the catalog holds for the game (shown on the way, checked on its files)
  const own = o.content !== undefined && o.content !== null ? o.content : plan.kind === "emulator" && spec.content ? withCatalogSerials(emulatorContent(spec.content, game), game) : null;
  if (own) {
    const v = validateWayContent(own, plan.kind);
    if (!v.ok) return { error: "the way's game file plan has problems", status: 400, errors: v.errors };
    content = v.value; warnings.push(...v.warnings);
  }
  const ov = validateWayOverrides(o.overrides, spec);
  if (!ov.ok || !ov.value) return { error: "the way's overrides have problems", status: 400, errors: ov.errors };
  const ship = shipProblem(content ?? spec.content, spec, (ov.value as WayOverrides).argvExtra);
  if (ship) return { error: ship, status: 400 };
  const w = insertWay({ gameId: game.id, planId: plan.id, content, overrides: ov.value, automatic: o.automatic });
  // the console's dump list, fetched now in the background when the server keeps none, so the way's first search has it
  const plat = (content ?? spec.content)?.platform;
  if (plat) void Promise.resolve().then(() => atdeps.loadDat(plat)).catch(() => {});
  // a game file already kept for this game that fits becomes the way's: one whose console is not known only as fitsUnasked
  // lets it, and one that came with a download (an imported dump, a search's file) only when the way's check proves it
  const plan2 = wayContent(w, plan);
  const fit = plan2 ? keptFileFor(plan2, game) : null;
  if (fit) updateWay(w.id, { contentId: fit.id });
  settleWay(w.id);
  try { reingestCustom(); } catch { /* the catalog follows on its next ingest */ }
  return { way: getWay(w.id)!, warnings };
}
