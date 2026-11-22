/**
 * Wave-3 review of "what a file is and taking it in" (src/ways/content.ts, find.ts, copy.ts, hooks.ts): each test below failed on the
 * merged tree and holds after its fix.
 *   1. the live Demon's Souls drop: an app0 folder put in the inbox for KytyPS5's upgraded way, whose make judges the whole
 *      game by the program's own file list, is kept as the make's input — intake has no program to read that list from, and
 *      used to refuse every dump ("the program's list … could not be read")
 *   2. a download's game folder that nothing proves (no serial, hash or build matched) is kept for a look, never made the
 *      way's file and built (a wrong game is far worse than no game)
 *   3. a sealed PS5 disc (by its own bytes) is refused before it is read or copied, even for a way that names .iso — it used
 *      to be copied in full to be judged, and on a short library failed "not enough room" (retried, never refused)
 *   4. the dump hand-off says what it is doing while it copies a dump the store cannot link
 *   5. an inbox folder of many files says how far its walk has got, instead of "looking at …" for minutes
 *   6. an obfuscated usenet post (subjects that name no file) says nothing about what it holds: judged as before, never
 *      refused for its form by the random words of its subjects
 *   7. a download on a volume that looks like the store's but refuses hard links (Unraid's shares are one device in the
 *      container; a link across their disks fails) is read once, as it is copied — not read in place and then copied
 *   8. a console file inside another kind of package (a PC copy, an emulator's bundle) is no more made into a way's file
 *      unproven than it is taken as one: the make leg asks the same proof as the direct leg
 *   9. the note left beside an inbox entry nobody takes is a new file of ludarr's: never written through a link someone
 *      put under its name (root would rewrite whatever file that link names)
 */
import { generalTemplate } from "./emulator-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow, type RootFolderRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { downloadsDir } from "../src/config";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import { jobKinds, type KindContext } from "../src/process/kinds";
import type { Manifest } from "../src/process/validate";
import { ctdeps, intakeEntry } from "../src/ways/content";
import { copyServes, cpdeps, judgeCopy } from "../src/ways/copy";
import { EnvError } from "../src/ways/errors";
import { fdeps, judgeListing, NotTheGameFile, nzbListing, SIZE_RANGE, takeDownload } from "../src/ways/find";
import { romHandOff } from "../src/ways/hooks";
import { getContent, getWay, insertPlan, insertWay } from "../src/ways/store";
import type { ContentPlan, IntakeManifest, RuntimePlanSpec } from "../src/ways/types";
import { ps5Disc, psIso, writeApp0 } from "./ways-images";

