/**
 * What an input is (src/ways/inspect.ts), from small reads and listings only: a folder walked (the game folder found inside
 * a release folder, the markers, the first members, links listed and never followed), a file's format by its magic
 * whatever it is called, its identity by the readers, a UDF image listed by ludarr's own reader and an archive by 7-Zip as
 * the build user (a fake exec here); exFAT and UFS2 images named as forms ludarr cannot open yet; one small member taken
 * out of a folder, a .zar, a UDF image or an archive; and whether a game folder is the whole game, not an update or a part.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { completeness, describeInput, extractMember, fileFormat, ideps, linkable, parseSlt } from "../src/ways/inspect";
import type { SandboxOpts } from "../src/ways/sandbox";
import { eboot, exfatImage, noise, ootNup, ps5Disc, ps5Param, ufsImage, writeApp0, writeExefsFolder, zarArchive } from "./ways-images";

const dir = mkdtempSync(join(tmpdir(), "ways-inspect-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (name: string, bytes: Uint8Array | string) => { const p = join(dir, `${++n}-${name}`); writeFileSync(p, bytes); return p; };
const folder = (name: string) => { const p = join(dir, `${++n}-${name}`); mkdirSync(p, { recursive: true }); return p; };
const saved = { ...ideps };
afterEach(() => Object.assign(ideps, saved));
const canLink = (() => { try { const t = join(dir, "link-probe"); writeFileSync(t + "-target", "x"); symlinkSync(t + "-target", t); return true; } catch { return false; } })();

/** what `7z l -slt -ba` prints for an archive holding a dumped PS5 game folder */
const SLT = [
  "Path = PPSA01341-app0", "Folder = +", "Size = 0", "Attributes = D", "",
  "Path = PPSA01341-app0/sce_sys/param.json", "Folder = -", "Size = 1834", "Attributes = A", "",
  "Path = PPSA01341-app0/eboot.bin", "Folder = -", "Size = 1048576", "Attributes = A", "",
  "Path = PPSA01341-app0/levels/huge.bin", "Folder = -", "Size = 40000000", "Attributes = A", "",
].join("\n");
/** a fake 7-Zip run as the build user: lists, or writes the member asked for into its -o folder */
function fake7z(calls: { cmd: string[]; o: SandboxOpts }[], body: Record<string, Uint8Array> = {}) {
  ideps.sevenZip = () => "/usr/bin/7zz";
  ideps.handTo = async () => { /* nothing to hand over here */ };
  ideps.sandboxed = () => false;                                            // a dev box: the input may be linked in
  ideps.exec = async (cmd, o) => {
    calls.push({ cmd, o });
    if (cmd[1] === "l") return { code: 0, stdout: SLT, stderr: "", timedOut: false };
    const out = cmd.find(a => a.startsWith("-o"))!.slice(2), member = cmd[cmd.length - 1];
    if (body[member]) writeFileSync(join(out, basename(member)), body[member]);
    return { code: body[member] ? 0 : 2, stdout: "", stderr: "", timedOut: false };
  };
}

