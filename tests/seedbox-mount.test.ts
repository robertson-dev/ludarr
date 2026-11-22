/**
 * The seedbox mount's watchdog (deploy/seedbox-mount.sh, installed by deploy/seedbox-mount.py): calm — it remounts only a
 * mount that is dead (nothing mounted, no rclone serving it, a FUSE endpoint that is gone), never on one slow listing; a
 * mount rclone serves that stops answering is remounted only after 5 failed looks over 10 minutes and only when the seedbox
 * itself answers; a remount stops the old rclone first (TERM, then KILL) and never starts a second one beside it; no VFS
 * cache. Its decisions run under bash with the system's commands stubbed (skipped where there is no bash that reads this
 * machine's paths); the script's text and the installer are checked everywhere.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// (as the installer reads it: a checkout on Windows may carry CRLF, which the deployed script never does)
const TEMPLATE = readFileSync(join(root, "deploy", "seedbox-mount.sh"), "utf8").replace(/\r\n/g, "\n");
const INSTALLER = readFileSync(join(root, "deploy", "seedbox-mount.py"), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "seedbox-mount-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
/** a path as bash reads it here (Git Bash takes C:/… as it is) */
const fwd = (p: string) => p.replace(/\\/g, "/");
const OLD_CACHE = join(tmp, "rclone-cache");
const MP = "/mnt/addons/seedbox/downloads";
const filled = TEMPLATE.replace("@@REMOTE@@", "seedbox:downloads").replace("@@MP@@", MP).replace("@@CONF@@", "/boot/config/plugins/rclone/.rclone.conf").replace("@@OLD_CACHE@@", fwd(OLD_CACHE));
const SCRIPT = join(tmp, "seedbox-mount.sh");
writeFileSync(SCRIPT, filled);

/** a bash that runs scripts from this machine's temp folder (none: the runs below are skipped) */
const bash = (() => {
  const b = Bun.which("bash");
  if (!b) return null;
  const probe = join(tmp, "probe.txt");
  writeFileSync(probe, "yes");
  try { const r = Bun.spawnSync([b, "-c", `cat "${fwd(probe)}"`]); return r.exitCode === 0 && r.stdout.toString().trim() === "yes" ? b : null; } catch { return null; }
})();

/** the system's commands, stubbed. The process table ($PROCS: "pid command line") holds the mount as the Unraid rclone plugin
 *  runs it — its /usr/sbin/rclone is a wrapper for `rcloneorig --config <its conf> "$@"` (WRAP=1; WRAP=0: a plain rclone) —
 *  and pgrep matches its pattern against those command lines as the real one does. The mount table ($SEEDBOX_MOUNTINFO, as
 *  /proc/self/mountinfo) holds the mount (MOUNTED); rclone serving it (ALIVE; DIES: it stops on TERM; STUCK: not even on
 *  KILL), its endpoint (GONE), a listing's exit code (LS_RC), the seedbox's own answer (BOX_RC), the clock (NOW). Every action
 *  goes to $CALLS, in order — a call of `mountpoint` too (it stats the mount, and a stuck FUSE root hangs it) */
