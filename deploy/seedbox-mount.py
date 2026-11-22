"""
ludarr — the seedbox's downloads folder mounted on Unraid (rclone over SFTP, key-based), for what reads it through the
download clients' remote path mapping: the seeding cleanup (a download's files removed once its client is done with it),
the ways' earlier downloads, and the admin's own "import it from the seedbox instead". Imports read the finished-downloads
folder the admin's own sync fills (downloads/finished, /arrivals in the container: Settings -> Media Management -> "Finished
downloads land in", /arrivals by default), never this mount.

    UNRAID_HOST=<server> UNRAID_USER=root UNRAID_PASS=... python deploy/seedbox-mount.py

What it does on the Unraid host (idempotent, re-run any time):
  1. generates an SSH key for rclone (/boot/config/plugins/rclone/seedbox_ed25519) if there is none
  2. installs the public key on the seedbox — the ONE time the seedbox password is used, read inside the
     ludarr container from the Seedbox connector's settings; it is never printed or copied anywhere
  3. points the rclone remote "seedbox" at the key (its stored password is removed), pins the host key
  4. installs the mount script (/boot/config/plugins/ludarr/seedbox-mount.sh, from deploy/seedbox-mount.sh) and its
     watchdog (started from /boot/config/go at boot; a check every minute that remounts only a dead mount — never on one
     slow listing — and logs every verdict with its reason to /var/log/rclone-seedbox.log), mounts seedbox:downloads at
     /mnt/addons/seedbox/downloads without a VFS cache, and — once — remounts a mount still running with the old cache
     settings (SEEDBOX_KEEP_MOUNT=1 leaves it; the old cache folder goes once its rclone has stopped)
Then run deploy/unraid.py (the container gets /mnt/addons/seedbox as /remote and downloads/finished as /arrivals, which ludarr
reads by default) and set, under Settings -> Download Clients, the Remote path mapping (e.g.
/home/user/downloads=/remote/downloads).
"""
import os
import sys
import time

import paramiko

