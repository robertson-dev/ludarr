import { describe, expect, test } from "bun:test";
import { encodeCall, decodeResponse, XmlRpcFault } from "../src/xmlrpc";
import { parseTorrent, parseMagnet, base32ToHex } from "../src/bencode";

describe("xmlrpc encode", () => {
  test("string / int / i8 / base64 / nested params", () => {
    const xml = encodeCall("load.raw_start", ["", new Uint8Array([1, 2, 3]), "d.custom1.set=ahoy", 7, 2 ** 40]);
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?><methodCall><methodName>load.raw_start</methodName>');
    expect(xml).toContain("<param><value><string></string></value></param>");
    expect(xml).toContain("<base64>AQID</base64>");
    expect(xml).toContain("<string>d.custom1.set=ahoy</string>");
    expect(xml).toContain("<i4>7</i4>");
    expect(xml).toContain(`<i8>${2 ** 40}</i8>`);
  });
  test("escapes markup in strings", () => {
    expect(encodeCall("m", ["a<b&c"])).toContain("<string>a&lt;b&amp;c</string>");
  });
});

describe("xmlrpc decode", () => {
  test("d.multicall2-shaped nested arrays with i8, implicit strings, entities", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<methodResponse><params><param><value><array><data>
  <value><array><data>
    <value><string>ABCDEF0123456789ABCDEF0123456789ABCDEF01</string></value>
    <value><string>Hades &amp; Friends</string></value>
    <value><i8>1</i8></value>
    <value><i8>5368709120</i8></value>
    <value>/home/u/downloads/Hades</value>
  </data></array></value>
</data></array></value></param></params></methodResponse>`;
    const v = decodeResponse(xml) as unknown[][];
    expect(v).toHaveLength(1);
    expect(v[0]).toEqual(["ABCDEF0123456789ABCDEF0123456789ABCDEF01", "Hades & Friends", 1, 5368709120, "/home/u/downloads/Hades"]);
  });
  test("scalar, struct, boolean, base64, nil", () => {
    expect(decodeResponse("<methodResponse><params><param><value><string>0.9.8/0.13.8</string></value></param></params></methodResponse>")).toBe("0.9.8/0.13.8");
    const s = decodeResponse(`<methodResponse><params><param><value><struct>
      <member><name>ok</name><value><boolean>1</boolean></value></member>
      <member><name>raw</name><value><base64>AQID</base64></value></member>
      <member><name>none</name><value><nil/></value></member>
    </struct></value></param></params></methodResponse>`) as any;
    expect(s.ok).toBe(true);
    expect([...s.raw]).toEqual([1, 2, 3]);
    expect(s.none).toBeNull();
  });
  test("fault throws XmlRpcFault", () => {
    const xml = `<methodResponse><fault><value><struct>
      <member><name>faultCode</name><value><i4>-501</i4></value></member>
      <member><name>faultString</name><value><string>Could not create download, the input is not a valid torrent.</string></value></member>
    </struct></value></fault></methodResponse>`;
    expect(() => decodeResponse(xml)).toThrow(XmlRpcFault);
    try { decodeResponse(xml); } catch (e: any) { expect(e.code).toBe(-501); expect(e.fault).toContain("not a valid torrent"); }
  });
  test("garbage is rejected", () => {
    expect(() => decodeResponse("<html>login</html>")).toThrow(/XMLRPC_BAD_RESPONSE/);
  });
});

describe("bencode", () => {
  const info = "d6:lengthi1000e4:name8:TestGame12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe";
  const torrent = new TextEncoder().encode(`d8:announce13:http://tr/ann4:info${info}e`);
  test("single-file torrent: info-hash is sha1 of the raw info dict", () => {
    const expected = new Bun.CryptoHasher("sha1").update(new TextEncoder().encode(info)).digest("hex").toUpperCase();
    const m = parseTorrent(torrent);
    expect(m.infoHash).toBe(expected);
    expect(m).toMatchObject({ name: "TestGame", length: 1000, multiFile: false, files: 1 });
  });
  test("multi-file torrent sums lengths", () => {
    const multi = new TextEncoder().encode("d4:infod5:filesld6:lengthi600e4:pathl1:aeed6:lengthi400e4:pathl1:beee4:name3:Dir12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAee");
    expect(parseTorrent(multi)).toMatchObject({ name: "Dir", length: 1000, multiFile: true, files: 2 });
  });
  test("non-torrent bytes throw", () => {
    expect(() => parseTorrent(new TextEncoder().encode("<html>"))).toThrow(/BENCODE/);
    expect(() => parseTorrent(new TextEncoder().encode("d3:fooi1ee"))).toThrow(/NO_INFO_DICT/);
  });
  test("magnet: hex and base32 btih, dn", () => {
    const hex = "C12FE1C06BB254887BAC6E25F7CE1CE2A3DEE4E8";
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex.toLowerCase()}&dn=Hades`)).toEqual({ infoHash: hex, name: "Hades" });
    const b32 = "YEX6DQDLWJKIQ65MNYS7PTQ44KR55ZHI";   // python: base64.b32encode(bytes.fromhex(hex))
    expect(base32ToHex(b32)).toBe(hex);
    expect(parseMagnet(`magnet:?xt=urn:btih:${b32}`)?.infoHash).toBe(hex);
    expect(parseMagnet("http://not-a-magnet")).toBeNull();
  });
});
