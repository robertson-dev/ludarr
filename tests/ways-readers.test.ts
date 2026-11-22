/**
 * The identity readers on bytes of their real formats (tests/ways-images.ts writes them): a PS5 app0 folder and its
 * param.json as KytyPS5 reads it; a .zar (zstd and stored blocks, param.json across a block's end, long names, a root of
 * many entries); a UDF 2.50 image (the US retail disc of a PS5 game, sealed PPSA01342 01.00; a game folder made into an
 * image; extended and plain file entries, with and without a metadata partition, the metadata file's mirror); a .nup (the
 * base and its update, the main build stored and as a zstd frame cut short, a TOC too big to hash whole); PARAM.SFO for
 * PS4, PS3, PSP and Vita, in folders and on discs; NSP and XCI named as sealed. Random bytes and damaged files say nothing,
 * with a reason, and never throw; every read is small and counted; links are never followed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify, identifyFolder, identityKeys, readFolderIdentity, readIdentity, serialKeys, serialWord, SERIAL_PLATFORMS, NAMED, DEFINITIVE } from "../src/ways/identity";
import { Bytes, MAX_READ } from "../src/ways/readers/bytes";
import { readNup } from "../src/ways/readers/nup";
import { parseSfo } from "../src/ways/readers/sfo";
import { consoleOfTitle, regionName, regionOfContentId, regionOfSerial, sameVersion, shownVersion, TITLE_PREFIX, versionKey } from "../src/ways/readers/titles";
import { listUdf, readUdf, readUdfMember } from "../src/ways/readers/udf";
import { listZar, readZar, readZarMember } from "../src/ways/readers/zar";
import { sealedWhy } from "../src/ways/match";
import { bdParam, eboot, noise, nupFile, nso, ootNup, ps5Disc, ps5Param, ps5Pkg, sfo, sfoIso, udfImage, writeApp0, writeExefsFolder, writeSfoFolder, zarArchive } from "./ways-images";

const dir = mkdtempSync(join(tmpdir(), "ways-readers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (name: string, bytes: Uint8Array) => { const p = join(dir, `${++n}-${name}`); writeFileSync(p, bytes); return p; };
const folder = (name: string) => join(dir, `${++n}-${name}`);
/** a reader run over a file with a counted budget: what it found, and how many reads it took */
async function counted(path: string, reader: (b: Bytes) => Promise<{ identity: unknown; why: string | null }>, budget = 128) {
  const fh = await open(path, "r");
  try {
    const b = new Bytes(fh, (await fh.stat()).size, budget);
    const r = await reader(b);
    return { ...r, reads: b.reads, exhausted: b.exhausted };
  } finally { await fh.close(); }
}
const canLink = (() => { try { const t = join(dir, "link-probe"); writeFileSync(t + "-target", "x"); symlinkSync(t + "-target", t); return true; } catch { return false; } })();

describe("what a title id, a content id and a version say (data, tested)", () => {
  test("the title id's prefix names the console", () => {
    const cases: [string, string | null][] = [
      ["PPSA01342", "ps5"], ["PPSA-01341", "ps5"], ["CUSA00001", "ps4"], ["PLAS10001", "ps4"], ["PCSE00001", "vita"], ["PCSB00245", "vita"],
      ["BLUS30443", "ps3"], ["BCES00001", "ps3"], ["NPUB30001", "ps3"], ["NPEA00001", "ps3"], ["ULUS10041", "psp"], ["UCES00001", "psp"], ["NPJH50001", "psp"],
      ["SLUS21678", null], ["TEST00001", null], ["", null], ["PPSA0134", null],
    ];
    for (const [id, p] of cases) expect([id, consoleOfTitle(id)]).toEqual([id, p]);
    expect(TITLE_PREFIX.length).toBeGreaterThanOrEqual(5);
  });
  test("a content id's store and a PS3 / PSP serial's third letter are the region", () => {
    expect(regionOfContentId("UP9000-PPSA01342_00-DEMONSSOULS00000")).toBe("US");
    expect(regionOfContentId("EP9000-PPSA01341_00-DEMONSSOULS00000")).toBe("EU");
    expect(regionOfContentId("JP9000-PPSA01340_00-DEMONSSOULS00000")).toBe("JP");
    expect(regionOfContentId("HP9000-PPSA01343_00-DEMONSSOULS00000")).toBe("ASIA");
    expect(regionOfContentId("KP9000-PPSA01344_00-DEMONSSOULS00000")).toBe("KR");
    expect(regionOfContentId("UP9000-PPSA01342_00-SHORT")).toBeUndefined();
    expect([regionOfSerial("BLUS30443"), regionOfSerial("ULES00001"), regionOfSerial("NPJB00001"), regionOfSerial("BLAS50001")]).toEqual(["US", "EU", "JP", "ASIA"]);
    expect([regionName("USA"), regionName("NTSC-U"), regionName("pal"), regionName("Japan"), regionName("world"), regionName("nowhere")]).toEqual(["US", "US", "EU", "JP", "WORLD", null]);
  });
  test("versions compare by number; a Switch title version only with its own kind; PlayStation versions are shown as 1.07", () => {
    expect([versionKey("01.007.000"), versionKey("1.07"), versionKey("1.7"), versionKey("01.00"), versionKey("v196608")]).toEqual(["1.7", "1.7", "1.7", "1", "196608"]);
    expect(sameVersion("01.007.000", "1.07")).toBe(true);
    expect(sameVersion("01.005.000", "1.07")).toBe(false);
    expect(sameVersion("1.50", "1.5")).toBe(false);
    expect(sameVersion("v196608", "196608")).toBe(false);
    expect([shownVersion("01.007.000"), shownVersion("01.005.000"), shownVersion("01.00"), shownVersion("1.1.1"), shownVersion("v196608")]).toEqual(["1.07", "1.05", "1.00", "1.1.1", "v196608"]);
  });
  test("serial keys: title ids in any spelling, a content id holding one, a Switch title id with or without 0x", () => {
    expect(serialKeys("ps5", "PPSA-01342")).toEqual(["SER:PPSA01342"]);
    expect(serialKeys("ps5", "UP9000-PPSA01342_00-DEMONSSOULS00000")).toEqual(["SER:PPSA01342"]);
    expect(serialKeys("ps3", "BLUS-30443")).toEqual(["SER:BLUS30443"]);
    expect(serialKeys("switch", "0x0400486024dec000")).toEqual(["TID:0400486024DEC000"]);
    expect(identityKeys({ platform: "switch", serial: "0400486024DEC000", titles: ["0400486024DEC000", "0400486024DEC800"] })).toEqual(["TID:0400486024DEC000", "TID:0400486024DEC800"]);
    expect([serialWord("ps5"), serialWord("switch"), serialWord("ps2"), serialWord("psp")]).toEqual(["title id", "title id", "serial", "serial"]);
    for (const p of ["ps3", "ps4", "ps5", "psp", "vita", "switch"] as const) { expect(SERIAL_PLATFORMS.has(p)).toBe(true); expect(NAMED.has(p)).toBe(true); expect(DEFINITIVE.has(p)).toBe(false); }
  });
});

