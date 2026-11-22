/**
 * ludarr — can this runtime send a request to an address under a host's name?
 *
 * Pinning a request to the address that was checked (src/net/public-url.ts pinnedFetch) asks three things of the
 * runtime's fetch: connect to the number in the URL, send the Host header it is given, and use the TLS server name it is
 * given both to ask for the certificate and to check it. The last one is an option of Bun's fetch that no page documents,
 * so it is not taken on faith: once per process a server on this machine answers one such request, and pinning is used
 * only when it arrived as asked. A runtime that cannot do it keeps fetching by name, as before, and nothing breaks.
 */
import { createServer } from "node:https";

/**
 * A certificate for the name "pin.test" (a reserved test name) and its key, for the one request this file makes to
 * itself. The key protects nothing: it is published here, and the certificate is trusted for that request only.
 */
export const PIN_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBkjCCATigAwIBAgIULR61CRSOKfOwqHMFag9LO/zIwEkwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIcGluLnRlc3QwIBcNMjYxMTEwMTUxMDIyWhgPMjEyNjEwMTcx
NTEwMjJaMBMxETAPBgNVBAMMCHBpbi50ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAERcqBEh/j8fuItKa2Qiwy0S6ihiIvw6ltQYfNLEJC+1XV5c2jZuuGTHzB
FaFMX2GookHdMdHA7ZSrDPxT07ZvyqNoMGYwHQYDVR0OBBYEFILU8d1zH9Q4GUYL
VJxvDGksTUyfMB8GA1UdIwQYMBaAFILU8d1zH9Q4GUYLVJxvDGksTUyfMA8GA1Ud
EwEB/wQFMAMBAf8wEwYDVR0RBAwwCoIIcGluLnRlc3QwCgYIKoZIzj0EAwIDSAAw
RQIgO5eK8ScasjsfpVpXY8tNvqZRZWlcVNmUKnlUUGiSVMsCIQCJHLZpxQJo/aVI
Pg6LiTrSpReOD5BafX8BTCaoWNaNag==
-----END CERTIFICATE-----
`;
export const PIN_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMJGEApcsNtS33Lhg
zp4xkzmaufvXt/PyFHzyTPgg8wKhRANCAARFyoESH+Px+4i0prZCLDLRLqKGIi/D
qW1Bh80sQkL7VdXlzaNm64ZMfMEVoUxfYaiiQd0x0cDtlKsM/FPTtm/K
-----END PRIVATE KEY-----
`;
const NAME = "pin.test";

/**
 * Two requests to a server of this process on 127.0.0.1, written as a pinned request is: the number in the URL, the name
 * in Host and as the TLS server name. True when the first one's server was asked for the name's certificate (SNI), got
 * the name in Host, and the certificate — the name's, not the number's — was accepted; and the second one, sent under
 * another name, was refused (the certificate really is checked against the name given). False on any other outcome, a
 * timeout included.
 */
export async function pinCheck(timeoutMs = 5000): Promise<boolean> {
  let sni: unknown = null, hostHeader: unknown = null;
  const server = createServer({ key: PIN_TEST_KEY, cert: PIN_TEST_CERT }, (req, res) => {
    sni = (req.socket as unknown as { servername?: unknown }).servername ?? null;
    hostHeader = req.headers.host ?? null;
    res.end("pinned");
  });
  try {
    await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => ok()); });
    const at = server.address();
    if (!at || typeof at === "string") return false;
    // Bun.fetch: the runtime's own, also where something has put another function in the global fetch's place
    const ask = (name: string) => Bun.fetch(`https://127.0.0.1:${at.port}/`, {
      headers: { host: `${name}:${at.port}` }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      tls: { serverName: name, ca: PIN_TEST_CERT },
    } as RequestInit);
    const res = await ask(NAME);
    if (!res.ok || (await res.text()) !== "pinned" || sni !== NAME || hostHeader !== `${NAME}:${at.port}`) return false;
    const other = await ask("other.test").then(r => { void r.body?.cancel(); return true; }, () => false);
    return !other;
  } catch { return false; }
  finally {
    // the answer never waits on the server's end: a connection the client keeps open would hold close() back
    try { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* not on this runtime */ }
    await new Promise<void>(done => { try { server.close(() => done()); } catch { done(); } setTimeout(done, 1000).unref?.(); });
  }
}
