import { beforeEach, describe, expect, test } from "bun:test";
import { ProwlarrClient, normalizeRelease } from "../src/prowlarr";
import { RtorrentClient } from "../src/rtorrent";
import { NzbgetClient } from "../src/nzbget";
import { prowlarr as prowlarrDef } from "../src/plugins/builtin/indexers";

type Call = { url: string; init?: RequestInit };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: any, init?: RequestInit) => {
    const c = { url: String(input), init };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const PROWLARR = { url: "http://prowlarr:9696/", apiKey: "k" };
const RT = { url: "https://box/rutorrent/plugins/httprpc/action.php", user: "u", pass: "p" };
const NZ = { url: "https://box/nzbget", user: "nzb", pass: "secret" };

describe("ProwlarrClient", () => {
  test("search builds the v1 query with repeated categories and sends X-Api-Key", async () => {

    const { f, calls } = fakeFetch(() => Response.json([{ guid: "g1", title: "Hades-CODEX", indexerId: 2, indexer: "Fuzer", size: 1, protocol: "torrent", infoHash: "abc" }]));
    const rows = await new ProwlarrClient(f, { ...PROWLARR, categories: [4000, 1000] }, 7).search("Hades");
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/api/v1/search");
    expect(u.searchParams.get("query")).toBe("Hades");
    expect(u.searchParams.get("type")).toBe("search");
    expect(u.searchParams.getAll("categories")).toEqual(["4000", "1000"]);
    expect(u.searchParams.has("indexerIds")).toBe(false);
    expect((calls[0].init?.headers as any)["X-Api-Key"]).toBe("k");
    expect(rows[0]).toMatchObject({ guid: "g1", infoHash: "ABC", protocol: "torrent", indexer: "Fuzer" });
    expect(rows[0]?.instanceId ?? 7).toBe(7);
  });
  test("search: an emptied category list asks every indexer; Prowlarr's 'all selected indexers unavailable' 400 becomes a sentence to act on", async () => {
    const { f, calls } = fakeFetch(() => Response.json([]));
    await new ProwlarrClient(f, { ...PROWLARR, categories: [] }, 7).search("Hades");
    expect(new URL(calls[0].url).searchParams.has("categories")).toBe(false);
    const { f: down } = fakeFetch(() => new Response(JSON.stringify({ message: "Search failed due to all selected indexers being unavailable" }), { status: 400 }));
    await expect(new ProwlarrClient(down, { ...PROWLARR, categories: [4000] }, 7).search("Hades")).rejects.toThrow(/no indexer available for this search right now \(categories 4000\)/);
    const { f: other } = fakeFetch(() => new Response("boom", { status: 500 }));
    await expect(new ProwlarrClient(other, PROWLARR, 7).search("Hades")).rejects.toThrow(/PROWLARR_HTTP_500/);
    const { f: hf } = fakeFetch(() => Response.json([{ type: "warning", message: "Indexers unavailable due to failures for more than 6 hours: Hebits, IPTorrents", source: "IndexerStatusCheck" }]));
    expect(await new ProwlarrClient(hf, PROWLARR, 7).health()).toEqual([{ type: "warning", message: "Indexers unavailable due to failures for more than 6 hours: Hebits, IPTorrents" }]);
  });
  test("the Prowlarr definition: emptied Categories and Indexer ids send no filter at all, never indexer 0", async () => {
    const { f, calls } = fakeFetch(() => Response.json([]));
    const idx = prowlarrDef.create({ url: "http://prowlarr:9696", apiKey: "k", categories: "", indexerIds: "" }, { fetch: f, instanceId: 7, log: { info() {}, warn() {}, error() {}, debug() {} }, config: () => "", paths: { downloads: "/d" } } as never);
    await idx.search("Hades");
    const u = new URL(calls[0].url);
    expect(u.searchParams.has("indexerIds")).toBe(false); expect(u.searchParams.has("categories")).toBe(false);
    const idx2 = prowlarrDef.create({ url: "http://prowlarr:9696", apiKey: "k", categories: "4000, 4050", indexerIds: "11,8" }, { fetch: f, instanceId: 7, log: { info() {}, warn() {}, error() {}, debug() {} }, config: () => "", paths: { downloads: "/d" } } as never);
    await idx2.search("Hades");
    const u2 = new URL(calls[1].url);
    expect(u2.searchParams.getAll("categories")).toEqual(["4000", "4050"]); expect(u2.searchParams.getAll("indexerIds")).toEqual(["11", "8"]);
  });
  test("download: 302 → magnet", async () => {
    const { f } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "magnet:?xt=urn:btih:C12FE1C06BB254887BAC6E25F7CE1CE2A3DEE4E8" } }));
    const p = await new ProwlarrClient(f, PROWLARR).download({ downloadUrl: "http://prowlarr:9696/2/download?x", magnetUrl: null, title: "t", fileName: null });
    expect(p.kind).toBe("magnet");
  });
  test("download: torrent bytes sniffed by bencode prefix; nzb by xml", async () => {
    const t = new TextEncoder().encode("d8:announce3:url4:infod4:name1:xee");
    const { f } = fakeFetch(() => new Response(t, { status: 200, headers: { "content-disposition": 'attachment; filename="Hades.torrent"' } }));
    const p = await new ProwlarrClient(f, PROWLARR).download({ downloadUrl: "http://p/dl", magnetUrl: null, title: "Hades", fileName: null });
    expect(p.kind).toBe("torrent");
    if (p.kind === "torrent") expect(p.filename).toBe("Hades.torrent");
    const { f: f2 } = fakeFetch(() => new Response('<?xml version="1.0"?><nzb/>', { status: 200 }));
    const n = await new ProwlarrClient(f2, PROWLARR).download({ downloadUrl: "http://p/dl", magnetUrl: null, title: "Hades/Deluxe", fileName: null });
    expect(n.kind).toBe("nzb");
    if (n.kind === "nzb") expect(n.filename).toBe("Hades_Deluxe.nzb");
  });
  test("download: html login page is rejected", async () => {
    const { f } = fakeFetch(() => new Response("<html>login</html>", { status: 200 }));
    await expect(new ProwlarrClient(f, PROWLARR).download({ downloadUrl: "http://p/dl", magnetUrl: null, title: "t", fileName: null })).rejects.toThrow(/UNRECOGNIZED_PAYLOAD/);
  });
  test("normalizeRelease tolerates sparse objects", () => {
    expect(normalizeRelease({})).toMatchObject({ guid: "", protocol: "unknown", seeders: null, categories: [] });
  });
});

