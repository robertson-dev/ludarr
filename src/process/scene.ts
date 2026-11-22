/**
 * ludarr — scene / repack installers the recipes cannot unpack.
 *
 * A scene ISO (RUNE, CODEX, TENOKE …) holds setup.exe + setup-N.bin: Inno Setup carrying an unarc ("ArC")
 * payload that neither 7z, unar nor innoextract can read, plus a folder named after the group whose files
 * replace the store DRM. Here that is installed the way the agent did it by hand for the first one:
 *
 *   wine setup.exe /VERYSILENT … /DIR=<staging>   (under xvfb, own WINEPREFIX in the job's work dir)
 *   → lay the group's crack folder over the installed tree
 *   → drop the uninstaller leftovers
 *
 * TENOKE ships its own installer instead: a small MFC dialog (SETUP.exe, wide strings "TENOKE INSTALLER",
 * "INSTALL DIRECTORY") with a multi-GB SETUP.bin and no silent switches at all. SETUP.bin is their own container
 * (process/tenoke.ts, read out of the installer with a decompiler): a run of scrambled records and Snappy/stored
 * file bodies — so it is unpacked straight into staging and the installer is never started. Should a package not
 * read (a format change), dlgdrive.exe (helpers/dlgdrive.c) still drives the installer on a virtual display: it
 * fills the directory box, clears the checkboxes, presses INSTALL and waits for 100%. The rest of the path (crack
 * overlay, leftovers) is shared.
 *
 * No model calls; when anything here is missing or fails, the agent still gets its turn.
 */
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { CRACK_DIR, scan, type FileInfo } from "./classify";
import { cfgNum } from "../config";
import { toolbox, type Exec, type ExecResult, type Toolbox } from "./tools";
import { extractTenoke, tenokePackage } from "./tenoke";

export interface SceneCtx {
  exec: Exec; tools: Toolbox; log: (line: string) => void; signal?: AbortSignal;
  progress?: (p: number, msg: string) => void;
}

/** polling of the install target; swappable in tests */
export const sceneOpts = { pollMs: 15_000, settleMs: 45_000, stallMs: 10 * 60_000 };

