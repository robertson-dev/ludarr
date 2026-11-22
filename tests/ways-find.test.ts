/**
 * The content pass (src/ways/find.ts): which candidates a way's search takes (a dump that names no console only for a way
 * that proves its files, Demo / Beta / Proto / Hack … tags only when the way asks for them, its regions first and others
 * never), which way a request searches for, the catalog's serials copied into a new way, the dump lists
 * (src/catalog/providers/dats.ts), the per-way blocklist, and POST /api/v1/way/:id/find-files.
 */
import { generalTemplate } from "./emulator-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type PackageRow, type RequestRow } from "../src/db";
import { ingest as catalogIngest } from "../src/catalog/store";
import { datdeps, datVerdict, entrySerials, forgetDats, gameEntries, loadDat, parseDat } from "../src/catalog/providers/dats";
import { askedDisc, askedWords, catalogSerials, contentNames, contentQuery, fdeps, findRefusal, judgeContent, judgeFile, prepareContentPass, refreshSerials, regionKey, regionRank, regionsOf, requestWay, sameSerial } from "../src/ways/find";
import { discNumber, retailTags } from "../src/ways/names";
import { validateWayContent } from "../src/ways/validate";
import type { FileFacts } from "../src/ways/match";
import { certainlyThisGame, nameQueries, rankForNames, type ReleaseView } from "../src/releases";
import { DEFAULT_PROFILE, INSTALL_CLASSES } from "../src/library/profiles";
import { enqueueJob } from "../src/process/kinds";
import { waysApi } from "../src/ways/api";
import { getContent, getPlan, getWay, insertContent, insertPlan, insertWay, updatePlan, updateWay } from "../src/ways/store";
import { ctdeps } from "../src/ways/content";
import { hkdeps, romHandOff } from "../src/ways/hooks";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import type { Manifest } from "../src/process/validate";
import type { ContentPlan, PlanKind, RuntimePlanSpec } from "../src/ways/types";
import type { ProwlarrRelease } from "../src/prowlarr";
import type { PlatformId } from "../src/platforms";
import { n64Rom, nintendoIso, psIso } from "./ways-images";

