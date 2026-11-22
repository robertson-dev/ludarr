import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { facets, getTitle, normName, queryTitles } from "../src/catalog/store";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";

for (const p of BUILTIN) registry.registerPlugin(p, "builtin");

const title = (name: string, routes: { source: string; kind: string; platform: string }[]) => {
  const id = (db.query("INSERT INTO titles (slug, name, sort_name, platforms_json) VALUES (?,?,?,'[]') RETURNING id").get(name.toLowerCase().replace(/\W+/g, "-"), name, normName(name)) as { id: number }).id;
  db.query("INSERT INTO title_names (norm, title_id) VALUES (?,?)").run(normName(name), id);
  for (const r of routes) db.query("INSERT INTO routes (title_id, kind, platform, provenance, source, source_key) VALUES (?,?,?,'retail',?,?)").run(id, r.kind, r.platform, r.source, `${r.source}:${id}`);
  return id;
};

beforeEach(() => { db.exec("DELETE FROM routes; DELETE FROM title_names; DELETE FROM title_ids; DELETE FROM titles; DELETE FROM plugin_instances WHERE kind IN ('metadata','runtime')"); registry.clearCache(); });

describe("a quiet catalog", () => {
  test("only Steam and the ways to play built here start enabled; every other source and the runtimes start off", () => {
    registry.ensureSingletons();
    const on = registry.instanceRows("metadata").filter(r => r.enabled).map(r => r.impl);
    expect(on).toEqual(["custom", "steam"]);
    expect(registry.instanceRows("metadata").length).toBeGreaterThan(5);
    expect(registry.instanceRows("runtime").every(r => !r.enabled)).toBe(true);
  });
  test("titles and routes from a disabled source stay stored but out of sight; a title Steam also knows keeps only its Steam route", () => {
    const zeldaSw = title("The Legend of Zelda: Tears of the Kingdom", [{ source: "compat-ryubing", kind: "emulated", platform: "switch" }]);
    const hades = title("Hades", [{ source: "steam", kind: "native", platform: "pc" }, { source: "compat-ryubing", kind: "emulated", platform: "switch" }]);
    title("Bloodborne", [{ source: "compat-shadps4", kind: "emulated", platform: "ps4" }]);
    const all = queryTitles({ q: "", all: true });
    expect(all.total).toBe(3);
    const steamOnly = queryTitles({ sources: new Set(["steam"]) });
    expect(steamOnly.titles.map(t => t.name)).toEqual(["Hades"]);
    expect(steamOnly.titles[0].kinds).toEqual(["native"]); expect(steamOnly.titles[0].routeCount).toBe(1);
    expect(queryTitles({ q: "zelda", sources: new Set(["steam"]) }).total).toBe(0);
    expect(queryTitles({ q: "zelda" }).total).toBe(1);                                    // no source filter: everything, as before
    expect(getTitle(hades, new Set(["steam"]))!.routes).toHaveLength(1);
    expect(getTitle(zeldaSw, new Set(["steam"]))!.routes).toHaveLength(0);
    expect(getTitle(hades)!.routes).toHaveLength(2);
    expect(facets(new Set(["steam"]))).toMatchObject({ titles: 1, kinds: { native: 1 }, platforms: { pc: 1 } });
    expect(facets().titles).toBe(3);
    expect(queryTitles({ sources: new Set() }).total).toBe(0);                            // nothing enabled: nothing shown
  });
});

describe("settings defaults", () => {
  test("a text field the user emptied stays empty; a field never set gets its default; an emptied number falls back", () => {
    const d = registry.definition("indexer", "prowlarr")!;
    expect(registry.withDefaults(d.fields, { url: "http://p:9696", apiKey: "k", categories: "" }).categories).toBe("");
    expect(registry.withDefaults(d.fields, { url: "http://p:9696", apiKey: "k" }).categories).toBe("4000");
    const rt = registry.definition("downloadClient", "rtorrent")!;
    expect(registry.withDefaults(rt.fields, { url: "https://box/rpc", seedRatio: "" }).seedRatio).toBe(1);
    expect(registry.withDefaults(rt.fields, { url: "https://box/rpc", label: "" }).label).toBe("");
  });
});
