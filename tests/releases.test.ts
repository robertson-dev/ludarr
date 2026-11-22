import { describe, expect, test } from "bun:test";
import { buildQuery, parseTitle, matchTitle, rankReleases, rankForNames, nameQueries, certainlyThisGame, nameRefusals, nameWords, inOrder, wrongKind, tokens, type ReleaseView } from "../src/releases";
import { platformId } from "../src/platforms";
import type { PlatformId } from "../src/platforms";
import type { ProwlarrRelease } from "../src/prowlarr";

const rel = (over: Partial<ProwlarrRelease>): ProwlarrRelease => ({
  guid: Math.random().toString(36).slice(2), title: "", instanceId: 0, indexerId: 1, indexer: "T", size: 20e9, age: 10,
  publishDate: "", seeders: 10, leechers: 0, grabs: null, files: null, downloadUrl: "http://x/dl", magnetUrl: null,
  infoUrl: null, infoHash: null, protocol: "torrent", categories: [], indexerFlags: [], fileName: null, ...over,
});

describe("tokens / buildQuery", () => {
  test("roman numerals and apostrophes normalize", () => {
    expect(tokens("Baldur's Gate III")).toEqual(["baldurs", "gate", "3"]);
    expect(tokens("Marvel’s Spider-Man")).toEqual(["marvels", "spider", "man"]);
  });
  test("subtitle becomes optional, edition words and phrases are dropped", () => {
    const q = buildQuery("The Witcher 3: Wild Hunt - Game of the Year Edition");
    expect(q.core).toEqual(["witcher", "3"]);
    expect(q.optional).toEqual(["wild", "hunt"]);
    expect(q.queries).toEqual(["The Witcher 3 Wild Hunt", "The Witcher 3"]);
  });
  test("trademark glyphs vanish, single query when nothing to split", () => {
    expect(buildQuery("ELDEN RING™").queries).toEqual(["ELDEN RING"]);
    expect(buildQuery("Hades").core).toEqual(["hades"]);
  });
  test("deluxe edition on a Steam app id keeps the base-game tokens as core", () => {
    const q = buildQuery("Hollow Knight Deluxe Edition");
    expect(q.core).toEqual(["hollow", "knight"]);
  });
});

describe("parseTitle", () => {
  test("FitGirl repack with version, edition, dlc", () => {
    const p = parseTitle("ELDEN RING Shadow of the Erdtree Deluxe Edition v1.12.3 + DLCs [FitGirl Repack]");
    expect(p).toMatchObject({ group: "FitGirl", repack: true, scene: false, version: "1.12.3", edition: "Deluxe", dlc: true, junk: [] });
  });
  test("scene GOG release", () => {
    expect(parseTitle("Hollow.Knight.v1.5.78.11833-GOG")).toMatchObject({ group: "GOG", scene: true, version: "1.5.78.11833" });
    expect(parseTitle("Hades-CODEX")).toMatchObject({ group: "CODEX", scene: true, repack: false });
  });
  test("update-only is junk unless the base game is bundled", () => {
    expect(parseTitle("Hades.II.Update.v1.143476-RUNE").junk).toEqual(["update-only"]);
    expect(parseTitle("Some.Game.Incl.Update.5-PLAZA").junk).toEqual([]);
    expect(parseTitle("Game v1.2 + Update 3 [DODI Repack]").junk).toEqual([]);
  });
  test("trainers, soundtracks, dlc packs are junk", () => {
    expect(parseTitle("Hades Trainer +12 FLiNG").junk).toContain("trainer");
    expect(parseTitle("Hades Original Soundtrack FLAC").junk).toContain("soundtrack");
    expect(parseTitle("Cyberpunk 2077 DLC Pack-SKIDROW").junk).toContain("dlc-only");
  });
  test("build numbers and language counts", () => {
    expect(parseTitle("Baldurs Gate 3 Build 12345678 MULTi12-ElAmigos")).toMatchObject({ version: "build 12345678", languages: 12, group: "ElAmigos", repack: true });
  });
  test("GazelleGames trailer: year, platform, format, tag", () => {
    expect(parseTitle("Hades-CODEX (2020) [Windows / Multi-Language / Full ISO]"))
      .toMatchObject({ group: "CODEX", scene: true, year: 2020, platform: "Windows", format: "Full ISO", junk: [] });
    expect(parseTitle("Hades (2020) [Windows / Multi-Language / Home Rip]"))
      .toMatchObject({ group: null, year: 2020, format: "Home Rip", junk: [] });
    expect(parseTitle("HADES.Build.10929685.REPACK-KaOs (2020) [Windows / Multi-Language / P2P Full Repack]"))
      .toMatchObject({ group: "KaOs", repack: true, version: "build 10929685" });
    expect(parseTitle("Hades II v1.137792 + Bonus OST [FitGirl Repack] (2025) [Windows / Multi-Language / P2P Full Repack]"))
      .toMatchObject({ group: "FitGirl", repack: true, year: 2025, junk: [] });   // bundled OST is not a soundtrack-only release
    expect(parseTitle("Hades.Update.v1.38246-CODEX (2020) [Windows / Multi-Language / GameDOX] [Update]").junk).toEqual(["update-only"]);
    expect(parseTitle("Hades.v1.0-v1.38.Plus.15.Trainer.x64-FLiNG (2020) [Windows / Multi-Language / GameDOX] [Trainer]").junk).toContain("trainer");
    expect(parseTitle("Hades II (2025) [Mac / Multi-Language / Home Rip]").platform).toBe("Mac");
  });
});

