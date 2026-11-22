/**
 * The seedbox tests' world (tests/seedbox-review*.test.ts): the mapped folder's probe, the download client's word, the clock
 * and the grabs stubbed — no network, no mount. The same setup tests/seedbox-resilience.test.ts uses, shared.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type FetchRow, type GameRow, type JobRow, type RequestRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { rdeps, createRequest, requestsTick } from "../src/requests";
import { rdeps as runner } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { inspectRom } from "../src/process/validate";
import { probeRoot, resetRemote, rmdeps, type ClientView, type Probe } from "../src/remote";
import { cancelAllPulls, deps as fdeps, FetchError, forgetSnapshots } from "../src/fetch";
import { sgdeps } from "../src/seeding";
import { hdeps } from "../src/health";
import type { ImportResult } from "../src/plugins/types";
import type { ReleaseView } from "../src/releases";

export const S = {
  now: Date.now(),
  /** what the probe of the folder sees */
  mount: { ok: true, ms: 4, entries: 40, dev: "fuse-1", mounted: true, why: null } as Probe,
  /** what the download's client says of it */
  view: { answered: true, has: true, complete: true, size: 75_482_117_932, name: "rTorrent" } as ClientView,
  grabs: [] as string[],
  grabFails: 0,
  seq: 0,
  made: [] as number[],
  protocol: "torrent" as "torrent" | "usenet",
};
const saved = { r: { ...rdeps }, rm: { ...rmdeps }, run: { ...runner }, f: { ...fdeps }, p: { ...pdeps }, sg: { ...sgdeps }, h: { ...hdeps } };
export const tmp = mkdtempSync(join(tmpdir(), "seedbox-review-"));
/** the seedbox's downloads folder as ludarr sees it (the rclone mount, bound in as /remote/downloads) */
export const ROOT = join(tmp, "remote", "downloads");
export const MAPPED = { from: "/home/user/downloads", to: ROOT, client: "rTorrent (direct)", instanceId: 7 };
export const A = "Call.of.Duty.Modern.Warfare.4.v13.1.29465156", B = "Call of Duty Modern Warfare 4 [FitGirl Repack]";

export function install() {
  beforeAll(() => { ensureDefaultRootFolder(); mkdirSync(ROOT, { recursive: true }); });
  beforeEach(() => {
    // what other files left in flight (one database for the whole run) is not woken by this file's clock
    db.exec("UPDATE requests SET state='cancelled' WHERE state IN ('requested','matching','fetching','processing')");
    db.exec("UPDATE fetches SET state='failed' WHERE state IN ('submitted','downloading','seedbox_done','pulling')");
    db.exec("UPDATE jobs SET state='cancelled' WHERE state IN ('queued')");
    resetRemote(); cancelAllPulls(); forgetSnapshots();
    S.now = Date.now(); S.grabs = []; S.grabFails = 0; S.protocol = "torrent";
    S.mount = { ok: true, ms: 4, entries: 40, dev: "fuse-1", mounted: true, why: null };
    S.view = { answered: true, has: true, complete: true, size: 75_482_117_932, name: "rTorrent" };
    rmdeps.roots = () => [MAPPED];
    rmdeps.probe = async () => ({ ...S.mount });
    rmdeps.clientView = async () => ({ ...S.view });
    rmdeps.now = () => S.now;
    rdeps.now = () => S.now;
    rdeps.log = () => {};
    rdeps.usenetAvailable = async () => false;
    rdeps.agentReady = () => false;
    rdeps.grab = async (rel, gameId) => {
      S.grabs.push(rel.title);
      if (S.grabFails > 0) { S.grabFails--; throw new FetchError("rTorrent did not answer (a timeout)", 503, true); }
      const usenet = S.protocol === "usenet";
      const row = stmts.insertFetch({ game_id: gameId, guid: rel.guid, indexer_id: 1, indexer: "GGn", title: rel.title, protocol: S.protocol, size: rel.size, info_hash: null, client: usenet ? "nzbget" : "rtorrent", client_id: usenet ? String(100 + S.grabs.length) : `H-${rel.title}-${S.seq}`, state: "submitted", release_json: JSON.stringify(rel), client_instance_id: 7 });
      return { fetch: { id: row.id } as never, duplicate: false };
    };
    pdeps.log = () => {};
    fdeps.now = () => S.now;
    fdeps.log = () => {};
  });
  afterEach(() => {
    Object.assign(rdeps, saved.r); Object.assign(rmdeps, saved.rm); Object.assign(runner, saved.run); Object.assign(fdeps, saved.f); Object.assign(pdeps, saved.p); Object.assign(sgdeps, saved.sg); Object.assign(hdeps, saved.h);
    resetRemote(); cancelAllPulls(); forgetSnapshots();
    for (const id of S.made) {
      db.query("UPDATE requests SET state='cancelled', remote_json=NULL WHERE game_id=? AND state IN ('requested','matching','fetching','processing','failed')").run(id);
      db.query("UPDATE fetches SET state=CASE WHEN state IN ('submitted','downloading','seedbox_done','pulling') THEN 'failed' ELSE state END, cleaned_at=COALESCE(cleaned_at, 1), trouble_json=NULL, retry_at=NULL WHERE game_id=?").run(id);
      db.query("UPDATE jobs SET state='cancelled' WHERE game_id=? AND state IN ('queued','running')").run(id);
    }
  });
  afterAll(() => {
    for (const id of S.made) for (const t of ["requests", "jobs", "blocklist", "fetches", "history", "packages"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
    for (const id of S.made) db.query("DELETE FROM games WHERE id=?").run(id);
    rmSync(tmp, { recursive: true, force: true });
  });
}

export const rv = (title: string, over: Partial<ReleaseView> = {}): ReleaseView => ({
  guid: `guid:${title}`, title, instanceId: 1, indexerId: 11, indexer: "GGn", size: 5e9, age: 10, publishDate: "", seeders: 40, leechers: 0, grabs: null, files: null,
  downloadUrl: "http://p/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: S.protocol, categories: [], indexerFlags: [], fileName: null,
  parsed: { group: null, repack: false, scene: false, version: null, edition: null, languages: null, dlc: false, junk: [], year: 2020, platform: "Windows", format: "Home Rip" },
  match: { ok: true, core: 1, optional: 1 }, score: 120, reasons: [], flags: { sequel: false, extraWords: false, buried: false, yearOff: null }, alsoOn: [],
  ...over,
} as ReleaseView);

export const req = (id: number) => stmts.requestById.get(id) as RequestRow;
export const job = (id: number) => stmts.jobById.get(id) as JobRow;
export const fetchRow = (id: number) => stmts.fetchById.get(id) as FetchRow;
export const blocks = (gameId: number) => db.query("SELECT guid, title, class FROM blocklist WHERE game_id=? ORDER BY id").all(gameId) as { guid: string | null; title: string; class: string | null }[];
export const importsOf = (requestId: number) => (db.query("SELECT COUNT(*) AS n FROM jobs WHERE request_id=? AND COALESCE(kind,'import')='import'").get(requestId) as { n: number }).n;
export const sec = () => Math.floor(S.now / 1000);
export const tick = () => new Promise(r => setTimeout(r, 0));

/** an import whose stub importer does what `run` says */
export function importer(run: (ctx: { input: string; staging: string }) => Promise<ImportResult>) {
  runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: run as never } }];
}
/** done with: a dump copied into staging (a valid package) */
export async function imported(ctx: { input: string; staging: string }): Promise<ImportResult> {
  cpSync(ctx.input, ctx.staging, { recursive: true });
  return { ok: true, shape: "folder", reason: null, platform: "n64", validation: await inspectRom(ctx.staging) };
}
export const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });
export const eio = (p: string) => Object.assign(new Error(`EIO: i/o error, read '${p}'`), { code: "EIO", path: p });

