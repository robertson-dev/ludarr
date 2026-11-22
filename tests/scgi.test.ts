import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { scgiFrame, scgiParse, scgiRequest, scgiTransport } from "../src/scgi";
import { RtorrentClient } from "../src/rtorrent";

/* a minimal SCGI server: parses the netstring, answers like rtorrent would */
const received: string[] = [];
const server = createServer(sock => {
  let buf = Buffer.alloc(0);
  sock.on("data", d => {
    buf = Buffer.concat([buf, d]);
    const colon = buf.indexOf(":");
    if (colon < 0) return;
    const hlen = Number(buf.subarray(0, colon).toString());
    if (buf.length < colon + 1 + hlen + 1) return;
    const headers = buf.subarray(colon + 1, colon + 1 + hlen).toString("latin1").split("\0");
    const clen = Number(headers[headers.indexOf("CONTENT_LENGTH") + 1]);
    const bodyStart = colon + 1 + hlen + 1;
    if (buf.length < bodyStart + clen) return;
    const body = buf.subarray(bodyStart, bodyStart + clen).toString();
    received.push(body);
    const method = /<methodName>([^<]+)<\/methodName>/.exec(body)?.[1];
    const xml = method === "system.client_version"
      ? `<?xml version="1.0"?><methodResponse><params><param><value><string>0.9.8</string></value></param></params></methodResponse>`
      : `<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>-501</int></value></member><member><name>faultString</name><value><string>Could not find method</string></value></member></struct></value></fault></methodResponse>`;
    sock.end(`Status: 200 OK\r\nContent-Type: text/xml\r\nContent-Length: ${Buffer.byteLength(xml)}\r\n\r\n${xml}`);
  });
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
afterAll(() => server.close());

describe("scgi", () => {
  test("frames a netstring header + body", () => {
    expect(Buffer.from(scgiFrame(Buffer.from("abc"))).toString("latin1")).toBe("24:CONTENT_LENGTH\x003\x00SCGI\x001\x00,abc");
  });
  test("parses status + body, with or without headers", () => {
    expect(scgiParse("Status: 200 OK\r\nX: y\r\n\r\n<a/>")).toEqual({ status: "200", body: "<a/>" });
    expect(scgiParse("<a/>")).toEqual({ status: null, body: "<a/>" });
  });
  test("round-trips through a socket into the rtorrent client", async () => {
    const rt = new RtorrentClient(fetch, scgiTransport(`127.0.0.1:${port}`));
    expect(rt.configured()).toBe(true);
    expect(await rt.version()).toBe("0.9.8");
    expect(received.at(-1)).toContain("system.client_version");
    await expect(rt.call("nope")).rejects.toThrow(/Could not find method/);
  });
  test("connection refused surfaces as an error, not a hang", async () => {
    await expect(scgiRequest("127.0.0.1:1", "<x/>", 2000)).rejects.toThrow();
  });
});
