import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer as createTlsServer } from "node:https";
import { assertPublicUrl, checkedUrl, isPublicIp, ndeps, pinnedFetch, publicFetch, PublicUrlError, readCapped, type PinnedInit } from "../src/net/public-url";
import { PIN_TEST_CERT, PIN_TEST_KEY, pinCheck } from "../src/net/pin-check";
import { latestRelease } from "../src/catalog/github";

const real = { ...ndeps };
afterEach(() => { Object.assign(ndeps, real); });

describe("public addresses", () => {
  test("private, loopback, link-local and reserved IPv4 are refused", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.10"])
      expect([ip, isPublicIp(ip)]).toEqual([ip, false]);
    for (const ip of ["8.8.8.8", "140.82.112.3", "172.32.0.1", "100.128.0.1"]) expect([ip, isPublicIp(ip)]).toEqual([ip, true]);
  });
  test("IPv6: loopback, unique-local, link-local, and forms that embed a private IPv4 are refused", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:192.168.1.1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:c0a8:0101::1", "2001:db8::1", "[::1]"])
      expect([ip, isPublicIp(ip)]).toEqual([ip, false]);
    for (const ip of ["2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:0808:0808::1"]) expect([ip, isPublicIp(ip)]).toEqual([ip, true]);
  });
});

describe("assertPublicUrl", () => {
  test("a public name passes; one private answer is enough to refuse", async () => {
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    expect((await assertPublicUrl("https://github.com/x")).hostname).toBe("github.com");
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }, { address: "192.168.1.20", family: 4 }];
    await expect(assertPublicUrl("https://rebind.example/")).rejects.toThrow(PublicUrlError);
  });
  test("http, logins, local names and private literals are refused", async () => {
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    await expect(assertPublicUrl("http://example.com/")).rejects.toThrow("only https");
    expect((await assertPublicUrl("http://example.com/", { allowHttp: true })).protocol).toBe("http:");
    await expect(assertPublicUrl("https://user:pw@example.com/")).rejects.toThrow("login");
    await expect(assertPublicUrl("https://localhost:7979/")).rejects.toThrow("local name");
    await expect(assertPublicUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow("not a public address");
    await expect(assertPublicUrl("https://[::1]:9696/")).rejects.toThrow("not a public address");
  });
});

describe("publicFetch", () => {
  test("every redirect target is checked like the first", async () => {
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    ndeps.fetch = async (url: string) => (url.startsWith("https://example.com") ? new Response(null, { status: 302, headers: { location: "https://192.168.1.20:9696/api" } }) : new Response("secret"));
    await expect(publicFetch("https://example.com/art.png")).rejects.toThrow("not a public address");
  });
  test("a public chain is followed", async () => {
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    ndeps.fetch = async (url: string) => (url.endsWith("/a") ? new Response(null, { status: 301, headers: { location: "/b" } }) : new Response("ok"));
    expect(await (await publicFetch("https://example.com/a")).text()).toBe("ok");
  });
  test("too many redirects stop", async () => {
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    ndeps.fetch = async () => new Response(null, { status: 302, headers: { location: "/again" } });
    await expect(publicFetch("https://example.com/", { maxRedirects: 2 })).rejects.toThrow("more than 2 redirects");
  });
});

describe("readCapped", () => {
  test("refuses a body over the cap, by header or while streaming", async () => {
    await expect(readCapped(new Response("x".repeat(10), { headers: { "content-length": "10" } }), 5)).rejects.toThrow("larger than");
    await expect(readCapped(new Response("x".repeat(2_000_000)), 1_000_000)).rejects.toThrow("larger than");
    expect((await readCapped(new Response("hello"), 100)).byteLength).toBe(5);
  });
});

/* the check is of an address; the request must go to that address. A name the runtime looks up again can answer
   differently the second time (a record that lives a second: public first, 192.168.x.x next) */
