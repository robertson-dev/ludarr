/** Ahoy — the pieces every page is built from: the journey line, cards, rows, the one button, small bits. */
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fmtSize, urlBase, type BestItem, type DiscoverItem, type Game, type LookupHit } from "../api";
import { Icon, type IconName } from "../ui/icons";
import { Art, art, hitArt } from "../ui/art";
import { useUi } from "../ui/kit";
import { LauncherDownload } from "../ui/launcher-download";
import { useLauncher } from "../launcher-state";
import { act, useLib, type AppDetail } from "./data";
import { availabilityOf, journeyOf, shortDate, STOPS, type Journey } from "./model";

export const steamBanner = (appId: number) => `${urlBase}/api/v1/art/steam/${appId}/banner`;
const PLATFORM_WORD: Record<string, string> = { ps1: "PlayStation", ps2: "PlayStation 2", ps3: "PlayStation 3", ps4: "PlayStation 4", ps5: "PlayStation 5", psp: "PSP", vita: "Vita", switch: "Switch", wii: "Wii", wiiu: "Wii U", gc: "GameCube", n64: "Nintendo 64", snes: "SNES", nes: "NES", gba: "Game Boy Advance", ds: "DS", "3ds": "3DS", xbox: "Xbox", x360: "Xbox 360", xone: "Xbox One", dreamcast: "Dreamcast", saturn: "Saturn", genesis: "Genesis", mac: "Mac", linux: "Linux" };
/** soundtracks, DLC and demos are not games to get */
export const isGameHit = (h: LookupHit) => !/\b(soundtrack|ost|dlc|demo|playtest|season pass|artbook|art book)\b/i.test(h.name);

/* ─────────── the journey line ─────────── */

export function JourneyLine({ j, small, labels = true }: { j: Journey; small?: boolean; labels?: boolean }) {
  const dots = STOPS.map((_, i) => (i < j.done ? "" : j.current === i ? "cur" : j.stage === "failed" && i === 0 ? "bad" : "todo"));
  const segs = STOPS.slice(1).map((_, i) => (i + 1 < j.done ? "" : j.current === i + 1 && j.progress != null ? "part" : "todo"));
  const label = (i: number) => (j.current === i && j.active ? j.label : STOPS[i]);
  return (
    <div className={`journey-wrap${small ? " sm" : ""}`}>
      <div className="journey">
        {STOPS.map((_, i) => (
          <span key={i} style={{ display: "contents" }}>
            <span className={`dot ${dots[i]}`} />
            {i < 4 && <span className={`seg ${segs[i]}`} style={segs[i] === "part" ? ({ "--part": `${Math.round((j.progress ?? 0) * 100)}%` } as React.CSSProperties) : undefined} />}
          </span>
        ))}
      </div>
      {labels && <div className="journey-labels">{STOPS.map((_, i) => <span key={i} className={i < j.done ? "done" : j.current === i ? "cur" : ""}>{label(i)}</span>)}</div>}
    </div>
  );
}

/* ─────────── cards and rows ─────────── */

export function CardRow({ title, count, sub, more, children }: { title: string; count?: number; sub?: string; more?: string; children: ReactNode }) {
  return (
    <section className="row">
      <div className="rh"><h2>{title}</h2>{count != null && <span className="n">{count}</span>}{sub && <span className="sub">{sub}</span>}{more && <Link className="more" to={more}>All<Icon name="chevronRight" size={16} /></Link>}</div>
      {children}
    </section>
  );
}

export function Card({ to, title, poster, sub, dot, lamp, mono, here, progress, action, badge }: { to: string; title: string; poster: string | null; sub?: string; dot?: "ok" | "lamp" | "bad" | "muted"; lamp?: boolean; mono?: boolean; here?: boolean; progress?: number | null; action?: ReactNode; badge?: string }) {
  const filling = progress != null && progress > 0 && progress < 1;
  return (
    <Link to={to} className="card" title={title}>
      <div className="art" style={filling ? ({ "--left": `${Math.round((1 - progress) * 100)}%` } as React.CSSProperties) : undefined}>
        {filling && poster ? <><img className="base" src={poster} alt="" loading="lazy" /><img className="fill" src={poster} alt="" loading="lazy" /><span className="rule" /></> : <Art src={poster} title={title} />}
        {badge && <span className="score" title="Metacritic">{badge}</span>}
        {here && <span className="here"><Icon name="check" size={14} /></span>}
        {action && <div className="hover"><span className="act" onClick={e => { e.preventDefault(); e.stopPropagation(); }}>{action}</span></div>}
      </div>
      <div className="t">{title}</div>
      {sub != null && <div className={`s${mono ? " mono" : ""}${lamp ? " lamp" : ""}`}>{dot && <span className={`dot ${dot}`} />}{sub}</div>}
    </Link>
  );
}

