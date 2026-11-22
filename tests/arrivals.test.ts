/**
 * Downloads that reach the server through the admin's own sync (src/arrivals.ts): the four shapes seen live in downloads/finished
 * beside a TV file, found by their names alone (never by a path on the seedbox), rclone's .partial files and the sync's
 * one-file-at-a-time gaps, the hold that keeps the hourly cleanup off the files (refreshed while waiting and importing, until
 * the removal once imported, again at once after a restart), the removal itself (exactly what was taken, the folders it leaves
 * empty inside its own folder; retried, restart-safe, never a loss; a copy that comes after an import from the seedbox; the
 * leftovers listed for the admin's OK), a cleanup that races a late claim, the bounds and the Queue's question, the one
 * setting ("Finished downloads land in": emptied = today's path; a client's old "Synced folder" migrated), the seedbox's side
 * read through a client's remote path (its folder there gone or emptied is all of it carried; one onto downloads/finished itself is
 * left out, and nothing there is deleted). A temp folder stands for downloads/finished, a fake clock for the hours, a stub for the
 * download client; no network, no mount.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { db, kv, stmts, upsertGame, type FetchRow, type GameRow, type JobRow, type RequestRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { rdeps, createRequest, requestsTick, retryRequest } from "../src/requests";
import { cancelJob, rdeps as runner, runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { inspectRom } from "../src/process/validate";
import { probeRoot, resetRemote, rmdeps, type Probe } from "../src/remote";
import { cancelAllPulls, deps as fdeps, forgetSnapshots, tick as fetchTick } from "../src/fetch";
import { adeps, arrivalOf, arrivalsEverySec, arrivalsHealth, arrivalsTick, chooseArrival, forgetArrivals, listLeftovers, removeLeftovers, REMOVAL_WARN_TRIES, resumeArrivals, watchSynced, type Taken } from "../src/arrivals";
import { utimes } from "node:fs/promises";
import { registerTask, startScheduler, stopScheduler } from "../src/tasks";
import { ARRIVALS_KEY, arrivalsDir, migrateSyncMap } from "../src/synced";
import { configSource, readConfig, writeConfig } from "../src/config";
import { dupeKey, nzbget as nzbgetPlugin, rtorrent as rtorrentPlugin } from "../src/plugins/builtin/clients";
import { torrentFileList } from "../src/bencode";
import { activityApi } from "../src/api/activity";
import { seedingTick, sgdeps } from "../src/seeding";
import type { DownloadClient, ImportResult } from "../src/plugins/types";
import type { ReleaseView } from "../src/releases";
import type { SbClient, SbItem } from "../src/seedbox-items";

const tmp = mkdtempSync(join(tmpdir(), "arrivals-"));
/** downloads/finished: the folder the admin's sync fills (/arrivals in the container) */
const A = join(tmp, "downloads", "finished");
/** the seedbox's own folder mounted here (the remote path mapping, /remote/downloads) */
const MOUNT = join(tmp, "remote", "downloads");
const HOME = "/home/user/downloads", FROM = `${HOME}/complete`;
const TV = "Chicago.Med.S12E03.1080p.WEB.h264-ETHEL.mkv";

const S = {
  now: Date.now(),
  items: [] as SbItem[],
  files: new Map<string, { path: string; size: number }[]>(),
  adds: [] as { key?: string; title: string; protocol: string }[],
  removes: [] as { id: string; data: boolean }[],
  pulls: [] as string[],
  seq: 0,
  grabs: 0,
  made: [] as number[],
  inputs: [] as string[],
  mount: { ok: true, ms: 3, entries: 4, dev: "array-1", mounted: true, why: null } as Probe,
};

/** "Finished downloads land in" (the one setting): a folder, or "" to turn it off */
const setFolder = (to: string) => kv.set(`cfg.${ARRIVALS_KEY}`, to);
/** a seedbox path through the remote path mapping (/home/user/downloads=/remote/downloads) */
const onMount = (p: string) => (p === HOME ? MOUNT : p.startsWith(`${HOME}/`) ? join(MOUNT, ...p.slice(HOME.length + 1).split("/")) : null);
/** the finished-downloads folder as the monitor lists it (src/remote.ts roots), while it is on */
const finishedRoot = () => { const d = arrivalsDir(); return d ? [{ from: "", to: d, client: "", instanceId: 0, kind: "synced" as const }] : []; };

/** the download client: rTorrent and NZBGet in one stub (the finished-downloads folder is the setting's, not the client's) */
const client: DownloadClient = {
  test: async () => ({ ok: true, detail: "stub" }),
  add: async (_p, o) => { S.adds.push({ key: o.key, title: o.title, protocol: o.protocol }); return { client: o.protocol === "usenet" ? "nzbget" : "rtorrent", clientId: o.protocol === "usenet" ? String(900 + S.adds.length) : `HASH-AGAIN-${S.adds.length}` }; },
  items: async () => ({ items: S.items }),
  remove: async (ref, data) => { S.removes.push({ id: ref.clientId, data }); },
  pull: item => { S.pulls.push(item.path); return { local: onMount(item.path) ?? item.path }; },
  files: async ref => S.files.get(ref.clientId) ?? [],
};

const saved = { r: { ...rdeps }, rm: { ...rmdeps }, run: { ...runner }, f: { ...fdeps }, p: { ...pdeps }, a: { ...adeps } };

beforeAll(() => { ensureDefaultRootFolder(); });
beforeEach(() => {
  // what other files left in flight is not woken by this file's clock
  db.exec("UPDATE requests SET state='cancelled' WHERE state IN ('requested','matching','fetching','processing')");
  db.exec("UPDATE fetches SET state='failed' WHERE state IN ('submitted','downloading','seedbox_done','pulling','arriving')");
  db.exec("UPDATE jobs SET state='cancelled' WHERE state IN ('queued','running')");
  resetRemote(); cancelAllPulls(); forgetSnapshots(); forgetArrivals();
  rmSync(A, { recursive: true, force: true }); rmSync(MOUNT, { recursive: true, force: true });
  mkdirSync(A, { recursive: true }); mkdirSync(MOUNT, { recursive: true });
  Object.assign(S, { now: Date.now(), items: [], files: new Map(), adds: [], removes: [], pulls: [], grabs: 0, inputs: [], mount: { ok: true, ms: 3, entries: 4, dev: "array-1", mounted: true, why: null } });
  setFolder(A);
  rmdeps.roots = () => [{ from: HOME, to: MOUNT, client: "rTorrent", instanceId: 7 }, ...finishedRoot()];
  rmdeps.probe = async () => ({ ...S.mount });
  rmdeps.now = () => S.now;
  rdeps.now = () => S.now;
  rdeps.log = () => {};
  rdeps.usenetAvailable = async () => true;
  rdeps.agentReady = () => false;
  rdeps.grab = async (rel, gameId) => {
    S.grabs++;
    const usenet = rel.protocol === "usenet";
    const row = stmts.insertFetch({ game_id: gameId, guid: rel.guid, indexer_id: 1, indexer: "GGn", title: rel.title, protocol: rel.protocol, size: rel.size, info_hash: null, client: usenet ? "nzbget" : "rtorrent", client_id: usenet ? String(100 + S.seq) : `HASH-${S.seq}`, state: "submitted", release_json: JSON.stringify(rel), client_instance_id: 7 });
    return { fetch: { id: row.id } as never, duplicate: false };
  };
  fdeps.now = () => S.now;
  fdeps.log = () => {};
  fdeps.clientById = () => client;
  fdeps.clients = () => [{ id: 7, name: "rTorrent", client, protocols: ["torrent", "usenet"] }];
  adeps.now = () => S.now;
  adeps.log = () => {};
  adeps.clientById = () => client;
  adeps.mountInfo = () => "";
  adeps.payload = async () => ({ kind: "nzb", bytes: new Uint8Array([60, 110, 122, 98, 47, 62]), filename: "again.nzb" });
  adeps.watch = () => null;
  pdeps.log = () => {};
  // the import: whatever the download is, a dump comes out (what matters here is where it was read from)
  runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async (ctx: { input: string; staging: string }) => {
    S.inputs.push(ctx.input);
    const dump = new Uint8Array(32_768).fill(3); dump.set([0x80, 0x37, 0x12, 0x40], 0);
    writeFileSync(join(ctx.staging, "Arrival Quest (USA).z64"), dump);
    return { ok: true, shape: "folder", reason: null, platform: "n64", validation: await inspectRom(ctx.staging) } as ImportResult;
  }) as never } }];
});
afterEach(() => {
  Object.assign(rdeps, saved.r); Object.assign(rmdeps, saved.rm); Object.assign(runner, saved.run); Object.assign(fdeps, saved.f); Object.assign(pdeps, saved.p); Object.assign(adeps, saved.a);
  resetRemote(); cancelAllPulls(); forgetSnapshots(); forgetArrivals();
  kv.del(`cfg.${ARRIVALS_KEY}`);                                 // (the default /arrivals is no folder here: off for every other file)
  for (const id of S.made) {
    db.query("UPDATE requests SET state='cancelled', remote_json=NULL WHERE game_id=? AND state IN ('requested','matching','fetching','processing','failed')").run(id);
    db.query("UPDATE fetches SET state=CASE WHEN state IN ('submitted','downloading','seedbox_done','pulling','arriving') THEN 'failed' ELSE state END, cleaned_at=COALESCE(cleaned_at, 1), arrival_json=NULL WHERE game_id=?").run(id);
    db.query("UPDATE jobs SET state='cancelled' WHERE game_id=? AND state IN ('queued','running')").run(id);
  }
});
afterAll(() => {
  for (const id of S.made) for (const t of ["requests", "jobs", "blocklist", "fetches", "history", "packages"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of S.made) db.query("DELETE FROM games WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

/* ─────────── the world ─────────── */

const rv = (title: string, protocol: "torrent" | "usenet"): ReleaseView => ({
  guid: `guid:${title}`, title, instanceId: 1, indexerId: 11, indexer: "GGn", size: 5e9, age: 10, publishDate: "", seeders: 40, leechers: 0, grabs: null, files: null,
  downloadUrl: "http://p/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol, categories: [], indexerFlags: [], fileName: null,
  parsed: { group: null, repack: false, scene: false, version: null, edition: null, languages: null, dlc: false, junk: [], year: 2020, platform: "Windows", format: "Home Rip" },
  match: { ok: true, core: 1, optional: 1 }, score: 120, reasons: [], flags: { sequel: false, extraWords: false, buried: false, yearOff: null }, alsoOn: [],
} as ReleaseView);
const req = (id: number) => stmts.requestById.get(id) as RequestRow;
const fetchRow = (id: number) => stmts.fetchById.get(id) as FetchRow;
const job = (id: number) => stmts.jobById.get(id) as JobRow;
const blocks = (gameId: number) => db.query("SELECT guid, title FROM blocklist WHERE game_id=?").all(gameId) as { guid: string | null; title: string }[];
const historyOf = (gameId: number, event: string) => (db.query("SELECT message FROM history WHERE game_id=? AND event=? ORDER BY id").all(gameId, event) as { message: string | null }[]).map(h => h.message ?? "");
const arrival = (fid: number) => arrivalOf(fetchRow(fid))!;
const sec = () => Math.floor(S.now / 1000);
const mtime = (p: string) => statSync(p).mtimeMs;
/** how old a file's date is, in minutes of the fake clock */
const age = (p: string) => (S.now - mtime(p)) / 60_000;

function game() {
  const g = upsertGame({ name: `Arrival Quest ${++S.seq}`, slug: `arrival-quest-${S.seq}-${Date.now()}`, platforms_json: '["win"]' } as Partial<GameRow>) as GameRow;
  S.made.push(g.id);
  return g;
}

/**
 * A search whose release finished on the seedbox: grabbed, then the client lists it done (rTorrent: its files; NZBGet: what it
 * downloaded; `nzbName`: NZBGet's NZB name when it is not its folder's) and the download worker's next look hands it on —
 * awaited in the finished-downloads folder, never pulled.
 */
async function finished(o: { name: string; protocol?: "torrent" | "usenet"; files?: [string, number][]; path?: string; isDir?: boolean; label?: string; downloaded?: number; guid?: string; finishedAgoMin?: number; nzbName?: string }) {
  const protocol = o.protocol ?? "torrent";
  const g = game();
  rdeps.search = async () => ({ query: {} as never, searched: [], raw: 1, ranked: [{ ...rv(o.name, protocol), ...(o.guid ? { guid: o.guid } : {}) }], errors: [] });
  const { request } = createRequest({ gameId: g.id });
  await requestsTick();
  const r0 = req(request.id);
  expect(r0.state).toBe("fetching");
  const f0 = fetchRow(r0.fetch_id!);
  if (o.files) S.files.set(f0.client_id!, o.files.map(([path, size]) => ({ path, size })));
  const total = (o.files ?? []).reduce((s, [, n]) => s + n, 0) || 4100;
  // a torrent of one file named like it is a single-file torrent; any other list is a folder
  const isDir = o.isDir ?? (protocol === "usenet" || !(o.files?.length === 1 && o.files[0][0] === o.name));
  S.items.push({
    id: `${protocol === "usenet" ? "nz" : "rt"}:${f0.client_id}`, client: f0.client as SbClient, clientId: f0.client_id!, name: o.nzbName ?? o.name, state: "done", progress: 1,
    sizeBytes: total, doneBytes: total, downRate: 0, path: o.path ?? `${HOME}/${o.name}`, isDir, message: protocol === "usenet" ? "SUCCESS/ALL" : "", label: o.label ?? "ludarr",
    ...(o.downloaded ? { downloadedBytes: o.downloaded } : {}), ...(o.finishedAgoMin ? { finishedAt: Math.floor(S.now / 1000) - o.finishedAgoMin * 60 } : {}),
  });
  await fetchTick();
  const f = fetchRow(f0.id);
  expect(f.state).toBe("arriving");
  return { g, rid: request.id, fid: f0.id };
}

/** a file the sync carried here: whole, with the seedbox's date (`ageMin` minutes before now) */
function land(p: string, size: number, ageMin = 90) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, new Uint8Array(size).fill(7));
  const t = new Date(S.now - ageMin * 60_000); utimesSync(p, t, t);
}
/** a file the sync is writing now: rclone's part file beside where it will land */
function writing(p: string, size: number): string {
  mkdirSync(dirname(p), { recursive: true });
  const part = `${p}.a1b2c3d4.partial`;
  writeFileSync(part, new Uint8Array(size));
  const t = new Date(S.now); utimesSync(part, t, t);
  return part;
}
/** the part file finished: renamed to its name, with the seedbox's date */
function finish(part: string, size: number, ageMin = 90) {
  const p = part.replace(/\.a1b2c3d4\.partial$/, "");
  writeFileSync(part, new Uint8Array(size).fill(7));
  renameSync(part, p);
  const t = new Date(S.now - ageMin * 60_000); utimesSync(p, t, t);
}
/** the admin's hourly cleanup: `find downloads/finished -type f -mmin +60 -exec rm`, then the empty folders; what it deleted */
function cleanup(): string[] {
  const gone: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); try { if (!readdirSync(p).length) rmdirSync(p); } catch { /* not empty */ } }
      else if (mtime(p) < S.now - 60 * 60_000) { unlinkSync(p); gone.push(p); }
    }
  };
  walk(A);
  return gone;
}
/** one look of the arrivals task after `s` seconds of the clock */
async function pass(s = 5) { S.now += s * 1000; await arrivalsTick(); }
/** the task for `minutes`, a look every `every` seconds */
async function passes(minutes: number, every = 60) { for (let t = 0; t < minutes * 60; t += every) await pass(every); }
/** the search's next look, its import run, and the look after */
async function imported(rid: number) {
  await requestsTick();
  const r = req(rid);
  expect(r.state).toBe("processing");
  await runJob(r.job_id!);
  await requestsTick();
  return req(rid);
}
const queueItem = async (rid: number) => ((await (await activityApi.request("/api/v1/queue")).json()) as { items: { id: number; waiting: { kind: string; stopped: boolean; words: string; ask?: { why: string; choices: string[] } | null } | null }[] }).items.find(i => i.id === rid)!;
const answer = (fid: number, choice: string) => activityApi.request(`/api/v1/download/${fid}/arrival`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice }) });

/* ─────────── the four shapes seen live, beside a TV file ─────────── */

