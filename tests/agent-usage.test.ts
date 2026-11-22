import { afterEach, describe, expect, test } from "bun:test";
import { anthropicCaller, callUsage, runAgent, runLoop, usageOf, type CallModel, type ContentBlock, type ModelRequest, type ModelResponse } from "../src/process/agent";
import { importScenario } from "./agent-import-scenario";

/** a scripted model: each call pops the next reply (with the usage given for it, if any); tool_use blocks get ids */
function scripted(turns: { content: ContentBlock[]; usage?: { input: number; output: number } }[]): CallModel & { seen: ModelRequest[] } {
  let n = 0;
  const fn = (async (req: ModelRequest) => {
    fn.seen.push(JSON.parse(JSON.stringify(req)));
    const t = turns[n++] ?? { content: [{ type: "text", text: "..." }] };
    const content = t.content.map((b, i) => (b.type === "tool_use" ? { ...b, id: `t${n}-${i}` } : b));
    const res: ModelResponse = { content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", ...(t.usage ? { usage: t.usage } : {}) };
    return res;
  }) as unknown as CallModel & { seen: ModelRequest[] };
  fn.seen = [];
  return fn;
}
const tool = (name: string, input: Record<string, unknown> = {}): ContentBlock => ({ type: "tool_use", name, input });
const base = { system: "s", brief: "go", tools: [], nudge: "go on", model: "m", maxTurns: 10, maxMinutes: 1, log: () => {} };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("what a run spends", () => {
  test("the API's own counts are summed over the calls, cache writes and reads with the input; every call reports the total so far", async () => {
    const model = scripted([
      { content: [tool("look")], usage: { input: 1200, output: 80 } },
      { content: [tool("look")], usage: { input: 1500, output: 120 } },
      { content: [tool("done")], usage: { input: 1800, output: 40 } },
    ]);
    const seen: number[] = [];
    const r = await runLoop<string>({ ...base, callModel: model, onUsage: u => seen.push(u.input + u.output), run: async name => (name === "done" ? { out: "", done: "ok" } : { out: "looked" }) });
    expect(r).toMatchObject({ done: "ok", turns: 3, usage: { input: 4500, output: 240, estimated: false } });
    expect(seen).toEqual([1280, 2900, 4740]);
    // the Messages API's block: input, cache creation and cache reads are all input; OpenRouter's copy answers the same
    expect(usageOf({ input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30_000, output_tokens: 5 })).toEqual({ input: 32_010, output: 5 });
    expect(usageOf({ output_tokens: 7 })).toEqual({ input: 0, output: 7 });
    expect(usageOf(undefined)).toBeNull();
    expect(usageOf({ something: 1 })).toBeNull();
  });

  test("an answer without usage counts what was sent and what came back, at 4 characters a token (rounded up)", async () => {
    const req: ModelRequest = { model: "m", system: "x".repeat(399), tools: [], messages: [{ role: "user", content: "hi" }], max_tokens: 8 };
    const res: ModelResponse = { content: [{ type: "text", text: "a".repeat(100) }], stop_reason: "end_turn" };
    expect(callUsage(req, res)).toEqual({ input: Math.ceil(JSON.stringify(req).length / 4), output: Math.ceil(JSON.stringify(res.content).length / 4), estimated: true });
    const model = scripted([{ content: [tool("done")] }]);
    const r = await runLoop<string>({ ...base, callModel: model, run: async () => ({ out: "", done: "ok" }) });
    expect(r.usage.estimated).toBe(true);
    expect(r.usage.input).toBe(Math.ceil(JSON.stringify(model.seen[0]).length / 4));
    expect(r.usage.output).toBeGreaterThan(0);
  });

  test("the real caller hands the API's usage on, and its request body is as it was", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 11, cache_read_input_tokens: 100, output_tokens: 3 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await anthropicCaller({ key: "sk", base: "https://api.example" })({ model: "m", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
    expect(res.usage).toEqual({ input: 111, output: 3 });
    expect(bodies[0]).toBe(JSON.stringify({ model: "m", max_tokens: 8, system: "s", tools: [], messages: [{ role: "user", content: "hi" }] }));
    globalThis.fetch = (async () => new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }), { status: 200 })) as unknown as typeof fetch;
    expect("usage" in await anthropicCaller({ key: "sk", base: "https://api.example" })({ model: "m", system: "s", tools: [], messages: [], max_tokens: 8 })).toBe(false);
  });

  test("a token budget stops the run before the next call once it is spent ('out-of-budget'); none set, no limit", async () => {
    const turns = Array.from({ length: 6 }, () => ({ content: [tool("look")], usage: { input: 600, output: 100 } }));
    const model = scripted(turns);
    const r = await runLoop<string>({ ...base, callModel: model, budgetTokens: 1000, run: async () => ({ out: "looked" }) });
    expect(r).toMatchObject({ done: null, end: "out-of-budget", turns: 2, usage: { input: 1200, output: 200 } });
    expect(model.seen.length).toBe(2);                                           // the second call went over; no third was made
    const none = scripted([{ content: [tool("look")], usage: { input: 1, output: 1 } }]);
    expect((await runLoop<string>({ ...base, callModel: none, budgetTokens: 0, run: async () => ({ out: "" }) }))).toMatchObject({ end: "out-of-budget", turns: 0 });
    expect(none.seen.length).toBe(0);
    const free = scripted(Array.from({ length: 3 }, () => ({ content: [tool("look")], usage: { input: 1e9, output: 1e9 } })));
    expect((await runLoop<string>({ ...base, maxTurns: 3, callModel: free, run: async () => ({ out: "" }) })).end).toBe("out-of-turns");
  });

  test("a tool call is handed a signal that fires at the minute budget: a long one stops there, and the run ends out of time", async () => {
    const model = scripted([{ content: [tool("shell")] }, { content: [tool("done")] }]);
    let aborted = false;
    const t0 = Date.now();
    const r = await runLoop<string>({
      ...base, maxMinutes: 0.003, callModel: model,                              // about 180 ms
      run: async (name, _input, signal) => {
        if (name === "done") return { out: "", done: "ok" };
        // a two-hour shell command, as far as this tool knows
        await new Promise<void>(res => { const t = setTimeout(res, 7_200_000); signal?.addEventListener("abort", () => { clearTimeout(t); aborted = true; res(); }); });
        return { out: "stopped" };
      },
    });
    expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r).toMatchObject({ done: null, end: "out-of-time", turns: 1 });
    expect(model.seen.length).toBe(1);
    // the job's own cancel reaches the tool through the same signal
    const ac = new AbortController();
    let cancelled = false;
    const p = runLoop<string>({ ...base, callModel: scripted([{ content: [tool("shell")] }]), signal: ac.signal, run: async (_n, _i, signal) => { await new Promise<void>(res => signal?.addEventListener("abort", () => { cancelled = true; res(); })); return { out: "" }; } });
    setTimeout(() => ac.abort(), 20);
    expect((await p).end).toBe("cancelled");
    expect(cancelled).toBe(true);
  });

  test("a minute budget longer than a timer can wait (about 24.8 days) is no end at once: the run goes on, as before", async () => {
    const model = scripted([{ content: [tool("look")] }, { content: [tool("done")] }]);
    let aborted = false;
    const r = await runLoop<string>({
      ...base, maxMinutes: 50_000, callModel: model,
      run: async (name, _input, signal) => {
        if (name === "done") return { out: "", done: "ok" };
        await Bun.sleep(30);
        aborted = !!signal?.aborted;
        return { out: "looked" };
      },
    });
    expect(aborted).toBe(false);
    expect(r).toMatchObject({ done: "ok", end: null, turns: 2 });
  });
});

describe("import mode is as it was", () => {
  test("a scripted AI importer run sends the expected requests including the shared portability instruction", async () => {
    const { requests, result } = await importScenario(runAgent);
    // Golden request transcript, updated for the shared runtime-portability instruction (2026-11-12).
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(requests)).digest("hex")).toBe("4c2f25ee5b75639eca6a9c018d4fa24b0f4c52dbc4740e9f08fef240f5682e5d");
    expect(requests.length).toBe(5);
    expect(result).toMatchObject({ ok: false, summary: "the release holds no installer ludarr can run", turns: 5 });
    expect(requests[0].system).toContain(`You are the processing agent on Ahoy`);
    expect(requests[3].messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3_0", content: "exit 0\n7-Zip 16.02\nType = PE" }] });
  });
});
