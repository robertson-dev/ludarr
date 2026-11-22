/**
 * The admin UI's own rules for games added by hand and ways to play (web/src/ways/logic.ts), held against the engine's:
 * the platforms it offers are the ones the server knows, its repo reading is normalizeRepo's, its limits are
 * validateGameDraft's, what the form sends is accepted, an edit sends only what changed (and a store game only its
 * names and terms), a draft fills only empty fields, an AI run's steps read the way the timeline shows them (a real
 * step-0 run among them), a way's card and the plan's actions say what the engine will do, and a job on screen is read
 * once more after it ends (web/src/ui/job-follow.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { gamesApi } from "../src/api/games";
import { app } from "../src/server";
import { apiKey } from "../src/config";
import { normName as serverNormName } from "../src/catalog/store";
import { PLATFORM_LABEL as SERVER_PLATFORMS, platformId } from "../src/platforms";
import { sdeps } from "../src/search";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { enqueueJob } from "../src/process/kinds";
import { runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { ndeps } from "../src/net/public-url";
import { sbdeps } from "../src/ways/sandbox";
import { prdeps } from "../src/ways/program";
import { cxdeps } from "../src/ways/construct";
import { wdeps } from "../src/ways/api";
import { renderReport, type TryReport } from "../src/ways/construct-tools";
import { insertContent, insertPlan, insertWay, updateWay, wstmts } from "../src/ways/store";
import { normalizeRepo, validateGameDraft, validatePlanSpec } from "../src/ways/validate";
import { fmtSize as apiFmtSize, getBlob, runtime, type JobView, type Plan, type RailState, type RunAsk, type RunView, type Way } from "../web/src/api";
import { followJob } from "../web/src/ui/job-follow";
import { followRun } from "../web/src/ui/run-follow";
import {
  aboutAiSetup, askLines, blobUrl, budgetLine, canCarry, checkJobOf, checkOfTrace, checkShotName, checkWords, constructOutcome, contentLine, copyLine, detailsPatch,
  draftOf, draftReport, emptyForm, fillEmpty, fmtClock, fmtSize, formOf, formProblems, fraction, identityWords, jobBy, jobEnd, jobWay, LIMITS, nextLook, normName, nowShown,
  parseJson, planBuildAction, plansFor, PLATFORM_GROUPS, PLATFORM_LABEL, platformIdOf, platformLabel, programLine, RAIL_PHASES, repoHint, repoUrl, runLine, runLook,
  runNow, runRail, sameGame, sayWho, searchQuery, secondCopy, shotUrl, smokeLine, smokeShots, startedWords, stepIcon, stepTime, toolLine, tryPlanVerdict, watchLine,
  wayCard, wayLook, whenWords, whoWord, type DraftForm, type RailTone,
} from "../web/src/ways/logic";
import { bytes, fake7z, restoreDeps, sha1, sha256, tempConfig, tmp, tools7z, zelda } from "./ways-fixtures";
import { DS_INBOX, DS_ISO, DS_SHARE, dsSecondCopy, dsWay, KYTY, localAt, OOT_SHARE, runSamples } from "./web-runs";

const made: number[] = [];
afterAll(() => { for (const id of made) db.query("DELETE FROM games WHERE id=?").run(id); });

const full = (over: Partial<DraftForm> = {}): DraftForm => ({
  name: "Zelda 64: Recompiled", aliases: ["Majora's Mask Recompiled"], platforms: ["n64", "pc"], year: "2024", releaseIso: "2024-05-17",
  summary: "A native port of Majora's Mask.", genres: ["Action", "Adventure"], developer: "Wiseguy", publisher: "", searchTerms: ["zelda64recomp"], ...over,
});

describe("the platforms the form offers", () => {
  test("are exactly the ids src/platforms.ts knows, with its labels, each in one group", () => {
    expect(PLATFORM_LABEL).toEqual({ ...SERVER_PLATFORMS });
    const grouped = PLATFORM_GROUPS.flatMap(g => g.ids);
    expect([...grouped].sort()).toEqual(Object.keys(SERVER_PLATFORMS).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
  test("a label becomes its id, and validateGameDraft takes what the form sends", () => {
    expect(platformIdOf("Nintendo 64")).toBe("n64");
    expect(platformIdOf("ps2")).toBe("ps2");
    // the stores' own spellings read as the server reads them (Steam: win, mac, lin)
    for (const s of ["win", "Windows", "lin", "mac", "macOS", "osx", "Nintendo 64", "GameCube"]) expect({ s, id: platformIdOf(s) }).toEqual({ s, id: platformId(s) as string });
    expect(platformLabel("lin")).toBe("Linux");
    const v = validateGameDraft(draftOf(full({ platforms: ["Nintendo 64", "gc"] })));
    expect(v.errors).toEqual([]);
    expect(v.value?.platforms).toEqual(["n64", "gc"]);
  });
});

describe("repo addresses", () => {
  const inputs = [
    "https://github.com/Zelda64Recomp/Zelda64Recomp", "github.com/HarbourMasters/Shipwright/releases", "git@github.com:PCSX2/pcsx2.git", "PCSX2/pcsx2",
    "https://codeberg.org/someone/thing", "forgejo:git.eden-emu.dev/eden-emu/eden", "dolphin:beta", "DOLPHIN:dev", "  owner/name.git  ",
    "https://github.com/owner", "not a repo", "", "forgejo:bad_host/x/y", "https://gitlab.com/a/b", "owner/name?tab=readme", "https://github.com/a/b#readme",
  ];
  test("are read as normalizeRepo reads them (the server decides; the hint never disagrees)", () => {
    for (const s of inputs) expect({ s, v: repoHint(s) }).toEqual({ s, v: normalizeRepo(s) as never });
  });
  test("link to the repo's page", () => {
    expect(repoUrl("Zelda64Recomp/Zelda64Recomp")).toBe("https://github.com/Zelda64Recomp/Zelda64Recomp");
    expect(repoUrl("forgejo:codeberg.org/someone/thing")).toBe("https://codeberg.org/someone/thing");
    expect(repoUrl("dolphin:beta")).toBe("https://dolphin-emu.org/download/");
    expect(repoUrl("nonsense")).toBeNull();
  });
});

describe("the game form", () => {
  test("a filled form is a draft the server accepts as it is", () => {
    const v = validateGameDraft(draftOf(full()));
    expect(v.ok).toBe(true);
    expect(v.value).toMatchObject({ name: "Zelda 64: Recompiled", year: 2024, releaseIso: "2024-05-17", publisher: null, searchTerms: ["zelda64recomp"] });
  });
  test("the year follows the date when only the date is given; empty texts are sent as null", () => {
    const d = draftOf({ ...emptyForm("Some Game"), releaseIso: "2031-02-03", summary: "  ", developer: " " });
    expect(d).toMatchObject({ year: 2031, releaseIso: "2031-02-03", summary: null, developer: null, publisher: null });
  });
  test("its limits are the server's: one more than allowed is refused by both, the most allowed by neither", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `name ${i}`);
    for (const k of ["aliases", "searchTerms", "genres"] as const) {
      const over = full({ [k]: many(LIMITS[k] + 1) });
      expect(formProblems(over)[k]).toBeTruthy();
      expect(validateGameDraft(draftOf(over)).ok).toBe(false);
      const most = full({ [k]: many(LIMITS[k]) });
      expect(formProblems(most)[k]).toBeUndefined();
      expect(validateGameDraft(draftOf(most)).ok).toBe(true);
    }
    const plats = Object.keys(SERVER_PLATFORMS);
    expect(formProblems(full({ platforms: plats.slice(0, LIMITS.platforms + 1) })).platforms).toBeTruthy();
    expect(validateGameDraft(draftOf(full({ platforms: plats.slice(0, LIMITS.platforms + 1) }))).ok).toBe(false);
    expect(validateGameDraft(draftOf(full({ platforms: plats.slice(0, LIMITS.platforms) }))).ok).toBe(true);
  });
  test("what it says before sending is what the server would refuse: no name, a bad year, a bad date", () => {
    for (const bad of [full({ name: "  " }), full({ year: "1950", releaseIso: "" }), full({ releaseIso: "2024-13-40", year: "" })]) {
      expect(Object.keys(formProblems(bad)).length).toBeGreaterThan(0);
      expect(validateGameDraft(draftOf(bad)).ok).toBe(false);
    }
    // a year that disagrees with the date: the form says so (the library refuses the add with the same reason)
    expect(formProblems(full({ year: "2023" })).year).toMatch(/disagree/);
  });
  test("the search test asks with the name, the year, every other name, every search term and every platform", () => {
    const p = new URLSearchParams(searchQuery(full({ aliases: ["A", "B"], searchTerms: ["t1", "t2"], platforms: ["Nintendo 64", "pc"] }), true));
    expect(p.get("term")).toBe("Zelda 64: Recompiled");
    expect(p.get("year")).toBe("2024");
    expect(p.getAll("aliases")).toEqual(["A", "B"]);
    expect(p.getAll("terms")).toEqual(["t1", "t2"]);
    expect(p.getAll("platforms")).toEqual(["n64", "pc"]);
    expect(p.get("loose")).toBe("1");
    expect(validateGameDraft({ aliases: p.getAll("aliases"), searchTerms: p.getAll("terms"), platforms: p.getAll("platforms") }, { partial: true }).ok).toBe(true);
  });
});

describe("a draft", () => {
  test("fills only the empty fields and says which", () => {
    const typed = { ...emptyForm("Ship of Harkinian"), developer: "HarbourMasters" };
    const { form, filled } = fillEmpty(typed, { name: "Something Else", developer: "Nintendo", summary: "Ocarina on PC.", genres: ["Adventure"], platforms: ["Nintendo 64"], year: 2022, aliases: ["SoH"] });
    expect(form.name).toBe("Ship of Harkinian");
    expect(form.developer).toBe("HarbourMasters");
    expect(form).toMatchObject({ summary: "Ocarina on PC.", genres: ["Adventure"], platforms: ["n64"], year: "2022", aliases: ["SoH"] });
    expect(filled.sort()).toEqual(["aliases", "genres", "platforms", "summary", "year"]);
  });
  test("leaves out a date that disagrees with a year the admin typed, and caps its lists at the server's limits", () => {
    const { form, filled } = fillEmpty({ ...emptyForm("X"), year: "1998" }, { releaseIso: "2000-01-01", aliases: ["a", "b", "c", "d", "e", "f", "g"] });
    expect(form.releaseIso).toBe("");
    expect(filled).not.toContain("releaseIso");
    expect(form.aliases).toHaveLength(LIMITS.aliases);
  });
  test("nothing, or something that is not a draft, fills nothing", () => {
    expect(fillEmpty(emptyForm("X"), null).filled).toEqual([]);
    expect(fillEmpty(emptyForm("X"), { summary: 42 as never, genres: "Action" as never }).filled).toEqual([]);
  });
});

describe("an edit of a game's details", () => {
  const manualGame = async () => {
    const game = draftOf(full({ name: "Webform Details Check", aliases: ["Majora's Mask Recompiled"] }));
    const res = await gamesApi.request("/api/v1/game", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "manual", game, monitored: false, searchNow: false }) });
    expect(res.status).toBe(201);
    const { item } = await res.json() as { item: any };
    made.push(item.id);
    return item;
  };
  const send = (id: number, patch: unknown) => gamesApi.request(`/api/v1/game/${id}/details`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  test("sends only the fields that changed, and the server takes them", async () => {
    const g = await manualGame();
    const before = formOf(g);
    expect(detailsPatch(before, before, true)).toEqual({});
    const after = { ...before, summary: "Majora's Mask, native on PC.", aliases: [...before.aliases, "MM Recomp"], releaseIso: "2024-05-18" };
    const patch = detailsPatch(before, after, true);
    expect(Object.keys(patch).sort()).toEqual(["aliases", "releaseIso", "summary"]);
    const res = await send(g.id, patch);
    expect(res.status).toBe(200);
    const { item } = await res.json() as { item: any };
    expect(item).toMatchObject({ summary: "Majora's Mask, native on PC.", aliases: ["Majora's Mask Recompiled", "MM Recomp"], releaseIso: "2024-05-18", releaseYear: 2024 });
  });
  test("a store game sends only its other names and search terms, which the server accepts (anything else it refuses)", async () => {
    const row = upsertGame({ igdb_id: null, steam_appid: 9_990_001, name: "Hades", slug: "hades-web-logic", summary: "From Steam.", storyline: null, release_year: 2020, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["win"]', game_modes_json: "[]", developer: "Supergiant", publisher: null }) as GameRow;
    made.push(row.id);
    const before = formOf({ name: row.name, releaseYear: 2020, summary: "From Steam.", developer: "Supergiant", aliases: [], searchTerms: [] });
    const after = { ...before, summary: "edited", developer: "someone", aliases: ["Hades 1"], searchTerms: ["hades supergiant"] };
    const patch = detailsPatch(before, after, false);
    expect(patch).toEqual({ aliases: ["Hades 1"], searchTerms: ["hades supergiant"] });
    expect((await send(row.id, patch)).status).toBe(200);
    expect((await send(row.id, { summary: "edited" })).status).toBe(400);
    expect((stmts.gameById.get(row.id) as GameRow).summary).toBe("From Steam.");
  });
});

describe("an AI run's steps", () => {
  test("a tool call reads as one line", () => {
    expect(toolLine({ tool: "github", input: { op: "file", path: "README.md", ref: "v1.2" } })).toBe("file README.md @ v1.2");
    expect(toolLine({ tool: "shell", input: { cmd: "cmake -B build\nninja -C build" } })).toBe("$ cmake -B build");
    expect(toolLine({ tool: "download", input: { url: "https://example.com/a.zip", name: "a.zip" } })).toBe("a.zip ← https://example.com/a.zip");
    expect(toolLine({ tool: "try_plan", input: { spec: { program: { kind: "release", assetPattern: "Windows\\.zip$" }, launch: { exe: "Game.exe" } } } })).toBe("a dry run: release /Windows\\.zip$/ → Game.exe");
    expect(toolLine({ tool: "finish", input: { ok: false, summary: "MSVC only" } })).toBe("gave up: MSVC only");
    expect(toolLine({ tool: "newtool", input: { a: 1 } })).toBe('{"a":1}');
  });
  test("a try_plan verdict is read from JSON or from text", () => {
    expect(tryPlanVerdict(JSON.stringify({ ok: false, problems: ["launch.exe is not in the program"], warnings: ["no hashes"] }))).toEqual({ ok: false, problems: ["launch.exe is not in the program"], warnings: ["no hashes"] });
    expect(tryPlanVerdict(JSON.stringify({ problems: [], warnings: [] })).ok).toBe(true);
    expect(tryPlanVerdict("PASS — the program starts and its window is up").ok).toBe(true);
    expect(tryPlanVerdict("problems:\n- the exe is missing\n- argv holds {stage}\nwarnings:\n- nightly")).toEqual({ ok: false, problems: ["the exe is missing", "argv holds {stage}"], warnings: ["nightly"] });
    expect(tryPlanVerdict("")).toEqual({ ok: null, problems: [], warnings: [] });
  });
  test("times read as m:ss, JSON mistakes are caught before anything is sent", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(75)).toBe("1:15");
    expect(fmtClock(3725)).toBe("1:02:05");
    expect(parseJson('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    const bad = parseJson('{\n  "a": 1,\n}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^Not valid JSON/);
  });
  test("what a construct job made is found from its manifest, its spec, or the plan that names it", () => {
    expect(constructOutcome({ id: 9, manifest: { planId: 4, wayId: 7, game: { name: "Majora's Mask" } } })).toEqual({ planId: 4, wayId: 7, game: { name: "Majora's Mask" }, runId: null });
    // the carry run that takes the plan on: a new plan's (its manifest), or the run a repair round belongs to (its spec)
    expect(constructOutcome({ id: 9, manifest: { planId: 4, runId: 11 } }).runId).toBe(11);
    expect(constructOutcome({ id: 9, manifest: { planId: 4 }, spec: { kind: "construct", planId: 4, runId: 12, repair: {} } }).runId).toBe(12);
    expect(constructOutcome({ id: 9, manifest: null, spec: { kind: "construct", planId: 3 } }).planId).toBe(3);
    expect(constructOutcome({ id: 9, manifest: null, spec: { kind: "construct" } }, [{ id: 2, jobId: 8 }, { id: 5, jobId: 9 }]).planId).toBe(5);
    expect(constructOutcome({ id: 9 }, []).planId).toBeNull();
  });
  test("a plan's program and game file read as a line", () => {
    expect(programLine({ kind: "release", assetPattern: "Win\\.zip$", channel: "stable" }, { tag: "v1.2", asset: "Win.zip", url: "", size: 1, sha256: "", pinnedAt: 0 })).toBe("the release file matching /Win\\.zip$/ · pinned to v1.2 · Win.zip");
    expect(programLine({ kind: "source", ref: "v2", steps: ["make"], artifact: "build", content: "none" }, null)).toBe("built from source at v2 · not built yet");
    expect(contentLine({ kind: "rom", platform: "n64", what: "Majora's Mask, NTSC-U 1.0", search: [], accept: { hashes: [{ algo: "sha1", value: "a".repeat(40) }], formats: ["z64"] }, place: "mm.z64" }))
      .toBe("Majora's Mask, NTSC-U 1.0 (Nintendo 64) · .z64 · 1 accepted version");
    expect(contentLine(null)).toMatch(/^No game file/);
  });
});

/* ─────────── what the wave-2 review found in the admin UI ─────────── */

