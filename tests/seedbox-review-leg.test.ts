/**
 * The seedbox's trouble is never the copy's — the review's cases on the download leg (a tracker that does not answer the box,
 * a box whose client is slow, a download that never moves, a list without any of ludarr's downloads, a transfer judged while
 * the client answers slowly, a resumed transfer, a silent client with nothing in flight, a usenet folder moved away) and on
 * the ways' jobs (a make or a 7z listing that ran out of time reading the seedbox's folder, a make's walk that could not read
 * the marker). Stubbed: the folder's probe, the clients, the clock; no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, type FetchRow, type GameRow, type RequestRow } from "../src/db";
import { createRequest, rdeps, requestsTick, retryRequest } from "../src/requests";
import { runJob } from "../src/process/runner";
import { enqueueJob, jobKinds } from "../src/process/kinds";
import { probeRoot, remoteHealth, rmdeps, troubledBetween, watchJob, watchPath, type ClientView } from "../src/remote";
import { activePulls, deps as fdeps, forgetBestRates, forgetSnapshots, tick as fetchTick, troubleOf } from "../src/fetch";
import { waitForLocal, type PullHandle } from "../src/pull";
import { fromRtorrent } from "../src/seedbox-items";
import { EnvError, PlanFault } from "../src/ways/errors";
import { refuseDownload } from "../src/ways/find";
import { makeDry, mkdeps } from "../src/ways/make";
import type { DownloadClient } from "../src/plugins/types";
import type { RtItem } from "../src/rtorrent";
import { world, zeldaPlan, type World } from "./carry-world";
import { A, B, blocks, fetchRow, game, install, job, req, ROOT, rv, S, sec, tick } from "./seedbox-harness";

install();

/* ─────────── a client the test drives ─────────── */

const HASH = (c: string) => c.repeat(40).slice(0, 40);
let rtItems: RtItem[] = [];
let itemsFail: Error | null = null;
/** the client's answer takes this long (ms): the tick measures it with the real clock */
let rpcSkew = 0;
let pulls: { resolve: (ok: boolean, err?: string) => void; cancelled: boolean; done: boolean }[] = [];
let pullBytes = 0;
const realNow = Date.now;
function rtClient(): DownloadClient {
  return {
    test: async () => ({ ok: true, detail: "" }),
    add: async () => { throw new Error("not used"); },
    items: async () => {
      if (itemsFail) throw itemsFail;
      if (rpcSkew) { const off = rpcSkew; const was = Date.now; Date.now = () => was() + off; setTimeout(() => { Date.now = realNow; }, 0); }
      return { items: rtItems.map(fromRtorrent) };
    },
    remove: async () => {},
    pull: (_i, job) => {
      let resolve!: (ok: boolean, err?: string) => void;
      const p = { resolve: (ok: boolean, err?: string) => { p.done = true; resolve(ok, err); }, cancelled: false, done: false };
      const done = new Promise<{ ok: boolean; localPath: string; bytes: number; error?: string }>(r => { resolve = (ok, error) => r({ ok, localPath: join(ROOT, "..", "dl", job.remotePath.split("/").pop()!), bytes: 0, error }); });
      pulls.push(p);
      return { localPath: join(ROOT, "..", "dl", "x"), done, progress: () => 0.1, bytes: () => pullBytes, cancel: () => { p.cancelled = true; p.resolve(false, "cancelled"); } } as PullHandle;
    },
  };
}
const rtItem = (hash: string, over: Partial<RtItem> = {}): RtItem => ({
  hash, name: hash.slice(0, 6), complete: false, active: true, sizeBytes: 75e9, completedBytes: 0, downRate: 0, directory: "/home/user/downloads", multiFile: true,
  label: "ludarr", message: "", dataPath: `/home/user/downloads/${hash.slice(0, 6)}`, ...over,
});

