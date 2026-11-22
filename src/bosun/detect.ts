/**
 * bosun — work out the seedbox layout without being told.
 *
 *   rtorrent  ~/.rtorrent.rc              → scgi socket, default download dir
 *   nzbget    nzbget.conf (usual places)  → control user/password/port; the URL by probing seedhost-style paths
 *   web       ~/www/<vhost>/…/<symlink>   → the https URL that serves the downloads folder (fast data plane)
 */
import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RcInfo { scgi: string | null; defaultDir: string | null; session: string | null }
export interface NzbConf { user: string; pass: string; port: number | null; destDir: string | null; interDir: string | null; mainDir: string | null }

export const expandHome = (p: string, home = homedir()) => p.replace(/^~(?=\/|$)/, home);

export function parseRtorrentRc(text: string, home = homedir()): RcInfo {
  const out: RcInfo = { scgi: null, defaultDir: null, session: null };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([\w.]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^"(.*)"$/, "$1");
    switch (key) {
      case "network.scgi.open_port": case "scgi_port": out.scgi = val; break;
      case "network.scgi.open_local": case "scgi_local": out.scgi = expandHome(val, home); break;
      case "directory.default.set": case "directory": out.defaultDir = expandHome(val, home).replace(/\/+$/, ""); break;
      case "session.path.set": case "session": out.session = expandHome(val, home); break;
    }
  }
  return out;
}

export function parseNzbgetConf(text: string): NzbConf {
  const kv = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const sub = (v: string | undefined, depth = 0): string | undefined =>
    v === undefined || depth > 5 ? v : v.replace(/\$\{(\w+)\}/g, (_, k: string) => sub(kv.get(k), depth + 1) ?? "");
  return {
    user: kv.get("ControlUsername") ?? "", pass: kv.get("ControlPassword") ?? "",
    port: Number(kv.get("ControlPort")) || null,
    destDir: sub(kv.get("DestDir")) ?? null, interDir: sub(kv.get("InterDir")) ?? null, mainDir: sub(kv.get("MainDir")) ?? null,
  };
}

export const nzbgetConfCandidates = (home: string) => [
  join(home, ".config/NZBGet/nzbget.conf"), join(home, ".config/nzbget/nzbget.conf"),
  join(home, "nzbget/nzbget.conf"), join(home, ".nzbget"),
];

export async function findNzbgetConf(home = homedir()): Promise<{ path: string; conf: NzbConf } | null> {
  for (const path of nzbgetConfCandidates(home)) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) return { path, conf: parseNzbgetConf(text) };
  }
  return null;
}

/** where NZBGet's RPC might answer, most likely first (seedhost.eu: https://<host>/<user>/nzbget) */
export const nzbgetUrlCandidates = (user: string, host: string, port: number | null) => [
  `https://${host}/${user}/nzbget`,
  `https://${user}.${host}/nzbget`,
  ...(port ? [`http://127.0.0.1:${port}`] : []),
];

/**
 * Find the vhost under ~/www whose tree links to `target` (seedhost: ~/www/<vhost>/<user>/downloads → ~/downloads)
 * and return the https URL that serves it. Symlinked directories are matched but not descended into.
 */
export async function detectWebBase(target: string, home = homedir(), maxDepth = 3): Promise<{ webBase: string; webRoot: string } | null> {
  const real = await realpath(target).catch(() => null);
  if (!real) return null;
  const www = join(home, "www");
  for (const vhost of await readdir(www).catch(() => [] as string[])) {
    if (!/^[\w-]+(\.[\w-]+)+$/.test(vhost)) continue;
    const hit = await find(join(www, vhost), [], maxDepth);
    if (hit) return { webBase: `https://${vhost}/${hit.map(encodeURIComponent).join("/")}`, webRoot: real };
  }
  return null;

  async function find(dir: string, rel: string[], depth: number): Promise<string[] | null> {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const p = join(dir, name);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if ((await realpath(p).catch(() => null)) === real) return [...rel, name];
      if (st.isDirectory() && !st.isSymbolicLink() && depth > 0) {
        const sub = await find(p, [...rel, name], depth - 1);
        if (sub) return sub;
      }
    }
    return null;
  }
}