describe("arrival: the shapes the sync brings, imported where they are", () => {
  test("a torrent folder nested under a folder of its own name (FitGirl): found, held, imported in place, then removed", async () => {
    const name = "Call of Duty - MW4 [FitGirl Repack]";
    land(join(A, TV), 4_000, 50);
    const tvDate = mtime(join(A, TV));
    const { g, rid, fid } = await finished({ name, files: [["fg-01.bin", 3_000], ["fg-02.bin", 2_000], ["setup.exe", 1_000]] });
    await requestsTick();
    expect(req(rid).stage).toMatch(/finished-downloads folder/);
    expect(req(rid).stage).not.toMatch(/queued|sent to|MB\/s|^finished downloading|^transferring|^downloading/);
    const C = join(A, name, name);
    land(join(C, "fg-01.bin"), 3_000);                       // the seedbox finished it 90 min ago: "already an hour old"
    await pass();
    expect(age(join(C, "fg-01.bin"))).toBeLessThan(1);       // held the moment it showed
    await requestsTick();
    expect(req(rid).stage).toMatch(/arriving in the finished-downloads folder: 1 of 3 files/);
    expect(req(rid).progress).toBeGreaterThan(0.5);
    land(join(C, "fg-02.bin"), 2_000); land(join(C, "setup.exe"), 1_000);
    await pass();
    expect(fetchRow(fid).state).toBe("arriving");            // whole once: looked at again a minute later
    await passes(2);
    const f = fetchRow(fid);
    expect(f.state).toBe("done");
    expect(f.local_path).toBe(join(A, name, name));
    const r = await imported(rid);
    expect(r.state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(join(A, name, name));         // read in place, from the finished-downloads folder
    expect(existsSync(join(C, "fg-01.bin"))).toBe(true);       // nothing moved or deleted while it is read
    expect(S.pulls).toEqual([]);                               // never transferred
    await pass();
    expect(arrival(fid).hold?.released).not.toBeNull();        // the hold ends with its removal
    expect(arrival(fid).rm?.state).toBe("done");
    expect(historyOf(g.id, "removed")).toEqual(["removed from the finished-downloads folder after its import (3 files, 0.0 GB)"]);
    expect(historyOf(g.id, "left")).toEqual([]);
    expect(existsSync(join(A, name))).toBe(false);             // its files, its folder and the folder of its name it sat in
    expect(existsSync(A)).toBe(true);
    expect(mtime(join(A, TV))).toBe(tvDate);                   // the TV file was never touched
    expect(blocks(g.id)).toEqual([]);
    expect(S.grabs).toBe(1);
  });

  test("a single-file torrent in a folder of its own name (Call.of.Duty.MW4.SP.rar/)", async () => {
    const name = "Call.of.Duty.MW4.SP.rar";
    land(join(A, TV), 4_000, 50);
    const { rid, fid } = await finished({ name, files: [[name, 5_000]], isDir: false });
    land(join(A, name, name), 5_000);
    await passes(2);
    expect(fetchRow(fid).local_path).toBe(join(A, name, name));
    expect((await imported(rid)).state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(join(A, name, name));
  });

  test("a torrent folder straight in the finished-downloads folder (Call.Of.Duty.4-Razor1911/…), with a subfolder", async () => {
    const name = "Call.Of.Duty.4-Razor1911";
    land(join(A, TV), 4_000, 50);
    const { rid, fid } = await finished({ name, files: [["rzr-cod4.rar", 2_500], ["rzr-cod4.r00", 2_500], ["Crack/iw3sp.exe", 300]] });
    land(join(A, name, "rzr-cod4.rar"), 2_500); land(join(A, name, "rzr-cod4.r00"), 2_500); land(join(A, name, "Crack", "iw3sp.exe"), 300);
    await passes(2);
    expect(fetchRow(fid).local_path).toBe(join(A, name));
    expect((await imported(rid)).state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(join(A, name));
  });

  test("a usenet download: NZBGet's folder (complete/ahoy/X) found as ahoy/X by its name, taken after the quiet time", async () => {
    const name = "Call.of.Duty.Modern.Warfare.4-RUNE";
    land(join(A, TV), 4_000, 50);
    const { rid, fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 4_100 });
    const X = join(A, "ahoy", name);
    land(join(X, "rune-cod.iso"), 4_000); land(join(X, "rune.nfo"), 100);
    await passes(5);
    expect(fetchRow(fid).state).toBe("arriving");              // unchanged for 5 of the 10 minutes
    expect(arrival(fid).words).toMatch(/quiet|nothing in it changed/);
    await passes(6);
    const f = fetchRow(fid);
    expect(f.state).toBe("done");
    expect(f.local_path).toBe(X);
    expect((await imported(rid)).state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(X);
  });

  test("all four at once beside the TV file: each finds its own, the TV file is never matched or touched", async () => {
    land(join(A, TV), 4_000, 50);
    const tvDate = mtime(join(A, TV));
    const t1 = await finished({ name: "Nested Repack", files: [["a.bin", 1_000], ["b.bin", 1_100]] });
    const t2 = await finished({ name: "Single.File.iso", files: [["Single.File.iso", 1_200]], isDir: false });
    const t3 = await finished({ name: "Plain.Folder-GRP", files: [["c.bin", 1_300], ["d.bin", 1_400]] });
    const u = await finished({ name: "Usenet.Thing-GRP", protocol: "usenet", path: `${FROM}/ahoy/Usenet.Thing-GRP`, downloaded: 1_500 });
    land(join(A, "Nested Repack", "Nested Repack", "a.bin"), 1_000); land(join(A, "Nested Repack", "Nested Repack", "b.bin"), 1_100);
    land(join(A, "Single.File.iso", "Single.File.iso"), 1_200);
    land(join(A, "Plain.Folder-GRP", "c.bin"), 1_300); land(join(A, "Plain.Folder-GRP", "d.bin"), 1_400);
    land(join(A, "ahoy", "Usenet.Thing-GRP", "u.bin"), 1_500);
    await passes(11);
    expect(fetchRow(t1.fid).local_path).toBe(join(A, "Nested Repack", "Nested Repack"));
    expect(fetchRow(t2.fid).local_path).toBe(join(A, "Single.File.iso", "Single.File.iso"));
    expect(fetchRow(t3.fid).local_path).toBe(join(A, "Plain.Folder-GRP"));
    expect(fetchRow(u.fid).local_path).toBe(join(A, "ahoy", "Usenet.Thing-GRP"));
    expect(mtime(join(A, TV))).toBe(tvDate);
    S.now += 11 * 60_000;
    expect(cleanup()).toEqual([join(A, TV)]);                  // the cleanup takes the TV file; ours are held
  });
});

/* ─────────── by its name alone, two levels deep ─────────── */

describe("arrival: found by its name alone — never by a path on the seedbox — two levels deep", () => {
  test("a torrent nested as <folder>/<name>/<name>, wherever its client keeps it on the seedbox", async () => {
    const name = "Elden.Ring.Nightreign [FitGirl Repack]";
    const { rid, fid } = await finished({ name, files: [["fg-01.bin", 2_000], ["setup.exe", 300]], path: `/data/rtorrent/session-7/${name}` });
    land(join(A, name, name, "fg-01.bin"), 2_000); land(join(A, name, name, "setup.exe"), 300);
    await passes(2);
    expect(fetchRow(fid).local_path).toBe(join(A, name, name));
    expect((await imported(rid)).state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(join(A, name, name));
  });

  test("a single file in <folder>/<name>/, its client's path saying nothing of where it lands", async () => {
    const name = "Hades.II.v1.0-RUNE.iso";
    const { fid } = await finished({ name, files: [[name, 4_200]], isDir: false, path: `/srv/torrents/${name}` });
    land(join(A, name, name), 4_200);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
    expect(fetchRow(fid).local_path).toBe(join(A, name, name));
  });

  test("usenet in <folder>/ahoy/<name>: the last folder of NZBGet's FinalDir, never its seedbox path", async () => {
    const name = "Kingdom.Come.Deliverance.II-RUNE";
    const { rid, fid } = await finished({ name, protocol: "usenet", path: `/var/lib/nzbget/dst/ahoy/${name}`, downloaded: 3_000 });
    land(join(A, "ahoy", name, "rune-kcd2.iso"), 3_000);
    await passes(11);
    expect(fetchRow(fid).local_path).toBe(join(A, "ahoy", name));
    expect((await imported(rid)).state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(join(A, "ahoy", name));
  });

  test("usenet straight in the folder (<folder>/<name>, no category folder)", async () => {
    const name = "Split.Fiction-RUNE";
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/${name}`, downloaded: 2_000 });
    land(join(A, name, "rune-sf.iso"), 2_000);
    await passes(11);
    expect(fetchRow(fid).state).toBe("done");
    expect(fetchRow(fid).local_path).toBe(join(A, name));
  });

  test("usenet found by NZBGet's NZB name when its folder on the seedbox is named otherwise", async () => {
    const nzb = "Avowed.Premium.Edition-RUNE";
    const { fid } = await finished({ name: nzb, nzbName: nzb, protocol: "usenet", path: `${FROM}/ahoy/${nzb}.#2`, downloaded: 1_000 });
    land(join(A, "ahoy", nzb, "rune-avowed.iso"), 1_000);
    await passes(11);
    expect(arrival(fid).name).toBe(`${nzb}.#2`);
    expect(arrival(fid).alt).toBe(nzb);
    expect(fetchRow(fid).local_path).toBe(join(A, "ahoy", nzb));
  });

  test("two places named like it: nothing touched, said and asked; once one goes, the other is taken", async () => {
    const name = "Two.Places-RUNE";
    const { fid, rid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    land(join(A, "ahoy", name, "a.iso"), 1_000, 50);
    land(join(A, name, "a.iso"), 1_000, 50);
    const before = mtime(join(A, "ahoy", name, "a.iso"));
    await passes(11);
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrival(fid).trouble).toBe("ambiguous");
    expect(arrival(fid).troubleWords).toMatch(/two places in the finished-downloads folder \(.*ahoy\/Two\.Places-RUNE.*\)/);
    expect(mtime(join(A, "ahoy", name, "a.iso"))).toBe(before);
    expect(mtime(join(A, name, "a.iso"))).toBe(before);
    expect(arrival(fid).hold).toBeNull();
    await requestsTick();
    expect(req(rid).stage).toMatch(/cannot be told apart/);
    expect((await queueItem(rid)).waiting?.ask?.why).toBe("ambiguous");
    rmSync(join(A, name), { recursive: true, force: true });
    await passes(11);
    expect(fetchRow(fid).state).toBe("done");
    expect(fetchRow(fid).local_path).toBe(join(A, "ahoy", name));
  });

  test("a TV item never matches: TV files and folders beside it, at both levels, are never held or taken", async () => {
    const tv = [join(A, TV), join(A, "tv", "Chicago.Med.S12E04.1080p.WEB.h264-ETHEL", "ep.mkv"), join(A, "Severance.S02E09.2160p.WEB.h265-NHTFS", "ep.mkv"), join(A, "ahoy", "The.Pitt.S01E07.1080p.WEB.h264-SuccessfulCrab", "ep.mkv")];
    for (const p of tv) land(p, 700, 50);
    const dates = tv.map(mtime);
    const t = await finished({ name: "Severance.The.Game-GRP", files: [["a.bin", 900]] });
    const u = await finished({ name: "The.Pitt.Simulator-RUNE", protocol: "usenet", path: `${FROM}/ahoy/The.Pitt.Simulator-RUNE`, downloaded: 800 });
    land(join(A, "Severance.The.Game-GRP", "a.bin"), 900);
    land(join(A, "ahoy", "The.Pitt.Simulator-RUNE", "b.iso"), 800);
    await passes(11);
    expect(fetchRow(t.fid).local_path).toBe(join(A, "Severance.The.Game-GRP"));
    expect(fetchRow(u.fid).local_path).toBe(join(A, "ahoy", "The.Pitt.Simulator-RUNE"));
    expect(tv.map(mtime)).toEqual(dates);
    S.now += 11 * 60_000;
    expect(cleanup().sort()).toEqual([...tv].sort());          // the cleanup takes every TV item; ours are held
  });

  test("never deeper than two levels: <folder>/x/y/<name> is not it", async () => {
    const name = "Too.Deep-GRP";
    const { fid } = await finished({ name, files: [["a.bin", 500]] });
    land(join(A, "x", "y", name, "a.bin"), 500, 50);
    const before = mtime(join(A, "x", "y", name, "a.bin"));
    await passes(3);
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrival(fid).seenAt).toBeNull();
    expect(mtime(join(A, "x", "y", name, "a.bin"))).toBe(before);
  });
});

/* ─────────── what keeps it waiting ─────────── */

describe("arrival: rclone's part files, a growing file and the sync's gaps keep it waiting", () => {
  test("the rename race: a part file keeps a torrent waiting (looked at every second); the file it becomes is held at once", async () => {
    const name = "Race.Condition-GRP";
    const { fid } = await finished({ name, files: [[name, 2_000]], isDir: false });
    const part = writing(join(A, name, name), 900);
    await pass();
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrivalsEverySec()).toBe(1);                        // a part beside it: looked at every second
    await pass(1);
    finish(part, 2_000, 120);                                  // renamed into place, two hours "old"
    expect(age(join(A, name, name))).toBeGreaterThan(60);      // a cleanup now would take it
    await pass(1);
    expect(age(join(A, name, name))).toBeLessThan(1);          // held at the first look, a second later
    S.now += 5 * 60_000;
    expect(cleanup()).toEqual([]);                             // the cleanup's next turn leaves it
  });

  test("a change in the folder (fs.watch) wakes a look at once: the file renamed into place is held without waiting its turn", async () => {
    let wakeUp: ((name: string | null) => void) | null = null;
    adeps.watch = (_dir, w) => { wakeUp = w; return { close() {} }; };
    watchSynced();
    expect(wakeUp).not.toBeNull();
    const name = "Woken.Up-GRP";
    await finished({ name, files: [[name, 800]], isDir: false });
    await pass();                                              // its next look is a while away on the clock …
    land(join(A, name, name), 800, 120);
    wakeUp!(null);                                             // … but the folder says something changed (not what)
    for (let i = 0; i < 40 && age(join(A, name, name)) > 1; i++) await Bun.sleep(50);
    expect(age(join(A, name, name))).toBeLessThan(1);
  });

  test("a torrent with one file still a part is never taken, however long", async () => {
    const name = "Half.There-GRP";
    const { fid } = await finished({ name, files: [["one.bin", 1_000], ["two.bin", 1_000]] });
    land(join(A, name, "one.bin"), 1_000);
    const part = writing(join(A, name, "two.bin"), 400);
    for (let i = 0; i < 10; i++) { utimesSync(part, new Date(S.now), new Date(S.now)); await pass(60); }
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrival(fid).here).toBe(1);
    finish(part, 1_000);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
  });

  test("a usenet download with a part inside, or a file that grows, starts its quiet time again", async () => {
    const name = "Growing.Release-GRP";
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 3_000 });
    const X = join(A, "ahoy", name);
    land(join(X, "a.bin"), 1_500);
    const part = writing(join(X, "b.bin"), 300);
    for (let i = 0; i < 12; i++) { utimesSync(part, new Date(S.now), new Date(S.now)); await pass(60); }
    expect(fetchRow(fid).state).toBe("arriving");              // 12 min, a part inside: no quiet time
    finish(part, 1_200);
    await passes(6);
    land(join(X, "a.bin"), 1_800);                             // a file that changed size: the clock starts again
    await passes(6);
    expect(fetchRow(fid).state).toBe("arriving");
    await passes(6);
    expect(fetchRow(fid).state).toBe("done");
  });

  test("the sync's one-file-at-a-time gaps: while it copies another download's file, the quiet time stands still", async () => {
    const name = "One.At.A.Time-GRP";
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 2_000 });
    const X = join(A, "ahoy", name);
    land(join(X, "part1.rar"), 1_900);                         // 95 % of it: only its last small file is still to come
    // the next run copies a TV episode first (one transfer at a time): 14 minutes of a part elsewhere in the folder
    const tv = writing(join(A, "Some.Show.S01E01.mkv"), 500);
    for (let i = 0; i < 14; i++) { utimesSync(tv, new Date(S.now), new Date(S.now)); await pass(60); }
    expect(fetchRow(fid).state).toBe("arriving");              // 14 min unchanged, but the sync was busy: not taken
    expect(arrival(fid).words).toMatch(/the sync is copying other files/);
    finish(tv, 900, 5);
    await passes(3);
    land(join(X, "part2.rar"), 100);                           // the rest of it comes on the next run
    await passes(9);
    expect(fetchRow(fid).state).toBe("arriving");
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
  });

  test("NZBGet not saying what it downloaded: a usenet download is never taken meanwhile, quiet or not", async () => {
    const name = "Silent.Client-GRP";
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    client.items = async () => { throw new Error("NZBGET_HTTP_502"); };
    try {
      S.now += 2 * 60_000;                                       // its last answer is old: asked again, and it does not answer
      land(join(A, "ahoy", name, "a.bin"), 1_000);
      await passes(15);
      expect(fetchRow(fid).state).toBe("arriving");
      expect(arrival(fid).words).toMatch(/waiting for NZBGet to say how much it downloaded/);
    } finally { client.items = async () => ({ items: S.items }); }
    await passes(12);
    expect(fetchRow(fid).state).toBe("done");
  });

  test("a usenet download with less than 90 % of what NZBGet downloaded waits, quiet or not", async () => {
    const name = "Short.Of.It-GRP";
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 10_000 });
    land(join(A, "ahoy", name, "x.bin"), 5_000);
    await passes(15);
    expect(fetchRow(fid).state).toBe("arriving");
    land(join(A, "ahoy", name, "y.bin"), 4_500);
    await passes(11);
    expect(fetchRow(fid).state).toBe("done");
  });
});

/* ─────────── told apart, or not ─────────── */

describe("arrival: what cannot be told apart is never touched", () => {
  test("two places holding it (nested in a folder of its name, and in a category's folder): nothing touched, said, asked", async () => {
    const name = "Twice.Here-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000]], label: "ludarr" });
    land(join(A, name, name, "a.bin"), 1_000, 50);
    land(join(A, "ludarr", name, "a.bin"), 1_000, 50);
    const before = mtime(join(A, name, name, "a.bin"));
    await pass();
    const a = arrival(fid);
    expect(a.trouble).toBe("ambiguous");
    expect(a.troubleWords).toMatch(/two places in the finished-downloads folder/);
    expect(a.troubleWords).toContain(`${name}/${name}`);
    expect(a.troubleWords).toContain(`ludarr/${name}`);
    expect(mtime(join(A, name, name, "a.bin"))).toBe(before);
    expect(mtime(join(A, "ludarr", name, "a.bin"))).toBe(before);
    expect(a.hold).toBeNull();
    await requestsTick();
    expect(req(rid).stage).toMatch(/cannot be told apart/);
    expect((await arrivalsHealth(sec())).map(h => h.message).join("\n")).toMatch(/Twice.Here-GRP: it is in two places/);
    expect((await queueItem(rid)).waiting?.ask?.choices).toEqual(["seedbox", "wait"]);
    // the other copy goes (its own cleanup): it is told apart again, and goes on by itself
    rmSync(join(A, "ludarr"), { recursive: true, force: true });
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
  });

  test("a file of its name at another size, and a folder of its name that holds more", async () => {
    const t = await finished({ name: "Other.Size-GRP", files: [["a.bin", 1_000]], isDir: true });
    land(join(A, "Other.Size-GRP", "a.bin"), 999);
    await pass();
    expect(arrival(t.fid).troubleWords).toMatch(/at 999 bytes/);
    const u = await finished({ name: "Crowded-GRP", files: [["Crowded-GRP", 1_000]], isDir: false });
    land(join(A, "Crowded-GRP", "Crowded-GRP"), 1_000);
    land(join(A, "Crowded-GRP", "Somebody.Elses.mkv"), 10);
    await pass();
    expect(arrival(u.fid).troubleWords).toMatch(/holds files that are not Crowded-GRP.s beside it \(Somebody.Elses.mkv\)/);
    expect(fetchRow(u.fid).state).toBe("arriving");
  });

  test("wherever NZBGet keeps it on the seedbox, nothing is asked about where: it is on its way until a folder of its name shows", async () => {
    const name = "Elsewhere-GRP";
    const { fid, rid } = await finished({ name, protocol: "usenet", path: `${HOME}/usenet/${name}`, downloaded: 1_000 });
    await pass();
    expect(arrival(fid).trouble).toBeNull();
    expect(arrival(fid).words).toMatch(/on its way to the finished-downloads folder/);
    expect((await queueItem(rid)).waiting?.ask ?? null).toBeNull();
    expect((await arrivalsHealth(sec())).filter(h => h.message.includes(name))).toEqual([]);
    land(join(A, "usenet", name, "a.iso"), 1_000);
    await passes(11);
    expect(fetchRow(fid).local_path).toBe(join(A, "usenet", name));
  });
});

/* ─────────── the hold ─────────── */

describe("arrival: the hold keeps the hourly cleanup off its files until the import is done", () => {
  test("refreshed every 10 min while it arrives and while its import waits and runs; removed after, once (the cleanup finds nothing of it)", async () => {
    const name = "Held.Long-GRP";
    const { rid, fid, g } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000, 120);
    await pass();
    expect(age(join(A, name, "a.bin"))).toBeLessThan(1);
    // 50 minutes with b still on its way: refreshed all along
    await passes(50);
    expect(age(join(A, name, "a.bin"))).toBeLessThanOrEqual(10);
    expect(cleanup()).toEqual([]);
    land(join(A, name, "b.bin"), 1_000, 120);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
    await requestsTick();
    expect(req(rid).state).toBe("processing");                 // the import waits in the queue: still held
    await passes(45);
    expect(age(join(A, name, "a.bin"))).toBeLessThanOrEqual(10);
    expect(cleanup()).toEqual([]);
    expect(arrival(fid).hold?.released).toBeNull();
    await runJob(req(rid).job_id!);
    await requestsTick();
    expect(req(rid).state).toBe("ready");
    await pass();
    expect(arrival(fid).hold?.released).not.toBeNull();        // removed, once: the hold ends with it
    expect(historyOf(g.id, "removed")).toHaveLength(1);
    await passes(70);
    expect(historyOf(g.id, "removed")).toHaveLength(1);
    expect(historyOf(g.id, "left")).toEqual([]);
    expect(existsSync(join(A, name))).toBe(false);
    expect(cleanup()).toEqual([]);
  });

  test("a torrent of many files: its list is kept once (files_json), the state written at each look stays small, a restart reads the list back", async () => {
    const name = "Loose.Game.Folder-GRP";
    const files: [string, number][] = Array.from({ length: 400 }, (_, i) => [`data/pak${String(i).padStart(4, "0")}.bin`, 10 + (i % 7)]);
    const { fid } = await finished({ name, files });
    for (const [p, n] of files.slice(0, 250)) land(join(A, name, ...p.split("/")), n);
    await pass();
    expect(arrival(fid).here).toBe(250);
    expect(arrival(fid).nfiles).toBe(400);
    expect(fetchRow(fid).arrival_json!.length).toBeLessThan(3000);
    expect((JSON.parse(fetchRow(fid).files_json!) as unknown[]).length).toBe(400);
    forgetArrivals();                                          // a restart: the list comes back from the row
    for (const [p, n] of files.slice(250)) land(join(A, name, ...p.split("/")), n);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
  });

  test("a restart in the middle of a hold: every held file gets the present date before anything else runs", async () => {
    const name = "Restart.Mid.Hold-GRP";
    const { rid, fid } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000], ["c.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000); land(join(A, name, "b.bin"), 1_000);
    await pass();
    const other = await finished({ name: "Imported.Waiting-GRP", files: [["x.bin", 500]] });
    land(join(A, "Imported.Waiting-GRP", "x.bin"), 500);
    await passes(2);
    await requestsTick();
    expect(req(other.rid).state).toBe("processing");
    // ludarr is down for 55 minutes: what it kept in memory is gone, the files' dates are 55 min old
    forgetArrivals();
    S.now += 55 * 60_000;
    expect(age(join(A, name, "a.bin"))).toBeGreaterThan(54);
    expect(age(join(A, "Imported.Waiting-GRP", "x.bin"))).toBeGreaterThan(54);
    await resumeArrivals();
    expect(age(join(A, name, "a.bin"))).toBeLessThan(1);
    expect(age(join(A, name, "b.bin"))).toBeLessThan(1);
    expect(age(join(A, "Imported.Waiting-GRP", "x.bin"))).toBeLessThan(1);
    S.now += 10 * 60_000;
    expect(cleanup()).toEqual([]);
    expect(fetchRow(fid).state).toBe("arriving");
    expect(req(rid).state).toBe("fetching");
  });

  test("a folder that refuses new dates is an error at once; held files that went away are an error", async () => {
    const name = "Read.Only-GRP";
    const { fid } = await finished({ name, files: [["a.bin", 1_000]] });
    adeps.touch = async () => { throw Object.assign(new Error("EPERM: operation not permitted, utime"), { code: "EPERM" }); };
    land(join(A, name, "a.bin"), 1_000);
    await pass();
    expect(arrival(fid).hold?.denied).toBe("EPERM");
    expect((await arrivalsHealth(sec())).some(h => h.type === "error" && /refuses new dates/.test(h.message))).toBe(true);
    adeps.touch = saved.a.touch;
    const done = await finished({ name: "Went.Away-GRP", files: [["z.bin", 700]] });
    land(join(A, "Went.Away-GRP", "z.bin"), 700);
    await passes(2);
    expect(fetchRow(done.fid).state).toBe("done");
    await requestsTick();                                      // its import queued: held
    unlinkSync(join(A, "Went.Away-GRP", "z.bin"));
    await passes(11);
    expect(arrival(done.fid).hold?.gone).toBe(1);
    expect((await arrivalsHealth(sec())).some(h => h.type === "error" && /Went.Away-GRP were deleted/.test(h.message))).toBe(true);
  });
});

/* ─────────── lost ─────────── */