const P = { id: 0, ...DEFAULT_PROFILE };
const realActive = fdeps.activeSources, realDat = { ...datdeps };
const made = { games: [] as number[], plans: [] as number[] };
const tmp = mkdtempSync(join(tmpdir(), "ways-find-"));
beforeAll(() => { datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats(); });
afterEach(() => { fdeps.activeSources = realActive; });
afterAll(() => {
  Object.assign(datdeps, realDat); forgetDats();
  for (const id of made.games) { db.query("DELETE FROM requests WHERE game_id=?").run(id); db.query("DELETE FROM jobs WHERE game_id=?").run(id); db.query("DELETE FROM contents WHERE game_id=?").run(id); db.query("DELETE FROM blocklist WHERE game_id=?").run(id); db.query("DELETE FROM packages WHERE game_id=?").run(id); db.query("DELETE FROM games WHERE id=?").run(id); }
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  db.exec("DELETE FROM routes WHERE source IN ('compat-pcsx2', 'find-test'); DELETE FROM titles WHERE name LIKE 'Synthetic%'");
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function game(name: string, o: Partial<GameRow> = {}): GameRow {
  const g = upsertGame({ name, slug: `find-${++seq}`, platforms_json: "[]", ...o } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
const content = (platform: PlatformId, o: Partial<ContentPlan> = {}): ContentPlan => ({
  kind: platform === "n64" ? "rom" : "disc", platform: platform as ContentPlan["platform"], what: `a ${platform} game`, search: ["Synthetic Quest"],
  accept: { hashes: [], formats: platform === "n64" ? ["z64", "v64", "n64"] : ["iso"] }, normalize: null, place: "games/{name}", ...o,
});
const spec = (c: ContentPlan | null): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Find-.*[.]zip$", channel: "stable" }, launch: { exe: "run.exe", argv: c ? ["{content}"] : [] },
  content: c, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
});
function plan(name: string, kind: PlanKind, c: ContentPlan | null, status: "ready" | "draft" = "ready") {
  const p = insertPlan({ name, kind, repo: `find/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: c ? [c.platform] : [], spec: spec(kind === "emulator" && c ? generalTemplate(c) : c), status });
  made.plans.push(p.id);
  return p;
}
const rel = (title: string, over: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: title, title, instanceId: 1, indexerId: 1, indexer: "T", size: 20e6, age: 10, publishDate: "", seeders: 10, leechers: 0,
  grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent",
  categories: [], indexerFlags: [], fileName: null, ...over,
});
/** the views a way's console pass judges, as the search ranks them */
const views = (names: string[], rows: ProwlarrRelease[], platform: PlatformId, unnamed: boolean, asked: string[] = []) =>
  rankForNames(nameQueries(names[0], null, names.slice(1)), rows, { platforms: [platform], known: [platform], unnamed, asked });
const judge = (ranked: ReleaseView[], c: ContentPlan, proves: boolean, blocked: string[] = []) =>
  judgeContent(ranked, { content: c, proves, names: c.search }, { profile: P, preferUsenet: false, blocked: new Set(blocked), tried: new Set() }).map(r => r.title);

describe("which candidates a way's console pass takes", () => {
  const MM = ["The Legend of Zelda: Majora's Mask"];
  const c = content("n64", { what: "Majora's Mask, NTSC-U 1.0", search: MM });
  const rows = [
    rel("Legend of Zelda, The - Majora's Mask (USA)", { seeders: 30 }),
    rel("Legend of Zelda, The - Majora's Mask (USA) N64", { seeders: 20 }),
    rel("Legend of Zelda, The - Majora's Mask (Europe)", { size: 3e9 }),          // a disc's size: no N64 game
    rel("Legend of Zelda, The - Majora's Mask (Japan)", { size: 0 }),              // no size to tell
    rel("Legend of Zelda, The - Majora's Mask (USA) [FitGirl Repack]", { size: 2e7 }),
  ];
  test("a dump that names no console only for a way that proves its files, and only at a size N64 games come in", () => {
    // the generic console fallback (and a way that proves nothing) still refuses No-Intro names
    const strict = views(MM, rows, "n64", false);
    expect(strict.find(v => v.title === "Legend of Zelda, The - Majora's Mask (USA)")!.flags.wrongKind).toMatch(/names no console/);
    expect(judge(strict, c, false)).toEqual(["Legend of Zelda, The - Majora's Mask (USA) N64"]);
    const loose = views(MM, rows, "n64", true);
    expect(certainlyThisGame(loose.find(v => v.title === "Legend of Zelda, The - Majora's Mask (USA)")!)).toBe(true);
    expect(judge(loose, c, true).sort()).toEqual(["Legend of Zelda, The - Majora's Mask (USA)", "Legend of Zelda, The - Majora's Mask (USA) N64"]);
    // a PC repack is never a dump, whatever it names
    expect(loose.find(v => /FitGirl/.test(v.title))!.flags.wrongKind).toMatch(/a PC release/);
  });

  test("Demo, Kiosk, Beta, Proto, Sample, Hack, Pirate and Unl stay refused unless the way's own description asks for them", () => {
    const tagged = ["(USA) (Beta)", "(USA) (Demo) (Kiosk)", "(USA) [h1C]", "(USA) (Proto)", "(USA) (Sample)", "(USA) (Pirate)", "(USA) (Unl)", "(USA)"]
      .map(t => rel(`Legend of Zelda, The - Majora's Mask ${t}`));
    expect(judge(views(MM, tagged, "n64", true, askedWords(c)), c, true)).toEqual(["Legend of Zelda, The - Majora's Mask (USA)"]);
    // Dinosaur Planet is a prototype: a way whose description says so takes a (Proto) dump, still never a beta or a demo
    const dino = content("n64", { what: "Dinosaur Planet prototype ROM (the 2021 leak)", search: ["Dinosaur Planet"] });
    const protos = ["(USA) (Proto)", "(USA) (Beta)", "(USA) (Demo)"].map(t => rel(`Dinosaur Planet ${t}`));
    expect(judge(views(["Dinosaur Planet"], protos, "n64", true, askedWords(dino)), dino, true)).toEqual(["Dinosaur Planet (USA) (Proto)"]);
    // a game called "Prototype" asks for no prototype: neither the console fallback nor its way's pass takes a (Proto) dump
    const proto = [rel("Prototype (USA) (Proto) PS2", { size: 4e9 }), rel("Prototype (USA) PS2", { size: 4e9 })];
    const fallback = rankForNames(nameQueries("Prototype", 2009), proto, { platforms: ["ps2"], known: ["ps2"] });
    expect(fallback.filter(certainlyThisGame).map(v => v.title)).toEqual(["Prototype (USA) PS2"]);
    const pg = game("Prototype", { release_year: 2009 });
    const pway = content("ps2", { what: "Prototype (PS2 disc)", search: ["Prototype"] });
    expect(askedWords(pway, pg)).not.toContain("prototype");
    expect(judge(views(["Prototype"], proto, "ps2", true, askedWords(pway, pg)), pway, true)).toEqual(["Prototype (USA) PS2"]);
    // a description that says no to a demo does not ask for one
    const not = content("n64", { what: "Majora's Mask ROM, not the demo", search: MM });
    expect(askedWords(not)).not.toContain("demo");
    expect(judge(views(MM, [rel("Legend of Zelda, The - Majora's Mask (USA) (Demo)")], "n64", true, askedWords(not)), not, true)).toEqual([]);
  });

  test("the way's regions first, in its order (a world release fits any), one that names none after them, other regions never", () => {
    const cr = content("n64", { search: ["Synthetic Quest"], accept: { hashes: [{ algo: "sha1", value: "a".repeat(40) }], formats: ["z64"], regions: ["US", "Europe"] } });
    const ranked = views(["Synthetic Quest"], [
      rel("Synthetic Quest (Europe)", { seeders: 90 }), rel("Synthetic Quest (Japan)", { seeders: 80 }), rel("Synthetic Quest (World)", { seeders: 5 }),
      rel("Synthetic.Quest.N64-GRP", { seeders: 70 }), rel("Synthetic Quest (USA)", { seeders: 60 }),
    ], "n64", true);
    expect(judge(ranked, cr, true)).toEqual(["Synthetic Quest (USA)", "Synthetic Quest (World)", "Synthetic Quest (Europe)", "Synthetic.Quest.N64-GRP"]);
    // the game's own words name no region ("Super Mario World", "The Last of Us")
    expect(regionsOf("Super Mario World (USA)", new Set(["super", "mario", "world"]))).toEqual(["US"]);
    expect(regionsOf("The Last of Us (Japan)", new Set(["the", "last", "of", "us"]))).toEqual(["JP"]);
    expect(regionsOf("Synthetic Quest (U) [!]")).toEqual(["US"]);
    expect(regionsOf("Synthetic.Quest.PAL.PS2DVD-GRP")).toEqual(["EU"]);
    expect(regionsOf("Synthetic Quest (NTSC-J)")).toEqual(["JP"]);
    expect(regionRank(["JP"], ["US"])).toBeNull();
    expect(regionRank([], ["US"])).toBe(1);
    expect(regionRank(["US"], [])).toBe(0);
  });

  test("blocked for the game or for this way, tried already, or not grabbable: never", () => {
    const ranked = views(["Synthetic Quest"], [rel("Synthetic Quest (USA) N64"), rel("Synthetic Quest (Europe) N64"), rel("Synthetic Quest (Japan) N64", { downloadUrl: null })], "n64", false);
    expect(judge(ranked, content("n64"), false, ["Synthetic Quest (USA) N64"])).toEqual(["Synthetic Quest (Europe) N64"]);
  });

  test("the names asked: the way's for the original game, the game's other names, its own name; its search terms only add queries", async () => {
    const added = game("Synthetic Quest DX", { release_year: 1999 });
    db.query("UPDATE games SET aliases_json=?, search_terms_json=? WHERE id=?").run(JSON.stringify(["Synth Quest"]), JSON.stringify(["synthquest n64"]), added.id);
    const g = stmts.gameById.get(added.id) as GameRow;
    const p = plan("Find Names Recomp", "recomp", content("n64", { search: ["Synthetic Quest", "Synthetic Quest 64"], accept: { hashes: [{ algo: "sha1", value: "b".repeat(40) }], formats: ["z64"] } }));
    const w = insertWay({ gameId: g.id, planId: p.id });
    const pass = (await prepareContentPass(w, g))!;
    expect(pass.names).toEqual(["Synthetic Quest", "Synthetic Quest 64", "Synth Quest", "Synthetic Quest DX"]);
    expect(contentNames(pass.content, g)).toEqual(pass.names);
    expect(pass.proves).toBe(true);
    expect(contentQuery(pass, g)).toEqual({ name: "Synthetic Quest", year: 1999, opts: {
      thorough: true, aliases: ["Synthetic Quest 64", "Synth Quest", "Synthetic Quest DX"], terms: ["synthquest n64"], categories: [], platforms: ["n64"], known: ["n64"], unnamed: true, asked: pass.asked,
    } });
  });
});

describe("which way a request searches for", () => {
  test("one that can prove a file first, then a recomp, a port, an emulator; a plan not ready, PC data: never", () => {
    const g = game("Synthetic Order", { platforms_json: '["n64"]' });
    const emu = insertWay({ gameId: g.id, planId: plan("Order Emu", "emulator", content("n64")).id, content: content("n64") });
    const port = insertWay({ gameId: g.id, planId: plan("Order Port", "port", content("n64")).id });
    expect(requestWay(g)?.id).toBe(port.id);                                   // neither proves a file: the port before the emulator
    const recomp = insertWay({ gameId: g.id, planId: plan("Order Recomp", "recomp", content("n64", { accept: { hashes: [{ algo: "sha1", value: "c".repeat(40) }], formats: ["z64"] } })).id });
    expect(requestWay(g)?.id).toBe(recomp.id);
    updateWay(emu.id, { content: content("n64", { accept: { hashes: [{ algo: "sha1", value: "d".repeat(40) }], formats: ["z64"] } }) });
    updatePlan(recomp.plan_id, { status: "draft" });
    expect(requestWay(g)?.id).toBe(emu.id);                                    // the one that proves its file, before the port
    expect(getWay(port.id)).toBeTruthy();
    // a PC-data way is never searched for; a ready contentless one is (it is simply built)
    const g2 = game("Synthetic PC Data");
    insertWay({ gameId: g2.id, planId: plan("Order PC Port", "port", content("pc" as PlatformId, { accept: { hashes: [], formats: ["wad"] } })).id });
    expect(requestWay(g2)).toBeNull();
    const none = insertWay({ gameId: g2.id, planId: plan("Order Freeware", "port", null).id });
    expect(requestWay(g2)?.id).toBe(none.id);
  });

  test("only while the game has no copy players can start: a console dump still searches, a PC copy or a built way does not", () => {
    const g = game("Synthetic Copy", { platforms_json: '["n64"]' });
    const w = insertWay({ gameId: g.id, planId: plan("Copy Recomp", "recomp", content("n64", { accept: { hashes: [{ algo: "sha1", value: "e".repeat(40) }], formats: ["z64"] } })).id });
    const pkg = (kind: string) => stmts.insertPackage.get(g.id, null, join(tmp, `copy-${kind}`), g.name, null, 1, JSON.stringify({ kind, launch: { exe: "x" } })) as { id: number };
    const rom = pkg("rom");
    expect(requestWay(g)?.id).toBe(w.id);
    db.query("DELETE FROM packages WHERE id=?").run(rom.id);
    pkg("native");
    expect(requestWay(g)).toBeNull();
    db.query("DELETE FROM packages WHERE game_id=?").run(g.id);
    pkg("recomp");
    expect(requestWay(g)).toBeNull();
  });
});

describe("the catalog's serials for a game, copied into a new way", () => {
  const ps2 = content("ps2", { what: "a PS2 disc image", search: ["x"] });
  function pcsx2Titles(name: string, retail: string[], demo: string[], key = "x") {
    catalogIngest({ id: "compat-pcsx2", metaRank: 25 }, [
      { title: { ids: retail.map(value => ({ scheme: "serial" as const, value })), name, platforms: ["ps2"] }, routes: [{ key: `pcsx2:${key}:retail`, kind: "emulated", platform: "ps2", provenance: "retail", runtime: "pcsx2", content: { kind: "disc", platform: "ps2", accept: { serials: retail }, from: [] } }] },
      // the list's "[Demo]" entry: the same base name (compat.ts baseName), so the same title, with a demo route
      { title: { ids: demo.map(value => ({ scheme: "serial" as const, value })), name, platforms: ["ps2"] }, routes: [{ key: `pcsx2:${key}:demo`, kind: "emulated", platform: "ps2", provenance: "demo", runtime: "pcsx2", content: { kind: "disc", platform: "ps2", accept: { serials: demo }, from: [] } }] },
    ]);
  }
  test("PCSX2's retail serials for the game's own title (a demo's never), when that source is switched on", async () => {
    fdeps.activeSources = () => new Set(["compat-pcsx2"]);
    pcsx2Titles("Synthetic Saga", ["SLUS-21678", "SLES-54206"], ["SCUS-97400"]);
    const t = db.query("SELECT id FROM titles WHERE name='Synthetic Saga'").get() as { id: number };
    const g = game("Synthetic Saga", { release_year: 2007, platforms_json: '["ps2"]' });
    stmts.setGameTitle.run(t.id, g.id);
    const emu = plan("Saga PS2 Emu", "emulator", ps2);
    const r = await waysApi.request(`/api/v1/game/${g.id}/ways`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: emu.id }) });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { item: { content: ContentPlan } }).item.content.accept.serials).toEqual(["SLUS-21678", "SLES-54206"]);
    fdeps.activeSources = () => new Set(["steam"]);
    expect(catalogSerials(stmts.gameById.get(g.id) as GameRow, "ps2")).toEqual([]);
  });

  test("a game linked to no such title takes them from the one title of exactly its name; two such titles: none", () => {
    fdeps.activeSources = () => new Set(["compat-pcsx2"]);
    pcsx2Titles("Synthetic Odyssey", ["SLUS-20111"], [], "o");
    const g = game("Synthetic Odyssey", { release_year: 2004 });
    expect(catalogSerials(g, "ps2")).toEqual(["SLUS-20111"]);
    expect(catalogSerials(g, "gc")).toEqual([]);
    // another title of the same name (a year apart from what the game says is no help: the list has none) makes it uncertain
    const other = db.query("INSERT INTO titles (slug, name, sort_name) VALUES ('synthetic-odyssey-other', 'Synthetic Odyssey', 'synthetic odyssey') RETURNING id").get() as { id: number };
    db.query("INSERT OR IGNORE INTO title_names (norm, title_id) VALUES ('synthetic odyssey', ?)").run(other.id);
    db.query(`INSERT INTO routes (title_id, kind, platform, provenance, content_json, source, source_key) VALUES (?, 'emulated', 'ps2', 'retail', ?, 'compat-pcsx2', 'pcsx2:other')`).run(other.id, JSON.stringify({ accept: { serials: ["SLES-50222"] } }));
    expect(catalogSerials(g, "ps2")).toEqual([]);
  });
});

