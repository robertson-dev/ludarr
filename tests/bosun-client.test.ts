import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BosunClient, sha256File, BosunError, type BosunSettings } from "../src/bosun-client";
import { createBosunApp } from "../src/bosun/app";
import { Roots } from "../src/bosun/fs";
import { kv } from "../src/db";
import type { SshLink } from "../src/ssh";

/* ── a fake seedbox: remembers files, answers the handful of shell commands the installer uses ── */
class FakeBox {
  files = new Map<string, string>();
  hashes = new Map<string, string>();
  running = false;
  cron = "";
  exec: string[] = [];
  puts: { local: string; remote: string }[] = [];
  constructor(public serverPort: () => number) {}
  connected() { return true; }
  describe() { return "u@box:22"; }
  async execCmd(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    this.exec.push(cmd);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    let m: RegExpExecArray | null;
    if (cmd === "echo $HOME") return ok("/home/u\n");
    if (cmd.startsWith("mkdir -p")) return ok();
    if ((m = /^sha256sum '([^']+)'/.exec(cmd))) return ok((this.hashes.get(m[1]) ?? "") + "\n");
    if ((m = /^mv -f '([^']+)' '([^']+)'/.exec(cmd))) { const h = this.hashes.get(m[1]); this.hashes.delete(m[1]); if (h) this.hashes.set(m[2], h); return ok(); }
    if ((m = /^cat '([^']+)'/.exec(cmd))) return ok(this.files.get(m[1]) ?? "");
    if (/bosun\.pid/.test(cmd) && /echo running/.test(cmd)) return ok(this.running ? "running\n" : "");
    if (/^kill /.test(cmd)) { this.running = false; return ok(); }
    if (/nohup setsid/.test(cmd)) { this.running = true; this.files.set("/home/u/.ahoy/bosun.port", String(this.serverPort())); return ok(); }
    if (cmd === "crontab -l 2>/dev/null") return ok(this.cron);
    if (/\| crontab -$/.test(cmd)) { const line = /echo '([^']+)'/.exec(cmd)![1]; this.cron += line + "\n"; return ok(); }
    if (/^tail /.test(cmd)) return ok("");
    return { code: 127, stdout: "", stderr: `unknown: ${cmd}` };
  }
  async put(local: string, remote: string) { this.puts.push({ local, remote }); this.hashes.set(remote, await sha256File(local)); }
  async writeFile(remote: string, data: string) { this.files.set(remote, data); }
  async localForward() { return { port: this.serverPort(), close() {} }; }
  close() {}
}
const asLink = (b: FakeBox) => ({ exec: (c: string) => b.execCmd(c), put: b.put.bind(b), writeFile: b.writeFile.bind(b), localForward: b.localForward.bind(b), connected: () => true, describe: () => "u@box:22", close() {} } as unknown as SshLink);

let server: ReturnType<typeof Bun.serve>;
let box: FakeBox;
let client: BosunClient;
let bin: string;

const mk = (over: Partial<BosunSettings> = {}) => new BosunClient({ sshHost: "box", sshUser: "u", sshPass: "p", binary: bin, ...over }, asLink(box), fetch, async () => { throw new Error("should not build: a binary is set"); });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahoy-bosun-"));
  bin = join(dir, "bosun-fake");
  writeFileSync(bin, "#!/bin/sh\necho fake bosun\n");
  process.env.BOSUN_BINARY = bin;
  process.env.SEEDBOX_SSH_HOST = "box";
  process.env.SEEDBOX_SSH_USER = "u";
  process.env.SEEDBOX_SSH_PASS = "p";
  const roots = await Roots.of([dir]);
  const app = createBosunApp({
    token: new BosunClient({ sshHost: "box", sshUser: "u" }).token(), version: "0.1.0-test", selfHash: () => "cafe", startedAt: Date.now(), host: "box", user: "u",
    rtorrent: { version: async () => "0.9.8", list: async () => [] } as any, nzbget: null, rtOpts: {}, nzbCategory: "ahoy",
    roots, downloadsDir: "/home/u/downloads", webBase: "https://box/u/downloads", webRoot: "/home/u/downloads", rtorrentScgi: "127.0.0.1:5039", nzbgetUrl: null,
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
});
afterAll(() => { server.stop(true); delete process.env.BOSUN_BINARY; delete process.env.SEEDBOX_SSH_HOST; delete process.env.SEEDBOX_SSH_USER; delete process.env.SEEDBOX_SSH_PASS; });
beforeEach(() => {
  box = new FakeBox(() => server.port!);
  client = mk();
});

