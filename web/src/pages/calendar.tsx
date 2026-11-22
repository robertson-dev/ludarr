/** Calendar: release dates of library games, as a month grid and an agenda. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { get, type Game } from "../api";
import { useEvents } from "../events";
import { Icon } from "../ui/icons";
import { Empty, Label, Spinner, ToolbarBtn, useLoad } from "../ui/kit";
import { statusLabel, statusTone } from "../ui/status";
import { Art, art } from "../ui/art";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarPage() {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); });
  const [view, setView] = useState<"month" | "agenda">("month");
  const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  const gridStart = new Date(first); gridStart.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const gridEnd = new Date(last); gridEnd.setUTCDate(last.getUTCDate() + (6 - ((last.getUTCDay() + 6) % 7)));
  const agendaEnd = new Date(first); agendaEnd.setUTCDate(first.getUTCDate() + 90);
  const start = iso(view === "month" ? gridStart : first), end = iso(view === "month" ? gridEnd : agendaEnd);
  const { data, loading, reload } = useLoad(() => get<{ items: Game[] }>(`/api/v1/calendar?start=${start}&end=${end}`), [start, end]);
  useEvents(["game", "follow", "package"], () => void reload());
  const byDay = new Map<string, Game[]>();
  for (const g of data?.items ?? []) if (g.releaseIso) byDay.set(g.releaseIso, [...(byDay.get(g.releaseIso) ?? []), g]);
  const days: Date[] = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setUTCDate(d.getUTCDate() + 1)) days.push(new Date(d));
  const today = iso(new Date());
  const shift = (n: number) => setMonth(m => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + n, 1)));
  const title = first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <>
      <div className="toolbar">
        <div className="tb-left">
          <ToolbarBtn icon="chevronLeft" label="Previous" onClick={() => shift(-1)} />
          <ToolbarBtn icon="calendar" label="Today" onClick={() => { const d = new Date(); setMonth(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); }} />
          <ToolbarBtn icon="chevronRight" label="Next" onClick={() => shift(1)} />
        </div>
        <div className="tb-right">
          <ToolbarBtn icon="grid" label="Month" className={view === "month" ? "on" : ""} onClick={() => setView("month")} />
          <ToolbarBtn icon="list" label="Agenda" className={view === "agenda" ? "on" : ""} onClick={() => setView("agenda")} />
        </div>
      </div>
      <div className="content">
        <h2 className="page-title">{title}</h2>
        {loading && !data ? <Spinner /> : view === "month" ? (
          <div className="cal">
            {DOW.map(d => <div key={d} className="dow">{d}</div>)}
            {days.map(d => { const k = iso(d); const other = d.getUTCMonth() !== first.getUTCMonth(); return (
              <div key={k} className={`day${other ? " other" : ""}${k === today ? " today" : ""}`}>
                <div className="n">{d.getUTCDate()}</div>
                {(byDay.get(k) ?? []).map(g => <Link key={g.id} to={`/games/${g.id}`} className={`ev ${g.status}`} title={`${g.name} — ${statusLabel(g.status)}`}>{g.name}</Link>)}
              </div>
            ); })}
          </div>
        ) : (
          <div className="agenda">
            {![...byDay.keys()].length ? <Empty title="Nothing scheduled" icon="calendar">No monitored game releases in the next 90 days.</Empty> : [...byDay.keys()].sort().map(k => (
              <div key={k}><div className="day-h">{new Date(k + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}{k === today && " · today"}</div>
                {byDay.get(k)!.map(g => <div key={g.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}><Art className="cover-sm" src={art.poster(g.id, g.customArtAt)} title={g.name} /><Link to={`/games/${g.id}`} className="grow">{g.name}</Link><Label tone={statusTone(g.status)}>{statusLabel(g.status)}</Label><Icon name={g.monitored ? "bookmark" : "bookmarkOff"} size={14} className="muted" /></div>)}
              </div>
            ))}
          </div>
        )}
        <div className="dim" style={{ marginTop: 14 }}>Colours: <span className="label primary">unreleased</span> <span className="label success">available</span> <span className="label danger">missing</span> <span className="label queue">in progress</span></div>
      </div>
    </>
  );
}
