import { useState } from "react";
import { post, type JobView } from "../api";
import { Btn, Fold } from "./kit";

type Action = { tool: string; input: Record<string, unknown>; output?: string | null };
interface Decision {
  model: string; mode: "replay" | "recovery"; proposed: Action[]; recorded: Action[]; text: string;
  comparison: "same" | "different" | "no-baseline"; omitted: number; shortened: boolean; reconstructed: boolean;
  usage: { input: number; output: number; estimated: boolean }; stopReason: string;
}
interface ExerciseResult {
  model: string; passed: boolean; expected: string; summary: string; turns: number; inputTokens: number; outputTokens: number; steps: Action[];
}
function Actions({ actions }: { actions: Action[] }) {
  return <>{actions.map((a, i) => <Fold key={i} label={a.tool}><pre className="log">{JSON.stringify(a.input, null, 2)}{a.output != null ? "\n\n" + a.output : ""}</pre></Fold>)}</>;
}

function TrialInstruction({ value, change, disabled }: { value: string; change: (v: string) => void; disabled: boolean }) {
  return <label className="field">Instruction to test (optional)
    <textarea className="textarea" rows={2} maxLength={2000} value={value} disabled={disabled} onChange={e => change(e.target.value)} />
  </label>;
}

export function JobSimulation({ job }: { job: JobView }) {
  const trace = job.trace ?? [];
  const first = trace.map(s => s.kind === "brief" && !!s.text).lastIndexOf(true);
  const turns = first === -1 ? [] : [...new Set(trace.slice(first + 1).filter(s => (s.kind === "tool" || s.kind === "say") && s.turn > 0).map(s => s.turn))];
  const [choice, setChoice] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Decision | null>(null);
  if (!["done", "failed", "cancelled"].includes(job.state) || (first < 0 && job.state !== "failed")) return null;
  const turn = choice ?? turns.at(-1) ?? 1;
  async function run() {
    setBusy(true); setError(""); setResult(null);
    try { setResult((await post<{ item: Decision }>(`/api/v1/import/${job.id}/simulate`, { turn, instruction: note })).item); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <Fold label="Simulate this job">
    <p>{first >= 0 ? "Give the current AI the observations it had before a recorded turn and compare its next move." : "Give the current AI this failure log and see which recovery step it proposes."} Each trial uses one model call. Every proposed action stays on this screen.</p>
    {turns.length > 0 && <label className="field">Start before turn
      <select className="select" value={turn} disabled={busy} onChange={e => { setChoice(Number(e.target.value)); setResult(null); }}>
        {turns.map(n => <option key={n} value={n}>{n}</option>)}
      </select></label>}
    <TrialInstruction value={note} disabled={busy} change={v => { setNote(v); setResult(null); }} />
    <Btn size="sm" busy={busy} onClick={() => void run()}>Simulate decision</Btn>
    {error && <p role="alert" className="test-result bad">{error}</p>}
    {result && <div aria-live="polite">
      <p><b>{result.comparison === "same" ? "Same tool calls as the recording" : result.comparison === "different" ? "Different decision" : "Proposed decision"}</b>
        {" · "}{result.model} · {result.usage.estimated ? "about " : ""}{(result.usage.input + result.usage.output).toLocaleString()} tokens</p>
      {result.text && <pre className="log">{result.text}</pre>}
      {result.proposed.length > 0 ? <Actions actions={result.proposed} /> : <p>The model proposed no tool call.</p>}
      {result.recorded.length > 0 && <Fold label="Original tool calls and results"><Actions actions={result.recorded} /></Fold>}
      {result.stopReason === "max_tokens" && <p className="dim">The response reached its output limit.</p>}
      {(result.shortened || result.omitted > 0) && <p className="dim">Context shortened for this trial{result.omitted > 0 ? ` · ${result.omitted} earlier turns omitted` : ""}.</p>}
      {result.reconstructed && result.mode === "replay" && <p className="dim">This older recording uses current toolbox settings and omits historical lessons.</p>}
    </div>}
  </Fold>;
}

export function ImportPractice() {
  const [exercise, setExercise] = useState("reuse-extracted"), [caller, setCaller] = useState("reference");
  const [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<ExerciseResult | null>(null);
  async function run() {
    setBusy(true); setError(""); setResult(null);
    try { setResult((await post<{ item: ExerciseResult }>("/api/v1/simulation/import", { exercise, caller, instruction: note })).item); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <section className="card"><h3>Import simulator</h3>
    <p>Run the importer and its validator on disposable sample files. Each exercise starts fresh. Game downloads and the library stay untouched.</p>
    <div className="row wrap">
      <label>Sample <select className="select" disabled={busy} value={exercise} onChange={e => { setExercise(e.target.value); setResult(null); }}>
        <option value="reuse-extracted">Already extracted game</option><option value="incomplete-release">Release missing its game files</option>
      </select></label>
      <label>Agent <select className="select" disabled={busy} value={caller} onChange={e => { setCaller(e.target.value); setResult(null); }}>
        <option value="reference">Scripted reference (free)</option><option value="model">Configured AI (up to 6 calls)</option>
      </select></label>
    </div>
    {caller === "model" && <TrialInstruction value={note} disabled={busy} change={v => { setNote(v); setResult(null); }} />}
    <Btn size="sm" busy={busy} onClick={() => void run()}>Run sample import</Btn>
    {error && <p role="alert" className="test-result bad">{error}</p>}
    {result && <div aria-live="polite"><p className={`test-result ${result.passed ? "ok" : "bad"}`}><b>{result.passed ? "Passed" : "Failed"}</b> · {result.expected}</p>
      <p>{result.summary}</p><div className="dim">{result.model} · {result.turns} turns · {(result.inputTokens + result.outputTokens).toLocaleString()} tokens</div>
      <Fold label="Tool calls and results"><Actions actions={result.steps} /></Fold></div>}
    <p className="dim">To simulate a specific failure, open its job log and choose “Simulate this job”.</p>
  </section>;
}
