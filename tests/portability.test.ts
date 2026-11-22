import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverPathInFile } from "../src/process/portability";

const root = mkdtempSync(join(tmpdir(), "ludarr-portability-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
async function check(data: Buffer | string, ext = "exe", work = "/library/.work/job-125") {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const path = join(root, `${++n}.${ext}`);
  writeFileSync(path, b);
  return serverPathInFile(path, b.length, work, "/library/.ahoy-content");
}

test("compiled defaults in large executables are checked across read boundaries, in narrow and wide strings", async () => {
  for (const encoding of ["utf8", "utf16le"] as const) for (const offset of [0, 1]) {
    const exe = Buffer.alloc(2_000_000);
    exe.write("MZ");
    Buffer.from("Z:/library/.work/job-125/scratch/ac/profile\0", encoding).copy(exe, 16 * 65536 - 9 + offset);
    expect(await check(exe)).toBe("a wine Z: drive path");
  }
});

test("relative defaults and diagnostic source paths pass; a runtime path beside them still fails", async () => {
  const diagnostic = "MZ\0Z:/library/.work/job-125/runtime/main.c\0Z:/library/.work/job-125/debug/game.pdb\0";
  expect(await check(diagnostic + "exefs\0romfs\0profile\0")).toBeNull();
  expect(await check(diagnostic + "/library/.work/job-125/profile\0")).toBe("the build's scratch folder");
  expect(await check("MZ\0/library/.ahoy-content/game/romfs\0", "dll")).toBe("the server's content store");
  expect(await check("MZ\0/tmp/büild/profile\0", "exe", "/tmp/büild")).toBe("the build's scratch folder");
});

test("text configs keep their checks; large game data is excluded", async () => {
  expect(await check(Buffer.from("profile=Z:\\library\\.work\\job-125\\profile", "utf16le"), "ini")).toBe("a wine Z: drive path");
  expect(await check("profile=/library/.work/job-125/profile", "ini")).toBe("the build's scratch folder");
  const data = Buffer.alloc(2_000_000); data.write("Z:/library/.work/job-125/profile\0");
  expect(await check(data, "bin")).toBeNull();
});

test("long printable runs without terminators are scanned in linear time", async () => {
  expect(await check(Buffer.alloc(6_000_000, 65))).toBeNull();
});

test("PE debug directory tables are metadata; the same path in loaded data still fails", async () => {
  const pe = Buffer.alloc(4_000_000);
  pe.write("MZ"); pe.writeUInt32LE(128, 60); pe.writeUInt32LE(0x4550, 128);
  pe.writeUInt16LE(2, 134); pe.writeUInt32LE(1_900_000, 140);
  // No optional header needed by the scanner; two section headers at 152 and 192.
  pe.write(".rdata", 152); pe.writeUInt32LE(65536, 168); pe.writeUInt32LE(4096, 172); pe.writeUInt32LE(0x40000040, 188);
  pe.write("/4", 192); pe.writeUInt32LE(65536, 208); pe.writeUInt32LE(80000, 212); pe.writeUInt32LE(0x42000040, 228);
  pe.writeUInt32LE(1_200_000, 1_900_000); pe.write(".debug_line_str\0", 1_900_004);
  pe.write("Z:/library/.work/job-125/program\0", 90000);
  expect(await check(pe)).toBeNull();
  pe.write("Z:/library/.work/job-125/profile\0", 5000);
  expect(await check(pe)).toBe("a wine Z: drive path");
  pe.fill(0, 5000, 5100);
  // A malformed section pointing over loaded data must not hide a runtime default.
  pe.writeUInt32LE(4096, 212); pe.write("Z:/library/.work/job-125/profile\0", 5000);
  expect(await check(pe)).toBe("a wine Z: drive path");
});

test("character tables shipped in Python and libiconv pass; adjacent runtime paths are still caught", async () => {
  const tables = Buffer.concat([
    Buffer.from("MZ\0r>r?rnK-;z:/A@rCrArDrq8BrErFrGrKr*;dBLrIrHrJr_7\0", "ascii"),
    Buffer.from("5bfc5a3a5cfc5dfc2d47005a00", "hex"),
    Buffer.from("49fd7a3a2f414afd4dfd407200", "hex"),
  ]);
  expect(await check(tables, "dll")).toBeNull();
  for (const path of ["--config=Z:/profile", "PATH=C:\\runtime;Z:/data", "%PATH%;Z:/cache"]) {
    expect(await check(Buffer.concat([tables, Buffer.from("\0" + path + "\0")]), "dll")).toBe("a wine Z: drive path");
  }
});

// The only matching narrow string in the shipped NVIDIA ray-reconstruction DLL was "$z:/".
test("a drive-like machine-code fragment is not a runtime path; bare prefixes pass and named paths still fail", async () => {
  expect(await check("MZ\0$z:/\0", "dll")).toBeNull();
  expect(await check("MZ\0Z:/\0", "dll")).toBeNull();
  expect(await check("MZ\0$z:/profile\0", "dll")).toBe("a wine Z: drive path");
  expect(await check("profile=$z:/", "ini")).toBe("a wine Z: drive path");
});
