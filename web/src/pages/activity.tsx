/** Activity: the queue (searches in flight with their download and import), history, blocklist. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { del, get, post, fmtSize, fmtRate, timeAgo, sentence, type ArrivalChoice, type BlockItem, type HistoryItem, type QueueItem, type RefusedRelease } from "../api";
import { useEvents } from "../events";
import { Icon } from "../ui/icons";
import { Btn, Empty, IconBtn, Label, Modal, Progress, Spinner, ToolbarBtn, useLoad, useUi } from "../ui/kit";
import { EVENT_ICON, EVENT_TONE, protocolTone } from "../ui/status";
import { Art, art } from "../ui/art";

const STATE_TONE: Record<string, "queue" | "success" | "danger" | "warning" | "dim"> = { requested: "dim", matching: "queue", fetching: "queue", processing: "queue", ready: "success", failed: "danger", cancelled: "dim" };
const STATE_LABEL: Record<string, string> = { requested: "Waiting", matching: "Searching", fetching: "Downloading", processing: "Importing", ready: "Done", failed: "Failed", cancelled: "Cancelled" };

/** the answers to a download that does not arrive in the finished-downloads folder (its own words are the stage's) — a torrent downloaded
 *  again loses its copy on the seedbox first, and the button says so */
const ARRIVAL_CHOICE: Record<ArrivalChoice, { label: string; done: string }> = {
  seedbox: { label: "Import from the seedbox instead", done: "Importing it from the seedbox" },
  now: { label: "Import what has arrived", done: "Importing what has arrived" },
  wait: { label: "Keep waiting", done: "Waiting for it in the finished-downloads folder" },
  again: { label: "Download again", done: "Downloading it again" },
};
const choiceLabel = (q: QueueItem, c: ArrivalChoice) => (c === "again" && q.download?.protocol === "torrent" ? "Download again (deletes its seedbox copy)" : ARRIVAL_CHOICE[c].label);

/** what a search that took nothing found, and why each release was not taken: where it was, its first reason (every reason on
 *  hover) — the admin's page only, a player never sees these */
export function RefusedList({ items }: { items: RefusedRelease[] }) {
  if (!items.length) return null;
  return (
    <details className="dim">
      <summary>{items.length} found, none taken</summary>
      <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>{items.map((x, i) => <li key={i} title={x.why.join("\n")}>{x.title} · {x.indexer} · {x.why[0] ?? "—"}</li>)}</ul>
    </details>
  );
}

