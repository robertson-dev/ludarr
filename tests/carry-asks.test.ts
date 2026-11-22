/**
 * What a carry run asks, word for word (src/ways/asks.ts): the words are made from the content plan, its make recipe and
 * the verdicts, never from the AI's prose alone (its exact line rides along as byAi); the inbox as the admin's PC opens it
 * when Settings says how; an upload offered only when one can bring the data. Admin-facing words: nothing filters out
 * "emulator", "AI" or "plan" here (the players' filter never runs on them).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { kv } from "../src/db";
import { askdeps, askFor, atClockWords, canUploadFor, clockWords, formsWords, inboxShare, sharePath } from "../src/ways/asks";
import type { ContentPlan } from "../src/ways/types";
import { kytyUpgraded, nx2naviContent, SEALED, zeldaPlan } from "./carry-world";

const realAsk = { ...askdeps };
afterEach(() => { kv.del("cfg.LIBRARY_SHARE_PATH"); kv.del("cfg.CONTENT_UPLOAD_MAX_GB"); Object.assign(askdeps, realAsk); });
const HINT = "(The folder starts with a dot, so Windows may hide it: type the path in Explorer's address bar.)";
const NOW = 1_794_000_000;

describe("the three live asks", () => {
  test("Demon's Souls: the folder or one .zar, the editions and versions the code names, the copy's own words, the share path", () => {
    kv.set("cfg.LIBRARY_SHARE_PATH", "\\\\tower\\games\\ahoy");
    const next = NOW + 6 * 3600;
    const a = askFor("file", {
      plan: { name: "KytyPS5 (chenxiao07 Demon's Souls fork)" }, game: { name: "Demon's Souls" }, content: kytyUpgraded(), now: NOW,
      inbox: "/library/.ahoy-inbox/demons-souls",
      tried: { copy: { name: "bbb-ps5-01342.iso", size: 54.2 * 1e9, why: SEALED }, kept: [{ name: "bbb-ps5-01342.iso", why: SEALED, same: true }], indexers: { looked: 2, reason: "Demons.Souls.PS5-BigBlueBox [Full ISO]: a PS5 disc image holds the game encrypted", nextAt: next } },
      watching: { nextSearchAt: next, inbox: true, every: "2 minutes" },
    });
    expect(a).toEqual({
      code: "file", title: "Demon's Souls needs its game data",
      need: `KytyPS5 (chenxiao07 Demon's Souls fork) plays Demon's Souls at 1.05 or 1.07. It takes the game folder dumped from a console (holding sce_sys/param.json and eboot.bin), or that folder packed as one .zar, of Demon's Souls (PlayStation 5) — PPSA01341, PPSA01342 or PPSA01340, version 01.005.000 or 01.007.000. Put it in \\\\tower\\games\\ahoy\\.ahoy-inbox\\demons-souls\\ (on the server: /library/.ahoy-inbox/demons-souls/), or pick it on the server: ludarr takes it from there and finishes by itself. ${HINT}`,
      tried: [
        `The copy on the server (bbb-ps5-01342.iso, 54.2 GB) is ${SEALED}.`,
        "bbb-ps5-01342.iso, kept on the server, is the same bytes as that copy: not used.",
        `The indexers have nothing it can use yet (2 releases looked at; Demons.Souls.PS5-BigBlueBox [Full ISO]: a PS5 disc image holds the game encrypted). Looking again ${atClockWords(next, NOW)}.`,
      ],
      accept: { platform: "ps5", shape: "folder", formats: ["zar"], serials: ["PPSA01341", "PPSA01342", "PPSA01340"], versions: ["01.005.000", "01.007.000"], regions: undefined },
      inbox: "/library/.ahoy-inbox/demons-souls", inboxShare: "\\\\tower\\games\\ahoy\\.ahoy-inbox\\demons-souls\\", canUpload: false,
      choices: [], heldContentId: null, watching: { nextSearchAt: next, inbox: true, every: "2 minutes" }, askedAt: NOW, byAi: null,
    });
  });

  test("NX2navi: one .nup with its ids, who makes it, the download already running — no upload (a .nup is bigger than the limit)", () => {
    askdeps.sizeRange = p => (p === "switch" ? [64 * 2 ** 20, 64 * 1e9] : null);
    const a = askFor("file", {
      plan: { name: "NX2navi" }, game: { name: "The Legend of Zelda: Ocarina of Time" }, content: nx2naviContent(), now: NOW, inbox: "/library/.ahoy-inbox/the-legend-of-zelda-ocarina-of-time-2026",
      tried: { download: { title: "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp" }, indexers: { looked: 0, reason: null, nextAt: null, not: "a download of The Legend of Zelda: Ocarina of Time is already running" } },
    });
    expect(a.title).toBe("The Legend of Zelda: Ocarina of Time needs its game data");
    expect(a.need).toBe(`NX2navi plays The Legend of Zelda: Ocarina of Time (Switch 2) with the 1.1.1 update. It takes one .nup file of The Legend of Zelda: Ocarina of Time (Switch) — 0400486024DEC000, version 1.1.1, build e0f3ccfaf50065ae4ea01eb5aeb13b1a. It comes from your own console: Eglantine on your Switch 2 makes it. Put it in /library/.ahoy-inbox/the-legend-of-zelda-ocarina-of-time-2026/, or pick it on the server: ludarr takes it from there and finishes by itself. ${HINT}`);
    expect(a.tried).toEqual([
      "A download of The Legend of Zelda: Ocarina of Time is already running (The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp): ludarr looks at what it brings as soon as it lands.",
      "The indexers are not searched now: a download of The Legend of Zelda: Ocarina of Time is already running.",
    ]);
    expect([a.canUpload, a.inboxShare]).toEqual([false, null]);
    // no "or its exefs and romfs folders": the plan cannot take that form
    expect(a.need).not.toContain("exefs");
  });

  test("Zelda 64: Recompiled: its file, were it asked for: one ROM, proven by hash, small enough to upload", () => {
    const a = askFor("file", { plan: { name: "Zelda 64: Recompiled" }, game: { name: "The Legend of Zelda: Majora's Mask" }, content: zeldaPlan().content, now: NOW, inbox: "/library/.ahoy-inbox/the-legend-of-zelda-majoras-mask", tried: { indexers: { looked: 3, reason: "Majora's Mask (Europe).z64: another region", nextAt: NOW + 3600 } } });
    expect(a.need).toBe(`Zelda 64: Recompiled plays Majora's Mask, NTSC-U 1.0. It takes one .z64, .v64 or .n64 file of The Legend of Zelda: Majora's Mask (Nintendo 64). Put it in /library/.ahoy-inbox/the-legend-of-zelda-majoras-mask/, pick it on the server, or upload it (files up to 16 GB): ludarr takes it from there and finishes by itself. ${HINT}`);
    expect(a.tried).toEqual([`The indexers have nothing it can use yet (3 releases looked at; Majora's Mask (Europe).z64: another region). Looking again ${atClockWords(NOW + 3600, NOW)}.`]);
    expect(a.canUpload).toBe(true);
  });

  test("Zelda 64: Recompiled: go ahead?", () => {
    const a = askFor("go-ahead", { plan: { name: "Zelda 64: Recompiled" }, game: { name: "The Legend of Zelda: Majora's Mask" }, content: zeldaPlan().content, now: NOW });
    expect([a.code, a.title, a.need]).toEqual(["go-ahead", "Make The Legend of Zelda: Majora's Mask playable?", "Should ludarr make The Legend of Zelda: Majora's Mask playable through Zelda 64: Recompiled? It adds the game to the library and looks for Majora's Mask, NTSC-U 1.0."]);
  });
});

describe("the inbox line and the upload", () => {
  test("with no share path set the server's path alone; with one, the PC's path first and the server's after it", () => {
    expect(sharePath()).toBeNull();
    const plain = askFor("file", { plan: { name: "P" }, game: { name: "G" }, content: kytyUpgraded(), inbox: "/library/.ahoy-inbox/g", now: NOW });
    expect(plain.need).toContain("Put it in /library/.ahoy-inbox/g/, or pick it on the server:");
    expect(plain.inboxShare).toBeNull();
    kv.set("cfg.LIBRARY_SHARE_PATH", "\\\\tower\\games\\ahoy\\");
    expect(inboxShare("/library/.ahoy-inbox/g")).toBe("\\\\tower\\games\\ahoy\\.ahoy-inbox\\g\\");
    kv.set("cfg.LIBRARY_SHARE_PATH", "smb://tower/games/ahoy");
    expect(inboxShare("/library/.ahoy-inbox/g")).toBe("smb://tower/games/ahoy/.ahoy-inbox/g/");
    // no inbox at all (no root folder): only the server path
    const none = askFor("file", { plan: { name: "P" }, game: { name: "G" }, content: kytyUpgraded(), inbox: null, now: NOW });
    expect(none.need).toEndWith("Pick it on the server: ludarr takes it from there and finishes by itself.");
  });

  test("upload it only when one file can bring it within the limit", () => {
    const rom = zeldaPlan().content!;
    expect(canUploadFor(rom)).toBe(true);                                    // an N64 ROM, at most 128 MB
    const a = askFor("file", { plan: { name: "Zelda 64: Recompiled" }, game: { name: "MM" }, content: rom, inbox: "/library/.ahoy-inbox/mm", now: NOW });
    expect(a.need).toContain("Put it in /library/.ahoy-inbox/mm/, pick it on the server, or upload it (files up to 16 GB): ludarr takes it from there and finishes by itself.");
    expect(a.canUpload).toBe(true);
    expect(canUploadFor(kytyUpgraded())).toBe(false);                        // a folder form
    askdeps.sizeRange = p => (p === "ps5" ? [2 ** 30, 200 * 1e9] : p === "n64" ? [512 * 1024, 128 * 2 ** 20] : null);
    expect(canUploadFor({ ...rom, complete: undefined, accept: { ...rom.accept }, platform: "ps5", kind: "disc", make: null } as ContentPlan)).toBe(false); // PS5: up to 200 GB
    kv.set("cfg.CONTENT_UPLOAD_MAX_GB", "256");
    expect(canUploadFor({ ...rom, platform: "ps5", kind: "disc" } as ContentPlan)).toBe(true);
  });

  test("the forms come from the content plan and its make only", () => {
    expect(formsWords(zeldaPlan().content!)).toBe("one .z64, .v64 or .n64 file");
    expect(formsWords({ ...kytyUpgraded(), make: { ...kytyUpgraded().make!, input: { ...kytyUpgraded().make!.input, shape: "either", formats: ["rar", "7z"] } } })).toBe("the game folder dumped from a console (holding sce_sys/param.json and eboot.bin), that folder in one .rar or .7z file, or that folder packed as one .zar");
    expect(formsWords({ ...kytyUpgraded(), make: { ...kytyUpgraded().make!, input: { ...kytyUpgraded().make!.input, shape: "file", formats: ["rar"] } } })).toBe("one .rar file holding the game folder (holding sce_sys/param.json and eboot.bin), or one .zar file");
    expect(formsWords({ kind: "folder", platform: "ps5", what: "x", search: [], accept: { hashes: [] }, marker: "sce_sys/param.json", place: "game" })).toBe("the game folder dumped from a console (holding sce_sys/param.json)");
  });
});

describe("every ask, in words", () => {
  const base = { plan: { name: "KytyPS5" }, game: { name: "Demon's Souls" }, content: kytyUpgraded(), now: NOW };
  test("held-file, game, choice, needs", () => {
    expect(askFor("held-file", { ...base, held: { contentId: 7, name: "DS.zar", facts: "PPSA01341, EU, 01.007.000" } })).toMatchObject({
      title: "Is DS.zar the game?", heldContentId: 7, need: "DS.zar came from the indexers, and nothing proves it is Demon's Souls at 1.05 or 1.07 (PPSA01341, EU, 01.007.000). Accept it if it is.",
    });
    expect(askFor("game", { ...base, choices: [{ gameId: 1, name: "Demon's Souls", year: 2020, platforms: ["PS5"] }] }).need).toBe("Which game does KytyPS5 play? It plays Demon's Souls at 1.05 or 1.07. Pick it from the library, or add it as a new game.");
    expect(askFor("game", { ...base, choices: [] }).need).toBe("Which game does KytyPS5 play? It plays Demon's Souls at 1.05 or 1.07. No library game is it: add it as a new game.");
    expect(askFor("needs", { ...base, need: { kind: "bios", name: "PS5 firmware", place: "fw.bin", accept: { formats: ["bin"], hashes: [{ algo: "sha1", value: "a".repeat(40) }] } } }).need)
      .toBe(`KytyPS5 needs PS5 firmware (a .bin file with sha1 ${"a".repeat(40)}): add it once on the plan; every game it plays uses it.`);
    const other = askFor("choice", { ...base, byAi: { need: "other", title: "A GitHub token is needed", exact: "the releases API answers 403 without a token" } });
    expect(other).toMatchObject({ code: "choice", title: "A GitHub token is needed", byAi: "the releases API answers 403 without a token", need: "ludarr's AI needs your help with KytyPS5 for Demon's Souls: the releases API answers 403 without a token." });
  });

  test("admin words are never filtered for players: emulator, AI, plan, ROM, repo stay as they are", () => {
    const words = [askFor("choice", { plan: { name: "PCSX2 emulator" }, content: { ...zeldaPlan().content!, platform: "ps2" }, choices: [], now: NOW }).need,
      askFor("ai", { plan: { name: "x" }, failure: "the ROM's repo has no release", now: NOW }).need].join(" ");
    for (const w of ["emulator", "AI importer", "ROM", "repo"]) expect(words).toContain(w);
  });

  test("ai, budget (and switched off), room, env — admin words, nothing filtered", () => {
    expect(askFor("ai", { ...base, failure: "check: the self-test failed" }).need).toBe("Working this out needs the AI importer, which is not set up: add its key under Settings → Importers. ludarr carries on by itself once it is there. (What stopped it: check: the self-test failed.)");
    const budget = askFor("budget", { ...base, failure: "build step 1 failed (exit 1)", phase: "fix the build", rounds: 3, roundsSetting: 3 });
    expect(budget.title).toBe("Demon's Souls: the AI stopped after 3 tries");
    expect(budget.need).toContain("ludarr's AI tried 3 times to make KytyPS5 work for Demon's Souls");
    expect(askFor("budget", { ...base, failure: "x", rounds: 0, roundsSetting: 0 }).need).toBe("AI repairs are switched off (Settings → General → Import → AI repairs per game), and this needs one: x.");
    expect(askFor("room", { ...base, room: { need: 105 * 1e9, free: 12 * 1e9 } }).need).toBe("Making Demon's Souls's game data needs about 105 GB free on the library; 12 GB are free. ludarr tries again every hour.");
    expect(askFor("env", { ...base, what: "Making Demon's Souls's game data", failure: "no sandbox here", nextAt: NOW + 86_400 }).need).toBe(`Making Demon's Souls's game data could not run on this server: no sandbox here. ludarr tries again by itself ${atClockWords(NOW + 86_400, NOW)}, and every day after that.`);
  });

  test("the budget promises one more try on a new release only when the run makes one; room names the step; an unusable inbox", () => {
    expect(askFor("budget", { ...base, failure: "x", phase: "make the plan pass", rounds: 3, roundsSetting: 3 }).need)
      .toBe("ludarr's AI tried 3 times to make KytyPS5 work for Demon's Souls; the last try failed at make the plan pass: x. It stops so it does not spend more: raise 'AI repairs per game' in Settings → General → Import, or change the plan.");
    expect(askFor("budget", { ...base, failure: "x", phase: "fix the build", rounds: 3, roundsSetting: 3, rearms: true }).need).toEndWith("or change the plan. It tries once more by itself when the program has a new release.");
    expect(askFor("room", { ...base, room: { need: 60 * 1e9, free: 12 * 1e9, what: "Building Demon's Souls" } }).need).toBe("Building Demon's Souls needs about 60 GB free on the library; 12 GB are free. ludarr tries again every hour.");
    const a = askFor("file", { ...base, inbox: null, tried: { inbox: "the folder is a link" } });
    expect(a.tried).toEqual(["The inbox folder cannot be used: the folder is a link."]);
    expect(a.need).toEndWith("Pick it on the server: ludarr takes it from there and finishes by itself.");
  });

  test("a file the AI asks for: the words from the plan, the AI's exact line beside them", () => {
    const a = askFor("file", { ...base, byAi: { need: "file", title: "x", exact: "only a 1.05 or 1.07 dump works", accept: { platform: "ps5", shape: "folder", serials: ["PPSA01341"] } }, inbox: "/library/.ahoy-inbox/ds" });
    expect(a.byAi).toBe("only a 1.05 or 1.07 dump works");
    expect(a.accept).toEqual({ platform: "ps5", shape: "folder", serials: ["PPSA01341"] });
    expect(a.need).toStartWith("KytyPS5 plays Demon's Souls at 1.05 or 1.07. It takes the game folder");
  });
});

describe("the replace question and the room, word for word", () => {
  const plan = { name: "NX2navi" }, game = { name: "The Legend of Zelda: Ocarina of Time" };
  const NUP = "Ocarina.nup";
  const copy = (serves: "direct" | "make" | "no") => ({ packageId: 42, name: NUP, size: 25_020_741_061, shape: "file" as const, identity: null, serves, why: "x" });
  const head = "The Legend of Zelda: Ocarina of Time already plays through its PC copy (lichii.exe). Should ludarr build NX2navi for it instead? Building it replaces the PC copy: its files are removed, and members install the NX2navi build in its place. Nothing changes until you say so.";
  const pc = { through: "its PC copy (lichii.exe)", replaces: "the PC copy" };

  test("building over what the game plays: what it plays through, what is removed, and where its game file comes from", () => {
    const base = { plan, game, content: nx2naviContent(), now: NOW };
    const a = askFor("go-ahead", { ...base, replace: { ...pc, copy: null } });
    expect([a.code, a.title, a.need]).toEqual(["go-ahead", "Build The Legend of Zelda: Ocarina of Time with NX2navi?", head]);
    expect(askFor("go-ahead", { ...base, replace: { ...pc, copy: copy("direct") } }).need).toBe(`${head} Its game file is on the server already (${NUP}, 25.0 GB): nothing is downloaded.`);
    expect(askFor("go-ahead", { ...base, replace: { ...pc, copy: copy("make") } }).need).toBe(`${head} Its game file is made from ${NUP} on the server: nothing is downloaded.`);
    expect(askFor("go-ahead", { ...base, replace: { ...pc, copy: copy("no"), unproven: true } }).need).toBe(`${head} ${NUP} (25.0 GB) on the server may be its game file: ludarr takes it once NX2navi proves it is the game, before anything is downloaded.`);
    expect(askFor("go-ahead", { ...base, replace: { ...pc, copy: copy("no") } }).need).toBe(head);
    expect(askFor("go-ahead", { ...base, replace: { through: "the way built through Lichii", replaces: "the Lichii build" } }).need)
      .toStartWith("The Legend of Zelda: Ocarina of Time already plays through the way built through Lichii. Should ludarr build NX2navi for it instead? Building it replaces the Lichii build: its files are removed");
    // the backfill's go-ahead is unchanged
    expect(askFor("go-ahead", { ...base }).title).toBe("Make The Legend of Zelda: Ocarina of Time playable?");
  });

  test("room: what ludarr keeps free is said with where it is set; the kept second copy is the fix, in numbers", () => {
    const base = { plan: { name: "KytyPS5" }, game: { name: "Demon's Souls" }, now: NOW };
    const dup = { contentId: 1, name: "bbb-ps5-01342.iso", size: 54.2 * 1e9 };
    const room = (need: number, free: number, duplicate: typeof dup | null) =>
      askFor("room", { ...base, room: { need: need * 1e9, free: free * 1e9, what: "Making Demon's Souls's game data", keepFree: 50 * 1e9, duplicate } }).need;
    const start = "Making Demon's Souls's game data needs about 104 GB free on the library: what it writes, and the 50 GB ludarr keeps free (Settings → General → Import → Keep free on the library); 76 GB are free.";
    expect(room(104, 76, dup)).toBe(`${start} Freeing the second copy of bbb-ps5-01342.iso kept in the game file store gives 54.2 GB back; one copy stays, and that is enough. ludarr tries again every hour.`);
    expect(room(158, 76, dup)).toEndWith("gives 54.2 GB back; one copy stays, and it is still about 28 GB short. ludarr tries again every hour.");
    expect(room(104, 76, null)).toBe(`${start} ludarr tries again every hour.`);
  });

  test("an earlier download that is not tried is said", () => {
    const a = askFor("file", { plan, game, content: nx2naviContent(), now: NOW, tried: { earlier: [{ title: "OoT.v1.0-grp", why: "refused for this way before" }] } });
    expect(a.tried).toEqual(["An earlier download of The Legend of Zelda: Ocarina of Time, OoT.v1.0-grp, was refused for this way before."]);
  });
});
