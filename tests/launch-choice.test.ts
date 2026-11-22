/**
 * How a game's copy starts, set by hand (src/library/launch.ts, src/api/launch.ts, src/library/pe.ts): what a program's
 * header says, what the package's own words say about its files, the game page's view (GET /game/:id/launch) and its
 * picker, the checks of a start set by hand (each refusal in its own words), applying it to the current copy in place
 * (manifest, ahoy.json, rev, requires, the intent, history, the package event), Reset, the launcher's question
 * (GET /package/:id/launch), and the start set by hand outliving what rewrites a copy: an upgrade or a re-import, a rescan,
 * a way's rebuild (the smoke start included) and the way's own PUT. The AI round is in tests/ways-construct-round.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { apiKey } from "../src/config";
import { db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { events } from "../src/events";
import { serializeLibraryGame } from "../src/library/games";
import { choiceOnDisk, globMatcher, ldeps, quoteArg, readScript, scriptDoes, sentencesOf, startNeeds } from "../src/library/launch";
import { peInfo } from "../src/library/pe";
import { needsAhoy, pasted, preview, quoteArg as webQuote, saidOfStart, splitCommandLine } from "../web/src/ways/launch-logic";
import { rescanLibrary, rsdeps } from "../src/library/rescan";
import { ensureDefaultRootFolder, rootFolders } from "../src/library/rootfolders";
import { enqueueJob } from "../src/process/kinds";
import { pdeps } from "../src/process/deps";
import { rdeps, runJob } from "../src/process/runner";
import { buildManifest, type Manifest, type Validation } from "../src/process/validate";
import { app } from "../src/server";
import { adeps } from "../src/ways/assemble";
import { prdeps } from "../src/ways/program";
import { sbdeps } from "../src/ways/sandbox";
import { getWay, insertContent, insertPlan, insertWay, updateWay, wayOverrides, wstmts } from "../src/ways/store";
import type { CheckReport, LaunchChoice, LaunchPlan, RuntimePlanSpec } from "../src/ways/types";
import { SCRIPT_ARG_WORDS, validatePlanSpec, validateWayOverrides } from "../src/ways/validate";
import { peBytes } from "./pe-build";
import { bytes, fake7z, releaseHost, restoreDeps, sha1, sha256, tempConfig, tools7z } from "./ways-fixtures";

const tmp = (p = "launch-") => mkdtempSync(join(tmpdir(), p));
const LIB = () => process.env.AHOY_LIBRARY!;

/* ─────────── a copy of KytyPS5 with Demon's Souls, as the server holds it ─────────── */

const README = [
  "# KytyPS5", "",
  "**Double-click `KytyLauncher.exe`** (or `launcher.cmd`) for the settings window, in English or Chinese. Its",
  "settings are kept in `launcher-settings.json`.", "",
  "`KytyLauncher.exe --play` starts the game right away with the launcher's settings, without its window: for a",
  "desktop shortcut, or Steam.", "",
  "- Do not double-click `kyty_emulator.exe` directly: it would lack its launch options.",
  "", "```", "KytyLauncher.exe --dry-run", "```", "",
  "With a recent graphics driver, a warm shader cache, the frame generation the settings window offers and the fullscreen mode on, a long play session with few stutters is what to expect; the program that does the work is kyty_emulator.exe, with the options the launcher gives it.",
].join("\n");
const OPEN_LOGS_CMD = '@echo off\r\nrem Opens the folder of the logs.\r\nexplorer.exe "%~dp0logs"\r\n';
const RUN_CMD = '@echo off\r\nrem Starts the game; the options are those of run-windows.ps1 (e.g. run.cmd -Fullscreen).\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-windows.ps1" -Prompt -Follow %*\r\nif %errorlevel% neq 0 pause\r\n';
const LAUNCHER_CMD = '@echo off\r\nrem The settings window: KytyLauncher.exe, else the older launcher.ps1.\r\nif exist "%~dp0KytyLauncher.exe" (\r\n\tstart "" "%~dp0KytyLauncher.exe"\r\n\texit /b 0\r\n)\r\n';
const RUN_PS1 = "param([switch]$Follow)\n# Windows launcher: runs the Windows build with the command line of a launch config.\n$x = 1\n& \"$PSScriptRoot\\kyty_emulator.exe\" --game $game\n";
const EMU = () => peBytes({ ui: "console", version: { FileDescription: "KytyPS5 PS5 emulator" }, pad: 200_000 });
const LAUNCHER = () => peBytes({ ui: "window", version: { FileDescription: "KytyPS5 launcher", Comments: "Settings window for the KytyPS5 emulator: starts run-windows.ps1" } });

/** the program's files (no game data): what a release unpacks to, and what a copy holds besides its game file */
function kytyProgram(dir: string, o: { launcher?: boolean } = {}) {
  for (const d of ["bin", "tools", "redist", "_SaveData", "logs"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "kyty_emulator.exe"), EMU());
  if (o.launcher !== false) writeFileSync(join(dir, "KytyLauncher.exe"), LAUNCHER());
  writeFileSync(join(dir, "bin", "KytyCli.exe"), peBytes({ ui: "console" }));
  writeFileSync(join(dir, "tools", "kyty_shader_precompile.exe"), peBytes({ ui: "console", version: { FileDescription: "KytyPS5 shader precompile" } }));
  writeFileSync(join(dir, "redist", "vc_redist.x64.exe"), peBytes({ ui: "window" }));
  writeFileSync(join(dir, "plugin.exe"), peBytes({ dll: true }));
  writeFileSync(join(dir, "broken.exe"), "this is not a program at all");
  writeFileSync(join(dir, "msvcp140.dll"), peBytes({ dll: true }));
  writeFileSync(join(dir, "_SaveData", "save-tool.exe"), peBytes({ ui: "console" }));
  writeFileSync(join(dir, "logs", "readme.txt"), "logs go here");
  writeFileSync(join(dir, "run.cmd"), RUN_CMD);
  writeFileSync(join(dir, "launcher.cmd"), LAUNCHER_CMD);
  writeFileSync(join(dir, "open-logs.cmd"), OPEN_LOGS_CMD);
  writeFileSync(join(dir, "run-windows.ps1"), RUN_PS1);
  writeFileSync(join(dir, "README.md"), README);
  writeFileSync(join(dir, "game-path.txt"), "game/PPSA01341-app0.zar\n");
}
function kytyCopy(dir: string, o: { launcher?: boolean } = {}) {
  kytyProgram(dir, o);
  mkdirSync(join(dir, "game"), { recursive: true });
  writeFileSync(join(dir, "game", "PPSA01341-app0.zar"), bytes(64 * 1024, 3));
}

let seq = 0;
const made = { games: [] as number[], dirs: [] as string[] };
function game(name: string): GameRow {
  const g = upsertGame({ steam_appid: 994_000 + ++seq, name, slug: `launch-test-${seq}` }) as GameRow;
  made.games.push(g.id);
  return g;
}
/** a game's PC copy as an import leaves it (an older row: no start recorded as found), its files on disk */
async function importedCopy(name: string, o: { exe?: string; tier?: "deterministic" | "agent"; kind?: "native" | "rom" } = {}) {
  const g = game(name);
  const dir = join(LIB(), `launch-copy-${seq}`);
  kytyCopy(dir);
  made.dirs.push(dir);
  const v: Validation = { ok: true, root: dir, problems: [], exeCandidates: [], launch: o.exe ?? "kyty_emulator.exe", prerequisites: [], totalSize: 0, fileCount: 0 };
  const m = await buildManifest(v, { name, slug: g.slug!, version: null, source: null, tier: o.tier ?? "deterministic", kind: o.kind ?? "native", notes: o.tier === "agent" ? "The AI importer: KytyLauncher.exe opens the settings window." : null });
  writeFileSync(join(dir, "ahoy.json"), JSON.stringify(m, null, 2));
  const pkg = stmts.insertPackage.get(g.id, null, dir, name, null, m.totalSize, JSON.stringify(m)) as PackageRow;
  return { g, dir, pkg, m };
}
const KYTY_SPEC = {
  program: { kind: "release", assetPattern: "^KytyPS5-v\\d+[.]zip$", channel: "stable" },
  launch: { exe: "kyty_emulator.exe", argv: ["--game", "{content}"] },
  content: { kind: "disc", platform: "ps5", what: "a PlayStation 5 game", search: ["PlayStation 5"], accept: { hashes: [], formats: ["zar"] }, place: "game/{name}" },
  files: [], setup: [], needs: [], keep: ["_SaveData/**", "launcher-settings.json"], seed: ["game-path.txt"], firstRun: null, notes: "KytyLauncher.exe --play starts the game without its window.",
};
/** a copy a way built (Demon's Souls through KytyPS5), as its build left it: the way built, its game file kept */
async function wayCopy(name: string) {
  const g = game(name);
  const checked = validatePlanSpec(KYTY_SPEC, "emulator");
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  const plan = insertPlan({ name: `KytyPS5 ${seq}`, kind: "emulator", repo: "chenxiao07/KytyPS5", platforms: ["ps5"], spec: checked.value!, status: "ready" });
  const dir = join(LIB(), `launch-way-${seq}`);
  kytyCopy(dir);
  made.dirs.push(dir);
  const file = insertContent({ gameId: g.id, platform: "ps5", name: "PPSA01341-app0.zar", path: join(dir, "game", "PPSA01341-app0.zar"), size: 64 * 1024, hashes: { sha256: "b".repeat(64) }, source: "upload" });
  let way = insertWay({ gameId: g.id, planId: plan.id, status: "built" });
  way = updateWay(way.id, { contentId: file.id })!;
  const v: Validation = { ok: true, root: dir, problems: [], exeCandidates: [], launch: "kyty_emulator.exe", prerequisites: [], totalSize: 0, fileCount: 0 };
  const m = await buildManifest(v, {
    name, slug: g.slug!, version: "20261108", source: { title: name, group: null, protocol: "way", indexer: null }, tier: "deterministic", kind: "emulated", platform: "ps5",
    launchArgs: "", argv: ["--game", "{install}/game/PPSA01341-app0.zar"], requires: { launcher: "0.10.0" }, keep: KYTY_SPEC.keep, seed: [...KYTY_SPEC.seed, ...KYTY_SPEC.keep],
  });
  writeFileSync(join(dir, "ahoy.json"), JSON.stringify(m, null, 2));
  const pkg = stmts.insertPackage.get(g.id, null, dir, name, "20261108", m.totalSize, JSON.stringify(m)) as PackageRow;
  wstmts.setWayBuilt.run(pkg.id, way.id);
  return { g, dir, pkg, m, plan, way: getWay(way.id)! };
}

