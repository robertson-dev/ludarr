/**
 * ludarr — one SSH session to the seedbox (ssh2, in-process: no openssh binary, no sshpass).
 *
 * Used for everything the bosun connector needs from this side: exec (install/start/inspect),
 * SFTP (upload the binary + config) and a local TCP forward so plain fetch() reaches the connector's
 * localhost port on the box. Lazily connected, reconnects on the next use after a drop.
 */
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";

export interface SshOpts { host: string; port: number; username: string; password?: string; privateKey?: string }
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface LocalForward { port: number; close(): void }

export class SshLink {
  private client: Client | null = null;
  private pending: Promise<Client> | null = null;
  private last: SshOpts | null = null;

  constructor(private opts: () => SshOpts | Promise<SshOpts>) {}

  connected() { return !!this.client; }
  describe() { return this.last ? `${this.last.username}@${this.last.host}:${this.last.port}` : "(unconfigured)"; }

  async conn(): Promise<Client> {
    if (this.client) return this.client;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const o = await this.opts();
      this.last = o;
      if (!o.host || !o.username) throw new Error("SSH_NOT_CONFIGURED");
      if (!o.password && !o.privateKey) throw new Error("SSH_NO_CREDENTIALS");
      const c = new Client();
      await new Promise<void>((res, rej) => {
        const onErr = (e: Error) => rej(new Error(`ssh ${o.username}@${o.host}:${o.port}: ${e.message}`));
        c.once("ready", () => { c.off("error", onErr); res(); });
        c.once("error", onErr);
        c.connect({
          host: o.host, port: o.port, username: o.username,
          password: o.password || undefined, privateKey: o.privateKey || undefined,
          readyTimeout: 30_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
        });
      });
      c.on("error", () => { /* surfaced by whichever call was in flight */ });
      c.on("close", () => { if (this.client === c) this.client = null; });
      this.client = c;
      return c;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  async exec(cmd: string, stdin?: string | Uint8Array): Promise<ExecResult> {
    const c = await this.conn();
    return new Promise((res, rej) => c.exec(cmd, (err, ch) => {
      if (err) return rej(err);
      let stdout = "", stderr = "";
      ch.on("data", (d: Buffer) => { stdout += d; });
      ch.stderr.on("data", (d: Buffer) => { stderr += d; });
      ch.on("close", (code: number | null) => res({ code: code ?? -1, stdout, stderr }));
      ch.on("error", rej);
      if (stdin !== undefined) ch.end(stdin);
    }));
  }

  async sftp(): Promise<SFTPWrapper> {
    const c = await this.conn();
    return new Promise((res, rej) => c.sftp((e, s) => (e ? rej(e) : res(s))));
  }

  async put(local: string, remote: string, mode = 0o644): Promise<void> {
    const s = await this.sftp();
    try {
      await new Promise<void>((res, rej) => s.fastPut(local, remote, { concurrency: 64, chunkSize: 32768, mode }, e => (e ? rej(e) : res())));
    } finally { s.end(); }
  }

  async writeFile(remote: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
    const s = await this.sftp();
    try {
      await new Promise<void>((res, rej) => s.writeFile(remote, Buffer.from(data as Uint8Array), { mode }, e => (e ? rej(e) : res())));
    } finally { s.end(); }
  }

  async forward(host: string, port: number): Promise<ClientChannel> {
    const c = await this.conn();
    return new Promise((res, rej) => c.forwardOut("127.0.0.1", 0, host, port, (e, ch) => (e ? rej(e) : res(ch))));
  }

  /**
   * 127.0.0.1:<random> here → <remoteHost>:<remotePort> as seen from the box.
   * Bun.listen rather than node:net: bytes that arrive while the SSH channel is still opening are
   * queued (a node:net relay in Bun loses them), and backpressure towards the local socket is explicit.
   */
  async localForward(remoteHost: string, remotePort: number): Promise<LocalForward> {
    type Relay = { ch: ClientChannel | null; toCh: Buffer[]; toSock: Buffer[]; closed: boolean };
    const flush = (sock: Bun.Socket<Relay>) => {
      const q = sock.data.toSock;
      while (q.length) {
        const b = q[0];
        const n = sock.write(b);
        if (n < b.length) { q[0] = b.subarray(Math.max(0, n)); sock.data.ch?.pause(); return; }
        q.shift();
      }
      sock.data.ch?.resume();
    };
    const server = Bun.listen<Relay>({
      hostname: "127.0.0.1", port: 0,
      socket: {
        open: sock => {
          sock.data = { ch: null, toCh: [], toSock: [], closed: false };
          this.forward(remoteHost, remotePort).then(ch => {
            if (sock.data.closed) { ch.close(); return; }
            sock.data.ch = ch;
            ch.on("data", (d: Buffer) => { sock.data.toSock.push(d); flush(sock); });
            ch.on("close", () => { flush(sock); sock.end(); });
            ch.on("error", () => sock.end());
            for (const b of sock.data.toCh) ch.write(b);
            sock.data.toCh = [];
          }).catch(() => sock.end());
        },
        data: (sock, d) => { const b = Buffer.from(d); if (sock.data.ch) sock.data.ch.write(b); else sock.data.toCh.push(b); },
        drain: sock => flush(sock),
        close: sock => { sock.data.closed = true; sock.data.ch?.close(); },
        error: sock => { sock.data.closed = true; sock.data.ch?.close(); },
      },
    });
    return { port: server.port, close: () => { server.stop(true); } };
  }

  close() {
    this.client?.end();
    this.client = null;
  }
}