describe("the request goes to the address that was checked", () => {
  beforeEach(() => { ndeps.canPin = async () => true; });                       // what this runtime can do is its own test, below
  /** a name that answers a public address the first time it is asked and this network the second */
  const rebinding = () => {
    let asked = 0;
    ndeps.lookup = async () => (++asked === 1 ? [{ address: "140.82.112.3", family: 4 }] : [{ address: "192.168.1.20", family: 4 }]);
    return () => asked;
  };

  test("publicFetch looks the name up once a hop and hands the request the addresses it checked", async () => {
    const asked = rebinding();
    const sent: { url: string; pin: unknown }[] = [];
    ndeps.fetch = async (url: string, init?: PinnedInit) => { sent.push({ url, pin: init?.pin }); return new Response("ok"); };
    expect(await (await publicFetch("https://rebind.example/art.png")).text()).toBe("ok");
    expect(asked()).toBe(1);                                                    // one lookup: the checked answer is the one used
    expect(sent).toEqual([{ url: "https://rebind.example/art.png", pin: [{ address: "140.82.112.3", family: 4 }] }]);
    expect((await checkedUrl("https://8.8.8.8/x")).addrs).toEqual([]);          // numbers need no lookup
  });

  test("the real request connects to the checked address: the address in the host's place, the name in Host and as the TLS name", async () => {
    const asked = rebinding();
    ndeps.fetch = (url, init) => pinnedFetch(url, init);                        // the real one, whatever another test file left here
    const calls: { url: string; host: string | null; redirect: unknown; serverName: unknown }[] = [];
    ndeps.connect = async (url, init) => {
      calls.push({ url, host: new Headers(init.headers).get("host"), redirect: init.redirect, serverName: (init as { tls?: { serverName?: string } }).tls?.serverName });
      return new Response("ok");
    };
    const res = await publicFetch("https://rebind.example:8443/art.png?size=2", { headers: { Accept: "image/png" } });
    expect(await res.text()).toBe("ok");
    expect(asked()).toBe(1);
    expect(calls).toEqual([{ url: "https://140.82.112.3:8443/art.png?size=2", host: "rebind.example:8443", redirect: "manual", serverName: "rebind.example" }]);
    expect(res.url).toBe("https://rebind.example:8443/art.png?size=2");         // what the caller asked for, not the numbers
    // plain http (where it is allowed) has no TLS name; the Host header still names the host
    calls.length = 0;
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    await publicFetch("http://plain.example/x", { allowHttp: true });
    expect(calls).toEqual([{ url: "http://140.82.112.3/x", host: "plain.example", redirect: "manual", serverName: undefined }]);
  });

  test("a request without checked addresses resolves and checks the name itself: it never connects to an address nobody looked at", async () => {
    let connected = 0;
    ndeps.connect = async () => { connected++; return new Response("secret"); };
    ndeps.lookup = async () => [{ address: "192.168.1.20", family: 4 }];
    await expect(pinnedFetch("https://rebind.example/api")).rejects.toThrow("not a public address");
    await expect(pinnedFetch("https://prowlarr.lan/api")).rejects.toThrow("local name");
    await expect(pinnedFetch("https://192.168.1.20:9696/api")).rejects.toThrow("not a public address");
    expect(connected).toBe(0);
    ndeps.lookup = async () => [{ address: "2606:4700:4700::1111", family: 6 }];
    let url = "";
    ndeps.connect = async u => { url = u; return new Response("ok"); };
    await pinnedFetch("https://six.example/x");
    expect(url).toBe("https://[2606:4700:4700::1111]/x");
  });

  test("IPv4 first, and the next address when one cannot be reached — for a request that changes nothing only", async () => {
    const pin = [{ address: "2606:4700:4700::1111", family: 6 }, { address: "140.82.112.3", family: 4 }, { address: "140.82.112.4", family: 4 }, { address: "140.82.112.3", family: 4 }];
    const tried: string[] = [];
    ndeps.connect = async url => { tried.push(new URL(url).host); if (tried.length < 3) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); return new Response("ok"); };
    expect(await (await pinnedFetch("https://many.example/x", { pin })).text()).toBe("ok");
    expect(tried).toEqual(["140.82.112.3", "140.82.112.4", "[2606:4700:4700::1111]"]);
    tried.length = 0;
    ndeps.connect = async url => { tried.push(new URL(url).host); throw new Error("connect ECONNREFUSED"); };
    await expect(pinnedFetch("https://many.example/x", { pin, method: "POST" })).rejects.toThrow("ECONNREFUSED");
    expect(tried).toEqual(["140.82.112.3"]);
    tried.length = 0;
    const ac = new AbortController(); ac.abort();
    await expect(pinnedFetch("https://many.example/x", { pin, signal: ac.signal })).rejects.toThrow();
    expect(tried).toEqual(["140.82.112.3"]);                                    // a cancelled request does not go on to the next
  });

  test("on the wire: a name that resolves nowhere reaches the pinned server, with the name in Host", async () => {
    const seen: (string | null)[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => { seen.push(req.headers.get("host")); return new Response(`hello ${new URL(req.url).pathname}`); } });
    try {
      ndeps.lookup = async () => { throw new Error("the name must not be looked up again"); };
      const res = await pinnedFetch(`http://pin.test:${server.port}/over/http`, { pin: [{ address: "127.0.0.1", family: 4 }] });
      expect([res.status, await res.text()]).toEqual([200, "hello /over/http"]);
      expect(seen).toEqual([`pin.test:${server.port}`]);
    } finally { await server.stop(true); }
  });

  test("on the wire, https: the certificate is checked against the name, although the connection is to the number", async () => {
    const cert = PIN_TEST_CERT, key = PIN_TEST_KEY;
    const seen: { sni: unknown; host: unknown }[] = [];
    const server = createTlsServer({ key, cert }, (req, res) => { seen.push({ sni: (req.socket as unknown as { servername?: string }).servername, host: req.headers.host }); res.end("over tls"); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    // the test certificate is its own authority: trusted for this connection only
    ndeps.connect = (url, init) => fetch(url, { ...init, tls: { ...(init as { tls?: object }).tls, ca: cert } } as RequestInit);
    try {
      const pin = [{ address: "127.0.0.1", family: 4 }];
      const res = await pinnedFetch(`https://pin.test:${port}/x`, { pin });
      expect([res.status, await res.text()]).toEqual([200, "over tls"]);
      expect(seen).toEqual([{ sni: "pin.test", host: `pin.test:${port}` }]);
      // the same server under another name: its certificate is pin.test's, so the request fails
      await expect(pinnedFetch(`https://other.test:${port}/x`, { pin })).rejects.toThrow();
      expect(seen).toHaveLength(1);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });

  test("a release check on a forgejo host (a typed address) is pinned the same way when the runtime's own fetch does it", async () => {
    const asked = rebinding();
    const calls: { url: string; host: string | null }[] = [];
    ndeps.connect = async (url, init) => {
      calls.push({ url, host: new Headers(init.headers).get("host") });
      return Response.json(url.endsWith("/releases/latest") ? { tag_name: "v1.2", name: "1.2", published_at: "2026-01-01T00:00:00Z", prerelease: false, draft: false, html_url: "https://git.example.org/o/r/releases/v1.2", assets: [{ name: "thing-windows-x64.zip", browser_download_url: "https://git.example.org/o/r/releases/download/v1.2/thing-windows-x64.zip", size: 10 }] } : []);
    };
    const rel = await latestRelease("forgejo:git.example.org/o/r", null, "stable");   // no fetch handed in: the runtime's own
    expect(rel?.tag).toBe("v1.2");
    expect(calls).toEqual([{ url: "https://140.82.112.3/api/v1/repos/o/r/releases/latest", host: "git.example.org" }]);
    expect(asked()).toBe(1);
  });

  test("this runtime can do it: the one request ludarr sends itself arrives under the name, and another name is refused", async () => {
    expect(await pinCheck()).toBe(true);
  });

  test("a runtime that cannot: the address is checked and the request goes by name, as it always did", async () => {
    const calls: { url: string; host: string | null; redirect: unknown; tls: unknown }[] = [];
    ndeps.canPin = async () => false;
    ndeps.fetch = (url, init) => pinnedFetch(url, init);
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    ndeps.connect = async (url, init) => { calls.push({ url, host: new Headers(init.headers).get("host"), redirect: init.redirect, tls: (init as { tls?: unknown }).tls }); return new Response("ok"); };
    expect(await (await publicFetch("https://old.example/x", { headers: { Accept: "text/plain" } })).text()).toBe("ok");
    expect(calls).toEqual([{ url: "https://old.example/x", host: null, redirect: "manual", tls: undefined }]);
    // a private answer is still refused before anything is sent
    ndeps.lookup = async () => [{ address: "192.168.1.20", family: 4 }];
    await expect(publicFetch("https://old.example/x")).rejects.toThrow("not a public address");
    expect(calls).toHaveLength(1);
  });
});