const call = async (method: string, path: string, body?: unknown, key = apiKey()) => {
  const r = await app.request(path, { method, headers: { ...(key ? { "x-api-key": key } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const pkgOf = (gameId: number) => stmts.packageForGame.get(gameId) as PackageRow;
const manifestOf = (gameId: number) => JSON.parse(pkgOf(gameId).manifest_json) as Manifest;
const historyOf = (gameId: number) => db.query("SELECT event, source, message FROM history WHERE game_id=? ORDER BY id").all(gameId) as { event: string; source: string; message: string }[];

beforeAll(() => { ensureDefaultRootFolder(); });
afterAll(() => {
  for (const id of made.games) {
    for (const t of ["jobs", "packages", "ways", "contents", "history"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
    db.query("DELETE FROM games WHERE id=?").run(id);
  }
  for (const d of made.dirs) rmSync(d, { recursive: true, force: true });
});

/* ─────────── a program's header ─────────── */

describe("what a program's own header says (src/library/pe.ts)", () => {
  test("a program with a window or a console, a library, and what is no program at all; the version strings it carries", async () => {
    const d = tmp();
    const at = (n: string, b: Uint8Array | string) => { writeFileSync(join(d, n), b); return join(d, n); };
    expect(await peInfo(at("l.exe", LAUNCHER()))).toEqual({ kind: "program", ui: "window", version: { FileDescription: "KytyPS5 launcher", Comments: "Settings window for the KytyPS5 emulator: starts run-windows.ps1" } });
    expect(await peInfo(at("e.exe", EMU()))).toEqual({ kind: "program", ui: "console", version: { FileDescription: "KytyPS5 PS5 emulator" } });
    expect((await peInfo(at("p.exe", peBytes({ dll: true })))).kind).toBe("dll");
    expect(await peInfo(at("n.exe", "MZ but nothing after it"))).toEqual({ kind: "other", ui: null, version: {} });
    expect(await peInfo(at("t.txt", "plain text"))).toEqual({ kind: "other", ui: null, version: {} });
    expect(await peInfo(join(d, "missing.exe"))).toEqual({ kind: "other", ui: null, version: {} });
    // a header cut short after the PE signature is no program either
    expect((await peInfo(at("cut.exe", peBytes({ ui: "window" }).slice(0, 0x50)))).kind).toBe("other");
    rmSync(d, { recursive: true, force: true });
  });
});

describe("what the package says about its files", () => {
  test("a cmd script: its first comment, and what it runs with the folders taken out (powershell on run-windows.ps1)", () => {
    const run = readScript(RUN_CMD, "cmd");
    expect(run.comment).toBe("Starts the game; the options are those of run-windows.ps1 (e.g. run.cmd -Fullscreen).");
    // the system's PowerShell is no file of the copy (no path); the script it is handed is named as the copy names it
    expect(run.commands).toEqual([{ line: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File run-windows.ps1 -Prompt -Follow", name: "powershell.exe", path: null, args: "-NoProfile -ExecutionPolicy Bypass -File run-windows.ps1 -Prompt -Follow" }]);
    // a script in a folder of the copy: its own folder in what it hands over, its program resolved from there
    expect(readScript(RUN_CMD.replace("%~dp0run-windows", "%~dp0..\\run-windows"), "cmd", "tools").commands[0].args).toBe("-NoProfile -ExecutionPolicy Bypass -File run-windows.ps1 -Prompt -Follow");
    expect(readScript(RUN_CMD, "cmd", "tools").commands[0].args).toBe("-NoProfile -ExecutionPolicy Bypass -File tools/run-windows.ps1 -Prompt -Follow");
    expect(readScript('"%~dp0..\\bin\\game.exe" -x\r\n', "cmd", "tools").commands[0]).toEqual({ line: "game.exe -x", name: "game.exe", path: "bin/game.exe", args: "-x" });
    expect(readScript('& "$PSScriptRoot\\..\\..\\outside.exe"\n', "ps1", "tools").commands[0].path).toBeNull();      // out of the game's folder
    // an `if exist` test is no start: the program is the one `start` starts
    const launcher = readScript(LAUNCHER_CMD, "cmd");
    expect(launcher).toMatchObject({ comment: "The settings window: KytyLauncher.exe, else the older launcher.ps1.", commands: [{ line: "KytyLauncher.exe", name: "KytyLauncher.exe" }] });
    // PowerShell: the comment after param(…), and the program `&` starts
    expect(readScript(RUN_PS1, "ps1")).toMatchObject({ comment: "Windows launcher: runs the Windows build with the command line of a launch config.", commands: [{ line: "kyty_emulator.exe --game $game" }] });
    expect(readScript("<#\n.SYNOPSIS\nStarts the thing.\n#>\nWrite-Host hi\n", "ps1").comment).toBe("Starts the thing.");
    // a block that runs on: its first sentence
    expect(readScript("@echo off\r\nrem Starts it. Options: -a, -b and -c, each one explained at length.\r\nrem More words.\r\n", "cmd").comment).toBe("Starts it.");
  });
  test("a README as sentences: wrapped lines joined, markdown taken out, a code line its own", () => {
    const s = sentencesOf(README);
    expect(s).toContain("Double-click KytyLauncher.exe (or launcher.cmd) for the settings window, in English or Chinese.");
    expect(s).toContain("KytyLauncher.exe --play starts the game right away with the launcher's settings, without its window: for a desktop shortcut, or Steam.");
    expect(s).toContain("Do not double-click kyty_emulator.exe directly: it would lack its launch options.");
    expect(s).toContain("KytyLauncher.exe --dry-run");
    expect(s.some(x => x.includes("**") || x.includes("`"))).toBe(false);
  });
  test("the player's keep and seed globs read as the launcher reads them", () => {
    const kept = globMatcher(["_SaveData/**", "launcher-settings.json", "*.seeds", "inis/{a,b}.ini"]);
    expect(["_SaveData/save-tool.exe", "_savedata/x/y.bin", "launcher-settings.json", "x.seeds", "inis/b.ini"].every(kept)).toBe(true);
    expect(["KytyLauncher.exe", "tools/x.seeds", "inis/c.ini", "_SaveDataX/a"].some(kept)).toBe(false);
    expect(globMatcher(["../x/**"])("../x/a")).toBe(false);                     // a glob that would leave the folder matches nothing
  });
});

/* ─────────── the game page's view ─────────── */

describe("Starts with: GET /game/:id/launch", () => {
  test("an imported copy: the whole start, found by ludarr; the picker's programs first (the current one, the package's start, top-level, larger), helpers last and dimmed, what cannot start at the very end", async () => {
    const c = await importedCopy("Starts With Import");
    const { status, json } = await call("GET", `/api/v1/game/${c.g.id}/launch`);
    expect(status).toBe(200);
    const v = json.item;
    expect(v).toMatchObject({ packageId: c.pkg.id, kind: "native", from: "import", wayId: null, editable: true, why: null, busy: null, applied: false, set: null, notApplied: null });
    expect(v.start).toMatchObject({ exe: "kyty_emulator.exe", argv: [], line: "kyty_emulator.exe", by: "ludarr", needsAhoy: null, startsIn: { kind: "program", folder: "" } });
    expect(v.auto.line).toBe("kyty_emulator.exe");
    expect(v.fields).toEqual({ exe: "kyty_emulator.exe", argv: [], cwd: null, env: {} });
    expect(v.programs.map((p: { path: string }) => p.path)).toEqual([
      // an imported copy keeps nothing for the player: _SaveData's tool is a helper like the others (a way's copy refuses it)
      "kyty_emulator.exe", "KytyLauncher.exe", "bin/KytyCli.exe", "tools/kyty_shader_precompile.exe", "_SaveData/save-tool.exe", "redist/vc_redist.x64.exe", "plugin.exe", "broken.exe",
    ]);
    const by = (p: string) => v.programs.find((x: { path: string }) => x.path === p);
    expect(by("KytyLauncher.exe")).toMatchObject({ kind: "program", ui: "window", helper: false, starts: true, refused: null });
    expect(by("KytyLauncher.exe").words[0]).toEqual({ text: "KytyPS5 launcher", source: "version info" });
    expect(by("KytyLauncher.exe").words).toContainEqual({ text: "KytyLauncher.exe --play starts the game right away with the launcher's settings, without its window: for a desktop shortcut, or Steam.", source: "README.md" });
    expect(by("KytyLauncher.exe").words.slice(2)).toEqual([
      { text: "Double-click KytyLauncher.exe (or launcher.cmd) for the settings window, in English or Chinese.", source: "README.md" },
      { text: "KytyLauncher.exe --play starts the game right away with the launcher's settings, without its window: for a desktop shortcut, or Steam.", source: "README.md" },
      { text: "KytyLauncher.exe --dry-run", source: "README.md" },
    ]);
    // a helper: dimmed, with its own words
    expect(by("tools/kyty_shader_precompile.exe")).toMatchObject({ helper: true, words: [{ text: "KytyPS5 shader precompile", source: "version info" }] });
    // a sentence longer than a quote is cut around the file's name, so the quote always shows it
    const long = by("kyty_emulator.exe").words[2];
    expect(by("kyty_emulator.exe")).toMatchObject({ current: true, ui: "console", words: [{ text: "KytyPS5 PS5 emulator", source: "version info" }, { text: "Do not double-click kyty_emulator.exe directly: it would lack its launch options.", source: "README.md" }, { source: "README.md" }] });
    expect(long.text).toStartWith("…");
    expect(long.text).toContain("the program that does the work is kyty_emulator.exe, with the options the launcher gives it.");
    expect(long.text.length).toBeLessThanOrEqual(200);
    expect(by("redist/vc_redist.x64.exe")).toMatchObject({ helper: true, refused: null });
    expect(by("plugin.exe").refused).toBe("a library (DLL), not a program");
    expect(by("broken.exe").refused).toBe("not a Windows program");
    expect(v.settingsWindow["KytyLauncher.exe"]).toMatch(/^version info: "Settings window for the KytyPS5 emulator/);
    // scripts: listed with their words; the program a script starts is named when it is one of the copy's; a .bat or .cmd can
    // itself be picked, and says what it does on a player's PC beyond starting a program
    const cmd = { startable: true, refused: null, current: false };
    expect(v.scripts).toEqual(expect.arrayContaining([
      { path: "run.cmd", size: RUN_CMD.length, comment: "Starts the game; the options are those of run-windows.ps1 (e.g. run.cmd -Fullscreen).", runs: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File run-windows.ps1 -Prompt -Follow", program: null, ...cmd,
        does: scriptDoes(RUN_CMD) },
      { path: "launcher.cmd", size: LAUNCHER_CMD.length, comment: "The settings window: KytyLauncher.exe, else the older launcher.ps1.", runs: "KytyLauncher.exe", program: "KytyLauncher.exe", ...cmd, does: [] },
      // a command that involves nothing of the copy (it opens Explorer) says nothing of what starts the game
      { path: "open-logs.cmd", size: OPEN_LOGS_CMD.length, comment: "Opens the folder of the logs.", runs: null, program: null, ...cmd, does: [] },
    ]));
    expect(scriptDoes(RUN_CMD)).toEqual([expect.stringMatching(/^runs PowerShell: "%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile /)]);
    // a PowerShell script is listed, and never one to pick
    expect(v.scripts.find((s: { path: string }) => s.path === "run-windows.ps1")).toMatchObject({ startable: false, refused: null, does: [] });
    expect(v.folders).toEqual(expect.arrayContaining(["bin", "game", "tools", "redist", "_SaveData", "logs"]));
    expect(v.files).toBe(c.m.files.length);
    expect(v.placeholders).toEqual({ install: `C:\\Games\\Ahoy\\${c.g.slug}`, content: null });
    // every file can be found by any part of its path
    const f = await call("GET", `/api/v1/game/${c.g.id}/launch/files?q=APP0`);
    expect(f.json).toEqual({ items: [{ path: "game/PPSA01341-app0.zar", size: 64 * 1024, kind: "file" }], total: c.m.files.length, matched: 1 });
  });

  test("a copy the AI importer made says so; a console dump has no start to set; no copy is 404", async () => {
    const ai = await importedCopy("Starts With AI", { tier: "agent" });
    expect((await call("GET", `/api/v1/game/${ai.g.id}/launch`)).json.item.start.by).toBe("ai");
    // the importer's notes are quoted too
    expect((await call("GET", `/api/v1/game/${ai.g.id}/launch`)).json.item.programs.find((p: { path: string }) => p.path === "KytyLauncher.exe").words).toContainEqual({ text: "The AI importer: KytyLauncher.exe opens the settings window.", source: "the importer's notes" });
    const dump = await importedCopy("Starts With Dump", { kind: "rom", exe: "game/PPSA01341-app0.zar" });
    const d = (await call("GET", `/api/v1/game/${dump.g.id}/launch`)).json.item;
    expect(d).toMatchObject({ editable: false, why: "a console dump: a way to play starts it", start: null, programs: [] });
    expect(await call("PUT", `/api/v1/game/${dump.g.id}/launch`, { exe: "KytyLauncher.exe", argv: [] })).toEqual({ status: 409, json: { error: "a console dump: a way to play starts it" } });
    expect(await call("DELETE", `/api/v1/game/${dump.g.id}/launch`)).toEqual({ status: 409, json: { error: "a console dump: a way to play starts it" } });
    expect((await call("GET", `/api/v1/game/${game("No Copy").id}/launch`)).status).toBe(404);
    expect((await call("GET", "/api/v1/game/99999999/launch")).json).toEqual({ error: "no such game" });
  });
});

/* ─────────── setting it ─────────── */

describe("setting the start by hand: PUT /game/:id/launch", () => {
  test("each refusal in its own words, and nothing changes", async () => {
    const c = await importedCopy("Refusals");
    const put = (body: unknown) => call("PUT", `/api/v1/game/${c.g.id}/launch`, body);
    const errorsOf = async (body: unknown) => { const r = await put(body); expect(r.status).toBe(400); expect(r.json.error).toBe("how the game starts has problems"); return r.json.errors as string[]; };
    // a script that is no .bat or .cmd is never a start; a .bat or .cmd is one only with arguments the command shell reads as plain words
    expect(await errorsOf({ exe: "run-windows.ps1" })).toEqual(["run-windows.ps1: Ahoy starts programs and Windows command scripts (.bat, .cmd), no other script and no shortcut. Pick the program it starts. This one runs: kyty_emulator.exe --game $game."]);
    expect(await errorsOf({ exe: "run.cmd", argv: ["-Fullscreen", "a b", "x&y", "{install}/game.bin", "%PATH%"] })).toEqual([2, 3, 4, 5].map(n => `argument ${n}: ${SCRIPT_ARG_WORDS}`));
    expect(await errorsOf({ exe: "run.cmd", env: { Ahoy_Start: "C:\\x.bat" } })).toEqual(["the variable AHOY_START is the launcher's own for a script (it holds the script's path)"]);
    expect(await errorsOf({ exe: "Gone.cmd" })).toEqual(["Gone.cmd is not a file of the game's copy"]);
    expect(await errorsOf({ exe: "plugin.exe" })).toEqual(["plugin.exe is a library (DLL), not a program"]);
    expect(await errorsOf({ exe: "broken.exe" })).toEqual(["broken.exe is not a Windows program"]);
    expect(await errorsOf({ exe: "msvcp140.dll" })).toEqual(["msvcp140.dll is not a program: Ahoy starts Windows programs (.exe)"]);
    expect(await errorsOf({ exe: "Gone.exe" })).toEqual(["Gone.exe is not a file of the game's copy"]);
    expect(await errorsOf({ exe: "../../Windows/notepad.exe" })).toEqual(["../../Windows/notepad.exe is not a file of the game's copy"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", argv: ["--x={foo}"] })).toEqual(["argument 1: {foo} is not a placeholder here ({install})"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", argv: ["--game", "{content}"] })).toEqual(["argument 2: {content} is a way's game file, and this copy was not built by a way"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", argv: ["--log={install}/../elsewhere"] })).toEqual(["argument 1: ../elsewhere climbs out of the game's folder"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", cwd: "../outside" })).toEqual(["the folder it starts in, ../outside, climbs out of the game's folder"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", cwd: "{install}/../outside" })).toEqual(["the folder it starts in, ../outside, climbs out of the game's folder"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", cwd: "C:/Games" })).toEqual(["the folder it starts in must be inside the game's folder (no drive, no leading /)"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", cwd: "nowhere" })).toEqual(["nowhere is not a folder of the game's copy"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", env: { "BAD-NAME": "1", OK: "{nope}" } })).toEqual(["BAD-NAME is not a variable name (letters, digits and _, not starting with a digit)", "the variable OK: {nope} is not a placeholder here ({install})"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", argv: "--play" })).toEqual(["the arguments: a list of text"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", argv: Array.from({ length: 51 }, (_, i) => `-${i}`) })).toEqual(["at most 50 arguments"]);
    expect(await errorsOf({ exe: "KytyLauncher.exe", via: "powershell" })).toEqual(["not a part of a start: via (they are exe, argv, cwd, env)"]);
    expect(await errorsOf({ argv: ["--play"] })).toEqual(["pick the program it starts"]);
    expect(await errorsOf(null)).toEqual(["send {exe, argv, cwd?, env?}"]);
    // nothing changed: the copy, its ahoy.json, the game, the history
    expect(pkgOf(c.g.id).manifest_json).toBe(c.pkg.manifest_json);
    expect(JSON.parse(readFileSync(join(c.dir, "ahoy.json"), "utf8"))).toEqual(c.m);
    expect((stmts.gameById.get(c.g.id) as GameRow).launch_json ?? null).toBeNull();
    expect(historyOf(c.g.id)).toEqual([]);
  });

  test("while the game's copy is being rebuilt nothing is saved (409), and once it is done the start is set", async () => {
    const c = await importedCopy("Busy");
    const job = stmts.insertJob.get(null, null, c.g.id, c.dir) as JobRow;
    try {
      expect((await call("GET", `/api/v1/game/${c.g.id}/launch`)).json.item.busy).toBe("the game's copy is being rebuilt");
      expect(await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).toEqual({ status: 409, json: { error: "the game's copy is being rebuilt: change how it starts once that is done" } });
      expect(pkgOf(c.g.id).manifest_json).toBe(c.pkg.manifest_json);
    } finally { stmts.setJobFailed.run("cancelled", "cancelled", job.id); }
    expect((await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).status).toBe(200);
  });

  test("applied at once: the copy's manifest and its ahoy.json (rm then a file of its own), rev, the intent, the start found kept for Reset, the history, the package event — the files untouched", async () => {
    const c = await importedCopy("Applied");
    const seen: { event: string; data: any }[] = [];
    const off = events.subscribe(e => seen.push({ event: e.event, data: e.data }));
    const t0 = Date.now();
    const r = await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "kytylauncher.EXE", argv: ["--play"] });
    off();
    expect(r.status).toBe(200);
    const m = manifestOf(c.g.id);
    const rev = m.launch.rev!;
    expect(rev).toBeGreaterThanOrEqual(t0);
    // the list's own spelling is stored; args joined (the old launchers start it too), the program's folder
    expect(m.launch).toEqual({ exe: "KytyLauncher.exe", args: "--play", cwd: "", argv: ["--play"], rev });
    expect(m.requires).toBeUndefined();
    expect(m.files).toEqual(c.m.files);
    expect({ ...m, launch: c.m.launch }).toEqual(c.m);
    expect(pkgOf(c.g.id).id).toBe(c.pkg.id);                                     // the same package: no new copy, nothing hashed
    expect(JSON.parse(readFileSync(join(c.dir, "ahoy.json"), "utf8"))).toEqual(m);
    expect(JSON.parse((stmts.gameById.get(c.g.id) as GameRow).launch_json!)).toEqual({ exe: "KytyLauncher.exe", argv: ["--play"], at: rev });
    expect(JSON.parse(pkgOf(c.g.id).launch_auto_json!)).toEqual({ launch: { exe: "kyty_emulator.exe", args: "", cwd: "" }, requires: null });
    expect(historyOf(c.g.id)).toEqual([{ event: "edited", source: "the admin", message: "start set by hand: KytyLauncher.exe --play (was kyty_emulator.exe)" }]);
    expect(seen.filter(e => e.event === "package").map(e => e.data.id)).toEqual([c.pkg.id]);
    // what the page reads back, and the library's own line for the game (the whole start, and the stamp a client compares)
    expect(r.json.warnings).toEqual([]);
    expect(r.json.item).toMatchObject({ applied: true, notApplied: null, set: { exe: "KytyLauncher.exe", argv: ["--play"], at: rev, line: "KytyLauncher.exe --play" }, start: { line: "KytyLauncher.exe --play", by: "hand", rev } });
    expect(r.json.item.fields).toEqual({ exe: "KytyLauncher.exe", argv: ["--play"], cwd: null, env: {} });
    // the README's line that holds the current arguments now comes first for the program
    const words = r.json.item.programs.find((p: { path: string }) => p.path === "KytyLauncher.exe").words.filter((w: { source: string }) => w.source === "README.md");
    expect(words[0].text).toStartWith("KytyLauncher.exe --play starts the game");
    const lib = serializeLibraryGame(stmts.gameById.get(c.g.id) as GameRow);
    expect(lib.file).toMatchObject({ launch: "KytyLauncher.exe", start: "KytyLauncher.exe --play", launchRev: rev });
    expect((await call("GET", "/api/v1/game")).json.items.find((x: { id: number }) => x.id === c.g.id).file).toMatchObject({ start: "KytyLauncher.exe --play", launchRev: rev });
  });

  test("what the start needs of Ahoy: 0.10 for an argument with a space, a placeholder, a variable or the game's folder; a folder that is the program's own is no folder; the warnings", async () => {
    const c = await importedCopy("Needs");
    const put = (body: unknown) => call("PUT", `/api/v1/game/${c.g.id}/launch`, body);
    let r = await put({ exe: "bin/KytyCli.exe", argv: ["--game", "{install}/game/PPSA01341-app0.zar", "--name", "Demon's Souls"], cwd: "{install}" });
    expect(r.status).toBe(200);
    let m = manifestOf(c.g.id);
    expect(m.launch).toMatchObject({ exe: "bin/KytyCli.exe", args: "", cwd: "{install}", argv: ["--game", "{install}/game/PPSA01341-app0.zar", "--name", "Demon's Souls"] });
    expect(m.requires).toEqual({ launcher: "0.10.0" });
    expect(r.json.warnings).toEqual(["it starts in the game's folder, not the program's own: files of the copy may name paths relative to the program's folder"]);
    expect(r.json.item.start.startsIn).toEqual({ kind: "game", folder: "" });
    expect(r.json.item.start.line).toBe(`bin/KytyCli.exe --game {install}/game/PPSA01341-app0.zar --name "Demon's Souls"`);
    // the program's own folder, however it is written, is said as none (and needs nothing)
    r = await put({ exe: "bin/KytyCli.exe", argv: ["--check"], cwd: "{install}/BIN" });
    m = manifestOf(c.g.id);
    expect(m.launch).toMatchObject({ exe: "bin/KytyCli.exe", args: "--check", cwd: "bin", argv: ["--check"] });
    expect(m.requires).toBeUndefined();
    expect(r.json.warnings).toEqual([]);
    // another folder of the copy, spelled as the copy spells it; a variable needs 0.10
    r = await put({ exe: "KytyLauncher.exe", argv: [], cwd: "LOGS", env: { KYTY_LOG: "{install}/logs" } });
    m = manifestOf(c.g.id);
    expect(m.launch).toMatchObject({ exe: "KytyLauncher.exe", args: "", cwd: "logs", argv: [], env: { KYTY_LOG: "{install}/logs" } });
    expect(m.requires).toEqual({ launcher: "0.10.0" });
    expect(r.json.warnings).toEqual([
      "it starts in logs, not the program's own folder: files of the copy may name paths relative to the program's folder",
      `with no arguments it may open its settings window rather than the game — version info: "Settings window for the KytyPS5 emulator: starts run-windows.ps1"`,
    ]);
    // a helper, and an argument naming nothing of the copy, are warned about, never refused
    r = await put({ exe: "redist/vc_redist.x64.exe", argv: ["--log={install}/nothing-here.txt"] });
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual(["argument 1: nothing-here.txt is not a file or folder of the game's copy", "vc_redist.x64.exe looks like an installer or a helper, not the game"]);
  });

  test("a way's copy: the intent on the way's overrides (the rest kept), {content} as the way's game file, the files players keep refused, requires never below the copy's own", async () => {
    const c = await wayCopy("Way Copy");
    updateWay(c.way.id, { overrides: { argvExtra: ["--fast"], env: { KYTY_X: "1" } } });
    const view = (await call("GET", `/api/v1/game/${c.g.id}/launch`)).json.item;
    expect(view).toMatchObject({ from: "way", wayId: c.way.id, start: { by: "plan", line: "kyty_emulator.exe --game {install}/game/PPSA01341-app0.zar", needsAhoy: "0.10.0" }, placeholders: { content: "game/PPSA01341-app0.zar" } });
    // the editor starts from the copy's start, the game file said as {content} again
    expect(view.fields).toEqual({ exe: "kyty_emulator.exe", argv: ["--game", "{content}"], cwd: null, env: {} });
    expect(view.programs.find((p: { path: string }) => p.path === "_SaveData/save-tool.exe").refused).toBe("one of the files players keep: the launcher never updates it");
    expect(view.programs.find((p: { path: string }) => p.path === "KytyLauncher.exe").words).toContainEqual({ text: "KytyLauncher.exe --play starts the game without its window.", source: "the plan's notes" });
    const r = await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "_SaveData/save-tool.exe" });
    expect(r.json.errors).toEqual(["_SaveData/save-tool.exe is one of the files players keep (the copy's keep or seed list): the launcher never updates or checks it, so it cannot be what starts the game"]);
    const ok = await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "kyty_emulator.exe", argv: ["--game", "{content}", "--fullscreen"] });
    expect(ok.status).toBe(200);
    const m = manifestOf(c.g.id);
    expect(m.launch).toMatchObject({ exe: "kyty_emulator.exe", args: "", argv: ["--game", "{install}/game/PPSA01341-app0.zar", "--fullscreen"] });
    expect(m.requires).toEqual({ launcher: "0.10.0" });                               // the copy's own (keep, seed)
    expect(m.keep).toEqual(c.m.keep);
    const ov = wayOverrides(getWay(c.way.id)!);
    expect(ov).toEqual({ argvExtra: ["--fast"], env: { KYTY_X: "1" }, launch: { exe: "kyty_emulator.exe", argv: ["--game", "{content}", "--fullscreen"], at: m.launch.rev! } });
    expect((stmts.gameById.get(c.g.id) as GameRow).launch_json ?? null).toBeNull();     // a way's start lives on the way
    expect(ok.json.item).toMatchObject({ applied: true, start: { by: "hand" }, fields: { argv: ["--game", "{content}", "--fullscreen"] } });
    // and Reset gives back the plan's start the copy was built with
    const back = await call("DELETE", `/api/v1/game/${c.g.id}/launch`);
    expect(back.status).toBe(200);
    expect(manifestOf(c.g.id).launch).toMatchObject({ exe: "kyty_emulator.exe", args: "", argv: ["--game", "{install}/game/PPSA01341-app0.zar"] });
    expect(wayOverrides(getWay(c.way.id)!)).toEqual({ argvExtra: ["--fast"], env: { KYTY_X: "1" } });
    expect(historyOf(c.g.id).at(-1)).toEqual({ event: "edited", source: "the admin", message: "start reset to kyty_emulator.exe --game {install}/game/PPSA01341-app0.zar, as the plan says" });
  });
});

describe("what Save would say, as the admin types: POST /game/:id/launch/check", () => {
  test("the same words as Save, the start as it would run and what it needs, and nothing changed", async () => {
    const c = await importedCopy("Check As You Type");
    const check = (body: unknown) => call("POST", `/api/v1/game/${c.g.id}/launch/check`, body);
    expect((await check({ exe: "run-windows.ps1" })).json.errors).toEqual((await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "run-windows.ps1" })).json.errors);
    expect((await check({ exe: "run.cmd", argv: ["a b"] })).json.errors).toEqual((await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "run.cmd", argv: ["a b"] })).json.errors);
    expect(await check({ exe: "KytyLauncher.exe", argv: ["--play"] })).toEqual({ status: 200, json: { errors: [], warnings: [], line: "KytyLauncher.exe --play", needsAhoy: null } });
    expect((await check({ exe: "KytyLauncher.exe", argv: [] })).json.warnings).toEqual([`with no arguments it may open its settings window rather than the game — version info: "Settings window for the KytyPS5 emulator: starts run-windows.ps1"`]);
    expect((await check({ exe: "KytyLauncher.exe", argv: ["--name", "Demon's Souls"] })).json).toMatchObject({ line: `KytyLauncher.exe --name "Demon's Souls"`, needsAhoy: "0.10.0" });
    expect(pkgOf(c.g.id).manifest_json).toBe(c.pkg.manifest_json);
    expect(historyOf(c.g.id)).toEqual([]);
    const dump = await importedCopy("Check A Dump", { kind: "rom", exe: "game/PPSA01341-app0.zar" });
    expect((await call("POST", `/api/v1/game/${dump.g.id}/launch/check`, { exe: "KytyLauncher.exe" })).json.errors).toEqual(["a console dump: a way to play starts it"]);
  });
});