describe("PARAM.SFO (PS4, PS3, PSP, Vita)", () => {
  test("an SFO's fields: text and numbers, every offset checked", () => {
    const f = parseSfo(sfo({ TITLE_ID: "CUSA00001", APP_VER: "01.07", ATTRIBUTE: 12, TITLE: "Synthetic" }))!;
    expect(f.get("TITLE_ID")).toBe("CUSA00001");
    expect(f.get("ATTRIBUTE")).toBe(12);
    expect(parseSfo(noise(200))).toBeNull();
    const bad = sfo({ TITLE_ID: "CUSA00001" }); bad[0x14 + 12] = 0xff;                       // the data offset past the end
    expect(parseSfo(bad)).toBeNull();
    expect(parseSfo(sfo({ TITLE_ID: "CUSA00001" }).subarray(0, 0x20))).toBeNull();
  });
  test("a PS4 game folder: title id, version, category, content id and its store; a patch and an add-on say so", async () => {
    const base = { TITLE_ID: "CUSA00001", APP_VER: "01.07", VERSION: "01.00", CATEGORY: "gd", CONTENT_ID: "UP0001-CUSA00001_00-SYNTHETICGAME000", TITLE: "Synthetic Four" };
    expect(await readFolderIdentity(writeSfoFolder(folder("ps4"), base))).toEqual({ platform: "ps4", serial: "CUSA00001", internalName: "Synthetic Four", region: "US", version: "01.07", category: "game", contentId: "UP0001-CUSA00001_00-SYNTHETICGAME000", shape: "folder" });
    expect((await readFolderIdentity(writeSfoFolder(folder("ps4p"), { ...base, CATEGORY: "gp" })))!.category).toBe("patch");
    expect((await readFolderIdentity(writeSfoFolder(folder("ps4a"), { ...base, CATEGORY: "ac" }, { eboot: false })))!.category).toBe("addon");
    // the game itself without its program is not a whole game folder
    const r = await identifyFolder(writeSfoFolder(folder("ps4n"), base, { eboot: false }));
    expect(r.identity).toBeNull();
    expect(r.why).toContain("no eboot.bin");
  });
  test("a Vita folder, a PS3 disc folder and a PS3 game as the console installs it, a PSP UMD folder", async () => {
    expect(await readFolderIdentity(writeSfoFolder(folder("vita"), { TITLE_ID: "PCSE00001", APP_VER: "01.00", CATEGORY: "gd", CONTENT_ID: "EP0001-PCSE00001_00-SYNTHETICVITA000" }))).toMatchObject({ platform: "vita", serial: "PCSE00001", region: "EU", category: "game" });
    expect(await readFolderIdentity(writeSfoFolder(folder("ps3"), { TITLE_ID: "BLUS30443", APP_VER: "01.00", CATEGORY: "DG", TITLE: "Synthetic Three" }, { at: "PS3_GAME" }))).toEqual({ platform: "ps3", serial: "BLUS30443", internalName: "Synthetic Three", region: "US", version: "01.00", category: "game", shape: "folder" });
    expect(await readFolderIdentity(writeSfoFolder(folder("ps3u"), { TITLE_ID: "BLES00001", APP_VER: "01.02", CATEGORY: "GD" }, { at: "PS3_GAME" }))).toMatchObject({ platform: "ps3", region: "EU", category: "patch", version: "01.02" });
    expect(await readFolderIdentity(writeSfoFolder(folder("ps3hdd"), { TITLE_ID: "NPUB30001", APP_VER: "01.00", CATEGORY: "HG" }, { at: "root" }))).toMatchObject({ platform: "ps3", serial: "NPUB30001", category: "game" });
    expect(await readFolderIdentity(writeSfoFolder(folder("psp"), { DISC_ID: "ULUS10041", DISC_VERSION: "1.01", CATEGORY: "UG" }, { at: "PSP_GAME" }))).toMatchObject({ platform: "psp", serial: "ULUS10041", version: "1.01", category: "game", region: "US" });
  });
  test("a title id the place does not hold, or none at all, says nothing (with the reason)", async () => {
    const psp = await identifyFolder(writeSfoFolder(folder("misplaced"), { TITLE_ID: "ULUS10041", CATEGORY: "gd" }));
    expect(psp.identity).toBeNull();
    expect(psp.why).toContain("ULUS10041");
    const none = await identifyFolder(writeSfoFolder(folder("noid"), { TITLE: "nothing here" }));
    expect(none.why).toBe("sce_sys/param.sfo names no title id");
  });
  test("a PSP UMD and a PS3 disc as ISO 9660: PARAM.SFO one folder down", async () => {
    expect(await readIdentity(file("umd.iso", sfoIso({ DISC_ID: "ULUS10041", DISC_VERSION: "1.00", CATEGORY: "UG", TITLE: "Synthetic Portable" })), "psp")).toEqual({ platform: "psp", serial: "ULUS10041", internalName: "Synthetic Portable", region: "US", version: "1.00", category: "game", shape: "iso" });
    expect(await readIdentity(file("ps3.iso", sfoIso({ TITLE_ID: "BCES00001", APP_VER: "01.00", CATEGORY: "DG" }, "PS3_GAME")), null)).toMatchObject({ platform: "ps3", serial: "BCES00001", region: "EU" });
  });
});

