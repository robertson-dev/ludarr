/** System: status + health, scheduled tasks, backups, live logs. */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { del, get, post, fmtDate, fmtDur, fmtSize, timeAgo, type HealthItem, type LogLine, type SystemStatus, type TaskView } from "../api";
import { subscribe, useEvents } from "../events";
import { Icon } from "../ui/icons";
import { Btn, Empty, IconBtn, Label, Section, Spinner, ToolbarBtn, useLoad, useUi } from "../ui/kit";

export function StatusPage() {
  const { data, loading } = useLoad(() => Promise.all([get<SystemStatus>("/api/v1/system/status"), get<{ items: HealthItem[] }>("/api/v1/health")]), []);
  const [s, h] = data ?? [null, null];
  if (loading && !data) return <div className="content"><Spinner /></div>;
  return (
    <div className="content narrow">
      <h2 className="page-title">Status</h2>
      <Section title="Health">
        {!h?.items.length ? <p className="row"><Icon name="check" style={{ color: "var(--success)" }} /> No issues with your configuration.</p> : (
          <div className="health-list">{h.items.map((i, k) => <div key={k} className="item"><Icon name={i.type === "notice" ? "info" : "alert"} style={{ color: i.type === "error" ? "var(--danger)" : i.type === "warning" ? "var(--warning)" : "var(--primary)" }} /><span className="grow">{i.message}</span>{i.link && <Link to={i.link}>Fix</Link>}</div>)}</div>
        )}
      </Section>
      <Section title="About">
        <dl className="kv">
          <dt>Version</dt><dd>ludarr {s?.version}</dd>
          <dt>Runtime</dt><dd>{s?.runtime} · {s?.os} {s?.arch}{s?.docker ? " · Docker" : ""}</dd>
          <dt>Started</dt><dd>{s ? `${fmtDate(Date.parse(s.startTime), true)} (up ${fmtDur((s.uptime ?? 0) * 1000)})` : ""}</dd>
          <dt>Config folder</dt><dd className="mono">{s?.paths.config}</dd>
          <dt>Downloads folder</dt><dd className="mono">{s?.paths.downloads}</dd>
          <dt>Root folders</dt><dd className="mono">{s?.paths.rootFolders.join(", ") || "none"}</dd>
        </dl>
      </Section>
      <Section title="Library">
        <dl className="kv">
          <dt>Games</dt><dd>{s?.counts.games} ({s?.counts.imported} imported, {s?.counts.missing} missing)</dd>
          <dt>In progress</dt><dd>{s?.counts.queue} searches · {s?.counts.imports} imports · {s?.counts.transfers} transfers</dd>
          <dt>Catalog</dt><dd>{s?.counts.catalogTitles?.toLocaleString()} titles</dd>
        </dl>
      </Section>
    </div>
  );
}

