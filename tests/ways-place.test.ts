/**
 * Placing a kept game file into a package (DESIGN3 B3 item 3, AMEND C2): a hard link from the content store when the
 * volume can and no setup step runs a program — nothing copied, and its sha256 not read again while the stat taken right
 * after the link holds — else a copy with real progress, hashed as it is written; a folder as a tree of links; a file the
 * setup reads handed over read-only. The link probe decides once per volume and is logged; the link check accepts exactly
 * the links ludarr placed. The fakes: the link itself (a share without hard links), the sandbox's user database and
 * ownership changes, the reads the manifest makes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { events } from "../src/events";
import { ensureDefaultRootFolder, rootFolderFor } from "../src/library/rootfolders";
import { enqueueJob, jobKinds } from "../src/process/kinds";
import { finalizePackage, runJob } from "../src/process/runner";
import { buildManifest, vdeps, type KnownFile, type Manifest, type Validation } from "../src/process/validate";
import { pdeps } from "../src/process/deps";
import { adeps } from "../src/ways/assemble";
import { forgetLinkProbes, forgetPlaced, handOver, isPlacedLink, linksWork, placeContent, pldeps, prdeps, refuseLinks } from "../src/ways/program";
import { SANDBOX_UIDS, sbdeps } from "../src/ways/sandbox";
import { getWay, insertContent, insertPlan, insertWay, updateWay, type ContentRow } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import type { HashedStat, PlanKind, RuntimePlanSpec } from "../src/ways/types";
import { bytes, dirLink, fake7z, ok, releaseHost, restoreDeps, sha1, sha256, tempConfig, tmp, tools7z, zelda } from "./ways-fixtures";

const ASSET = "Zelda64Recompiled-v1.2.2-Windows.zip";
const URL_ = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.2/${ASSET}`;
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(4000, 7)]);
const RELEASE = { tag: "v1.2.2", name: "v1.2.2", date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: ASSET, url: URL_, size: ZIP.byteLength, digest: `sha256:${sha256(ZIP)}` } };

const mmSpec = (sha: string, over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "Zelda64Recompiled.exe", argv: ["{content}"] },
  content: { kind: "rom", platform: "n64", what: "Majora's Mask, NTSC-U 1.0", search: ["The Legend of Zelda: Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha }], formats: ["z64"] }, normalize: null, place: "game/mm.z64" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...over,
});
const statOf = (path: string): HashedStat => { const s = lstatSync(path); return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, dev: s.dev, ino: s.ino }; };

let seq = 0;
/** a game, its game file kept in a store folder (hashed with its stat, unless told not to), a ready plan, the way */
function fixture(o: { spec?: (sha: string) => RuntimePlanSpec; kind?: PlanKind; stat?: boolean; rom?: Uint8Array } = {}) {
  seq++;
  const game = upsertGame({ steam_appid: 993_000 + seq, name: `Place Test ${seq}`, slug: `place-test-${seq}` }) as GameRow;
  const rom = o.rom ?? bytes(256 * 1024, seq % 250);
  const store = join(tmp("place-root-"), ".ahoy-content", `place-test-${seq}`);
  mkdirSync(store, { recursive: true });
  const romPath = join(store, "Majora's Mask (USA).z64");
  writeFileSync(romPath, rom);
  const checked = validatePlanSpec((o.spec ?? mmSpec)(sha1(rom)), o.kind ?? "recomp");
  if (!checked.ok) throw new Error(`fixture plan does not validate: ${checked.errors.join("; ")}`);
  const plan = insertPlan({ name: `Place Plan ${seq}`, kind: o.kind ?? "recomp", repo: "Zelda64Recomp/Zelda64Recomp", platforms: ["n64"], spec: checked.value!, status: "ready" });
  const file = insertContent({ gameId: game.id, platform: "n64", name: basename(romPath), path: romPath, size: rom.byteLength, hashes: { sha1: sha1(rom), sha256: sha256(rom) }, source: "upload", ...(o.stat === false ? {} : { stat: statOf(romPath) }) });
  const way = updateWay(insertWay({ gameId: game.id, planId: plan.id, status: "ready" }).id, { contentId: file.id })!;
  return { game, plan, way, file, rom, romPath };
}
/** a build of the way, with every 'build' message it said */
async function build(wayId: number): Promise<{ job: JobRow; said: string[] }> {
  const j = enqueueJob({ kind: "assemble", wayId }, { gameId: getWay(wayId)!.game_id });
  const said: string[] = [];
  const off = events.subscribe(e => { const d = e.data as { id?: number; message?: string } | null; if (e.event === "build" && d?.id === j.id && d.message) said.push(d.message); });
  try { await runJob(j.id); } finally { off(); }
  return { job: stmts.jobById.get(j.id) as JobRow, said };
}
const pkgOf = (gameId: number) => stmts.packageForGame.get(gameId) as PackageRow;
const manifestOf = (p: PackageRow) => JSON.parse(p.manifest_json) as { files: { path: string; sha256: string }[] };

