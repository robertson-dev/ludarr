/**
 * What a page showing a job reads when the job ends (review 2: admin-ui-1, e2e-5). The page loads the job once on each
 * 'job' event and stops polling once the state is final, so the row must hold every line and step written before the end
 * when that event goes out, and lines written after it (the hand-off, the download's removal, the scratch folder) must
 * come with one more 'job' event.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadsDir } from "../src/config";
import { stmts, upsertGame, type GameRow, type JobRow } from "../src/db";
import { events } from "../src/events";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { enqueueJob, jobKinds, type KindContext, type KindDef } from "../src/process/kinds";
import { rdeps, runJob } from "../src/process/runner";
import { pdeps } from "../src/process/deps";
import { inspectRom } from "../src/process/validate";
import { restoreDeps } from "./ways-fixtures";

const realBuild = jobKinds.get("build"), realImporters = rdeps.importers;
beforeAll(() => { ensureDefaultRootFolder(); });
afterEach(() => {
  if (realBuild) jobKinds.set("build", realBuild); else jobKinds.delete("build");
  rdeps.importers = realImporters;
  restoreDeps();
});

const lines = (t: string | null | undefined) => (t ?? "").split("\n").filter(Boolean);
const traceOf = (j: JobRow) => JSON.parse(j.trace_json ?? "[]") as unknown[];
/** every 'job' event of one job, with what its row held at that moment (what the page's load() reads) */
function watch(id: () => number | null) {
  const seen: { state: string; lines: string[]; steps: number }[] = [];
  const off = events.subscribe(e => {
    const d = e.data as { id?: number; state?: string } | null;
    if (e.event !== "job" || !d || d.id !== id()) return;
    const row = stmts.jobById.get(d.id) as JobRow;
    seen.push({ state: row.state, lines: lines(row.transcript), steps: traceOf(row).length });
  });
  return { seen, off };
}
/** a job kind in place of the build kind for one test (the runner takes any registered kind) */
function kind(run: KindDef["run"]) { jobKinds.set("build", { run, scratch: () => 0 }); }

describe("a job of another kind", () => {
  test("when its end is announced, the row holds every line and every step written before it, done or failed", async () => {
    pdeps.log = () => {};
    for (const fails of [false, true]) {
      kind(async ctx => {
        ctx.trace?.({ turn: 0, kind: "say", text: "on ludarr's own list: trying its plan" });
        ctx.log("first line");
        ctx.trace?.({ turn: 0, kind: "tool", tool: "try_plan", input: {}, output: "try_plan #1: PASS" });
        ctx.log("second line");
        ctx.log("plan saved");
        if (fails) throw new Error("it did not work");
        return { message: "plan ready" };
      });
      const job = enqueueJob({ kind: "build", planId: 999_001 });
      const w = watch(() => job.id);
      await runJob(job.id);
      w.off();
      const final = stmts.jobById.get(job.id) as JobRow;
      const end = w.seen.find(s => s.state === (fails ? "failed" : "done"))!;
      expect(end).toBeTruthy();
      expect(end.steps).toBe(2);
      expect(end.lines).toEqual(lines(final.transcript));
      expect(end.lines.at(-1)).toMatch(fails ? /failed: it did not work$/ : /plan ready$/);
      // nothing came after the end: no second event
      expect(w.seen.filter(s => s.state !== "running").length).toBe(1);
    }
  });

  test("a line written after the end reaches the page with one more 'job' event, once the job has let go", async () => {
    pdeps.log = () => {};
    let ctxOf: KindContext | null = null;
    kind(async ctx => { ctxOf = ctx; ctx.log("working"); return { message: "done here" }; });
    const job = enqueueJob({ kind: "build", planId: 999_002 });
    // what the runner writes after the end (a scratch folder it could not remove, a process it had to stop), done here
    // the moment the end is announced
    let late = false;
    const off = events.subscribe(e => {
      const d = e.data as { id?: number; state?: string } | null;
      if (e.event === "job" && d?.id === job.id && d.state === "done" && !late) { late = true; ctxOf!.log("written after the end"); }
    });
    const w = watch(() => job.id);
    await runJob(job.id);
    off(); w.off();
    const final = stmts.jobById.get(job.id) as JobRow;
    const ends = w.seen.filter(s => s.state === "done");
    expect(ends.length).toBe(2);
    expect(ends[0].lines.at(-1)).toMatch(/done here$/);
    expect(ends[1].lines).toEqual(lines(final.transcript));
    expect(ends[1].lines.at(-1)).toMatch(/written after the end$/);
  });
});

describe("an import", () => {
  test("its end is announced with the whole log; the download's removal, written after it, comes with one more event", async () => {
    pdeps.log = () => {};
    const g = upsertGame({ steam_appid: 774_001, name: "Job Ends Dump", slug: "job-ends-dump" }) as GameRow;
    const input = join(downloadsDir(), "job-ends-dump");
    mkdirSync(input, { recursive: true });
    const dump = new Uint8Array(32_768).fill(3); dump.set([0x80, 0x37, 0x12, 0x40], 0);
    writeFileSync(join(input, "Job Ends Dump (USA).z64"), dump);
    rdeps.importers = () => [{ impl: "recipes", name: "copy", importer: { probe: async () => true, run: async (ctx: any) => {
      cpSync(ctx.input, ctx.staging, { recursive: true });
      return { ok: true, shape: "folder" as const, reason: null, platform: "n64", validation: await inspectRom(ctx.staging) };
    } } }];
    const j = stmts.insertJob.get(null, null, g.id, input) as JobRow;
    const w = watch(() => j.id);
    await runJob(j.id);
    w.off();
    const final = stmts.jobById.get(j.id) as JobRow;
    expect(final.state).toBe("done");
    const ends = w.seen.filter(s => s.state === "done");
    expect(ends[0].lines.at(-1)).toMatch(/ready: 1 files/);                     // the whole log up to the end, flushed
    expect(lines(final.transcript).at(-1)).toMatch(/raw download removed$/);
    expect(ends.at(-1)!.lines).toEqual(lines(final.transcript));             // and what came after it, with the last event
    expect(ends.length).toBe(2);
  });
});
