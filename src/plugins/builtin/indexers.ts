/**
 * Built-in indexers: Prowlarr (one search fans out to everything set up there) and plain Torznab /
 * Newznab endpoints (Jackett, NZBHydra, an indexer's own API).
 */
import { ProwlarrClient } from "../../prowlarr";
import type { Indexer, IndexerDefinition, Payload, PluginContext, Release, Settings } from "../types";

/** "11, 8" -> [11, 8]; "" -> [] (an emptied field means none: Number("") is 0, and Prowlarr treats indexer 0 as "every selected indexer is unavailable") */
const ints = (s: unknown) => String(s ?? "").split(",").map(x => x.trim()).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n > 0);
const safeName = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 120);

/** GET a release link: a magnet, or .torrent / .nzb bytes (following redirects by hand so a magnet redirect is caught) */
export async function resolvePayload(r: Pick<Release, "downloadUrl" | "magnetUrl" | "title" | "fileName">, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<Payload> {
  if (r.magnetUrl && /^magnet:/i.test(r.magnetUrl)) return { kind: "magnet", uri: r.magnetUrl };
  if (!r.downloadUrl) throw new Error("the release has no download link");
  let url = r.downloadUrl;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") ?? "";
      if (/^magnet:/i.test(loc)) return { kind: "magnet", uri: loc };
      if (!loc) throw new Error("redirect without a location");
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`download link answered HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const head = Buffer.from(bytes.subarray(0, 64)).toString("latin1");
    const cdName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
    if (/^d\d+:/.test(head)) return { kind: "torrent", bytes, filename: cdName ?? `${safeName(r.title)}.torrent` };
    if (/^\s*(<\?xml|<!DOCTYPE nzb|<nzb)/i.test(head)) return { kind: "nzb", bytes, filename: cdName ?? r.fileName ?? `${safeName(r.title)}.nzb` };
    throw new Error(`unrecognised payload (${res.headers.get("content-type") ?? "?"}): ${head.slice(0, 40)}`);
  }
  throw new Error("too many redirects");
}

/* ─────────── Prowlarr ─────────── */

export const prowlarr: IndexerDefinition = {
  kind: "indexer", impl: "prowlarr", name: "Prowlarr", protocols: ["torrent", "usenet"],
  description: "Searches every indexer configured in Prowlarr. The usual way to go.",
  infoLink: "https://wiki.servarr.com/prowlarr",
  fields: [
    { name: "url", label: "URL", type: "url", required: true, placeholder: "http://192.168.1.10:9696", helpText: "must be reachable from ludarr's container" },
    { name: "apiKey", label: "API key", type: "password", required: true, helpText: "Prowlarr → Settings → General → API Key" },
    { name: "categories", label: "Categories", type: "text", default: "4000", helpText: "newznab categories, comma-separated: 4000 = PC (what private trackers answer to), 4050 = PC/Games, 1000 = Console; empty = every category, which asks every indexer" },
    { name: "indexerIds", label: "Indexer ids", type: "text", default: "", helpText: "comma-separated Prowlarr indexer ids to search; empty = every enabled indexer", advanced: true },
  ],
  create(s: Settings, ctx: PluginContext): Indexer {
    const client = new ProwlarrClient(ctx.fetch, { url: String(s.url), apiKey: String(s.apiKey), categories: ints(s.categories), indexerIds: ints(s.indexerIds) }, ctx.instanceId ?? 0);
    return {
      test: async () => { const st = await client.status(); return { ok: st.ok, detail: st.detail }; },
      search: (q, opt) => client.search(q, opt),
      recent: opt => client.search("", opt),              // a query-less search is every indexer's recent feed
      health: () => client.health(),
      download: r => client.download(r),
      privacy: async () => new Map((await client.indexers()).map(i => [i.id, i.privacy] as [number, string])),
    };
  },
};

/* ─────────── Torznab / Newznab ─────────── */

const tag = (xml: string, name: string) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml); return m ? decode(m[1].trim()) : null; };
const attr = (xml: string, name: string) => { const m = new RegExp(`<(?:torznab|newznab):attr\\s+name="${name}"\\s+value="([^"]*)"`, "i").exec(xml); return m ? decode(m[1]) : null; };
const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

