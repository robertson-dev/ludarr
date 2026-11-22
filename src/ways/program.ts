/**
 * ludarr — getting a plan's program: the Windows build every player of the way gets, exactly as the plan pins it; and
 * placing kept files (a game file, a kept build) into an install folder without copying them when a hard link does.
 *
 *   release  a GitHub / forgejo release asset picked by the plan's pattern. Once pinned: that file and no other (its
 *            size and sha256 must match; a file changed under the same tag fails loudly and marks the plan broken).
 *            Unpinned, or asked to repin: the newest release the channel allows; when GitHub lists a sha256 digest for
 *            the asset the download must match it; a release GitHub does not mark immutable is logged
 *   feed     a project's own update feed (Dolphin), pinned by the sha256 taken while downloading (the feed gives none)
 *   url      one fixed https file whose sha256 the plan names
 *   source   built from the repo by the build job (wave 2): <config>/ways/builds/<pinned asset>, else it fails
 *
 * Every download goes through publicFetch (the address and every redirect must be public) straight to disk, with an
 * 8 GB cap, hashed on the way. Downloads are kept by sha256 in <config>/ways/cache, least recently used out first
 * (WAYS_CACHE_GB; 0 keeps none), so the next build of the same pin downloads nothing. The file is then unpacked in the
 * build sandbox: an archive (zip, 7z, rar, tar), a self-extracting .exe (7z sees an archive in it), or a bare program
 * copied as it is. An installer (Inno Setup, NSIS, MSI) is taken only when the plan's setup runs it — nothing here
 * clicks through one. A program that unpacks to a link (symbolic or hard) is refused: it could point anywhere.
 *
 * The new pin is returned, not stored: assemble stores it once the way is built, so a failed build of a newer
 * release leaves the plan on the program its packages carry. What goes wrong says what kind of failure it is (its
 * `fail`, src/ways/errors.ts): a host that does not answer is this server's trouble for now, a pin the host no longer has
 * is the plan's, a program not built yet asks for its build.
 *
 * Placing (placeContent, used by assembly, a build per game and the AI's dry run): a file kept in the content store goes
 * into an install folder as a hard link when the store and the folder share a volume and hard links work there (a test
 * link decides that once per volume, and the answer is logged), else as a copy hashed on the way, the bytes of total told
 * as it goes; a folder goes as a tree of links. A link is made only to a file no build user can write (with the sandbox it
 * is made read-only first), and every link ludarr places is noted by its device and inode and the folder it was placed
 * in: refuseLinks accepts exactly those and refuses every other link.
 */
import type { Stats } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { cfgNum, configDir } from "../config";
import { fileChunks } from "../fsutil";
import { latestRelease, RateLimited } from "../catalog/github";
import type { RuntimeRelease } from "../catalog/types";
import { PublicUrlError, publicFetch } from "../net/public-url";
import { extractArchive } from "../process/recipes";
import { isInnoSetup, isNsisInstaller } from "../process/scene";
import { pdeps } from "../process/deps";
import type { Exec, Toolbox } from "../process/tools";
import { NeedsFiles, PlanFault } from "./errors";
import { handTo, SANDBOX_UIDS, sandboxAvailable, sandboxed, sbdeps } from "./sandbox";
import { contentHashes, contentStat, planPinned, planSpec, wstmts, type ContentRow, type PlanRow } from "./store";
import { placedName, safeRelPath, storeName } from "./validate";
import type { FailInfo, PinnedProgram, RuntimePlanSpec } from "./types";

/** the largest program download (a whole emulator with its Qt runtime is a few hundred MB; 8 GB is far past any) */
export const PROGRAM_MAX_BYTES = 8 * 2 ** 30;

/** swapped in tests: the release lookup and the toolbox (downloads go through src/net/public-url.ts's own ndeps) */
export const prdeps = {
  latestRelease: (repo: string, pattern?: string | null, channel?: string | null): Promise<RuntimeRelease | null> => latestRelease(repo, pattern, channel),
  tools: (): Toolbox => pdeps.tools(),
};

export const waysDir = () => join(configDir(), "ways");
/** downloaded programs by sha256 */
export const cacheDir = () => join(waysDir(), "cache");
/** source plans' built programs (the build job writes them; assemble only reads) */
export const buildsDir = () => join(waysDir(), "builds");
/** native helpers built from a plan's repo: <tools>/<plan slug>/<commit>/ with a tools.json {ref, commit} (wave 2) */
export const toolsDir = () => join(waysDir(), "tools");

/** a host that did not answer, or answered with something broken: this server's trouble for now, looked at again later */
const NET: FailInfo = { class: "env", kind: "net" };
/** the program is built on this server first (the build job), then the way is built again */
const NEEDS_BUILD: FailInfo = { class: "other", kind: "needs-build" };

export class ProgramError extends Error {
  /** `why`: what kind of failure it is (src/ways/errors.ts failOf reads `fail`); the plan's, unless said otherwise */
  constructor(msg: string, private readonly why: FailInfo = { class: "plan" }) { super(msg); }
  get fail(): FailInfo { return this.message === "cancelled" ? { class: "cancelled" } : { ...this.why }; }
}

