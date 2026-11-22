/**
 * A carry run as the admin sees it. useRun keeps one run current (run-follow.ts says when it is read). RunRail shows its
 * phases, RunNow what it does now with the real progress of the job it follows, AskCard what it asks: its words, the inbox
 * folder with a copy button, and only the controls that can work. RunSteps lists who did what, how each step ended and its
 * proof, and the AI's rounds with what they changed. RunCheck shows its build's check with the screenshot, and RunModal
 * all of it. The way card (game-ways.tsx), Activity → Builds and Add → From a repo show runs through these.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ApiError, get, missingRoute, NOT_YET, post, sentence, timeAgo,
  type ConstructManifest, type Game, type JobView, type RunAnswer, type RunStep, type RunView, type UploadResult, type WayRun,
} from "../api";
import { onConnection, subscribe } from "../events";
import { Icon } from "./icons";
import { Btn, Callout, CopyButton, Empty, Label, Modal, Progress, Spinner, useLoad, useUi } from "./kit";
import { ServerPathModal, UploadButton } from "./files";
import { GamePicker } from "./game-picker";
import { cancelJob, JobLogModal, Queued, useJob } from "./job-log";
import { CheckView } from "./check-view";
import { followRun } from "./run-follow";
import {
  askLines, budgetLine, checkJobOf, checkOfTrace, jobEnd, nowShown, platformLabel, runLook, runNow, runOpen, runRail, runWorking, startedWords, stepIcon, stepTime, whoWord,
  type AskModel,
} from "../ways/logic";

/* ─────────── one run, kept current ─────────── */

/**
 * One run while it is on screen: the run, the latest tick of the job it follows, the read's error, and `missing` when
 * the server has no run routes yet (an older engine), which the pages take quietly.
 */
export function useRun(id: number | null) {
  const [run, setRun] = useState<RunView | null>(null);
  const [tick, setTick] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const again = useRef<() => void>(() => {});
  useEffect(() => {
    setRun(null); setTick(null); setError(null); setMissing(false);
    if (id == null) return;
    const f = followRun(id, {
      subscribe, onConnection,
      load: async rid => (await get<{ item: RunView }>(`/api/v1/run/${rid}`)).item,
      onRun: (r, full) => { setRun(r); if (full) setError(null); },
      onTick: setTick,
      onError: e => {
        if (missingRoute(e)) { setMissing(true); return true; }
        setError(String((e as Error)?.message ?? e));
        return e instanceof ApiError && e.status === 404;
      },
    });
    again.current = f.reload;
    return f.stop;
  }, [id]);
  // the job it follows (or its search's, while it asks), read once when it starts following it: its own words (bytes of
  // total, the step it is on) show at once, not only from its next tick
  const following = run && nowShown(run) ? run.now?.jobId ?? null : null;
  useEffect(() => {
    if (following == null) return;
    let alive = true;
    void get<{ item: JobView }>(`/api/v1/import/${following}`).then(r => {
      if (alive && r?.item) setTick(t => (t && t.id === following ? t : r.item));
    }, () => { /* its ticks will say it */ });
    return () => { alive = false; };
  }, [following]);
  return { run, tick, error, missing, reload: () => again.current() };
}

/** a press on a run: its words when it worked, the server's when it did not, and a quiet word on a server without runs */
function useRunPress(onChanged: () => void) {
  const { toast } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const press = async (key: string, fn: () => Promise<unknown>, done?: ReactNode): Promise<boolean> => {
    setBusy(key);
    try { await fn(); if (done) toast(done, "success"); onChanged(); return true; }
    catch (e) {
      if (missingRoute(e)) toast(`Making games playable by itself: ${NOT_YET.toLowerCase()}`, "info");
      else toast(sentence((e as Error).message), e instanceof ApiError && e.status === 409 ? "warning" : "danger");
      return false;
    } finally { if (alive.current) setBusy(null); }
  };
  return { busy, press };
}

/* ─────────── the rail ─────────── */

