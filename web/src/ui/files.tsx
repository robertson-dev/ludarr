/** Taking a file in: an upload with its progress, or a file already on the server (a content job, followed live). */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtSize, upload, type JobView } from "../api";
import { Icon } from "./icons";
import { Btn, Modal, Progress, Row } from "./kit";
import { JobLine } from "./job-log";

/**
 * A button that sends one picked file as the raw body to `to(file)` and shows how far it got; Cancel stops it.
 * `onDone` gets the server's answer, `onError` its refusal (too large, no room, not the file a need asks for …).
 */
export function UploadButton<T>({ label = "Upload a file", accept, to, onDone, onError, kind, size = "sm" }: {
  label?: string; accept?: string; to: (file: File) => string; onDone: (r: T, file: File) => void; onError?: (message: string) => void;
  kind?: "default" | "primary" | "outline"; size?: "sm" | "lg";
}) {
  const [state, setState] = useState<{ file: File; sent: number; total: number } | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const start = async (file: File) => {
    const ac = new AbortController();
    ctl.current = ac;
    setState({ file, sent: 0, total: file.size });
    try {
      const r = await upload<T>(to(file), file, { signal: ac.signal, onProgress: (sent, total) => setState({ file, sent, total }) });
      onDone(r, file);
    } catch (e: any) {
      if (!ac.signal.aborted) onError?.(String(e?.message ?? e));
    } finally {
      if (ctl.current === ac) ctl.current = null;
      setState(null);
    }
  };
  if (state) {
    const done = state.total > 0 && state.sent >= state.total;
    return (
      <div className="uploading">
        <Progress value={state.total ? state.sent / state.total : 0} tone="accent"
          text={done ? `Checking ${state.file.name}…` : `Uploading ${state.file.name} · ${fmtSize(state.sent)} of ${fmtSize(state.total)}`} />
        <Btn size="sm" kind="ghost" icon="x" onClick={() => ctl.current?.abort()}>Cancel</Btn>
      </div>
    );
  }
  return (
    <>
      <Btn size={size} kind={kind} icon="upload" onClick={() => input.current?.click()}>{label}</Btn>
      <input ref={input} type="file" accept={accept} hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void start(f); }} />
    </>
  );
}

/**
 * "Use a file on the server": a path the server takes in as a job (it is never moved: a hard link on the library's volume,
 * a copy otherwise), then that job's progress until it ends. `start` posts the path and returns the job; `help` and
 * `placeholder` say what the path may be when it is
 * more than one file (a game folder a run asks for).
 */
export function ServerPathModal({ open, onClose, title, intro, start, onDone, help, placeholder }: {
  open: boolean; onClose: () => void; title: ReactNode; intro?: ReactNode;
  start: (path: string) => Promise<{ job: JobView }>; onDone: (job: JobView) => void;
  help?: ReactNode; placeholder?: string;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => { if (open) { setPath(""); setError(null); setJobId(null); setEnded(false); } }, [open]);
  const go = async () => {
    if (!path.trim()) return;
    setBusy(true); setError(null);
    try { const r = await start(path.trim()); setJobId(r.job.id); }
    catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };
  const running = jobId != null && !ended;
  return (
    <Modal open={open} onClose={onClose} title={title}
      foot={<><Btn onClick={onClose}>{jobId != null ? "Close" : "Cancel"}</Btn>{jobId == null && <Btn kind="primary" icon="folder" busy={busy} disabled={!path.trim()} onClick={() => void go()}>Take it in</Btn>}</>}>
      {intro && <p className="dim" style={{ marginBottom: 8 }}>{intro}</p>}
      <Row label="Path" help={help ?? "A file in the downloads folder, a root folder or a download client's mapped folder. It stays where it is."} error={error}>
        <input className="input mono-in" value={path} placeholder={placeholder ?? "/downloads/Some Game (USA).z64"} disabled={jobId != null} autoFocus aria-label="Path on the server"
          onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void go(); }} />
      </Row>
      {jobId != null && (
        <Row label={running ? "Taking it in" : "Result"}>
          <JobLine id={jobId} onDone={j => { setEnded(true); onDone(j); }} />
        </Row>
      )}
      {running && <p className="dim"><Icon name="info" size={13} /> Closing this keeps it going; it shows under Activity → Builds.</p>}
    </Modal>
  );
}
