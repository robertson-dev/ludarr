/**
 * The build sandbox's users and invariants (src/ways/sandbox.ts): one build user per running job from a pool of seven,
 * a job's folder closed to every other job's user, a kept game file linked into a folder never handed over or changed,
 * a step's end typed by its phase, no network for make and check steps where the server can take it away, ludarr's
 * own values for WINEDEBUG, and the library scrubbed of write for others. On this Windows dev box the Linux parts run
 * against fakes (sbdeps): the logic, never real uids.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { EnvError, PlanFault, failOf } from "../src/ways/errors";
import {
  POOL_USERS, SANDBOX_UIDS, SANDBOX_USERS, closeJobFolder, handTo, spareJobFolder, linkProblem, noNetwork, releaseSandboxUser, resetSandbox, runSandboxedStep, sandboxEnv, sandboxExec,
  sandboxUserFor, sbdeps, scrubWorldWritable, stepFailure, stopUnder, takeSandboxUser, withSandboxUser, type SandboxedStepOpts,
} from "../src/ways/sandbox";
import { pdeps } from "../src/process/deps";
import type { ExecResult } from "../src/process/tools";
import { ok, restoreDeps, tmp, tools7z } from "./ways-fixtures";

const PASSWD = [
  "root:x:0:0:root:/root:/bin/bash",
  "builder:x:1500:1500::/home/builder:/bin/sh",
  ...[1, 2, 3, 4, 5, 6, 7].map(i => `builder${i}:x:${1500 + i}:${1500 + i}::/home/builder${i}:/bin/sh`),
].join("\n");

interface Seen { chowns: [string, number, number][]; chmods: [string, number][]; killed: number[]; cmds: string[][]; logs: string[] }
/** an entry's stat with the modes a Linux box gives it (Windows says 0666 for everything): folders 0755, files 0644 */
const linuxLike = (st: Stats, mode?: number): Stats => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: (st.mode & ~0o7777) | (mode ?? (st.isDirectory() ? 0o755 : 0o644)) });
/** a Linux box running as root with runuser, unshare and the eight build users, as the Docker image is */
function asContainer(o: { passwd?: string; group?: string; procs?: { pid: number; uid: number; euid: number }[]; exec?: (cmd: string[]) => ExecResult } = {}): Seen {
  const seen: Seen = { chowns: [], chmods: [], killed: [], cmds: [], logs: [] };
  sbdeps.lstat = async p => linuxLike(lstatSync(p));
  sbdeps.platform = () => "linux";
  sbdeps.uid = () => 0;
  sbdeps.which = n => (n === "runuser" ? "/usr/sbin/runuser" : n === "unshare" ? "/usr/bin/unshare" : null);
  sbdeps.passwd = () => o.passwd ?? PASSWD;
  sbdeps.group = () => o.group ?? "root:x:0:\nusers:x:100:\n";
  sbdeps.chown = async (p, u, g) => { seen.chowns.push([p, u, g]); };
  sbdeps.chmod = async (p, m) => { seen.chmods.push([p, m]); };
  sbdeps.procs = () => o.procs ?? [];
  sbdeps.kill = pid => { seen.killed.push(pid); };
  sbdeps.tempDirs = () => [];
  sbdeps.settleMs = 1;
  sbdeps.log = l => { seen.logs.push(l); };
  sbdeps.exec = async cmd => { seen.cmds.push(cmd); return o.exec?.(cmd) ?? ok(); };
  return seen;
}
afterEach(() => { restoreDeps(); resetSandbox(); });

