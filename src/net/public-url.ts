/**
 * ludarr — fetching an address someone typed (an art link, a release on a forgejo host, a file the AI wants) without
 * letting it reach this machine's own network: every address the host name resolves to must be public, and so must
 * every redirect's target. One implementation for every such fetch (art, catalog/github.ts for forgejo hosts, the
 * construct agent's fetch/download tools), so there is one place to audit.
 *
 * The name is resolved once. The request then goes to an address that was checked (pinnedFetch), never to the name: a
 * name looked up a second time by the runtime may answer differently (a short-lived record that says a public address
 * first and 192.168.x.x next), and the check would have been of another address than the one connected to. That takes a
 * runtime whose fetch can do it (src/net/pin-check.ts asks once); one that cannot fetches by name, as this always did.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { logger } from "../log";
import { pinCheck } from "./pin-check";

const log = logger("Net");
export class PublicUrlError extends Error {}

/** an address a name resolved to */
export interface Addr { address: string; family: number }
/** a request with the addresses its host was checked at: the connection goes to one of them and nowhere else */
export type PinnedInit = RequestInit & { pin?: Addr[] };

let pinnable: Promise<boolean> | null = null;

/** swapped in tests (no network): name resolution, the request, and the connection the real request makes */
export const ndeps = {
  lookup: async (host: string): Promise<Addr[]> => lookup(host, { all: true, verbatim: true }),
  /** the request itself: sent to a checked address of its host (`pin`, or looked up and checked here), redirects never followed */
  fetch: (url: string, init?: PinnedInit): Promise<Response> => pinnedFetch(url, init),
  /** the runtime's fetch, as pinnedFetch calls it: an address in the host's place, the name kept for Host and TLS */
  connect: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
  /** can this runtime send a request to an address under its host's name? Asked once per process, and said when not */
  canPin: (): Promise<boolean> => (pinnable ??= pinCheck().then(ok => {
    if (!ok) ndeps.warn("this runtime's fetch cannot be sent to a checked address under the host's name: addresses are checked, then fetched by name (a name that changes its answer in between is not caught)");
    return ok;
  })),
  warn: (line: string): void => log.warn(line),
};

function v4Parts(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every(n => n >= 0 && n <= 255) ? p : null;
}

function v4Public(p: number[]): boolean {
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;                        // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false;                         // carrier-grade NAT
  if (a === 169 && b === 254) return false;                                   // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;                          // private
  if (a === 192 && b === 168) return false;                                   // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;             // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;                        // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false;                      // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;                       // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;                        // TEST-NET-3
  if (a >= 224) return false;                                                 // multicast, reserved, broadcast
  return true;
}

/** eight 16-bit groups, or null when it is not an IPv6 address */
function v6Groups(ip: string): number[] | null {
  let s = ip.split("%")[0].toLowerCase().replace(/^\[|\]$/g, "");
  let v4: number[] | null = null;
  const m = s.match(/^(.*):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) { v4 = v4Parts(m[2]); if (!v4) return null; s = `${m[1]}:0:0`; }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":").map(x => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)) : []);
  const a = parse(halves[0]), b = halves.length === 2 ? parse(halves[1]) : [];
  if ([...a, ...b].some(n => Number.isNaN(n))) return null;
  let g: number[];
  if (halves.length === 1) { if (a.length !== 8) return null; g = a; }
  else { const fill = 8 - a.length - b.length; if (fill < 1) return null; g = [...a, ...new Array(fill).fill(0), ...b]; }
  if (v4) { g[6] = (v4[0] << 8) | v4[1]; g[7] = (v4[2] << 8) | v4[3]; }
  return g;
}
const v4Of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/** may a fetch go to this address? false for loopback, private, link-local, unique-local, multicast, documentation and
 *  reserved ranges, and for IPv6 forms that embed such an IPv4 address (mapped, compatible, NAT64, 6to4) */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0]);
  if (kind === 4) { const p = v4Parts(ip); return !!p && v4Public(p); }
  if (kind !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  if (g.every(x => x === 0)) return false;                                                   // ::
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4Public(v4Of(g[6], g[7]));  // ::ffff:a.b.c.d, ::a.b.c.d, ::1
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4Public(v4Of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4Public(v4Of(g[1], g[2]));                                    // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false;                                              // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false;                                              // link-local
  if ((g[0] & 0xff00) === 0xff00) return false;                                              // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;                                      // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every(x => x === 0)) return false;                    // discard-only
  return true;
}

/**
 * The URL parsed, once its host is known to be public: https only (http when allowed), no login in the address, and every
 * address the name resolves to public (one private answer is enough to refuse).
 */
export async function assertPublicUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<URL> {
  return (await checkedUrl(raw, opts)).url;
}

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "");

