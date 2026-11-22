/**
 * Requests for a game that has a way to play, end to end (src/requests.ts + src/ways/find.ts): the real searcher against a
 * fake indexer, a fake download client, the content job and the way's build with a fake release host and 7z. A member's
 * request for a hand-added N64 game with a hashed recomp ends with the recomp built and no console dump; an emulator way
 * that cannot prove the file keeps it for the admin and builds nothing; a way whose serial check refuses a download
 * moves on to the next candidate, the release blocked for that way only; a PS2 way with the catalog's serials takes the
 * right disc and refuses another game's; a game with no ways searches exactly as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiKey, downloadsDir } from "../src/config";
import { db, stmts, type FetchRow, type GameRow, type JobRow, type PackageRow, type RequestRow } from "../src/db";
import { ingest as catalogIngest } from "../src/catalog/store";
import { datdeps, forgetDats, loadDat } from "../src/catalog/providers/dats";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { statusOf } from "../src/library/games";
import { pdeps } from "../src/process/deps";
import { runJob } from "../src/process/runner";
import type { Indexer, Release } from "../src/plugins/types";
import { createRequest, rdeps, requestsTick } from "../src/requests";
import { sdeps, searchReleases } from "../src/search";
import { app } from "../src/server";
import { ctdeps } from "../src/ways/content";
import { fdeps } from "../src/ways/find";
import { prdeps } from "../src/ways/program";
import { sbdeps } from "../src/ways/sandbox";
import { contentIdentity, getContent, getWay, heldFile, insertPlan, type ContentRow } from "../src/ways/store";
import { enqueueJob } from "../src/process/kinds";
import type { PlanKind, RuntimePlanSpec } from "../src/ways/types";
import { validatePlanSpec } from "../src/ways/validate";
import { bytes, fake7z, releaseHost, restoreDeps, sha1, sha256, tempConfig, tools7z } from "./ways-fixtures";
import { n64Rom, nintendoIso, psIso } from "./ways-images";

/* ─────────── the program releases (a recomp, an N64 emulator, a PS2 emulator) ─────────── */

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(3000, 7)]), SEVEN = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, ...bytes(3000, 8)]), EMU = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(3000, 9)]);
const CUBE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(3000, 11)]);
const REL = {
  recomp: { asset: "SynthRecomp-v1.0-Windows.zip", url: "https://github.com/synth/recomp/releases/download/v1.0/SynthRecomp-v1.0-Windows.zip", data: ZIP },
  n64emu: { asset: "SynthEmu-v2.0-win64.zip", url: "https://github.com/synth/emu/releases/download/v2.0/SynthEmu-v2.0-win64.zip", data: EMU },
  ps2emu: { asset: "synth2-v3.0-windows-x64-Qt.7z", url: "https://github.com/synth/ps2/releases/download/v3.0/synth2-v3.0-windows-x64-Qt.7z", data: SEVEN },
  gcemu: { asset: "SynthCube-v4.0-win64.zip", url: "https://github.com/synth/gc/releases/download/v4.0/SynthCube-v4.0-win64.zip", data: CUBE },
};
const relFor = (r: { asset: string; url: string; data: Uint8Array }) => ({ tag: r.asset.match(/v\d\.\d/)![0], name: null, date: "2026-01-01", prerelease: false, page: null, immutable: true, asset: { name: r.asset, url: r.url, size: r.data.byteLength, digest: `sha256:${sha256(r.data)}` } });
const program = (exe: string) => (out: string) => { mkdirSync(join(out, "prog"), { recursive: true }); writeFileSync(join(out, "prog", exe), bytes(5000, 3)); };

const N64_FORMATS = ["z64", "v64", "n64"];
function plan(name: string, kind: PlanKind, repo: string, raw: Partial<RuntimePlanSpec>) {
  const checked = validatePlanSpec({ files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...raw }, kind);
  if (!checked.ok) throw new Error(`the test plan does not validate: ${checked.errors.join("; ")}`);
  const p = insertPlan({ name, kind, repo, platforms: [checked.value!.content?.platform ?? "pc"], spec: checked.value!, status: "ready" });
  made.plans.push(p.id);
  return p;
}
const recompPlan = (sha: string) => plan("Synth Recomp", "recomp", "synth/recomp", {
  program: { kind: "release", assetPattern: "^SynthRecomp-v.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "synth.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "Synthetic Quest NTSC-U 1.0", search: ["Synthetic Quest"], accept: { hashes: [{ algo: "sha1", value: sha }], formats: N64_FORMATS, regions: ["US"] }, normalize: "n64-z64", place: "rom.z64" },
});
const n64EmuPlan = () => plan("Synth N64 Emu", "emulator", "synth/emu", {
  program: { kind: "release", assetPattern: "^SynthEmu-v.*-win64[.]zip$", channel: "stable" }, launch: { exe: "emu.exe", argv: ["{content}"] },
  content: { kind: "rom", platform: "n64", what: "an N64 ROM", search: ["n64"], accept: { hashes: [], formats: N64_FORMATS }, normalize: "n64-z64", place: "games/{name}" },
});
const ps2EmuPlan = (name = "Synth PS2 Emu") => plan(name, "emulator", name === "Synth PS2 Emu" ? "synth/ps2" : "synth/ps2b", {
  program: { kind: "release", assetPattern: "windows-x64-Qt\\.7z$", channel: "stable" }, launch: { exe: "synth2.exe", argv: ["-batch", "--", "{content}"] },
  content: { kind: "disc", platform: "ps2", what: "a PS2 disc image", search: ["ps2"], accept: { hashes: [], formats: ["iso"] }, normalize: null, place: "games/{name}" },
});
const gcEmuPlan = () => plan("Synth GC Emu", "emulator", "synth/gc", {
  program: { kind: "release", assetPattern: "^SynthCube-v.*-win64[.]zip$", channel: "stable" }, launch: { exe: "cube.exe", argv: ["-e", "{content}"] },
  content: { kind: "disc", platform: "gc", what: "a GameCube disc image", search: ["gc"], accept: { hashes: [], formats: ["iso", "rvz"] }, normalize: null, place: "games/{name}" },
});

/* ─────────── the indexer, the download client and what each release downloads to ─────────── */

const rel = (title: string, over: Partial<Release> = {}): Release => ({
  guid: `guid:${title}`, title, instanceId: 1, indexerId: 1, indexer: "Fake", size: 20e6, age: 3, publishDate: "", seeders: 10, leechers: 0,
  grabs: null, files: null, downloadUrl: "http://indexer/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent", categories: [], indexerFlags: [], fileName: null, ...over,
});
let listing: Release[] = [];
/** what 7z unpacks from each archive, by name: the programs' releases, and the archives a test's downloads hold */
const archives: Record<string, (out: string) => void> = {};
const asked: { term: string; categories: number[] | null }[] = [];
const grabbed: string[] = [];
/** release title → what the download holds (written into its folder when the transfer finishes) */
let payloads: Record<string, (dir: string) => void> = {};

const made = { games: [] as number[], plans: [] as number[] };
let cfg: ReturnType<typeof tempConfig>;
const saved = { rdeps: { ...rdeps }, sdeps: { ...sdeps }, ctdeps: { ...ctdeps }, datdeps: { ...datdeps }, fdeps: { ...fdeps } };