export interface AcquireOpts {
  /** the job's scratch folder: the download lands in <work>/dl, the unpacked program in <work>/program */
  work: string;
  repin?: boolean;
  signal?: AbortSignal;
  log: (line: string) => void;
  /** 0..1 with an admin-facing message */
  progress?: (p: number, message: string) => void;
}
export interface Acquired {
  /** the unpacked program (the plan's root is picked inside it by the caller) */
  dir: string;
  pinned: PinnedProgram;
  /** a new pin (the first, or a repin): the caller stores it once the build succeeds */
  fresh: boolean;
  /** the files of a kept build placed into dir by links, each with its sha256 when it can be trusted (src/ways/build.ts) */
  files?: PlacedFile[];
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const nowSec = () => Math.floor(Date.now() / 1000);
const errText = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e);

/** the plan stops building until the admin looks at it (a check or an edit makes it ready again) */
function breakPlan(plan: PlanRow, note: string): never {
  try { wstmts.setPlanStatus.run("broken", note, plan.id); } catch { /* the failure below says it anyway */ }
  throw new ProgramError(note);
}

export async function acquireProgram(plan: PlanRow, o: AcquireOpts): Promise<Acquired> {
  const spec = planSpec(plan), prog = spec.program, pinned = planPinned(plan);
  const dl = join(o.work, "dl"), out = join(o.work, "program");
  await rm(out, { recursive: true, force: true });
  await mkdir(dl, { recursive: true });
  await mkdir(out, { recursive: true });
  let file: string, pin: PinnedProgram, fresh = false;

  if (prog.kind === "source") {
    // a build that needs the game file is made once per way (wave 2), never shared through the plan's builds
    if (prog.content === "build") throw new ProgramError("needs a build for this game (the build job runs the plan's recorded steps with its game file)", NEEDS_BUILD);
    if (!pinned) throw new ProgramError("needs a build (the build job runs the plan's recorded steps)", NEEDS_BUILD);
    const built = join(buildsDir(), storeName(pinned.asset));
    const st = await stat(built).catch(() => null);
    if (!st?.isFile()) throw new ProgramError("needs a build (the build job runs the plan's recorded steps)", NEEDS_BUILD);
    file = join(dl, storeName(pinned.asset));
    const sum = await copyHashed(built, file, o.signal);
    if (sum.size !== pinned.size || sum.sha256 !== pinned.sha256) throw new ProgramError("the built program is not the one pinned (its size or sha256 changed); build the plan again", NEEDS_BUILD);
    o.log(`program: the build of ${pinned.tag} (${mb(sum.size)}, sha256 ${sum.sha256.slice(0, 12)}…)`);
    pin = pinned;
  } else if (pinned && !o.repin) {
    file = await fetchPinned(plan, pinned, dl, o);
    pin = pinned;
  } else {
    let url: string, name: string, size: number | null, digest: string | null = null, tag: string, immutable: boolean | null = null;
    if (prog.kind === "url") {
      url = prog.url; name = storeName(decodeURIComponent(new URL(prog.url).pathname.split("/").pop() || "program")); size = null; tag = "url";
    } else {
      const repo = prog.kind === "feed" ? prog.feed : plan.repo;
      let rel: RuntimeRelease | null;
      try { rel = await prdeps.latestRelease(repo, prog.kind === "release" ? prog.assetPattern : null, prog.kind === "release" ? prog.channel : "stable"); }
      catch (e) {
        if (e instanceof RateLimited) throw new ProgramError("GitHub's hourly limit: set a GitHub token in Settings → General", NET);
        if (o.signal?.aborted) throw new Error("cancelled");
        if (e instanceof PublicUrlError) throw e;                              // the repo's own address is refused: the plan's
        throw new ProgramError(errText(e), NET);                               // the host did not answer as it should
      }
      if (o.signal?.aborted) throw new Error("cancelled");
      if (!rel) breakPlan(plan, prog.kind === "feed" ? "the update feed lists no build" : `${plan.repo} has no releases`);
      if (!rel.asset) breakPlan(plan, prog.kind === "feed" ? `the update feed has no Windows build in ${rel.tag}` : `the plan's asset pattern picks nothing in ${rel.tag}`);
      url = rel.asset.url; name = storeName(rel.asset.name); size = rel.asset.size > 0 ? rel.asset.size : null; digest = rel.asset.digest ?? null; tag = rel.tag; immutable = rel.immutable ?? null;
      if (immutable === false) o.log(`warning: release ${tag} is not immutable on GitHub — its files can be replaced under the same tag; the pin (size and sha256) catches a change`);
    }
    o.log(`program: ${name} from ${tag}${size ? ` (${mb(size)})` : ""}`);
    file = join(dl, name);
    const sum = await download(url, file, o);
    if (size !== null && sum.size !== size) throw new ProgramError(`the download is ${sum.size} bytes, and the release lists ${size}`, NET);
    if (digest) {
      const m = /^sha256:([0-9a-f]{64})$/i.exec(digest);
      if (m && m[1].toLowerCase() !== sum.sha256) { await rm(file, { force: true }); throw new ProgramError(`the download does not match the sha256 the host lists for ${name} (${sum.sha256.slice(0, 12)}… against ${m[1].slice(0, 12).toLowerCase()}…)`, NET); }
      if (!m) o.log(`the host's digest for ${name} (${digest.split(":")[0]}) is not one ludarr checks`);
      else o.log("sha256 matches the host's own digest");
    }
    if (prog.kind === "url" && sum.sha256 !== prog.sha256) { await rm(file, { force: true }); throw new ProgramError(`the file at the plan's address is not the one it names (sha256 ${sum.sha256.slice(0, 12)}…, the plan says ${prog.sha256.slice(0, 12)}…)`); }
    pin = { tag, asset: name, url, size: sum.size, sha256: sum.sha256, digest, immutable, pinnedAt: nowSec() };
    fresh = true;
    await putCache(file, sum.sha256, sum.size, o.log);
  }

  if (o.signal?.aborted) throw new Error("cancelled");
  o.progress?.(1, "unpacking the program");
  await unpack(file, pin.asset, out, spec, o);
  await refuseLinks(out, "the program");
  return { dir: out, pinned: pin, fresh };
}

