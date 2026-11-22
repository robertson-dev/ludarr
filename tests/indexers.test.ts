import { describe, expect, test } from "bun:test";
import { parseNabFeed, resolvePayload, torznab, newznab, prowlarr } from "../src/plugins/builtin/indexers";
import { pluginContext } from "../src/plugins/registry";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel><title>Jackett</title>
<item>
  <title>Hollow.Knight.v1.5.78-GOG</title>
  <guid>https://tracker/t/123</guid>
  <link>https://jackett/dl/123.torrent</link>
  <comments>https://tracker/t/123#c</comments>
  <pubDate>Fri, 17 Oct 2026 10:00:00 +0000</pubDate>
  <size>5368709120</size>
  <enclosure url="https://jackett/dl/123.torrent" length="5368709120" type="application/x-bittorrent" />
  <torznab:attr name="category" value="4050" />
  <torznab:attr name="category" value="4000" />
  <torznab:attr name="seeders" value="12" />
  <torznab:attr name="peers" value="15" />
  <torznab:attr name="infohash" value="abcdef0123456789abcdef0123456789abcdef01" />
</item>
<item>
  <title><![CDATA[Game &amp; Watch Collection]]></title>
  <guid isPermaLink="false">g2</guid>
  <link>magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF02&amp;dn=gw</link>
  <pubDate>Thu, 16 Oct 2026 10:00:00 +0000</pubDate>
  <torznab:attr name="size" value="1024" />
  <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF02&amp;dn=gw" />
</item>
</channel></rss>`;

describe("Torznab / Newznab", () => {
  test("feed items become releases: sizes, peers, categories, info hash, magnets, entities", () => {
    const rows = parseNabFeed(FEED, 7, "Jackett", "torrent");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ guid: "https://tracker/t/123", title: "Hollow.Knight.v1.5.78-GOG", instanceId: 7, indexer: "Jackett", size: 5368709120, seeders: 12, leechers: 3,
      downloadUrl: "https://jackett/dl/123.torrent", magnetUrl: null, infoHash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", protocol: "torrent", infoUrl: "https://tracker/t/123#c" });
    expect(rows[0].categories.map(c => c.id)).toEqual([4050, 4000]);
    expect(rows[0].age).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ guid: "g2", title: "Game & Watch Collection", size: 1024, downloadUrl: null, seeders: null });
    expect(rows[1].magnetUrl).toMatch(/^magnet:\?xt=urn:btih:ABCDEF/);
  });
  test("the definition: caps test, search query, api key and categories on the wire, download through the link", async () => {
    const calls: string[] = [];
    const f = (async (input: any) => {
      const url = String(input); calls.push(url);
      if (url.includes("t=caps")) return new Response('<caps><server title="My Jackett"/></caps>');
      if (url.includes("t=search")) return new Response(FEED);
      if (url.endsWith("123.torrent")) return new Response(new TextEncoder().encode("d8:announce3:abc4:infod4:name1:x6:lengthi1eee"));
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const ix = torznab.create({ url: "http://jackett:9117/api/v2.0/indexers/x/results/torznab/", apiKey: "K", categories: "4050,4000" }, { ...pluginContext("indexers", 7), fetch: f });
    expect(await ix.test()).toMatchObject({ ok: true, detail: expect.stringContaining("My Jackett") });
    const rows = await ix.search("hollow knight");
    expect(rows[0].instanceId).toBe(7);
    expect(calls[1]).toContain("t=search"); expect(calls[1]).toContain("q=hollow+knight"); expect(calls[1]).toContain("cat=4050%2C4000"); expect(calls[1]).toContain("apikey=K");
    const p = await ix.download(rows[0]);
    expect(p.kind).toBe("torrent");
    expect(await ix.download(rows[1])).toMatchObject({ kind: "magnet" });
    const err = torznab.create({ url: "http://x", apiKey: "" }, { ...pluginContext("indexers"), fetch: (async () => new Response('<error code="100" description="Incorrect user credentials"/>')) as unknown as typeof fetch });
    await expect(err.search("x")).rejects.toThrow(/Incorrect user credentials/);
    expect(newznab.protocols).toEqual(["usenet"]); expect(prowlarr.protocols).toEqual(["torrent", "usenet"]);
  });
  test("resolvePayload follows redirects and recognises magnets, torrents and nzbs", async () => {
    const f = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://a/dl") return new Response(null, { status: 302, headers: { location: "/real" } });
      if (url === "http://a/real") return new Response(new TextEncoder().encode("<?xml version=\"1.0\"?><nzb/>"), { headers: { "content-disposition": 'attachment; filename="game.nzb"' } });
      if (url === "http://m/dl") return new Response(null, { status: 302, headers: { location: "magnet:?xt=urn:btih:ABC" } });
      return new Response("html", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await resolvePayload({ downloadUrl: "http://a/dl", magnetUrl: null, title: "t", fileName: null }, {}, f)).toMatchObject({ kind: "nzb", filename: "game.nzb" });
    expect(await resolvePayload({ downloadUrl: "http://m/dl", magnetUrl: null, title: "t", fileName: null }, {}, f)).toMatchObject({ kind: "magnet", uri: "magnet:?xt=urn:btih:ABC" });
    await expect(resolvePayload({ downloadUrl: "http://h/x", magnetUrl: null, title: "t", fileName: null }, {}, f)).rejects.toThrow(/unrecognised payload/);
  });
});