const H = { "x-api-key": apiKey(), "content-type": "application/json" };
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
let seq = 0;
const plansMade: number[] = [], jobsMade: number[] = [];
/** a library game with these platforms (it goes, with its ways, when the file is done) */
function libGame(name: string, platforms: string[] = []): GameRow {
  const g = upsertGame({ steam_appid: 9_990_100 + ++seq, name, slug: `web-logic-${seq}` });
  db.query("UPDATE games SET platforms_json=? WHERE id=?").run(JSON.stringify(platforms), g.id);
  made.push(g.id);
  return stmts.gameById.get(g.id) as GameRow;
}
afterAll(() => {
  for (const id of jobsMade) db.query("DELETE FROM jobs WHERE id=?").run(id);
  for (const id of plansMade) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
});
/** a passing or failing dry run as construct-tools.ts reports it */
const report = (over: Partial<TryReport> = {}): TryReport => ({
  n: 1, ok: true, problems: [], warnings: ["no game file to place: only the program was tried (the admin adds the game file to the way)"], env: false,
  kind: "recomp", spec: { launch: { exe: "Zelda64Recompiled.exe", argv: [] } }, key: null, dir: "", built: null, packed: null, tools: null, toolsLookup: null,
  pinned: { tag: "v1.2.2", asset: "Zelda64Recompiled-v1.2.2-Windows.zip", url: "x", size: 30_300_000, sha256: "d02b95f1".padEnd(64, "0"), pinnedAt: 0 },
  exe: "Zelda64Recompiled.exe", files: 44, bytes: 67_200_000, placed: null, smoke: null,
  lines: ["warning: release v1.2.2 is not immutable on GitHub", "- a listing line that starts with a dash", "problems: none of them, this is the log"],
  ...over,
} as unknown as TryReport);

