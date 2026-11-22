/**
 * What the merge of wave 3 wired into the content pass (src/ways/find.ts): a plan that lists a main program's build proves
 * a file by it, as a serial does (B2a's .nup and exefs readers give the build); the serial check before a file is read
 * keeps the plan's formats, so a sealed NSP an emulator way takes is not refused there; and a make that refuses its input
 * only for its form keeps that class, so the release is looked at again once the way's plan changes.
 */
import { generalTemplate } from "./emulator-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, upsertGame, type GameRow, type JobRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { downloadsDir } from "../src/config";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import type { KindContext } from "../src/process/kinds";
import { ctdeps } from "../src/ways/content";
import { failOf } from "../src/ways/errors";
import { canProve, fdeps, judgeFile, NotTheGameFile, takeDownload } from "../src/ways/find";
import { MakeRefused } from "../src/ways/make";
import { getContent, getWay, insertContent, insertPlan, insertWay } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";

const realF = { ...fdeps }, realC = { ...ctdeps }, realDat = { ...datdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-find-int-"));
const made = { games: [] as number[], plans: [] as number[] };
beforeAll(() => {
  ensureDefaultRootFolder(); ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
  datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats();
});
afterEach(() => { Object.assign(fdeps, realF); Object.assign(ctdeps, realC, { diskSpace: async () => ({ free: 1e15, total: 2e15 }) }); });
afterAll(() => {
  Object.assign(fdeps, realF); Object.assign(ctdeps, realC); Object.assign(datdeps, realDat); forgetDats();
  for (const id of made.games) for (const t of ["jobs", "contents", "fetches", "blocklist", "requests"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

const MB = 2 ** 20;
const OOT = "0400486024DEC000", BUILD = "e0f3ccfaf50065ae4ea01eb5aeb13b1a";
let seq = 0;
function game(name: string, platforms: string[]): GameRow {
  const g = upsertGame({ name, slug: `find-int-${++seq}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function plan(name: string, c: ContentPlan) {
  const spec = { program: { kind: "release", assetPattern: "^E-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: generalTemplate(c), files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: [] } as unknown as RuntimePlanSpec;
  const p = insertPlan({ name, kind: "emulator", repo: `findint/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
}
function download(name: string, files: Record<string, Uint8Array | string>): string {
  const dir = join(downloadsDir(), `find-int-${++seq}-${name}`);
  for (const [rel, b] of Object.entries(files)) { mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...rel.split("/")), b); }
  return dir;
}
function ctxFor(): KindContext & { lines: string[] } {
  const lines: string[] = [];
  const work = mkdtempSync(join(tmp, "work-"));
  return { job: { id: 1 } as JobRow, spec: { kind: "content", gameId: null } as never, work, staging: join(work, "staging"), log: (l: string) => lines.push(l), progress: () => {}, signal: new AbortController().signal, trace: () => {}, tier: () => {}, lines } as unknown as KindContext & { lines: string[] };
}
/** an NSP as B2a's reader knows one (PFS0, a ticket named by its rights id), padded to a size a Switch game comes in */
function nsp(title: string, size = 64 * MB + 4096): Uint8Array {
  const names = [`${title.toLowerCase()}0000000000000005.tik`, `${title.toLowerCase()}0000000000000005.cert`, "a1b2c3.nca"];
  const strs = new TextEncoder().encode(names.join("\0") + "\0");
  const h = new Uint8Array(size);
  h.set(new TextEncoder().encode("PFS0"), 0);
  const dv = new DataView(h.buffer);
  dv.setUint32(4, names.length, true); dv.setUint32(8, strs.length, true);
  let so = 0;
  names.forEach((nm, i) => { dv.setUint32(16 + i * 24 + 16, so, true); so += nm.length + 1; });
  h.set(strs, 16 + names.length * 24);
  return h;
}
const nupWay = (accept: ContentPlan["accept"]): ContentPlan => ({ kind: "rom", platform: "switch", what: `program ${OOT}`, search: ["Ocarina of Time"], accept, place: "game.nup" } as ContentPlan);
const pass = (c: ContentPlan) => ({ content: c, names: ["Ocarina of Time"], asked: [], disc: null, dat: null }) as never;

describe("a main program's build proves a file, as a serial does", () => {
  test("a plan that lists builds can prove files of a console whose dumps carry one; with neither, it cannot", () => {
    expect(canProve(nupWay({ hashes: [], formats: ["nup"], builds: [BUILD] }))).toBe(true);
    expect(canProve(nupWay({ hashes: [], formats: ["nup"], serials: [OOT] }))).toBe(true);
    expect(canProve(nupWay({ hashes: [], formats: ["nup"] }))).toBe(false);
  });
  test("a .nup whose main program's build is one the plan accepts is proven by it; another build is refused", () => {
    const c = nupWay({ hashes: [], formats: ["nup"], builds: [BUILD] });
    const facts = { platform: "switch", name: "oot.nup", size: 25e9, hashes: {}, identity: { platform: "switch", serial: OOT, shape: "nup", build: `${BUILD}00000000000000000000000000000000` } };
    expect(judgeFile(pass(c), "oot.nup", facts as never)).toEqual({ verdict: "proven", why: "its main program's build e0f3ccfa… is one the way accepts", by: "build" });
    const other = { ...facts, identity: { ...facts.identity, build: "f".repeat(64) } };
    expect(judgeFile(pass(c), "oot.nup", other as never).verdict).toBe("refused");
  });
});

describe("the serial check before a file is read keeps the plan's formats", () => {
  test("an emulator way that takes NSPs of a title: the sealed NSP passes the early check and is proven by its title id", async () => {
    const c = { kind: "rom", platform: "switch", what: "the game as an NSP", search: ["Ocarina of Time"], accept: { hashes: [], formats: ["nsp"], serials: [OOT] }, place: "game.nsp" } as ContentPlan;
    const g = game("Find Int Nsp", ["Switch"]);
    const w = insertWay({ gameId: g.id, planId: plan("Find Int Nsp Emu", c).id, content: c });
    const src = download("nsp", { "game.nsp": nsp(OOT) });
    const r = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "proven", wayId: w.id, file: "game.nsp", by: "serial" });
    expect(getContent(getWay(w.id)!.content_id!)).toMatchObject({ name: "game.nsp" });
  }, 60_000);
});

describe("a make that refuses its input keeps the class it gave", () => {
  const zarWay = (): ContentPlan => ({
    kind: "disc", platform: "ps5", what: "Demon's Souls (PS5) as one .zar", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, place: "games/{name}",
    make: { input: { shape: "either", platform: "ps5", formats: ["rar"], marker: "sce_sys/param.json" }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { name: "{serial}.zar", shape: "file" } },
  } as unknown as ContentPlan);
  test("refused only for its form: the release is refused as 'form' (looked at again once the plan changes); for the game itself: 'identity'", async () => {
    const g = game("Find Int Make Form", ["PS5"]);
    const w = insertWay({ gameId: g.id, planId: plan("Find Int Kyty", zarWay()).id, content: zarWay() });
    fdeps.inputMatches = () => ({ ok: true, why: null });
    fdeps.runMake = (async () => { throw new MakeRefused("Demons.Souls.PPSA01341.rar holds the game only as a disc image, and this makes from the game folder", "form"); }) as typeof fdeps.runMake;
    const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: download("form", { "Demons.Souls.PPSA01341.rar": "rar" }), fetchId: null }).catch(x => x);
    expect(e).toBeInstanceOf(NotTheGameFile);
    expect((e as NotTheGameFile).cls).toBe("form");
    expect(failOf(e)).toEqual({ class: "file", kind: "form" });
    fdeps.runMake = (async () => { throw new MakeRefused("Other.Game.rar is another game (its title id is PPSA09999, and this takes PPSA01341)", "identity"); }) as typeof fdeps.runMake;
    const e2 = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: download("identity", { "Other.Game.rar": "rar" }), fetchId: null }).catch(x => x);
    expect((e2 as NotTheGameFile).cls).toBe("identity");
    expect(failOf(e2)).toEqual({ class: "file" });
  });
});