const realCt = { ...ctdeps }, realF = { ...fdeps }, realCp = { ...cpdeps }, realDat = { ...datdeps };
const tmp = mkdtempSync(join(tmpdir(), "files-review-"));
const lib = join(tmp, "library"); mkdirSync(lib, { recursive: true });
const libReal = realpathSync(lib);
const root: RootFolderRow = { id: 997_700, path: lib, name: null, created_at: 0 };
const made = { games: [] as number[], plans: [] as number[], pkgs: [] as number[] };
const BIG = async () => ({ free: 1e15, total: 2e15 });
const reset = () => {
  Object.assign(ctdeps, realCt, { rootFolders: () => [root], diskSpace: BIG });
  Object.assign(fdeps, realF);
  Object.assign(cpdeps, realCp, { judgeSoon: () => {} });
};
let addedRoot: number | null = null;
beforeAll(() => {
  const had = rootFolders().length;
  ensureDefaultRootFolder();                                                // the downloads' volume is weighed against a root folder
  if (!had) addedRoot = rootFolders()[0]?.id ?? null;
  reset();
  datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats();
});
afterEach(reset);
afterAll(() => {
  Object.assign(ctdeps, realCt); Object.assign(fdeps, realF); Object.assign(cpdeps, realCp); Object.assign(datdeps, realDat); forgetDats();
  for (const id of made.games) for (const t of ["jobs", "contents", "fetches", "blocklist", "requests"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.pkgs) db.query("DELETE FROM packages WHERE id=?").run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  db.query("DELETE FROM jobs WHERE kind='assemble' AND input_path LIKE 'way:%' AND game_id IS NULL").run();
  if (addedRoot != null) db.query("DELETE FROM root_folders WHERE id=?").run(addedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function game(name: string, platforms = ["ps5"]): GameRow {
  const g = upsertGame({ name, slug: `files-review-${++seq}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function plan(name: string, c: ContentPlan, kind: "emulator" | "recomp" = "emulator") {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^R-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: kind === "emulator" ? generalTemplate(c) : c, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name, kind, repo: `review/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
}
function bytes(n: number, seed: number) { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; }
function ctxFor(): KindContext & { messages: string[]; lines: string[] } {
  const messages: string[] = [], lines: string[] = [];
  const work = mkdtempSync(join(tmp, "work-"));
  return { job: { id: 1 } as JobRow, spec: { kind: "content", gameId: null } as never, work, staging: join(work, "staging"), log: l => lines.push(l), progress: (_p, m) => { if (m) messages.push(m); }, signal: new AbortController().signal, messages, lines };
}
function download(name: string, files: Record<string, Uint8Array | string>): string {
  const dir = join(downloadsDir(), `files-review-${++seq}-${name}`);
  for (const [rel, b] of Object.entries(files)) { mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...rel.split("/")), b); }
  return dir;
}
const assembles = (wayId: number) => (db.query("SELECT COUNT(*) AS n FROM jobs WHERE kind='assemble' AND input_path=? AND state IN ('queued','running')").get(`way:${wayId}`) as { n: number }).n;

/** KytyPS5's way 1 after the AI's upgrade round (tests/ways-construct-round.test.ts): one .zar made from the app0 folder,
 *  the whole game judged by the program's own list of its files */
const LIST = "tools/local/static-precompile/files-PPSA01341_01.007.000.files";
const kytyUpgraded = (complete: NonNullable<ContentPlan["complete"]> = { list: { path: LIST, share: 0.98 } }): ContentPlan => ({
  kind: "rom", platform: "ps5", what: "Demon's Souls (PlayStation 5) as one .zar", search: ["Demon's Souls"],
  accept: { hashes: [], formats: ["zar"], serials: ["PPSA01340", "PPSA01341", "PPSA01342"], versions: ["01.005.000", "01.007.000"] }, place: "games/{name}",
  make: {
    input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", also: ["eboot.bin"], serials: ["PPSA01340", "PPSA01341", "PPSA01342"], versions: ["01.005.000", "01.007.000"], complete },
    steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 3600 } }],
    output: { shape: "file", name: "{serial}.zar" },
  },
});

describe("1. the inbox takes the app0 dump the upgraded KytyPS5 way makes its .zar from", () => {
  test("a whole-game check by the program's file list is the make's (it has the program): intake keeps the dump as the make's input", async () => {
    const g = game("Review Demon's Souls");
    const w = insertWay({ gameId: g.id, planId: plan("Review KytyPS5", kytyUpgraded()).id, content: kytyUpgraded() });
    const box = join(libReal, ".ahoy-inbox", g.slug!); mkdirSync(box, { recursive: true });
    const src = writeApp0(join(box, "PPSA01341-app0"), { titleId: "PPSA01341", version: "01.007.000" });
    const r = await intakeEntry(src, g, { source: "inbox", move: true });
    expect(r.notes).toEqual([]);
    expect(r.inputFor).toEqual([w.id]);
    expect(r.row).toMatchObject({ shape: "folder", source: "inbox" });
    expect(existsSync(src)).toBe(false);                                      // moved into the store, kept
  });

  test("the counts a plan gives are still checked at intake (an update alone is never kept as the game's dump)", async () => {
    const g = game("Review Demon's Souls Part");
    insertWay({ gameId: g.id, planId: plan("Review KytyPS5 Part", kytyUpgraded({ minFiles: 1000, list: { path: LIST } })).id, content: kytyUpgraded({ minFiles: 1000, list: { path: LIST } }) });
    const box = join(libReal, ".ahoy-inbox", g.slug!); mkdirSync(box, { recursive: true });
    const src = writeApp0(join(box, "PPSA01341-patch"), { titleId: "PPSA01341", version: "01.007.000" });
    const r = await intakeEntry(src, g, { source: "inbox", move: true });
    expect(r.row).toBeNull();
    expect(r.notes[0]).toMatch(/an update or a part of the game, not the whole game: it holds \d+ files .*at least 1,000 files/);
    expect(existsSync(src)).toBe(true);
  });
});

describe("2. a download's game folder that nothing proves is kept for a look, never built", () => {
  const folderWay = (serials?: string[]): ContentPlan => ({ kind: "folder", platform: "ps5", what: "the PS5 game folder", search: ["Review Folder"], accept: { hashes: [], ...(serials ? { serials } : {}) }, marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game" });

  test("its param.json names no title id: nothing proves it is the game the way lists", async () => {
    const g = game("Review Folder Unread");
    const w = insertWay({ gameId: g.id, planId: plan("Review Folder Emu", folderWay(["PPSA01341"])).id, content: folderWay(["PPSA01341"]) });
    const src = download("unread", { "Release/PPSA01341-app0/sce_sys/param.json": "{}", "Release/PPSA01341-app0/eboot.bin": bytes(2048, 1), "Release/PPSA01341-app0/data/x.bin": bytes(4096, 2) });
    const r = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "kept" });
    expect(getWay(w.id)!.content_id).toBeNull();
    expect(assembles(w.id)).toBe(0);
    expect(getContent((r.manifest as { contentId: number }).contentId)).toMatchObject({ shape: "folder", source: "indexer" });
  });

  test("a way that lists no serial takes no folder by itself, whatever title id it holds", async () => {
    const g = game("Review Folder Other");
    const w = insertWay({ gameId: g.id, planId: plan("Review Folder Any", folderWay()).id, content: folderWay() });
    const src = join(downloadsDir(), `files-review-${++seq}-other`);
    writeApp0(join(src, "Release", "PPSA09999-app0"), { titleId: "PPSA09999", title: "Another Game Entirely" });
    const r = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "kept" });
    expect(getWay(w.id)!.content_id).toBeNull();
    expect(assembles(w.id)).toBe(0);
  });
});

