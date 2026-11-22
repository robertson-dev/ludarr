/**
 * ludarr — what a game file or game folder says it is, read from its own bytes: the serial or game code its console's
 * header carries, and the header's title, region and version. Only small reads at fixed places (src/ways/readers/bytes.ts:
 * at most 64 KiB a read, a fixed number of reads a file) — never the whole disc. A format that cannot be read without
 * unpacking it (CHD, CSO, GCZ, an archive …) says nothing (null), and so does a file that is not what its header should be.
 *
 *   n64        the 64-byte header in any of the three byte orders (put in big-endian order first): title 0x20, game code
 *              0x3B-0x3E, version 0x3F
 *   gc / wii   the disc header: game id 0x00-0x05, disc 0x06, version 0x07, the Wii magic word at 0x18, the GameCube one
 *              at 0x1C; a .wbfs keeps it at its first sector (0x200), a .wia / .rvz in its second header (at 0x58),
 *              both headers checked by the SHA-1s the file carries for them (Dolphin's docs/WiaAndRvz.md)
 *   ps1 / ps2  ISO 9660, in 2048-byte sectors or a raw 2352-byte .bin: the root folder's SYSTEM.CNF, whose BOOT2 line (PS2)
 *              or BOOT line (PS1) names the boot file: SLUS_216.78 is the serial SLUS-21678; a disc with no SYSTEM.CNF but
 *              a PSX.EXE in its root is one of the first PlayStation discs (the console starts that file then)
 *   psp / ps3  ISO 9660 too: PSP_GAME/PARAM.SFO or PS3_GAME/PARAM.SFO one folder down (src/ways/readers/sfo.ts)
 *   ps5        a .zar's sce_sys/param.json (readers/zar.ts); a UDF disc image's bd/param.json, sealed when its game is in
 *              an encrypted package (readers/udf.ts); a game folder's sce_sys/param.json (readers/ps5.ts)
 *   ps4 / vita a game folder's sce_sys/param.sfo
 *   switch     a .nup's packages and main build (readers/nup.ts); a game folder's exefs/main (its build, no title id); an
 *              NSP or XCI only as sealed (its contents need the console's keys)
 *   gba        title 0xA0, game code 0xAC, the fixed byte 0x96 at 0xB2 and the header checksum at 0xBD
 *   gb / gbc   title 0x134 and the header checksum at 0x14D (old cartridges carry no game code)
 *   nds        title 0x00, game code 0x0C, the logo's CRC (0xCF56) and the header's own CRC-16 at 0x15E
 *   snes       the LoROM / HiROM / ExHiROM header whose checksum and complement agree (a 512-byte copier header skipped):
 *              title, region, version, and the game code of an extended header
 *   genesis    "SEGA" at 0x100, the serial at 0x180 ("GM 00001009-00"), the names at 0x120 and 0x150
 *
 * A folder is never followed through a link, and a link given as the file says nothing. The title a header carries is for
 * the admin to read: it never proves which game a file is. Serials and game codes do (src/ways/match.ts), in the forms
 * serialKeys() compares.
 */
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { platformId, type PlatformId } from "../platforms";
import { n64Order } from "./hash";
import { Bytes, MAX_READ, MAX_READS, nothing, nothingIn, openPlain, withBytes, type Read } from "./readers/bytes";
import { readNup, readPfs0, readXci } from "./readers/nup";
import { parseParamJson, ps5Identity } from "./readers/ps5";
import { parseSfo, sfoIdentity, type SfoPlace } from "./readers/sfo";
import { readUdf } from "./readers/udf";
import { readZar } from "./readers/zar";
import { noted } from "../transport";

export interface Identity {
  /** the console the bytes are for */
  platform: PlatformId;
  /** PS1 / PS2 "SLUS-21678"; Mega Drive "GM 00001009-00"; PS3 / PS4 / PS5 / PSP / Vita a title id "PPSA01342"; Switch a
   *  title id "0400486024DEC000" (a .nup's base) */
  serial?: string;
  /** GameCube / Wii game id "GZLE01" */
  discId?: string;
  /** a cartridge's four-character game code: N64 "NZSE", GBA "AXVE", DS "AMHE", SNES (extended header) */
  gameCode?: string;
  /** the header's title: for the admin to read, never proof of anything */
  internalName?: string;
  /** "US", "EU", "JP" … as the header says */
  region?: string;
  version?: string;
  /** GameCube / Wii (and a PS5 Blu-ray): which disc of the game (1 = the first) */
  disc?: number;
  /** what the data is: the game, a patch (an update), an add-on, or an application that is no game */
  category?: "game" | "patch" | "addon" | "app";
  /** a PlayStation content id ("EP9000-PPSA01341_00-DEMONSSOULS00000") */
  contentId?: string;
  /** a PS5 Blu-ray's own version (bd/param.json masterVersion) */
  masterVersion?: string;
  /** the form the data was read from */
  shape?: "bd-image" | "folder" | "zar" | "pkg" | "nup" | "iso" | "nsp" | "xci";
  /** the data is encrypted for the console (a retail disc as a PC drive reads it, an NSP or XCI): nothing can open it */
  sealed?: boolean;
  /** a Switch title's main build id (hex) */
  build?: string;
  /** every title id the data holds (a .nup's base, update and add-on packages) */
  titles?: string[];
}

