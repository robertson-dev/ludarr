/**
 * The seedbox's trouble is never taken as "this copy is bad" (src/remote.ts; live incident 2026-11-09: import #79 of
 * Call of Duty: Modern Warfare 4 read /remote/downloads while the mount watchdog remounted it, failed with ENOENT on a file
 * that was there all along, and the request blocklisted the release and grabbed a 68 GB repack). Stubbed: the mapped
 * folder's probe, the clients, the clock; no network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type FetchRow, type GameRow, type JobRow, type RequestRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { rdeps, createRequest, requestsTick, retryRequest, resumeRequests } from "../src/requests";
import { rdeps as runner, runJob, resumeJobs } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { inspectRom } from "../src/process/validate";
import { clientTrouble, goneRule, ladderSec, probeRoot, remoteHealth, resetRemote, rmdeps, rootDown, steadyOrThrow, transportTrouble, watchJob, watchPath, wordsTrouble, type ClientView, type Probe } from "../src/remote";
import { cancelAllPulls, deps as fdeps, FetchError, forgetSnapshots, grab, tick as fetchTick, troubleOf } from "../src/fetch";
import { fromRtorrent } from "../src/seedbox-items";
import { seedingTick, sgdeps } from "../src/seeding";
import { NzbgetClient } from "../src/nzbget";
import { nzbget as nzbgetPlugin } from "../src/plugins/builtin/clients";
import { RtorrentClient } from "../src/rtorrent";
import { EnvError } from "../src/ways/errors";
import type { DownloadClient, ImportResult } from "../src/plugins/types";
import type { ReleaseView } from "../src/releases";
import type { RtItem } from "../src/rtorrent";
import type { PullHandle } from "../src/pull";

const saved = { r: { ...rdeps }, rm: { ...rmdeps }, run: { ...runner }, f: { ...fdeps }, p: { ...pdeps }, sg: { ...sgdeps } };
const tmp = mkdtempSync(join(tmpdir(), "seedbox-resilience-"));
/** the seedbox's downloads folder as ludarr sees it (the rclone mount, bound in as /remote/downloads) */
const ROOT = join(tmp, "remote", "downloads");
const MAPPED = { from: "/home/user/downloads", to: ROOT, client: "rTorrent (direct)", instanceId: 7 };
const made: number[] = [];

let now = Date.now();
/** what the probe of the folder sees: answering, its device (a remount gives it a new one), its FUSE mount, its entries */
let mount: Probe = { ok: true, ms: 4, entries: 40, dev: "fuse-1", mounted: true, why: null };
/** what rTorrent says of the download */
let view: ClientView = { answered: true, has: true, complete: true, size: 75_482_117_932, name: "rTorrent" };
let grabs: string[] = [];
let grabFails = 0;
let seq = 0;

beforeAll(() => { ensureDefaultRootFolder(); });
beforeEach(() => {
  // the searcher and the download worker go over every row in flight: what other files left in flight (the database is
  // shared by the files run in one process) would be woken by this file's clock, which jumps days
  db.exec("UPDATE requests SET state='cancelled' WHERE state IN ('requested','matching','fetching','processing')");
  db.exec("UPDATE fetches SET state='failed' WHERE state IN ('submitted','downloading','seedbox_done','pulling')");
  resetRemote(); cancelAllPulls(); forgetSnapshots();
  now = Date.now(); grabs = []; grabFails = 0;
  mount = { ok: true, ms: 4, entries: 40, dev: "fuse-1", mounted: true, why: null };
  view = { answered: true, has: true, complete: true, size: 75_482_117_932, name: "rTorrent" };
  rmdeps.roots = () => [MAPPED];
  rmdeps.probe = async () => ({ ...mount });
  rmdeps.clientView = async () => ({ ...view });
  rmdeps.now = () => now;
  rdeps.now = () => now;
  rdeps.log = () => {};
  rdeps.usenetAvailable = async () => false;
  rdeps.agentReady = () => false;
  rdeps.grab = async (rel, gameId) => {
    grabs.push(rel.title);
    if (grabFails > 0) { grabFails--; throw new FetchError("rTorrent did not answer (a timeout)", 503, true); }
    const row = stmts.insertFetch({ game_id: gameId, guid: rel.guid, indexer_id: 1, indexer: "GGn", title: rel.title, protocol: "torrent", size: rel.size, info_hash: null, client: "rtorrent", client_id: `H-${rel.title}`, state: "submitted", release_json: JSON.stringify(rel), client_instance_id: 7 });
    return { fetch: { id: row.id } as never, duplicate: false };
  };
  pdeps.log = () => {};
});
afterEach(() => {
  Object.assign(rdeps, saved.r); Object.assign(rmdeps, saved.rm); Object.assign(runner, saved.run); Object.assign(fdeps, saved.f); Object.assign(pdeps, saved.p); Object.assign(sgdeps, saved.sg);
  resetRemote(); cancelAllPulls(); forgetSnapshots();
  // what a test left waiting is not the next test's (the health list counts every wait)
  for (const id of made) {
    db.query("UPDATE requests SET state='cancelled', remote_json=NULL WHERE game_id=? AND state IN ('requested','matching','fetching','processing')").run(id);
    db.query("UPDATE fetches SET state=CASE WHEN state IN ('submitted','downloading','seedbox_done','pulling') THEN 'failed' ELSE state END, cleaned_at=COALESCE(cleaned_at, 1), trouble_json=NULL, retry_at=NULL WHERE game_id=?").run(id);
  }
});
afterAll(() => {
  for (const id of made) for (const t of ["requests", "jobs", "blocklist", "fetches", "history", "packages"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made) db.query("DELETE FROM games WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

const rv = (title: string, over: Partial<ReleaseView> = {}): ReleaseView => ({
  guid: `guid:${title}`, title, instanceId: 1, indexerId: 11, indexer: "GGn", size: 5e9, age: 10, publishDate: "", seeders: 40, leechers: 0, grabs: null, files: null,
  downloadUrl: "http://p/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent", categories: [], indexerFlags: [], fileName: null,
  parsed: { group: null, repack: false, scene: false, version: null, edition: null, languages: null, dlc: false, junk: [], year: 2020, platform: "Windows", format: "Home Rip" },
  match: { ok: true, core: 1, optional: 1 }, score: 120, reasons: [], flags: { sequel: false, extraWords: false, buried: false, yearOff: null }, alsoOn: [],
  ...over,
} as ReleaseView);
const A = "Call.of.Duty.Modern.Warfare.4.v13.1.29465156", B = "Call of Duty Modern Warfare 4 [FitGirl Repack]";

const req = (id: number) => stmts.requestById.get(id) as RequestRow;
const job = (id: number) => stmts.jobById.get(id) as JobRow;
const fetchRow = (id: number) => stmts.fetchById.get(id) as FetchRow;
const blocks = (gameId: number) => db.query("SELECT guid, title, class FROM blocklist WHERE game_id=? ORDER BY id").all(gameId) as { guid: string | null; title: string; class: string | null }[];
const historyOf = (gameId: number, event: string) => (db.query("SELECT COUNT(*) AS n FROM history WHERE game_id=? AND event=?").get(gameId, event) as { n: number }).n;
const importsOf = (requestId: number) => (db.query("SELECT COUNT(*) AS n FROM jobs WHERE request_id=? AND COALESCE(kind,'import')='import'").get(requestId) as { n: number }).n;
const sec = () => Math.floor(now / 1000);

/** an import whose stub importer does what `run` says; done with: a dump copied into staging (a valid package) */
function importer(run: (ctx: { input: string; staging: string }) => Promise<ImportResult>) {
  runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: run as never } }];
}
async function imported(ctx: { input: string; staging: string }): Promise<ImportResult> {
  cpSync(ctx.input, ctx.staging, { recursive: true });
  return { ok: true, shape: "folder", reason: null, platform: "n64", validation: await inspectRom(ctx.staging) };
}
const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });

/** a search for a new game whose first candidate (A, the 75 GB torrent) finished on the seedbox and is read from its mapped
 *  folder; the next candidate (B, the repack) is what a wrong verdict would grab */
async function landedImport(o: { present?: boolean } = {}) {
  const g = upsertGame({ name: `Seedbox Quest ${++seq}`, slug: `seedbox-quest-${seq}`, platforms_json: '["win"]' } as Partial<GameRow>) as GameRow;
  made.push(g.id);
  rdeps.search = async () => ({ query: {} as never, searched: [], raw: 2, ranked: [rv(A), rv(B, { score: 100 })], errors: [] });
  const { request } = createRequest({ gameId: g.id });
  await requestsTick();
  const r0 = req(request.id);
  expect(r0.state).toBe("fetching");
  const input = join(ROOT, `${A}-${seq}`);
  if (o.present !== false) {
    mkdirSync(input, { recursive: true });
    const dump = new Uint8Array(32_768).fill(3); dump.set([0x80, 0x37, 0x12, 0x40], 0);
    writeFileSync(join(input, "Seedbox Quest (USA).z64"), dump);
  }
  stmts.setFetchSeedbox.run(`/home/user/downloads/${A}-${seq}`, 1, 75_482_117_932, r0.fetch_id);
  stmts.setFetchDone.run(input, r0.fetch_id);
  await requestsTick();
  const r = req(request.id);
  expect(r.state).toBe("processing");
  return { g, r, input, firstJob: r.job_id! };
}
/** the folder answered steadily: two healthy probes, 40 s apart (the monitor does this every 30 s while anything waits) */
async function steady() { await probeRoot(ROOT); now += 40_000; await probeRoot(ROOT); }

