/**
 * ludarr — NZBGet client over JSON-RPC (POST <NZBGET_URL>/jsonrpc, HTTP basic auth).
 *
 *   add:     append(Filename, <nzb base64>, Category, Priority, AddToTop, AddPaused, DupeKey, DupeScore, DupeMode, AutoCategory, PPParameters) → NZBID
 *   queue:   listgroups(0)   → active items (Status QUEUED, DOWNLOADING, PP_QUEUED, UNPACKING, …)
 *   done:    history(false)  → finished items (Status SUCCESS/…, WARNING/…, FAILURE/…, DELETED/…)
 *   sizes come as Lo/Hi 32-bit halves.
 */
export interface NzbItem {
  id: number;
  name: string;
  status: string;
  sizeBytes: number;
  remainingBytes: number;
  downloadedBytes: number;
  destDir: string;
  finalDir: string;
  category: string;
  inHistory: boolean;
  /** the dupe key it was appended with (ludarr's: "ludarr:<release guid>"), and when it went to the history (unix s) */
  dupeKey?: string;
  historyTime?: number;
}

const u64 = (lo: unknown, hi: unknown) => (Number(hi) >>> 0) * 4294967296 + (Number(lo) >>> 0);

const toItem = (x: any, inHistory: boolean): NzbItem => ({
  id: Number(x.NZBID),
  name: String(x.NZBName ?? x.Name ?? ""),
  status: String(x.Status ?? ""),
  sizeBytes: u64(x.FileSizeLo, x.FileSizeHi),
  remainingBytes: u64(x.RemainingSizeLo, x.RemainingSizeHi),
  downloadedBytes: u64(x.DownloadedSizeLo, x.DownloadedSizeHi),
  destDir: String(x.DestDir ?? ""),
  finalDir: String(x.FinalDir ?? ""),
  category: String(x.Category ?? ""),
  inHistory,
  dupeKey: String(x.DupeKey ?? ""),
  ...(inHistory && Number(x.HistoryTime) > 0 ? { historyTime: Number(x.HistoryTime) } : {}),
});

export interface NzbgetConn { url: string; user?: string; pass?: string }

export class NzbgetClient {
  constructor(private fetchImpl: typeof fetch = fetch, private conn: NzbgetConn | null = null) {}

  private connection(): NzbgetConn { return this.conn ?? { url: "" }; }
  configured() { return !!this.connection().url; }
  private endpoint() {
    const u = this.connection().url.replace(/\/+$/, "");
    return /\/jsonrpc$/.test(u) ? u : `${u}/jsonrpc`;
  }

  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.configured()) throw new Error("NZBGET_NOT_CONFIGURED");
    const { user, pass } = this.connection();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) headers.authorization = "Basic " + Buffer.from(`${user}:${pass ?? ""}`).toString("base64");
    const res = await this.fetchImpl(this.endpoint(), {
      method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`NZBGET_HTTP_${res.status}`);
    const j = await res.json() as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new Error(`NZBGET_RPC ${j.error.code}: ${j.error.message}`);
    return j.result as T;
  }

  version(): Promise<string> { return this.rpc<string>("version"); }

  /** `dupeKey`: ludarr's key for the release (its own check finds an append that went through when the answer was lost;
   *  NZBGet's own duplicate rules are switched off for it: FORCE) */
  async add(filename: string, bytes: Uint8Array, category: string, dupeKey = ""): Promise<number> {
    const id = await this.rpc<number>("append", [
      filename, Buffer.from(bytes).toString("base64"), category, 0, false, false, dupeKey, 0, dupeKey ? "FORCE" : "SCORE", false, [],
    ]);
    if (!(Number(id) > 0)) throw new Error(`NZBGET_APPEND_FAILED (${id})`);
    return Number(id);
  }

  /** the item an earlier append with this dupe key made — in the queue, or in the history from the last two hours and not
   *  failed (an append whose answer was lost, sent again): its NZBID, or null */
  async findByDupeKey(dupeKey: string, nowSec = Math.floor(Date.now() / 1000)): Promise<number | null> {
    if (!dupeKey) return null;
    const hit = (await this.snapshot()).find(i => i.dupeKey === dupeKey && (!i.inHistory || ((i.historyTime ?? 0) > nowSec - 7200 && !/^(FAILURE|DELETED)/.test(i.status))));
    return hit ? hit.id : null;
  }

  /** Queue then history — the worker polls this once per tick, not once per item. One after the other, the queue first: an
   *  item that finishes in between is then in both (the queue's row wins until the next look), never in neither */
  async snapshot(): Promise<NzbItem[]> {
    const groups = await this.rpc<any[]>("listgroups", [0]);
    const history = await this.rpc<any[]>("history", [false]);
    return [...(groups ?? []).map(g => toItem(g, false)), ...(history ?? []).map(h => toItem(h, true))];
  }

  async get(id: number): Promise<NzbItem | null> {
    return (await this.snapshot()).find(i => i.id === id) ?? null;
  }

  async remove(id: number, inHistory: boolean): Promise<void> {
    await this.rpc("editqueue", [inHistory ? "HistoryDelete" : "GroupDelete", "", [id]]);
  }
}