/** the consoles whose files the bytes name beyond doubt AND whose every file of a readable format says so (a magic word,
 *  SYSTEM.CNF's boot line): an .iso is what they say, whatever it was sent as, and one that says nothing is no game of
 *  theirs (src/ways/find.ts silentFile turns that silence into a refusal) */
export const DEFINITIVE: ReadonlySet<PlatformId> = new Set<PlatformId>(["n64", "gc", "wii", "ps1", "ps2"]);
/** the consoles an identity names beyond doubt: DEFINITIVE, and those whose title id (or container) names the console —
 *  a file read as one of these is for it, whatever it was stored as. Silence from their readers proves nothing (it is a
 *  soft verdict: the file waits for the admin), so they are not DEFINITIVE */
export const NAMED: ReadonlySet<PlatformId> = new Set<PlatformId>([...DEFINITIVE, "ps3", "ps4", "ps5", "psp", "vita", "switch"]);
/** the consoles a serial or game code can be read for (src/ways/find.ts: a way with serials can check such a file) */
export const SERIAL_PLATFORMS: ReadonlySet<PlatformId> = new Set<PlatformId>(["n64", "gc", "wii", "ps1", "ps2", "gba", "nds", "snes", "genesis", "ps3", "ps4", "ps5", "psp", "vita", "switch"]);
/** file formats a serial reader sees into for the consoles above beyond the cartridge and disc headers (a .zar, a .nup) */
export const SERIAL_FORMATS: ReadonlySet<string> = new Set(["zar", "nup"]);
/** the files inside a game folder a reader takes its identity from (readFolderIdentity) */
export const SERIAL_MARKERS: readonly string[] = ["sce_sys/param.json", "sce_sys/param.sfo", "PS3_GAME/PARAM.SFO", "PSP_GAME/PARAM.SFO", "PARAM.SFO"];

/** formats whose header is not where a reader can see it without unpacking (or that are no game file by themselves) */
const UNREADABLE = new Set(["chd", "cso", "zso", "gcz", "ciso", "dax", "jso", "cdi", "gdi", "cue", "m3u", "pbp", "ecm", "zip", "7z", "rar"]);
const ext = (name: string) => (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
/** can the readers see this file's header (an .iso, a .z64, an .rvz …), so that a file they find nothing in is no game
 *  file of a console whose bytes always say so (DEFINITIVE)? */
export const readsFormat = (name: string): boolean => !UNREADABLE.has(ext(name));
/**
 * Does a reader tell what such a file or folder is for this console, beyond the DEFINITIVE ones' headers: a PS5 .zar or
 * disc image, a game folder of a PlayStation console or of a Switch game, a Switch .nup / NSP / XCI. When one does and
 * finds nothing, the file is not refused for that (src/ways/match.ts says "nothing in it reads as …", and it waits for
 * the admin).
 */
export function hasReader(platform: string, f: { name: string; shape?: "file" | "folder" }): boolean {
  if (f.shape === "folder") return ["ps5", "ps4", "ps3", "psp", "vita", "switch"].includes(platform);
  const e = ext(f.name);
  switch (platform) {
    case "ps5": return e === "zar" || e === "iso";
    case "ps4": case "ps3": case "psp": return e === "iso";
    case "switch": return ["nup", "nsp", "nsz", "xci", "xcz"].includes(e);
    default: return false;
  }
}
/** extensions that name a console's cartridge format */
const EXT_HINT: Record<string, PlatformId> = { z64: "n64", n64: "n64", v64: "n64", gba: "gba", gb: "gb", gbc: "gbc", nds: "nds", sfc: "snes", smc: "snes", md: "genesis", gen: "genesis", gcm: "gc", wbfs: "wii" };
/** the hints that read an ISO 9660 image (no hint reads one too) */
const ISO_PLATFORMS = new Set<PlatformId>(["ps1", "ps2", "gc", "wii", "ps3", "psp"]);
/** the hints that read a UDF image whatever its name (an .iso is tried as one whatever the hint) */
const UDF_PLATFORMS = new Set<PlatformId>(["ps4", "ps5"]);

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
/** printable ASCII up to the first NUL; anything else is a space; runs of spaces collapse; undefined when nothing is left */
function ascii(b: Uint8Array): string | undefined {
  let s = "";
  for (const c of b) { if (c === 0) break; s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " "; }
  const t = s.replace(/\s+/g, " ").trim();
  return t || undefined;
}
/** the bytes as they are, for codes that must match exactly */
const raw = (b: Uint8Array) => String.fromCharCode(...b);
const CODE4 = /^[A-Z0-9]{4}$/;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const sha1 = (b: Uint8Array) => new Uint8Array(new Bun.CryptoHasher("sha1").update(b).digest());
/** the fields that were found (undefined ones dropped, so a result compares and serializes cleanly) */
const pack = (id: Identity): Identity => Object.fromEntries(Object.entries(id).filter(([, v]) => v !== undefined && v !== "")) as unknown as Identity;

/** the region letter Nintendo's game codes and disc ids end with */
const LETTER_REGION: Record<string, string> = {
  E: "US", N: "US", J: "JP", P: "EU", D: "EU", F: "EU", I: "EU", S: "EU", H: "EU", X: "EU", Y: "EU", Z: "EU", U: "AU", K: "KR", C: "CN",
};

/* ─────────── Nintendo 64 ─────────── */

function swapped(b: Uint8Array, unit: 2 | 4): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i + unit <= b.length; i += unit) for (let k = 0; k < unit; k++) out[i + k] = b[i + unit - 1 - k];
  return out;
}