describe("a PS5 game folder's sce_sys/param.json, as KytyPS5 reads it", () => {
  test("title id, content id and its store, contentVersion, the default language's title, category 0 = the game", async () => {
    expect(await readFolderIdentity(writeApp0(folder("app0")))).toEqual({
      platform: "ps5", serial: "PPSA01341", contentId: "EP9000-PPSA01341_00-SYNTHETICGAME000", region: "EU", version: "01.007.000",
      internalName: "Synthetic Souls", category: "game", shape: "folder",
    });
    const r = await identifyFolder(writeApp0(folder("app0m")));
    expect(r.markers).toEqual(["sce_sys/param.json", "eboot.bin"]);
  });
  test("a byte order mark is stripped; appVersion stands in only when there is no contentVersion", async () => {
    expect((await readFolderIdentity(writeApp0(folder("bom"), { bom: true })))!.serial).toBe("PPSA01341");
    expect((await readFolderIdentity(writeApp0(folder("both"), { version: "01.005.000", appVersion: "01.007.000" })))!.version).toBe("01.005.000");
    const onlyApp = folder("onlyapp");
    writeApp0(onlyApp, { extra: { contentVersion: undefined, appVersion: "01.005.000" } });
    expect((await readFolderIdentity(onlyApp))!.version).toBe("01.005.000");
  });
  test("another category is an application; an add-on (no applicationCategoryType, a content id, no eboot.bin) says so", async () => {
    expect((await readFolderIdentity(writeApp0(folder("media"), { category: 65536 })))!.category).toBe("app");
    expect(await readFolderIdentity(writeApp0(folder("addon"), { category: null, eboot: false, contentId: "EP9000-PPSA01341_00-DLCSYNTHETIC0001" }))).toMatchObject({ platform: "ps5", category: "addon", serial: "PPSA01341" });
    // no applicationCategoryType but the game's program there: nothing said about what it is
    expect((await readFolderIdentity(writeApp0(folder("unsaid"), { category: null })))!.category).toBeUndefined();
  });
  test("an application's param.json without eboot.bin is not a whole game folder; a title id of another console names none", async () => {
    const r = await identifyFolder(writeApp0(folder("noboot"), { eboot: false }));
    expect(r.identity).toBeNull();
    expect(r.why).toBe("it has no eboot.bin beside sce_sys, so it is not a whole PS5 game folder");
    const ps4 = await identifyFolder(writeApp0(folder("ps4id"), { titleId: "CUSA00001" }));
    expect(ps4.why).toBe("its sce_sys/param.json names CUSA00001, which is not a PlayStation 5 title id");
    const broken = folder("broken");
    mkdirSync(join(broken, "sce_sys"), { recursive: true });
    writeFileSync(join(broken, "sce_sys", "param.json"), "{ not json");
    expect((await identifyFolder(broken)).why).toBe("its sce_sys/param.json is not JSON");
    expect((await identifyFolder(join(dir, "nothing-here"))).why).toBe("it is not there");
  });
  test.skipIf(!canLink)("a link is never followed: neither a linked folder nor a linked param.json says anything", async () => {
    const real = writeApp0(folder("real"));
    const linked = folder("linked");
    symlinkSync(real, linked, "dir");
    expect((await identifyFolder(linked)).why).toBe("it is a link, and ludarr never follows one");
    const viaLink = folder("vialink");
    mkdirSync(join(viaLink, "sce_sys"), { recursive: true });
    writeFileSync(join(viaLink, "eboot.bin"), eboot());
    symlinkSync(join(real, "sce_sys", "param.json"), join(viaLink, "sce_sys", "param.json"));
    expect((await identifyFolder(viaLink)).identity).toBeNull();
  });
});

