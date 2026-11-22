import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { ingest, getTitle, queryTitles } from "../src/catalog/store";
import { PORTS, portsProvider, portRuntime } from "../src/catalog/providers/ports";
import { seedContributions, splitTitle, type SeedRow } from "../src/catalog/providers/ports-seed";
import { sceneContributions, sceneTitle } from "../src/catalog/providers/scene";
import { isPlatform, STATUS_ORDER } from "../src/catalog/types";

beforeEach(() => db.exec("DELETE FROM routes; DELETE FROM title_names; DELETE FROM title_ids; DELETE FROM titles; DELETE FROM runtimes; DELETE FROM catalog_sources;"));
const ctx = { log: () => {}, fetch };

describe("curated ports registry", () => {
  test("every entry is well-formed: unique id, compiling asset pattern, known platforms and statuses, hex hashes", () => {
    expect(new Set(PORTS.map(p => p.id)).size).toBe(PORTS.length);
    for (const p of PORTS) {
      expect(() => new RegExp(p.asset)).not.toThrow();
      expect(p.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(p.games.length).toBeGreaterThan(0);
      for (const g of p.games) { expect(isPlatform(g.platform)).toBe(true); expect(g.year).toBeGreaterThan(1980); }
      expect(STATUS_ORDER).toContain(p.status);
      for (const x of p.data.hashes ?? []) expect(x.value).toMatch(/^[0-9a-fA-F]{8,64}$/);
      expect(p.data.how.length).toBeGreaterThan(10);
    }
  });
  test("asset patterns pick the Windows build from the release names seen live", () => {
    const seen: Record<string, string> = {
      zelda64recomp: "Zelda64Recompiled-v1.2.2-Windows.zip", shipwright: "SoH-Ackbar-Delta-Win64.zip", "2ship2harkinian": "2Ship-Battler-Bravo-Win64.zip",
      sm64coopdx: "sm64coopdx_Windows.zip", opengoal: "opengoal-windows-v0.3.9.zip", devilutionx: "devilutionx-windows-x86_64.zip", dk64recomp: "DK64Recompiled-Windows-Release-1-0-3.zip",
      unleashedrecomp: "UnleashedRecomp-Windows.zip", dusklight: "Dusklight-v2.0.3-win32-x86_64.zip", goldeneyerecomp: "GoldenEye-Recomp-Win.rar",
    };
    for (const [id, name] of Object.entries(seen)) expect(new RegExp(PORTS.find(p => p.id === id)!.asset).test(name)).toBe(true);
    expect(new RegExp(PORTS.find(p => p.id === "zelda64recomp")!.asset).test("Zelda64Recompiled-v1.2.2-Linux.zip")).toBe(false);
  });
  test("collected into titles: one title per game, shared by every port of it; runtimes carry the launch", async () => {
    const items = await portsProvider.collect(ctx);
    ingest(portsProvider, items, PORTS.map(portRuntime));
    const mm = getTitle(queryTitles({ q: "majoras mask" }).titles[0].id)!;
    expect(mm.routes.map(r => r.label)).toEqual(["Zelda 64: Recompiled", "2 Ship 2 Harkinian"]);
    expect(mm.routes[0]).toMatchObject({ kind: "recomp", status: "perfect", launch: { exe: "Zelda64Recompiled.exe" } });
    expect((mm.routes[0].content as any).accept.hashes[0]).toEqual({ algo: "xxh3-64", value: "EF18B4A9E2386169", label: "checked", of: "big-endian ROM" });
    expect(queryTitles({ runtime: "opengoal" }).titles.map(t => t.name).sort()).toEqual(["Jak 3", "Jak II", "Jak and Daxter: The Precursor Legacy"]);
    expect(getTitle(queryTitles({ q: "dinosaur planet" }).titles[0].id)!.routes[0].provenance).toBe("prototype");
  });
});

describe("community seed list", () => {
  const row = (o: Partial<SeedRow>): SeedRow => ({ id: "x", title: "Game (Port)", platform: "N64", type: "static-recomp", repo: "o/game-recomp", stars: 100, archived: false, release: "v1", release_date: "2026-01-01T00:00:00Z", ...o });
  test("released, not archived, 25+ stars, a known platform, a Windows target, not already curated", () => {
    const rows = [
      row({}), row({ repo: "o/no-release", release: null }), row({ repo: "o/old", archived: true }), row({ repo: "o/tiny", stars: 3 }),
      row({ repo: "o/zx", platform: "ZX Spectrum" }), row({ repo: "o/tool", type: "tool" }), row({ repo: "o/zelda64recomp-android", title: "Zelda64 Recompiled [Android]" }),
      row({ repo: "HarbourMasters/Shipwright" }), row({ repo: "o/oot-psp" }),
    ];
    const { items, runtimes } = seedContributions(rows, new Set(["harbourmasters/shipwright"]));
    expect(items.map(i => i.routes[0].key)).toEqual(["o/game-recomp"]);
    expect(items[0]).toMatchObject({ title: { name: "Game", platforms: ["n64"] }, routes: [{ kind: "recomp", status: "unknown", label: "Port", runtime: "gh-o-game-recomp" }] });
    expect(runtimes[0]).toMatchObject({ channel: "seed", latest: { tag: "v1" } });
    expect(splitTitle("The Legend of Zelda: Ocarina of Time (Ship of Harkinian)")).toEqual({ game: "The Legend of Zelda: Ocarina of Time", label: "Ship of Harkinian" });
  });
});

describe("scene releases", () => {
  test("release names → game names; DLC, updates and non-Windows rips are not games", () => {
    expect(sceneTitle("Trails.in.the.Sky.2nd.Chapter.Deluxe.Edition.incl.DLC.PS5-DUPLEX")).toEqual({ name: "Trails in the Sky 2nd Chapter", group: "DUPLEX" });
    expect(sceneTitle("SILENT.HILL.Townfall.Deluxe.Edition.PS5-DUPLEX")?.name).toBe("SILENT HILL Townfall");
    expect(sceneTitle("Super_Game_v1.2.0_NSW-VENOM")?.name).toBe("Super Game");
    expect(sceneTitle("SOMEWHERE_SMALL_Nature_Pack_DLC_NSW-SUXXORS")).toBeNull();
    expect(sceneTitle("Transport_Fever_3_Linux-Razor1911")).toBeNull();
    expect(sceneTitle("Some.Game.Update.v1.02.PS5-DUPLEX")).toBeNull();
  });
  test("a PC release before the game's release date is a leak; unknown PC games are skipped; console releases create titles", () => {
    ingest({ id: "steam", metaRank: 80 }, [{ title: { ids: [{ scheme: "steam", value: "1" }], name: "Future Game", platforms: ["pc"], releaseIso: "2099-01-01" }, routes: [{ key: "app/1", kind: "native", platform: "pc" }] }]);
    const pre = (id: number, name: string) => ({ id, name, team: name.split("-").pop()!, cat: "x", size: 2048, files: 10, preAt: 1792000000, nuke: null });
    const pc = sceneContributions([pre(1, "Future.Game-RUNE"), pre(2, "Unknown.Game-TENOKE")], "pc", true);
    expect(pc).toHaveLength(1);
    expect(pc[0].routes[0]).toMatchObject({ key: "predb:1", kind: "native", provenance: "leak", label: "RUNE release", content: { from: [{ type: "release", title: "Future.Game-RUNE", size: 2048 * 1024 * 1024 }] } });
    const ps5 = sceneContributions([pre(3, "Brand.New.PS5-DUPLEX")], "ps5", false);
    expect(ps5[0]).toMatchObject({ title: { name: "Brand New", platforms: ["ps5"] }, routes: [{ kind: "emulated", runtime: "sharpemu", provenance: "retail", status: "unknown" }] });
  });
});
