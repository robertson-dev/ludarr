#!/usr/bin/env python3
"""
ludarr — build and (re)create the container on Unraid in one go.

    UNRAID_HOST=<server> UNRAID_USER=root UNRAID_PASS=... python deploy/unraid.py

Steps: pack the build context (src, web, Dockerfile; no secrets, no node_modules) → upload over SFTP →
`docker build` on the box → install the Unraid template (my-ludarr.xml) → recreate the `ludarr`
container (with the finished-downloads folder LUDARR_ARRIVALS_HOST, /mnt/user/downloads/finished, as /arrivals when it exists:
the default of Settings → Media Management → "Finished downloads land in") →
wait for /api/health.

First install: creates /mnt/user/appdata/ludarr/ludarr.env from Ahoy's ahoy.env when one exists (same
Prowlarr / seedbox / AI secrets, so nothing has to be typed again) and copies ahoy.db to ludarr.db, so
the games, catalog and connector token come over. Secrets never leave the box.

This server's own values (UNRAID_HOST and, for folders that differ from the defaults, LUDARR_GAMES_HOST, LUDARR_ARRIVALS_HOST and the other *_HOST names below) go in
deploy/.env.site: KEY=VALUE lines, ignored by git. The environment wins over the file; the password is never read from it.

The template in the repo names default folders; the copy installed on the server names the folders this deploy mounts.
A deploy refuses to give a running container another library or finished-downloads folder than it has
(LUDARR_ALLOW_MOVE=1 when the move is meant).

Needs python3 + paramiko on this machine.
"""
import io, os, re, subprocess, sys, tarfile, time
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
PASS = os.environ.get("UNRAID_PASS")                                             # none: this machine's SSH keys (and its agent) are tried
PORT = int(os.environ.get("LUDARR_PORT", "7979"))
# the container, its image, its template, its appdata folder, its env file and its staging folder all carry this name; a
# server set up before the engine was renamed says its old name in deploy/.env.site and is deployed to as it is
NAME = os.environ.get("LUDARR_CONTAINER", "ludarr")
APPDATA = os.environ.get("LUDARR_APPDATA", f"/mnt/user/appdata/{NAME}")
BUILD = f"{APPDATA}-build"
RUN_EXTRA = os.environ.get("LUDARR_RUN_EXTRA", "")                              # more `docker run` arguments, for this server alone
SSD_POOL = os.environ.get("LUDARR_SSD_POOL", "/mnt/cache")
DOWNLOADS = os.environ.get("LUDARR_DOWNLOADS_HOST", "/mnt/user/downloads/ahoy")
GAMES = os.environ.get("LUDARR_GAMES_HOST", "/mnt/user/games/ludarr")                 # the library; a server whose library is elsewhere says so in deploy/.env.site
REMOTE = os.environ.get("LUDARR_REMOTE_HOST", "/mnt/addons/seedbox")
# the finished-downloads folder: the one the admin's own sync fills with the seedbox's finished downloads (their Sonarr/Radarr's),
# /arrivals in the container — the default of "Finished downloads land in" — read-write (ludarr refreshes the dates of the
# files it imports so the folder's hourly cleanup leaves them).
# Checked, never created: the admin's sync owns it
ARRIVALS = os.environ.get("LUDARR_ARRIVALS_HOST", "/mnt/user/downloads/finished")
WORK = os.environ.get("LUDARR_WORK_DIR", "/library/.work")
NET = os.environ.get("LUDARR_NET", "bridge")                                 # "host" when docker still books the port for a container it cannot kill (until the next reboot)                  # scratch for imports, inside the library so a finished game is a rename away     # the download client's folder, mounted by deploy/seedbox-mount.py → /remote
AHOY_APPDATA = "/mnt/user/appdata/ahoy"
TEMPLATE = f"/boot/config/plugins/dockerMan/templates-user/my-{NAME}.xml"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXCLUDE = ("node_modules", ".git", "public", "dist", "config", "deploy", "unraid", "tests")
sys.stdout.reconfigure(encoding="utf-8")

# keys from ahoy.env that ludarr understands (seeded into plugin instances on first boot); the rest are Ahoy-only
CARRY = ("PROWLARR_URL", "PROWLARR_API_KEY", "PROWLARR_INDEXERS", "PROWLARR_CATEGORIES", "RTORRENT_URL", "RTORRENT_USER", "RTORRENT_PASS", "RTORRENT_LABEL", "RTORRENT_DIR",
         "NZBGET_URL", "NZBGET_USER", "NZBGET_PASS", "NZBGET_CATEGORY", "SEEDBOX_SSH_HOST", "SEEDBOX_SSH_PORT", "SEEDBOX_SSH_USER", "SEEDBOX_SSH_PASS", "SEEDBOX_SSH_KEY",
         "SEEDBOX_WEB_USER", "SEEDBOX_WEB_PASS", "BOSUN_PORT", "PULL_SEGMENTS", "PULL_PARALLEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AGENT_MODEL", "IGDB_CLIENT_ID", "IGDB_CLIENT_SECRET", "GITHUB_TOKEN")