describe("3. a sealed PS5 disc is refused by its own bytes before it is read or copied", () => {
  const isoWay = (): ContentPlan => ({ kind: "rom", platform: "ps5", what: "a PS5 game folder made into an image", search: ["Review Sealed"], accept: { hashes: [], formats: ["iso"] }, place: "game.iso" });

  test("on another volume with a short library: refused as sealed, not 'not enough room' to copy it in first", async () => {
    const range = SIZE_RANGE.ps5;
    SIZE_RANGE.ps5 = [1, 200 * 2 ** 30];                                    // the fixture disc is small
    try {
      const g = game("Review Sealed Room");
      const w = insertWay({ gameId: g.id, planId: plan("Review Sealed Emu", isoWay()).id, content: isoWay() });
      const src = download("sealed", { "Demons Souls (USA).iso": ps5Disc() });
      ctdeps.sameVolume = async () => false;                                 // the downloads on the array, the library on the cache
      ctdeps.diskSpace = async () => ({ free: 10 * 2 ** 30, total: 2e12 });  // and the library short of room
      const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null }).catch(x => x);
      expect(e).not.toBeInstanceOf(EnvError);
      expect(e).toBeInstanceOf(NotTheGameFile);
      expect((e as Error).message).toContain("the retail disc as a PC drive reads it");
      expect(db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id)).toEqual({ n: 0 });
    } finally { SIZE_RANGE.ps5 = range; }
  });

  test("on the store's volume: refused without reading it through", async () => {
    const range = SIZE_RANGE.ps5;
    SIZE_RANGE.ps5 = [1, 200 * 2 ** 30];
    try {
      const g = game("Review Sealed Read");
      const w = insertWay({ gameId: g.id, planId: plan("Review Sealed Emu 2", isoWay()).id, content: isoWay() });
      const src = download("sealed-here", { "Demons Souls (USA).iso": ps5Disc() });
      const ctx = ctxFor();
      const e = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null }).catch(x => x);
      expect(e).toBeInstanceOf(NotTheGameFile);
      expect(ctx.messages.filter(m => / · \d+ of \d+ (KB|MB|GB)$/.test(m))).toEqual([]);   // no bytes-of-total read went on
    } finally { SIZE_RANGE.ps5 = range; }
  });
});