describe("RtorrentClient", () => {
  test("list decodes d.multicall2 rows and derives the data path", async () => {
    const xml = `<?xml version="1.0"?><methodResponse><params><param><value><array><data>
      <value><array><data>
        <value><string>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</string></value><value><string>Hades-CODEX</string></value>
        <value><i8>0</i8></value><value><i8>1</i8></value><value><i8>10000</i8></value><value><i8>2500</i8></value><value><i8>900</i8></value>
        <value><string>/home/u/downloads/Hades-CODEX</string></value><value><i8>1</i8></value><value><string>ahoy</string></value><value><string></string></value>
      </data></array></value>
      <value><array><data>
        <value><string>BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB</string></value><value><string>single.iso</string></value>
        <value><i8>1</i8></value><value><i8>0</i8></value><value><i8>500</i8></value><value><i8>500</i8></value><value><i8>0</i8></value>
        <value><string>/home/u/downloads/</string></value><value><i8>0</i8></value><value><string></string></value><value><string>Tracker: [Timeout]</string></value>
      </data></array></value>
    </data></array></value></param></params></methodResponse>`;
    const { f, calls } = fakeFetch(() => new Response(xml));
    const items = await new RtorrentClient(f, null, RT).list();
    expect(calls[0].url).toBe("https://box/rutorrent/plugins/httprpc/action.php");
    expect((calls[0].init?.headers as any).authorization).toBe("Basic " + btoa("u:p"));
    expect(String(calls[0].init?.body)).toContain("<methodName>d.multicall2</methodName>");
    expect(String(calls[0].init?.body)).toContain("<string>d.hash=</string>");
    expect(items[0]).toMatchObject({ hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", complete: false, active: true, sizeBytes: 10000, completedBytes: 2500, multiFile: true, label: "ahoy", dataPath: "/home/u/downloads/Hades-CODEX" });
    expect(items[1]).toMatchObject({ complete: true, multiFile: false, dataPath: "/home/u/downloads/single.iso", message: "Tracker: [Timeout]" });
    expect(await new RtorrentClient(f, null, RT).get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toBeNull();
  });
  test("addTorrent sends load.raw_start with base64 + label + dir", async () => {
    const { f, calls } = fakeFetch(() => new Response("<methodResponse><params><param><value><i4>0</i4></value></param></params></methodResponse>"));
    await new RtorrentClient(f, null, RT).addTorrent(new Uint8Array([100, 101]), { label: "ahoy", dir: "/home/u/dl/ahoy" });
    const body = String(calls[0].init?.body);
    expect(body).toContain("<methodName>load.raw_start</methodName>");
    expect(body).toContain("<param><value><string></string></value></param>");
    expect(body).toContain("<base64>ZGU=</base64>");
    expect(body).toContain("<string>d.custom1.set=ahoy</string>");
    expect(body).toContain("<string>d.directory.set=/home/u/dl/ahoy</string>");
  });
  test("http errors and xmlrpc faults surface", async () => {
    const { f } = fakeFetch(() => new Response("nope", { status: 401 }));
    await expect(new RtorrentClient(f, null, RT).version()).rejects.toThrow(/RTORRENT_HTTP_401/);
    delete process.env.RTORRENT_URL;
    expect(new RtorrentClient(f).configured()).toBe(false);
  });
});

describe("NzbgetClient", () => {
  test("add posts the 11-arg append over jsonrpc with basic auth", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ result: 42 }));
    const id = await new NzbgetClient(f, NZ).add("Hades.nzb", new Uint8Array([1, 2]), "ahoy");
    expect(id).toBe(42);
    expect(calls[0].url).toBe("https://box/nzbget/jsonrpc");
    expect((calls[0].init?.headers as any).authorization).toBe("Basic " + btoa("nzb:secret"));
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.method).toBe("append");
    expect(body.params).toEqual(["Hades.nzb", "AQI=", "ahoy", 0, false, false, "", 0, "SCORE", false, []]);
  });
  test("append failure (0) throws; rpc error surfaces", async () => {
    await expect(new NzbgetClient(fakeFetch(() => Response.json({ result: 0 })).f, NZ).add("x.nzb", new Uint8Array(), "ahoy")).rejects.toThrow(/APPEND_FAILED/);
    await expect(new NzbgetClient(fakeFetch(() => Response.json({ error: { code: 401, message: "Unauthorized" } })).f, NZ).version()).rejects.toThrow(/NZBGET_RPC 401/);
  });
  test("snapshot merges queue and history, decoding Lo/Hi sizes", async () => {
    const { f } = fakeFetch(c => {
      const m = JSON.parse(String(c.init?.body)).method;
      if (m === "listgroups") return Response.json({ result: [{ NZBID: 7, NZBName: "Hades", Status: "DOWNLOADING", FileSizeLo: 0, FileSizeHi: 1, RemainingSizeLo: 2147483648, RemainingSizeHi: 0, DestDir: "/dl/Hades", FinalDir: "", Category: "ahoy" }] });
      return Response.json({ result: [{ NZBID: 5, Name: "Old", Status: "SUCCESS/UNPACK", FileSizeLo: 1000, FileSizeHi: 0, DestDir: "/dl/Old", FinalDir: "/done/Old", Category: "ahoy" }] });
    });
    const items = await new NzbgetClient(f, NZ).snapshot();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 7, status: "DOWNLOADING", sizeBytes: 4294967296, remainingBytes: 2147483648, inHistory: false });
    expect(items[1]).toMatchObject({ id: 5, status: "SUCCESS/UNPACK", finalDir: "/done/Old", inHistory: true, sizeBytes: 1000 });
    expect(await new NzbgetClient(f, NZ).get(5)).toMatchObject({ inHistory: true });
    expect(await new NzbgetClient(f, NZ).get(99)).toBeNull();
  });
});

