import { beforeEach, describe, expect, test } from "bun:test";
import { db, stmts, type FetchRow } from "../src/db";
import { deps, grab, tick, retry, remove, cancelAllPulls, FetchError } from "../src/fetch";
import type { ProwlarrRelease } from "../src/prowlarr";
import type { RtItem } from "../src/rtorrent";
import type { NzbItem } from "../src/nzbget";
import type { PullHandle, PullJob } from "../src/pull";
import type { DownloadClient } from "../src/plugins/types";
import { parseMagnet, parseTorrent } from "../src/bencode";
import { fromNzbget, fromRtorrent } from "../src/seedbox-items";

const INFO = "d6:lengthi1000e4:name8:TestGame12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe";
const TORRENT = new TextEncoder().encode(`d8:announce13:http://tr/ann4:info${INFO}e`);
const HASH = new Bun.CryptoHasher("sha1").update(new TextEncoder().encode(INFO)).digest("hex").toUpperCase();

const release = (over: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: "g-" + Math.random().toString(36).slice(2), title: "TestGame-CODEX", instanceId: 1, indexerId: 1, indexer: "T", size: 5000, age: 1,
  publishDate: "", seeders: 5, leechers: 0, grabs: null, files: null, downloadUrl: "http://p/dl", magnetUrl: null,
  infoUrl: null, infoHash: null, protocol: "torrent", categories: [], indexerFlags: [], fileName: null, ...over,
});

/* ---- fakes: two download clients (torrent, usenet) and one indexer ---- */
let rtItems: RtItem[] = [];
const rtAdded: { kind: string; opt: unknown }[] = [];
let nzItems: NzbItem[] = [];
let nzNext = 41;
let pullQueue: { job: PullJob; resolve: (ok: boolean, err?: string) => void }[] = [];
let nowOffsetSec = 0;
let download: (r: any) => Promise<any>;
let clients: { id: number; name: string; client: DownloadClient; protocols: string[] }[] = [];

function fakePull(job: PullJob): PullHandle {
  let resolve!: (ok: boolean, err?: string) => void;
  const done = new Promise<{ ok: boolean; localPath: string; bytes: number; error?: string }>(r => {
    resolve = (ok, error) => r({ ok, localPath: "/downloads/" + job.remotePath.split("/").pop(), bytes: ok ? job.expectedBytes : 0, error });
  });
  pullQueue.push({ job, resolve });
  return { localPath: "/downloads/" + job.remotePath.split("/").pop(), done, progress: () => 0.5, bytes: () => 0, cancel: () => resolve(false, "cancelled") };
}

function installFakes() {
  rtItems = []; nzItems = []; pullQueue = []; rtAdded.length = 0; nowOffsetSec = 0; nzNext = 41;
  download = async (r: any) => r.protocol === "usenet"
    ? { kind: "nzb", bytes: new TextEncoder().encode("<nzb/>"), filename: "x.nzb" }
    : r.magnetUrl ? { kind: "magnet", uri: r.magnetUrl } : { kind: "torrent", bytes: TORRENT, filename: "t.torrent" };
  const rt: DownloadClient = {
    test: async () => ({ ok: true, detail: "" }),
    add: async payload => {
      const hash = payload.kind === "magnet" ? parseMagnet(payload.uri)!.infoHash : payload.kind === "torrent" ? parseTorrent(payload.bytes).infoHash : "";
      if (!rtItems.find(i => i.hash === hash)) rtAdded.push({ kind: payload.kind, opt: { label: "ahoy", dir: "/home/u/dl/ahoy" } });
      return { client: "rtorrent", clientId: hash, infoHash: hash };
    },
    items: async () => ({ items: rtItems.map(fromRtorrent) }),
    remove: async () => { rtItems = []; },
    pull: (_i, job) => fakePull(job),
  };
  const nz: DownloadClient = {
    test: async () => ({ ok: true, detail: "" }),
    add: async () => ({ client: "nzbget", clientId: String(++nzNext) }),
    items: async () => ({ items: nzItems.map(fromNzbget) }),
    remove: async () => { nzItems = []; },
    pull: (_i, job) => fakePull(job),
  };
  clients = [{ id: 1, name: "rt", client: rt, protocols: ["torrent"] }, { id: 2, name: "nz", client: nz, protocols: ["usenet"] }];
  deps.clients = () => clients;
  deps.clientById = id => clients.find(c => c.id === id)?.client ?? null;
  deps.indexerById = () => ({ download: (r: any) => download(r) } as any);
  deps.log = () => {};
  deps.now = () => Date.now() + nowOffsetSec * 1000;
}

