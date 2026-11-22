/**
 * ludarr — SCGI client for rtorrent's own socket (network.scgi.open_port / open_local).
 *
 *   request:  "<len>:CONTENT_LENGTH\0<n>\0SCGI\x001\0,<body>"     netstring of headers, then the body
 *   response: "Status: 200 OK\r\nContent-Type: text/xml\r\n…\r\n\r\n<xml>"   rtorrent closes when done
 *
 * Only the bosun connector uses this — it runs on the seedbox where the socket is reachable.
 */
import { connect, type Socket } from "node:net";
import type { RtTransport } from "./rtorrent";

export function scgiFrame(body: Uint8Array): Uint8Array {
  const hdr = Buffer.from(`CONTENT_LENGTH\0${body.length}\0SCGI\x001\0`, "latin1");
  return Buffer.concat([Buffer.from(`${hdr.length}:`), hdr, Buffer.from(","), body]);
}

/** Split a raw SCGI response into its header block and body (headers may be absent). */
export function scgiParse(raw: string): { status: string | null; body: string } {
  const i = raw.indexOf("\r\n\r\n");
  if (i < 0) return { status: null, body: raw };
  const status = /^Status:\s*(\d+)/im.exec(raw.slice(0, i))?.[1] ?? null;
  return { status, body: raw.slice(i + 4) };
}

/** target: "host:port" (":port" means localhost) or a unix socket path */
export function scgiRequest(target: string, body: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const m = /^(.*):(\d+)$/.exec(target);
    const sock: Socket = m ? connect(Number(m[2]), m[1] || "127.0.0.1") : connect(target);
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; reject(e); } sock.destroy(); };
    const timer = setTimeout(() => fail(new Error("SCGI_TIMEOUT")), timeoutMs);
    sock.on("connect", () => { sock.write(scgiFrame(Buffer.from(body))); });
    sock.on("data", c => chunks.push(c));
    sock.on("error", e => { clearTimeout(timer); fail(e); });
    sock.on("close", () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return reject(new Error("SCGI_EMPTY_RESPONSE"));
      const { status, body } = scgiParse(raw);
      if (status && status !== "200") return reject(new Error(`RTORRENT_SCGI_${status}`));
      resolve(body);
    });
  });
}

export const scgiTransport = (target: string): RtTransport => body => scgiRequest(target, body);