describe("Test the search for a console game (admin-ui-4)", () => {
  const saved = { ...sdeps };
  afterAll(() => Object.assign(sdeps, saved));
  const dump = "Banjo-Kazooie (USA) N64";
  const listing = [{ guid: dump, title: dump, instanceId: 0, indexerId: 1, indexer: "T", size: 1.6e7, age: 10, publishDate: "", seeders: 10, leechers: 0, grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent", categories: [{ id: 1000 }], indexerFlags: [], fileName: null }];
  const rows = (b: any) => (b.items ?? []).map((i: any) => ({ title: i.title, certain: i.certain, allowed: i.allowed }));
  /** the page's own query for the draft, and the saved game's search once the same draft is added */
  const both = async (platforms: string[]) => {
    const page = await call("GET", `/api/v1/release?${searchQuery({ ...emptyForm("Banjo-Kazooie"), year: "1998", platforms })}`);
    const add = await call("POST", "/api/v1/game", { source: "manual", monitored: false, searchNow: false, force: true, game: { name: "Banjo-Kazooie", year: 1998, platforms } });
    made.push(add.json.item.id);
    return { page: rows(page.json), savedGame: rows((await call("GET", `/api/v1/release?gameId=${add.json.item.id}`)).json) };
  };
  for (const where of ["every category", "the console categories only"] as const) {
    test(`a draft with Nintendo 64 picked reads its dump as the saved game's search does (an indexer that lists it under ${where})`, async () => {
      // the PC pass asks without categories (the indexer's PC ones), the console pass with every category ([])
      sdeps.indexers = () => [{ id: 1, name: "T", indexer: { search: async (_t: string, opt?: { categories?: number[] }) => (where === "every category" || opt?.categories?.length === 0 ? listing : []) } as never }];
      const r = await both(["n64"]);
      // the saved game's own search reads the dump as this game (its PC pass may list it too, as not a PC build)
      expect(r.savedGame).toContainEqual({ title: dump, certain: true, allowed: true });
      expect(r.page).toEqual(r.savedGame);
    });
  }
  test("a draft with no platform picked is searched as the saved game will be: the profile's console search follows an empty PC one", async () => {
    sdeps.indexers = () => [{ id: 1, name: "T", indexer: { search: async (_t: string, opt?: { categories?: number[] }) => (opt?.categories?.length === 0 ? listing : []) } as never }];
    expect(new URLSearchParams(searchQuery(emptyForm("Banjo-Kazooie"))).getAll("platforms")).toEqual([""]);
    const r = await both([]);
    expect(r.savedGame.map((x: { title: string }) => x.title)).toEqual([dump]);
    expect(r.page).toEqual(r.savedGame);
  });
});

describe("the timeline reads the engine's own words (admin-ui-5, admin-ui-6, e2e-8)", () => {
  test("a passing dry run as renderReport writes it reads as passed; nothing under 'what it did' is a problem or a warning", () => {
    const pass = renderReport(report());
    expect(pass.split("\n")[0]).toBe("try_plan #1: PASS");
    expect(tryPlanVerdict(pass)).toEqual({ ok: true, problems: [], warnings: ["no game file to place: only the program was tried (the admin adds the game file to the way)"] });
    const notYet = renderReport(report({ n: 2, ok: false, problems: ["launch.exe: Zelda64Recompiled.exe is not in the install folder"] }));
    expect(notYet.split("\n")[0]).toMatch(/^try_plan #2: NOT YET/);
    expect(tryPlanVerdict(notYet)).toEqual({ ok: false, problems: ["launch.exe: Zelda64Recompiled.exe is not in the install folder"], warnings: ["no game file to place: only the program was tried (the admin adds the game file to the way)"] });
    // a pass with nothing to warn about still says it worked
    expect(tryPlanVerdict(renderReport(report({ warnings: [] }))).ok).toBe(true);
  });
  test("words recorded as turn 0 are ludarr's own list's; the AI's (turn 1 on) are the AI importer's", () => {
    expect(sayWho({ turn: 0 })).toBe("ludarr's own list");
    expect(sayWho({ turn: 1 })).toBe("The AI importer");
    expect(sayWho({ turn: 7 })).toBe("The AI importer");
  });
  test("the Jobs table says the AI importer only for a run that used it, and nobody for a run that never started", () => {
    expect(jobBy("construct", "agent")).toBe("AI importer");
    expect(jobBy("construct", "deterministic")).toBe("ludarr's own list");
    expect(jobBy("import", "agent")).toBe("AI importer");
    expect(jobBy(undefined, "deterministic")).toBe("recipes");
    expect(jobBy("assemble", "deterministic")).toBeNull();
    // the runner writes the tier as a job starts: one still queued, or cancelled before it started, has none
    expect(jobBy("construct", null)).toBeNull();
  });
  test("a construct job cancelled before it started is nobody's work", async () => {
    const j = enqueueJob({ kind: "construct", repo: "Zelda64Recomp/Zelda64Recomp" });
    jobsMade.push(j.id);
    expect(jobBy(j.kind, j.tier)).toBeNull();
    expect((await call("POST", `/api/v1/jobs/${j.id}/cancel`)).status).toBe(200);
    const row = stmts.jobById.get(j.id) as JobRow;
    expect({ state: row.state, tier: row.tier }).toEqual({ state: "cancelled", tier: null });
    expect(jobBy(row.kind, row.tier)).toBeNull();
  });

  describe("a real step-0 run (Zelda64Recomp, ludarr's own list, no model)", () => {
    const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(3000, 7)]);
    const MM_ASSET = "Zelda64Recompiled-v1.2.2-Windows.zip", MM_URL = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.2/${MM_ASSET}`;
    let cfg: ReturnType<typeof tempConfig>;
    const savedCx = { ...cxdeps };
    beforeAll(() => {
      cfg = tempConfig();
      ensureDefaultRootFolder();
      pdeps.log = () => {};
      pdeps.tools = () => ({ ...tools7z });
      sbdeps.platform = () => "win32";
      sbdeps.exec = fake7z({ [MM_ASSET]: zelda });
      ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
      ndeps.fetch = (async (url: string) => (url === MM_URL ? new Response(new Uint8Array(ZIP), { headers: { "content-length": String(ZIP.byteLength) } }) : new Response("nope", { status: 404 }))) as typeof ndeps.fetch;
      prdeps.latestRelease = async () => ({ tag: "v1.2.2", name: "v1.2.2", date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: MM_ASSET, url: MM_URL, size: ZIP.byteLength, digest: `sha256:${sha256(ZIP)}` } });
      cxdeps.ai = () => null; cxdeps.lookup = async () => []; cxdeps.igdb = () => null;
    });
    afterAll(() => { restoreDeps(); Object.assign(cxdeps, savedCx); cfg.restore(); });
    test("its dry run reads as passed, its words as ludarr's own list's, and the Jobs table does not say AI importer", async () => {
      const j0 = enqueueJob({ kind: "construct", repo: "Zelda64Recomp/Zelda64Recomp" });
      jobsMade.push(j0.id);
      await runJob(j0.id);
      const j = stmts.jobById.get(j0.id) as JobRow;
      expect(j.state).toBe("done");
      const trace = JSON.parse(j.trace_json ?? "[]") as { turn: number; kind: string; tool?: string; output?: string }[];
      const dry = trace.find(s => s.tool === "try_plan");
      expect(dry?.output?.split("\n")[0]).toBe("try_plan #1: PASS");
      expect(tryPlanVerdict(dry?.output).ok).toBe(true);
      const said = trace.filter(s => s.kind === "say");
      expect(said.length).toBeGreaterThan(0);
      expect(said.map(s => sayWho(s))).toEqual(said.map(() => "ludarr's own list"));
      expect(jobBy(j.kind, j.tier)).toBe("ludarr's own list");
      const planId = JSON.parse(j.manifest_json ?? "{}").planId;
      if (planId) plansMade.push(planId);
    }, 60_000);
  });
});

describe("a job on screen (job-follow.ts, behind useJob: admin-ui-1)", () => {
  /** timers the test moves by hand */
  function clock() {
    let now = 0, n = 0;
    const due = new Map<number, { at: number; fn: () => void }>();
    return {
      timers: { set: (fn: () => void, ms: number) => { due.set(++n, { at: now + ms, fn }); return n; }, clear: (t: unknown) => { due.delete(t as number); } },
      async advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          due.delete(next[0]); now = next[1].at; next[1].fn();
          await settle();
        }
        now = end;
      },
    };
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const step = (n: number) => ({ turn: 0, t: n, kind: "tool", tool: `step${n}` });
  function server(first: Partial<JobView>) {
    let row = { id: 7, state: "running", trace: [step(1)], transcript: "one", ...first } as JobView;
    const listeners = new Set<(ev: string, d: unknown) => void>();
    let reads = 0;
    return {
      set: (over: Partial<JobView>) => { row = { ...row, ...over } as JobView; },
      emit: (ev: string, d: unknown) => { for (const l of listeners) l(ev, d); },
      get reads() { return reads; },
      opts: (c: ReturnType<typeof clock>, seen: JobView[]) => ({
        load: async () => { reads++; return JSON.parse(JSON.stringify(row)) as JobView; },
        subscribe: (l: (ev: string, d: unknown) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        onConnection: () => () => {},
        onJob: (j: JobView, full: boolean) => { if (full) seen.push(j); },
        onError: () => {},
        timers: c.timers, every: 2000, settle: 1500,
      }),
    };
  }
  test("the last steps and lines, written just after the event that says the job ended, still reach the page", async () => {
    const c = clock(), s = server({}), seen: JobView[] = [];
    const stop = followJob(7, s.opts(c, seen));
    await settle();
    expect(seen.at(-1)?.state).toBe("running");
    // the runner saves 'done' and sends its event, then writes the try_plan step and the last log lines
    s.set({ state: "done" });
    s.emit("job", { id: 7, state: "done" });
    await settle();
    expect(seen.at(-1)).toMatchObject({ state: "done", trace: [step(1)] });
    s.set({ trace: [step(1), step(2)], transcript: "one\ntwo" });
    await c.advance(1500);
    expect(seen.at(-1)).toMatchObject({ state: "done", trace: [step(1), step(2)], transcript: "one\ntwo" });
    // and then nothing more is read
    const reads = s.reads;
    await c.advance(60_000);
    expect(s.reads).toBe(reads);
    stop();
  });
  test("a running job is read every few seconds and its end is caught without an event; an ended one is read once; nothing after it is closed", async () => {
    const c = clock(), s = server({}), seen: JobView[] = [];
    const stop = followJob(7, s.opts(c, seen));
    await settle();
    await c.advance(2000);
    expect(s.reads).toBe(2);
    s.set({ state: "failed", trace: [step(1), step(2)] });
    await c.advance(2000);                       // the poll sees it ended
    expect(seen.at(-1)?.state).toBe("failed");
    s.set({ transcript: "one\nthe compiler's error" });
    await c.advance(1500);                       // and reads it once more
    expect(seen.at(-1)?.transcript).toBe("one\nthe compiler's error");
    stop();
    const reads = s.reads;
    s.emit("job", { id: 7, state: "failed" });
    await c.advance(60_000);
    expect(s.reads).toBe(reads);
    // a job that had ended before it was opened: one read
    const c2 = clock(), s2 = server({ state: "done" }), seen2: JobView[] = [];
    const stop2 = followJob(7, s2.opts(c2, seen2));
    await settle();
    await c2.advance(60_000);
    expect(s2.reads).toBe(1);
    stop2();
  });
  test("what an event carries freshens the record in between, without a read", async () => {
    const c = clock(), s = server({}), all: [JobView, boolean][] = [];
    const stop = followJob(7, { ...s.opts(c, []), onJob: (j: JobView, full: boolean) => { all.push([j, full]); } });
    await settle();
    s.emit("build", { id: 7, state: "running", progress: 0.5, message: "unpacking" });
    s.emit("build", { id: 8, state: "running", progress: 0.9, message: "another job" });
    expect(all.at(-1)).toEqual([expect.objectContaining({ progress: 0.5, message: "unpacking", trace: [step(1)] }), false]);
    expect(s.reads).toBe(1);
    stop();
  });
});

describe("a way's card (admin-ui-7, admin-ui-9, admin-ui-10)", () => {
  const PIN = { tag: "v2.2.0", asset: "pcsx2.7z", url: "u", size: 1, sha256: "s", pinnedAt: 1 };
  const plan = (program: unknown, over: Partial<Plan> = {}) => ({ spec: { program }, pinned: null, status: "ready", ...over }) as unknown as Plan;
  const way = (over: Partial<Way> = {}) => ({ status: "ready", job: null, blockers: [], plan: { status: "ready" }, ...over }) as unknown as Way;
  const job = (over: Partial<JobView>) => ({ id: 31, state: "queued", kind: "build", spec: { kind: "build", planId: 2, wayId: 5 }, progress: 0, message: null, ...over }) as unknown as JobView;
  const release = { kind: "release", assetPattern: "x", channel: "stable" }, perGame = { kind: "source", ref: "nightly", steps: ["make"], artifact: "build", content: "build" };

  test("a way with its files whose plan still has to be checked, mended or built reads 'Waiting for its plan', not 'Ready to build'", () => {
    const blocked = way({ blockers: [{ code: "plan", error: "the plan has not been checked yet: check it first" }], plan: { status: "draft" } as Way["plan"] });
    expect(wayCard(blocked, plan(release, { status: "draft" }), null).look).toEqual({ label: "Waiting for its plan", tone: "warning" });
    expect(wayCard(way(), plan(release), null).look.label).toBe("Ready to build");
    // the plan dialog's ways table has only the way's status and the plan's
    expect(wayLook({ status: "ready" }, "broken").label).toBe("Waiting for its plan");
    expect(wayLook({ status: "ready" }, "ready").label).toBe("Ready to build");
    expect(wayLook({ status: "needs-files" }, "draft").label).toBe("Needs files");
    expect(wayLook({ status: "built" }, "draft").label).toBe("Built");
  });
  test("a pinned release or feed plan offers its repin whatever the way's state: 'Update the program' once built, 'Build with the newest release' before", () => {
    expect(wayCard(way({ status: "built" }), plan(release, { pinned: PIN }), null).repin).toBe("Update the program");
    expect(wayCard(way({ status: "failed" }), plan(release, { pinned: PIN }), null).repin).toBe("Build with the newest release");
    expect(wayCard(way({ status: "ready" }), plan({ kind: "feed", feed: "dolphin:beta" }, { pinned: PIN }), null).repin).toBe("Build with the newest release");
    expect(wayCard(way({ status: "failed" }), plan(release), null).repin).toBeNull();                       // nothing pinned: Build takes the newest
    expect(wayCard(way({ status: "built" }), plan(perGame, { pinned: { ...PIN, tag: `nightly@${"a".repeat(40)}` } }), null).repin).toBeNull();
  });
  test("a per-game plan's first build shows on the card while it is queued or running, from the server or from its first event", () => {
    // the server lists it on the way (wayItem.job)
    const served = wayCard(way({ job: job({}), blockers: [{ code: "plan", error: "…build it from source for this game first" }] }), plan(perGame, { status: "draft" }), null);
    expect(served).toMatchObject({ building: true, look: { label: "Queued to build" }, perGameFirst: true });
    expect(served.job?.kind).toBe("build");
    // its first event, before the page has reloaded
    expect(jobWay(job({}))).toBe(5);
    expect(jobWay(job({ kind: "assemble", spec: { kind: "assemble", wayId: 9 } }))).toBe(9);
    expect(jobWay(job({ spec: { kind: "build", planId: 2 } }))).toBeNull();                               // a plan-wide build is no way's
    expect(jobWay(job({ kind: "construct", spec: { kind: "construct", wayId: 5 } }))).toBeNull();
    const ticked = wayCard(way(), plan(perGame, { status: "draft" }), job({ state: "running", progress: 0.4 }));
    expect(ticked).toMatchObject({ building: true, look: { label: "Building" } });
    // once it has ended the card is back to the way's own state
    expect(wayCard(way(), plan(perGame, { status: "draft" }), job({ state: "done" })).building).toBe(false);
    // pinned at a commit, the plan is no longer before its first build
    expect(wayCard(way(), plan(perGame, { status: "draft", pinned: { ...PIN, tag: `nightly@${"b".repeat(40)}` } }), null).perGameFirst).toBe(false);
  });

  describe("held against the engine's ways", () => {
    let cfg: ReturnType<typeof tempConfig>;
    beforeAll(() => { cfg = tempConfig(); });
    afterAll(() => cfg.restore());
    test("a hand-written (draft) plan's way with its file: 'ready' to the engine, 'Waiting for its plan' on the card until the plan is checked", async () => {
      const rom = bytes(32 * 1024, 2);
      const spec = {
        program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "Zelda64Recompiled.exe", argv: [] },
        content: { kind: "rom", platform: "n64", what: "MM US", search: ["The Legend of Zelda: Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha1(rom) }], formats: ["z64"] }, normalize: "n64-z64", place: "mm.n64.us.1.0.z64" },
        files: [], setup: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: null,
      };
      const p = await call("POST", "/api/v1/plan", { name: "MM by hand (web-logic)", kind: "recomp", repo: "Zelda64Recomp/Zelda64Recomp", spec });
      expect(p.status).toBe(201);
      plansMade.push(p.json.item.id);
      // the game the recomp plays, by its own name (the ways route refuses a recomp for a game it does not play)
      const g = libGame("The Legend of Zelda: Majora's Mask", ["n64"]);
      const path = join(tmp("web-logic-rom-"), "mm.z64");
      writeFileSync(path, rom);
      insertContent({ gameId: g.id, platform: "n64", name: "mm.z64", path, size: rom.byteLength, hashes: { sha1: sha1(rom) }, source: "upload" });
      const added = await call("POST", `/api/v1/game/${g.id}/ways`, { planId: p.json.item.id });
      expect(added.status).toBe(201);
      const listed = async () => (await call("GET", `/api/v1/game/${g.id}/ways`)).json.items[0] as Way;
      const w = await listed();
      expect({ status: w.status, canBuild: w.canBuild }).toEqual({ status: "ready", canBuild: false });
      expect(wayCard(w, null, null).look.label).toBe("Waiting for its plan");
      db.query("UPDATE runtime_plans SET status='ready' WHERE id=?").run(p.json.item.id);
      const after = await listed();
      expect(after.canBuild).toBe(true);
      expect(wayCard(after, null, null).look.label).toBe("Ready to build");
    });
  });
});

describe("the way out when a pinned release is gone from its host (admin-ui-7)", () => {
  const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(3000, 7)]);
  const OLD = "Zelda64Recompiled-v1.2.1-Windows.zip", OLD_URL = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.1/${OLD}`;
  const NEW = "Zelda64Recompiled-v1.2.2-Windows.zip", NEW_URL = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.2/${NEW}`;
  const newest = { tag: "v1.2.2", name: "v1.2.2", date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: NEW, url: NEW_URL, size: ZIP.byteLength, digest: `sha256:${sha256(ZIP)}` } };
  let cfg: ReturnType<typeof tempConfig>;
  const savedW = { ...wdeps };
  beforeAll(() => {
    cfg = tempConfig();
    ensureDefaultRootFolder();
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    pdeps.log = () => {};
    pdeps.tools = () => ({ ...tools7z });
    sbdeps.platform = () => "win32";
    sbdeps.exec = fake7z({ [NEW]: zelda, [OLD]: zelda });
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    // the host still has the newest release; the pinned one answers 404
    ndeps.fetch = (async (url: string) => (url === NEW_URL ? new Response(new Uint8Array(ZIP), { headers: { "content-length": String(ZIP.byteLength) } }) : new Response("gone", { status: 404 }))) as typeof ndeps.fetch;
    prdeps.latestRelease = async () => newest;
    wdeps.latestRelease = async () => newest as never;
  });
  afterAll(() => { delete process.env.LUDARR_ALLOW_UNSANDBOXED; restoreDeps(); Object.assign(wdeps, savedW); cfg.restore(); });

  test("a way whose build found the pinned file gone still offers 'Build with the newest release' once Check has made the plan ready again, though a file landing set the way back to ready; pressing it builds", async () => {
    const rom = bytes(64 * 1024, 9);
    const g = libGame("The Legend of Zelda: Majora's Mask (repin)", ["n64"]);
    const spec = validatePlanSpec({
      program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "Zelda64Recompiled.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "Majora's Mask, NTSC-U 1.0", search: ["The Legend of Zelda: Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha1(rom) }], formats: ["z64"] }, normalize: "n64-z64", place: "mm.n64.us.1.0.z64" },
      files: [{ path: "portable.txt", text: "" }], setup: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: null,
    }, "recomp");
    expect(spec.errors).toEqual([]);
    const p = insertPlan({ name: "Zelda 64: Recompiled (repin)", kind: "recomp", repo: "Zelda64Recomp/Zelda64Recomp", platforms: ["n64"], spec: spec.value!, status: "ready" });
    plansMade.push(p.id);
    wstmts.setPinned.run(JSON.stringify({ tag: "v1.2.1", asset: OLD, url: OLD_URL, size: ZIP.byteLength, sha256: sha256(ZIP), pinnedAt: 1 }), p.id);
    const path = join(tmp("web-logic-repin-"), "mm.z64");
    writeFileSync(path, rom);
    const file = insertContent({ gameId: g.id, platform: "n64", name: "mm.z64", path, size: rom.byteLength, hashes: { sha1: sha1(rom) }, source: "upload" });
    const w = insertWay({ gameId: g.id, planId: p.id });
    updateWay(w.id, { contentId: file.id });
    const card = async () => {
      const listed = (await call("GET", `/api/v1/game/${g.id}/ways`)).json.items.find((x: Way) => x.id === w.id) as Way;
      return { w: listed, repin: wayCard(listed, (await call("GET", `/api/v1/plan/${p.id}`)).json.item, null).repin };
    };
    const build = async (body: unknown) => {
      const r = await call("POST", `/api/v1/way/${w.id}/build`, body);
      expect(r.status).toBe(202);
      jobsMade.push(r.json.job.id);
      await runJob(r.json.job.id);
      return stmts.jobById.get(r.json.job.id) as JobRow;
    };
    // Build: the pinned file is gone, and the plan is broken
    expect((await build({})).message).toBe("the pinned release file is gone from its host; check the plan and repin it");
    // another file of the game lands: the game's ways settle, and this one reads ready again, no longer failed
    const landed = await app.request(`/api/v1/content?gameId=${g.id}&name=${encodeURIComponent("Other (USA).z64")}`, { method: "POST", headers: { "x-api-key": apiKey(), "content-type": "application/octet-stream" }, body: bytes(8 * 1024, 3) });
    expect(landed.status).toBe(201);
    expect((await card()).w).toMatchObject({ status: "ready", plan: { status: "broken" } });
    // Check makes the plan ready again, still pinned to the gone file: to the card this way is now like one never built,
    // and Build alone would fail the same way again
    expect((await call("POST", `/api/v1/plan/${p.id}/check`)).json.item).toMatchObject({ status: "ready", pinned: { tag: "v1.2.1" } });
    const checked = await card();
    expect({ status: checked.w.status, plan: checked.w.plan?.status, canBuild: checked.w.canBuild }).toEqual({ status: "ready", plan: "ready", canBuild: true });
    expect(checked.repin).toBe("Build with the newest release");
    // the button's own call takes the newest release, builds, and pins it
    expect((await build({ repin: true })).state).toBe("done");
    const built = await card();
    expect(built.w.status).toBe("built");
    expect(built.repin).toBe("Update the program");
    expect((await call("GET", `/api/v1/plan/${p.id}`)).json.item.pinned.tag).toBe("v1.2.2");
  }, 60_000);
});

describe("the plan's own build action (admin-ui-8)", () => {
  const tools = { ref: "{tag}", steps: ["make -C tools"], outputs: ["tools/extract"] };
  test("a ready-made program with tools offers 'Build its tools'; one built from source 'Build from source'; per game or nothing to build, none", () => {
    expect(planBuildAction({ program: { kind: "release", assetPattern: "x", channel: "stable" }, tools })).toBe("Build its tools");
    expect(planBuildAction({ program: { kind: "feed", feed: "dolphin:beta" }, tools })).toBe("Build its tools");
    expect(planBuildAction({ program: { kind: "release", assetPattern: "x", channel: "stable" }, tools: null })).toBeNull();
    expect(planBuildAction({ program: { kind: "source", ref: "v1", steps: ["make"], artifact: "out", content: "none" }, tools })).toBe("Build from source");
    expect(planBuildAction({ program: { kind: "source", ref: "v1", steps: ["make"], artifact: "out", content: "build" }, tools })).toBeNull();
  });
  test("the route the action calls takes a release plan's tools (it is the only way they get built)", async () => {
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    try {
      const checked = validatePlanSpec({
        program: { kind: "release", assetPattern: "^SoH-.*-Win64[.]zip$", channel: "stable" }, launch: { exe: "soh.exe", argv: [] },
        content: { kind: "rom", platform: "n64", what: "Ocarina of Time, NTSC 1.0", search: ["The Legend of Zelda: Ocarina of Time"], accept: { hashes: [{ algo: "sha1", value: "a".repeat(40) }], formats: ["z64"] }, normalize: "n64-z64", place: "oot.z64", ship: false },
        tools, setup: [{ run: { tool: "tools/extract", argv: ["{content}", "{stage}/oot.o2r"], wine: false, timeoutSec: 600 } }],
        files: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: null,
      }, "port");
      expect(checked.errors).toEqual([]);
      expect(planBuildAction(checked.value!)).toBe("Build its tools");
      const plan = insertPlan({ name: "Ship of Harkinian (web-logic)", kind: "port", repo: "HarbourMasters/Shipwright", platforms: ["n64"], spec: checked.value!, status: "ready" });
      plansMade.push(plan.id);
      const r = await call("POST", `/api/v1/plan/${plan.id}/build`, {});
      expect(r.status).toBe(202);
      jobsMade.push(r.json.job.id);
      await call("POST", `/api/v1/jobs/${r.json.job.id}/cancel`);
    } finally { delete process.env.LUDARR_ALLOW_UNSANDBOXED; }
  });
});

describe("Draft with AI says where each field came from (admin-ui-12)", () => {
  const savedCx = { ...cxdeps };
  beforeEach(() => { cxdeps.ai = () => null; cxdeps.igdb = () => null; });
  afterEach(() => Object.assign(cxdeps, savedCx));
  const draft = async (name: string) => (await call("POST", "/api/v1/game/draft", { name })).json as { draft: any; from: string[]; fields: Record<string, string>; inLibrary: number | null };
  test("each filled field is marked with its own source, in words; the name the admin typed is not a source", async () => {
    cxdeps.lookup = async () => [{ id: { scheme: "steam", value: "367520" }, name: "Hollow Knight", year: 2017, releaseIso: "2017-02-24", platforms: ["win", "mac", "lin"], cover: null, summary: "Forge your own path in Hollow Knight! An epic action adventure through a vast ruined kingdom of insects and heroes.", source: "steam", gameId: null, status: null }];
    const r = await draft("Hollow Knight");
    const { filled } = fillEmpty(emptyForm("Hollow Knight"), r.draft);
    const said = draftReport(filled, r.fields);
    expect(filled).not.toContain("name");
    expect(Object.values(said.marks)).toEqual(filled.map(() => "from Steam"));
    expect(said.sources).toEqual(["Steam"]);
    expect(said.found).toBe(true);
    expect(r.inLibrary).toBeNull();
  });
  test("a game nobody knows: nothing found (not 'typed had nothing'); a library hit names the library and the game", async () => {
    cxdeps.lookup = async () => [];
    const none = await draft("Some Homebrew Game");
    const empty = draftReport(fillEmpty(emptyForm("Some Homebrew Game"), none.draft).filled, none.fields);
    expect(empty).toEqual({ marks: {}, sources: [], found: false });
    const g = libGame("Celeste (web-logic)", ["pc"]);
    cxdeps.lookup = async () => [{ id: { scheme: "steam", value: "504230" }, name: "Celeste (web-logic)", year: 2018, releaseIso: null, platforms: ["pc"], cover: null, summary: null, source: "library", gameId: g.id, status: null }];
    const hit = await draft("Celeste (web-logic)");
    expect(hit.inLibrary).toBe(g.id);
    const said = draftReport(fillEmpty(emptyForm("Celeste (web-logic)"), hit.draft).filled, hit.fields);
    expect(said.sources).toEqual(["your library"]);
  });
  test("every source the engine names has words", () => {
    const filled = ["name", "aliases", "platforms", "year", "summary", "genres", "developer"] as const;
    const fields = { name: "typed", aliases: "curated", platforms: "catalog", year: "igdb", summary: "ai", genres: "library", developer: "steam" };
    expect(Object.values(draftReport([...filled], fields).marks)).toEqual(["from what you typed", "from ludarr's own list", "from the catalog", "from IGDB", "from the AI importer", "from your library", "from Steam"]);
  });
});

describe("plans for a game and the refusals the pages explain (admin-ui-13, admin-ui-14)", () => {
  test("names read as the engine reads them, and the same game is found by its name or its subtitle, never by a shared start", () => {
    for (const s of ["The Legend of Zelda™: Majora’s Mask", "Final Fantasy VII", "Ratchet & Clank", "Pokémon Snap", "The", "  "]) expect({ s, n: normName(s) }).toEqual({ s, n: serverNormName(s) });
    expect(sameGame(["The Legend of Zelda: Majora's Mask"], ["Majora's Mask"])).toBe(true);
    expect(sameGame(["Zelda 64: Recompiled", "Majora's Mask"], ["The Legend of Zelda: Majora's Mask"])).toBe(true);
    expect(sameGame(["Sonic the Hedgehog"], ["Sonic the Hedgehog 2"])).toBe(false);
    expect(sameGame(["Hollow Knight"], ["The Legend of Zelda: Majora's Mask"])).toBe(false);
    expect(sameGame(["Banjo-Kazooie"], ["Banjo-Tooie"])).toBe(false);
  });
  test("the plans that play this game come first: its recomp or port by name, an emulator of one of its platforms", () => {
    const mk = (id: number, kind: string, platforms: string[], content: unknown) => ({ id, kind, platforms, spec: { content } }) as unknown as Plan;
    const zelda64 = mk(1, "recomp", ["n64"], { platform: "n64", search: ["The Legend of Zelda: Majora's Mask"] });
    const soh = mk(2, "port", ["n64"], { platform: "n64", search: ["The Legend of Zelda: Ocarina of Time"] });
    const pcsx2 = mk(3, "emulator", ["ps2"], { platform: "ps2", search: [] });
    const m64 = mk(4, "emulator", ["n64"], { platform: "n64", search: [] });
    const free = mk(5, "port", [], null);
    const r = plansFor({ name: "The Legend of Zelda: Majora's Mask", aliases: ["MM"], platforms: ["Nintendo 64"] }, [soh, pcsx2, zelda64, free, m64]);
    expect(r.fits.map(p => p.id)).toEqual([1, 4]);
    expect(r.others.map(p => p.id)).toEqual([2, 3, 5]);
    expect(plansFor({ name: "Hollow Knight", platforms: ["win"] }, [zelda64, pcsx2]).fits).toEqual([]);
  });
  test("only a refusal about the AI importer's setup points at Settings → Importers", async () => {
    const savedCx = { ...cxdeps };
    cxdeps.ai = () => null;
    try {
      const unknown = await call("POST", "/api/v1/plan/construct", { repo: "someone/not-a-known-port" });
      expect(unknown.status).toBe(409);
      expect(aboutAiSetup(unknown.json.error)).toBe(true);
      const hk = libGame("Hollow Knight (web-logic)", ["pc"]);
      const wrong = await call("POST", "/api/v1/plan/construct", { repo: "Zelda64Recomp/Zelda64Recomp", gameId: hk.id });
      expect(wrong.status).toBe(409);
      expect(wrong.json.error).toMatch(/does not look like that game/);
      expect(aboutAiSetup(wrong.json.error)).toBe(false);
      expect(aboutAiSetup("that file was kept for another game")).toBe(false);
      expect(aboutAiSetup("set up the AI importer first (Settings → Importers): rebuilding a plan or following a note needs it")).toBe(true);
    } finally { Object.assign(cxdeps, savedCx); }
  });
});

describe("a file on the server that does not fit its way (admin-ui-15)", () => {
  test("a content job that says the file is not the one its way needs ends as a warning, not as kept", () => {
    expect(jobEnd({ state: "done", message: "kept Super Mario 64 (USA).z64 (32 KB) — not the file Zelda 64: Recompiled needs: not the version this needs (its sha1 is 1234…)" })).toBe("warn");
    expect(jobEnd({ state: "done", message: "kept Legend of Zelda, The - Majora's Mask (USA).z64 (32 MB)" })).toBe("ok");
    expect(jobEnd({ state: "done", message: "already kept as mm.z64" })).toBe("ok");
    expect(jobEnd({ state: "failed", message: "the path is outside the folders ludarr may read" })).toBe("bad");
    expect(jobEnd({ state: "cancelled", message: "cancelled" })).toBe("bad");
  });
});

describe("the smoke start's screenshot (admin-ui-16)", () => {
  test("is found in a try_plan output as renderReport writes it", () => {
    const out = renderReport(report({ smoke: { titles: ["Zelda 64: Recompiled"], screenshot: "/config/ways/shots/job-12-3.png", note: null } as TryReport["smoke"] }));
    expect(out).toContain("smoke start: screenshot job-12-3.png (attached)");
    expect(smokeShots(out)).toEqual([{ jobId: 12, n: 3 }]);
    expect(smokeShots(renderReport(report()))).toEqual([]);
  });
  test("is fetched from its route by the API client and shown from an object URL, revoked when the step goes", async () => {
    const asked: string[] = [];
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const revoked: string[] = [];
    const realRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (u: string) => { revoked.push(u); realRevoke(u); };
    try {
      const shown = shotUrl(12, 3, async p => { asked.push(p); return png; });
      const url = await shown.ready;
      expect(asked).toEqual(["/api/v1/plan/construct/12/shot/3"]);
      expect(url).toMatch(/^blob:/);
      expect(url).not.toMatch(/apikey/i);
      shown.stop();
      expect(revoked).toEqual([url!]);
      // a step that goes before the picture arrives: its URL is revoked as soon as it is made
      let arrive!: (b: Blob) => void;
      const late = shotUrl(12, 4, () => new Promise<Blob>(r => { arrive = r; }));
      late.stop();
      arrive(png);
      expect(await late.ready).toBeNull();
      expect(revoked).toHaveLength(2);
      // one that is not kept any more
      expect(await shotUrl(12, 5, async () => { throw new Error("no such screenshot"); }).ready).toBeNull();
    } finally { URL.revokeObjectURL = realRevoke; }
  });
  test("the API client fetches it with the key in the header (an <img> address would have to carry it), and says why it is not there", async () => {
    const realFetch = globalThis.fetch, realKey = runtime.apiKey;
    const asked: { url: string; key: string | null }[] = [];
    runtime.apiKey = "key-of-the-test";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
      return String(url).endsWith("/shot/3") ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } })
        : new Response(JSON.stringify({ error: "no such screenshot" }), { status: 404, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const png = await getBlob("/api/v1/plan/construct/12/shot/3");
      expect(png.size).toBe(4);
      expect(asked).toEqual([{ url: "/api/v1/plan/construct/12/shot/3", key: "key-of-the-test" }]);
      await expect(getBlob("/api/v1/plan/construct/12/shot/4")).rejects.toThrow("no such screenshot");
    } finally { globalThis.fetch = realFetch; runtime.apiKey = realKey; }
  });
});

/* ─────────── a carry run: a repo carried all the way to a game members install (DESIGN3 B4 item 4) ─────────── */

/** noon on the day of the live cases, in this machine's own time zone (the words say local times) */
const NOW = new Date(2026, 10, 8, 12, 0).getTime() / 1000;
const S = runSamples(NOW);

describe("a carry run's rail", () => {
  const LOOK: Record<RailState, [string, string, RailTone]> = {
    done: ["check", "done", "ok"], active: ["spinner", "working on it", "active"], waiting: ["clock", "waiting", "wait"], asked: ["help", "asks you", "ask"],
    failed: ["x", "failed", "bad"], env: ["minusCircle", "not checked here", "env"], todo: ["circle", "not yet", "todo"],
  };
  test("has the five phases in order, every phase in every state with its icon and words; a phase the server does not list is still to come", () => {
    for (const phase of RAIL_PHASES) for (const state of Object.keys(LOOK) as RailState[]) {
      const steps = runRail({ state: "active", rail: [{ phase, state, summary: "what it says" }] });
      expect(steps.map(s => s.label)).toEqual(["Plan", "Game", "Game file", "Build", "Check"]);
      const s = steps.find(x => x.phase === phase)!;
      const [icon, words, tone] = LOOK[state];
      // only the check's env means "not checked here"; any other phase the server cannot do now
      expect({ phase, state, icon: s.icon, words: s.words, tone: s.tone, summary: s.summary }).toEqual({ phase, state, icon, words: state === "env" && phase !== "check" ? "the server cannot do it now" : words, tone, summary: "what it says" });
      expect(steps.filter(x => x.phase !== phase).map(x => x.state)).toEqual(["todo", "todo", "todo", "todo"]);
    }
    expect(runRail(S.ds).map(s => `${s.label}: ${s.words}`)).toEqual(["Plan: done", "Game: done", "Game file: asks you", "Build: not yet", "Check: not yet"]);
    expect(runRail(S.mm).find(s => s.phase === "check")).toMatchObject({ words: "not checked here", summary: "not started here: the server has no graphics device" });
  });
  test("a stopped run shows no phase as still working, and a run on hold none as moving; a held run's go-ahead still asks", () => {
    for (const state of ["active", "waiting", "asked"] as RailState[]) {
      expect(runRail({ state: "stopped", rail: [{ phase: "build", state, summary: null }] }).find(s => s.phase === "build")).toMatchObject({ icon: "minusCircle", words: "stopped here" });
    }
    expect(runRail(S.nxHeld).find(s => s.phase === "build")).toMatchObject({ icon: "clock", words: "on hold", summary: "building the game on the server" });
    expect(runRail(S.zelda).find(s => s.phase === "game")).toMatchObject({ icon: "help", words: "asks you" });
  });
  test("the full rail's line under each label: what the run says of the phase, with the state first where it is on hold or stopped", () => {
    expect(runRail(S.ds).map(s => s.line)).toEqual(["Ready (v20261108)", "The way to play exists", "Needs the game folder dumped from a console", "Not yet", "Not yet"]);
    expect(runRail(S.nxHeld).find(s => s.phase === "build")?.line).toBe("On hold: building the game on the server");
    expect(runRail({ state: "stopped", rail: [{ phase: "file", state: "active", summary: "making it from the game folder" }] }).find(s => s.phase === "file")?.line).toBe("Stopped here: making it from the game folder");
    expect(runRail({ state: "active", rail: [{ phase: "build", state: "active", summary: null }] }).find(s => s.phase === "build")?.line).toBe("Working on it");
  });
  test("a run's label says what it waits for, from its state and its ask", () => {
    expect(runLook(S.dsMake)).toEqual({ label: "Working on it", tone: "queue" });
    expect(runLook(S.ds)).toEqual({ label: "Needs its game data", tone: "warning" });
    expect(runLook(S.nxHeld)).toEqual({ label: "On hold", tone: "warning" });
    expect(runLook(S.zelda)).toEqual({ label: "Waiting for your go-ahead", tone: "warning" });
    expect(runLook(S.mm)).toEqual({ label: "Done", tone: "success" });
    expect(runLook({ state: "stopped" })).toEqual({ label: "Stopped", tone: "dim" });
    const codes: Record<RunAsk["code"], string> = {
      file: "Needs its game data", "held-file": "Needs your look at a file", game: "Needs the game it plays", choice: "Needs your choice", needs: "Needs a system file",
      ai: "Needs the AI importer", budget: "Out of AI budget", room: "Needs room on the library", env: "Waiting for the server", "go-ahead": "Waiting for your go-ahead",
    };
    for (const [code, label] of Object.entries(codes)) expect({ code, label: runLook({ state: "asking", ask: { code: code as RunAsk["code"] } }).label }).toEqual({ code, label });
  });
});

describe("what a run asks, as its card shows it", () => {
  test("Demon's Souls: the game folder, the sealed copy's words, the share path with the server's own in small type, no upload, still watching", () => {
    const m = askLines(S.ds.ask!, { planId: 3, nowSec: NOW });
    expect(m.title).toBe("Demon's Souls needs its game data");
    // the sentence that names the inbox, and the dot-folder hint, are the card's own lines (with a copy button)
    expect(m.need).toEqual([
      `${KYTY} plays Demon's Souls at 1.05 or 1.07.`,
      "It takes the game folder dumped from a console (holding sce_sys/param.json and eboot.bin), or that folder packed as one .zar, of Demon's Souls (PlayStation 5) — PPSA01341, PPSA01342 or PPSA01340, version 01.005.000 or 01.007.000.",
    ]);
    expect(m.tried[0]).toBe("The copy on the server (bbb-ps5-01342.iso, 54.2 GB) is the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it.");
    expect(m.inbox).toEqual({ shown: DS_SHARE, server: DS_INBOX, dotted: true, mapped: true });
    expect(m.bring).toBe("Put it in this folder or pick it on the server: ludarr takes it from there and finishes by itself.");
    expect({ pick: m.pick, upload: m.upload, accept: m.accept, go: m.go, choices: m.choices, newGame: m.newGame, pickGame: m.pickGame, retry: m.retry, link: m.link })
      .toEqual({ pick: true, upload: false, accept: null, go: false, choices: [], newGame: false, pickGame: false, retry: true, link: null });
    expect(m.watching).toBe("Still watching: next search at 18:40 · the inbox every 2 minutes");
  });
  test("Ocarina of Time (NX2navi): a .nup only the owner's console makes, the AI's own words, watching into tomorrow", () => {
    const m = askLines(S.nx.ask!, { nowSec: NOW });
    expect(m.need).toEqual([
      "NX2navi plays The Legend of Zelda: Ocarina of Time (Switch 2).",
      "It takes one .nup file of The Legend of Zelda: Ocarina of Time (Switch) — title 0400486024DEC000, build e0f3ccfa…, with the 1.1.1 update.",
      "It comes only from your own console: Eglantine on your Switch 2 dumps it.",
    ]);
    expect(m.inbox?.shown).toBe(OOT_SHARE);
    expect(m.upload).toBe(false);
    expect(m.byAi).toBe("Only the owner's console can make the .nup: Eglantine on a Switch 2 dumps the base game and its 1.1.1 update into one file.");
    expect(m.watching).toBe("Still watching: next search tomorrow at 06:10 · the inbox every 2 minutes");
  });
  test("Zelda 64: Recompiled's go-ahead: Go ahead / Not now and nothing else", () => {
    const m = askLines(S.zelda.ask!, { nowSec: NOW });
    expect(m).toMatchObject({ title: "Make The Legend of Zelda: Majora's Mask playable?", go: true, retry: false, pick: false, upload: false, inbox: null, bring: null, watching: null, link: null, pickGame: false, newGame: false });
    expect(m.need.join(" ")).toBe(S.zelda.ask!.need);
  });
  test("each other ask offers only the controls that can work for it", () => {
    const sm = askLines(S.sm64.ask!, { nowSec: NOW });
    expect(sm.bring).toBe("Put it in this folder, pick it on the server, or upload it: ludarr takes it from there and finishes by itself.");
    expect(sm.inbox).toEqual({ shown: "/library/.ahoy-inbox/super-mario-64", server: null, dotted: true, mapped: false });
    expect(sm.need).toEqual(["sm64ex builds Super Mario 64 from the US ROM.", "It takes one .z64 file of Super Mario 64 (Nintendo 64), proven by its sha1."]);
    expect(sm.upload).toBe(true);
    // without an inbox folder (no root folder) the folder is not offered
    expect(askLines({ ...S.sm64.ask!, inbox: null, inboxShare: null }).bring).toBe("Pick it on the server or upload it: ludarr takes it from there and finishes by itself.");
    expect(askLines(S.banjo.ask!)).toMatchObject({ accept: 33, pick: false, upload: false, retry: true, go: false, inbox: null });
    expect(askLines(S.pcsx2.ask!)).toMatchObject({ pickGame: true, newGame: false, go: false, retry: false });
    expect(askLines(S.pcsx2.ask!).choices.map(c => c.name)).toEqual(["Shadow of the Colossus", "Okami", "Ico"]);
    // an emulator's choice with no library game to list yet: any library game answers it (the engine takes {gameId});
    // there is no go-ahead to give (the engine takes {go} only for a run held for one)
    expect(askLines({ ...S.pcsx2.ask!, choices: [] })).toMatchObject({ pickGame: true, choices: [], go: false, newGame: false });
    expect(askLines({ ...S.pcsx2.ask!, code: "game", choices: [] })).toMatchObject({ pickGame: true, newGame: true, go: false, retry: false });
    expect(askLines(S.sonic.ask!).link).toEqual({ to: "/settings/general", label: "Settings → General → Import" });
    expect(askLines({ ...S.sonic.ask!, code: "ai" }).link).toEqual({ to: "/settings/importers", label: "Settings → Importers" });
    expect(askLines({ ...S.sonic.ask!, code: "needs" }, { planId: 6 }).link).toEqual({ to: "/settings/runtimes?plan=6", label: "Fill it with the plan" });
    expect(askLines({ ...S.sonic.ask!, code: "room" }).link?.to).toBe("/settings/mediamanagement");
    expect(askLines({ ...S.sonic.ask!, code: "env" })).toMatchObject({ link: null, retry: true, upload: false, pick: false });
  });
  test("a question the AI asked: no game to pick and no go-ahead (the engine takes neither for it), the plan to change, and Look again now", () => {
    // as carry.ts askFromAi makes it: code 'choice', the AI's title, its exact line in byAi, no choices
    const ai: RunAsk = {
      ...S.pcsx2.ask!, title: "Which of the program's two kits fits this server?", choices: [],
      need: "ludarr's AI needs your help with PCSX2: the release has an AVX2 build and an SSE4 build, and this server's CPU cannot be told from here.",
      byAi: "the release has an AVX2 build and an SSE4 build, and this server's CPU cannot be told from here",
    };
    const m = askLines(ai, { planId: 5 });
    expect({ pickGame: m.pickGame, choices: m.choices, newGame: m.newGame, go: m.go, retry: m.retry, link: m.link })
      .toEqual({ pickGame: false, choices: [], newGame: false, go: false, retry: true, link: { to: "/settings/runtimes?plan=5", label: "Open the plan" } });
    // even when choices came with it: the engine refuses a game as the answer to the AI's question
    expect(askLines({ ...ai, choices: S.pcsx2.ask!.choices }).choices).toEqual([]);
    // a system file the AI asked for keeps its own link, and can be looked at again
    expect(askLines({ ...ai, code: "needs" }, { planId: 5 })).toMatchObject({ link: { label: "Fill it with the plan" }, retry: true });
  });
  test("the file ask in the engine's own words (src/ways/asks.ts): the inbox sentence, its server path and the dot hint become the card's lines", () => {
    // the share path ends with its separator, the server's path follows it in brackets, the upload names its limit
    const share = `${DS_SHARE}\\`, inbox = `${DS_INBOX}/`;
    const need = `${KYTY} plays Demon's Souls. It takes the game folder dumped from a console (holding sce_sys/param.json and eboot.bin), or that folder packed as one .zar, of Demon's Souls (PlayStation 5) — PPSA01341. Put it in ${share} (on the server: ${inbox}), pick it on the server, or upload it (files up to 16 GB): ludarr takes it from there and finishes by itself. (The folder starts with a dot, so Windows may hide it: type the path in Explorer's address bar.)`;
    const m = askLines({ ...S.ds.ask!, need, inbox, inboxShare: share, canUpload: false });
    expect(m.need).toEqual([
      `${KYTY} plays Demon's Souls.`,
      "It takes the game folder dumped from a console (holding sce_sys/param.json and eboot.bin), or that folder packed as one .zar, of Demon's Souls (PlayStation 5) — PPSA01341.",
    ]);
    expect(m.inbox).toEqual({ shown: share, server: inbox, dotted: true, mapped: true });
    expect(m.bring).toBe("Put it in this folder or pick it on the server: ludarr takes it from there and finishes by itself.");
    // no share path set: the server's own path is the one shown, and nothing else names it
    const plain = askLines({ ...S.ds.ask!, need: need.replace(`${share} (on the server: ${inbox})`, inbox), inbox, inboxShare: null });
    expect(plain.inbox).toEqual({ shown: inbox, server: null, dotted: true, mapped: false });
    expect(plain.need.some(s => s.includes(".ahoy-inbox"))).toBe(false);
  });
  test("Ocarina of Time on game 48 while its ordinary download runs: the ask says so, keeps watching the inbox, and plans no search beside it", () => {
    const ask: RunAsk = {
      ...S.nx.ask!, watching: { nextSearchAt: null, inbox: true, every: "2 minutes" },
      tried: [
        "No copy of the game is on the server, and no file is kept for it.",
        "A download of The Legend of Zelda: Ocarina of Time is already running (The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp): ludarr looks at what it brings as soon as it lands.",
      ],
    };
    const m = askLines(ask, { nowSec: NOW });
    expect(m.tried[1]).toContain("is already running (The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp)");
    expect(m.watching).toBe("Still watching: no search of the indexers planned · the inbox every 2 minutes");
    expect({ upload: m.upload, pick: m.pick, retry: m.retry }).toEqual({ upload: false, pick: true, retry: true });
  });
  test("still watching: the next search in local words, or none planned, and the inbox", () => {
    expect(watchLine({ nextSearchAt: null, inbox: true, every: "2 minutes" }, NOW)).toBe("Still watching: no search of the indexers planned · the inbox every 2 minutes");
    expect(watchLine({ nextSearchAt: localAt(NOW, 18, 40), inbox: false, every: "" }, NOW)).toBe("Still watching: next search at 18:40");
    expect(watchLine(null, NOW)).toBeNull();
    expect(whenWords(NOW + 10, NOW)).toBe("now");
    expect(whenWords(localAt(NOW, 18, 40), NOW)).toBe("at 18:40");
    expect(whenWords(localAt(NOW, 6, 10, 1), NOW)).toBe("tomorrow at 06:10");
    expect(whenWords(localAt(NOW, 6, 10, 4), NOW)).toBe("on 12 Nov at 06:10");
    expect(stepTime(localAt(NOW, 11, 5), NOW)).toBe("11:05");
    expect(stepTime(localAt(NOW, 18, 40, -1), NOW)).toBe("7 Nov 18:40");
  });
});

