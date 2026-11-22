import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree, reapUnder, type ProcRef } from "../src/fsutil";

describe("removeTree", () => {
  test("takes a nested tree away in one pass and reports nothing left", async () => {
    const root = await mkdtemp(join(tmpdir(), "ludarr-rt-"));
    await mkdir(join(root, "a", "b", "c"), { recursive: true });
    for (let i = 0; i < 40; i++) await writeFile(join(root, "a", "b", `f${i}`), "x");
    await writeFile(join(root, "a", "b", "c", "deep"), "y");
    expect(await removeTree(root)).toEqual([]);
    expect(await stat(root).catch(() => null)).toBeNull();
  });
  test("a path that is not there is nothing to do", async () => {
    expect(await removeTree(join(tmpdir(), "ludarr-rt-never-there"))).toEqual([]);
  });
});

describe("reapUnder", () => {
  const procs: ProcRef[] = [
    { pid: 100, pgid: 100, name: "bun", paths: ["/app", "/library/.work/job-9/staging/x"] },            // ourselves: never
    { pid: 241, pgid: 230, name: "Xvfb", paths: ["/library/.work/job-9", "/library/.work/job-9/xvfb.log"] },
    { pid: 300, pgid: 300, name: "wine", paths: ["/usr/bin/wine", "/library/.work/job-9/wine"] },       // WINEPREFIX
    { pid: 400, pgid: 400, name: "other", paths: ["/library/.work/job-90/x"] },                          // a sibling folder, not ours
    { pid: 500, pgid: 500, name: "sh", paths: ["/library"] },
  ];
  test("kills what still works out of the folder — group first — and nobody else", async () => {
    const killed: string[] = [];
    const got = await reapUnder("/library/.work/job-9", { procs: async () => procs, kill: (pid, sig) => killed.push(`${pid}:${sig}`), self: 100, wait: 0 });
    expect(got.sort()).toEqual([241, 300]);
    expect(killed).toEqual(["-230:SIGKILL", "241:SIGKILL", "-300:SIGKILL", "300:SIGKILL"]);
  });
  test("a kill that fails (already gone) is not an error", async () => {
    const got = await reapUnder("/library/.work/job-9", { procs: async () => procs, kill: () => { throw new Error("ESRCH"); }, self: 100, wait: 0 });
    expect(got.length).toBe(2);
  });
});
