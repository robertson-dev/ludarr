/**
 * The cases the carry run must finish, as the admin would see them (DESIGN3 "The three live cases"), and the zero-touch
 * run end to end: a plan a construct job saves reaches 'done' with no admin call. Fakes stand in for the copy's judge, the
 * inbox, the AI and the indexers (tests/carry-world.ts); the run, its words and its rows are the real ones.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { db, kv, stmts, type GameRow, type RequestRow } from "../src/db";
import { cadeps, carryApi } from "../src/ways/carry-api";
import { atdeps } from "../src/ways/attach";
import { askdeps } from "../src/ways/asks";
import { clockWords } from "../src/ways/asks";
import { crdeps, ensureRuns, getRun, intend, serializeRun, type RunRow } from "../src/ways/carry";
import { getPlan, getWay, planSpec, updatePlan, updateWay, waysOfPlan } from "../src/ways/store";
import type { JobSpec, RuntimePlanSpec } from "../src/ways/types";
import {
  DEMONS_SOULS, DS_VERSIONS, ENV_CHECK, GB, intake, kytyCheck, kytyMake, kytyPlan, kytyUpgraded, kytyWay, MM_SHA1, mmDraft, nx2navi, nx2naviContent, nx2naviOnServer,
  PASS_CHECK, SEALED, sha256, world, zeldaPlan, type World,
} from "./carry-world";
import { copyFactsOf } from "./fakes-w3";

let w: World;
const realAt = { ...atdeps }, realAsk = { ...askdeps }, realCa = { ...cadeps };
const extra = { packages: [] as number[], fetches: [] as number[] };
beforeEach(() => { w = world(); kv.set("cfg.LIBRARY_SHARE_PATH", "\\\\tower\\games\\ahoy"); });
afterEach(() => {
  for (const id of extra.fetches.splice(0)) db.query("DELETE FROM fetches WHERE id=?").run(id);
  for (const id of extra.packages.splice(0)) db.query("DELETE FROM packages WHERE id=?").run(id);
  w.cleanup(); Object.assign(atdeps, realAt); Object.assign(askdeps, realAsk); Object.assign(cadeps, realCa); kv.del("cfg.LIBRARY_SHARE_PATH");
});

const live = (runId: number, kind: string) => { const j = w.live(runId); expect(j?.kind).toBe(kind); return j!; };
const runOf = (planId: number) => db.query("SELECT * FROM carry_runs WHERE plan_id=? ORDER BY id DESC LIMIT 1").get(planId) as RunRow;
const texts = (runId: number) => w.steps(runId).map(s => s.text);
const HINT = "(The folder starts with a dot, so Windows may hide it: type the path in Explorer's address bar.)";

describe("Demon's Souls: way 1 through KytyPS5", () => {
  test("the copy judged sealed in place, nothing copied; widened; asked with the exact words; watching; a dump in the inbox carries it to done", async () => {
    const p = w.plan("KytyPS5 (chenxiao07 Demon's Souls fork)", "emulator", kytyPlan(), { repo: "chenxiao07/KytyPS5" });
    const g = w.game("Demon's Souls", ["PS5"], { year: 2020 });
    const way = w.way(g, p, kytyWay());
    const ISO = 54.2 * GB, SUM = sha256("bbb-ps5-01342.iso bytes");
    const pkg = w.romPackage(g, "bbb-ps5-01342/bbb-ps5-01342.iso", { size: ISO, platform: "ps5", sha256: SUM, title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]" });
    // content row 1: a second copy of the same disc, kept by the hand-over the user's Build ran
    const row1 = w.kept(g, "bbb-ps5-01342.iso", { source: "package", size: ISO, platform: "ps5", sha256: SUM });
    crdeps.inboxDir = () => "/library/.ahoy-inbox/demons-souls";
    // judged in place: small reads say what the disc is; nothing is copied to tell
    crdeps.judgeCopy = async gameId => {
      w.copy.judged.push(gameId);
      w.copy.facts.set(g.id, copyFactsOf({ packageId: pkg, rel: "bbb-ps5-01342/bbb-ps5-01342.iso", path: "/library/demons-souls/bbb-ps5-01342/bbb-ps5-01342.iso", shape: "file", size: ISO, mtime: 1, sha256: SUM,
        identity: { platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", region: "US", sealed: true, shape: "bd-image", category: "game" }, markers: [], judgedAt: 1 }));
      w.copy.serves.set(g.id, { serves: "no", why: SEALED });
      return w.copy.facts.get(g.id)!;
    };
    const run = w.start({ wayId: way.id, by: "backfill" });
    // 1. the upgrade round first: a .zar only ZArchive makes, and no check
    let r = await w.advance(run.id);
    let round = live(run.id, "construct");
    let brief = (w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!;
    expect(brief.phase).toBe("upgrade");
    expect(brief.failure).toContain("it takes a .zar file, which is packed from the game folder with ZArchive");
    expect(brief.failure).toContain("the plan runs no check on the server before the package is offered (check)");
    expect(r.phase).toBe("file");
    w.round(round.id, { edit: () => updateWay(way.id, { content: kytyUpgraded(), overrides: { check: kytyCheck } }), changed: ["content", "check"], message: "the way takes the app0 folder packed into one .zar; the three editions and two versions the code names; the shader check" });
    // 2. the copy: judged in place (sealed), said once, its release kept off the searches; the kept second copy not used
    r = await w.advance(run.id);
    expect(w.copy.judged).toEqual([g.id]);
    expect(texts(run.id)).toContain(`The copy on the server (bbb-ps5-01342.iso, 54.2 GB) is ${SEALED}: nothing is copied from it`);
    expect(w.steps(run.id).find(s => s.text.startsWith("The copy on the server"))!.proof).toBe("PPSA01342, 01.00, US, sealed");
    expect(w.children(run.id).filter(j => j.kind !== "construct")).toEqual([]);                   // nothing copied, nothing made
    const block = db.query("SELECT * FROM blocklist WHERE game_id=? AND way_id=?").get(g.id, way.id) as { title: string; class: string; plan_digest: string };
    expect(block).toMatchObject({ title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]", class: "identity" });
    expect(block.plan_digest).toMatch(/^[0-9a-f]{64}$/);
    // 3. the indexers: searched, nothing usable — the widen round, then the search starts over from scratch
    expect(w.requests.made.length).toBe(1);
    const req = w.requests.made[0];
    expect(r.state).toBe("waiting");
    const later = Math.floor(w.clock.t / 1000) + 6 * 3600;
    w.setRequest(req, { state: "requested", stage: "no usable copy yet — searching again in 6h", next_try_at: later });
    r = await w.advance(run.id);
    round = live(run.id, "construct");
    brief = (w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!;
    expect(brief).toMatchObject({ phase: "widen", round: 2, rounds: 3, copy: { name: "bbb-ps5-01342.iso", serves: "no", why: SEALED }, searched: { names: ["Demon's Souls"], looked: 1 } });
    w.round(round.id, { edit: () => updateWay(way.id, { content: { ...kytyUpgraded(), what: "Demon's Souls at 1.05 or 1.07" } }), changed: ["content"], message: "the program also takes PPSA01340 and PPSA01342 at 01.005.000 (demonsSouls.h:13-26)" });
    r = await w.advance(run.id);
    expect(w.requests.retried).toEqual([req]);
    expect(r.state).toBe("waiting");
    w.setRequest(req, { state: "requested", stage: "no usable copy yet — searching again in 6h", next_try_at: later });
    // 4. still nothing: asked, in words made from the plan and the verdicts, and still watching
    r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    const a = serializeRun(r).ask!;
    expect(a).toMatchObject({ code: "file", title: "Demon's Souls needs its game data", canUpload: false, inbox: "/library/.ahoy-inbox/demons-souls", inboxShare: "\\\\tower\\games\\ahoy\\.ahoy-inbox\\demons-souls\\" });
    expect(a.need).toBe(`KytyPS5 (chenxiao07 Demon's Souls fork) plays Demon's Souls at 1.05 or 1.07. It takes the game folder dumped from a console (holding sce_sys/param.json and eboot.bin), or that folder packed as one .zar, of Demon's Souls (PlayStation 5) — PPSA01341, PPSA01342 or PPSA01340, version 01.005.000 or 01.007.000. Put it in \\\\tower\\games\\ahoy\\.ahoy-inbox\\demons-souls\\ (on the server: /library/.ahoy-inbox/demons-souls/), or pick it on the server: ludarr takes it from there and finishes by itself. ${HINT}`);
    expect(a.tried).toEqual([
      `The copy on the server (bbb-ps5-01342.iso, 54.2 GB) is ${SEALED}.`,
      "bbb-ps5-01342.iso, kept on the server, is the same bytes as that copy: not used.",
      `The indexers have nothing it can use yet. Looking again at ${clockWords(later)}.`,
    ]);
    expect(a.watching).toEqual({ nextSearchAt: later, inbox: true, every: "2 minutes" });
    expect(r.next_at).toBe(Math.floor(w.clock.t / 1000) + 120);
    expect(getRun(run.id)!.rounds).toBe(2);
    // the kept second copy is still the one row, never copied again
    expect((db.query("SELECT COUNT(*) AS n FROM contents WHERE game_id=?").get(g.id) as { n: number }).n).toBe(1);
    // 5. two minutes later a dump is in the inbox: taken in, made into one .zar, built, checked, done
    w.clock.t += 120_000;
    w.inbox.next = ["/library/.ahoy-inbox/demons-souls/PPSA01341-app0"];
    r = await w.advance(run.id);
    const take = live(run.id, "content");
    expect(w.spec(take)).toEqual({ kind: "content", gameId: g.id, path: "/library/.ahoy-inbox/demons-souls/PPSA01341-app0", inbox: true, runId: run.id });
    expect([r.state, serializeRun(r).ask]).toEqual(["waiting", null]);
    expect(texts(run.id).at(-1)).toBe("PPSA01341-app0 landed in the inbox: taking it in");
    const dump = w.kept(g, "PPSA01341-app0", { source: "inbox", shape: "folder", platform: "ps5", size: 83 * GB });
    w.end(take.id, { message: "kept PPSA01341-app0 (83.0 GB): what the way's file is made from", manifest: intake("PPSA01341-app0", dump.id, { inputFor: [way.id] }) });
    crdeps.inputMatches = (_i, row) => (row.id === dump.id ? { ok: true, why: null } : { ok: false, why: SEALED });
    r = await w.advance(run.id);
    const make = live(run.id, "make");
    expect(w.spec(make)).toEqual({ kind: "make", wayId: way.id, from: "kept", contentId: dump.id, then: "assemble", auto: true, runId: run.id });
    const { assemble } = w.made(make.id, { name: "PPSA01341-app0.zar", serial: "PPSA01341", version: "01.007.000" });
    r = await w.advance(run.id);
    expect([r.phase, JSON.parse(r.step_json!).job]).toEqual(["build", assemble.id]);
    w.built(assemble.id, { ...ENV_CHECK, text: "the emulator reads the packed game; not started here: the server has no graphics device" });
    r = await w.advance(run.id);
    expect(r.state).toBe("done");
    expect(texts(run.id).at(-1)).toBe("built: Demon's Souls is ready for members to install; the emulator reads the packed game; not started here: the server has no graphics device");
    expect(row1.id).toBeGreaterThan(0);
  });
});

describe("NX2navi: attached to game 48 (Switch 2)", () => {
  test("attached by names and platform, the build moved to the server, the plan made data, the .nup asked at once — and the download already running waited for", async () => {
    const oot64 = w.game("The Legend of Zelda: Ocarina of Time", ["N64"], { year: 1998 });
    const g48 = w.game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"], { year: 2026, igdbId: 990_048 });
    const p = w.plan("NX2navi", "recomp", nx2navi(), { repo: "tangerineturtle1/NX2navi" });
    // a member's ordinary search for game 48 is downloading something already
    const ord = stmts.insertRequest.get(g48.id, "add") as RequestRow;
    db.query("UPDATE requests SET state='fetching', stage='downloading · 12 MB/s', release_json=? WHERE id=?").run(JSON.stringify({ title: "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp" }), ord.id);
    crdeps.inboxDir = gg => `/library/.ahoy-inbox/${gg.slug}`;
    askdeps.sizeRange = plat => (plat === "switch" ? [64 * 2 ** 20, 64 * GB] : null);
    expect(await ensureRuns()).toBe(1);
    const run = runOf(p.id);
    expect(run).toMatchObject({ game_id: g48.id, state: "active", started_by: "backfill" });
    // the server-build round: the build players' PCs would run moves to the server
    let r = await w.advance(run.id);
    let round = live(run.id, "construct");
    let brief = (w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!;
    expect(brief.phase).toBe("server-build");
    expect(brief.failure).toStartWith("firstRun says the game is made on the player's PC");
    w.round(round.id, { edit: () => updatePlan(p.id, { spec: nx2naviOnServer() }), changed: ["program", "launch", "content", "firstRun", "check"] });
    // the way on game 48 — never the N64 one — and the upgrade round: the ids in words made data, who makes the .nup
    r = await w.advance(run.id);
    const way = waysOfPlan(p.id)[0];
    expect(way.game_id).toBe(g48.id);
    expect(JSON.parse(r.facts_json).serverBuild).toBe("moved to the server");
    round = live(run.id, "construct");
    brief = (w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!;
    expect(brief.phase).toBe("upgrade");
    expect(brief.failure).toContain("what names the title id 0400486024DEC000, which accept.serials does not list");
    expect(brief.failure).toContain("what names the build e0f3ccfa, which accept.builds does not list");
    expect(brief.failure).toContain("it takes a .nup file, which is made by Eglantine on the console");
    w.round(round.id, { edit: () => updatePlan(p.id, { spec: { ...nx2naviOnServer(), content: nx2naviContent() } }), changed: ["content"] });
    // asked at once (only its owner can make a .nup), while the download already running is waited for: no second one
    r = await w.advance(run.id);
    expect(r.state).toBe("asking");
    expect(w.requests.made).toEqual([]);
    const a = serializeRun(r).ask!;
    const inbox = `/library/.ahoy-inbox/${g48.slug}`;
    expect(a).toMatchObject({ code: "file", title: "The Legend of Zelda: Ocarina of Time needs its game data", canUpload: false, inbox, watching: { nextSearchAt: null, inbox: true, every: "2 minutes" } });
    expect(a.need).toBe(`NX2navi plays The Legend of Zelda: Ocarina of Time (Switch 2) with the 1.1.1 update. It takes one .nup file of The Legend of Zelda: Ocarina of Time (Switch) — 0400486024DEC000, version 1.1.1, build e0f3ccfaf50065ae4ea01eb5aeb13b1a. It comes from your own console: Eglantine on your Switch 2 makes it. Put it in \\\\tower\\games\\ahoy\\.ahoy-inbox\\${g48.slug}\\ (on the server: ${inbox}/), or pick it on the server: ludarr takes it from there and finishes by itself. ${HINT}`);
    expect(a.tried).toEqual([
      "A download of The Legend of Zelda: Ocarina of Time is already running (The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp): ludarr looks at what it brings as soon as it lands.",
      "The indexers are not searched now: a download of The Legend of Zelda: Ocarina of Time is already running.",
    ]);
    // the download lands: an NSP the way cannot take; judged and said — and no search of the way's own starts for data only
    // its owner can make (it would fetch the same kind of copy again); the ask stays
    db.query("UPDATE requests SET state='ready', stage='imported' WHERE id=?").run(ord.id);
    w.romPackage(g48, "OoT.nsp", { size: 16 * GB, platform: "switch", title: "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp" });
    w.copy.serves.set(g48.id, { serves: "no", why: "a .nsp file, and this needs .nup" });
    w.clock.t += 120_000;
    r = await w.advance(run.id);
    expect(texts(run.id)).toContain("The copy on the server (OoT.nsp, 16.0 GB) is a .nsp file, and this needs .nup: nothing is copied from it");
    expect(w.requests.made).toEqual([]);
    expect(r.state).toBe("asking");
    const b = serializeRun(r).ask!;
    expect(b.tried).toEqual(["The copy on the server (OoT.nsp, 16.0 GB) is a .nsp file, and this needs .nup.", "The indexers are not searched now: only its owner can make this game data (Eglantine on your Switch 2), and they hold it in no form ludarr takes."]);
    expect(b.watching!.nextSearchAt).toBeNull();
    expect(oot64.id).not.toBe(g48.id);
    expect(getWay(way.id)!.game_id).toBe(g48.id);
  });
});

describe("NX2navi on game 48 as it is now: package 42, the Lichii emulator's PC copy, holds the .nup", () => {
  const NUP = "The Legend of Zelda Ocarina of Time [0400486024DEC000][v131072].nup";
  const UNPROVEN = "a .nup file in the game's PC copy that nothing this way checks can prove is the game";
  /** game 48 with package 42 (kind native, launch Lichii) and the plan as it is live (built on players' PCs, words only) */
  function game48() {
    const g48 = w.game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"], { year: 2026, igdbId: 990_048 });
    const p = w.plan("NX2navi", "recomp", nx2navi(), { repo: "tangerineturtle1/NX2navi" });
    const m = { schema: 1, kind: "native", launch: { exe: "Emulator (Lichii nx2 build 88)/lichii.exe", args: "", cwd: "" }, source: { title: "The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp" },
      files: [{ path: "Emulator (Lichii nx2 build 88)/lichii.exe", size: 40_000, sha256: "a".repeat(64) }, { path: NUP, size: 25_020_741_061, sha256: "b".repeat(64) }] };
    const pkg = (stmts.insertPackage.get(g48.id, null, join(w.dir, "oot-lichii"), g48.name, null, 26_440_000_000, JSON.stringify(m)) as { id: number }).id;
    extra.packages.push(pkg);
    // judged in place: the .nup is the one piece of console game data in it; the plan as it is proves nothing yet
    w.copy.facts.set(g48.id, copyFactsOf({ packageId: pkg, kind: "native", rel: NUP, path: join(w.dir, "oot-lichii", NUP), shape: "file", size: 25_020_741_061, identity: { platform: "switch", serial: "0400486024DEC000", shape: "nup" } }));
    w.copy.serves.set(g48.id, { serves: "no", why: UNPROVEN, block: null });
    return { g48, p, pkg };
  }

  test("held with the replace question; go: the build moves to the server, the plan made data, the .nup taken from the PC copy with no download, built for the game, assembled with replace, done", async () => {
    const { g48, p } = game48();
    expect(await ensureRuns()).toBe(1);
    const run = runOf(p.id);
    let r = await w.advance(run.id);
    const way = waysOfPlan(p.id)[0];
    expect(way.game_id).toBe(g48.id);
    expect([r.state, r.phase]).toEqual(["held", "game"]);
    const a = serializeRun(r).ask!;
    expect(a).toMatchObject({ code: "go-ahead", title: "Build The Legend of Zelda: Ocarina of Time with NX2navi?" });
    expect(a.need).toBe(`The Legend of Zelda: Ocarina of Time already plays through its PC copy (lichii.exe). Should ludarr build NX2navi for it instead? Building it replaces the PC copy: its files are removed, and members install the NX2navi build in its place. Nothing changes until you say so. ${NUP} (25.0 GB) on the server may be its game file: ludarr takes it once NX2navi proves it is the game, before anything is downloaded.`);
    expect([w.children(run.id), w.requests.made]).toEqual([[], []]);              // no AI round, no search before the answer
    // go: from the plan again — the build players' PCs would run moves to the server first
    intend(run.id, { kind: "answer", answer: { go: true } });
    r = await w.advance(run.id, 1);
    expect([r.state, r.phase]).toEqual(["active", "plan"]);
    r = await w.advance(run.id);
    let round = live(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("server-build");
    w.round(round.id, { edit: () => updatePlan(p.id, { spec: nx2naviOnServer() }), changed: ["program", "launch", "content", "firstRun", "check"] });
    // the upgrade round: the program id and build in words made data
    r = await w.advance(run.id);
    expect(JSON.parse(r.facts_json).serverBuild).toBe("moved to the server");
    round = live(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!).toMatchObject({ phase: "upgrade", copy: { name: NUP, serves: "no", why: UNPROVEN } });
    w.round(round.id, { edit: () => updatePlan(p.id, { spec: { ...nx2naviOnServer(), content: nx2naviContent() } }), changed: ["content"] });
    // its title id and build now prove the .nup in the PC copy: taken by a link through the content job, nothing downloaded
    w.copy.serves.set(g48.id, { serves: "direct", why: "the game file this way takes (its title id 0400486024DEC000 is one the way accepts)", block: null });
    r = await w.advance(run.id);
    const take = live(run.id, "content");
    expect(w.spec(take)).toEqual({ kind: "content", gameId: g48.id, wayId: way.id, fromCopy: true, runId: run.id });
    const nup = w.kept(g48, NUP, { source: "package", platform: "switch", size: 25_020_741_061 });
    db.query("UPDATE contents SET identity_json=? WHERE id=?").run(JSON.stringify({ platform: "switch", serial: "0400486024DEC000", build: "e0f3ccfaf50065ae4ea01eb5aeb13b1a", version: "1.1.1", shape: "nup" }), nup.id);
    updateWay(way.id, { contentId: nup.id });
    w.end(take.id, { message: `${NUP} is the game file of NX2navi now (taken from the game's copy)`, manifest: { fromCopy: true, wayId: way.id, contentId: nup.id } });
    // the program built for this game first (no assemble of its own: the run queues the one that replaces the PC copy)
    let built = false;
    crdeps.wayBuildNeeded = () => !built;
    r = await w.advance(run.id);
    const build = live(run.id, "build");
    expect(w.spec(build)).toEqual({ kind: "build", planId: p.id, wayId: way.id, runId: run.id });
    built = true;
    w.end(build.id, { message: "built NX2navi for The Legend of Zelda: Ocarina of Time (24.1 GB kept)" });
    r = await w.advance(run.id);
    const asm = live(run.id, "assemble");
    expect(w.spec(asm)).toEqual({ kind: "assemble", wayId: way.id, replace: true, runId: run.id });
    w.built(asm.id, PASS_CHECK);
    r = await w.advance(run.id);
    expect(r.state).toBe("done");
    expect(texts(run.id).at(-1)).toBe("built: The Legend of Zelda: Ocarina of Time is ready for members to install; checked: the game's own self-test passed");
    expect(w.requests.made).toEqual([]);
  });

  test("not now: stopped; the PC copy, the plan and its way are as they were", async () => {
    const { g48, p, pkg } = game48();
    await ensureRuns();
    const run = runOf(p.id);
    expect((await w.advance(run.id)).state).toBe("held");
    intend(run.id, { kind: "answer", answer: { go: false } });
    const r = await w.advance(run.id, 1);
    expect(r.state).toBe("stopped");
    expect(texts(run.id).at(-1)).toBe("stopped: you said not now: nothing was removed, and the game plays as it did");
    expect([stmts.packageById.get(pkg) != null, getPlan(p.id) != null, waysOfPlan(p.id).map(x => x.game_id)]).toEqual([true, true, [g48.id]]);
    expect(w.children(run.id)).toEqual([]);
  });
});

