import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db";
import { cwDate, cwFind, cwGame, cwKey, cwList, cwdeps, isShell, parseCards, parseGamePage, parseGroups, parseSitemap, parseUpcoming } from "../src/crackwatch";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const cracked = fx("crackwatch-game-cracked.html"), uncracked = fx("crackwatch-game-uncracked.html"), shell = fx("crackwatch-shell.html");

describe("CrackWatch pages", () => {
  test("dates", () => {
    expect(cwDate("Oct 15, 2026")).toBe("2026-10-15"); expect(cwDate("March 3, 2025")).toBe("2025-03-03");
    expect(cwDate("TBD")).toBeNull(); expect(cwDate(null)).toBeNull();
    expect(cwKey("Castlevania: Belmont's Curse")).toBe(cwKey("castlevania-belmont-s-curse")); expect(cwKey("Final Fantasy VII Rebirth")).toBe(cwKey("final-fantasy-7-rebirth"));
  });
  test("a cracked game: status, both dates, days to crack, DRM, group, cover, description, stores", () => {
    const g = parseGamePage(cracked, "enshrouded");
    expect(g).toMatchObject({ slug: "enshrouded", title: "Enshrouded", status: "cracked", statusText: "Cracked on release day", releaseDate: "2026-10-15", crackDate: "2026-10-15", daysToCrack: 0, drm: "Steam", group: "RUNE", url: "https://isitcracked.com/game/enshrouded" });
    expect(g.cover).toContain("game-covers/enshrouded.webp");
    expect(g.description).toMatch(/^Enshrouded launches on October 15, 2026/);
    expect(g.stores.some(s => s.includes("instant-gaming.com"))).toBe(true);
  });
  test("an uncracked Denuvo game: no crack date, no group, the waiting text", () => {
    const g = parseGamePage(uncracked, "planet-zoo-2");
    expect(g).toMatchObject({ title: "Planet Zoo 2", status: "uncracked", statusText: "6 days and counting", releaseDate: "2026-10-13", crackDate: null, daysToCrack: null, drm: "Denuvo", group: null });
    expect(g.stores.length).toBeGreaterThan(0);
  });
  test("a game playable through a hypervisor bypass is its own status, not a crack", () => {
    const g = parseGamePage(fx("crackwatch-game-hypervisor.html"), "ea-sports-fc-27");
    expect(g).toMatchObject({ status: "hypervisor", statusText: "Bypassed after 3 days", drm: "Denuvo" });
  });
  test("list cards: status, D+N and title; the uncracked list; the upcoming calendar with dates; the groups; the sitemap", () => {
    const c = parseCards(fx("crackwatch-list-cracked.html"));
    expect(c).toHaveLength(30);
    expect(c[0]).toMatchObject({ slug: "penguin-colony", title: "Penguin Colony", status: "cracked", days: 0 });
    expect(c.every(x => x.status === "cracked")).toBe(true);
    const u = parseCards(fx("crackwatch-list-uncracked.html"));
    expect(u[0]).toMatchObject({ slug: "hide-zone", title: "Hide Zone", status: "uncracked", days: 2 });
    const up = parseUpcoming(fx("crackwatch-upcoming.html"));
    expect(up.length).toBeGreaterThan(10);
    expect(up[0]).toMatchObject({ slug: "enshrouded", title: "Enshrouded", releaseDate: "2026-10-15" });
    expect(up.filter(x => x.releaseDate).length).toBeGreaterThanOrEqual(20);          // one card has no date badge yet (TBD)
    expect(up.every(x => !x.releaseDate || x.releaseDate >= "2026-10-01")).toBe(true);
    const groups = parseGroups(fx("crackwatch-groups.html"));
    expect(groups.length).toBeGreaterThan(10); expect(groups).toContain("voices38");
    const slugs = parseSitemap(fx("crackwatch-sitemap.xml"));
    expect(slugs).toContain("enshrouded"); expect(slugs).toContain("planet-zoo-2"); expect(slugs.length).toBeGreaterThan(30);
    expect(isShell(shell)).toBe(true); expect(isShell(cracked)).toBe(false);
  });
});

describe("CrackWatch client", () => {
  let calls: string[] = [];
  beforeEach(() => {
    db.exec("DELETE FROM kv WHERE key LIKE 'crackwatch.%'");
    calls = [];
    cwdeps.spacingMs = 0;
    cwdeps.fetch = (async (u: any) => {
      const url = String(u); calls.push(url);
      if (url.endsWith("/sitemap.xml")) return new Response(fx("crackwatch-sitemap.xml"));
      if (url.endsWith("/game/enshrouded")) return new Response(cracked);
      if (url.endsWith("/game/planet-zoo-2")) return new Response(uncracked);
      if (url.endsWith("/game/castlevania-belmont-s-curse")) return new Response(cracked.replace(/Enshrouded/g, "Castlevania: Belmont&#39;s Curse"));
      if (url.endsWith("/games/cracked")) return new Response(fx("crackwatch-list-cracked.html"));
      if (url.endsWith("/game/shell-only")) return new Response(shell);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
  });
  test("pages are fetched once and cached; a missing game is a 404; the empty app shell is an error, not a game", async () => {
    expect((await cwGame("enshrouded")).group).toBe("RUNE");
    expect((await cwGame("enshrouded")).title).toBe("Enshrouded");
    expect((await cwList("cracked"))[0].slug).toBe("penguin-colony");
    expect(calls.filter(c => c.endsWith("/game/enshrouded"))).toHaveLength(1);
    await expect(cwGame("no-such-game")).rejects.toMatchObject({ status: 404 });
    await expect(cwGame("shell-only")).rejects.toThrow(/app shell/);
  });
  test("a game is found by its title: the exact slug, else the sitemap by normalised name; nothing for an untracked title", async () => {
    expect((await cwFind("Enshrouded"))!.status).toBe("cracked");
    expect((await cwFind("PLANET ZOO 2"))!.drm).toBe("Denuvo");
    expect((await cwFind("Planet Zoo II"))!.slug).toBe("planet-zoo-2");           // roman numerals normalise
    expect((await cwFind("Castlevania: Belmont's Curse"))!.slug).toBe("castlevania-belmont-s-curse");   // the site slugs an apostrophe as "-s-"
    expect((await cwFind("CASTLEVANIA – Belmont’s Curse"))!.title).toBe("Castlevania: Belmont's Curse");
    expect(await cwFind("Hollow Knight: Silksong")).toBeNull();
    expect(calls.filter(c => c.endsWith("/sitemap.xml"))).toHaveLength(1);
  });
});
