/**
 * A recipe for every console (src/ways/recipes.ts): which emulator plays which console, that the plan ludarr's own list
 * makes for each is a whole, valid plan (or says why it is not made by itself), and the way a game gets through it with no
 * click — an emulator plan that is ready is taken, else the recipe's is made by a construct job from the list, never by
 * the AI; a recipe that failed waits a day, a plan the admin removed stays removed. (The construct job itself, with a
 * fake release, is in tests/ways-construct.test.ts; that a search waits for the emulator in tests/requests.test.ts.)
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { EMULATORS } from "../src/catalog/providers/emulators";
import { PLATFORM_LABEL, type PlatformId } from "../src/platforms";
import { addWay, atdeps } from "../src/ways/attach";
import { automaticProblem, needsTitleReport } from "../src/ways/emulator-scope";
import { researchDeps, researchEmulator } from "../src/ways/emulator-research";
import { requestWay } from "../src/ways/find";
import { startRun } from "../src/ways/carry";
import { kytyPlan, kytyUpgraded } from "./carry-world";
import { step0For } from "../src/ways/construct";
import { ensureWay, ensureWaysOfCopies, ownRecipe, planRepoOf, rcdeps, recipeFor, RECIPE_FOR } from "../src/ways/recipes";
import { getPlan, getWay, insertPlan, insertWay, planSpec, updatePlan, waysOfGame, type PlanRow } from "../src/ways/store";
import type { RuntimePlanSpec } from "../src/ways/types";
import { CONTENT_PLATFORMS, validatePlanSpec } from "../src/ways/validate";

const saved = { ...rcdeps }, savedAt = { ...atdeps };
const wipe = "DELETE FROM carry_runs; DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans; DELETE FROM requests; DELETE FROM games;";
let seq = 0, started: number[] = [], clock = Date.now();
afterAll(() => { Object.assign(rcdeps, saved); Object.assign(atdeps, savedAt); db.exec(wipe); });
beforeEach(() => {
  process.env.LUDARR_CONFIG = mkdtempSync(join(tmpdir(), "ludarr-recipes-"));
  db.exec(wipe);
  Object.assign(rcdeps, saved);
  started = []; clock = Date.now();
  rcdeps.startRun = async wayId => { started.push(wayId); };
  rcdeps.now = () => clock;
  rcdeps.research = async g => ({ reason: `No verified build for ${g.name}.` });
  atdeps.loadDat = async () => null;                                       // a new way fetches its console's dump list in the background: not here
});

function game(name: string, platforms: string[]): GameRow {
  const g = upsertGame({ steam_appid: 985_000 + ++seq, name, slug: `recipes-${seq}` }) as GameRow;
  db.query("UPDATE games SET platforms_json=? WHERE id=?").run(JSON.stringify(platforms), g.id);
  return stmts.gameById.get(g.id) as GameRow;
}
/** the plan the list makes for a console, saved as a construct job would save it */
function planFor(platform: PlatformId, o: { status?: "ready" | "draft"; author?: "user" | "ai" } = {}): PlanRow {
  const e = recipeFor(platform)!;
  const st = step0For(e.repo!, null, platform)!;
  const v = validatePlanSpec(st.spec, "emulator");
  return insertPlan({ name: st.name, kind: "emulator", repo: st.repo, platforms: [platform], spec: v.value as RuntimePlanSpec, status: o.status ?? "ready", author: o.author ?? "user" });
}
const jobs = () => (db.query("SELECT * FROM jobs WHERE kind='construct' ORDER BY id").all() as JobRow[]).map(j => ({ id: j.id, state: j.state, spec: JSON.parse(j.spec_json ?? "null") }));

/** the consoles whose emulator ludarr sets up with no one's help */
const BY_ITSELF: PlatformId[] = ["ps1", "ps2", "psp", "gc", "wii", "wiiu", "switch", "3ds", "nds", "n64", "snes", "nes", "gba", "gbc", "gb", "xbox", "x360", "dc", "saturn", "genesis", "arcade"];

