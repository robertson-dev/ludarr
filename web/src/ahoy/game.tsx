/** Ahoy — one page for a game, whether it is on your server (GamePage) or only out there on Steam (SteamPage). */
import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { fmtSize, type GameDetail } from "../api";
import { Icon } from "../ui/icons";
import { art } from "../ui/art";
import { useLauncher } from "../launcher-state";
import { useApp, useGame, useSimilar, type AppDetail, type Trailer } from "./data";
import { availabilityOf, journeyOf, plainText, sentence, shortDate } from "./model";
import { Actions, CardRow, DiscoverCard, Empty, Facts, JourneyLine, MediaStrip, Reel, Spin, Viewer, releaseLine, steamBanner, steamStore } from "./parts";

const crackWord = (s: string | null | undefined) => (s === "cracked" ? "playable" : s === "uncracked" ? "not playable yet" : s === "hypervisor" ? "bypass only" : s === "unreleased" ? "not out yet" : null);

/** what the store puts next to this game; nothing is drawn until there is something to show */
function Similar({ appId }: { appId: number | null | undefined }) {
  const { items } = useSimilar(appId);
  if (!items?.length) return null;
  return <div className="gmore"><CardRow title="More like this" sub="games the store keeps next to it"><div className="cards">{items.map(i => <DiscoverCard key={i.appId} item={i} />)}</div></CardRow></div>;
}

/** the top of the page: the trailer playing quietly when there is one, the wide art otherwise */
function Backdrop({ image, trailer }: { image: string; trailer: Trailer | null }) {
  const [sound, setSound] = useState(false);
  const [live, setLive] = useState(false);
  return (
    <div className="gshot" style={{ backgroundImage: `url(${image})` }}>
      {trailer && <Reel t={trailer} poster={image} className={`reel${live ? " live" : ""}`} sound={sound} onReady={() => setLive(true)} />}
      {trailer && live && <button className={`sound${sound ? " on" : ""}`} onClick={() => setSound(s => !s)} title={sound ? "Mute" : "Sound"}><Icon name={sound ? "volume" : "volumeOff"} size={16} />{sound ? "Sound on" : "Sound"}</button>}
    </div>
  );
}

