/**
 * What a game file's own bytes say it is (src/ways/identity.ts), read from synthetic images of each console's format, and
 * how match.ts checks it: serials and game codes in their every spelling, a file whose header carries none is not proven
 * (and not refused for that), and a header's title alone never accepts a file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc16, identityKeys, readIdentity, serialKeys } from "../src/ways/identity";
import { contentMatches, proven } from "../src/ways/match";
import type { ContentPlan } from "../src/ways/types";
import { discHead, gbaRom, gbRom, genesisRom, n64Rom, ndsRom, nintendoIso, psIso, rvzImage, snesRom, wbfsImage } from "./ways-images";

const dir = mkdtempSync(join(tmpdir(), "ways-identity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
async function idOf(bytes: Uint8Array, name: string, platform?: string) {
  const p = join(dir, `${++n}-${name}`);
  writeFileSync(p, bytes);
  return readIdentity(p, platform ?? null, name);
}

describe("reading a file's identity", () => {
  test("N64: the header in each byte order, put right first: title, game code, region, version", async () => {
    for (const order of ["z64", "v64", "n64"] as const) {
      expect(await idOf(n64Rom({ code: "NSYE", name: "SYNTH TEST ROM", version: 1, order }), `rom.${order}`)).toEqual({ platform: "n64", internalName: "SYNTH TEST ROM", gameCode: "NSYE", region: "US", version: "1.1" });
    }
    expect((await idOf(n64Rom({ code: "NSYP" }), "eu.z64"))!.region).toBe("EU");
    // a header with no game code to speak of says what else it has
    expect(await idOf(n64Rom({ code: "" }), "blank.z64")).toEqual({ platform: "n64", internalName: "SYNTH TEST ROM", version: "1.0" });
  });

  test("GameCube and Wii discs: the game id, disc, version and title; the magic word says which console", async () => {
    expect(await idOf(nintendoIso({ id: "GSYE01", title: "SYNTH CUBE" }), "game.iso")).toEqual({ platform: "gc", discId: "GSYE01", internalName: "SYNTH CUBE", region: "US", disc: 1, version: "0" });
    expect(await idOf(nintendoIso({ id: "RSYP01", wii: true }), "game.iso", "wii")).toMatchObject({ platform: "wii", discId: "RSYP01", region: "EU" });
    expect(await idOf(nintendoIso({ id: "GSYE01" }), "game.gcm")).toMatchObject({ platform: "gc", discId: "GSYE01" });
    // a .wbfs keeps the disc header at its first sector; .rvz / .wia in their second header, held to its SHA-1
    expect(await idOf(wbfsImage("RSYE01"), "game.wbfs")).toMatchObject({ platform: "wii", discId: "RSYE01" });
    expect(await idOf(rvzImage({ id: "GSYJ01" }), "game.rvz")).toMatchObject({ platform: "gc", discId: "GSYJ01", region: "JP" });
    expect(await idOf(rvzImage({ id: "RSYE01", wii: true, magic: "WIA" }), "game.wia")).toMatchObject({ platform: "wii", discId: "RSYE01" });
    expect(await idOf(rvzImage({ id: "GSYE01", corrupt: true }), "bad.rvz")).toBeNull();
    // a header whose disc type and magic word disagree says nothing
    const mixed = rvzImage({ id: "GSYE01" }); mixed.set(discHead({ id: "RSYE01", wii: true }).subarray(0, 0x80), 0x58);
    expect(await idOf(mixed, "mixed.rvz")).toBeNull();
  });

  test("PS2 and PS1: SYSTEM.CNF's boot line names the serial — in an .iso, and in a raw 2352-byte .bin", async () => {
    expect(await idOf(psIso({ boot: "cdrom0:\\SLUS_216.78;1", ver: "1.00", volume: "SYNTHPS2" }), "game.iso")).toEqual({ platform: "ps2", serial: "SLUS-21678", internalName: "SYNTHPS2", region: "US", version: "1.00" });
    expect(await idOf(psIso({ boot: "cdrom:\\SCES_123.45;1", ps1: true }), "game.iso", "ps1")).toMatchObject({ platform: "ps1", serial: "SCES-12345", region: "EU" });
    expect(await idOf(psIso({ boot: "cdrom:SLPS_000.01;1", ps1: true, raw: true, size: 4 * 1024 * 1024 }), "game.bin", "ps1")).toMatchObject({ platform: "ps1", serial: "SLPS-00001", region: "JP" });
    // a boot file that is no serial: the disc is still the console's, with nothing to check it by
    expect(await idOf(psIso({ boot: "cdrom0:\\MAIN.ELF;1" }), "homebrew.iso")).toMatchObject({ platform: "ps2", internalName: "SYNTHETIC" });
    expect((await idOf(psIso({ boot: "cdrom0:\\MAIN.ELF;1" }), "homebrew.iso"))!.serial).toBeUndefined();
  });

  test("cartridges: GBA, Game Boy (Color), DS, SNES (LoROM, HiROM, a copier header, an extended header), Mega Drive", async () => {
    expect(await idOf(gbaRom({ code: "BSYE", title: "SYNTHGBA" }), "game.gba")).toEqual({ platform: "gba", internalName: "SYNTHGBA", gameCode: "BSYE", region: "US", version: "0" });
    const bad = gbaRom(); bad[0xbd] ^= 1;
    expect(await idOf(bad, "bad.gba")).toBeNull();
    expect(await idOf(gbRom({ title: "SYNTHGB" }), "game.gb")).toEqual({ platform: "gb", internalName: "SYNTHGB", version: "0" });
    expect(await idOf(gbRom({ title: "SYNTHCOLOR", color: true, japan: true }), "game.gbc")).toEqual({ platform: "gbc", internalName: "SYNTHCOLOR", region: "JP", version: "0" });
    expect(await idOf(ndsRom({ code: "ASYJ" }), "game.nds")).toMatchObject({ platform: "nds", gameCode: "ASYJ", region: "JP", internalName: "SYNTHDS" });
    const nds = ndsRom(); nds[0x20] ^= 1;
    expect(await idOf(nds, "bad.nds")).toBeNull();                         // the header's CRC no longer holds
    expect(await idOf(snesRom({ title: "SYNTH LOROM" }), "game.sfc")).toEqual({ platform: "snes", internalName: "SYNTH LOROM", region: "US", version: "0" });
    expect(await idOf(snesRom({ hi: true, title: "SYNTH HIROM", region: 2 }), "game.sfc")).toMatchObject({ internalName: "SYNTH HIROM", region: "EU" });
    expect(await idOf(snesRom({ copier: true, title: "SYNTH COPIER" }), "game.smc")).toMatchObject({ platform: "snes", internalName: "SYNTH COPIER" });
    expect(await idOf(snesRom({ code: "ASYE" }), "game.sfc")).toMatchObject({ gameCode: "ASYE" });
    expect(await idOf(genesisRom({ serial: "GM 00001234-01", name: "SYNTH MD" }), "game.md")).toEqual({ platform: "genesis", serial: "GM 00001234-01", internalName: "SYNTH MD", region: "US", version: "01" });
    expect(await idOf(genesisRom(), "game.bin", "genesis")).toMatchObject({ platform: "genesis" });
    expect(await idOf(genesisRom({ system: "SEGA 32X" }), "game.32x", "genesis")).toBeNull();
  });

  test("what cannot be read deterministically says nothing: a .chd, an archive, random bytes, a cartridge without its header", async () => {
    expect(await idOf(nintendoIso({ id: "GSYE01" }), "game.chd")).toBeNull();
    expect(await idOf(psIso({ boot: "cdrom0:\\SLUS_216.78;1" }), "game.cso")).toBeNull();
    expect(await idOf(n64Rom(), "game.zip")).toBeNull();
    const noise = new Uint8Array(3 * 1024 * 1024);
    let x = 1; for (let i = 0; i < noise.length; i++) { x = (x * 1103515245 + 12345) >>> 0; noise[i] = x >>> 24; }
    for (const [name, p] of [["noise.iso", null], ["noise.z64", null], ["noise.gba", null], ["noise.nds", null], ["noise.sfc", null], ["noise.md", null], ["noise.bin", "ps2"]] as const) expect([name, await idOf(noise, name, p ?? undefined)]).toEqual([name, null]);
    expect(await readIdentity(join(dir, "missing.iso"))).toBeNull();
  });

  test("a disc says what it is whatever it was sent as: a GameCube disc read for a PS2 way is a GameCube disc", async () => {
    expect(await idOf(nintendoIso({ id: "GSYE01" }), "game.iso", "ps2")).toMatchObject({ platform: "gc" });
    expect(await idOf(psIso({ boot: "cdrom0:\\SLUS_216.78;1" }), "game.iso", "gc")).toMatchObject({ platform: "ps2" });
    expect(await idOf(n64Rom(), "game.bin", "genesis")).toMatchObject({ platform: "n64" });
  });

  test("the DS header's CRC-16 is MODBUS's (check value 0x4B37)", () => {
    expect(crc16(new TextEncoder().encode("123456789"))).toBe(0x4b37);
  });
});

describe("discs with no boot line", () => {
  /** an image's root folder record for SYSTEM.CNF given another name (the record keeps its length) */
  function rename(iso: Uint8Array, to: string): Uint8Array {
    const root = iso.subarray(18 * 2048, 19 * 2048);
    for (let off = 0; off < 2048 && root[off];) {
      const rl = root[off], nl = root[off + 32];
      if (new TextDecoder().decode(root.subarray(off + 33, off + 33 + nl)).startsWith("SYSTEM.CNF")) {
        root.fill(0, off + 33, off + 33 + nl); root.set(new TextEncoder().encode(to), off + 33); root[off + 32] = to.length;
      }
      off += rl;
    }
    return iso;
  }
  test("one of the first PlayStation discs (no SYSTEM.CNF, a PSX.EXE in its root) is a PlayStation disc with no serial; a disc with neither is nothing", async () => {
    expect(await idOf(rename(psIso({ boot: "cdrom:\\SLUS_000.01;1", ps1: true, volume: "SYNTH EARLY" }), "PSX.EXE;1"), "early.bin", "ps1")).toEqual({ platform: "ps1", internalName: "SYNTH EARLY" });
    expect(await idOf(rename(psIso({ boot: "cdrom:\\SLUS_000.02;1", ps1: true }), "PSX.EXE;1"), "early.iso", "ps2")).toMatchObject({ platform: "ps1" });
    expect(await idOf(rename(psIso({ boot: "cdrom0:\\SLUS_299.97;1" }), "SETUP.EXE;1"), "pc.iso", "ps2")).toBeNull();
  });
});

