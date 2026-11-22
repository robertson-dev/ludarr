#!/bin/bash
# ludarr — the seedbox's downloads folder, mounted on this host (rclone over SFTP, key-based), for what still reads it: the
# seeding cleanup, the ways' earlier downloads, and the admin's own "import it from the seedbox instead". Imports read the
# finished-downloads folder your own sync fills (/arrivals in the container), never this mount. Installed by deploy/seedbox-mount.py,
# which fills in the four values below (REMOTE, MP, CONF, OLD_CACHE).
#
#   seedbox-mount.sh            one check
#   seedbox-mount.sh --watch    a check every minute, for as long as the host is up (started from /boot/config/go)
#   seedbox-mount.sh --remount  the remount, now (the old rclone stopped first)
#
# The check is calm. It remounts only a mount that is dead: nothing mounted, no rclone serving it, or a FUSE endpoint that
# is gone ("Transport endpoint is not connected"). A look that is slow while rclone runs (a busy link: a transfer, the hourly
# sync) is logged and counted, never acted on by itself: only after 5 failed looks over at least 10 minutes, and only when
# the seedbox itself answers (rclone lsf straight over SFTP) is the mount stuck and remounted; a seedbox that does not answer
# either is waited for. A remount stops the old rclone first (TERM, 30 s, KILL, until it is gone) and unmounts: never two
# rclones on one mount. No VFS cache: reads go to the seedbox in 8 parallel chunk streams (a cache smaller than a download
# cannot evict a file held open, and a cache two rclones shared once left an unreadable sparse file behind).
#
# The mount's rclone is found by its arguments (" mount <remote> <mount point>"), never by its program's name: the Unraid
# rclone plugin's /usr/sbin/rclone is a wrapper that runs `rcloneorig --config <its conf> "$@"`. Whether something is mounted
# comes from the mount table, never from a stat of the mount point (a stuck FUSE root would hang the check itself).
REMOTE="@@REMOTE@@"
MP="@@MP@@"
CONF="@@CONF@@"
OLD_CACHE="@@OLD_CACHE@@"
LOG="${SEEDBOX_MOUNT_LOG:-/var/log/rclone-seedbox.log}"
MOUNTINFO="${SEEDBOX_MOUNTINFO:-/proc/self/mountinfo}"
STATE="${SEEDBOX_MOUNT_STATE:-/var/run/ludarr-seedbox-mount.state}"
ERR="$STATE.err"
SLOW_FAILS=5          # failed looks …
SLOW_SPAN=600         # … over at least this many seconds, before a mount rclone still serves can be called stuck
PROBE_SEC=30          # a look at the mount that takes longer failed
TERM_WAIT=30          # seconds rclone gets to stop on TERM before it is killed …
KILL_WAIT=30          # … and to be gone after KILL

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') watchdog: $*" >> "$LOG"; }

# The verdict on what a check saw, as "<action> <why>" — the action is one of ok, mount, remount, wait, check-box:
#   decide <mounted 0|1> <rclone serves it 0|1> <endpoint gone 0|1> <it answered 0|1> <failed looks> <first failure, epoch s>
#          <now, epoch s> <the seedbox answers: 1|0|- (not asked yet)>
decide() {
  local mounted=$1 alive=$2 dead=$3 listed=$4 fails=$5 first=$6 now=$7 box=$8
  if [ "$mounted" != 1 ]; then echo "mount dead: $MP is not mounted"; return; fi
  if [ "$alive" != 1 ]; then echo "remount dead: $MP is mounted but no rclone serves it"; return; fi
  if [ "$dead" = 1 ]; then echo "remount dead: the mount's endpoint is gone (Transport endpoint is not connected)"; return; fi
  if [ "$listed" = 1 ]; then echo "ok it answers"; return; fi
  local span=$(( now - first ))
  if [ "$fails" -lt "$SLOW_FAILS" ] || [ "$span" -lt "$SLOW_SPAN" ]; then
    echo "wait slow: it did not answer within ${PROBE_SEC}s while rclone runs ($fails failed look(s) over ${span}s) — a busy link, not a dead mount"
    return
  fi
  case "$box" in
    -) echo "check-box $fails failed looks over ${span}s: asking the seedbox itself";;
    1) echo "remount stuck: the seedbox answers but the mount has not for ${span}s ($fails failed looks)";;
    *) echo "wait box-silent: the seedbox does not answer either ($fails failed looks over ${span}s) — the mount is left as it is";;
  esac
}

# the rclone serving the mount, by its arguments (the plugin's wrapper runs it as rcloneorig --config … mount …)
rclone_pids() { pgrep -f " mount ${REMOTE} ${MP}( |\$)" 2>/dev/null; }

