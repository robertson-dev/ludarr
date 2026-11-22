/**
 * A carry run's step that the seedbox's folder broke off (src/remote.ts: a job that read the mapped folder while it did not
 * answer or was remounted ends with fail {class: "env", kind: "remote"}): waited out on a short ladder of its own — 5, 15,
 * 30 min, then hourly — that is no try of the step (the usual ladder asks after four), and asked about only after 6 h; and an
 * earlier download on the seedbox's folder while that is down is waited for, never passed by for the indexers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, type JobRow } from "../src/db";
import { probeRoot, resetRemote, rmdeps } from "../src/remote";
import { serializeRun } from "../src/ways/carry";
import { MM_SHA1, world, zeldaPlan, type World } from "./carry-world";

let w: World;
const savedRm = { ...rmdeps };
const extra: number[] = [];
beforeEach(() => { w = world(); resetRemote(); });
afterEach(() => {
  for (const id of extra.splice(0)) db.query("DELETE FROM fetches WHERE id=?").run(id);
  w.cleanup();
  Object.assign(rmdeps, savedRm);
  resetRemote();
});

const kidOf = (runId: number, kind: string): JobRow => { const j = w.live(runId); expect(j?.kind).toBe(kind); return j!; };
const texts = (runId: number) => w.steps(runId).map(s => s.text);
function recomp(name: string) {
  const p = w.plan(`Carry ${name}`, "recomp", zeldaPlan(true));
  const g = w.game("The Legend of Zelda: Majora's Mask", ["N64"], { year: 2000 });
  return { p, g, way: w.way(g, p) };
}

describe("a carry run and the seedbox", () => {
  test("a step the seedbox broke off waits 5, 15, 30 min, then hourly, without spending the run's tries; it asks only after 6 h", async () => {
    const { g, way } = recomp("Seedbox Remote");
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const waits: number[] = [];
    let asked = false;
    for (let i = 0; i < 14 && !asked; i++) {
      w.end(kidOf(run.id, "assemble").id, { state: "failed", message: "the seedbox folder was remounted while it was being read — tried again once it answers steadily", fail: { class: "env", kind: "remote" } });
      const r = await w.advance(run.id);
      if (r.state === "asking") { asked = true; break; }
      expect(r.state).toBe("waiting");
      waits.push(r.next_at! - Math.floor(w.clock.t / 1000));
      expect(texts(run.id).at(-1)).toMatch(/waits for the seedbox: the seedbox folder was remounted while it was being read — tried again once it answers steadily; trying again (?:at|tomorrow at) \d\d:\d\d$/);
      w.clock.t = r.next_at! * 1000; await w.advance(run.id);
    }
    // nine waits where the usual ladder (30 min, 2 h, 8 h, 24 h) would have asked after four
    expect(waits).toEqual([300, 900, 1800, 3600, 3600, 3600, 3600, 3600, 3600]);
    expect(asked).toBe(true);
    const r = w.run(run.id)!;
    expect(JSON.parse(r.ask_json!)).toMatchObject({ code: "env" });
    expect(r.next_at! - Math.floor(w.clock.t / 1000)).toBe(3600);           // and it is still tried every hour
  });

  test("an earlier download on the seedbox's folder while that does not answer is waited for, never passed by for a new download", async () => {
    const { g, way } = recomp("Seedbox Earlier");
    const root = join(w.dir, "remote", "downloads");
    mkdirSync(root, { recursive: true });
    rmdeps.roots = () => [{ from: "/home/user/downloads", to: root, client: "rTorrent (direct)", instanceId: 7 }];
    rmdeps.probe = async () => ({ ok: false, ms: 10_000, entries: null, dev: null, mounted: false, why: "Transport endpoint is not connected" });
    rmdeps.now = () => w.clock.t;
    await probeRoot(root);
    const path = join(root, "Majoras.Mask.N64-GRP.zip");                     // not there: the folder shows nothing while it is down
    const row = db.query("INSERT INTO fetches (game_id, title, protocol, client, state, local_path, size) VALUES (?,?,?,?,?,?,?) RETURNING id").get(g.id, "Majoras.Mask.N64-GRP", "torrent", "rtorrent", "done", path, 32_000_000) as { id: number };
    extra.push(row.id);
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id, 6);
    expect(w.requests.made).toEqual([]);                                     // no search for another copy
    expect(texts(run.id).at(-1)).toBe("waiting for the seedbox folder to answer: the earlier download Majoras.Mask.N64-GRP is on it");
    // the folder answers again and holds it: it is offered to the way
    rmdeps.probe = async () => ({ ok: true, ms: 4, entries: 3, dev: "fuse-2", mounted: true, why: null });
    await probeRoot(root);
    writeFileSync(path, "zip");
    w.clock.t += 5 * 60_000;
    await w.advance(run.id, 6);
    expect(w.requests.made).toEqual([]);
    expect(w.live(run.id)?.kind).toBe("content");
  });
});

/* ─────────── the review's cases (2026-11-09) ─────────── */

