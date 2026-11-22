/**
 * ludarr — the queue: a release → a download client → this machine.
 *
 *   submitted ─► downloading ─► seedbox_done ─► pulling ─► done
 *       └─────────────┴───────────────┴─────────────┴──────► failed   (retry from the queue)
 *                                     └──► arriving ──► done   (the finished-downloads folder set and there: the admin's own
 *                                                                sync brings it, src/arrivals.ts; an arrival never fails its
 *                                                                download)
 *
 * State lives in `fetches`, so a restart resumes where it left off. The worker is a poll loop (download
 * clients have no push): one tick every QUEUE_POLL_SEC, one snapshot per client per tick no matter how
 * many downloads are in flight. Which client takes a release: the first enabled one, by priority, that
 * speaks its protocol.
 *
 * The seedbox's trouble is never the copy's (src/remote.ts): a client that does not answer leaves its downloads as they
 * were (nothing counts as a stall while it is silent, nothing vanishes); an item missing from its list is gone only once it
 * was missing at least 3 times over at least 15 minutes from lists that look sane — a list without any of ludarr's
 * downloads (two or more) is believed only once it said so as often and as long. The stall clock (fetches.still_sec) runs
 * only while a torrent has no one to download from — never while it waits in the client (paused, queued, checking), while
 * its tracker does not answer the seedbox, while the seedbox's disk or link is full, and never for usenet (NZBGet's own
 * health check decides that); a torrent with seeders that sends nothing runs it at a third of the speed, one with no one to
 * download from on a box whose client is slow to answer at half. A download that does not move at all is bounded by its
 * request (moved_at: asked about after a day, stopped after three). A transfer the seedbox broke off (a dropped connection,
 * a short read, a transfer that stopped moving, a mapped folder that has not shown the download yet) goes back to
 * seedbox_done and is tried again after 1, 2, 5, 10, 20, 30, 60 min, then hourly, resuming where it stopped (the https
 * engine's .ahoy-part sidecar, lftp -c); it fails only when its files are gone for good (absent 3 times over 15 min and the
 * client no longer has them — a usenet download is only a record in NZBGet's history once its folder is gone) or its
 * settings are wrong. After 72 h of that it stops and waits for the admin (fetches.trouble_json stopped; retry picks it up).
 */
import { existsSync } from "node:fs";
import { kv, stmts, serializeFetch, type FetchRow } from "./db";
import { cfgNum, stagingDir, downloadsDir } from "./config";
import { logger } from "./log";
import * as registry from "./plugins/registry";
import type { DownloadClient, Indexer, ItemsSnapshot, Payload, Release } from "./plugins/types";
import { parseTorrent, parseMagnet, torrentFileList } from "./bencode";
import type { PullHandle } from "./pull";
import type { SbItem, SbClient } from "./seedbox-items";
import { goneRule, inWords, ladderSec, lookSec, rmdeps, STOP_AFTER_SEC, syncedRoot, tail, type ClientView } from "./remote";
import { beginArrival, fromSeedbox, resumeArrival, seedboxMissed } from "./arrivals";
import { arrivalsDir } from "./synced";
import { clientTrouble, messageOf, transportTrouble } from "./transport";

const log = logger("Download");

/** swappable in tests */
export const deps = {
  clients: (): { id: number; name: string; client: DownloadClient; protocols: string[] }[] => registry.downloadClients().map(c => ({ id: c.row.id, name: c.row.name, client: c.client, protocols: c.protocols })),
  clientById: (id: number): DownloadClient | null => registry.downloadClientById(id),
  indexerById: (id: number): Indexer | null => registry.indexerById(id),
  log: (...a: unknown[]) => log.log(...a),
  now: () => Date.now(),
};

export class FetchError extends Error {
  /** `transient`: the download client did not answer (a timeout, a dropped connection, a 5xx): the same release is tried
   *  again later, nothing is marked tried or blocklisted */
  constructor(msg: string, public status = 400, public transient = false) { super(msg); }
}

/** a magnet needs a moment to show up in the client; after this, "not found" is real */
const CLIENT_GRACE_SEC = 180;

export function clientFor(protocol: string) {
  return deps.clients().find(c => c.protocols.includes(protocol)) ?? null;
}

