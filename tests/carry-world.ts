/**
 * A scripted world for the carry run's tests: real rows (plans, games, ways, kept files, packages, jobs, requests) in the
 * test database, every outside call the run makes swapped through crdeps, a clock the test moves, and jobs that end
 * exactly as the test says (done with a manifest, failed with a typed fail_json, cancelled by whom). Nothing here runs a
 * job: the run only ever queues them, and the test plays the job's part.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { db, serializeJob, serializeRequest, stmts, type GameRow, type JobRow, type RequestRow } from "../src/db";
import { events } from "../src/events";
import { atdeps } from "../src/ways/attach";
import { advanceRun, carryMemory, crdeps, getRun, startRun, type RunRow, type StartRun } from "../src/ways/carry";
import type { CopyFacts, CopyServes } from "../src/ways/copy";
import { insertContent, insertPlan, insertWay, updateWay, type ContentRow, type PlanRow, type WayRow } from "../src/ways/store";
import type { CheckReport, ConstructManifest, ContentPlan, FailInfo, GameDraft, IntakeManifest, JobSpec, PlanKind, RunStep, RuntimePlanSpec } from "../src/ways/types";
import { validatePlanSpec, validateWayContent } from "../src/ways/validate";

export const sha1 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
export const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
/** decimal, as ludarr says every size */
export const GB = 1e9;

/* ─────────── the live shapes ─────────── */

export const KYTY = "chenxiao07/KytyPS5", KYTY_AT = "65ed19d996d4f0c4fc46305194a3dde27e36e39c";
export const DEMONS_SOULS = ["PPSA01341", "PPSA01342", "PPSA01340"], DS_VERSIONS = ["01.005.000", "01.007.000"];
export const SEALED = "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it";
/** the KytyPS5 plan: an emulator whose games are packed into one .zar */
export const kytyPlan = (): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^KytyPS5-v\\d+[.]zip$", channel: "stable" },
  launch: { exe: "KytyLauncher.exe", argv: ["--play"] },
  content: { kind: "disc", platform: "ps5", what: "a PS5 game packed from its app0 folder (.zar)", search: ["any"], accept: { hashes: [], formats: ["zar"] }, place: "game/{name}" },
  files: [], setup: [], needs: [], keep: ["user/**"], seed: [], firstRun: null, notes: "",
});
/** way 1 of Demon's Souls as it is live: the emulator's template made this game's (one serial, no make, no versions) */
export const kytyWay = (): ContentPlan => ({
  kind: "disc", platform: "ps5", what: "Demon's Souls (PlayStation 5)", search: ["Demon's Souls"],
  accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, normalize: null, place: "game/PPSA01341-app0.zar",
});
/** the Kyty make: the app0 folder packed into one .zar with zarchive */
export const kytyMake = () => ({
  from: ["kept", "copy", "inbox", "indexer"] as ("kept" | "copy" | "inbox" | "indexer")[],
  input: { shape: "folder" as const, platform: "ps5" as const, marker: "sce_sys/param.json", also: ["eboot.bin"], serials: [...DEMONS_SOULS], versions: [...DS_VERSIONS], category: "game" as const },
  steps: [
    { pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } },
    { convert: { with: "zarchive" as const, argv: ["{prep}/app0", "{out}"], timeoutSec: 7200 } },
  ],
  output: { shape: "file" as const, name: "{serial}-app0.zar" },
});
/** the way's content after the upgrade round: the editions and versions the code names (with evidence), made from the folder */
export const kytyUpgraded = (): ContentPlan => ({
  ...kytyWay(), what: "Demon's Souls at 1.05 or 1.07", terms: ["PPSA01341"], place: "game/{name}",
  accept: { hashes: [], formats: ["zar"], serials: [...DEMONS_SOULS], versions: [...DS_VERSIONS], category: "game",
    evidence: [{ repo: KYTY, commit: KYTY_AT, path: "src/graphics/host_gpu/renderer/demonsSouls.h", lines: [13, 19], values: [...DEMONS_SOULS, ...DS_VERSIONS] }] },
  make: kytyMake() as never,
});
/** the check the AI adds for Kyty (a way override: the plan is shared by every game it plays) */
export const kytyCheck = { steps: [{ run: { exe: "kyty_shader_precompile.exe", argv: ["--game", "{content}", "--param", "{work}/param.json"], wine: true, timeoutSec: 600 }, what: "the emulator reads the packed game" }], smoke: null };