TEMPLATE_GAMES, TEMPLATE_ARRIVALS = "/mnt/user/games/ludarr", "/mnt/user/downloads/finished"   # the folders unraid/my-ludarr.xml names


def site_template(xml: bytes) -> bytes:
    """The template as it is installed on the server: the repo's copy names default folders, this one the folders the
    deploy mounts (the mounted folder and the value of its setting; the "Default" hints stay as they are)."""
    stage = SSD_POOL.rstrip("/") + f"/{NAME}-staging"
    for default, own in (("/mnt/user/appdata/ludarr/ludarr.env", f"{APPDATA}/{NAME}.env"), ("/mnt/user/appdata/ludarr", APPDATA), ("/mnt/cache/ludarr-staging", stage),
                         ("<Name>ludarr</Name>", f"<Name>{NAME}</Name>"), ("<Repository>ludarr:latest</Repository>", f"<Repository>{NAME}:latest</Repository>")):
        xml = xml.replace(default.encode(), own.encode())
    for default, own in ((TEMPLATE_GAMES, GAMES), (TEMPLATE_ARRIVALS, ARRIVALS)):
        for before, after in (("<HostDir>", "</HostDir>"), (">", "</Config>")):
            xml = xml.replace(f"{before}{default}{after}".encode(), f"{before}{own}{after}".encode())
    return xml

def revision() -> str:
    """the commit this deploy is built from (DEPLOY_REVISION, else the checkout's HEAD): stamped on the image, so the
    server can say which commit it runs"""
    rev = os.environ.get("DEPLOY_REVISION", "")
    if not rev:
        try: rev = subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception: rev = ""
    return rev if re.fullmatch(r"[0-9A-Za-z._-]{1,40}", rev) else ""


REVISION = revision()
LABEL = os.environ.get("DEPLOY_LABEL", "")                                       # a word for this deploy: the image is also tagged <label>-<commit>
if LABEL and not re.fullmatch(r"[0-9A-Za-z._-]{1,40}", LABEL): sys.exit("DEPLOY_LABEL: letters, digits, dot, dash and underscore only")


def pack() -> bytes:
    buf = io.BytesIO()
    def keep(ti: tarfile.TarInfo):
        rel = ti.name
        parts = rel.split("/")
        if any(p in EXCLUDE for p in parts[1:]) or (len(parts) == 1 and parts[0] in EXCLUDE): return None
        if rel.endswith((".db", ".db-wal", ".db-shm", ".log", ".env")): return None
        return ti
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for item in ("src", "web", "helpers", "package.json", "bun.lock", "Dockerfile", ".dockerignore", "tsconfig.json"):
            tar.add(os.path.join(ROOT, item), arcname=item, filter=keep)
    return buf.getvalue()


