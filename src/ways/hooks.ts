/**
 * ludarr — where the ways to play meet the rest of the engine, wired once when this module is imported (by
 * src/ways/api.ts, so the server and the tests get it with the routes):
 *   - a console dump imported for a game is judged where it lies (src/ways/copy.ts judgeCopy: small reads, never a copy to
 *     look at it), and every way of the game settles on what the copy is to it. For its ready ways that check their game
 *     file (by hash, or by the serial or game code its bytes carry), a way the copy is plainly no file for (another form,
 *     sealed, another console or game) is told so without a read; for the others the dump is read where it lies once, and
 *     judged as the way's own search judges a file (src/ways/find.ts judgeFile: the dump list, the dump's name, its disc,
 *     what its bytes say). Only for the ways that proves is the dump linked into the content store (a hard link: the dump
 *     stays the game's copy), and the best such way is built; nothing is written for a dump no way takes. A way that
 *     checks nothing (an emulator's without serials) never takes a dump by itself;
 *   - a way with no game file takes it from the game's copy when the copy is its file (copy.ts takeCopy: the kept row of the
 *     same bytes, or a hard link and a hash where it lies; a copy only across volumes) — assembly asks through
 *     adeps.contentFromPackage, with its progress and its cancel; a copy that is not the way's file (what its make takes,
 *     another form, sealed) is refused with the copy's own words, before anything is read;
 *   - the custom catalog source is ingested again whenever a game changes, a build or an import ends, or a package is
 *     removed, so "Ways to play" follows;
 *   - the assemble job kind registers itself when src/ways/assemble.ts is imported, here.
 */
import { stmts, type GameRow } from "../db";
import { events } from "../events";
import { logger } from "../log";
import { reingestCustom } from "../catalog/providers/custom";
import { onGameChange } from "../library/games";
import { enqueueJob } from "../process/kinds";
import { finalizeHooks } from "../process/runner";
import { adeps } from "./assemble";
import { existsSync } from "node:fs";
import { gameTarget, ingestFile, ingestTree, ofText, sizeWords } from "./content";
import { copyFacts, copyVerdict, judgeCopy, listedSums, recordCopyHashes, takeCopy, type CopyEntry } from "./copy";
import { fileTag, judgeFile, prepareContentPass } from "./find";
import { hashInPlace } from "./hash";
import { checksFiles, type FileFacts } from "./match";
import { PLATFORM_LABEL, platformId, type PlatformId } from "../platforms";
import { automaticProblem } from "./emulator-scope";
import { ensureWay, type Ensured } from "./recipes";
import { assembling, contentHashes, contentRawHashes, getContent, getPlan, settleWay, updateWay, wayContent, waysOfGame, type ContentRow, type PlanRow, type WayRow } from "./store";
import type { PlanKind } from "./types";

const log = logger("ways");

/** swapped in tests */
export const hkdeps = { ensureWay: (game: GameRow, platform: PlatformId): Promise<Ensured> => ensureWay(game, platform) };

/** the best way to play first, as the catalog ranks routes: a recomp, then a port, then an emulator */
const KIND_RANK: Record<PlanKind, number> = { recomp: 0, port: 1, emulator: 2 };

const factsOf = (e: CopyEntry): FileFacts => ({ platform: e.platform, name: e.name, size: e.size, hashes: e.hashes, rawHashes: e.rawHashes, identity: e.identity, shape: e.shape });

/**
 * An imported console dump (from the indexers, as often as not) for a game with ready ways. Only a way that checks its game
 * file (by hash, or by the serial or game code its bytes carry) may take it, and only when the way's own checks prove it
 * — the ones its search makes (a dump list that knows the bytes as a beta refuses it, serial or not; so does a tag in the
 * dump's name, another disc, or bytes that are no disc of the console): the dump becomes the file of each such way, with
 * the dump's own console, and ONE build is queued, for the best of them — none when the game already has a built way. A
 * way that checks nothing (an emulator's without serials) is never handed a dump nobody checked: the admin gives it a
 * file, or builds it from the game page, which takes the console copy then.
 */
