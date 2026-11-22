/**
 * ludarr — tier 1 of the processor: deterministic recipes.
 *
 *   folder          → copy
 *   archive(s)      → rar: unrar (7z/unar fallback); everything else: 7z (unar fallback); then unwrap whatever was inside, up to three levels
 *   disc image      → 7z opens ISO/UDF images like archives
 *   GOG installer   → innoextract --gog (no execution needed)
 *   scene installer → setup.exe whose parts 7z can read: extract them; else (Inno Setup + unarc) run it
 *                     unattended under wine into staging and lay the group's crack folder over it (scene.ts)
 *   anything else   → not ours: the agent takes over with whatever is in staging
 *
 * Every step is logged into the job transcript; the validator decides if the result is a game.
 *
 * A game folder holds files and folders only. A link an archive carried is removed the moment the archive is unpacked
 * (unpack), and a link in a downloaded folder is not copied (copyIn): the steps after it — another part unpacked over it,
 * the crack laid over it, the copy into the library — run as ludarr itself and would otherwise write or read through it.
 */
import { cp, lstat, mkdir, rm, readdir, rename, stat } from "node:fs/promises";
import { checkpointPath, completed, publishStage, restoreStage } from "./checkpoint";
import { volumesOf } from "./volumes";
import { removeTree } from "../fsutil";
import { isConsole, type PlatformId } from "../platforms";
import { basename, dirname, join, posix } from "node:path";
import { classifyPath, dropLinks, linksDropped, unrunInstaller, SECONDARY_PART, type Classified, type Shape } from "./classify";
import { crackDirs, overlayCrack, pickInstaller, sceneInstall, tenokePackageIn, wineBlocker } from "./scene";
import { inspect, type Validation, inspectRom } from "./validate";
import type { Exec, Toolbox } from "./tools";
import { transportTrouble } from "../transport";

export interface RecipeCtx {
  work?: string;
  exec: Exec; tools: Toolbox; log: (line: string) => void; signal?: AbortSignal;
  progress?: (p: number, msg: string) => void;
}
export interface RecipeResult { ok: boolean; shape: Shape; steps: string[]; validation: Validation | null; reason: string | null; platform?: string | null }

const EXTRACT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const stem = (name: string) => name.replace(/\.(part0*1\.rar|7z\.001|tar\.(gz|bz2|xz|zst)|[a-z0-9]{1,4})$/i, "");

async function exists(p: string) { return stat(p).then(() => true, () => false); }

export async function extractArchive(ctx: RecipeCtx, archive: string, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ").slice(-300);
  const isRar = /\.(rar|r00)$/i.test(archive);
  const opts = { timeoutMs: EXTRACT_TIMEOUT_MS, signal: ctx.signal, maxOutput: 8000 };
  // RAR goes to RARLAB's unrar first: a 7z without the RAR codec only writes the stored entries and refuses the compressed
  // ones ("Unsupported Method"), and unar fails on RAR5 solid archives ("Attempted to read more data than was available").
  // -p- never prompts for a password (a prompt would wait on stdin forever); only a clean exit counts, CRCs included.
  if (isRar && ctx.tools.unrar) {
    const r = await ctx.exec([ctx.tools.unrar, "x", "-y", "-o+", "-p-", archive, outDir.replace(/\/?$/, "/")], opts);
    if (r.code === 0 && !r.timedOut) return;
    const next = ctx.tools.sevenZip ? "7z" : ctx.tools.unar ? "unar" : null;
    if (!next) throw new Error(`unrar failed on ${basename(archive)} (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${tail(r)}`);
    ctx.log(`unrar failed on ${basename(archive)} (exit ${r.code}): ${tail(r)} — trying ${next}`);
  }
  if (ctx.tools.sevenZip) {
    const r = await ctx.exec([ctx.tools.sevenZip, "x", "-y", "-bd", "-bb0", `-o${outDir}`, archive], opts);
    if (r.code === 0 || r.code === 1) return;                       // 1 = warnings only
    if (!(isRar && ctx.tools.unar)) throw new Error(`7z failed on ${basename(archive)} (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${tail(r)}`);
    ctx.log(`7z could not open ${basename(archive)}, trying unar`);
  }
  if (ctx.tools.unar) {
    const r = await ctx.exec([ctx.tools.unar, "-q", "-f", "-o", outDir, archive], opts);
    if (r.code === 0) return;
    throw new Error(`unar failed on ${basename(archive)} (exit ${r.code}): ${tail(r)}`);
  }
  throw new Error(`no archiver on this host (install ${isRar ? "unrar" : "p7zip"})`);
}

