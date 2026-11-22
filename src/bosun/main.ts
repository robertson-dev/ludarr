#!/usr/bin/env bun
/**
 * bosun — Ahoy's seedbox connector.
 *
 * Runs on the seedbox as the seedbox user, listens on 127.0.0.1 only (Ahoy reaches it through an SSH
 * port-forward) and authenticates with the bearer token in ~/.ahoy/bosun.json. Everything else —
 * rtorrent's SCGI socket, NZBGet's login, the download folder, the https URL that serves it — is
 * detected on the box (detect.ts); the config only has to carry what detection cannot find.
 *
 *   bosun serve      start (default)        bosun detect     print what it found, as json
 *   bosun version
 *
 * Built into one static binary from the Ahoy repo:  bun run build:bosun
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { RtorrentClient } from "../rtorrent";
import { NzbgetClient } from "../nzbget";
import { scgiTransport } from "../scgi";
import { createBosunApp, type BosunCtx } from "./app";
import { Roots } from "./fs";
import { parseRtorrentRc, findNzbgetConf, nzbgetUrlCandidates, detectWebBase } from "./detect";
import { BOSUN_VERSION } from "./version";

export interface BosunConfig {
  token: string;
  port?: number;
  rtorrent?: { scgi?: string; dir?: string; label?: string };
  nzbget?: { url?: string; user?: string; pass?: string; category?: string };
  downloadsDir?: string;
  roots?: string[];
  webBase?: string;
  webRoot?: string;
}

const HOME = homedir();
const DIR = process.env.BOSUN_DIR || join(HOME, ".ahoy");
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[bosun]", ...a);

async function detectAll(cfg: BosunConfig) {
  const rc = parseRtorrentRc(await readFile(join(HOME, ".rtorrent.rc"), "utf8").catch(() => ""), HOME);
  const scgi = cfg.rtorrent?.scgi || rc.scgi;
  const downloadsDir = cfg.downloadsDir || rc.defaultDir || join(HOME, "downloads");
  const nzbConf = await findNzbgetConf(HOME);
  const user = cfg.nzbget?.user || nzbConf?.conf.user || "";
  const pass = cfg.nzbget?.pass || nzbConf?.conf.pass || "";
  const nzbUrls = cfg.nzbget?.url ? [cfg.nzbget.url] : nzbgetUrlCandidates(userInfo().username, hostname(), nzbConf?.conf.port ?? null);
  const roots = await Roots.of([
    downloadsDir, nzbConf?.conf.destDir, nzbConf?.conf.interDir, nzbConf?.conf.mainDir, cfg.rtorrent?.dir, ...(cfg.roots ?? []),
  ].filter((p): p is string => !!p));
  const web = cfg.webBase && cfg.webRoot ? { webBase: cfg.webBase, webRoot: cfg.webRoot } : await detectWebBase(downloadsDir, HOME);
  return { scgi, downloadsDir, nzb: { user, pass, urls: nzbUrls, conf: nzbConf?.path ?? null }, roots, web };
}

/** first NZBGet URL that answers version() — retried later if none does now */
async function findNzbget(urls: string[], user: string, pass: string): Promise<{ client: NzbgetClient; url: string } | null> {
  for (const url of urls) {
    const client = new NzbgetClient(fetch, { url, user, pass });
    if (await client.version().then(() => true, () => false)) return { client, url };
  }
  return null;
}