/** `pre`: the release's payload fetched moments ago (a way's search read its listing from it), so the indexer is asked once */
export async function grab(release: Release, gameId: number | null, pre?: Payload): Promise<{ fetch: ReturnType<typeof serializeFetch>; duplicate: boolean }> {
  const protocol = release.protocol;
  if (protocol !== "torrent" && protocol !== "usenet") throw new FetchError(`unsupported protocol: ${protocol}`);
  const target = clientFor(protocol);
  if (!target) throw new FetchError(`no enabled download client handles ${protocol} — add one under Settings → Download clients`, 400);

  // the same post again (a usenet post has no info hash: its guid says it): one still in flight, waiting out the seedbox, or
  // landed and never imported (a search that stopped waiting for the seedbox, one removed without its download) is the
  // download — never a second one of the same post beside it (NZBGet's own dupe check looks back two hours only)
  const same = release.guid ? (stmts.fetchByGuid.get(release.guid) as FetchRow | undefined) : undefined;
  // (one that landed in the finished-downloads folder and is no longer there was taken by that folder's cleanup: it is
  // downloaded anew)
  if (same && (same.state !== "done" || (same.imported_at == null && same.cleaned_at == null && !!same.local_path && (!syncedRoot(same.local_path) || existsSync(same.local_path))))) return { fetch: serializeFetch(again(same)), duplicate: true };

  let payload: Payload;
  try {
    const indexer = deps.indexerById(release.instanceId);
    if (pre) payload = pre;
    else if (indexer) payload = await indexer.download(release);
    else if (release.magnetUrl) payload = { kind: "magnet", uri: release.magnetUrl };
    else throw new Error(`the indexer that found it (instance ${release.instanceId}) is gone`);
  } catch (e: any) { throw new FetchError(`could not fetch the release payload: ${e?.message ?? e}`, 502); }

  let infoHash: string | null = null;
  let size = release.size;
  let title = release.title;
  if (payload.kind === "magnet") {
    const m = parseMagnet(payload.uri);
    if (!m) throw new FetchError("the indexer returned an unparsable magnet", 502);
    infoHash = m.infoHash;
  } else if (payload.kind === "torrent") {
    const meta = parseTorrent(payload.bytes);
    infoHash = meta.infoHash;
    size = meta.length || size;
    title = title || meta.name;
  }
  if (infoHash) {
    // the same torrent again: a duplicate while it is in flight, or when its download is still on disk —
    // a finished row whose files are gone (imported and cleaned up long ago) is simply downloaded again
    const dup = stmts.fetchByHash.get(infoHash) as FetchRow | undefined;
    if (dup && (dup.state !== "done" || (dup.local_path && existsSync(dup.local_path)))) return { fetch: serializeFetch(again(dup)), duplicate: true };
  }
  // the client not answering is its trouble, not the release's (the add is safe to send again: rTorrent is asked for the
  // hash first, NZBGet for the release's dupe key)
  let added: Awaited<ReturnType<DownloadClient["add"]>>;
  try { added = await target.client.add(payload, { title, protocol, key: release.guid }); }
  catch (e) { const t = clientTrouble(e); throw new FetchError(t ? `${target.name} did not answer (${t})` : messageOf(e), t ? 503 : 400, !!t); }
  const row = stmts.insertFetch({
    game_id: gameId, guid: release.guid, indexer_id: release.indexerId, indexer: release.indexer,
    title, protocol, size, info_hash: infoHash ?? added.infoHash ?? null, client: added.client, client_id: added.clientId,
    state: "submitted", release_json: JSON.stringify(release), client_instance_id: target.id, indexer_instance_id: release.instanceId || null,
  });
  // what the .torrent lists: what an arrival in the finished-downloads folder waits for when the client cannot say
  // (src/arrivals.ts) — kept only while that folder is on (without it, nothing reads it)
  if (payload.kind === "torrent" && arrivalsDir()) { const list = torrentFileList(payload.bytes); if (list?.length) stmts.setFetchFiles.run(JSON.stringify(list), row.id); }
  deps.log(`#${row.id} sent to ${target.name} (${added.client}): ${title}`);
  return { fetch: serializeFetch(row), duplicate: false };
}

/** a download taken up again by a new grab: one that stopped waiting for the seedbox (72 h of it) is tried again now — a grab
 *  that found it would otherwise only fail on its stopped wait at once */
function again(f: FetchRow): FetchRow {
  if (f.state === "seedbox_done" && troubleOf(f)?.stopped) { retry(f.id); return stmts.fetchById.get(f.id) as FetchRow; }
  return f;
}

/* ───────────────────────── what the clients said last ───────────────────────── */

/** each client's latest answer (what the seedbox judge reads instead of asking again) */
const snaps = new Map<number, { at: number; snap: ItemsSnapshot }>();
/** clients that did not answer: since when (ms), and why */
const silent = new Map<number, { since: number; why: string }>();
/** each client's best total download rate this week (bytes/s): the yardstick of a full link — kept across restarts (kv), so a
 *  restart never makes the first trickle seen the link's best */
const best = new Map<number, { rate: number; at: number }>();
const WEEK_MS = 7 * 86_400_000;
const bestKey = (id: number) => `seedbox.bestRate.${id}`;
/** the looks at which a client answered without any of ludarr's downloads (two or more) — believed once it said so 3 times
 *  over 15 minutes, like any one download's absence */
const allMissing = new Map<number, number[]>();
/** why each download's stall clock runs or stands (in memory: words only) */
const stallNotes = new Map<number, string>();
export const stallNoteOf = (fetchId: number): string | null => stallNotes.get(fetchId) ?? null;
/** since when a client has not answered (ms; null: it answers) */
export const clientSilentSince = (instanceId: number | null | undefined): number | null => (instanceId != null ? silent.get(instanceId)?.since ?? null : null);

