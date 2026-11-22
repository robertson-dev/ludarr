/**
 * ludarr — the seedbox seen from here: is trouble reading it the seedbox's (its folder choked, remounted or not answering,
 * a client that does not answer, a link so full a transfer stalls) or the copy's (a corrupt or locked archive, the wrong
 * game, a post no one seeds, a file really gone)? Only the copy's moves a search on to another copy; the seedbox's is waited
 * out — retried with a backoff, resumed where it can be — and said in plain words to the admin. Players read none of it
 * (Ahoy shows them "Preparing" / "Downloading").
 *
 *   transportTrouble(e)   one classification of an error: its own code (EIO, ETIMEDOUT, ESTALE, ENOTCONN, ECONNRESET …, a
 *                         timeout) is the read path's or the connection's, never the copy's. Words a child program printed
 *                         ("Read error", "unexpected end of archive", "ran out of time") decide nothing by themselves: they
 *                         call for the evidence below and, at most, one confirming re-run. The system's own words for such an
 *                         errno ("Input/output error", libuv's "EIO: i/o error") are the read path's; a checksum or password
 *                         an archiver refuses (copyWords) is the copy's.
 *   the monitor           every mapped seedbox folder (a download client's remote path mapping, /remote/downloads) — and
 *                         the finished-downloads folder the admin's own sync fills here (src/synced.ts) — is probed
 *                         every 5 min, every 30 s while anything waits on it or a job reads it: does it answer within 10 s,
 *                         did it get remounted (its device or its mount's id changed, its mount went away), does it read empty
 *                         all at once — or read empty with nothing mounted there at all (a mount that never came up after a
 *                         restart). What the probe sees, and any transient error a reader of the folder met (noteTrouble),
 *                         goes into the trouble log; a folder that only answers slowly is noted, never counted as trouble.
 *   watch → verdict       a job reading a mapped folder is watched from its start (its input's files and bytes too); when it
 *                         fails, the verdict says whether the read path was troubled in between (a remount, the folder down,
 *                         its own error's code, a file it could not find that is there now, a download that lost files while
 *                         it was read) and whether its input is still there. The runner records it in the job's FailInfo
 *                         ('env'/'remote' when troubled), so the decision survives a restart.
 *   the gone rule         a file is gone for good only when it was looked for at least 3 times over at least 15 minutes, each
 *                         time on a folder that answered, AND its download client no longer has it (or says its files are
 *                         missing; a usenet download is only a record in NZBGet's history once its folder is gone — the
 *                         hourly move out of complete/ takes it for good).
 *   the waits             a retry after 1, 2, 5, 10, 20, 30, 60 min, then hourly, each only once the folder answered twice at
 *                         least 35 s apart; a health warning after 2 h, a health error, a notification and the request asking
 *                         after 6 h; after 72 h the request stops with its download kept and nothing blocklisted (Retry, or a
 *                         search of the game, picks it up again).
 */
import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { db } from "./db";
import * as registry from "./plugins/registry";
import { EnvError } from "./ways/errors";
import { codeOf, copyWords, errnoWords, messageOf, readTrouble, transportTrouble, wordsTrouble } from "./transport";
import { arrivalsDir, overArrivals } from "./synced";

/* ─────────── 1. what an error says about the read path: src/transport.ts ─────────── */

export { TRANSPORT_WORDS, transportTrouble, wordsTrouble, clientTrouble, messageOf, copyWords, noted } from "./transport";

/* ─────────── 2. the mapped folders and the monitor ─────────── */

/** a folder a download client's downloads are read from: the seedbox's own folder mounted here (a remote path mapping), or
 *  the finished-downloads folder the admin's own sync fills on this server (kind 'synced', one for every client: src/synced.ts,
 *  src/arrivals.ts — its `from`, `client` and `instanceId` are empty) */
export interface Mapped { to: string; from: string; client: string; instanceId: number; kind?: "mount" | "synced" }
export interface Probe { ok: boolean; ms: number; entries: number | null; dev: string | null; mounted: boolean | null; why: string | null }
/** what a client says of one download, from its latest snapshot (src/fetch.ts clientViewOf) */
export interface ClientView {
  /** the client answered (a snapshot that is not marked unavailable) */
  answered: boolean;
  has: boolean;
  complete?: boolean;
  size?: number | null;
  /** it lists the item but says its files are missing ("No such file", "Storage error") */
  lost?: boolean;
  /** "rTorrent", "NZBGet" */
  name?: string;
  /** the client's own item as it listed it (what an arrival reads: NZBGet's downloaded size, the item's label) */
  item?: import("./seedbox-items").SbItem | null;
}
/** what a download weighs: its files and their bytes */
export interface Weight { files: number; bytes: number }

const PROBE_MS = 10_000;
/** a probe slower than this says the folder is choked even when it answers (noted, never trouble by itself) */
const SLOW_MS = 5_000;
/** a folder that held entries and reads empty on the same mount this many times over this long was emptied (its downloads
 *  moved away or cleaned up), not remounted: empty is what it is now */
const EMPTY_LOOKS = 3, EMPTY_SPAN_MS = 5 * 60_000;