describe("a game that starts through its own script (.bat, .cmd), set by hand", () => {
  // what a repack's start script looks like when the game cannot start without it: administrator rights, a driver, the game
  const DRIVER_BAT = [
    "@echo off", "setlocal", "", 'cd /d "%~dp0"', "", "net session >nul 2>&1", "if %errorlevel% neq 0 (",
    "    powershell -Command \"Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs\"", "    exit /b", ")", "",
    "set DRIVERFILE=Guard.sys", "set DRIVERNAME=game-guard_offline", "rem sc delete would undo it",
    'sc.exe create %DRIVERNAME% type= kernel binPath="%CD%\\%DRIVERFILE%"', 'sc start "%DRIVERNAME%" >nul 2>&1',
    "start /wait .\\sp\\game.exe key123", 'sc stop "%DRIVERNAME%" >nul 2>&1', "sc.exe delete %DRIVERNAME%", "exit", "",
  ].join("\r\n");

  test("what a script does on a player's PC is read from it: each kind once, with the line that does it; a comment does nothing", () => {
    expect(scriptDoes(DRIVER_BAT)).toEqual([
      "asks for administrator rights on the player's PC (Windows asks the player each time): powershell -Command \"Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs\"",
      'installs or starts a Windows service or driver: sc.exe create %DRIVERNAME% type= kernel binPath="%CD%\\%DRIVERFILE%"',
      "runs PowerShell: powershell -Command \"Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs\"",
    ]);
    expect(scriptDoes('@echo off\r\nrem reg add would be bad\r\n:: so would sc create\r\nstart "" "%~dp0bin\\Game.exe" -windowed\r\n')).toEqual([]);
    expect(scriptDoes("reg add HKCU\\Software\\X /v a /d 1 /f\r\ncurl -o x.zip https://example.org/x.zip\r\nrd /q /s \"%TEMP%\\x\"\r\nschtasks /create /tn x /tr y\r\nnetsh advfirewall set allprofiles state off").map(d => d.split(":")[0]))
      .toEqual(["changes the Windows registry", "changes Windows security or system settings", "downloads from the network", "adds a scheduled task", "deletes folders"]);
  });

  test("picked by hand it is the copy's start: said with what it does, needing Ahoy 0.11, and Reset gives the program back", async () => {
    const c = await importedCopy("Script Start");
    writeFileSync(join(pkgOf(c.g.id).path, "!start game.bat"), DRIVER_BAT);
    // (the copy's file list is its manifest's: the script is one of its files)
    const m = JSON.parse(pkgOf(c.g.id).manifest_json) as Manifest;
    m.files.push({ path: "!start game.bat", size: DRIVER_BAT.length, sha256: sha256(DRIVER_BAT) } as Manifest["files"][number]);
    db.query("UPDATE packages SET manifest_json=? WHERE id=?").run(JSON.stringify(m), pkgOf(c.g.id).id);
    const before = pkgOf(c.g.id);
    const said = await call("POST", `/api/v1/game/${c.g.id}/launch/check`, { exe: "!start game.bat", argv: ["key123"] });
    expect(said.json).toEqual({
      errors: [], line: "!start game.bat key123", needsAhoy: "0.11.0",
      warnings: [
        "!start game.bat is a script: on each player's PC it runs through the Windows command shell and does whatever it says there, with that player's rights. Read it before you pick it",
        "it asks for administrator rights on the player's PC (Windows asks the player each time): powershell -Command \"Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs\"",
        'it installs or starts a Windows service or driver: sc.exe create %DRIVERNAME% type= kernel binPath="%CD%\\%DRIVERFILE%"',
        "it runs PowerShell: powershell -Command \"Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs\"",
      ],
    });
    expect(pkgOf(c.g.id).manifest_json).toBe(before.manifest_json);
    const put = await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "!start game.bat", argv: ["key123"] });
    expect(put.status).toBe(200);
    expect(put.json.warnings).toEqual(said.json.warnings);
    expect(put.json.item.start).toMatchObject({ exe: "!start game.bat", argv: ["key123"], line: "!start game.bat key123", by: "hand", needsAhoy: "0.11.0", startsIn: { kind: "program", folder: "" } });
    expect(put.json.item.scripts.find((s: { path: string }) => s.path === "!start game.bat")).toMatchObject({ startable: true, current: true, refused: null });
    expect(put.json.item.programs.filter((p: { current: boolean }) => p.current)).toEqual([]);
    const now = JSON.parse(pkgOf(c.g.id).manifest_json) as Manifest;
    expect(now.launch).toMatchObject({ exe: "!start game.bat", args: "key123", cwd: "", argv: ["key123"] });
    expect(now.requires).toEqual({ launcher: "0.11.0" });
    expect(JSON.parse(readFileSync(join(pkgOf(c.g.id).path, "ahoy.json"), "utf8")).launch.exe).toBe("!start game.bat");
    // what the launcher asks at Play says the same
    expect((await call("GET", `/api/v1/package/${pkgOf(c.g.id).id}/launch`)).json).toMatchObject({ launch: { exe: "!start game.bat", argv: ["key123"] }, requires: { launcher: "0.11.0" } });
    // Reset: the program ludarr found, and what that needed
    const reset = await call("DELETE", `/api/v1/game/${c.g.id}/launch`);
    expect(reset.status).toBe(200);
    const after = JSON.parse(pkgOf(c.g.id).manifest_json) as Manifest;
    expect([after.launch.exe, after.requires ?? null]).toEqual([(JSON.parse(before.manifest_json) as Manifest).launch.exe, (JSON.parse(before.manifest_json) as Manifest).requires ?? null]);
  });

  test("a new copy takes a script start when the script is in it, with its plain arguments; and the editor's rule for what it needs is the server's", async () => {
    const root = mkdtempSync(join(tmpdir(), "launch-script-"));
    mkdirSync(join(root, "sp"), { recursive: true });
    writeFileSync(join(root, "!Start Game.BAT"), "@echo off\r\n");
    const s: LaunchChoice = { exe: "!start game.bat", argv: ["key123"], at: 5 };
    expect(await choiceOnDisk(s, { root, placed: null })).toEqual({ start: { exe: "!Start Game.BAT", argv: ["key123"] } });
    expect(await choiceOnDisk({ ...s, argv: ["a b"] }, { root, placed: null })).toEqual({ why: "its script !Start Game.BAT takes plain arguments only" });
    expect(await choiceOnDisk({ ...s, exe: "other.bat" }, { root, placed: null })).toEqual({ why: "its program other.bat is not in it" });
    expect(await choiceOnDisk(s, { root, placed: null, keep: ["*.bat"] })).toEqual({ why: "its program !Start Game.BAT is one of the files players keep" });
    for (const f of [{ exe: "run.cmd", argv: [], cwd: null, env: {} }, { exe: "a/b.BAT", argv: ["x y"], cwd: null, env: {} }, { exe: "Game.exe", argv: ["x y"], cwd: null, env: {} }, { exe: "Game.exe", argv: [], cwd: null, env: {} }])
      expect(needsAhoy(f), f.exe).toBe(startNeeds({ exe: f.exe, argv: f.argv, env: f.env }));
    expect([needsAhoy({ exe: "run.cmd", argv: [], cwd: null, env: {} }), needsAhoy({ exe: "run.ps1", argv: [], cwd: null, env: {} })]).toEqual(["0.11.0", null]);
  });
});

