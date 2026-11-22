/**
 * Built-in download clients:
 *   seedbox   one SSH login to a seedbox; ludarr installs its connector (bosun) there, which fronts the
 *             box's rTorrent and NZBGet and serves the finished files (https listing when the box has one)
 *   rtorrent  rTorrent / ruTorrent over XML-RPC, files pulled with lftp or read from a mapped folder
 *   nzbget    NZBGet over JSON-RPC, same transfer options
 * While the finished-downloads folder is on (one global setting, src/synced.ts), none of them pulls a finished download: it is
 * found there by its name and imported in place (src/arrivals.ts) — rTorrent lists a torrent's files for it (files).
 */
import { BosunClient, type BosunSettings } from "../../bosun-client";
import { RtorrentClient } from "../../rtorrent";
import { NzbgetClient } from "../../nzbget";
import { parseMagnet, parseTorrent } from "../../bencode";
import { join } from "node:path";
import { stageMapped } from "../../mapped-pull";
import { startPull, waitForLocal, type PullHandle, type PullJob } from "../../pull";
import { startHttpPull } from "../../pull-http";
import { httpsSource } from "../../pull-https";
import { fromNzbget, fromRtorrent, itemId } from "../../seedbox-items";
import type { DownloadClient, DownloadClientDefinition, Field, PluginContext, Settings } from "../types";

const str = (v: unknown) => (v == null ? "" : String(v));
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && str(v) !== "" ? Number(v) : d);

/* ─────────── seedbox (bosun) ─────────── */