describe("arrival: lost before its import — never a bad copy", () => {
  test("the cleanup racing a late claim: files that landed long ago are held at the first look, before the cleanup's turn", async () => {
    const name = "Late.Claim-GRP";
    // the sync carried it before ludarr heard the client finish: the files are already two hours "old"
    land(join(A, name, "a.bin"), 1_000, 120); land(join(A, name, "b.bin"), 1_000, 120);
    const { fid } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    await pass();
    expect(cleanup()).toEqual([]);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
  });

  test("…and when the cleanup won: nothing here, nothing left on the seedbox — a usenet download is downloaded again by itself, once", async () => {
    const name = "Cleanup.Won-GRP";
    const { fid, rid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    await probeRoot(MOUNT);                                    // the seedbox's mount answers, and shows nothing of it left
    await passes(30);
    expect(fetchRow(fid).state).toBe("arriving");              // not before the quiet time and the cleanup's hour
    await passes(50);
    const f = fetchRow(fid);
    expect(f.state).toBe("submitted");                         // the same release in NZBGet again
    expect(S.adds).toEqual([{ key: `guid:${name}#2`, title: name, protocol: "usenet" }]);
    expect(f.client_id).toBe("901");
    expect(blocks(g.id)).toEqual([]);
    expect(S.grabs).toBe(1);                                   // no other copy
    expect(historyOf(g.id, "downloadFailed").join()).toMatch(/nothing of it is left on the seedbox/);
    await requestsTick();
    expect(req(rid).state).toBe("fetching");
  });

  test("…a torrent gone from where its client keeps it on the seedbox, nothing of it here after the cleanup's hour: lost, asked at once", async () => {
    const name = "Carried.Off-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000]], path: `${FROM}/${name}` });
    await probeRoot(MOUNT);                                      // the mount answers: complete/Carried.Off-GRP is not there
    await passes(80);
    const a = arrival(fid);
    expect(a.lost?.why).toMatch(/nothing of it is left on the seedbox/);
    expect(a.lost?.why).not.toMatch(/\/home|complete\//);         // (never a seedbox path in its words)
    expect(a.ask?.why).toBe("lost");
    expect(S.adds).toEqual([]);                                  // a torrent is never downloaded again by itself
    expect((await queueItem(rid)).waiting?.ask?.choices).toEqual(["again", "seedbox", "wait"]);
  });

  test("a torrent still where its client keeps it on the seedbox is never called lost: at 6 h the Queue offers to import it from there", async () => {
    const name = "Seeds.On-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000]] });
    mkdirSync(join(MOUNT, name), { recursive: true });           // rTorrent still seeds it from downloads/: the sync never took it
    writeFileSync(join(MOUNT, name, "a.bin"), new Uint8Array(1_000));
    await probeRoot(MOUNT);
    await passes(80);
    expect(arrival(fid).lost).toBeNull();
    S.now += 6 * 3600_000; await pass();
    expect(arrival(fid).ask?.why).toBe("late");
    expect((await queueItem(rid)).waiting?.ask?.choices).toEqual(["seedbox", "wait", "again"]);
  });

  test("a usenet download still in NZBGet's folder on the seedbox is never called lost, however long", async () => {
    const name = "Outside.Lost-GRP";
    const { fid } = await finished({ name, protocol: "usenet", path: `${HOME}/usenet/${name}`, downloaded: 1_000 });
    mkdirSync(join(MOUNT, "usenet", name), { recursive: true }); writeFileSync(join(MOUNT, "usenet", name, "a.rar"), new Uint8Array(1_000));
    await probeRoot(MOUNT);
    await passes(100, 300);
    expect(arrival(fid).lost).toBeNull();
    expect(arrival(fid).trouble).toBeNull();
  });

  test("a download still in the seedbox's folder is not lost, however late (the sync has not carried it yet)", async () => {
    const name = "Still.There-GRP";
    const { fid } = await finished({ name, files: [["a.bin", 1_000]], path: `${FROM}/${name}` });
    mkdirSync(join(MOUNT, "complete", name), { recursive: true }); writeFileSync(join(MOUNT, "complete", name, "a.bin"), new Uint8Array(1_000));
    await probeRoot(MOUNT);
    await passes(90, 120);
    const a = arrival(fid);
    expect(a.lost).toBeNull();
    expect(fetchRow(fid).state).toBe("arriving");
  });

  test("the cleanup deleting files mid-import: the import fails, the download is lost (asked: torrent), nothing blocklisted", async () => {
    const name = "Mid.Import-GRP";
    const { fid, rid, g } = await finished({ name, files: [["a.bin", 1_000]] });
    const hash = fetchRow(fid).client_id!;
    land(join(A, name, "a.bin"), 1_000);
    await passes(2);
    await requestsTick();
    const jid = req(rid).job_id!;
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async (ctx: { input: string }) => {
      rmSync(ctx.input, { recursive: true, force: true });       // taken while it was read
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${join(ctx.input, "a.bin")}'`), { code: "ENOENT", path: join(ctx.input, "a.bin") });
    }) as never } }];
    await runJob(jid);
    expect(job(jid).state).toBe("failed");
    await requestsTick();
    const r = req(rid);
    expect(r.state).toBe("fetching");
    const f = fetchRow(fid);
    expect(f.state).toBe("arriving");
    expect(arrivalOf(f)?.lost?.why).toMatch(/finished-downloads folder/);
    expect(blocks(g.id)).toEqual([]);
    expect(S.grabs).toBe(1);
    await pass();
    const q = await queueItem(rid);
    expect(q.waiting?.ask?.why).toBe("lost");
    expect(q.waiting?.ask?.choices).toEqual(["again", "seedbox", "wait"]);
    const res = await answer(fid, "again");
    expect(res.status).toBe(200);
    expect(S.removes).toEqual([{ id: hash, data: true }]);       // removed from rTorrent with its data, then added again
    expect(fetchRow(fid).client_id).toBe("HASH-AGAIN-1");
    expect(fetchRow(fid).state).toBe("submitted");
    expect(S.adds.at(-1)?.key).toBe(`guid:${name}`);
    expect(blocks(g.id)).toEqual([]);
  });

  test("an import whose input is gone from the finished-downloads folder at its first look: lost too (a usenet one is downloaded again)", async () => {
    const name = "Gone.At.Start-GRP";
    const { fid, rid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 900 });
    land(join(A, "ahoy", name, "a.bin"), 900);
    await passes(11);
    await requestsTick();
    rmSync(join(A, "ahoy", name), { recursive: true, force: true });
    await runJob(req(rid).job_id!);
    await requestsTick();
    expect(req(rid).state).toBe("fetching");
    expect(fetchRow(fid).state).toBe("arriving");
    await pass();
    expect(fetchRow(fid).state).toBe("submitted");
    expect(S.adds.at(-1)?.key).toBe(`guid:${name}#2`);
    expect(blocks(g.id)).toEqual([]);
  });
});

/* ─────────── the bounds and the question ─────────── */

describe("arrival: the bounds, and what the admin may answer", () => {
  test("nothing after 30 min: a warning; at 6 h an error and the question; keep waiting asks again 6 h on; from the seedbox imports from the mount", async () => {
    const name = "Never.Came-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000]] });
    await passes(31, 120);
    let h = (await arrivalsHealth(sec())).find(x => x.message.includes(name));
    expect(h?.type).toBe("warning");
    expect(h?.message).toMatch(/is the sync running/);
    S.now += 6 * 3600_000; await pass();
    h = (await arrivalsHealth(sec())).find(x => x.message.includes(name));
    expect(h?.type).toBe("error");
    expect(arrival(fid).ask?.why).toBe("late");
    await requestsTick();
    expect(req(rid).stage).toMatch(/import it from the seedbox instead, keep waiting or download it again/);
    expect((await queueItem(rid)).waiting?.ask?.choices).toEqual(["seedbox", "wait", "again"]);
    expect((await answer(fid, "wait")).status).toBe(200);
    expect(arrival(fid).ask).toBeNull();
    S.now += 5 * 3600_000; await pass();
    expect(arrival(fid).ask).toBeNull();
    S.now += 3600_000 + 60_000; await pass();
    expect(arrival(fid).ask?.why).toBe("late");                // asked again 6 h on
    expect((await answer(fid, "seedbox")).status).toBe(200);
    expect(fetchRow(fid).state).toBe("seedbox_done");
    await fetchTick();
    expect(S.pulls).toEqual([`${HOME}/${name}`]);
    const f = fetchRow(fid);
    expect(f.state).toBe("done");
    expect(f.local_path).toBe(join(MOUNT, name));
    await requestsTick();
    expect(job(req(rid).job_id!).input_path).toBe(join(MOUNT, name));   // the admin's choice: read through the mount
  });

  test("from the seedbox needs the seedbox's folder mounted here (a remote path mapping); a choice that is no choice is refused", async () => {
    const { fid } = await finished({ name: "No.Mapping-GRP", files: [["a.bin", 1_000]] });
    rmdeps.roots = () => finishedRoot();
    const res = await answer(fid, "seedbox");
    expect(res.status).toBe(409);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toMatch(/not mounted here/);
    expect(error).not.toMatch(/mapping|synced/i);
    expect((await answer(fid, "later")).status).toBe(400);
    expect(fetchRow(fid).state).toBe("arriving");
  });

  test("72 h without it: the search stops, its download kept, nothing blocklisted; Retry waits for it again from now", async () => {
    const name = "Three.Days-GRP";
    const { fid, rid, g } = await finished({ name, files: [["a.bin", 1_000]] });
    S.now += 72 * 3600_000; await pass();
    expect(arrival(fid).stopped).toBe(true);
    await requestsTick();
    const r = req(rid);
    expect(r.state).toBe("failed");
    expect(r.stage).toBe("waited 3 days for it to arrive in the finished-downloads folder");
    expect(JSON.parse(r.remote_json!)).toMatchObject({ kind: "arrival", stopped: true });
    expect(blocks(g.id)).toEqual([]);
    retryRequest(rid);
    expect(req(rid).state).toBe("fetching");
    const a = arrival(fid);
    expect(a.stopped).toBe(false);
    expect(a.since).toBe(sec());
    land(join(A, name, "a.bin"), 1_000);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
  });
});

/* ─────────── settings ─────────── */

describe("arrival: the one setting", () => {
  /** a torrent done on the seedbox, handed on by the download worker: what it does with it */
  async function plainTorrent(name: string) {
    const g = game();
    rdeps.search = async () => ({ query: {} as never, searched: [], raw: 1, ranked: [rv(name, "torrent")], errors: [] });
    const { request } = createRequest({ gameId: g.id });
    await requestsTick();
    const f0 = fetchRow(req(request.id).fetch_id!);
    S.items.push({ id: `rt:${f0.client_id}`, client: "rtorrent", clientId: f0.client_id!, name, state: "done", progress: 1, sizeBytes: 10, doneBytes: 10, downRate: 0, path: `${HOME}/${name}`, isDir: true, message: "", label: "ludarr" });
    await fetchTick();
    return fetchRow(f0.id);
  }

  test("the setting empty: today's path — the download is transferred (here: read through the mapping), never awaited", async () => {
    setFolder("");
    expect(arrivalsDir()).toBeNull();
    const f = await plainTorrent("Plain.Old.Path-GRP");
    expect(f.state).toBe("done");
    expect(f.local_path).toBe(join(MOUNT, "Plain.Old.Path-GRP"));
    expect(f.arrival_json).toBeNull();
    expect(S.pulls).toEqual([`${HOME}/Plain.Old.Path-GRP`]);
  });

  test("set to a folder that is not there: today's path too, and the health list says why (never the folder's path)", async () => {
    const nope = join(tmp, "nope");
    setFolder(nope);
    expect(arrivalsDir()).toBeNull();
    const f = await plainTorrent("Not.There-GRP");
    expect(f.state).toBe("done");
    expect(f.arrival_json).toBeNull();
    const h = (await arrivalsHealth(sec())).find(x => /is missing/.test(x.message));
    expect(h?.type).toBe("error");
    expect(h?.message).toMatch(/^the finished-downloads folder is missing: new downloads are transferred from the seedbox as before/);
    expect(h?.message).not.toContain(nope);
    expect(h?.link).toBe("/settings/mediamanagement");
  });

  test("emptied in Settings mid-arrival: the download goes back to today's path; its client deleted: it waits", async () => {
    const t = await finished({ name: "Setting.Cleared-GRP", files: [["a.bin", 100]] });
    setFolder("");
    await pass();
    expect(fetchRow(t.fid).state).toBe("seedbox_done");
    await fetchTick();
    expect(fetchRow(t.fid).state).toBe("done");
    expect(S.pulls).toEqual([`${HOME}/Setting.Cleared-GRP`]);
    setFolder(A);
    const u = await finished({ name: "Client.Deleted-GRP", files: [["a.bin", 100]] });
    adeps.clientById = () => null;
    await pass();
    expect(fetchRow(u.fid).state).toBe("arriving");
    expect(arrival(u.fid).words).toMatch(/its download client was deleted/);
  });

  test("one plain global setting: \"Finished downloads land in\", /arrivals by default; emptied it stays empty (off), the default clears it", () => {
    kv.del(`cfg.${ARRIVALS_KEY}`);
    const item = () => readConfig("media").find(c => c.key === ARRIVALS_KEY)!;
    expect(item()).toMatchObject({ label: "Finished downloads land in", doc: "the folder on this server where everything you download ends up", type: "path", value: "/arrivals", source: "default" });
    expect(`${item().label} ${item().doc}`).not.toMatch(/synced|mapping|\/arrivals/i);
    expect(arrivalsDir()).toBeNull();                              // (no /arrivals on this machine: off)
    expect(writeConfig({ [ARRIVALS_KEY]: "" })).toMatchObject({ changed: [ARRIVALS_KEY], errors: [] });
    expect(item()).toMatchObject({ value: "", source: "saved" });   // emptied, it stays empty: never the default again
    expect(writeConfig({ [ARRIVALS_KEY]: "" }).changed).toEqual([]);
    expect(writeConfig({ [ARRIVALS_KEY]: A }).changed).toEqual([ARRIVALS_KEY]);
    expect(arrivalsDir()).toBe(A);
    expect(writeConfig({ [ARRIVALS_KEY]: "/arrivals" }).changed).toEqual([ARRIVALS_KEY]);
    expect(configSource(ARRIVALS_KEY)).toBe("default");
    expect(kv.get(`cfg.${ARRIVALS_KEY}`)).toBeNull();
    // no download client has a folder of its own any more, and none says "synced"
    for (const d of [rtorrentPlugin, nzbgetPlugin]) {
      expect(d.fields.map(f => f.name)).not.toContain("syncMap");
      expect(d.fields.map(f => f.name)).not.toContain("arrivalQuietMin");
      expect(JSON.stringify(d.fields)).not.toMatch(/synced/i);
    }
    const ctx = { config: () => "", paths: { downloads: "/dl", config: "/c", work: "/w", rootFolders: [] }, fetch, log: { info() {}, warn() {}, error() {}, debug() {} }, store: { get: () => null, set() {}, del() {} } } as never;
    expect(typeof rtorrentPlugin.create({ url: "https://box/rpc" }, ctx).files).toBe("function");
  });

  test("a client's saved \"Synced folder\" is migrated: its folder becomes the setting, the old per-client settings go", () => {
    const put = (name: string, enabled: number, settings: Record<string, unknown>) =>
      (db.query("INSERT INTO plugin_instances (kind, impl, name, enabled, priority, settings_json, tags_json) VALUES ('downloadClient','rtorrent',?,?,1,?,'[]') RETURNING id").get(name, enabled, JSON.stringify(settings)) as { id: number }).id;
    const settingsOf = (id: number) => JSON.parse((db.query("SELECT settings_json FROM plugin_instances WHERE id=?").get(id) as { settings_json: string }).settings_json);
    const ids: number[] = [];
    try {
      kv.del(`cfg.${ARRIVALS_KEY}`);
      ids.push(put("Old Disabled", 0, { url: "https://box/rpc", syncMap: "/x/complete=/elsewhere" }));
      ids.push(put("Old rTorrent", 1, { url: "https://box/rpc", pathMap: `${HOME}=/remote/downloads`, syncMap: `${FROM}=/mnt/sync/`, label: "ludarr" }));
      ids.push(put("Old NZBGet", 1, { url: "https://box/nzbget", syncMap: `${FROM}=/mnt/other`, arrivalQuietMin: 12 }));
      ids.push(put("Untouched", 1, { url: "https://box/rpc", pathMap: `${HOME}=/remote/downloads` }));
      const r = migrateSyncMap();
      expect(r).toEqual({ moved: "/mnt/sync", cleaned: 3 });         // the first enabled one's folder; a disabled one's never
      expect(kv.get(`cfg.${ARRIVALS_KEY}`)).toBe("/mnt/sync");
      expect(settingsOf(ids[1])).toEqual({ url: "https://box/rpc", pathMap: `${HOME}=/remote/downloads`, label: "ludarr" });
      expect(settingsOf(ids[2])).toEqual({ url: "https://box/nzbget" });
      expect(settingsOf(ids[0])).toEqual({ url: "https://box/rpc" });
      expect(settingsOf(ids[3])).toEqual({ url: "https://box/rpc", pathMap: `${HOME}=/remote/downloads` });
      expect(migrateSyncMap()).toEqual({ moved: null, cleaned: 0 });  // once
      // a setting saved already wins; a folder that is the default is not saved apart from it
      db.query("UPDATE plugin_instances SET settings_json=? WHERE id=?").run(JSON.stringify({ url: "https://box/rpc", syncMap: `${FROM}=/mnt/third` }), ids[1]);
      expect(migrateSyncMap()).toEqual({ moved: null, cleaned: 1 });
      expect(kv.get(`cfg.${ARRIVALS_KEY}`)).toBe("/mnt/sync");
      kv.del(`cfg.${ARRIVALS_KEY}`);
      db.query("UPDATE plugin_instances SET settings_json=? WHERE id=?").run(JSON.stringify({ url: "https://box/rpc", syncMap: `${FROM}=/arrivals` }), ids[1]);
      expect(migrateSyncMap()).toEqual({ moved: "/arrivals", cleaned: 1 });
      expect(configSource(ARRIVALS_KEY)).toBe("default");
    } finally {
      for (const id of ids) db.query("DELETE FROM plugin_instances WHERE id=?").run(id);
      setFolder(A);
    }
  });

  test("an NZBGet append downloaded again keeps its #2 whole (never the first append's answer); a .torrent's own list", () => {
    expect(dupeKey("guid:abc")).toBe("ludarr:guid:abc");
    expect(dupeKey("guid:abc#2")).toBe("ludarr:guid:abc#2");
    const long = dupeKey(`${"x".repeat(400)}#2`);
    expect(long.length).toBeLessThanOrEqual(250);
    expect(long.endsWith("#2")).toBe(true);
    const enc = (v: unknown): string => typeof v === "number" ? `i${v}e` : typeof v === "string" ? `${Buffer.byteLength(v)}:${v}` : Array.isArray(v) ? `l${v.map(enc).join("")}e` : `d${Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => enc(k) + enc(x)).join("")}e`;
    const multi = new TextEncoder().encode(enc({ announce: "http://t", info: { name: "Game-GRP", "piece length": 16384, pieces: "", files: [{ length: 10, path: ["a.bin"] }, { length: 5, path: ["Sub", "b.bin"] }, { length: 3, path: [".pad", "3"], attr: "p" }] } }));
    expect(torrentFileList(multi)).toEqual([{ p: "Game-GRP/a.bin", s: 10 }, { p: "Game-GRP/Sub/b.bin", s: 5 }]);
    const single = new TextEncoder().encode(enc({ info: { name: "One.iso", length: 42, "piece length": 16384, pieces: "" } }));
    expect(torrentFileList(single)).toEqual([{ p: "One.iso", s: 42 }]);
    expect(torrentFileList(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("the folder's own health: set and missing, or an rclone mount, is an error; the default with no such folder is nothing to say", async () => {
    setFolder(join(tmp, "nope"));
    expect((await arrivalsHealth(sec())).find(h => /is missing/.test(h.message))?.type).toBe("error");
    kv.del(`cfg.${ARRIVALS_KEY}`);                                   // the default, /arrivals: not there on this machine
    expect((await arrivalsHealth(sec())).filter(h => h.source === "FinishedDownloads")).toEqual([]);
    setFolder(A.replace(/\\/g, "/"));
    adeps.mountInfo = () => `36 25 0:32 / ${A.replace(/\\/g, "/")} rw,nosuid,nodev,relatime shared:1 - fuse.rclone seedbox:downloads rw,user_id=0`;
    const h = await arrivalsHealth(sec());
    expect(h.some(x => x.type === "error" && /rclone mount/.test(x.message))).toBe(true);
    expect(h.map(x => x.message).join("\n")).not.toMatch(/mapping|synced/i);
  });

  test("the admin's words never say \"synced\" or \"mapping\", nor the folder's path or a seedbox path", async () => {
    const t = await finished({ name: "Words.Torrent-GRP", files: [["a.bin", 1_000], ["b.bin", 1_000]], path: `${FROM}/Words.Torrent-GRP` });
    const u = await finished({ name: "Words.Usenet-GRP", protocol: "usenet", path: `${FROM}/ahoy/Words.Usenet-GRP`, downloaded: 1_000 });
    const v = await finished({ name: "Words.Twice-GRP", protocol: "usenet", path: `${FROM}/ahoy/Words.Twice-GRP`, downloaded: 1_000 });
    land(join(A, "Words.Torrent-GRP", "a.bin"), 1_000);
    land(join(A, "ahoy", "Words.Twice-GRP", "x.iso"), 1_000); land(join(A, "Words.Twice-GRP", "x.iso"), 1_000);
    const said: string[] = [];
    const look = async () => {
      await requestsTick();
      for (const x of [t, u, v]) { said.push(req(x.rid).stage ?? "", arrival(x.fid).words, arrival(x.fid).troubleWords ?? ""); const q = await queueItem(x.rid); said.push(q?.waiting?.words ?? ""); }
      said.push(...(await arrivalsHealth(sec())).map(h => `${h.source} ${h.message}`));
    };
    await pass(); await look();
    await passes(40); await look();                                // late: is the sync running?
    S.now += 6 * 3600_000; await pass(); await look();             // asked
    for (const x of [t, u, v]) said.push(...["left", "downloadFailed", "grabbed"].flatMap(e => historyOf(x.g.id, e)));
    const text = said.filter(Boolean);
    expect(text.join("\n")).toMatch(/finished-downloads folder/);
    for (const s of text) {
      expect(s).not.toMatch(/synced|mapping/i);
      expect(s).not.toContain("/arrivals");
      expect(s).not.toContain(A);
      expect(s).not.toContain(A.replace(/\\/g, "/"));
      expect(s).not.toContain(HOME);
    }
  });

  test("the grab of a usenet post that landed in the finished-downloads folder and is no longer there downloads it anew", async () => {
    // (a done download whose files the cleanup took is no duplicate to hand back)
    const name = "Gone.Before.Import-GRP";
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 500 });
    land(join(A, "ahoy", name, "a.bin"), 500);
    await passes(11);
    expect(fetchRow(fid).state).toBe("done");
    rmSync(join(A, "ahoy", name), { recursive: true, force: true });
    const { grab } = await import("../src/fetch");
    fdeps.indexerById = () => ({ download: async () => ({ kind: "nzb", bytes: new Uint8Array([1]), filename: "x.nzb" }) }) as never;
    const r = await grab(rv(name, "usenet") as never, null);
    expect(r.duplicate).toBe(false);
    expect(r.fetch.id).not.toBe(fid);
    db.query("UPDATE fetches SET state='failed' WHERE id=?").run(r.fetch.id);
  });
});

/* ─────────── the review of 2026-11-09: each finding reproduced here first, then fixed ─────────── */

/** NZBGet's folder on the seedbox as the remote path mapping shows it (/remote/downloads/complete/ahoy/<name>) */
const onSeedbox = (name: string) => join(MOUNT, "complete", "ahoy", name);
/** a file NZBGet's folder holds on the seedbox */
function seed(name: string, rel: string, size: number) { const p = join(onSeedbox(name), ...rel.split("/")); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, new Uint8Array(size).fill(5)); }
/** the sync carries one file of it: gone from the seedbox, whole here with the seedbox's date */
function carry(name: string, rel: string, size: number, ageMin = 90) { rmSync(join(onSeedbox(name), ...rel.split("/")), { force: true }); land(join(A, "ahoy", name, ...rel.split("/")), size, ageMin); }
/** a .torrent's bytes (bencoded) */
const benc = (v: unknown): string => typeof v === "number" ? `i${v}e` : typeof v === "string" ? `${Buffer.byteLength(v)}:${v}` : Array.isArray(v) ? `l${v.map(benc).join("")}e` : `d${Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => benc(k) + benc(x)).join("")}e`;
/** the import of a search whose recipes give up, its AI importer without a key */
const noRecipe = () => [
  { impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "unknown", reason: "no recipe opens it" })) as never } },
  { impl: "agent", name: "AI importer", importer: { probe: async () => false, run: (async () => { throw new Error("not called"); }) as never } },
] as never;
/** the search's next looks until its download is awaited again (a wait's looks come on their own clock) */
async function untilArriving(fid: number) { for (let i = 0; i < 12 && fetchRow(fid).state !== "arriving"; i++) { S.now += 60_000; await requestsTick(); } }

