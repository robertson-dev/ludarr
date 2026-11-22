import { afterEach, expect, test } from "bun:test";
import { db, stmts, type JobRow } from "../src/db";
import { activityApi } from "../src/api/activity";
import { simulateDecision } from "../src/process/simulation";
import { practiceImport, exercises } from "../src/process/import-exercise";
import { type CallModel, type ModelRequest, type ReplayContext } from "../src/process/agent";
import { cxdeps } from "../src/ways/construct";

const context: ReplayContext = { mode: "construct", tools: { sevenZip: null, unar: null, unrar: null, innoextract: null, wine: null, xvfb: null, bash: null, dlgdrive: null }, lessons: [] };
const trace = [
  { kind: "brief", turn: 0, text: "Use the downloaded package already present.", context },
  { kind: "tool", turn: 1, tool: "library", input: { what: "downloads" }, output: "Existing package 84" },
  { kind: "tool", turn: 2, tool: "inspect", input: { op: "identify", source: "copy" }, output: "hidden selected-turn output" },
  { kind: "say", turn: 3, text: "hidden future diagnosis" },
];
const job = { id: 73, kind: "construct", state: "failed", input_path: "recorded:copy", transcript: "hidden final transcript", message: "hidden final outcome", trace_json: JSON.stringify(trace) } as JobRow;
const call: CallModel = async () => ({ content: [{ type: "tool_use", name: "inspect", id: "i", input: { source: "copy", op: "identify" } }], stop_reason: "tool_use" });
test("a trial uses the current prompt, sees only earlier observations, and compares the entire proposed decision", async () => {
  const requests: ModelRequest[] = [];
  const r = await simulateDecision({ job, fallback: context, turn: 2, model: "trial", instruction: "Prefer kept inputs.", callModel: async (req, signal) => { requests.push(req); return call(req, signal); } });
  expect(requests).toHaveLength(1);
  const [req] = requests;
  expect(req.system).toContain("Prefer kept inputs.");
  expect(req.system).toContain("construct agent");
  expect(JSON.stringify(req.messages)).toContain("Existing package 84");
  expect(JSON.stringify(req.messages)).not.toContain("hidden");
  expect(r).toMatchObject({ comparison: "same", mode: "replay", turn: 2, reconstructed: false });
  expect(r.recorded[0].output).toBe("hidden selected-turn output");
  const different = await simulateDecision({ job, fallback: context, turn: 2, model: "trial", instruction: "", callModel: async () => ({
    content: [{ type: "tool_use", id: "d", name: "download", input: { url: "https://invalid.invalid/game.iso" } }], stop_reason: "tool_use",
  }) });
  expect(different.comparison).toBe("different");
  expect(different.proposed[0].tool).toBe("download");
});
test("an older failed converter with no AI trace is a recovery exercise, never a claim that its proposed action worked", async () => {
  let brief = "";
  const r = await simulateDecision({ job: { ...job, kind: "make", trace_json: null, transcript: "PkgTool.Core not found at https://host.test/archive?sig=privatevalue X-Api-Key: privatevalue", input_path: "/absent/large.pkg" }, fallback: context, model: "m", instruction: "", callModel: async (req, s) => { brief = JSON.stringify(req.messages); return call(req, s); } });
  expect(brief).toContain("PkgTool.Core not found");
  expect(brief).not.toContain("privatevalue");
  expect(r).toMatchObject({ mode: "recovery", comparison: "no-baseline", recorded: [] });
});
test("both miniature imports run with the real validator without a model, downloads, or library writes", async () => {
  for (const name of exercises) {
    const r = await practiceImport(name);
    expect(r).toMatchObject({ passed: true, inputTokens: 0, outputTokens: 0 });
    expect(r.steps.at(-1)?.tool).toBe("finish");
    if (name === "reuse-extracted") expect(r.steps.at(-1)?.output).toBe("accepted");
  }
});
test("a model that stops or requests an unrelated shell command does not pass the missing-files case", async () => {
  const commands = ['curl https://invalid.invalid/game.iso', 'cp -a "$INPUT/installed/." "$STAGING/"; exit 0'];
  for (const cmd of commands) {
    const result = await practiceImport("incomplete-release", { model: "script", caller: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "shell", input: { cmd } }] }) });
    expect(result.passed).toBe(false);
    expect(result.steps).toHaveLength(6);
    expect(result.steps.every(s => s.output?.includes("only supports the fixed copy"))).toBe(true);
  }
});

const ai = cxdeps.ai, caller = cxdeps.caller;
afterEach(() => { cxdeps.ai = ai; cxdeps.caller = caller; });
const send = (path: string, body: unknown) => activityApi.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const counts = () => ["jobs", "requests", "fetches", "packages"].map(t => db.query(`select count(*) n from ${t}`).get());
test("the admin entry points are read-only even when the model proposes a download", async () => {
  const j = stmts.insertJob.get(null, null, null, "/absent/retained.iso") as JobRow;
  try {
    const path = `/api/v1/import/${j.id}/simulate`;
    expect((await send(path, {})).status).toBe(409);
    db.query("update jobs set state='failed',kind='construct',trace_json=? where id=?").run(JSON.stringify(trace), j.id);
    cxdeps.ai = () => ({ key: "stub", base: "", model: "stub", maxTurns: 1, maxMinutes: 1 });
    let calls = 0;
    cxdeps.caller = () => async () => { calls++; return { content: [{ type: "tool_use", name: "download", id: "d", input: { url: "https://invalid.invalid/sample.iso" } }], stop_reason: "tool_use" }; };
    const before = counts();
    expect((await send(path, { turn: 9 })).status).toBe(400);
    expect((await send(path, { turn: 2 })).status).toBe(200);
    expect(calls).toBe(1);
    const ref = await send("/api/v1/simulation/import", { caller: "reference", exercise: "reuse-extracted" });
    expect((await ref.json()).item.passed).toBe(true);
    expect(calls).toBe(1);
    expect(counts()).toEqual(before);
    expect((stmts.jobById.get(j.id) as JobRow).state).toBe("failed");
  } finally { db.query("delete from jobs where id=?").run(j.id); }
});