describe("matchTitle / rankReleases", () => {
  const q = buildQuery("Hades");
  test("core tokens must all be present", () => {
    expect(matchTitle(q, "Hades-CODEX").ok).toBe(true);
    expect(matchTitle(q, "Hollow.Knight-GOG").ok).toBe(false);
    expect(matchTitle(buildQuery("Hades II"), "Hades-CODEX").ok).toBe(false);
    expect(matchTitle(buildQuery("Hades II"), "Hades.2.v1.0-RUNE").ok).toBe(true);
  });
  test("ranking: repack with seeders first, sequel / buried-name / dead / update-only pushed down, mismatch dropped", () => {
    const rows = [
      rel({ title: "Hades-CODEX", seeders: 0 }),
      rel({ title: "Hades.II-RUNE", seeders: 50 }),
      rel({ title: "Hades v1.38 [FitGirl Repack]", seeders: 30, size: 4e9 }),
      rel({ title: "Daymare 1998 HADES Dead End-HOODLUM", seeders: 5 }),
      rel({ title: "Hades.Update.v1.38-CODEX", seeders: 40, size: 3e8 }),
      rel({ title: "Hollow.Knight-GOG", seeders: 99 }),
    ];
    const out = rankReleases(q, rows);
    expect(out.map(r => r.title)).not.toContain("Hollow.Knight-GOG");
    expect(out[0].title).toBe("Hades v1.38 [FitGirl Repack]");
    const by = Object.fromEntries(out.map(r => [r.title, r]));
    expect(by["Hades.II-RUNE"].reasons).toContain("looks like a sequel / other entry");
    expect(by["Daymare 1998 HADES Dead End-HOODLUM"].reasons.join()).toContain("name not at start");
    expect(by["Hades-CODEX"].reasons).toContain("no seeders");
    expect(by["Hades.Update.v1.38-CODEX"].reasons).toContain("update-only");
    expect(by["Hades v1.38 [FitGirl Repack]"].score).toBeGreaterThan(by["Hades.II-RUNE"].score);
  });
  test("a digital comic that shares the game's name is flagged as the wrong kind", () => {
    const q = buildQuery("Bloodborne");
    const out = rankReleases(q, [
      rel({ title: "Bloodborne 001 (2026) (Digital) (Titan Comics) (LeDuch).cbz", seeders: 20 }),
      rel({ title: "Bloodborne - The Death of Sleep v01 (2019) (Digital-HD) (webp)", seeders: 20 }),
      rel({ title: "Bloodborne.PS4-DUPLEX", seeders: 20 }),
      rel({ title: "Bloodborne.Digital.Deluxe.Edition-RUNE", seeders: 20 }),
    ], { loose: true });
    const by = Object.fromEntries(out.map(r => [r.title, r]));
    expect(by["Bloodborne 001 (2026) (Digital) (Titan Comics) (LeDuch).cbz"].flags.wrongKind).toBe("a comic book, not a game");
    expect(by["Bloodborne - The Death of Sleep v01 (2019) (Digital-HD) (webp)"].flags.wrongKind).toBe("a comic book, not a game");
    expect(by["Bloodborne.PS4-DUPLEX"].flags.wrongKind).toMatch(/ps4/i);
    expect(by["Bloodborne.Digital.Deluxe.Edition-RUNE"].flags.wrongKind).toBeNull();
  });
  test("loose mode keeps mismatches but scores them lower", () => {
    const out = rankReleases(q, [rel({ title: "Hades-CODEX", seeders: 5 }), rel({ title: "Hollow.Knight-GOG", seeders: 99 })], { loose: true });
    expect(out.map(r => r.title)).toEqual(["Hades-CODEX", "Hollow.Knight-GOG"]);
  });
  test("same torrent on several trackers collapses to one row", () => {
    const out = rankReleases(q, [
      rel({ title: "Hades-CODEX", indexer: "A", infoHash: "abc", seeders: 3, indexerId: 1 }),
      rel({ title: "Hades-CODEX", indexer: "B", infoHash: "ABC", seeders: 9, indexerId: 2 }),
    ], { privacy: new Map([[1, "private"], [2, "public"]]) });
    expect(out).toHaveLength(1);
    expect(out[0].indexer).toBe("B");
    expect(out[0].alsoOn).toEqual(["A"]);
  });
  test("usenet gets a flat bonus and no seeder math", () => {
    const [u] = rankReleases(q, [rel({ title: "Hades-CODEX", protocol: "usenet", seeders: null })]);
    expect(u.reasons).toContain("usenet");
  });
  test("spin-offs with extra title words rank below the real game; editions do not", () => {
    const hk = rankReleases(buildQuery("Hollow Knight", 2017), [
      rel({ title: "Hollow Knight: Silksong (2025) [Windows / Multi-Language / Home Rip]", seeders: 136, size: 2e9 }),
      rel({ title: "Hollow_Knight_Silksong-FLT (2025) [Windows / Multi-Language / Full ISO]", seeders: 296, size: 2.3e9 }),
      rel({ title: "Hollow Knight: Silksong (2025) [GOG Edition 2025] [Windows / Multi-Language / DRM Free]", seeders: 714, size: 2.5e9 }),
      rel({ title: "Hollow Knight (2017) [GOG Edition 2017] [Windows / Multi-Language / DRM Free]", seeders: 139, size: 1.2e9 }),
      rel({ title: "Hollow.Knight.v1.5.68.11808-CODEX (2017) [Windows / Multi-Language / Full ISO]", seeders: 112, size: 2.2e9 }),
    ]);
    expect(hk[0].title).toBe("Hollow Knight (2017) [GOG Edition 2017] [Windows / Multi-Language / DRM Free]");
    expect(hk[0].reasons).toContain("DRM Free");
    expect(hk[1].title).toContain("CODEX");
    for (const r of hk.slice(2)) expect(r.reasons.join()).toContain('extra title words ("silksong")');   // "[GOG Edition]" is not an edition
    expect(hk[1].score - hk[2].score).toBeGreaterThan(20);

    const er = rankReleases(buildQuery("ELDEN RING", 2022), [
      rel({ title: "ELDEN.RING.NIGHTREIGN-RUNE (2025) [Windows / Multi-Language / Full ISO]", seeders: 165, size: 21e9 }),
      rel({ title: "ELDEN.RING.Tarnished.Edition-RUNE (2022) [Windows / Multi-Language / Full ISO]", seeders: 108, size: 70e9 }),
      rel({ title: "ELDEN.RING-PLAZA (2022) [Windows / Multi-Language / Full ISO]", seeders: 366, size: 49e9 }),
    ]);
    expect(er.map(r => r.title.split(" ")[0])).toEqual(["ELDEN.RING-PLAZA", "ELDEN.RING.Tarnished.Edition-RUNE", "ELDEN.RING.NIGHTREIGN-RUNE"]);
    expect(er[1].reasons.join()).not.toContain("extra title words");
    expect(er[2].reasons.join()).toContain('extra title words ("nightreign")');
  });
  test("real GazelleGames result set for Hades (2020): clean full game first, sequel/mac/gamedox behind", () => {
    const qy = buildQuery("Hades", 2020);
    const rows = [
      rel({ title: "Hades.II.Update.v1.143476-RUNE (2025) [Windows / Multi-Language / GameDOX] [Update]", size: 1e8, seeders: 86 }),
      rel({ title: "Hades.II-RUNE (2025) [Windows / Multi-Language / Full ISO]", size: 8.9e9, seeders: 418 }),
      rel({ title: "HADES.Build.10929685.REPACK-KaOs (2020) [Windows / Multi-Language / P2P Full Repack]", size: 9.4e9, seeders: 140 }),
      rel({ title: "Hades (2020) [Windows / Multi-Language / Home Rip]", size: 10.6e9, seeders: 260 }),
      rel({ title: "Hades-CODEX (2020) [Windows / Multi-Language / Full ISO]", size: 10.9e9, seeders: 93 }),
      rel({ title: "Hades.v1.0-v1.38.Plus.15.Trainer.x64-FLiNG (2020) [Windows / Multi-Language / GameDOX] [Trainer]", size: 0, seeders: 75 }),
      rel({ title: "Hades II (2025) [Mac / Multi-Language / Home Rip]", size: 9e9, seeders: 40 }),
      rel({ title: "Cinders.Of.Hades-TiNYiSO (2021) [Windows / English / Full ISO]", size: 8e8, seeders: 4 }),
      rel({ title: "eXoDOS Collection (1980) [eXoDOS 1992] [DOS / Multi-Language / Home Rip]", size: 685e9, seeders: 45 }),
    ];
    const out = rankReleases(qy, rows);
    const titles = out.map(r => r.title);
    expect(titles).not.toContain("eXoDOS Collection (1980) [eXoDOS 1992] [DOS / Multi-Language / Home Rip]");
    expect(titles.slice(0, 3)).toEqual([
      "Hades (2020) [Windows / Multi-Language / Home Rip]",
      "HADES.Build.10929685.REPACK-KaOs (2020) [Windows / Multi-Language / P2P Full Repack]",
      "Hades-CODEX (2020) [Windows / Multi-Language / Full ISO]",
    ]);
    const by = Object.fromEntries(out.map(r => [r.title, r]));
    expect(by["Hades.II-RUNE (2025) [Windows / Multi-Language / Full ISO]"].reasons).toContain("year 2025 vs 2020");
    expect(by["Hades II (2025) [Mac / Multi-Language / Home Rip]"].reasons).toContain("platform: Mac");
    expect(by["Hades.II.Update.v1.143476-RUNE (2025) [Windows / Multi-Language / GameDOX] [Update]"].reasons).toContain("update-only");
    expect(out[out.length - 1].parsed.junk.length + out[out.length - 2].parsed.junk.length).toBeGreaterThan(0);
  });
});

