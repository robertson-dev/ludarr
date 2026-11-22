import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { lftpScript, remotePath, localPathFor, startPull, diskBytes, transportUrl, type Spawner, type PullOpts } from "../src/pull";

const DL = process.env.AHOY_DOWNLOADS!;
const opts = (over: Partial<PullOpts> = {}): PullOpts => ({ url: "sftp://me:p%40ss@box.example:2222", downloadsDir: DL, ...over });

describe("remotePath", () => {
  test("strips a chroot prefix only when configured", () => {
    expect(remotePath("/home/me/downloads/Hades")).toBe("/home/me/downloads/Hades");
    expect(remotePath("/home/me/downloads/Hades", "/home/me/")).toBe("/downloads/Hades");
    expect(remotePath("/home/me", "/home/me/")).toBe("/");
    expect(remotePath("/other/Hades", "/home/me/")).toBe("/other/Hades");
  });
  test("only sftp / ftp / https transports count", () => {
    expect(transportUrl("sftp://me:p@box:22")?.hostname).toBe("box");
    expect(transportUrl("bogus://x")).toBeNull();
    expect(transportUrl("")).toBeNull();
  });
});

describe("lftpScript", () => {
  const u = () => new URL(opts().url);
  test("directory → mirror with pget segments, creds stay in the open line (percent-encoded)", () => {
    const s = lftpScript(u(), { remotePath: "/home/me/dl/Hades v1 \"GOTY\"", isDir: true, expectedBytes: 1 }, opts({ segments: 6 }));
    expect(s).toContain('open "sftp://me:p%40ss@box.example:2222"');
    expect(s).toContain("set sftp:auto-confirm yes");
    expect(s).toContain("set ssl:verify-certificate yes");
    expect(s).toMatch(/mirror --continue --use-pget-n=6 --parallel=2 --no-perms "\/home\/me\/dl\/Hades v1 \\"GOTY\\"" ".*Hades v1 \\"GOTY\\""/);
    expect(s.trim().endsWith("quit")).toBe(true);
  });
  test("single file → pget into the downloads dir; TLS verify can be switched off", () => {
    const s = lftpScript(u(), { remotePath: "/home/me/dl/game.iso", isDir: false, expectedBytes: 1 }, opts({ verifyTls: false, segments: 4 }));
    expect(s).toContain("set ssl:verify-certificate no");
    expect(s).toMatch(/pget -c -n 4 -O ".+" "\/home\/me\/dl\/game.iso"/);
    expect(localPathFor({ remotePath: "/home/me/dl/game.iso", isDir: false, expectedBytes: 0 }, opts())).toBe(join(DL, "game.iso"));
  });
});

describe("startPull", () => {
  const fakeSpawn = (exitCode: number, onStart?: (script: string) => Promise<void>): Spawner & { script: string } => {
    let script = "";
    let resolveExit!: (n: number) => void;
    const exited = new Promise<number>(r => { resolveExit = r; });
    const sp = ((_cmd: string[]) => ({
      stdin: {
        write(s: string) { script += s; },
        end() { (onStart ? onStart(script) : Promise.resolve()).then(() => resolveExit(exitCode)); },
      },
      stderr: new Response("lftp: mirror: Access failed: No such file\nfinal line\n").body,
      exited,
      kill() { resolveExit(137); },
    })) as unknown as Spawner & { script: string };
    Object.defineProperty(sp, "script", { get: () => script });
    return sp;
  };

  test("success: local bytes are measured on disk and reported", async () => {
    const job = { remotePath: "/home/me/dl/HadesDir", isDir: true, expectedBytes: 10 };
    const local = localPathFor(job, opts());
    await rm(local, { recursive: true, force: true });
    const sp = fakeSpawn(0, async () => { await mkdir(local, { recursive: true }); await writeFile(join(local, "a.bin"), new Uint8Array(10)); });
    const h = startPull(job, opts(), sp);
    const res = await h.done;
    expect(res.ok).toBe(true);
    expect(res.localPath).toBe(local);
    expect(res.bytes).toBe(10);
    expect(h.progress()).toBe(1);
    expect(sp.script).toContain("mirror --continue");
    expect(await diskBytes(local)).toBe(10);
  });
  test("failure: exit code and the tail of stderr are reported", async () => {
    const h = startPull({ remotePath: "/home/me/dl/missing.iso", isDir: false, expectedBytes: 5 }, opts(), fakeSpawn(1));
    const res = await h.done;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/lftp exit 1: .*No such file.*final line/);
  });
  test("missing transport short-circuits before spawning", async () => {
    const res = await startPull({ remotePath: "/x", isDir: true, expectedBytes: 1 }, opts({ url: "" }), fakeSpawn(0)).done;
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/no transfer URL/) });
  });
});

describe("review 2026-11-10: a client that reports its root as the item's path", () => {
  test("the download gets a folder of its own, never the downloads folder itself or its parent", () => {
    expect(localPathFor({ remotePath: "/home/me", isDir: true, expectedBytes: 0 }, opts({ pathStrip: "/home/me/" }))).toBe(join(DL, "download"));
    expect(localPathFor({ remotePath: "/", isDir: true, expectedBytes: 0 }, opts())).toBe(join(DL, "download"));
    expect(localPathFor({ remotePath: "/home/me/..", isDir: true, expectedBytes: 0 }, opts())).toBe(join(DL, "download"));
    expect(localPathFor({ remotePath: "/home/me/dl/Hades/", isDir: true, expectedBytes: 0 }, opts())).toBe(join(DL, "Hades"));
  });
});
