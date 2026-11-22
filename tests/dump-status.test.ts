/**
 * What a release's tags say about it, in both passes:
 *  - a console pass never takes a dump that is not the game as it was sold — a beta, prototype, pre-production, demo,
 *    kiosk, sample or promotional build, a hack, a pirate, unlicensed or homebrew copy (No-Intro / Redump / GoodTools
 *    tags), or a GoodTools bad, hack, overdump, trainer, pirate, fixed or translated dump — unless the game's own name has
 *    that word;
 *  - the PC pass takes a repacker's or a Windows build whose tags name the retro consoles of the games inside it, and
 *    such a release is a PC build (installed, not unpacked as a dump), while a dump with a PC group's tag, or one handed
 *    out with an emulator for Windows (its region tag gives it away), stays refused.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSOLE_PLATFORMS, type PlatformId } from "../src/platforms";
import { buildQuery, certainlyThisGame, rankReleases, type ReleaseView } from "../src/releases";
import type { ProwlarrRelease } from "../src/prowlarr";
import { db, stmts, type RequestRow } from "../src/db";
import { app } from "../src/server";
import { apiKey } from "../src/config";
import { installClass, rdeps, requestsTick } from "../src/requests";
import { sdeps, searchReleases } from "../src/search";

const rel = (title: string, over: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: title, title, instanceId: 0, indexerId: 1, indexer: "T", size: 3.2e7, age: 10, publishDate: "", seeders: 10, leechers: 0,
  grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent",
  categories: [], indexerFlags: [], fileName: null, ...over,
});
/** the view of one release for a game, in a pass for `platforms` (PC when absent), with the consoles the game is known on */
const view = (name: string, year: number | null, title: string, platforms?: PlatformId[], known?: PlatformId[], size = 3.2e7): ReleaseView =>
  rankReleases(buildQuery(name, year), [rel(title, { size })], { loose: true, platforms, known })[0];

const MM = "The Legend of Zelda: Majora's Mask";