let g: GameRow;
beforeEach(() => {
  rtItems = []; itemsFail = null; pulls = []; rpcSkew = 0; pullBytes = 0;
  forgetBestRates();
  fdeps.clients = () => [{ id: 7, name: "rTorrent (direct)", client: rtClient(), protocols: ["torrent"] }];
  fdeps.clientById = id => (id === 7 ? rtClient() : null);
  g = game("Leg Review");
  rdeps.grab = async (rel, gameId) => {
    S.grabs.push(rel.title);
    const c = rel.title === A ? "A" : "B";
    const row = stmts.insertFetch({ game_id: gameId, guid: rel.guid, indexer_id: 1, indexer: "GGn", title: rel.title, protocol: "torrent", size: 75e9, info_hash: HASH(c.toLowerCase()), client: "rtorrent", client_id: HASH(c), state: "submitted", release_json: JSON.stringify(rel), client_instance_id: 7 });
    db.query("UPDATE fetches SET created_at=? WHERE id=?").run(sec() - 3600, row.id);
    return { fetch: { id: row.id } as never, duplicate: false };
  };
  rdeps.search = async () => ({ query: {} as never, searched: [], raw: 2, ranked: [rv(A), rv(B, { score: 100 })], errors: [] });
});
afterEach(() => { Date.now = realNow; });

async function downloading() {
  const { request } = createRequest({ gameId: g.id });
  await requestsTick();
  return req(request.id);
}
/** `n` client polls `everyMin` apart, each followed by the searcher's look */
async function polls(n: number, everyMin: number) { for (let i = 0; i < n; i++) { S.now += everyMin * 60_000; await fetchTick(); await requestsTick(); } }

describe("the stall clock and its bounds", () => {
  test("a torrent with no peers because its tracker does not answer the box (an announce that timed out) is no dead post: an hour on, the same copy waits", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { peers: 0, seeders: 0, message: "Tracker: [Timeout was reached]" }), rtItem(HASH("C"), { downRate: 30e6, completedBytes: 1e9 })];
    await polls(13, 5);
    expect(fetchRow(r.fetch_id!).still_sec).toBe(0);
    expect(S.grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
    expect(req(r.id).stage).toMatch(/^downloading — its tracker does not answer the seedbox \(Tracker: \[Timeout was reached\]\): it waits, nothing is wrong with this copy$/);
    // an unregistered torrent is still a dead post at once
    rtItems = [rtItem(HASH("A"), { peers: 0, seeders: 0, message: "Tracker: [Failure reason \"Unregistered torrent\"]" })];
    await polls(1, 5);
    expect(S.grabs).toEqual([A, B]);
  });

  test("a dead torrent on a box whose client is always slow to answer still moves on — its clock runs at half the speed, never stands", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { peers: 0, seeders: 0 })];
    rpcSkew = 6000;
    await polls(18, 5);
    expect(S.grabs).toEqual([A]);
    expect(req(r.id).stage).toBe("downloading");
    expect(fetchRow(r.fetch_id!).still_sec).toBe(17 * 150);
    await polls(1, 5);
    expect(S.grabs).toEqual([A, B]);
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: "source" }]);
  });

  test("a download that never moves (paused in its client) is noted at 6 h, asked about at 24 h, and stopped at 72 h with the download kept; Retry waits on it again", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { active: false, completedBytes: 3e9 })];
    await polls(1, 1);
    expect(fetchRow(r.fetch_id!).moved_at).toBe(sec());
    await polls(6, 60);
    expect(remoteHealth(sec()).map(h => `${h.type}: ${h.message}`)).toEqual([expect.stringMatching(/^warning: 1 download has not moved in the download client since \d\d:\d\d/)]);
    await polls(18, 60);
    expect(req(r.id).stage).toMatch(/^downloading — it waits in the client \(stopped or paused\); it has not moved since \d\d:\d\d — ludarr keeps waiting and nothing was thrown away: Remove \(with blocklist\) gives this copy up$/);
    expect(remoteHealth(sec()).map(h => h.type)).toEqual(["error"]);
    await polls(48, 60);
    const q = req(r.id);
    expect(q).toMatchObject({ state: "failed", stage: "waited 3 days for the download to move" });
    expect(JSON.parse(q.remote_json!)).toMatchObject({ kind: "download", stopped: true });
    expect(fetchRow(r.fetch_id!).state).toBe("downloading");                 // kept in the client
    expect(S.grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
    retryRequest(r.id);
    await polls(1, 1);
    expect(req(r.id)).toMatchObject({ state: "fetching" });
    expect(req(r.id).stage).toMatch(/^downloading — it waits in the client/);
  });

  test("a restart does not make the first trickle the link's best: a neighbour at 2 MB/s after one at 50 MB/s is no full link, and a dead torrent moves on", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { peers: 3, seeders: 0 }), rtItem(HASH("C"), { downRate: 50e6, completedBytes: 1e9 })];
    await polls(1, 1);
    forgetSnapshots();                                                        // the process restarts: what was in memory is gone
    rtItems = [rtItem(HASH("A"), { peers: 3, seeders: 0 }), rtItem(HASH("C"), { downRate: 2e6, completedBytes: 2e9 })];
    await polls(10, 5);
    expect(S.grabs).toEqual([A, B]);
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: "source" }]);
    expect(req(r.id).state).toBe("fetching");
  });

  test("seeders that send nothing count a third: the stall is said in the time it really stood still", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { peers: 3, seeders: 3 })];
    await polls(1, 1);
    await polls(26, 5);
    expect(S.grabs).toEqual([A]);
    await polls(1, 5);
    expect(S.grabs).toEqual([A, B]);
    const reason = (db.query("SELECT reason FROM blocklist WHERE game_id=?").get(g.id) as { reason: string }).reason;
    expect(reason).toBe("stalled — no progress for 2 h 15 min (3 seeders connected, nothing sent yet)");
    expect(req(r.id).state).toBe("fetching");
  });
});

