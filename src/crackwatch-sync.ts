/**
 * ludarr — crack status for the library and the storefront feeds, from CrackWatch: the DRM a game carries,
 * whether it is cracked, since when and by whom. Checked on a schedule: what can still change (uncracked,
 * unreleased) every run, what is settled (cracked) weekly, what the site does not track every few days. The
 * moment a monitored game without a copy turns cracked, a search starts: that is the day there is something
 * to find. Nothing here fetches a release; it only says whether one can exist.
 */
import { stmts, type GameRow } from "./db";
import { cfgNum } from "./config";
import { logger } from "./log";
import { cwFind, type CwGame } from "./crackwatch";
import { record } from "./library/history";
import { createRequest, retryRequest } from "./requests";
import type { RequestRow } from "./db";

const log = logger("CrackWatch");
const H = 3600;

/** swappable in tests */
export const cwsdeps = { find: (title: string): Promise<CwGame | null> => cwFind(title), createRequest, retryRequest, now: () => Date.now() };

export interface CrackVerdict { drm: string | null; status: string; date: string | null; group: string | null; slug: string | null }
const verdictOf = (g: CwGame | null): CrackVerdict => (g ? { drm: g.drm, status: g.status, date: g.crackDate, group: g.group, slug: g.slug } : { drm: null, status: "untracked", date: null, group: null, slug: null });

/** how long a verdict stands before it is looked at again */
export const dueIn = (status: string | null | undefined): number => (status === "cracked" ? 7 * 24 * H : status === "untracked" ? 3 * 24 * H : 6 * H);

/** look one library game up and store what CrackWatch says; a game that just turned cracked gets its search */
export async function checkGame(g: GameRow): Promise<CrackVerdict | null> {
  let found: CwGame | null;
  try { found = await cwsdeps.find(g.name); }
  catch (e: any) { log.warn(`${g.name}: ${e?.message ?? e}`); return null; }
  const v = verdictOf(found);
  const was = g.crack_status;
  stmts.setGameCrack.run(v.drm, v.status, v.date, v.group, v.slug, Math.floor(cwsdeps.now() / 1000), g.id);
  const playable = v.status === "cracked" || v.status === "hypervisor";
  if (playable && (was === "uncracked" || was === "unreleased" || (was === "hypervisor" && v.status === "cracked"))) {
    const how = `${v.status === "hypervisor" ? "bypassed (hypervisor)" : "cracked"}${v.group ? ` by ${v.group}` : ""}${v.date ? ` on ${v.date}` : ""}${v.drm ? ` (${v.drm})` : ""}`;
    record(g.id, "cracked", { gameName: g.name, source: "CrackWatch", message: how });
    const active = stmts.requestActiveForGame.get(g.id) as RequestRow | undefined;
    if ((g.monitored ?? 1) === 1 && !stmts.packageForGame.get(g.id) && !active) {
      const r = cwsdeps.createRequest({ gameId: g.id, by: "crackwatch" });
      if (!r.duplicate) log.info(`${g.name}: ${how} — searching`);
    } else if (active?.state === "requested" && active.next_try_at && active.next_try_at > Math.floor(cwsdeps.now() / 1000)) {
      // the game's search waits (for a crack, most likely): it looks now, not at its next try hours from now
      cwsdeps.retryRequest(active.id);
      log.info(`${g.name}: ${how} — its waiting search looks now`);
    }
  }
  return v;
}

/** one pass: due library games first, then the storefront entries Discover shows. Returns what was looked at. */
export async function crackwatchSync(limit = 80): Promise<{ checked: number; changed: number }> {
  if (cfgNum("CRACKWATCH_SYNC_HOURS", 6) <= 0) return { checked: 0, changed: 0 };
  const now = Math.floor(cwsdeps.now() / 1000);
  let checked = 0, changed = 0;
  for (const g of stmts.gamesForCrackwatch.all() as GameRow[]) {
    if (checked >= limit) break;
    if (g.crackwatch_at && now - g.crackwatch_at < dueIn(g.crack_status)) continue;
    const v = await checkGame(g);
    if (!v) continue;
    checked++;
    if (v.status !== g.crack_status || v.drm !== g.drm) changed++;
  }
  for (const r of stmts.catalogForCrackwatch.all() as { steam_appid: number; name: string; crack_status: string | null; crackwatch_at: number | null }[]) {
    if (checked >= limit) break;
    if (r.crackwatch_at && now - r.crackwatch_at < dueIn(r.crack_status)) continue;
    let found: CwGame | null;
    try { found = await cwsdeps.find(r.name); } catch (e: any) { log.warn(`${r.name}: ${e?.message ?? e}`); continue; }
    const v = verdictOf(found);
    stmts.setCatalogCrack.run(v.drm, v.status, v.date, v.group, v.slug, now, r.steam_appid);
    checked++;
    if (v.status !== r.crack_status) changed++;
  }
  if (checked) log.info(`${checked} looked up, ${changed} changed`);
  return { checked, changed };
}