describe("describing a folder", () => {
  test("a PS5 app0 folder: its identity, markers, members (listed by the file system) and size", async () => {
    const app0 = writeApp0(folder("PPSA01341-app0"));
    const d = await describeInput(app0);
    expect(d).toMatchObject({ shape: "folder", format: "folder", sealed: false, listing: "fs", why: null });
    expect(d.identity).toMatchObject({ platform: "ps5", serial: "PPSA01341", version: "01.007.000", shape: "folder" });
    expect(d.markers).toEqual(expect.arrayContaining(["sce_sys/param.json", "eboot.bin"]));
    expect(d.members!.map(m => m.path)).toEqual(expect.arrayContaining(["sce_sys", "sce_sys/param.json", "eboot.bin", "levels/m01/map.bin"]));
    expect(d.size).toBe(d.members!.filter(m => !m.dir).reduce((a, m) => a + m.size, 0));
  });
  test("a release folder holding the dump: the game folder inside is found (≤ 4 folders down) and read", async () => {
    const rel = folder("Demons.Souls.PS5-DUMP");
    writeApp0(join(rel, "Demon's Souls", "PPSA01341-app0"));
    writeFileSync(join(rel, "release.nfo"), "nfo");
    const d = await describeInput(rel);
    expect(d.identity).toMatchObject({ serial: "PPSA01341", shape: "folder" });
    expect(d.why).toBe("the game folder inside is Demon's Souls/PPSA01341-app0");
    expect(d.markers).toContain("Demon's Souls/PPSA01341-app0/sce_sys/param.json");
  });
  test("two game folders: neither is taken, both named; a folder of nothing says why", async () => {
    const two = folder("two");
    writeApp0(join(two, "app"), {});
    writeApp0(join(two, "patch"), { version: "01.007.000" });
    const d = await describeInput(two);
    expect(d.identity).toBeNull();
    expect(d.why).toBe("it holds 2 game folders (app, patch)");
    const empty = folder("empty");
    writeFileSync(join(empty, "readme.txt"), "hi");
    expect((await describeInput(empty)).why).toContain("nothing in it says which game it is");
  });
  test("at most 400 members are listed, every file's size still counted", async () => {
    const big = folder("big");
    for (let i = 0; i < 450; i++) writeFileSync(join(big, `f${String(i).padStart(3, "0")}.bin`), "ab");
    const d = await describeInput(big);
    expect(d.members!.length).toBe(400);
    expect(d.size).toBe(900);
  });
  test.skipIf(!canLink)("a link inside is listed, said, and never followed; a link given as the input is only a link", async () => {
    const f = writeApp0(folder("linky"));
    symlinkSync(join(dir, "elsewhere"), join(f, "outside"));
    const d = await describeInput(f);
    expect(d.why).toContain("a link (outside), which ludarr never follows");
    const l = join(dir, `${++n}-link`);
    symlinkSync(f, l, "dir");
    expect(await describeInput(l)).toMatchObject({ format: "link", identity: null, why: "it is a link, and ludarr never follows one" });
  });
});

describe("describing a file", () => {
  test("a .zar: format by its footer whatever it is called, its identity and markers", async () => {
    const z = zarArchive([{ path: "sce_sys/param.json", data: ps5Param() }, { path: "eboot.bin", data: eboot() }]);
    const d = await describeInput(file("PPSA01341.bin", z));
    expect(d).toMatchObject({ shape: "file", format: "zar", sealed: false, markers: ["sce_sys/param.json", "eboot.bin"], members: null, listing: "none", why: null });
    expect(d.identity).toMatchObject({ serial: "PPSA01341", shape: "zar" });
  });
  test("the PS5 retail disc image: sealed, listed by ludarr's UDF reader", async () => {
    const d = await describeInput(file("bbb-ps5-01342.iso", ps5Disc()), { platform: "ps5" });
    expect(d).toMatchObject({ format: "iso", sealed: true, listing: "udf", markers: ["bd/param.json", "app/PPSA01342/app_0.pkg"] });
    expect(d.identity).toMatchObject({ serial: "PPSA01342", masterVersion: "01.00", shape: "bd-image" });
    expect(d.members!.map(m => m.path)).toEqual(expect.arrayContaining(["bd/param.json", "app/PPSA01342/app_0.pkg"]));
  });
  test("a .nup: its titles and build", async () => {
    const d = await describeInput(file("oot.nup", ootNup()));
    expect(d.format).toBe("nup");
    expect(d.identity).toMatchObject({ platform: "switch", serial: "0400486024DEC000", build: expect.stringMatching(/^e0f3ccfa/) });
  });
  test("exFAT and UFS2 disk images are named, as forms ludarr cannot open yet", async () => {
    expect(await describeInput(file("PPSA01341.exfat", exfatImage()))).toMatchObject({ format: "exfat", identity: null, sealed: false, listing: "none", why: "an exFAT disk image: a form ludarr cannot open yet" });
    expect(await describeInput(file("PPSA01341.ffpkg", ufsImage()))).toMatchObject({ format: "ufs", identity: null, why: "a UFS2 disk image (a PS5 dump's .ffpkg): a form ludarr cannot open yet" });
  });
  test("an archive is listed by 7-Zip as the build user, the input handed in by a link inside the job's scratch folder", async () => {
    const calls: { cmd: string[]; o: SandboxOpts }[] = [];
    fake7z(calls);
    const work = folder("work");
    const zip = file("Demons.Souls.rar", new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, ...noise(100)]));
    const d = await describeInput(zip, { work });
    expect(d).toMatchObject({ format: "rar", listing: "7z", identity: null, why: null });
    expect(d.members).toEqual([
      { path: "PPSA01341-app0", size: 0, dir: true }, { path: "PPSA01341-app0/sce_sys/param.json", size: 1834, dir: false },
      { path: "PPSA01341-app0/eboot.bin", size: 1048576, dir: false }, { path: "PPSA01341-app0/levels/huge.bin", size: 40000000, dir: false },
    ]);
    expect(calls[0].cmd.slice(0, 5)).toEqual(["/usr/bin/7zz", "l", "-slt", "-ba", "--"]);
    expect(calls[0].o.work.startsWith(join(work, "inspect"))).toBe(true);
    expect(basename(calls[0].cmd[5])).toBe("in-" + basename(zip));
  });
  test("no 7-Zip: the archive is not listed, and the description says so", async () => {
    ideps.sevenZip = () => null;
    const d = await describeInput(file("x.zip", new Uint8Array([0x50, 0x4b, 3, 4, ...noise(50)])));
    expect(d).toMatchObject({ format: "zip", listing: "none", members: null, why: "7-Zip is not here to list it" });
  });
  test("random bytes, a missing path, cartridges by their header", async () => {
    expect((await describeInput(file("noise.zar", noise(5000)))).why).toBe("its last bytes are not a ZArchive footer");
    expect(await describeInput(join(dir, "missing"))).toMatchObject({ format: "missing", why: "it is not there" });
    expect(await fileFormat(file("a.z64", noise(100)), "a.z64")).toBe("z64");
  });
  test("7-Zip's -slt blocks: the archive's own block left out", () => {
    expect(parseSlt("Path = x.7z\nType = 7z\n\n----------\nPath = a\\b.txt\nSize = 3\nFolder = -\n")).toEqual([{ path: "a/b.txt", size: 3, dir: false }]);
  });
});

