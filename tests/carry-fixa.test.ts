/**
 * The carry run after the wave-3 merge (src/ways/carry.ts): the game's copy of any kind (a console file inside a PC copy),
 * the one digest every plan_digest is taken of, the copy's own release blocked only as its verdict says, the game's
 * earlier downloads offered before a new search (only read; one refused is not offered again under the same plan), and the
 * room ask that names the kept duplicate — freeing it wakes the run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, stmts, type GameRow } from "../src/db";
import { cadeps, carryApi } from "../src/ways/carry-api";
import { contentDigest as runDigest, copyView, crdeps, digestOf, serializeRun } from "../src/ways/carry";
import { contentDigest, getPlan, getWay, updateWay } from "../src/ways/store";
import type { ContentPlan, JobSpec } from "../src/ways/types";
import { GB, kytyCheck, kytyPlan, kytyUpgraded, nx2navi, nx2naviContent, nx2naviOnServer, SEALED, sha256, world, type World } from "./carry-world";
import { copyFactsOf } from "./fakes-w3";

let w: World;
const realCa = { ...cadeps };
const extra = { packages: [] as number[], fetches: [] as number[] };
beforeEach(() => { w = world(); });
afterEach(() => {
  for (const id of extra.fetches.splice(0)) db.query("DELETE FROM fetches WHERE id=?").run(id);
  for (const id of extra.packages.splice(0)) db.query("DELETE FROM packages WHERE id=?").run(id);
  w.cleanup();
  Object.assign(cadeps, realCa);
});

const live = (runId: number, kind: string) => { const j = w.live(runId); expect(j?.kind).toBe(kind); return j!; };
const texts = (runId: number) => w.steps(runId).map(s => s.text);
const factsOfRun = (runId: number) => JSON.parse(w.run(runId).facts_json);

const NUP = "The Legend of Zelda Ocarina of Time [0400486024DEC000][v131072].nup";
const NUP_SIZE = 25_020_741_061;
const UNPROVEN = "a .nup file in the game's PC copy that nothing this way checks can prove is the game";

/** game 48's package 42 as it is live: the Lichii emulator's PC copy, with the dump inside it */
function lichii(g: GameRow, title = "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp"): number {
  const m = { schema: 1, kind: "native", launch: { exe: "Emulator (Lichii nx2 build 88)/lichii.exe", args: "", cwd: "" }, files: [{ path: "Emulator (Lichii nx2 build 88)/lichii.exe", size: 40_000, sha256: "a".repeat(64) }, { path: NUP, size: NUP_SIZE, sha256: "b".repeat(64) }], source: { title } };
  const pkg = stmts.insertPackage.get(g.id, null, join(w.dir, "pkg-oot"), g.name, null, 26_440_000_000, JSON.stringify(m)) as { id: number };
  extra.packages.push(pkg.id);
  return pkg.id;
}
/** a download of the game that landed earlier (a fetch done), its file on disk unless said otherwise */
function fetchOf(g: GameRow, title: string, o: { size?: number; there?: boolean; guid?: string } = {}): { id: number; path: string } {
  const dir = join(w.dir, "remote", "downloads");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${title.replace(/[\\/:*?"<>|]/g, "-")}.rar`);
  if (o.there !== false) writeFileSync(path, "rar");
  const r = db.query("INSERT INTO fetches (game_id, title, protocol, client, state, local_path, size, guid) VALUES (?,?,?,?,?,?,?,?) RETURNING id")
    .get(g.id, title, "torrent", "rtorrent", "done", path, o.size ?? 54_255_919_283, o.guid ?? null) as { id: number };
  extra.fetches.push(r.id);
  return { id: r.id, path };
}
const ISO = 54.2 * GB, SUM = sha256("bbb-ps5-01342.iso bytes");
const BBB = "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]";
const V1004 = "Demons.Souls.v1.004.PS5.PPSA01341";
/** Demon's Souls way 1 as the upgrade round leaves it (it takes the app0 folder, made into a .zar), its copy the sealed disc,
 *  and content row 1 — a second copy of that disc in the content store */
function demonsSouls(name: string) {
  const p = w.plan(`KytyPS5 ${name}`, "emulator", kytyPlan());
  const g = w.game("Demon's Souls", ["PS5"], { year: 2020 });
  const way = w.way(g, p, kytyUpgraded(), { check: kytyCheck });
  const file = "bbb-ps5-01342/bbb-ps5-01342.iso";
  const pkg = w.romPackage(g, file, { size: ISO, platform: "ps5", sha256: SUM, title: BBB });
  const row1 = w.kept(g, "bbb-ps5-01342.iso", { source: "package", size: ISO, platform: "ps5", sha256: SUM, bytes: "dump" });
  w.copy.facts.set(g.id, copyFactsOf({ packageId: pkg, rel: file, path: join(w.dir, "packages", String(g.id), file), shape: "file", size: ISO, sha256: SUM, contentId: row1.id,
    identity: { platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", region: "US", sealed: true, shape: "bd-image", category: "game" } }));
  w.copy.serves.set(g.id, { serves: "no", why: SEALED, block: "identity" });
  return { p, g, way, pkg, row1 };
}

describe("one digest for every plan_digest", () => {
  test("the run's digest of a content plan is store.ts contentDigest's, whatever order its fields were written in", () => {
    const rev = (v: unknown): unknown => (Array.isArray(v) ? v.map(rev) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, rev(x)])) : v);
    const a: ContentPlan = kytyUpgraded();
    expect(digestOf(a)).toBe(contentDigest(a));
    expect(digestOf(rev(a))).toBe(contentDigest(a));
    expect(digestOf({ ...a, terms: undefined })).toBe(contentDigest({ ...a, terms: undefined }));
    expect(digestOf(null)).toBe(contentDigest(null));
  });
});

describe("the game's copy, of any kind", () => {
  test("a console file inside a PC copy is the copy a way sees; a PC copy with no console game data in it is none; one not looked at yet is shown only when it is a console copy", () => {
    const g = w.game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"]);
    const pkg = lichii(g);
    const c = nx2navi().content!;
    expect(copyView(g.id, c)).toBeNull();                                // a PC copy is shown once a look found game data in it
    const id = { platform: "switch" as const, serial: "0400486024DEC000", shape: "nup" as const };
    w.copy.facts.set(g.id, copyFactsOf({ packageId: pkg, kind: "native", rel: NUP, path: join(w.dir, "pkg-oot", NUP), shape: "file", size: NUP_SIZE, identity: id }));
    w.copy.serves.set(g.id, { serves: "no", why: UNPROVEN, block: null });
    expect(copyView(g.id, c)).toEqual({ packageId: pkg, name: NUP, size: NUP_SIZE, shape: "file", identity: id, serves: "no", why: UNPROVEN });
    // a PC game's own copy holds no console game data: no copy for a console way, and none for a PC way ever
    w.copy.facts.set(g.id, { ...copyFactsOf({ packageId: pkg, kind: "native", rel: "", path: join(w.dir, "pkg-oot"), shape: "folder", size: 1 }), entries: [] });
    expect(copyView(g.id, c)).toBeNull();
    w.copy.facts.set(g.id, copyFactsOf({ packageId: pkg, kind: "native", rel: NUP, path: join(w.dir, "pkg-oot", NUP), shape: "file", size: NUP_SIZE, identity: id }));
    expect(copyView(g.id, { ...c, platform: "pc" })).toBeNull();
  });

  test("the copy route: a console file in a PC copy that nothing proves is said, and its release is never blocked; once proven, it is taken by the content job", async () => {
    const spec = { ...nx2naviOnServer(), content: nx2naviContent() };
    const p = w.plan("NX2navi Fix Route", "recomp", spec);
    const g = w.game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"]);
    const way = w.way(g, p);
    const pkg = lichii(g);
    w.copy.facts.set(g.id, copyFactsOf({ packageId: pkg, kind: "native", rel: NUP, path: join(w.dir, "pkg-oot", NUP), shape: "file", size: NUP_SIZE, identity: { platform: "switch", serial: "0400486024DEC000" } }));
    w.copy.serves.set(g.id, { serves: "no", why: UNPROVEN, block: null });
    // the admin already said to build it over the PC copy
    const run = w.start({ wayId: way.id, by: "admin", replace: true });
    let r = await w.advance(run.id);
    expect(texts(run.id)).toContain(`The copy on the server (${NUP}, 25.0 GB) is ${UNPROVEN}: nothing is copied from it`);
    expect(db.query("SELECT COUNT(*) AS n FROM blocklist WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
    expect(r.state).toBe("asking");
    // proven (the upgrade round put its title id into the plan): taken by a link through the content job
    w.copy.serves.set(g.id, { serves: "direct", why: "the game file this way takes (its title id 0400486024DEC000 is one the way accepts)", block: null });
    w.clock.t += 120_000;
    r = await w.advance(run.id);
    expect(w.spec(live(run.id, "content"))).toEqual({ kind: "content", gameId: g.id, wayId: way.id, fromCopy: true, runId: run.id });
    expect(serializeRun(r).now!.text).toBe(`taking the game's copy (${NUP}, 25.0 GB) as the game file — waiting for its turn`);
  });

  test("a copy refused for its form only is blocked as a form refusal (looked at again once the plan says something else)", async () => {
    const { g, way } = demonsSouls("Fix Form");
    w.copy.serves.set(g.id, { serves: "no", why: "a .iso file, and this needs .zar", block: "form" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    expect(db.query("SELECT title, class, plan_digest FROM blocklist WHERE game_id=? AND way_id=?").all(g.id, way.id)).toEqual([{ title: BBB, class: "form", plan_digest: contentDigest(kytyUpgraded()) }]);
  });
});

describe("the game's earlier downloads, before a new search", () => {
  test("an earlier download is offered to the way before any search, only read (earlier); the copy's own release is not; a refused one is not offered again under the same plan, and is under the next", async () => {
    const { g, way } = demonsSouls("Fix Earlier");
    // the import of this one failed on the old archiver: the game's own blocklist row says nothing of it as game data
    db.query("INSERT INTO blocklist (game_id, title, reason) VALUES (?, ?, ?)").run(g.id, V1004, "import failed: unar failed on Demons.Souls.v1.004.PS5.PPSA01341.rar (exit 1)");
    fetchOf(g, BBB, { size: 58e9 });
    const v1004 = fetchOf(g, V1004);
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    const take = live(run.id, "content");
    expect(w.spec(take)).toEqual({ kind: "content", gameId: g.id, wayId: way.id, path: v1004.path, fetchId: v1004.id, earlier: true, runId: run.id });
    expect(texts(run.id).at(-1)).toBe(`taking the game data from an earlier download (${V1004}, 54.3 GB)`);
    expect([r.state, w.requests.made]).toEqual(["waiting", []]);
    // refused (another version, say): not offered again under this plan; the indexers are searched now
    w.end(take.id, { state: "failed", message: `not the game file: ${V1004}.rar holds PPSA01341 at 01.004.000, and this takes 01.005.000 or 01.007.000`, fail: { class: "file" } });
    r = await w.advance(run.id);
    const key = `earlier:${v1004.id}:${runDigest(getPlan(way.plan_id)!, getWay(way.id)!)}`;
    expect(factsOfRun(run.id).ledger[key]).toMatchObject({ class: "file", kind: "content" });
    expect(w.children(run.id).filter(j => j.kind === "content").length).toBe(1);
    expect(w.requests.made.length).toBe(1);
    // the plan comes to take that version too: the download is offered again, under the new plan
    updateWay(way.id, { content: { ...kytyUpgraded(), make: { ...kytyUpgraded().make!, input: { ...kytyUpgraded().make!.input, versions: ["01.004.000", "01.005.000", "01.007.000"] } } } });
    db.query("UPDATE requests SET state='cancelled' WHERE id=?").run(w.requests.made[0]);
    w.clock.t += 120_000;
    r = await w.advance(run.id);
    expect(w.spec(live(run.id, "content"))).toMatchObject({ kind: "content", path: v1004.path, fetchId: v1004.id, earlier: true });
  });

  test("a release the way itself refused is not offered (said in the ask); a download gone from the disk is skipped", async () => {
    const { g, way } = demonsSouls("Fix Refused");
    w.ai.ready = false;                                                   // no widening round: the run asks
    const x = fetchOf(g, V1004);
    fetchOf(g, "Demons.Souls.v1.005.PS5.PPSA01342", { there: false });
    db.query("INSERT INTO blocklist (game_id, title, reason, way_id, plan_digest, class) VALUES (?,?,?,?,?,?)").run(g.id, V1004, "not the game file: another game", way.id, contentDigest(kytyUpgraded()), "identity");
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    expect(w.children(run.id).filter(j => j.kind === "content")).toEqual([]);
    const req = w.requests.made[0];
    w.setRequest(req, { state: "requested", stage: "no usable copy yet — searching again in 6h", next_try_at: Math.floor(w.clock.t / 1000) + 6 * 3600 });
    const r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    expect(serializeRun(r).ask!.tried).toContain(`An earlier download of Demon's Souls, ${V1004}, was refused for this way before.`);
    expect(x.id).toBeGreaterThan(0);
  });
});

describe("no room: the ask names the fix in numbers, and freeing it wakes the run", () => {
  test("the earlier download out of room three times: the room ask names the kept second copy; freeing it (the route) takes the download again at once", async () => {
    const { g, way, row1 } = demonsSouls("Fix Room");
    crdeps.diskFree = async () => 76 * GB;
    fetchOf(g, V1004);
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    for (let i = 0; i < 3; i++) {
      w.end(live(run.id, "content").id, { state: "failed", message: "not enough room on the library: 76 GB free, 101 GB needed with what it keeps free", fail: { class: "env", kind: "room" } });
      const r = await w.advance(run.id);
      if (r.state === "asking") break;                   // plainly short: asked at the first failure
      if (i < 2) { w.clock.t = r.next_at! * 1000; await w.advance(run.id); }
    }
    const r = w.run(run.id);
    expect(serializeRun(r).ask).toMatchObject({
      code: "room", title: "Demon's Souls needs more free space",
      need: "Taking in Demon's Souls's game data needs about 104 GB free on the library: what it writes, and the 50 GB ludarr keeps free (Settings → General → Import → Keep free on the library); 76 GB are free. Freeing the second copy of bbb-ps5-01342.iso kept in the game file store gives 54.2 GB back; one copy stays, and that is enough. ludarr tries again every hour.",
    });
    // the admin frees it: the run looks again at once and takes the download again
    let freed = 0;
    cadeps.freeDuplicate = async id => { freed = id; return { freedBytes: ISO }; };
    const res = await carryApi.request(`/api/v1/content/${row1.id}/free-duplicate`, { method: "POST" });
    expect([res.status, await res.json(), freed]).toEqual([200, { freedBytes: ISO }, row1.id]);
    const after = await w.advance(run.id);
    expect([after.state, serializeRun(after).ask]).toEqual(["waiting", null]);
    expect(w.children(run.id).filter(j => j.kind === "content").length).toBe(2);   // asked at the first: one failed, one after the free
    expect(w.spec(live(run.id, "content"))).toMatchObject({ kind: "content", earlier: true });
  });

  test("free-duplicate: a way using the file being built is 409, no room to re-read is 507, both in words", async () => {
    const { row1 } = demonsSouls("Fix Free");
    const { EnvError } = await import("../src/ways/errors");
    cadeps.freeDuplicate = async () => { throw new EnvError("busy", "a way using this file is being built: it is freed once that build ends"); };
    let res = await carryApi.request(`/api/v1/content/${row1.id}/free-duplicate`, { method: "POST" });
    expect([res.status, await res.json()]).toEqual([409, { error: "a way using this file is being built: it is freed once that build ends" }]);
    cadeps.freeDuplicate = async () => { throw new EnvError("room", "not enough room to read it again"); };
    res = await carryApi.request(`/api/v1/content/${row1.id}/free-duplicate`, { method: "POST" });
    expect(res.status).toBe(507);
  });
});

describe("the replace question, by the admin's own press", () => {
  test("Make it playable with replace on a run held for the question: from the plan again, replace kept, the question gone", async () => {
    const spec = { ...nx2navi() };
    const p = w.plan("NX2navi Fix Press", "recomp", spec);
    const g = w.game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"]);
    const way = w.way(g, p);
    lichii(g);
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    expect([r.state, serializeRun(r).ask!.code, serializeRun(r).ask!.need]).toEqual(["held", "go-ahead", expect.stringContaining("already plays through its PC copy (lichii.exe)")]);
    const res = await carryApi.request(`/api/v1/way/${way.id}/carry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace: true }) });
    expect(res.status).toBe(202);
    r = w.run(run.id);
    expect([r.state, r.phase, r.ask_json]).toEqual(["active", "plan", null]);
    expect(factsOfRun(run.id)).toMatchObject({ replace: true, replaceAsk: false });
    r = await w.advance(run.id);
    // the build its plan would run on players' PCs moves to the server first
    expect((w.spec(live(run.id, "construct")) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("server-build");
  });
});
