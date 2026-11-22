/**
 * An import works on someone else's files, as ludarr itself. What it hands them, and where it follows them:
 *   - the programs it starts (unpackers, installers under wine, the AI importer's shell) get a small fixed environment,
 *     never ludarr's own (the indexer, seedbox and AI keys it was started with)
 *   - the AI importer's list and read tools look inside the download, the output and the scratch folder only
 *   - a link is never followed, never copied and never packaged
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { IMPORT_PATH, importEnv, importExec, realExec, type Exec, type ExecOpts, type Toolbox } from "../src/process/tools";
import { jobPath, runAgent, type CallModel, type ContentBlock } from "../src/process/agent";
import { classifyPath, dropLinks, scan } from "../src/process/classify";
import { buildManifest, inspect, unwrapRoot } from "../src/process/validate";
import { deterministic } from "../src/process/recipes";
import { crackDirs } from "../src/process/scene";
import { agent, recipes } from "../src/plugins/builtin/importers";
import { pluginContext } from "../src/plugins/registry";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { pdeps, rdeps, runJob } from "../src/process/runner";
import { db, stmts, type JobRow, type PackageRow } from "../src/db";
import type { ImportContext } from "../src/plugins/types";

const tmp = (p = "ahoy-safe-") => mkdtempSync(join(tmpdir(), p));
const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill);
function mkGame(dir: string, name = "Hades") {
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, `${name}.exe`), bytes(2_000_000, 1));
  writeFileSync(join(dir, "data", "level.pak"), bytes(5_000_000, 2));
}
/** a link to a folder: a junction on Windows (needs no privilege), a symbolic link elsewhere */
const linkDir = (target: string, at: string) => symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
/** a link to a file where this machine lets a test make one (Windows wants a privilege for it) */
const linkFile = (target: string, at: string): boolean => { try { symlinkSync(target, at, "file"); return true; } catch { return false; } };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const allTools: Toolbox = { sevenZip: "7z", unar: "unar", unrar: null, innoextract: "innoextract", wine: null, xvfb: null, bash: "bash", dlgdrive: null };
/** a scripted model: each call pops the next reply */
function scripted(turns: ContentBlock[][]): CallModel & { seen: unknown[][] } {
  let n = 0;
  const fn = (async (req: { messages: unknown[] }) => {
    fn.seen.push([...req.messages]);
    const content = (turns[n++] ?? [{ type: "text", text: "..." }]).map((b, i) => (b.type === "tool_use" ? { ...b, id: `t${n}-${i}` } : b));
    return { content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }) as unknown as CallModel & { seen: unknown[][] };
  fn.seen = [];
  return fn;
}
/** what the tool calls of a scripted run answered, in order */
const toolResults = (model: { seen: unknown[][] }): string[] =>
  (model.seen.at(-1) as { role: string; content: ContentBlock[] | string }[]).filter(m => m.role === "user" && Array.isArray(m.content))
    .flatMap(m => (m.content as ContentBlock[]).filter(b => b.type === "tool_result").map(b => String(b.content)));

/** the names ludarr is started with on the server (deploy: --env-file ludarr.env), with values no child may see */
const SECRETS: Record<string, string> = {
  PROWLARR_API_KEY: "prowlarr-secret-1", SEEDBOX_SSH_PASS: "seedbox-secret-2", ANTHROPIC_API_KEY: "ai-secret-3",
  LUDARR_CONFIG_SECRET: "config-secret-4", GITHUB_TOKEN: "github-secret-5",
};
const withSecrets = async <T>(fn: () => Promise<T>): Promise<T> => {
  const had = Object.fromEntries(Object.keys(SECRETS).map(k => [k, process.env[k]]));
  Object.assign(process.env, SECRETS);
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(had)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const leaks = (text: string) => Object.entries(SECRETS).filter(([k, v]) => text.includes(v) || text.includes(`"${k}"`)).map(([k]) => k);

const saved = { exec: pdeps.exec, tools: pdeps.tools, callModel: pdeps.callModel, log: pdeps.log, importers: rdeps.importers };
afterAll(() => { pdeps.exec = saved.exec; pdeps.tools = saved.tools; pdeps.callModel = saved.callModel; pdeps.log = saved.log; rdeps.importers = saved.importers; });

describe("what an import's programs are given", () => {
  test("a fixed, small environment: a PATH, a home in the job's scratch folder, the caller's own names — none of ludarr's", async () => {
    const work = tmp();
    await withSecrets(async () => {
      const env = importEnv(work, { WINEPREFIX: join(work, "wine"), STAGING: join(work, "staging") });
      expect(leaks(JSON.stringify(env))).toEqual([]);
      expect(env.HOME).toBe(join(work, "home"));
      expect(env.WINEPREFIX).toBe(join(work, "wine")); expect(env.STAGING).toBe(join(work, "staging"));
      expect(env.PATH).toBe(process.platform === "linux" ? IMPORT_PATH : process.env.PATH ?? "");
      expect(env.TMPDIR).toBeUndefined();                                       // the image's wine does not start with one
      // nothing but the listed names: whatever else ludarr's own environment holds stays there
      const allowed = new Set(["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "WINEPREFIX", "STAGING", ...(process.platform === "win32" ? ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP"] : [])]);
      expect(Object.keys(env).filter(k => !allowed.has(k))).toEqual([]);
    });
  });

  test("a program really started that way cannot read ludarr's keys", async () => {
    const work = tmp();
    await withSecrets(async () => {
      const print = "console.log(JSON.stringify(process.env))";
      // the way imports ran their programs before: everything inherited
      const before = await realExec([process.execPath, "-e", print], { timeoutMs: 30_000 });
      expect(before.code).toBe(0);
      expect(leaks(before.stdout).sort()).toEqual(Object.keys(SECRETS).sort());
      const r = await importExec(work)([process.execPath, "-e", print], { timeoutMs: 30_000, env: { STAGING: join(work, "staging") } });
      expect(r.code).toBe(0);
      expect(leaks(r.stdout)).toEqual([]);
      const seen = JSON.parse(r.stdout) as Record<string, string>;
      expect(seen.HOME).toBe(join(work, "home")); expect(seen.STAGING).toBe(join(work, "staging"));
      expect(existsSync(join(work, "home"))).toBe(true);
    });
  });

  test("the recipes and the AI importer start every program that way", async () => {
    const ctx = pluginContext("importers");
    const calls: { cmd: string[]; opts: ExecOpts }[] = [];
    const work = tmp(), staging = join(work, "staging"), input = tmp();
    mkdirSync(staging);
    writeFileSync(join(input, "game.zip"), bytes(1000));
    pdeps.tools = () => allTools; pdeps.log = () => {};
    pdeps.exec = async (cmd, opts = {}) => {
      calls.push({ cmd, opts });
      if (cmd[0] === "7z" && cmd[1] === "x") mkGame(cmd.find(a => a.startsWith("-o"))!.slice(2), "Hades");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const c: ImportContext = { input, staging, work, gameName: "Hades", releaseTitle: "Hades-GROUP", group: null, log: () => {}, progress: () => {}, signal: new AbortController().signal, previous: [] };
    await withSecrets(async () => {
      const r = await recipes.create({}, ctx).run(c);
      expect(r.ok).toBe(true);
      pdeps.callModel = scripted([
        [{ type: "tool_use", name: "shell", input: { cmd: "env" } }],
        [{ type: "tool_use", name: "finish", input: { ok: false, summary: "only looking", lesson: { recognize: "x", steps: [] } } }],
      ]);
      await agent.create({ apiKey: "sk-test", baseUrl: "https://api.anthropic.com", model: "test", maxTurns: 4, maxMinutes: 1 }, ctx).run(c);
    });
    expect(calls.map(x => x.cmd[0])).toEqual(["7z", "bash"]);
    for (const { cmd, opts } of calls) {
      expect([cmd[0], opts.inheritEnv]).toEqual([cmd[0], false]);
      expect([cmd[0], leaks(JSON.stringify(opts.env))]).toEqual([cmd[0], []]);
      expect(opts.env!.HOME).toBe(join(work, "home"));
    }
    // the shell still gets what its brief promises
    expect(calls[1].opts.env).toMatchObject({ INPUT: input, STAGING: staging, WORK: work, WINEPREFIX: join(work, "wine") });
  });
});

describe("the AI importer's list and read", () => {
  const base = (input: string, staging: string, work: string, callModel: CallModel) => ({
    input, staging, work, gameName: "Hades", releaseTitle: "Hades-GROUP", shape: "installer", problems: ["only an installer"], notes: [],
    exec: (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false })) as Exec, tools: allTools, callModel, model: "test", maxTurns: 8, maxMinutes: 5, log: () => {},
  });
  const giveUp = { type: "tool_use" as const, name: "finish", input: { ok: false, summary: "looked", lesson: { recognize: "x", steps: [] } } };

  test("look inside the download, the output and the scratch folder, and nowhere else on the server", async () => {
    const top = tmp(), work = join(top, "work"), staging = join(work, "staging"), input = join(top, "download"), elsewhere = join(top, "config");
    for (const d of [staging, input, elsewhere]) mkdirSync(d, { recursive: true });
    writeFileSync(join(elsewhere, "ludarr.db"), "API-KEY-AND-SEEDBOX-LOGIN");
    writeFileSync(join(input, "release.nfo"), "install notes");
    writeFileSync(join(staging, "readme.txt"), "in the output");
    writeFileSync(join(work, "log.txt"), "scratch");
    const model = scripted([
      [{ type: "tool_use", name: "read", input: { path: join(elsewhere, "ludarr.db") } }],
      [{ type: "tool_use", name: "read", input: { path: "../config/ludarr.db" } }],
      [{ type: "tool_use", name: "read", input: { path: join(staging, "..", "..", "config", "ludarr.db") } }],
      [{ type: "tool_use", name: "list", input: { path: elsewhere } }],
      [{ type: "tool_use", name: "list", input: { path: process.platform === "win32" ? "C:\\" : "/" } }],
      [{ type: "tool_use", name: "read", input: { path: join(input, "release.nfo") } }],
      [{ type: "tool_use", name: "read", input: { path: join(staging, "readme.txt") } }],
      [{ type: "tool_use", name: "read", input: { path: "log.txt" } }],
      [{ type: "tool_use", name: "list", input: { path: input } }],
      [giveUp],
    ]);
    await runAgent({ ...base(input, staging, work, model), maxTurns: 12 });
    const out = toolResults(model);
    expect(out.slice(0, 5).every(o => /outside INPUT, STAGING and WORK/.test(o))).toBe(true);
    expect(out.join("\n")).not.toContain("API-KEY-AND-SEEDBOX-LOGIN");
    expect(out.join("\n")).not.toContain("ludarr.db");
    expect(out.slice(5, 9)).toEqual(["install notes", "in the output", "scratch", expect.stringContaining("release.nfo")]);
  });

  test("a link in the output or the download leads nowhere else", async () => {
    const top = tmp(), work = join(top, "work"), staging = join(work, "staging"), input = join(top, "download"), elsewhere = join(top, "config");
    for (const d of [staging, input, elsewhere]) mkdirSync(d, { recursive: true });
    writeFileSync(join(elsewhere, "ludarr.db"), "API-KEY-AND-SEEDBOX-LOGIN");
    linkDir(elsewhere, join(staging, "saves"));
    linkDir(elsewhere, join(input, "extras"));
    const byFile = linkFile(join(elsewhere, "ludarr.db"), join(staging, "notes.txt"));
    const model = scripted([
      [{ type: "tool_use", name: "read", input: { path: join(staging, "saves", "ludarr.db") } }],
      [{ type: "tool_use", name: "read", input: { path: join(input, "extras", "ludarr.db") } }],
      [{ type: "tool_use", name: "list", input: { path: join(staging, "saves") } }],
      [{ type: "tool_use", name: "read", input: { path: join(staging, "notes.txt") } }],
      [{ type: "tool_use", name: "list", input: { path: staging } }],
      [giveUp],
    ]);
    await runAgent(base(input, staging, work, model));
    const out = toolResults(model);
    expect(out.slice(0, 3).every(o => /outside INPUT, STAGING and WORK/.test(o))).toBe(true);
    expect(out[3]).toMatch(byFile ? /outside INPUT, STAGING and WORK/ : /no such file/);
    expect(out.join("\n")).not.toContain("API-KEY-AND-SEEDBOX-LOGIN");
    expect(out[4]).not.toContain("ludarr.db");                                // the tree does not walk through the link either
    expect(await jobPath(join(staging, "saves", "ludarr.db"), { input, staging, work })).toBeNull();
    expect(await jobPath(join(staging, "new-file.txt"), { input, staging, work })).toBe(join(staging, "new-file.txt"));   // not there yet: as written
  });
});

