import { beforeEach, describe, expect, test } from "bun:test";
import { db, stmts, type FetchRow, type GameRow } from "../src/db";
import { goalMet, mappedPath, seedingTick, sgdeps } from "../src/seeding";
import type { SbItem } from "../src/seedbox-items";
import { resolve } from "node:path";

const game = (name: string) => stmts.upsertGame({ igdb_id: null, steam_appid: null, name, slug: name.toLowerCase().replace(/\W+/g, "-"), summary: null, storyline: null, release_year: null, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["win"]', game_modes_json: "[]", developer: null, publisher: null }) as GameRow;
const fetchRow = (o: { game: number; title: string; protocol: "torrent" | "usenet"; client: "rtorrent" | "nzbget"; clientId: string; local: string | null; imported?: boolean }) =>
  db.query("INSERT INTO fetches (game_id, title, protocol, client, client_id, state, local_path, client_instance_id, imported_at) VALUES (?,?,?,?,?,'done',?,7,?) RETURNING *")
    .get(o.game, o.title, o.protocol, o.client, o.clientId, o.local, o.imported === false ? null : 1) as FetchRow;
const item = (client: "rtorrent" | "nzbget", clientId: string, extra: Partial<SbItem> = {}): SbItem => ({ id: `${client}:${clientId}`, client, clientId, name: clientId, state: "done", progress: 1, sizeBytes: 1, doneBytes: 1, downRate: 0, path: "/x", isDir: true, message: "", label: "", ...extra });

let items: SbItem[] = [];
let removed: { clientId: string; deleteData: boolean }[] = [];
let deleted: string[] = [];
let present = new Set<string>();
let settings: Record<string, unknown> = {};
beforeEach(() => {
  db.exec("DELETE FROM fetches; DELETE FROM games; DELETE FROM history");
  items = []; removed = []; deleted = []; present = new Set(); settings = { seedRatio: 1, seedTimeHours: 0, pathMap: "/home/u/downloads=/remote/downloads" };
  sgdeps.clientById = () => ({ test: async () => ({ ok: true, detail: "" }), add: async () => { throw new Error("no"); }, items: async () => ({ items }), remove: async (ref, deleteData) => { removed.push({ clientId: ref.clientId, deleteData }); }, pull: () => ({ local: "/x" }), seedGoals: { ratio: Number(settings.seedRatio), hours: Number(settings.seedTimeHours) } });
  sgdeps.settingsOf = () => settings;
  sgdeps.nameOf = () => "rT";
  sgdeps.exists = async p => present.has(p);
  sgdeps.rm = async p => { deleted.push(p); };
  sgdeps.now = () => 1_800_000_000_000;
});

describe("after the import", () => {
  test("seed goals: ratio or hours, whichever first; 0 is no goal", () => {
    const now = 1_800_000_000;
    expect(goalMet({ ratio: 1, hours: 0 }, { ratio: 0.4, finishedAt: now - 10 * 86_400 }, now)).toBeNull();
    expect(goalMet({ ratio: 1, hours: 0 }, { ratio: 1.02, finishedAt: null }, now)).toBe("ratio 1.02 reached");
    expect(goalMet({ ratio: 0, hours: 72 }, { ratio: 5, finishedAt: now - 71 * 3600 }, now)).toBeNull();
    expect(goalMet({ ratio: 0, hours: 72 }, { ratio: 0.1, finishedAt: now - 73 * 3600 }, now)).toBe("seeded for 73 h");
    expect(goalMet({ ratio: 2, hours: 1 }, { ratio: 0.5, finishedAt: now - 7200 }, now)).toBe("seeded for 2 h");
  });
  test("only the download's own folder under the mapping is ever deleted", () => {
    const s = { pathMap: "/home/u/downloads=/remote/downloads" };
    expect(mappedPath(s, "/remote/downloads/Game-RUNE")).toBe(resolve("/remote/downloads/Game-RUNE"));
    expect(mappedPath(s, "/remote/downloads")).toBeNull();
    expect(mappedPath(s, "/remote/downloads/")).toBeNull();
    expect(mappedPath(s, "/downloads/Game-RUNE")).toBeNull();
    expect(mappedPath(s, "/remote/downloads-other/x")).toBeNull();
    expect(mappedPath({}, "/remote/downloads/Game-RUNE")).toBeNull();
    expect(mappedPath(s, null)).toBeNull();
  });
  test("usenet goes at once with its files; a torrent waits for its goal, then goes with its files; no goal keeps it; a vanished item is closed out once missing 3 times over 15 min", async () => {
    const g = game("Hollow Knight");
    const nz = fetchRow({ game: g.id, title: "HK.nzb", protocol: "usenet", client: "nzbget", clientId: "41", local: "/remote/downloads/complete/ahoy/HK" });
    const young = fetchRow({ game: g.id, title: "HK-GOG", protocol: "torrent", client: "rtorrent", clientId: "AAA", local: "/remote/downloads/HK-GOG" });
    const ripe = fetchRow({ game: g.id, title: "HK-RUNE", protocol: "torrent", client: "rtorrent", clientId: "BBB", local: "/remote/downloads/HK-RUNE" });
    const gone = fetchRow({ game: g.id, title: "HK-OLD", protocol: "torrent", client: "rtorrent", clientId: "CCC", local: "/remote/downloads/HK-OLD" });
    const notImported = fetchRow({ game: g.id, title: "HK-X", protocol: "torrent", client: "rtorrent", clientId: "DDD", local: null, imported: false });
    items = [item("nzbget", "41"), item("rtorrent", "AAA", { ratio: 0.3 }), item("rtorrent", "BBB", { ratio: 1.5 }), item("rtorrent", "DDD", { ratio: 9 })];
    present = new Set(["/remote/downloads/complete/ahoy/HK", "/remote/downloads/HK-RUNE"].map(p => resolve(p)));
    expect(await seedingTick()).toBe(2);                                                   // the vanished one: missing once is nothing yet
    let t = 1_800_000_000_000;
    sgdeps.now = () => (t += 8 * 60_000);
    expect(await seedingTick()).toBe(0);                                                   // missing twice, 8 min apart
    expect(await seedingTick()).toBe(1);                                                   // the third time, 16 min after the first: gone
    expect(removed).toEqual([{ clientId: "41", deleteData: true }, { clientId: "BBB", deleteData: true }]);
    expect(deleted.map(p => p.replace(/\\/g, "/").replace(/^[A-Z]:/, ""))).toEqual(["/remote/downloads/complete/ahoy/HK", "/remote/downloads/HK-RUNE"]);
    const rows = Object.fromEntries((db.query("SELECT id, cleaned_at, message FROM fetches").all() as { id: number; cleaned_at: number | null; message: string | null }[]).map(r => [r.id, r]));
    expect(rows[nz.id].cleaned_at).not.toBeNull(); expect(rows[nz.id].message).toContain("files deleted");
    expect(rows[young.id].cleaned_at).toBeNull();
    expect(rows[ripe.id].message).toMatch(/ratio 1\.50 reached.*files deleted/);
    expect(rows[gone.id].message).toContain("gone from the download client");
    expect(rows[notImported.id].cleaned_at).toBeNull();                                  // never imported: not ours to clean
    expect((db.query("SELECT event, COUNT(*) n FROM history GROUP BY event").all() as { event: string; n: number }[])).toEqual([{ event: "cleaned", n: 3 }]);
    // no goals at all: the ripe one would have stayed
    db.exec("UPDATE fetches SET cleaned_at=NULL"); removed = []; settings = { ...settings, seedRatio: 0, seedTimeHours: 0 };
    expect(await seedingTick()).toBe(2);                                                   // usenet and the vanished one still close out
    expect(removed).toEqual([{ clientId: "41", deleteData: true }]);
  });
  test("a client that cannot be reached leaves its rows for the next pass", async () => {
    const g = game("Hollow Knight");
    fetchRow({ game: g.id, title: "HK-RUNE", protocol: "torrent", client: "rtorrent", clientId: "BBB", local: null });
    sgdeps.clientById = () => ({ test: async () => ({ ok: true, detail: "" }), add: async () => { throw new Error("no"); }, items: async () => { throw new Error("ECONNREFUSED"); }, remove: async () => {}, pull: () => ({ local: "/x" }) });
    expect(await seedingTick()).toBe(0);
    expect((db.query("SELECT cleaned_at FROM fetches").get() as { cleaned_at: number | null }).cleaned_at).toBeNull();
  });
});