const NAMES: Record<string, string> = { rtorrent: "rTorrent", nzbget: "NZBGet" };
/** what a download's client says of it: from the snapshot of the last 60 s, else asked now (an answer is the client back) */
export async function clientViewOf(f: Pick<FetchRow, "id" | "client" | "client_id" | "client_instance_id" | "protocol">): Promise<ClientView> {
  const id = instanceOf(f as FetchRow);
  const client = id ? deps.clientById(id) : null;
  const name = NAMES[f.client] ?? f.client;
  if (!client || !f.client_id) return { answered: false, has: false, name };
  let s = snaps.get(id!);
  if (!s || deps.now() - s.at > 60_000) {
    try { s = { at: deps.now(), snap: await client.items() }; snaps.set(id!, s); silent.delete(id!); }
    catch { return { answered: false, has: false, name }; }
  }
  if (s.snap.unavailable?.includes(f.client as SbClient)) return { answered: false, has: false, name };
  const it = s.snap.items.find(i => i.client === f.client && i.clientId === f.client_id);
  if (!it) return { answered: true, has: false, name };
  return { answered: true, has: true, complete: it.state === "done", size: it.sizeBytes, lost: LOST.test(it.message), name, item: it };
}
rmdeps.clientView = f => clientViewOf(f as FetchRow);
rmdeps.silentClients = () => [...silent].map(([id, s]) => ({ name: deps.clients().find(c => c.id === id)?.name ?? `download client ${id}`, since: s.since }));

/** a client that lists an item but cannot open its files (rTorrent's message): its files are missing on the box */
const LOST = /No such file|Could not open|Storage error|does not exist/i;
/** the box's disk is full: everything on it waits */
const DISK_FULL = /No space left|disk full|not enough (?:disk )?space|DISKSPACE/i;
/** the tracker no longer knows the torrent: a dead post, nothing to wait for */
const UNREGISTERED = /unregistered|not registered|torrent not found|info ?hash (?:not found|not authorized)|torrent (?:has been )?deleted/i;
/** an announce that failed on the way (rTorrent's message for a tracker that did not answer the box: its link choked, its
 *  DNS down, the tracker down): no peers then says nothing of the post */
