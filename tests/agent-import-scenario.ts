/**
 * One scripted run of the AI importer (import mode, src/process/agent.ts runAgent) whose every request is kept: the same
 * run on the code before wave 3 gave the sha256 that tests/agent-usage.test.ts holds it to, so import mode is proven
 * byte-identical — the system prompt, the tools, the brief, every message and tool result as sent. It takes runAgent as an
 * argument, so the same scenario runs on either copy of the code; nothing here reads the file system or the network.
 */
import type { AgentOpts, AgentResult, CallModel, ContentBlock, ModelRequest } from "../src/process/agent";

export async function importScenario(runAgent: (o: AgentOpts) => Promise<AgentResult>): Promise<{ requests: ModelRequest[]; result: AgentResult }> {
  const turns: ContentBlock[][] = [
    [{ type: "text", text: "Listing the input first." }, { type: "tool_use", name: "list", input: { path: "/nonexistent/ahoy-scenario/input", depth: 2 } }],
    [{ type: "tool_use", name: "read", input: { path: "/nonexistent/ahoy-scenario/input/release.nfo", max_bytes: 400 } }],
    [{ type: "tool_use", name: "shell", input: { cmd: "7z l \"$INPUT/setup.exe\"", timeout_sec: 60 } }],
    [{ type: "text", text: "Nothing to install from here." }],
    [{ type: "tool_use", name: "finish", input: { ok: false, summary: "the release holds no installer ludarr can run", lesson: { recognize: "an empty folder", steps: [], pitfalls: "none", automatable: false } } }],
  ];
  const requests: ModelRequest[] = [];
  let n = 0;
  const callModel: CallModel = async req => {
    requests.push(JSON.parse(JSON.stringify(req)));
    const content = (turns[n++] ?? [{ type: "text", text: "..." }]).map((b, i) => (b.type === "tool_use" ? { ...b, id: `toolu_${n}_${i}` } : b));
    return { content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn" };
  };
  const result = await runAgent({
    input: "/nonexistent/ahoy-scenario/input", staging: "/nonexistent/ahoy-scenario/staging", work: "/nonexistent/ahoy-scenario/work",
    gameName: "Scenario Quest", releaseTitle: "Scenario.Quest-GRP", shape: "unknown", problems: ["no launchable exe"], notes: ["--- release.nfo ---\nRun setup.exe"],
    exec: async () => ({ code: 0, stdout: "7-Zip 16.02\nType = PE", stderr: "", timedOut: false }),
    tools: { sevenZip: "7z", unar: null, unrar: null, innoextract: "innoextract", wine: null, xvfb: null, bash: "bash", dlgdrive: null },
    callModel, model: "scenario-model", maxTurns: 8, maxMinutes: 5, log: () => {},
    lessons: [{ game: "Other Game", release: "Other.Game-GRP", ok: true, recognize: "an Inno installer", steps: ["innoextract -d $STAGING $INPUT/setup.exe"], pitfalls: null, adopted: null }],
  });
  return { requests, result };
}
