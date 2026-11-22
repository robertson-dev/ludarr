/**
 * Carry runs as the engine sends them (src/ways/types.ts RunView, RunAsk, RunStep, CopyView, CheckReport), for the admin
 * UI's tests (tests/web-logic.test.ts, tests/web-render.test.ts): the three live cases of 2026-11-08 and the other states a
 * run can be in. Every time is relative to `now` (seconds), so the words the pages say about them can be held exactly.
 */
import type { CheckReport, ContentFile, ContentPlan, CopyView, JobView, RunAsk, RunView, Way } from "../web/src/api";

export const KYTY = "KytyPS5 (chenxiao07 Demon's Souls fork)";
export const DS_SHARE = "\\\\tower\\games\\ahoy\\.ahoy-inbox\\demons-souls";
export const DS_INBOX = "/library/.ahoy-inbox/demons-souls";
export const OOT_SHARE = "\\\\tower\\games\\ahoy\\.ahoy-inbox\\the-legend-of-zelda-ocarina-of-time";
export const OOT_INBOX = "/library/.ahoy-inbox/the-legend-of-zelda-ocarina-of-time";
export const DS_ISO = 54_234_005_504;

/** a local time of the day `now` falls on (or of a day after it) */
export function localAt(now: number, h: number, m: number, days = 0): number {
  const d = new Date(now * 1000);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, m).getTime() / 1000);
}