const TRACKER_DOWN = /Tracker: \[(?:Timeout was reached|Couldn'?t connect|Could not connect|Couldn'?t resolve|Could not resolve|Failed to connect|Connection (?:refused|reset|timed out)|Server returned nothing|HTTP response code said error|SSL connect error|Operation timed out|Failure when receiving data|Send failure|Recv failure)/i;

/* ───────────────────────── worker ───────────────────────── */

const pulls = new Map<number, PullHandle>();
const pullBytes = new Map<number, { b: number; at: number }>();
/** when each transfer last moved (ms): one that stands still for PULL_STALL_MS is stopped and tried again later */
const pullMoved = new Map<number, { b: number; at: number }>();
const PULL_STALL_MS = 15 * 60_000;
/** transfers whose end is being judged (pullFailed waits for the client's word): neither resumed nor started again meanwhile */
const judging = new Set<number>();
/** a transfer that resumed after a wait: what it had when it started — once it has moved on from there, the wait is over */
const resumedAt = new Map<number, number>();
const RESUMED_MOVED = 64 * 2 ** 20;
let ticking = false;

export const activePulls = () => pulls.size;

/** Cancel every in-flight pull and forget the handles (shutdown, tests). Rows stay as they are. */
export function cancelAllPulls() {
  for (const h of pulls.values()) h.cancel();
  pulls.clear();
  pullMoved.clear();
  resumedAt.clear();
}
/** tests (and a restart, in effect): forget what the clients said — the week's best rates stay (forgetBestRates) */
export function forgetSnapshots() { snaps.clear(); silent.clear(); best.clear(); allMissing.clear(); stallNotes.clear(); }
/** tests: forget the clients' best rates too */
export function forgetBestRates() { for (const c of deps.clients()) kv.del(bestKey(c.id)); for (let id = 0; id < 64; id++) kv.del(bestKey(id)); best.clear(); }

/** rows from before download clients were instances: the first enabled client that speaks the protocol */
function instanceOf(r: FetchRow): number | null {
  if (r.client_instance_id) return r.client_instance_id;
  return clientFor(r.protocol)?.id ?? null;
}

/** a download's wait on the seedbox (fetches.trouble_json) */
export interface FetchTrouble {
  /** when the trouble began (unix s) and the transfers tried since */
  since: number;
  tries: number;
  words: string;
  /** snapshots the client answered without the item (unix s): first and the latest few */
  missing?: number[];
  /** looks that found its files absent on the seedbox while the client no longer had them */
  absent?: number[];
  /** waited 72 h: the transfer is not tried again until someone retries it */
  stopped?: boolean;
}
export function troubleOf(r: Pick<FetchRow, "trouble_json"> | null | undefined): FetchTrouble | null {
  if (!r?.trouble_json) return null;
  try { const t = JSON.parse(r.trouble_json) as FetchTrouble; return t && typeof t.since === "number" ? t : null; } catch { return null; }
}
/** the first look and the latest few (the gone rule reads the span and the count) */
const pushLook = (a: number[] | undefined, t: number) => { const x = a ?? []; return x.length < 5 ? [...x, t] : [x[0], ...x.slice(-3), t]; };

/** the week's best total rate of a client, this answer counted (kept across restarts) */
function bestRate(id: number, total: number): number {
  const now = deps.now();
  let b = best.get(id);
  if (!b) { try { const v = JSON.parse(kv.get(bestKey(id)) ?? "null"); if (v && typeof v.rate === "number" && typeof v.at === "number") b = v; } catch { /* none kept */ } }
  if (!b || total > b.rate || now - b.at > WEEK_MS) { b = { rate: total, at: now }; try { kv.set(bestKey(id), JSON.stringify(b)); } catch { /* kept in memory */ } }
  best.set(id, b);
  return b.rate;
}

interface SnapCtx { nowSec: number; rpcMs: number; total: number; best: number; insane: boolean; streak: number[] | null; items: SbItem[] }

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const rows = stmts.fetchesActive.all() as FetchRow[];
    const polling = rows.filter(r => r.state === "submitted" || r.state === "downloading");
    const byInstance = new Map<number | null, FetchRow[]>();
    for (const r of polling) { const id = instanceOf(r); byInstance.set(id, [...(byInstance.get(id) ?? []), r]); }
    // a client with nothing in flight any more is no silent client (its silence was about downloads that are gone)
    for (const id of [...silent.keys()]) if (!byInstance.has(id)) silent.delete(id);
    const nowSec = Math.floor(deps.now() / 1000);
    for (const [id, group] of byInstance) {
      const client = id ? deps.clientById(id) : null;
      if (!client) { for (const r of group) stmts.setFetchState.run(r.state, r.progress, "its download client is gone — re-add it under Settings", r.id); continue; }
      let snap: ItemsSnapshot;
      const t0 = Date.now();
      try { snap = await client.items(); }
      catch (e: any) {
        // a client that does not answer: its downloads stay as they were — nothing stalls, nothing vanishes while it is silent
        const why = clientTrouble(e) ?? messageOf(e);
        if (!silent.has(id!)) silent.set(id!, { since: deps.now(), why });
        deps.log(`download client ${id} unreachable: ${e?.message ?? e}`);
        continue;
      }
      const rpcMs = Date.now() - t0;
      silent.delete(id!);
      snaps.set(id!, { at: deps.now(), snap });
      const total = snap.items.reduce((a, i) => a + Math.max(0, i.downRate || 0), 0);
      const yard = bestRate(id!, total);
      // a list without every one of ludarr's downloads at once (two or more) is not believed at first: a client that answered
      // with an empty or cut-short list says nothing of what it holds — until it said so 3 times over 15 minutes
      const find = (r: FetchRow) => snap.items.find(i => i.client === r.client && i.clientId === r.client_id) ?? null;
      const judged = group.filter(r => nowSec - r.created_at > CLIENT_GRACE_SEC && !snap.unavailable?.includes(r.client as SbClient));
      let insane = false, streak: number[] | null = null;
      if (judged.length >= 2 && judged.every(r => !find(r))) {
        streak = pushLook(allMissing.get(id!), nowSec);
        allMissing.set(id!, streak);
        insane = !goneRule(streak);
        deps.log(insane ? `download client ${id} listed none of ludarr's ${judged.length} downloads: not believed yet` : `download client ${id} has listed none of ludarr's ${judged.length} downloads ${streak.length} times over ${inWords(streak[streak.length - 1] - streak[0])}: believed`);
      } else allMissing.delete(id!);
      const ctx: SnapCtx = { nowSec, rpcMs, total, best: yard, insane, streak: insane ? null : streak, items: snap.items };
      for (const r of group) {
        if (snap.unavailable?.includes(r.client as SbClient)) continue;
        pollItem(r, find(r), ctx);
      }
    }
    // pulls that were in flight when the process died: resume (both engines pick up where they left off) — never one whose
    // end is being judged right now
    for (const r of rows) {
      if (r.state === "pulling" && !pulls.has(r.id) && !judging.has(r.id)) stmts.setFetchState.run("seedbox_done", r.progress, "resuming after restart", r.id);
    }
    const cap = cfgNum("PULL_PARALLEL", 2);
    for (const r of stmts.fetchesByState.all("seedbox_done") as FetchRow[]) {
      if (pulls.size >= cap) break;
      if (r.retry_at && r.retry_at > nowSec) continue;                // a transfer the seedbox broke off: tried again at its time
      if (troubleOf(r)?.stopped) continue;                            // waited 72 h: the admin's to retry
      if (judging.has(r.id)) continue;
      startPullFor(r);
    }
    const now = deps.now();
    for (const [id, h] of [...pulls]) {
      const b = h.bytes();
      const prev = pullBytes.get(id);
      const rate = prev && now > prev.at ? Math.max(0, Math.round((b - prev.b) / ((now - prev.at) / 1000))) : 0;
      pullBytes.set(id, { b, at: now });
      stmts.setFetchPulling.run(h.progress(), rate, id);
      // a transfer that resumed after a wait and has moved on since: the wait is over (its clock, its tries are no next one's)
      const from = resumedAt.get(id);
      if (from != null && (b - from >= RESUMED_MOVED || h.progress() >= 1)) { stmts.setFetchTrouble.run(null, id); resumedAt.delete(id); }
      // a transfer that stands still (a full link, a segment that hangs) is stopped and tried again later: it resumes
      if (h.waits) continue;
      const m = pullMoved.get(id);
      if (!m || b > m.b) pullMoved.set(id, { b, at: now });
      else if (now - m.at >= PULL_STALL_MS) {
        pulls.delete(id); pullMoved.delete(id); resumedAt.delete(id);
        const cur = stmts.fetchById.get(id) as FetchRow | undefined;
        if (cur?.state === "pulling") retryLater(cur, `the transfer stopped moving for ${inWords((now - m.at) / 1000)}`);
        h.cancel();
      }
    }
    for (const id of [...pullBytes.keys()]) if (!pulls.has(id)) pullBytes.delete(id);
    for (const id of [...pullMoved.keys()]) if (!pulls.has(id)) pullMoved.delete(id);
  } finally {
    ticking = false;
  }
}

