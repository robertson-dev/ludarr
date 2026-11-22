/**
 * Wave-3 review of "what a file is and taking it in", the skeptic's pass: each test below failed on the reviewer's tree and
 * holds after its fix.
 *   S1. what a way's make takes from a DOWNLOAD (an app0 folder in it) is made into the way's file only when something
 *       proves the result is the game — the title id the make's input lists, or the way's own checks of the file it makes;
 *       a download nothing proves used to be made, attached and built (a file nothing proves is kept for a look; the copy's
 *       make leg already asks the same proof)
 *   S2. a file whose hashes an earlier read told (its stat unchanged since) is not read again to look for a kept duplicate
 *       when it has to be copied in (a share without hard links): the game's copy, hashed once by the hand-off, used to be
 *       read a second time before it was copied whenever the game kept another file of the same size
 *   S3. a game folder that has to be copied in (another volume, or one device whose shares hold no hard links between them)
 *       is read once, as it is copied: every file used to be read for its hash first and then read again by the copy; a
 *       folder the game keeps already (same files, same bytes) is still found before anything is written
 *   S4. a folder taken in by a move or a link loses world-write on every entry (an SMB share writes all 117,000 files of
 *       an app0 dump 0666): that pass said nothing at all, for as long as it took — now it says how far it has got
 *   S5. a game file found inside an archive a download held, unpacked in the job's own folder on the library, is linked
 *       into the store: whether a link works was decided once for the download's own volume (the seedbox mount, live), so
 *       every file unpacked from an archive there was copied a second time on the library, and needed twice the room
 */
import { generalTemplate } from "./emulator-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow, type RootFolderRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { downloadsDir } from "../src/config";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import { jobKinds, type KindContext } from "../src/process/kinds";
import { ctdeps, ingestTree } from "../src/ways/content";
import { copyServes, cpdeps, judgeCopy, recordCopyHashes, takeCopy } from "../src/ways/copy";
import { hashFile, hashedStat } from "../src/ways/hash";
import { fdeps, NotTheGameFile, takeDownload } from "../src/ways/find";
import type { MakeOutcome } from "../src/ways/make";
import { getWay, insertContent, insertPlan, insertWay } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";
import { psIso, writeApp0 } from "./ways-images";

