/**
 * The version of a game that is asked for (games.want_platform): which versions a game can be asked for, that the API keeps
 * the choice and searches again when it changes, and what a release's title says of its platform where the indexer's filing
 * says otherwise. (That a search then looks for that version only is in tests/requests.test.ts, with the searcher's fakes.)
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, serializeGame, stmts, type GameRow, type RequestRow } from "../src/db";
import { lookup, wantedFor } from "../src/library/games";
import { gamesApi } from "../src/api/games";
import { cdeps } from "../src/catalog/worker";
import * as registry from "../src/plugins/registry";
import { PLATFORM_LABEL, consolePlatforms, isConsole, platformChoices, platformId, wantedPlatform } from "../src/platforms";
import { buildQuery, parseTitle, releasePlatform, wrongKind } from "../src/releases";
import { rdeps } from "../src/requests";

const saved = { sources: cdeps.sources, rdeps: { ...rdeps } };
const wipe = "DELETE FROM requests; DELETE FROM follows; DELETE FROM jobs; DELETE FROM packages; DELETE FROM games; DELETE FROM routes; DELETE FROM title_names; DELETE FROM title_ids; DELETE FROM titles";
afterAll(() => { cdeps.sources = saved.sources; Object.assign(rdeps, saved.rdeps); db.exec(wipe); });
beforeEach(() => {
  process.env.LUDARR_CONFIG = mkdtempSync(join(tmpdir(), "ludarr-version-"));
  db.exec(wipe);
  registry.clearCache();
  cdeps.sources = saved.sources;
  rdeps.log = () => {};
});

const post = async (body: unknown) => gamesApi.request("/api/v1/game", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = async (id: number, body: unknown) => gamesApi.request(`/api/v1/game/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const row = (id: number) => stmts.gameById.get(id) as GameRow;
const active = (id: number) => stmts.requestActiveForGame.get(id) as RequestRow | undefined;
const mvc = { name: "Marvel vs. Capcom: Clash of Super Heroes", year: 1998, platforms: ["Arcade", "PS3", "X360", "DC"] };
async function added(extra: Record<string, unknown> = {}) {
  const res = await post({ source: "manual", game: mvc, searchNow: false, ...extra });
  expect(res.status).toBe(201);
  return (await res.json() as { item: any }).item;
}

describe("the versions a game can be asked for", () => {
  test("the arcade is a platform, by the names sources and trackers give it", () => {
    for (const n of ["Arcade", "arcade", "MAME", "FBNeo", "Coin-Op"]) expect(platformId(n), n).toBe("arcade");
    expect(PLATFORM_LABEL.arcade).toBe("Arcade");
    expect(isConsole("arcade")).toBe(true);                                  // a dump, not a PC build
    expect(consolePlatforms(["Arcade", "PS3", "X360", "DC"])).toEqual(["arcade", "ps3", "x360", "dc"]);
  });
  test("the platforms it is on, each once, PC first; other desktops and phones are none", () => {
    expect(platformChoices(["Arcade", "PS3", "X360", "DC"])).toEqual(["arcade", "ps3", "x360", "dc"]);
    expect(platformChoices(["PS4", "win", "mac", "linux", "PC (Microsoft Windows)", "XONE", "iOS", "Android"])).toEqual(["pc", "ps4", "xone"]);
    expect(platformChoices(["win"])).toEqual(["pc"]);
    expect(platformChoices([])).toEqual([]);
    expect(platformChoices(["Some Handheld Nobody Knows"])).toEqual([]);
  });
  test("a wanted version is a platform id a copy can be fetched for", () => {
    expect(wantedPlatform("x360")).toBe("x360");
    expect(wantedPlatform("Arcade")).toBe("arcade");
    for (const none of [null, undefined, "", "mac", "ios", "nonsense"]) expect(wantedPlatform(none)).toBeNull();
  });
  test("every game says its versions and the one that was asked for", async () => {
    const item = await added();
    expect(item.platformChoices).toEqual([{ id: "arcade", label: "Arcade" }, { id: "ps3", label: "PlayStation 3" }, { id: "x360", label: "Xbox 360" }, { id: "dc", label: "Dreamcast" }]);
    expect(item.wantPlatform).toBeNull();
    expect(serializeGame(row(item.id)).wantPlatform).toBeNull();
  });
  test("a lookup's hits say theirs", async () => {
    await added();
    const hit = (await lookup("marvel vs capcom")).find(h => h.source === "library")!;
    expect(hit.choices?.map(c => c.id)).toEqual(["arcade", "ps3", "x360", "dc"]);
  });
});

describe("asking for a version", () => {
  test("with the game: kept before its first search", async () => {
    const item = await added({ platform: "Arcade" });
    expect(item.wantPlatform).toBe("arcade");
    expect(row(item.id).want_platform).toBe("arcade");
    expect(active(item.id)).toBeFalsy();                                  // searchNow: false
    const now = await added({ searchNow: true, force: true, platform: "x360", game: { ...mvc, name: "Marvel vs. Capcom 2", year: 2000, platforms: ["Arcade", "XBOX", "DC", "PS2"] } }).catch(() => null);
    expect(now).toBeNull();                                                   // an Xbox 360 version of a game that is on none: refused
  });
  test("only one the game is on; a game that names no platform takes any a copy can be fetched for", async () => {
    const g = row((await added()).id);
    expect(wantedFor(g, "x360")).toBe("x360");
    expect(wantedFor(g, "Dreamcast")).toBe("dc");
    expect(wantedFor(g, null)).toBeNull();
    expect(wantedFor(g, "")).toBeNull();
    for (const bad of ["psp", "pc", "mac", "nonsense", 7]) expect(() => wantedFor(g, bad), String(bad)).toThrow(/Arcade, PlayStation 3, Xbox 360, Dreamcast/);
    expect(wantedFor({ name: "x", platforms_json: "[]" }, "psp")).toBe("psp");
    expect(() => wantedFor({ name: "x", platforms_json: "[]" }, "mac")).toThrow(/no such platform/);
    const res = await post({ source: "manual", game: { ...mvc, name: "Another Fighter" }, platform: "psp", searchNow: false });
    expect(res.status).toBe(400);
  });
  test("another version later: the search for the old one stops, and the game is looked for again at once", async () => {
    const id = (await added()).id;
    let res = await put(id, { platform: "x360" });
    expect(res.status).toBe(200);
    expect((await res.json() as { item: any }).item.wantPlatform).toBe("x360");
    const first = active(id);
    expect(first?.state).toBe("requested");
    res = await put(id, { platform: "arcade" });
    const second = active(id);
    expect(second && second.id !== first!.id).toBe(true);                     // the old search is gone, a new one runs
    expect(stmts.requestById.get(first!.id)).toBeFalsy();
    expect(row(id).want_platform).toBe("arcade");
    // the same version again changes nothing: the search under way goes on
    await put(id, { platform: "Arcade" });
    expect(active(id)!.id).toBe(second!.id);
    // no choice again
    res = await put(id, { platform: null });
    expect((await res.json() as { item: any }).item.wantPlatform).toBeNull();
    expect(active(id)!.id).not.toBe(second!.id);
    expect((await put(id, { platform: "psp" })).status).toBe(400);
    expect(row(id).want_platform).toBeNull();
    // other edits leave the version alone
    await put(id, { platform: "dc" });
    await put(id, { monitored: true });
    expect(row(id).want_platform).toBe("dc");
  });
  test("a game nobody watches is not searched for because its version changed", async () => {
    const id = (await added({ monitored: false })).id;
    await put(id, { platform: "x360" });
    expect(row(id).want_platform).toBe("x360");
    expect(active(id)).toBeFalsy();
  });
});

describe("what a release says of its platform", () => {
  const kind = (title: string, want: Parameters<typeof wrongKind>[3], cats: number[] = [], known = want) => wrongKind(buildQuery(mvc.name, 1998), title, parseTitle(title), want, cats, known);
  test("a PlayStation game converted for the PSP is a PSP release, wherever the indexer filed it", () => {
    const title = "Marvel vs Capcom Clash Of Super Heroes PSX2PSP";
    expect(releasePlatform(title, parseTitle(title), [1080])).toBe("psp");   // filed under PS3 (taken as the PS3 game, 2026-11-11)
    expect(kind(title, ["ps3", "x360", "dc"], [1080])).toBe("platform: PSP");
    expect(kind(title, ["arcade"], [1080])).toBe("platform: PSP");
    expect(kind(title, ["pc"], [1080])).toMatch(/not a PC build \(psx2psp\)/);
  });
  test("an arcade release names the arcade, and is taken only in a search for the arcade version", () => {
    const ggn = "Marvel vs. Capcom: Clash of Super Heroes (1998) [Arcade / English / ROM]";
    expect(releasePlatform(ggn, parseTitle(ggn))).toBe("arcade");
    expect(kind(ggn, ["arcade"])).toBeNull();
    expect(kind(ggn, ["ps3", "x360", "dc"])).toBe("platform: Arcade");
    const set = "Marvel.vs.Capcom.Clash.of.Super.Heroes.MAME-GROUP";
    expect(releasePlatform(set, parseTitle(set))).toBe("arcade");
    expect(kind(set, ["arcade"])).toBeNull();
    // the word in a PC game's own name is no platform ("Arcade Classics")
    const pc = "MARVEL.vs.CAPCOM.Fighting.Collection.Arcade.Classics-RUNE";
    expect(releasePlatform(pc, parseTitle(pc), [], new Set(["marvel", "vs", "capcom", "fighting", "collection", "arcade", "classics"]))).toBeNull();
    const edition = "Street.Fighter.IV.Arcade.Edition-RELOADED";
    expect(releasePlatform(edition, parseTitle(edition), [], new Set(["street", "fighter", "iv"]))).toBeNull();   // the bare word is no tag
  });
});
