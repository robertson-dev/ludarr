/**
 * match.ts over the content model v2: a game folder against a folder-kind way (and a folder never as one file), versions
 * by number, what the data is (the game, never its update or an add-on), program builds as prefixes, data sealed for the
 * console refused with its words unless the plan takes that very format, and the soft verdict: what a reader could not
 * tell never refuses a file, it only leaves it unproven (it waits for the admin). Then inputMatches() over a make's input:
 * shape, console, formats (multi-volume archives too), sealed, category, serials, versions and regions in any spelling.
 * The live shapes: KytyPS5's way for Demon's Souls before and after its widening, and NX2navi's .nup.
 */
import { describe, expect, test } from "bun:test";
import type { Identity } from "../src/ways/identity";
import { checksFiles, contentMatches, formatOf, inputMatches, proven, sealedWhy, type FileFacts } from "../src/ways/match";
import type { ContentPlan, MakeInput } from "../src/ways/types";

const facts = (name: string, identity: Identity | null, o: Partial<FileFacts> = {}): FileFacts => ({ platform: identity?.platform ?? "ps5", name, size: 1, hashes: { sha1: "a".repeat(40) }, identity, ...o });
const ps5 = (o: Partial<Identity> = {}): Identity => ({ platform: "ps5", serial: "PPSA01341", version: "01.007.000", category: "game", contentId: "EP9000-PPSA01341_00-DEMONSSOULS00000", region: "EU", shape: "zar", ...o });
/** the live Kyty way's content (DESIGN3-AMEND live facts): a disc of ps5, formats [zar], serials [PPSA01341], no versions */
const kyty = (accept: Partial<ContentPlan["accept"]> = {}): ContentPlan => ({
  kind: "disc", platform: "ps5", what: "Demon's Souls PS5 packed as one .zar", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"], ...accept }, place: "game/{name}",
});
/** the US retail disc on the server as the UDF reader reads it */
const disc: Identity = { platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", version: "01.00", contentId: "UP9000-PPSA01342_00-DEMONSSOULS00000", region: "US", category: "game", disc: 1, shape: "bd-image", sealed: true };

describe("a game folder, a game file", () => {
  const app0: ContentPlan = { kind: "folder", platform: "ps5", what: "the app0 folder", search: ["Demon's Souls"], accept: { hashes: [], serials: ["PPSA01341"] }, marker: "sce_sys/param.json", also: ["eboot.bin"], place: "game/app0" };
  test("a folder-kind way takes a folder (proven by its title id), never one file; a file way never takes a folder", () => {
    expect(contentMatches(app0, facts("PPSA01341-app0", ps5({ shape: "folder" }), { shape: "folder" }))).toEqual({ ok: true, why: null, serial: "PPSA01341" });
    expect(contentMatches(app0, facts("PPSA01341.zar", ps5()))).toEqual({ ok: false, why: "one file, and this needs the game folder (holding sce_sys/param.json)" });
    expect(contentMatches(kyty(), facts("PPSA01341-app0", ps5({ shape: "folder" }), { shape: "folder" }))).toEqual({ ok: false, why: "a folder, and this needs one .zar file" });
  });
  test("a folder its reader found nothing in is not refused for it: unproven, it waits for the admin", () => {
    const v = contentMatches(app0, facts("dump", null, { shape: "folder" }));
    expect(v).toEqual({ ok: true, why: null, unchecked: "nothing in it reads as a PlayStation 5 game folder" });
    expect(proven(v)).toBe(false);
  });
});

describe("versions, by number", () => {
  test("01.007.000 = 1.07 = 1.7; another version is refused with both shown as people write them", () => {
    for (const a of ["1.07", "01.007.000", "1.7"]) expect(contentMatches(kyty({ versions: [a] }), facts("g.zar", ps5()))).toMatchObject({ ok: true, version: a, serial: "PPSA01341" });
    expect(contentMatches(kyty({ versions: ["01.005.000", "01.007.000"] }), facts("g.zar", ps5({ version: "01.004.000" })))).toEqual({ ok: false, why: "version 1.04, and this takes 1.05 or 1.07" });
  });
  test("a version the data does not say, or one of another kind of number, never refuses", () => {
    expect(contentMatches(kyty({ versions: ["1.07"] }), facts("g.zar", ps5({ version: undefined })))).toMatchObject({ ok: true, serial: "PPSA01341", unchecked: "its version cannot be read" });
    const nx: ContentPlan = { kind: "rom", platform: "switch", what: "OoT", search: ["OoT"], accept: { hashes: [], formats: ["nup"], versions: ["1.1.1"] }, place: "dump/{name}" };
    expect(contentMatches(nx, facts("oot.nup", { platform: "switch", serial: "0400486024DEC000", version: "v196608", shape: "nup" }))).toMatchObject({ ok: true, unchecked: "its version v196608 is not the kind of number this way names (1.1.1)" });
  });
  test("a version alone proves nothing (1.07 of what?)", () => {
    const v = contentMatches({ ...kyty({ versions: ["1.07"] }), accept: { hashes: [], formats: ["zar"], versions: ["1.07"] } }, facts("g.zar", ps5()));
    expect(v).toMatchObject({ ok: true, version: "1.07" });
    expect(proven(v)).toBe(false);
  });
});

describe("what the data is", () => {
  test("an update, an add-on or an application is never the game; a way that takes an update takes one", () => {
    expect(contentMatches(kyty(), facts("p.zar", ps5({ category: "patch" })))).toEqual({ ok: false, why: "an update of the game, not the game itself" });
    expect(contentMatches(kyty(), facts("a.zar", ps5({ category: "addon" })))).toEqual({ ok: false, why: "an add-on, not the game" });
    expect(contentMatches(kyty(), facts("m.zar", ps5({ category: "app" })))).toEqual({ ok: false, why: "an application, not a game" });
    expect(contentMatches(kyty({ category: "patch" }), facts("p.zar", ps5({ category: "patch" })))).toMatchObject({ ok: true });
    expect(contentMatches(kyty({ category: "patch" }), facts("g.zar", ps5()))).toEqual({ ok: false, why: "the game itself, and this takes its update" });
    // data that does not say what it is is not refused for that
    expect(contentMatches(kyty(), facts("g.zar", ps5({ category: undefined })))).toMatchObject({ ok: true, serial: "PPSA01341" });
  });
});

describe("program builds", () => {
  const nx: ContentPlan = { kind: "rom", platform: "switch", what: "OoT", search: ["OoT"], accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"], builds: ["e0f3ccfa"] }, place: "dump/{name}" };
  const nup = (build?: string, o: Partial<Identity> = {}): Identity => ({ platform: "switch", serial: "0400486024DEC000", titles: ["0400486024DEC000", "0400486024DEC800"], version: "v196608", category: "game", shape: "nup", ...(build ? { build } : {}), ...o });
  test("a build matches as a prefix (8 hex or more) and proves the file; another build is refused", () => {
    const v = contentMatches(nx, facts("oot.nup", nup("e0f3ccfaf50065ae4ea01eb5aeb13b1a" + "0".repeat(32))));
    expect(v).toEqual({ ok: true, why: null, serial: "0400486024DEC000", build: "e0f3ccfa" });
    expect(proven(v)).toBe(true);
    expect(proven(contentMatches({ ...nx, accept: { hashes: [], formats: ["nup"], builds: ["E0F3CCFA"] } }, facts("oot.nup", nup("e0f3ccfaf50065ae"))))).toBe(true);
    expect(contentMatches(nx, facts("oot.nup", nup("1234567890abcdef")))).toEqual({ ok: false, why: "another build of the game (its main program is build 12345678…, and this takes e0f3ccfa…)" });
  });
  test("a build the reader could not see never refuses; another title id does; only the update is a patch", () => {
    expect(contentMatches(nx, facts("oot.nup", nup()))).toMatchObject({ ok: true, serial: "0400486024DEC000", unchecked: "its program's build cannot be read" });
    expect(contentMatches(nx, facts("totk.nup", nup("e0f3ccfa", { serial: "0100F2C0115B6000", titles: ["0100F2C0115B6000"] })))).toMatchObject({ ok: false, why: "another game (its title id is 0100F2C0115B6000, and this takes 0400486024DEC000)" });
    expect(contentMatches(nx, facts("upd.nup", nup("e0f3ccfa", { category: "patch", serial: "0400486024DEC800", titles: ["0400486024DEC800"] })))).toEqual({ ok: false, why: "an update of the game, not the game itself" });
    expect(checksFiles({ ...nx, accept: { hashes: [], builds: ["e0f3ccfa"] } })).toBe(true);
  });
});

describe("data sealed for the console", () => {
  test("the Demon's Souls copy on the server is refused with the sealed words, not as a format", () => {
    const v = contentMatches(kyty(), facts("bbb-ps5-01342.iso", disc));
    expect(v).toEqual({ ok: false, why: "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it" });
    // whatever the plan takes, unless it names that very format
    expect(contentMatches({ ...kyty(), accept: { hashes: [] } }, facts("bbb-ps5-01342.iso", disc)).ok).toBe(false);
  });
  test("a declared encrypted input reaches its recipe; undeclared formats and wrong identities still fail", () => {
    const nsp: Identity = { platform: "switch", shape: "nsp", sealed: true, serial: "0100F2C0115B6000", titles: ["0100F2C0115B6000"] };
    const emu: ContentPlan = { kind: "rom", platform: "switch", what: "a Switch game", search: ["x"], accept: { hashes: [], formats: ["nsp", "xci"] }, place: "games/{name}" };
    expect(contentMatches(emu, facts("g.nsp", nsp)).ok).toBe(true);
    expect(sealedWhy(nsp)).toBe("a Switch package (NSP) (0100F2C0115B6000): its game data requires matching keys and a plan that processes this format");
    expect(inputMatches({ shape: "file", platform: "switch", formats: ["nsp"] }, facts("g.nsp", nsp)).ok).toBe(true);
    expect(inputMatches({ shape: "file", platform: "switch", formats: ["zip"] }, facts("g.nsp", nsp)).ok).toBe(false);
    expect(inputMatches({ shape: "file", platform: "switch", formats: ["nsp"], serials: ["01007300020FA000"] }, facts("g.nsp", nsp))).toMatchObject({ ok: false, why: expect.stringContaining("another game") });
    expect(inputMatches({ shape: "file", platform: "ps4", formats: ["pkg"], serials: ["CUSA01127"] }, facts("PT.pkg", { platform: "ps4", sealed: true, serial: "CUSA01127", shape: "pkg" }))).toMatchObject({ ok: true, serial: "CUSA01127" });
  });
});

describe("the soft verdict and the console the bytes name", () => {
  test("a .zar whose reader found nothing is unproven, never refused; the old consoles keep their words", () => {
    const v = contentMatches(kyty(), facts("random.zar", null));
    expect(v).toEqual({ ok: true, why: null, unchecked: "nothing in it reads as a PlayStation 5 game" });
    // a disc image of a disc-kind way is a disc
    expect(contentMatches({ ...kyty(), accept: { hashes: [], formats: ["iso"] } }, facts("random.iso", null)).unchecked).toBe("nothing in it reads as a PlayStation 5 disc");
    expect(proven(v)).toBe(false);
    const ps2: ContentPlan = { kind: "disc", platform: "ps2", what: "x", search: ["x"], accept: { hashes: [], serials: ["SLUS-21678"] }, place: "g/{name}" };
    expect(contentMatches(ps2, facts("a.chd", null, { platform: "ps2" }))).toEqual({ ok: true, why: null, unchecked: "no serial can be read from it" });
  });
  test("a title id names its console: a PS4 folder is no PS5 game, whatever it was stored as", () => {
    expect(contentMatches(kyty(), facts("x.zar", { platform: "ps4", serial: "CUSA00001" }, { platform: "ps5" }))).toEqual({ ok: false, why: "a ps4 file, and this needs a ps5 one" });
  });
  test("a title id in any spelling, or a content id holding it, proves the file", () => {
    expect(contentMatches(kyty({ serials: ["PPSA-01341"] }), facts("g.zar", ps5()))).toMatchObject({ ok: true, serial: "PPSA-01341" });
    expect(contentMatches(kyty({ serials: ["EP9000-PPSA01341_00-DEMONSSOULS00000"] }), facts("g.zar", ps5()))).toMatchObject({ ok: true });
  });
});

describe("the live KytyPS5 way, before and after its widening", () => {
  const widened = kyty({ serials: ["PPSA01340", "PPSA01341", "PPSA01342"], versions: ["01.005.000", "01.007.000"] });
  test("before: the EU 1.07 .zar is proven; the US one is another game; the disc is sealed", () => {
    expect(proven(contentMatches(kyty(), facts("PPSA01341-app0.zar", ps5())))).toBe(true);
    expect(contentMatches(kyty(), facts("PPSA01342-app0.zar", ps5({ serial: "PPSA01342", region: "US" })))).toEqual({ ok: false, why: "another game (its title id is PPSA01342, and this takes PPSA01341)" });
  });
  test("after: the US 1.05 .zar is proven by its title id and version; a launch-day 1.00 dump is refused", () => {
    expect(contentMatches(widened, facts("PPSA01342-app0.zar", ps5({ serial: "PPSA01342", version: "01.005.000" })))).toEqual({ ok: true, why: null, serial: "PPSA01342", version: "01.005.000" });
    expect(contentMatches(widened, facts("PPSA01342-app0.zar", ps5({ serial: "PPSA01342", version: "01.000.000" })))).toEqual({ ok: false, why: "version 1.00, and this takes 1.05 or 1.07" });
    expect(contentMatches(widened, facts("bbb-ps5-01342.iso", disc)).why).toContain("encrypted for the console");
  });
});

describe("a make's input (inputMatches)", () => {
  const input = (o: Partial<MakeInput> = {}): MakeInput => ({ shape: "either", platform: "ps5", formats: ["zip", "7z", "rar"], marker: "sce_sys/param.json", also: ["eboot.bin"], serials: ["PPSA01340", "PPSA01341", "PPSA01342"], versions: ["01.005.000", "01.007.000"], ...o });
  const folderFacts = (id: Identity | null, o: Partial<FileFacts> = {}) => facts("PPSA01341-app0", id, { shape: "folder", ...o });
  test("a kept app0 folder of an accepted title and version fits; its marker is the make's to judge", () => {
    expect(inputMatches(input(), folderFacts(ps5({ shape: "folder" })))).toEqual({ ok: true, why: null, serial: "PPSA01341", version: "01.007.000" });
    expect(inputMatches(input({ shape: "folder", formats: undefined }), folderFacts(ps5({ shape: "folder" }))).ok).toBe(true);
  });
  test("shape: a folder input takes no file, a file input no folder", () => {
    expect(inputMatches(input({ shape: "folder", formats: undefined }), facts("g.rar", null))).toEqual({ ok: false, why: "one file, and this is made from the game folder (holding sce_sys/param.json)" });
    expect(inputMatches(input({ shape: "file" }), folderFacts(null))).toEqual({ ok: false, why: "a folder, and this is made from one .zip, .7z, .rar file" });
  });
  test("formats, a multi-volume archive's first part included; an archive's contents are judged once it is unpacked", () => {
    for (const name of ["Demons.Souls.part01.rar", "Demons.Souls.r00", "Demons.Souls.7z.001", "game.zip", "game.z01"]) expect([name, inputMatches(input(), facts(name, null)).ok]).toEqual([name, true]);
    expect(inputMatches(input(), facts("game.iso", null))).toEqual({ ok: false, why: "a .iso file, and this is made from .zip, .7z, .rar or the game folder" });
    expect(inputMatches(input(), facts("game.rar", null))).toEqual({ ok: true, why: null, unchecked: "no serial can be read from it; its version cannot be read" });
    expect([formatOf("x.part12.rar"), formatOf("x.7z.003"), formatOf("x.z05"), formatOf("x.ZIP")]).toEqual(["rar", "7z", "zip", "zip"]);
  });
  test("console, sealed, category, title id and version as for a game file", () => {
    expect(inputMatches(input(), folderFacts({ platform: "ps4", serial: "CUSA00001" }))).toEqual({ ok: false, why: "a ps4 file, and this is made from a ps5 one" });
    expect(inputMatches(input({ formats: ["iso"] }), facts("bbb-ps5-01342.iso", disc))).toMatchObject({ ok: false, why: expect.stringContaining("version 1.00") });
    expect(inputMatches(input(), folderFacts(ps5({ shape: "folder", category: "patch" })))).toEqual({ ok: false, why: "an update of the game, not the game itself" });
    expect(inputMatches(input(), folderFacts(ps5({ shape: "folder", serial: "PPSA09999" }))).why).toBe("another game (its title id is PPSA09999, and this takes PPSA01340, PPSA01341, PPSA01342)");
    expect(inputMatches(input(), folderFacts(ps5({ shape: "folder", version: "01.04" }))).why).toBe("version 1.04, and this takes 1.05 or 1.07");
    expect(inputMatches(input({ category: "patch" }), folderFacts(ps5({ shape: "folder", category: "patch" }))).ok).toBe(true);
  });
  test("regions in any spelling; a world release fits any; a region the data does not say never refuses", () => {
    expect(inputMatches(input({ regions: ["USA", "PAL"] }), folderFacts(ps5({ shape: "folder", region: "EU" }))).ok).toBe(true);
    expect(inputMatches(input({ regions: ["NTSC-U"] }), folderFacts(ps5({ shape: "folder", region: "JP" })))).toEqual({ ok: false, why: "a JP copy, and this is made from US copies" });
    expect(inputMatches(input({ regions: ["World"] }), folderFacts(ps5({ shape: "folder", region: "JP" }))).ok).toBe(true);
    expect(inputMatches(input({ regions: ["US"] }), folderFacts(ps5({ shape: "folder", region: undefined })))).toMatchObject({ ok: true, unchecked: "its region cannot be read" });
  });
});

describe("the live cases, as the run will meet them (skeptic)", () => {
  /** content row 1 (DESIGN3-AMEND live facts): the kept second copy of the 54 GB disc, source 'package', platform ps5 */
  const row1 = (identity: Identity | null): FileFacts => ({ platform: "ps5", name: "bbb-ps5-01342.iso", size: 54_200_000_000, hashes: { sha1: "b".repeat(40) }, identity, shape: "file" });
  /** the Kyty way after its upgrade round: the app0 folder (loose or in an archive) packed into one .zar */
  const kytyMake: MakeInput = { shape: "either", platform: "ps5", formats: ["rar", "7z", "zip"], marker: "sce_sys/param.json", also: ["eboot.bin"], serials: ["PPSA01340", "PPSA01341", "PPSA01342"], versions: ["01.005.000", "01.007.000"] };
  test("Demon's Souls way 1 [zar]: row 1 before the judge is refused for its form; once read, for being sealed — never taken", () => {
    expect(contentMatches(kyty(), row1(null))).toEqual({ ok: false, why: "a .iso file, and this needs .zar" });
    expect(contentMatches(kyty(), row1(disc))).toEqual({ ok: false, why: sealedWhy(disc) });
  });
  test("Demon's Souls: nothing is made from the disc — the make's input refuses row 1 with the sealed words, not its form", () => {
    expect(inputMatches(kytyMake, row1(disc))).toEqual({ ok: false, why: "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it" });
    // before the judge only its form is known
    expect(inputMatches(kytyMake, row1(null)).why).toBe("a .iso file, and this is made from .rar, .7z, .zip or the game folder");
  });
  test("a plan that names .iso for a PlayStation 5 still never takes the sealed disc (only a Switch NSP or XCI is taken as it is)", () => {
    const isoPlan: ContentPlan = { ...kyty(), accept: { hashes: [], formats: ["iso"], serials: ["PPSA01342"] } };
    expect(contentMatches(isoPlan, row1(disc))).toEqual({ ok: false, why: sealedWhy(disc) });
    const xci: Identity = { platform: "switch", shape: "xci", sealed: true };
    const emu: ContentPlan = { kind: "rom", platform: "switch", what: "a Switch game", search: ["x"], accept: { hashes: [], formats: ["xci"] }, place: "games/{name}" };
    expect(contentMatches(emu, facts("g.xci", xci, { platform: "switch" })).ok).toBe(true);
  });
  /** NX2navi as it is live (plan 2): a .nup of switch, its identity only in `what` */
  const nxV1: ContentPlan = { kind: "rom", platform: "switch", what: "The Legend of Zelda: Ocarina of Time (Switch 2) 1.1.1 as one .nup made with Eglantine", search: ["The Legend of Zelda: Ocarina of Time"], accept: { hashes: [], formats: ["nup"] }, place: "dump/{name}" };
  const nxV2: ContentPlan = { ...nxV1, accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"], builds: ["e0f3ccfaf50065ae4ea01eb5aeb13b1a"] } };
  const oot = (build: string): Identity => ({ platform: "switch", serial: "0400486024DEC000", titles: ["0400486024DEC000", "0400486024DEC800"], version: "v196608", category: "game", shape: "nup", build });
  test("NX2navi as it is live: the right .nup fits but proves nothing (held for the admin); after its upgrade the build proves it", () => {
    const v1 = contentMatches(nxV1, facts("oot.nup", oot("e0f3ccfaf50065ae4ea01eb5aeb13b1a" + "0".repeat(32)), { platform: "switch" }));
    expect(v1).toEqual({ ok: true, why: null });
    expect(proven(v1)).toBe(false);
    const v2 = contentMatches(nxV2, facts("oot.nup", oot("e0f3ccfaf50065ae4ea01eb5aeb13b1a" + "0".repeat(32)), { platform: "switch" }));
    expect(v2).toEqual({ ok: true, why: null, serial: "0400486024DEC000", build: "e0f3ccfaf50065ae4ea01eb5aeb13b1a" });
    expect(proven(v2)).toBe(true);
    // another version of the game (its main is another build) is refused by the upgraded plan
    expect(contentMatches(nxV2, facts("oot-1.0.nup", oot("aaaaaaaabbbbbbbb"), { platform: "switch" })).ok).toBe(false);
  });
  test("game 48's ordinary download: an NSP or an XCI of the game is refused with the sealed words, never taken for NX2navi", () => {
    const nsp: Identity = { platform: "switch", shape: "nsp", sealed: true, serial: "0400486024DEC000", titles: ["0400486024DEC000"] };
    expect(contentMatches(nxV1, facts("The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp.nsp", nsp, { platform: "switch" }))).toEqual({ ok: false, why: "a Switch package (NSP) (0400486024DEC000): its game data requires matching keys and a plan that processes this format" });
    expect(contentMatches(nxV2, facts("oot.xci", { platform: "switch", shape: "xci", sealed: true }, { platform: "switch" })).why).toBe("a Switch game card image (XCI): its game data requires matching keys and a plan that processes this format");
  });
  test("a make's input versions compare by number too (1.07 = 01.007.000)", () => {
    expect(inputMatches({ ...kytyMake, versions: ["1.05", "1.07"] }, { ...row1(null), name: "PPSA01341-app0", shape: "folder", identity: ps5({ shape: "folder" }) })).toMatchObject({ ok: true, version: "1.07", serial: "PPSA01341" });
  });
  test("Zelda 64: Recompiled (held): a hash-proving recomp plan still proves Majora's Mask by its sha1, whatever else v2 checks", () => {
    const mm: ContentPlan = { kind: "rom", platform: "n64", what: "Majora's Mask (USA)", search: ["Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: "d6133ace5afaa0882cf214cf88daba39e266c078" }], formats: ["z64"] }, normalize: "n64-z64", place: "mm.us.rev1.rom.z64" };
    const rom = (sha1: string): FileFacts => ({ platform: "n64", name: "Majora's Mask (USA).z64", size: 32 * 1024 * 1024, hashes: { sha1 }, identity: { platform: "n64", gameCode: "NZSE", region: "US", version: "1.0", internalName: "ZELDA MAJORA'S MASK" } });
    const v = contentMatches(mm, rom("d6133ace5afaa0882cf214cf88daba39e266c078"));
    expect(proven(v)).toBe(true);
    expect(contentMatches(mm, rom("0".repeat(40)))).toEqual({ ok: false, why: "not the version this needs (its sha1 is " + "0".repeat(40) + ")" });
  });
  test("NX2navi's other form, the exefs and romfs folders: a folder-kind way proves them by the main program's build", () => {
    const folderWay: ContentPlan = { kind: "folder", platform: "switch", what: "OoT's exefs and romfs", search: ["OoT"], accept: { hashes: [], builds: ["e0f3ccfaf50065ae"] }, marker: "exefs/main", also: ["romfs"], place: "game" };
    const v = contentMatches(folderWay, facts("oot-dump", { platform: "switch", build: "e0f3ccfaf50065ae4ea01eb5aeb13b1a" + "0".repeat(32), shape: "folder" }, { platform: "switch", shape: "folder" }));
    expect(v).toEqual({ ok: true, why: null, build: "e0f3ccfaf50065ae" });
    expect(proven(v)).toBe(true);
    // a folder whose reader found nothing waits for the admin
    expect(contentMatches(folderWay, facts("dump", null, { platform: "switch", shape: "folder" }))).toEqual({ ok: true, why: null, unchecked: "its program's build cannot be read" });
  });
});
