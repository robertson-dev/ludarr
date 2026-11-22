/** TENOKE's SETUP.bin container, read without the installer */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLength, entryPath, extractTenoke, parseRecord, recordLength, snappyInto, tenokePackage, unscramble } from "../src/process/tenoke";
import { packEntry, snappyLiteral, tenokePack } from "./tenoke-pack";

const tmp = () => mkdtempSync(join(tmpdir(), "tenoke-"));
const bytes = (n: number, seed = 1) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };

describe("tenoke container", () => {
  test("the length prefix round-trips and rejects anything outside the installer's window", () => {
    for (const n of [0x48, 86, 126, 0x48 + 0x1ffb8]) expect(recordLength(encodeLength(n))).toBe(n);
    expect(recordLength(encodeLength(0x47))).toBe(-1);
    expect(recordLength(Buffer.from("MZ\x90\0"))).toBe(-1);
    expect(recordLength(Buffer.from([0xc5, 0xd3, 0xd0, 0xd0]))).toBe(86);           // the first bytes of every real package seen
  });

  test("snappy: literals, near and far copies, overlapping copies, and refusal of bad streams", () => {
    const text = Buffer.from("abcdefghabcdefgh" + "0123456789".repeat(20));
    const out = Buffer.alloc(text.length);
    expect(snappyInto(snappyLiteral(text, true), out)).toBe(true);
    expect(out.equals(text)).toBe(true);
    // overlapping copy: 'a' then copy 7 bytes from offset 1 → "aaaaaaaa" (type-1 tag, len 7, offset 1)
    const run = Buffer.from([8, 0x00, 0x61, ((7 - 4) << 2) | 1, 1]);
    const o2 = Buffer.alloc(8);
    expect(snappyInto(run, o2)).toBe(true); expect(o2.toString()).toBe("aaaaaaaa");
    expect(snappyInto(Buffer.from([8, 0x00, 0x61]), Buffer.alloc(8))).toBe(false);         // short
    expect(snappyInto(Buffer.from([8, ((7 - 4) << 2) | 1, 1]), Buffer.alloc(8))).toBe(false); // copy before any output
    expect(snappyInto(snappyLiteral(text), Buffer.alloc(text.length + 1))).toBe(false);    // wrong size
  });

  test("records: strings, sizes, method, timestamps; traversal and unknown methods are refused", () => {
    const b = packEntry({ name: "game.exe", dir: "Game\\bin\\", data: bytes(100), method: 0, mtimeMs: Date.UTC(2024, 5, 1) }, 0);
    const len = recordLength(b.subarray(0, 4));
    const e = parseRecord(unscramble(b.subarray(4, 4 + len)), 3, 0, 4 + len);
    expect(e).toMatchObject({ name: "game.exe", dir: ["Game", "bin"], stored: 100, raw: 100, method: 0, dataAt: 4 + len });
    expect(new Date(e.mtimeMs!).toISOString()).toBe("2024-06-01T00:00:00.000Z");
    const bad = packEntry({ name: "x", dir: "Game\\..\\..\\", data: bytes(10) }, 0);
    expect(() => parseRecord(unscramble(bad.subarray(4, 4 + recordLength(bad.subarray(0, 4)))), 1, 0, 0)).toThrow(/escapes/);
    const m = packEntry({ name: "x", dir: "Game\\", data: bytes(10) }, 0);
    const rec = unscramble(m.subarray(4, 4 + recordLength(m.subarray(0, 4)))); rec.writeUInt32LE(7, 16);
    expect(() => parseRecord(rec, 1, 0, 0)).toThrow(/method 7/);
  });

  test("a package: pakinfo read, pakinfo + UNINSTALL.exe skipped, stored / snappy / zlib / blocked files land under the game folder with their mtimes", async () => {
    const dir = tmp();
    const big = bytes(3_000_000, 7);
    const pkg = tenokePack({
      name: "Potato Please", launch: "PotatoPlease.exe", entries: [
        { name: "PotatoPlease.exe", dir: "", data: Buffer.concat([Buffer.from("MZ"), bytes(50_000, 2)]), method: 1, key: 0x1234, withCopy: true },
        { name: "", dir: "D3D12/" },
        { name: "D3D12Core.dll", dir: "D3D12/", data: bytes(20_000, 3), method: 0, mtimeMs: Date.UTC(2021, 0, 2, 3, 4, 5) },
        { name: "readme.txt", dir: "", data: Buffer.from("hello ".repeat(2000)), method: 1, key: 0xbeef, zlib: true },
        { name: "data.pak", dir: "PotatoPlease_Data/", data: big, method: 2, key: 0x55, blockSize: 1_000_000 },
        { name: "mixed.bin", dir: "PotatoPlease_Data/", data: big.subarray(0, 2_500_000), method: 2, key: 0x9, blockSize: 1_000_000, zlib: true },
        { name: "empty.cfg", dir: "", data: Buffer.alloc(0), method: 0 },
      ],
    });
    const bin = join(dir, "SETUP.bin");
    writeFileSync(bin, pkg);
    expect(await tenokePackage(bin)).toMatchObject({ name: "Potato Please", launch: "PotatoPlease.exe", size: pkg.length });

    const out = join(dir, "out");
    const seen: number[] = [];
    const r = await extractTenoke(bin, out, { progress: p => seen.push(p.files) });
    expect(r).toMatchObject({ files: 6, folders: 1, info: { name: "Potato Please", launch: "PotatoPlease.exe" } });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(readdirSync(out).sort()).toEqual(["D3D12", "PotatoPlease.exe", "PotatoPlease_Data", "empty.cfg", "readme.txt"]);
    expect(existsSync(join(out, "UNINSTALL.exe"))).toBe(false);
    expect(existsSync(join(out, "pakinfo"))).toBe(false);
    expect(readFileSync(join(out, "PotatoPlease.exe")).subarray(0, 2).toString()).toBe("MZ");
    expect(readFileSync(join(out, "PotatoPlease.exe")).length).toBe(50_002);
    expect(readFileSync(join(out, "D3D12", "D3D12Core.dll")).equals(bytes(20_000, 3))).toBe(true);
    expect(statSync(join(out, "D3D12", "D3D12Core.dll")).mtime.toISOString()).toBe("2021-01-02T03:04:05.000Z");
    expect(readFileSync(join(out, "readme.txt")).toString()).toBe("hello ".repeat(2000));
    expect(readFileSync(join(out, "PotatoPlease_Data", "data.pak")).equals(big)).toBe(true);
    expect(readFileSync(join(out, "PotatoPlease_Data", "mixed.bin")).equals(big.subarray(0, 2_500_000))).toBe(true);
    expect(statSync(join(out, "empty.cfg")).size).toBe(0);
  });

  test("not a package / a truncated package: recognised as such, extraction fails loudly", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "random.bin"), bytes(200_000, 11));
    expect(await tenokePackage(join(dir, "random.bin"))).toBeNull();
    const pkg = tenokePack({ name: "G", launch: "g.exe", entries: [{ name: "g.exe", dir: "", data: bytes(100_000), method: 0 }] });
    writeFileSync(join(dir, "cut.bin"), pkg.subarray(0, pkg.length - 5_000));
    expect(await tenokePackage(join(dir, "cut.bin"))).not.toBeNull();                 // the manifest is intact …
    await expect(extractTenoke(join(dir, "cut.bin"), join(dir, "o"))).rejects.toThrow(/past the end/);   // … the game is not
    const flipped = Buffer.from(pkg); flipped[pkg.length - 100_000 + 40] ^= 0xff;    // fine for stored data: no checksum in the format
    writeFileSync(join(dir, "flip.bin"), flipped);
    expect((await extractTenoke(join(dir, "flip.bin"), join(dir, "o2"))).files).toBe(1);
  });

  test("a file name is one name: with a separator in it nothing is written, inside the game folder or out of it", async () => {
    // the folder path was always split and checked; the name was only compared whole, so "../../x" passed and was
    // written two folders above the game
    for (const name of ["../../escaped.txt", "..\\..\\escaped.txt", "sub/inner.txt", "..", "."]) {
      const b = packEntry({ name, dir: "Game\\", data: bytes(10) }, 0);
      expect(() => parseRecord(unscramble(b.subarray(4, 4 + recordLength(b.subarray(0, 4)))), 2, 0, 0)).toThrow(/escapes/);
    }
    const base = tmp(), target = join(base, "work", "staging");
    const pkg = tenokePack({ name: "G", launch: "game.exe", entries: [
      { name: "game.exe", dir: "", data: bytes(50_000), method: 0 },
      { name: "../../escaped.txt", dir: "", data: Buffer.from("out of the folder"), method: 0 },
    ] });
    writeFileSync(join(base, "SETUP.bin"), pkg);
    await expect(extractTenoke(join(base, "SETUP.bin"), target)).rejects.toThrow(/escapes the target/);
    expect(existsSync(join(base, "escaped.txt"))).toBe(false);
    expect(readdirSync(base).sort()).toEqual(["SETUP.bin", "work"]);
    expect(readdirSync(join(base, "work"))).toEqual(["staging"]);
  });

  test("where an entry is written is asked of the path itself too: inside the target, or nothing is made", () => {
    const target = join(tmp(), "staging");
    expect(entryPath(target, { index: 3, name: "g.exe", dir: ["Game", "bin"] })).toBe(join(target, "bin", "g.exe"));
    expect(entryPath(target, { index: 3, name: "", dir: ["Game"] })).toBe(target);                       // the game folder itself
    // names that reach it unchecked (a record built by other code) are still held to the folder
    expect(() => entryPath(target, { index: 4, name: "../../x", dir: ["Game"] })).toThrow(/escapes the target/);
    expect(() => entryPath(target, { index: 4, name: "x", dir: ["Game", "..", ".."] })).toThrow(/escapes the target/);
    expect(() => entryPath(target, { index: 4, name: ".", dir: ["Game"] })).toThrow(/names the target itself/);
  });

  test("a file in one block that claims more than is ever packed that way is refused before a buffer is made for it", () => {
    const b = packEntry({ name: "big.pak", dir: "Game\\", data: bytes(100), method: 1, key: 7 }, 0);
    const rec = unscramble(b.subarray(4, 4 + recordLength(b.subarray(0, 4))));
    expect(parseRecord(rec, 2, 0, 0).raw).toBe(100);
    rec.writeUInt32LE(0xf0000000, 8);                                                 // 3.75 GB "unpacked", in a 100-byte block
    expect(() => parseRecord(rec, 2, 0, 0)).toThrow(/in one block/);
    rec.writeUInt32LE(100, 8); rec.writeUInt32LE(3, 12);                              // … and past 4 GB
    expect(() => parseRecord(rec, 2, 0, 0)).toThrow(/in one block/);
    // a stored or a blocked file may be as large as the game needs
    const big = packEntry({ name: "big.pak", dir: "Game\\", data: bytes(100), method: 2, key: 7 }, 0);
    const rec2 = unscramble(big.subarray(4, 4 + recordLength(big.subarray(0, 4)))); rec2.writeUInt32LE(8, 12);
    expect(parseRecord(rec2, 2, 0, 0).raw).toBe(8 * 4294967296 + 100);
  });
});