describe("one build user per running job (H1)", () => {
  test("the pool is builder1 (1501) to builder7 (1507): each job gets one of its own, none is left once all are in use, and 'builder' (1500) is never a job's", async () => {
    expect(SANDBOX_UIDS).toEqual([1500, 1501, 1502, 1503, 1504, 1505, 1506, 1507]);           // every build user's files are refused alike
    expect(SANDBOX_USERS.map(u => u.user)).toEqual(["builder1", "builder2", "builder3", "builder4", "builder5", "builder6", "builder7", "builder"]);
    expect(POOL_USERS.map(u => u.user)).toEqual(["builder1", "builder2", "builder3", "builder4", "builder5", "builder6", "builder7"]);
    asContainer();
    const got = [1, 2, 3, 4, 5, 6, 7].map(id => takeSandboxUser(id)!);
    expect(new Set(got.map(u => u.uid)).size).toBe(7);
    expect(got.map(u => u.uid).sort()).toEqual([1501, 1502, 1503, 1504, 1505, 1506, 1507]);
    expect(takeSandboxUser(8)).toBeNull();                                    // the runner leaves job 8 queued: 'builder' is no job's
    expect(takeSandboxUser(3)).toEqual(got[2]);                               // a job asking again keeps its own
    releaseSandboxUser(3);
    await new Promise(r => setTimeout(r, 20));                               // once what it left behind is cleared
    expect(takeSandboxUser(8)).toEqual(got[2]);
  });

  test("a job's end stops what runs as its own user only: a look at a file outside any job runs as 'builder', and no job's end stops it", async () => {
    const seen = asContainer({ procs: [] });
    const u = takeSandboxUser(1)!;
    expect(u.user).toBe("builder1");
    expect(sandboxUserFor(tmp("sbx-nojob-")).user).toBe("builder");            // what belongs to no job
    sbdeps.procs = () => [{ pid: 77, uid: 1500, euid: 1500 }, { pid: 88, uid: 1501, euid: 1501 }];
    releaseSandboxUser(1);
    expect(seen.killed).toEqual([88]);
    await stopUnder(join(tmp("sbx-root-"), ".work", "job-2"));                 // a job that holds no user stops nobody by uid
    expect(seen.killed).toEqual([88]);
  });

  test("a user this server does not have as the image makes it, or one in the 'users' group, is never handed out", () => {
    const short = PASSWD.split("\n").filter(l => !/^builder[4-7]:/.test(l)).join("\n");
    asContainer({ passwd: short.replace("builder2:x:1502:1502", "builder2:x:1502:100"), group: "users:x:100:builder3\n" });
    const got = [1, 2, 3, 4].map(id => takeSandboxUser(id));
    expect(got.map(u => u?.user ?? null)).toEqual(["builder1", null, null, null]);
  });

  test("whatever still runs as a free user is stopped, and that user is handed out once it is gone", () => {
    const procs = [{ pid: 4242, uid: 1501, euid: 1501 }, { pid: 7, uid: 0, euid: 0 }];
    const seen = asContainer({ procs });
    expect(takeSandboxUser(1)?.user).toBe("builder2");
    expect(seen.killed).toEqual([4242]);
    procs.splice(0, 1);
    expect(takeSandboxUser(2)?.user).toBe("builder1");
  });

  test("a released user's leftovers are stopped and its temp entries removed before it is handed out again", async () => {
    const procs = [{ pid: 900, uid: 1501, euid: 1501 }];
    const seen = asContainer({ procs: [] });
    expect(takeSandboxUser(5)?.uid).toBe(1501);
    sbdeps.procs = () => procs;
    const temp = tmp("sbx-temp-");
    writeFileSync(join(temp, ".X99-lock"), "x");
    writeFileSync(join(temp, "mine.txt"), "x");
    sbdeps.tempDirs = () => [temp];
    sbdeps.lstat = async p => { const st = lstatSync(p); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: p.endsWith(".X99-lock") ? 1501 : 0 }); };
    releaseSandboxUser(5);
    expect(seen.killed).toEqual([900]);
    expect(takeSandboxUser(6)?.uid).not.toBe(1501);                          // still being cleared
    await new Promise(r => setTimeout(r, 50));
    expect(() => lstatSync(join(temp, ".X99-lock"))).toThrow();
    expect(lstatSync(join(temp, "mine.txt")).isFile()).toBe(true);           // root's own stays
    procs.splice(0, 1);
    releaseSandboxUser(6);
    expect(takeSandboxUser(7)?.uid).toBe(1501);
  });

  test("a job's programs run as its own user, found by the job id in its folder's path; its folder is root's, open to that user's group only", async () => {
    const seen = asContainer();
    const u = takeSandboxUser(41)!;
    const work = join(tmp("sbx-root-"), ".work", "job-41", "make");
    await sandboxExec(["true"], { work, cwd: work });
    expect(seen.cmds[0].slice(0, 4)).toEqual(["/usr/sbin/runuser", "-u", u.user, "--"]);
    const job = join(work, "..");
    expect(seen.chowns).toContainEqual([job, 0, u.uid]);
    expect(seen.chmods).toContainEqual([job, 0o750]);
    for (const d of ["home", "tmp", "wine", "scratch"]) expect(seen.chowns).toContainEqual([join(work, d), u.uid, u.uid]);
    expect(sandboxUserFor(join(job, "staging", "game"))).toEqual(u);
    // a folder no job holds runs as 'builder'
    expect(sandboxUserFor(tmp("sbx-loose-")).user).toBe("builder");
    // a nested folder named like a job inside a job's tree belongs to the outer job
    expect(sandboxUserFor(join(job, "staging", "job-7"))).toEqual(u);
  });

  test("a step of job A cannot create a file in job B's handed-over folder", async () => {
    const seen = asContainer();
    const root = join(tmp("sbx-h1-"), ".work");
    const a = takeSandboxUser(101)!, b = takeSandboxUser(102)!;
    const workA = join(root, "job-101"), workB = join(root, "job-102"), stagingB = join(workB, "staging");
    mkdirSync(stagingB, { recursive: true });
    await sandboxExec(["true"], { work: workA });
    await sandboxExec(["true"], { work: workB });
    await handTo(stagingB, "builder");
    // what the fakes were told, as ownership and modes; who may create an entry in a folder (owner, group, others)
    const owner = new Map<string, { uid: number; gid: number }>(), mode = new Map<string, number>();
    for (const [p, uid, gid] of seen.chowns) owner.set(p, { uid, gid });
    for (const [p, m] of seen.chmods) mode.set(p, m);
    const perm = (p: string) => ({ ...(owner.get(p) ?? { uid: 0, gid: 0 }), mode: mode.get(p) ?? 0o755 });
    const may = (uid: number, gid: number, p: string, bits: number) => {
      const f = perm(p);
      const set = f.uid === uid ? (f.mode >> 6) & 7 : f.gid === gid ? (f.mode >> 3) & 7 : f.mode & 7;
      return (set & bits) === bits;
    };
    const canCreate = (u: { uid: number }, dir: string) => [root, workB].every(p => may(u.uid, u.uid, p, 1)) && may(u.uid, u.uid, dir, 3);
    expect(perm(workB)).toEqual({ uid: 0, gid: b.uid, mode: 0o750 });
    expect(perm(stagingB).uid).toBe(b.uid);
    expect(canCreate(b, stagingB)).toBe(true);
    expect(canCreate(a, stagingB)).toBe(false);                             // job B's folder is closed to job A's user
    expect(a.uid).not.toBe(b.uid);
  });

  test("a probe that is no job holds a user of its own while it runs", async () => {
    asContainer();
    const dir = tmp("sbx-probe-");
    const inside = await withSandboxUser(dir, async u => { expect(sandboxUserFor(join(dir, "x"))).toEqual(u); return u.user; });
    expect(inside).toBe("builder1");
    expect(sandboxUserFor(join(dir, "x")).user).toBe("builder");
    for (let i = 1; i <= 8; i++) takeSandboxUser(200 + i);
    expect(await withSandboxUser(dir, async () => "ran")).toBeNull();
  });

  test("without the sandbox (a dev box) every job runs as 'builder' and no job waits for a user", () => {
    sbdeps.platform = () => "win32";
    for (let i = 1; i <= 12; i++) expect(takeSandboxUser(300 + i)?.user).toBe("builder");
  });
});