/** every enabled download client's remote path mapping with both sides set: the seedbox's folder, and where it is mounted here */
export function clientMappings(): Mapped[] {
  const out: Mapped[] = [];
  for (const r of registry.instanceRows("downloadClient")) {
    if (!r.enabled) continue;
    let s: Record<string, unknown> = {}; try { s = JSON.parse(r.settings_json); } catch { /* unreadable settings: no mapping */ }
    const [from, to] = String(s.pathMap ?? "").split("=").map(x => x.trim().replace(/[\\/]+$/, ""));
    if (from && to) out.push({ from, to, client: r.name, instanceId: r.id });
  }
  return out;
}

/** swappable in tests: the mapped folders, the probe, a stat, a weighing, the clients' word on a download, the clock */
export const rmdeps = {
  roots: (): Mapped[] => {
    const finished = arrivalsDir();
    // (a mapping onto the finished-downloads folder is not the seedbox's folder: left out while that folder is on — the
    // health list says so, src/arrivals.ts — so nothing reads that folder as the seedbox's)
    const out = clientMappings().filter(m => !overArrivals(m.to, finished));
    if (finished) out.push({ from: "", to: finished, client: "", instanceId: 0, kind: "synced" });
    return out;
  },
  probe: (root: string): Promise<Probe> => realProbe(root),
  /** a path looked at once: there, not there (ENOENT), or the error's code (a timeout is ETIMEDOUT) */
  stat: (p: string): Promise<"present" | "absent" | { code: string }> => statOnce(p),
  /** what a download weighs now (null: it could not be told — a read failed, it is too big to walk, it is not there) */
  weigh: (p: string): Promise<Weight | null> => weighOnce(p),
  /** what the download's client says of it now (src/fetch.ts provides it at load: no import cycle) */
  clientView: async (_f: { id: number }): Promise<ClientView> => ({ answered: false, has: false }),
  /** the download clients that have not answered, and since when (ms; src/fetch.ts provides it at load) */
  silentClients: (): { name: string; since: number }[] => [],
  now: (): number => Date.now(),
};

const within = (p: string, dir: string) => { const a = resolve(p), b = resolve(dir); return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep); };
/** the mapped seedbox folder a path is under (null: a local path) */
export function rootOf(path: string | null | undefined): Mapped | null {
  if (!path || /^(?:way|make|plan|repo):/.test(path)) return null;
  let best: Mapped | null = null;
  for (const m of rmdeps.roots()) if (within(path, m.to) && (!best || m.to.length > best.to.length)) best = m;
  return best;
}
export const onSeedbox = (path: string | null | undefined): boolean => !!rootOf(path);
/** the finished-downloads folder when a path is in it (null: it is not) — what is not there is gone from here, never "gone
 *  from the seedbox" */
export const syncedRoot = (path: string | null | undefined): Mapped | null => { const m = rootOf(path); return m?.kind === "synced" ? m : null; };
/** the kind of a monitored folder (by its path here) */
function kindAt(root: string): "mount" | "synced" {
  const k = resolve(root);
  return rmdeps.roots().find(m => resolve(m.to) === k)?.kind === "synced" ? "synced" : "mount";
}
/** the finished-downloads folder in words (never its path: the admin knows it as downloads/finished) */
export const FINISHED_FOLDER = "the finished-downloads folder";
/** a monitored folder in words: the seedbox's (its mount) or the finished-downloads folder (the admin's own sync fills it) */
export const placeOf = (root: string | null | undefined): string => (root && kindAt(root) === "synced" ? FINISHED_FOLDER : "the seedbox folder");

/** a filesystem that is the seedbox reached over the network (rclone's or sshfs's FUSE, NFS, SMB …) */
const REMOTE_FS = /^(?:fuse|nfs|cifs|smb|9p|ceph|glusterfs|sshfs|davfs)/i;
/** the mount a path sits on (Linux's mount table): its id — a remount makes a new one even when the device number comes back
 *  the same — and whether it is a remote filesystem; null where there is no table to read */
function mountAt(path: string): { id: string; remote: boolean } | null {
  let text = "";
  try { text = readFileSync("/proc/self/mountinfo", "utf8"); } catch { return null; }
  const p = resolve(path);
  let best: { at: string; id: string; fstype: string } | null = null;
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    const dash = f.indexOf("-");
    if (f.length < 10 || dash < 6) continue;
    const at = f[4].replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (!(p === at || p.startsWith(at.endsWith("/") ? at : `${at}/`))) continue;
    if (!best || at.length >= best.at.length) best = { at, id: f[0], fstype: f[dash + 1] ?? "" };
  }
  return best ? { id: best.id, remote: REMOTE_FS.test(best.fstype) } : null;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** the probe's shell: the folder's device, then its entries — ls's own status counts (a listing the mount failed while its
 *  attributes were still cached is no answer, never "0 entries") */
export const PROBE_SH = 'stat -c %d -- "$1" && out=$(ls -1A -- "$1") && if [ -z "$out" ]; then echo 0; else printf "%s\\n" "$out" | wc -l; fi';

/** one look at a folder: in a child process that is killed after 10 s on Linux (a FUSE call that hangs must never hold one
 *  of ludarr's own threads), else in-process with a deadline */