def main():
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, USER, PASS, timeout=25, look_for_keys=not PASS, allow_agent=not PASS)
    def sh(cmd: str, timeout=900) -> str:
        _, out, err = c.exec_command(cmd, timeout=timeout)
        o = out.read().decode(errors="replace") + err.read().decode(errors="replace")
        if out.channel.recv_exit_status() != 0: sys.exit(f"failed: {cmd}\n{o[-2000:]}")
        return o

    # a deploy keeps the folders the running container has: a default never slips another library or finished-downloads
    # folder under it (LUDARR_ALLOW_MOVE=1 when the move is meant)
    mounts = dict(l.split("=", 1) for l in sh("docker inspect -f '{{range .Mounts}}{{.Destination}}={{.Source}}{{println}}{{end}}' " + NAME + " 2>/dev/null || true").splitlines() if "=" in l)
    for inside, mine, name in (("/library", GAMES, "LUDARR_GAMES_HOST"), ("/arrivals", ARRIVALS, "LUDARR_ARRIVALS_HOST")):
        if mounts.get(inside) and mounts[inside] != mine and os.environ.get("LUDARR_ALLOW_MOVE") != "1":
            sys.exit(f"the running container has {mounts[inside]} as {inside}; this deploy would give it {mine}. Set {name} (environment or deploy/.env.site), or LUDARR_ALLOW_MOVE=1 if the move is meant.")
    data = pack(); print(f"build context: {len(data) / 1024:.0f} KB")
    sh(f"mkdir -p {BUILD} {APPDATA} {APPDATA}/plugins {APPDATA}/backups {DOWNLOADS} {GAMES} {REMOTE}")

    # first install: env + database from Ahoy
    if sh(f"test -f {APPDATA}/{NAME}.env && echo yes || echo no").strip() != "yes":
        if sh(f"test -f {AHOY_APPDATA}/ahoy.env && echo yes || echo no").strip() == "yes":
            keep = "|".join(CARRY)
            sh(f"grep -E '^({keep})=' {AHOY_APPDATA}/ahoy.env > {APPDATA}/{NAME}.env && chmod 600 {APPDATA}/{NAME}.env")
            print("ludarr.env created from ahoy.env")
        else:
            sh(f"touch {APPDATA}/{NAME}.env && chmod 600 {APPDATA}/{NAME}.env")
            print("empty ludarr.env created — configure everything in the web UI")
    if sh(f"test -f {APPDATA}/{NAME}.db && echo yes || echo no").strip() != "yes":
        if sh(f"test -f {AHOY_APPDATA}/ahoy.db && echo yes || echo no").strip() == "yes":
            # a consistent copy even while Ahoy is running (WAL): VACUUM INTO from inside the ahoy container
            sh(f"docker exec ahoy bun -e \"const {{Database}}=require('bun:sqlite'); new Database('/data/ahoy.db').exec(\\\"VACUUM INTO '/data/ludarr-seed.db'\\\")\" && mv {AHOY_APPDATA}/ludarr-seed.db {APPDATA}/{NAME}.db")
            print("ludarr.db seeded from ahoy.db")

    with c.open_sftp() as s:
        with s.file(f"{BUILD}/src.tar", "wb") as f: f.write(data)
        with s.file(TEMPLATE, "wb") as f: f.write(site_template(open(os.path.join(ROOT, "unraid", "my-ludarr.xml"), "rb").read()))
    sh(f"cd {BUILD} && rm -rf src web package.json bun.lock Dockerfile .dockerignore tsconfig.json && tar -xf src.tar && rm src.tar")
    print("building image …")
    # the image the container runs now stays as :prev, to go back to
    sh(f"img=$(docker inspect -f '{{{{.Image}}}}' {NAME} 2>/dev/null) && docker tag $img {NAME}:prev || true")
    stamp = f"--label org.opencontainers.image.revision={REVISION} " if REVISION else ""
    sh(f"cd {BUILD} && docker build {stamp}-t {NAME}:latest . > build.log 2>&1", timeout=2400)
    if REVISION and LABEL: sh(f"docker tag {NAME}:latest {NAME}:{LABEL}-{REVISION}")
    print("image built; recreating container …")
    sh(f"docker rm -f {NAME} >/dev/null 2>&1 || true")
    for _ in range(30):                                   # the daemon frees the name a moment after rm returns
        if sh(f"docker inspect {NAME} >/dev/null 2>&1 && echo busy || echo free").strip() == "free": break
        time.sleep(1)
    # --init: an init process reaps what importers leave behind (bun as PID 1 does not, and docker cannot kill a container whose PID 1 is a zombie)
    publish = "--network host" if NET == "host" else f"-p {PORT}:7979"
    import shlex
    ssd = ""
    if SSD_POOL and sh(f"mountpoint -q {shlex.quote(SSD_POOL)} && echo yes || echo no").strip() == "yes":
        stage = shlex.quote(SSD_POOL.rstrip("/") + f"/{NAME}-staging")
        sh(f"mkdir -p {stage}")
        ssd = f"-v {stage}:/ssd "
    arrivals = ""
    if sh(f"test -d '{ARRIVALS}' && echo yes || echo no").strip() == "yes": arrivals = f"-v '{ARRIVALS}':/arrivals:rw "
    else: print(f"note: {ARRIVALS} is not a folder on the host — the container gets no /arrivals, so downloads are transferred from the seedbox as before (set LUDARR_ARRIVALS_HOST to the folder your sync fills; it is never created here)")
    sh(f"docker run -d --init --name {NAME} --restart unless-stopped {publish} --env-file {APPDATA}/{NAME}.env "
       f"-e PORT=7979 -e LUDARR_GAMES=/library -e LUDARR_WORK={WORK} {RUN_EXTRA} "
       f"-v {APPDATA}:/config -v {DOWNLOADS}:/downloads -v {GAMES}:/library -v {REMOTE}:/remote:rw,rslave {arrivals}{ssd}{NAME}:latest")
    for _ in range(45):
        time.sleep(2)
        if sh(f"curl -s -m 5 http://127.0.0.1:{PORT}/api/health || true").strip().startswith("{"): break
    print(sh(f"docker logs {NAME} 2>&1 | head -12"))
    print("health:", sh(f"curl -s -m 10 http://127.0.0.1:{PORT}/api/health").strip())
    print(f"→ http://{HOST}:{PORT}/   (template installed: Unraid → Docker → {NAME})")


if __name__ == "__main__":
    main()