describe("a kept game file is never handed over (C2)", () => {
  const storeFile = () => {
    const store = tmp("sbx-store-"), staging = tmp("sbx-staging-");
    const kept = join(store, "PPSA01341-app0.zar");
    writeFileSync(kept, "zar bytes");
    chmodSync(kept, 0o444);
    mkdirSync(join(staging, "game"), { recursive: true });
    const placed = join(staging, "game", "PPSA01341-app0.zar");
    linkSync(kept, placed);
    writeFileSync(join(staging, "Kyty.exe"), "exe");
    const st = lstatSync(placed);
    return { store, staging, kept, placed, ref: { dev: st.dev, ino: st.ino } };
  };

  test("handed over and back, the linked file is never chowned or chmodded, and the step may leave exactly that link", async () => {
    const seen = asContainer();
    const s = storeFile();
    await handTo(s.staging, "builder", { skip: [s.ref], log: l => seen.logs.push(l) });
    await handTo(s.staging, "root", { skip: [s.ref] });
    expect(seen.chowns.map(c => c[0])).toContain(join(s.staging, "Kyty.exe"));
    expect(seen.chowns.some(c => c[0] === s.placed)).toBe(false);
    expect(seen.chmods.some(c => c[0] === s.placed)).toBe(false);
    expect(seen.logs.join("\n")).toMatch(/1 linked file left as it is \(game\/PPSA01341-app0\.zar\): a kept game file is never handed to a build program/);
    expect(await linkProblem(s.staging, "the package", [s.ref])).toBeNull();
    expect(await linkProblem(s.staging, "the package")).toBe("the package holds a hard link (game/PPSA01341-app0.zar), and a package carries files of its own only");
    expect(lstatSync(s.kept).mode & 0o222).toBe(0);                          // still read-only
  });

  test("a multi-linked file is left alone whoever asks, and a folder holding one ludarr did not place is not handed over", async () => {
    const seen = asContainer();
    const s = storeFile();
    await expect(handTo(s.staging, "builder")).rejects.toThrow("game/PPSA01341-app0.zar is a hard link to a file ludarr did not place: a folder holding one is not handed to a build program");
    expect(seen.chowns).toEqual([]);
    await handTo(s.staging, "root");                                          // back to root: still never the linked file
    expect(seen.chowns.some(c => c[0] === s.placed)).toBe(false);
    expect(seen.chmods.some(c => c[0] === s.placed)).toBe(false);
  });

  test("a setup step through runSandboxedStep keeps the store file root's, and a hard link the step leaves is refused", async () => {
    const seen = asContainer();
    pdeps.tools = () => ({ ...tools7z });
    const s = storeFile();
    const work = join(tmp("sbx-c2-"), "job-7");
    const outside = join(tmp("sbx-outside-"), "secret.bin");
    writeFileSync(outside, "secret");
    sbdeps.exec = async cmd => { seen.cmds.push(cmd); if (cmd.includes("plant")) linkSync(outside, join(s.staging, "planted.bin")); return ok(); };
    const o: SandboxedStepOpts = { exe: "tool", cwd: s.staging, fill: {}, work, signal: new AbortController().signal, log: () => {}, name: { log: "setup 1", error: "setup step 1" }, skip: [s.ref], phase: "setup" };
    await runSandboxedStep({ exe: "tool", argv: [], wine: false, timeoutSec: 5 }, o);
    expect(seen.chowns.some(c => c[0] === s.placed) || seen.chmods.some(c => c[0] === s.placed)).toBe(false);
    const e = await runSandboxedStep({ exe: "tool", argv: ["plant"], wine: false, timeoutSec: 5 }, o).catch(x => x);
    expect(e).toBeInstanceOf(PlanFault);
    expect(e.message).toBe("setup step 1 holds a hard link (planted.bin), and a package carries files of its own only");
  });
});