beforeAll(() => {
  cfg = tempConfig();
  ensureDefaultRootFolder();
});
afterAll(() => {
  Object.assign(rdeps, saved.rdeps); Object.assign(sdeps, saved.sdeps); Object.assign(ctdeps, saved.ctdeps); Object.assign(datdeps, saved.datdeps); Object.assign(fdeps, saved.fdeps);
  forgetDats();
  for (const id of made.games) for (const t of ["requests", "jobs", "contents", "blocklist", "packages", "fetches", "history"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  db.exec("DELETE FROM routes WHERE source='compat-pcsx2'");
  cfg.restore();
});
beforeEach(() => {
  listing = []; asked.length = 0; grabbed.length = 0; payloads = {};
  pdeps.log = () => {};
  pdeps.tools = () => tools7z;
  sbdeps.platform = () => "win32";                                           // a dev box: no sandbox, 7z runs as this user
  for (const k of Object.keys(archives)) delete archives[k];
  Object.assign(archives, { [REL.recomp.asset]: program("synth.exe"), [REL.n64emu.asset]: program("emu.exe"), [REL.gcemu.asset]: program("cube.exe"), [REL.ps2emu.asset]: (out: string) => writeFileSync(join(out, "synth2.exe"), bytes(5000, 4)) });
  sbdeps.exec = fake7z(archives);                                           // looked up when 7z runs: a test adds its downloads' archives
  releaseHost({ [REL.recomp.url]: REL.recomp.data, [REL.n64emu.url]: REL.n64emu.data, [REL.ps2emu.url]: REL.ps2emu.data, [REL.gcemu.url]: REL.gcemu.data });
  prdeps.latestRelease = async repo => relFor(repo === "synth/recomp" ? REL.recomp : repo === "synth/emu" ? REL.n64emu : repo === "synth/gc" ? REL.gcemu : REL.ps2emu);
  ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
  datdeps.fetchText = async () => { throw new Error("offline"); };
  forgetDats();
  rmSync(datdeps.dir(), { recursive: true, force: true });                  // no dump list is kept unless a test keeps one
  fdeps.activeSources = () => new Set(["compat-pcsx2"]);
  const indexer: Indexer = {
    test: async () => ({ ok: true, detail: "" }),
    download: async () => { throw new Error("no"); },
    // dumps are filed under consoles: a PC search (4000) finds nothing, a console pass (every category) finds them
    search: async (term: string, opt?: { categories?: number[] }) => { asked.push({ term, categories: opt?.categories ?? null }); return (opt?.categories ?? [4000]).length === 0 ? listing : []; },
  };
  sdeps.indexers = () => [{ id: 1, name: "Fake", indexer }];
  rdeps.search = searchReleases;
  rdeps.usenetAvailable = async () => false;
  rdeps.log = () => {};
  rdeps.now = () => Date.now();
  rdeps.grab = async (r, gameId) => {
    grabbed.push(r.title);
    const f = stmts.insertFetch({ game_id: gameId, guid: r.guid, indexer_id: 1, indexer: "Fake", title: r.title, protocol: r.protocol, size: r.size, info_hash: null, client: "rtorrent", client_id: `c-${grabbed.length}`, state: "submitted", release_json: JSON.stringify(r) });
    return { fetch: f as never, duplicate: false };
  };
});
afterEach(() => { restoreDeps(); });

const req = (id: number) => stmts.requestById.get(id) as RequestRow;
const fetchOf = (r: RequestRow) => stmts.fetchById.get(r.fetch_id!) as FetchRow;
/**
 * The request carried as far as it goes: a grabbed release's download lands (what `payloads` says it holds) and its
 * transfer finishes, each queued job runs, the searcher ticks — until the request is done or waits for a later search.
 */
async function drive(id: number, rounds = 30): Promise<RequestRow> {
  for (let i = 0; i < rounds; i++) {
    await requestsTick();
    const r = req(id);
    if (["ready", "failed", "cancelled"].includes(r.state) || (r.state === "requested" && r.next_try_at)) return r;
    if (r.state === "fetching") {
      const f = fetchOf(r);
      if (f.state === "submitted") {
        const dir = join(downloadsDir(), `dl-${f.id}`);
        mkdirSync(dir, { recursive: true });
        (payloads[f.title] ?? (() => { throw new Error(`the test has no download for ${f.title}`); }))(dir);
        stmts.setFetchDone.run(dir, f.id);
      }
    }
    if (r.state === "processing") {
      const j = stmts.jobById.get(r.job_id!) as JobRow;
      if (j.state === "queued") await runJob(j.id);
    }
  }
  return req(id);
}
const call = async (path: string, init: RequestInit = {}) => {
  const r = await app.request(path, { ...init, headers: { "x-api-key": apiKey(), "content-type": "application/json", ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.json() as any };
};
async function manualGame(name: string, platforms: string[], year: number): Promise<GameRow> {
  const r = await call("/api/v1/game", { method: "POST", body: JSON.stringify({ source: "manual", game: { name, year, platforms }, searchNow: false }) });
  expect(r.status).toBe(201);
  made.games.push(r.body.item.id);
  return stmts.gameById.get(r.body.item.id) as GameRow;
}
const addWay = async (g: GameRow, planId: number, content?: unknown) => {
  // force: these synthetic plans name made-up games; the wrong-game guard of POST /game/:id/ways is tested elsewhere
  const r = await call(`/api/v1/game/${g.id}/ways`, { method: "POST", body: JSON.stringify({ planId, force: true, ...(content ? { content } : {}) }) });
  expect(r.status).toBe(201);
  return r.body.item as { id: number; content: { accept: { serials?: string[] } } };
};
const contentJobs = (gameId: number) => db.query("SELECT * FROM jobs WHERE game_id=? AND kind='content' ORDER BY id").all(gameId) as JobRow[];
const packagesOf = (gameId: number) => (db.query("SELECT * FROM packages WHERE game_id=? ORDER BY id").all(gameId) as PackageRow[]).map(p => ({ id: p.id, kind: JSON.parse(p.manifest_json).kind as string }));
const gameFiles = (gameId: number) => db.query("SELECT * FROM contents WHERE game_id=? AND role='game' ORDER BY id").all(gameId) as ContentRow[];

describe("a request for a game with a way to play", () => {
  test("a member's request for a hand-added N64 game with a hashed recomp ends with the recomp built — no console dump, ever", async () => {
    const rom = n64Rom({ code: "NSQE", name: "SYNTH QUEST", seed: 21 });
    const g = await manualGame("Synthetic Quest", ["n64"], 1999);
    const recomp = recompPlan(sha1(rom));
    const way = await addWay(g, recomp.id);
    // what the indexer has: the better-seeded beta, the No-Intro dump (no console in its name), a European dump the recomp
    // does not take, and the dump as a byte-swapped .v64 inside a zip
    listing = [
      rel("Synthetic Quest (USA) (Beta)", { seeders: 90 }),
      rel("Synthetic Quest (USA)", { seeders: 40 }),
      rel("Synthetic Quest (Europe) N64", { seeders: 70 }),
    ];
    const v64 = n64Rom({ code: "NSQE", name: "SYNTH QUEST", seed: 21, order: "v64" });
    archives["Synthetic Quest (USA).zip"] = out => writeFileSync(join(out, "Synthetic Quest (USA).v64"), v64);
    payloads["Synthetic Quest (USA)"] = dir => { writeFileSync(join(dir, "Synthetic Quest (USA).zip"), new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])); writeFileSync(join(dir, "info.nfo"), "release notes"); };
    // the member presses Request in Ahoy: the game's Search
    const s = await call(`/api/v1/game/${g.id}/search`, { method: "POST" });
    expect(s.status).toBeLessThan(300);
    const id = (db.query("SELECT id FROM requests WHERE game_id=? ORDER BY id DESC LIMIT 1").get(g.id) as { id: number }).id;
    expect(req(id).way_id).toBe(way.id);
    const r = await drive(id);
    expect(grabbed).toEqual(["Synthetic Quest (USA)"]);                      // never the beta, never the other region
    expect(asked.every(a => a.categories?.length === 0)).toBe(true);          // the way's console pass only: no PC search
    expect(r).toMatchObject({ state: "ready", stage: "imported", progress: 1 });
    expect(packagesOf(g.id)).toEqual([{ id: r.package_id!, kind: "recomp" }]);
    expect(getWay(way.id)).toMatchObject({ status: "built", package_id: r.package_id });
    // the file kept is the dump put in big-endian order, its bytes' identity with it; the download was taken in for good
    const [kept] = gameFiles(g.id);
    expect(kept).toMatchObject({ source: "indexer", platform: "n64", name: "Synthetic Quest (USA).z64", normalized: "n64 byte order v64 → z64" });
    expect(contentIdentity(kept)).toMatchObject({ platform: "n64", gameCode: "NSQE" });
    const f = stmts.fetchById.get(r.fetch_id!) as FetchRow;
    expect(f.imported_at).not.toBeNull();
    expect(existsSync(f.local_path!)).toBe(false);
    const [taken] = contentJobs(g.id);
    expect(taken).toMatchObject({ state: "done", fetch_id: f.id, request_id: id });
    expect(taken.transcript).toContain("unpacking Synthetic Quest (USA).zip");
    expect(taken.transcript).toContain("Synthetic Quest (USA).v64: the game file — its sha1 is one the way accepts");
    expect(JSON.parse(taken.manifest_json!)).toMatchObject({ outcome: "proven", wayId: way.id, by: "hash", file: "Synthetic Quest (USA).z64" });
    // the game's next request is ready at once: its way is built
    const again = createRequest({ gameId: g.id, by: "auto" });
    await requestsTick();
    expect(req(again.request.id)).toMatchObject({ state: "ready", package_id: r.package_id, way_id: null });
  }, 30_000);

  test("a console dump the game already has does not end the request: the way's file is searched for, and its build replaces the dump", async () => {
    const rom = n64Rom({ code: "NSRE", seed: 31 });
    const g = await manualGame("Synthetic Return", ["n64"], 2001);
    const recomp = recompPlan(sha1(rom));
    await addWay(g, recomp.id);
    // an earlier import left a beta dump as the game's console copy
    const dumpDir = join(process.env.AHOY_LIBRARY!, `synthetic-return-dump`);
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "Synthetic Return (Beta).z64"), n64Rom({ code: "NSRE", seed: 32 }));
    stmts.insertPackage.get(g.id, null, dumpDir, g.name, null, 1, JSON.stringify({ kind: "rom", platform: "n64", launch: { exe: "Synthetic Return (Beta).z64", args: "", cwd: "" }, files: [] }));
    listing = [rel("Synthetic Return (USA) N64", { seeders: 5 })];
    payloads["Synthetic Return (USA) N64"] = dir => writeFileSync(join(dir, "Synthetic Return (USA).z64"), rom);
    const s = await call(`/api/v1/game/${g.id}/search`, { method: "POST" });
    expect(s.status).toBeLessThan(300);                                      // not "already has a copy": the dump is no copy players can start
    const id = (db.query("SELECT id FROM requests WHERE game_id=? ORDER BY id DESC LIMIT 1").get(g.id) as { id: number }).id;
    const r = await drive(id);
    expect(r.state).toBe("ready");
    expect(packagesOf(g.id).map(p => p.kind)).toEqual(["recomp"]);
  }, 30_000);

  test("an emulator way that cannot prove the file keeps it for the admin: needs-files, the file named, nothing built", async () => {
    const g = await manualGame("Synthetic Saga 64", ["n64"], 2000);
    const emu = n64EmuPlan();
    const way = await addWay(g, emu.id);
    expect(way.content.accept.serials ?? []).toEqual([]);
    listing = [rel("Synthetic Saga 64 (USA)", { seeders: 50 }), rel("Synthetic Saga 64 (USA) N64", { seeders: 5 })];
    payloads["Synthetic Saga 64 (USA) N64"] = dir => writeFileSync(join(dir, "Synthetic Saga 64 (USA).z64"), n64Rom({ code: "NS6E", name: "SYNTH SAGA 64", seed: 41 }));
    const { request } = createRequest({ gameId: g.id, by: "add" });
    const r = await drive(request.id);
    expect(grabbed).toEqual(["Synthetic Saga 64 (USA) N64"]);                // a name with no console only for a way that can prove the file
    expect(r).toMatchObject({ state: "failed", stage: "kept the game file for a look" });
    expect(r.message).toMatch(/^kept Synthetic Saga 64 \(USA\)\.z64: its header says "SYNTH SAGA 64" \(game code NS6E\), and nothing the way accepts proves it is the game/);
    expect(packagesOf(g.id)).toEqual([]);
    const w = getWay(way.id)!;
    expect(w).toMatchObject({ status: "needs-files", content_id: null });
    expect(w.status_note).toMatch(/Synthetic Saga 64 \(USA\)\.z64 came from the indexers, and nothing could prove it is the game — accept it if it is/);
    const [kept] = gameFiles(g.id);
    expect(kept).toMatchObject({ source: "indexer", platform: "n64" });
    expect(existsSync(kept.path)).toBe(true);
    expect(db.query("SELECT guid, way_id FROM blocklist WHERE game_id=?").all(g.id)).toEqual([{ guid: "guid:Synthetic Saga 64 (USA) N64", way_id: way.id }]);
    // a later search fetches nothing more while the file waits: the admin accepts it (or removes it)
    grabbed.length = 0;
    const later = createRequest({ gameId: g.id, by: "auto" });
    const r2 = await drive(later.request.id);
    expect(r2).toMatchObject({ state: "failed", stage: "a game file waits for a look" });
    expect(grabbed).toEqual([]);
    // accepted by hand, the next request builds it
    const acc = await call(`/api/v1/way/${way.id}/accept-file`, { method: "POST", body: JSON.stringify({ contentId: kept.id }) });
    expect(acc.status).toBe(200);
    const third = createRequest({ gameId: g.id, by: "auto" });
    const r3 = await drive(third.request.id);
    expect(r3.state).toBe("ready");
    expect(packagesOf(g.id).map(p => p.kind)).toEqual(["emulated"]);
  }, 30_000);

  test("a download whose header is another game's is refused for that way only, and the next candidate is the game (the admin's Find)", async () => {
    const g = await manualGame("Synthetic Tale 64", ["n64"], 2000);
    const emu = n64EmuPlan();
    const way = await addWay(g, emu.id);
    // the admin wrote the game code the way takes
    const content = { ...way.content, accept: { ...way.content.accept, serials: ["NUS-NSTE-USA"] } };
    expect((await call(`/api/v1/way/${way.id}`, { method: "PUT", body: JSON.stringify({ content }) })).status).toBe(200);
    // the scene release ranks first (its group, its console tag) and holds another game; the No-Intro dump is the game
    listing = [rel("Synthetic.Tale.64.USA.N64-GRP", { seeders: 10 }), rel("Synthetic Tale 64 (USA)", { seeders: 40 })];
    payloads["Synthetic.Tale.64.USA.N64-GRP"] = dir => writeFileSync(join(dir, "stale64-grp.z64"), n64Rom({ code: "NOTE", name: "SYNTH TALE 64", seed: 51 }));
    payloads["Synthetic Tale 64 (USA)"] = dir => writeFileSync(join(dir, "Synthetic Tale 64 (USA).z64"), n64Rom({ code: "NSTE", name: "SYNTH TALE 64", seed: 52 }));
    const find = await call(`/api/v1/way/${way.id}/find-files`, { method: "POST" });
    expect(find.status).toBe(202);
    const r = await drive(find.body.request.id);
    expect(grabbed).toEqual(["Synthetic.Tale.64.USA.N64-GRP", "Synthetic Tale 64 (USA)"]);
    expect(r.state).toBe("ready");
    expect(packagesOf(g.id).map(p => p.kind)).toEqual(["emulated"]);
    const blocked = db.query("SELECT guid, way_id, reason FROM blocklist WHERE game_id=?").all(g.id) as { guid: string; way_id: number; reason: string }[];
    expect(blocked).toEqual([{ guid: "guid:Synthetic.Tale.64.USA.N64-GRP", way_id: way.id, reason: expect.stringMatching(/another game \(its game code is NOTE, and this takes NUS-NSTE-USA\)/) }]);
    expect(stmts.blocklistForGame.all(g.id)).toEqual([]);                    // the game's own search could still take it
    // only the proven file was kept: the other game's never entered the store
    expect(gameFiles(g.id).map(f => f.name)).toEqual(["Synthetic Tale 64 (USA).z64"]);
  }, 30_000);

  test("a PS2 way with the catalog's serials takes the right disc and refuses another game's; another way may still try that one", async () => {
    catalogIngest({ id: "compat-pcsx2", metaRank: 25 }, [
      { title: { ids: [{ scheme: "serial", value: "SLUS-21678" }, { scheme: "serial", value: "SLES-54206" }], name: "Synthetic Saga", platforms: ["ps2"] },
        routes: [{ key: "pcsx2:SLES-54206", kind: "emulated", platform: "ps2", provenance: "retail", runtime: "pcsx2", content: { kind: "disc", platform: "ps2", accept: { serials: ["SLUS-21678", "SLES-54206"] }, from: [] } }] },
    ]);
    const g = await manualGame("Synthetic Saga", ["ps2"], 2007);
    const emu = ps2EmuPlan();
    const way = await addWay(g, emu.id);
    expect(way.content.accept.serials).toEqual(["SLUS-21678", "SLES-54206"]);      // copied from the catalog as the way was made
    // the scene release (first by score) is another game's disc; the Redump-named one holds the game in a 7z
    listing = [rel("Synthetic.Saga.USA.PS2DVD-GRP", { seeders: 10, size: 4e9 }), rel("Synthetic Saga (USA)", { seeders: 50, size: 4e9 })];
    payloads["Synthetic.Saga.USA.PS2DVD-GRP"] = dir => writeFileSync(join(dir, "ssaga-grp.iso"), psIso({ boot: "cdrom0:\\SLUS_200.00;1", seed: 61 }));
    archives["synthetic-saga.7z"] = out => writeFileSync(join(out, "Synthetic Saga (USA).iso"), psIso({ boot: "cdrom0:\\SLUS_216.78;1", seed: 62 }));
    payloads["Synthetic Saga (USA)"] = dir => writeFileSync(join(dir, "synthetic-saga.7z"), new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 1, 2]));
    const { request } = createRequest({ gameId: g.id, by: "add" });
    const r = await drive(request.id);
    expect(grabbed).toEqual(["Synthetic.Saga.USA.PS2DVD-GRP", "Synthetic Saga (USA)"]);
    expect(r.state).toBe("ready");
    const [pkg] = db.query("SELECT * FROM packages WHERE game_id=?").all(g.id) as PackageRow[];
    expect(JSON.parse(pkg.manifest_json)).toMatchObject({ kind: "emulated", platform: "ps2", launch: { argv: ["-batch", "--", "{install}/games/Synthetic_Saga_USA.iso"] } });
    const kept = getContent(getWay(way.id)!.content_id!)!;
    expect(contentIdentity(kept)).toMatchObject({ platform: "ps2", serial: "SLUS-21678" });
    const [refused, taken] = contentJobs(g.id);
    expect(refused).toMatchObject({ state: "failed", message: "not the game file: ssaga-grp.iso is another game (its serial is SLUS-20000, and this takes SLUS-21678, SLES-54206)" });
    expect(taken.transcript).toContain("Synthetic Saga (USA).iso: the game file — its serial SLUS-21678 is one the way accepts");
    expect(gameFiles(g.id).map(x => x.name)).toEqual(["Synthetic Saga (USA).iso"]);  // another game's disc never entered the store
    // the refused disc is blocked for this way only: a second PS2 way of the game may still try it
    const other = await addWay(g, ps2EmuPlan("Synth PS2 Emu B").id);
    const guids = (wayId: number) => (stmts.blocklistForWay.all(g.id, wayId) as { guid: string }[]).map(b => b.guid);
    expect(guids(way.id)).toEqual(["guid:Synthetic.Saga.USA.PS2DVD-GRP"]);
    expect(guids(other.id)).toEqual([]);
  }, 30_000);
});