describe("review: a usenet download is taken only once the sync is done with it (F1, F3, F7)", () => {
  test("F1 the sync stalls with 19 of 20 volumes here: never taken while the 20th is still on the seedbox; taken once it came", async () => {
    const name = "Call.of.Duty.Modern.Warfare.4-RUNE";
    const vols = Array.from({ length: 20 }, (_, i) => `rune-cod.part${String(i + 1).padStart(2, "0")}.rar`);
    for (const v of vols) seed(name, v, 100);
    const { fid, rid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 2_000 });
    await pass();
    for (const v of vols.slice(0, 19)) carry(name, v, 100);      // then the seedbox's SFTP stops answering the sync: no part file anywhere
    await passes(15);
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrival(fid).words).toMatch(/still on the seedbox/);
    carry(name, vols[19], 100);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
    expect((await imported(rid)).state).toBe("ready");
    expect(blocks(g.id)).toEqual([]);
  });

  test("F1 NZBGet answering without it (its history cleared), no mount to ask: the release's size is the measure, never none", async () => {
    const name = "History.Cleared-GRP";
    rmdeps.roots = () => finishedRoot();
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 4_000 });
    S.items = S.items.filter(i => i.name !== name);
    forgetSnapshots();
    land(join(A, "ahoy", name, "part01.rar"), 1_000);
    await passes(15);
    expect(arrival(fid).want).toBe(0);
    expect(fetchRow(fid).state).toBe("arriving");
  });

  test("F1 an import that began before all of it was here: more of it arriving while it is read is the arrival's, never the copy's", async () => {
    const name = "Taken.Early-GRP";
    rmdeps.roots = () => finishedRoot();
    const { fid, rid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 2_000 });
    const X = join(A, "ahoy", name);
    for (let i = 1; i <= 19; i++) land(join(X, `v.part${String(i).padStart(2, "0")}.rar`), 100);
    await passes(11);
    expect(fetchRow(fid).state).toBe("done");                    // 95 % and quiet, nothing to ask: taken
    await requestsTick();
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async (ctx: { input: string }) => {
      land(join(ctx.input, "v.part20.rar"), 100);                  // the sync brings the last volume while the import reads
      throw new Error("unrar failed on v.part01.rar (exit 10): Cannot find volume v.part20.rar");
    }) as never } }];
    await runJob(req(rid).job_id!);
    await requestsTick();
    expect(blocks(g.id)).toEqual([]);
    expect(req(rid).state).toBe("fetching");
    expect(fetchRow(fid).state).toBe("arriving");
    expect(S.grabs).toBe(1);
  });

  test("F7 a usenet file the cleanup takes before ludarr's first look: missed against what NZBGet's folder held — lost, downloaded again", async () => {
    const name = "Usenet.With.Crack-GRP";
    seed(name, "game.iso", 9_800); seed(name, "Crack/steam_api64.dll", 150);
    const { fid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 10_000 });
    await pass();                                                  // what NZBGet's folder holds, read through the mount
    expect(arrival(fid).nfiles).toBe(2);
    carry(name, "game.iso", 9_800);
    rmSync(join(onSeedbox(name), "Crack"), { recursive: true, force: true });   // carried, and taken by the hourly find before a look
    await passes(12);
    expect(fetchRow(fid).state).toBe("submitted");                // never imported without it: the same release again
    expect(S.adds.at(-1)?.key).toBe(`guid:${name}#2`);
    expect(blocks(g.id)).toEqual([]);
  });

  test("F3 a part file the sync writes deep in another download's tree still holds the quiet time", async () => {
    const name = "Deep.Part-GRP";
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 2_000 });
    land(join(A, "ahoy", name, "part1.rar"), 1_900);
    const deep = writing(join(A, "Other.Game-GRP", "Game", "Content", "Paks", "Data", "Assets", "Textures", "High", "Pack", "x.pak"), 500);
    for (let i = 0; i < 14; i++) { utimesSync(deep, new Date(S.now), new Date(S.now)); await pass(60); }
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrival(fid).words).toMatch(/the sync is copying other files/);
  });
});

describe("review: what another download left is never taken for this one (F2)", () => {
  test("F2 a torrent's own folder holding files it does not list (a fake of the same name before it): nothing taken or touched", async () => {
    const name = "Call.of.Duty.MW4-RUNE";
    land(join(A, name, "Setup.exe"), 300, 50); land(join(A, name, "rune-cod.iso"), 2_000, 50);
    const fake = mtime(join(A, name, "Setup.exe"));
    const { fid } = await finished({ name, files: [["Call.of.Duty.MW4-RUNE.part1.rar", 1_500]] });
    land(join(A, name, "Call.of.Duty.MW4-RUNE.part1.rar"), 1_500);
    await passes(3);
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrival(fid).trouble).toBe("ambiguous");
    expect(arrival(fid).troubleWords).toMatch(/Setup\.exe/);
    expect(mtime(join(A, name, "Setup.exe"))).toBe(fake);
  });

  test("F2 …nested under a folder of its name, with an unlisted file inside the inner folder", async () => {
    const name = "Call of Duty - MW4 [FitGirl Repack]";
    const C = join(A, name, name);
    land(join(C, "fg-optional-bonus-old.bin"), 700, 50);
    const { fid } = await finished({ name, files: [["fg-01.bin", 1_000], ["setup.exe", 200]] });
    land(join(C, "fg-01.bin"), 1_000); land(join(C, "setup.exe"), 200);
    await passes(3);
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrival(fid).troubleWords).toMatch(/fg-optional-bonus-old\.bin/);
  });

  test("F2 a usenet folder an earlier download of that name used: nothing of it is held, counted or taken", async () => {
    const name = "Call.of.Duty.MW4-RUNE";
    const X = join(A, "ahoy", name);
    const fake = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    land(join(X, "fake.iso"), 1_000);
    await passes(11);
    expect(fetchRow(fake.fid).state).toBe("done");
    db.query("UPDATE fetches SET state='failed' WHERE id=?").run(fake.fid);    // its import failed: given up
    await pass();
    expect(arrival(fake.fid).hold?.released).not.toBeNull();
    const real = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000, guid: "guid:the-real-post" });
    const before = mtime(join(X, "fake.iso"));
    await passes(12);
    expect(fetchRow(real.fid).state).toBe("arriving");
    expect(arrival(real.fid).trouble).toBe("ambiguous");
    expect(mtime(join(X, "fake.iso"))).toBe(before);
    expect(arrival(real.fid).hold).toBeNull();
  });
});

describe("review: when it counts as arrived, and the hold (F5, F6, F7, F8, F11, F12, F17)", () => {
  test("F5 a file written in place at its full size (its date still moving) is not taken until it stood still a minute", async () => {
    const name = "In.Place-GRP";
    const { fid } = await finished({ name, files: [[name, 2_000]], isDir: false });
    const p = join(A, name, name);
    land(p, 2_000, 0);
    for (let i = 0; i < 14; i++) { await pass(5); const t = new Date(S.now + 300); utimesSync(p, t, t); }
    expect(fetchRow(fid).state).toBe("arriving");
    await passes(4);
    expect(fetchRow(fid).state).toBe("done");
  });

  test("F6 files the cleanup takes after it was taken and before its import began: the import never runs on what is left — lost, nothing blocklisted", async () => {
    const name = "Taken.Then.Gone-GRP";
    const { fid, rid, g } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000], ["c.bin", 1_000]] });
    for (const n of ["a.bin", "b.bin", "c.bin"]) land(join(A, name, n), 1_000);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
    await requestsTick();
    unlinkSync(join(A, name, "b.bin"));
    S.inputs = [];
    await runJob(req(rid).job_id!);
    expect(S.inputs).toEqual([]);
    await requestsTick();
    await untilArriving(fid);
    expect(fetchRow(fid).state).toBe("arriving");
    expect(arrival(fid).lost).not.toBeNull();
    expect(blocks(g.id)).toEqual([]);
    expect(S.grabs).toBe(1);
  });

  test("F6 after a restart: a held file the cleanup took while ludarr was down — the queued import does not run on what is left", async () => {
    const name = "Down.During.Cleanup-GRP";
    const { fid, rid, g } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000); land(join(A, name, "b.bin"), 1_000);
    await passes(2);
    await requestsTick();
    expect(req(rid).state).toBe("processing");
    forgetArrivals();                                              // ludarr is down …
    S.now += 58 * 60_000;
    const t = new Date(S.now - 2 * 3600_000); utimesSync(join(A, name, "a.bin"), t, t);
    expect(cleanup()).toEqual([join(A, name, "a.bin")]);          // … and the cleanup takes one of its files
    await resumeArrivals();
    S.inputs = [];
    await runJob(req(rid).job_id!);
    expect(S.inputs).toEqual([]);
    await requestsTick();
    await untilArriving(fid);
    expect(arrival(fid).lost).not.toBeNull();
    expect(blocks(g.id)).toEqual([]);
  });

  test("F6 an import that went through while one of its files vanished (its hold broken) is never kept: lost, nothing blocklisted", async () => {
    const name = "Gone.While.Read-GRP";
    const { fid, rid, g } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000); land(join(A, name, "b.bin"), 1_000);
    await passes(2);
    await requestsTick();
    const ok = runner.importers;
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async (ctx: { input: string; staging: string }) => {
      unlinkSync(join(ctx.input, "b.bin"));                       // the cleanup takes one while it is read …
      return ((ok()[0].importer.run) as unknown as (c: unknown) => Promise<ImportResult>)(ctx);   // … and the importer copes without it
    }) as never } }];
    await runJob(req(rid).job_id!);
    await requestsTick();
    await untilArriving(fid);
    expect(req(rid).state).not.toBe("ready");
    expect(arrival(fid).lost).not.toBeNull();
    expect(blocks(g.id)).toEqual([]);
  });

  test("F8 a held file the sync copies again (the seedbox's date back on it) is held again within a minute", async () => {
    const name = "Recopied-GRP";
    await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000, 90);
    await pass();
    expect(age(join(A, name, "a.bin"))).toBeLessThan(1);
    land(join(A, name, "a.bin"), 1_000, 90);                      // an overlapping sync run renames its own copy over it
    await passes(1, 5);
    expect(age(join(A, name, "a.bin"))).toBeLessThan(2);
    expect(cleanup()).toEqual([]);
  });

  test("F11 a date the folder could not set (EIO) is not counted as held: tried again at the next look, and an error while it fails", async () => {
    const name = "Silent.EIO-GRP";
    const { fid } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    let failing = true;
    adeps.touch = async (p, at) => { if (failing && p.endsWith("a.bin")) throw Object.assign(new Error("EIO: i/o error, utime"), { code: "EIO" }); return utimes(p, at, at); };
    land(join(A, name, "a.bin"), 1_000, 90);
    await passes(1, 5);
    expect((arrival(fid).hold as { failed?: { code: string } | null } | null)?.failed?.code).toBe("EIO");
    expect((await arrivalsHealth(sec())).some(h => h.type === "error" && /could not set the dates/.test(h.message))).toBe(true);
    failing = false;
    await pass();
    expect(age(join(A, name, "a.bin"))).toBeLessThan(1);
    expect((arrival(fid).hold as { failed?: unknown } | null)?.failed ?? null).toBeNull();
  });

  test("F12 a change that lands while a look runs gets its own look (the wake is never swallowed)", async () => {
    await Bun.sleep(1_100);                                        // (the wake's once-a-second limit, from the tests before, out of the way)
    let wakeUp: ((name?: string | null) => void) | null = null;
    adeps.watch = (_dir, w) => { wakeUp = w as never; return { close() {} }; };
    watchSynced();
    const name = "Swallowed.Wake-GRP";
    await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    await pass();
    land(join(A, name, "a.bin"), 1_000, 90);
    let once = false;
    adeps.touch = async (p, at) => {
      await utimes(p, at, at);
      if (!once && p.endsWith("a.bin")) { once = true; land(join(A, name, "b.bin"), 1_000, 90); wakeUp!(null); await Bun.sleep(60); }
    };
    await pass();
    for (let i = 0; i < 40 && age(join(A, name, "b.bin")) > 60; i++) await Bun.sleep(10);
    expect(age(join(A, name, "b.bin"))).toBeLessThan(1);
  });

  test("F17 a file just landed beside a held usenet download (still the seedbox's date) is no 'dates not refreshed' warning", async () => {
    const name = "Held.Usenet-GRP";
    await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 2_000 });
    land(join(A, "ahoy", name, "a.rar"), 1_000, 90);
    await pass();
    land(join(A, "ahoy", name, "b.rar"), 1_000, 90);
    expect((await arrivalsHealth(sec())).filter(h => /not being refreshed/.test(h.message))).toEqual([]);
  });

  test("F7 the folder's change event holds a file the moment it lands, even while the looks are spaced out", async () => {
    let on: ((name?: string | null) => void) | null = null;
    adeps.watch = (_dir, w) => { on = w as never; return { close() {} }; };
    watchSynced();
    const name = "Event.Held-GRP";
    await finished({ name, files: [["a.bin", 800], ["b.bin", 800]] });
    await pass();
    land(join(A, name, "a.bin"), 800, 120);
    on!(join(name, "a.bin"));
    for (let i = 0; i < 30 && age(join(A, name, "a.bin")) > 1; i++) await Bun.sleep(5);
    land(join(A, name, "b.bin"), 800, 120);                      // the next one, within the second
    on!(join(name, "b.bin"));
    for (let i = 0; i < 30 && age(join(A, name, "b.bin")) > 1; i++) await Bun.sleep(5);
    expect(age(join(A, name, "a.bin"))).toBeLessThan(1);
    expect(age(join(A, name, "b.bin"))).toBeLessThan(1);
  });

  test("F7 looked at every second while anything is awaited; a task of a second runs every second", async () => {
    await finished({ name: "Every.Second-GRP", files: [["a.bin", 800]] });
    await pass();
    expect(arrivalsEverySec()).toBe(1);
    let runs = 0;
    registerTask({ name: "review-every-second", label: "review", intervalSec: 1, run: async () => { runs++; } });
    startScheduler();
    try { await Bun.sleep(3_400); } finally { stopScheduler(); }
    expect(runs).toBeGreaterThanOrEqual(3);
  }, 10_000);

  test("F7 a torrent file taken before ludarr saw it: lost once the rest is here and nothing of it is left on the seedbox's side", async () => {
    const name = "Torrent.Missed-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 100]], path: `${FROM}/${name}` });
    mkdirSync(join(MOUNT, "complete", name), { recursive: true });   // the sync's move leaves its client's folder there, emptied
    await probeRoot(MOUNT);
    land(join(A, name, "a.bin"), 1_000, 90);
    await passes(3);
    expect(arrival(fid).lost?.why).toMatch(/b\.bin/);
    expect((await queueItem(rid)).waiting?.ask?.why).toBe("lost");
  });

  test("F7 …while that file is still on the seedbox's side, it is only on its way", async () => {
    const name = "Torrent.Coming-GRP";
    const { fid } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 100]], path: `${FROM}/${name}` });
    mkdirSync(join(MOUNT, "complete", name), { recursive: true }); writeFileSync(join(MOUNT, "complete", name, "b.bin"), new Uint8Array(100));
    await probeRoot(MOUNT);
    land(join(A, name, "a.bin"), 1_000, 90);
    await passes(5);
    expect(arrival(fid).lost).toBeNull();
    expect(fetchRow(fid).state).toBe("arriving");
  });
});