export function TasksPage() {
  const { toast } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ items: TaskView[] }>("/api/v1/system/task"), []);
  const [running, setRunning] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => void reload(), 5000); return () => clearInterval(t); }, [reload]);
  const run = async (t: TaskView) => {
    setRunning(t.name);
    try { const r = await post<{ ok: boolean; ms: number; error?: string }>(`/api/v1/system/task/${t.name}`); toast(r.ok ? `${t.label} finished in ${fmtDur(r.ms)}` : `${t.label}: ${r.error}`, r.ok ? "success" : "danger"); }
    catch (e: any) { toast(e.message, "danger"); } finally { setRunning(null); void reload(); }
  };
  const every = (s: number) => s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86_400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86_400)} d`;
  return (
    <>
      <div className="toolbar"><div className="tb-left"><ToolbarBtn icon="refresh" label="Refresh" onClick={() => void reload()} /></div></div>
      <div className="content">
        <h2 className="page-title">Scheduled Tasks</h2>
        {loading && !data ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Task</th><th>Interval</th><th>Last run</th><th>Duration</th><th>Next run</th><th>Result</th><th className="actions"></th></tr></thead>
            <tbody>{data?.items.map(t => (
              <tr key={t.name}>
                <td>{t.label}<div className="dim mono">{t.name}</div></td>
                <td className="nowrap">{every(t.intervalSec)}</td>
                <td className="nowrap dim">{t.lastRun ? timeAgo(t.lastRun, true) : "never"}</td>
                <td className="nowrap">{fmtDur(t.lastDuration)}</td>
                <td className="nowrap dim">{t.running ? <Label tone="queue">running</Label> : t.nextRun - Date.now() < 2000 ? "now" : `in ${every(Math.round((t.nextRun - Date.now()) / 1000))}`}</td>
                <td>{t.lastError ? <span className="test-result bad" title={t.lastError}><Icon name="alert" size={12} /> {t.lastError.slice(0, 80)}</span> : t.runs ? <span className="test-result ok"><Icon name="check" size={12} /> ok</span> : ""}</td>
                <td className="actions"><IconBtn icon={running === t.name || t.running ? "spinner" : "play"} label="Run now" disabled={running === t.name || t.running} onClick={() => void run(t)} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function BackupPage() {
  const { toast, confirm } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ items: { name: string; size: number; at: number }[]; folder: string }>("/api/v1/system/backup"), []);
  const [busy, setBusy] = useState(false);
  const make = async () => { setBusy(true); try { const r = await post<{ name: string }>("/api/v1/system/backup"); toast(`Backup written: ${r.name}`, "success"); void reload(); } catch (e: any) { toast(e.message, "danger"); } finally { setBusy(false); } };
  const remove = async (name: string) => { if (await confirm("Delete backup?", name)) { try { await del(`/api/v1/system/backup/${name}`); void reload(); } catch (e: any) { toast(e.message, "danger"); } } };
  return (
    <>
      <div className="toolbar"><div className="tb-left"><ToolbarBtn icon="save" label="Backup Now" busy={busy} onClick={make} /><ToolbarBtn icon="refresh" label="Refresh" onClick={() => void reload()} /></div></div>
      <div className="content narrow">
        <h2 className="page-title">Backups</h2>
        <p className="dim" style={{ marginBottom: 12 }}>A copy of the database is written every day to <code>{data?.folder}</code>; the last seven are kept. To restore, stop ludarr and copy one over <code>ludarr.db</code>.</p>
        {loading && !data ? <Spinner /> : !data?.items.length ? <Empty title="No backups yet" icon="save" /> : (
          <table className="table"><thead><tr><th>Name</th><th>Size</th><th>Written</th><th className="actions"></th></tr></thead>
            <tbody>{data.items.map(b => <tr key={b.name}><td className="mono">{b.name}</td><td>{fmtSize(b.size)}</td><td className="dim">{fmtDate(b.at)}</td><td className="actions"><IconBtn icon="trash" label="Delete" danger onClick={() => void remove(b.name)} /></td></tr>)}</tbody></table>
        )}
      </div>
    </>
  );
}

export function LogsPage() {
  const [level, setLevel] = useState("info");
  const [filter, setFilter] = useState("");
  const [live, setLive] = useState(true);
  const [lines, setLines] = useState<LogLine[]>([]);
  const { data, loading, reload } = useLoad(() => get<{ items: LogLine[] }>(`/api/v1/log?level=${level}&limit=300${filter ? `&logger=${encodeURIComponent(filter)}` : ""}`), [level, filter]);
  useEffect(() => { if (data) setLines(data.items); }, [data]);
  const liveRef = useRef(live); liveRef.current = live;
  useEffect(() => subscribe((ev, d) => {
    if (ev !== "log" || !liveRef.current) return;
    const l = d as LogLine;
    const order = ["debug", "info", "warn", "error"];
    if (order.indexOf(l.level) < order.indexOf(level)) return;
    if (filter && !l.logger.toLowerCase().includes(filter.toLowerCase())) return;
    setLines(ls => [l, ...ls].slice(0, 500));
  }), [level, filter]);
  useEvents([], () => {});
  return (
    <>
      <div className="toolbar"><div className="tb-left"><ToolbarBtn icon="refresh" label="Refresh" onClick={() => void reload()} /><ToolbarBtn icon={live ? "activity" : "play"} label={live ? "Live" : "Paused"} className={live ? "on" : ""} onClick={() => setLive(v => !v)} /></div></div>
      <div className="content">
        <div className="filterbar">
          <select className="select" value={level} onChange={e => setLevel(e.target.value)} aria-label="Level">{["debug", "info", "warn", "error"].map(l => <option key={l} value={l}>{l} and up</option>)}</select>
          <input className="input" placeholder="Filter by logger (Search, Download, Import, Plugin:…)" value={filter} onChange={e => setFilter(e.target.value)} style={{ maxWidth: 360 }} />
          <span className="dim">{lines.length} lines</span>
        </div>
        {loading && !data ? <Spinner /> : !lines.length ? <Empty title="No log lines" icon="terminal" /> : (
          <table className="table compact logs">
            <thead><tr><th style={{ width: 140 }}>Time</th><th style={{ width: 70 }}>Level</th><th style={{ width: 150 }}>Logger</th><th>Message</th></tr></thead>
            <tbody>{lines.map(l => <tr key={`${l.id}-${l.at}`}><td className="dim">{new Date(l.at).toLocaleTimeString()}</td><td><span className={`lvl ${l.level}`}>{l.level}</span></td><td className="dim">{l.logger}</td><td>{l.message}</td></tr>)}</tbody>
          </table>
        )}
        {!lines.length && !loading && <p className="dim"><Btn size="sm" onClick={() => void reload()}>Reload</Btn></p>}
      </div>
    </>
  );
}
