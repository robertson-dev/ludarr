/**
 * A way's search and its blocklist (src/requests.ts, src/ways/find.ts; AMEND C1b, H7a): a release is looked at by its own
 * listing before it is grabbed (one that cannot hold the way's game file is refused without a download); every release
 * refused for a way is blocklisted with the version of the way's game file plan and why ('identity' never again, 'form'
 * looked at again once the plan takes another form — the live KytyPS5 way gaining its make); a make that fails on a
 * download is the recipe's fault, and blocklists nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db, stmts, upsertGame, type GameRow, type JobRow, type RequestRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { downloadsDir } from "../src/config";
import { enqueueJob } from "../src/process/kinds";
import { nameQueries, rankForNames, type ReleaseView } from "../src/releases";
import { blockReleaseForWay, createRequest, rdeps, requestsTick } from "../src/requests";
import { wayBlocked } from "../src/ways/find";
import { contentDigest, insertPlan, insertWay, updateWay, wayContent, getPlan } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";
import type { ProwlarrRelease } from "../src/prowlarr";

const saved = { ...rdeps }, realDat = { ...datdeps };
const tmp = mkdtempSync(join(tmpdir(), "requests-blocks-"));
const made = { games: [] as number[], plans: [] as number[] };
afterEach(() => { Object.assign(rdeps, saved); });
afterAll(() => {
  Object.assign(rdeps, saved); Object.assign(datdeps, realDat); forgetDats();
  rmSync(tmp, { recursive: true, force: true });
  for (const id of made.games) for (const t of ["requests", "jobs", "blocklist", "fetches", "history", "contents"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
});
beforeAll(() => { rdeps.log = () => {}; datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats(); });

const GB = 2 ** 30;
let seq = 0;
function game(name: string): GameRow {
  const g = upsertGame({ name, slug: `blocks-${++seq}`, platforms_json: '["ps5"]' } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
/** the live KytyPS5 way before its upgrade: a .zar with its serial, no make */
const v1 = (): ContentPlan => ({ kind: "disc", platform: "ps5", what: "Demon's Souls (PS5)", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, place: "games/{name}" });
/** after its upgrade round: the .zar is made from the app0 folder */
const v2 = (): ContentPlan => ({ ...v1(), make: { input: { shape: "either", platform: "ps5", formats: ["rar", "7z", "zip"], marker: "sce_sys/param.json", also: ["eboot.bin"] }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { shape: "file", name: "{serial}.zar" } } });
function kytyWay(g: GameRow) {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^K-.*[.]zip$", channel: "stable" }, launch: { exe: "k.exe", argv: ["{content}"] }, content: { ...v1(), search: [g.name] }, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name: `Blocks Kyty ${seq}`, kind: "emulator", repo: `blocks/kyty-${seq}`, platforms: ["ps5"], spec, status: "ready" });
  made.plans.push(p.id);
  return insertWay({ gameId: g.id, planId: p.id, content: v1() });
}
const rel = (title: string): ProwlarrRelease => ({
  guid: `guid:${title}`, title, instanceId: 1, indexerId: 1, indexer: "T", size: 40 * GB, age: 10, publishDate: "", seeders: 10, leechers: 0,
  grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent", categories: [], indexerFlags: [], fileName: null,
});
const ranked = (rows: ProwlarrRelease[]): ReleaseView[] => rankForNames(nameQueries("Demon's Souls", null, []), rows, { platforms: ["ps5"], known: ["ps5"], unnamed: true });
const blocksOf = (gameId: number) => db.query("SELECT guid, way_id, class, plan_digest, reason FROM blocklist WHERE game_id=? ORDER BY id").all(gameId) as { guid: string; way_id: number | null; class: string | null; plan_digest: string | null; reason: string }[];

