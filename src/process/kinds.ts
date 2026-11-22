/**
 * ludarr — jobs that are not imports of a download (src/ways/types.ts JobKind): each kind registers how it runs, and the
 * import runner (src/process/runner.ts) schedules them in lanes of their own (assembling and plan builds; taking game
 * files in; making them and building programs for one game; the AI), gives them a scratch folder, a log, progress
 * ('build' events), an abort signal and a build user of their own, and records the outcome like any job, a failure with
 * its kind (jobs.fail_json). Modules register their kind when imported: src/ways/assemble.ts (assemble),
 * src/ways/content.ts (content), the construct agent (construct, build), src/ways/make.ts (make).
 */
import { serializeJob, stmts, type JobRow } from "../db";
import { events } from "../events";
import type { JobKind, JobSpec } from "../ways/types";

export interface KindContext {
  job: JobRow;
  spec: JobSpec;
  /** the job's scratch folder (removed afterwards) and a staging folder inside it */
  work: string;
  staging: string;
  log(line: string): void;
  /** 0..1, with an admin-facing message */
  progress(p: number, message?: string): void;
  signal: AbortSignal;
  /** one recorded step (the AI's turns), kept in jobs.trace_json */
  trace?(step: unknown): void;
  /** the tier at work from here on: a job starts deterministic, and a construct job turns 'agent' when the AI takes over */
  tier?(tier: "deterministic" | "agent"): void;
}
export interface KindResult {
  message: string; packageId?: number | null;
  /** what a job that builds no package made, kept as its manifest for the admin UI (a construct job: {planId, wayId?, game?}) */
  manifest?: Record<string, unknown> | null;
}
export interface KindDef {
  run(ctx: KindContext): Promise<KindResult>;
  /** scratch bytes it needs before it may start (default 2 GB) */
  scratch?(job: JobRow, spec: JobSpec): Promise<number> | number;
  /** may it be queued again after a restart? (default true; an AI run is not repeated unasked) */
  resumable?: boolean;
}

export const jobKinds = new Map<Exclude<JobKind, "import">, KindDef>();
export function registerJobKind(kind: Exclude<JobKind, "import">, def: KindDef) { jobKinds.set(kind, def); }

/** queue a job of a non-import kind; input_path gets a sentinel that says what it works on (fetchId: the download it reads;
 *  runId: the carry run that started it, else the spec's own) */
export function enqueueJob(spec: JobSpec, opts: { gameId?: number | null; requestId?: number | null; fetchId?: number | null; runId?: number | null } = {}): JobRow {
  const sentinel = spec.kind === "assemble" ? `way:${spec.wayId}`
    : spec.kind === "construct" ? `repo:${spec.repo}`
    : spec.kind === "build" ? `plan:${spec.planId}`
    : spec.kind === "make" ? `make:way:${spec.wayId}`
    : spec.path ? spec.path : `way:${spec.wayId ?? "?"}`;
  // Both the carry run and the download request may discover the same completed release.
  // Each follows the resulting manifest using its own job pointer. Keep cancellation and cleanup
  // with the original owner, especially for an earlier download which is read-only.
  if (spec.kind === "content" && spec.path && spec.wayId && spec.fetchId && !spec.inbox && !spec.fromCopy) {
    for (const state of ["running", "queued"]) {
      for (const job of stmts.jobsByState.all(state) as JobRow[]) {
        if (job.kind !== "content" || job.game_id !== spec.gameId || job.input_path !== spec.path) continue;
        const active = JSON.parse(job.spec_json ?? "{}") as Partial<typeof spec>;
        if (active.wayId === spec.wayId && active.fetchId && !!active.confirm === !!spec.confirm) return job;
      }
    }
  }
  const runId = opts.runId ?? spec.runId ?? null;
  const row = stmts.insertJobOf.get(opts.requestId ?? null, opts.fetchId ?? null, opts.gameId ?? null, sentinel, spec.kind, JSON.stringify(spec), runId) as JobRow;
  events.emit("job", serializeJob(row));
  return row;
}

const idOf = (v: unknown): number | null => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/**
 * What a job holds while it runs: two jobs with the same key never run at once, whatever their lanes. "way:<id>" for every
 * job that works on one way (an assemble, a make, a content job for a way, a build for one game), "plan:<id>" for a plan's
 * own build, and the job's input otherwise (a download's path, 'repo:<owner/name>').
 */
export function lockKeyOf(job: Pick<JobRow, "kind" | "spec_json" | "input_path">): string {
  let spec: Record<string, unknown> | null = null;
  try { const v = JSON.parse(job.spec_json ?? "null"); spec = v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { spec = null; }
  const kind = job.kind ?? "import";
  if (spec) {
    const way = idOf(spec.wayId);
    if (way && (kind === "assemble" || kind === "make" || kind === "content" || kind === "build")) return `way:${way}`;
    const plan = idOf(spec.planId);
    if (plan && kind === "build") return `plan:${plan}`;
  }
  return job.input_path;
}