describe("serials, in every spelling", () => {
  test("a PS2 serial as SYSTEM.CNF, the catalog and a box spell it", () => {
    for (const s of ["SLUS-21678", "SLUS_216.78", "slus21678", "SLUS-21678-P", "SLUS 216.78"]) expect([s, serialKeys("ps2", s)]).toEqual([s, ["SER:SLUS21678"]]);
    expect(serialKeys("ps2", "SLES-55345/ANZ")).toEqual(["SER:SLES55345"]);
  });
  test("a GameCube id, its four-character code, a Redump box code; a cartridge's code and its box code", () => {
    expect(serialKeys("gc", "GZLE01")).toEqual(["ID:GZLE01"]);
    expect(serialKeys("gc", "gzle")).toEqual(["CODE:GZLE"]);
    expect(serialKeys("gc", "DL-DOL-GZLE-USA")).toEqual(["CODE:GZLE"]);
    expect(serialKeys("wii", "RVL-RMCE-USA")).toEqual(["CODE:RMCE"]);
    expect(serialKeys("n64", "NUS-NZSE-USA")).toEqual(["CODE:NZSE"]);
    expect(serialKeys("gba", "AGB-AXVE-USA")).toEqual(["CODE:AXVE"]);
    expect(serialKeys("n64", "NZSE")).toEqual(["CODE:NZSE"]);
    expect(serialKeys("genesis", "GM 00001234-01")).toEqual(["SER:GM0000123401", "SER:GM00001234"]);
  });
  test("an identity's keys: a disc id is matched as itself and by its code", () => {
    expect(identityKeys({ platform: "gc", discId: "GZLE01" })).toEqual(["ID:GZLE01", "CODE:GZLE"]);
    expect(identityKeys({ platform: "ps2", serial: "SLUS-21678" })).toEqual(["SER:SLUS21678"]);
    expect(identityKeys({ platform: "n64", gameCode: "NZSE", internalName: "ZELDA MAJORA'S MASK" })).toEqual(["CODE:NZSE"]);
    expect(identityKeys({ platform: "gb", internalName: "ANYTHING" })).toEqual([]);
    expect(identityKeys(null)).toEqual([]);
  });
});

