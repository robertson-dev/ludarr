/**
 * Uploading a game's files from this PC: the dialog that takes the pick (an archive, some files, a whole folder — dropped
 * or chosen), the game page's list of what is on its way, being taken in, or waiting for another try, and the top bar's
 * mark while anything is being sent. The sending itself is web/src/uploads.ts.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { del, fmtDate, fmtSize, get, post, sentence, upload, type GameDetail, type JobView, type Way } from "../api";
import { useEvents } from "../events";
import {
  consolesOf, continueUpload, forgetUpload, localUpload, looksLikeConsoleData, MAX_FILES, pauseUpload, shapePick, startUpload, subscribeUploads, timeLeft, uploadsBusy, uploadsNow,
  type Io, type Picked, type ServerFile, type UploadState, type UploadView,
} from "../uploads";
import { misfitMessage, platformLabel } from "../ways/logic";
import { Icon } from "./icons";
import { Btn, Callout, Modal, Progress, Row, useLoad, useUi } from "./kit";
import { JobLine } from "./job-log";

/** the server, as the sender reaches it */
export const uploadIo: Io = {
  create: (gameId, body) => post<{ item: UploadView; resumed?: boolean }>(`/api/v1/game/${gameId}/upload`, body),
  files: id => get<{ item: UploadView; files: ServerFile[] }>(`/api/v1/upload/${id}`),
  where: (id, path) => get<{ received: number; done: boolean }>(`/api/v1/upload/${id}/file?path=${encodeURIComponent(path)}`),
  piece: (id, path, size, offset, body, o) =>
    upload<{ received: number; done: boolean }>(`/api/v1/upload/${id}/file?path=${encodeURIComponent(path)}&size=${size}&offset=${offset}`, body, { method: "PUT", signal: o.signal, onProgress: sent => o.onProgress(sent) }),
  finish: id => post<{ item: UploadView; job: JobView }>(`/api/v1/upload/${id}/finish`),
  remove: id => del(`/api/v1/upload/${id}`),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("stopped")); }, { once: true });
  }),
  now: () => Date.now(),
};

/** this tab's uploads, live */
export const useUploads = (): UploadState[] => useSyncExternalStore(subscribeUploads, uploadsNow, uploadsNow);

const WAY_KINDS = new Set(["recomp", "port", "emulated"]);
const count = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;

/* ─────────── picking ─────────── */

interface Raw { path: string; size: number; file: File }
const fromList = (list: FileList | null): Raw[] => [...(list ?? [])].map(f => ({ path: f.webkitRelativePath || f.name, size: f.size, file: f }));