describe("the dump lists", () => {
  const retail = n64Rom({ code: "NSYE", seed: 1 }), beta = n64Rom({ code: "NSYE", seed: 2 }), other = n64Rom({ code: "NOTE", seed: 3 });
  const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
  const DAT = `clrmamepro (
\tname "Nintendo - Nintendo 64"
\tdescription "Nintendo - Nintendo 64"
\tversion "2026.10.07"
)

game (
\tname "Synthetic Quest (USA)"
\tregion "USA"
\tserial "NSYE"
\trom ( name "Synthetic Quest (USA).z64" size 1048576 crc 0A0B0C0D md5 ${"1".repeat(32)} sha1 ${sha(retail).toUpperCase()} serial "NSYE" )
)

game (
\tname "Synthetic Quest (USA) (Beta)"
\trom ( name "Synthetic Quest (USA) (Beta).z64" size 1048576 crc 01020304 md5 ${"2".repeat(32)} sha1 ${sha(beta).toUpperCase()} )
)

game (
\tname "Other Adventure (USA)"
\tregion "USA"
\trom ( name "Other Adventure (USA).z64" size 1048576 crc 05060708 md5 ${"3".repeat(32)} sha1 ${sha(other).toUpperCase()} )
)
`;
  test("a clrmamepro list read: the version, each entry's name, region, serial and roms", () => {
    const d = parseDat(DAT);
    expect(d.version).toBe("2026.10.07");
    expect(d.entries.map(e => [e.name, e.region, e.serial])).toEqual([["Synthetic Quest (USA)", "USA", "NSYE"], ["Synthetic Quest (USA) (Beta)", null, null], ["Other Adventure (USA)", "USA", null]]);
    expect(d.entries[0].roms).toEqual([{ name: "Synthetic Quest (USA).z64", size: 1048576, crc: "0a0b0c0d", md5: "1".repeat(32), sha1: sha(retail), serial: "NSYE" }]);
  });

  test("a file the list knows as the game proves it; as a beta or another game refuses it; one it does not know says nothing", async () => {
    datdeps.fetchText = async () => DAT;
    forgetDats();
    const dat = (await loadDat("n64"))!;
    const names = ["Synthetic Quest"];
    expect(datVerdict(dat, { sha1: sha(retail) }, null, names)).toMatchObject({ kind: "game", entry: { name: "Synthetic Quest (USA)" } });
    expect(datVerdict(dat, { sha1: "f".repeat(40) }, { sha1: sha(retail) }, names).kind).toBe("game");   // as the bytes came, before they were put right
    expect(datVerdict(dat, { sha1: sha(beta) }, null, names)).toMatchObject({ kind: "other", why: expect.stringMatching(/Synthetic Quest \(USA\) \(Beta\).*a development build/) });
    expect(datVerdict(dat, { sha1: sha(other) }, null, names)).toMatchObject({ kind: "other", why: "the dump list names it Other Adventure (USA): another game" });
    expect(datVerdict(dat, { sha1: "e".repeat(40) }, null, names)).toEqual({ kind: "none", entry: null, why: null });
    expect(gameEntries(dat, names).map(e => e.name)).toEqual(["Synthetic Quest (USA)"]);
    // a way that asks for a beta: the list no longer refuses the beta's bytes, and never proves them either
    expect(datVerdict(dat, { sha1: sha(beta) }, null, names, ["beta"])).toMatchObject({ kind: "unknown", entry: { name: "Synthetic Quest (USA) (Beta)" } });
    datdeps.fetchText = async () => { throw new Error("offline"); };
  });

  test("kept on the server, fetched again when two weeks old; a failed fetch keeps the old copy and waits an hour", async () => {
    let calls = 0, now = Date.now();
    datdeps.now = () => now;
    datdeps.fetchText = async () => { calls++; return DAT; };
    forgetDats();
    rmSync(join(tmp, "dats"), { recursive: true, force: true });
    expect((await loadDat("snes"))!.entries.length).toBe(3);
    expect(await loadDat("snes")).toBeTruthy();
    expect(calls).toBe(1);
    const path = join(tmp, "dats", "snes.dat");
    const old = new Date(now - 15 * 86_400_000);
    utimesSync(path, old, old);
    datdeps.fetchText = async () => { calls++; throw new Error("HTTP 503"); };
    const lines: string[] = [];
    expect((await loadDat("snes", l => lines.push(l)))!.entries.length).toBe(3);
    expect(lines.join("\n")).toMatch(/could not be fetched \(HTTP 503\): the copy kept on the server is used/);
    await loadDat("snes");
    expect(calls).toBe(2);                                                     // not asked again within the hour
    now += 2 * 3_600_000;
    await loadDat("snes");
    expect(calls).toBe(3);
    expect(await loadDat("pc" as PlatformId)).toBeNull();                     // no list for PC data
    Object.assign(datdeps, { now: realDat.now, fetchText: async () => { throw new Error("offline"); } });
  });

  test("a disc's serials, as its entries give them, in the form its bytes carry them", () => {
    const e = (serial: string) => ({ name: "x", region: null, serial, roms: [] });
    expect(entrySerials([e("SLUS-21678"), e("SLES-55345/ANZ"), e("SLUS-20265GH"), e("SLPM-65002-0"), e("SLUS-21678")], "ps2")).toEqual(["SLUS-21678", "SLES-55345", "SLUS-20265", "SLPM-65002"]);
    expect(entrySerials([e("DL-DOL-GW7E-USA"), e("DL-DOL-GW7P-EUR, DL-DOL-GW7P-NOE")], "gc")).toEqual(["DL-DOL-GW7E-USA", "DL-DOL-GW7P-EUR", "DL-DOL-GW7P-NOE"]);
  });
});