const REMOTE_FAIL = { class: "env" as const, kind: "remote" };
const REMOUNTED = "the seedbox folder was remounted while it was being read (it ended: ENOENT: no such file or directory)";
/** a mapped seedbox folder in the world's folder, its probe as given, and an earlier download of the game on it */
async function seedboxWith(g: { id: number }, probe: { ok: boolean; entries: number | null; mounted: boolean | null; dev?: string | null }, o: { present?: boolean } = {}) {
  const root = join(w.dir, "remote", "downloads");
  mkdirSync(root, { recursive: true });
  rmdeps.roots = () => [{ from: "/home/user/downloads", to: root, client: "rTorrent (direct)", instanceId: 7 }];
  rmdeps.probe = async () => ({ ms: 3, dev: probe.dev ?? "fuse-1", why: probe.ok ? null : "Transport endpoint is not connected", ...probe } as never);
  rmdeps.now = () => w.clock.t;
  await probeRoot(root);
  const path = join(root, "Majoras.Mask.N64-GRP.zip");
  if (o.present) writeFileSync(path, "zip");
  const row = db.query("INSERT INTO fetches (game_id, title, protocol, client, client_id, state, local_path, size) VALUES (?,?,?,?,?,?,?,?) RETURNING id").get(g.id, "Majoras.Mask.N64-GRP", "torrent", "rtorrent", "HMM", "done", path, 32_000_000) as { id: number };
  extra.push(row.id);
  return { root, path };
}