describe("a .zar (ZArchive @ d2c71773)", () => {
  const game = (extra: { path: string; data: Uint8Array | string }[] = [], o: { raw?: boolean } = {}) =>
    zarArchive([{ path: "sce_sys/param.json", data: ps5Param() }, { path: "sce_sys/icon0.png", data: noise(300, 2) }, { path: "eboot.bin", data: eboot() }, ...extra], o);
  /** the archive's offset record sizes (+1), from its footer */
  const blockSizes = (z: Uint8Array) => {
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength), f = z.length - 144;
    const recOff = Number(v.getBigUint64(f + 16)), recSize = Number(v.getBigUint64(f + 24));
    const out: number[] = [];
    for (let r = 0; r * 40 < recSize; r++) for (let i = 0; i < 16; i++) out.push(v.getUint16(recOff + r * 40 + 8 + i * 2) + 1);
    return out;
  };

  test("the PS5 identity of its sce_sys/param.json, with eboot.bin at its root; zstd blocks and stored ones", async () => {
    const z = game([{ path: "data/pad.bin", data: new Uint8Array(70_000) }, { path: "data/level.bin", data: noise(200_000, 4) }]);
    const sizes = blockSizes(z);
    expect(sizes[0]).toBeLessThan(65536);                                     // param.json's block: one zstd frame
    expect(sizes.slice(2, 4)).toEqual([65536, 65536]);                         // the noise: stored as it is
    const r = await identify(file("game.zar", z), "ps5");
    expect(r.identity).toEqual({ platform: "ps5", serial: "PPSA01341", contentId: "EP9000-PPSA01341_00-SYNTHETICGAME000", region: "EU", version: "01.007.000", internalName: "Synthetic Souls", category: "game", shape: "zar" });
    expect(r.markers).toEqual(["sce_sys/param.json", "eboot.bin"]);
    expect(await readIdentity(file("raw.zar", game([], { raw: true })), null)).toMatchObject({ serial: "PPSA01341", shape: "zar" });
  });
  test("param.json across a block's end, a root of 600 entries and names longer than 127 bytes: still a few small reads", async () => {
    const long = "x".repeat(200) + ".bin";
    const many = Array.from({ length: 600 }, (_, i) => ({ path: `file-${String(i).padStart(4, "0")}.dat`, data: noise(10, i) }));
    const z = zarArchive([{ path: "lead.bin", data: noise(65536 - 300, 9) }, { path: "sce_sys/param.json", data: ps5Param({ title: "Across A Block" }) }, { path: long, data: "y" }, { path: "eboot.bin", data: eboot() }, ...many]);
    const r = await counted(file("wide.zar", z), readZar);
    expect(r.identity).toMatchObject({ internalName: "Across A Block", serial: "PPSA01341" });
    expect(r.reads).toBeLessThanOrEqual(12);
    const listed = await listZar(file("wide2.zar", z), 1000);
    expect(listed.members.find(m => m.path === long)).toEqual({ path: long, size: 1, dir: false });
    expect(listed.members.filter(m => m.path.startsWith("file-")).length).toBe(600);
    expect(new TextDecoder().decode(await readZarMember(file("wide3.zar", z), "SCE_SYS/Param.json", 1 << 20))).toContain("Across A Block");
  });
  test("no eboot.bin at its root: not a packed game folder; an add-on's archive says it is one", async () => {
    const r = await identify(file("noboot.zar", zarArchive([{ path: "sce_sys/param.json", data: ps5Param() }, { path: "data.bin", data: noise(10) }])), "ps5");
    expect(r.identity).toBeNull();
    expect(r.why).toBe("it holds no eboot.bin at its root, so it is not a packed PS5 game folder");
    const addon = zarArchive([{ path: "sce_sys/param.json", data: ps5Param({ category: null, contentId: "EP9000-PPSA01341_00-DLCSYNTHETIC0001" }) }, { path: "dlc.bin", data: noise(10) }]);
    expect(await readIdentity(file("addon.zar", addon), "ps5")).toMatchObject({ category: "addon" });
    expect((await identify(file("nosys.zar", zarArchive([{ path: "eboot.bin", data: eboot() }])), "ps5")).why).toBe("it holds no sce_sys folder at its root, so nothing in it says which game it is");
  });
  test("random bytes, a cut-short archive, a damaged block or tree say nothing, with the reason, and never throw", async () => {
    expect((await identify(file("noise.zar", noise(300_000, 13)), "ps5")).why).toBe("its last bytes are not a ZArchive footer");
    const z = game();
    expect((await identify(file("cut.zar", z.subarray(0, z.length - 10)), "ps5")).why).toBe("its last bytes are not a ZArchive footer");
    const padded = new Uint8Array(z.length + 7); padded.set(z, 7);
    const shifted = await identify(file("pad.zar", padded), "ps5");
    expect(shifted.why).toContain("cut short or has bytes added");
    const damaged = z.slice(); for (let i = 8; i < 60; i++) damaged[i] ^= 0x5a;  // inside param.json's zstd frame
    const d = await identify(file("damaged.zar", damaged), "ps5");
    expect(d.identity).toBeNull();
    expect(d.why).toMatch(/zstd data is damaged|not JSON|does not unpack/);
    const tree = z.slice(); const f = tree.length - 144;
    const treeOff = Number(new DataView(tree.buffer).getBigUint64(f + 48));
    tree[treeOff + 8] = 0xff;                                                  // the root's child count far past the tree
    expect((await identify(file("tree.zar", tree), "ps5")).why).toBe("a folder's entries lie outside the file tree");
    for (const cut of [0, 1, 100, 144, 145, 5000]) expect(await readIdentity(file(`c${cut}.zar`, z.subarray(0, cut)), "ps5")).toBeNull();
  });
});

