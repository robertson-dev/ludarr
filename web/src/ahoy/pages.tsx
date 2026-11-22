/** Ahoy — Home, Discover, Library, Search, Downloads, Settings. */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fmtSize, timeAgo, type DiscoverItem, type Game, type LookupHit } from "../api";
import { Icon } from "../ui/icons";
import { Art, art, hitArt } from "../ui/art";
import { Modal, useUi } from "../ui/kit";
import { useLauncher } from "../launcher-state";
import { launcher, type LauncherConfig } from "../launcher";
import { act, useApp, useBest, useBestLists, useDiscover, useGenre, useGenres, useLib, useLookup, usePlayable } from "./data";
import { availabilityOf, isActive, journeyOf, shortDate } from "./model";
import { Actions, BestCard, Card, CardRow, DiscoverCard, Empty, HitCard, JourneyLine, LibCard, Reel, Spin, isGameHit } from "./parts";

/* ─────────── Home ─────────── */

function NowStrip() {
  const lib = useLib();
  const L = useLauncher();
  const installs = Object.values(L.installs);
  const moving = lib.games.filter(isActive);
  const total = installs.length + moving.length;
  if (!total) return null;
  const p = installs[0];
  const g = p ? lib.games.find(x => x.file?.id === p.packageId) ?? null : moving[0];
  const j = journeyOf(g, undefined, p);
  const name = p?.name ?? g?.name ?? "";
  const gameId = p?.gameId ?? g?.id ?? null;
  return (
    <div className="now">
      {gameId != null ? <Link to={`/game/${gameId}`}><Art className="thumb" src={art.poster(gameId)} title={name} /></Link> : <span className="thumb" />}
      <div className="what"><b>{gameId != null ? <Link to={`/game/${gameId}`}>{name}</Link> : name}</b><span>{j.label}{j.detail ? ` · ${j.detail}` : ""}</span></div>
      <div className="route"><JourneyLine j={j} /></div>
      {total > 1 && <Link className="more" to="/downloads">+{total - 1} more</Link>}
      {p ? <button className="btn quiet" onClick={() => void L.cancelInstall(p.packageId)}>Cancel</button> : <Link className="btn quiet" to="/downloads">Details</Link>}
    </div>
  );
}

function Hero({ g, arrived }: { g: Game; arrived: boolean }) {
  const when = g.file?.addedAt ? timeAgo(g.file.addedAt) : null;
  const line = [g.file ? fmtSize(g.file.size) : null, g.releaseYear, g.developer, g.genres.slice(0, 3).join(", ")].filter(Boolean).join(" · ");
  const { item: app } = useApp(g.steamAppId ?? null);
  const trailer = app?.trailers[0] ?? null;
  const [live, setLive] = useState(false);
  // the banner endpoint falls back to the cover when a game has no wide art: measure what actually comes back
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    setWide(null); setLive(false);
    const img = new Image();
    img.onload = () => setWide(img.naturalWidth > img.naturalHeight * 1.3);
    img.onerror = () => setWide(false);
    img.src = art.banner(g.id);
  }, [g.id]);
  if (wide == null) return <section className="hero" />;
  return (
    <section className={`hero${wide ? "" : " noart"}`} style={wide ? { backgroundImage: `url(${art.banner(g.id)})` } : undefined}>
      {!wide && <><img className="blur" src={art.poster(g.id)} alt="" /><img className="box" src={art.poster(g.id)} alt="" /></>}
      {trailer && wide && <Reel t={trailer} poster={art.banner(g.id)} className={`reel${live ? " live" : ""}`} onReady={() => setLive(true)} />}
      <div className="in">
        <div className="eyebrow"><span className={`status${arrived ? " ok" : ""}`}>{arrived && when ? `Arrived on your server ${when}` : g.file ? "On your server" : journeyOf(g).label}</span></div>
        <h1>{g.name}</h1>
        {line && <div className="line">{line}</div>}
        <div className="acts"><Actions game={g} lg /><Link className="btn lg quiet" to={`/game/${g.id}`}>Details</Link></div>
      </div>
    </section>
  );
}

