/** One game: hero, actions (search, interactive search, upload, edit, details, art, delete), files, history, imports, ways to play. */
import { useEffect, useState } from "react";
import { useLauncher, fmtRate } from "../launcher-state";
import { PHASE_LABEL } from "../launcher";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { del, get, post, put, fmtSize, fmtDate, timeAgo, sentence, type GameDetail, type Profile, type Release, type ReleaseSearch, type RootFolder, type Way } from "../api";
import { useEvents } from "../events";
import { Icon } from "../ui/icons";
import { Btn, Empty, IconBtn, Label, Modal, Progress, Row, Spinner, Tabs, ToolbarBtn, useLoad, useUi } from "../ui/kit";
import { EVENT_ICON, EVENT_TONE, JOB_KIND, STATUS, jobState, statusLabel, statusTone, crackLabel, CRACK_TONE } from "../ui/status";
import { Art, art } from "../ui/art";
import { ReleaseTable, SearchSummary } from "../ui/releases";
import { JobLogModal } from "../ui/job-log";
import { WaysTab } from "./game-ways";
import { ArtModal, EditDetailsModal } from "./game-details";
import { StartsWith } from "../ui/launch-editor";
import { GameUploads, UploadModal, useFileDragOpens } from "../ui/upload";
import { jobBy, jobEnd, platformLabel } from "../ways/logic";

function UseDownload({ gameId, ways, onClose, onQueued }: { gameId: number; ways: Way[]; onClose: () => void; onQueued: (id: number) => void }) {
  type Entry = { id: number; title: string; path: string; reason: string | null; size: number | null };
  const { data, loading, error } = useLoad(() => get<{ items: Entry[] }>(`/api/v1/game/${gameId}/downloads`), [gameId]);
  const [way, setWay] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  async function use(id: number) {
    setBusy(id); setProblem("");
    try { const job = await post<{ jobId: number }>(`/api/v1/game/${gameId}/downloads/${id}/use`, { wayId: way ? Number(way) : null }); onQueued(job.jobId); }
    catch (e: any) { setProblem(e.message); } finally { setBusy(null); }
  }
  return <Modal open onClose={onClose} title="Use a download">
    <Row label="Use for"><select className="input" value={way} onChange={e => setWay(e.target.value)}><option value="">Regular import</option>
      {ways.filter(w => w.content).map(w => <option key={w.id} value={w.id}>{w.planName ?? w.plan?.name ?? `Way #${w.id}`}</option>)}</select></Row>
    {error || problem ? <p role="alert">{problem || String(error)}</p> : null}
    {loading ? <Spinner /> : !data?.items.length ? <p>No completed downloads recorded for this game.</p> :
      data.items.map(f => <div className="row" key={f.id}><div><strong>{f.title}</strong><div className="mono dim">{f.path}</div>
        {f.reason && <div>{f.reason}</div>}</div><Btn busy={busy === f.id} disabled={busy !== null} onClick={() => void use(f.id)}>Use this download</Btn></div>)}
  </Modal>;
}

export function InteractiveSearch({ gameId, name, open, onClose }: { gameId: number; name: string; open: boolean; onClose: () => void }) {
  const { toast } = useUi();
  const [loose, setLoose] = useState(false);
  const [grabbing, setGrabbing] = useState<string | null>(null);
  const { data, loading, error, reload } = useLoad(() => open ? get<ReleaseSearch>(`/api/v1/release?gameId=${gameId}${loose ? "&loose=1" : ""}&limit=100`) : Promise.resolve(null), [open, gameId, loose]);
  const grab = async (r: Release) => {
    setGrabbing(r.guid);
    try { await post("/api/v1/release", { guid: r.guid, instanceId: r.instanceId, gameId }); toast(<>Grabbed <b>{r.title}</b></>, "success"); onClose(); }
    catch (e: any) { toast(e.message, "danger"); } finally { setGrabbing(null); }
  };
  return (
    <Modal open={open} onClose={onClose} title={<>Interactive search — {name}</>} wide
      foot={<><span className="left">{data && <SearchSummary data={data} />}</span>
        <label className="check"><input type="checkbox" checked={loose} onChange={e => setLoose(e.target.checked)} /> show everything the indexers returned</label><Btn onClick={() => void reload()} icon="refresh">Search again</Btn><Btn onClick={onClose}>Close</Btn></>}>
      {loading ? <Spinner text="Asking the indexers…" /> : error ? <Empty title="Search failed" icon="alert">{error}</Empty> : !data?.items.length ? <Empty title="Nothing found" icon="search">No release matched. Try the loose search to see everything the indexers returned.</Empty> : (
        <ReleaseTable items={data.items} name={name} onGrab={r => void grab(r)} grabbing={grabbing} />
      )}
    </Modal>
  );
}