async function n64(b: Bytes): Promise<Identity | null> {
  const head = await b.at(0, 0x40);
  if (head.length < 0x40) return null;
  const order = n64Order(head);
  if (!order) return null;
  const h = order === "z64" ? head : swapped(head, order === "v64" ? 2 : 4);
  const code = raw(h.subarray(0x3b, 0x3f));
  const ok = CODE4.test(code);
  return pack({ platform: "n64", internalName: ascii(h.subarray(0x20, 0x34)), gameCode: ok ? code : undefined, region: ok ? LETTER_REGION[code[3]] : undefined, version: `1.${h[0x3f]}` });
}

/* ─────────── GameCube and Wii ─────────── */

const WII_MAGIC = 0x5d1c9ea3, GC_MAGIC = 0xc2339f3d;

/** the first 0x80 (or more) bytes of a GameCube or Wii disc */
export function discHeader(h: Uint8Array): Identity | null {
  if (h.length < 0x20) return null;
  const wii = be32(h, 0x18) === WII_MAGIC, gc = be32(h, 0x1c) === GC_MAGIC;
  if (wii === gc) return null;
  const id = raw(h.subarray(0, 6));
  if (!/^[A-Z0-9]{6}$/.test(id)) return null;
  return pack({ platform: wii ? "wii" : "gc", discId: id, internalName: ascii(h.subarray(0x20, Math.min(h.length, 0x80))), region: LETTER_REGION[id[3]], disc: h[6] + 1, version: String(h[7]) });
}

/** a .wbfs: the WBFS header, then the disc header at its first sector (512 bytes on every file the tools write) */
async function wbfs(b: Bytes): Promise<Identity | null> {
  const head = await b.at(0, 12);
  if (head.length < 12 || raw(head.subarray(0, 4)) !== "WBFS") return null;
  const shift = head[8];
  const id = discHeader(await b.at(shift >= 9 && shift <= 12 ? 2 ** shift : 0x200, 0x100));
  return id?.platform === "wii" ? id : null;
}

/** a .wia / .rvz: header 1 (0x48 bytes, its own SHA-1 last) names the size and SHA-1 of header 2, which holds the disc's
 *  type (1 GameCube, 2 Wii) and its first 0x80 bytes, stored as they are */
async function wia(b: Bytes): Promise<Identity | null> {
  const h1 = await b.at(0, 0x48);
  if (h1.length < 0x48) return null;
  const magic = raw(h1.subarray(0, 3));
  if ((magic !== "WIA" && magic !== "RVZ") || h1[3] !== 1) return null;
  if (!same(sha1(h1.subarray(0, 0x34)), h1.subarray(0x34, 0x48))) return null;
  const size2 = be32(h1, 0x0c);
  if (size2 < 0x90 || size2 > MAX_READ) return null;
  const h2 = await b.at(0x48, size2);
  if (h2.length < size2 || !same(sha1(h2), h1.subarray(0x10, 0x24))) return null;
  const type = be32(h2, 0);
  const id = discHeader(h2.subarray(0x10, 0x90));
  return id && id.platform === (type === 1 ? "gc" : type === 2 ? "wii" : null) ? id : null;
}

/* ─────────── PlayStation discs (ISO 9660) ─────────── */

const SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
/** the region a PlayStation serial's prefix names (SLUS / SCUS: America, SLES / SCES: Europe, SLPS / SCPS: Japan …) */
const PS_REGION: Record<string, string> = { SLU: "US", SCU: "US", SLE: "EU", SCE: "EU", SLP: "JP", SCP: "JP", SLK: "KR", SCK: "KR", SLA: "ASIA", SCA: "ASIA" };
/** raw sectors one read takes: as many 2352-byte sectors as fit in 64 KiB */
const RAW_RUN = Math.floor(MAX_READ / 2352);

