/**
 * ludarr — Prowlarr client: one search fans out to every indexer you've set up there.
 *
 * Contract (Prowlarr v1 API, from its openapi.json):
 *   auth:     X-Api-Key header
 *   status:   GET /api/v1/system/status
 *   indexers: GET /api/v1/indexer
 *   search:   GET /api/v1/search?query=&type=search&categories=&indexerIds=&limit=&offset=
 *   payload:  GET <release.downloadUrl> → .torrent / .nzb bytes, or a 3xx to a magnet: URI
 */
import type { Release } from "./plugins/types";

export type Protocol = "torrent" | "usenet" | "unknown";
export type ProwlarrRelease = Release;
export interface ProwlarrOpts { url: string; apiKey: string; categories?: number[]; indexerIds?: number[] }

export interface _ProwlarrReleaseShape {
  guid: string;
  title: string;
  instanceId: number;
  indexerId: number;
  indexer: string;
  size: number;
  age: number;                 // days
  publishDate: string;
  seeders: number | null;
  leechers: number | null;
  grabs: number | null;
  files: number | null;
  downloadUrl: string | null;
  magnetUrl: string | null;
  infoUrl: string | null;
  infoHash: string | null;     // uppercase hex when the indexer reports it
  protocol: Protocol;
  categories: { id: number; name?: string }[];
  indexerFlags: string[];
  fileName: string | null;
}

export interface ProwlarrIndexer {
  id: number; name: string; enable: boolean; protocol: Protocol; privacy: string;
}

export type Payload =
  | { kind: "magnet"; uri: string }
  | { kind: "torrent" | "nzb"; bytes: Uint8Array; filename: string };

/** a .torrent or an .nzb is a few MB (a huge season pack's nzb, tens): anything bigger is not one, and is never read whole */
export const MAX_PAYLOAD = 64 * 1024 * 1024;
async function bodyUpTo(res: Response, max: number): Promise<Uint8Array> {
  const tooBig = () => new Error(`PROWLARR_DOWNLOAD_TOO_LARGE (over ${Math.round(max / 1024 / 1024)} MB: not a .torrent or an .nzb)`);
  if (Number(res.headers.get("content-length") ?? 0) > max) { await res.body?.cancel().catch(() => {}); throw tooBig(); }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); throw tooBig(); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const safeName =(s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 120);

export function normalizeRelease(x: any, instanceId = 0): ProwlarrRelease {
  return {
    guid: String(x.guid ?? ""),
    title: String(x.title ?? ""),
    instanceId: Number(x.instanceId ?? instanceId),
    indexerId: Number(x.indexerId ?? 0),
    indexer: String(x.indexer ?? ""),
    size: Number(x.size ?? 0),
    age: Number(x.age ?? 0),
    publishDate: String(x.publishDate ?? ""),
    seeders: x.seeders ?? null,
    leechers: x.leechers ?? null,
    grabs: x.grabs ?? null,
    files: x.files ?? null,
    downloadUrl: x.downloadUrl ?? null,
    magnetUrl: x.magnetUrl ?? null,
    infoUrl: x.infoUrl ?? null,
    infoHash: x.infoHash ? String(x.infoHash).toUpperCase() : null,
    protocol: x.protocol === "torrent" || x.protocol === "usenet" ? x.protocol : "unknown",
    categories: (x.categories ?? []).map((c: any) => ({ id: Number(c.id), name: c.name })),
    indexerFlags: x.indexerFlags ?? [],
    fileName: x.fileName ?? null,
    privacy: x.privacy ?? undefined,
  };
}

export class ProwlarrClient {
  constructor(private fetchImpl: typeof fetch = fetch, private opts: ProwlarrOpts | null = null, private instanceId = 0) {}

  configured() { return !!(this.opts?.url && this.opts?.apiKey); }
  private base() { return (this.opts?.url ?? "").replace(/\/+$/, ""); }
  private key() { return this.opts?.apiKey ?? ""; }

