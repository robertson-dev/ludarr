/**
 * Paths a plan may name and the names files are stored under (review findings ways-api-10, e2e-3, ways-api-12): a plan
 * path passes only when the Ahoy launcher would install it (launcher/src/engine.ts pathProblem: no ':', no control
 * character, no name of only dots and spaces, no empty folder name; a glob keeps * ? [ ] { }), and a stored name holds
 * no character Windows refuses and fits a file system's name limit in bytes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, upsertGame, type GameRow, type RootFolderRow } from "../src/db";
import { ctdeps, gameTarget, ingestUpload } from "../src/ways/content";
import * as validate from "../src/ways/validate";
import { safeRelPath, storeName, validatePlanSpec, validateWayContent } from "../src/ways/validate";

const launcherPathProblem = (p: string, o: { glob?: boolean }) => validate.launcherPathProblem(p, o);

/** what the launcher's pathProblem answers, read from launcher/src/engine.ts (null: it installs the path) */
const LAUNCHER: [string, boolean, string | null][] = [
  ["games/x.iso", false, null],
  ["games/{name}", false, null],
  ["games/a:b.iso", false, "holds a character Windows does not allow in a path"],
  ["games:Game.z64", false, "holds a character Windows does not allow in a path"],
  ["a\u0001b.exe", false, "holds a character Windows does not allow in a path"],
  ["saves/slot\u001f.sav", false, "holds a character Windows does not allow in a path"],
  ["x?.exe", false, "holds a character Windows does not allow in a path"],
  ["x*.exe", false, "holds a character Windows does not allow in a path"],
  [".../x.exe", false, "climbs out of the install folder"],
  ["saves/.../x", false, "climbs out of the install folder"],
  ["data/ ./x", false, "climbs out of the install folder"],
  ["data/ /x", false, "climbs out of the install folder"],
  ["a//b", false, "has an empty folder name"],
  ["/abs/x.exe", false, "is not inside the install folder"],
  ["saves/*.sav", true, null],
  ["saves/?.sav", true, null],
  ["saves/[ab].sav", true, null],
  ["{saves,cfg}/**", true, null],
  ["saves/a:b/**", true, "holds a character Windows does not allow in a path"],
  ["saves/.../*", true, "climbs out of the install folder"],
];

describe("plan paths stay what the launcher installs (ways-api-10, e2e-3)", () => {
  test("launcherPathProblem answers as the launcher does", () => {
    for (const [p, glob, why] of LAUNCHER) expect([p, glob, launcherPathProblem(p, { glob })]).toEqual([p, glob, why]);
  });

  test("safeRelPath refuses every path the launcher refuses, and a glob keeps * ? [ ] { }", () => {
    for (const [p, glob, why] of LAUNCHER) expect([p, glob, safeRelPath(p, { glob }) === null]).toEqual([p, glob, why === null]);
  });

  test("a plan naming such a path is refused before it is stored", () => {
    const plan = (o: Record<string, unknown> = {}) => ({
      program: { kind: "release", assetPattern: "^Emu-.*[.]zip$", channel: "stable" }, launch: { exe: "emu.exe", argv: ["{content}"] },
      content: { kind: "rom", platform: "n64", what: "an N64 ROM", search: ["x"], accept: { hashes: [], formats: ["z64"] }, place: "games/{name}" },
      files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...o,
    });
    expect(validatePlanSpec(plan(), "emulator").errors).toEqual([]);
    const bad: [Record<string, unknown>, string][] = [
      [{ content: { kind: "rom", platform: "n64", what: "x", search: ["x"], accept: { hashes: [] }, place: "games:{name}" } }, "content.place: holds a character Windows does not allow in a path"],
      [{ files: [{ path: ".../notes.txt", text: "hi" }] }, "files[0].path: climbs out of the install folder"],
      [{ files: [{ path: "config/a:b.ini", text: "x" }] }, "files[0].path: holds a character Windows does not allow in a path"],
      [{ keep: ["saves/a:b/**"] }, "keep[0]: holds a character Windows does not allow in a path"],
      [{ seed: ["data/ /x.ini"] }, "seed[0]: climbs out of the install folder"],
      [{ launch: { exe: "bin/\u0007run.exe", argv: [] } }, "launch.exe: holds a character Windows does not allow in a path"],
      [{ setup: [{ remove: "junk/.../*" }] }, "setup[0].remove: climbs out of the install folder"],
    ];
    for (const [o, error] of bad) expect(validatePlanSpec(plan(o), "emulator").errors).toContain(error);
    expect(validateWayContent({ kind: "rom", platform: "n64", what: "x", search: ["x"], accept: { hashes: [] }, place: "roms/Zelda: MM.z64" }, "emulator").ok).toBe(false);
    // what the launcher takes stays allowed
    expect(validatePlanSpec(plan({ keep: ["saves/**", "{cfg,ini}/*.ini", "slot?.sav", "[ab]/*"], files: [{ path: "a$b/it's (1).txt", text: "x" }] }), "emulator").errors).toEqual([]);
  });
});

describe("stored names (ways-api-12)", () => {
  test("characters Windows refuses become '_', the extension is kept, and a name fits in 200 bytes", () => {
    expect(storeName("x?.iso")).toBe("x_.iso");
    expect(storeName("Disc 1: The <Start> \"Cut\" | A*B.iso")).toBe("Disc 1_ The _Start_ _Cut_ _ A_B.iso");
    expect(storeName("Zelda64Recompiled-1.2.2.zip")).toBe("Zelda64Recompiled-1.2.2.zip");
    expect(storeName("../../other/baserom.z64")).toBe("baserom.z64");
    expect(storeName("C:\\Users\\x\\.hidden.iso")).toBe("hidden.iso");
    const cjk = storeName("あ".repeat(86) + ".iso");
    expect(new TextEncoder().encode(cjk).length).toBeLessThanOrEqual(200);
    expect(cjk.endsWith(".iso")).toBe(true);
    expect(cjk.startsWith("あ".repeat(60))).toBe(true);
    const long = storeName("x".repeat(300) + ".chd");
    expect([long.length, long.slice(-4)]).toEqual([180, ".chd"]);
    // a character outside the basic plane is never cut in half
    const emoji = storeName("🎮".repeat(60) + ".iso");
    expect(emoji).toMatch(/^(🎮)+\.iso$/u);
    expect(new TextEncoder().encode(emoji).length).toBeLessThanOrEqual(200);
  });

  test("an upload whose name holds such characters is kept under the safe name", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ways-paths-")), lib = join(tmp, "library");
    mkdirSync(lib, { recursive: true });
    const realC = { ...ctdeps };
    ctdeps.rootFolders = () => [{ id: 994_500, path: lib, name: null, created_at: 0 } as RootFolderRow];
    ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 });
    const g = upsertGame({ name: "Paths Upload", slug: "paths-upload", platforms_json: JSON.stringify(["ps2"]) } as Partial<GameRow>) as GameRow;
    try {
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2048).fill(7)); c.close(); } });
      const r = await ingestUpload(body, gameTarget(g.id), { name: "Disc 1: Start?.iso" });
      expect(r.row.name).toBe("Disc 1_ Start_.iso");
      expect(existsSync(r.row.path)).toBe(true);
    } finally {
      Object.assign(ctdeps, realC);
      db.query("DELETE FROM contents WHERE game_id=?").run(g.id);
      db.query("DELETE FROM games WHERE id=?").run(g.id);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
