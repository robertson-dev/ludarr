/**
 * Synthetic game files for the identity readers and the content pass: each is only what its console's header must hold
 * (made-up titles, codes and serials, zeros elsewhere) — never real game data. The PlayStation, ZArchive, UDF and .nup
 * writers below lay out whole files of their real formats, so the readers are tested on bytes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc16 } from "../src/ways/identity";

const enc = new TextEncoder();
const put = (b: Uint8Array, at: number, s: string) => b.set(enc.encode(s), at);
const be32 = (b: Uint8Array, at: number, v: number) => { b[at] = v >>> 24; b[at + 1] = (v >>> 16) & 0xff; b[at + 2] = (v >>> 8) & 0xff; b[at + 3] = v & 0xff; };
const le16 = (b: Uint8Array, at: number, v: number) => { b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff; };
const le32 = (b: Uint8Array, at: number, v: number) => { b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff; b[at + 2] = (v >>> 16) & 0xff; b[at + 3] = v >>> 24; };
const sha1 = (b: Uint8Array) => new Uint8Array(new Bun.CryptoHasher("sha1").update(b).digest());
/** a few bytes that make two images of the same layout differ */
const salt = (b: Uint8Array, seed: number, from: number) => { let x = seed || 1; for (let i = from; i < Math.min(b.length, from + 4096); i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } };

/** an N64 ROM: big-endian (z64), or 16-bit-swapped (v64), or 32-bit-reversed (n64) */
export function n64Rom(o: { code?: string; name?: string; version?: number; order?: "z64" | "v64" | "n64"; size?: number; seed?: number } = {}): Uint8Array {
  const b = new Uint8Array(o.size ?? 1024 * 1024);
  b.set([0x80, 0x37, 0x12, 0x40], 0);
  put(b, 0x20, (o.name ?? "SYNTH TEST ROM").padEnd(20, " ").slice(0, 20));
  if (o.code !== "") put(b, 0x3b, o.code ?? "NSYE");
  b[0x3f] = o.version ?? 0;
  salt(b, o.seed ?? 7, 0x1000);
  if (o.order === "v64") for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  if (o.order === "n64") for (let i = 0; i + 3 < b.length; i += 4) { const t0 = b[i], t1 = b[i + 1]; b[i] = b[i + 3]; b[i + 1] = b[i + 2]; b[i + 2] = t1; b[i + 3] = t0; }
  return b;
}

/** the first bytes of a GameCube or Wii disc */
export function discHead(o: { id: string; wii?: boolean; title?: string; disc?: number; version?: number }): Uint8Array {
  const h = new Uint8Array(0x440);
  put(h, 0, o.id);
  h[6] = o.disc ?? 0; h[7] = o.version ?? 0;
  if (o.wii) be32(h, 0x18, 0x5d1c9ea3); else be32(h, 0x1c, 0xc2339f3d);
  put(h, 0x20, o.title ?? "SYNTHETIC DISC");
  return h;
}
/** a GameCube / Wii .iso: its header, then zeros */
export function nintendoIso(o: { id: string; wii?: boolean; title?: string; size?: number; seed?: number }): Uint8Array {
  const b = new Uint8Array(o.size ?? 17 * 1024 * 1024);
  b.set(discHead(o), 0);
  salt(b, o.seed ?? 3, 0x10000);
  return b;
}
/** a Wii .wbfs: the WBFS header, the disc header at its first 512-byte sector */
export function wbfsImage(id: string, size = 17 * 1024 * 1024): Uint8Array {
  const b = new Uint8Array(size);
  put(b, 0, "WBFS"); be32(b, 4, size / 512); b[8] = 9; b[9] = 21;
  b.set(discHead({ id, wii: true }).subarray(0, 0x100), 0x200);
  salt(b, 5, 0x10000);
  return b;
}
/** an .rvz (or .wia): header 1 with its SHA-1s, header 2 holding the disc type and the disc's first 0x80 bytes */
export function rvzImage(o: { id: string; wii?: boolean; magic?: "RVZ" | "WIA"; corrupt?: boolean; size?: number }): Uint8Array {
  const b = new Uint8Array(o.size ?? 17 * 1024 * 1024);
  const h2 = new Uint8Array(0xdc);
  be32(h2, 0, o.wii ? 2 : 1); be32(h2, 4, 5); be32(h2, 0x0c, 2 * 1024 * 1024);
  h2.set(discHead({ id: o.id, wii: o.wii }).subarray(0, 0x80), 0x10);
  const h1 = new Uint8Array(0x48);
  put(h1, 0, o.magic ?? "RVZ"); h1[3] = 1;
  be32(h1, 4, 0x00030000); be32(h1, 8, 0x00030000); be32(h1, 0x0c, h2.length);
  h1.set(sha1(h2), 0x10);
  be32(h1, 0x24 + 4, 1459978240); be32(h1, 0x2c + 4, b.length);
  h1.set(sha1(h1.subarray(0, 0x34)), 0x34);
  b.set(h1, 0); b.set(h2, 0x48);
  if (o.corrupt) b[0x48 + 0x12] ^= 0xff;                                   // a header byte changed after its SHA-1 was taken
  salt(b, 9, 0x10000);
  return b;
}

