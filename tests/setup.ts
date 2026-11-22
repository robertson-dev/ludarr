/**
 * bun test preload — isolates every test run from the real DB, downloads dir, worker, and
 * the real Prowlarr/seedbox (bun auto-loads .env, so those keys are scrubbed here).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.AHOY_DOWNLOADS = mkdtempSync(join(tmpdir(), "ahoy-test-"));
process.env.FETCH_WORKER = "0";
process.env.AHOY_LIBRARY = mkdtempSync(join(tmpdir(), "ahoy-lib-"));
process.env.AHOY_WORK = mkdtempSync(join(tmpdir(), "ahoy-work-"));
process.env.LUDARR_BLOCKS_DIR = mkdtempSync(join(tmpdir(), "ahoy-blocks-"));       // block indexes (src/blocks.ts), never in the repo
for (const k of Object.keys(process.env)) {
  if (/^(PROWLARR|RTORRENT|NZBGET|SEEDBOX|BOSUN|IGDB|ANTHROPIC|AGENT|PROCESS|REQUEST|DISCOVER|FOLLOW|GITHUB|CATALOG)_/.test(k)) delete process.env[k];
}
