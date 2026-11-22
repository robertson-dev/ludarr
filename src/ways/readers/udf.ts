/**
 * ludarr — a UDF disc image (a PS5 Blu-ray as a PC drive reads it: UDF 2.50 with a metadata partition; ECMA-167 and OSTA
 * UDF) walked with small reads: the anchor, the volume descriptors, the metadata file's map, the root folder and the few
 * folders and files that say what the disc is. 2048-byte sectors; every number little-endian.
 *
 *   anchor (AVDP)      sector 256, tag 2: the main volume descriptor sequence at @16 (length) @20 (sector), the reserve
 *                      one at @24 / @28
 *   descriptors        tag 5 partition (number @22, first sector @188, length @192); tag 6 logical volume (block size @212,
 *                      the file set descriptor's long_ad @248, map table length @264, map count @268, maps from @440); tag 8
 *                      ends the sequence. A map of type 1 is a partition itself (its number @4); type 2 "*UDF Metadata
 *                      Partition" (identifier @5, partition number @38, metadata file @40, its mirror @44) holds the file
 *                      entries and folders, addressed through the metadata file's own allocation
 *   file entries       tag 261 (FE) or 266 (EFE): file type @27 (4 a folder, 5 a file, 250 the metadata file), flags @34 (the
 *                      low three bits: short_ad, long_ad, extended, or the data inside the entry), information length @56,
 *                      extended attribute and descriptor lengths @168/@172 (EFE @208/@212), descriptors after them (@176 /
 *                      @216). A short_ad's block is in the entry's own partition, a long_ad names its partition
 *   folder records     tag 257 (FID): characteristics @18 (2 a folder, 4 deleted, 8 the parent), name length @19, the
 *                      entry's long_ad @20, implementation use length @36, the name after it (a d-string: 8 = one byte a
 *                      character, 16 = UTF-16BE), padded to four bytes
 *   tags               every descriptor starts with a 16-byte tag whose byte 4 is the sum of the other fifteen
 *
 * What it is: bd/param.json ("SCECDF" at 0, JSON from 0x800: disc[0].masterDataId, masterVersion, discNumber) names a PS5
 * disc. With no eboot.bin and sce_sys at the root its game is inside app/<id>/app_0.pkg, encrypted for the console: sealed,
 * nothing can open it. An image whose root holds sce_sys is a game folder made into an image, read as that folder.
 */
import { Bytes, jsonObject, jsonText, le16, le32, le64, MAX_READ, nothing, nothingIn, OUT_OF_READS, raw, withBytes, type Read } from "./bytes";
import { parseParamJson, ps5Identity } from "./ps5";
import { parseSfo, sfoIdentity } from "./sfo";
import { consoleOfTitle, CONTENT_ID, regionOfContentId, titleIdOf } from "./titles";
import type { Identity } from "../identity";

export const SECTOR = 2048;
const AVDP_SECTOR = 256;
/** the most records of one folder read */
const FOLDER_MAX = 2048;
/** the most bytes of one folder's records read */
const FOLDER_BYTES = 512 * 1024;

type Part =
  | { kind: "physical"; start: number; length: number }
  | { kind: "metadata"; start: number; length: number; extents: MetaExtent[] }
  | { kind: "none" };
interface Icb { lbn: number; part: number }
/** a run of the metadata partition's blocks: where it lies in the physical partition, or null for blocks allocated but not
 *  recorded (they keep their place in the numbering, and read as nothing) */
interface MetaExtent { lbn: number | null; blocks: number }
/** a name in a folder, and where its file entry is */
export interface UdfEntry { name: string; dir: boolean; icb: Icb }
interface Extent { part: number; lbn: number; bytes: number; type: number }
/** a file entry as read: a folder or a file, its length, and where its bytes are (or the bytes themselves) */
export interface UdfFile { dir: boolean; size: number; extents: Extent[]; embedded: Uint8Array | null }

/** a tag with this identifier whose checksum holds */
function tagOk(b: Uint8Array, id: number): boolean {
  if (b.length < 16 || le16(b, 0) !== id) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) sum = (sum + b[i]) & 0xff;
  return sum === b[4];
}

