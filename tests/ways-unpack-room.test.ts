/**
 * Where a download's archive is unpacked when the way's make takes only the game folder (src/ways/make.ts unpackRoom, used
 * by src/ways/find.ts): in the job's folder on the library when the library holds the unpack and what is kept from it;
 * else on the downloads folder's volume (another disk, never a network or read-only mount), with only what is kept written
 * on the library; else refused in words with the numbers. The live shape: the library on the 1.9 TB cache pool with 76 GB
 * free and 50 GB kept free, the downloads folder on the array with 34 TB free, the RAR 54 GB.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { db, upsertGame, type GameRow, type JobRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { downloadsDir } from "../src/config";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import type { KindContext } from "../src/process/kinds";
import { ctdeps } from "../src/ways/content";
import { fdeps, takeDownload } from "../src/ways/find";
import { mkdeps, unpackRoom } from "../src/ways/make";
import { insertContent, insertPlan, insertWay } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";

const realM = { ...mkdeps }, realF = { ...fdeps }, realC = { ...ctdeps }, realDat = { ...datdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-unpack-room-"));
const made = { games: [] as number[], plans: [] as number[] };
beforeAll(() => {
  ensureDefaultRootFolder(); ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
  datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats();
});
afterEach(() => { Object.assign(mkdeps, realM); Object.assign(fdeps, realF); Object.assign(ctdeps, realC, { diskSpace: async () => ({ free: 1e15, total: 2e15 }) }); });
afterAll(() => {
  Object.assign(mkdeps, realM); Object.assign(fdeps, realF); Object.assign(ctdeps, realC); Object.assign(datdeps, realDat); forgetDats();
  for (const id of made.games) for (const t of ["jobs", "contents", "fetches", "blocklist", "requests"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

const RAR = 54_255_919_283;
const under = (p: string, dir: string) => resolve(p) === resolve(dir) || resolve(p).startsWith(resolve(dir) + sep);
/** the live volumes: the library (the job's folder) 1.9 TB with `libraryFree` free, the downloads folder 77 TB with 34 TB */
function volumes(o: { libraryFree: number; downloadsMount?: { fstype: string; options: string[] } }) {
  const dl = mkdtempSync(join(tmp, "downloads-"));
  mkdeps.downloadsDir = () => dl;
  mkdeps.keepFreeBytes = () => 50e9;
  mkdeps.mountOf = p => (under(p, dl) ? { at: dl, ...(o.downloadsMount ?? { fstype: "fuse.shfs", options: ["rw", "nosuid"] }) } : { at: "/", fstype: "fuse.shfs", options: ["rw"] });
  mkdeps.diskSpace = async p => (under(p, dl) ? { free: 34e12, total: 77e12 } : { free: o.libraryFree, total: 1.9e12 });
  const work = join(tmp, `lib-${Math.round(o.libraryFree / 1e9)}`, ".work", "job-77");
  mkdirSync(work, { recursive: true });
  return { dl, work };
}

describe("where an archive is unpacked", () => {
  test("the library holds the unpack and what is kept from it: in the job's own folder", async () => {
    const v = volumes({ libraryFree: 200e9 });
    expect(await unpackRoom(v.work, RAR, { here: RAR, away: RAR })).toEqual({ dir: v.work, away: false });
  });
  test("the duplicate freed (130 GB free): the unpack goes on the downloads folder's volume, the product stays on the library", async () => {
    const v = volumes({ libraryFree: 130e9 });
    const r = await unpackRoom(v.work, RAR, { here: RAR, away: RAR });
    expect(r).toEqual({ dir: join(resolve(v.dl), ".ahoy-work", "job-77"), away: true });
    expect(statSync(join(v.dl, ".ahoy-work", "job-77")).isDirectory()).toBe(true);
  });
  test("as it is today (26 GB usable): refused in words, with both volumes' numbers, and nothing made away", async () => {
    const v = volumes({ libraryFree: 76e9 });
    const r = await unpackRoom(v.work, RAR, { here: RAR, away: RAR });
    expect(r).toEqual({ why: `not enough room: what it keeps (about 54.3 GB) is written on the library, and 26.0 GB is free there above the 50.0 GB it keeps free (Settings → General → Import); the unpack (about 54.3 GB) would go on the downloads folder (${resolve(v.dl)}, 34000 GB free)` });
    expect(existsSync(join(v.dl, ".ahoy-work", "job-77"))).toBe(false);
  });
  test("a downloads folder on a network mount never takes an unpack", async () => {
    const v = volumes({ libraryFree: 130e9, downloadsMount: { fstype: "fuse.rclone", options: ["ro"] } });
    const r = await unpackRoom(v.work, RAR, { here: RAR, away: RAR });
    expect("why" in r && r.why).toContain("the downloads folder cannot take the unpack: the downloads folder");
    expect("why" in r && r.why).toContain("mounted read-only");
  });
});

