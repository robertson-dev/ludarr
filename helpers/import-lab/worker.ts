/** Run inside the network-disabled fixture container. The parent relays only model messages. */
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { db, stmts, type JobRow } from "./src/db";
import { ensureDefaultRootFolder } from "./src/library/rootfolders";
import { BUILTIN } from "./src/plugins/builtin";
import * as registry from "./src/plugins/registry";
import { pdeps } from "./src/process/deps";
import { realExec } from "./src/process/tools";
import { callUsage, type ModelResponse } from "./src/process/agent";
import { runJob } from "./src/process/runner";

if (process.env.DB_PATH !== ":memory:" || process.env.LUDARR_GAMES !== "/lab/library") throw Error("Run through run.sh in the disposable fixture container.");
const [platform, mode, smoke] = process.argv.slice(2);
for (const p of BUILTIN.filter(p => p.id === "importers")) registry.registerPlugin(p, "builtin");
registry.ensureSingletons();
db.query("update plugin_instances set settings_json=? where impl='agent'").run(JSON.stringify({ apiKey: "local-relay", maxTurns: 9, maxMinutes: 3 }));
if (mode === "agent-only") db.query("update plugin_instances set enabled=0 where impl='recipes'").run();
ensureDefaultRootFolder();
const game = db.query("insert into games(name,slug,platforms_json) values(?,?,?) returning id").get("Lantern Vale", "lantern-vale", JSON.stringify([platform])) as { id: number };
const release = { title: "Lantern.Vale.1.1", flags: { platform } };
const fetchRow = db.query("insert into fetches(game_id,title,client,protocol,state,release_json) values(?,?,'fixture','manual','done',?) returning id").get(game.id, release.title, JSON.stringify(release)) as { id: number };
const job = stmts.insertJob.get(null, fetchRow.id, game.id, "/fixture/Lantern.Vale.1.1") as JobRow;
const lines = createInterface({ input: process.stdin, terminal: false });
const replies = lines[Symbol.asyncIterator]();
let calls = 0, tokens = 0, model = "", relayError = "";
pdeps.log = () => {};
pdeps.callModel = async req => {
  calls++;
  const request = { ...req, max_tokens: Math.min(2200, req.max_tokens) };
  process.stdout.write("ASK " + JSON.stringify(request) + "\n");
  const line = await replies.next();
  if (line.done) throw Error("Model relay closed.");
  const reply = JSON.parse(line.value);
  if (reply.error) { relayError = String(reply.error); throw Error(relayError); }
  model = reply.model;
  const answer = reply.response as ModelResponse;
  const use = callUsage(request, answer);
  tokens += use.input + use.output;
  return answer;
};
try {
  await runJob(job.id);
  const ended = stmts.jobById.get(job.id) as JobRow;
  const pkg = db.query("select path,manifest_json from packages where game_id=?").get(game.id) as { path: string; manifest_json: string } | null;
  const manifest = pkg && JSON.parse(pkg.manifest_json);
  const files: Record<string, { hash: string; size: number; text?: string }> = {};
  let probe: { code: number; stderr: string; timedOut: boolean } | null = null;
  if (pkg) {
    const root = await realpath(pkg.path);
    if (!root.startsWith("/lab/library/")) throw Error("Output outside the fixture library.");
    for (const f of manifest.files) {
      const path = await realpath(resolve(root, f.path));
      if (!path.startsWith(root + sep)) throw Error("Unexpected output path.");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      const size = (await stat(path)).size;
      files[f.path] = { size, hash: hash.digest("hex"), ...(/settings\.ini$/i.test(f.path) && size < 8192 ? { text: await readFile(path, "utf8") } : {}) };
    }
    if (smoke === "yes" && platform === "pc" && manifest?.launch?.exe) {
      const exe = await realpath(resolve(root, manifest.launch.exe));
      if (!exe.startsWith(root + sep)) throw Error("Launch outside the fixture package.");
      const cwd = await realpath(resolve(root, manifest.launch.cwd || "."));
      if (cwd !== root && !cwd.startsWith(root + sep)) throw Error("Launch directory outside the fixture package.");
      const r = await realExec(["xvfb-run", "-a", "wine", exe], { cwd, timeoutMs: 65000,
        env: { WINEPREFIX: "/lab/probe-wine", WINEDEBUG: "-all", HOME: "/tmp" }, maxOutput: 2000 });
      probe = { code: r.code, timedOut: r.timedOut, stderr: r.stderr.slice(-650) };
    }
  }
  const trace = JSON.parse(ended.trace_json ?? "[]").filter((s: any) => s.kind === "tool")
    .map((s: any) => ({ turn: s.turn, tool: s.tool, input: s.input, output: String(s.output ?? "").slice(0, 1500) }));
  await Bun.write(Bun.stdout, "RESULT " + JSON.stringify({ probe, state: ended.state, message: ended.message, tier: ended.tier, calls, tokens, model, relayError,
    stages: JSON.parse(ended.fingerprint_json ?? "{}").importers, lesson: JSON.parse(ended.lesson_json ?? "null"),
    launch: manifest?.launch, kind: manifest?.kind, platform: manifest?.platform, files, trace, log: ended.transcript?.slice(-9000) }) + "\n");
} finally { lines.close(); }
process.exit(0);