export function QueuePage() {
  const { toast } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ items: QueueItem[] }>("/api/v1/queue"), []);
  useEvents(["request", "job", "fetch", "package"], () => void reload());
  const [removing, setRemoving] = useState<QueueItem | null>(null);
  const [blocklist, setBlocklist] = useState(true);
  const remove = async () => {
    if (!removing) return;
    try { await del(`/api/v1/queue/${removing.id}?blocklist=${blocklist ? 1 : 0}`); toast("Removed from the queue", "success"); setRemoving(null); void reload(); }
    catch (e: any) { toast(e.message, "danger"); }
  };
  // a search waiting on the seedbox (or stopped after 72 h of it, its download kept) is tried again as it is — never searched
  // afresh, which would fetch another copy of what is on the seedbox already
  const retry = async (q: QueueItem, fresh = false) => { try { await post(`/api/v1/queue/${q.id}/retry${fresh && !q.waiting ? "?fresh=1" : ""}`); toast(q.waiting ? "Trying again now" : "Searching again"); void reload(); } catch (e: any) { toast(e.message, "danger"); } };
  // a download that does not arrive in the finished-downloads folder: the admin's answer to the question its stage asks
  const answer = async (q: QueueItem, choice: ArrivalChoice) => {
    if (!q.download) return;
    try { await post(`/api/v1/download/${q.download.id}/arrival`, { choice }); toast(ARRIVAL_CHOICE[choice].done, "success"); void reload(); } catch (e: any) { toast(e.message, "danger"); }
  };
  const items = data?.items ?? [];
  return (
    <>
      <div className="toolbar"><div className="tb-left"><ToolbarBtn icon="refresh" label="Refresh" onClick={() => void reload()} /></div></div>
      <div className="content">
        {loading && !data ? <Spinner /> : !items.length ? <Empty title="The queue is empty" icon="download">Searches, downloads and imports in progress show up here.</Empty> : (
          <table className="table">
            <thead><tr><th>Game</th><th>Release</th><th>Protocol</th><th>Size</th><th>Status</th><th style={{ width: 240 }}>Progress</th><th className="actions"></th></tr></thead>
            <tbody>{items.map(q => {
              const active = ["requested", "matching", "fetching", "processing"].includes(q.state);
              const rate = q.download?.rate ?? 0;
              return (
                <tr key={q.id}>
                  <td><div className="row"><Art className="cover-sm" src={art.poster(q.gameId)} title={q.gameName ?? ""} /><Link to={`/games/${q.gameId}`}>{q.gameName ?? `game #${q.gameId}`}</Link></div></td>
                  <td className="ellipsis" style={{ maxWidth: 380 }} title={q.release?.title ?? ""}>{q.release?.title ?? <span className="dim">—</span>}{q.release?.indexer && <div className="dim">{q.release.indexer}{q.release.group ? ` · ${q.release.group}` : ""}</div>}</td>
                  <td>{q.release ? <Label tone={protocolTone(q.release.protocol)}>{q.release.protocol}</Label> : ""}</td>
                  <td className="nowrap">{fmtSize(q.release?.size ?? q.download?.size)}</td>
                  <td><Label tone={STATE_TONE[q.state] ?? "dim"}>{STATE_LABEL[q.state] ?? q.state}</Label><div className="dim">{sentence(q.stage)}{q.message && q.state !== "ready" ? <span title={q.message}> · {q.message.slice(0, 120)}</span> : ""}</div>{q.refused?.length ? <RefusedList items={q.refused} /> : null}
                    {q.waiting?.kind === "arrival" && q.waiting.ask?.choices.length ? <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>{q.waiting.ask.choices.map(c => <Btn key={c} size="sm" kind={c === "wait" ? "default" : "primary"} onClick={() => void answer(q, c)}>{choiceLabel(q, c)}</Btn>)}</div> : null}</td>
                  <td>{active ? <Progress value={q.progress} tone="queue" text={`${Math.round(q.progress * 100)}%${rate ? ` · ${fmtRate(rate)}` : ""}`} /> : <span className="dim">{timeAgo(q.doneAt ?? q.updatedAt)}</span>}</td>
                  <td className="actions">
                    {q.waiting ? <IconBtn icon="refresh" label={q.waiting.kind === "arrival" ? (q.waiting.stopped ? "Retry: wait for it in the finished-downloads folder again (the download is kept)" : "Look for it in the finished-downloads folder now") : q.waiting.stopped ? "Retry: wait on the seedbox again (the download is kept)" : "Retry now"} onClick={() => void retry(q)} />
                      : (q.state === "failed" || q.state === "requested") && <IconBtn icon="refresh" label="Search again" onClick={() => void retry(q, q.state === "failed")} />}
                    {q.import && <Link to={`/games/${q.gameId}`} className="ibtn" title="Open"><Icon name="external" /></Link>}
                    {(active || q.waiting?.stopped) && <IconBtn icon="x" label="Remove" danger onClick={() => { setBlocklist(!!q.release); setRemoving(q); }} />}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Remove from the queue" sm foot={<><Btn onClick={() => setRemoving(null)}>Cancel</Btn><Btn kind="danger" onClick={remove}>Remove</Btn></>}>
        <p>Stop the search for <b>{removing?.gameName}</b>. The download client keeps what it already has.</p>
        {removing?.release && <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={blocklist} onChange={e => setBlocklist(e.target.checked)} /> blocklist this release so it is never grabbed again</label>}
      </Modal>
    </>
  );
}

export function HistoryPage() {
  const [page, setPage] = useState(1);
  const { data, loading, reload } = useLoad(() => get<{ items: HistoryItem[]; total: number; pageSize: number }>(`/api/v1/history?page=${page}&pageSize=50`), [page]);
  useEvents(["request", "job", "package"], () => void reload());
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <div className="toolbar"><div className="tb-left"><ToolbarBtn icon="refresh" label="Refresh" onClick={() => void reload()} /></div></div>
      <div className="content">
        {loading && !data ? <Spinner /> : !data?.items.length ? <Empty title="No history yet" icon="history" /> : (
          <>
            <table className="table">
              <thead><tr><th></th><th>Event</th><th>Game</th><th>Release</th><th>Source</th><th>Details</th><th>When</th></tr></thead>
              <tbody>{data.items.map(h => (
                <tr key={h.id}>
                  <td style={{ width: 30 }}><Icon name={EVENT_ICON[h.event] ?? "info"} size={15} /></td>
                  <td><Label tone={EVENT_TONE[h.event] ?? "default"}>{h.label}</Label></td>
                  <td>{h.gameId ? <Link to={`/games/${h.gameId}`}>{h.gameName ?? `#${h.gameId}`}</Link> : <span className="dim">{h.gameName ?? "—"}</span>}</td>
                  <td className="ellipsis" style={{ maxWidth: 340 }} title={h.release ?? ""}>{h.release ?? ""}</td>
                  <td>{h.source ?? ""}</td>
                  <td className="dim ellipsis" style={{ maxWidth: 320 }} title={h.message ?? ""}>{h.message ?? ""}</td>
                  <td className="dim nowrap">{timeAgo(h.at)}</td>
                </tr>
              ))}</tbody>
            </table>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}><Btn size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Btn><span className="dim">page {page} of {pages}</span><Btn size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</Btn></div>
          </>
        )}
      </div>
    </>
  );
}

export function BlocklistPage() {
  const { toast, confirm } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ items: BlockItem[] }>("/api/v1/blocklist"), []);
  const remove = async (b: BlockItem) => { try { await del(`/api/v1/blocklist/${b.id}`); void reload(); } catch (e: any) { toast(e.message, "danger"); } };
  const clear = async () => { if (await confirm("Clear the blocklist?", "Every blocklisted release becomes a candidate again.", { ok: "Clear" })) { await del("/api/v1/blocklist"); void reload(); } };
  return (
    <>
      <div className="toolbar"><div className="tb-left"><ToolbarBtn icon="refresh" label="Refresh" onClick={() => void reload()} /><ToolbarBtn icon="trash" label="Clear" disabled={!data?.items.length} onClick={() => void clear()} /></div></div>
      <div className="content">
        {loading && !data ? <Spinner /> : !data?.items.length ? <Empty title="The blocklist is empty" icon="ban">Releases that failed to download or import land here and are never grabbed again.</Empty> : (
          <table className="table">
            <thead><tr><th>Game</th><th>Release</th><th>Indexer</th><th>Reason</th><th>When</th><th className="actions"></th></tr></thead>
            <tbody>{data.items.map(b => <tr key={b.id}><td>{b.gameId ? <Link to={`/games/${b.gameId}`}>{b.gameName}</Link> : "—"}</td><td className="ellipsis" style={{ maxWidth: 380 }} title={b.title}>{b.title}</td><td>{b.indexer ?? ""}</td><td className="dim">{b.reason ?? ""}</td><td className="dim nowrap">{timeAgo(b.at)}</td><td className="actions"><IconBtn icon="x" label="Remove from the blocklist" danger onClick={() => void remove(b)} /></td></tr>)}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