let cfg: ReturnType<typeof tempConfig>;
let reads: string[];
let logged: string[];
const realLink = pldeps.link, realSha = vdeps.sha256, realAdeps = { ...adeps };
const EXDEV = async () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };
let wineDir: string;
let other: ((c: string[]) => ReturnType<typeof ok> | null) | null = null;
beforeAll(() => { cfg = tempConfig(); wineDir = tmp("place-wine-"); writeFileSync(join(wineDir, "wine"), ""); writeFileSync(join(wineDir, "wineserver"), ""); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  reads = []; logged = []; other = null;
  pdeps.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  pdeps.tools = () => ({ ...tools7z, wine: join(wineDir, "wine"), xvfb: "xvfb-run" });
  sbdeps.platform = () => "win32";
  sbdeps.exec = fake7z({ [ASSET]: zelda }, { other: c => other?.(c) ?? null });
  releaseHost({ [URL_]: ZIP });
  prdeps.latestRelease = async () => RELEASE;
  Object.assign(adeps, realAdeps, { contentFromPackage: async () => null });
  vdeps.sha256 = async (path, onBytes, signal) => { reads.push(path); return realSha(path, onBytes, signal); };
  pldeps.link = realLink;
  forgetLinkProbes();
});
afterEach(() => { restoreDeps(); pldeps.link = realLink; vdeps.sha256 = realSha; forgetLinkProbes(); delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

describe("the game file in a package", () => {
  test("where hard links work it is the store's own file: a link, nothing copied, its sha256 never read again; the probe is logged once", async () => {
    const f = fixture();
    const { job } = await build(f.way.id);
    expect(job.state).toBe("done");
    const pkg = pkgOf(f.game.id);
    const placed = join(pkg.path, "game", "mm.z64");
    const st = lstatSync(placed), store = lstatSync(f.romPath);
    expect([st.ino, st.dev, st.nlink >= 2]).toEqual([store.ino, store.dev, true]);
    expect(readFileSync(placed)).toEqual(Buffer.from(f.rom));
    // the manifest took the row's sha256: the 256 KB game file was not read for it (the program's files were)
    const m = manifestOf(pkg);
    expect(m.files.find(x => x.path === "game/mm.z64")!.sha256).toBe(sha256(f.rom));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.some(p => p.endsWith("mm.z64"))).toBe(false);
    expect(job.transcript).toMatch(/a hard link: nothing copied, its sha256 kept/);
    expect(job.transcript).toMatch(/hard links work on the volume of /);
    expect(logged.filter(l => /hard links work on the volume of/.test(l)).length).toBe(1);
    // a second build asks the volume nothing again
    expect((await build(f.way.id)).job.state).toBe("done");
    expect(logged.filter(l => /hard links (do not )?work on the volume of/.test(l)).length).toBe(1);
    // the package going does not take the store's file with it
    const again = pkgOf(f.game.id);
    expect(existsSync(f.romPath)).toBe(true);
    expect(again.id).not.toBe(pkg.id);
  });

  test("a row whose hashes were taken under another stat (or none) is linked but read again: its sha256 is trusted only with the same file", async () => {
    const f = fixture({ stat: false });
    expect((await build(f.way.id)).job.state).toBe("done");
    expect(reads.filter(p => p.endsWith("mm.z64")).length).toBe(1);
    // a stat from another inode (the file was replaced after it was hashed): read again too
    const g = fixture();
    const elsewhere = join(tmp("place-other-"), "x.z64"); writeFileSync(elsewhere, g.rom);
    db.query("UPDATE contents SET stat_json=? WHERE id=?").run(JSON.stringify(statOf(elsewhere)), g.file.id);
    reads.length = 0;
    expect((await build(g.way.id)).job.state).toBe("done");
    expect(reads.filter(p => p.endsWith("mm.z64")).length).toBe(1);
  });

  test("a store file whose bytes are not the ones it was taken in with is never shipped: the file's fault, whether it was linked or copied", async () => {
    for (const links of [true, false]) {
      pldeps.link = links ? realLink : EXDEV;
      forgetLinkProbes();
      const f = fixture({ stat: false });
      writeFileSync(f.romPath, bytes(f.rom.byteLength, 255));          // the same size, other bytes: only a read can tell
      const { job } = await build(f.way.id);
      expect(job).toMatchObject({ state: "failed", message: "the game file Majora's Mask (USA).z64 on the server is not the one that was checked (its sha256 changed since it was taken in): take it in again" });
      expect(JSON.parse(job.fail_json!)).toEqual({ class: "file" });
      expect(stmts.packageForGame.get(f.game.id)).toBeNull();
      expect(getWay(f.way.id)!.status).toBe("needs-files");
    }
  });

  test("where hard links do not work (the probe says so), it is copied with real progress and hashed as it is written: the manifest does not read it again", async () => {
    pldeps.link = EXDEV;
    const f = fixture({ rom: bytes(3 * 1024 * 1024, 5) });
    const { job, said } = await build(f.way.id);
    expect(job.state).toBe("done");
    const placed = join(pkgOf(f.game.id).path, "game", "mm.z64");
    expect(lstatSync(placed).ino).not.toBe(lstatSync(f.romPath).ino);
    expect(lstatSync(placed).nlink).toBe(1);
    expect(readFileSync(placed)).toEqual(Buffer.from(f.rom));
    expect(said.some(m => /^placing the game file · 0 of 3 MB$/.test(m))).toBe(true);
    expect(said).toContain("placing the game file · 3 of 3 MB");
    expect(reads.some(p => p.endsWith("mm.z64"))).toBe(false);
    expect(job.transcript).toMatch(/hard links do not work on the volume of .* \(EXDEV\)/);
    expect(job.transcript).toMatch(/copied, 0\.00 GB, hashed as it was written/);
  });

  test("a plan whose setup runs a program gets a copy (hashed as it is written), never the store's own file", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    other = c => (c[0] === "xvfb-run" ? ok() : c[1] === "-k" ? ok() : null);
    const f = fixture({ spec: sha => mmSpec(sha, { setup: [{ run: { exe: "Zelda64Recompiled.exe", argv: ["--extract"], wine: true, timeoutSec: 60 } }] }) });
    const { job } = await build(f.way.id);
    expect(job.state).toBe("done");
    const placed = join(pkgOf(f.game.id).path, "game", "mm.z64");
    expect(lstatSync(placed).ino).not.toBe(lstatSync(f.romPath).ino);
    expect(job.transcript).toMatch(/copied, .* hashed as it was written/);
    expect(manifestOf(pkgOf(f.game.id)).files.find(x => x.path === "game/mm.z64")!.sha256).toBe(sha256(f.rom));
  });

  test("the setup's own copy of a file it consumes is a link in the scratch folder, never a copy, and never shipped", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    let seen: { path: string; nlink: number; bytes: number } | null = null;
    const f = fixture({ spec: sha => mmSpec(sha, { launch: { exe: "Zelda64Recompiled.exe", argv: [] }, content: { ...mmSpec(sha).content!, ship: false }, setup: [{ run: { exe: "Zelda64Recompiled.exe", argv: ["--rom", "{content}"], wine: false, timeoutSec: 60 } }] }) });
    // the program run (wine false): {content} goes in as the path it was handed over at
    other = c => {
      const p = c.find(a => /[\\/]in[\\/]/.test(a));
      if (p) { const st = lstatSync(p); seen = { path: p, nlink: st.nlink, bytes: st.size }; return ok(); }
      return null;
    };
    const { job } = await build(f.way.id);
    expect(job.state).toBe("done");
    expect(seen!.path.replace(/\\/g, "/")).toMatch(/job-\d+\/in\/Majoras_Mask_USA\.z64$/);
    expect(seen!.nlink).toBeGreaterThanOrEqual(2);
    expect(seen!.bytes).toBe(f.rom.byteLength);
    expect(manifestOf(pkgOf(f.game.id)).files.some(x => x.path.endsWith(".z64"))).toBe(false);
  });

  test("a row hashed before stats were kept is read once by the manifest, then trusted: its stat goes with it, and the next build reads nothing", async () => {
    const f = fixture({ stat: false });
    const first = await build(f.way.id);
    expect(first.job.state).toBe("done");
    expect(reads.filter(p => p.endsWith("mm.z64")).length).toBe(1);
    expect(first.job.transcript).toMatch(/read once more and still the file that was taken in; its sha256 is trusted from now on while it is unchanged/);
    const kept = JSON.parse((db.query("SELECT stat_json FROM contents WHERE id=?").get(f.file.id) as { stat_json: string }).stat_json) as HashedStat;
    const now = statOf(f.romPath);
    expect([kept.size, kept.mtimeMs, kept.dev, kept.ino]).toEqual([now.size, now.mtimeMs, now.dev, now.ino]);
    reads.length = 0;
    expect((await build(f.way.id)).job.state).toBe("done");
    expect(reads.some(p => p.endsWith("mm.z64"))).toBe(false);
    // a file whose bytes are not the row's gets no stat: it is refused, and read again next time
    const g = fixture({ stat: false });
    writeFileSync(g.romPath, bytes(g.rom.byteLength, 254));
    expect((await build(g.way.id)).job.state).toBe("failed");
    expect((db.query("SELECT stat_json FROM contents WHERE id=?").get(g.file.id) as { stat_json: string | null }).stat_json).toBeNull();
  });

  test("a game file placed where the package's own manifest goes (ahoy.json) is refused: the manifest is never written into the store's file", async () => {
    const f = fixture({ spec: sha => mmSpec(sha, { content: { ...mmSpec(sha).content!, place: "ahoy.json" } }) });
    const { job } = await build(f.way.id);
    expect(job).toMatchObject({ state: "failed", message: "the package would hold ahoy.json, the name of the package's own manifest: the program, the game file's place and the plan's files must not use it" });
    expect(JSON.parse(job.fail_json!)).toEqual({ class: "plan" });
    expect(readFileSync(f.romPath)).toEqual(Buffer.from(f.rom));
    expect(stmts.packageForGame.get(f.game.id)).toBeNull();
  });

  test("finalizing a package writes its manifest as a file of its own, never through a hard link that is there", async () => {
    const f = fixture();
    const work = tmp("place-final-"), staging = join(work, "staging");
    mkdirSync(staging);
    writeFileSync(join(staging, "Game.exe"), "exe");
    linkSync(f.romPath, join(staging, "ahoy.json"));                      // a link to the store's file under that name
    const root = rootFolderFor(f.game)!;
    const manifest = { schema: 1, name: f.game.name, slug: f.game.slug, version: null, launch: { exe: "Game.exe", args: "", cwd: "" }, prerequisites: [], files: [], totalSize: 3, source: null, tier: "deterministic", notes: null, kind: "recomp", platform: null, createdAt: "" } as unknown as Manifest;
    const job = stmts.insertJob.get(null, null, f.game.id, "/nowhere") as JobRow;
    stmts.setJobFailed.run("cancelled", "a test's own row", job.id);
    const { final } = await finalizePackage({ jobId: job.id, gameId: f.game.id, root, slug: `${f.game.slug}-final`, name: f.game.name, version: null, from: staging, manifest, by: "way", log: () => {} });
    expect(readFileSync(f.romPath)).toEqual(Buffer.from(f.rom));          // the store's bytes, untouched
    expect(JSON.parse(readFileSync(join(final, "ahoy.json"), "utf8")).name).toBe(f.game.name);
    expect(lstatSync(join(final, "ahoy.json")).ino).not.toBe(lstatSync(f.romPath).ino);
  });

  test("scratch: a linked placement writes nothing, a copy counts its size", async () => {
    const f = fixture();
    db.query("UPDATE contents SET size=? WHERE id=?").run(40e9, f.file.id);
    const scratch = jobKinds.get("assemble")!.scratch!;
    expect(await scratch({} as JobRow, { kind: "assemble", wayId: f.way.id })).toBe(2e9);
    pldeps.link = EXDEV;
    forgetLinkProbes();
    expect(await scratch({} as JobRow, { kind: "assemble", wayId: f.way.id })).toBe(3 * 300e6 + 40e9);
  });
});