/** 2048-byte user-data sectors, from an .iso or from a raw 2352-byte image (mode 1 data at 16, mode 2 form 1 at 24) */
async function sectorsOf(b: Bytes): Promise<(lba: number, count: number) => Promise<Uint8Array>> {
  const head = await b.at(0, 16);
  if (head.length === 16 && SYNC.every((x, i) => head[i] === x)) {
    const data = head[15] === 2 ? 24 : 16;
    return async (lba, count) => {
      const out = new Uint8Array(count * 2048);
      let n = 0;
      for (let i = 0; i < count; i += RAW_RUN) {
        const k = Math.min(RAW_RUN, count - i);
        const run = await b.at((lba + i) * 2352, k * 2352);
        for (let s = 0; s < k; s++) {
          const user = run.subarray(s * 2352 + data, s * 2352 + data + 2048);
          out.set(user, n);
          n += user.length;
          if (user.length < 2048) return out.subarray(0, n);
        }
      }
      return out.subarray(0, n);
    };
  }
  return (lba, count) => b.span(lba * 2048, count * 2048);
}

/** a record in a folder's records: the extent and size of `name` (any version suffix ignored), a folder or not */
function recordIn(dir: Uint8Array, len: number, name: string, folder: boolean): { lba: number; size: number } | null {
  for (let off = 0; off < Math.min(len, dir.length);) {
    const rl = dir[off];
    if (!rl) { off = (Math.floor(off / 2048) + 1) * 2048; continue; }        // records never cross a sector: padding to its end
    if (rl < 34 || off + rl > dir.length) break;
    const nl = dir[off + 32];
    const n = raw(dir.subarray(off + 33, off + 33 + nl)).toUpperCase().replace(/;\d*$/, "");
    if (n === name && !!(dir[off + 25] & 2) === folder) return { lba: le32(dir, off + 2), size: le32(dir, off + 10) };
    off += rl;
  }
  return null;
}
const fileIn = (dir: Uint8Array, len: number, name: string) => recordIn(dir, len, name, false);

/** a PSP or PS3 disc's PARAM.SFO, one folder down (PSP_GAME / PS3_GAME) */
async function sfoBelow(read: (lba: number, count: number) => Promise<Uint8Array>, root: Uint8Array, len: number, folder: "PSP_GAME" | "PS3_GAME"): Promise<Identity | null> {
  const d = recordIn(root, len, folder, true);
  if (!d || !d.lba || !d.size) return null;
  const sub = await read(d.lba, Math.min(32, Math.ceil(d.size / 2048)));
  const f = fileIn(sub, d.size, "PARAM.SFO");
  if (!f || !f.lba || !f.size || f.size > MAX_READ) return null;
  const sfo = parseSfo((await read(f.lba, Math.ceil(f.size / 2048))).subarray(0, f.size));
  return sfo ? sfoIdentity(sfo, folder, "iso").identity : null;
}

/** an ISO 9660 disc's identity (`seen.pvd`: it has an ISO 9660 volume, whatever it names) */
async function iso9660(b: Bytes, seen: { pvd: boolean } = { pvd: false }): Promise<Identity | null> {
  const read = await sectorsOf(b);
  const pvd = await read(16, 1);
  if (pvd.length < 2048 || pvd[0] !== 1 || raw(pvd.subarray(1, 6)) !== "CD001") return null;
  seen.pvd = true;
  const root = pvd.subarray(156, 190);
  const lba = le32(root, 2), len = le32(root, 10);
  if (!lba || !len) return null;
  const dir = await read(lba, Math.min(32, Math.ceil(len / 2048)));
  const cnf = fileIn(dir, len, "SYSTEM.CNF");
  if (!cnf || !cnf.lba || !cnf.size) {
    // a PSP UMD or a PS3 disc keeps its PARAM.SFO one folder down
    const below = (await sfoBelow(read, dir, len, "PSP_GAME")) ?? (await sfoBelow(read, dir, len, "PS3_GAME"));
    if (below) return below;
    // the first PlayStation discs carry no SYSTEM.CNF: the console starts the PSX.EXE in the root then
    return fileIn(dir, len, "PSX.EXE") ? pack({ platform: "ps1", internalName: ascii(pvd.subarray(40, 72)) }) : null;
  }
  const body = await read(cnf.lba, Math.min(2, Math.ceil(cnf.size / 2048)));
  const text = new TextDecoder("latin1").decode(body.subarray(0, Math.min(cnf.size, 4096)));
  const boot2 = /^\s*BOOT2\s*=\s*(\S+)/im.exec(text), boot = /^\s*BOOT\s*=\s*(\S+)/im.exec(text);
  const line = boot2 ?? boot;
  if (!line) return null;
  const file = (line[1].split(/[\\/:]/).pop() ?? "").replace(/;\d*$/, "");
  const m = /^([A-Z]{4})[_-](\d{3})\.(\d{2})$/i.exec(file);
  const serial = m ? `${m[1].toUpperCase()}-${m[2]}${m[3]}` : undefined;
  return pack({
    platform: boot2 ? "ps2" : "ps1", serial, internalName: ascii(pvd.subarray(40, 72)), region: serial ? PS_REGION[serial.slice(0, 3)] : undefined,
    version: /^\s*VER\s*=\s*(\S+)/im.exec(text)?.[1],
  });
}

/* ─────────── cartridges ─────────── */

