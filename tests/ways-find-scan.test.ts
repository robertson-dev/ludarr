/**
 * The content pass on real-sized shapes (src/ways/find.ts; AMEND H6, H7a, C1b, SEAMS "progress"): a game folder found by its
 * marker however many files sit before it — in a folder beside it too; a release's listing too long to read says nothing
 * (a loose app0 folder of 117,000 files is never refused for what its first files are), and a long one that can be read is
 * read whole; a make that turns its input down for its form keeps that class; an unpack says how much it has written as it
 * goes; and a way's refusal from before refusals had a class is looked at again under a plan that takes another form.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { downloadsDir } from "../src/config";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import type { KindContext } from "../src/process/kinds";
import { ctdeps } from "../src/ways/content";
import { fdeps, judgeListing, NotTheGameFile, nzbListing, takeDownload, torrentListing, wayBlocked } from "../src/ways/find";
import { contentDigest, insertContent, insertPlan, insertWay, type WayRow } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";

const realF = { ...fdeps }, realC = { ...ctdeps }, realDat = { ...datdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-scan-"));
const made = { games: [] as number[], plans: [] as number[] };
beforeAll(() => {
  ensureDefaultRootFolder(); ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
  datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats();
});
afterEach(() => { Object.assign(fdeps, realF); Object.assign(ctdeps, realC, { diskSpace: async () => ({ free: 1e15, total: 2e15 }) }); });
afterAll(() => {
  Object.assign(fdeps, realF); Object.assign(ctdeps, realC); Object.assign(datdeps, realDat); forgetDats();
  for (const id of made.games) for (const t of ["jobs", "contents", "fetches", "blocklist"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function game(name: string, platforms = ["ps5"]): GameRow {
  const g = upsertGame({ name, slug: `scan-${++seq}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function bytes(n: number, seed: number) { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; }
/** the live KytyPS5 way after its upgrade round: the .zar made from the app0 folder, loose or packed */
const zarWay = (o: Partial<ContentPlan> = {}): ContentPlan => ({
  kind: "disc", platform: "ps5", what: "Demon's Souls (PS5) as one .zar", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, place: "games/{name}",
  make: { input: { shape: "either", platform: "ps5", formats: ["rar", "7z", "zip"], marker: "sce_sys/param.json", also: ["eboot.bin"] }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { shape: "file", name: "{serial}.zar" } }, ...o,
});
function way(g: GameRow, c: ContentPlan): WayRow {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^Sc-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: { ...c, search: [g.name] }, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name: `Scan Plan ${++seq}`, kind: "emulator", repo: `scan/p-${seq}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return insertWay({ gameId: g.id, planId: p.id, content: c });
}
function ctxFor(): KindContext & { lines: string[]; messages: string[] } {
  const lines: string[] = [], messages: string[] = [];
  const work = mkdtempSync(join(tmp, "work-"));
  return { job: { id: 1 } as JobRow, spec: { kind: "content", gameId: null } as never, work, staging: join(work, "staging"), log: l => lines.push(l), progress: (_p, m) => { if (m) messages.push(m); }, signal: new AbortController().signal, lines, messages };
}
function download(name: string, files: Record<string, Uint8Array | string>): string {
  const dir = join(downloadsDir(), `scan-${++seq}-${name}`);
  for (const [rel, b] of Object.entries(files)) { mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...rel.split("/")), b); }
  return dir;
}
const fakeMake = (g: GameRow, seen: { input?: unknown }) => (async (_ctx: KindContext, o: { input: unknown }) => {
  seen.input = o.input;
  const dir = join(rootFolders()[0].path, ".ahoy-content", g.slug!); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PPSA01341.zar"), bytes(4096, 3));
  return { product: insertContent({ gameId: g.id, platform: "ps5", name: "PPSA01341.zar", path: join(dir, "PPSA01341.zar"), size: 4096, hashes: { sha1: "2".repeat(40) }, source: "made" }), reused: false };
}) as typeof fdeps.runMake;
/** a .torrent as bencode */
const be = (v: unknown): string => typeof v === "number" ? `i${v}e` : typeof v === "string" ? `${Buffer.byteLength(v)}:${v}` : Array.isArray(v) ? `l${v.map(be).join("")}e` : `d${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => be(k) + be(x)).join("")}e`;
const torrent = (name: string, files: [string, number][]) => new TextEncoder().encode(be({ announce: "http://t/a", info: { name, files: files.map(([p, n]) => ({ path: p.split("/"), length: n })), "piece length": 16384, pieces: "" } }));

describe("a game folder is found by its marker, whatever sits before it", () => {
  test("a folder of 6,000 files beside it, sorting first, never hides the app0 folder (H6)", async () => {
    const g = game("Scan Beside");
    const w = way(g, zarWay());
    const src = download("beside", { "PPSA01341-app0/sce_sys/param.json": "{}", "PPSA01341-app0/eboot.bin": "e" });
    const extras = join(src, "AAA-extras"); mkdirSync(extras, { recursive: true });
    for (let i = 0; i < 6000; i++) writeFileSync(join(extras, `${String(i).padStart(5, "0")}.png`), "");
    const seen: { input?: unknown } = {};
    fdeps.inputMatches = () => ({ ok: true, why: null });
    fdeps.runMake = fakeMake(g, seen);
    const r = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(seen.input).toEqual({ from: "indexer", path: join(src, "PPSA01341-app0"), fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "proven", made: true });
  }, 120_000);
});

describe("a release's listing", () => {
  test("one too long to read says nothing (null: judged as before); a long one is read whole, so a marker after 20,000 files is seen", () => {
    const files: [string, number][] = Array.from({ length: 11 }, (_, i) => [`d/${i}.bin`, 1]);
    expect(torrentListing(torrent("T", files), 10)).toBeNull();
    expect(torrentListing(torrent("T", files), 11)!.length).toBe(11);
    const nzb = `<nzb>${Array.from({ length: 3 }, (_, i) => `<file subject="&quot;p${i}.rar&quot; yEnc"><segments><segment bytes="1">x</segment></segments></file>`).join("")}</nzb>`;
    expect(nzbListing(nzb, 2)).toBeNull();
    expect(nzbListing(nzb)!.map(f => f.path)).toEqual(["p0.rar", "p1.rar", "p2.rar"]);
    // a loose app0 folder: 25,000 data files, then its sce_sys
    const loose: [string, number][] = [...Array.from({ length: 25_000 }, (_, i) => [`PPSA01341-app0/aaa/${String(i).padStart(5, "0")}.dat`, 1024] as [string, number]), ["PPSA01341-app0/eboot.bin", 1], ["PPSA01341-app0/sce_sys/param.json", 1]];
    const listed = torrentListing(torrent("Demons.Souls.PS5-LOOSE", loose))!;
    expect(listed.length).toBe(25_002);
    expect(judgeListing(zarWay(), listed)).toEqual({ ok: true, why: null });
  });
});

describe("a make that turns its input down", () => {
  test("for its form only: the release is refused as 'form' (looked at again once the plan changes), not as another game", async () => {
    const g = game("Scan Make Form");
    const w = way(g, zarWay());
    const src = download("formonly", { "Demons.Souls.PPSA01341.rar": bytes(4096, 4) });
    fdeps.inputMatches = () => ({ ok: true, why: null });
    fdeps.runMake = (async () => { throw new NotTheGameFile("Demons.Souls.PPSA01341.rar holds no folder with sce_sys/param.json", "form"); }) as typeof fdeps.runMake;
    const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null }).catch(x => x);
    expect(e).toBeInstanceOf(NotTheGameFile);
    expect((e as NotTheGameFile).cls).toBe("form");
    expect((e as Error).message).toBe("not the game file: Demons.Souls.PPSA01341.rar holds no folder with sce_sys/param.json");
  });
});

describe("an unpack says how much it has written", () => {
  test("every few seconds while the archiver runs, from the scratch volume's free space; nothing once it ends", async () => {
    const g = game("Scan Unpack", ["ps2"]);
    const disc: ContentPlan = { kind: "disc", platform: "ps2", what: "a PS2 disc", search: ["Scan Unpack"], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}" };
    const w = way(g, disc);
    const src = download("unpack", { "Scan.Unpack.PS2-GRP.7z": bytes(3 * 2 ** 20, 5) });
    let free = 100 * 2 ** 30;                                                  // room besides the 50 GB the library keeps free
    ctdeps.diskSpace = async () => ({ free, total: 2e15 });
    fdeps.unpackEvery = 5;
    fdeps.extract = async () => { for (let i = 0; i < 12; i++) { free -= 2 ** 20; await Bun.sleep(8); } };   // writes 12 MB, nothing a way takes
    const ctx = ctxFor();
    const e = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null }).catch(x => x);
    expect(e).toBeInstanceOf(NotTheGameFile);
    const said = ctx.messages.filter(m => m.startsWith("unpacking Scan.Unpack.PS2-GRP.7z"));
    expect(said[0]).toBe("unpacking Scan.Unpack.PS2-GRP.7z");
    const unit: Record<string, number> = { KB: 1e3, MB: 1e6, GB: 1e9 };
    const written = said.slice(1).map(m => { const x = / · ([\d.]+) (KB|MB|GB) written so far \(the archive is 3 MB\)$/.exec(m); return x ? Number(x[1]) * unit[x[2]] : NaN; });
    expect(written.length).toBeGreaterThan(2);
    expect(written.every(n => Number.isFinite(n))).toBe(true);
    expect(Math.max(...written)).toBeGreaterThan(written[0]);
    const after = ctx.messages.length;
    await Bun.sleep(40);
    expect(ctx.messages.length).toBe(after);                                  // the timer ended with the archiver
  });
});

describe("a way's refusals from before refusals had a class", () => {
  test("an old form refusal ('no PlayStation 5 game file in the download') is looked at again under a plan that takes another form; an old 'another game' never; the game's own never", () => {
    const g = game("Scan Legacy Rows");
    const w = way(g, zarWay({ make: null }));
    stmts.insertWayBlock.run(g.id, "guid:noform", "Demons.Souls.App0.PS5-GRP", "T", "not the game file: no PlayStation 5 game file in the download (.zar)", w.id, null, null);
    stmts.insertWayBlock.run(g.id, "guid:tracks", "Some.Disc.PS5-GRP", "T", "not the game file: a disc of several tracks: this way keeps one game file (a single-file image is needed)", w.id, null, null);
    stmts.insertWayBlock.run(g.id, "guid:other", "Other.Game.PS5-GRP", "T", "not the game file: x.zar is another game (its serial is PPSA09999, and this takes PPSA01341)", w.id, null, null);
    stmts.insertBlock.run(g.id, "guid:game", "Stalled.PS5-GRP", "T", "stalled");
    const now = wayBlocked(g.id, w.id, zarWay());
    expect(["guid:noform", "guid:tracks", "guid:other", "guid:game"].map(x => now.has(x))).toEqual([false, false, true, true]);
    // a row written with its class and digest is judged by those, as before
    stmts.insertWayBlock.run(g.id, "guid:v2form", "New.Form.PS5-GRP", "T", "not the game file: it holds no .zar", w.id, contentDigest(zarWay()), "form");
    expect(wayBlocked(g.id, w.id, zarWay()).has("guid:v2form")).toBe(true);
  });
});
