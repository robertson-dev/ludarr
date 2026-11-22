/**
 * The content pass for v2 shapes (src/ways/find.ts; DESIGN3 B2.6, AMEND H6, H7a, H7c, L4, L6): the sizes PlayStation and
 * Switch games come in; a release whose title says its data is sealed for the console, refused before any download for a
 * way that takes neither it nor makes from it; a release's own listing judged before it is grabbed; a game folder found by
 * its marker without walking its 20,000 files; game data the way's make takes made into its file in the same job; a
 * download read once (where it lies, or as it is copied); the way's own extra queries; a preview that grabs nothing.
 */
import { generalTemplate } from "./emulator-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { downloadsDir } from "../src/config";
import { DEFAULT_PROFILE } from "../src/library/profiles";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import type { KindContext } from "../src/process/kinds";
import { nameQueries, rankForNames } from "../src/releases";
import { ctdeps } from "../src/ways/content";
import { PlanFault } from "../src/ways/errors";
import {
  contentQuery, contentRefusal, fdeps, judgeContent, judgeListing, nzbListing, NotTheGameFile, prepareContentPass, previewContentPass, sealedTitle, SIZE_RANGE, takeDownload, torrentListing, wayBlocked,
} from "../src/ways/find";
import { failOf } from "../src/ways/errors";
import { getContent, getWay, insertContent, insertPlan, insertWay, type WayRow } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";
import type { ProwlarrRelease } from "../src/prowlarr";
import type { PlatformId } from "../src/platforms";
import { psIso } from "./ways-images";

const P = { id: 0, ...DEFAULT_PROFILE };
const realF = { ...fdeps }, realC = { ...ctdeps }, realDat = { ...datdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-shapes-"));
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

const GB = 2 ** 30, MB = 2 ** 20;
let seq = 0;
function game(name: string, platforms: string[] = ["ps5"]): GameRow {
  const g = upsertGame({ name, slug: `shapes-${++seq}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function bytes(n: number, seed: number) { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; }
const zarWay = (o: Partial<ContentPlan> = {}): ContentPlan => ({
  kind: "disc", platform: "ps5", what: "Demon's Souls (PS5) as one .zar", search: ["Demon's Souls"], terms: ["PPSA01341"],
  accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, place: "games/{name}",
  make: { input: { shape: "either", platform: "ps5", formats: ["rar", "7z", "zip"], marker: "sce_sys/param.json", also: ["eboot.bin"] }, steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 600 } }], output: { shape: "file", name: "{serial}.zar" } }, ...o,
});
const nupWay = (): ContentPlan => ({ kind: "rom", platform: "switch", what: "program 0400486024DEC000", search: ["Ocarina of Time"], accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"] }, place: "game.nup" });
function plan(name: string, c: ContentPlan) {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^S-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: generalTemplate(c), files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name, kind: "emulator", repo: `shapes/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
}
const rel = (title: string, over: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: title, title, instanceId: 1, indexerId: 1, indexer: "T", size: 40 * GB, age: 10, publishDate: "", seeders: 10, leechers: 0,
  grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent",
  categories: [], indexerFlags: [], fileName: null, ...over,
});
const views = (names: string[], rows: ProwlarrRelease[], platform: PlatformId) => rankForNames(nameQueries(names[0], null, names.slice(1)), rows, { platforms: [platform], known: [platform], unnamed: true });
const x = { profile: P, preferUsenet: false, blocked: new Set<string>(), tried: new Set<string>() };

function ctxFor(job: Partial<JobRow> = {}): KindContext & { lines: string[]; messages: string[] } {
  const lines: string[] = [], messages: string[] = [];
  const work = mkdtempSync(join(tmp, "work-"));
  return { job: { id: 1, ...job } as JobRow, spec: { kind: "content", gameId: null } as never, work, staging: join(work, "staging"), log: l => lines.push(l), progress: (_p, m) => { if (m) messages.push(m); }, signal: new AbortController().signal, lines, messages };
}
function download(name: string, files: Record<string, Uint8Array | string>): string {
  const dir = join(downloadsDir(), `shapes-${++seq}-${name}`);
  for (const [rel, b] of Object.entries(files)) { mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...rel.split("/")), b); }
  return dir;
}