export function parseNabFeed(xml: string, instanceId: number, indexerName: string, protocol: "torrent" | "usenet"): Release[] {
  const out: Release[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    const enclosure = /<enclosure\s[^>]*url="([^"]+)"[^>]*(?:length="(\d+)")?/i.exec(it);
    const title = tag(it, "title") ?? "";
    if (!title) continue;
    const size = Number(attr(it, "size") ?? enclosure?.[2] ?? tag(it, "size") ?? 0);
    const pub = tag(it, "pubDate") ?? "";
    const age = pub ? Math.max(0, (Date.now() - Date.parse(pub)) / 86_400_000) : 0;
    const link = enclosure?.[1] ?? tag(it, "link");
    const magnet = attr(it, "magneturl") ?? (link && /^magnet:/i.test(link) ? link : null);
    const cats = [...it.matchAll(/<(?:torznab|newznab):attr\s+name="category"\s+value="(\d+)"/gi)].map(x => ({ id: Number(x[1]) }));
    out.push({
      guid: tag(it, "guid") ?? link ?? title, title, instanceId, indexerId: 0, indexer: indexerName, size: Number.isFinite(size) ? size : 0,
      age: Math.round(age), publishDate: pub ? new Date(pub).toISOString() : "",
      seeders: attr(it, "seeders") != null ? Number(attr(it, "seeders")) : null, leechers: attr(it, "peers") != null ? Math.max(0, Number(attr(it, "peers")) - Number(attr(it, "seeders") ?? 0)) : null,
      grabs: attr(it, "grabs") != null ? Number(attr(it, "grabs")) : null, files: attr(it, "files") != null ? Number(attr(it, "files")) : null,
      downloadUrl: link && !/^magnet:/i.test(link) ? link : null, magnetUrl: magnet, infoUrl: tag(it, "comments"),
      infoHash: attr(it, "infohash")?.toUpperCase() ?? null, protocol, categories: cats, indexerFlags: [], fileName: null,
    });
  }
  return out;
}

function nab(impl: "torznab" | "newznab"): IndexerDefinition {
  const protocol = impl === "torznab" ? "torrent" : "usenet";
  return {
    kind: "indexer", impl, name: impl === "torznab" ? "Torznab" : "Newznab", protocols: [protocol],
    description: impl === "torznab" ? "A Torznab endpoint: Jackett, or a tracker's own API." : "A Newznab endpoint: NZBHydra, or a usenet indexer's own API.",
    fields: [
      { name: "url", label: "URL", type: "url", required: true, placeholder: impl === "torznab" ? "http://jackett:9117/api/v2.0/indexers/xyz/results/torznab/" : "https://indexer.example/api", helpText: "the endpoint that answers ?t=caps" },
      { name: "apiKey", label: "API key", type: "password", default: "" },
      { name: "categories", label: "Categories", type: "text", default: "4000,4050", helpText: "comma-separated newznab categories" },
      { name: "name", label: "Indexer name", type: "text", default: "", helpText: "shown on releases; defaults to the host name", advanced: true },
    ],
    create(s: Settings, ctx: PluginContext): Indexer {
      const base = String(s.url).replace(/\/+$/, "");
      const name = String(s.name || new URL(base).hostname);
      const get = async (params: Record<string, string>) => {
        const u = new URL(base.includes("?") ? base : base + "?");
        for (const [k, v] of Object.entries({ ...params, ...(s.apiKey ? { apikey: String(s.apiKey) } : {}) })) if (v) u.searchParams.set(k, v);
        const res = await ctx.fetch(u, { headers: { "User-Agent": "ludarr" }, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${name}`);
        const xml = await res.text();
        const err = /<error\s+code="(\d+)"\s+description="([^"]*)"/i.exec(xml);
        if (err) throw new Error(`${name}: ${err[2]} (${err[1]})`);
        return xml;
      };
      return {
        test: async () => { const xml = await get({ t: "caps" }); const n = /<server\s[^>]*title="([^"]*)"/i.exec(xml)?.[1]; return { ok: true, detail: `caps OK${n ? ` — ${n}` : ""}` }; },
        search: async (q, opt) => parseNabFeed(await get({ t: "search", q, cat: (opt?.categories ?? ints(s.categories)).join(","), limit: String(opt?.limit ?? 100) }), ctx.instanceId ?? 0, name, protocol),
        download: r => resolvePayload(r, {}, ctx.fetch),
      };
    },
  };
}
export const torznab = nab("torznab");
export const newznab = nab("newznab");
