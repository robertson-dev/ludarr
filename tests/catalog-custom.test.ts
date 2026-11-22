import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { db, stmts, upsertGame, type GameRow } from "../src/db";
import { ingest, normName, runtimeRow } from "../src/catalog/store";
import { cdeps } from "../src/catalog/worker";
import { collectSync, customProvider, dropPlanRuntime, ensureTitle, reingestCustom, runtimesSync } from "../src/catalog/providers/custom";
import { seedContributions, skipRepos } from "../src/catalog/providers/ports-seed";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";
import { gameDetail } from "../src/library/games";
import { insertPlan, insertWay, updateWay, wstmts } from "../src/ways/store";
import type { RuntimePlanSpec } from "../src/ways/types";

for (const p of BUILTIN) registry.registerPlugin(p, "builtin");
const realSources = cdeps.sources;
const made = { plans: [] as number[], games: [] as number[] };
afterEach(() => { cdeps.sources = realSources; });
afterAll(() => {
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  db.exec("DELETE FROM routes WHERE source='custom'; DELETE FROM runtimes WHERE source='custom'");
});

let appid = 993_100;
function game(name: string, o: Record<string, unknown> = {}): GameRow {
  const g = upsertGame({ steam_appid: ++appid, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), release_year: 1993, platforms_json: '["pc"]', ...o });
  made.games.push(g.id);
  return g;
}
const spec = (program: RuntimePlanSpec["program"] = { kind: "release", assetPattern: "^Customtest-.*[.]zip$", channel: "stable" }, o: Partial<RuntimePlanSpec> = {}): RuntimePlanSpec => ({
  program, launch: { exe: "Run.exe", argv: ["--rom", "{content}"], cwd: "bin" },
  content: { kind: "rom", platform: "n64", what: "a ROM", search: ["n64"], accept: { hashes: [] }, normalize: null, place: "rom/{name}" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "how it runs", ...o,
});
function plan(name: string, o: { kind?: "recomp" | "port" | "emulator"; repo?: string; spec?: RuntimePlanSpec } = {}) {
  const p = insertPlan({ name, kind: o.kind ?? "recomp", repo: o.repo ?? "customtest/" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), platforms: ["n64"], spec: o.spec ?? spec() });
  made.plans.push(p.id);
  return p;
}
const titleOf = (gameId: number) => (stmts.gameById.get(gameId) as GameRow).title_id;
const keyTitle = (gameId: number) => (db.query("SELECT title_id FROM title_ids WHERE scheme='registry' AND value=?").get(`game:${gameId}`) as { title_id: number } | null)?.title_id ?? null;

describe("custom catalog source: titles by id, never by name", () => {
  test("a game without a title gets its own; the registry id, games.title_id and titles.game_id all point the right way", () => {
    const g = game("Custom Lonely Game");
    expect(g.title_id).toBeNull();
    const id = ensureTitle(g);
    expect(titleOf(g.id)).toBe(id);
    expect(keyTitle(g.id)).toBe(id);
    expect((db.query("SELECT game_id, slug FROM titles WHERE id=?").get(id) as { game_id: number; slug: string })).toEqual({ game_id: g.id, slug: "custom-lonely-game" });
    expect(ensureTitle(stmts.gameById.get(g.id) as GameRow)).toBe(id);                         // idempotent
  });

  test("a game's own title is used; a registry id left pointing elsewhere is moved to it", () => {
    const g = game("Custom Linked Game");
    const t = (db.query("INSERT INTO titles (slug, name, sort_name, meta_source, meta_rank) VALUES ('custom-linked-steam', 'Custom Linked Game', ?, 'steam', 80) RETURNING id").get(normName("Custom Linked Game")) as { id: number }).id;
    const old = (db.query("INSERT INTO titles (slug, name, sort_name) VALUES ('custom-linked-old', 'Old', 'old') RETURNING id").get() as { id: number }).id;
    db.query("INSERT INTO title_ids (scheme, value, title_id, source) VALUES ('registry', ?, ?, 'custom')").run(`game:${g.id}`, old);
    stmts.setGameTitle.run(t, g.id);
    expect(ensureTitle(stmts.gameById.get(g.id) as GameRow)).toBe(t);
    expect(keyTitle(g.id)).toBe(t);
  });

  test("a way's route never lands on another library game's same-named title", () => {
    const steamDoom = game("Customdoom");
    const other = (db.query("INSERT INTO titles (slug, name, sort_name, game_id, year) VALUES ('customdoom-steam', 'Customdoom', ?, ?, 1993) RETURNING id").get(normName("Customdoom"), steamDoom.id) as { id: number }).id;
    db.query("INSERT INTO title_names (norm, title_id) VALUES (?, ?)").run(normName("Customdoom"), other);
    stmts.setGameTitle.run(other, steamDoom.id);
    const manual = game("Customdoom", { steam_appid: null, igdb_id: 993_999 });                  // the same name, a game of its own
    const p = plan("Customdoom Port", { kind: "port" });
    const w = insertWay({ gameId: manual.id, planId: p.id });
    reingestCustom();
    const route = db.query("SELECT * FROM routes WHERE source='custom' AND source_key=?").get(`way:${w.id}`) as { title_id: number } | null;
    expect(route).not.toBeNull();
    expect(route!.title_id).not.toBe(other);
    expect(route!.title_id).toBe(titleOf(manual.id)!);
    expect(db.query("SELECT COUNT(*) AS n FROM routes WHERE title_id=? AND source='custom'").get(other)).toEqual({ n: 0 });
  });

  test("ranked below every source: a title another source named keeps its name; one this source made follows the game", () => {
    const g = game("Custom Rank Game");
    const t = (db.query("INSERT INTO titles (slug, name, sort_name, meta_source, meta_rank) VALUES ('custom-rank', 'Custom Rank Game™ (Steam)', 'x', 'steam', 80) RETURNING id").get() as { id: number }).id;
    stmts.setGameTitle.run(t, g.id);
    insertWay({ gameId: g.id, planId: plan("Custom Rank Plan").id });
    reingestCustom();
    expect((db.query("SELECT name FROM titles WHERE id=?").get(t) as { name: string }).name).toBe("Custom Rank Game™ (Steam)");
    expect(customProvider.metaRank).toBeLessThan(10);
    const own = game("Custom Renamed Game");
    insertWay({ gameId: own.id, planId: plan("Custom Renamed Plan").id });
    reingestCustom();
    db.query("UPDATE games SET name='Custom Renamed Game II' WHERE id=?").run(own.id);
    reingestCustom();
    expect((db.query("SELECT name FROM titles WHERE id=?").get(titleOf(own.id)) as { name: string }).name).toBe("Custom Renamed Game II");
  });
});