describe("the per-way blocklist", () => {
  test("a release one way refused is blocked for that way only, never for the game's own search or another way", () => {
    const g = game("Synthetic Blocks");
    stmts.insertWayBlock.run(g.id, "guid-a", "Synthetic Blocks (USA)", "T", "not the game file", 111, null, null);
    stmts.insertBlock.run(g.id, "guid-b", "Synthetic Blocks (Europe)", "T", "stalled");
    const guids = (rows: { guid: string | null }[]) => rows.map(r => r.guid).sort();
    expect(guids(stmts.blocklistForGame.all(g.id) as never)).toEqual(["guid-b"]);
    expect(guids(stmts.blocklistForWay.all(g.id, 111) as never)).toEqual(["guid-a", "guid-b"]);
    expect(guids(stmts.blocklistForWay.all(g.id, 222) as never)).toEqual(["guid-b"]);
  });
});

describe("POST /api/v1/way/:id/find-files", () => {
  const call = async (id: number) => { const r = await waysApi.request(`/api/v1/way/${id}/find-files`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); return { status: r.status, body: await r.json() as any }; };
  test("the UI's probe (way 0) is told there is no such way, not that the route is missing", async () => {
    expect(await call(0)).toEqual({ status: 404, body: { error: "no such way" } });
  });
  test("202 with the request (the queue shows it), once per way; 409 with the reason when there is nothing to search for", async () => {
    const g = game("Synthetic Finder", { platforms_json: '["n64"]' });
    const p = plan("Finder Recomp", "recomp", content("n64", { accept: { hashes: [{ algo: "sha1", value: "a".repeat(40) }], formats: ["z64"] } }));
    const w = insertWay({ gameId: g.id, planId: p.id });
    // a search of the game's own that is only waiting becomes the admin's
    const waiting = stmts.insertRequest.get(g.id, "auto") as RequestRow;
    const first = await call(w.id);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ duplicate: false, request: { id: waiting.id, gameId: g.id, state: "requested", stage: "queued" } });
    expect(stmts.requestById.get(waiting.id)).toMatchObject({ way_id: w.id, requested_by: "find-files" });
    expect((await call(w.id)).body).toMatchObject({ duplicate: true, request: { id: waiting.id } });
    expect(Object.keys(first.body.request)).not.toContain("wayId");          // nothing new reaches Ahoy through a request
    db.query("DELETE FROM requests WHERE game_id=?").run(g.id);
    // the way is being built
    const job = enqueueJob({ kind: "assemble", wayId: w.id }, { gameId: g.id });
    expect(await call(w.id)).toEqual({ status: 409, body: { error: "the way is being built" } });
    db.query("DELETE FROM jobs WHERE id=?").run(job.id);
    // its plan is not ready
    updatePlan(p.id, { status: "draft" });
    expect((await call(w.id)).body.error).toMatch(/^the plan is draft/);
    updatePlan(p.id, { status: "ready" });
    // it has its file
    const romPath = join(tmp, "finder.z64");
    await Bun.write(romPath, "x");
    const f = insertContent({ gameId: g.id, platform: "n64", name: "finder.z64", path: romPath, size: 1, hashes: { sha1: "a".repeat(40) }, source: "upload" });
    updateWay(w.id, { contentId: f.id });
    expect(await call(w.id)).toEqual({ status: 409, body: { error: "the way has its game file already (finder.z64)" } });
    expect(findRefusal(getWay(w.id)!, getPlan(p.id)!)).toBe("the way has its game file already (finder.z64)");
  });
  test("a file a search brought that nothing could prove holds the way's searches until the admin decides", async () => {
    const g = game("Synthetic Holder", { platforms_json: '["n64"]' });
    const p = plan("Holder Emu", "emulator", content("n64"));
    const w = insertWay({ gameId: g.id, planId: p.id, content: content("n64") });
    const romPath = join(tmp, "held.z64");
    await Bun.write(romPath, "y");
    insertContent({ gameId: g.id, platform: "n64", name: "Synthetic Holder (USA).z64", path: romPath, size: 1, hashes: { sha1: "9".repeat(40) }, source: "indexer" });
    expect(await call(w.id)).toEqual({ status: 409, body: { error: "Synthetic Holder (USA).z64 came from the indexers and waits for a look: accept it for the way, or remove it to search again" } });
  });
});