async function realProbe(root: string): Promise<Probe> {
  const t0 = Date.now();
  const m = mountAt(root);
  const mounted = m ? m.remote : null, mid = m ? `:m${m.id}` : "";
  if (process.platform === "linux" && Bun.which("sh")) {
    let p: ReturnType<typeof Bun.spawn>;
    try { p = Bun.spawn(["sh", "-c", PROBE_SH, "probe", root], { stdout: "pipe", stderr: "pipe", stdin: "ignore" }); }
    catch (e) { return { ok: false, ms: Date.now() - t0, entries: null, dev: null, mounted, why: messageOf(e) }; }
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, PROBE_MS);
    const done = Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
    const r = await Promise.race([done, sleep(PROBE_MS + 2000).then(() => null)]);
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (!r) return { ok: false, ms, entries: null, dev: null, mounted, why: `it did not answer within ${PROBE_MS / 1000} s` };
    const [out, err, code] = r;
    const lines = out.trim().split(/\s+/);
    if (code !== 0 || lines.length < 2) return { ok: false, ms, entries: null, dev: null, mounted, why: (err.trim().split("\n").pop() || `the probe ended with ${code}`).slice(0, 200) };
    return { ok: true, ms, entries: Number(lines[1]) || 0, dev: `${lines[0]}${mid}`, mounted, why: null };
  }
  try {
    const r = await Promise.race([Promise.all([stat(root), readdir(root)]), sleep(PROBE_MS).then(() => null)]);
    const ms = Date.now() - t0;
    if (!r) return { ok: false, ms, entries: null, dev: null, mounted, why: `it did not answer within ${PROBE_MS / 1000} s` };
    return { ok: true, ms, entries: r[1].length, dev: `${String(r[0].dev)}${mid}`, mounted, why: null };
  } catch (e) { return { ok: false, ms: Date.now() - t0, entries: null, dev: null, mounted, why: transportTrouble(e) ?? messageOf(e) }; }
}

async function statOnce(p: string): Promise<"present" | "absent" | { code: string }> {
  try {
    const r = await Promise.race([stat(p).then(() => "present" as const), sleep(PROBE_MS).then(() => ({ code: "ETIMEDOUT" }))]);
    return r;
  } catch (e) {
    const c = codeOf(e);
    return c === "ENOENT" || c === "ENOTDIR" ? "absent" : { code: c || "EIO" };
  }
}

/** a download's files and bytes, walked once (as the import's snapshot counts them: regular files only — never an rclone part
 *  file, which the admin's sync writes in the finished-downloads folder until a file is whole); null past 50,000 entries or a minute, or when
 *  the folder failed a read — an entry that vanished during the walk is simply not counted */
async function weighOnce(p: string): Promise<Weight | null> {
  let files = 0, bytes = 0, seen = 0, failed = false;
  const gone = (e: unknown) => codeOf(e) === "ENOENT" || codeOf(e) === "ENOTDIR";
  const walk = async (q: string, top: boolean): Promise<void> => {
    if (failed) return;
    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(q); } catch (e) { if (top || !gone(e)) failed = true; return; }
    if (!st.isDirectory()) { files++; bytes += st.size; return; }
    let names: string[];
    try { names = await readdir(q); } catch (e) { if (top || !gone(e)) failed = true; return; }
    for (const n of names) { if (failed) return; if (n.endsWith(".partial")) continue; if (++seen > 50_000) { failed = true; return; } await walk(join(q, n), false); }
  };
  const done = await Promise.race([walk(p, true).then(() => true), sleep(60_000).then(() => false)]);
  return done && !failed ? { files, bytes } : null;
}

interface RootState {
  ok: boolean | null; at: number; ms: number | null; entries: number | null; dev: string | null; mounted: boolean | null; why: string | null;
  /** the healthy probes in a row since the last trouble, and when the first of them was */
  good: number; goodSince: number | null;
  /** when the current trouble began (null: none) */
  badSince: number | null;
  /** what it looked like when last healthy */
  okDev: string | null; okEntries: number | null; okMounted: boolean | null;
  /** a folder that held entries reading empty on one mount: since when, how many looks */
  empty: { since: number; n: number; dev: string | null } | null;
  probing: Promise<Probe> | null;
}
const roots = new Map<string, RootState>();
/** what the log holds: the folder down (or not mounted, or empty all at once), remounted, a reader's errno, or only slow */
type LogKind = "down" | "remounted" | "io" | "slow";
/** every trouble seen on a mapped folder, newest last (two days of it) */
const log: { root: string; at: number; why: string; kind: LogKind }[] = [];
const LOG_KEEP_MS = 48 * 3600_000;

const fresh = (): RootState => ({ ok: null, at: 0, ms: null, entries: null, dev: null, mounted: null, why: null, good: 0, goodSince: null, badSince: null, okDev: null, okEntries: null, okMounted: null, empty: null, probing: null });
const stateOf = (root: string): RootState => { const k = resolve(root); let s = roots.get(k); if (!s) { s = fresh(); roots.set(k, s); } return s; };

function trouble(root: string, why: string, at = rmdeps.now(), kind: LogKind = "down") {
  const k = resolve(root);
  log.push({ root: k, at, why, kind });
  while (log.length && (log.length > 500 || at - log[0].at > LOG_KEEP_MS)) log.shift();
  // a folder that answers, only slowly, is noted (a verdict may say so) and is still steady: what reads it reads it whole
  if (kind === "slow") return;
  const s = stateOf(k);
  s.good = 0; s.goodSince = null;
  if (s.badSince == null) s.badSince = at;
  s.why = why;
}

/** a transient error a reader of a mapped folder met (a readdir that failed with EIO, a stat that timed out): the folder
 *  counts as troubled from now until it answered steadily again. A missing entry (ENOENT) is not noted here: a remount's gap
 *  shows in the probe, the folder's mount and the verdict's second look, and a file really gone must stay countable by the
 *  gone rule */
