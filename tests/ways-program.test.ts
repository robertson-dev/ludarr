import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireProgram, cacheDir, buildsDir, download, evictCache, getCache, prdeps, putCache } from "../src/ways/program";
import { sbdeps } from "../src/ways/sandbox";
import { getPlan, insertPlan, planPinned, wstmts, type PlanRow } from "../src/ways/store";
import { latestRelease, pickRelease } from "../src/catalog/github";
import { ndeps, PublicUrlError } from "../src/net/public-url";
import type { PinnedProgram, RuntimePlanSpec } from "../src/ways/types";
import { bytes, dirLink, fake7z, releaseHost, restoreDeps, sha256, tempConfig, tmp, tools7z, zelda, type Call } from "./ways-fixtures";

const ASSET = "Zelda64Recompiled-v1.2.2-Windows.zip";
const URL_ = `https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v1.2.2/${ASSET}`;
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(5000, 7)]);
const spec = (over: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "Zelda64Recompiled.exe", argv: [] }, content: null, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...over,
});
const release = (o: { digest?: string | null; immutable?: boolean | null; asset?: boolean; size?: number } = {}) => ({
  tag: "v1.2.2", name: "v1.2.2", date: "2026-01-01", prerelease: false, page: "p", immutable: o.immutable ?? true,
  asset: o.asset === false ? null : { name: ASSET, url: URL_, size: o.size ?? ZIP.byteLength, digest: o.digest === undefined ? `sha256:${sha256(ZIP)}` : o.digest },
});
let n = 0;
const plan = (s = spec(), repo = "Zelda64Recomp/Zelda64Recomp"): PlanRow => insertPlan({ name: `Zelda test ${++n}`, kind: "recomp", repo, platforms: ["n64"], spec: s, status: "ready" });
const opts = (lines: string[] = []) => ({ work: tmp("prog-work-"), log: (l: string) => lines.push(l) });

let cfg: ReturnType<typeof tempConfig>;
beforeAll(() => { cfg = tempConfig(); });
afterAll(() => cfg.restore());
let calls: Call[];
beforeEach(() => {
  calls = [];
  prdeps.tools = () => tools7z;
  prdeps.latestRelease = async () => release();
  sbdeps.platform = () => "win32";                                  // no sandbox here: the same environment list, current user
  sbdeps.exec = fake7z({ [ASSET]: zelda }, { calls });
  delete process.env.WAYS_CACHE_GB;
});
afterEach(() => { restoreDeps(); delete process.env.WAYS_CACHE_GB; });