/** extractArchive for an import: the links the archive carried are removed at once (see the file header), and said */
export async function unpack(ctx: RecipeCtx, archive: string, outDir: string, log: (line: string) => void = ctx.log): Promise<void> {
  const parts = ctx.work ? [archive, ...await volumesOf(archive)] : [];
  const fingerprint = async () => JSON.stringify(await Promise.all(parts.map(async path => {
    const s = await stat(path);
    return [path, s.size, s.mtimeMs];
  })));
  const key = await fingerprint();
  const saved = ctx.work ? await checkpointPath(ctx.work, "archive:" + key) : null;
  if (saved && await completed(saved)) {
    log(`resuming from the completed extraction of ${basename(archive)}`);
  } else {
    const target = saved ? saved + ".partial" : outDir;
    if (saved) await removeTree(target);
    await extractArchive(ctx, archive, target);
    const gone = await dropLinks(target);
    if (gone.length) log(linksDropped(gone));
    if (saved) {
      if (key !== await fingerprint()) throw new Error("the archive changed while it was being unpacked");
      await publishStage(target, saved);
    }
  }
  if (saved) await restoreStage(saved, outDir, ctx.signal);
}

/**
 * The download copied into `dest` as it is, without the links it holds (`links`: what the look at it found). A copy
 * with none goes the way it always did; one with links is copied entry by entry, each link left out.
 */
export async function copyIn(input: string, dest: string, isDir: boolean, links: string[], log: (line: string) => void): Promise<void> {
  if (!isDir) { await cp(input, dest); return; }
  if (!links.length) { await cp(input, dest, { recursive: true }); return; }
  log(`${links.length} link${links.length === 1 ? "" : "s"} in the download left out (a game folder holds files only): ${links.slice(0, 5).join(", ")}${links.length > 5 ? " …" : ""}`);
  await cp(input, dest, { recursive: true, filter: async src => { if (src === input) return true; const st = await lstat(src).catch(() => null); return !!st && (st.isDirectory() || st.isFile()); } });
}

export async function innoExtract(ctx: RecipeCtx, setupExe: string, outDir: string): Promise<void> {
  if (!ctx.tools.innoextract) throw new Error("innoextract is not installed on this host");
  await mkdir(outDir, { recursive: true });
  const r = await ctx.exec([ctx.tools.innoextract, "--gog", "-s", "-d", outDir, setupExe], { timeoutMs: EXTRACT_TIMEOUT_MS, signal: ctx.signal, maxOutput: 8000 });
  if (r.code !== 0) throw new Error(`innoextract failed on ${basename(setupExe)} (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`);
  // innoextract writes {app} either straight into the output dir or under app/ (varies by installer);
  // everything else at the top level (tmp/, commonappdata/, …) is installer housekeeping, not the game.
  for (const n of await readdir(outDir)) if (INNO_NON_APP.test(n)) await removeTree(join(outDir, n));
  const app = join(outDir, "app");
  if (await exists(app)) {
    for (const n of await readdir(app)) {
      const to = join(outDir, n);
      if (await exists(to)) await removeTree(join(app, n));   // the root copy wins
      else await rename(join(app, n), to);
    }
    await removeTree(app);
  }
  // GOG Galaxy leftovers: not part of the game, and webcache.zip would read as "still packed"
  for (const n of await readdir(outDir)) if (GOG_JUNK.test(n)) await removeTree(join(outDir, n));
}

/** innoextract's top-level dirs for non-{app} destinations */
const INNO_NON_APP = /^(tmp|commonappdata|localappdata|userappdata|userdocs|commondocs|userdesktop|commondesktop|userstartmenu|commonstartmenu|userprograms|commonprograms|userstartup|commonstartup|usertemplates|commontemplates|userfavorites|commonfavorites|userfonts|fonts|windows|system|syswow64|commonfiles|commoncf|usercf|sendto|pf|commonpf)$/i;
const GOG_JUNK = /^(webcache\.zip|webcache|goggame-\d+\.hashdb|goggame-\d+\.script|goggame-galaxyfilelist\.id)$/i;

/** remove the other volumes of a multi-part set once the first one has been extracted */
async function dropSiblings(primary: string) {
  const dir = dirname(primary), s = stem(basename(primary)).toLowerCase();
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (n.toLowerCase().startsWith(s) && SECONDARY_PART.test(n)) await rm(join(dir, n), { force: true });
  }
}