function Media({ app, shots }: { app: AppDetail | null; shots: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const trailers = app?.trailers ?? [];
  const pics = (app?.screenshots?.length ? app.screenshots : shots).map(s => art.proxy(s));
  if (!trailers.length && !pics.length) return null;
  return <>
    <MediaStrip trailers={trailers} shots={pics} onOpen={setOpen} />
    <Viewer open={open != null} index={open ?? 0} trailers={trailers} shots={pics} onClose={() => setOpen(null)} />
  </>;
}

function Ways({ g }: { g: GameDetail }) {
  if (!g.routes.length) return null;
  return (
    <div className="ways">
      <div className="section-title" style={{ margin: "0 0 4px" }}>Other ways to play</div>
      {g.routes.map(r => (
        <div className="way" key={r.id}>
          <div className="grow"><b>{r.label ?? r.runtime?.name ?? r.kind}</b><small>{[r.platform, r.provenance !== "retail" ? r.provenance : null, r.runtime?.latest ? `${r.runtime.name} ${r.runtime.latest.tag}` : r.statusNote, r.status].filter(Boolean).join(" · ")}</small></div>
          {r.link && <a className="ibtn" href={r.link} target="_blank" rel="noreferrer" title="Open"><Icon name="external" size={16} /></a>}
        </div>
      ))}
    </div>
  );
}

export function GamePage() {
  const { id } = useParams();
  const gid = Number(id);
  const { item: g, error } = useGame(gid);
  const { item: app } = useApp(g?.steamAppId ?? null);
  const L = useLauncher();
  if (error) return <div className="body"><Empty title="That game is not on your server" icon="alert">{error}<Link className="btn" to="/library">Back to the library</Link></Empty></div>;
  if (!g) return <div className="body"><Spin /></div>;
  const inst = g.file ? L.installedFor(g.id, g.file.id) : undefined;
  const prog = g.file ? L.installs[g.file.id] : undefined;
  const j = journeyOf(g, inst, prog);
  const tone = j.stage === "installed" || j.stage === "ready" ? "ok" : j.active ? "lamp" : j.stage === "failed" ? "bad" : "";
  const panelTitle = j.stage === "installed" ? "On this PC" : j.stage === "ready" ? "Ready to install" : j.active ? "On its way" : j.stage === "waiting" ? "Not out yet" : j.stage === "failed" ? "Didn't make it" : "Not on your server";
  const note = j.stage === "ready" ? `${fmtSize(g.file?.size)} prepared on your server. Install puts it on this PC and checks every file.`
    : j.stage === "installed" ? `Installed here${inst?.launch.exe ? `, launches ${inst.launch.exe}` : ""}.`
    : j.active ? `${j.label}: ${j.detail || "working on it"}.`
    : j.stage === "waiting" ? (g.tracked ? `Tracked. Ahoy requests it on ${releaseLine(g) ?? "release day"}.` : `Out ${releaseLine(g) ?? "later"}. Track it and Ahoy gets it on release day.`)
    : j.stage === "failed" ? `${j.detail || "Nothing usable was found"}. Try again later, or watch the indexers in ludarr.`
    : g.monitored ? "Ahoy keeps looking and takes it the moment a copy appears." : "Press Get it and Ahoy finds it, prepares it and brings it here. Nothing to choose.";
  const about = plainText(app?.about, 1600).length ? plainText(app?.about, 1600) : plainText(g.summary, 1600);
  return (
    <div className="gpage">
      <Backdrop image={art.banner(g.id)} trailer={app?.trailers[0] ?? null} />
      <div className="gbody">
        <div>
          <h1>{g.name}{g.releaseYear ? <span className="year">{g.releaseYear}</span> : null}</h1>
          <div className="line">
            <span className={`status ${tone}`}>{j.label}</span>
            {g.file && <span className="mono">{fmtSize(g.file.size)}{g.file.version && g.file.version !== "unknown" ? ` · v${g.file.version}` : ""}{g.file.format && g.file.format !== "unknown" ? ` · ${g.file.format}` : ""}</span>}
            {g.developer && <span>{g.developer}</span>}
            {g.genres.length > 0 && <span>{g.genres.slice(0, 3).join(", ")}</span>}
          </div>
          <div className="acts"><Actions game={g} lg /></div>
          <div className="note"><span className={`status ${tone}`}>{note}</span></div>
          <Media app={app} shots={g.screenshots} />
          {about.length > 0 && <div className="about">{about.map((p, i) => <p key={i}>{p}</p>)}</div>}
          <Ways g={g} />
          <p className="advanced">Files, history and search details: <a href={`${location.origin}/games/${g.id}`} target="_blank" rel="noreferrer">open this game in ludarr</a></p>
        </div>
        <aside className="side">
          <div className="panel">
            <h3>{panelTitle}</h3>
            <JourneyLine j={j} />
            {j.active && j.detail && <p>{j.detail}</p>}
          </div>
          <Facts items={[
            ["Release", releaseLine(g) ?? g.releaseYear],
            ["Developer", g.developer], ["Publisher", g.publisher],
            ["Genres", g.genres.join(", ")],
            ["Protection", g.drm ? `${g.drm}${crackWord(g.crackStatus) ? ` · ${crackWord(g.crackStatus)}` : ""}` : null],
            ["Platforms", g.platforms.map(p => (p === "win" ? "Windows" : p)).join(", ")],
            ["Steam", g.steamAppId ? <a href={steamStore(g.steamAppId)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>Store page<Icon name="external" size={14} style={{ color: "var(--fg-3)" }} /></a> : null],
          ]} />
        </aside>
      </div>
      <Similar appId={g.steamAppId} />
    </div>
  );
}

export function SteamPage() {
  const { appId } = useParams();
  const id = Number(appId);
  const { item: a, error } = useApp(id);
  if (error) return <div className="body"><Empty title="Steam does not know that one" icon="alert">{error}<Link className="btn" to="/discover">Back to Discover</Link></Empty></div>;
  if (!a) return <div className="body"><Spin /></div>;
  if (a.gameId != null) return <Navigate to={`/game/${a.gameId}`} replace />;
  const av = availabilityOf(a);
  const blocked = a.crackStatus === "uncracked" || a.crackStatus === "hypervisor";
  const note = a.comingSoon ? `Out ${releaseLine(a) ?? "later"}. Track it and Ahoy gets it on release day.`
    : blocked ? `${a.drm ?? "Its protection"} has not been made playable yet. Watch for it and Ahoy gets it the moment that changes.`
    : a.crackStatus === "cracked" ? "Available. Ahoy finds it, prepares it and installs it here. Nothing to choose."
    : "Press Get it and Ahoy looks for a copy, prepares it and brings it here.";
  const j = journeyOf(null);
  const about = plainText(a.about, 1400).length ? plainText(a.about, 1400) : a.summary ? [a.summary] : [];
  return (
    <div className="gpage">
      <Backdrop image={a.hero ? art.proxy(a.hero) : steamBanner(a.appId)} trailer={a.trailers[0] ?? null} />
      <div className="gbody">
        <div>
          <h1>{a.name}</h1>
          <div className="line">
            {a.reviewSummary && <span><b>{sentence(a.reviewSummary.toLowerCase())}</b>{a.reviewPct != null ? ` · ${a.reviewPct}% of reviews` : ""}</span>}
            {releaseLine(a) && <span>{releaseLine(a)}</span>}
            {a.developers.length > 0 && <span>{a.developers.slice(0, 2).join(", ")}</span>}
            {a.genres.length > 0 && <span>{a.genres.slice(0, 3).join(", ")}</span>}
          </div>
          <div className="acts"><Actions app={a} lg /></div>
          <div className="note"><span className={`status ${av.dot === "muted" ? "" : av.dot}`}>{note}</span></div>
          <Media app={a} shots={[]} />
          {about.length > 0 && <div className="about">{about.map((p, i) => <p key={i}>{p}</p>)}</div>}
        </div>
        <aside className="side">
          <div className="panel">
            <h3>On its way</h3>
            <JourneyLine j={j} />
            <p>{a.comingSoon ? `Not out yet${releaseLine(a) ? `, due ${releaseLine(a)}` : ""}.` : "Not started. Press Get it and you can watch it travel here."}</p>
          </div>
          <Facts items={[
            ["Release", releaseLine(a)],
            ["Publisher", a.publishers.slice(0, 2).join(", ")],
            ["Protection", a.drm ? `${a.drm}${crackWord(a.crackStatus) ? ` · ${crackWord(a.crackStatus)}` : ""}` : null],
            ["Reviews", a.reviewCount != null ? a.reviewCount.toLocaleString() : null],
            ["Metacritic", a.metacritic],
            ["Steam", <a href={steamStore(a.appId)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>Store page<Icon name="external" size={14} style={{ color: "var(--fg-3)" }} /></a>],
          ]} />
        </aside>
      </div>
      <Similar appId={a.appId} />
    </div>
  );
}

export { shortDate };