describe("4. the dump hand-off says what it does when the store cannot link the dump", () => {
  const rom = (() => { const b = bytes(65536, 9); b.set([0x80, 0x37, 0x12, 0x40], 0); return b; })();
  const sha1 = new Bun.CryptoHasher("sha1").update(rom).digest("hex");
  test("a copy across volumes reports bytes of total as it goes", async () => {
    const g = game("Review Hand Off Copy", ["n64"]);
    const c: ContentPlan = { kind: "rom", platform: "n64", what: "the US ROM", search: ["Review Hand Off Copy"], accept: { hashes: [{ algo: "sha1", value: sha1 }], formats: ["z64"] }, normalize: "n64-z64", place: "rom.z64" };
    const w = insertWay({ gameId: g.id, planId: plan("Review Recomp", c, "recomp").id });
    const dir = join(libReal, `${g.slug}-dump`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Review (USA).z64"), rom);
    const manifest = { schema: 1, name: g.name, slug: g.slug!, version: null, launch: { exe: "Review (USA).z64", args: "", cwd: "" }, prerequisites: [], files: [], totalSize: rom.length, source: null, tier: "deterministic", kind: "rom", platform: "n64", notes: null, createdAt: "" } as unknown as Manifest;
    const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, rom.length, JSON.stringify(manifest)) as PackageRow;
    made.pkgs.push(pkg.id);
    ctdeps.link = async () => { const e = new Error("cross-device link") as Error & { code: string }; e.code = "EXDEV"; throw e; };
    const messages: string[] = [];
    await romHandOff({ gameId: g.id, pkg, manifest, log: () => {}, progress: (_p: number, m: string) => { messages.push(m); } });
    expect(getWay(w.id)!.content_id).not.toBeNull();                      // copied in, the way's file
    expect(messages.some(m => /^copying the dump into the store · \d+ of \d+ KB$/.test(m))).toBe(true);
  });
});

describe("5. an inbox folder's walk says how far it has got", () => {
  test("the job's message moves while the entry is looked through, before anything is taken", async () => {
    const g = game("Review Inbox Walk");
    insertWay({ gameId: g.id, planId: plan("Review Inbox Kyty", kytyUpgraded({ minFiles: 10 })).id, content: kytyUpgraded({ minFiles: 10 }) });
    const box = join(libReal, ".ahoy-inbox", g.slug!); mkdirSync(box, { recursive: true });
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 40; i++) files[`levels/m${String(i).padStart(2, "0")}/map.bin`] = bytes(1024, i + 1);
    writeApp0(join(box, "PPSA01341-app0"), { titleId: "PPSA01341", files });
    let t = 0; ctdeps.now = () => (t += 1500);
    const messages: string[] = [];
    const ctx = { job: {} as never, spec: { kind: "content", gameId: g.id, path: join(box, "PPSA01341-app0"), inbox: true } as never, work: tmp, staging: tmp, log: () => {}, progress: (_p: number, m?: string) => { if (m) messages.push(m); }, signal: new AbortController().signal };
    const r = await jobKinds.get("content")!.run(ctx as KindContext);
    expect((r.manifest as unknown as IntakeManifest).contentId).not.toBeNull();
    expect(messages.filter(m => /^looking at PPSA01341-app0 · [\d,]+ files/.test(m)).length).toBeGreaterThan(1);
    expect(readdirSync(box)).toEqual([]);
  });
});

