/**
 * Add → From a repo: the repo of a recomp, port or emulator becomes a plan (a repo ludarr knows is set up directly, any
 * other is worked out by the AI importer and tested before it is saved). The run is followed live; when it ends, the
 * plan it saved, and then the carry run that takes the plan on by itself to a game members install (where it is, what it
 * does now, what it asks). A job from before runs, or a server without them, shows the way it made for the chosen game
 * or the game it proposes, ready to add.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, errorList, get, missingRoute, NOT_YET, post, sentence, type Game, type GameDraft, type JobView, type Plan, type PlanDetail } from "../api";
import { Icon } from "../ui/icons";
import { Btn, Callout, Empty, Row, Section, Spinner, Tabs, useLoad, useReveal, useUi } from "../ui/kit";
import { GameDraftForm } from "../ui/game-form";
import { GamePicker } from "../ui/game-picker";
import { LibraryFields, libraryBody, useLibraryFields } from "../ui/library-fields";
import { JobHead, JobLogModal, JobTimeline, useJob } from "../ui/job-log";
import { PlanSummary } from "../ui/plan-view";
import { RunBody, RunHead, useRun } from "../ui/run-view";
import { aboutAiSetup, constructOutcome, draftOf, emptyForm, fillEmpty, formProblems, repoHint, repoLabel, repoTitle, type RepoHint } from "../ways/logic";
import { duplicateName } from "./add-manual";

interface Ask { repo: string; gameId: number | null; note: string }

const hostWords = (h: Extract<RepoHint, { repo: string }>) =>
  h.host === "feed" ? repoLabel(h.repo) : h.host === "forgejo" ? `forgejo host ${h.repo.slice("forgejo:".length).split("/")[0]}: ${h.repo.split("/").slice(1).join("/")}` : `GitHub: ${h.repo}`;

/** start a construct job; a server without the route says so instead of failing */
async function construct(a: Ask): Promise<{ job?: JobView; notYet?: boolean; error?: { message: string; status: number } }> {
  try {
    const r = await post<{ job: JobView }>("/api/v1/plan/construct", { repo: a.repo.trim(), ...(a.gameId ? { gameId: a.gameId } : {}), ...(a.note.trim() ? { note: a.note.trim() } : {}) });
    return { job: r.job };
  } catch (e) {
    if (missingRoute(e)) return { notYet: true };
    return { error: { message: String((e as Error).message), status: e instanceof ApiError ? e.status : 0 } };
  }
}

function RepoForm({ initial, onStarted }: { initial: Ask; onStarted: (id: number) => void }) {
  const [repo, setRepo] = useState(initial.repo);
  const [game, setGame] = useState<Game | null>(null);
  const [note, setNote] = useState(initial.note);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; status: number } | null>(null);
  const [notYet, setNotYet] = useState(false);
  useEffect(() => {
    if (!initial.gameId) return;
    void get<{ item: Game }>(`/api/v1/game/${initial.gameId}`).then(r => setGame(r.item)).catch(() => {});
  }, [initial.gameId]);
  const hint = repo.trim() ? repoHint(repo) : null;
  const bad = !!hint && "error" in hint;
  const start = async () => {
    if (!repo.trim() || bad) return;
    setBusy(true); setFailure(null); setNotYet(false);
    const r = await construct({ repo, gameId: game?.id ?? null, note });
    setBusy(false);
    if (r.job) onStarted(r.job.id);
    else if (r.notYet) setNotYet(true);
    else if (r.error) setFailure(r.error);
  };
  return (
    <div className="narrow-inner">
      <p className="dim lead">The repo of a recomp, a port or an emulator, on GitHub or a forgejo host. A repo ludarr already knows is set up from what it knows; any other is worked out by the AI importer, which tests its plan before saving it.</p>
      {notYet && <Callout tone="info">Building a way to play from a repo: {NOT_YET.toLowerCase()}</Callout>}
      {failure && (
        <Callout tone={failure.status === 409 ? "warning" : "danger"}>
          {sentence(failure.message)}
          {failure.status === 409 && aboutAiSetup(failure.message) && <> · <Link to="/settings/importers">Settings → Importers</Link></>}
        </Callout>
      )}
      <Section title="The repo">
        <Row label={<>Repo<span className="muted"> *</span></>} help="A GitHub link or owner/name, a Codeberg link, or forgejo:host/owner/name for another forge."
          error={bad && hint && "error" in hint ? sentence(hint.error) : null} src={hint && "repo" in hint ? hostWords(hint) : undefined}>
          <input className="input" value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://github.com/owner/name" autoFocus aria-label="Repo"
            onKeyDown={e => { if (e.key === "Enter") void start(); }} />
        </Row>
        <Row label="For this game" help="The library game it plays. Leave it empty and the game it plays is proposed with the plan, ready to add.">
          <GamePicker value={game} onChange={setGame} />
        </Row>
        <Row label="Note for the AI" help="Anything the AI importer should know: which build to prefer, where the game file goes. A repo ludarr already knows needs none.">
          <textarea className="textarea prose" rows={3} value={note} onChange={e => setNote(e.target.value)} maxLength={2000} aria-label="Note for the AI" />
        </Row>
      </Section>
      <div className="form-actions"><Btn kind="primary" size="lg" icon="hammer" busy={busy} disabled={!repo.trim() || bad} onClick={() => void start()}>Build it</Btn></div>
    </div>
  );
}

