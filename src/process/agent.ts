/**
 * ludarr — the AI agents: one loop and the modes that use it.
 *
 *   runLoop     a model with tools: the brief, then turn after turn of tool calls until a tool says it is done, within
 *               a turn and a minute budget, one nudge when the model stops without finishing, every step traced in full
 *               (the transcript keeps a short line per step), and the oldest tool results cut to their first line once
 *               the conversation grows past about 100k tokens (the trace keeps them whole). It counts the tokens every
 *               call spends (the API's own count, or the request and answer measured at 4 characters a token when it
 *               gives none), stops before the next call once a token budget is spent, and hands every tool call — and
 *               the model's own call — a signal that fires at the minute budget, so a long shell command, a dry run or a
 *               request that hangs stops there too
 *   runAgent    the AI importer (import mode): spawned when the recipes could not produce a game folder. It gets a shell
 *               inside the job's work directory, the toolbox (7z, innoextract, wine under xvfb …), the release notes, and
 *               one brief: make STAGING hold the installed game. It checks itself with the same validator and must call
 *               `finish`; the runner validates once more. `finish` carries a lesson (how to recognise this download, the
 *               steps that worked).
 *   the construct mode lives with its tools in src/ways/construct.ts: a repo to turn into a runtime plan.
 *
 * Talks to the Anthropic Messages API directly (tool use); `callModel` is injectable for tests.
 */
import { realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { PORTABILITY_INSTRUCTION } from "./portability";
import { inspect, type Validation } from "./validate";
import { describeToolbox, type Exec, type Toolbox } from "./tools";
import { scan } from "./classify";

/** a part of a tool result: its text, or an image (the construct agent's smoke start sends a screenshot) */
export interface TextPart { type: "text"; text: string }
export interface ImagePart { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg"; data: string } }
export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string; id?: string; name?: string; input?: Record<string, unknown>;
  tool_use_id?: string; content?: string | (TextPart | ImagePart)[]; is_error?: boolean;
}
export interface ModelRequest {
  model: string; system: string; tools: unknown[]; messages: { role: "user" | "assistant"; content: ContentBlock[] | string }[]; max_tokens: number;
  /** make the model call one tool (the game draft's `propose`); absent = the model chooses */
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
}
/** what one model call spent, as the API counts it: input (cache writes and reads included) and output tokens */
export interface Usage { input: number; output: number }
export interface ModelResponse { content: ContentBlock[]; stop_reason: string; usage?: Usage }
export type CallModel = (req: ModelRequest, signal?: AbortSignal) => Promise<ModelResponse>;

export interface AgentOpts {
  input: string; staging: string; work: string;
  gameName: string; releaseTitle: string; shape: string; problems: string[]; notes: string[];
  exec: Exec; tools: Toolbox; callModel: CallModel; model: string;
  maxTurns: number; maxMinutes: number;
  log: (line: string) => void; signal?: AbortSignal;
  onProgress?: (turn: number, note: string) => void;
  /** every step in full (the transcript keeps a short line per step) — the raw material for new recipes */
  trace?: (step: TraceStep) => void;
  /** lessons from earlier agent runs: the agent reads them before exploring, instead of rediscovering the same installer */
  lessons?: PriorLesson[];
}
export interface PriorLesson { game: string; release: string | null; ok: boolean; recognize: string; steps: string[]; pitfalls: string | null; adopted: string | null }
/** what the agent says it learned, for whoever turns its run into a deterministic recipe */
export interface Lesson { recognize: string; steps: string[]; pitfalls: string | null; automatable: boolean | null }
export type ImportPrompt = Pick<AgentOpts, "gameName" | "input" | "staging" | "work" | "tools" | "lessons">;
export type ReplayContext = ({ mode: "import" } & ImportPrompt) | { mode: "construct"; tools: Toolbox; lessons: PriorLesson[] };
export interface TraceStep { context?: ReplayContext; turn: number; t: number; kind: "brief" | "say" | "tool"; text?: string; tool?: string; input?: Record<string, unknown>; output?: string; ms?: number }
export interface AgentResult { ok: boolean; summary: string; launchExe: string | null; version: string | null; turns: number; validation: Validation | null; lesson: Lesson | null }

export function readLesson(v: unknown): Lesson | null {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const steps = Array.isArray(o.steps) ? o.steps.map(s => String(s).trim()).filter(Boolean) : typeof o.steps === "string" && o.steps.trim() ? [o.steps.trim()] : [];
  const recognize = typeof o.recognize === "string" ? o.recognize.trim() : "";
  if (!recognize && !steps.length) return null;
  return { recognize, steps, pitfalls: typeof o.pitfalls === "string" && o.pitfalls.trim() ? o.pitfalls.trim() : null, automatable: typeof o.automatable === "boolean" ? o.automatable : null };
}

/* ─────────── the loop ─────────── */

/** what one tool call gives back: its text for the model (and the trace), optionally images, and `done` to end the run */
export interface ToolOutcome<R> { out: string; done?: R; images?: { mediaType: "image/png" | "image/jpeg"; data: string }[] }
export interface LoopOpts<R> {
  system: string;
  /** Frozen prompt inputs for simulating a decision after the scratch folder is gone. */
  replayContext?: ReplayContext;
  /** the first user message */
  brief: string;
  tools: unknown[];
  /** runs one tool call; `signal` fires when the job is cancelled or the minute budget is up (a tool that takes long
   *  watches it) */
  run(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome<R>>;
  /** said once when the model ends its turn without a tool call */
  nudge: string;
  callModel: CallModel; model: string; maxTokens?: number;
  maxTurns: number; maxMinutes: number;
  log: (line: string) => void; signal?: AbortSignal;
  onProgress?: (turn: number, note: string) => void;
  trace?: (step: TraceStep) => void;
  /** past about this many tokens (4 characters each) the oldest tool results are cut to their first line (default 100k) */
  contextTokens?: number;
  /** no model call is made once this many tokens (input and output) are spent; absent: no limit */
  budgetTokens?: number;
  /** the tokens spent so far, after every model call (so a job can record them however it ends) */
  onUsage?: (u: LoopUsage) => void;
}
/** how a run ended without a tool saying it is done */
export type LoopEnd = "cancelled" | "out-of-time" | "out-of-budget" | "model-failed" | "out-of-turns" | "stopped";
/** the tokens a run spent; estimated: some call came back without the API's count, so its request and answer were
 *  measured instead (4 characters a token) */
export interface LoopUsage { input: number; output: number; estimated: boolean }
export interface LoopResult<R> { done: R | null; end: LoopEnd | null; error: string | null; turns: number; usage: LoopUsage }

/** tokens as the API counts them, or the request and the answer measured at 4 characters a token (rounded up) when the
 *  answer carries no count */
export function callUsage(req: ModelRequest, res: ModelResponse): Usage & { estimated: boolean } {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const input = n(res.usage?.input), output = n(res.usage?.output);
  if (input !== null && output !== null) return { input, output, estimated: false };
  return { input: Math.ceil(JSON.stringify(req).length / 4), output: Math.ceil(JSON.stringify(res.content ?? []).length / 4), estimated: true };
}

/** what one tool's output may be at most, for the model and for the trace */
export const TOOL_OUTPUT_CAP = 30_000;
/** an image counts as this many characters when the conversation is measured (about the 1.5k tokens a screenshot costs) */
const IMAGE_CHARS = 6_000;
const TRIM_MARK = " [trimmed]";

const partsChars = (c: ContentBlock["content"]): number =>
  typeof c === "string" ? c.length : (c ?? []).reduce((a, p) => a + (p.type === "text" ? p.text.length : IMAGE_CHARS), 0);
const blockChars = (b: ContentBlock): number =>
  40 + (b.text?.length ?? 0) + (b.input ? JSON.stringify(b.input).length : 0) + partsChars(b.content);
const messageChars = (m: ModelRequest["messages"][number]): number =>
  20 + (typeof m.content === "string" ? m.content.length : m.content.reduce((a, b) => a + blockChars(b), 0));

/**
 * The conversation as the model gets it: once it (with `fixed`, the system prompt and tools) passes `maxChars`, the
 * oldest tool results become their first line plus "[trimmed]", oldest first, until it fits; the newest message (the
 * results the model is about to read) stays whole. Returns new message objects where it changed something; the
 * messages passed in are left as they are.
 */
export function trimForContext(messages: ModelRequest["messages"], maxChars: number, fixed = 0): ModelRequest["messages"] {
  let total = fixed + messages.reduce((a, m) => a + messageChars(m), 0);
  if (total <= maxChars) return messages;
  const out = [...messages];
  for (let i = 0; i < out.length - 1 && total > maxChars; i++) {
    const m = out[i];
    if (m.role !== "user" || typeof m.content === "string") continue;
    let changed = false;
    const blocks = m.content.map(b => {
      if (b.type !== "tool_result" || total <= maxChars) return b;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).filter((p): p is TextPart => p.type === "text").map(p => p.text).join("\n");
      const short = (text.split("\n")[0] ?? "").slice(0, 300) + TRIM_MARK;
      const before = blockChars(b);
      const nb: ContentBlock = { ...b, content: short };
      const after = blockChars(nb);
      if (after >= before) return b;
      total -= before - after;
      changed = true;
      return nb;
    });
    if (changed) out[i] = { ...m, content: blocks };
  }
  return out;
}

/** the agent loop every mode runs (see the file header) */
export async function runLoop<R>(o: LoopOpts<R>): Promise<LoopResult<R>> {
  const t0 = Date.now();
  const deadline = t0 + o.maxMinutes * 60_000;
  const messages: ModelRequest["messages"] = [{ role: "user", content: o.brief }];
  const record = (s: Omit<TraceStep, "t">) => { try { o.trace?.({ ...s, t: Math.round((Date.now() - t0) / 1000) }); } catch { /* recording never stops the job */ } };
  record({ turn: 0, kind: "brief", text: o.brief, ...(o.replayContext ? { context: o.replayContext } : {}) });
  const maxChars = (o.contextTokens ?? 100_000) * 4;
  const fixed = o.system.length + JSON.stringify(o.tools).length;
  const usage: LoopUsage = { input: 0, output: 0, estimated: false };
  const ended = (end: LoopEnd, turns: number, error: string | null = null): LoopResult<R> => ({ done: null, end, error, turns, usage: { ...usage } });
  // a tool call and the model's own call stop at the minute budget as well: a shell command or a dry run that takes hours,
  // or a request that hangs (a busy API tried again and again), does not outlast it
  const timeUp = new AbortController();
  // a timer cannot wait longer than about 24.8 days (a longer one fires at once): a budget past that is checked between
  // the calls only, as before
  const wait = Math.max(0, deadline - Date.now());
  const timer = wait <= 2_147_483_647 ? setTimeout(() => timeUp.abort(new Error("out of time")), wait) : null;
  const toolSignal = o.signal ? AbortSignal.any([o.signal, timeUp.signal]) : timeUp.signal;

  try {
    let turns = 0;
    let nudged = false;
    while (turns < o.maxTurns) {
      if (o.signal?.aborted) return ended("cancelled", turns);
      // the timer may fire a little before the clock reads past the deadline: either one means the minutes are up
      if (timeUp.signal.aborted || Date.now() > deadline) return ended("out-of-time", turns);
      if (o.budgetTokens !== undefined && usage.input + usage.output >= o.budgetTokens) return ended("out-of-budget", turns);
      turns++;
      const req: ModelRequest = { model: o.model, system: o.system, tools: o.tools, messages: trimForContext(messages, maxChars, fixed), max_tokens: o.maxTokens ?? 8192 };
      let res: ModelResponse;
      try { res = await o.callModel(req, toolSignal); }
      catch (e: any) {
        // a call the job's cancel or the minute budget stopped is that end, not a model that failed
        if (o.signal?.aborted) return ended("cancelled", turns);
        if (timeUp.signal.aborted || Date.now() > deadline) return ended("out-of-time", turns);
        return ended("model-failed", turns, String(e?.message ?? e));
      }
      const spent = callUsage(req, res);
      usage.input += spent.input; usage.output += spent.output;
      if (spent.estimated) usage.estimated = true;
      try { o.onUsage?.({ ...usage }); } catch { /* counting never stops the run */ }
      messages.push({ role: "assistant", content: res.content });
      const results: ContentBlock[] = [];
      for (const block of res.content) {
        if (block.type === "text" && block.text?.trim()) {
          o.log(`agent: ${block.text.trim().slice(0, 800)}`); o.onProgress?.(turns, block.text.trim().slice(0, 120));
          record({ turn: turns, kind: "say", text: block.text.trim() });
        }
        if (block.type !== "tool_use" || !block.id || !block.name) continue;
        const input = block.input ?? {};
        o.log(`agent → ${block.name} ${JSON.stringify(input).slice(0, 1000)}`);
        const started = Date.now();
        const r = await o.run(block.name, input, toolSignal);
        o.log(`  ← ${r.out.split("\n")[0].slice(0, 200)}${r.out.includes("\n") ? " …" : ""}`);
        record({ turn: turns, kind: "tool", tool: block.name, input, output: r.out.slice(0, TOOL_OUTPUT_CAP), ms: Date.now() - started });
        const text = r.out.slice(0, TOOL_OUTPUT_CAP);
        results.push({
          type: "tool_result", tool_use_id: block.id,
          content: r.images?.length ? [{ type: "text", text }, ...r.images.map(im => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } }))] : text,
        });
        if (r.done) return { done: r.done, end: null, error: null, turns, usage: { ...usage } };
      }
      if (results.length) { messages.push({ role: "user", content: results }); continue; }
      if (res.stop_reason === "end_turn" && !nudged) {
        nudged = true;
        messages.push({ role: "user", content: o.nudge });
        continue;
      }
      break;
    }
    return ended(turns >= o.maxTurns ? "out-of-turns" : "stopped", turns);
  } finally { if (timer) clearTimeout(timer); }
}