function fail(r: FetchRow, why: string) {
  stmts.setFetchState.run("failed", r.progress, why, r.id);
  deps.log(`#${r.id} failed: ${why}`);
}

/** missing from the client's list: gone only once it was missing at least 3 times over at least 15 minutes from lists
 *  that were believed — one list without it (a client answering mid-restart, NZBGet moving it to its history) is nothing.
 *  The client answered either way: the download's stage never calls it silent */
function vanished(r: FetchRow, x: SnapCtx) {
  stmts.setFetchAnswered.run(x.nowSec, r.id);
  if (x.insane || x.nowSec - r.created_at <= CLIENT_GRACE_SEC) return;
  const t: FetchTrouble = troubleOf(r) ?? { since: x.nowSec, tries: 0, words: "" };
  // a client believed only after it listed none of ludarr's downloads for long enough: those looks are this one's too
  const missing = t.missing?.length ? pushLook(t.missing, x.nowSec) : x.streak ?? [x.nowSec];
  if (goneRule(missing)) return fail(r, `not found in the download client (${r.client} ${r.client_id}): missing from its list ${missing.length} times over ${inWords(missing[missing.length - 1] - missing[0])}`);
  stmts.setFetchTrouble.run(JSON.stringify({ ...t, missing, words: t.words || `${NAMES[r.client] ?? r.client} does not list it right now` }), r.id);
}

/**
 * The stall clock's speed for a download the client answered about and that did not move: 0 while it waits in the client
 * (paused, checking), for usenet (NZBGet decides), while the box is busy (its disk full, its link full with other downloads
 * moving, its client slow to answer) or its tracker does not answer the box; a third for a torrent whose seeders send
 * nothing; a half for one with no one to download from on a box whose client is slow to answer; 1 for one with no one to
 * download from — whatever else moves — and for one nothing more is known of.
 */
function stallClock(r: FetchRow, it: SbItem, x: SnapCtx): { factor: number; note: string } {
  if (r.protocol === "usenet" || it.client === "nzbget") return { factor: 0, note: "NZBGet decides whether a usenet post is complete" };
  if (it.state === "paused") return { factor: 0, note: "it waits in the client (stopped or paused)" };
  if (it.checking) return { factor: 0, note: "the client is checking its data" };
  if (DISK_FULL.test(it.message)) return { factor: 0, note: "the seedbox's disk is full" };
  const none = it.peers === 0 && !it.seeders;
  if (none && TRACKER_DOWN.test(it.message)) return { factor: 0, note: `its tracker does not answer the seedbox (${it.message.slice(0, 100)}): it waits, nothing is wrong with this copy` };
  if (x.rpcMs > 5000) {
    const busy = `its client took ${Math.round(x.rpcMs / 1000)} s to answer`;
    return none ? { factor: 0.5, note: `no peers to download from, on a busy seedbox (${busy})` } : { factor: 0, note: `the seedbox is busy (${busy})` };
  }
  const others = x.items.some(i => !(i.client === r.client && i.clientId === r.client_id) && (i.downRate || 0) > 50_000);
  const full = others && x.best >= 1e6 && x.total >= 0.8 * x.best;
  if (none) return { factor: 1, note: "no peers to download from" };
  if (full) return { factor: 0, note: "the seedbox's link is full with other downloads: it waits, nothing is wrong with this copy" };
  if ((it.seeders ?? 0) > 0) return { factor: 1 / 3, note: `${it.seeders} seeder${it.seeders === 1 ? "" : "s"} connected, nothing sent yet` };
  return { factor: 1, note: "no progress" };
}