# is this path a mount point: read from the mount table (field 5), which never touches the mount itself
mounted_at() { awk -v mp="$1" '$5 == mp { found = 1 } END { exit !found }' "$MOUNTINFO" 2>/dev/null; }

# one look at the mount that never holds the check up: it runs on its own, and one still running after PROBE_SEC failed (a
# look can hang in the kernel until rclone answers; it is left to end by itself). What it printed on error goes to $ERR.
look() {
  ( "$@" >/dev/null 2>"$ERR" ) &
  local pid=$! i
  for i in $(seq 1 "$PROBE_SEC"); do
    kill -0 "$pid" 2>/dev/null || { wait "$pid"; return $?; }
    sleep 1
  done
  return 124
}

# the old rclone stopped (TERM, up to TERM_WAIT s, then KILL, until it is gone), the mount point unmounted, the old cache gone
stop_mount() {
  local pids i
  pids=$(rclone_pids)
  if [ -n "$pids" ]; then
    kill -TERM $pids 2>/dev/null
    for i in $(seq 1 "$TERM_WAIT"); do [ -z "$(rclone_pids)" ] && break; sleep 1; done
    pids=$(rclone_pids)
    if [ -n "$pids" ]; then say "rclone did not stop within ${TERM_WAIT}s: killing it ($pids)"; kill -KILL $pids 2>/dev/null; fi
    for i in $(seq 1 "$KILL_WAIT"); do [ -z "$(rclone_pids)" ] && break; sleep 1; done
    if [ -n "$(rclone_pids)" ]; then say "rclone still runs after KILL ($(rclone_pids)): no second one is mounted beside it"; return 1; fi
  fi
  fusermount -uz "$MP" 2>/dev/null
  if [ -n "$OLD_CACHE" ] && [ -d "$OLD_CACHE" ]; then rm -rf -- "$OLD_CACHE" && say "removed the old VFS cache $OLD_CACHE"; fi
  return 0
}

start_mount() {
  mkdir -p "$MP"
  rclone mount "$REMOTE" "$MP" --config "$CONF" --allow-other --daemon --umask 022 \
    --vfs-cache-mode off \
    --vfs-read-chunk-size 32M --vfs-read-chunk-size-limit 1G --vfs-read-chunk-streams 8 --buffer-size 32M \
    --dir-cache-time 30s --poll-interval 0 --attr-timeout 10s --sftp-concurrency 32 --sftp-chunk-size 255k \
    --log-file "$LOG" --log-level NOTICE
}

remount() { stop_mount && start_mount && say "mounted $REMOTE at $MP"; }

check() {
  mounted_at /mnt/user || return 0                       # the array is not started: the next check mounts
  local now mounted=0 alive=0 dead=0 listed=0 fails=0 first=0 rc verdict action box
  now=$(date +%s)
  mounted_at "$MP" && mounted=1
  [ -n "$(rclone_pids)" ] && alive=1
  if [ "$mounted" = 1 ]; then
    look stat -- "$MP"; rc=$?
    if [ "$rc" != 0 ] && grep -q "Transport endpoint is not connected" "$ERR" 2>/dev/null; then dead=1; fi
    if [ "$dead" = 0 ] && [ "$rc" = 0 ] && look ls -- "$MP"; then listed=1; fi
  fi
  [ -f "$STATE" ] && read -r fails first < "$STATE"
  case "$fails" in ''|*[!0-9]*) fails=0;; esac
  case "$first" in ''|*[!0-9]*) first=0;; esac
  if [ "$mounted" = 1 ] && [ "$alive" = 1 ] && [ "$dead" = 0 ] && [ "$listed" != 1 ]; then
    fails=$((fails + 1)); [ "$first" = 0 ] && first=$now
  fi
  verdict=$(decide "$mounted" "$alive" "$dead" "$listed" "$fails" "$first" "$now" -)
  if [ "${verdict%% *}" = check-box ]; then
    box=0
    timeout 60 rclone lsf "$REMOTE" --config "$CONF" --max-depth 1 >/dev/null 2>&1 && box=1
    verdict=$(decide "$mounted" "$alive" "$dead" "$listed" "$fails" "$first" "$now" "$box")
  fi
  action=${verdict%% *}
  case "$action" in
    ok) [ "$fails" -gt 0 ] && say "ok: it answers again (after $fails failed look(s))"; echo "0 0" > "$STATE";;
    wait) say "$verdict"; echo "$fails $first" > "$STATE";;
    mount|remount) say "$verdict — remounting"; echo "0 0" > "$STATE"; remount;;
  esac
}

case "$1" in
  --watch) while true; do /bin/bash "$0"; sleep 60; done;;
  --remount) say "remount asked for by hand"; remount;;
  --lib) ;;                                              # the functions only (tests/seedbox-mount.test.ts)
  *) check;;
esac
