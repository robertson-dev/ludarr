import { describe, expect, test } from "bun:test";
import {
  baseName, csvRows, groupReports, parsePcsx2, parseRpcs3, parseRyubing, parseShadps4, parseSharpemu, parseXenia, ps3Cover,
} from "../src/catalog/providers/compat";
import { latestRelease } from "../src/catalog/github";

/* records quoted from the live sources (2026-10-18), trimmed */

describe("compat parsers", () => {
  test("shadPS4: Windows report first, else another OS with a note; status labels mapped", () => {
    const r = parseShadps4({
      CUSA03455: { "os-windows": { issue_number: "3103", name: "7 Days To Die", serial: "CUSA03455", last_tested: "2026-10-14T15:47:31Z", status: "status-playable", version: "v0.19.0" } },
      CUSA00001: { "os-linux": { issue_number: "9", name: "Linux Only", serial: "CUSA00001", last_tested: "2025-01-01T00:00:00Z", status: "status-weird", version: "v0.15.0" } },
    });
    expect(r[0]).toMatchObject({ id: "CUSA03455", name: "7 Days To Die", status: "playable", at: Date.parse("2026-10-14T15:47:31Z") / 1000, note: "tested on v0.19.0 · Windows" });
    expect(r[0].link).toMatch(/issues\/3103$/);
    expect(r[1]).toMatchObject({ status: "unknown", note: "tested on v0.15.0 · linux (no Windows report)" });
  });
  test("SharpEmu: untested titles are left out", () => {
    const r = parseSharpemu([{ t: "PPSA01880", a: "PPSA01880 PPSA01881", n: "Quake", s: "playable" }, { t: "PPSA01280", a: "PPSA01280", n: "Share Factory Studio", s: "untested" }]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "PPSA01880", status: "playable", note: "also PPSA01881" });
  });
  test("RPCS3: statuses mapped (Loadable → boots), forum thread linked", () => {
    const r = parseRpcs3({ return_code: 0, results: {
      BLUS30001: { title: "Ridge Racer 7", status: "Playable", date: "2026-10-05", thread: 200229 },
      NPEA00137: { title: ".detuned", status: "Loadable", date: "2023-08-15", thread: 206651 },
    } });
    expect(r[0]).toMatchObject({ id: "BLUS30001", status: "playable", link: "https://forums.rpcs3.net/thread-200229.html" });
    expect(r[1].status).toBe("boots");
    expect(ps3Cover(["BLES00001", "BLUS30001"])).toBe("https://art.gametdb.com/ps3/cover/US/BLUS30001.jpg");
    expect(ps3Cover(["BLES00001"])).toBeNull();
  });
  test("Xenia: Gameplay → ingame, extra labels kept as a note", () => {
    const r = parseXenia([{ id: "4d4607d5", title: "Heavy Fire: Shattered Spear", updated: "2026-10-17T09:45:27Z", state: "Gameplay", url: "u", labels: { others: ["gpu-occlusion-query"] } }]);
    expect(r[0]).toMatchObject({ id: "4D4607D5", status: "ingame", note: "gpu-occlusion-query" });
  });
  test("PCSX2: English name preferred, unrated entries skipped, 6 → perfect", () => {
    const index = Bun.YAML.parse([
      "SLPM-66340:", '  name: "モンスターハンター2"', '  name-en: "Monster Hunter 2 [DX Hunters Box]"', '  region: "NTSC-J"', "  compat: 5",
      "SLUS-20062:", '  name: "Grand Theft Auto III"', '  region: "NTSC-U"', "  compat: 6",
      "SLUS-99999:", '  name: "Unrated"', '  region: "NTSC-U"',
    ].join("\n")) as any;
    const r = parsePcsx2(index);
    expect(r.map(x => [x.id, x.name, x.status])).toEqual([["SLPM-66340", "Monster Hunter 2 [DX Hunters Box]", "playable"], ["SLUS-20062", "Grand Theft Auto III", "perfect"]]);
  });
  test("Ryubing CSV: quoted names with commas, labels as a note", () => {
    const csv = 'title_id,game_name,labels,status,last_updated\r\n0100F2C0115B6000,"The Legend of Zelda™: Tears of the Kingdom",gpu;amd-vendor-bug,ingame,2024-08-24 12:38:30\r\n0100000000000001,"Name, With ""Quotes""",,playable,2020-06-27 13:27:30\r\n';
    expect(csvRows(csv)[2][1]).toBe('Name, With "Quotes"');
    const r = parseRyubing(csv);
    expect(r[0]).toMatchObject({ id: "0100F2C0115B6000", status: "ingame", note: "gpu, amd-vendor-bug", at: 1724503110 });
    expect(r[1]).toMatchObject({ name: 'Name, With "Quotes"', status: "playable", note: null });
  });
});