export function noteTrouble(path: string, e: unknown): void {
  const m = rootOf(path);
  if (!m) return;
  const why = transportTrouble(e, { words: false });
  if (why) trouble(m.to, `${why} reading ${tail(path)}`, rmdeps.now(), "io");
}
// the readers' hook (src/transport.ts noted): what a walk of the seedbox's folder could not read is this log's
readTrouble.note = noteTrouble;

/**
 * Probe a mapped folder now (one probe at a time per folder: a call while one runs shares it). Healthy: it answered within
 * 10 s, it is still the mount it was (its device and its mount unchanged since it was last healthy), it does not read empty
 * when it held entries (unless it stays empty on the same mount: emptied), and it does not read empty with nothing mounted
 * there. A remount seen here is trouble even though the folder answers: whatever read it across the remount may have read
 * the empty folder underneath.
 */
export async function probeRoot(root: string): Promise<RootState> {
  const s = stateOf(root);
  if (s.probing) { await s.probing.catch(() => null); return s; }
  s.probing = rmdeps.probe(root);
  let p: Probe;
  try { p = await s.probing; } catch (e) { p = { ok: false, ms: 0, entries: null, dev: null, mounted: null, why: messageOf(e) }; }
  finally { s.probing = null; }
  const now = rmdeps.now();
  Object.assign(s, { at: now, ms: p.ms, entries: p.entries, dev: p.dev, mounted: p.mounted });
  if (!p.ok || (p.entries ?? 0) > 0) s.empty = null;
  // the finished-downloads folder is a folder on this server that empties as what lands there is imported (Sonarr and Radarr
  // move theirs out, ludarr removes its own): empty is what it may well be
  const synced = kindAt(root) === "synced";
  // what is wrong, said of the folder ("the seedbox folder …")
  let why: string | null = null;
  if (!p.ok) why = `does not answer (${p.why ?? "no reason given"})`;
  else if (synced) why = null;
  else if (s.okMounted === true && p.mounted === false) why = "lost its mount (it shows the empty folder underneath)";
  // the seedbox's folder is a mount: empty with nothing mounted there is the folder underneath (a mount that never came up
  // after a restart), never "a seedbox with nothing on it"
  else if (p.entries === 0 && p.mounted === false) why = "reads empty with nothing mounted there (is the seedbox's mount up?)";
  else if (p.entries === 0 && (s.okEntries ?? 0) > 0) {
    const e = s.empty && s.empty.dev === p.dev ? { ...s.empty, n: s.empty.n + 1 } : { since: now, n: 1, dev: p.dev };
    s.empty = e;
    if (!(e.n >= EMPTY_LOOKS && now - e.since >= EMPTY_SPAN_MS)) why = "reads empty all at once (a remount in progress?)";
  }
  const remounted = !why && s.okDev != null && p.dev != null && p.dev !== s.okDev;
  if (why) { s.ok = false; trouble(root, why, now, "down"); return s; }
  // answering, but choked: noted (a verdict says it alongside), yet neither down nor unsteady — what reads it reads it whole
  const slow = p.ms > SLOW_MS ? `took ${(p.ms / 1000).toFixed(0)} s to answer` : null;
  if (remounted) trouble(root, "was remounted", now, "remounted");
  if (slow) trouble(root, slow, now, "slow");
  s.ok = true; s.why = remounted ? "was remounted" : slow;
  s.okDev = p.dev; s.okEntries = p.entries; s.okMounted = p.mounted;
  if (s.good === 0) s.goodSince = now;
  s.good++;
  if (s.good >= 2) s.badSince = null;
  return s;
}

/** the folder is known not to answer now (its last probe failed): nothing new starts reading it */
export function rootDown(root: string | null | undefined): boolean {
  if (!root) return false;
  const s = roots.get(resolve(root));
  return !!s && s.ok === false;
}
/** the folder answered at least twice, at least 35 s apart, since its last trouble: a retry may read it */
export function rootSteady(root: string): boolean {
  const s = roots.get(resolve(root));
  return !!s && s.ok === true && s.good >= 2 && s.goodSince != null && s.at - s.goodSince >= 35_000;
}
/** what the monitor knows of a folder (null: never probed) */
export function rootState(root: string): Pick<RootState, "ok" | "at" | "why" | "badSince" | "good"> | null {
  const s = roots.get(resolve(root));
  return s ? { ok: s.ok, at: s.at, why: s.why, badSince: s.badSince, good: s.good } : null;
}
/** the first trouble logged on a folder between two moments (ms): the folder down, a remount, a reader's errno — `slow`
 *  also counts a folder that only answered slowly; null when there was none */
function troubleBetween(root: string, from: number, to: number, o: { slow?: boolean } = {}): { why: string; kind: LogKind } | null {
  const k = resolve(root);
  return log.find(e => e.root === k && e.at >= from && e.at <= to && (o.slow || e.kind !== "slow")) ?? null;
}
export function troubledBetween(root: string, from: number, to: number, o: { slow?: boolean } = {}): string | null {
  return troubleBetween(root, from, to, o)?.why ?? null;
}

/** a request's wait that waits now: not stopped, and its failed job not re-run yet (or its next try set) — a re-run under
 *  way waits on nothing */
