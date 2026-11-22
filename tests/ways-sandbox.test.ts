import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_USER, SANDBOX_PATH, handTo, sandboxAvailable, sandboxEnv, sandboxExec, sandboxOrAllowed, sandboxed, sbdeps } from "../src/ways/sandbox";
import { realExec } from "../src/process/tools";
import { lockConfig } from "../src/bootstrap";
import { makeBackup } from "../src/api/system";
import { dirLink, ok, restoreDeps, tempConfig, tmp } from "./ways-fixtures";

afterEach(() => { restoreDeps(); delete process.env.LUDARR_ALLOW_UNSANDBOXED; });

/** a Linux box running as root with runuser and the build user, as the Docker image is */
function asContainer(chowns: [string, number, number][] = [], chmods: [string, number][] = []) {
  sbdeps.platform = () => "linux";
  sbdeps.uid = () => 0;
  sbdeps.which = n => (n === "runuser" ? "/usr/sbin/runuser" : null);
  sbdeps.passwd = () => "root:x:0:0:root:/root:/bin/bash\nbuilder:x:1500:1500::/home/builder:/bin/sh\n";
  sbdeps.chown = async (p, u, g) => { chowns.push([p, u, g]); };
  sbdeps.chmod = async (p, m) => { chmods.push([p, m]); };
  return { chowns, chmods };
}