/** a d-string's text: 8 one byte a character, 16 UTF-16BE; null for anything else or a name a path cannot hold */
function dstring(b: Uint8Array): string | null {
  if (!b.length) return null;
  let s: string;
  if (b[0] === 8) s = String.fromCharCode(...b.subarray(1));
  else if (b[0] === 16) { s = ""; for (let i = 1; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); }
  else return null;
  return s && !/[\/\0]/.test(s) && s !== "." && s !== ".." ? s : null;
}

/** allocation descriptors as extents (short ones in the entry's own partition `part`) */
function extentsOf(ads: Uint8Array, adType: number, part: number): Extent[] {
  const out: Extent[] = [];
  const size = adType === 0 ? 8 : adType === 1 ? 16 : 0;
  if (!size) return out;
  for (let p = 0; p + size <= ads.length; p += size) {
    const len = le32(ads, p);
    const bytes = len & 0x3fffffff, type = len >>> 30;
    if (!bytes) break;
    out.push(adType === 0 ? { part, lbn: le32(ads, p + 4), bytes, type } : { part: le16(ads, p + 8), lbn: le32(ads, p + 4), bytes, type });
  }
  return out;
}

/** a UDF volume opened for reading */
export class Udf {
  private constructor(readonly b: Bytes, private parts: Part[], readonly root: Icb) {}

  /** the anchor, the descriptors and the file set read and checked; the reason when the image holds no UDF volume */
  static async open(b: Bytes): Promise<Udf | string> {
    const anchor = await b.at(AVDP_SECTOR * SECTOR, SECTOR);
    if (anchor.length < SECTOR || !tagOk(anchor, 2) || le32(anchor, 12) !== AVDP_SECTOR) return "it holds no UDF anchor at sector 256";
    let vds: { pds: Map<number, { start: number; length: number }>; lvd: Uint8Array } | null = null;
    for (const at of [16, 24]) {
      vds = await readVds(b, le32(anchor, at + 4), le32(anchor, at));
      if (vds) break;
    }
    if (!vds) return "its volume descriptors could not be read";
    const lvd = vds.lvd;
    if (le32(lvd, 212) !== SECTOR) return `its blocks are ${le32(lvd, 212)} bytes, and a disc image's are 2048`;
    const parts: Part[] = [];
    const mapLen = le32(lvd, 264), maps = le32(lvd, 268);
    for (let i = 0, p = 440; i < maps && i < 8; i++) {
      const type = lvd[p], len = lvd[p + 1];
      if (len < 6 || p + len > 440 + mapLen || p + len > SECTOR) break;
      const physical = (num: number) => vds!.pds.get(num) ?? null;
      if (type === 1) {
        const pd = physical(le16(lvd, p + 4));
        parts.push(pd ? { kind: "physical", ...pd } : { kind: "none" });
      } else if (type === 2 && len >= 64) {
        const ident = raw(lvd.subarray(p + 5, p + 28)).replace(/\0+$/, "");
        const pd = physical(le16(lvd, p + 38));
        if (!pd) parts.push({ kind: "none" });
        else if (ident.startsWith("*UDF Metadata Partition")) {
          let extents: MetaExtent[] | null = null;
          for (const loc of [le32(lvd, p + 40), le32(lvd, p + 44)]) {
            extents = await metadataExtents(b, pd, loc);
            if (extents) break;
          }
          parts.push(extents ? { kind: "metadata", ...pd, extents } : { kind: "none" });
        } else if (ident.startsWith("*UDF Sparable Partition")) parts.push({ kind: "physical", ...pd });
        else parts.push({ kind: "none" });
      } else parts.push({ kind: "none" });
      p += len;
    }
    if (!parts.some(p => p.kind !== "none")) return "it names no partition ludarr can read";
    const probe = new Udf(b, parts, { lbn: 0, part: 0 });
    const fsd = await probe.block(le16(lvd, 256), le32(lvd, 252));
    if (!fsd || !tagOk(fsd, 256)) return "its file set descriptor could not be read";
    return new Udf(b, parts, { lbn: le32(fsd, 404), part: le16(fsd, 408) });
  }

