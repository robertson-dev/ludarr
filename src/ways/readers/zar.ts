/**
 * ludarr — a ZArchive (.zar: Exzap/ZArchive @ d2c71773, the form KytyPS5 reads a packed PS5 game folder in) read with
 * targeted reads only: the footer, the root folder's entries, the names they point at, sce_sys's entries, one offset
 * record and the blocks param.json lives in. Never the whole tables: a PS5 game's tree, names and records are megabytes.
 *
 * The layout (zarchivecommon.h and zarchivereader.cpp at d2c71773, with KytyPS5's bounds patch
 * 3rdparty/patches/zarchive-reader.patch; every number big-endian):
 *   footer      the last 144 bytes: six {offset u64, size u64} (compressed data, offset records, names, file tree, meta
 *               directory, meta data), an integrity hash [32], the total size u64 (= the file's size), version u32
 *               0x61bf3a01, magic u32 0x169f52d6 (common.h:247-300; reader.cpp:35-62; each section inside the file)
 *   file tree   16-byte entries, entry 0 the root, whose name offset is 0x7FFFFFFF (Kyty's patch, :28). The first word's top
 *               bit marks a file, its low 31 bits are the name's offset; a file: offset low u32, size low u32, then a word
 *               whose upper 16 bits are size bits 32-47 and lower 16 offset bits 32-47; a folder: first child, child count,
 *               reserved (common.h:133-199). A file's bytes lie inside the blocks the records cover, a folder's children
 *               inside the tree (the patch, :30-47)
 *   names       a length byte (its low 7 bits; with the top bit set the next byte adds bits 7-14, as the patch reads it —
 *               upstream read the first byte twice, :97), then the name; never empty, ".", "..", or holding / \ or NUL
 *               (:37); compared without regard to ASCII case (common.h:346-362)
 *   records     40 bytes: a base offset u64 and 16 × u16 (compressed size − 1), one record per 16 blocks of 64 KiB. Block b
 *               starts at data + record[b/16].base + Σ_{i < b%16}(size[i] + 1) and is size[b%16] + 1 bytes long: 65536
 *               means stored as it is, anything less one zstd frame of exactly 65536 bytes (reader.cpp:319-348)
 *
 * The identity is the PS5 one of sce_sys/param.json (readers/ps5.ts) with shape 'zar'; a game archive must hold eboot.bin
 * at its root, as KytyPS5 requires (src/main.cpp:209-214).
 */
import * as zlib from "node:zlib";
import { Bytes, be16, be32, be64, MAX_READ, nothing, nothingIn, OUT_OF_READS, withBytes, type Read } from "./bytes";
import { parseParamJson, ps5Identity } from "./ps5";

const FOOTER = 144, MAGIC = 0x169f52d6, VERSION1 = 0x61bf3a01;
const BLOCK = 64 * 1024, RECORD = 40, ENTRY = 16, PER_RECORD = 16;
/** the most entries of one folder looked at (one 64 KiB read of the tree) */
const FOLDER_MAX = MAX_READ / ENTRY;
/** the largest file read out of an archive for a look (param.json is a few KB) */
const PARAM_MAX = 1024 * 1024;

interface Section { offset: number; size: number }
/** an opened archive: its sections, how many tree entries, and how many bytes the blocks hold */
export interface Zar { b: Bytes; data: Section; records: Section; names: Section; tree: Section; entries: number; capacity: number }
/** one entry of the file tree */
export interface ZarNode { index: number; file: boolean; nameOffset: number; offset: number; size: number; start: number; count: number; name?: string }

