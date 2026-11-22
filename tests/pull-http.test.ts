import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpPull, PART_EXT, type HttpSource } from "../src/pull-http";
import { fileResponse, listDir, statPath } from "../src/bosun/fs";

const remote = mkdtempSync(join(tmpdir(), "ahoy-remote-"));
const local = mkdtempSync(join(tmpdir(), "ahoy-local-"));
const rnd = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
writeFileSync(join(remote, "game.bin"), rnd(1_000_000));
mkdirSync(join(remote, "Pack", "sub"), { recursive: true });
writeFileSync(join(remote, "Pack", "a.bin"), rnd(300_000));
writeFileSync(join(remote, "Pack", "sub", "b.bin"), rnd(70_000));
writeFileSync(join(remote, "Pack", "empty"), "");
const sha = (p: string) => new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");

let ignoreRange = false;
let refuse: { re: RegExp; status: number } | null = null;        // paths the server will not serve (a rule against hidden files)
let requests: { path: string; range: string | null }[] = [];
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname.replace(/^\/files\//, ""));
    requests.push({ path: rel, range: req.headers.get("range") });
    if (refuse?.re.test(rel)) return new Response("no", { status: refuse.status });
    const p = join(remote, rel);
    if (!existsSync(p)) return new Response("nope", { status: 404 });
    if (ignoreRange) return new Response(readFileSync(p), { status: 200 });      // a plain body: Bun.serve would honour Range for a Bun.file body by itself
    return fileResponse(req, p);
  },
});
afterAll(() => server.stop(true));

const src: HttpSource = {
  stat: async p => { const s = await statPath(join(remote, p)); return { size: s.size, isDir: s.isDir }; },
  list: p => listDir(join(remote, p)),
  request: async p => ({ url: `http://127.0.0.1:${server.port}/files/${p.split("/").map(encodeURIComponent).join("/")}`, headers: { "x-test": "1" } }),
};
const opts = (over: Partial<Parameters<typeof startHttpPull>[2]> = {}) => ({ downloadsDir: local, segments: 4, minSegmentBytes: 64 * 1024, retries: 2, sleep: async () => {}, ...over });

beforeEach(() => { ignoreRange = false; refuse = null; requests = []; rmSync(local, { recursive: true, force: true }); mkdirSync(local); });

