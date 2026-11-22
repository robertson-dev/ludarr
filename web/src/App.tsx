/** ludarr web — the shell: top bar, sidebar, routes. */
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { get, runtime, type Game, type HealthItem } from "./api";
import { onConnection, useEvents } from "./events";
import { Icon, type IconName } from "./ui/icons";
import { UiProvider } from "./ui/kit";
import { LauncherProvider } from "./launcher-state";
import { inLauncher } from "./launcher";
import { LauncherPage } from "./pages/settings/launcher";
import { Art, art } from "./ui/art";
import { UploadsBadge } from "./ui/upload";
import { GamesPage } from "./pages/games";
import { GamePage } from "./pages/game";
import { AddPage } from "./pages/add";
import { CalendarPage } from "./pages/calendar";
import { QueuePage, HistoryPage, BlocklistPage } from "./pages/activity";
import { BuildsPage } from "./pages/builds";
import { WantedPage } from "./pages/wanted";
import { MediaPage } from "./pages/settings/media";
import { ProfilesPage } from "./pages/settings/profiles";
import { ImportPractice } from "./ui/job-simulation";
import { InstancesPage, SingletonsPage } from "./pages/settings/instances";
import { RuntimesPage } from "./pages/settings/plans";
import { PluginsPage } from "./pages/settings/plugins";
import { GeneralPage } from "./pages/settings/general";
import { StatusPage, TasksPage, BackupPage, LogsPage } from "./pages/system";

