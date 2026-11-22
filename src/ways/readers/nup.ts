/**
 * ludarr — a .nup (the plain container Eglantine packs a Switch 2 console's dump in; little-endian, nothing encrypted)
 * read into an identity: the title ids of its packages, the newest update's version, and the build id of the game's main
 * program. The layout is NX2navi's tools/nup.py (read as text, never run), struct by struct:
 *
 *   superblock  0x80 bytes '<4sHHQQ32sQQII16s32s' (nup.py:20): "NUP\x01", u16 0x80, u16 1, TOC offset, TOC size, sha256 of
 *               the TOC, blob offset, file size, package count, 0, a 16-byte unique id, 32 zero bytes (nup.py:3-4, 39-41)
 *   TOC         '<IIQQQQQ' (nup.py:46): "TOC\x01" (0x01434F54), packages, dirs, files, the name pool's offset (from the TOC)
 *               and length, 0; its sha256 must be the superblock's (nup.py:44)
 *   packages    from TOC+0x30 (nup.py:49), 0x40 each '<QIIIIBBHIQI20s' (nup.py:21, 52): title id, root / exefs / romfs dir,
 *               version, kind (0 base, 1 update, 2 dlc), …
 *   dirs        after them, 0x18 each '<IIIIQ' (nup.py:22, 55): name offset, name length, first child, child count
 *   files       after the dirs, 0x50 each '<IIQQQ32sBBH12s' (nup.py:23, 57): name offset, name length, size, data offset
 *               (absolute), stored size, sha256, codec (0 stored, 1 one zstd frame)
 *   children    u32 each up to the pool (nup.py:59): below the dir count a dir, else the dir count + a file index (72-78)
 *   names       the pool, UTF-8 (nup.py:60-64)
 *
 * The build: exefs/main of the base's newest update (its title id | 0x800), else of the base (the packages and the order
 * NX2navi's make_game.py:189-208 takes modules in, a module only when it is whole: ≥ 0x100 bytes starting "NSO0"); an
 * update of another title never lends its build or version to the base. The build id is the NSO header's module id, bytes
 * 0x40-0x60 (make_game.py:268-276 compares the first 16). A zstd-stored main is decoded from the first ≤ 256 KiB of its
 * frame only. A TOC larger than 4 MiB is not hashed whole; one whose parts lie past 16 MiB is not walked (an identity
 * without a build).
 */
import * as zlib from "node:zlib";
import { Bytes, hex, le32, le64, MAX_READ, nothing, nothingIn, raw, type Read } from "./bytes";
import type { Identity } from "../identity";

const TOC_MAGIC = 0x01434f54, SUPER = 0x80, TOC_HEAD = 0x30, PACKAGE = 0x40, DIRECTORY = 0x18, FILE = 0x50;
/** a TOC up to this is read whole and its sha256 checked */
const TOC_WHOLE = 4 * 1024 * 1024;
/** a TOC's parts past this are not walked */
const TOC_WALK = 16 * 1024 * 1024;
/** how much of a zstd-stored main is decoded for its header */
const MAIN_PREFIX = 256 * 1024;

export interface NupPackage { title: string; root: number; exefs: number; romfs: number; version: number; kind: number }

/** the first `need` bytes a zstd frame's prefix decodes to (node:zlib decodes a cut frame's beginning), or null */
export async function zstdHead(frame: Uint8Array, need: number, whole: boolean): Promise<Uint8Array | null> {
  const make = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream & { destroy(): void } }).createZstdDecompress;
  if (!make) return null;
  const z = make();
  return new Promise(resolve => {
    const parts: Buffer[] = [];
    let n = 0, settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { z.destroy(); } catch { /* gone */ }
      resolve(n >= need ? new Uint8Array(Buffer.concat(parts).subarray(0, need)) : null);
    };
    const timer = setTimeout(finish, 3000);
    z.on("data", (c: Buffer) => { parts.push(c); n += c.length; if (n >= need) finish(); });
    z.on("error", finish);
    z.on("end", finish);
    if (whole) z.end(Buffer.from(frame)); else z.write(Buffer.from(frame));
  });
}