describe("a carry run in lists and on its card", () => {
  test("a run in a line: what it asks, what it does now with its progress, or how it ended", () => {
    expect(runLine(S.ds)).toBe("Demon's Souls needs its game data · still watching");
    expect(runLine(S.dsMake)).toBe("Making the game file from the game folder that landed in the inbox · 41%");
    expect(runLine(S.mm)).toBe("Done · the check: not started here: the server has no graphics device");
    expect(runLine(S.nxHeld)).toBe("On hold since you cancelled what it was doing: Resume carries on");
    expect(runLine(S.zelda)).toBe("Make The Legend of Zelda: Majora's Mask playable?");
    expect(runLine({ ...S.ds, state: "stopped", ask: null })).toBe("Stopped");
    expect(runLine({ ...S.dsMake, now: null, state: "active" })).toBe("Game file: working on it");
    expect(nextLook(S.ds, NOW)).toBe("looks again at 12:02");
    expect(nextLook(S.dsMake, NOW)).toBeNull();
    expect(nextLook(S.mm, NOW)).toBeNull();
  });
  test("what it does now takes the live progress of the job it follows, and only that job's", () => {
    const tick = (over: Partial<JobView>) => ({ id: 70, state: "running", progress: 0.45, message: "packing the game folder · 24.4 of 54.2 GB", ...over }) as JobView;
    expect(runNow(S.dsMake.now, tick({}))).toEqual({ text: S.dsMake.now!.text, heading: S.dsMake.now!.text, progress: 0.45, detail: "packing the game folder · 24.4 of 54.2 GB", queued: false, jobId: 70, requestId: null });
    // the engine's own words for a running job are the job's message of a moment ago: the live line stands alone
    expect(runNow({ ...S.dsMake.now!, text: "packing the game folder · 22.1 of 54.2 GB" }, tick({}))).toMatchObject({ heading: null, detail: "packing the game folder · 24.4 of 54.2 GB" });
    expect(runNow({ ...S.dsMake.now!, text: "packing the game folder · 22.1 of 54.2 GB" }, null)).toMatchObject({ heading: "packing the game folder · 22.1 of 54.2 GB", detail: null, progress: 0.41 });
    expect(runNow(S.dsMake.now, tick({ id: 71 }))).toMatchObject({ progress: 0.41, detail: null });
    expect(runNow(S.dsMake.now, tick({ state: "done" }))).toMatchObject({ progress: 0.41, detail: null });
    expect(runNow(S.dsMake.now, tick({ state: "queued", progress: 0 }))).toMatchObject({ queued: true });
    expect(runNow(null, tick({}))).toBeNull();
    // shown while the run follows its own job or request; while it asks, only while its search brings something in
    const looking = { text: "looking on the indexers", progress: 0, jobId: null, requestId: 9 };
    const fetching = { text: "downloading Demons.Souls.PS5.app0-GRP", progress: 0.37, jobId: null, requestId: 9 };
    expect([nowShown(S.dsMake), nowShown({ state: "asking", now: looking }), nowShown({ state: "asking", now: fetching }), nowShown({ state: "asking", now: { ...looking, jobId: 72 } })])
      .toEqual([true, false, true, true]);
    expect([nowShown({ state: "held", now: fetching }), nowShown({ state: "done", now: fetching }), nowShown({ state: "active", now: null })]).toEqual([false, false, false]);
    expect([fraction(41), fraction(0.41), fraction(-1), fraction(Number.NaN), fraction(3)]).toEqual([0.41, 0.41, 0, 0, 0.03]);
  });
  test("a step reads with its outcome's icon and who took it", () => {
    expect((["ok", "refused", "failed", "waiting", "env", "asked", null] as const).map(o => stepIcon({ outcome: o }).icon)).toEqual(["check", "ban", "alert", "clock", "minusCircle", "help", "dot"]);
    expect(["ludarr", "ai", "admin"].map(whoWord)).toEqual(["ludarr", "the AI", "you"]);
    expect(startedWords("backfill")).toBe("started by ludarr for a way not built yet");
    expect(startedWords("backfill", 4)).toBe("started by ludarr for a way not built yet");
    expect(startedWords("backfill", null)).toBe("started by ludarr for a plan with no way to play yet");
    expect(startedWords("construct")).toBe("started when its plan was saved");
  });
  test("the game's copy, as a way's card says it", () => {
    expect(copyLine(S.dsCopy)).toEqual({ tone: "warn", icon: "alert", text: "The game's copy on the server (bbb-ps5-01342.iso, 54.2 GB) is the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it." });
    expect(copyLine({ ...S.dsCopy, name: "PPSA01341-app0", size: 83.1e9, shape: "folder", serves: "make", why: "" })?.text).toBe("The game file is made from the game's copy on the server (PPSA01341-app0, 83.1 GB).");
    expect(copyLine({ ...S.dsCopy, name: "Super Mario 64 (USA).z64", size: 8_388_608, serves: "direct", why: "" })?.text).toBe("The game's copy on the server (Super Mario 64 (USA).z64, 8 MB) is the game file this way needs: the build takes it as it is.");
    expect(copyLine({ ...S.dsCopy, serves: "unknown", why: "looking at the game's copy" })).toMatchObject({ tone: "wait", text: "Looking at the game's copy on the server (bbb-ps5-01342.iso, 54.2 GB)…" });
    expect(copyLine(null)).toBeNull();
    // one formatter for the pages and these words: one decimal up to 100 GB
    expect(apiFmtSize).toBe(fmtSize);
    expect([DS_ISO, 150e9, 33_554_432, 900_000, null].map(fmtSize)).toEqual(["54.2 GB", "150 GB", "34 MB", "900 KB", "—"]);
  });
  test("a second copy of the game's copy can be freed: as the engine says, or as a guess by the copy's own name and size on a file no way uses", () => {
    expect(secondCopy(dsSecondCopy({ secondCopy: { bytes: DS_ISO } }), S.dsCopy)).toEqual({ bytes: DS_ISO, sure: true });
    expect(secondCopy(dsSecondCopy({ secondCopy: null }), S.dsCopy)).toBeNull();
    // content row 1 on an engine that does not tell: the copy's name and size, kept from its package, used by no way
    expect(secondCopy(dsSecondCopy(), S.dsCopy)).toEqual({ bytes: DS_ISO, sure: false });
    // a way's own file (the copy taken in by a link has its name and size too, and frees nothing) is never guessed at
    expect(secondCopy(dsSecondCopy(), S.dsCopy, true)).toBeNull();
    // what the engine says wins over whether a way uses it
    expect(secondCopy(dsSecondCopy({ secondCopy: { bytes: DS_ISO } }), S.dsCopy, true)).toEqual({ bytes: DS_ISO, sure: true });
    expect(secondCopy(dsSecondCopy(), null)).toBeNull();
    expect(secondCopy(dsSecondCopy({ name: "other.iso" }), S.dsCopy)).toBeNull();
    expect(secondCopy(dsSecondCopy({ size: DS_ISO - 1 }), S.dsCopy)).toBeNull();
    expect(secondCopy(dsSecondCopy({ source: "upload" }), S.dsCopy)).toBeNull();
    expect(identityWords(S.dsCopy.identity)).toBe("PPSA01342 · US · disc 01.00 · sealed for the console");
    expect(identityWords({ platform: "ps5", serial: "PPSA01341", version: "01.007.000", category: "patch" })).toBe("PPSA01341 · 01.007.000 · an update, not the game");
    expect(identityWords({ platform: "switch", serial: "0400486024DEC000", build: "e0f3ccfa5d8d1b6c0a9e", titles: [] })).toBe("0400486024DEC000 · build e0f3ccfa…");
    expect(identityWords(null)).toBeNull();
  });
  test("Make it playable: only on an engine with runs, for a way not built, with no open run and nothing building", () => {
    const w = dsWay(S);
    expect(canCarry(w)).toBe(false);                                                  // its run is open
    expect(canCarry({ ...w, run: null })).toBe(true);
    expect(canCarry({ ...w, run: undefined })).toBe(false);                          // the engine has no runs
    expect(canCarry({ ...w, run: { ...w.run!, state: "stopped" } })).toBe(true);
    expect(canCarry({ ...w, run: { ...w.run!, state: "done" } })).toBe(true);
    expect(canCarry({ ...w, run: null, status: "built" })).toBe(false);
    expect(canCarry({ ...w, run: null, plan: null })).toBe(false);
    expect(canCarry({ ...w, run: null }, null, { state: "running" })).toBe(false);
    // the run as it is kept current wins over the listing's
    expect(canCarry(w, { state: "stopped" })).toBe(true);
  });
  test("a make or the copy taken in shows on its way's card with its own words", () => {
    const job = (over: Partial<JobView>) => ({ id: 70, state: "running", progress: 0.41, message: null, kind: "make", spec: { kind: "make", wayId: 1, from: "copy" }, ...over }) as JobView;
    expect(jobWay(job({}))).toBe(1);
    expect(jobWay(job({ kind: "content", spec: { kind: "content", wayId: 1, fromCopy: true } }))).toBe(1);
    expect(jobWay(job({ kind: "content", spec: { kind: "content", wayId: 1, path: "/downloads/x.z64" } }))).toBeNull();      // the admin's own file: its dialog follows it
    const w = { status: "needs-files", job: null, blockers: [], plan: { status: "ready" } } as unknown as Way;
    expect(wayCard(w, null, job({ state: "queued" }))).toMatchObject({ building: true, look: { label: "Queued: its game file" }, jobTitle: "Making its game file" });
    expect(wayCard(w, null, job({}))).toMatchObject({ look: { label: "Making its game file", tone: "queue" } });
    expect(wayCard(w, null, job({ kind: "content", spec: { kind: "content", wayId: 1, fromCopy: true } }))).toMatchObject({ look: { label: "Taking the game's copy" }, jobTitle: "Taking in the game's copy" });
    const kit = { spec: { program: { kind: "release", assetPattern: "x", channel: "stable" } }, pinned: null, status: "ready" } as unknown as Plan;
    expect(wayCard(w, kit, job({ kind: "build", spec: { kind: "build", planId: 2, wayId: 1 } })).jobTitle).toBe("Building the program for this game on the server");
  });
  test("what a way's game file must be, in a line, for the live ways", () => {
    expect(contentLine(dsWay(S).content)).toBe("Demon's Souls (PlayStation 5) · .zar · PPSA01341, PPSA01342 or PPSA01340 · version 01.005.000 or 01.007.000 · made from the game folder");
    expect(contentLine({
      kind: "rom", platform: "switch", what: "The Legend of Zelda: Ocarina of Time (Switch 2)", search: [], place: "game.nup",
      accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"], builds: ["e0f3ccfa5d8d1b6c"] }, personalDump: "Eglantine on your Switch 2",
    })).toBe("The Legend of Zelda: Ocarina of Time (Switch 2) · .nup · 0400486024DEC000 · build e0f3ccfa… · made by Eglantine on your Switch 2");
    expect(contentLine({ kind: "folder", platform: "ps5", what: "Demon's Souls", search: [], place: "game", marker: "sce_sys/param.json", accept: { hashes: [], serials: ["PPSA01341"] } }))
      .toBe("Demon's Souls (PlayStation 5) · a game folder (holding sce_sys/param.json) · PPSA01341");
  });
});

