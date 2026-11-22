/**
 * ludarr web — a game's files sent from this PC to the server (the server side: src/uploads.ts, src/api/uploads.ts).
 *
 * What was picked (one archive, some files, a whole folder) becomes one upload: its files go up in pieces of 32 MB, a few
 * files side by side. Nothing is asked of the admin when the line drops: a piece that did not arrive is sent again from
 * where the server says the file ends, with a wait that grows while the server does not answer. The same pick again —
 * after a reload, on another day — is the same upload on the server, and only what is missing is sent.
 *
 * The uploads under way live here, outside any page, so they keep going while the admin looks at something else; closing
 * or reloading the tab stops them (the browser is asked to warn), and picking the files again goes on.
 *
 * Free of React and of the DOM: the server is reached through `Io`, so the engine's tests drive it (tests/web-uploads.test.ts).
 */
import { ApiError, type JobView } from "./api";

/** an upload as the server tells it (src/uploads.ts serializeUpload) */
export interface UploadView {
  id: number; gameId: number; name: string; files: number; bytes: number; received: number; wayId: number | null; replace: boolean;
  state: "uploading" | "importing" | "failed" | "removing"; jobId: number | null;
  job: { id: number; kind: string; state: string; progress: number; message: string | null } | null;
  message: string | null; createdAt: number; touchedAt: number; expiresAt: number | null;
}
export interface ServerFile { path: string; size: number; done: boolean }

/** one picked file: its path inside the upload, and its bytes */
export interface PickedFile { path: string; size: number; file: Blob }
export interface Picked { name: string; files: PickedFile[]; bytes: number }

/** the most files one upload holds (the server's limit: src/uploads.ts) */
export const MAX_FILES = 200_000;
/** a piece of a file: small enough for any proxy in front of ludarr, large enough that a fast line is not held up */
export const PIECE = 32 * 2 ** 20;
/** files sent side by side (a game folder is thousands of small ones) */
const PARALLEL = 3;
/** tries in a row, for one file, before an upload stops and waits for "Continue": about eight minutes of a server that does
 *  not answer (a restart, an update of ludarr, takes far less) */
const MAX_FAILS = 20;

/**
 * What was picked, as an upload. A folder is named by itself and its files by their paths inside it; one file is named by
 * itself; several loose files (an installer with its parts, the volumes of an archive) are named for the game.
 */