describe("a step's end, typed by its phase", () => {
  const res = (code: number, o: Partial<ExecResult> = {}): ExecResult => ({ code, stdout: "", stderr: "", timedOut: false, ...o });
  test("a non-zero exit or a timeout is the recipe's; memory and the CPU are this server's; without a phase the words are the same, untyped", () => {
    const p = { name: "make step 2", timeoutSec: 60, wine: false, phase: "make" as const };
    expect(stepFailure(res(0), p)).toBeNull();
    const fail = stepFailure(res(1, { stderr: "reading\nzstd: error 11\nbad block" }), p)!;
    expect(fail).toBeInstanceOf(PlanFault);
    expect([fail.message, failOf(fail)]).toEqual(["make step 2 failed (exit 1): reading | zstd: error 11 | bad block", { class: "plan", phase: "make" }]);
    expect(failOf(stepFailure(res(-1, { timedOut: true }), p))).toEqual({ class: "plan", phase: "make" });
    expect(stepFailure(res(-1, { timedOut: true }), p)!.message).toBe("make step 2 ran out of time (60 s)");
    expect(failOf(stepFailure(res(137), p))).toEqual({ class: "env", kind: "oom" });
    expect(failOf(stepFailure(res(1, { stderr: "bash: line 1:  4711 Killed                  ./pack in out" }), p))).toEqual({ class: "env", kind: "oom" });
    expect(failOf(stepFailure(res(1, { stderr: "Killed 3 enemies, then exit 1" }), p))).toEqual({ class: "plan", phase: "make" });   // a program's own words never count
    expect(failOf(stepFailure(res(132), p))).toEqual({ class: "env", kind: "cpu" });
    expect(failOf(stepFailure(res(29), { ...p, wine: true }))).toEqual({ class: "env", kind: "cpu" });   // 0xC000001D under wine
    expect(failOf(stepFailure(res(29), p))).toEqual({ class: "plan", phase: "make" });
    const plain = stepFailure(res(137), { name: "setup step 1", timeoutSec: 60, wine: false })!;
    expect([plain instanceof PlanFault, plain instanceof EnvError, plain.message]).toEqual([false, false, "setup step 1 failed (exit 137)"]);
  });

  test("runSandboxedStep with a phase throws the typed errors, and a wine step on a server without wine is this server's", async () => {
    sbdeps.platform = () => "win32";
    pdeps.tools = () => ({ ...tools7z });
    const work = tmp("sbx-typed-"), cwd = join(work, "run");
    mkdirSync(cwd, { recursive: true });
    let answer = res(137);
    sbdeps.exec = async () => answer;
    const o: SandboxedStepOpts = { exe: "/opt/pack", cwd, fill: { content: () => "{content}" }, work, signal: new AbortController().signal, log: () => {}, name: { log: "make 3", error: "make step 3" }, phase: "convert" };
    expect(failOf(await runSandboxedStep({ exe: "pack", argv: [], wine: false, timeoutSec: 5 }, o).catch(e => e))).toEqual({ class: "env", kind: "oom" });
    answer = res(2, { stderr: "no such folder" });
    const e = await runSandboxedStep({ exe: "pack", argv: [], wine: false, timeoutSec: 5 }, o).catch(x => x);
    expect([failOf(e), e.message]).toEqual([{ class: "plan", phase: "convert" }, "make step 3 failed (exit 2): no such folder"]);
    expect(failOf(await runSandboxedStep({ exe: "pack", argv: ["{content}"], wine: false, timeoutSec: 5 }, o).catch(x => x))).toEqual({ class: "plan", phase: "convert" });
    const w = await runSandboxedStep({ exe: "x.exe", argv: [], wine: true, timeoutSec: 5 }, o).catch(x => x);
    expect([failOf(w), w.message]).toEqual([{ class: "env", kind: "tool" }, "make step 3 runs a Windows program, and wine or its virtual display is not on this server"]);
    answer = res(3, { stdout: "partial" });
    expect((await runSandboxedStep({ exe: "pack", argv: [], wine: false, timeoutSec: 5 }, { ...o, judge: false })).code).toBe(3);   // a check judges it itself
  });

  test("whatever still runs as the job's user after a step is stopped (a container cannot read another uid's folders)", async () => {
    const procs = [{ pid: 3131, uid: 1501, euid: 1501 }, { pid: 3132, uid: 1502, euid: 1502 }];
    const seen = asContainer({ procs: [] });
    pdeps.tools = () => ({ ...tools7z });
    const work = join(tmp("sbx-reap-"), "job-77"), cwd = join(work, "run");
    mkdirSync(cwd, { recursive: true });
    expect(takeSandboxUser(77)?.uid).toBe(1501);
    sbdeps.procs = () => procs;
    const lines: string[] = [];
    await runSandboxedStep({ exe: "pack", argv: [], wine: false, timeoutSec: 5 }, { exe: "/opt/pack", cwd, fill: {}, work, signal: new AbortController().signal, log: l => lines.push(l), name: { log: "make 1", error: "make step 1" }, phase: "make" });
    expect(seen.killed).toEqual([3131]);                                      // never another job's
    expect(lines).toContain("make 1: stopped 1 process(es) it left running");
    expect(await stopUnder(work)).toBe(1);
  });
});