async function gba(b: Bytes): Promise<Identity | null> {
  const h = await b.at(0, 0xc0);
  if (h.length < 0xc0 || h[0xb2] !== 0x96) return null;
  let c = 0;
  for (let i = 0xa0; i <= 0xbc; i++) c = (c - h[i]) & 0xff;
  if (((c - 0x19) & 0xff) !== h[0xbd]) return null;
  const code = raw(h.subarray(0xac, 0xb0)), ok = CODE4.test(code);
  return pack({ platform: "gba", internalName: ascii(h.subarray(0xa0, 0xac)), gameCode: ok ? code : undefined, region: ok ? LETTER_REGION[code[3]] : undefined, version: String(h[0xbc]) });
}

async function gb(b: Bytes): Promise<Identity | null> {
  const h = await b.at(0x100, 0x50);
  if (h.length < 0x50) return null;
  let x = 0;
  for (let i = 0x34; i <= 0x4c; i++) x = (x - h[i] - 1) & 0xff;
  if (x !== h[0x4d]) return null;
  const color = (h[0x43] & 0x80) !== 0;
  return pack({ platform: color ? "gbc" : "gb", internalName: ascii(h.subarray(0x34, color ? 0x3f : 0x44)), region: h[0x4a] === 0 ? "JP" : undefined, version: String(h[0x4c]) });
}

/** CRC-16 as the DS header uses it (the MODBUS one: polynomial 0xA001 reflected, starting at 0xFFFF) */
export function crc16(b: Uint8Array): number {
  let crc = 0xffff;
  for (const x of b) { crc ^= x; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1; }
  return crc;
}

async function nds(b: Bytes): Promise<Identity | null> {
  const h = await b.at(0, 0x160);
  if (h.length < 0x160 || le16(h, 0x15c) !== 0xcf56 || le16(h, 0x15e) !== crc16(h.subarray(0, 0x15e))) return null;
  const code = raw(h.subarray(0x0c, 0x10)), ok = CODE4.test(code);
  return pack({ platform: "nds", internalName: ascii(h.subarray(0, 12)), gameCode: ok ? code : undefined, region: ok ? LETTER_REGION[code[3]] : undefined, version: String(h[0x1e]) });
}

/** the SNES destination codes */
const SNES_REGION: Record<number, string> = { 0: "JP", 1: "US", 2: "EU", 3: "EU", 6: "EU", 7: "EU", 8: "EU", 9: "EU", 10: "EU", 11: "CN", 13: "KR", 15: "US", 16: "BR", 17: "AU" };

async function snes(b: Bytes): Promise<Identity | null> {
  const base = b.size % 1024 === 512 ? 512 : 0;                                // a copier's header in front
  for (const at of [0x7fc0, 0xffc0, 0x40ffc0]) {
    const off = base + at;
    if (off + 0x20 > b.size) continue;
    const h = await b.at(off - 0x10, 0x30);
    if (h.length < 0x30) continue;
    const hd = h.subarray(0x10);
    if ((le16(hd, 0x1c) ^ le16(hd, 0x1e)) !== 0xffff) continue;               // the checksum and its complement
    if ((hd[0x15] & 0xe0) !== 0x20) continue;                                 // a map mode (0x20 LoROM, 0x21 HiROM, 0x30 fast …)
    const code = hd[0x1a] === 0x33 ? raw(h.subarray(0x02, 0x06)) : "";          // an extended header in the 16 bytes before
    return pack({ platform: "snes", internalName: ascii(hd.subarray(0, 21)), gameCode: CODE4.test(code) ? code : undefined, region: SNES_REGION[hd[0x19]], version: String(hd[0x1b]) });
  }
  return null;
}

async function genesis(b: Bytes): Promise<Identity | null> {
  const h = await b.at(0x100, 0x100);
  if (h.length < 0x100) return null;
  const system = raw(h.subarray(0, 16));
  if (!/^ ?SEGA/.test(system) || /32X/.test(system)) return null;
  const field = (ascii(h.subarray(0x80, 0x8e)) ?? "").toUpperCase();
  const serial = /^[A-Z]{2} [A-Z0-9][A-Z0-9 -]*$/.test(field) ? field : undefined;
  const region = raw(h.subarray(0xf0, 0xf3));
  return pack({
    platform: "genesis", serial, internalName: ascii(h.subarray(0x50, 0x80)) ?? ascii(h.subarray(0x20, 0x50)),
    region: /U/.test(region) ? "US" : /E/.test(region) ? "EU" : /J/.test(region) ? "JP" : undefined, version: serial ? /-(\d{2})$/.exec(serial)?.[1] : undefined,
  });
}

/* ─────────── what a file is ─────────── */

const said = (id: Identity | null, why: string): Read => (id ? { identity: id, why: null } : nothing(why));

/**
 * What the file's bytes say it is, with the reason when they say nothing that can be relied on (for an admin or the AI's
 * look: describeInput in src/ways/inspect.ts), and the files inside that said it. `platform` is the console the file is
 * expected to be for (it picks the cartridge reader); `name` is the file's own name when `path` has none (a file still on
 * its way in). Discs say what they are whatever was expected: a GameCube disc sent for a PS2 way is a GameCube disc.
 */