describe("one classification of the read path's trouble", () => {
  test("an error's own code is the read path's (EIO, ETIMEDOUT, ESTALE, ENOTCONN, ECONNRESET, a timeout); ENOENT and a child's words are not, by themselves", () => {
    for (const code of ["EIO", "ETIMEDOUT", "ESTALE", "ENOTCONN", "ECONNRESET"]) expect(transportTrouble(Object.assign(new Error("x"), { code }), { words: false })).toContain(code);
    expect(transportTrouble(enoent("/remote/downloads/x.rar"), { words: false })).toBeNull();
    expect(transportTrouble(new DOMException("The operation timed out.", "TimeoutError"))).toBe("a timeout");
    // what a child program printed only calls for a closer look
    expect(wordsTrouble("unrar: Read error in the file Call.of.Duty.MW4.SP.rar")).toBe("Read error");
    expect(wordsTrouble("Transport endpoint is not connected")).toBeTruthy();
    expect(wordsTrouble("CRC failed in the encrypted file x.bin. Corrupt file or wrong password.")).toBeNull();
    // a client's own call: timeouts, 5xx, dropped connections are its trouble; what it says of a release is not
    expect(clientTrouble(new Error("RTORRENT_HTTP_503"))).toBeTruthy();
    expect(clientTrouble(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBeTruthy();
    expect(clientTrouble(new Error("rTorrent cannot take an NZB"))).toBeNull();
    // the gone rule: 3 looks over 15 minutes at least; the ladder: 1, 2, 5 … 60 min, then hourly
    expect(goneRule([0, 300, 899])).toBe(false); expect(goneRule([0, 900])).toBe(false); expect(goneRule([0, 400, 900])).toBe(true);
    expect([0, 1, 2, 3, 6, 7, 30].map(n => ladderSec(n) / 60)).toEqual([1, 2, 5, 10, 60, 60, 60]);
  });
});

describe("an import reading the seedbox's folder", () => {
  test("the incident replayed: ENOENT mid-import while the folder was remounted — waited out, then imported; nothing blocklisted, no second grab", async () => {
    const { g, r, input, firstJob } = await landedImport();
    let runs = 0;
    importer(async ctx => {
      if (++runs === 1) { mount = { ...mount, dev: "fuse-2" }; throw enoent(join(ctx.input, "Call.of.Duty.MW4.SP.rar")); }   // the watchdog remounted it mid-read
      return imported(ctx);
    });
    await runJob(firstJob);
    const j = job(firstJob);
    expect(j.state).toBe("failed");
    expect(JSON.parse(j.fail_json!)).toMatchObject({ class: "env", kind: "remote", remote: { troubled: true, trouble: "remounted" } });
    expect(j.message).toMatch(/^the seedbox folder was remounted while it was being read \(it ended: ENOENT/);
    expect(historyOf(g.id, "importFailed")).toBe(0);                          // the seedbox's trouble, not an import that failed
    await requestsTick();
    let q = req(r.id);
    expect(q.state).toBe("processing"); expect(q.job_id).toBe(firstJob);
    expect(q.stage).toBe("the seedbox folder was remounted while it was being read — trying again in a minute");
    expect(q.next_try_at).toBe(sec() + 60);
    expect(blocks(g.id)).toEqual([]); expect(grabs).toEqual([A]);
    await requestsTick();
    expect(req(r.id).job_id).toBe(firstJob);                                  // not before its time
    now += 61_000; await steady();
    await requestsTick();
    q = req(r.id);
    expect(q.job_id).not.toBe(firstJob); expect(q.stage).toBe("importing");
    expect(JSON.parse(q.remote_json!)).toMatchObject({ kind: "import", tries: 1, jobId: null });
    await runJob(q.job_id!);
    expect(job(q.job_id!).state).toBe("done");
    await requestsTick();
    q = req(r.id);
    expect(q).toMatchObject({ state: "ready", stage: "imported", remote_json: null });
    expect(blocks(g.id)).toEqual([]); expect(grabs).toEqual([A]); expect(historyOf(g.id, "blocklisted")).toBe(0);
    expect(importsOf(r.id)).toBe(2);
  });

  for (const code of ["EIO", "ETIMEDOUT", "ESTALE", "ENOTCONN"]) {
    test(`a read that fails with ${code} on a folder that otherwise answers: the seedbox's, waited out — no blocklist, no other copy`, async () => {
      const { g, r, firstJob } = await landedImport();
      let runs = 0;
      importer(async ctx => { if (++runs === 1) throw Object.assign(new Error(`${code}: read failed`), { code }); return imported(ctx); });
      await runJob(firstJob);
      expect(JSON.parse(job(firstJob).fail_json!)).toMatchObject({ class: "env", kind: "remote", remote: { trouble: "io" } });
      await requestsTick();
      expect(req(r.id).stage).toContain(`reading the seedbox folder failed`);
      expect(req(r.id).stage).toContain(code);
      now += 61_000; await steady(); await requestsTick();
      await runJob(req(r.id).job_id!); await requestsTick();
      expect(req(r.id).state).toBe("ready");
      expect(blocks(g.id)).toEqual([]); expect(grabs).toEqual([A]);
    });
  }

  test("a job never starts reading a folder that does not answer: it waits in the queue saying so", async () => {
    const { r } = await landedImport();
    mount = { ...mount, ok: false, dev: null, entries: null, why: "Transport endpoint is not connected" };
    await probeRoot(ROOT);
    expect(rootDown(ROOT)).toBe(true);
    const { processTick } = await import("../src/process/runner");
    // only this test's job in the queue (the database is shared with the files run before this one)
    db.query("UPDATE jobs SET state='cancelled' WHERE state='queued' AND id<>?").run(req(r.id).job_id);
    await processTick();
    const j = job(req(r.id).job_id!);
    expect(j.state).toBe("queued");
    expect(j.message).toBe("waiting for the seedbox folder, which does not answer (Transport endpoint is not connected)");
    await requestsTick();
    expect(req(r.id).stage).toBe(j.message);
  });

  test("an archiver that prints the kernel's own words for a failed read ('Input/output error') is the read path's however often it happens — never the copy's", async () => {
    const { g, r, firstJob } = await landedImport();
    const ai: string[] = [];
    runner.importers = () => [
      { impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "archive", reason: "7z failed on Call.of.Duty.MW4.SP.rar (exit 2): ERROR: Call.of.Duty.MW4.SP.rar : Input/output error" })) as never } },
      { impl: "agent", name: "AI importer", importer: { probe: async () => true, run: (async () => { ai.push("ran"); return { ok: false, shape: "archive", reason: "gave up" }; }) as never } },
    ];
    await runJob(firstJob);
    expect(JSON.parse(job(firstJob).fail_json!)).toMatchObject({ class: "env", kind: "remote", remote: { trouble: "io" } });
    expect(ai).toEqual([]);                                                  // the AI importer never read the troubled folder
    await requestsTick();
    for (let i = 0; i < 3; i++) {
      expect(req(r.id).stage).toMatch(/^reading the seedbox folder failed: "Input\/output error" — trying again in /);
      now = (req(r.id).next_try_at! + 1) * 1000; await steady(); await requestsTick();
      const j = req(r.id).job_id!;
      await runJob(j); await requestsTick();
    }
    expect(req(r.id).state).toBe("processing"); expect(grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
    expect(importsOf(r.id)).toBe(4);
  });

  test("a corrupt archive on a steady folder is the copy's: blocklisted and the next copy grabbed, as before", async () => {
    const { g, r, firstJob } = await landedImport();
    importer(async () => ({ ok: false, shape: "archive", reason: "unrar failed on Call.of.Duty.MW4.SP.rar (exit 3): CRC failed in Call.of.Duty.MW4.SP.rar. Corrupt file or wrong password." }));
    await runJob(firstJob);
    expect(JSON.parse(job(firstJob).fail_json!)).toMatchObject({ class: "other", remote: { troubled: false, absent: false, io: false } });
    await requestsTick();
    const q = req(r.id);
    expect(q.state).toBe("fetching"); expect(grabs).toEqual([A, B]);
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: null }]);   // the copy is refused: its title, every post
  });

  test("a child's I/O words on a steady folder get one confirming re-run; the same end again is the copy's", async () => {
    const { g, r, firstJob } = await landedImport();
    importer(async () => ({ ok: false, shape: "archive", reason: "unrar failed on Call.of.Duty.MW4.SP.rar (exit 3): Read error in the file Call.of.Duty.MW4.SP.rar" }));
    await runJob(firstJob);
    expect(JSON.parse(job(firstJob).fail_json!)).toMatchObject({ class: "other", remote: { troubled: false, io: true } });
    await requestsTick();
    expect(req(r.id).stage).toMatch(/running it once more to tell the seedbox from the copy — trying again in a minute$/);
    expect(blocks(g.id)).toEqual([]);
    now += 61_000; await steady(); await requestsTick();
    const second = req(r.id).job_id!;
    expect(second).not.toBe(firstJob);
    await runJob(second); await requestsTick();
    expect(grabs).toEqual([A, B]);                                           // the re-run ended the same way: the copy's
    expect(blocks(g.id).map(b => b.title)).toEqual([A]);
    expect(req(r.id).remote_json).toBeNull();
  });

  test("a file really gone: looked for 5 times over 15 minutes on a folder that answers, and rTorrent no longer has it → that post only is blocked, the next copy grabbed", async () => {
    const { g, r, firstJob } = await landedImport({ present: false });
    view = { answered: true, has: false, name: "rTorrent" };
    importer(imported);
    await runJob(firstJob);
    expect(job(firstJob).message).toMatch(/^input is gone/);
    expect(JSON.parse(job(firstJob).fail_json!)).toMatchObject({ class: "other", remote: { troubled: false, absent: true } });
    await requestsTick();
    let q = req(r.id);
    expect(q.state).toBe("processing");
    expect(q.stage).toMatch(/is not in the seedbox folder and rTorrent no longer lists it; another copy is tried once it stays away for 15 min — looking again in a minute$/);
    expect(q.message).toBeNull();                                            // the stage says it; the row does not repeat it
    for (const wait of [1, 2, 4, 8]) {
      expect(grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
      now += wait * 60_000 + 1000; await probeRoot(ROOT); await requestsTick();
    }
    q = req(r.id);
    expect(grabs).toEqual([A, B]); expect(q.state).toBe("fetching");
    expect(q.message ?? "").toBe("");                                          // cleared by the new grab
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: "source" }]);
    expect(importsOf(r.id)).toBe(1);                                        // looked for, never imported again in between
  });

  test("a file the folder does not show but rTorrent still has is never gone: the wait goes on, and asks about the path mapping after 30 minutes", async () => {
    const { g, r, firstJob } = await landedImport({ present: false });
    importer(imported);
    await runJob(firstJob);
    await requestsTick();
    expect(req(r.id).stage).toMatch(/the seedbox folder lost sight of .*; rTorrent still has it \(75\.5 GB\) — looking again in a minute$/);
    for (let i = 0; i < 12; i++) { now += 10 * 60_000; await probeRoot(ROOT); await requestsTick(); }
    const q = req(r.id);
    expect(q.state).toBe("processing"); expect(grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
    expect(q.stage).toContain("check the remote path mapping (Settings → Download clients)");
  });

  test("a usenet download the hourly move took out of complete/ is gone for good once its folder stayed away 3 times over 15 min (NZBGet's history is only a record): that post only is blocked, the next copy grabbed — never 72 h of looks", async () => {
    const { g, r, firstJob } = await landedImport({ present: false });
    db.query("UPDATE fetches SET protocol='usenet', client='nzbget' WHERE id=?").run(r.fetch_id);
    view = { answered: true, has: true, complete: true, size: 41e9, name: "NZBGet" };
    importer(imported);
    await runJob(firstJob);
    await requestsTick();
    expect(req(r.id).stage).toMatch(/is no longer in the seedbox folder: NZBGet finished it, so it was moved away \(the hourly move out of complete\/\?\); another copy is tried once it stays away for 15 min — looking again in a minute$/);
    expect(req(r.id).stage).not.toContain("remote path mapping");
    for (const wait of [1, 2, 4, 8]) {
      expect(grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
      now += wait * 60_000 + 1000; await probeRoot(ROOT); await requestsTick();
    }
    const q = req(r.id);
    expect(q.state).toBe("fetching"); expect(grabs).toEqual([A, B]);
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: "source" }]);   // the post, never the title
    expect(importsOf(r.id)).toBe(1);
  });

  test("the wait is bounded: a warning after 2 h, an error and the request asking after 6 h, and after 72 h it stops — the download kept, nothing blocklisted; Retry picks it up", async () => {
    const { g, r, firstJob } = await landedImport();
    // a read of a folder that does not answer fails (the test's own folder is local: the importer says what the mount would)
    importer(async ctx => { if (!mount.ok) throw Object.assign(new Error(`ENOTCONN: socket is not connected, scandir '${ctx.input}'`), { code: "ENOTCONN" }); return imported(ctx); });
    mount = { ok: false, ms: 10_000, entries: null, dev: null, mounted: false, why: "Transport endpoint is not connected" };
    await runJob(firstJob);
    expect(JSON.parse(job(firstJob).fail_json!)).toMatchObject({ class: "env", kind: "remote", remote: { trouble: "mount-down" } });
    await requestsTick();
    const t0 = sec();
    now += 2 * 3600_000 + 1000; await requestsTick();
    let health = remoteHealth(sec());
    expect(health.map(h => h.type)).toEqual(["warning", "warning"]);
    expect(health[0].message).toContain(`the seedbox folder ${ROOT} (rTorrent (direct)) has not answered since`);
    expect(health[1].message).toMatch(/^1 import has waited on the seedbox since \d\d:\d\d: nothing was thrown away/);
    expect(req(r.id).stage).toMatch(/^the seedbox folder does not answer \(Transport endpoint is not connected\) — trying again in a minute \(waiting since \d\d:\d\d; nothing was thrown away\)$/);
    now += 4 * 3600_000; await requestsTick();
    health = remoteHealth(sec());
    expect(health.map(h => h.type)).toEqual(["error", "error"]);
    expect(req(r.id).stage).toMatch(/ludarr keeps trying every hour and nothing was thrown away: Retry \(Activity → Queue\) tries now, Remove \(with blocklist\) gives this copy up$/);
    // never a loop: while the folder does not answer the import is not run again — and 72 h on, the request stops
    for (let h = 6; h < 72; h += 6) { expect(req(r.id).state).toBe("processing"); now += 6 * 3600_000; await requestsTick(); }
    expect(importsOf(r.id)).toBe(1);
    let q = req(r.id);
    expect(q.state).toBe("failed"); expect(q.stage).toBe("waited 3 days for the seedbox");
    expect(q.message).toContain("the download is kept and nothing was blocklisted: Retry once the seedbox answers again");
    expect(JSON.parse(q.remote_json!)).toMatchObject({ stopped: true, since: t0 });
    expect(blocks(g.id)).toEqual([]); expect(grabs).toEqual([A]);
    await requestsTick(); await requestsTick();
    expect(req(r.id).state).toBe("failed"); expect(importsOf(r.id)).toBe(1);
    expect(remoteHealth(sec()).filter(h => /waited on the seedbox/.test(h.message))).toEqual([]);   // a stopped wait asks no more
    // the seedbox answers again; the admin's Retry runs it at once
    mount = { ok: true, ms: 4, entries: 40, dev: "fuse-3", mounted: true, why: null };
    const back = retryRequest(r.id);
    expect(back.state).toBe("processing");
    await requestsTick();
    q = req(r.id);
    expect(q.job_id).not.toBe(firstJob);
    await runJob(q.job_id!); await requestsTick();
    expect(req(r.id).state).toBe("ready"); expect(grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
  });

  test("a restart in the middle of a wait: the wait (its since, its tries) is on the row and goes on; the forgotten monitor looks again first", async () => {
    const { g, r, firstJob } = await landedImport();
    let runs = 0;
    importer(async ctx => { if (++runs === 1) { mount = { ...mount, dev: "fuse-2" }; throw enoent(join(ctx.input, "x.rar")); } return imported(ctx); });
    await runJob(firstJob);
    await requestsTick();
    const before = JSON.parse(req(r.id).remote_json!);
    // the process dies and comes back: everything in memory is gone
    resetRemote(); forgetSnapshots(); resumeRequests(); resumeJobs();
    now += 5 * 60_000;
    await requestsTick();
    let q = req(r.id);
    expect(q.job_id).toBe(firstJob);                                          // the monitor has not looked yet: nothing runs
    expect(q.stage).toMatch(/the seedbox folder has not been looked at yet — trying again in a minute$/);
    expect(JSON.parse(q.remote_json!)).toEqual(before);
    await steady(); now += 30_000; await requestsTick();
    q = req(r.id);
    expect(q.job_id).not.toBe(firstJob);
    expect(JSON.parse(q.remote_json!)).toMatchObject({ since: before.since, tries: 1 });
    await runJob(q.job_id!); await requestsTick();
    expect(req(r.id).state).toBe("ready"); expect(blocks(g.id)).toEqual([]); expect(grabs).toEqual([A]);
  });

  test("an importer that throws on a steady folder stops like one that gave up: the next importer (or the hold for the AI's key) takes over", async () => {
    const { r, firstJob } = await landedImport();
    runner.importers = () => [
      { impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: async () => { throw new Error("classify: unexpected shape"); } } },
      { impl: "agent", name: "AI importer", importer: { probe: async () => false, run: async () => { throw new Error("never"); } } },
    ];
    await runJob(firstJob);
    expect(job(firstJob).message).toBe("classify: unexpected shape — the AI importer could take over once it has an API key");
    await requestsTick();
    expect(req(r.id).stage).toMatch(/needs the AI importer/); expect(grabs).toEqual([A]);
  });
});