describe("what a file's bytes say, where files come in by themselves", () => {
  const realC = { ...ctdeps };
  beforeAll(() => { ensureDefaultRootFolder(); ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); });
  afterAll(() => { Object.assign(ctdeps, realC); });
  const ps2 = (serials: string[]) => content("ps2", { what: "a PS2 disc image", search: ["Synthetic Hand"], accept: { hashes: [], formats: ["iso", "chd"], serials } });
  /** the game's console copy as an import leaves it: one file in a package folder under the root folder */
  function romPackage(g: GameRow, file: string, bytes: Uint8Array, platform: string) {
    const dir = join(rootFolders()[0].path, `find-copy-${g.id}-${file.replace(/[^a-z0-9]+/gi, "-")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), bytes);
    const manifest = { schema: 1, name: g.name, slug: g.slug, version: null, launch: { exe: file, args: "", cwd: "" }, prerequisites: [], files: [], totalSize: bytes.length, source: null, tier: "deterministic", kind: "rom", platform, notes: null, createdAt: "" } as unknown as Manifest;
    return { pkg: stmts.insertPackage.get(g.id, null, dir, g.name, null, bytes.length, JSON.stringify(manifest)) as PackageRow, manifest };
  }
  const assembles = (gameId: number) => (db.query("SELECT spec_json FROM jobs WHERE kind='assemble' AND game_id=?").all(gameId) as { spec_json: string }[]).map(j => JSON.parse(j.spec_json).wayId as number);

  test("a dump of a console the game has no way for yet: that console's emulator is asked to give it one", async () => {
    const g = game("Synthetic Cart", { platforms_json: '["snes"]' });
    const asked: [number, string][] = [];
    const real = hkdeps.ensureWay;
    hkdeps.ensureWay = async (gm, platform) => { asked.push([gm.id, platform]); return { state: "waiting", emulator: "ares", jobId: 7 }; };
    try {
      const lines: string[] = [];
      const rom = romPackage(g, "Synthetic Cart (USA).sfc", new Uint8Array(4096).fill(7), "snes");
      await romHandOff({ gameId: g.id, pkg: rom.pkg, manifest: rom.manifest, log: l => lines.push(l) });
      expect(asked).toEqual([[g.id, "snes"]]);
      expect(lines[0]).toBe("ares is being set up for SNES games: the game's way follows");
      // one that cannot be made says why in the import's log, and the import goes on
      hkdeps.ensureWay = async () => ({ state: "none", why: "ludarr has no emulator of its own for SNES games" });
      await romHandOff({ gameId: g.id, pkg: rom.pkg, manifest: rom.manifest, log: l => lines.push(l) });
      expect(lines.at(-1)).toBe("no way to play was made by itself: ludarr has no emulator of its own for SNES games");
    } finally { hkdeps.ensureWay = real; }
  });

  test("an imported dump goes to a way that checks serials only when its serial is one the way takes", async () => {
    const g = game("Synthetic Hand", { platforms_json: '["ps2"]' });
    const w = insertWay({ gameId: g.id, planId: plan("Hand PS2 Emu", "emulator", ps2([])).id, content: ps2(["SLUS-21678"]) });
    const lines: string[] = [];
    // another game's disc: refused, nothing built
    const wrong = romPackage(g, "Synthetic Hand (USA).iso", psIso({ boot: "cdrom0:\\SLUS_200.00;1", seed: 5 }), "ps2");
    await romHandOff({ gameId: g.id, pkg: wrong.pkg, manifest: wrong.manifest, log: l => lines.push(l) });
    expect(getWay(w.id)!.content_id).toBeNull();
    expect(lines.join("\n")).toMatch(/the dump is no game file for Hand PS2 Emu: another game \(its serial is SLUS-20000/);
    expect(assembles(g.id)).toEqual([]);
    // a copy whose serial cannot be read: nothing proves it, so it is not built into the way by itself
    const chd = romPackage(g, "Synthetic Hand (USA).chd", new Uint8Array(32 * 1024).fill(3), "ps2");
    await romHandOff({ gameId: g.id, pkg: chd.pkg, manifest: chd.manifest, log: l => lines.push(l) });
    expect(getWay(w.id)!.content_id).toBeNull();
    expect(lines.at(-1)).toMatch(/nothing proves the dump is the game file of Hand PS2 Emu: .*\(no serial can be read from it\) — it is not built into it by itself$/);
    // the game's own disc: the way's file, and its build queued
    const right = romPackage(g, "Synthetic Hand (USA) [right].iso", psIso({ boot: "cdrom0:\\SLUS_216.78;1", seed: 6 }), "ps2");
    await romHandOff({ gameId: g.id, pkg: right.pkg, manifest: right.manifest, log: l => lines.push(l) });
    expect(getContent(getWay(w.id)!.content_id!)).toMatchObject({ source: "package", platform: "ps2" });
    expect(assembles(g.id)).toEqual([w.id]);
  });

  test("an upload whose bytes name another console is that console's file, whatever it was sent as", async () => {
    const g = game("Synthetic Upload", { platforms_json: '["ps2", "gc"]' });
    const w = insertWay({ gameId: g.id, planId: plan("Upload PS2 Emu", "emulator", ps2([])).id, content: ps2([]) });
    const disc = nintendoIso({ id: "GSUE01", size: 2 * 1024 * 1024 });
    const r = await waysApi.request(`/api/v1/content?gameId=${g.id}&name=${encodeURIComponent("Synthetic Upload.iso")}&platform=ps2&wayId=${w.id}`, { method: "POST", body: new Uint8Array(disc) });
    expect(r.status).toBe(201);
    const body = await r.json() as { item: { platform: string; identity: { discId: string } }; attached: number[]; checks: { wayId: number; plan: string; ok: boolean; why: string | null }[] };
    expect(body.item).toMatchObject({ platform: "gc", identity: { platform: "gc", discId: "GSUE01" } });
    expect(body.attached).toEqual([]);
    expect(body.checks[0]).toEqual({ wayId: w.id, plan: "Upload PS2 Emu", ok: false, why: "a gc file, and this needs a ps2 one" });
  });
});

/* ─────────── what the W7 verification found (each test is one of its findings, fixed) ─────────── */

const offline = async (): Promise<string> => { throw new Error("offline"); };
const shaN = (n: number) => n.toString(16).padStart(40, "0");
/** a dump list of these entries (name, serial, the sha1 of a made-up file) */
const datText = (system: string, entries: [string, string, number][]) => `clrmamepro (\n\tname "${system}"\n\tversion "2026.10.07"\n)\n\n` +
  entries.map(([name, serial, n]) => `game (\n\tname "${name}"\n\tserial "${serial}"\n\trom ( name "${name}.bin" size 1048576 crc 00000000 md5 ${"0".repeat(32)} sha1 ${shaN(n)} serial "${serial}" )\n)\n`).join("\n");
async function keptDat(platform: PlatformId, text: string) {
  datdeps.fetchText = async () => text;
  forgetDats();
  rmSync(join(tmp, "dats", `${platform}.dat`), { force: true });
  const dat = (await loadDat(platform))!;
  datdeps.fetchText = offline;
  return dat;
}
const dropKept = (platform: PlatformId) => { rmSync(join(tmp, "dats", `${platform}.dat`), { force: true }); forgetDats(); };

describe("the dump list's entries that are not the game as it was sold", () => {
  test("a bonus disc, a sampler, a store demo or a later disc is never the game: it gives no serial, proves nothing, and refuses its bytes", async () => {
    const dat = await keptDat("ps1", datText("Sony - PlayStation", [
      ["Synthetic Fantasy (USA) (Disc 1)", "SCUS-94163", 1], ["Synthetic Fantasy (USA) (Disc 2)", "SCUS-94164", 2],
      ["Synthetic Fantasy (USA) (Interactive Sampler CD)", "SCUS-94961", 3], ["Synthetic Fantasy (USA) (Square Soft on PlayStation Previews)", "SCUS-94179", 4],
      ["Synthetic Fantasy (Japan) (Tentou-you Taikenban)", "SLPM-80001", 5], ["Synthetic Fantasy (USA) (Bonus Disc)", "SCUS-94999", 6],
      ["Synthetic Fantasy (Europe) (LodgeNet)", "SCES-00001", 7], ["Synthetic Fantasy (Japan) (PlayStation the Best)", "SLPS-91001", 8],
    ]));
    const names = ["Synthetic Fantasy"];
    const entries = gameEntries(dat, names);
    expect(entries.map(e => e.name)).toEqual(["Synthetic Fantasy (USA) (Disc 1)", "Synthetic Fantasy (Japan) (PlayStation the Best)"]);
    expect(entrySerials(entries, "ps1")).toEqual(["SCUS-94163", "SLPS-91001"]);
    const v = (n: number, o: { disc?: number } = {}) => datVerdict(dat, { sha1: shaN(n) }, null, names, [], o);
    expect(v(1)).toMatchObject({ kind: "game", entry: { name: "Synthetic Fantasy (USA) (Disc 1)" } });
    expect(v(8).kind).toBe("game");
    expect(v(2)).toMatchObject({ kind: "other", why: "the dump list names it Synthetic Fantasy (USA) (Disc 2) (disc 2 of the game)" });
    expect(v(2, { disc: 2 }).kind).toBe("unknown");                          // a way that asks for disc 2: no refusal, no proof
    expect(v(3).why).toMatch(/\(Interactive Sampler CD\): a demo, not the game as it was sold/);
    expect(v(4).why).toMatch(/Previews\): a demo/);
    expect(v(5).why).toMatch(/\(Tentou-you Taikenban\): a demo/);
    expect(v(6).why).toMatch(/\(Bonus Disc\): a bonus disc/);
    expect(v(7)).toMatchObject({ kind: "unknown", why: expect.stringMatching(/LodgeNet\) \(an edition the list's tags do not say was sold as the game\)/) });
    dropKept("ps1");
  });

  test("which tags a retail dump carries, and which disc a name is", () => {
    for (const n of ["X (USA)", "X (USA, Europe) (En,Fr,De)", "X (Europe) (En,Fr,De,Es,It) (Rev 1)", "X (USA) (v1.01)", "X (USA) (Disc 1)", "X (Japan) (PlayStation 2 the Best)",
      "X (USA) (Greatest Hits)", "X (Europe) (Virtual Console)", "X (Japan) (Shokai Genteiban)", "X (USA) [!]"]) expect([n, retailTags(n)]).toEqual([n, true]);
    for (const n of ["X (USA) (LodgeNet)", "X (USA) (Bonus Disc)", "X (Europe) (Zelda Collection)", "X (USA) [b1]", "X (USA) (Disc 2)", "X (Japan) (2000-12-01)"]) expect([n, retailTags(n)]).toEqual([n, false]);
    expect(["X (USA) (Disc 2)", "X (Disc B)", "X.Disc.2.PSX-GRP", "X Disc2.iso", "X (USA)", "X (CD 3)", "Disco Elysium (USA)"].map(discNumber)).toEqual([2, 2, 2, 2, null, 3, null]);
  });

  test("a console pass refuses the discs Redump files beside the game (bonus, sampler, previews, store and show demos); an edition stays the game", () => {
    for (const t of ["(Bonus Disc)", "(Interactive Sampler CD)", "(Square Soft on PlayStation Previews)", "(Special Disc)", "(Premium Disc)", "(Making Disc)", "(Tentou-you Taikenban)", "(E3 1997)", "(Test Drive Disc)"]) {
      const [v] = views(["Synthetic Fantasy"], [rel(`Synthetic Fantasy (USA) ${t}`, { size: 4e8 })], "ps1", true);
      expect([t, v.flags.wrongKind]).toEqual([t, expect.stringMatching(/not the game as it was sold$/)]);
    }
    expect(certainlyThisGame(views(["Synthetic Fantasy"], [rel("Synthetic Fantasy (USA) (Special Edition)", { size: 4e8 })], "ps1", true)[0])).toBe(true);
  });

  test("a status tag counts whatever the game is called: a (Hack) of a game named Hack Quest is a hack; a demo disc's own (Demo) stays its own", () => {
    const fallback = (name: string, title: string) => rankForNames(nameQueries(name, 2000), [rel(title)], { platforms: ["n64"], known: ["n64"] })[0];
    expect(fallback("Synthetic Hack Quest", "Synthetic Hack Quest (USA) (Hack) N64").flags.wrongKind).toBe("(Hack): a hack, not the game as it was sold");
    expect(fallback("Synthetic Beta Quest", "Synthetic Beta Quest (USA) (Beta) N64").flags.wrongKind).toBe("(Beta): a development build, not the game as it was sold");
    expect(certainlyThisGame(fallback("Synthetic Hack Quest", "Synthetic Hack Quest (USA) N64"))).toBe(true);
    expect(fallback("Synthetic Demo Disc", "Synthetic Demo Disc (USA) (Demo) N64").flags.wrongKind).toBeNull();
    // a way asking for that tag still takes it (Dinosaur Planet)
    expect(rankForNames(nameQueries("Synthetic Proto Quest", 2000), [rel("Synthetic Proto Quest (USA) (Proto) N64")], { platforms: ["n64"], known: ["n64"], asked: ["prototype"] })[0].flags.wrongKind).toBeNull();
  });

  test("a release of another disc than the first is skipped, unless the way asks for that disc", () => {
    const c = content("ps1", { search: ["Synthetic Fantasy"], accept: { hashes: [], formats: ["bin"], serials: ["SCUS-94163"] } });
    const ranked = views(["Synthetic Fantasy"], [rel("Synthetic Fantasy (USA) (Disc 2)", { size: 4e8 }), rel("Synthetic Fantasy (USA) (Disc 1)", { size: 4e8 })], "ps1", true);
    const x = { profile: P, preferUsenet: false, blocked: new Set<string>(), tried: new Set<string>() };
    expect(judgeContent(ranked, { content: c, proves: true, names: c.search }, x).map(r => r.title)).toEqual(["Synthetic Fantasy (USA) (Disc 1)"]);
    const two = content("ps1", { ...c, what: "disc 2 of the game (the second half)" });
    expect(askedDisc(two)).toBe(2);
    expect(askedDisc(content("ps1", { ...c, what: "the game, not disc 2" }))).toBeNull();
    expect(judgeContent(ranked, { content: two, proves: true, names: c.search, disc: askedDisc(two) }, x).map(r => r.title)).toContain("Synthetic Fantasy (USA) (Disc 2)");
  });
});

describe("what a way's own words ask for", () => {
  test("a description that says no to anything asks for no dump tag; an affirmative one still does", () => {
    const TAGS = ["demo", "beta", "prototype", "proto", "kiosk", "hack"];
    for (const what of ["Retail only — demo, beta and prototype discs are refused", "the US retail disc (beta builds won't boot)", "the final game: prototype dumps can't be used",
      "US disc; the kiosk demo doesn't work", "a clean, hack-free US ROM", "the beta lacks the final levels", "the US disc (beta builds won’t boot)"]) {
      expect([what, askedWords(content("ps2", { what, search: ["Synthetic Saga"] })).filter(w => TAGS.includes(w))]).toEqual([what, []]);
    }
    expect(askedWords(content("n64", { what: "Dinosaur Planet prototype ROM (the 2021 leak)", search: ["Dinosaur Planet"] }))).toContain("prototype");
    // the game's own name says no to nothing ("Never Alone"), its description's words still do
    const never = game("Never Synthetic");
    expect(askedWords(content("n64", { what: "Never Synthetic prototype build", search: ["Never Synthetic"] }), never)).toContain("prototype");
    expect(askedWords(content("n64", { what: "Never Synthetic, not the prototype", search: ["Never Synthetic"] }), never)).not.toContain("prototype");
    // and the search keeps refusing the beta for such a way
    const c = content("ps2", { what: "the US retail disc (beta builds won't boot)", search: ["Synthetic Saga"], accept: { hashes: [], formats: ["iso"], serials: ["SLUS-29991"] } });
    expect(judge(views(["Synthetic Saga"], [rel("Synthetic Saga (USA) (Beta)", { size: 4e9 }), rel("Synthetic Saga (USA)", { size: 4e9 })], "ps2", true, askedWords(c)), c, true)).toEqual(["Synthetic Saga (USA)"]);
  });

  test("words a way asks for never make the dump list prove a file: a prototype it wants is neither refused nor proven by the list", async () => {
    const dat = await keptDat("n64", datText("Nintendo - Nintendo 64", [["Synthetic Planet (USA)", "NSPE", 11], ["Synthetic Planet (USA) (Proto)", "NSPE", 12]]));
    expect(datVerdict(dat, { sha1: shaN(12) }, null, ["Synthetic Planet"], []).kind).toBe("other");
    expect(datVerdict(dat, { sha1: shaN(12) }, null, ["Synthetic Planet"], ["prototype"]).kind).toBe("unknown");
    expect(gameEntries(dat, ["Synthetic Planet"]).map(e => e.name)).toEqual(["Synthetic Planet (USA)"]);
    dropKept("n64");
  });

  test("an accepted hash proves a file whatever its name says; else its name's tags, the release it came in and its disc decide first", () => {
    const sha = "1".repeat(40);
    const facts = (o: Partial<FileFacts> = {}): FileFacts => ({ platform: "n64", name: "f.z64", size: 1048576, hashes: { sha1: sha }, identity: { platform: "n64", gameCode: "NSYE" }, ...o });
    const pass = { content: content("n64", { accept: { hashes: [{ algo: "sha1", value: sha }], formats: ["z64"] } }), names: ["Synthetic Quest"], asked: [] as string[], disc: null, dat: null };
    expect(judgeFile(pass, "Synthetic Quest (USA) (Proto).z64", facts())).toMatchObject({ verdict: "proven", by: "hash" });
    const serial = { ...pass, content: content("n64", { accept: { hashes: [], formats: ["z64"], serials: ["NSYE"] } }) };
    expect(judgeFile(serial, "Synthetic Quest (USA) (Proto).z64", facts())).toEqual({ verdict: "refused", why: "(Proto): a development build, not the game as it was sold", by: null });
    expect(judgeFile(serial, "Synthetic Quest (USA).z64", facts())).toMatchObject({ verdict: "proven", by: "serial" });
    // a file that came in a release carries only the tags that release carried: a beta beside "Beta Quest" is a beta,
    // and a demo disc's own "(Demo)" stays its own
    const beta = { ...serial, names: ["Synthetic Beta Quest"] };
    expect(judgeFile(beta, "Synthetic Beta Quest (USA) (Beta).z64", facts(), "Synthetic Beta Quest (USA)").verdict).toBe("refused");
    const demo = { ...serial, names: ["Synthetic Demo Disc"] };
    expect(judgeFile(demo, "Synthetic Demo Disc (USA) (Demo).z64", facts(), "Synthetic Demo Disc (USA) (Demo) N64").verdict).toBe("proven");
    // the second disc of a GameCube game, by its bytes
    const gc = { ...pass, content: content("gc", { accept: { hashes: [], formats: ["iso"], serials: ["GSXE01"] } }) };
    const disc2 = facts({ platform: "gc", name: "x.iso", identity: { platform: "gc", discId: "GSXE01", disc: 2 } });
    expect(judgeFile(gc, "Synthetic Quest (USA).iso", disc2)).toMatchObject({ verdict: "refused", why: "disc 2 of the game, and this way takes its first disc" });
    expect(judgeFile({ ...gc, disc: 2 }, "Synthetic Quest (USA).iso", disc2)).toMatchObject({ verdict: "proven", by: "serial" });
    // bytes that say nothing, in a format the reader sees into: no PS2 disc (a file kept earlier was read as it came in)
    const ps2 = { ...pass, content: content("ps2", { accept: { hashes: [], formats: ["iso", "chd"], serials: ["SLUS-29991"] } }) };
    const silent = facts({ platform: "ps2", name: "x.iso", identity: null });
    expect(judgeFile(ps2, "Synthetic Quest (USA).iso", silent)).toMatchObject({ verdict: "refused", why: "nothing in it reads as a PlayStation 2 disc" });
    expect(judgeFile(ps2, "Synthetic Quest (USA).iso", silent, null, { stored: true }).verdict).toBe("unproven");
    expect(judgeFile(ps2, "Synthetic Quest (USA).chd", { ...silent, name: "x.chd" }).verdict).toBe("unproven");
  });
});

describe("a way's serials and regions as the admin keeps them", () => {
  test("a serial the admin takes off a way never comes back from the catalog or the dump list; one written again is forgotten", async () => {
    fdeps.activeSources = () => new Set(["compat-pcsx2"]);
    catalogIngest({ id: "compat-pcsx2", metaRank: 25 }, [
      { title: { ids: [{ scheme: "serial", value: "SLUS-29981" }, { scheme: "serial", value: "SLES-59982" }], name: "Synthetic Serial Saga", platforms: ["ps2"] },
        routes: [{ key: "pcsx2:serial-saga", kind: "emulated", platform: "ps2", provenance: "retail", runtime: "pcsx2", content: { kind: "disc", platform: "ps2", accept: { serials: ["SLUS-29981", "SLES-59982"] }, from: [] } }] },
    ]);
    const g = game("Synthetic Serial Saga", { release_year: 2006, platforms_json: '["ps2"]' });
    const emu = plan("Serial Saga PS2 Emu", "emulator", content("ps2", { what: "a PS2 disc image", search: ["x"] }));
    const api = async (path: string, method: string, body?: unknown) => { const r = await waysApi.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : "{}" }); return { status: r.status, body: await r.json() as any }; };
    const made = await api(`/api/v1/game/${g.id}/ways`, "POST", { planId: emu.id });
    expect(made.body.item.content.accept.serials).toEqual(["SLUS-29981", "SLES-59982"]);
    const id = made.body.item.id as number;
    const serials = () => JSON.parse(getWay(id)!.content_json!).accept.serials as string[];
    // the admin knows SLES-59982 is not this game
    expect((await api(`/api/v1/way/${id}`, "PUT", { content: { ...made.body.item.content, accept: { ...made.body.item.content.accept, serials: ["SLUS-29981"] } } })).status).toBe(200);
    expect(getWay(id)!.dropped_serials_json).toBe('["SLES-59982"]');
    expect((await api(`/api/v1/way/${id}/find-files`, "POST")).status).toBe(202);
    expect(serials()).toEqual(["SLUS-29981"]);
    expect(await refreshSerials(getWay(id)!, stmts.gameById.get(g.id) as GameRow)).toBe(0);
    expect((await prepareContentPass(getWay(id)!, stmts.gameById.get(g.id) as GameRow))!.content.accept.serials).toEqual(["SLUS-29981"]);
    // written again (in another spelling): it is the way's again, and no longer remembered as taken off
    const cur = JSON.parse(getWay(id)!.content_json!);
    expect((await api(`/api/v1/way/${id}`, "PUT", { content: { ...cur, accept: { ...cur.accept, serials: ["SLUS-29981", "SLES_599.82"] } } })).status).toBe(200);
    expect(getWay(id)!.dropped_serials_json).toBeNull();
    expect(sameSerial("ps2", "SLES_599.82", "SLES-59982")).toBe(true);
    expect(sameSerial("gc", "GZLE01", "DL-DOL-GZLE-USA")).toBe(true);
  });

  test("a way's region words are one name per region, as typed or as GoodTools and scene names write them; a word that names none is refused", async () => {
    expect(["US", "USA", "U", "NTSC", "NTSC-U", "North America", "E", "PAL", "J", "NTSC-J", "NTSC-K", "W"].map(regionKey)).toEqual(["US", "US", "US", "US", "US", "US", "EU", "EU", "JP", "JP", "KR", "WORLD"]);
    expect(regionKey("Narnia")).toBeNull();
    expect(regionsOf("Synthetic Saga (NTSC-K) PS2")).toEqual(["KR"]);
    expect(regionRank(regionsOf("Synthetic Quest (USA)"), [regionKey("U")!])).toBe(0);
    const n64 = (regions: string[]) => content("n64", { accept: { hashes: [], formats: ["z64"], regions } });
    expect(validateWayContent(n64(["U", "NTSC-J", "USA"]), "emulator").value!.accept.regions).toEqual(["US", "JP"]);
    expect(validateWayContent(n64(["Narnia"]), "emulator").errors.join(" ")).toMatch(/accept\.regions: "Narnia" is not a region/);
    const g = game("Synthetic Regions", { platforms_json: '["n64"]' });
    const w = insertWay({ gameId: g.id, planId: plan("Regions Emu", "emulator", content("n64")).id, content: content("n64") });
    const r = await waysApi.request(`/api/v1/way/${w.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: n64(["Narnia"]) }) });
    expect(r.status).toBe(400);
  });
});

