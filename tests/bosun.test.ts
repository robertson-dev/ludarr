import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRtorrentRc, parseNzbgetConf, nzbgetUrlCandidates, detectWebBase, expandHome } from "../src/bosun/detect";
import { Roots } from "../src/bosun/fs";
import { createBosunApp, type BosunCtx } from "../src/bosun/app";
import { fromRtorrent, fromNzbget, parseItemId, itemId } from "../src/seedbox-items";
import type { RtItem } from "../src/rtorrent";
import type { NzbItem } from "../src/nzbget";

const INFO = "d6:lengthi1000e4:name8:TestGame12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe";
const TORRENT = new TextEncoder().encode(`d8:announce13:http://tr/ann4:info${INFO}e`);
const HASH = new Bun.CryptoHasher("sha1").update(new TextEncoder().encode(INFO)).digest("hex").toUpperCase();

describe("detect", () => {
  test("rtorrent rc: scgi + default dir, ~ expanded, comments ignored", () => {
    const rc = parseRtorrentRc(`
# comment
directory.default.set = ~/downloads
session.path.set = /home/u/.config/.session
network.scgi.open_port = 127.0.0.1:5039   # inline comment
`, "/home/u");
    expect(rc).toEqual({ scgi: "127.0.0.1:5039", defaultDir: "/home/u/downloads", session: "/home/u/.config/.session" });
    expect(parseRtorrentRc("scgi_local = ~/.rtorrent.sock\ndirectory = /dl/", "/h").scgi).toBe("/h/.rtorrent.sock");
    expect(parseRtorrentRc("directory = /dl/", "/h").defaultDir).toBe("/dl");
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~x", "/h")).toBe("~x");
  });
  test("nzbget conf: creds, port, ${MainDir} substitution", () => {
    const c = parseNzbgetConf(`MainDir=/home/u/downloads\nDestDir=\${MainDir}/complete\nInterDir=\${MainDir}/intermediate\nControlUsername=u\nControlPassword=p=w\nControlPort=6789\n# x\n`);
    expect(c).toEqual({ user: "u", pass: "p=w", port: 6789, destDir: "/home/u/downloads/complete", interDir: "/home/u/downloads/intermediate", mainDir: "/home/u/downloads" });
  });
  test("nzbget url candidates: seedhost layout first", () => {
    expect(nzbgetUrlCandidates("user", "box.example.eu", 6789)).toEqual([
      "https://box.example.eu/user/nzbget", "https://user.box.example.eu/nzbget", "http://127.0.0.1:6789",
    ]);
  });
  test("web base: finds the vhost tree that links to the downloads dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "ahoy-home-"));
    const dl = join(home, "downloads");
    mkdirSync(dl);
    mkdirSync(join(home, "www", "u.box.example.eu", "u"), { recursive: true });
    mkdirSync(join(home, "www", "u.box.example.eu", "rutorrent"));
    symlinkSync(dl, join(home, "www", "u.box.example.eu", "u", "downloads"), process.platform === "win32" ? "junction" : "dir");
    const web = await detectWebBase(dl, home);
    expect(web?.webBase).toBe("https://u.box.example.eu/u/downloads");
    expect(web?.webRoot).toBe(await Bun.file(dl).exists().then(() => require("node:fs").realpathSync(dl)));
    expect(await detectWebBase(join(home, "nope"), home)).toBeNull();
  });
});

describe("seedbox items", () => {
  test("ids round-trip", () => {
    expect(parseItemId(itemId("rtorrent", "abc"))).toEqual({ client: "rtorrent", clientId: "ABC" });
    expect(parseItemId(itemId("nzbget", "41"))).toEqual({ client: "nzbget", clientId: "41" });
    expect(parseItemId("x:1")).toBeNull();
  });
  test("rtorrent + nzbget rows map to one shape", () => {
    const rt: RtItem = { hash: HASH, name: "G", complete: false, active: true, sizeBytes: 100, completedBytes: 25, downRate: 5, directory: "/d", multiFile: false, label: "ahoy", message: "", dataPath: "/d/G" };
    expect(fromRtorrent(rt)).toMatchObject({ id: `rt:${HASH}`, state: "downloading", progress: 0.25, path: "/d/G", isDir: false });
    expect(fromRtorrent({ ...rt, complete: true }).state).toBe("done");
    expect(fromRtorrent({ ...rt, active: false }).state).toBe("paused");
    const nz: NzbItem = { id: 7, name: "N", status: "DOWNLOADING", sizeBytes: 100, remainingBytes: 60, downloadedBytes: 40, destDir: "/c/N", finalDir: "", category: "ahoy", inHistory: false };
    expect(fromNzbget(nz)).toMatchObject({ id: "nz:7", clientId: "7", state: "downloading", progress: 0.4, path: null, isDir: true });
    expect(fromNzbget({ ...nz, inHistory: true, status: "SUCCESS/UNPACK" })).toMatchObject({ state: "done", path: "/c/N", progress: 1 });
    expect(fromNzbget({ ...nz, inHistory: true, status: "FAILURE/PAR" })).toMatchObject({ state: "failed", message: "FAILURE/PAR" });
  });
});

