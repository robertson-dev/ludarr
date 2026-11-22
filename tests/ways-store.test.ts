import { describe, expect, test } from "bun:test";
import { db, stmts, upsertGame, activeBuilds } from "../src/db";
import { getPlan, insertContent, insertPlan, insertWay, planPinned, serializePlan, serializeWay, uniquePlanSlug, updatePlan, updateWay, wayContent, wstmts } from "../src/ways/store";
import { contentMatches, needsMet } from "../src/ways/match";
import { enqueueJob } from "../src/process/kinds";
import type { RuntimePlanSpec } from "../src/ways/types";

const spec = (): RuntimePlanSpec => ({
  program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "Zelda64Recompiled.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "Majora's Mask, NTSC-U 1.0", search: ["The Legend of Zelda: Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: "d6133ace5afaa0882cf214cf88daba39e266c078" }], formats: ["z64"] }, normalize: "n64-z64", place: "mm.n64.us.1.0.z64" },
  files: [{ path: "portable.txt", text: "" }], setup: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: "",
});

describe("ways store", () => {
  test("plans get unique slugs; a changed program drops the pin", () => {
    const a = insertPlan({ name: "Zelda 64: Recompiled", kind: "recomp", repo: "Zelda64Recomp/Zelda64Recomp", platforms: ["n64"], spec: spec() });
    expect(a.slug).toBe("zelda-64-recompiled");
    expect(uniquePlanSlug("Zelda 64: Recompiled")).toBe("zelda-64-recompiled-2");
    wstmts.setPinned.run(JSON.stringify({ tag: "v1.2.2", asset: "x.zip", url: "https://x", size: 1, sha256: "a".repeat(64), pinnedAt: 1 }), a.id);
    expect(planPinned(getPlan(a.id)!)?.tag).toBe("v1.2.2");
    updatePlan(a.id, { name: "Zelda 64 Recompiled" });
    expect(planPinned(getPlan(a.id)!)?.tag).toBe("v1.2.2");          // a rename keeps it
    const s = spec(); (s.program as any).assetPattern = "^Other-.*[.]zip$";
    updatePlan(a.id, { spec: s });
    expect(planPinned(getPlan(a.id)!)).toBeNull();
    expect(serializePlan(getPlan(a.id)!).spec.program).toMatchObject({ assetPattern: "^Other-.*[.]zip$" });
  });

  test("a way takes the plan's game file plan unless it has its own; one way per game and plan", () => {
    const g = upsertGame({ steam_appid: 990001, name: "Store game", slug: "store-game" });
    const p = insertPlan({ name: "Emu", kind: "emulator", repo: "a/emu", platforms: ["gc"], spec: { ...spec(), content: { ...spec().content!, platform: "gc", accept: { hashes: [] }, normalize: null, place: "games/{name}" } } });
    const w = insertWay({ gameId: g.id, planId: p.id });
    expect(wayContent(w, p)?.platform).toBe("gc");
    const own = { ...spec().content!, platform: "gc" as const, normalize: null, place: "games/{name}", search: ["Store game"] };
    expect(wayContent(updateWay(w.id, { content: own })!, p)?.search).toEqual(["Store game"]);
    expect(() => insertWay({ gameId: g.id, planId: p.id })).toThrow();
    expect(serializeWay(w, p)).toMatchObject({ gameId: g.id, planName: "Emu", status: "needs-files" });
  });

  test("build jobs count per game while queued or running", () => {
    const g = upsertGame({ steam_appid: 990002, name: "Built game", slug: "built-game" });
    const j = enqueueJob({ kind: "assemble", wayId: 1 }, { gameId: g.id });
    expect(j.kind).toBe("assemble");
    expect(j.input_path).toBe("way:1");
    expect(activeBuilds().get(g.id)?.id).toBe(j.id);
    stmts.setJobFailed.run("failed", "x", j.id);
    expect(activeBuilds().has(g.id)).toBe(false);
  });
});

describe("matching game files", () => {
  const c = spec().content!;
  test("a listed hash must match, normalised or as received", () => {
    expect(contentMatches(c, { platform: "n64", name: "mm.z64", size: 1, hashes: { sha1: "d6133ace5afaa0882cf214cf88daba39e266c078" } }).ok).toBe(true);
    expect(contentMatches(c, { platform: "n64", name: "mm.z64", size: 1, hashes: { sha1: "0".repeat(40) }, rawHashes: { sha1: "d6133ace5afaa0882cf214cf88daba39e266c078" } }).ok).toBe(true);
    const v = contentMatches(c, { platform: "n64", name: "mm.z64", size: 1, hashes: { sha1: "1".repeat(40) } });
    expect(v.ok).toBe(false);
    expect(v.why).toContain("not the version this needs (its sha1 is 1111");
  });
  test("platform and format first", () => {
    expect(contentMatches(c, { platform: "snes", name: "x.z64", size: 1, hashes: {} }).why).toContain("a snes file");
    expect(contentMatches(c, { platform: "n64", name: "x.zip", size: 1, hashes: {} }).why).toContain("a .zip file");
  });
  test("needs: a matching system file per slot", () => {
    const s = { ...spec(), needs: [{ kind: "bios" as const, name: "PS2 BIOS", place: "bios/scph.bin", accept: { sizes: [4194304] } }] };
    expect(needsMet(s, []).missing.map(m => m.name)).toEqual(["PS2 BIOS"]);
    expect(needsMet(s, [{ needIndex: 0, platform: null, name: "scph.bin", size: 4194304, hashes: {} }]).met).toBe(true);
    expect(needsMet(s, [{ needIndex: 0, platform: null, name: "scph.bin", size: 10, hashes: {} }]).missing[0].why).toContain("10 bytes");
  });
  test("a content row stores both hash sets", () => {
    const row = insertContent({ name: "mm.z64", path: "/x/mm.z64", size: 32, hashes: { sha1: "a".repeat(40) }, rawHashes: { sha1: "b".repeat(40) }, normalized: "n64: v64 -> z64", source: "upload" });
    expect(JSON.parse(row.raw_hashes_json!).sha1).toBe("b".repeat(40));
    db.query("DELETE FROM contents WHERE id=?").run(row.id);
  });
});
