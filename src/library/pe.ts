/**
 * ludarr — what a Windows program's own header says about it, read without running it (src/library/launch.ts asks it for
 * the admin's picker and for the checks of a start set by hand):
 *
 *   kind     "program" — an MZ/PE executable image without the DLL flag; "dll" — a library (the flag is set); "other" —
 *            not a Windows program at all (a renamed archive, a text file, a truncated header)
 *   ui       the subsystem: "window" (a Windows GUI program), "console" (a console program), null for anything else
 *   version  the strings of its version resource as the program carries them (FileDescription, ProductName, …), first string
 *            table with a FileDescription; {} when it has none
 *
 * Every read is bounded: a few headers, the resource directory's three levels, and at most 64 KB of version data. Nothing
 * here trusts an offset: one that points outside the file (or the resource section) ends the read with what is known.
 */
import { open, type FileHandle } from "node:fs/promises";

export interface PeInfo { kind: "program" | "dll" | "other"; ui: "window" | "console" | null; version: Record<string, string> }

const OTHER: PeInfo = { kind: "other", ui: null, version: {} };
/** the version strings kept (what a picker can quote), each cut to 200 characters */
const KEYS = ["FileDescription", "ProductName", "CompanyName", "FileVersion", "ProductVersion", "OriginalFilename", "InternalName", "Comments"];
const RT_VERSION = 16;
const MAX_VERSION = 64 * 1024;

type Read = (pos: number, len: number) => Promise<Buffer | null>;

export async function peInfo(path: string): Promise<PeInfo> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(path, "r");
    const size = (await fh.stat()).size;
    const h = fh;
    const read: Read = async (pos, len) => {
      if (!Number.isInteger(pos) || pos < 0 || len <= 0 || pos >= size) return null;
      const n = Math.min(len, size - pos);
      const b = Buffer.alloc(n);
      const { bytesRead } = await h.read(b, 0, n, pos);
      return bytesRead ? b.subarray(0, bytesRead) : null;
    };
    return await parse(read);
  } catch { return OTHER; } finally { await fh?.close().catch(() => {}); }
}

