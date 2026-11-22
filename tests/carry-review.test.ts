/**
 * The carry run after the wave-3 review (src/ways/carry.ts, src/ways/carry-api.ts): what a run must never repeat, start
 * beside work already under way, or keep from the admin. An earlier download is read once under a content plan, never
 * beside the search or the import that is still taking it in; a step waiting in the queue says why it waits.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, stmts, type GameRow, type JobRow, type RequestRow } from "../src/db";
import { advanceRun, crdeps, getRun, intend, serializeRun } from "../src/ways/carry";
import { waysApi } from "../src/ways/api";
import { getPlan, getWay, insertContent, planSpec, updatePlan, updateWay } from "../src/ways/store";
import type { ContentPlan, JobSpec, RuntimePlanSpec } from "../src/ways/types";
import { atdeps } from "../src/ways/attach";
import { step0For } from "../src/ways/construct";
import { checkJobOf } from "../web/src/ways/logic";
import { kytyCheck, kytyPlan, kytyUpgraded, kytyWay, mmDraft, nx2naviContent, nx2naviOnServer, PASS_CHECK, world, zeldaPlan, type World } from "./carry-world";
import { copyFactsOf } from "./fakes-w3";

let w: World;
const fetches: number[] = [];
beforeEach(() => { w = world(); });
const packages: number[] = [];
afterEach(() => {
  for (const id of fetches.splice(0)) db.query("DELETE FROM fetches WHERE id=?").run(id);
  for (const id of packages.splice(0)) db.query("DELETE FROM packages WHERE id=?").run(id);
  w.cleanup();
});

const live = (runId: number, kind: string): JobRow => { const j = w.live(runId); expect(j?.kind).toBe(kind); return j!; };
const texts = (runId: number) => w.steps(runId).map(s => s.text);
const kinds = (runId: number, kind: string) => w.children(runId).filter(j => j.kind === kind);

/** an N64 emulator with a check (no upgrade round): a game file it takes is proven by nothing, so one can only be kept for
 *  a look */