describe("a console pass takes only the game as it was sold", () => {
  const refused: [string, number, string, PlatformId, RegExp][] = [
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Beta) N64", "n64", /development build/],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Demo) (Kiosk) N64", "n64", /a demo/],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Kiosk Demo) N64", "n64", /a demo/],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) [Hack] N64", "n64", /a hack/],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Proto 2) (2000-03-15) N64", "n64", /development build/],
    // written with a hyphen, these are one word: as "pre" and "release" they passed
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Pre-Production) N64", "n64", /\(Pre-Production\): a development build/],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Pre-Release) N64", "n64", /\(Pre-Release\): a development build/],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Pre Release Version) N64", "n64", /a development build/],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Promo) N64", "n64", /\(Promo\): a promotional copy/],
    ["Super Mario World", 1990, "Super Mario World (USA) (Proto) SFC", "snes", /development build/],
    ["Super Mario World", 1990, "Super Mario World (USA) (Sample) SFC", "snes", /a sample copy/],
    ["Super Mario World", 1990, "Super Mario World (U) [h1] SFC", "snes", /\[h1\]: a hack/],
    ["Super Mario World", 1990, "Super Mario World (U) [h1C] SFC", "snes", /a hack/],
    ["Super Mario World", 1990, "Super Mario World (U) [b1] SFC", "snes", /a bad dump/],
    ["Super Mario World", 1990, "Super Mario World (U) [o1] SFC", "snes", /an overdump/],
    ["Super Mario World", 1990, "Super Mario World (U) [t1] SFC", "snes", /a trainer/],
    ["Super Mario World", 1990, "Super Mario World (U) [p1] SFC", "snes", /a pirate copy/],
    ["Super Mario World", 1990, "Super Mario World (U) [f1] SFC", "snes", /a fixed dump/],
    ["Super Mario World", 1990, "Super Mario World (J) [T+Eng1.0_Someone] SFC", "snes", /a translation/],
    ["Super Mario World", 1990, "Super Mario World (J) [T-Eng] SFC", "snes", /a translation/],
    ["Sonic the Hedgehog", 1991, "Sonic the Hedgehog (USA, Europe) (Hack) Genesis", "genesis", /a hack/],
    ["Sonic the Hedgehog", 1991, "Sonic the Hedgehog (Pirate) Genesis", "genesis", /a pirate copy/],
    ["Tetris", 1989, "Tetris (USA) (Unl) NES", "nes", /unlicensed/],
    ["Tetris", 1989, "Tetris (PD) GB", "gb", /homebrew/],
    ["Super Mario Bros.", 1985, "Super Mario Bros. (World) (Aftermarket) (Unl) NES", "nes", /homebrew|unlicensed/],
    ["God of War II", 2007, "God of War II (USA) (Demo) PS2", "ps2", /a demo/],
  ];
  for (const [name, year, title, plat, why] of refused) {
    test(`"${title}" is refused in the ${plat} pass of a game known on it`, () => {
      const v = view(name, year, title, [plat], [plat]);
      expect({ title, kind: v.flags.wrongKind }).toEqual({ title, kind: expect.stringMatching(why) });
      expect(certainlyThisGame(v)).toBe(false);
    });
  }
  test("the any-console fallback of a PC game refuses them too (a PS2 demo was certain there)", () => {
    const v = rankReleases(buildQuery("God of War II", 2007), [rel("God of War II (USA) (Demo) PS2", { size: 3e9 })], { loose: true, platforms: CONSOLE_PLATFORMS, known: [] })[0];
    expect(v.flags.wrongKind).toMatch(/a demo/); expect(certainlyThisGame(v)).toBe(false);
  });
  const retail: [string, number, string, PlatformId][] = [
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) N64", "n64"],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Rev 1) N64", "n64"],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (USA) (Virtual Console) N64", "n64"],
    [MM, 2000, "Legend of Zelda, The - Majora's Mask (Europe) (En,Fr,De,Es) (Rev 1) N64", "n64"],
    ["Super Mario World", 1990, "Super Mario World (U) [!] SFC", "snes"],
    ["Super Mario World", 1990, "Super Mario World (U) [a1] SFC", "snes"],
    ["Sonic the Hedgehog", 1991, "Sonic the Hedgehog (USA, Europe) (Rev 1) Genesis", "genesis"],
    ["Final Fantasy VII", 1997, "Final Fantasy VII (USA) (Disc 1) PS1", "ps1"],
    ["God of War II", 2007, "God.of.War.II.USA.PS2DVD-STRiKE", "ps2"],
  ];
  for (const [name, year, title, plat] of retail) {
    test(`"${title}" stays certain in the ${plat} pass`, () => {
      const v = view(name, year, title, [plat], [plat]);
      expect({ title, kind: v.flags.wrongKind }).toEqual({ title, kind: null });
      expect(certainlyThisGame(v)).toBe(true);
    });
  }
  test("a word the game's own name has is not held against its dumps", () => {
    const v = view("Jampack Demo Disc", 1999, "Jampack Demo Disc (USA) (Demo) PS1", ["ps1"], ["ps1"]);
    expect(v.flags.wrongKind).toBeNull(); expect(certainlyThisGame(v)).toBe(true);
    // … but only that word: the same game's beta is still refused
    expect(view("Jampack Demo Disc", 1999, "Jampack Demo Disc (USA) (Beta) PS1", ["ps1"], ["ps1"]).flags.wrongKind).toMatch(/development build/);
    // a hyphenated word counts as the name's too
    expect(view("Pre-Release Showdown", 1999, "Pre-Release Showdown (USA) (Pre-Release) PS1", ["ps1"], ["ps1"]).flags.wrongKind).toBeNull();
  });
});

describe("the PC pass and retro tags", () => {
  test("a repacker's build whose tags name the consoles of the games in it is the PC game, and a PC build", () => {
    for (const [name, year, title] of [
      ["Collection of Mana", 2019, "Collection of Mana (SNES + GB) [FitGirl Repack]"],
      ["SEGA Mega Drive Classics", 2018, "SEGA Mega Drive Classics (MD, Genesis) [DODI Repack]"],
      ["Mega Man Legacy Collection", 2015, "Mega Man Legacy Collection (NES) x64"],
      ["Football Manager 2024", 2023, "Football Manager 2024 (EN-GB) [FitGirl Repack]"],
      ["Super Mario 64", 1996, "Super Mario 64 (N64) Windows x64 PC Port"],
    ] as [string, number, string][]) {
      const v = view(name, year, title, undefined, undefined, 5e9);
      expect({ title, kind: v.flags.wrongKind, platform: v.flags.platform ?? null }).toEqual({ title, kind: null, platform: null });
      expect(certainlyThisGame(v)).toBe(true);
      expect(installClass(v)).not.toBe("rom");                  // installed as a PC game, never unpacked as a dump
    }
  });
  test("a dump that only a PC group's tag dresses up stays refused (no scene-group rescue)", () => {
    for (const [name, year, title] of [
      ["DOOM", 2016, "Doom (USA) SNES [P2P]"],
      ["DOOM", 2016, "Doom (USA) N64 [GOG]"],
      ["Castlevania Anniversary Collection", 2019, "Castlevania Anniversary Collection (NES, GB, SNES, MD) [GOG]"],
    ] as [string, number, string][]) {
      const v = view(name, year, title, undefined, undefined, 5e9);
      expect({ title, kind: v.flags.wrongKind }).toEqual({ title, kind: expect.stringMatching(/not a PC build/) });
      expect(certainlyThisGame(v)).toBe(false);
    }
  });
  test("an old dump handed out with an emulator for Windows stays refused: its region tag says it is a dump", () => {
    for (const [name, year, title, plat] of [
      ["DOOM", 2016, "Doom (USA) SNES x86", "snes"],
      ["DOOM", 2016, "Doom (USA) (SNES) [Windows x64 emulator]", "snes"],
      ["DOOM", 2016, "Doom (U) [!] SNES x86", "snes"],
      ["DOOM", 2016, "Doom.USA.SNES.x86-GRP", "snes"],
      ["Prince of Persia", 2008, "Prince of Persia (USA) SNES [Windows x86]", "snes"],
      ["Sonic the Hedgehog", 2006, "Sonic the Hedgehog (USA, Europe) Genesis [Windows]", "genesis"],
    ] as [string, number, string, PlatformId][]) {
      const v = view(name, year, title, undefined, undefined, 5e9);
      expect({ title, kind: v.flags.wrongKind, platform: v.flags.platform }).toEqual({ title, kind: expect.stringMatching(/not a PC build/), platform: plat });
      expect(certainlyThisGame(v)).toBe(false);
    }
  });
  test("the console pass still refuses such a repack, as a PC release", () => {
    const v = view("Collection of Mana", 2019, "Collection of Mana (SNES + GB) [FitGirl Repack]", ["snes"], ["snes"], 5e9);
    expect(v.flags.wrongKind).toMatch(/a PC release \(FitGirl\)/); expect(certainlyThisGame(v)).toBe(false);
  });
});