const waiting = (w: Pick<RemoteWait, "stopped" | "jobId"> | null, nextTryAt: number | null | undefined) => !!w && !w.stopped && (w.jobId != null || nextTryAt != null);
const parseWait = (s: string | null | undefined): RemoteWait | null => { try { const w = s ? JSON.parse(s) : null; return w && typeof w.since === "number" ? (w as RemoteWait) : null; } catch { return null; } };

/** how many downloads and requests wait on the seedbox now (the monitor looks every 30 s while any do) */
export function waitingCount(): number {
  try {
    let n = 0;
    for (const r of db.query("SELECT remote_json, next_try_at FROM requests WHERE remote_json IS NOT NULL AND state IN ('requested','fetching','processing')").all() as { remote_json: string; next_try_at: number | null }[])
      if (waiting(parseWait(r.remote_json), r.next_try_at)) n++;
    n += (db.query("SELECT COUNT(*) AS n FROM fetches WHERE state='seedbox_done' AND retry_at IS NOT NULL AND trouble_json IS NOT NULL").get() as { n: number }).n;
    return n;
  } catch { return 0; }
}
/** the monitor (a task every 15 s): each mapped folder probed every 5 min, every 30 s while it is troubled, anything waits
 *  on the seedbox, or a job reads it (a remount in the middle of a read is then seen while it happens) */
export async function remoteTick(): Promise<void> {
  const now = rmdeps.now();
  const busy = watches.size > 0 || waitingCount() > 0;
  const seen = new Set<string>();
  for (const m of rmdeps.roots()) {
    const k = resolve(m.to);
    if (seen.has(k)) continue;
    seen.add(k);
    const s = stateOf(m.to);
    const every = busy || s.ok !== true || s.good < 2 ? 30_000 : 300_000;
    if (s.at && now - s.at < every) continue;
    await probeRoot(m.to);
  }
}
/** tests: forget everything the monitor saw */
export function resetRemote(): void { roots.clear(); log.length = 0; watches.clear(); }

/* ─────────── 3. a job reading a mapped folder: watched, then judged ─────────── */

export type Trouble = "mount-down" | "remounted" | "io" | "slow" | "absent" | "not-listed" | "moved" | "client-silent" | "transfer" | "suspect" | "flicker" | "changed" | "frozen" | "arrival";
export interface Watch {
  path: string; root: string; at: number; dev: string | null; mounted: boolean | null;
  /** what the input weighed when the job began (null: not weighed) */
  start?: Weight | null;
}
/** what a job's failure says about the seedbox (FailInfo.remote): kept on the job row, read by the request */
export interface RemoteEvidence {
  root: string;
  /** the read path was troubled during the job: the job's failure says nothing of the copy */
  troubled: boolean;
  trouble?: Trouble | null;
  words?: string;
  /** the input was not there when it was looked for at the end (on a folder that answered) */
  absent?: boolean;
  /** a child program's words that call for one confirming re-run (an I/O error it reported, "unexpected end", a timeout) */
  io?: boolean;
  /** the job's own end is a verdict on the copy (a checksum, a password) — it stands once it comes again */
  copy?: boolean;
  /** the folder only answered slowly while it was read (said alongside; never trouble by itself) */
  slow?: boolean;
  /** what the input weighed at the job's start, and at its end when that was less */
  start?: Weight | null;
  left?: Weight | null;
  /** the job's own end, in its words (a troubled job's message leads with the folder's) */
  ended?: string;
  /** the job was a confirming re-run (confirmingRun): its end is taken as it is */
  confirmed?: boolean;
}

const watches = new Map<number, Watch>();
/** a watch on a path that is on a mapped folder (null otherwise): the folder as it is at the start — and, asked to, what the
 *  input weighs then (a job that reads it whole: a download that loses files meanwhile was moved or remounted) */
export async function watchPath(path: string | null | undefined, o: { weigh?: boolean } = {}): Promise<Watch | null> {
  const m = rootOf(path);
  if (!m || !path) return null;
  const s = stateOf(m.to);
  const now = rmdeps.now();
  if (!s.at || now - s.at > 60_000 || s.ok !== true) await probeRoot(m.to);
  const start = o.weigh && s.ok ? await rmdeps.weigh(path).catch(() => null) : null;
  return { path, root: m.to, at: now, dev: s.ok ? s.dev : null, mounted: s.ok ? s.mounted : null, ...(start ? { start } : {}) };
}
export function watchJob(jobId: number, w: Watch | null): void { if (w) watches.set(jobId, w); else watches.delete(jobId); }
export function unwatchJob(jobId: number): void { watches.delete(jobId); }
export const jobWatch = (jobId: number): Watch | null => watches.get(jobId) ?? null;

const ENOENT_WORDS = /\bENOENT\b|No such file or directory/i;
/** the path an error names: its own (an fs error's `path`), else the first one quoted in its words */
function pathIn(err: unknown): string | null {
  const own = err && typeof err === "object" ? (err as { path?: unknown }).path : null;
  if (typeof own === "string" && own) return own;
  const t = messageOf(err);
  const m = /'([^']+)'/.exec(t) ?? /"([^"]+)"/.exec(t);
  return m ? m[1] : null;
}
const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

/**
 * Was the read path troubled while the watched job ran, and is its input still there? Rule 1 of the judge: a folder that does
 * not answer now, a remount since the job began (its device or its mount changed), a trouble logged in between (never one
 * that only says it was slow), an error whose own code is the read path's, a file the job could not find that is there now,
 * or an input that lost files or bytes since the job began — the job's failure says nothing of the copy. Otherwise the input
 * is looked for once: absent (on a folder that answers) is evidence for the gone rule, never a verdict by itself; an ENOENT
 * that names no path, or a child program's words that may be a failed read, call for one confirming re-run (io).
 */
