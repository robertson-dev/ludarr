/**
 * ludarr — the catalog source for this server's own ways to play (src/ways): one route per way, under the game it
 * plays, and one runtime per plan. The data lives in the ways tables (and a game added by hand keeps its own on its
 * games row), so this source ranks below every other (metaRank 5) and never renames a title another source knows.
 *
 * Routes reach a game only through games.title_id (library/games.ts gameDetail). So before every ingest each game with
 * a way gets a title of its own (ensureTitle): the one games.title_id names, else the one another source already gave
 * the game, else a new one, with the registry id 'game:<id>' pointing at it; the contribution carries that id, the
 * game's names, year, release date and platforms and the game's id, so the catalog finds the title by id and never by
 * name — a same-named title can be another game's — and the title knows its year, which keeps a same-named game of
 * another year from merging into it.
 *
 * Every plan, way or game write ingests again at once (reingestCustom): ingest() runs synchronously, where the worker's
 * runSource would drop a call that overlaps a running one. The worker's own run every 15 minutes is the safety net.
 *
 * Runtimes: a GitHub release plan is polled like any runtime, a Dolphin feed plan through its feed. A release plan on
 * another forge is not polled (the poller fetches without checking where a typed host leads; POST /plan/:id/check does
 * check, and stores what it finds), and url and source plans have nothing to poll: they show what is pinned.
 */
import { db, stmts, type GameRow } from "../../db";
import { events } from "../../events";
import { logger } from "../../log";
import { platformId } from "../../platforms";
import * as registry from "../../plugins/registry";
import { automaticProblem } from "../../ways/emulator-scope";
import { planPinned, planSpec, wayContent, wstmts, type PlanRow, type WayRow } from "../../ways/store";
import { PACKAGE_KIND } from "../../ways/types";
import { ingest, normName, uniqueSlug } from "../store";
import { isPlatform, type Contribution, type Platform, type Provider, type RouteInput, type RuntimeInput } from "../types";

const log = logger("Catalog");
export const CUSTOM_ID = "custom";

const q = {
  title: db.query("SELECT id FROM titles WHERE id=?"),
  byKey: db.query("SELECT title_id FROM title_ids WHERE scheme='registry' AND value=?"),
  /** the title another source already gave this game (titles.game_id), when games.title_id was never set */
  claimedBy: db.query("SELECT id FROM titles WHERE game_id=? ORDER BY id LIMIT 1"),
  /** the title a store id of the game names, when no other game holds it */
  byStoreId: db.query("SELECT t.id FROM title_ids i JOIN titles t ON t.id=i.title_id WHERE i.scheme=? AND i.value=? AND (t.game_id IS NULL OR t.game_id=?)"),
  insertTitle: db.query("INSERT INTO titles (slug, name, sort_name, year, release_iso, platforms_json) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"),
  pointKey: db.query(`INSERT INTO title_ids (scheme, value, title_id, source) VALUES ('registry', ?, ?, 'custom')
    ON CONFLICT(scheme, value) DO UPDATE SET title_id=excluded.title_id, source=excluded.source`),
  claim: db.query("UPDATE titles SET game_id=? WHERE id=? AND game_id IS NULL"),
  /** a title this source made follows its game's name (one another source named keeps that name) */
  rename: db.query("UPDATE titles SET name=?, sort_name=?, updated_at=unixepoch() WHERE id=? AND meta_source='custom' AND name<>?"),
  dropRuntime: db.query("DELETE FROM runtimes WHERE id=? AND source='custom'"),
  dropOrphanRuntimes: () => db.query("DELETE FROM runtimes WHERE source='custom' AND id LIKE 'plan:%' AND substr(id, 6) NOT IN (SELECT slug FROM runtime_plans)").run(),
};

const list = (s: string | null | undefined): unknown[] => { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v : []; } catch { return []; } };
/** a game's other names (games.aliases_json, written for games added by hand) */
export const gameAliases = (g: GameRow): string[] =>
  list((g as GameRow & { aliases_json?: string | null }).aliases_json).filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim());
/** the catalog's platform slug for an engine platform name ("n64", "win" …), when the catalog has one */
const catalogPlatform = (p: unknown): Platform | null => { const id = typeof p === "string" ? platformId(p) ?? p : null; return id && isPlatform(id) ? id : null; };
/** the game's own platforms, as catalog slugs */
const gamePlatforms = (g: GameRow): Platform[] => [...new Set(list(g.platforms_json).map(catalogPlatform).filter((x): x is Platform => !!x))];
const planPlatforms = (p: PlanRow): Platform[] => {
  const own = list(p.platforms_json).map(catalogPlatform).filter((x): x is Platform => !!x);
  const fromContent = catalogPlatform(planSpec(p).content?.platform);
  return [...new Set(own.length ? own : fromContent ? [fromContent] : [])];
};

/** a page about the repo: the GitHub or forge project, the Dolphin site for its feed */
export function repoUrl(repo: string, homepage?: string | null): string | null {
  const forge = /^forgejo:([^/]+)\/(.+)$/.exec(repo);
  if (forge) return `https://${forge[1]}/${forge[2]}`;
  if (repo.startsWith("dolphin:")) return homepage || "https://dolphin-emu.org/";
  return /^[^/:]+\/[^/]+$/.test(repo) ? `https://github.com/${repo}` : homepage ?? null;
}

/**
 * The title a game's ways are listed under, made when it has none: games.title_id's own title, else the one the registry id
 * already points at, else the one another source already gave the game (it claims the game, or the game's Steam / IGDB id
 * names it), else a new one that knows the game's year, release date and platforms (so a same-named game of another year
 * never lands on it). The registry id 'game:<id>' is pointed at it, games.title_id set, and the title claims the game when
 * no other game holds it.
 */