/** the pinned file: from the cache when it holds it (checked again), else downloaded and held to the pin */
async function fetchPinned(plan: PlanRow, pinned: PinnedProgram, dl: string, o: AcquireOpts): Promise<string> {
  const file = join(dl, storeName(pinned.asset));
  const cached = await getCache(pinned.sha256, pinned.size);
  if (cached) {
    let last = 0;
    const sum = await copyHashed(cached, file, o.signal, done => { if (Date.now() - last >= 1000) { last = Date.now(); o.progress?.(Math.min(0.99, done / Math.max(1, pinned.size)), `getting the program · kept on the server · ${mb(done)} of ${mb(pinned.size)}`); } }).catch(() => null);
    if (o.signal?.aborted) throw new Error("cancelled");
    if (sum && sum.sha256 === pinned.sha256 && sum.size === pinned.size) { o.log(`program: ${pinned.asset} from ${pinned.tag}, kept on the server (sha256 ${pinned.sha256.slice(0, 12)}…)`); return file; }
    o.log("the kept copy of the program is damaged — downloading it again");
    await rm(cached, { force: true }).catch(() => {});
  }
  o.log(`program: ${pinned.asset} from ${pinned.tag} (pinned, ${mb(pinned.size)})`);
  let sum: { size: number; sha256: string };
  try { sum = await download(pinned.url, file, o); }
  catch (e) {
    if (e instanceof ProgramError && /HTTP 404|HTTP 410/.test(e.message)) breakPlan(plan, "the pinned release file is gone from its host; check the plan and repin it");
    throw e;
  }
  if (sum.size !== pinned.size || sum.sha256 !== pinned.sha256) { await rm(file, { force: true }); breakPlan(plan, "the release file changed since it was pinned; check the plan"); }
  await putCache(file, sum.sha256, sum.size, o.log);
  return file;
}

/** one download to disk through publicFetch, sha256 on the way, refused past the cap. A host that does not answer, or
 *  breaks off, is this server's trouble for now (env); an address that is not public is refused as it is */
export async function download(url: string, dest: string, o: { signal?: AbortSignal; progress?: (p: number, message: string) => void; what?: string }, maxBytes = PROGRAM_MAX_BYTES): Promise<{ size: number; sha256: string }> {
  const what = o.what ?? "the program";
  let res: Response;
  try { res = await publicFetch(url, { signal: o.signal, maxRedirects: 5, headers: { "User-Agent": "ludarr", Accept: "application/octet-stream" } }); }
  catch (e) {
    if (o.signal?.aborted) throw new Error("cancelled");
    if (e instanceof PublicUrlError) {
      // a name that does not resolve is the network's state now; an address that is not public is the plan's
      if (/does not resolve/.test(e.message)) Object.defineProperty(e, "fail", { value: NET, enumerable: false });
      throw e;
    }
    throw new ProgramError(`the download failed: ${errText(e)}`, NET);
  }
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* nothing to drain */ } throw new ProgramError(`the download answered HTTP ${res.status}`, NET); }
  const len = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(len) && len > maxBytes) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new ProgramError(`${what} is ${mb(len)}, more than the ${mb(maxBytes)} ${what === "the program" ? "a program" : "a download"} may be`); }
  const h = new Bun.CryptoHasher("sha256");
  const fh = await open(dest, "w");
  let total = 0, last = 0;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new ProgramError(`${what} is more than the ${mb(maxBytes)} ${what === "the program" ? "a program" : "a download"} may be`); }
        h.update(value);
        await fh.write(value);
        if (o.progress && Date.now() - last > 1000) { last = Date.now(); o.progress(Number.isFinite(len) && len > 0 ? Math.min(0.99, total / len) : 0.5, `downloading ${what} · ${mb(total)}${Number.isFinite(len) && len > 0 ? ` of ${mb(len)}` : ""}`); }
      }
    }
  } catch (e) {
    await fh.close().catch(() => {}); await rm(dest, { force: true }).catch(() => {});
    if (o.signal?.aborted) throw new Error("cancelled");
    if (e instanceof ProgramError) throw e;
    throw new ProgramError(`the download broke off after ${mb(total)}: ${errText(e)}`, NET);
  }
  await fh.close();
  return { size: total, sha256: h.digest("hex") };
}