describe("a UDF disc image", () => {
  test("the US retail disc of a PS5 game as a PC drive reads it: bd/param.json names it, its game is in an encrypted package — sealed", async () => {
    const p = file("bbb-ps5-01342.iso", ps5Disc());
    const r = await identify(p, "ps5");
    expect(r.identity).toEqual({
      platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", version: "01.00", contentId: "UP9000-PPSA01342_00-DEMONSSOULS00000", region: "US",
      category: "game", disc: 1, shape: "bd-image", sealed: true,
    });
    expect(r.markers).toEqual(["bd/param.json", "app/PPSA01342/app_0.pkg"]);
    expect(sealedWhy(r.identity!)).toBe("the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it");
    const c = await counted(p, readUdf);
    expect(c.reads).toBeLessThanOrEqual(24);
    // read whatever the hint: a disc says what it is
    expect((await readIdentity(p, null))!.sealed).toBe(true);
    expect((await readIdentity(p, "ps2"))!.platform).toBe("ps5");
  });
  test("plain file entries, no metadata partition, a damaged metadata file (its mirror read): the same disc", async () => {
    for (const [name, img] of [["fe.iso", ps5Disc({ efe: false })], ["plain.iso", ps5Disc({ metadata: false })], ["mirror.iso", udfImage({ corruptMetadata: true, files: [{ path: "bd/param.json", data: bdParam({ masterVersion: "01.04" }) }] })]] as const) {
      const id = await readIdentity(file(name, img), "ps5");
      expect([name, id?.serial, id?.sealed]).toEqual([name, "PPSA01342", true]);
    }
  });
  test("a game folder made into an image is that folder: not sealed", async () => {
    const img = udfImage({ files: [{ path: "sce_sys/param.json", data: ps5Param({ version: "01.005.000" }) }, { path: "eboot.bin", data: eboot() }, { path: "data/x.bin", data: noise(5000) }] });
    expect(await readIdentity(file("app0.iso", img), null)).toEqual({ platform: "ps5", serial: "PPSA01341", contentId: "EP9000-PPSA01341_00-SYNTHETICGAME000", region: "EU", version: "01.005.000", internalName: "Synthetic Souls", category: "game", shape: "iso" });
    const both = udfImage({ files: [{ path: "bd/param.json", data: bdParam() }, { path: "sce_sys/param.json", data: ps5Param() }, { path: "eboot.bin", data: eboot() }] });
    expect((await readIdentity(file("open-disc.iso", both), "ps5"))!.sealed).toBe(false);
  });
  test("names written as UTF-16, and a PS4 game folder made into an image (read for a ps4 way whatever its name)", async () => {
    expect(await readIdentity(file("u16.iso", udfImage({ utf16: true, files: [{ path: "bd/param.json", data: bdParam() }] })), "ps5")).toMatchObject({ serial: "PPSA01342", sealed: true });
    const ps4 = udfImage({ files: [{ path: "sce_sys/param.sfo", data: sfo({ TITLE_ID: "CUSA00001", APP_VER: "01.00", CATEGORY: "gd", CONTENT_ID: "UP0001-CUSA00001_00-SYNTHETICGAME000" }) }, { path: "eboot.bin", data: eboot() }] });
    expect(await readIdentity(file("ps4.img", ps4), "ps4")).toMatchObject({ platform: "ps4", serial: "CUSA00001", region: "US", category: "game", shape: "iso" });
  });
  test("a look that runs out of reads finds nothing and says so", async () => {
    const z = file("tight.zar", zarArchive([{ path: "sce_sys/param.json", data: ps5Param() }, { path: "eboot.bin", data: eboot() }]));
    const r = await counted(z, readZar, 3);
    expect(r).toMatchObject({ identity: null, exhausted: true, why: "it needs more reads than a quick look allows" });
    const d = await counted(file("tight.iso", ps5Disc()), readUdf, 6);
    expect(d.identity).toBeNull();
    expect(d.exhausted).toBe(true);
  });
  test("listing and one member, by ludarr's own reader", async () => {
    const p = file("list.iso", ps5Disc());
    const l = await listUdf(p);
    expect(l.members.map(m => m.path)).toEqual(expect.arrayContaining(["bd", "bd/param.json", "app/PPSA01342/app_0.pkg", "PS5/UPDATE/PS5UPDATE.PUP"]));
    expect(l.members.find(m => m.path === "app/PPSA01342/app_0.pkg")!.size).toBe(8192);
    const pj = await readUdfMember(p, "bd/param.json", 1 << 20);
    expect(new TextDecoder().decode(pj.subarray(0, 6))).toBe("SCECDF");
    await expect(readUdfMember(p, "bd/nothing.json", 1 << 20)).rejects.toThrow("it holds no bd/nothing.json");
  });
  test("random bytes, a disc without bd/param.json's header, a cut image say nothing with the reason", async () => {
    expect((await identify(file("noise.iso", noise(1 << 20, 17)), null)).why).toBe("it holds no UDF anchor at sector 256");
    const bad = udfImage({ files: [{ path: "bd/param.json", data: "{\"disc\":[{\"masterDataId\":\"PPSA01342\"}]}" }] });
    expect((await identify(file("nohead.iso", bad), "ps5")).why).toBe("its bd/param.json does not start as a PS5 disc's does (SCECDF)");
    const img = ps5Disc();
    for (const cut of [0, 2048 * 256, 2048 * 257, 2048 * 301, img.length - 2048]) {
      const got = await readIdentity(file(`cut${cut}.iso`, img.subarray(0, cut)), "ps5").then(() => "read", e => `threw ${e}`);
      expect(got).toBe("read");
    }
    const blank = udfImage({ files: [{ path: "readme.txt", data: "hello" }] });
    expect((await identify(file("blank.iso", blank), null)).why).toContain("no bd/param.json and no sce_sys folder at its root");
  });
});

