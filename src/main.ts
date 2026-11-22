#!/usr/bin/env bun
/** ludarr — boot: load plugins, seed from the environment, resume work, schedule the workers, listen. */
import "./former";
import { app } from "./server";
import { websocket } from "hono/bun";
import { cfg, cfgNum, configDir, downloadsDir } from "./config";
import { logger, setLogLevel, type Level } from "./log";
import { VERSION } from "./version";
import { loadPlugins } from "./plugins/loader";
import { bootstrap } from "./bootstrap";
import { registerTask, startScheduler } from "./tasks";
import { tick as queueTick, readyClients } from "./fetch";
import { requestsTick, resumeRequests } from "./requests";
import { jobNeedsWork, processTick, resumeJobs } from "./process/runner";
import { catalogTick } from "./catalog/worker";
import { discoverTick, followsTick } from "./discover";
import { searchMissing } from "./library/games";
import { healthChecks } from "./health";
import { makeBackup } from "./api/system";
import { join } from "node:path";
import { expireUnpacks } from "./ways/unpack-cache";
import { rootFolders, workDirFor } from "./library/rootfolders";
import { resolveMissingArt } from "./art";
import { rssSync } from "./rss";
import { seedingTick } from "./seeding";
import { rescanLibrary } from "./library/rescan";
import { remoteTick } from "./remote";
import { arrivalsEverySec, arrivalsTick, resumeArrivals, watchSynced } from "./arrivals";
import { migrateSyncMap } from "./synced";
import { crackwatchSync } from "./crackwatch-sync";
import "./ways/make";                                    // the make job kind (game data made by recorded steps)
import { carryTick, ensureRuns } from "./ways/carry";    // carry runs (their table is made on import)
import { ensureWaysOfCopies } from "./ways/recipes";
import { scrubWorldWritable, SPARE_WORK, sweepSpareWork } from "./ways/sandbox";
import { sweepUploads } from "./uploads";
import { blocksTick, primeIndexes } from "./blocks";

const log = logger("App");
setLogLevel((cfg("LOG_LEVEL") as Level) || "info");

const plugins = await loadPlugins();
bootstrap();
// a download client's old "Synced folder" setting becomes the one "Finished downloads land in" (src/synced.ts), once
migrateSyncMap();

const port = cfgNum("PORT", 7979);
// a game file uploaded for a way to play can be a whole disc image: Bun refuses bodies over 128 MB unless told otherwise
// (every other body is capped where it is read: src/server.ts; a game uploaded from the web UI comes in pieces of 32 MB,
// so its size is not bound by this: src/uploads.ts)
// which packages can be sent as blocks is known before the first launcher asks (src/blocks.ts)
await primeIndexes().catch(() => { /* the task reads them again */ });
Bun.serve({ port, fetch: app.fetch, websocket, idleTimeout: 120, maxRequestBodySize: Math.max(1, cfgNum("CONTENT_UPLOAD_MAX_GB", 16)) * 1e9 });
log.info(`ludarr ${VERSION} listening on http://localhost:${port}`);
log.info(`config ${configDir()} · downloads ${downloadsDir()} · root folders ${rootFolders().map(r => r.path).join(", ") || "(none)"}`);
log.info(`plugins: ${plugins.loaded.join(", ")}${plugins.failed.length ? ` — failed: ${plugins.failed.map(f => f.id).join(", ")}` : ""}`);