describe("a link is never followed, copied or packaged", () => {
  /** an installed game beside a folder that is not part of it, and a link from the game into that folder */
  function linked() {
    const top = tmp(), game = join(top, "staging"), elsewhere = join(top, "config");
    mkGame(game, "Hades"); mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "ludarr.db"), bytes(3_000_000, 9));
    linkDir(elsewhere, join(game, "saves"));
    const byFile = linkFile(join(elsewhere, "ludarr.db"), join(game, "data", "extra.pak"));
    return { top, game, elsewhere, byFile };
  }

  test("the scan lists the files that are there and names the links; the validator and the manifest never see behind one", async () => {
    const { game, byFile } = linked();
    const s = await scan(game);
    expect(s.files.map(f => f.rel).sort()).toEqual(["Hades.exe", "data/level.pak"]);
    expect(s.links.sort()).toEqual(byFile ? ["data/extra.pak", "saves"] : ["saves"]);
    expect((await classifyPath(game)).links).toEqual(s.links);
    const v = await inspect(game, { name: "Hades" });
    expect(v).toMatchObject({ ok: true, launch: "Hades.exe", fileCount: 2, totalSize: 7_000_000 });
    const read: string[] = [];
    const { vdeps } = await import("../src/process/validate");
    const real = vdeps.sha256;
    vdeps.sha256 = async (path, ...rest) => { read.push(basename(path)); return real(path, ...rest); };
    try {
      const m = await buildManifest(v, { name: "Hades", version: null, source: null, tier: "deterministic" });
      expect(m.files.map(f => f.path)).toEqual(["Hades.exe", "data/level.pak"]);
      expect(m.totalSize).toBe(7_000_000);
      expect(read.sort()).toEqual(["Hades.exe", "level.pak"]);               // ludarr.db was never opened
    } finally { vdeps.sha256 = real; }
  });

  test("a folder holding only a link to a game elsewhere is no game folder", async () => {
    const top = tmp(), staging = join(top, "staging"), elsewhere = join(top, "other-game");
    mkdirSync(staging); mkGame(elsewhere, "Hades");
    linkDir(elsewhere, join(staging, "Hades"));
    expect(await unwrapRoot(staging)).toBe(staging);                          // not descended into: the link would become the package
    expect((await inspect(staging, { name: "Hades" })).problems).toContain("the folder is empty");
  });

  test("links are removed, their targets left alone", async () => {
    const { game, elsewhere, byFile } = linked();
    expect((await dropLinks(game)).sort()).toEqual(byFile ? ["data/extra.pak", "saves"] : ["saves"]);
    expect(readdirSync(game).sort()).toEqual(["Hades.exe", "data"]);
    expect(readdirSync(join(game, "data"))).toEqual(["level.pak"]);
    expect(readdirSync(elsewhere)).toEqual(["ludarr.db"]);
    expect(await dropLinks(game)).toEqual([]);
  });

  test("a link an archive carried is gone the moment it is unpacked: nothing is unpacked or laid over through it", async () => {
    const top = tmp(), input = join(top, "dl"), staging = join(top, "work", "staging"), elsewhere = join(top, "config");
    mkdirSync(input); mkdirSync(elsewhere);
    writeFileSync(join(input, "Game.zip"), bytes(1000));
    const log: string[] = [];
    // the outer archive: the game, a second archive, and a link named as the folder that second archive unpacks into
    const exec: Exec = async cmd => {
      if (cmd[0] !== "7z" || cmd[1] !== "x") return { code: 2, stdout: "", stderr: "", timedOut: false };
      const out = cmd.find(a => a.startsWith("-o"))!.slice(2), archive = basename(cmd[cmd.length - 1]);
      mkdirSync(out, { recursive: true });
      if (archive === "Game.zip") { mkGame(out, "Hades"); writeFileSync(join(out, "dlc.7z"), bytes(60_000_000, 5)); linkDir(elsewhere, join(out, "dlc")); }
      else { mkdirSync(join(out, "plugins"), { recursive: true }); writeFileSync(join(out, "plugins", "x.js"), "planted"); }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const r = await deterministic(input, staging, { exec, tools: allTools, log: l => log.push(l) }, { name: "Hades" });
    expect(readdirSync(elsewhere)).toEqual([]);                                // nothing was written where the link pointed
    expect(log.join("\n")).toMatch(/removed 1 link \(a game folder holds files only\): dlc/);
    expect(isLink(join(staging, "dlc"))).toBe(false);
    expect(existsSync(join(staging, "dlc", "plugins", "x.js"))).toBe(true);    // the inner archive went into a folder of its own
    expect(r.ok).toBe(true);
  });

  test("a link in a downloaded folder is not copied into the game", async () => {
    const top = tmp(), input = join(top, "Hades-GROUP"), staging = join(top, "work", "staging"), elsewhere = join(top, "config");
    mkGame(input, "Hades"); mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "ludarr.db"), bytes(3_000_000, 9));
    linkDir(elsewhere, join(input, "saves"));
    const log: string[] = [];
    const r = await deterministic(input, staging, { exec: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false }), tools: allTools, log: l => log.push(l) }, { name: "Hades" });
    expect(r.ok).toBe(true);
    expect(r.validation?.fileCount).toBe(2);
    expect(log.join("\n")).toMatch(/1 link in the download left out \(a game folder holds files only\): saves/);
    expect(readdirSync(join(staging, "Hades-GROUP")).sort()).toEqual(["Hades.exe", "data"]);
    expect(existsSync(join(input, "saves", "ludarr.db"))).toBe(true);        // the download is as it was
  });

  test("a link named after the group is no crack folder", async () => {
    const top = tmp(), disc = join(top, "disc"), elsewhere = join(top, "config");
    mkdirSync(join(disc, "CODEX"), { recursive: true }); mkdirSync(elsewhere);
    writeFileSync(join(disc, "CODEX", "steam_api64.dll"), bytes(1000)); writeFileSync(join(elsewhere, "ludarr.db"), bytes(1000));
    linkDir(elsewhere, join(disc, "Crack"));
    expect(await crackDirs(disc, "CODEX")).toEqual([join(disc, "CODEX")]);
  });
});