/** the game the run was for: its way is on its page */
function ForGame({ gameId }: { gameId: number }) {
  const { data, error } = useLoad(() => get<{ item: Game }>(`/api/v1/game/${gameId}`), [gameId]);
  if (error) return <Callout tone="warning">The game this was for is no longer in the library.</Callout>;
  if (!data) return null;
  return (
    <Callout tone="success">
      The way to play is on <b>{data.item.name}</b>'s page: <Link to={`/games/${gameId}?tab=ways`}>open it</Link> to give it its game file and build it.
    </Callout>
  );
}

/** the game the plan plays, as proposed: added to the library with its way, or a library game takes the way */
function ProposedGame({ plan, draft }: { plan: Plan; draft: Partial<GameDraft> | null }) {
  const nav = useNavigate();
  const { toast } = useUi();
  const [mode, setMode] = useState("new");
  const [form, setForm] = useState(() => fillEmpty(emptyForm(), draft ?? {}).form);
  const lib = useLibraryFields();
  const [pick, setPick] = useState<Game | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dup, setDup] = useState<{ id: number; name: string | null } | null>(null);
  const [failure, setFailure] = useState<string[] | null>(null);
  /** the server's word that the plan plays another game than the one picked (an admin who knows better adds it anyway);
   *  `added` when that game was just added to the library */
  const [wrong, setWrong] = useState<{ id: number; name: string; message: string; added: boolean } | null>(null);
  const problems = formProblems(form);
  /** the plan's way on a game (one it has already is fine) */
  const attach = async (gameId: number, force = false) => {
    try { await post(`/api/v1/game/${gameId}/ways`, { planId: plan.id, ...(force ? { force: true } : {}) }); }
    catch (e) { if (!(e instanceof ApiError && e.status === 409 && e.data?.existingId)) throw e; }
  };
  /** the server's refusal of a recomp or port for a game it does not play (409 { wrongGame }) */
  const wrongGame = (e: unknown) => (e instanceof ApiError && e.status === 409 && e.data?.wrongGame ? sentence(e.message) : null);
  /** the search starts only once the way is there, so it looks for what the way needs */
  const search = (gameId: number) => (lib.value.monitored && lib.value.searchNow ? post(`/api/v1/game/${gameId}/search`).catch(() => { /* released later, or nothing to search yet */ }) : null);
  const done = (gameId: number, name: string) => { toast(<><b>{name}</b> plays through {plan.name} now</>, "success"); nav(`/games/${gameId}?tab=ways`); };
  const addNew = async (force = false) => {
    setTried(true);
    if (Object.keys(problems).length) return;
    setBusy(true); setFailure(null); setDup(null); setWrong(null);
    try {
      const g = (await post<{ item: Game }>("/api/v1/game", { source: "manual", game: draftOf(form), ...libraryBody({ ...lib.value, searchNow: false }), ...(force ? { force: true } : {}) })).item;
      try { await attach(g.id); }
      catch (e) { const why = wrongGame(e); if (why) { setWrong({ id: g.id, name: g.name, message: why, added: true }); return; } throw e; }
      await search(g.id);
      done(g.id, g.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.existingId) setDup({ id: Number(e.data.existingId), name: duplicateName(e.message) });
      else setFailure(errorList(e));
    } finally { setBusy(false); }
  };
  const takeGame = async (id: number, name: string, force = false, added = false) => {
    setBusy(true); setFailure(null); setWrong(null);
    try { await attach(id, force); if (added) await search(id); done(id, name); }
    catch (e) { const why = wrongGame(e); if (why) setWrong({ id, name, message: why, added }); else setFailure(errorList(e)); }
    finally { setBusy(false); }
  };
  // what the last press brought back sits next to the buttons, and is brought into view
  const notice = useReveal(dup ?? failure ?? wrong);
  const notices = (
    <div ref={notice}>
      {failure && <Callout tone="danger">{failure.length === 1 ? sentence(failure[0]) : <ul className="errs">{failure.map((f, i) => <li key={i}>{f}</li>)}</ul>}</Callout>}
      {wrong && (
        <Callout tone="warning">
          {wrong.message}{wrong.added ? <>. <b>{wrong.name}</b> is in the library without this way to play</> : null} · <button type="button" className="linkish" disabled={busy} onClick={() => void takeGame(wrong.id, wrong.name, true, wrong.added)}>add it anyway</button>
          {wrong.added && <> · <Link to={`/games/${wrong.id}`}>open it</Link></>}
        </Callout>
      )}
      {dup && mode === "new" && (
        <Callout tone="warning">
          Already in your library{dup.name ? <> as <b>{dup.name}</b></> : null}: <button type="button" className="linkish" onClick={() => void takeGame(dup.id, dup.name ?? "The game")}>use it</button> · <Link to={`/games/${dup.id}`}>open it</Link> · <button type="button" className="linkish" onClick={() => void addNew(true)}>add anyway</button>
        </Callout>
      )}
    </div>
  );
  return (
    <Section title="The game it plays">
      <Tabs value={mode} onChange={setMode} items={[{ id: "new", label: draft ? "Add this game" : "Add a game for it" }, { id: "library", label: "Use a game in my library" }]} />
      {mode === "new" ? (
        <>
          {draft ? <p className="dim" style={{ marginBottom: 6 }}>Proposed with the plan. Players see the name and the summary in Ahoy, so check them.</p>
            : <p className="dim" style={{ marginBottom: 6 }}>The run proposed no game: describe the one it plays.</p>}
          <GameDraftForm value={form} onChange={setForm} errors={tried ? problems : {}} />
          <LibraryFields lib={lib} searchHelp="Search the indexers once the game and its way to play are added (released games only)." />
          {notices}
          <div className="form-actions"><Btn kind="success" size="lg" icon="plus" busy={busy} onClick={() => void addNew()}>{draft ? "Add this game" : "Add the game"}</Btn></div>
        </>
      ) : (
        <>
          <Row label="Game" help="The way to play is added to this game; its other ways stay."><GamePicker value={pick} onChange={setPick} autoFocus /></Row>
          {notices}
          <div className="form-actions"><Btn kind="primary" size="lg" busy={busy} disabled={!pick} onClick={() => pick && void takeGame(pick.id, pick.name)}>Use this game</Btn></div>
        </>
      )}
    </Section>
  );
}