const realCt = { ...ctdeps }, realF = { ...fdeps }, realCp = { ...cpdeps }, realDat = { ...datdeps };
const tmp = mkdtempSync(join(tmpdir(), "files-skeptic-"));
const lib = join(tmp, "library"); mkdirSync(lib, { recursive: true });
const libReal = realpathSync(lib);
const root: RootFolderRow = { id: 997_800, path: lib, name: null, created_at: 0 };
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
  ensureDefaultRootFolder();
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
  const g = upsertGame({ name, slug: `files-skeptic-${++seq}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
function plan(name: string, c: ContentPlan, kind: "emulator" | "recomp" = "emulator") {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^R-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: kind === "emulator" ? generalTemplate(c) : c, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name, kind, repo: `skeptic/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
}
function ctxFor(): KindContext & { messages: string[]; lines: string[] } {
  const messages: string[] = [], lines: string[] = [];
  const work = mkdtempSync(join(tmp, "work-"));
  return { job: { id: 1 } as JobRow, spec: { kind: "content", gameId: null } as never, work, staging: join(work, "staging"), log: l => lines.push(l), progress: (_p, m) => { if (m) messages.push(m); }, signal: new AbortController().signal, messages, lines };
}
const assembles = (wayId: number) => (db.query("SELECT COUNT(*) AS n FROM jobs WHERE kind='assemble' AND input_path=? AND state IN ('queued','running')").get(`way:${wayId}`) as { n: number }).n;

describe("S1. a download's make input that nothing proves is never made into the way's file", () => {
  /** an emulator's way whose game file is one .zar made from the app0 folder; o: what proves it */
  const zarWay = (o: { inputSerials?: string[]; serials?: string[] } = {}): ContentPlan => ({
    kind: "rom", platform: "ps5", what: "the game as one .zar", search: ["Skeptic Make"], accept: { hashes: [], formats: ["zar"], ...(o.serials ? { serials: o.serials } : {}) }, place: "games/{name}",
    make: {
      input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", also: ["eboot.bin"], ...(o.inputSerials ? { serials: o.inputSerials } : {}) },
      steps: [{ convert: { with: "zarchive", argv: ["{in}", "{out}"], timeoutSec: 3600 } }],
      output: { shape: "file", name: "{serial}.zar" },
    },
  });
  /** a download holding one app0 folder of this title id */
  const appDownload = (titleId: string) => {
    const src = join(downloadsDir(), `files-skeptic-${++seq}-app0`);
    writeApp0(join(src, "Release", `${titleId}-app0`), { titleId, title: `Game ${titleId}` });
    return src;
  };
  /** the make, faked: the product it would have made, attached as runMake attaches it */
  const fakeMake = (calls: { n: number }) => async (_ctx: KindContext, o: Parameters<typeof fdeps.runMake>[1]): Promise<MakeOutcome> => {
    calls.n++;
    const dir = join(libReal, ".ahoy-content", `made-${++seq}`); mkdirSync(dir, { recursive: true });
    const path = join(dir, "PPSA01341.zar"); await Bun.write(path, new Uint8Array(4096).fill(7));
    const row = insertContent({ gameId: o.way.game_id, role: "game", platform: "ps5", name: "PPSA01341.zar", path, size: 4096, hashes: { sha1: `${seq}`.padStart(40, "0") }, source: "made", shape: "file" });
    const { attachToWays } = await import("../src/ways/content");
    attachToWays(row, { wayId: o.way.id });
    return { product: row, reused: false };
  };

  test("another game's app0 folder, for a way that checks nothing: refused before any make, as its form (looked at again once the plan proves files)", async () => {
    const g = game("Skeptic Make Unproven");
    const w = insertWay({ gameId: g.id, planId: plan("Skeptic Zar Emu", zarWay()).id, content: zarWay() });
    const src = appDownload("PPSA09999");
    const calls = { n: 0 };
    fdeps.runMake = fakeMake(calls);
    const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null }).catch(x => x);
    expect(calls.n).toBe(0);                                                   // nothing made from it
    expect(e).toBeInstanceOf(NotTheGameFile);
    expect((e as NotTheGameFile).cls).toBe("form");
    expect((e as Error).message).toContain("PPSA09999");
    expect(getWay(w.id)!.content_id).toBeNull();
    expect(assembles(w.id)).toBe(0);
  });

  test("proven by the title id the make's input lists, or by what the way checks of the file it makes: made", async () => {
    for (const [i, c] of [zarWay({ inputSerials: ["PPSA01341"] }), zarWay({ serials: ["PPSA01341"] })].entries()) {
      const g = game(`Skeptic Make Proven ${i}`);
      const w = insertWay({ gameId: g.id, planId: plan(`Skeptic Zar Emu Proven ${i}`, c).id, content: c });
      const calls = { n: 0 };
      fdeps.runMake = fakeMake(calls);
      const r = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: appDownload("PPSA01341"), fetchId: null });
      expect(calls.n).toBe(1);
      expect(r.manifest).toMatchObject({ outcome: "proven", made: true });
      expect(getWay(w.id)!.content_id).not.toBeNull();
    }
  });

  test("a download whose input the make's listed title ids turn down is refused as another game, as before", async () => {
    const g = game("Skeptic Make Other");
    const c = zarWay({ inputSerials: ["PPSA01341"] });
    const w = insertWay({ gameId: g.id, planId: plan("Skeptic Zar Emu Other", c).id, content: c });
    const calls = { n: 0 };
    fdeps.runMake = fakeMake(calls);
    const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: appDownload("PPSA09999"), fetchId: null }).catch(x => x);
    expect(calls.n).toBe(0);
    expect(e).toBeInstanceOf(NotTheGameFile);
    expect((e as NotTheGameFile).cls).toBe("identity");
    expect((e as Error).message).toContain("another game");
    expect(getWay(w.id)!.content_id).toBeNull();
  });
});