describe("things that only mention the name (INSIDE, 2026-11-07)", () => {
  const anime = "[T1GGR] Concrete Revolutio Superhuman Phantasmagoria - S01E02 - [Inside the 'Black Smog' (02)] - [Bluray-1080p][AV1][AAC]";
  test("an anime episode whose title names the game is refused twice over: an episode, and the name only in its tags", () => {
    const [v] = rankReleases(buildQuery("INSIDE"), [rel({ title: anime, protocol: "usenet" })], { loose: true });
    expect(v.flags.wrongKind).toContain("episode");
    expect(v.flags.buried).toBe(true);
    expect(v.reasons).toContain("name only inside its tags");
  });
  test("films and shows are refused by their tags or their category", () => {
    const q = buildQuery("INSIDE");
    const [film] = rankReleases(q, [rel({ title: "Inside.2023.1080p.BluRay.x264-GROUP" })], { loose: true });
    expect(film.flags.wrongKind).toContain("a video");
    const [tv] = rankReleases(q, [rel({ title: "INSIDE", categories: [{ id: 5070, name: "TV/Anime" }] as never })], { loose: true });
    expect(tv.flags.wrongKind).toContain("not games");
  });
  test("underscored and dotted titles are read with spaces, and adult videos are named", () => {
    const q = buildQuery("INSIDE");
    const kinds = rankReleases(q, ["Vandaag_Inside_S10E54_DUTCH_1080p_WEB_h264", "Inside Llewyn Davis 2013 COMPLETE UHD BLURAY-4KDVS",
      "SweetSinner.26.09.15.Khloe.Kapri.Slip.Deep.Inside.XXX.1080p.MP4-WRB"].map(title => rel({ title })), { loose: true }).map(v => v.flags.wrongKind);
    expect(kinds.every(k => !!k)).toBe(true);
    expect(kinds.join(" | ")).toContain("episode");
    expect(kinds.join(" | ")).toContain("adult video");
  });
  test("a short name is searched with its year first (a bare \"INSIDE\" found no game on GazelleGames)", () => {
    expect(buildQuery("INSIDE", 2016).queries).toEqual(["INSIDE 2016", "INSIDE"]);
    expect(buildQuery("INSIDE").queries).toEqual(["INSIDE"]);
    expect(buildQuery("The Witcher 3: Wild Hunt", 2015).queries[0]).toBe("The Witcher 3 Wild Hunt");
  });
  test("the game itself still passes", () => {
    const q = buildQuery("INSIDE");
    for (const title of ["INSIDE-GOG", "INSIDE v1.0 [FitGirl Repack]", "Inside (2016) [Windows / English / Home Rip]", "INSIDE.v1.0.x64-RUNE"]) {
      const [v] = rankReleases(q, [rel({ title, categories: [{ id: 4050, name: "PC/Games" }] as never })]);
      expect({ title, kind: v.flags.wrongKind, buried: v.flags.buried }).toEqual({ title, kind: null, buried: false });
    }
  });
});

/* ─────────── Fix A (2026-11-09): "Call of Duty®: Modern Warfare® 4" took Call of Duty 4: Modern Warfare (2007) ─────────── */

/** one title judged under a game's names (its own, then each alias), as the automatic searcher judges it */
const judge = (name: string, year: number | null, title: string, o: { aliases?: string[]; platforms?: PlatformId[]; known?: PlatformId[]; unnamed?: boolean; asked?: string[] } & Partial<ProwlarrRelease> = {}): ReleaseView | undefined => {
  const { aliases = [], platforms, known, unnamed, asked, ...row } = o;
  return rankForNames(nameQueries(name, year, aliases), [rel({ title, ...row })], { platforms, known, unnamed, asked })[0];
};
const certain = (name: string, year: number | null, title: string, o: Parameters<typeof judge>[3] = {}) => { const v = judge(name, year, title, o); return !!v && certainlyThisGame(v); };
const MW4 = "Call of Duty®: Modern Warfare® 4";

describe("R1 — the name's words in the name's order", () => {
  test("every word of the name in another order is another game: the 2007 Call of Duty 4 for Modern Warfare 4, and back", () => {
    for (const title of ["Call.of.Duty.4.Modern.Warfare-Razor1911", "Call.of.Duty.4.Modern.Warfare.v1.7.2.MacOSX.Intel.Cracked-AR", "Call of Duty 4-Modern Warfare Repack-P2P.exe.rar", "Call of Duty 4 Modern Warfare v1.7 [FitGirl Repack]"]) {
      const v = judge(MW4, 2026, title)!;
      expect({ title, reordered: v.flags.reordered, certain: certainlyThisGame(v) }).toEqual({ title, reordered: true, certain: false });
      expect(nameRefusals(v)).toContain("the words of the name are in another order (another game?)");
    }
    expect(certain(MW4, 2026, "Call.of.Duty.Modern.Warfare.4-RUNE")).toBe(true);
    expect(certain(MW4, 2026, "Call of Duty Modern Warfare 4 [FitGirl Repack]")).toBe(true);
    // the other way round: Modern Warfare 4 is not the 2007 game (Steam's name for it carries its year, a bare one does not)
    expect(judge("Call of Duty 4: Modern Warfare", 2007, "Call.of.Duty.Modern.Warfare.4-RUNE")!.flags.reordered).toBe(true);
    expect(certain("Call of Duty® 4: Modern Warfare® (2007)", 2007, "Call.of.Duty.Modern.Warfare.4-RUNE")).toBe(false);
    expect(certain("Call of Duty 4: Modern Warfare", 2007, "Call.of.Duty.4.Modern.Warfare-RELOADED")).toBe(true);
  });
  test("the tags count, articles do not, and an alias written in another order is the way out", () => {
    expect(certain("Lords Of The Fallen™ 2014", 2014, "Lords.Of.The.Fallen-CPY (2014) [Windows / Multi-Language / Full ISO]")).toBe(true);   // its 2014 sits in "(2014)"
    expect(certain("The Legend of Zelda: Majora's Mask", 2000, "Legend of Zelda, The - Majora's Mask (Europe) (En,Fr,De,Es) (Rev 1) (Wii Virtual Console)", { platforms: ["wii"], known: ["wii", "n64"] })).toBe(true);
    expect(certain("Sid Meier's Civilization® VI", 2016, "Sid.Meiers.Civilization.VI-CODEX")).toBe(true);
    expect(certain("KINGDOM HEARTS HD 1.5+2.5 ReMIX", 2024, "KINGDOM.HEARTS.HD.1.5.2.5.ReMIX-RUNE")).toBe(true);
    // a tracker that moves the possessive to the end: refused under the name, taken under an alias that reads like it
    const miles = "Spider-Man: Miles Morales (Marvel's) [Windows / Multi-Language / Full ISO]";
    expect(certain("Marvel's Spider-Man: Miles Morales", 2022, miles)).toBe(false);
    expect(certain("Marvel's Spider-Man: Miles Morales", 2022, miles, { aliases: ["Spider-Man: Miles Morales"] })).toBe(true);
  });
  test("the words a name needs, in its own order, each once; the in-order test is greedy", () => {
    expect(nameWords(buildQuery("Call of Duty®: Modern Warfare® 4"))).toEqual(["call", "duty", "modern", "warfare", "4"]);
    expect(nameWords(buildQuery("Hollow Knight Deluxe Edition"))).toEqual(["hollow", "knight"]);
    expect(inOrder(["call", "duty", "4"], tokens("Call of Duty 4 Modern Warfare"))).toBe(4);
    expect(inOrder(["modern", "warfare", "4"], tokens("Call of Duty 4 Modern Warfare"))).toBe(-1);
  });
});