describe("the searcher end to end", () => {
  const saved = { rdeps: { ...rdeps }, sdeps: { ...sdeps } };
  const listing = [
    rel("Legend of Zelda, The - Majora's Mask (USA) (Beta) N64", { seeders: 40, categories: [{ id: 1000 }] }),
    rel("Legend of Zelda, The - Majora's Mask (USA) (Demo) (Kiosk) N64", { seeders: 30, categories: [{ id: 1000 }] }),
    rel("Legend of Zelda, The - Majora's Mask (USA) [h1C] N64", { seeders: 20, categories: [{ id: 1000 }] }),
    rel("Legend of Zelda, The - Majora's Mask (USA) N64", { seeders: 5, categories: [{ id: 1000 }] }),
  ];
  beforeEach(() => {
    process.env.LUDARR_CONFIG = mkdtempSync(join(tmpdir(), "ludarr-dumps-"));
    db.exec("DELETE FROM requests; DELETE FROM follows; DELETE FROM jobs; DELETE FROM packages; DELETE FROM fetches; DELETE FROM games");
  });
  afterAll(() => {
    Object.assign(rdeps, saved.rdeps); Object.assign(sdeps, saved.sdeps);
    db.exec("DELETE FROM requests; DELETE FROM follows; DELETE FROM jobs; DELETE FROM packages; DELETE FROM fetches; DELETE FROM games");
  });
  test("a hand-added N64 game's request grabs the retail dump, never the better-seeded beta, demo or hack", async () => {
    // an indexer that files dumps under consoles: a PC search (4000) finds nothing, the console pass (every category) finds them
    sdeps.indexers = () => [{ id: 1, name: "T", indexer: { search: async (_t: string, opt?: { categories?: number[] }) => ((opt?.categories ?? [4000]).length === 0 ? listing : []) } as never }];
    const grabbed: string[] = [];
    rdeps.search = searchReleases;
    rdeps.grab = async (r, gameId) => {
      grabbed.push(r.title);
      const f = stmts.insertFetch({ game_id: gameId, guid: r.guid, indexer_id: 1, indexer: "T", title: r.title, protocol: "torrent", size: r.size, info_hash: null, client: "fake", client_id: "1", state: "submitted", release_json: JSON.stringify(r) });
      return { fetch: f as never, duplicate: false };
    };
    rdeps.usenetAvailable = async () => false;
    rdeps.log = () => {};
    rdeps.now = () => Date.now();
    const res = await app.request("/api/v1/game", { method: "POST", headers: { "x-api-key": apiKey(), "content-type": "application/json" }, body: JSON.stringify({ source: "manual", game: { name: MM, year: 2000, platforms: ["n64"] } }) });
    expect(res.status).toBe(201);
    const g = ((await res.json()) as { item: { id: number } }).item;
    await requestsTick();
    const r = db.query("SELECT * FROM requests WHERE game_id=? ORDER BY id DESC LIMIT 1").get(g.id) as RequestRow;
    expect(grabbed).toEqual(["Legend of Zelda, The - Majora's Mask (USA) N64"]);
    expect(r.state).toBe("fetching");
    expect((JSON.parse(r.candidates_json ?? "[]") as ReleaseView[]).map(c => c.title)).toEqual(["Legend of Zelda, The - Majora's Mask (USA) N64"]);
  });
});