export const seedbox: DownloadClientDefinition = {
  kind: "downloadClient", impl: "seedbox", name: "Seedbox (SSH connector)", protocols: ["torrent", "usenet"],
  description: "One SSH login: ludarr installs a small connector on the box that drives its rTorrent and NZBGet and serves the finished files.",
  fields: [
    { name: "sshHost", label: "SSH host", type: "text", required: true, placeholder: "box.seedhost.eu" },
    { name: "sshPort", label: "SSH port", type: "number", default: 22 },
    { name: "sshUser", label: "SSH user", type: "text", required: true },
    { name: "sshPass", label: "SSH password", type: "password", helpText: "or a private key below" },
    { name: "sshKey", label: "SSH private key", type: "textarea", advanced: true, helpText: "PEM text, or a path to the key file" },
    { name: "webUser", label: "Web login user", type: "text", helpText: "the box's web (ruTorrent) login: lets transfers use its https file listing, several times faster than the SSH tunnel; defaults to the SSH user" },
    { name: "webPass", label: "Web login password", type: "password" },
    { name: "rtorrentLabel", label: "Torrent label", type: "text", default: "ludarr", helpText: "stamped on grabs in rTorrent (d.custom1)", advanced: true },
    { name: "rtorrentDir", label: "Torrent directory", type: "text", default: "", helpText: "optional download directory on the box for grabs", advanced: true },
    { name: "nzbgetCategory", label: "NZBGet category", type: "text", default: "ludarr", advanced: true },
    { name: "nzbgetUrl", label: "NZBGet URL", type: "text", default: "", helpText: "only when the connector cannot find NZBGet on the box by itself", advanced: true },
    { name: "nzbgetUser", label: "NZBGet user", type: "text", default: "", advanced: true },
    { name: "nzbgetPass", label: "NZBGet password", type: "password", advanced: true },
    { name: "port", label: "Connector port", type: "number", default: 17867, helpText: "localhost port on the box; the next free one is taken if busy", advanced: true },
    { name: "binary", label: "Connector binary", type: "path", default: "", helpText: "path to a compiled connector; built on demand when empty", advanced: true },
  ],
  create(s: Settings, ctx: PluginContext): DownloadClient {
    const settings: BosunSettings = {
      sshHost: str(s.sshHost), sshPort: num(s.sshPort, 22), sshUser: str(s.sshUser), sshPass: str(s.sshPass) || undefined, sshKey: str(s.sshKey) || undefined,
      webUser: str(s.webUser) || undefined, webPass: str(s.webPass) || undefined, port: num(s.port, 17867), binary: str(s.binary) || undefined,
      rtorrentLabel: str(s.rtorrentLabel) || "ludarr", rtorrentDir: str(s.rtorrentDir) || undefined,
      nzbgetUrl: str(s.nzbgetUrl) || undefined, nzbgetUser: str(s.nzbgetUser) || undefined, nzbgetPass: str(s.nzbgetPass) || undefined, nzbgetCategory: str(s.nzbgetCategory) || "ludarr",
    };
    const bosun = new BosunClient(settings, undefined, ctx.fetch);
    return {
      async test() {
        const r = await bosun.ensureInstalled();
        const st = await bosun.status();
        const part = (name: string, x: { configured: boolean; ok: boolean; version: string | null; detail: string | null }) => `${name} ${x.ok ? (x.version ?? "ok") : x.configured ? `✕ ${x.detail ?? ""}` : "not found"}`;
        return { ok: st.ok, detail: `connector ${r.version}${r.uploaded ? " (uploaded)" : ""} on port ${r.port}: ${part("rTorrent", st.rtorrent)}, ${part("NZBGet", st.nzbget)}; files over ${bosun.dataPlane(st)}` };
      },
      async add(payload) {
        const r = payload.kind === "magnet" ? await bosun.add({ kind: "magnet", uri: payload.uri }) : await bosun.add({ kind: payload.kind, data: payload.bytes, name: payload.filename });
        return { client: r.client, clientId: r.clientId, infoHash: r.infoHash ?? null };
      },
      async items() {
        const r = await bosun.items();
        const unavailable = (Object.entries(r.errors ?? {}) as [("rtorrent" | "nzbget"), string | undefined][]).filter(([, e]) => e).map(([c]) => c);
        for (const c of unavailable) ctx.log.warn(`${c} via the connector: ${r.errors[c]}`);
        return { items: r.items, unavailable };
      },
      remove: ref => bosun.remove(itemId(ref.client, ref.clientId)),
      pull: (_item, job: PullJob): PullHandle => startHttpPull(job, bosun.source(), { downloadsDir: job.staging ? join(job.staging, "fetch-" + job.fetchId) : ctx.paths.downloads, segments: num(ctx.config("PULL_SEGMENTS"), 4) }),
      async ready() {
        const r = await bosun.ensureInstalled();
        ctx.log.info(`connector ${r.version} ready on ${settings.sshHost} (port ${r.port}${r.uploaded ? ", uploaded" : ""}${r.started ? ", started" : ""})`);
      },
    };
  },
};

/* ─────────── direct clients: shared transfer settings ─────────── */

const TRANSFER_FIELDS: Field[] = [
  { name: "pathMap", label: "Remote path mapping", type: "text", default: "", placeholder: "/home/user/downloads=/remote/downloads", helpText: "the client's finished folder as ludarr sees it: mount it into the container (Unraid: /mnt/addons/seedbox → /remote, set up by deploy/seedbox-mount.py) and write <client path>=<ludarr path>; imports then read straight from the mount, like Radarr — no transfer, no login. While Settings → Media Management → Finished downloads land in is set (downloads/finished), imports read that folder instead, and the mount is only the fallback you choose from the Queue: it must then be the seedbox's own folder, never downloads/finished (one there is not used)" },
  { name: "pullUrl", label: "Transfer URL", type: "text", default: "", placeholder: "https://box/downloads  or  sftp://host:22", helpText: "only when the folder cannot be mounted: fetch finished downloads from the client's host over a web file listing (https://) or sftp:// ftps:// ftp://, without the login", advanced: true },
  { name: "pullUser", label: "Transfer user", type: "text", default: "", helpText: "the login for the transfer URL (the folder's basic-auth or the sftp/ftp account)", advanced: true },
  { name: "pullPass", label: "Transfer password", type: "password", advanced: true },
  { name: "pathStrip", label: "Strip remote prefix", type: "text", default: "", helpText: "transfer URL only: the client path prefix the URL's root corresponds to (a chrooted FTP home, the listed folder)", advanced: true },
  { name: "verifyTls", label: "Verify TLS certificates", type: "checkbox", default: true, advanced: true },
];