/** a copy made by ludarr with its sha256 taken on the way (a kept or built program is checked again before it is used;
 *  a placed file is hashed as it is written, so it is never read again to be hashed): the bytes so far are told as it
 *  goes, and a cancel stops it between chunks. `flag` "wx" never writes over anything */
export async function copyHashed(from: string, to: string, signal?: AbortSignal, onBytes?: (done: number) => void, flag: "w" | "wx" = "w"): Promise<{ size: number; sha256: string }> {
  const h = new Bun.CryptoHasher("sha256");
  const fh = await open(to, flag);
  let size = 0;
  try {
    if (signal?.aborted) throw new Error("cancelled");
    for await (const chunk of fileChunks(from)) {
      size += chunk.byteLength;
      h.update(chunk);
      for (let off = 0; off < chunk.byteLength;) { const { bytesWritten } = await fh.write(chunk, off, chunk.byteLength - off); off += bytesWritten; }
      onBytes?.(size);
      if (signal?.aborted) throw new Error("cancelled");
    }
  } finally { await fh.close(); }
  return { size, sha256: h.digest("hex") };
}

/* ─────────── the cache ─────────── */

const cacheCap = () => Math.max(0, cfgNum("WAYS_CACHE_GB", 20)) * 2 ** 30;

/** a kept download, when it is there (with the right size, when the size is known): its use counts as recent */
export async function getCache(sha256: string, size?: number | null): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const p = join(cacheDir(), sha256);
  const st = await stat(p).catch(() => null);
  if (!st?.isFile() || (size != null && st.size !== size)) return null;
  const now = new Date();
  await utimes(p, now, now).catch(() => {});
  return p;
}

/** keep a verified download; then the oldest kept ones go until the cache fits WAYS_CACHE_GB again */
export async function putCache(file: string, sha256: string, size: number, log: (line: string) => void): Promise<void> {
  const cap = cacheCap();
  if (cap <= 0) return;
  if (size > cap) { log(`not kept on the server: the file is larger than the program cache (${mb(cap)})`); return; }
  try {
    await mkdir(cacheDir(), { recursive: true });
    const target = join(cacheDir(), sha256);
    if (!(await stat(target).catch(() => null))) {
      const tmp = join(cacheDir(), `.in-${sha256}-${process.pid}-${Date.now()}`);
      await copyFile(file, tmp);
      await rename(tmp, target);
    }
    await evictCache(cap, sha256);
  } catch (e: any) { log(`the file could not be kept on the server: ${e?.message ?? e}`); }
}

/** least recently used first, never `keep`; left-over partial copies older than an hour go too */
export async function evictCache(cap = cacheCap(), keep?: string): Promise<string[]> {
  const dir = cacheDir();
  const entries: { name: string; size: number; at: number }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const st = await stat(join(dir, name)).catch(() => null);
    if (!st?.isFile()) continue;
    if (name.startsWith(".in-")) { if (Date.now() - st.mtimeMs > 3600_000) await rm(join(dir, name), { force: true }).catch(() => {}); continue; }
    if (/^[0-9a-f]{64}$/.test(name)) entries.push({ name, size: st.size, at: st.mtimeMs });
  }
  entries.sort((a, b) => a.at - b.at);
  let total = entries.reduce((a, e) => a + e.size, 0);
  const gone: string[] = [];
  for (const e of entries) {
    if (total <= cap) break;
    if (e.name === keep) continue;
    await rm(join(dir, e.name), { force: true }).catch(() => {});
    total -= e.size;
    gone.push(e.name);
  }
  return gone;
}

/* ─────────── unpacking ─────────── */

const ARCHIVE = /\.(zip|7z|rar|tar|tgz|txz|tbz2?|tar\.(gz|xz|bz2|zst))$/i;
/** what 7z reports for an archive behind a self-extracting stub (a plain program is Type = PE) */
const SFX_TYPE = /^(7z|zip|rar|rar5|cab|arj|lzh|xz|gzip|bzip2|tar)$/i;

/** the archive type `7z l -slt` reports for the file itself (the block before the entry list), or null */
function archiveType(listing: string): string | null {
  const head = listing.split(/\r?\n-{10,}\r?\n/)[0] ?? "";
  return /^Type = (.+)$/m.exec(head)?.[1].trim() ?? null;
}

