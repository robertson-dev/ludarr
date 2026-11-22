/**
 * ludarr — the ship's side of the bosun connector.
 *
 * Given one SSH login (SEEDBOX_SSH_*), this installs the connector on the seedbox (upload the compiled
 * binary when its hash differs, write ~/.ahoy/bosun.json with a token, start it, add a cron @reboot line),
 * keeps a local port-forward to it, and wraps its API. Pulls use the box's own https file listing when
 * the web login is known (fast) and the connector's /v1/fs/file through the tunnel otherwise.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { kv } from "./db";
import { fileChunks } from "./fsutil";
import { SshLink, type SshOpts, type LocalForward } from "./ssh";
import type { SbItem } from "./seedbox-items";
import type { HttpSource } from "./pull-http";
import { BOSUN_VERSION } from "./bosun/version";

export class BosunError extends Error {
  constructor(msg: string, public status = 502) { super(msg); }
}

export interface BosunStatus {
  ok: boolean; version: string; hash: string | null; uptime: number; host: string; user: string;
  downloadsDir: string; webBase: string | null; webRoot: string | null; roots: string[];
  rtorrent: { configured: boolean; ok: boolean; version: string | null; detail: string | null };
  nzbget: { configured: boolean; ok: boolean; version: string | null; detail: string | null };
  disk: { free: number; total: number } | null;
  tools: Record<string, string | null>;
}
export interface AddResult { id: string; client: "rtorrent" | "nzbget"; clientId: string; infoHash?: string; name?: string; size?: number }
export interface InstallReport { uploaded: boolean; restarted: boolean; started: boolean; port: number; version: string; hash: string }

export const BACKEND_ROOT = dirname(import.meta.dir);
export const DEFAULT_BINARY = join(BACKEND_ROOT, "dist", "bosun-linux-x64");
export interface BosunSettings {
  sshHost: string; sshPort?: number; sshUser: string; sshPass?: string; sshKey?: string;
  webUser?: string; webPass?: string; port?: number; binary?: string;
  rtorrentLabel?: string; rtorrentDir?: string;
  nzbgetUrl?: string; nzbgetUser?: string; nzbgetPass?: string; nzbgetCategory?: string;
}
const EMPTY: BosunSettings = { sshHost: "", sshUser: "" };
export const bosunBinaryPath = (s: BosunSettings = EMPTY) => s.binary || DEFAULT_BINARY;

/** shell single-quote */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function sshOptsFrom(s: BosunSettings): Promise<SshOpts> {
  let privateKey = s.sshKey ?? "";
  if (privateKey && !privateKey.includes("-----BEGIN")) {
    const f = Bun.file(privateKey);
    if (!(await f.exists())) throw new Error(`SEEDBOX_SSH_KEY: no such file ${privateKey}`);
    privateKey = await f.text();
  }
  return { host: s.sshHost, port: Number(s.sshPort) || 22, username: s.sshUser, password: s.sshPass || undefined, privateKey };
}

export async function sha256File(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of fileChunks(path)) h.update(chunk);
  return h.digest("hex");
}