/** a URL with its login split out: the login belongs in password fields (masked in the UI, never echoed by the API), not in the URL */
export function splitLogin(url: string): { url: string; user: string; pass: string } {
  try {
    const u = new URL(url.trim());
    if (!u.username && !u.password) return { url: url.trim(), user: "", pass: "" };
    const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
    u.username = ""; u.password = "";
    return { url: u.toString(), user, pass };
  } catch { return { url: url.trim(), user: "", pass: "" }; }
}
/** the transfer URL with the login from the settings put back in; null when there is no transfer URL */
export function transferUrl(s: Settings): URL | null {
  const raw = str(s.pullUrl);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.username && str(s.pullUser)) u.username = encodeURIComponent(str(s.pullUser));   // a login still written into the URL is honoured
    if (!u.password && str(s.pullPass)) u.password = encodeURIComponent(str(s.pullPass));
    return u;
  } catch { return null; }
}

export function transfer(s: Settings, ctx: PluginContext) {
  const u = transferUrl(s);
  const [from, to] = str(s.pathMap).split("=").map(x => x.trim().replace(/[\\/]+$/, ""));
  return (item: { path: string; isDir: boolean; sizeBytes: number }, job: PullJob): PullHandle | { local: string } => {
    // a web file listing (https://box/downloads): the native segmented engine; sftp/ftp: lftp
    if (u && /^https?:$/i.test(u.protocol)) return startHttpPull(job, httpsSource(u, str(s.pathStrip), ctx.fetch), { downloadsDir: job.staging ? join(job.staging, "fetch-" + job.fetchId) : ctx.paths.downloads, segments: num(ctx.config("PULL_SEGMENTS"), 4) });
    if (u) return startPull(job, { url: u.toString(), downloadsDir: job.staging ? join(job.staging, "fetch-" + job.fetchId) : ctx.paths.downloads, pathStrip: str(s.pathStrip), verifyTls: s.verifyTls !== false, segments: num(ctx.config("PULL_SEGMENTS"), 4) });
    const p = item.path.replace(/\\/g, "/");
    const mapped = from && to && (p === from || p.startsWith(from + "/")) ? to + p.slice(from.length) : null;
    if (job.staging) return stageMapped(mapped ?? item.path, job, join(job.staging, "fetch-" + job.fetchId));
    if (mapped) return waitForLocal(mapped, job);   // appears, settles, then imports
    return { local: item.path };
  };
}

/* ─────────── rTorrent ─────────── */