describe("the download clients not answering", () => {
  test("a grab the client did not answer is sent again later — the same release, nothing tried, nothing blocklisted, no other copy", async () => {
    const g = upsertGame({ name: `Grab Quest ${++seq}`, slug: `grab-quest-${seq}`, platforms_json: '["win"]' } as Partial<GameRow>) as GameRow;
    made.push(g.id);
    rdeps.search = async () => ({ query: {} as never, searched: [], raw: 2, ranked: [rv(A), rv(B, { score: 100 })], errors: [] });
    grabFails = 2;
    const { request } = createRequest({ gameId: g.id });
    await requestsTick();
    let q = req(request.id);
    expect(q.state).toBe("requested"); expect(q.attempt).toBe(0); expect(q.tried_json).toBeNull();
    // said as a copy sent once more, never "again in N h" (Ahoy reads that as a search that found nothing)
    expect(q.stage).toMatch(/^the download client did not answer \(.*rTorrent did not answer \(a timeout\)\) — sending it once more in a minute$/);
    expect(grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
    now += 61_000; await requestsTick();                                      // still no answer: the ladder's next wait
    q = req(request.id);
    expect(grabs).toEqual([A, A]); expect(q.state).toBe("requested"); expect(q.next_try_at).toBe(sec() + 120);
    now += 121_000; await requestsTick();
    q = req(request.id);
    expect(grabs).toEqual([A, A, A]); expect(q.state).toBe("fetching"); expect(q.remote_json).toBeNull();
    expect(JSON.parse(q.release_json!).title).toBe(A); expect(blocks(g.id)).toEqual([]);
  });

  test("NZBGet's answer to an append was lost: sent again, it finds the item by the release's dupe key — no second download", async () => {
    const queue: Record<string, unknown>[] = [];
    let appends = 0, loseAnswer = true;
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "listgroups") return Response.json({ result: queue });
      if (body.method === "history") return Response.json({ result: [] });
      if (body.method === "append") {
        appends++;
        queue.push({ NZBID: 77, NZBName: "MW4", Status: "QUEUED", DupeKey: body.params[6], FileSizeLo: 10, FileSizeHi: 0, RemainingSizeLo: 10, RemainingSizeHi: 0 });
        if (loseAnswer) { loseAnswer = false; throw new DOMException("The operation timed out.", "TimeoutError"); }
        return Response.json({ result: 77 });
      }
      return Response.json({ result: null });
    }) as unknown as typeof fetch;
    const ctx = { fetch: f, log: { info() {}, warn() {}, error() {}, debug() {} }, paths: { downloads: tmp }, config: () => "" } as never;
    const client = nzbgetPlugin.create({ url: "https://box/nzbget", user: "u", pass: "p", category: "ludarr" }, ctx) as DownloadClient;
    const payload = { kind: "nzb" as const, bytes: new Uint8Array([1]), filename: "MW4.nzb" };
    await expect(client.add(payload, { title: "MW4", protocol: "usenet", key: "guid-mw4" })).rejects.toThrow(/timed out/);
    const again = await client.add(payload, { title: "MW4", protocol: "usenet", key: "guid-mw4" });   // the grab sent again
    expect(again).toEqual({ client: "nzbget", clientId: "77" });
    expect(appends).toBe(1);
    expect(queue[0].DupeKey).toBe("ludarr:guid-mw4");
    // NZBGet's own list is read queue first, then history: one after the other, never at once
    const order: string[] = [];
    const nz = new NzbgetClient((async (_u: string, init: RequestInit) => { order.push(JSON.parse(String(init.body)).method); await new Promise(r => setTimeout(r, 2)); return Response.json({ result: [] }); }) as unknown as typeof fetch, { url: "https://box/nzbget" });
    await nz.snapshot();
    expect(order).toEqual(["listgroups", "history"]);
  });

  test("rTorrent answering without a list is not read as 'it holds nothing'", async () => {
    const rt = new RtorrentClient((async () => new Response("<?xml version=\"1.0\"?><methodResponse></methodResponse>")) as unknown as typeof fetch, null, { url: "https://box/RPC2" });
    await expect(rt.list()).rejects.toThrow(/without a list/);
  });
});

