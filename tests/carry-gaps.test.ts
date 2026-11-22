/**
 * What a plan made before the content model could say more still lacks (src/ways/gaps.ts): the upgrade round runs only
 * when there is a gap, and its brief lists them.
 */
import { describe, expect, test } from "bun:test";
import { factsIn, upgradeGaps } from "../src/ways/gaps";
import { kytyCheck, kytyPlan, kytyUpgraded, kytyWay, nx2navi, nx2naviContent, nx2naviOnServer, zeldaPlan } from "./carry-world";

describe("upgradeGaps", () => {
  test("way 1 of Demon's Souls: a .zar only ZArchive makes and no recipe, and no check", () => {
    expect(upgradeGaps(kytyPlan(), kytyWay(), "emulator")).toEqual([
      "it takes a .zar file, which is packed from the game folder with ZArchive, and the plan has no recipe that makes one (content.make) and does not say only the game's owner can make it (content.personalDump)",
      "the plan runs no check on the server before the package is offered (check)",
    ]);
    // the upgraded way, with its own check: nothing left
    expect(upgradeGaps({ ...kytyPlan(), check: kytyCheck }, kytyUpgraded(), "emulator")).toEqual([]);
  });

  test("NX2navi: the ids written only in words, who makes a .nup, no check, nothing that proves the file", () => {
    expect(upgradeGaps(nx2navi(), null, "recomp")).toEqual([
      "it takes a .nup file, which is made by Eglantine on the console, and the plan has no recipe that makes one (content.make) and does not say only the game's owner can make it (content.personalDump)",
      "what names the title id 0400486024DEC000, which accept.serials does not list",
      "what names the build e0f3ccfa, which accept.builds does not list",
      "what names the version 1.1.1, which accept.versions does not list",
      "the plan runs no check on the server before the package is offered (check)",
      "content.accept: nothing proves the game file — a recomp or port keeps at least one of hashes, serials and builds (a wrong game is far worse than none)",
    ]);
    expect(upgradeGaps({ ...nx2naviOnServer(), content: nx2naviContent() }, null, "recomp")).toEqual([]);
  });

  test("Zelda 64: Recompiled: proven by hash, only the check is missing", () => {
    expect(upgradeGaps(zeldaPlan(), null, "recomp")).toEqual(["the plan runs no check on the server before the package is offered (check)"]);
    expect(upgradeGaps(zeldaPlan(true), null, "recomp")).toEqual([]);
  });
});

describe("factsIn", () => {
  test("title ids (with or without a separator), Switch title ids, build ids next to 'build', versions as consoles and releases write them", () => {
    expect(factsIn("Demon's Souls PPSA-01342 and PPSA01341 at 01.007.000")).toEqual({ serials: ["PPSA01342", "PPSA01341"], builds: [], versions: ["01.007.000"] });
    expect(factsIn("program 0400486024DEC000, main build e0f3ccfa, with the v1.1.1 update")).toEqual({ serials: ["0400486024DEC000"], builds: ["e0f3ccfa"], versions: ["1.1.1"] });
    expect(factsIn("build id: E0F3CCFAF50065AE4EA01EB5AEB13B1A")).toEqual({ serials: [], builds: ["e0f3ccfaf50065ae4ea01eb5aeb13b1a"], versions: [] });
    expect(factsIn("needs Vulkan 1.3 and 16 GB of RAM")).toEqual({ serials: [], builds: [], versions: [] });
    expect(factsIn("version 1.05 or the 1.07 update")).toEqual({ serials: [], builds: [], versions: ["1.05", "1.07"] });
  });

  test("ids already accepted are no gap, in any spelling", () => {
    const c = { ...kytyUpgraded(), what: "Demon's Souls PPSA-01342 at version 1.07" };
    expect(upgradeGaps({ ...kytyPlan(), check: kytyCheck }, c, "emulator")).toEqual([]);
  });
});