export function Home() {
  const lib = useLib();
  const L = useLauncher();
  const { section } = useDiscover();
  const here = (g: Game) => (g.file ? L.installedFor(g.id, g.file.id) : undefined);
  const ready = useMemo(() => lib.games.filter(g => g.status === "available" && !here(g)).sort((a, b) => (b.file?.addedAt ?? 0) - (a.file?.addedAt ?? 0)), [lib.games, L.installed]);
  const installed = useMemo(() => lib.games.filter(g => here(g)), [lib.games, L.installed]);
  const hero = ready[0] ?? [...lib.games].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))[0];
  const fresh = !!(hero?.file?.addedAt && Date.now() / 1000 - hero.file.addedAt < 7 * 86_400);
  if (!lib.loaded) return <div className="body"><Spin /></div>;
  return (
    <div className="body">
      <NowStrip />
      {hero ? <Hero g={hero} arrived={fresh} /> : (
        <Empty title="Nothing on your server yet" icon="compass">Find a game under Discover and press Get it. It arrives here, prepared, ready to install.<Link className="btn primary" to="/discover">Open Discover</Link></Empty>
      )}
      {ready.length > 0 && <CardRow title="Ready to install" count={ready.length} sub="on your server, one click away" more="/library"><div className="cards">{ready.slice(0, 8).map(g => <LibCard key={g.id} g={g} />)}</div></CardRow>}
      {installed.length > 0 && <CardRow title="On this PC" count={installed.length} more="/library"><div className="cards">{installed.slice(0, 8).map(g => <LibCard key={g.id} g={g} />)}</div></CardRow>}
      {section("coming_soon").length > 0 && <CardRow title="Coming soon" sub="track one and Ahoy gets it on release day" more="/discover"><div className="cards">{section("coming_soon").slice(0, 8).map(i => <DiscoverCard key={i.appId} item={i} />)}</div></CardRow>}
      {section("new").length > 0 && <CardRow title="New & trending" sub="out in the last three months and climbing" more="/discover"><div className="cards">{section("new").slice(0, 8).map(i => <DiscoverCard key={i.appId} item={i} />)}</div></CardRow>}
      <HomeBest />
    </div>
  );
}

/** the all-time list, eight wide: the games worth having that were never "new" while you were looking */
function HomeBest() {
  const { list } = useBest("all");
  if (!list?.items.length) return null;
  return <CardRow title="Highest rated of all time" sub="by Metacritic" more="/discover"><div className="cards">{list.items.slice(0, 8).map(i => <BestCard key={i.appId} item={i} />)}</div></CardRow>;
}

/* ─────────── Discover ─────────── */

type Lens = "all" | "available" | "soon";
function Ranked({ items }: { items: DiscoverItem[] }) {
  const lib = useLib();
  return (
    <div className="ranked">{items.map((i, n) => {
      const g = (i.gameId != null ? lib.byId.get(i.gameId) : undefined) ?? lib.byApp.get(i.appId);
      const a = g ? { text: journeyOf(g).label, dot: g.status === "available" ? "ok" as const : isActive(g) ? "lamp" as const : "muted" as const } : availabilityOf(i);
      const sub = [a.text, i.reviewSummary].filter(Boolean).join(" · ");
      return (
        <Link key={i.appId} to={g ? `/game/${g.id}` : `/steam/${i.appId}`} className="rank">
          <span className="no">{n + 1}</span>
          <img src={i.img || art.steam(i.appId, i.name)} alt="" loading="lazy" />
          <div className="tx"><b>{i.name}</b><span><i className={`dot ${a.dot === "muted" ? "" : a.dot}`} />{sub}</span></div>
        </Link>
      );
    })}</div>
  );
}