describe("http pull", () => {
  test("single file: 4 segments, bytes identical, sidecar gone, progress 1", async () => {
    const h = startHttpPull({ remotePath: "game.bin", isDir: false, expectedBytes: 1_000_000 }, src, opts());
    const res = await h.done;
    expect(res).toMatchObject({ ok: true, localPath: join(local, "game.bin"), bytes: 1_000_000 });
    expect(sha(join(local, "game.bin"))).toBe(sha(join(remote, "game.bin")));
    expect(existsSync(join(local, "game.bin") + PART_EXT)).toBe(false);
    expect(h.progress()).toBe(1);
    const ranges = requests.map(r => r.range);
    expect(ranges).toHaveLength(4);
    expect(ranges).toContain("bytes=0-249999");
    expect(ranges).toContain("bytes=750000-999999");
  });
  test("directory: mirrored recursively, empty files included, second run skips everything", async () => {
    const res = await startHttpPull({ remotePath: "Pack", isDir: true, expectedBytes: 370_000 }, src, opts()).done;
    expect(res.ok).toBe(true);
    expect(res.bytes).toBe(370_000);
    for (const f of ["a.bin", "sub/b.bin"]) expect(sha(join(local, "Pack", f))).toBe(sha(join(remote, "Pack", f)));
    expect(readFileSync(join(local, "Pack", "empty")).length).toBe(0);
    requests = [];
    const again = await startHttpPull({ remotePath: "Pack", isDir: true, expectedBytes: 370_000 }, src, opts()).done;
    expect(again).toMatchObject({ ok: true, bytes: 370_000 });
    expect(requests).toHaveLength(0);
  });
  test("a segment whose connection dies is retried from where it stopped", async () => {
    let tripped = false;
    const flaky: typeof fetch = (async (url: any, init?: RequestInit) => {
      const res = await fetch(url, init);
      const range = (init?.headers as Record<string, string>)?.range ?? "";
      if (!tripped && /^bytes=[1-9]/.test(range)) {
        tripped = true;
        const reader = res.body!.getReader();
        const first = (await reader.read()).value!;
        await reader.cancel();
        let pulls = 0;
        return new Response(new ReadableStream({ pull(c) { if (pulls++ === 0) c.enqueue(first.subarray(0, 1000)); else c.error(new Error("boom")); } }), { status: res.status, headers: res.headers });
      }
      return res;
    }) as typeof fetch;
    const res = await startHttpPull({ remotePath: "game.bin", isDir: false, expectedBytes: 1_000_000 }, src, opts({ fetchImpl: flaky })).done;
    expect(res.ok).toBe(true);
    expect(sha(join(local, "game.bin"))).toBe(sha(join(remote, "game.bin")));
    expect(tripped).toBe(true);
    const resumed = requests.filter(r => r.range && !/^bytes=(0|250000|500000|750000)-/.test(r.range));
    expect(resumed).toHaveLength(1);                       // exactly one retry, at offset+1000
    expect(resumed[0].range).toMatch(/^bytes=(251000|501000|751000)-/);
  });
  test("cancel keeps the sidecar; the next run resumes instead of restarting", async () => {
    const slow: typeof fetch = (async (url: any, init?: RequestInit) => {
      const res = await fetch(url, init);
      const paced = res.body!.pipeThrough(new TransformStream({ async transform(chunk, c) {
        for (let i = 0; i < chunk.length; i += 4096) { c.enqueue(chunk.subarray(i, i + 4096)); await Bun.sleep(3); }
      } }));
      return new Response(paced, { status: res.status, headers: res.headers });
    }) as typeof fetch;
    const h = startHttpPull({ remotePath: "game.bin", isDir: false, expectedBytes: 1_000_000 }, src, opts({ fetchImpl: slow }));
    while (h.bytes() < 20_000) await Bun.sleep(10);
    h.cancel();
    const res = await h.done;
    expect(res).toMatchObject({ ok: false, error: "cancelled" });
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.bytes).toBeLessThan(1_000_000);
    const part = JSON.parse(readFileSync(join(local, "game.bin") + PART_EXT, "utf8"));
    expect(part.size).toBe(1_000_000);
    expect(part.segs.reduce((a: number, s: any) => a + s.done, 0)).toBe(res.bytes);
    requests = [];
    const res2 = await startHttpPull({ remotePath: "game.bin", isDir: false, expectedBytes: 1_000_000 }, src, opts()).done;
    expect(res2.ok).toBe(true);
    expect(sha(join(local, "game.bin"))).toBe(sha(join(remote, "game.bin")));
    expect(requests.some(r => r.range && !/^bytes=(0|250000|500000|750000)-/.test(r.range))).toBe(true);   // at least one segment resumed mid-way
    expect(existsSync(join(local, "game.bin") + PART_EXT)).toBe(false);
  });
  test("a server that ignores Range fails fast with segments, works with one", async () => {
    ignoreRange = true;
    const res = await startHttpPull({ remotePath: "game.bin", isDir: false, expectedBytes: 1_000_000 }, src, opts({ retries: 0 })).done;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ignored Range/);
    const res2 = await startHttpPull({ remotePath: "game.bin", isDir: false, expectedBytes: 1_000_000 }, src, opts({ segments: 1 })).done;
    expect(res2.ok).toBe(true);
    expect(sha(join(local, "game.bin"))).toBe(sha(join(remote, "game.bin")));
  });
  test("missing remote file → failed with the status", async () => {
    const res = await startHttpPull({ remotePath: "nope.bin", isDir: false, expectedBytes: 1 }, src, opts({ retries: 0 })).done;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ENOENT|no such|404/i);
  });
});

describe("review 2026-11-10: a listing cannot write outside the download, and a short torrent is no finished transfer", () => {
  test("an entry name that leaves the folder fails the pull: nothing is fetched, nothing written outside", async () => {
    for (const bad of ["../escaped.bin", "..", "a/../../b", "..\\escaped.bin"]) {
      const evil: HttpSource = { ...src, list: async () => [{ name: "ok.bin", size: 3, isDir: false }, { name: bad, size: 3, isDir: false }] };
      requests = [];
      const res = await startHttpPull({ remotePath: "Pack", isDir: true, expectedBytes: 6 }, evil, opts()).done;
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/is no file name/);
      expect(requests).toHaveLength(0);
      expect(existsSync(join(local, "escaped.bin"))).toBe(false);
      expect(existsSync(join(local, "..", "escaped.bin"))).toBe(false);
    }
  });
  test("a remote path that names no folder of its own lands in a folder of its own, never the downloads folder itself", async () => {
    for (const p of ["/", "", "/home/me/..", "."]) {
      const h = startHttpPull({ remotePath: p, isDir: true, expectedBytes: 0 }, { ...src, list: async () => [] }, opts());
      expect(h.localPath).toBe(join(local, "download"));
      await h.done;
    }
  });
  test("a torrent whose listing shows fewer bytes than its client has fails; without an exact size it passes as before", async () => {
    const short = await startHttpPull({ remotePath: "Pack", isDir: true, expectedBytes: 400_000, exact: true }, src, opts()).done;
    expect(short.ok).toBe(false);
    expect(short.error).toMatch(/fetched 370000 of the 400000 bytes/);
    expect((await startHttpPull({ remotePath: "Pack", isDir: true, expectedBytes: 370_000, exact: true }, src, opts()).done).ok).toBe(true);
    expect((await startHttpPull({ remotePath: "Pack", isDir: true, expectedBytes: 400_000 }, src, opts()).done).ok).toBe(true);   // usenet: the client's size is no file size
  });
});