/** a PlayStation / PlayStation 2 disc as ISO 9660: the volume descriptor at sector 16, the root folder at 18, SYSTEM.CNF at 20 */
export function psIso(o: { boot: string; ps1?: boolean; volume?: string; ver?: string; size?: number; seed?: number; raw?: boolean }): Uint8Array {
  const sectors = Math.ceil((o.size ?? 17 * 1024 * 1024) / 2048);
  const iso = new Uint8Array(sectors * 2048);
  const pvd = iso.subarray(16 * 2048, 17 * 2048);
  pvd[0] = 1; put(pvd, 1, "CD001"); pvd[6] = 1;
  put(pvd, 40, (o.volume ?? "SYNTHETIC").padEnd(32, " "));
  le32(pvd, 80, sectors);
  const rec = (at: Uint8Array, off: number, name: Uint8Array, extent: number, size: number, dir: boolean) => {
    const len = 33 + name.length + ((33 + name.length) % 2);
    at[off] = len; le32(at, off + 2, extent); be32(at, off + 6, extent); le32(at, off + 10, size); be32(at, off + 14, size);
    at[off + 25] = dir ? 2 : 0; at[off + 32] = name.length; at.set(name, off + 33);
    return off + len;
  };
  rec(pvd, 156, new Uint8Array([0]), 18, 2048, true);
  const cnf = enc.encode(`${o.ps1 ? "BOOT" : "BOOT2"} = ${o.boot}\r\n${o.ver ? `VER = ${o.ver}\r\n` : ""}VMODE = NTSC\r\n`);
  const root = iso.subarray(18 * 2048, 19 * 2048);
  let off = rec(root, 0, new Uint8Array([0]), 18, 2048, true);
  off = rec(root, off, new Uint8Array([1]), 18, 2048, true);
  off = rec(root, off, enc.encode("README.TXT;1"), 21, 5, false);
  rec(root, off, enc.encode("SYSTEM.CNF;1"), 20, cnf.length, false);
  iso.set(cnf, 20 * 2048);
  put(iso, 21 * 2048, "hello");
  salt(iso, o.seed ?? 11, 30 * 2048);
  if (!o.raw) return iso;
  // the same disc as raw 2352-byte mode 2 sectors (sync, address, mode, subheader, the 2048 bytes, error codes left zero)
  const out = new Uint8Array(sectors * 2352);
  for (let s = 0; s < sectors; s++) {
    const at = s * 2352;
    out[at] = 0; out.fill(0xff, at + 1, at + 11); out[at + 11] = 0;
    out[at + 15] = 2;
    out.set(iso.subarray(s * 2048, (s + 1) * 2048), at + 24);
  }
  return out;
}

/** a Game Boy Advance ROM header (title, game code, the fixed byte, the header checksum) */
export function gbaRom(o: { code?: string; title?: string; size?: number } = {}): Uint8Array {
  const b = new Uint8Array(o.size ?? 256 * 1024);
  put(b, 0xa0, (o.title ?? "SYNTHGBA").slice(0, 12)); put(b, 0xac, o.code ?? "BSYE"); put(b, 0xb0, "01");
  b[0xb2] = 0x96;
  let c = 0;
  for (let i = 0xa0; i <= 0xbc; i++) c = (c - b[i]) & 0xff;
  b[0xbd] = (c - 0x19) & 0xff;
  return b;
}
/** a Game Boy (Color) ROM header: title, the color flag, the header checksum */
export function gbRom(o: { title?: string; color?: boolean; japan?: boolean } = {}): Uint8Array {
  const b = new Uint8Array(64 * 1024);
  put(b, 0x134, (o.title ?? "SYNTHGB").slice(0, o.color ? 11 : 16));
  if (o.color) b[0x143] = 0x80;
  b[0x14a] = o.japan ? 0 : 1;
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - b[i] - 1) & 0xff;
  b[0x14d] = x;
  return b;
}
/** a Nintendo DS ROM header: title, game code, the logo's CRC and the header's own CRC-16 */
export function ndsRom(o: { code?: string; title?: string } = {}): Uint8Array {
  const b = new Uint8Array(2 * 1024 * 1024);
  put(b, 0, (o.title ?? "SYNTHDS").slice(0, 12)); put(b, 0x0c, o.code ?? "ASYE"); put(b, 0x10, "01");
  le16(b, 0x15c, 0xcf56);
  le16(b, 0x15e, crc16(b.subarray(0, 0x15e)));
  return b;
}
/** a SNES ROM: its header where its map mode puts it (LoROM 0x7FC0, HiROM 0xFFC0), checksum and complement agreeing; a
 *  copier's 512 bytes in front when asked; an extended header with a game code when one is given */
export function snesRom(o: { hi?: boolean; copier?: boolean; title?: string; code?: string; region?: number } = {}): Uint8Array {
  const rom = new Uint8Array(512 * 1024);
  const at = o.hi ? 0xffc0 : 0x7fc0;
  put(rom, at, (o.title ?? "SYNTH SNES").padEnd(21, " "));
  rom[at + 0x15] = o.hi ? 0x21 : 0x20;
  rom[at + 0x19] = o.region ?? 1;
  if (o.code) { rom[at + 0x1a] = 0x33; put(rom, at - 0x10, "01"); put(rom, at - 0x0e, o.code); }
  le16(rom, at + 0x1c, 0x1234 ^ 0xffff); le16(rom, at + 0x1e, 0x1234);
  if (!o.copier) return rom;
  const out = new Uint8Array(rom.length + 512);
  out.set(rom, 512);
  return out;
}
/** a Mega Drive / Genesis ROM header */
export function genesisRom(o: { serial?: string; name?: string; system?: string } = {}): Uint8Array {
  const b = new Uint8Array(512 * 1024);
  put(b, 0x100, (o.system ?? "SEGA GENESIS").padEnd(16, " "));
  put(b, 0x120, (o.name ?? "SYNTH MD").padEnd(48, " "));
  put(b, 0x150, (o.name ?? "SYNTH MD").padEnd(48, " "));
  put(b, 0x180, (o.serial ?? "GM 00001234-01").padEnd(14, " "));
  put(b, 0x1f0, "JUE");
  return b;
}

/* ─────────── bytes for the formats below ─────────── */