describe("which way, and the dump list a search reads", () => {
  test("a way whose plan has every file it needs comes before a better kind that would wait for a data pack", () => {
    const g = game("Synthetic Needs", { platforms_json: '["n64"]' });
    const c = content("n64", { accept: { hashes: [{ algo: "sha1", value: "7".repeat(40) }], formats: ["z64"] } });
    const needy = insertPlan({ name: "Needs Recomp", kind: "recomp", repo: "find/needs-recomp", platforms: ["n64"], spec: { ...spec(c), needs: [{ kind: "firmware", name: "a data pack", place: "data/pack.bin" }] } as RuntimePlanSpec, status: "ready" });
    made.plans.push(needy.id);
    const recomp = insertWay({ gameId: g.id, planId: needy.id });
    const emu = insertWay({ gameId: g.id, planId: plan("Needs Emu", "emulator", content("n64")).id, content: content("n64", { accept: { hashes: [], formats: ["z64"], serials: ["NSNE"] } }) });
    expect(requestWay(g)?.id).toBe(emu.id);
    updateWay(emu.id, { content: content("n64") });                          // it can prove nothing now: the recomp, which can, first
    expect(requestWay(g)?.id).toBe(recomp.id);
  });

  test("a search never waits for a dump list to download: the fetch runs in the background, and a job waits for it", async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    let calls = 0;
    datdeps.fetchText = async () => { calls++; await gate; return datText("Nintendo - Game Boy Advance", [["Synthetic Advance (USA)", "BSAE", 21]]); };
    forgetDats();
    rmSync(join(tmp, "dats", "gba.dat"), { force: true });
    const g = game("Synthetic Advance", { platforms_json: '["gba"]' });
    const w = insertWay({ gameId: g.id, planId: plan("Advance Emu", "emulator", content("gba" as PlatformId, { accept: { hashes: [], formats: ["gba"] } })).id, content: content("gba" as PlatformId, { search: ["Synthetic Advance"], accept: { hashes: [], formats: ["gba"] } }) });
    const pass = await prepareContentPass(w, g, () => {}, { wait: false });   // answers at once, without the list
    expect(pass).toMatchObject({ dat: null, proves: false });
    expect(calls).toBe(1);
    const job = loadDat("gba");                                              // a job waits for that same fetch, never a second one
    expect(calls).toBe(1);
    open();
    expect((await job)!.entries.map(e => e.name)).toEqual(["Synthetic Advance (USA)"]);
    expect((await prepareContentPass(w, g, () => {}, { wait: false }))!.proves).toBe(true);
    expect(calls).toBe(1);
    datdeps.fetchText = offline;
    dropKept("gba" as PlatformId);
  });

  test("the profile's console-dump switch is about a dump kept as the game's copy: a way's game file is looked for either way, and it says so", () => {
    expect(INSTALL_CLASSES.find(x => x.value === "rom")!.doc).toMatch(/A way to play's game file is looked for whatever this says/);
    const off = { ...P, consoleFallback: false, formats: P.formats.filter(f => f !== "rom") };
    const c = content("ps2", { search: ["Synthetic Saga"], accept: { hashes: [], formats: ["iso"], serials: ["SLUS-29991"] } });
    const ranked = views(["Synthetic Saga"], [rel("Synthetic Saga (USA) PS2", { size: 4e9 })], "ps2", true);
    expect(judgeContent(ranked, { content: c, proves: true, names: c.search }, { profile: off, preferUsenet: false, blocked: new Set(), tried: new Set() }).map(r => r.title)).toEqual(["Synthetic Saga (USA) PS2"]);
  });
});