describe("6. an obfuscated usenet post is judged as if nothing were listed", () => {
  const nzbOf = (subjects: string[]) => `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">${subjects.map((sub, i) => `<file poster="p" date="1" subject="${sub}"><segments><segment bytes="${1000 + i}" number="1">m${i}@x</segment></segments></file>`).join("")}</nzb>`;
  test("subjects with no file name in them: no listing, so the release is not refused unseen", () => {
    const obfuscated = nzbOf(["b7a2c9e1f3d4a5b6 yEnc (1/50)", "[2/3] - &quot;&quot; yEnc (1/40)", "[3/3] - 9f8e7d6c5b4a yEnc (1/2)"]);
    const files = nzbListing(obfuscated);
    const look = files ? judgeListing(kytyUpgraded(), files) : { ok: true, why: null };
    expect(look).toMatchObject({ ok: true });
    expect(files).toBeNull();
    // a post that names its files is still read and judged
    expect(nzbListing(nzbOf(["[1/2] - &quot;Demons.Souls.part1.rar&quot; yEnc (1/3)", "[2/2] - &quot;Demons.Souls.part2.rar&quot; yEnc (1/1)"]))!.map(f => f.path)).toEqual(["Demons.Souls.part1.rar", "Demons.Souls.part2.rar"]);
    expect(judgeListing(kytyUpgraded(), nzbListing(nzbOf(["[1/2] - &quot;readme.txt&quot; yEnc (1/1)", "[2/2] - &quot;cover.jpg&quot; yEnc (1/1)"]))!)).toMatchObject({ ok: false, cls: "form" });
  });
});

describe("7. a download the store cannot link is read once", () => {
  test("the same device but no hard links: read as it is copied, once (its bytes of total climb once and never start over)", async () => {
    const c: ContentPlan = { kind: "disc", platform: "ps2", what: "a PS2 disc", search: ["Review Once"], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}" };
    const g = game("Review Once", ["ps2"]);
    const w = insertWay({ gameId: g.id, planId: plan("Review Once Emu", c).id, content: c });
    const src = download("once", { "Review Once (USA).iso": psIso({ boot: "cdrom0:\\SLUS_299.72;1", size: 24 * 2 ** 20, seed: 8 }) });
    ctdeps.sameVolume = async () => true;
    ctdeps.link = async () => { const e = new Error("cross-device link") as Error & { code: string }; e.code = "EXDEV"; throw e; };
    let t = 0; ctdeps.now = () => (t += 1500);
    const ctx = ctxFor();
    const r = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "kept" });                   // nothing proves an unread PS2 disc: kept for a look
    const seen = ctx.messages.map(m => / · (\d+) of 25 MB$/.exec(m)?.[1]).filter((v): v is string => !!v).map(Number);
    expect(seen.at(-1)).toBe(25);
    expect(seen.filter((v, i) => i > 0 && v < seen[i - 1])).toEqual([]);
  }, 60_000);
});

