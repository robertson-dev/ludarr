/**
 * A game's inbox (src/ways/inbox.ts): an entry is queued as a content job only once nothing in it changed for ten minutes
 * (or <entry>.done is beside it); an archive set is one entry; dot entries, sidecars and links are never entries; a note
 * newer than the entry keeps it from being tried again until it changes; an entry written by a build program is refused
 * with a note; the folders are root:users 0770, never world-writable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, type GameRow, type JobRow } from "../src/db";
import { ibdeps, inboxDir, inboxEntries, inboxMemory, intakeInbox, STABLE_MS } from "../src/ways/inbox";
import { dirLink } from "./ways-fixtures";

const real = { ...ibdeps };
let root = "", dir = "", clock = 0, queued: { gameId: number; path: string; runId: number | null }[] = [];
let game: GameRow;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carry-inbox-"));
  clock = Date.UTC(2026, 10, 8, 12);
  queued = [];
  inboxMemory.reset();
  game = db.query("INSERT INTO games (name, slug, platforms_json) VALUES (?,?,?) RETURNING *").get("Inbox Quest", `inbox-quest-${Date.now()}-${Math.random().toString(36).slice(2)}`, "[]") as GameRow;
  dir = join(root, ".ahoy-inbox", game.slug!);
  mkdirSync(dir, { recursive: true });
  ibdeps.now = () => clock;
  ibdeps.posix = () => false;
  ibdeps.intakeFor = () => null;
  ibdeps.enqueue = (gameId, path, runId) => { queued.push({ gameId, path, runId }); return { id: 1000 + queued.length } as JobRow; };
});
afterEach(() => { Object.assign(ibdeps, real); rmSync(root, { recursive: true, force: true }); db.query("DELETE FROM games WHERE id=?").run(game.id); });
/** the inbox scan for a game whose inbox is `dir` (the root folder is the test's) */
async function scan(runId: number | null = 7) {
  const g = game;
  const rf = db.query("INSERT INTO root_folders (path) VALUES (?) RETURNING *").get(root) as { id: number };
  db.query("UPDATE games SET root_folder_id=? WHERE id=?").run(rf.id, g.id);
  try { return await intakeInbox(db.query("SELECT * FROM games WHERE id=?").get(g.id) as GameRow, { runId }); }
  finally { db.query("UPDATE games SET root_folder_id=NULL WHERE id=?").run(g.id); db.query("DELETE FROM root_folders WHERE id=?").run(rf.id); }
}

describe("the inbox folder", () => {
  test("<root folder>/.ahoy-inbox/<the game's folder>", () => {
    const rf = db.query("INSERT INTO root_folders (path) VALUES (?) RETURNING *").get(root) as { id: number };
    try { expect(inboxDir({ ...game, root_folder_id: rf.id })).toBe(dir); }
    finally { db.query("DELETE FROM root_folders WHERE id=?").run(rf.id); }
  });
});