describe("Demon's Souls: way 1, and the v1.004 download still on the seedbox", () => {
  test("the copy refused sealed; the earlier v1.004 RAR offered before any search, read where it is; out of room, the ask names the kept second copy; freed, the RAR is taken again and made, built, done", async () => {
    const p = w.plan("KytyPS5 (chenxiao07 Demon's Souls fork)", "emulator", kytyPlan(), { repo: "chenxiao07/KytyPS5" });
    const g = w.game("Demon's Souls", ["PS5"], { year: 2020 });
    const way = w.way(g, p, kytyWay());
    const ISO = 54.2 * GB, SUM = sha256("bbb-ps5-01342.iso bytes"), FILE = "bbb-ps5-01342/bbb-ps5-01342.iso";
    const BBB = "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]";
    const pkg = w.romPackage(g, FILE, { size: ISO, platform: "ps5", sha256: SUM, title: BBB });
    const row1 = w.kept(g, "bbb-ps5-01342.iso", { source: "package", size: ISO, platform: "ps5", sha256: SUM, bytes: "dump" });
    w.copy.facts.set(g.id, copyFactsOf({ packageId: pkg, rel: FILE, path: join(w.dir, "packages", String(g.id), FILE), shape: "file", size: ISO, sha256: SUM, contentId: row1.id,
      identity: { platform: "ps5", serial: "PPSA01342", masterVersion: "01.00", region: "US", sealed: true, shape: "bd-image", category: "game" } }));
    w.copy.serves.set(g.id, { serves: "no", why: SEALED, block: "identity" });
    // fetch 19 as it is live: the import failed on the old archiver; the RAR is still on the seedbox mount
    const RAR = "/remote/downloads/Demons.Souls.v1.004.PS5.PPSA01341.rar";
    const fetch19 = (db.query("INSERT INTO fetches (game_id, title, protocol, client, state, local_path, size) VALUES (?,?,?,?,?,?,?) RETURNING id")
      .get(g.id, "Demons.Souls.v1.004.PS5.PPSA01341", "torrent", "rtorrent", "done", RAR, 54_255_919_283) as { id: number }).id;
    extra.fetches.push(fetch19);
    crdeps.exists = path => path === RAR || existsSync(path);
    // the seedbox's mount is one of the folders ludarr takes files from (a download client's mapped folder)
    crdeps.allowedRoots = async () => [resolve("/remote/downloads"), realpathSync(w.dir)];
    crdeps.diskFree = async () => 76 * GB;
    const run = w.start({ wayId: way.id, by: "backfill" });
    // the upgrade round first: the way takes the app0 folder packed into one .zar, the editions and versions the code names
    await w.advance(run.id);
    w.round(live(run.id, "construct").id, { edit: () => updateWay(way.id, { content: kytyUpgraded(), overrides: { check: kytyCheck } }), changed: ["content", "check"] });
    let r = await w.advance(run.id);
    expect(texts(run.id)).toContain(`The copy on the server (bbb-ps5-01342.iso, 54.2 GB) is ${SEALED}: nothing is copied from it`);
    // the v1.004 RAR: offered to the way before any search, only read (the fetch is not marked imported, nothing removed)
    const take = live(run.id, "content");
    expect(w.spec(take)).toEqual({ kind: "content", gameId: g.id, wayId: way.id, path: RAR, fetchId: fetch19, earlier: true, runId: run.id });
    expect([r.state, w.requests.made]).toEqual(["waiting", []]);
    // the make inside it runs out of room on the library, three times: the ask says it in numbers and names the fix
    for (let i = 0; i < 3; i++) {
      w.end(live(run.id, "content").id, { state: "failed", message: "not enough room on the library for PPSA01341-app0.zar: 76 GB free", fail: { class: "env", kind: "room" } });
      r = await w.advance(run.id);
      if (r.state === "asking") break;                   // plainly short: asked at the first failure
      if (i < 2) { w.clock.t = r.next_at! * 1000; r = await w.advance(run.id); }
    }
    expect(serializeRun(r).ask).toMatchObject({
      code: "room",
      need: "Taking in Demon's Souls's game data needs about 104 GB free on the library: what it writes, and the 50 GB ludarr keeps free (Settings → General → Import → Keep free on the library); 76 GB are free. Freeing the second copy of bbb-ps5-01342.iso kept in the game file store gives 54.2 GB back; one copy stays, and that is enough. ludarr tries again every hour.",
    });
    // the admin frees it: the run takes the RAR again at once, the .zar is made in that job and the way's build follows
    cadeps.freeDuplicate = async () => ({ freedBytes: ISO });
    expect((await carryApi.request(`/api/v1/content/${row1.id}/free-duplicate`, { method: "POST" })).status).toBe(200);
    r = await w.advance(run.id);
    const again = live(run.id, "content");
    expect(w.spec(again)).toMatchObject({ path: RAR, fetchId: fetch19, earlier: true });
    const zar = w.kept(g, "PPSA01341-app0.zar", { made: true, platform: "ps5", size: 22 * GB });
    db.query("UPDATE contents SET identity_json=? WHERE id=?").run(JSON.stringify({ platform: "ps5", serial: "PPSA01341", version: "01.007.000", shape: "zar" }), zar.id);
    updateWay(way.id, { contentId: zar.id });
    // find.ts queues the way's build when the file landed (a search's own build, not the run's): the run follows it
    const asm = crdeps.enqueueJob({ kind: "assemble", wayId: way.id, auto: true }, { gameId: g.id });
    w.end(again.id, { message: "PPSA01341-app0.zar: the game file, made from Demons.Souls.v1.004.PS5.PPSA01341.rar; building it" });
    r = await w.advance(run.id);
    expect([r.phase, JSON.parse(r.step_json!)]).toEqual(["build", expect.objectContaining({ job: asm.id, adopted: true })]);
    w.built(asm.id, ENV_CHECK);
    r = await w.advance(run.id);
    expect(r.state).toBe("done");
    expect(w.requests.made).toEqual([]);
    expect(stmts.fetchById.get(fetch19)).toMatchObject({ imported_at: null });
  });
});