/** extract one item in place: <dir>/<name> → <dir>/<stem>/ (or straight into <dir> when it is the only thing there) */
async function unpackInPlace(ctx: RecipeCtx, abs: string, kind: "archive" | "iso" | "gog"): Promise<void> {
  const dir = dirname(abs);
  const siblings = (await readdir(dir)).filter(n => n !== basename(abs) && !SECONDARY_PART.test(n));
  const target = siblings.length === 0 ? dir : join(dir, stem(basename(abs)));
  ctx.log(`${kind === "gog" ? "innoextract" : "extracting"} ${basename(abs)} → ${basename(target) || "."}`);
  if (kind === "gog") await innoExtract(ctx, abs, target); else await unpack(ctx, abs, target);
  await rm(abs, { force: true });
  await dropSiblings(abs);
  if (kind === "gog") for (const n of await readdir(dir)) if (/^setup_.*\.bin$/i.test(n) || /^setup_.*-\d+\.bin$/i.test(n)) await rm(join(dir, n), { force: true });
}

/** what the first bytes of a payload part say about it: an archive 7z knows, FreeArc's "ArC", or nothing we know */
export async function partSignature(path: string): Promise<"archive" | "freearc" | "tenoke" | "unknown"> {
  const head = Buffer.from(await Bun.file(path).slice(0, 8).arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (head.length < 4) return "unknown";
  if (head.subarray(0, 4).toString("latin1") === "ArC\x01") return "freearc";
  if (head.readUInt32LE(0) === 0xd0d0d3c5) return "tenoke";                                    // the length prefix of a "pakinfo" record (process/tenoke.ts)
  const sig = head.toString("latin1");
  if (/^(7z\xbc\xaf\x27\x1c|PK\x03\x04|Rar!\x1a\x07|MSCF|\xfd7zXZ\x00|\x1f\x8b|BZh[1-9]|\xff\xd8|ustar)/.test(sig)) return "archive";
  return "unknown";
}

/**
 * Retail/scene installers ship their payload as big .bin/.dat parts next to setup.exe. Some of those are
 * plain archives in disguise — when 7z can list every part, extracting them beats running the installer.
 * All-or-nothing: one unreadable part means the installer owns the format and the agent has to take over.
 * The first bytes decide whether 7z is even asked: a FreeArc payload ("ArC", the Inno + unarc.dll scene and
 * repack installers) or TENOKE's container is never 7z's, and 7z scanning a 15 GB part on a network mount for
 * signatures it will not find costs a quarter of an hour.
 */
async function installerParts(ctx: RecipeCtx, c: Classified, abs: (rel: string) => string): Promise<string[]> {
  if (!ctx.tools.sevenZip) return [];
  const parts = c.files.filter(f => /\.(bin|dat)$/i.test(f.rel) && f.rel.split("/").length <= 2 && f.size >= 1_000_000).map(f => f.rel);
  for (const rel of parts) {
    const sig = await partSignature(abs(rel));
    if (sig === "freearc") { ctx.log(`${basename(rel)} is a FreeArc payload (unarc) — only the installer can unpack it`); return []; }
    if (sig === "tenoke") { ctx.log(`${basename(rel)} is a TENOKE package — it is read directly, not run`); return []; }
    if (sig === "unknown") { ctx.log(`${basename(rel)} carries no archive signature — the installer has to be run`); return []; }
    const r = await ctx.exec([ctx.tools.sevenZip, "l", "-ba", abs(rel)], { timeoutMs: 120_000, signal: ctx.signal, maxOutput: 4000 });
    if (r.code !== 0 || !r.stdout.trim()) { ctx.log(`${basename(rel)} is not something 7z can open — the installer has to be run`); return []; }
  }
  return parts;
}

/** lay crack folders that sit inside staging over the game (moved out first, so a file is never copied onto itself) */
async function applyCracksInStaging(ctx: RecipeCtx, dirs: string[], staging: string, log: (s: string) => void) {
  for (const [i, d] of dirs.entries()) {
    const moved = join(dirname(staging), `crack-${i}`);
    await removeTree(moved);
    await rename(d, moved);
    const files = await overlayCrack(moved, staging);
    if (files.length) log(`applied ${basename(d)}: ${files.length} file(s) — ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}`);
    await removeTree(moved);
  }
}

/**
 * staging holds a disc whose installer has to be run: move the disc aside (WORK/disc), install into the now
 * empty staging under wine, crack it. On failure the disc goes back so the agent sees what we saw.
 */
async function installInPlace(ctx: RecipeCtx, staging: string, installerRel: string, group: string | null | undefined, log: (s: string) => void): Promise<boolean> {
  const packaged = !!(await tenokePackageIn(join(staging, posix.dirname(installerRel))));   // TENOKE: read, not run
  const why = packaged ? null : await wineBlocker(ctx.tools, join(staging, installerRel));
  if (why) { log(`${installerRel} has to be run, but ${why}`); return false; }
  const disc = join(dirname(staging), "disc");
  await removeTree(disc);
  await rename(staging, disc);
  await mkdir(staging, { recursive: true });
  const sub = posix.dirname(installerRel);
  log(packaged ? `${installerRel} carries the game as a TENOKE package — unpacking it (disc moved to WORK/disc)` : `${installerRel} carries the game in a format only the installer can read — installing it (disc moved to WORK/disc)`);
  const r = await sceneInstall(ctx, {
    srcDir: sub === "." ? disc : join(disc, sub), installer: basename(installerRel), staging,
    prefix: join(dirname(staging), "wine"), group, overlay: true,
  });
  if (r.ok) return true;
  log(`unattended install failed: ${r.reason} — the disc contents go back to staging`);
  await removeTree(staging);
  await rename(disc, staging);
  return false;
}

/** an error whose own code is the read path's (ludarr's own copy from the seedbox's folder failing with EIO, a stale handle,
 *  a timeout) is thrown as it is, never turned into a recipe that gave up: the runner judges it against the folder with its
 *  code (src/remote.ts) — as words only, it would be one confirming re-run away from blocklisting a good copy */
const rethrowTransport = (e: unknown) => { if (transportTrouble(e, { words: false })) throw e; };

export async function deterministic(input: string, staging: string, ctx: RecipeCtx, hints: { name: string; group?: string | null; platform?: PlatformId | string | null; consoles?: string[] }): Promise<RecipeResult> {
  const steps: string[] = [];
  const log = (s: string) => { steps.push(s); ctx.log(s); };
  const c: Classified = await classifyPath(input);
  log(`input: ${c.shape} — ${c.why} (${(c.totalSize / 1e9).toFixed(2)} GB, ${c.files.length} files)`);
  await removeTree(staging);
  await mkdir(staging, { recursive: true });
  const abs = (rel: string) => (c.isDir ? join(input, rel) : input);
  const fail = (reason: string, validation: Validation | null = null): RecipeResult => ({ ok: false, shape: c.shape, steps, validation, reason });
  const rom = isConsole((hints.platform ?? null) as PlatformId | null);

  // a console dump: archives are unpacked, disc images and packages are kept whole (they are the game), nothing is ever run
  if (rom) {
    try {
      if (c.shape === "archive") { for (const rel of c.archives) { log(`extracting ${rel}`); await unpack(ctx, abs(rel), c.archives.length === 1 ? staging : join(staging, stem(basename(rel))), log); } }
      else { log(`console dump for ${hints.platform}: copying as it is`); await copyIn(input, join(staging, basename(input)), c.isDir, c.links, log); }
      for (let round = 0; round < 3; round++) {
        const inner = await classifyPath(staging);
        if (inner.shape !== "archive") break;
        for (const rel of inner.archives) await unpackInPlace(ctx, join(staging, rel), "archive");
      }
    } catch (e: any) { rethrowTransport(e); return fail(String(e?.message ?? e)); }
    const v = await inspectRom(staging);
    if (!v.ok) { log(`validator: ${v.problems.join("; ")}`); return fail(v.problems.join("; "), v); }
    log(`validator: ok — ${hints.platform} dump ${v.launch}, ${v.fileCount} files, ${(v.totalSize / 1e9).toFixed(2)} GB`);
    return { ok: true, shape: c.shape, steps, validation: v, reason: null, platform: String(hints.platform) };
  }

  try {
    switch (c.shape) {
      case "folder":
        log("copying game files into staging");
        await copyIn(input, join(staging, basename(input)), c.isDir, c.links, log);
        break;
      case "archive":
        for (const rel of c.archives) {
          const target = c.archives.length === 1 ? staging : join(staging, stem(basename(rel)));
          log(`extracting ${rel}`);
          await unpack(ctx, abs(rel), target, log);
        }
        break;
      case "iso":
        for (const rel of c.isos) {
          const target = c.isos.length === 1 ? staging : join(staging, stem(basename(rel)));
          log(`opening disc image ${rel}`);
          await unpack(ctx, abs(rel), target, log);
        }
        break;
      case "gog-installer":
        for (const rel of c.installers) {
          log(`innoextract ${rel}`);
          await innoExtract(ctx, abs(rel), c.installers.length === 1 ? staging : join(staging, stem(basename(rel))));
        }
        break;
      case "installer": {
        const parts = await installerParts(ctx, c, abs);
        if (parts.length) {
          for (const rel of parts) { log(`installer payload ${rel} is a plain archive — extracting it instead of running ${c.installers[0]}`); await unpack(ctx, abs(rel), staging, log); }
          if (c.isDir) {
            for (const d of await crackDirs(dirname(abs(c.installers[0])), hints.group)) {
              const files = await overlayCrack(d, staging);
              if (files.length) log(`applied ${basename(d)}: ${files.length} file(s) — ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}`);
            }
          }
          break;
        }
        const exe = pickInstaller(c.installers);
        const r = exe
          ? await sceneInstall(ctx, { srcDir: dirname(abs(exe)), installer: basename(abs(exe)), staging, prefix: join(dirname(staging), "wine"), group: hints.group, overlay: c.isDir })
          : { ok: false, reason: null };
        if (!r.ok) {
          await removeTree(staging); await mkdir(staging, { recursive: true });
          return fail(`only an installer (${c.installers.join(", ")}) — nothing to extract, it has to be run${r.reason ? ` (${r.reason})` : ""}`);
        }
        break;
      }
      default:
        // nothing a PC importer knows what to do with — a console game's dump looks exactly like that: keep it as it is when it is one
        if (hints.consoles?.length) {
          log(`${c.why} — the game is on ${hints.consoles.join(", ")}: keeping it as a dump if it is one`);
          await copyIn(input, join(staging, basename(input)), c.isDir, c.links, log);
          const rv = await inspectRom(staging);
          if (rv.ok) { log(`validator: ok — ${hints.consoles[0]} dump ${rv.launch}, ${rv.fileCount} files, ${(rv.totalSize / 1e9).toFixed(2)} GB`); return { ok: true, shape: c.shape, steps, validation: rv, reason: null, platform: hints.consoles[0] }; }
          return fail(`${c.why}; not a console dump either: ${rv.problems.join("; ")}`, rv);
        }
        return fail(c.why);
    }

    // whatever came out may itself be packaging: archives in an ISO, an installer in an archive …
    for (let round = 0; round < 3; round++) {
      const inner = await classifyPath(staging);
      if (inner.shape === "archive") { for (const rel of inner.archives) await unpackInPlace(ctx, join(staging, rel), "archive"); continue; }
      if (inner.shape === "iso") { for (const rel of inner.isos) await unpackInPlace(ctx, join(staging, rel), "iso"); continue; }
      if (inner.shape === "gog-installer") { for (const rel of inner.installers) await unpackInPlace(ctx, join(staging, rel), "gog"); continue; }
      // a scene ISO: setup.exe + parts (+ the group's crack folder, whose patched exe makes the shape read "folder")
      const pending = inner.shape === "installer" ? (pickInstaller(inner.installers) ?? inner.installers[0])
        : inner.shape === "folder" ? unrunInstaller(inner.files)?.exe ?? null : null;
      if (!pending) break;
      const sub = posix.dirname(pending);
      const cracks = await crackDirs(sub === "." ? staging : join(staging, sub), hints.group);
      const parts = await installerParts(ctx, inner, rel => join(staging, rel));
      if (parts.length) {
        for (const rel of parts) { log(`installer payload ${rel} is a plain archive — extracting it instead of running ${basename(pending)}`); await unpack(ctx, join(staging, rel), staging, log); await rm(join(staging, rel), { force: true }); }
        for (const rel of inner.installers) await rm(join(staging, rel), { force: true });
        await applyCracksInStaging(ctx, cracks, staging, log);
        continue;
      }
      await installInPlace(ctx, staging, pending, hints.group, log);
      break;
    }
  } catch (e: any) {
    rethrowTransport(e);
    return fail(String(e?.message ?? e));
  }

  const v = await inspect(staging, { name: hints.name });
  if (!v.ok && !v.launch && hints.consoles?.length) {
    // nothing to launch on a PC, but the game is a console game: a dump for one of its consoles is kept as it is
    const rv = await inspectRom(staging);
    if (rv.ok) { log(`validator: no PC game inside, a ${hints.consoles[0]} dump instead — kept as it is (${rv.launch})`); return { ok: true, shape: c.shape, steps, validation: rv, reason: null, platform: hints.consoles[0] }; }
  }
  if (!v.ok) { log(`validator: ${v.problems.join("; ")}`); return fail(v.problems.join("; "), v); }
  await removeTree(join(dirname(staging), "disc"));   // an installed disc is not needed any more
  log(`validator: ok — launch ${v.launch}, ${v.fileCount} files, ${(v.totalSize / 1e9).toFixed(2)} GB${v.prerequisites.length ? `, ${v.prerequisites.length} prerequisite installer(s)` : ""}`);
  return { ok: true, shape: c.shape, steps, validation: v, reason: null };
}