describe("custom catalog source: routes and runtimes", () => {
  test("one route per way: kind from the plan, the plan's runtime, playable once built, the repo as its link", () => {
    const g = game("Custom Route Game", { platforms_json: '["n64"]' });
    const emu = plan("Customemu", { kind: "emulator", repo: "customtest/emu" });
    const rec = plan("Customrec", { kind: "recomp", repo: "forgejo:codeberg.org/someone/rec" });
    const we = insertWay({ gameId: g.id, planId: emu.id }), wr = insertWay({ gameId: g.id, planId: rec.id });
    updateWay(wr.id, { status: "built", packageId: 1 });
    const mine = collectSync().find(c => c.title.gameId === g.id)!;
    // the id, the names, the game, and the game's own year, date and platforms (which fill a title that has none)
    expect(mine.title).toEqual({ ids: [{ scheme: "registry", value: `game:${g.id}` }], name: "Custom Route Game", aliases: [], gameId: g.id, year: 1993, releaseIso: null, platforms: ["n64"] });
    expect(mine.routes).toEqual([
      { key: `way:${we.id}`, kind: "emulated", platform: "n64", provenance: "retail", runtime: `plan:${emu.slug}`, label: "Customemu", status: null, link: "https://github.com/customtest/emu" },
      { key: `way:${wr.id}`, kind: "recomp", platform: "n64", provenance: "retail", runtime: `plan:${rec.slug}`, label: "Customrec", status: "playable", link: "https://codeberg.org/someone/rec" },
    ]);
    // shown on the game's page while the source is on
    reingestCustom();
    cdeps.sources = () => [{ id: 1, name: "custom", source: { id: "custom" } as never }];
    expect(gameDetail(g.id)!.routes.map((r: { label: string | null }) => r.label).sort()).toEqual(["Customemu", "Customrec"]);
    cdeps.sources = () => [{ id: 2, name: "steam", source: { id: "steam" } as never }];
    expect(gameDetail(g.id)!.routes).toEqual([]);
  });

  test("runtimes: GitHub releases and the Dolphin feed are polled; another forge, a fixed file and a source build are not", () => {
    const gh = plan("Customrt Github");
    const feed = plan("Customrt Feed", { kind: "emulator", repo: "dolphin-emu/dolphin", spec: spec({ kind: "feed", feed: "dolphin:beta" }) });
    const forge = plan("Customrt Forge", { repo: "forgejo:git.example.org/a/b" });
    const url = plan("Customrt Url", { spec: spec({ kind: "url", url: "https://files.example.org/x.zip", sha256: "a".repeat(64) }) });
    const src = plan("Customrt Source", { spec: spec({ kind: "source", ref: "v1", steps: ["make"], artifact: "build", content: "none" }) });
    wstmts.setPinned.run(JSON.stringify({ tag: "fixed", asset: "x.zip", url: "https://files.example.org/x.zip", size: 10, sha256: "a".repeat(64), pinnedAt: 1 }), url.id);
    const rts = new Map(runtimesSync().map(r => [r.id, r]));
    expect(rts.get(`plan:${gh.slug}`)).toMatchObject({ kind: "recomp", repo: gh.repo, assetPattern: "^Customtest-.*[.]zip$", channel: "stable", platforms: ["n64"], notes: "how it runs", launch: { exe: "Run.exe", args: ["--rom", "{content}"], cwd: "bin" } });
    expect(rts.get(`plan:${gh.slug}`)!.latest).toBeUndefined();               // the poller's to fill
    expect(rts.get(`plan:${feed.slug}`)).toMatchObject({ kind: "emulator", repo: "dolphin:beta", channel: "stable", homepage: "https://github.com/dolphin-emu/dolphin" });
    expect(rts.get(`plan:${forge.slug}`)).toMatchObject({ channel: "seed" });
    expect(rts.get(`plan:${forge.slug}`)!.latest).toBeUndefined();            // its own check stores what it finds
    expect(rts.get(`plan:${url.slug}`)).toMatchObject({ channel: "seed", latest: { tag: "fixed", asset: { name: "x.zip", size: 10 } } });
    expect(rts.get(`plan:${src.slug}`)).toMatchObject({ channel: "seed", latest: null });
  });

  test("written at once after a change; a deleted way's route and a deleted plan's runtime go; switched off, nothing is written", () => {
    const g = game("Custom Churn Game");
    const p = plan("Custom Churn Plan");
    const w = insertWay({ gameId: g.id, planId: p.id });
    reingestCustom();
    const route = () => db.query("SELECT id FROM routes WHERE source='custom' AND source_key=?").get(`way:${w.id}`);
    expect(route()).not.toBeNull();
    expect(runtimeRow(`plan:${p.slug}`)?.source).toBe("custom");
    wstmts.deleteWay.run(w.id);
    reingestCustom();
    expect(route()).toBeNull();
    db.query("DELETE FROM runtime_plans WHERE id=?").run(p.id);
    dropPlanRuntime(p.slug);
    expect(runtimeRow(`plan:${p.slug}`)).toBeFalsy();
    // a plan row gone some other way still loses its runtime on the next run
    const q = plan("Custom Churn Orphan");
    reingestCustom();
    db.query("DELETE FROM runtime_plans WHERE id=?").run(q.id);
    reingestCustom();
    expect(runtimeRow(`plan:${q.slug}`)).toBeFalsy();
    // switched off in Settings → Metadata
    registry.ensureSingletons();
    const row = registry.instanceRows("metadata").find(r => r.impl === "custom")!;
    registry.updateInstance(row.id, { enabled: false });
    try { expect(reingestCustom()).toBeNull(); } finally { registry.updateInstance(row.id, { enabled: true }); }
  });

  test("the worker's own run feeds the same snapshot through ingest", async () => {
    const g = game("Custom Worker Game");
    const w = insertWay({ gameId: g.id, planId: plan("Custom Worker Plan").id });
    const items = await customProvider.collect({ log: () => {}, fetch });
    ingest(customProvider, items, customProvider.runtimes!());
    expect(db.query("SELECT id FROM routes WHERE source='custom' AND source_key=?").get(`way:${w.id}`)).not.toBeNull();
  });
});

describe("custom catalog source: registration", () => {
  test("on by default (wrap honours defaultEnabled); the others keep theirs", () => {
    expect(registry.definition("metadata", "custom")?.defaultEnabled).toBe(true);
    expect(registry.definition("metadata", "steam")?.defaultEnabled).toBe(true);
    expect(registry.definition("metadata", "ports")?.defaultEnabled).toBe(false);
  });

  test("the community ports list leaves out repos a plan already covers", () => {
    const p = plan("Customseed Plan", { repo: "SeedOwner/SeedPort" });
    expect(skipRepos().has("seedowner/seedport")).toBe(true);
    const rows = [
      { id: "1", title: "Seed Game (SeedPort)", platform: "N64", type: "source-port", repo: "SeedOwner/SeedPort", release: "v1", stars: 100 },
      { id: "2", title: "Other Game (OtherPort)", platform: "N64", type: "source-port", repo: "someone/otherport", release: "v1", stars: 100 },
    ];
    expect(seedContributions(rows, skipRepos()).items.map(c => c.title.name)).toEqual(["Other Game"]);
    db.query("DELETE FROM runtime_plans WHERE id=?").run(p.id);
    expect(skipRepos().has("seedowner/seedport")).toBe(false);
  });
});
