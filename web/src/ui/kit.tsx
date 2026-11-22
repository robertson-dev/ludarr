/** ludarr web — small building blocks: buttons, labels, modals, toasts, confirm, toggles, progress, empty states. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/* ─────────── buttons ─────────── */

export type Kind = "default" | "primary" | "accent" | "success" | "danger" | "warning" | "ghost" | "outline";
export function Btn({ kind = "default", size, icon, busy, children, className, ...rest }: { kind?: Kind; size?: "sm" | "lg"; icon?: IconName; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn ${kind === "default" ? "" : kind}${size ? " " + size : ""}${className ? " " + className : ""}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <Icon name="spinner" size={14} /> : icon ? <Icon name={icon} size={14} /> : null}{children}
    </button>
  );
}
export function IconBtn({ icon, label, danger, size = 16, ...rest }: { icon: IconName; label: string; danger?: boolean; size?: number } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`ibtn${danger ? " danger" : ""}`} title={label} aria-label={label} {...rest}><Icon name={icon} size={size} /></button>;
}
export function ToolbarBtn({ icon, label, busy, className, ...rest }: { icon: IconName; label: string; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`tbtn${className ? " " + className : ""}`} {...rest} disabled={busy || rest.disabled}><Icon name={busy ? "spinner" : icon} />{label}</button>;
}
export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? " on" : ""}`} disabled={disabled} onClick={e => { e.stopPropagation(); onChange(!on); }} />;
}

/* ─────────── labels ─────────── */

export type Tone = "default" | "primary" | "success" | "danger" | "warning" | "queue" | "accent" | "info" | "torrent" | "usenet" | "dim" | "outline";
export function Label({ tone = "default", icon, children, title }: { tone?: Tone; icon?: IconName; children: ReactNode; title?: string }) {
  return <span className={`label${tone === "default" ? "" : " " + tone}`} title={title}>{icon && <Icon name={icon} size={11} />}{children}</span>;
}

export function Progress({ value, tone, text }: { value: number; tone?: "queue" | "accent" | "warning"; text?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return <div className={`progress${tone ? " " + tone : ""}`}><i style={{ width: `${pct}%` }} /><span>{text ?? `${pct}%`}</span></div>;
}

export function Empty({ title, children, icon = "info" }: { title: string; children?: ReactNode; icon?: IconName }) {
  return <div className="empty"><Icon name={icon} size={36} className="muted" /><h3>{title}</h3>{children}</div>;
}
export function Spinner({ text }: { text?: string }) { return <div className="empty"><Icon name="spinner" size={28} /> {text && <div style={{ marginTop: 8 }}>{text}</div>}</div>; }

/* ─────────── modal ─────────── */

export function Modal({ open, onClose, title, children, foot, wide, sm }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; foot?: ReactNode; wide?: boolean; sm?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    addEventListener("keydown", on, true);
    return () => removeEventListener("keydown", on, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? " wide" : ""}${sm ? " sm" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head"><span>{title}</span><IconBtn icon="x" label="Close" onClick={onClose} /></div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

/* ─────────── toasts + confirm (app-wide) ─────────── */

interface Toast { id: number; text: ReactNode; tone: "info" | "success" | "danger" | "warning" }
interface ConfirmReq { title: string; body: ReactNode; ok?: string; kind?: Kind; resolve: (v: boolean) => void }
interface UiCtx { toast: (text: ReactNode, tone?: Toast["tone"]) => void; confirm: (title: string, body: ReactNode, opt?: { ok?: string; kind?: Kind }) => Promise<boolean> }
const Ctx = createContext<UiCtx>({ toast: () => {}, confirm: async () => false });
export const useUi = () => useContext(Ctx);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const seq = useRef(0);
  // the toasts' timers go with the provider: nothing is set on it once it is gone
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => { const all = timers.current; return () => { for (const t of all) clearTimeout(t); all.clear(); }; }, []);
  const toast = useCallback((text: ReactNode, tone: Toast["tone"] = "info") => {
    const id = ++seq.current;
    setToasts(t => [...t, { id, text, tone }]);
    const t = setTimeout(() => { timers.current.delete(t); setToasts(list => list.filter(x => x.id !== id)); }, tone === "danger" ? 8000 : 4000);
    timers.current.add(t);
  }, []);
  const confirm = useCallback((title: string, body: ReactNode, opt: { ok?: string; kind?: Kind } = {}) => new Promise<boolean>(resolve => setConfirmReq({ title, body, ok: opt.ok, kind: opt.kind, resolve })), []);
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);
  const answer = (v: boolean) => { confirmReq?.resolve(v); setConfirmReq(null); };
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
      <Modal open={!!confirmReq} onClose={() => answer(false)} title={confirmReq?.title ?? ""} sm
        foot={<><Btn onClick={() => answer(false)}>Cancel</Btn><Btn kind={confirmReq?.kind ?? "danger"} onClick={() => answer(true)} autoFocus>{confirmReq?.ok ?? "Delete"}</Btn></>}>
        {confirmReq?.body}
      </Modal>
    </Ctx.Provider>
  );
}

/** a fetch that re-runs on demand and shows errors through toasts; an answer that comes after the page is gone is dropped */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], opt: { quiet?: boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const gen = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async () => {
    const g = ++gen.current;
    const mine = () => g === gen.current && alive.current;
    try { const d = await fn(); if (mine()) { setData(d); setError(null); } }
    catch (e: any) { if (mine()) setError(String(e?.message ?? e)); }
    finally { if (mine()) setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { setLoading(true); void reload(); }, [reload]);
  void opt;
  return { data, error, loading, reload, setData };
}

export function Tabs({ items, value, onChange }: { items: { id: string; label: ReactNode }[]; value: string; onChange: (id: string) => void }) {
  return <div className="tabs">{items.map(t => <button key={t.id} className={t.id === value ? "on" : ""} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}

export function Section({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return <div className="form-section"><h3>{title}<span className="grow" />{right}</h3>{children}</div>;
}

/** a part that opens on demand (a tool's output, a long log); `right` sits on the same line as the toggle */
export function Fold({ label, children, open: initial = false, right }: { label: ReactNode; children: ReactNode; open?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="fold">
      <div className="fold-line"><button type="button" className="fold-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name={open ? "chevronDown" : "chevronRight"} size={13} />{label}</button>{right}</div>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

/** a ref for a notice that appears after a button press: it is brought into view when `show` turns truthy */
export function useReveal<T extends HTMLElement = HTMLDivElement>(show: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => { if (show) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [show]);
  return ref;
}

/**
 * Text onto the clipboard. The clipboard API exists only on a secure page (https, or localhost), and the admin page is
 * often plain http on the LAN: there a hidden field's text is copied the older way.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof window !== "undefined" && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* the older way below */ }
  try {
    const t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.top = "0"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch { return false; }
}
/** a button that copies `text` and says whether it could */
export function CopyButton({ text, label = "Copy", what = "the path" }: { text: string; label?: string; what?: string }) {
  const { toast } = useUi();
  return <Btn size="sm" kind="outline" icon="copy" onClick={async () => { const ok = await copyText(text); toast(ok ? "Copied" : `Could not copy: select ${what} and copy it`, ok ? "success" : "warning"); }}>{label}</Btn>;
}

/** an inline notice inside a page or a modal (a duplicate found, a job's failure, what is missing) */
export function Callout({ tone = "info", icon, children }: { tone?: "info" | "success" | "warning" | "danger"; icon?: IconName; children: ReactNode }) {
  return <div className={`callout ${tone}`}><Icon name={icon ?? (tone === "success" ? "check" : tone === "info" ? "info" : "alert")} size={15} /><div className="grow">{children}</div></div>;
}

export function Row({ label, help, children, error, src }: { label: ReactNode; help?: ReactNode; children: ReactNode; error?: string | null; src?: string }) {
  return (
    <div className="form-row">
      <label>{label}</label>
      <div className="field">{children}{help && <div className="help">{help}</div>}{src && <div className="src">{src}</div>}{error && <div className="err">{error}</div>}</div>
    </div>
  );
}