describe("the job: what the importers left is packaged as files only", () => {
  const ctx = pluginContext("importers");
  beforeEach(() => {
    db.exec("DELETE FROM jobs; DELETE FROM packages;"); ensureDefaultRootFolder();
    pdeps.log = () => {}; pdeps.tools = () => allTools;
    rdeps.importers = () => [
      { impl: "recipes", name: "Automatic recipes", importer: recipes.create({}, ctx) },
      { impl: "agent", name: "AI importer", importer: agent.create({ apiKey: "sk-test", baseUrl: "https://api.anthropic.com", model: "test", maxTurns: 8, maxMinutes: 5 }, ctx) },
    ];
  });

  test("a link the AI importer's shell (or an installer) left in the output is not in the package, and nothing behind it is read", async () => {
    const elsewhere = tmp("ahoy-safe-config-");
    writeFileSync(join(elsewhere, "ludarr.db"), bytes(3_000_000, 9));
    const input = tmp(); writeFileSync(join(input, "setup.exe"), bytes(10)); writeFileSync(join(input, "data1.bin"), bytes(10));
    process.env.PROCESS_KEEP_INPUT = "1";
    const j = stmts.insertJob.get(null, null, null, input) as JobRow;
    const staging = join(process.env.AHOY_WORK!, `job-${j.id}`, "staging");
    pdeps.exec = async cmd => {
      if (/wine-install/.test(cmd[2] ?? "")) { mkGame(staging, "Linked Game"); linkDir(elsewhere, join(staging, "saves")); }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    pdeps.callModel = scripted([
      [{ type: "tool_use", name: "shell", input: { cmd: "wine-install" } }],
      [{ type: "tool_use", name: "finish", input: { ok: true, summary: "installed", launch_exe: "Linked Game.exe", lesson: { recognize: "x", steps: ["wine-install"] } } }],
    ]);
    try { await runJob(j.id); } finally { delete process.env.PROCESS_KEEP_INPUT; }
    const done = stmts.jobById.get(j.id) as JobRow;
    expect([done.state, done.message]).toEqual(["done", expect.stringMatching(/^ready: 2 files/)]);
    expect(done.transcript).toMatch(/removed 1 link \(a game folder holds files only\): saves/);
    const pkg = stmts.packageForJob.get(j.id) as PackageRow;
    expect(readdirSync(pkg.path).sort()).toEqual(["Linked Game.exe", "ahoy.json", "data"]);
    expect(JSON.parse(pkg.manifest_json).files.map((f: { path: string }) => f.path)).toEqual(["Linked Game.exe", "data/level.pak"]);
    expect(readdirSync(elsewhere)).toEqual(["ludarr.db"]);                   // what the link pointed at is untouched
  });
});