describe("review: ludarr against itself, and the bounds (F9, F10, F13, F26, F29)", () => {
  test("F9 the admin's answer while a pass awaits the folder is never written over by that pass", async () => {
    await finished({ name: "Slow.Refresh-GRP", files: [["a.bin", 1_000], ["z.bin", 1_000]] });
    const two = await finished({ name: "Admin.Choice-GRP", files: [["x.bin", 1_000], ["y.bin", 1_000]] });
    land(join(A, "Slow.Refresh-GRP", "a.bin"), 1_000, 90);
    land(join(A, "Admin.Choice-GRP", "x.bin"), 1_000, 90);
    await pass();
    let entered!: () => void; const reached = new Promise<void>(r => { entered = r; });
    let open!: () => void; const gate = new Promise<void>(r => { open = r; });
    adeps.touch = async (p, at) => { if (p.includes("Slow.Refresh-GRP")) { entered(); await gate; } return utimes(p, at, at); };
    S.now += 10 * 60_000 + 5_000;
    const tick = arrivalsTick();
    await reached;
    await chooseArrival(two.fid, "seedbox");
    open(); await tick;
    expect(arrival(two.fid).via).toBe("seedbox");
    await fetchTick();
    expect(S.pulls).toEqual([`${HOME}/Admin.Choice-GRP`]);
  });

  test("F10 its download client deleted mid-arrival: its files are let go, the health list says why, and 72 h on it stops", async () => {
    const name = "Orphan-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000, 90);
    await pass();
    adeps.clientById = () => null;
    await pass();
    expect(arrival(fid).hold?.released).not.toBeNull();
    expect((await arrivalsHealth(sec())).find(h => h.message.includes(name))?.message).toMatch(/download client was deleted/);
    S.now += 72 * 3600_000; await pass();
    expect(arrival(fid).stopped).toBe(true);
    await requestsTick();
    expect(req(rid).state).toBe("failed");
  });

  test("F13 the arrival's clock starts when the client finished it, not when ludarr noticed", async () => {
    const name = "Finished.While.Down-GRP";
    const { fid } = await finished({ name, files: [["a.bin", 1_000]], finishedAgoMin: 120 });
    const fin = sec() - 120 * 60;
    await pass();
    expect(arrival(fid).since).toBe(fin);
    const at = new Date(fin * 1000);
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    expect((await arrivalsHealth(sec())).find(h => h.message.includes(name))?.message).toContain(hhmm);
  });

  test("F26 a lost usenet download whose download again cannot be sent: tried on the ladder with its NZB kept, asked after 6 h", async () => {
    const name = "Regrab.Loop-GRP";
    let payloads = 0;
    adeps.payload = async () => { payloads++; return { kind: "nzb", bytes: new Uint8Array([60]), filename: "again.nzb" }; };
    const add = client.add;
    client.add = async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.2:6789"), { code: "ECONNREFUSED" }); };
    try {
      const { fid, rid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
      land(join(A, "ahoy", name, "a.bin"), 1_000);
      await pass();
      rmSync(join(A, "ahoy", name), { recursive: true, force: true });
      await pass();
      expect(arrival(fid).lost).not.toBeNull();
      await passes(7 * 60);
      const a = arrival(fid) as ReturnType<typeof arrival> & { tries?: number };
      expect(payloads).toBe(1);
      expect(a.tries ?? 99).toBeLessThan(15);
      expect(a.ask?.why).toBe("lost");
      expect((await arrivalsHealth(sec())).find(h => h.message.includes(name))?.type).toBe("error");
      expect((await queueItem(rid)).waiting?.ask?.choices).toEqual(["again", "wait"]);
    } finally { client.add = add; }
  });

  test("F29 a download held for a day while its search waits for the AI importer is said in the health list", async () => {
    const name = "Needs.AI-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000);
    await passes(2);
    expect(fetchRow(fid).state).toBe("done");
    runner.importers = noRecipe;
    await requestsTick();
    await runJob(req(rid).job_id!);
    await requestsTick();
    expect(req(rid).state).toBe("processing");
    for (let h = 0; h < 25; h++) { S.now += 3600_000; await pass(); }
    expect((await arrivalsHealth(sec())).find(x => x.message.includes(name))?.message).toMatch(/kept in the finished-downloads folder/);
  });
});

describe("review: the Queue's question and its words (F14, F15, F16, F18, F19, F21, F22)", () => {
  test("F14 a usenet download whole but under 90 % in the finished-downloads folder: the Queue offers to import what arrived, never the seedbox", async () => {
    const name = "Under.Ninety-GRP";
    const { fid, rid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 10_000 });
    land(join(A, "ahoy", name, "game.iso"), 5_000);
    await pass();
    S.now += 6 * 3600_000; await pass();
    const q = await queueItem(rid);
    expect(q.waiting?.ask?.why).toBe("late");
    expect(q.waiting?.ask?.choices).toEqual(["now", "wait", "again"]);
    expect((await answer(fid, "seedbox")).status).toBe(409);
    expect((await answer(fid, "now")).status).toBe(200);
    expect(fetchRow(fid).state).toBe("done");
    expect((await imported(rid)).state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(join(A, "ahoy", name));
    expect(blocks(g.id)).toEqual([]);
  });

  test("F14 'import from the seedbox' that finds nothing there (the sync carried it): back to the finished-downloads folder, nothing blocklisted", async () => {
    const name = "Carried.Away-GRP";
    const { fid, rid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    seed(name, "a.bin", 1_000);
    S.now += 6 * 3600_000; await pass();
    expect((await queueItem(rid)).waiting?.ask?.choices).toContain("seedbox");
    const pull = client.pull;
    client.pull = (item: { path: string }) => {
      S.pulls.push(item.path);
      const local = onMount(item.path) ?? item.path;
      return { localPath: local, waits: true, progress: () => 0, bytes: () => 0, cancel() {}, done: Promise.resolve({ ok: false, localPath: local, bytes: 0, error: `${local} never appeared under the mapped folder — is the mount up?` }) } as never;
    };
    try {
      expect((await answer(fid, "seedbox")).status).toBe(200);
      rmSync(onSeedbox(name), { recursive: true, force: true });  // the sync moved it meanwhile
      for (let i = 0; i < 8 && fetchRow(fid).state !== "arriving"; i++) { await fetchTick(); await Bun.sleep(20); S.now += 6 * 60_000; }
    } finally { client.pull = pull; }
    expect(fetchRow(fid).state).toBe("arriving");
    await requestsTick();
    expect(req(rid).state).toBe("fetching");
    expect(blocks(g.id)).toEqual([]);
    expect(S.grabs).toBe(1);
  });

  test("F15 'Download again' on a torrent fetches the download first: an indexer down erases nothing; a torrent its client lost is taken as removed", async () => {
    const name = "Again.Safely-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000]] });
    const hash = fetchRow(fid).client_id!;
    S.now += 6 * 3600_000; await pass();
    let down = true;
    adeps.payload = async () => { if (down) throw new Error("Prowlarr answered 503 Service Unavailable"); return { kind: "torrent", bytes: new Uint8Array([100]), filename: "x.torrent" } as never; };
    expect((await answer(fid, "again")).status).not.toBe(200);
    expect(S.removes).toEqual([]);
    expect(fetchRow(fid).client_id).toBe(hash);
    await pass();
    expect((await queueItem(rid)).waiting?.ask?.choices).toContain("seedbox");     // its seedbox copy is still there
    down = false;
    const remove = client.remove, add = client.add;
    let addFails = true;
    client.remove = async (ref, data) => { S.removes.push({ id: ref.clientId, data }); if (S.removes.length > 1) throw new Error("Could not find info-hash."); };
    client.add = async (p, o) => { if (addFails) throw new Error("rTorrent: load.raw_start failed"); return add(p, o); };
    try {
      expect((await answer(fid, "again")).status).not.toBe(200);   // erased, then the add failed
      expect(S.removes).toEqual([{ id: hash, data: true }]);
      await pass();
      expect((await queueItem(rid)).waiting?.ask?.choices).not.toContain("seedbox");   // nothing of it is left there
      await requestsTick();
      expect(req(rid).stage).not.toMatch(/still seeds/);
      addFails = false;
      expect((await answer(fid, "again")).status).toBe(200);
      expect(S.removes).toHaveLength(1);                          // never erased twice
      expect(fetchRow(fid).state).toBe("submitted");
      expect(S.adds.at(-1)?.key).toBe(`guid:${name}`);
    } finally { client.remove = remove; client.add = add; }
  });

  test("F15 …and a torrent its client no longer has: 'Could not find info-hash' on the erase is taken as erased", async () => {
    const name = "Already.Gone-GRP";
    const { fid } = await finished({ name, files: [["a.bin", 1_000]] });
    S.now += 6 * 3600_000; await pass();
    const remove = client.remove;
    client.remove = async (ref, data) => { S.removes.push({ id: ref.clientId, data }); throw new Error("Could not find info-hash."); };
    try {
      expect((await answer(fid, "again")).status).toBe(200);
      expect(fetchRow(fid).state).toBe("submitted");
    } finally { client.remove = remove; }
  });

  test("F16 'Keep waiting' on a question nothing answers by itself (two places named like it) puts it off for 6 h", async () => {
    const name = "Elsewhere2-GRP";
    const { fid, rid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    land(join(A, "ahoy", name, "a.iso"), 1_000); land(join(A, name, "a.iso"), 1_000);
    await pass();
    expect((await queueItem(rid)).waiting?.ask?.why).toBe("ambiguous");
    expect((await answer(fid, "wait")).status).toBe(200);
    await pass();
    expect((await queueItem(rid)).waiting?.ask ?? null).toBeNull();
    await requestsTick();
    expect(req(rid).stage).toMatch(/you chose to keep waiting/);
    expect((await arrivalsHealth(sec())).find(h => /Elsewhere2-GRP/.test(h.message))?.type).toBe("notice");
    S.now += 6 * 3600_000 + 60_000; await pass();
    expect((await queueItem(rid)).waiting?.ask?.why).toBe("ambiguous");
  });

  test("F18 a torrent its client cannot list yet: the health list says so, its exact-name folder is kept meanwhile, it is never called lost", async () => {
    const name = "Magnet.Only-GRP";
    const { fid } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    S.files.delete(fetchRow(fid).client_id!);
    db.query("UPDATE fetches SET files_json=NULL WHERE id=?").run(fid);
    land(join(A, name, "a.bin"), 1_000, 90); land(join(A, name, "b.bin"), 1_000, 90);
    await probeRoot(MOUNT);
    await passes(80);
    expect(arrival(fid).lost).toBeNull();
    expect(age(join(A, name, "a.bin"))).toBeLessThanOrEqual(11);
    expect(cleanup()).toEqual([]);
    expect((await arrivalsHealth(sec())).find(x => x.message.includes(name))?.message).toMatch(/has not listed the files/);
  });

  test("F19 without a remote path mapping, the seedbox is never offered or suggested", async () => {
    rmdeps.roots = () => finishedRoot();
    const { rid } = await finished({ name: "No.Mount-GRP", files: [["a.bin", 1_000]] });
    S.now += 6 * 3600_000; await pass();
    expect((await queueItem(rid)).waiting?.ask?.choices).toEqual(["wait", "again"]);
    await requestsTick();
    expect(req(rid).stage).not.toMatch(/from the seedbox/);
  });

  test("F21 an import from the finished-downloads folder that ends on a child program's I/O words is said of that folder", async () => {
    const name = "Io.Words-GRP";
    const { rid } = await finished({ name, files: [["a.rar", 1_000]] });
    land(join(A, name, "a.rar"), 1_000);
    await passes(2);
    await requestsTick();
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => { throw new Error("unrar: Unexpected end of archive"); }) as never } }];
    await runJob(req(rid).job_id!);
    await requestsTick();
    expect(req(rid).stage).toMatch(/finished-downloads folder/);
    expect(req(rid).stage).not.toMatch(/seedbox folder/);
  });

  test("F22 with the setting empty, a grab keeps no torrent file list (today's path as it was)", async () => {
    setFolder("");
    const { grab } = await import("../src/fetch");
    const torrent = (n: string) => new TextEncoder().encode(benc({ announce: "http://t", info: { name: n, "piece length": 16384, pieces: "", files: [{ length: 10, path: ["a.bin"] }] } }));
    fdeps.indexerById = () => ({ download: async (r: { title: string }) => ({ kind: "torrent", bytes: torrent(r.title), filename: "x.torrent" }) }) as never;
    const r = await grab(rv("No.List-GRP", "torrent") as never, null);
    expect(fetchRow(r.fetch.id).files_json ?? null).toBeNull();
    db.query("UPDATE fetches SET state='failed' WHERE id=?").run(r.fetch.id);
    setFolder(A);
    const r2 = await grab(rv("With.List-GRP", "torrent") as never, null);
    expect(JSON.parse(fetchRow(r2.fetch.id).files_json ?? "[]")).toEqual([{ p: "With.List-GRP/a.bin", s: 10 }]);
    db.query("UPDATE fetches SET state='failed' WHERE id=?").run(r2.fetch.id);
  });
});

/* ─────────── the review of the one setting (2026-11-09): each finding reproduced here first, then fixed ─────────── */

describe("review: the seedbox's side, and a remote path onto the finished-downloads folder (R3, R4, R5)", () => {
  test("R3 usenet nested as <folder>/<name>/<name>: NZBGet's folder is the inner one — taken whole once the sync is done, never lost or downloaded again", async () => {
    const name = "Nested.Usenet-RUNE";
    const { fid, rid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 2_000 });
    seed(name, "a.iso", 1_000); seed(name, "b.iso", 1_000);
    await pass(60);
    expect(arrival(fid).side?.left).toBe(2);                         // what NZBGet's folder holds, read through the mount
    rmSync(join(onSeedbox(name), "a.iso")); rmSync(join(onSeedbox(name), "b.iso"));          // the sync moved both …
    land(join(A, name, name, "a.iso"), 1_000); land(join(A, name, name, "b.iso"), 1_000);   // … nested in a folder of its name
    await pass(61); await pass(5);
    expect(arrival(fid).lost).toBeNull();
    expect(S.adds).toEqual([]);
    const f = fetchRow(fid);
    expect(f.state).toBe("done");
    expect(f.local_path).toBe(join(A, name));
    expect((await imported(rid)).state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(join(A, name));
    expect(blocks(g.id)).toEqual([]);
  });

  test("R3 …in the nested shape, a file still on the seedbox is on its way; one the sync carried and the cleanup took is lost", async () => {
    const name = "Nested.Part-RUNE";
    const { fid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 2_000 });
    seed(name, "a.iso", 1_000); seed(name, "b.iso", 1_000);
    await pass(60);
    rmSync(join(onSeedbox(name), "a.iso"));
    land(join(A, name, name, "a.iso"), 1_000);
    await pass(61);
    expect(arrival(fid).lost).toBeNull();
    expect(arrival(fid).words).toMatch(/still on the seedbox/);
    rmSync(join(onSeedbox(name), "b.iso"));                          // carried, and taken by the cleanup before a look
    await pass(61);
    expect(arrival(fid).lost?.why).toMatch(/b\.iso/);
  });

  test("R5 a whole torrent the sync carried and the cleanup took (its client's folders left emptied on the seedbox): lost after the cleanup's hour, asked at once", async () => {
    const name = "Whole.Carried-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000], ["Sub/b.bin", 1_000]], path: `${FROM}/${name}` });
    mkdirSync(join(MOUNT, "complete", name, "Sub"), { recursive: true });     // the move takes each file and leaves the folders
    await probeRoot(MOUNT);
    await passes(80);
    const a = arrival(fid);
    expect(a.lost?.why).toMatch(/nothing of it is left on the seedbox/);
    expect(a.ask?.why).toBe("lost");
    expect(S.adds).toEqual([]);                                      // a torrent is never downloaded again by itself
    expect((await queueItem(rid)).waiting?.ask?.why).toBe("lost");
  });

  test("R5 …a whole usenet download likewise (NZBGet's folder emptied): downloaded again by itself, nothing blocklisted", async () => {
    const name = "Whole.Usenet-RUNE";
    const { fid, g } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    mkdirSync(onSeedbox(name), { recursive: true });
    await probeRoot(MOUNT);
    await passes(80);
    expect(fetchRow(fid).state).toBe("submitted");
    expect(S.adds).toEqual([{ key: `guid:${name}#2`, title: name, protocol: "usenet" }]);
    expect(blocks(g.id)).toEqual([]);
    expect(S.grabs).toBe(1);
  });

  test("R5 …a single-file torrent still where its client keeps it (the file itself) is never called lost: late at 6 h, the seedbox offered", async () => {
    const name = "Single.Seeding.iso";
    const { fid, rid } = await finished({ name, files: [[name, 1_000]], isDir: false, path: `${FROM}/${name}` });
    mkdirSync(join(MOUNT, "complete"), { recursive: true }); writeFileSync(join(MOUNT, "complete", name), new Uint8Array(1_000));
    await probeRoot(MOUNT);
    await passes(80);
    expect(arrival(fid).lost).toBeNull();
    S.now += 6 * 3600_000; await pass();
    expect((await queueItem(rid)).waiting?.ask).toEqual({ why: "late", choices: ["seedbox", "wait", "again"] });
  });

  test("R4 a download client's remote path onto the finished-downloads folder (Radarr's way): left out while the folder is on, an error in the health list, taken by name, nothing there deleted", async () => {
    const put = (name: string, pathMap: string) =>
      (db.query("INSERT INTO plugin_instances (kind, impl, name, enabled, priority, settings_json, tags_json) VALUES ('downloadClient','nzbget',?,1,1,?,'[]') RETURNING id").get(name, JSON.stringify({ url: "https://box/nzbget", category: "ahoy", pathMap })) as { id: number }).id;
    const onto = put("NZBGet onto finished", `${FROM}=${A}`), into = put("NZBGet into ahoy", `${FROM}/ahoy=${join(A, "ahoy")}`), right = put("NZBGet mounted", `${HOME}=${MOUNT}`);
    const ours = [onto, into, right];
    const sg = { ...sgdeps };
    try {
      const mounts = () => saved.rm.roots().filter(m => m.kind !== "synced" && ours.includes(m.instanceId)).map(m => m.instanceId);
      expect(mounts()).toEqual([right]);                             // the folder on: only the seedbox's own folder is a mount
      expect(saved.rm.roots().filter(m => m.kind === "synced").map(m => m.to)).toEqual([A]);
      const said = async () => (await arrivalsHealth(sec())).filter(x => /^NZBGet (onto|into|mounted)/.test(x.message));
      const h = await said();
      expect(h.map(x => [x.type, x.message.split("'")[0], x.link])).toEqual([["error", "NZBGet onto finished", "/settings/downloadclients"], ["error", "NZBGet into ahoy", "/settings/downloadclients"]]);
      expect(h[0].message).toMatch(/points into the finished-downloads folder/);
      for (const x of h) {
        expect(x.message).not.toMatch(/synced|mapping/i);
        expect(x.message).not.toContain(A);
        expect(x.message).not.toContain(A.replace(/\\/g, "/"));
        expect(x.message).not.toContain(HOME);
      }
      setFolder("");                                                 // off: today's path, every mapping as it was
      expect(mounts()).toEqual([onto, into, right]);
      expect(await said()).toEqual([]);
      setFolder(A);
      // a usenet download through that client: its own folder is never read as "the seedbox's" — taken by its name and the quiet time
      rmdeps.roots = saved.rm.roots;
      const name = "Overlap.Usenet-RUNE";
      const { fid, rid } = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
      db.query("UPDATE fetches SET client_instance_id=? WHERE id=?").run(onto, fid);
      land(join(A, "ahoy", name, "a.iso"), 1_000);
      await passes(11);
      expect(arrival(fid).words).not.toMatch(/on the seedbox/);
      expect(fetchRow(fid).state).toBe("done");
      expect((await imported(rid)).state).toBe("ready");
      // its seeding cleanup: removed from NZBGet; nothing in the finished-downloads folder is deleted, whatever the remote path says
      const rm: string[] = [];
      sgdeps.clientById = id => (id === onto ? client : null);
      sgdeps.settingsOf = () => ({ pathMap: `${FROM}=${A}` });
      sgdeps.rm = async p => { rm.push(p); };
      expect(await seedingTick()).toBe(1);
      expect(rm).toEqual([]);
      expect(existsSync(join(A, "ahoy", name, "a.iso"))).toBe(true);
      expect(S.removes.at(-1)).toEqual({ id: fetchRow(fid).client_id!, data: true });
      expect(fetchRow(fid).cleaned_at).not.toBeNull();
    } finally {
      Object.assign(sgdeps, sg);
      for (const id of ours) db.query("DELETE FROM plugin_instances WHERE id=?").run(id);
    }
  });
});

/* ─────────── removed once imported (the admin's hourly cleanup is off: ludarr removes its own, as Radarr and Sonarr do) ─────────── */

/** what was taken, as fetches.took_json has it */
const taken = (fid: number) => JSON.parse(fetchRow(fid).took_json!) as Taken;
/** a download that arrived, was taken and imported: its search ready (nothing removed yet: the arrivals task has not looked) */
async function importedOne(o: Parameters<typeof finished>[0], put: [string, number][]) {
  const w = await finished(o);
  for (const [p, n] of put) land(p, n);
  await passes(o.protocol === "usenet" ? 11 : 2);
  expect(fetchRow(w.fid).state).toBe("done");
  expect((await imported(w.rid)).state).toBe("ready");
  return w;
}
/** …a usenet download in ahoy/, as it goes live with the seedbox mounted: NZBGet's folder read on the seedbox before anything of
 *  it came here (its whole list), the sync carrying each file (`put`: its path in NZBGet's folder, its size), taken, imported */
async function importedListed(o: { name: string; guid?: string }, put: [string, number][]) {
  for (const [rel, n] of put) seed(o.name, rel, n);
  const w = await finished({ name: o.name, protocol: "usenet", path: `${FROM}/ahoy/${o.name}`, downloaded: put.reduce((s, [, n]) => s + n, 0), ...(o.guid ? { guid: o.guid } : {}) });
  await pass();
  expect(arrival(w.fid).listAll).toBe(true);
  for (const [rel, n] of put) carry(o.name, rel, n);
  await passes(2);
  expect(fetchRow(w.fid).state).toBe("done");
  expect((await imported(w.rid)).state).toBe("ready");
  return w;
}
/** what is in the finished-downloads folder (paths inside it; a folder with a trailing slash) */
function tree(dir = A): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); walk(join(d, e.name), r); } else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}
/** its record of what it took rewritten (and the arrival's anchor with it, so it is followed) */
function craft(fid: number, t: Taken) {
  const a = arrival(fid);
  a.took = { at: t.at, how: t.how, path: t.path, files: t.files.length, bytes: t.files.reduce((s, x) => s + x[1], 0) };
  db.query("UPDATE fetches SET took_json=?, arrival_json=? WHERE id=?").run(JSON.stringify(t), JSON.stringify(a), fid);
}
const failing = (match: string, code: string) => async (p: string) => { if (p.includes(match)) throw Object.assign(new Error(`${code}: refused, unlink '${p}'`), { code }); return saved.a.unlink(p); };

