/**
 * What a build writes into the package (review findings ways-build-1, ways-api-10 / e2e-3, launcher-1): the placed game
 * file's path goes into argv as it is (a '$' in it is no replacement pattern), a program file whose name no launcher would
 * install fails the build naming it, and the manifest seeds what the plan keeps (a kept settings file the package also
 * ships is the player's once it is on disk).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { enqueueJob } from "../src/process/kinds";
import { runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { adeps } from "../src/ways/assemble";
import { prdeps } from "../src/ways/program";
import { sbdeps } from "../src/ways/sandbox";
import { getWay, insertContent, insertPlan, insertWay, updateWay } from "../src/ways/store";
import type { RuntimePlanSpec } from "../src/ways/types";
import { validatePlanSpec } from "../src/ways/validate";
import { bytes, fake7z, ok, releaseHost, restoreDeps, sha1, sha256, tempConfig, tmp, tools7z } from "./ways-fixtures";

const EMU = "emu-v1.0-windows-x64.7z", EMU_URL = `https://github.com/buildchecks/emu/releases/download/v1.0/${EMU}`;
const SEVEN = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, ...bytes(4000, 8)]);
const BS = String.fromCharCode(92);
let layout: (out: string) => void = () => {};
let other: ((c: string[]) => ReturnType<typeof ok> | null) | null = null;

const emuSpec = (place: string, over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "windows-x64\\.7z$", channel: "stable" },
  launch: { exe: "emu.exe", argv: ["-batch", "--", "{content}"] },
  content: { kind: "disc", platform: "ps2", what: "a PS2 disc image", search: ["ps2"], accept: { hashes: [], formats: ["iso"] }, normalize: null, place },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...over,
});
let seq = 0;
function fixture(spec: RuntimePlanSpec) {
  seq++;
  const game = upsertGame({ name: `Build Checks ${seq}`, slug: `build-checks-${seq}`, platforms_json: JSON.stringify(["ps2"]) } as Partial<GameRow>) as GameRow;
  const disc = bytes(3000, seq), romPath = join(tmp("build-checks-disc-"), "God of War II (USA).iso");
  writeFileSync(romPath, disc);
  const checked = validatePlanSpec(spec, "emulator");
  if (!checked.ok) throw new Error(`fixture plan does not validate: ${checked.errors.join("; ")}`);
  const plan = insertPlan({ name: `Build Checks Plan ${seq}`, kind: "emulator", repo: "buildchecks/emu", platforms: ["ps2"], spec: checked.value!, status: "ready" });
  const file = insertContent({ gameId: game.id, platform: "ps2", name: basename(romPath), path: romPath, size: disc.byteLength, hashes: { sha1: sha1(disc), sha256: sha256(disc) }, source: "upload" });
  const way = updateWay(insertWay({ gameId: game.id, planId: plan.id, status: "ready" }).id, { contentId: file.id })!;
  return { game, plan, way };
}
async function build(wayId: number): Promise<JobRow> {
  const j = enqueueJob({ kind: "assemble", wayId }, { gameId: getWay(wayId)!.game_id });
  await runJob(j.id);
  return stmts.jobById.get(j.id) as JobRow;
}
const pkgOf = (gameId: number) => stmts.packageForGame.get(gameId) as PackageRow | null;

let cfg: ReturnType<typeof tempConfig>;
beforeAll(() => { cfg = tempConfig(); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  layout = out => { writeFileSync(join(out, "emu.exe"), bytes(200_000, 3)); };
  other = null;
  pdeps.log = () => {};
  pdeps.tools = () => ({ ...tools7z });
  sbdeps.platform = () => "win32";
  sbdeps.exec = fake7z({ [EMU]: out => layout(out) }, { other: c => other?.(c) ?? null });
  releaseHost({ [EMU_URL]: SEVEN });
  prdeps.latestRelease = async () => ({ tag: "v1.0", name: "v1.0", date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: EMU, url: EMU_URL, size: SEVEN.byteLength, digest: `sha256:${sha256(SEVEN)}` } }) as any;
  adeps.contentFromPackage = async () => null;
});
afterEach(() => { restoreDeps(); delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

describe("the placed game file's path goes into argv as it is (ways-build-1)", () => {
  for (const place of ["games/a$$b/{name}", "games/x$&y/{name}", "games/it$'s/{name}", "games/q$`r/{name}"]) {
    test(`place ${place}`, async () => {
      const f = fixture(emuSpec(place));
      const job = await build(f.way.id);
      expect(job.state).toBe("done");
      const pkg = pkgOf(f.game.id)!, m = JSON.parse(pkg.manifest_json);
      const placed = place.replace("{name}", "God_of_War_II_USA.iso");
      expect(m.launch.argv).toEqual(["-batch", "--", `{install}/${placed}`]);
      expect(existsSync(join(pkg.path, ...placed.split("/")))).toBe(true);
    });
  }

  test("a setup step gets the game file's real path too", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    let seen: { arg: string; there: boolean } | null = null;
    other = c => { if (c[0] === "mytool") { seen = { arg: c[1], there: existsSync(c[1]) }; return ok(); } return null; };
    const f = fixture(emuSpec("games/a$$b/{name}", { setup: [{ run: { exe: "mytool", argv: ["{content}"], wine: false, timeoutSec: 60 } }] }));
    expect((await build(f.way.id)).state).toBe("done");
    expect(seen).not.toBeNull();
    expect(seen!.arg.replace(/\\/g, "/")).toEndWith("/games/a$$b/God_of_War_II_USA.iso");
    expect(seen!.there).toBe(true);
  });
});

describe("a program file no launcher would install fails the build (ways-api-10, e2e-3)", () => {
  // a name that is legal on the server and refused on every player's PC: a ':' on Linux; on Windows a folder made only
  // of dots (only a \\?\ path can make one there)
  const bad = process.platform === "win32" ? "data/.../readme.txt" : "data/a:b.txt";
  const withBadName = (out: string) => {
    writeFileSync(join(out, "emu.exe"), bytes(200_000, 3));
    if (process.platform === "win32") {
      const long = BS + BS + "?" + BS + join(out, "data", "...");
      mkdirSync(long, { recursive: true });
      writeFileSync(long + BS + "readme.txt", "read me");
    } else { mkdirSync(join(out, "data"), { recursive: true }); writeFileSync(join(out, "data", "a:b.txt"), "read me"); }
  };

  test("a plan's remove step can still take such a file out, and the build goes on", async () => {
    layout = withBadName;
    const f = fixture(emuSpec("games/{name}", { setup: [{ remove: "data/**" }] }));
    const job = await build(f.way.id);
    expect([job.state, job.message]).toEqual(["done", expect.stringContaining("built:")]);
    const m = JSON.parse(pkgOf(f.game.id)!.manifest_json);
    expect(m.files.map((x: { path: string }) => x.path).filter((p: string) => p.startsWith("data/"))).toEqual([]);
  });

  test("the build names the file and the game keeps what it had", async () => {
    layout = withBadName;
    const f = fixture(emuSpec("games/{name}"));
    const job = await build(f.way.id);
    expect(job.state).toBe("failed");
    expect(job.message).toContain(`the package would hold ${JSON.stringify(bad)}, which`);
    expect(job.message).toContain("no player's PC could install it");
    expect(pkgOf(f.game.id)).toBeNull();
    expect(getWay(f.way.id)).toMatchObject({ status: "failed", package_id: null });
  });
});

describe("the manifest seeds what the plan keeps (launcher-1)", () => {
  test("a kept settings file the package also ships is seeded, so no launcher resets the player's edits", async () => {
    layout = out => {
      writeFileSync(join(out, "emu.exe"), bytes(200_000, 3));
      mkdirSync(join(out, "User", "Config"), { recursive: true });
      writeFileSync(join(out, "User", "Config", "Dolphin.ini"), "[Interface]\nShowAnalytics=False\n");
    };
    const f = fixture(emuSpec("games/{name}", { keep: ["User/**"], seed: ["portable.txt"], files: [{ path: "portable.txt", text: "" }] }));
    expect((await build(f.way.id)).state).toBe("done");
    const m = JSON.parse(pkgOf(f.game.id)!.manifest_json);
    expect(m.files.map((x: { path: string }) => x.path)).toContain("User/Config/Dolphin.ini");
    expect(m).toMatchObject({ keep: ["User/**"], seed: ["portable.txt", "User/**"] });
  });
});