async function unpack(file: string, name: string, out: string, spec: RuntimePlanSpec, o: AcquireOpts): Promise<void> {
  const tools = prdeps.tools();
  const exec: Exec = sandboxed(o.work);
  const ctx = { exec, tools, log: o.log, signal: o.signal };
  const runsSetup = spec.setup.some(s => "run" in s);
  const asIs = async (why: string) => { o.log(`${name}: ${why}`); await copyFile(file, join(out, storeName(name))); };
  await handTo(out, "builder");
  try {
    if (ARCHIVE.test(name)) {
      o.log(`unpacking ${name}`);
      await extractArchive(ctx, file, out);
      await innerTar(name, out, ctx);
    } else if (/\.(exe|msi)$/i.test(name)) {
      const installer = /\.msi$/i.test(name) ? "an MSI package"
        : (await isInnoSetup(file).catch(() => false)) ? "an Inno Setup installer"
        : (await isNsisInstaller(file).catch(() => false)) ? "an NSIS installer" : null;
      if (installer) {
        if (!runsSetup) throw new ProgramError("the release is an installer; the plan needs setup steps that run it headless");
        await asIs(`${installer}, copied as it is for the plan's setup to run`);
      } else if (!tools.sevenZip) await asIs("a program, copied as it is (7z is not here to look inside it)");
      else {
        const r = await exec([tools.sevenZip, "l", "-slt", file], { timeoutMs: 120_000, signal: o.signal, maxOutput: 200_000 });
        const type = r.code === 0 ? archiveType(r.stdout) : null;
        if (type && SFX_TYPE.test(type)) { o.log(`${name} is a self-extracting ${type} archive — unpacking it`); await extractArchive(ctx, file, out); }
        else await asIs("a program, copied as it is");
      }
    } else await asIs("copied as it is");
  } finally { await handTo(out, "root"); }
  if (!(await readdir(out).catch(() => [] as string[])).length) throw new ProgramError(`${name} unpacked to nothing`);
}

/** a .tar.gz unpacks to its .tar first */
async function innerTar(name: string, out: string, ctx: { exec: Exec; tools: Toolbox; log: (l: string) => void; signal?: AbortSignal }) {
  if (!/\.(tgz|txz|tbz2?|tar\.(gz|xz|bz2|zst))$/i.test(name)) return;
  const inner = (await readdir(out).catch(() => [] as string[])).filter(n => /\.tar$/i.test(n));
  if (inner.length !== 1) return;
  const tar = join(out, inner[0]);
  await extractArchive(ctx, tar, out);
  await rm(tar, { force: true });
}

/* ─────────── links ─────────── */

/** the hard links ludarr itself placed: "<dev>:<ino>" → the folders they were placed under */
const placedLinks = new Map<string, Set<string>>();
const inodeKey = (st: { dev: number; ino: number }) => `${st.dev}:${st.ino}`;
/** whether `abs` is `dir` or inside it */
export function within(abs: string, dir: string): boolean {
  const a = resolve(abs), d = resolve(dir);
  return a === d || a.startsWith(d.endsWith(sep) ? d : d + sep);
}
/** a hard link placeContent made under `scope` (the folder it was placed in, or the job's scratch folder holding it):
 *  refuseLinks accepts that inode there, and only there */
export function notePlaced(scope: string, st: { dev: number; ino: number }): void {
  const k = inodeKey(st);
  let s = placedLinks.get(k);
  if (!s) placedLinks.set(k, (s = new Set()));
  s.add(resolve(scope));
}
/** whether `abs` is one of the links ludarr placed: its device and inode noted, under the folder it was noted for */
export function isPlacedLink(abs: string, st: { dev: number; ino: number }): boolean {
  const s = placedLinks.get(inodeKey(st));
  if (!s) return false;
  for (const scope of s) if (within(abs, scope)) return true;
  return false;
}
/** a job is over: the links it placed under `scope` are not accepted any more */
export function forgetPlaced(scope: string): void {
  for (const [k, s] of placedLinks) {
    for (const d of [...s]) if (within(d, scope)) s.delete(d);
    if (!s.size) placedLinks.delete(k);
  }
}

/** refuse a tree that holds a symbolic link, or a hard link ludarr did not place itself (either could make a package
 *  carry a file from outside it); `allow` says which multi-linked files are ludarr's own (default: the ones it noted) */
export async function refuseLinks(dir: string, what: string, o: { allow?: (abs: string, st: { dev: number; ino: number }) => boolean } = {}): Promise<void> {
  const allow = o.allow ?? isPlacedLink;
  const walk = async (p: string, rel: string) => {
    for (const n of await readdir(p)) {
      const full = join(p, n), r = rel ? `${rel}/${n}` : n;
      const st = await lstat(full);
      if (st.isSymbolicLink()) throw new ProgramError(`${what} holds a link (${r}), and a package carries files only`);
      if (st.isDirectory()) await walk(full, r);
      else if (!st.isFile()) throw new ProgramError(`${what} holds something that is not a file (${r})`);
      else if (st.nlink > 1 && !allow(full, st)) throw new ProgramError(`${what} holds a hard link (${r}), and a package carries files of its own only`);
    }
  };
  await walk(dir, "");
}

/** swapped in tests: how a hard link is made (a test makes it fail, as it does across volumes or on a share without them) */
export const pldeps = {
  link: (from: string, to: string): Promise<void> => link(from, to),
};