/** NX2navi as it is live: a recomp whose game file (a .nup) is described only in words, built on the player's PC */
export const nx2navi = (): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^NX2navi-Setup-.*[.]exe$", channel: "stable" },
  launch: { exe: "NX2navi.exe", argv: ["--from", "{install}/dump"] },
  content: {
    kind: "rom", platform: "switch", search: ["The Legend of Zelda: Ocarina of Time"], normalize: null, place: "dump/{name}",
    what: "The Legend of Zelda: Ocarina of Time (Switch 2) with its 1.1.1 update, as one .nup made with Eglantine: program 0400486024DEC000, main build e0f3ccfa",
    accept: { hashes: [], formats: ["nup"] },
  },
  files: [], setup: [], needs: [], keep: ["saves/**"], seed: [],
  firstRun: "On the first start NX2navi builds the game from your dump on your PC (10 to 25 minutes) and downloads its tools.",
  notes: "",
});
/** what the server-build round makes of it: a kit build on the server, a GPU-free check, nothing built on players' PCs */
export const nx2naviOnServer = (): RuntimePlanSpec => ({
  ...nx2navi(),
  program: {
    kind: "release", assetPattern: "^NX2navi-app-.*[.]zip$", channel: "stable",
    perGame: { steps: ["python -I tools/make_game.py --nup {content} --out {out} --until compile --jobs {jobs}"], wine: true, cpu: "x86-64-v3", timeoutSec: 21600, artifact: "." },
  },
  launch: { exe: "ocarina.exe", argv: [] },
  content: { ...nx2navi().content!, ship: false },
  firstRun: null,
  check: { steps: [{ run: { exe: "ocarina.exe", argv: ["--selftest"], wine: true, timeoutSec: 300 }, what: "the game's own self-test" }], smoke: null },
});
/** and what the upgrade round makes of its content: the ids as data, and who makes the .nup */
export const nx2naviContent = (): ContentPlan => ({
  ...nx2navi().content!, ship: false, what: "The Legend of Zelda: Ocarina of Time (Switch 2) with the 1.1.1 update",
  accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"], builds: ["e0f3ccfaf50065ae4ea01eb5aeb13b1a"], versions: ["1.1.1"],
    evidence: [{ repo: "tangerineturtle1/NX2navi", commit: "1".repeat(40), path: "tools/make_game.py", lines: [60, 70], values: ["0400486024DEC000", "e0f3ccfaf50065ae4ea01eb5aeb13b1a", "1.1.1"] }] },
  personalDump: "Eglantine on your Switch 2",
});

/** Zelda 64: Recompiled (ludarr's own list): Majora's Mask, US 1.0, proven by hash */
export const MM_SHA1 = "d6133ace5afaa0882cf214cf88daba39e266c078";
export const zeldaPlan = (check = false): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "Zelda64Recompiled.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "Majora's Mask, NTSC-U 1.0", search: ["The Legend of Zelda: Majora's Mask", "Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: MM_SHA1 }], formats: ["z64", "v64", "n64"], regions: ["US"] }, normalize: "n64-z64", place: "mm.n64.us.1.0.z64" },
  files: [{ path: "portable.txt", text: "" }], setup: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: "",
  ...(check ? { check: { steps: [], smoke: { seconds: 20, needs: "vulkan" as const } } } : {}),
});
export const mmDraft = (): GameDraft => ({ name: "The Legend of Zelda: Majora's Mask", aliases: ["Majora's Mask"], platforms: ["n64"], year: 2000, releaseIso: null, summary: null, genres: [], developer: "Nintendo", publisher: "Nintendo", searchTerms: [] });