/** a library game as a card: what is under it comes from the journey */
export function LibCard({ g, action = true, badge }: { g: Game; action?: boolean; badge?: string }) {
  const L = useLauncher();
  const inst = g.file ? L.installedFor(g.id, g.file.id) : undefined;
  const prog = g.file ? L.installs[g.file.id] : undefined;
  const j = journeyOf(g, inst, prog);
  const sub = j.stage === "ready" ? fmtSize(g.file?.size) : j.stage === "installing" ? `${j.label} · ${Math.round((j.progress ?? 0) * 100)}%` : j.active ? `${j.label}…` : j.label;
  const dot = j.stage === "installed" ? "ok" : j.stage === "failed" ? "bad" : j.active ? "lamp" : undefined;
  return <Card to={`/game/${g.id}`} title={g.name} poster={art.poster(g.id)} sub={sub} dot={dot} lamp={j.active} mono={j.stage === "ready" || j.stage === "waiting"} here={!!inst}
    progress={prog ? prog.progress : j.active ? g.request?.progress ?? null : null} action={action ? <Actions game={g} compact /> : undefined} badge={badge} />;
}

/** a storefront item as a card: in the library it behaves like the library game, otherwise it says whether it can be had */
export function DiscoverCard({ item }: { item: DiscoverItem }) {
  const lib = useLib();
  const g = (item.gameId != null ? lib.byId.get(item.gameId) : undefined) ?? lib.byApp.get(item.appId);
  if (g) return <LibCard g={g} />;
  const a = availabilityOf(item);
  return <Card to={`/steam/${item.appId}`} title={item.name} poster={item.portrait ?? art.steam(item.appId, item.name)} sub={a.text} dot={a.dot === "muted" ? undefined : a.dot} mono={item.comingSoon} action={<Actions app={item} compact />} />;
}

/** a Metacritic entry as a card: the score sits on the poster; the players' lists show the user score instead */
export function BestCard({ item, user }: { item: BestItem; user?: boolean }) {
  const lib = useLib();
  const g = (item.gameId != null ? lib.byId.get(item.gameId) : undefined) ?? lib.byApp.get(item.appId);
  const badge = user && item.userScore != null ? item.userScore.toFixed(1) : item.metacritic != null ? String(item.metacritic) : undefined;
  if (g) return <LibCard g={g} badge={badge} />;
  const a = availabilityOf(item);
  return <Card to={`/steam/${item.appId}`} title={item.name} poster={item.portrait ?? art.steam(item.appId, item.name)} sub={a.text} dot={a.dot === "muted" ? undefined : a.dot} mono={item.comingSoon} badge={badge} action={<Actions app={item} compact />} />;
}

/** a search hit as a card */
export function HitCard({ h, onPreview }: { h: LookupHit; onPreview: (h: LookupHit) => void }) {
  const lib = useLib();
  const g = h.gameId != null ? lib.byId.get(h.gameId) : undefined;
  if (g) return <LibCard g={g} />;
  const steam = h.id.scheme === "steam";
  const plats = h.platforms.filter(p => !/^(win|pc|windows)$/i.test(p)).map(p => PLATFORM_WORD[p.toLowerCase()] ?? p).slice(0, 2).join(", ");
  const sub = [h.year, plats].filter(Boolean).join(" · ") || (steam ? "Steam" : h.source);
  if (steam) return <Card to={`/steam/${h.id.value}`} title={h.name} poster={hitArt(h)} sub={sub} />;
  return (
    <a className="card" href="#" title={h.name} onClick={e => { e.preventDefault(); onPreview(h); }}>
      <div className="art"><Art src={hitArt(h)} title={h.name} /></div>
      <div className="t">{h.name}</div><div className="s">{sub}</div>
    </a>
  );
}

/* ─────────── the one button ─────────── */