describe("the dump lists in a search", () => {
  const sha = (b: Uint8Array) => sha1(b).toUpperCase();
  const datOf = (entries: [string, Uint8Array][]) => `clrmamepro (\n\tname "Nintendo - Nintendo 64"\n\tversion "2026.10.07"\n)\n\n` +
    entries.map(([name, b]) => `game (\n\tname "${name}"\n\trom ( name "${name}.z64" size ${b.length} crc 00000000 md5 ${"0".repeat(32)} sha1 ${sha(b)} )\n)\n`).join("\n");

  test("an emulator way with no hashes or serials proves its file by the list: a beta it knows is refused, the retail dump built", async () => {
    const retail = n64Rom({ code: "NSOE", seed: 71 }), beta = n64Rom({ code: "NSOE", seed: 72 });
    datdeps.fetchText = async () => datOf([["Synthetic Odyssey (USA)", retail], ["Synthetic Odyssey (USA) (Beta)", beta]]);
    forgetDats();
    await loadDat("n64");                                                      // the list is kept on the server (a search never waits for one)
    const g = await manualGame("Synthetic Odyssey", ["n64"], 2002);
    const way = await addWay(g, n64EmuPlan().id);
    // the scene release ranks first and is the beta under a retail-looking name; the No-Intro name is taken because the list can prove it
    listing = [rel("Synthetic.Odyssey.USA.N64-GRP", { seeders: 10 }), rel("Synthetic Odyssey (USA)", { seeders: 30 })];
    payloads["Synthetic.Odyssey.USA.N64-GRP"] = dir => writeFileSync(join(dir, "sodyssey.z64"), beta);
    payloads["Synthetic Odyssey (USA)"] = dir => writeFileSync(join(dir, "Synthetic Odyssey (USA).z64"), retail);
    const { request } = createRequest({ gameId: g.id, by: "add" });
    const r = await drive(request.id);
    expect(grabbed).toEqual(["Synthetic.Odyssey.USA.N64-GRP", "Synthetic Odyssey (USA)"]);
    expect(r.state).toBe("ready");
    const [refused, taken] = contentJobs(g.id);
    expect(refused.message).toMatch(/sodyssey\.z64: the dump list names it Synthetic Odyssey \(USA\) \(Beta\) \(\(Beta\): a development build, not the game as it was sold\)/);
    expect(JSON.parse(taken.manifest_json!)).toMatchObject({ outcome: "proven", by: "list", wayId: way.id });
    expect(taken.transcript).toContain("the dump list knows it as Synthetic Odyssey (USA)");
    expect(packagesOf(g.id).map(p => p.kind)).toEqual(["emulated"]);
  }, 30_000);
});