/* ─────────── the download leg: the stall clock, vanishing, transfers ─────────── */

const HASH = (c: string) => c.repeat(40).slice(0, 40);
let rtItems: RtItem[] = [];
let itemsFail: Error | null = null;
let pulls: { resolve: (ok: boolean, err?: string) => void; cancelled: boolean }[] = [];
function rtClient(): DownloadClient {
  return {
    test: async () => ({ ok: true, detail: "" }),
    add: async () => { throw new Error("not used"); },
    items: async () => { if (itemsFail) throw itemsFail; return { items: rtItems.map(fromRtorrent) }; },
    remove: async () => {},
    pull: (_i, job) => {
      let resolve!: (ok: boolean, err?: string) => void;
      const p = { resolve: (ok: boolean, err?: string) => resolve(ok, err), cancelled: false };
      const done = new Promise<{ ok: boolean; localPath: string; bytes: number; error?: string }>(r => { resolve = (ok, error) => r({ ok, localPath: join(tmp, "dl", job.remotePath.split("/").pop()!), bytes: 0, error }); });
      pulls.push(p);
      return { localPath: join(tmp, "dl", "x"), done, progress: () => 0, bytes: () => 0, cancel: () => { p.cancelled = true; resolve(false, "cancelled"); } } as PullHandle;
    },
  };
}
const rtItem = (hash: string, over: Partial<RtItem> = {}): RtItem => ({
  hash, name: hash.slice(0, 6), complete: false, active: true, sizeBytes: 75e9, completedBytes: 0, downRate: 0, directory: "/home/user/downloads", multiFile: true,
  label: "ludarr", message: "", dataPath: `/home/user/downloads/${hash.slice(0, 6)}`, ...over,
});