describe("no network for make and check steps, ludarr's own environment values", () => {
  test("where unshare -rn works as the build user, make and check steps run under it; setup and build steps keep the network", async () => {
    const seen = asContainer();
    pdeps.tools = () => ({ ...tools7z });
    const work = join(tmp("sbx-net-"), "job-9"), cwd = join(work, "run");
    mkdirSync(cwd, { recursive: true });
    const step = (phase: SandboxedStepOpts["phase"]) => runSandboxedStep({ exe: "pack", argv: ["x"], wine: false, timeoutSec: 5 }, { exe: "/opt/pack", cwd, fill: {}, work, signal: new AbortController().signal, log: () => {}, name: { log: "s", error: "step" }, phase });
    await step("make");
    expect(seen.cmds[0]).toEqual(["/usr/sbin/runuser", "-u", "builder", "--", "/usr/bin/unshare", "-rn", "true"]);   // the probe, once
    const run = seen.cmds[1];
    expect(run.slice(run.indexOf("/usr/bin/unshare"))).toEqual(["/usr/bin/unshare", "-rn", "/opt/pack", "x"]);
    await step("check");
    expect(seen.cmds[2]).toContain("/usr/bin/unshare");
    await step("setup");
    expect(seen.cmds[3]).not.toContain("/usr/bin/unshare");
    expect(seen.cmds.filter(c => c.includes("true")).length).toBe(1);
    expect(seen.logs).toContain("make and check steps run without a network (unshare -rn)");
    // a Windows program under wine keeps the network until wine inside the namespace is proven in the image
    pdeps.tools = () => ({ ...tools7z, wine: "/usr/bin/wine", xvfb: "/usr/bin/xvfb-run" });
    await runSandboxedStep({ exe: "x.exe", argv: [], wine: true, timeoutSec: 5 }, { exe: join(cwd, "x.exe"), cwd, fill: {}, work, signal: new AbortController().signal, log: () => {}, name: { log: "check 1", error: "check 1" }, phase: "check" });
    const wine = seen.cmds.find(c => c.includes("/usr/bin/wine"))!;
    expect(wine).not.toContain("/usr/bin/unshare");
  });

  test("where the container refuses new namespaces, they keep it, and the log says why", async () => {
    const seen = asContainer({ exec: cmd => (cmd.includes("true") ? { code: 1, stdout: "", stderr: "unshare: unshare failed: Operation not permitted", timedOut: false } : ok()) });
    expect(await noNetwork()).toBe(false);
    expect(seen.logs[0]).toBe("make and check steps keep the network: unshare -rn is refused here (exit 1: unshare: unshare failed: Operation not permitted)");
    await sandboxExec(["/opt/pack"], { work: tmp("sbx-net2-"), noNetwork: true });
    expect(seen.cmds[1]).not.toContain("/usr/bin/unshare");
  });

  test("WINEDEBUG and LANG may take ludarr's own value for one run; PATH, HOME, TMPDIR and WINEPREFIX never change", () => {
    const work = tmp("sbx-env-");
    const env = sandboxEnv(work, { EXTRA: "1" }, { WINEDEBUG: "err+all", PATH: "/evil", HOME: "/root", WINEPREFIX: "/x" });
    expect(env).toContain("WINEDEBUG=err+all");
    expect(env.filter(e => e.startsWith("WINEDEBUG="))).toEqual(["WINEDEBUG=err+all"]);
    expect(env).toContain(`HOME=${join(work, "home")}`);
    expect(env).toContain(`WINEPREFIX=${join(work, "wine")}`);
    expect(env.find(e => e.startsWith("PATH="))).toBe("PATH=/usr/local/bin:/usr/bin:/bin");
    expect(env).toContain("EXTRA=1");
  });
});