describe("what the client's list says", () => {
  test("a list without any of ludarr's downloads is not believed at first — but it is once it said so 3 times over 15 min: those downloads are gone, their posts blocked; the client is never called silent meanwhile", async () => {
    const r = await downloading();
    const other = stmts.insertFetch({ game_id: g.id, guid: "guid:other", indexer_id: 1, indexer: "GGn", title: "Other", protocol: "torrent", size: 1e9, info_hash: HASH("x"), client: "rtorrent", client_id: HASH("X"), state: "downloading", release_json: "{}", client_instance_id: 7 }) as FetchRow;
    db.query("UPDATE fetches SET created_at=? WHERE id=?").run(sec() - 3600, other.id);
    rtItems = [rtItem(HASH("A"), { downRate: 20e6, completedBytes: 1e9 }), rtItem(HASH("X")), rtItem(HASH("C"))];
    await polls(1, 1);
    rtItems = [rtItem(HASH("C"), { downRate: 9e6 })];                          // rTorrent lost its session: only others listed
    await polls(1, 5);
    expect(fetchRow(r.fetch_id!).state).toBe("downloading");
    expect(req(r.id).stage).not.toMatch(/has not answered/);
    await polls(3, 5);
    expect(fetchRow(r.fetch_id!).state).toBe("failed");
    expect(fetchRow(other.id).state).toBe("failed");
    expect(fetchRow(r.fetch_id!).message).toMatch(/^not found in the download client \(rtorrent [A]{40}\): missing from its list 4 times over 15 min$/);
    await requestsTick();
    expect(S.grabs).toEqual([A, B]);
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: "source" }]);
  });

  test("the downloading stage says what the client said: missing from its list (it answered), or silent — then with no rate (the last one seen is no rate)", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { downRate: 25e6, completedBytes: 1e9 }), rtItem(HASH("C"))];
    await polls(1, 1);
    expect(req(r.id).stage).toBe("downloading · 25 MB/s");
    rtItems = [rtItem(HASH("C"))];
    await polls(2, 5);
    expect(req(r.id).stage).toBe("downloading — rTorrent does not list it right now");
    rtItems = [rtItem(HASH("A"), { downRate: 25e6, completedBytes: 2e9 }), rtItem(HASH("C"))];
    await polls(1, 1);
    itemsFail = new DOMException("The operation timed out.", "TimeoutError") as unknown as Error;
    await polls(2, 5);
    expect(req(r.id).stage).toMatch(/^downloading — the download client has not answered since \d\d:\d\d \(nothing counts as a stall while it is silent\)$/);
  });

  test("a client silent once, whose download then left, is no silent client: nothing to wait on, no health error days later", async () => {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { downRate: 1e6, completedBytes: 1e9 })];
    await polls(1, 1);
    itemsFail = new DOMException("The operation timed out.", "TimeoutError") as unknown as Error;
    await polls(1, 5);
    db.query("UPDATE fetches SET state='failed' WHERE id=?").run(r.fetch_id);  // the admin removed the stuck download
    itemsFail = null;
    await polls(1, 5);
    S.now += 7 * 3600_000;
    expect(remoteHealth(sec()).filter(h => /has not answered/.test(h.message))).toEqual([]);
  });
});

