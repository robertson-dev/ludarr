/** Games: the library as posters or a table, with sort, filter and search. */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { get, post, fmtSize, timeAgo, type Game } from "../api";
import { useEvents } from "../events";
import { Icon } from "../ui/icons";
import { Empty, Label, Spinner, ToolbarBtn, useLoad, useUi } from "../ui/kit";
import { STATUS, statusLabel, statusTone, crackChip, crackLabel, CRACK_TONE } from "../ui/status";
import { Art, art } from "../ui/art";
import { useLauncher } from "../launcher-state";

const SORTS = [["name", "Name"], ["added", "Date added"], ["release", "Release date"], ["status", "Status"]] as const;
const FILTERS = [["", "All"], ["monitored", "Monitored"], ["unmonitored", "Unmonitored"], ["missing", "Missing"], ["available", "Available"], ["unreleased", "Unreleased"], ["active", "In progress"]] as const;

function matches(g: Game, filter: string) {
  if (!filter) return true;
  if (filter === "monitored") return g.monitored;
  if (filter === "unmonitored") return !g.monitored;
  if (filter === "active") return ["searching", "downloading", "importing"].includes(g.status);
  return g.status === filter;
}

export function Poster({ g }: { g: Game }) {
  const L = useLauncher();
  const inst = g.file ? L.installedFor(g.id, g.file.id) : undefined;
  const installing = g.file ? L.installs[g.file.id] : undefined;
  const prog = installing ? installing.progress : g.request && ["fetching", "processing"].includes(g.request.state) ? g.request.progress : null;
  return (
    <Link to={`/games/${g.id}`} className="poster" title={g.name}>
      <div className="img">
        <Art src={art.poster(g.id, g.customArtAt)} title={g.name} />
        <span className="mon"><Icon name={g.monitored ? "bookmark" : "bookmarkOff"} size={16} /></span>
        {g.status !== "available" && g.status !== "missing" && <span className="badge"><Label tone={statusTone(g.status)}>{statusLabel(g.status)}</Label></span>}
        {inst && <span className="ribbon">{L.playing[inst.slug] ? "PLAYING" : "INSTALLED"}</span>}
        {(() => { const c = crackChip(g.drm, g.crackStatus); return c ? <span className="drm"><Label tone={c.tone}>{c.text}</Label></span> : null; })()}
        {prog != null && <div className="prog"><i style={{ width: `${Math.round(prog * 100)}%` }} /></div>}
        <span className={`st ${g.status}`} />
      </div>
      <div className="t">{g.name}</div>
      <div className="s">{g.status === "available" ? fmtSize(g.file?.size) : g.status === "unreleased" ? (g.releaseText || g.releaseIso || "coming soon") : statusLabel(g.status)}</div>
    </Link>
  );
}

