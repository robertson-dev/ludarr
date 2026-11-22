/**
 * Activity → Builds: first the games being made playable (the open carry runs: where each is, what it does or asks, when
 * it looks again; each opens its run), then the jobs that are not imports of a download — plans worked out from a repo,
 * ways to play being built, game files taken in or made from other forms of the game's data, programs built from source —
 * live, with their logs and Cancel. ?run=<id> opens that run.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, get, missingRoute, post, timeAgo, type Game, type JobView, type Plan, type RunView } from "../api";
import { subscribe, useEvents } from "../events";
import { Empty, IconBtn, Label, Progress, Section, Spinner, ToolbarBtn, useLoad, useUi } from "../ui/kit";
import { JOB_KIND, jobActive, jobState } from "../ui/status";
import { Art, art } from "../ui/art";
import { JobLogModal, Queued } from "../ui/job-log";
import { RunModal, RunRail } from "../ui/run-view";
import { RUN_LIVE } from "../ui/run-follow";
import { fraction, nextLook, nowShown, repoTitle, runLine, runLook, runOpen } from "../ways/logic";

const KINDS = ["construct", "assemble", "content", "make", "build"] as const;
const FILTERS: [string, string][] = [["", "Every kind"], ["construct", "From a repo"], ["assemble", "Ways to play"], ["content", "Game files"], ["make", "Game data"], ["build", "From source"]];
const base = (p: string) => p.split(/[\\/]/).pop() || p;
/** where a game file is made from, in the admin's words (a make job's `from`) */
const FROM_WORD: Record<string, string> = { kept: "a file kept on the server", copy: "the game's copy on the server", inbox: "a file dropped in its inbox", indexer: "a download" };

function What({ j, games, plans, onRun }: { j: JobView; games: Map<number, Game>; plans: Map<number, Plan>; onRun: (id: number) => void }) {
  const s = (j.spec ?? {}) as Record<string, any>;
  const g = j.gameId ? games.get(j.gameId) : undefined;
  const game = g ? <Link to={`/games/${g.id}?tab=ways`}>{g.name}</Link> : j.gameId ? <span>game #{j.gameId}</span> : null;
  const plan = (id: unknown) => plans.get(Number(id))?.name ?? (id ? `plan #${id}` : null);
  // a job a carry run started: the run it is a step of
  const run = j.runId ? <> · <button type="button" className="linkish" onClick={() => onRun(j.runId!)}>its run</button></> : null;
  switch (j.kind) {
    case "construct": return <><div>{repoTitle(String(s.repo ?? ""))}</div><div className="dim">{game ? <>for {game}</> : "proposes the game it plays"}{s.planId ? ` · ${s.repair ? "a repair round of" : "reworks"} ${plan(s.planId)}` : ""}{run}</div></>;
    case "assemble": return <><div>{game ?? "a game"}</div><div className="dim">way to play #{s.wayId}{s.replace ? " · replaces the PC copy" : ""}{s.repin ? " · takes the newest release" : ""}{run}</div></>;
    case "content": {
      const need = s.planId ? plans.get(Number(s.planId))?.spec.needs[Number(s.needIndex)]?.name : null;
      const what = s.fromCopy ? "the game's copy on the server" : s.path ? base(String(s.path)) : "a file";
      return <><div className={s.fromCopy ? undefined : "mono ellipsis"} style={s.fromCopy ? undefined : { maxWidth: 320 }} title={s.path}>{what}</div><div className="dim">{s.planId ? <>for {plan(s.planId)}{need ? `: ${need}` : ""}</> : game ? <>for {game}{s.inbox ? ", from its inbox folder" : ""}{s.wayId ? ` · way to play #${s.wayId}` : ""}</> : null}{run}</div></>;
    }
    case "make": return <><div>{game ?? "a game"}</div><div className="dim">its game file, made from {FROM_WORD[String(s.from)] ?? "other game data"} · way to play #{s.wayId}{run}</div></>;
    case "build": return <><div>{plan(s.planId) ?? "a plan"}</div><div className="dim">{s.wayId ? <>for {game ?? `way #${s.wayId}`}</> : "the program, from source"}{run}</div></>;
    default: return <span className="dim">{j.inputPath}</span>;
  }
}

/**
 * The games being made playable: the open runs, kept current by their 'run' events, and what each does now by the ticks
 * of the job it follows (its progress and its words, bytes of total, as they come: a run's own row changes only when the
 * run moves on)
 */
