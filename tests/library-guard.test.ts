/**
 * The library's one-game-per-game guard and what a delete stops:
 *  - a store add (and a lookup hit) of a game already in the library by another route — added by hand and linked to the
 *    store's catalog title — is that game, never a second one; renamed to another game, it lets that title go, so the
 *    store's game is a game of its own again;
 *  - two adds of the same hand-made game at once, each fetching its poster, give one game;
 *  - names in any script are kept as other names and caught by the guard (normName keeps only a–z and 0–9);
 *  - deleting a game stops its builds, file intakes and imports (the admin's own included), so none of them leaves a
 *    package behind or fails on the game that is gone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { addGame, deleteGame, lookup, nameKey } from "../src/library/games";
import { gamesApi } from "../src/api/games";
import { normName } from "../src/catalog/store";
import { cdeps } from "../src/catalog/worker";
import { ndeps } from "../src/net/public-url";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import { adeps } from "../src/ways/assemble";
import { insertContent, insertPlan, insertWay, updateWay } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import { enqueueJob } from "../src/process/kinds";
import { rdeps as importDeps, runJob } from "../src/process/runner";
import { activityApi } from "../src/api/activity";
import { recipes } from "../src/plugins/builtin/importers";
import { reingestCustom } from "../src/catalog/providers/custom";
import { pdeps } from "../src/process/deps";
import { sbdeps } from "../src/ways/sandbox";
import { prdeps } from "../src/ways/program";
import { bytes, fake7z, ok, restoreDeps, sha1, sha256, tempConfig, tmp, tools7z, zelda } from "./ways-fixtures";

const saved = { sources: cdeps.sources, fetch: globalThis.fetch, ndeps: { ...ndeps }, adeps: { ...adeps } };
const clean = () => db.exec("DELETE FROM requests; DELETE FROM follows; DELETE FROM jobs; DELETE FROM packages; DELETE FROM games; DELETE FROM routes; DELETE FROM title_names; DELETE FROM title_ids; DELETE FROM titles");
afterAll(() => {
  cdeps.sources = saved.sources; globalThis.fetch = saved.fetch; Object.assign(ndeps, saved.ndeps); Object.assign(adeps, saved.adeps);
  clean();
  db.exec("DELETE FROM plugin_instances WHERE kind='metadata'");
  registry.clearCache();
});
/** the store answers for Hades only, and every call is counted (a store add of a game already in the library asks nothing) */
let storeCalls = 0;
beforeEach(() => {
  process.env.LUDARR_CONFIG = mkdtempSync(join(tmpdir(), "ludarr-guard-"));
  clean();
  db.exec("DELETE FROM plugin_instances WHERE kind='metadata'");
  registry.clearCache();
  cdeps.sources = saved.sources;
  storeCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    storeCalls++;
    const u = String(url);
    if (u.includes("/api/storesearch/")) return Response.json({ total: 1, items: [{ id: 1145360, name: "Hades", tiny_image: "https://x/t.jpg" }] });
    if (u.includes("/api/appdetails")) return Response.json({ "1145360": { success: true, data: { type: "game", steam_appid: 1145360, name: "Hades", header_image: null, release_date: { coming_soon: false, date: "17 Sep, 2020" }, platforms: { windows: true, mac: true, linux: false } } } });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
});