/* ─────────── the world ─────────── */

export interface World {
  dir: string;
  clock: { t: number };
  /** fakes the test can change */
  copy: { facts: Map<number, CopyFacts | null>; serves: Map<number, CopyServes>; judged: number[] };
  inbox: { queued: { path: string; jobId: number }[]; next: string[]; waiting: number; dir: string };
  ai: { ready: boolean; tokens: Map<number, number> };
  requests: { made: number[]; retried: number[]; cancelled: number[] };
  plan(name: string, kind: PlanKind, spec: RuntimePlanSpec, o?: { status?: "ready" | "draft" | "broken"; repo?: string; jobId?: number | null }): PlanRow;
  game(name: string, platforms: string[], o?: { year?: number; aliases?: string[]; igdbId?: number }): GameRow;
  way(g: GameRow, p: PlanRow, content?: ContentPlan | null, overrides?: Record<string, unknown>): WayRow;
  kept(g: GameRow, name: string, o?: { source?: ContentRow["source"]; size?: number; bytes?: string; platform?: string; shape?: "file" | "folder"; sha1?: string; sha256?: string; made?: boolean }): ContentRow;
  romPackage(g: GameRow, file: string, o: { size: number; platform: string; title?: string; sha256?: string }): number;
  start(o: StartRun): RunRow;
  advance(id: number, steps?: number): Promise<RunRow>;
  run(id: number): RunRow;
  steps(id: number): RunStep[];
  children(id: number): JobRow[];
  live(id: number): JobRow | null;
  job(id: number): JobRow;
  spec(j: JobRow): JobSpec;
  end(id: number, o: { state?: "done" | "failed" | "cancelled"; message?: string; fail?: FailInfo | null; manifest?: unknown; trace?: unknown[] }): JobRow;
  /** a repair round's end as the AI leaves it: its edits applied first */
  round(id: number, o: { edit?: () => void; changed?: string[]; ask?: ConstructManifest["ask"]; message?: string; tokens?: number; fail?: FailInfo; failMessage?: string }): JobRow;
  /** a make's end as make.ts leaves it: the product kept and attached, the assemble queued */
  made(id: number, o: { name: string; serial?: string; version?: string }): { job: JobRow; product: ContentRow; assemble: JobRow };
  /** an assemble's end as assemble.ts leaves it: the package, the way built, the check in the trace */
  built(id: number, check?: CheckReport | null): JobRow;
  request(id: number): RequestRow;
  setRequest(id: number, patch: Partial<Record<keyof RequestRow, unknown>>): void;
  cleanup(): void;
}

const saved = { ...crdeps }, savedAt = { ...atdeps };
let appid = 977_000;

