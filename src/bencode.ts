/**
 * ludarr — just enough bencode to pull the info-hash + layout out of a .torrent,
 * and a magnet parser (hex or base32 btih). Both feed the rTorrent tracking key.
 */
export interface TorrentMeta { infoHash: string; name: string; length: number; multiFile: boolean; files: number }

type BVal = number | Uint8Array | BVal[] | Map<string, BVal>;

const latin1 = (u: Uint8Array) => Buffer.from(u).toString("latin1");
const utf8 = (u: Uint8Array) => Buffer.from(u).toString("utf8");

class Reader {
  pos = 0;
  infoStart = -1;
  infoEnd = -1;
  constructor(private b: Uint8Array) {}
  private byte() { return this.b[this.pos]; }

  read(depth = 0): BVal {
    const c = this.byte();
    if (c === 0x69) {                                   // i<int>e
      const e = this.b.indexOf(0x65, this.pos);
      if (e < 0) throw new Error("BENCODE_TRUNCATED");
      const n = Number(latin1(this.b.subarray(this.pos + 1, e)));
      this.pos = e + 1;
      return n;
    }
    if (c === 0x6c) {                                   // l…e
      this.pos++;
      const out: BVal[] = [];
      while (this.byte() !== 0x65) out.push(this.read(depth + 1));
      this.pos++;
      return out;
    }
    if (c === 0x64) {                                   // d…e
      this.pos++;
      const out = new Map<string, BVal>();
      while (this.byte() !== 0x65) {
        const k = latin1(this.read(depth + 1) as Uint8Array);
        const start = this.pos;
        const v = this.read(depth + 1);
        if (depth === 0 && k === "info") { this.infoStart = start; this.infoEnd = this.pos; }
        out.set(k, v);
      }
      this.pos++;
      return out;
    }
    if (c >= 0x30 && c <= 0x39) {                       // <len>:<bytes>
      const colon = this.b.indexOf(0x3a, this.pos);
      if (colon < 0) throw new Error("BENCODE_TRUNCATED");
      const len = Number(latin1(this.b.subarray(this.pos, colon)));
      const s = this.b.subarray(colon + 1, colon + 1 + len);
      this.pos = colon + 1 + len;
      return s;
    }
    throw new Error(`BENCODE_BAD_BYTE 0x${(c ?? 0).toString(16)} @${this.pos}`);
  }
}

export function parseTorrent(bytes: Uint8Array): TorrentMeta {
  const r = new Reader(bytes);
  const top = r.read();
  if (!(top instanceof Map) || r.infoStart < 0) throw new Error("BENCODE_NO_INFO_DICT");
  const info = top.get("info") as Map<string, BVal>;
  const infoHash = new Bun.CryptoHasher("sha1").update(bytes.subarray(r.infoStart, r.infoEnd)).digest("hex").toUpperCase();
  const files = info.get("files") as BVal[] | undefined;
  let length = Number(info.get("length") ?? 0);
  if (files) length = files.reduce<number>((n, f) => n + Number((f as Map<string, BVal>).get("length") ?? 0), 0);
  const nameRaw = (info.get("name.utf-8") ?? info.get("name")) as Uint8Array | undefined;
  return { infoHash, name: nameRaw ? utf8(nameRaw) : "", length, multiFile: !!files, files: files ? files.length : 1 };
}

/** the files a .torrent lists as they land on disk — `<name>/<path>` for each file of a multi-file torrent, `<name>` for a
 *  single file, with their sizes (BEP 47 padding files, which no client writes, left out) — or null when the bytes are not a
 *  torrent or it lists more than `max` files (src/arrivals.ts waits for these when rTorrent cannot say) */
export function torrentFileList(bytes: Uint8Array, max = 20_000): { p: string; s: number }[] | null {
  try {
    const top = new Reader(bytes).read();
    const info = top instanceof Map ? top.get("info") : null;
    if (!(info instanceof Map)) return null;
    const raw = info.get("name.utf-8") ?? info.get("name");
    const name = raw instanceof Uint8Array ? utf8(raw) : "";
    if (!name) return null;
    const files = info.get("files");
    if (!Array.isArray(files)) return [{ p: name, s: Number(info.get("length") ?? 0) }];
    if (files.length > max) return null;
    const out: { p: string; s: number }[] = [];
    for (const f of files) {
      if (!(f instanceof Map)) continue;
      const attr = f.get("attr");
      if (attr instanceof Uint8Array && utf8(attr).includes("p")) continue;
      const parts = f.get("path.utf-8") ?? f.get("path");
      if (!Array.isArray(parts)) continue;
      const segs = parts.map(x => (x instanceof Uint8Array ? utf8(x) : "")).filter(Boolean);
      if (segs.length) out.push({ p: [name, ...segs].join("/"), s: Number(f.get("length") ?? 0) });
    }
    return out;
  } catch { return null; }
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32ToHex(s: string): string {
  let bits = 0, acc = 0, out = "";
  for (const ch of s.toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("BAD_BASE32");
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out += ((acc >> bits) & 0xff).toString(16).padStart(2, "0");
      acc &= (1 << bits) - 1;
    }
  }
  return out.toUpperCase();
}

export function parseMagnet(uri: string): { infoHash: string; name: string | null } | null {
  if (!/^magnet:\?/i.test(uri)) return null;
  const p = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
  const xt = p.getAll("xt").find(x => /^urn:btih:/i.test(x));
  if (!xt) return null;
  const raw = xt.slice("urn:btih:".length);
  const infoHash = /^[0-9a-f]{40}$/i.test(raw) ? raw.toUpperCase() : raw.length === 32 ? base32ToHex(raw) : null;
  return infoHash ? { infoHash, name: p.get("dn") } : null;
}
