import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { facets, findTitle, getTitle, ingest, normName, queryTitles, upsertTitle } from "../src/catalog/store";
import { pickRelease } from "../src/catalog/github";
import { catalogApi } from "../src/api/catalog";
import { cdeps } from "../src/catalog/worker";
import { registerPlugin, ensureSingletons } from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";
import type { Contribution, RuntimeInput } from "../src/catalog/types";

const steam = { id: "steam", metaRank: 80 };
const registry = { id: "registry", metaRank: 70 };
const compat = { id: "compat", metaRank: 20 };

beforeEach(() => db.exec("DELETE FROM routes; DELETE FROM title_names; DELETE FROM title_ids; DELETE FROM titles; DELETE FROM runtimes; DELETE FROM catalog_sources;"));

describe("names", () => {
  test("normalised for matching: case, marks, punctuation, leading article, roman numerals", () => {
    expect(normName("The Legend of Zelda™: Majora’s Mask")).toBe("legend of zelda majoras mask");
    expect(normName("FINAL FANTASY VII")).toBe("final fantasy 7");
    expect(normName("Pokémon Sun & Moon")).toBe("pokemon sun and moon");
    expect(normName("Mega Man X")).toBe("mega man x");          // X stays a letter
    expect(normName("The")).toBe("the");
  });
});

describe("resolution and merging", () => {
  test("a shared id wins, then the name (+ year when both know it); otherwise a new title", () => {
    const a = upsertTitle({ ids: [{ scheme: "steam", value: "379720" }], name: "DOOM", platforms: ["pc"], year: 2016 }, steam);
    expect(findTitle({ ids: [{ scheme: "steam", value: "379720" }], name: "something else" })).toBe(a);
    expect(findTitle({ ids: [{ scheme: "serial", value: "CUSA02084" }], name: "Doom", platforms: ["ps4"] })).toBe(a);   // name, no year
    expect(findTitle({ ids: [], name: "Doom", year: 1993 })).toBeNull();                                                  // same name, other decade
    const b = upsertTitle({ ids: [{ scheme: "registry", value: "doom-1993" }], name: "Doom", year: 1993, platforms: ["dos"] }, registry);
    expect(b).not.toBe(a);
    expect(findTitle({ ids: [], name: "doom", year: 1994 })).toBe(b);
  });
  test("metadata from a higher-ranked provider wins; lower ones only fill gaps; ids and platforms accumulate", () => {
    const id = upsertTitle({ ids: [{ scheme: "serial", value: "CUSA00900" }], name: "Bloodborne", platforms: ["ps4"], meta: { summary: "from compat" } }, compat);
    upsertTitle({ ids: [{ scheme: "registry", value: "bloodborne" }], name: "Bloodborne™", year: 2015, platforms: ["ps4"], meta: { summary: "curated", cover: "c.jpg" } }, registry);
    upsertTitle({ ids: [{ scheme: "serial", value: "CUSA03173" }], name: "Bloodborne GOTY", aliases: ["Bloodborne"], platforms: ["ps4"], meta: { summary: "low", hero: "h.jpg" } }, compat);
    const t = getTitle(id)!;
    expect(t.name).toBe("Bloodborne™"); expect(t.summary).toBe("curated"); expect(t.cover).toBe("c.jpg"); expect(t.hero).toBe("h.jpg"); expect(t.year).toBe(2015);
    expect(t.ids.map(i => i.value).sort()).toEqual(["CUSA00900", "CUSA03173", "bloodborne"]);
  });
});

const mm = (status = "playable"): Contribution => ({
  title: { ids: [{ scheme: "registry", value: "zelda-mm" }], name: "The Legend of Zelda: Majora's Mask", platforms: ["n64"], year: 2000 },
  routes: [{ key: "zelda64recomp", kind: "recomp", platform: "n64", runtime: "zelda64recomp", label: "Zelda64Recomp", status: status as any,
    features: ["60 fps", "widescreen"], content: { kind: "rom", platform: "n64", accept: { sha1: ["d6133ace5afaa0882cf214cf88daba39e266c078"], regions: ["US"] }, place: "mm.us.rev1.rom.z64", from: [{ type: "tracker", query: "Majoras Mask N64" }] } }],
});
const runtime: RuntimeInput = { id: "zelda64recomp", name: "Zelda64Recomp", kind: "recomp", platforms: ["n64"], repo: "Zelda64Recomp/Zelda64Recomp", launch: { exe: "Zelda64Recompiled.exe" } };