/** Plan · Game · Game file · Build · Check: each phase's state, and (full size) what the run says about it */
export function RunRail({ view, compact }: { view: Pick<RunView, "rail" | "state">; compact?: boolean }) {
  const steps = runRail(view);
  return (
    <ol className={`rail${compact ? " compact" : ""}`} aria-label="Where it is">
      {steps.map(s => (
        <li key={s.phase} className={`rail-step ${s.tone}`} title={`${s.label}: ${s.words}${s.summary ? ` — ${s.summary}` : ""}`}>
          <Icon name={s.icon} size={compact ? 13 : 15} />
          <div className="rail-text">
            <span className="rail-label">{s.label}</span>
            {!compact && <span className="rail-words">{s.line}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ─────────── what it does now ─────────── */

/**
 * The job or request the run follows: its words, its real progress (the job's own ticks as they come), its log. While the
 * run asks, its search's download shows here too (nowShown), without Cancel: that job is the search's, not the run's.
 */
export function RunNow({ view, tick, onLog, onChanged }: { view: RunView; tick: JobView | null; onLog: (id: number) => void; onChanged: () => void }) {
  const { confirm } = useUi();
  const { busy, press } = useRunPress(onChanged);
  const now = runNow(view.now, tick);
  if (!now || !nowShown(view)) return null;
  const own = runWorking(view.state);
  const pct = now.progress != null ? Math.round(now.progress * 100) : null;
  const cancel = async () => {
    if (!now.jobId || !(await confirm("Cancel this step?", "The job stops, and the run waits on hold until you press Resume.", { ok: "Cancel the job", kind: "warning" }))) return;
    await press("cancel", () => cancelJob(now.jobId!));
  };
  return (
    <div className="run-now">
      {now.heading && <div className="run-now-text">{sentence(now.heading)}</div>}
      {now.queued ? <Queued job={{ message: now.detail }} />
        : pct != null ? <><Progress value={now.progress!} tone="queue" text={`${pct}%`} />{now.detail && <div className="run-now-detail">{now.detail}</div>}</>
        : now.detail && <div className="run-now-detail"><Icon name="spinner" size={12} /> {now.detail}</div>}
      {(now.jobId || now.requestId) && (
        <div className="acts">
          {now.jobId && <Btn size="sm" kind="outline" icon="terminal" onClick={() => onLog(now.jobId!)}>Open its log</Btn>}
          {now.jobId && own && <Btn size="sm" kind="outline" icon="x" busy={busy === "cancel"} onClick={() => void cancel()}>Cancel this step</Btn>}
          {now.requestId && <Link className="btn sm outline" to="/activity/queue"><Icon name="search" size={14} />Open the queue</Link>}
        </div>
      )}
    </div>
  );
}

/* ─────────── what it asks ─────────── */

/** the inbox folder: as the admin's PC opens it with a copy button, the server's own path in small type */
function InboxPath({ inbox }: { inbox: NonNullable<AskModel["inbox"]> }) {
  const notes = [inbox.server ? `On the server: ${inbox.server}` : null, inbox.dotted ? "The folder starts with a dot, so Windows may hide it: type the path in Explorer's address bar." : null].filter(Boolean);
  return (
    <div className="inbox">
      <div className="inbox-line"><code className="inbox-path">{inbox.shown}</code><CopyButton text={inbox.shown} /></div>
      {notes.length > 0 && <div className="inbox-note">{notes.join(" · ")}</div>}
      {!inbox.mapped && <div className="inbox-note">To see it as your PC opens it, set Library as your PC sees it under <Link to="/settings/mediamanagement">Settings → Media Management</Link> (advanced).</div>}
    </div>
  );
}

/** a choice of game: the run's own candidates, another library game, or a new game from the plan's own description */
function GameChoice({ m, busy, onAnswer }: { m: AskModel; busy: string | null; onAnswer: (key: string, body: RunAnswer, done: ReactNode) => void }) {
  const [picked, setPicked] = useState<Game | null>(null);
  const word = m.code === "choice" ? "Make this one playable" : "This one";
  return (
    <div className="ask-games">
      {m.choices.length > 0 && (
        <ul className="ask-choices">{m.choices.map(c => (
          <li key={c.gameId}>
            <span className="grow"><b>{c.name}</b>{c.year ? <span className="dim"> ({c.year})</span> : null}{c.platforms.length ? <span className="dim"> · {c.platforms.map(platformLabel).join(", ")}</span> : null}</span>
            <Btn size="sm" kind="primary" busy={busy === `game:${c.gameId}`} disabled={!!busy} onClick={() => onAnswer(`game:${c.gameId}`, { gameId: c.gameId }, <>Making <b>{c.name}</b> playable</>)}>{word}</Btn>
          </li>
        ))}</ul>
      )}
      {m.pickGame && (
        <div className="ask-pick">
          <div className="grow"><GamePicker value={picked} onChange={setPicked} placeholder={m.choices.length ? "Another game in the library" : "A game in the library"} /></div>
          {picked && <Btn size="sm" kind="primary" busy={busy === "game:picked"} disabled={!!busy} onClick={() => onAnswer("game:picked", { gameId: picked.id }, <>Making <b>{picked.name}</b> playable</>)}>Use this game</Btn>}
        </div>
      )}
      {m.newGame && <div className="acts"><Btn size="sm" kind="outline" icon="plus" busy={busy === "new"} disabled={!!busy} onClick={() => onAnswer("new", { newGame: true }, "Adding it as a new game")}>Add it as a new game</Btn></div>}
    </div>
  );
}

/** what the run asks, its words generated from facts, with only the controls that can bring it */
export function AskCard({ view, onChanged }: { view: RunView; onChanged: () => void }) {
  const { toast, confirm } = useUi();
  const { busy, press } = useRunPress(onChanged);
  const [pathOpen, setPathOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "This is wrong": what the admin tells the AI, in their own words (POST /run/:id/tell)
  const [telling, setTelling] = useState(false);
  const [told, setTold] = useState("");
  const ask = view.ask;
  if (!ask || !runOpen(view.state)) return null;
  const tell = async () => {
    const text = told.trim();
    if (!text) return;
    if (await press("tell", () => post(`/api/v1/run/${view.id}/tell`, { text }), "The AI is reworking the plan as you said")) { setTold(""); setTelling(false); }
  };
  const m = askLines(ask, { planId: view.planId });
  const answer = (key: string, body: RunAnswer, done: ReactNode) => void press(key, () => post(`/api/v1/run/${view.id}/answer`, body), done);
  const retry = () => void press("retry", () => post(`/api/v1/run/${view.id}/retry`), "Looking again now");
  const notNow = async () => {
    if (!(await confirm("Not now?", "The run stops and nothing is removed. To be done with the plan, delete it from its dialog under Settings → Runtimes; Make it playable there starts the run again.", { ok: "Stop the run", kind: "warning" }))) return;
    answer("no", { go: false }, "Stopped");
  };
  const accept = async () => {
    if (!m.accept || !view.wayId) return;
    if (!(await confirm("Accept the file?", <>Its sha1 joins the versions this way accepts, and it becomes the way's game file. Only do this for a file you know is the right game: a wrong file builds a game that does not start.</>, { ok: "Accept it", kind: "warning" }))) return;
    await press("accept", () => post(`/api/v1/way/${view.wayId}/accept-file`, { contentId: m.accept }), "Accepted: it is the way's game file now");
  };
  const folder = ask.accept?.shape !== "file";
  return (
    <div className="ask-card">
      <div className="ask-head"><Icon name="help" size={15} /><b className="grow">{ask.title}</b><span className="dim nowrap">asked {timeAgo(ask.askedAt)}</span></div>
      {m.need.length > 0 && <p className="ask-need">{m.need.join(" ")}</p>}
      {m.tried.length > 0 && (
        <div className="ask-tried"><div className="ask-sub">What it tried</div><ul>{m.tried.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
      )}
      {m.bring && <p className="ask-bring">{m.bring}</p>}
      {m.inbox && <InboxPath inbox={m.inbox} />}
      {m.byAi && <div className="ask-ai">The AI's words: “{m.byAi}”</div>}
      {(m.choices.length > 0 || m.pickGame || m.newGame) && <GameChoice m={m} busy={busy} onAnswer={answer} />}
      {error && <div className="err-line">{error}</div>}
      {(m.pick || m.upload || m.accept || m.go || m.link || m.retry) && (
        <div className="acts">
          {m.pick && view.gameId && <Btn size="sm" kind="primary" icon="folder" disabled={!!busy} onClick={() => setPathOpen(true)}>Pick it on the server</Btn>}
          {m.upload && view.gameId && (
            <UploadButton<UploadResult> kind="outline" label="Upload it" to={f => `/api/v1/content?gameId=${view.gameId}${view.wayId ? `&wayId=${view.wayId}` : ""}&name=${encodeURIComponent(f.name)}`}
              onError={msg => setError(sentence(msg))}
              onDone={(r, f) => {
                setError(null);
                const mine = r.checks?.find(c => c.wayId === view.wayId);
                if (mine && !mine.ok) setError(`${f.name} is kept, but it is ${mine.why ?? "not the file this way needs"}.`);
                else toast(<>Kept <b>{r.item.name}</b>: ludarr takes it from there</>, "success");
                onChanged();
              }} />
          )}
          {m.accept && view.wayId && <Btn size="sm" kind="warning" icon="check" busy={busy === "accept"} disabled={!!busy} onClick={() => void accept()}>Accept it</Btn>}
          {m.go && <Btn size="sm" kind="success" icon="play" busy={busy === "go"} disabled={!!busy} onClick={() => answer("go", { go: true }, "Going ahead")}>Go ahead</Btn>}
          {m.go && <Btn size="sm" kind="outline" busy={busy === "no"} disabled={!!busy} onClick={() => void notNow()}>Not now</Btn>}
          {m.link && <Link className="btn sm outline" to={m.link.to}>{m.link.label}</Link>}
          {m.retry && <Btn size="sm" kind="outline" icon="refresh" busy={busy === "retry"} disabled={!!busy} onClick={retry}>Look again now</Btn>}
        </div>
      )}
      {m.watching && <div className="ask-watch"><Icon name="eye" size={12} /> {m.watching}</div>}
      {view.state !== "held" && (telling ? (
        <div className="ask-tell">
          <div className="ask-sub">What is wrong, and what to do instead</div>
          <textarea className="textarea prose" rows={3} value={told} onChange={e => setTold(e.target.value)} autoFocus maxLength={2000} aria-label="What is wrong, and what to do instead" />
          <div className="acts">
            <Btn size="sm" kind="accent" icon="sparkles" busy={busy === "tell"} disabled={!!busy || !told.trim()} onClick={() => void tell()}>Tell the AI</Btn>
            <Btn size="sm" kind="outline" disabled={!!busy} onClick={() => setTelling(false)}>Cancel</Btn>
          </div>
        </div>
      ) : (
        <div className="acts"><Btn size="sm" kind="outline" icon="sparkles" disabled={!!busy} onClick={() => setTelling(true)}>This is wrong</Btn></div>
      ))}
      {m.pick && view.gameId && (
        <ServerPathModal open={pathOpen} onClose={() => setPathOpen(false)} title={<>{view.gameName ?? "The game"} — its game data on the server</>}
          intro={ask.title}
          help={folder ? "The game data as the server sees it: a file or a folder in the downloads folder, a root folder or a download client's mapped folder. It stays where it is." : undefined}
          placeholder={folder ? "/downloads/the game folder" : undefined}
          start={p => post<{ job: JobView }>("/api/v1/content/path", { path: p, gameId: view.gameId, ...(view.wayId ? { wayId: view.wayId } : {}) })}
          onDone={j => {
            if (jobEnd(j) === "warn" || j.state !== "done") toast(<>{sentence(j.message ?? j.state)}</>, "warning");
            else toast(<>{sentence(j.message ?? "taken in")}: ludarr takes it from there</>, "success");
            onChanged();
          }} />
      )}
    </div>
  );
}

/** a run on hold since the admin cancelled its job: Resume carries on (POST /run/:id/retry) */
function Held({ view, onChanged }: { view: RunView; onChanged: () => void }) {
  const { busy, press } = useRunPress(onChanged);
  const why = [...(view.steps ?? [])].reverse().find(s => s.who === "admin")?.text;
  return (
    <div className="held">
      <Icon name="clock" size={15} />
      <span className="grow">On hold: {why ? why.replace(/[.\s]+$/, "") : "you cancelled what it was doing"}.</span>
      <Btn size="sm" kind="primary" icon="play" busy={busy === "resume"} onClick={() => void press("resume", () => post(`/api/v1/run/${view.id}/retry`), "Carrying on")}>Resume</Btn>
    </div>
  );
}

/* ─────────── what it did ─────────── */

/** an AI round: its summary and what it changed in the plan, read when opened; its whole timeline behind the log */
function AiRound({ jobId, onLog }: { jobId: number; onLog: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const { job, error } = useJob(open ? jobId : null);
  const m = (job?.manifest ?? null) as ConstructManifest | null;
  const diff = Array.isArray(m?.diff) ? m!.diff! : [];
  return (
    <div className="fold">
      <div className="fold-line">
        <button type="button" className="fold-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name={open ? "chevronDown" : "chevronRight"} size={13} />What the AI changed</button>
        <button type="button" className="fold-toggle" onClick={() => onLog(jobId)}><Icon name="terminal" size={13} />What the AI did</button>
      </div>
      {open && (
        <div className="fold-body">
          {!job ? (error ? <div className="err-line">{error}</div> : <div className="dim"><Icon name="spinner" size={12} /> Reading the round…</div>) : (
            <>
              {job.message && <div className="say-text">{sentence(job.message.split("\n")[0])}</div>}
              {m?.changed?.length ? <div className="dim" style={{ marginTop: 4 }}>Changed: {m.changed.join(", ")}</div> : null}
              {diff.map((d, i) => (
                <div key={i} className="diff">
                  <div className="diff-field">{d.field}</div>
                  <div className="diff-cols">
                    <div><div className="dim">before</div><pre className="log">{d.before === undefined ? "—" : JSON.stringify(d.before, null, 2)}</pre></div>
                    <div><div className="dim">after</div><pre className="log">{d.after === undefined ? "—" : JSON.stringify(d.after, null, 2)}</pre></div>
                  </div>
                </div>
              ))}
              {!diff.length && !m?.changed?.length && <div className="dim" style={{ marginTop: 4 }}>{m?.ask ? "It changed nothing, and asked you instead." : "It changed nothing in the plan."}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ s, nowSec, onLog }: { s: RunStep; nowSec: number; onLog: (id: number) => void }) {
  const look = stepIcon(s);
  return (
    <div className={`tl-step run-step ${look.tone}${s.who === "ai" ? " ai" : s.who === "admin" ? " you" : ""}`}>
      <span className="t">{stepTime(s.at, nowSec)}</span>
      <div className="main">
        <div className="head"><Icon name={look.icon} size={13} className="st" /><span className="who">{whoWord(s.who)}</span><span className="what">{sentence(s.text)}</span></div>
        {s.proof && <div className="proof">{s.proof}</div>}
        {s.who === "ai" && s.jobId ? <AiRound jobId={s.jobId} onLog={onLog} />
          : (s.jobId || s.requestId) ? (
            <div className="tl-folds">
              {s.jobId && <button type="button" className="fold-toggle" onClick={() => onLog(s.jobId!)}><Icon name="terminal" size={13} />Its log (job {s.jobId})</button>}
              {s.requestId && <Link className="fold-toggle" to="/activity/queue"><Icon name="search" size={13} />The search (request {s.requestId})</Link>}
            </div>
          ) : null}
      </div>
    </div>
  );
}

/** the run's steps, oldest first: when, who ("ludarr", "the AI", "you"), what, how it ended and its proof */
export function RunSteps({ steps, onLog }: { steps: RunStep[]; onLog: (id: number) => void }) {
  if (!steps.length) return <p className="dim">Nothing yet.</p>;
  const nowSec = Date.now() / 1000;
  return <div className="timeline run-steps">{steps.map((s, i) => <StepRow key={i} s={s} nowSec={nowSec} onLog={onLog} />)}</div>;
}

/** the check of the run's build: the run's own copy of it, else the one its build's job recorded */
export function RunCheck({ view }: { view: RunView }) {
  const jobId = view.check ? null : checkJobOf(view.steps);
  const { data } = useLoad(() => (jobId ? get<{ item: JobView }>(`/api/v1/import/${jobId}`).catch(() => null) : Promise.resolve(null)), [jobId]);
  const report = view.check ?? checkOfTrace(data?.item.trace);
  if (!report) return null;
  return <div className="run-sec"><h5>The check</h5><CheckView report={report} /></div>;
}

/* ─────────── a whole run ─────────── */

export function RunHead({ view }: { view: RunView }) {
  const look = runLook(view);
  const budget = budgetLine(view.budget);
  return (
    <div className="jobhead">
      <div className="row wrap">
        <Label tone={look.tone}>{look.label}</Label>
        <span>{view.gameName ? <><Link to={`/games/${view.gameId}?tab=ways`}>{view.gameName}</Link> through </> : "Through "}<b>{view.planName}</b></span>
        <span className="grow" />
        <span className="dim">{startedWords(view.startedBy, view.wayId)} {timeAgo(view.createdAt)}</span>
      </div>
      {budget && <div className="dim" style={{ marginTop: 6 }}>{budget}</div>}
    </div>
  );
}

/** how a run that ended ended: the last thing it said */
function Ended({ view }: { view: RunView }) {
  const last = [...(view.steps ?? [])].reverse().find(s => s.who !== "admin" || view.state === "stopped");
  if (view.state === "done") return <Callout tone="success">{last ? sentence(last.text) : "Done: the game is playable."}</Callout>;
  return <Callout tone="info">Stopped{last ? `: ${last.text.replace(/[.\s]+$/, "")}` : ""}.</Callout>;
}

/** the rail, what it does now, what it asks (or why it waits, or how it ended), the check, and its steps */
export function RunBody({ view, tick, onChanged, onLog }: { view: RunView; tick: JobView | null; onChanged: () => void; onLog: (id: number) => void }) {
  return (
    <div className="run-body">
      <RunRail view={view} />
      <RunNow view={view} tick={tick} onLog={onLog} onChanged={onChanged} />
      {view.state === "held" && !view.ask && <Held view={view} onChanged={onChanged} />}
      <AskCard view={view} onChanged={onChanged} />
      {!runOpen(view.state) && <Ended view={view} />}
      <RunCheck view={view} />
      <div className="run-sec"><h5>What it did</h5><RunSteps steps={view.steps ?? []} onLog={onLog} /></div>
    </div>
  );
}

/** the run in a dialog: its head, its body, Stop, and the way to its game */
export function RunModal({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged?: () => void }) {
  const { run, tick, error, missing, reload } = useRun(id);
  const [logId, setLogId] = useState<number | null>(null);
  const { confirm } = useUi();
  const changed = () => { reload(); onChanged?.(); };
  const { busy, press } = useRunPress(changed);
  const stop = async () => {
    if (!run || !(await confirm(run.gameName ? `Stop making ${run.gameName} playable?` : `Stop the run of ${run.planName}?`, "Its queued and running jobs are cancelled. The way to play and the files kept for it stay: Make it playable starts it again.", { ok: "Stop", kind: "danger" }))) return;
    await press("stop", () => post(`/api/v1/run/${run.id}/stop`), "Stopped");
  };
  // a run that has no game yet is about the plan: the game is what it asks about
  const title = !run ? "Making it playable" : run.gameName ? <>Making {run.gameName} playable</> : <>Making a game playable through {run.planName}</>;
  return (
    <>
      <Modal open={id != null} onClose={onClose} wide title={title}
        foot={<>
          <span className="left">{run && runOpen(run.state) && <Btn kind="danger" icon="x" busy={busy === "stop"} onClick={() => void stop()}>Stop</Btn>}</span>
          {run?.gameId && <Link className="btn" to={`/games/${run.gameId}?tab=ways`} onClick={onClose}>Open the game</Link>}
          <Btn onClick={onClose}>Close</Btn>
        </>}>
        {!run ? (missing ? <Callout tone="info">{NOT_YET}</Callout> : error ? <Empty title="Could not load the run" icon="alert">{error}</Empty> : <Spinner text="Loading the run…" />)
          : <><RunHead view={run} /><RunBody view={run} tick={tick} onChanged={changed} onLog={setLogId} /></>}
      </Modal>
      <JobLogModal id={logId} onClose={() => setLogId(null)} />
    </>
  );
}

/** the run as a way listing names it, enough for its ask's card until the run itself is read */
function seedView(seed: WayRun, at: { planId: number; planName: string; gameId: number; gameName: string; wayId: number }): RunView {
  return {
    id: seed.id, ...at, phase: seed.phase, state: seed.state, rail: [], now: null, ask: seed.ask,
    budget: { rounds: 0, roundsUsed: 0, tokens: 0, tokensUsed: 0 }, nextAt: null, startedBy: "way", createdAt: 0, updatedAt: 0, doneAt: null,
  };
}

/**
 * A way's run on its card: the compact rail, what it does now, what it asks, and the way to the whole run. `view` is
 * the run as useRun keeps it (null until it is read: the listing's `seed` stands in, its ask with its controls at once).
 */
export function RunPanel({ seed, view, tick, onChanged, onLog, onOpen, at }: {
  seed: WayRun; view: RunView | null; tick: JobView | null; onChanged: () => void; onLog: (id: number) => void; onOpen: () => void;
  /** the way the run is of, as the card knows it */
  at: { planId: number; planName: string; gameId: number; gameName: string; wayId: number };
}) {
  const look = runLook(view ?? seed);
  return (
    <div className="part run-part">
      <div className="run-part-head">
        <h5>Making it playable</h5><Label tone={look.tone}>{look.label}</Label><span className="grow" />
        <button type="button" className="linkish" onClick={onOpen}>Open the run</button>
      </div>
      {!view ? (seed.ask && runOpen(seed.state) ? <AskCard view={seedView(seed, at)} onChanged={onChanged} /> : <div className="dim">Reading the run…</div>) : (
        <>
          <RunRail view={view} compact />
          <RunNow view={view} tick={tick} onLog={onLog} onChanged={onChanged} />
          {view.state === "held" && !view.ask && <Held view={view} onChanged={onChanged} />}
          <AskCard view={view} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}
