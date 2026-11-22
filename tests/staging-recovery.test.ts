import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordWhenAvailable, db } from "../src/db";
import { downloadsDir, workDir, stagingDir } from "../src/config";
import { clearInterruptedWork } from "../src/process/checkpoint";
import { unpack, type RecipeCtx } from "../src/process/recipes";

test("the server initializes a fresh database before the download picker or catalog runs", async () => {
  const probe = Bun.spawn([process.execPath, "-e", 'await import("./src/server")'], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DB_PATH: ":memory:" }, stderr: "pipe" });
  const diagnostic = await new Response(probe.stderr).text();
  expect(await probe.exited, diagnostic).toBe(0);
});

test("an actual SQLite writer lock defers progress; the next update succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "ludarr-lock-"));
  const a = new Database(join(root, "test.db")), b = new Database(join(root, "test.db"));
  try {
    a.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER); BEGIN IMMEDIATE");
    b.exec("PRAGMA busy_timeout=10");
    expect(recordWhenAvailable(() => b.exec("INSERT INTO t VALUES(1)"))).toBe(false);
    a.exec("COMMIT");
    expect(recordWhenAvailable(() => b.exec("INSERT INTO t VALUES(2)"))).toBe(true);
    expect(b.query("SELECT n FROM t").all()).toEqual([{ n: 2 }]);
    expect(() => recordWhenAvailable(() => b.exec("SELECT * FROM missing_table"))).toThrow();
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  } finally { a.close(); b.close(); await rm(root, { recursive: true }); }
});

test("staging uses an existing mount for both downloads and work", async () => {
  const root = await mkdtemp(join(tmpdir(), "ludarr-ssd-"));
  const previous = process.env.LUDARR_STAGING;
  try {
    process.env.LUDARR_STAGING = root;
    expect(stagingDir()).toBe(root);
    expect(downloadsDir()).toBe(join(root, "downloads"));
    expect(workDir()).toBe(join(root, "work"));
    process.env.LUDARR_STAGING = join(root, "absent");
    expect(() => downloadsDir()).toThrow();
  } finally {
    if (previous === undefined) delete process.env.LUDARR_STAGING; else process.env.LUDARR_STAGING = previous;
    await rm(root, { recursive: true });
  }
});

test("regular imports reuse only complete extractions of the same archive volumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ludarr-unpack-"));
  const work = join(root, "work"), out = join(work, "staging"), archive = join(root, "game.part01.rar"), second = join(root, "game.part02.rar");
  await mkdir(work);
  await writeFile(archive, "first");
  await writeFile(second, "other");
  let runs = 0;
  const ctx: RecipeCtx = {
    work, tools: { unrar: "unrar" } as RecipeCtx["tools"], log() {},
    exec: async args => {
      runs++;
      await writeFile(join(args.at(-1)!, "data.bin"), String(runs));
      if (runs === 1) throw new Error("interrupted before completion");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
  try {
    await expect(unpack(ctx, archive, out)).rejects.toThrow("interrupted");
    await clearInterruptedWork(work);
    await unpack(ctx, archive, out);
    await clearInterruptedWork(work);
    await unpack(ctx, archive, out);
    expect(runs).toBe(2);
    expect(await readFile(join(out, "data.bin"), "utf8")).toBe("2");
    await writeFile(second, "changed part");
    await clearInterruptedWork(work);
    await unpack(ctx, archive, out);
    expect(runs).toBe(3);
  } finally { await rm(root, { recursive: true }); }
});