describe("an earlier download a carry run offers the way is only read", () => {
  const fetchOf = (g: GameRow, title: string, path: string): number =>
    (db.query("INSERT INTO fetches (game_id, title, protocol, client, state, local_path, size) VALUES (?,?,?,?,?,?,?) RETURNING id").get(g.id, title, "torrent", "rtorrent", "done", path, 8192) as { id: number }).id;
  const importedAt = (id: number) => (db.query("SELECT imported_at FROM fetches WHERE id=?").get(id) as { imported_at: number | null }).imported_at;
  test("refused, or made into the way's file: the download stays where it was, and its fetch is not marked imported", async () => {
    const zar = (): ContentPlan => ({
      kind: "disc", platform: "ps5", what: "Demon's Souls (PS5) as one .zar", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, place: "games/{name}",
      make: { input: { shape: "either", platform: "ps5", formats: ["rar"], marker: "sce_sys/param.json" }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { name: "{serial}.zar", shape: "file" } },
    } as unknown as ContentPlan);
    const g = game("Find Int Earlier", ["PS5"]);
    const w = insertWay({ gameId: g.id, planId: plan("Find Int Earlier Kyty", zar()).id, content: zar() });
    // refused (another game): left as it was, unlike a search's own download
    const other = download("earlier-other", { "Other.Game.PPSA09999.rar": "rar" });
    const f1 = fetchOf(g, "Other.Game.PPSA09999", other);
    fdeps.inputMatches = () => ({ ok: false, why: "another game (its title id is PPSA09999, and this takes PPSA01341)" });
    const ctx = ctxFor();
    const e = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: other, fetchId: f1, earlier: true }).catch(x => x);
    expect(e).toBeInstanceOf(NotTheGameFile);
    expect(statSync(join(other, "Other.Game.PPSA09999.rar")).isFile()).toBe(true);
    expect(importedAt(f1)).toBeNull();
    expect(ctx.lines).toContain("the earlier download stays as it was: it was only read");
    // made into the way's file: the product is the way's, the download is still there and not marked imported
    const mine = download("earlier-mine", { "Demons.Souls.v1.004.PS5.PPSA01341.rar": "rar" });
    const f2 = fetchOf(g, "Demons.Souls.v1.004.PS5.PPSA01341", mine);
    fdeps.inputMatches = () => ({ ok: true, why: null });
    fdeps.runMake = (async () => {
      const dir = join(rootFolders()[0].path, ".ahoy-content", g.slug!); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "PPSA01341.zar"), "zar");
      const product = insertContent({ gameId: g.id, platform: "ps5", name: "PPSA01341.zar", path: join(dir, "PPSA01341.zar"), size: 3, hashes: { sha1: "2".repeat(40) }, source: "made", identity: { platform: "ps5", serial: "PPSA01341", shape: "zar" } });
      return { product, reused: false };
    }) as typeof fdeps.runMake;
    const r = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: mine, fetchId: f2, earlier: true });
    expect(r.manifest).toMatchObject({ outcome: "proven", wayId: w.id, made: true });
    expect(statSync(join(mine, "Demons.Souls.v1.004.PS5.PPSA01341.rar")).isFile()).toBe(true);
    expect(importedAt(f2)).toBeNull();
    // A search's own rejected download is also retained for the administrator.
    const again = download("search-own", { "Other.Game.PPSA09999.rar": "rar" });
    const f3 = fetchOf(g, "Other.Game.PPSA09999 (search)", again);
    fdeps.inputMatches = () => ({ ok: false, why: "another game" });
    await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: again, fetchId: f3 }).catch(() => null);
    expect(importedAt(f3)).toBeNull();
  });
});