describe("a run's check", () => {
  test("is found in the build its last check step names, and reads as its verdict", () => {
    expect(checkJobOf(S.mm.steps)).toBe(80);
    expect(checkJobOf(S.ds.steps)).toBeNull();
    // the engine's own steps (carry.ts): "built: …" names the way's build while the run is still in its build, and the
    // check's closing step names no job
    const at = NOW - 600;
    expect(checkJobOf([
      { at, phase: "build", who: "ludarr", text: "building The Legend of Zelda: Majora's Mask through Zelda 64: Recompiled", outcome: "waiting", jobId: 80 },
      { at, phase: "build", who: "ludarr", text: "built: 44 files, 67 MB · not started here: the server has no graphics device", outcome: "ok", jobId: 80 },
      { at, phase: "check", who: "ludarr", text: "built: The Legend of Zelda: Majora's Mask is ready for members to install; not started here: the server has no graphics device", outcome: "ok" },
    ])).toBe(80);
    // a check that failed, then the AI's round about it: the build that ran the check, not the round
    expect(checkJobOf([
      { at, phase: "build", who: "ludarr", text: "check: the self-test failed (exit 2)", outcome: "failed", jobId: 77 },
      { at, phase: "build", who: "ai", text: "round 1 of 3 (check): the self-test now runs with --headless", outcome: "ok", jobId: 64 },
    ])).toBe(77);
    expect(checkOfTrace(S.assembleJob.trace)).toEqual(S.mmCheck);
    expect(checkOfTrace([{ kind: "say", text: "x" }, { kind: "check", report: "not a report" }])).toBeNull();
    expect(checkOfTrace(null)).toBeNull();
    expect(checkWords(S.mmCheck)).toEqual({ tone: "env", text: "Not started here: the server has no graphics device" });
    const step = { what: "the emulator reads the packed game (kyty_shader_precompile --param)", code: 0, ok: true, tail: "", seconds: 4.2 };
    expect(checkWords({ verdict: "pass", steps: [step], smoke: null, text: "" })).toEqual({ tone: "ok", text: "The checks passed" });
    expect(checkWords({ verdict: "fail", steps: [{ ...step, ok: false, code: 3 }], smoke: null, text: "" })).toEqual({ tone: "bad", text: "The emulator reads the packed game (kyty_shader_precompile --param) failed (exit 3)" });
    expect(checkWords({ verdict: "none", steps: [], smoke: null, text: "" }).tone).toBe("none");
    expect(checkWords({ verdict: "env", steps: [], smoke: null, text: "not run here: the server's CPU lacks AVX2" }).text).toBe("Not run here: the server's CPU lacks AVX2");
    expect(checkWords({ ...S.mmCheck, smoke: null }).text).toBe("Not started here: the server has no graphics device");
  });
  test("its smoke start says what it showed (the verdict line says what that means), and its screenshot is asked for only by a name the engine gives", () => {
    expect(smokeLine(S.mmCheck.smoke!)).toBe("The smoke start: its window “Zelda 64: Recompiled” came up, and it stopped (exit 1)");
    expect(smokeLine({ ...S.mmCheck.smoke!, verdict: "pass", alive: true, exitCode: null })).toBe("The smoke start: its window “Zelda 64: Recompiled” came up, and it kept running");
    expect(smokeLine({ ...S.mmCheck.smoke!, verdict: "fail", titles: [], exitCode: null })).toBe("The smoke start: no window came up, and it stopped");
    expect(checkWords({ verdict: "fail", steps: [], smoke: { ...S.mmCheck.smoke!, verdict: "fail", why: "it closed at once." }, text: "" }).text).toBe("The program did not start (exit 1): it closed at once");
    expect(checkWords({ verdict: "pass", steps: [], smoke: { ...S.mmCheck.smoke!, verdict: "pass" }, text: "" }).text).toBe("The checks passed, and the program started on the server");
    expect(checkShotName("check-80-1.png")).toBe("check-80-1.png");
    for (const bad of ["../x.png", "check.jpg", "", null, "CHECK.png", "a/b.png"]) expect(checkShotName(bad)).toBeNull();
  });
  test("a picture the API serves becomes an object URL, revoked when it goes", async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const shown = blobUrl(async () => png);
    const url = await shown.ready;
    expect(url).toMatch(/^blob:/);
    shown.stop();
    expect(await blobUrl(async () => { throw new Error("gone"); }).ready).toBeNull();
    // whatever type the answer claims, the URL is a picture's: a tab it opens in never renders it as a page of this origin
    const made: Blob[] = [];
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (b: Blob) => { made.push(b); return realCreate(b); };
    try {
      const page = blobUrl(async () => new Blob(["<script>alert(1)</script>"], { type: "text/html" }));
      await page.ready;
      page.stop();
      expect(made.map(b => b.type)).toEqual(["image/png"]);
    } finally { URL.createObjectURL = realCreate; }
  });
  test("the AI's spending, in a line", () => {
    expect(budgetLine(S.ds.budget)).toBe("AI repairs: 1 of 3 used · 0.41 of 8 million tokens");
    expect(budgetLine(S.sonic.budget)).toBe("AI repairs: 3 of 3 used · 6.9 of 8 million tokens");
    expect(budgetLine({ rounds: 0, roundsUsed: 0, tokens: 0, tokensUsed: 0 })).toBe("AI repairs are switched off (Settings → General → Import: AI repairs per game)");
    expect(budgetLine(null)).toBeNull();
  });
});

