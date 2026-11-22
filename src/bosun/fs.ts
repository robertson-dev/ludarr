/**
 * bosun — file access, fenced to the download roots. Every path is realpath'd first, so symlinks
 * cannot lead out, and the Range handling is what lets Ahoy resume and segment pulls.
 */
import { readdir, stat, realpath } from "node:fs/promises";
import { join, isAbsolute, sep } from "node:path";

export class FsError extends Error {
  constructor(public status: 400 | 403 | 404, msg: string) { super(msg); }
}

export class Roots {
  private constructor(private real: string[]) {}

  static async of(paths: string[]): Promise<Roots> {
    const real: string[] = [];
    for (const p of paths) {
      const rp = await realpath(p).catch(() => null);
      if (rp && !real.includes(rp)) real.push(rp);
    }
    return new Roots(real);
  }

  list() { return [...this.real]; }

  /** absolute, existing path inside one of the roots → its real path */
  async resolve(p: string): Promise<string> {
    if (!p || !isAbsolute(p)) throw new FsError(400, "absolute path required");
    const rp = await realpath(p).catch(() => null);
    if (!rp) throw new FsError(404, "no such path");
    if (!this.real.some(r => rp === r || rp.startsWith(r + sep))) throw new FsError(403, "outside the download roots");
    return rp;
  }
}

export interface Entry { name: string; size: number; isDir: boolean; mtime: number }

export async function statPath(rp: string) {
  const st = await stat(rp);
  return { path: rp, size: st.isDirectory() ? 0 : st.size, isDir: st.isDirectory(), mtime: Math.floor(st.mtimeMs / 1000) };
}

export async function listDir(rp: string): Promise<Entry[]> {
  const st = await stat(rp);
  if (!st.isDirectory()) throw new FsError(400, "not a directory");
  const out: Entry[] = [];
  for (const name of await readdir(rp)) {
    const s = await stat(join(rp, name)).catch(() => null);
    if (!s) continue;                                  // dangling symlink etc.
    out.push({ name, size: s.isDirectory() ? 0 : s.size, isDir: s.isDirectory(), mtime: Math.floor(s.mtimeMs / 1000) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** GET/HEAD a file with RFC 7233 single-range support. */
export async function fileResponse(req: Request, rp: string): Promise<Response> {
  const st = await stat(rp);
  if (st.isDirectory()) throw new FsError(400, "is a directory");
  const size = st.size;
  const head = req.method === "HEAD";
  const base: Record<string, string> = {
    "accept-ranges": "bytes", "content-type": "application/octet-stream",
    "last-modified": st.mtime.toUTCString(), "cache-control": "no-store",
  };
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const unsatisfiable = () => new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
    if (!m || (!m[1] && !m[2])) return unsatisfiable();
    let start: number, end: number;
    if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }       // suffix: last N bytes
    else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    if (start > end || start >= size) return unsatisfiable();
    return new Response(head ? null : Bun.file(rp).slice(start, end + 1), {
      status: 206, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(head ? null : Bun.file(rp), { status: 200, headers: { ...base, "content-length": String(size) } });
}