describe("removed once imported: exactly what it took, then the folders that leaves empty inside its own folder", () => {
  test("the shapes — A/name, A/name/name, A/cat/name, a single file in A and in A/name/, usenet A/ahoy/name and A/name/name: each goes down to the folder it shares, which stays even empty", async () => {
    land(join(A, TV), 4_000, 50);
    land(join(A, "tv", "Show.S01E01.1080p-GRP", "ep.mkv"), 500, 50);
    const tvDate = mtime(join(A, TV));
    const N = "Nested Rm [FitGirl Repack]";
    // NZBGet's folders as the seedbox's mount shows them: read before anything of them came here (their whole lists)
    const onBox = (p: string, n: number) => { const q = join(MOUNT, "complete", ...p.split("/")); mkdirSync(dirname(q), { recursive: true }); writeFileSync(q, new Uint8Array(n).fill(5)); };
    onBox("ahoy/Usenet.Cat.Rm-RUNE/u.iso", 1_100); onBox("ahoy/Usenet.Cat.Rm-RUNE/u.nfo", 100); onBox("Usenet.Nest.Rm-RUNE/t.iso", 400);
    const plain = await finished({ name: "Plain.Rm-GRP", files: [["a.bin", 1_000], ["sub/b.bin", 500]] });
    const nested = await finished({ name: N, files: [["fg-01.bin", 900], ["setup.exe", 100]] });
    const cat = await finished({ name: "Category.Rm-GRP", files: [["c.bin", 800]] });
    const top = await finished({ name: "Top.File.Rm.iso", files: [["Top.File.Rm.iso", 700]], isDir: false });
    const own = await finished({ name: "Own.File.Rm.iso", files: [["Own.File.Rm.iso", 600]], isDir: false });
    const ua = await finished({ name: "Usenet.Cat.Rm-RUNE", protocol: "usenet", path: `${FROM}/ahoy/Usenet.Cat.Rm-RUNE`, downloaded: 1_200 });
    const ut = await finished({ name: "Usenet.Nest.Rm-RUNE", protocol: "usenet", path: `${FROM}/Usenet.Nest.Rm-RUNE`, downloaded: 400 });
    await pass();
    rmSync(join(MOUNT, "complete"), { recursive: true, force: true });               // the sync moves them here
    land(join(A, "Plain.Rm-GRP", "a.bin"), 1_000); land(join(A, "Plain.Rm-GRP", "sub", "b.bin"), 500);
    land(join(A, N, N, "fg-01.bin"), 900); land(join(A, N, N, "setup.exe"), 100);
    land(join(A, "cat", "Category.Rm-GRP", "c.bin"), 800);
    land(join(A, "Top.File.Rm.iso"), 700);
    land(join(A, "Own.File.Rm.iso", "Own.File.Rm.iso"), 600);
    land(join(A, "ahoy", "Usenet.Cat.Rm-RUNE", "u.iso"), 1_100); land(join(A, "ahoy", "Usenet.Cat.Rm-RUNE", "u.nfo"), 100);
    land(join(A, "Usenet.Nest.Rm-RUNE", "Usenet.Nest.Rm-RUNE", "t.iso"), 400);
    await passes(11);
    const all = [plain, nested, cat, top, own, ua, ut];
    for (const x of all) expect(fetchRow(x.fid).state).toBe("done");
    // what it took, file by file, and the folder that is all its own (none for a single file straight in the folder)
    expect(taken(plain.fid)).toMatchObject({ how: "arrived", path: join(A, "Plain.Rm-GRP"), own: join(A, "Plain.Rm-GRP"), files: [["a.bin", 1_000], ["sub/b.bin", 500]] });
    expect(taken(nested.fid)).toMatchObject({ path: join(A, N, N), own: join(A, N) });
    expect(taken(cat.fid)).toMatchObject({ path: join(A, "cat", "Category.Rm-GRP"), own: join(A, "cat", "Category.Rm-GRP") });
    expect(taken(top.fid)).toMatchObject({ path: join(A, "Top.File.Rm.iso"), own: null, files: [["", 700]] });
    expect(taken(own.fid)).toMatchObject({ path: join(A, "Own.File.Rm.iso", "Own.File.Rm.iso"), own: join(A, "Own.File.Rm.iso"), files: [["", 600]] });
    expect(taken(ua.fid)).toMatchObject({ path: join(A, "ahoy", "Usenet.Cat.Rm-RUNE"), own: join(A, "ahoy", "Usenet.Cat.Rm-RUNE"), files: [["u.iso", 1_100], ["u.nfo", 100]] });
    expect(taken(ut.fid)).toMatchObject({ path: join(A, "Usenet.Nest.Rm-RUNE"), own: join(A, "Usenet.Nest.Rm-RUNE"), files: [["Usenet.Nest.Rm-RUNE/t.iso", 400]] });
    for (const x of all) expect((await imported(x.rid)).state).toBe("ready");
    expect(tree()).toContain("ahoy/Usenet.Cat.Rm-RUNE/u.iso");      // nothing goes before the arrivals task looks
    await pass();
    for (const x of all) expect(arrival(x.fid).rm?.state).toBe("done");
    // the folder itself, a category's (ahoy/, cat/: empty now) and the folders others' things sit in stay; TV untouched
    expect(tree()).toEqual([TV, "ahoy/", "cat/", "tv/", "tv/Show.S01E01.1080p-GRP/", "tv/Show.S01E01.1080p-GRP/ep.mkv"]);
    expect(mtime(join(A, TV))).toBe(tvDate);
    expect(historyOf(ua.g.id, "removed")).toEqual(["removed from the finished-downloads folder after its import (2 files, 0.0 GB)"]);
  });

  test("a file put in its folder after it was taken stays, and keeps that folder and the ones above it inside its own", async () => {
    const name = "Stranger.Rm-GRP";
    const { g, fid } = await importedOne({ name, files: [["a.bin", 1_000], ["data/c.bin", 500], ["data/d.bin", 300]] },
      [[join(A, name, "a.bin"), 1_000], [join(A, name, "data", "c.bin"), 500], [join(A, name, "data", "d.bin"), 300]]);
    land(join(A, name, "data", "notes.txt"), 10);                     // not part of it: someone put it there since
    await pass();
    expect(tree()).toEqual([`${name}/`, `${name}/data/`, `${name}/data/notes.txt`]);
    expect(arrival(fid).rm).toMatchObject({ state: "done", removed: 3, kept: 2, changed: 0 });
    expect(historyOf(g.id, "removed")).toEqual(["removed from the finished-downloads folder after its import (3 files, 0.0 GB); its folder stays: something else is still in it (Stranger.Rm-GRP/data/notes.txt)"]);
  });

  test("Keep downloads after import on: nothing of it goes, and the history says why (the setting covers this folder too)", async () => {
    const name = "Kept.Rm-GRP", was = process.env.IMPORT_KEEP_DOWNLOAD;
    process.env.IMPORT_KEEP_DOWNLOAD = "1";
    try {
      const { g, fid } = await importedOne({ name, files: [["a.bin", 1_000], ["b.bin", 500]] }, [[join(A, name, "a.bin"), 1_000], [join(A, name, "b.bin"), 500]]);
      await pass();
      expect(tree()).toEqual([`${name}/`, `${name}/a.bin`, `${name}/b.bin`]);
      expect(arrival(fid).rm).toMatchObject({ state: "left", why: "Keep downloads after import is on" });
      expect(historyOf(g.id, "left")).toEqual(["left in the finished-downloads folder (Keep downloads after import is on): ludarr deletes nothing of it there"]);
      expect(historyOf(g.id, "removed")).toEqual([]);
    } finally { if (was === undefined) delete process.env.IMPORT_KEEP_DOWNLOAD; else process.env.IMPORT_KEEP_DOWNLOAD = was; }
  });

  test("a file whose size changed since it was taken stays (and its folder); the rest goes", async () => {
    const name = "Changed.Rm-GRP";
    const { g, fid } = await importedOne({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] }, [[join(A, name, "a.bin"), 1_000], [join(A, name, "b.bin"), 1_000]]);
    writeFileSync(join(A, name, "b.bin"), new Uint8Array(1_234));     // written over at another size after its import
    await pass();
    expect(tree()).toEqual([`${name}/`, `${name}/b.bin`]);
    expect(arrival(fid).rm).toMatchObject({ state: "done", removed: 1, changed: 1, kept: 1 });
    expect(historyOf(g.id, "removed")).toEqual(["removed from the finished-downloads folder after its import (1 file, 0.0 GB); 1 file changed since it was taken and stays (Changed.Rm-GRP/b.bin); its folder stays: something else is still in it"]);
  });

  test("never the finished-downloads folder, a category's or a folder it shares: a record that reaches outside its place is not followed", async () => {
    land(join(A, TV), 4_000, 50);
    // its own folder written down as the finished-downloads folder itself: nothing of it is touched, it is left
    const one = await importedOne({ name: "Crafted.Root-GRP", files: [["a.bin", 1_000]] }, [[join(A, "Crafted.Root-GRP", "a.bin"), 1_000]]);
    craft(one.fid, { ...taken(one.fid), own: resolve(A) });
    // a file of it written down as a path out of its folder (the TV file beside it): that entry is never followed
    const two = await importedOne({ name: "Crafted.Out-GRP", files: [["a.bin", 1_000]] }, [[join(A, "Crafted.Out-GRP", "a.bin"), 1_000]]);
    craft(two.fid, { ...taken(two.fid), files: [["a.bin", 1_000], [`../${TV}`, 4_000]] });
    // in a category's folder, the category's folder written down as its own: not followed either
    const three = await importedListed({ name: "Crafted.Cat-RUNE" }, [["x.iso", 900]]);
    craft(three.fid, { ...taken(three.fid), own: resolve(A, "ahoy") });
    // its place written down as the finished-downloads folder itself
    const four = await importedOne({ name: "Crafted.Place-GRP", files: [["a.bin", 1_000]] }, [[join(A, "Crafted.Place-GRP", "a.bin"), 1_000]]);
    craft(four.fid, { ...taken(four.fid), path: resolve(A), own: null, files: [["Crafted.Place-GRP/a.bin", 1_000]] });
    await pass();
    expect(arrival(one.fid).rm).toMatchObject({ state: "left", why: "what it took does not lie inside the finished-downloads folder" });
    expect(historyOf(one.g.id, "left")).toEqual(["left in the finished-downloads folder (what it took does not lie inside the finished-downloads folder): ludarr deletes nothing of it there"]);
    expect(arrival(two.fid).rm).toMatchObject({ state: "done", removed: 1, changed: 1 });
    expect(arrival(three.fid).rm).toMatchObject({ state: "left", why: "its own folder is written down as a folder it only sits in" });
    expect(arrival(four.fid).rm).toMatchObject({ state: "left", why: "what it took does not lie inside the finished-downloads folder" });
    expect(tree()).toEqual([TV, "Crafted.Place-GRP/", "Crafted.Place-GRP/a.bin", "Crafted.Root-GRP/", "Crafted.Root-GRP/a.bin", "ahoy/", "ahoy/Crafted.Cat-RUNE/", "ahoy/Crafted.Cat-RUNE/x.iso"].sort());
    expect(existsSync(A)).toBe(true);
  });

  test("nothing goes when its import failed or was cancelled, or the game's copy does not check out: left, said once", async () => {
    const ok = runner.importers;
    // its import fails (no recipe opens it, no AI importer): the search moves on, the download is left
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "unknown", reason: "no recipe opens it" })) as never } }];
    const bad = await finished({ name: "Failed.Import.Rm-GRP", files: [["a.bin", 1_000]] });
    land(join(A, "Failed.Import.Rm-GRP", "a.bin"), 1_000);
    await passes(2);
    await requestsTick();
    await runJob(req(bad.rid).job_id!);
    await requestsTick();
    expect((db.query("SELECT state FROM jobs WHERE fetch_id=? ORDER BY id DESC LIMIT 1").get(bad.fid) as { state: string }).state).toBe("failed");
    expect(req(bad.rid).fetch_id).not.toBe(bad.fid);                                           // its search moved on
    runner.importers = ok;
    // cancelled before it ran
    const stop = await finished({ name: "Cancelled.Rm-GRP", files: [["a.bin", 1_000]] });
    land(join(A, "Cancelled.Rm-GRP", "a.bin"), 1_000);
    await passes(2);
    await requestsTick();
    expect(cancelJob(req(stop.rid).job_id!)).toBe(true);
    await requestsTick();
    expect(req(stop.rid).state).toBe("cancelled");
    // imported, then a file of the game's copy in the library goes missing before the removal looks
    const broken = await importedOne({ name: "Broken.Copy.Rm-GRP", files: [["a.bin", 1_000]] }, [[join(A, "Broken.Copy.Rm-GRP", "a.bin"), 1_000]]);
    const pkg = stmts.packageForGame.get(broken.g.id) as { path: string };
    rmSync(join(pkg.path, "Arrival Quest (USA).z64"));
    await passes(3);
    expect(arrival(bad.fid).rm).toMatchObject({ state: "left", why: "its import did not go through" });
    expect(arrival(stop.fid).rm).toMatchObject({ state: "left", why: "its import was cancelled" });
    expect(arrival(broken.fid).rm).toMatchObject({ state: "left", why: "the game's copy in the library is not all there" });
    for (const n of ["Failed.Import.Rm-GRP", "Cancelled.Rm-GRP", "Broken.Copy.Rm-GRP"]) expect(existsSync(join(A, n, "a.bin"))).toBe(true);
    await passes(5);
    for (const x of [bad, stop, broken]) { expect(historyOf(x.g.id, "left")).toHaveLength(1); expect(historyOf(x.g.id, "removed")).toEqual([]); expect(arrival(x.fid).hold?.released).not.toBeNull(); }
    expect(historyOf(stop.g.id, "left")[0]).toBe("left in the finished-downloads folder (its import was cancelled): ludarr deletes nothing of it there");
  });

  test("nothing goes while its import is cut short or still being tried: lost back to arriving; the AI importer's wait, a day long", async () => {
    // a file vanishes while it is read: the import is not kept, the download is awaited again — nothing of it removed
    const cut = await finished({ name: "Cut.Short.Rm-GRP", files: [["a.bin", 1_000], ["b.bin", 1_000]] });
    land(join(A, "Cut.Short.Rm-GRP", "a.bin"), 1_000); land(join(A, "Cut.Short.Rm-GRP", "b.bin"), 1_000);
    await passes(2);
    await requestsTick();
    const ok = runner.importers;
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async (ctx: { input: string; staging: string }) => {
      unlinkSync(join(ctx.input, "b.bin"));
      return ((ok()[0].importer.run) as unknown as (c: unknown) => Promise<ImportResult>)(ctx);
    }) as never } }];
    await runJob(req(cut.rid).job_id!);
    await requestsTick();
    await untilArriving(cut.fid);
    runner.importers = ok;
    await passes(3);
    expect(fetchRow(cut.fid).state).toBe("arriving");
    expect(arrival(cut.fid).took).toBeNull();
    expect(existsSync(join(A, "Cut.Short.Rm-GRP", "a.bin"))).toBe(true);
    // the recipes give up and the AI importer has no key: the search waits, held, a day on — nothing removed
    const wait = await finished({ name: "Waits.For.AI.Rm-GRP", files: [["a.bin", 1_000]] });
    land(join(A, "Waits.For.AI.Rm-GRP", "a.bin"), 1_000);
    await passes(2);
    runner.importers = noRecipe;
    await requestsTick();
    await runJob(req(wait.rid).job_id!);
    await requestsTick();
    expect(req(wait.rid).state).toBe("processing");
    for (let h = 0; h < 25; h++) { S.now += 3600_000; await pass(); }
    expect(existsSync(join(A, "Waits.For.AI.Rm-GRP", "a.bin"))).toBe(true);
    expect(arrival(wait.fid).rm).toBeNull();
    expect(arrival(wait.fid).hold?.released).toBeNull();
  });

  test("it waits while another job reads it — an import by hand of its folder, a carry run's look at it — then goes", async () => {
    const name = "Read.Again.Rm-GRP";
    const { g, fid } = await importedOne({ name, files: [["a.bin", 1_000]] }, [[join(A, name, "a.bin"), 1_000]]);
    const hand = stmts.insertJob.get(null, null, g.id, join(A, name)) as JobRow;              // POST /import { path }
    await passes(3);
    expect(existsSync(join(A, name, "a.bin"))).toBe(true);
    expect(arrival(fid).rm).toMatchObject({ state: "waiting", why: "a job still reads it" });
    expect(arrival(fid).hold?.released).toBeNull();                                            // still held: dates refreshed
    expect(age(join(A, name, "a.bin"))).toBeLessThan(11);
    cancelJob(hand.id);
    const carry = stmts.insertJobOf.get(null, null, g.id, join(A, name), "content", JSON.stringify({ kind: "content", gameId: g.id, wayId: 1, path: join(A, name), fetchId: fid, earlier: true }), null) as JobRow;
    await passes(2);
    expect(existsSync(join(A, name, "a.bin"))).toBe(true);
    expect(arrival(fid).rm?.state).toBe("waiting");
    cancelJob(carry.id);
    await passes(2);
    expect(existsSync(join(A, name))).toBe(false);
    expect(arrival(fid).rm?.state).toBe("done");
    expect(historyOf(g.id, "removed")).toHaveLength(1);
  });

  test("it waits while another download of ludarr's of that name is awaited there, and goes once that one is imported too", async () => {
    const name = "Twice.Fetched-RUNE";
    const one = await importedListed({ name }, [["x.iso", 800]]);
    // the same name awaited again (another post of the release) before the first was removed
    const two = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 800, guid: "guid:another-post" });
    await pass();
    expect(arrival(one.fid).rm).toMatchObject({ state: "waiting" });
    expect(arrival(one.fid).rm?.why).toMatch(/another download of ludarr's/);
    expect(existsSync(join(A, "ahoy", name, "x.iso"))).toBe(true);
    db.query("UPDATE fetches SET state='failed' WHERE id=?").run(two.fid);                     // (given up)
    await passes(2);
    expect(arrival(one.fid).rm?.state).toBe("done");
    expect(existsSync(join(A, "ahoy", name))).toBe(false);
  });

  test("a delete that fails is tried again on the ladder; a restart carries on where it was; the hold stays on until it is done", async () => {
    const name = "Busy.Rm-GRP";
    const { g, fid } = await importedOne({ name, files: [["a.bin", 1_000], ["b.bin", 1_000], ["c.bin", 1_000]] },
      [[join(A, name, "a.bin"), 1_000], [join(A, name, "b.bin"), 1_000], [join(A, name, "c.bin"), 1_000]]);
    adeps.unlink = failing("b.bin", "EBUSY");                                                   // held open at the first try
    await pass();
    expect(tree()).toEqual([`${name}/`, `${name}/b.bin`]);
    expect(arrival(fid).rm).toMatchObject({ state: "due", tries: 1, code: "EBUSY", removed: 2 });
    expect(arrival(fid).hold?.released).toBeNull();
    expect(historyOf(g.id, "removed")).toEqual([]);
    // ludarr restarts: what it kept in memory is gone — the removal is the arrival's own state
    forgetArrivals();
    adeps.unlink = saved.a.unlink;
    await resumeArrivals();
    expect(age(join(A, name, "b.bin"))).toBeLessThan(1);                                        // held: refreshed at boot
    expect(existsSync(join(A, name, "b.bin"))).toBe(true);                                      // not before its minute
    await pass(61);
    expect(existsSync(join(A, name))).toBe(false);
    expect(arrival(fid).rm).toMatchObject({ state: "done", removed: 3, tries: 1 });
    expect(arrival(fid).hold?.gone).toBe(0);                                                    // its own removal is no "files deleted while held"
    expect(historyOf(g.id, "removed")).toEqual(["removed from the finished-downloads folder after its import (3 files, 0.0 GB)"]);
    await passes(3);
    expect(historyOf(g.id, "removed")).toHaveLength(1);
  });

  test("files already gone when ludarr removed none (deleted, then a crash before that was written down) are looked at once more, then it is done", async () => {
    const name = "Crash.Rm-GRP";
    const { g, fid } = await importedOne({ name, files: [["a.bin", 1_000], ["b.bin", 1_000]] }, [[join(A, name, "a.bin"), 1_000], [join(A, name, "b.bin"), 1_000]]);
    rmSync(join(A, name), { recursive: true, force: true });
    forgetArrivals();
    await pass();
    expect(arrival(fid).rm).toMatchObject({ state: "due", removed: 0, gone: 2, tries: 0 });
    expect(arrival(fid).rm?.confirm).not.toBeNull();
    await pass(61);
    expect(arrival(fid).rm?.state).toBe("done");
    expect(historyOf(g.id, "removed")).toEqual(["nothing of it was left to remove from the finished-downloads folder after its import: its 2 files were already gone"]);
  });

  test("a delete that keeps failing (EACCES) is tried at 1, 2, 5 min …, said in the health list without a path, and holds up no other download", async () => {
    const one = await finished({ name: "Denied.Rm-GRP", files: [["a.bin", 1_000]] });
    const two = await finished({ name: "Other.Rm-GRP", files: [["x.bin", 500]] });
    land(join(A, "Denied.Rm-GRP", "a.bin"), 1_000); land(join(A, "Other.Rm-GRP", "x.bin"), 500);
    await passes(2);
    expect((await imported(one.rid)).state).toBe("ready");
    expect((await imported(two.rid)).state).toBe("ready");
    adeps.unlink = failing("Denied.Rm-GRP", "EACCES");
    await pass();
    expect(arrival(one.fid).rm).toMatchObject({ state: "due", tries: 1, code: "EACCES" });
    expect(existsSync(join(A, "Other.Rm-GRP"))).toBe(false);                                   // the other goes all the same
    expect(arrival(two.fid).rm?.state).toBe("done");
    expect((await arrivalsHealth(sec())).some(h => h.message.includes("Denied.Rm-GRP"))).toBe(false);   // once is nothing to say
    const tries: number[] = [];
    for (let i = 0; i < 9; i++) { await pass(60); tries.push(arrival(one.fid).rm!.tries); }
    expect(tries).toEqual([2, 2, 3, 3, 3, 3, 3, 4, 4]);
    expect(REMOVAL_WARN_TRIES).toBe(3);
    const h = (await arrivalsHealth(sec())).find(x => x.message.includes("Denied.Rm-GRP"));
    expect(h?.type).toBe("warning");
    expect(h?.message).toMatch(/^Denied\.Rm-GRP is imported, but ludarr could not delete its own download from the finished-downloads folder \(EACCES since \d\d:\d\d\): it keeps trying, and nothing else waits on it$/);
    for (const s of [h!.message]) { expect(s).not.toContain(A); expect(s).not.toContain(A.replace(/\\/g, "/")); expect(s).not.toContain("/arrivals"); expect(s).not.toMatch(/synced|mapping/i); }
    adeps.unlink = saved.a.unlink;
    S.now += 10 * 60_000; await pass();
    expect(existsSync(join(A, "Denied.Rm-GRP"))).toBe(false);
    expect((await arrivalsHealth(sec())).some(x => x.message.includes("Denied.Rm-GRP"))).toBe(false);
  });

  test("a folder Unraid still holds a deleted file in (.fuse_hidden) is tried again, and goes once that is let go", async () => {
    const name = "Fuse.Hidden.Rm-GRP";
    const { fid } = await importedOne({ name, files: [["a.bin", 1_000]] }, [[join(A, name, "a.bin"), 1_000]]);
    adeps.unlink = async p => { await saved.a.unlink(p); writeFileSync(join(dirname(p), ".fuse_hidden0000001a00000001"), "x"); };
    await pass();
    expect(arrival(fid).rm).toMatchObject({ state: "due", tries: 1, code: "EBUSY", removed: 1 });
    adeps.unlink = saved.a.unlink;
    unlinkSync(join(A, name, ".fuse_hidden0000001a00000001"));                                  // the last handle closed
    await pass(61);
    expect(existsSync(join(A, name))).toBe(false);
    expect(arrival(fid).rm).toMatchObject({ state: "done", removed: 1, kept: 0 });
  });

  test("never through a link: a folder of it that became a link to elsewhere keeps what it points at, and stays", async () => {
    const name = "Linked.Folder.Rm-GRP";
    const { fid } = await importedOne({ name, files: [["a.bin", 1_000], ["data/x.bin", 500]] }, [[join(A, name, "a.bin"), 1_000], [join(A, name, "data", "x.bin"), 500]]);
    const out = join(tmp, "elsewhere");
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, "x.bin"), new Uint8Array(500));     // the same name, the same size
    rmSync(join(A, name, "data"), { recursive: true, force: true });
    symlinkSync(out, join(A, name, "data"), "junction");                                         // (a junction: no privilege needed on Windows)
    await pass();
    expect(existsSync(join(out, "x.bin"))).toBe(true);
    expect(existsSync(join(A, name, "a.bin"))).toBe(false);
    expect(arrival(fid).rm).toMatchObject({ state: "done", removed: 1, changed: 1 });
    expect(existsSync(join(A, name))).toBe(true);                                               // (the link in it keeps it)
    rmSync(out, { recursive: true, force: true });
  });

  test("the game's copy linking into the finished-downloads folder (its folder, or a file of it, a link to there): nothing goes", async () => {
    // its folder a link into the finished-downloads folder
    const one = await importedOne({ name: "Copy.Links.Here-GRP", files: [["a.bin", 1_000]] }, [[join(A, "Copy.Links.Here-GRP", "a.bin"), 1_000]]);
    const pkg = stmts.packageForGame.get(one.g.id) as { path: string };
    renameSync(pkg.path, join(A, "Copy.Links.Here-GRP", "copy"));
    symlinkSync(join(A, "Copy.Links.Here-GRP", "copy"), pkg.path, "junction");
    await pass();
    expect(arrival(one.fid).rm).toMatchObject({ state: "left", why: "the game's copy in the library links into the finished-downloads folder" });
    expect(existsSync(join(A, "Copy.Links.Here-GRP", "a.bin"))).toBe(true);
    rmSync(pkg.path, { force: true, recursive: false });
    // a file of it a link to a file there (where the system lets a file be linked without a privilege)
    const two = await importedOne({ name: "File.Links.Here-GRP", files: [["a.bin", 1_000]] }, [[join(A, "File.Links.Here-GRP", "a.bin"), 1_000]]);
    const dump = join((stmts.packageForGame.get(two.g.id) as { path: string }).path, "Arrival Quest (USA).z64");
    writeFileSync(join(A, "File.Links.Here-GRP", "dump.z64"), new Uint8Array(statSync(dump).size));
    rmSync(dump);
    try { symlinkSync(join(A, "File.Links.Here-GRP", "dump.z64"), dump, "file"); }
    catch { return; }                                                                            // (Windows without the privilege: the folder case above stands)
    await pass();
    expect(arrival(two.fid).rm).toMatchObject({ state: "left", why: "the game's copy in the library links into the finished-downloads folder" });
    expect(existsSync(join(A, "File.Links.Here-GRP", "a.bin"))).toBe(true);
  });

  test("a way's search: removed once the way's check proved the game file in it and its search ended with the way built; a file only kept for a look is left", async () => {
    const proven = await finished({ name: "Way.Proven-GRP", files: [["a.bin", 1_000]] });
    const kept = await finished({ name: "Way.Kept-GRP", files: [["a.bin", 1_000]] });
    land(join(A, "Way.Proven-GRP", "a.bin"), 1_000); land(join(A, "Way.Kept-GRP", "a.bin"), 1_000);
    await passes(2);
    for (const x of [proven, kept]) expect((await imported(x.rid)).state).toBe("ready");
    // the latest job its search ran on it: a way's check of the download (its content job), done, with its outcome
    const check = (x: { g: GameRow; fid: number; rid: number }, name: string, outcome: "proven" | "kept") => {
      const p = join(A, name);
      const j = stmts.insertJobOf.get(x.rid, x.fid, x.g.id, p, "content", JSON.stringify({ kind: "content", gameId: x.g.id, wayId: 1, path: p, fetchId: x.fid }), null) as JobRow;
      db.query("UPDATE jobs SET state='done', manifest_json=? WHERE id=?").run(JSON.stringify({ outcome, file: "a.bin" }), j.id);
    };
    check(proven, "Way.Proven-GRP", "proven");
    check(kept, "Way.Kept-GRP", "kept");
    await pass();
    expect(arrival(proven.fid).rm?.state).toBe("done");
    expect(existsSync(join(A, "Way.Proven-GRP"))).toBe(false);
    expect(arrival(kept.fid).rm).toMatchObject({ state: "left", why: "the way's check did not prove the game file in it" });
    expect(existsSync(join(A, "Way.Kept-GRP", "a.bin"))).toBe(true);
  });

  test("left, then used again (its search took it up again and imported it): looked at anew, and removed", async () => {
    const name = "Used.Again.Rm-GRP";
    const ok = runner.importers;
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "unknown", reason: "no recipe opens it" })) as never } }];
    const { g, fid, rid } = await finished({ name, files: [["a.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000);
    await passes(2);
    await requestsTick();
    await runJob(req(rid).job_id!);
    await requestsTick();
    await passes(2);
    expect(arrival(fid).rm?.state).toBe("left");
    runner.importers = ok;
    // a search of the game takes the same download up again (the same post grabbed again is that download)
    const again = createRequest({ gameId: g.id }).request.id;
    db.query("UPDATE requests SET state='fetching', fetch_id=?, stage='downloading' WHERE id=?").run(fid, again);
    await requestsTick();
    expect(req(again).state).toBe("processing");
    await pass();
    expect(arrival(fid).rm).toBeNull();                                                          // held again: looked at anew
    await runJob(req(again).job_id!);
    await requestsTick();
    expect(req(again).state).toBe("ready");
    await pass();
    expect(arrival(fid).rm?.state).toBe("done");
    expect(existsSync(join(A, name))).toBe(false);
  });

  test("its own removal is never a loss: not lost, not awaited again, not downloaded again, no error about files deleted while held", async () => {
    const name = "Never.Lost.Rm-RUNE";
    const { g, fid, rid } = await importedListed({ name }, [["a.iso", 1_000]]);
    await probeRoot(MOUNT);
    await pass();
    expect(existsSync(join(A, "ahoy", name))).toBe(false);
    await passes(90);
    expect(fetchRow(fid).state).toBe("done");
    expect(req(rid).state).toBe("ready");
    expect(arrival(fid).lost).toBeNull();
    expect(arrival(fid).hold?.gone).toBe(0);
    expect(S.adds).toEqual([]);
    expect(S.grabs).toBe(1);
    expect(historyOf(g.id, "downloadFailed")).toEqual([]);
    expect((await arrivalsHealth(sec())).filter(h => h.message.includes(name))).toEqual([]);
  });

  test("a copy that reaches the folder after its import from the seedbox goes once it is exactly what its client listed, whole and unchanged a minute on", async () => {
    const name = "Late.Copy-GRP";
    const { g, fid, rid } = await finished({ name, files: [["a.bin", 1_000], ["b.bin", 500]], path: `${HOME}/${name}` });
    mkdirSync(join(MOUNT, name), { recursive: true });
    writeFileSync(join(MOUNT, name, "a.bin"), new Uint8Array(1_000)); writeFileSync(join(MOUNT, name, "b.bin"), new Uint8Array(500));
    await probeRoot(MOUNT);
    S.now += 6 * 3600_000; await pass();
    expect(arrival(fid).ask?.why).toBe("late");
    expect((await answer(fid, "seedbox")).status).toBe(200);
    await fetchTick();
    expect(fetchRow(fid).local_path).toBe(join(MOUNT, name));
    expect((await imported(rid)).state).toBe("ready");
    expect(S.inputs.at(-1)).toBe(join(MOUNT, name));
    // the sync was late, not gone: its copy lands, a part first — left alone while anything of it is written
    land(join(A, name, "a.bin"), 1_000);
    const part = writing(join(A, name, "b.bin"), 200);
    await passes(3);
    expect(existsSync(join(A, name, "a.bin"))).toBe(true);
    expect(arrival(fid).took).toBeNull();
    finish(part, 500);
    await pass(60);
    expect(existsSync(join(A, name, "a.bin"))).toBe(true);                                      // whole once: a minute on, again
    await pass(60);
    expect(taken(fid)).toMatchObject({ how: "late", path: join(A, name), own: join(A, name), files: [["a.bin", 1_000], ["b.bin", 500]] });
    expect(existsSync(join(A, name))).toBe(false);
    expect(historyOf(g.id, "removed")).toEqual(["a copy of it that reached the finished-downloads folder after its import from the seedbox was removed (2 files, 0.0 GB)"]);
  });

  test("…a late copy that is not exactly its client's list (another file in its folder, a file at another size) is left — and listed for the admin", async () => {
    const name = "Late.Odd-GRP";
    const { fid, rid } = await finished({ name, files: [["a.bin", 1_000]], path: `${HOME}/${name}` });
    mkdirSync(join(MOUNT, name), { recursive: true }); writeFileSync(join(MOUNT, name, "a.bin"), new Uint8Array(1_000));
    await probeRoot(MOUNT);
    S.now += 6 * 3600_000; await pass();
    expect((await answer(fid, "seedbox")).status).toBe(200);
    await fetchTick();
    expect((await imported(rid)).state).toBe("ready");
    land(join(A, name, "a.bin"), 1_000); land(join(A, name, "sample.mkv"), 300);
    await passes(5);
    expect(tree()).toEqual([`${name}/`, `${name}/a.bin`, `${name}/sample.mkv`]);
    expect(arrival(fid).took).toBeNull();
    const l = (await listLeftovers()).find(x => x.fetchId === fid);
    expect(l).toMatchObject({ against: "client", removable: true, files: [{ p: `${name}/a.bin`, s: 1_000 }], imported: true });
    expect(l!.stays[0]).toMatch(/1 other file in its folder stays \(Late\.Odd-GRP\/sample\.mkv\), and so does the folder/);
  });
});