describe("8. the copy's make leg asks the proof its direct leg asks", () => {
  const NUP_NAME = "The Legend of Zelda Ocarina of Time [0400486024DEC000][v131072].nup";
  const nup = bytes(300_000, 31);
  function pcCopyWithNup(g: GameRow): void {
    const dir = join(libReal, `${g.slug}-pc`);
    mkdirSync(join(dir, "Emulator"), { recursive: true });
    writeFileSync(join(dir, "Emulator", "lichii.exe"), bytes(4000, 30));
    writeFileSync(join(dir, NUP_NAME), nup);
    const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
    const manifest = { schema: 1, name: g.name, slug: g.slug, version: null, launch: { exe: "Emulator/lichii.exe", args: "", cwd: "Emulator" }, prerequisites: [],
      files: [{ path: "Emulator/lichii.exe", size: 4000, sha256: sha(bytes(4000, 30)) }, { path: NUP_NAME, size: nup.length, sha256: sha(nup) }], totalSize: 0, source: null, tier: "deterministic", kind: "native", platform: null, notes: null, createdAt: "" };
    const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, 1, JSON.stringify(manifest)) as PackageRow;
    made.pkgs.push(pkg.id);
  }
  /** an emulator's way that makes its file from a .nup, proving nothing by itself (no serial, build or hash anywhere) */
  const makesFromNup = (o: { inputSerials?: string[]; builds?: string[] } = {}): ContentPlan => ({
    kind: "rom", platform: "switch", what: "the game as one .xci", search: ["Ocarina"], accept: { hashes: [], formats: ["xci"], ...(o.builds ? { builds: o.builds } : {}) }, place: "game.xci",
    make: { input: { shape: "file", platform: "switch", formats: ["nup"], ...(o.inputSerials ? { serials: o.inputSerials } : {}) }, steps: [{ run: { tool: "pack", argv: ["{in}", "{out}"], wine: false, timeoutSec: 600 } }], output: { shape: "file", name: "game.xci" } },
  });

  test("a .nup in the game's PC copy that nothing proves: no file this way makes its game file from by itself", async () => {
    const g = game("Review Ocarina Make", ["switch"]);
    pcCopyWithNup(g);
    cpdeps.readIdentity = async (_p, _platform, name) => (name.endsWith(".nup") ? { platform: "switch", serial: "0400486024DEC000", version: "v131072", build: "e0f3ccfa", shape: "nup", titles: ["0400486024DEC000"] } : null);
    await judgeCopy(g.id);
    expect(copyServes(g.id, makesFromNup())).toEqual({ serves: "no", why: "a .nup file in the game's PC copy that nothing this way checks can prove is the game", block: null });
    // proven by the input's own title id, or by the build the made file must carry: made from it
    expect(copyServes(g.id, makesFromNup({ inputSerials: ["0400486024DEC000"] })).serves).toBe("make");
    expect(copyServes(g.id, makesFromNup({ builds: ["e0f3ccfa"] })).serves).toBe("make");
  });
});

describe("9. the inbox's note is never written through a link", () => {
  test("a hard link planted under <entry>.not-taken.txt: the file it names keeps its bytes, and the note is written beside", async () => {
    const g = game("Review Inbox Note");
    insertWay({ gameId: g.id, planId: plan("Review Note Kyty", kytyUpgraded()).id, content: kytyUpgraded() });
    const box = join(libReal, ".ahoy-inbox", g.slug!); mkdirSync(box, { recursive: true });
    writeFileSync(join(box, "Disc.iso"), bytes(4096, 5));
    const precious = join(libReal, "precious.db"); writeFileSync(precious, "the admin's own data");
    linkSync(precious, join(box, "Disc.iso.not-taken.txt"));
    const ctx = { job: {} as never, spec: { kind: "content", gameId: g.id, path: join(box, "Disc.iso"), inbox: true } as never, work: tmp, staging: tmp, log: () => {}, progress: () => {}, signal: new AbortController().signal };
    const r = await jobKinds.get("content")!.run(ctx as KindContext);
    expect((r.manifest as unknown as IntakeManifest).contentId).toBeNull();
    expect(readFileSync(precious, "utf8")).toBe("the admin's own data");
    expect(readFileSync(join(box, "Disc.iso.not-taken.txt"), "utf8")).toBe(`${r.message}\n`);
  });
});
