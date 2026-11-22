import { describe, expect, test } from "bun:test";
import { realExec } from "../src/process/tools";

describe("the executor", () => {
  test.skipIf(process.platform !== "linux")("an abort or a timeout takes the whole process tree with it and returns promptly, even when a grandchild holds the pipes", async () => {
    const t0 = Date.now();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    // the inner sleep inherits stdout: without a group kill it would keep the pipe open for a minute
    const r = await realExec(["bash", "-c", "sleep 60 & sleep 60"], { signal: ac.signal, timeoutMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.code).not.toBe(0);
    const r2 = await realExec(["bash", "-c", "sleep 60 & sleep 60"], { timeoutMs: 500 });
    expect(r2.timedOut).toBe(true);
  });
  test("a normal command returns its output and code", async () => {
    const r = await realExec(process.platform === "win32" ? ["cmd", "/c", "echo hi"] : ["sh", "-c", "echo hi"], { timeoutMs: 10_000 });
    expect(r.code).toBe(0); expect(r.stdout.trim()).toBe("hi"); expect(r.timedOut).toBe(false);
  });
});
