/**
 * src/process/validate.ts in wave 3 (DESIGN3 B3 item 8): a PS5 app0 folder (sce_sys/param.json) is a console dump an import
 * keeps, its launch the marker (the dump is the folder, read as one by src/ways/copy.ts); and the manifest takes a sha256
 * it is given only while the file's stat is the one recorded with it.
 */
import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, inspectRom, vdeps, type KnownFile, type Validation } from "../src/process/validate";
import { ROM_MARKER } from "../src/platforms";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

describe("inspectRom: folder dumps", () => {
  test("validation and packaging include a PS5 marker and game assets beyond the discovery sample", async () => {
    const dir = tmp("pv-ps5-large-");
    mkdirSync(join(dir, "sce_sys"));
    writeFileSync(join(dir, "data.bin"), new Uint8Array(5_000_000));
    writeFileSync(join(dir, "eboot.bin"), "program");
    writeFileSync(join(dir, "sce_sys", "param.json"), JSON.stringify({ titleId: "PPSA21564" }));
    writeFileSync(join(dir, "tail.dat"), "last game asset");
    const scan = vdeps.scan;
    // Use the real walker with a small default sample so this exercises the cutoff without 50,001 fixture files.
    vdeps.scan = (path, limit = 1) => scan(path, limit);
    try {
      const v = await inspectRom(dir);
      expect(v).toMatchObject({ ok: true, fileCount: 4, launch: "sce_sys/param.json" });
      const m = await buildManifest(v, { name: "Astro Bot", version: null, source: null, tier: "deterministic", kind: "rom", platform: "ps5" });
      expect(m.files.map(f => f.path)).toEqual(["data.bin", "eboot.bin", "sce_sys/param.json", "tail.dat"]);
      expect(m.files.find(f => f.path === "tail.dat")?.sha256).toBe(sha256("last game asset"));
      expect(m.totalSize).toBe(v.totalSize);
      writeFileSync(join(dir, "z-leftover.rar"), "unpacked incompletely");
      expect((await inspectRom(dir)).problems.join(" ")).toContain("z-leftover.rar");
    } finally {
      vdeps.scan = scan;
    }
  });

  test("a PS5 app0 folder (sce_sys/param.json beside eboot.bin) is a dump, launched by its marker; the wrapping folder is unwrapped", async () => {
    const dir = tmp("pv-ps5-");
    const app0 = join(dir, "PPSA01341-app0");
    mkdirSync(join(app0, "sce_sys"), { recursive: true });
    writeFileSync(join(app0, "eboot.bin"), new Uint8Array(7_000_000).fill(1));
    writeFileSync(join(app0, "sce_sys", "param.json"), JSON.stringify({ titleId: "PPSA01341", contentVersion: "01.007.000" }));
    const v = await inspectRom(dir);
    expect(v).toMatchObject({ ok: true, launch: "sce_sys/param.json", root: app0, problems: [] });
    // the PS4 one as it was: its param.sfo
    const ps4 = tmp("pv-ps4-");
    mkdirSync(join(ps4, "sce_sys"), { recursive: true });
    writeFileSync(join(ps4, "eboot.bin"), new Uint8Array(7_000_000).fill(2));
    writeFileSync(join(ps4, "sce_sys", "param.sfo"), "\0PSF");
    expect(await inspectRom(ps4)).toMatchObject({ ok: true, launch: "sce_sys/param.sfo" });
    expect(["sce_sys/param.json", "PPSA01341-app0/sce_sys/PARAM.JSON"].map(p => ROM_MARKER.test(p))).toEqual([true, true]);
    expect(ROM_MARKER.test("sce_sys/param.json.bak")).toBe(false);
  });
});

describe("buildManifest: the sha256 it is given", () => {
  const meta = { name: "G", version: null, source: null, tier: "deterministic" as const };
  test("taken while the stat holds (size, both times, device, inode), the file read like any other once one of them differs", async () => {
    const dir = tmp("pv-known-");
    writeFileSync(join(dir, "Game.exe"), "exe");
    const data = new Uint8Array(100_000).fill(4);
    writeFileSync(join(dir, "data.bin"), data);
    const v: Validation = { ok: true, root: dir, problems: [], exeCandidates: ["Game.exe"], launch: "Game.exe", prerequisites: [], totalSize: 0, fileCount: 2 };
    const st = lstatSync(join(dir, "data.bin"));
    const known = (over: Partial<KnownFile> = {}) => new Map<string, KnownFile>([["data.bin", { sha256: "f".repeat(64), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, dev: st.dev, ino: st.ino, ...over }]]);
    const reads: string[] = [];
    const real = vdeps.sha256;
    vdeps.sha256 = async (p, onBytes, signal) => { reads.push(p); return real(p, onBytes, signal); };
    try {
      const progress: [number, number][] = [];
      const m = await buildManifest(v, meta, (d, t) => progress.push([d, t]), { known: known() });
      expect(m.files).toEqual([{ path: "Game.exe", size: 3, sha256: sha256("exe") }, { path: "data.bin", size: 100_000, sha256: "f".repeat(64) }]);
      expect(reads.map(r => r.split(/[\\/]/).pop())).toEqual(["Game.exe"]);
      expect(progress.at(-1)).toEqual([100_003, 100_003]);                  // a known file counts as done in the progress
      for (const over of [{ size: st.size + 1 }, { mtimeMs: st.mtimeMs + 1 }, { ctimeMs: st.ctimeMs + 1 }, { ino: st.ino + 1 }, { dev: st.dev + 1 }]) {
        reads.length = 0;
        const again = await buildManifest(v, meta, undefined, { known: known(over) });
        expect(again.files[1].sha256).toBe(sha256(data));
        expect(reads.length).toBe(2);
      }
      // a write after it was placed moves its time: read again
      utimesSync(join(dir, "data.bin"), new Date(), new Date(Date.now() + 5000));
      reads.length = 0;
      expect((await buildManifest(v, meta, undefined, { known: known() })).files[1].sha256).toBe(sha256(data));
      expect(reads.length).toBe(2);
    } finally { vdeps.sha256 = real; }
  });
});