describe("the download leg", () => {
  let g: GameRow;
  beforeEach(() => {
    rtItems = []; itemsFail = null; pulls = [];
    fdeps.clients = () => [{ id: 7, name: "rTorrent (direct)", client: rtClient(), protocols: ["torrent"] }];
    fdeps.clientById = id => (id === 7 ? rtClient() : null);
    fdeps.now = () => now;
    fdeps.log = () => {};
    g = upsertGame({ name: `Leg Quest ${++seq}`, slug: `leg-quest-${seq}`, platforms_json: '["win"]' } as Partial<GameRow>) as GameRow;
    made.push(g.id);
    rdeps.grab = async (rel, gameId) => {
      grabs.push(rel.title);
      const row = stmts.insertFetch({ game_id: gameId, guid: rel.guid, indexer_id: 1, indexer: "GGn", title: rel.title, protocol: "torrent", size: 75e9, info_hash: HASH(rel.title === A ? "a" : "b"), client: "rtorrent", client_id: HASH(rel.title === A ? "A" : "B"), state: "submitted", release_json: JSON.stringify(rel), client_instance_id: 7 });
      return { fetch: { id: row.id } as never, duplicate: false };
    };
    rdeps.search = async () => ({ query: {} as never, searched: [], raw: 2, ranked: [rv(A), rv(B, { score: 100 })], errors: [] });
  });
  async function downloading() {
    const { request } = createRequest({ gameId: g.id });
    await requestsTick();
    return req(request.id);
  }
  /** `n` client polls `everyMin` apart, each followed by the searcher's look */
  async function polls(n: number, everyMin: number) { for (let i = 0; i < n; i++) { now += everyMin * 60_000; await fetchTick(); await requestsTick(); } }

  test("a stall while the seedbox's link is full (others downloading at the week's best) is no stall: an hour on, the same copy waits", async () => {
    const r = await downloading();
    const others = [rtItem(HASH("C"), { downRate: 30e6, completedBytes: 1e9 }), rtItem(HASH("D"), { downRate: 28e6, completedBytes: 2e9 })];
    rtItems = [rtItem(HASH("A"), { peers: 6, seeders: 3 }), ...others];
    await polls(14, 5);                                                        // 70 minutes without a byte
    const f = fetchRow(r.fetch_id!);
    expect(f.still_sec).toBe(0); expect(grabs).toEqual([A]);
    expect(req(r.id).stage).toBe("downloading — the seedbox's link is full with other downloads: it waits, nothing is wrong with this copy");
  });

  test("a stall with no peers on a seedbox that answers (others moving) is a dead post: 45 min on, that post is blocked and the next copy grabbed", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { peers: 0, seeders: 0 }), rtItem(HASH("C"), { downRate: 30e6, completedBytes: 1e9 })];
    await polls(9, 5);                                                         // 45 minutes, the first poll only starts the clock
    expect(grabs).toEqual([A]);
    await polls(1, 5);
    expect(grabs).toEqual([A, B]);
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: "source" }]);
    expect(req(r.id).message ?? "").toBe("");
  });

  test("a client that does not answer for 50 min: nothing counts as a stall, nothing vanishes", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { peers: 0, seeders: 0 })];
    await polls(1, 1);
    itemsFail = new DOMException("The operation timed out.", "TimeoutError") as unknown as Error;
    await polls(10, 5);
    let f = fetchRow(r.fetch_id!);
    expect(f.state).toBe("downloading"); expect(f.still_sec).toBe(0); expect(grabs).toEqual([A]);
    expect(req(r.id).stage).toMatch(/^downloading — the download client has not answered since \d\d:\d\d \(nothing counts as a stall while it is silent\)$/);
    itemsFail = null; rtItems = [];                                           // it answers again, with a list that lacks the item
    await polls(2, 5);
    f = fetchRow(r.fetch_id!);
    expect(f.state).toBe("downloading");                                      // missing twice over 5 min: nothing yet
    expect(troubleOf(f)?.missing?.length).toBe(2);
  });

  test("a transfer the seedbox broke off resumes later; one that stands still for 15 min is stopped and tried again; one gone for good fails as its source", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { complete: true, completedBytes: 75e9 })];
    await fetchTick();
    expect(pulls).toHaveLength(1);
    pulls[0].resolve(false, "connection ended early at byte 123 of /x.rar");
    await new Promise(res => setTimeout(res, 0));
    let f = fetchRow(r.fetch_id!);
    expect(f.state).toBe("seedbox_done"); expect(f.message).toMatch(/^the transfer broke off: connection ended early/);
    await requestsTick();
    expect(req(r.id).stage).toMatch(/^waiting to transfer: the transfer broke off: connection ended early .* — trying again in a minute$/);
    now += 61_000; await fetchTick();
    expect(pulls).toHaveLength(2);
    // the watchdog: no byte for 15 minutes → stopped, tried again later (it resumes)
    now += 16 * 60_000; await fetchTick();
    expect(pulls[1].cancelled).toBe(true);
    f = fetchRow(r.fetch_id!);
    expect(f.state).toBe("seedbox_done"); expect(f.message).toMatch(/^the transfer stopped moving for 16 min — trying again in 2 min/);
    // the files are gone and rTorrent no longer has it: looked for at 0, 1, 3, 7 and 15 min, then a failure of the source
    let calls = 0;
    rmdeps.clientView = async () => { calls++; return { answered: true, has: false, name: "rTorrent" }; };
    for (const wait of [3, 1, 2, 4, 8]) {
      expect(fetchRow(r.fetch_id!).state).toBe("seedbox_done");
      now += wait * 60_000 + 1000; await fetchTick();
      const p = pulls.at(-1)!; p.resolve(false, "HTTP 404 for /home/user/downloads/AAAAAA");
      await new Promise(res => setTimeout(res, 0));
    }
    f = fetchRow(r.fetch_id!);
    expect(calls).toBe(5);
    expect(f.state).toBe("failed"); expect(f.message).toMatch(/^gone from the seedbox: AAAAAA was not there 5 times over 15 min and rTorrent no longer has it$/);
    await requestsTick();
    expect(grabs).toEqual([A, B]);
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: "source" }]);
  });

  test("a restart in the middle of a transfer's wait: its time is on the row — nothing before it, then it resumes", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { complete: true, completedBytes: 75e9 })];
    await fetchTick();
    pulls[0].resolve(false, "lftp exit 1: Fatal error: max-retries exceeded");
    await new Promise(res => setTimeout(res, 0));
    const at = fetchRow(r.fetch_id!).retry_at!;
    cancelAllPulls(); forgetSnapshots(); resetRemote();                      // the process dies and comes back
    now += 30_000; await fetchTick();
    expect(pulls).toHaveLength(1); expect(fetchRow(r.fetch_id!).retry_at).toBe(at);
    now = (at + 1) * 1000; await fetchTick();
    expect(pulls).toHaveLength(2); expect(fetchRow(r.fetch_id!).state).toBe("pulling");
  });
});

