/**
 * ludarr — the retail dump lists: No-Intro's for cartridges, Redump's for discs, as libretro-database publishes them
 * (github.com/libretro/libretro-database, metadat/no-intro and metadat/redump; CC BY-SA 4.0, imported from No-Intro and
 * Redump in bulk every few months). A way to play's content pass (src/ways/find.ts) uses them on a file it downloaded:
 * the file is proven to be the game when its SHA-1 is a dump the list names under a name that is certainly this game (the
 * searcher's own rules, src/releases.ts) and whose every tag is one a retail dump carries (a region, languages, a revision,
 * the first disc, a budget re-release: src/ways/names.ts); it is refused when the list gives that SHA-1 to another game, to
 * a demo, a beta, a bonus disc, a sampler (any tag that says it was not sold as the game) or to another disc of the game.
 * An entry of the game under any other tag ("(LodgeNet)", "(Zelda Collection)") proves nothing and refuses nothing. The
 * words a way's description asks for (a prototype it wants) never make the list prove anything: they only keep it from
 * refusing that tag. A disc's retail entries also give its serials (SLUS-21678, DL-DOL-GZLE-USA), which a way of that console
 * takes in as the serials it accepts when the admin looks for its file.
 *
 * This is no catalog source (it adds no titles): each list is kept as <config>/ways/dats/<platform>.dat, fetched in the
 * background when a pass finds it missing or two weeks old (a search never waits for it; a content job does), and a
 * failed fetch keeps the old copy and is not tried again for an hour; with no copy there is simply no list to check
 * against. The lists are read on this server only, never handed on.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../../config";
import { publicFetch, readCapped } from "../../net/public-url";
import { PLATFORM_LABEL, type PlatformId } from "../../platforms";
import type { Release } from "../../plugins/types";
import { certainlyThisGame, nameQueries, notAsSold, rankForNames, tokens, type GameQuery } from "../../releases";
import { discNumber, retailTags } from "../../ways/names";
import type { Hashes } from "../../ways/types";

const BASE = "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/";
/** the list for each console the content store can hold a game file of (single files: a cartridge, a one-file disc image) */
export const DAT_FILES: Partial<Record<PlatformId, string>> = {
  n64: "no-intro/Nintendo - Nintendo 64.dat", snes: "no-intro/Nintendo - Super Nintendo Entertainment System.dat",
  nes: "no-intro/Nintendo - Nintendo Entertainment System.dat", gb: "no-intro/Nintendo - Game Boy.dat", gbc: "no-intro/Nintendo - Game Boy Color.dat",
  gba: "no-intro/Nintendo - Game Boy Advance.dat", nds: "no-intro/Nintendo - Nintendo DS.dat", genesis: "no-intro/Sega - Mega Drive - Genesis.dat",
  gc: "redump/Nintendo - GameCube.dat", wii: "redump/Nintendo - Wii.dat", ps1: "redump/Sony - PlayStation.dat", ps2: "redump/Sony - PlayStation 2.dat",
  psp: "redump/Sony - PlayStation Portable.dat",
};
export const datUrl = (file: string) => BASE + file.split("/").map(encodeURIComponent).join("/");
const MAX_BYTES = 64 * 2 ** 20;
const MAX_AGE_MS = 14 * 86_400_000;
const RETRY_MS = 3_600_000;

/** swapped in tests */
export const datdeps = {
  fetchText: async (url: string): Promise<string> => {
    // a minute at most: a content job waits for it (a few MB from GitHub's file host takes seconds; a search never waits)
    const res = await publicFetch(url, { headers: { "User-Agent": "ludarr", Accept: "text/plain" }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* nothing to drain */ } throw new Error(`HTTP ${res.status}`); }
    return new TextDecoder().decode(await readCapped(res, MAX_BYTES));
  },
  now: () => Date.now(),
  dir: () => join(configDir(), "ways", "dats"),
};

export interface DatRom { name: string; size: number | null; crc: string | null; md5: string | null; sha1: string | null; serial: string | null }
export interface DatEntry { name: string; region: string | null; serial: string | null; roms: DatRom[] }
export interface Dat { platform: PlatformId; version: string | null; entries: DatEntry[]; bySha1: Map<string, DatEntry[]> }

