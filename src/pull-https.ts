/**
 * ludarr — the http(s) pull engine over a plain web file listing (nginx / Apache autoindex with basic auth),
 * for download clients reached directly: the seedbox's https listing of its downloads folder is several
 * times faster than SFTP, supports Range, and needs no SSH. Paths given to the source are the client's
 * own (seedbox) paths; `pathStrip` is the prefix the listing root corresponds to.
 */
import { posix } from "node:path";
import type { HttpSource, RemoteEntry } from "./pull-http";

/** nginx/Apache autoindex rows: <a href="name/">name/</a>  date  size (bytes, or "-" for folders; human units when exact size is off) */
export function autoindexEntries(html: string): RemoteEntry[] {
  const out: RemoteEntry[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\s+href="([^"?#]+)"[^>]*>[^<]*<\/a>\s*([^<\r\n]*)/gi)) {
    let href = m[1];
    try { href = decodeURIComponent(href); } catch { /* keep raw */ }
    // a link elsewhere (an absolute URL, a path from the root) is no entry; "http/" and "httplib.dll" are
    if (href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    // Apache writes "./" in front of a name with a colon in it ("./Game:%20Sub.iso"), so it is not read as a scheme: the
    // same entry of this folder — one "./" is taken off, and what is left is held to the rule below
    if (href.startsWith("./")) href = href.slice(2);
    const isDir = href.endsWith("/");
    const name = isDir ? href.slice(0, -1) : href;
    // an entry is one name in this folder: nothing with a separator in it, never the folder itself or its parent
    if (!name || name === "." || name === ".." || /[\/\\]/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const tail = m[2].trim().split(/\s+/).pop() ?? "";
    const size = isDir ? 0 : /^\d+$/.test(tail) ? Number(tail) : parseHuman(tail);
    out.push({ name, size, isDir });
  }
  return out;
}
/** "1.2G" → bytes (approximate; the file is re-measured with HEAD when the listing is not exact) */
function parseHuman(s: string): number {
  const m = /^([\d.]+)([KMGT])?$/i.exec(s);
  if (!m) return -1;
  const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[(m[2] ?? "").toUpperCase() as "K"] ?? 1;
  return m[2] ? -Math.round(Number(m[1]) * mult) : Number(m[1]);    // negative = approximate, must be confirmed
}

export function httpsSource(base: URL, pathStrip = "", fetchImpl: typeof fetch = fetch): HttpSource & { urlFor(path: string): string } {
  const strip = pathStrip.replace(/\/+$/, "");
  const root = base.origin + base.pathname.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (base.username) headers.authorization = "Basic " + Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString("base64");
  const rel = (p: string) => {
    let s = p.replace(/\\/g, "/");
    if (strip && (s === strip || s.startsWith(strip + "/"))) s = s.slice(strip.length);
    return s.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  };
  const urlFor = (p: string) => `${root}/${rel(p)}`;
  const head = async (url: string) => fetchImpl(url, { method: "HEAD", headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return {
    urlFor,
    async stat(p) {
      const r = await head(urlFor(p));
      if (r.status >= 300 && r.status < 400) return { size: 0, isDir: true };           // nginx: folder without the trailing slash → redirect
      if (r.ok && !/text\/html/i.test(r.headers.get("content-type") ?? "")) return { size: Number(r.headers.get("content-length") ?? 0), isDir: false };
      if (r.ok) return { size: 0, isDir: true };
      throw new Error(`HTTP ${r.status} for ${p}`);
    },
    async list(p) {
      const r = await fetchImpl(urlFor(p) + "/", { headers, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} listing ${p}`);
      const entries = autoindexEntries(await r.text());
      for (const e of entries) {
        if (e.isDir || e.size >= 0) continue;
        const h = await head(urlFor(posix.join(p, e.name)));                          // the listing was not exact: ask the file
        e.size = Number(h.headers.get("content-length") ?? 0);
      }
      return entries;
    },
    async request(p) { return { url: urlFor(p), headers }; },
  };
}