describe("look before grabbing (H7a)", () => {
  test("a release whose listing holds only a sealed disc or nothing the way takes is refused without a download; the next is grabbed", async () => {
    const g = game("Demon's Souls Blocks");
    const w = kytyWay(g);
    const rows = [rel("Demons.Souls.PS5.PPSA01341-DUPLEX"), rel("Demons.Souls.PS5.PPSA01341-LOOSE"), rel("Demons.Souls.PS5.PPSA01341-ZAR")];
    rdeps.search = async () => ({ ranked: ranked(rows) } as never);
    rdeps.usenetAvailable = async () => false;
    const listings: Record<string, { path: string; size: number }[] | null> = {
      "Demons.Souls.PS5.PPSA01341-DUPLEX": [{ path: "DS/Demons.Souls.iso", size: 54 * GB }],
      "Demons.Souls.PS5.PPSA01341-LOOSE": [{ path: "PPSA01341-app0/sce_sys/param.json", size: 1 }, { path: "PPSA01341-app0/eboot.bin", size: 1 }],
      "Demons.Souls.PS5.PPSA01341-ZAR": [{ path: "PPSA01341.zar", size: 45 * GB }],
    };
    rdeps.peek = async r => listings[r.title] ?? null;
    const grabbed: string[] = [];
    rdeps.grab = async (r, gameId) => {
      grabbed.push(r.title);
      const f = stmts.insertFetch({ game_id: gameId, guid: r.guid, indexer_id: 1, indexer: "T", title: r.title, protocol: r.protocol, size: r.size, info_hash: null, client: "rtorrent", client_id: `c-${grabbed.length}`, state: "submitted", release_json: JSON.stringify(r) });
      return { fetch: f as never, duplicate: false };
    };
    const { request } = createRequest({ gameId: g.id, wayId: w.id });
    await requestsTick();
    expect((stmts.requestById.get(request.id) as RequestRow).state).toBe("fetching");
    expect(grabbed).toEqual(["Demons.Souls.PS5.PPSA01341-ZAR"]);            // the first two were never downloaded
    const digest = contentDigest(v1());
    // both are refusals of the form: a listing names files, it does not read them (a sealed verdict from a file's own bytes
    // is another matter)
    expect(blocksOf(g.id)).toEqual([
      { guid: "guid:Demons.Souls.PS5.PPSA01341-DUPLEX", way_id: w.id, class: "form", plan_digest: digest, reason: "not the game file: it holds Demons.Souls.iso, whose game data is encrypted for the console: nothing can open it" },
      { guid: "guid:Demons.Souls.PS5.PPSA01341-LOOSE", way_id: w.id, class: "form", plan_digest: digest, reason: "not the game file: it holds no .zar (its 2 files: param.json, eboot.bin)" },
    ]);
    expect(wayBlocked(g.id, w.id, v1()).has("guid:Demons.Souls.PS5.PPSA01341-LOOSE")).toBe(true);
    // the way gains its make (an upgrade round): both are looked at again — by their listings, so the sealed disc is turned
    // down again without a download, and the loose app0 folder (what the make takes) is grabbed
    updateWay(w.id, { content: v2() });
    expect(wayBlocked(g.id, w.id, v2()).has("guid:Demons.Souls.PS5.PPSA01341-LOOSE")).toBe(false);
    delete listings["Demons.Souls.PS5.PPSA01341-ZAR"];                      // the first grab's release is gone from the indexer
    rows.pop();
    grabbed.length = 0;
    db.query("UPDATE requests SET state='failed' WHERE id=?").run(request.id);
    const { request: again } = createRequest({ gameId: g.id, wayId: w.id });
    expect(again.id).not.toBe(request.id);
    await requestsTick();
    expect(grabbed).toEqual(["Demons.Souls.PS5.PPSA01341-LOOSE"]);
    expect((stmts.requestById.get(again.id) as RequestRow).state).toBe("fetching");
    expect(blocksOf(g.id).filter(b => b.plan_digest === contentDigest(v2())).map(b => [b.guid, b.class])).toEqual([["guid:Demons.Souls.PS5.PPSA01341-DUPLEX", "form"]]);
  });
});

