import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { classify, classifyPath, scan, snapshot } from "../src/process/classify";
import { inspect, buildManifest, unwrapRoot, prereqKind, slugify } from "../src/process/validate";
import { deterministic, partSignature } from "../src/process/recipes";
import { overlayCrack, winPath, installerKind, dialogInstallCommand, sceneOpts } from "../src/process/scene";
import { tenokePack } from "./tenoke-pack";
import { runAgent, agentModel, systemPrompt, priorLessons, AGENT_TOOLS, type CallModel, type ContentBlock, type TraceStep } from "../src/process/agent";
import { activityApi } from "../src/api/activity";
import { rdeps } from "../src/process/runner";
import { pluginContext } from "../src/plugins/registry";
import { recipes, agent } from "../src/plugins/builtin/importers";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { pdeps, runJob, processTick, activeJobs, scratchNeeded } from "../src/process/runner";
import { db, stmts, type JobRow, type PackageRow } from "../src/db";
import { events } from "../src/events";
import type { Exec, Toolbox } from "../src/process/tools";

const tmp = () => mkdtempSync(join(tmpdir(), "ahoy-proc-"));
const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill);
/** a plausible installed game: main exe, data, a crash handler, a redist installer */
function mkGame(dir: string, name = "Hades") {
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "_CommonRedist", "vcredist"), { recursive: true });
  writeFileSync(join(dir, `${name}.exe`), bytes(2_000_000, 1));
  writeFileSync(join(dir, "data", "level.pak"), bytes(5_000_000, 2));
  writeFileSync(join(dir, "UnityCrashHandler64.exe"), bytes(100_000));
  writeFileSync(join(dir, "_CommonRedist", "vcredist", "vc_redist.x64.exe"), bytes(50_000));
  writeFileSync(join(dir, "readme.txt"), "enjoy");
}
/** a RUNE-style scene disc: Inno Setup setup.exe + an unarc "ArC" payload + the group's crack folder (Unity / IL2CPP game) */
function sceneDisc(out: string, inno = true) {
  mkdirSync(join(out, "RUNE", "DaveTheDiver_Data", "Plugins", "x86_64"), { recursive: true });
  mkdirSync(join(out, "RUNE", "DaveTheDiver_Data", "il2cpp_data", "Metadata"), { recursive: true });
  writeFileSync(join(out, "autorun.inf"), "[autorun]\nopen=setup.exe");
  writeFileSync(join(out, "setup.exe"), Buffer.concat([Buffer.from(inno ? "MZ\0\0 This installation was built with Inno Setup. rDlPtS02" : "MZ\0\0 some other installer"), bytes(3_000_000)]));
  writeFileSync(join(out, "setup-1.bin"), Buffer.concat([Buffer.from("ArC\x01"), bytes(40_000_000, 3)]));
  writeFileSync(join(out, "RUNE", "DaveTheDiver.exe"), bytes(2_000_000, 7));
  writeFileSync(join(out, "RUNE", "DaveTheDiver.rne"), bytes(100_000, 7));
  writeFileSync(join(out, "RUNE", "RUNE.nfo"), "greets");
  writeFileSync(join(out, "RUNE", "DaveTheDiver_Data", "Plugins", "x86_64", "steam_api64.dll"), bytes(400_000, 8));
  writeFileSync(join(out, "RUNE", "DaveTheDiver_Data", "Plugins", "x86_64", "steam_api64.rne"), bytes(300_000, 8));
  writeFileSync(join(out, "RUNE", "DaveTheDiver_Data", "Plugins", "x86_64", "steam_emu.ini"), "[Settings]");
  writeFileSync(join(out, "RUNE", "DaveTheDiver_Data", "il2cpp_data", "Metadata", "global-metadata.dat"), bytes(2_000_000, 9));
}
/** a TENOKE disc: their own MFC dialog installer (no silent mode) + SETUP.bin + a flat Crack folder */
function tenokeDisc(out: string, opaque = false) {
  mkdirSync(join(out, "Crack", "DesktopExplorer_Data", "Plugins", "x86_64"), { recursive: true });
  writeFileSync(join(out, "autorun.inf"), "[autorun]\nopen=SETUP.exe");
  writeFileSync(join(out, "SETUP.exe"), Buffer.concat([Buffer.from("MZ\0\0 MFC app "), Buffer.from("TENOKE INSTALLER", "utf16le"), Buffer.from(" ... "), Buffer.from("INSTALL DIRECTORY", "utf16le"), bytes(4_000_000)]));
  // the real thing is their container (process/tenoke.ts); `opaque` stands for a build of the format we cannot read
  writeFileSync(join(out, "SETUP.bin"), opaque ? bytes(40_000_000, 3) : tenokePack({
    name: "Desktop Explorer", launch: "DesktopExplorer.exe", entries: [
      { name: "DesktopExplorer.exe", dir: "", data: bytes(2_000_000, 1), method: 1, key: 0x77 },
      { name: "UnityPlayer.dll", dir: "", data: bytes(3_000_000, 2), method: 2, key: 0x12, blockSize: 1_000_000 },
      { name: "", dir: "DesktopExplorer_Data/Plugins/x86_64/" },
      { name: "globalgamemanagers", dir: "DesktopExplorer_Data/", data: bytes(1_000_000, 4), method: 0 },
      { name: "steam_api64.dll", dir: "DesktopExplorer_Data/Plugins/x86_64/", data: bytes(400_000, 4), method: 0 },
    ],
  }));
  writeFileSync(join(out, "Crack", "DesktopExplorer_Data", "Plugins", "x86_64", "steam_api64.dll"), bytes(400_000, 8));
  writeFileSync(join(out, "Crack", "DesktopExplorer_Data", "Plugins", "x86_64", "steam_api64.ini"), "[Settings]");
}
/** what TENOKE's installer writes when dlgdrive presses INSTALL (the uninstaller box was cleared, but older builds write it anyway) */
function installedTenoke(dir: string) {
  mkdirSync(join(dir, "DesktopExplorer_Data", "Plugins", "x86_64"), { recursive: true });
  writeFileSync(join(dir, "DesktopExplorer.exe"), bytes(2_000_000, 1));
  writeFileSync(join(dir, "UnityPlayer.dll"), bytes(3_000_000, 2));
  writeFileSync(join(dir, "DesktopExplorer_Data", "globalgamemanagers"), bytes(1_000_000, 4));
  writeFileSync(join(dir, "DesktopExplorer_Data", "Plugins", "x86_64", "steam_api64.dll"), bytes(400_000, 4));
  writeFileSync(join(dir, "UNINSTALL.exe"), bytes(1_000));
}
/** what the installer writes: the real Unity game + Inno's uninstaller */
function installedUnity(dir: string) {
  mkdirSync(join(dir, "DaveTheDiver_Data", "Plugins", "x86_64"), { recursive: true });
  mkdirSync(join(dir, "DaveTheDiver_Data", "il2cpp_data", "Metadata"), { recursive: true });
  mkdirSync(join(dir, "_CommonRedist", "vcredist"), { recursive: true });
  writeFileSync(join(dir, "DaveTheDiver.exe"), bytes(2_000_000, 1));
  writeFileSync(join(dir, "UnityPlayer.dll"), bytes(3_000_000, 2));
  writeFileSync(join(dir, "GameAssembly.dll"), bytes(3_000_000, 3));
  writeFileSync(join(dir, "DaveTheDiver_Data", "globalgamemanagers"), bytes(1_000_000, 4));
  writeFileSync(join(dir, "DaveTheDiver_Data", "Plugins", "x86_64", "steam_api64.dll"), bytes(400_000, 4));
  writeFileSync(join(dir, "DaveTheDiver_Data", "il2cpp_data", "Metadata", "global-metadata.dat"), bytes(2_000_000, 5));
  writeFileSync(join(dir, "_CommonRedist", "vcredist", "VC_redist.x64.exe"), bytes(50_000));
  writeFileSync(join(dir, "unins000.exe"), bytes(1_000)); writeFileSync(join(dir, "unins000.dat"), bytes(1_000)); writeFileSync(join(dir, "uninst.dll"), bytes(1_000));
}
const noTools: Toolbox = { sevenZip: null, unar: null, unrar: null, innoextract: null, wine: null, xvfb: null, bash: null, dlgdrive: null };
const allTools: Toolbox = { sevenZip: "7z", unar: "unar", unrar: null, innoextract: "innoextract", wine: null, xvfb: null, bash: "bash", dlgdrive: null };