describe("a run on screen (run-follow.ts, behind useRun)", () => {
  /** timers the test moves by hand */
  function clock() {
    let now = 0, n = 0;
    const due = new Map<number, { at: number; fn: () => void }>();
    return {
      timers: { set: (fn: () => void, ms: number) => { due.set(++n, { at: now + ms, fn }); return n; }, clear: (t: unknown) => { due.delete(t as number); } },
      async advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          due.delete(next[0]); now = next[1].at; next[1].fn();
          await settle();
        }
        now = end;
      },
    };
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  function server(first: RunView) {
    let row: RunView = first;
    const listeners = new Set<(ev: string, d: unknown) => void>();
    let reads = 0, fail: unknown = null;
    return {
      set: (over: Partial<RunView>) => { row = { ...row, ...over }; },
      failWith: (e: unknown) => { fail = e; },
      emit: (ev: string, d: unknown) => { for (const l of listeners) l(ev, d); },
      get reads() { return reads; },
      opts: (c: ReturnType<typeof clock>, seen: [RunView, boolean][], ticks: JobView[] = [], stopOn: (e: unknown) => boolean = () => false) => ({
        load: async () => { reads++; if (fail) throw fail; return JSON.parse(JSON.stringify(row)) as RunView; },
        subscribe: (l: (ev: string, d: unknown) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        onConnection: () => () => {},
        onRun: (r: RunView, full: boolean) => { seen.push([r, full]); },
        onTick: (j: JobView) => { ticks.push(j); },
        onError: stopOn,
        timers: c.timers, every: 2000, idle: 30_000, settle: 1500,
      }),
    };
  }
  test("it is read at once, every 2 s while it works on a job, every 30 s while it asks, once more after it ends, then never", async () => {
    const c = clock(), s = server(S.dsMake), seen: [RunView, boolean][] = [];
    const f = followRun(12, s.opts(c, seen));
    await settle();
    expect(s.reads).toBe(1);
    await c.advance(2000);
    expect(s.reads).toBe(2);
    s.set({ state: "asking", ask: S.ds.ask, now: null });
    await c.advance(2000);                               // the poll finds it asking
    expect(s.reads).toBe(3);
    await c.advance(29_000);
    expect(s.reads).toBe(3);
    await c.advance(1000);
    expect(s.reads).toBe(4);
    s.set({ state: "done", ask: null });
    await c.advance(30_000);                             // the poll finds it ended
    expect(seen.at(-1)?.[0].state).toBe("done");
    await c.advance(1500);                               // and reads it once more, for the steps written last
    expect(s.reads).toBe(6);
    await c.advance(600_000);
    expect(s.reads).toBe(6);
    f.stop();
  });
  test("a 'run' event freshens it at once without a read, and a change of state or ask reads its steps again", async () => {
    const c = clock(), s = server(S.ds), seen: [RunView, boolean][] = [];
    const f = followRun(11, s.opts(c, seen));
    await settle();
    // the inbox scan moved the next look: the event's payload is enough
    s.emit("run", { ...S.ds, steps: undefined, nextAt: S.ds.nextAt! + 120 });
    await settle();
    expect(seen.at(-1)).toEqual([expect.objectContaining({ nextAt: S.ds.nextAt! + 120, steps: S.ds.steps }), false]);
    expect(s.reads).toBe(1);
    // another run's event changes nothing here
    s.emit("run", { ...S.mm, steps: undefined });
    await settle();
    expect(seen.at(-1)?.[0].id).toBe(11);
    // a file landed: the run works again, and its new steps are read
    s.set({ state: "waiting", ask: null, now: S.dsMake.now });
    s.emit("run", { ...S.ds, steps: undefined, state: "waiting", ask: null, now: S.dsMake.now });
    await settle();
    expect(s.reads).toBe(2);
    expect(seen.at(-1)).toEqual([expect.objectContaining({ state: "waiting" }), true]);
    f.stop();
  });
  test("the ticks of the job it follows reach the page, another job's do not; nothing after it is closed", async () => {
    const c = clock(), s = server(S.dsMake), ticks: JobView[] = [];
    const f = followRun(12, s.opts(c, [], ticks));
    await settle();
    s.emit("build", { id: 70, state: "running", progress: 0.42, message: "packing the game folder · 22.8 of 54.2 GB" });
    s.emit("build", { id: 71, state: "running", progress: 0.9, message: "another job" });
    s.emit("job", { id: 70, state: "running", progress: 0.43, message: "packing the game folder · 23.3 of 54.2 GB" });
    expect(ticks.map(t => t.progress)).toEqual([0.42, 0.43]);
    f.stop();
    s.emit("build", { id: 70, state: "running", progress: 0.5, message: "later" });
    const reads = s.reads;
    await c.advance(60_000);
    expect(ticks).toHaveLength(2);
    expect(s.reads).toBe(reads);
  });
  test("a server without run routes stops the following at once; a read that failed for another reason is tried again", async () => {
    const c = clock(), s = server(S.ds), seen: [RunView, boolean][] = [];
    s.failWith(new Error("no such endpoint"));
    const f = followRun(11, s.opts(c, seen, [], e => (e as Error).message === "no such endpoint"));
    await settle();
    await c.advance(120_000);
    expect(s.reads).toBe(1);
    expect(seen).toEqual([]);
    f.stop();
    const c2 = clock(), s2 = server(S.ds);
    s2.failWith(new Error("the server restarted"));
    const f2 = followRun(11, s2.opts(c2, seen));
    await settle();
    s2.failWith(null);
    await c2.advance(5000);
    expect(s2.reads).toBe(2);
    expect(seen.at(-1)?.[1]).toBe(true);
    // a reload after a press reads it now
    f2.reload();
    await settle();
    expect(s2.reads).toBe(3);
    f2.stop();
  });
});
