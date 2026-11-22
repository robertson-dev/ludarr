import { afterEach, describe, expect, test } from "bun:test";
import { db, stmts, type JobRow } from "../src/db";
import { anthropicCaller, runLoop, trimForContext, type CallModel, type ContentBlock, type ModelRequest, type TraceStep } from "../src/process/agent";
import { priorLessonsFromJobs } from "../src/plugins/builtin/importers";

/** a scripted model: each call pops the next reply; tool_use blocks get ids; every request is kept (a deep copy) */
function scripted(turns: ContentBlock[][]): CallModel & { seen: ModelRequest[] } {
  let n = 0;
  const fn = (async (req: ModelRequest) => {
    fn.seen.push(JSON.parse(JSON.stringify(req)));
    const content = (turns[n++] ?? [{ type: "text", text: "..." }]).map((b, i) => (b.type === "tool_use" ? { ...b, id: `t${n}-${i}` } : b));
    return { content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }) as unknown as CallModel & { seen: ModelRequest[] };
  fn.seen = [];
  return fn;
}
const tool = (name: string, input: Record<string, unknown> = {}): ContentBlock => ({ type: "tool_use", name, input });
const results = (m: ModelRequest["messages"][number]) => (Array.isArray(m.content) ? m.content.filter(b => b.type === "tool_result") : []);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("the agent loop", () => {
  test("past the context budget the oldest tool results shrink to their first line; the newest stay whole; the trace keeps all", async () => {
    const big = (tag: string) => `${tag} first line\n${"x".repeat(25_000)}`;
    const model = scripted([[tool("dump", { n: 1 })], [tool("dump", { n: 2 })], [tool("dump", { n: 3 })], [tool("dump", { n: 4 })], [tool("done")]]);
    const trace: TraceStep[] = [];
    const r = await runLoop<string>({
      system: "s", brief: "go", tools: [], nudge: "go on", callModel: model, model: "m", maxTurns: 10, maxMinutes: 1, log: () => {},
      trace: s => trace.push(s), contextTokens: 15_000,                                // 60k characters
      run: async (name, input) => (name === "done" ? { out: "ok", done: "finished" } : { out: big(`dump ${input.n}`) }),
    });
    expect(r).toMatchObject({ done: "finished", turns: 5 });
    // the fifth request carries four results: the oldest are cut to "<first line> [trimmed]", the newest is whole
    const last = model.seen[4].messages;
    const all = last.flatMap(results);
    expect(all.length).toBe(4);
    expect(all[0].content).toBe("dump 1 first line [trimmed]");
    expect(all[1].content).toBe("dump 2 first line [trimmed]");
    expect(String(all[3].content).length).toBeGreaterThan(25_000);
    expect(JSON.stringify(last).length).toBeLessThan(80_000);
    // the trace has every output in full
    const outs = trace.filter(s => s.kind === "tool" && s.tool === "dump").map(s => s.output!);
    expect(outs.length).toBe(4);
    for (const o of outs) expect(o.length).toBeGreaterThan(25_000);
    // under the budget nothing is touched (the import agent's requests stay as they were)
    const small = scripted([[tool("dump", { n: 1 })], [tool("done")]]);
    await runLoop<string>({ system: "s", brief: "go", tools: [], nudge: "n", callModel: small, model: "m", maxTurns: 5, maxMinutes: 1, log: () => {}, run: async name => (name === "done" ? { out: "", done: "x" } : { out: "short\nresult" }) });
    expect(small.seen[1].messages.flatMap(results)[0].content).toBe("short\nresult");
  });

  test("trimForContext leaves the messages it was given alone and only ever cuts tool results", () => {
    const msgs: ModelRequest["messages"] = [
      { role: "user", content: "brief" },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(50_000) }, { type: "tool_use", id: "1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: `line one\n${"b".repeat(50_000)}` }] },
      { role: "assistant", content: [{ type: "tool_use", id: "2", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: `newest\n${"c".repeat(50_000)}` }] },
    ];
    const before = JSON.stringify(msgs);
    const out = trimForContext(msgs, 120_000);
    expect(JSON.stringify(msgs)).toBe(before);
    expect((out[2].content as ContentBlock[])[0].content).toBe("line one [trimmed]");
    expect((out[1].content as ContentBlock[])[0].text!.length).toBe(50_000);       // the model's own words are never cut
    expect(String((out[4].content as ContentBlock[])[0].content).startsWith("newest\nccc")).toBe(true);
    expect(trimForContext(msgs, 10_000_000)).toBe(msgs);
  });

  test("a tool result can carry an image (the smoke start's screenshot); a cut one keeps its words only", async () => {
    const model = scripted([[tool("shot")], [tool("done")]]);
    await runLoop<string>({
      system: "s", brief: "b", tools: [], nudge: "n", callModel: model, model: "m", maxTurns: 4, maxMinutes: 1, log: () => {},
      run: async name => (name === "done" ? { out: "", done: "x" } : { out: "two windows", images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] }),
    });
    const [res] = model.seen[1].messages.flatMap(results);
    expect(res.content).toEqual([{ type: "text", text: "two windows" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
    const shot: ContentBlock = { type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "shot\nmore" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(10) } }] };
    const cut = trimForContext([{ role: "user", content: [shot] }, { role: "user", content: "next" }], 10);
    expect((cut[0].content as ContentBlock[])[0].content).toBe("shot [trimmed]");
  });

  test("one nudge when the model stops without a tool; the ends are told apart", async () => {
    const quiet = scripted([[{ type: "text", text: "thinking" }], [{ type: "text", text: "still thinking" }]]);
    const r = await runLoop<string>({ system: "s", brief: "b", tools: [], nudge: "Continue, please.", callModel: quiet, model: "m", maxTurns: 5, maxMinutes: 1, log: () => {}, run: async () => ({ out: "" }) });
    expect(r).toMatchObject({ done: null, end: "stopped", turns: 2 });
    expect(quiet.seen[1].messages.at(-1)).toEqual({ role: "user", content: "Continue, please." });
    const loop = scripted(Array.from({ length: 5 }, () => [tool("x")]));
    expect(await runLoop<string>({ system: "s", brief: "b", tools: [], nudge: "n", callModel: loop, model: "m", maxTurns: 3, maxMinutes: 1, log: () => {}, run: async () => ({ out: "" }) })).toMatchObject({ end: "out-of-turns", turns: 3 });
    const broken: CallModel = async () => { throw new Error("HTTP 529"); };
    expect(await runLoop<string>({ system: "s", brief: "b", tools: [], nudge: "n", callModel: broken, model: "m", maxTurns: 3, maxMinutes: 1, log: () => {}, run: async () => ({ out: "" }) })).toMatchObject({ end: "model-failed", error: "HTTP 529" });
    const ac = new AbortController(); ac.abort();
    expect(await runLoop<string>({ system: "s", brief: "b", tools: [], nudge: "n", callModel: loop, model: "m", maxTurns: 3, maxMinutes: 1, log: () => {}, signal: ac.signal, run: async () => ({ out: "" }) })).toMatchObject({ end: "cancelled", turns: 0 });
  });
});