describe("Zelda 64: Recompiled: Majora's Mask is not in the library", () => {
  /** plan 1 as it is live: saved by step 0 of a construct job (its manifest's curated game) with no game */
  function zelda(name: string) {
    const job = stmts.insertJobOf.get(null, null, null, "repo:Zelda64Recomp/Zelda64Recomp", "construct", JSON.stringify({ kind: "construct", repo: "Zelda64Recomp/Zelda64Recomp" }), null) as { id: number };
    const p = w.plan(name, "recomp", zeldaPlan(), { repo: "Zelda64Recomp/Zelda64Recomp", jobId: job.id });
    stmts.setJobDone.run("plan ready", null, JSON.stringify({ planId: p.id, game: mmDraft() }), job.id);
    return p;
  }

  test("the backfill holds it, asking to go ahead; go: Majora's Mask added (IGDB, N64), the way carried through to done", async () => {
    const p = zelda("Zelda 64: Recompiled");
    await ensureRuns();
    await ensureRuns();
    const runs = db.query("SELECT * FROM carry_runs WHERE plan_id=?").all(p.id) as RunRow[];
    expect(runs.length).toBe(1);
    const run = runs[0];
    expect([run.state, run.game_id, run.next_at]).toEqual(["held", null, null]);
    const a = serializeRun(run).ask!;
    expect(a).toMatchObject({ code: "go-ahead", title: "Make The Legend of Zelda: Majora's Mask playable?", need: "Should ludarr make The Legend of Zelda: Majora's Mask playable through Zelda 64: Recompiled? It adds the game to the library and looks for Majora's Mask, NTSC-U 1.0." });
    // held: the ticker leaves it be
    expect((await w.advance(run.id)).state).toBe("held");
    // go
    const added: GameRow[] = [];
    atdeps.lookup = async () => [{ id: { scheme: "igdb", value: "1030" }, name: "The Legend of Zelda: Majora's Mask", year: 2000, platforms: ["N64"], cover: null, summary: null, source: "igdb", gameId: null, status: null }];
    atdeps.addGame = async body => {
      expect(body).toEqual({ source: "igdb", id: "1030", monitored: true, searchNow: false });
      const g = w.game("The Legend of Zelda: Majora's Mask", ["N64"], { year: 2000, igdbId: 1030 });
      added.push(g);
      return { id: g.id } as never;
    };
    intend(run.id, { kind: "answer", answer: { go: true } });
    let r = await w.advance(run.id, 1);
    expect(r.state).toBe("active");
    r = await w.advance(run.id);
    expect(added.length).toBe(1);
    expect(r.game_id).toBe(added[0].id);
    const way = waysOfPlan(p.id)[0];
    expect(way.game_id).toBe(added[0].id);
    // its plan proves the ROM by hash, but runs no check: the upgrade round adds one
    let round = live(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!.failure).toBe("the plan runs no check on the server before the package is offered (check)");
    w.round(round.id, { edit: () => updatePlan(p.id, { spec: zeldaPlan(true) }), changed: ["check"] });
    r = await w.advance(run.id);
    // the search: its content pass proves the No-Intro ROM by its sha1, keeps it and queues the way's build
    expect(w.requests.made.length).toBe(1);
    const rom = w.kept(added[0], "Legend of Zelda, The - Majora's Mask (USA).z64", { source: "indexer", platform: "n64", sha1: MM_SHA1 });
    updateWay(way.id, { contentId: rom.id });
    const asm = crdeps.enqueueJob({ kind: "assemble", wayId: way.id, auto: true }, { gameId: added[0].id });
    w.setRequest(w.requests.made[0], { state: "processing", job_id: asm.id, stage: "waiting to build" });
    r = await w.advance(run.id);
    expect([r.phase, JSON.parse(r.step_json!)]).toEqual(["build", expect.objectContaining({ job: asm.id, adopted: true })]);
    w.built(asm.id, { verdict: "env", steps: [], smoke: { verdict: "env", alive: false, exitCode: null, titles: [], screenshot: null, outputTail: "", why: "the server has no graphics device" }, text: "not started here: the server has no graphics device" });
    r = await w.advance(run.id);
    expect(r.state).toBe("done");
    expect(serializeRun(r).rail.at(-1)!.state).toBe("env");
  });

  test("not now: the run stops and nothing is removed", async () => {
    const p = zelda("Zelda 64: Recompiled (not now)");
    await ensureRuns();
    const run = runOf(p.id);
    expect(run.state).toBe("held");
    intend(run.id, { kind: "answer", answer: { go: false } });
    const r = await w.advance(run.id, 1);
    expect(r.state).toBe("stopped");
    expect(texts(run.id).at(-1)).toBe("stopped: you said not now: nothing was removed (remove the plan to be done with it)");
    expect(getPlan(p.id)).not.toBeNull();
    expect(waysOfPlan(p.id)).toEqual([]);
    // and the backfill does not start it again
    await ensureRuns();
    expect((db.query("SELECT COUNT(*) AS n FROM carry_runs WHERE plan_id=?").get(p.id) as { n: number }).n).toBe(1);
  });
});