  private async get<T>(path: string, params: Record<string, string | number | (string | number)[] | undefined> = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.configured()) throw new Error("PROWLARR_NOT_CONFIGURED");
    const u = new URL(`${this.base()}/api/v1/${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(x));
    }
    const res = await this.fetchImpl(u, {
      headers: { "X-Api-Key": this.key(), Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`PROWLARR_HTTP_${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }

  async status(): Promise<{ ok: boolean; version?: string; indexers?: number; detail: string }> {
    try {
      const s = await this.get<{ version: string }>("system/status", {}, 10_000);
      const enabled = (await this.indexers()).filter(i => i.enable).length;
      return { ok: true, version: s.version, indexers: enabled, detail: `Prowlarr ${s.version}, ${enabled} indexers enabled` };
    } catch (e: any) {
      return { ok: false, detail: String(e.message ?? e) };
    }
  }

  async indexers(): Promise<ProwlarrIndexer[]> {
    const raw = await this.get<any[]>("indexer", {}, 15_000);
    return raw.map(i => ({
      id: Number(i.id), name: String(i.name ?? ""), enable: !!i.enable,
      protocol: i.protocol ?? "unknown", privacy: String(i.privacy ?? "unknown"),
    }));
  }

  async search(query: string, opt: { categories?: number[]; indexerIds?: number[]; limit?: number } = {}): Promise<ProwlarrRelease[]> {
    const categories = opt.categories ?? this.opts?.categories ?? [4000];
    let raw: any[];
    try {
      raw = await this.get<any[]>("search", { query, type: "search", categories, indexerIds: opt.indexerIds ?? this.opts?.indexerIds ?? [], limit: opt.limit ?? 100, offset: 0 });
    } catch (e: any) {
      // Prowlarr answers 400 when every indexer it would ask is in a failure backoff or rate-limited: nothing was searched
      if (/PROWLARR_HTTP_400/.test(String(e?.message)) && /unavailable/i.test(String(e?.message)))
        throw new Error(`Prowlarr has no indexer available for this search right now${categories.length ? ` (categories ${categories.join(", ")})` : ""}: they are failing or rate-limited — see Prowlarr → System → Status, or clear the categories under Settings → Indexers to ask every indexer`);
      throw e;
    }
    return (Array.isArray(raw) ? raw : []).map(x => normalizeRelease(x, this.instanceId));
  }

  /** Prowlarr's own health page: indexers in a failure backoff, broken definitions … */
  async health(): Promise<{ type: "error" | "warning" | "notice"; message: string }[]> {
    const raw = await this.get<any[]>("health", {}, 10_000);
    return (Array.isArray(raw) ? raw : []).map(h => ({ type: h.type === "error" ? "error" : h.type === "warning" ? "warning" : "notice", message: String(h.message ?? "") }));
  }

  /** Resolve what a seedbox client needs: a magnet URI, or raw .torrent / .nzb bytes. */
  async download(r: Pick<ProwlarrRelease, "downloadUrl" | "magnetUrl" | "title" | "fileName">): Promise<Payload> {
    if (r.magnetUrl && /^magnet:/i.test(r.magnetUrl)) return { kind: "magnet", uri: r.magnetUrl };
    if (!r.downloadUrl) throw new Error("RELEASE_HAS_NO_DOWNLOAD_URL");
    let url = r.downloadUrl;
    const originOf = (u: string) => { try { return new URL(u).origin; } catch { return null; } };
    // the key goes to Prowlarr only: to the address set for it and to the host its own download link names (the same server,
    // however the link spells it) — never to where a redirect leads (an indexer set to redirect, a tracker's CDN)
    const ours = new Set([originOf(this.base()), originOf(r.downloadUrl)].filter(Boolean));
    for (let hop = 0; hop < 5; hop++) {
      if (!/^https?:/i.test(url)) throw new Error("PROWLARR_REDIRECT_NOT_HTTP");
      const res = await this.fetchImpl(url, {
        headers: ours.has(originOf(url)) ? { "X-Api-Key": this.key() } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") ?? "";
        if (/^magnet:/i.test(loc)) return { kind: "magnet", uri: loc };
        if (!loc) throw new Error("PROWLARR_REDIRECT_WITHOUT_LOCATION");
        url = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`PROWLARR_DOWNLOAD_HTTP_${res.status}`);
      const bytes = await bodyUpTo(res, MAX_PAYLOAD);
      const head = Buffer.from(bytes.subarray(0, 64)).toString("latin1");
      const cd = res.headers.get("content-disposition") ?? "";
      const cdName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
      if (/^d\d+:/.test(head)) return { kind: "torrent", bytes, filename: cdName ?? `${safeName(r.title)}.torrent` };
      if (/^\s*(<\?xml|<!DOCTYPE nzb|<nzb)/i.test(head)) return { kind: "nzb", bytes, filename: cdName ?? r.fileName ?? `${safeName(r.title)}.nzb` };
      throw new Error(`UNRECOGNIZED_PAYLOAD (${res.headers.get("content-type") ?? "?"}): ${head.slice(0, 40)}`);
    }
    throw new Error("PROWLARR_TOO_MANY_REDIRECTS");
  }
}