const STUBS = `
wrapper() { if [ "$WRAP" = 1 ]; then echo "/usr/sbin/rcloneorig --config /boot/config/plugins/rclone/.rclone.conf"; else echo "/usr/sbin/rclone"; fi; }
mi_add() { echo "36 25 0:32 / $1 rw,relatime shared:1 - $2 $3 rw" >> "$SEEDBOX_MOUNTINFO"; }
mi_del() { grep -v " $1 rw,relatime" "$SEEDBOX_MOUNTINFO" > "$SEEDBOX_MOUNTINFO.tmp"; command mv "$SEEDBOX_MOUNTINFO.tmp" "$SEEDBOX_MOUNTINFO"; }
mountpoint() { echo "mountpoint $*" >> "$CALLS"; return 0; }
pgrep() {
  local a=0 pid cmd; while [ "\${1#-}" != "$1" ]; do case "$1" in *a*) a=1;; esac; shift; done
  while read -r pid cmd; do printf '%s\\n' "$cmd" | grep -Eq -- "$1" && { if [ $a = 1 ]; then echo "$pid $cmd"; else echo "$pid"; fi; }; done < "$PROCS"
  return 0
}
stat() { if [ "$GONE" = 1 ]; then echo "stat: cannot statx '$2': Transport endpoint is not connected" >&2; return 1; fi; return 0; }
ls() { return "$LS_RC"; }
timeout() { shift; "$@"; }
rclone() { echo "rclone $*" >> "$CALLS"; if [ "$1" = lsf ]; then return "$BOX_RC"; fi; echo "$((5000 + RANDOM % 1000)) $(wrapper) $*" >> "$PROCS"; mi_add "$3" fuse.rclone "$2"; GONE=0; return 0; }
fusermount() { echo "fusermount $*" >> "$CALLS"; mi_del "$2"; GONE=0; }
kill() {
  if [ "$1" = -0 ]; then builtin kill "$@"; return; fi
  echo "kill $*" >> "$CALLS"; local sig=$1 p; shift
  case "$sig" in -TERM) [ "$DIES" = 1 ] || return 0;; -KILL) [ "$STUCK" = 1 ] && return 0;; esac
  for p in "$@"; do grep -v "^$p " "$PROCS" > "$PROCS.tmp"; command mv "$PROCS.tmp" "$PROCS"; done; return 0
}
sleep() { command sleep 0.02; }
date() { if [ "\${1:-}" = +%s ]; then echo "$NOW"; else command date "$@"; fi; }
mkdir() { :; }
rm() { echo "rm $*" >> "$CALLS"; }
`;
/** the world a check starts from: the array's share and (MOUNTED) the mount in the mount table, (ALIVE) its rclone */
const WORLD = `
: > "$PROCS"; : > "$SEEDBOX_MOUNTINFO"
echo "22 1 0:20 / /mnt/user rw,relatime shared:2 - fuse.shfs shfs rw" >> "$SEEDBOX_MOUNTINFO"
[ "$MOUNTED" = 1 ] && mi_add "$MP" fuse.rclone "$REMOTE"
[ "$ALIVE" = 1 ] && echo "4242 $(wrapper) mount $REMOTE $MP --config $CONF --allow-other --daemon --umask 022 --vfs-cache-mode off" >> "$PROCS"
true
`;

let runN = 0;
/** one bash: the script's functions, the stubs, the facts, then `body`; what it printed, what it did, its log and state */
function run(body: string, facts: Record<string, string | number> = {}): { out: string; calls: string[]; log: string; state: string; procs: string[] } {
  const dir = join(tmp, `run-${++runN}`);
  mkdirSync(dir, { recursive: true });
  const f = { NOW: 100_000, MOUNTED: 1, ALIVE: 1, DIES: 1, STUCK: 0, GONE: 0, LS_RC: 0, BOX_RC: 0, WRAP: 1, ...facts };
  const script = [
    `export SEEDBOX_MOUNT_LOG="${fwd(join(dir, "log"))}" SEEDBOX_MOUNT_STATE="${fwd(join(dir, "state"))}" SEEDBOX_MOUNTINFO="${fwd(join(dir, "mountinfo"))}"`,
    `CALLS="${fwd(join(dir, "calls"))}"; : > "$CALLS"; PROCS="${fwd(join(dir, "procs"))}"`,
    `source "${fwd(SCRIPT)}" --lib`,
    STUBS,
    Object.entries(f).map(([k, v]) => `${k}=${v}`).join("; "),
    WORLD,
    "TERM_WAIT=3; KILL_WAIT=3",                                  // the script's 30 s waits, shortened (its loops are what is tested)
    body,
    "true",                                                      // a step that fails on purpose (no second rclone) is no bash failure
  ].join("\n");
  const r = Bun.spawnSync([bash!, "-c", script], { stdout: "pipe", stderr: "pipe" });
  const read = (n: string) => { try { return readFileSync(join(dir, n), "utf8"); } catch { return ""; } };
  if (r.exitCode !== 0) throw new Error(`bash failed (${r.exitCode}): ${r.stderr.toString()}`);
  return { out: r.stdout.toString().trim(), calls: read("calls").split("\n").filter(Boolean), log: read("log"), state: read("state").trim(), procs: read("procs").split("\n").filter(Boolean) };
}
const mountCall = (calls: string[]) => calls.find(c => c.startsWith("rclone mount ")) ?? null;

