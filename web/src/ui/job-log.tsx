/**
 * Jobs as they run: a hook that keeps one job current (its 'build' and 'job' events as they come, the full record with
 * the log and the AI's steps re-read every two seconds while it runs and once more just after it ends), the timeline of
 * those steps, the modal that shows a job, and a one-line progress for jobs started from a form.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtDur, get, getBlob, post, timeAgo, type JobView, type TraceStep } from "../api";
import { onConnection, subscribe } from "../events";
import { Icon } from "./icons";
import { Btn, Empty, Fold, Label, Modal, Progress, Spinner, useUi, type Tone } from "./kit";
import { JOB_KIND, jobActive, jobState, tierLabel } from "./status";
import { JobSimulation } from "./job-simulation";
import { followJob } from "./job-follow";
import { CheckView } from "./check-view";
import { fmtClock, jobEnd, sayWho, shotUrl, smokeShots, toolLine, tryPlanVerdict, type PlanVerdict } from "../ways/logic";

/** one job, kept current while it is on screen (job-follow.ts says when it is read) */
export function useJob(id: number | null, every = 2000) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setJob(null); setError(null);
    if (id == null) return;
    return followJob(id, {
      every, subscribe, onConnection,
      load: async jobId => (await get<{ item: JobView }>(`/api/v1/import/${jobId}`)).item,
      onJob: (j, full) => { setJob(j); if (full) setError(null); },
      onError: setError,
    });
  }, [id, every, tick]);
  return { job, error, reload: () => setTick(t => t + 1) };
}

/** a job waiting for its turn (or for scratch space, which the runner says in its message) */
export function Queued({ job }: { job: Pick<JobView, "message"> }) {
  return <span className="dim"><Icon name="clock" size={12} /> Queued{job.message ? ` · ${job.message}` : ""}</span>;
}

/** stop a job: a queued one never starts, a running one is aborted */
export async function cancelJob(id: number): Promise<string> {
  const r = await post<{ stopping?: boolean }>(`/api/v1/jobs/${id}/cancel`);
  return r?.stopping ? "Stopping it" : "Cancelled";
}

export function JobHead({ job, title }: { job: JobView; title?: ReactNode }) {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const st = jobState(job.state);
  const active = jobActive(job.state);
  const kind = job.kind ?? "import";
  const cancel = async () => {
    setBusy(true);
    try { toast(await cancelJob(job.id)); } catch (e: any) { toast(e.message, "danger"); } finally { setBusy(false); }
  };
  return (
    <div className="jobhead">
      <div className="row wrap">
        {title && <b className="jobtitle">{title}</b>}
        <Label tone="outline">{JOB_KIND[kind] ?? kind}</Label>
        <Label tone={st.tone}>{st.label}</Label>
        {kind === "import" && job.tier && <Label tone={job.tier === "agent" ? "accent" : "dim"}>{tierLabel(job.tier)}</Label>}
        <span className="grow" />
        <span className="dim">started {timeAgo(job.createdAt)}{job.doneAt ? ` · took ${fmtDur((job.doneAt - job.createdAt) * 1000)}` : ""}</span>
        {active && <Btn size="sm" kind="outline" icon="x" busy={busy} onClick={() => void cancel()}>Cancel</Btn>}
      </div>
      {job.state === "queued" ? <div style={{ marginTop: 8 }}><Queued job={job} /></div>
        : active ? <div style={{ marginTop: 8 }}><Progress value={job.progress} tone="queue" text={`${Math.round(job.progress * 100)}%${job.message ? ` · ${job.message}` : ""}`} /></div>
        : job.message && <div className={`test-result ${job.state === "done" ? jobEnd(job) : job.state === "failed" ? "bad" : ""}`} style={{ marginTop: 8, maxWidth: "none" }}>
          <Icon name={jobEnd(job) === "ok" ? "check" : job.state === "cancelled" ? "info" : "alert"} size={13} /> {job.message.split("\n")[0]}
        </div>}
    </div>
  );
}