function pollItem(r: FetchRow, it: SbItem | null, x: SnapCtx) {
  if (!it) return vanished(r, x);
  const t = troubleOf(r);
  if (t?.missing?.length) { const { missing: _m, ...rest } = t; stmts.setFetchTrouble.run(rest.tries || rest.absent?.length ? JSON.stringify(rest) : null, r.id); }
  if (it.state === "done") {
    if (!it.path) return fail(r, `${r.client}: finished but reported no path`);
    stmts.setFetchSeedbox.run(it.path, it.isDir ? 1 : 0, it.sizeBytes, r.id);
    const warn = r.client === "nzbget" && it.message.startsWith("WARNING") ? `nzbget: ${it.message}` : null;
    stmts.setFetchState.run("seedbox_done", 1, warn, r.id);
    stmts.setFetchPolled.run(x.nowSec, 0, r.id);
    stallNotes.delete(r.id);
    deps.log(`#${r.id} complete in the client: ${it.path}${warn ? ` (${it.message})` : ""}`);
    return;
  }
  if (it.state === "failed") return fail(r, `${r.client}: ${it.message}`);
  if (it.client === "rtorrent" && UNREGISTERED.test(it.message)) return fail(r, `the tracker no longer has this torrent: ${it.message}`);
  // the stall clock: only for the time the client answered (a gap of more than 5 min between answers is not counted)
  const moved = it.progress > (r.progress ?? 0) + 1e-9;
  if (moved || r.moved_at == null) stmts.setFetchMoved.run(x.nowSec, r.id);
  const dt = r.polled_at ? Math.max(0, Math.min(300, x.nowSec - r.polled_at)) : 0;
  let still = moved ? 0 : (r.still_sec ?? 0);
  if (!moved) { const c = stallClock(r, it, x); still += dt * c.factor; stallNotes.set(r.id, c.note); }
  else stallNotes.delete(r.id);
  stmts.setFetchDownloading.run(it.progress, it.message || null, Math.max(0, Math.round(it.downRate || 0)), r.id);
  stmts.setFetchPolled.run(x.nowSec, Math.round(still), r.id);
}

/** a transfer the seedbox broke off: back to seedbox_done, tried again after the ladder's wait (it resumes) — or, after 72 h
 *  of trouble, left for the admin */
function retryLater(r: FetchRow, why: string, o: { look?: boolean; t?: FetchTrouble } = {}) {
  const nowSec = Math.floor(deps.now() / 1000);
  const t: FetchTrouble = o.t ?? troubleOf(r) ?? { since: nowSec, tries: 0, words: "" };
  t.tries++;
  t.words = why;
  if (nowSec - t.since >= STOP_AFTER_SEC) {
    t.stopped = true;
    stmts.setFetchRetry.run("seedbox_done", r.progress, `${why} — waited ${inWords(nowSec - t.since)} for the seedbox: it is tried again when you retry it (nothing was thrown away)`, null, JSON.stringify(t), r.id);
    deps.log(`#${r.id} stopped waiting for the seedbox: ${why}`);
    return;
  }
  const wait = o.look ? lookSec(t.absent?.length ?? 1) : ladderSec(t.tries - 1);
  stmts.setFetchRetry.run("seedbox_done", r.progress, `${why} — trying again in ${inWords(wait)} (it resumes where it stopped)`, nowSec + wait, JSON.stringify(t), r.id);
  deps.log(`#${r.id} transfer: ${why} — trying again in ${inWords(wait)}`);
}

/** settings that are wrong, not a seedbox that is choked: the download fails at once (a hidden file a web listing neither
 *  shows nor serves, src/pull-http.ts, is one: every try would list the same and fail the same) */
const CONFIG_TROUBLE = /no transfer URL|not installed on this host|download client is gone|did not say where|ignored Range|PULL_SEGMENTS|does not serve it either/i;
/** what a transfer says when the file is not on the seedbox (or not under the mapped folder) */
const ABSENT = /\bHTTP 404\b|No such file|not found|never appeared under|went away from the mapped folder/i;

/** a transfer that ended without its files: the seedbox's trouble (tried again later, resuming), its files gone for good
 *  (absent 3 times over 15 min and the client no longer has them — or, for usenet, only NZBGet's history remembers them: the
 *  hourly move out of complete/ took the folder), or settings that are wrong. The row is held (judging) while the client is
 *  asked, and acted on only as it still is afterwards */