describe("before any download", () => {
  test("PlayStation 3, 4, 5 and Switch games come in their own sizes", () => {
    expect([SIZE_RANGE.ps3, SIZE_RANGE.ps4, SIZE_RANGE.ps5, SIZE_RANGE.switch]).toEqual([[1 * GB, 64 * GB], [1 * GB, 200 * GB], [1 * GB, 200 * GB], [64 * MB, 64 * GB]]);
  });

  test("a PS5 'Full ISO' (or a release named .iso) is refused before download for a way that takes neither an .iso nor makes from one; a way that takes .iso takes it (H7c)", () => {
    const names = ["Demon's Souls"];
    const rows = [rel("Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]"), rel("Demons.Souls.PS5.PPSA01341-DUPLEX"), rel("Demons Souls PS5 PPSA01342.iso")];
    const ranked = views(names, rows, "ps5");
    const c = zarWay();
    expect(judgeContent(ranked, { content: c, proves: true, names }, x).map(r => r.title)).toEqual(["Demons.Souls.PS5.PPSA01341-DUPLEX"]);
    expect(contentRefusal(ranked.find(r => /Full ISO/.test(r.title))!, { content: c, proves: true, names }, x)).toBe("a PlayStation 5 disc image: the disc holds the game encrypted for the console, and nothing can open it");
    expect(sealedTitle("Demons Souls PS5 PPSA01342.iso", c)).toMatch(/disc image/);
    const takesIso = zarWay({ accept: { hashes: [], formats: ["iso"] }, make: null });
    expect(judgeContent(ranked, { content: takesIso, proves: true, names }, x).length).toBe(3);
  });

  test("a Switch NSP, XCI or scene NSW release is refused for a way that takes a .nup; an NSP way takes it", () => {
    const names = ["Ocarina of Time"];
    const rows = [rel("Ocarina.of.Time.NSW-GRP", { size: 20 * GB }), rel("Ocarina.of.Time.Switch.NSP-GRP", { size: 20 * GB }), rel("Ocarina.of.Time.Switch.XCI-GRP", { size: 20 * GB }), rel("Ocarina.of.Time.Switch-GRP", { size: 20 * GB })];
    const ranked = views(names, rows, "switch");
    expect(judgeContent(ranked, { content: nupWay(), proves: true, names }, x).map(r => r.title)).toEqual(["Ocarina.of.Time.Switch-GRP"]);
    expect(judgeContent(ranked, { content: { ...nupWay(), accept: { hashes: [], formats: ["nsp", "xci"] } }, proves: true, names }, x).length).toBe(4);
    expect(sealedTitle("The.Legend.of.Zelda.Ocarina.of.Time.NSW-GRP", nupWay())).toBe("an NSP or XCI: its game data is encrypted for the console");
    expect(sealedTitle("The.Legend.of.Zelda.Ocarina.of.Time.NSW-GRP", { ...nupWay(), accept: { hashes: [], formats: ["nsp", "xci"] } })).toBeNull();
  });

  test("a release's listing is judged before it is grabbed: sealed files, nothing in a form the way takes, or what may hold the way's file (H7a)", () => {
    // a .torrent as bencode: one with files, one of a single file
    const be = (v: unknown): string => typeof v === "number" ? `i${v}e` : typeof v === "string" ? `${Buffer.byteLength(v)}:${v}` : Array.isArray(v) ? `l${v.map(be).join("")}e` : `d${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => be(k) + be(x)).join("")}e`;
    const torrent = (name: string, files: [string, number][] | number) => new TextEncoder().encode(be({ announce: "http://t/a", info: typeof files === "number" ? { name, length: files, "piece length": 16384, pieces: "" } : { name, files: files.map(([p, n]) => ({ path: p.split("/"), length: n })), "piece length": 16384, pieces: "" } }));
    expect(torrentListing(torrent("Ocarina NSW", [["oot.nsp", 20 * GB], ["oot.nfo", 900]]))).toEqual([{ path: "Ocarina NSW/oot.nsp", size: 20 * GB }, { path: "Ocarina NSW/oot.nfo", size: 900 }]);
    expect(torrentListing(torrent("Demons.Souls.iso", 54 * GB))).toEqual([{ path: "Demons.Souls.iso", size: 54 * GB }]);
    expect(torrentListing(new TextEncoder().encode("not a torrent"))).toBeNull();
    const nzb = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="[1/2] - &quot;Demons.Souls.part1.rar&quot; yEnc (1/3)"><segments><segment bytes="100" number="1">a</segment><segment bytes="50" number="2">b</segment></segments></file><file subject="[2/2] - &quot;Demons.Souls.part2.rar&quot; yEnc (1/1)"><segments><segment bytes="70" number="1">c</segment></segments></file></nzb>`;
    expect(nzbListing(nzb)).toEqual([{ path: "Demons.Souls.part1.rar", size: 150 }, { path: "Demons.Souls.part2.rar", size: 70 }]);
    // the verdicts
    // a name is not the bytes: refused for its form, and looked at again should the way's plan come to take that form
    expect(judgeListing(nupWay(), [{ path: "Ocarina NSW/oot.nsp", size: 1 }, { path: "Ocarina NSW/oot.nfo", size: 1 }])).toEqual({ ok: false, cls: "form", why: "it holds oot.nsp, which this plan does not process as game input" });
    expect(judgeListing(zarWay({ make: null }), [{ path: "Demons.Souls.iso", size: 1 }])).toMatchObject({ ok: false, cls: "form" });
    expect(judgeListing(nupWay(), [{ path: "README.txt", size: 1 }, { path: "cover.jpg", size: 1 }])).toEqual({ ok: false, cls: "form", why: "it holds no .nup (its 2 files: README.txt, cover.jpg)" });
    expect(judgeListing(zarWay(), [{ path: "PPSA01341-app0/sce_sys/param.json", size: 1 }, { path: "PPSA01341-app0/eboot.bin", size: 1 }]).ok).toBe(true);   // a loose app0 folder
    expect(judgeListing(zarWay(), [{ path: "Demons.Souls.part1.rar", size: 1 }]).ok).toBe(true);                                   // what its make takes
    expect(judgeListing(nupWay(), [{ path: "Release/oot.7z", size: 1 }]).ok).toBe(true);                                         // an archive: its inside cannot be seen from here
    expect(judgeListing(nupWay(), [{ path: "Ocarina/game.nup", size: 1 }]).ok).toBe(true);
    expect(judgeListing(nupWay(), []).ok).toBe(true);
  });

  test("the way's own extra queries ride along with the game's search terms (L6)", async () => {
    const g = game("Shapes Terms");
    db.query("UPDATE games SET search_terms_json=? WHERE id=?").run(JSON.stringify(["demons souls remake"]), g.id);
    const w = insertWay({ gameId: g.id, planId: plan("Shapes Terms Kyty", zarWay()).id, content: zarWay() });
    const pass = (await prepareContentPass(w, stmts.gameById.get(g.id) as GameRow))!;
    expect(contentQuery(pass, stmts.gameById.get(g.id) as GameRow).opts.terms).toEqual(["demons souls remake", "PPSA01341"]);
  });

  test("a preview says what the pass would take and why the rest would not be taken, and grabs nothing", async () => {
    const g = game("Demon's Souls Preview");
    const w = insertWay({ gameId: g.id, planId: plan("Shapes Preview Kyty", zarWay()).id, content: zarWay() });
    const rows = [rel("Demons.Souls.PS5.PPSA01341-DUPLEX"), rel("Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]"), rel("Demons.Souls.PS5.PPSA01341-TINY", { size: 10 * MB })];
    let asked: unknown = null;
    fdeps.search = async (name, _y, opt) => { asked = { name, terms: opt?.terms }; return { ranked: views([name], rows, "ps5") }; };
    fdeps.usenetAvailable = async () => false;
    const p = await previewContentPass(w);
    expect(asked).toEqual({ name: "Demon's Souls", terms: ["PPSA01341"] });
    expect(p.platform).toBe("ps5");
    expect(p.candidates).toEqual([
      { title: "Demons.Souls.PS5.PPSA01341-DUPLEX", size: 40 * GB, indexer: "T", take: true, why: "it would be tried first" },
      { title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]", size: 40 * GB, indexer: "T", take: false, why: "a PlayStation 5 disc image: the disc holds the game encrypted for the console, and nothing can open it" },
      { title: "Demons.Souls.PS5.PPSA01341-TINY", size: 10 * MB, indexer: "T", take: false, why: "10 MB is not a size PlayStation 5 games come in" },
    ]);
    // with other formats asked: a way that took .iso would take the disc image
    expect((await previewContentPass(w, { formats: ["iso"] })).candidates.find(c => /Full ISO/.test(c.title))!.take).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM fetches WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
  });
});

describe("a download for a way whose file is made from what it holds", () => {
  function kytyGame(name: string, c = zarWay()) {
    const g = game(name);
    const w = insertWay({ gameId: g.id, planId: plan(`${name} Kyty`, c).id, content: c });
    return { g, w };
  }
  const fakeMake = (g: GameRow, seen: { input?: unknown }) => async (_ctx: KindContext, o: { way: WayRow; input: unknown }) => {
    seen.input = o.input;
    const dir = join(rootFolders()[0].path, ".ahoy-content", g.slug!); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PPSA01341.zar"), bytes(4096, 3));
    const product = insertContent({ gameId: g.id, platform: "ps5", name: "PPSA01341.zar", path: join(dir, "PPSA01341.zar"), size: 4096, hashes: { sha1: "1".repeat(40) }, source: "made", identity: { platform: "ps5", serial: "PPSA01341", shape: "zar" } });
    return { product, reused: false };
  };

  test("a downloaded PKG reaches a folder plan's extractor instead of being judged as its finished game folder", async () => {
    const c: ContentPlan = { kind: "folder", platform: "ps4", what: "P.T. game folder", search: ["P.T."], accept: { hashes: [], serials: ["CUSA01127"] }, marker: "chunk1.psarc", also: ["texture.qar"], place: "CUSA01127",
      make: { input: { shape: "file", platform: "ps4", formats: ["pkg"] }, steps: [{ run: { exe: "extractor/PT.PkgExtract.exe", argv: ["{in}", "{out}"], wine: true, timeoutSec: 3600 } }], output: { shape: "folder", name: "CUSA01127" } } };
    const g = game("Shapes PT", ["ps4"]);
    const w = insertWay({ gameId: g.id, planId: plan("Shapes PT Port", c).id, content: c });
    const src = download("pt", { "P.T. v12.08.2014/PT.pkg": bytes(4096, 9) });
    let input: unknown;
    fdeps.runMake = async (_ctx, o) => {
      input = o.input;
      const dir = join(rootFolders()[0].path, ".ahoy-content", g.slug!); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "chunk1.psarc"), "PSAR"); writeFileSync(join(dir, "texture.qar"), "data");
      const product = insertContent({ gameId: g.id, platform: "ps4", name: "CUSA01127", path: dir, shape: "folder", size: 8, hashes: { sha1: "9".repeat(40) }, source: "made", identity: { platform: "ps4", serial: "CUSA01127", shape: "folder" } });
      return { product, reused: false };
    };
    const result = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src });
    expect(input).toEqual({ from: "indexer", path: join(src, "P.T. v12.08.2014", "PT.pkg"), fetchId: null });
    expect(result.manifest).toMatchObject({ outcome: "proven", made: true });
    expect(getContent(getWay(w.id)!.content_id!)).toMatchObject({ shape: "folder", source: "made" });
  });

  test("a RAR'd app0 folder: handed to the make as it is (no second unpack), its product the way's file, the build queued", async () => {
    const { g, w } = kytyGame("Shapes Rar App0");
    const src = download("rar", { "Demons.Souls.v1.004.PS5.PPSA01341.rar": bytes(8192, 1) });
    const seen: { input?: unknown } = {};
    fdeps.inputMatches = () => ({ ok: true, why: null });
    fdeps.runMake = fakeMake(g, seen) as typeof fdeps.runMake;
    const ctx = ctxFor();
    const r = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(seen.input).toEqual({ from: "indexer", path: join(src, "Demons.Souls.v1.004.PS5.PPSA01341.rar"), fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "proven", wayId: w.id, file: "PPSA01341.zar", made: true });
    expect(getContent(getWay(w.id)!.content_id!)).toMatchObject({ source: "made", name: "PPSA01341.zar" });
    expect((db.query("SELECT COUNT(*) AS n FROM jobs WHERE kind='assemble' AND game_id=?").get(g.id) as { n: number }).n).toBe(1);
    expect(ctx.lines.join("\n")).not.toContain("unpacking");
    expect(existsSync(src)).toBe(false);                                     // the download is done with
  });

  test("a game folder among 20,000 files is found by its marker, never by walking them (H6)", async () => {
    const { g, w } = kytyGame("Shapes Big Folder");
    const files: Record<string, string> = { "PPSA01341-app0/sce_sys/param.json": "{}", "PPSA01341-app0/eboot.bin": "e" };
    const src = download("big", files);
    const data = join(src, "PPSA01341-app0", "aaaa");                        // sorts before sce_sys
    mkdirSync(data, { recursive: true });
    for (let i = 0; i < 20_000; i++) writeFileSync(join(data, `${String(i).padStart(5, "0")}.bin`), "");
    const seen: { input?: unknown } = {};
    fdeps.inputMatches = () => ({ ok: true, why: null });
    fdeps.runMake = fakeMake(g, seen) as typeof fdeps.runMake;
    await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(seen.input).toEqual({ from: "indexer", path: join(src, "PPSA01341-app0"), fetchId: null });
  }, 120_000);

  test("an input the way's make cannot take (another game) refuses the release; a recipe that fails keeps the download", async () => {
    const { g, w } = kytyGame("Shapes Input Refused");
    const src = download("other", { "Other.Game.PPSA09999.rar": bytes(4096, 2) });
    fdeps.inputMatches = () => ({ ok: false, why: "another game (its serial is PPSA09999, and this takes PPSA01341)" });
    const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null }).catch(x => x);
    expect(e).toBeInstanceOf(NotTheGameFile);
    expect(e.message).toBe("not the game file: Other.Game.PPSA09999.rar is another game (its serial is PPSA09999, and this takes PPSA01341)");
    expect(failOf(e)).toEqual({ class: "file" });
    expect(existsSync(src)).toBe(true);
    // the make's own step fails: the recipe's fault, the download stays for the repaired recipe
    const src2 = download("fault", { "Demons.Souls.PPSA01341.rar": bytes(4096, 3) });
    fdeps.inputMatches = () => ({ ok: true, why: null });
    fdeps.runMake = (async () => { throw new PlanFault("make", "make step 1 failed (exit 1): zarchive: bad input"); }) as typeof fdeps.runMake;
    await expect(takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src2, fetchId: null })).rejects.toBeInstanceOf(PlanFault);
    expect(existsSync(src2)).toBe(true);
  });

  test("nothing in a form the way takes is refused only for its form (fetched again once the way's plan changes)", async () => {
    const { g, w } = kytyGame("Shapes Form", zarWay({ make: null }));
    const src = download("form", { "readme.txt": "x", "Demons.Souls.iso.nfo": "y" });
    const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null }).catch(x => x);
    expect(e).toBeInstanceOf(NotTheGameFile);
    expect((e as NotTheGameFile).cls).toBe("form");
    expect(failOf(e)).toEqual({ class: "file", kind: "form" });
  });
});

describe("a download's game folder, and a download read once", () => {
  const folderWay = (): ContentPlan => ({ kind: "folder", platform: "ps5", what: "the PS5 game folder", search: ["x"], accept: { hashes: [], serials: ["PPSA01341"] }, marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game" });
  test("a way of kind 'folder' takes the game folder as a tree of links, judged by what its own data says", async () => {
    const g = game("Shapes Folder Way");
    const w = insertWay({ gameId: g.id, planId: plan("Shapes Folder Emu", folderWay()).id, content: folderWay() });
    const src = download("folder", { "unused.pkg": bytes(128, 8), "Release/PPSA01341-app0/sce_sys/param.json": "{}", "Release/PPSA01341-app0/eboot.bin": bytes(1000, 4), "Release/PPSA01341-app0/data/x.bin": bytes(3000, 5) });
    fdeps.readFolderIdentity = async () => ({ platform: "ps5", serial: "PPSA01341", version: "01.007.000", shape: "folder", category: "game" });
    const r = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "proven", by: "serial", file: "PPSA01341-app0" });
    const kept = getContent(getWay(w.id)!.content_id!)!;
    expect(kept).toMatchObject({ shape: "folder", source: "indexer" });
    expect(readdirSync(kept.path).sort()).toEqual(["data", "eboot.bin", "sce_sys"]);
  });

  test("on the store's volume a download is read where it lies once and linked in; across volumes it is read once, as it is copied (L4)", async () => {
    const c: ContentPlan = { kind: "disc", platform: "ps2", what: "a PS2 disc", search: ["Shapes Once"], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}" };
    for (const same of [true, false]) {
      const g = game(`Shapes Once ${same}`, ["ps2"]);
      const w = insertWay({ gameId: g.id, planId: plan(`Shapes Once Emu ${same}`, c).id, content: c });
      const iso = psIso({ boot: "cdrom0:\SLUS_299.71;1", size: 40 * MB, seed: same ? 6 : 7 });
      const src = download(`once-${same}`, { "Shapes Once (USA).iso": iso });
      const ino = lstatSync(join(src, "Shapes Once (USA).iso")).ino;
      ctdeps.sameVolume = async () => same;
      let t = 0; ctdeps.now = () => (t += 1500);
      const ctx = ctxFor();
      const r = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
      expect(r.manifest).toMatchObject({ outcome: "kept" });                  // nothing proves an unread PS2 disc: kept for a look
      const kept = getContent((r.manifest as { contentId: number }).contentId)!;
      // the whole file went through once: its bytes-of-total climb once, and never start over
      const seen = ctx.messages.map(m => / · (\d+) of 42 MB$/.exec(m)?.[1]).filter((v): v is string => !!v).map(Number);
      expect(seen.at(-1)).toBe(42);
      expect(seen.filter((v, i) => i > 0 && v < seen[i - 1]).length).toBe(0);
      if (same) { expect(JSON.parse(kept.stat_json!).ino).toBe(ino); expect(ctx.messages.some(m => m.startsWith("keeping the game file · hashing"))).toBe(false); }
      else expect(JSON.parse(kept.stat_json!).ino).not.toBe(ino);
    }
  }, 60_000);
});

describe("refusals carry their class", () => {
  test("another game is never fetched again for the way; only a form refusal is looked at again under another plan", () => {
    expect(failOf(new NotTheGameFile("another game"))).toEqual({ class: "file" });
    expect(failOf(new NotTheGameFile("no .zar in the download", "form"))).toEqual({ class: "file", kind: "form" });
    expect(wayBlocked).toBeTypeOf("function");
  });
});