describe("taking one member out", () => {
  test("from a folder (never through a link, never climbing out), a .zar and a UDF image", async () => {
    const app0 = writeApp0(folder("x-app0"));
    const to = folder("out");
    const p = await extractMember(app0, "sce_sys/param.json", to);
    expect(JSON.parse(readFileSync(p, "utf8")).titleId).toBe("PPSA01341");
    await expect(extractMember(app0, "../escape.txt", to)).rejects.toThrow("is not a path inside the input");
    await expect(extractMember(app0, "sce_sys/missing.json", to)).rejects.toThrow("it holds no sce_sys/missing.json");
    const z = file("m.zar", zarArchive([{ path: "sce_sys/param.json", data: ps5Param({ title: "From The Archive" }) }, { path: "eboot.bin", data: eboot() }]));
    expect(readFileSync(await extractMember(z, "sce_sys/param.json", to), "utf8")).toContain("From The Archive");
    const iso = file("m.iso", ps5Disc());
    expect(readFileSync(await extractMember(iso, "bd/param.json", to)).subarray(0, 6).toString()).toBe("SCECDF");
  });
  test("from an archive: by 7-Zip as the build user into a folder of its own, at most 16 MB", async () => {
    const calls: { cmd: string[]; o: SandboxOpts }[] = [];
    fake7z(calls, { "PPSA01341-app0/sce_sys/param.json": ps5Param({ title: "Out Of The RAR" }) });
    const rar = file("g.rar", new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, ...noise(100)]));
    const to = folder("out-rar");
    const p = await extractMember(rar, "PPSA01341-app0/sce_sys/param.json", to, { work: folder("w") });
    expect(p).toBe(join(to, "param.json"));
    expect(readFileSync(p, "utf8")).toContain("Out Of The RAR");
    const e = calls.find(c => c.cmd[1] === "e")!;
    expect(e.cmd.slice(0, 6)).toEqual(["/usr/bin/7zz", "e", "-y", "-bd", "-bb0", "-spd"]);
    await expect(extractMember(rar, "PPSA01341-app0/levels/huge.bin", to)).rejects.toThrow("only files up to 16 MB are taken out for a look");
    await expect(extractMember(rar, "nothing.txt", to)).rejects.toThrow("it holds no nothing.txt");
  });
});

