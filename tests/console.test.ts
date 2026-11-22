import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSOLE_PLATFORMS, consolePlatforms, hasPc, platformId, platformOfCategory } from "../src/platforms";
import { buildQuery, parseTitle, rankReleases, releasePlatform } from "../src/releases";
import { certainlyThisGame, installClass } from "../src/requests";
import { classOfPackage, parseProfile } from "../src/library/profiles";
import { deterministic } from "../src/process/recipes";
import { inspectRom } from "../src/process/validate";
import type { ProwlarrRelease } from "../src/prowlarr";

const rel = (title: string, over: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
  guid: Math.random().toString(36).slice(2), title, instanceId: 0, indexerId: 1, indexer: "GGn", size: 30e9, age: 10,
  publishDate: "", seeders: 10, leechers: 0, grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null,
  infoUrl: null, infoHash: null, protocol: "torrent", categories: [], indexerFlags: [], fileName: null, ...over,
});

describe("platforms", () => {
  test("ids from metadata, trailers, tags and categories", () => {
    expect(platformId("PS5")).toBe("ps5"); expect(platformId("PlayStation 5")).toBe("ps5"); expect(platformId("PC (Microsoft Windows)")).toBe("pc");
    expect(platformId("win")).toBe("pc"); expect(platformId("Windows")).toBe("pc"); expect(platformId("NSW")).toBe("switch"); expect(platformId("Xbox Series X|S")).toBe("xsx");
    expect(platformId("Series X|S")).toBe("xsx"); expect(platformId("")).toBeNull(); expect(platformId("Stadia")).toBeNull();
    expect(consolePlatforms(["PS5", "PS3", "win", "Linux"])).toEqual(["ps5", "ps3"]); expect(hasPc(["win", "mac"])).toBe(true); expect(hasPc(["PS5"])).toBe(false);
    expect(platformOfCategory([1080, 101080])).toBe("ps3"); expect(platformOfCategory([4050])).toBeNull();
    expect(releasePlatform("Demons.Souls.EUR.PS3-BlaZe", parseTitle("Demons.Souls.EUR.PS3-BlaZe"))).toBe("ps3");
    expect(releasePlatform("Demon's Souls (2020) [PlayStation 5 / Multi-Language / USA / Home Rip]", parseTitle("Demon's Souls (2020) [PlayStation 5 / Multi-Language / USA / Home Rip]"))).toBe("ps5");
    expect(releasePlatform("Demons Souls Remake", parseTitle("Demons Souls Remake"), [1080])).toBe("ps3");
    expect(releasePlatform("Demons Souls Remake", parseTitle("Demons Souls Remake"))).toBeNull();
  });
});

describe("console releases", () => {
  const q = buildQuery("Demon's Souls", 2020);
  const rows = [
    rel("Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]"),
    rel("Demon's Souls (2020) [PlayStation 5 / Multi-Language / Asia / Home Rip]"),
    rel("Demon's Souls (2009) [PlayStation 3 / English / USA / ROM]"),
    rel("Demons.Souls.EUR.PS3-BlaZe", { categories: [{ id: 1080, name: "PS3" }] }),
    rel("Demon's Souls (2020) [Windows / English / Home Rip]"),
    rel("Demons Souls Remake 2020"),
  ];
  const by = (views: ReturnType<typeof rankReleases>, start: string) => views.find(v => v.title.startsWith(start))!;
  test("the PC pass refuses every console dump", () => {
    const v = rankReleases(q, rows);
    expect(certainlyThisGame(by(v, "Demon's Souls (2020) [Windows"))).toBe(true);
    for (const t of ["Demons.Souls.PS5", "Demon's Souls (2020) [PlayStation 5", "Demon's Souls (2009)", "Demons.Souls.EUR"]) { const r = by(v, t); expect(r.flags.wrongKind).toBeTruthy(); expect(certainlyThisGame(r)).toBe(false); }
  });
  test("the console pass for a PS5 game: PS5 dumps are certain and 'rom', an English region beats Asia, PS3 and PC are wrong, an unnamed dump is not taken on faith", () => {
    const v = rankReleases(q, rows, { platforms: ["ps5"] });
    const usa = by(v, "Demons.Souls.PS5"), asia = by(v, "Demon's Souls (2020) [PlayStation 5");
    expect(certainlyThisGame(usa)).toBe(true); expect(usa.flags.platform).toBe("ps5"); expect(installClass(usa)).toBe("rom");
    expect(certainlyThisGame(asia)).toBe(true); expect(usa.score).toBeGreaterThan(asia.score);
    expect(by(v, "Demon's Souls (2009)").flags.wrongKind).toBe("platform: PlayStation 3");
    expect(by(v, "Demons.Souls.EUR").flags.wrongKind).toBe("platform: PlayStation 3");
    expect(by(v, "Demon's Souls (2020) [Windows").flags.wrongKind).toBe("platform: PC");
    expect(by(v, "Demons Souls Remake").flags.wrongKind).toMatch(/names no console/);
    expect(v[0].title).toBe(usa.title);
  });
  test("any console (the game's platforms unknown): the PS3 dumps count as well — but the year rule still tells the 2009 game from the 2020 remake", () => {
    const v = rankReleases(q, rows, { platforms: CONSOLE_PLATFORMS });
    const old = by(v, "Demon's Souls (2009)");
    expect(old.flags.wrongKind).toBeNull(); expect(old.flags.yearOff).toBe(11); expect(certainlyThisGame(old)).toBe(false);
    expect(by(v, "Demons.Souls.EUR").flags.platform).toBe("ps3"); expect(certainlyThisGame(by(v, "Demons.Souls.EUR"))).toBe(true);
    expect(certainlyThisGame(by(rankReleases(buildQuery("Demon's Souls", null), rows, { platforms: CONSOLE_PLATFORMS }), "Demon's Souls (2009)"))).toBe(true);
  });
});