describe("placeContent, piece by piece", () => {
  const row = (path: string, o: Partial<ContentRow> = {}): ContentRow => ({ id: 1, game_id: null, plan_id: null, need_index: null, role: "game", platform: "n64", name: basename(path), path, size: lstatSync(path).size, hashes_json: "{}", raw_hashes_json: null, normalized: null, source: "upload", created_at: 0, ...o });
  const job = () => { const work = tmp("place-job-"); const staging = join(work, "staging"); mkdirSync(staging); return { work, staging }; };

  test("the link check accepts exactly the links ludarr placed: a planted hard link to another file, or a symbolic link, is refused", async () => {
    const src = join(tmp("place-src-"), "game.bin"); writeFileSync(src, bytes(1000, 3));
    const { work, staging } = job();
    const p = await placeContent(staging, "data/game.bin", row(src), { link: true, scope: work });
    expect(p.linked).toBe(true);
    expect(p.links).toEqual([{ abs: join(staging, "data", "game.bin"), dev: lstatSync(src).dev, ino: lstatSync(src).ino }]);
    expect(isPlacedLink(p.abs, lstatSync(p.abs))).toBe(true);
    await refuseLinks(staging, "the package");
    // another file's hard link planted beside it
    const outside = join(tmp("place-out-"), "secret.txt"); writeFileSync(outside, "s");
    linkSync(outside, join(staging, "data", "planted.txt"));
    await expect(refuseLinks(staging, "the package")).rejects.toThrow("the package holds a hard link (data/planted.txt), and a package carries files of its own only");
    rmPlanted(join(staging, "data", "planted.txt"));
    // a symbolic link (a junction on Windows) planted beside it
    dirLink(tmp("place-out2-"), join(staging, "data", "elsewhere"));
    await expect(refuseLinks(staging, "the package")).rejects.toThrow("the package holds a link (data/elsewhere)");
    rmPlanted(join(staging, "data", "elsewhere"), true);
    await refuseLinks(staging, "the package");
    // the same inode linked outside the folder it was placed in is not one ludarr placed there
    const elsewhere = job();
    linkSync(src, join(elsewhere.staging, "copy.bin"));
    await expect(refuseLinks(elsewhere.staging, "the package")).rejects.toThrow(/holds a hard link \(copy\.bin\)/);
    // once the job is over, its links are not accepted any more
    forgetPlaced(work);
    await expect(refuseLinks(staging, "the package")).rejects.toThrow(/holds a hard link \(data\/game\.bin\)/);
  });

  test("a game folder is placed as a tree of links; a link inside the kept folder refuses it", async () => {
    const dir = join(tmp("place-folder-"), "PPSA01341-app0");
    mkdirSync(join(dir, "sce_sys"), { recursive: true });
    writeFileSync(join(dir, "eboot.bin"), bytes(5000, 1));
    writeFileSync(join(dir, "sce_sys", "param.json"), "{}");
    const { work, staging } = job();
    const progress: [number, number, string][] = [];
    const p = await placeContent(staging, "game", row(dir, { shape: "folder", size: 5002 }), { link: true, scope: work, progress: (d, t, how) => progress.push([d, t, how]) });
    expect(p.linked).toBe(true);
    expect(p.files.map(f => [f.rel, f.linked]).sort()).toEqual([["game/eboot.bin", true], ["game/sce_sys/param.json", true]]);
    expect(lstatSync(join(staging, "game", "eboot.bin")).ino).toBe(lstatSync(join(dir, "eboot.bin")).ino);
    expect(progress.at(-1)).toEqual([5002, 5002, "link"]);
    await refuseLinks(staging, "the package");
    // a kept folder holding a link is not placed at all
    dirLink(tmp("place-out3-"), join(dir, "sce_sys", "trophy"));
    const other = job();
    await expect(placeContent(other.staging, "game", row(dir, { shape: "folder", size: 5002 }), { link: true, scope: other.work })).rejects.toThrow("sce_sys/trophy in PPSA01341-app0 is a link: the folder is not used");
  });

  test("a file the setup or a build reads is handed over by a link in the scratch folder, or read where it is kept: never copied", async () => {
    const src = join(tmp("place-hand-"), "Super Mario 64 (USA).z64"); writeFileSync(src, bytes(4000, 9));
    const { work } = job();
    const linked = await handOver(row(src), work);
    expect(linked).toEqual({ path: join(work, "in", "Super_Mario_64_USA.z64"), linked: true });
    expect(lstatSync(linked.path).ino).toBe(lstatSync(src).ino);
    pldeps.link = EXDEV;
    const other = job();
    expect(await handOver(row(src), other.work)).toEqual({ path: src, linked: false });
    expect(existsSync(join(other.work, "in", "Super_Mario_64_USA.z64"))).toBe(false);
  });

  test("with the sandbox, a store file is made read-only before it is linked; one a build user owns is never linked, nor handed over", async () => {
    const chmods: [string, number][] = [];
    sbdeps.platform = () => "linux"; sbdeps.uid = () => 0; sbdeps.which = (n: string) => (n === "runuser" ? "/usr/sbin/runuser" : null);
    sbdeps.passwd = () => "root:x:0:0::/root:/bin/sh\nbuilder:x:1500:1500::/home/builder:/bin/sh\n";
    sbdeps.chmod = async (p: string, mode: number) => { chmods.push([p, mode]); };
    sbdeps.chown = async () => {};
    const src = join(tmp("place-sb-"), "game.bin"); writeFileSync(src, bytes(2000, 4));
    chmodSync(src, 0o666);
    const mode = lstatSync(src).mode & 0o777;
    const { work, staging } = job();
    const p = await placeContent(staging, "game.bin", row(src), { link: true, scope: work });
    expect(p.linked).toBe(true);
    expect(chmods).toEqual([[src, mode & 0o555]]);
    // a store file a build user owns (here: this box's own uid, counted as one): copied, and refused as {content}
    SANDBOX_UIDS.push(lstatSync(src).uid);
    try {
      const other = job();
      const q = await placeContent(other.staging, "game.bin", row(src), { link: true, scope: other.work });
      expect(q.linked).toBe(false);
      expect(q.files[0].sha256).toBe(sha256(bytes(2000, 4)));
      await expect(handOver(row(src), other.work)).rejects.toThrow("belongs to a build user on this server: it may have been changed, so it is not used (take it in again)");
    } finally { SANDBOX_UIDS.pop(); }
  });

  test("the link probe answers once per volume, and a share without hard links copies everything", async () => {
    const { work } = job();
    expect(await linksWork(work)).toBe(true);
    pldeps.link = EXDEV;
    expect(await linksWork(work)).toBe(true);                             // the volume's answer stands
    forgetLinkProbes();
    expect(await linksWork(work)).toBe(false);
    expect(logged.filter(l => /hard links do not work on the volume of .* \(EXDEV\): game files are copied into packages/.test(l)).length).toBe(1);
    expect(await linksWork(join(work, "no-such-folder"))).toBe(false);
  });
});