describe("the library stays ludarr's (H5)", () => {
  test("every entry of the stores and packages writable by others loses that write, a build user's goes back to root, links are not followed", async () => {
    const seen = asContainer();
    const store = tmp("sbx-scrub-");
    mkdirSync(join(store, "demons-souls"), { recursive: true });
    writeFileSync(join(store, "demons-souls", "PPSA01341-app0.zar"), "x");
    writeFileSync(join(store, "demons-souls", "planted.bin"), "x");
    sbdeps.lstat = async p => {
      const st = lstatSync(p);
      const fake = { mode: (st.mode & ~0o7777) | (st.isDirectory() ? 0o777 : p.endsWith("planted.bin") ? 0o664 : 0o666), uid: p.endsWith("planted.bin") ? 1503 : 99, gid: p.endsWith("planted.bin") ? 1503 : 100 };
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, fake);
    };
    const r = await scrubWorldWritable({ trees: [store] });
    expect(r).toEqual({ looked: 4, fixed: 4 });
    for (const [, m] of seen.chmods) expect(m & 0o002).toBe(0);
    expect(seen.chmods).toContainEqual([join(store, "demons-souls", "PPSA01341-app0.zar"), 0o664]);    // users (gid 100) keep their write
    expect(seen.chowns).toEqual([[join(store, "demons-souls", "planted.bin"), 0, 0]]);
    expect(seen.chmods).toContainEqual([join(store, "demons-souls", "planted.bin"), 0o644]);
    expect(seen.logs[0]).toMatch(/4 entries were writable by others or by a build program, and no longer are/);
    sbdeps.platform = () => "win32";
    expect(await scrubWorldWritable({ trees: [store] })).toEqual({ looked: 0, fixed: 0 });
  });
});