export async function verdictOf(w: Watch, err?: unknown): Promise<RemoteEvidence> {
  const text = err === undefined ? "" : messageOf(err);
  // the job's own error code, or the system's words for one that a child program printed while reading the folder (its input
  // is on the mapped folder: the read path failed it); a checksum or a password is the copy's own verdict
  const own = err === undefined ? null : transportTrouble(err, { words: false }) ?? (errnoWords(text) ? `"${errnoWords(text)}"` : null);
  const copy = !own && !!copyWords(text);
  let io = !own && !copy && err !== undefined && !!wordsTrouble(text);
  const s = await probeRoot(w.root);
  const now = rmdeps.now();
  const slow = !!troubleBetween(w.root, w.at, now, { slow: true }) && !troubleBetween(w.root, w.at, now);
  const base = { root: w.root, ...(copy ? { copy: true } : {}), ...(slow ? { slow: true } : {}), ...(w.start ? { start: w.start } : {}) };
  const place = placeOf(w.root);
  if (s.ok !== true) return { ...base, io, troubled: true, trouble: "mount-down", words: `${place} ${s.why ?? "does not answer"}` };
  if ((w.dev && s.dev && w.dev !== s.dev) || (w.mounted === true && s.mounted === false))
    return { ...base, io, troubled: true, trouble: "remounted", words: `${place} was remounted while it was being read` };
  const logged = troubleBetween(w.root, w.at, now);
  if (logged) {
    const words = logged.kind === "remounted" ? `${place} was remounted while it was being read`
      : logged.kind === "io" ? `reading ${place} failed: ${logged.why}`
      : `${place} stopped answering while it was being read (it ${logged.why})`;
    return { ...base, io, troubled: true, trouble: logged.kind === "remounted" ? "remounted" : logged.kind === "io" ? "io" : "mount-down", words };
  }
  if (own) return { ...base, io, troubled: true, trouble: "io", words: `reading ${place} failed: ${own}` };
  const there = await rmdeps.stat(w.path);
  if (typeof there === "object") {
    const why = transportTrouble({ code: there.code }) ?? there.code;
    trouble(w.root, why, rmdeps.now(), "io");
    return { ...base, io, troubled: true, trouble: "io", words: `${place} could not say whether ${tail(w.path)} is there: ${why}` };
  }
  if (there === "absent") return { ...base, io, troubled: false, absent: true };
  // a file the job could not find that is there now: the folder did not show it for a moment (a remount whose new mount got
  // the old device number back, between two probes) — a copy does not un-vanish. One under the input that is not there now
  // either, or an ENOENT that names nothing: looked at once more before it is the copy's
  if (err !== undefined && (codeOf(err) === "ENOENT" || ENOENT_WORDS.test(text))) {
    const p = pathIn(err);
    if (p && within(p, w.path)) {
      const back = resolve(p) === resolve(w.path) ? "present" : await rmdeps.stat(p);
      if (back === "present") return { ...base, io, troubled: true, trouble: "flicker", words: `${place} did not show ${tail(p)} for a moment while it was being read (it is there)` };
      io = true;
    } else if (!p) io = true;
  }
  // a download that lost files or bytes while it was read: moved away (the hourly move out of complete/) or remounted
  if (w.start) {
    const finished = kindAt(w.root) === "synced";
    const left = await rmdeps.weigh(w.path).catch(() => null);
    if (left && (left.files < w.start.files || left.bytes < w.start.bytes))
      return { ...base, io, left, troubled: true, trouble: "changed", words: finished
        ? `${tail(w.path)} lost files in ${FINISHED_FOLDER} while it was being read (${left.files} of its ${w.start.files} files, ${gb(left.bytes)} of ${gb(w.start.bytes)}): did its cleanup take them?`
        : `${tail(w.path)} lost files on the seedbox while it was being read (${left.files} of its ${w.start.files} files, ${gb(left.bytes)} of ${gb(w.start.bytes)}): it is being moved away, or the folder was remounted` };
    // more of it in the finished-downloads folder than when the job began: the admin's sync was still bringing it (it was taken
    // too early) — the arrival's trouble, never the copy's
    if (left && finished && (left.files > w.start.files || left.bytes > w.start.bytes))
      return { ...base, io, left, troubled: true, trouble: "arrival", words: `more of ${tail(w.path)} arrived in ${FINISHED_FOLDER} while it was being read (${left.files} files, ${gb(left.bytes)}; ${w.start.files} files, ${gb(w.start.bytes)} when it began): the sync was still bringing it` };
  }
  return { ...base, io, troubled: false, absent: false };
}

/**
 * The job is a confirming re-run: of a request's wait that met a child program's I/O words once already, or one queued to
 * confirm (its spec says so: a carry run's). What it ends with this time is taken as it is.
 */
export function confirmingRun(jobId: number): boolean {
  try {
    const j = db.query("SELECT request_id, spec_json FROM jobs WHERE id=?").get(jobId) as { request_id: number | null; spec_json: string | null } | null;
    if (!j) return false;
    try { if ((JSON.parse(j.spec_json ?? "null") as { confirm?: unknown } | null)?.confirm === true) return true; } catch { /* no spec */ }
    if (j.request_id == null) return false;
    const r = db.query("SELECT remote_json FROM requests WHERE id=?").get(j.request_id) as { remote_json: string | null } | null;
    return (parseWait(r?.remote_json)?.reruns ?? 0) >= 1;
  } catch { return false; }
}