export function ensureTitle(game: GameRow): number {
  const key = `game:${game.id}`;
  const idOf = (r: unknown) => (r as { id: number } | null)?.id ?? null;
  let id: number | null = game.title_id != null && q.title.get(game.title_id) ? game.title_id : null;
  if (id == null) id = (q.byKey.get(key) as { title_id: number } | null)?.title_id ?? null;
  if (id == null) id = idOf(q.claimedBy.get(game.id));
  if (id == null && game.steam_appid) id = idOf(q.byStoreId.get("steam", String(game.steam_appid), game.id));
  if (id == null && game.igdb_id) id = idOf(q.byStoreId.get("igdb", String(game.igdb_id), game.id));
  if (id == null) {
    const platforms = gamePlatforms(game);
    id = (q.insertTitle.get(uniqueSlug(game.name, game.release_year, platforms[0]), game.name, normName(game.name), game.release_year ?? null,
      game.release_iso ?? null, JSON.stringify(platforms)) as { id: number }).id;
  }
  q.pointKey.run(key, id);
  if (game.title_id !== id) stmts.setGameTitle.run(id, game.id);
  q.claim.run(game.id, id);
  q.rename.run(game.name, normName(game.name), id, game.name);
  return id;
}

function routeFor(w: WayRow, p: PlanRow, g: GameRow): RouteInput {
  const platform = catalogPlatform(wayContent(w, p)?.platform) ?? planPlatforms(p)[0] ?? list(g.platforms_json).map(catalogPlatform).find((x): x is Platform => !!x) ?? "pc";
  return {
    key: `way:${w.id}`, kind: PACKAGE_KIND[p.kind], platform, provenance: "retail", runtime: `plan:${p.slug}`, label: p.name,
    status: w.status === "built" ? "playable" : null, link: repoUrl(p.repo, p.homepage),
  };
}

function runtimeFor(p: PlanRow): RuntimeInput {
  const spec = planSpec(p), prog = spec.program, pin = planPinned(p);
  const forge = p.repo.startsWith("forgejo:");
  const polled = (prog.kind === "release" && !forge) || prog.kind === "feed";
  const rt: RuntimeInput = {
    id: `plan:${p.slug}`, name: p.name, kind: p.kind, platforms: planPlatforms(p), homepage: p.homepage ?? repoUrl(p.repo),
    repo: prog.kind === "feed" ? prog.feed : p.repo, assetPattern: prog.kind === "release" ? prog.assetPattern : null,
    channel: !polled ? "seed" : prog.kind === "release" ? prog.channel : "stable",
    notes: spec.notes || null, launch: { exe: spec.launch.exe, args: spec.launch.argv, ...(spec.launch.cwd ? { cwd: spec.launch.cwd } : {}) },
  };
  // a polled runtime's release comes from the poller, a forge plan's from its check; the others show the pinned file
  if (!polled && !forge) rt.latest = pin ? { tag: pin.tag, name: pin.tag, date: null, prerelease: false, asset: { name: pin.asset, url: pin.url, size: pin.size }, page: null } : null;
  return rt;
}

/** one contribution per game with a way: its own title (by id) and a route per way */
export function collectSync(): Contribution[] {
  const plans = new Map((wstmts.plansAll.all() as PlanRow[]).map(p => [p.id, p]));
  const out: Contribution[] = [];
  // The ways module creates its schema after catalog providers can first be imported.
  const gamesWithWays = db.query("SELECT g.* FROM games g WHERE EXISTS (SELECT 1 FROM ways w WHERE w.game_id=g.id) ORDER BY g.id");
  for (const g of gamesWithWays.all() as GameRow[]) {
    ensureTitle(g);
    const routes = (wstmts.waysForGame.all(g.id) as WayRow[]).flatMap(w => { const p = plans.get(w.plan_id); return p && !automaticProblem(p, w) ? [routeFor(w, p, g)] : []; });
    // the game's own year, date and platforms: they fill a title that has none, so its year keeps other games' titles apart
    out.push({
      title: { ids: [{ scheme: "registry", value: `game:${g.id}` }], name: g.name, aliases: gameAliases(g), gameId: g.id, year: g.release_year ?? null, releaseIso: g.release_iso ?? null, platforms: gamePlatforms(g) },
      routes,
    });
  }
  return out;
}
export const runtimesSync = (): RuntimeInput[] => (wstmts.plansAll.all() as PlanRow[]).map(runtimeFor);

export const customProvider: Provider = {
  id: CUSTOM_ID, label: "Ways to play built here", every: 15, metaRank: 5,
  about: "The ways to play this server builds from plans (recomps, ports, emulators): a route under each game that has one, and each plan's program as a runtime. Switched off, they leave the catalog and its release checks; building them still works.",
  runtimes: () => runtimesSync(),
  async collect() { q.dropOrphanRuntimes(); return collectSync(); },
};

/** the source switched off in Settings → Metadata: nothing is ingested (the worker skips it too) */
const switchedOff = () => registry.instanceRows("metadata").some(r => r.impl === CUSTOM_ID && !r.enabled);

/** after a plan, way or game write: the custom snapshot again, at once */
export function reingestCustom(): { titles: number; routes: number } | null {
  if (switchedOff()) return null;
  try {
    q.dropOrphanRuntimes();
    const r = ingest(customProvider, collectSync(), runtimesSync());
    events.emit("catalog", { source: CUSTOM_ID, ...r });
    return r;
  } catch (e: any) {
    log.warn(`${CUSTOM_ID}: ${e?.message ?? e}`);                     // the write itself stands; the next run catches up
    return null;
  }
}

/** a deleted plan's runtime row goes with it (runtimes are never dropped by an ingest) */
export const dropPlanRuntime = (slug: string) => q.dropRuntime.run(`plan:${slug}`);