describe("the image's build users", () => {
  test("builder (1500) and builder1 … builder7 (1501-1507), each in a group of its own and none in 'users': the pool's own list", async () => {
    const df = await Bun.file("Dockerfile").text();
    const runtime = df.slice(df.lastIndexOf("\nFROM "));
    expect(runtime).toMatch(/RUN useradd --create-home --uid 1500 builder\r?\n/);
    expect(runtime).toMatch(/for i in 1 2 3 4 5 6 7; do groupadd --gid \$\(\(1500 \+ i\)\) builder\$i && useradd --create-home --uid \$\(\(1500 \+ i\)\) --gid \$\(\(1500 \+ i\)\) builder\$i/);
    expect(runtime).toMatch(/for u in builder builder1 builder2 builder3 builder4 builder5 builder6 builder7; do/);
    expect(runtime).toMatch(/! id -Gn "\$u" \| grep -qw users \|\| exit 1/);
    expect(runtime).not.toMatch(/useradd[^\n]*(?:-G|--groups)/);
    expect([...SANDBOX_USERS].map(u => `${u.user}:${u.uid}`).sort()).toEqual(["builder1:1501", "builder2:1502", "builder3:1503", "builder4:1504", "builder5:1505", "builder6:1506", "builder7:1507", "builder:1500"]);
  });
});

describe("a make's {prep} on the downloads folder's volume", () => {
  test("its job folder there is closed as the scratch folder is; a step hands it over and back with its own folder, and refuses a link left in it", async () => {
    let linkIt = false;
    const base = tmp("sbx-also-");
    const work = join(base, "library", ".work", "job-51", "make"), cwd = join(work, "run");
    const prep = join(spareJobFolder(join(base, "downloads"), 51), "prep");
    const seen = asContainer({ exec: cmd => {
      if (linkIt && cmd.includes("/usr/bin/unrar")) { writeFileSync(join(prep, "x", "a.bin"), "a"); linkSync(join(prep, "x", "a.bin"), join(prep, "x", "b.bin")); }
      return ok();
    } });
    const u = takeSandboxUser(51)!;
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(prep, "x"), { recursive: true });
    // closed before anything is written there: root's, open to the job's own user's group only
    await closeJobFolder(prep);
    const job = join(base, "downloads", ".ahoy-work", "job-51");
    expect(seen.chowns).toContainEqual([job, 0, u.uid]);
    expect(seen.chmods).toContainEqual([job, 0o750]);
    expect(sandboxUserFor(join(prep, "x"))).toEqual(u);                       // found by the job id in its path
    const step = () => runSandboxedStep({ exe: "/usr/bin/unrar", argv: ["x", "-y"], wine: false, timeoutSec: 60 }, {
      exe: "/usr/bin/unrar", cwd, also: [prep], fill: {}, work, signal: new AbortController().signal, log: () => {}, phase: "unpack", name: { log: "make 1", error: "make step 1" },
    });
    seen.chowns.length = 0;
    await step();
    expect(seen.chowns).toContainEqual([prep, u.uid, u.uid]);                 // the build user's while the step runs
    expect(seen.chowns).toContainEqual([prep, 0, 0]);                         // root's again after it
    linkIt = true;
    const e = await step().catch(x => x);
    expect(e).toBeInstanceOf(PlanFault);
    expect(failOf(e)).toEqual({ class: "plan", phase: "unpack" });
    expect(e.message).toMatch(/^make step 1 holds a hard link \(x\/[ab]\.bin\), and a package carries files of its own only$/);
  });
});