export function runSamples(now: number) {
  const ago = (min: number) => Math.round(now - min * 60);
  const ask = (a: Partial<RunAsk> & Pick<RunAsk, "code" | "title" | "need">): RunAsk => ({
    tried: [], accept: null, inbox: null, inboxShare: null, canUpload: false, choices: [], heldContentId: null, watching: null, askedAt: ago(95), byAi: null, ...a,
  });
  const run = (r: Partial<RunView> & Pick<RunView, "id" | "planId" | "planName" | "phase" | "state" | "rail">): RunView => ({
    gameId: null, gameName: null, wayId: null, now: null, ask: null, steps: [], budget: { rounds: 3, roundsUsed: 0, tokens: 8_000_000, tokensUsed: 0 },
    nextAt: null, startedBy: "backfill", createdAt: ago(130), updatedAt: ago(1), doneAt: null, ...r,
  });

  /* ─────────── Demon's Souls through KytyPS5: the copy is the sealed retail disc, the run asks for the game folder ─────────── */
  const dsCopy: CopyView = {
    packageId: 7, name: "bbb-ps5-01342.iso", size: DS_ISO, shape: "file",
    identity: { platform: "ps5", serial: "PPSA01342", region: "US", masterVersion: "01.00", category: "game", shape: "bd-image", sealed: true },
    serves: "no", why: "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it",
  };
  const dsAsk = ask({
    code: "file", title: "Demon's Souls needs its game data",
    need: `${KYTY} plays Demon's Souls at 1.05 or 1.07. It takes the game folder dumped from a console (holding sce_sys/param.json and eboot.bin), or that folder packed as one .zar, of Demon's Souls (PlayStation 5) — PPSA01341, PPSA01342 or PPSA01340, version 01.005.000 or 01.007.000. Put it in ${DS_SHARE}, or pick it on the server: ludarr takes it from there and finishes by itself. (The folder starts with a dot, so Windows may hide it: type the path in Explorer's address bar.)`,
    tried: [
      "The copy on the server (bbb-ps5-01342.iso, 54.2 GB) is the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it.",
      "The file kept beside it (bbb-ps5-01342.iso) is the same disc: not used.",
      "The indexers have nothing it can use yet (14 releases looked at; a \"Full ISO\" release holds the game encrypted). Looking again at 18:40.",
    ],
    accept: { platform: "ps5", shape: "either", formats: ["zar"], serials: ["PPSA01341", "PPSA01342", "PPSA01340"], versions: ["01.005.000", "01.007.000"] },
    inbox: DS_INBOX, inboxShare: DS_SHARE, canUpload: false,
    watching: { nextSearchAt: localAt(now, 18, 40), inbox: true, every: "2 minutes" },
  });
  const dsSteps: RunView["steps"] = [
    { at: ago(130), phase: "plan", who: "ludarr", text: "the plan is ready: KytyPS5 v20261108", outcome: "ok" },
    { at: ago(130), phase: "game", who: "ludarr", text: "the way to play exists: Demon's Souls through KytyPS5", outcome: "ok" },
    { at: ago(129), phase: "file", who: "ludarr", text: `the game's copy on the server (bbb-ps5-01342.iso, 54.2 GB) is ${dsCopy.why}`, outcome: "refused", proof: "bd/param.json: masterDataId PPSA01342, masterVersion 01.00 · app/PPSA01342/app_0.pkg, and no eboot.bin or sce_sys at the root" },
    { at: ago(129), phase: "file", who: "ludarr", text: "the file kept beside it (bbb-ps5-01342.iso) is the same disc: not used", outcome: "refused", contentId: 1 },
    { at: ago(124), phase: "file", who: "ai", text: "round 1 of 3 (upgrade): the game file is now made from the game folder with ZArchive, and the plan also takes PPSA01340 and PPSA01342 at 01.005.000 and 01.007.000", outcome: "ok", jobId: 61, proof: "chenxiao07/KytyPS5@65ed19d9 src/graphics/host_gpu/renderer/demonsSouls.h:13-26" },
    { at: ago(118), phase: "file", who: "ludarr", text: "searching the indexers for Demon's Souls (PlayStation 5)", outcome: "waiting", requestId: 9 },
    { at: ago(97), phase: "file", who: "ludarr", text: "14 releases looked at: the copy's own release skipped, a \"Full ISO\" release refused before download; nothing it can use", outcome: "refused", requestId: 9 },
    { at: ago(95), phase: "file", who: "ludarr", text: "asked you for the game folder; it keeps watching the inbox and the indexers", outcome: "asked" },
  ];
  const dsRail = (file: RunView["rail"][number]): RunView["rail"] => [
    { phase: "plan", state: "done", summary: "ready (v20261108)" },
    { phase: "game", state: "done", summary: "the way to play exists" },
    file,
    { phase: "build", state: "todo", summary: null },
    { phase: "check", state: "todo", summary: null },
  ];
  const ds = run({
    id: 11, planId: 3, planName: KYTY, gameId: 21, gameName: "Demon's Souls", wayId: 1, phase: "file", state: "asking",
    rail: dsRail({ phase: "file", state: "asked", summary: "needs the game folder dumped from a console" }),
    ask: dsAsk, steps: dsSteps, budget: { rounds: 3, roundsUsed: 1, tokens: 8_000_000, tokensUsed: 412_000 }, nextAt: Math.round(now + 120),
  });
  /** the same run once a dump landed in the inbox: the game file is being made, 41 % in */
  const dsMake = run({
    ...ds, id: 12, state: "waiting", ask: null, nextAt: null,
    rail: dsRail({ phase: "file", state: "active", summary: "making it from the game folder that landed in the inbox" }),
    now: { text: "making the game file from the game folder that landed in the inbox", progress: 0.41, jobId: 70, requestId: null },
    steps: [
      ...dsSteps,
      { at: ago(40), phase: "file", who: "ludarr", text: "the inbox took PPSA01341-app0 (a folder, 83.1 GB in 117,206 files)", outcome: "ok", contentId: 14 },
      { at: ago(39), phase: "file", who: "ludarr", text: "PPSA01341-app0 reads as Demon's Souls PPSA01341 01.007.000, the whole game", outcome: "ok", proof: "sce_sys/param.json: titleId PPSA01341, contentVersion 01.007.000 · 98,368 of the 98,368 files on the program's list are there" },
      { at: ago(38), phase: "file", who: "ludarr", text: "making the game file: the packer (Exzap/ZArchive@d2c71773) is built and checked", outcome: "ok", jobId: 70 },
      { at: ago(37), phase: "file", who: "ludarr", text: "packing PPSA01341-app0 into PPSA01341-app0.zar", outcome: "waiting", jobId: 70 },
    ],
  });
  const makeJob: JobView = {
    id: 70, requestId: null, fetchId: null, gameId: 21, inputPath: "make:way:1", outputPath: null, state: "running", tier: "deterministic", progress: 0.41,
    message: "packing the game folder · 22.1 of 54.2 GB", manifest: null, createdAt: ago(38), updatedAt: ago(0), doneAt: null,
    kind: "make", spec: { kind: "make", wayId: 1, from: "kept", contentId: 14, then: "assemble", auto: true, runId: 12 }, runId: 12,
  };

  /* ─────────── Majora's Mask through Zelda 64: Recompiled: done, its smoke start could not run here ─────────── */
  const mmCheck: CheckReport = {
    verdict: "env", steps: [],
    smoke: {
      verdict: "env", alive: false, exitCode: 1, titles: ["Zelda 64: Recompiled"], screenshot: "check-80-1.png",
      outputTail: "RT64: vkCreateInstance failed: VK_ERROR_INCOMPATIBLE_DRIVER\nRT64: no D3D12 device either (DXGI_ERROR_UNSUPPORTED)", why: "the server has no graphics device",
    },
    text: "not started here: the server has no graphics device",
  };
  const mm = run({
    id: 13, planId: 1, planName: "Zelda 64: Recompiled", gameId: 50, gameName: "The Legend of Zelda: Majora's Mask", wayId: 5, phase: "done", state: "done",
    rail: [
      { phase: "plan", state: "done", summary: "ready (v1.2.2)" },
      { phase: "game", state: "done", summary: "added from IGDB (Nintendo 64, 2000)" },
      { phase: "file", state: "done", summary: "proven by its sha1 (No-Intro, USA)" },
      { phase: "build", state: "done", summary: "built: 44 files, 67 MB" },
      { phase: "check", state: "env", summary: "not started here: the server has no graphics device" },
    ],
    steps: [
      { at: ago(300), phase: "game", who: "admin", text: "you said go ahead", outcome: "ok" },
      { at: ago(299), phase: "game", who: "ludarr", text: "added The Legend of Zelda: Majora's Mask (Nintendo 64, 2000) from IGDB, and its way to play", outcome: "ok" },
      { at: ago(298), phase: "file", who: "ludarr", text: "searching the indexers for The Legend of Zelda: Majora's Mask (Nintendo 64)", outcome: "waiting", requestId: 12 },
      { at: ago(250), phase: "file", who: "ludarr", text: "Legend of Zelda, The - Majora's Mask (USA).z64 is the game file: its sha1 is the one the plan takes", outcome: "ok", contentId: 20, proof: "sha1 d6133ace5afaa0882cf214cf88daba39e266c078 (No-Intro: USA)" },
      { at: ago(248), phase: "build", who: "ludarr", text: "built the way to play: 44 files, 67 MB", outcome: "ok", jobId: 80 },
      { at: ago(247), phase: "check", who: "ludarr", text: "the check: not started here, the server has no graphics device (that proves nothing either way)", outcome: "env", jobId: 80 },
      { at: ago(247), phase: "done", who: "ludarr", text: "playable: members can install it from Ahoy", outcome: "ok" },
    ],
    budget: { rounds: 3, roundsUsed: 0, tokens: 8_000_000, tokensUsed: 0 }, startedBy: "backfill", doneAt: ago(247),
  });
  const assembleJob: JobView = {
    id: 80, requestId: null, fetchId: null, gameId: 50, inputPath: "way:5", outputPath: "/library/.ahoy-packages/majoras-mask", state: "done", tier: "deterministic", progress: 1,
    message: "built: 44 files, 67 MB · not started here: the server has no graphics device", manifest: null, createdAt: ago(249), updatedAt: ago(247), doneAt: ago(247),
    kind: "assemble", spec: { kind: "assemble", wayId: 5, auto: true, runId: 13 }, runId: 13, trace: [{ turn: 0, t: 61, kind: "check", report: mmCheck }],
    transcript: "placing the game file (linked)\nchecking: smoke start under wine (needs vulkan)\nnot started here: the server has no graphics device",
  };

  /* ─────────── Ocarina of Time (Switch 2) through NX2navi: its game data only comes from the owner's console ─────────── */
  const nxRail = (file: RunView["rail"][number], build: RunView["rail"][number]): RunView["rail"] => [
    { phase: "plan", state: "done", summary: "the build moved to the server (round 1)" },
    { phase: "game", state: "done", summary: "plays The Legend of Zelda: Ocarina of Time (Switch 2)" },
    file, build,
    { phase: "check", state: "todo", summary: null },
  ];
  const nxSteps: RunView["steps"] = [
    { at: ago(200), phase: "plan", who: "ludarr", text: "the plan builds the game on players' PCs: the AI moves that to the server", outcome: "waiting" },
    { at: ago(180), phase: "plan", who: "ai", text: "round 1 of 3 (server-build): the game is built on the server from NX2navi-app-0.5.0.zip with 31 pinned MSYS2 packages under wine, for x86-64-v3; the check is ocarina.exe --selftest", outcome: "ok", jobId: 63, proof: "NX2navi/NX2navi@0.5.0 toolchain.lock.json" },
    { at: ago(179), phase: "game", who: "ludarr", text: "plays The Legend of Zelda: Ocarina of Time (Switch 2, game 48): way added", outcome: "ok" },
  ];
  const nx = run({
    id: 14, planId: 2, planName: "NX2navi", gameId: 48, gameName: "The Legend of Zelda: Ocarina of Time", wayId: 4, phase: "file", state: "asking",
    rail: nxRail({ phase: "file", state: "asked", summary: "needs a .nup made on the owner's console" }, { phase: "build", state: "todo", summary: null }),
    ask: ask({
      code: "file", title: "The Legend of Zelda: Ocarina of Time needs its game data",
      need: `NX2navi plays The Legend of Zelda: Ocarina of Time (Switch 2). It takes one .nup file of The Legend of Zelda: Ocarina of Time (Switch) — title 0400486024DEC000, build e0f3ccfa…, with the 1.1.1 update. It comes only from your own console: Eglantine on your Switch 2 dumps it. Put it in ${OOT_SHARE}, or pick it on the server: ludarr takes it from there and finishes by itself.`,
      tried: [
        "No copy of the game is on the server, and no file is kept for it.",
        "The indexers have nothing it can use yet (3 releases looked at; NSP releases hold the game sealed for the console). Looking again tomorrow at 06:10.",
      ],
      accept: { platform: "switch", shape: "file", formats: ["nup"], serials: ["0400486024DEC000"] },
      inbox: OOT_INBOX, inboxShare: OOT_SHARE, canUpload: false,
      watching: { nextSearchAt: localAt(now, 6, 10, 1), inbox: true, every: "2 minutes" }, askedAt: ago(178),
      byAi: "Only the owner's console can make the .nup: Eglantine on a Switch 2 dumps the base game and its 1.1.1 update into one file.",
    }),
    steps: [...nxSteps, { at: ago(178), phase: "file", who: "ludarr", text: "asked you for the .nup; it keeps watching the inbox and the indexers", outcome: "asked" }],
    budget: { rounds: 3, roundsUsed: 1, tokens: 8_000_000, tokensUsed: 1_930_000 },
  });
  /** the same run with its per-game build cancelled by the admin: on hold until Resume */
  const nxHeld = run({
    ...nx, id: 15, phase: "build", state: "held", ask: null,
    rail: nxRail({ phase: "file", state: "done", summary: "0400486024DEC000 v65536, build e0f3ccfa" }, { phase: "build", state: "active", summary: "building the game on the server" }),
    steps: [
      ...nxSteps,
      { at: ago(60), phase: "file", who: "ludarr", text: "the inbox took Ocarina.nup: title 0400486024DEC000 with its 1.1.1 update, build e0f3ccfa", outcome: "ok", contentId: 30 },
      { at: ago(58), phase: "build", who: "ludarr", text: "building the game for this way on the server (step 1 of 2: lifting the program)", outcome: "waiting", jobId: 75 },
      { at: ago(12), phase: "build", who: "admin", text: "you cancelled job 75 (building the game on the server): press Resume to carry on", outcome: "failed", jobId: 75 },
    ],
  });

  /* ─────────── Zelda 64: Recompiled with no game in the library: held for the go-ahead ─────────── */
  const zelda = run({
    id: 16, planId: 1, planName: "Zelda 64: Recompiled", phase: "game", state: "held",
    rail: [
      { phase: "plan", state: "done", summary: "ready (v1.2.2)" },
      { phase: "game", state: "asked", summary: "waiting for your go-ahead" },
      { phase: "file", state: "todo", summary: null }, { phase: "build", state: "todo", summary: null }, { phase: "check", state: "todo", summary: null },
    ],
    ask: ask({
      code: "go-ahead", title: "Make The Legend of Zelda: Majora's Mask playable?",
      need: "Should ludarr make The Legend of Zelda: Majora's Mask playable through Zelda 64: Recompiled? It adds the game to the library and looks for The Legend of Zelda: Majora's Mask (Nintendo 64), NTSC-U 1.0.",
      askedAt: ago(130),
    }),
    steps: [{ at: ago(130), phase: "game", who: "ludarr", text: "the game it plays is not in the library: it waits for your go-ahead before adding it", outcome: "asked" }],
  });

  /* ─────────── an emulator plan saved without a game: which one should it make playable? ─────────── */
  const pcsx2 = run({
    id: 17, planId: 5, planName: "PCSX2", phase: "game", state: "asking", startedBy: "construct", createdAt: ago(21),
    rail: [
      { phase: "plan", state: "done", summary: "ready (v2.2.0)" },
      { phase: "game", state: "asked", summary: "an emulator plays many games: which one?" },
      { phase: "file", state: "todo", summary: null }, { phase: "build", state: "todo", summary: null }, { phase: "check", state: "todo", summary: null },
    ],
    ask: ask({
      code: "choice", title: "Which game should PCSX2 make playable?",
      need: "PCSX2 plays PlayStation 2 games, and it was added without one. These games in the library have only a console dump, so it can make each of them playable.",
      choices: [
        { gameId: 30, name: "Shadow of the Colossus", year: 2005, platforms: ["ps2"] },
        { gameId: 31, name: "Okami", year: 2006, platforms: ["ps2"] },
        { gameId: 32, name: "Ico", year: 2001, platforms: ["ps2"] },
      ],
      askedAt: ago(20),
    }),
    steps: [{ at: ago(20), phase: "game", who: "ludarr", text: "an emulator plays many games: asked you which one", outcome: "asked" }],
  });

  /* ─────────── a recomp whose AI repairs are used up ─────────── */
  const sonic = run({
    id: 18, planId: 6, planName: "Unleashed Recompiled", gameId: 60, gameName: "Sonic Unleashed", wayId: 6, phase: "build", state: "asking", startedBy: "way",
    rail: [
      { phase: "plan", state: "done", summary: "ready (v1.0.3)" },
      { phase: "game", state: "done", summary: "the way to play exists" },
      { phase: "file", state: "done", summary: "the game's files are here" },
      { phase: "build", state: "failed", summary: "build step 2 failed (exit 1)" },
      { phase: "check", state: "todo", summary: null },
    ],
    ask: ask({
      code: "budget", title: "Sonic Unleashed: the AI's repairs are used up",
      need: "ludarr's AI tried 3 times to make Unleashed Recompiled work for Sonic Unleashed; the last try failed at the build: build step 2 failed (exit 1): XenonRecomp: unknown instruction at 0x82A4C1D0. It stops so it does not spend more: raise 'AI repairs per game' in Settings → General → Import, or change the plan. It tries once more by itself when the program has a new release.",
      askedAt: ago(600),
    }),
    steps: [
      { at: ago(700), phase: "build", who: "ai", text: "round 3 of 3 (build): the build now skips the shader cache step", outcome: "failed", jobId: 64 },
      { at: ago(600), phase: "build", who: "ludarr", text: "build step 2 failed (exit 1): XenonRecomp: unknown instruction at 0x82A4C1D0", outcome: "failed", jobId: 77 },
    ],
    budget: { rounds: 3, roundsUsed: 3, tokens: 8_000_000, tokensUsed: 6_940_000 },
  });

  /* ─────────── a port whose ROM can come by upload (no share path set) ─────────── */
  const sm64 = run({
    id: 19, planId: 8, planName: "sm64ex", gameId: 70, gameName: "Super Mario 64", wayId: 8, phase: "file", state: "asking", startedBy: "way",
    rail: [
      { phase: "plan", state: "done", summary: "built per game from source" },
      { phase: "game", state: "done", summary: "the way to play exists" },
      { phase: "file", state: "asked", summary: "needs the US ROM" },
      { phase: "build", state: "todo", summary: null }, { phase: "check", state: "todo", summary: null },
    ],
    ask: ask({
      code: "file", title: "Super Mario 64 needs its game data",
      need: "sm64ex builds Super Mario 64 from the US ROM. It takes one .z64 file of Super Mario 64 (Nintendo 64), proven by its sha1. Put it in /library/.ahoy-inbox/super-mario-64, pick it on the server, or upload it (files up to 16 GB): ludarr takes it from there and finishes by itself.",
      tried: ["No copy of the game is on the server, and no file is kept for it.", "The indexers have nothing it can use yet (6 releases looked at; none has the US ROM's sha1). Looking again at 18:40."],
      accept: { platform: "n64", shape: "file", formats: ["z64"] },
      inbox: "/library/.ahoy-inbox/super-mario-64", inboxShare: null, canUpload: true,
      watching: { nextSearchAt: localAt(now, 18, 40), inbox: true, every: "2 minutes" }, askedAt: ago(30),
    }),
    steps: [{ at: ago(30), phase: "file", who: "ludarr", text: "asked you for the US ROM; it keeps watching the inbox and the indexers", outcome: "asked" }],
  });

  /* ─────────── a file the indexers brought that nothing proves: accept it if it is ─────────── */
  const banjo = run({
    id: 20, planId: 9, planName: "BanjoRecomp", gameId: 71, gameName: "Banjo-Kazooie", wayId: 10, phase: "file", state: "asking", startedBy: "way",
    rail: [
      { phase: "plan", state: "done", summary: "ready (v0.9.1)" }, { phase: "game", state: "done", summary: "the way to play exists" },
      { phase: "file", state: "asked", summary: "a file nothing proves" }, { phase: "build", state: "todo", summary: null }, { phase: "check", state: "todo", summary: null },
    ],
    ask: ask({
      code: "held-file", title: "Is this Banjo-Kazooie's game file?",
      need: "Banjo-Kazooie (USA) (Rev 1).z64 came from the indexers, and nothing proves it is Banjo-Kazooie, NTSC-U 1.1 (its sha1 1c1f1f9b… is not the one the plan takes; the header says NBKE, revision 1). Accept it if it is.",
      heldContentId: 33, askedAt: ago(15),
    }),
    steps: [{ at: ago(15), phase: "file", who: "ludarr", text: "kept Banjo-Kazooie (USA) (Rev 1).z64 for a look: nothing proves it is the game", outcome: "asked", contentId: 33 }],
  });

  return { ds, dsMake, dsCopy, makeJob, mm, mmCheck, assembleJob, nx, nxHeld, zelda, pcsx2, sonic, sm64, banjo };
}