describe("R2 — a number right after the whole name", () => {
  test("a number after the subtitle is another entry, not only one after the head", () => {
    for (const [name, year, title] of [["Call of Duty®: Modern Warfare®", 2019, "Call.of.Duty.Modern.Warfare.2-RELOADED"], ["Call of Duty®: Modern Warfare®", 2019, "Call.of.Duty.Modern.Warfare.3-FLT"], ["Call of Duty®: Black Ops", 2010, "Call.of.Duty.Black.Ops.II-SKIDROW"]] as const) {
      const v = judge(name, year, title)!;
      expect({ title, sequel: v.flags.sequel, certain: certainlyThisGame(v) }).toEqual({ title, sequel: true, certain: false });
      expect(nameRefusals(v)[0]).toMatch(/^a number after the name \("\d"\): a sequel or another entry$/);
    }
    expect(certain("Call of Duty®: Black Ops III", 2015, "Call.of.Duty.Black.Ops.III-RELOADED")).toBe(true);
  });
  test("a count is no sequel (\"+ 3 DLCs\"), a version is one word, and a name's own number is the name's", () => {
    expect(certain("Hollow Knight", 2017, "Hollow Knight v1.5.78 + 3 DLCs [FitGirl Repack]")).toBe(true);
    expect(certain("Hollow Knight", 2017, "Hollow Knight + 3 DLCs [FitGirl Repack]")).toBe(true);           // the head's check counts too now
    expect(certain("MARVEL Tōkon: Fighting Souls", 2026, "MARVEL Tōkon: Fighting Souls v1.2.2 + 9 DLCs [FitGirl Repack] (2026) [Windows / Multi-Language / P2P Full Repack]")).toBe(true);
    expect(certain("Hollow Knight", 2017, "Hollow Knight 1.5.78 [GOG]")).toBe(true);
    expect(certain("Samurai GUNN 2", 2021, "Samurai Gunn 2 EA1 v2021.07.19 (2021) [Early Access 2021] [Windows / English / Home Rip]")).toBe(true);
    expect(certain("DARK SOULS™ III", 2016, "DARK.SOULS.III.Build.10167187.REPACK-KaOs (2016) [Windows / Multi-Language / P2P Full Repack]")).toBe(true);
    // a dotted scene name's bare "N.N.N" may hide a sequel number: only a "v" makes it a version there
    expect(certain("Hades", 2020, "Hades.2.1.0.3-RUNE")).toBe(false);
    expect(certain("Hades", 2020, "Hades.II.v1.0.3-RUNE")).toBe(false);
  });
});

describe("R3 — the extra-words waiver only for a sequel already flagged", () => {
  test("the name's own number after its head no longer hides the words after the name", () => {
    const mac = judge(MW4, 2026, "Call.of.Duty.4.Modern.Warfare.v1.7.2.MacOSX.Intel.Cracked-AR")!;
    expect(mac.flags.extraWords).toBe(true);
    expect(mac.reasons).toContain('extra title words ("macosx")');
    expect(judge(MW4, 2026, "Call of Duty 4-Modern Warfare Repack-P2P.exe.rar")!.reasons).toContain('extra title words ("exe")');
    // a sequel is flagged once: its extra words stay waived
    const two = judge("Hades", 2020, "Hades.2.Nightmare.Edition-RUNE")!;
    expect({ sequel: two.flags.sequel, extra: two.flags.extraWords }).toEqual({ sequel: true, extra: false });
  });
});

describe("R4 — the builds for another system the list missed (a PC pass)", () => {
  test("Mac, iOS, Android, Xbox, Switch and Wii U packages, ARM builds and PlayStation title ids are no PC build", () => {
    for (const [title, token] of [["Hades.v1.38290.MacOSX-ACTiVATED", "macosx"], ["Hades.v1.38290.Macintosh-X", "macintosh"], ["Hades v1.38 dmg", "dmg"],
      ["Hades v1.0.ipa", "ipa"], ["Hades v1.0 XAPK", "xapk"], ["Hades APKS", "apks"], ["Hades v1.0 OBB", "obb"], ["Hades.XONE-GRP", "xone"], ["Hades.XSX-GRP", "xsx"],
      ["Hades.XBSX-GRP", "xbsx"], ["Hades XB1", "xb1"], ["Hades.NSZ-VENOM", "nsz"], ["Hades.WUX-GRP", "wux"], ["Hades WUA", "wua"], ["Hades.ARM64-GRP", "arm64"],
      ["Hades aarch64", "aarch64"], ["Hades.PPC-GRP", "ppc"], ["Hades [CUSA12345] v1.23", "cusa12345"], ["Hades.PPSA01341-GRP", "ppsa01341"], ["Hades BLUS30443", "blus30443"]] as const) {
      expect({ title, kind: judge("Hades", 2020, title)!.flags.wrongKind }).toEqual({ title, kind: `not a PC build (${token})` });
    }
  });
  test("the platforms they name, and a console pass still takes its dump", () => {
    expect(["macosx", "macintosh", "dmg", "ipa", "xapk", "obb", "xbsx", "xb1", "nsz", "wux", "wua", "CUSA12345", "PPSA01341", "NPEB01234"].map(platformId))
      .toEqual(["mac", "mac", "mac", "ios", "android", "android", "xsx", "xone", "switch", "wiiu", "wiiu", "ps4", "ps5", "ps3"]);
    expect(platformId("arm64")).toBeNull();
    const ps5 = judge("Demon's Souls", 2020, "Demons.Souls.v1.004.PS5.PPSA01341", { platforms: ["ps5"], known: ["ps5"] })!;
    expect({ kind: ps5.flags.wrongKind, platform: ps5.flags.platform, certain: certainlyThisGame(ps5) }).toEqual({ kind: null, platform: "ps5", certain: true });
    expect(judge("Dead Cells", 2018, "Dead Cells [CUSA12345] v1.23", { platforms: ["ps4"], known: ["ps4"] })!.flags.platform).toBe("ps4");
  });
});