interface NavItem { to: string; label: string; icon: IconName; children?: { to: string; label: string }[] }
const NAV: NavItem[] = [
  { to: "/games", label: "Games", icon: "games" },
  { to: "/add", label: "Add New", icon: "plus" },
  { to: "/calendar", label: "Calendar", icon: "calendar" },
  { to: "/activity", label: "Activity", icon: "activity", children: [{ to: "/activity/queue", label: "Queue" }, { to: "/activity/builds", label: "Builds" }, { to: "/activity/history", label: "History" }, { to: "/activity/blocklist", label: "Blocklist" }] },
  { to: "/wanted", label: "Wanted", icon: "wanted", children: [{ to: "/wanted/missing", label: "Missing" }, { to: "/wanted/cutoff", label: "Cutoff Unmet" }] },
  { to: "/settings", label: "Settings", icon: "settings", children: [
    { to: "/settings/mediamanagement", label: "Media Management" }, { to: "/settings/profiles", label: "Profiles" }, { to: "/settings/indexers", label: "Indexers" },
    { to: "/settings/downloadclients", label: "Download Clients" }, { to: "/settings/metadata", label: "Metadata" }, { to: "/settings/importers", label: "Importers" },
    { to: "/settings/runtimes", label: "Runtimes" }, { to: "/settings/connect", label: "Connect" }, { to: "/settings/plugins", label: "Plugins" }, { to: "/settings/general", label: "General" },
    ...(inLauncher ? [{ to: "/settings/launcher", label: "Launcher" }] : []),
  ] },
  { to: "/system", label: "System", icon: "system", children: [{ to: "/system/status", label: "Status" }, { to: "/system/tasks", label: "Tasks" }, { to: "/system/backup", label: "Backup" }, { to: "/system/logs", label: "Logs" }] },
];

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const loc = useLocation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const active = NAV.find(n => loc.pathname.startsWith(n.to));
  const openGroup = expanded ?? active?.to ?? null;
  return (
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Main">
      {NAV.map(n => (
        <div key={n.to}>
          <NavLink to={n.children ? n.children[0].to : n.to} className={({ isActive }) => (isActive || loc.pathname.startsWith(n.to) ? "on" : "")}
            onClick={() => { setExpanded(n.to); onNavigate(); }}>
            <Icon name={n.icon} size={18} />{n.label}{n.children && <Icon name={openGroup === n.to ? "chevronUp" : "chevronDown"} size={14} className="chev" />}
          </NavLink>
          {n.children && openGroup === n.to && <div className="sub">{n.children.map(c => <NavLink key={c.to} to={c.to} className={({ isActive }) => (isActive ? "on" : "")} onClick={onNavigate}>{c.label}</NavLink>)}</div>}
        </div>
      ))}
      <div className="foot">ludarr {runtime.version}</div>
    </nav>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [games, setGames] = useState<Game[] | null>(null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const on = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); }; addEventListener("mousedown", on); return () => removeEventListener("mousedown", on); }, []);
  // the list is fetched when the box is focused and again after it has aged or the library changed — a deleted game must not linger as a hit
  const loadedAt = useRef(0);
  const load = async (force = false) => {
    if (!force && games && Date.now() - loadedAt.current < 15_000) return;
    const items = (await get<{ items: Game[] }>("/api/v1/game")).items;
    setGames(items); loadedAt.current = Date.now();
  };
  useEvents(["game", "package"], () => { loadedAt.current = 0; if (open) void load(true); });   // a game added or deleted: the hits follow at once
  const t = q.trim().toLowerCase();
  const hits = t ? (games ?? []).filter(g => g.name.toLowerCase().includes(t) || (g.aliases ?? []).some(a => a.toLowerCase().includes(t))).slice(0, 8) : [];
  const go = (i: number) => {
    if (i < hits.length) nav(`/games/${hits[i].id}`); else nav(`/add?term=${encodeURIComponent(q.trim())}`);
    setQ(""); setOpen(false);
  };
  return (
    <div className="search" ref={box}>
      <Icon name="search" size={16} />
      <input placeholder="Search games" value={q} aria-label="Search games" onFocus={() => { setOpen(true); void load(); }} onChange={e => { setQ(e.target.value); setOpen(true); setSel(0); }}
        onKeyDown={e => { if (e.key === "ArrowDown") setSel(s => Math.min(s + 1, hits.length)); else if (e.key === "ArrowUp") setSel(s => Math.max(0, s - 1)); else if (e.key === "Enter" && q.trim()) go(sel); else if (e.key === "Escape") setOpen(false); }} />
      {open && q.trim() && (
        <div className="results">
          {hits.map((g, i) => <Link key={g.id} to={`/games/${g.id}`} className={i === sel ? "on" : ""} onClick={() => { setQ(""); setOpen(false); }}><Art src={art.poster(g.id, g.customArtAt)} title={g.name} className="thumb" /><span className="grow ellipsis">{g.name}</span><span className="dim">{g.releaseYear ?? ""}</span></Link>)}
          <Link to={`/add?term=${encodeURIComponent(q.trim())}`} className={sel === hits.length ? "on" : ""} onClick={() => { setQ(""); setOpen(false); }}><Icon name="plus" size={16} /><span className="grow">Add new: “{q.trim()}”</span></Link>
        </div>
      )}
    </div>
  );
}

function HealthBadge() {
  const [items, setItems] = useState<HealthItem[]>([]);
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState(true);
  const load = () => get<{ items: HealthItem[] }>("/api/v1/health").then(r => setItems(r.items)).catch(() => {});
  useEffect(() => { void load(); const t = setInterval(load, 60_000); const off = onConnection(setOnline); return () => { clearInterval(t); off(); }; }, []);
  useEvents(["catalog", "package", "job"], () => void load());
  const worst = !online ? "error" : items.some(i => i.type === "error") ? "error" : items.some(i => i.type === "warning") ? "warning" : "ok";
  const shown = items.filter(i => i.type !== "notice").concat(items.filter(i => i.type === "notice"));
  return (
    <>
      <button title="Health" aria-label="Health" onClick={() => setOpen(o => !o)}><Icon name="activity" size={18} /><span className={`health-dot ${worst}`} /></button>
      {open && (
        <div className="health-pop" onMouseLeave={() => setOpen(false)}>
          {!online && <div className="item"><Icon name="alert" className="muted" /> <span>Lost the live connection to ludarr — reconnecting…</span></div>}
          {shown.length === 0 && online && <div className="item"><Icon name="check" style={{ color: "var(--success)" }} /> <span>Everything looks healthy.</span></div>}
          {shown.map((i, k) => <div key={k} className="item"><Icon name={i.type === "notice" ? "info" : "alert"} style={{ color: i.type === "error" ? "var(--danger)" : i.type === "warning" ? "var(--warning)" : "var(--primary)" }} /><span>{i.message}{i.link && <> · <Link to={i.link} onClick={() => setOpen(false)}>Fix</Link></>}</span></div>)}
        </div>
      )}
    </>
  );
}