const le64 = (b: Uint8Array, at: number, v: number | bigint) => new DataView(b.buffer, b.byteOffset, b.byteLength).setBigUint64(at, BigInt(v), true);
const be64 = (b: Uint8Array, at: number, v: number | bigint) => new DataView(b.buffer, b.byteOffset, b.byteLength).setBigUint64(at, BigInt(v), false);
const be16 = (b: Uint8Array, at: number, v: number) => { b[at] = (v >>> 8) & 0xff; b[at + 1] = v & 0xff; };
const bytesOf = (d: Uint8Array | string) => (typeof d === "string" ? enc.encode(d) : d);
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
/** bytes nothing compresses (xorshift32 in integer arithmetic, so two runs with one seed are alike) */
export function noise(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x >>> 24; }
  return b;
}
const sha256 = (b: Uint8Array) => new Uint8Array(new Bun.CryptoHasher("sha256").update(b).digest());

/* ─────────── PlayStation system files ─────────── */

/** a PARAM.SFO: the keys sorted as the console writes them, text ending in NUL in room rounded up to four bytes, numbers
 *  as u32 (0x0404) */
export function sfo(fields: Record<string, string | number>): Uint8Array {
  const keys = Object.keys(fields).sort();
  const keyBytes: number[] = [], keyOff: number[] = [];
  for (const k of keys) { keyOff.push(keyBytes.length); keyBytes.push(...enc.encode(k), 0); }
  while (keyBytes.length % 4) keyBytes.push(0);
  const data: number[] = [];
  const entries: [number, number, number, number, number][] = [];
  keys.forEach((k, i) => {
    const v = fields[k], off = data.length;
    if (typeof v === "number") { data.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); entries.push([keyOff[i], 0x0404, 4, 4, off]); }
    else {
      const t = enc.encode(v), len = t.length + 1, room = Math.ceil(len / 4) * 4;
      data.push(...t, 0);
      while (data.length - off < room) data.push(0);
      entries.push([keyOff[i], 0x0204, len, room, off]);
    }
  });
  const keyStart = 0x14 + keys.length * 16, dataStart = keyStart + keyBytes.length;
  const out = new Uint8Array(dataStart + data.length);
  out.set([0, 0x50, 0x53, 0x46], 0); le32(out, 4, 0x0101); le32(out, 8, keyStart); le32(out, 12, dataStart); le32(out, 16, keys.length);
  entries.forEach(([ko, fmt, len, room, off], i) => { const e = 0x14 + i * 16; le16(out, e, ko); le16(out, e + 2, fmt); le32(out, e + 4, len); le32(out, e + 8, room); le32(out, e + 12, off); });
  out.set(keyBytes, keyStart); out.set(data, dataStart);
  return out;
}

export interface Ps5ParamOpts { titleId?: string; contentId?: string | null; version?: string; appVersion?: string; category?: number | null; title?: string; bom?: boolean; extra?: Record<string, unknown> }
/** a PS5 game's sce_sys/param.json with the keys KytyPS5 reads (systemContent.cpp:164-220) among the others a console's
 *  dump carries; category null leaves applicationCategoryType out (an add-on's), contentId null leaves the content id out */
export function ps5Param(o: Ps5ParamOpts = {}): Uint8Array {
  const titleId = o.titleId ?? "PPSA01341";
  const j: Record<string, unknown> = {
    ageLevel: { default: 17 }, ...(o.category === null ? {} : { applicationCategoryType: o.category ?? 0 }), applicationDrmType: "standard", attribute: 0,
    ...(o.contentId === null ? {} : { contentId: o.contentId ?? `EP9000-${titleId}_00-SYNTHETICGAME000` }),
    contentVersion: o.version ?? "01.007.000", ...(o.appVersion ? { appVersion: o.appVersion } : {}),
    kernel: { flexibleMemorySize: 268435456 },
    localizedParameters: { defaultLanguage: "en-GB", "en-GB": { titleName: o.title ?? "Synthetic Souls" }, "ja-JP": { titleName: "シンセティック" } },
    requiredSystemSoftwareVersion: "0x0114000000000000", titleId, userDefinedParam1: 2, ...o.extra,
  };
  const text = enc.encode(JSON.stringify(j, null, 2));
  return o.bom ? concat([new Uint8Array([0xef, 0xbb, 0xbf]), text]) : text;
}
/** the first bytes of a PS5 program (an ELF header and a little more) */
export const eboot = () => { const b = noise(4096, 77); b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0x12], 0); return b; };

/** a PS5 app0 folder at `dir`: sce_sys/param.json, eboot.bin (unless eboot false) and a few files of game data */
export function writeApp0(dir: string, o: Ps5ParamOpts & { eboot?: boolean; files?: Record<string, Uint8Array | string> } = {}): string {
  mkdirSync(join(dir, "sce_sys"), { recursive: true });
  writeFileSync(join(dir, "sce_sys", "param.json"), ps5Param(o));
  writeFileSync(join(dir, "sce_sys", "icon0.png"), noise(256, 3));
  if (o.eboot !== false) writeFileSync(join(dir, "eboot.bin"), eboot());
  const files = o.files ?? { "playgo-chunkdefs.xml": "<?xml version=\"1.0\"?><psproject><chunks default_chunk=\"0\"/></psproject>", "coredata/enginesupport/shaders/a.csdr": noise(2048, 5), "levels/m01/map.bin": noise(8192, 6) };
  for (const [p, v] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), bytesOf(v)); }
  return dir;
}
/** a PS4 (or Vita) game folder: sce_sys/param.sfo and eboot.bin */
export function writeSfoFolder(dir: string, fields: Record<string, string | number>, o: { eboot?: boolean; at?: "sce_sys" | "PS3_GAME" | "PSP_GAME" | "root" } = {}): string {
  const at = o.at ?? "sce_sys";
  const file = at === "sce_sys" ? join(dir, "sce_sys", "param.sfo") : at === "root" ? join(dir, "PARAM.SFO") : join(dir, at, "PARAM.SFO");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sfo(fields));
  if (o.eboot !== false && at === "sce_sys") writeFileSync(join(dir, "eboot.bin"), eboot());
  if (at === "PS3_GAME") { mkdirSync(join(dir, "PS3_GAME", "USRDIR"), { recursive: true }); writeFileSync(join(dir, "PS3_GAME", "USRDIR", "EBOOT.BIN"), noise(512, 9)); }
  return dir;
}