describe("a release program", () => {
  test("unpinned: the newest release's asset, held to GitHub's digest, pinned by the bytes received", async () => {
    const host = releaseHost({ [URL_]: ZIP });
    const p = plan();
    const lines: string[] = [];
    prdeps.latestRelease = async () => release({ immutable: false });
    const r = await acquireProgram(p, opts(lines));
    expect(r.fresh).toBe(true);
    expect(r.pinned).toMatchObject({ tag: "v1.2.2", asset: ASSET, url: URL_, size: ZIP.byteLength, sha256: sha256(ZIP), digest: `sha256:${sha256(ZIP)}`, immutable: false });
    expect(existsSync(join(r.dir, "Zelda64Recompiled", "Zelda64Recompiled.exe"))).toBe(true);
    expect(host.seen).toEqual([URL_]);
    expect(lines.join("\n")).toMatch(/not immutable on GitHub/);
    expect(lines.join("\n")).toMatch(/matches the host's own digest/);
    expect(planPinned(getPlan(p.id)!)).toBeNull();                 // stored by assemble once the way is built, not here
    expect(existsSync(join(cacheDir(), sha256(ZIP)))).toBe(true);   // kept for the next build
    // the unpacking ran through the sandbox's exec, with nothing inherited
    const x = calls.find(c => c.cmd[1] === "x")!;
    expect(x.opts.inheritEnv).toBe(false);
  });

  test("a download that disagrees with GitHub's digest fails, and nothing is kept", async () => {
    releaseHost({ [URL_]: ZIP });
    prdeps.latestRelease = async () => release({ digest: `sha256:${"0".repeat(64)}` });
    await expect(acquireProgram(plan(), opts())).rejects.toThrow(/does not match the sha256 the host lists/);
    // the size the release lists must match too
    prdeps.latestRelease = async () => release({ digest: null, size: 99 });
    await expect(acquireProgram(plan(), opts())).rejects.toThrow(/the release lists 99/);
  });

  test("a pattern that picks nothing fails and marks the plan broken", async () => {
    releaseHost({});
    const p = plan();
    prdeps.latestRelease = async () => release({ asset: false });
    await expect(acquireProgram(p, opts())).rejects.toThrow("the plan's asset pattern picks nothing in v1.2.2");
    expect(getPlan(p.id)).toMatchObject({ status: "broken", status_note: "the plan's asset pattern picks nothing in v1.2.2" });
  });

  test("pinned: the kept copy is used, nothing downloaded; not kept: downloaded and held to the pin; a changed file fails loudly", async () => {
    const host = releaseHost({ [URL_]: ZIP });
    const p = plan();
    const first = await acquireProgram(p, opts());
    wstmts.setPinned.run(JSON.stringify(first.pinned), p.id);
    host.seen.length = 0;
    const again = await acquireProgram(getPlan(p.id)!, opts());
    expect(again.fresh).toBe(false);
    expect(host.seen).toEqual([]);                                  // from the cache
    // the cache lost it: downloaded again and checked against the pin
    const emptyCache = () => { for (const f of readdirSync(cacheDir())) rmSync(join(cacheDir(), f)); };
    emptyCache();
    const third = await acquireProgram(getPlan(p.id)!, opts());
    expect(host.seen).toEqual([URL_]);
    expect(third.pinned.sha256).toBe(first.pinned.sha256);
    // the same tag now serves another file
    emptyCache();
    host.files[URL_] = new Uint8Array([...ZIP, 1]);
    await expect(acquireProgram(getPlan(p.id)!, opts())).rejects.toThrow("the release file changed since it was pinned; check the plan");
    expect(getPlan(p.id)).toMatchObject({ status: "broken" });
    // a repin takes whatever the release has now
    prdeps.latestRelease = async () => ({ ...release({ digest: null, size: ZIP.byteLength + 1 }), tag: "v1.2.3" });
    const re = await acquireProgram(getPlan(p.id)!, { ...opts(), repin: true });
    expect(re).toMatchObject({ fresh: true, pinned: { tag: "v1.2.3", size: ZIP.byteLength + 1 } });
  });

  test("a pinned file gone from its host marks the plan broken", async () => {
    releaseHost({});
    const p = plan();
    const pin: PinnedProgram = { tag: "v1", asset: ASSET, url: URL_, size: 10, sha256: "a".repeat(64), pinnedAt: 1 };
    wstmts.setPinned.run(JSON.stringify(pin), p.id);
    await expect(acquireProgram(getPlan(p.id)!, opts())).rejects.toThrow("the pinned release file is gone from its host; check the plan and repin it");
    expect(getPlan(p.id)!.status).toBe("broken");
  });

  test("GitHub's hourly limit says how to lift it", async () => {
    const { RateLimited } = await import("../src/catalog/github");
    prdeps.latestRelease = async () => { throw new RateLimited("GitHub rate limit (0 left)"); };
    await expect(acquireProgram(plan(), opts())).rejects.toThrow("GitHub's hourly limit: set a GitHub token in Settings → General");
  });
});

describe("other program sources", () => {
  test("a feed (Dolphin): the feed gives no size, the pin is the sha256 taken while downloading", async () => {
    const url = "https://dl.dolphin-emu.org/builds/a1/dolphin-2509-x64.7z";
    const seven = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, ...bytes(800, 3)]);
    releaseHost({ [url]: seven });
    const seen: string[] = [];
    prdeps.latestRelease = async repo => { seen.push(repo); return { tag: "2509", name: "Dolphin 2509", date: null, prerelease: false, page: "p", asset: { name: "dolphin-2509-x64.7z", url, size: 0, digest: null }, immutable: null }; };
    sbdeps.exec = fake7z({ "dolphin-2509-x64.7z": out => { mkdirSync(join(out, "Dolphin-x64"), { recursive: true }); writeFileSync(join(out, "Dolphin-x64", "Dolphin.exe"), "x"); } });
    const r = await acquireProgram(plan(spec({ program: { kind: "feed", feed: "dolphin:beta" } }), "dolphin-emu/dolphin"), opts());
    expect(seen).toEqual(["dolphin:beta"]);
    expect(r.pinned).toMatchObject({ tag: "2509", size: seven.byteLength, sha256: sha256(seven), digest: null });
  });

  test("a fixed url: the file must be the one the plan names", async () => {
    const url = "https://example.com/files/port-1.0-win64.zip";
    releaseHost({ [url]: ZIP });
    sbdeps.exec = fake7z({ "port-1.0-win64.zip": zelda });
    await expect(acquireProgram(plan(spec({ program: { kind: "url", url, sha256: "b".repeat(64) } })), opts())).rejects.toThrow(/not the one it names/);
    const r = await acquireProgram(plan(spec({ program: { kind: "url", url, sha256: sha256(ZIP) } })), opts());
    expect(r.pinned).toMatchObject({ tag: "url", asset: "port-1.0-win64.zip", sha256: sha256(ZIP) });
  });

  test("a source plan needs its build (the build job's), and the build must be the pinned one", async () => {
    const s = spec({ program: { kind: "source", ref: "v1", steps: ["make"], artifact: "build/win", content: "none" } });
    const p = plan(s, "owner/port");
    await expect(acquireProgram(p, opts())).rejects.toThrow("needs a build (the build job runs the plan's recorded steps)");
    const tar = new Uint8Array([...bytes(600, 4)]);
    wstmts.setPinned.run(JSON.stringify({ tag: "v1@abc", asset: "port-abc.tar", url: "build:v1", size: tar.byteLength, sha256: sha256(tar), pinnedAt: 1 }), p.id);
    await expect(acquireProgram(getPlan(p.id)!, opts())).rejects.toThrow("needs a build");
    mkdirSync(buildsDir(), { recursive: true });
    writeFileSync(join(buildsDir(), "port-abc.tar"), tar);
    sbdeps.exec = fake7z({ "port-abc.tar": out => writeFileSync(join(out, "port.exe"), "x") });
    const r = await acquireProgram(getPlan(p.id)!, opts());
    expect(existsSync(join(r.dir, "port.exe"))).toBe(true);
    writeFileSync(join(buildsDir(), "port-abc.tar"), new Uint8Array([...tar, 9]));
    await expect(acquireProgram(getPlan(p.id)!, opts())).rejects.toThrow(/not the one pinned/);
    // a build that needs the game file belongs to one way, never to the plan's shared builds
    const perWay = plan(spec({ program: { kind: "source", ref: "v1", steps: ["make {content}"], artifact: "build", content: "build" }, content: { kind: "rom", platform: "n64", what: "x", search: ["x"], accept: { hashes: [] }, normalize: null, place: "baserom.us.z64" } }), "sm64pc/sm64ex");
    wstmts.setPinned.run(JSON.stringify({ tag: "v1@abc", asset: "port-abc.tar", url: "build:v1", size: tar.byteLength, sha256: sha256(tar), pinnedAt: 1 }), perWay.id);
    await expect(acquireProgram(getPlan(perWay.id)!, opts())).rejects.toThrow("needs a build for this game");
  });
});