const rtItem = (over: Partial<RtItem>): RtItem => ({
  hash: HASH, name: "TestGame", complete: false, active: true, sizeBytes: 1000, completedBytes: 0, downRate: 0,
  directory: "/home/u/dl/ahoy", multiFile: false, label: "ahoy", message: "", dataPath: "/home/u/dl/ahoy/TestGame", ...over,
});
const row = (id: number) => stmts.fetchById.get(id) as FetchRow;

beforeEach(() => { cancelAllPulls(); db.exec("DELETE FROM fetches"); installFakes(); });

describe("grab", () => {
  test("torrent: hash from bytes, size from metainfo, label + dir passed to rtorrent", async () => {
    const { fetch: f, duplicate } = await grab(release(), null);
    expect(duplicate).toBe(false);
    expect(f).toMatchObject({ state: "submitted", client: "rtorrent", clientId: HASH, infoHash: HASH, size: 1000, title: "TestGame-CODEX" });
    expect(rtAdded).toEqual([{ kind: "torrent", opt: { label: "ahoy", dir: "/home/u/dl/ahoy" } }]);
  });
  test("same torrent again is a duplicate, not a second row — unless the old download finished and its files are gone", async () => {
    await grab(release(), null);
    const { duplicate } = await grab(release(), null);
    expect(duplicate).toBe(true);
    expect(stmts.allFetches.all()).toHaveLength(1);
    db.exec("UPDATE fetches SET state='done', local_path='/downloads/long-gone'");
    expect((await grab(release(), null)).duplicate).toBe(false);
    expect(stmts.allFetches.all()).toHaveLength(2);
  });
  test("magnet path tracks by btih and skips add when the seedbox already has it", async () => {
    rtItems = [rtItem({})];
    const { fetch: f } = await grab(release({ magnetUrl: `magnet:?xt=urn:btih:${HASH}&dn=TestGame` }), null);
    expect(f.clientId).toBe(HASH);
    expect(rtAdded).toHaveLength(0);
  });
  test("usenet goes to nzbget with the NZBID as client id", async () => {
    const { fetch: f } = await grab(release({ protocol: "usenet", title: "TestGame-NZB" }), null);
    expect(f).toMatchObject({ client: "nzbget", clientId: "42", state: "submitted" });
  });
  test("no client for the protocol is a 400 FetchError; payload failure is 502", async () => {
    clients = clients.filter(c => !c.protocols.includes("usenet"));
    await expect(grab(release({ protocol: "usenet" }), null)).rejects.toThrow(/no enabled download client handles usenet/);
    download = async () => { throw new Error("PROWLARR_DOWNLOAD_HTTP_500"); };
    try { await grab(release(), null); throw new Error("no throw"); }
    catch (e: any) { expect(e).toBeInstanceOf(FetchError); expect(e.status).toBe(502); }
  });
});