export function game(name = "Seedbox Review") {
  const g = upsertGame({ name: `${name} ${++S.seq}`, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${S.seq}-${Date.now()}`, platforms_json: '["win"]' } as Partial<GameRow>) as GameRow;
  S.made.push(g.id);
  return g;
}

/** a search for a new game whose first candidate (A, the 75 GB torrent — or a usenet post) finished on the seedbox and is read
 *  from its mapped folder; the next candidate (B, the repack) is what a wrong verdict would grab. `files`: what the download
 *  holds (name → bytes; default a valid N64 dump); `present: false`: nothing there */
export async function landedImport(o: { files?: Record<string, number>; present?: boolean } = {}) {
  const g = game();
  rdeps.search = async () => ({ query: {} as never, searched: [], raw: 2, ranked: [rv(A), rv(B, { score: 100 })], errors: [] });
  const { request } = createRequest({ gameId: g.id });
  await requestsTick();
  const r0 = req(request.id);
  expect(r0.state).toBe("fetching");
  const input = join(ROOT, `${A}-${S.seq}`);
  if (o.present !== false) {
    mkdirSync(input, { recursive: true });
    if (o.files) for (const [n, size] of Object.entries(o.files)) writeFileSync(join(input, n), new Uint8Array(size).fill(7));
    else { const dump = new Uint8Array(32_768).fill(3); dump.set([0x80, 0x37, 0x12, 0x40], 0); writeFileSync(join(input, "Seedbox Quest (USA).z64"), dump); }
  }
  stmts.setFetchSeedbox.run(`/home/user/downloads/${A}-${S.seq}`, 1, 75_482_117_932, r0.fetch_id);
  stmts.setFetchDone.run(input, r0.fetch_id);
  await requestsTick();
  const r = req(request.id);
  expect(r.state).toBe("processing");
  return { g, r, input, firstJob: r.job_id! };
}
/** the folder answered steadily: two healthy probes, 40 s apart (the monitor does this every 30 s while anything waits) */
export async function steady() { await probeRoot(ROOT); S.now += 40_000; await probeRoot(ROOT); }
/** a request's wait comes to its next turn: its time come, the folder steady, the searcher's look */
export async function turn(requestId: number) { S.now = (req(requestId).next_try_at! + 1) * 1000; await steady(); await requestsTick(); }
