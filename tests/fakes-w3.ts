/** Test fakes for shapes that grew when the wave-3 builders' copies were merged: a test that cares about a few fields of the
 *  game's copy, or of a placed file, gets the whole shape from these. */
import type { CopyEntry, CopyFacts } from "../src/ways/copy";
import type { Placed } from "../src/ways/program";

type CopyFake = Partial<CopyFacts> & Pick<CopyFacts, "packageId" | "rel" | "path" | "shape" | "size">;

/** the game's copy judged in place (src/ways/copy.ts CopyFacts): the given fields are its main piece, mirrored as entries[0]
 *  unless entries are given */
export function copyFactsOf(p: CopyFake): CopyFacts {
  const name = p.name ?? p.rel.split("/").pop() ?? p.rel;
  const ext = name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "";
  const entry: CopyEntry = {
    rel: p.rel, path: p.path, name, shape: p.shape, size: p.size, mtime: p.mtime ?? 1,
    format: p.format ?? (p.shape === "folder" ? "folder" : ext),
    sha256: p.sha256 ?? null, hashes: p.hashes ?? (p.sha256 ? { sha256: p.sha256 } : {}), rawHashes: p.rawHashes ?? null,
    hashed: p.hashed ?? null, identity: p.identity ?? null, markers: p.markers ?? [],
    platform: p.platform ?? p.identity?.platform ?? null, sealed: p.sealed ?? !!p.identity?.sealed,
    contentId: p.contentId ?? null, files: p.files ?? null, why: p.why ?? null,
  };
  return { ...entry, packageId: p.packageId, kind: p.kind ?? "rom", judgedAt: p.judgedAt ?? 1, entries: p.entries ?? [entry] };
}

/** what placeContent put into STAGING (src/ways/program.ts Placed), from the fields a fake placement knows */
export function placedOf(p: Pick<Placed, "rel" | "abs" | "linked" | "links"> & Partial<Placed>): Placed {
  return { bytes: 0, files: [], ...p };
}