describe("the transfer", () => {
  async function landed() {
    const r = await downloading();
    rtItems = [rtItem(HASH("A"), { complete: true, completedBytes: 75e9 })];
    await fetchTick();
    expect(pulls).toHaveLength(1);
    return r;
  }

  test("a transfer judged while the client answers slowly is held: the tick neither restarts nor doubles it, and one transfer runs at a time", async () => {
    const r = await landed();
    let answer!: (v: ClientView) => void;
    rmdeps.clientView = () => new Promise<ClientView>(res => { answer = res; });
    pulls[0].resolve(false, "HTTP 404 for /home/user/downloads/AAAAAA/x.rar");
    await tick();
    expect(fetchRow(r.fetch_id!).state).toBe("pulling");                     // judged: the client is asked
    S.now += 10_000; await fetchTick();
    expect(pulls).toHaveLength(1);                                            // not started again meanwhile
    answer({ answered: true, has: true, size: 75e9, name: "rTorrent" });
    await tick(); await tick();
    const row = fetchRow(r.fetch_id!);
    expect(row.state).toBe("seedbox_done");
    expect(activePulls()).toBe(0);
    S.now = ((row.retry_at ?? 0) + 1) * 1000; await fetchTick();
    expect(pulls).toHaveLength(2); expect(activePulls()).toBe(1);
    expect(pulls[0].cancelled || pulls[0].done).toBe(true);
  });

  test("a transfer that resumed after a break and moved on is no wait any more: no 'download has waited' in the health list, and its next break starts a new clock", async () => {
    const r = await landed();
    pulls[0].resolve(false, "connection ended early at byte 123 of /x.rar");
    await tick();
    expect(troubleOf(fetchRow(r.fetch_id!))).toMatchObject({ tries: 1 });
    S.now = (fetchRow(r.fetch_id!).retry_at! + 1) * 1000; await fetchTick();
    expect(pulls).toHaveLength(2);
    pullBytes = 500e6; S.now += 10_000; await fetchTick();
    expect(fetchRow(r.fetch_id!).state).toBe("pulling");
    expect(troubleOf(fetchRow(r.fetch_id!))).toBeNull();
    S.now += 7 * 3600_000; pullBytes = 70e9; await fetchTick();
    expect(remoteHealth(sec()).filter(h => /waited on the seedbox/.test(h.message))).toEqual([]);
  });

  test("a usenet download the hourly move took before its transfer: gone after the rule (NZBGet's history is only a record) — that post only, and never 'check the remote path mapping'", async () => {
    const gg = game("Moved Usenet");
    const f = stmts.insertFetch({ game_id: gg.id, guid: "guid:moved-usenet", indexer_id: 1, indexer: "NZBgeek", title: "MW4.Usenet", protocol: "usenet", size: 41e9, info_hash: null, client: "nzbget", client_id: "88", state: "submitted", release_json: JSON.stringify(rv("MW4.Usenet")), client_instance_id: 7 }) as FetchRow;
    stmts.setFetchSeedbox.run("/home/user/downloads/complete/ahoy/MW4.Usenet", 1, 41e9, f.id);
    stmts.setFetchState.run("seedbox_done", 1, null, f.id);
    const r = stmts.insertRequest.get(gg.id, "manual") as RequestRow;
    db.query("UPDATE requests SET state='fetching', fetch_id=?, release_json=?, candidates_json=?, attempt=0 WHERE id=?").run(f.id, JSON.stringify(rv("MW4.Usenet")), JSON.stringify([rv("MW4.Usenet"), rv(B, { score: 100 })]), r.id);
    rmdeps.clientView = async () => ({ answered: true, has: true, complete: true, size: 41e9, name: "NZBGet" });
    const messages: string[] = [];
    for (let i = 0; i < 6 && fetchRow(f.id).state !== "failed"; i++) {
      await fetchTick();
      pulls.at(-1)!.resolve(false, "/remote/downloads/complete/ahoy/MW4.Usenet never appeared under the mapped folder — is the mount up?");
      await tick(); await tick();
      messages.push(fetchRow(f.id).message ?? "");
      await requestsTick();
      if (fetchRow(f.id).retry_at) S.now = (fetchRow(f.id).retry_at! + 1) * 1000;
    }
    expect(fetchRow(f.id).state).toBe("failed");
    expect(fetchRow(f.id).message).toMatch(/^gone from the seedbox: MW4\.Usenet was not there \d times over 1\d min and NZBGet finished it, so it was moved away/);
    expect(messages.join(" ")).not.toMatch(/remote path mapping/);
    await requestsTick();
    expect(blocks(gg.id)).toEqual([{ guid: "guid:MW4.Usenet", title: "MW4.Usenet", class: "source" }]);
    expect(req(r.id).fetch_id).toBeNull();                                   // the search moved on past that post
  });

  test("a mapped folder that loses files while it is measured is going away — never settled on what is left (a torrent's still arrives)", async () => {
    const seq = [{ bytes: 4000, files: 4 }, { bytes: 3000, files: 3 }];
    let i = 0;
    const h = waitForLocal("/remote/downloads/X", { remotePath: "/x", isDir: true, expectedBytes: 0 }, { pollMs: 1, settleMs: 1, exists: async () => true, measure: async () => seq[Math.min(i++, seq.length - 1)] });
    const res = await h.done;
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/went away from the mapped folder while it was measured \(3 of 4 files left\)/) });
    const t = [{ bytes: 4000, files: 4 }, { bytes: 3000, files: 3 }, { bytes: 9000, files: 5 }, { bytes: 9000, files: 5 }];
    let j = 0;
    const tor = waitForLocal("/remote/downloads/Y", { remotePath: "/y", isDir: true, expectedBytes: 9000, exact: true }, { pollMs: 1, settleMs: 1, exists: async () => true, measure: async () => t[Math.min(j++, t.length - 1)] });
    expect(await tor.done).toMatchObject({ ok: true, bytes: 9000 });
  });
});