/** a PSP UMD or a PS3 disc as ISO 9660: the volume descriptor at 16, the root folder at 18 holding PSP_GAME (or PS3_GAME)
 *  at 19, whose PARAM.SFO is at 20 */
export function sfoIso(fields: Record<string, string | number>, folder: "PSP_GAME" | "PS3_GAME" = "PSP_GAME", o: { size?: number } = {}): Uint8Array {
  const sectors = Math.ceil((o.size ?? 2 * 1024 * 1024) / 2048);
  const iso = new Uint8Array(sectors * 2048);
  const pvd = iso.subarray(16 * 2048, 17 * 2048);
  pvd[0] = 1; put(pvd, 1, "CD001"); pvd[6] = 1;
  put(pvd, 40, "SYNTHETIC".padEnd(32, " "));
  const rec = (at: Uint8Array, off: number, name: Uint8Array, extent: number, size: number, dir: boolean) => {
    const len = 33 + name.length + ((33 + name.length) % 2);
    at[off] = len; le32(at, off + 2, extent); be32(at, off + 6, extent); le32(at, off + 10, size); be32(at, off + 14, size);
    at[off + 25] = dir ? 2 : 0; at[off + 32] = name.length; at.set(name, off + 33);
    return off + len;
  };
  rec(pvd, 156, new Uint8Array([0]), 18, 2048, true);
  const body = sfo(fields);
  const root = iso.subarray(18 * 2048, 19 * 2048);
  let off = rec(root, 0, new Uint8Array([0]), 18, 2048, true);
  off = rec(root, off, new Uint8Array([1]), 18, 2048, true);
  off = rec(root, off, enc.encode(folder), 19, 2048, true);
  rec(root, off, enc.encode("UMD_DATA.BIN;1"), 21, 16, false);
  const sub = iso.subarray(19 * 2048, 20 * 2048);
  let s = rec(sub, 0, new Uint8Array([0]), 19, 2048, true);
  s = rec(sub, s, new Uint8Array([1]), 18, 2048, true);
  rec(sub, s, enc.encode("PARAM.SFO;1"), 20, body.length, false);
  iso.set(body, 20 * 2048);
  put(iso, 21 * 2048, "ULUS-10041|0001");
  return iso;
}

/* ─────────── ZArchive (.zar) ─────────── */

/**
 * A real ZArchive, as Exzap/ZArchive @ d2c71773 lays one out (zarchivecommon.h, zarchivereader.cpp): the files' bytes as
 * one stream cut into 64 KiB blocks (each a zstd frame, or stored when that saves nothing or `raw`), the offset records
 * (a base u64 and 16 sizes − 1 per 16 blocks), the names (a length byte, two when the top bit is set), the file tree
 * (16-byte entries, the root first, each folder's children together and in name order), an empty meta directory and
 * meta data, and the 144-byte footer — every number big-endian. Files are streamed in the order given (so a test can put
 * a file across a block's end).
 */
export function zarArchive(files: { path: string; data: Uint8Array | string }[], o: { raw?: boolean; rawBlocks?: number[] } = {}): Uint8Array {
  interface N { name: string; file: boolean; data?: Uint8Array; kids: Map<string, N>; offset?: number }
  const root: N = { name: "", file: false, kids: new Map() };
  const order: N[] = [];
  for (const f of files) {
    const parts = f.path.split("/");
    let at = root;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      let n = at.kids.get(p.toLowerCase());
      if (!n) { n = { name: p, file: last, kids: new Map(), ...(last ? { data: bytesOf(f.data) } : {}) }; at.kids.set(p.toLowerCase(), n); if (last) order.push(n); }
      at = n;
    });
  }
  // the stream
  let len = 0;
  for (const n of order) { n.offset = len; len += n.data!.length; }
  const stream = new Uint8Array(Math.max(1, Math.ceil(len / 65536)) * 65536);
  for (const n of order) stream.set(n.data!, n.offset!);
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < stream.length; i += 65536) {
    const block = stream.subarray(i, i + 65536);
    const z = Bun.zstdCompressSync(block);
    blocks.push(o.raw || o.rawBlocks?.includes(i / 65536) || z.length >= 65536 ? block : new Uint8Array(z));
  }
  const data = concat(blocks);
  const records = new Uint8Array(Math.ceil(blocks.length / 16) * 40);
  let base = 0;
  for (let r = 0; r * 16 < blocks.length; r++) {
    be64(records, r * 40, base);
    for (let i = 0; i < 16 && r * 16 + i < blocks.length; i++) { const sz = blocks[r * 16 + i].length; be16(records, r * 40 + 8 + i * 2, sz - 1); base += sz; }
  }
  // the tree, level by level, each folder's children in name order (ASCII case ignored)
  const fold = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());
  const nodes: N[] = [root];
  const start = new Map<N, number>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.file) continue;
    const kids = [...n.kids.values()].sort((a, b) => (fold(a.name) < fold(b.name) ? -1 : fold(a.name) > fold(b.name) ? 1 : 0));
    start.set(n, nodes.length);
    nodes.push(...kids);
  }
  const nameBytes: number[] = [], nameOff = new Map<N, number>();
  for (const n of nodes.slice(1)) {
    const b = Array.from(n.name, c => c.charCodeAt(0) & 0xff);
    nameOff.set(n, nameBytes.length);
    if (b.length < 0x80) nameBytes.push(b.length); else nameBytes.push(0x80 | (b.length & 0x7f), b.length >> 7);
    nameBytes.push(...b);
  }
  const tree = new Uint8Array(nodes.length * 16);
  nodes.forEach((n, i) => {
    const at = i * 16;
    be32(tree, at, (n.file ? 0x80000000 : 0) | (n === root ? 0x7fffffff : nameOff.get(n)!));
    if (n.file) {
      const off = n.offset!, size = n.data!.length;
      be32(tree, at + 4, off >>> 0); be32(tree, at + 8, size >>> 0); be32(tree, at + 12, (Math.floor(size / 2 ** 32) << 16) | Math.floor(off / 2 ** 32));
    } else { be32(tree, at + 4, start.get(n) ?? 0); be32(tree, at + 8, n.kids.size); }
  });
  const names = new Uint8Array(nameBytes);
  const body = concat([data, records, names, tree]);
  const footer = new Uint8Array(144);
  const sections = [[0, data.length], [data.length, records.length], [data.length + records.length, names.length], [data.length + records.length + names.length, tree.length], [body.length, 0], [body.length, 0]];
  sections.forEach(([off, size], i) => { be64(footer, i * 16, off); be64(footer, i * 16 + 8, size); });
  footer.set(sha256(body), 96);
  be64(footer, 128, body.length + 144);
  be32(footer, 136, 0x61bf3a01); be32(footer, 140, 0x169f52d6);
  return concat([body, footer]);
}