describe("grouping reports into titles", () => {
  test("regions fold into one route with every serial and the best status; demos become their own route", () => {
    expect(baseName("Dark Chronicle [Trial]")).toEqual({ name: "Dark Chronicle", provenance: "demo" });
    expect(baseName("Gran Turismo 4 Prologue [PlayStation 2 Racing Pack]")).toEqual({ name: "Gran Turismo 4 Prologue", provenance: "retail" });
    const out = groupReports([
      { id: "BLES00001", name: "Ridge Racer 7", status: "ingame", at: 100 },
      { id: "BLUS30001", name: "Ridge Racer 7", status: "playable", at: 50, link: "best" },
      { id: "NPUA80001", name: "Ridge Racer 7 Demo", status: "playable", at: 10 },
    ], { runtime: "rpcs3", platform: "ps3", scheme: "serial", cover: ps3Cover });
    expect(out).toHaveLength(2);
    const full = out.find(c => c.routes[0].provenance === "retail")!;
    expect(full.title.ids.map(i => i.value)).toEqual(["BLUS30001", "BLES00001"]);
    expect(full.title.meta?.cover).toMatch(/BLUS30001/);
    expect(full.routes[0]).toMatchObject({ key: "rpcs3:BLES00001", kind: "emulated", status: "playable", link: "best", label: "RPCS3",
      statusNote: "2 releases reported", content: { kind: "disc", accept: { serials: ["BLUS30001", "BLES00001"] } } });
    expect(full.routes[0].needs?.[0].name).toMatch(/PS3 system software/);
    expect(out.find(c => c.routes[0].provenance === "demo")!.title.name).toBe("Ridge Racer 7 Demo");
  });
});

describe("runtime release lookup", () => {
  const rel = (tag: string, prerelease: boolean, date: string, asset: string) => ({ tag_name: tag, name: tag, published_at: date, prerelease, draft: false, html_url: "h",
    assets: [{ name: asset, browser_download_url: `https://dl/${asset}`, size: 1 }] });
  const fake = (routes: Record<string, unknown>) => {
    const seen: string[] = [];
    const f = (async (url: string) => { seen.push(url); const body = routes[url]; return new Response(body === undefined ? "nope" : JSON.stringify(body), { status: body === undefined ? 404 : 200 }); }) as unknown as typeof fetch;
    return { f, seen };
  };
  test("stable asks for the repo's latest release first (busy repos bury it under nightlies)", async () => {
    const { f, seen } = fake({ "https://api.github.com/repos/PCSX2/pcsx2/releases/latest": rel("v2.8.2", false, "2026-09-04", "pcsx2-v2.8.2-windows-x64-Qt.7z") });
    expect(await latestRelease("PCSX2/pcsx2", "windows-x64-Qt\\.7z$", "stable", f)).toMatchObject({ tag: "v2.8.2", asset: { name: "pcsx2-v2.8.2-windows-x64-Qt.7z" } });
    expect(seen).toHaveLength(1);
  });
  test("nightly takes the newest by date even when the list is out of order; Forgejo repos use their own API", async () => {
    const { f } = fake({ "https://api.github.com/repos/o/r/releases?per_page=15": [rel("old", true, "2025-09-19", "a_win64_msvc.7z"), rel("new", true, "2026-10-14", "b_win64_msvc.7z")] });
    expect((await latestRelease("o/r", "_win64_msvc\\.7z$", "nightly", f))?.tag).toBe("new");
    const g = fake({ "https://git.eden-emu.dev/api/v1/repos/eden-emu/eden/releases/latest": rel("v0.2.1", false, "2026-06-01", "Eden-Windows-v0.2.1-amd64-msvc-standard.zip") });
    const { ndeps } = await import("../src/net/public-url");                       // a forgejo host is checked as public first: no real DNS in tests
    const lookup = ndeps.lookup; ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    try { expect((await latestRelease("forgejo:git.eden-emu.dev/eden-emu/eden", "Windows.*amd64-msvc-standard\\.zip$", "stable", g.f))?.tag).toBe("v0.2.1"); }
    finally { ndeps.lookup = lookup; }
  });
  test("Dolphin's update feed", async () => {
    const { f } = fake({ "https://dolphin-emu.org/update/latest/beta/": { shortrev: "2609a", date: "2026-10-08T10:00:00Z", artifacts: [{ system: "Windows x64", url: "https://dl.dolphin-emu.org/releases/2609a/dolphin-2609a-x64.7z" }] } });
    expect(await latestRelease("dolphin:beta", null, "stable", f)).toMatchObject({ tag: "2609a", asset: { name: "dolphin-2609a-x64.7z" } });
  });
});
