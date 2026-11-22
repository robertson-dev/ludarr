#!/usr/bin/env bash
# On the Docker host: bash run.sh RESULTS_DIR [--agent-only] [--smoke] [case ...]
set -euo pipefail
lab=$(cd -- "$(dirname -- "$0")" && pwd)
out=${1:?Supply a new results directory}; shift
mkdir -p -- "$out"
out=$(cd -- "$out" && pwd)
mode=normal
if [[ ${1:-} == --agent-only ]]; then mode=agent-only; shift; fi
smoke=no
if [[ ${1:-} == --smoke ]]; then smoke=yes; shift; fi
service=${LUDARR_CONTAINER:-ludarr}
image=$(docker inspect -f '{{.Image}}' "$service")
cases=$(mktemp -d)
worker_name=""
cleanup() {
  if [[ -n "$worker_name" ]]; then docker rm -f "$worker_name" >/dev/null 2>&1 || true; fi
  if [[ "$cases" == /tmp/tmp.* && -d "$cases" ]]; then rm -rf -- "$cases"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
isolated=(--rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 120 --cpus 2 --memory 3g)
case_tool() {
  docker run "${isolated[@]}" --tmpfs /tmp:rw,exec,size=96m -v "$lab/fixtures.py:/fixtures.py:ro" -v "$cases:/cases:$1" "$image" python3 /fixtures.py "${@:2}"
}
case_tool rw prepare
mapfile -t available < <(case_tool ro list)
if (( $# )); then selected=("$@"); else selected=("${available[@]}"); fi
# Model calls run separately. Only text from the synthetic worker goes to the configured provider.
# The model key stays in Ludarr; the worker has no network, host credentials or production volumes.
relay=$(cat <<'BUN'
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { anthropicCaller, agentModel } from "./src/process/agent";
try {
  const d=new Database(existsSync("/config/ludarr.db")?"/config/ludarr.db":"/config/playarr.db",{readonly:true});   // (the old name: a server set up before the rename)
  const row=d.query("select settings_json from plugin_instances where kind='importer' and impl='agent' and enabled=1 order by priority,id limit 1").get();
  const plugin=d.query("select enabled from plugins where id='importers'").get();
  if(!row || !plugin?.enabled)throw Error("AI importer disabled");
  const s=JSON.parse(row.settings_json); d.close();
  const base=s.baseUrl||"https://api.anthropic.com", model=agentModel(s.model||"",base);
  const q=JSON.parse(await Bun.stdin.text());
  const response=await anthropicCaller({key:s.apiKey,base,timeoutMs:80000,retries:0})({model,system:q.system,tools:q.tools,messages:q.messages,max_tokens:Math.min(2200,q.max_tokens)});
  console.log(JSON.stringify({model,response}));
} catch(e) {console.log(JSON.stringify({error:String(e.message).slice(0,350)}));}
BUN
)
reports=()
for name in "${selected[@]}"; do
  [[ "$name" =~ ^[a-z0-9-]+$ && -d "$cases/$name" ]] || { echo "Unknown case $name" >&2; exit 2; }
  suffix="$mode"; [[ "$smoke" != yes ]] || suffix="$mode-smoke"
  result="$out/$name-$suffix.json"
  [[ ! -e "$result" ]] || { echo "Result exists: $result" >&2; exit 2; }
  platform=pc; [[ "$name" != ps5-* ]] || platform=ps5
  worker_name="ludarr-fixture-${cases##*.}-$name"
  echo "Running $name ($mode)" >&2
  coproc TRIAL { timeout 260 docker run -i "${isolated[@]}" --init --name "$worker_name" --user 65534:65534 \
    --tmpfs /tmp:rw,exec,size=400m,mode=1777 --tmpfs /lab:rw,exec,size=2g,uid=65534,gid=65534 \
    -e DB_PATH=:memory: -e LUDARR_CONFIG=/lab -e LUDARR_GAMES=/lab/library -e LUDARR_WORK=/lab/work -e LUDARR_BLOCKS_DIR=/lab/blocks -e HOME=/tmp \
    -v "$lab/worker.ts:/app/lab-worker.ts:ro" -v "$cases/$name:/fixture:ro" "$image" bun /app/lab-worker.ts "$platform" "$mode" "$smoke"; }
  pid=$TRIAL_PID
  exec {reader}<&"${TRIAL[0]}" {writer}>&"${TRIAL[1]}"
  calls=0
  while IFS= read -r line <&"$reader"; do
    case "$line" in
      "ASK "*)
        ((++calls <= 9)) || { echo "Worker exceeded its model budget" >&2; exit 1; }
        reply=$(printf '%s' "${line#ASK }" | docker exec -i "$service" bun -e "$relay")
        printf '%s\n' "$reply" >&"$writer"
        ;;
      "RESULT "*) printf '%s\n' "${line#RESULT }" > "$cases/outcome.json" ;;
      *) : ;;
    esac
  done
  exec {reader}<&- {writer}>&-
  rc=0; wait "$pid" || rc=$?
  if (( rc != 0 )) || [[ ! -s "$cases/outcome.json" ]]; then
    docker rm -f "$worker_name" >/dev/null 2>&1 || true
    printf '{"state":"worker-error","relayError":"Worker ended without a complete result (exit %d)","calls":%d,"tokens":null}\n' "$rc" "$calls" > "$cases/outcome.json"
  fi
  worker_name=""
  docker run -i "${isolated[@]}" -v "$lab/fixtures.py:/fixtures.py:ro" -v "$cases:/cases:ro" "$image" \
    python3 /fixtures.py grade "$name" "$mode" "$image" < "$cases/outcome.json" > "$result.tmp"
  mv -- "$result.tmp" "$result"
  rm -- "$cases/outcome.json"
  echo "Saved $name ($calls model calls)" >&2
  reports+=("${result##*/}")
done
docker run "${isolated[@]}" -v "$lab/fixtures.py:/fixtures.py:ro" -v "$out:/results:ro" "$image" \
  python3 /fixtures.py summary "${reports[@]}"