/** a Linux path as wine sees it (Z: is the root); a Windows path stays as it is */
export const winPath = (p: string) => (/^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\//g, "\\") : "Z:" + p.replace(/\//g, "\\"));

/** does the file carry any of these strings (ASCII or UTF-16LE), looking at its first and last 16 MB */
async function carries(path: string, needles: string[]): Promise<boolean> {
  const f = Bun.file(path);
  const size = f.size;
  const W = 16_000_000;
  const chunks = size <= 2 * W ? [f] : [f.slice(0, W), f.slice(size - W)];
  for (const c of chunks) {
    const buf = Buffer.from(await c.arrayBuffer());
    for (const n of needles) if (buf.indexOf(n) >= 0 || buf.indexOf(Buffer.from(n, "utf16le")) >= 0) return true;
  }
  return false;
}
/** Inno Setup's loader carries "Inno Setup" (version resource, ASCII and UTF-16) and the "rDlPtS" offset-table magic */
export const isInnoSetup = (path: string) => carries(path, ["Inno Setup", "rDlPtS"]);
/** a hand-rolled dialog installer with no unattended mode: TENOKE's ("TENOKE INSTALLER" / "INSTALL DIRECTORY" in its string table) */
export const isDialogInstaller = (path: string) => carries(path, ["TENOKE INSTALLER", "INSTALL DIRECTORY"]);
export type InstallerKind = "inno" | "dialog" | null;
export async function installerKind(path: string): Promise<InstallerKind> {
  if (await isInnoSetup(path).catch(() => false)) return "inno";
  if (await isDialogInstaller(path).catch(() => false)) return "dialog";
  return null;
}
/** an NSIS installer: its stub carries "Nullsoft" (the manifest's "Nullsoft Install System") and the "NSIS Error" dialog title */
export const isNsisInstaller = (path: string) => carries(path, ["Nullsoft", "NSIS Error"]);

/** the TENOKE package next to an installer, when there is one that reads */
export async function tenokePackageIn(dir: string): Promise<string | null> {
  const bin = (await readdir(dir).catch(() => [] as string[])).find(n => /^setup\.bin$/i.test(n));
  if (!bin) return null;
  return (await tenokePackage(join(dir, bin))) ? join(dir, bin) : null;
}

/**
 * Unpack a TENOKE package into staging. null when `srcDir` holds none; { ok: false } when it is one but does not
 * read to the end (staging is emptied again so the installer can take over).
 */
export async function unpackTenoke(ctx: SceneCtx, srcDir: string, staging: string): Promise<{ ok: boolean; reason: string | null } | null> {
  const bin = await tenokePackageIn(srcDir);
  if (!bin) return null;
  const info = await tenokePackage(bin);
  ctx.log(`${basename(bin)} is a TENOKE package (${info?.name ?? "?"}, launches ${info?.launch ?? "?"}) — unpacking it directly, the installer stays closed`);
  ctx.progress?.(0.2, "unpacking the game");
  let last = 0;
  try {
    const r = await extractTenoke(bin, staging, { signal: ctx.signal, progress: p => { if (Date.now() - last > 5000) { last = Date.now(); ctx.progress?.(0.3, `unpacking the game — ${gb(p.bytes)} written`); } } });
    ctx.log(`unpacked: ${r.files} files, ${gb(r.bytes)}`);
    return { ok: true, reason: null };
  } catch (e: any) {
    if (ctx.signal?.aborted) throw e;
    const reason = `reading ${basename(bin)} failed: ${e?.message ?? e}`;
    ctx.log(`${reason} — the installer has to run after all`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    return { ok: false, reason };
  }
}

/** which of several installer-looking exes to run: setup.exe, then setup*, then install* */
export function pickInstaller(rels: string[]): string | null {
  const by = (re: RegExp) => rels.find(r => re.test(basename(r)));
  return by(/^setup\.exe$/i) ?? by(/^setup.*\.exe$/i) ?? by(/^install.*\.exe$/i) ?? null;
}

/** why the installer cannot be run unattended here, or null when it can */
export async function wineBlocker(tools: Toolbox, installer: string): Promise<string | null> {
  if (!tools.wine || !tools.xvfb) return "wine / xvfb-run are not available here";
  const kind = await installerKind(installer);
  if (kind === "inno") return null;
  if (kind === "dialog") return tools.dlgdrive && tools.bash ? null : `${basename(installer)} is a GUI-only installer and dlgdrive.exe / bash are missing here`;
  return `${basename(installer)} is not an Inno Setup installer (no known unattended switches)`;
}

/** the wineserver that belongs to this wine (stopping it takes every process of a prefix down) */
export function wineserverPath(wine: string): string | null {
  for (const p of [join(dirname(wine), "wineserver"), "/usr/lib/wine/wineserver64", "/usr/lib/wine/wineserver", "/usr/lib/x86_64-linux-gnu/wine/wineserver", "/usr/bin/wineserver"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Run a Windows program headless under wine on its own virtual display — a setup step of a way to play (a port's
 * asset extractor, an emulator writing its default settings). `exec` is the caller's: the build sandbox's
 * (src/ways/sandbox.ts), so the program runs as the build user with an empty environment. The prefix's wineserver is
 * stopped afterwards through the same exec, so nothing the program started outlives the step.
 */
export async function runUnderWine(exec: Exec, exe: string, argv: string[], o: { prefix: string; cwd?: string; timeoutMs: number; env?: Record<string, string>; tools?: Toolbox; signal?: AbortSignal; maxOutput?: number }): Promise<ExecResult> {
  const tools = o.tools ?? toolbox();
  if (!tools.wine || !tools.xvfb) return { code: 127, stdout: "", stderr: "wine / xvfb-run are not available here", timedOut: false };
  const env = { WINEPREFIX: o.prefix, WINEDEBUG: "-all", WINEDLLOVERRIDES: "mscoree,mshtml=", ...(o.env ?? {}) };
  try {
    return await exec([tools.xvfb, "-a", "-s", "-screen 0 1280x1024x24", tools.wine, exe, ...argv], { env, cwd: o.cwd, timeoutMs: o.timeoutMs, signal: o.signal, maxOutput: o.maxOutput ?? 8000 });
  } finally {
    const ws = wineserverPath(tools.wine);
    if (ws) await exec([ws, "-k"], { env, timeoutMs: 30_000 }).catch(() => {});
  }
}

const bytesOf = (files: FileInfo[]) => files.reduce((a, f) => a + f.size, 0);
const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

/**
 * Run an Inno Setup installer silently under wine + xvfb with /DIR=staging. Returns when the process exits,
 * or earlier when the installer has clearly finished but lingers — some repack installers sit on a hidden
 * final page, others run [Run] steps for minutes. Inno is asked for its own log (/LOG): once it lists files,
 * "Installation process succeeded" in it is the finish line and its growth the sign of life, so a 30 000-file
 * tree on a slow share is never walked while the installer runs. A log that lists nothing (scene builds strip
 * that) or no log at all: the tree is watched — unins000.dat written and nothing growing, or the tree holding
 * as much as the payload (`payloadBytes`) and nothing growing for a while, or nothing at all for ten minutes.
 */
export async function runInstallerUnderWine(ctx: SceneCtx, installer: string, staging: string, prefix: string, payloadBytes = 0): Promise<{ ok: boolean; reason: string | null }> {
  const { wine, xvfb } = ctx.tools;
  if (!wine || !xvfb) return { ok: false, reason: "wine / xvfb-run are not available here" };
  await mkdir(staging, { recursive: true });
  await mkdir(prefix, { recursive: true });
  const env = { WINEPREFIX: prefix, WINEDEBUG: "-all", WINEDLLOVERRIDES: "mscoree,mshtml=" };
  const minutes = cfgNum("WINE_INSTALL_MINUTES", 90);
  const kind = await installerKind(installer);
  const logPath = kind === "inno" ? join(dirname(staging), "inno.log") : null;
  if (logPath) await rm(logPath, { force: true }).catch(() => {});
  const cmd = kind === "dialog"
    ? dialogInstallCommand(ctx.tools, installer, staging, minutes)
    : [xvfb, "-a", wine, installer, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/NOCANCEL", "/NOICONS", `/DIR=${winPath(staging)}`, ...(logPath ? [`/LOG=${winPath(logPath)}`] : [])];
  if (!cmd) return { ok: false, reason: `${basename(installer)} is a GUI-only installer and dlgdrive.exe / bash are missing here` };
  ctx.log(kind === "dialog" ? `running ${basename(installer)} under wine with dlgdrive at the controls → staging (up to ${minutes} min)` : `running ${basename(installer)} unattended under wine → staging (up to ${minutes} min)`);
  ctx.progress?.(0.2, "installing the game");

  const ac = new AbortController();
  const onOuter = () => ac.abort();
  ctx.signal?.addEventListener("abort", onOuter, { once: true });
  let settled = false, busy = false, lastSize = -1, lastChange = Date.now(), logSize = -1, logFiles = 0, logDone = false;
  const timer = setInterval(async () => {
    if (busy || settled) return;
    busy = true;
    try {
      let finished: boolean, quiet: number, how: string, why = "has finished";
      const log = logPath ? await stat(logPath).catch(() => null) : null;
      if (log && log.size !== logSize) {                                    // Inno's log: one stat, the file itself only when it grew
        const text = await readFile(logPath!, "latin1").catch(() => "");
        logSize = log.size;
        logFiles = (text.match(/^.*Dest filename:/gm) ?? []).length;
        logDone = /Installation process succeeded/i.test(text.slice(-20_000));
        if (logFiles > 0 || logDone) { lastChange = Date.now(); ctx.progress?.(0.3, `installing the game — ${logFiles} files written`); if (!logDone) return; }
      }
      if (logFiles > 0 || logDone) {                                        // a log that tells: no need to walk the tree
        finished = logDone; quiet = Date.now() - lastChange; how = `${logFiles} files`;
      } else {                                                              // no log, or a scene build's log that lists nothing: the tree tells
        const { files } = await scan(staging).catch(() => ({ files: [] as FileInfo[] }));
        const size = bytesOf(files);
        if (size !== lastSize) { lastSize = size; lastChange = Date.now(); ctx.progress?.(0.3, `installing the game — ${gb(size)} written`); return; }
        if (size === 0) return;
        quiet = Date.now() - lastChange; how = gb(size);
        finished = files.some(f => /^unins\d{3}\.dat$/i.test(f.rel));
        if (!finished && payloadBytes > 0 && size >= 0.95 * payloadBytes && quiet >= 2 * sceneOpts.settleMs) { finished = true; why = `holds as much as the payload (${gb(payloadBytes)}) and has written nothing for ${Math.round(quiet / 1000)} s`; }
      }
      if ((finished && quiet >= sceneOpts.settleMs) || quiet >= sceneOpts.stallMs) {
        settled = true;
        ctx.log(finished ? `the installer ${why} (${how}) but is still running — stopping it` : `the installer wrote nothing for ${Math.round(quiet / 60_000)} min (${how} so far) — stopping it`);
        ac.abort();
      }
    } finally { busy = false; }
  }, sceneOpts.pollMs);

  let r: Awaited<ReturnType<Exec>>;
  try {
    r = await ctx.exec(cmd, { env, timeoutMs: minutes * 60_000, signal: ac.signal, maxOutput: 8000 });
  } finally {
    clearInterval(timer);
    ctx.signal?.removeEventListener("abort", onOuter);
    const ws = wineserverPath(wine);                                       // nothing of this prefix may outlive the job
    if (ws) await ctx.exec([ws, "-k"], { env, timeoutMs: 30_000 }).catch(() => {});
    if (logPath) await rm(logPath, { force: true }).catch(() => {});
  }
  if (ctx.signal?.aborted) throw new Error("cancelled");
  const { files } = await scan(staging).catch(() => ({ files: [] as FileInfo[] }));
  const tail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ").slice(-300);
  if (kind === "dialog") for (const line of r.stdout.split("\n").map(s => s.trim()).filter(Boolean).slice(-12)) ctx.log(`dlgdrive: ${line}`);
  if (!files.length) return { ok: false, reason: `the installer wrote nothing (exit ${r.code}${r.timedOut ? ", timed out" : ""})${tail ? `: ${tail}` : ""}` };
  if (r.code !== 0 && !settled) ctx.log(`the installer exited with ${r.code}${r.timedOut ? " (timed out)" : ""} after writing ${files.length} files — the validator decides`);
  ctx.log(`installed: ${files.length} files, ${gb(bytesOf(files))}`);
  return { ok: true, reason: null };
}

/**
 * One xvfb-run around a small bash script, so the installer and dlgdrive share the virtual display: start the
 * installer in its own folder (it finds SETUP.bin next to itself), let dlgdrive fill the dialog and wait for
 * completion, then end the installer (it sits on its final page otherwise). dlgdrive's exit code is the script's.
 */
export function dialogInstallCommand(tools: Toolbox, installer: string, staging: string, minutes: number): string[] | null {
  const { wine, xvfb, bash, dlgdrive } = tools;
  if (!wine || !xvfb || !bash || !dlgdrive) return null;
  // after dlgdrive returns the installer may sit on its last page (TENOKE 2.x does, and it shrugs off SIGTERM): the
  // prefix's wineserver takes every wine process of this install down, so the script, xvfb-run and the exec() return at once
  const ws = wineserverPath(wine) ?? "wineserver";
  // two wine processes starting at once in a prefix that does not exist yet trip over each other (the second one
  // dies with "chdir to /tmp/wine-…/server-…"), so the prefix is initialised on its own first
  const script = [
    `cd "$1" || exit 2`,
    `"$WINE_BIN" wineboot --init >/dev/null 2>&1`,
    `"$WINE_BIN" "$2" >/dev/null 2>&1 & pid=$!`,
    `"$WINE_BIN" "$DLGDRIVE" --dir "$3" --button INSTALL --wait-sec 240 --timeout-sec "$4"; rc=$?`,
    `"$WINESERVER_BIN" -k >/dev/null 2>&1; sleep 1; kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null`,
    `exit $rc`,
  ].join("\n");
  return [xvfb, "-a", "-s", "-screen 0 1280x1024x24", "env", `WINE_BIN=${wine}`, `DLGDRIVE=${dlgdrive}`, `WINESERVER_BIN=${ws}`, bash, "-c", script, "dlgdrive", dirname(installer), basename(installer), winPath(staging), String(minutes * 60)];
}

/* ─────────────────────────── the group's crack ─────────────────────────── */

const GROUP_DIR = CRACK_DIR;
const CRACK_FILE = /^(steam_api(64)?\.(dll|rne|cdx|ini)|steam_emu\.ini|steamclient(64)?\.dll|.*\.rne|.*\.cdx|codex\d*\.ini|cream_api\.ini|cpy\.ini|ali213\.ini|3dmgame\.(dll|ini)|onlinefix.*|goldberg.*|tenoke\.ini|flt\.ini|rune\.ini|eossdk-win64-shipping\.dll|uplay_r[12](_loader)?(64)?\.dll|galaxy(64)?\.dll)$/i;
const NOT_CRACK_DIR = /^(_?_?redist|_commonredist|commonredist|directx|vcredist|support|md5|__installer|installers?|prereqs?|dotnet|physx)$/i;
/** DRM dlls are swapped wherever the game carries a copy (main game + bundled extras) */
const DRM_DLL = /^(steam_api(64)?\.dll|steamclient(64)?\.dll|eossdk-win64-shipping\.dll|uplay_r[12](_loader)?(64)?\.dll|galaxy(64)?\.dll)$/i;
const NOISE = /\.(nfo|diz|url|sfv|md5)$/i;
/** emulator settings live beside the DRM dll they configure */
const EMU_FILE = /\.(ini|rne|cdx)$|^steam_appid\.txt$/i;

/** folders next to the installer that hold the group's crack: named after the group / "Crack", or carrying emulator files */
export async function crackDirs(srcDir: string, group?: string | null): Promise<string[]> {
  const out: string[] = [];
  for (const n of await readdir(srcDir).catch(() => [] as string[])) {
    const p = join(srcDir, n);
    // a folder that is really there: a link named "Crack" would have whatever it points at laid over the game
    if (!(await lstat(p).catch(() => null))?.isDirectory() || NOT_CRACK_DIR.test(n)) continue;
    if (GROUP_DIR.test(n) || (group && n.toLowerCase() === group.toLowerCase())) { out.push(p); continue; }
    const { files } = await scan(p, 2000).catch(() => ({ files: [] as FileInfo[] }));
    if (files.length && files.length <= 200 && files.some(f => CRACK_FILE.test(basename(f.rel)))) out.push(p);
  }
  return out;
}

/**
 * Copy a crack folder over an installed game. A file goes where the same relative path exists; else over
 * same-named files elsewhere in the tree (a flat Crack/steam_api64.dll lands in Game_Data/Plugins/x86_64).
 * A new file whose own folder is one of the game's goes into that folder and nowhere else: a crack that mirrors the
 * game's folders says where each file belongs (RUNE's METAL GEAR SOLID 4 has a steam_api64.rne and a steam_emu.ini of
 * its own in Launcher/…, MGS1/, MGS4/ and MGS4DB/…: following the files of the same name put one folder's copy in all
 * four and the settings in one, 2026-11-11). Any other new file goes next to its siblings, or the game root.
 */
export async function overlayCrack(crackDir: string, target: string): Promise<string[]> {
  const src = (await scan(crackDir)).files.filter(f => !NOISE.test(f.rel));
  const dst = (await scan(target)).files;
  const lc = (s: string) => s.toLowerCase();
  const fileByRel = new Map(dst.map(f => [lc(f.rel), f.rel]));
  const dirByRel = new Map<string, string>([[".", "."]]);
  for (const f of dst) for (let d = posix.dirname(f.rel); d !== "."; d = posix.dirname(d)) dirByRel.set(lc(d), d);
  const byBase = new Map<string, string[]>();
  for (const f of dst) { const k = lc(basename(f.rel)); byBase.set(k, [...(byBase.get(k) ?? []), f.rel]); }
  const suffix = (a: string, b: string) => { const x = lc(a).split("/").reverse(), y = lc(b).split("/").reverse(); let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return i; };

  const placed = new Map<string, Set<string>>();                         // crack-side dir → install-side dir(s)
  const drmAt = new Map<string, Set<string>>();                          // crack-side dir → where its DRM dlls went
  const stemAt = new Map<string, Set<string>>();                         // file stem → where that file went (Game.rne follows Game.exe)
  const stem = (n: string) => lc(basename(n)).replace(/\.[^.]+$/, "");
  const add = (m: Map<string, Set<string>>, k: string, v: string) => m.set(k, (m.get(k) ?? new Set()).add(v));
  const copied: string[] = [];
  const put = async (from: FileInfo, to: string) => {
    await mkdir(dirname(join(target, to)), { recursive: true });
    await copyFile(join(crackDir, from.rel), join(target, to));
    copied.push(to);
    add(placed, posix.dirname(from.rel), posix.dirname(to));
    if (DRM_DLL.test(basename(from.rel))) add(drmAt, posix.dirname(from.rel), posix.dirname(to));
    add(stemAt, stem(from.rel), posix.dirname(to));
  };
  const later: FileInfo[] = [];
  for (const f of src) {
    const exact = fileByRel.get(lc(f.rel));
    if (exact) { await put(f, exact); continue; }
    const same = byBase.get(lc(basename(f.rel))) ?? [];
    if (same.length) {
      if (DRM_DLL.test(basename(f.rel))) { for (const t of same) await put(f, t); continue; }
      const best = [...same].sort((a, b) => suffix(b, f.rel) - suffix(a, f.rel) || a.split("/").length - b.split("/").length)[0];
      await put(f, best);
      continue;
    }
    later.push(f);
  }
  for (const f of later) {
    const home = posix.dirname(f.rel);
    // its own folder is one of the game's: there, and only there
    const mirrored = home === "." ? undefined : dirByRel.get(lc(home));
    if (mirrored) { await put(f, `${mirrored}/${basename(f.rel)}`); continue; }
    // a flat crack: next to wherever its siblings went (every copy)
    const emu = EMU_FILE.test(basename(f.rel)) ? drmAt.get(home) : undefined;
    const dirs = [...(stemAt.get(stem(f.rel)) ?? emu ?? placed.get(home) ?? [dirByRel.get(lc(home)) ?? "."])];
    for (const dir of dirs) await put(f, dir === "." ? basename(f.rel) : `${dir}/${basename(f.rel)}`);
  }
  return copied;
}

/** what an installer leaves at the game root that is not the game (Inno's unins000.*, TENOKE's UNINSTALL.exe) */
const LEFTOVER = /^(unins\d{3}\.(exe|dat|msg)|uninst\.dll|uninstall\.exe)$/i;
export async function dropInstallerLeftovers(target: string): Promise<string[]> {
  const gone: string[] = [];
  for (const n of await readdir(target).catch(() => [] as string[])) if (LEFTOVER.test(n)) { await rm(join(target, n), { force: true }); gone.push(n); }
  return gone;
}

/**
 * The whole scene path: run `installer` (inside `srcDir`) into `staging`, then apply every crack folder found
 * next to it. `prefix` is the WINEPREFIX (in the job's work dir, removed with it).
 */
export async function sceneInstall(ctx: SceneCtx, o: { srcDir: string; installer: string; staging: string; prefix: string; group?: string | null; overlay: boolean }): Promise<{ ok: boolean; reason: string | null }> {
  const exe = join(o.srcDir, o.installer);
  let r = await unpackTenoke(ctx, o.srcDir, o.staging);                 // a package we can read: no installer at all
  if (!r?.ok) {
    const blocker = await wineBlocker(ctx.tools, exe);
    if (blocker) return { ok: false, reason: r ? `${r.reason}; and ${blocker}` : blocker };
    const files = (await scan(o.srcDir, 5000).catch(() => ({ files: [] as FileInfo[] }))).files;   // the installer and its parts, not the crack folder
    const payload = bytesOf(files.filter(f => f.rel === o.installer || (/\.(bin|dat)$/i.test(f.rel) && !f.rel.includes("/"))));
    r = await runInstallerUnderWine(ctx, exe, o.staging, o.prefix, payload);
    if (!r.ok) return r;
  }
  if (o.overlay) {
    for (const dir of await crackDirs(o.srcDir, o.group)) {
      const files = await overlayCrack(dir, o.staging);
      if (files.length) ctx.log(`applied ${basename(dir)}: ${files.length} file(s) — ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}`);
    }
  }
  const gone = await dropInstallerLeftovers(o.staging);
  if (gone.length) ctx.log(`removed installer leftovers: ${gone.join(", ")}`);
  return { ok: true, reason: null };
}