export async function identify(path: string, platform?: string | null, name: string = path): Promise<Read> {
  const e = ext(name);
  if (UNREADABLE.has(e)) return nothing(`a .${e} file says what it is only once it is unpacked`);
  const hint: PlatformId | null = platformId(platform ?? "") ?? EXT_HINT[e] ?? null;
  return withBytes(path, async b => {
    switch (e) {
      case "zar": return readZar(b);
      case "nup": return readNup(b);
      case "nsp": case "nsz": return readPfs0(b);
      case "xci": case "xcz": return readXci(b);
      case "wbfs": return said(await wbfs(b), "its WBFS header holds no Wii disc header");
      case "wia": case "rvz": return said(await wia(b), "its headers do not hold together (their SHA-1s differ)");
    }
    const n = await n64(b);
    if (n) return { identity: n, why: null };
    const seen = { pvd: false };
    const disc = discHeader(await b.at(0, 0x80)) ?? (!hint || ISO_PLATFORMS.has(hint) || UDF_PLATFORMS.has(hint) ? await iso9660(b, seen) : null);
    if (disc) return { identity: disc, why: null };
    if (e === "iso" || (hint && UDF_PLATFORMS.has(hint))) {
      const u = await readUdf(b);
      if (u.identity) return u;
      // an ISO 9660 disc with no UDF volume beside it: its own file system is what said nothing
      if (e === "iso") return seen.pvd && u.why?.includes("UDF anchor") ? nothingIn(b, "its ISO 9660 file system names no game (no SYSTEM.CNF, PSX.EXE, PSP_GAME or PS3_GAME)") : u;
    }
    switch (hint) {
      case "gba": return said(await gba(b), "its header's checksum does not hold");
      case "gb": case "gbc": return said(await gb(b), "its header's checksum does not hold");
      case "nds": return said(await nds(b), "its header's CRC does not hold");
      case "snes": return said(await snes(b), "no SNES header's checksum and complement agree");
      case "genesis": return said(await genesis(b), "it holds no SEGA header");
      default: return nothingIn(b, "nothing in it says which game it is");
    }
  }, MAX_READS);
}

/**
 * What the file's bytes say it is, or null when they say nothing that can be relied on (identify() says why). `platform`
 * is the console the file is expected to be for; `name` is the file's own name when `path` has none.
 */
export async function readIdentity(path: string, platform?: string | null, name: string = path): Promise<Identity | null> {
  return (await identify(path, platform, name)).identity;
}

/* ─────────── what a game folder is ─────────── */

/** a folder's names, keyed without regard to case (at most `max` of them), and what each is by lstat (links are links) */
async function namesIn(dir: string, max = 10000): Promise<Map<string, { name: string; kind: "dir" | "file" | "link" | "other"; size: number }>> {
  const out = new Map<string, { name: string; kind: "dir" | "file" | "link" | "other"; size: number }>();
  const d = await opendir(dir).catch(noted(dir));
  if (!d) return out;
  try {
    let n = 0;
    for await (const ent of d) {
      if (++n > max) break;
      const st = await lstat(join(dir, ent.name)).catch(noted(join(dir, ent.name)));
      if (!st) continue;
      const kind = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      if (!out.has(ent.name.toLowerCase())) out.set(ent.name.toLowerCase(), { name: ent.name, kind, size: st.size });
    }
  } finally { await d.close().catch(() => { /* closed */ }); }
  return out;
}

/** a small file's first bytes (at most `max`; with `whole`, a larger file is refused), from a file lstat said is a plain
 *  one, opened without following a link (src/ways/readers/bytes.ts openPlain) */
