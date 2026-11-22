/** Runtime files must survive moving from the build server to a player's install folder. */
import { open, readFile } from "node:fs/promises";
import { fileChunks } from "../fsutil";

/** Shared by the importer and construct agent (plan authoring, recipes, builds and repairs). */
export const PORTABILITY_INSTRUCTION = `PORTABILITY: the server's build folder is temporary; the finished game is installed at an arbitrary path on a different Windows PC. Build-time INPUT/STAGING/WORK, {work}, {out}, {program}, {tools}, {needs}, content-store paths and Wine Z: paths must never become runtime paths in shipped configuration, scripts or compiled executable defaults. Inspect the build tool's generated defaults: a relative argument may be resolved to an absolute path before compilation. Keep absolute paths only for reading inputs during the build; patch/configure the emitted runtime defaults separately. Game data, profiles/saves, settings, mods, logs and shader caches must resolve from the executable/install folder or the player's own supported user-data location. Use {install} only in launcher fields that expand it, never as literal text in a compiled binary or config. Set portable save/settings paths explicitly and preserve them with keep/seed where the plan supports it. Empty directories do not survive packaging: first launch must create its own profile/cache directories or ship a suitable seed file. Verify the packaged output from a different directory, with the build scratch unavailable and no existing profile; test save/profile initialization as well as data loading. A self-test or loader probe alone does not prove first launch works. Record these portability steps in reusable recipes and lessons.`;

/** text in the encodings a Windows program writes (UTF-16 with or without its mark, else UTF-8); null for binary */
export function textOf(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2))); b.swap16(); return b.toString("utf16le"); }
  const head = buf.subarray(0, 4096);
  let nul = 0, oddNul = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) { nul++; if (i % 2 === 1) oddNul++; }
  if (!nul) return buf.toString("utf8");
  if (head.length >= 8 && oddNul >= head.length / 2 * 0.9) return buf.toString("utf16le");
  return null;
}
/** why a text names this server's own paths (a wine drive, the scratch folder), or null */
export function serverPathIn(text: string, work: string, binary = false): string | null {
  if (binary ? binaryWinePath(text) : /\bz:[\\/]/i.test(text)) return "a wine Z: drive path";
  const w = work.replace(/\\/g, "/").replace(/\/+$/, "");
  if (w && (text.includes(w) || text.replace(/\\/g, "/").includes(w))) return "the build's scratch folder";
  return null;
}


/** In a binary, look for a path token. Character conversion tables also contain the
 * three drive-prefix bytes in the middle of unrelated data. */
function binaryWinePath(text: string): boolean {
  for (const match of text.matchAll(/\bz:[\\/][^<>:"|?*\s\\/\uFFFD]/gi)) {
    const i = match.index!;
    if (i === 0 || /[\s"'=$(:[{,]/.test(text[i - 1])) return true;
    if (text[i - 1] === ";" && /(?:^|[=\s;"'])(?:[a-z]:[\\/]|%[\w()]+%)[^;]*;$/i.test(text.slice(0, i))) return true;
  }
  return false;
}

/** A source/debug filename is diagnostic metadata, not a runtime directory. */
const SOURCE_FILE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|rs|go|o|obj|pdb)(?::\d+(?::\d+)?)?$/i;
const BINARY = /\.(?:exe|dll)$/i;
const WINDOW = 64 * 1024, OVERLAP = 8 * 1024;

/** COFF long section names live in the symbol string table. Ignore only bounded, non-overlapping,
 *  discardable DWARF sections; their directory tables describe compilation, not runtime defaults. */
async function debugSections(path: string, size: number): Promise<{ start: number; end: number }[]> {
  const f = await open(path, "r");
  const read = async (at: number, n: number) => {
    if (at < 0 || n < 0 || at + n > size) return null;
    const b = Buffer.alloc(n);
    return (await f.read(b, 0, n, at)).bytesRead === n ? b : null;
  };
  try {
    const dos = await read(0, 64);
    if (!dos || dos.toString("ascii", 0, 2) !== "MZ") return [];
    const pe = dos.readUInt32LE(60), head = await read(pe, 24);
    if (!head || head.readUInt32LE(0) !== 0x4550) return [];
    const n = head.readUInt16LE(6), at = pe + 24 + head.readUInt16LE(20);
    if (!n || n > 96) return [];
    const table = await read(at, n * 40);
    if (!table) return [];
    let stringsAt = 0, stringsLength = 0;
    const sym = head.readUInt32LE(12);
    if (sym) {
      const pos = sym + head.readUInt32LE(16) * 18, h = await read(pos, 4), len = h?.readUInt32LE(0) ?? 0;
      if (len >= 4 && pos + len <= size) { stringsAt = pos; stringsLength = len; }
    }
    const sections: { start: number; end: number; debug: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const h = table.subarray(i * 40, i * 40 + 40);
      let name = h.toString("ascii", 0, 8).replace(/\0.*$/, "");
      if (/^\/\d+$/.test(name) && stringsLength) {
        const off = Number(name.slice(1));
        if (off >= 4 && off < stringsLength) {
          const b = await read(stringsAt + off, Math.min(64, stringsLength - off));
          const end = b?.indexOf(0) ?? -1;
          if (b && end >= 0) name = b.toString("ascii", 0, end);
        }
      }
      const start = h.readUInt32LE(20), end = start + h.readUInt32LE(16);
      sections.push({ start, end, debug: /^\.z?debug(?:_|$)/.test(name) && !!(h.readUInt32LE(36) & 0x02000000) });
    }
    return sections.filter((s, i) => s.debug && s.start >= at + n * 40 && s.end <= size && s.start < s.end
      && !sections.some((other, j) => j !== i && other.start < s.end && other.end > s.start));
  } finally { await f.close(); }
}

/** Scan small text files and executable string literals. Large game-data blobs are never read here.
 *  Executables have no size cutoff; overlap catches UTF-8/UTF-16 literals spanning reads, at either alignment.
 *  This catches embedded path defaults, not every possible computed runtime dependency. */
export async function serverPathInFile(path: string, size: number, work: string, store = ""): Promise<string | null> {
  const why = (s: string, binary = false) => serverPathIn(s, work, binary)
    ?? (store && s.replace(/\\/g, "/").includes(store.replace(/\\/g, "/")) ? "the server's content store" : null);
  if (!BINARY.test(path)) {
    if (size > 1_000_000) return null;
    const text = textOf(await readFile(path));
    return text ? why(text) : null;
  }
  const debug = await debugSections(path, size);
  let tail = Buffer.alloc(0), offset = 0;
  for await (const chunk of fileChunks(path, { size: WINDOW })) {
    const bytes = Buffer.from(chunk);
    for (const s of debug) {
      const from = Math.max(0, s.start - offset), to = Math.min(bytes.length, s.end - offset);
      if (from < to) bytes.fill(0, from, to);
    }
    offset += bytes.length;
    const b = Buffer.concat([tail, bytes]);
    for (const text of [b.toString("utf8"), b.toString("utf16le"), b.subarray(1).toString("utf16le")]) {
      // NUL-terminated printable strings, not arbitrary machine instructions that happen to contain Z:/.
      for (const m of text.matchAll(/[^\x00-\x1f\x7f-\x9f]+/g)) {
        if (m[0].length < 4 || text[m.index! + m[0].length] !== "\0") continue;
        const literal = m[0];
        if (SOURCE_FILE.test(literal)) continue;
        const found = why(literal, true);
        if (found) return found;
      }
    }
    tail = Buffer.from(b.subarray(Math.max(0, b.length - OVERLAP)));
  }
  return null;
}