/* ─────────── reading a list ─────────── */

type Tok = "(" | ")" | { v: string };
function* lex(text: string): Generator<Tok> {
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text.charCodeAt(i);
    if (c <= 32) { i++; continue; }
    if (c === 40) { yield "("; i++; continue; }
    if (c === 41) { yield ")"; i++; continue; }
    if (c === 34) {
      let j = i + 1, s = "";
      while (j < n && text.charCodeAt(j) !== 34) { if (text.charCodeAt(j) === 92 && j + 1 < n) { s += text[j + 1]; j += 2; continue; } s += text[j++]; }
      yield { v: s }; i = j + 1; continue;
    }
    let j = i;
    while (j < n && text.charCodeAt(j) > 32 && text.charCodeAt(j) !== 40 && text.charCodeAt(j) !== 41) j++;
    yield { v: text.slice(i, j) }; i = j;
  }
}

type Block = Map<string, (string | Block)[]>;
function block(t: Iterator<Tok>): Block {
  const out: Block = new Map();
  for (;;) {
    const k = t.next();
    if (k.done || k.value === ")") return out;
    if (k.value === "(") { block(t); continue; }                              // a block with no key: skipped
    const v = t.next();
    if (v.done || v.value === ")") return out;
    const value = v.value === "(" ? block(t) : v.value.v;
    const list = out.get(k.value.v) ?? [];
    list.push(value); out.set(k.value.v, list);
  }
}
const one = (b: Block, k: string): string | null => { const v = b.get(k)?.[0]; return typeof v === "string" ? v : null; };

/** a clrmamepro-format list: the header's version, and each game ( … ) block's name, region, serial and roms */
export function parseDat(text: string): { version: string | null; entries: DatEntry[] } {
  const t = lex(text);
  let version: string | null = null;
  const entries: DatEntry[] = [];
  for (;;) {
    const k = t.next();
    if (k.done) break;
    if (k.value === "(" || k.value === ")") continue;
    const open = t.next();
    if (open.done || open.value !== "(") continue;
    const b = block(t);
    if (k.value.v === "clrmamepro") version = one(b, "version");
    else if (k.value.v === "game") {
      const name = one(b, "name");
      if (!name) continue;
      const roms = (b.get("rom") ?? []).filter((r): r is Block => typeof r !== "string").map(r => ({
        name: one(r, "name") ?? "", size: Number(one(r, "size")) || null, crc: one(r, "crc")?.toLowerCase() ?? null,
        md5: one(r, "md5")?.toLowerCase() ?? null, sha1: one(r, "sha1")?.toLowerCase() ?? null, serial: one(r, "serial"),
      }));
      entries.push({ name, region: one(b, "region"), serial: one(b, "serial"), roms });
    }
  }
  return { version, entries };
}

function index(platform: PlatformId, parsed: { version: string | null; entries: DatEntry[] }): Dat {
  const bySha1 = new Map<string, DatEntry[]>();
  for (const e of parsed.entries) for (const r of e.roms) if (r.sha1) { const l = bySha1.get(r.sha1) ?? []; if (!l.includes(e)) l.push(e); bySha1.set(r.sha1, l); }
  return { platform, version: parsed.version, entries: parsed.entries, bySha1 };
}

/* ─────────── keeping the lists ─────────── */

const loaded = new Map<PlatformId, { mtime: number; dat: Dat }>();
const failedAt = new Map<PlatformId, number>();
/** a fetch in flight per console: a second pass waits for it (or not) instead of starting another */
const fetching = new Map<PlatformId, Promise<void>>();
const fileOf = (platform: PlatformId) => join(datdeps.dir(), `${platform}.dat`);

/** the lists read into memory, the fetches that failed and the ones in flight, forgotten (a test starts afresh) */
export function forgetDats() { loaded.clear(); failedAt.clear(); fetching.clear(); }

/** is a list for this console kept on the server (it may be old; loadDat refreshes it) */
export const datKept = (platform: string): boolean => !!DAT_FILES[platform as PlatformId] && existsSync(fileOf(platform as PlatformId));

