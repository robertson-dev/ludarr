/**
 * Small Windows images for the tests (src/library/pe.ts reads them): a PE32+ header with the subsystem and the DLL flag
 * asked for, and a .rsrc section holding one VS_VERSIONINFO with the strings given. Nothing in it runs.
 */

const utf16z = (s: string) => Buffer.from(`${s}\0`, "utf16le");
const pad4 = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

/** one version-info block: wLength, wValueLength (characters for text), wType, the key, the value, the children */
function vsBlock(key: string, value: Buffer | null, valueUnits: number, type: 0 | 1, children: Buffer[] = []): Buffer {
  const head = Buffer.alloc(6);
  const keyed = pad4(Buffer.concat([head, utf16z(key)]));
  const body = Buffer.concat([keyed, value ? pad4(value) : Buffer.alloc(0), ...children]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueUnits, 2);
  body.writeUInt16LE(type, 4);
  return pad4(body);
}
export function versionResource(strings: Record<string, string>): Buffer {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  const entries = Object.entries(strings).map(([k, v]) => vsBlock(k, utf16z(v), v.length + 1, 1));
  const table = vsBlock("040904b0", null, 0, 1, entries);
  const sfi = vsBlock("StringFileInfo", null, 0, 1, [table]);
  return vsBlock("VS_VERSION_INFO", fixed, 52, 0, [sfi]);
}

/** a PE32+ image: a program (window or console) or a library, with version strings when given */
export function peBytes(o: { dll?: boolean; ui?: "window" | "console"; version?: Record<string, string>; pad?: number } = {}): Uint8Array {
  const vi = o.version ? versionResource(o.version) : null;
  // the resource section: root (RT_VERSION) → name 1 → language 0x409 → data entry → VS_VERSIONINFO at 0x58
  const RVA = 0x1000;
  const rsrc = Buffer.alloc(vi ? 0x58 + vi.length : 0);
  if (vi) {
    rsrc.writeUInt16LE(1, 14); rsrc.writeUInt32LE(16, 0x10); rsrc.writeUInt32LE(0x80000000 + 0x18, 0x14);
    rsrc.writeUInt16LE(1, 0x18 + 14); rsrc.writeUInt32LE(1, 0x28); rsrc.writeUInt32LE(0x80000000 + 0x30, 0x2c);
    rsrc.writeUInt16LE(1, 0x30 + 14); rsrc.writeUInt32LE(0x409, 0x40); rsrc.writeUInt32LE(0x48, 0x44);
    rsrc.writeUInt32LE(RVA + 0x58, 0x48); rsrc.writeUInt32LE(vi.length, 0x4c);
    vi.copy(rsrc, 0x58);
  }
  const raw = Math.ceil(rsrc.length / 0x200) * 0x200;
  const head = Buffer.alloc(0x200);
  head.write("MZ", 0, "latin1");
  head.writeUInt32LE(0x40, 0x3c);
  head.write("PE\0\0", 0x40, "latin1");
  const coff = 0x44;
  head.writeUInt16LE(0x8664, coff);
  head.writeUInt16LE(vi ? 1 : 0, coff + 2);
  head.writeUInt16LE(240, coff + 16);
  head.writeUInt16LE(0x0022 | (o.dll ? 0x2000 : 0), coff + 18);
  const opt = coff + 20;
  head.writeUInt16LE(0x20b, opt);
  head.writeUInt16LE(o.ui === "console" ? 3 : 2, opt + 68);
  head.writeUInt32LE(16, opt + 108);
  if (vi) {
    head.writeUInt32LE(RVA, opt + 112 + 16);
    head.writeUInt32LE(rsrc.length, opt + 112 + 20);
    const sec = opt + 240;
    head.write(".rsrc", sec, "latin1");
    head.writeUInt32LE(rsrc.length, sec + 8);
    head.writeUInt32LE(RVA, sec + 12);
    head.writeUInt32LE(raw, sec + 16);
    head.writeUInt32LE(0x200, sec + 20);
  }
  const body = Buffer.alloc(raw);
  rsrc.copy(body, 0);
  return new Uint8Array(Buffer.concat([head, body, Buffer.alloc(o.pad ?? 0)]));
}