describe("refusals blocklisted with the plan's version and why (C1b)", () => {
  /** a way request at its content job, as the searcher leaves it once a download landed */
  function atContentJob(g: GameRow, wayId: number, title: string, end: { message: string; fail: unknown }) {
    const dir = join(downloadsDir(), `blocks-${++seq}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "x.rar"), "x");
    const r = stmts.insertWayRequest.get(g.id, "find-files", wayId) as RequestRow;
    const f = stmts.insertFetch({ game_id: g.id, guid: `guid:${title}`, indexer_id: 1, indexer: "T", title, protocol: "torrent", size: 1, info_hash: null, client: "rtorrent", client_id: `b-${seq}`, state: "done", release_json: JSON.stringify(rel(title)) });
    stmts.setFetchDone.run(dir, f.id);
    const j = enqueueJob({ kind: "content", gameId: g.id, wayId, requestId: r.id, fetchId: f.id, path: dir }, { gameId: g.id, requestId: r.id, fetchId: f.id });
    db.query("UPDATE jobs SET state='failed', message=?, fail_json=? WHERE id=?").run(end.message, JSON.stringify(end.fail), j.id);
    db.query("UPDATE requests SET state='processing', job_id=?, fetch_id=?, release_json=?, candidates_json='[]' WHERE id=?").run(j.id, f.id, JSON.stringify(rel(title)), r.id);
    return { r, dir, job: stmts.jobById.get(j.id) as JobRow };
  }

  test("a download refused for its form is blocklisted as 'form' under the plan's digest; another game as 'identity'", async () => {
    const g = game("Blocks Classes");
    const w = kytyWay(g);
    rdeps.now = () => Date.now();
    atContentJob(g, w.id, "Demons.Souls.App0.PS5-GRP", { message: "not the game file: no PlayStation 5 game file in the download (.zar)", fail: { class: "file", kind: "form" } });
    await requestsTick();
    atContentJob(g, w.id, "Other.Game.PS5-GRP", { message: "not the game file: x.zar is another game (its serial is PPSA09999, and this takes PPSA01341)", fail: { class: "file" } });
    await requestsTick();
    const digest = contentDigest(wayContent(w, getPlan(w.plan_id)!));
    expect(blocksOf(g.id).map(b => [b.guid, b.class, b.plan_digest])).toEqual([
      ["guid:Demons.Souls.App0.PS5-GRP", "form", digest],
      ["guid:Other.Game.PS5-GRP", "identity", digest],
    ]);
    // the way's plan gains a make: the app0 release may be taken now; the other game never
    updateWay(w.id, { content: v2() });
    expect([...wayBlocked(g.id, w.id, v2())].filter(x => x.startsWith("guid:"))).toEqual(["guid:Other.Game.PS5-GRP"]);
  });

  test("a make that failed on the download is the recipe's fault: the search ends, nothing is blocklisted, the download is kept", async () => {
    const g = game("Blocks Recipe");
    const w = kytyWay(g);
    rdeps.now = () => Date.now();
    const { r, dir } = atContentJob(g, w.id, "Demons.Souls.App0.PS5-GRP", { message: "make step 1 failed (exit 1): zarchive: bad input", fail: { class: "plan", phase: "make" } });
    await requestsTick();
    expect(stmts.requestById.get(r.id)).toMatchObject({ state: "failed", stage: "the game file could not be made from the download", message: "make step 1 failed (exit 1): zarchive: bad input — the download is kept" });
    expect(blocksOf(g.id)).toEqual([]);
    expect(existsSync(join(dir, "x.rar"))).toBe(true);
  });

  test("the run blocks the copy's own release for a way with the class its verdict gives (blockReleaseForWay)", () => {
    const g = game("Blocks Copy Release");
    const w = kytyWay(g);
    blockReleaseForWay({ gameId: g.id, wayId: w.id, title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]", indexer: "T", reason: "the game's copy: the retail disc as a PC drive reads it", cls: "identity" });
    expect(blocksOf(g.id)).toEqual([{ guid: null as unknown as string, way_id: w.id, class: "identity", plan_digest: contentDigest(v1()), reason: "the game's copy: the retail disc as a PC drive reads it" }]);
    expect(wayBlocked(g.id, w.id, v2()).has("Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]")).toBe(true);
  });

  test("rows from before (no class) and the game's own blocklist stay blocked under any plan", () => {
    const g = game("Blocks Legacy");
    const w = kytyWay(g);
    stmts.insertWayBlock.run(g.id, "guid:old", "Old.Release", "T", "not the game file: old", w.id, null, null);
    stmts.insertBlock.run(g.id, "guid:game", "Game.Release", "T", "stalled");
    const b = wayBlocked(g.id, w.id, v2());
    expect([b.has("guid:old"), b.has("guid:game")]).toEqual([true, true]);
  });
});

describe("a release's payload is fetched once", () => {
  test("the .torrent a way's search read the listing from is the one the grab sends: the indexer is asked once per release", async () => {
    const g = game("Demon's Souls Payload");
    const w = kytyWay(g);
    rdeps.search = async () => ({ ranked: ranked([rel("Demons.Souls.PS5.PPSA01341-ZAR")]) } as never);
    rdeps.usenetAvailable = async () => false;
    const be = (v: unknown): string => typeof v === "number" ? `i${v}e` : typeof v === "string" ? `${Buffer.byteLength(v)}:${v}` : Array.isArray(v) ? `l${v.map(be).join("")}e` : `d${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => be(k) + be(x)).join("")}e`;
    const payload = { kind: "torrent" as const, bytes: new TextEncoder().encode(be({ announce: "http://t/a", info: { name: "DS", files: [{ path: ["PPSA01341.zar"], length: 45 * GB }], "piece length": 16384, pieces: "" } })), filename: "DS.torrent" };
    let fetched = 0, sent: unknown = undefined;
    rdeps.payload = async () => { fetched++; return payload; };
    rdeps.grab = async (r, gameId, pre) => {
      sent = pre;
      const f = stmts.insertFetch({ game_id: gameId, guid: r.guid, indexer_id: 1, indexer: "T", title: r.title, protocol: r.protocol, size: r.size, info_hash: null, client: "rtorrent", client_id: `p-${seq}`, state: "submitted", release_json: JSON.stringify(r) });
      return { fetch: f as never, duplicate: false };
    };
    const { request } = createRequest({ gameId: g.id, wayId: w.id });
    await requestsTick();
    expect((stmts.requestById.get(request.id) as RequestRow).state).toBe("fetching");
    expect(fetched).toBe(1);
    expect(sent).toBe(payload);
  });
});

test("old Switch encryption refusals are reconsidered after the plan changes, but identity and global blocks stay", () => {
  const g = game("Switch format recovery");
  const w = kytyWay(g);
  const before: ContentPlan = { ...v1(), platform: "switch", accept: { hashes: [], formats: ["nup"] } };
  const after: ContentPlan = { ...before, accept: { hashes: [], formats: ["xci"] } };
  const reason = "not the game file: Astral Chain (Rev 1).xci is a Switch game card image (XCI): its game data is encrypted for the console, and ludarr never decrypts it";
  for (const [title, why, way] of [
    ["old sealed", reason, w.id],
    ["wrong game", "not the game file: another game (its serial differs)", w.id],
    ["global sealed", reason, null],
    ["old copy", "the game's own copy on the server: a .nsp file (01007300020FA000), whose game data is encrypted for the console: nothing can open it", w.id],
  ] as const) stmts.insertWayBlock.run(g.id, `guid:${title}`, title, "T", why, way, contentDigest(before), "identity");
  expect([...wayBlocked(g.id, w.id, before)].filter(v => !v.startsWith("guid:")).sort()).toEqual(["global sealed", "old copy", "old sealed", "wrong game"]);
  expect([...wayBlocked(g.id, w.id, after)].filter(v => !v.startsWith("guid:")).sort()).toEqual(["global sealed", "wrong game"]);
});