/** each volume's answer: do hard links work there (and why not) */
const probes = new Map<string, Promise<{ ok: boolean; why: string | null }>>();
async function probeLinks(dir: string): Promise<{ ok: boolean; why: string | null }> {
  const a = join(dir, `.link-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), b = `${a}-link`;
  try {
    await writeFile(a, "ludarr", { flag: "wx" });
    await pldeps.link(a, b);
    const st = await lstat(a);
    return st.nlink >= 2 ? { ok: true, why: null } : { ok: false, why: "a test link left the file with one name" };
  } catch (e: any) { return { ok: false, why: String(e?.code ?? e?.message ?? e) }; }
  finally { await rm(b, { force: true }).catch(() => {}); await rm(a, { force: true }).catch(() => {}); }
}
/**
 * Whether hard links work on the volume `dir` is on: a test link in `dir` (the job's scratch folder, beside the content
 * store) decides it once per volume, and the answer is logged then. Without them every placement is a copy.
 */
export async function linksWork(dir: string, log?: (line: string) => void): Promise<boolean> {
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) return false;
  const key = String(st.dev);
  const known = probes.get(key);
  if (known) return (await known).ok;
  const p = probeLinks(dir);
  probes.set(key, p);
  const r = await p;
  const line = r.ok
    ? `hard links work on the volume of ${dir}: game files are linked into packages, never copied`
    : `hard links do not work on the volume of ${dir} (${r.why}): game files are copied into packages`;
  // the job's log, which goes to the server's log too; the server's log alone when no job asked
  if (log) log(line); else pdeps.log(line);
  return r.ok;
}
/** tests: each volume is probed again */
export const forgetLinkProbes = () => probes.clear();

/**
 * Whether a link may be made to this kept file: never to one a build user owns (it could have changed it), and with the
 * sandbox the file is made read-only for everyone first (root's store files are never written in place), so no program
 * handed a folder it is linked into can change the store's own bytes. Without the sandbox there is no build user.
 */
async function linkableFile(path: string, st: Stats, log?: (line: string) => void): Promise<boolean> {
  if (!sandboxAvailable()) return true;
  if (SANDBOX_UIDS.includes(st.uid)) { log?.(`${basename(path)} belongs to a build user on this server: it is not linked`); return false; }
  const perms = st.mode & 0o7777;
  if (perms & 0o7222) { await sbdeps.chmod(path, perms & 0o555); log?.(`${basename(path)} is read-only now (it was ${perms.toString(8)})`); }
  return true;
}
/** every entry of a kept folder made read-only for the build users, or refused when one of them wrote an entry */
export async function readOnlyTree(dir: string, log?: (line: string) => void): Promise<void> {
  if (!sandboxAvailable()) return;
  let fixed = 0;
  const walk = async (p: string, rel: string) => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) throw new NeedsFiles(`${rel || basename(p)} in the kept game folder is a link: the folder is not used`);
    if (SANDBOX_UIDS.includes(st.uid)) throw new NeedsFiles(`${rel || basename(p)} in the kept game folder was written by a build program, not by you: the folder is not used`);
    const perms = st.mode & 0o7777;
    if (perms & 0o7022) { await sbdeps.chmod(p, perms & 0o755); fixed++; }
    if (st.isDirectory()) for (const n of await readdir(p)) await walk(join(p, n), rel ? `${rel}/${n}` : n);
  };
  await walk(dir, "");
  if (fixed) log?.(`${fixed} entr${fixed === 1 ? "y" : "ies"} of ${basename(dir)} could be written by others: made read-only for them`);
}

/** a stat the hashes of a kept file can be trusted by (src/ways/types.ts HashedStat): the same size, time, device and inode */
const sameFile = (a: { size: number; mtimeMs: number; dev: number; ino: number } | null, b: { size: number; mtimeMs: number; dev: number; ino: number }) =>
  !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino;

/* ─────────── placing kept files ─────────── */

/** one file placeContent put into an install folder: where, its stat right after it was placed, and its sha256 when that
 *  is known without reading it again (a link to a kept file whose stat is the one its hashes were taken with, or a copy
 *  hashed as it was written) */
export interface PlacedFile { rel: string; abs: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; sha256: string | null; linked: boolean }
/** what placeContent put into STAGING: where, whether it is the store's own file (a hard link, or a tree of them for a
 *  folder) or a copy, the bytes it copied, and each file with its stat (links: the (dev, ino) the link check accepts) */
export interface Placed { rel: string; abs: string; linked: boolean; bytes: number; links: { abs: string; dev: number; ino: number }[]; files: PlacedFile[] }
export interface PlaceOpts {
  /** may it be a hard link (the caller's rule: it ships, and no program is handed the folder it lands in) */
  link: boolean;
  log?: (line: string) => void;
  /** bytes placed of total, and how (links count at once) */
  progress?: (bytes: number, total: number, how: "link" | "copy") => void;
  signal?: AbortSignal;
  /** the folder the links are accepted in (default: the folder holding STAGING, the job's scratch folder) */
  scope?: string;
}

/**
 * The absolute path of `rel` inside `root`, refusing a link on any part of the way (and anything that is not a folder
 * where a folder must be). `create` makes the missing folders on the way. A path a plan names must be one the launcher
 * installs; one `found` in STAGING (a remove step's match) only has to stay inside it, so a name Windows refuses can be
 * removed.
 */
export async function inside(root: string, rel: string, o: { create?: boolean; found?: boolean } = {}): Promise<string> {
  const err = o.found ? (!rel || rel.startsWith("/") || rel.split("/").some(s => !s || s === "." || s === "..") ? "is not a path inside the package" : null) : safeRelPath(rel);
  if (err) throw new Error(`${rel}: ${err}`);
  const parts = rel.split("/");
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const st = await lstat(cur).catch(() => null);
    const at = parts.slice(0, i + 1).join("/");
    if (st?.isSymbolicLink()) throw new Error(`${at} is a link, and nothing is written through one`);
    if (i < parts.length - 1) {
      if (!st) { if (!o.create) continue; await mkdir(cur); }
      else if (!st.isDirectory()) throw new Error(`${at} is a file where the path needs a folder`);
    }
  }
  return cur;
}
/** a fresh file at `rel`: whatever was there goes first (never written through), then it is created exclusively */
export async function freshTarget(root: string, rel: string): Promise<string> {
  const abs = await inside(root, rel, { create: true });
  const st = await lstat(abs).catch(() => null);
  if (st?.isDirectory()) throw new Error(`${rel} is a folder`);
  if (st) await unlink(abs);
  return abs;
}

/** one kept file to `target` (which is not there): a link when allowed and possible, else a copy hashed on the way */
async function placeOne(src: string, st: Stats, target: string, o: { link: boolean; scope: string; log?: (line: string) => void; signal?: AbortSignal; onBytes?: (n: number) => void; trusted?: string | null; name: string }): Promise<{ file: Omit<PlacedFile, "rel">; copied: number }> {
  let linked = false;
  if (o.link && st.dev === (await stat(dirname(target))).dev && (await linkableFile(src, st, o.log))) {
    try { await pldeps.link(src, target); linked = true; }
    catch (e: any) { o.log?.(`${o.name} could not be linked (${e?.code ?? e?.message ?? e}): it is copied`); }
  }
  let sha256: string | null = null, copied = 0;
  if (!linked) {
    const sum = await copyHashed(src, target, o.signal, o.onBytes, "wx");
    if (sum.size !== st.size) throw new NeedsFiles(`${o.name} changed while it was being placed`);
    sha256 = sum.sha256; copied = sum.size;
  }
  const now = await lstat(target);
  if (linked) {
    notePlaced(o.scope, now);
    // the stored sha256 stands for the link only while the file is the one it was taken from (C2): same size, time,
    // device and inode as when it was hashed (a link changes its ctime, so that is compared from here on, not before)
    sha256 = o.trusted ?? null;
    o.onBytes?.(st.size);
  }
  return { file: { abs: target, dev: now.dev, ino: now.ino, size: now.size, mtimeMs: now.mtimeMs, ctimeMs: now.ctimeMs, sha256, linked }, copied };
}

/**
 * A kept folder placed at `dest` (which must not be there): its folders made, each file a hard link when `link` allows it
 * and the volume can (else a copy hashed on the way), the bytes of total told as it goes, a cancel honoured between
 * files. `trusted` gives a linked file's sha256 when its stat says it is still the file that was hashed. A link anywhere
 * in the kept folder refuses it (it could point anywhere).
 */
export async function placeTree(src: string, dest: string, o: { link: boolean; scope: string; log?: (line: string) => void; signal?: AbortSignal; progress?: (done: number, total: number, how: "link" | "copy") => void; trusted?: (rel: string, st: Stats) => string | null }): Promise<{ files: PlacedFile[]; linked: boolean; bytes: number }> {
  const list: { rel: string; abs: string; st: Stats }[] = [];
  const walk = async (dir: string, at: string) => {
    for (const n of (await readdir(dir)).sort()) {
      const p = join(dir, n), r = at ? `${at}/${n}` : n;
      const st = await lstat(p);
      if (st.isSymbolicLink()) throw new NeedsFiles(`${r} in ${basename(src)} is a link: the folder is not used`);
      if (st.isDirectory()) { list.push({ rel: r, abs: p, st }); await walk(p, r); }
      else if (st.isFile()) list.push({ rel: r, abs: p, st });
      else throw new NeedsFiles(`${r} in ${basename(src)} is not a file`);
    }
  };
  await walk(src, "");
  const total = list.reduce((a, e) => a + (e.st.isFile() ? e.st.size : 0), 0);
  const canLink = o.link && (await linksWork(o.scope, o.log));
  await mkdir(dest);
  const files: PlacedFile[] = [];
  let done = 0, copied = 0, last = 0;
  const how = canLink ? "link" : "copy";
  const tell = (extra = 0) => { if (Date.now() - last >= 1000 || done + extra >= total) { last = Date.now(); o.progress?.(done + extra, total, how); } };
  o.progress?.(0, total, how);
  for (const e of list) {
    if (o.signal?.aborted) throw new Error("cancelled");
    const to = join(dest, ...e.rel.split("/"));
    if (e.st.isDirectory()) { await mkdir(to, { recursive: true }); continue; }
    const r = await placeOne(e.abs, e.st, to, { link: canLink, scope: o.scope, log: o.log, signal: o.signal, onBytes: n => tell(n), trusted: o.trusted?.(e.rel, e.st) ?? null, name: `${basename(src)}/${e.rel}` });
    done += e.st.size; copied += r.copied;
    tell();
    files.push({ ...r.file, rel: e.rel });
  }
  return { files, linked: files.length > 0 && files.every(f => f.linked), bytes: copied };
}

/**
 * A way's game file (or game folder) placed at `rel` inside STAGING: a hard link from the content store when `link`
 * allows it and the volume can, a copy hashed on the way otherwise (with progress); a folder row as a tree of links (or
 * copies). The link check (refuseLinks) accepts exactly the links placed here, under `scope`.
 */
export async function placeContent(staging: string, rel: string, row: ContentRow, o: PlaceOpts): Promise<Placed> {
  const scope = o.scope ?? dirname(staging);
  const src = await lstat(row.path).catch(() => null);
  const folder = row.shape === "folder";
  if (!src || (folder ? !src.isDirectory() : !src.isFile()) || src.isSymbolicLink()) throw new NeedsFiles(`the game file ${row.name} is gone from the server, or changed on disk`);
  if (!folder) {
    if (src.size !== row.size) throw new NeedsFiles(`the game file ${row.name} is gone from the server, or changed on disk`);
    const canLink = o.link && (await linksWork(scope, o.log));
    const target = await freshTarget(staging, rel);
    const trusted = sameFile(contentStat(row), src) ? contentHashes(row).sha256 ?? null : null;
    const how = canLink ? "link" : "copy";
    let last = 0;
    const tell = (n: number) => { if (n >= src.size || Date.now() - last >= 1000) { last = Date.now(); o.progress?.(n, src.size, how); } };
    o.progress?.(0, src.size, how);
    const r = await placeOne(row.path, src, target, { link: canLink, scope, log: o.log, signal: o.signal, onBytes: tell, trusted, name: row.name });
    o.log?.(r.file.linked ? `${row.name} → ${rel} (a hard link: nothing copied${trusted ? ", its sha256 kept" : ""})` : `${row.name} → ${rel} (copied, ${(r.copied / 1e9).toFixed(2)} GB, hashed as it was written)`);
    return { rel, abs: target, linked: r.file.linked, bytes: r.copied, links: r.file.linked ? [{ abs: target, dev: r.file.dev, ino: r.file.ino }] : [], files: [{ ...r.file, rel }] };
  }
  // a game folder: a tree of links (or copies), file by file, in a place of its own
  const target = await inside(staging, rel, { create: true });
  const there = await lstat(target).catch(() => null);
  if (there) {
    if (!there.isDirectory()) await unlink(target);
    else if ((await readdir(target)).length) throw new PlanFault("place", `${rel} is already in the program: the game folder needs a place of its own`);
    else await rm(target, { recursive: true, force: true });
  }
  const tree = await placeTree(row.path, target, { link: o.link, scope, log: o.log, signal: o.signal, progress: o.progress });
  const files = tree.files.map(f => ({ ...f, rel: `${rel}/${f.rel}` }));
  o.log?.(`${row.name} → ${rel}/ (${files.length} files${tree.linked ? ", hard links: nothing copied" : `, ${(tree.bytes / 1e9).toFixed(2)} GB copied`})`);
  return { rel, abs: target, linked: tree.linked, bytes: tree.bytes, links: files.filter(f => f.linked).map(f => ({ abs: f.abs, dev: f.dev, ino: f.ino })), files };
}

/* ─────────── what a program wrote ─────────── */

export { textOf, serverPathIn } from "../process/portability";

/**
 * A kept game file handed to a program that reads it on the server (a setup step's {content}, a build that needs it):
 * a hard link in <work>/in, else the store's own path — read-only for the build user either way, never a copy. A folder
 * is read where it is kept. A kept file a build user owns is not used at all: it may have been changed.
 */
export async function handOver(row: ContentRow, work: string, o: { log?: (line: string) => void; scope?: string } = {}): Promise<{ path: string; linked: boolean }> {
  const st = await lstat(row.path).catch(() => null);
  if (!st || st.isSymbolicLink() || (row.shape === "folder" ? !st.isDirectory() : !st.isFile())) throw new NeedsFiles(`the game file ${row.name} is gone from the server, or changed on disk`);
  if (row.shape === "folder") { await readOnlyTree(row.path, o.log); return { path: row.path, linked: false }; }
  if (!(await linkableFile(row.path, st, o.log))) throw new NeedsFiles(`the game file ${row.name} belongs to a build user on this server: it may have been changed, so it is not used (take it in again)`);
  const dir = join(work, "in");
  await mkdir(dir, { recursive: true });
  const to = join(dir, placedName(row.name));
  await rm(to, { force: true }).catch(() => {});
  if ((await linksWork(work, o.log)) && st.dev === (await stat(dir)).dev) {
    try {
      await pldeps.link(row.path, to);
      notePlaced(o.scope ?? work, await lstat(to));
      o.log?.(`${row.name}: handed over by a hard link (nothing copied)`);
      return { path: to, linked: true };
    } catch (e: any) { o.log?.(`${row.name} could not be linked (${e?.code ?? e?.message ?? e}): it is read where it is kept`); }
  }
  return { path: row.path, linked: false };
}