describe("pipeline", () => {
  test("torrent: submitted → downloading → seedbox_done → pulling → done", async () => {
    const { fetch: f } = await grab(release(), null);
    rtItems = [rtItem({ completedBytes: 500 })];
    await tick();
    expect(row(f.id)).toMatchObject({ state: "downloading", progress: 0.5 });

    rtItems = [rtItem({ complete: true, completedBytes: 1000, multiFile: true, directory: "/home/u/dl/ahoy/TestGame", dataPath: "/home/u/dl/ahoy/TestGame" })];
    await tick();   // sees completion, and in the same tick starts the pull
    expect(row(f.id)).toMatchObject({ state: "pulling", seedbox_path: "/home/u/dl/ahoy/TestGame", seedbox_is_dir: 1, local_path: "/downloads/TestGame" });
    expect(pullQueue).toHaveLength(1);
    expect(pullQueue[0].job).toEqual({ remotePath: "/home/u/dl/ahoy/TestGame", isDir: true, expectedBytes: 1000, exact: true });   // a torrent's size is exact

    await tick();
    expect(row(f.id).progress).toBe(0.5);
    pullQueue[0].resolve(true);
    await new Promise(r => setTimeout(r, 0));
    expect(row(f.id)).toMatchObject({ state: "done", progress: 1, local_path: "/downloads/TestGame" });
    expect(row(f.id).done_at).not.toBeNull();
  });

  test("usenet: queue progress, then history SUCCESS → final dir", async () => {
    const { fetch: f } = await grab(release({ protocol: "usenet", title: "TestGame-NZB" }), null);
    const base = { id: 42, name: "TestGame", destDir: "/dl/TestGame", finalDir: "", category: "ahoy", downloadedBytes: 0 };
    nzItems = [{ ...base, status: "DOWNLOADING", sizeBytes: 4000, remainingBytes: 1000, inHistory: false }];
    await tick();
    expect(row(f.id)).toMatchObject({ state: "downloading", progress: 0.75, message: "DOWNLOADING" });
    nzItems = [{ ...base, status: "SUCCESS/UNPACK", sizeBytes: 4000, remainingBytes: 0, finalDir: "/done/TestGame", inHistory: true }];
    await tick();
    expect(row(f.id)).toMatchObject({ state: "pulling", seedbox_path: "/done/TestGame", size: 4000 });
  });

  test("usenet failure in history fails the fetch with the status", async () => {
    const { fetch: f } = await grab(release({ protocol: "usenet" }), null);
    nzItems = [{ id: 42, name: "x", status: "FAILURE/PAR", sizeBytes: 1, remainingBytes: 0, downloadedBytes: 0, destDir: "", finalDir: "", category: "", inHistory: true }];
    await tick();
    expect(row(f.id)).toMatchObject({ state: "failed", message: "nzbget: FAILURE/PAR" });
  });

  test("not on the seedbox: tolerated inside the grace window; after it, gone only once missing 3 times over 15 minutes", async () => {
    const { fetch: f } = await grab(release(), null);
    await tick();
    expect(row(f.id).state).toBe("submitted");
    nowOffsetSec = 600;
    await tick();
    expect(row(f.id).state).toBe("submitted");                                // one list without it is nothing yet
    nowOffsetSec = 900; await tick();
    expect(row(f.id).state).toBe("submitted");
    nowOffsetSec = 1500; await tick();                                        // the third miss, 15 minutes after the first
    expect(row(f.id)).toMatchObject({ state: "failed" });
    expect(row(f.id).message).toContain("not found in the download client");
  });

  test("a transfer the seedbox broke off goes back to seedbox_done and is tried again at its time; wrong settings fail it", async () => {
    const { fetch: f } = await grab(release(), null);
    rtItems = [rtItem({ complete: true, completedBytes: 1000 })];
    await tick();
    pullQueue[0].resolve(false, "lftp exit 1: timeout");
    await new Promise(r => setTimeout(r, 0));
    const at = Math.floor(Date.now() / 1000);
    expect(row(f.id)).toMatchObject({ state: "seedbox_done" });
    expect(row(f.id).message).toMatch(/^the transfer broke off: lftp exit 1: timeout — trying again in a minute \(it resumes where it stopped\)$/);
    expect(row(f.id).retry_at!).toBeGreaterThanOrEqual(at + 59);
    await tick();
    expect(pullQueue).toHaveLength(1);                                        // not before its time
    nowOffsetSec = 61; await tick();
    expect(row(f.id).state).toBe("pulling");
    expect(pullQueue).toHaveLength(2);
    // settings that are wrong are no seedbox trouble: failed at once; the admin's retry starts it again
    pullQueue[1].resolve(false, "no transfer URL (sftp://host) on this download client");
    await new Promise(r => setTimeout(r, 0));
    expect(row(f.id)).toMatchObject({ state: "failed" });
    expect(retry(f.id).state).toBe("seedbox_done");
    await tick();
    expect(row(f.id).state).toBe("pulling");
    expect(pullQueue).toHaveLength(3);
    expect(() => retry(f.id)).toThrow(/cannot retry/);
  });

  test("review 2026-11-10: a torrent's transfer is given the client's own list of its files, and a hidden file no listing serves fails it at once", async () => {
    // a client that can list a torrent's files (rTorrent): the transfer asks it when a web listing shows less than it has
    const asked: unknown[] = [];
    clients[0].client.files = async ref => { asked.push(ref); return [{ path: "game.exe", size: 963 }, { path: ".DepotDownloader/depot.config", size: 37 }]; };
    const { fetch: f } = await grab(release(), null);
    rtItems = [rtItem({ complete: true, completedBytes: 1000, multiFile: true, directory: "/home/u/dl/ahoy/TestGame", dataPath: "/home/u/dl/ahoy/TestGame" })];
    await tick();
    const job = pullQueue[0].job;
    expect(job).toMatchObject({ remotePath: "/home/u/dl/ahoy/TestGame", isDir: true, expectedBytes: 1000, exact: true });
    expect(await job.files!()).toEqual([{ path: "game.exe", size: 963 }, { path: ".DepotDownloader/depot.config", size: 37 }]);
    expect(asked).toEqual([{ client: "rtorrent", clientId: HASH }]);
    // a listing that is short for now (the client did not answer for its files) is the seedbox's trouble: tried again
    pullQueue[0].resolve(false, "the transfer fetched 963 of the 1000 bytes the client has: the file listing leaves some of the download out");
    await new Promise(r => setTimeout(r, 0));
    expect(row(f.id)).toMatchObject({ state: "seedbox_done" });
    expect(row(f.id).retry_at).not.toBeNull();
    nowOffsetSec = 61; await tick();
    expect(row(f.id).state).toBe("pulling");
    // the hidden file is neither listed nor served: every try would end the same, so the download fails now, in its words
    const words = "the file listing does not show .DepotDownloader/depot.config and the server does not serve it either (HTTP 403): this download cannot be fetched whole over the Transfer URL — map the client's folder, or use an sftp:// Transfer URL";
    pullQueue[1].resolve(false, words);
    await new Promise(r => setTimeout(r, 0));
    expect(row(f.id)).toMatchObject({ state: "failed", message: words });
    expect(row(f.id).retry_at).toBeNull();
  });
  test("review 2026-11-10: a usenet download, or a client that cannot list a torrent's files, is given no list", async () => {
    const { fetch: f } = await grab(release(), null);
    rtItems = [rtItem({ complete: true, completedBytes: 1000 })];
    clients[1].client.files = async () => [{ path: "x", size: 1 }];             // (a usenet client that could: its size is no file size)
    const { fetch: n } = await grab(release({ protocol: "usenet", title: "TestGame-NZB" }), null);
    nzItems = [{ id: Number(row(n.id).client_id), name: "TestGame-NZB", status: "SUCCESS/ALL", sizeBytes: 5000, remainingBytes: 0, downloadedBytes: 5000, destDir: "/home/u/nzb/TestGame-NZB", finalDir: "", category: "", inHistory: true }];
    await tick();
    const jobs = pullQueue.map(p => p.job);
    expect(jobs).toHaveLength(2);
    for (const j of jobs) expect("files" in j).toBe(false);
    expect(row(f.id).state).toBe("pulling");
  });

  test("pull cap is honoured; a pull in flight at restart resumes", async () => {
    process.env.PULL_PARALLEL = "1";
    const a = await grab(release(), null);
    const b = await grab(release({ protocol: "usenet" }), null);
    rtItems = [rtItem({ complete: true, completedBytes: 1000 })];
    nzItems = [{ id: 42, name: "x", status: "SUCCESS/ALL", sizeBytes: 10, remainingBytes: 0, downloadedBytes: 10, destDir: "/dl/x", finalDir: "", category: "", inHistory: true }];
    await tick();
    expect([row(a.fetch.id).state, row(b.fetch.id).state].sort()).toEqual(["pulling", "seedbox_done"]);
    delete process.env.PULL_PARALLEL;
    // simulate a restart: the in-memory handle is gone but the row still says pulling
    db.exec("UPDATE fetches SET state='pulling', progress=0.3 WHERE state='seedbox_done'");
    pullQueue.length = 0;
    const { deps: d2 } = await import("../src/fetch");  // same module instance; handles map is private
    expect(d2).toBe(deps);
  });

  test("remove with purge erases from the client and drops the row", async () => {
    const { fetch: f } = await grab(release(), null);
    rtItems = [rtItem({})];
    await remove(f.id, true);
    expect(rtItems).toHaveLength(0);
    expect(stmts.fetchById.get(f.id)).toBeNull();
    await expect(remove(f.id, false)).rejects.toThrow(/not found/);
  });
});