describe("the dump hand-off judges a dump as the way's own search does", () => {
  const realC = { ...ctdeps };
  beforeAll(() => { ensureDefaultRootFolder(); ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); });
  afterAll(() => { Object.assign(ctdeps, realC); dropKept("ps2"); });
  function romPackage(g: GameRow, file: string, bytes: Uint8Array, platform: string) {
    const dir = join(rootFolders()[0].path, `hand-${g.id}-${file.replace(/[^a-z0-9]+/gi, "-")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), bytes);
    const manifest = { schema: 1, name: g.name, slug: g.slug, version: null, launch: { exe: file, args: "", cwd: "" }, prerequisites: [], files: [], totalSize: bytes.length, source: null, tier: "deterministic", kind: "rom", platform, notes: null, createdAt: "" } as unknown as Manifest;
    return { pkg: stmts.insertPackage.get(g.id, null, dir, g.name, null, bytes.length, JSON.stringify(manifest)) as PackageRow, manifest };
  }
  const builds = (gameId: number) => (db.query("SELECT spec_json FROM jobs WHERE kind='assemble' AND game_id=?").all(gameId) as { spec_json: string }[]).map(j => JSON.parse(j.spec_json) as { wayId: number; auto?: boolean });

  test("a dump the list knows as a beta, or whose name says so, is no file for a way that takes its serial; the retail disc is built by itself", async () => {
    const beta = psIso({ boot: "cdrom0:\\SLUS_299.93;1", seed: 201 });
    const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
    datdeps.fetchText = async () => `clrmamepro (\n\tname "Sony - PlayStation 2"\n\tversion "2026.10.07"\n)\n\ngame (\n\tname "Synthetic Hand Saga (USA) (Beta)"\n\trom ( name "Synthetic Hand Saga (USA) (Beta).iso" size ${beta.length} crc 00000000 md5 ${"2".repeat(32)} sha1 ${sha(beta)} )\n)\n`;
    forgetDats();
    rmSync(join(tmp, "dats", "ps2.dat"), { force: true });
    await loadDat("ps2");
    datdeps.fetchText = offline;
    const g = game("Synthetic Hand Saga", { platforms_json: '["ps2"]' });
    const c = content("ps2", { what: "a PS2 disc image", search: ["Synthetic Hand Saga"], accept: { hashes: [], formats: ["iso"], serials: ["SLUS-29993"] } });
    const w = insertWay({ gameId: g.id, planId: plan("Hand Saga PS2 Emu", "emulator", c).id, content: c });
    const lines: string[] = [];
    const hand = async (file: string, bytes: Uint8Array) => { const p = romPackage(g, file, bytes, "ps2"); await romHandOff({ gameId: g.id, pkg: p.pkg, manifest: p.manifest, log: l => lines.push(l) }); };
    await hand("Synthetic Hand Saga (USA).iso", beta);
    expect(lines.at(-1)).toBe("the dump is no game file for Hand Saga PS2 Emu: the dump list names it Synthetic Hand Saga (USA) (Beta) ((Beta): a development build, not the game as it was sold)");
    await hand("Synthetic Hand Saga (USA) (Beta).iso", psIso({ boot: "cdrom0:\\SLUS_299.93;1", seed: 202 }));
    expect(lines.at(-1)).toBe("the dump is no game file for Hand Saga PS2 Emu: (Beta): a development build, not the game as it was sold");
    expect(getWay(w.id)!.content_id).toBeNull();
    expect(builds(g.id)).toEqual([]);
    await hand("Synthetic Hand Saga (USA) [retail].iso", psIso({ boot: "cdrom0:\\SLUS_299.93;1", seed: 203 }));
    expect(getWay(w.id)!.content_id).not.toBeNull();
    expect(builds(g.id)).toEqual([{ kind: "assemble", wayId: w.id, auto: true } as never]);
  });
});