function EditModal({ g, open, onClose, onSaved }: { g: GameDetail; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const { data: profiles } = useLoad(() => get<{ items: Profile[] }>("/api/v1/profile"), []);
  const { data: roots } = useLoad(() => get<{ items: RootFolder[] }>("/api/v1/rootfolder"), []);
  const [form, setForm] = useState({ monitored: g.monitored, profileId: g.profile?.id ?? 0, rootFolderId: g.rootFolder?.id ?? 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setForm({ monitored: g.monitored, profileId: g.profile?.id ?? 0, rootFolderId: g.rootFolder?.id ?? 0 }); }, [g, open]);
  const save = async () => {
    setBusy(true);
    try { await put(`/api/v1/game/${g.id}`, { monitored: form.monitored, profileId: form.profileId || null, rootFolderId: form.rootFolderId || null }); toast("Saved", "success"); onSaved(); onClose(); }
    catch (e: any) { toast(e.message, "danger"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={<>Edit — {g.name}</>} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" busy={busy} onClick={save}>Save</Btn></>}>
      <Row label="Monitored" help="Monitored games are searched automatically and picked up on release day."><label className="check"><input type="checkbox" checked={form.monitored} onChange={e => setForm({ ...form, monitored: e.target.checked })} /> monitored</label></Row>
      <Row label="Profile"><select className="select" value={form.profileId} onChange={e => setForm({ ...form, profileId: Number(e.target.value) })}>{(profiles?.items ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Row>
      <Row label="Root folder"><select className="select" value={form.rootFolderId} onChange={e => setForm({ ...form, rootFolderId: Number(e.target.value) })}>{(roots?.items ?? []).map(r => <option key={r.id} value={r.id}>{r.path}</option>)}</select></Row>
    </Modal>
  );
}

/** the launcher's buttons for this game: Install while there is a copy on the server, then Play / Uninstall / Open folder */
function LauncherButtons({ g }: { g: GameDetail }) {
  const L = useLauncher();
  const { confirm } = useUi();
  if (!g.file) return null;
  const inst = L.installedFor(g.id, g.file.id);
  const prog = L.installs[g.file.id];
  const rom = g.file.format === "rom";
  if (!L.inLauncher) return <><ToolbarBtn data-primary="" icon="download" label="Install" disabled title="installing happens in Ahoy, the player-facing app in front of ludarr" /><span className="sep" /></>;
  if (prog) return <><ToolbarBtn data-primary="" icon="spinner" label={`${PHASE_LABEL[prog.phase]} ${Math.round(prog.progress * 100)}%`} disabled /><ToolbarBtn icon="x" label="Cancel" onClick={() => void L.cancelInstall(g.file!.id)} /><span className="sep" /></>;
  if (inst) {
    const running = !!L.playing[inst.slug];
    return <>
      {rom || inst.kind === "rom" ? <ToolbarBtn data-primary="" icon="box" label={`${inst.platform ?? "console"} dump installed`} disabled title="nothing a PC can launch — an emulator has to open it" />
        : <ToolbarBtn data-primary="" icon="play" label={running ? "Running…" : "Play"} disabled={running} onClick={() => void L.play(inst.slug)} />}
      <ToolbarBtn icon="folder" label="Open folder" onClick={() => void L.openFolder(inst.slug)} />
      {inst.packageId !== g.file.id && <ToolbarBtn icon="refresh" label="Update" title="a newer copy is on the server" onClick={() => void L.install(g.file!.id)} />}
      <ToolbarBtn icon="trash" label="Uninstall" onClick={async () => { if (await confirm(`Uninstall ${g.name}?`, <>The folder <code>{inst.path}</code> is deleted from this PC.</>, { ok: "Uninstall" })) void L.uninstall(inst.slug); }} />
      <span className="sep" />
    </>;
  }
  return <><ToolbarBtn data-primary="" icon="download" label={rom ? "Install dump" : "Install"} onClick={() => void L.install(g.file!.id)} /><span className="sep" /></>;
}
/** the hero line: install progress, or what is installed here */
function LauncherLine({ g }: { g: GameDetail }) {
  const L = useLauncher();
  if (!L.inLauncher || !g.file) return null;
  const prog = L.installs[g.file.id];
  if (prog) return <span style={{ minWidth: 260 }}><Progress value={prog.progress} tone="accent" text={`${PHASE_LABEL[prog.phase]} ${Math.round(prog.progress * 100)}%${prog.rate ? ` · ${fmtRate(prog.rate)}` : ""}${prog.message ? ` · ${prog.message}` : ""}`} /></span>;
  const inst = L.installedFor(g.id, g.file.id);
  if (inst) return <Label tone={L.playing[inst.slug] ? "success" : "accent"}>{L.playing[inst.slug] ? "playing" : "installed on this PC"}</Label>;
  return null;
}

/** the game's jobs of every kind; who did the work says the AI importer only for a run that used it, and a game file kept
 *  that is not the one its way needs reads as a warning (the message, cut short here, says why) */
export function JobsTable({ jobs, onLog }: { jobs: GameDetail["jobs"]; onLog: (id: number) => void }) {
  return (
    <div className="table-wrap"><table className="table jobs"><thead><tr><th>#</th><th>Kind</th><th>State</th><th>By</th><th>Message</th><th>Started</th><th className="actions"></th></tr></thead>
      <tbody>{jobs.map(j => {
        const kind = j.kind ?? "import", by = jobBy(kind, j.tier), misfit = jobEnd(j) === "warn";
        return (
          <tr key={j.id}><td>{j.id}</td><td className="nowrap">{JOB_KIND[kind] ?? kind}</td>
            <td>{misfit ? <Label tone="warning">{j.state} · does not fit</Label> : <Label tone={jobState(j.state).tone}>{j.state}</Label>}</td>
            <td className="nowrap">{by ?? <span className="dim">—</span>}</td>
            <td className="ellipsis msg" title={j.message ?? undefined}>{j.message?.split("\n")[0]}</td><td className="dim nowrap">{timeAgo(j.createdAt)}</td>
            <td className="actions"><Btn size="sm" icon="terminal" onClick={() => onLog(j.id)}>Log</Btn></td></tr>
        );
      })}</tbody></table></div>
  );
}

/** what made a copy, in words: the import tiers, or a way to play */
const madeBy = (importer: string | null | undefined, kind: string | undefined) =>
  kind && kind !== "native" && kind !== "rom" ? "a way to play" : importer === "agent" ? "the AI importer" : "the automatic recipes";
const TABS = ["overview", "files", "history", "imports", "ways"];

export function GamePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { toast, confirm } = useUi();
  const gid = Number(id);
  const { data, loading, error, reload } = useLoad(() => get<{ item: GameDetail }>(`/api/v1/game/${gid}`), [gid]);
  const { data: profiles } = useLoad(() => get<{ items: Profile[] }>("/api/v1/profile"), []);
  const { data: waysData, reload: reloadWays } = useLoad(() => get<{ items: Way[]; research?: { platform: string; reason: string; link?: string }[] }>(`/api/v1/game/${gid}/ways`), [gid]);
  useEvents(["request", "job", "package", "game", "fetch"], () => void reload());
  const asked = params.get("tab") ?? "";
  const [tab, setTabState] = useState(TABS.includes(asked) ? asked : "overview");
  useEffect(() => { if (TABS.includes(asked)) setTabState(asked); }, [asked]);
  const setTab = (t: string) => { setTabState(t); const p = new URLSearchParams(params); if (t === "overview") p.delete("tab"); else p.set("tab", t); setParams(p, { replace: true }); };
  const [search, setSearch] = useState(false);
  const [edit, setEdit] = useState(false);
  const [details, setDetails] = useState(false);
  const [artOpen, setArtOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [useOpen, setUseOpen] = useState(false);
  // the game's files dragged onto its page: the upload dialog opens and takes the drop
  useFileDragOpens(() => setUploadOpen(true));
  const [logId, setLogId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const g = data?.item;
  if (loading && !g) return <div className="content"><Spinner /></div>;
  if (!g) return <div className="content"><Empty title="Game not found" icon="alert">{error}</Empty></div>;
  const st = STATUS[g.status];
  const manual = g.source === "manual";
  const ways = waysData?.items ?? null;
  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    try { await fn(); if (ok) toast(ok, "success"); void reload(); } catch (e: any) { toast(e.message, "danger"); } finally { setBusy(null); }
  };
  const remove = async () => {
    let files = false;
    const ok = await confirm(`Delete ${g.name}?`, <>
      <p>The game is removed from the library{g.file ? " and its history" : ""}{ways?.length ? `, with its ${ways.length === 1 ? "way" : "ways"} to play` : ""}.</p>
      {g.file && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" onChange={e => { files = e.target.checked; }} /> also delete the files ({fmtSize(g.file.size)} in <code>{g.file.path}</code>)</label>}
    </>);
    if (!ok) return;
    try { await del(`/api/v1/game/${g.id}?deleteFiles=${files ? 1 : 0}`); toast(`Deleted ${g.name}`, "success"); nav("/games"); } catch (e: any) { toast(e.message, "danger"); }
  };
  const inFlight = g.request && ["requested", "matching", "fetching", "processing"].includes(g.request.state);
  // with a copy on disk a search is an upgrade search, which only makes sense when the profile allows upgrades
  const upgradesOn = !!profiles?.items.find(p => p.id === g.profile?.id)?.upgrade;
  const searchLabel = g.hasFile ? "Search for upgrade" : "Search";
  const searchBlocked = g.hasFile && !upgradesOn;
  const v = g.customArtAt;
  const heroImg = g.customArt.includes("hero") ? art.hero(g.id, v) : art.banner(g.id, v);
  const waysCount = ways?.length ? ways.length : g.routes.filter(r => r.source !== "custom").length;
  return (
    <>
      <div className="toolbar">
        <div className="tb-left">
          <LauncherButtons g={g} />
          {!manual && <><ToolbarBtn icon="refresh" label="Refresh" busy={busy === "refresh"} onClick={() => void act("refresh", () => post(`/api/v1/game/${g.id}/refresh`), "Metadata and art refreshed")} /><span className="sep" /></>}
          <ToolbarBtn icon="search" label={searchLabel} busy={busy === "search"} disabled={!!inFlight || searchBlocked} title={searchBlocked ? "upgrades are off in this profile" : undefined}
            onClick={() => void act("search", () => post(`/api/v1/game/${g.id}/search`), g.hasFile ? "Searching for an upgrade" : "Search started")} />
          <ToolbarBtn icon="folder" label="Use a download" onClick={() => setUseOpen(true)} />
          <ToolbarBtn icon="wand" label="Interactive Search" onClick={() => setSearch(true)} />
          <ToolbarBtn icon="upload" label="Upload" title="Send the game's files from this PC: an archive, an installer with its files, or its folder" onClick={() => setUploadOpen(true)} />
          {inFlight && <ToolbarBtn icon="x" label="Cancel" busy={busy === "cancel"} onClick={() => void act("cancel", () => del(`/api/v1/queue/${g.request!.id}`), "Cancelled")} />}
          <span className="sep" />
          <ToolbarBtn icon="pencil" label="Edit" onClick={() => setEdit(true)} />
          <ToolbarBtn icon="tag" label="Edit Details" onClick={() => setDetails(true)} title={manual ? "Everything about the game" : "The other names it goes by and its search terms"} />
          <ToolbarBtn icon="image" label="Art" onClick={() => setArtOpen(true)} />
          <ToolbarBtn icon="trash" label="Delete" onClick={() => void remove()} />
        </div>
      </div>
      <div className="content">
        <div className="hero" style={{ backgroundImage: `url(${heroImg})` }}>
          <div className="inner">
            <Art className="cover" src={art.poster(g.id, v)} title={g.name} lazy={false} />
            <div className="grow">
              <h1><IconBtn icon={g.monitored ? "bookmark" : "bookmarkOff"} label={g.monitored ? "Unmonitor" : "Monitor"} onClick={() => void act("mon", () => put(`/api/v1/game/${g.id}`, { monitored: !g.monitored }))} />{g.name}{g.releaseYear && <span className="muted" style={{ fontSize: 22 }}>{g.releaseYear}</span>}</h1>
              <div className="line">
                <Label tone={statusTone(g.status)} icon={st?.icon}>{statusLabel(g.status)}</Label>
                <span>{sentence(g.statusDetail)}</span>
                {g.request && inFlight && <span style={{ minWidth: 220 }}><Progress value={g.request.progress} tone="queue" text={`${Math.round(g.request.progress * 100)}% · ${g.request.stage ?? ""}`} /></span>}
                {g.cutoffUnmet && <Label tone="warning">cutoff unmet</Label>}
                {manual && <Label tone="outline">added by hand</Label>}
                <LauncherLine g={g} />
              </div>
              <div className="stats">
                <div><b>Release</b>{g.releaseText || g.releaseIso || g.releaseYear || "—"}</div>
                <div><b>Profile</b>{g.profile?.name ?? "—"}</div>
                <div><b>Root folder</b><span className="mono">{g.rootFolder?.path ?? "—"}</span></div>
                {g.file && <div><b>On disk</b>{fmtSize(g.file.size)}{g.file.format ? ` · ${g.file.format}` : ""}{g.file.version ? ` · v${g.file.version}` : ""}</div>}
                {g.developer && <div><b>Developer</b>{g.developer}</div>}
                {g.publisher && <div><b>Publisher</b>{g.publisher}</div>}
                {g.genres.length > 0 && <div><b>Genres</b>{g.genres.join(", ")}</div>}
                {g.steamAppId && <div><b>Steam</b><a href={`https://store.steampowered.com/app/${g.steamAppId}/`} target="_blank" rel="noreferrer">{g.steamAppId} <Icon name="external" size={12} /></a></div>}
                {g.crackStatus && g.crackStatus !== "untracked" && <div><b>Protection</b>{g.drm ?? "unknown DRM"} · <Label tone={CRACK_TONE[g.crackStatus] ?? "dim"}>{crackLabel(g.crackStatus)}</Label>{g.crackGroup && <> by {g.crackGroup}</>}{g.crackDate && <> on {g.crackDate}</>}{g.crackwatchUrl && <> · <a href={g.crackwatchUrl} target="_blank" rel="noreferrer">CrackWatch <Icon name="external" size={12} /></a></>}</div>}
              </div>
              {g.summary && <div className="summary">{g.summary}</div>}
            </div>
          </div>
        </div>

        <GameUploads g={g} ways={ways} onLog={setLogId} onPick={() => setUploadOpen(true)} />

        <Tabs value={tab} onChange={setTab} items={[{ id: "overview", label: "Overview" }, { id: "files", label: `Files (${g.files.length})` }, { id: "history", label: `History (${g.history.length})` }, { id: "imports", label: `Jobs (${g.jobs.length})` }, { id: "ways", label: `Ways to play (${waysCount})` }]} />

        {tab === "overview" && (
          <div className="kv">
            <dt>Status</dt><dd>{statusLabel(g.status)} — {g.statusDetail}</dd>
            {g.request && <><dt>Last search</dt><dd>{g.request.state} · {g.request.stage}{g.request.message && <span className="dim"> — {g.request.message}</span>}{g.request.release && <div className="dim">{g.request.release.title}</div>}</dd></>}
            <dt>Monitored</dt><dd>{g.monitored ? "Yes" : "No"}{g.tracked && " · tracked for release day"}</dd>
            <dt>Added</dt><dd>{fmtDate(g.addedAt)}{manual ? " · by hand" : ""}</dd>
            {g.aliases.length > 0 && <><dt>Other names</dt><dd>{g.aliases.join(" · ")}</dd></>}
            {g.searchTerms.length > 0 && <><dt>Search terms</dt><dd>{g.searchTerms.map(t => <code key={t} className="term">{t}</code>)}</dd></>}
            {g.path && <><dt>Path</dt><dd className="mono">{g.path}</dd></>}
            {g.file && <><dt>Starts with</dt><dd><StartsWith g={g} onChanged={() => void reload()} /></dd></>}
            {g.file?.release && <><dt>{g.file.format === "uploaded" ? "Uploaded as" : "Imported from"}</dt><dd>{g.file.release}{g.file.group && ` (${g.file.group})`}{g.file.format === "uploaded" ? ", imported by " : " via "}{madeBy(g.file.importer, g.file.kind)}</dd></>}
            {g.file?.kind && g.file.kind !== "native" && <><dt>Kind of copy</dt><dd>{g.file.kind}{g.file.requiresLauncher ? ` · needs Ahoy ${g.file.requiresLauncher} or newer` : ""}</dd></>}
            {g.platforms.length > 0 && <><dt>Platforms</dt><dd>{g.platforms.map(platformLabel).join(", ")}</dd></>}
            {g.rating != null && <><dt>Rating</dt><dd>{Math.round(g.rating)} / 100</dd></>}
          </div>
        )}
        {tab === "files" && (!g.files.length ? <Empty title="No files" icon="folder">Nothing has been imported for this game yet.<div style={{ marginTop: 12 }}><Btn icon="upload" onClick={() => setUploadOpen(true)}>Upload the game from this PC</Btn></div></Empty> : (
          <table className="table"><thead><tr><th>Path</th><th>Format</th><th>Version</th><th>Size</th><th>Imported</th></tr></thead>
            <tbody>{g.files.map(f => <tr key={f.id}><td className="mono">{f.path}</td><td><Label tone={f.format === "clean" ? "success" : "info"}>{f.format}</Label></td><td>{f.version ?? "—"}</td><td>{fmtSize(f.size)}</td><td className="dim">{fmtDate(f.createdAt)}</td></tr>)}</tbody></table>
        ))}
        {tab === "history" && (!g.history.length ? <Empty title="No history" icon="history" /> : (
          <table className="table"><thead><tr><th></th><th>Event</th><th>Release</th><th>Source</th><th>Details</th><th>When</th></tr></thead>
            <tbody>{g.history.map(h => <tr key={h.id}><td style={{ width: 30 }}><Icon name={EVENT_ICON[h.event] ?? "info"} size={15} /></td><td><Label tone={EVENT_TONE[h.event] ?? "default"}>{h.event}</Label></td><td className="ellipsis" style={{ maxWidth: 360 }}>{h.release ?? ""}</td><td>{h.source ?? ""}</td><td className="dim ellipsis" style={{ maxWidth: 360 }}>{h.message ?? ""}</td><td className="dim nowrap">{timeAgo(h.at)}</td></tr>)}</tbody></table>
        ))}
        {tab === "imports" && (!g.jobs.length ? <Empty title="No jobs" icon="box">Imports of downloads and the builds of its ways to play show up here.</Empty> : (
          <JobsTable jobs={g.jobs} onLog={setLogId} />
        ))}
        {tab === "ways" && <WaysTab g={g} ways={ways} research={waysData?.research ?? []} reloadWays={() => void reloadWays()} />}
      </div>
      {useOpen && <UseDownload gameId={g.id} ways={waysData?.items ?? []} onClose={() => setUseOpen(false)} onQueued={id => { setUseOpen(false); setTab("imports"); setLogId(id); void reload(); }} />}
      <InteractiveSearch gameId={g.id} name={g.name} open={search} onClose={() => setSearch(false)} />
      <EditModal g={g} open={edit} onClose={() => setEdit(false)} onSaved={() => void reload()} />
      <EditDetailsModal g={g} open={details} onClose={() => setDetails(false)} onSaved={() => void reload()} />
      <ArtModal g={g} open={artOpen} onClose={() => setArtOpen(false)} onChanged={() => void reload()} />
      <UploadModal g={g} ways={ways} open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <JobLogModal id={logId} onClose={() => setLogId(null)} />
    </>
  );
}
