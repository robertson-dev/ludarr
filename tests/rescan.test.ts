import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, kv, stmts, type GameRow } from "../src/db";
import { rescanLibrary, rsdeps, unmappedFolders } from "../src/library/rescan";
import { addRootFolder, rootFolders } from "../src/library/rootfolders";
import { healthChecks } from "../src/health";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";

for (const p of BUILTIN) registry.registerPlugin(p, "builtin");
const game = (name: string) => stmts.upsertGame({ igdb_id: null, steam_appid: null, name, slug: name.toLowerCase().replace(/\W+/g, "-"), summary: null, storyline: null, release_year: null, first_release_date: null, rating: null, cover_url: null, banner_url: null, screenshots_json: "[]", genres_json: "[]", themes_json: "[]", platforms_json: '["win"]', game_modes_json: "[]", developer: null, publisher: null }) as GameRow;
const pkg = (gameId: number, path: string, name: string) => stmts.insertPackage.get(gameId, null, path, name, null, 1, "{}");

let root = "";
beforeEach(() => {
  db.exec("DELETE FROM packages; DELETE FROM games; DELETE FROM history; DELETE FROM root_folders; DELETE FROM plugin_instances WHERE kind='downloadClient'");
  registry.clearCache();
  root = mkdtempSync(join(tmpdir(), "ludarr-lib-"));
  rsdeps.rootFolders = () => rootFolders();
});

describe("rescan", () => {
  test("a copy deleted by hand stops counting; an intact one stays; folders no game accounts for are listed", async () => {
    addRootFolder(root);
    const hk = game("Hollow Knight"), dd = game("Dave the Diver");
    mkdirSync(join(root, "hollow-knight")); writeFileSync(join(root, "hollow-knight", "ahoy.json"), "{}");
    mkdirSync(join(root, "Some.Game-RUNE")); mkdirSync(join(root, ".work"));
    pkg(hk.id, join(root, "hollow-knight"), "Hollow Knight"); pkg(dd.id, join(root, "dave-the-diver"), "Dave the Diver");
    stmts.setGamePath.run(join(root, "dave-the-diver"), dd.id);
    expect(await rescanLibrary()).toEqual({ missing: 1, skipped: [] });
    expect((stmts.packagesAll.all() as { name: string }[]).map(p => p.name)).toEqual(["Hollow Knight"]);
    expect((stmts.gameById.get(dd.id) as GameRow).path).toBeNull();
    expect((db.query("SELECT event, message FROM history").all() as { event: string; message: string }[])).toEqual([{ event: "deleted", message: `the copy at ${join(root, "dave-the-diver")} is gone from disk` }]);
    const un = await unmappedFolders(rootFolders()[0]);
    expect(un.map(u => u.name)).toEqual(["Some.Game-RUNE"]);               // not the known copy, not the hidden work folder
    expect(un[0].path).toBe(join(root, "Some.Game-RUNE"));
  });
  test("a root folder that reads empty while copies are recorded there (a volume that is down) is not judged", async () => {
    addRootFolder(root);
    const hk = game("Hollow Knight");
    pkg(hk.id, join(root, "hollow-knight"), "Hollow Knight");
    expect(await rescanLibrary()).toEqual({ missing: 0, skipped: [root] });
    expect(stmts.packagesAll.all()).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });                            // unreadable altogether: the same
    expect(await rescanLibrary()).toEqual({ missing: 0, skipped: [root] });
    expect(stmts.packagesAll.all()).toHaveLength(1);
  });
});

describe("health: remote path mapping", () => {
  test("a mapped folder that is missing is a warning, an empty one a notice, a populated one nothing", async () => {
    const mapping = async (to: string) => {
      db.exec("DELETE FROM plugin_instances WHERE kind='downloadClient'"); registry.clearCache();
      registry.createInstance("downloadClient", "rtorrent", { name: "rT", settings: { url: "https://box/rpc", pathMap: `/home/u/downloads=${to}` } as never });
      return (await healthChecks(true)).filter(i => i.source === "RemotePathMapping");
    };
    expect((await mapping(join(root, "nope")))[0]).toMatchObject({ type: "warning", message: expect.stringContaining("is not reachable") });
    mkdirSync(join(root, "remote"));
    expect((await mapping(join(root, "remote")))[0]).toMatchObject({ type: "notice", message: expect.stringContaining("is empty") });
    mkdirSync(join(root, "remote", "Game-RUNE"));
    expect(await mapping(join(root, "remote"))).toEqual([]);
  });
  test("one onto the finished-downloads folder (downloads/finished) is no mount: said once, by that folder's own line, never with its path", async () => {
    const finished = join(root, "downloads", "finished");
    mkdirSync(finished, { recursive: true });                           // empty, as its hourly cleanup often leaves it
    kv.set("cfg.LUDARR_ARRIVALS", finished);
    try {
      db.exec("DELETE FROM plugin_instances WHERE kind='downloadClient'"); registry.clearCache();
      registry.createInstance("downloadClient", "rtorrent", { name: "rT", settings: { url: "https://box/rpc", pathMap: `/home/u/downloads/complete=${finished}` } as never });
      const said = (await healthChecks(true)).filter(i => i.message.startsWith("rT"));
      expect(said.map(i => [i.type, i.source])).toEqual([["error", "FinishedDownloads"]]);
      expect(said[0].message).not.toContain(finished);
      kv.set("cfg.LUDARR_ARRIVALS", "");                            // the folder off: the mapping is a mount like any other
      expect((await healthChecks(true)).filter(i => i.message.startsWith("rT")).map(i => [i.type, i.source])).toEqual([["notice", "RemotePathMapping"]]);
    } finally { kv.del("cfg.LUDARR_ARRIVALS"); }
  });
});
