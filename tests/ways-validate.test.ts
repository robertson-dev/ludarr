import { describe, expect, test } from "bun:test";
import {
  acceptChanges, evidenceProblems, firstRunOnPlayersPc, normalizeRepo, placedName, provingProblem, safeRelPath, storeName, validateGameDraft,
  validatePlanSpec, validateWayContent, validateWayOverrides, versionKey,
} from "../src/ways/validate";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";

/** a plan the way Zelda 64: Recompiled is played (facts from ports.ts and the repo) */
const zelda = (): any => ({
  program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "Zelda64Recompiled.exe", argv: [] },
  content: {
    kind: "rom", platform: "n64", what: "Majora's Mask, NTSC-U 1.0", search: ["The Legend of Zelda: Majora's Mask"],
    accept: { hashes: [{ algo: "xxh3-64", value: "EF18B4A9E2386169" }, { algo: "sha1", value: "d6133ace5afaa0882cf214cf88daba39e266c078" }], formats: ["z64", "n64", "v64"] },
    normalize: "n64-z64", place: "mm.n64.us.1.0.z64",
  },
  files: [{ path: "portable.txt", text: "" }],
  setup: [], needs: [], keep: ["saves/**", "*.json"], seed: [], firstRun: "the recomp's own start menu", notes: "",
});

describe("runtime plans", () => {
  test("a good recomp plan passes and comes back normalised", () => {
    const r = validatePlanSpec(zelda(), "recomp");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.value!.content!.accept.hashes[0]).toEqual({ algo: "xxh3-64", value: "ef18b4a9e2386169" });
    expect(r.value!.content!.platform).toBe("n64");
  });

  test("paths stay inside the install folder", () => {
    for (const bad of ["../x.exe", "/abs/x.exe", "C:/x.exe", "a\\b.exe", "a//b.exe", "a/./b.exe"]) {
      const p = zelda(); p.launch.exe = bad;
      expect(validatePlanSpec(p, "recomp").ok).toBe(false);
    }
    expect(safeRelPath("saves/**", { glob: true })).toBeNull();
    expect(safeRelPath("saves/**")).not.toBeNull();
  });

  test("only .exe files start: a script would run through a shell", () => {
    const p = zelda(); p.launch.exe = "start.bat";
    expect(validatePlanSpec(p, "recomp").errors.join(" ")).toContain(".exe files only");
  });

  test("a hash has the length of its algorithm", () => {
    const p = zelda(); p.content.accept.hashes = [{ algo: "sha1", value: "abc" }];
    expect(validatePlanSpec(p, "recomp").errors.join(" ")).toContain("sha1 is 40 hex digits");
    const q = zelda(); q.content.accept.hashes = [{ algo: "xxh3-128", value: "99aa06d3014798d86001c324468d497f" }];
    expect(validatePlanSpec(q, "recomp").ok).toBe(true);
  });

  test("placeholders are the known ones, {content} only with a shipped game file", () => {
    const p = zelda(); p.launch.argv = ["--rom", "{content}", "{home}"];
    expect(validatePlanSpec(p, "recomp").errors.join(" ")).toContain("{home} is not a placeholder");
    const q = zelda() as any; q.content.ship = false; q.launch.argv = ["{content}"];
    expect(validatePlanSpec(q, "recomp").errors.join(" ")).toContain("{content} is not a placeholder");
  });

  test("a portable program must say which files hold saves", () => {
    const p = zelda(); p.keep = [];
    expect(validatePlanSpec(p, "recomp").errors.join(" ")).toContain("portable program keeps saves");
  });

  test("files never ship the server's own paths", () => {
    const p = zelda(); p.files.push({ path: "config.ini", text: "rom=Z:\\library\\.work\\job-3\\rom.z64" });
    expect(validatePlanSpec(p, "recomp").errors.join(" ")).toContain("wine Z: drive");
  });

  test("an emulator plan plays any game of its platform: per-game hashes belong on the way", () => {
    const emu: any = {
      program: { kind: "feed", feed: "dolphin:beta" },
      launch: { exe: "Dolphin.exe", argv: ["-b", "-C", "Dolphin.Analytics.PermissionAsked=True", "-e", "{content}"] },
      content: { kind: "disc", platform: "gc", what: "a GameCube disc image", search: ["placeholder"], accept: { hashes: [], formats: ["rvz", "iso"] }, place: "games/{name}" },
      files: [{ path: "portable.txt", text: "" }], setup: [], needs: [], keep: ["User/**"], seed: [], firstRun: null, notes: "",
    };
    expect(validatePlanSpec(emu, "emulator").errors).toEqual([]);
    emu.content.accept.hashes = [{ algo: "sha1", value: "d6133ace5afaa0882cf214cf88daba39e266c078" }];
    expect(validatePlanSpec(emu, "emulator").errors.join(" ")).toContain("put per-game hashes on the way");
    expect(validateWayContent(emu.content, "emulator").ok).toBe(true);
  });

  test("v1 keeps one file per game", () => {
    const p = zelda(); (p.content.accept as any).formats = ["cue"];
    expect(validatePlanSpec(p, "recomp").errors.join(" ")).toContain("one file per game");
  });

  test("setup steps: exactly one of exe and tool, known placeholders, sane timeouts", () => {
    const p: any = zelda();
    p.tools = { ref: "{tag}", steps: ["cmake -B build", "cmake --build build --target ExtractAssets"], outputs: ["build/extract"] };
    p.content.ship = false;
    p.setup = [{ run: { tool: "build/extract", argv: ["{content}", "{stage}/oot.o2r"], wine: false, timeoutSec: 600 } }];
    expect(validatePlanSpec(p, "port").errors).toEqual([]);
    p.setup = [{ run: { exe: "x.exe", tool: "build/extract", argv: [], wine: true, timeoutSec: 0 } }];
    const e = validatePlanSpec(p, "port").errors.join(" ");
    expect(e).toContain("exactly one of exe and tool");
    expect(e).toContain("1 to 3600");
  });

  test("needs are slots with a place", () => {
    const p: any = zelda(); p.needs = [{ kind: "bios", name: "PS2 BIOS" }];
    expect(validatePlanSpec(p, "recomp").errors.join(" ")).toContain("needs[0].place");
  });

  test("a source build may use the game file only when it says so", () => {
    const p: any = zelda();
    p.program = { kind: "source", ref: "nightly", steps: ["make VERSION=us -j8"], artifact: "build/us_pc", content: "none" };
    expect(validatePlanSpec(p, "port").errors).toEqual([]);
    p.program.steps = ["cp {content} baserom.us.z64", "make"];
    expect(validatePlanSpec(p, "port").errors.join(" ")).toContain("{content} is not a placeholder");
    p.program.content = "build";
    expect(validatePlanSpec(p, "port").errors).toEqual([]);
  });
});

describe("repos", () => {
  test("links and short forms become owner/name", () => {
    expect(normalizeRepo("https://github.com/Zelda64Recomp/Zelda64Recomp")).toEqual({ repo: "Zelda64Recomp/Zelda64Recomp", host: "github" });
    expect(normalizeRepo("https://github.com/HarbourMasters/Shipwright/tree/develop")).toEqual({ repo: "HarbourMasters/Shipwright", host: "github" });
    expect(normalizeRepo("git@github.com:PCSX2/pcsx2.git")).toEqual({ repo: "PCSX2/pcsx2", host: "github" });
    expect(normalizeRepo("sm64pc/sm64ex")).toEqual({ repo: "sm64pc/sm64ex", host: "github" });
    expect(normalizeRepo("https://codeberg.org/some/emu")).toEqual({ repo: "forgejo:codeberg.org/some/emu", host: "forgejo" });
    expect(normalizeRepo("dolphin:beta")).toEqual({ repo: "dolphin:beta", host: "feed" });
  });
  test("anything else is refused", () => {
    for (const bad of ["", "https://gitlab.com/a/b", "a/b/c", "forgejo:/a/b", "../x", "forgejo:host_with_underscore/a/b"]) expect("error" in normalizeRepo(bad)).toBe(true);
  });
});

describe("game file names", () => {
  test("stored names lose folders and leading dots", () => {
    expect(storeName("../../other/baserom.z64")).toBe("baserom.z64");
    expect(storeName("C:\\Users\\x\\.hidden.iso")).toBe("hidden.iso");
    expect(storeName("")).toBe("file");
  });
  test("placed names carry no shell syntax", () => {
    expect(placedName("Metroid Prime (USA) & more!.iso")).toBe("Metroid_Prime_USA__more.iso");
    expect(placedName("a&calc.cmd")).toBe("acalc.cmd");
    expect(placedName("Majora's Mask (USA).v64", "z64")).toBe("Majoras_Mask_USA.z64");
  });
});

describe("way overrides", () => {
  test("checked like the plan", () => {
    const spec = validatePlanSpec(zelda(), "recomp").value as RuntimePlanSpec;
    expect(validateWayOverrides({ argvExtra: ["--fullscreen"], env: { SDL_VIDEODRIVER: "windows" } }, spec).ok).toBe(true);
    expect(validateWayOverrides({ env: { "BAD-NAME": "x" } }, spec).ok).toBe(false);
    expect(validateWayOverrides({ files: [{ path: "../escape.ini", text: "" }] }, spec).ok).toBe(false);
  });
});