/** fake 7z / innoextract: "extracts" by materialising whatever the test registered for that archive name */
function fakeExec(layouts: Record<string, (out: string) => void>, calls: string[][] = []): Exec {
  return async cmd => {
    calls.push(cmd);
    if (cmd[0] === "7z" && cmd[1] === "l") {
      const known = !!layouts[basename(cmd[cmd.length - 1])];
      return { code: known ? 0 : 2, stdout: known ? "2026-01-01 00:00:00 ....A   1000   900  Game.exe" : "", stderr: known ? "" : "Cannot open the file as archive", timedOut: false };
    }
    if (cmd[0] === "7z" && cmd[1] === "x") {
      const out = cmd.find(a => a.startsWith("-o"))!.slice(2);
      const archive = basename(cmd[cmd.length - 1]);
      const lay = layouts[archive];
      if (!lay) return { code: 2, stdout: "", stderr: `cannot open ${archive}`, timedOut: false };
      mkdirSync(out, { recursive: true }); lay(out);
      return { code: 0, stdout: "Everything is Ok", stderr: "", timedOut: false };
    }
    if (cmd[0] === "unrar" && cmd[1] === "x") {                                   // unrar x -y -o+ -p- <archive> <dir>/
      const out = cmd[cmd.length - 1], archive = basename(cmd[cmd.length - 2]);
      const lay = layouts[archive];
      if (!lay) return { code: 10, stdout: "", stderr: `${archive} is not RAR archive`, timedOut: false };
      mkdirSync(out, { recursive: true }); lay(out);
      return { code: 0, stdout: "All OK", stderr: "", timedOut: false };
    }
    if (cmd[0] === "innoextract") {
      const out = cmd[cmd.indexOf("-d") + 1];
      const lay = layouts[basename(cmd[cmd.length - 1])];
      if (!lay) return { code: 1, stdout: "", stderr: "not an Inno Setup installer", timedOut: false };
      mkdirSync(join(out, "app"), { recursive: true }); mkdirSync(join(out, "tmp"), { recursive: true }); mkdirSync(join(out, "commonappdata", "GOG.com"), { recursive: true });
      writeFileSync(join(out, "tmp", "junk"), "x"); writeFileSync(join(out, "commonappdata", "GOG.com", "uninstall.dll"), "x");
      writeFileSync(join(out, "app", "goggame-1.ico"), "x"); writeFileSync(join(out, "app", "webcache.zip"), "x");
      lay(out);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { code: 127, stdout: "", stderr: `unknown ${cmd[0]}`, timedOut: false };
  };
}

describe("classify", () => {
  test("installed-looking folder", async () => {
    const d = tmp(); mkGame(d);
    const c = await classifyPath(d);
    expect(c.shape).toBe("folder");
    expect(c.exes).toContain("Hades.exe");
  });
  test("multi-part rar: only the first volume counts", async () => {
    const d = tmp();
    for (const n of ["Game.rar", "Game.r00", "Game.r01", "game.nfo"]) writeFileSync(join(d, n), "x");
    const c = await classifyPath(d);
    expect(c.shape).toBe("archive");
    expect(c.archives).toEqual(["Game.rar"]);
    expect(c.nfos).toEqual(["game.nfo"]);
    const d2 = tmp();
    for (const n of ["x.part1.rar", "x.part2.rar", "x.part10.rar", "y.7z.001", "y.7z.002"]) writeFileSync(join(d2, n), "x");
    expect((await classifyPath(d2)).archives.sort()).toEqual(["x.part1.rar", "y.7z.001"]);
  });
  test("disc images: iso, bin+cue, but not a lone .bin", () => {
    expect(classify("/r", true, [{ rel: "game.iso", size: 1, ext: ".iso" }]).shape).toBe("iso");
    // beside programs of its own, a copy is a disc image only while the game could still be inside one
    const installed = [{ rel: "MGS4/mgs4.exe", size: 30e6, ext: ".exe" }, { rel: "MGS4/data.dat", size: 24e9, ext: ".dat" }, { rel: "MGS1/mgs4mgs1_us.img", size: 3e6, ext: ".img" }];
    expect(classify("/r", true, installed).shape).toBe("folder");
    expect(classify("/r", true, [{ rel: "Crack/Game.exe", size: 5e6, ext: ".exe" }, { rel: "game.iso", size: 4e9, ext: ".iso" }])).toMatchObject({ shape: "iso", isos: ["game.iso"] });
    expect(classify("/r", true, [...installed, { rel: "update.iso", size: 2e8, ext: ".iso" }])).toMatchObject({ shape: "iso", isos: ["update.iso"] });
    expect(classify("/r", true, [{ rel: "gta3.exe", size: 2e6, ext: ".exe" }, { rel: "models/gta3.img", size: 6e8, ext: ".img" }], [], { notImages: new Set(["models/gta3.img"]) }).shape).toBe("folder");
    const bc = classify("/r", true, [{ rel: "disc.bin", size: 1, ext: ".bin" }, { rel: "disc.cue", size: 1, ext: ".cue" }]);
    expect(bc.shape).toBe("iso"); expect(bc.isos).toEqual(["disc.bin"]);
    expect(classify("/r", true, [{ rel: "data.bin", size: 1, ext: ".bin" }]).shape).toBe("unknown");
  });
  test("a small zip beside a game's exe is data, a rar set that is the release is an archive", () => {
    const withZip = classify("/r", true, [{ rel: "Game.exe", size: 50e6, ext: ".exe" }, { rel: "webcache.zip", size: 2e5, ext: ".zip" }, { rel: "data/a.pak", size: 900e6, ext: ".pak" }]);
    expect(withZip.shape).toBe("folder");
    const scene = classify("/r", true, [{ rel: "g.rar", size: 500e6, ext: ".rar" }, { rel: "g.r00", size: 500e6, ext: ".r00" }, { rel: "Crack/Game.exe", size: 5e6, ext: ".exe" }]);
    expect(scene.shape).toBe("archive");
  });
  test("GOG installer, lone installer, empty", () => {
    const gog = classify("/r", true, [{ rel: "setup_hades_1.0.exe", size: 1e6, ext: ".exe" }, { rel: "setup_hades_1.0-1.bin", size: 4e9, ext: ".bin" }]);
    expect(gog.shape).toBe("gog-installer"); expect(gog.installers).toEqual(["setup_hades_1.0.exe"]);
    expect(classify("/f/setup_hollow_knight_1.5.exe", false, [{ rel: "setup_hollow_knight_1.5.exe", size: 1.2e9, ext: ".exe" }]).shape).toBe("gog-installer");
    expect(classify("/r", true, [{ rel: "setup.exe", size: 1e6, ext: ".exe" }, { rel: "data1.bin", size: 4e9, ext: ".bin" }]).shape).toBe("installer");
    expect(classify("/r", true, []).shape).toBe("empty");
  });
});

describe("snapshot (the job fingerprint)", () => {
  test("layout, heaviest extensions, first bytes of the biggest files, un-run installer", async () => {
    const disc = tmp(); sceneDisc(disc);
    const s = (await snapshot(disc))!;
    expect(s.files).toBe(10);
    expect(s.layout[0]).toBe("setup-1.bin (40.0 MB)");
    expect(s.layout.some(l => l.startsWith("RUNE/DaveTheDiver_Data/ (4 files"))).toBe(true);
    expect(s.byExt[0]).toMatchObject({ ext: ".bin", files: 1 });
    expect(s.largest[0].rel).toBe("setup-1.bin"); expect(s.largest[0].magic.startsWith("ArC")).toBe(true); expect(s.largest[0].magic).toContain("x01");
    expect(s.largest.find(f => f.rel === "setup.exe")!.magic.startsWith("MZ")).toBe(true);
    expect(s.unrunInstaller).toContain("setup.exe + 1 part(s)");
    const one = join(tmp(), "Game.iso"); writeFileSync(one, Buffer.concat([bytes(0x8001), Buffer.from("CD001"), bytes(100)]));
    expect((await snapshot(one))!).toMatchObject({ files: 1, shape: "iso", largest: [{ rel: "Game.iso", magic: expect.stringContaining("(ISO 9660)") }] });
    expect(await snapshot(join(tmp(), "missing"))).toBeNull();
  });
});

describe("validate", () => {
  test("a real game folder passes: launch exe picked, crash handler ignored, redist listed", async () => {
    const d = tmp(); mkGame(d);
    const v = await inspect(d, { name: "Hades" });
    expect(v.ok).toBe(true);
    expect(v.launch).toBe("Hades.exe");
    expect(v.exeCandidates).toEqual(["Hades.exe"]);
    expect(v.prerequisites).toEqual([{ kind: "vcredist", path: "_CommonRedist/vcredist/vc_redist.x64.exe", args: "/quiet /norestart" }]);
  });
  test("single-folder nesting is unwrapped; launch hint wins; name similarity beats size", async () => {
    const d = tmp(); mkdirSync(join(d, "Hollow Knight")); mkGame(join(d, "Hollow Knight"), "hollow_knight");
    writeFileSync(join(d, "Hollow Knight", "BigTool.exe"), bytes(9_000_000));
    expect(await unwrapRoot(d)).toBe(join(d, "Hollow Knight"));
    const v = await inspect(d, { name: "Hollow Knight" });
    expect(v.root).toBe(join(d, "Hollow Knight"));
    expect(v.launch).toBe("hollow_knight.exe");
    expect((await inspect(d, { name: "Hollow Knight", launchExe: "BigTool.exe" })).launch).toBe("BigTool.exe");
  });
  test("a small disc image inside an installed game is the game's own data; one the game could still be inside is a leftover", async () => {
    const mk = (root: string, rel: string, data: Uint8Array | string) => { mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(root, ...rel.split("/")), data); };
    /** raw CD sectors, as a disc image starts */
    const disc = (n: number) => { const b = bytes(n, 3); b.set([0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]); return b; };
    // METAL GEAR SOLID 4 - Master Collection as its installer leaves it: the PlayStation game as six .img files for the
    // emulator it ships (both downloads were installed, cracked and refused for them, 2026-11-11)
    const d = tmp();
    mk(d, "Launcher/launcher.exe", bytes(900_000, 1)); mk(d, "Launcher/UnityPlayer.dll", bytes(3_000_000)); mk(d, "Launcher/launcher_Data/globalgamemanagers", bytes(1000));
    mk(d, "MGS1/mgs1.exe", bytes(2_000_000, 1)); mk(d, "MGS4/mgs4.exe", bytes(12_000_000, 1)); mk(d, "MGS4/common/stage.dat", bytes(15_000_000, 2));
    for (const l of ["us", "jp", "fr", "gr", "it", "sp"]) mk(d, `MGS1/mgs4mgs1_${l}.img`, disc(1_100_000));
    const v = await inspect(d, { name: "METAL GEAR SOLID 4: Guns of the Patriots - Master Collection Version" });
    expect(v.problems).toEqual([]);
    expect(v.launch).toBe("Launcher/launcher.exe");
    expect((await classifyPath(d)).shape).toBe("folder");                 // and no recipe unpacks them
    // the same kind of file holding most of the copy: the game is still inside it
    const e = tmp(); mk(e, "Crack/Game.exe", bytes(2_000_000, 1)); mk(e, "disc/game.img", disc(6_000_000));
    expect((await inspect(e, { name: "Game" })).problems[0]).toBe("archives / disc images still inside: disc/game.img");
    expect((await classifyPath(e))).toMatchObject({ shape: "iso", isos: ["disc/game.img"] });
    // an image by its name, small and deep in the game: data (a soundtrack disc); with one that holds most of the copy
    // beside it, the images are leftovers (the top of the copy and 100 MB alone: the classify test above)
    const f = tmp(); mkGame(f); mk(f, "extras/soundtrack.iso", bytes(1_000_000, 5));
    expect((await inspect(f, { name: "Hades" })).ok).toBe(true);
    writeFileSync(join(f, "update.iso"), ""); truncateSync(join(f, "update.iso"), 100_000_000);
    expect((await inspect(f, { name: "Hades" })).problems[0]).toBe("archives / disc images still inside: extras/soundtrack.iso, update.iso");
    expect((await classifyPath(f)).shape).toBe("iso");
    // a .img that is no disc image at all (Grand Theft Auto's models archive), however much of the game it is
    const g = tmp(); mk(g, "gta3.exe", bytes(2_300_000, 1)); mk(g, "models/gta3.img", bytes(8_000_000, 7)); mk(g, "audio/sfx.raw", bytes(3_000_000, 2));
    expect((await inspect(g, { name: "Grand Theft Auto III" })).problems).toEqual([]);
    expect((await classifyPath(g)).shape).toBe("folder");
    // an archive is a leftover wherever it is and however small
    mk(d, "MGS4/patch.rar", "x");
    expect((await inspect(d, { name: "METAL GEAR SOLID 4" })).problems[0]).toBe("archives / disc images still inside: MGS4/patch.rar");
  });
  test("a small root zip is tolerated, a big one is a leftover", async () => {
    const d = tmp(); mkGame(d); writeFileSync(join(d, "webcache.zip"), bytes(1000));
    expect((await inspect(d, { name: "Hades" })).ok).toBe(true);
    writeFileSync(join(d, "update.zip"), bytes(6_000_000));
    expect((await inspect(d, { name: "Hades" })).problems[0]).toMatch(/update.zip/);
  });
  test("problems: leftovers, no exe, installer-only, tiny", async () => {
    const d = tmp(); mkGame(d); writeFileSync(join(d, "data", "more.rar"), "x");
    expect((await inspect(d, { name: "Hades" })).problems[0]).toMatch(/still inside: data\/more.rar/);
    const e = tmp(); writeFileSync(join(e, "setup.exe"), bytes(6_000_000)); writeFileSync(join(e, "data1.bin"), bytes(1_000_000));
    const ve = await inspect(e, { name: "X" });
    expect(ve.ok).toBe(false); expect(ve.problems.join()).toMatch(/installer-like/);
    const f = tmp(); writeFileSync(join(f, "a.txt"), "x");
    const vf = await inspect(f, { name: "X" });
    expect(vf.problems).toEqual(expect.arrayContaining([expect.stringMatching(/no executable/), expect.stringMatching(/small/)]));
  });
  test("a scene disc that was never installed is refused: the payload holds the bytes, the crack's Unity exe has no runtime", async () => {
    const d = tmp(); sceneDisc(d);
    const v = await inspect(d, { name: "DAVE THE DIVER" });
    expect(v.ok).toBe(false);
    expect(v.launch).toBeNull();                                        // never the crack folder's program (the old validator shipped RUNE/DaveTheDiver.exe)
    expect(v.problems.join("\n")).toMatch(/still inside its installer: setup\.exe \+ setup-1\.bin/);
    // the crack folder on its own is not a game either
    const crack = await inspect(join(d, "RUNE"), { name: "DAVE THE DIVER" });
    expect(crack.ok).toBe(false); expect(crack.problems.join()).toMatch(/no Unity runtime/);
    // the installed game passes; a config setup.exe beside a game's own big data file does not trip the installer rule
    const g = tmp(); installedUnity(g);
    expect((await inspect(g, { name: "DAVE THE DIVER" })).launch).toBe("DaveTheDiver.exe");
    expect((await inspect(g, { name: "DAVE THE DIVER" })).ok).toBe(true);
    const old = tmp(); writeFileSync(join(old, "Game.exe"), bytes(3_000_000)); writeFileSync(join(old, "Setup.exe"), bytes(500_000)); writeFileSync(join(old, "LINKDATA.BIN"), bytes(20_000_000));
    expect((await inspect(old, { name: "Game" })).ok).toBe(true);
  });
  test("manifest: every file hashed, launch cwd, prerequisites, totals", async () => {
    const d = tmp(); mkGame(d);
    const v = await inspect(d, { name: "Hades" });
    const m = await buildManifest(v, { name: "Hades", version: "1.38", source: null, tier: "deterministic" });
    expect(m.files.map(f => f.path)).toEqual(["Hades.exe", "UnityCrashHandler64.exe", "_CommonRedist/vcredist/vc_redist.x64.exe", "data/level.pak", "readme.txt"]);
    expect(m.files[0].sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes(2_000_000, 1)).digest("hex"));
    expect(m.totalSize).toBe(2_000_000 + 5_000_000 + 100_000 + 50_000 + 5);
    expect(m.launch).toEqual({ exe: "Hades.exe", args: "", cwd: "" });
    expect(m.slug).toBe("hades"); expect(m.version).toBe("1.38");
    expect(prereqKind("dxwebsetup.exe")?.kind).toBe("directx");
    expect(prereqKind("thing.msi")?.kind).toBe("msi");
    expect(slugify("Marvel's Spider-Man: Remastered!")).toBe("marvels-spider-man-remastered");
  });
});