/** the footer read and checked; the reason when the bytes are no ZArchive */
export async function openZar(b: Bytes): Promise<Zar | string> {
  if (b.size <= FOOTER) return "it is too short to be a .zar";
  const f = await b.at(b.size - FOOTER, FOOTER);
  if (f.length < FOOTER) return "its footer could not be read";
  if (be32(f, 140) !== MAGIC) return "its last bytes are not a ZArchive footer";
  if (be32(f, 136) !== VERSION1) return "its footer names a ZArchive version ludarr does not know";
  const total = be64(f, 128);
  if (total !== b.size) return `its footer says the archive is ${total} bytes and the file is ${b.size}: it is cut short or has bytes added`;
  const sections: Section[] = [0, 1, 2, 3, 4, 5].map(i => ({ offset: be64(f, i * 16), size: be64(f, i * 16 + 8) }));
  for (const s of sections) {
    if (!Number.isSafeInteger(s.offset) || !Number.isSafeInteger(s.size) || s.offset > b.size || s.size > b.size - s.offset) return "a section its footer names lies outside the file";
  }
  const [data, records, names, tree] = sections;
  if (records.size > 0xffffffff || names.size > 0x7fffffff || tree.size > 0xffffffff) return "its footer names tables larger than a ZArchive holds";
  if (!records.size || records.size % RECORD) return "its offset records are not whole";
  if (!tree.size || tree.size % ENTRY) return "its file tree is not whole";
  return { b, data, records, names, tree, entries: tree.size / ENTRY, capacity: (records.size / RECORD) * PER_RECORD * BLOCK };
}

function nodeAt(z: Zar, e: Uint8Array, at: number, index: number): ZarNode | string {
  const w0 = be32(e, at), a = be32(e, at + 4), b = be32(e, at + 8), c = be32(e, at + 12);
  const file = (w0 & 0x80000000) !== 0, nameOffset = w0 & 0x7fffffff;
  if (file) {
    const offset = a + (c & 0xffff) * 2 ** 32, size = b + (c >>> 16) * 2 ** 32;
    if (offset > z.capacity || size > z.capacity - offset) return "a file's bytes lie outside the archive's blocks";
    return { index, file, nameOffset, offset, size, start: 0, count: 0 };
  }
  if (a > z.entries || b > z.entries - a) return "a folder's entries lie outside the file tree";
  return { index, file, nameOffset, offset: 0, size: 0, start: a, count: b };
}

/** the root entry: a folder with no name */
export async function zarRoot(z: Zar): Promise<ZarNode | string> {
  const e = await z.b.at(z.tree.offset, ENTRY);
  if (e.length < ENTRY) return "its file tree could not be read";
  const root = nodeAt(z, e, 0, 0);
  if (typeof root === "string") return root;
  if (root.file) return "its first tree entry is a file, and it must be the root folder";
  if (root.nameOffset !== 0x7fffffff) return "its root folder has a name, and a ZArchive's root has none";
  return root;
}

const latin = new TextDecoder("windows-1252");
/** a name at `rel` in a window of the names table: the name, null when it is malformed, undefined when the window cuts it */
function nameIn(win: Uint8Array, rel: number, cutByWindow: boolean): string | null | undefined {
  if (rel < 0 || rel >= win.length) return undefined;
  let len = win[rel] & 0x7f, start = rel + 1;
  if (win[rel] & 0x80) {
    if (rel + 1 >= win.length) return cutByWindow ? undefined : null;
    len |= win[rel + 1] << 7;
    start = rel + 2;
  }
  if (start + len > win.length) return cutByWindow ? undefined : null;
  const name = latin.decode(win.subarray(start, start + len));
  if (!name || name === "." || name === ".." || /[\/\\\0]/.test(name)) return null;
  return name;
}

/** the names of `nodes`, read in as few windows of the names table as their offsets allow */
async function namesOf(z: Zar, nodes: ZarNode[]): Promise<void> {
  const want = nodes.filter(n => n.nameOffset < z.names.size).sort((a, b) => a.nameOffset - b.nameOffset);
  let from = -1, win: Uint8Array = new Uint8Array(0);
  for (const n of want) {
    const cut = (f: number, w: Uint8Array) => f + w.length < z.names.size;
    let got = from >= 0 ? nameIn(win, n.nameOffset - from, cut(from, win)) : undefined;
    if (got === undefined) {
      from = n.nameOffset;
      win = await z.b.at(z.names.offset + from, Math.min(MAX_READ, z.names.size - from));
      got = nameIn(win, 0, cut(from, win));
    }
    if (got) n.name = got;
  }
}