describe("the model call", () => {
  test("every request has its own time limit, also when the caller passes a signal of its own", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
    })) as unknown as typeof fetch;
    const call = anthropicCaller({ key: "sk", base: "https://api.example", timeoutMs: 60, retries: 0 });
    const cancel = new AbortController();                                              // never aborted
    const t0 = Date.now();
    const err = await call({ model: "m", system: "", tools: [], messages: [{ role: "user", content: "hi" }], max_tokens: 8 }, cancel.signal).catch(e => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(String(err?.name ?? err)).toMatch(/TimeoutError|AbortError/);
    // and a cancel still stops it at once
    const c2 = new AbortController();
    const p = anthropicCaller({ key: "sk", base: "https://api.example", timeoutMs: 60_000, retries: 0 })({ model: "m", system: "", tools: [], messages: [], max_tokens: 8 }, c2.signal).catch(e => e);
    c2.abort();
    expect(await p).toBeTruthy();
  });

  test("tool_choice goes to the API only when asked; the import agent's request body is as it was", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }), { status: 200 }); }) as unknown as typeof fetch;
    const call = anthropicCaller({ key: "sk", base: "https://api.example" });
    await call({ model: "m", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
    await call({ model: "m", system: "s", tools: [], messages: [{ role: "user", content: "hi" }], max_tokens: 8, tool_choice: { type: "tool", name: "propose" } });
    expect(bodies[0]).toBe(JSON.stringify({ model: "m", max_tokens: 8, system: "s", tools: [], messages: [{ role: "user", content: "hi" }] }));
    expect(JSON.parse(bodies[1]).tool_choice).toEqual({ type: "tool", name: "propose" });
  });
});

describe("lessons by kind", () => {
  test("the AI importer reads the lessons of imports; the construct agent those of construct jobs", () => {
    db.exec("DELETE FROM jobs");
    const imp = stmts.insertJob.get(null, null, null, "/downloads/Game.v1-GRP") as JobRow;
    stmts.setJobLesson.run(JSON.stringify({ recognize: "an Inno installer", steps: ["wine setup.exe /VERYSILENT"], ok: true }), imp.id);
    const old = stmts.insertJob.get(null, null, null, "/downloads/Old-GRP") as JobRow;          // from before kinds existed
    db.query("UPDATE jobs SET kind=NULL WHERE id=?").run(old.id);
    stmts.setJobLesson.run(JSON.stringify({ recognize: "a zip", steps: ["7z x"] }), old.id);
    const con = stmts.insertJobOf.get(null, null, null, "repo:Some/Port", "construct", JSON.stringify({ kind: "construct", repo: "Some/Port" }), null) as JobRow;
    stmts.setJob.run("done", "agent", 1, "plan ready", con.id);
    stmts.setJobLesson.run(JSON.stringify({ recognize: "a Windows zip per release", steps: ["release ^Port-.*-win64[.]zip$"], ok: true }), con.id);
    const asm = stmts.insertJobOf.get(null, null, null, "way:1", "assemble", JSON.stringify({ kind: "assemble", wayId: 1 }), null) as JobRow;
    stmts.setJobLesson.run(JSON.stringify({ recognize: "never read", steps: ["x"] }), asm.id);

    const forImports = priorLessonsFromJobs();
    expect(forImports.map(l => l.recognize).sort()).toEqual(["a zip", "an Inno installer"]);
    const forConstruct = priorLessonsFromJobs(undefined, "construct");
    expect(forConstruct).toEqual([{ game: "no game", release: "Some/Port", ok: true, recognize: "a Windows zip per release", steps: ["release ^Port-.*-win64[.]zip$"], pitfalls: null, adopted: null }]);
    // a job's own lesson is left out of its own prompt
    expect(priorLessonsFromJobs("repo:Some/Port", "construct")).toEqual([]);
    db.exec("DELETE FROM jobs");
  });
});