describe("the editor's own rules (web/src/ways/launch-logic.ts), held against the server's", () => {
  test("a pasted command line splits as Windows splits it; its first word picks the program when the copy has it", () => {
    expect(splitCommandLine(`"C:\\Program Files\\Game\\Game.exe" --name "Demon's Souls" -x`)).toEqual(["C:\\Program Files\\Game\\Game.exe", "--name", "Demon's Souls", "-x"]);
    expect(splitCommandLine(`a\\\\"b c" d\\"e "f""g"`)).toEqual(['a\\b c', 'd"e', 'f"g']);
    expect(splitCommandLine(`--empty "" x`)).toEqual(["--empty", "", "x"]);
    expect(pasted(`KYTYLAUNCHER.EXE --play`, ["KytyLauncher.exe", "bin/KytyCli.exe"])).toEqual({ exe: "KytyLauncher.exe", argv: ["--play"] });
    expect(pasted(`.\\bin\\kytycli.exe --check`, ["KytyLauncher.exe", "bin/KytyCli.exe"])).toEqual({ exe: "bin/KytyCli.exe", argv: ["--check"] });
    expect(pasted(`--play --refocus`, ["KytyLauncher.exe"])).toEqual({ exe: null, argv: ["--play", "--refocus"] });
  });
  test("the preview: the program by its whole path, {install} and {content} filled in as the launcher fills them, the folder it starts in", () => {
    const o = { install: "C:\\Games\\Ahoy\\demons-souls", content: "game/PPSA01341-app0.zar" };
    expect(preview({ exe: "KytyLauncher.exe", argv: ["--play"], cwd: null, env: {} }, o)).toEqual({ line: `"C:\\Games\\Ahoy\\demons-souls\\KytyLauncher.exe" --play`, folder: "C:\\Games\\Ahoy\\demons-souls" });
    expect(preview({ exe: "bin/x.exe", argv: ["--game", "{content}", "--log={install}/logs/a b.txt"], cwd: "{install}", env: {} }, o)).toEqual({
      line: `"C:\\Games\\Ahoy\\demons-souls\\bin\\x.exe" --game C:\\Games\\Ahoy\\demons-souls\\game\\PPSA01341-app0.zar "--log=C:\\Games\\Ahoy\\demons-souls\\logs\\a b.txt"`,
      folder: "C:\\Games\\Ahoy\\demons-souls",
    });
    expect(preview({ exe: "bin/x.exe", argv: [], cwd: null, env: {} }, o).folder).toBe("C:\\Games\\Ahoy\\demons-souls\\bin");
    expect(preview({ exe: "x.exe", argv: [], cwd: "logs", env: {} }, o).folder).toBe("C:\\Games\\Ahoy\\demons-souls\\logs");
  });
  test("the line under a start: a quote holding its arguments, else the version info, else a sentence about the program itself — never a passing mention", () => {
    const info = { text: "KytyPS5 PS5 emulator", source: "version info" };
    const passing = { text: "For FSR, put amd_fidelityfx_upscaler_vk.dll next to kyty_emulator.exe.", source: "README.md" };
    const subject = { text: "kyty_emulator.exe plays the game with the launcher's options.", source: "README.md" };
    const play = { text: "KytyLauncher.exe --play starts the game right away.", source: "README.md" };
    expect(saidOfStart([info, passing, subject], "kyty_emulator.exe", [])).toEqual(info);
    expect(saidOfStart([passing, subject], "kyty_emulator.exe", [])).toEqual(subject);
    expect(saidOfStart([passing], "kyty_emulator.exe", [])).toBeNull();
    expect(saidOfStart([{ text: "KytyPS5 launcher", source: "version info" }, play], "KytyLauncher.exe", ["--play"])).toEqual(play);
    // a program in a folder is the subject when the sentence opens with its path
    expect(saidOfStart([{ text: "bin/KytyCli.exe checks the game's files.", source: "README.md" }], "bin/KytyCli.exe", [])).toEqual({ text: "bin/KytyCli.exe checks the game's files.", source: "README.md" });
  });
  test("what Ahoy a start needs is the server's own rule", () => {
    const cases: { argv: string[]; cwd: string | null; env: Record<string, string> }[] = [
      { argv: [], cwd: null, env: {} }, { argv: ["--play"], cwd: null, env: {} }, { argv: ["--name", "Big Game"], cwd: null, env: {} },
      { argv: ["{install}/x"], cwd: null, env: {} }, { argv: [], cwd: "{install}", env: {} }, { argv: [], cwd: "logs", env: {} }, { argv: [], cwd: null, env: { A: "1" } },
    ];
    for (const f of cases) expect([f, needsAhoy(f)]).toEqual([f, startNeeds({ argv: f.argv, cwd: f.cwd ?? undefined, env: f.env })]);
    expect(cases.map(f => needsAhoy(f))).toEqual([null, null, "0.10.0", "0.10.0", "0.10.0", null, "0.10.0"]);
    expect(webQuote(`Demon's Souls`)).toBe(quoteArg(`Demon's Souls`));
    expect(webQuote(`a "b" c\\`)).toBe(quoteArg(`a "b" c\\`));
  });
});