describe("the manifest reads nothing it knows (C2)", () => {
  test("a placed file's sha256 is taken only while its stat is exactly the one taken right after it was placed: a touch, a chmod or a new link means it is read again", async () => {
    const src = join(tmp("place-c2-"), "big.bin"); writeFileSync(src, bytes(64 * 1024, 2));
    const work = tmp("place-c2-job-"), staging = join(work, "staging"); mkdirSync(staging);
    writeFileSync(join(staging, "Game.exe"), "exe");
    const p = await placeContent(staging, "big.bin", { id: 1, game_id: null, plan_id: null, need_index: null, role: "game", platform: null, name: "big.bin", path: src, size: 64 * 1024, hashes_json: JSON.stringify({ sha256: sha256(bytes(64 * 1024, 2)) }), raw_hashes_json: null, normalized: null, source: "upload", created_at: 0, stat_json: JSON.stringify(statOf(src)) }, { link: true, scope: work });
    const f = p.files[0];
    expect(f.sha256).toBe(sha256(bytes(64 * 1024, 2)));
    const known = new Map<string, KnownFile>([["big.bin", { sha256: f.sha256!, size: f.size, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs, dev: f.dev, ino: f.ino }]]);
    const v: Validation = { ok: true, root: staging, problems: [], exeCandidates: ["Game.exe"], launch: "Game.exe", prerequisites: [], totalSize: 0, fileCount: 2 };
    const meta = { name: "G", version: null, source: null, tier: "deterministic" as const };
    reads.length = 0;
    const m1 = await buildManifest(v, meta, undefined, { known });
    expect(m1.files.find(x => x.path === "big.bin")!.sha256).toBe(f.sha256!);
    expect(reads.map(r => basename(r))).toEqual(["Game.exe"]);
    // the inode changed after it was placed (a chmod moves its ctime; file times tick in steps of a few ms): read again
    await Bun.sleep(40);
    chmodSync(src, 0o444);
    reads.length = 0;
    const m2 = await buildManifest(v, meta, undefined, { known });
    expect(reads.map(r => basename(r)).sort()).toEqual(["Game.exe", "big.bin"]);
    expect(m2.files.find(x => x.path === "big.bin")!.sha256).toBe(sha256(bytes(64 * 1024, 2)));
    chmodSync(src, 0o644);
    // a file whose size or inode is not the known one is read too (another file put in its place)
    rmPlanted(join(staging, "big.bin"));
    writeFileSync(join(staging, "big.bin"), bytes(64 * 1024, 2));
    reads.length = 0;
    await buildManifest(v, meta, undefined, { known });
    expect(reads.map(r => basename(r)).sort()).toEqual(["Game.exe", "big.bin"]);
  });

  test("a cancel stops the reading", async () => {
    const dir = tmp("place-cancel-");
    writeFileSync(join(dir, "Game.exe"), bytes(256 * 1024, 1));
    const ac = new AbortController();
    ac.abort();
    const v: Validation = { ok: true, root: dir, problems: [], exeCandidates: ["Game.exe"], launch: "Game.exe", prerequisites: [], totalSize: 0, fileCount: 1 };
    await expect(buildManifest(v, { name: "G", version: null, source: null, tier: "deterministic" }, undefined, { signal: ac.signal })).rejects.toThrow("cancelled");
  });
});

/** a test's planted entry gone again (a junction is a folder to rmSync) */
function rmPlanted(p: string, dir = false) {
  const fs = require("node:fs") as typeof import("node:fs");
  if (dir) fs.rmSync(p, { recursive: false, force: true }); else fs.unlinkSync(p);
}
