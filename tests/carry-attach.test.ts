/**
 * Which library game a plan plays (src/ways/attach.ts): names AND platform, never a name alone; several → the exact name,
 * else ask; none → the one store hit of that name on that platform, else by hand on the plan's platform; another
 * platform's release is another game (Ocarina of Time on the N64 in 1998, on the Switch 2 in 2026).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db, type GameRow } from "../src/db";
import { LibraryError, type AddBody, type LookupResult } from "../src/library/games";
import { addGameFor, addWay, atdeps, libraryMatch, matchGame, onPlatform, planGameNames, platformOf } from "../src/ways/attach";
import { serializeRun } from "../src/ways/carry";
import { planSpec } from "../src/ways/store";
import type { RuntimePlanSpec } from "../src/ways/types";
import { kytyPlan, nx2navi, world, zeldaPlan, type World } from "./carry-world";

let w: World;
const realAt = { ...atdeps };
let mine: GameRow[] = [];
beforeEach(() => { w = world(); mine = []; atdeps.libraryGames = () => mine.map(g => db.query("SELECT * FROM games WHERE id=?").get(g.id) as GameRow).filter(Boolean); });
afterEach(() => { w.cleanup(); Object.assign(atdeps, realAt); });
const game = (name: string, platforms: string[], o: { year?: number; aliases?: string[]; igdbId?: number } = {}) => { const g = w.game(name, platforms, o); mine.push(g); return g; };
const hit = (name: string, platforms: string[], value: string, scheme = "igdb", year: number | null = null): LookupResult => ({ id: { scheme, value }, name, year, platforms, cover: null, summary: null, source: scheme, gameId: null, status: null });
const port = (search: string[], platform = "n64"): RuntimePlanSpec => ({ ...zeldaPlan(true), content: { ...zeldaPlan().content!, platform: platform as never, search, accept: { hashes: [{ algo: "sha1", value: "a".repeat(40) }], formats: platform === "n64" ? ["z64"] : ["nup"] } } });

describe("platforms by their stored names", () => {
  test("Switch generations have separate identifiers across store and scene names", () => {
    for (const n of ["Nintendo Switch 2", "Switch 2", "NS2", "NSW2", "switch2"]) expect(platformOf(n)).toBe("switch2");
    for (const n of ["Nintendo Switch", "NSW"]) expect(platformOf(n)).toBe("switch");
    expect(onPlatform(["Nintendo Switch 2"], "switch")).toBe(false);
    expect(onPlatform(["N64"], "switch")).toBe(false);
    expect(onPlatform(["PC (Microsoft Windows)", "PS5"], "pc")).toBe(true);
    expect(onPlatform(["PS5"], "ps5")).toBe(true);
  });
});

describe("matchGame", () => {
  test("Ocarina of Time on the N64 (1998) and on the Switch 2 (2026): a Switch plan is the 2026 game, never the other", async () => {
    const oot64 = game("The Legend of Zelda: Ocarina of Time", ["N64"], { year: 1998 });
    const g48 = game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"], { year: 2026, igdbId: 990_148 });
    const p = w.plan("NX2navi Attach", "recomp", nx2navi());
    const m = await matchGame(p, null);
    expect(m).toMatchObject({ kind: "attach", game: { id: g48.id } });
    expect(libraryMatch(p, null)?.id).toBe(g48.id);
    // and an N64 plan of the same game is the 1998 one
    const n64 = w.plan("Ship Attach", "port", port(["The Legend of Zelda: Ocarina of Time"]));
    expect(await matchGame(n64, null)).toMatchObject({ kind: "attach", game: { id: oot64.id } });
  });

  test("two of the platform: the one named exactly; still two: ask", async () => {
    // "Majora's Mask" is the subtitle of one and the whole name of the other: the exact one
    game("The Legend of Zelda: Majora's Mask", ["N64"]);
    const exact = game("Majora's Mask", ["N64"]);
    const p = w.plan("Mask Port", "port", port(["Majora's Mask"]));
    expect(await matchGame(p, null)).toMatchObject({ kind: "attach", game: { id: exact.id } });
    const twin = game("Majora's Mask", ["N64"], { year: 2008 });
    const m = await matchGame(p, null);
    expect(m.kind).toBe("ask");
    // the two named exactly first, then the one whose subtitle it is
    expect((m as Extract<typeof m, { kind: "ask" }>).candidates.map(g => g.name)).toEqual(["Majora's Mask", "Majora's Mask", "The Legend of Zelda: Majora's Mask"]);
    expect((m as Extract<typeof m, { kind: "ask" }>).candidates.slice(0, 2).map(g => g.id).sort()).toEqual([exact.id, twin.id].sort());
  });

  test("a re-release of the same name on the original Switch cannot take a Switch 2 plan", async () => {
    const a = game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"], { year: 2026 });
    const b = game("The Legend of Zelda: Ocarina of Time", ["Switch"], { year: 2027 });
    game("The Legend of Zelda: Ocarina of Time", ["N64"], { year: 1998 });
    const p = w.plan("NX2navi Two", "recomp", nx2navi());
    const m = await matchGame(p, null);
    expect(m).toMatchObject({ kind: "attach", game: { id: a.id } });
    expect(libraryMatch(p, null)?.id).toBe(a.id);
  });

  test("a library game of that name that says nothing of its platforms is asked about: a name alone never attaches", async () => {
    const bare = game("Perfect Dark", []);
    const p = w.plan("Perfect Dark Port", "port", port(["Perfect Dark"]));
    const m = await matchGame(p, null);
    expect(m).toMatchObject({ kind: "ask", candidates: [{ id: bare.id }] });
    expect(libraryMatch(p, null)).toBeNull();
  });

  test("none in the library: the one IGDB hit of that name on that platform is added; none: by hand on the plan's platform", async () => {
    atdeps.lookup = async () => [hit("Majora's Mask 3D", ["3DS"], "1"), hit("The Legend of Zelda: Majora's Mask", ["N64"], "1030", "igdb", 2000), hit("The Legend of Zelda: Majora's Mask", ["3DS"], "2000")];
    const p = w.plan("MM Attach", "recomp", zeldaPlan(true));
    expect(await matchGame(p, null)).toEqual({ kind: "add", body: { source: "igdb", id: "1030", monitored: true, searchNow: false }, why: "The Legend of Zelda: Majora's Mask (2000) from igdb" });
    atdeps.lookup = async () => [];
    const m = await matchGame(p, null);
    expect(m.kind).toBe("add");
    const body = (m as Extract<typeof m, { kind: "add" }>).body as AddBody & { game: { name: string; aliases: string[]; platforms: string[] } };
    expect(body).toMatchObject({ source: "manual", monitored: true, searchNow: false, game: { name: "The Legend of Zelda: Majora's Mask", aliases: ["Majora's Mask"], platforms: ["n64"] } });
  });

  test("a port whose names are another game's is never attached; the program's own name is never the game's", async () => {
    game("Super Mario 64 DS", ["NDS"]);
    game("Zelda 64: Recompiled", ["N64"]);
    atdeps.lookup = async () => [];
    const p = w.plan("SM64 Port", "port", port(["Super Mario 64"]));
    expect((await matchGame(p, null)).kind).toBe("add");
    const z = w.plan("Zelda 64: Recompiled", "recomp", port(["Zelda 64: Recompiled", "The Legend of Zelda: Majora's Mask"]));
    expect(planGameNames(z, planSpec(z).content, null)).toEqual(["The Legend of Zelda: Majora's Mask"]);
    expect((await matchGame(z, null)).kind).toBe("add");
    // and its way through POST /game/:id/ways' checks is refused for the other game unless forced
    const sm64ds = mine[0];
    const added = await addWay(sm64ds, p);
    expect(added).toMatchObject({ status: 409, wrongGame: true, error: "SM64 Port plays Super Mario 64, and Super Mario 64 DS does not look like that game" });
    expect(await addWay(sm64ds, p, { force: true })).toHaveProperty("way");
  });

  test("an emulator plays many games: matchGame names none", async () => {
    const p = w.plan("Kyty Attach", "emulator", kytyPlan());
    expect(await matchGame(p, null)).toEqual({ kind: "none", why: "an emulator plays many games: add it to a game to make that one playable" });
  });
});

describe("addGameFor", () => {
  test("a store add that cannot be made is made by hand; a 409 is that game only on the plan's platform, else one beside it", async () => {
    const p = w.plan("NX2navi Add", "recomp", nx2navi());
    const c = planSpec(p).content!;
    const calls: AddBody[] = [];
    const oot64 = game("The Legend of Zelda: Ocarina of Time", ["N64"], { year: 1998 });
    atdeps.addGame = async body => {
      calls.push(body);
      if (body.source === "igdb") throw new LibraryError("IGDB is not configured (Settings → Metadata)", 400);
      if (body.source === "manual" && !body.force) throw new LibraryError("already in the library", 409, { existingId: oot64.id });
      return { id: game("The Legend of Zelda: Ocarina of Time", ["switch"], { year: 2026 }).id } as never;
    };
    const g = await addGameFor({ kind: "add", body: { source: "igdb", id: "1", monitored: true, searchNow: false }, why: "x" }, c, null, p.name);
    expect(g.id).not.toBe(oot64.id);
    expect(JSON.parse(g.platforms_json)).toEqual(["switch"]);
    expect(calls.map(b => [b.source, !!b.force])).toEqual([["igdb", false], ["manual", false], ["manual", true]]);
    // the same name already there on the plan's platform: that game
    const sw = game("The Legend of Zelda: Ocarina of Time", ["Nintendo Switch 2"], { year: 2026 });
    atdeps.addGame = async () => { throw new LibraryError("already in the library", 409, { existingId: sw.id }); };
    expect((await addGameFor({ kind: "add", body: { source: "manual", game: {}, monitored: true, searchNow: false }, why: "x" }, c, null, p.name)).id).toBe(sw.id);
  });
});

describe("an emulator plan saved without a game, carried", () => {
  test("one 'choice' ask with the library games of its console whose only copy is a console dump; none: done with a note", async () => {
    const p = w.plan("Kyty Choice", "emulator", kytyPlan());
    const run = w.start({ planId: p.id, by: "construct" });
    let r = await w.advance(run.id);
    expect(r.state).toBe("done");
    expect(serializeRun(r).rail.find(x => x.phase === "game")!.summary).toBe("an emulator plays many games: add it to a game to make that one playable (no library game of PlayStation 5 has only a console copy)");
    const p2 = w.plan("Kyty Choice Two", "emulator", kytyPlan());
    const ds = game("Demon's Souls", ["PS5"]);
    w.romPackage(ds, "bbb-ps5-01342.iso", { size: 1, platform: "ps5" });
    const run2 = w.start({ planId: p2.id, by: "construct" });
    r = await w.advance(run2.id);
    expect(r.state).toBe("asking");
    const a = serializeRun(r).ask!;
    expect(a).toMatchObject({ code: "choice", title: "Which game should Kyty Choice Two play?", choices: [{ gameId: ds.id, name: "Demon's Souls" }] });
    expect(a.need).toBe("Kyty Choice Two is an emulator: it plays many games. These library games of PlayStation 5 have only a console copy so far: pick the one to make playable.");
  });
});