describe("whether a game folder is the whole game (an update alone is not)", () => {
  const listOf = (paths: string[]) => paths.map(p => p + "\r");                 // the program's list is written with CRLF
  test("counts and sizes: enough files and bytes, or the words of what is missing", async () => {
    const g = writeApp0(folder("whole"));
    const progress: number[] = [];
    expect(await completeness(g, { minFiles: 5, minBytes: 10_000 }, { progress: f => progress.push(f) })).toMatchObject({ ok: true, why: null, files: 6 });
    expect(progress.at(-1)).toBe(6);
    const few = await completeness(g, { minFiles: 100_000 });
    expect(few.ok).toBe(false);
    expect(few.why).toMatch(/^an update or a part of the game, not the whole game: it holds 6 files \(\d+ bytes\), and the whole game holds at least 100,000 files$/);
    expect((await completeness(g, { minBytes: 70e9 })).why).toMatch(/the whole game is at least 70\.0 GB$/);
  });
  test("the program's list of the game's files: at least 98% of its paths there (case, slashes and app0/ aside)", async () => {
    const g = folder("listed");
    const paths = Array.from({ length: 100 }, (_, i) => `data/Chunk${i}.ctxc`);
    for (const p of paths) { mkdirSync(join(g, "data"), { recursive: true }); writeFileSync(join(g, p), "x"); }
    const list = listOf([...paths.slice(0, 99).map(p => p.toLowerCase()), "/app0/data/Chunk99.ctxc".replace("Chunk", "chunk")]);
    expect(await completeness(g, { list: { path: "tools/local/static-precompile/files-PPSA01341_01.007.000.files" } }, { list })).toMatchObject({ ok: true, listed: 100, present: 100 });
    const update = folder("update-only");
    mkdirSync(join(update, "data"), { recursive: true });
    for (const p of paths.slice(0, 60)) writeFileSync(join(update, p), "x");
    const r = await completeness(update, { list: { path: "files.files" } }, { list });
    expect(r).toMatchObject({ ok: false, listed: 100, present: 60 });
    expect(r.why).toBe("an update or a part of the game, not the whole game: 60% of the 100 files the program lists for it are there (the whole game has 98%)");
    expect((await completeness(update, { list: { path: "files.files", share: 0.5 } }, { list })).ok).toBe(true);
  });
  test("a list the plan names but the caller could not read is not taken as complete; a file is not a game folder", async () => {
    const g = writeApp0(folder("nolist"));
    expect((await completeness(g, { list: { path: "files.files" } })).why).toBe("the program's list of the game's files (files.files) could not be read, so it cannot be told whether this is the whole game");
    expect((await completeness(file("x.zar", "z"), { minFiles: 1 })).why).toBe("it is not a folder, so it cannot be the whole game");
  });
  test.skipIf(!canLink)("links are neither followed nor counted", async () => {
    const g = writeApp0(folder("links"));
    symlinkSync(join(g, "eboot.bin"), join(g, "again.bin"));
    expect((await completeness(g, { minFiles: 1 })).files).toBe(6);
  });
});

