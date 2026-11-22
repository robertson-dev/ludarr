/**
 * What ludarr (root) does with what the build programs leave and with the folders around their work (src/ways/sandbox.ts):
 * a file a build program wrote is read without following a link and only when it has one name, a build's output is taken
 * only when no link leads to it, the folder the jobs' folders sit in is closed to others (so no build program can swap
 * another job's folder), the scrub covers the root and work folders themselves, and a program's own words never pass
 * for the shell's out-of-memory line. On this Windows box links are directory junctions, and the Linux parts are fakes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdirSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { failOf } from "../src/ways/errors";
import { buildFileProblem, readBuildFile, resetSandbox, sandboxExec, sbdeps, scrubWorldWritable, stepFailure, takeSandboxUser } from "../src/ways/sandbox";
import { dirLink, ok, restoreDeps, tmp } from "./ways-fixtures";

const PASSWD = ["root:x:0:0:root:/root:/bin/bash", "builder:x:1500:1500::/home/builder:/bin/sh", ...[1, 2, 3, 4, 5, 6, 7].map(i => `builder${i}:x:${1500 + i}:${1500 + i}::/home/builder${i}:/bin/sh`)].join("\n");
const withMode = (st: Stats, mode: number): Stats => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: (st.mode & ~0o7777) | mode });

function asContainer(modes: (p: string, st: Stats) => number = (_p, st) => (st.isDirectory() ? 0o755 : 0o644)) {
  const seen = { chowns: [] as [string, number, number][], chmods: [] as [string, number][], logs: [] as string[] };
  sbdeps.platform = () => "linux";
  sbdeps.uid = () => 0;
  sbdeps.which = n => (n === "runuser" ? "/usr/sbin/runuser" : null);
  sbdeps.passwd = () => PASSWD;
  sbdeps.group = () => "users:x:100:\n";
  sbdeps.procs = () => [];
  sbdeps.chown = async (p, u, g) => { seen.chowns.push([p, u, g]); };
  sbdeps.chmod = async (p, m) => { seen.chmods.push([p, m]); };
  sbdeps.lstat = async p => { const st = lstatSync(p); return withMode(st, modes(p, st)); };
  sbdeps.log = l => { seen.logs.push(l); };
  sbdeps.exec = async () => ok();
  return seen;
}
afterEach(() => { restoreDeps(); resetSandbox(); });

describe("what a build program wrote, read by ludarr", () => {
  test("a plain file's last bytes are read; a link (here a junction), a folder or a file with a second name never is", async () => {
    const dir = tmp("sbx-read-");
    writeFileSync(join(dir, "out.txt"), "line 1\nline 2\nthe end");
    expect((await readBuildFile(join(dir, "out.txt"), 7))!.toString()).toBe("the end");
    expect((await readBuildFile(join(dir, "out.txt"), 1000))!.toString()).toBe("line 1\nline 2\nthe end");
    // root's own file, reached by a second name the build program made beside its output: never read
    const secret = join(tmp("sbx-secret-"), "keys.json");
    writeFileSync(secret, '{"apiKey":"s3cret"}');
    linkSync(secret, join(dir, "smoke-output.txt"));
    expect(await readBuildFile(join(dir, "smoke-output.txt"), 1000)).toBeNull();
    dirLink(tmp("sbx-elsewhere-"), join(dir, "smoke.png"));
    expect(await readBuildFile(join(dir, "smoke.png"), 1000)).toBeNull();
    expect(await readBuildFile(join(dir, "missing"), 10)).toBeNull();
  });

  test("a build's output is taken only as a plain file of its own, reached through no link on the way", async () => {
    const src = tmp("sbx-build-");
    mkdirSync(join(src, "b"), { recursive: true });
    writeFileSync(join(src, "b", "zarchive"), "built");
    expect(await buildFileProblem(src, "b/zarchive")).toBeNull();
    const elsewhere = tmp("sbx-root-only-");
    writeFileSync(join(elsewhere, "zarchive"), "root's own file");
    dirLink(elsewhere, join(src, "out"));
    expect(await buildFileProblem(src, "out/zarchive")).toBe("out is a link, and nothing is taken through one");
    linkSync(join(src, "b", "zarchive"), join(src, "b", "zarchive-again"));
    expect(await buildFileProblem(src, "b/zarchive")).toBe("b/zarchive has more than one name (a hard link)");
    expect(await buildFileProblem(src, "b/nothing")).toBe("there is no b/nothing");
    expect(await buildFileProblem(src, "b")).toBe("b is not a file");
  });
});

describe("the folders around the jobs' work", () => {
  test("the folder the jobs' folders sit in loses write for others (unless it is sticky), so no build program can swap another job's folder", async () => {
    const root = tmp("sbx-work-"), work = join(root, ".work"), job = join(work, "job-61");
    mkdirSync(job, { recursive: true });
    let seen = asContainer((p, st) => (p === work ? 0o777 : st.isDirectory() ? 0o755 : 0o644));
    expect(takeSandboxUser(61)).not.toBeNull();
    await sandboxExec(["true"], { work: job });
    expect(seen.chmods).toContainEqual([work, 0o775]);
    expect(seen.logs.some(l => l.startsWith(`${work} was writable by others: no longer`))).toBe(true);
    // a sticky one (like /tmp) already keeps others' entries from being renamed: left as it is
    resetSandbox();
    seen = asContainer((p, st) => (p === work ? 0o1777 : st.isDirectory() ? 0o755 : 0o644));
    takeSandboxUser(61);
    await sandboxExec(["true"], { work: job });
    expect(seen.chmods.some(([p]) => p === work)).toBe(false);
  });

  test("the scrub looks at each root folder and its work folder by itself (not walked): write for others goes, users keep theirs", async () => {
    const root = tmp("sbx-lib-"), work = join(root, ".work");
    mkdirSync(join(work, "job-1", "staging"), { recursive: true });
    const seen = asContainer((p, st) => (p === root || p === work ? 0o777 : st.isDirectory() ? 0o777 : 0o666));
    sbdeps.libraryTrees = async () => [];
    sbdeps.libraryFolders = async () => [root, work];
    const r = await scrubWorldWritable();
    expect(r).toEqual({ looked: 2, fixed: 2 });
    expect(seen.chmods).toEqual([[root, 0o775], [work, 0o775]]);                  // gid 'users' keeps its write: the share still works
    expect(seen.logs).toContain(`${work} was writable by others or by a build program, and no longer is`);
    // a scrub of given trees looks at no folder beyond them
    seen.chmods.length = 0;
    await scrubWorldWritable({ trees: [join(work, "job-1")] });
    expect(seen.chmods.some(([p]) => p === root || p === work)).toBe(false);
  });
});

describe("a program's own words never pass for the server's trouble (M2)", () => {
  test("only the shell's own out-of-memory line counts, with its name and line number; a line a program prints does not", () => {
    const p = { name: "make step 2", timeoutSec: 60, wine: false, phase: "make" as const };
    const res = (stderr: string) => ({ code: 1, stdout: "", stderr, timedOut: false });
    expect(failOf(stepFailure(res("bash: line 3:  9001 Killed                  ./pack in out"), p))).toEqual({ class: "env", kind: "oom" });
    expect(failOf(stepFailure(res("./build.sh: line 12: 77 Killed    make -j16"), p))).toEqual({ class: "env", kind: "oom" });
    expect(failOf(stepFailure(res("loading\n3 Killed by the dragon\nexit"), p))).toEqual({ class: "plan", phase: "make" });
    expect(failOf(stepFailure(res("12 Killed"), p))).toEqual({ class: "plan", phase: "make" });
  });
});