describe("agent model naming", () => {
  test("stock default is translated for OpenRouter, explicit names pass through", () => {
    expect(agentModel("", "https://api.anthropic.com")).toBe("claude-opus-5-5");
    expect(agentModel("", "https://openrouter.ai/api")).toBe("anthropic/claude-opus-5.5");
    expect(agentModel("anthropic/claude-sonnet-5.5", "https://openrouter.ai/api")).toBe("anthropic/claude-sonnet-5.5");
    expect(agentModel("claude-sonnet-5-5", "https://api.anthropic.com")).toBe("claude-sonnet-5-5");
  });
});

describe("deterministic recipes", () => {
  test("installer whose .bin parts are plain archives → extracted, installer dropped; unreadable parts → not ours", async () => {
    const input = tmp();
    const zipped = (n: number, seed = 1) => Buffer.concat([Buffer.from("7z\xbc\xaf\x27\x1c", "latin1"), bytes(n, seed)]);   // a 7z signature: worth asking 7z
    writeFileSync(join(input, "setup.exe"), bytes(3_000_000)); writeFileSync(join(input, "data1.bin"), zipped(2_000_000)); writeFileSync(join(input, "data2.bin"), zipped(2_000_000, 2)); writeFileSync(join(input, "group.nfo"), "n");
    const calls: string[][] = [];
    const exec = fakeExec({
      "data1.bin": out => mkGame(out, "Game"),
      "data2.bin": out => { mkdirSync(join(out, "data"), { recursive: true }); writeFileSync(join(out, "data", "more.pak"), bytes(10)); },
      "Game.iso": out => { writeFileSync(join(out, "setup.exe"), bytes(3_000_000)); writeFileSync(join(out, "data1.bin"), zipped(2_000_000)); writeFileSync(join(out, "rune.nfo"), "n"); },
    }, calls);
    const staging = join(tmp(), "staging");
    const r = await deterministic(input, staging, { exec, tools: allTools, log: () => {} }, { name: "Game" });
    expect(r.ok).toBe(true); expect(r.validation?.launch).toBe("Game.exe");
    expect(existsSync(join(staging, "data", "more.pak"))).toBe(true);
    expect(calls.filter(c => c[1] === "l").length).toBe(2);
    // the same thing inside a disc image: image → installer + part → part extracted, setup.exe removed
    const input2 = tmp(); writeFileSync(join(input2, "Game.iso"), bytes(10));
    const staging2 = join(tmp(), "staging");
    const r2 = await deterministic(input2, staging2, { exec, tools: allTools, log: () => {} }, { name: "Game" });
    expect(r2.ok).toBe(true); expect(r2.validation?.launch).toBe("Game.exe");
    expect(existsSync(join(staging2, "setup.exe"))).toBe(false); expect(existsSync(join(staging2, "data1.bin"))).toBe(false);
    // parts 7z cannot read → the installer has to be run → the agent's problem
    const input3 = tmp(); writeFileSync(join(input3, "setup.exe"), bytes(3_000_000)); writeFileSync(join(input3, "rune-1.bin"), bytes(2_000_000));
    const r3 = await deterministic(input3, join(tmp(), "staging"), { exec: fakeExec({}), tools: allTools, log: () => {} }, { name: "Game" });
    expect(r3.ok).toBe(false); expect(r3.reason).toMatch(/only an installer/);
    // a part with a signature 7z turns down: still asked, still not ours
    const input4 = tmp(); writeFileSync(join(input4, "setup.exe"), bytes(3_000_000)); writeFileSync(join(input4, "data1.bin"), zipped(2_000_000, 9));
    const calls4: string[][] = [];
    const r4 = await deterministic(input4, join(tmp(), "staging"), { exec: fakeExec({}, calls4), tools: allTools, log: () => {} }, { name: "Game" });
    expect(r4.ok).toBe(false); expect(calls4.some(c => c[1] === "l")).toBe(true);
  });

  test("a payload's first bytes say whether 7z is even asked: FreeArc and TENOKE never, signatures 7z knows yes, anything else no", async () => {
    const d = tmp();
    writeFileSync(join(d, "arc.bin"), Buffer.concat([Buffer.from("ArC\x01"), bytes(1000)]));
    writeFileSync(join(d, "tenoke.bin"), Buffer.concat([Buffer.from([0xc5, 0xd3, 0xd0, 0xd0]), bytes(1000)]));
    writeFileSync(join(d, "zip.bin"), Buffer.concat([Buffer.from("PK\x03\x04"), bytes(1000)]));
    writeFileSync(join(d, "rar.bin"), Buffer.concat([Buffer.from("Rar!\x1a\x07\x00", "latin1"), bytes(1000)]));
    writeFileSync(join(d, "cab.bin"), Buffer.concat([Buffer.from("MSCF"), bytes(1000)]));
    writeFileSync(join(d, "noise.bin"), bytes(1000, 5));
    writeFileSync(join(d, "tiny.bin"), Buffer.from("ab"));
    expect(await partSignature(join(d, "arc.bin"))).toBe("freearc");
    expect(await partSignature(join(d, "tenoke.bin"))).toBe("tenoke");
    for (const n of ["zip.bin", "rar.bin", "cab.bin"]) expect(await partSignature(join(d, n))).toBe("archive");
    expect(await partSignature(join(d, "noise.bin"))).toBe("unknown");
    expect(await partSignature(join(d, "tiny.bin"))).toBe("unknown");
    expect(await partSignature(join(d, "missing.bin"))).toBe("unknown");
    // the scene ISO's setup-1.bin: FreeArc → the recipe says so and never starts a 7z scan of it
    const input = tmp(); writeFileSync(join(input, "dave.iso"), "x");
    const calls: string[][] = [];
    const steps: string[] = [];
    const r = await deterministic(input, join(tmp(), "staging"), { exec: fakeExec({ "dave.iso": out => sceneDisc(out) }, calls), tools: allTools, log: s => steps.push(s) }, { name: "DAVE THE DIVER", group: "RUNE" });
    expect(r.ok).toBe(false);
    expect(steps.join("\n")).toMatch(/setup-1\.bin is a FreeArc payload \(unarc\) — only the installer can unpack it/);
    expect(calls.some(c => c[1] === "l" && basename(c[c.length - 1]) === "setup-1.bin")).toBe(false);
  });

  test("scene ISO (Inno Setup + unarc payload + RUNE crack) → installed under wine, crack laid over, leftovers dropped", async () => {
    const input = tmp(); writeFileSync(join(input, "dave.iso"), "x");
    const staging = join(tmp(), "staging");
    const calls: string[][] = [];
    const wine: { cmd: string[]; env?: Record<string, string> }[] = [];
    const base = fakeExec({ "dave.iso": out => sceneDisc(out) }, calls);
    const exec: Exec = async (cmd, opts) => {
      if (cmd[0] === "xvfb-run") { wine.push({ cmd, env: opts?.env }); installedUnity(staging); return { code: 0, stdout: "", stderr: "", timedOut: false }; }
      return base(cmd, opts);
    };
    const steps: string[] = [];
    const tools = { ...allTools, wine: "wine", xvfb: "xvfb-run" };
    const r = await deterministic(input, staging, { exec, tools, log: s => steps.push(s) }, { name: "DAVE THE DIVER", group: "RUNE" });
    expect(r.ok).toBe(true);
    expect(r.validation?.launch).toBe("DaveTheDiver.exe");
    expect(calls.some(c => c[1] === "l" && basename(c[c.length - 1]) === "setup-1.bin")).toBe(false);       // "ArC": 7z is not asked
    expect(wine.length).toBe(1);
    expect(wine[0].cmd.slice(0, 3)).toEqual(["xvfb-run", "-a", "wine"]);
    expect(basename(wine[0].cmd[3])).toBe("setup.exe");
    expect(wine[0].cmd).toEqual(expect.arrayContaining(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", `/DIR=${winPath(staging)}`, `/LOG=${winPath(join(dirname(staging), "inno.log"))}`]));
    expect(existsSync(join(dirname(staging), "inno.log"))).toBe(false);                                    // gone with the install
    expect(wine[0].env?.WINEPREFIX).toBe(join(dirname(staging), "wine"));
    expect(winPath("/library/.work/job-8/staging")).toBe("Z:\\library\\.work\\job-8\\staging");
    // the crack replaced the store exe and DRM dll, its extra files sit beside them, the nfo stayed out
    expect(readFileSync(join(staging, "DaveTheDiver.exe"))[0]).toBe(7);
    expect(readFileSync(join(staging, "DaveTheDiver_Data", "Plugins", "x86_64", "steam_api64.dll"))[0]).toBe(8);
    expect(existsSync(join(staging, "DaveTheDiver_Data", "Plugins", "x86_64", "steam_emu.ini"))).toBe(true);
    expect(existsSync(join(staging, "DaveTheDiver_Data", "Plugins", "x86_64", "steam_api64.rne"))).toBe(true);
    expect(existsSync(join(staging, "DaveTheDiver.rne"))).toBe(true);
    expect(existsSync(join(staging, "RUNE.nfo"))).toBe(false);
    // nothing of the disc or the installer is left in the package
    for (const n of ["setup.exe", "setup-1.bin", "autorun.inf", "RUNE", "unins000.exe", "unins000.dat", "uninst.dll"]) expect(existsSync(join(staging, n))).toBe(false);
    expect(existsSync(join(dirname(staging), "disc"))).toBe(false);
    expect(steps.join("\n")).toMatch(/only the installer can read[\s\S]*applied RUNE: \d+ file/);
  });
  test("an installer that lingers after finishing: Inno's log is the finish line (and the sign of life), the tree is not walked", async () => {
    const saved = { ...sceneOpts };
    Object.assign(sceneOpts, { pollMs: 25, settleMs: 80, stallMs: 5_000 });
    try {
      const input = tmp(); writeFileSync(join(input, "dave.iso"), "x");
      const staging = join(tmp(), "staging");
      const base = fakeExec({ "dave.iso": out => sceneDisc(out) });
      let logArg = "";
      const exec: Exec = async (cmd, opts) => {
        if (cmd[0] !== "xvfb-run") return base(cmd, opts);
        logArg = cmd.find(a => a.startsWith("/LOG="))!.slice(5);
        const logPath = logArg.replace(/^Z:/, "").replace(/\\/g, "/");
        installedUnity(staging);
        for (let i = 1; i <= 3; i++) { await new Promise(r => setTimeout(r, 30)); writeFileSync(logPath, `-- File entry --\nDest filename: C:\\g\\${i}.bin\n`, { flag: "a" }); }
        await new Promise(r => setTimeout(r, 30));
        writeFileSync(logPath, "Installation process succeeded.\nNeed to restart Windows? No\n", { flag: "a" });
        await new Promise<void>(r => opts?.signal?.addEventListener("abort", () => r(), { once: true }));   // sits on its final page until told
        return { code: -1, stdout: "", stderr: "", timedOut: false };
      };
      const steps: string[] = [];
      const progress: string[] = [];
      const t0 = Date.now();
      const r = await deterministic(input, staging, { exec, tools: { ...allTools, wine: "wine", xvfb: "xvfb-run" }, log: s => steps.push(s), progress: (_p: number, m: string) => progress.push(m) }, { name: "DAVE THE DIVER", group: "RUNE" });
      expect(r.ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(logArg).toMatch(/inno\.log$/);
      expect(steps.join("\n")).toMatch(/the installer has finished \(3 files\) but is still running — stopping it/);
      expect(progress.some(m => /installing the game — 3 files written/.test(m))).toBe(true);
      expect(existsSync(join(dirname(staging), "inno.log"))).toBe(false);
      // no log at all (an installer that ignores /LOG): the tree is watched — uninstall data written, nothing growing → stopped
      const input2 = tmp(); writeFileSync(join(input2, "dave.iso"), "x");
      const staging2 = join(tmp(), "staging");
      const exec2: Exec = async (cmd, opts) => {
        if (cmd[0] !== "xvfb-run") return base(cmd, opts);
        installedUnity(staging2);
        await new Promise<void>(r => opts?.signal?.addEventListener("abort", () => r(), { once: true }));
        return { code: -1, stdout: "", stderr: "", timedOut: false };
      };
      const steps2: string[] = [];
      const r2 = await deterministic(input2, staging2, { exec: exec2, tools: { ...allTools, wine: "wine", xvfb: "xvfb-run" }, log: s => steps2.push(s) }, { name: "DAVE THE DIVER", group: "RUNE" });
      expect(r2.ok).toBe(true);
      expect(steps2.join("\n")).toMatch(/the installer has finished \(0\.\d\d GB\) but is still running — stopping it/);
      // a scene build: its log lists no files and never says "succeeded", no uninstall data either (CODEX) — the tree holds
      // as much as the payload and stops growing → stopped after a short settle, not after the ten-minute stall rule
      const input3 = tmp(); writeFileSync(join(input3, "dave.iso"), "x");
      const staging3 = join(tmp(), "staging");
      const exec3: Exec = async (cmd, opts) => {
        if (cmd[0] !== "xvfb-run") return base(cmd, opts);
        const logPath = cmd.find(a => a.startsWith("/LOG="))!.slice(5).replace(/^Z:/, "").replace(/\\/g, "/");
        writeFileSync(logPath, "2026-11-05 10:44:14.134   Windows version: 6.2.9200\n2026-11-05 10:44:14.464   0.527777791023\n");
        mkdirSync(join(staging3, "Game"), { recursive: true });
        writeFileSync(join(staging3, "Game", "DarkSoulsIII.exe"), bytes(2_000_000, 1));
        writeFileSync(join(staging3, "Game", "Data0.bdt"), bytes(40_000_000, 2));                 // ≈ the 43 MB payload (setup.exe + setup-1.bin): stored, not compressed
        await new Promise<void>(r => opts?.signal?.addEventListener("abort", () => r(), { once: true }));
        return { code: -1, stdout: "", stderr: "", timedOut: false };
      };
      const steps3: string[] = [];
      const t3 = Date.now();
      const r3 = await deterministic(input3, staging3, { exec: exec3, tools: { ...allTools, wine: "wine", xvfb: "xvfb-run" }, log: s => steps3.push(s) }, { name: "DAVE THE DIVER", group: "RUNE" });
      expect(r3.ok).toBe(true);
      expect(Date.now() - t3).toBeLessThan(4_000);
      expect(steps3.join("\n")).toMatch(/the installer holds as much as the payload \(0\.0\d GB\) and has written nothing for \d+ s \(0\.04 GB\) but is still running — stopping it/);
    } finally { Object.assign(sceneOpts, saved); }
  });

  test("the same disc without wine, or with an installer that is not Inno Setup: refused, disc left in staging for the agent", async () => {
    const input = tmp(); writeFileSync(join(input, "dave.iso"), "x");
    const staging = join(tmp(), "staging");
    const r = await deterministic(input, staging, { exec: fakeExec({ "dave.iso": out => sceneDisc(out) }), tools: allTools, log: () => {} }, { name: "DAVE THE DIVER", group: "RUNE" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/still inside its installer/);
    expect(existsSync(join(staging, "setup-1.bin"))).toBe(true);
    const staging2 = join(tmp(), "staging");
    let ran = false;
    const base = fakeExec({ "dave.iso": out => sceneDisc(out, false) });
    const exec: Exec = async (cmd, opts) => { if (cmd[0] === "xvfb-run") ran = true; return base(cmd, opts); };
    const steps: string[] = [];
    const r2 = await deterministic(input, staging2, { exec, tools: { ...allTools, wine: "wine", xvfb: "xvfb-run" }, log: s => steps.push(s) }, { name: "DAVE THE DIVER" });
    expect(r2.ok).toBe(false); expect(ran).toBe(false);
    expect(steps.join("\n")).toMatch(/not an Inno Setup installer/);
    expect(existsSync(join(staging2, "setup.exe"))).toBe(true);
  });
  test("a TENOKE disc: SETUP.bin is their container — unpacked straight into staging, no wine, crack laid over, UNINSTALL.exe never written", async () => {
    const input = tmp();
    const wine: { cmd: string[]; env?: Record<string, string> }[] = [];
    const base = fakeExec({ "de.iso": out => tenokeDisc(out) });
    const exec: Exec = async (cmd, opts) => {
      if (cmd[0] === "xvfb-run") { wine.push({ cmd, env: opts?.env }); return { code: 1, stdout: "", stderr: "must not run", timedOut: false }; }
      return base(cmd, opts);
    };
    writeFileSync(join(input, "de.iso"), "x");
    const steps: string[] = [];
    const staging = join(tmp(), "staging");
    const r = await deterministic(input, staging, { exec, tools: { ...allTools }, log: s => steps.push(s) }, { name: "Desktop Explorer", group: "TENOKE" });   // wine, xvfb, dlgdrive all missing: fine
    expect(r.ok).toBe(true);
    expect(wine.length).toBe(0);
    expect(steps.join("\n")).toMatch(/SETUP\.bin is a TENOKE package \(Desktop Explorer, launches DesktopExplorer\.exe\)[\s\S]*unpacked: 4 files[\s\S]*applied Crack: \d+ file/);
    expect(steps.join("\n")).not.toMatch(/dlgdrive|under wine/);
    const files = (await scan(staging)).files.map(f => f.rel).sort();
    expect(files).toEqual(["DesktopExplorer.exe", "DesktopExplorer_Data/Plugins/x86_64/steam_api64.dll", "DesktopExplorer_Data/Plugins/x86_64/steam_api64.ini", "DesktopExplorer_Data/globalgamemanagers", "UnityPlayer.dll"]);
    expect(readFileSync(join(staging, "UnityPlayer.dll")).equals(bytes(3_000_000, 2))).toBe(true);
    expect(readFileSync(join(staging, "DesktopExplorer_Data", "Plugins", "x86_64", "steam_api64.dll")).equals(bytes(400_000, 8))).toBe(true);   // the crack's copy
    expect(existsSync(join(dirname(staging), "disc"))).toBe(false);                   // the disc copy is cleared with the rest of the work dir
  });
  test("a TENOKE disc whose SETUP.bin we cannot read (another build of the format): dlgdrive drives the installer on its display, crack laid over, UNINSTALL.exe dropped", async () => {
    const input = tmp(); writeFileSync(join(input, "de.iso"), "x");
    const staging = join(tmp(), "staging");
    const wine: { cmd: string[]; env?: Record<string, string> }[] = [];
    const base = fakeExec({ "de.iso": out => tenokeDisc(out, true) });
    const exec: Exec = async (cmd, opts) => {
      if (cmd[0] === "xvfb-run") { wine.push({ cmd, env: opts?.env }); installedTenoke(staging); return { code: 0, stdout: "dialog 'TENOKE INSTALLER' with 4 buttons\ndirectory box set\nunchecked 'CREATE DESKTOP SHORTCUT'\npressed 'INSTALL'\n100.0%\nthe installer reports 100%", stderr: "", timedOut: false }; }
      return base(cmd, opts);
    };
    const steps: string[] = [];
    const tools = { ...allTools, wine: "wine", xvfb: "xvfb-run", dlgdrive: "/usr/local/bin/dlgdrive.exe" };
    const r = await deterministic(input, staging, { exec, tools, log: s => steps.push(s) }, { name: "Desktop Explorer", group: "TENOKE" });
    expect(r.ok).toBe(true);
    expect(r.validation?.launch).toBe("DesktopExplorer.exe");
    expect(wine.length).toBe(1);
    const c = wine[0].cmd;
    expect(c[0]).toBe("xvfb-run");
    expect(c).toContain("bash");
    const script = c[c.indexOf("-c") + 1];
    expect(script).toMatch(/"\$WINE_BIN" "\$2"[^\n]*&/);                       // the installer in the background …
    expect(script).toMatch(/"\$DLGDRIVE" --dir "\$3" --button INSTALL/);          // … dlgdrive at the controls on the same display
    expect(script).toMatch(/"\$WINESERVER_BIN" -k/);                                // … and the prefix torn down when it is done
    expect(script.indexOf("wineboot --init")).toBeLessThan(script.indexOf('"$2"'));  // the prefix exists before two wines start in it
    expect(c.slice(-4)).toEqual([expect.stringMatching(/disc$/), "SETUP.exe", winPath(staging), expect.stringMatching(/^\d+$/)]);
    expect(c).toContain("WINE_BIN=wine"); expect(c).toContain("DLGDRIVE=/usr/local/bin/dlgdrive.exe");
    expect(wine[0].env?.WINEPREFIX).toBe(join(dirname(staging), "wine"));
    expect(readFileSync(join(staging, "DesktopExplorer_Data", "Plugins", "x86_64", "steam_api64.dll"))[0]).toBe(8);
    expect(existsSync(join(staging, "DesktopExplorer_Data", "Plugins", "x86_64", "steam_api64.ini"))).toBe(true);
    for (const n of ["SETUP.exe", "SETUP.bin", "autorun.inf", "Crack", "UNINSTALL.exe"]) expect(existsSync(join(staging, n))).toBe(false);
    expect(steps.join("\n")).toMatch(/dlgdrive at the controls[\s\S]*dlgdrive: the installer reports 100%[\s\S]*applied Crack: \d+ file/);
  });
  test("the same unreadable TENOKE disc without dlgdrive: refused with the reason, disc left for the agent", async () => {
    const input = tmp(); writeFileSync(join(input, "de.iso"), "x");
    const staging = join(tmp(), "staging");
    let ran = false;
    const base = fakeExec({ "de.iso": out => tenokeDisc(out, true) });
    const exec: Exec = async (cmd, opts) => { if (cmd[0] === "xvfb-run") ran = true; return base(cmd, opts); };
    const steps: string[] = [];
    const r = await deterministic(input, staging, { exec, tools: { ...allTools, wine: "wine", xvfb: "xvfb-run" }, log: s => steps.push(s) }, { name: "Desktop Explorer" });
    expect(r.ok).toBe(false); expect(ran).toBe(false);
    expect(steps.join("\n")).toMatch(/GUI-only installer and dlgdrive\.exe/);
    expect(existsSync(join(staging, "SETUP.bin"))).toBe(true);
    expect(await installerKind(join(staging, "SETUP.exe"))).toBe("dialog");
    expect(dialogInstallCommand({ ...allTools, wine: "wine", xvfb: "xvfb-run" }, "/d/SETUP.exe", "/s", 5)).toBeNull();
  });
  test("an installer folder handed over as is (no ISO): run from the download, cracked, input untouched", async () => {
    const input = tmp(); sceneDisc(input);
    const staging = join(tmp(), "staging");
    const exec: Exec = async (cmd) => {
      if (cmd[0] === "xvfb-run") { installedUnity(staging); return { code: 0, stdout: "", stderr: "", timedOut: false }; }
      return { code: 2, stdout: "", stderr: "Cannot open the file as archive", timedOut: false };
    };
    const r = await deterministic(input, staging, { exec, tools: { ...allTools, wine: "wine", xvfb: "xvfb-run" }, log: () => {} }, { name: "DAVE THE DIVER" });
    expect(r.ok).toBe(true); expect(r.validation?.launch).toBe("DaveTheDiver.exe");
    expect(readFileSync(join(staging, "DaveTheDiver.exe"))[0]).toBe(7);
    expect(existsSync(join(input, "setup-1.bin"))).toBe(true);
  });
  test("a crack that mirrors the game's folders: each folder's own files land in that folder, and nowhere else", async () => {
    const mk = (root: string, rel: string, data: Uint8Array | string) => { mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(root, ...rel.split("/")), data); };
    // RUNE's METAL GEAR SOLID 4: four folders, each with a steam_api64.dll, its own steam_api64.rne (the game's own dll,
    // which differs per folder) and its own steam_emu.ini; the old overlay put the last folder's .rne in all four and the
    // settings in one (2026-11-11)
    const DIRS = ["Launcher/launcher_Data/Plugins/x86_64", "MGS1", "MGS4", "MGS4DB/Engine/Binaries/ThirdParty/Steamworks/Steamv157/Win64"];
    const g = tmp();
    DIRS.forEach(dir => mk(g, `${dir}/steam_api64.dll`, bytes(300_000, 1)));
    mk(g, "Launcher/launcher.exe", bytes(900_000, 1)); mk(g, "MGS1/mgs1.exe", bytes(2_000_000, 1)); mk(g, "MGS4/mgs4.exe", bytes(3_000_000, 1));
    const c = tmp();
    DIRS.forEach((dir, i) => { mk(c, `${dir}/steam_api64.dll`, bytes(1000, 9)); mk(c, `${dir}/steam_api64.rne`, bytes(2000 + i, 20 + i)); mk(c, `${dir}/steam_emu.ini`, `folder ${i}`); });
    mk(c, "Launcher/launcher.exe", bytes(1000, 9)); mk(c, "Launcher/launcher.rne", bytes(900, 8));
    mk(c, "MGS1/mgs1.exe", bytes(1000, 9)); mk(c, "MGS1/mgs1.rne", bytes(901, 8));
    mk(c, "MGS4/mgs4.exe", bytes(1000, 9)); mk(c, "MGS4/mgs4.rne", bytes(902, 8));
    const done = await overlayCrack(c, g);
    expect(done.length).toBe(18);                                         // every crack file once
    expect(done.sort()).toEqual((await scan(c)).files.map(f => f.rel).sort());
    DIRS.forEach((dir, i) => {
      expect(readFileSync(join(g, dir, "steam_api64.dll"))[0]).toBe(9);
      const rne = readFileSync(join(g, dir, "steam_api64.rne"));
      expect([dir, rne.length, rne[0]]).toEqual([dir, 2000 + i, 20 + i]);
      expect(readFileSync(join(g, dir, "steam_emu.ini"), "utf8")).toBe(`folder ${i}`);
    });
    expect(readFileSync(join(g, "MGS4", "mgs4.rne")).length).toBe(902);
    expect(existsSync(join(g, "steam_emu.ini"))).toBe(false);
  });
  test("a flat Crack folder: the DRM dll replaces every copy, its ini lands beside each", async () => {
    const g = tmp(); installedUnity(g);
    mkdirSync(join(g, "Gallery", "Gallery_Data", "Plugins", "x86_64"), { recursive: true });
    writeFileSync(join(g, "Gallery", "Gallery_Data", "Plugins", "x86_64", "steam_api64.dll"), bytes(400_000, 4));
    const c = tmp(); writeFileSync(join(c, "steam_api64.dll"), bytes(1000, 6)); writeFileSync(join(c, "steam_emu.ini"), "x"); writeFileSync(join(c, "DaveTheDiver.exe"), bytes(1000, 6));
    const done = await overlayCrack(c, g);
    expect(done.length).toBe(5);
    for (const p of ["DaveTheDiver_Data/Plugins/x86_64", "Gallery/Gallery_Data/Plugins/x86_64"]) {
      expect(readFileSync(join(g, p, "steam_api64.dll"))[0]).toBe(6);
      expect(existsSync(join(g, p, "steam_emu.ini"))).toBe(true);
    }
    expect(readFileSync(join(g, "DaveTheDiver.exe"))[0]).toBe(6);
  });

  test("folder → copied → ok", async () => {
    const input = tmp(); mkGame(join(input, "Hades"), "Hades");
    const staging = join(tmp(), "staging");
    const r = await deterministic(join(input, "Hades"), staging, { exec: fakeExec({}), tools: noTools, log: () => {} }, { name: "Hades" });
    expect(r.ok).toBe(true); expect(r.shape).toBe("folder");
    expect(r.validation?.launch).toBe("Hades.exe");
    expect(existsSync(join(staging, "Hades", "data", "level.pak"))).toBe(true);
  });
  test("archive → nested archive inside → game; nothing left to unpack", async () => {
    const input = tmp(); writeFileSync(join(input, "Game.rar"), "x"); writeFileSync(join(input, "Game.r00"), "x"); writeFileSync(join(input, "game.nfo"), "n");
    const calls: string[][] = [];
    const exec = fakeExec({
      "Game.rar": out => { mkdirSync(join(out, "Game-GROUP"), { recursive: true }); writeFileSync(join(out, "Game-GROUP", "inner.7z"), "x"); writeFileSync(join(out, "Game-GROUP", "group.nfo"), "n"); },
      "inner.7z": out => mkGame(out, "Game"),
    }, calls);
    const staging = join(tmp(), "staging");
    const steps: string[] = [];
    const r = await deterministic(input, staging, { exec, tools: allTools, log: s => steps.push(s) }, { name: "Game" });
    expect(r.ok).toBe(true);
    expect(calls.filter(c => c[1] === "x").length).toBe(2);
    expect(existsSync(join(staging, "Game-GROUP", "inner.7z"))).toBe(false);
    expect(existsSync(join(staging, "Game-GROUP", "inner", "Game.exe"))).toBe(true);
    expect(steps.join("\n")).toMatch(/extracting Game.rar[\s\S]*extracting inner.7z/);
  });
  test("RAR volumes → disc image inside → installer whose payload 7z reads → game: unrar takes the RAR, 7z the image", async () => {
    const zipped = (n: number, seed = 1) => Buffer.concat([Buffer.from("7z\xbc\xaf\x27\x1c", "latin1"), bytes(n, seed)]);
    const layouts = {
      "Game.rar": (out: string) => writeFileSync(join(out, "Game.iso"), bytes(10)),
      "Game.iso": (out: string) => { writeFileSync(join(out, "setup.exe"), bytes(3_000_000)); writeFileSync(join(out, "data1.bin"), zipped(2_000_000)); writeFileSync(join(out, "group.nfo"), "n"); },
      "data1.bin": (out: string) => mkGame(out, "Game"),
    };
    const run = async (tools: Toolbox) => {
      const input = tmp(); for (const n of ["Game.rar", "Game.r00", "Game.r01"]) writeFileSync(join(input, n), "x"); writeFileSync(join(input, "group.nfo"), "n");
      const calls: string[][] = [], steps: string[] = [];
      const staging = join(tmp(), "staging");
      const r = await deterministic(input, staging, { exec: fakeExec(layouts, calls), tools, log: s => steps.push(s) }, { name: "Game" });
      return { r, calls, steps, staging };
    };
    // unrar on the host: the RAR goes to it (never waiting on a password prompt), the image and the payload to 7z
    const a = await run({ ...allTools, unrar: "unrar" });
    expect(a.r.ok).toBe(true); expect(a.r.validation?.launch).toBe("Game.exe");
    expect(a.calls[0].slice(0, 5)).toEqual(["unrar", "x", "-y", "-o+", "-p-"]);
    expect(a.calls.filter(c => c[0] === "7z" && c[1] === "x").map(c => basename(c[c.length - 1]))).toEqual(["Game.iso", "data1.bin"]);
    for (const n of ["Game.iso", "setup.exe", "data1.bin"]) expect(existsSync(join(a.staging, n))).toBe(false);
    expect(a.steps.join("\n")).toMatch(/extracting Game.rar[\s\S]*extracting Game.iso[\s\S]*data1.bin is a plain archive/);
    // no unrar on the host: 7z takes the RAR itself; a failing unrar: 7z takes over after it
    const b = await run(allTools);
    expect(b.r.ok).toBe(true); expect(b.calls[0][0]).toBe("7z");
    const c = await run({ ...allTools, unrar: "unrar-broken" });
    expect(c.r.ok).toBe(true); expect(c.steps.join("\n")).toMatch(/unrar failed on Game.rar \(exit 127\).*trying 7z/);
  });
  test("GOG installer → innoextract: game at the root (newer layout), housekeeping dropped", async () => {
    const input = tmp(); writeFileSync(join(input, "setup_hades_1.38.exe"), "x"); writeFileSync(join(input, "setup_hades_1.38-1.bin"), "x");
    const exec = fakeExec({ "setup_hades_1.38.exe": out => { mkGame(out, "Hades"); writeFileSync(join(out, "goggame-123.hashdb"), "x"); } });
    const staging = join(tmp(), "staging");
    const r = await deterministic(input, staging, { exec, tools: allTools, log: () => {} }, { name: "Hades" });
    expect(r.ok).toBe(true); expect(r.shape).toBe("gog-installer");
    expect(readdirSync(staging).sort()).toEqual(["Hades.exe", "UnityCrashHandler64.exe", "_CommonRedist", "data", "goggame-1.ico", "readme.txt"]);
  });
  test("GOG installer → innoextract: game under app/ (older layout) is hoisted", async () => {
    const input = tmp(); writeFileSync(join(input, "setup_hades_1.0.exe"), "x"); writeFileSync(join(input, "setup_hades_1.0-1.bin"), "x");
    const exec = fakeExec({ "setup_hades_1.0.exe": out => mkGame(join(out, "app"), "Hades") });
    const staging = join(tmp(), "staging");
    const r = await deterministic(input, staging, { exec, tools: allTools, log: () => {} }, { name: "Hades" });
    expect(r.ok).toBe(true);
    expect(readdirSync(staging).sort()).toEqual(["Hades.exe", "UnityCrashHandler64.exe", "_CommonRedist", "data", "goggame-1.ico", "readme.txt"]);
  });
  test("ISO holding only a scene installer → not ok, with the validator's reason", async () => {
    const input = tmp(); writeFileSync(join(input, "game.iso"), "x");
    const exec = fakeExec({ "game.iso": out => { writeFileSync(join(out, "setup.exe"), bytes(6_000_000)); writeFileSync(join(out, "data1.bin"), bytes(50_000_000)); } });
    const r = await deterministic(input, join(tmp(), "staging"), { exec, tools: allTools, log: () => {} }, { name: "Game" });
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/installer-like/); expect(r.validation?.ok).toBe(false);
  });
  test("no archiver / installer-only / 7z failure are reported, not thrown", async () => {
    const input = tmp(); writeFileSync(join(input, "a.rar"), "x");
    expect((await deterministic(input, join(tmp(), "s"), { exec: fakeExec({}), tools: noTools, log: () => {} }, { name: "G" })).reason).toMatch(/no archiver/);
    expect((await deterministic(input, join(tmp(), "s"), { exec: fakeExec({}), tools: { ...allTools, unar: null }, log: () => {} }, { name: "G" })).reason).toMatch(/7z failed on a.rar/);
    const inst = tmp(); writeFileSync(join(inst, "setup.exe"), bytes(10)); writeFileSync(join(inst, "data1.bin"), bytes(10));
    expect((await deterministic(inst, join(tmp(), "s"), { exec: fakeExec({}), tools: allTools, log: () => {} }, { name: "G" })).reason).toMatch(/has to be run/);
  });
});

/** a scripted model: each call pops the next reply; tool_use blocks get ids automatically */
function scripted(turns: ContentBlock[][]): CallModel & { seen: unknown[][] } {
  let n = 0;
  const fn = (async (req: { messages: unknown[] }) => {
    fn.seen.push([...req.messages]);
    const content = (turns[n++] ?? [{ type: "text", text: "..." }]).map((b, i) => (b.type === "tool_use" ? { ...b, id: `t${n}-${i}` } : b));
    return { content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }) as unknown as CallModel & { seen: unknown[][] };
  fn.seen = [];
  return fn;
}

describe("agent prompt", () => {
  const base = { input: "/i", staging: "/s", work: "/w", gameName: "G", releaseTitle: "G-TENOKE", shape: "installer", problems: [], notes: [], exec: fakeExec({}), tools: { ...allTools, wine: "wine", xvfb: "xvfb-run", dlgdrive: "/usr/local/bin/dlgdrive.exe" }, callModel: (async () => ({ content: [], stop_reason: "end_turn" })) as CallModel, model: "m", maxTurns: 1, maxMinutes: 1, log: () => {} };
  test("earlier lessons and the dialog-installer helper are in the brief; the budget trims old ones", () => {
    const lessons = [
      { game: "Desktop Explorer", release: "Desktop.Explorer-TENOKE", ok: true, recognize: "TENOKE SETUP.exe + SETUP.bin", steps: ["start SETUP.exe under xvfb", "drive the dialog", "copy Crack over"], pitfalls: null, adopted: "process/scene.ts dialog installers" },
      { game: "Bloodborne", release: "Bloodborne 001 (Digital).cbz", ok: false, recognize: "a .cbz comic", steps: [], pitfalls: "not a game", adopted: null },
    ];
    const p = systemPrompt({ ...base, lessons });
    expect(p).toContain("WHAT WORKED BEFORE");
    expect(p).toMatch(/Desktop Explorer \(Desktop\.Explorer-TENOKE\) — succeeded; now a recipe: process\/scene\.ts/);
    expect(p).toMatch(/1\. start SETUP\.exe under xvfb[\s\S]*3\. copy Crack over/);
    expect(p).toMatch(/Bloodborne[^\n]*could not be done[\s\S]*pitfalls: not a game/);
    expect(p).toContain("/usr/local/bin/dlgdrive.exe");
    expect(p).toContain("PACE:");
    expect(systemPrompt({ ...base, lessons: [] })).not.toContain("WHAT WORKED BEFORE (lessons");
    const many = Array.from({ length: 40 }, (_, i) => ({ game: `G${i}`, release: null, ok: true, recognize: "x".repeat(400), steps: ["y".repeat(200)], pitfalls: null, adopted: null }));
    const text = priorLessons(many);
    expect(text.length).toBeLessThan(9600);
    expect(text).toContain("- G0 ");
    expect(text).not.toContain("- G39 ");
  });
});

describe("agent", () => {
  const base = (input: string, staging: string, work: string, exec: Exec, callModel: CallModel) => ({
    input, staging, work, gameName: "Hades", releaseTitle: "Hades-GROUP", shape: "installer", problems: ["only an installer"], notes: ["--- x.nfo ---\ninstall it"],
    exec, tools: allTools, callModel, model: "test", maxTurns: 8, maxMinutes: 5, log: () => {},
  });
  test("explores, runs a command that produces the game, validates, finishes → accepted", async () => {
    const work = tmp(), staging = join(work, "staging"), input = tmp();
    mkdirSync(staging);
    const cmds: string[] = [];
    const exec: Exec = async cmd => { cmds.push(cmd[2]); if (/make-game/.test(cmd[2])) mkGame(staging, "Hades"); return { code: 0, stdout: "done", stderr: "", timedOut: false }; };
    const model = scripted([
      [{ type: "text", text: "Looking around." }, { type: "tool_use", name: "list", input: { path: "$STAGING" } }, { type: "tool_use", name: "read", input: { path: "nope.nfo" } }],
      [{ type: "tool_use", name: "shell", input: { cmd: "make-game --into $STAGING" } }],
      [{ type: "tool_use", name: "validate", input: {} }],
      [{ type: "tool_use", name: "finish", input: { ok: true, summary: "ran the installer", launch_exe: "Hades.exe", version: "1.0" } }],
    ]);
    const r = await runAgent(base(input, staging, work, exec, model));
    expect(r.ok).toBe(true); expect(r.launchExe).toBe("Hades.exe"); expect(r.version).toBe("1.0"); expect(r.turns).toBe(4);
    expect(cmds).toEqual(["make-game --into $STAGING"]);
    const lastUser = (model.seen[3] as any[]).at(-1);
    expect(lastUser.role).toBe("user");
    expect(JSON.stringify(lastUser.content)).toMatch(/PASS — launch: Hades.exe/);
  });
  test("finish before the folder is right is pushed back; giving up is honoured", async () => {
    const work = tmp(), staging = join(work, "staging"); mkdirSync(staging);
    const model = scripted([
      [{ type: "tool_use", name: "finish", input: { ok: true, summary: "done?" } }],
      [{ type: "tool_use", name: "finish", input: { ok: false, summary: "needs a Windows installer I cannot run" } }],
    ]);
    const r = await runAgent(base(tmp(), staging, work, async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), model));
    expect(r.ok).toBe(false); expect(r.summary).toMatch(/cannot run/);
    expect(JSON.stringify((model.seen[1] as any[]).at(-1).content)).toMatch(/NOT YET/);
  });
  test("every step is traced in full and the agent's lesson comes back with the result", async () => {
    const work = tmp(), staging = join(work, "staging"), input = tmp(); mkdirSync(staging);
    const exec: Exec = async cmd => { if (/make-game/.test(cmd[2])) mkGame(staging, "Hades"); return { code: 0, stdout: "x".repeat(5000), stderr: "", timedOut: false }; };
    const trace: TraceStep[] = [];
    const model = scripted([
      [{ type: "text", text: "Inno Setup with an ArC payload." }, { type: "tool_use", name: "shell", input: { cmd: "make-game --into $STAGING" } }],
      [{ type: "tool_use", name: "finish", input: { ok: true, summary: "done", launch_exe: "Hades.exe",
        lesson: JSON.stringify({ recognize: "setup.exe + setup-1.bin starting with ArC", steps: ["wine setup.exe /VERYSILENT /DIR=$STAGING", " "], automatable: true }) } }],
    ]);
    const r = await runAgent({ ...base(input, staging, work, exec, model), trace: s => trace.push(s) });
    expect(r.ok).toBe(true);
    expect(r.lesson).toEqual({ recognize: "setup.exe + setup-1.bin starting with ArC", steps: ["wine setup.exe /VERYSILENT /DIR=$STAGING"], pitfalls: null, automatable: true });
    expect(trace.map(s => s.kind + (s.tool ? ":" + s.tool : ""))).toEqual(["brief", "say", "tool:shell", "tool:finish"]);
    expect(trace[0].text).toMatch(/Release: Hades-GROUP/);
    expect(trace[2].input).toEqual({ cmd: "make-game --into $STAGING" });
    expect(trace[2].output!.length).toBeGreaterThan(5000);
    expect(trace[3].output).toBe("accepted");
    expect((AGENT_TOOLS.find(t => t.name === "finish")!.input_schema as { required: string[] }).required).toContain("lesson");
    const giveUp = scripted([[{ type: "tool_use", name: "finish", input: { ok: false, summary: "an Android APK", lesson: { recognize: "a single .apk", steps: [] } } }]]);
    expect((await runAgent(base(tmp(), staging, work, exec, giveUp))).lesson).toEqual({ recognize: "a single .apk", steps: [], pitfalls: null, automatable: null });
  });
  test("runs out of turns / model failure", async () => {
    const work = tmp(), staging = join(work, "staging"); mkdirSync(staging);
    const loop = scripted(Array.from({ length: 10 }, () => [{ type: "tool_use" as const, name: "list", input: { path: "." } }]));
    const r = await runAgent({ ...base(tmp(), staging, work, async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), loop), maxTurns: 3 });
    expect(r.ok).toBe(false); expect(r.summary).toMatch(/gave up after 3 turns/);
    const broken: CallModel = async () => { throw new Error("HTTP 529"); };
    expect((await runAgent(base(tmp(), staging, work, async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), broken))).summary).toMatch(/model call failed: HTTP 529/);
  });
});