/**
 * A job reading a mapped folder that is about to give the download up (refuse it, keep it for a look): when the folder was
 * troubled while it ran, or the input went missing, it throws EnvError 'remote' instead — what it saw says nothing of the
 * copy. `why`: the refusal's own words; when they say the read itself may have failed (7z ran out of time listing it, a read
 * error) and this is not yet the confirming run, it is 'suspect': refused without letting the download go, and looked at
 * once more (src/requests.ts judgeJob). Otherwise 'steady': the refusal stands.
 */
export async function steadyOrThrow(jobId: number, why?: string): Promise<"steady" | "suspect"> {
  const w = watches.get(jobId);
  if (!w) return "steady";
  const v = await verdictOf(w, why ? new Error(why) : undefined);
  if (v.troubled) throw new EnvError("remote", `${v.words ?? `${placeOf(w.root)} had trouble`} — nothing is decided about this download until it answers steadily`);
  if (v.absent) throw new EnvError("remote", `${tail(w.path)} went missing from ${placeOf(w.root)} while it was being read — it is looked for again`);
  return v.io && !confirmingRun(jobId) ? "suspect" : "steady";
}

/* ─────────── 4. the rules: gone, the ladders, the bounds ─────────── */

/** a request's wait on the seedbox (requests.remote_json) */
export interface RemoteWait {
  /** when the wait began, and when it last said something new (unix s) */
  since: number;
  /** retries so far (a re-run of the job, a look, a grab) */
  tries: number;
  /** retry: run the job (or the grab) again once the folder answers steadily; look: look for the input first */
  mode: "retry" | "look";
  /** what is waited on: an import, a way's content job, a held import (needs the AI), a check, a grab, a transfer, a
   *  download that does not move in its client, a download that does not arrive in the finished-downloads folder
   *  (src/arrivals.ts) */
  kind: "import" | "content" | "hold" | "check" | "grab" | "pull" | "download" | "arrival";
  trouble: Trouble;
  words: string;
  /** the failed job the wait is about (null once its re-run is queued) */
  jobId: number | null;
  input: string | null;
  /** the looks (unix s) that found the input absent on a folder that answered */
  absent: number[];
  /** confirming re-runs spent on a child program's words */
  reruns: number;
  /** troubled ends that were nonetheless the copy's own words (a checksum, a password): the second one is the copy's */
  copyEnds?: number;
  /** the most the input weighed when a job began reading it: a re-run waits until it is all there again (a download half
   *  moved away is looked at as one that is gone) */
  weight?: Weight | null;
  /** the bound reached (72 h): the request stopped; Retry picks it up */
  stopped?: boolean;
  /** the admin asked to try now: the next retry does not wait for the folder to answer steadily */
  now?: boolean;
}

export const WARN_AFTER_SEC = 2 * 3600, ASK_AFTER_SEC = 6 * 3600, STOP_AFTER_SEC = 72 * 3600;
/** a download that does not move in its client (paused, waiting on a choked box, a lapsed news server …): noted at 6 h, asked
 *  about at 24 h, stopped at 72 h — the download kept, nothing blocklisted */
export const FROZEN_WARN_SEC = 6 * 3600, FROZEN_ASK_SEC = 24 * 3600;
const LADDER_MIN = [1, 2, 5, 10, 20, 30, 60];
/** the wait before retry number `tries` + 1 (seconds): 1, 2, 5, 10, 20, 30, 60 min, then hourly */
export const ladderSec = (tries: number): number => 60 * (LADDER_MIN[Math.max(0, tries)] ?? 60);
/** the looks for an input that is not there: at 0, 1, 3, 7 and 15 min, then every 15 min */
const LOOK_MIN = [1, 2, 4, 8];
export const lookSec = (looks: number): number => 60 * (LOOK_MIN[Math.max(0, looks - 1)] ?? 15);
/** a file looked for at least 3 times over at least 15 minutes, never there */
export const GONE_LOOKS = 3, GONE_SPAN_SEC = 15 * 60;
export function goneRule(absent: number[]): boolean {
  return absent.length >= GONE_LOOKS && absent[absent.length - 1] - absent[0] >= GONE_SPAN_SEC;
}

