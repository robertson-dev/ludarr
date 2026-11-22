/**
 * ludarr — why a job ended badly, as a type instead of words. The runner writes failOf(err) into jobs.fail_json on every
 * failure, and a carry run (src/ways/carry.ts) decides what to do next from it: back off and look again later (env), ask
 * the AI to fix the recipe (plan), look for another game file (file), wait for the admin (cancelled by them), or start the
 * job again (restart). Nothing is classified by what a child program printed: a build's own output can say "socket" or
 * "timed out" for reasons that are the plan's.
 *
 *   EnvError      thrown only by ludarr's own checks: no room, no sandbox or wine, a tool missing, ludarr's own fetches,
 *                 an out-of-memory kill, a CPU or graphics device the server lacks, the input changing while it was used,
 *                 the seedbox's folder troubled while a job read it ('remote': the runner's verdict from src/remote.ts — a
 *                 job's own error, whatever its type, says nothing of the copy then)
 *   PlanFault     the plan's recipe failed in one of its phases (a make step, a build step, a check)
 *   NeedsFiles    a game file or a system file is missing or is not the one accepted: the way waits for files
 */
import type { FailInfo } from "./types";

export type EnvKind = "room" | "tool" | "net" | "oom" | "device" | "cpu" | "restart" | "changed" | "busy" | "remote";

/** this server cannot do it now; nothing is wrong with the plan or the file */
export class EnvError extends Error {
  constructor(public kind: EnvKind, msg: string) { super(msg); this.name = "EnvError"; }
  get fail(): FailInfo { return { class: "env", kind: this.kind }; }
}

/** the plan's recipe failed in `phase` */
export class PlanFault extends Error {
  constructor(public phase: FailInfo["phase"], msg: string) { super(msg); this.name = "PlanFault"; }
  get fail(): FailInfo { return this.phase ? { class: "plan", phase: this.phase } : { class: "plan" }; }
}

/** the way's program must first be built for this game (a release kit, program.perGame, or a source build that reads the
 *  game file) and no kept build fits: the run or the Build route queues that build, then the assemble again. Neither the
 *  plan's fault nor the file's */
export class NeedsBuild extends Error {
  get fail(): FailInfo { return { class: "other", kind: "needs-build" }; }
}

/** a file that is missing or is not the one accepted: the way waits for files rather than failing */
export class NeedsFiles extends Error {
  get fail(): FailInfo { return { class: "file" }; }
}

const CLASSES: ReadonlySet<string> = new Set(["env", "plan", "file", "cancelled", "restart", "other"]);
const isFail = (v: unknown): v is FailInfo => !!v && typeof v === "object" && CLASSES.has(String((v as { class?: unknown }).class));

/** what kind of failure `err` is: a typed error says so, an error that carries a `fail` says that, an abort is a cancel,
 *  anything else is 'other' */
export function failOf(err: unknown): FailInfo {
  if (err instanceof EnvError || err instanceof PlanFault) return err.fail;
  const own = err && typeof err === "object" ? (err as { fail?: unknown }).fail : undefined;
  if (isFail(own)) return { ...own };
  const name = err && typeof err === "object" ? String((err as { name?: unknown }).name ?? "") : "";
  const msg = err && typeof err === "object" ? String((err as { message?: unknown }).message ?? "") : String(err ?? "");
  if (name === "AbortError" || msg === "cancelled") return { class: "cancelled" };
  return { class: "other" };
}