describe("checking a file against the serials a way accepts", () => {
  const plan = (platform: ContentPlan["platform"], serials: string[], hashes: { algo: "sha1"; value: string }[] = []): ContentPlan => ({
    kind: platform === "n64" || platform === "gba" ? "rom" : "disc", platform, what: "a game", search: ["Synthetic Game"], accept: { hashes, serials }, normalize: null, place: "games/{name}",
  });
  const facts = (platform: string, name: string, identity: Parameters<typeof identityKeys>[0], sha1 = "a".repeat(40)) => ({ platform, name, size: 1, hashes: { sha1 }, identity });

  test("the right serial proves the file; another game's is refused, saying both", () => {
    const c = plan("ps2", ["SLUS-21678", "SLES-54206"]);
    const ok = contentMatches(c, facts("ps2", "a.iso", { platform: "ps2", serial: "SLUS-21678" }));
    expect(ok).toEqual({ ok: true, why: null, serial: "SLUS-21678" });
    expect(proven(ok)).toBe(true);
    const other = contentMatches(c, facts("ps2", "b.iso", { platform: "ps2", serial: "SLUS-20000" }));
    expect(other.ok).toBe(false);
    expect(other.why).toBe("another game (its serial is SLUS-20000, and this takes SLUS-21678, SLES-54206)");
    expect(contentMatches(plan("gc", ["DL-DOL-GZLE-USA"]), facts("gc", "z.rvz", { platform: "gc", discId: "GZLE01" }))).toMatchObject({ ok: true, serial: "DL-DOL-GZLE-USA" });
    expect(contentMatches(plan("gc", ["GZLE01"]), facts("gc", "z.iso", { platform: "gc", discId: "GZLE8P" })).ok).toBe(false);   // another maker's disc of that code
  });

  test("a file whose header carries no serial is not refused for it, and is not proven either", () => {
    const c = plan("ps2", ["SLUS-21678"]);
    const chd = contentMatches(c, facts("ps2", "a.chd", null));
    expect(chd).toEqual({ ok: true, why: null, unchecked: "no serial can be read from it" });
    expect(proven(chd)).toBe(false);
    const gb = contentMatches(plan("gb" as ContentPlan["platform"], ["DMG-ASYE-USA"]), facts("gb", "a.gb", { platform: "gb", internalName: "SYNTHETIC GAME" }));
    expect(gb).toMatchObject({ ok: true, unchecked: "its header carries no game code" });
    expect(proven(gb)).toBe(false);
  });

  test("a header's title alone never accepts a file", () => {
    // the title says the game; the code is another game's, or there is none
    const c = plan("n64", ["NZSE"]);
    expect(contentMatches(c, facts("n64", "a.z64", { platform: "n64", internalName: "SYNTHETIC GAME", gameCode: "NDKE" })).ok).toBe(false);
    expect(proven(contentMatches(c, facts("n64", "a.z64", { platform: "n64", internalName: "SYNTHETIC GAME" })))).toBe(false);
    // and a way that lists nothing proves nothing, whatever the title says
    expect(proven(contentMatches(plan("n64", []), facts("n64", "a.z64", { platform: "n64", internalName: "SYNTHETIC GAME", gameCode: "NZSE" })))).toBe(false);
  });

  test("hashes come before serials: a way that lists exact versions takes those only", () => {
    const c = plan("ps2", ["SLUS-21678"], [{ algo: "sha1", value: "b".repeat(40) }]);
    expect(contentMatches(c, facts("ps2", "a.iso", { platform: "ps2", serial: "SLUS-21678" })).ok).toBe(false);
    expect(contentMatches(c, facts("ps2", "a.iso", { platform: "ps2", serial: "SLUS-20000" }, "b".repeat(40)))).toMatchObject({ ok: true, matched: { algo: "sha1" } });
  });

  test("the console the bytes name wins over what the file was stored as", () => {
    const v = contentMatches(plan("ps2", []), facts("ps2", "a.iso", { platform: "gc", discId: "GSYE01" }));
    expect(v).toEqual({ ok: false, why: "a gc file, and this needs a ps2 one" });
  });
});