describe("manual games", () => {
  test("a described game passes, platforms by any of their names", () => {
    const r = validateGameDraft({ name: " Dinosaur  Planet ", aliases: ["Dinosaur Planet (Prototype)"], platforms: ["N64", "nintendo 64"], year: 2000, searchTerms: ["Dinosaur Planet N64"] });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ name: "Dinosaur Planet", platforms: ["n64"], year: 2000 });
  });
  test("at most 5 aliases and 3 search terms, so every one is asked", () => {
    expect(validateGameDraft({ name: "X", aliases: ["a", "b", "c", "d", "e", "f"] }).ok).toBe(false);
    expect(validateGameDraft({ name: "X", searchTerms: ["a", "b", "c", "d"] }).ok).toBe(false);
  });
  test("an alias equal to the name is dropped; unknown platforms and bad dates are refused", () => {
    expect(validateGameDraft({ name: "Doom", aliases: ["DOOM", "Doom (1993)"] }).value!.aliases).toEqual(["Doom (1993)"]);
    expect(validateGameDraft({ name: "X", platforms: ["Amiga"] }).ok).toBe(false);
    expect(validateGameDraft({ name: "X", releaseIso: "2024-13-40" }).ok).toBe(false);
  });
  test("a partial edit checks only what it sends", () => {
    expect(validateGameDraft({ aliases: ["Other name"] }, { partial: true }).ok).toBe(true);
    expect(validateGameDraft({ aliases: ["Other name"] }).ok).toBe(false);
  });
});

/* ─────────── the content model ─────────── */

const KYTY = "chenxiao07/KytyPS5", KYTY_AT = "65ed19d996d4f0c4fc46305194a3dde27e36e39c";
const DEMONS_SOULS = ["PPSA01340", "PPSA01341", "PPSA01342"], VERSIONS = ["01.005.000", "01.007.000"];
/** where KytyPS5 names the Demon's Souls editions it plays: src/graphics/host_gpu/renderer/demonsSouls.h:13-19 */
const demonsSoulsH = (values = [...DEMONS_SOULS, ...VERSIONS]) => ({ repo: KYTY, commit: KYTY_AT, path: "src/graphics/host_gpu/renderer/demonsSouls.h", lines: [13, 19], values });