describe("bosun client", () => {
  test("token is minted once and persisted", () => {
    const t = client.token();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(mk().token()).toBe(t);
    expect(kv.get("bosun.token")).toBe(t);
  });
  test("first install: upload, config with the token, start, cron; second: nothing to do", async () => {
    const r = await client.ensureInstalled();
    expect(r).toMatchObject({ uploaded: true, started: true, restarted: false, port: server.port, version: "0.1.0-test", hash: "cafe" });
    expect(box.puts).toEqual([{ local: bin, remote: "/home/u/.ahoy/bosun.new" }]);
    expect(box.hashes.get("/home/u/.ahoy/bosun")).toBe(await sha256File(bin));
    const conf = JSON.parse(box.files.get("/home/u/.ahoy/bosun.json")!);
    expect(conf).toMatchObject({ token: client.token(), port: 17867, rtorrent: { label: "ahoy" }, nzbget: { category: "ahoy" } });
    expect(box.cron).toContain("@reboot sleep 20; $HOME/.ahoy/bosun serve");
    expect(box.running).toBe(true);
    const again = await client.ensureInstalled();
    expect(again).toMatchObject({ uploaded: false, started: false, restarted: false });
    expect(box.puts).toHaveLength(1);
    expect(box.cron.split("\n").filter(l => l.includes("bosun")).length).toBe(1);
  });
  test("a config change restarts the running connector; force re-uploads", async () => {
    await client.ensureInstalled();
    const r = await mk({ nzbgetUrl: "https://box/u/nzbget" }).ensureInstalled();
    expect(r).toMatchObject({ uploaded: false, restarted: true, started: true });
    expect(JSON.parse(box.files.get("/home/u/.ahoy/bosun.json")!).nzbget.url).toBe("https://box/u/nzbget");
    const f = await client.ensureInstalled({ force: true });
    expect(f).toMatchObject({ uploaded: true, restarted: true });
    expect(box.puts).toHaveLength(2);
  });
  test("api calls auto-install when the connector is not running", async () => {
    expect(box.running).toBe(false);
    const s = await client.status();
    expect(s).toMatchObject({ ok: true, version: "0.1.0-test" });
    expect(box.running).toBe(true);
    expect((await client.items()).items).toEqual([]);
    expect(await client.get("rt:ABC")).toBeNull();
  });
  test("fileRequest: https with the web login when known, else the tunnel with the bearer", async () => {
    await client.ensureInstalled();
    const tunnel = await client.fileRequest("/home/u/downloads/Game Dir/a b.bin");
    expect(tunnel.url).toBe(`http://127.0.0.1:${server.port}/v1/fs/file?path=${encodeURIComponent("/home/u/downloads/Game Dir/a b.bin")}`);
    expect(tunnel.headers.authorization).toBe(`Bearer ${client.token()}`);
    expect(client.dataPlane(await client.status())).toBe("tunnel");
    const web = await mk({ webPass: "w" }).fileRequest("/home/u/downloads/Game Dir/a+b.bin");
    expect(web.url).toBe("https://box/u/downloads/Game%20Dir/a%2Bb.bin");
    expect(web.headers.authorization).toBe("Basic " + Buffer.from("u:w").toString("base64"));
    const w = mk({ webPass: "w" }); expect(w.dataPlane(await w.status())).toBe("https");
    const outside = await client.fileRequest("/elsewhere/x");
    expect(outside.url).toContain("/v1/fs/file?path=");
  });
  test("unconfigured → clear error; a bad binary path → clear error", async () => {
    await expect(mk({ sshHost: "" }).status()).rejects.toThrow(/no SSH host/);
    await expect(mk({ binary: join(tmpdir(), "definitely-missing-bosun") }).ensureInstalled()).rejects.toBeInstanceOf(BosunError);
  });
});