/* ─────────── Reset ─────────── */

describe("Reset: DELETE /game/:id/launch", () => {
  test("the start found comes back with its requires, stamped; the intent goes; a second Reset is 404", async () => {
    const c = await importedCopy("Reset");
    await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play", "--name", "Demon's Souls"] });
    expect(manifestOf(c.g.id).requires).toEqual({ launcher: "0.10.0" });
    const set = manifestOf(c.g.id).launch.rev!;
    const r = await call("DELETE", `/api/v1/game/${c.g.id}/launch`);
    expect(r.status).toBe(200);
    const m = manifestOf(c.g.id);
    expect(m.launch).toEqual({ exe: "kyty_emulator.exe", args: "", cwd: "", rev: m.launch.rev });
    expect(m.launch.rev).toBeGreaterThan(set);
    expect(m.requires).toBeUndefined();
    expect(JSON.parse(readFileSync(join(c.dir, "ahoy.json"), "utf8"))).toEqual(m);
    expect((stmts.gameById.get(c.g.id) as GameRow).launch_json ?? null).toBeNull();
    expect(r.json.item).toMatchObject({ applied: false, set: null, start: { by: "ludarr", line: "kyty_emulator.exe" } });
    expect(historyOf(c.g.id).map(h => h.message)).toEqual([`start set by hand: KytyLauncher.exe --play --name "Demon's Souls" (was kyty_emulator.exe)`, "start reset to kyty_emulator.exe, as ludarr found it"]);
    expect(await call("DELETE", `/api/v1/game/${c.g.id}/launch`)).toEqual({ status: 404, json: { error: "the start was not set by hand" } });
  });
});

/* ─────────── the launcher's question ─────────── */

describe("GET /package/:id/launch", () => {
  test("the package's start as it is now, with its stamp, what it needs and its kind; behind the API key; 404 once it is gone", async () => {
    const c = await importedCopy("Launcher Asks");
    expect(await call("GET", `/api/v1/package/${c.pkg.id}/launch`)).toEqual({ status: 200, json: { launch: { exe: "kyty_emulator.exe", args: "", cwd: "" }, rev: null, requires: null, kind: "native" } });
    await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] });
    const rev = manifestOf(c.g.id).launch.rev;
    expect((await call("GET", `/api/v1/package/${c.pkg.id}/launch`)).json).toEqual({ launch: { exe: "KytyLauncher.exe", args: "--play", cwd: "", argv: ["--play"], rev }, rev, requires: null, kind: "native" });
    expect((await call("GET", `/api/v1/package/${c.pkg.id}/launch`, undefined, "")).status).toBe(401);
    expect(await call("GET", "/api/v1/package/99999999/launch")).toEqual({ status: 404, json: { error: "not found" } });
  });
});

/* ─────────── what rewrites a copy ─────────── */