describe("a download whose archive holds the game folder a way's make takes", () => {
  const folderWay = (): ContentPlan => ({
    kind: "disc", platform: "ps5", what: "Demon's Souls (PS5) as one .zar", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, place: "games/{name}",
    make: { input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json" }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { name: "{serial}.zar", shape: "file" } },
  } as unknown as ContentPlan);
  test("unpacked where unpackRoom says (the downloads folder's volume when the library is short), then made into the way's file", async () => {
    const g = upsertGame({ name: "Unpack Room Kyty", slug: "unpack-room-kyty", platforms_json: JSON.stringify(["PS5"]) } as Partial<GameRow>) as GameRow;
    made.games.push(g.id);
    const spec = { program: { kind: "release", assetPattern: "^K-.*[.]zip$", channel: "stable" }, launch: { exe: "k.exe", argv: ["{content}"] }, content: { ...folderWay(), search: [g.name] }, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: [] } as unknown as RuntimePlanSpec;
    const p = insertPlan({ name: "Unpack Room Kyty", kind: "emulator", repo: "unpackroom/kyty", platforms: ["ps5"], spec, status: "ready" });
    made.plans.push(p.id);
    const w = insertWay({ gameId: g.id, planId: p.id, content: folderWay() });
    const src = join(downloadsDir(), `unpack-room-${g.id}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "Demons.Souls.v1.004.PS5.PPSA01341.rar"), "Rar!".padEnd(4096, "r"));
    const away = mkdtempSync(join(tmp, "away-job-"));
    const seen: { out?: string; input?: unknown } = {};
    fdeps.unpackRoom = async () => ({ dir: away, away: true });
    fdeps.extract = (async (_o: unknown, _archive: string, out: string) => {
      seen.out = out;
      mkdirSync(join(out, "PPSA01341-app0", "sce_sys"), { recursive: true });
      writeFileSync(join(out, "PPSA01341-app0", "sce_sys", "param.json"), "{}");
      writeFileSync(join(out, "PPSA01341-app0", "eboot.bin"), "e");
    }) as typeof fdeps.extract;
    fdeps.inputMatches = () => ({ ok: true, why: null });
    fdeps.runMake = (async (_ctx: KindContext, o: { input: unknown }) => {
      seen.input = o.input;
      const dir = join(rootFolders()[0].path, ".ahoy-content", g.slug!); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "PPSA01341.zar"), "zar");
      return { product: insertContent({ gameId: g.id, platform: "ps5", name: "PPSA01341.zar", path: join(dir, "PPSA01341.zar"), size: 3, hashes: { sha1: "3".repeat(40) }, source: "made", identity: { platform: "ps5", serial: "PPSA01341", shape: "zar" } }), reused: false };
    }) as typeof fdeps.runMake;
    const lines: string[] = [];
    const work = mkdtempSync(join(tmp, "work-"));
    const ctx = { job: { id: 5 } as JobRow, spec: { kind: "content", gameId: g.id } as never, work, staging: join(work, "staging"), log: (l: string) => lines.push(l), progress: () => {}, signal: new AbortController().signal, trace: () => {}, tier: () => {} } as unknown as KindContext;
    const r = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "proven", wayId: w.id, made: true });
    expect(under(seen.out!, away)).toBe(true);
    expect(seen.input).toEqual({ from: "indexer", path: join(seen.out!, "PPSA01341-app0"), fetchId: null });
    expect(lines.some(l => l.startsWith("unpacking Demons.Souls.v1.004.PS5.PPSA01341.rar on the downloads folder's volume"))).toBe(true);
  });
});
