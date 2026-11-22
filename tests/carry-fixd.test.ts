/**
 * The carry run after the live trace (src/ways/carry.ts): a run that asks for room queues nothing every hour while the
 * library still lacks it; the room ask names the largest second copy kept for any game, and freeing one wakes every run
 * that asked; a per-game build's room is what it writes; no widen round when there is nothing to widen against; words
 * that say a thing once ("built: …"), a server-build round's own words, the day of a retry that is not today; and an
 * earlier download is only one that was never imported and lies inside the folders ludarr takes files from.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, type GameRow, type JobRow } from "../src/db";
import { cadeps, carryApi } from "../src/ways/carry-api";
import { crdeps, serializeRun } from "../src/ways/carry";
import type { JobSpec } from "../src/ways/types";
import { GB, kytyCheck, kytyPlan, kytyUpgraded, MM_SHA1, nx2navi, PASS_CHECK, SEALED, sha256, world, zeldaPlan, type World } from "./carry-world";
import { copyFactsOf } from "./fakes-w3";

let w: World;
const realCa = { ...cadeps };
const extra = { fetches: [] as number[] };
beforeEach(() => { w = world(); });
afterEach(() => {
  for (const id of extra.fetches.splice(0)) db.query("DELETE FROM fetches WHERE id=?").run(id);
  w.cleanup();
  Object.assign(cadeps, realCa);
});

const kidOf = (runId: number, kind: string): JobRow => { const j = w.live(runId); expect(j?.kind).toBe(kind); return j!; };
const texts = (runId: number) => w.steps(runId).map(s => s.text);
const contentJobs = (runId: number) => w.children(runId).filter(j => j.kind === "content").length;
const ISO = 54.2 * GB, SUM = sha256("bbb-ps5-01342.iso bytes");
const BBB = "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]";
const V1004 = "Demons.Souls.v1.004.PS5.PPSA01341";

/** a download of the game that landed earlier (a fetch done), its file on disk */
function fetchOf(g: GameRow, title: string, o: { dir?: string; imported?: boolean } = {}): { id: number; path: string } {
  const dir = o.dir ?? join(w.dir, "remote", "downloads");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${title.replace(/[\\/:*?"<>|]/g, "-")}.rar`);
  writeFileSync(path, "rar");
  const r = db.query("INSERT INTO fetches (game_id, title, protocol, client, state, local_path, size, imported_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id")
    .get(g.id, title, "torrent", "rtorrent", "done", path, 54_255_919_283, o.imported ? Math.floor(w.clock.t / 1000) : null) as { id: number };
  extra.fetches.push(r.id);
  return { id: r.id, path };
}
/** Demon's Souls way 1 as the upgrade round leaves it, its copy the sealed disc, and content row 1 — a second copy of it */
function demonsSouls(name: string, game = "Demon's Souls") {
  const p = w.plan(`KytyPS5 ${name}`, "emulator", kytyPlan());
  const g = w.game(game, ["PS5"], { year: 2020 });
  const way = w.way(g, p, kytyUpgraded(), { check: kytyCheck });
  const file = "bbb-ps5-01342/bbb-ps5-01342.iso";
  const pkg = w.romPackage(g, file, { size: ISO, platform: "ps5", sha256: SUM, title: BBB });
  const row1 = w.kept(g, "bbb-ps5-01342.iso", { source: "package", size: ISO, platform: "ps5", sha256: SUM, bytes: "dump" });
  w.copy.facts.set(g.id, copyFactsOf({ packageId: pkg, rel: file, path: join(w.dir, "packages", String(g.id), file), shape: "file", size: ISO, sha256: SUM, contentId: row1.id,
    identity: { platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", region: "US", sealed: true, shape: "bd-image", category: "game" } }));
  w.copy.serves.set(g.id, { serves: "no", why: SEALED, block: "identity" });
  return { p, g, way, pkg, row1 };
}
/** a run's earlier-download content job ended out of room three times: it asks for room */
async function outOfRoomThrice(runId: number): Promise<void> {
  for (let i = 0; i < 3; i++) {
    w.end(kidOf(runId, "content").id, { state: "failed", message: "not enough room on the library: 76 GB free, 101 GB needed with what it keeps free", fail: { class: "env", kind: "room" } });
    const r = await w.advance(runId);
    if (r.state === "asking") break;                   // plainly short: asked at the first failure
    if (i < 2) { w.clock.t = r.next_at! * 1000; await w.advance(runId); }
  }
}
/** a recomp with a check (no upgrade round), its game, its way */
function recomp(name: string) {
  const p = w.plan(`Carry ${name}`, "recomp", zeldaPlan(true));
  const g = w.game("The Legend of Zelda: Majora's Mask", ["N64"], { year: 2000 });
  return { p, g, way: w.way(g, p) };
}

describe("asking for room", () => {
  test("while the library still lacks the room, the hourly look queues nothing and adds no step; once it has it, the step is tried", async () => {
    const { g, way } = demonsSouls("Fixd Room Loop");
    crdeps.diskFree = async () => 76 * GB;
    fetchOf(g, V1004);
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    await outOfRoomThrice(run.id);
    expect(serializeRun(w.run(run.id)).ask?.code).toBe("room");
    const jobs = contentJobs(run.id), steps = w.steps(run.id).length;
    // an hour later, and the hour after: still 76 GB free — nothing queued (it would fail at once), nothing said again
    for (let h = 0; h < 2; h++) {
      w.clock.t = w.run(run.id).next_at! * 1000;
      const r = await w.advance(run.id);
      expect([r.state, serializeRun(r).ask?.code, contentJobs(run.id), w.steps(run.id).length]).toEqual(["asking", "room", jobs, steps]);
    }
    // the library has the room now (the share given the array): the next look tries the step once
    crdeps.diskFree = async () => 34e12;
    w.clock.t = w.run(run.id).next_at! * 1000;
    await w.advance(run.id);
    expect(contentJobs(run.id)).toBe(jobs + 1);
    expect(w.spec(kidOf(run.id, "content"))).toMatchObject({ kind: "content", earlier: true });
  });

  test("the room ask names the largest second copy kept for any game on the library; freeing it wakes every run that asked for room", async () => {
    const owner = demonsSouls("Fixd Dup Owner");
    const p2 = w.plan("KytyPS5 Fixd Dup Other", "emulator", kytyPlan());
    const g2 = w.game("Astro's Playroom", ["PS5"], { year: 2020 });
    const way2 = w.way(g2, p2, kytyUpgraded(), { check: kytyCheck });
    crdeps.diskFree = async () => 76 * GB;
    crdeps.secondCopyOf = row => (row.id === owner.row1.id ? { bytes: ISO } : null);
    fetchOf(g2, "Astros.Playroom.PS5");
    const run = w.start({ wayId: way2.id, by: "backfill" });
    await w.advance(run.id);
    await outOfRoomThrice(run.id);
    const ask = serializeRun(w.run(run.id)).ask!;
    expect(ask.code).toBe("room");
    expect(ask.need).toContain("Freeing the second copy of bbb-ps5-01342.iso (Demon's Souls) kept in the game file store gives");
    // the admin frees it (another game's file): this run looks again at once and takes its download again
    cadeps.freeDuplicate = async () => ({ freedBytes: ISO });
    const res = await carryApi.request(`/api/v1/content/${owner.row1.id}/free-duplicate`, { method: "POST" });
    expect(res.status).toBe(200);
    await w.advance(run.id);
    expect(contentJobs(run.id)).toBe(2);                                      // asked at the first: one failed, one after the free
  });

  test("a per-game build's room is what it writes: about its game data again and a little more, plus what the library keeps free", async () => {
    const { g, way } = recomp("Fixd Build Room");
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64", size: 25_000_000_000 });
    crdeps.wayBuildNeeded = () => true;
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    for (let i = 0; i < 3; i++) {
      w.end(kidOf(run.id, "build").id, { state: "failed", message: "not enough room: 50.0 GB free on the library, and 53.7 GB is kept free there", fail: { class: "env", kind: "room" } });
      const r = await w.advance(run.id);
      if (r.state === "asking") break;                   // plainly short: asked at the first failure
      if (i < 2) { w.clock.t = r.next_at! * 1000; await w.advance(run.id); }
    }
    const ask = serializeRun(w.run(run.id)).ask!;
    expect(ask.code).toBe("room");
    // 25.0e9 B × 1.1 + 50 GB kept free: about 78 GB (the game data alone would say 75)
    expect(ask.need).toMatch(/ needs about 78 GB free on the library/);
  });
});

describe("the widen round", () => {
  test("the indexers had no release at all and nothing on the server was turned down: no AI round, the file is asked for", async () => {
    const { g, way } = recomp("Fixd No Widen");
    crdeps.previewContentPass = async () => ({ names: [g.name], platform: "n64", candidates: [] }) as never;
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const req = w.requests.made[0];
    w.setRequest(req, { state: "requested", stage: "nothing suitable yet — searching again in 6h", next_try_at: Math.floor(w.clock.t / 1000) + 6 * 3600 });
    const r = await w.advance(run.id);
    expect(w.children(run.id).filter(j => j.kind === "construct")).toEqual([]);
    expect([r.state, serializeRun(r).ask?.code]).toEqual(["asking", "file"]);
    expect(texts(run.id)).toContain("the indexers had no release at all for Majora's Mask, NTSC-U 1.0, and nothing on the server was turned down: nothing to widen what the plan accepts against");
  });

  test("a release the indexers had (it did not fit): the widen round runs as before", async () => {
    const { way } = recomp("Fixd Widen Still");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const req = w.requests.made[0];
    w.setRequest(req, { state: "requested", stage: "nothing suitable yet — searching again in 6h", next_try_at: Math.floor(w.clock.t / 1000) + 6 * 3600 });
    await w.advance(run.id);
    const round = kidOf(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("widen");
  });
});

describe("words", () => {
  test("an assemble's own summary says built once", async () => {
    const { g, way } = recomp("Fixd Built Once");
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    w.built(kidOf(run.id, "assemble").id, PASS_CHECK);
    await w.advance(run.id);
    expect(texts(run.id).some(t => /^built: built\b/.test(t))).toBe(false);
    expect(texts(run.id).some(t => /^built \(/.test(t))).toBe(true);
  });

  test("a server-build round that keeps the build on players' PCs is said in its own words, never with a field name", async () => {
    const p = w.plan("NX2navi Fixd Kept", "recomp", nx2navi());
    const g = w.game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"]);
    const way = w.way(g, p);
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const round = kidOf(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("server-build");
    w.round(round.id, { changed: ["decisions"], message: "kept on players' PCs: its build compiles for the player's own CPU and needs the player's Vulkan GPU" });
    const r = await w.advance(run.id);
    const said = JSON.parse(r.facts_json).serverBuild as string;
    expect(said).toBe("kept on players' PCs: its build compiles for the player's own CPU and needs the player's Vulkan GPU");
    expect(JSON.stringify(serializeRun(r))).not.toContain("changed decisions");
  });

  test("a retry a day away says its day: tomorrow at …", async () => {
    const { g, way } = recomp("Fixd Tomorrow");
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    for (let i = 0; i < 4; i++) {
      w.end(kidOf(run.id, "assemble").id, { state: "failed", message: "wine / xvfb-run are not available here", fail: { class: "env", kind: "tool" } });
      const r = await w.advance(run.id);
      if (i < 3) { w.clock.t = r.next_at! * 1000; await w.advance(run.id); }
    }
    // the fourth back-off waits 24 hours: never "at <the same time as now>"
    expect(texts(run.id).at(-1)).toMatch(/could not run on this server: wine \/ xvfb-run are not available here; trying again tomorrow at \d\d:\d\d$/);
  });
});

describe("earlier downloads", () => {
  test("an imported download still present is offered read-only; paths outside the allowed folders are not", async () => {
    const { g, way } = demonsSouls("Fixd Earlier Rules");
    const allowed = join(w.dir, "remote");
    mkdirSync(allowed, { recursive: true });
    crdeps.allowedRoots = async () => [realpathSync(allowed)];
    const imported = fetchOf(g, "Demons.Souls.Imported.PS5", { imported: true });
    fetchOf(g, "Demons.Souls.Elsewhere.PS5", { dir: join(w.dir, "config-like") });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const jobs = w.children(run.id).filter(j => j.kind === "content");
    expect(jobs.length).toBe(1);
    expect(JSON.parse(jobs[0].spec_json!)).toMatchObject({ earlier: true, fetchId: imported.id });
    expect(w.requests.made.length).toBe(0);
  });
});