describe("zero touch", () => {
  const ztqMake = () => ({ ...kytyMake(), input: { ...kytyMake().input, serials: ["PPSA09999"], versions: undefined } });
  const ztq = (): RuntimePlanSpec => ({
    program: { kind: "release", assetPattern: "^ZTQ-.*[.]zip$", channel: "stable" },
    launch: { exe: "ztq.exe", argv: ["{content}"] },
    content: { kind: "disc", platform: "ps5", what: "Zero Touch Quest, PPSA09999", search: ["Zero Touch Quest"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA09999"] }, place: "game/{name}" },
    files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
  });

  test("a plan a construct job saves reaches done with no admin call: game attached, upgrade round, file from the inbox, make, assemble, env check", async () => {
    const g = w.game("Zero Touch Quest", ["PS5"], { year: 2026 });
    const p = w.plan("Zero Touch Port", "port", ztq());
    // the construct job that saved it ends: its end alone starts the run
    const job = crdeps.enqueueJob({ kind: "construct", repo: "carrytest/zero-touch-port" }, {});
    w.end(job.id, { message: "plan ready: Zero Touch Port", manifest: { planId: p.id, game: { ...mmDraft(), name: "Zero Touch Quest", aliases: [], platforms: ["ps5"], year: 2026 } } });
    const run = runOf(p.id);
    expect(run).toMatchObject({ started_by: "construct", state: "active", game_id: null });
    let r = await w.advance(run.id);
    expect(r.game_id).toBe(g.id);
    const way = waysOfPlan(p.id)[0];
    expect(way.game_id).toBe(g.id);
    const round = live(run.id, "construct");
    expect((w.spec(round) as Extract<JobSpec, { kind: "construct" }>).repair!.phase).toBe("upgrade");
    w.round(round.id, { edit: () => updatePlan(p.id, { spec: { ...planSpec(getPlan(p.id)!), content: { ...ztq().content!, make: ztqMake() as never }, check: kytyCheck } }), changed: ["content", "check"] });
    w.inbox.next = ["/library/.ahoy-inbox/zero-touch-quest/PPSA09999-app0"];
    r = await w.advance(run.id);
    const take = live(run.id, "content");
    const dump = w.kept(g, "PPSA09999-app0", { source: "inbox", shape: "folder", platform: "ps5", size: 40 * GB });
    w.end(take.id, { manifest: intake("PPSA09999-app0", dump.id, { inputFor: [way.id] }) });
    crdeps.inputMatches = (_i, row) => ({ ok: row.id === dump.id, why: row.id === dump.id ? null : "not the folder" });
    r = await w.advance(run.id);
    const make = live(run.id, "make");
    const { assemble } = w.made(make.id, { name: "PPSA09999-app0.zar", serial: "PPSA09999", version: "01.000.000" });
    r = await w.advance(run.id);
    expect(JSON.parse(r.step_json!).job).toBe(assemble.id);
    w.built(assemble.id, ENV_CHECK);
    r = await w.advance(run.id);
    expect(r.state).toBe("done");
    const steps = w.steps(run.id);
    expect(steps.some(s => s.who === "admin")).toBe(false);
    expect(steps.map(s => s.text)).toEqual(expect.arrayContaining([
      "Zero Touch Port was saved: carrying it through",
      "Zero Touch Port plays Zero Touch Quest (PlayStation 5): attached",
      expect.stringMatching(/^a way to play Zero Touch Quest through Zero Touch Port: added/),
      "PPSA09999-app0 landed in the inbox: taking it in",
      "making the game data from PPSA09999-app0",
      "built: Zero Touch Quest is ready for members to install; not started here: the server has no graphics device",
    ]));
    expect(DEMONS_SOULS.length + DS_VERSIONS.length).toBe(5);
  });
});