describe("unpacking", () => {
  const exeRelease = (name: string) => ({ ...release({ digest: null }), asset: { name, url: `https://github.com/o/r/releases/download/v1/${name}`, size: 0, digest: null } });
  test("an installer is refused unless the plan's setup runs it; a self-extracting exe is unpacked; a plain exe is copied as it is", async () => {
    const nsis = new Uint8Array([...new TextEncoder().encode("MZ\0\0 Nullsoft Install System v3.10 "), ...bytes(2000)]);
    const plain = new Uint8Array([...new TextEncoder().encode("MZ\0\0 a port "), ...bytes(2000)]);
    const sfx = new Uint8Array([...new TextEncoder().encode("MZ\0\0 7-Zip SFX "), ...bytes(2000, 5)]);
    releaseHost({
      "https://github.com/o/r/releases/download/v1/setup.exe": nsis, "https://github.com/o/r/releases/download/v1/port.exe": plain, "https://github.com/o/r/releases/download/v1/port-sfx.exe": sfx,
    });
    sbdeps.exec = fake7z({ "port-sfx.exe": out => writeFileSync(join(out, "game.exe"), "x") }, { types: { "port-sfx.exe": "7z" }, calls });
    prdeps.latestRelease = async () => exeRelease("setup.exe");
    await expect(acquireProgram(plan(spec({ program: { kind: "release", assetPattern: "setup", channel: "stable" } })), opts())).rejects.toThrow("the release is an installer; the plan needs setup steps that run it headless");
    const runs = spec({ program: { kind: "release", assetPattern: "setup", channel: "stable" }, setup: [{ run: { exe: "setup.exe", argv: ["/S"], wine: true, timeoutSec: 60 } }] });
    const inst = await acquireProgram(plan(runs), opts());
    expect(readdirSync(inst.dir)).toEqual(["setup.exe"]);
    prdeps.latestRelease = async () => exeRelease("port-sfx.exe");
    expect(readdirSync((await acquireProgram(plan(), opts())).dir)).toEqual(["game.exe"]);
    prdeps.latestRelease = async () => exeRelease("port.exe");
    calls.length = 0;
    expect(readdirSync((await acquireProgram(plan(), opts())).dir)).toEqual(["port.exe"]);   // 7z reads any exe as "PE": that is not an archive
    expect(calls.some(c => c.cmd.includes("-slt"))).toBe(true);
  });

  test("a program that unpacks to a link (or a hard link) is refused", async () => {
    const outside = tmp("prog-outside-");
    releaseHost({ [URL_]: ZIP });
    sbdeps.exec = fake7z({ [ASSET]: out => { zelda(out); dirLink(outside, join(out, "Zelda64Recompiled", "saves")); } });
    await expect(acquireProgram(plan(), opts())).rejects.toThrow(/the program holds a link \(Zelda64Recompiled\/saves\)/);
    const hard = join(outside, "hard.bin"); writeFileSync(hard, "x");
    sbdeps.exec = fake7z({ [ASSET]: out => { zelda(out); linkSync(hard, join(out, "Zelda64Recompiled", "h.bin")); } });
    await expect(acquireProgram(plan(), opts())).rejects.toThrow(/hard link/);
  });
});