if (process.env.FETCH_WORKER !== "0") {
  // the downloads held in the finished-downloads folder get their files' dates refreshed first: the folder's hourly cleanup
  // may have come close while ludarr was down (src/arrivals.ts)
  await resumeArrivals();
  resumeRequests();
  resumeJobs();
  registerTask({ name: "queue", label: "Check download clients", intervalSec: () => cfgNum("QUEUE_POLL_SEC", 10), run: queueTick });
  registerTask({ name: "searcher", label: "Searcher (match → download → import)", intervalSec: 3, run: requestsTick });
  registerTask({ name: "importer", label: "Import finished downloads", intervalSec: 5, run: processTick });
  registerTask({ name: "wanted", label: "Search missing and upgradable games", intervalSec: () => cfgNum("SEARCH_RECHECK_HOURS", 6) * 3600, run: async () => searchMissing() });
  registerTask({ name: "catalog", label: "Refresh catalog sources", intervalSec: 60, run: catalogTick });
  registerTask({ name: "discover", label: "Refresh storefront feeds", intervalSec: 600, run: discoverTick });
  registerTask({ name: "releases", label: "Check tracked release dates", intervalSec: 1800, run: async () => followsTick() });
  registerTask({ name: "health", label: "Health check", intervalSec: 300, run: () => healthChecks(true) });
  // the seedbox's mapped folders: probed every 5 min, every 30 s while anything waits on them (src/remote.ts)
  registerTask({ name: "seedbox", label: "Watch the seedbox's folders", intervalSec: 15, run: remoteTick });
  // downloads awaited in the finished-downloads folder, and the hold on their files: every second while anything is awaited,
  // else every 5 s (a change in the folder wakes it sooner)
  registerTask({ name: "arrivals", label: "Wait for downloads in the finished-downloads folder", intervalSec: arrivalsEverySec, run: async () => { watchSynced(); await arrivalsTick(); } });
  registerTask({ name: "backup", label: "Backup the database", intervalSec: 86_400, run: makeBackup });
  registerTask({ name: "art", label: "Find missing art", intervalSec: 6 * 3600, run: () => resolveMissingArt() });
  registerTask({ name: "rss", label: "RSS sync (new releases for wanted games)", intervalSec: () => Math.max(60, cfgNum("RSS_SYNC_MIN", 15) * 60), run: rssSync });
  registerTask({ name: "seeding", label: "Remove imported downloads from their clients (seed goals)", intervalSec: 600, run: seedingTick });
  registerTask({ name: "rescan", label: "Rescan the library on disk", intervalSec: 12 * 3600, run: rescanLibrary });
  registerTask({ name: "crackwatch", label: "Crack status from CrackWatch", intervalSec: () => Math.max(3600, cfgNum("CRACKWATCH_SYNC_HOURS", 6) * 3600), run: () => crackwatchSync() });
  // a repo carried all the way to a game members install: each run advanced from the world as it is, with no click
  registerTask({ name: "carry", label: "Carry repos through to playable games", intervalSec: 5, run: carryTick });
  // the backfill: a way for every console dump that has none (its console's emulator, src/ways/recipes.ts), then a run for
  // every way not built yet and every plan without a way (right after boot, then once a day)
  registerTask({ name: "carry-backfill", label: "Start carry runs for ways and plans not built yet", intervalSec: 86_400, run: async () => { await ensureWaysOfCopies(); await ensureRuns(); } });
  // the library stays ludarr's: nothing in the stores, the packages or the folders they sit in writable by others or by a
  // build program, and what jobs that no longer run left on the downloads folder's volume goes (the scheduler runs every
  // task once right after boot, then once a day)
  registerTask({
    name: "scrub", label: "Keep the library ludarr's (no write for others or build programs; leftover job folders removed)", intervalSec: 86_400,
    run: async () => {
      const s = await scrubWorldWritable();
      if (s.fixed) log.info(`scrub: ${s.fixed} of ${s.looked} entries in the library were writable by others or by a build program, and no longer are`);
      for (const top of new Set([...rootFolders().map(workDirFor), join(downloadsDir(), SPARE_WORK)])) await expireUnpacks(top);
      await sweepSpareWork(downloadsDir(), jobNeedsWork, line => log.info(`scrub: ${line}`));
    },
  });
  // games uploaded from the admin's PC (src/uploads.ts): one whose job ended while ludarr was down is settled, one
  // nobody finished (or whose job failed) goes after a week
  registerTask({ name: "uploads", label: "Tidy uploaded games (finished, or left unfinished for a week)", intervalSec: 3600, run: sweepUploads });
  // a package as blocks (src/blocks.ts): the index of each one that has none, one package a run, never while a job runs
  registerTask({ name: "blocks", label: "Index games so launchers take them as blocks", intervalSec: 20, run: blocksTick });
  startScheduler();
  readyClients();
}