/** a folder's children (at most FOLDER_MAX of them), with their names */
export async function zarChildren(z: Zar, dir: ZarNode): Promise<ZarNode[] | string> {
  if (dir.file) return "it is a file, not a folder";
  const count = Math.min(dir.count, FOLDER_MAX);
  if (!count) return [];
  const e = await z.b.at(z.tree.offset + dir.start * ENTRY, count * ENTRY);
  if (e.length < count * ENTRY) return "its file tree could not be read";
  const out: ZarNode[] = [];
  for (let i = 0; i < count; i++) {
    const n = nodeAt(z, e, i * ENTRY, dir.start + i);
    if (typeof n === "string") return n;
    out.push(n);
  }
  await namesOf(z, out);
  return out;
}

const fold = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());
/** the child of `dir` called `name` (ASCII case ignored, as ZArchive compares names), or null */
export async function zarChild(z: Zar, dir: ZarNode, name: string): Promise<ZarNode | null> {
  const kids = await zarChildren(z, dir);
  if (typeof kids === "string") return null;
  const want = fold(name);
  return kids.find(k => k.name !== undefined && fold(k.name) === want) ?? null;
}

/** the entry at a slash-separated path below the root, or null */
export async function zarFind(z: Zar, path: string): Promise<ZarNode | null> {
  const root = await zarRoot(z);
  if (typeof root === "string") return null;
  let at: ZarNode | null = root;
  for (const part of path.split(/[\\/]+/).filter(Boolean)) {
    if (!at || at.file) return null;
    at = await zarChild(z, at, part);
  }
  return at;
}

/** one block's 64 KiB, stored or unpacked from its zstd frame (records: the offset records read so far) */
async function blockAt(z: Zar, blk: number, records: Map<number, Uint8Array>): Promise<Uint8Array | string> {
  const ri = Math.floor(blk / PER_RECORD), sub = blk % PER_RECORD;
  if (ri >= z.records.size / RECORD) return "a block lies past the archive's offset records";
  let rec = records.get(ri);
  if (!rec) {
    rec = await z.b.at(z.records.offset + ri * RECORD, RECORD);
    if (rec.length < RECORD) return "an offset record could not be read";
    records.set(ri, rec);
  }
  let off = be64(rec, 0);
  if (!Number.isSafeInteger(off) || off > z.data.size) return "an offset record points outside the archive's data";
  for (let i = 0; i < sub; i++) {
    const s = be16(rec, 8 + i * 2) + 1;
    if (s > z.data.size - off) return "an offset record points outside the archive's data";
    off += s;
  }
  const csize = be16(rec, 8 + sub * 2) + 1;
  if (csize > z.data.size - off) return "a block lies outside the archive's data";
  const bytes = await z.b.at(z.data.offset + off, csize);
  if (bytes.length < csize) return z.b.exhausted ? OUT_OF_READS : "a block could not be read";
  if (csize === BLOCK) return bytes;
  try {
    // capped, so a frame that would unpack to more than a block never fills memory
    const out = (zlib as unknown as { zstdDecompressSync(b: Uint8Array, o: { maxOutputLength: number }): Buffer }).zstdDecompressSync(bytes, { maxOutputLength: BLOCK });
    if (out.length !== BLOCK) return "a block does not unpack to 64 KiB";
    return new Uint8Array(out.buffer, out.byteOffset, out.length);
  } catch { return "a block's zstd data is damaged"; }
}

