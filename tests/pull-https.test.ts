import { describe, expect, test } from "bun:test";
import { autoindexEntries, httpsSource } from "../src/pull-https";

const NGINX = `<html><head><title>Index of /user/downloads/</title></head><body><h1>Index of /user/downloads/</h1><hr><pre><a href="../">../</a>
<a href="Game%20Dir/">Game Dir/</a>                                           17-Oct-2026 10:00                   -
<a href="game.iso">game.iso</a>                                            17-Oct-2026 10:01          5368709120
<a href="notes.txt">notes.txt</a>                                           17-Oct-2026 10:01                  12
</pre><hr></body></html>`;
const APACHE_HUMAN = `<a href="?C=N;O=D">Name</a> <a href="big.bin">big.bin</a>  2026-10-17 10:00  1.5G  <a href="sub/">sub/</a> 2026-10-17 -`;

describe("https listing source", () => {
  test("nginx autoindex rows → entries with exact sizes; parent and sort links ignored", () => {
    expect(autoindexEntries(NGINX)).toEqual([{ name: "Game Dir", size: 0, isDir: true }, { name: "game.iso", size: 5368709120, isDir: false }, { name: "notes.txt", size: 12, isDir: false }]);
    const human = autoindexEntries(APACHE_HUMAN);
    expect(human.map(e => e.name)).toEqual(["big.bin", "sub"]);
    expect(human[0].size).toBeLessThan(0);          // approximate → confirmed with HEAD by list()
  });
  test("maps seedbox paths onto the listing, carries basic auth, stats files and folders, confirms approximate sizes", async () => {
    const calls: { url: string; method: string; auth?: string }[] = [];
    const f = (async (input: any, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? "GET";
      calls.push({ url, method, auth: (init?.headers as Record<string, string>)?.authorization });
      if (url.endsWith("/complete/ahoy/Game%20Dir/")) return new Response(APACHE_HUMAN, { headers: { "content-type": "text/html" } });
      if (url.endsWith("/complete/ahoy/Game%20Dir") && method === "HEAD") return new Response(null, { status: 301, headers: { location: url + "/" } });
      if (url.endsWith("/big.bin") && method === "HEAD") return new Response(null, { headers: { "content-length": "1610612736", "content-type": "application/octet-stream" } });
      if (url.endsWith("/game.iso") && method === "HEAD") return new Response(null, { headers: { "content-length": "5368709120", "content-type": "application/octet-stream" } });
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const src = httpsSource(new URL("https://user:p%40ss@user.box.example.eu/user/downloads/"), "/home/user/downloads", f);
    expect(src.urlFor("/home/user/downloads/complete/ahoy/Game Dir")).toBe("https://user.box.example.eu/user/downloads/complete/ahoy/Game%20Dir");
    expect(await src.stat("/home/user/downloads/complete/ahoy/Game Dir")).toEqual({ size: 0, isDir: true });
    expect(await src.stat("/home/user/downloads/complete/ahoy/game.iso")).toEqual({ size: 5368709120, isDir: false });
    const entries = await src.list("/home/user/downloads/complete/ahoy/Game Dir");
    expect(entries).toEqual([{ name: "big.bin", size: 1610612736, isDir: false }, { name: "sub", size: 0, isDir: true }]);
    const req = await src.request("/home/user/downloads/complete/ahoy/game.iso");
    expect(req.headers?.authorization).toBe("Basic " + Buffer.from("user:p@ss").toString("base64"));
    expect(calls.every(c => c.auth?.startsWith("Basic "))).toBe(true);
  });
});

describe("review 2026-11-10: what a listing may name", () => {
  test("files and folders whose names start with 'http' are entries; a name that leaves the folder is none", () => {
    const html = `<a href="../">../</a><a href="http/">http/</a> 17-Oct-2026 10:00 -
<a href="httplib.dll">httplib.dll</a> 17-Oct-2026 10:00 42
<a href="https%3Anotes.txt">https:notes.txt</a> 17-Oct-2026 10:00 7
<a href="..%2F..%2Fevil.txt">evil</a> 17-Oct-2026 10:00 5
<a href="a/../../b">b</a> 17-Oct-2026 10:00 5
<a href="..%5Cwin.txt">w</a> 17-Oct-2026 10:00 5
<a href="%2E%2E/">up</a> 17-Oct-2026 10:00 -
<a href="sub/deep/">deep</a> 17-Oct-2026 10:00 -
<a href="http://elsewhere.example/x.bin">x</a> 17-Oct-2026 10:00 5
<a href="https://elsewhere.example/">y</a> 17-Oct-2026 10:00 -
<a href="/abs/path">abs</a> 17-Oct-2026 10:00 5
<a href="game.exe">game.exe</a> 17-Oct-2026 10:00 9`;
    expect(autoindexEntries(html)).toEqual([
      { name: "http", size: 0, isDir: true }, { name: "httplib.dll", size: 42, isDir: false }, { name: "https:notes.txt", size: 7, isDir: false },
      { name: "game.exe", size: 9, isDir: false },
    ]);
  });
  test("Apache's \"./name\" (how it writes a name with a colon in it) is that entry; \"./\" in front of a way out is still none", async () => {
    const html = `<a href="?C=N;O=D">Name</a> <a href="/dl/">Parent Directory</a>   -
<a href="./Game:%20Sub.iso">Game: Sub.iso</a> 2026-11-10 10:00 700
<a href="./Dir:%20X/">Dir: X/</a> 2026-11-10 10:00 -
<a href="./">here</a> 2026-11-10 10:00 -
<a href="./../">up</a> 2026-11-10 10:00 -
<a href="./../../evil.txt">evil</a> 2026-11-10 10:00 5
<a href=".%2F..%2Fevil2.txt">evil2</a> 2026-11-10 10:00 5
<a href="././twice.txt">twice</a> 2026-11-10 10:00 5
<a href=".//abs.txt">abs</a> 2026-11-10 10:00 5
<a href="./sub/deep.txt">deep</a> 2026-11-10 10:00 5
<a href="game.exe">game.exe</a> 2026-11-10 10:00 5000`;
    expect(autoindexEntries(html)).toEqual([
      { name: "Game: Sub.iso", size: 700, isDir: false }, { name: "Dir: X", size: 0, isDir: true }, { name: "game.exe", size: 5000, isDir: false },
    ]);
    // and it is asked for under its own name, the colon escaped
    const src = httpsSource(new URL("https://box.example/dl"), "/home/u/dl", (async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch);
    const entries = await src.list("/home/u/dl/Game");
    expect(entries.map(e => e.name)).toEqual(["Game: Sub.iso", "Dir: X", "game.exe"]);
    expect((await src.request("/home/u/dl/Game/" + entries[0].name)).url).toBe("https://box.example/dl/Game/Game%3A%20Sub.iso");
  });
});