function ConstructResult({ job }: { job: JobView }) {
  const { data: plans, error: plansError } = useLoad(() => get<{ items: Plan[] }>("/api/v1/plan"), [job.id]);
  const outcome = constructOutcome(job, plans?.items ?? []);
  const { data: detail, error } = useLoad(() => (outcome.planId ? get<{ item: PlanDetail }>(`/api/v1/plan/${outcome.planId}`) : Promise.resolve(null)), [outcome.planId]);
  // the run that carries the saved plan on by itself (a new plan's, or the run whose repair round this was)
  const carry = useRun(outcome.runId);
  const [logId, setLogId] = useState<number | null>(null);
  const gameId: number | null = Number(job.spec?.gameId) || job.gameId || null;
  if (!plans && !plansError) return <Spinner />;
  if (!outcome.planId) return <Callout tone="warning">The run ended without saving a plan. {job.message ? sentence(job.message) : null}</Callout>;
  // a run the server cannot show (no run routes yet, or the run is gone) leaves the page as it was before runs
  const byRun = !!outcome.runId && !carry.missing && !(carry.error && !carry.run);
  return (
    <>
      <Section title="The plan" right={<Link className="btn sm" to={`/settings/runtimes?plan=${outcome.planId}`}>Open it with the plans</Link>}>
        {detail ? <PlanSummary plan={detail.item} /> : error ? <Callout tone="warning">{sentence(error)}</Callout> : <Spinner />}
        {!byRun && detail && detail.item.status !== "ready" && <p className="dim" style={{ marginTop: 8 }}><Icon name="info" size={13} /> A plan that is not ready is checked again before anything is built from it.</p>}
      </Section>
      {byRun ? (
        <Section title={carry.run ? <>Making {carry.run.gameName ?? "it"} playable</> : "Making it playable"}>
          {carry.run ? <><RunHead view={carry.run} /><RunBody view={carry.run} tick={carry.tick} onChanged={carry.reload} onLog={setLogId} /></> : <Spinner text="Loading the run…" />}
          <JobLogModal id={logId} onClose={() => setLogId(null)} />
        </Section>
      ) : gameId ? <ForGame gameId={gameId} /> : detail && <ProposedGame plan={detail.item} draft={outcome.game} />}
    </>
  );
}

