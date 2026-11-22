/**
 * What members and the admin see while a way gets ready (src/library/games.ts statusOf, AMEND M8; src/ways/store.ts
 * wayGaps, DESIGN3 B2.8): a make or a program built for one game counts like a build ("importing · preparing", never the
 * job's own words); a way's status follows what the game's copy is to it, in the copy's words; a plan's digest does not
 * depend on the order its fields were written in.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeBuilds, db, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { statusOf } from "../src/library/games";
import { enqueueJob } from "../src/process/kinds";
import { copyServes, cpdeps, judgeCopy } from "../src/ways/copy";
import { canonicalJson, contentDigest, getPlan, insertPlan, insertWay, settleWay, settleWaysOnCopy, wayGaps } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";

const realCp = { ...cpdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-status-"));
const made = { games: [] as number[], plans: [] as number[] };
afterEach(() => { Object.assign(cpdeps, realCp); });
afterAll(() => {
  Object.assign(cpdeps, realCp);
  for (const id of made.games) for (const t of ["jobs", "packages", "contents"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});
let seq = 0;
function game(name: string, platforms = ["ps2"]): GameRow {
  const g = upsertGame({ name, slug: `status-${++seq}`, platforms_json: JSON.stringify(platforms) } as Partial<GameRow>) as GameRow;
  made.games.push(g.id);
  return g;
}
const disc = (o: Partial<ContentPlan> = {}): ContentPlan => ({ kind: "disc", platform: "ps2", what: "a PS2 disc", search: ["ps2"], accept: { hashes: [], formats: ["iso"] }, place: "g/{name}", ...o });
function plan(c: ContentPlan) {
  const spec: RuntimePlanSpec = { program: { kind: "release", assetPattern: "^St-.*[.]zip$", channel: "stable" }, launch: { exe: "e.exe", argv: ["{content}"] }, content: c, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "" };
  const p = insertPlan({ name: `Status Plan ${++seq}`, kind: "emulator", repo: `status/p-${seq}`, platforms: [c.platform], spec, status: "ready" });
  made.plans.push(p.id);
  return p;
}
function copyOf(g: GameRow, file: string, platform: string) {
  const dir = join(tmp, `pkg-${++seq}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), new Uint8Array(4096).fill(7));
  return stmts.insertPackage.get(g.id, null, dir, g.name, null, 4096, JSON.stringify({ schema: 1, kind: "rom", platform, launch: { exe: file }, files: [] })) as PackageRow;
}

describe("members see 'Preparing' while a way gets ready (M8)", () => {
  test("a make, or a program built for this one game, counts like a build; a plan's own build or the AI never does", () => {
    const g = game("Status Preparing");
    const row = stmts.gameById.get(g.id) as GameRow;
    const make = enqueueJob({ kind: "make", wayId: 1, from: "copy", packageId: 1 }, { gameId: g.id });
    expect(activeBuilds().get(g.id)?.id).toBe(make.id);
    expect(statusOf(row, null, null, activeBuilds().get(g.id))).toEqual({ status: "importing", detail: "preparing" });
    stmts.setJobFailed.run("cancelled", "test", make.id);
    const build = enqueueJob({ kind: "build", planId: 1, wayId: 1, then: "assemble" }, { gameId: g.id });
    expect(statusOf(row, null, null, activeBuilds().get(g.id))).toEqual({ status: "importing", detail: "preparing" });
    stmts.setJobFailed.run("cancelled", "test", build.id);
    // a plan's own build, an AI round: what members see does not move
    expect(statusOf(row, null, null, { kind: "build", state: "running", spec_json: JSON.stringify({ kind: "build", planId: 1 }) } as JobRow).status).toBe("missing");
    expect(statusOf(row, null, null, { kind: "construct", state: "running", spec_json: "{}" } as JobRow).status).toBe("missing");
    // a running make never covers a copy players can start
    const pkg = { manifest_json: JSON.stringify({ kind: "recomp" }), size: 1e9, version: null } as PackageRow;
    expect(statusOf(row, pkg, null, { kind: "make", state: "running", spec_json: "{}" } as JobRow).status).toBe("available");
  });
});

describe("a way's status follows what the game's copy is to it", () => {
  test("not looked at yet: 'looking at the game's copy'; then ready when it is the way's file, or needs-files in the copy's words", async () => {
    cpdeps.judgeSoon = () => {};
    const g = game("Status Copy");
    copyOf(g, "Game.iso", "ps2");
    const ok = insertWay({ gameId: g.id, planId: plan(disc()).id, content: disc() });
    const zar = insertWay({ gameId: g.id, planId: plan(disc({ platform: "ps2", accept: { hashes: [], formats: ["chd"] } })).id, content: disc({ accept: { hashes: [], formats: ["chd"] } }) });
    expect(wayGaps(ok, getPlan(ok.plan_id)!)).toEqual(["looking at the game's copy"]);
    expect(copyServes(g.id, disc()).serves).toBe("unknown");                 // not yet known: no build is offered on a guess
    cpdeps.readIdentity = async () => ({ platform: "ps2", serial: "SLUS-21678" });
    await judgeCopy(g.id);                                                    // its end settles the game's ways without a file
    expect(settleWay(ok.id)).toMatchObject({ status: "ready", status_note: null });
    expect(settleWay(zar.id)).toMatchObject({ status: "needs-files", status_note: "needs the game file (a PS2 disc): the game's copy Game.iso is a .iso file, and this needs .chd" });
    expect(copyServes(g.id, disc()).serves).toBe("direct");
    expect(settleWaysOnCopy(g.id).map(w => w.id).sort()).toEqual([ok.id, zar.id].sort());
  });

  test("a game with no copy: the way needs its file, in the old words", () => {
    const g = game("Status No Copy");
    const w = insertWay({ gameId: g.id, planId: plan(disc()).id, content: disc() });
    expect(settleWay(w.id)).toMatchObject({ status: "needs-files", status_note: "needs the game file (a PS2 disc)" });
  });
});

describe("a plan's digest", () => {
  test("canonical: the same plan in another field order is the same digest; any change is another", () => {
    const a = disc(), b = JSON.parse(JSON.stringify({ place: a.place, accept: { formats: ["iso"], hashes: [] }, search: a.search, what: a.what, platform: a.platform, kind: a.kind })) as ContentPlan;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentDigest(a)).toBe(contentDigest(b));
    expect(contentDigest(disc({ accept: { hashes: [], formats: ["iso", "chd"] } }))).not.toBe(contentDigest(a));
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });
});
