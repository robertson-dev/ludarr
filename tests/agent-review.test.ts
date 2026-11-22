/**
 * Review of the AI loop's budgets (src/process/agent.ts): the minute budget holds for the model call itself, not only for
 * the tool calls between them, and a cancel is not held up by the caller's wait between two tries of a busy API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { anthropicCaller, runAgent, runLoop, type CallModel, type ContentBlock } from "../src/process/agent";
import { importScenario } from "./agent-import-scenario";

const base = { system: "s", brief: "go", tools: [], nudge: "go on", model: "m", maxTurns: 10, log: () => {} };
const tool = (name: string): ContentBlock => ({ type: "tool_use", id: "t1", name, input: {} });
/** a model whose answer never comes: only its signal ends the call */
const hanging: CallModel = (_req, signal) => new Promise((_res, rej) => {
  signal?.addEventListener("abort", () => rej(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
});
const race = <T>(p: Promise<T>, ms: number) => Promise.race([p, Bun.sleep(ms).then(() => "still waiting" as const)]);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("the minute budget holds in every mode, the model's own call included", () => {
  test("a model call that does not answer is stopped at the minute budget: the run ends out of time, not hours later", async () => {
    const t0 = Date.now();
    const r = await race(runLoop<string>({ ...base, maxMinutes: 0.003, callModel: hanging, run: async () => ({ out: "" }) }), 3000);
    expect(r).not.toBe("still waiting");
    expect(r).toMatchObject({ done: null, end: "out-of-time", turns: 1 });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  test("the job's cancel during a model call ends the run as cancelled (not as a model that failed)", async () => {
    const ac = new AbortController();
    const p = runLoop<string>({ ...base, maxMinutes: 5, signal: ac.signal, callModel: hanging, run: async () => ({ out: "" }) });
    setTimeout(() => ac.abort(), 20);
    const r = await race(p, 3000);
    expect(r).toMatchObject({ end: "cancelled" });
  });

  test("the import agent (import mode) stops at its minutes during a model call too, and says so", async () => {
    const r = await race(runAgent({
      input: "/nonexistent/in", staging: "/nonexistent/staging", work: "/nonexistent/work", gameName: "G", releaseTitle: "G-GRP", shape: "unknown", problems: [], notes: [],
      exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      tools: { sevenZip: "7z", unar: null, unrar: null, innoextract: null, wine: null, xvfb: null, bash: "bash", dlgdrive: null },
      callModel: hanging, model: "m", maxTurns: 4, maxMinutes: 0.003, log: () => {},
    }), 3000);
    expect(r).not.toBe("still waiting");
    expect(r).toMatchObject({ ok: false, summary: "out of time after 0.003 minutes" });
  });

  test("a model that answers in time is not cut off, and import mode still sends byte for byte what it sent", async () => {
    let n = 0;
    const answering: CallModel = async () => ({ content: n++ === 0 ? [tool("look")] : [tool("done")], stop_reason: "tool_use" });
    const r = await runLoop<string>({ ...base, maxMinutes: 1, callModel: answering, run: async name => (name === "done" ? { out: "", done: "ok" } : { out: "looked" }) });
    expect(r).toMatchObject({ done: "ok", end: null, turns: 2 });
    const { requests } = await importScenario(runAgent);
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(requests)).digest("hex")).toBe("4c2f25ee5b75639eca6a9c018d4fa24b0f4c52dbc4740e9f08fef240f5682e5d");
  });
});

describe("the real caller", () => {
  test("its wait before trying a busy API again ends at once on a cancel", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }); }) as unknown as typeof fetch;
    const ac = new AbortController();
    const t0 = Date.now();
    const p = anthropicCaller({ key: "sk", base: "https://api.example", retries: 5 })({ model: "m", system: "s", tools: [], messages: [], max_tokens: 8 }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    const r = await race(p.then(() => "answered", () => "stopped"), 5000);
    expect(r).toBe("stopped");
    expect(Date.now() - t0).toBeLessThan(1000);                                // the first wait is 2 s: it is not waited out
    expect(calls).toBe(1);
  });
});
