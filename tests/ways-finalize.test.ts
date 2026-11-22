/**
 * The runner around a finished folder and around scratch space (review findings e2e-2, games-6, ways-api-8 / e2e-7,
 * ways-build-3): a package only ever moves into a folder of its own (never another game's, never a name another package
 * row records), also where a rename cannot move it, a folder nothing could record is removed again, a kind's own scratch
 * estimate counts as it is (0 is 0), the content kind's estimate is the file it copies, and a build that takes its game
 * file from the console copy counts that dump.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow, type RootFolderRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { enqueueJob, jobKinds, type KindDef } from "../src/process/kinds";
import * as runner from "../src/process/runner";
import { activeJobs, finalizePackage, processTick } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import type { Manifest } from "../src/process/validate";
import "../src/ways/assemble";
import { ctdeps } from "../src/ways/content";
import { forgetLinkProbes, pldeps } from "../src/ways/program";
import { insertPlan, insertWay } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";

const tmp = mkdtempSync(join(tmpdir(), "ways-finalize-"));
const lib = join(tmp, "library");
const root: RootFolderRow = { id: 994_000, path: lib, name: null, created_at: 0 };
const made = { games: [] as number[], plans: [] as number[], jobs: [] as number[] };
const realPdeps = { ...pdeps };
beforeAll(() => { mkdirSync(lib, { recursive: true }); ensureDefaultRootFolder(); });
afterEach(() => { Object.assign(pdeps, realPdeps); delete process.env.WAYS_PARALLEL; });
afterAll(() => {
  for (const id of made.jobs) db.query("DELETE FROM jobs WHERE id=?").run(id);
  for (const id of made.games) { for (const t of ["packages", "jobs", "history"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id); db.query("DELETE FROM games WHERE id=?").run(id); }
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function game(name: string, slug: string): GameRow {
  const g = upsertGame({ name, slug: `${slug}`, platforms_json: JSON.stringify(["pc"]) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
const manifest = (name: string, kind = "native"): Manifest => ({ schema: 1, name, slug: "x", version: "1", launch: { exe: "run.exe", args: "", cwd: "" }, prerequisites: [], files: [], totalSize: 1, source: null, tier: "deterministic", kind, platform: null, notes: null, createdAt: "" } as unknown as Manifest);
function staging(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmp, `staging-${++seq}-`));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), text); }
  return dir;
}
function job(gameId: number | null): JobRow {
  const j = stmts.insertJob.get(null, null, gameId, tmp) as JobRow;
  db.query("UPDATE jobs SET state='done' WHERE id=?").run(j.id);
  made.jobs.push(j.id);
  return j;
}
const ls = (p: string) => readdirSync(p).sort();

describe("a package only moves into a folder of its own (e2e-2)", () => {
  test("a restart finishes a verified transfer on either side of the final rename", async () => {
    for (const landed of [false, true]) {
      const slug = landed ? "transfer-landed" : "transfer-pending";
      const g = game(slug, slug), j = job(g.id);
      const from = staging({ "Game.exe": "MZ" }), final = join(lib, slug), token = crypto.randomUUID();
      const options = { jobId: j.id, gameId: g.id, root, slug, name: g.name, version: "1", from, manifest: manifest(g.name), by: "import" };
      if (landed) {
        mkdirSync(final); writeFileSync(join(final, "Game.exe"), "MZ"); writeFileSync(join(final, ".ludarr-transfer-" + token), "");
      }
      db.query("UPDATE jobs SET publication_json=?,state='queued' WHERE id=?").run(JSON.stringify({ options, final, token, previousId: null }), j.id);
      await runner.runJob(j.id);
      expect((stmts.jobById.get(j.id) as JobRow).state).toBe("done");
      expect((stmts.packageForJob.get(j.id) as PackageRow).path).toBe(final);
      expect(readFileSync(join(final, "Game.exe"), "utf8")).toBe("MZ");
      expect(existsSync(join(final, ".ludarr-transfer-" + token))).toBe(false);
    }
  });

  test("a rebuild whose <slug>-<job> folder is another game's lands beside it, and that game's copy is left as it is", async () => {
    const j3 = job(null);
    // the other game's copy: a sequel whose slug is the rebuilt game's slug and this job's number
    const sequel = game("Alpha Sequel", `alpha-fin-${j3.id}`);
    const sequelDir = join(lib, sequel.slug!);
    mkdirSync(sequelDir, { recursive: true });
    writeFileSync(join(sequelDir, "Sequel.exe"), "sequel");
    writeFileSync(join(sequelDir, "ahoy.json"), JSON.stringify(manifest("Alpha Sequel")));
    stmts.insertPackage.get(sequel.id, null, sequelDir, sequel.name, "1", 1, JSON.stringify(manifest("Alpha Sequel")));
    // the rebuilt game's own copy holds <slug>
    const alpha = game("Alpha", "alpha-fin");
    const first = staging({ "run.exe": "build 1" });
    const p1 = await finalizePackage({ jobId: job(alpha.id).id, gameId: alpha.id, root, slug: "alpha-fin", name: "Alpha", version: "1", from: first, manifest: manifest("Alpha", "recomp"), by: "way", log: () => {} });
    expect(p1.final).toBe(join(lib, "alpha-fin"));
    const second = staging({ "run.exe": "build 2" });
    const p2 = await finalizePackage({ jobId: j3.id, gameId: alpha.id, root, slug: "alpha-fin", name: "Alpha", version: "2", from: second, manifest: manifest("Alpha", "recomp"), by: "way", log: () => {} });
    expect(p2.final).toBe(join(lib, `alpha-fin-${j3.id}-1`));
    expect(ls(sequelDir)).toEqual(["Sequel.exe", "ahoy.json"]);
    expect(JSON.parse(readFileSync(join(sequelDir, "ahoy.json"), "utf8")).name).toBe("Alpha Sequel");
    expect(readFileSync(join(p2.final, "run.exe"), "utf8")).toBe("build 2");
    // the next rebuild takes <slug> again and removes only its own previous folder
    const p3 = await finalizePackage({ jobId: job(alpha.id).id, gameId: alpha.id, root, slug: "alpha-fin", name: "Alpha", version: "3", from: staging({ "run.exe": "build 3" }), manifest: manifest("Alpha", "recomp"), by: "way", log: () => {} });
    expect(p3.final).toBe(join(lib, "alpha-fin"));
    expect(existsSync(p2.final)).toBe(false);
    expect(ls(sequelDir)).toEqual(["Sequel.exe", "ahoy.json"]);
  });

  test("moving a folder never merges it into one that is there, even where a rename cannot be used", async () => {
    const to = join(tmp, "taken"); mkdirSync(to, { recursive: true }); writeFileSync(join(to, "mine.txt"), "mine");
    const from = staging({ "theirs.txt": "theirs" });
    await expect(runner.moveDir(from, to)).rejects.toThrow("is already there");
    expect(ls(to)).toEqual(["mine.txt"]);
    expect(ls(from)).toEqual(["theirs.txt"]);
  });

  test("where a rename cannot move it (another volume), the folder is copied into one made for it; a taken one is still refused", async () => {
    const realRename = runner.rdeps.rename;
    let tried = 0;
    runner.rdeps.rename = async (a: string, b: string) => { tried++; throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${a}' -> '${b}'`), { code: "EXDEV" }); };
    try {
      const g = game("Cross Volume", "cross-volume-fin");
      const from = staging({ "Game.exe": "MZ", "data/levels/one.pak": "1", "data/two.pak": "2" });
      const p = await finalizePackage({ jobId: job(g.id).id, gameId: g.id, root, slug: "cross-volume-fin", name: g.name, version: "1", from, manifest: manifest(g.name), by: "import", log: () => {} });
      expect(tried).toBe(1);
      expect(p.final).toBe(join(lib, "cross-volume-fin"));
      expect(readdirSync(p.final, { recursive: true }).map(e => String(e).split(sep).join("/")).sort()).toEqual(["Game.exe", "ahoy.json", "data", "data/levels", "data/levels/one.pak", "data/two.pak"]);
      expect(readFileSync(join(p.final, "data", "levels", "one.pak"), "utf8")).toBe("1");
      expect(existsSync(from)).toBe(false);
      expect((stmts.packageForGame.get(g.id) as PackageRow).path).toBe(p.final);
      // a folder that is there is never copied into either
      const to = join(tmp, "taken-across"); mkdirSync(to, { recursive: true }); writeFileSync(join(to, "mine.txt"), "mine");
      const other = staging({ "theirs.txt": "theirs" });
      await expect(runner.moveDir(other, to)).rejects.toThrow("is already there");
      expect(ls(to)).toEqual(["mine.txt"]);
      expect(ls(other)).toEqual(["theirs.txt"]);
    } finally { runner.rdeps.rename = realRename; }
  });

  test("a name another package row records (its folder deleted by hand, no rescan yet) is taken: that game's next import removes nothing of this one's", async () => {
    const j = job(null);
    // the other game: a sequel whose slug is this game's slug and that job's number; its folder was deleted by hand
    const sequel = game("Gamma Sequel", `gamma-fin-${j.id}`);
    const gone = await finalizePackage({ jobId: job(sequel.id).id, gameId: sequel.id, root, slug: sequel.slug!, name: sequel.name, version: "1", from: staging({ "Sequel.exe": "sequel 1" }), manifest: manifest(sequel.name), by: "import", log: () => {} });
    rmSync(gone.final, { recursive: true, force: true });
    const gamma = game("Gamma", "gamma-fin");
    await finalizePackage({ jobId: job(gamma.id).id, gameId: gamma.id, root, slug: "gamma-fin", name: "Gamma", version: "1", from: staging({ "Gamma.exe": "v1" }), manifest: manifest("Gamma"), by: "import", log: () => {} });
    const second = await finalizePackage({ jobId: j.id, gameId: gamma.id, root, slug: "gamma-fin", name: "Gamma", version: "2", from: staging({ "Gamma.exe": "v2" }), manifest: manifest("Gamma"), by: "import", log: () => {} });
    expect(second.final).toBe(join(lib, `gamma-fin-${j.id}-1`));
    // the sequel imported again takes its own name back, and Gamma's copy stays
    const again = await finalizePackage({ jobId: job(sequel.id).id, gameId: sequel.id, root, slug: sequel.slug!, name: sequel.name, version: "2", from: staging({ "Sequel.exe": "sequel 2" }), manifest: manifest(sequel.name), by: "import", log: () => {} });
    expect(again.final).toBe(join(lib, sequel.slug!));
    expect(readFileSync(join(second.final, "Gamma.exe"), "utf8")).toBe("v2");
    expect((stmts.packageForGame.get(gamma.id) as PackageRow).path).toBe(second.final);
  });

  test("two rows that already name one folder (from before): replacing one package never removes the other's copy", async () => {
    const shared = join(lib, "delta-fin-shared"); mkdirSync(shared, { recursive: true }); writeFileSync(join(shared, "Delta.exe"), "delta");
    const stale = game("Delta Old", "delta-old-fin"), live = game("Delta", "delta-fin");
    stmts.insertPackage.get(stale.id, null, shared, stale.name, "1", 1, JSON.stringify(manifest(stale.name)));
    stmts.insertPackage.get(live.id, null, shared, live.name, "1", 1, JSON.stringify(manifest(live.name)));
    const lines: string[] = [];
    const re = await finalizePackage({ jobId: job(stale.id).id, gameId: stale.id, root, slug: "delta-old-fin", name: stale.name, version: "2", from: staging({ "Old.exe": "x" }), manifest: manifest(stale.name), by: "import", log: l => lines.push(l) });
    expect(re.final).toBe(join(lib, "delta-old-fin"));
    expect(readFileSync(join(shared, "Delta.exe"), "utf8")).toBe("delta");
    expect(lines).toContain(`previous copy's folder ${shared} is another package's too: left in place`);
  });

  test("a folder whose package cannot be recorded (its game was deleted meanwhile) is removed again (games-6)", async () => {
    const gone = game("Deleted Mid Build", "deleted-mid-build");
    db.query("DELETE FROM games WHERE id=?").run(gone.id);
    const from = staging({ "run.exe": "x", "assets/a.bin": "y" });
    await expect(finalizePackage({ jobId: job(null).id, gameId: gone.id, root, slug: "deleted-mid-build", name: "Deleted Mid Build", version: null, from, manifest: manifest("Deleted Mid Build", "recomp"), by: "way", log: () => {} }))
      .rejects.toThrow("FOREIGN KEY");
    expect(existsSync(join(lib, "deleted-mid-build"))).toBe(false);
  });
});

describe("scratch estimates (ways-api-8, e2e-7, ways-build-3)", () => {
  async function drain() { for (let i = 0; i < 400 && activeJobs() > 0; i++) await Bun.sleep(10); }

  test("a kind that needs no scratch starts beside a running job when scratch is short; one that says nothing usable counts 2 GB", async () => {
    const saved = { build: jobKinds.get("build"), construct: jobKinds.get("construct") };
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const blocker: KindDef = { run: async () => { await gate; return { message: "built" }; }, scratch: () => 9e9 };
    jobKinds.set("build", blocker);
    jobKinds.set("construct", { run: async () => ({ message: "done" }), scratch: () => 0, resumable: false });
    pdeps.log = () => {};
    pdeps.diskSpace = async () => ({ free: 10e9, total: 100e9 });
    process.env.WAYS_PARALLEL = "5";
    const big = enqueueJob({ kind: "build", planId: 994_001 }), zero = enqueueJob({ kind: "construct", repo: "finalize/zero" });
    made.jobs.push(big.id, zero.id);
    try {
      await processTick();
      await Bun.sleep(30);
      const z = stmts.jobById.get(zero.id) as JobRow;
      expect(z.state).not.toBe("queued");
      expect(z.message ?? "").not.toContain("waiting for scratch space");
      // a NaN estimate is no estimate: the default 2 GB, which does not fit beside the running 9 GB job
      jobKinds.set("construct", { run: async () => ({ message: "done" }), scratch: () => Number.NaN, resumable: false });
      const nan = enqueueJob({ kind: "construct", repo: "finalize/nan" });
      made.jobs.push(nan.id);
      await processTick();
      expect(stmts.jobById.get(nan.id)).toMatchObject({ state: "queued" });
      expect((stmts.jobById.get(nan.id) as JobRow).message).toContain("needs about 2.0 GB");
      stmts.setJobFailed.run("cancelled", "test over", nan.id);
    } finally {
      open();
      await drain();
      for (const [k, v] of Object.entries(saved)) { if (v) jobKinds.set(k as "build", v); else jobKinds.delete(k as "build"); }
    }
  });

  test("the content kind needs the size of the file it copies (across volumes), nothing for one it links in, 0 when it cannot look", async () => {
    const def = jobKinds.get("content")!;
    const file = join(tmp, "disc.iso"); writeFileSync(file, new Uint8Array(123_456));
    const sameVolume = ctdeps.sameVolume;
    try {
      ctdeps.sameVolume = async () => false;
      expect(await def.scratch!({} as JobRow, { kind: "content", gameId: null, path: file })).toBe(123_456);
      ctdeps.sameVolume = async () => true;
      expect(await def.scratch!({} as JobRow, { kind: "content", gameId: null, path: file })).toBe(0);
    } finally { ctdeps.sameVolume = sameVolume; }
    expect(await def.scratch!({} as JobRow, { kind: "content", gameId: null, path: join(tmp, "no-such.iso") })).toBe(0);
  });

  test("a build that takes its game file from the console copy counts the dump only where it is copied (ways-build-3)", async () => {
    const g = game("Console Copy Build", "console-copy-build");
    const spec = validatePlanSpec({
      program: { kind: "release", assetPattern: "^Emu-.*[.]7z$", channel: "stable" }, launch: { exe: "emu.exe", argv: ["{content}"] },
      content: { kind: "disc", platform: "ps2", what: "a PS2 disc", search: ["x"], accept: { hashes: [], formats: ["iso"] }, place: "games/{name}" },
      files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
    }, "emulator").value!;
    const p = insertPlan({ name: "Console Copy Emu", kind: "emulator", repo: "finalize/emu", platforms: ["ps2"], spec, status: "ready" });
    made.plans.push(p.id);
    const w = insertWay({ gameId: g.id, planId: p.id, status: "ready" });
    const scratch = jobKinds.get("assemble")!.scratch!;
    const before = await scratch({} as JobRow, { kind: "assemble", wayId: w.id });
    const dir = join(lib, "console-copy-build-dump"); mkdirSync(dir, { recursive: true });
    stmts.insertPackage.get(g.id, null, dir, g.name, null, 4.7e9, JSON.stringify({ ...manifest(g.name, "rom"), platform: "ps2", totalSize: 4.7e9 })) as PackageRow;
    // where hard links work, the copy is taken by a link and placed by one: nothing of it is written
    expect(await scratch({} as JobRow, { kind: "assemble", wayId: w.id })).toBe(2e9);
    // where they do not (another volume, a share without them): taken by a copy, placed by a copy
    const realLink = pldeps.link;
    pldeps.link = async () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };
    forgetLinkProbes();
    try {
      const withCopy = await scratch({} as JobRow, { kind: "assemble", wayId: w.id });
      expect(before).toBe(2e9);
      expect(withCopy).toBe(3 * 300e6 + 2 * 4.7e9);
    } finally { pldeps.link = realLink; forgetLinkProbes(); }
  });
});
