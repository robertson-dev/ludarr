/**
 * The seedbox's trouble is never the copy's — the review's cases (2026-11-09): what a failed import says of the mapped
 * folder (a file that is there again, Bun's own errno words, a start that could not look, a download the hourly move took
 * half of, a read error before the AI importer, a slow folder beside a CRC error), the bounds of a wait and what the admin
 * and players see of it, and the monitor's own looks. Stubbed: the folder's probe, the clients, the clock; no network.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { db, stmts, type FetchRow, type JobRow } from "../src/db";
import { createRequest, rdeps, requestsTick, retryRequest, cancelRequest } from "../src/requests";
import { rdeps as runner, runJob, processTick } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { PROBE_SH, probeRoot, remoteHealth, rmdeps, rootDown, rootState, waitingCount } from "../src/remote";
import { copyWords, errnoWords, wordsTrouble } from "../src/transport";
import { deps as fdeps, grab, troubleOf } from "../src/fetch";
import { activityApi } from "../src/api/activity";
import { healthChecks, hdeps } from "../src/health";
import { recipes } from "../src/plugins/builtin/importers";
import type { DownloadClient, Importer } from "../src/plugins/types";
import { A, B, blocks, eio, enoent, fetchRow, game, importer, imported, importsOf, install, job, landedImport, req, ROOT, rv, S, sec, steady, turn } from "./seedbox-harness";

install();

const failOf = (id: number) => JSON.parse(job(id).fail_json!);

describe("what a failed import says of the seedbox", () => {
  test("the incident's own end: an ENOENT on a file that is there again, the remount unseen (the same device back, no probe in the gap) — the seedbox's, waited out; nothing blocklisted, no second grab", async () => {
    const { g, r, firstJob } = await landedImport();
    let runs = 0;
    importer(async ctx => { if (++runs === 1) throw enoent(join(ctx.input, "Seedbox Quest (USA).z64")); return imported(ctx); });
    await runJob(firstJob);
    expect(failOf(firstJob)).toMatchObject({ class: "env", kind: "remote", remote: { troubled: true, trouble: "flicker" } });
    expect(job(firstJob).message).toMatch(/^the seedbox folder did not show Seedbox Quest \(USA\)\.z64 for a moment while it was being read \(it is there\) \(it ended: ENOENT/);
    await requestsTick();
    expect(req(r.id).state).toBe("processing"); expect(blocks(g.id)).toEqual([]); expect(S.grabs).toEqual([A]);
    await turn(r.id);
    await runJob(req(r.id).job_id!); await requestsTick();
    expect(req(r.id).state).toBe("ready"); expect(blocks(g.id)).toEqual([]); expect(S.grabs).toEqual([A]);
  });

  test("an ENOENT on a file under the input that is not there now either: looked at once more (it may have been the remount's gap) — the same end again is the copy's", async () => {
    const { g, r, firstJob } = await landedImport();
    importer(async ctx => { throw enoent(join(ctx.input, "Missing.part03.rar")); });
    await runJob(firstJob);
    expect(failOf(firstJob)).toMatchObject({ class: "other", remote: { troubled: false, absent: false, io: true } });
    await requestsTick();
    expect(S.grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
    await turn(r.id);
    await runJob(req(r.id).job_id!); await requestsTick();
    expect(S.grabs).toEqual([A, B]); expect(blocks(g.id).map(b => b.title)).toEqual([A]);
    expect(req(r.id).state).toBe("fetching");
  });

  test("Bun's own errno words passed on as text (libuv's 'EIO: i/o error', 'ENOTCONN: socket is not connected') are the read path's every time — never one re-run and a blocklist", async () => {
    expect(errnoWords("EIO: i/o error, copyfile 'C:/remote/x.rar'")).toBe("EIO");
    expect(errnoWords("cp failed: ENOTCONN: socket is not connected, scandir '/remote/downloads/x'")).toBeTruthy();
    expect(errnoWords("unrar: Read error in the file x.rar")).toBeNull();
    expect(copyWords("CRC failed in the encrypted file x.bin. Corrupt file or wrong password.")).toBeTruthy();
    expect(wordsTrouble("make step 1 (unpacking X) ran out of time (14400 s)")).toBe("ran out of time");
    const { g, r, input, firstJob } = await landedImport();
    importer(async () => ({ ok: false, shape: "folder", reason: `EIO: i/o error, copyfile '${join(input, "Seedbox Quest (USA).z64")}'` }));
    await runJob(firstJob);
    expect(failOf(firstJob)).toMatchObject({ class: "env", kind: "remote", remote: { trouble: "io" } });
    await requestsTick();
    for (let i = 0; i < 3; i++) {
      expect(req(r.id).stage).toMatch(/^reading the seedbox folder failed: "EIO" — trying again in /);
      await turn(r.id);
      await runJob(req(r.id).job_id!); await requestsTick();
    }
    expect(req(r.id).state).toBe("processing"); expect(S.grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
  });

  test("the real recipes importer: an EIO from its own copy or archiver call keeps its code (thrown, never turned into a recipe that gave up) — the read path's", async () => {
    const { g, r, input, firstJob } = await landedImport({ files: { "Game.rar": 2048 } });
    pdeps.tools = () => ({ unrar: "unrar", sevenZip: null, unar: null, innoextract: null, wine: null } as never);
    pdeps.exec = (async () => { throw eio(join(input, "Game.rar")); }) as never;
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: recipes.create({} as never, {} as never) as Importer }];
    await runJob(firstJob);
    expect(failOf(firstJob)).toMatchObject({ class: "env", kind: "remote", remote: { troubled: true, trouble: "io" } });
    expect(job(firstJob).message).toMatch(/^reading the seedbox folder failed: an input\/output error \(EIO\)/);
    await requestsTick();
    expect(req(r.id).state).toBe("processing"); expect(S.grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
  });

  test("the import's first look at its input failing with EIO is no 'input is gone': judged against the folder with its code, nothing blocklisted", async () => {
    const { g, r, firstJob } = await landedImport();
    const real = runner.statInput;
    let failed = 0;
    runner.statInput = async p => { if (failed++ === 0) throw eio(p); return real(p); };
    importer(imported);
    await runJob(firstJob);
    expect(job(firstJob).message).not.toMatch(/input is gone/);
    expect(failOf(firstJob)).toMatchObject({ class: "env", kind: "remote", remote: { trouble: "io" } });
    await requestsTick();
    expect(S.grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
    await turn(r.id);
    await runJob(req(r.id).job_id!); await requestsTick();
    expect(req(r.id).state).toBe("ready");
  });

  test("the hourly move takes a usenet download's volumes while it is imported: the download changed under the job — the seedbox's, never the copy's; it is never re-run on what is left, and once it is gone for good only that post is blocked", async () => {
    S.protocol = "usenet";
    S.view = { answered: true, has: true, complete: true, size: 41e9, name: "NZBGet" };
    const { g, r, input, firstJob } = await landedImport({ files: { "X.part01.rar": 4000, "X.part02.rar": 4000, "X.part03.rar": 4000, "X.part04.rar": 1000 } });
    importer(async ctx => {
      // rclone move copied part03 and part04 to the finished folder and deleted them while unrar read part02
      unlinkSync(join(ctx.input, "X.part03.rar")); unlinkSync(join(ctx.input, "X.part04.rar"));
      return { ok: false, shape: "archive", reason: "unrar failed on X.part01.rar (exit 10): Cannot find volume X.part03.rar" };
    });
    await runJob(firstJob);
    expect(failOf(firstJob)).toMatchObject({ class: "env", kind: "remote", remote: { troubled: true, trouble: "changed", start: { files: 4, bytes: 13_000 }, left: { files: 2, bytes: 8000 } } });
    await requestsTick();
    expect(req(r.id).state).toBe("processing"); expect(blocks(g.id)).toEqual([]); expect(S.grabs).toEqual([A]);
    // the next turn: the folder answers, but what is left of the download is not all of it — looked at as one going away
    await turn(r.id);
    expect(importsOf(r.id)).toBe(1);
    expect(req(r.id).stage).toMatch(/is only partly in the seedbox folder: NZBGet finished it, so it was moved away \(the hourly move out of complete\/\?\); another copy is tried once it stays away for 15 min — looking again in a minute$/);
    // the move finishes: the folder is gone; looked for over 15 minutes, then that post only is blocked and the next copy tried
    rmSync(input, { recursive: true, force: true });
    for (const wait of [2, 4, 8, 8]) { expect(S.grabs).toEqual([A]); S.now += wait * 60_000 + 1000; await probeRoot(ROOT); await requestsTick(); }
    expect(S.grabs).toEqual([A, B]);
    expect(blocks(g.id)).toEqual([{ guid: `guid:${A}`, title: A, class: "source" }]);
    expect(importsOf(r.id)).toBe(1);
  });

  test("a read error from the recipes ends the import there the first time — the AI importer is not spent on a suspect read; the confirming run goes on to it", async () => {
    const { g, r, firstJob } = await landedImport();
    let ai = 0;
    runner.importers = () => [
      { impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "archive", reason: "unrar failed on X.rar (exit 3): Read error in the file X.rar" })) as never } },
      { impl: "agent", name: "AI importer", importer: { probe: async () => true, run: (async (ctx: { input: string; staging: string }) => { ai++; return imported(ctx); }) as never } },
    ];
    await runJob(firstJob);
    expect(ai).toBe(0);
    expect(failOf(firstJob)).toMatchObject({ class: "other", remote: { troubled: false, io: true } });
    await requestsTick();
    expect(req(r.id).stage).toMatch(/running it once more to tell the seedbox from the copy/);
    await turn(r.id);
    await runJob(req(r.id).job_id!);
    expect(ai).toBe(1);
    await requestsTick();
    expect(req(r.id).state).toBe("ready"); expect(blocks(g.id)).toEqual([]); expect(S.grabs).toEqual([A]);
  });

  test("a read error with no AI key: one confirming run, then the hold for the key — and the wait is over then (no false health error, no 30 s probing); a new hiccup days later starts a wait of its own", async () => {
    const { g, r, firstJob } = await landedImport();
    runner.importers = () => [
      { impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "archive", reason: "unrar failed on X.rar (exit 3): Read error in the file X.rar" })) as never } },
      { impl: "agent", name: "AI importer", importer: { probe: async () => false, run: (async () => { throw new Error("never"); }) as never } },
    ];
    await runJob(firstJob);
    await requestsTick();
    await turn(r.id);
    const second = req(r.id).job_id!;
    await runJob(second);
    expect(job(second).message).toMatch(/the AI importer could take over once it has an API key$/);
    await requestsTick();
    let q = req(r.id);
    expect(q.stage).toBe("downloaded, but it needs the AI importer — add an API key under Settings → Importers");
    expect(q.remote_json).toBeNull(); expect(waitingCount()).toBe(0);
    S.now += 7 * 3600_000; await requestsTick();
    expect(remoteHealth(sec()).filter(h => /waited on the seedbox/.test(h.message))).toEqual([]);
    // days later a key is saved, and the AI's import meets one EIO: a wait of its own, from now — not "waited 3 days" at once
    S.now += 4 * 86_400_000;
    rdeps.agentReady = () => true;
    await requestsTick();
    const third = req(r.id).job_id!;
    expect(third).not.toBe(second);
    runner.importers = () => [{ impl: "agent", name: "AI importer", importer: { probe: async () => true, run: (async (ctx: { input: string }) => { throw eio(ctx.input); }) as never } }];
    await runJob(third); await requestsTick();
    q = req(r.id);
    expect(q.state).toBe("processing");
    expect(JSON.parse(q.remote_json!)).toMatchObject({ since: sec(), kind: "import" });
    expect(blocks(g.id)).toEqual([]); expect(S.grabs).toEqual([A]);
  });

  test("a folder that only answered slowly while a corrupt archive was read: the CRC error is the copy's at once — slowness is said, never a wait of its own", async () => {
    const { g, r, firstJob } = await landedImport();
    importer(async () => {
      S.mount = { ...S.mount, ms: 6000 }; await probeRoot(ROOT); S.mount = { ...S.mount, ms: 4 };   // the import's own reads fill the link
      return { ok: false, shape: "archive", reason: "unrar failed on X.rar (exit 3): CRC failed in X.rar. Corrupt file or wrong password." };
    });
    await runJob(firstJob);
    expect(failOf(firstJob)).toMatchObject({ class: "other", remote: { troubled: false, copy: true, slow: true } });
    await requestsTick();
    expect(S.grabs).toEqual([A, B]); expect(blocks(g.id).map(b => b.title)).toEqual([A]);
    expect(req(r.id).state).toBe("fetching");
  });

  test("a CRC error each time the folder was also remounted: run once more, then the copy's — never 72 h of re-reading a corrupt archive", async () => {
    const { g, r, firstJob } = await landedImport();
    let runs = 0;
    importer(async () => { S.mount = { ...S.mount, dev: `fuse-${10 + ++runs}` }; return { ok: false, shape: "archive", reason: "unrar failed on X.rar (exit 3): CRC failed in X.rar. Corrupt file or wrong password." }; });
    await runJob(firstJob);
    expect(failOf(firstJob)).toMatchObject({ class: "env", kind: "remote", remote: { trouble: "remounted", copy: true } });
    await requestsTick();
    expect(S.grabs).toEqual([A]);
    await turn(r.id);
    await runJob(req(r.id).job_id!); await requestsTick();
    expect(runs).toBe(2);
    expect(S.grabs).toEqual([A, B]); expect(blocks(g.id).map(b => b.title)).toEqual([A]);
    // refused in its own words, never the folder's
    expect((db.query("SELECT reason FROM blocklist WHERE game_id=?").get(g.id) as { reason: string }).reason).toMatch(/^import failed: unrar failed on X\.rar \(exit 3\): CRC failed/);
  });
});

describe("the bounds of a wait, and what the admin sees of it", () => {
  /** a search whose import stopped waiting after 72 h of a folder that did not answer: the download kept */
  async function stoppedImport() {
    const l = await landedImport();
    importer(async ctx => { if (!S.mount.ok) throw Object.assign(new Error(`ENOTCONN: socket is not connected, scandir '${ctx.input}'`), { code: "ENOTCONN" }); return imported(ctx); });
    S.mount = { ok: false, ms: 10_000, entries: null, dev: null, mounted: false, why: "Transport endpoint is not connected" };
    await runJob(l.firstJob);
    await requestsTick();
    for (let h = 0; h < 13; h++) { S.now += 6 * 3600_000; await requestsTick(); }
    expect(req(l.r.id)).toMatchObject({ state: "failed", stage: "waited 3 days for the seedbox" });
    S.mount = { ok: true, ms: 4, entries: 40, dev: "fuse-3", mounted: true, why: null };
    return l;
  }

  test("a re-run held in the queue by a folder that does not answer is bounded too: 72 h on, the job leaves the queue and the request stops, the download kept", async () => {
    const { g, r, firstJob } = await landedImport();
    let runs = 0;
    importer(async ctx => { if (++runs === 1) { S.mount = { ...S.mount, dev: "fuse-2" }; throw enoent(join(ctx.input, "x.rar")); } return imported(ctx); });
    await runJob(firstJob);
    await requestsTick();
    await turn(r.id);
    const rerun = req(r.id).job_id!;
    expect(rerun).not.toBe(firstJob);
    S.mount = { ok: false, ms: 10_000, entries: null, dev: null, mounted: false, why: "Transport endpoint is not connected" };
    await probeRoot(ROOT);
    await processTick();
    expect(job(rerun)).toMatchObject({ state: "queued", message: "waiting for the seedbox folder, which does not answer (Transport endpoint is not connected)" });
    for (let h = 0; h < 13; h++) { S.now += 6 * 3600_000; await requestsTick(); }
    expect(req(r.id)).toMatchObject({ state: "failed", stage: "waited 3 days for the seedbox" });
    expect(job(rerun).state).toBe("cancelled");
    expect(JSON.parse(req(r.id).remote_json!)).toMatchObject({ stopped: true });
    expect(blocks(g.id)).toEqual([]); expect(S.grabs).toEqual([A]);
    // the seedbox answers again: Retry runs the import anew (the job the bound took out of the queue is no cancel of the search)
    S.mount = { ok: true, ms: 4, entries: 40, dev: "fuse-4", mounted: true, why: null };
    retryRequest(r.id);
    await requestsTick();
    const again = req(r.id).job_id!;
    expect(again).not.toBe(rerun); expect(req(r.id).state).toBe("processing");
    await runJob(again); await requestsTick();
    expect(req(r.id).state).toBe("ready"); expect(S.grabs).toEqual([A]);
  });

  test("the admin cancels the search while its wait looks at the seedbox: nothing is done from what was read before — the search stays cancelled, no import queued", async () => {
    S.view = { answered: true, has: false, name: "rTorrent" };
    const { r } = await landedImport({ present: false });
    importer(imported);
    await runJob(r.job_id!);
    await requestsTick();
    expect(JSON.parse(req(r.id).remote_json!)).toMatchObject({ mode: "look" });
    rmdeps.stat = async () => { await cancelRequest(r.id, false); return "present"; };
    S.now = (req(r.id).next_try_at! + 1) * 1000; await probeRoot(ROOT);
    await requestsTick();
    expect(req(r.id).state).toBe("cancelled");
    expect(importsOf(r.id)).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM jobs WHERE request_id=? AND state='queued'").get(r.id)).toEqual({ n: 0 });
  });

  test("after the 72 h stop: the automatic searches leave the game to the admin, a search by hand (the Search button, a player's Try again) picks the kept download up again — never another copy", async () => {
    const { g, r } = await stoppedImport();
    S.now += 25 * 3600_000;
    for (const by of ["auto", "rss", "tracker", "upgrade"]) {
      const again = createRequest({ gameId: g.id, by });
      expect(again).toMatchObject({ duplicate: true, request: { id: r.id, state: "failed" } });
    }
    const asked = createRequest({ gameId: g.id, by: "manual" });
    expect(asked).toMatchObject({ duplicate: true, request: { id: r.id, state: "processing" } });
    const w = JSON.parse(req(r.id).remote_json!);
    expect(w).toMatchObject({ stopped: false, now: true, since: sec() });
    await requestsTick();
    await runJob(req(r.id).job_id!); await requestsTick();
    expect(req(r.id).state).toBe("ready"); expect(S.grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
  });

  test("the same usenet post is never added twice: a grab finds its download still in flight, or landed and never imported", async () => {
    const g = game("Dupe");
    const adds: string[] = [];
    const client = { test: async () => ({ ok: true, detail: "" }), add: async () => { adds.push("add"); return { client: "nzbget" as const, clientId: "999" }; }, items: async () => ({ items: [] }), remove: async () => {}, pull: () => ({ local: "/x" }) } as unknown as DownloadClient;
    fdeps.clients = () => [{ id: 9, name: "NZBGet (direct)", client, protocols: ["usenet"] }];
    fdeps.indexerById = () => ({ download: async () => ({ kind: "nzb", bytes: new Uint8Array([1]), filename: "MW4.nzb" }) }) as never;
    const kept = stmts.insertFetch({ game_id: g.id, guid: "guid:usenet-post", indexer_id: 1, indexer: "NZBgeek", title: "MW4", protocol: "usenet", size: 41e9, info_hash: null, client: "nzbget", client_id: "88", state: "submitted", release_json: "{}", client_instance_id: 9 }) as FetchRow;
    stmts.setFetchDone.run(join(ROOT, "complete", "MW4"), kept.id);
    const rel = { ...rv("MW4", { guid: "guid:usenet-post", protocol: "usenet" }), indexerId: 1, instanceId: 1 };
    const got = await grab(rel as never, g.id);
    expect(got.duplicate).toBe(true); expect(got.fetch.id).toBe(kept.id); expect(adds).toEqual([]);
    // once it was imported it is no longer kept: a new grab adds it
    stmts.setFetchImported.run(kept.id);
    expect((await grab(rel as never, g.id)).duplicate).toBe(false); expect(adds).toEqual(["add"]);
  });

  test("the Queue's 'Search again' on a stopped wait picks the wait up (fresh would fetch another copy): it stays listed with its wait until resolved, and Remove lets its download go", async () => {
    const { g, r } = await stoppedImport();
    S.now += 3 * 3600_000;
    let items = (await (await activityApi.request("/api/v1/queue")).json() as { items: { id: number; waiting: { stopped: boolean; kind: string } | null }[] }).items;
    expect(items.find(i => i.id === r.id)?.waiting).toMatchObject({ stopped: true, kind: "import" });
    retryRequest(r.id, { fresh: true });
    expect(req(r.id)).toMatchObject({ state: "processing" });
    expect(req(r.id).candidates_json).not.toBeNull();                         // not a fresh search
    items = (await (await activityApi.request("/api/v1/queue")).json() as { items: { id: number; waiting: { stopped: boolean; kind: string } | null }[] }).items;
    expect(items.find(i => i.id === r.id)?.waiting).toMatchObject({ stopped: false, kind: "import" });
    await requestsTick();
    await runJob(req(r.id).job_id!); await requestsTick();
    expect(req(r.id).state).toBe("ready"); expect(S.grabs).toEqual([A]); expect(blocks(g.id)).toEqual([]);
  });

  test("a stopped transfer wait: a grab of the same post tries it again rather than failing on it at once; the health list and the monitor count no stopped wait; removing its search lets the download go", async () => {
    const g = game("Stopped Transfer");
    const f = stmts.insertFetch({ game_id: g.id, guid: "guid:stopped-pull", indexer_id: 1, indexer: "GGn", title: "MW4", protocol: "torrent", size: 75e9, info_hash: null, client: "rtorrent", client_id: "HSTOP", state: "submitted", release_json: "{}", client_instance_id: 7 }) as FetchRow;
    stmts.setFetchSeedbox.run("/home/user/downloads/MW4", 1, 75e9, f.id);
    stmts.setFetchRetry.run("seedbox_done", 1, "waited 72 h", null, JSON.stringify({ since: sec() - 80 * 3600, tries: 40, words: "the transfer broke off", stopped: true }), f.id);
    expect(waitingCount()).toBe(0);
    expect(remoteHealth(sec()).filter(h => /waited on the seedbox/.test(h.message))).toEqual([]);
    // a request whose wait stopped on it, removed by the admin: the download goes with it (nothing would ever try it again)
    const r = stmts.insertRequest.get(g.id, "manual") as { id: number };
    db.query("UPDATE requests SET state='failed', fetch_id=?, remote_json=? WHERE id=?").run(f.id, JSON.stringify({ since: sec() - 80 * 3600, tries: 40, mode: "retry", kind: "pull", trouble: "transfer", words: "the transfer broke off", jobId: null, input: null, absent: [], reruns: 0, stopped: true }), r.id);
    await cancelRequest(r.id, true);
    expect(fetchRow(f.id)).toBeNull();
    // and a grab that finds one stopped: its wait begins again (tried now)
    const h = stmts.insertFetch({ game_id: g.id, guid: "guid:stopped-pull-2", indexer_id: 1, indexer: "GGn", title: "MW4", protocol: "torrent", size: 75e9, info_hash: null, client: "rtorrent", client_id: "HSTOP2", state: "submitted", release_json: "{}", client_instance_id: 7 }) as FetchRow;
    stmts.setFetchSeedbox.run("/home/user/downloads/MW4", 1, 75e9, h.id);
    stmts.setFetchRetry.run("seedbox_done", 1, "waited 72 h", null, JSON.stringify({ since: sec() - 80 * 3600, tries: 40, words: "the transfer broke off", stopped: true }), h.id);
    fdeps.clients = () => [{ id: 7, name: "rTorrent (direct)", client: {} as DownloadClient, protocols: ["torrent"] }];
    const got = await grab({ ...rv("MW4", { guid: "guid:stopped-pull-2" }), indexerId: 1 } as never, g.id);
    expect(got.duplicate).toBe(true);
    expect(troubleOf(fetchRow(h.id))).toBeNull(); expect(fetchRow(h.id).state).toBe("seedbox_done");
  });

  test("a wait under way offers 'Retry now' (no new search): tried at once, without waiting for the folder's steady answers", async () => {
    const { r, firstJob } = await landedImport();
    importer(async ctx => { S.mount = { ...S.mount, dev: "fuse-7" }; throw enoent(join(ctx.input, "y.rar")); });
    await runJob(firstJob);
    await requestsTick();
    const items = (await (await activityApi.request("/api/v1/queue")).json() as { items: { id: number; waiting: { stopped: boolean; kind: string; nextTryAt: number } | null }[] }).items;
    expect(items.find(i => i.id === r.id)?.waiting).toMatchObject({ stopped: false, kind: "import", nextTryAt: req(r.id).next_try_at });
    retryRequest(r.id);
    importer(imported);
    await requestsTick();                                                     // no steady answers yet: the admin asked
    expect(req(r.id).job_id).not.toBe(firstJob);
  });

  test("the seedbox's health: one line per folder whichever clients map it, and a notification when it turns into an error at 6 h (the same words)", async () => {
    rmdeps.roots = () => [{ ...{ from: "/home/user/downloads", to: ROOT, client: "rTorrent (direct)", instanceId: 7 } }, { from: "/home/user/downloads", to: ROOT, client: "NZBGet (direct)", instanceId: 8 }];
    const sent: string[] = [];
    hdeps.notify = async (_e, n) => { sent.push(`${n.title}: ${n.message}`); };
    S.mount = { ok: false, ms: 10_000, entries: null, dev: null, mounted: false, why: "Transport endpoint is not connected" };
    await probeRoot(ROOT);
    S.now += 2 * 3600_000 + 1000; await probeRoot(ROOT);
    const two = remoteHealth(sec()).filter(h => /has not answered since/.test(h.message));
    expect(two.map(h => h.message)).toEqual([expect.stringContaining(`the seedbox folder ${ROOT} (rTorrent (direct), NZBGet (direct)) has not answered since`)]);
    await healthChecks(true);
    expect(sent.filter(s => /^Health warning: Seedbox: the seedbox folder/.test(s))).toHaveLength(1);
    S.now += 4 * 3600_000; await probeRoot(ROOT);
    await healthChecks(true);
    expect(sent.filter(s => /^Health error: Seedbox: the seedbox folder/.test(s))).toHaveLength(1);
    await healthChecks(true);
    expect(sent.filter(s => /^Health error: Seedbox: the seedbox folder/.test(s))).toHaveLength(1);   // said once
  });
});

