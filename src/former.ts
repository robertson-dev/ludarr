/**
 * ludarr — its former name. The engine was called playarr until 2026-11-21, and a server set up under that name keeps
 * working without being touched: what it still has under the old name is read, everything new is written under the
 * new one. This file is the one place that knows the old name.
 *
 *   environment   every PLAYARR_X the process is given counts as LUDARR_X, unless LUDARR_X is set itself
 *   database      <config>/playarr.db stays the database while there is no ludarr.db beside it (src/db.ts)
 *   settings      a setting saved as cfg.PLAYARR_X is read as LUDARR_X until that one is saved (src/config.ts)
 *   backups       playarr-*.db in <config>/backups are listed and thinned out with the new ones (src/api/system.ts)
 *   scripts       a notification script gets its PLAYARR_* variables beside the LUDARR_* ones
 *   Ahoy          art answers carry the old placeholder header beside the new one (src/api/art.ts)
 *   on disk       an interrupted import's marker is found under either name (src/process/runner.ts)
 *   runs          a step recorded as taken by "playarr" reads as taken by "ludarr" (src/ways/carry.ts)
 *   clients       a download client that relied on the old default label or category keeps it, written into its
 *                 settings once at start (src/bootstrap.ts)
 */
export const FORMER = "playarr";
const OLD_ENV = "PLAYARR_", NEW_ENV = "LUDARR_";

/** PLAYARR_X → LUDARR_X in the environment, where LUDARR_X is not set itself */
export function adoptFormerEnv(env: Record<string, string | undefined> = process.env): void {
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(OLD_ENV) || v == null) continue;
    const now = NEW_ENV + k.slice(OLD_ENV.length);
    if (env[now] == null) env[now] = v;
  }
}
adoptFormerEnv();

/** the old name of a LUDARR_X setting or variable; null for any other name */
export const formerKey = (key: string): string | null => (key.startsWith(NEW_ENV) ? OLD_ENV + key.slice(NEW_ENV.length) : null);

/** variables handed to a script: each LUDARR_X also under its old name */
export function withFormerEnv(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...vars };
  for (const [k, v] of Object.entries(vars)) { const old = formerKey(k); if (old && !(old in out)) out[old] = v; }
  return out;
}

/** a file, marker or header name as it was: "ludarr.db" → "playarr.db", ".ludarr-transfer-x" → ".playarr-transfer-x" */
export const formerName = (name: string): string => name.replace("ludarr", FORMER);