describe("the profile and the package", () => {
  const row = (settings: object) => ({ id: 1, name: "P", settings_json: JSON.stringify(settings), created_at: 0, updated_at: 0 }) as never;
  test("the console dump is the last format while the fallback is on, gone when it is off; an imported dump is of that format", () => {
    expect(parseProfile(row({})).formats.at(-1)).toBe("rom"); expect(parseProfile(row({})).consoleFallback).toBe(true);
    expect(parseProfile(row({ formats: ["clean", "iso"] })).formats).toEqual(["clean", "iso", "rom"]);
    expect(parseProfile(row({ formats: ["clean", "rom", "iso"] })).formats).toEqual(["clean", "rom", "iso"]);
    expect(parseProfile(row({ consoleFallback: false, formats: ["clean", "iso", "rom"] })).formats).toEqual(["clean", "iso"]);
    expect(classOfPackage({ manifest_json: JSON.stringify({ kind: "rom", source: { title: "Demons.Souls.PS5-BigBlueBox", protocol: "torrent" } }) })).toBe("rom");
    expect(classOfPackage({ manifest_json: JSON.stringify({ source: { title: "Hades [GOG Edition]", protocol: "torrent" } }) })).toBe("clean");
  });
});

describe("importing a console dump", () => {
  const ctx = () => ({ exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), tools: {} as never, log: () => {} }) as never;
  test("a package dump is copied whole and the package is the thing to launch; a PS3 JB folder is recognised by its marker", async () => {
    const dl = mkdtempSync(join(tmpdir(), "ludarr-rom-"));
    const input = join(dl, "Demons.Souls.PS5-BigBlueBox"); mkdirSync(input);
    writeFileSync(join(input, "PPSA01342.pkg"), new Uint8Array(6_000_000)); writeFileSync(join(input, "bbb.nfo"), "release notes");
    const r = await deterministic(input, join(dl, "staging"), ctx(), { name: "Demon's Souls", platform: "ps5" });
    expect(r.ok).toBe(true); expect(r.validation?.launch).toBe("PPSA01342.pkg"); expect(r.validation?.exeCandidates).toEqual([]);
    expect(r.steps.some(s => /copying as it is/.test(s))).toBe(true);
    const jb = join(dl, "Demons.Souls.EUR.PS3-BlaZe"); mkdirSync(join(jb, "PS3_GAME", "USRDIR"), { recursive: true });
    writeFileSync(join(jb, "PS3_GAME", "USRDIR", "EBOOT.BIN"), new Uint8Array(6_000_000)); writeFileSync(join(jb, "PS3_DISC.SFB"), "x");
    const v = await inspectRom(jb);
    expect(v.ok).toBe(true); expect(v.launch).toMatch(/PS3_DISC\.SFB|EBOOT\.BIN/i);
  });
  test("a PC port of a console game is a PC import: a FitGirl installer is never treated as a dump; a bare dump for one of the game's consoles is kept when no PC game comes out", async () => {
    const dl = mkdtempSync(join(tmpdir(), "ludarr-rom-"));
    const fg = join(dl, "Bloodborne [FitGirl Repack]"); mkdirSync(fg);
    writeFileSync(join(fg, "setup.exe"), new Uint8Array(6_000_000)); writeFileSync(join(fg, "fg-01.bin"), new Uint8Array(6_000_000));
    const r = await deterministic(fg, join(dl, "s1"), ctx(), { name: "Bloodborne", platform: null, consoles: ["ps4"] });
    expect(r.ok).toBe(false); expect(r.reason).not.toMatch(/no console image/); expect(r.platform ?? null).toBeNull();   // the PC installer path spoke, not the dump validator
    const dump = join(dl, "Demons.Souls.PS5-HomeRip"); mkdirSync(join(dump, "sce_sys"), { recursive: true });
    writeFileSync(join(dump, "sce_sys", "param.sfo"), "x"); writeFileSync(join(dump, "eboot.bin"), new Uint8Array(6_000_000));
    const r2 = await deterministic(dump, join(dl, "s2"), ctx(), { name: "Demon's Souls", platform: null, consoles: ["ps5"] });
    expect(r2.ok).toBe(true); expect(r2.platform).toBe("ps5"); expect(r2.validation?.launch).toMatch(/param\.sfo$/i);
    const r3 = await deterministic(dump, join(dl, "s3"), ctx(), { name: "Demon's Souls", platform: null, consoles: [] });
    expect(r3.ok).toBe(false); expect(r3.reason).toMatch(/no (archive|executable)/);                                  // a PC game: a dump is not a game folder
  });
  test("an unpacked folder that holds no image, package or ROM is refused; a leftover archive too", async () => {
    const d = mkdtempSync(join(tmpdir(), "ludarr-rom-")); writeFileSync(join(d, "readme.txt"), "x".repeat(6_000_000));
    expect((await inspectRom(d)).problems[0]).toMatch(/no console image/);
    writeFileSync(join(d, "game.iso"), new Uint8Array(6_000_000)); writeFileSync(join(d, "part.rar"), "x");
    expect((await inspectRom(d)).problems[0]).toMatch(/archives still inside/);
  });
  test("a comic, a book or an edition named after the game: comics are junk, their extra words are seen past articles and volume numbers; a PC port and an edition still pass", () => {
    const q = buildQuery("Bloodborne", null);
    const rows = [
      rel("Bloodborne_-_The_Death_of_Sleep_Deluxe_Edition_v01__2025___Collection___Titan_comics___Digital-HD___webp___LeDuch_", { protocol: "usenet" }),
      rel("Bloodborne v02: The Healing Thirst by Ales Kot [Volume 2: The Healing Thirst 2018] [CBR]"),
      rel("Bloodborne - The Death of Sleep (2025) (Digital) (Comics)"),
      rel("Bloodborne.v1.09.All.DLCs.+.Online.Recompiled.for.PC.v1.9.6-FitGirl.Repack"),
      rel("Bloodborne The Old Hunters Edition (2015) [PlayStation 4 / English / USA / Home Rip]"),
    ];
    const v = rankReleases(q, rows, { platforms: CONSOLE_PLATFORMS.concat("pc") });
    const find = (t: string) => v.find(x => x.title.includes(t))!;
    for (const t of ["Death_of_Sleep", "Healing Thirst", "(Comics)"]) { const r = find(t); expect(r.parsed.junk.length > 0 || r.flags.extraWords).toBe(true); expect(certainlyThisGame(r)).toBe(false); }
    expect(find("Healing Thirst").parsed.junk).toContain("comic / book"); expect(find("Healing Thirst").flags.extraWords).toBe(true);
    expect(certainlyThisGame(find("FitGirl"))).toBe(true); expect(installClass(find("FitGirl"))).toBe("repack"); expect(find("FitGirl").flags.extraWords).toBe(false);
    expect(find("Old Hunters").flags.extraWords).toBe(false);
  });
});