/** one fetch of the console's list into its kept copy (a failure is noted, and the old copy stays) */
function refresh(platform: PlatformId, file: string, had: boolean, log: (line: string) => void): Promise<void> {
  const inflight = fetching.get(platform);
  if (inflight) return inflight;
  const path = fileOf(platform);
  const box: { run?: Promise<void> } = {};
  box.run = (async () => {
    await null;                                                              // never in the caller's turn: box.run is set first
    try {
      const text = await datdeps.fetchText(datUrl(file));
      if (!/^\s*clrmamepro\s*\(/.test(text)) throw new Error("the answer is not a dump list");
      await mkdir(datdeps.dir(), { recursive: true });
      const tmp = `${path}.${process.pid}.${datdeps.now()}`;
      await writeFile(tmp, text);
      await rename(tmp, path);
      failedAt.delete(platform);
      log(`fetched the ${PLATFORM_LABEL[platform]} dump list (${Math.round(text.length / 1024)} KB)`);
    } catch (e: any) {
      failedAt.set(platform, datdeps.now());
      log(`the ${PLATFORM_LABEL[platform]} dump list could not be fetched (${e?.message ?? e})${had ? ": the copy kept on the server is used" : ""}`);
    } finally { if (fetching.get(platform) === box.run) fetching.delete(platform); }        // a fetch forgotten meanwhile clears no newer one
  })();
  fetching.set(platform, box.run);
  return box.run;
}

/**
 * The console's dump list: the copy kept on the server, or null when there is none. A copy that is missing or two weeks
 * old is fetched again (not within an hour of a failed fetch); `wait: false` (a search: the searcher never waits on
 * GitHub) leaves that fetch running in the background and answers with what is kept now, while a job waits for it.
 */
export async function loadDat(platform: PlatformId, log: (line: string) => void = () => {}, opts: { wait?: boolean } = {}): Promise<Dat | null> {
  const file = DAT_FILES[platform];
  if (!file) return null;
  const path = fileOf(platform);
  let st = await stat(path).catch(() => null);
  const stale = !st || datdeps.now() - st.mtimeMs > MAX_AGE_MS;
  if (stale && (fetching.has(platform) || datdeps.now() - (failedAt.get(platform) ?? 0) > RETRY_MS)) {
    const run = refresh(platform, file, !!st, log);
    if (opts.wait === false) return st ? read(platform, path, st.mtimeMs) : null;
    await run;
    st = await stat(path).catch(() => null);
  }
  return st ? read(platform, path, st.mtimeMs) : null;
}
async function read(platform: PlatformId, path: string, mtime: number): Promise<Dat | null> {
  const hit = loaded.get(platform);
  if (hit && hit.mtime === mtime) return hit.dat;
  const text = await readFile(path, "utf8").catch(() => null);
  if (text == null) return null;
  const dat = index(platform, parseDat(text));
  loaded.set(platform, { mtime, dat });
  return dat;
}

/* ─────────── judging entries ─────────── */

/** a list entry as a release title, so the searcher's own rules judge its name */
const asRelease = (e: DatEntry): Release => ({
  guid: e.name, title: e.name, instanceId: 0, indexerId: 0, indexer: "dump list", size: e.roms[0]?.size ?? 0, age: 0, publishDate: "", seeders: null, leechers: null,
  grabs: null, files: null, downloadUrl: null, magnetUrl: null, infoUrl: null, infoHash: null, protocol: "usenet", categories: [], indexerFlags: [], fileName: null,
});

/**
 * What one entry is for a game (by any of its names): the game as it was sold ("game": certainly its name, every tag one a
 * retail dump carries, the first disc); another disc of it ("disc"); the game in an edition the list's tags cannot vouch
 * for, or under a tag the way asked for ("unknown": it proves nothing and refuses nothing); another game, or the game under
 * a tag that says it was not sold as it ("other": a demo, a beta, a bonus disc …). `asked` never makes an entry the game.
 */
type Judged = { kind: "game" | "disc" | "unknown" | "other"; why: string };
function judge(e: DatEntry, qs: GameQuery[], platform: PlatformId, asked: string[]): Judged {
  const [v] = rankForNames(qs, [asRelease(e)], { platforms: [platform], known: [platform], unnamed: true });
  if (!v || !certainlyThisGame({ ...v, flags: { ...v.flags, wrongKind: null } })) return { kind: "other", why: "another game" };
  if (v.flags.wrongKind) {
    // a tag the way's own description asks for (a prototype it wants) is no refusal, and no proof either
    const name = v.matchedName ?? "";
    const softened = asked.length > 0 && !!notAsSold(e.name, name) && !notAsSold(e.name, name, asked);
    return { kind: softened ? "unknown" : "other", why: v.flags.wrongKind };
  }
  const disc = discNumber(e.name);
  if (disc != null && disc > 1) return { kind: "disc", why: `disc ${disc} of the game` };
  return retailTags(e.name) ? { kind: "game", why: "" } : { kind: "unknown", why: "an edition the list's tags do not say was sold as the game" };
}
const queriesFor = (names: string[]) => nameQueries(names[0] ?? "", null, names.slice(1));

/** the entries that are certainly this game as it was sold, its first disc (its names: the way's names for the original game) */
export function gameEntries(dat: Dat, names: string[]): DatEntry[] {
  if (!names.length) return [];
  const qs = queriesFor(names), cores = qs.map(q => q.core).filter(c => c.length);
  return dat.entries.filter(e => { const t = new Set(tokens(e.name)); return cores.some(c => c.every(x => t.has(x))); })
    .filter(e => judge(e, qs, dat.platform, []).kind === "game");
}

/** what the list says a file is: this game as it was sold ("game", the entry); another game, a demo, a beta, a bonus disc
 *  of it, or another of its discs than `disc` (the one the way asked for) ("other", with why); the game in an edition the
 *  list cannot vouch for, or under a tag the way asked for ("unknown"); or nothing (its SHA-1 is in no entry) */
export interface DatVerdict { kind: "game" | "other" | "unknown" | "none"; entry: DatEntry | null; why: string | null }
export function datVerdict(dat: Dat, hashes: Hashes, rawHashes: Hashes | null | undefined, names: string[], asked: string[] = [], opts: { disc?: number | null } = {}): DatVerdict {
  const hits: DatEntry[] = [];
  for (const h of [hashes.sha1, rawHashes?.sha1]) for (const e of (h ? dat.bySha1.get(h.toLowerCase()) : null) ?? []) if (!hits.includes(e)) hits.push(e);
  if (!hits.length) return { kind: "none", entry: null, why: null };
  const qs = queriesFor(names);
  const judged = hits.map(e => ({ e, j: judge(e, qs, dat.platform, asked) }));
  const game = judged.find(x => x.j.kind === "game");
  if (game) return { kind: "game", entry: game.e, why: null };
  // the same bytes under several entries: one that says they are not the game decides
  const other = judged.find(x => x.j.kind === "other") ?? judged.find(x => x.j.kind === "disc" && discNumber(x.e.name) !== opts.disc);
  if (other) return { kind: "other", entry: other.e, why: `the dump list names it ${other.e.name}${other.j.why === "another game" ? ": another game" : ` (${other.j.why})`}` };
  const [first] = judged;
  return { kind: "unknown", entry: first.e, why: `the dump list names it ${first.e.name} (${first.j.why})` };
}

/** the serials a console's entries give, in the form its discs carry them (SLUS-21678; DL-DOL-GZLE-USA), each once */
export function entrySerials(entries: DatEntry[], platform: PlatformId): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (s.length <= 32 && /^[A-Za-z0-9_.-]+$/.test(s) && !out.includes(s)) out.push(s); };
  for (const e of entries) for (const raw of [e.serial, ...e.roms.map(r => r.serial)]) {
    if (!raw) continue;
    if (platform === "ps1" || platform === "ps2" || platform === "psp") for (const m of raw.toUpperCase().matchAll(/([A-Z]{4})[-_ ]?(\d{5})/g)) add(`${m[1]}-${m[2]}`);
    else for (const part of raw.split(/[\s,/]+/)) add(part.toUpperCase());
  }
  return out;
}