describe("S2. a file whose hashes are known is read once when it has to be copied in", () => {
  const bytes = (n: number, seed: number) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
  test("the game's copy, hashed by the hand-off, on a share without hard links: copied (one read), never read first to look for a duplicate", async () => {
    const g = game("Skeptic Copy Known", ["n64"]);
    const rom = bytes(300_000, 41); rom.set([0x80, 0x37, 0x12, 0x40], 0);
    const romAt = join(tmp, `rom-${++seq}.z64`); writeFileSync(romAt, rom);
    const full = await hashFile(romAt);
    const c: ContentPlan = { kind: "rom", platform: "n64", what: "the US ROM", search: ["Skeptic Copy Known"], accept: { hashes: [{ algo: "sha1", value: full.hashes.sha1! }], formats: ["z64"] }, normalize: "n64-z64", place: "rom.z64" };
    const w = insertWay({ gameId: g.id, planId: plan("Skeptic Copy Recomp", c, "recomp").id });
    // the game's console copy: one z64 dump, listed with its sha256
    const dir = join(libReal, `${g.slug}-copy`); mkdirSync(dir, { recursive: true });
    const file = join(dir, "Skeptic (USA).z64"); writeFileSync(file, rom);
    const manifest = { schema: 1, name: g.name, slug: g.slug, version: null, launch: { exe: "Skeptic (USA).z64", args: "", cwd: "" }, prerequisites: [], files: [{ path: "Skeptic (USA).z64", size: rom.length, sha256: full.hashes.sha256 }], totalSize: rom.length, source: null, tier: "deterministic", kind: "rom", platform: "n64", notes: null, createdAt: "" };
    const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, rom.length, JSON.stringify(manifest)) as PackageRow;
    made.pkgs.push(pkg.id);
    await judgeCopy(g.id);
    // the hand-off read it once already: its hashes, and the stat they belong to
    recordCopyHashes(g.id, "Skeptic (USA).z64", { hashes: full.hashes, rawHashes: null, stat: hashedStat(lstatSync(file)) });
    // another kept file of the game, of the same size (another dump of a cartridge of that size)
    const other = join(libReal, `${g.slug}-other.z64`); const otherBytes = bytes(300_000, 42); writeFileSync(other, otherBytes);
    insertContent({ gameId: g.id, role: "game", platform: "n64", name: "Other (USA).z64", path: other, size: otherBytes.length, hashes: { sha1: "1".repeat(40) }, source: "upload", shape: "file" });
    expect(copyServes(g.id, c).serves).toBe("direct");
    ctdeps.link = async () => { const e = new Error("cross-device link") as Error & { code: string }; e.code = "EXDEV"; throw e; };
    const steps: string[] = [];
    const row = (await takeCopy({ game: g, way: w, content: c, log: () => {}, progress: (_b, _t, s) => { if (s && steps.at(-1) !== s) steps.push(s); } }))!;
    expect(steps).toEqual(["copying the game's copy"]);
    expect(readFileSync(row.path).equals(Buffer.from(rom))).toBe(true);
    expect(lstatSync(row.path).nlink).toBe(1);
  });
});

describe("S3. a game folder copied in is read once", () => {
  const folderWay = (): ContentPlan => ({ kind: "folder", platform: "ps5", what: "the PS5 game folder", search: ["Skeptic Folder"], accept: { hashes: [], serials: ["PPSA01341"] }, marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game" });
  /** a download holding the game folder, with ~3 MB of data in it */
  const folderDownload = () => {
    const src = join(downloadsDir(), `files-skeptic-${++seq}-folder`);
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 6; i++) files[`data/part${i}.bin`] = new Uint8Array(512 * 1024).fill(i + 1);
    writeApp0(join(src, "Release", "PPSA01341-app0"), { titleId: "PPSA01341", version: "01.007.000", files });
    return src;
  };
  /** the bytes-of-total the job said, in KB or MB as the message gives them, in order */
  const climbs = (messages: string[]) => messages.map(m => / · ([\d.]+) of [\d.]+ (?:KB|MB|GB)$/.exec(m)?.[1]).filter((v): v is string => !!v).map(Number);
  const EXDEV = async () => { const e = new Error("cross-device link") as Error & { code: string }; e.code = "EXDEV"; throw e; };

  for (const [what, setup] of [
    ["on another volume", () => { ctdeps.sameVolume = async () => false; }],
    ["on one device whose shares hold no hard links between them", () => { ctdeps.sameVolume = async () => true; ctdeps.link = EXDEV; }],
  ] as const) {
    test(`${what}: the folder's bytes are read once (its bytes of total climb once and never start over), and kept whole`, async () => {
      const g = game(`Skeptic Folder Copy ${what}`);
      const w = insertWay({ gameId: g.id, planId: plan(`Skeptic Folder Emu ${what}`, folderWay()).id, content: folderWay() });
      setup();
      let t = 0; ctdeps.now = () => (t += 1500);
      const ctx = ctxFor();
      const r = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: folderDownload(), fetchId: null });
      expect(r.manifest).toMatchObject({ outcome: "proven", by: "serial" });
      const seen = climbs(ctx.messages);
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.filter((v, i) => i > 0 && v < seen[i - 1])).toEqual([]);
      const row = db.query("SELECT * FROM contents WHERE id=?").get((r.manifest as { contentId: number }).contentId) as { path: string; size: number };
      expect(readFileSync(join(row.path, "data", "part5.bin")).equals(Buffer.from(new Uint8Array(512 * 1024).fill(6)))).toBe(true);
      expect(readFileSync(`${row.path}.tree.tsv`, "utf8")).toContain("data/part0.bin\t524288\t");
      expect(getWay(w.id)!.content_id).toBe((r.manifest as { contentId: number }).contentId);
    });
  }

  test("the same folder kept already: found before anything is written, nothing copied", async () => {
    const g = game("Skeptic Folder Twice");
    const src = folderDownload();
    ctdeps.sameVolume = async () => false;
    const first = await ingestTree(join(src, "Release", "PPSA01341-app0"), { role: "game", game: g }, { mode: "copy", hash: true, source: "indexer" });
    // no room at all now: a copy would be refused, so the second intake can only find the first
    ctdeps.diskSpace = async () => ({ free: 0, total: 2e15 });
    const again = await ingestTree(join(src, "Release", "PPSA01341-app0"), { role: "game", game: g }, { mode: "copy", hash: true, source: "indexer" });
    expect(again).toMatchObject({ duplicate: true });
    expect(again.row.id).toBe(first.row.id);
  });
});
describe("S4. taking a world-writable folder in says what it does while it makes it ludarr's own", () => {
  test("an app0 folder dropped over SMB (every file 0666): the job's message moves while world-write is taken off each file", async () => {
    const g = game("Skeptic Inbox Open");
    const c: ContentPlan = { kind: "folder", platform: "ps5", what: "the PS5 game folder", search: ["Skeptic Inbox Open"], accept: { hashes: [] }, marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game" };
    insertWay({ gameId: g.id, planId: plan("Skeptic Folder Emu Open", c).id, content: c });
    const box = join(libReal, ".ahoy-inbox", g.slug!); mkdirSync(box, { recursive: true });
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30; i++) files[`levels/m${String(i).padStart(2, "0")}/map.bin`] = new Uint8Array(64 * 1024).fill(i + 1);
    const entry = writeApp0(join(box, "PPSA01341-app0"), { titleId: "PPSA01341", files });
    const open = (dir: string) => { for (const n of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, n.name); if (n.isDirectory()) { chmodSync(p, 0o777); open(p); } else chmodSync(p, 0o666); } };
    open(entry);
    let now = 0; ctdeps.now = () => (now += 10);
    const messages: string[] = [];
    // each change of a file's mode takes a while (a FUSE share): the clock moves a second and a half per file
    const during: number[] = [];
    ctdeps.chmod = async (p: string, mode: number) => { now += 1500; during.push(messages.length); try { chmodSync(p, mode); } catch { /* a share that keeps its modes */ } };
    const ctx = { job: {} as never, spec: { kind: "content", gameId: g.id, path: entry, inbox: true } as never, work: tmp, staging: tmp, log: () => {}, progress: (_p: number, m?: string) => { if (m) messages.push(m); }, signal: new AbortController().signal };
    const r = await jobKinds.get("content")!.run(ctx as KindContext);
    expect((r.manifest as { contentId: number | null }).contentId).not.toBeNull();
    expect(during.length).toBeGreaterThan(30);                                   // every file and folder of the drop
    expect(during.at(-1)! - during[0]).toBeGreaterThan(2);                      // the message moved while that went on
    expect(messages.some(m => /^protecting PPSA01341-app0 from changes · \d+ of \d+ (KB|MB)$/.test(m))).toBe(true);
  });
});