/* ─────────── UDF disc images ─────────── */

/** CRC-ITU-T as a UDF tag carries it over its descriptor (polynomial 0x1021, starting at 0) */
function crcItu(b: Uint8Array): number {
  let crc = 0;
  for (const x of b) { crc ^= x << 8; for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
/** a descriptor's 16-byte tag: identifier, version 3, the CRC of `len` bytes after it, where it is, and the checksum */
function tag(b: Uint8Array, id: number, location: number, len = b.length) {
  le16(b, 0, id); le16(b, 2, 3); le16(b, 6, 1);
  const crcLen = Math.max(0, Math.min(len, b.length) - 16);
  le16(b, 8, crcItu(b.subarray(16, 16 + crcLen))); le16(b, 10, crcLen); le32(b, 12, location);
  let sum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) sum = (sum + b[i]) & 0xff;
  b[4] = sum;
}
const dstr = (s: string, utf16 = false) => (utf16 ? new Uint8Array([16, ...Array.from(s).flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])]) : new Uint8Array([8, ...Array.from(s, c => c.charCodeAt(0) & 0xff)]));

export interface UdfOpts { files: { path: string; data: Uint8Array | string }[]; efe?: boolean; metadata?: boolean; corruptMetadata?: boolean; utf16?: boolean; metaGap?: number }
/**
 * A UDF 2.50 disc image as a Blu-ray is laid out: the volume recognition sequence (BEA01 NSR03 TEA01), the main and reserve
 * volume descriptor sequences (a primary, a partition, a logical volume and a terminating descriptor), the anchor at sector
 * 256, and one partition from sector 300 whose first block is the metadata file's entry. The metadata partition (map 1,
 * "*UDF Metadata Partition") holds the file set descriptor, every file entry and every folder's records; the files' bytes
 * are in the physical partition (map 0), reached by long_ads. Folders' entries point at their records by short_ads, which
 * go through the metadata file's map. With `metadata: false` everything is in the one physical partition; `efe: false`
 * writes file entries (tag 261) in place of extended ones (tag 266); `corruptMetadata` damages the main metadata file entry
 * so only its mirror can be read; `utf16` writes the names as UTF-16 (a d-string of compression id 16); `metaGap` puts a run
 * of that many blocks allocated but not recorded in the metadata file's map after its first block (the file set descriptor),
 * so every later metadata block is numbered past the run while it lies right after that block on the disc.
 */