async function pullFailed(id: number, why: string): Promise<void> {
  // cancelled by ludarr (a shutdown, a removal): the row stays as it is — a pull left 'pulling' resumes at the next start
  if (why === "cancelled") return;
  const cur = stmts.fetchById.get(id) as FetchRow | undefined;
  if (!cur || cur.state !== "pulling") return;                       // removed, or the watchdog moved it on already
  if (CONFIG_TROUBLE.test(why)) return fail(cur, why);
  const nowSec = Math.floor(deps.now() / 1000);
  const t: FetchTrouble = troubleOf(cur) ?? { since: nowSec, tries: 0, words: "" };
  if (ABSENT.test(why)) {
    const view = await rmdeps.clientView(cur).catch(() => ({ answered: false, has: false } as ClientView));
    // the row as it is after the client's word: removed, retried or started again meanwhile — nothing to do from here
    const now = stmts.fetchById.get(id) as FetchRow | undefined;
    if (!now || now.state !== "pulling" || pulls.has(id)) return;
    const name = view.name ?? cur.client, file = tail(cur.seedbox_path);
    const moved = view.answered && view.has && !view.lost && cur.protocol === "usenet";
    if (view.answered && (!view.has || view.lost || moved)) {
      t.absent = pushLook(t.absent, nowSec);
      const lost = moved ? `${name} finished it, so it was moved away (the hourly move out of complete/?)` : `${name} no longer has it`;
      // an import from the seedbox the admin chose instead of the finished-downloads folder: not on the seedbox is the sync
      // having carried it — never "gone", never a bad copy: it is awaited in that folder again (src/arrivals.ts)
      if (goneRule(t.absent) && fromSeedbox(now)) return seedboxMissed(now, `${file} was not there ${t.absent.length} times over ${inWords(t.absent[t.absent.length - 1] - t.absent[0])} and ${lost}`);
      if (goneRule(t.absent)) return fail(now, `gone from the seedbox: ${file} was not there ${t.absent.length} times over ${inWords(t.absent[t.absent.length - 1] - t.absent[0])} and ${lost}`);
      return retryLater(now, `${file} is not on the seedbox and ${moved ? `${name} finished it — moved away (the hourly move out of complete/?)` : `${name} no longer lists it`}; another copy is tried once it stays away for 15 min`, { look: true, t });
    }
    if (view.answered && view.has) return retryLater(now, `${name} has ${file}${view.size ? ` (${(view.size / 1e9).toFixed(1)} GB)` : ""}, but the transfer could not find it (${why.slice(0, 160)}) — check the remote path mapping`, { t });
    return retryLater(now, `${name} is not answering and the transfer could not find ${file}`, { t });
  }
  return retryLater(cur, `the transfer broke off: ${why.slice(0, 200)}`, { t });
}

function startPullFor(r: FetchRow) {
  if (!r.seedbox_path) return fail(r, "the client did not say where the files are");
  const id = instanceOf(r);
  const client = id ? deps.clientById(id) : null;
  if (!client) return fail(r, "its download client is gone");
  // the admin's own sync carries every finished download into the finished-downloads folder: while that is set and there, it
  // is awaited there, found by its name and imported in place, never pulled (src/arrivals.ts) — unless the admin chose to
  // import it from the seedbox instead
  if (!stagingDir() && arrivalsDir() && !fromSeedbox(r)) return beginArrival(r);
  const t = troubleOf(r);
  let h: PullHandle | { local: string };
  // a torrent's client that can list its files is asked when a transfer's file listing shows less than the client has: a web
  // listing hides names that start with a dot, and the rest is then fetched by its path (src/pull-http.ts)
  const files = r.protocol === "torrent" && client.files && r.client_id ? { files: () => client.files!({ client: r.client as SbClient, clientId: r.client_id! }) } : {};
  // a look for files found missing before (look): a mapped folder that does not show them is said at once, not after 30 min
  try { h = client.pull({ path: r.seedbox_path, isDir: !!r.seedbox_is_dir, sizeBytes: r.size ?? 0 }, { ...(stagingDir() ? { staging: downloadsDir(), fetchId: r.id } : {}), remotePath: r.seedbox_path, isDir: !!r.seedbox_is_dir, expectedBytes: r.size ?? 0, exact: r.protocol === "torrent", ...(t?.absent?.length ? { look: true } : {}), ...files }); }
  catch (e: any) {
    // a connector that could not be reached to start it is the seedbox's trouble: tried again later
    if (transportTrouble(e) || clientTrouble(e)) return retryLater(r, `the transfer could not start: ${e?.message ?? e}`);
    return fail(r, `transfer could not start: ${e?.message ?? e}`);
  }
  if ("local" in h) {
    stmts.setFetchDone.run(h.local, r.id);
    deps.log(`#${r.id} already here → ${h.local}`);
    return;
  }
  // never two transfers of one download: one still held (a tick that started it again) is stopped first
  const old = pulls.get(r.id);
  if (old && old !== h) old.cancel();
  pulls.set(r.id, h);
  pullMoved.delete(r.id); pullBytes.delete(r.id);                     // a new transfer: its own clock, not the last one's
  if (t && !t.stopped) resumedAt.set(r.id, h.bytes()); else resumedAt.delete(r.id);
  stmts.setFetchRetry.run("pulling", 0, null, null, r.trouble_json ?? null, r.id);   // its wait (if any) goes on should it break again
  stmts.setFetchLocal.run(h.localPath, r.id);
  deps.log(`#${r.id} pulling ${r.seedbox_path} → ${h.localPath}`);
  const handle = h;
  const judge = (why: string) => { judging.add(r.id); void pullFailed(r.id, why).finally(() => judging.delete(r.id)); };
  h.done.then(
    res => {
      if (pulls.get(r.id) === handle) pulls.delete(r.id);
      else if (!res.ok) return;                                         // a transfer replaced by a newer one: its end is not the row's
      if (res.ok) { stmts.setFetchDone.run(res.localPath, r.id); deps.log(`#${r.id} done → ${res.localPath}`); }
      else judge(res.error ?? "transfer failed");
    },
    e => { if (pulls.get(r.id) === handle) { pulls.delete(r.id); judge(String(e?.message ?? e)); } },
  );
}

