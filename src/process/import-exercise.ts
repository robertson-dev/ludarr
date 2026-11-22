import { copyFile, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callUsage, runAgent, type CallModel, type ContentBlock, type TraceStep } from "./agent";

export const exercises = ["reuse-extracted", "incomplete-release"] as const;
export type Exercise = typeof exercises[number];
const copyCommand = 'cp -a "$INPUT/installed/." "$STAGING/"';
const toolbox = { sevenZip: null, unar: null, unrar: null, innoextract: null, wine: null, xvfb: null, bash: null, dlgdrive: null };

/** Both callers see the same brief and use the same importer and validator. Only this fixed copy can change the fixture. */
export async function practiceImport(which: Exercise, o: { caller?: CallModel; model?: string; instruction?: string; signal?: AbortSignal } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ludarr-practice-"));
  const input = join(root, "input"), staging = join(root, "staging"), installed = join(input, "installed");
  const ready = which === "reuse-extracted";
  const steps: TraceStep[] = [];
  const tool = (name: string, args: Record<string, unknown>): ContentBlock => ({ type: "tool_use", id: "sample_" + (++seq), name, input: args });
  let seq = 0, turns = 0, inputTokens = 0, outputTokens = 0;
  let examinedInput = false, copied = false;
  const model = o.caller ? (o.model ?? "configured AI") : "scripted reference";
  try {
    await mkdir(input); await mkdir(staging);
    await writeFile(join(input, "release.nfo"), "Orbit sample for Windows. Check the contents of this release.");
    if (ready) {
      await mkdir(installed);
      await writeFile(join(installed, "Orbit.exe"), "synthetic sample executable");
      const asset = join(installed, "assets.pak");
      await writeFile(asset, "");
      await truncate(asset, 5_100_000); // satisfies the actual validator's 5 MB floor
    }
    // The scripted reference verifies the fixture itself without spending tokens.
    const reference: CallModel = async () => {
      const action = turns === 1 ? tool("list", { path: input }) : turns === 2 ? tool("list", { path: staging })
        : ready && turns === 3 ? tool("shell", { cmd: copyCommand }) : ready && turns === 4 ? tool("validate", {})
        : tool("finish", { ok: ready, summary: ready ? "Recovered the installed copy." : "The release only contains a note and has no game files.", lesson: {} });
      return { content: [action], stop_reason: "tool_use" };
    };
    const caller = o.caller ?? reference;
    const result = await runAgent({
      gameName: "Orbit", releaseTitle: "Orbit.Sample", shape: "folder",
      problems: ["no launchable program was staged"], notes: ["Inspect INPUT and STAGING. This exercise supports list, read, validate and finish. To copy an existing installed/ folder, the practice shell accepts exactly: " + copyCommand],
      tools: toolbox, input, work: root, staging, model, maxTurns: 6, maxMinutes: 1.5, log: () => {}, signal: o.signal,
      exec: async argv => {
        if (argv[2]?.trim() !== copyCommand) return { code: 1, stdout: "", stderr: "This practice shell only supports the fixed copy in the brief.", timedOut: false };
        try {
          for (const name of ["Orbit.exe", "assets.pak"]) await copyFile(join(installed, name), join(staging, name));
          copied = true;
          return { code: 0, stdout: "", stderr: "", timedOut: false };
        } catch { return { code: 1, stdout: "", stderr: "Could not copy the installed folder.", timedOut: false }; }
      },
      trace: s => {
        if (s.kind !== "tool") return;
        if (s.tool === "list" && s.output?.includes("release.nfo")) examinedInput = true;
        if (s.tool === "read" && s.output?.includes("Orbit sample for Windows")) examinedInput = true;
        steps.push(s);
      },
      callModel: async (req, signal) => {
        turns++;
        const trial = { ...req, max_tokens: Math.min(req.max_tokens, 1400), system: req.system + (o.instruction ? "\nAdditional instruction for this trial only:\n" + o.instruction : "") };
        const res = await caller(trial, signal);
        if (o.caller) { const u = callUsage(trial, res); inputTokens += u.input; outputTokens += u.output; }
        return res;
      },
    });
    const last = steps.at(-1);
    const passed = ready ? copied && result.ok && result.validation?.ok === true && result.launchExe === "Orbit.exe"
      : examinedInput && last?.tool === "finish" && last.input?.ok === false && last.output === "noted";
    return { exercise: which, model, passed, expected: ready ? "Recover the existing Orbit.exe and pass package validation." : "Inspect the input and report the missing game files.",
      summary: result.summary, turns, inputTokens, outputTokens, steps: steps.map(s => ({ tool: s.tool, input: s.input, output: s.output })) };
  } finally { await rm(root, { recursive: true, force: true }); }
}