export function udfImage(o: UdfOpts): Uint8Array {
  const S = 2048, P = 300, efe = o.efe !== false, meta = o.metadata !== false;
  interface N { name: string; dir: boolean; kids: Map<string, N>; data?: Uint8Array; parent?: N; fe?: number; recs?: number; at?: number }
  const root: N = { name: "", dir: true, kids: new Map() };
  for (const f of o.files) {
    const parts = f.path.split("/");
    let at = root;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      let n = at.kids.get(p);
      if (!n) { n = { name: p, dir: !last, kids: new Map(), parent: at, ...(last ? { data: bytesOf(f.data) } : {}) }; at.kids.set(p, n); }
      at = n;
    });
  }
  const nodes: N[] = [root];
  for (let i = 0; i < nodes.length; i++) nodes.push(...nodes[i].kids.values());
  // the metadata partition's blocks: the file set descriptor, then each node's entry and each folder's records
  let mb = 1;
  for (const n of nodes) { n.fe = mb++; if (n.dir) n.recs = mb++; }
  const metaBlocks = mb;
  const metaAt = 1;                                          // where the metadata partition's blocks start in the partition
  const mirrorFe = metaAt + metaBlocks;                      // the mirror metadata file's entry
  let next = mirrorFe + 1;
  for (const n of nodes) if (!n.dir) { n.at = next; next += Math.max(1, Math.ceil(n.data!.length / S)); }
  const partLen = next + 4;
  const img = new Uint8Array((P + partLen) * S);
  const sector = (s: number) => img.subarray(s * S, (s + 1) * S);
  // block m of the metadata partition is physical block metaAt + m; descriptors name it as m in the metadata partition
  // (map 1), or as metaAt + m in the physical one when there is no metadata partition
  const metaRef = meta ? 1 : 0;
  const gap = meta ? o.metaGap ?? 0 : 0;
  const ref = (m: number) => (meta ? (gap && m >= 1 ? m + gap : m) : metaAt + m);
  const metaBlock = (m: number) => sector(P + metaAt + m);
  // volume recognition
  for (const [i, id] of [[16, "BEA01"], [17, "NSR03"], [18, "TEA01"]] as const) { const s = sector(i); s[0] = 0; put(s, 1, id); s[6] = 1; }
  // descriptor sequences at 32 (main) and 64 (reserve)
  for (const base of [32, 64]) {
    const pvd = sector(base);
    put(pvd, 24, "PS5VOLUME"); tag(pvd, 1, base, 512);
    const pd = sector(base + 1);
    le16(pd, 20, 1); le16(pd, 22, 0); put(pd, 25, "+NSR03"); le32(pd, 184, 1); le32(pd, 188, P); le32(pd, 192, partLen); tag(pd, 5, base + 1, 256);
    const lvd = sector(base + 2);
    le32(lvd, 212, S); put(lvd, 217, "*OSTA UDF Compliant");
    le32(lvd, 248, S); le32(lvd, 252, ref(0)); le16(lvd, 256, metaRef);
    const maps = new Uint8Array(meta ? 70 : 6);
    maps[0] = 1; maps[1] = 6; le16(maps, 2, 1); le16(maps, 4, 0);
    if (meta) {
      maps[6] = 2; maps[7] = 64; put(maps, 6 + 5, "*UDF Metadata Partition"); le16(maps, 6 + 28, 0x0250);
      le16(maps, 6 + 36, 1); le16(maps, 6 + 38, 0); le32(maps, 6 + 40, 0); le32(maps, 6 + 44, mirrorFe); le32(maps, 6 + 48, 0xffffffff); le32(maps, 6 + 52, 32); le16(maps, 6 + 56, 1);
    }
    le32(lvd, 264, maps.length); le32(lvd, 268, meta ? 2 : 1); lvd.set(maps, 440); tag(lvd, 6, base + 2, 440 + maps.length);
    tag(sector(base + 3), 8, base + 3, 16);
  }
  const avdp = sector(256);
  le32(avdp, 16, 4 * S); le32(avdp, 20, 32); le32(avdp, 24, 4 * S); le32(avdp, 28, 64); tag(avdp, 2, 256, 32);
  // an entry: file type, information length, its allocation descriptors (type 0 short, 1 long)
  const entry = (blk: Uint8Array, loc: number, type: number, size: number, adType: 0 | 1, ads: Uint8Array) => {
    le16(blk, 20, 4); le16(blk, 24, 1); blk[27] = type; le16(blk, 34, adType);
    le32(blk, 36, 0xffffffff); le32(blk, 40, 0xffffffff); le32(blk, 44, 0x14a5); le16(blk, 48, 1);
    le64(blk, 56, size);
    const blocks = Math.ceil(size / S);
    if (efe) { le64(blk, 64, size); le64(blk, 72, blocks); le32(blk, 208, 0); le32(blk, 212, ads.length); blk.set(ads, 216); tag(blk, 266, loc, 216 + ads.length); }
    else { le64(blk, 64, blocks); le32(blk, 168, 0); le32(blk, 172, ads.length); blk.set(ads, 176); tag(blk, 261, loc, 176 + ads.length); }
  };
  const shortAd = (len: number, pos: number) => { const a = new Uint8Array(8); le32(a, 0, len); le32(a, 4, pos); return a; };
  const longAd = (len: number, lbn: number, part: number) => { const a = new Uint8Array(16); le32(a, 0, len); le32(a, 4, lbn); le16(a, 8, part); return a; };
  if (meta) {
    // the map: the blocks as they lie, or the first block, the run not recorded (extent type 1), then the rest
    const map = gap ? concat([shortAd(S, metaAt), shortAd((1 << 30) | (gap * S), 0), shortAd((metaBlocks - 1) * S, metaAt + 1)]) : shortAd(metaBlocks * S, metaAt);
    entry(sector(P + 0), 0, 250, (metaBlocks + gap) * S, 0, map);
    entry(sector(P + mirrorFe), mirrorFe, 251, (metaBlocks + gap) * S, 0, map);
    if (o.corruptMetadata) sector(P + 0)[4] ^= 0xff;
  }
  // the file set descriptor: the root folder's entry
  const fsd = metaBlock(0);
  le32(fsd, 400, S); le32(fsd, 404, ref(root.fe!)); le16(fsd, 408, metaRef); tag(fsd, 256, ref(0), 512);
  for (const n of nodes) {
    if (n.dir) {
      const recs: Uint8Array[] = [];
      const fid = (name: string | null, kid: N, parent: boolean) => {
        const nb = name ? dstr(name, o.utf16) : new Uint8Array(0);
        const b = new Uint8Array((38 + nb.length + 3) & ~3);
        b[18] = (kid.dir ? 2 : 0) | (parent ? 8 : 0); b[19] = nb.length;
        le32(b, 20, S); le32(b, 24, ref(kid.fe!)); le16(b, 28, metaRef); b.set(nb, 38);
        tag(b, 257, ref(n.recs!), 38 + nb.length);
        recs.push(b);
      };
      fid(null, n.parent ?? n, true);
      for (const k of n.kids.values()) fid(k.name, k, false);
      const all = concat(recs);
      metaBlock(n.recs!).set(all);
      entry(metaBlock(n.fe!), ref(n.fe!), 4, all.length, 0, shortAd(all.length, ref(n.recs!)));
    } else {
      const d = n.data!;
      img.set(d, (P + n.at!) * S);
      entry(metaBlock(n.fe!), ref(n.fe!), 5, d.length, 1, d.length ? longAd(d.length, n.at!, 0) : new Uint8Array(0));
    }
  }
  return img;
}

