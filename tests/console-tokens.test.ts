import { describe, expect, test } from "bun:test";
import { CONSOLE_PLATFORMS, platformId, type PlatformId } from "../src/platforms";
import { buildQuery, certainlyThisGame, parseTitle, rankReleases, releasePlatform } from "../src/releases";
import type { ProwlarrRelease } from "../src/prowlarr";

const rel = (title: string, over: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: title, title, instanceId: 0, indexerId: 1, indexer: "T", size: 2e8, age: 10, publishDate: "", seeders: 10, leechers: 0,
  grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null, infoUrl: null, infoHash: null, protocol: "torrent",
  categories: [], indexerFlags: [], fileName: null, ...over,
});
/** the one view of a release for a game in a pass (PC by default) */
const view = (name: string, year: number | null, title: string, platforms?: PlatformId[]) => rankReleases(buildQuery(name, year), [rel(title)], { loose: true, platforms })[0];

describe("retro consoles named the way real dumps are", () => {
  const dumps: [string, number, string, PlatformId][] = [
    ["Sonic the Hedgehog", 1991, "Sonic the Hedgehog (USA, Europe) Genesis", "genesis"],
    ["Super Mario World", 1990, "Super Mario World (USA) SFC", "snes"],
    ["Tetris", 1989, "Tetris (World) GB", "gb"],
    ["Crazy Taxi", 1999, "Crazy Taxi (USA) DC", "dc"],
    ["God of War II", 2007, "God.of.War.II.USA.PS2DVD-STRiKE", "ps2"],
  ];
  for (const [name, year, title, plat] of dumps) {
    test(`"${title}" is certain in the ${plat} pass and refused in the PC pass`, () => {
      const c = view(name, year, title, [plat]);
      expect(c.flags.platform).toBe(plat); expect(c.flags.wrongKind).toBeNull(); expect(c.flags.extraWords).toBe(false);
      expect(certainlyThisGame(c)).toBe(true);
      const pc = view(name, year, title);
      expect(pc.flags.wrongKind).toMatch(/not a PC build/); expect(certainlyThisGame(pc)).toBe(false);
    });
  }
  test("a No-Intro name says no console: the generic console fallback still refuses it (a verifiable content pass decides those)", () => {
    const t = "Legend of Zelda, The - Majora's Mask (USA)";
    for (const plats of [["n64"], CONSOLE_PLATFORMS] as PlatformId[][]) {
      const v = view("The Legend of Zelda: Majora's Mask", 2000, t, plats);
      expect(v.flags.wrongKind).toMatch(/names no console/); expect(certainlyThisGame(v)).toBe(false);
    }
  });
  test("every new tag maps to its console; gcn is the GameCube", () => {
    const expected: Record<string, PlatformId> = { n64: "n64", snes: "snes", sfc: "snes", nes: "nes", famicom: "nes", gc: "gc", ngc: "gc", gcn: "gc", gb: "gb", gbc: "gbc", gba: "gba", nds: "nds",
      dc: "dc", dreamcast: "dc", saturn: "saturn", genesis: "genesis", megadrive: "genesis", md: "genesis", ps1: "ps1", psx: "ps1", psone: "ps1", n3ds: "3ds", ps2dvd: "ps2", ps2cd: "ps2" };
    for (const [tag, id] of Object.entries(expected)) {
      expect({ tag, id: platformId(tag) }).toEqual({ tag, id });
      const title = `Some Game (USA) ${tag.toUpperCase()}`;
      expect({ tag, plat: releasePlatform(title, parseTitle(title)) }).toEqual({ tag, plat: id });
    }
  });
  test("Super Mario 64 DS stays a DS game: the N64 game does not take it, the DS game does", () => {
    const t = "Super.Mario.64.DS.USA.NDS-PDX";
    expect(releasePlatform(t, parseTitle(t))).toBe("nds");
    expect(certainlyThisGame(view("Super Mario 64 DS", 2004, t, ["nds"]))).toBe(true);
    const n64 = view("Super Mario 64", 1996, t, ["n64"]);
    expect(n64.flags.wrongKind).toBe("platform: Nintendo DS"); expect(certainlyThisGame(n64)).toBe(false);
  });
  test("a PC game whose name holds MD or DC is not refused as a console build", () => {
    for (const [name, year, title] of [["DC Universe Online", 2011, "DC.Universe.Online-RUNE"], ["MD Hospital Simulator", 2024, "MD.Hospital.Simulator-TENOKE"], ["Sonic Genesis Collection", 2010, "Sonic.Genesis.Collection-GOG"]] as const) {
      const v = view(name, year, title);
      expect({ title, kind: v.flags.wrongKind }).toEqual({ title, kind: null });
      expect(certainlyThisGame(v)).toBe(true);
    }
  });
  test("a size in a title is not a Game Boy tag", () => {
    const fg = "Cyberpunk 2077: Ultimate Edition - v2.21 + 3 DLCs [FitGirl Repack, Selective Download - from 61.7 GB]";
    const v = view("Cyberpunk 2077", 2020, fg);
    expect(v.flags.wrongKind).toBeNull(); expect(v.flags.platform).toBeNull(); expect(certainlyThisGame(v)).toBe(true);
    expect(releasePlatform("Hades (4.7 GB)", parseTitle("Hades (4.7 GB)"))).toBeNull();
    expect(releasePlatform("Tetris (1989) GB", parseTitle("Tetris (1989) GB"))).toBe("gb");
  });
  test("the any-console fallback of a PC game never takes a dump that only a retro tag names; a pass for a console the game is on does", () => {
    const t = "Doom (USA) SNES";
    const fallback = rankReleases(buildQuery("DOOM", 2016), [rel(t)], { loose: true, platforms: CONSOLE_PLATFORMS, known: [] })[0];
    expect(fallback.flags.wrongKind).toMatch(/not known to be on that console/); expect(certainlyThisGame(fallback)).toBe(false);
    expect(certainlyThisGame(rankReleases(buildQuery("Doom", 1995), [rel(t)], { platforms: CONSOLE_PLATFORMS, known: ["snes"] })[0])).toBe(true);
    expect(certainlyThisGame(rankReleases(buildQuery("Doom", 1995), [rel(t)], { platforms: ["snes"] })[0])).toBe(true);
    // the tags that named a console before keep doing so in the fallback, and a GazelleGames trailer is no tag
    expect(certainlyThisGame(rankReleases(buildQuery("Demon's Souls", null), [rel("Demons.Souls.EUR.PS3-BlaZe")], { platforms: CONSOLE_PLATFORMS, known: [] })[0])).toBe(true);
    expect(rankReleases(buildQuery("Doom", 1995), [rel("Doom (1995) [SNES / English / USA / ROM]")], { platforms: CONSOLE_PLATFORMS, known: [] })[0].flags.wrongKind).toBeNull();
  });
  test("a console pass never takes a PC repack or a Windows build for a dump, whatever tag it shows", () => {
    for (const t of ["Death Stranding DC v1.0 [FitGirl Repack]", "Crazy.Taxi.DC.x64-PDX", "Sonic.Genesis.Windows-PDX"]) {
      const v = view(t.startsWith("Death") ? "Death Stranding" : t.startsWith("Crazy") ? "Crazy Taxi" : "Sonic", null, t, CONSOLE_PLATFORMS);
      expect({ t, kind: v.flags.wrongKind }).toEqual({ t, kind: expect.stringMatching(/a PC release/) });
      expect(certainlyThisGame(v)).toBe(false);
    }
  });
});