describe("review 2026-11-10: a web listing hides entries, so a torrent's own files are asked for by path", () => {
  // a Steam rip as it lies on the box: two files a web index shows, and what it never lists — a folder whose name starts
  // with a dot (nginx, Apache's stock IndexIgnore) and a README (Apache's stock IndexIgnore). The server serves them all.
  mkdirSync(join(remote, "Rip", ".DepotDownloader"), { recursive: true });
  writeFileSync(join(remote, "Rip", "game.exe"), rnd(5_000));
  writeFileSync(join(remote, "Rip", "data.pak"), rnd(20_000));
  writeFileSync(join(remote, "Rip", ".DepotDownloader", "depot.config"), rnd(37));
  writeFileSync(join(remote, "Rip", "README.txt"), rnd(11));
  const SHOWN = 25_000, ALL = 25_048;
  const index: HttpSource = { ...src, list: async p => (await src.list(p)).filter(e => !e.name.startsWith(".") && !e.name.startsWith("README")) };
  const client = [{ path: "game.exe", size: 5_000 }, { path: "data.pak", size: 20_000 }, { path: ".DepotDownloader/depot.config", size: 37 }, { path: "README.txt", size: 11 }];
  const rip = (over: Partial<Parameters<typeof startHttpPull>[0]> = {}) => startHttpPull({ remotePath: "Rip", isDir: true, expectedBytes: ALL, exact: true, files: async () => client, ...over }, index, opts()).done;

  test("what the listing leaves out is fetched by its path, and the torrent is whole", async () => {
    const res = await rip();
    expect(res).toMatchObject({ ok: true, localPath: join(local, "Rip"), bytes: ALL });
    for (const f of ["game.exe", "data.pak", ".DepotDownloader/depot.config", "README.txt"]) expect(sha(join(local, "Rip", f))).toBe(sha(join(remote, "Rip", f)));
    expect(requests.map(r => r.path)).toContain("Rip/.DepotDownloader/depot.config");
    expect(existsSync(join(local, "Rip", ".DepotDownloader", "depot.config") + PART_EXT)).toBe(false);
    requests = [];
    expect((await rip()).ok).toBe(true);                                      // a second run finds everything here
    expect(requests).toHaveLength(0);
  });
  test("a client that cannot say what the torrent holds (or does not answer): the short listing fails as before", async () => {
    for (const files of [undefined, async () => { throw new Error("rTorrent did not answer"); }, async () => []]) {
      const res = await rip({ files });
      expect(res.ok).toBe(false);
      expect(res.error).toBe(`the transfer fetched ${SHOWN} of the ${ALL} bytes the client has: the file listing leaves some of the download out`);
      expect(existsSync(join(local, "Rip", ".DepotDownloader"))).toBe(false);
    }
  });
  test("a hidden file the server will not serve either ends the transfer in words that name it", async () => {
    for (const status of [403, 404]) {
      refuse = { re: /(^|\/)\./, status };
      const res = await rip();
      expect(res.ok).toBe(false);
      expect(res.error).toBe(`the file listing does not show .DepotDownloader/depot.config and the server does not serve it either (HTTP ${status}): this download cannot be fetched whole over the Transfer URL — map the client's folder, or use an sftp:// Transfer URL`);
    }
    // a file with no hidden name that is not there is a file that is missing, said as any other
    refuse = null;
    const res = await rip({ files: async () => [...client, { path: "gone.bin", size: 9 }], expectedBytes: ALL + 9 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^HTTP 404 for Rip\/gone\.bin/);
  });
  test("the client's list is the measure: files it was told not to download are not waited for, a file at another size is still short", async () => {
    refuse = null;
    expect(await rip({ expectedBytes: ALL + 5_000 })).toMatchObject({ ok: true, bytes: ALL });   // the client's total counts a file it does not download
    const other = await rip({ files: async () => client.map(f => (f.path === "game.exe" ? { ...f, size: 6_000 } : f)), expectedBytes: ALL + 1_000 });
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/fetched \d+ of the 26048 bytes the client has/);
  });
  test("a path of the client's that is none inside the download is never fetched", async () => {
    writeFileSync(join(remote, "escaped.bin"), rnd(9));
    for (const bad of ["../escaped.bin", "sub/../../escaped.bin", "./escaped.bin", "..\\escaped.bin", "sub//x"]) {
      requests = [];
      const res = await rip({ files: async () => [...client, { path: bad, size: 9 }], expectedBytes: ALL + 9 });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/fetched 25000 of the 25057 bytes the client has/);
      expect(requests.some(r => /escaped|DepotDownloader/.test(r.path))).toBe(false);   // nothing was asked for by path at all
      expect(existsSync(join(local, "escaped.bin"))).toBe(false);
      expect(existsSync(join(local, "..", "escaped.bin"))).toBe(false);
    }
  });
  test("a single-file torrent has no listing to be short of: the client is not asked", async () => {
    let asked = 0;
    const res = await startHttpPull({ remotePath: "game.bin", isDir: false, expectedBytes: 2_000_000, exact: true, files: async () => { asked++; return [{ path: "game.bin", size: 2_000_000 }]; } }, index, opts()).done;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/fetched 1000000 of the 2000000 bytes/);
    expect(asked).toBe(0);
  });
});