export const romHandOff = async ({ gameId, pkg, manifest, log: jobLog, progress }: Parameters<typeof finalizeHooks.romImported>[0] & { progress?: (p: number, message: string) => void }): Promise<void> => {
  // a dump of a console the game has no way for yet: that console's emulator gets it one, by itself (src/ways/recipes.ts);
  // its carry run then takes this copy as its game file
  const dumpOf = platformId(manifest.platform ?? null);
  // Read the imported title ID and version before choosing an experimental build.
  const facts = await judgeCopy(gameId);
  const owner = stmts.gameById.get(gameId) as GameRow | undefined;
  if (dumpOf && owner) {
    try {
      const made = await hkdeps.ensureWay(owner, dumpOf);
      if (made.state === "there" && made.made) jobLog(`the game got a way to play its ${PLATFORM_LABEL[dumpOf]} version: it is carried through from here`);
      else if (made.state === "waiting") jobLog(`${made.emulator} is being set up for ${PLATFORM_LABEL[dumpOf]} games: the game's way follows`);
      else if (made.state === "none") jobLog(`no way to play was made by itself: ${made.why}`);
    } catch (e: any) { jobLog(`no way to play was made by itself: ${e?.message ?? e}`); }
  }
  const open = waysOfGame(gameId).flatMap(w => {
    const p = getPlan(w.plan_id), c = p ? wayContent(w, p) : null;
    return p && c && p.status === "ready" && !automaticProblem(p, w) && w.content_id == null && !assembling(w.id) ? [{ w, p, c }] : [];
  });
  // a way that checks no hashes takes nothing, but the console copy stands in for its missing file now: it settles (ready
  // when that was all it lacked), so its status says what its Build button does
  for (const { w, p } of open.filter(x => !checksFiles(x.c))) {
    settleWay(w.id);
    jobLog(`${p.name} checks no hashes, so the dump is not built into it by itself: build it from the game page to use the console copy`);
  }
  const checked = open.filter(x => checksFiles(x.c));
  const dump = facts?.entries[0];
  if (!checked.length || !dump) return;
  if (dump.why) { jobLog(`the console copy is ${dump.why}: it is handed to no way`); return; }
  const game = stmts.gameById.get(gameId) as GameRow | undefined;
  if (!game) return;
  const release = manifest.source?.title ?? null;
  // first what can be told without reading the dump through: another form, sealed, another console, game or tag
  const candidates: { w: WayRow; p: PlanRow; pass: NonNullable<Awaited<ReturnType<typeof prepareContentPass>>> }[] = [];
  for (const { w, p, c } of checked) {
    const pass = await prepareContentPass(w, game, jobLog);
    if (!pass) continue;
    const v = copyVerdict(gameId, c);
    if (v.entry && v.entry.rel !== dump.rel) { jobLog(`nothing proves the dump is the game file of ${p.name}: another file of the copy may be it (${v.entry.name}) — it is not built into it by itself`); continue; }
    if (v.serves === "no") { jobLog(`the dump is no game file for ${p.name}: ${v.why}`); settleWay(w.id); continue; }
    if (v.serves === "make") { jobLog(`${p.name} makes its game file from the dump: build it from the game page, or let its carry run make it`); settleWay(w.id); continue; }
    // a way without hashes refuses a tagged name before the dump is read through; an accepted hash beats a name's tag
    const tag = c.accept.hashes.length ? null : fileTag(dump.name, pass, dump.identity, release);
    if (tag) { jobLog(`the dump is no game file for ${p.name}: ${tag}`); settleWay(w.id); continue; }
    candidates.push({ w, p, pass });
  }
  if (!candidates.length) return;
  // the rest need its hashes: a kept file of these very bytes says them (content row 1), else the dump is read where it
  // lies, once (or not at all when a read since its last change told them)
  let kept: ContentRow | null = dump.contentId != null ? getContent(dump.contentId) : null;
  if (kept && !existsSync(kept.path)) kept = null;
  let full: FileFacts = factsOf(dump);
  // bytes of the whole as the dump is read or linked in: through the job's progress when it passes one, and a line in the
  // job's log every 30 seconds either way
  let said = Date.now();
  const tell = (step: string) => (b: number, total: number) => {
    progress?.(Math.min(0.99, b / Math.max(1, total)), `${step} · ${ofText(b, total)}`);
    if (Date.now() - said >= 30_000) { said = Date.now(); jobLog(`${step} · ${ofText(b, total)}`); }
  };
  if (kept) full = { ...full, hashes: contentHashes(kept), rawHashes: contentRawHashes(kept) };
  // a folder dump is named by its listing, from the package's own list of its files: nothing to read
  else if (dump.shape === "file" && !(dump.hashed && dump.hashes.sha1)) {
    jobLog(`reading the dump where it lies (${sizeWords(dump.size)}) for ${candidates.map(x => x.p.name).join(", ")}`);
    try {
      const h = await hashInPlace(dump.path, { n64: true, progress: tell("reading the dump where it lies") });
      recordCopyHashes(gameId, dump.rel, { hashes: h.result.hashes, rawHashes: h.result.rawHashes ?? null, stat: h.stat });
      full = { ...full, hashes: h.result.hashes, rawHashes: h.result.rawHashes ?? null };
    } catch (e: any) { jobLog(`the dump could not be read: ${e?.message ?? e}`); return; }
  }
  const fits: { w: WayRow; p: PlanRow }[] = [];
  for (const { w, p, pass } of candidates) {
    // judged as the way's own search judges a file
    const j = judgeFile(pass, dump.name, full, release);
    if (j.verdict === "refused") { jobLog(`the dump is no game file for ${p.name}: ${j.why}`); settleWay(w.id); continue; }
    if (j.verdict !== "proven") { jobLog(`nothing proves the dump is the game file of ${p.name}: ${j.why} — it is not built into it by itself`); continue; }
    fits.push({ w, p });
  }
  if (!fits.length) return;
  // linked into the store once, for the ways it proves (the dump stays the game's copy; nothing is copied or read again);
  // a kept file of the same bytes is that file already
  let row = kept;
  if (!row && dump.shape === "folder") {
    // a tree of links, named by the package's own list (a file it does not list is read once)
    row = (await ingestTree(dump.path, gameTarget(gameId), {
      mode: "link", hash: true, source: "package", known: listedSums(pkg.manifest_json, dump.rel), identity: dump.identity, platform: manifest.platform ?? dump.platform,
      progress: (b, total, s) => tell(s === "linking" ? "linking the dump into the store" : s === "copying" ? "copying the dump into the store" : s === "protecting" ? "protecting the dump from changes" : "reading the dump where it lies")(b, total),
      looking: (n, b) => progress?.(0.01, `looking through the dump · ${n.toLocaleString("en-US")} files (${sizeWords(b)}) so far`),
    })).row;
    recordCopyHashes(gameId, dump.rel, { hashes: full.hashes, rawHashes: null, stat: null, contentId: row.id });
  } else if (!row) {
    const fresh = copyFacts(gameId)?.entries.find(e => e.rel === dump.rel) ?? dump;
    row = (await ingestFile(dump.path, gameTarget(gameId), {
      name: dump.name, source: "package", platform: manifest.platform ?? dump.platform, mode: "link", identity: dump.identity,
      known: fresh.hashed && fresh.hashes.sha1 ? { hashes: fresh.hashes, rawHashes: fresh.rawHashes, stat: fresh.hashed } : null,
      // a store that cannot link the dump (another volume, a share without hard links) copies it: said as it goes
      progress: (b, total, s) => tell(s === "copying" ? "copying the dump into the store" : "reading the dump where it lies")(b, total),
    })).row;
    recordCopyHashes(gameId, dump.rel, { hashes: full.hashes, rawHashes: full.rawHashes ?? null, stat: fresh.hashed ?? null, contentId: row.id });
  }
  const ready: { w: WayRow; p: PlanRow }[] = [];
  for (const { w, p } of fits) {
    updateWay(w.id, { contentId: row.id });
    const settled = settleWay(w.id);
    if (settled?.status === "ready") ready.push({ w: settled, p });
  }
  if (!ready.length) return;
  const built = waysOfGame(gameId).find(w => w.status === "built" && w.package_id != null && stmts.packageById.get(w.package_id));
  if (built) { jobLog(`the dump is the game file of ${ready.map(f => f.p.name).join(", ")} now; the game already has a built way to play, so nothing is built`); return; }
  const best = [...ready].sort((a, b) => KIND_RANK[a.p.kind] - KIND_RANK[b.p.kind] || a.w.id - b.w.id)[0];
  if (assembling(best.w.id)) return;
  enqueueJob({ kind: "assemble", wayId: best.w.id, auto: true }, { gameId });
  jobLog(`the dump became the game file of ${best.p.name}: building it`);
};

