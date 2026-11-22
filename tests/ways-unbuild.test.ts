/**
 * Every path that removes a way's package — DELETE /package, a rescan that finds the folder gone, an import that replaces
 * it — settles the way (ready again, or needs-files when its game file went too) and the catalog follows at once, so
 * "Ways to play" never says playable for a game with no copy (review findings ways-api-7, e2e-4).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { activityApi } from "../src/api/activity";
import { reingestCustom } from "../src/catalog/providers/custom";
import { db, stmts, upsertGame, type GameRow, type PackageRow, type RootFolderRow } from "../src/db";
import { rescanLibrary, rsdeps } from "../src/library/rescan";
import { finalizePackage } from "../src/process/runner";
import type { Manifest } from "../src/process/validate";
import "../src/ways/hooks";
import { getWay, insertContent, insertPlan, insertWay, updateWay, wstmts } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";

const tmp = mkdtempSync(join(tmpdir(), "ways-unbuild-"));
const realRs = { ...rsdeps };
const made = { games: [] as number[], plans: [] as number[] };
afterAll(() => {
  Object.assign(rsdeps, realRs);
  for (const id of made.games) {
    for (const t of ["contents", "packages", "jobs", "history"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
    db.query("DELETE FROM games WHERE id=?").run(id);
  }
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  reingestCustom();
  rmSync(tmp, { recursive: true, force: true });
});

const sha1 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const route = (wayId: number) => (db.query("SELECT status FROM routes WHERE source='custom' AND source_key=?").get(`way:${wayId}`) as { status: string | null } | null)?.status;
const manifest = (kind: string): Manifest => ({ schema: 1, name: "G", slug: "g", version: "1", launch: { exe: "run.exe", args: "", cwd: "" }, prerequisites: [], files: [], totalSize: 1, source: null, tier: "deterministic", kind, platform: null, notes: null, createdAt: "" } as unknown as Manifest);

let seq = 0;
/** a port of a PC game, built: its data file kept in a store folder, its package in a folder of its own, its route playable */
function builtWay(name: string) {
  const n = ++seq, data = new Uint8Array(4096).fill(n);
  const g = upsertGame({ name, slug: `unbuild-${n}`, release_year: 1993, platforms_json: JSON.stringify(["pc"]) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  const spec = validatePlanSpec({
    program: { kind: "release", assetPattern: "^Unbuild-.*[.]zip$", channel: "stable" }, launch: { exe: "run.exe", argv: [] },
    content: { kind: "rom", platform: "pc", what: "DATA.WAD", search: [name], accept: { hashes: [{ algo: "sha1", value: sha1(data) }], formats: ["wad"] }, place: "data.wad" },
    files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
  }, "port").value!;
  const plan = insertPlan({ name: `${name} port`, kind: "port", repo: `unbuild/port-${n}`, platforms: ["pc"], spec, status: "ready" });
  made.plans.push(plan.id);
  const store = join(tmp, "store", `game-${n}`); mkdirSync(store, { recursive: true });
  const path = join(store, "DATA.WAD"); writeFileSync(path, data);
  const file = insertContent({ gameId: g.id, platform: "pc", name: "DATA.WAD", path, size: data.byteLength, hashes: { sha1: sha1(data), sha256: sha256(data) }, source: "upload" });
  const way = updateWay(insertWay({ gameId: g.id, planId: plan.id, status: "ready" }).id, { contentId: file.id })!;
  const dir = join(tmp, "library", `unbuild-${n}`); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.exe"), "x");
  const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, "1", 1, JSON.stringify(manifest("port"))) as PackageRow;
  wstmts.setWayBuilt.run(pkg.id, way.id);
  reingestCustom();
  expect(route(way.id)).toBe("playable");
  return { g, way, file, pkg, path };
}

describe("a removed package settles its ways, and the catalog follows at once", () => {
  test("DELETE /package of a way whose game file is gone too: needs-files, and its route is no longer playable", async () => {
    const b = builtWay("Unbuild Gone File");
    db.query("DELETE FROM contents WHERE id=?").run(b.file.id);           // its file was removed while it stayed built
    expect(getWay(b.way.id)).toMatchObject({ status: "built", content_id: null });
    const r = await activityApi.request(`/api/v1/package/${b.pkg.id}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(getWay(b.way.id)).toMatchObject({ status: "needs-files", package_id: null, status_note: "needs the game file (DATA.WAD)" });
    expect(route(b.way.id)).toBeNull();
  });

  test("DELETE /package of a way that still has its file: ready again, saying why, and not playable", async () => {
    const b = builtWay("Unbuild Kept File");
    expect((await activityApi.request(`/api/v1/package/${b.pkg.id}`, { method: "DELETE" })).status).toBe(200);
    expect(getWay(b.way.id)).toMatchObject({ status: "ready", package_id: null, status_note: "its copy was removed" });
    expect(route(b.way.id)).toBeNull();
  });

  test("a rescan that finds the folder gone does the same", async () => {
    const b = builtWay("Unbuild Rescan");
    rmSync(b.pkg.path, { recursive: true, force: true });
    rsdeps.rootFolders = () => [];
    rsdeps.exists = async p => resolve(p) !== resolve(b.pkg.path) || existsSync(p);
    try { await rescanLibrary(); } finally { Object.assign(rsdeps, realRs); }
    expect(stmts.packageById.get(b.pkg.id)).toBeNull();
    expect(getWay(b.way.id)).toMatchObject({ status: "ready", package_id: null, status_note: "its copy is gone from disk" });
    expect(route(b.way.id)).toBeNull();
  });

  test("an import that replaces the way's package (asked to) does the same", async () => {
    const b = builtWay("Unbuild Replaced");
    db.query("DELETE FROM contents WHERE id=?").run(b.file.id);           // and its file is gone: it needs one again
    const from = mkdtempSync(join(tmp, "staging-")); writeFileSync(join(from, "Game.exe"), "MZ");
    const root: RootFolderRow = { id: 993_500, path: join(tmp, "library"), name: null, created_at: 0 };
    const job = stmts.insertJob.get(null, null, b.g.id, from) as { id: number };
    const lines: string[] = [];
    const r = await finalizePackage({ jobId: job.id, gameId: b.g.id, root, slug: b.g.slug!, name: b.g.name, version: null, from, manifest: manifest("native"), by: "import", replace: true, log: l => lines.push(l) });
    db.query("UPDATE jobs SET state='done' WHERE id=?").run(job.id);
    expect(r.previous?.id).toBe(b.pkg.id);
    expect(getWay(b.way.id)).toMatchObject({ status: "needs-files", package_id: null, status_note: "needs the game file (DATA.WAD)" });
    expect(route(b.way.id)).toBeNull();
    expect(lines).toContain("1 way to play built the replaced copy: no longer built");
  });
});