describe("a .nup (NX2navi's tools/nup.py layout)", () => {
  const BUILD = "e0f3ccfaf50065ae4ea01eb5aeb13b1a" + "0".repeat(32);
  test("the base and its update: every title id, the update's version, the newest main program's build", async () => {
    const r = await counted(file("oot.nup", ootNup()), readNup);
    expect(r.identity).toEqual({ platform: "switch", serial: "0400486024DEC000", titles: ["0400486024DEC000", "0400486024DEC800"], version: "v196608", category: "game", shape: "nup", build: BUILD });
    expect(r.reads).toBeLessThanOrEqual(6);
    expect((await identify(file("oot2.nup", ootNup()), "switch")).markers).toEqual(["update 0400486024DEC800 v196608: exefs/main"]);
  });
  test("a main stored as one zstd frame is decoded from the start of its frame only", async () => {
    const r = await counted(file("ootz.nup", ootNup({ zstd: true, mainSize: 900 * 1024 })), readNup);
    expect((r.identity as { build: string }).build).toBe(BUILD);
    expect(r.reads).toBeLessThanOrEqual(10);
  });
  test("only the update is a patch; only the base gives the base's build; another title's build is that build", async () => {
    expect(await readIdentity(file("upd.nup", ootNup({ onlyUpdate: true })), "switch")).toMatchObject({ category: "patch", serial: "0400486024DEC800", version: "v196608" });
    expect(await readIdentity(file("base.nup", ootNup({ noUpdate: true })), "switch")).toMatchObject({ category: "game", version: "v0", build: "aaaaaaaabbbbbbbb" + "0".repeat(48) });
    expect(await readIdentity(file("other.nup", ootNup({ base: "0100F2C0115B6000", build: "1234567890abcdef" })), "switch")).toMatchObject({ serial: "0100F2C0115B6000", build: "1234567890abcdef" + "0".repeat(48) });
  });
  test("a TOC too big to hash whole is read where it is needed; its build still found", async () => {
    const romfs = Array.from({ length: 56_000 }, (_, i) => ({ name: `f${i}.bin`, data: new Uint8Array([i & 0xff]) }));
    const big = nupFile([
      { title: "0400486024DEC000", kind: 0, version: 0, exefs: [{ name: "main", data: nso("cafebabecafebabe") }], romfs },
      { title: "0400486024DEC800", kind: 1, version: 65536, exefs: [{ name: "main", data: nso("e0f3ccfaf50065ae") }] },
    ]);
    const r = await counted(file("big.nup", big), readNup);
    expect(r.identity).toMatchObject({ version: "v65536", build: "e0f3ccfaf50065ae" + "0".repeat(48) });
    expect(r.reads).toBeLessThanOrEqual(30);
  });
  test("a damaged TOC, random bytes, a cut file say nothing with the reason", async () => {
    expect((await identify(file("damaged.nup", nupFile([{ title: "0400486024DEC000", kind: 0, version: 0, exefs: [{ name: "main", data: nso("e0f3ccfa") }] }], { damageToc: true })), "switch")).why).toBe("its table of contents is damaged (its sha256 is not the one the file names)");
    expect((await identify(file("noise.nup", noise(4096, 3)), "switch")).why).toBe("it does not start as a .nup does (NUP and version 1)");
    const ok = ootNup();
    expect((await identify(file("cut.nup", ok.subarray(0, ok.length - 100)), "switch")).why).toBe("its table of contents lies outside the file (cut short?)");
    const noMain = nupFile([{ title: "0400486024DEC000", kind: 0, version: 0, exefs: [{ name: "main", data: noise(0x400) }] }]);
    const r = await identify(file("nomain.nup", noMain), "switch");
    expect(r.identity).toMatchObject({ serial: "0400486024DEC000" });
    expect(r.identity!.build).toBeUndefined();
    expect(r.why).toBe("its main program's build id could not be read");
  });
  test("an NSP names its title by its ticket and is sealed; an XCI is sealed", async () => {
    const names = ["0400486024dec0000000000000000005.tik", "0400486024dec0000000000000000005.cert", "a1b2c3.nca"];
    const strs = new TextEncoder().encode(names.join("\0") + "\0");
    const h = new Uint8Array(16 + names.length * 24 + strs.length + 64);
    h.set(new TextEncoder().encode("PFS0"), 0);
    new DataView(h.buffer).setUint32(4, names.length, true); new DataView(h.buffer).setUint32(8, strs.length, true);
    let so = 0;
    names.forEach((nm, i) => { new DataView(h.buffer).setUint32(16 + i * 24 + 16, so, true); so += nm.length + 1; });
    h.set(strs, 16 + names.length * 24);
    expect(await readIdentity(file("game.nsp", h), "switch")).toEqual({ platform: "switch", shape: "nsp", sealed: true, serial: "0400486024DEC000", titles: ["0400486024DEC000"] });
    const xci = new Uint8Array(0x400); xci.set(new TextEncoder().encode("HEAD"), 0x100);
    expect(await readIdentity(file("game.xci", xci), "switch")).toEqual({ platform: "switch", shape: "xci", sealed: true });
    expect(await readIdentity(file("noise.xci", noise(0x400)), "switch")).toBeNull();
  });
});