  /** the sector a partition's block is in, or null */
  sectorOf(part: number, lbn: number): number | null {
    const p = this.parts[part];
    if (!p || p.kind === "none") return null;
    if (p.kind === "physical") return lbn < p.length ? p.start + lbn : null;
    let left = lbn;
    for (const e of p.extents) {
      if (left < e.blocks) return e.lbn != null && e.lbn + left < p.length ? p.start + e.lbn + left : null;
      left -= e.blocks;
    }
    return null;
  }

  /** one block of a partition */
  async block(part: number, lbn: number): Promise<Uint8Array | null> {
    const s = this.sectorOf(part, lbn);
    if (s == null) return null;
    const b = await this.b.at(s * SECTOR, SECTOR);
    return b.length === SECTOR ? b : null;
  }

  /** a file entry */
  async entry(icb: Icb): Promise<UdfFile | string> {
    const blk = await this.block(icb.part, icb.lbn);
    if (!blk) return this.b.exhausted ? OUT_OF_READS : "a file entry lies outside its partition";
    const efe = tagOk(blk, 266);
    if (!efe && !tagOk(blk, 261)) return "a file entry is damaged";
    const fileType = blk[27], adType = le16(blk, 34) & 7, size = le64(blk, 56);
    const lEa = le32(blk, efe ? 208 : 168), lAd = le32(blk, efe ? 212 : 172), base = efe ? 216 : 176;
    if (!Number.isSafeInteger(size) || lEa > SECTOR || lAd > SECTOR || base + lEa + lAd > SECTOR) return "a file entry is damaged";
    const ads = blk.subarray(base + lEa, base + lEa + lAd);
    if (adType === 3) return { dir: fileType === 4, size, extents: [], embedded: ads.subarray(0, Math.min(size, ads.length)) };
    return { dir: fileType === 4, size, extents: await this.continued(extentsOf(ads, adType, icb.part), adType), embedded: null };
  }

  /** extents that continue in an allocation extent descriptor (tag 258) followed, a few times at most */
  private async continued(list: Extent[], adType: number): Promise<Extent[]> {
    const out: Extent[] = [];
    let todo = list, hops = 0;
    while (todo.length) {
      const next: Extent[] = [];
      for (const e of todo) {
        if (e.type !== 3) { out.push(e); continue; }
        if (++hops > 8) continue;
        const blk = await this.block(e.part, e.lbn);
        if (!blk || !tagOk(blk, 258)) continue;
        const lAd = Math.min(le32(blk, 20), SECTOR - 24);
        next.push(...extentsOf(blk.subarray(24, 24 + lAd), adType, e.part));
      }
      todo = next;
    }
    return out;
  }

  /** up to `max` bytes of a file (an extent not recorded reads as zeros) */
  async read(f: UdfFile, max: number): Promise<Uint8Array | string> {
    const want = Math.min(f.size, max);
    if (f.embedded) return f.embedded.subarray(0, want);
    const out = new Uint8Array(want);
    let got = 0;
    for (const e of f.extents) {
      if (got >= want) break;
      const n = Math.min(e.bytes, want - got);
      if (e.type === 0) {
        // in runs of blocks the partition maps to consecutive sectors (a metadata partition may map them apart)
        for (let done = 0; done < n;) {
          const at = e.lbn + done / SECTOR, first = this.sectorOf(e.part, at);
          if (first == null) return "a file's bytes lie outside its partition";
          const most = Math.ceil(Math.min(n - done, MAX_READ) / SECTOR);
          let blocks = 1;
          while (blocks < most && this.sectorOf(e.part, at + blocks) === first + blocks) blocks++;
          const take = Math.min(blocks * SECTOR, n - done);
          const bytes = await this.b.at(first * SECTOR, take);
          if (bytes.length < take) return this.b.exhausted ? OUT_OF_READS : "a file's bytes could not be read";
          out.set(bytes, got + done);
          done += take;
        }
      }
      got += n;
    }
    return out.subarray(0, got);
  }