/** the KytyPS5 plan: an emulator whose games are packed into one .zar */
const kytyPlan = (): any => ({
  program: { kind: "release", assetPattern: "^KytyPS5-v\\d+[.]zip$", channel: "stable" },
  launch: { exe: "KytyLauncher.exe", argv: ["--play"] },
  content: { kind: "disc", platform: "ps5", what: "a PS5 game packed from its app0 folder (.zar)", search: ["any"], accept: { hashes: [], formats: ["zar"] }, place: "game/{name}" },
  files: [], setup: [], needs: [], keep: ["user/**"], seed: [], firstRun: "The launcher compiles shaders on the first start.", notes: "",
});
/** way 1 of Demon's Souls as it is live: the emulator's template made this game's (one serial, no make, no versions) */
const kytyWay = (): any => ({
  kind: "disc", platform: "ps5", what: "Demon's Souls (PlayStation 5)", search: ["Demon's Souls"],
  accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, normalize: null, place: "game/PPSA01341-app0.zar",
});
/** the Kyty make: the app0 folder (sce_sys/param.json and eboot.bin) packed into one .zar with zarchive */
const kytyMake = (): any => ({
  from: ["kept", "copy", "inbox", "indexer"],
  input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", also: ["eboot.bin"], serials: [...DEMONS_SOULS], versions: [...VERSIONS], category: "game", complete: { minFiles: 90000, list: { path: "files-PPSA01341_01.007.000.files", share: 0.98 } } },
  steps: [
    { pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } },
    { convert: { with: "zarchive", argv: ["{prep}/app0", "{out}"], timeoutSec: 7200 } },
  ],
  output: { shape: "file", name: "{serial}-app0.zar" },
});
/** the way's content after the upgrade round: the three editions the code names, the two versions, made from the folder */
const kytyUpgraded = (): any => ({
  ...kytyWay(), terms: ["PPSA01341"], place: "game/{name}",
  accept: { hashes: [], formats: ["zar"], serials: [...DEMONS_SOULS], versions: [...VERSIONS], category: "game", evidence: [demonsSoulsH()] },
  make: kytyMake(),
});
/** the NX2navi plan as it is live: a recomp whose game file (a .nup) is described only in words, built on the player's PC */
const nx2navi = (): any => ({
  program: { kind: "release", assetPattern: "^NX2navi-Setup-.*[.]exe$", channel: "stable" },
  launch: { exe: "NX2navi.exe", argv: ["--from", "{install}/dump"] },
  content: {
    kind: "rom", platform: "switch", search: ["The Legend of Zelda: Ocarina of Time"], normalize: null, place: "dump/{name}",
    what: "The Legend of Zelda: Ocarina of Time (Switch 2) with its 1.1.1 update, as one .nup made with Eglantine: program 0400486024DEC000, main build e0f3ccfa",
    accept: { hashes: [], formats: ["nup"] },
  },
  files: [], setup: [], needs: [], keep: ["saves/**"], seed: [],
  firstRun: "On the first start NX2navi builds the game from the .nup on the player's PC (10 to 25 minutes, about 175 MB of tools downloaded).",
  notes: "Needs a Vulkan 1.3 GPU with VK_EXT_mesh_shader.",
});
/** NX2navi after a server-build round: the release kit builds the game per way, the .nup is proven by its ids */
const nx2naviOnServer = (): any => {
  const p = nx2navi();
  p.program = {
    kind: "release", assetPattern: "^NX2navi-app-.*[.]zip$", channel: "stable",
    perGame: {
      fetch: [{ url: "https://repo.msys2.org/mingw/clang64/mingw-w64-clang-x86_64-clang-19.1.7-1-any.pkg.tar.zst", sha256: "A".repeat(64), size: 123456, to: "msys2/clang.pkg.tar.zst", unpack: "tar.zst" }],
      steps: ["wine {program}/nx2navi-build.exe --dump {content} --out {out} --tools {tools} --cpu {cpu} -j{jobs} --work {work} --until compile"],
      wine: true, cpu: "x86-64-v3", timeoutSec: 21600, artifact: ".",
    },
  };
  p.launch = { exe: "ocarina.exe", argv: [] };
  p.content = { ...p.content, ship: false, personalDump: "Eglantine on your Switch 2", accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"], builds: ["E0F3CCFA"] } };
  p.check = { steps: [{ run: { exe: "ocarina.exe", argv: ["--selftest"], wine: true, timeoutSec: 600 }, what: "the built game passes its self-test", expect: "selftest: ok", needs: ["x86-64-v3", "wine"] }] };
  p.firstRun = null;
  return p;
};

const errs = (r: { errors: string[] }) => r.errors.join(" | ");
/** a way's content plan checked as an emulator way's is (hashes allowed, no plan to compare its tools with) */
const way = (c: unknown) => validateWayContent(c, "emulator");
const wayErrs = (c: unknown) => errs(way(c));
const valueOf = (c: unknown): ContentPlan => { const r = way(c); if (!r.ok) throw new Error(errs(r)); return r.value!; };

describe("the live plans keep loading", () => {
  test("NX2navi (a .nup described only in words, no hashes) and the Kyty way (one serial, no make) still pass, with the same warning as before", () => {
    const nx = validatePlanSpec(nx2navi(), "recomp");
    expect(nx.errors).toEqual([]);
    expect(nx.warnings).toEqual(["the game file cannot be verified (no accepted hashes): any file of the platform will do"]);
    expect(nx.value!.content).toMatchObject({ kind: "rom", platform: "switch", accept: { hashes: [], formats: ["nup"] }, place: "dump/{name}" });
    const kw = way(kytyWay());
    expect(kw.errors).toEqual([]);
    expect(kw.value).toMatchObject({ kind: "disc", platform: "ps5", accept: { formats: ["zar"], serials: ["PPSA01341"] } });
    expect(validatePlanSpec(kytyPlan(), "emulator").errors).toEqual([]);
  });

  test("a plan made before the content model comes back exactly as it went in: no new keys, so a save of it changes nothing", () => {
    for (const [spec, kind] of [[zelda(), "recomp"], [nx2navi(), "recomp"], [kytyPlan(), "emulator"]] as const) {
      const once = validatePlanSpec(spec, kind).value!;
      expect(Object.keys(once)).toEqual(["program", "launch", "content", "files", "setup", "needs", "keep", "seed", "firstRun", "notes"]);
      expect(Object.keys(once.content!)).toEqual(["kind", "platform", "what", "search", "accept", "normalize", "place"]);
      expect(JSON.stringify(validatePlanSpec(once, kind).value)).toBe(JSON.stringify(once));
    }
    const kw = valueOf(kytyWay());
    expect(JSON.stringify(valueOf(kw))).toBe(JSON.stringify(kw));
  });

  test("the upgraded plans pass too, and come back the same on a second save", () => {
    const up = valueOf(kytyUpgraded());
    expect(up.make!.output).toEqual({ shape: "file", name: "{serial}-app0.zar" });
    expect(up.accept.evidence![0]).toMatchObject({ repo: KYTY, lines: [13, 19] });
    expect(JSON.stringify(valueOf(up))).toBe(JSON.stringify(up));
    const nx = validatePlanSpec(nx2naviOnServer(), "recomp");
    expect(nx.errors).toEqual([]);
    expect(nx.value!.content!.accept.builds).toEqual(["e0f3ccfa"]);
    expect((nx.value!.program as any).perGame.fetch[0].sha256).toBe("a".repeat(64));
    expect(JSON.stringify(validatePlanSpec(nx.value, "recomp").value)).toBe(JSON.stringify(nx.value));
  });
});

describe("a game folder (content kind 'folder')", () => {
  const folder = (o: Record<string, unknown> = {}) => ({
    kind: "folder", platform: "ps5", what: "Demon's Souls, the app0 folder", search: ["Demon's Souls"], marker: "sce_sys/param.json", also: ["eboot.bin"],
    accept: { hashes: [], serials: ["PPSA01341"] }, place: "game/app0", complete: { minBytes: 70e9, minFiles: 90000 }, ...o,
  });
  test("names its marker and the files beside it, and its place is the folder it becomes", () => {
    const v = valueOf(folder());
    expect(v).toMatchObject({ kind: "folder", marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game/app0", complete: { minBytes: 70e9, minFiles: 90000 } });
  });
  test("a marker is required, inside the folder", () => {
    expect(wayErrs(folder({ marker: undefined }))).toContain("content.marker: the file inside the folder that says it is the game");
    expect(wayErrs(folder({ marker: "../sce_sys/param.json" }))).toContain("content.marker: may not hold . or .. segments");
    expect(wayErrs(folder({ marker: "/sce_sys/param.json" }))).toContain("content.marker: must be relative");
    expect(wayErrs(folder({ also: ["..\\eboot.bin"] }))).toContain("content.also[0]: must use forward slashes");
  });
  test("its place has no {name}, and it has no file format", () => {
    expect(wayErrs(folder({ place: "game/{name}" }))).toContain("content.place: a folder game's place is the folder it becomes, written without {name}");
    expect(wayErrs(folder({ accept: { hashes: [], formats: ["zar"] } }))).toContain("content.accept.formats: a folder game has no file format");
  });
  test("a marker or a completeness check on a file game is refused (it would do nothing)", () => {
    expect(wayErrs({ ...kytyWay(), marker: "sce_sys/param.json" })).toContain("content.marker: only a folder game has a marker");
    expect(wayErrs({ ...kytyWay(), complete: { minFiles: 10 } })).toContain("content.complete: only a folder game is checked for being whole");
    expect(way({ ...kytyWay(), marker: null, also: null, complete: null }).ok).toBe(true);
  });
  test("a kind that is none of the three is refused", () => {
    expect(wayErrs({ ...kytyWay(), kind: "tree" })).toContain("content.kind: rom, disc or folder");
  });
});

describe("terms, versions, category and builds", () => {
  const accept = (o: Record<string, unknown>) => ({ ...kytyWay(), accept: { ...kytyWay().accept, ...o } });
  test("up to 5 terms of up to 100 characters", () => {
    expect(valueOf({ ...kytyWay(), terms: ["PPSA01341", "Demon's Souls PS5"] }).terms).toEqual(["PPSA01341", "Demon's Souls PS5"]);
    expect(wayErrs({ ...kytyWay(), terms: ["a", "b", "c", "d", "e", "f"] })).toContain("content.terms: at most 5");
    expect(wayErrs({ ...kytyWay(), terms: ["x".repeat(101)] })).toContain("is longer than 100 characters");
  });
  test("versions are digits and dots as the data writes them, at most 8", () => {
    expect(valueOf(accept({ versions: ["01.007.000", "1.05", "01.007.000"] })).accept.versions).toEqual(["01.007.000", "1.05"]);
    expect(wayErrs(accept({ versions: ["v1.0"] }))).toContain(`content.accept.versions: "v1.0" is not a version`);
    expect(wayErrs(accept({ versions: ["1.0-beta"] }))).toContain("is not a version");
    expect(wayErrs(accept({ versions: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }))).toContain("content.accept.versions: at most 8");
    expect(wayErrs(accept({ versions: ["1." + "0".repeat(16)] }))).toContain("is longer than 16 characters");
  });
  test("the category is game, patch or addon", () => {
    expect(valueOf(accept({ category: "patch" })).accept.category).toBe("patch");
    expect(wayErrs(accept({ category: "dlc" }))).toContain("content.accept.category: game, patch or addon");
  });
  test("build ids are 8 to 64 hex digits, at most 4, kept in lower case", () => {
    expect(valueOf(accept({ builds: ["E0F3CCFA", "e0f3ccfa"] })).accept.builds).toEqual(["e0f3ccfa"]);
    expect(wayErrs(accept({ builds: ["e0f3cc"] }))).toContain(`"e0f3cc" is not a build id`);
    expect(wayErrs(accept({ builds: ["xyz12345"] }))).toContain("is not a build id");
    expect(wayErrs(accept({ builds: ["a".repeat(8), "b".repeat(8), "c".repeat(8), "d".repeat(8), "e".repeat(8)] }))).toContain("content.accept.builds: at most 4");
  });
});

describe("evidence: where the program's code names an accepted value", () => {
  const withEvidence = (...e: unknown[]) => ({ ...kytyWay(), accept: { ...kytyWay().accept, evidence: e } });
  test("a repo, its full commit, a path, a few lines and the values they hold", () => {
    const v = valueOf(withEvidence({ ...demonsSoulsH(), repo: `https://github.com/${KYTY}`, commit: KYTY_AT.toUpperCase() }));
    expect(v.accept.evidence).toEqual([demonsSoulsH() as any]);
  });
  test("each part is checked", () => {
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), repo: "dolphin:beta" }))).toContain("content.accept.evidence[0].repo: a repo whose files can be read");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), repo: "gitlab.com/a/b/c" }))).toContain("content.accept.evidence[0].repo:");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), commit: "65ed19d9" }))).toContain("content.accept.evidence[0].commit: the full 40-digit commit");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), path: "../secrets" }))).toContain("content.accept.evidence[0].path: may not hold . or .. segments");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), lines: [19, 13] }))).toContain("content.accept.evidence[0].lines: [first, last]");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), lines: [0, 5] }))).toContain("[first, last]");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), lines: [13] }))).toContain("[first, last]");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), lines: [1, 400] }))).toContain("content.accept.evidence[0].lines: at most 300 lines apart");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), lines: [999_990, 1_000_001] }))).toContain("content.accept.evidence[0].lines: [first, last]");
    expect(valueOf(withEvidence({ ...demonsSoulsH(), lines: ["13", "19"] })).accept.evidence![0].lines).toEqual([13, 19]);
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), values: [] }))).toContain("content.accept.evidence[0].values: the values those lines name");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), values: Array.from({ length: 21 }, (_, i) => `V${i}`) }))).toContain("content.accept.evidence[0].values: at most 20");
    expect(wayErrs(withEvidence({ ...demonsSoulsH(), values: ["x".repeat(101)] }))).toContain("is longer than 100 characters");
    expect(wayErrs(withEvidence(...Array.from({ length: 21 }, () => demonsSoulsH())))).toContain("content.accept.evidence: at most 20");
  });
  test("a line of text is no evidence: it must say where", () => {
    expect(wayErrs(withEvidence("chenxiao07/KytyPS5@65ed19d9 src/graphics/host_gpu/renderer/demonsSouls.h:13-26 PPSA01342"))).toContain("content.accept.evidence[0]: must be {repo, commit, path, lines, values}");
    expect(wayErrs({ ...kytyWay(), accept: { ...kytyWay().accept, evidence: "demonsSouls.h" } })).toContain("content.accept.evidence: a list of");
  });
});

describe("completeness and personal dumps", () => {
  const folder = (complete: unknown) => ({ kind: "folder", platform: "ps5", what: "x", search: ["x"], marker: "sce_sys/param.json", accept: { hashes: [] }, place: "app0", complete });
  test("at least so many bytes or files, or most of the paths a file in the program lists", () => {
    expect(valueOf(folder({ list: { path: "files-PPSA01341_01.007.000.files" } })).complete).toEqual({ list: { path: "files-PPSA01341_01.007.000.files" } });
    expect(valueOf(folder({ minBytes: 0, minFiles: 10, list: { path: "f.files", share: 0.98 } })).complete).toEqual({ minBytes: 0, minFiles: 10, list: { path: "f.files", share: 0.98 } });
  });
  test("an empty check, negative counts, a share outside 0.5..1 and a list outside the program are refused", () => {
    expect(wayErrs(folder({}))).toContain("content.complete: minBytes, minFiles or list (an empty check checks nothing)");
    expect(wayErrs(folder({ minFiles: -1 }))).toContain("content.complete.minFiles: a whole number, 0 or more");
    expect(wayErrs(folder({ minBytes: 1.5 }))).toContain("content.complete.minBytes: a whole number");
    expect(wayErrs(folder({ list: { path: "f.files", share: 0.4 } }))).toContain("content.complete.list.share: between 0.5 and 1");
    expect(wayErrs(folder({ list: { path: "f.files", share: 1.2 } }))).toContain("between 0.5 and 1");
    expect(wayErrs(folder({ list: { path: "../f.files" } }))).toContain("content.complete.list.path: may not hold . or .. segments");
    expect(wayErrs(folder("all"))).toContain("content.complete: {minBytes?, minFiles?, list?: {path, share?}}");
  });
  test("who makes a personal dump, in up to 200 characters", () => {
    expect(valueOf({ ...nx2navi().content, personalDump: "Eglantine on your Switch 2" }).personalDump).toBe("Eglantine on your Switch 2");
    expect(valueOf({ ...nx2navi().content, personalDump: "  " }).personalDump).toBeUndefined();
    expect(wayErrs({ ...nx2navi().content, personalDump: "x".repeat(201) })).toContain("content.personalDump: who makes it, up to 200 characters");
    expect(wayErrs({ ...nx2navi().content, personalDump: true })).toContain("content.personalDump");
  });
});