export function retry(id: number) {
  const r = stmts.fetchById.get(id) as FetchRow | undefined;
  if (!r) throw new FetchError("not found", 404);
  // awaited in the finished-downloads folder: looked for again now (one that stopped after 72 h is awaited again from now)
  if (r.state === "arriving") { resumeArrival(r); return serializeFetch(stmts.fetchById.get(id) as FetchRow); }
  // a transfer that waits out the seedbox (stopped after 72 h, or waiting for its next try): tried now, its wait begun again
  if (r.state === "seedbox_done" && (r.retry_at || troubleOf(r)?.stopped)) {
    stmts.setFetchRetry.run("seedbox_done", r.progress, "trying again now", null, null, r.id);
    return serializeFetch(stmts.fetchById.get(id) as FetchRow);
  }
  if (r.state !== "failed") throw new FetchError(`cannot retry a download in state ${r.state}`, 409);
  const next = r.seedbox_path ? "seedbox_done" : r.client_id ? "submitted" : null;
  if (!next) throw new FetchError("nothing to retry — grab it again", 409);
  stmts.setFetchRetry.run(next, 0, null, null, null, r.id);
  return serializeFetch(stmts.fetchById.get(id) as FetchRow);
}

/** a download whose files lie in the finished-downloads folder: its row is all that can find, hold, list or remove them there
 *  (the removal once imported and the leftovers list both read the row) */
const tookAt = (r: FetchRow): string | null => { try { const t = r.took_json ? JSON.parse(r.took_json) : null; return typeof t?.path === "string" ? t.path : null; } catch { return null; } };
const lyingInFinished = (r: FetchRow) => {
  if (r.state === "done" && !!r.local_path && !!syncedRoot(r.local_path) && existsSync(r.local_path)) return true;
  const took = tookAt(r);                                    // taken there (a copy that reached it after an import from the seedbox, too)
  return !!took && existsSync(took);
};

/** Forget a download; with purge, also drop it from the client (its data is left alone). One whose files are still in the
 *  finished-downloads folder is not forgotten (409): its record stays, so a cancelled search leaves a leftover that can be
 *  listed and removed, never files nothing knows about. */
export async function remove(id: number, purge: boolean): Promise<void> {
  const r = stmts.fetchById.get(id) as FetchRow | undefined;
  if (!r) throw new FetchError("not found", 404);
  if (lyingInFinished(r)) throw new FetchError("its files are still in the finished-downloads folder, and this record is what finds them there: it is kept until they are gone from it", 409);
  pulls.get(id)?.cancel();
  pulls.delete(id);
  resumedAt.delete(id);
  if (purge && r.client_id) {
    const inst = instanceOf(r);
    const client = inst ? deps.clientById(inst) : null;
    try { if (client) await client.remove({ client: r.client as SbClient, clientId: r.client_id }, false); }
    catch (e: any) { deps.log(`#${id} removing from the client failed: ${e?.message ?? e}`); }
  }
  stmts.deleteFetch.run(id);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startWorker() {
  if (timer) return;
  const ms = cfgNum("QUEUE_POLL_SEC", 10) * 1000;
  timer = setInterval(() => { tick().catch(e => deps.log("tick failed:", e?.message ?? e)); }, ms);
  tick().catch(e => deps.log("tick failed:", e?.message ?? e));
  deps.log(`worker up, polling download clients every ${ms / 1000}s`);
  readyClients();
}
/** startup hooks (the seedbox connector installs itself here) */
export function readyClients() {
  for (const c of deps.clients()) c.client.ready?.().catch(e => deps.log(`${c.name}: ${e?.message ?? e}`));
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