export function App() {
  const [menu, setMenu] = useState(false);
  return (
    <UiProvider><LauncherProvider>
      <header className="topbar">
        <button className="menu-btn ibtn" aria-label="Menu" onClick={() => setMenu(m => !m)} style={{ marginLeft: 8 }}><Icon name="menu" size={20} /></button>
        <Link to="/games" className="logo"><span className="mark"><Icon name="play" size={16} /></span>ludarr</Link>
        <GlobalSearch />
        <span className="spacer" />
        <div className="tools"><UploadsBadge /><HealthBadge /><Link to="/settings/general" title="Settings" aria-label="Settings"><Icon name="settings" size={18} /></Link></div>
      </header>
      <Sidebar open={menu} onNavigate={() => setMenu(false)} />
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/games" replace />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:id" element={<GamePage />} />
          <Route path="/add" element={<AddPage tab="search" />} />
          <Route path="/add/discover" element={<AddPage tab="discover" />} />
          <Route path="/add/manual" element={<AddPage tab="manual" />} />
          <Route path="/add/repo" element={<AddPage tab="repo" />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/activity" element={<Navigate to="/activity/queue" replace />} />
          <Route path="/activity/queue" element={<QueuePage />} />
          <Route path="/activity/builds" element={<BuildsPage />} />
          <Route path="/activity/history" element={<HistoryPage />} />
          <Route path="/activity/blocklist" element={<BlocklistPage />} />
          <Route path="/wanted" element={<Navigate to="/wanted/missing" replace />} />
          <Route path="/wanted/missing" element={<WantedPage kind="missing" />} />
          <Route path="/wanted/cutoff" element={<WantedPage kind="cutoff" />} />
          <Route path="/settings" element={<Navigate to="/settings/mediamanagement" replace />} />
          <Route path="/settings/mediamanagement" element={<MediaPage />} />
          <Route path="/settings/profiles" element={<ProfilesPage />} />
          <Route path="/settings/indexers" element={<InstancesPage kind="indexer" title="Indexers" blurb="Where releases are found. Prowlarr fans one search out to everything configured there; Torznab / Newznab endpoints can be added directly." />} />
          <Route path="/settings/downloadclients" element={<InstancesPage kind="downloadclient" title="Download Clients" blurb="Where grabbed releases are sent, and how finished downloads get to ludarr. The first enabled client that speaks a release's protocol takes it." />} />
          <Route path="/settings/connect" element={<InstancesPage kind="notification" title="Connect" blurb="Notifications when something is grabbed, imported or fails." />} />
          <Route path="/settings/metadata" element={<SingletonsPage kind="metadata" title="Metadata" blurb="The catalog sources: where games and the ways to play them come from. Each runs on its own schedule." />} />
          <Route path="/settings/importers" element={<SingletonsPage kind="importer" title="Importers" blurb="How a finished download becomes an installed game. Importers run in order until one produces a valid game folder." ordered><ImportPractice /></SingletonsPage>} />
          <Route path="/settings/runtimes" element={<RuntimesPage />} />
          <Route path="/settings/plugins" element={<PluginsPage />} />
          <Route path="/settings/general" element={<GeneralPage />} />
          <Route path="/settings/launcher" element={<LauncherPage />} />
          <Route path="/system" element={<Navigate to="/system/status" replace />} />
          <Route path="/system/status" element={<StatusPage />} />
          <Route path="/system/tasks" element={<TasksPage />} />
          <Route path="/system/backup" element={<BackupPage />} />
          <Route path="/system/logs" element={<LogsPage />} />
          <Route path="*" element={<div className="content"><h2 className="page-title">Not found</h2><p className="muted">There is nothing at this address.</p></div>} />
        </Routes>
      </main>
    </LauncherProvider></UiProvider>
  );
}