describe("the build sandbox", () => {
  test("it is there only on Linux, as root, with runuser and the build user", () => {
    asContainer();
    expect(sandboxAvailable()).toBe(true);
    sbdeps.uid = () => 1000; expect(sandboxAvailable()).toBe(false);                   // runuser needs root
    asContainer(); sbdeps.which = () => null; expect(sandboxAvailable()).toBe(false);
    asContainer(); sbdeps.passwd = () => "root:x:0:0:root:/root:/bin/bash\n"; expect(sandboxAvailable()).toBe(false);
    asContainer(); sbdeps.platform = () => "win32"; expect(sandboxAvailable()).toBe(false);
  });

  test("a command runs as the build user with nothing but the sandbox's environment", async () => {
    const { chowns } = asContainer();
    const calls: { cmd: string[]; opts: any }[] = [];
    sbdeps.exec = async (cmd, opts) => { calls.push({ cmd, opts }); return ok(); };
    const work = tmp("sbx-");
    await sandboxExec(["/usr/bin/xvfb-run", "-a", "wine", "x.exe"], { work, cwd: work, timeoutMs: 5000, env: { WINEDLLOVERRIDES: "mscoree=", PATH: "/evil", HOME: "/root" } });
    const { cmd, opts } = calls[0];
    expect(cmd.slice(0, 6)).toEqual(["/usr/sbin/runuser", "-u", BUILD_USER, "--", "env", "-i"]);
    // the fixed list first; a caller's extra names after it, and never over it (PATH and HOME stay the sandbox's)
    expect(cmd.slice(6, 13)).toEqual([`PATH=${SANDBOX_PATH}`, `HOME=${join(work, "home")}`, "LANG=C.UTF-8", `TMPDIR=${join(work, "tmp")}`, `WINEPREFIX=${join(work, "wine")}`, "WINEDEBUG=-all", "WINEDLLOVERRIDES=mscoree="]);
    expect(cmd.slice(13)).toEqual(["/usr/bin/xvfb-run", "-a", "wine", "x.exe"]);
    expect(cmd.filter(a => a.startsWith("PATH=")).length).toBe(1);
    expect([opts.inheritEnv, opts.cwd, opts.timeoutMs]).toEqual([false, work, 5000]);
    expect(opts.env).toEqual({ PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" });   // runuser itself gets a PATH and nothing else
    // home, temp, the wine prefix (wine refuses one it does not own) and the scratch folder belong to the build user
    for (const d of ["home", "tmp", "wine", "scratch"]) expect(chowns).toContainEqual([join(work, d), 1500, 1500]);
    expect(statSync(join(work, "wine")).isDirectory()).toBe(true);
  });

  test("without the sandbox (a dev box) the same environment list, nothing inherited, as the current user", async () => {
    sbdeps.platform = () => "win32";
    const calls: { cmd: string[]; opts: any }[] = [];
    sbdeps.exec = async (cmd, opts) => { calls.push({ cmd, opts }); return ok(); };
    const work = tmp("sbx-");
    await sandboxed(work)(["7z", "x", "a.zip"], { timeoutMs: 1000, env: { EXTRA: "1" } });
    expect(calls[0].cmd).toEqual(["7z", "x", "a.zip"]);
    expect(calls[0].opts.inheritEnv).toBe(false);
    expect(calls[0].opts.env).toEqual({ PATH: SANDBOX_PATH, HOME: join(work, "home"), LANG: "C.UTF-8", TMPDIR: join(work, "tmp"), WINEPREFIX: join(work, "wine"), WINEDEBUG: "-all", EXTRA: "1" });
    expect(sandboxEnv(work, { "BAD NAME": "x", OK_1: "y" })).toContain("OK_1=y");
    expect(sandboxEnv(work, { "BAD NAME": "x" }).some(kv => kv.startsWith("BAD"))).toBe(false);
  });

  test("a program started with inheritEnv false sees none of ludarr's environment", async () => {
    process.env.LUDARR_TEST_SECRET = "s3cret-key";
    try {
      const r = await realExec([process.execPath, "-e", "console.log(JSON.stringify(process.env))"], { inheritEnv: false, env: { ONLY_THIS: "1", PATH: SANDBOX_PATH } });
      const seen = JSON.parse(r.stdout.trim()) as Record<string, string>;
      expect(seen.ONLY_THIS).toBe("1");
      expect(seen.LUDARR_TEST_SECRET).toBeUndefined();
      expect(Object.values(seen).some(v => v.includes("s3cret"))).toBe(false);
    } finally { delete process.env.LUDARR_TEST_SECRET; }
  });

  test("a tree goes to the build user and back to root without following a link; back at root nothing is writable by others", async () => {
    const { chowns, chmods } = asContainer();
    const root = tmp("sbx-tree-"), outside = tmp("sbx-outside-");
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a", "f.txt"), "x");
    writeFileSync(join(outside, "secret.txt"), "x");
    dirLink(outside, join(root, "link"));
    await handTo(root, "builder");
    expect(chowns.map(c => c[0])).toEqual(expect.arrayContaining([root, join(root, "a"), join(root, "a", "f.txt"), join(root, "link")]));
    expect(chowns.some(c => c[0].startsWith(outside))).toBe(false);                  // the link itself, never what it points at
    expect(chowns.every(c => c[1] === 1500)).toBe(true);
    chowns.length = 0;
    await handTo(root, "root");
    expect(chowns.every(c => c[1] === 0 && c[2] === 0)).toBe(true);
    expect(chmods.length).toBeGreaterThan(0);
    for (const [p, m] of chmods) { expect(m & 0o022).toBe(0); expect(m & 0o7000).toBe(0); expect(p.startsWith(outside)).toBe(false); }
    // without the sandbox there is nothing to hand over
    sbdeps.platform = () => "win32"; chowns.length = 0;
    await handTo(root, "builder");
    expect(chowns).toEqual([]);
  });

  test("setup programs run only in the sandbox, unless the box's owner allows it (LUDARR_ALLOW_UNSANDBOXED=1)", () => {
    sbdeps.platform = () => "win32";
    expect(sandboxOrAllowed()).toBe(false);
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    expect(sandboxOrAllowed()).toBe(true);
  });
});

describe("<config> is root's alone", () => {
  test("the image has the build user", async () => {
    const df = await Bun.file("Dockerfile").text();
    const runtime = df.slice(df.lastIndexOf("\nFROM "));
    expect(runtime).toMatch(/RUN useradd --create-home --uid 1500 builder/);
  });
  test("bootstrap locks <config> before anything else", async () => {
    expect(await Bun.file("src/bootstrap.ts").text()).toMatch(/export function bootstrap\(\) \{\s*lockConfig\(\);/);
  });
  test.skipIf(process.platform === "win32")("the database, its journal files, ludarr.env and every backup are 0600, the folders 0700", () => {
    const dir = tmp("cfg-");
    for (const f of ["ludarr.db", "ludarr.db-wal", "ludarr.db-shm", "ludarr.env"]) writeFileSync(join(dir, f), "x");
    mkdirSync(join(dir, "backups"));
    writeFileSync(join(dir, "backups", "ludarr-2026-11-01.db"), "x");
    lockConfig(dir, join(dir, "ludarr.db"));
    const mode = (p: string) => statSync(join(dir, p)).mode & 0o777;
    expect(mode(".")).toBe(0o700);
    for (const f of ["ludarr.db", "ludarr.db-wal", "ludarr.db-shm", "ludarr.env", "backups/ludarr-2026-11-01.db"]) expect([f, mode(f)]).toEqual([f, 0o600]);
    expect(mode("backups")).toBe(0o700);
  });
  test.skipIf(process.platform === "win32")("a new backup is made private: the folder 0700, the file 0600", async () => {
    const cfg = tempConfig();
    try {
      const name = await makeBackup();
      expect(statSync(join(cfg.dir, "backups")).mode & 0o777).toBe(0o700);
      expect(statSync(join(cfg.dir, "backups", name)).mode & 0o777).toBe(0o600);
    } finally { cfg.restore(); }
  });
});