export function GamesPage() {
  const { toast } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ items: Game[] }>("/api/v1/game"), []);
  useEvents(["request", "job", "package", "game", "fetch"], () => void reload());
  const [view, setView] = useState<"posters" | "table">(() => (localStorage.getItem("games.view") as "posters" | "table") || "posters");
  const [sort, setSort] = useState(() => localStorage.getItem("games.sort") || "name");
  const [filter, setFilter] = useState(() => localStorage.getItem("games.filter") || "");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const items = useMemo(() => {
    let rows = (data?.items ?? []).filter(g => matches(g, filter));
    const t = q.trim().toLowerCase();
    if (t) rows = rows.filter(g => g.name.toLowerCase().includes(t) || (g.aliases ?? []).some(a => a.toLowerCase().includes(t)));
    return rows.sort((a, b) => sort === "added" ? (b.addedAt ?? 0) - (a.addedAt ?? 0) : sort === "release" ? String(b.releaseIso ?? "").localeCompare(String(a.releaseIso ?? "")) : sort === "status" ? a.status.localeCompare(b.status) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [data, filter, q, sort]);
  const setV = (v: "posters" | "table") => { setView(v); localStorage.setItem("games.view", v); };
  const setS = (v: string) => { setSort(v); localStorage.setItem("games.sort", v); };
  const setF = (v: string) => { setFilter(v); localStorage.setItem("games.filter", v); };
  const searchMissing = async () => {
    setBusy(true);
    try { const r = await post<{ ok: boolean; error?: string }>("/api/v1/system/task/wanted"); toast(r.ok ? "Searching for every missing game" : r.error ?? "failed", r.ok ? "success" : "danger"); }
    catch (e: any) { toast(e.message, "danger"); } finally { setBusy(false); }
  };
  const refreshCatalog = async () => { try { await post("/api/v1/system/task/catalog"); toast("Catalog refresh started"); } catch (e: any) { toast(e.message, "danger"); } };
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const g of data?.items ?? []) c[g.status] = (c[g.status] ?? 0) + 1; return c; }, [data]);
  return (
    <>
      <div className="toolbar">
        <div className="tb-left">
          <Link to="/add" className="tbtn"><Icon name="plus" />Add New</Link>
          <ToolbarBtn icon="search" label="Search Missing" busy={busy} onClick={searchMissing} />
          <ToolbarBtn icon="refresh" label="Refresh Catalog" onClick={refreshCatalog} />
        </div>
        <div className="tb-right">
          <ToolbarBtn icon="grid" label="Posters" className={view === "posters" ? "on" : ""} onClick={() => setV("posters")} />
          <ToolbarBtn icon="list" label="Table" className={view === "table" ? "on" : ""} onClick={() => setV("table")} />
        </div>
      </div>
      <div className="content">
        <div className="filterbar">
          <input className="input" placeholder="Filter by name" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter by name" />
          <select className="select" value={filter} onChange={e => setF(e.target.value)} aria-label="Filter"><option value="">All games</option>{FILTERS.slice(1).map(([v, l]) => <option key={v} value={v}>{l}{counts[v] ? ` (${counts[v]})` : ""}</option>)}</select>
          <select className="select" value={sort} onChange={e => setS(e.target.value)} aria-label="Sort">{SORTS.map(([v, l]) => <option key={v} value={v}>Sort: {l}</option>)}</select>
          <span className="dim">{items.length} of {data?.items.length ?? 0}</span>
        </div>
        {loading && !data ? <Spinner /> : !data?.items.length ? (
          <Empty title="No games yet" icon="games">Add one under <Link to="/add">Add New</Link>, or import what is already on disk from the catalog.</Empty>
        ) : view === "posters" ? (
          <div className="posters">{items.map(g => <Poster key={g.id} g={g} />)}</div>
        ) : (
          <table className="table">
            <thead><tr><th></th><th></th><th>Title</th><th>Year</th><th>Status</th><th>DRM</th><th>Crack</th><th>Profile</th><th>Size</th><th>Added</th><th>Path</th></tr></thead>
            <tbody>{items.map(g => (
              <tr key={g.id}>
                <td style={{ width: 36 }}><Icon name={g.monitored ? "bookmark" : "bookmarkOff"} size={15} className="muted" /></td>
                <td style={{ width: 44 }}><Art className="cover-sm" src={art.poster(g.id, g.customArtAt)} title={g.name} /></td>
                <td><Link to={`/games/${g.id}`}>{g.name}</Link></td>
                <td>{g.releaseYear ?? (g.releaseIso ?? "").slice(0, 4) ?? ""}</td>
                <td><Label tone={statusTone(g.status)} icon={STATUS[g.status]?.icon}>{statusLabel(g.status)}</Label> {g.status !== "available" && <span className="dim">{g.statusDetail}</span>}</td>
                <td className="dim">{g.drm ?? ""}</td>
                <td>{g.crackStatus && g.crackStatus !== "untracked" ? <><Label tone={CRACK_TONE[g.crackStatus] ?? "dim"}>{crackLabel(g.crackStatus)}</Label>{g.crackGroup && <span className="dim"> {g.crackGroup}</span>}</> : <span className="dim">{g.crackStatus === "untracked" ? "—" : ""}</span>}</td>
                <td>{g.profile?.name ?? "—"}</td>
                <td>{fmtSize(g.file?.size)}</td>
                <td className="dim">{timeAgo(g.addedAt)}</td>
                <td className="dim ellipsis" style={{ maxWidth: 320 }}>{g.file?.path ?? g.path ?? ""}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