export const rtorrent: DownloadClientDefinition = {
  kind: "downloadClient", impl: "rtorrent", name: "rTorrent", protocols: ["torrent"],
  description: "rTorrent / ruTorrent over XML-RPC (the httprpc plugin or a bare /RPC2 mount).",
  fields: [
    { name: "url", label: "XML-RPC URL", type: "url", required: true, placeholder: "https://box/rutorrent/plugins/httprpc/action.php" },
    { name: "user", label: "Username", type: "text", default: "" },
    { name: "pass", label: "Password", type: "password" },
    { name: "label", label: "Label", type: "text", default: "ludarr", helpText: "stamped on grabs (d.custom1)", advanced: true },
    { name: "dir", label: "Download directory", type: "text", default: "", helpText: "optional directory on the client for grabs", advanced: true },
    { name: "seedRatio", label: "Remove after seed ratio", type: "number", default: 1, helpText: "an imported torrent keeps seeding until it reaches this ratio, then it is removed with its files; 0 = no ratio goal" },
    { name: "seedTimeHours", label: "Remove after seeding (hours)", type: "number", default: 0, helpText: "… or after this many hours of seeding, whichever comes first; 0 = no time goal (0 and 0: it seeds for good)" },
    ...TRANSFER_FIELDS,
  ],
  create(s: Settings, ctx: PluginContext): DownloadClient {
    const rt = new RtorrentClient(ctx.fetch, null, { url: str(s.url), user: str(s.user), pass: str(s.pass) });
    const opts = { label: str(s.label) || undefined, dir: str(s.dir) || undefined };
    return {
      test: async () => ({ ok: true, detail: `rTorrent ${await rt.version()}` }),
      async add(payload) {
        if (payload.kind === "nzb") throw new Error("rTorrent cannot take an NZB");
        const hash = payload.kind === "magnet" ? parseMagnet(payload.uri)?.infoHash : parseTorrent(payload.bytes).infoHash;
        if (!hash) throw new Error("could not read the info hash");
        if (!(await rt.get(hash))) { if (payload.kind === "magnet") await rt.addMagnet(payload.uri, opts); else await rt.addTorrent(payload.bytes, opts); }
        return { client: "rtorrent", clientId: hash, infoHash: hash };
      },
      items: async () => ({ items: (await rt.list()).map(fromRtorrent) }),
      remove: (ref, deleteData) => rt.erase(ref.clientId, deleteData),
      seedGoals: { ratio: Math.max(0, num(s.seedRatio, 1)), hours: Math.max(0, num(s.seedTimeHours, 0)) },
      pull: transfer(s, ctx),
      files: ref => rt.files(ref.clientId),
    };
  },
};

/* ─────────── NZBGet ─────────── */

/** the dupe key an append carries: "ludarr:<release guid>", cut to NZBGet's 250 characters — a "#2" on the key (the same
 *  release downloaded again after the finished-downloads folder lost it, src/arrivals.ts) is kept whole, so it never finds
 *  the first */
export function dupeKey(key: string): string {
  const n = /#\d+$/.exec(key)?.[0] ?? "";
  return `ludarr:${key.slice(0, key.length - n.length)}`.slice(0, 250 - n.length) + n;
}

export const nzbget: DownloadClientDefinition = {
  kind: "downloadClient", impl: "nzbget", name: "NZBGet", protocols: ["usenet"],
  description: "NZBGet over JSON-RPC.",
  fields: [
    { name: "url", label: "URL", type: "url", required: true, placeholder: "https://box/nzbget", helpText: "/jsonrpc is appended" },
    { name: "user", label: "Username", type: "text", default: "" },
    { name: "pass", label: "Password", type: "password" },
    { name: "category", label: "Category", type: "text", default: "ludarr" },
    ...TRANSFER_FIELDS,
  ],
  create(s: Settings, ctx: PluginContext): DownloadClient {
    const nz = new NzbgetClient(ctx.fetch, { url: str(s.url), user: str(s.user), pass: str(s.pass) });
    return {
      test: async () => ({ ok: true, detail: `NZBGet ${await nz.version()}` }),
      async add(payload, opt) {
        if (payload.kind !== "nzb") throw new Error("NZBGet only takes NZBs");
        // sent again after an answer that never came (NZBGet slow to answer): the item the first append made is taken, never
        // a second download of the same post
        const key = opt?.key ? dupeKey(opt.key) : "";
        const had = key ? await nz.findByDupeKey(key) : null;
        if (had) { ctx.log.info(`${payload.filename}: NZBGet already has it (#${had}) — not added twice`); return { client: "nzbget", clientId: String(had) }; }
        const id = await nz.add(payload.filename, payload.bytes, str(s.category) || "ludarr", key);
        return { client: "nzbget", clientId: String(id) };
      },
      items: async () => ({ items: (await nz.snapshot()).map(fromNzbget) }),
      async remove(ref) { const it = await nz.get(Number(ref.clientId)); if (it) await nz.remove(it.id, it.inHistory); },
      pull: transfer(s, ctx),
    };
  },
};