describe("every read is small, the budget holds, and nothing throws", () => {
  test("a read is at most 64 KiB; past the budget a read gives nothing and says so", async () => {
    const p = file("budget.bin", noise(300_000));
    const fh = await open(p, "r");
    try {
      const b = new Bytes(fh, 300_000, 3);
      expect((await b.at(0, 1 << 20)).length).toBe(MAX_READ);
      expect((await b.at(299_990, 100)).length).toBe(10);
      expect((await b.at(400_000, 10)).length).toBe(0);                      // past the end: not counted
      expect((await b.at(-1, 10)).length).toBe(0);
      expect((await b.span(0, 200_000)).length).toBe(MAX_READ);               // one read left of the three
      expect(b.exhausted).toBe(true);
      expect((await b.at(0, 10)).length).toBe(0);
      expect(b.reads).toBe(3);
    } finally { await fh.close(); }
  });
  test("every reader over every cut of its fixture: null or an identity, never a throw", async () => {
    const fixtures: [string, Uint8Array][] = [["g.zar", zarArchive([{ path: "sce_sys/param.json", data: ps5Param() }, { path: "eboot.bin", data: eboot() }])], ["d.iso", ps5Disc()], ["o.nup", ootNup({ zstd: true })], ["u.iso", sfoIso({ DISC_ID: "ULUS10041" })]];
    for (const [name, bytes] of fixtures) {
      for (const at of [1, 17, 128, 1000, 4096, Math.floor(bytes.length / 3), Math.floor(bytes.length / 2), bytes.length - 1]) {
        const flipped = bytes.slice(); flipped[at % flipped.length] ^= 0xff;
        const got = await readIdentity(file(name, flipped), null).catch(e => `threw ${e}`);
        expect(typeof got === "string" ? got : "ok").toBe("ok");
        const cut = await readIdentity(file(name, bytes.subarray(0, at)), null).catch(e => `threw ${e}`);
        expect(typeof cut === "string" ? cut : "ok").toBe("ok");
      }
    }
  });
  test.skipIf(!canLink)("a file given as a link is never followed", async () => {
    const real = file("real.zar", zarArchive([{ path: "sce_sys/param.json", data: ps5Param() }, { path: "eboot.bin", data: eboot() }]));
    const l = join(dir, `${++n}-link.zar`);
    symlinkSync(real, l);
    expect((await identify(l, "ps5")).why).toBe("it is a link, and ludarr never follows one");
  });
});

