/**
 * The engine says which kept game file is a second copy of the game's copy (src/ways/copy.ts secondCopyOf, sent as
 * fileItem's secondCopy): the same bytes as a file the game's package lists, on the same volume under another inode, with no
 * other name — what POST /content/:id/free-duplicate frees. The live case: content row 1, a second copy of package 13's ISO.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow } from "../src/db";
import { secondCopyOf } from "../src/ways/copy";
import { fileItem } from "../src/ways/api";
import { insertContent } from "../src/ways/store";

const tmp = mkdtempSync(join(tmpdir(), "ways-second-copy-"));
const games: number[] = [];
afterAll(() => {
  for (const id of games) { for (const t of ["contents", "packages", "copy_facts"]) db.query(`DELETE FROM ${t} WHERE game_id=?`).run(id); db.query("DELETE FROM games WHERE id=?").run(id); }
  rmSync(tmp, { recursive: true, force: true });
});
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

function setUp(name: string) {
  const g = upsertGame({ name, slug: `second-copy-${games.length + 1}`, platforms_json: JSON.stringify(["PS5"]) } as Partial<GameRow>) as GameRow;
  games.push(g.id);
  const iso = new Uint8Array(64 * 1024).map((_, i) => (i * 31) & 0xff);
  const pkgDir = join(tmp, `pkg-${g.id}`);
  mkdirSync(join(pkgDir, "bbb-ps5-01342"), { recursive: true });
  writeFileSync(join(pkgDir, "bbb-ps5-01342", "bbb-ps5-01342.iso"), iso);
  const manifest = { schema: 1, kind: "rom", platform: "ps5", launch: { exe: "bbb-ps5-01342/bbb-ps5-01342.iso", args: "", cwd: "" }, files: [{ path: "bbb-ps5-01342/bbb-ps5-01342.iso", size: iso.length, sha256: sha256(iso) }] };
  stmts.insertPackage.get(g.id, null, pkgDir, g.name, null, iso.length, JSON.stringify(manifest));
  const store = join(tmp, `store-${g.id}`);
  mkdirSync(store, { recursive: true });
  return { g, iso, pkgFile: join(pkgDir, "bbb-ps5-01342", "bbb-ps5-01342.iso"), store };
}

describe("a second copy of the game's copy, as the engine tells it", () => {
  test("the same bytes in their own space: a second copy, with the bytes freeing it gives back; the listing says so", () => {
    const s = setUp("Second Copy Own Space");
    writeFileSync(join(s.store, "bbb-ps5-01342.iso"), s.iso);
    const row = insertContent({ gameId: s.g.id, platform: "ps5", name: "bbb-ps5-01342.iso", path: join(s.store, "bbb-ps5-01342.iso"), size: s.iso.length, hashes: { sha256: sha256(s.iso) }, source: "package" });
    expect(secondCopyOf(row)).toEqual({ bytes: s.iso.length });
    expect(fileItem(row)).toMatchObject({ id: row.id, onDisk: true, secondCopy: { bytes: s.iso.length } });
  });
  test("a hard link to the copy's own file is no second copy (freeing it would give nothing back)", () => {
    const s = setUp("Second Copy Linked");
    linkSync(s.pkgFile, join(s.store, "bbb-ps5-01342.iso"));
    const row = insertContent({ gameId: s.g.id, platform: "ps5", name: "bbb-ps5-01342.iso", path: join(s.store, "bbb-ps5-01342.iso"), size: s.iso.length, hashes: { sha256: sha256(s.iso) }, source: "package" });
    expect(secondCopyOf(row)).toBeNull();
    expect(fileItem(row).secondCopy).toBeNull();
  });
  test("other bytes, a file gone, or a kept file a package was built from: none is a second copy", () => {
    const s = setUp("Second Copy Others");
    const other = s.iso.map(b => b ^ 1);
    writeFileSync(join(s.store, "other.iso"), other);
    const a = insertContent({ gameId: s.g.id, platform: "ps5", name: "other.iso", path: join(s.store, "other.iso"), size: other.length, hashes: { sha256: sha256(other) }, source: "upload" });
    expect(secondCopyOf(a)).toBeNull();
    writeFileSync(join(s.store, "gone.iso"), s.iso);
    const b = insertContent({ gameId: s.g.id, platform: "ps5", name: "gone.iso", path: join(s.store, "gone.iso"), size: s.iso.length, hashes: { sha256: sha256(s.iso) }, source: "package" });
    unlinkSync(join(s.store, "gone.iso"));
    expect(secondCopyOf(b)).toBeNull();
    writeFileSync(join(s.store, "built.iso"), s.iso);
    linkSync(join(s.store, "built.iso"), join(s.store, "built-into-a-package.iso"));
    const c = insertContent({ gameId: s.g.id, platform: "ps5", name: "built.iso", path: join(s.store, "built.iso"), size: s.iso.length, hashes: { sha256: sha256(s.iso) }, source: "package" });
    expect(secondCopyOf(c)).toBeNull();
  });
});