/** the one big moment on Discover: a game you can have today, its trailer running quietly */
function Featured({ item }: { item: DiscoverItem }) {
  const { item: app } = useApp(item.appId);
  const [live, setLive] = useState(false);
  const trailer = app?.trailers[0] ?? null;
  const a = availabilityOf(item);
  return (
    <section className="featured" style={{ backgroundImage: `url(${app?.hero ? art.proxy(app.hero) : item.img || ""})` }}>
      {trailer && <Reel t={trailer} className={`reel${live ? " live" : ""}`} onReady={() => setLive(true)} />}
      <div className="in">
        <div className="eyebrow"><span className={`status ${a.dot === "muted" ? "" : a.dot}`}>{a.text}{item.reviewSummary ? ` · ${item.reviewSummary.toLowerCase()}` : ""}</span></div>
        <h1>{item.name}</h1>
        <div className="line">{[app?.developers?.[0], releaseLineOf(item), item.genres.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}</div>
        {item.summary && <p className="blurb">{item.summary}</p>}
        <div className="acts"><Actions app={item} lg /><Link className="btn lg quiet" to={`/steam/${item.appId}`}>Details</Link></div>
      </div>
    </section>
  );
}
const releaseLineOf = (i: DiscoverItem) => shortDate(i.releaseIso) ?? i.releaseText ?? null;

function GenreRows() {
  const genres = useGenres();
  const [tag, setTag] = useState<number | null>(() => Number(localStorage.getItem("ahoy.genre")) || null);
  const current = tag ?? genres[0]?.tag ?? null;
  const { items } = useGenre(current);
  const label = genres.find(g => g.tag === current)?.label ?? "";
  if (!genres.length) return null;
  return (
    <section className="row">
      <div className="rh"><h2>Browse by genre</h2><span className="sub">the store's best sellers, one genre at a time</span></div>
      <div className="chips" style={{ marginBottom: 16 }}>{genres.map(g => <button key={g.tag} className={g.tag === current ? "on" : ""} onClick={() => { setTag(g.tag); localStorage.setItem("ahoy.genre", String(g.tag)); }}>{g.label}</button>)}</div>
      {!items ? <Spin text={`Reading ${label}`} /> : !items.length ? <Empty title={`Nothing in ${label} right now`} /> : <div className="cards" key={current}>{items.map(i => <DiscoverCard key={i.appId} item={i} />)}</div>}
    </section>
  );
}

/** the Metacritic lists: all time, the players' picks, or one year — the games that were never "new" while you were looking */
const RECENT_YEARS = 10;
function BestRows({ keep }: { keep: (i: DiscoverItem) => boolean }) {
  const all = useBestLists();
  const [key, setKey] = useState<string>(() => localStorage.getItem("ahoy.best") || "all");
  const [earlier, setEarlier] = useState(false);
  const { list, error } = useBest(all.length ? key : null);
  if (!all.length) return null;
  const years = all.filter(l => /^\d{4}$/.test(l.key));
  const shown = [...all.filter(l => !/^\d{4}$/.test(l.key)), ...(earlier ? years : years.slice(0, RECENT_YEARS))];
  if (!earlier && !shown.some(l => l.key === key) && all.some(l => l.key === key)) shown.push(all.find(l => l.key === key)!);
  const info = all.find(l => l.key === key) ?? all[0];
  const items = list?.items.filter(keep) ?? null;
  const pick = (k: string) => { setKey(k); localStorage.setItem("ahoy.best", k); };
  return (
    <section className="row">
      <div className="rh"><h2>Highest rated</h2><span className="sub">{info.sub} · Metacritic</span></div>
      <div className="chips" style={{ marginBottom: 16 }}>
        {shown.map(l => <button key={l.key} className={l.key === key ? "on" : ""} onClick={() => pick(l.key)}>{l.label}</button>)}
        {years.length > RECENT_YEARS && <button onClick={() => setEarlier(e => !e)}>{earlier ? "Fewer years" : "Earlier years"}</button>}
      </div>
      {error ? <Empty title="Metacritic did not answer" icon="alert">{error}</Empty>
        : !items ? <Spin text={`Reading ${info.label.toLowerCase()}`} />
        : !items.length ? (list!.pending ? <Spin text={`Matching ${list!.pending} titles to the store`} /> : <Empty title={`Nothing in ${info.label.toLowerCase()} for that filter`} />)
        : <div className="cards" key={key}>{items.map(i => <BestCard key={i.appId} item={i} user={key === "players"} />)}</div>}
      {list && list.pending > 0 && items && items.length > 0 && <p className="hint">Matching {list.pending} more to the store…</p>}
    </section>
  );
}

export function Discover() {
  const { sections, error, section } = useDiscover();
  const { items: playable } = usePlayable();
  const [lens, setLens] = useState<Lens>("all");
  const [q, setQ] = useState("");
  const keep = (i: DiscoverItem) => lens === "all" || (lens === "available" ? i.inLibrary || i.crackStatus === "cracked" : i.comingSoon);
  const term = q.trim();
  const featured = section("new").find(i => i.crackStatus === "cracked" && !i.inLibrary && i.img) ?? section("top").find(i => i.crackStatus === "cracked" && !i.inLibrary && i.img) ?? null;
  return (
    <div className="body">
      <div className="phead">
        <h1>Discover</h1>
        <form className="search" role="search" onSubmit={e => e.preventDefault()}><Icon name="search" size={18} /><input value={q} placeholder="Search any game, on any platform" aria-label="Search" onChange={e => setQ(e.target.value)} /></form>
        <div className="chips right">
          <button className={lens === "all" ? "on" : ""} onClick={() => setLens("all")}>Everything</button>
          <button className={lens === "available" ? "on" : ""} onClick={() => setLens("available")}>Available today</button>
          <button className={lens === "soon" ? "on" : ""} onClick={() => setLens("soon")}>Coming soon</button>
        </div>
      </div>
      {term ? <SearchResults term={term} /> : error ? <Empty title="The storefront did not answer" icon="alert">{error}</Empty> : !sections ? <Spin text="Reading the storefront" /> : <>
        {featured && lens !== "soon" && <Featured item={featured} />}
        {lens !== "soon" && playable && playable.length > 0 && <CardRow title="Just became playable" sub="protection broken lately, newest first"><div className="cards">{playable.map(i => <DiscoverCard key={i.appId} item={i} />)}</div></CardRow>}
        {section("new").filter(keep).length > 0 && <CardRow title="New & trending" sub="out in the last three months and climbing"><div className="cards">{section("new").filter(keep).map(i => <DiscoverCard key={i.appId} item={i} />)}</div></CardRow>}
        {section("coming_soon").filter(keep).length > 0 && <CardRow title="Coming soon" sub="track one and Ahoy gets it on release day"><div className="cards">{section("coming_soon").filter(keep).map(i => <DiscoverCard key={i.appId} item={i} />)}</div></CardRow>}
        {lens !== "soon" && <BestRows keep={keep} />}
        {lens === "all" && <GenreRows />}
        {section("top").filter(keep).length > 0 && <CardRow title="Top sellers" sub="what everyone is playing this week"><Ranked items={section("top").filter(keep)} /></CardRow>}
        {sections.every(s => !s.items.filter(keep).length) && <Empty title="Nothing here for that filter" />}
      </>}
    </div>
  );
}

/* ─────────── Search ─────────── */

function Preview({ h, onClose }: { h: LookupHit | null; onClose: () => void }) {
  const { toast } = useUi();
  const lib = useLib();
  const [busy, setBusy] = useState(false);
  const get = async () => {
    if (!h) return;
    setBusy(true);
    try { const r = await act.getHit(h, true); toast("On its way", "success"); await lib.reload(); onClose(); location.hash = ""; window.history.pushState(null, "", `/ahoy/game/${r.item.id}`); window.dispatchEvent(new PopStateEvent("popstate")); }
    catch (e: any) { toast(String(e?.message ?? e), "danger"); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!h} onClose={onClose} title={h?.name ?? ""} foot={<><button className="btn quiet" onClick={onClose}>Close</button><button className="btn primary" disabled={busy} onClick={() => void get()}><Icon name="download" size={16} className="ic" />Get it</button></>}>
      {h && <div style={{ display: "flex", gap: 16 }}>
        <div style={{ width: 120, flex: "none", aspectRatio: "2 / 3", position: "relative", borderRadius: 8, overflow: "hidden", background: "var(--raised)" }}><Art src={hitArt(h)} title={h.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
        <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
          <div className="dim">{[h.year, h.platforms.join(", "), h.source].filter(Boolean).join(" · ")}</div>
          {h.summary && <p style={{ color: "var(--fg-2)" }}>{h.summary.slice(0, 500)}{h.summary.length > 500 ? "…" : ""}</p>}
          <p className="dim">Ahoy finds the best copy, prepares it on your server and shows it under Ready to install.</p>
        </div>
      </div>}
    </Modal>
  );
}

function SearchResults({ term }: { term: string }) {
  const lib = useLib();
  const { hits, error, busy } = useLookup(term);
  const [preview, setPreview] = useState<LookupHit | null>(null);
  const t = term.toLowerCase();
  const mine = lib.games.filter(g => g.name.toLowerCase().includes(t));
  const shown = (hits ?? []).filter(isGameHit).filter(h => h.gameId == null || !mine.some(g => g.id === h.gameId));
  return (
    <>
      {mine.length > 0 && <CardRow title="On your server" count={mine.length}><div className="cards">{mine.map(g => <LibCard key={g.id} g={g} />)}</div></CardRow>}
      {busy && !hits ? <Spin text="Searching Steam and the catalog" /> : error ? <Empty title="Search failed" icon="alert">{error}</Empty> : shown.length ? (
        <CardRow title="Out there" count={shown.length} sub="Steam, IGDB and the console catalog"><div className="cards">{shown.map(h => <HitCard key={`${h.id.scheme}:${h.id.value}`} h={h} onPreview={setPreview} />)}</div></CardRow>
      ) : hits && !mine.length ? <Empty title={`Nothing called “${term}”`} icon="search">Try another spelling, or the original title.</Empty> : null}
      <Preview h={preview} onClose={() => setPreview(null)} />
    </>
  );
}

export function SearchPage() {
  const [params] = useSearchParams();
  const term = (params.get("q") ?? "").trim();
  return (
    <div className="body">
      <div className="phead"><h1>{term ? `“${term}”` : "Search"}</h1></div>
      {term ? <SearchResults term={term} /> : <Empty title="Type a name in the box above" icon="search" />}
    </div>
  );
}

/* ─────────── Library ─────────── */

type Shelf = "all" | "here" | "ready" | "way" | "soon";
export function Library() {
  const lib = useLib();
  const L = useLauncher();
  const [shelf, setShelf] = useState<Shelf>(() => (localStorage.getItem("ahoy.shelf") as Shelf) || "all");
  const pick = (s: Shelf) => { setShelf(s); localStorage.setItem("ahoy.shelf", s); };
  const here = (g: Game) => (g.file ? !!L.installedFor(g.id, g.file.id) : false);
  const groups = useMemo(() => ({
    all: lib.games, here: lib.games.filter(here), ready: lib.games.filter(g => g.status === "available" && !here(g)),
    way: lib.games.filter(isActive), soon: lib.games.filter(g => g.status === "unreleased"),
  }), [lib.games, L.installed]);
  const items = [...groups[shelf]].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const size = lib.games.reduce((a, g) => a + (g.file?.size ?? 0), 0);
  const chip = (s: Shelf, label: string) => <button className={shelf === s ? "on" : ""} onClick={() => pick(s)}>{label}<i>{groups[s].length}</i></button>;
  return (
    <div className="body">
      <div className="phead"><h1>Library</h1><span className="n">{lib.games.length} games · {fmtSize(size)} on your server</span>
        <div className="chips right">{chip("all", "All")}{L.inLauncher && chip("here", "On this PC")}{chip("ready", "Ready to install")}{chip("way", "On the way")}{chip("soon", "Coming")}</div>
      </div>
      {!lib.loaded ? <Spin /> : !items.length ? <Empty title={shelf === "all" ? "Nothing on your server yet" : "Nothing on this shelf"}>{shelf === "all" && <Link className="btn primary" to="/discover">Open Discover</Link>}</Empty> : <div className="cards wide">{items.map(g => <LibCard key={g.id} g={g} />)}</div>}
    </div>
  );
}

/* ─────────── Downloads ─────────── */

export function Downloads() {
  const lib = useLib();
  const L = useLauncher();
  const { toast } = useUi();
  const installs = Object.values(L.installs);
  const moving = lib.games.filter(isActive);
  const failed = lib.games.filter(g => g.status === "failed");
  const recent = lib.games.filter(g => g.status === "available" && g.file?.addedAt && Date.now() / 1000 - g.file.addedAt < 3 * 86_400).sort((a, b) => (b.file?.addedAt ?? 0) - (a.file?.addedAt ?? 0));
  const cancel = async (g: Game) => { if (!g.request) return; try { await act.cancel(g.request.id); toast("Cancelled", "success"); await lib.reload(); } catch (e: any) { toast(String(e?.message ?? e), "danger"); } };
  const row = (g: Game | null, name: string, gameId: number | null, j: ReturnType<typeof journeyOf>, right: React.ReactNode) => (
    <div className="item" key={`${name}-${gameId}`}>
      {gameId != null ? <Link to={`/game/${gameId}`}><Art className="thumb" src={art.poster(gameId)} title={name} /></Link> : <span className="thumb" />}
      <div className="what"><b>{gameId != null ? <Link to={`/game/${gameId}`}>{name}</Link> : name}</b><span>{j.label}{j.detail ? ` · ${j.detail}` : ""}</span></div>
      <div className="route"><JourneyLine j={j} /></div>
      {right}
    </div>
  );
  return (
    <div className="body">
      <div className="phead"><h1>On the way</h1><span className="n">{installs.length + moving.length} moving</span></div>
      {!installs.length && !moving.length && !failed.length ? <Empty title="Nothing on the way" icon="download">Press Get it on a game, or Install on one that is ready.</Empty> : (
        <div className="list">
          {installs.map(p => { const g = lib.games.find(x => x.file?.id === p.packageId) ?? null; return row(g, p.name, p.gameId ?? g?.id ?? null, journeyOf(g, undefined, p), <button className="btn quiet" onClick={() => void L.cancelInstall(p.packageId)}>Cancel</button>); })}
          {moving.map(g => row(g, g.name, g.id, journeyOf(g), <button className="btn quiet" onClick={() => void cancel(g)}>Cancel</button>))}
          {failed.map(g => row(g, g.name, g.id, journeyOf(g), <Actions game={g} />))}
        </div>
      )}
      {recent.length > 0 && <CardRow title="Arrived lately" sub="ready to install"><div className="cards">{recent.map(g => <LibCard key={g.id} g={g} />)}</div></CardRow>}
    </div>
  );
}

/* ─────────── Settings ─────────── */

export function Settings() {
  const { toast, confirm } = useUi();
  const L = useLauncher();
  const [cfg, setCfg] = useState<LauncherConfig | null>(null);
  const load = () => launcher?.config().then(setCfg).catch(() => {});
  useEffect(() => { void load(); }, []);
  const save = async (patch: Parameters<NonNullable<typeof launcher>["setConfig"]>[0]) => {
    const r = await launcher!.setConfig(patch);
    if (r.ok) { toast("Saved", "success"); void load(); } else toast(r.error ?? "could not save", "danger");
  };
  const origin = location.origin;
  return (
    <div className="body narrow">
      <div className="phead"><h1>Settings</h1></div>
      {!launcher ? <p className="dim">You are looking at Ahoy in a browser. Installing and playing need the Ahoy launcher, a small app for your PC: get it from <a href={`${origin}/settings/general`} target="_blank" rel="noreferrer" style={{ color: "var(--fg)" }}>ludarr, Settings → General</a>.</p> : !cfg ? <Spin /> : <>
        <div className="section-title">This PC</div>
        <div className="srow"><label>Server</label><div className="v"><span className="mono">{cfg.serverUrl}</span></div></div>
        <div className="srow"><label>Install games into</label><div className="v"><span className="mono">{cfg.libraryDir}</span><button className="btn" onClick={() => void launcher!.pickDir().then(d => { if (d) void save({ libraryDir: d }); })}>Change…</button></div></div>
        <div className="srow"><label>Desktop shortcuts</label><div className="v"><button role="switch" aria-checked={cfg.desktopShortcuts} className={`toggle${cfg.desktopShortcuts ? " on" : ""}`} onClick={() => void save({ desktopShortcuts: !cfg.desktopShortcuts })} /><span className="dim">a shortcut for every game installed here</span></div></div>
        <div className="srow"><label>Launcher</label><div className="v"><span className="dim">Ahoy {cfg.version} · {cfg.platform}</span></div></div>
        <div className="srow"><label>Sign out</label><div className="v"><button className="btn" onClick={async () => { if (await confirm("Sign out?", "The launcher forgets this server and shows the setup page again. Installed games stay on disk.", { ok: "Sign out", kind: "primary" })) void save({ serverUrl: "", apiKey: "", user: "", pass: "" }); }}>Sign out</button></div></div>
        {L.installed.length > 0 && <>
          <div className="section-title">On this PC</div>
          <div className="list" style={{ marginTop: 12 }}>{L.installed.map(g => (
            <div className="item" key={g.slug}>
              {g.gameId != null ? <Link to={`/game/${g.gameId}`}><Art className="thumb" src={art.poster(g.gameId)} title={g.name} /></Link> : <span className="thumb" />}
              <div className="what"><b>{g.gameId != null ? <Link to={`/game/${g.gameId}`}>{g.name}</Link> : g.name}</b><span className="mono">{fmtSize(g.sizeBytes)}{g.version ? ` · v${g.version}` : ""}{g.kind === "rom" ? ` · ${g.platform ?? "console"} dump` : ""}</span></div>
              <span className="dim mono" style={{ marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>{g.path}</span>
              <button className="btn quiet" onClick={() => void L.openFolder(g.slug)}>Open folder</button>
              <button className="btn quiet danger" onClick={async () => { if (await confirm(`Uninstall ${g.name}?`, <>The folder <code>{g.path}</code> is deleted from this PC. The copy on your server stays.</>, { ok: "Uninstall" })) void L.uninstall(g.slug); }}>Uninstall</button>
            </div>
          ))}</div>
        </>}
      </>}
      <div className="section-title">Advanced</div>
      <p className="dim" style={{ marginTop: 8 }}>Everything else, from indexers to download clients, lives in ludarr, the server behind Ahoy. <a href={`${origin}/`} target="_blank" rel="noreferrer" style={{ color: "var(--fg)" }}>Open ludarr</a></p>
    </div>
  );
}

export { shortDate };