describe("job runner", () => {
  const lib = process.env.AHOY_LIBRARY!;
  let agentKey = "";
  const ctx = pluginContext("importers");
  beforeEach(() => {
    db.exec("DELETE FROM jobs; DELETE FROM packages;"); ensureDefaultRootFolder();
    agentKey = ""; pdeps.log = () => {}; pdeps.tools = () => allTools; pdeps.callModel = null;
    rdeps.importers = () => [
      { impl: "recipes", name: "Automatic recipes", importer: recipes.create({}, ctx) },
      ...(agentKey ? [{ impl: "agent", name: "AI importer", importer: agent.create({ apiKey: agentKey, baseUrl: "https://api.anthropic.com", model: "test", maxTurns: 8, maxMinutes: 5 }, ctx) }] : [{ impl: "agent", name: "AI importer", importer: agent.create({ apiKey: "", baseUrl: "", model: "test" }, ctx) }]),
    ];
  });

  test("imports at once: a second one starts only while the scratch disk can hold its need on top of the running one's", async () => {
    const downloads = tmp(); process.env.LUDARR_DOWNLOADS = downloads;
    const a = join(downloads, "Parallel.One-GROUP"); mkGame(a, "Parallel One");
    const b = join(downloads, "Parallel.Two-GROUP"); mkGame(b, "Parallel Two");
    const bytesA = (await scan(a)).files.reduce((n, f) => n + f.size, 0);
    expect(scratchNeeded(bytesA)).toBe(2e9);                                                  // a small game: the 2 GB floor
    expect(scratchNeeded(20e9)).toBe(60e9);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    pdeps.exec = async cmd => { await gate; return fakeExec({})(cmd); };                   // the first import sits in its unpack step until told
    const savedSpace = pdeps.diskSpace;
    let free = 3e9;                                                                          // room for one 2 GB need, not two
    pdeps.diskSpace = async () => ({ free, total: 100e9 });
    process.env.IMPORT_PARALLEL = "2";
    try {
      const j1 = stmts.insertJob.get(null, null, null, a) as JobRow;
      const j2 = stmts.insertJob.get(null, null, null, b) as JobRow;
      await processTick();
      expect(activeJobs()).toBe(1);
      const waiting = stmts.jobById.get(j2.id) as JobRow;
      expect(waiting.state).toBe("queued");
      expect(waiting.message).toMatch(/waiting for scratch space: this import needs about 2\.0 GB, 1\.0 GB will be free once the running import has what it may need/);
      await processTick();                                                                   // still no room: nothing changes
      expect(activeJobs()).toBe(1);
      free = 10e9;                                                                           // disk freed up elsewhere: the second one goes
      await processTick();
      expect(activeJobs()).toBe(2);
      // a job leaves `running` before its scratch folder is scrubbed: wait for the folders too, or the next test's job may reuse the id
      const settled = async (...ids: number[]) => { for (let i = 0; i < 400; i++) { if (ids.every(id => (stmts.jobById.get(id) as JobRow).state !== "running" && !existsSync(join(process.env.AHOY_WORK!, `job-${id}`)))) break; await new Promise(r => setTimeout(r, 25)); } await new Promise(r => setTimeout(r, 50)); };
      release();
      await settled(j1.id, j2.id);
      expect((stmts.jobById.get(j1.id) as JobRow).state).toBe("done");
      expect((stmts.jobById.get(j2.id) as JobRow).state).toBe("done");
      // with nothing running a lone import always starts, however little room there is
      free = 1;
      const c = join(downloads, "Parallel.Three-GROUP"); mkGame(c, "Parallel Three");
      const j3 = stmts.insertJob.get(null, null, null, c) as JobRow;
      await processTick();
      expect(activeJobs()).toBe(1);
      await settled(j3.id);
      expect((stmts.jobById.get(j3.id) as JobRow).state).toBe("done");
    } finally { pdeps.diskSpace = savedSpace; delete process.env.IMPORT_PARALLEL; }
  });

  test("folder input → package in the library, manifest written, input removed, events emitted", async () => {
    const downloads = tmp(); process.env.LUDARR_DOWNLOADS = downloads;         // ludarr's own folder: the raw download is removed after import
    const input = join(downloads, "Hades-GROUP"); mkGame(input, "Hades");
    pdeps.exec = fakeExec({});
    const j = stmts.insertJob.get(null, null, null, input) as JobRow;
    const seen: string[] = [];
    const off = events.subscribe(e => seen.push(e.event));
    await runJob(j.id);
    off();
    const done = stmts.jobById.get(j.id) as JobRow;
    expect(done.state).toBe("done"); expect(done.tier).toBe("deterministic");
    expect(done.output_path).toBe(join(resolve(lib), "hades-group"));
    expect(existsSync(join(done.output_path!, "ahoy.json"))).toBe(true);
    expect(existsSync(join(done.output_path!, "Hades.exe"))).toBe(true);
    expect(existsSync(input)).toBe(false);
    const pkg = stmts.packageForJob.get(j.id) as PackageRow;
    expect(pkg.name).toBe("Hades-GROUP"); expect(JSON.parse(pkg.manifest_json).launch.exe).toBe("Hades.exe");
    expect(JSON.parse(pkg.manifest_json).version).toBeNull();
    expect(done.transcript).toMatch(/input: folder[\s\S]*validator: ok[\s\S]*ready: 5 files/);
    expect(seen).toContain("package");
    expect(JSON.parse(done.fingerprint_json!)).toMatchObject({ input: { shape: "folder", files: 5 }, importers: [{ importer: "recipes", ok: true }] });
    expect(done.trace_json).toBeNull(); expect(done.lesson_json).toBeNull();
  });
  test("installer with no API key → failed with a clear reason; with the agent → done as tier agent", async () => {
    const input = tmp(); writeFileSync(join(input, "setup.exe"), bytes(10)); writeFileSync(join(input, "data1.bin"), bytes(10));
    pdeps.exec = fakeExec({});
    const j = stmts.insertJob.get(null, null, null, input) as JobRow;
    await runJob(j.id);
    expect(stmts.jobById.get(j.id) as JobRow).toMatchObject({ state: "failed", message: expect.stringMatching(/has to be run.*AI importer could take over/) });
    expect(JSON.parse((stmts.jobById.get(j.id) as JobRow).fingerprint_json!)).toMatchObject({ input: { shape: "installer", files: 2 }, importers: [{ importer: "recipes", ok: false, stopped: expect.stringMatching(/has to be run/) }] });

    agentKey = "sk-test";
    process.env.PROCESS_KEEP_INPUT = "1";
    let stagingSeen = "";
    pdeps.exec = async cmd => { const m = /--into (.+)$/.exec(cmd[2] ?? ""); if (m) { stagingSeen = m[1]; mkGame(m[1], "Setup Game"); } return { code: 0, stdout: "", stderr: "", timedOut: false }; };
    pdeps.callModel = scripted([
      [{ type: "tool_use", name: "shell", input: { cmd: "wine-install --into " + join(process.env.AHOY_WORK!, "job-" + (j.id + 1), "staging") } }],
      [{ type: "tool_use", name: "finish", input: { ok: true, summary: "installed with wine", launch_exe: "Setup Game.exe", lesson: { recognize: "setup.exe next to data1.bin", steps: ["wine-install --into $STAGING"], automatable: true } } }],
    ]);
    const j2 = stmts.insertJob.get(null, null, null, input) as JobRow;
    await runJob(j2.id);
    const done = stmts.jobById.get(j2.id) as JobRow;
    expect(done.state).toBe("done"); expect(done.tier).toBe("agent");
    const fp = JSON.parse(done.fingerprint_json!);
    expect(fp.input).toMatchObject({ shape: "installer", files: 2 }); expect(fp.importers[0].ok).toBe(false); expect("handedOver" in fp).toBe(true);
    expect(JSON.parse(done.trace_json!).filter((s: TraceStep) => s.kind === "tool").map((s: TraceStep) => s.tool)).toEqual(["shell", "finish"]);
    expect(JSON.parse(done.lesson_json!)).toMatchObject({ recognize: "setup.exe next to data1.bin", steps: ["wine-install --into $STAGING"], ok: true, turns: 2, model: expect.any(String) });
    const runs = await (await activityApi.request("/api/v1/import/lessons")).json() as any;
    expect(runs.open).toBe(1); expect(runs.items[0]).toMatchObject({ id: j2.id, toolSteps: 2, lesson: { automatable: true } }); expect(runs.items[0].trace).toBeUndefined();
    await activityApi.request(`/api/v1/import/${j2.id}/lesson`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ adopted: "recipes.ts: wine-install" }) });
    expect((await (await activityApi.request("/api/v1/import/lessons")).json() as any).open).toBe(0);
    const detail = await (await activityApi.request(`/api/v1/import/${j2.id}`)).json() as any;
    expect(detail.item.lesson.adopted).toBe("recipes.ts: wine-install"); expect(detail.item.trace.length).toBeGreaterThan(2);
    expect(stagingSeen).toContain("staging");
    expect(JSON.parse(done.manifest_json!).notes).toBe("installed with wine");
    expect(JSON.parse(done.manifest_json!).version).toBeNull();
    expect(existsSync(input)).toBe(true);
    delete process.env.PROCESS_KEEP_INPUT;
  });
});