  /** a folder's names (deleted ones and the parent left out) */
  async list(dir: Icb | UdfFile, max = FOLDER_MAX): Promise<UdfEntry[] | string> {
    const f = "lbn" in dir ? await this.entry(dir) : dir;
    if (typeof f === "string") return f;
    if (!f.dir) return "it is a file, not a folder";
    const data = await this.read(f, FOLDER_BYTES);
    if (typeof data === "string") return data;
    const out: UdfEntry[] = [];
    for (let p = 0; p + 38 <= data.length && out.length < max;) {
      if (!tagOk(data.subarray(p, p + 16), 257)) break;
      const ch = data[p + 18], lfi = data[p + 19], liu = le16(data, p + 36);
      if (p + 38 + liu + lfi > data.length) break;
      if (!(ch & 0x0c) && lfi) {
        const name = dstring(data.subarray(p + 38 + liu, p + 38 + liu + lfi));
        if (name) out.push({ name, dir: (ch & 0x02) !== 0, icb: { lbn: le32(data, p + 24), part: le16(data, p + 28) } });
      }
      p += (38 + liu + lfi + 3) & ~3;
    }
    return out;
  }

  /** the entry of `name` in a folder (case ignored), or null */
  async child(dir: Icb | UdfFile, name: string, isDir: boolean): Promise<UdfEntry | null> {
    const kids = await this.list(dir);
    if (typeof kids === "string") return null;
    return kids.find(k => k.dir === isDir && k.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  /** the entry at a slash-separated path below the root, or null */
  async find(path: string): Promise<{ entry: UdfEntry; file: UdfFile } | null> {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    if (!parts.length) return null;
    let at: Icb = this.root, found: UdfEntry | null = null;
    for (const p of parts) {
      const kids = await this.list(at);
      if (typeof kids === "string") return null;
      found = kids.find(k => k.name.toLowerCase() === p.toLowerCase()) ?? null;
      if (!found) return null;
      at = found.icb;
    }
    const file = await this.entry(found!.icb);
    return typeof file === "string" ? null : { entry: found!, file };
  }
}

/** a volume descriptor sequence: its partitions by number and its logical volume descriptor */
async function readVds(b: Bytes, sector: number, length: number): Promise<{ pds: Map<number, { start: number; length: number }>; lvd: Uint8Array } | null> {
  if (!sector || length < SECTOR) return null;
  const pds = new Map<number, { start: number; length: number }>();
  let lvd: Uint8Array | null = null;
  let at = sector, left = Math.min(Math.floor(length / SECTOR), 64), hops = 0;
  while (left > 0) {
    const n = Math.min(left, MAX_READ / SECTOR);
    const run = await b.at(at * SECTOR, n * SECTOR);
    if (run.length < SECTOR) break;
    let ended = false, jumped = false;
    for (let i = 0; i + SECTOR <= run.length; i += SECTOR) {
      const s = run.subarray(i, i + SECTOR);
      if (tagOk(s, 5)) pds.set(le16(s, 22), { start: le32(s, 188), length: le32(s, 192) });
      else if (tagOk(s, 6) && !lvd) lvd = s.slice();
      else if (tagOk(s, 8)) { ended = true; break; }
      else if (tagOk(s, 3) && hops++ < 2) { at = le32(s, 24); left = Math.min(Math.floor(le32(s, 20) / SECTOR), 64); jumped = true; break; }
    }
    if (ended) break;
    if (!jumped) { at += n; left -= n; }
  }
  return lvd && pds.size ? { pds, lvd } : null;
}

/** where the metadata file maps the metadata partition's blocks to, read from its file entry at `loc` in the partition: its
 *  extents in order (one allocated but not recorded keeps its place), an allocation extent descriptor (tag 258) followed a
 *  few hops when the entry's own list continues there */
async function metadataExtents(b: Bytes, pd: { start: number; length: number }, loc: number): Promise<MetaExtent[] | null> {
  if (loc >= pd.length) return null;
  const blk = await b.at((pd.start + loc) * SECTOR, SECTOR);
  if (blk.length < SECTOR) return null;
  const efe = tagOk(blk, 266);
  if (!efe && !tagOk(blk, 261)) return null;
  const adType = le16(blk, 34) & 7;
  const lEa = le32(blk, efe ? 208 : 168), lAd = le32(blk, efe ? 212 : 172), base = efe ? 216 : 176;
  if (base + lEa + lAd > SECTOR || (adType !== 0 && adType !== 1)) return null;
  const out: MetaExtent[] = [];
  let list = extentsOf(blk.subarray(base + lEa, base + lEa + lAd), adType, 0);
  for (let hops = 0; list.length;) {
    const next: Extent[] = [];
    for (const e of list) {
      if (e.type === 3) {
        // the list continues in an allocation extent descriptor, in the same partition as the metadata file
        if (++hops > 8 || e.lbn >= pd.length) return null;
        const aed = await b.at((pd.start + e.lbn) * SECTOR, SECTOR);
        if (aed.length < SECTOR || !tagOk(aed, 258)) return null;
        next.push(...extentsOf(aed.subarray(24, 24 + Math.min(le32(aed, 20), SECTOR - 24)), adType, 0));
        break;
      }
      out.push({ lbn: e.type === 0 ? e.lbn : null, blocks: Math.ceil(e.bytes / SECTOR) });
    }
    list = next;
  }
  return out.some(e => e.lbn != null) ? out : null;
}

const pack = (id: Identity): Identity => Object.fromEntries(Object.entries(id).filter(([, v]) => v !== undefined && v !== "")) as unknown as Identity;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** what a UDF image is: a PS5 disc (bd/param.json; sealed unless its game folder lies open at the root), or a PS5 / PS4
 *  game folder made into an image */
export async function readUdf(b: Bytes): Promise<Read> {
  const v = await Udf.open(b);
  if (typeof v === "string") return nothingIn(b, v);
  const top = await v.list(v.root, 512);
  if (typeof top === "string") return nothingIn(b, `its root folder could not be read: ${top}`);
  const get = (name: string, dir: boolean) => top.find(e => e.dir === dir && e.name.toLowerCase() === name) ?? null;
  const bd = get("bd", true), sys = get("sce_sys", true), eboot = get("eboot.bin", false);
  if (bd) {
    const pj = await v.child(bd.icb, "param.json", false);
    if (pj) {
      const f = await v.entry(pj.icb);
      const bytes = typeof f === "string" ? f : await v.read(f, 0x800 + MAX_READ - SECTOR);
      if (typeof bytes === "string") return nothingIn(b, `its bd/param.json could not be read: ${bytes}`);
      if (raw(bytes.subarray(0, 6)) !== "SCECDF" || bytes.length <= 0x800) return nothingIn(b, "its bd/param.json does not start as a PS5 disc's does (SCECDF)");
      const j = jsonObject(jsonText(bytes.subarray(0x800)));
      const disc = j && Array.isArray(j.disc) && j.disc[0] && typeof j.disc[0] === "object" ? (j.disc[0] as Record<string, unknown>) : null;
      const serial = titleIdOf(disc?.masterDataId);
      if (!j || !serial) return nothingIn(b, "its bd/param.json names no title id (disc[0].masterDataId)");
      if (consoleOfTitle(serial) !== "ps5") return nothingIn(b, `its bd/param.json names ${serial}, which is not a PlayStation 5 title id`);
      const markers = ["bd/param.json"];
      let contentId: string | undefined;
      const app = get("app", true);
      const own = app ? await v.child(app.icb, serial, true) : null;
      const pkg = own ? await v.child(own.icb, "app_0.pkg", false) : null;
      if (pkg) {
        markers.push(`app/${own!.name}/${pkg.name}`);
        const pf = await v.entry(pkg.icb);
        const head = typeof pf === "string" ? null : await v.read(pf, 4096);
        // the package's header names its content id in the clear (the same pattern Kyty checks, libAppContent.cpp:198)
        const m = head && typeof head !== "string" ? /[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}/.exec(String.fromCharCode(...head)) : null;
        if (m && CONTENT_ID.exec(m[0])?.[2] === serial) contentId = m[0];
      }
      const masterVersion = str(j.masterVersion);
      const open = !!(sys && eboot);
      return {
        identity: pack({
          platform: "ps5", serial, masterVersion, version: masterVersion, contentId, region: regionOfContentId(contentId), category: "game",
          disc: typeof j.discNumber === "number" && Number.isInteger(j.discNumber) && j.discNumber >= 0 ? j.discNumber + 1 : undefined,
          shape: "bd-image", sealed: !open,
        }),
        why: null, markers,
      };
    }
  }
  if (sys) {
    const pj = await v.child(sys.icb, "param.json", false);
    if (pj) {
      const f = await v.entry(pj.icb);
      const bytes = typeof f === "string" ? f : await v.read(f, 1024 * 1024);
      if (typeof bytes === "string") return nothingIn(b, `its sce_sys/param.json could not be read: ${bytes}`);
      const j = parseParamJson(bytes);
      if (!j) return nothingIn(b, "its sce_sys/param.json is not JSON");
      return { ...ps5Identity(j, { shape: "iso", eboot: !!eboot }), markers: ["sce_sys/param.json", ...(eboot ? ["eboot.bin"] : [])] };
    }
    const ps = await v.child(sys.icb, "param.sfo", false);
    if (ps) {
      const f = await v.entry(ps.icb);
      const bytes = typeof f === "string" ? f : await v.read(f, MAX_READ);
      const sfo = typeof bytes === "string" ? null : parseSfo(bytes);
      if (!sfo) return nothingIn(b, "its sce_sys/param.sfo could not be read");
      return { ...sfoIdentity(sfo, "sce_sys", "iso"), markers: ["sce_sys/param.sfo"] };
    }
  }
  return nothingIn(b, "it is a UDF disc image with no bd/param.json and no sce_sys folder at its root, so nothing in it says which game it is");
}

/** the members of a UDF image, level by level (at most `max`, at most `depth` folders deep), with their sizes */
export async function listUdf(path: string, max = 400, depth = 3): Promise<{ members: { path: string; size: number; dir: boolean }[]; why: string | null }> {
  const members: { path: string; size: number; dir: boolean }[] = [];
  const r = await withBytes(path, async b => {
    const v = await Udf.open(b);
    if (typeof v === "string") return nothing(v);
    const queue: { icb: Icb; at: string; level: number }[] = [{ icb: v.root, at: "", level: 1 }];
    while (queue.length && members.length < max) {
      const { icb, at, level } = queue.shift()!;
      const kids = await v.list(icb);
      if (typeof kids === "string") return nothing(kids);
      for (const k of kids) {
        if (members.length >= max) break;
        const p = at ? `${at}/${k.name}` : k.name;
        const f = k.dir ? null : await v.entry(k.icb);
        members.push({ path: p, size: f && typeof f !== "string" ? f.size : 0, dir: k.dir });
        if (k.dir && level < depth) queue.push({ icb: k.icb, at: p, level: level + 1 });
      }
    }
    return { identity: null, why: b.exhausted ? "the listing stopped where a quick look ends" : null };
  }, 1024);
  return { members, why: r.why };
}

/** one member of a UDF image (at most `max` bytes); throws with the reason */
export async function readUdfMember(path: string, member: string, max: number): Promise<Uint8Array> {
  const got: { bytes?: Uint8Array } = {};
  const r = await withBytes(path, async b => {
    const v = await Udf.open(b);
    if (typeof v === "string") return nothing(v);
    const hit = await v.find(member);
    if (!hit) return nothing(`it holds no ${member}`);
    if (hit.file.dir) return nothing(`${member} is a folder`);
    if (hit.file.size > max) return nothing(`${member} is ${hit.file.size} bytes, more than the ${max} a look takes`);
    const bytes = await v.read(hit.file, max);
    if (typeof bytes === "string") return nothing(`${member}: ${bytes}`);
    got.bytes = bytes;
    return { identity: null, why: null };
  }, Math.ceil(max / MAX_READ) + 512);
  if (!got.bytes) throw new Error(r.why ?? `${member} could not be read`);
  return got.bytes;
}