/** the addresses a name resolves to, every one of them public (one private answer is enough to refuse) */
async function publicAddrs(host: string): Promise<Addr[]> {
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw new PublicUrlError(`${host} is a local name`);
  let addrs: Addr[];
  try { addrs = await ndeps.lookup(host); } catch { throw new PublicUrlError(`${host} does not resolve`); }
  if (!addrs.length) throw new PublicUrlError(`${host} does not resolve`);
  const bad = addrs.find(a => !isPublicIp(a.address));
  if (bad) throw new PublicUrlError(`${host} resolves to ${bad.address}, which is not a public address`);
  return addrs;
}

/** assertPublicUrl, with the addresses the check was made of (none for an address written as numbers): what the request
 *  is then pinned to */
export async function checkedUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<{ url: URL; addrs: Addr[] }> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new PublicUrlError(`not an address: ${String(raw).slice(0, 80)}`); }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) throw new PublicUrlError(`only ${opts.allowHttp ? "http(s)" : "https"} addresses are fetched`);
  if (u.username || u.password) throw new PublicUrlError("an address with a login in it is not fetched");
  const host = bare(u.hostname);
  if (!host) throw new PublicUrlError("the address has no host");
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new PublicUrlError(`${host} is not a public address`);
    return { url: u, addrs: [] };
  }
  return { url: u, addrs: await publicAddrs(host) };
}

/** how many of a name's addresses a request tries before it gives up */
const PIN_TRIES = 4;

/**
 * One request, sent to an address that was checked and to no other: the URL goes out with that address in the host's
 * place, the name still in the Host header and (https) as the TLS server name, so the certificate is the name's. `pin`
 * is what the caller's check resolved; without it the name is resolved and checked here, so this alone never connects to
 * an address nobody looked at. IPv4 first (a container often has no IPv6 route), the next address when one cannot be
 * reached (a request that changes nothing only: GET, HEAD). A redirect is never followed: publicFetch does that by hand,
 * checking each target. On a runtime that cannot send such a request (ndeps.canPin) it goes by name, after the check.
 */
export async function pinnedFetch(raw: string, init: PinnedInit = {}): Promise<Response> {
  const { pin, ...rest } = init;
  const u = new URL(raw);
  const host = bare(u.hostname);
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new PublicUrlError(`${host} is not a public address`);
    return ndeps.connect(u.toString(), { ...rest, redirect: "manual" });
  }
  const seen = new Set<string>();
  const addrs = (pin?.length ? pin : await publicAddrs(host)).filter(a => !seen.has(a.address) && !!seen.add(a.address));
  if (!(await ndeps.canPin())) return ndeps.connect(u.toString(), { ...rest, redirect: "manual" });
  const v6 = (a: Addr) => a.family === 6 || a.address.includes(":");
  const order = [...addrs.filter(a => !v6(a)), ...addrs.filter(v6)].slice(0, PIN_TRIES);
  const headers = new Headers(rest.headers);
  headers.set("host", u.host);
  const again = /^(GET|HEAD)$/i.test(rest.method ?? "GET");
  for (let i = 0; ; i++) {
    const a = order[i];
    const at = new URL(u.toString());
    at.hostname = v6(a) ? `[${bare(a.address)}]` : a.address;
    const tls = u.protocol === "https:" ? { tls: { ...((rest as { tls?: object }).tls ?? {}), serverName: host } } : {};
    try {
      const res = await ndeps.connect(at.toString(), { ...rest, headers, redirect: "manual", ...tls } as RequestInit);
      try { Object.defineProperty(res, "url", { value: u.toString(), configurable: true }); } catch { /* it keeps the numbers */ }
      return res;
    } catch (e) {
      if (!again || i >= order.length - 1 || rest.signal?.aborted) throw e;
    }
  }
}

/** fetch with redirects followed by hand (at most `maxRedirects`, default 3), each target checked like the first */
export async function publicFetch(raw: string, opts: { allowHttp?: boolean; maxRedirects?: number; headers?: Record<string, string>; signal?: AbortSignal; method?: string } = {}): Promise<Response> {
  let url = raw;
  const max = opts.maxRedirects ?? 3;
  for (let hop = 0; ; hop++) {
    const { url: u, addrs } = await checkedUrl(url, opts);
    const res = await ndeps.fetch(u.toString(), { method: opts.method ?? "GET", headers: opts.headers, signal: opts.signal, redirect: "manual", pin: addrs });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= max) throw new PublicUrlError(`more than ${max} redirects`);
      url = new URL(res.headers.get("location")!, u).toString();
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      continue;
    }
    return res;
  }
}

/** the body, refused once it passes `maxBytes` (the Content-Length is checked first when the server sends one) */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(len) && len > maxBytes) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new PublicUrlError(`larger than ${Math.round(maxBytes / 1048576)} MB`); }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new PublicUrlError(`larger than ${Math.round(maxBytes / 1048576)} MB`); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