async function parse(read: Read): Promise<PeInfo> {
  const dos = await read(0, 64);
  if (!dos || dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return OTHER;                      // "MZ"
  const lfanew = dos.readUInt32LE(0x3c);
  const nt = await read(lfanew, 24 + 240);
  if (!nt || nt.length < 26 || nt.readUInt32LE(0) !== 0x00004550) return OTHER;                       // "PE\0\0"
  const sections = nt.readUInt16LE(6), optSize = nt.readUInt16LE(20), chars = nt.readUInt16LE(22);
  if (!(chars & 0x0002)) return OTHER;                                                                 // not an executable image
  const opt = 24;
  if (nt.length < opt + 2) return OTHER;
  const magic = nt.readUInt16LE(opt);
  const plus = magic === 0x20b;
  if (magic !== 0x10b && !plus) return OTHER;
  const subsystem = nt.length >= opt + 70 ? nt.readUInt16LE(opt + 68) : 0;
  const ui = subsystem === 2 ? "window" : subsystem === 3 ? "console" : null;
  const kind = chars & 0x2000 ? "dll" : "program";
  let version: Record<string, string> = {};
  const countAt = opt + (plus ? 108 : 92), dirsAt = opt + (plus ? 112 : 96);
  const dirs = nt.length >= countAt + 4 ? nt.readUInt32LE(countAt) : 0;
  if (dirs > 2 && nt.length >= dirsAt + 24) {
    const rva = nt.readUInt32LE(dirsAt + 16), len = nt.readUInt32LE(dirsAt + 20);
    if (rva && len) {
      const table = await read(lfanew + 24 + optSize, Math.min(sections, 96) * 40);
      const secs: { va: number; vsize: number; raw: number; rawSize: number }[] = [];
      for (let i = 0; table && (i + 1) * 40 <= table.length; i++) {
        const at = i * 40;
        secs.push({ vsize: table.readUInt32LE(at + 8), va: table.readUInt32LE(at + 12), rawSize: table.readUInt32LE(at + 16), raw: table.readUInt32LE(at + 20) });
      }
      const toOffset = (r: number): number | null => {
        for (const s of secs) {
          const span = Math.max(s.vsize, s.rawSize);
          if (r >= s.va && r < s.va + span) { const into = r - s.va; return into < s.rawSize ? s.raw + into : null; }
        }
        return null;
      };
      version = await versionStrings(read, toOffset, rva).catch(() => ({}));
    }
  }
  return { kind, ui, version };
}

interface Entry { id: number | null; sub: boolean; at: number }
/** one level of the resource directory: its entries (named ones have no id) */
async function dirEntries(read: Read, base: number, at: number): Promise<Entry[]> {
  const head = await read(base + at, 16);
  if (!head || head.length < 16) return [];
  const n = Math.min(head.readUInt16LE(12) + head.readUInt16LE(14), 256);
  const body = n ? await read(base + at + 16, n * 8) : null;
  const out: Entry[] = [];
  for (let i = 0; body && (i + 1) * 8 <= body.length; i++) {
    const name = body.readUInt32LE(i * 8), off = body.readUInt32LE(i * 8 + 4);
    out.push({ id: name & 0x80000000 ? null : name & 0xffff, sub: (off & 0x80000000) !== 0, at: off & 0x7fffffff });
  }
  return out;
}

async function versionStrings(read: Read, toOffset: (rva: number) => number | null, rsrc: number): Promise<Record<string, string>> {
  const base = toOffset(rsrc);
  if (base == null) return {};
  const type = (await dirEntries(read, base, 0)).find(e => e.id === RT_VERSION && e.sub);
  if (!type) return {};
  const name = (await dirEntries(read, base, type.at)).find(e => e.sub);
  if (!name) return {};
  const langs = (await dirEntries(read, base, name.at)).filter(e => !e.sub);
  const lang = langs.find(e => e.id === 0x409) ?? langs.find(e => e.id === 0) ?? langs[0];
  if (!lang) return {};
  const data = await read(base + lang.at, 16);
  if (!data || data.length < 8) return {};
  const at = toOffset(data.readUInt32LE(0));
  if (at == null) return {};
  const buf = await read(at, Math.min(data.readUInt32LE(4), MAX_VERSION));
  return buf ? versionInfo(buf) : {};
}

const align4 = (n: number) => (n + 3) & ~3;
interface Block { key: string; valueAt: number; valueLength: number; type: number; end: number }
/** one VS_VERSIONINFO-style block at `at` (wLength, wValueLength, wType, the key in UTF-16, then the value, then children) */
function block(buf: Buffer, at: number, limit: number): Block | null {
  if (at + 6 > limit) return null;
  const length = buf.readUInt16LE(at);
  if (length < 6) return null;
  const end = Math.min(at + length, limit);
  let k = at + 6, key = "";
  while (k + 1 < end) { const c = buf.readUInt16LE(k); k += 2; if (!c) break; key += String.fromCharCode(c); }
  return { key, valueAt: align4(k), valueLength: buf.readUInt16LE(at + 2), type: buf.readUInt16LE(at + 4), end };
}
function children(buf: Buffer, from: number, end: number): Block[] {
  const out: Block[] = [];
  for (let at = align4(from); at < end && out.length < 512;) {
    const b = block(buf, at, end);
    if (!b) break;
    out.push(b);
    const next = align4(b.end);
    if (next <= at) break;
    at = next;
  }
  return out;
}
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
/** the strings of a VS_VERSIONINFO resource: the first string table that names a FileDescription, else the first one */
export function versionInfo(buf: Buffer): Record<string, string> {
  const root = block(buf, 0, buf.length);
  if (!root || root.key !== "VS_VERSION_INFO") return {};
  const tables: Record<string, string>[] = [];
  for (const c of children(buf, root.valueAt + root.valueLength, root.end)) {
    if (c.key !== "StringFileInfo") continue;
    for (const t of children(buf, c.valueAt, c.end)) {
      const out: Record<string, string> = {};
      for (const s of children(buf, t.valueAt, t.end)) {
        if (!KEYS.includes(s.key)) continue;
        // wValueLength counts characters for text (some linkers write bytes): read to the NUL or the block's end
        let v = "";
        for (let i = s.valueAt; i + 1 < s.end; i += 2) { const ch = buf.readUInt16LE(i); if (!ch) break; v += String.fromCharCode(ch); }
        const text = clean(v);
        if (text) out[s.key] = text;
      }
      tables.push(out);
    }
  }
  return tables.find(t => t.FileDescription) ?? tables[0] ?? {};
}