export function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "carry-world-"));
  const clock = { t: Date.UTC(2026, 10, 8, 12, 0, 0) };
  const copy = { facts: new Map<number, CopyFacts | null>(), serves: new Map<number, CopyServes>(), judged: [] as number[] };
  const inbox = { queued: [] as { path: string; jobId: number }[], next: [] as string[], waiting: 0, dir: join(dir, "library", ".ahoy-inbox") };
  const ai = { ready: true, tokens: new Map<number, number>() };
  const requests = { made: [] as number[], retried: [] as number[], cancelled: [] as number[] };
  carryMemory.reset();
  // a way added in a test fetches no dump list from the network
  atdeps.loadDat = async () => null;
  Object.assign(crdeps, {
    now: () => clock.t,
    checkPlanNow: async (p: PlanRow) => { db.query("UPDATE runtime_plans SET status='ready', status_note=NULL WHERE id=?").run(p.id); return db.query("SELECT * FROM runtime_plans WHERE id=?").get(p.id) as PlanRow; },
    latestRelease: async () => null,
    curatedGame: async () => null,
    copyFacts: (gameId: number) => copy.facts.get(gameId) ?? null,
    judgeCopy: async (gameId: number) => { copy.judged.push(gameId); return copy.facts.get(gameId) ?? null; },
    copyServes: (gameId: number) => copy.serves.get(gameId) ?? { serves: "unknown", why: "looking at the game's copy" },
    inputMatches: () => ({ ok: false, why: "not what its game file is made from" }),
    inboxDir: (g: GameRow) => join(inbox.dir, g.slug ?? `game-${g.id}`),
    ensureInbox: async (g: GameRow) => ({ dir: join(inbox.dir, g.slug ?? `game-${g.id}`), why: null }),
    intakeInbox: async (g: GameRow, runId: number) => {
      const jobs: number[] = [];
      for (const path of inbox.next.splice(0)) {
        const j = crdeps.enqueueJob({ kind: "content", gameId: g.id, path, inbox: true, runId }, { gameId: g.id, runId });
        inbox.queued.push({ path, jobId: j.id }); jobs.push(j.id);
      }
      return { queued: jobs.length, jobs, notes: [], waiting: inbox.waiting };
    },
    previewContentPass: async () => ({ names: ["Demon's Souls"], platform: "ps5", candidates: [{ title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]", size: 58e9, indexer: "GGn", take: false, why: "the game's own copy" }] }),
    diskFree: async () => 10 * GB,
    // the world's own folder stands in for the folders ludarr takes files from (a download in it may be offered)
    allowedRoots: async () => [realpathSync(dir)],
    wayBuildNeeded: () => false,
    createRequest: (gameId: number, wayId: number) => {
      const r = stmts.insertWayRequest.get(gameId, "find-files", wayId) as RequestRow;
      requests.made.push(r.id);
      return serializeRequest(stmts.requestById.get(r.id) as RequestRow);
    },
    retryRequest: (id: number) => { requests.retried.push(id); db.query("UPDATE requests SET state='requested', stage='queued', next_try_at=NULL, candidates_json=NULL, tried_json=NULL WHERE id=?").run(id); return serializeRequest(stmts.requestById.get(id) as RequestRow); },
    cancelRequest: async (id: number) => { requests.cancelled.push(id); db.query("UPDATE requests SET state='cancelled', stage='cancelled' WHERE id=?").run(id); },
    agentReady: () => ai.ready,
    constructTokens: async (jobId: number) => ai.tokens.get(jobId) ?? 0,
    log: () => {},
  });
  const plans: number[] = [], games: number[] = [], packages: number[] = [];

  const w: World = {
    dir, clock, copy, inbox, ai, requests,
    plan(name, kind, spec, o = {}) {
      const v = validatePlanSpec(spec, kind);
      if (!v.ok) throw new Error(`the test plan does not validate: ${v.errors.join("; ")}`);
      const p = insertPlan({ name, kind, repo: o.repo ?? `carrytest/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, platforms: spec.content ? [spec.content.platform] : [], spec: v.value!, status: o.status ?? "ready", jobId: o.jobId ?? null });
      plans.push(p.id);
      return p;
    },
    game(name, platforms, o = {}) {
      const row = db.query(`INSERT INTO games (name, slug, platforms_json, release_year, aliases_json, igdb_id, source) VALUES (?,?,?,?,?,?,?) RETURNING *`)
        .get(name, `carry-${++appid}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, JSON.stringify(platforms), o.year ?? null, JSON.stringify(o.aliases ?? []), o.igdbId ?? null, o.igdbId ? "igdb" : "manual") as GameRow;
      games.push(row.id);
      return row;
    },
    way(g, p, content, overrides) {
      const own = content ? validateWayContent(content, p.kind) : null;
      if (own && !own.ok) throw new Error(`the test way does not validate: ${own.errors.join("; ")}`);
      return insertWay({ gameId: g.id, planId: p.id, content: own?.value ?? null, overrides: (overrides ?? null) as never });
    },
    kept(g, name, o = {}) {
      const store = join(dir, "store", String(g.id));
      mkdirSync(store, { recursive: true });
      const path = join(store, name);
      if (o.shape === "folder") { mkdirSync(join(path, "sce_sys"), { recursive: true }); writeFileSync(join(path, "eboot.bin"), "elf"); }
      else writeFileSync(path, o.bytes ?? name);
      const row = insertContent({ gameId: g.id, platform: o.platform ?? null, name, path, size: o.size ?? (o.bytes ?? name).length, hashes: { sha1: o.sha1 ?? sha1(o.bytes ?? name), sha256: o.sha256 ?? sha256(o.bytes ?? name) }, source: o.made ? "made" : o.source ?? "upload", shape: o.shape ?? "file" });
      return row;
    },
    romPackage(g, file, o) {
      const pkgDir = join(dir, "packages", String(g.id));
      mkdirSync(dirname(join(pkgDir, file)), { recursive: true });
      writeFileSync(join(pkgDir, file), "dump");
      const manifest = { schema: 1, kind: "rom", platform: o.platform, launch: { exe: file, args: "", cwd: "" }, files: [{ path: file, size: o.size, sha256: o.sha256 ?? "c".repeat(64) }], source: o.title ? { title: o.title } : null };
      const pkg = stmts.insertPackage.get(g.id, null, pkgDir, g.name, null, o.size, JSON.stringify(manifest)) as { id: number };
      packages.push(pkg.id);
      events.emit("package", { id: pkg.id, gameId: g.id });
      return pkg.id;
    },
    start: o => startRun(o),
    async advance(id, steps) { await advanceRun(id, steps ? { steps } : {}); return getRun(id)!; },
    run: id => getRun(id)!,
    steps: id => JSON.parse(getRun(id)!.steps_json) as RunStep[],
    children: id => db.query("SELECT * FROM jobs WHERE run_id=? ORDER BY id").all(id) as JobRow[],
    live: id => (db.query("SELECT * FROM jobs WHERE run_id=? AND state IN ('queued','running') ORDER BY id DESC LIMIT 1").get(id) as JobRow | null) ?? null,
    job: id => stmts.jobById.get(id) as JobRow,
    spec: j => JSON.parse(j.spec_json!) as JobSpec,
    end(id, o) {
      const state = o.state ?? "done";
      if (state === "done") stmts.setJobDone.run(o.message ?? "done", null, o.manifest === undefined ? null : JSON.stringify(o.manifest), id);
      else stmts.setJobFailed.run(state, o.message ?? state, id);
      if (o.fail !== undefined) stmts.setJobFail.run(o.fail ? JSON.stringify(o.fail) : null, id);
      if (o.trace) stmts.setJobTrace.run(JSON.stringify(o.trace), id);
      const j = stmts.jobById.get(id) as JobRow;
      events.emit("job", serializeJob(j));
      return j;
    },
    round(id, o) {
      const j = stmts.jobById.get(id) as JobRow;
      const spec = JSON.parse(j.spec_json!) as Extract<JobSpec, { kind: "construct" }>;
      o.edit?.();
      if (o.tokens) ai.tokens.set(id, o.tokens);
      if (o.fail) return w.end(id, { state: "failed", message: o.failMessage ?? "the AI importer could not make a plan", fail: o.fail });
      const manifest: ConstructManifest = { planId: spec.planId!, runId: spec.runId ?? null, changed: o.changed ?? [], ...(o.ask ? { ask: o.ask } : {}) };
      return w.end(id, { message: o.message ?? (o.changed?.length ? `the plan was reworked: ${o.changed.join(", ")}` : "nothing to change"), manifest });
    },
    made(id, o) {
      const j = stmts.jobById.get(id) as JobRow;
      const spec = JSON.parse(j.spec_json!) as Extract<JobSpec, { kind: "make" }>;
      const way = db.query("SELECT * FROM ways WHERE id=?").get(spec.wayId) as WayRow;
      const g = stmts.gameById.get(way.game_id) as GameRow;
      const product = w.kept(g, o.name, { made: true, platform: "ps5", size: 22 * GB });
      db.query("UPDATE contents SET identity_json=? WHERE id=?").run(JSON.stringify({ platform: "ps5", serial: o.serial ?? "PPSA01341", version: o.version ?? "01.007.000", shape: "zar" }), product.id);
      updateWay(way.id, { contentId: product.id });
      const assemble = crdeps.enqueueJob({ kind: "assemble", wayId: way.id, auto: true, runId: j.run_id ?? null }, { gameId: g.id, runId: j.run_id ?? null });
      const job = w.end(id, { message: `made ${o.name} (22.0 GB) · ${o.serial ?? "PPSA01341"} ${o.version ?? "01.007.000"}` });
      return { job, product: db.query("SELECT * FROM contents WHERE id=?").get(product.id) as ContentRow, assemble };
    },
    built(id, check = null) {
      const j = stmts.jobById.get(id) as JobRow;
      const spec = JSON.parse(j.spec_json!) as Extract<JobSpec, { kind: "assemble" }>;
      const way = db.query("SELECT * FROM ways WHERE id=?").get(spec.wayId) as WayRow;
      const pkgDir = join(dir, "built", String(way.id), String(id));
      mkdirSync(pkgDir, { recursive: true });
      const pkg = stmts.insertPackage.get(way.game_id, id, pkgDir, "built", null, 1000, JSON.stringify({ schema: 1, kind: "emulated", files: [] })) as { id: number };
      packages.push(pkg.id);
      db.query("UPDATE ways SET status='built', status_note=NULL, package_id=? WHERE id=?").run(pkg.id, way.id);
      return w.end(id, { message: `built (${pkgDir})`, trace: check ? [{ kind: "check", report: check }] : [] });
    },
    request: id => stmts.requestById.get(id) as RequestRow,
    setRequest(id, patch) {
      const keys = Object.keys(patch);
      db.query(`UPDATE requests SET ${keys.map(k => `${k}=?`).join(", ")} WHERE id=?`).run(...keys.map(k => (patch as Record<string, unknown>)[k] as never), id);
      events.emit("request", serializeRequest(stmts.requestById.get(id) as RequestRow));
    },
    cleanup() {
      Object.assign(crdeps, saved);
      Object.assign(atdeps, savedAt);
      carryMemory.reset();
      for (const id of games) {
        db.query("DELETE FROM jobs WHERE game_id=?").run(id);
        db.query("DELETE FROM requests WHERE game_id=?").run(id);
        db.query("DELETE FROM blocklist WHERE game_id=?").run(id);
        db.query("DELETE FROM contents WHERE game_id=?").run(id);
      }
      for (const id of packages) db.query("DELETE FROM packages WHERE id=?").run(id);
      for (const id of plans) { db.query("DELETE FROM jobs WHERE run_id IN (SELECT id FROM carry_runs WHERE plan_id=?)").run(id); db.query("DELETE FROM runtime_plans WHERE id=?").run(id); }
      for (const id of games) db.query("DELETE FROM games WHERE id=?").run(id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return w;
}

/** a check the server could not run: no graphics device (proves nothing either way) */
export const ENV_CHECK: CheckReport = { verdict: "env", steps: [{ what: "the emulator reads the packed game", code: 0, ok: true, tail: "param ok", seconds: 2 }], smoke: null, text: "not started here: the server has no graphics device" };
export const PASS_CHECK: CheckReport = { verdict: "pass", steps: [{ what: "the game's own self-test", code: 0, ok: true, tail: "selftest ok", seconds: 1 }], smoke: null, text: "the game's own self-test passed" };
/** an inbox entry as the content job leaves it */
export const intake = (entry: string, contentId: number | null, o: Partial<IntakeManifest> = {}): IntakeManifest => ({ inbox: true, entry, contentId, attached: [], inputFor: [], notes: [], ...o });