const post = (body: unknown) => gamesApi.request("/api/v1/game", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (path: string, body: unknown) => gamesApi.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const item = async (r: Response) => ((await r.json()) as { item: any }).item;
/** a catalog title of that name and year carrying a store id, as that store's source makes it (its rank is above the
 *  custom source's, so the custom source never takes the title over), from an active source when `active` */
function storeTitle(name: string, year: number, scheme: "steam" | "igdb", value: string, active = true) {
  const id = (db.query("INSERT INTO titles (slug, name, sort_name, year, platforms_json, meta_source, meta_rank) VALUES (?,?,?,?,'[\"pc\"]',?,?) RETURNING id")
    .get(`${normName(name).replace(/ /g, "-")}-${value}`, name, normName(name), year, scheme, scheme === "steam" ? 80 : 90) as { id: number }).id;
  db.query("INSERT INTO title_names (norm, title_id) VALUES (?,?)").run(normName(name), id);
  db.query("INSERT INTO title_ids (scheme, value, title_id, source) VALUES (?,?,?,?)").run(scheme, value, id, scheme);
  db.query("INSERT INTO routes (title_id, kind, platform, provenance, source, source_key) VALUES (?, 'native', 'pc', 'retail', 'steam', ?)").run(id, `steam:${value}`);
  if (active) cdeps.sources = () => [{ id: 1, name: "Steam", source: { id: "steam", label: "Steam", about: "", every: 60, metaRank: 80, collect: async () => [] } as never }];
  return id;
}
const games = () => stmts.allGames.all() as GameRow[];

describe("a game added by hand is the store's game once linked to the store's title", () => {
  test("lookup offers no store hit for it, and a store add of it is the same game", async () => {
    const t = storeTitle("Hades", 2020, "steam", "1145360");
    const manual = await item(await post({ source: "manual", monitored: false, game: { name: "Hades", year: 2020 } }));
    expect(manual.titleId).toBe(t);
    const hits = await lookup("hades");
    expect(hits.filter(h => h.gameId === null).map(h => `${h.id.scheme}:${h.id.value}`)).toEqual([]);
    expect(hits.filter(h => h.gameId === manual.id)).toHaveLength(1);
    // what Ahoy's Request sends for a store hit
    storeCalls = 0;
    const res = await post({ source: "steam", id: "1145360", monitored: true, searchNow: false });
    expect(res.status).toBe(201);
    expect((await item(res)).id).toBe(manual.id);
    expect(games().map(g => `${g.name}:${g.source}`)).toEqual(["Hades:manual"]);
    expect(storeCalls).toBe(0);
  });
  test("the store's own search hit folds in too, even when the catalog source that holds the title is off", async () => {
    // the built-in Steam source answers the lookup through the store search; the catalog shows nothing
    for (const p of BUILTIN) registry.registerPlugin(p, "builtin");
    registry.ensureSingletons();
    storeTitle("Hades", 2020, "steam", "1145360", false);
    cdeps.sources = () => [];
    const manual = await addGame({ source: "manual", monitored: false, game: { name: "Hades", year: 2020 } });
    expect(manual.titleId).not.toBeNull();
    storeCalls = 0;
    const hits = await lookup("hades");
    expect(storeCalls).toBe(1);                                       // the store was asked
    expect(hits.some(h => h.id.scheme === "steam" && h.id.value === "1145360" && h.gameId === null)).toBe(false);
    expect(hits.filter(h => h.gameId === manual.id)).toHaveLength(1);
  });
  test("an IGDB add of a title a hand-made game holds is that game (IGDB need not even be set up)", async () => {
    storeTitle("Dinosaur Planet", 2000, "igdb", "26758");
    const manual = await addGame({ source: "manual", monitored: false, game: { name: "Dinosaur Planet", year: 2000 } });
    const again = await addGame({ source: "igdb", id: 26758, searchNow: false, monitored: false });
    expect(again.id).toBe(manual.id);
    expect(games()).toHaveLength(1);
  });
  test("renamed to another game, it lets the store's title go: the store's game is then a game of its own", async () => {
    const t = storeTitle("Hades", 2020, "steam", "1145360");
    const manual = await item(await post({ source: "manual", monitored: false, game: { name: "Hades", year: 2020 } }));
    expect(manual.titleId).toBe(t);
    // the admin typed the wrong game and renames it to the one they meant
    const r = await put(`/api/v1/game/${manual.id}/details`, { name: "Hadean Lands", year: 2014 });
    expect(r.status).toBe(200);
    expect((await item(r)).titleId).toBeNull();
    expect(db.query("SELECT game_id FROM titles WHERE id=?").get(t)).toEqual({ game_id: null });
    expect((await lookup("hades")).filter(h => h.id.scheme === "steam").map(h => h.gameId)).toEqual([null]);
    // what Ahoy's Request sends for the store's Hades: a game of its own, never the renamed one switched to monitored
    const res = await post({ source: "steam", id: "1145360", monitored: true, searchNow: false });
    expect(res.status).toBe(201);
    expect((await item(res)).id).not.toBe(manual.id);
    expect(games().map(g => `${g.name}:${g.source}:${g.monitored}`).sort()).toEqual(["Hadean Lands:manual:0", "Hades:steam:1"]);
  });
  test("a change that keeps its name and year near keeps the link, and a name that is now a title's links that one", async () => {
    const t = storeTitle("Hades", 2020, "steam", "1145360");
    const manual = await addGame({ source: "manual", monitored: false, game: { name: "Hades", year: 2020 } });
    expect((await item(await put(`/api/v1/game/${manual.id}/details`, { year: 2021 }))).titleId).toBe(t);
    expect((await item(await put(`/api/v1/game/${manual.id}/details`, { name: "HADES", year: 2020 }))).titleId).toBe(t);
    const c = storeTitle("Celeste", 2018, "steam", "504230");
    const typo = await addGame({ source: "manual", monitored: false, game: { name: "Celest", year: 2018 } });
    expect(typo.titleId).toBeNull();
    expect((await item(await put(`/api/v1/game/${typo.id}/details`, { name: "Celeste" }))).titleId).toBe(c);
    expect((await addGame({ source: "steam", id: 504230, searchNow: false, monitored: false })).id).toBe(typo.id);
  });
  test("with ways to play, the custom source's next run does not link the old title again", async () => {
    const t = storeTitle("Hades", 2020, "steam", "1145360");
    const manual = await addGame({ source: "manual", monitored: false, game: { name: "Hades", year: 2020 } });
    const spec = validatePlanSpec({ program: { kind: "release", assetPattern: "^Hades-.*[.]zip$", channel: "stable" }, launch: { exe: "Hades.exe", argv: [] }, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" }, "port").value!;
    const plan = insertPlan({ name: "Guard rename port", kind: "port", repo: "someone/guard-rename-port", platforms: [], spec, status: "ready" });
    try {
      const way = insertWay({ gameId: manual.id, planId: plan.id, status: "ready" });
      const routeTitle = () => (db.query("SELECT title_id FROM routes WHERE source='custom' AND source_key=?").get(`way:${way.id}`) as { title_id: number } | null)?.title_id;
      reingestCustom();
      expect(routeTitle()).toBe(t);                                       // the way is listed under the store's title
      expect((await put(`/api/v1/game/${manual.id}/details`, { name: "Hadean Lands", year: 2014 })).status).toBe(200);
      reingestCustom();
      const g = stmts.gameById.get(manual.id) as GameRow;
      expect(g.title_id).not.toBeNull();
      expect(g.title_id).not.toBe(t);
      expect(routeTitle()).toBe(g.title_id!);                             // … and now under the renamed game's own title
      expect(db.query("SELECT game_id FROM titles WHERE id=?").get(t)).toEqual({ game_id: null });
      expect((await addGame({ source: "steam", id: 1145360, searchNow: false, monitored: false })).id).not.toBe(manual.id);
    } finally {
      db.query("DELETE FROM runtime_plans WHERE id=?").run(plan.id);
      db.query("DELETE FROM runtimes WHERE id=?").run(`plan:${plan.slug}`);
    }
  });
});

describe("two adds of the same game at once", () => {
  const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
  test("each fetching its poster: one is added, the other is told it is already in the library", async () => {
    ndeps.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    ndeps.fetch = async () => { await Bun.sleep(150); return new Response(PNG, { headers: { "content-type": "image/png" } }); };
    const body = { source: "manual", monitored: false, game: { name: "Hadez", year: 2020 }, posterUrl: "https://art.example.com/p.png" };
    const [a, b] = await Promise.all([post(body), post(body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(games().map(g => g.slug)).toEqual(["hadez"]);
  });
});

describe("names in any script", () => {
  test("for Latin names the key is the catalog's normName: nothing changes for them", () => {
    for (const s of ["The Legend of Zelda™: Majora’s Mask", "Final Fantasy VII", "Pokémon Red", "Hades & Co", "Zelda 64: Recompiled", "Brütal Legend", "Mega Man X", "The"]) expect({ s, key: nameKey(s) }).toEqual({ s, key: normName(s) });
  });
  test("other names without Latin letters are each kept, and spellings of one name are still one", async () => {
    const g = await addGame({ source: "manual", monitored: false, game: { name: "The Witcher 3: Wild Hunt", year: 2015, aliases: ["ウィッチャー3 ワイルドハント", "Ведьмак 3", "Дикая Охота 3", "ВЕДЬМАК 3", "the witcher 3 wild hunt"] } });
    expect(g.aliases).toEqual(["ウィッチャー3 ワイルドハント", "Ведьмак 3", "Дикая Охота 3"]);
    // a mark that makes another letter is another name (ド is not ト); Latin accents are not (Pokémon is Pokemon)
    const k = await addGame({ source: "manual", monitored: false, game: { name: "Pokémon Red", year: 1996, aliases: ["Pokemon Red", "ドラゴン", "トラゴン"] } });
    expect(k.aliases).toEqual(["ドラゴン", "トラゴン"]);
  });
  test("the guard catches a name in another script added twice, and one that another game goes by", async () => {
    for (const name of ["ドラゴンクエスト", "Ведьмак"]) {
      expect((await post({ source: "manual", monitored: false, game: { name, year: 1986 } })).status).toBe(201);
      const again = await post({ source: "manual", monitored: false, game: { name, year: 1986 } });
      expect(again.status).toBe(409);
    }
    await addGame({ source: "manual", monitored: false, game: { name: "The Witcher 3: Wild Hunt", year: 2015, aliases: ["Ведьмак 3: Дикая Охота"] } });
    const res = await post({ source: "manual", monitored: false, game: { name: "ведьмак 3 — дикая охота", year: 2015 } });
    expect(res.status).toBe(409);
    // the digits alone are not the name: another game with a 3 in it is not a duplicate
    expect((await post({ source: "manual", monitored: false, game: { name: "Дикая Охота 3", year: 2015 } })).status).toBe(201);
  });
  test("lookup finds a hand-made game by a name in another script", async () => {
    const g = await addGame({ source: "manual", monitored: false, game: { name: "Ведьмак", year: 2007, aliases: ["ウィッチャー"] } });
    expect((await lookup("ведьмак")).map(h => h.gameId)).toContain(g.id);
    expect((await lookup("ウィッチャー")).map(h => h.gameId)).toContain(g.id);
  });
  test("a name in another script is never linked to a catalog title by its digits alone", async () => {
    const t = db.query("INSERT INTO titles (slug, name, sort_name, year, platforms_json) VALUES ('three','III','3',2015,'[]') RETURNING id").get() as { id: number };
    db.query("INSERT INTO title_names (norm, title_id) VALUES ('3', ?)").run(t.id);
    const g = await addGame({ source: "manual", monitored: false, game: { name: "Ведьмак 3", year: 2015 } });
    expect(g.titleId).toBeNull();
  });
});

describe("deleting a game stops what is being made for it", () => {
  let cfg: ReturnType<typeof tempConfig>;
  beforeAll(() => { cfg = tempConfig(); });
  afterAll(() => { restoreDeps(); cfg.restore(); });

  test("its queued builds and file intakes are cancelled and never start", async () => {
    const g = upsertGame({ steam_appid: 997101, name: "Queued Builds", slug: "queued-builds" }) as GameRow;
    const a = enqueueJob({ kind: "assemble", wayId: 999_001 }, { gameId: g.id });
    const c = enqueueJob({ kind: "content", gameId: g.id, path: "/nowhere/x.z64", wayId: null }, { gameId: g.id });
    await deleteGame(g.id);
    for (const j of [a, c]) expect((stmts.jobById.get(j.id) as JobRow).state).toBe("cancelled");
  });

  /* an import the admin starts by hand (POST /import {path, gameId}) has no request that deleting the game would cancel */
  const savedImporters = importDeps.importers;
  const handImport = async (name: string, year: number, input: string) => {
    ensureDefaultRootFolder();
    pdeps.log = () => {};
    pdeps.tools = () => ({ ...tools7z });
    importDeps.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: recipes.create({}, registry.pluginContext("importers")) }];
    const g = await addGame({ source: "manual", monitored: false, game: { name, year } });
    const res = await activityApi.request("/api/v1/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: input, gameId: g.id }) });
    expect(res.status).toBe(201);
    return { g, job: (await item(res)) as { id: number; state: string } };
  };
  /** a game as a download holds it: its exe and its data */
  const gameFolder = (dir: string, name: string) => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, `${name}.exe`), bytes(2_000_000, 1));
    writeFileSync(join(dir, "data", "level.pak"), bytes(3_000_000, 2));
    writeFileSync(join(dir, "readme.txt"), "enjoy");
  };
  const leftIn = (root: string, prefix: string) => readdirSync(root).filter(n => n.startsWith(prefix));

  test("a hand import queued for it is cancelled and never runs: no package for no game", async () => {
    const input = join(tmp("guard-hand-"), "Queued.Hand.Import-GROUP");
    gameFolder(input, "Queued Hand Import");
    try {
      const { g, job } = await handImport("Queued Hand Import", 2020, input);
      expect(job.state).toBe("queued");
      await deleteGame(g.id, { deleteFiles: true });
      expect((stmts.jobById.get(job.id) as JobRow).state).toBe("cancelled");
      await runJob(job.id);                                              // what the job loop would do with it: nothing
      expect((stmts.jobById.get(job.id) as JobRow).state).toBe("cancelled");
      expect(db.query("SELECT COUNT(*) AS n FROM packages").get()).toEqual({ n: 0 });
      expect(leftIn(rootFolders()[0].path, "queued-hand-import")).toEqual([]);
    } finally { importDeps.importers = savedImporters; }
  });

  test("a hand import running when its game is deleted ends cancelled, and nothing is recorded for the game that is gone", async () => {
    const input = join(tmp("guard-hand-"), "Running.Hand.Import-GROUP");
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "running.hand.import.7z"), bytes(1_000_000, 5));
    // the import sits in its unpack step until the game has been deleted
    let open!: () => void;
    const gate = new Promise<void>(r => (open = r));
    let unpacking = false;
    const savedExec = pdeps.exec;
    pdeps.exec = async (cmd: string[]) => {
      if (cmd[0] === "7z" && cmd[1] === "l") return ok("2026-01-01 00:00:00 ....A   1000   900  Game.exe");
      if (cmd[0] === "7z" && cmd[1] === "x") {
        unpacking = true; await gate;
        const out = cmd.find(a => a.startsWith("-o"))!.slice(2);
        gameFolder(out, "Running Hand Import");
        return ok("Everything is Ok");
      }
      return ok();
    };
    const root = (ensureDefaultRootFolder(), rootFolders()[0].path);
    try {
      const { g, job } = await handImport("Running Hand Import", 2021, input);
      const done = runJob(job.id);
      for (let i = 0; i < 300 && !unpacking; i++) await Bun.sleep(10);
      expect(unpacking).toBe(true);
      await deleteGame(g.id, { deleteFiles: true });
      open();
      // it used to go on and record its failure for the game that is gone: a foreign key error thrown out of the job,
      // which under the job loop (void runJob) is an unhandled rejection, and that ends the process
      await done;
      expect((stmts.jobById.get(job.id) as JobRow).state).toBe("cancelled");
      expect(db.query("SELECT COUNT(*) AS n FROM packages").get()).toEqual({ n: 0 });
    } finally {
      importDeps.importers = savedImporters;
      pdeps.exec = savedExec;
      // a folder moved in before the package row failed is the runner's to remove (src/process/runner.ts finalizePackage)
      for (const n of leftIn(root, "running-hand-import")) rmSync(join(root, n), { recursive: true, force: true });
    }
  });

  test("a build running when its game is deleted ends cancelled and leaves no package folder", async () => {
    const ASSET = "Zelda64Recompiled-v1.2.2-Windows.zip";
    const URL_ = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.2/${ASSET}`;
    const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(4000, 7)]);
    ensureDefaultRootFolder();
    const root = rootFolders()[0];
    pdeps.log = () => {};
    pdeps.tools = () => ({ ...tools7z });
    sbdeps.platform = () => "win32";
    sbdeps.exec = fake7z({ [ASSET]: zelda });
    adeps.contentFromPackage = async () => null;
    // the program download is held until the game has been deleted
    let open!: () => void;
    const gate = new Promise<void>(r => (open = r));
    let fetching = false;
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    ndeps.fetch = async (url: string) => { fetching = true; await gate; return url === URL_ ? new Response(new Uint8Array(ZIP), { headers: { "content-length": String(ZIP.byteLength) } }) : new Response("nope", { status: 404 }); };
    prdeps.latestRelease = async () => ({ tag: "v1.2.2", name: "v1.2.2", date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: ASSET, url: URL_, size: ZIP.byteLength, digest: `sha256:${sha256(ZIP)}` } });

    const game = upsertGame({ steam_appid: 997102, name: "Delete Me Mid Build", slug: "delete-me-mid-build" }) as GameRow;
    const rom = bytes(64 * 1024, 9);
    const romPath = join(tmp("guard-content-"), "Legend of Zelda, The - Majora's Mask (USA).z64");
    writeFileSync(romPath, rom);
    const spec = validatePlanSpec({
      program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "Zelda64Recompiled.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "MM", search: ["The Legend of Zelda: Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha1(rom) }], formats: ["z64"] }, normalize: "n64-z64", place: "mm.z64" },
      files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" }, "recomp").value!;
    const plan = insertPlan({ name: "MM recomp", kind: "recomp", repo: "Zelda64Recomp/Zelda64Recomp", platforms: ["n64"], spec, status: "ready" });
    const file = insertContent({ gameId: game.id, platform: "n64", name: basename(romPath), path: romPath, size: rom.byteLength, hashes: { sha1: sha1(rom), sha256: sha256(rom) }, source: "upload" });
    const way = updateWay(insertWay({ gameId: game.id, planId: plan.id, status: "ready" }).id, { contentId: file.id })!;
    const j = enqueueJob({ kind: "assemble", wayId: way.id }, { gameId: game.id });
    const done = runJob(j.id);
    for (let i = 0; i < 300 && !fetching; i++) await Bun.sleep(10);
    expect(fetching).toBe(true);
    await deleteGame(game.id, { deleteFiles: true });
    open();
    await done;
    try {
      expect((stmts.jobById.get(j.id) as JobRow).state).toBe("cancelled");
      expect(db.query("SELECT COUNT(*) AS n FROM packages").get()).toEqual({ n: 0 });
      expect(readdirSync(root.path).filter(n => n.startsWith("delete-me-mid-build"))).toEqual([]);
    } finally {
      db.query("DELETE FROM runtime_plans WHERE id=?").run(plan.id);
      db.query("DELETE FROM contents WHERE id=?").run(file.id);
    }
  });
});
