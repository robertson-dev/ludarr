/**
 * The program an import starts the game with (src/process/validate.ts chooseLaunch, read by inspect): the engine's own
 * program read from the copy's layout first, never a library or a known helper (by its name or by what its header says it
 * is), rarely a console program, then the game's name in the file's name and in the header, the top of the copy, the size
 * last; the program the importer named is kept. The live cases are replayed from the headers and sizes recorded on the server.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { chooseLaunch, copyLayout, helperProgram, inspect, NOT_LAUNCH_DIR, NOT_LAUNCH_NAME, vdeps, type FileInfo } from "../src/process/validate";
import type { PeInfo } from "../src/library/pe";
import { peBytes } from "./pe-build";
import { stmts, type JobRow, type PackageRow } from "../src/db";
import { rdeps, runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { recipes } from "../src/plugins/builtin/importers";
import { pluginContext } from "../src/plugins/registry";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";

const W = (version: Record<string, string> = {}): PeInfo => ({ kind: "program", ui: "window", version });
const C = (version: Record<string, string> = {}): PeInfo => ({ kind: "program", ui: "console", version });
const DLL: PeInfo = { kind: "dll", ui: "window", version: {} };
const OTHER: PeInfo = { kind: "other", ui: null, version: {} };

/** a copy as the picker sees it: each file's path and size, and the header of the programs that have one */
function pick(name: string, entries: [string, number, PeInfo?][]) {
  const files: FileInfo[] = entries.map(([rel, size]) => ({ rel, size, ext: extname(rel).toLowerCase() }));
  const pe = new Map(entries.filter(e => e[2]).map(([rel, , p]) => [rel, p!] as [string, PeInfo]));
  return chooseLaunch(files, name, rel => pe.get(rel));
}