export function Actions({ game, app, lg, compact }: { game?: Game | null; app?: DiscoverItem | AppDetail | null; lg?: boolean; compact?: boolean }) {
  const L = useLauncher();
  const lib = useLib();
  const { toast, confirm } = useUi();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [dl, setDl] = useState(false);
  const size = lg ? " lg" : "";
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) toast(done, "success"); await lib.reload(); } catch (e: any) { toast(String(e?.message ?? e), "danger"); } finally { setBusy(false); }
  };
  const g = game ?? (app?.gameId != null ? lib.byId.get(app.gameId) : undefined) ?? (app ? lib.byApp.get(app.appId) : undefined);
  const inst = g?.file ? L.installedFor(g.id, g.file.id) : undefined;
  const prog = g?.file ? L.installs[g.file.id] : undefined;

  if (g && prog) {
    const j = journeyOf(g, inst, prog);
    return <>
      <button className={`btn${size}`} disabled><Icon name="spinner" size={16} className="ic spin" />{j.label} {Math.round((j.progress ?? 0) * 100)}%</button>
      {!compact && <button className={`btn quiet${size}`} onClick={() => void L.cancelInstall(g.file!.id)}>Cancel</button>}
    </>;
  }
  if (g && inst) {
    const running = !!L.playing[inst.slug];
    return <>
      <button data-primary="" className={`btn play${size}`} disabled={running} onClick={() => void L.play(inst.slug)}><Icon name="play" size={16} className="ic" />{running ? "Running" : "Play"}</button>
      {!compact && <>
        <button className={`btn quiet${size}`} onClick={() => void L.openFolder(inst.slug)}>Open folder</button>
        <button className={`btn quiet${size}`} onClick={async () => { if (await confirm(`Uninstall ${g.name}?`, <>The folder <code>{inst.path}</code> is deleted from this PC. The copy on your server stays.</>, { ok: "Uninstall" })) void L.uninstall(inst.slug); }}>Uninstall</button>
      </>}
    </>;
  }
  if (g) {
    const j = journeyOf(g);
    if (g.status === "available" && g.file) {
      if (L.inLauncher) return <button data-primary="" className={`btn primary${size}`} onClick={() => void L.install(g.file!.id)}><Icon name="download" size={16} className="ic" />Install</button>;
      return <><button data-primary="" className={`btn primary${size}`} onClick={() => setDl(true)}><Icon name="download" size={16} className="ic" />Install</button><LauncherDownload open={dl} onClose={() => setDl(false)} /></>;
    }
    if (j.active) return <>
      <button className={`btn${size}`} disabled><Icon name="spinner" size={16} className="ic spin" />{j.label}…</button>
      {!compact && g.request && <button className={`btn quiet${size}`} disabled={busy} onClick={() => void run(() => act.cancel(g.request!.id), "Cancelled")}>Cancel</button>}
    </>;
    if (g.status === "unreleased") {
      return g.tracked
        ? <button className={`btn${size}`} disabled={busy} title="click to stop tracking" onClick={() => void run(() => act.monitor(g.id, false), "No longer tracked")}><Icon name="check" size={16} className="ic" />Tracked</button>
        : <button data-primary="" className={`btn primary${size}`} disabled={busy} onClick={() => void run(() => act.monitor(g.id, true), "Tracked: it arrives on release day")}><Icon name="bell" size={16} className="ic" />Track</button>;
    }
    return <button data-primary="" className={`btn primary${size}`} disabled={busy} onClick={() => void run(async () => { if (!g.monitored) await act.monitor(g.id, true); await act.search(g.id); }, "Looking for it")}><Icon name="download" size={16} className="ic" />{g.status === "failed" ? "Try again" : "Get it"}</button>;
  }
  if (app) {
    if (app.comingSoon) return <button data-primary="" className={`btn primary${size}`} disabled={busy} onClick={() => void run(() => act.getSteam(app.appId, false), "Tracked: it arrives on release day")}><Icon name="bell" size={16} className="ic" />Track</button>;
    const blocked = app.crackStatus === "uncracked" || app.crackStatus === "hypervisor";
    if (blocked) return <>
      <button className={`btn${size}`} disabled title={`${app.drm ?? "protected"}: nobody has made it playable yet`}>Not yet</button>
      {!compact && <button className={`btn quiet${size}`} disabled={busy} onClick={() => void run(() => act.getSteam(app.appId, false), "On the watch list: Ahoy gets it when it becomes playable")}><Icon name="bell" size={16} className="ic" />Watch for it</button>}
    </>;
    return <button data-primary="" className={`btn primary${size}`} disabled={busy} onClick={() => void run(async () => { const r = await act.getSteam(app.appId, true); nav(`/game/${r.item.id}`); }, "On its way")}><Icon name="download" size={16} className="ic" />Get it</button>;
  }
  return null;
}

/* ─────────── small bits ─────────── */

export function Empty({ title, icon = "compass", children }: { title: string; icon?: IconName; children?: ReactNode }) {
  return <div className="empty"><Icon name={icon} size={32} /><h3>{title}</h3>{children}</div>;
}
export function Spin({ text }: { text?: string }) { return <div className="empty"><Icon name="spinner" size={24} className="spin" />{text && <span>{text}</span>}</div>; }

export function Facts({ items }: { items: [string, ReactNode][] }) {
  const rows = items.filter(([, v]) => v != null && v !== "" && v !== false);
  if (!rows.length) return null;
  return <div className="facts">{rows.map(([k, v]) => <div key={k}><b>{k}</b><span>{v}</span></div>)}</div>;
}

