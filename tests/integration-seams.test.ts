import { describe, expect, test } from "bun:test";
import { db, upsertGame, freeSlug } from "../src/db";
import { record } from "../src/library/history";
import { buildQuery, rankForNames } from "../src/releases";

/** seams found when wave 2 met the wave-1 review fixes */
describe("slugs", () => {
  test("a new store game never takes another game's slug, and a game keeps its slug when the store renames it", () => {
    const a = upsertGame({ steam_appid: 993_001, name: "Alone in the Dark", slug: "alone-in-the-dark", release_year: 1992 });
    const b = upsertGame({ steam_appid: 993_002, name: "Alone in the Dark", slug: "alone-in-the-dark", release_year: 2008 });
    const c = upsertGame({ steam_appid: 993_003, name: "Alone in the Dark", slug: "alone-in-the-dark", release_year: 2008 });
    expect([a.slug, b.slug, c.slug]).toEqual(["alone-in-the-dark", "alone-in-the-dark-2008", "alone-in-the-dark-2"]);
    const renamed = upsertGame({ steam_appid: 993_002, name: "Alone in the Dark (2008)", slug: "alone-in-the-dark-2008-edition", release_year: 2008 });
    expect(renamed.id).toBe(b.id);
    expect(renamed.slug).toBe("alone-in-the-dark-2008");
    expect(renamed.name).toBe("Alone in the Dark (2008)");
    expect(freeSlug("alone-in-the-dark", 1992, a.id)).toBe("alone-in-the-dark");
    for (const id of [a.id, b.id, c.id]) db.query("DELETE FROM games WHERE id=?").run(id);
  });
});

describe("history", () => {
  test("a line for a game that was just deleted is kept without the game instead of throwing", () => {
    const row = record(987_654_321, "importFailed", { gameName: "Gone", release: "x", message: "the game was deleted mid-import" });
    expect(row.game_id).toBeNull();
    db.query("DELETE FROM history WHERE id=?").run(row.id);
  });
});

describe("language tags", () => {
  test("(EN-GB) is British English, not a Game Boy dump, in a PC game's pass", () => {
    const r = { title: "Football Manager 2024 (EN-GB) [GOG]", guid: "g1", size: 4e9, seeders: 10, leechers: 0, indexer: "x", protocol: "torrent", categories: [4000], publishDate: null, downloadUrl: null, magnetUrl: null, infoUrl: null, indexerId: 1 } as any;
    const [v] = rankForNames([buildQuery("Football Manager 2024", 2023)], [r]);
    expect(v.flags.wrongKind ?? null).toBeNull();
  });
  test("a real Game Boy tag is still read as one", () => {
    const r = { title: "Tetris (World) GB", guid: "g2", size: 4e4, seeders: 10, leechers: 0, indexer: "x", protocol: "torrent", categories: [], publishDate: null, downloadUrl: null, magnetUrl: null, infoUrl: null, indexerId: 1 } as any;
    const [v] = rankForNames([buildQuery("Tetris", 1989)], [r]);
    expect(String(v.flags.wrongKind ?? "")).toMatch(/PC|Game Boy|gb/i);
  });
});