describe("a recipe for every console", () => {
  test("each console names an emulator that plays it, and a game file of that console can be kept", () => {
    for (const [platform, id] of Object.entries(RECIPE_FOR) as [PlatformId, string][]) {
      const e = EMULATORS.find(x => x.id === id);
      expect([platform, !!e, e?.platforms.includes(platform as never)]).toEqual([platform, true, true]);
      expect([platform, CONTENT_PLATFORMS.includes(platform)]).toEqual([platform, true]);
      expect(recipeFor(platform)?.id).toBe(id);
    }
    // every console with a working emulator has one; these have none that plays a game handed to it
    for (const p of ["ps5", "vita", "xone", "xsx"] as PlatformId[]) expect(recipeFor(p)).toBeNull();
    expect(recipeFor(null)).toBeNull();
    expect(Object.keys(RECIPE_FOR).sort()).toEqual([...BY_ITSELF, "ps3", "ps4"].sort());
  });

  test("the plan made for each: whole and valid, for that console, the game handed over on the command line, its saves kept, nothing asked of the AI", () => {
    for (const platform of BY_ITSELF) {
      const e = recipeFor(platform)!;
      const st = step0For(e.repo!, null, platform)!;
      expect([platform, st.missing, st.refused]).toEqual([platform, [], null]);
      const v = validatePlanSpec(st.spec, "emulator");
      expect([platform, v.errors]).toEqual([platform, []]);
      const spec = v.value!;
      expect([platform, spec.content?.platform]).toEqual([platform, platform]);
      expect([platform, spec.content!.accept.hashes]).toEqual([platform, []]);
      expect([platform, (spec.content!.accept.formats ?? []).length > 0]).toEqual([platform, true]);
      expect([platform, spec.launch.argv.some(a => a.includes("{content}"))]).toEqual([platform, true]);
      expect([platform, /\.exe$/.test(spec.launch.exe)]).toEqual([platform, true]);
      expect([platform, spec.keep.length > 0]).toEqual([platform, true]);
      // a settings file the plan ships and the program rewrites is never reset by the launcher
      // (shipped as a file of the plan, as a need's file, or written by a setup step)
      for (const s of spec.seed) expect([platform, s, spec.files.some(f => f.path === s) || spec.needs.some(n => n.place === s) || spec.setup.some(x => "ini" in x && x.ini.path === s)]).toEqual([platform, s, true]);
      // every need has a place, and nothing is run on the server but PCSX2's own settings writer
      for (const n of spec.needs) expect([platform, n.name, !!n.place]).toEqual([platform, n.name, true]);
      expect([platform, spec.setup.filter(s => "run" in s).length]).toEqual([platform, platform === "ps2" ? 1 : 0]);
      expect(st.name).toBe(e.platforms.length > 1 ? `${e.name} (${PLATFORM_LABEL[platform]})` : e.name);
    }
  });

  test("what each still needs from the admin, once: a BIOS, keys", () => {
    const needs = (p: PlatformId) => (step0For(recipeFor(p)!.repo!, null, p)!.spec as unknown as RuntimePlanSpec).needs.map(n => [n.kind, n.place]);
    expect(needs("ps1")).toEqual([["bios", "bios/ps1-bios.bin"]]);
    expect(needs("ps2")).toEqual([["bios", "bios/ps2-bios.bin"]]);
    expect(needs("saturn")).toEqual([["bios", "profile/roms/ipl/saturn-bios.bin"]]);
    expect(needs("switch")).toEqual([["keys", "user/keys/prod.keys"]]);
    expect(needs("wiiu")).toEqual([["keys", "portable/keys.txt"]]);
    expect(needs("xbox")).toEqual([["bios", "system/mcpx_1.0.bin"], ["bios", "system/bios.bin"], ["other", "system/xbox_hdd.qcow2"]]);
    for (const p of ["psp", "gc", "wii", "3ds", "nds", "n64", "snes", "nes", "gba", "gbc", "gb", "x360", "dc", "genesis", "arcade"] as PlatformId[]) expect([p, needs(p)]).toEqual([p, []]);
    // the Xbox boot ROM is the one dump that works: its size and hash are checked
    const mcpx = (step0For("xemu-project/xemu", null, "xbox")!.spec as unknown as RuntimePlanSpec).needs[0];
    expect(mcpx.accept).toEqual({ sizes: [512], hashes: [{ algo: "md5", value: "d49c52a4102f6df7bcf8d0617ac475ed", label: "mcpx_1.0.bin" }] });
  });

  test("an emulator of several consoles is made for the one asked for; one it does not play is refused", () => {
    const snes = step0For("ares-emulator/ares", null, "snes")!, md = step0For("ares-emulator/ares", null, "genesis")!;
    expect((snes.spec.launch as { argv: string[] }).argv).toEqual(["--kiosk", "--fullscreen", "--setting", "Paths/Saves={install}/saves/", "--system", "Super Famicom", "{content}"]);
    expect((md.spec.launch as { argv: string[] }).argv).toContain("Mega Drive");
    expect((snes.spec.content as { accept: { formats: string[] } }).accept.formats).toEqual(["sfc", "smc"]);
    expect((md.spec.content as { accept: { formats: string[] } }).accept.formats).toEqual(["md", "gen", "bin"]);
    expect(step0For("mgba-emu/mgba", null, "gbc")!.name).toBe("mGBA (Game Boy Color)");
    expect(step0For("dolphin:beta", null, "wii")!.platforms).toEqual(["wii"]);
    // the console that was asked for wins over the game's first (an arcade game that also came out on the Mega Drive)
    const g = game("Golden Axe", ["Arcade", "genesis"]);
    expect(step0For("mamedev/mame", g, "arcade")!).toMatchObject({ platforms: ["arcade"], refused: null, missing: [] });
    expect(step0For("mamedev/mame", g, "genesis")!.refused).toBe("MAME plays Arcade games, not Mega Drive ones");
    // an arcade game's file is a ROM set, placed where MAME is told to look, under its own name
    expect(step0For("mamedev/mame", g, "arcade")!.spec.content).toMatchObject({ kind: "rom", platform: "arcade", place: "roms/{name}", accept: { hashes: [], formats: ["zip", "7z"] } });
    expect((step0For("mamedev/mame", g, "arcade")!.spec.launch as { argv: string[] }).argv).toEqual(["{content}", "-rompath", "{install}/roms", "-skip_gameinfo"]);
  });

  test("the ones ludarr does not set up by itself say why", () => {
    expect(step0For("RPCS3/rpcs3-binaries-win", null, "ps3")!.missing.join(" ")).toMatch(/system software has to be installed into it once/);
    expect(step0For("shadps4-emu/shadPS4", null, "ps4")!.missing.join(" ")).toMatch(/comes as a package it no longer installs/);
  });

  test("a plan from the list is ludarr's own recipe; one the AI wrote, or a recomp, is not", () => {
    expect(ownRecipe({ kind: "emulator", author: "user", repo: "ares-emulator/ares" })).toBe(true);
    expect(ownRecipe({ kind: "emulator", author: "user", repo: "Dolphin-Emu/Dolphin" })).toBe(true);     // its builds come from a feed; its plan names the repo
    expect(ownRecipe({ kind: "emulator", author: "ai", repo: "ares-emulator/ares" })).toBe(false);
    expect(ownRecipe({ kind: "emulator", author: "user", repo: "someone/their-emulator" })).toBe(false);
    expect(ownRecipe({ kind: "recomp", author: "user", repo: "Zelda64Recomp/Zelda64Recomp" })).toBe(false);
    expect(planRepoOf(EMULATORS.find(e => e.id === "dolphin")!)).toBe("dolphin-emu/dolphin");
  });
});