function ConstructRun({ id, onBack, onRetry }: { id: number; onBack: (a: Ask | null) => void; onRetry: (a: Ask) => void }) {
  const { job, error } = useJob(id);
  if (!job) return <div className="narrow-inner">{error ? <Empty title="Could not load the run" icon="alert">{error}</Empty> : <Spinner text="Loading the run…" />}</div>;
  const spec = (job.spec ?? {}) as { repo?: string; gameId?: number | null; note?: string | null };
  const ask: Ask = { repo: spec.repo ?? "", gameId: spec.gameId ?? null, note: spec.note ?? "" };
  // a job of another kind in the address shows its log, nothing more
  const construct = (job.kind ?? "construct") === "construct";
  // once the plan is saved its run's view shows what the run did: this job's own steps are how the plan was worked out
  const byRun = construct && job.state === "done" && !!constructOutcome(job).runId;
  return (
    <div className="narrow-inner">
      <div className="run-head">
        <h2 className="page-title">{repoTitle(ask.repo) || "From a repo"}</h2>
        <span className="grow" />
        <Btn size="sm" icon="chevronLeft" onClick={() => onBack(null)}>Start another</Btn>
      </div>
      <JobHead job={job} />
      {job.state === "done" && construct && <ConstructResult job={job} />}
      {construct && (job.state === "failed" || job.state === "cancelled") && (
        <div className="row wrap" style={{ margin: "10px 0 18px" }}>
          <Btn icon="refresh" onClick={() => onRetry(ask)}>Try again</Btn>
          <Btn icon="pencil" onClick={() => onBack(ask)}>Change and try again</Btn>
        </div>
      )}
      <Section title={byRun ? "How the plan was worked out" : "What it did"}><JobTimeline job={job} /></Section>
    </div>
  );
}

export function RepoTab() {
  const [params, setParams] = useSearchParams();
  const { toast } = useUi();
  const jobId = Number(params.get("job")) || null;
  const back = (a: Ask | null) => setParams(a ? { repo: a.repo, ...(a.gameId ? { gameId: String(a.gameId) } : {}), ...(a.note ? { note: a.note } : {}) } : {});
  const retry = async (a: Ask) => {
    const r = await construct(a);
    if (r.job) setParams({ job: String(r.job.id) });
    else toast(r.notYet ? `Building a way to play from a repo: ${NOT_YET.toLowerCase()}` : sentence(r.error?.message ?? "could not start"), r.notYet ? "info" : "danger");
  };
  if (jobId) return <ConstructRun key={jobId} id={jobId} onBack={back} onRetry={a => void retry(a)} />;
  return <RepoForm key={params.toString()} initial={{ repo: params.get("repo") ?? "", gameId: Number(params.get("gameId")) || null, note: params.get("note") ?? "" }} onStarted={id => setParams({ job: String(id) })} />;
}