/* ─────────── import mode ─────────── */

const LESSON_SCHEMA = {
  type: "object",
  description: "For the developers who turn agent runs into automatic recipes. Fill it whether or not you succeeded.",
  properties: {
    recognize: { type: "string", description: "the concrete signals that identify this kind of download, testable by a script: file names and layout, magic bytes, installer type, group/crack folder, what is inside archives" },
    steps: { type: "array", items: { type: "string" }, description: "the minimal commands that produced STAGING, in order, written with $INPUT/$STAGING/$WORK instead of literal paths; leave out exploration and dead ends. Empty when it cannot be done." },
    pitfalls: { type: "string", description: "what did not work and why, so a recipe avoids it" },
    automatable: { type: "boolean", description: "true when these steps would work unchanged for every download that matches `recognize`" },
  },
  required: ["recognize", "steps"],
};

export const AGENT_TOOLS = [
  { name: "shell", description: "Run one bash command in the job's work directory (INPUT, STAGING and WORK are exported as environment variables). Output is trimmed; long extractions should redirect to a file and be checked afterwards.", input_schema: { type: "object", properties: { cmd: { type: "string" }, timeout_sec: { type: "integer", description: "default 900, max 7200" } }, required: ["cmd"] } },
  { name: "list", description: "Tree of a directory with sizes (relative to the work directory, or absolute), capped at a few hundred entries.", input_schema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", description: "default 3" } }, required: ["path"] } },
  { name: "read", description: "Read a text file (NFO, install notes, scripts), up to max_bytes (default 20000).", input_schema: { type: "object", properties: { path: { type: "string" }, max_bytes: { type: "integer" } }, required: ["path"] } },
  { name: "validate", description: "Run the package validator on STAGING: tells you what is still wrong, or that it passes.", input_schema: { type: "object", properties: { launch_exe: { type: "string", description: "relative path of the main executable if you already know it" } } } },
  { name: "finish", description: "Declare the job done (the validator runs again) or impossible (ok=false with the reason).", input_schema: { type: "object", properties: { ok: { type: "boolean" }, summary: { type: "string", description: "what you did / why it cannot be done, for the captain" }, launch_exe: { type: "string" }, version: { type: "string" }, lesson: LESSON_SCHEMA }, required: ["ok", "summary", "lesson"] } },
];

export function systemPrompt(o: ImportPrompt): string {
  return [
    `You are the processing agent on Ahoy, a self-hosted game library. A release of "${o.gameName}" was downloaded; turn it into the installed game inside the STAGING directory.`,
    ``,
    `EXPECTED OUTPUT (checked by a validator when you call finish):`,
    `- STAGING holds the game exactly as it sits on a Windows PC after a normal install: executables and data, nothing left to unpack. No archives, disc images or installers remain (prerequisite installers under a redist/_CommonRedist folder are fine and wanted).`,
    `- A launchable main executable exists; pass it as launch_exe if there is any doubt.`,
    `- No shortcuts, registry work or compression. Just the folder.`,
    ``,
    PORTABILITY_INSTRUCTION,
    `PATHS: INPUT=${o.input} (the download, read-only — never delete it), STAGING=${o.staging} (your output; it may hold a partial attempt from the automatic tier — inspect before wiping), WORK=${o.work} (scratch).`,
    `TOOLS ON THIS HOST: ${describeToolbox(o.tools)}.`,
    o.tools.wine ? `Wine (64- and 32-bit) can run Windows installers unattended under a virtual display: \`xvfb-run -a ${o.tools.wine} setup.exe <silent switches>\` with WINEPREFIX=$WORK/wine. Common silent switches: Inno Setup /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /DIR="Z:\\\\path"; NSIS /S /D=Z:\\\\path; InstallShield /s; MSI via msiexec /qn. Expect it to take a while (minutes to an hour for big games); poll the target folder.` : `Wine is not available here, so installers cannot be executed; extraction is the only route.`,
    o.tools.dlgdrive ? `GUI-ONLY INSTALLERS (no silent switches, a dialog with a directory box and an INSTALL button): do not script window messages yourself — \`${o.tools.dlgdrive}\` does it. Run installer and driver inside ONE xvfb-run so they share the display: \`xvfb-run -a bash -c 'cd "$INSTDIR"; wine SETUP.exe & p=$!; wine ${o.tools.dlgdrive} --dir "Z:\\\\…\\\\staging" --button INSTALL --timeout-sec 5400; rc=$?; kill $p; exit $rc'\` (it fills every Edit box with the directory, clears checkboxes, presses the button, answers yes/no, waits for 100% or the window to close; exit 0 = done).` : ``,
    `SCENE / REPACK RELEASES: an ISO with setup.exe + setup-N.bin (Inno Setup carrying unarc.dll; the .bin starts with "ArC") cannot be extracted by innoextract or 7z — run the installer silently with /DIR pointing into STAGING. A folder named after the group (CODEX, RUNE, TENOKE, …) or "Crack" holds files that replace the store DRM (steam_api64.dll, .ini): copy them over the installed game afterwards, that is the last step that makes it launch.`,
    `Prefer extraction over execution: innoextract opens Inno Setup / GOG installers; 7z opens ISO/UDF images, rar/7z/zip and many self-extracting exes; unar/unrar for stubborn rar sets. Read the NFO or install notes first when present.`,
    ``,
    `RULES: write only inside STAGING and WORK. One shell command per call; commands have a time limit; outputs are trimmed. Anything you start in the background (Xvfb, wine, wineserver) must be stopped before you finish — ps, pkill and wineserver -k are available; a process left running keeps files open and blocks the clean-up. Work step by step, check with validate, and call finish when STAGING is right. If it is genuinely impossible with these tools, call finish with ok=false and say exactly why in plain words.`,
    `RECORDING: every step you take is kept so that downloads like this one can be handled by a script next time. Refer to $INPUT, $STAGING and $WORK rather than literal paths where you can, and fill finish.lesson carefully: how to recognise this kind of download, and the exact steps that worked.`,
    `PACE: you are slow and expensive compared with a script. Read WHAT WORKED BEFORE first and follow a matching lesson straight away; do not sleep longer than 30 s in one command (poll instead); do not re-derive what a lesson already states.`,
    priorLessons(o.lessons ?? []),
  ].filter(Boolean).join("\n");
}

const LESSONS_HEAD = `WHAT WORKED BEFORE (lessons from earlier agent runs on this server; a lesson marked "now a recipe" means the automatic tier already handles that case — if you still see it, the recipe failed on this input, so check why before repeating it):`;

/** earlier runs' lessons, newest first, within a budget: a matching one turns an hour of exploration into a few steps
 *  (`head` is the line above them; the construct agent's says what its lessons are about) */
export function priorLessons(lessons: PriorLesson[], budget = 9000, head = LESSONS_HEAD): string {
  if (!lessons.length) return "";
  const out: string[] = [``, head];
  let used = 0;
  for (const l of lessons) {
    const top = `- ${l.game}${l.release ? ` (${l.release})` : ""} — ${l.ok ? "succeeded" : "could not be done"}${l.adopted ? `; now a recipe: ${l.adopted}` : ""}`;
    const body = [`  recognise: ${l.recognize}`, ...(l.steps.length ? [`  steps:`, ...l.steps.map((s, i) => `    ${i + 1}. ${s}`)] : []), ...(l.pitfalls ? [`  pitfalls: ${l.pitfalls}`] : [])].join("\n");
    const text = `${top}\n${body}`;
    if (used + text.length > budget) { if (used === 0) out.push(text.slice(0, budget)); break; }
    out.push(text); used += text.length;
  }
  return out.join("\n");
}

function brief(o: AgentOpts): string {
  const lines = [
    `Release: ${o.releaseTitle}`,
    `Game: ${o.gameName}`,
    `The automatic tier classified the input as "${o.shape}" and stopped because: ${o.problems.join("; ") || "unknown"}.`,
  ];
  if (o.notes.length) lines.push(``, `Release notes found with the download:`, ...o.notes.map(n => n.slice(0, 6000)));
  lines.push(``, `Start by listing INPUT and STAGING.`);
  return lines.join("\n");
}

async function tree(root: string, depth: number): Promise<string> {
  const { files } = await scan(root, 2000).catch(() => ({ isDir: false, files: [] }));
  if (!files.length) return "(empty or missing)";
  const lines = files.filter(f => f.rel.split("/").length <= depth + 1).slice(0, 400)
    .map(f => `${String(f.size).padStart(12)}  ${f.rel}`);
  return `${files.length} files\n` + lines.join("\n") + (files.length > lines.length ? `\n… (${files.length - lines.length} more)` : "");
}

/** what list and read answer for a path outside the job's folders. The refusal states the rule; the tools' descriptions
 *  stay as they were (tests/agent-usage.test.ts holds every request of a scripted run to the bytes it always sent) */
const OUTSIDE = "that path is outside INPUT, STAGING and WORK: list and read only look inside those three folders";
/** is `p` the folder `dir` or something in it (both as written: no link is resolved here) */
function within(p: string, dir: string): boolean {
  const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const a = fold(resolve(p)), b = fold(resolve(dir));
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}
/**
 * The path a `list` or `read` call names, when it is in one of the job's folders (the download, the output, the scratch
 * folder), else null. Looked at twice: as it is written, and as the file system resolves it — a link an archive planted
 * in the output, or a ".." past a link, leads nowhere else. A path that is not there yet passes as written (the tool then
 * says there is nothing).
 */
export async function jobPath(p: string, o: Pick<AgentOpts, "input" | "staging" | "work">): Promise<string | null> {
  const abs = resolve(p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : join(o.work, p));
  const rooms = [o.input, o.staging, o.work];
  if (!rooms.some(r => within(abs, r))) return null;
  const real = await realpath(abs).catch(() => null);
  if (real === null) return abs;
  for (const r of rooms) if (within(real, await realpath(r).catch(() => resolve(r)))) return abs;
  return null;
}

/** the AI importer: the loop with the import tools, STAGING checked by the validator on every finish */
export async function runAgent(o: AgentOpts): Promise<AgentResult> {
  let finishes = 0;
  let lastValidation: Validation | null = null;
  const env = { INPUT: o.input, STAGING: o.staging, WORK: o.work, WINEPREFIX: join(o.work, "wine"), WINEDEBUG: "-all" };

  const runTool = async (name: string, input: Record<string, unknown>): Promise<ToolOutcome<AgentResult>> => {
    switch (name) {
      case "shell": {
        const cmd = String(input.cmd ?? "");
        const timeoutMs = Math.min(7200, Math.max(10, Number(input.timeout_sec) || 900)) * 1000;
        const bash = o.tools.bash ?? "bash";
        const r = await o.exec([bash, "-lc", cmd], { cwd: o.work, timeoutMs, env, signal: o.signal, maxOutput: 24_000 });
        return { out: `exit ${r.code}${r.timedOut ? " (timed out)" : ""}\n${r.stdout}${r.stderr ? "\n[stderr]\n" + r.stderr : ""}`.trim() };
      }
      case "list": {
        const at = await jobPath(String(input.path ?? "."), o);
        return { out: at ? await tree(at, Number(input.depth) || 3) : OUTSIDE };
      }
      case "read": {
        const max = Math.min(200_000, Number(input.max_bytes) || 20_000);
        const at = await jobPath(String(input.path ?? ""), o);
        if (!at) return { out: OUTSIDE };
        const f = Bun.file(at);
        if (!(await f.exists())) return { out: "no such file" };
        const buf = new Uint8Array(await f.slice(0, max).arrayBuffer());
        return { out: new TextDecoder("utf-8", { fatal: false }).decode(buf) + (f.size > max ? `\n… (${f.size - max} more bytes)` : "") };
      }
      case "validate": {
        lastValidation = await inspect(o.staging, { name: o.gameName, work: o.work, launchExe: input.launch_exe ? String(input.launch_exe) : null });
        return { out: lastValidation.ok
          ? `PASS — launch: ${lastValidation.launch}, ${lastValidation.fileCount} files, ${(lastValidation.totalSize / 1e9).toFixed(2)} GB, prerequisites: ${lastValidation.prerequisites.map(p => p.kind).join(", ") || "none"}`
          : `FAIL — ${lastValidation.problems.join("; ")}\nexecutables seen: ${lastValidation.exeCandidates.slice(0, 20).join(", ") || "none"}` };
      }
      case "finish": {
        finishes++;
        const ok = input.ok !== false;
        const summary = String(input.summary ?? "").trim() || "(no summary)";
        const lesson = readLesson(input.lesson);
        if (!ok) return { out: "noted", done: { ok: false, summary, launchExe: null, version: null, turns: 0, validation: lastValidation, lesson } };
        lastValidation = await inspect(o.staging, { name: o.gameName, work: o.work, launchExe: input.launch_exe ? String(input.launch_exe) : null });
        if (lastValidation.ok) return { out: "accepted", done: { ok: true, summary, launchExe: lastValidation.launch, version: input.version ? String(input.version) : null, turns: 0, validation: lastValidation, lesson } };
        if (finishes >= 3) return { out: "rejected", done: { ok: false, summary: `validator still rejects it: ${lastValidation.problems.join("; ")} (agent said: ${summary})`, launchExe: null, version: null, turns: 0, validation: lastValidation, lesson } };
        return { out: `NOT YET — the validator rejects STAGING: ${lastValidation.problems.join("; ")}. Fix that and call finish again, or finish with ok=false explaining why it cannot be done.` };
      }
      default: return { out: `unknown tool ${name}` };
    }
  };

  const r = await runLoop<AgentResult>({
    replayContext: { mode: "import", gameName: o.gameName, input: o.input, staging: o.staging, work: o.work, tools: o.tools, lessons: o.lessons },
    system: systemPrompt(o), brief: brief(o), tools: AGENT_TOOLS, run: runTool,
    nudge: "Continue. When STAGING holds the installed game call finish(ok=true); if it cannot be done, finish(ok=false) with the reason.",
    callModel: o.callModel, model: o.model, maxTurns: o.maxTurns, maxMinutes: o.maxMinutes,
    log: o.log, signal: o.signal, onProgress: o.onProgress, trace: o.trace,
  });
  if (r.done) return { ...r.done, turns: r.turns };
  const failed = (summary: string): AgentResult => ({ ok: false, summary, launchExe: null, version: null, turns: r.turns, validation: lastValidation, lesson: null });
  switch (r.end) {
    case "cancelled": return failed("cancelled");
    case "out-of-time": return failed(`out of time after ${o.maxMinutes} minutes`);
    case "model-failed": return failed(`model call failed: ${r.error}`);
    case "out-of-turns": return failed(`gave up after ${r.turns} turns`);
    default: return failed("the agent stopped without finishing");
  }
}

/* ─────────── the model ─────────── */

/** the model for the agent; an OpenRouter base URL wants provider-prefixed names, so the stock default is translated */
export function agentModel(model: string, base: string): string {
  const m = model || "claude-opus-5-5";
  if (/openrouter/i.test(base) && !m.includes("/")) return "anthropic/" + m.replace(/^claude-([a-z]+)-(\d+)-(\d+)$/, "claude-$1-$2.$3");
  return m;
}

export interface CallerOpts {
  key: string; base: string;
  /** each request's own time limit, also when the caller passes a signal (default 300 s) */
  timeoutMs?: number;
  /** how often a 429 / 5xx answer is tried again (default 5) */
  retries?: number;
}

/** the real thing: the Messages API (Anthropic, or OpenRouter's copy of it) with tool use, retried on 429/5xx */
export const anthropicCaller = (opts: CallerOpts): CallModel => async (req, signal) => {
  const key = opts.key;
  if (!key) throw new Error("the AI importer has no API key");
  const base = (opts.base || "https://api.anthropic.com").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 300_000, retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
    // every request gets its own time limit: a cancel signal alone would let a request that hangs hold the job forever
    const limit = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: req.model, max_tokens: req.max_tokens, system: req.system, tools: req.tools, messages: req.messages, ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}) }),
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    // the wait before the next try ends at once on a cancel (or the run's minute budget)
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < retries) { await pause(Math.min(60_000, 2000 * 2 ** attempt), signal); continue; }
    const j = await res.json().catch(() => ({})) as any;
    if (!res.ok) throw new Error(`model API HTTP ${res.status}: ${j?.error?.message ?? "no detail"}`);
    const usage = usageOf(j?.usage);
    return { content: j.content ?? [], stop_reason: j.stop_reason ?? "end_turn", ...(usage ? { usage } : {}) };
  }
};

/** a wait that a signal ends at once (with the signal's reason) */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("cancelled"));
  return new Promise((res, rej) => {
    const stop = () => { clearTimeout(t); rej(signal.reason ?? new Error("cancelled")); };
    const t = setTimeout(() => { signal.removeEventListener("abort", stop); res(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** the Messages API's usage block (OpenRouter's copy of the API answers the same): every input token, cache writes and
 *  reads included, and the output; null when the answer has none */
export function usageOf(u: unknown): Usage | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  if (typeof o.input_tokens !== "number" && typeof o.output_tokens !== "number") return null;
  return { input: n(o.input_tokens) + n(o.cache_creation_input_tokens) + n(o.cache_read_input_tokens), output: n(o.output_tokens) };
}
