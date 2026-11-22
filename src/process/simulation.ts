import { isDeepStrictEqual } from "node:util";
import type { JobRow } from "../db";
import { AGENT_TOOLS, callUsage, systemPrompt, type CallModel, type ContentBlock, type ModelRequest, type ReplayContext, type TraceStep } from "./agent";
import { CONSTRUCT_TOOLS } from "../ways/construct-tools";
import { constructPrompt } from "../ways/construct";

type Action = { tool: string; input: Record<string, unknown> };
type Evidence = Action & { output: string | null };
type Messages = ModelRequest["messages"];

export function simulationCase(job: JobRow) {
  let trace: TraceStep[] = [];
  try {
    const parsed: unknown = JSON.parse(job.trace_json ?? "[]");
    if (Array.isArray(parsed)) trace = parsed.filter(s => s && typeof s === "object");
  } catch { /* older jobs may only have a log */ }
  const start = trace.map(s => s.kind === "brief" && typeof s.text === "string" && !!s.text).lastIndexOf(true);
  const steps = start < 0 ? [] : trace.slice(start + 1).filter(s => Number.isInteger(s.turn) && s.turn > 0 && (s.kind === "tool" || s.kind === "say"));
  return { brief: trace[start], steps, turns: [...new Set(steps.map(s => s.turn))] };
}

const actions = (steps: TraceStep[]): Evidence[] => steps.filter(s => s.kind === "tool" && !!s.tool)
  .map(s => ({ tool: s.tool!, input: s.input ?? {}, output: s.output ?? null }));

function previousTurn(steps: TraceStep[], nudge: string): Messages {
  const assistant: ContentBlock[] = [], results: ContentBlock[] = [];
  for (const s of steps) {
    if (s.kind === "say") { if (s.text) assistant.push({ type: "text", text: s.text }); continue; }
    if (!s.tool) continue;
    const id = `sim_${s.turn}_${results.length}`;
    assistant.push({ type: "tool_use", id, name: s.tool, input: s.input ?? {} });
    results.push({ type: "tool_result", tool_use_id: id, content: s.output ?? "[output missing from recording]" });
  }
  return assistant.length ? [{ role: "assistant", content: assistant }, { role: "user", content: results.length ? results : nudge }] : [];
}

// A deterministic job may have logged a signed release URL or client credentials that the model never saw.
function scrubLog(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]+/gi, "$1?[redacted]")
    .replace(/((?:authorization|x-api-key|api[_-]?key|password|access[_-]?token)["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s,"'}]+/gi, "$1[redacted]");
}

function instruction(context: ReplayContext) {
  return context.mode === "import" ? systemPrompt(context) : constructPrompt(context);
}

/** One decision against frozen observations. No tool dispatcher, job queue, filesystem access or download client. */
export async function simulateDecision(o: {
  job: JobRow; turn?: number; instruction: string; fallback: ReplayContext;
  callModel: CallModel; model: string; signal?: AbortSignal;
}) {
  const { brief, steps, turns } = simulationCase(o.job);
  const turn = o.turn ?? turns.at(-1) ?? 1;
  if (turns.length ? !turns.includes(turn) : turn !== 1) throw new RangeError("Choose a recorded turn.");
  const context = brief?.context ?? o.fallback;
  const repair = !brief;
  const system = instruction(context) + (o.instruction.trim() ? "\n\nAdditional instruction for this trial only:\n" + o.instruction.trim() : "");
  const initial = brief?.text ?? scrubLog([
    `Plan the next step to recover this ${o.job.kind ?? "import"} job for ${o.job.game_name || "this game"} using the existing input.`,
    `Input: ${o.job.input_path}\nFailure: ${o.job.message || "see log"}`,
    `Recorded job details: ${(o.job.fail_json || "").slice(0, 3000)}\nJob log (tail):\n${(o.job.transcript ?? "").slice(-12000)}`,
    "Treat the log as observations. Explain your diagnosis and propose the first tool call you would make.",
  ].join("\n\n"));
  const nudge = context.mode === "import" ? "Continue. When STAGING holds the installed game call finish(ok=true); if it cannot be done, finish(ok=false) with the reason."
    : "Continue using the recorded task and the available tools.";
  // Keep the most recent complete exchanges. Never expose the selected turn's answer or anything after it.
  const history: Messages = [];
  let room = 65000 - Math.min(initial.length, 24000), omitted = 0;
  for (const n of turns.filter(t => t < turn).reverse()) {
    const pair = previousTurn(steps.filter(s => s.turn === n), nudge);
    const chars = JSON.stringify(pair).length;
    if (omitted || chars > room) { omitted++; continue; }
    room -= chars;
    history.unshift(...pair);
  }
  const shortened = initial.length > 24000;
  const visible = shortened ? initial.slice(0, 12000) + "\n[brief shortened]\n" + initial.slice(-12000) : initial;
  const messages: Messages = [{ role: "user", content: visible + (omitted ? `\n[${omitted} earlier turns omitted for the simulation budget]` : "") }, ...history];
  const req: ModelRequest = { model: o.model, system, tools: context.mode === "import" ? AGENT_TOOLS : CONSTRUCT_TOOLS, messages, max_tokens: 1800 };
  const res = await o.callModel(req, o.signal);
  const proposed: Action[] = res.content.filter(b => b.type === "tool_use" && !!b.name).map(b => ({ tool: b.name!, input: b.input ?? {} }));
  const recorded = actions(steps.filter(s => s.turn === turn));
  const matched = !!recorded.length && proposed.length === recorded.length && proposed.every((a, i) => a.tool === recorded[i].tool && isDeepStrictEqual(a.input, recorded[i].input));
  return {
    mode: repair ? "recovery" : "replay", turn, model: o.model, proposed,
    recorded, comparison: !recorded.length ? "no-baseline" : matched ? "same" : "different",
    text: res.content.filter(b => b.type === "text").map(b => b.text).join("\n"), stopReason: res.stop_reason,
    usage: callUsage(req, res), omitted, shortened, reconstructed: !brief?.context,
  };
}