describe("downloads and the cache", () => {
  test("every download goes through publicFetch: a private address or redirect is refused, and so is anything past the cap", async () => {
    ndeps.lookup = async () => [{ address: "192.168.1.20", family: 4 }];
    ndeps.fetch = async () => new Response("secret");
    await expect(download("https://evil.example/x.zip", join(tmp(), "x.zip"), {})).rejects.toThrow(PublicUrlError);
    ndeps.lookup = async (h: string) => [{ address: h === "github.com" ? "140.82.112.3" : "10.0.0.5", family: 4 }];
    ndeps.fetch = async (url: string) => (url.startsWith("https://github.com") ? new Response(null, { status: 302, headers: { location: "https://internal.example/p" } }) : new Response("x"));
    await expect(download("https://github.com/o/r/x.zip", join(tmp(), "x.zip"), {})).rejects.toThrow("not a public address");
    releaseHost({ "https://github.com/big": bytes(5000) });
    await expect(download("https://github.com/big", join(tmp(), "big"), {}, 1000)).rejects.toThrow(/more than/);
    ndeps.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes(800)); c.enqueue(bytes(800)); c.close(); } }));
    const dest = join(tmp(), "streamed");
    await expect(download("https://github.com/stream", dest, {}, 1000)).rejects.toThrow(/more than/);
    expect(existsSync(dest)).toBe(false);                            // a refused download leaves nothing behind
  });

  test("kept downloads: least recently used out first, never the one just kept; WAYS_CACHE_GB 0 keeps none", async () => {
    const dir = tmp("cache-src-");
    /** a kept program under a sha256-shaped name, last used at `at` (seconds) */
    const put = async (name: string, size: number, at: number) => {
      const f = join(dir, name); writeFileSync(f, bytes(size));
      const key = name.repeat(64);
      await putCache(f, key, size, () => {});
      utimesSync(join(cacheDir(), key), at, at);
      return key;
    };
    for (const f of readdirSync(cacheDir())) rmSync(join(cacheDir(), f));
    process.env.WAYS_CACHE_GB = String(3000 / 2 ** 30);                 // room for three 1000-byte programs
    const a = await put("a", 1000, 100), b = await put("b", 1000, 200), c = await put("c", 1000, 300);
    expect(await getCache(a, 1000)).not.toBeNull();                      // a is used: now the most recent
    const d = await put("d", 1000, 400);
    expect(existsSync(join(cacheDir(), b))).toBe(false);                 // b was the least recently used
    for (const x of [a, c, d]) expect(existsSync(join(cacheDir(), x))).toBe(true);
    expect(await getCache(c, 999)).toBeNull();                           // the wrong size is not the file
    await evictCache(0);
    expect(readdirSync(cacheDir()).filter(f => !f.startsWith("."))).toEqual([]);
    process.env.WAYS_CACHE_GB = "0";
    const f = join(dir, "e"); writeFileSync(f, "x");
    await putCache(f, "e".repeat(64), 1, () => {});
    expect(existsSync(join(cacheDir(), "e".repeat(64)))).toBe(false);
    expect(statSync(cacheDir()).isDirectory()).toBe(true);
  });
});