/** what a .nup is: a Switch title's packages, their newest update, and its main program's build */
export async function readNup(b: Bytes): Promise<Read> {
  const sb = await b.at(0, SUPER);
  if (sb.length < SUPER || raw(sb.subarray(0, 4)) !== "NUP\x01") return nothingIn(b, "it does not start as a .nup does (NUP and version 1)");
  const tocOff = le64(sb, 8), tocSize = le64(sb, 16), tocSha = sb.subarray(24, 56);
  if (!Number.isSafeInteger(tocOff) || !Number.isSafeInteger(tocSize) || tocSize < TOC_HEAD || tocOff < SUPER || tocOff > b.size || tocSize > b.size - tocOff) {
    return nothingIn(b, "its table of contents lies outside the file (cut short?)");
  }
  // the TOC: whole and hashed when it is small enough, else read where it is needed
  let whole: Uint8Array | null = null;
  if (tocSize <= TOC_WHOLE) {
    whole = await b.span(tocOff, tocSize);
    if (whole.length < tocSize) return nothingIn(b, "its table of contents could not be read");
    const sha = new Uint8Array(new Bun.CryptoHasher("sha256").update(whole).digest());
    if (sha.some((x, i) => x !== tocSha[i])) return nothingIn(b, "its table of contents is damaged (its sha256 is not the one the file names)");
  }
  const toc = async (rel: number, len: number): Promise<Uint8Array | null> => {
    if (rel < 0 || len < 0 || rel + len > tocSize) return null;
    if (whole) return whole.subarray(rel, rel + len);
    if (rel + len > TOC_WALK || len > MAX_READ) return null;
    const got = await b.at(tocOff + rel, len);
    return got.length === len ? got : null;
  };
  const head = await toc(0, TOC_HEAD);
  if (!head || le32(head, 0) !== TOC_MAGIC) return nothingIn(b, "its table of contents does not start as a .nup's does (TOC and version 1)");
  const npkg = le32(head, 4), ndir = le64(head, 8), nfile = le64(head, 16), poolOff = le64(head, 24), poolLen = le64(head, 32);
  const dirsAt = TOC_HEAD + npkg * PACKAGE, filesAt = dirsAt + ndir * DIRECTORY, kidsAt = filesAt + nfile * FILE;
  if (!npkg || npkg > 1024 || ![ndir, nfile, poolOff, poolLen, kidsAt].every(Number.isSafeInteger) || kidsAt > poolOff || poolOff > tocSize || poolLen > tocSize - poolOff) {
    return nothingIn(b, "its table of contents is not consistent (its counts and the name pool do not fit in it)");
  }
  const pk = await toc(TOC_HEAD, npkg * PACKAGE);
  if (!pk) return nothingIn(b, "its package table could not be read");
  const packages: NupPackage[] = [];
  for (let i = 0; i < npkg; i++) {
    const at = i * PACKAGE;
    const id = new DataView(pk.buffer, pk.byteOffset + at, 8).getBigUint64(0, true);
    packages.push({ title: id.toString(16).toUpperCase().padStart(16, "0"), root: le32(pk, at + 8), exefs: le32(pk, at + 12), romfs: le32(pk, at + 16), version: le32(pk, at + 20), kind: pk[at + 24] });
  }
  if (packages.some(p => p.kind > 2)) return nothingIn(b, "a package in it is of a kind a .nup does not hold (base, update or add-on)");

  const name = async (off: number, len: number): Promise<string | null> => {
    if (len > 1024 || off + len > poolLen) return null;
    const bytes = await toc(poolOff + off, len);
    return bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : null;
  };
  /** a module of a package's exefs whole and of its kind: the file's record, or null */
  const exefsMain = async (p: NupPackage): Promise<{ off: number; stored: number; size: number; codec: number } | null> => {
    if (p.exefs >= ndir) return null;
    const d = await toc(dirsAt + p.exefs * DIRECTORY, DIRECTORY);
    if (!d) return null;
    const first = le32(d, 8), count = Math.min(le32(d, 12), 64);
    if (kidsAt + (first + count) * 4 > poolOff) return null;
    const kids = count ? await toc(kidsAt + first * 4, count * 4) : null;
    if (!kids) return null;
    for (let i = 0; i < count; i++) {
      const c = le32(kids, i * 4);
      if (c < ndir) continue;
      const fi = c - ndir;
      if (fi >= nfile) continue;
      const f = await toc(filesAt + fi * FILE, FILE);
      if (!f || (await name(le32(f, 0), le32(f, 4))) !== "main") continue;
      const size = le64(f, 8), off = le64(f, 16), stored = le64(f, 24), codec = f[64];
      if (![size, off, stored].every(Number.isSafeInteger) || size < 0x100 || off > b.size || stored > b.size - off || codec > 1) return null;
      return { off, stored, size, codec };
    }
    return null;
  };
  const byVersion = (x: NupPackage, y: NupPackage) => y.version - x.version;
  const base = packages.filter(p => p.kind === 0).sort(byVersion)[0] ?? null;
  // the base's own update (title id | 0x800, make_game.py:197); with no base, every update the file holds
  const ownUpdate = (p: NupPackage) => !base || BigInt("0x" + p.title) === (BigInt("0x" + base.title) | 0x800n);
  const updates = packages.filter(p => p.kind === 1 && ownUpdate(p)).sort(byVersion);
  const newestFirst = [...updates, ...packages.filter(p => p.kind === 0 && (!base || p.title === base.title)).sort(byVersion)];
  let build: string | undefined, from: NupPackage | null = null;
  for (const p of newestFirst) {
    const m = await exefsMain(p);
    if (!m) continue;
    let nso: Uint8Array | null;
    if (m.codec === 0) nso = await b.at(m.off, 0x100);
    else {
      const frame = await b.span(m.off, Math.min(m.stored, MAIN_PREFIX));
      nso = frame.length ? await zstdHead(frame, 0x100, frame.length === m.stored) : null;
    }
    if (!nso || nso.length < 0x100 || raw(nso.subarray(0, 4)) !== "NSO0") continue;
    build = hex(nso.subarray(0x40, 0x60));
    from = p;
    break;
  }

  const titles = [...new Set(packages.map(p => p.title))];
  const newest = updates[0] ?? base;
  const id: Identity = {
    platform: "switch", serial: (base ?? packages[0]).title, titles, ...(newest ? { version: `v${newest.version}` } : {}),
    category: base ? "game" : updates.length ? "patch" : "addon", shape: "nup", ...(build ? { build } : {}),
  };
  const kindWord = (k: number) => (k === 1 ? "update" : k === 2 ? "add-on" : "base");
  return { identity: id, why: build ? null : "its main program's build id could not be read", markers: from ? [`${kindWord(from.kind)} ${from.title} v${from.version}: exefs/main`] : [] };
}