describe("R5 — a file name is not a release", () => {
  test("an executable, a script or a shortcut, alone or packed, in every pass; a bare archive on PC", () => {
    const kind = (title: string, want: PlatformId[] = ["pc"]) => wrongKind(buildQuery("Hades"), title, parseTitle(title), want);
    expect(kind("Hades Repack-P2P.exe.rar")).toBe("a file name, not a release (.exe.rar)");
    expect(kind("[EXTERNAL]Hades-RELOADED [mininova] rar.exe")).toBe("a file name, not a release (.exe)");
    expect(kind("Hades Campaign Unlocked.scr")).toBe("a file name, not a release (.scr)");
    expect(kind("Hades.iso.lnk")).toBe("a file name, not a release (.lnk)");
    for (const ext of ["pif", "bat", "cmd", "msi", "vbs", "jar", "ps1", "url"]) expect(kind(`Hades setup.${ext}`)).toBe(`a file name, not a release (.${ext})`);
    expect(kind("Hades.v1.0.exe.zip")).toBe("a file name, not a release (.exe.zip)");
    expect(kind("[EXTERNAL]Hades-RELOADED [mininova] rar.rar")).toBe("a file name, not a release (.rar)");
    expect(kind("Hades-GOG.7z")).toBe("a file name, not a release (.7z)");
    // a console pass: a dump is posted as "Game (USA).zip", an executable never is
    expect(kind("Hades (USA) N64.zip", ["n64"])).toBeNull();
    expect(kind("Hades (USA) N64.exe", ["n64"])).toBe("a file name, not a release (.exe)");
    // ".com" is a domain in a name, and an executable word that is not a file extension is nothing
    expect(kind("Hades-CODEX [www.example.com]")).toBeNull();
    expect(kind("Hades.Exe.Edition-RUNE")).toBeNull();
  });
});

describe("R7a — an update by its name", () => {
  test("an update word anywhere in the release's own name, unless the game is bundled before it or it is a repack", () => {
    expect(parseTitle("Command.and.Conquer.Red.Alert.3.v1.012.Update-SKIDROW").junk).toEqual(["update-only"]);   // imported as the game, 2026-11-09
    expect(parseTitle("Mouthwashing Update v20241014 incl DLC-TENOKE").junk).toEqual(["update-only"]);        // "incl" after the word bundles nothing
    expect(parseTitle("ELDEN.RING.v1.02.Update-CODEX").junk).toEqual(["update-only"]);
    expect(parseTitle("Cyberpunk.2077.v2.12.Hotfix-RUNE").junk).toEqual(["update-only"]);
    expect(parseTitle("Hades.Patch.Only-CODEX").junk).toEqual(["update-only"]);
    expect(parseTitle("ELDEN RING v1.16.1 + Update 1.16.1 incl DLC-ElAmigos").junk).toEqual([]);
    expect(parseTitle("Some.Game.Incl.Update.5-PLAZA").junk).toEqual([]);
    expect(parseTitle("Some Game with Update 5").junk).toEqual([]);
    expect(parseTitle("Some Game v1.2 Update 3 [FitGirl Repack]").junk).toEqual([]);
    expect(parseTitle("Some.Game.Updated.Edition-GRP").junk).toEqual([]);
    expect(parseTitle("Some Game [Update 5]").junk).toEqual(["update-only"]);                                // a tag with its number, as before
  });
  test("a word of the game's own name never marks it (\"Patch Quest\" is a game)", () => {
    expect(parseTitle("Patch.Quest.v1.0.3-TENOKE", "Patch Quest").junk).toEqual([]);
    expect(parseTitle("Patch.Quest.v1.0.3-TENOKE").junk).toEqual(["update-only"]);                    // without the name every such word counts
    expect(parseTitle("Patch.Quest.Update.v1.0.4-TENOKE", "Patch Quest").junk).toEqual(["update-only"]);
    const quest = judge("Patch Quest", 2022, "Patch.Quest.v1.0.3-TENOKE")!;
    expect({ certain: certainlyThisGame(quest), junk: quest.parsed.junk }).toEqual({ certain: true, junk: [] });
  });
});

describe("R7b — a PC release's own tags", () => {
  const kind = (title: string, name = "Hades", asked?: string[]) => wrongKind(buildQuery(name), title, parseTitle(title), ["pc"], [], undefined, { asked });
  test("a demo, a beta, a test build, and the add-ons trackers file beside the game are refused", () => {
    expect(kind("Hades (Demo)")).toBe("(Demo): a demo, not the game as it was sold");
    expect(kind("Hades [Beta]")).toBe("[Beta]: a development build, not the game as it was sold");
    expect(kind("Hades [Network Test]")).toBe("[Network Test]: a test build, not the game as it was sold");
    expect(kind("Hades [Playtest]")).toBe("[Playtest]: a playtest, not the game");
    expect(kind("Hades [Prologue]")).toBe("[Prologue]: a prologue, not the game");
    expect(kind("Hades (Benchmark)")).toBe("(Benchmark): a benchmark, not the game");
    expect(kind("Hades [Dedicated Server]")).toBe("[Dedicated Server]: a server, not the game");
    expect(kind("Hades [Original Soundtrack]")).toBe("[Original Soundtrack]: the soundtrack, not the game");
    expect(kind("Hades [Art Book]")).toBe("[Art Book]: an artbook, not the game");
  });
  test("an early access build, a tag that lists what comes along, and the game's own words are the game", () => {
    expect(kind("Frosthaven (2026) [Early Access 2025] [Windows / Multi-Language / Home Rip]", "Frosthaven")).toBeNull();
    expect(kind("Hollow Knight (v1.5.78 + DLC + Bonus Content, MULTi10) [DODI Repack]", "Hollow Knight")).toBeNull();
    expect(kind("Hades [Incl. Soundtrack]")).toBeNull();
    expect(kind("INSIDE (Proper) [FitGirl Repack]", "INSIDE")).toBeNull();
    expect(kind("Lords of the Fallen Game of the Year Edition v1.0.0 (64bit) (24706) (2014) [GOG Game of the Year Edition 2018] [Windows / Multi-Language / DRM Free]", "Lords Of The Fallen 2014")).toBeNull();
    expect(kind("PROLOGUE [Prologue]", "Prologue")).toBeNull();
  });
  test("a way that asks for a prototype takes one; nothing else does (only wrongKind knows what a way asked for)", () => {
    expect(kind("Hades (Proto) [Windows / English / Home Rip]")).toBe("(Proto): a development build, not the game as it was sold");
    expect(kind("Hades (Proto) [Windows / English / Home Rip]", "Hades", ["the prototype build"])).toBeNull();
    expect(kind("Hades (Beta) [Windows / English / Home Rip]", "Hades", ["the prototype build"])).toMatch(/development build/);
    // a console way's pass, as before
    const dino = judge("Dinosaur Planet", 2000, "Dinosaur Planet (USA) (Proto)", { platforms: ["n64"], known: ["n64"], unnamed: true, asked: ["an unreleased prototype"] })!;
    expect(certainlyThisGame(dino)).toBe(true);
  });
});

describe("nameRefusals: every reason in words, the same verdict as certainlyThisGame", () => {
  test("certain exactly when nothing but junk is named, and junk in words", () => {
    const titles = ["Hades-CODEX", "Hades.II-RUNE", "Daymare 1998 HADES Dead End-HOODLUM", "Hades.Update.v1.38-CODEX", "Hades Trainer +12 FLiNG", "Hades (2020) [Mac / Multi-Language / Home Rip]",
      "Hades (2016) [Windows / English / Home Rip]", "Hades.Nightmare-RUNE", "Hades (Demo)", "Hades Repack-P2P.exe.rar", "Hades v1.38 [FitGirl Repack]"];
    for (const title of titles) {
      const v = judge("Hades", 2020, title)!;
      const words = nameRefusals(v);
      expect({ title, certain: certainlyThisGame(v) }).toEqual({ title, certain: words.length === v.parsed.junk.length });
      expect(words.every(w => typeof w === "string" && w.length > 3)).toBe(true);
    }
    expect(nameRefusals(judge("Hades", 2020, "Hades.Update.v1.38-CODEX")!)).toEqual(["an update or a patch, not the game"]);
    expect(nameRefusals(judge("Hades", 2020, "Hades (2016) [Windows / English / Home Rip]")!)).toEqual(["from 2016: 4 years off the game's year"]);
    expect(nameRefusals(judge("Castlevania: Belmont's Curse", 2026, "Castlevania Curse of Darkness")!)[0]).toBe('the title lacks "belmonts" from the name');
  });
});