function Runs({ onOpen, games }: { onOpen: (id: number) => void; games: Map<number, Game> }) {
  // a server without runs answers "no such endpoint": the section is left out
  const { data, error, reload, setData } = useLoad(() => get<{ items: RunView[] }>("/api/v1/runs?open=1").catch(e => { if (missingRoute(e)) return null; throw e; }), []);
  const known = useRef<Set<number>>(new Set());
  known.current = new Set((data?.items ?? []).map(r => r.id));
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const again = () => { if (!t) t = setTimeout(() => { t = null; void reload(); }, 400); };
    const off = subscribe((ev, d) => {
      if (!d || typeof (d as { id?: unknown }).id !== "number") return;
      if (ev === "build" || ev === "job") {
        const j = d as JobView;
        if (!jobActive(j.state)) return;
        setData(cur => cur && { items: cur.items.map(x => (x.now?.jobId === j.id && nowShown(x)
          ? { ...x, now: { ...x.now, text: j.message?.split("\n")[0] || x.now.text, progress: j.progress } } : x)) });
        return;
      }
      if (ev !== "run") return;
      const r = d as RunView;
      // a run this list does not have yet, or one that ended: read the list again
      if (!known.current.has(r.id)) { if (runOpen(r.state)) again(); return; }
      if (!runOpen(r.state)) again();
      setData(cur => cur && { items: cur.items.map(x => { if (x.id !== r.id) return x; const next = { ...x } as Record<string, unknown>; for (const k of RUN_LIVE) if (r[k] !== undefined) next[k] = r[k]; return next as unknown as RunView; }) });
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [reload, setData]);
  useEvents(["job"], () => void reload());
  if (data === null && !error) return null;
  const items = data?.items ?? [];
  return (
    <Section title="Making it playable" right={<span className="dim">{items.length ? `${items.length} game${items.length === 1 ? "" : "s"}` : ""}</span>}>
      {error && !data ? <div className="err-line">Could not load the runs: {error}</div> : !items.length ? <p className="dim">No game is being made playable right now.</p> : (
        <div className="table-wrap"><table className="table runs">
          <thead><tr><th className="art-col"></th><th>Game</th><th className="rail-col">Where it is</th><th>State</th><th className="actions"></th></tr></thead>
          <tbody>{items.map(r => {
            const look = runLook(r), g = r.gameId ? games.get(r.gameId) : undefined;
            const next = nextLook(r);
            return (
              <tr key={r.id}>
                <td className="art-col" style={{ width: 44 }}>{g ? <Art className="cover-sm" src={art.poster(g.id, g.customArtAt)} title={g.name} /> : null}</td>
                <td>
                  <div>{r.gameId ? <Link to={`/games/${r.gameId}?tab=ways`}>{r.gameName ?? `game #${r.gameId}`}</Link> : <span className="dim">no game yet</span>}</div>
                  <div className="dim">through {r.planName}</div>
                </td>
                <td className="rail-col"><RunRail view={r} compact /></td>
                <td>
                  <Label tone={look.tone}>{look.label}</Label>
                  <div className="dim clamp2" style={{ maxWidth: 380 }} title={runLine(r)}>{runLine(r)}</div>
                  {/* while it asks, what its search is bringing in (a download) still shows, with its bytes */}
                  {r.state === "asking" && nowShown(r) && <div className="dim clamp2" style={{ maxWidth: 380 }}>{runLine({ ...r, state: "waiting", ask: null })}</div>}
                  {nowShown(r) && r.now?.progress != null && <div style={{ marginTop: 4, maxWidth: 240 }}><Progress value={fraction(r.now.progress)} tone="queue" /></div>}
                  {next && <div className="dim">{next}</div>}
                </td>
                <td className="actions"><IconBtn icon="external" label="Open the run" onClick={() => onOpen(r.id)} /></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </Section>
  );
}

/** a kind's jobs; a server that does not know the kind yet ('make' before a newer engine) lists none of it */
const jobsOf = (k: string) => get<{ items: JobView[] }>(`/api/v1/jobs?kind=${k}`).catch(e => {
  if (e instanceof ApiError && e.status === 400) return { items: [] as JobView[] };
  throw e;
});

export function BuildsPage() {
  const { toast } = useUi();
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState(() => { try { return localStorage.getItem("builds.kind") ?? ""; } catch { return ""; } });
  const { data, loading, error, reload } = useLoad(async () => {
    const [lists, games, plans] = await Promise.all([
      Promise.all(KINDS.map(jobsOf)),
      get<{ items: Game[] }>("/api/v1/game").catch(() => ({ items: [] as Game[] })),
      get<{ items: Plan[] }>("/api/v1/plan").catch(() => ({ items: [] as Plan[] })),
    ]);
    return {
      jobs: lists.flatMap(l => l.items).sort((a, b) => b.id - a.id),
      games: new Map(games.items.map(g => [g.id, g])), plans: new Map(plans.items.map(p => [p.id, p])),
    };
  }, []);
  /** the latest word from each job: progress ticks ('build') and state changes ('job', so a finish never loses to an older tick);
   *  a 'job' event also reloads the list, which brings new jobs in */
  const [live, setLive] = useState<Record<number, JobView>>({});
  useEffect(() => subscribe((ev, d) => {
    if ((ev !== "build" && ev !== "job") || !d || typeof (d as JobView).id !== "number") return;
    const j = d as JobView;
    setLive(l => ({ ...l, [j.id]: j }));
  }), []);
  useEvents(["job"], () => void reload());
  const [logId, setLogId] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const runId = Number(params.get("run")) || null;
  const openRun = (id: number | null) => setParams(p => { const n = new URLSearchParams(p); if (id) n.set("run", String(id)); else n.delete("run"); return n; }, { replace: true });
  const setK = (v: string) => { setKind(v); try { localStorage.setItem("builds.kind", v); } catch { /* the choice just is not kept */ } };
  const cancel = async (j: JobView) => {
    setBusy(j.id);
    try { const r = await post<{ stopping?: boolean }>(`/api/v1/jobs/${j.id}/cancel`); toast(r?.stopping ? "Stopping it" : "Cancelled"); void reload(); }
    catch (e: any) { toast(e.message, "danger"); } finally { setBusy(null); }
  };
  const rows = (data?.jobs ?? []).map(j => (live[j.id] && live[j.id].updatedAt >= j.updatedAt ? { ...j, ...live[j.id] } : j)).filter(j => !kind || j.kind === kind);
  return (
    <>
      <div className="toolbar"><div className="tb-left"><ToolbarBtn icon="refresh" label="Refresh" onClick={() => void reload()} /></div></div>
      <div className="content">
        <Runs onOpen={id => openRun(id)} games={data?.games ?? new Map()} />
        <div className="filterbar">
          <select className="select" value={kind} onChange={e => setK(e.target.value)} aria-label="Kind">{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <span className="dim">{rows.length} job{rows.length === 1 ? "" : "s"}</span>
        </div>
        {loading && !data ? <Spinner /> : error && !data ? <Empty title="Could not load the builds" icon="alert">{error}</Empty> : !rows.length ? (
          <Empty title={kind ? "Nothing of this kind" : "No builds yet"} icon="hammer">Plans worked out from a repo, ways to play being built and game files taken in or made show up here.</Empty>
        ) : (
          <div className="table-wrap"><table className="table builds">
            <thead><tr><th className="art-col"></th><th>Kind</th><th>What</th><th style={{ minWidth: 170 }}>State</th><th style={{ width: 170 }}>Progress</th><th className="actions"></th></tr></thead>
            <tbody>{rows.map(j => {
              const st = jobState(j.state), active = jobActive(j.state);
              const g = j.gameId ? data?.games.get(j.gameId) : undefined;
              return (
                <tr key={j.id}>
                  <td className="art-col" style={{ width: 44 }}>{g ? <Art className="cover-sm" src={art.poster(g.id, g.customArtAt)} title={g.name} /> : null}</td>
                  <td><Label tone="outline">{JOB_KIND[j.kind ?? ""] ?? j.kind}</Label></td>
                  <td>{data && <What j={j} games={data.games} plans={data.plans} onRun={id => openRun(id)} />}</td>
                  <td><Label tone={st.tone}>{st.label}</Label>{j.message && <div className="dim clamp2" style={{ maxWidth: 340 }} title={j.message}>{j.message.split("\n")[0]}</div>}</td>
                  <td>
                    {j.state === "queued" ? <Queued job={{ message: null }} /> : active ? <Progress value={j.progress} tone="queue" /> : null}
                    <div className="dim nowrap" style={{ marginTop: active ? 4 : 0 }}>{j.doneAt ? `ended ${timeAgo(j.doneAt)}` : `started ${timeAgo(j.createdAt)}`}</div>
                  </td>
                  <td className="actions">
                    <IconBtn icon="terminal" label="Open the log" onClick={() => setLogId(j.id)} />
                    {active && <IconBtn icon={busy === j.id ? "spinner" : "x"} label="Cancel" danger disabled={busy === j.id} onClick={() => void cancel(j)} />}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
      <JobLogModal id={logId} onClose={() => setLogId(null)} />
      <RunModal id={runId} onClose={() => openRun(null)} onChanged={() => void reload()} />
    </>
  );
}