/** Demon's Souls' way as the way listing sends it, with its run and the game's copy */
export function dsWay(s: ReturnType<typeof runSamples>, over: Partial<Way> = {}): Way {
  const content: ContentPlan = {
    kind: "disc", platform: "ps5", what: "Demon's Souls", search: ["Demon's Souls"], place: "game/{name}",
    accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341", "PPSA01342", "PPSA01340"], versions: ["01.005.000", "01.007.000"] },
    make: {
      from: ["kept", "copy", "inbox", "indexer"],
      input: { shape: "either", platform: "ps5", formats: ["zip", "7z", "rar"], marker: "sce_sys/param.json", also: ["eboot.bin"] },
      steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, { convert: { with: "zarchive", argv: ["{prep}/app0", "{out}"], timeoutSec: 14400 } }],
      output: { shape: "file", name: "{serial}-app0.zar" },
    },
  };
  return {
    id: 1, gameId: 21, planId: 3, planName: KYTY, planKind: "emulator", content, ownContent: true, overrides: {}, contentId: null, packageId: null,
    status: "needs-files", statusNote: null, createdAt: s.ds.createdAt, updatedAt: s.ds.updatedAt,
    plan: { id: 3, slug: "kytyps5", name: KYTY, kind: "emulator", status: "ready", statusNote: null, repo: "chenxiao07/KytyPS5" },
    file: null, fileCheck: null, fromConsoleCopy: false, needs: { met: true, missing: [] },
    blockers: [{ code: "file", error: `the game's copy on the server is ${s.dsCopy.why}` }], canBuild: false, replaces: "rom", job: null,
    copy: s.dsCopy, run: { id: s.ds.id, phase: s.ds.phase, state: s.ds.state, ask: s.ds.ask },
    ...over,
  };
}

/** content row 1: the second copy of the game's copy, kept from its package */
export function dsSecondCopy(over: Partial<ContentFile> = {}): ContentFile {
  return {
    id: 1, gameId: 21, planId: null, needIndex: null, role: "game", platform: "ps5", name: "bbb-ps5-01342.iso", size: DS_ISO,
    hashes: { sha1: "5c7f0a1d93e2b4c86a0f1e2d3c4b5a69788796a5" }, rawHashes: null, normalized: null, source: "package", createdAt: 1_762_560_000, onDisk: true,
    identity: { platform: "ps5", serial: "PPSA01342", region: "US", masterVersion: "01.00", category: "game", shape: "bd-image", sealed: true }, shape: "file",
    ...over,
  };
}