describe("bosun app", () => {
  let root: string, app: ReturnType<typeof createBosunApp>, ctx: BosunCtx;
  const auth = { authorization: "Bearer tok" };
  const rtCalls: unknown[] = [], nzCalls: unknown[] = [];
  let rtItems: RtItem[] = [];
  let nzItems: NzbItem[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ahoy-roots-"));
    mkdirSync(join(root, "dl", "Game"), { recursive: true });
    writeFileSync(join(root, "dl", "Game", "a.bin"), "0123456789");
    writeFileSync(join(root, "dl", "single.iso"), "hello world");
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "secret"), "no");
    const fakeRt = {
      version: async () => "0.9.8", list: async () => rtItems,
      get: async (h: string) => rtItems.find(i => i.hash === h) ?? null,
      addTorrent: async (b: Uint8Array, o: unknown) => { rtCalls.push({ kind: "torrent", len: b.length, o }); },
      addMagnet: async (u: string, o: unknown) => { rtCalls.push({ kind: "magnet", u, o }); },
      erase: async (h: string) => { rtCalls.push({ kind: "erase", h }); },
    };
    const fakeNz = {
      version: async () => "26.0", snapshot: async () => nzItems,
      get: async (id: number) => nzItems.find(i => i.id === id) ?? null,
      add: async (name: string, b: Uint8Array, cat: string) => { nzCalls.push({ name, len: b.length, cat }); return 99; },
      remove: async (id: number, hist: boolean) => { nzCalls.push({ remove: id, hist }); },
    };
    ctx = {
      token: "tok", version: "0.1.0-test", selfHash: () => "deadbeef", startedAt: Date.now(), host: "box", user: "u",
      rtorrent: fakeRt as any, nzbget: fakeNz as any, rtOpts: { label: "ahoy" }, nzbCategory: "ahoy",
      roots: await Roots.of([join(root, "dl")]), downloadsDir: join(root, "dl"), webBase: "https://box/u/downloads", webRoot: join(root, "dl"),
      rtorrentScgi: "127.0.0.1:5039", nzbgetUrl: "https://box/u/nzbget", diskFree: async () => ({ free: 1, total: 2 }), tools: { "7z": "/usr/bin/7z" },
    };
    app = createBosunApp(ctx);
  });

  test("bearer token required", async () => {
    expect((await app.request("/v1/status")).status).toBe(401);
    expect((await app.request("/v1/status", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await app.request("/v1/status", { headers: auth })).status).toBe(200);
  });
  test("status reports what was detected", async () => {
    const s = await (await app.request("/v1/status", { headers: auth })).json() as any;
    expect(s).toMatchObject({ ok: true, version: "0.1.0-test", hash: "deadbeef", host: "box", webBase: "https://box/u/downloads", disk: { free: 1, total: 2 } });
    expect(s.rtorrent).toMatchObject({ ok: true, version: "0.9.8" });
    expect(s.nzbget).toMatchObject({ ok: true, version: "26.0" });
  });
  test("items merge both clients; a missing client is reported, not fatal", async () => {
    rtItems = [{ hash: HASH, name: "G", complete: true, active: true, sizeBytes: 10, completedBytes: 10, downRate: 0, directory: "/d/G", multiFile: true, label: "ahoy", message: "", dataPath: "/d/G" }];
    nzItems = [{ id: 7, name: "N", status: "DOWNLOADING", sizeBytes: 100, remainingBytes: 60, downloadedBytes: 40, destDir: "/c/N", finalDir: "", category: "ahoy", inHistory: false }];
    const j = await (await app.request("/v1/items", { headers: auth })).json() as any;
    expect(j.items.map((i: any) => i.id)).toEqual([`rt:${HASH}`, "nz:7"]);
    expect(j.errors).toEqual({});
    const one = await (await app.request(`/v1/items/rt:${HASH.toLowerCase()}`, { headers: auth })).json() as any;
    expect(one.item.state).toBe("done");
    expect((await app.request("/v1/items/nz:8", { headers: auth })).status).toBe(404);
    const saved = ctx.nzbget; ctx.nzbget = null;
    const j2 = await (await app.request("/v1/items", { headers: auth })).json() as any;
    expect(j2.errors.nzbget).toBe("not detected");
    expect(j2.items).toHaveLength(1);
    ctx.nzbget = saved;
  });
  test("POST torrent → hash computed here, added once with the label", async () => {
    rtItems = [];
    const body = JSON.stringify({ kind: "torrent", data: Buffer.from(TORRENT).toString("base64") });
    const r = await app.request("/v1/items", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: `rt:${HASH}`, client: "rtorrent", clientId: HASH, infoHash: HASH, name: "TestGame", size: 1000 });
    expect(rtCalls).toEqual([{ kind: "torrent", len: TORRENT.length, o: { label: "ahoy" } }]);
    const bad = await app.request("/v1/items", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ kind: "torrent", data: "AAAA" }) });
    expect(bad.status).toBe(400);
  });
  test("POST magnet / nzb", async () => {
    const m = await app.request("/v1/items", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ kind: "magnet", uri: `magnet:?xt=urn:btih:${HASH}&dn=G` }) });
    expect(await m.json()).toMatchObject({ client: "rtorrent", clientId: HASH });
    expect(rtCalls.at(-1)).toMatchObject({ kind: "magnet" });
    const n = await app.request("/v1/items", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ kind: "nzb", name: "g.nzb", data: Buffer.from("<nzb/>").toString("base64") }) });
    expect(n.status).toBe(201);
    expect(await n.json()).toMatchObject({ id: "nz:99", client: "nzbget", clientId: "99" });
    expect(nzCalls).toEqual([{ name: "g.nzb", len: 6, cat: "ahoy" }]);
  });
  test("DELETE drops it from the client", async () => {
    nzItems = [{ id: 7, name: "N", status: "SUCCESS/ALL", sizeBytes: 1, remainingBytes: 0, downloadedBytes: 1, destDir: "/c/N", finalDir: "", category: "ahoy", inHistory: true }];
    expect((await app.request(`/v1/items/rt:${HASH}`, { method: "DELETE", headers: auth })).status).toBe(200);
    expect(rtCalls.at(-1)).toEqual({ kind: "erase", h: HASH });
    expect((await app.request("/v1/items/nz:7", { method: "DELETE", headers: auth })).status).toBe(200);
    expect(nzCalls.at(-1)).toEqual({ remove: 7, hist: true });
  });
  test("fs: stat / ls / file with Range, fenced to the roots", async () => {
    const st = await (await app.request(`/v1/fs/stat?path=${encodeURIComponent(join(root, "dl", "single.iso"))}`, { headers: auth })).json() as any;
    expect(st).toMatchObject({ size: 11, isDir: false });
    const ls = await (await app.request(`/v1/fs/ls?path=${encodeURIComponent(join(root, "dl"))}`, { headers: auth })).json() as any;
    expect(ls.entries.map((e: any) => [e.name, e.isDir, e.size])).toEqual([["Game", true, 0], ["single.iso", false, 11]]);
    const f = join(root, "dl", "single.iso");
    const whole = await app.request(`/v1/fs/file?path=${encodeURIComponent(f)}`, { headers: auth });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await whole.text()).toBe("hello world");
    const part = await app.request(`/v1/fs/file?path=${encodeURIComponent(f)}`, { headers: { ...auth, range: "bytes=6-" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(await part.text()).toBe("world");
    const tail = await app.request(`/v1/fs/file?path=${encodeURIComponent(f)}`, { headers: { ...auth, range: "bytes=-3" } });
    expect(await tail.text()).toBe("rld");
    const head = await app.request(`/v1/fs/file?path=${encodeURIComponent(f)}`, { method: "HEAD", headers: { ...auth, range: "bytes=0-3" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("4");
    expect((await app.request(`/v1/fs/file?path=${encodeURIComponent(f)}`, { headers: { ...auth, range: "bytes=50-60" } })).status).toBe(416);
    expect((await app.request(`/v1/fs/file?path=${encodeURIComponent(join(root, "elsewhere", "secret"))}`, { headers: auth })).status).toBe(403);
    expect((await app.request(`/v1/fs/file?path=${encodeURIComponent(join(root, "dl", "missing"))}`, { headers: auth })).status).toBe(404);
    expect((await app.request(`/v1/fs/file?path=relative`, { headers: auth })).status).toBe(400);
    expect((await app.request(`/v1/fs/file?path=${encodeURIComponent(join(root, "dl", "Game"))}`, { headers: auth })).status).toBe(400);
  });
});