describe("a carry run and the seedbox: the review's cases", () => {
  test("after a restart the mount is not up yet (the folder reads empty and nothing is mounted there): the earlier download on it is waited for, never passed by for a new search", async () => {
    const { g, way } = recomp("Seedbox Boot");
    await seedboxWith(g, { ok: true, entries: 0, mounted: false, dev: "2049" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id, 6);
    expect(w.requests.made).toEqual([]);
    expect(texts(run.id).at(-1)).toBe("waiting for the seedbox folder to answer: the earlier download Majoras.Mask.N64-GRP is on it");
  });

  test("an earlier download the folder (which answers) does not show: waited for while its client still has it — passed by only once the client no longer does", async () => {
    const { g, way } = recomp("Seedbox Lost Sight");
    await seedboxWith(g, { ok: true, entries: 3, mounted: true });
    rmdeps.clientView = async () => ({ answered: true, has: true, name: "rTorrent" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id, 6);
    expect(w.requests.made).toEqual([]);
    expect(texts(run.id).at(-1)).toBe("the seedbox folder does not show the earlier download Majoras.Mask.N64-GRP, though its download client still has it (check the remote path mapping): waiting for it");
    rmdeps.clientView = async () => ({ answered: true, has: false, name: "rTorrent" });
    w.clock.t += 5 * 60_000;
    await w.advance(run.id, 6);
    expect(w.requests.made).toHaveLength(1);
  });

  test("a run that asked after 6 h of seedbox trouble holds the route: a poke before its hour walks nowhere — no search for another copy", async () => {
    const { g, way } = recomp("Seedbox Asking");
    await seedboxWith(g, { ok: true, entries: 3, mounted: true }, { present: true });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id, 6);
    let asked = false;
    for (let i = 0; i < 14 && !asked; i++) {
      const kid = w.live(run.id) as JobRow;
      expect(kid?.kind).toBe("content");
      w.end(kid.id, { state: "failed", message: REMOUNTED, fail: REMOTE_FAIL });
      const r = await w.advance(run.id);
      if (r.state === "asking") { asked = true; break; }
      w.clock.t = r.next_at! * 1000; await w.advance(run.id, 6);
    }
    expect(asked).toBe(true);
    expect(JSON.parse(w.run(run.id).ask_json!)).toMatchObject({ title: expect.stringMatching(/waits for the seedbox$/) });
    w.clock.t += 60_000;                                                     // any job or request event of the game pokes it
    await w.advance(run.id, 6);
    expect(w.requests.made).toEqual([]);
    expect(w.live(run.id)).toBeNull();
  });

  test("72 h of seedbox trouble: the run stops trying by itself and asks (Look again tries at once) — never a job every hour for ever, never an ask that comes and goes", async () => {
    const { g, way } = recomp("Seedbox Stop");
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const t0 = w.clock.t;
    let jobs = 0, flaps = 0, wasAsking = false;
    for (let i = 0; i < 200; i++) {
      const kid = w.live(run.id);
      if (!kid) break;
      jobs++;
      w.end(kid.id, { state: "failed", message: REMOUNTED, fail: REMOTE_FAIL });
      const r = await w.advance(run.id);
      if (wasAsking && r.state !== "asking") flaps++;
      wasAsking = r.state === "asking";
      if (r.next_at == null) break;
      w.clock.t = r.next_at * 1000; await w.advance(run.id);
      if (wasAsking && w.run(run.id).state !== "asking") flaps++;
    }
    const r = w.run(run.id);
    expect(r.state).toBe("asking"); expect(r.next_at).toBeNull();
    expect(w.clock.t - t0).toBeGreaterThanOrEqual(72 * 3600_000);
    expect(jobs).toBeLessThan(80);
    expect(flaps).toBe(0);
    expect(JSON.parse(r.ask_json!).need).toMatch(/does not try it again by itself: press Look again once the seedbox answers\.$/);
    w.clock.t += 6 * 3600_000; await w.advance(run.id, 6);
    expect(w.live(run.id)).toBeNull();
  });

  test("a step that ended on what may be a failed read of the seedbox folder (a 7z listing that ran out of time) is run once more, as its confirming run, before the refusal counts", async () => {
    const { g, way } = recomp("Seedbox Confirm");
    const { root } = await seedboxWith(g, { ok: true, entries: 3, mounted: true }, { present: true });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id, 6);
    const first = w.live(run.id) as JobRow;
    expect(first.kind).toBe("content");
    const why = "not the game file: Majoras.Mask.N64-GRP.zip could be listed only in part (7z ran out of time: …): a volume may be missing or the archive is damaged";
    w.end(first.id, { state: "failed", message: why, fail: { class: "file", kind: "form", remote: { root, troubled: false, io: true } } });
    let r = await w.advance(run.id);
    expect(r.state).toBe("waiting");
    expect(texts(run.id).at(-1)).toMatch(/ended on what may be a failed read of the seedbox folder .*: it runs once more before that counts; trying again/);
    w.clock.t = r.next_at! * 1000; await w.advance(run.id, 6);
    const second = w.live(run.id) as JobRow;
    expect(second.id).not.toBe(first.id);
    expect(w.spec(second)).toMatchObject({ kind: "content", confirm: true });
    w.end(second.id, { state: "failed", message: why, fail: { class: "file", kind: "form", remote: { root, troubled: false, io: true, confirmed: true } } });
    r = await w.advance(run.id);
    expect(texts(run.id).some(t => t.startsWith("refused: not the game file"))).toBe(true);
  });

  test("a run waiting on the seedbox says so — never 'could not run on this server', never the runner's 'once it answers steadily'", async () => {
    const { g, way } = recomp("Seedbox Now");
    w.kept(g, "mm.z64", { sha1: MM_SHA1, platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    w.end(kidOf(run.id, "assemble").id, { state: "failed", message: REMOUNTED, fail: REMOTE_FAIL });
    await w.advance(run.id);
    const now = serializeRun(w.run(run.id)).now?.text ?? "";
    expect(now).toMatch(/^Building The Legend of Zelda: Majora's Mask waits for the seedbox \(the seedbox folder was remounted while it was being read/);
    expect(now).not.toMatch(/could not run on this server|once it answers steadily/);
  });
});