/* ─────────── Fix A review round (2026-11-09): the name rules' false refusals and false accepts ─────────── */

/** what the automatic searcher reads off a title alone: every reason in words (empty: its name stands in nothing's way) */
const why = (name: string, year: number | null, title: string, o: Parameters<typeof judge>[3] = {}) => { const v = judge(name, year, title, o); return v ? nameRefusals(v) : ["no name matches"]; };
const takes = (name: string, year: number | null, title: string, o: Parameters<typeof judge>[3] = {}) => why(name, year, title, o).length === 0;

describe("review: a version, a size or a count never supplies the name's number (R1, R2)", () => {
  test("a sequel written '<name> N + DLC' is the sequel: the count is what follows a '+', not what precedes a count word", () => {
    for (const [name, title] of [["Borderlands Game of the Year Enhanced", "Borderlands 2 + DLC [FitGirl Repack]"], ["Borderlands Game of the Year Enhanced", "Borderlands 3 + DLCs [DODI Repack]"],
      ["Borderlands Game of the Year Enhanced", "Borderlands.2.DLC.Bundle-SKIDROW"], ["Frostpunk", "Frostpunk 2 + DLC [DODI Repack]"], ["Hades", "Hades II + DLC [FitGirl Repack]"],
      ["Hades", "Hades.II.DLC-RUNE"], ["Hades", "Hades.2.Bonus-RUNE"], ["Hades", "Hades 2 in Early Access-P2P"], ["Dying Light", "Dying Light 2 + DLC-P2P"], ["Dead Island", "Dead.Island.2.DLC-RUNE"],
      ["Call of Duty®: Black Ops", "Call of Duty Black Ops II + DLC"], ["Cities: Skylines", "Cities: Skylines II + DLC"], ["Call of Duty®: Modern Warfare®", "Call of Duty Modern Warfare 2 + DLC"]] as const) {
      expect({ name, title, taken: takes(name, null, title) }).toEqual({ name, title, taken: false });
    }
    for (const [name, title] of [["Hollow Knight", "Hollow Knight + 3 DLCs [FitGirl Repack]"], ["Hollow Knight", "Hollow Knight v1.5.78 + 3 DLCs [FitGirl Repack]"],
      ["MARVEL Tōkon: Fighting Souls", "MARVEL Tōkon: Fighting Souls v1.2.2 + 9 DLCs [FitGirl Repack]"], ["Lords of the Fallen", "Lords of the Fallen GOG + All DLCs"],
      ["Bloodborne", "Bloodborne v1.09.All.DLCs.+.Online"], ["The Witcher 3", "Witcher 3 GOTY v4.04 + 2 DLCs [GOG]"], ["Hollow Knight: Silksong", "Hollow Knight: Silksong + 2 Soundtracks [GOG]"]] as const) {
      expect({ name, title, why: why(name, null, title) }).toEqual({ name, title, why: [] });
    }
  });
  test("the name's number only inside a version, a size tag or a count is another entry", () => {
    for (const [name, title] of [["Total War: WARHAMMER III", "Total.War.WARHAMMER.II.v1.3.0-CODEX"], ["Total War: WARHAMMER III", "Total War: WARHAMMER II - v1.12.1 + 3 DLCs [FitGirl Repack]"],
      ["Cities: Skylines II", "Cities.Skylines.v1.2.1.f1-GOG"], ["Frostpunk 2", "Frostpunk: Game of the Year Edition v1.6.2 + 2 DLCs [FitGirl Repack]"],
      ["Mortal Kombat 1", "Mortal.Kombat.Komplete.Edition.v1.0.1-PROPHET"], [MW4, "Call.of.Duty.4.Modern.Warfare.v1.4-RELOADED"], [MW4, "Call.of.Duty.4.Modern.Warfare.v1.7.4-PROPHET"],
      [MW4, "Call of Duty 4 Modern Warfare + 4 DLCs [FitGirl Repack]"], [MW4, "Call of Duty 4 Modern Warfare [Windows] [4 GB]"],
      [MW4, "Call of Duty 4: Modern Warfare - v1.7.568 + Multiplayer [FitGirl Repack, Selective Download - from 4.4 GB]"],
      ["Grand Theft Auto V", "Grand Theft Auto IV v 1.0.7 [GOG]"]] as const) {
      expect({ name, title, taken: takes(name, null, title) }).toEqual({ name, title, taken: false });
    }
    expect(why("Total War: WARHAMMER III", null, "Total.War.WARHAMMER.II.v1.3.0-CODEX")[0]).toBe('the name\'s "3" is only part of a version, a size or a count: another entry?');
    for (const [name, title] of [["Total War: WARHAMMER III", "Total.War.WARHAMMER.III-RUNE"], ["Frostpunk 2", "Frostpunk.2-RUNE"], ["Frostpunk 2", "Frostpunk 2 v1.0.3 + 2 DLCs [FitGirl Repack]"],
      ["Mortal Kombat 1", "Mortal Kombat 1 Premium Edition v1.0.1 [FitGirl Repack]"], ["Grand Theft Auto V", "Grand Theft Auto V 1.0.2189 [DODI Repack]"], ["Grand Theft Auto V", "Grand.Theft.Auto.V-RELOADED"],
      ["KINGDOM HEARTS HD 1.5+2.5 ReMIX", "KINGDOM.HEARTS.HD.1.5.2.5.ReMIX-RUNE"], ["KINGDOM HEARTS HD 1.5+2.5 ReMIX", "KINGDOM HEARTS HD 1.5+2.5 ReMIX v1.0.0.2 [FitGirl Repack]"],
      ["Lords Of The Fallen™ 2014", "Lords of the Fallen Game of the Year Edition v1.0.0 (64bit) (24706) (2014) [GOG Game of the Year Edition 2018] [Windows / Multi-Language / DRM Free]"]] as const) {
      expect({ name, title, why: why(name, null, title) }).toEqual({ name, title, why: [] });
    }
  });
  test("words between the name and the number it ends with are another game (Revelations 2 is not Resident Evil 2)", () => {
    expect(why("Resident Evil 2", null, "Resident Evil Revelations 2 [DODI Repack]")).toEqual(['more words between the name and its number ("revelations"): another game?']);
    expect(takes("Total War: WARHAMMER III", null, "Total War WARHAMMER II 3 DLC Pack-GRP")).toBe(false);
    for (const title of ["Resident.Evil.2-CODEX", "Resident Evil 2 Remake Deluxe Edition [FitGirl Repack]", "Resident Evil 2 (2019) [Windows / Multi-Language / Full ISO]"]) expect({ title, why: why("Resident Evil 2", 2019, title) }).toEqual({ title, why: [] });
    for (const [name, title] of [["Command & Conquer™ Red Alert™ 3", "Command.and.Conquer.Red.Alert.3-RELOADED"], ["Warhammer 40,000: Space Marine 2", "Warhammer 40,000: Space Marine 2 - Ultra Edition [FitGirl Repack]"],
      ["Left 4 Dead 2", "Left.4.Dead.2-RELOADED"], ["Call of Duty®: Black Ops III", "Call.of.Duty.Black.Ops.III-RELOADED"]] as const) expect({ name, title, why: why(name, null, title) }).toEqual({ name, title, why: [] });
  });
  test("a version after the subtitle is one word in every spelling; a sequel's number stays one", () => {
    for (const title of ["Hollow.Knight.Silksong.1.0.28324-GOG", "Hollow Knight: Silksong 1.04 [GOG]", "Hollow Knight Silksong v 1.0.28324 [GOG]", "Hollow Knight: Silksong Version 1.0.2 [GOG]"]) {
      expect({ title, why: why("Hollow Knight: Silksong", 2025, title) }).toEqual({ title, why: [] });
    }
    for (const title of ["Hades.2.1.0.3-RUNE", "Hades.2.1.0-RUNE", "Hades.II.v1.0.3-RUNE", "Hades 2.0 [GOG]"]) expect({ title, taken: takes("Hades", 2020, title) }).toEqual({ title, taken: false });
  });
});