describe("a make: the game file made from another form of the game's data", () => {
  const made = (m: Record<string, unknown>, c: Record<string, unknown> = {}) => ({ ...kytyWay(), place: "game/{name}", ...c, make: { ...kytyMake(), ...m } });
  const steps = (...s: unknown[]) => made({ steps: s });
  const pick = { pick: { within: "{in}", marker: "sce_sys/param.json", as: "app0" } };
  const convert = (argv = ["{prep}/app0", "{out}"], extra: Record<string, unknown> = {}) => ({ convert: { with: "zarchive", argv, timeoutSec: 3600, ...extra } });

  test("the Kyty recipe passes: pick the app0 folder in the input, pack it with zarchive", () => {
    const v = valueOf(made({}));
    expect(v.make!.steps).toEqual([{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, { convert: { with: "zarchive", argv: ["{prep}/app0", "{out}"], timeoutSec: 7200 } }]);
    expect(v.make!.input).toMatchObject({ shape: "folder", platform: "ps5", marker: "sce_sys/param.json", complete: { minFiles: 90000 } });
  });

  test("a file input is unpacked first, then picked inside {prep}; remove and move stay inside {prep}", () => {
    const v = valueOf(made({
      input: { shape: "file", platform: "ps5", formats: ["rar", ".7Z", "zip"], marker: "sce_sys/param.json" },
      steps: [
        { unpack: { to: "unpacked", only: ["**/sce_sys/**", "**/eboot.bin"] } },
        { pick: { within: "{prep}/unpacked", marker: "sce_sys/param.json", as: "app0" } },
        { remove: "unpacked/**/*.txt" }, { move: { from: "app0/extra", to: "spare/extra" } },
        convert(),
      ],
    }));
    expect(v.make!.input.formats).toEqual(["rar", "7z", "zip"]);
    expect(v.make!.steps.length).toBe(5);
  });

  test("each field holds only its own placeholders", () => {
    expect(wayErrs(steps(pick, convert(["{prep}/app0", "{out}", "{program}/x"])))).toContain("content.make.steps[1].convert.argv[2]: {program} is not a placeholder here");
    expect(wayErrs(steps(pick, convert(["{stage}", "{out}"])))).toContain("{stage} is not a placeholder here");
    expect(wayErrs(steps(pick, convert(["{tools}/x", "{out}"])))).toContain("{tools} is not a placeholder here");
    expect(way(steps(pick, { run: { exe: "tools/pack.exe", argv: ["{program}/data", "{prep}/app0", "{out}", "{serial}", "{version}"], wine: true, timeoutSec: 600 } })).ok).toBe(true);
    expect(wayErrs(steps(pick, { run: { exe: "tools/pack.exe", argv: ["{content}", "{out}"], wine: true, timeoutSec: 600 } }))).toContain("{content} is not a placeholder here");
    expect(wayErrs(steps({ unpack: { to: "{prep}/x" } }, convert()))).toContain("content.make.steps[0].unpack.to: a path inside {prep}, written without placeholders");
    expect(wayErrs(steps({ pick: { within: "{in}", marker: "sce_sys/param.json", as: "{out}" } }, convert()))).toContain("content.make.steps[0].pick.as: a path inside {prep}, written without placeholders");
    expect(wayErrs(steps(pick, { move: { from: "app0", to: "{out}/app0" } }, convert()))).toContain("content.make.steps[1].move.to: a path inside {prep}, written without placeholders");
    expect(wayErrs(steps(pick, { remove: "../app0" }, convert()))).toContain("content.make.steps[1].remove: may not hold . or .. segments (a path inside {prep})");
    expect(wayErrs(steps(pick, { remove: "{in}/x" }, convert()))).toContain("content.make.steps[1].remove: a path inside {prep}, written without placeholders");
  });

  test("{out} is written by exactly the one step that makes the product, and some step reads the input", () => {
    expect(wayErrs(steps(pick, convert(["{prep}/app0", "{prep}/x.zar"])))).toContain("content.make.steps: no step writes the product: one convert or run step puts it at {out}");
    expect(wayErrs(steps(pick, convert(), convert()))).toContain("content.make.steps: only the step that makes the product writes {out} (2 steps do)");
    expect(wayErrs(steps({ pick: { within: "{prep}", marker: "sce_sys/param.json", as: "app0" } }, convert()))).toContain("content.make.steps: no step reads the input");
    expect(way(steps(convert(["{in}", "{out}"]))).ok).toBe(true);
  });

  test("an unpack needs a file and a pick within {in} a folder", () => {
    expect(wayErrs(steps({ unpack: { to: "x" } }, convert()))).toContain("content.make.steps[0].unpack: the input is a folder: there is nothing to unpack");
    expect(wayErrs(made({ input: { shape: "file", platform: "ps5", formats: ["zip"] } }))).toContain("content.make.steps[0].pick.within: the input is a file: unpack it first and pick inside {prep}");
    expect(wayErrs(steps({ pick: { within: "app0", marker: "sce_sys/param.json", as: "app0" } }, convert()))).toContain("content.make.steps[0].pick.within: {in} (the input) or {prep}");
    expect(wayErrs(steps({ pick: { within: "{prep}/../x", marker: "sce_sys/param.json", as: "app0" } }, convert(["{in}", "{out}"])))).toContain("content.make.steps[0].pick.within: may not hold . or .. segments");
    expect(wayErrs(steps({ pick: { within: "{in}", marker: "../param.json", as: "app0" } }, convert()))).toContain("content.make.steps[0].pick.marker: may not hold . or .. segments");
  });

  test("a converter is one ludarr knows or one pinned to a commit of a public repo, built from allowed packages", () => {
    const pinned = { repo: "https://github.com/Exzap/ZArchive", commit: "D2C717730092C7BF8CBB033B12FD4001B7C4D932", steps: ["cmake -S . -B b -DCMAKE_BUILD_TYPE=Release", "cmake --build b -j{jobs}"], outputs: ["b/zarchive"], apt: ["libzstd-dev", "cmake"] };
    const v = valueOf(steps(pick, convert(undefined, { with: pinned })));
    expect((v.make!.steps[1] as any).convert.with).toEqual({ ...pinned, repo: "Exzap/ZArchive", commit: pinned.commit.toLowerCase() });
    expect(wayErrs(steps(pick, convert(undefined, { with: "chdman" })))).toContain("content.make.steps[1].convert.with: one of zarchive, or a converter pinned to a commit");
    expect(wayErrs(steps(pick, convert(undefined, { with: { ...pinned, commit: "d2c71773" } })))).toContain("convert.with.commit: the full 40-digit commit");
    expect(wayErrs(steps(pick, convert(undefined, { with: { ...pinned, repo: "dolphin:dev" } })))).toContain("convert.with.repo: a GitHub owner/name");
    expect(wayErrs(steps(pick, convert(undefined, { with: { ...pinned, steps: [] } })))).toContain("convert.with.steps: the build commands");
    expect(wayErrs(steps(pick, convert(undefined, { with: { ...pinned, steps: Array.from({ length: 21 }, () => "make") } })))).toContain("convert.with.steps: at most 20");
    expect(wayErrs(steps(pick, convert(undefined, { with: { ...pinned, steps: ["make -C {prep}"] } })))).toContain("{prep} is not a placeholder here ({jobs})");
    expect(wayErrs(steps(pick, convert(undefined, { with: { ...pinned, outputs: ["../zarchive"] } })))).toContain("convert.with.outputs[0]: may not hold . or .. segments");
    expect(wayErrs(steps(pick, convert(undefined, { with: { ...pinned, apt: ["curl"] } })))).toContain("convert.with.apt: curl is not on the build allowlist");
  });

  test("steps run 1 second to 4 hours; 1 to 20 steps, each exactly one kind", () => {
    expect(way(steps(pick, convert(undefined, { timeoutSec: 14400 }))).ok).toBe(true);
    expect(wayErrs(steps(pick, convert(undefined, { timeoutSec: 14401 })))).toContain("content.make.steps[1].convert.timeoutSec: whole seconds, 1 to 14400");
    expect(wayErrs(steps(pick, convert(undefined, { timeoutSec: 0 })))).toContain("1 to 14400");
    expect(wayErrs(steps(pick, { run: { exe: "pack.exe", argv: ["{in}", "{out}"], wine: true, timeoutSec: 20000 } }))).toContain("content.make.steps[1].run.timeoutSec: whole seconds, 1 to 14400");
    expect(wayErrs(made({ steps: [] }))).toContain("content.make.steps: the steps, in order (1 to 20)");
    expect(wayErrs(made({ steps: [pick, ...Array.from({ length: 19 }, () => ({ remove: "x" })), convert()] }))).toContain("content.make.steps: at most 20 steps");
    expect(wayErrs(steps({ ...pick, ...convert() }))).toContain("content.make.steps[0]: exactly one of unpack, pick, convert, run, remove, move");
    expect(wayErrs(steps(pick, { copy: "x" }, convert()))).toContain("content.make.steps[1]: exactly one of unpack, pick, convert, run, remove, move");
  });

  test("a run step's program: exactly one of exe and tool, .exe under wine", () => {
    expect(wayErrs(steps(pick, { run: { exe: "pack.sh", argv: ["{in}", "{out}"], wine: true, timeoutSec: 60 } }))).toContain("content.make.steps[1].run.exe: wine runs .exe files");
    expect(wayErrs(steps(pick, { run: { exe: "/usr/bin/pack", argv: ["{in}", "{out}"], wine: false, timeoutSec: 60 } }))).toContain("content.make.steps[1].run.exe: must be relative");
    expect(way(steps(pick, { run: { exe: "python3", argv: ["{in}", "{out}"], wine: false, timeoutSec: 60 } })).ok).toBe(true);
    expect(wayErrs(steps(pick, { run: { exe: "a.exe", tool: "b", argv: ["{in}", "{out}"], wine: true, timeoutSec: 60 } }))).toContain("content.make.steps[1].run: exactly one of exe and tool");
    // a tool must be one the plan builds: known where the plan is
    const plan = kytyPlan();
    plan.content = { ...kytyUpgraded(), what: "a PS5 game", search: ["any"], accept: { hashes: [], formats: ["zar"] }, make: { ...kytyMake(), input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json" }, steps: [pick, { run: { tool: "bin/pack", argv: ["{prep}/app0", "{out}"], wine: false, timeoutSec: 60 } }] } };
    expect(errs(validatePlanSpec(plan, "emulator"))).toContain("content.make.steps[1].run.tool: must be one of tools.outputs");
    plan.tools = { ref: "{tag}", steps: ["make pack"], outputs: ["bin/pack"] };
    expect(validatePlanSpec(plan, "emulator").errors).toEqual([]);
    expect(validateWayContent(plan.content, "emulator", { tools: null }).errors.join(" ")).toContain("run.tool: must be one of tools.outputs");
    expect(validateWayContent(plan.content, "emulator", { tools: plan.tools }).ok).toBe(true);
  });

  test("the product: a safe name in a format the plan accepts, of the way's own shape", () => {
    expect(wayErrs(made({ output: { shape: "folder", name: "app0" } }))).toContain("content.make.output.shape: file, as the way's game data is one file");
    expect(wayErrs(made({ output: { shape: "file", name: "{serial} app0.zar" } }))).toContain("content.make.output.name: letters, digits, dot, dash and underscore only");
    expect(wayErrs(made({ output: { shape: "file", name: ".zar" } }))).toContain("content.make.output.name: letters, digits, dot, dash and underscore only");
    expect(wayErrs(made({ output: { shape: "file", name: "{title}.zar" } }))).toContain("content.make.output.name: {title} is not a placeholder here ({serial}, {version})");
    expect(wayErrs(made({ output: { shape: "file", name: "{serial}.iso" } }))).toContain("content.make.output.name: a .iso file, and accept.formats (the product's formats) are .zar");
    expect(wayErrs(made({ output: { shape: "file", name: "{serial}" } }))).toContain("content.make.output.name: a file's name ends with its format");
    expect(wayErrs(made({ output: { shape: "box", name: "x.zar" } }))).toContain("content.make.output.shape: file or folder");
    expect(way(made({ output: { shape: "file", name: "{serial}-{version}.zar" } })).ok).toBe(true);
    expect(wayErrs(made({}, { accept: { hashes: [], serials: ["PPSA01341"] } }))).toContain("content.accept.formats: a made file says its format here");
    // a game folder made from another form is a folder product, with no format
    const folderMade = { kind: "folder", platform: "ps5", what: "x", search: ["x"], marker: "sce_sys/param.json", accept: { hashes: [] }, place: "app0",
      make: { input: { shape: "file", platform: "ps5", formats: ["rar"] }, steps: [{ unpack: { to: "x" } }, { run: { exe: "copy-tree", argv: ["{prep}/x", "{out}"], wine: false, timeoutSec: 600 } }], output: { shape: "folder", name: "app0" } } };
    expect(way(folderMade).errors).toEqual([]);
  });

  test("what the input must be: its shape, the same console, formats for a file, a marker for a folder", () => {
    const input = (o: Record<string, unknown>) => made({ input: { ...kytyMake().input, ...o } });
    expect(wayErrs(input({ platform: "ps4" }))).toContain("content.make.input.platform: game data is only re-shaped, so it is the same console's as the game file (ps5)");
    expect(wayErrs(input({ platform: "amiga" }))).toContain("content.make.input.platform: one of");
    expect(wayErrs(input({ shape: "tree" }))).toContain("content.make.input.shape: file, folder or either");
    expect(wayErrs(input({ formats: ["zip"] }))).toContain("content.make.input.formats: a folder input has no file format");
    expect(wayErrs(input({ shape: "file", marker: undefined, also: undefined }))).toContain("content.make.input.formats: what a file input may be");
    expect(wayErrs(input({ marker: undefined }))).toContain("content.make.input.marker: the file that says a folder is the game");
    expect(wayErrs(input({ shape: "file", formats: ["7z"], marker: undefined }))).toContain("content.make.input.also: files beside the marker: name the marker too");
    expect(wayErrs(input({ shape: "file", formats: ["cue"] }))).toContain(`"cue" is made of several files`);
    expect(wayErrs(input({ versions: ["v1.07"] }))).toContain(`content.make.input.versions: "v1.07" is not a version`);
    expect(wayErrs(input({ category: "update" }))).toContain("content.make.input.category: game, patch or addon");
    expect(wayErrs(input({ regions: ["Mars"] }))).toContain(`content.make.input.regions: "Mars" is not a region`);
    expect(wayErrs(input({ complete: {} }))).toContain("content.make.input.complete: minBytes, minFiles or list");
    expect(way(input({ shape: "either", formats: ["zip", "rar"] })).ok).toBe(true);
    // 'either' is the folder or a file holding it: that file's formats are said too
    expect(wayErrs(input({ shape: "either" }))).toContain("content.make.input.formats: what a file input may be");
  });

  test("where its input may come from", () => {
    expect(valueOf(made({ from: ["copy", "inbox", "copy"] })).make!.from).toEqual(["copy", "inbox"]);
    expect(wayErrs(made({ from: ["kept", "nas"] }))).toContain(`content.make.from: "nas" is not one of kept, copy, inbox, indexer`);
    expect(wayErrs(made({ from: [] }))).toContain("content.make.from: a list of kept, copy, inbox, indexer");
    expect(valueOf(made({ from: undefined })).make!.from).toBeUndefined();
  });
});

describe("a per-game build from the release kit (program.perGame)", () => {
  const kit = (o: Record<string, unknown>) => { const p = nx2naviOnServer(); p.program.perGame = { ...p.program.perGame, ...o }; return p; };
  const kitErrs = (o: Record<string, unknown>) => errs(validatePlanSpec(kit(o), "recomp"));
  test("pinned fetches, steps with the kit's placeholders, wine, a CPU level and the install folder inside {out}", () => {
    const v = validatePlanSpec(nx2naviOnServer(), "recomp").value!;
    expect((v.program as any).perGame).toMatchObject({ steps: [expect.stringContaining("--cpu {cpu}")], wine: true, cpu: "x86-64-v3", timeoutSec: 21600, artifact: "." });
    expect(validatePlanSpec({ ...nx2naviOnServer(), program: { kind: "url", url: "https://example.com/kit.zip", sha256: "b".repeat(64), perGame: nx2naviOnServer().program.perGame } }, "recomp").errors).toEqual([]);
  });
  test("only a release asset or a fixed file is such a kit, and it builds from the game file", () => {
    const p = nx2naviOnServer();
    p.program = { kind: "source", ref: "main", steps: ["make"], artifact: "out", content: "build", perGame: p.program.perGame };
    expect(errs(validatePlanSpec(p, "recomp"))).toContain("program.perGame: only a release asset or a fixed file (url) is a kit");
    expect(errs(validatePlanSpec({ ...nx2naviOnServer(), program: { kind: "feed", feed: "dolphin:beta", perGame: {} } }, "recomp"))).toContain("program.perGame: only a release asset");
    expect(errs(validatePlanSpec({ ...nx2naviOnServer(), content: null }, "recomp"))).toContain("program.perGame: builds the game from its file, so the plan needs a content plan");
  });
  test("every fetch is https and pinned by its sha256, into {tools}", () => {
    const f = nx2naviOnServer().program.perGame.fetch[0];
    expect(kitErrs({ fetch: [{ ...f, url: "http://repo.msys2.org/x.pkg.tar.zst" }] })).toContain("program.perGame.fetch[0].url: an https address");
    expect(kitErrs({ fetch: [{ ...f, url: "https://user:pw@example.com/x" }] })).toContain("program.perGame.fetch[0].url: may not carry a login");
    expect(kitErrs({ fetch: [{ ...f, sha256: "abc" }] })).toContain("program.perGame.fetch[0].sha256: the file's sha256 (64 hex digits)");
    expect(kitErrs({ fetch: [{ ...f, to: "../x" }] })).toContain("program.perGame.fetch[0].to: may not hold . or .. segments");
    expect(kitErrs({ fetch: [{ ...f, to: "{tools}/x" }] })).toContain("program.perGame.fetch[0].to: a path inside {tools}, written without placeholders");
    expect(kitErrs({ fetch: [{ ...f, unpack: "rar" }] })).toContain("program.perGame.fetch[0].unpack: zip, tar, tar.zst or none");
    expect(kitErrs({ fetch: [{ ...f, size: -3 }] })).toContain("program.perGame.fetch[0].size: whole bytes");
    expect(kitErrs({ fetch: Array.from({ length: 65 }, () => f) })).toContain("program.perGame.fetch: at most 64 files");
  });
  test("1 to 30 steps with the kit's placeholders; {cpu} needs the level; per-step time up to 6 hours", () => {
    expect(kitErrs({ steps: [] })).toContain("program.perGame.steps: the build commands, in order (1 to 30)");
    expect(kitErrs({ steps: Array.from({ length: 31 }, () => "make") })).toContain("program.perGame.steps: at most 30");
    expect(kitErrs({ steps: ["make -C {stage}"] })).toContain("program.perGame.steps[0]: {stage} is not a placeholder here");
    expect(kitErrs({ cpu: undefined })).toContain("program.perGame.cpu: the steps pass {cpu}, so the plan names the level");
    expect(kitErrs({ cpu: "native" })).toContain("program.perGame.cpu: x86-64-v2 or x86-64-v3");
    expect(kitErrs({ timeoutSec: 21601 })).toContain("program.perGame.timeoutSec: whole seconds per step, 1 to 21600");
    expect(kitErrs({ timeoutSec: 0 })).toContain("1 to 21600");
    expect(kitErrs({ artifact: "../out" })).toContain("program.perGame.artifact: may not hold . or .. segments");
    expect(kitErrs({ wine: "yes" })).toContain("program.perGame.wine: true (the steps run Windows tools) or false");
    expect(errs(validatePlanSpec({ ...nx2naviOnServer(), program: { ...nx2naviOnServer().program, perGame: "build it" } }, "recomp"))).toContain("program.perGame: {fetch?, steps, wine?, cpu?, timeoutSec, artifact}");
  });
});

describe("checks run on the server (spec.check)", () => {
  const kytyCheck = () => ({
    steps: [{ run: { exe: "kyty_shader_precompile.exe", argv: ["--game", "{content}", "--param", "{work}/param.json"], wine: true, timeoutSec: 1800 }, what: "the emulator reads the packed game", expect: "param.json: PPSA01341 (", needs: ["x86-64-v3", "wine", "wine"] }],
    smoke: { seconds: 20, title: "Kyty", needs: "vulkan" },
  });
  const checked = (check: unknown, o: Record<string, unknown> = {}) => validatePlanSpec({ ...kytyPlan(), check, ...o }, "emulator");
  const checkErrs = (check: unknown, o: Record<string, unknown> = {}) => errs(checked(check, o));
  test("GPU-free steps with what they show, a piece of text to find, what they need; a short smoke start", () => {
    const v = checked(kytyCheck()).value!;
    expect(v.check).toEqual({ steps: [{ run: { exe: "kyty_shader_precompile.exe", argv: ["--game", "{content}", "--param", "{work}/param.json"], wine: true, timeoutSec: 1800 }, what: "the emulator reads the packed game", expect: "param.json: PPSA01341 (", needs: ["x86-64-v3", "wine"] }], smoke: { seconds: 20, title: "Kyty", needs: "vulkan" } });
    expect(checked({ smoke: { seconds: 5, needs: "nothing" } }).errors).toEqual([]);
  });
  test("expect is plain text found in a line, never a pattern, up to 200 characters", () => {
    expect(checked({ steps: [{ ...kytyCheck().steps[0], expect: "a[(+" }] }).errors).toEqual([]);
    expect(checkErrs({ steps: [{ ...kytyCheck().steps[0], expect: "x".repeat(201) }] })).toContain("check.steps[0].expect: up to 200 characters");
    expect(checkErrs({ steps: [{ ...kytyCheck().steps[0], expect: "  " }] })).toContain("check.steps[0].expect: the text one line of the output contains");
  });
  test("at most 6 steps of up to 30 minutes, each saying what it shows, needing only what the server can have", () => {
    const step = kytyCheck().steps[0];
    expect(checkErrs({ steps: Array.from({ length: 7 }, () => step) })).toContain("check.steps: at most 6");
    expect(checkErrs({ steps: [{ ...step, run: { ...step.run, timeoutSec: 1801 } }] })).toContain("check.steps[0].run.timeoutSec: whole seconds, 1 to 1800");
    expect(checkErrs({ steps: [{ ...step, what: "" }] })).toContain("check.steps[0].what: what the step shows");
    expect(checkErrs({ steps: [{ ...step, needs: ["gpu"] }] })).toContain(`check.steps[0].needs: "gpu" is not one of avx2, x86-64-v2, x86-64-v3, wine, gl, vulkan`);
    expect(checkErrs({ steps: [{ ...step, run: { ...step.run, argv: ["{install}"] } }] })).toContain("check.steps[0].run.argv[0]: {install} is not a placeholder here ({stage}, {content}, {work})");
    expect(checkErrs({ steps: [{ ...step, run: { tool: "bin/check", argv: [], wine: false, timeoutSec: 10 } }] })).toContain("check.steps[0].run.tool: must be one of tools.outputs");
    expect(checkErrs({ steps: [{ run: step.run }] })).toContain("check.steps[0].what");
    expect(checkErrs({ steps: ["kyty --check"] })).toContain("check.steps[0]: must be {run, what, expect?, needs?}");
  });
  test("{content} needs a content plan", () => {
    const p = zelda(); p.content = null; p.files = []; p.keep = [];
    p.check = { steps: [{ run: { exe: "Zelda64Recompiled.exe", argv: ["--check", "{content}"], wine: true, timeoutSec: 60 }, what: "it opens the ROM" }] };
    expect(errs(validatePlanSpec(p, "port"))).toContain("check.steps[0].run.argv: {content} needs a content plan");
  });
  test("a smoke start of 1 to 60 seconds says what the program draws with", () => {
    expect(checkErrs({ smoke: { seconds: 0, needs: "gl" } })).toContain("check.smoke.seconds: whole seconds, 1 to 60");
    expect(checkErrs({ smoke: { seconds: 61, needs: "gl" } })).toContain("1 to 60");
    expect(checkErrs({ smoke: { seconds: 10, needs: "metal" } })).toContain("check.smoke.needs: nothing, gl, vulkan or d3d12");
    expect(checkErrs({ smoke: { seconds: 10 } })).toContain("check.smoke.needs");
    expect(checkErrs({ smoke: { seconds: 10, needs: "gl", title: "x".repeat(201) } })).toContain("check.smoke.title: text up to 200 characters");
  });
  test("an empty check checks nothing", () => {
    expect(checkErrs({ steps: [] })).toContain("check: at least one step or a smoke start (an empty check checks nothing)");
    expect(checkErrs("run it")).toContain("check: {steps, smoke?}");
    expect(checked(null).errors).toEqual([]);
    expect(checked(null).value!.check).toBeUndefined();
  });
});

describe("a game file that is not shipped needs something on the server that uses it", () => {
  test("a setup step with {content}, a source build that reads it, or a per-game build", () => {
    const p = zelda(); p.content.ship = false;
    expect(errs(validatePlanSpec(p, "port"))).toContain("content.ship: false means the file is used on the server and not shipped, but nothing uses it");
    const src = zelda(); src.content.ship = false; src.program = { kind: "source", ref: "main", steps: ["make BASEROM={content}"], artifact: "build/pc", content: "build" };
    expect(validatePlanSpec(src, "port").errors).toEqual([]);
    // a source build that does not read the file does not use it
    src.program = { kind: "source", ref: "main", steps: ["make"], artifact: "build/pc", content: "none" };
    expect(errs(validatePlanSpec(src, "port"))).toContain("content.ship: false means the file is used on the server");
    expect(validatePlanSpec(nx2naviOnServer(), "recomp").errors).toEqual([]);
  });
});

describe("way overrides: a way's own check and setup steps", () => {
  const spec = () => validatePlanSpec(kytyPlan(), "emulator").value as RuntimePlanSpec;
  test("checked like the plan's", () => {
    const check = { steps: [{ run: { exe: "kyty.exe", argv: ["--check", "{content}"], wine: true, timeoutSec: 300 }, what: "it opens the game" }] };
    const setup = [{ ini: { path: "launcher-settings.ini", section: "game", key: "path", value: "game" } }, { run: { exe: "kyty.exe", argv: ["--seed", "{stage}"], wine: true, timeoutSec: 60 } }];
    const r = validateWayOverrides({ check, setup }, spec());
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ check, setup } as any);
    expect(validateWayOverrides({ check: { steps: [{ ...check.steps[0], run: { ...check.steps[0].run, timeoutSec: 4000 } }] } }, spec()).errors.join(" ")).toContain("overrides.check.steps[0].run.timeoutSec: whole seconds, 1 to 1800");
    expect(validateWayOverrides({ setup: [{ run: { exe: "a.exe", tool: "b", argv: [], wine: true, timeoutSec: 5 } }] }, spec()).errors.join(" ")).toContain("overrides.setup[0].run: exactly one of exe and tool");
    expect(validateWayOverrides({ setup: "kyty --seed" }, spec()).errors.join(" ")).toContain("overrides.setup: a list of steps");
    expect(validateWayOverrides("all", spec()).errors).toEqual(["overrides: {files?, argvExtra?, env?, check?, setup?}"]);
  });
});

describe("decisions kept on the plan", () => {
  const decided = (decisions: unknown) => validatePlanSpec({ ...nx2navi(), decisions }, "recomp");
  test("when, what, what came of it, and who decided", () => {
    const d = [{ at: 1762600000, what: "server-build", outcome: "kept on players' PCs: the kit needs the player's GPU to compile", by: "ai" }];
    expect(decided(d).value!.decisions).toEqual(d as any);
    expect(decided([]).value!.decisions).toBeUndefined();
  });
  test("at most 20, each part checked", () => {
    const d = { at: 1, what: "widen", outcome: "added PPSA01340", by: "admin" };
    expect(errs(decided(Array.from({ length: 21 }, () => d)))).toContain("decisions: at most 20");
    expect(errs(decided([{ ...d, what: "other" }]))).toContain("decisions[0].what: server-build, upgrade, widen or game");
    expect(errs(decided([{ ...d, by: "user" }]))).toContain("decisions[0].by: ai or admin");
    expect(errs(decided([{ ...d, outcome: "" }]))).toContain("decisions[0].outcome: what was decided");
    expect(errs(decided([{ ...d, at: -1 }]))).toContain("decisions[0].at: when, in whole seconds since 1970");
    expect(errs(decided("none"))).toContain("decisions: a list of {at, what, outcome, by}");
  });
});

describe("what a new content plan accepts that the old one did not", () => {
  const widened = (accept: Record<string, unknown>) => valueOf({ ...kytyWay(), accept: { ...kytyWay().accept, ...accept } });
  test("the Kyty way widened to the editions its code names: without evidence each new serial is a problem, with demonsSouls.h none", () => {
    const prev = valueOf(kytyWay());
    const next = widened({ serials: [...DEMONS_SOULS], versions: [...VERSIONS] });
    // the versions only narrow what the way took (it took any version): they need no evidence
    expect(acceptChanges(prev, next)).toEqual([{ field: "accept.serials", added: ["PPSA01340", "PPSA01342"], emptied: false }]);
    expect(evidenceProblems(prev, next)).toEqual([
      "accept.serials: PPSA01340 was added without evidence — cite the repo file and lines that name it",
      "accept.serials: PPSA01342 was added without evidence — cite the repo file and lines that name it",
    ]);
    expect(evidenceProblems(prev, widened({ serials: [...DEMONS_SOULS], versions: [...VERSIONS], evidence: [demonsSoulsH()] }))).toEqual([]);
    // evidence that names other values does not count
    expect(evidenceProblems(prev, widened({ serials: [...DEMONS_SOULS], evidence: [demonsSoulsH(["PPSA01340"])] }))).toEqual(["accept.serials: PPSA01342 was added without evidence — cite the repo file and lines that name it"]);
  });

  test("the upgraded Kyty way: what its new make's input takes beyond what the way took needs evidence too", () => {
    const prev = valueOf(kytyWay());
    const bare = valueOf({ ...kytyUpgraded(), accept: { ...kytyUpgraded().accept, evidence: undefined } });
    // the way took PPSA01341 at any version: the input's two other editions are new, its versions only narrow
    expect(acceptChanges(prev, bare)).toEqual([
      { field: "accept.serials", added: ["PPSA01340", "PPSA01342"], emptied: false },
      { field: "make.input.serials", added: ["PPSA01340", "PPSA01342"], emptied: false },
    ]);
    expect(evidenceProblems(prev, bare)).toEqual([
      "accept.serials: PPSA01340 was added without evidence — cite the repo file and lines that name it",
      "accept.serials: PPSA01342 was added without evidence — cite the repo file and lines that name it",
      "make.input.serials: PPSA01340 was added without evidence — cite the repo file and lines that name it",
      "make.input.serials: PPSA01342 was added without evidence — cite the repo file and lines that name it",
    ]);
    expect(evidenceProblems(prev, valueOf(kytyUpgraded()))).toEqual([]);
    // a way that took one version: a new make whose input takes another needs evidence for it
    const oneVersion = valueOf({ ...kytyWay(), accept: { ...kytyWay().accept, versions: ["01.007.000"] } });
    expect(acceptChanges(oneVersion, bare)).toContainEqual({ field: "make.input.versions", added: ["01.005.000"], emptied: false });
    // an input that names only what the way took, or leaves a list out (the product is still judged by the way's own), adds nothing
    const same = valueOf({ ...kytyWay(), place: "game/{name}", make: { ...kytyMake(), input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", serials: ["PPSA01341"] } } });
    expect(acceptChanges(prev, same)).toEqual([]);
    const loose = valueOf({ ...kytyWay(), place: "game/{name}", make: { ...kytyMake(), input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json" } } });
    expect(acceptChanges(prev, loose)).toEqual([]);
    // a new make that takes archives: its formats are new forms, which no program's code names, so they need no evidence
    const archived = valueOf({ ...kytyWay(), place: "game/{name}", make: { ...kytyMake(), input: { shape: "either", platform: "ps5", formats: ["rar", "7z"], marker: "sce_sys/param.json", serials: ["PPSA01341"] } } });
    expect(acceptChanges(prev, archived)).toEqual([{ field: "make.input.formats", added: ["rar", "7z"], emptied: false }]);
    expect(evidenceProblems(prev, archived)).toEqual([]);
  });

  test("versions added to a list that had some need evidence, compared by number", () => {
    const prev = widened({ versions: ["01.007.000"] });
    const next = widened({ versions: ["1.07", "01.005.000"] });
    expect(acceptChanges(prev, next)).toEqual([{ field: "accept.versions", added: ["01.005.000"], emptied: false }]);
    expect(evidenceProblems(prev, next)).toEqual(["accept.versions: 01.005.000 was added without evidence — cite the repo file and lines that name it"]);
    expect(evidenceProblems(prev, widened({ versions: ["1.07", "01.005.000"], evidence: [demonsSoulsH(["1.05"])] }))).toEqual([]);
  });

  test("an emptied serial list accepts any serial: always a problem, whatever is cited", () => {
    const prev = valueOf(kytyWay());
    const next = widened({ serials: [], evidence: [demonsSoulsH()] });
    expect(acceptChanges(prev, next)).toEqual([{ field: "accept.serials", added: [], emptied: true }]);
    expect(evidenceProblems(prev, next)).toEqual(["accept.serials: accepting any serial needs the admin: ask with a choice"]);
    const gone = valueOf({ ...kytyWay(), accept: { hashes: [], formats: ["zar"] } });
    expect(evidenceProblems(prev, gone)).toEqual(["accept.serials: accepting any serial needs the admin: ask with a choice"]);
  });

  test("formats, regions, hashes in another algorithm, a shorter build prefix and the category widen too", () => {
    const prev = widened({ regions: ["EU"], builds: ["e0f3ccfa12"], hashes: [{ algo: "sha1", value: "a".repeat(40) }] });
    const next = widened({ formats: ["zar", "iso"], regions: ["Europe", "USA"], builds: ["e0f3ccfa"], hashes: [{ algo: "sha1", value: "a".repeat(40) }, { algo: "md5", value: "b".repeat(32) }], category: "patch" });
    expect(acceptChanges(prev, next)).toEqual([
      { field: "accept.builds", added: ["e0f3ccfa"], emptied: false },
      { field: "accept.hashes", added: ["b".repeat(32)], emptied: false },
      { field: "accept.regions", added: ["US"], emptied: false },
      { field: "accept.formats", added: ["iso"], emptied: false },
      { field: "accept.category", added: ["patch"], emptied: false },
    ]);
    // a longer build id under an accepted prefix, fewer serials, the same serial spelled otherwise: only narrower
    expect(acceptChanges(widened({ builds: ["e0f3ccfa"] }), widened({ builds: ["e0f3ccfa1234"] }))).toEqual([]);
    expect(acceptChanges(widened({ serials: [...DEMONS_SOULS] }), widened({ serials: ["PPSA01341"] }))).toEqual([]);
    expect(acceptChanges(valueOf(kytyWay()), widened({ serials: ["ppsa-01341"] }))).toEqual([]);
    expect(acceptChanges(valueOf(kytyWay()), valueOf(kytyWay()))).toEqual([]);
  });

  test("a make's input that takes more forms (folder → either) or more serials is a widening", () => {
    const prev = valueOf(kytyUpgraded());
    const either = valueOf({ ...kytyUpgraded(), make: { ...kytyMake(), input: { ...kytyMake().input, shape: "either", formats: ["rar", "7z"] } } });
    expect(acceptChanges(prev, either)).toEqual([{ field: "make.input.shape", added: ["file"], emptied: false }]);
    // a form ludarr's own archiver opens: the input is still judged by its data before any step, so no evidence is asked
    expect(evidenceProblems(prev, either)).toEqual([]);
    const zip = valueOf({ ...kytyUpgraded(), make: { ...kytyMake(), input: { ...kytyMake().input, shape: "either", formats: ["rar", "7z", "zip"] } } });
    expect(acceptChanges(either, zip)).toEqual([{ field: "make.input.formats", added: ["zip"], emptied: false }]);
    expect(evidenceProblems(either, zip)).toEqual([]);
    // back to the folder alone only narrows: a folder has no formats to empty
    expect(acceptChanges(either, prev)).toEqual([]);
    const more = valueOf({ ...kytyUpgraded(), make: { ...kytyMake(), input: { ...kytyMake().input, serials: [...DEMONS_SOULS, "PPSA01339"] } } });
    expect(acceptChanges(prev, more)).toEqual([{ field: "make.input.serials", added: ["PPSA01339"], emptied: false }]);
    const any = valueOf({ ...kytyUpgraded(), make: { ...kytyMake(), input: { ...kytyMake().input, versions: undefined } } });
    expect(evidenceProblems(prev, any)).toEqual(["make.input.versions: accepting any version needs the admin: ask with a choice"]);
  });

  test("a fresh plan: every value it lists is new", () => {
    const z = validatePlanSpec(zelda(), "recomp").value!.content!;
    expect(acceptChanges(null, z)).toEqual([
      { field: "accept.hashes", added: ["ef18b4a9e2386169", "d6133ace5afaa0882cf214cf88daba39e266c078"], emptied: false },
      { field: "accept.formats", added: ["z64", "n64", "v64"], emptied: false },
    ]);
    expect(evidenceProblems(null, z).length).toBe(5);
  });

  test("a weaker check that the data is the whole game always needs the admin: an update or a part would pass", () => {
    const prev = valueOf(kytyUpgraded());
    const input = (complete: unknown) => valueOf({ ...kytyUpgraded(), make: { ...kytyMake(), input: { ...kytyMake().input, complete } } });
    const gone = valueOf({ ...kytyUpgraded(), make: { ...kytyMake(), input: { ...kytyMake().input, complete: undefined } } });
    expect(acceptChanges(prev, gone)).toEqual([{ field: "make.input.complete", added: [], emptied: true }]);
    expect(evidenceProblems(prev, gone)).toEqual(["make.input.complete: the check that the data is the whole game was removed, so an update or a part of the game would pass: that needs the admin: ask with a choice"]);
    const fewer = input({ minFiles: 1000, list: { path: "files-PPSA01341_01.007.000.files", share: 0.5 } });
    expect(acceptChanges(prev, fewer)).toEqual([{ field: "make.input.complete", added: ["minFiles 90000 → 1000", "list share 0.98 → 0.5"], emptied: false }]);
    expect(evidenceProblems(prev, { ...fewer, accept: { ...fewer.accept, evidence: [demonsSoulsH(["minFiles 90000 → 1000"]) as any] } })[0]).toContain("is weaker (minFiles 90000 → 1000, list share 0.98 → 0.5)");
    expect(acceptChanges(prev, input({ minFiles: 90000 }))).toEqual([{ field: "make.input.complete", added: ["no file list (was files-PPSA01341_01.007.000.files)"], emptied: false }]);
    // a stricter check, or another list, is no widening
    expect(acceptChanges(prev, input({ minFiles: 95000, minBytes: 70e9, list: { path: "files-PPSA01341_01.005.000.files" } }))).toEqual([]);
    // a game folder's own check
    const folder = (complete?: unknown) => valueOf({ kind: "folder", platform: "ps5", what: "x", search: ["x"], marker: "sce_sys/param.json", accept: { hashes: [], serials: ["PPSA01341"] }, place: "app0", ...(complete ? { complete } : {}) });
    expect(acceptChanges(folder({ minBytes: 70e9 }), folder())).toEqual([{ field: "complete", added: [], emptied: true }]);
    expect(acceptChanges(folder(), folder({ minBytes: 70e9 }))).toEqual([]);
    // the folder made into one packed file keeps its check on the make that packs it
    expect(acceptChanges(folder({ minFiles: 90000 }), valueOf(kytyUpgraded())).filter(c => c.field === "complete")).toEqual([]);
  });

  test("a value is cited as the repo writes it: a region by any spelling, a format with its dot, a version by number", () => {
    const prev = widened({ regions: ["EU"], versions: ["01.007.000"] });
    const next = widened({ regions: ["EU", "US"], versions: ["01.007.000", "1.05"], formats: ["zar", "iso"], evidence: [demonsSoulsH(["USA", ".iso", "01.005.000"])] });
    expect(acceptChanges(prev, next).map(c => c.field)).toEqual(["accept.versions", "accept.regions", "accept.formats"]);
    expect(evidenceProblems(prev, next)).toEqual([]);
    expect(evidenceProblems(prev, { ...next, accept: { ...next.accept, evidence: [demonsSoulsH(["Japan", "zip", "1.07"]) as any] } })).toEqual([
      "accept.versions: 1.05 was added without evidence — cite the repo file and lines that name it",
      "accept.regions: US was added without evidence — cite the repo file and lines that name it",
      "accept.formats: iso was added without evidence — cite the repo file and lines that name it",
    ]);
  });

  test("a game folder has no formats: becoming one says nothing of them; an old plan without accept is read as accepting nothing new", () => {
    const folder = valueOf({ kind: "folder", platform: "ps5", what: "x", search: ["x"], marker: "sce_sys/param.json", accept: { hashes: [], serials: ["PPSA01341"] }, place: "app0" });
    expect(acceptChanges(valueOf(kytyWay()), folder)).toEqual([]);
    expect(acceptChanges({ kind: "disc", platform: "ps5" } as unknown as ContentPlan, valueOf(kytyWay()))).toEqual([]);
  });
});

describe("a recomp or port proves its file", () => {
  test("by a hash, a serial or a build id; an emulator never has to", () => {
    expect(provingProblem(nx2navi(), "recomp")).toContain("content.accept: nothing proves the game file");
    expect(provingProblem(nx2navi(), "port")).not.toBeNull();
    expect(provingProblem(validatePlanSpec(nx2naviOnServer(), "recomp").value!, "recomp")).toBeNull();
    expect(provingProblem({ content: { ...nx2navi().content, accept: { hashes: [], formats: ["nup"], builds: ["e0f3ccfa"] } } }, "recomp")).toBeNull();
    expect(provingProblem(zelda(), "recomp")).toBeNull();
    expect(provingProblem(kytyPlan(), "emulator")).toBeNull();
    expect(provingProblem({ content: null }, "port")).toBeNull();
  });
});

describe("a plan that makes the game on the player's PC", () => {
  test("NX2navi's first start builds it there", () => {
    expect(firstRunOnPlayersPc(nx2navi())).toBe(`firstRun says the game is made on the player's PC: "On the first start NX2navi builds the game from the .nup on the player's PC (10 to 25 minutes, about 175 MB of tools downloaded)."`);
  });
  test("a first start that only compiles shaders, says nothing is built, or names the server is no such plan", () => {
    expect(firstRunOnPlayersPc(zelda())).toBeNull();
    expect(firstRunOnPlayersPc(kytyPlan())).toBeNull();
    expect(firstRunOnPlayersPc({ firstRun: "Nothing is built on the player's PC: the game starts at once.", notes: "" })).toBeNull();
    expect(firstRunOnPlayersPc({ firstRun: "The game is never compiled locally.", notes: "" })).toBeNull();
    expect(firstRunOnPlayersPc({ firstRun: "It was built on the server, so it starts straight away.", notes: "" })).toBeNull();
    expect(firstRunOnPlayersPc({ firstRun: null, notes: "" })).toBeNull();
  });
  test("a first start that fetches build tools counts; notes count only when they say it happens on the player's PC", () => {
    expect(firstRunOnPlayersPc({ firstRun: "Downloads the MSYS2 toolchain, then shows the menu.", notes: "" })).toContain("firstRun says");
    expect(firstRunOnPlayersPc({ firstRun: null, notes: "The port is recompiled on the player's PC at the first start." })).toContain(`notes says the game is made on the player's PC: "The port is recompiled`);
    expect(firstRunOnPlayersPc({ firstRun: null, notes: "Built from source with CMake. The artifact is the install folder." })).toBeNull();
  });
  test("shaders are no game: a verb whose object is the shaders does not count, another verb in the same sentence does", () => {
    expect(firstRunOnPlayersPc({ firstRun: "Shaders are compiled on the first start.", notes: "" })).toBeNull();
    expect(firstRunOnPlayersPc({ firstRun: "It builds the shader cache once (about a minute).", notes: "" })).toBeNull();
    expect(firstRunOnPlayersPc({ firstRun: "Builds the game (10-25 min) and its shaders on the first start.", notes: "" })).toContain("firstRun says");
    expect(firstRunOnPlayersPc({ firstRun: "Compiles its shaders, then builds the game from the dump.", notes: "" })).toContain("firstRun says");
    expect(firstRunOnPlayersPc({ firstRun: "Builds the game on your PC … 10 to 25 minutes, once", notes: "" })).toContain("firstRun says");
  });
});

describe("versions compared by number", () => {
  test("leading zeros and trailing zero parts do not count", () => {
    expect(versionKey("01.007.000")).toBe("1.7");
    expect(versionKey("1.07")).toBe("1.7");
    expect(versionKey("1.7")).toBe("1.7");
    expect(versionKey("1.70")).toBe("1.70");
    expect(versionKey("0")).toBe("0");
    expect(versionKey("01.005.000")).toBe(versionKey("1.05"));
  });
});