describe("what is taken, and when", () => {
  test("a file is taken once nothing in it changed for ten minutes; a change starts the ten minutes again", async () => {
    writeFileSync(join(dir, "Demon's Souls.zar"), "partial");
    let r = await scan();
    expect([r.queued, r.waiting]).toEqual([0, 1]);
    clock += 5 * 60_000;
    expect((await scan()).queued).toBe(0);
    writeFileSync(join(dir, "Demon's Souls.zar"), "partial and more");     // still arriving
    clock += 6 * 60_000;
    expect((await scan()).queued).toBe(0);
    clock += STABLE_MS;
    r = await scan(7);
    expect(r.queued).toBe(1);
    expect(queued).toEqual([{ gameId: game.id, path: join(dir, "Demon's Souls.zar"), runId: 7 }]);
  });

  test("a folder counts every file in it; <entry>.done beside it is taken at once", async () => {
    mkdirSync(join(dir, "PPSA01341-app0", "sce_sys"), { recursive: true });
    writeFileSync(join(dir, "PPSA01341-app0", "sce_sys", "param.json"), "{}");
    expect((await scan()).queued).toBe(0);
    writeFileSync(join(dir, "PPSA01341-app0.done"), "");
    const r = await scan();
    expect(r.queued).toBe(1);
    expect(queued[0].path).toBe(join(dir, "PPSA01341-app0"));
  });

  test("a big folder is walked a few files at a time and every file counts: a change deep inside starts the ten minutes again", async () => {
    const top = join(dir, "PPSA01341-app0");
    for (let i = 0; i < 60; i++) { mkdirSync(join(top, `d${i}`, "x"), { recursive: true }); writeFileSync(join(top, `d${i}`, "x", "f.bin"), "a"); }
    expect((await scan()).queued).toBe(0);
    clock += 6 * 60_000;
    writeFileSync(join(top, "d47", "x", "f.bin"), "ab");                     // one byte more, three levels down
    clock += 6 * 60_000;
    expect((await scan()).queued).toBe(0);
    clock += STABLE_MS;
    const r = await scan();
    expect(r.queued).toBe(1);
    expect(queued[0].path).toBe(top);
  });

  test("a .done left from an earlier drop of the same name does not take a new entry before it is whole", async () => {
    writeFileSync(join(dir, "Demon's Souls.zar.done"), "");
    await Bun.sleep(30);
    writeFileSync(join(dir, "Demon's Souls.zar"), "partial");               // copied in after the old marker
    let r = await scan();
    expect([r.queued, r.waiting]).toEqual([0, 1]);
    await Bun.sleep(30);
    writeFileSync(join(dir, "Demon's Souls.zar.done"), "");                  // the copy finished: a new marker
    r = await scan();
    expect(r.queued).toBe(1);
  });

  test("an archive set is taken at once with <set>.done beside it", async () => {
    for (const n of ["Game.part1.rar", "Game.part2.rar"]) writeFileSync(join(dir, n), n);
    writeFileSync(join(dir, "Game.rar.done"), "");
    const r = await scan();
    expect(r.queued).toBe(1);
    expect(queued[0].path).toBe(join(dir, "Game.part1.rar"));
  });

  test("an archive set is one entry, by its first volume (a split zip by its .zip); a lone .zip is a file", async () => {
    for (const n of ["Game.part1.rar", "Game.part2.rar", "Game.part3.rar", "Disc.7z.001", "Disc.7z.002", "Split.z01", "Split.z02", "Split.zip", "Lone.zip", "Old.rar", "Old.r00", "Old.r01"]) writeFileSync(join(dir, n), n);
    const { entries } = await inboxEntries(dir);
    expect(entries.map(e => [e.name, e.path.slice(dir.length + 1), e.parts.length])).toEqual([
      ["Disc.7z", "Disc.7z.001", 2], ["Game.rar", "Game.part1.rar", 3], ["Lone.zip", "Lone.zip", 1], ["Old.rar", "Old.rar", 3], ["Split.zip", "Split.zip", 3],
    ]);
    clock += STABLE_MS;
    await scan();
    clock += STABLE_MS + 1;
    await scan();
    expect(queued.map(q => q.path.slice(dir.length + 1)).sort()).toEqual(["Disc.7z.001", "Game.part1.rar", "Lone.zip", "Old.rar", "Split.zip"]);
  });

  test("dot entries, sidecars and links are never entries", async () => {
    mkdirSync(join(dir, ".partial"), { recursive: true });
    writeFileSync(join(dir, "x.not-taken.txt"), "no");
    writeFileSync(join(dir, "y.done"), "");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    dirLink(elsewhere, join(dir, "linked"));
    const { entries, skipped } = await inboxEntries(dir);
    expect(entries).toEqual([]);
    expect(skipped).toEqual(["linked is a link: ludarr never follows one"]);
  });

  test("a note newer than everything in the entry: not tried again; changed or dropped again: tried again; one being taken in is not queued twice", async () => {
    const f = join(dir, "Refused.zar");
    writeFileSync(f, "bytes");
    await Bun.sleep(20);
    writeFileSync(`${f}.not-taken.txt`, "another game");
    clock += STABLE_MS + 1;
    await scan();
    clock += STABLE_MS + 1;
    let r = await scan();
    expect(r.queued).toBe(0);
    expect(r.notes).toContain("Refused.zar: not taken (see Refused.zar.not-taken.txt); change it or drop it again to try again");
    // dropped again: newer than the note
    await Bun.sleep(20);
    writeFileSync(f, "other bytes");
    clock += STABLE_MS + 1;
    await scan();
    clock += STABLE_MS + 1;
    r = await scan();
    expect(r.queued).toBe(1);
    // a content job for the path already: not queued twice
    ibdeps.intakeFor = () => ({ id: 1 } as JobRow);
    clock += STABLE_MS + 1;
    r = await scan();
    expect([r.queued, r.notes]).toEqual([0, ["Refused.zar: being taken in"]]);
  });
});

describe("who wrote it", () => {
  /** an lstat that says who owns what, for a server that keeps owners */
  function owners(map: Record<string, { uid: number; gid: number; mode: number }>) {
    ibdeps.posix = () => true;
    ibdeps.chown = async () => {};
    const modes: Record<string, number> = {};
    ibdeps.chmod = async (p, m) => { modes[p] = m; };
    ibdeps.lstat = (async (p: string) => {
      const st = await real.lstat(p);
      const o = map[p] ?? map["*"];
      if (!o) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: o.uid, gid: o.gid, mode: (st.mode & ~0o777) | (modes[p] ?? o.mode) });
    }) as typeof ibdeps.lstat;
    return modes;
  }

  test("an entry a build program wrote is refused, with the note beside it", async () => {
    writeFileSync(join(dir, "forged.zar"), "x");
    owners({ [join(dir, "forged.zar")]: { uid: 1500, gid: 1500, mode: 0o644 }, "*": { uid: 0, gid: 100, mode: 0o770 } });
    clock += STABLE_MS + 1;
    const r = await scan();
    expect(r.queued).toBe(0);
    expect(r.notes).toContain("forged.zar: written by a build program, not by you");
    expect(await Bun.file(join(dir, "forged.zar.not-taken.txt")).text()).toBe("written by a build program, not by you: ludarr does not take it\n");
  });

  test("the folders are made 0770; one open to every user, or a stranger's, is refused", async () => {
    const modes = owners({ "*": { uid: 0, gid: 100, mode: 0o777 } });
    writeFileSync(join(dir, "a.zar"), "x");
    let r = await scan();
    expect(modes[dir]).toBe(0o770);                                         // made 0770 (never world-writable)
    expect(r.notes).not.toContain(expect.stringContaining("open to every user"));
    owners({ "*": { uid: 4242, gid: 4242, mode: 0o770 } });
    r = await scan();
    expect(r.notes).toEqual([`${dir} belongs to user 4242: ludarr takes files only from a folder of root or of the users group`]);
    owners({ "*": { uid: 1500, gid: 1500, mode: 0o770 } });
    r = await scan();
    expect(r.notes).toEqual([`${dir} was made by a build program, not by you: ludarr takes nothing from it`]);
  });
});