describe("the seams a way's search shares", () => {
  test("a request that only follows the admin's own build leaves it running when it is cancelled", async () => {
    const rom = n64Rom({ code: "NSCE", seed: 81 });
    const g = await manualGame("Synthetic Cancel", ["n64"], 1998);
    const way = await addWay(g, recompPlan(sha1(rom)).id);
    const up = await app.request(`/api/v1/content?gameId=${g.id}&name=synthetic-cancel.z64&wayId=${way.id}`, { method: "POST", headers: { "x-api-key": apiKey() }, body: new Uint8Array(rom) });
    expect(up.status).toBe(201);
    const build = await call(`/api/v1/way/${way.id}/build`, { method: "POST", body: "{}" });
    expect(build.status).toBe(202);
    const { request } = createRequest({ gameId: g.id, by: "manual" });
    await requestsTick();
    expect(req(request.id)).toMatchObject({ state: "processing", job_id: build.body.job.id });
    await (await import("../src/requests")).cancelRequest(request.id, true);
    expect((stmts.jobById.get(build.body.job.id) as JobRow).state).toBe("queued");
    db.query("DELETE FROM jobs WHERE id=?").run(build.body.job.id);
  });

  test("a search for a way's file never changes what members see of a copy they can start", async () => {
    const g = await manualGame("Synthetic Quiet", ["n64"], 1998);
    const way = await addWay(g, recompPlan(sha1(n64Rom({ seed: 95 }))).id);
    const pkg = stmts.insertPackage.get(g.id, null, join(process.env.AHOY_LIBRARY!, "quiet-native"), g.name, null, 1, JSON.stringify({ kind: "native", launch: { exe: "q.exe" } })) as PackageRow;
    const r = stmts.insertWayRequest.get(g.id, "find-files", way.id) as RequestRow;
    db.query("UPDATE requests SET state='fetching', stage='downloading · 9 MB/s' WHERE id=?").run(r.id);
    const row = stmts.gameById.get(g.id) as GameRow;
    expect(statusOf(row, pkg, req(r.id)).status).toBe("available");
    expect(statusOf(row, null, req(r.id)).status).toBe("downloading");          // a game players cannot start: they see it coming
    db.query("DELETE FROM requests WHERE id=?").run(r.id);
    db.query("DELETE FROM packages WHERE id=?").run(pkg.id);
  });

  test("a game's own search waits while the admin's search looks for its best way's file", async () => {
    const g = await manualGame("Synthetic Busy", ["n64"], 1998);
    const way = await addWay(g, recompPlan(sha1(n64Rom({ seed: 91 }))).id);
    const find = await call(`/api/v1/way/${way.id}/find-files`, { method: "POST" });
    expect(find.status).toBe(202);
    // a second request of the game's own is the admin's, as a duplicate; one made underneath (an RSS hit racing it) waits
    expect(createRequest({ gameId: g.id, by: "auto" })).toMatchObject({ duplicate: true, request: { id: find.body.request.id } });
    const own = stmts.insertRequest.get(g.id, "rss") as RequestRow;
    db.query("UPDATE requests SET state='fetching' WHERE id=?").run(find.body.request.id);    // the admin's is busy downloading
    await requestsTick();
    expect(req(own.id)).toMatchObject({ state: "requested", stage: expect.stringMatching(/^another search looks for this game's file — searching again in \d+h$/) });
    db.query("DELETE FROM requests WHERE game_id=?").run(g.id);
  });
});

describe("a game without ways", () => {
  test("searches exactly as before: the PC pass, then the console fallback, for the game itself", async () => {
    const g = await manualGame("Synthetic Plain", ["ps2"], 2005);
    listing = [rel("Synthetic.Plain.USA.PS2DVD-GRP", { seeders: 5, size: 4e9 })];
    const { request } = createRequest({ gameId: g.id, by: "add" });
    await requestsTick();
    const r = req(request.id);
    expect(r.way_id).toBeNull();
    expect(asked[0].categories).toBeNull();                                  // the PC pass first, with the indexer's own categories
    expect(asked.some(a => a.categories?.length === 0)).toBe(true);           // then every category for the console dump
    expect(r.state).toBe("fetching");
    expect(grabbed).toEqual(["Synthetic.Plain.USA.PS2DVD-GRP"]);
  });
});

/* ─────────── what the W7 verification found (each test is one of its findings, fixed) ─────────── */

const blocksOf = (gameId: number) => db.query("SELECT guid, way_id, reason FROM blocklist WHERE game_id=? ORDER BY id").all(gameId) as { guid: string; way_id: number | null; reason: string }[];
const putSerials = async (way: { id: number; content: any }, serials: string[], what?: string) => {
  const content = { ...way.content, ...(what ? { what } : {}), accept: { ...way.content.accept, serials } };
  const r = await call(`/api/v1/way/${way.id}`, { method: "PUT", body: JSON.stringify({ content }) });
  expect(r.status).toBe(200);
  return r.body.item as { id: number; content: any };
};
/** a GameCube dump list holding these entries (name, serial, bytes) */
const gcDat = (entries: [string, string, Uint8Array][]) => `clrmamepro (\n\tname "Nintendo - GameCube"\n\tversion "2026.10.07"\n)\n\n` + entries.map(([name, serial, b]) =>
  `game (\n\tname "${name}"\n\tregion "USA"\n\tserial "${serial}"\n\trom ( name "${name}.iso" size ${b.length} crc 00000000 md5 ${"0".repeat(32)} sha1 ${sha1(b).toUpperCase()} serial "${serial}" )\n)\n`).join("\n");

describe("the dump list's bonus discs and a download's tagged files", () => {
  test("a GameCube way never takes the game's bonus disc: its serial never joins the way's, and its release is never grabbed", async () => {
    const disc = nintendoIso({ id: "GSKE01", seed: 301 }), bonus = nintendoIso({ id: "PSKE01", seed: 302 });
    datdeps.fetchText = async () => gcDat([["Synthetic Kart (USA)", "DL-DOL-GSKE-USA", disc], ["Synthetic Kart (USA) (Bonus Disc)", "DL-DOL-PSKE-USA", bonus]]);
    forgetDats();
    await loadDat("gc");
    const g = await manualGame("Synthetic Kart", ["gc"], 2003);
    const way = await addWay(g, gcEmuPlan().id);
    listing = [rel("Synthetic Kart (USA) (Bonus Disc)", { seeders: 60, size: 1.4e9 }), rel("Synthetic Kart (USA)", { seeders: 8, size: 1.4e9 })];
    payloads["Synthetic Kart (USA) (Bonus Disc)"] = dir => writeFileSync(join(dir, "Synthetic Kart (USA) (Bonus Disc).iso"), bonus);
    payloads["Synthetic Kart (USA)"] = dir => writeFileSync(join(dir, "Synthetic Kart (USA).iso"), disc);
    // the admin's Find takes in the serials the list gives the game: the game's own, never the bonus disc's
    const find = await call(`/api/v1/way/${way.id}/find-files`, { method: "POST" });
    expect(find.status).toBe(202);
    expect(JSON.parse(getWay(way.id)!.content_json!).accept.serials).toEqual(["DL-DOL-GSKE-USA"]);
    const r = await drive(find.body.request.id);
    expect(grabbed).toEqual(["Synthetic Kart (USA)"]);
    expect(r.state).toBe("ready");
    expect(getContent(getWay(way.id)!.content_id!)!.name).toBe("Synthetic Kart (USA).iso");
    expect(JSON.parse(contentJobs(g.id)[0].manifest_json!)).toMatchObject({ outcome: "proven", by: "serial" });
  }, 30_000);

  test("a beta beside the game in a retail-named release is never what is taken; a lone beta is refused for the way and never kept", async () => {
    const g = await manualGame("Synthetic Quest Two", ["n64"], 1999);
    const way = await putSerials(await addWay(g, n64EmuPlan().id), ["NUS-NQ2E-USA"]);
    listing = [rel("Synthetic Quest Two (USA)", { seeders: 40 })];
    // the folder holds the beta (its file name says so, sorted first by name) and the retail dump; both carry the retail code
    payloads["Synthetic Quest Two (USA)"] = dir => {
      writeFileSync(join(dir, "Synthetic Quest Two (USA) (Beta).z64"), n64Rom({ code: "NQ2E", seed: 101 }));
      writeFileSync(join(dir, "Synthetic Quest Two (USA).z64"), n64Rom({ code: "NQ2E", seed: 102 }));
    };
    const r = await drive(createRequest({ gameId: g.id, by: "add" }).request.id);
    expect(r.state).toBe("ready");
    expect(getContent(getWay(way.id)!.content_id!)!.name).toBe("Synthetic Quest Two (USA).z64");
    // a release whose only file is a beta: refused by the file's name (serial or not), for this way only, and nothing kept
    const g2 = await manualGame("Synthetic Lone Quest", ["n64"], 1999);
    const way2 = await putSerials(await addWay(g2, n64EmuPlan().id), ["NLQE"]);
    listing = [rel("Synthetic Lone Quest (USA) N64", { seeders: 40 })];
    payloads["Synthetic Lone Quest (USA) N64"] = dir => writeFileSync(join(dir, "Synthetic Lone Quest (USA) (Beta).z64"), n64Rom({ code: "NLQE", seed: 111 }));
    const r2 = await drive(createRequest({ gameId: g2.id, by: "add" }).request.id);
    expect(r2.state).toBe("requested");
    expect(contentJobs(g2.id)[0]).toMatchObject({ state: "failed", message: "not the game file: Synthetic Lone Quest (USA) (Beta).z64: (Beta): a development build, not the game as it was sold" });
    expect(blocksOf(g2.id)).toEqual([{ guid: "guid:Synthetic Lone Quest (USA) N64", way_id: way2.id, reason: expect.stringMatching(/^not the game file: /) }]);
    expect(gameFiles(g2.id)).toEqual([]);
    expect(packagesOf(g2.id)).toEqual([]);
  }, 30_000);

  test("a download that holds only disc 2 is refused for a way that takes the game's first disc (its bytes say which disc)", async () => {
    const g = await manualGame("Synthetic Disc Saga", ["gc"], 2003);
    const way = await putSerials(await addWay(g, gcEmuPlan().id), ["GSDE01"]);
    listing = [rel("Synthetic Disc Saga (USA) GC", { seeders: 20, size: 1.4e9 })];
    const second = nintendoIso({ id: "GSDE01", seed: 131 });
    second[6] = 1;                                                            // the disc byte: disc 2 of the game
    payloads["Synthetic Disc Saga (USA) GC"] = dir => writeFileSync(join(dir, "Synthetic Disc Saga (USA).iso"), second);
    const r = await drive(createRequest({ gameId: g.id, by: "add" }).request.id);
    expect(r.state).toBe("requested");
    expect(contentJobs(g.id)[0].message).toBe("not the game file: Synthetic Disc Saga (USA).iso: disc 2 of the game, and this way takes its first disc");
    expect(getWay(way.id)!.content_id).toBeNull();
    expect(packagesOf(g.id)).toEqual([]);
  }, 30_000);

  test("a description that says hacks won't run asks for no hack: the (Hack) release is never grabbed", async () => {
    const g = await manualGame("Synthetic Quest Six", ["n64"], 2000);
    await putSerials(await addWay(g, n64EmuPlan().id), ["NQ6E"], "the US cartridge ROM; ROM hacks won't run");
    listing = [rel("Synthetic Quest Six (USA) (Hack) N64", { seeders: 90 }), rel("Synthetic Quest Six (USA) N64", { seeders: 5 })];
    payloads["Synthetic Quest Six (USA) (Hack) N64"] = dir => writeFileSync(join(dir, "Synthetic Quest Six (USA) (Hack).z64"), n64Rom({ code: "NQ6E", seed: 121 }));
    payloads["Synthetic Quest Six (USA) N64"] = dir => writeFileSync(join(dir, "Synthetic Quest Six (USA).z64"), n64Rom({ code: "NQ6E", seed: 122 }));
    const r = await drive(createRequest({ gameId: g.id, by: "add" }).request.id);
    expect(grabbed).toEqual(["Synthetic Quest Six (USA) N64"]);
    expect(r.state).toBe("ready");
  }, 30_000);

  test("a disc image whose bytes are no PS2 disc (ISO 9660 without SYSTEM.CNF) is refused for the way, not kept: nothing holds the next search", async () => {
    const g = await manualGame("Synthetic Other Disc", ["ps2"], 2001);
    const way = await putSerials(await addWay(g, ps2EmuPlan().id), ["SLUS-29997"]);
    const iso = psIso({ boot: "cdrom0:\\SLUS_299.97;1", seed: 241 });
    renameRootFile(iso, "SYSTEM.CNF", "SETUP.EXE;1");                         // a PC disc, or another console's
    listing = [rel("Synthetic Other Disc (USA)", { seeders: 20, size: 4e9 })];
    payloads["Synthetic Other Disc (USA)"] = dir => writeFileSync(join(dir, "Synthetic Other Disc (USA).iso"), iso);
    const r = await drive(createRequest({ gameId: g.id, by: "add" }).request.id);
    expect(r.state).toBe("requested");
    expect(contentJobs(g.id)[0].message).toBe("not the game file: Synthetic Other Disc (USA).iso: nothing in it reads as a PlayStation 2 disc");
    expect(blocksOf(g.id).map(b => b.way_id)).toEqual([way.id]);
    expect(gameFiles(g.id)).toEqual([]);
    expect(heldFile(g.id, "ps2")).toBeNull();
  }, 30_000);
});

/** an ISO 9660 image's root folder record for `from` renamed (the record keeps its length) */
function renameRootFile(iso: Uint8Array, from: string, to: string) {
  const root = iso.subarray(18 * 2048, 19 * 2048);
  for (let off = 0; off < 2048;) {
    const rl = root[off];
    if (!rl) break;
    const nl = root[off + 32];
    if (new TextDecoder().decode(root.subarray(off + 33, off + 33 + nl)).startsWith(from)) {
      root.fill(0, off + 33, off + 33 + nl);
      root.set(new TextEncoder().encode(to), off + 33);
      root[off + 32] = to.length;
    }
    off += rl;
  }
}

describe("a refused download, a check that could not be made, and a way that went away", () => {
  test("a refused download stays available on the game page for another import", async () => {
    const g = await manualGame("Synthetic Leftover", ["ps2"], 2004);
    await putSerials(await addWay(g, ps2EmuPlan().id), ["SLUS-29994"]);
    listing = [rel("Synthetic.Leftover.USA.PS2DVD-GRP", { seeders: 10, size: 4e9 })];
    payloads["Synthetic.Leftover.USA.PS2DVD-GRP"] = dir => writeFileSync(join(dir, "sleft.iso"), psIso({ boot: "cdrom0:\\SLUS_200.01;1", seed: 211 }));
    await drive(createRequest({ gameId: g.id, by: "add" }).request.id);
    expect(contentJobs(g.id)[0].state).toBe("failed");
    const f = db.query("SELECT * FROM fetches WHERE game_id=?").get(g.id) as FetchRow;
    expect(f.imported_at).toBeNull();
    expect(existsSync(f.local_path!)).toBe(true);
    expect((stmts.fetchesToClean.all() as FetchRow[]).map(x => x.id)).not.toContain(f.id);
    const { retainedDownloads, useDownload } = await import("../src/library/retained");
    expect(retainedDownloads(g.id).find(d => d.id === f.id)?.reason).toBeTruthy();
    await expect(useDownload(g.id + 1, f.id, null)).rejects.toThrow();
    await expect(useDownload(g.id, f.id, -1)).rejects.toThrow();
    const [one, two] = await Promise.all([useDownload(g.id, f.id, null), useDownload(g.id, f.id, null)]);
    expect(one.id).toBe(two.id);
    expect(one.input_path).toBe(f.local_path!);
  }, 30_000);

  test("a check that cannot be made (no room for the file) blocklists nothing and is tried again later on the same download", async () => {
    const g = await manualGame("Synthetic Full Disk", ["ps2"], 2002);
    await putSerials(await addWay(g, ps2EmuPlan().id), ["SLUS-29996"]);
    listing = [rel("Synthetic.Full.Disk.USA.PS2DVD-AAA", { seeders: 20, size: 4e9 }), rel("Synthetic.Full.Disk.USA.PS2DVD-BBB", { seeders: 10, size: 4e9 })];
    for (const t of listing.map(x => x.title)) payloads[t] = dir => writeFileSync(join(dir, "game.iso"), psIso({ boot: "cdrom0:\\SLUS_299.96;1", seed: 231 }));
    ctdeps.diskSpace = async () => ({ free: 10e6, total: 2e15 });            // the store's volume is full for now
    let now = Date.now();
    rdeps.now = () => now;
    const { request } = createRequest({ gameId: g.id, by: "add" });
    let r = await drive(request.id, 8);
    expect(r).toMatchObject({ state: "processing", stage: "the game file could not be checked — trying again in 10 min" });
    expect(r.message).toMatch(/^not enough room/);
    expect(grabbed).toEqual(["Synthetic.Full.Disk.USA.PS2DVD-AAA"]);       // the next candidate is not downloaded for nothing
    expect(blocksOf(g.id)).toEqual([]);
    // room again, and the wait is over: the same download is checked again and the way built
    ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
    now += 11 * 60_000;
    r = await drive(request.id);
    expect(r.state).toBe("ready");
    expect(grabbed).toEqual(["Synthetic.Full.Disk.USA.PS2DVD-AAA"]);
    expect(contentJobs(g.id).map(j => j.state)).toEqual(["failed", "done"]);
    expect(packagesOf(g.id).map(p => p.kind)).toEqual(["emulated"]);
  }, 30_000);

  test("after a few checks that could not be made the request fails saying why, the download kept and nothing blocklisted", async () => {
    const g = await manualGame("Synthetic Still Full", ["ps2"], 2002);
    await putSerials(await addWay(g, ps2EmuPlan().id), ["SLUS-29986"]);
    listing = [rel("Synthetic.Still.Full.USA.PS2DVD-AAA", { seeders: 20, size: 4e9 })];
    payloads["Synthetic.Still.Full.USA.PS2DVD-AAA"] = dir => writeFileSync(join(dir, "game.iso"), psIso({ boot: "cdrom0:\\SLUS_299.86;1", seed: 232 }));
    ctdeps.diskSpace = async () => ({ free: 10e6, total: 2e15 });
    let now = Date.now();
    rdeps.now = () => now;
    const { request } = createRequest({ gameId: g.id, by: "add" });
    let r = await drive(request.id, 8);
    for (let i = 0; i < 3 && r.state === "processing"; i++) { now += 31 * 60_000; r = await drive(request.id, 8); }
    expect(r).toMatchObject({ state: "failed", stage: "the game file could not be checked" });
    expect(r.message).toMatch(/^not enough room.* — the download is kept: search again once that is fixed$/);
    expect(contentJobs(g.id).length).toBe(3);
    expect(blocksOf(g.id)).toEqual([]);
    const f = db.query("SELECT * FROM fetches WHERE game_id=?").get(g.id) as FetchRow;
    expect(existsSync(f.local_path!)).toBe(true);
  }, 30_000);

  test("an archive its archiver turns down (corrupt, locked with a password) is the release's fault: refused for the way, the next candidate taken", async () => {
    const g = await manualGame("Synthetic Locked", ["n64"], 1998);
    const way = await putSerials(await addWay(g, n64EmuPlan().id), ["NSLE"]);
    listing = [rel("Synthetic Locked (USA) N64", { seeders: 50 }), rel("Synthetic.Locked.USA.N64-GRP", { seeders: 5 })];
    payloads["Synthetic Locked (USA) N64"] = dir => writeFileSync(join(dir, "locked.zip"), new Uint8Array([0x50, 0x4b, 3, 4, 9]));   // 7z cannot open it
    payloads["Synthetic.Locked.USA.N64-GRP"] = dir => writeFileSync(join(dir, "slocked.z64"), n64Rom({ code: "NSLE", seed: 191 }));
    const r = await drive(createRequest({ gameId: g.id, by: "add" }).request.id);
    expect(r.state).toBe("ready");
    expect(grabbed).toEqual(["Synthetic Locked (USA) N64", "Synthetic.Locked.USA.N64-GRP"]);
    expect(contentJobs(g.id)[0].message).toBe("not the game file: locked.zip cannot be unpacked: 7z failed on locked.zip (exit 2): cannot open locked.zip");
    expect(blocksOf(g.id)).toEqual([{ guid: "guid:Synthetic Locked (USA) N64", way_id: way.id, reason: expect.stringMatching(/cannot be unpacked/) }]);
  }, 30_000);

  test("a way deleted while its file downloads: the download goes, and the request searches for the game itself", async () => {
    const g = await manualGame("Synthetic Gone Way", ["n64"], 1997);
    const way = await putSerials(await addWay(g, n64EmuPlan().id), ["NSGE"]);
    listing = [rel("Synthetic Gone Way (USA)", { seeders: 50 }), rel("Synthetic Gone Way (Europe)", { seeders: 30 })];
    const { request } = createRequest({ gameId: g.id, by: "add" });
    await requestsTick();
    expect(req(request.id)).toMatchObject({ state: "fetching", way_id: way.id });
    expect((await call(`/api/v1/way/${way.id}`, { method: "DELETE" })).status).toBe(200);
    await requestsTick();
    expect(req(request.id)).toMatchObject({ state: "requested", way_id: null, fetch_id: null, message: "the way to play it searched for is gone: searching for the game itself" });
    expect(db.query("SELECT COUNT(*) AS n FROM fetches WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
    // the game's own search takes over: no-console dump names are not taken on faith there, so nothing more is grabbed
    await requestsTick();
    expect(grabbed).toEqual(["Synthetic Gone Way (USA)"]);
    expect(blocksOf(g.id)).toEqual([]);
  }, 30_000);
});

describe("searches of one game for its ways", () => {
  test("of two searches waiting on one way, the older looks and the newer waits: neither waits on the other for good", async () => {
    const g = await manualGame("Synthetic Deadlock", ["n64"], 1993);
    const way = await addWay(g, recompPlan(sha1(n64Rom({ seed: 142 }))).id);
    listing = [];
    // a search that gave up after its week, a member's newer one waiting, then "Search again" on the old one in Activity
    const old = createRequest({ gameId: g.id, by: "add" });
    await drive(old.request.id);
    db.query("UPDATE requests SET state='failed', done_at=unixepoch(), next_try_at=NULL WHERE id=?").run(old.request.id);
    const fresh = createRequest({ gameId: g.id, by: "manual" });
    await drive(fresh.request.id);
    expect(req(fresh.request.id)).toMatchObject({ state: "requested", way_id: way.id });
    expect((await call(`/api/v1/queue/${old.request.id}/retry?fresh=1`, { method: "POST" })).status).toBe(200);
    const searches = () => asked.filter(a => /Deadlock/i.test(a.term)).length;
    const before = searches();
    let now = Date.now();
    rdeps.now = () => now;
    for (let day = 0; day < 3; day++) { now += 24 * 3600_000; for (let k = 0; k < 10; k++) await requestsTick(); }
    expect(searches()).toBeGreaterThan(before);
    expect(req(old.request.id).stage).toMatch(/^nothing suitable yet — searching again in \d+h$/);
    expect(req(fresh.request.id).stage).toMatch(/^another search looks for this game's file — searching again in \d+h$/);
  }, 30_000);

  test("a file kept for an emulator way holds only the ways that cannot tell it apart: a recomp that refuses it by hash searches and is built", async () => {
    const us = n64Rom({ code: "NSHE", seed: 161 }), eu = n64Rom({ code: "NSHP", seed: 162 });
    const g = await manualGame("Synthetic Held", ["n64"], 1996);
    const emu = await addWay(g, n64EmuPlan().id);
    listing = [rel("Synthetic Held (Europe) N64", { seeders: 50 })];
    payloads["Synthetic Held (Europe) N64"] = dir => writeFileSync(join(dir, "Synthetic Held (Europe).z64"), eu);
    expect((await drive(createRequest({ gameId: g.id, by: "add" }).request.id)).stage).toBe("kept the game file for a look");
    // the emulator way's next search is held: it cannot tell the waiting file apart
    const held = await call(`/api/v1/way/${emu.id}/find-files`, { method: "POST" });
    expect(held).toMatchObject({ status: 409, body: { error: "Synthetic Held (Europe).z64 came from the indexers and waits for a look: accept it for the way, or remove it to search again" } });
    // the admin adds the recomp, which takes only the US dump by its sha1: the waiting file is no file for it
    const recomp = await addWay(g, recompPlan(sha1(us)).id);
    listing = [rel("Synthetic Held (USA) N64", { seeders: 50 })];
    payloads["Synthetic Held (USA) N64"] = dir => writeFileSync(join(dir, "Synthetic Held (USA).z64"), us);
    const find = await call(`/api/v1/way/${recomp.id}/find-files`, { method: "POST" });
    expect(find.status).toBe(202);
    const r = await drive(find.body.request.id);
    expect(r.state).toBe("ready");
    expect(grabbed).toEqual(["Synthetic Held (Europe) N64", "Synthetic Held (USA) N64"]);
    expect(packagesOf(g.id).map(p => p.kind)).toEqual(["recomp"]);
  }, 30_000);

  test("a way that can prove the waiting file takes it on its search, and is built without another download", async () => {
    const rom = n64Rom({ code: "NSWE", seed: 171 });
    const g = await manualGame("Synthetic Waiting", ["n64"], 1996);
    const emu = await addWay(g, n64EmuPlan().id);
    listing = [rel("Synthetic Waiting (USA) N64", { seeders: 50 })];
    payloads["Synthetic Waiting (USA) N64"] = dir => writeFileSync(join(dir, "Synthetic Waiting (USA).z64"), rom);
    expect((await drive(createRequest({ gameId: g.id, by: "add" }).request.id)).stage).toBe("kept the game file for a look");
    // the admin writes the game code the way takes: the waiting file is proven by it on the way's next search
    await putSerials(emu, ["NSWE"]);
    expect(getWay(emu.id)!.content_id).toBeNull();
    const r = await drive(createRequest({ gameId: g.id, by: "manual" }).request.id);
    expect(r.state).toBe("ready");
    expect(grabbed).toEqual(["Synthetic Waiting (USA) N64"]);
    expect(getWay(emu.id)).toMatchObject({ status: "built" });
    expect(heldFile(g.id, "n64")).toBeNull();
  }, 30_000);

  test("two searches of one game for two ways: a build ludarr queued by itself never replaces the other way's package", async () => {
    const rom = n64Rom({ code: "NSTE", seed: 271 });
    const g = await manualGame("Synthetic Two Ways", ["n64"], 1991);
    const recomp = await addWay(g, recompPlan(sha1(rom)).id);
    const emu = await putSerials(await addWay(g, n64EmuPlan().id), ["NSTE"]);
    listing = [rel("Synthetic Two Ways (USA) N64", { seeders: 20 }), rel("Synthetic.Two.Ways.USA.N64-GRP", { seeders: 5 })];
    for (const t of listing.map(x => x.title)) payloads[t] = dir => writeFileSync(join(dir, "stw.z64"), rom);
    const own = createRequest({ gameId: g.id, by: "manual" });
    await requestsTick();                                                      // the game's own search (the recomp) is downloading
    expect(req(own.request.id)).toMatchObject({ state: "fetching", way_id: recomp.id });
    const find = await call(`/api/v1/way/${emu.id}/find-files`, { method: "POST" });
    expect(find.status).toBe(202);
    db.query("UPDATE requests SET tried_json=? WHERE id=?").run(JSON.stringify(["guid:Synthetic Two Ways (USA) N64"]), find.body.request.id);
    await requestsTick();                                                      // the admin's search (the emulator) is downloading too
    for (const f of db.query("SELECT * FROM fetches WHERE game_id=? AND state='submitted'").all(g.id) as FetchRow[]) {
      const dir = join(downloadsDir(), `two-${f.id}`); mkdirSync(dir, { recursive: true }); payloads[f.title](dir); stmts.setFetchDone.run(dir, f.id);
    }
    for (let i = 0; i < 6; i++) {
      await requestsTick();
      for (const j of db.query("SELECT id FROM jobs WHERE game_id=? AND state='queued' ORDER BY id").all(g.id) as { id: number }[]) await runJob(j.id);
    }
    expect(packagesOf(g.id).map(p => p.kind)).toEqual(["recomp"]);
    expect(getWay(recomp.id)!.status).toBe("built");
    expect(getWay(emu.id)!.status).toBe("ready");
    const refused = db.query("SELECT state, message FROM jobs WHERE kind='assemble' AND json_extract(spec_json, '$.wayId')=?").get(emu.id);
    expect(refused).toEqual({ state: "failed", message: "the game has another way to play built: build this one from the game page to replace it" });
    expect(req(own.request.id).state).toBe("ready");
    expect(req(find.body.request.id)).toMatchObject({ state: "ready", package_id: req(own.request.id).package_id });
  }, 30_000);

  test("a proven file that arrives while the way's build is queued is taken once that build ends, never kept as unproven", async () => {
    const rom = n64Rom({ code: "NSRA", seed: 181 });
    const g = await manualGame("Synthetic Race", ["n64"], 1995);
    const way = await addWay(g, recompPlan(sha1(rom)).id);
    listing = [rel("Synthetic Race (USA) N64", { seeders: 50 })];
    payloads["Synthetic Race (USA) N64"] = dir => writeFileSync(join(dir, "Synthetic Race (USA).z64"), rom);
    let now = Date.now();
    rdeps.now = () => now;
    const { request } = createRequest({ gameId: g.id, by: "add" });
    for (let i = 0; i < 6 && req(request.id).state !== "processing"; i++) {
      await requestsTick();
      const r = req(request.id);
      if (r.state === "fetching") { const f = fetchOf(r); const dir = join(downloadsDir(), `race-${f.id}`); mkdirSync(dir, { recursive: true }); payloads[f.title](dir); stmts.setFetchDone.run(dir, f.id); }
    }
    // the admin presses Build while the download's check waits in the queue
    const admin = enqueueJob({ kind: "assemble", wayId: way.id }, { gameId: g.id });
    await runJob(req(request.id).job_id!);
    expect(contentJobs(g.id)[0]).toMatchObject({ state: "failed", message: "the way is being built: its game file is taken once that build ends" });
    await requestsTick();
    expect(req(request.id)).toMatchObject({ state: "processing", stage: "the game file could not be checked — trying again in 10 min" });
    expect(heldFile(g.id, "n64")).toBeNull();
    expect(blocksOf(g.id)).toEqual([]);
    await runJob(admin.id);                                                    // the admin's build: no game file yet
    now += 11 * 60_000;
    const r = await drive(request.id);
    expect(r.state).toBe("ready");
    expect(getWay(way.id)).toMatchObject({ status: "built" });
    expect(packagesOf(g.id).map(p => p.kind)).toEqual(["recomp"]);
  }, 30_000);
});