describe("release lookup", () => {
  const gh = (assets: any[], immutable?: boolean) => [{ tag_name: "v1.2.2", name: "v1.2.2", published_at: "2026-01-01", prerelease: false, draft: false, html_url: "h", assets, ...(immutable === undefined ? {} : { immutable }) }];
  test("GitHub's asset digest and immutable flag come through", () => {
    const r = pickRelease(gh([{ name: ASSET, browser_download_url: URL_, size: 10, digest: "sha256:abc" }], true), "Windows");
    expect(r).toMatchObject({ immutable: true, asset: { name: ASSET, digest: "sha256:abc" } });
    expect(pickRelease(gh([{ name: ASSET, browser_download_url: URL_, size: 10 }]), "Windows")).toMatchObject({ immutable: null, asset: { digest: null } });
  });
  test("a forgejo host is a typed address: it must be public, and so must every redirect", async () => {
    const asked: string[] = [];
    const f = (async (url: string) => { asked.push(url); return new Response("[]"); }) as unknown as typeof fetch;
    await expect(latestRelease("forgejo:192.168.1.20:9696/x/y", null, "stable", f)).rejects.toThrow(PublicUrlError);
    await expect(latestRelease("forgejo:169.254.169.254/x/y", null, "stable", f)).rejects.toThrow(PublicUrlError);
    expect(asked).toEqual([]);                                           // refused before any request
    ndeps.lookup = async (h: string) => [{ address: h === "codeberg.org" ? "217.197.91.145" : "10.1.1.1", family: 4 }];
    const redirecting = (async (url: string) => { asked.push(url); return new Response(null, { status: 302, headers: { location: "https://internal.lan.example/api" } }); }) as unknown as typeof fetch;
    await expect(latestRelease("forgejo:codeberg.org/o/r", null, "stable", redirecting)).rejects.toThrow("not a public address");
    expect(asked).toEqual(["https://codeberg.org/api/v1/repos/o/r/releases/latest"]);
  });
});
