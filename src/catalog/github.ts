/**
 * Latest Windows build of a runtime (recomp / port / emulator) from its GitHub releases.
 * Unauthenticated GitHub allows 60 calls an hour per IP; GITHUB_TOKEN lifts that to 5000.
 *
 * A forgejo host is an address someone typed (a plan's repo), so every request to it, and every redirect it answers
 * with, goes through the same public-address check as any other typed address (src/net/public-url.ts). GitHub's own
 * API host and the Dolphin feed are fixed names. The asset's download URL is checked again where it is downloaded.
 */
import { cfg } from "../config";
import { checkedUrl, pinnedFetch, PublicUrlError } from "../net/public-url";
import type { RuntimeRelease } from "./types";

export class RateLimited extends Error {}

/** digest: GitHub's checksum of the asset ("sha256:<hex>"), on assets uploaded since mid-2025 */
interface GhAsset { name: string; browser_download_url: string; size: number; digest?: string | null }
/** immutable: GitHub's immutable-release flag (the assets can no longer be replaced under the same tag) */
interface GhRelease { tag_name: string; name: string | null; published_at: string | null; prerelease: boolean; draft: boolean; html_url: string; assets: GhAsset[]; immutable?: boolean | null }

const WINDOWS = /(win(dows)?|msvc|x64|x86_64|amd64).*\.(zip|7z|exe)$|\.(exe)$/i;
const NOT_WINDOWS = /(linux|macos|darwin|osx|android|ios|appimage|flatpak|\.dmg|\.deb|\.rpm|arm64|aarch64|debug|pdb|symbols|source)/i;

export function pickAsset(assets: GhAsset[], pattern?: string | null): GhAsset | null {
  if (pattern) { const re = new RegExp(pattern, "i"); return assets.find(a => re.test(a.name)) ?? null; }
  return assets.find(a => WINDOWS.test(a.name) && !NOT_WINDOWS.test(a.name)) ?? null;
}

export function pickRelease(list: GhRelease[], pattern?: string | null, channel: string | null = "stable"): RuntimeRelease | null {
  // some repos (RPCS3's binaries) do not list releases newest-first
  const usable = list.filter(r => !r.draft).sort((a, b) => Date.parse(b.published_at ?? "") - Date.parse(a.published_at ?? ""));
  const ordered = channel === "nightly" ? usable : [...usable.filter(r => !r.prerelease), ...usable.filter(r => r.prerelease)];
  const base = (r: GhRelease) => ({ tag: r.tag_name, name: r.name, date: r.published_at, prerelease: r.prerelease, page: r.html_url, immutable: typeof r.immutable === "boolean" ? r.immutable : null });
  for (const r of ordered) {
    const a = pickAsset(r.assets ?? [], pattern);
    if (!a) continue;
    return { ...base(r), asset: { name: a.name, url: a.browser_download_url, size: a.size, digest: typeof a.digest === "string" && a.digest ? a.digest : null } };
  }
  const r = ordered[0];
  return r ? { ...base(r), asset: null } : null;
}

/** "owner/name" → GitHub; "forgejo:host/owner/name" → that Forgejo/Gitea instance (same release JSON shape) */
function apiBase(repo: string): { base: string; github: boolean } {
  const m = /^forgejo:([^/]+)\/(.+)$/.exec(repo);
  return m ? { base: `https://${m[1]}/api/v1/repos/${m[2]}`, github: false } : { base: `https://api.github.com/repos/${repo}`, github: true };
}

/** a request to a typed host: its address must be public, and so must every redirect target; `f` does the request
 *  itself (the catalog worker and the tests hand in their own). The runtime's own fetch would look the name up a second
 *  time and could be answered with another address than the one checked: in its place the request goes to the checked
 *  address (pinnedFetch) */
async function publicGet(f: typeof fetch, url: string, init: RequestInit, maxRedirects = 3): Promise<Response> {
  for (let hop = 0; ; hop++) {
    const { url: u, addrs } = await checkedUrl(url);
    const res = f === fetch ? await pinnedFetch(u.toString(), { ...init, pin: addrs }) : await f(u.toString(), { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    if (hop >= maxRedirects) throw new PublicUrlError(`more than ${maxRedirects} redirects`);
    url = new URL(loc, u).toString();
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
  }
}

export async function latestRelease(repo: string, pattern?: string | null, channel?: string | null, f: typeof fetch = fetch): Promise<RuntimeRelease | null> {
  if (repo.startsWith("dolphin:")) return dolphinRelease(repo.slice(8) || "beta", f);
  const { base, github } = apiBase(repo);
  const token = github ? cfg("GITHUB_TOKEN") : "";
  const get = async (path: string) => {
    const init: RequestInit = {
      headers: { Accept: "application/json", "User-Agent": "ludarr", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(20_000),
    };
    const res = github ? await f(base + path, init) : await publicGet(f, base + path, init);
    if (github && (res.status === 403 || res.status === 429)) throw new RateLimited(`GitHub rate limit (${res.headers.get("x-ratelimit-remaining") ?? "?"} left, resets ${res.headers.get("x-ratelimit-reset") ?? "?"})`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${repo}${path}`);
    return await res.json();
  };
  // stable: the repo's own "latest" release first — busy repos bury it under a page of nightlies
  if (channel !== "nightly") {
    const latest = await get("/releases/latest") as GhRelease | null;
    const pick = latest ? pickRelease([latest], pattern, "stable") : null;
    if (pick?.asset) return pick;
  }
  const list = await get(github ? "/releases?per_page=15" : "/releases?limit=15") as GhRelease[] | null;
  return list ? pickRelease(list, pattern, channel) : null;
}

/** Dolphin publishes its builds through its own update feed: dolphin-emu.org/update/latest/<beta|dev>/ (no size, no digest:
 *  what is downloaded is pinned by the sha256 taken while downloading it) */
export async function dolphinRelease(track: string, f: typeof fetch = fetch): Promise<RuntimeRelease | null> {
  const res = await f(`https://dolphin-emu.org/update/latest/${track}/`, { headers: { "User-Agent": "ludarr", Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the Dolphin update feed`);
  const j = await res.json() as { shortrev?: string; date?: string; changelog_html?: string; artifacts?: { system: string; url: string }[] };
  const win = j.artifacts?.find(a => /windows x64/i.test(a.system));
  if (!j.shortrev) return null;
  return { tag: j.shortrev, name: `Dolphin ${j.shortrev}`, date: j.date ?? null, prerelease: track !== "beta", page: "https://dolphin-emu.org/download/",
    asset: win ? { name: win.url.split("/").pop() ?? "dolphin.7z", url: win.url, size: 0, digest: null } : null, immutable: null };
}