describe("nothing is written through a link, nothing planted is taken (skeptic)", () => {
  const rar = () => file("g.rar", new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, ...noise(100)]));
  test("a file planted under the member's name in the folder it goes to is replaced, never written through", async () => {
    const app0 = writeApp0(folder("plant-app0"));
    const to = folder("plant-out");
    const victim = file("victim.txt", "keep me");
    linkSync(victim, join(to, "param.json"));                                 // a second name for a file elsewhere
    const p = await extractMember(app0, "sce_sys/param.json", to);
    expect(JSON.parse(readFileSync(p, "utf8")).titleId).toBe("PPSA01341");
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(statSync(p).nlink).toBe(1);
    expect(readdirSync(to)).toEqual(["param.json"]);                          // no part file left behind
    // the same from a .zar and from an archive 7-Zip takes the member out of
    const z = file("plant.zar", zarArchive([{ path: "sce_sys/param.json", data: ps5Param() }, { path: "eboot.bin", data: eboot() }]));
    linkSync(victim, join(to, "eboot.bin"));
    await extractMember(z, "eboot.bin", to);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    fake7z([], { "PPSA01341-app0/sce_sys/param.json": ps5Param({ title: "Planted" }) });
    const to2 = folder("plant-out2");
    linkSync(victim, join(to2, "param.json"));
    await extractMember(rar(), "PPSA01341-app0/sce_sys/param.json", to2, { work: folder("w-plant") });
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(readFileSync(join(to2, "param.json"), "utf8")).toContain("Planted");
  });
  test.skipIf(!canLink)("a link planted under the member's name, or given as the folder, is never followed", async () => {
    const app0 = writeApp0(folder("ln-app0"));
    const victim = file("ln-victim.txt", "keep me");
    const to = folder("ln-out");
    symlinkSync(victim, join(to, "param.json"));
    await extractMember(app0, "sce_sys/param.json", to);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    const elsewhere = folder("ln-elsewhere");
    const linkedDir = join(dir, `${++n}-ln-dir`);
    symlinkSync(elsewhere, linkedDir, "dir");
    await expect(extractMember(app0, "sce_sys/param.json", linkedDir)).rejects.toThrow("is a link or not a folder");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  test("what 7-Zip left that has a second name (a file linked in from elsewhere) is refused, not moved", async () => {
    const outside = file("outside-secret.txt", "secret");
    ideps.sevenZip = () => "/usr/bin/7zz";
    ideps.handTo = async () => { /* nothing to hand over here */ };
    ideps.exec = async cmd => {
      if (cmd[1] === "l") return { code: 0, stdout: SLT, stderr: "", timedOut: false };
      const out = cmd.find(a => a.startsWith("-o"))!.slice(2);
      linkSync(outside, join(out, "param.json"));                             // as a build program could
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await expect(extractMember(rar(), "PPSA01341-app0/sce_sys/param.json", folder("o-linked"), { work: folder("w-linked") })).rejects.toThrow("is linked from elsewhere, so it is not taken out");
  });
  test("a member whose name 7-Zip would read as a list of names is not taken out", async () => {
    ideps.sevenZip = () => "/usr/bin/7zz";
    ideps.exec = async () => ({ code: 0, stdout: ["Path = @list.txt", "Folder = -", "Size = 10", ""].join("\n"), stderr: "", timedOut: false });
    await expect(extractMember(rar(), "@list.txt", folder("o-at"))).rejects.toThrow("a name 7-Zip would read as a list of names");
  });
  test("a hard link hands the input in only when no build user could change the file through it", () => {
    const users = { uids: [1500, 1501], gids: [1500, 1501] };
    expect(linkable({ mode: 0o100444, uid: 0, gid: 0 }, true, users)).toBe(true);
    expect(linkable({ mode: 0o100666, uid: 99, gid: 100 }, true, users)).toBe(false);          // others may write it
    expect(linkable({ mode: 0o100664, uid: 0, gid: 1501 }, true, users)).toBe(false);          // a build user's group may
    expect(linkable({ mode: 0o100664, uid: 0, gid: 100 }, true, users)).toBe(true);            // the users group: no build user in it
    expect(linkable({ mode: 0o100444, uid: 1500, gid: 1500 }, true, users)).toBe(false);       // a build user's own file
    expect(linkable({ mode: 0o100666, uid: 99, gid: 100 }, false, users)).toBe(true);          // no sandbox here: nothing changes hands
  });
  test("a look without a job folder gets a fresh folder of its own under the temp folder, never a name planted beforehand", async () => {
    const calls: { cmd: string[]; o: SandboxOpts }[] = [];
    fake7z(calls);
    const zip = file("fresh.zip", new Uint8Array([0x50, 0x4b, 3, 4, ...noise(50)]));
    await describeInput(zip);
    await describeInput(zip);
    expect(calls.length).toBe(2);
    for (const c of calls) { expect(basename(c.o.work).startsWith("ludarr-inspect-")).toBe(true); expect(dirname(c.o.work)).toBe(tmpdir()); }
    expect(calls[0].o.work).not.toBe(calls[1].o.work);
    // the job's own: under its inspect folder, and gone afterwards
    const work = folder("w-fresh");
    await describeInput(zip, { work });
    expect(dirname(calls[2].o.work)).toBe(join(work, "inspect"));
    expect(readdirSync(join(work, "inspect"))).toEqual([]);
  });
});

describe("a Switch game folder (skeptic)", () => {
  test("a release folder holding exefs and romfs: the game folder inside is found and its build read", async () => {
    const rel = folder("OoT.Switch2.Dump");
    writeExefsFolder(join(rel, "0400486024DEC000"));
    const d = await describeInput(rel);
    expect(d.identity).toMatchObject({ platform: "switch", build: expect.stringMatching(/^e0f3ccfaf50065ae/), shape: "folder" });
    expect(d.why).toBe("the game folder inside is 0400486024DEC000");
  });
});