/** bd/param.json as a PS5 disc carries it: a binary header with "SCECDF" at 0, the JSON from 0x800 */
export function bdParam(o: { masterDataId?: string; masterVersion?: string; discNumber?: number } = {}): Uint8Array {
  const head = new Uint8Array(0x800);
  put(head, 0, "SCECDF");
  put(head, 0x260, (o.masterDataId ?? "PPSA01342").replace(/^(\w{4})/, "$1-"));
  const json = { disc: [{ masterDataId: o.masterDataId ?? "PPSA01342", role: "Play Disc" }], discNumber: o.discNumber ?? 0, discTotal: 1, masterVersion: o.masterVersion ?? "01.00", pubtoolsVersion: "1.89", requiredSystemSoftwareVersion: "0x0700000000000000" };
  return concat([head, enc.encode(JSON.stringify(json))]);
}
/** a PS5 package's first bytes: its magic and, in the clear, its content id */
export function ps5Pkg(contentId = "UP9000-PPSA01342_00-DEMONSSOULS00000", size = 8192): Uint8Array {
  const b = noise(size, 41);
  b.fill(0, 0, 0x100);
  b.set([0x7f, 0x46, 0x49, 0x48], 0);
  put(b, 0x40, contentId);
  return b;
}
/** the US retail disc of a PS5 game as a PC drive reads it: bd/param.json, the encrypted package under app/<id>/, the
 *  license and the system update — and no game folder at the root */
export function ps5Disc(o: { masterDataId?: string; masterVersion?: string; contentId?: string; efe?: boolean; metadata?: boolean } = {}): Uint8Array {
  const id = o.masterDataId ?? "PPSA01342";
  return udfImage({
    efe: o.efe, metadata: o.metadata,
    files: [
      { path: "bd/param.json", data: bdParam({ masterDataId: id, masterVersion: o.masterVersion }) },
      { path: `app/${id}/app_0.pkg`, data: ps5Pkg(o.contentId ?? `UP9000-${id}_00-DEMONSSOULS00000`) },
      { path: `app/${id}/app_sc.pkg`, data: noise(4096, 43) },
      { path: `app/${id}/app.json`, data: "{\"version\":1}" },
      { path: "license/rif", data: noise(1024, 44) },
      { path: "PS5/UPDATE/PS5UPDATE.PUP", data: noise(4096, 45) },
    ],
  });
}

/* ─────────── .nup (a Switch 2 dump packed by Eglantine) ─────────── */