def site_values():
    """deploy/.env.site: this server's own values as KEY=VALUE lines, ignored by git. The environment wins over the
    file, and the password is never read from it."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.site")
    if not os.path.isfile(path): return
    for line in open(path, encoding="utf-8"):
        key, sep, value = line.strip().partition("=")
        key = key.strip()
        if sep and key and not key.startswith("#") and key != "UNRAID_PASS": os.environ.setdefault(key, value.strip())


site_values()
HOST = os.environ.get("UNRAID_HOST") or sys.exit("set UNRAID_HOST to the server's address (in the environment or in deploy/.env.site)")
USER = os.environ.get("UNRAID_USER", "root")
PASS = os.environ.get("UNRAID_PASS") or sys.exit("set UNRAID_PASS")
NAME = os.environ.get("LUDARR_CONTAINER", "ludarr")                              # a server set up before the rename says its old name in deploy/.env.site
APPDATA = os.environ.get("LUDARR_APPDATA", f"/mnt/user/appdata/{NAME}")
REMOTE_NAME = os.environ.get("SEEDBOX_RCLONE_REMOTE", "seedbox")
REMOTE_PATH = os.environ.get("SEEDBOX_RCLONE_PATH", "downloads")          # relative to the seedbox home
BASE = os.environ.get("LUDARR_REMOTE_HOST", "/mnt/addons/seedbox")        # /mnt/addons is a shared mount on Unraid 7: mounts below it propagate into containers
MP = f"{BASE}/{os.path.basename(REMOTE_PATH)}"
PLUG = f"/boot/config/plugins/{NAME}"
RCLONE_DIR = "/boot/config/plugins/rclone"
CONF = f"{RCLONE_DIR}/.rclone.conf"
KEY = f"{RCLONE_DIR}/seedbox_ed25519"
KNOWN = f"{RCLONE_DIR}/seedbox_known_hosts"
OLD_CACHE = f"{APPDATA}/rclone-cache"                                     # the VFS cache of the old mount settings: removed once its rclone stopped

# the mount script and its calm watchdog (deploy/seedbox-mount.sh, tested by tests/seedbox-mount.test.ts), filled in (a
# Windows checkout may carry CRLF: the script on the host never does)
MARKERS = {"@@REMOTE@@": f"{REMOTE_NAME}:{REMOTE_PATH}", "@@MP@@": MP, "@@CONF@@": CONF, "@@OLD_CACHE@@": OLD_CACHE}
MOUNT_SH = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "seedbox-mount.sh"), encoding="utf-8").read().replace("\r\n", "\n")
for _k, _v in MARKERS.items():
    assert _k in MOUNT_SH, f"the mount script has no {_k} to fill in"
    MOUNT_SH = MOUNT_SH.replace(_k, _v)
    assert _k not in MOUNT_SH, f"{_k} of the mount script was not filled in"

GO_LINE = f"nohup /bin/bash {PLUG}/seedbox-mount.sh --watch >/dev/null 2>&1 &"

# runs inside the ludarr container: the connector's stored login is used once, to install the public key, and never leaves the box
INSTALL_KEY_TS = r"""
import { Database } from "bun:sqlite";
import { SshLink } from "/app/src/ssh";
const db = new Database(require("node:fs").existsSync("/config/ludarr.db") ? "/config/ludarr.db" : "/config/" + process.env.OLD_DB, { readonly: true });
const row = db.query("SELECT settings_json FROM plugin_instances WHERE kind='downloadClient' AND impl='seedbox' ORDER BY id LIMIT 1").get() as { settings_json: string } | null;
if (!row) { console.error("no Seedbox connector instance to take the login from"); process.exit(2); }
const s = JSON.parse(row.settings_json);
const pub = (process.env.PUBKEY ?? "").trim();
if (!pub || pub.includes("'")) { console.error("PUBKEY missing"); process.exit(2); }
if (!s.sshPass && !s.sshKey) { console.error("the Seedbox connector has no password or key"); process.exit(2); }
const link = new SshLink(() => ({ host: s.sshHost, port: Number(s.sshPort || 22), username: s.sshUser, password: s.sshPass || undefined, privateKey: s.sshKey || undefined }));
const r = await link.exec(`mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF '${pub}' ~/.ssh/authorized_keys || echo '${pub}' >> ~/.ssh/authorized_keys) && echo installed`);
console.log((r.stdout || r.stderr).trim());
process.exit(r.code === 0 ? 0 : 1);
"""


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, USER, PASS, timeout=25, look_for_keys=False, allow_agent=False)

    def sh(cmd, timeout=120, ok=True):
        _, out, err = c.exec_command(cmd, timeout=timeout)
        o = out.read().decode(errors="replace") + err.read().decode(errors="replace")
        code = out.channel.recv_exit_status()
        if ok and code != 0: sys.exit(f"failed ({code}): {cmd}\n{o[-2000:]}")
        return o.strip()

    if sh("which rclone || true") == "": sys.exit("rclone is not installed on the Unraid host (Community Applications -> rclone)")
    if sh("docker inspect -f '{{.State.Running}}' " + NAME + " 2>/dev/null || echo no") != "true": sys.exit(f"the {NAME} container is not running (deploy/unraid.py first)")
    if sh(f"rclone config show {REMOTE_NAME} --config {CONF} 2>/dev/null | head -1 || true") == "":
        sys.exit(f"no rclone remote named {REMOTE_NAME} on the host: rclone config create {REMOTE_NAME} sftp host <box> user <user> (no password needed)")
    print(f"rclone {sh('rclone version | head -1')} | remote {REMOTE_NAME}: " + sh(f"rclone config show {REMOTE_NAME} --config {CONF} | grep -E '^(host|user|port)' | tr '\\n' ' '"))

    # 1. the key
    sh(f"mkdir -p {PLUG} {RCLONE_DIR}")
    if sh(f"test -f {KEY} && echo yes || echo no") != "yes":
        sh(f"ssh-keygen -q -t ed25519 -N '' -C ludarr-rclone -f {KEY}")
        print(f"key generated: {KEY}")
    pub = sh(f"cat {KEY}.pub")
    host = sh(f"rclone config show {REMOTE_NAME} --config {CONF} | sed -n 's/^host = //p'")
    port = sh(f"rclone config show {REMOTE_NAME} --config {CONF} | sed -n 's/^port = //p'") or "22"
    sh(f"ssh-keyscan -4 -T 20 -p {port} {host} 2>/dev/null | grep -v '^#' > {KNOWN} && test -s {KNOWN}")   # every key type (the server picks which one it presents); -4: keyscan gives up after a refused IPv6 address

    # 2. the public key onto the seedbox, with the login the connector holds (used inside the container, never shown)
    conn = f":sftp,host={host},port={port},user=$(rclone config show {REMOTE_NAME} --config {CONF} | sed -n 's/^user = //p'),key_file={KEY},known_hosts_file={KNOWN}:"
    if sh(f"timeout 60 rclone lsd \"{conn}{REMOTE_PATH}\" --max-depth 1 >/dev/null 2>&1 && echo yes || echo no") == "yes":
        print("the key already opens the seedbox")
    else:
        with c.open_sftp() as s:
            with s.file(f"{APPDATA}/.install-key.ts", "wb") as f: f.write(INSTALL_KEY_TS.encode())
        try:
            r = sh(f"docker exec -e PUBKEY='{pub}' -e OLD_DB={NAME}.db {NAME} bun /config/.install-key.ts", ok=False)
            print("seedbox:", r)
            if "installed" not in r: sys.exit("could not install the key on the seedbox — is the Seedbox connector's SSH password right (Settings -> Download Clients)?")
        finally:
            sh(f"rm -f {APPDATA}/.install-key.ts")
        if sh(f"timeout 60 rclone lsd \"{conn}{REMOTE_PATH}\" --max-depth 1 >/dev/null 2>&1 && echo yes || echo no") != "yes":
            sys.exit("the key was installed but rclone still cannot log in with it")
        print("the key opens the seedbox")

    # 3. the remote uses the key; its stored password goes
    sh(f"rclone config update {REMOTE_NAME} key_file {KEY} known_hosts_file {KNOWN} --config {CONF} --non-interactive >/dev/null")
    sh(f"sed -i '/^\\[{REMOTE_NAME}\\]/,/^\\[/{{/^pass = /d;/^key_pem = /d;/^key_file_pass = /d}}' {CONF}")
    listing = sh(f"timeout 60 rclone lsd {REMOTE_NAME}:{REMOTE_PATH} --config {CONF} --max-depth 1 2>&1 | head -5")
    if "ERROR" in listing or "CRITICAL" in listing: sys.exit(f"the remote does not work with the key:\n{listing}")
    print(f"remote {REMOTE_NAME} now logs in with the key (no password stored); {REMOTE_PATH}/ lists fine")

    # 4. the mount: script, boot line, the watchdog (which mounts right away)
    with c.open_sftp() as s:
        with s.file(f"{PLUG}/seedbox-mount.sh", "wb") as f: f.write(MOUNT_SH.encode())
    sh(f"chmod 755 {PLUG}/seedbox-mount.sh; rm -f {PLUG}/seedbox-mount.cron")
    sh("sed -i '/seedbox-mount.sh/d; /^# [a-z]*: the seedbox downloads mount/d' /boot/config/go")        # an older line goes
    sh("printf '\n# ludarr: the seedbox downloads mount watchdog (deploy/seedbox-mount.py)\n%s\n' " + repr(GO_LINE) + " >> /boot/config/go")
    sh("pkill -f '[s]eedbox-mount.sh --watch' || true", ok=False)                                           # [s]: the pattern must not match this very command line
    sh(f"setsid nohup /bin/bash {PLUG}/seedbox-mount.sh --watch >/dev/null 2>&1 </dev/null &", ok=False)   # detached: the daemonised rclone must not hold our pipes
    time.sleep(3)
    if sh("pgrep -f '[s]eedbox-mount.sh --watch' | head -1") == "": sys.exit("the mount watchdog did not start")
    print("watchdog running (pid " + sh("pgrep -f '[s]eedbox-mount.sh --watch' | head -1") + "); boot line in /boot/config/go")
    for _ in range(20):
        if sh(f"mountpoint -q {MP} && echo yes || echo no") == "yes": break
        time.sleep(1)
    # a mount still running with the old settings (a 30G VFS cache on appdata, shared by every rclone the old watchdog left
    # behind): remounted once with the new ones — nothing imports from it any more, but check Activity first
    # found by its arguments: the Unraid plugin's rclone is a wrapper that runs `rcloneorig --config … mount …`; [m]: never this very command line
    old = sh(f"pgrep -af ' [m]ount {REMOTE_NAME}:{REMOTE_PATH} {MP}( |$)' | grep -c -- '--vfs-cache-mode full' || true", ok=False)
    if old.strip() not in ("", "0"):
        if os.environ.get("SEEDBOX_KEEP_MOUNT") == "1": print("the mount still runs with the old cache settings (SEEDBOX_KEEP_MOUNT=1: left as it is until its next remount)")
        else:
            print("the mount runs with the old cache settings: remounting it without a cache (the old rclone is stopped first) …")
            # detached, like the watchdog: the remounted rclone daemon keeps the shell's pipes open, so waiting on this ssh
            # channel hung until its timeout (2026-11-09: the remount itself had worked)
            sh(f"setsid nohup /bin/bash {PLUG}/seedbox-mount.sh --remount >/dev/null 2>&1 </dev/null &", ok=False)
            for _ in range(180):                                    # the old rclone gets TERM, 30 s, then KILL; then the new mount
                time.sleep(1)
                left = sh(f"pgrep -af ' [m]ount {REMOTE_NAME}:{REMOTE_PATH} {MP}( |$)' | grep -c -- '--vfs-cache-mode full' || true", ok=False).strip()
                if left in ("", "0") and sh(f"mountpoint -q {MP} && echo yes || echo no") == "yes":
                    break
    for _ in range(30):
        if sh(f"mountpoint -q {MP} && echo yes || echo no") == "yes": break
        time.sleep(1)
    print(f"mounted: {sh(f'mountpoint {MP}')}")
    print("rclone: " + (sh(f"pgrep -af ' [m]ount {REMOTE_NAME}:{REMOTE_PATH} {MP}( |$)' | head -3", ok=False) or "(none)"))
    print("top of the mount:\n  " + sh(f"timeout 60 ls -1 {MP} | head -8").replace("\n", "\n  "))
    print(f"\nnext: python deploy/unraid.py (gives the container {BASE} as /remote and downloads/finished as /arrivals, where finished downloads are imported from), then Settings -> Download Clients -> Remote path mapping = <seedbox downloads path>={'/remote/' + os.path.basename(REMOTE_PATH)}")
    c.close()


if __name__ == "__main__":
    main()