describe("review: the order of a name's words (R1)", () => {
  test("a No-Intro name that moves its article to the end, and a year in the middle of a name, are the game", () => {
    expect(why("Les Schtroumpfs", 1994, "Schtroumpfs, Les (France)", { platforms: ["snes"], known: ["snes"], unnamed: true })).toEqual([]);
    expect(why("Die Siedler", 1993, "Siedler, Die (Germany)", { platforms: ["genesis"], known: ["genesis"], unnamed: true })).toEqual([]);
    expect(why("Microsoft Flight Simulator (2020) 40th Anniversary Edition", 2020, "Microsoft Flight Simulator 40th Anniversary Edition (2020) [Windows / Multi-Language / Full ISO]")).toEqual([]);
    // a possessive a tracker moves stays refused: an alias that reads like it is the way out (as before)
    expect(takes("Marvel's Spider-Man Remastered", 2022, "Spider-Man Remastered (Marvel's) [Windows / Multi-Language / Full ISO]")).toBe(false);
  });
});

describe("review: a PC port that names its console's title id (R4)", () => {
  test("a repacker's, a Windows or a 'for PC' build is the PC game whatever serial it names; a bare serial is a console package", () => {
    for (const [name, title] of [["Bloodborne", "Bloodborne (CUSA03173) Recompiled for PC v1.9.6 [FitGirl Repack]"], ["Bloodborne", "Bloodborne v1.09 + All DLCs (shadPS4, CUSA00900) [DODI Repack]"],
      ["Demon's Souls", "Demons.Souls.BLUS30443.RPCS3.Windows-P2P"], ["Bloodborne", "Bloodborne (CUSA03173) Recompiled for PC v1.9.6"]] as const) {
      const v = judge(name, null, title)!;
      expect({ title, why: nameRefusals(v), platform: v.flags.platform ?? null }).toEqual({ title, why: [], platform: null });
    }
    expect(judge("Hades", 2020, "Hades [CUSA12345] v1.23")!.flags.wrongKind).toBe("not a PC build (cusa12345)");
    // a console pass takes no PC port, by its repacker or its "for PC"
    expect(judge("Bloodborne", null, "Bloodborne (CUSA03173) Recompiled for PC v1.9.6", { platforms: ["ps4"], known: ["ps4"] })!.flags.wrongKind).toMatch(/^a PC release/);
  });
});

describe("review: a PC release's own tags (R7b)", () => {
  test("an early access version, bonus content, a fan translation and a tag that is the game's own name are the game", () => {
    for (const [name, title] of [["7 Days to Die", "7 Days to Die (Alpha 21.2) [GOG]"], ["Kenshi", "Kenshi (Bonus Content) [GOG]"], ["Kenshi", "Kenshi (v1.0.65) (Translated) [GOG]"],
      ["Kenshi", "Kenshi [Fan Translation] [GOG]"], ["Kenshi", "Kenshi [Beta 0.98.50]"], ["Prototype 2", "Prototype 2 [Prototype 2 RADNET Edition] [GOG]"]] as const) {
      expect({ title, why: why(name, null, title) }).toEqual({ title, why: [] });
    }
    for (const title of ["Hades (Demo)", "Hades [Beta]", "Hades [Network Test]", "Hades (Proto) [Windows / English / Home Rip]", "Hades (Debug Build)", "Hades [Stress Test]"]) expect({ title, taken: takes("Hades", 2020, title) }).toEqual({ title, taken: false });
  });
  test("an add-on's tag of two words is read by its first ('[Benchmark Tool]', '[Server Files]', '(Prologue Edition)'); a soundtrack edition is the game", () => {
    for (const title of ["ELDEN RING [Benchmark Tool]", "ELDEN RING [Server Files]", "ELDEN RING (Prologue Edition)", "ELDEN RING [Playtest Build]"]) expect({ title, taken: takes("ELDEN RING", 2022, title) }).toEqual({ title, taken: false });
    expect(why("Celeste", 2018, "Celeste (Soundtrack Edition) [GOG]")).toEqual([]);
  });
});