describe("seedbox mount: the script and its installer", () => {
  test("no VFS cache; the chunk streams stay; nothing of the old cache's settings is left", () => {
    const mount = filled.slice(filled.indexOf("rclone mount "), filled.indexOf("--log-level"));
    expect(mount).toContain("--vfs-cache-mode off");
    for (const kept of ["--vfs-read-chunk-size 32M", "--vfs-read-chunk-streams 8", "--buffer-size 32M"]) expect(mount).toContain(kept);
    for (const gone of ["--cache-dir", "--vfs-cache-max-size", "--vfs-cache-max-age", "--vfs-read-ahead", "--vfs-cache-mode full"]) expect(mount).not.toContain(gone);
  });

  test("a check a minute; a remount always stops the old rclone first and unmounts before it mounts", () => {
    expect(filled).toMatch(/--watch\) while true; do \/bin\/bash "\$0"; sleep 60; done/);
    const remount = filled.slice(filled.indexOf("remount() {"));
    expect(remount.indexOf("stop_mount")).toBeLessThan(remount.indexOf("start_mount"));
    const stop = filled.slice(filled.indexOf("stop_mount() {"), filled.indexOf("start_mount() {"));
    expect(stop.indexOf("kill -TERM")).toBeLessThan(stop.indexOf("kill -KILL"));
    expect(stop.indexOf("kill -KILL")).toBeLessThan(stop.indexOf("fusermount -uz"));
    expect(stop).toContain("return 1");                          // rclone still running: no second one
  });

  test("the installer fills in every value of the script and remounts a mount still on the old cache once", () => {
    for (const k of TEMPLATE.match(/@@[A-Z_]+@@/g) ?? []) expect(INSTALLER).toContain(`"${k}":`);
    expect(INSTALLER).toContain("seedbox-mount.sh --remount");
    expect(INSTALLER).not.toMatch(/timeout 30 ls/);
  });

  test("(F23) the installer's own fill runs — its module-level code, the check of every marker included — and leaves none", () => {
    // the template's own words never look like a marker: only the four values are filled in
    expect(TEMPLATE.match(/@@/g)?.length).toBe(8);
    expect(filled).not.toContain("@@");
    // a Python that runs (Windows may answer "python3" with the Store's stand-in, which only prints that Python is missing)
    const py = [Bun.which("python"), Bun.which("python3")].find(p => !!p && Bun.spawnSync([p, "-I", "-c", "print(7)"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim() === "7");
    if (!py) return;                                               // no Python here: the text checks above stand
    const code = "import os, runpy, sys, types; sys.modules['paramiko'] = types.ModuleType('paramiko'); os.environ['UNRAID_PASS'] = 'x'; "
      + "g = runpy.run_path(sys.argv[1], run_name='installer'); print('@@' in g['MOUNT_SH'], g['MOUNT_SH'].count('seedbox:downloads'))";
    const r = Bun.spawnSync([py, "-I", "-c", code, join(root, "deploy", "seedbox-mount.py")], { stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe("False 1");
  });

  test("(F24) the installer finds the mount by its arguments: as the Unraid plugin's wrapper runs it, never its own command line", () => {
    const MPX = "/mnt/addons/seedbox/downloads";
    const wrapped = `/usr/sbin/rcloneorig --config /boot/config/plugins/rclone/.rclone.conf mount seedbox:downloads ${MPX} --config /boot/config/plugins/rclone/.rclone.conf --allow-other --daemon --vfs-cache-mode full`;
    const plain = `/usr/sbin/rclone mount seedbox:downloads ${MPX} --allow-other`;
    const pats = [...INSTALLER.matchAll(/pgrep -af '([^']+)'/g)].map(m => m[1].replace("{REMOTE_NAME}", "seedbox").replace("{REMOTE_PATH}", "downloads").replace("{MP}", MPX));
    expect(pats.length).toBeGreaterThanOrEqual(2);
    for (const p of pats) {
      const re = new RegExp(p);
      expect(re.test(wrapped)).toBe(true);
      expect(re.test(plain)).toBe(true);
      expect(re.test(`bash -c pgrep -af '${p}' | grep -c -- '--vfs-cache-mode full'`)).toBe(false);   // its own command line
    }
  });
});

/** a bash run forks for every look (slow under Git Bash): each of these may take a few seconds */
const SLOW = 30_000;
describe.skipIf(!bash)("seedbox mount: the watchdog's decisions (bash, stubbed commands)", () => {
  test("decide: dead is remounted at once, slow is waited out, stuck only with the seedbox answering", () => {
    const d = (args: string) => run(`decide ${args}`).out;
    expect(d("0 1 0 0 0 0 100 -")).toMatch(/^mount /);                         // nothing mounted
    expect(d("1 0 0 0 0 0 100 -")).toMatch(/^remount dead: .* no rclone serves it/);
    expect(d("1 1 1 0 0 0 100 -")).toMatch(/^remount dead: .*Transport endpoint/);
    expect(d("1 1 0 1 0 0 100 -")).toMatch(/^ok /);
    expect(d("1 1 0 0 1 100 100 -")).toMatch(/^wait slow/);                    // one slow look
    expect(d("1 1 0 0 7 100 500 -")).toMatch(/^wait slow/);                    // many, but within 10 min
    expect(d("1 1 0 0 4 100 900 -")).toMatch(/^wait slow/);                    // long, but only 4 looks
    expect(d("1 1 0 0 5 100 700 -")).toMatch(/^check-box /);
    expect(d("1 1 0 0 5 100 700 1")).toMatch(/^remount stuck/);
    expect(d("1 1 0 0 5 100 700 0")).toMatch(/^wait box-silent/);
  }, SLOW);

  test("one slow listing while rclone runs: logged and counted, nothing done to the mount", () => {
    const r = run("check", { LS_RC: 2 });
    expect(r.calls).toEqual([]);
    expect(r.state).toBe("1 100000");
    expect(r.log).toMatch(/watchdog: wait slow: it did not answer within 30s while rclone runs \(1 failed look/);
  }, SLOW);

  test("five failed looks over ten minutes with the seedbox answering: stopped, unmounted, the old cache gone, mounted again", () => {
    mkdirSync(OLD_CACHE, { recursive: true });
    const r = run(`for t in 0 150 300 450; do NOW=$((100000 + t)); check; done; echo "after4=$(cat "$SEEDBOX_MOUNT_STATE")"; NOW=100600; check`, { LS_RC: 2 });
    expect(r.out).toBe("after4=4 100000");                       // four looks over 7.5 min: waited
    const i = (re: RegExp) => r.calls.findIndex(c => re.test(c));
    expect(i(/^rclone lsf seedbox:downloads/)).toBe(0);           // the seedbox asked first
    expect(i(/^kill -TERM 4242$/)).toBeGreaterThan(0);
    expect(i(/^fusermount -uz \/mnt\/addons\/seedbox\/downloads$/)).toBeGreaterThan(i(/^kill -TERM/));
    expect(i(/^rm -rf -- .*rclone-cache$/)).toBeGreaterThan(i(/^fusermount/));
    expect(i(/^rclone mount /)).toBeGreaterThan(i(/^rm -rf/));
    expect(r.calls.filter(c => c.startsWith("rclone mount ")).length).toBe(1);
    expect(mountCall(r.calls)).toContain("--vfs-cache-mode off");
    expect(r.calls.some(c => c.startsWith("kill -KILL"))).toBe(false);
    expect(r.log).toMatch(/remount stuck: the seedbox answers but the mount has not for 600s \(5 failed looks\) — remounting/);
    expect(r.state).toBe("0 0");
  }, SLOW);

  test("…and with the seedbox silent too: waited for, the mount left as it is", () => {
    const r = run(`for t in 0 150 300 450 600 750; do NOW=$((100000 + t)); check; done`, { LS_RC: 2, BOX_RC: 1 });
    expect(r.calls.filter(c => !c.startsWith("rclone lsf"))).toEqual([]);
    expect(r.log).toMatch(/wait box-silent: the seedbox does not answer either/);
  }, SLOW);

  test("not mounted: mounted at once, an rclone left over stopped first", () => {
    const r = run("check", { MOUNTED: 0, ALIVE: 1 });
    expect(r.calls[0]).toBe("kill -TERM 4242");
    expect(mountCall(r.calls)).not.toBeNull();
    expect(r.log).toMatch(/mount dead: \/mnt\/addons\/seedbox\/downloads is not mounted — remounting/);
  }, SLOW);

  test("a FUSE endpoint that is gone, or a mount no rclone serves: remounted at the first check", () => {
    const gone = run("check", { GONE: 1 });
    expect(mountCall(gone.calls)).not.toBeNull();
    expect(gone.log).toMatch(/endpoint is gone/);
    const orphan = run("check", { ALIVE: 0 });
    expect(orphan.calls[0]).toBe("fusermount -uz /mnt/addons/seedbox/downloads");   // nothing to stop: unmounted, mounted
    expect(mountCall(orphan.calls)).not.toBeNull();
  }, SLOW);

  test("an rclone that ignores TERM is killed; one that survives KILL gets no second rclone beside it", () => {
    const stubborn = run("remount", { DIES: 0 });
    expect(stubborn.calls.slice(0, 2)).toEqual(["kill -TERM 4242", "kill -KILL 4242"]);
    expect(mountCall(stubborn.calls)).not.toBeNull();
    const stuck = run("remount", { DIES: 0, STUCK: 1 });
    expect(mountCall(stuck.calls)).toBeNull();
    expect(stuck.calls.some(c => c.startsWith("fusermount"))).toBe(false);
    expect(stuck.log).toMatch(/rclone still runs after KILL/);
  }, SLOW);

  test("(F24) a healthy mount the Unraid plugin's wrapper runs (rcloneorig --config … mount …) is left alone, check after check", () => {
    const r = run("check; NOW=100060; check; NOW=100120; check; rclone_pids", { WRAP: 1 });
    expect(r.calls.filter(c => !c.startsWith("mountpoint"))).toEqual([]);
    expect(r.out).toBe("4242");                                    // the wrapper-run rclone is the one serving the mount
    expect(r.log).toBe("");
    expect(r.procs).toHaveLength(1);
  }, SLOW);

  test("(F24) …and stopping it reaches that rclone: TERM to it, the mount gone, one new rclone", () => {
    const r = run("remount", { WRAP: 1 });
    expect(r.calls[0]).toBe("kill -TERM 4242");
    expect(r.procs.filter(p => / mount seedbox:downloads /.test(p))).toHaveLength(1);
    expect(r.procs[0]).not.toMatch(/^4242 /);
  }, SLOW);

  test("(F28) whether it is mounted comes from the mount table, never from a stat of the mount (a stuck FUSE root would hang it)", () => {
    const up = run("check", { LS_RC: 0 });
    expect(up.calls.some(c => c.startsWith("mountpoint"))).toBe(false);
    expect(up.log).toBe("");
    const down = run("check", { MOUNTED: 0, ALIVE: 0 });
    expect(down.calls.some(c => c.startsWith("mountpoint"))).toBe(false);
    expect(down.log).toMatch(/mount dead: \/mnt\/addons\/seedbox\/downloads is not mounted/);
    expect(mountCall(down.calls)).not.toBeNull();
  }, SLOW);

  test("a mount that answers again after slow looks: the count starts over, and that is said once", () => {
    const r = run(`check; NOW=100060; check; LS_RC=0; NOW=100120; check; check`, { LS_RC: 2 });
    expect(r.calls).toEqual([]);
    expect(r.state).toBe("0 0");
    expect(r.log.match(/ok: it answers again \(after 2 failed look/g)?.length).toBe(1);
  }, SLOW);
});