/** a Switch package's header: an NSP (PFS0) names its title in its ticket's name; its contents need the console's keys */
export async function readPfs0(b: Bytes): Promise<Read> {
  const h = await b.at(0, MAX_READ);
  if (h.length < 16 || raw(h.subarray(0, 4)) !== "PFS0") return nothing("it does not start as an NSP does (PFS0)");
  const files = le32(h, 4), strSize = le32(h, 8);
  const names: string[] = [];
  const strAt = 16 + files * 24;
  if (files <= 4096 && strAt + strSize <= h.length) {
    for (let i = 0; i < files; i++) {
      const so = le32(h, 16 + i * 24 + 16);
      if (so >= strSize) continue;
      let end = strAt + so;
      while (end < strAt + strSize && end - (strAt + so) < 256 && h[end] !== 0) end++;
      names.push(raw(h.subarray(strAt + so, end)));
    }
  }
  // a ticket is named by its rights id: the title id, then the key generation (16 hex digits each)
  const titles = [...new Set(names.map(n => /^([0-9a-f]{16})[0-9a-f]{16}\.(tik|cert)$/i.exec(n)?.[1]?.toUpperCase()).filter((t): t is string => !!t))];
  return { identity: { platform: "switch", shape: "nsp", sealed: true, ...(titles.length ? { serial: titles[0], titles } : {}) }, why: null };
}

/** a Switch game card image (XCI: "HEAD" at 0x100); its contents need the console's keys */
export async function readXci(b: Bytes): Promise<Read> {
  const h = await b.at(0x100, 4);
  if (raw(h) !== "HEAD") return nothing("it does not hold a game card header (HEAD at 0x100)");
  return { identity: { platform: "switch", shape: "xci", sealed: true }, why: null };
}