describe("leftovers: ludarr's own downloads still in the folder, listed read-only, removed only with the admin's OK", () => {
  /** an older download of ludarr's (from before the finished-downloads folder took them): its row as it is now */
  function older(o: { name: string; protocol?: "torrent" | "usenet"; files?: [string, number][]; read?: { files: number; bytes: number; largest: [string, number][] }; state?: "done" | "failed"; imported?: boolean }) {
    const g = game();
    const protocol = o.protocol ?? "torrent";
    const f = stmts.insertFetch({ game_id: g.id, guid: `guid:${o.name}`, indexer_id: 1, indexer: "GGn", title: o.name, protocol, size: 1, info_hash: null, client: protocol === "usenet" ? "nzbget" : "rtorrent", client_id: `old-${o.name}`, state: o.state ?? "done", release_json: null, client_instance_id: 7 });
    const local = join(MOUNT, "complete", ...(protocol === "usenet" ? ["ahoy", o.name] : [o.name]));
    db.query("UPDATE fetches SET seedbox_path=?, local_path=?, files_json=?, imported_at=?, done_at=unixepoch() WHERE id=?")
      .run(`${FROM}/${protocol === "usenet" ? `ahoy/${o.name}` : o.name}`, local, o.files ? JSON.stringify(o.files.map(([p, s]) => ({ p: `${o.name}/${p}`, s }))) : null, o.imported === false ? null : 1_700_000_000, f.id);
    const j = stmts.insertJob.get(null, f.id, g.id, local) as JobRow;
    db.query("UPDATE jobs SET state=?, fingerprint_json=? WHERE id=?").run(o.imported === false ? "failed" : "done", o.read ? JSON.stringify({ input: { files: o.read.files, bytes: o.read.bytes, largest: o.read.largest.map(([rel, size]) => ({ rel, size, magic: "" })) } }) : null, j.id);
    return { g, fid: f.id };
  }

  test("listed by the same name rules, matched file by file (or by its import's record); the dry run changes nothing; --yes removes exactly that", async () => {
    // the admin's own things: never listed, never touched
    land(join(A, TV), 4_000, 50);
    land(join(A, "tv", "Show.S01E02.1080p-GRP", "ep.mkv"), 500, 50);
    land(join(A, "ahoy", "Some.Other.Thing-GRP", "x.bin"), 100, 50);
    // an older torrent of ludarr's: its .torrent's list kept at its grab, imported from the seedbox — its copy here, a file beside it
    const t = older({ name: "Old.Torrent-GRP", files: [["a.bin", 1_000], ["sub/b.bin", 500]] });
    land(join(A, "Old.Torrent-GRP", "a.bin"), 1_000); land(join(A, "Old.Torrent-GRP", "sub", "b.bin"), 500); land(join(A, "Old.Torrent-GRP", "extra.nfo"), 20);
    // an older usenet download: no list of its files, only its import's record of what it read
    const u = older({ name: "Old.Usenet-RUNE", protocol: "usenet", read: { files: 2, bytes: 1_500, largest: [["u.iso", 1_400], ["u.nfo", 100]] } });
    land(join(A, "ahoy", "Old.Usenet-RUNE", "u.iso"), 1_400); land(join(A, "ahoy", "Old.Usenet-RUNE", "u.nfo"), 100);
    // one whose import failed (taken from the folder by an arrival: what it took is its list), its search moved on
    const ok = runner.importers;
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "unknown", reason: "no recipe opens it" })) as never } }];
    const f = await finished({ name: "Failed.Left-GRP", files: [["c.bin", 700]] });
    land(join(A, "Failed.Left-GRP", "c.bin"), 700);
    await passes(2);
    await requestsTick();
    await runJob(req(f.rid).job_id!);
    await requestsTick();
    runner.importers = ok;
    // unsafe: a file of its name at another size; two places; a place of its name whose files are not what its import read
    const sized = older({ name: "Sized-GRP", files: [["s.bin", 900]] });
    land(join(A, "Sized-GRP", "s.bin"), 901);
    const twice = older({ name: "Twice-RUNE", protocol: "usenet", read: { files: 1, bytes: 300, largest: [["t.iso", 300]] } });
    land(join(A, "Twice-RUNE", "t.iso"), 300); land(join(A, "ahoy", "Twice-RUNE", "t.iso"), 300);
    const other = older({ name: "Not.What.It.Read-RUNE", protocol: "usenet", read: { files: 1, bytes: 300, largest: [["n.iso", 300]] } });
    land(join(A, "ahoy", "Not.What.It.Read-RUNE", "n.iso"), 300); land(join(A, "ahoy", "Not.What.It.Read-RUNE", "n.nfo"), 10);
    // in use: its search still on it — not a leftover
    const busy = await finished({ name: "In.Use-GRP", files: [["i.bin", 100]] });
    land(join(A, "In.Use-GRP", "i.bin"), 100);
    await passes(2);

    const list = await listLeftovers();
    const by = new Map(list.map(l => [l.fetchId, l]));
    expect(list.map(l => l.fetchId).sort((x, y) => x - y)).toEqual([t.fid, u.fid, f.fid, sized.fid, twice.fid, other.fid].sort((x, y) => x - y));
    expect(by.get(t.fid)).toMatchObject({ state: "done", game: t.g.name, imported: true, against: "client", place: "Old.Torrent-GRP", removable: true, bytes: 1_500, unsafe: [],
      files: [{ p: "Old.Torrent-GRP/a.bin", s: 1_000 }, { p: "Old.Torrent-GRP/sub/b.bin", s: 500 }] });
    expect(by.get(t.fid)!.stays).toEqual(["1 other file in its folder stays (Old.Torrent-GRP/extra.nfo), and so does the folder"]);
    expect(by.get(u.fid)).toMatchObject({ against: "import", place: "ahoy/Old.Usenet-RUNE", removable: true, files: [{ p: "ahoy/Old.Usenet-RUNE/u.iso", s: 1_400 }, { p: "ahoy/Old.Usenet-RUNE/u.nfo", s: 100 }] });
    expect(by.get(f.fid)).toMatchObject({ against: "taken", imported: false, place: "Failed.Left-GRP", removable: true, files: [{ p: "Failed.Left-GRP/c.bin", s: 700 }] });
    expect(by.get(sized.fid)).toMatchObject({ removable: false, files: [] });
    expect(by.get(sized.fid)!.unsafe).toEqual(["1 file of its names is not at the size of what its client listed (Sized-GRP/s.bin)"]);
    expect(by.get(twice.fid)!.unsafe).toEqual(["it could be in 2 places (Twice-RUNE, ahoy/Twice-RUNE): nothing of it is touched"]);
    expect(by.get(other.fid)!.unsafe[0]).toMatch(/^a place of its name holds other files than its import read \(2 files, 0\.0 GB there; its import read 1, 0\.0 GB\)$/);
    expect(by.has(busy.fid)).toBe(false);
    for (const l of list) for (const s of [...l.unsafe, ...l.stays, l.place, ...l.files.map(x => x.p), ...l.unproven]) { expect(s).not.toContain(A); expect(s).not.toContain("/arrivals"); }

    // the dry run (the default) changes nothing — not a file, not a date, not a row
    const before = tree(), dates = before.filter(p => !p.endsWith("/")).map(p => mtime(join(A, ...p.split("/")))), rows = db.query("SELECT id, took_json, arrival_json FROM fetches ORDER BY id").all();
    const ids = [t.fid, u.fid, f.fid, sized.fid, twice.fid, other.fid, busy.fid, 999_999];
    const dry = await removeLeftovers(ids);
    expect(tree()).toEqual(before);
    expect(before.filter(p => !p.endsWith("/")).map(p => mtime(join(A, ...p.split("/"))))).toEqual(dates);
    expect(db.query("SELECT id, took_json, arrival_json FROM fetches ORDER BY id").all()).toEqual(rows);
    const d = new Map(dry.map(x => [x.fetchId, x]));
    expect(d.get(t.fid)).toMatchObject({ dry: true, removed: false, files: ["Old.Torrent-GRP/a.bin", "Old.Torrent-GRP/sub/b.bin"], dirs: ["Old.Torrent-GRP/sub"] });
    expect(d.get(t.fid)!.words).toBe("would remove 2 files (0.0 GB) and 1 folder; its folder stays: something else is still in it (Old.Torrent-GRP/extra.nfo)");
    expect(d.get(u.fid)).toMatchObject({ files: ["ahoy/Old.Usenet-RUNE/u.iso", "ahoy/Old.Usenet-RUNE/u.nfo"], dirs: ["ahoy/Old.Usenet-RUNE"] });
    expect(d.get(sized.fid)!.words).toMatch(/^not removed: 1 file of its names/);
    expect(d.get(busy.fid)!.words).toMatch(/its search is not over/);
    expect(d.get(999_999)!.words).toMatch(/nothing of it is in the finished-downloads folder/);

    // the admin's OK
    const done = await removeLeftovers(ids, { yes: true });
    expect(done.filter(x => x.removed).map(x => x.fetchId).sort((x, y) => x - y)).toEqual([t.fid, u.fid, f.fid].sort((x, y) => x - y));
    expect(tree()).toEqual([TV, "In.Use-GRP/", "In.Use-GRP/i.bin", "Old.Torrent-GRP/", "Old.Torrent-GRP/extra.nfo", "Sized-GRP/", "Sized-GRP/s.bin", "Twice-RUNE/", "Twice-RUNE/t.iso",
      "ahoy/", "ahoy/Not.What.It.Read-RUNE/", "ahoy/Not.What.It.Read-RUNE/n.iso", "ahoy/Not.What.It.Read-RUNE/n.nfo", "ahoy/Some.Other.Thing-GRP/", "ahoy/Some.Other.Thing-GRP/x.bin", "ahoy/Twice-RUNE/", "ahoy/Twice-RUNE/t.iso",
      "tv/", "tv/Show.S01E02.1080p-GRP/", "tv/Show.S01E02.1080p-GRP/ep.mkv"].sort());
    expect(historyOf(t.g.id, "removed")).toEqual(["removed from the finished-downloads folder with your OK: ludarr's own download, left there before (2 files, 0.0 GB); its folder stays: something else is still in it (Old.Torrent-GRP/extra.nfo)"]);
    // what it followed is written down (a run cut short goes on by the same list); done twice removes nothing more
    expect(JSON.parse(fetchRow(u.fid).took_json!)).toMatchObject({ how: "leftover", path: join(A, "ahoy", "Old.Usenet-RUNE") });
    expect((await removeLeftovers([u.fid, f.fid], { yes: true })).map(x => x.removed)).toEqual([false, false]);
    // what stays in the older torrent's own folder is offered next, named as nothing shows it to be its own: the admin decides
    const next = await listLeftovers();
    expect(next.map(l => l.fetchId).sort((x, y) => x - y)).toEqual([t.fid, sized.fid, twice.fid, other.fid].sort((x, y) => x - y));
    expect(next.find(l => l.fetchId === t.fid)).toMatchObject({ against: "folder", removable: true, place: "Old.Torrent-GRP", files: [{ p: "Old.Torrent-GRP/extra.nfo", s: 20 }], unproven: ["Old.Torrent-GRP/extra.nfo"] });
  });

  test("the nested shape is one place, not two: <name>/<name> (a folder, or a single file) fits its import's record once and goes whole with the OK", async () => {
    // how every older torrent of ludarr's sits in downloads/finished (2026-11-10): the seedbox's complete/<name>/<name>, moved over
    land(join(A, TV), 4_000, 50);
    const d = older({ name: "Nested.Old-CODEX", read: { files: 2, bytes: 1_500, largest: [["game.iso", 1_400], ["codex.nfo", 100]] } });
    land(join(A, "Nested.Old-CODEX", "Nested.Old-CODEX", "game.iso"), 1_400); land(join(A, "Nested.Old-CODEX", "Nested.Old-CODEX", "codex.nfo"), 100);
    const s = older({ name: "Single.Old.7z", read: { files: 1, bytes: 800, largest: [["Single.Old.7z", 800]] } });
    land(join(A, "Single.Old.7z", "Single.Old.7z"), 800);
    // the same shape with a stranger beside the inner one is not its whole folder: the import's record does not fit the outer
    // one, so only the inner one is it — and the stranger keeps the outer folder
    const b = older({ name: "Beside.Old-GRP", read: { files: 1, bytes: 300, largest: [["b.iso", 300]] } });
    land(join(A, "Beside.Old-GRP", "Beside.Old-GRP", "b.iso"), 300); land(join(A, "Beside.Old-GRP", "notes.txt"), 10);
    const list = await listLeftovers();
    const by = new Map(list.map(l => [l.fetchId, l]));
    expect(by.get(d.fid)).toMatchObject({ against: "import", place: "Nested.Old-CODEX/Nested.Old-CODEX", removable: true, unsafe: [],
      files: [{ p: "Nested.Old-CODEX/Nested.Old-CODEX/codex.nfo", s: 100 }, { p: "Nested.Old-CODEX/Nested.Old-CODEX/game.iso", s: 1_400 }] });
    expect(by.get(s.fid)).toMatchObject({ against: "import", place: "Single.Old.7z/Single.Old.7z", removable: true, unsafe: [], files: [{ p: "Single.Old.7z/Single.Old.7z", s: 800 }] });
    expect(by.get(b.fid)).toMatchObject({ against: "import", place: "Beside.Old-GRP/Beside.Old-GRP", removable: true, unsafe: [] });
    const done = await removeLeftovers([d.fid, s.fid, b.fid], { yes: true });
    expect(done.map(x => x.removed)).toEqual([true, true, true]);
    // each goes whole, its folder of its own name with it; the stranger and its folder stay; the admin's file is untouched
    expect(tree()).toEqual([TV, "Beside.Old-GRP/", "Beside.Old-GRP/notes.txt"].sort());
  });
});

