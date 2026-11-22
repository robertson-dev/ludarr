import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";
import { moveTransferLogins } from "../src/bootstrap";
import { splitLogin, transfer, transferUrl } from "../src/plugins/builtin/clients";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { httpsSource } from "../src/pull-https";
import { lftpScript, measure, waitForLocal } from "../src/pull";
import { ownsDownload } from "../src/process/runner";

for (const p of BUILTIN) registry.registerPlugin(p, "builtin");
beforeEach(() => { db.exec("DELETE FROM plugin_instances WHERE kind='downloadClient'"); registry.clearCache(); });

describe("transfer login", () => {
  test("the login lives in its own fields and goes back into the URL only when a transfer runs", async () => {
    expect(splitLogin("https://user:s3cr%40t@box.example/downloads")).toEqual({ url: "https://box.example/downloads", user: "user", pass: "s3cr@t" });
    expect(splitLogin("sftp://host:22")).toEqual({ url: "sftp://host:22", user: "", pass: "" });
    expect(splitLogin("not a url")).toEqual({ url: "not a url", user: "", pass: "" });
    const u = transferUrl({ pullUrl: "https://box.example/downloads", pullUser: "user", pullPass: "p@ss word" })!;
    expect(u.username).toBe("user"); expect(decodeURIComponent(u.password)).toBe("p@ss word"); expect(u.origin + u.pathname).toBe("https://box.example/downloads");
    expect(transferUrl({ pullUrl: "", pullUser: "x", pullPass: "y" })).toBeNull();
    // the https engine sends it as basic auth, never in the URL it requests
    const seen: { url: string; auth: string | undefined }[] = [];
    const src = httpsSource(u, "", (async (url: any, init?: RequestInit) => { seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization }); return new Response("", { status: 200, headers: { "content-length": "5", "content-type": "application/octet-stream" } }); }) as unknown as typeof fetch);
    await src.stat("/home/user/downloads/x.bin");
    expect(seen[0].url).toBe("https://box.example/downloads/home/user/downloads/x.bin");
    expect(seen[0].auth).toBe("Basic " + Buffer.from("user:p@ss word").toString("base64"));
    // lftp gets it in the script on stdin
    const sftp = transferUrl({ pullUrl: "sftp://host:2222", pullUser: "u", pullPass: "p" })!;
    expect(lftpScript(sftp, { id: "1", remotePath: "/x", sizeBytes: 1 } as never, { url: sftp.toString(), downloadsDir: "/d" })).toContain("sftp://u:p@host:2222");
  });
  test("the password field is masked by the API; a login still written into a saved URL moves into the fields at boot", () => {
    const row = registry.createInstance("downloadClient", "rtorrent", { name: "rT", settings: { url: "https://box/rpc", pullUrl: "https://user:hunter2@box.example/downloads" } as never });
    expect(moveTransferLogins()).toBe(1);
    const s = JSON.parse(registry.instanceRow(row.id)!.settings_json);
    expect(s).toMatchObject({ pullUrl: "https://box.example/downloads", pullUser: "user", pullPass: "hunter2" });
    expect(registry.serializeInstance(registry.instanceRow(row.id)!).settings).toMatchObject({ pullUrl: "https://box.example/downloads", pullUser: "user", pullPass: registry.MASK });
    expect(moveTransferLogins()).toBe(0);
  });
  test("a mounted client folder: a late mount is waited for, a folder still filling is not imported until it settles, and the client's files are never deleted", async () => {
    let there = false;
    const sizes = [[3, 1], [5, 2], [7, 2], [7, 2]];              // still arriving, then two equal measurements
    const h = waitForLocal("/remote/downloads/x", { remotePath: "/home/u/downloads/x", isDir: true, expectedBytes: 7 }, { pollMs: 5, settleMs: 5, exists: async () => there, measure: async () => { const [bytes, files] = sizes.length > 1 ? sizes.shift()! : sizes[0]; return { bytes, files }; } });
    expect(h.progress()).toBe(0);
    setTimeout(() => { there = true; }, 20);
    expect(await h.done).toMatchObject({ ok: true, localPath: "/remote/downloads/x", bytes: 7 });
    expect(sizes).toEqual([[7, 2]]);                              // it sat through the growing samples before agreeing
    expect(h.progress()).toBe(1); expect(h.bytes()).toBe(7);
    const late = waitForLocal("/remote/never", { remotePath: "/x", isDir: false, expectedBytes: 1 }, { pollMs: 5, maxMs: 30, exists: async () => false });
    expect((await late.done).error).toContain("is the mount up");
    let n = 0;
    const forever = waitForLocal("/remote/growing", { remotePath: "/x", isDir: true, expectedBytes: 1 }, { pollMs: 5, settleMs: 5, maxMs: 40, exists: async () => true, measure: async () => ({ bytes: ++n, files: 1 }) });
    expect((await forever.done).error).toContain("kept changing");
    const c = waitForLocal("/remote/never", { remotePath: "/x", isDir: false, expectedBytes: 1 }, { pollMs: 1000, exists: async () => false });
    setTimeout(() => c.cancel(), 10);
    expect((await c.done).error).toBe("cancelled");
    const root = mkdtempSync(join(tmpdir(), "ludarr-remote-")).replaceAll(sep, "/"); mkdirSync(join(root, "downloads", "Game-RUNE"), { recursive: true });
    const t = transfer({ pathMap: `/home/u/downloads=${root}/downloads` }, { config: () => "", paths: { downloads: "/dl" }, fetch, log: { info() {}, warn() {}, error() {}, debug() {} } } as never);
    const m = t({ path: "/home/u/downloads/Game-RUNE", isDir: true, sizeBytes: 1 }, { remotePath: "/home/u/downloads/Game-RUNE", isDir: true, expectedBytes: 1 });
    expect("done" in m && m.localPath).toBe(`${root}/downloads/Game-RUNE`); (m as { cancel(): void }).cancel();     // a handle even when it is there: it still has to settle
    expect(await measure(join(root, "downloads"))).toEqual({ bytes: 0, files: 0 });
    writeFileSync(join(root, "downloads", "Game-RUNE", "a.bin"), "12345"); writeFileSync(join(root, "downloads", "Game-RUNE", "b.bin"), "67");
    expect(await measure(join(root, "downloads"))).toEqual({ bytes: 7, files: 2 });
    expect(t({ path: "/elsewhere/x", isDir: false, sizeBytes: 1 }, { remotePath: "/elsewhere/x", isDir: false, expectedBytes: 1 })).toEqual({ local: "/elsewhere/x" });
    expect(ownsDownload("/downloads/Game-RUNE", "/downloads")).toBe(true);
    expect(ownsDownload("/remote/downloads/Game-RUNE", "/downloads")).toBe(false);
    expect(ownsDownload("/downloads-other/x", "/downloads")).toBe(false);
  });
});

describe("review 2026-11-10: the downloads folder itself is no download", () => {
  test("ownsDownload is true only for what lies inside the downloads folder", () => {
    expect(ownsDownload("/downloads", "/downloads")).toBe(false);
    expect(ownsDownload("/downloads/", "/downloads")).toBe(false);
    expect(ownsDownload("/downloads/x/..", "/downloads")).toBe(false);
    expect(ownsDownload("/downloads/Game-RUNE", "/downloads/")).toBe(true);
    expect(ownsDownload("/downloads/Game-RUNE/sub", "/downloads")).toBe(true);
  });
});
