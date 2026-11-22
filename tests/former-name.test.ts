/**
 * The engine's former name (src/former.ts): a server set up as playarr keeps working after the rename. What it still
 * has under the old name is read; what is written goes under the new one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseFile, db, kv } from "../src/db";
import { cfg, configSource, writeConfig } from "../src/config";
import { adoptFormerEnv, formerKey, formerName, withFormerEnv } from "../src/former";
import * as registry from "../src/plugins/registry";
import { pinFormerDefaults } from "../src/bootstrap";
import { BUILTIN } from "../src/plugins/builtin";

const tmp = mkdtempSync(join(tmpdir(), "former-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the environment", () => {
  test("an old name counts as the new one; a new one that is set wins", () => {
    const env: Record<string, string | undefined> = { PLAYARR_GAMES: "/library", PLAYARR_WORK: "/old", LUDARR_WORK: "/new", OTHER: "x" };
    adoptFormerEnv(env);
    expect(env).toMatchObject({ LUDARR_GAMES: "/library", LUDARR_WORK: "/new", OTHER: "x" });
    expect(formerKey("LUDARR_ARRIVALS")).toBe("PLAYARR_ARRIVALS");
    expect(formerKey("IMPORT_PARALLEL")).toBeNull();
  });
  test("a script gets its variables under both names", () => {
    expect(withFormerEnv({ LUDARR_EVENT: "imported", LUDARR_TITLE: "A game" })).toEqual({ LUDARR_EVENT: "imported", LUDARR_TITLE: "A game", PLAYARR_EVENT: "imported", PLAYARR_TITLE: "A game" });
  });
});

describe("the database file", () => {
  test("a fresh folder gets ludarr.db; a folder with only the old database keeps it; the new one wins once it is there", () => {
    const fresh = mkdtempSync(join(tmp, "fresh-")), old = mkdtempSync(join(tmp, "old-"));
    expect(databaseFile(fresh)).toBe(join(fresh, "ludarr.db"));
    writeFileSync(join(old, formerName("ludarr.db")), "");
    expect(databaseFile(old)).toBe(join(old, "playarr.db"));
    writeFileSync(join(old, "ludarr.db"), "");
    expect(databaseFile(old)).toBe(join(old, "ludarr.db"));
  });
});

describe("saved settings", () => {
  test("one saved under the old name is read; saving writes the new name; putting it back to the default clears both", () => {
    kv.del("cfg.LUDARR_ARRIVALS");
    kv.set("cfg.PLAYARR_ARRIVALS", "/mnt/finished");
    expect(cfg("LUDARR_ARRIVALS")).toBe("/mnt/finished");
    expect(configSource("LUDARR_ARRIVALS")).toBe("saved");
    expect(writeConfig({ LUDARR_ARRIVALS: "/mnt/elsewhere" }).changed).toEqual(["LUDARR_ARRIVALS"]);
    expect(kv.get("cfg.LUDARR_ARRIVALS")).toBe("/mnt/elsewhere");
    expect(cfg("LUDARR_ARRIVALS")).toBe("/mnt/elsewhere");
    expect(writeConfig({ LUDARR_ARRIVALS: "/arrivals" }).changed).toEqual(["LUDARR_ARRIVALS"]);          // its default
    expect(kv.get("cfg.LUDARR_ARRIVALS")).toBeNull();
    expect(kv.get("cfg.PLAYARR_ARRIVALS")).toBeNull();
    expect(configSource("LUDARR_ARRIVALS")).toBe("default");
  });
});

describe("download clients", () => {
  for (const p of BUILTIN) if (!registry.definition("downloadClient", "nzbget")) registry.registerPlugin(p, "builtin");
  test("one that relied on the old default label or category keeps it, once; one made afterwards gets the new default", () => {
    kv.del("former.labels-pinned");
    const set = registry.createInstance("downloadClient", "nzbget", { name: "set", enabled: false, settings: { url: "https://box/nzbget", category: "games" } });
    const bare = registry.createInstance("downloadClient", "nzbget", { name: "bare", enabled: false, settings: { url: "https://box/nzbget" } });
    db.query("UPDATE plugin_instances SET settings_json=? WHERE id=?").run(JSON.stringify({ url: "https://box/nzbget" }), bare.id);   // as an old row: no category of its own
    expect(pinFormerDefaults()).toBe(1);
    expect(JSON.parse(registry.instanceRow(bare.id)!.settings_json).category).toBe("playarr");
    expect(JSON.parse(registry.instanceRow(set.id)!.settings_json).category).toBe("games");
    expect(pinFormerDefaults()).toBe(0);                                                                   // once
    const later = registry.createInstance("downloadClient", "nzbget", { name: "later", enabled: false, settings: { url: "https://box/nzbget" } });
    expect(JSON.parse(later.settings_json).category).toBe("ludarr");
    for (const r of [set, bare, later]) registry.deleteInstance(r.id);
  });
});