/* ─────────── the review of the removal (2026-11-09): each problem it proved, reproduced here first, then fixed ─────────── */

describe("review of the removal: only what is proven its own goes (R1–R6)", () => {
  test("R1 usenet: a file in the folder of its name before NZBGet's folder was read on the seedbox is taken with it, never deleted — said, and listed for the admin", async () => {
    const name = "Word.Name-RUNE";
    seed(name, "w.iso", 800);
    land(join(A, "ahoy", name, "someone-elses.mkv"), 5_000, 600);                 // already in the folder of its name
    const w = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 800 });
    await pass();
    expect(arrival(w.fid).listAll).toBe(false);                                   // something was here before its list was read
    carry(name, "w.iso", 800);
    await passes(3);
    expect(fetchRow(w.fid).state).toBe("done");
    expect(taken(w.fid)).toMatchObject({ files: [["w.iso", 800]], unproven: [["someone-elses.mkv", 5_000]] });
    expect((await imported(w.rid)).state).toBe("ready");
    await pass();
    expect(tree()).toEqual(["ahoy/", `ahoy/${name}/`, `ahoy/${name}/someone-elses.mkv`]);
    expect(arrival(w.fid).rm).toMatchObject({ state: "done", removed: 1 });
    expect(historyOf(w.g.id, "removed")).toEqual([`removed from the finished-downloads folder after its import (1 file, 0.0 GB); 1 file it took is not known to be its own and stays (ahoy/${name}/someone-elses.mkv); its folder stays with it`]);
    const l = (await listLeftovers()).find(x => x.fetchId === w.fid);
    expect(l).toMatchObject({ against: "taken", removable: true, files: [{ p: `ahoy/${name}/someone-elses.mkv`, s: 5_000 }], unproven: [`ahoy/${name}/someone-elses.mkv`] });
  });

  test("R1 …NZBGet's folder read before any of it was here (its whole list): a file in its folder it does not list is someone else's — nothing taken, said; once it is gone, exactly its list", async () => {
    const name = "Whole.List-RUNE";
    seed(name, "g.iso", 900);
    const w = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 900 });
    await pass();
    expect(arrival(w.fid).listAll).toBe(true);
    carry(name, "g.iso", 900);
    land(join(A, "ahoy", name, "admins-notes.txt"), 50, 0);                       // not NZBGet's
    await passes(3);
    expect(fetchRow(w.fid).state).toBe("arriving");
    expect(arrival(w.fid).trouble).toBe("ambiguous");
    expect(arrival(w.fid).troubleWords).toMatch(/admins-notes\.txt/);
    expect(arrival(w.fid).troubleWords).not.toContain(A);
    unlinkSync(join(A, "ahoy", name, "admins-notes.txt"));
    await passes(2);
    expect(fetchRow(w.fid).state).toBe("done");
    expect(taken(w.fid)).toMatchObject({ files: [["g.iso", 900]], unproven: [] });
  });

  test("R1 …no list of NZBGet's (its folder already carried when ludarr first looked): imported, and nothing of it deleted — nor a file put there after it was taken", async () => {
    const name = "Gains.After-RUNE";
    const w = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    land(join(A, "ahoy", name, "g.iso"), 1_000);
    await passes(11);
    expect(fetchRow(w.fid).state).toBe("done");
    land(join(A, "ahoy", name, "admins-notes.txt"), 50, 0);                       // someone else's, after it was taken
    await requestsTick();
    await runJob(req(w.rid).job_id!);
    await requestsTick();
    await untilArriving(w.fid);                                                   // more than was taken: awaited again
    await passes(12);
    expect(fetchRow(w.fid).state).toBe("done");
    expect(taken(w.fid)).toMatchObject({ files: [], unproven: [["admins-notes.txt", 50], ["g.iso", 1_000]] });
    expect((await imported(w.rid)).state).toBe("ready");
    await pass();
    expect(tree()).toEqual(["ahoy/", `ahoy/${name}/`, `ahoy/${name}/admins-notes.txt`, `ahoy/${name}/g.iso`]);
    expect(arrival(w.fid).rm?.state).toBe("left");
    expect(historyOf(w.g.id, "left")).toEqual(["left in the finished-downloads folder (its files there cannot be told from anything else: NZBGet's folder was not seen on the seedbox before the sync carried it): ludarr deletes nothing of it there"]);
    const l = (await listLeftovers()).find(x => x.fetchId === w.fid);
    expect(l).toMatchObject({ against: "taken", removable: true, unproven: [`ahoy/${name}/admins-notes.txt`, `ahoy/${name}/g.iso`] });
  });

  test("R1 an earlier download of that name whose import failed left its files there: a later post of it is never taken while they are, however long after — then it is", async () => {
    const name = "Same.Name-RUNE";
    const ok = runner.importers;
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "unknown", reason: "no recipe opens it" })) as never } }];
    const e1 = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 1_000 });
    land(join(A, "ahoy", name, "old.part1.rar"), 1_000);
    await passes(11);
    expect(fetchRow(e1.fid).state).toBe("done");
    await requestsTick();
    await runJob(req(e1.rid).job_id!);
    await requestsTick();
    await passes(2);
    expect(arrival(e1.fid).rm?.state).toBe("left");
    runner.importers = ok;
    db.query("UPDATE requests SET state='cancelled' WHERE id=?").run(e1.rid);    // (its search given up)
    S.now += 3 * 3600_000;                                                      // long past the hour the cleanup was once assumed to take
    const e2 = await finished({ name, protocol: "usenet", path: `${FROM}/ahoy/${name}`, downloaded: 900, guid: "guid:another-post" });
    land(join(A, "ahoy", name, "new.iso"), 900);
    await passes(15);
    expect(fetchRow(e2.fid).state).toBe("arriving");
    expect(arrival(e2.fid).trouble).toBe("ambiguous");
    expect(arrival(e2.fid).troubleWords).toMatch(/an earlier download of that name/);
    expect(existsSync(join(A, "ahoy", name, "old.part1.rar"))).toBe(true);
    unlinkSync(join(A, "ahoy", name, "old.part1.rar"));                          // the admin deletes what the earlier one left
    await passes(12);
    expect(fetchRow(e2.fid).state).toBe("done");
    expect(taken(e2.fid).unproven).toEqual([["new.iso", 900]]);
  });

  test("R2 the folder an rclone mount of the seedbox (the health list's error): nothing is deleted there — the removal waits, the leftovers are refused", async () => {
    const at = resolve(A).split("\\").join("/");
    adeps.mountInfo = () => `612 35 0:77 / ${at} rw,nosuid,nodev,relatime - fuse.rclone seedbox: rw,user_id=0,group_id=0\n`;
    const name = "On.The.Mount-GRP";
    const { g, fid } = await importedOne({ name, files: [["a.bin", 1_000]] }, [[join(A, name, "a.bin"), 1_000]]);
    expect((await arrivalsHealth(sec())).some(h => h.type === "error" && /rclone mount/.test(h.message))).toBe(true);
    await passes(3);
    expect(existsSync(join(A, name, "a.bin"))).toBe(true);
    expect(arrival(fid).rm).toMatchObject({ state: "waiting", why: "the finished-downloads folder is an rclone mount of the seedbox" });
    expect(historyOf(g.id, "removed")).toEqual([]);
    await expect(listLeftovers()).rejects.toThrow(/rclone mount of the seedbox/);
    await expect(removeLeftovers([fid], { yes: true })).rejects.toThrow(/rclone mount of the seedbox/);
    adeps.mountInfo = () => "";                                                 // put right: the folder the sync fills
    await pass(61);
    expect(existsSync(join(A, name))).toBe(false);
    expect(arrival(fid).rm?.state).toBe("done");
  });

  test("R3 the setting emptied, or moved to another folder, while a removal waits: nothing is deleted in the old folder until it is that folder again", async () => {
    const one = await finished({ name: "Off.Then-GRP", files: [["a.bin", 1_000]] });
    const two = await finished({ name: "Moved.Then-GRP", files: [["a.bin", 1_000]] });
    land(join(A, "Off.Then-GRP", "a.bin"), 1_000); land(join(A, "Moved.Then-GRP", "a.bin"), 1_000);
    await passes(2);
    for (const x of [one, two]) expect((await imported(x.rid)).state).toBe("ready");
    // an import by hand reads each, so its removal waits
    const hands = [stmts.insertJob.get(null, null, one.g.id, join(A, "Off.Then-GRP")) as JobRow, stmts.insertJob.get(null, null, two.g.id, join(A, "Moved.Then-GRP")) as JobRow];
    await pass();
    for (const x of [one, two]) expect(arrival(x.fid).rm?.state).toBe("waiting");
    for (const h of hands) cancelJob(h.id);
    setFolder("");                                                              // off
    await passes(3);
    expect(arrival(one.fid).rm).toMatchObject({ state: "waiting", why: "the finished-downloads folder is not set" });
    const B = join(tmp, "Other");
    mkdirSync(B, { recursive: true });
    setFolder(B);                                                               // another folder
    await passes(3);
    expect(arrival(two.fid).rm).toMatchObject({ state: "waiting", why: "the finished-downloads folder is set to another folder now" });
    expect(tree()).toEqual(["Moved.Then-GRP/", "Moved.Then-GRP/a.bin", "Off.Then-GRP/", "Off.Then-GRP/a.bin"]);
    setFolder(A);                                                               // that folder again
    await pass(61);
    expect(tree()).toEqual([]);
    for (const x of [one, two]) expect(arrival(x.fid).rm?.state).toBe("done");
  });

  test("R4 what lands in its folder after its removal is listed for the admin — by its client's list when it has one, else as what is left in its own folder", async () => {
    // a torrent removed while a part file is written into its folder, renamed into place after
    const name = "Part.During-GRP";
    const t = await importedOne({ name, files: [["a.bin", 950]] }, [[join(A, name, "a.bin"), 950]]);
    let part = "";
    adeps.unlink = async p => { await saved.a.unlink(p); if (!part) part = writing(join(A, name, "a.r00"), 50); };
    await pass();
    adeps.unlink = saved.a.unlink;
    expect(arrival(t.fid).rm).toMatchObject({ state: "done", removed: 1, kept: 1 });
    let l = (await listLeftovers()).find(x => x.fetchId === t.fid);
    expect(l).toMatchObject({ against: "folder", removable: false, unsafe: ["a file in its folder is still being written"] });
    finish(part, 50);
    l = (await listLeftovers()).find(x => x.fetchId === t.fid);
    expect(l).toMatchObject({ against: "folder", removable: true, place: name, files: [{ p: `${name}/a.r00`, s: 50 }], unproven: [`${name}/a.r00`] });
    expect((await removeLeftovers([t.fid], { yes: true }))[0]).toMatchObject({ removed: true });
    expect(existsSync(join(A, name))).toBe(false);

    // usenet with NZBGet's folder read: imported as it had arrived (the admin's choice), the rest lands after its removal
    const u = "Now.Then.Rest-RUNE";
    for (const p of ["p1.rar", "p2.rar", "p3.rar"]) seed(u, p, 1_000);
    const w = await finished({ name: u, protocol: "usenet", path: `${FROM}/ahoy/${u}`, downloaded: 3_000 });
    await pass();
    carry(u, "p1.rar", 1_000); carry(u, "p2.rar", 1_000);
    await passes(2);
    S.now += 6 * 3600_000; await pass();
    expect((await answer(w.fid, "now")).status).toBe(200);
    expect((await imported(w.rid)).state).toBe("ready");
    await pass();
    expect(tree()).toEqual(["ahoy/"]);
    carry(u, "p3.rar", 1_000);                                                  // the sync brings the rest
    await passes(3);
    const m = (await listLeftovers()).find(x => x.fetchId === w.fid);
    expect(m).toMatchObject({ against: "client", removable: true, files: [{ p: `ahoy/${u}/p3.rar`, s: 1_000 }], unproven: [] });
  });

  test("R4 …a part file left for dead in its folder (an rclone run that died: unchanged 30 min) is no file being written — it stays, the rest may go", async () => {
    const name = "Dead.Part-GRP";
    const ok = runner.importers;
    runner.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: { probe: async () => true, run: (async () => ({ ok: false, shape: "unknown", reason: "no recipe opens it" })) as never } }];
    const w = await finished({ name, files: [["a.bin", 1_000]] });
    land(join(A, name, "a.bin"), 1_000);
    await passes(2);
    await requestsTick();
    await runJob(req(w.rid).job_id!);
    await requestsTick();
    runner.importers = ok;
    await passes(2);
    expect(arrival(w.fid).rm?.state).toBe("left");                             // its import failed: what it took is a leftover
    const part = writing(join(A, name, "b.bin"), 300);                          // written now
    let l = (await listLeftovers()).find(x => x.fetchId === w.fid);
    expect(l).toMatchObject({ against: "taken", removable: false, unsafe: ["a file in its folder is still being written"] });
    const old = new Date(S.now - 40 * 60_000);
    utimesSync(part, old, old);                                                 // the run writing it died 40 min ago
    l = (await listLeftovers()).find(x => x.fetchId === w.fid);
    expect(l).toMatchObject({ against: "taken", removable: true, unsafe: [], files: [{ p: `${name}/a.bin`, s: 1_000 }] });
    expect(l!.stays).toEqual([`1 other file in its folder stays (${name}/b.bin.a1b2c3d4.partial), and so does the folder`]);
  });

  test("R5 a wait for another download of that name that stopped (72 h) holds no removal up; a removal held up for a day is said in the health list", async () => {
    const name = "Blocked.By.Stopped-GRP";
    const one = await importedOne({ name, files: [["a.bin", 1_000]] }, [[join(A, name, "a.bin"), 1_000]]);
    const two = await finished({ name, files: [["b.bin", 2_000]], guid: "guid:another-torrent" });   // the same name, other files: awaited, never here
    await pass();
    expect(arrival(one.fid).rm).toMatchObject({ state: "waiting", why: `another download of ludarr's of that name is awaited (#${two.fid})` });
    const waits = async () => (await arrivalsHealth(sec())).filter(x => /to delete its own download/.test(x.message));
    expect(await waits()).toEqual([]);
    S.now += 24 * 3600_000; await pass(61);
    const h = await waits();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ type: "warning", link: "/activity/queue" });
    expect(h[0].message).toMatch(new RegExp(`^${name.replace(/\./g, "\\.")}: ludarr has been waiting since .+ to delete its own download from the finished-downloads folder \\(another download of ludarr's of that name is awaited \\(#${two.fid}\\)\\)$`));
    expect(h[0].message).not.toContain(A);
    S.now += 48 * 3600_000; await pass();
    expect(arrival(two.fid).stopped).toBe(true);
    await pass(61);
    expect(arrival(one.fid).rm?.state).toBe("done");
    expect(existsSync(join(A, name))).toBe(false);
  });

  test("R6 a folder named like a download of ludarr's with nothing that says what its files were is never listed (it may be the admin's own)", async () => {
    const g = game();
    const f = stmts.insertFetch({ game_id: g.id, guid: "guid:shared-name", indexer_id: 1, indexer: "GGn", title: "Shared.Name.2019", protocol: "torrent", size: 1, info_hash: null, client: "rtorrent", client_id: "old-shared", state: "failed", release_json: null, client_instance_id: 7 });
    land(join(A, "Shared.Name.2019", "movie.mkv"), 5_000, 600);
    expect((await listLeftovers()).map(l => l.fetchId)).not.toContain(f.id);
  });
});