/** what was dropped: files as they are, folders walked to their files (their paths keep the folder's name) */
async function fromDrop(dt: DataTransfer): Promise<Raw[]> {
  // the entries are read before anything is awaited: the drop's items are gone afterwards
  const entries = [...dt.items].filter(i => i.kind === "file").map(i => i.webkitGetAsEntry?.() ?? null);
  const plain = fromList(dt.files);
  if (!entries.some(Boolean)) return plain;
  const out: Raw[] = [];
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ path: prefix + e.name, size: f.size, file: f });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${prefix}${e.name}/`);
      }
    }
  };
  for (const e of entries) if (e) await walk(e, "");
  return out;
}

/** the way an upload is for when the pick looks like its game data (or the game is on no PC at all); null: the game's copy */
function guessWay(g: GameDetail, ways: Way[], picked: Picked): number | null {
  if (!ways.length) return null;
  const pc = g.platforms.some(p => /^(pc|win|windows|linux|mac)/i.test(p) || /windows/i.test(p));
  if (!looksLikeConsoleData(picked) && (pc || !g.platforms.length)) return null;
  // the way that plays the console the files name, when they name one; among those, one that has no file yet
  const consoles = consolesOf(picked);
  const fits = ways.filter(w => !!w.content?.platform && consoles.includes(w.content.platform));
  const pool = fits.length ? fits : ways;
  return (pool.find(w => !w.file) ?? pool[0]).id;
}

/* ─────────── the dialog ─────────── */

export function UploadModal({ g, ways, open, onClose }: { g: GameDetail; ways: Way[] | null; open: boolean; onClose: () => void }) {
  const { toast } = useUi();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [wayId, setWayId] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const filesIn = useRef<HTMLInputElement>(null), folderIn = useRef<HTMLInputElement>(null);
  const list = useMemo(() => (ways ?? []).filter(w => w.content), [ways]);
  useEffect(() => { if (open) { setPicked(null); setWayId(null); setOver(false); setReading(false); } }, [open]);
  // a folder picker is an attribute React does not know
  useEffect(() => { folderIn.current?.setAttribute("webkitdirectory", ""); });

  const take = (raw: Raw[]) => {
    const p = shapePick(raw, g.name);
    if (!p.files.length) { toast("Nothing was picked: an empty folder holds no game", "warning"); return; }
    setPicked(p);
    setWayId(guessWay(g, list, p));
  };
  const drop = async (dt: DataTransfer | null) => {
    setOver(false);
    if (!dt) return;
    setReading(true);
    try { take(await fromDrop(dt)); }
    catch (err: any) { toast(`Could not read what was dropped: ${err?.message ?? err}`, "danger"); }
    finally { setReading(false); }
  };
  // while the dialog is open a drop anywhere in the window is the pick (beside the zone, the browser would open the file instead)
  const dropRef = useRef(drop);
  dropRef.current = drop;
  useEffect(() => {
    if (!open) return;
    const files = (e: globalThis.DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const onOver = (e: globalThis.DragEvent) => { if (files(e)) { e.preventDefault(); setOver(true); } };
    const onLeave = (e: globalThis.DragEvent) => { if (!e.relatedTarget) setOver(false); };
    const onDrop = (e: globalThis.DragEvent) => { if (files(e)) { e.preventDefault(); void dropRef.current(e.dataTransfer); } };
    addEventListener("dragover", onOver); addEventListener("dragleave", onLeave); addEventListener("drop", onDrop);
    return () => { removeEventListener("dragover", onOver); removeEventListener("dragleave", onLeave); removeEventListener("drop", onDrop); };
  }, [open]);

  const copyKind = g.file?.kind ?? (g.file ? "native" : null);
  const overWay = wayId == null && !!copyKind && WAY_KINDS.has(copyKind);
  const searching = !!g.request && ["requested", "matching", "fetching", "processing"].includes(g.request.state);
  const tooMany = !!picked && picked.files.length > MAX_FILES;
  const empty = !!picked && picked.bytes === 0;
  const go = () => {
    if (!picked) return;
    startUpload(uploadIo, { id: g.id, name: g.name }, picked, { wayId, replace: overWay });
    toast(<>Uploading <b>{picked.name}</b>: it goes on while this tab stays open</>, "info");
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={<>Upload — {g.name}</>}
      foot={<>
        {picked && <span className="left"><Btn kind="ghost" onClick={() => setPicked(null)}>Choose something else</Btn></span>}
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon="upload" disabled={!picked || tooMany || empty} onClick={go}>{picked ? `Upload ${fmtSize(picked.bytes)}` : "Upload"}</Btn>
      </>}>
      {!picked ? (
        <>
          <div className={`dropzone${over ? " over" : ""}`}>
            <Icon name={reading ? "spinner" : "upload"} size={30} className="muted" />
            <b>{reading ? "Reading what was dropped…" : "Drop the game here"}</b>
            <span className="dim">One archive (zip, 7z, rar), an installer with its files, or the game's whole folder.</span>
            <div className="picks">
              <Btn icon="upload" onClick={() => filesIn.current?.click()}>Choose files</Btn>
              <Btn icon="folder" onClick={() => folderIn.current?.click()}>Choose a folder</Btn>
            </div>
          </div>
          <input ref={filesIn} type="file" multiple hidden onChange={e => { const raw = fromList(e.target.files); e.target.value = ""; if (raw.length) take(raw); }} />
          <input ref={folderIn} type="file" multiple hidden onChange={e => { const raw = fromList(e.target.files); e.target.value = ""; if (raw.length) take(raw); }} />
          <p className="dim" style={{ marginTop: 12 }}>
            ludarr unpacks or installs it, checks it and puts it in the library{list.length ? ", or keeps it as the game file of a way to play" : ""}. An upload that breaks off goes on where it stopped when you pick the same files again.
          </p>
        </>
      ) : (
        <>
          <Row label="Upload" help={list.length ? undefined : "It is unpacked or installed on the server, checked, and becomes the copy players install."}>
            <div className="up-picked"><Icon name={picked.files.length === 1 ? "box" : "folder"} size={15} /><b className="ellipsis" title={picked.name}>{picked.name}</b><span className="dim nowrap">{count(picked.files.length, "file")} · {fmtSize(picked.bytes)}</span></div>
          </Row>
          {list.length > 0 && (
            <Row label="It is">
              <label className="check"><input type="radio" name="upload-for" checked={wayId == null} onChange={() => setWayId(null)} /> the PC game: ludarr unpacks or installs it</label>
              {list.map(w => (
                <label key={w.id} className="check"><input type="radio" name="upload-for" checked={wayId === w.id} onChange={() => setWayId(w.id)} /> the game file for {w.plan?.name ?? w.planName ?? "a way to play"}{w.content?.platform ? ` (${platformLabel(w.content.platform)})` : ""}{w.file ? ", in place of the one it has" : ""}</label>
              ))}
            </Row>
          )}
          {tooMany && <Callout tone="danger">That is {picked.files.length.toLocaleString()} files, more than one upload holds ({MAX_FILES.toLocaleString()}): zip the folder and upload the archive.</Callout>}
          {empty && <Callout tone="danger">Every file in it is empty.</Callout>}
          {overWay && <Callout tone="warning">{g.name} plays through a way to play that ludarr built. This upload takes its place once it is imported.</Callout>}
          {wayId == null && g.file && !overWay && <Callout>The copy on the server{g.file.size ? ` (${fmtSize(g.file.size)})` : ""} is replaced once this one is imported.</Callout>}
          {wayId == null && searching && <Callout>The search under way for {g.name} stops once this is imported.</Callout>}
        </>
      )}
    </Modal>
  );
}

/** files dragged over the page (and no dialog open): `open` is called, and the upload dialog takes the drop */
export function useFileDragOpens(open: () => void) {
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    const onEnter = (e: globalThis.DragEvent) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files") || document.querySelector(".overlay")) return;
      ref.current();
    };
    addEventListener("dragenter", onEnter);
    return () => removeEventListener("dragenter", onEnter);
  }, []);
}

/* ─────────── the game page's list ─────────── */

/** one upload being sent from this tab */
function Sending({ l, onRemove }: { l: UploadState; onRemove: () => void }) {
  const active = l.phase === "starting" || l.phase === "sending" || l.phase === "finishing";
  const left = timeLeft(l.bytes, l.sent, l.rate);
  const text = l.phase === "starting" ? "Starting…"
    : l.phase === "finishing" ? "Every byte is there: handing it over…"
    : l.phase === "paused" ? `Paused · ${fmtSize(l.sent)} of ${fmtSize(l.bytes)}`
    : l.phase === "failed" ? `Stopped · ${fmtSize(l.sent)} of ${fmtSize(l.bytes)}`
    : l.waiting ? `${fmtSize(l.sent)} of ${fmtSize(l.bytes)} · waiting for the server`
    : `${fmtSize(l.sent)} of ${fmtSize(l.bytes)}${l.rate > 0 ? ` · ${fmtSize(l.rate)}/s` : ""}${left ? ` · ${left}` : ""}`;
  return (
    <div className="up-row">
      <div className="up-head"><Icon name="upload" size={15} /><b className="ellipsis" title={l.name}>{l.name}</b><span className="dim nowrap">{count(l.files, "file")}</span></div>
      <div className="up-main">
        <Progress value={l.bytes ? l.sent / l.bytes : 0} tone={active ? "accent" : "warning"} text={text} />
        <div className="up-note dim ellipsis">
          {l.phase === "failed" ? <span className="err">{l.error}</span>
            : l.waiting ? "The server does not answer: sending goes on by itself once it does"
            : l.phase === "sending" && l.current ? `${l.current}${l.more ? ` and ${l.more} more` : ""}`
            : l.phase === "paused" ? "What arrived stays on the server" : " "}
        </div>
      </div>
      <div className="up-acts">
        {(l.phase === "starting" || l.phase === "sending") && <Btn size="sm" onClick={() => pauseUpload(l.key)}>Pause</Btn>}
        {(l.phase === "paused" || l.phase === "failed") && <Btn size="sm" kind="primary" onClick={() => continueUpload(l.key)}>Continue</Btn>}
        <Btn size="sm" kind="ghost" icon="trash" onClick={onRemove}>Remove</Btn>
      </div>
    </div>
  );
}

/** why an upload was not taken in, in one line: a file that is not its way's says so itself ("kept X — not the file Y needs: …") */
function whyNot(u: UploadView): string {
  const m = u.message ?? "its job failed";
  if (u.wayId == null) return `Not imported: ${m}`;
  const misfit = misfitMessage(m) ? /(not the file\b.+)$/i.exec(m)?.[1] : null;
  return misfit ? sentence(misfit) : `Not taken in: ${m}`;
}

/** the choices an upload that was not taken in can be tried again with: as it was, the game's copy, or a way's game file */
function AgainAs({ u, ways, value, onChange }: { u: UploadView; ways: Way[]; value: number | null; onChange: (wayId: number | null) => void }) {
  if (!ways.length && u.wayId == null) return null;
  return (
    <select className="select sm" value={value ?? ""} aria-label="Take it in as" onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))}>
      <option value="">as the PC game</option>
      {ways.map(w => <option key={w.id} value={w.id}>as the game file for {w.plan?.name ?? w.planName ?? `way ${w.id}`}</option>)}
    </select>
  );
}

/**
 * The game's uploads: what this tab is sending, what waits on the server unfinished (pick the same files again to go on),
 * what is being taken in, and what was not taken in (try again, the other way too, or remove). Nothing when there is none.
 */
export function GameUploads({ g, ways, onLog, onPick }: { g: GameDetail; ways: Way[] | null; onLog: (jobId: number) => void; onPick: () => void }) {
  const { toast, confirm } = useUi();
  const all = useUploads();
  const { data, reload } = useLoad(() => get<{ items: UploadView[] }>(`/api/v1/upload?gameId=${g.id}`), [g.id]);
  useEvents(["upload", "job"], () => void reload(), [g.id]);
  const mine = all.filter(u => u.gameId === g.id);
  // a piece that arrived, an upload handed over: the server's list follows what this tab did
  const handed = mine.map(u => `${u.uploadId}:${u.phase}`).join(",");
  useEffect(() => { void reload(); }, [handed, reload]);
  const [againAs, setAgainAs] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const list = (ways ?? []).filter(w => w.content);
  /** what "Try again" takes an upload in as: what was chosen here, else what it was for — the PC game when that way is gone */
  const asOf = (u: UploadView): number | null => {
    const as = u.id in againAs ? againAs[u.id] : u.wayId;
    return as != null && list.some(w => w.id === as) ? as : null;
  };
  const server = data?.items ?? [];
  const starting = mine.filter(l => l.uploadId == null || !server.some(u => u.id === l.uploadId));
  if (!server.length && !starting.length) return null;

  const remove = async (name: string, id: number | null, key: number | null, importing = false) => {
    if (!(await confirm(`Remove the upload ${name}?`, importing ? <>Taking it in is stopped, and its files are deleted from the server. The game keeps what it has.</> : <>What was sent of it is deleted from the server.</>, { ok: "Remove" }))) return;
    if (key != null) forgetUpload(key);
    try { if (id != null) await del(`/api/v1/upload/${id}`); } catch (e: any) { toast(e.message, "danger"); }
    void reload();
  };
  const again = async (u: UploadView) => {
    const as = asOf(u);
    setBusy(u.id);
    try { await post(`/api/v1/upload/${u.id}/retry`, { wayId: as, replace: as == null && !!g.file?.kind && WAY_KINDS.has(g.file.kind) ? true : undefined }); }
    catch (e: any) { toast(e.message, "danger"); }
    finally { setBusy(null); void reload(); }
  };

  return (
    <div className="uploads">
      {starting.map(l => <Sending key={`l${l.key}`} l={l} onRemove={() => void remove(l.name, l.uploadId, l.key)} />)}
      {server.map(u => {
        const l = localUpload(mine, u.id);
        if (l && u.state === "uploading") return <Sending key={u.id} l={l} onRemove={() => void remove(u.name, u.id, l.key)} />;
        return (
          <div className={`up-row${u.state === "failed" ? " failed" : ""}`} key={u.id}>
            <div className="up-head"><Icon name={u.state === "failed" ? "alert" : "upload"} size={15} /><b className="ellipsis" title={u.name}>{u.name}</b><span className="dim nowrap">{count(u.files, "file")} · {fmtSize(u.bytes)}</span></div>
            <div className="up-main">
              {u.state === "uploading" && <>
                <Progress value={u.bytes ? u.received / u.bytes : 0} tone="warning" text={`Not finished · ${fmtSize(u.received)} of ${fmtSize(u.bytes)} is on the server`} />
                <div className="up-note dim">Pick the same {u.files === 1 ? "file" : "files"} again and it goes on from there{u.expiresAt ? ` · kept until ${fmtDate(u.expiresAt)}` : ""}</div>
              </>}
              {u.state === "importing" && (u.jobId != null ? <JobLine id={u.jobId} /> : <span className="dim">Waiting for its job…</span>)}
              {u.state === "removing" && <span className="dim"><Icon name="spinner" size={12} /> Removing it…</span>}
              {u.state === "failed" && <>
                <div className="err">{whyNot(u)}</div>
                <div className="up-note dim">The files are still on the server{u.expiresAt ? ` until ${fmtDate(u.expiresAt)}` : ""}</div>
              </>}
            </div>
            <div className="up-acts">
              {u.state === "uploading" && <Btn size="sm" kind="primary" icon="upload" onClick={onPick}>Continue…</Btn>}
              {u.state === "importing" && u.jobId != null && <Btn size="sm" icon="terminal" onClick={() => onLog(u.jobId!)}>Log</Btn>}
              {u.state === "failed" && <>
                <AgainAs u={u} ways={list} value={asOf(u)} onChange={v => setAgainAs(s => ({ ...s, [u.id]: v }))} />
                <Btn size="sm" kind="primary" icon="refresh" busy={busy === u.id} onClick={() => void again(u)}>Try again</Btn>
                {u.jobId != null && <Btn size="sm" icon="terminal" onClick={() => onLog(u.jobId!)}>Log</Btn>}
              </>}
              {u.state !== "removing" && <Btn size="sm" kind="ghost" icon="trash" onClick={() => void remove(u.name, u.id, l?.key ?? null, u.state === "importing")}>Remove</Btn>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────── the top bar ─────────── */

/** shown while this tab is sending anything: how far it is, and a click to its game; the browser warns before the tab closes */
export function UploadsBadge() {
  const all = useUploads();
  const nav = useNavigate();
  const busy = all.some(u => u.phase === "starting" || u.phase === "sending" || u.phase === "finishing");
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => { if (uploadsBusy()) { e.preventDefault(); e.returnValue = ""; } };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [busy]);
  if (!all.length) return null;
  const bytes = all.reduce((n, u) => n + u.bytes, 0), sent = all.reduce((n, u) => n + u.sent, 0);
  const stopped = !busy;
  const u = all[0];
  return (
    <button className={`up-badge${stopped ? " stopped" : ""}`} title={`${stopped ? "Upload paused" : "Uploading"}: ${all.map(x => `${x.name} (${x.gameName})`).join(", ")}`} aria-label="Uploads" onClick={() => nav(`/games/${u.gameId}`)}>
      <Icon name="upload" size={16} /><span>{bytes ? Math.floor((sent / bytes) * 100) : 0}%</span>
    </button>
  );
}