describe("review 2026-11-10: the Prowlarr key stays with Prowlarr, and a payload has a size", () => {
  const key = (c: Call) => (c.init?.headers as Record<string, string> | undefined)?.["X-Api-Key"];
  test("a redirect to another host is followed without the key; a hop back on Prowlarr carries it", async () => {
    const t = new TextEncoder().encode("d8:announce3:url4:infod4:name1:xee");
    const { f, calls } = fakeFetch(c => {
      if (c.url === "http://prowlarr:9696/2/download?x") return new Response(null, { status: 302, headers: { location: "/2/again" } });
      if (c.url === "http://prowlarr:9696/2/again") return new Response(null, { status: 302, headers: { location: "https://tracker.example/dl/1.torrent" } });
      if (c.url === "https://tracker.example/dl/1.torrent") return new Response(null, { status: 302, headers: { location: "https://cdn.example/1.torrent" } });
      return new Response(t, { status: 200 });
    });
    const p = await new ProwlarrClient(f, PROWLARR).download({ downloadUrl: "http://prowlarr:9696/2/download?x", magnetUrl: null, title: "t", fileName: null });
    expect(p.kind).toBe("torrent");
    expect(calls.map(c => [new URL(c.url).host, key(c)])).toEqual([["prowlarr:9696", "k"], ["prowlarr:9696", "k"], ["tracker.example", undefined], ["cdn.example", undefined]]);
  });
  test("a redirect to something that is no web address is refused", async () => {
    const { f } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }));
    await expect(new ProwlarrClient(f, PROWLARR).download({ downloadUrl: "http://prowlarr:9696/2/download", magnetUrl: null, title: "t", fileName: null })).rejects.toThrow(/PROWLARR_REDIRECT_NOT_HTTP/);
  });
  test("a body past the cap is never read whole: by its length, or cut off as it streams", async () => {
    const { MAX_PAYLOAD } = await import("../src/prowlarr");
    const { f } = fakeFetch(() => new Response("d1:a1:be", { status: 200, headers: { "content-length": String(MAX_PAYLOAD + 1) } }));
    await expect(new ProwlarrClient(f, PROWLARR).download({ downloadUrl: "http://prowlarr:9696/dl", magnetUrl: null, title: "t", fileName: null })).rejects.toThrow(/PROWLARR_DOWNLOAD_TOO_LARGE/);
    let sent = 0;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const endless = () => new Response(new ReadableStream<Uint8Array>({ pull(c) { sent += chunk.length; c.enqueue(chunk); } }), { status: 200 });
    const { f: f2 } = fakeFetch(endless);
    await expect(new ProwlarrClient(f2, PROWLARR).download({ downloadUrl: "http://prowlarr:9696/dl", magnetUrl: null, title: "t", fileName: null })).rejects.toThrow(/PROWLARR_DOWNLOAD_TOO_LARGE/);
    expect(sent).toBeLessThan(MAX_PAYLOAD + 4 * chunk.length);
  });
});