describe("seeding and the ways' jobs", () => {
  test("seeding: one list without the item deletes nothing; a client the connector could not reach deletes nothing", async () => {
    const g = upsertGame({ name: `Seed Quest ${++seq}`, slug: `seed-quest-${seq}`, platforms_json: '["win"]' } as Partial<GameRow>) as GameRow;
    made.push(g.id);
    const f = db.query("INSERT INTO fetches (game_id, title, protocol, client, client_id, state, local_path, client_instance_id, imported_at) VALUES (?,?,?,?,?,'done',?,7,1) RETURNING *").get(g.id, "MW4", "torrent", "rtorrent", "ZZZ", join(ROOT, "MW4")) as FetchRow;
    const deleted: string[] = [];
    let unavailable: ("rtorrent" | "nzbget")[] = ["rtorrent"];
    sgdeps.clientById = () => ({ test: async () => ({ ok: true, detail: "" }), add: async () => { throw new Error("no"); }, items: async () => ({ items: [], unavailable }), remove: async () => {}, pull: () => ({ local: "/x" }), seedGoals: { ratio: 1, hours: 0 } });
    sgdeps.settingsOf = () => ({ pathMap: `/home/user/downloads=${ROOT}` });
    sgdeps.exists = async () => true;
    sgdeps.rm = async p => { deleted.push(p); };
    let t = now;
    sgdeps.now = () => t;
    expect(await seedingTick()).toBe(0);                                     // unavailable: not even counted
    expect(troubleOf(fetchRow(f.id))).toBeNull();
    unavailable = [];
    expect(await seedingTick()).toBe(0);
    t += 10 * 60_000; expect(await seedingTick()).toBe(0);
    expect(deleted).toEqual([]);
    t += 6 * 60_000; expect(await seedingTick()).toBe(1);                     // 3 times over 16 minutes: gone
    expect(deleted.length).toBe(1);
  });

  test("a job of the ways reading the seedbox's folder (a content job's download): its failure while the folder was remounted is 'remote', whatever its own type", async () => {
    const { jobKinds, enqueueJob } = await import("../src/process/kinds");
    const real = jobKinds.get("content");
    const input = join(ROOT, `content-${++seq}`);
    mkdirSync(input, { recursive: true });
    const { NeedsFiles } = await import("../src/ways/errors");
    jobKinds.set("content", { run: async () => { mount = { ...mount, dev: "fuse-9" }; throw new NeedsFiles(`${input} is gone`); }, scratch: () => 0 });
    try {
      const j = enqueueJob({ kind: "content", gameId: null, path: input, wayId: null });
      await runJob(j.id);
      expect(JSON.parse(job(j.id).fail_json!)).toMatchObject({ class: "env", kind: "remote", remote: { trouble: "remounted" } });
      // and one on a steady folder keeps its own type, with what its end says of the input
      now += 60_000;
      jobKinds.set("content", { run: async () => { throw new NeedsFiles("no game file in it"); }, scratch: () => 0 });
      const k = enqueueJob({ kind: "content", gameId: null, path: input, wayId: null });
      await runJob(k.id);
      expect(JSON.parse(job(k.id).fail_json!)).toMatchObject({ class: "file", remote: { troubled: false, absent: false } });
    } finally { if (real) jobKinds.set("content", real); else jobKinds.delete("content"); }
  });

  test("a content job about to refuse or keep a download it read while the folder was troubled throws 'remote' instead", async () => {
    const input = join(ROOT, `refuse-${++seq}`);
    mkdirSync(input, { recursive: true });
    const w = await watchPath(input);
    expect(w).not.toBeNull();
    watchJob(424_242, w);
    await expect(steadyOrThrow(424_242)).resolves.toBe("steady");            // steady: the refusal stands
    mount = { ...mount, dev: "fuse-5" };
    const e = await steadyOrThrow(424_242).catch(x => x);
    expect(e).toBeInstanceOf(EnvError); expect((e as EnvError).kind).toBe("remote");
    expect((e as EnvError).message).toMatch(/^the seedbox folder was remounted while it was being read — nothing is decided about this download/);
    watchJob(424_242, null);
  });
});