describe("S5. a game file unpacked from a download's archive on the library is linked into the store, not copied", () => {
  test("the download on another volume (the seedbox mount), its archive unpacked in the job's folder on the library: one read, no second copy", async () => {
    const g = game("Skeptic Unpacked", ["ps2"]);
    const iso = psIso({ boot: "cdrom0:\\SLUS_299.72;1", size: 16 * 2 ** 20, seed: 12 });
    const sha1 = new Bun.CryptoHasher("sha1").update(iso).digest("hex");
    const c: ContentPlan = { kind: "disc", platform: "ps2", what: "the US disc", search: ["Skeptic Unpacked"], accept: { hashes: [{ algo: "sha1", value: sha1 }], formats: ["iso"] }, place: "g/{name}" };
    const w = insertWay({ gameId: g.id, planId: plan("Skeptic Unpacked Emu", c).id, content: c });
    const remote = realpathSync(downloadsDir());
    const src = join(remote, `files-skeptic-${++seq}-archive`); mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "Skeptic.Unpacked.USA.PS2-GRP.7z"), new Uint8Array(4096).fill(55));
    // the download's volume is another device than the library's; the job's folder is on the library
    ctdeps.sameVolume = async (a: string, b: string) => a.startsWith(remote) === b.startsWith(remote);
    fdeps.unpackRoom = async (work: string) => ({ dir: work, away: false });
    fdeps.extract = (async (_o: unknown, _archive: string, out: string) => { writeFileSync(join(out, "Skeptic Unpacked (USA).iso"), iso); }) as typeof fdeps.extract;
    const ctx = ctxFor();
    const r = await takeDownload(ctx, { kind: "content", gameId: g.id, wayId: w.id, path: src, fetchId: null });
    expect(r.manifest).toMatchObject({ outcome: "proven", by: "hash" });
    const row = db.query("SELECT * FROM contents WHERE id=?").get((r.manifest as { contentId: number }).contentId) as { path: string };
    // the kept file is the unpacked one, linked (it is still in the job's folder here: the runner removes that folder)
    expect(lstatSync(row.path).nlink).toBe(2);
    expect(ctx.messages.some(m => m.includes("copying"))).toBe(false);
  });
});