describe("an import, an upgrade, a rescan: the start set by hand for the game's PC copies", () => {
  let layout: (dir: string) => void = d => kytyCopy(d);
  /** the importer that takes the copy in: "agent" is the AI importer */
  let impl = "test";
  const saved = { ...rdeps };
  beforeEach(() => {
    pdeps.log = () => {};
    rdeps.importers = () => [{ impl, name: "Test importer", importer: {
      probe: async () => true,
      run: async ctx => {
        layout(ctx.staging);
        const v: Validation = { ok: true, root: ctx.staging, problems: [], exeCandidates: ["kyty_emulator.exe"], launch: "kyty_emulator.exe", prerequisites: [], totalSize: 1, fileCount: 1 };
        return { ok: true, shape: "folder", reason: null, validation: v };
      },
    } }];
  });
  afterEach(() => { Object.assign(rdeps, saved); restoreDeps(); layout = d => kytyCopy(d); impl = "test"; });
  const importFor = async (g: GameRow) => {
    const input = tmp("launch-input-");
    writeFileSync(join(input, "x.bin"), "x");
    const j = stmts.insertJob.get(null, null, g.id, input) as JobRow;
    await runJob(j.id);
    const done = stmts.jobById.get(j.id) as JobRow;
    expect([done.state, done.message]).toEqual(["done", expect.any(String)]);
    made.dirs.push(pkgOf(g.id).path);
    return done;
  };

  test("an upgrade takes it when its program is in the new copy; one whose copy lacks it starts as found, says so, and keeps it; a rescan keeps it for the next copy", async () => {
    const g = game("Import Keeps It");
    // the first import: as ludarr finds it, and that start recorded as found
    await importFor(g);
    expect(manifestOf(g.id).launch).toEqual({ exe: "kyty_emulator.exe", args: "", cwd: "" });
    expect(JSON.parse(pkgOf(g.id).launch_auto_json!)).toEqual({ launch: { exe: "kyty_emulator.exe", args: "", cwd: "" }, requires: null });
    expect((await call("PUT", `/api/v1/game/${g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).status).toBe(200);
    const at = JSON.parse((stmts.gameById.get(g.id) as GameRow).launch_json!).at as number;

    // an upgrade (a new import over it): the new copy starts as set by hand, stamped with the same rev
    const first = pkgOf(g.id).id;
    const up = await importFor(g);
    expect(pkgOf(g.id).id).not.toBe(first);
    expect(manifestOf(g.id).launch).toEqual({ exe: "KytyLauncher.exe", args: "--play", cwd: "", argv: ["--play"], rev: at });
    expect(JSON.parse(readFileSync(join(pkgOf(g.id).path, "ahoy.json"), "utf8")).launch).toEqual(manifestOf(g.id).launch);
    expect(JSON.parse(pkgOf(g.id).launch_auto_json!)).toEqual({ launch: { exe: "kyty_emulator.exe", args: "", cwd: "" }, requires: null });
    // the job's line names the whole start, as the game page does (the program alone misled once)
    expect(up.message).toMatch(/launch KytyLauncher\.exe --play \(set by hand\)$/);
    expect(historyOf(g.id).at(-1)).toMatchObject({ event: "upgraded", message: up.message });
    expect((await call("GET", `/api/v1/game/${g.id}/launch`)).json.item).toMatchObject({ applied: true, start: { by: "hand" } });

    // a copy without that program: as found, the job and the history say why, the intent stays for the next one
    layout = d => kytyCopy(d, { launcher: false });
    const lacking = await importFor(g);
    expect(manifestOf(g.id).launch).toEqual({ exe: "kyty_emulator.exe", args: "", cwd: "" });
    const words = "the start set by hand (KytyLauncher.exe --play) is not applied to the new copy: its program KytyLauncher.exe is not in it; it starts with kyty_emulator.exe, as ludarr found it";
    expect(lacking.transcript).toContain(words);
    expect(historyOf(g.id).at(-1)).toEqual({ event: "edited", source: "import", message: words });
    expect(JSON.parse((stmts.gameById.get(g.id) as GameRow).launch_json!)).toEqual({ exe: "KytyLauncher.exe", argv: ["--play"], at });
    expect((await call("GET", `/api/v1/game/${g.id}/launch`)).json.item).toMatchObject({ applied: false, notApplied: "its program KytyLauncher.exe is not in this copy", set: { line: "KytyLauncher.exe --play" }, start: { by: "ludarr" } });

    // a rescan: the copy deleted by hand is gone, the start set by hand is not; the next copy takes it
    rmSync(pkgOf(g.id).path, { recursive: true, force: true });
    rsdeps.rootFolders = () => rootFolders();
    await rescanLibrary();
    expect(stmts.packageForGame.get(g.id) ?? null).toBeNull();
    expect(JSON.parse((stmts.gameById.get(g.id) as GameRow).launch_json!)).toEqual({ exe: "KytyLauncher.exe", argv: ["--play"], at });
    layout = d => kytyCopy(d);
    await importFor(g);
    expect(manifestOf(g.id).launch).toEqual({ exe: "KytyLauncher.exe", args: "--play", cwd: "", argv: ["--play"], rev: at });
  });

  test("an argument naming a file of the copy ({install}/…): a new copy without that file starts as found and says why; a path no copy had when the start was set holds nothing back", async () => {
    const g = game("Import Path Argument");
    await importFor(g);
    // the file search's "use it as an argument" puts {install}/<path> in; the log is a file the program writes itself
    const put = await call("PUT", `/api/v1/game/${g.id}/launch`, { exe: "bin/KytyCli.exe", argv: ["--game", "{install}/game/PPSA01341-app0.zar", "--log={install}/logs/kyty.log"] });
    expect(put.status).toBe(200);
    expect(put.json.warnings).toEqual(["argument 3: logs/kyty.log is not a file or folder of the game's copy"]);
    const at = JSON.parse((stmts.gameById.get(g.id) as GameRow).launch_json!).at as number;
    // the next release keeps its game data under data/: the start would name a file this copy lacks
    layout = d => { kytyProgram(d); mkdirSync(join(d, "data"), { recursive: true }); writeFileSync(join(d, "data", "PPSA01341-app0.zar"), bytes(64 * 1024, 3)); };
    const moved = await importFor(g);
    expect(manifestOf(g.id).launch).toEqual({ exe: "kyty_emulator.exe", args: "", cwd: "" });
    const words = "the start set by hand (bin/KytyCli.exe --game {install}/game/PPSA01341-app0.zar --log={install}/logs/kyty.log) is not applied to the new copy: argument 2 names game/PPSA01341-app0.zar, which is not in it; it starts with kyty_emulator.exe, as ludarr found it";
    expect(moved.transcript).toContain(words);
    expect(historyOf(g.id).at(-1)).toEqual({ event: "edited", source: "import", message: words });
    const v = (await call("GET", `/api/v1/game/${g.id}/launch`)).json.item;
    expect(v).toMatchObject({ applied: false, notApplied: "argument 2 names game/PPSA01341-app0.zar, which is not in this copy", start: { by: "ludarr", line: "kyty_emulator.exe" } });
    // the editor starts from the copy's own start, not from the one that does not fit
    expect(v.fields).toEqual({ exe: "kyty_emulator.exe", argv: [], cwd: null, env: {} });
    // the start set by hand keeps the files of the copy it named when it was set (not the log, which no copy had)
    expect(JSON.parse((stmts.gameById.get(g.id) as GameRow).launch_json!)).toEqual({ exe: "bin/KytyCli.exe", argv: ["--game", "{install}/game/PPSA01341-app0.zar", "--log={install}/logs/kyty.log"], paths: ["game/PPSA01341-app0.zar"], at });
    // the game data back where it was: the start set by hand again, the log it writes itself holding nothing back
    layout = d => kytyCopy(d);
    await importFor(g);
    expect(manifestOf(g.id).launch).toMatchObject({ exe: "bin/KytyCli.exe", argv: ["--game", "{install}/game/PPSA01341-app0.zar", "--log={install}/logs/kyty.log"], rev: at });
  });

  test("a new copy whose program is now a library or no Windows program: the page gives that reason (Save would refuse it too) and the editor starts from the copy's own start; one that fits but was not taken says so once", async () => {
    const g = game("Import Program Changed");
    await importFor(g);
    expect((await call("PUT", `/api/v1/game/${g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).status).toBe(200);
    for (const [bytes_, why] of [[peBytes({ dll: true }), "its program KytyLauncher.exe is a library (DLL), not a program"], ["not a program at all", "its program KytyLauncher.exe is not a Windows program"]] as const) {
      layout = d => { kytyCopy(d); writeFileSync(join(d, "KytyLauncher.exe"), bytes_); };
      await importFor(g);
      expect(manifestOf(g.id).launch.exe).toBe("kyty_emulator.exe");
      const v = (await call("GET", `/api/v1/game/${g.id}/launch`)).json.item;
      expect(v).toMatchObject({ applied: false, notApplied: why, set: { line: "KytyLauncher.exe --play" } });
      expect(v.fields).toEqual({ exe: "kyty_emulator.exe", argv: [], cwd: null, env: {} });
      // Save refuses the same start for the same reason
      expect((await call("PUT", `/api/v1/game/${g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).json.errors).toEqual([expect.stringMatching(/^KytyLauncher\.exe is (a library \(DLL\), not a program|not a Windows program)$/)]);
    }
    // a start set by hand that fits this copy but was not taken (kept from before it): said once, and the editor starts from it
    layout = d => kytyCopy(d);
    await importFor(g);
    db.query("UPDATE games SET launch_json=? WHERE id=?").run(JSON.stringify({ exe: "KytyLauncher.exe", argv: ["--play", "--refocus"], at: 7 }), g.id);
    const v = (await call("GET", `/api/v1/game/${g.id}/launch`)).json.item;
    expect(v).toMatchObject({ applied: false, notApplied: null, set: { line: "KytyLauncher.exe --play --refocus" } });
    expect(v.fields).toEqual({ exe: "KytyLauncher.exe", argv: ["--play", "--refocus"], cwd: null, env: {} });
  });

  test("a copy the AI importer made: a start set by hand it lacks starts as the AI importer found it, in those words", async () => {
    const g = game("Import By The AI");
    await importFor(g);
    expect((await call("PUT", `/api/v1/game/${g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).status).toBe(200);
    impl = "agent";
    layout = d => kytyCopy(d, { launcher: false });
    const done = await importFor(g);
    const words = "the start set by hand (KytyLauncher.exe --play) is not applied to the new copy: its program KytyLauncher.exe is not in it; it starts with kyty_emulator.exe, as the AI importer found it";
    expect(done.transcript).toContain(words);
    expect(historyOf(g.id).at(-1)).toEqual({ event: "edited", source: "import", message: words });
    expect((await call("GET", `/api/v1/game/${g.id}/launch`)).json.item.start.by).toBe("ai");
  });
});

describe("a way's rebuild: overrides.launch", () => {
  const ASSET = "KytyPS5-v20261108.zip";
  const URL_ = `https://github.com/chenxiao07/KytyPS5/releases/download/v20261108/${ASSET}`;
  const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(4000, 7)]);
  const RELEASE = { tag: "v20261108", name: "v20261108", date: "2026-11-08", prerelease: false, page: "p", immutable: true, asset: { name: ASSET, url: URL_, size: ZIP.byteLength, digest: `sha256:${sha256(ZIP)}` } };
  const ROM = bytes(32 * 1024, 9);
  const SPEC = (): RuntimePlanSpec => validatePlanSpec({
    program: { kind: "release", assetPattern: "^KytyPS5-v\\d+[.]zip$", channel: "stable" },
    launch: { exe: "kyty_emulator.exe", argv: ["--game", "{content}"] },
    content: { kind: "rom", platform: "n64", what: "the game", search: ["The Game"], accept: { hashes: [{ algo: "sha1", value: sha1(ROM) }], formats: ["z64"] }, normalize: null, place: "game/game.z64" },
    files: [], setup: [], needs: [], keep: ["_SaveData/**"], seed: [], firstRun: null, notes: "",
    check: { steps: [{ run: { exe: "kyty_emulator.exe", argv: ["--selftest"], wine: true, timeoutSec: 60 }, what: "its self-test" }] },
  }, "recomp").value!;
  let cfg: ReturnType<typeof tempConfig>;
  const smoke: LaunchPlan[] = [];
  const realAdeps = { ...adeps };
  beforeAll(() => { cfg = tempConfig(); });
  afterAll(() => cfg.restore());
  beforeEach(() => {
    ensureDefaultRootFolder();
    smoke.length = 0;
    pdeps.log = () => {};
    pdeps.tools = () => tools7z;
    sbdeps.platform = () => "win32";
    sbdeps.exec = fake7z({ [ASSET]: out => kytyProgram(join(out, "KytyPS5")) });
    releaseHost({ [URL_]: ZIP });
    prdeps.latestRelease = async () => RELEASE;
    Object.assign(adeps, realAdeps, {
      contentFromPackage: async () => null,
      runChecks: async (o: { spec: RuntimePlanSpec }) => { smoke.push(o.spec.launch); return { verdict: "pass", steps: [], smoke: null, text: "" } satisfies CheckReport; },
    });
  });
  afterEach(() => { Object.assign(adeps, realAdeps); restoreDeps(); });
  async function wayToBuild() {
    const g = game("Way Rebuild");
    const plan = insertPlan({ name: `Rebuild Plan ${seq}`, kind: "recomp", repo: "chenxiao07/KytyPS5", platforms: ["n64"], spec: SPEC(), status: "ready" });
    const romPath = join(tmp("launch-rom-"), "The Game (USA).z64");
    writeFileSync(romPath, ROM);
    const file = insertContent({ gameId: g.id, platform: "n64", name: basename(romPath), path: romPath, size: ROM.byteLength, hashes: { sha1: sha1(ROM), sha256: sha256(ROM) }, source: "upload" });
    const way = updateWay(insertWay({ gameId: g.id, planId: plan.id, status: "ready" }).id, { contentId: file.id, overrides: { argvExtra: ["--fast"] } })!;
    return { g, plan, way };
  }
  const build = async (wayId: number) => {
    const j = enqueueJob({ kind: "assemble", wayId }, { gameId: getWay(wayId)!.game_id });
    await runJob(j.id);
    const done = stmts.jobById.get(j.id) as JobRow;
    expect([done.state, done.message]).toEqual(["done", expect.any(String)]);
    made.dirs.push(pkgOf(getWay(wayId)!.game_id).path);
    return done;
  };

  test("a rebuild starts as set by hand, stamped, with the plan's start recorded as found; the smoke start starts it; a build whose program lacks it starts as the plan says, says so, and keeps it", async () => {
    const { g, way } = await wayToBuild();
    await build(way.id);
    const plan = { exe: "kyty_emulator.exe", args: "", cwd: "", argv: ["--game", "{install}/game/game.z64", "--fast"] };
    expect(manifestOf(g.id).launch).toEqual(plan);
    // the smoke start starts what players start: the way's own arguments included
    expect(smoke.at(-1)).toEqual({ exe: "kyty_emulator.exe", argv: ["--game", "{install}/game/game.z64", "--fast"] });
    expect(JSON.parse(pkgOf(g.id).launch_auto_json!)).toEqual({ launch: plan, requires: { launcher: "0.10.0" } });

    const r = await call("PUT", `/api/v1/game/${g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play", "{content}"] });
    expect(r.status).toBe(200);
    const at = wayOverrides(getWay(way.id)!).launch!.at;
    expect(manifestOf(g.id).launch).toEqual({ exe: "KytyLauncher.exe", args: "", cwd: "", argv: ["--play", "{install}/game/game.z64"], rev: at });

    // the rebuild: the start set by hand, its {content} placed again; the plan's start is what Reset gives back
    const rebuilt = await build(way.id);
    expect(manifestOf(g.id).launch).toEqual({ exe: "KytyLauncher.exe", args: "", cwd: "", argv: ["--play", "{install}/game/game.z64"], rev: at });
    expect(manifestOf(g.id).requires).toEqual({ launcher: "0.10.0" });
    expect(JSON.parse(pkgOf(g.id).launch_auto_json!)).toEqual({ launch: plan, requires: { launcher: "0.10.0" } });
    expect(smoke.at(-1)).toEqual({ exe: "KytyLauncher.exe", argv: ["--play", "{install}/game/game.z64"] });
    expect(rebuilt.transcript).toContain("it starts as set by hand: KytyLauncher.exe --play {install}/game/game.z64");
    // the build's line names the whole start
    expect(rebuilt.message).toMatch(/, launch KytyLauncher\.exe --play \{install\}\/game\/game\.z64(;|$)/);
    expect(wayOverrides(getWay(way.id)!)).toEqual({ argvExtra: ["--fast"], launch: { exe: "KytyLauncher.exe", argv: ["--play", "{content}"], at } });
    expect((await call("GET", `/api/v1/game/${g.id}/launch`)).json.item).toMatchObject({ applied: true, start: { by: "hand" }, auto: { by: "plan", line: "kyty_emulator.exe --game {install}/game/game.z64 --fast" } });

    // a start set by hand whose program the build lacks: the plan's start, the build and the history say so, it is kept
    const gone: LaunchChoice = { exe: "Gone.exe", argv: ["--play"], at: at + 1 };
    updateWay(way.id, { overrides: { ...wayOverrides(getWay(way.id)!), launch: gone } });
    const lacking = await build(way.id);
    expect(manifestOf(g.id).launch).toEqual(plan);
    expect(smoke.at(-1)).toEqual({ exe: "kyty_emulator.exe", argv: ["--game", "{install}/game/game.z64", "--fast"] });
    const words = "the start set by hand (Gone.exe --play) is not applied to the new copy: its program Gone.exe is not in it; it starts with kyty_emulator.exe --game {install}/game/game.z64 --fast, as the plan says";
    expect(lacking.transcript).toContain(words);
    expect(historyOf(g.id).at(-1)).toEqual({ event: "edited", source: "way", message: words });
    expect(wayOverrides(getWay(way.id)!).launch).toEqual(gone);
    expect((await call("GET", `/api/v1/game/${g.id}/launch`)).json.item).toMatchObject({ applied: false, notApplied: "its program Gone.exe is not in this copy", start: { by: "plan" } });
  });

  test("a variable naming a folder of the copy is held to the new copy as an argument is", async () => {
    const d = tmp();
    kytyProgram(d);
    const choice: LaunchChoice = { exe: "KytyLauncher.exe", argv: ["--play"], env: { KYTY_GAME: "{install}/game" }, paths: ["game"], at: 3 };
    expect(await choiceOnDisk(choice, { root: d, placed: null })).toEqual({ why: "the variable KYTY_GAME names game, which is not in it" });
    mkdirSync(join(d, "GAME"));
    expect(await choiceOnDisk(choice, { root: d, placed: null })).toEqual({ start: { exe: "KytyLauncher.exe", argv: ["--play"], env: { KYTY_GAME: "{install}/game" } } });
    rmSync(d, { recursive: true, force: true });
  });

  test("the way's own PUT keeps the start set by hand (a client's round trip, an emptied overrides); a way added never takes one", async () => {
    const { g, way } = await wayToBuild();
    const hand: LaunchChoice = { exe: "KytyLauncher.exe", argv: ["--play"], at: 5 };
    updateWay(way.id, { overrides: { argvExtra: ["--fast"], launch: hand } });
    const read = (await call("GET", `/api/v1/game/${g.id}/ways`)).json.items[0];
    expect(read.overrides.launch).toEqual(hand);
    // sent back as read, with another launch in it, or emptied: the start set by hand is the same
    expect((await call("PUT", `/api/v1/way/${way.id}`, { overrides: { ...read.overrides, argvExtra: ["--faster"], launch: { exe: "kyty_emulator.exe", argv: [], at: 9 } } })).status).toBe(200);
    expect(wayOverrides(getWay(way.id)!)).toEqual({ argvExtra: ["--faster"], launch: hand });
    expect((await call("PUT", `/api/v1/way/${way.id}`, { overrides: null })).status).toBe(200);
    expect(wayOverrides(getWay(way.id)!)).toEqual({ launch: hand });
    expect((await call("PUT", `/api/v1/way/${way.id}`, { overrides: "all" })).json).toEqual({ error: "the way's overrides have problems", errors: ["overrides: {files?, argvExtra?, env?, check?, setup?}"] });
    // the AI's way and a way added: never a start set by hand
    const spec = SPEC();
    expect(validateWayOverrides({ launch: hand }, spec).errors).toEqual(["overrides.launch: how the game starts is set by hand on the game page (Starts with), not here"]);
    expect(validateWayOverrides({ launch: hand, argvExtra: ["-x"] }, spec, { admin: true }).value).toEqual({ argvExtra: ["-x"], launch: hand });
    expect(validateWayOverrides({ launch: { exe: "run.ps1", argv: ["{nope}"], cwd: "../x", at: 0 } }, spec, { admin: true }).errors).toEqual([
      "overrides.launch.exe: Ahoy starts programs and Windows command scripts (.bat, .cmd), no other script and no shortcut",
      "overrides.launch.argv[0]: {nope} is not a placeholder here ({install}, {content})",
      "overrides.launch.cwd: may not hold . or .. segments",
      "overrides.launch.at: when it was set (ms)",
    ]);
    // a command script, set by hand: plain arguments only, and never the launcher's own variable
    expect(validateWayOverrides({ launch: { exe: "run.cmd", argv: ["-x", "{install}/a", "a b"], env: { AHOY_START: "x" }, at: 5 } }, spec, { admin: true }).errors).toEqual([
      `overrides.launch.argv[1]: ${SCRIPT_ARG_WORDS}`, `overrides.launch.argv[2]: ${SCRIPT_ARG_WORDS}`,
      "overrides.launch.env: AHOY_START is the launcher's own for a script (the script's path)",
    ]);
    expect(validateWayOverrides({ launch: { exe: "tools/run.BAT", argv: ["-x", "k=v"], at: 5 } }, spec, { admin: true }).value).toEqual({ launch: { exe: "tools/run.BAT", argv: ["-x", "k=v"], at: 5 } });
    const other = game("Way Added");
    const added = await call("POST", `/api/v1/game/${other.id}/ways`, { planId: way.plan_id, overrides: { launch: hand }, force: true });
    expect(added.json).toEqual({ error: "the way's overrides have problems", errors: ["overrides.launch: how the game starts is set by hand on the game page (Starts with), not here"] });
  });
});

describe("the copy's ahoy.json, rewritten in place", () => {
  test("written beside the old one and renamed over it: never through its link; when the new one cannot be written the old one stays, nothing changes, and the admin is told in words", async () => {
    const c = await importedCopy("Write Fails");
    // ahoy.json as a hard link into a file of the content store
    const store = join(tmp(), "store.json");
    writeFileSync(store, "the store's own bytes");
    rmSync(join(c.dir, "ahoy.json"));
    linkSync(store, join(c.dir, "ahoy.json"));
    const real = { ...ldeps };
    ldeps.writeFile = async () => { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); };
    let r: Awaited<ReturnType<typeof call>>;
    try { r = await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] }); } finally { Object.assign(ldeps, real); }
    expect(r).toEqual({ status: 500, json: { error: "the copy's ahoy.json could not be written (the disk is full): how the game starts is unchanged" } });
    expect(readFileSync(join(c.dir, "ahoy.json"), "utf8")).toBe("the store's own bytes");     // the old one, in its place
    expect(readdirSync(c.dir).filter(n => n.toLowerCase().includes("ahoy"))).toEqual(["ahoy.json"]);   // nothing left behind
    expect(pkgOf(c.g.id).manifest_json).toBe(c.pkg.manifest_json);
    expect((stmts.gameById.get(c.g.id) as GameRow).launch_json ?? null).toBeNull();
    expect(historyOf(c.g.id)).toEqual([]);
    // the rename fails: the same
    ldeps.rename = async () => { throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); };
    try { r = await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] }); } finally { Object.assign(ldeps, real); }
    expect(r.json.error).toBe("the copy's ahoy.json could not be written (it may not be written there): how the game starts is unchanged");
    expect(readdirSync(c.dir).filter(n => n.toLowerCase().includes("ahoy"))).toEqual(["ahoy.json"]);
    expect(readFileSync(join(c.dir, "ahoy.json"), "utf8")).toBe("the store's own bytes");
    // the next Save writes it: a file of its own, the store's file untouched
    expect((await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(c.dir, "ahoy.json"), "utf8"))).toEqual(manifestOf(c.g.id));
    expect(readFileSync(store, "utf8")).toBe("the store's own bytes");
    expect(readdirSync(c.dir).filter(n => n.toLowerCase().includes("ahoy"))).toEqual(["ahoy.json"]);
    // and Reset the same way
    expect((await call("DELETE", `/api/v1/game/${c.g.id}/launch`)).status).toBe(200);
    expect(JSON.parse(readFileSync(join(c.dir, "ahoy.json"), "utf8"))).toEqual(manifestOf(c.g.id));
    expect(readFileSync(store, "utf8")).toBe("the store's own bytes");
  });
});

describe("what the page says, and what it lets the admin do", () => {
  test("a way's copy whose way was removed: it still starts as set by hand and says so; Reset gives the plan's start back; the words say what gives control back", async () => {
    const c = await wayCopy("Way Removed");
    expect((await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).status).toBe(200);
    const rev = manifestOf(c.g.id).launch.rev;
    expect((await call("DELETE", `/api/v1/way/${c.way.id}`)).status).toBe(200);
    const why = "the way to play that built this copy is gone: build a way to play again, or import a new copy, to change how the game starts";
    const v = (await call("GET", `/api/v1/game/${c.g.id}/launch`)).json.item;
    expect(v).toMatchObject({ editable: false, why, set: null, applied: false, notApplied: null, resettable: true, start: { line: "KytyLauncher.exe --play", by: "hand", rev }, auto: { by: "plan", line: "kyty_emulator.exe --game {install}/game/PPSA01341-app0.zar" } });
    // no Change: the start would have nowhere to be kept; Reset puts the plan's start back
    expect(await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: [] })).toEqual({ status: 409, json: { error: why } });
    const back = await call("DELETE", `/api/v1/game/${c.g.id}/launch`);
    expect(back.status).toBe(200);
    expect(manifestOf(c.g.id).launch).toMatchObject({ exe: "kyty_emulator.exe", args: "", argv: ["--game", "{install}/game/PPSA01341-app0.zar"] });
    expect(back.json.item).toMatchObject({ editable: false, resettable: false, start: { by: "plan" } });
    expect(historyOf(c.g.id).at(-1)).toEqual({ event: "edited", source: "the admin", message: "start reset to kyty_emulator.exe --game {install}/game/PPSA01341-app0.zar, as the plan says" });
    expect(await call("DELETE", `/api/v1/game/${c.g.id}/launch`)).toEqual({ status: 404, json: { error: "the start was not set by hand" } });
  });

  test("Reset of a copy the AI importer made says 'as the AI importer found it', as the page does", async () => {
    const c = await importedCopy("Reset AI", { tier: "agent" });
    expect((await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).status).toBe(200);
    expect((await call("DELETE", `/api/v1/game/${c.g.id}/launch`)).json.item.start.by).toBe("ai");
    expect(historyOf(c.g.id).at(-1)!.message).toBe("start reset to kyty_emulator.exe, as the AI importer found it");
  });

  test("a script's program is the file it names, resolved from the script's own folder: its folder kept in 'it runs', 'pick' only for that very file", async () => {
    const g = game("Two Programs Of One Name");
    const dir = join(LIB(), `launch-same-name-${seq}`);
    made.dirs.push(dir);
    for (const d of ["bin/x64", "bin/x86", "tools"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "bin", "x64", "game.exe"), peBytes({ ui: "window", version: { FileDescription: "The Game (64-bit)" }, pad: 300_000 }));
    writeFileSync(join(dir, "bin", "x86", "game.exe"), peBytes({ ui: "window", version: { FileDescription: "The Game (32-bit)" }, pad: 100_000 }));
    writeFileSync(join(dir, "play-32bit.cmd"), '@echo off\r\nrem Starts the 32-bit build, for old graphics cards.\r\n"%~dp0bin\\x86\\game.exe" -windowed %*\r\n');
    // a script in a folder of its own that names a game.exe beside it (there is none), and one that runs a bare name
    writeFileSync(join(dir, "tools", "here.cmd"), '@echo off\r\nrem Runs the game beside this script.\r\n"%~dp0game.exe" -x\r\n');
    writeFileSync(join(dir, "bare.cmd"), "@echo off\r\nrem Runs it by its name.\r\ngame.exe -y\r\n");
    writeFileSync(join(dir, "up.cmd"), '@echo off\r\nrem From a folder up.\r\ncd /d "%~dp0bin\\x64"\r\ngame.exe -z\r\n');
    const v0: Validation = { ok: true, root: dir, problems: [], exeCandidates: [], launch: "bin/x64/game.exe", prerequisites: [], totalSize: 0, fileCount: 0 };
    const m = await buildManifest(v0, { name: g.name, slug: g.slug!, version: null, source: null, tier: "deterministic", kind: "native" });
    stmts.insertPackage.get(g.id, null, dir, g.name, null, m.totalSize, JSON.stringify(m));
    const v = (await call("GET", `/api/v1/game/${g.id}/launch`)).json.item;
    const script = (p: string) => v.scripts.find((s: { path: string }) => s.path === p);
    expect(script("play-32bit.cmd")).toMatchObject({ comment: "Starts the 32-bit build, for old graphics cards.", runs: "bin/x86/game.exe -windowed", program: "bin/x86/game.exe" });
    expect(script("tools/here.cmd")).toMatchObject({ runs: null, program: null });
    expect(script("bare.cmd")).toMatchObject({ runs: null, program: null });
    expect(script("up.cmd")).toMatchObject({ runs: "bin/x64/game.exe -z", program: "bin/x64/game.exe" });
    // picking a script says what it runs, folder and all: the program itself, with those arguments, would need no script
    expect((await call("POST", `/api/v1/game/${g.id}/launch/check`, { exe: "play-32bit.cmd" })).json).toMatchObject({
      errors: [], needsAhoy: "0.11.0",
      warnings: [expect.stringMatching(/^play-32bit\.cmd is a script: on each player's PC it runs through the Windows command shell/), "it runs bin/x86/game.exe -windowed: picking that program with those arguments starts the game without a script"],
    });
  });

  test("a README quoted as written: a usage line keeps its <placeholder> words and a code span its underscores; markdown and real HTML tags go", () => {
    const s = sentencesOf([
      "Without the launcher: `kyty_emulator.exe --game <path to the game folder> --fullscreen` starts the game directly.", "",
      "```", "KytyLauncher.exe --demo-path <folder>", "```", "",
      "Run `__main__.py` with **care**: <b>bold</b> words<br> and a [link](https://example.com).",
    ].join("\n"));
    expect(s).toContain("Without the launcher: kyty_emulator.exe --game <path to the game folder> --fullscreen starts the game directly.");
    expect(s).toContain("KytyLauncher.exe --demo-path <folder>");
    expect(s).toContain("Run __main__.py with care: bold words and a link.");
  });

  test("a program missing from the disk is listed as such, in Save's words", async () => {
    const c = await importedCopy("Missing On Disk");
    rmSync(join(c.dir, "KytyLauncher.exe"));
    const v = (await call("GET", `/api/v1/game/${c.g.id}/launch`)).json.item;
    expect(v.programs.find((p: { path: string }) => p.path === "KytyLauncher.exe").refused).toBe("not on the disk now: the copy is not whole");
    expect((await call("PUT", `/api/v1/game/${c.g.id}/launch`, { exe: "KytyLauncher.exe", argv: ["--play"] })).json.errors).toEqual(["KytyLauncher.exe is not on the disk now: the copy is not whole"]);
  });

  test("a settings window is credited to the program the package says opens it, never to every program a sentence about one names", async () => {
    const c = await importedCopy("Settings Words");
    writeFileSync(join(c.dir, "README.md"), [
      "kyty_emulator.exe plays the game with the options the settings window saved.", "",
      "Double-click `bin/KytyCli.exe` (or `launcher.cmd`) for the settings window.",
    ].join("\n"));
    const check = (exe: string) => call("POST", `/api/v1/game/${c.g.id}/launch/check`, { exe, argv: [] });
    expect((await check("kyty_emulator.exe")).json.warnings).toEqual([]);
    expect((await check("bin/KytyCli.exe")).json.warnings).toEqual([`with no arguments it may open its settings window rather than the game — README.md: "Double-click bin/KytyCli.exe (or launcher.cmd) for the settings window."`]);
    const v = (await call("GET", `/api/v1/game/${c.g.id}/launch`)).json.item;
    expect(Object.keys(v.settingsWindow).sort()).toEqual(["KytyLauncher.exe", "bin/KytyCli.exe"]);
    // the sentence is still quoted, as written, without the inference
    expect(v.programs.find((p: { path: string }) => p.path === "kyty_emulator.exe").words).toContainEqual({ text: "kyty_emulator.exe plays the game with the options the settings window saved.", source: "README.md" });
  });

  test("two options typed into one argument are said to be two", async () => {
    const c = await importedCopy("One Row Two Options");
    const check = (argv: string[]) => call("POST", `/api/v1/game/${c.g.id}/launch/check`, { exe: "KytyLauncher.exe", argv });
    expect((await check(["--play --refocus"])).json.warnings).toEqual(["argument 1 looks like more than one argument: put each in its own row"]);
    expect((await check(["--play", "/x /y"])).json.warnings).toEqual(["argument 2 looks like more than one argument: put each in its own row"]);
    // one argument with a space in its value is one argument
    expect((await check(["--title=Demon's Souls", "--log={install}/logs/readme.txt", "Demon's Souls"])).json.warnings).toEqual([]);
  });
});