/** a file's bytes (at most `max` of them; a larger file is refused with the reason) */
export async function zarRead(z: Zar, node: ZarNode, max: number): Promise<Uint8Array | string> {
  if (!node.file) return "it is a folder";
  if (node.size > max) return `it is ${node.size} bytes, more than the ${max} a look takes`;
  const out = new Uint8Array(node.size);
  const records = new Map<number, Uint8Array>();
  let pos = node.offset, got = 0;
  while (got < node.size) {
    const block = await blockAt(z, Math.floor(pos / BLOCK), records);
    if (typeof block === "string") return block;
    const within = pos % BLOCK, n = Math.min(BLOCK - within, node.size - got);
    out.set(block.subarray(within, within + n), got);
    got += n;
    pos += n;
  }
  return out;
}

/** what a .zar is: the PS5 identity of its sce_sys/param.json, with eboot.bin at its root */
export async function readZar(b: Bytes): Promise<Read> {
  const z = await openZar(b);
  if (typeof z === "string") return nothingIn(b, z);
  const root = await zarRoot(z);
  if (typeof root === "string") return nothingIn(b, root);
  const top = await zarChildren(z, root);
  if (typeof top === "string") return nothingIn(b, top);
  const named = (n: string, file: boolean) => top.find(k => k.file === file && k.name !== undefined && fold(k.name) === n) ?? null;
  const sys = named("sce_sys", false);
  if (!sys) return nothingIn(b, "it holds no sce_sys folder at its root, so nothing in it says which game it is");
  const param = await zarChild(z, sys, "param.json");
  if (!param || !param.file) return nothingIn(b, "its sce_sys folder holds no param.json");
  const bytes = await zarRead(z, param, PARAM_MAX);
  if (typeof bytes === "string") return nothingIn(b, `its sce_sys/param.json could not be read: ${bytes}`);
  const j = parseParamJson(bytes);
  if (!j) return nothingIn(b, "its sce_sys/param.json is not JSON");
  const eboot = !!named("eboot.bin", true);
  const r = ps5Identity(j, { shape: "zar", eboot });
  return { ...r, markers: ["sce_sys/param.json", ...(eboot ? ["eboot.bin"] : [])] };
}

/** the members of a .zar, folders first level by level (at most `max`), for a listing; the reason when it cannot be read */
export async function listZar(path: string, max = 400): Promise<{ members: { path: string; size: number; dir: boolean }[]; why: string | null }> {
  const members: { path: string; size: number; dir: boolean }[] = [];
  const r = await withBytes(path, async b => {
    const z = await openZar(b);
    if (typeof z === "string") return nothing(z);
    const root = await zarRoot(z);
    if (typeof root === "string") return nothing(root);
    const queue: { node: ZarNode; at: string }[] = [{ node: root, at: "" }];
    while (queue.length && members.length < max) {
      const { node, at } = queue.shift()!;
      const kids = await zarChildren(z, node);
      if (typeof kids === "string") return nothing(kids);
      for (const k of kids) {
        if (members.length >= max) break;
        const p = at ? `${at}/${k.name ?? "?"}` : k.name ?? "?";
        members.push({ path: p, size: k.size, dir: !k.file });
        if (!k.file) queue.push({ node: k, at: p });
      }
    }
    return { identity: null, why: b.exhausted ? "the listing stopped where a quick look ends" : null };
  }, 1024);
  return { members, why: r.why };
}

/** one member of a .zar (at most `max` bytes); throws with the reason */
export async function readZarMember(path: string, member: string, max: number): Promise<Uint8Array> {
  const got: { bytes?: Uint8Array } = {};
  const r = await withBytes(path, async b => {
    const z = await openZar(b);
    if (typeof z === "string") return nothing(z);
    const node = await zarFind(z, member);
    if (!node) return nothing(`it holds no ${member}`);
    const bytes = await zarRead(z, node, max);
    if (typeof bytes === "string") return nothing(`${member}: ${bytes}`);
    got.bytes = bytes;
    return { identity: null, why: null };
  }, Math.ceil(max / BLOCK) * 2 + 256);
  if (!got.bytes) throw new Error(r.why ?? `${member} could not be read`);
  return got.bytes;
}