/** "What the AI importer learned": the lesson a run left for the next one */
export function LessonCard({ lesson }: { lesson: any }) {
  if (!lesson || !(lesson.recognize || lesson.steps?.length || lesson.pitfalls)) return null;
  return (
    <div className="card lesson">
      <b>What the AI importer learned</b>
      {lesson.recognize && <div className="dim" style={{ marginTop: 4 }}>{lesson.recognize}</div>}
      {Array.isArray(lesson.steps) && lesson.steps.length > 0 && <pre className="log" style={{ marginTop: 8, maxHeight: 200 }}>{lesson.steps.join("\n")}</pre>}
      {lesson.pitfalls && <div className="dim" style={{ marginTop: 6 }}>Watch out: {lesson.pitfalls}</div>}
    </div>
  );
}

function VerdictLine({ v }: { v: PlanVerdict }) {
  if (v.ok === null && !v.problems.length && !v.warnings.length) return null;
  return (
    <div className={`verdict${v.ok === true ? " ok" : v.ok === false ? " bad" : ""}`}>
      {v.ok !== null && <div className="row"><Icon name={v.ok ? "check" : "alert"} size={13} />{v.ok ? "The plan worked" : "The plan does not work yet"}</div>}
      {v.problems.length > 0 && <ul>{v.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      {v.warnings.length > 0 && <ul className="warn">{v.warnings.map((p, i) => <li key={i}>{p}</li>)}</ul>}
    </div>
  );
}

const lineCount = (s: string) => s.split("\n").length;

/** what the window showed at a dry run's smoke start: fetched with the API key in the header (an image address would
 *  have to carry the key), shown from an object URL that goes when the step does */
function SmokeShot({ jobId, n }: { jobId: number; n: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setUrl(null); setGone(false);
    let alive = true;
    const shot = shotUrl(jobId, n, getBlob);
    void shot.ready.then(u => { if (!alive) return; if (u) setUrl(u); else setGone(true); });
    return () => { alive = false; shot.stop(); };
  }, [jobId, n]);
  if (gone) return <div className="dim smoke-note">The smoke start's screenshot is not kept any more.</div>;
  if (!url) return <div className="dim smoke-note"><Icon name="spinner" size={12} /> Loading the smoke start's screenshot…</div>;
  return <a className="smoke-shot" href={url} target="_blank" rel="noreferrer" title="Open it full size"><img src={url} alt="The program's window at the smoke start" /></a>;
}

function ToolStep({ s }: { s: TraceStep }) {
  const [open, setOpen] = useState<"input" | "output" | null>(null);
  const verdict = s.tool === "try_plan" ? tryPlanVerdict(s.output) : null;
  const shots = s.tool === "try_plan" ? smokeShots(s.output) : [];
  const finish = s.tool === "finish";
  const look = verdict ? (verdict.ok === true ? "ok" : verdict.ok === false ? "bad" : "") : finish ? (s.input?.ok === false ? "bad" : "ok") : "";
  const tone: Tone = s.tool === "try_plan" ? "accent" : finish ? (s.input?.ok === false ? "danger" : "success") : "outline";
  const hasInput = !!s.input && Object.keys(s.input).length > 0;
  return (
    <div className={`tl-step tool${look ? " " + look : ""}`}>
      <span className="t">{fmtClock(s.t)}</span>
      <div className="main">
        <div className="head"><Label tone={tone}>{s.tool ?? "tool"}</Label><span className="what">{toolLine(s)}</span><span className="grow" />{s.ms != null && <span className="dim nowrap">{fmtDur(s.ms)}</span>}</div>
        {verdict && <VerdictLine v={verdict} />}
        {shots.map(x => <SmokeShot key={`${x.jobId}-${x.n}`} jobId={x.jobId} n={x.n} />)}
        {(hasInput || s.output) && (
          <div className="tl-folds">
            {hasInput && <button type="button" className="fold-toggle" aria-expanded={open === "input"} onClick={() => setOpen(o => (o === "input" ? null : "input"))}><Icon name={open === "input" ? "chevronDown" : "chevronRight"} size={13} />Input</button>}
            {s.output && <button type="button" className="fold-toggle" aria-expanded={open === "output"} onClick={() => setOpen(o => (o === "output" ? null : "output"))}><Icon name={open === "output" ? "chevronDown" : "chevronRight"} size={13} />Output ({lineCount(s.output)} line{lineCount(s.output) === 1 ? "" : "s"})</button>}
          </div>
        )}
        {open === "input" && <pre className="log">{JSON.stringify(s.input, null, 2)}</pre>}
        {open === "output" && <pre className="log">{s.output}</pre>}
      </div>
    </div>
  );
}

function Step({ s }: { s: TraceStep }) {
  if (s.kind === "tool") return <ToolStep s={s} />;
  if (s.kind === "brief") return (
    <div className="tl-step brief"><span className="t">{fmtClock(s.t)}</span><div className="main"><Fold label="What the AI importer was told"><pre className="log">{s.text}</pre></Fold></div></div>
  );
  if (s.kind === "say") return (
    <div className={`tl-step say${s.turn === 0 ? " own" : ""}`}><span className="t">{fmtClock(s.t)}</span><div className="main"><div className="who">{sayWho(s)}</div><div className="say-text">{s.text}</div></div></div>
  );
  // an assemble job's check (src/ways/types.ts CheckTraceStep): the verdict, each step, the smoke start and its screenshot
  if (s.kind === "check" && s.report && Array.isArray(s.report.steps)) {
    const tone = s.report.verdict === "pass" ? " ok" : s.report.verdict === "fail" ? " bad" : "";
    return <div className={`tl-step tl-check${tone}`}><span className="t">{s.t != null ? fmtClock(s.t) : ""}</span><div className="main"><div className="who">The check</div><CheckView report={s.report} /></div></div>;
  }
  // a step of a kind this page does not know yet (the deterministic part of a run, for one) is shown as it is
  return (
    <div className="tl-step"><span className="t">{fmtClock(s.t)}</span><div className="main"><div className="say-text">{s.text ?? JSON.stringify(s)}</div></div></div>
  );
}

/** the steps of a run (when it has any), then its log; a job without steps shows its log open */
export function JobTimeline({ job }: { job: JobView }) {
  const steps = Array.isArray(job.trace) ? job.trace : [];
  const log = (job.transcript ?? "").trimEnd();
  const lines = log ? log.split("\n").length : 0;
  return (
    <div className="joblog">
      <JobSimulation key={job.id} job={job} />
      <LessonCard lesson={job.lesson} />
      {steps.length > 0 && (
        <div className="timeline">
          {steps.map((s, i) => <Step key={i} s={s} />)}
          {jobActive(job.state) && <div className="tl-step live"><span className="t"><Icon name="spinner" size={13} /></span><div className="main dim">{job.message || "Working…"}</div></div>}
        </div>
      )}
      {steps.length > 0
        ? log && <Fold label={`The job's log (${lines} line${lines === 1 ? "" : "s"})`}><pre className="log">{log}</pre></Fold>
        : <pre className="log">{log || (jobActive(job.state) ? "Waiting for the first line…" : job.message || "No log.")}</pre>}
    </div>
  );
}

export function JobLogModal({ id, onClose, title }: { id: number | null; onClose: () => void; title?: ReactNode }) {
  const { job, error } = useJob(id);
  const kind = job?.kind ?? "import";
  return (
    <Modal open={id != null} onClose={onClose} wide title={title ?? <>{JOB_KIND[kind] ?? "Job"} — #{id}</>} foot={<Btn onClick={onClose}>Close</Btn>}>
      {!job ? (error ? <Empty title="Could not load the job" icon="alert">{error}</Empty> : <Spinner text="Loading the log…" />)
        : <><JobHead job={job} /><JobTimeline job={job} /></>}
    </Modal>
  );
}

/** a job started from a form, in one line: its progress while it runs, then how it ended (`onDone` once, with the final job) */
export function JobLine({ id, onDone }: { id: number; onDone?: (job: JobView) => void }) {
  const { job } = useJob(id, 3000);
  const reported = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (job && !jobActive(job.state) && !reported.current) { reported.current = true; done.current?.(job); }
  }, [job]);
  if (!job) return <span className="dim"><Icon name="spinner" size={12} /> Starting…</span>;
  if (job.state === "queued") return <Queued job={job} />;
  if (jobActive(job.state)) return <Progress value={job.progress} tone="queue" text={`${Math.round(job.progress * 100)}%${job.message ? ` · ${job.message}` : ""}`} />;
  return <JobResult job={job} />;
}

/** how a finished job ended, in one line: done, done with a warning (a file kept that does not fit its way), or not */
export function JobResult({ job }: { job: Pick<JobView, "state" | "message"> }) {
  const end = jobEnd(job);
  return <span className={`test-result ${end}`}><Icon name={end === "ok" ? "check" : "alert"} size={12} /> {job.message ?? job.state}</span>;
}