async function smallFile(path: string, max: number, whole = true): Promise<Uint8Array | string> {
  const opened = await openPlain(path).catch(e => `it could not be opened (${(e as Error)?.message ?? e})`);
  if (typeof opened === "string") return opened === "it is a link, and ludarr never follows one" || opened === "it is not a file" ? "it is not a plain file" : opened;
  const { fh, st } = opened;
  try {
    if (whole && st.size > max) return `it is ${st.size} bytes, more than such a file ever is`;
    const b = new Uint8Array(Math.min(st.size, max));
    let got = 0;
    while (got < b.length) {
      const { bytesRead } = await fh.read(b, got, Math.min(MAX_READ, b.length - got), got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return b.subarray(0, got);
  } catch (e) {
    return `it could not be read (${(e as Error)?.message ?? e})`;
  } finally { await fh.close().catch(() => { /* closed */ }); }
}

const PARAM_JSON_MAX = 1024 * 1024, SFO_MAX = MAX_READ;

/**
 * What a game FOLDER says it is, with the reason when nothing in it can be relied on: a PS5 app0 folder's
 * sce_sys/param.json, a PS4 or Vita one's sce_sys/param.sfo, PS3_GAME/PARAM.SFO (a disc's folder), PSP_GAME/PARAM.SFO,
 * a PARAM.SFO at the top (a PS3 game as the console installs it), or a Switch game's exefs/main (the program's build only:
 * its title id is not read). Names are matched without regard to case; a link is never followed, so a marker that is a
 * link says nothing. A folder that cannot be read says so; nothing is thrown.
 */
export async function identifyFolder(dir: string, platform?: string | null): Promise<Read> {
  try { return await folderRead(dir, platform); }
  catch (e) { return nothing(`it could not be read (${(e as Error)?.message ?? e})`); }
}

/** the first 0x100 bytes of a Switch program (an NSO: "NSO0", its module id — the build — at 0x40-0x60), as NX2navi's
 *  make_game.py check() reads it (tools/make_game.py:268-276) */
const NSO_HEAD = 0x100;

async function folderRead(dir: string, _platform?: string | null): Promise<Read> {
  const st = await lstat(dir).catch(noted(dir));
  if (!st) return nothing("it is not there");
  if (st.isSymbolicLink()) return nothing("it is a link, and ludarr never follows one");
  if (!st.isDirectory()) return nothing("it is not a folder");
  const top = await namesIn(dir);
  const isDir = (m: Map<string, { name: string; kind: string }>, n: string) => (m.get(n.toLowerCase())?.kind === "dir" ? m.get(n.toLowerCase())!.name : null);
  const isFile = (m: Map<string, { name: string; kind: string }>, n: string) => (m.get(n.toLowerCase())?.kind === "file" ? m.get(n.toLowerCase())!.name : null);
  const eboot = !!isFile(top, "eboot.bin");
  const sys = isDir(top, "sce_sys");
  if (sys) {
    const inner = await namesIn(join(dir, sys), 4096);
    const pj = isFile(inner, "param.json");
    if (pj) {
      const bytes = await smallFile(join(dir, sys, pj), PARAM_JSON_MAX);
      if (typeof bytes === "string") return nothing(`its sce_sys/param.json could not be read: ${bytes}`);
      const j = parseParamJson(bytes);
      if (!j) return nothing("its sce_sys/param.json is not JSON");
      return { ...ps5Identity(j, { shape: "folder", eboot }), markers: [`${sys}/${pj}`, ...(eboot ? [isFile(top, "eboot.bin")!] : [])] };
    }
    const ps = isFile(inner, "param.sfo");
    if (ps) {
      const r = await sfoAt(join(dir, sys, ps), "sce_sys");
      if (r.identity?.category === "game" && !eboot) return nothing("it has no eboot.bin beside sce_sys, so it is not a whole game folder");
      return { ...r, markers: [`${sys}/${ps}`] };
    }
    if (inner.get("param.json")?.kind === "link" || inner.get("param.sfo")?.kind === "link") return nothing("its sce_sys holds a link where the game's param file should be, and ludarr never follows one");
  }
  for (const folder of ["PS3_GAME", "PSP_GAME"] as const) {
    const sub = isDir(top, folder);
    if (!sub) continue;
    const inner = await namesIn(join(dir, sub), 4096);
    const sfo = isFile(inner, "PARAM.SFO");
    if (sfo) return { ...(await sfoAt(join(dir, sub, sfo), folder)), markers: [`${sub}/${sfo}`] };
  }
  const rootSfo = isFile(top, "PARAM.SFO");
  if (rootSfo) return { ...(await sfoAt(join(dir, rootSfo), "root")), markers: [rootSfo] };
  // a Switch game's folders (hactool's exefs and romfs, the form NX2navi's --exefs / --romfs take): the main program's build
  const exefs = isDir(top, "exefs");
  if (exefs) {
    const inner = await namesIn(join(dir, exefs), 256);
    const main = isFile(inner, "main");
    if (main) {
      const head = await smallFile(join(dir, exefs, main), NSO_HEAD, false);
      if (typeof head === "string") return nothing(`its exefs/main could not be read: ${head}`);
      if (head.length < NSO_HEAD || raw(head.subarray(0, 4)) !== "NSO0") return nothing("its exefs/main is not a Switch program (no NSO0 header)");
      const build = Array.from(head.subarray(0x40, 0x60), x => x.toString(16).padStart(2, "0")).join("");
      const romfs = isDir(top, "romfs");
      return {
        identity: { platform: "switch", build, shape: "folder" }, why: null,
        markers: [`${exefs}/${main}`, ...(isFile(inner, "main.npdm") ? [`${exefs}/${isFile(inner, "main.npdm")}`] : []), ...(romfs ? [romfs] : [])],
      };
    }
    if (inner.get("main")?.kind === "link") return nothing("its exefs/main is a link, and ludarr never follows one");
  }
  if (top.get("sce_sys")?.kind === "link") return nothing("its sce_sys is a link, and ludarr never follows one");
  return nothing("nothing in it says which game it is (no sce_sys/param.json, sce_sys/param.sfo, PS3_GAME/PARAM.SFO, PSP_GAME/PARAM.SFO or exefs/main)");
}

async function sfoAt(path: string, place: SfoPlace): Promise<Read> {
  const bytes = await smallFile(path, SFO_MAX);
  if (typeof bytes === "string") return nothing(`its ${place === "root" ? "PARAM.SFO" : `${place}/${place === "sce_sys" ? "param.sfo" : "PARAM.SFO"}`} could not be read: ${bytes}`);
  const sfo = parseSfo(bytes);
  if (!sfo) return nothing(`its ${place === "sce_sys" ? "sce_sys/param.sfo" : place === "root" ? "PARAM.SFO" : `${place}/PARAM.SFO`} is not an SFO`);
  return sfoIdentity(sfo, place, "folder");
}

/** What a game FOLDER says it is (identifyFolder), or null when nothing in it can be relied on */
export async function readFolderIdentity(dir: string, platform?: string | null): Promise<Identity | null> {
  return (await identifyFolder(dir, platform)).identity;
}

/* ─────────── comparing serials ─────────── */

type Family = "ps" | "disc" | "cart" | "genesis" | "nx" | "other";
const familyOf = (platform: string): Family =>
  ["ps1", "ps2", "psp", "ps3", "ps4", "ps5", "vita"].includes(platform) ? "ps"
    : platform === "gc" || platform === "wii" ? "disc"
    : ["n64", "gba", "nds", "gb", "gbc", "snes", "3ds"].includes(platform) ? "cart"
    : platform === "genesis" ? "genesis"
    : platform === "switch" ? "nx" : "other";
/** what a box's product code starts with, never the game code itself (DL-DOL-GZLE-USA, NUS-NZSE-USA, AGB-AXVE-USA …) */
const LABEL_PREFIX = new Set(["DL", "DOL", "RVL", "NUS", "AGB", "NTR", "CGB", "DMG", "TWL", "SHVC", "SNS", "SNSP", "CTR", "MGB"]);
const alnum = (s: string) => s.replace(/[^A-Z0-9]/g, "");
const fourOf = (s: string) => s.split(/[-_ ./]/).find(p => CODE4.test(p) && !LABEL_PREFIX.has(p)) ?? null;

/**
 * The forms a serial is compared in, as typed keys: PS1 / PS2 "SLUS-21678" in any spelling (SLUS_216.78, SLUS21678,
 * SLUS-21678-P), and a PS3 / PS4 / PS5 / PSP / Vita title id the same way (PPSA01342, PPSA-01342, or a content id that
 * holds it); GameCube / Wii a game id (GZLE01) or its four-character code (GZLE, or a box's DL-DOL-GZLE-USA); a
 * cartridge's game code (NZSE, or a box's NUS-NZSE-USA); a Mega Drive serial with and without its revision; a Switch
 * title id in 16 hex digits (with or without 0x).
 */
export function serialKeys(platform: string, value: string): string[] {
  const s = value.toUpperCase().trim();
  if (!s) return [];
  switch (familyOf(platform)) {
    case "ps": { const m = /([A-Z]{4})[-_. ]?(\d{3})[._]?(\d{2})/.exec(s); return [`SER:${m ? m[1] + m[2] + m[3] : alnum(s)}`]; }
    case "disc": { if (/^[A-Z0-9]{6}$/.test(s)) return [`ID:${s}`]; const code = CODE4.test(s) ? s : fourOf(s); return code ? [`CODE:${code}`] : []; }
    case "cart": { const code = CODE4.test(s) ? s : fourOf(s); return code ? [`CODE:${code}`] : []; }
    case "genesis": return [...new Set([`SER:${alnum(s)}`, `SER:${alnum(s.replace(/-\d{2}$/, ""))}`])];
    case "nx": { const h = s.replace(/^0X/, "").replace(/[^0-9A-F]/g, ""); return [/^[0-9A-F]{16}$/.test(h) ? `TID:${h}` : `SER:${alnum(s)}`]; }
    default: return [`SER:${alnum(s)}`];
  }
}

/** the keys a file's identity can be matched by (none when its header carries no serial, id or code); every title id a
 *  container holds counts */
export function identityKeys(id: Identity | null | undefined): string[] {
  if (!id) return [];
  const out: string[] = [];
  if (id.serial) out.push(...serialKeys(id.platform, id.serial));
  for (const t of id.titles ?? []) out.push(...serialKeys(id.platform, t));
  if (id.discId) out.push(`ID:${id.discId.toUpperCase()}`, `CODE:${id.discId.slice(0, 4).toUpperCase()}`);
  if (id.gameCode) out.push(`CODE:${id.gameCode.toUpperCase()}`);
  return [...new Set(out)];
}

/** what the identity's serial is called, for the admin */
export const serialWord = (platform: string) =>
  ["ps3", "ps4", "ps5", "vita", "switch"].includes(platform) ? "title id" : familyOf(platform) === "disc" ? "game id" : familyOf(platform) === "cart" ? "game code" : "serial";
/** the identity's serial (or id, or code) as the admin reads it */
export const shownSerial = (id: Identity | null | undefined): string | null => id?.serial ?? id?.discId ?? id?.gameCode ?? null;