describe("the way a game gets by itself", () => {
  test("a ready plan for the console: the game gets its way through it at once, and its carry run starts", async () => {
    const plan = planFor("n64");
    const g = game("Mario Kart 64", ["n64"]);
    const r = await ensureWay(g, "n64");
    expect(r).toMatchObject({ state: "there", made: true });
    const way = getWay((r as { wayId: number }).wayId)!;
    expect(way).toMatchObject({ game_id: g.id, plan_id: plan.id });
    expect(JSON.parse(way.content_json!)).toMatchObject({ platform: "n64", what: "Mario Kart 64 (Nintendo 64)", search: ["Mario Kart 64"] });
    expect(started).toEqual([way.id]);
    expect(jobs()).toEqual([]);                                             // nothing to set up
    // asked again: the way is there, nothing is added or started twice
    expect(await ensureWay(g, "n64")).toEqual({ state: "there", wayId: way.id, made: false });
    expect(waysOfGame(g.id)).toHaveLength(1);
    expect(started).toEqual([way.id]);
  });

  test("a generic PS5 emulator needs a title report for its own repository", async () => {
    const theirs = insertPlan({ name: "Their PS5 emulator", kind: "emulator", repo: "someone/ps5emu", platforms: ["ps5"], status: "ready", author: "ai",
      spec: { program: { kind: "release", assetPattern: "win64\\.zip$", channel: "stable" }, launch: { exe: "emu.exe", argv: ["{content}"] }, content: { kind: "folder", platform: "ps5", what: "a PS5 game", search: ["PlayStation 5"], accept: { hashes: [] }, marker: "sce_sys/param.json", place: "game" }, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" } });
    const g = game("Astro's Playroom", ["PS5"]);
    expect((await ensureWay(g, "ps5")).state).toBe("none");
    expect(waysOfGame(g.id)).toHaveLength(0);
    clock += 86_401_000;
    rcdeps.research = async () => ({ repo: theirs.repo, reason: "upstream reports playable" });
    const r = await ensureWay(g, "ps5");
    expect(r).toMatchObject({ state: "there", made: true });
    expect(getWay((r as { wayId: number }).wayId)!.plan_id).toBe(theirs.id);
  });

  test("a Demon's Souls plan never adopts Astro Bot, including a legacy way whose display name was overwritten", async () => {
    const p = insertPlan({ name: "KytyPS5", kind: "emulator", repo: "chenxiao07/KytyPS5", platforms: ["ps5"], status: "ready",
      spec: { ...kytyPlan(), content: kytyUpgraded() } });
    const astro = game("Astro Bot", ["PS5"]);
    const stale = insertWay({ gameId: astro.id, planId: p.id, content: { ...kytyUpgraded(), search: ["Astro Bot"] } });
    expect((await ensureWay(astro, "ps5")).state).toBe("none");
    expect(requestWay(astro)).toBeNull();
    expect(() => startRun({ wayId: stale.id, by: "backfill" })).toThrow(/Demon's Souls/);
    expect(await addWay(astro, p, { force: true })).toMatchObject({ wrongGame: true });
    expect(jobs()).toEqual([]);
    expect(started).toEqual([]);
    expect((await ensureWay(game("Demon's Souls", ["PS5"]), "ps5")).state).toBe("there");
  });

  test("experimental console generations research each title once and never borrow another title's job", async () => {
    let calls = 0;
    rcdeps.research = async () => { calls++; return { repo: "tested/emu", reason: "tested build", assetUrl: "https://github.com/tested/emu/releases/download/v1/win64.zip" }; };
    for (const p of ["ps5", "switch", "switch2", "xbox", "x360", "xone", "xsx"] as const) {
      expect(needsTitleReport(p)).toBe(true);
      const g = game("Title " + p, [p]);
      const [a,b] = await Promise.all([ensureWay(g, p), ensureWay(g, p)]);
      expect(a).toEqual(b);
      expect(a.state).toBe("waiting");
      expect(await ensureWay(g, p)).toEqual(a);
    }
    expect(calls).toBe(7);
    expect(jobs()).toHaveLength(7);
    expect(jobs().every(j => j.spec.titleResearch && j.spec.assetUrl && !j.spec.listOnly)).toBe(true);
  });

  test("a legacy generic experimental way needs title evidence before a request can use it", () => {
    const p = planFor("switch"), g = game("Metroid Prime Remastered", ["switch"]);
    const way = insertWay({ gameId: g.id, planId: p.id, automatic: true });
    expect(automaticProblem(p, way)).toMatch(/compatibility report/);
    expect(requestWay(g)).toBeNull();
  });

  test("a named Windows release can be selected only for the reported title, with its exact asset", async () => {
    const original = { ...researchDeps };
    const g = game("Astro Bot", ["PS5"]), name = "somefork/KytyPS5-AstroBot", link = "https://github.com/" + name;
    let notes = "Astro Bot is playable on Windows.";
    researchDeps.catalog = () => null;
    researchDeps.json = async url => url.includes("/search/") ? { items: [{ full_name: name }] } :
      url.endsWith("/readme") ? {} : url.includes("/releases?") ? [{ name: "v1", html_url: link + "/releases/tag/v1", body: notes,
        assets: [{ name: "win64.zip", browser_download_url: link + "/releases/download/v1/win64.zip" }] }] :
      { full_name: name, parent: { full_name: "Jetsku/KytyPS5" } };
    try {
      expect(await researchEmulator(g, "ps5")).toMatchObject({ repo: name, assetUrl: link + "/releases/download/v1/win64.zip" });
      notes = "Super Astro Bot is playable on Windows.";
      expect((await researchEmulator(g, "ps5")).repo).toBeUndefined();
      notes = "Astro Bot is playable on Windows. Untested preview.";
      expect((await researchEmulator(g, "ps5")).repo).toBeUndefined();
    } finally { Object.assign(researchDeps, original); }
  });

  test("no plan yet: the recipe's is made by a construct job from the list alone, for that console and this game; everyone else waits on the same job", async () => {
    const mvc = game("Marvel vs. Capcom: Clash of Super Heroes", ["Arcade", "PS3", "X360", "DC"]);
    const r = await ensureWay(mvc, "arcade");
    expect(r).toMatchObject({ state: "waiting", emulator: "MAME" });
    expect(jobs()).toEqual([{ id: (r as { jobId: number }).jobId, state: "queued", spec: { kind: "construct", repo: "mamedev/mame", gameId: mvc.id, platform: "arcade", listOnly: true } }]);
    expect(started).toEqual([]);
    // the same game again, and another arcade game: the one job is waited for
    expect(await ensureWay(mvc, "arcade")).toEqual(r);
    expect(await ensureWay(game("Metal Slug", ["Arcade"]), "arcade")).toEqual(r);
    expect(jobs()).toHaveLength(1);
    // another console of the same game is another recipe
    const dc = await ensureWay(mvc, "dc");
    expect(dc).toMatchObject({ state: "waiting", emulator: "Flycast" });
    expect(jobs().map(j => j.spec.repo)).toEqual(["mamedev/mame", "flyinghead/flycast"]);
    // a job that has waited in the queue for twenty minutes is no longer waited for (the search goes on without it)
    clock += 21 * 60_000;
    expect(await ensureWay(mvc, "arcade")).toEqual({ state: "none", why: "MAME is still being set up" });
    expect(jobs()).toHaveLength(2);
  });

  test("a recipe that could not be set up is left alone for a day, for every game; then it is tried again", async () => {
    const g = game("Crazy Taxi", ["dc"]);
    const first = await ensureWay(g, "dc") as { jobId: number };
    db.query("UPDATE jobs SET state='failed', message=?, done_at=? WHERE id=?").run("the plan's asset pattern picks nothing in v2.7", Math.floor(clock / 1000), first.jobId);
    const again = await ensureWay(g, "dc");
    expect(again).toEqual({ state: "none", why: "Flycast could not be set up (the plan's asset pattern picks nothing in v2.7): it is tried again in a day" });
    expect((await ensureWay(game("Shenmue", ["dc"]), "dc")).state).toBe("none");
    expect(jobs()).toHaveLength(1);
    clock += 25 * 3600_000;
    expect(await ensureWay(g, "dc")).toMatchObject({ state: "waiting", emulator: "Flycast" });
    expect(jobs()).toHaveLength(2);
  });

  test("a plan the admin removed is not made again, and one that is not ready is theirs to look at", async () => {
    const g = game("Jet Set Radio", ["dc"]);
    const first = await ensureWay(g, "dc") as { jobId: number };
    db.query("UPDATE jobs SET state='done', done_at=? WHERE id=?").run(Math.floor(clock / 1000), first.jobId);     // made, and its plan removed since
    clock += 40 * 86_400_000;
    expect(await ensureWay(g, "dc")).toEqual({ state: "none", why: "Flycast was set up before, and its plan is gone: it is not made again by itself" });
    expect(jobs()).toHaveLength(1);
    const draft = planFor("psp", { status: "draft" });
    updatePlan(draft.id, { statusNote: "its release has no Windows file" });
    expect(await ensureWay(game("Lumines", ["psp"]), "psp")).toEqual({ state: "none", why: "PPSSPP is draft (its release has no Windows file)" });
    expect(jobs()).toHaveLength(1);
  });

  test("a console without a recipe, and one ludarr does not set up by itself: nothing is queued", async () => {
    expect(await ensureWay(game("Halo 5", ["xone"]), "xone")).toEqual({ state: "none", why: "No verified build for Halo 5." });
    const ps3 = await ensureWay(game("God of War III", ["ps3"]), "ps3");
    expect(ps3.state).toBe("none");
    expect((ps3 as { why: string }).why).toMatch(/^RPCS3 is not set up by ludarr itself \(.*installed into it once.*\): make its plan on the Ways page$/);
    expect(jobs()).toEqual([]);
  });

  test("the games fetched before there was a recipe: a console copy with no way of its console gets one", async () => {
    const plan = planFor("snes");
    const smw = game("Super Mario World", ["snes"]), pc = game("Hades", ["win"]), none = game("Halo 5", ["xone"]);
    const pkg = (g: GameRow, manifest: object) => db.query("INSERT INTO packages (game_id, path, name, manifest_json) VALUES (?, ?, ?, ?)").run(g.id, `/library/${g.slug}`, g.name, JSON.stringify(manifest));
    pkg(smw, { kind: "rom", platform: "snes" });
    pkg(pc, { kind: "native" });
    pkg(none, { kind: "rom", platform: "xone" });
    expect(await ensureWaysOfCopies()).toBe(1);
    expect(waysOfGame(smw.id).map(w => w.plan_id)).toEqual([plan.id]);
    expect(waysOfGame(pc.id)).toEqual([]);
    expect(waysOfGame(none.id)).toEqual([]);
    expect(await ensureWaysOfCopies()).toBe(0);                             // nothing left to do
    expect(planSpec(getPlan(plan.id)!).launch.argv).toContain("Super Famicom");
  });
});