describe("ingest", () => {
  test("snapshots upsert routes, keep runtimes, and drop what a provider stops reporting", () => {
    ingest(registry, [mm(), { title: { ids: [], name: "Perfect Dark", platforms: ["n64"] }, routes: [{ key: "pd", kind: "port", platform: "n64", label: "perfect_dark" }] }], [runtime]);
    expect(queryTitles({}).total).toBe(2);
    ingest(registry, [mm("perfect")], [runtime]);
    expect(queryTitles({ all: true }).total).toBe(2);   // the title stays …
    expect(queryTitles({}).total).toBe(1);              // … but without routes it is not listed
    const t = getTitle(queryTitles({}).titles[0].id)!;
    expect(t.routes).toHaveLength(1);
    expect(t.routes[0]).toMatchObject({ kind: "recomp", status: "perfect", runtime: { id: "zelda64recomp", name: "Zelda64Recomp" }, launch: { exe: "Zelda64Recompiled.exe" } });
    expect((t.routes[0].content as any).accept.sha1[0]).toMatch(/^d6133/);
  });
  test("one title, several routes from several providers, best first; filters and facets", () => {
    ingest(steam, [{ title: { ids: [{ scheme: "steam", value: "1" }], name: "Sonic Unleashed", platforms: ["pc"] }, routes: [] }]);
    ingest(registry, [{ title: { ids: [{ scheme: "registry", value: "unleashed" }], name: "Sonic Unleashed", platforms: ["x360"], year: 2008 },
      routes: [{ key: "unleashedrecomp", kind: "recomp", platform: "x360", label: "UnleashedRecomp", status: "playable" }] }]);
    ingest(compat, [{ title: { ids: [{ scheme: "titleid", value: "534507D4" }], name: "Sonic Unleashed", platforms: ["x360"] },
      routes: [{ key: "534507D4", kind: "emulated", platform: "x360", runtime: "xenia", status: "ingame" }] },
      { title: { ids: [{ scheme: "serial", value: "CUSA1" }], name: "Leaky Game", platforms: ["ps4"] },
        routes: [{ key: "leak1", kind: "emulated", platform: "ps4", provenance: "leak", status: "boots" }] }]);
    const list = queryTitles({});
    expect(list.total).toBe(2);
    const sonic = list.titles.find(t => t.name === "Sonic Unleashed")!;
    expect(sonic).toMatchObject({ kinds: ["recomp", "emulated"], best: { kind: "recomp", status: "playable" }, routeCount: 2 });
    expect(queryTitles({ kind: "emulated", status: "ingame" }).titles.map(t => t.name)).toEqual(["Sonic Unleashed"]);
    expect(queryTitles({ provenance: "leak" }).titles.map(t => t.name)).toEqual(["Leaky Game"]);
    expect(queryTitles({ q: "unleash" }).total).toBe(1);
    expect(queryTitles({ q: "534507D4" }).total).toBe(1);
    expect(queryTitles({ platform: "ps4" }).titles[0].name).toBe("Leaky Game");
    expect(facets()).toMatchObject({ titles: 2, kinds: { recomp: 1, emulated: 2 }, provenances: { retail: 1, leak: 1 } });
  });
});

describe("runtime releases", () => {
  const rel = (tag: string, prerelease: boolean, assets: string[]) => ({ tag_name: tag, name: tag, published_at: "2026-10-01T00:00:00Z", prerelease, draft: false, html_url: `https://gh/${tag}`,
    assets: assets.map(a => ({ name: a, browser_download_url: `https://gh/${tag}/${a}`, size: 1000 })) });
  test("stable before pre-releases, the Windows asset, a pattern when given", () => {
    const list = [rel("v2-nightly", true, ["App-win64.zip"]), rel("v1.2", false, ["App-linux.AppImage", "App-macos.dmg", "App-1.2-windows-x64.zip", "App-1.2-windows-x64-pdb.zip"])];
    expect(pickRelease(list)).toMatchObject({ tag: "v1.2", asset: { name: "App-1.2-windows-x64.zip" } });
    expect(pickRelease(list, null, "nightly")).toMatchObject({ tag: "v2-nightly", prerelease: true });
    expect(pickRelease(list, "pdb")).toMatchObject({ asset: { name: "App-1.2-windows-x64-pdb.zip" } });
    expect(pickRelease([rel("v0", false, ["src.tar.gz"])])).toMatchObject({ tag: "v0", asset: null });
  });
});

describe("API", () => {
  test("titles list, detail by id and slug, facets, vocab, runtimes, sources", async () => {
    ingest(registry, [mm()], [runtime]);
    for (const p of BUILTIN) registerPlugin(p, "builtin");
    ensureSingletons();
    cdeps.sources = () => [{ id: 0, name: "registry", source: { id: "registry" } as never }, { id: 1, name: "steam", source: { id: "steam" } as never }];   // the API shows enabled sources only
    const list = await (await catalogApi.request("/api/v1/catalog/titles?kind=recomp")).json() as any;
    expect(list.total).toBe(1);
    const { id, slug } = list.titles[0];
    expect(slug).toBe("legend-of-zelda-majoras-mask");
    expect((await (await catalogApi.request(`/api/v1/catalog/titles/${slug}`)).json() as any).item.id).toBe(id);
    expect((await catalogApi.request("/api/v1/catalog/titles/nope")).status).toBe(404);
    expect((await (await catalogApi.request("/api/v1/catalog/vocab")).json() as any).platforms.n64).toBe("Nintendo 64");
    const rt = await (await catalogApi.request("/api/v1/catalog/runtimes/zelda64recomp")).json() as any;
    expect(rt.item.repo).toBe("Zelda64Recomp/Zelda64Recomp"); expect(rt.titles.total).toBe(1);
    expect((await (await catalogApi.request("/api/v1/catalog/sources")).json() as any).items.map((s: any) => s.id)).toContain("steam");
  });
});