const n64Emu = (): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^N64Emu-.*[.]zip$", channel: "stable" },
  launch: { exe: "n64emu.exe", argv: ["{content}"] },
  content: { kind: "rom", platform: "n64", what: "a Nintendo 64 game", search: ["any"], accept: { hashes: [], formats: ["z64", "n64", "v64"] }, place: "roms/{name}" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
  check: { steps: [], smoke: { seconds: 20, needs: "vulkan" } },
});
const banjo = (): ContentPlan => ({ kind: "rom", platform: "n64", what: "Banjo-Kazooie (Nintendo 64)", search: ["Banjo-Kazooie"], accept: { hashes: [], formats: ["z64", "n64", "v64"] }, place: "roms/{name}" });
function n64Game(name: string) {
  const p = w.plan(`N64 Emu ${name}`, "emulator", n64Emu());
  const g = w.game("Banjo-Kazooie", ["N64"], { year: 1998 });
  return { p, g, way: w.way(g, p, banjo()) };
}
/** a download of the game that landed (a fetch done), its file on disk */
function fetchOf(g: GameRow, title: string): { id: number; path: string; title: string } {
  const dir = join(w.dir, "downloads");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${title}.zip`);
  writeFileSync(path, "zip");
  const r = db.query("INSERT INTO fetches (game_id, title, protocol, client, state, local_path, size) VALUES (?,?,?,?,?,?,?) RETURNING id").get(g.id, title, "torrent", "rtorrent", "done", path, 16 * 2 ** 20) as { id: number };
  fetches.push(r.id);
  return { id: r.id, path, title };
}

/** a PC copy of the game members play (a native package), imported now */
function pcCopy(g: GameRow): number {
  const m = { schema: 1, kind: "native", launch: { exe: "Banjo/banjo.exe", args: "", cwd: "" }, files: [{ path: "Banjo/banjo.exe", size: 1000, sha256: "a".repeat(64) }], source: { title: "Banjo-Kazooie-GOG" } };
  const pkg = stmts.insertPackage.get(g.id, null, join(w.dir, "pc-copy"), g.name, null, 1000, JSON.stringify(m)) as { id: number };
  packages.push(pkg.id);
  return pkg.id;
}

describe("an earlier download, read once", () => {
  test("one its content job kept for a look (nothing proves it is the game) is not taken in again: the run asks whether it is the game", async () => {
    const { g, way } = n64Game("Kept Once");
    w.ai.ready = false;                                                    // no held-file round: the run asks at once
    const d = fetchOf(g, "Banjo-Kazooie.N64-GRP");
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    const take = live(run.id, "content");
    expect(w.spec(take)).toMatchObject({ kind: "content", path: d.path, fetchId: d.id, earlier: true });
    // the content job read the whole download and kept its ROM for a look
    const held = w.kept(g, "Banjo-Kazooie (Proto).z64", { source: "indexer", platform: "n64" });
    w.end(take.id, { message: "kept Banjo-Kazooie (Proto).z64 for a look: nothing this way checks proves it is the game", manifest: { outcome: "kept", wayId: way.id, contentId: held.id, file: held.name, why: "nothing this way checks proves it is the game" } });
    r = await w.advance(run.id);
    expect(kinds(run.id, "content").length).toBe(1);
    expect([r.state, serializeRun(r).ask?.code, serializeRun(r).ask?.heldContentId]).toEqual(["asking", "held-file", held.id]);
    // two minutes later (the run looks again by itself): still read only once
    w.clock.t += 120_000;
    r = await w.advance(run.id);
    expect(kinds(run.id, "content").length).toBe(1);
    expect(serializeRun(r).ask?.code).toBe("held-file");
  });

  test("a download the game's own search is still importing is not taken in beside that import: the run waits for it", async () => {
    const { g, way } = n64Game("Importing");
    const d = fetchOf(g, "Banjo-Kazooie.N64-GRP");
    // a member's search for the game: its download landed, its import is queued
    const req = stmts.insertRequest.get(g.id, "add") as RequestRow;
    const imp = stmts.insertJob.get(req.id, d.id, g.id, d.path) as JobRow;
    db.query("UPDATE requests SET state='processing', stage='importing', fetch_id=?, job_id=?, release_json=? WHERE id=?").run(d.id, imp.id, JSON.stringify({ title: d.title }), req.id);
    const run = w.start({ wayId: way.id, by: "backfill" });
    const r = await w.advance(run.id);
    expect(w.children(run.id)).toEqual([]);
    expect(r.state).toBe("waiting");
    expect(texts(run.id).at(-1)).toBe(`waiting for the download of ${g.name} that is already running`);
  });

  test("a download a member's search parked (its import failed and waits for the AI importer) is an earlier download all the same: offered to the way", async () => {
    const { g, way } = n64Game("Parked");
    const d = fetchOf(g, "Banjo-Kazooie.N64-GRP");
    const req = stmts.insertRequest.get(g.id, "add") as RequestRow;
    const imp = stmts.insertJob.get(req.id, d.id, g.id, d.path) as JobRow;
    stmts.setJobFailed.run("failed", "no recipe fits this download: the AI importer could take over", imp.id);
    db.query("UPDATE requests SET state='processing', stage='downloaded, but it needs the AI importer — add an API key under Settings → Importers', fetch_id=?, job_id=? WHERE id=?").run(d.id, imp.id, req.id);
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const take = live(run.id, "content");
    expect(w.spec(take)).toMatchObject({ kind: "content", path: d.path, fetchId: d.id, earlier: true });
    // the way refuses it: that parked search brings nothing more, so the run searches for the way itself — it does not
    // wait for a "download already running" that is not running
    w.end(take.id, { state: "failed", message: "not the game file: Banjo-Kazooie.N64-GRP.zip holds a PC installer", fail: { class: "file" } });
    const r = await w.advance(run.id);
    expect(w.requests.made.length).toBe(1);
    expect(texts(run.id).some(t => /already running/.test(t))).toBe(false);
    expect(r.state).toBe("waiting");
  });

  test("the way's own search whose download just landed is followed, not taken in a second time beside it", async () => {
    const { g, way } = n64Game("Landed");
    const d = fetchOf(g, "Banjo-Kazooie.N64-GRP");
    // the way's search: its download is here, the searcher has not queued its content job yet
    const req = stmts.insertWayRequest.get(g.id, "find-files", way.id) as RequestRow;
    db.query("UPDATE requests SET state='fetching', stage='transferring to ludarr', fetch_id=?, release_json=? WHERE id=?").run(d.id, JSON.stringify({ title: d.title }), req.id);
    const run = w.start({ wayId: way.id, by: "backfill" });
    const r = await w.advance(run.id);
    expect(w.children(run.id)).toEqual([]);
    expect(r.state).toBe("waiting");
    expect(JSON.parse(r.facts_json).requestId).toBe(req.id);
  });
});

describe("a step waiting in the queue says why it waits", () => {
  test("the run's now line is the runner's own words for a queued step, with no progress until it starts", async () => {
    const { g, way } = n64Game("Queued");
    w.kept(g, "banjo.z64", { platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    let r = await w.advance(run.id);
    const asm = live(run.id, "assemble");
    // not started yet (its turn has not come): what it is and that it waits, and no "0 %" for a step that has not begun
    expect(serializeRun(r).now).toMatchObject({ text: "building Banjo-Kazooie through N64 Emu Queued — waiting for its turn", progress: null, jobId: asm.id });
    // the runner keeps it queued and says why (the Builds list shows this line as it is)
    const why = "waiting for scratch space: this build needs about 54 GB and 50 GB kept free on the library, 20 GB will be free once the running make has what it may need";
    stmts.setJob.run("queued", null, 0, why, asm.id);
    r = w.run(run.id);
    expect(serializeRun(r).now).toMatchObject({ text: why, progress: null, jobId: asm.id });
    // running: its own words and its progress, as before
    stmts.setJob.run("running", null, 0.25, "placing the game file · 4 of 16 MB", asm.id);
    expect(serializeRun(w.run(run.id)).now).toMatchObject({ text: "placing the game file · 4 of 16 MB", progress: 0.25, jobId: asm.id });
  });
});

describe("a run that waits says what for", () => {
  test("waiting on a file still arriving in the inbox (no job, no search): its now line says so, not just its phase", async () => {
    const p = w.plan("KytyPS5 Arriving", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"], { year: 2020 });
    const way = w.way(g, p, { ...kytyUpgraded(), make: { ...kytyUpgraded().make!, from: ["kept", "inbox"] as ("kept" | "inbox")[] } }, { check: kytyCheck });
    w.inbox.waiting = 1;                                                   // an entry copied in less than 10 minutes ago
    const run = w.start({ wayId: way.id, by: "backfill" });
    const r = await w.advance(run.id);
    expect(r.state).toBe("waiting");
    expect(serializeRun(r).now).toMatchObject({ text: "a file is arriving in the inbox: it is taken once nothing in it changed for 10 minutes", progress: null, jobId: null });
  });
});

describe("a child's end, read for what it is", () => {
  test("an assemble that would not start because the plan was not ready (the admin edited it meanwhile) sends the run back to the plan: no AI round", async () => {
    const { p, g, way } = n64Game("Edited");
    w.kept(g, "banjo.z64", { platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const asm = live(run.id, "assemble");
    // while it waits in the queue the admin changes the plan: a draft again until it is checked
    updatePlan(p.id, { spec: { ...planSpec(p), notes: "the admin's note" }, status: "draft", statusNote: null });
    w.end(asm.id, { state: "failed", message: "the plan is draft: check it before building", fail: { class: "plan" } });
    const r = await w.advance(run.id);
    expect(w.children(run.id).filter(j => j.kind === "construct")).toEqual([]);
    expect(getPlan(p.id)!.status).toBe("ready");                          // checked again
    const again = live(run.id, "assemble");
    expect(again.id).not.toBe(asm.id);
    expect(r.phase).toBe("build");
  });

  test("an assemble refused because the game came to play another way meanwhile (a PC copy): the replace question is asked at once, not after a 30-minute wait as an error", async () => {
    const { g, way } = n64Game("Replaced");
    w.kept(g, "banjo.z64", { platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const asm = live(run.id, "assemble");
    pcCopy(g);                                                            // a member's search imported a PC copy meanwhile
    w.end(asm.id, { state: "failed", message: "the game already has a PC copy; build with replace to swap it for this way", fail: { class: "other", kind: "replace" } });
    const r = await w.advance(run.id);
    expect([r.state, serializeRun(r).ask?.code, serializeRun(r).ask?.title]).toEqual(["held", "go-ahead", "Build Banjo-Kazooie with N64 Emu Replaced?"]);
    expect(texts(run.id).some(t => /trying again at/.test(t))).toBe(false);
    // the admin says go: built at once, over the PC copy (no wait left over from the refusal)
    intend(run.id, { kind: "answer", answer: { go: true } });
    await w.advance(run.id);
    expect(w.spec(live(run.id, "assemble"))).toEqual({ kind: "assemble", wayId: way.id, replace: true, runId: run.id });
  });

  test("an assemble refused because a need of the plan is missing (its BIOS removed while the build waited) asks for the need: the game file is not refused, and once the BIOS is back that file is built", async () => {
    const spec = { ...n64Emu(), needs: [{ kind: "bios" as const, name: "N64 BIOS", place: "bios/pif.rom", accept: { formats: ["rom"] } }] };
    const p = w.plan("N64 Emu Needs", "emulator", spec);
    const g = w.game("Banjo-Kazooie", ["N64"], { year: 1998 });
    const way = w.way(g, p, banjo());
    const file = w.kept(g, "banjo.z64", { platform: "n64" });
    writeFileSync(join(w.dir, "pif.rom"), "pif");
    const bios = () => insertContent({ planId: p.id, needIndex: 0, role: "system", name: "pif.rom", path: join(w.dir, "pif.rom"), size: 3, hashes: { sha1: "1".repeat(40) }, source: "upload" });
    const b = bios();
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const asm = live(run.id, "assemble");
    db.query("DELETE FROM contents WHERE id=?").run(b.id);                 // the admin removed it meanwhile
    w.end(asm.id, { state: "failed", message: "needs N64 BIOS — add it on the plan", fail: { class: "file" } });
    let r = await w.advance(run.id);
    expect([r.phase, r.state, serializeRun(r).ask?.code]).toEqual(["build", "asking", "needs"]);
    expect(JSON.parse(r.facts_json).refusedFiles ?? []).toEqual([]);
    expect(w.requests.made).toEqual([]);                                  // no search for another game file
    // the BIOS is back: the same game file is built
    bios();
    w.clock.t += 3_600_000;
    r = await w.advance(run.id);
    expect(live(run.id, "assemble").id).not.toBe(asm.id);
    expect(getWay(way.id)!.content_id).toBe(file.id);
    db.query("DELETE FROM contents WHERE plan_id=?").run(p.id);
  });
});

describe("an answer that lands while the run is looking", () => {
  test("Stop pressed while the run reads the inbox: the search it was about to start is never left looking on its own", async () => {
    const { g, way } = n64Game("Stop Race");
    let open!: () => void;
    const gate = new Promise<void>(res => { open = res; });
    const inner = crdeps.intakeInbox;
    crdeps.intakeInbox = async (gg, runId) => { await gate; return inner(gg, runId); };
    const run = w.start({ wayId: way.id, by: "backfill" });
    const a = advanceRun(run.id);
    await Bun.sleep(5);
    intend(run.id, { kind: "stop", why: "you stopped it" });               // the admin's Stop, while the inbox is read
    open();
    await a;
    await w.advance(run.id);
    await Bun.sleep(5);
    expect(getRun(run.id)!.state).toBe("stopped");
    const looking = db.query("SELECT id FROM requests WHERE game_id=? AND state IN ('requested','matching','fetching','processing')").all(g.id);
    expect(looking).toEqual([]);
  });

  test("Stop pressed while the run looks up the game a plan plays: the game is not added to the library (it would be searched for and downloaded)", async () => {
    const p = w.plan("Zelda Stop Race", "recomp", zeldaPlan(true));
    let open!: () => void;
    const gate = new Promise<void>(res => { open = res; });
    const added: unknown[] = [];
    atdeps.lookup = async () => { await gate; return [{ id: { scheme: "igdb", value: "1030" }, name: "The Legend of Zelda: Majora's Mask", year: 2000, platforms: ["N64"], cover: null, summary: null, source: "igdb", gameId: null, status: null }]; };
    atdeps.addGame = async body => { added.push(body); return { id: w.game("The Legend of Zelda: Majora's Mask", ["N64"], { year: 2000, igdbId: 1030 }).id } as never; };
    const run = w.start({ planId: p.id, by: "admin", draft: mmDraft() });
    const a = advanceRun(run.id);
    await Bun.sleep(5);
    intend(run.id, { kind: "stop", why: "you stopped it" });
    open();
    await a;
    await w.advance(run.id);
    expect(getRun(run.id)!.state).toBe("stopped");
    expect(added).toEqual([]);
  });
});

describe("a build the run already made is not made again", () => {
  test("the program built for this game, and the assemble still says it needs that build: no second build (hours, gigabytes), the run says so and asks", async () => {
    const { g, way } = n64Game("Built Twice");
    w.kept(g, "banjo.z64", { platform: "n64" });
    crdeps.wayBuildNeeded = () => true;                                    // whatever was built, the check keeps saying yes
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const build = live(run.id, "build");
    w.end(build.id, { message: "built N64 Emu Built Twice for Banjo-Kazooie (2.1 GB kept)" });
    await w.advance(run.id);
    const asm = live(run.id, "assemble");
    w.end(asm.id, { state: "failed", message: "its program has to be built for this game first (a build job does that, then the way is built)", fail: { class: "other", kind: "needs-build" } });
    let r = await w.advance(run.id);
    expect(kinds(run.id, "build").length).toBe(1);
    // looked at again later, it still does not build it a second time: it asks with the words
    w.clock.t += 31 * 60_000;
    r = await w.advance(run.id);
    const asm2 = w.live(run.id);
    if (asm2?.kind === "assemble") { w.end(asm2.id, { state: "failed", message: "its program has to be built for this game first (a build job does that, then the way is built)", fail: { class: "other", kind: "needs-build" } }); r = await w.advance(run.id); }
    expect(kinds(run.id, "build").length).toBe(1);
    expect([r.state, serializeRun(r).ask?.code]).toEqual(["asking", "env"]);
  });
});

describe("an ask that says it tries again does", () => {
  test("a ludarr error asked about after its second failure is tried again by itself the next day, as the ask says", async () => {
    const { g, way } = n64Game("Daily");
    w.kept(g, "banjo.z64", { platform: "n64" });
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const oops = (id: number) => w.end(id, { state: "failed", message: "the way's file store did not answer", fail: { class: "other" } });
    oops(live(run.id, "assemble").id);
    let r = await w.advance(run.id);
    w.clock.t = r.next_at! * 1000;                                         // thirty minutes later: once more
    r = await w.advance(run.id);
    oops(live(run.id, "assemble").id);
    r = await w.advance(run.id);
    const a = serializeRun(r).ask!;
    expect([r.state, a.code]).toEqual(["asking", "env"]);
    expect(a.need).toMatch(/ludarr tries again by itself (tomorrow )?at \d\d:\d\d/);
    // the next day: tried again, by itself
    w.clock.t = r.next_at! * 1000;
    r = await w.advance(run.id);
    expect(kinds(run.id, "assemble").length).toBe(3);
    expect(w.live(run.id)?.kind).toBe("assemble");
  });
});

describe("the AI's budget is spent on what it has not seen", () => {
  test("an upgrade round that could not add a check is not run again for the same gap each time the content plan changes", async () => {
    const p = w.plan("KytyPS5 Seen", "emulator", kytyPlan());
    const g = w.game("Demon's Souls", ["PS5"], { year: 2020 });
    const way = w.way(g, p, kytyWay());
    const run = w.start({ wayId: way.id, by: "backfill" });
    await w.advance(run.id);
    const round = live(run.id, "construct");
    const brief = (w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!;
    expect(brief.failure).toContain("the plan runs no check on the server before the package is offered (check)");
    // the round turns the words into data and adds the make, but finds no check this program can run without a GPU
    w.round(round.id, { edit: () => updateWay(way.id, { content: kytyUpgraded() }), changed: ["content"] });
    await w.advance(run.id);
    expect(kinds(run.id, "construct").length).toBe(1);
    // later the content plan changes (a search term, an accepted file): the same gap alone calls for no second round
    updateWay(way.id, { content: { ...kytyUpgraded(), terms: ["PPSA01341", "Demons Souls PS5"] } });
    w.clock.t += 120_000;
    await w.advance(run.id);
    expect(kinds(run.id, "construct").length).toBe(1);
  });
});

describe("an emulator from ludarr's own list", () => {
  test("it is data already: its ways get no upgrade round, though the plan runs no check; the same plan from another repo is asked about once, as before", async () => {
    const spec = step0For("ares-emulator/ares", null, "snes")!.spec as unknown as RuntimePlanSpec;
    const own = w.plan("ares (SNES)", "emulator", spec, { repo: "ares-emulator/ares" });
    const run = w.start({ wayId: w.way(w.game("Super Mario World", ["SNES"], { year: 1990 }), own).id, by: "way" });
    await w.advance(run.id);
    expect(kinds(run.id, "construct")).toEqual([]);
    expect(texts(run.id).join(" ")).not.toMatch(/the AI/);
    const theirs = w.plan("Their SNES emulator", "emulator", spec, { repo: "someone/snes-emu" });
    const run2 = w.start({ wayId: w.way(w.game("Chrono Trigger", ["SNES"], { year: 1995 }), theirs).id, by: "way" });
    await w.advance(run2.id);
    expect(kinds(run2.id, "construct").length).toBe(1);
    expect((w.spec(live(run2.id, "construct")) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("upgrade");
  });
});

describe("how a run ends", () => {
  test("a way built by a build the run did not follow (the admin's press while it was held): its last step names that build, so the run's check is shown", async () => {
    const { g, way } = n64Game("Built Elsewhere");
    w.kept(g, "banjo.z64", { platform: "n64" });
    // the admin's Build, run and done before the run looks
    const asm = crdeps.enqueueJob({ kind: "assemble", wayId: way.id, auto: true }, { gameId: g.id });
    w.built(asm.id, PASS_CHECK);
    const run = w.start({ wayId: way.id, by: "admin" });
    const r = await w.advance(run.id);
    expect(r.state).toBe("done");
    const last = w.steps(run.id).at(-1)!;
    expect(last).toMatchObject({ text: "built: Banjo-Kazooie is ready for members to install; checked: the game's own self-test passed", jobId: asm.id });
    expect(checkJobOf(w.steps(run.id))).toBe(asm.id);                     // the admin UI reads the check from that job
  });
});

describe("one press of Build", () => {
  test("a way whose program is built for each game, its file still the game's copy, its run held for the replace question: the build the assemble stopped for is queued, then the assemble — no second press", async () => {
    const NUP = "The Legend of Zelda Ocarina of Time [0400486024DEC000][v131072].nup";
    const p = w.plan("NX2navi Press", "recomp", { ...nx2naviOnServer(), content: nx2naviContent() });
    const g = w.game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"], { year: 2026 });
    const way = w.way(g, p);
    // game 48 as it is: a PC copy (the Lichii emulator) with the .nup inside it, which the upgraded plan proves
    const m = { schema: 1, kind: "native", launch: { exe: "Emulator (Lichii nx2 build 88)/lichii.exe", args: "", cwd: "" }, files: [{ path: NUP, size: 25_020_741_061, sha256: "b".repeat(64) }], source: { title: "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp" } };
    const pkg = (stmts.insertPackage.get(g.id, null, join(w.dir, "oot-lichii"), g.name, null, 26_440_000_000, JSON.stringify(m)) as { id: number }).id;
    packages.push(pkg);
    w.copy.facts.set(g.id, copyFactsOf({ packageId: pkg, kind: "native", rel: NUP, path: join(w.dir, "oot-lichii", NUP), shape: "file", size: 25_020_741_061, identity: { platform: "switch", serial: "0400486024DEC000", shape: "nup" } }));
    w.copy.serves.set(g.id, { serves: "direct", why: "the game file this way takes (its title id 0400486024DEC000 is one the way accepts)", block: null });
    // as build.ts says: there is nothing to build with until the game file is the way's
    crdeps.wayBuildNeeded = (_p, wy) => getWay(wy.id)?.content_id != null;
    const run = w.start({ wayId: way.id, by: "backfill" });
    expect((await w.advance(run.id)).state).toBe("held");
    // the admin presses Build (replace) on the way card instead of answering the question
    const res = await waysApi.request(`/api/v1/way/${way.id}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace: true }) });
    expect(res.status).toBe(202);
    const asm = (await res.json()).job as { id: number; spec: unknown };
    expect(asm.spec).toEqual({ kind: "assemble", wayId: way.id, replace: true });
    // the assemble takes the copy in (the way's file now), then stops: its program is built for this game first
    const nup = w.kept(g, NUP, { source: "package", platform: "switch", size: 25_020_741_061 });
    updateWay(way.id, { contentId: nup.id });
    w.end(asm.id, { state: "failed", message: "its program has to be built for this game first (a build job does that, then the way is built)", fail: { class: "other", kind: "needs-build" } });
    const builds = (db.query("SELECT spec_json FROM jobs WHERE game_id=? AND kind='build'").all(g.id) as { spec_json: string }[]).map(j => JSON.parse(j.spec_json));
    expect(builds).toEqual([{ kind: "build", planId: p.id, wayId: way.id, then: "assemble", replace: true }]);
    // that build ends and queues its assemble; should the assemble still say the build is missing, no second build follows
    // (whatever the check says, the same file is never built again and again)
    const build = db.query("SELECT id FROM jobs WHERE game_id=? AND kind='build'").get(g.id) as { id: number };
    w.end(build.id, { message: "built NX2navi for The Legend of Zelda: Ocarina of Time (24.1 GB kept)" });
    const again = crdeps.enqueueJob({ kind: "assemble", wayId: way.id, replace: true }, { gameId: g.id });
    w.end(again.id, { state: "failed", message: "its program has to be built for this game first (a build job does that, then the way is built)", fail: { class: "other", kind: "needs-build" } });
    expect((db.query("SELECT COUNT(*) AS n FROM jobs WHERE game_id=? AND kind='build'").get(g.id) as { n: number }).n).toBe(1);
  });
});
