/** Ahoy — the shell: wordmark, three tabs, one search, the downloads ring, settings. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Icon } from "../ui/icons";
import { UiProvider } from "../ui/kit";
import { LauncherProvider, useLauncher } from "../launcher-state";
import { launcher } from "../launcher";
import { LibCtx, useLib, useLibrarySource } from "./data";
import { isActive } from "./model";
import { Discover, Downloads, Home, Library, SearchPage, Settings } from "./pages";
import { GamePage, SteamPage } from "./game";

function LibProvider({ children }: { children: ReactNode }) {
  const lib = useLibrarySource();
  return <LibCtx.Provider value={lib}>{children}</LibCtx.Provider>;
}

function Ring() {
  const lib = useLib();
  const L = useLauncher();
  const installs = Object.values(L.installs);
  const active = lib.games.filter(isActive);
  const n = installs.length + active.length;
  const progress = installs[0]?.progress ?? active[0]?.request?.progress ?? 0;
  const C = 2 * Math.PI * 12;
  return (
    <Link to="/downloads" className={`ring${n ? "" : " idle"}`} title={n ? `${n} on the way` : "Nothing on the way"} aria-label="Downloads">
      <svg className="r" viewBox="0 0 28 28"><circle className="t" cx="14" cy="14" r="12" />{n > 0 && <circle className="p" cx="14" cy="14" r="12" strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(1, Math.max(0.03, progress)))} />}</svg>
      {n ? <span className="n">{n}</span> : <Icon name="download" size={16} />}
    </Link>
  );
}

const framed = !!launcher?.features?.includes("frameless");     // the launcher draws no title bar: this bar is it
function TopBar({ over }: { over: boolean }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!loc.pathname.startsWith("/search")) setQ(""); }, [loc.pathname]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) { e.preventDefault(); box.current?.focus(); }
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); nav(-1); }
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); nav(1); }
    };
    // the mouse's back and forward buttons: a browser handles them itself, the launcher's window does not
    const mouse = (e: MouseEvent) => { if (!launcher) return; if (e.button === 3) { e.preventDefault(); nav(-1); } else if (e.button === 4) { e.preventDefault(); nav(1); } };
    addEventListener("keydown", on); addEventListener("mouseup", mouse);
    return () => { removeEventListener("keydown", on); removeEventListener("mouseup", mouse); };
  }, []);
  const canBack = ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;
  return (
    <header className={`top${over ? " over" : ""}${framed ? " framed" : ""}`}>
      <button className={`ib back${canBack ? "" : " off"}`} title="Back" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" size={20} /></button>
      <Link to="/" className="word">Ahoy</Link>
      <nav className="tabs" aria-label="Main">
        <NavLink to="/" end className={({ isActive }) => (isActive ? "on" : "")}>Home</NavLink>
        <NavLink to="/discover" className={({ isActive }) => (isActive ? "on" : "")}>Discover</NavLink>
        <NavLink to="/library" className={({ isActive }) => (isActive ? "on" : "")}>Library</NavLink>
      </nav>
      <form className="search" role="search" onSubmit={e => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`); }}>
        <Icon name="search" size={16} />
        <input ref={box} value={q} placeholder="Search any game" aria-label="Search any game" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { setQ(""); box.current?.blur(); } }} />
        {!q && <span className="key">/</span>}
      </form>
      <Ring />
      <NavLink to="/settings" className={({ isActive }) => `ib${isActive ? " on" : ""}`} title="Settings" aria-label="Settings"><Icon name="settings" size={18} /></NavLink>
    </header>
  );
}

function Shell() {
  const loc = useLocation();
  const over = /^\/(game|steam)\//.test(loc.pathname);
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  return (
    <>
      <TopBar over={over} />
      <main className="page">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/library" element={<Library />} />
          <Route path="/game/:id" element={<GamePage />} />
          <Route path="/steam/:appId" element={<SteamPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}

export function App() {
  return (
    <UiProvider><LauncherProvider><LibProvider>
      <Shell />
    </LibProvider></LauncherProvider></UiProvider>
  );
}