export function shapePick(list: { path: string; size: number; file: Blob }[], fallback: string): Picked {
  const seen = new Map<string, PickedFile>();
  for (const f of list) {
    const path = f.path.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
    if (path) seen.set(path, { path, size: f.size, file: f.file });
  }
  let files = [...seen.values()];
  const first = files[0]?.path.split("/")[0];
  const oneFolder = files.length > 0 && files.every(f => f.path.includes("/") && f.path.split("/")[0] === first);
  let name = fallback;
  if (oneFolder) { name = first!; files = files.map(f => ({ ...f, path: f.path.slice(first!.length + 1) })); }
  else if (files.length === 1) name = files[0].path.split("/").pop()!;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { name, files, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/** file names that are a console's own (a .iso or a .bin can be a PC disc as well: not among them) */
const CONSOLE_FILE = /\.(z64|n64|v64|nes|fds|sfc|smc|gb|gbc|gba|nds|3ds|cia|nsp|xci|nsz|xcz|wbfs|rvz|wia|gcz|gcm|wua|wux|wud|cso|chd|pbp|pkg|vpk|xex|gdi|cdi)$/i;
const CONSOLE_FOLDER = /(^|\/)(ps3_game\/|ps3_disc\.sfb$|sce_sys\/param\.(sfo|json)$|exefs\/main$|romfs\/)/i;
/** the consoles a pick's files name (a ROM's extension, a dumped game folder's own files); none when nothing says */
const CONSOLES: [RegExp, string[]][] = [
  [/\.(z64|n64|v64)$/i, ["n64"]], [/\.(nsp|xci|nsz|xcz)$/i, ["switch"]], [/(^|\/)(exefs\/main$|romfs\/)/i, ["switch"]], [/\.(wbfs|wia)$/i, ["wii"]], [/\.(rvz|gcz|gcm)$/i, ["gc", "wii"]],
  [/\.(wua|wux|wud)$/i, ["wiiu"]], [/\.(3ds|cia)$/i, ["3ds"]], [/\.nds$/i, ["nds"]], [/\.gba$/i, ["gba"]], [/\.gbc$/i, ["gbc", "gb"]], [/\.gb$/i, ["gb", "gbc"]],
  [/\.(sfc|smc)$/i, ["snes"]], [/\.(nes|fds)$/i, ["nes"]], [/\.(pbp|cso)$/i, ["psp", "ps1"]], [/\.vpk$/i, ["vita"]], [/\.xex$/i, ["x360"]], [/\.(gdi|cdi)$/i, ["dc"]],
  [/(^|\/)(ps3_game\/|ps3_disc\.sfb$)/i, ["ps3"]], [/(^|\/)sce_sys\/param\.json$/i, ["ps5"]], [/(^|\/)sce_sys\/param\.sfo$/i, ["ps4"]],
];
export function consolesOf(p: Picked): string[] {
  const out = new Set<string>();
  for (const f of p.files) for (const [re, ids] of CONSOLES) if (re.test(f.path)) for (const id of ids) out.add(id);
  return [...out];
}

/** does the pick look like a console's game data (a ROM, a console disc image, a dumped game folder) and not like a PC game? */
export function looksLikeConsoleData(p: Picked): boolean {
  if (!p.files.length) return false;
  if (p.files.some(f => CONSOLE_FOLDER.test(f.path))) return true;
  if (p.files.some(f => /\.(exe|msi)$/i.test(f.path))) return false;
  return p.files.length <= 8 && p.files.some(f => CONSOLE_FILE.test(f.path));
}

/* ─────────── sending ─────────── */

export type Phase = "starting" | "sending" | "paused" | "finishing" | "handed" | "failed";
export interface UploadState {
  /** this tab's own number for it (the server's id comes once it answers) */
  key: number; gameId: number; gameName: string; name: string; files: number; bytes: number; wayId: number | null;
  uploadId: number | null; phase: Phase;
  /** bytes the server has, plus what is on its way */
  sent: number;
  /** bytes a second, over the last seconds */
  rate: number;
  /** a file being sent right now, and how many more are on their way beside it */
  current: string | null; more: number;
  /** the server does not answer: sending goes on by itself once it does */
  waiting: boolean;
  error: string | null;
  /** the job that takes it in, once every byte is there */
  jobId: number | null;
}

/** how the server is reached (the page gives the real one; a test its own) */
export interface Io {
  create(gameId: number, body: { name: string; files: number; bytes: number; wayId: number | null; replace: boolean }): Promise<{ item: UploadView; resumed?: boolean }>;
  files(id: number): Promise<{ item: UploadView; files: ServerFile[] }>;
  /** how much of one file the server has (nothing is sent): asked after a piece failed, before the next */
  where(id: number, path: string): Promise<{ received: number; done: boolean }>;
  /** a piece of one file at `offset`; refused with an ApiError (409 carries `received` in its data, or `busy`) */
  piece(id: number, path: string, size: number, offset: number, body: Blob, o: { signal: AbortSignal; onProgress: (sent: number) => void }): Promise<{ received: number; done: boolean }>;
  finish(id: number): Promise<{ item: UploadView; job: JobView }>;
  remove(id: number): Promise<unknown>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

interface Running extends UploadState {
  picked: Picked; replace: boolean; io: Io;
  ac: AbortController | null;
  /** bytes of each file the server has confirmed, and bytes of the piece on its way */
  have: Map<string, number>; flight: Map<string, number>;
  /** the files being sent right now */
  active: Set<string>;
  samples: [number, number][];
}

const uploads = new Map<number, Running>();
const listeners = new Set<() => void>();
let snapshot: UploadState[] = [];
let seq = 0, lastTold = 0, pending: ReturnType<typeof setTimeout> | null = null;

const view = (r: Running): UploadState => ({
  key: r.key, gameId: r.gameId, gameName: r.gameName, name: r.name, files: r.files, bytes: r.bytes, wayId: r.wayId, uploadId: r.uploadId, phase: r.phase,
  sent: r.sent, rate: r.rate, current: r.active.values().next().value ?? null, more: Math.max(0, r.active.size - 1), waiting: r.waiting, error: r.error, jobId: r.jobId,
});
function publish() {
  pending = null; lastTold = Date.now();
  snapshot = [...uploads.values()].map(view);
  for (const l of listeners) { try { l(); } catch { /* a page that is gone */ } }
}
/** a change the pages hear of: at once when the state moved, a few times a second while bytes flow */
function changed(now = false) {
  if (now) { if (pending) { clearTimeout(pending); pending = null; } publish(); return; }
  if (pending) return;
  pending = setTimeout(publish, Math.max(0, 250 - (Date.now() - lastTold)));
}

export const subscribeUploads = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const uploadsNow = (): UploadState[] => snapshot;
/** is anything still on its way to the server (the tab should not be closed)? */
export const uploadsBusy = (): boolean => snapshot.some(u => u.phase === "starting" || u.phase === "sending" || u.phase === "finishing");

function measure(r: Running) {
  let sent = 0;
  for (const n of r.have.values()) sent += n;
  for (const n of r.flight.values()) sent += n;
  r.sent = Math.min(r.bytes, sent);
  const t = r.io.now();
  r.samples.push([t, r.sent]);
  while (r.samples.length > 2 && t - r.samples[0][0] > 5000) r.samples.shift();
  const [t0, s0] = r.samples[0];
  r.rate = t > t0 ? Math.max(0, ((r.sent - s0) * 1000) / (t - t0)) : 0;
}

const PAUSED = Symbol("paused");
/** what this tab found wrong itself (a file that is another one on the server): nothing to try again */
class Stop extends Error {}
/** a refusal the server will repeat (the upload is gone, a name it does not take, no room), or one of this tab's own:
 *  nothing to try again. Everything else is the line or the server being away (a fetch that failed, a 5xx): waited out */
const final = (e: unknown) => e instanceof Stop || (e instanceof ApiError && ((e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) || e.status === 507));
const pause = (fails: number) => Math.min(30_000, 1000 * 2 ** Math.min(5, fails - 1));

/** one call to the server that is tried again while the line or the server is away (not a piece: those keep their place
 *  themselves): the upload neither stops nor asks anything for a start, a look or a hand-over that did not get through */
async function steady<T>(r: Running, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  for (let fails = 0; ;) {
    if (signal.aborted) throw PAUSED;
    try {
      const v = await call();
      if (fails) { r.waiting = false; changed(true); }
      return v;
    } catch (e) {
      if (signal.aborted) throw PAUSED;
      if (final(e)) throw e;
      if (++fails > MAX_FAILS) throw new Error(`the server stopped answering (${(e as Error)?.message ?? e})`);
      r.waiting = true; changed(true);
      await r.io.sleep(pause(fails), signal).catch(() => {});
    }
  }
}

async function sendFile(r: Running, f: PickedFile, signal: AbortSignal) {
  r.active.add(f.path);
  try { await sendPieces(r, f, signal); } finally { r.active.delete(f.path); }
}
async function sendPieces(r: Running, f: PickedFile, signal: AbortSignal) {
  const id = r.uploadId!;
  let offset = r.have.get(f.path) ?? 0;
  /** tries in a row that failed, for this file (each file counts its own: three sent side by side share no budget) */
  let fails = 0;
  const at = (n: number) => { offset = n; r.have.set(f.path, n); measure(r); changed(); };
  for (;;) {
    if (signal.aborted) throw PAUSED;
    try {
      const got = await r.io.piece(id, f.path, f.size, offset, f.file.slice(offset, Math.min(f.size, offset + PIECE)), {
        signal, onProgress: sent => { r.flight.set(f.path, sent); measure(r); changed(); },
      });
      r.flight.delete(f.path);
      fails = 0; r.waiting = false;
      at(got.received);
      if (got.done) return;
    } catch (e) {
      r.flight.delete(f.path);
      if (signal.aborted) throw PAUSED;
      const data = e instanceof ApiError ? (e.data as { received?: unknown; done?: unknown; busy?: unknown } | null) : null;
      if (e instanceof ApiError && e.status === 409 && typeof data?.received === "number") {
        // the server has another number of bytes than this tab thought: it knows, so on from there
        at(data.received);
        if (data.done === true) return;
        continue;
      }
      // an earlier piece of the file has not let go on the server yet (its line dropped without a word): a moment, then again
      const busy = e instanceof ApiError && e.status === 409 && data?.busy === true;
      if (!busy && final(e)) throw e;
      if (++fails > MAX_FAILS) throw new Error(`the server stopped answering (${(e as Error)?.message ?? e})`);
      r.waiting = true; measure(r); changed(true);
      await r.io.sleep(pause(fails), signal).catch(() => {});
      if (signal.aborted) throw PAUSED;
      // where the file ends on the server now: the piece may have arrived in part, or whole, before the line dropped
      try {
        const now = await r.io.where(id, f.path);
        if (now.done && now.received !== f.size) throw new Stop(`${f.path} has another size on the server: remove the upload and send it again`);
        at(now.received);
        if (now.done) { r.waiting = false; return; }
      } catch (w) {
        if (signal.aborted) throw PAUSED;
        if (final(w)) throw w;
        // still no answer (the line is down, the server is starting): the next try says
      }
    }
  }
}

async function run(r: Running) {
  const ac = new AbortController();
  r.ac = ac; r.error = null; r.waiting = false; r.samples = [];
  r.phase = r.uploadId == null ? "starting" : "sending";
  changed(true);
  try {
    if (r.uploadId == null) {
      // (the same pick again is the same upload on the server: a start whose answer was lost is asked again safely)
      const made = await steady(r, ac.signal, () => r.io.create(r.gameId, { name: r.name, files: r.files, bytes: r.bytes, wayId: r.wayId, replace: r.replace }));
      r.uploadId = made.item.id;
    }
    if (ac.signal.aborted) throw PAUSED;
    const id = r.uploadId;
    // what the server has already (the same pick sent before, or pieces that arrived before a pause)
    const there = new Map((await steady(r, ac.signal, () => r.io.files(id))).files.map(f => [f.path, f]));
    r.have = new Map(); r.flight = new Map();
    const todo: PickedFile[] = [];
    for (const f of r.picked.files) {
      const s = there.get(f.path);
      if (s && s.size > f.size) throw new Stop(`${f.path} is larger on the server than here: remove the upload and send it again`);
      if (s?.done && s.size !== f.size) throw new Stop(`${f.path} has another size on the server: remove the upload and send it again`);
      r.have.set(f.path, s?.size ?? 0);
      if (!s?.done) todo.push(f);
    }
    r.phase = "sending"; measure(r); changed(true);
    let next = 0;
    const worker = async () => { while (next < todo.length) await sendFile(r, todo[next++], ac.signal); };
    const workers = Array.from({ length: Math.min(PARALLEL, todo.length) }, worker);
    // the first to fail stops the others, and all are awaited: none goes on writing after the upload has stopped
    const ends = await Promise.allSettled(workers.map(w => w.catch(e => { ac.abort(); throw e; })));
    const bad = ends.find((x): x is PromiseRejectedResult => x.status === "rejected" && x.reason !== PAUSED) ?? ends.find((x): x is PromiseRejectedResult => x.status === "rejected");
    if (bad) throw bad.reason;
    // paused while the last pieces were on their way: they arrived, and it stays paused (nothing is handed over unasked)
    if (ac.signal.aborted) throw PAUSED;
    r.phase = "finishing"; measure(r); changed(true);
    let tries = 0, jobId: number | null;
    try { jobId = (await steady(r, ac.signal, () => { tries++; return r.io.finish(id); })).job.id; }
    catch (e) {
      // a hand-over whose answer was lost, asked again: the server says it is being taken in already (or, taken in and done, that it is gone)
      const again = tries > 1 && e instanceof ApiError && (e.status === 409 || e.status === 404);
      const now = again && e.status === 409 ? await r.io.files(id).catch(() => null) : null;
      if (again && e.status === 404) jobId = null;
      else if (now?.item.state === "importing") jobId = now.item.jobId;
      else throw e;
    }
    // handed over: the pages hear it once (with the job that takes it in), then it is the server's to show
    r.jobId = jobId; r.sent = r.bytes; r.rate = 0; r.phase = "handed";
    changed(true);
    uploads.delete(r.key);
  } catch (e) {
    if ((r.phase as Phase) === "paused") { /* the admin's own pause (pauseUpload set it) */ }
    else if (e === PAUSED) r.phase = "paused";
    else { r.phase = "failed"; r.error = String((e as Error)?.message ?? e); }
    r.rate = 0; r.waiting = false; r.flight = new Map();
  } finally {
    if (r.ac === ac) r.ac = null;
    r.active.clear();
    changed(true);
  }
}

/** send what was picked for the game: as its copy, or (wayId) as that way's game file */
export function startUpload(io: Io, game: { id: number; name: string }, picked: Picked, o: { wayId?: number | null; replace?: boolean } = {}): number {
  const key = ++seq;
  const r: Running = {
    key, gameId: game.id, gameName: game.name, name: picked.name, files: picked.files.length, bytes: picked.bytes, wayId: o.wayId ?? null, uploadId: null, phase: "starting",
    sent: 0, rate: 0, current: null, more: 0, waiting: false, error: null, jobId: null,
    picked, replace: o.replace === true, io, ac: null, have: new Map(), flight: new Map(), active: new Set(), samples: [],
  };
  uploads.set(key, r);
  void run(r);
  return key;
}
/** stop sending; what arrived stays on the server */
export function pauseUpload(key: number) {
  const r = uploads.get(key);
  if (!r || (r.phase !== "starting" && r.phase !== "sending")) return;
  r.phase = "paused"; r.rate = 0;
  r.ac?.abort();
  changed(true);
}
/** go on with one that was paused or that stopped */
export function continueUpload(key: number) {
  const r = uploads.get(key);
  if (!r || r.ac || (r.phase !== "paused" && r.phase !== "failed")) return;
  void run(r);
}
/** forget one in this tab (it is handed over, or the admin removed it): nothing more is sent */
export function forgetUpload(key: number) {
  const r = uploads.get(key);
  if (!r) return;
  if (r.phase === "starting" || r.phase === "sending") r.phase = "paused";
  r.ac?.abort();
  uploads.delete(key);
  changed(true);
}
/** the upload of this tab that is the server's upload `id` */
export const localUpload = (list: UploadState[], id: number): UploadState | null => list.find(u => u.uploadId === id) ?? null;

/* ─────────── words ─────────── */

/** "3 min left", "1 h 20 min left", or nothing while it cannot be told */
export function timeLeft(bytes: number, sent: number, rate: number): string | null {
  if (!(rate > 0) || sent >= bytes) return null;
  const s = (bytes - sent) / rate;
  if (s < 60) return "under a minute left";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`;
}
