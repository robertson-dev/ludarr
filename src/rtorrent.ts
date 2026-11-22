/**
 * ludarr — rTorrent client over XML-RPC.
 *
 * The transport is pluggable:
 *   • HTTP(S) to ruTorrent's httprpc plugin or a bare /RPC2 mount — "direct" mode, RTORRENT_URL (+USER/PASS)
 *   • SCGI straight into rtorrent's own socket — what the bosun connector uses on the seedbox (scgi.ts)
 *
 *   add:    load.raw_start("", <torrent bytes>, "d.custom1.set=<label>"[, "d.directory.set=<dir>"])
 *           load.start("", <magnet uri>, …same post-load commands…)
 *   list:   d.multicall2("", "main", "d.hash=", "d.name=", …)
 *   files:  f.multicall(<hash>, "", "f.path=", "f.size_bytes=", "f.priority=") — a torrent's files it downloads (priority 0:
 *           "don't download", never written, never synced; src/arrivals.ts waits for the rest)
 *   path:   d.directory already includes the torrent's own folder for multi-file items;
 *           single-file items live at d.directory + "/" + d.name. (d.base_path is empty
 *           after restarts, so it is deliberately not used.)
 */
import { encodeCall, decodeResponse, type XValue } from "./xmlrpc";

export interface RtorrentConn { url: string; user?: string; pass?: string }

export type RtTransport = (xml: string) => Promise<string>;

export function httpTransport(url: string, user = "", pass = "", fetchImpl: typeof fetch = fetch): RtTransport {
  return async xml => {
    const headers: Record<string, string> = { "content-type": "text/xml" };
    if (user) headers.authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    const res = await fetchImpl(url, { method: "POST", headers, body: xml, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`RTORRENT_HTTP_${res.status}`);
    return res.text();
  };
}

export interface RtItem {
  hash: string;            // uppercase hex info-hash
  name: string;
  complete: boolean;
  active: boolean;
  sizeBytes: number;
  completedBytes: number;
  downRate: number;
  directory: string;
  multiFile: boolean;
  label: string;
  message: string;
  dataPath: string;        // where the payload actually lives on the seedbox
  ratio?: number;          // upload / download
  finishedAt?: number | null;  // unix seconds when it completed, when rTorrent knows
  peers?: number;          // peers connected now
  seeders?: number;        // connected peers that have it all
  hashing?: boolean;       // checking its data
}

const FIELDS = ["d.hash=", "d.name=", "d.complete=", "d.is_active=", "d.size_bytes=", "d.completed_bytes=",
  "d.down.rate=", "d.directory=", "d.is_multi_file=", "d.custom1=", "d.message=", "d.ratio=", "d.timestamp.finished=",
  // who it can download from and whether it is being checked: a stall with no peers is a dead torrent, one on a full link is not
  "d.peers_connected=", "d.peers_complete=", "d.hashing="];

export class RtorrentClient {
  constructor(private fetchImpl: typeof fetch = fetch, private transport: RtTransport | null = null, private conn: RtorrentConn | null = null) {}

  configured() { return !!this.transport || !!this.conn?.url; }

  async call<T = XValue>(method: string, ...params: XValue[]): Promise<T> {
    if (!this.configured()) throw new Error("RTORRENT_NOT_CONFIGURED");
    const send = this.transport ?? httpTransport(this.conn!.url, this.conn!.user ?? "", this.conn!.pass ?? "", this.fetchImpl);
    return decodeResponse(await send(encodeCall(method, params))) as T;
  }

  async version(): Promise<string> { return String(await this.call("system.client_version")); }

  private postLoad(opt: { label?: string; dir?: string } = {}): string[] {
    const cmds: string[] = [];
    if (opt.label) cmds.push(`d.custom1.set=${opt.label}`);
    if (opt.dir) cmds.push(`d.directory.set=${opt.dir}`);
    return cmds;
  }

  async addTorrent(bytes: Uint8Array, opt: { label?: string; dir?: string } = {}): Promise<void> {
    await this.call("load.raw_start", "", bytes, ...this.postLoad(opt));
  }

  async addMagnet(uri: string, opt: { label?: string; dir?: string } = {}): Promise<void> {
    await this.call("load.start", "", uri, ...this.postLoad(opt));
  }

  async list(): Promise<RtItem[]> {
    const rows = await this.call<XValue[][]>("d.multicall2", "", "main", ...FIELDS);
    // an answer that is not a list says nothing of what rTorrent holds: never read as "it holds nothing" (every download
    // would look vanished at once)
    if (!Array.isArray(rows)) throw new Error("rTorrent answered without a list of its torrents");
    return rows.map(r => {
      const [hash, name, complete, active, size, done, rate, directory, multi, label, message, ratio, finished, peers, seeders, hashing] = r as [string, string, number, number, number, number, number, string, number, string, string, number, number, number?, number?, number?];
      const dir = String(directory ?? "").replace(/\/+$/, "");
      const multiFile = Number(multi) === 1;
      return {
        hash: String(hash).toUpperCase(), name: String(name ?? ""),
        complete: Number(complete) === 1, active: Number(active) === 1,
        sizeBytes: Number(size) || 0, completedBytes: Number(done) || 0, downRate: Number(rate) || 0,
        directory: dir, multiFile, label: String(label ?? ""), message: String(message ?? ""),
        dataPath: multiFile ? dir : `${dir}/${name}`,
        ratio: (Number(ratio) || 0) / 1000, finishedAt: Number(finished) > 0 ? Number(finished) : null,
        ...(peers !== undefined ? { peers: Number(peers) || 0, seeders: Number(seeders) || 0 } : {}), ...(Number(hashing) > 0 ? { hashing: true } : {}),
      };
    });
  }

  /** the files a torrent holds that rTorrent downloads: each one's path inside the torrent's own folder (a single-file
   *  torrent: its name) and size — a file set to "don't download" (priority 0) is never written, so never waited for */
  async files(hash: string): Promise<{ path: string; size: number }[]> {
    const rows = await this.call<XValue[][]>("f.multicall", hash.toUpperCase(), "", "f.path=", "f.size_bytes=", "f.priority=");
    if (!Array.isArray(rows)) throw new Error("rTorrent answered without a list of the torrent's files");
    return rows.filter(r => !(Array.isArray(r) && r.length > 2 && Number(r[2]) === 0))
      .map(r => { const [path, size] = r as [string, number]; return { path: String(path ?? ""), size: Number(size) || 0 }; }).filter(f => !!f.path);
  }

  async get(hash: string): Promise<RtItem | null> {
    const h = hash.toUpperCase();
    return (await this.list()).find(i => i.hash === h) ?? null;
  }

  /** Remove from the client. With `deleteData`, custom5 is set to 1 first: ruTorrent's erasedata plugin then deletes the files (its own "Remove and delete data"). */
  async erase(hash: string, deleteData = false): Promise<void> {
    const h = hash.toUpperCase();
    if (deleteData) await this.call("d.custom5.set", h, "1").catch(() => { /* no such method: the files stay, the caller may delete them another way */ });
    await this.call("d.erase", h);
  }
}