async function diskFree(dir: string): Promise<{ free: number; total: number } | null> {
  const p = Bun.spawn(["df", "-B1", "--output=avail,size", dir], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  const m = /(\d+)\s+(\d+)\s*$/.exec(out.trim());
  return m ? { free: Number(m[1]), total: Number(m[2]) } : null;
}

/** Bun.which, then the usual bin dirs (the cron/nohup environment can have a thin PATH) */
function which(...names: string[]): string | null {
  for (const n of names) {
    const w = Bun.which(n);
    if (w) return w;
    for (const d of ["/usr/local/bin", "/usr/bin", "/bin", join(HOME, "bin"), join(HOME, ".local/bin")]) {
      const p = join(d, n);
      try { if (require("node:fs").statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

async function selfHash(): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(process.execPath).stream().getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; h.update(value); }
  return h.digest("hex");
}

async function loadConfig(): Promise<BosunConfig> {
  const path = join(DIR, "bosun.json");
  const cfg = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as BosunConfig;
  if (!cfg.token) { console.error(`bosun: no token in ${path} — let Ahoy install me (POST /api/seedbox/connect)`); process.exit(2); }
  return cfg;
}

async function serve() {
  const cfg = await loadConfig();
  await mkdir(DIR, { recursive: true });
  const pidFile = join(DIR, "bosun.pid");
  const oldPid = Number(await readFile(pidFile, "utf8").catch(() => "")) || 0;
  if (oldPid && oldPid !== process.pid) {
    try { process.kill(oldPid, 0); console.error(`bosun: already running (pid ${oldPid})`); process.exit(0); } catch { /* stale pid file */ }
  }

  const d = await detectAll(cfg);
  const rtorrent = d.scgi ? new RtorrentClient(fetch, scgiTransport(d.scgi)) : null;
  const nz = await findNzbget(d.nzb.urls, d.nzb.user, d.nzb.pass);
  const ctx: BosunCtx = {
    token: cfg.token, version: BOSUN_VERSION, selfHash: () => hash, startedAt: Date.now(),
    host: hostname(), user: userInfo().username,
    rtorrent, nzbget: nz?.client ?? null,
    rtOpts: { label: cfg.rtorrent?.label || "ahoy", dir: cfg.rtorrent?.dir || undefined }, nzbCategory: cfg.nzbget?.category || "ahoy",
    roots: d.roots, downloadsDir: d.downloadsDir, webBase: d.web?.webBase ?? null, webRoot: d.web?.webRoot ?? null,
    rtorrentScgi: d.scgi ?? null, nzbgetUrl: nz?.url ?? null,
    diskFree, tools: { "7z": which("7z", "7za"), unrar: which("unrar"), tar: which("tar") },
  };
  let hash: string | null = null;
  selfHash().then(h => { hash = h; }).catch(() => {});
  if (!ctx.nzbget) {
    const retry = setInterval(async () => {
      const found = await findNzbget(d.nzb.urls, d.nzb.user, d.nzb.pass);
      if (found) { ctx.nzbget = found.client; ctx.nzbgetUrl = found.url; clearInterval(retry); log(`nzbget found at ${found.url}`); }
    }, 60_000);
  }

  const app = createBosunApp(ctx);
  let port = cfg.port || 17867;
  let server: ReturnType<typeof Bun.serve> | null = null;
  for (let i = 0; i < 20 && !server; i++, port++) {
    try { server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, idleTimeout: 120 }); }
    catch (e: any) { if (!/EADDRINUSE|address already in use|port/i.test(String(e?.message ?? e))) throw e; }
  }
  if (!server) { console.error("bosun: no free port"); process.exit(1); }
  await writeFile(join(DIR, "bosun.port"), String(server.port));
  await writeFile(pidFile, String(process.pid));
  log(`v${BOSUN_VERSION} listening on 127.0.0.1:${server.port} as ${ctx.user}@${ctx.host}`);
  log(`rtorrent: ${d.scgi ?? "not found"} · nzbget: ${nz?.url ?? "not found (will keep looking)"} · downloads: ${d.downloadsDir}`);
  log(`web: ${d.web ? `${d.web.webBase} → ${d.web.webRoot}` : "no https mapping found (pulls go through the tunnel)"} · roots: ${d.roots.list().join(", ")}`);
  const bye = () => { server?.stop(true); process.exit(0); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

const cmd = process.argv[2] ?? "serve";
if (cmd === "version") console.log(BOSUN_VERSION);
else if (cmd === "detect") {
  const cfg = JSON.parse(await readFile(join(DIR, "bosun.json"), "utf8").catch(() => "{}")) as BosunConfig;
  const d = await detectAll(cfg);
  console.log(JSON.stringify({ ...d, nzb: { ...d.nzb, pass: d.nzb.pass ? "••••" : "" }, roots: d.roots.list() }, null, 2));
} else if (cmd === "serve") await serve();
else { console.error(`bosun: unknown command ${cmd}`); process.exit(2); }