describe("the ways' jobs on the seedbox's folder", () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(() => { w.cleanup(); });

  /** a way's search whose download (A) landed on the seedbox's folder and is taken in by a content job; B is next */
  function wayRequest(name: string) {
    const p = w.plan(`Seedbox Review ${name}`, "recomp", zeldaPlan(true));
    const gg = w.game("The Legend of Zelda: Majora's Mask", ["N64"], { year: 2000 });
    const way = w.way(gg, p);
    S.made.push(gg.id);
    const input = join(ROOT, `${name}.rar`);
    writeFileSync(input, "rar");
    const f = stmts.insertFetch({ game_id: gg.id, guid: `guid:${A}`, indexer_id: 1, indexer: "GGn", title: A, protocol: "torrent", size: 58e9, info_hash: null, client: "rtorrent", client_id: `H-${name}`, state: "submitted", release_json: JSON.stringify(rv(A)), client_instance_id: 7 }) as FetchRow;
    stmts.setFetchDone.run(input, f.id);
    const r = stmts.insertWayRequest.get(gg.id, "find-files", way.id) as RequestRow;
    db.query("UPDATE requests SET state='processing', fetch_id=?, release_json=?, candidates_json=?, attempt=0 WHERE id=?").run(f.id, JSON.stringify(rv(A)), JSON.stringify([rv(A), rv(B, { score: 100 })]), r.id);
    const j = enqueueJob({ kind: "content", gameId: gg.id, wayId: way.id, requestId: r.id, fetchId: f.id, path: input }, { gameId: gg.id, requestId: r.id, fetchId: f.id });
    db.query("UPDATE requests SET job_id=? WHERE id=?").run(j.id, r.id);
    return { gg, way, r, f, input, j };
  }
  const contentJobs = (requestId: number) => (db.query("SELECT COUNT(*) AS n FROM jobs WHERE request_id=? AND kind='content'").get(requestId) as { n: number }).n;
  async function withContent(run: (ctx: { job: { id: number } }) => Promise<never>, body: () => Promise<void>) {
    const real = jobKinds.get("content");
    jobKinds.set("content", { run: run as never, scratch: () => 0 });
    try { await body(); } finally { if (real) jobKinds.set("content", real); else jobKinds.delete("content"); }
  }

  test("a make's unpack that ran out of time reading the seedbox's folder is run once more before it counts against the recipe", async () => {
    const { r, j } = wayRequest("Unpack");
    await withContent(async () => { throw new PlanFault("unpack", "make step 1 (unpacking Unpack.rar) ran out of time (14400 s): Extracting  Zelda/rom.z64  41%"); }, async () => {
      await runJob(j.id);
      expect(JSON.parse(job(j.id).fail_json!)).toMatchObject({ class: "plan", remote: { io: true, troubled: false } });
      await requestsTick();
      expect(req(r.id).state).toBe("processing");
      expect(req(r.id).stage).toMatch(/running it once more to tell the seedbox from the copy/);
      S.now = (req(r.id).next_try_at! + 1) * 1000; await probeRoot(ROOT); S.now += 40_000; await probeRoot(ROOT);
      await requestsTick();
      expect(contentJobs(r.id)).toBe(2);
      await runJob(req(r.id).job_id!);
      expect(JSON.parse(job(req(r.id).job_id!).fail_json!)).toMatchObject({ class: "plan", remote: { io: true, confirmed: true } });
      await requestsTick();
      expect(req(r.id)).toMatchObject({ state: "failed", stage: "the game file could not be made from the download" });
      expect(S.grabs).toEqual([]);
    });
  });

  test("a refusal made from a 7z listing that ran out of time on the seedbox's folder keeps the download and is looked at once more — refused (and let go of) only when the confirming run says the same", async () => {
    const { gg, way, r, j } = wayRequest("Listing");
    let letGo = 0;
    await withContent(async ctx => refuseDownload(ctx.job.id, "Listing.rar could be listed only in part (7z ran out of time: Listing.part07.rar): a volume may be missing or the archive is damaged", "form", async () => { letGo++; }, () => {}), async () => {
      await runJob(j.id);
      expect(letGo).toBe(0);
      expect(JSON.parse(job(j.id).fail_json!)).toMatchObject({ class: "file", kind: "form", remote: { io: true } });
      await requestsTick();
      expect(req(r.id).state).toBe("processing"); expect(S.grabs).toEqual([]);
      expect(db.query("SELECT COUNT(*) AS n FROM blocklist WHERE game_id=?").get(gg.id)).toEqual({ n: 0 });
      S.now = (req(r.id).next_try_at! + 1) * 1000; await probeRoot(ROOT); S.now += 40_000; await probeRoot(ROOT);
      await requestsTick();
      await runJob(req(r.id).job_id!);
      expect(letGo).toBe(1);
      await requestsTick();
      expect(S.grabs).toEqual([B]);
      expect((db.query("SELECT way_id, reason FROM blocklist WHERE game_id=?").get(gg.id) as { way_id: number; reason: string })).toMatchObject({ way_id: way.id, reason: expect.stringMatching(/ran out of time/) });
    });
  });

  test("a make's walk that could not read the marker (EIO) reports it: the refusal it would make is no refusal — the seedbox's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "make-walk-"));
    const root = join(dir, "remote", "downloads");
    const input = join(root, "Demons.Souls.PS5-GRP");
    mkdirSync(join(input, "PPSA01341-app0", "sce_sys"), { recursive: true });
    writeFileSync(join(input, "PPSA01341-app0", "sce_sys", "param.json"), JSON.stringify({ titleId: "PPSA01341" }));
    writeFileSync(join(input, "PPSA01341-app0", "eboot.bin"), "x");
    rmdeps.roots = () => [{ from: "/home/user/downloads", to: root, client: "rTorrent (direct)", instanceId: 7 }];
    const realLstat = mkdeps.lstat;
    mkdeps.lstat = async (p: string) => { if (/param\.json$/.test(p)) throw Object.assign(new Error(`EIO: i/o error, lstat '${p}'`), { code: "EIO" }); return realLstat(p); };
    try {
      const watched = await watchPath(input);
      watchJob(515_151, watched);
      const content = {
        kind: "disc", platform: "ps5", what: "Demon's Souls", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"] }, place: "game/{name}",
        make: { from: ["indexer"], input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", also: ["eboot.bin"] }, steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }], output: { shape: "file", name: "game.zar" } },
      };
      const rep = await makeDry({ work: join(dir, "work"), content: content as never, input: { from: "indexer", path: input, fetchId: null } as never, mode: "plan", signal: new AbortController().signal, log: () => {}, budget: { bytes: 1e12, minutes: 999 } } as never);
      expect(rep.problems.join(" ")).toMatch(/it is not the game's folder/);
      expect(troubledBetween(root, S.now - 1000, S.now + 1000)).toMatch(/an input\/output error \(EIO\) reading param\.json/);
      const e = await refuseDownload(515_151, rep.problems[0], "form", async () => { throw new Error("never let go"); }, () => {}).catch(x => x);
      expect(e).toBeInstanceOf(EnvError); expect((e as EnvError).kind).toBe("remote");
    } finally { mkdeps.lstat = realLstat; watchJob(515_151, null); rmSync(dir, { recursive: true, force: true }); }
  });
});