/** a Switch program's NSO header: "NSO0", then its module (build) id at 0x40-0x60; the rest of `size` made-up bytes */
export function nso(build: string, size = 0x2000): Uint8Array {
  const b = noise(size, 51);
  b.fill(0, 0, 0x100);
  put(b, 0, "NSO0");
  const id = build.padEnd(64, "0");
  for (let i = 0; i < 32; i++) b[0x40 + i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
  return b;
}
export interface NupPkg { title: string; kind: 0 | 1 | 2; version: number; exefs?: { name: string; data: Uint8Array; codec?: 0 | 1 }[]; romfs?: { name: string; data: Uint8Array }[] }
/**
 * A .nup as NX2navi's tools/nup.py reads one (struct formats at nup.py:20-23 and 46, read as text): the superblock
 * '<4sHHQQ32sQQII16s32s' at 0, the files' stored bytes from 0x80 (codec 0 as they are, codec 1 one zstd frame), then the
 * TOC: '<IIQQQQQ' ("TOC\x01", packages, dirs, files, the name pool's offset from the TOC and its length, 0), the packages
 * from TOC+0x30 at 0x40 each '<QIIIIBBHIQI20s', the dirs at 0x18 each '<IIIIQ' (a package's root holding its exefs and romfs
 * dirs), the files at 0x50 each '<IIQQQ32sBBH12s' (each with the sha256 of its bytes), the children as u32 (a dir below the
 * dir count, else the dir count + a file index: nup.py:59, 72-78), and the name pool; the superblock holds the TOC's
 * sha256 (nup.py:44), unless `damageToc`.
 */
export function nupFile(pkgs: NupPkg[], o: { damageToc?: boolean } = {}): Uint8Array {
  interface D { name: string; kids: ({ dir: number } | { file: number })[] }
  interface F { name: string; size: number; stored: Uint8Array; sha: Uint8Array; codec: number; off?: number }
  const dirs: D[] = [], files: F[] = [];
  const pkgDirs: { root: number; exefs: number; romfs: number }[] = [];
  for (const p of pkgs) {
    const root = dirs.length, exefs = root + 1, romfs = root + 2;
    dirs.push({ name: "", kids: [{ dir: exefs }, { dir: romfs }] }, { name: "exefs", kids: [] }, { name: "romfs", kids: [] });
    for (const f of p.exefs ?? []) { dirs[exefs].kids.push({ file: files.length }); files.push({ name: f.name, size: f.data.length, stored: f.codec === 1 ? new Uint8Array(Bun.zstdCompressSync(f.data)) : f.data, sha: sha256(f.data), codec: f.codec ?? 0 }); }
    for (const f of p.romfs ?? []) { dirs[romfs].kids.push({ file: files.length }); files.push({ name: f.name, size: f.data.length, stored: f.data, sha: sha256(f.data), codec: 0 }); }
    pkgDirs.push({ root, exefs, romfs });
  }
  // the blob after the superblock
  let at = 0x80;
  for (const f of files) { f.off = at; at += f.stored.length; }
  const blob = concat(files.map(f => f.stored));
  const tocOff = Math.ceil(at / 16) * 16;
  // names
  const pool: number[] = [];
  const nameAt = (s: string) => { const b = enc.encode(s); const off = pool.length; pool.push(...b); return [off, b.length] as const; };
  const ndir = dirs.length, nfile = files.length;
  const kids: number[] = [];
  const dirRecs = new Uint8Array(ndir * 0x18);
  dirs.forEach((d, i) => {
    const [no, nl] = nameAt(d.name);
    le32(dirRecs, i * 0x18, no); le32(dirRecs, i * 0x18 + 4, nl); le32(dirRecs, i * 0x18 + 8, kids.length); le32(dirRecs, i * 0x18 + 12, d.kids.length);
    for (const k of d.kids) kids.push("dir" in k ? k.dir : ndir + k.file);
  });
  const fileRecs = new Uint8Array(nfile * 0x50);
  files.forEach((f, i) => {
    const [no, nl] = nameAt(f.name), r = i * 0x50;
    le32(fileRecs, r, no); le32(fileRecs, r + 4, nl); le64(fileRecs, r + 8, f.size); le64(fileRecs, r + 16, f.off!); le64(fileRecs, r + 24, f.stored.length);
    fileRecs.set(f.sha, r + 32); fileRecs[r + 64] = f.codec;
  });
  const pkgRecs = new Uint8Array(pkgs.length * 0x40);
  pkgs.forEach((p, i) => {
    const r = i * 0x40;
    le64(pkgRecs, r, BigInt("0x" + p.title)); le32(pkgRecs, r + 8, pkgDirs[i].root); le32(pkgRecs, r + 12, pkgDirs[i].exefs); le32(pkgRecs, r + 16, pkgDirs[i].romfs);
    le32(pkgRecs, r + 20, p.version); pkgRecs[r + 24] = p.kind;
  });
  const kidRecs = new Uint8Array(kids.length * 4);
  kids.forEach((k, i) => le32(kidRecs, i * 4, k));
  const head = new Uint8Array(0x30);
  const poolOff = 0x30 + pkgRecs.length + dirRecs.length + fileRecs.length + kidRecs.length;
  le32(head, 0, 0x01434f54); le32(head, 4, pkgs.length); le64(head, 8, ndir); le64(head, 16, nfile); le64(head, 24, poolOff); le64(head, 32, pool.length);
  const toc = concat([head, pkgRecs, dirRecs, fileRecs, kidRecs, new Uint8Array(pool)]);
  const sb = new Uint8Array(0x80);
  put(sb, 0, "NUP\x01"); le16(sb, 4, 0x80); le16(sb, 6, 1); le64(sb, 8, tocOff); le64(sb, 16, toc.length);
  sb.set(sha256(toc), 24); le64(sb, 56, 0x80); le64(sb, 64, tocOff + toc.length); le32(sb, 72, pkgs.length); sb.set(noise(16, 61), 80);
  if (o.damageToc) toc[0x30 + 20] ^= 0xff;                               // a byte of the first package changed after the hash
  const out = new Uint8Array(tocOff + toc.length);
  out.set(sb, 0); out.set(blob, 0x80); out.set(toc, tocOff);
  return out;
}
/** Ocarina of Time for Switch 2 as NX2navi takes it: the base (0400486024DEC000) and its 1.1.1 update (|0x800) whose exefs
 *  main has build e0f3ccfa…; `zstd` stores the update's main as one zstd frame */
export function ootNup(o: { build?: string; base?: string; zstd?: boolean; mainSize?: number; noUpdate?: boolean; onlyUpdate?: boolean } = {}): Uint8Array {
  const base = o.base ?? "0400486024DEC000";
  const update = (BigInt("0x" + base) | 0x800n).toString(16).toUpperCase().padStart(16, "0");
  const build = o.build ?? "e0f3ccfaf50065ae4ea01eb5aeb13b1a";
  const exefs = (b: string, codec: 0 | 1) => [
    { name: "main.npdm", data: concat([enc.encode("META"), noise(0x200, 7)]) },
    { name: "main", data: nso(b, o.mainSize ?? 0x2000), codec },
    { name: "rtld", data: nso("1111111111111111", 0x400) },
  ];
  const pkgs: NupPkg[] = [];
  if (!o.onlyUpdate) pkgs.push({ title: base, kind: 0, version: 0, exefs: exefs("aaaaaaaabbbbbbbb", 0), romfs: [{ name: "romfs.bin", data: noise(4096, 8) }] });
  if (!o.noUpdate) pkgs.push({ title: update, kind: 1, version: 196608, exefs: exefs(build, o.zstd ? 1 : 0), romfs: [{ name: "patch.bin", data: noise(1024, 9) }] });
  return nupFile(pkgs);
}

/** a Switch game's folders as hactool unpacks them and NX2navi's --exefs / --romfs take them: exefs/main (an NSO whose
 *  build is `build`), exefs/main.npdm, exefs/rtld and a romfs file */
export function writeExefsFolder(dir: string, build = "e0f3ccfaf50065ae4ea01eb5aeb13b1a", o: { main?: Uint8Array } = {}): string {
  mkdirSync(join(dir, "exefs"), { recursive: true });
  mkdirSync(join(dir, "romfs"), { recursive: true });
  writeFileSync(join(dir, "exefs", "main"), o.main ?? nso(build));
  writeFileSync(join(dir, "exefs", "main.npdm"), concat([enc.encode("META"), noise(0x200, 7)]));
  writeFileSync(join(dir, "exefs", "rtld"), nso("1111111111111111", 0x400));
  writeFileSync(join(dir, "romfs", "romfs.bin"), noise(4096, 8));
  return dir;
}

/* ─────────── images ludarr only names ─────────── */

/** the first sectors of an exFAT disk image (its boot sector: "EXFAT   " at 3, 0x55AA at 510) */
export function exfatImage(size = 64 * 1024): Uint8Array { const b = new Uint8Array(size); b.set([0xeb, 0x76, 0x90], 0); put(b, 3, "EXFAT   "); b[510] = 0x55; b[511] = 0xaa; return b; }
/** a UFS2 disk image's start (the superblock at 64 KiB, its magic 0x19540119 at 0x1055C) */
export function ufsImage(size = 0x20000): Uint8Array { const b = new Uint8Array(size); le32(b, 0x1055c, 0x19540119); return b; }
