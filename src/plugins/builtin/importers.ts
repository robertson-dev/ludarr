/**
 * Built-in importers, run in priority order until one produces a valid game folder:
 *   recipes   the deterministic tier: archives, disc images, GOG installers, scene ISOs under wine …
 *   agent     the AI tier: an agent with a shell and the same toolbox, for whatever the recipes could not do
 */
import { dirname, join } from "node:path";
import { deterministic } from "../../process/recipes";
import { runAgent, agentModel, readLesson, type PriorLesson } from "../../process/agent";
import { stmts, type JobRow } from "../../db";
import { pdeps } from "../../process/deps";
import { importExec, type Exec } from "../../process/tools";
import { scan } from "../../process/classify";
import type { ImportContext, Importer, ImporterDefinition, PluginContext, Settings } from "../types";

/**
 * How an import starts a program (an unpacker, an installer under wine, the AI importer's shell): with the fixed, small
 * environment of src/process/tools.ts importEnv and nothing of ludarr's own. What it starts came with a download, and
 * the keys and passwords ludarr was started with are not that program's to read.
 */
export const importerExec = (c: Pick<ImportContext, "work" | "staging">): Exec => importExec(c.work || dirname(c.staging), pdeps.exec);

/** small text files shipped with a release (nfo / readme / install notes) */
async function releaseNotes(input: string): Promise<string[]> {
  const { isDir, files } = await scan(input, 5000).catch(() => ({ isDir: false, files: [] }));
  if (!isDir) return [];
  const picks = files.filter(f => /\.(nfo|txt|md|diz)$/i.test(f.rel) && f.size > 0 && f.size < 60_000 && !/\/(redist|__redist)\//i.test(f.rel)).slice(0, 4);
  const out: string[] = [];
  for (const f of picks) {
    const text = await Bun.file(join(input, f.rel)).text().catch(() => "");
    if (text.trim()) out.push(`--- ${f.rel} ---\n${text.replace(/[^\x09\x0a\x0d\x20-\x7e -￿]/g, "")}`);
  }
  return out;
}

/**
 * What earlier agent runs learned, newest first, for the prompt (capped; the prompt builder trims to its budget). Each
 * agent reads its own pool: the AI importer the lessons of imports (and of jobs from before kinds existed), the construct
 * agent those of construct jobs, whose "release" is the repo it read.
 */
export function priorLessonsFromJobs(exceptJobInput?: string, kind: "import" | "construct" = "import"): PriorLesson[] {
  const mine = (j: JobRow) => (kind === "import" ? (j.kind ?? "import") === "import" : j.kind === kind);
  const rows = (stmts.agentRuns.all() as JobRow[]).filter(j => j.lesson_json && j.input_path !== exceptJobInput && mine(j)).slice(0, 12);
  const out: PriorLesson[] = [];
  for (const j of rows) {
    const l = readLesson(j.lesson_json);
    if (!l) continue;
    let adopted: string | null = null, ok = j.state === "done";
    try { const raw = JSON.parse(j.lesson_json!) as { adopted?: string; ok?: boolean }; adopted = raw.adopted ?? null; if (typeof raw.ok === "boolean") ok = raw.ok; } catch { /* lesson as it is */ }
    const release = !j.input_path ? null : kind === "construct" ? j.input_path.replace(/^repo:/, "") : j.input_path.split("/").pop() ?? null;
    out.push({ game: j.game_name ?? (kind === "construct" ? "no game" : "a game"), release, ok, recognize: l.recognize, steps: l.steps, pitfalls: l.pitfalls, adopted });
  }
  return out;
}

export const recipes: ImporterDefinition = {
  kind: "importer", impl: "recipes", name: "Automatic recipes",
  description: "Folders, archives (7z/rar/zip, nested), disc images, GOG installers (innoextract) and scene installers (Inno Setup under wine with the group's crack laid over). Never needs a key.",
  fields: [],
  create(): Importer {
    return {
      probe: async () => true,
      async run(c: ImportContext) {
        const r = await deterministic(c.input, c.staging, { work: c.work, exec: importerExec(c), tools: pdeps.tools(), log: c.log, signal: c.signal, progress: c.progress }, { name: c.gameName, group: c.group ?? undefined, platform: c.platform ?? null, consoles: c.consoles ?? [] });
        return { ok: r.ok, shape: r.shape, reason: r.reason, launchExe: r.validation?.launch ?? null, validation: r.validation, steps: r.steps, platform: r.platform ?? null };
      },
    };
  },
};

export const agent: ImporterDefinition = {
  kind: "importer", impl: "agent", name: "AI importer",
  description: "When the recipes stop, an agent with a shell and the same toolbox works out what the download is and installs it. Every step is recorded, and it reports how to recognise the case next time.",
  infoLink: "https://openrouter.ai/",
  fields: [
    { name: "apiKey", label: "API key", type: "password", required: true, helpText: "an Anthropic key, or an OpenRouter key together with the OpenRouter base URL" },
    { name: "baseUrl", label: "API base URL", type: "url", default: "https://api.anthropic.com", helpText: "https://api.anthropic.com, or https://openrouter.ai/api" },
    { name: "model", label: "Model", type: "text", default: "claude-opus-5-5", helpText: "with OpenRouter, provider-prefixed names (anthropic/claude-opus-5.5) are derived automatically" },
    { name: "maxTurns", label: "Turns per import", type: "number", default: 60, advanced: true },
    { name: "maxMinutes", label: "Minutes per import", type: "number", default: 120, advanced: true },
  ],
  create(s: Settings, ctx: PluginContext): Importer {
    const key = String(s.apiKey ?? ""), base = String(s.baseUrl || "https://api.anthropic.com");
    const model = agentModel(String(s.model || "claude-opus-5-5"), base);
    return {
      probe: async () => !!key,
      async test() {
        if (!key) return { ok: false, detail: "no API key" };
        try {
          const call = pdeps.callModel ?? pdeps.caller({ key, base });
          const r = await call({ model, system: "Reply with the single word OK.", tools: [], messages: [{ role: "user", content: "ping" }], max_tokens: 8 });
          return { ok: true, detail: `${model} answered: ${r.content.map(b => b.text ?? "").join("").trim().slice(0, 40) || "(empty)"}` };
        } catch (e: any) { return { ok: false, detail: String(e?.message ?? e) }; }
      },
      async run(c: ImportContext) {
        const last = c.previous.at(-1);
        const t0 = Date.now();
        const r = await runAgent({
          input: c.input, staging: c.staging, work: c.work, gameName: c.gameName, releaseTitle: c.releaseTitle,
          shape: last?.shape ?? "unknown", problems: last?.problems ?? [], notes: await releaseNotes(c.input),
          exec: importerExec(c), tools: pdeps.tools(), callModel: pdeps.callModel ?? pdeps.caller({ key, base }), model,
          maxTurns: Number(s.maxTurns) || 60, maxMinutes: Number(s.maxMinutes) || 120,
          lessons: priorLessonsFromJobs(c.input),
          log: c.log, signal: c.signal, trace: c.trace,
          onProgress: (turn, note) => c.progress(Math.min(0.9, turn / (Number(s.maxTurns) || 60)), `AI importer: ${note}`),
        });
        ctx.log.info(`${c.gameName}: ${r.ok ? "done" : "gave up"} after ${r.turns} turns — ${r.summary.split("\n")[0]}`);
        return { ok: r.ok, shape: last?.shape ?? "unknown", reason: r.ok ? null : r.summary, launchExe: r.launchExe, version: r.version, notes: r.summary, validation: r.validation,
          lesson: { ...(r.lesson ?? {}), ok: r.ok, turns: r.turns, model, seconds: Math.round((Date.now() - t0) / 1000) } };
      },
    };
  },
};

export const importerDefinitions: ImporterDefinition[] = [recipes, agent];