/**
 * A way with no game file, for a game whose copy is its file: taken by src/ways/copy.ts takeCopy (the kept row of the same
 * bytes, or a hard link into the store hashed where it lies, with progress and the build's cancel). A copy that is not the
 * way's file is refused with its own words (NeedsFiles), before anything is read; null when the game has no copy.
 */
export const contentFromConsoleCopy: typeof adeps.contentFromPackage = async ({ way, game, pkg, log: jobLog, content, progress, signal }) => {
  if (!pkg) return null;
  let v = copyVerdict(game.id, content);
  if (v.serves === "unknown") { await judgeCopy(game.id); v = copyVerdict(game.id, content); }
  if (!v.facts || !v.entry) return null;
  jobLog(`the game's copy: ${v.entry.name} is ${v.why}`);
  // the step it is on ("hashing the game's copy", "copying the game's copy") rides along for assemble's message
  const report = progress as ((bytes: number, total: number, step?: string) => void) | undefined;
  return takeCopy({ game, way, content, log: jobLog, signal, progress: report ? (b, total, step) => report(b, total, step) : undefined });
};

finalizeHooks.romImported = romHandOff;
adeps.contentFromPackage = contentFromConsoleCopy;

const reingest = (why: string) => { try { reingestCustom(); } catch (e: any) { log.warn(`ways to play were not refreshed in the catalog after ${why}: ${e?.message ?? e}`); } };
onGameChange(() => reingest("a game changed"));
events.subscribe(e => {
  // every path that removes a package (DELETE /package, a rescan, a replace) settles its ways first, then says so here
  if (e.event === "package") { if ((e.data as { deleted?: boolean } | null)?.deleted) reingest("a package was removed"); return; }
  if (e.event !== "job") return;
  const d = e.data as { kind?: string; state?: string } | null;
  if (!d || (d.state !== "done" && d.state !== "failed")) return;
  if (d.kind === "assemble") reingest("a build ended");
  else if (d.kind === "import") reingest("an import ended");
});