export const tail = (p: string | null | undefined) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p ?? "");
export function inWords(sec: number): string {
  if (sec < 90) return "a minute";
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return m && h < 6 ? `${h} h ${m} min` : `${Math.round(sec / 3600)} h`;
}
const clock = (unixSec: number) => { const d = new Date(unixSec * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** the wait in a line for the request's stage (the admin's; players never see it): what is wrong, that nothing was thrown
 *  away, and when it is tried again — or, past the bounds, what the admin can do. `again`: how the next try is said */
export function waitStage(w: Pick<RemoteWait, "since" | "words">, nowSec: number, nextSec: number | null, again = "trying again"): string {
  const long = nowSec - w.since;
  const next = nextSec != null && nextSec > nowSec ? ` — ${again} in ${inWords(nextSec - nowSec)}` : ` — ${again} now`;
  if (long >= ASK_AFTER_SEC) return `${w.words}; waiting since ${clock(w.since)} — ludarr keeps trying every hour and nothing was thrown away: Retry (Activity → Queue) tries now, Remove (with blocklist) gives this copy up`;
  return `${w.words}${next}${long >= WARN_AFTER_SEC ? ` (waiting since ${clock(w.since)}; nothing was thrown away)` : ""}`;
}

/* ─────────── 5. health ─────────── */

export interface RemoteHealth { type: "error" | "warning" | "notice"; source: string; message: string; link?: string }
/**
 * The seedbox in the health list: a mapped folder that does not answer (a warning once it has been down 2 h, an error at
 * 6 h — the health check notifies when one appears or turns into an error), one line per folder whichever clients map it;
 * the downloads and requests waiting on it as long; and downloads that have not moved in their client for 6 h (an error at
 * 24 h). The words are stable while nothing changes (a time, never a running duration), so the notification goes out once.
 */
export function remoteHealth(nowSec: number = Math.floor(rmdeps.now() / 1000)): RemoteHealth[] {
  const out: RemoteHealth[] = [];
  for (const c of rmdeps.silentClients()) {
    const since = Math.floor(c.since / 1000), long = nowSec - since;
    if (long >= WARN_AFTER_SEC) out.push({ type: long >= ASK_AFTER_SEC ? "error" : "warning", source: "Seedbox", message: `${c.name} has not answered since ${clock(since)}: its downloads wait as they are (nothing counts as a stall meanwhile)`, link: "/settings/downloadclients" });
  }
  const folders = new Map<string, { to: string; clients: string[]; finished: boolean }>();
  for (const m of rmdeps.roots()) { const k = resolve(m.to); const f = folders.get(k) ?? { to: m.to, clients: [], finished: m.kind === "synced" }; if (m.client && !f.clients.includes(m.client)) f.clients.push(m.client); folders.set(k, f); }
  for (const [k, f] of folders) {
    const s = roots.get(k);
    if (!s || s.ok !== false || s.badSince == null) continue;
    const since = Math.floor(s.badSince / 1000), long = nowSec - since;
    if (long < WARN_AFTER_SEC) continue;
    // (the finished-downloads folder is said without its path: the admin knows it as downloads/finished, set under Media Management)
    out.push(f.finished
      ? { type: long >= ASK_AFTER_SEC ? "error" : "warning", source: "FinishedDownloads", message: `${FINISHED_FOLDER} has not answered since ${clock(since)}`, link: "/settings/mediamanagement" }
      : { type: long >= ASK_AFTER_SEC ? "error" : "warning", source: "Seedbox", message: `the seedbox folder ${f.to} (${f.clients.join(", ")}) has not answered since ${clock(since)}`, link: "/settings/downloadclients" });
  }
  let rows: { since: number; kind: string; synced: boolean }[] = [];
  let frozen: number[] = [];
  try {
    for (const r of db.query("SELECT remote_json, next_try_at FROM requests WHERE remote_json IS NOT NULL AND state IN ('requested','fetching','processing')").all() as { remote_json: string; next_try_at: number | null }[]) {
      const w = parseWait(r.remote_json);
      if (w && w.kind !== "download" && waiting(w, r.next_try_at)) rows.push({ since: w.since, kind: w.kind, synced: !!syncedRoot(w.input) });
    }
    for (const f of db.query("SELECT trouble_json FROM fetches WHERE trouble_json IS NOT NULL AND state='seedbox_done' AND retry_at IS NOT NULL").all() as { trouble_json: string }[]) {
      try { const t = JSON.parse(f.trouble_json) as { since?: number; tries?: number; stopped?: boolean }; if (t.since && (t.tries ?? 0) > 0 && !t.stopped) rows.push({ since: t.since, kind: "pull", synced: false }); } catch { /* skipped */ }
    }
    frozen = (db.query("SELECT COALESCE(moved_at, created_at) AS since FROM fetches WHERE state IN ('submitted','downloading') AND COALESCE(moved_at, created_at) <= ?").all(nowSec - FROZEN_WARN_SEC) as { since: number }[]).map(r => r.since);
  } catch { rows = []; frozen = []; }
  // (waits on an import read from the finished-downloads folder are said of that folder, the others of the seedbox)
  for (const synced of [false, true]) {
    const old = rows.filter(r => r.synced === synced && nowSec - r.since >= WARN_AFTER_SEC);
    if (!old.length) continue;
    const first = Math.min(...old.map(r => r.since));
    const imports = old.filter(r => r.kind !== "pull" && r.kind !== "grab").length, transfers = old.length - imports;
    const what = [imports ? `${imports} import${imports === 1 ? "" : "s"}` : "", transfers ? `${transfers} download${transfers === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    out.push({ type: nowSec - first >= ASK_AFTER_SEC ? "error" : "warning", source: synced ? "FinishedDownloads" : "Seedbox", message: `${what} ${old.length === 1 ? "has" : "have"} waited on ${synced ? FINISHED_FOLDER : "the seedbox"} since ${clock(first)}: nothing was thrown away — see Activity → Queue`, link: "/activity/queue" });
  }
  if (frozen.length) {
    const first = Math.min(...frozen);
    out.push({ type: nowSec - first >= FROZEN_ASK_SEC ? "error" : "warning", source: "Seedbox", message: `${frozen.length} download${frozen.length === 1 ? " has" : "s have"} not moved in the download client since ${clock(first)} — see Activity → Queue`, link: "/activity/queue" });
  }
  return out;
}
