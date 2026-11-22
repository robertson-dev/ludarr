/**
 * Fix round C: a program's file list judges only the title and version it is for (src/ways/inspect.ts listFor,
 * listJudges, completeness), read on real app0 folders; and a download's archive is judged by its listing before the
 * content pass asks for room or unpacks it (src/ways/find.ts gameFilesIn → make.ts judgeArchive), its refusal the make's
 * own words and class. The live case: Demon's Souls v1.004 (PPSA01341, 41,737 files) against Kyty's list of the 1.07
 * game's files (files-PPSA01341_01.007.000.files, 98,368 paths).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, upsertGame, type GameRow, type JobRow } from "../src/db";
import { datdeps, forgetDats } from "../src/catalog/providers/dats";
import { downloadsDir } from "../src/config";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import type { KindContext } from "../src/process/kinds";
import { ctdeps } from "../src/ways/content";
import { failOf } from "../src/ways/errors";
import { fdeps, NotTheGameFile, takeDownload } from "../src/ways/find";
import * as inspect from "../src/ways/inspect";
import { MakeRefused } from "../src/ways/make";
import { insertPlan, insertWay } from "../src/ways/store";
import type { ContentPlan, RuntimePlanSpec } from "../src/ways/types";
import { writeApp0 } from "./ways-images";

const tmp = mkdtempSync(join(tmpdir(), "fixc-whole-"));
const LIST = "tools/local/static-precompile/files-PPSA01341_01.007.000.files";
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("what a program's file list is for, and whom it judges", () => {
  test("Kyty's list names its title and version in its file name", () => {
    expect(inspect.listFor(LIST)).toEqual({ title: "PPSA01341", version: "01.007.000" });
    expect(inspect.listFor("lists/files-PPSA01342_01.005.000.files")).toEqual({ title: "PPSA01342", version: "01.005.000" });
    expect(inspect.listFor("game-files.txt")).toEqual({ title: null, version: null });
  });
  test("the list judges its own title at its own version; another version or title is judged by its size, in words; an unknown one by the list, as before", () => {
    const c = { list: { path: LIST }, minBytes: 30e9 };
    expect(inspect.listJudges(c, { serial: "PPSA01341", version: "01.007.000" })).toEqual({ judges: true });
    expect(inspect.listJudges(c, { serial: "PPSA01341", version: "01.04" })).toEqual({ judges: false, note: "the program's file list (files-PPSA01341_01.007.000.files) is for PPSA01341 01.007.000; this dump is PPSA01341 01.04, so it is judged by its size" });
    expect(inspect.listJudges(c, { serial: "PPSA01342", version: "01.007.000" })).toMatchObject({ judges: false });
    expect(inspect.listJudges(c, { serial: "PPSA01341" })).toEqual({ judges: true });
    expect(inspect.listJudges(c, null)).toEqual({ judges: true });
    expect(inspect.listJudges({ list: { path: "game-files.txt" } }, { serial: "PPSA01341", version: "01.004.000" })).toEqual({ judges: true });
  });
  test("completeness on real dumps: the v1.004 folder is not refused by the 1.07 list (its own param.json says which it is), the 1.07 one still is", async () => {
    const list = Array.from({ length: 98 }, (_, i) => `app0/data/file-${i}.bin`);
    // the live v1.004 dump holds 42 % of the files Kyty's 1.07 list names (41,737 of 98,368)
    const held = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`data/file-${i}.bin`, "x"]));
    const v104 = writeApp0(join(tmp, "v104", "PPSA01341-app0"), { titleId: "PPSA01341", version: "01.004.000", files: held(42) });
    const old = await inspect.completeness(v104, { list: { path: LIST } }, { list });
    expect([old.ok, old.note]).toEqual([true, "the program's file list (files-PPSA01341_01.007.000.files) is for PPSA01341 01.007.000; this dump is PPSA01341 01.004.000, so it is judged by how many of the list's files it holds (at least 25 %: an update holds only a few)"]);
    // an update-only dump of another version holds only the few files it changes: still refused, with no size in the plan
    const v106 = writeApp0(join(tmp, "v106", "PPSA01341-app0"), { titleId: "PPSA01341", version: "01.006.000", files: held(3) });
    const update = await inspect.completeness(v106, { list: { path: LIST } }, { list });
    expect([update.ok, update.why]).toEqual([false, "an update or a part of the game, not the whole game: 3% of the 98 files the program lists for it are there (the whole game has 25%)"]);
    // judged by its size when the plan gives one
    const small = await inspect.completeness(v104, { list: { path: LIST }, minFiles: 90000 }, { list });
    expect([small.ok, small.why]).toEqual([false, expect.stringMatching(/^an update or a part of the game, not the whole game: it holds \d+ files/)]);
    const v107 = writeApp0(join(tmp, "v107", "PPSA01341-app0"), { titleId: "PPSA01341", version: "01.007.000" });
    const same = await inspect.completeness(v107, { list: { path: LIST } }, { list });
    expect([same.ok, same.why, same.note]).toEqual([false, "an update or a part of the game, not the whole game: 0% of the 98 files the program lists for it are there (the whole game has 98%)", undefined]);
  });
});

describe("a download's archive is judged by its listing before any room is asked for or anything unpacked", () => {
  const realF = { ...fdeps }, realC = { ...ctdeps }, realDat = { ...datdeps };
  const made = { games: [] as number[], plans: [] as number[] };
  beforeAll(() => {
    ensureDefaultRootFolder(); ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
    datdeps.dir = () => join(tmp, "dats"); datdeps.fetchText = async () => { throw new Error("offline"); }; forgetDats();
  });
  afterEach(() => { Object.assign(fdeps, realF); Object.assign(ctdeps, realC, { diskSpace: async () => ({ free: 1e15, total: 2e15 }) }); });
  afterAll(() => {
    Object.assign(fdeps, realF); Object.assign(ctdeps, realC); Object.assign(datdeps, realDat); forgetDats();
    for (const id of made.games) for (const t of ["jobs", "contents", "fetches", "blocklist", "requests"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id);
    for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
    for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  });
  /** the upgraded KytyPS5 way: the app0 folder (an archive of it unpacked by the content pass) packed into one .zar */
  const folderWay = (): ContentPlan => ({
    kind: "disc", platform: "ps5", what: "Demon's Souls (PS5) as one .zar", search: ["Demon's Souls"], accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] }, place: "games/{name}",
    make: { input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", also: ["eboot.bin"], serials: ["PPSA01341"], versions: ["01.005.000", "01.007.000"] }, steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, { convert: { with: "zarchive", argv: ["{prep}/app0", "{out}"], timeoutSec: 600 } }], output: { name: "{serial}-app0.zar", shape: "file" } },
  } as unknown as ContentPlan);
  let seq = 0;
  function way() {
    const g = upsertGame({ name: `Fixc Kyty ${++seq}`, slug: `fixc-kyty-${seq}`, platforms_json: JSON.stringify(["PS5"]) } as Partial<GameRow>) as GameRow;
    made.games.push(g.id);
    const spec = { program: { kind: "release", assetPattern: "^K-.*[.]zip$", channel: "stable" }, launch: { exe: "k.exe", argv: ["{content}"] }, content: { ...folderWay(), search: [g.name] }, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: [] } as unknown as RuntimePlanSpec;
    const p = insertPlan({ name: `Fixc Kyty ${seq}`, kind: "emulator", repo: `fixc/kyty-${seq}`, platforms: ["ps5"], spec, status: "ready" });
    made.plans.push(p.id);
    return { g, w: insertWay({ gameId: g.id, planId: p.id, content: folderWay() }) };
  }
  function rarDownload(name: string): string {
    const dir = join(downloadsDir(), `fixc-${++seq}-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Demons.Souls.v1.004.PS5.PPSA01341.rar"), "Rar!".padEnd(4096, "r"));
    return dir;
  }
  const ctxFor = (): KindContext & { lines: string[] } => {
    const lines: string[] = [];
    const work = mkdtempSync(join(tmp, "work-"));
    return { job: { id: 7 } as JobRow, spec: { kind: "content", gameId: null } as never, work, staging: join(work, "staging"), log: (l: string) => lines.push(l), progress: () => {}, signal: new AbortController().signal, trace: () => {}, tier: () => {}, lines } as unknown as KindContext & { lines: string[] };
  };

  test("refused from its listing (another version, here): no room is asked for, nothing is unpacked, and the release is refused with the make's words and class", async () => {
    const { g, w } = way();
    const asked: string[] = [];
    (fdeps as Record<string, unknown>).judgeArchive = async () => { asked.push("judged"); throw new MakeRefused("PPSA01341-app0 in Demons.Souls.v1.004.PS5.PPSA01341.rar is version 01.004.000, and this takes 01.005.000 or 01.007.000", "identity"); };
    fdeps.unpackRoom = async () => { asked.push("room"); return { why: "not enough room: asked before the archive was judged" }; };
    fdeps.extract = (async () => { asked.push("unpacked"); }) as typeof fdeps.extract;
    const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: rarDownload("v104"), fetchId: null }).catch(x => x);
    expect(asked).toEqual(["judged"]);
    expect(e).toBeInstanceOf(NotTheGameFile);
    expect([e.message, (e as NotTheGameFile).cls, failOf(e)]).toEqual(["not the game file: PPSA01341-app0 in Demons.Souls.v1.004.PS5.PPSA01341.rar is version 01.004.000, and this takes 01.005.000 or 01.007.000", "identity", { class: "file" }]);
  });

  test("judged fit: the room asked for is its game folder's bytes by the listing, then it is unpacked; one that cannot be judged here is unpacked as before", async () => {
    const { g, w } = way();
    const sizes: number[] = [];
    (fdeps as Record<string, unknown>).judgeArchive = async () => ({ dir: "PPSA01341-app0", identity: { platform: "ps5", serial: "PPSA01341", version: "01.007.000" }, bytes: 56e9 });
    fdeps.unpackRoom = async (_w, unpack) => { sizes.push(unpack); return { why: "not enough room: the test stops here" }; };
    const e = await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: rarDownload("fit"), fetchId: null }).catch(x => x);
    expect(sizes).toEqual([56e9]);                                                  // the listing's bytes, not the archive's 4 KB
    expect(e.message).toBe("not enough room: the test stops here");
    (fdeps as Record<string, unknown>).judgeArchive = async () => null;
    sizes.length = 0;
    await takeDownload(ctxFor(), { kind: "content", gameId: g.id, wayId: w.id, path: rarDownload("unknown"), fetchId: null }).catch(x => x);
    expect(sizes).toEqual([4096]);
  });
});