describe("review: what is not the game by its name (R5, R7a, the junk tags)", () => {
  test("a crack, a fix, a DLC, a soundtrack, a language pack, a demo, a trainer, an update repack, a PS4 package, an XBLA build", () => {
    for (const title of ["ELDEN.RING.Crack-3DM", "ELDEN.RING.Proper.Crack-RELOADED", "ELDEN RING CPY Crack", "ELDEN.RING.Fix-CODEX", "ELDEN.RING.DLC-RUNE", "ELDEN RING OST [FitGirl Repack]",
      "ELDEN RING Soundtrack + Bonus", "ELDEN.RING.MULTi12.Language.Pack-RUNE", "ELDEN.RING.MULTi9.Demo-RUNE", "ELDEN.RING.Plus.24-FLiNG", "ELDEN RING Update 1.16 Repack by Xatab",
      "ELDEN RING [Update 1.16 incl. DLC]", "Elden.Ring.v1.04.PKG-DUPLEX"]) {
      expect({ title, taken: takes("ELDEN RING", 2022, title) }).toEqual({ title, taken: false });
    }
    expect(takes("Hollow Knight", 2017, "Hollow.Knight.Voidheart.Edition.XBLA-GRP")).toBe(false);
    for (const title of ["ELDEN RING Deluxe Edition v1.16 + DLC [FitGirl Repack]", "ELDEN.RING.MULTi14-ElAmigos", "ELDEN RING v1.16.1 + Update 1.16.1 incl DLC-ElAmigos", "ELDEN.RING.v1.02.Incl.Crack-GRP",
      "ELDEN RING v1.16 + Bonus OST [FitGirl Repack]", "ELDEN RING (v1.16 + DLC + Bonus OST, MULTi14) [DODI Repack]"]) {
      expect({ title, why: why("ELDEN RING", 2022, title) }).toEqual({ title, why: [] });
    }
  });
  test("a bundle word that is part of the game's own name bundles nothing: an update of it is an update", () => {
    for (const [name, title] of [["Getting Over It with Bennett Foddy", "Getting.Over.It.with.Bennett.Foddy.Update.v1.5-SKIDROW"], ["Fun with Ragdolls: The Game", "Fun.with.Ragdolls.The.Game.Update.v1.2-PLAZA"],
      ["Cloudy with a Chance of Meatballs", "Cloudy.with.a.Chance.of.Meatballs.Patch.v1.1-GRP"], ["KINGDOM HEARTS HD 1.5+2.5 ReMIX", "KINGDOM HEARTS HD 1.5+2.5 ReMIX Update v1.0.0.2-RUNE"]] as const) {
      expect({ title, junk: parseTitle(title, name).junk }).toEqual({ title, junk: ["update-only"] });
    }
    expect(parseTitle("Getting.Over.It.with.Bennett.Foddy-PLAZA", "Getting Over It with Bennett Foddy").junk).toEqual([]);
    expect(parseTitle("Getting.Over.It.with.Bennett.Foddy.with.Update.v1.5-PLAZA", "Getting Over It with Bennett Foddy").junk).toEqual([]);
  });
  test("'.PS1' names the console in a console pass; it is a script's extension only on PC", () => {
    for (const title of ["Crash.Bandicoot.USA.PS1", "Metal.Gear.Solid.PAL.PS1 (Disc 1)", "Metal Gear Solid (USA) (Disc 1).PS1"]) {
      const v = judge(title.startsWith("Crash") ? "Crash Bandicoot" : "Metal Gear Solid", 1998, title, { platforms: ["ps1"], known: ["ps1"] })!;
      expect({ title, kind: v.flags.wrongKind ?? null, platform: v.flags.platform }).toEqual({ title, kind: null, platform: "ps1" });
    }
    expect(wrongKind(buildQuery("Hades"), "Hades setup.ps1", parseTitle("Hades setup.ps1"), ["pc"])).toBe("a file name, not a release (.ps1)");
  });
  test("a release filed only under Mac, iOS or Android is no PC build; a PC category beside it is", () => {
    for (const cat of [4030, 4060, 4070]) expect(judge("Hollow Knight", 2017, "Hollow.Knight.v1.5.78.11833-GRP", { categories: [{ id: cat }, { id: 100000 + cat }] } as any)!.flags.wrongKind).toMatch(/^filed under (Mac|iOS|Android), not PC$/);
    expect(judge("Hollow Knight", 2017, "Hollow Knight v1.5.78", { categories: [{ id: 4030 }, { id: 4050 }] } as any)!.flags.wrongKind ?? null).toBeNull();
    expect(judge("Hollow Knight", 2017, "Hollow Knight 1.5.78.11833 [TNT]")!.flags.wrongKind).toBe("not a PC build (tnt)");
  });
});

describe("review 2026-11-10: a namesake from another year, its year written without brackets", () => {
  const NAMESAKES: [string, number | null, string][] = [
    ["Prey", 2017, "Prey.2006-GRP"], ["Prey", 2017, "Prey.2006.MULTi5-PROPHET"], ["Prey", 2017, "Prey 2006 GOG"],
    ["Doom", 2016, "Doom.1993-GRP"], ["Tomb Raider", 2013, "Tomb.Raider.1996-GOG"],
    ["Need for Speed Most Wanted", 2012, "Need.for.Speed.Most.Wanted.2005-GRP"],
    ["Wolfenstein", 2009, "Wolfenstein.3D-GOG"], ["Worms", null, "Worms.3D-RELOADED"],
  ];
  test("the reviewer's titles are no longer certainly the game, and each says why", () => {
    for (const [name, year, title] of NAMESAKES) {
      const v = judge(name, year, title)!;
      expect({ title, certain: certainlyThisGame(v) }).toEqual({ title, certain: false });
      expect(nameRefusals(v).join(" ")).toMatch(/years off the game's year|more words after the name \("3d"\)/);
    }
    expect(judge("Prey", 2017, "Prey.2006-GRP")!.flags.yearOff).toBe(11);
    expect(parseTitle("Prey 2006 GOG", "Prey").year).toBe(2006);
    expect(judge("Wolfenstein", 2009, "Wolfenstein.3D-GOG")!.flags.extraWords).toBe(true);
  });
  test("the right game is still taken: its own year, no year, a year or a '3D' that is a word of its name, a date, a version", () => {
    const RIGHT: [string, number | null, string][] = [
      ["Prey", 2017, "Prey.2017-CODEX"], ["Prey", 2017, "Prey-CODEX"], ["Prey", 2017, "Prey.2018.MULTi5-PROPHET"],      // a year one off is the game's
      ["Prey", 2017, "Prey.v1.10.2024.11.05-GOG"], ["Prey", 2017, "Prey.2024.11.05-GOG"], ["Prey", 2017, "Prey.2024.05-GOG"],   // a build's date is no year of the game
      ["Wolfenstein 3D", 1992, "Wolfenstein.3D-GOG"], ["Worms 3D", null, "Worms.3D-RELOADED"],
      ["Lords Of The Fallen™ 2014", 2014, "Lords.of.the.Fallen.2014-CODEX"], ["Cyberpunk 2077", 2020, "Cyberpunk.2077-GOG"],
      ["Football Manager 2024", 2023, "Football.Manager.2024-RUNE"], ["Hades", 2020, "Hades.MULTi12-3DM"], ["Hades", 2020, "Hades.v1.38.x64-CODEX"],
      ["Prey", 2017, "Prey (2017) [Windows / Multi-Language / Home Rip]"],
    ];
    for (const [name, year, title] of RIGHT) expect({ title, certain: certain(name, year, title) }).toEqual({ title, certain: true });
    expect(parseTitle("Lords.of.the.Fallen.2014-CODEX", "Lords Of The Fallen 2014").year).toBeNull();     // the name's own word
    expect(parseTitle("Prey.2024.11.05-GOG", "Prey").year).toBeNull();
    expect(parseTitle("Prey.2006-GRP").year).toBeNull();                                                  // no name to read it after: as before
  });
  test("a bracketed year still counts as before, and wins over a bare one", () => {
    expect(judge("Prey", 2017, "Prey (2006)-GRP")!.flags.yearOff).toBe(11);
    expect(parseTitle("Prey 2006 (2017) [Windows / English / Home Rip]", "Prey").year).toBe(2017);
  });
  test("a year alone in square brackets is the release's year too: the namesake is refused, the right game taken", () => {
    for (const title of ["Prey [2006] GOG", "Prey [2006]", "Prey.[2006]-GRP"]) {
      const v = judge("Prey", 2017, title)!;
      expect({ title, year: v.parsed.year, yearOff: v.flags.yearOff, certain: certainlyThisGame(v) }).toEqual({ title, year: 2006, yearOff: 11, certain: false });
      expect(nameRefusals(v).join(" ")).toMatch(/from 2006: 11 years off the game's year/);
    }
    expect(parseTitle("Prey [2006] GOG").year).toBe(2006);                                                // read without a name, as "(2006)" is
    for (const title of ["Prey [2017] GOG", "Prey [2018]", "Prey [GOG Edition 2024]", "Prey [Windows / English / Home Rip]", "Prey [v1.10 build 20241105]"])
      expect({ title, certain: certain("Prey", 2017, title) }).toEqual({ title, certain: true });
    // a tag that holds more than a year is no year; round brackets come first, as before
    expect(parseTitle("Prey [GOG Edition 2024]", "Prey").year).toBeNull();
    expect(parseTitle("Prey [Windows / English / Home Rip]", "Prey").year).toBeNull();
    expect(parseTitle("Prey [2006] (2017)", "Prey").year).toBe(2017);
  });
});