describe("the monitor's looks", () => {
  test("a folder that reads empty with nothing mounted there (the mount not up after a restart) is down from the first look — never 'healthy, and empty'", async () => {
    S.mount = { ok: true, ms: 3, entries: 0, dev: "2049", mounted: false, why: null };
    await probeRoot(ROOT);
    expect(rootDown(ROOT)).toBe(true);
    expect(rootState(ROOT)?.why).toMatch(/reads empty with nothing mounted there/);
    S.mount = { ok: true, ms: 3, entries: 12, dev: "fuse-1", mounted: true, why: null };
    await probeRoot(ROOT);
    expect(rootDown(ROOT)).toBe(false);
  });

  test("a mounted folder that was emptied (its downloads moved away) is down only while that could be a remount: empty on the same mount 3 looks over 5 min is its normal", async () => {
    await probeRoot(ROOT);
    S.mount = { ...S.mount, entries: 0 };
    await probeRoot(ROOT);
    expect(rootDown(ROOT)).toBe(true);
    S.now += 3 * 60_000; await probeRoot(ROOT);
    expect(rootDown(ROOT)).toBe(true);
    S.now += 3 * 60_000; await probeRoot(ROOT);
    expect(rootDown(ROOT)).toBe(false);
    for (let i = 0; i < 6; i++) { S.now += 3600_000; await probeRoot(ROOT); }
    expect(rootDown(ROOT)).toBe(false);
    expect(remoteHealth(sec()).filter(h => /has not answered/.test(h.message))).toEqual([]);
  });

  const sh = Bun.which("sh");
  test.skipIf(!sh)("the probe's shell: an ls that fails is no answer (its own status counts), never '0 entries'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-sh-"));
    try {
      mkdirSync(join(dir, "full", "a"), { recursive: true }); mkdirSync(join(dir, "full", "b")); mkdirSync(join(dir, "empty"));
      const run = async (path: string, env?: Record<string, string>) => {
        const p = Bun.spawn([sh!, "-c", PROBE_SH, "probe", path], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
        const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        return { lines: out.trim().split(/\s+/), code };
      };
      expect(await run(join(dir, "full"))).toMatchObject({ code: 0, lines: [expect.any(String), "2"] });
      expect(await run(join(dir, "empty"))).toMatchObject({ code: 0, lines: [expect.any(String), "0"] });
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "ls"), "#!/bin/sh\necho \"ls: reading directory: Input/output error\" >&2\nexit 2\n");
      chmodSync(join(bin, "ls"), 0o755);
      const failed = await run(join(dir, "full"), { PATH: `${bin}${delimiter}${process.env.PATH}` });
      expect(failed.code).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