export const releaseLine = (i: { releaseIso: string | null; releaseText: string | null }) => shortDate(i.releaseIso) ?? i.releaseText ?? null;
export const steamStore = (appId: number) => `https://store.steampowered.com/app/${appId}/`;

/* ─────────── video: trailers, muted and looping until asked for sound ─────────── */

import { useEffect, useRef } from "react";
import type { Trailer } from "./data";

/** Steam serves trailers as HLS manifests now (older apps still have mp4 / webm): hls.js feeds the <video> through MSE */
function attach(v: HTMLVideoElement, t: Trailer): () => void {
  if (t.hls) {
    let dead = false, player: { destroy(): void } | null = null;
    void import("hls.js").then(({ default: Hls }) => {
      if (dead) return;
      if (!Hls.isSupported()) { v.src = t.mp4 ?? t.webm ?? t.hls!; v.load(); return; }
      const h = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 20, startLevel: -1 });
      h.loadSource(t.hls!); h.attachMedia(v); player = h;
      const p = v.play(); if (p) p.catch(() => {});
    });
    return () => { dead = true; player?.destroy(); };
  }
  v.src = t.mp4 ?? t.webm ?? ""; v.load();
  return () => { v.removeAttribute("src"); v.load(); };
}

/** a trailer playing quietly in the background of a hero; React does not set `muted` reliably, so it is done by hand */
export function Reel({ t, poster, className, sound, onReady }: { t: Trailer; poster?: string | null; className?: string; sound?: boolean; onReady?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const v = ref.current; if (!v) return; v.defaultMuted = true; v.muted = !sound; if (sound) v.volume = 0.6; }, [sound]);
  useEffect(() => {
    const v = ref.current; if (!v) return;
    v.defaultMuted = true; v.muted = true;
    const off = attach(v, t);
    const p = v.play(); if (p) p.catch(() => {});
    return off;
  }, [t.hls, t.mp4, t.webm]);
  return <video ref={ref} className={className} poster={poster ?? t.thumb} autoPlay loop playsInline muted preload="auto" onPlaying={onReady} disablePictureInPicture />;
}

/** a trailer with controls and sound, for the viewer */
function Clip({ t }: { t: Trailer }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const v = ref.current; if (!v) return; const off = attach(v, t); const p = v.play(); if (p) p.catch(() => {}); return off; }, [t.hls, t.mp4, t.webm]);
  return <video ref={ref} controls autoPlay playsInline poster={t.thumb} />;
}

/** trailers and screenshots as one strip; click opens the viewer */
export function MediaStrip({ trailers, shots, onOpen }: { trailers: Trailer[]; shots: string[]; onOpen: (i: number) => void }) {
  const items = [...trailers.map(t => ({ kind: "video" as const, thumb: t.thumb, label: t.name })), ...shots.map(s => ({ kind: "image" as const, thumb: s, label: "" }))];
  if (!items.length) return null;
  return (
    <div className="media">
      {items.slice(0, 8).map((m, i) => (
        <button key={i} className={`shot ${m.kind}`} onClick={() => onOpen(i)} title={m.label || (m.kind === "video" ? "Trailer" : "Screenshot")}>
          <img src={m.thumb} alt="" loading="lazy" />
          {m.kind === "video" && <span className="playmark"><Icon name="play" size={18} /></span>}
        </button>
      ))}
    </div>
  );
}

export function Viewer({ open, index, trailers, shots, onClose }: { open: boolean; index: number; trailers: Trailer[]; shots: string[]; onClose: () => void }) {
  const [i, setI] = useState(index);
  const total = trailers.length + shots.length;
  useEffect(() => { setI(index); }, [index, open]);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowRight") setI(x => Math.min(total - 1, x + 1)); if (e.key === "ArrowLeft") setI(x => Math.max(0, x - 1)); };
    addEventListener("keydown", on); return () => removeEventListener("keydown", on);
  }, [open, total, onClose]);
  if (!open || !total) return null;
  const t = i < trailers.length ? trailers[i] : null;
  const shot = t ? null : shots[i - trailers.length];
  return (
    <div className="viewer" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="ib close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
      {i > 0 && <button className="ib prev" onClick={() => setI(i - 1)} aria-label="Previous"><Icon name="chevronLeft" size={20} /></button>}
      {i < total - 1 && <button className="ib next" onClick={() => setI(i + 1)} aria-label="Next"><Icon name="chevronRight" size={20} /></button>}
      <div className="stage">{t ? <Clip key={t.hls ?? t.mp4 ?? i} t={t} /> : <img src={shot!} alt="" />}</div>
      <div className="count mono">{i + 1} / {total}</div>
    </div>
  );
}