/** compile src/bosun/main.ts into a static linux binary (what the Dockerfile does at build time) */
export async function buildBosun(out = DEFAULT_BINARY): Promise<string> {
  await mkdir(dirname(out), { recursive: true });
  const p = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-linux-x64", "--minify", "src/bosun/main.ts", "--outfile", out],
    { cwd: BACKEND_ROOT, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new BosunError(`building bosun failed: ${err.trim().slice(-400)}`, 500);
  return out;
}

export class BosunClient {
  private fwd: LocalForward | null = null;
  private remotePort: number | null = null;
  private remoteHome: string | null = null;
  private statusCache: { at: number; s: BosunStatus } | null = null;
  private installing: Promise<InstallReport> | null = null;

  constructor(
    private settings: BosunSettings = EMPTY,
    public link: SshLink = new SshLink(() => sshOptsFrom(settings)),
    private fetchImpl: typeof fetch = fetch,
    private build: () => Promise<string> = buildBosun,
  ) {}

  configured() { return !!this.settings.sshHost; }

  /** the bearer token the connector was installed with; minted once, kept in kv */
  token(): string {
    let t = kv.get("bosun.token");
    if (!t) { t = randomBytes(32).toString("hex"); kv.set("bosun.token", t); }
    return t;
  }

  private async home(): Promise<string> {
    if (!this.remoteHome) {
      const r = await this.link.exec("echo $HOME");
      this.remoteHome = r.stdout.trim().replace(/\/+$/, "");
      if (!this.remoteHome) throw new BosunError("could not read $HOME on the seedbox", 502);
    }
    return this.remoteHome;
  }
  private async dir() { return `${await this.home()}/.ahoy`; }

  private async sh(cmd: string): Promise<string> {
    const r = await this.link.exec(cmd);
    if (r.code !== 0) throw new BosunError(`seedbox: ${cmd.slice(0, 60)}… failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`, 502);
    return r.stdout;
  }

  private async port(): Promise<number> {
    if (this.remotePort) return this.remotePort;
    const r = await this.link.exec(`cat ${q(`${await this.dir()}/bosun.port`)} 2>/dev/null`);
    const p = Number(r.stdout.trim());
    if (!p) throw new BosunError("BOSUN_NOT_RUNNING", 503);
    this.remotePort = p;
    return p;
  }

  /** http://127.0.0.1:<local> that lands on the connector */
  async base(): Promise<string> {
    if (!this.fwd || !this.link.connected()) {
      this.fwd?.close();
      this.fwd = await this.link.localForward("127.0.0.1", await this.port());
    }
    return `http://127.0.0.1:${this.fwd.port}`;
  }

  private dropForward() {
    this.fwd?.close();
    this.fwd = null;
    this.remotePort = null;
    this.statusCache = null;
  }

  async api<T>(path: string, init: RequestInit = {}, autoInstall = true): Promise<T> {
    if (!this.configured()) throw new BosunError("the seedbox connector has no SSH host", 400);
    let res: Response;
    try {
      const base = await this.base();
      res = await this.fetchImpl(base + path, {
        ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.token()}` },
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e: any) {
      // not running / tunnel broke: (re)install once, then try again
      this.dropForward();
      if (autoInstall && !(e instanceof BosunError && /SSH|ssh /.test(e.message))) {
        await this.ensureInstalled();
        return this.api<T>(path, init, false);
      }
      throw e instanceof BosunError ? e : new BosunError(`bosun unreachable: ${e?.message ?? e}`, 503);
    }
    if (res.status === 401) throw new BosunError("bosun rejected the token — POST /api/seedbox/connect {force:true} re-installs it", 502);
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new BosunError(j.error ?? `bosun HTTP ${res.status}`, res.status);
    return j as T;
  }

  async status(): Promise<BosunStatus> {
    const s = await this.api<BosunStatus>("/v1/status");
    this.statusCache = { at: Date.now(), s };
    return s;
  }
  private async cachedStatus(): Promise<BosunStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < 60_000) return this.statusCache.s;
    return this.status();
  }

  items(): Promise<{ items: SbItem[]; errors: Record<string, string> }> { return this.api("/v1/items"); }

  async get(id: string): Promise<SbItem | null> {
    try { return (await this.api<{ item: SbItem }>(`/v1/items/${encodeURIComponent(id)}`)).item; }
    catch (e) { if (e instanceof BosunError && e.status === 404) return null; throw e; }
  }

  add(body: { kind: "torrent" | "magnet" | "nzb"; data?: Uint8Array; uri?: string; name?: string }): Promise<AddResult> {
    return this.api("/v1/items", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: body.kind, uri: body.uri, name: body.name, data: body.data ? Buffer.from(body.data).toString("base64") : undefined }),
    });
  }

  async remove(id: string): Promise<void> { await this.api(`/v1/items/${encodeURIComponent(id)}`, { method: "DELETE" }); }

  stat(path: string): Promise<{ path: string; size: number; isDir: boolean; mtime: number }> {
    return this.api(`/v1/fs/stat?path=${encodeURIComponent(path)}`);
  }
  async ls(path: string): Promise<{ name: string; size: number; isDir: boolean; mtime: number }[]> {
    return (await this.api<{ entries: { name: string; size: number; isDir: boolean; mtime: number }[] }>(`/v1/fs/ls?path=${encodeURIComponent(path)}`)).entries;
  }

  private webLogin(): { user: string; pass: string } | null {
    const pass = this.settings.webPass || "";
    const user = this.settings.webUser || this.settings.sshUser;
    return pass && user ? { user, pass } : null;
  }

  dataPlane(s: BosunStatus | null): "https" | "tunnel" {
    return s?.webBase && s.webRoot && this.webLogin() ? "https" : "tunnel";
  }

  /** how the pull engine should GET a file: the box's https listing (fast) or the connector through the tunnel */
  async fileRequest(path: string): Promise<{ url: string; headers: Record<string, string> }> {
    const s = await this.cachedStatus();
    const web = this.webLogin();
    if (web && s.webBase && s.webRoot && (path === s.webRoot || path.startsWith(s.webRoot + "/"))) {
      const rel = path.slice(s.webRoot.length).split("/").filter(Boolean).map(encodeURIComponent).join("/");
      return { url: `${s.webBase.replace(/\/+$/, "")}/${rel}`, headers: { authorization: "Basic " + Buffer.from(`${web.user}:${web.pass}`).toString("base64") } };
    }
    return { url: `${await this.base()}/v1/fs/file?path=${encodeURIComponent(path)}`, headers: { authorization: `Bearer ${this.token()}` } };
  }

  source(): HttpSource {
    return {
      stat: async p => { const s = await this.stat(p); return { size: s.size, isDir: s.isDir }; },
      list: p => this.ls(p),
      request: p => this.fileRequest(p),
    };
  }

  /** the compiled connector on this side, built on demand */
  async binary(): Promise<string> {
    const p = bosunBinaryPath(this.settings);
    if (await Bun.file(p).exists()) return p;
    if (this.settings.binary) throw new BosunError(`connector binary: no such file ${p}`, 500);
    return this.build();
  }

  ensureInstalled(opts: { force?: boolean } = {}): Promise<InstallReport> {
    if (!this.installing) this.installing = this.install(opts).finally(() => { this.installing = null; });
    return this.installing;
  }

  private async install({ force = false }: { force?: boolean }): Promise<InstallReport> {
    const bin = await this.binary();
    const hash = await sha256File(bin);
    const dir = await this.dir();
    const B = q(`${dir}/bosun`), PID = q(`${dir}/bosun.pid`), PORT = q(`${dir}/bosun.port`), LOG = q(`${dir}/bosun.log`), CONF = q(`${dir}/bosun.json`);
    await this.sh(`mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`);

    const remoteHash = (await this.link.exec(`sha256sum ${B} 2>/dev/null | cut -c1-64`)).stdout.trim();
    // another install (Ahoy, a second ludarr) may keep its own build of the same connector version on this box:
    // a different hash of the same version is left alone, so the two never restart it on each other
    const remoteVersion = remoteHash && remoteHash !== hash ? (await this.link.exec(`${B} version 2>/dev/null`)).stdout.trim() : "";
    let uploaded = false;
    if (force || (remoteHash !== hash && remoteVersion !== BOSUN_VERSION)) {
      await this.link.put(bin, `${dir}/bosun.new`, 0o755);
      await this.sh(`mv -f ${q(`${dir}/bosun.new`)} ${B} && chmod 755 ${B}`);
      uploaded = true;
    }

    const config = JSON.stringify({
      token: this.token(), port: Number(this.settings.port) || 17867,
      rtorrent: { label: this.settings.rtorrentLabel || "ahoy", dir: this.settings.rtorrentDir || undefined },
      nzbget: { url: this.settings.nzbgetUrl || undefined, user: this.settings.nzbgetUser || undefined, pass: this.settings.nzbgetPass || undefined, category: this.settings.nzbgetCategory || "ahoy" },
    }, null, 2) + "\n";
    const oldConfig = (await this.link.exec(`cat ${CONF} 2>/dev/null`)).stdout;
    const configChanged = oldConfig !== config;
    if (configChanged) await this.link.writeFile(`${dir}/bosun.json`, config, 0o600);

    const running = (await this.link.exec(`p=$(cat ${PID} 2>/dev/null); [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo running`)).stdout.includes("running");
    let restarted = false, started = false;
    if (running && (uploaded || configChanged || force)) {
      await this.link.exec(`kill $(cat ${PID}) 2>/dev/null; sleep 1; kill -9 $(cat ${PID}) 2>/dev/null; true`);
      restarted = true;
    }
    if (!running || restarted) {
      await this.sh(`rm -f ${PORT} && cd ${q(await this.home())} && (nohup setsid ${B} serve >> ${LOG} 2>&1 < /dev/null &)`);
      started = true;
    }

    const cronLine = `@reboot sleep 20; $HOME/.ahoy/bosun serve >> $HOME/.ahoy/bosun.log 2>&1`;
    const cron = (await this.link.exec("crontab -l 2>/dev/null")).stdout;
    if (!cron.includes(".ahoy/bosun serve")) await this.link.exec(`(crontab -l 2>/dev/null; echo ${q(cronLine)}) | crontab -`);

    this.dropForward();
    let port = 0;
    for (let i = 0; i < 40 && !port; i++) {
      if (started) await Bun.sleep(250);
      port = Number((await this.link.exec(`cat ${PORT} 2>/dev/null`)).stdout.trim()) || 0;
    }
    if (!port) {
      const log = (await this.link.exec(`tail -n 5 ${LOG} 2>/dev/null`)).stdout.trim();
      throw new BosunError(`bosun did not come up${log ? ": " + log.split("\n").slice(-2).join(" | ") : ""}`, 502);
    }
    this.remotePort = port;
    const s = await this.api<BosunStatus>("/v1/status", {}, false);
    return { uploaded, restarted, started, port, version: s.version, hash: s.hash ?? hash };
  }

  /** stop the connector on the box and forget the forward (the cron line stays) */
  async stop(): Promise<void> {
    const PID = q(`${await this.dir()}/bosun.pid`);
    await this.link.exec(`kill $(cat ${PID}) 2>/dev/null; rm -f ${PID}; true`);
    this.dropForward();
  }

  describe() {
    return { host: this.settings.sshHost, port: Number(this.settings.sshPort) || 22, user: this.settings.sshUser, connected: this.link.connected(), version: BOSUN_VERSION };
  }
}