describe("the live copies, read in place (skeptic)", () => {
  test("Demon's Souls: the 54 GB copy and content row 1 are one disc, read in a few small reads whatever their size", async () => {
    // the package's file and the kept second copy of it (row 1): the same bytes under two names; the disc made large so a
    // read that walked its files would show
    const big = udfImage({ files: [
      { path: "bd/param.json", data: bdParam() },
      { path: "app/PPSA01342/app_0.pkg", data: ps5Pkg("UP9000-PPSA01342_00-DEMONSSOULS00000", 48 * 1024 * 1024) },
      { path: "app/PPSA01342/app_sc.pkg", data: noise(4096, 43) }, { path: "license/rif", data: noise(1024, 44) },
    ] });
    const pkg = file("bbb-ps5-01342.iso", big), row1 = file("row1-bbb-ps5-01342.iso", big);
    const a = await counted(pkg, readUdf), r = await counted(row1, readUdf);
    expect(a.identity).toEqual(r.identity);
    expect(a.identity).toMatchObject({ platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", region: "US", shape: "bd-image", sealed: true });
    expect(a.reads).toBeLessThanOrEqual(24);
    expect(a.reads * MAX_READ).toBeLessThan(big.length / 20);
  });
  test("a disc whose package names no content id in its first bytes: still sealed, the words leave the region out", async () => {
    const r = await identify(file("noid.iso", ps5Disc({ contentId: "" })), "ps5");
    expect(r.identity).toMatchObject({ serial: "PPSA01342", sealed: true, shape: "bd-image" });
    expect(r.identity!.region).toBeUndefined();
    expect(sealedWhy(r.identity!)).toBe("the retail disc as a PC drive reads it (PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it");
  });
  test("a metadata file whose map holds a run allocated but not recorded: later blocks keep their numbers", async () => {
    const id = await readIdentity(file("gap.iso", udfImage({ metaGap: 3, files: [{ path: "bd/param.json", data: bdParam() }, { path: "app/PPSA01342/app_0.pkg", data: ps5Pkg() }] })), "ps5");
    expect(id).toMatchObject({ serial: "PPSA01342", sealed: true, contentId: "UP9000-PPSA01342_00-DEMONSSOULS00000" });
  });
  test("NX2navi: a .nup's build and version are its base's own update's, never another title's packed beside it", async () => {
    const nup = nupFile([
      { title: "0400486024DEC000", kind: 0, version: 0, exefs: [{ name: "main", data: nso("aaaaaaaabbbbbbbb") }] },
      { title: "0400486024DEC800", kind: 1, version: 196608, exefs: [{ name: "main", data: nso("e0f3ccfaf50065ae") }] },
      { title: "0100F2C0115B6800", kind: 1, version: 999999, exefs: [{ name: "main", data: nso("1234567812345678") }] },
    ]);
    expect(await readIdentity(file("mixed.nup", nup), "switch")).toMatchObject({ serial: "0400486024DEC000", version: "v196608", category: "game", build: "e0f3ccfaf50065ae" + "0".repeat(48) });
  });
});

describe("a Switch game's folders (exefs and romfs) (skeptic)", () => {
  test("exefs/main names the program's build (NSO0, 0x40-0x60), as NX2navi's check reads it; no title id is read", async () => {
    const r = await identifyFolder(writeExefsFolder(folder("oot-folders")));
    expect(r.identity).toEqual({ platform: "switch", build: "e0f3ccfaf50065ae4ea01eb5aeb13b1a" + "0".repeat(32), shape: "folder" });
    expect(r.markers).toEqual(["exefs/main", "exefs/main.npdm", "romfs"]);
  });
  test("an exefs/main that is no NSO says so, and nothing in it is relied on", async () => {
    const r = await identifyFolder(writeExefsFolder(folder("not-nso"), undefined, { main: noise(0x400, 5) }));
    expect(r).toEqual({ identity: null, why: "its exefs/main is not a Switch program (no NSO0 header)" });
  });
});

describe("discs and SFOs, more (skeptic)", () => {
  test("an ISO 9660 disc that names no game says so, not that it lacks a UDF anchor", async () => {
    const iso = sfoIso({ DISC_ID: "ULUS10041", CATEGORY: "UG" });
    const root = iso.subarray(18 * 2048, 19 * 2048);
    const at = Buffer.from(root).indexOf("PSP_GAME");
    root.set(new TextEncoder().encode("DOC_GAME"), at);
    expect((await identify(file("pc.iso", iso), null)).why).toBe("its ISO 9660 file system names no game (no SYSTEM.CNF, PSX.EXE, PSP_GAME or PS3_GAME)");
  });
  test("a PSP update (CATEGORY PG) is the game's update, not the game", async () => {
    expect(await readIdentity(file("pg.iso", sfoIso({ DISC_ID: "ULUS10041", DISC_VERSION: "1.01", CATEGORY: "PG" })), "psp")).toMatchObject({ platform: "psp", category: "patch" });
  });
});