/** a copy on disk: real program headers (tests/pe-build.ts) and plain files */
function onDisk(files: Record<string, Uint8Array | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "launch-pick-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
const win = (version?: Record<string, string>, pad = 0) => peBytes({ ui: "window", version, pad });
const con = (version?: Record<string, string>, pad = 0) => peBytes({ ui: "console", version, pad });
const blob = (n: number) => new Uint8Array(n);

const NWJS = { CompanyName: "The NW.js Community", FileDescription: "nwjs", FileVersion: "0.94.0", InternalName: "nw_exe", OriginalFilename: "nw.exe", ProductName: "nwjs", ProductVersion: "0.94.0" };

describe("the live copies, replayed from what the server recorded", () => {
  test("METAL GEAR SOLID 4 - Master Collection (a bundle: a launcher, two games and a database viewer, each in its folder): its launcher — not MGS4DB.exe, the viewer's Unreal program", () => {
    const MC = "METAL GEAR SOLID 4: Guns of the Patriots - Master Collection Version";
    const copy: [string, number, PeInfo?][] = [
      ["MGS4DB/MGS4DB.exe", 426496, W({ ProductName: "METAL GEAR SOLID 4 GUNS OF THE PATRIOTS" })],
      ["MGS4DB/MGS4DB/Binaries/Win64/MGS4DB-Win64-Shipping.exe", 148105800, W({ ProductName: "METAL GEAR SOLID 4 GUNS OF THE PATRIOTS" })],
      ["MGS4DB/Engine/Binaries/ThirdParty/Steamworks/Steamv157/Win64/steam_api64.dll", 1118360],
      ["MGS4/mgs4.exe", 32682568, W({ ProductName: MC })], ["MGS4/steam_api64.dll", 1118360], ["MGS4/common/stage.dat", 9_000_000_000],
      ["MGS1/mgs1.exe", 6781000, W({ ProductName: "METAL GEAR SOLID 4: Guns of the Patriots: METAL GEAR" })], ["MGS1/mgs4mgs1_us.img", 3_000_000],
      ["Launcher/launcher.exe", 906312, W()], ["Launcher/UnityCrashHandler64.exe", 1531064, W()], ["Launcher/UnityPlayer.dll", 33532840], ["Launcher/launcher_Data/globalgamemanagers", 100_000],
      ["_CommonRedist/vcredist/2022/VC_redist.x64.exe", 18731856, W({ FileDescription: "Microsoft Visual C++ v14 Redistributable (x64) - 14.51.36247" })],
    ];
    const r = pick(MC, copy);
    expect(r.launch).toBe("Launcher/launcher.exe");
    expect(r.why).toBe("the launcher of a copy that holds several programs (MGS1, MGS4, MGS4DB)");
    // the others in the order of how fully each names the game: the game itself, then the rest
    expect(r.candidates).toEqual(["Launcher/launcher.exe", "MGS4/mgs4.exe", "MGS4DB/MGS4DB.exe", "MGS4DB/MGS4DB/Binaries/Win64/MGS4DB-Win64-Shipping.exe", "MGS1/mgs1.exe"]);
    // without a launcher the program that names the game most fully starts it, whatever engine the others are built on
    const bare = pick(MC, copy.filter(([rel]) => !rel.startsWith("Launcher/")));
    expect(bare).toMatchObject({ launch: "MGS4/mgs4.exe", why: `its header names the game: ${MC}` });
    // a launcher beside ONE game is no front door: the game starts (a store's or a settings launcher is skipped, as ever)
    const pair = pick("Some Game", [["Launcher/Launcher.exe", 900_000, W()], ["Game/SomeGame.exe", 30_000_000, W()], ["Game/data.pak", 1e9]]);
    expect(pair.launch).toBe("Game/SomeGame.exe");
    // and one game whose programs are at the top of the copy is no bundle: its engine's program, as before
    const unreal = pick("Some Game", [["SomeGame.exe", 400_000, W()], ["SomeGame/Binaries/Win64/SomeGame-Win64-Shipping.exe", 90_000_000, W()], ["Launcher/Launcher.exe", 900_000, W()], ["Extras/Viewer.exe", 5_000_000, W()]]);
    expect(unreal).toMatchObject({ launch: "SomeGame.exe", why: "the game's Unreal program (it starts SomeGame/Binaries)" });
  });
  test("Look Outside (NW.js / RPG Maker): Game.exe, whose header names it nw.exe — not nwjc.exe, the 26 MB NW.js compiler the size-first picker took", () => {
    const r = pick("Look Outside", [
      ["Game.exe", 2760192, W(NWJS)],
      ["chromedriver.exe", 18452480, C()],
      ["notification_helper.exe", 1373696, W({ ...NWJS, InternalName: "notification_helper_exe", OriginalFilename: "notification_helper.exe" })],
      ["nwjc.exe", 26364416, C()],
      ["nw.dll", 248019456], ["node.dll", 23948288], ["package.json", 309], ["index.html", 708], ["resources.pak", 10269727],
      ["js/rpg_core.js", 300000], ["data/Map001.json", 20000], ["www/img/x.png", 1000],
    ]);
    expect(r).toEqual({ launch: "Game.exe", candidates: ["Game.exe"], why: "the game's NW.js program (its header names it nw.exe)" });
  });
  test("MARVEL Tōkon (Unreal): the program at the top over its Binaries build, the Easy Anti-Cheat bootstrapper and Sony's error reporter", () => {
    const shipping = { OriginalFilename: "MTFSSteam-Win64-Shipping.exe", InternalName: "MTFS", FileDescription: "MARVEL Tokon: Fighting Souls", ProductName: "MARVEL Tokon: Fighting Souls", CompanyName: "Epic Games, Inc." };
    const sony = { ProductName: "Sony Error Reporter", CompanyName: "Sony Interactive Entertainment" };
    const r = pick("MARVEL Tōkon: Fighting Souls", [
      ["MTFS.exe", 138240, W(shipping)],
      ["MTFS/Binaries/Win64/MTFSSteam-Win64-Shipping.exe", 218870712, W(shipping)],
      ["MTFS/Binaries/Win64/crs-handler.exe", 1499368, W(sony)],
      ["MTFS/Binaries/Win64/crs-uploader.exe", 862952, C(sony)],
      ["MTFS/Binaries/Win64/crs-video.exe", 1423080, W(sony)],
      ["MTFS/Binaries/Win64/Prerequisites/eos_eac_setup/EasyAntiCheat_EOS_Setup.exe", 965416, C({ InternalName: "Easy Anti-Cheat Service (EOS)" })],
      ["start_protected_game.exe", 3977000, W({ InternalName: "Easy Anti-Cheat Bootstrapper (EOS)", FileDescription: "Easy Anti-Cheat Bootstrapper (EOS)", ProductName: "Easy Anti-Cheat Bootstrapper (EOS)" })],
      ["unins000.exe", 1515889, W({ FileDescription: "Setup/Uninstall" })],
      ["Engine/Binaries/ThirdParty/x.dll", 1000],
    ]);
    expect(r.launch).toBe("MTFS.exe");                                       // the deployed picker took start_protected_game.exe
    expect(r.candidates).toEqual(["MTFS.exe", "MTFS/Binaries/Win64/MTFSSteam-Win64-Shipping.exe"]);
    expect(r.why).toBe("the game's Unreal program (it starts MTFS/Binaries)");
  });
  test("Call of Duty: the single-player program whose header names the whole game, over cod.exe, which names only the series", () => {
    const r = pick("Call of Duty®: Modern Warfare® 4", [
      ["cod.exe", 229256176, W({ OriginalFilename: "cod.exe", FileDescription: "Call of Duty®", ProductName: "Call of Duty®" })],
      ["sp26/sp26-cod.exe", 229181936, W({ OriginalFilename: "sp26-cod.exe", FileDescription: "Call of Duty®: Modern Warfare® 4 SP", ProductName: "Call of Duty®: Modern Warfare® 4 SP" })],
      ["ccsdownloader.exe", 2199032, W({ FileDescription: "Call of Duty® Patch Downloader", ProductName: "Call of Duty® Patch Downloader" })],
      ["CrashLogsGenerator.exe", 76059296, W({ ProductName: "Call of Duty®" })],
      ["codCrashHandler.exe", 1604600, C({ FileDescription: "Call of Duty External Crash Handler" })],
      ["CODBrokerService.exe", 166384, C()],
      ["bootstrapper.exe", 398328, W()],
      ["unins000.exe", 1515889, W({ FileDescription: "Setup/Uninstall" })],
    ]);
    expect(r.launch).toBe("sp26/sp26-cod.exe");
    expect(r.why).toBe("its header names the game: Call of Duty®: Modern Warfare® 4 SP");
    expect(r.candidates).not.toContain("CrashLogsGenerator.exe");
  });
  test("Hades: the 64-bit program over the 32-bit one even when that one is bigger", () => {
    const r = pick("Hades", [["x86/Hades.exe", 900000, W()], ["x64/Hades.exe", 496128, W()], ["x64Vk/Hades.exe", 496128, W()]]);
    expect(r.launch).toBe("x64/Hades.exe");
    expect(r.candidates.at(-1)).toBe("x86/Hades.exe");
  });
});

describe("engine layouts come first", () => {
  test("Unity: <Name>.exe beside <Name>_Data and its runtime, over a bigger program at the top and the crash handler; a crack folder's copy is never a candidate", () => {
    const r = pick("Some Other Title", [
      ["Game.exe", 650000, W()], ["Game_Data/globalgamemanagers", 1000000], ["UnityPlayer.dll", 30000000, DLL],
      ["UnityCrashHandler64.exe", 1500000, W({ FileDescription: "Unity Crash Handler" })],
      ["Patch.exe", 90000000, W()],
      ["RUNE/Game.exe", 650000, W()], ["RUNE/Game_Data/Plugins/steam_api64.dll", 300000],
    ]);
    expect(r.launch).toBe("Game.exe");
    expect(r.candidates).toEqual(["Game.exe", "Patch.exe"]);
    expect(r.why).toBe("the game's Unity program (beside Game_Data)");
  });
  test("a Unity player whose name reads like a helper's (Crash…) is taken for its layout; the crash handler never is", () => {
    const r = pick("Crash Bandicoot N. Sane Trilogy", [
      ["CrashBandicootNSaneTrilogy.exe", 650000, W()], ["CrashBandicootNSaneTrilogy_Data/Managed/Assembly-CSharp.dll", 9000000, DLL],
      ["UnityCrashHandler64.exe", 1500000, W()], ["CrashReporter.exe", 3000000, W()],
    ]);
    expect(r.launch).toBe("CrashBandicootNSaneTrilogy.exe");
    expect(r.candidates).toEqual(["CrashBandicootNSaneTrilogy.exe"]);
  });
  test("Unreal: the root program by its header when its name is not the project's; without one, the build under Binaries over a loader at the top", () => {
    const boot = { OriginalFilename: "BootstrapPackagedGame-Win64-Shipping.exe", FileDescription: "BootstrapPackagedGame", ProductName: "BootstrapPackagedGame" };
    const named = pick("Hogwarts Legacy", [
      ["HogwartsLegacy.exe", 400000, W(boot)], ["Phoenix/Binaries/Win64/HogwartsLegacy.exe", 180000000, W({ ProductName: "Hogwarts Legacy" })],
      ["Engine/Binaries/Win64/CrashReportClient.exe", 28000000, W({ OriginalFilename: "CrashReportClient.exe" })],
      ["Engine/Binaries/Win64/UnrealCEFSubProcess.exe", 1000000, W()],
    ]);
    expect(named.launch).toBe("HogwartsLegacy.exe");
    const bare = pick("Stray Thing", [
      ["Loader.exe", 9000000, W()], ["Stray/Binaries/Win64/Stray-Win64-Shipping.exe", 90000000, W()], ["Engine/Binaries/Win64/EpicWebHelper.exe", 3000000, W()],
    ]);
    expect(bare).toMatchObject({ launch: "Stray/Binaries/Win64/Stray-Win64-Shipping.exe", candidates: ["Stray/Binaries/Win64/Stray-Win64-Shipping.exe", "Loader.exe"] });
  });
  test("Electron: the app's program beside resources/app.asar — never Squirrel's Update.exe, Squirrel.exe or elevate.exe", () => {
    const r = pick("Neon Nights", [
      ["Update.exe", 1900000, W({ OriginalFilename: "Update.exe" })],
      ["app-1.2.0/Stellar.exe", 150000000, W({ OriginalFilename: "Stellar.exe" })],
      ["app-1.2.0/Squirrel.exe", 1900000, W()],
      ["app-1.2.0/resources/app.asar", 50000000], ["app-1.2.0/resources/elevate.exe", 100000, W()],
      ["app-1.2.0/chrome_crashpad_handler.exe", 1000000, C()],
      ["Bigger Tool At The Top.exe", 300000000, W()],
    ]);
    expect(r.launch).toBe("app-1.2.0/Stellar.exe");
    expect(r.candidates).toEqual(["app-1.2.0/Stellar.exe", "Bigger Tool At The Top.exe"]);
  });
  test("Ren'Py: <Name>.exe beside <Name>.py and renpy/ — never lib/**/python(w).exe or zsync", () => {
    const r = pick("Doki Doki Literature Club!", [
      ["DDLC.exe", 100000, W()], ["DDLC.py", 2000], ["renpy/common/00start.rpy", 9000],
      ["lib/py3-windows-x86_64/DDLC.exe", 500000, W()],
      ["lib/py3-windows-x86_64/python.exe", 100000, C()], ["lib/py3-windows-x86_64/pythonw.exe", 900000, W()],
      ["lib/py3-windows-x86_64/zsync.exe", 800000, C()], ["lib/py3-windows-x86_64/zsyncmake.exe", 800000, C()],
    ]);
    expect(r.launch).toBe("DDLC.exe");
    expect(r.candidates).toEqual(["DDLC.exe", "lib/py3-windows-x86_64/DDLC.exe"]);
  });
  test("GameMaker: beside data.win, even when its name reads like a helper's (Crashlands); 7-Zip and aria2c never", () => {
    const r = pick("Crashlands", [["Crashlands.exe", 5000000, W()], ["data.win", 90000000], ["7z.exe", 9000000, C()], ["7za.exe", 9000000, C()], ["aria2c.exe", 9000000, C()], ["options.ini", 100]]);
    expect(r).toMatchObject({ launch: "Crashlands.exe", candidates: ["Crashlands.exe"], why: "the game's GameMaker program (beside data.win)" });
  });
  test("Godot: beside <Name>.pck, or the engine by its header; never <Name>.console.exe", () => {
    expect(pick("Batomon Showdown", [["bs.exe", 80000000, W()], ["bs.pck", 200000000], ["bs.console.exe", 90000000, C()], ["uc-online64.exe", 135680, C()]]).launch).toBe("bs.exe");
    const packed = pick("Other Name", [["x.exe", 80000000, W({ FileDescription: "Godot Engine" })], ["x.console.exe", 90000000, C({ FileDescription: "Godot Engine" })], ["Launcher2.exe", 120000000, W()]]);
    expect(packed).toMatchObject({ launch: "x.exe", why: "the game's Godot program (its header names Godot)" });
  });
  test("RPG Maker (VX Ace, 2003), LÖVE and Adventure Game Studio, by their layout or the engine's name in the header", () => {
    expect(pick("A Tale", [["Game.exe", 400000, W()], ["Game.ini", 100], ["Game.rgss3a", 90000000], ["System/RGSS301.dll", 2000000, DLL], ["Patcher.exe", 9000000, W()]]).launch).toBe("Game.exe");
    expect(pick("A Tale", [["RPG_RT.exe", 900000, W()], ["RPG_RT.ldb", 900000], ["Harmony.dll", 100000, DLL], ["Extras.exe", 9000000, W()]]).launch).toBe("RPG_RT.exe");
    expect(pick("Balatro", [["Game.exe", 56000000, W({ OriginalFilename: "love.exe" })], ["lovec.exe", 90000000, C({ OriginalFilename: "lovec.exe" })]]).launch).toBe("Game.exe");
    expect(pick("Endacopia", [["Windows/Endacopia.exe", 1325447755, W({ OriginalFilename: "acwin.exe" })], ["Windows/winsetup.exe", 155674, W({ OriginalFilename: "setup.exe" })]]))
      .toMatchObject({ launch: "Windows/Endacopia.exe", candidates: ["Windows/Endacopia.exe"] });
  });
});

describe("never a library or a known helper, rarely a console program", () => {
  test("helpers known by what their header says (renamed, and bigger than the game), and a library named .exe, are never candidates", () => {
    const r = pick("Mystery Quest", [
      ["MysteryQuest.exe", 500000, W()],
      ["a.exe", 9000000, W({ OriginalFilename: "crashpad_handler.exe" })],
      ["b.exe", 9000000, W({ InternalName: "setup" })],
      ["c.exe", 9000000, W({ OriginalFilename: "VC_redist.x64.exe" })],
      ["d.exe", 9000000, W({ InternalName: "Easy Anti-Cheat Bootstrapper (EOS)" })],
      ["e.exe", 9000000, W({ FileDescription: "Microsoft Visual C++ 2015-2022 Redistributable (x64)" })],
      ["f.exe", 9000000, W({ ProductName: "Sony Error Reporter" })],
      ["g.exe", 9000000, W({ OriginalFilename: "QtWebEngineProcess.exe" })],
      ["h.exe", 9000000, W({ OriginalFilename: "CefSharp.BrowserSubprocess.exe" })],
      ["i.exe", 9000000, W({ OriginalFilename: "BEService.exe" })],
      ["j.exe", 9000000, W({ InternalName: "UE4PrereqSetup_x64" })],
      ["k.exe", 9000000, DLL],
      ["__support/scriptinterpreter.exe", 9000000, W({ FileDescription: "GOG.com, scriptIntepreter" })],
    ]);
    expect(r).toMatchObject({ launch: "MysteryQuest.exe", candidates: ["MysteryQuest.exe"] });
  });
  test("a console program only when nothing else can start: a window program first, then one whose header could not be read", () => {
    expect(pick("Cataclysm", [["cataclysm.exe", 30000000, C()], ["cataclysm-tiles.exe", 20000000, W()]]).launch).toBe("cataclysm-tiles.exe");
    const kyty = pick("Demon's Souls", [["KytyLauncher.exe", 349696, W()], ["kyty_emulator.exe", 25778688, C()], ["kyty_shader_precompile.exe", 12153856, C()]]);
    expect(kyty).toMatchObject({ launch: "KytyLauncher.exe", why: "a window program: the others are console programs" });
    expect(pick("X", [["unread.exe", 1000], ["tool.bin.exe", 9000000, C()]])).toMatchObject({ launch: "unread.exe", why: "the others are console programs" });
    expect(pick("X", [["unread.exe", 1000, OTHER], ["tool.bin.exe", 9000000, C()]]).launch).toBe("tool.bin.exe");
    expect(pick("X", [["unread.exe", 9000000, OTHER], ["small.exe", 1000, W()]]).launch).toBe("small.exe");
    expect(pick("Brogue", [["brogue.exe", 3000000, C()]])).toMatchObject({ launch: "brogue.exe", candidates: ["brogue.exe"] });
    expect(pick("X", [["setup.exe", 1, W()], ["k.exe", 1, DLL]])).toEqual({ launch: null, candidates: [], why: null });
  });
  test("the helpers an engine ships are dimmed in the admin's picker too (the name filter), and only those", () => {
    for (const n of ["nwjc.exe", "chromedriver.exe", "notification_helper.exe", "crashpad_handler.exe", "elevate.exe", "Squirrel.exe", "Update.exe", "QtWebEngineProcess.exe",
      "python.exe", "pythonw.exe", "python3.11.exe", "zsync.exe", "zsyncmake.exe", "aria2c.exe", "7z.exe", "7za.exe", "7zG.exe", "EasyAntiCheat_EOS.exe", "UE5PrereqSetup_x64.exe"]) expect([n, NOT_LAUNCH_NAME.test(n)]).toEqual([n, true]);
    for (const n of ["Game.exe", "Elevated.exe", "7zombies.exe", "Python Adventure.exe", "KytyCli.exe", "KytyLauncher.exe", "Squirrel Stapler.exe", "SuperSquirrel.exe", "SquirrelWithAGun.exe", "Javelin.exe", "AutoRunner.exe"]) expect([n, NOT_LAUNCH_NAME.test(n)]).toEqual([n, false]);
    for (const n of ["javaw.exe", "java.exe", "AutoRun.exe", "instmsiw.exe", "InstMsiA.exe", "WEXTRACT.EXE"]) expect([n, NOT_LAUNCH_NAME.test(n)]).toEqual([n, true]);
    expect(NOT_LAUNCH_DIR.test("__support/scriptinterpreter.exe")).toBe(true);
    expect(NOT_LAUNCH_DIR.test("my__support/game.exe")).toBe(false);
  });
});

describe("inspect reads each program's own header", () => {
  test("Look Outside on disk: Game.exe, with the reason, the helpers out of the candidates; without its version info it is still the NW.js program", async () => {
    const files = {
      "Game.exe": win(NWJS, 200_000),
      "nwjc.exe": con(undefined, 2_600_000),
      "chromedriver.exe": con(undefined, 1_800_000),
      "notification_helper.exe": win({ ...NWJS, InternalName: "notification_helper_exe", OriginalFilename: "notification_helper.exe" }, 100_000),
      "nw.dll": peBytes({ dll: true, pad: 5_000_000 }),
      "package.json": JSON.stringify({ name: "look-outside", main: "index.html" }),
      "index.html": "<html></html>", "js/main.js": "x", "data/System.json": "{}",
    };
    const v = await inspect(onDisk(files), { name: "Look Outside" });
    expect(v).toMatchObject({ ok: true, launch: "Game.exe", exeCandidates: ["Game.exe"], launchWhy: "the game's NW.js program (its header names it nw.exe)" });
    const bare = await inspect(onDisk({ ...files, "Game.exe": win(undefined, 200_000) }), { name: "Look Outside" });
    expect(bare).toMatchObject({ ok: true, launch: "Game.exe", launchWhy: "the game's NW.js program (beside nw.dll and package.json)" });
  });
  test("a Unity copy on disk: the player over a bigger crash handler and a bigger console tool; a library named .exe is never taken", async () => {
    const dir = onDisk({
      "Mouthwashing.exe": win(undefined, 600_000), "UnityPlayer.dll": peBytes({ dll: true, pad: 5_000_000 }), "Mouthwashing_Data/globalgamemanagers": blob(100_000),
      "UnityCrashHandler64.exe": win({ FileDescription: "Unity Crash Handler", ProductName: "Unity" }, 1_100_000),
      "dumper.exe": con(undefined, 2_000_000), "plugin.exe": peBytes({ dll: true, pad: 3_000_000 }),
    });
    expect(await inspect(dir, { name: "Mouthwashing" })).toMatchObject({ ok: true, launch: "Mouthwashing.exe", exeCandidates: ["Mouthwashing.exe", "dumper.exe"] });
  });
  test("the program the importer named (the AI importer's choice) is kept as it is, with a backslash path too", async () => {
    const dir = onDisk({ "Game.exe": win(NWJS, 100_000), "nwjc.exe": con(undefined, 100_000), "nw.dll": peBytes({ dll: true, pad: 5_000_000 }), "package.json": "{}", "bin/Tool.exe": win(undefined, 1000) });
    expect(await inspect(dir, { name: "Look Outside", launchExe: "nwjc.exe" })).toMatchObject({ launch: "nwjc.exe", launchWhy: "the program the importer named" });
    expect((await inspect(dir, { name: "Look Outside", launchExe: "bin\\Tool.exe" })).launch).toBe("bin/Tool.exe");
    // a name that is not in the copy is not a choice: ludarr picks
    expect(await inspect(dir, { name: "Look Outside", launchExe: "missing.exe" })).toMatchObject({ launch: "Game.exe", launchWhy: expect.stringMatching(/NW\.js/) });
  });
  test("an Unreal copy on disk: the root program, though the build under Binaries is far bigger and names the game in its header", async () => {
    const dir = onDisk({
      "Hellraiser.exe": win({ OriginalFilename: "BootstrapPackagedGame-Win64-Shipping.exe", InternalName: "UnrealEngine", FileDescription: "BootstrapPackagedGame", ProductName: "BootstrapPackagedGame" }, 400_000),
      "Hellraiser/Binaries/Win64/Hellraiser-Win64-Shipping.exe": win({ OriginalFilename: "Hellraiser-Win64-Shipping.exe", FileDescription: "Hellraiser", ProductName: "Hellraiser" }, 5_000_000),
      "Engine/Binaries/Win64/CrashReportClient.exe": win({ OriginalFilename: "CrashReportClient.exe", FileDescription: "CrashReportClient" }, 2_000_000),
      "Engine/Extras/Redist/en-us/UE4PrereqSetup_x64.exe": win({ OriginalFilename: "UE4PrereqSetup_x64.exe", InternalName: "setup" }, 1_000),
    });
    expect(await inspect(dir, { name: "Clive Barker's Hellraiser: Revival" })).toMatchObject({
      ok: true, launch: "Hellraiser.exe", exeCandidates: ["Hellraiser.exe", "Hellraiser/Binaries/Win64/Hellraiser-Win64-Shipping.exe"],
      launchWhy: "the game's Unreal program (it starts Hellraiser/Binaries)",
    });
  });
});

/** Red Alert 3, live package #46: the RELOADED disc extracted and never installed, its programs' headers as recorded */
const RA3: [string, number, PeInfo?][] = [
  ["AutoRun.exe", 447752, W({ CompanyName: "Electronic Arts, Inc.", FileDescription: "Autorun program", FileVersion: "2.3.2.0", InternalName: "AutoRun.exe", OriginalFilename: "AutoRun.exe", ProductName: "Autorun", ProductVersion: "2.3.2.0" })],
  ["EASetup.exe", 447752, W({ CompanyName: "Electronic Arts, Inc.", FileDescription: "Autorun program", FileVersion: "2.3.2.0", InternalName: "AutoRun.exe", OriginalFilename: "AutoRun.exe", ProductName: "Autorun", ProductVersion: "2.3.2.0" })],
  ["Crack/rld-ra3k.exe", 8192, W()],
  ["DirectX/DXSETUP.exe", 528392, W({ FileDescription: "Microsoft DirectX Setup", OriginalFilename: "dxsetup.exe" })],
  ["Support/EADM/eadm-installer.exe", 15526656, W({ FileDescription: "Setup Launcher", InternalName: "Setup", OriginalFilename: "Setup.exe" })],
  ["Support/Red Alert 3_code.exe", 386312, W({ FileDescription: "Unified Registration code installer program" })],
  ["Support/Red Alert 3_uninst.exe", 189704, C({ FileDescription: "Registration code installer program" })],
  ["autorun.inf", 137], ["autorun.dat", 4108288], ["ra3.ico", 29310], ["Core_0.cab", 86991621], ["Core_5.cab", 433805577], ["Maps_0.cab", 182991541],
  ["Crack/Data/ra3_1.0.game", 40506608], ["Data/static.big", 900_000_000], ["Data/ra3_english_1.big", 700_000_000],
];

describe("a disc that was never installed (review: Red Alert 3 started on its autorun menu, CoD4 on the Windows Installer)", () => {
  test("Red Alert 3 (#46): neither its autorun program, by its header, nor the crack folder's program starts it — nothing does", () => {
    expect(pick("Command & Conquer™ Red Alert™ 3", RA3)).toEqual({ launch: null, candidates: [], why: null });
  });
  test("on disk, inspect says it is the game's disc, which has to be installed (the AI importer, which runs installers, takes it)", async () => {
    const autorun = win({ FileDescription: "Autorun program", ProductName: "Autorun", OriginalFilename: "AutoRun.exe", InternalName: "AutoRun.exe" }, 400_000);
    const v = await inspect(onDisk({ "AutoRun.exe": autorun, "EASetup.exe": autorun, "autorun.inf": "[autorun]\r\nopen=AutoRun.exe\r\n", "Core_0.cab": blob(2_000_000),
      "Crack/rld-ra3k.exe": win(undefined, 8_000), "Data/static.big": blob(6_000_000) }), { name: "Command & Conquer™ Red Alert™ 3" });
    expect(v.ok).toBe(false);
    expect(v.launch).toBeNull();
    expect(v.problems).toContain("this is the game's disc, not the installed game: autorun.inf beside Core_0.cab — it has to be installed");
  });
  test("CoD4's Razor1911 disc: never instmsiw.exe (the Windows Installer redistributable), never the crack's iw3sp.exe; inspect says it is a disc", async () => {
    const disc: [string, number, PeInfo?][] = [
      ["autorun.inf", 60], ["setup.exe", 118784, W({ OriginalFilename: "Setup.exe", InternalName: "Setup" })], ["instmsia.exe", 1708856, W()], ["instmsiw.exe", 1822520, W()],
      ["Data1.cab", 2_100_000_000], ["Call of Duty(R) 4 - Modern Warfare(TM).msi", 2_500_000], ["zone/english/common.ff", 900_000_000],
      ["Razor1911/iw3sp.exe", 3_342_336, W({ ProductName: "Call of Duty(R) 4 - Modern Warfare(TM)" })], ["DirectX/DXSETUP.exe", 491520, W()],
    ];
    expect(pick("Call of Duty®: Modern Warfare® 4", disc)).toEqual({ launch: null, candidates: [], why: null });
    // a self-extracting installer is known by the name its header gives it, whatever its file is called
    expect(pick("X", [["x.exe", 5_000_000, W({ OriginalFilename: "WEXTRACT.EXE" })], ["game.exe", 1_000_000, W()]]).candidates).toEqual(["game.exe"]);
    const v = await inspect(onDisk({ "autorun.inf": "[autorun]\r\nopen=setup.exe\r\n", "setup.exe": win({ OriginalFilename: "Setup.exe" }, 100_000), "instmsiw.exe": win(undefined, 200_000),
      "Data1.cab": blob(6_000_000), "game.msi": blob(1_500_000), "Razor1911/iw3sp.exe": win(undefined, 300_000) }), { name: "Call of Duty®: Modern Warfare® 4" });
    expect(v).toMatchObject({ ok: false, launch: null });
    expect(v.problems).toContain("this is the game's disc, not the installed game: autorun.inf beside Data1.cab, game.msi — it has to be installed");
  });
  test("an installed game with an autorun.inf of its own and no installer's payload is no disc", async () => {
    const v = await inspect(onDisk({ "Game.exe": win(undefined, 3_000_000), "autorun.inf": "[autorun]\r\nicon=game.ico\r\n", "data.pak": blob(6_000_000) }), { name: "Game" });
    expect(v).toMatchObject({ ok: true, launch: "Game.exe" });
  });
});

describe("what the reason says (review: a patch installer was 'its name is the game's' for one word of four; a header naming another entry)", () => {
  test("one word of the game's name is part of its name, not the game's name", () => {
    const r = pick("Command & Conquer™ Red Alert™ 3", [["RedAlert3_english_patch1.012.exe", 455_000_000, W()], ["SKIDROW/Data/ra3_1.12.game", 40_600_000], ["skidrow.nfo", 9000]]);
    expect(r).toEqual({ launch: "RedAlert3_english_patch1.012.exe", candidates: ["RedAlert3_english_patch1.012.exe"], why: "part of its name is the game's" });
  });
  test("a header with another number than the game's names another entry: the one with the game's number is taken, for its header", () => {
    const r = pick("Command & Conquer™ Red Alert™ 3", [["ra2.exe", 9_000_000, W({ ProductName: "Command & Conquer Red Alert 2" })], ["game.exe", 5_000_000, W({ ProductName: "Command & Conquer Red Alert 3" })]]);
    expect(r).toEqual({ launch: "game.exe", candidates: ["game.exe", "ra2.exe"], why: "its header names the game: Command & Conquer Red Alert 3" });
    // the whole name written together is the game's name, its year aside
    expect(pick("Lords Of The Fallen™ 2014", [["bin/LordsOfTheFallen.exe", 9_000_000, W()], ["bin/Tool.exe", 1_000_000, W()]])).toMatchObject({ launch: "bin/LordsOfTheFallen.exe", why: "its name is the game's" });
    // a version is no entry's number
    expect(pick("Hades", [["Hades.exe", 1_000_000, W({ FileDescription: "Hades 1.38" })], ["Other.exe", 9_000_000, W()]]).launch).toBe("Hades.exe");
    expect(pick("Hades", [["h.exe", 1_000_000, W({ ProductName: "Hades II" })], ["Other.exe", 900_000, W()]])).toMatchObject({ launch: "h.exe" });
    expect(pick("Hades", [["h.exe", 1_000_000, W({ ProductName: "Hades II" })], ["Other.exe", 900_000, W()]]).why).toBe("nothing names the game: the program nearest the top, then the largest");
  });
});

describe("what is no Windows program ranks last (review: a non-PE file and a 28-byte one outranked the console program)", () => {
  test("a header that says it is no program, a file too small to hold one: the console program is taken, they rank last", () => {
    expect(pick("Brogue", [["brogue.exe", 3_000_000, C({ ProductName: "Brogue" })], ["data.exe", 9_000_000, OTHER]])).toEqual({ launch: "brogue.exe", candidates: ["brogue.exe", "data.exe"], why: "its name is the game's" });
    expect(pick("X", [["cli.exe", 3_000_000, C()], ["data.exe", 9_000_000, OTHER]])).toMatchObject({ launch: "cli.exe", why: "the others are not Windows programs" });
    expect(pick("Brogue", [["brogue.exe", 3_000_000, C({ ProductName: "Brogue" })], ["stub.exe", 0]])).toMatchObject({ launch: "brogue.exe", candidates: ["brogue.exe", "stub.exe"] });
  });
  test("on disk: an MZ stub with no PE header and a text file named .exe are passed over for the real console program", async () => {
    const stub = new Uint8Array(4096); stub[0] = 0x4d; stub[1] = 0x5a;
    const v = await inspect(onDisk({ "Game.exe": stub, "broken.exe": "this is not a program at all", "game-cli.exe": con(undefined, 3_000_000), "data.pak": blob(6_000_000) }), { name: "Some Game" });
    expect(v).toMatchObject({ ok: true, launch: "game-cli.exe", exeCandidates: ["game-cli.exe", "Game.exe", "broken.exe"], launchWhy: "the others are not Windows programs" });
  });
});

describe("a header that could not be read is unread, not 'no program' (src/library/pe.ts reads both as other)", () => {
  test("a program whose file went away while it was read ranks as unread, above the console program", async () => {
    const dir = onDisk({ "Main.exe": con(undefined, 2_000_000), "Locked.exe": win(undefined, 1_000_000), "data.pak": blob(6_000_000) });
    const saved = vdeps.peInfo;
    vdeps.peInfo = async (path: string) => { if (path.endsWith("Locked.exe")) { rmSync(path); return { kind: "other", ui: null, version: {} }; } return saved(path); };
    try {
      const v = await inspect(dir, { name: "Some Game" });
      expect(v).toMatchObject({ launch: "Locked.exe", exeCandidates: ["Locked.exe", "Main.exe"], launchWhy: "the others are console programs" });
    } finally { vdeps.peInfo = saved; }
  });
});

describe("a console program that names the game (review: a bundled javaw.exe won as the only window program)", () => {
  test("a Java runtime's programs are helpers, by name, folder and header; the game's console program is taken", () => {
    const r = pick("Frontier Outpost", [
      ["FrontierOutpost.exe", 600_000, C({ ProductName: "Frontier Outpost" })], ["game.jar", 80_000_000],
      ["jre/bin/java.exe", 250_000, C({ OriginalFilename: "java.exe", FileDescription: "OpenJDK Platform binary" })],
      ["jre/bin/javaw.exe", 250_000, W({ OriginalFilename: "javaw.exe", FileDescription: "OpenJDK Platform binary" })],
      ["bin/launcher.exe", 250_000, W({ OriginalFilename: "javaw.exe", FileDescription: "Java(TM) Platform SE binary" })],
    ]);
    expect(r).toEqual({ launch: "FrontierOutpost.exe", candidates: ["FrontierOutpost.exe"], why: "its name is the game's" });
  });
  test("one that names the game beats a window program that names nothing; between two that name it, the window program", () => {
    expect(pick("Frontier Outpost", [["FrontierOutpost.exe", 600_000, C({ ProductName: "Frontier Outpost" })], ["Loader.exe", 3_000_000, W()]]))
      .toMatchObject({ launch: "FrontierOutpost.exe", why: "its name is the game's" });
    expect(pick("Cataclysm", [["cataclysm.exe", 30000000, C()], ["cataclysm-tiles.exe", 20000000, W()]]).launch).toBe("cataclysm-tiles.exe");
  });
});

describe("games whose name starts with Squirrel (review: '^squirrel' made them helpers)", () => {
  test("a Unity and an Unreal game named Squirrel… are taken; Squirrel's own Squirrel.exe never is", () => {
    expect(pick("Squirrel Stapler", [
      ["Squirrel Stapler.exe", 650000, W({ ProductName: "Squirrel Stapler", FileDescription: "Squirrel Stapler" })],
      ["Squirrel Stapler_Data/globalgamemanagers", 1000000], ["UnityPlayer.dll", 30000000, DLL], ["UnityCrashHandler64.exe", 1500000, W({ FileDescription: "Unity Crash Handler" })],
    ])).toMatchObject({ launch: "Squirrel Stapler.exe", candidates: ["Squirrel Stapler.exe"] });
    expect(pick("Squirrel with a Gun", [
      ["SquirrelWithAGun.exe", 300000, W({ OriginalFilename: "BootstrapPackagedGame-Win64-Shipping.exe", ProductName: "BootstrapPackagedGame" })],
      ["SquirrelWithAGun/Binaries/Win64/SquirrelWithAGun-Win64-Shipping.exe", 150000000, W({ ProductName: "Squirrel with a Gun" })],
    ]).launch).toBe("SquirrelWithAGun.exe");
    expect(pick("Neon Nights", [["Squirrel.exe", 1900000, W()], ["app/Neon.exe", 1000000, W()], ["app/resources/app.asar", 5000000]]).candidates).toEqual(["app/Neon.exe"]);
  });
  test("on disk, the Unity game imports", async () => {
    const v = await inspect(onDisk({ "Squirrel Stapler.exe": win(undefined, 600_000), "UnityPlayer.dll": peBytes({ dll: true, pad: 5_000_000 }), "Squirrel Stapler_Data/globalgamemanagers": blob(1000) }), { name: "Squirrel Stapler" });
    expect(v).toMatchObject({ ok: true, launch: "Squirrel Stapler.exe" });
  });
});

describe("the admin's picker judges helpers as the importer does (review: it dimmed the Unity player and not the anti-cheat)", () => {
  test("the engine's own program is no helper whatever its name; one known by its header, or in a crack folder, is", () => {
    const L = copyLayout(["CrashBandicootNSaneTrilogy.exe", "CrashBandicootNSaneTrilogy_Data/Managed/Assembly-CSharp.dll", "start_protected_game.exe", "Crack/tool.exe", "AutoRun.exe", "Squirrel Stapler.exe"]);
    expect(helperProgram("CrashBandicootNSaneTrilogy.exe", W(), L)).toBe(false);
    expect(NOT_LAUNCH_NAME.test("CrashBandicootNSaneTrilogy.exe")).toBe(true);                // the name alone would dim it
    expect(helperProgram("start_protected_game.exe", W({ FileDescription: "Easy Anti-Cheat Bootstrapper (EOS)" }), L)).toBe(true);
    expect(helperProgram("Crack/tool.exe", W(), L)).toBe(true);
    expect(helperProgram("AutoRun.exe", W({ FileDescription: "Autorun program" }), L)).toBe(true);
    expect(helperProgram("Squirrel Stapler.exe", W(), L)).toBe(false);
    expect(helperProgram("redist/vc_redist.x64.exe", undefined, L)).toBe(true);
  });
});

describe("an import job says why it took that program", () => {
  test("the job's log names the program and the reason, and the package starts with it (Look Outside, through the recipes)", async () => {
    const saved = { importers: rdeps.importers, exec: pdeps.exec, tools: pdeps.tools, log: pdeps.log };
    try {
      ensureDefaultRootFolder();
      rdeps.importers = () => [{ impl: "recipes", name: "Automatic recipes", importer: recipes.create({}, pluginContext("importers")) }];
      pdeps.exec = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
      pdeps.tools = () => ({ sevenZip: null, unar: null, unrar: null, innoextract: null, wine: null, xvfb: null, bash: null, dlgdrive: null });
      pdeps.log = () => {};
      const input = onDisk({
        "Game.exe": win(NWJS, 200_000), "nwjc.exe": con(undefined, 2_600_000), "chromedriver.exe": con(undefined, 1_800_000),
        "nw.dll": peBytes({ dll: true, pad: 5_000_000 }), "package.json": "{}", "index.html": "<html></html>",
      });
      const j = stmts.insertJob.get(null, null, null, input) as JobRow;
      await runJob(j.id);
      const done = stmts.jobById.get(j.id) as JobRow;
      expect(done.state).toBe("done");
      expect(done.transcript).toContain("launch Game.exe: the game's NW.js program (its header names it nw.exe)");
      expect(JSON.parse((stmts.packageForJob.get(j.id) as PackageRow).manifest_json).launch.exe).toBe("Game.exe");
    } finally {
      rdeps.importers = saved.importers; pdeps.exec = saved.exec; pdeps.tools = saved.tools; pdeps.log = saved.log;
    }
  });
});
