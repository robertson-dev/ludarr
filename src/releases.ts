/**
 * ludarr — release reconciliation: a game name in, a ranked list of grabbable releases out.
 *
 *   buildQuery(name)         → the strings we send Prowlarr + the tokens a hit MUST contain
 *   queryPlan(name, …)       → every string a search asks, in order: the name, its aliases, the admin's search terms
 *   parseTitle(title)        → group / repack / scene / version / edition / junk flags
 *   rankReleases(q, rows)    → match → score → sort → dedupe (same torrent on 3 trackers = 1 row)
 *   rankForNames(qs, rows)   → the same, each release judged under every name the game goes by
 *   certainlyThisGame(view)  → may the automatic matcher take it (the strictest test, applied per name)
 *   nameRefusals(view)       → every reason its title stands in the way, in plain words (src/requests.ts adds the ones
 *                              that need the whole search: the other copies, the game's dates, CrackWatch)
 *
 * Pure functions, no I/O — everything here is unit-testable.
 */
import type { ProwlarrRelease } from "./prowlarr";
import { PLATFORM_LABEL, platformId, platformOfCategory, type PlatformId } from "./platforms";

export interface GameQuery { name: string; year: number | null; queries: string[]; core: string[]; optional: string[] }
export interface ParsedTitle {
  group: string | null; repack: boolean; scene: boolean;
  version: string | null; edition: string | null; languages: number | null; dlc: boolean; junk: string[];
  year: number | null;          // "(2020)" — GazelleGames and friends put the release year in the title
  platform: string | null;      // GazelleGames "[Windows / Multi-Language / Full ISO]" → "Windows"
  format: string | null;        //                                                      → "Full ISO"
}
export interface MatchInfo { ok: boolean; core: number; optional: number }
/** what the scorer saw — the automatic matcher refuses anything flagged here; humans just see the reasons */
export interface MatchFlags {
  sequel: boolean; extraWords: boolean; buried: boolean; yearOff: number | null;
  /** every word of the name is there, but not in the name's order: "Call of Duty 4 Modern Warfare" for "Call of Duty: Modern
   *  Warfare 4" is another game */
  reordered?: boolean;
  /** the name is there, but read wrongly — why, in words: its number only inside a version, a size or a count ("WARHAMMER II
   *  v1.3.0" for WARHAMMER III), or words between the name and the number it ends with ("Resident Evil Revelations 2") */
  misread?: string | null;
  /** not the game at all: another platform's build, a mod, one file of a usenet post — why, or null */
  wrongKind?: string | null;
  /** the platform the release names (trailer, scene tag or category); null when it names none (a PC release, usually) */
  platform?: PlatformId | null;
}
export interface ReleaseView extends ProwlarrRelease {
  parsed: ParsedTitle; match: MatchInfo; score: number; reasons: string[]; flags: MatchFlags; alsoOn: string[];
  /** the name (the game's own, or one of its aliases) this view was judged under: its match, score and flags are that name's */
  matchedName?: string;
}

const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const STOP = new Set(["the", "a", "an", "of", "and", "for", "to", "in", "on", "at", "by", "vs", "with"]);
const EDITION = new Set([
  "edition", "standard", "deluxe", "digital", "ultimate", "gold", "premium", "complete", "definitive",
  "special", "collectors", "goty", "anniversary", "enhanced", "bundle", "legendary",
]);
const PHRASES = /\b(game of the year|director'?s cut)\b/gi;
/** harmless words some trackers put in front of the name: "[PC] Hades", "Game Hades" */
const LEAD_OK = new Set(["pc", "win", "windows", "game", "games", "repack", "fitgirl", "dodi", "elamigos", "gog", "steam", "x64", "multi"]);
/** release noise that may legitimately follow the name without meaning "a different game" */
const TRAIL_OK = new Set([
  "v", "ver", "version", "build", "update", "updated", "repack", "multi", "multilingual", "incl", "dlc", "dlcs", "bonus", "ost", "soundtrack",
  "soundtracks", "plus", "trainer", "patch", "hotfix", "fix", "crack", "proper", "rip", "iso", "windows", "pc", "x64", "x86",
  "win", "gog", "steam", "early", "access", "edition", "deluxe", "ultimate", "complete", "definitive", "goty", "gold", "premium",
  "remastered", "remake", "enhanced", "anniversary", "digital", "collectors", "legendary", "directors", "cut", "game", "year",
  "english", "eng", "rus", "p2p", "scene", "internal", "ggn", "dox", "gamedox", "full", "home", "drm", "free", "humble", "bundle",
  // console dumps carry a region and a platform right after the name: "Demons.Souls.EUR.PS3-BlaZe"
  "usa", "us", "eur", "europe", "pal", "ntsc", "world", "japan", "jpn", "jp", "asia", "korea", "kor", "region", "ps1", "psx", "ps2", "ps3", "ps4", "ps5",
  "psp", "vita", "nsw", "switch", "ns2", "nsw2", "switch2", "wii", "wiiu", "gc", "gamecube", "n64", "snes", "nes", "gba", "gbc", "nds", "3ds", "xbox", "x360", "xbox360", "xone", "xsx", "xbla",
  // retro dumps name their console the same way: "Sonic the Hedgehog (USA, Europe) Genesis", "God.of.War.II.USA.PS2DVD-STRiKE"
  "sfc", "famicom", "ngc", "gcn", "gb", "dc", "dreamcast", "saturn", "genesis", "megadrive", "md", "psone", "n3ds", "ps2dvd", "ps2cd",
  "rom", "dump", "jb", "pkg", "nsp", "xci", "nsz", "chd", "rvz", "wbfs", "disc", "cd", "dvd", "bd", "bluray",
  // a store's re-release of a console game names its store: "Majoras.Mask.REPACK.N64.MULTi4.VC.WiiU-LiNKLE"
  "vc", "virtual", "console", "eshop", "psn", "rev", "revision",
  // "v1.09 All DLCs + Online, Recompiled for PC": a port's own vocabulary
  "all", "online", "offline", "recompiled", "recomp", "recompilation", "port", "ported", "native", "fixed", "multiplayer", "coop", "lan",
  "mod", "mods", "modpack",                      // "Incl. Mods" rides along; a mod by itself is caught by the kind check
]);

/** lowercase word tokens; apostrophes collapse (marvel's → marvels) and roman numerals become digits */
export function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[™®©]/g, "").replace(/['’]/g, "").replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(t => ROMAN[t] ?? t);
}
const natural = (s: string) => s.replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

/** the words a release must carry for a name (what matchTitle counts: the head's and the subtitle's, without articles and
 *  edition words), each once, in the name's own order */
export function nameWords(q: Pick<GameQuery, "name" | "core" | "optional">): string[] {
  const need = new Set([...q.core, ...q.optional]);
  return [...new Set(tokens(q.name).filter(t => need.has(t)))];
}
/** are `words` an in-order subsequence of `tt` (greedy, left to right)? the index just past the last one, or -1 */
export function inOrder(words: string[], tt: string[]): number {
  let at = 0;
  for (const w of words) { const j = tt.indexOf(w, at); if (j < 0) return -1; at = j + 1; }
  return at;
}
/** a name's year ("Lords Of The Fallen™ 2014", "Microsoft Flight Simulator (2020) 40th Anniversary Edition"): it counts where
 *  it stands, a tracker's "(2014)" tag or the middle of a Steam name, so it is looked for but never placed */
const yearWord = (w: string) => /^(19[7-9]\d|20[0-3]\d)$/.test(w);

/* ─────────── the title as the name checks read it: what is no word of the name taken out ─────────── */

/** No-Intro's and Redump's article moved to the end of its part ("Legend of Zelda, The - Majora's Mask", "Schtroumpfs, Les
 *  (France)"), put back in front */
const ARTICLE_END = /(^|\s[-–—]\s|:\s*)([^,()\[\]:]+?),\s*(the|a|an|les|le|la|l'|die|der|das|den|el|los|las|il|lo|gli|de|het|een|ein|eine|o|os|as|un|une|uno)(?=\s*(?:$|[-–—(\[:]))/giu;
/** a size in a title ("[4 GB]", "from 4.4 GB", "350 MB"); a year in front of "GB" is the Game Boy's ("Tetris (1989) GB") */
const SIZE_WORDS = /(^|[^\w.])(?!(?:19|20)\d\d\s?GB\b)\d{1,5}(?:[.,]\d{1,3})?\s?(?:[KMGT]i?B)(?![\p{L}\p{N}])/giu;
/** a number that counts what comes along: what follows a "+" or an "incl"/"with"/"all" and comes before what it counts ("+ 3
 *  DLCs", "Incl. 2 Bonus Items", "all 4 DLC") — "Borderlands 2 + DLC" is the sequel with its DLC */
const COUNT_PHRASE = /(\+|&|(?<![\p{L}\p{N}])(?:incl|including|with|plus|and|all))\.?[\s._-]*\d{1,3}(?=[\s._-]*(?:dlcs?|bonus(?:es)?|osts?|soundtracks?|packs?|add-?ons?|expansions?|updates?|extras?|items?|songs?|tracks?|maps?|skins?|characters?|costumes?|missions?|episodes?)(?![\p{L}\p{N}]))/giu;
/** "3 in 1", "2-in-1": a bundle's count */
const IN_ONE = /(?<![\p{L}\p{N}.])\d{1,2}[\s._-]*in[\s._-]*1(?![\p{L}\p{N}])/giu;
/** a version run, one word: "v1.02", "v.1.0.3" */
const V_VERSION = /\bv\.?\d+(?:\.\d+)+[a-z]?\b/gi;
/** a version written apart from its "v": "v 1.0.28324", "Version 1.0.2", "ver. 1.04" */
const LONE_V = /(?<![\p{L}\p{N}])(v|ver|version)\.?\s+\d+(?:\.\d+)+[a-z]?(?![\p{L}\p{N}])/giu;
/** a bare run of three numbers or more ("Hollow Knight 1.5.78", "Silksong.1.0.28324"), and a run of two that starts with 0 or 1
 *  ("Silksong 1.04"): a version (a run starts after no letter, digit or "<digit>." — never inside another run) */
const BARE_VERSION = /(?<![\p{L}\p{N}])(?<!\d\.)(\d+)(?:\.\d+){2,}[a-z]?(?![\p{L}\p{N}]|\.\d)/giu;
const SMALL_VERSION = /(?<![\p{L}\p{N}])(?<!\d\.)([01])\.\d{1,5}[a-z]?(?![\p{L}\p{N}]|\.\d)/giu;
/** a name that writes a number with a point or a comma ("KINGDOM HEARTS HD 1.5+2.5 ReMIX", "Warhammer 40,000"): its runs are
 *  the name's, so no bare run is read as a version */
const DECIMAL_NAME = /\d[.,]\d/;

/**
 * A title as the name checks read it: an article moved to the end put back in front, and what can never be a word of the
 * name made one word or taken out — a size, the number of a count ("+ 3 DLCs"), a version ("v1.4", "v 1.0.3", and the bare
 * runs above). A bare run in a dotted scene name keeps its first number when that may be a sequel's ("Hades.2.1.0.3" is Hades
 * 2 v1.0.3), and one that starts with the name's own number keeps it ("Frostpunk.2.1.0.3"). `spaced`: the release's own
 * name (its tags aside) is written with spaces.
 */
function shapeText(text: string, gameName: string, spaced: boolean): string {
  const nameTok = new Set(tokens(gameName));
  let s = text.replace(ARTICLE_END, "$1$3 $2").replace(SIZE_WORDS, "$1 ").replace(COUNT_PHRASE, "$1 ").replace(IN_ONE, " ").replace(V_VERSION, " ver ");
  s = s.replace(LONE_V, (m, v: string) => (nameTok.has(v.toLowerCase() === "v" ? "5" : v.toLowerCase()) ? m : " ver "));
  if (DECIMAL_NAME.test(gameName)) return s;
  s = s.replace(BARE_VERSION, (_m, first: string) => (nameTok.has(first) || (!spaced && Number(first) > 1) ? ` ${first} ver ` : " ver "));
  return s.replace(SMALL_VERSION, (_m, first: string) => (nameTok.has(first) ? ` ${first} ver ` : " ver "));
}

/** the three strings one name is searched by: name + year (short names only), the full name, the part before the subtitle */
function queryParts(name: string, year: number | null) {
  const clean = name.replace(/[™®©]/g, "").replace(/\s+/g, " ").trim();
  const noPhrase = clean.replace(PHRASES, " ");
  const head = noPhrase.split(/\s[:\-–—|]\s|:\s|\s\(/)[0] ?? noPhrase;      // "The Witcher 3: Wild Hunt" → "The Witcher 3"
  const strip = (s: string) => natural(s).split(" ")
    .filter(w => !EDITION.has(w.toLowerCase().replace(/['’]/g, ""))).join(" ").trim();
  const qHead = strip(head), qFull = strip(noPhrase);
  // a short name ("INSIDE", "Control", "Prey") drowns in films and shows on a general tracker, and GazelleGames answered a bare
  // "INSIDE" with nothing while "INSIDE 2016" found every copy (2026-11-07): with the year known, ask for name + year first
  const y = year && year > 1970 ? year : null;
  const qYear = y && qFull && tokens(qFull).filter(t => !STOP.has(t)).length <= 2 ? `${qFull} ${y}` : "";
  return { clean, y, qYear, qFull, qHead };
}

export function buildQuery(name: string, year: number | null = null): GameQuery {
  const { clean, y, qYear, qFull, qHead } = queryParts(name, year);
  const headTok = tokens(qHead);
  const core = headTok.filter(t => !STOP.has(t));
  const optional = tokens(qFull).filter(t => !STOP.has(t) && !core.includes(t));
  return {
    name: clean,
    year: y,
    queries: [...new Set([qYear, qFull, qHead].filter(Boolean))],  // a short name with its year, then the exact title, the franchise name only when that is thin
    core: core.length ? core : headTok,
    optional,
  };
}

/** one string a search sends: `name` is the game's own name, `alias` another name it goes by, `term` what the admin typed,
 *  `head` an alias's franchise part (the broadest ask, so it comes last) */
export interface PlannedQuery { text: string; kind: "name" | "alias" | "term" | "head" }

/**
 * Every string a search for a game asks, in order and each once: the name [name + year when short, full, head]; each
 * alias's full name (+ name + year when short); every search term as typed; then the aliases' heads. Search terms only add
 * queries — what they find is still judged against the names alone.
 */
export function queryPlan(name: string, year: number | null, aliases: string[] = [], terms: string[] = []): PlannedQuery[] {
  const out: PlannedQuery[] = [];
  const seen = new Set<string>();
  const add = (text: string, kind: PlannedQuery["kind"]) => {
    const t = text.replace(/\s+/g, " ").trim(), k = t.toLowerCase();
    if (t && !seen.has(k)) { seen.add(k); out.push({ text: t, kind }); }
  };
  for (const t of buildQuery(name, year).queries) add(t, "name");
  const parts = aliases.map(a => queryParts(a, year));
  for (const p of parts) { add(p.qYear, "alias"); add(p.qFull, "alias"); }
  for (const t of terms) add(t, "term");
  for (const p of parts) add(p.qHead, "head");
  return out;
}

/** the queries one game is judged by: its name first, then each alias (same year) */
export function nameQueries(name: string, year: number | null, aliases: string[] = []): GameQuery[] {
  const out = [buildQuery(name, year)];
  for (const a of aliases) {
    const q = buildQuery(a, year);
    if (q.core.length && !out.some(x => x.name.toLowerCase() === q.name.toLowerCase())) out.push(q);
  }
  return out;
}

/** GazelleGames trailer: "(2020) [Windows / Multi-Language / Full ISO] [Update]" */
const GGN_BLOCK = /\[([^\]\/]+?)\s*\/\s*([^\]\/]+?)\s*\/\s*([^\]]+?)\]/;
const PC_PLATFORMS = /^(windows|pc|dos)$/i;

const REPACKERS: [RegExp, string][] = [
  [/fit[\s._-]?girl/i, "FitGirl"], [/\bdodi\b/i, "DODI"], [/el[\s._-]?amigos/i, "ElAmigos"], [/\bkaos\b/i, "KaOs"],
  [/\bmasquerade\b/i, "Masquerade"], [/\bxatab\b/i, "xatab"], [/r\.?g\.?[\s._-]?mechanics/i, "R.G. Mechanics"],
  [/\bdarck\b/i, "Darck"], [/tiny[\s._-]?repacks?/i, "TinyRepacks"], [/\bdecepticon\b/i, "Decepticon"],
  [/\bchovka\b/i, "Chovka"], [/\bseyter\b/i, "Seyter"], [/\bblackbox\b/i, "BlackBox"], [/\bcorepack\b/i, "CorePack"],
  [/\bgnarly\b/i, "Gnarly"], [/\bmr[\s._-]?dj\b/i, "Mr DJ"],
];
/** one of the repackers above (`group` as parseTitle names it): a build made from the files of a store's copy */
export const isRepacker = (group: string | null | undefined): boolean => !!group && REPACKERS.some(([, n]) => n.toLowerCase() === group.toLowerCase());
/** the groups that crack games, the scene's and the P2P crackers', each as it signs a release ("Game-TENOKE", "Game-DARKSiDERS",
 *  "Game-voices38"): a store's rip ("GOG"), an emulator ("Goldberg"), a site ("SteamRIP"), a multiplayer fix ("OnlineFix") or
 *  "P2P" cracks nothing. A release of one on GazelleGames, posted once a game was out, says the game is cracked
 *  (src/requests.ts autoContext) */
const CRACK_GROUPS = [
  "TENOKE", "RUNE", "CODEX", "SKIDROW", "RELOADED", "PLAZA", "FLT", "FAiRLiGHT", "DOGE", "DARKSiDERS", "I_KnoW", "Razor1911", "RZR",
  "EMPRESS", "CPY", "HOODLUM", "PROPHET", "TiNYiSO", "ANOMALY", "SiMPLEX", "Unleashed", "DINOByTES", "CONSPIR4CY", "CHRONOS", "VREX",
  "FCKDRM", "voices38", "ALI213", "3DM",
];
/** the signatures, as each group writes its name or in capitals ("-tenoke" is no group's: a group writes its own name) */
const CRACK_SIGNED = new Set(CRACK_GROUPS.flatMap(g => [g, g.toUpperCase()]));
/** one of the cracking groups above, by the name a release is signed with, written as the group writes it (or in capitals) */
export const isCrackGroup = (group: string | null | undefined): boolean => !!group && CRACK_SIGNED.has(group);
const SCENE = new Set([
  "codex", "plaza", "skidrow", "rune", "tenoke", "razor1911", "rzr", "flt", "empress", "doge", "goldberg", "cpy",
  "hoodlum", "reloaded", "prophet", "darksiders", "dinobytes", "tinyiso", "gog", "ali213", "3dm", "steamrip",
  "onlinefix", "online-fix", "i_know", "anomaly", "chronos", "simplex", "unleashed", "vrex", "p2p", "early-access",
]);
const JUNK: [RegExp, string][] = [
  [/\b(cbr|cbz|epub|mobi|azw3|comics?|graphic novel|manga|novel|audiobook|volume ?\d+|vol\.? ?\d+)\b|\bv0?\d+:/i, "comic / book"],
  [/\btrainer\b/i, "trainer"],
  [/\bcrack[\s._-]*(only|fix)\b|\bcrackfix\b/i, "crack-only"],
  [/\bkeygen\b/i, "keygen"],
  [/\bcheat/i, "cheat"],
  [/\b(soundtrack|ost)\b/i, "soundtrack"],
  [/\bartbook\b/i, "artbook"],
  [/\bsave[\s._-]*games?\b/i, "savegame"],
  [/\bno[\s._-]?(cd|dvd)\b/i, "nocd"],
  [/\bdlcs?[\s._-]*(only|pack)\b/i, "dlc-only"],
];
/** an update by its name: "Update", "Patch" or "Hotfix" anywhere in the release's own name (not in its tags) */
const UPDATE_WORD = /(?<![\p{L}\p{N}])(update|patch|hotfix)(?![\p{L}\p{N}])/giu;
/** what bundles the base game with what follows: "v1.2 + Update 5", "Incl. Update 5", "with Update 3", "plus Soundtrack" ("and"
 *  is not one: "Command.and.Conquer" writes the name's "&") */
const BUNDLE_WORDS = /\+|(?<![\p{L}\p{N}])(incl|including|with|plus)(?![\p{L}\p{N}])/giu;
const bundleCounts = (s: string) => {
  const n = new Map<string, number>();
  for (const m of s.matchAll(BUNDLE_WORDS)) { const k = (m[1] ?? m[0]).toLowerCase(); n.set(k, (n.get(k) ?? 0) + 1); }
  return n;
};
/** does `before` bundle something with the game: a bundle word the game's own name does not account for ("with" in "Getting
 *  Over It with Bennett Foddy", the "+" of "KINGDOM HEARTS HD 1.5+2.5 ReMIX" bundle nothing) */
function bundledBefore(before: string, gameName: string): boolean {
  const name = bundleCounts(gameName);
  for (const [k, n] of bundleCounts(before)) if (n > (name.get(k) ?? 0)) return true;
  return false;
}
/** an update tag anywhere, the tags too: "[Update 5]", "Patch v1.02", "Update Only" */
const UPDATE_TAG = /\b(update|patch|hotfix)[\s._-]*(?:only|v?\d)/gi;
/** the words of a release's own name that follow the game's name (null: the name's words are not there in order) */
function afterName(own: string, gameName: string): string[] | null {
  const name = tokens(gameName).filter(t => !STOP.has(t));
  if (!name.length) return null;
  const tt = tokens(own), k = inOrder(name, tt);
  return k < 0 ? null : tt.slice(k).filter(t => !STOP.has(t));
}
/**
 * Is this release an update rather than the game? An update word in its own name that is not a word of the game's
 * ("Patch Quest" is a game), unless something is bundled before it ("Mouthwashing Update v20241014 incl DLC" is an update;
 * "ELDEN RING v1.16 + Update 1.16" the game with it); or an update word followed by a number or "only" anywhere, tags
 * included, with nothing bundled before it ("ELDEN RING [Update 1.16 incl. DLC]"). RA3's "v1.012.Update-SKIDROW" was
 * imported as the game, 2026-11-09. A repack installs the game with its updates ("v1.2 Update 3 [FitGirl Repack]"): one is an
 * update only when the update word comes right after the name ("ELDEN RING Update 1.16 Repack by Xatab").
 */
function updateOnly(t: string, repack: boolean, name: Set<string>, gameName: string): boolean {
  const own = t.replace(/[\[(][^\])]*[\])]/g, " ");
  if (repack) { const next = afterName(own, gameName)?.[0]; return !!next && /^(update|patch|hotfix)$/.test(next); }
  for (const m of own.matchAll(UPDATE_WORD)) {
    if (name.has(m[1].toLowerCase())) continue;
    return !bundledBefore(own.slice(0, m.index), gameName);
  }
  const tw = t.replace(/[._]/g, " ");
  for (const m of tw.matchAll(UPDATE_TAG)) if (!name.has(m[1].toLowerCase()) && !bundledBefore(tw.slice(0, m.index), gameName)) return true;
  return false;
}
/** a crack or a fix by itself, its word in the release's own name with nothing bundled before it ("ELDEN.RING.Crack-3DM",
 *  "ELDEN RING CPY Crack", "Hades.Fix-CODEX"); "Incl. Crack" rides along */
const CRACK_WORD = /(?<![\p{L}\p{N}])(crack|fix)(?![\p{L}\p{N}])/giu;
/** FLiNG makes trainers only ("ELDEN.RING.Plus.24-FLiNG") */
const TRAINER_GROUP = /^fling$/i;

/**
 * The year a release's own name carries without brackets, right after the game's name: "Prey.2006-GRP", "Prey 2006 GOG",
 * "Need.for.Speed.Most.Wanted.2005.MULTi5-PROPHET" — how a namesake from another year is told apart, and it was read as no
 * year at all (review, 2026-11-10: the 2006 Prey was certainly the 2017 one). A year that is a word of the game's name
 * ("Lords Of The Fallen 2014") is the name's; a version or a date ("2024.11.05", "2024.05") is none. Null without a name
 * to read it after.
 */
function bareYear(title: string, gameName: string): number | null {
  if (!gameName) return null;
  const own = title.replace(/[\[(][^\])]*[\])]/g, " ");
  const next = afterName(shapeText(own, gameName, /\s/.test(own.trim())), gameName);
  if (!next?.length || !yearWord(next[0])) return null;
  if (new RegExp(`(?<![0-9])${next[0]}[ ._-][0-9]{1,2}(?![0-9])`).test(own)) return null;        // a date or a version's first number
  return Number(next[0]);
}

/** `gameName`: the name this release is judged under — its own words never mark the release (an update word in "Patch
 *  Quest"); without it every such word counts */
export function parseTitle(title: string, gameName = ""): ParsedTitle {
  const t = title.trim();
  let group: string | null = null, repack = false, scene = false;
  for (const [re, name] of REPACKERS) if (re.test(t)) { group = name; repack = true; break; }
  if (!group) {
    // scene-style suffix: Game.Name.v1.2-GROUP  (drop trailing [tags] / (size) first)
    const bare = t.replace(/(\s*[\[(][^\])]*[\])])+\s*$/, "").trim();
    const m = /-([A-Za-z0-9_]{2,14})$/.exec(bare);
    if (m) { group = m[1]; scene = SCENE.has(m[1].toLowerCase()) || /^[A-Z0-9_]+$/.test(m[1]); }
  }
  if (!group) {
    const hit = tokens(t).find(x => SCENE.has(x));
    if (hit) { group = hit.toUpperCase(); scene = true; }
  }
  if (!repack && !scene && /\brepack\b/i.test(t)) repack = true;          // "Game Repack by Someone"
  const build = /\bbuild[\s._]?(\d{3,})\b/i.exec(t)?.[1];
  const version = /\bv\.?(\d+(?:\.\d+)+[a-z0-9]*)\b/i.exec(t)?.[1] ?? (build ? `build ${build}` : null);
  const edition = /\b(digital deluxe|deluxe|ultimate|gold|premium|complete|definitive|goty|game of the year|anniversary|legendary|collector'?s|enhanced|director'?s cut|remastered)(?:[\s._-]*edition)?\b/i.exec(t)?.[1] ?? null;
  const languages = Number(/\bmulti[\s._-]?(\d{1,2})\b/i.exec(t)?.[1]) || null;
  const dlc = /\bdlcs?\b|\+\s*\d+\s*dlc/i.test(t);
  // a year alone in brackets, round ones first as trackers write it ("(2006)"), square ones too ("Prey [2006] GOG" was read
  // as no year at all: the bare-year reading looks past every bracket); a tag that holds more ("[GOG Edition 2020]") is none
  const year = Number(/\((\d{4})\)/.exec(t)?.[1]) || Number(/\[(\d{4})\]/.exec(t)?.[1]) || bareYear(t, gameName);
  const ggn = GGN_BLOCK.exec(t);
  const platform = ggn?.[1].trim() ?? null;
  const format = ggn?.[3].trim() ?? null;
  if (format && /repack/i.test(format)) repack = true;                      // "[… / P2P Full Repack]" without a known group name
  const tw = t.replace(/[._]/g, " ");                                          // "_comics_" is a word too
  const nameTok = new Set(tokens(gameName));
  // a soundtrack riding along with the base game is not junk: it follows a bundle word ("v1.2 + 3 DLCs + Bonus OST", "Incl.
  // Soundtrack"); "ELDEN RING OST [FitGirl Repack]" and "ELDEN RING Soundtrack + Bonus" are the soundtrack
  const ost = /\b(soundtrack|ost)\b/i.exec(tw);
  const ridesAlong = !!ost && (bundledBefore(tw.slice(0, ost.index), gameName) || /^\s*(edition|bundle)\b/i.test(tw.slice(ost.index + ost[0].length)));   // "(Soundtrack Edition)": an edition of the game
  const junk = JUNK.filter(([re]) => re.test(tw)).map(([, tag]) => tag)
    .filter(j => !(j === "soundtrack" && ridesAlong));
  if (updateOnly(t, repack, nameTok, gameName)) junk.push("update-only");
  const own = t.replace(/[\[(][^\])]*[\])]/g, " ");
  if (!junk.includes("crack-only")) for (const m of own.matchAll(CRACK_WORD)) {
    if (nameTok.has(m[1].toLowerCase())) continue;
    if (!bundledBefore(own.slice(0, m.index), gameName)) junk.push("crack-only");
    break;
  }
  // a DLC by itself: "dlc" right after the name, then nothing but the group ("ELDEN.RING.DLC-RUNE")
  const next = afterName(own, gameName);
  if (next && /^dlcs?$/.test(next[0] ?? "") && (next.length === 1 || (next.length === 2 && next[1] === group?.toLowerCase())) && !junk.includes("dlc-only")) junk.push("dlc-only");
  if (group && TRAINER_GROUP.test(group) && !nameTok.has(group.toLowerCase()) && !junk.includes("trainer")) junk.push("trainer");
  const tag = /\]\s*\[(update|trainer|patch|crack|dlc|fix)\]\s*$/i.exec(t)?.[1]?.toLowerCase();
  if (tag === "update" && !junk.includes("update-only")) junk.push("update-only");
  if (tag === "trainer" && !junk.includes("trainer")) junk.push("trainer");
  if (tag === "dlc" && !junk.includes("dlc-only")) junk.push("dlc-only");
  if ((tag === "crack" || tag === "patch" || tag === "fix") && !junk.includes("crack-only")) junk.push("crack-only");
  if (format && /gamedox/i.test(format) && !junk.length) junk.push("gamedox");   // GGn's add-on bin: never a full game
  return { group, repack, scene, version, edition, languages, dlc, junk, year, platform, format };
}

/** tokens that mean "a build for something other than a Windows PC" (unless the game's own name has them) */
const NOT_PC_TOKEN = new Set([
  "apk", "android", "ios", "iphone", "ipad", "mobile", "nsw", "nsp", "xci", "switch", "ns2", "nsw2", "switch2", "ps2", "ps3", "ps4", "ps5", "psp", "vita",
  "psvita", "xbox", "xbox360", "x360", "xboxone", "wii", "wiiu", "3ds", "nds", "gba", "macos", "osx", "mac", "linux",
  // the retro consoles: a cartridge or disc dump is never the PC game, and the console pass needs the tag to take it
  "n64", "snes", "sfc", "nes", "famicom", "gc", "ngc", "gcn", "gb", "gbc", "dc", "dreamcast", "saturn", "genesis", "megadrive", "md",
  "ps1", "psx", "psone", "n3ds", "ps2dvd", "ps2cd",
  // what the list missed (MW4's "MacOSX" build was taken, 2026-11-09): Mac, iOS and Android packages, Xbox, Switch and Wii U
  // dump formats, ARM and PowerPC builds
  "macosx", "macintosh", "dmg", "ipa", "xapk", "apks", "obb", "xone", "xsx", "xbsx", "xb1", "nsz", "wux", "wua", "arm64", "aarch64", "ppc",
  // a PlayStation game converted for the PSP names both in one word, and an indexer files it wherever ("Marvel vs Capcom
  // Clash Of Super Heroes PSX2PSP", filed under PS3, was taken as the PS3 game, 2026-11-11); an arcade set names its emulator
  "psx2psp", "mame", "fbneo",
  // a PlayStation package, an Xbox Live Arcade build, TNT's Mac cracks (review, 2026-11-09)
  "pkg", "xbla", "tnt",
]);
/** a PlayStation title id ("CUSA12345", "PPSA01341", "BLUS30443"): a console package — unless the release is plainly a PC
 *  build that names the game it ports ("Bloodborne (CUSA03173) Recompiled for PC [FitGirl Repack]") */
const CONSOLE_SERIAL = /^(cusa|ppsa|bles|blus|bljm|bcus|bces|npub|npeb|npjb|npua|npea)\d{4,5}$/;
const notPcToken = (t: string) => NOT_PC_TOKEN.has(t) || CONSOLE_SERIAL.test(t);
/** the retro consoles' tags (those above that only now name a console): a dump named by one alone is taken only in a pass
 *  for a console the game is known to be on — an old game of the same name ("Doom (USA) SNES" for the 2016 PC game)
 *  carries no year in its dump name to tell them apart, so the any-console fallback of a PC game never takes it */
const RETRO_TAG = new Set(["n64", "snes", "sfc", "nes", "famicom", "gc", "ngc", "gcn", "gb", "gbc", "dc", "dreamcast", "saturn", "genesis", "megadrive", "md", "ps1", "psx", "psone", "n3ds"]);
/** a size in a title ("[FitGirl Repack, Selective Download - from 47.5 GB]") is not a Game Boy tag; a bare year in front of
 *  "GB" ("Tetris (1989) GB" has the bracket between them anyway) is left alone */
const SIZE_TAG = /(^|[^\w.])(?!(?:19|20)\d\d\s?GB\b)\d{1,4}(?:[.,]\d{1,3})?\s?(?:GB|GiB)\b/gi;
/** the words a title names its platform with: the GazelleGames trailer and any size left out */
/** a language tag is not a console: "(EN-GB)" is British English, never a Game Boy dump */
const LANG_TAG = /\b(en|eng)[-_]gb\b/gi;
const platformWords = (title: string) => tokens(title.replace(GGN_BLOCK, " ").replace(/\bswitch[ ._-]+2\b/gi, "switch2").replace(SIZE_TAG, "$1 ").replace(LANG_TAG, "$1"));
/** what only a PC release carries: a console pass never takes a repacker's installer or a Windows build for a dump, whatever
 *  console tag it shows ("Death Stranding DC [FitGirl Repack]" is the Director's Cut, not a Dreamcast disc) */
const PC_WORD = new Set(["windows", "win32", "win64", "x64", "x86"]);
/** a port's own words: "Recompiled for PC", "for Windows" */
const FOR_PC = /(?<![\p{L}\p{N}])for[\s._-]+(?:pc|windows|win(?:32|64)?)(?![\p{L}\p{N}])/iu;
function pcRelease(title: string, name: Set<string>): string | null {
  const repacker = REPACKERS.find(([re]) => re.test(title))?.[1];
  if (repacker && !tokens(repacker).every(t => name.has(t))) return repacker;
  if (FOR_PC.test(title) && !(name.has("pc") || name.has("windows"))) return "for PC";
  return platformWords(title).find(t => PC_WORD.has(t) && !name.has(t)) ?? null;
}
/** the words a dump names its region with — No-Intro and Redump "(USA, Europe)", "(Japan)", "(World)", a scene dump's "USA",
 *  "EUR", "PAL", "NTSC-U" — and GoodTools' codes "(U)", "(E)", "(J)", "(JU)" …: a PC build names none of them */
const REGION_WORD = new Set([
  "usa", "us", "europe", "eur", "pal", "ntsc", "world", "japan", "jpn", "jp", "asia", "korea", "kor", "australia", "brazil", "canada",
  "china", "france", "germany", "hong", "italy", "netherlands", "spain", "sweden", "taiwan", "uk", "russia", "scandinavia",
]);
const GOODTOOLS_REGION = /\((?:[UEJWABCFGIKS]|[JUE]{2,3}|HK|NL|UK|Unk)\)/;
/**
 * May a retro tag in this title name the games inside a PC build rather than what the release runs on? Only on a repacker's
 * or a Windows build (pcRelease) whose title names no dump region: "Collection of Mana (SNES + GB) [FitGirl Repack]" and
 * "Mega Man Legacy Collection (NES) x64" are PC games, "Doom (USA) SNES x86" is the old dump with an emulator for Windows.
 */
function retroTagsNameGames(title: string, name: Set<string>): boolean {
  if (pcRelease(title, name) === null || GOODTOOLS_REGION.test(title)) return false;
  return !platformWords(title).some(t => REGION_WORD.has(t) && !name.has(t));
}
/** what a dump's tags say when it is not the game as it was sold (No-Intro and Redump: "(Beta)", "(Proto 2)", "(Demo) (Kiosk)",
 *  "(Pre-Production)", "(Sample)", "(Promo)", "(Unl)", "(Pirate)", "(Aftermarket)", Redump's discs that came with the game or
 *  went to shops and shows: "(Bonus Disc)", "(Interactive Sampler CD)", "(Previews)", "(Tentou-you Taikenban)", "(E3 1997)",
 *  "(Test Drive Disc)"; GoodTools: "(Hack)", "(PD)"); "(Rev 1)", "(Virtual Console)", "(Disc 1)" and the like are the game */
const NOT_AS_SOLD = new Map<string, string>([
  ["demo", "a demo"], ["kiosk", "a demo"], ["trial", "a demo"], ["preview", "a demo"], ["previews", "a demo"], ["sampler", "a demo"],
  ["taikenban", "a demo"], ["taiken", "a demo"], ["tentou", "a demo"], ["jitsuen", "a demo"], ["jitsuenban", "a demo"], ["cheheompan", "a demo"],
  ["e3", "a demo"], ["test", "a test build"], ["sample", "a sample copy"], ["bonus", "a bonus disc"],
  ["promo", "a promotional copy"], ["promotional", "a promotional copy"], ["kenshouhin", "a promotional copy"],
  ["beta", "a development build"], ["alpha", "a development build"], ["proto", "a development build"], ["prototype", "a development build"],
  ["prerelease", "a development build"], ["preproduction", "a development build"], ["debug", "a development build"],
  ["hack", "a hack"], ["hacked", "a hack"], ["hacks", "a hack"], ["pirate", "a pirate copy"], ["unl", "an unlicensed copy"], ["unlicensed", "an unlicensed copy"],
  ["aftermarket", "homebrew"], ["homebrew", "homebrew"], ["pd", "homebrew"], ["translated", "a translation"], ["translation", "a translation"],
]);
/** the tags that say what a dump is (a beta, a hack, a pirate copy …): no game is sold under them, so the game's own name
 *  never spares one ("Hack Quest (USA) (Hack)" is a hack of it); a demo disc or a sampler can be the product itself
 *  ("Jampack Demo Disc (USA) (Demo)") */
const STATUS_TAG = new Set(["beta", "alpha", "proto", "prototype", "debug", "hack", "hacked", "hacks", "pirate", "unl", "unlicensed", "aftermarket", "homebrew", "pd", "translated", "translation"]);
/** two tag words that say it together ("Special Edition" is the game, a "(Special Disc)" came with it) */
const NOT_AS_SOLD_PAIR = new Map<string, string>([
  ["special disc", "a bonus disc"], ["premium disc", "a bonus disc"], ["making disc", "a bonus disc"], ["extra disc", "a bonus disc"],
  ["virtual drive", "a promotional disc"],
]);
/** the GoodTools codes for the same: [b1] bad, [h1C] hack, [o1] overdump, [t1] trainer, [p1] pirate, [f1] fixed, [T+Eng] and
 *  [T-Eng] translated ([!] verified and [a1] alternate are the game); lowercase letters only, so "[PAL]" or "[FLT]" is no code */
const GOODTOOLS_CODE = /\[(?:([bhotpf])\d*[A-Z0-9]{0,4}|(T)[+-][^\]]*)\]/;
const GOODTOOLS_WHAT: Record<string, string> = { b: "a bad dump", h: "a hack", o: "an overdump", t: "a trainer", p: "a pirate copy", f: "a fixed dump", T: "a translation" };
/** words as the tags mean them: "Pre-Release" and "Pre-Production" are one word each (split, they are "pre" and a harmless one) */
const tagWords = (s: string) => tokens(s.replace(/\bpre[\s._-]+(?=(?:release|production)\b)/gi, "pre"));
/** one spelling per tag word ("(Proto)" is what a "prototype" asks for), and the word a GoodTools code means */
const SAME_TAG: Record<string, string> = { prototype: "proto", hacked: "hack", hacks: "hack", unlicensed: "unl", promotional: "promo", translation: "translated" };
const sameTag = (w: string) => SAME_TAG[w] ?? w;
const GOODTOOLS_WORD: Record<string, string> = { h: "hack", p: "pirate", T: "translated" };
/** why a dump (a release, a file, a dump list's entry) is not the game as it was sold, or null: a word in its tags that the
 *  game's own name does not have ("Jampack Demo Disc (USA) (Demo)" is that game; a status tag such as "(Beta)" or "(Hack)"
 *  counts whatever the game is called), nor the words `asked` (a way's own description of a prototype it wants: any
 *  spelling of the tag), or a GoodTools code */
export function notAsSold(title: string, gameName: string, asked: string[] = []): string | null {
  const name = new Set(tagWords(gameName));
  const want = new Set(asked.flatMap(tagWords).map(sameTag));
  for (const tag of title.match(/[\[(][^\])]*[\])]/g) ?? []) {
    const words = tagWords(tag);
    const word = words.find(t => NOT_AS_SOLD.has(t) && (STATUS_TAG.has(t) || !name.has(t)) && !want.has(sameTag(t)));
    if (word) return `${tag}: ${NOT_AS_SOLD.get(word)}, not the game as it was sold`;
    const at = words.findIndex((t, i) => NOT_AS_SOLD_PAIR.has(`${t} ${words[i + 1]}`) && !(name.has(t) && name.has(words[i + 1])) && !want.has(t));
    if (at >= 0) return `${tag}: ${NOT_AS_SOLD_PAIR.get(`${words[at]} ${words[at + 1]}`)}, not the game as it was sold`;
  }
  const code = GOODTOOLS_CODE.exec(title);
  if (code && want.has(GOODTOOLS_WORD[code[1] ?? code[2]] ?? "")) return null;
  return code ? `${code[0]}: ${GOODTOOLS_WHAT[code[1] ?? code[2]]}, not the game as it was sold` : null;
}
/** the tags that say a PC release is not the game as it was sold: a demo, a development build, a test (review, 2026-11-09:
 *  the console dumps' vocabulary refused "Kenshi (Bonus Content)", a fan translation and "7 Days to Die (Alpha 21.2)") — bonus
 *  content and a translation ride along on PC, a promotional copy or a hack is a console dump's tag */
const PC_NOT_AS_SOLD = new Map<string, string>([
  ["demo", "a demo"], ["kiosk", "a demo"], ["trial", "a demo"], ["preview", "a demo"], ["previews", "a demo"], ["sampler", "a demo"], ["e3", "a demo"],
  ["taikenban", "a demo"], ["taiken", "a demo"],
  ["test", "a test build"], ["beta", "a development build"], ["alpha", "a development build"], ["proto", "a development build"], ["prototype", "a development build"],
  ["prerelease", "a development build"], ["preproduction", "a development build"], ["debug", "a development build"],
]);
/** why a PC release's own tags say it is not the game as it was sold, or null: one of the words above that the game's name
 *  does not have and the way does not ask for; "Alpha 21.2", "Beta 0.98.50" (a version after it) is an early access build,
 *  and a tag that names the game itself ("[Prototype 2 RADNET Edition]") is the game's */
export function pcNotAsSold(title: string, gameName: string, asked: string[] = []): string | null {
  const name = new Set(tagWords(gameName));
  const want = new Set(asked.flatMap(tagWords).map(sameTag));
  const nameSeq = tokens(gameName).filter(t => !STOP.has(t));
  for (const tag of title.match(/[\[(][^\])]*[\])]/g) ?? []) {
    const words = tagWords(tag);
    if (nameSeq.length && inOrder(nameSeq, words) >= 0) continue;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!PC_NOT_AS_SOLD.has(w) || name.has(w) || want.has(sameTag(w))) continue;
      if ((w === "alpha" || w === "beta") && /^v?\d/.test(words[i + 1] ?? "")) continue;
      return `${tag}: ${PC_NOT_AS_SOLD.get(w)}, not the game as it was sold`;
    }
  }
  return null;
}
/** newznab's Mac, iOS and Android trees under PC: a release filed only there ("Hollow.Knight.v1.5.78.11833-TNT", 4030) is
 *  another platform's build, whatever its title says (an indexer's own ids, 100000 and up, mirror the standard ones) */
const OTHER_PC_CATEGORY: Record<number, string> = { 4030: "Mac", 4060: "iOS", 4070: "Android" };
function otherPcCategory(categories: number[]): string | null {
  const std = categories.filter(c => c < 100000);
  if (!std.length || !std.every(c => OTHER_PC_CATEGORY[c])) return null;
  return `filed under ${[...new Set(std.map(c => OTHER_PC_CATEGORY[c]))].join(", ")}, not PC`;
}
const MOD_TOKEN = new Set(["mod", "mods", "modded", "modpack"]);
const BUNDLE_WORD = new Set(["incl", "including", "with", "plus", "and"]);
/** a usenet subject naming one file of a post: [30/44] "Name.part1.rar" yEnc */
/** digital comics share names with games (Bloodborne, Witcher …): cbz/cbr files, "(Digital) (Titan Comics)"-style tags */
const COMIC = /\.(cbz|cbr)\b|\((digital(-hd)?|webp|scan|c2c)\)|\b(titan|dc|marvel|idw|dark horse|image|boom!?|dynamite|vertigo|oni press|archie|valiant|aftershock) comics?\b|\bcomics?\b.*\b(digital|cbz|cbr)\b/i;
const PART_POST = /^\s*\[\d+\s*\/\s*\d+\]|"[^"]*\.(part\d+\.rar|rar|r\d\d|zip|7z|\d{3}|par2|nzb)"|\byenc\b/i;
/** a file's name where a release's should be: an executable, a script or a shortcut, alone or packed ("…Repack-P2P.exe.rar"
 *  for MW4, 2026-11-09; "[mininova] rar.exe"; "ELDEN RING.iso.lnk") — the fake / malware post. Never ".com": a domain in a name */
const EXEC_FILE = /\.(?:exe|scr|lnk|pif|bat|cmd|msi|vbs|jar|ps1|url)(?:\.(?:rar|zip|7z))?(?=$|[\s"'\])])/i;
/** a title that ends in an archive's extension ("[EXTERNAL] … [mininova] rar.rar"): a file, not a release — on PC only (a
 *  No-Intro dump is posted as "Game (USA).zip") */
const ARCHIVE_END = /\.(?:rar|zip|7z)["']?\s*$/i;
/** an early access build is the game: GazelleGames tags it "[Early Access 2025]" */
const EARLY_ACCESS_TAG = /[\[(]\s*early\s+access(?:\s+\d{4})?\s*[\])]/gi;
/** a tag that names what comes with the game ("(v1.0 + DLC + Bonus OST, MULTi12) [DODI Repack]", "[Incl. Soundtrack]") says
 *  nothing about what the release itself is */
const BUNDLE_TAG = /[\[(][^\])]*(?:\+|(?<![\p{L}\p{N}])(?:incl|including|with|plus)(?![\p{L}\p{N}]))[^\])]*[\])]/giu;
/** a tag that by itself names an add-on filed beside the game: "[Playtest]", "[Prologue]", "[Benchmark]", "[Dedicated Server]",
 *  "[Original Soundtrack]", "[Artbook]" */
const ADDON_TAG: Record<string, string> = { playtest: "a playtest", prologue: "a prologue", benchmark: "a benchmark", server: "a server", soundtrack: "the soundtrack", ost: "the soundtrack", artbook: "an artbook" };
const ADDON_FILLER = new Set(["the", "a", "an", "original", "official", "dedicated", "digital", "game"]);
/** an add-on by its tag's first word ("[Benchmark Tool]", "[Server Files]", "(Prologue Edition)"), unless the game's own name
 *  has that word ("Prologue") or the way's description asks for it; a "(Soundtrack Edition)" is an edition of the game */
function addonTag(title: string, name: Set<string>, asked: string[]): string | null {
  const want = new Set(asked.flatMap(tokens));
  for (const tag of title.match(/[\[(][^\])]*[\])]/g) ?? []) {
    const words = tokens(tag.replace(/\bart\s+book\b/gi, "artbook")).filter(w => !ADDON_FILLER.has(w));
    const w = words[0];
    if (!w || !ADDON_TAG[w] || name.has(w) || want.has(w)) continue;
    if (/^(soundtrack|ost|artbook)$/.test(w) && /^(edition|bundle)$/.test(words[1] ?? "")) continue;
    return `${tag}: ${ADDON_TAG[w]}, not the game`;
  }
  return null;
}
/** films and episodes share words with games ("INSIDE" took "Concrete Revolutio - S01E02 - [Inside the 'Black Smog' (02)]
 *  [Bluray-1080p][AV1][AAC]" twice): an episode number marks a video by itself, and so do two of the usual video tags. The
 *  title is read with dots and underscores as spaces ("Vandaag_Inside_S10E54_DUTCH_1080p_WEB_h264": "_" is a word character,
 *  so a plain \b never fires there) */
const spaced = (title: string) => title.replace(/[._]+/g, " ");
const EPISODE = /\bS\d{1,2}\s?E\d{1,3}\b|\bepisode\s?\d+\b/i;
const VIDEO_TAG = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|x26[45]|h\s?26[45]|hevc|av1|xvid|divx|blu-?ray|bdrip|brrip|bdremux|remux|web[\s-]?dl|webrip|hdtv|dvdrip|hdrip|aac|ddp?5\s?1|dts|truehd|atmos|mp4|mkv|avi)\b/gi;
const ADULT = /\bxxx\b/i;
/** newznab's video, audio, book and adult trees; a release filed only there (and not under PC or console) is not a game */
const notGameCategory = (cats: number[]) => cats.length > 0 && cats.every(c => (c >= 2000 && c < 4000) || (c >= 5000 && c < 8000));

/** the platform a release names: the GazelleGames trailer, a scene tag ("PS3", "NSW"), else its newznab category */
export function releasePlatform(title: string, p: ParsedTitle, categories: number[] = [], nameTokens: Set<string> = new Set()): PlatformId | null {
  return platformAndTag(title, p, categories, nameTokens).id;
}
/** the platform and, when a tag in the title named it, that tag */
function platformAndTag(title: string, p: ParsedTitle, categories: number[], nameTokens: Set<string>): { id: PlatformId | null; tag: string | null } {
  const trailer = platformId(p.platform);
  if (trailer) return { id: trailer, tag: null };
  // on a release that is plainly a PC build (a repacker's, a Windows build, no dump region) a retro tag names the games in
  // it, not what it runs on: "Collection of Mana (SNES + GB) [FitGirl Repack]" is installed, never unpacked as a dump
  const pcBuild = retroTagsNameGames(title, nameTokens);
  // a PC port names the console's title id of the game it ports: the id is no platform of the release
  const port = pcRelease(title, nameTokens) !== null;
  for (const t of platformWords(title)) {
    if (nameTokens.has(t) || !notPcToken(t) || (pcBuild && RETRO_TAG.has(t)) || (port && CONSOLE_SERIAL.test(t))) continue;
    const id = platformId(t);
    if (id) return { id, tag: t };
  }
  return { id: platformOfCategory(categories), tag: null };
}

/** a console pass for one way's game file (src/ways/find.ts): `unnamed` takes a dump that names no console ("Legend of Zelda,
 *  The - Majora's Mask (USA)", as No-Intro and Redump name them) as one of the pass's consoles — only for a way that checks the
 *  file once it is here; `asked` are the words of the way's own description, whose tags it may want ("Dinosaur Planet" is a
 *  prototype) */
export interface DumpPass { unnamed?: boolean; asked?: string[] }

/**
 * why this is not the game at all, or null — the automatic matcher refuses anything named here. `want` is the
 * platforms this search is for: PC by default; a console pass names the consoles the game is on, and then a
 * release must say which console it is (a dump that names none is not taken on faith, unless the pass says so: `dump`).
 */
export function wrongKind(q: GameQuery, title: string, p: ParsedTitle, want: PlatformId[] = ["pc"], categories: number[] = [], known?: PlatformId[], dump: DumpPass = {}): string | null {
  const name = new Set(tokens(q.name));
  const { id: plat, tag } = platformAndTag(title, p, categories, name);
  if (want.includes("pc")) {
    if (p.platform && !PC_PLATFORMS.test(p.platform)) return `platform: ${p.platform}`;
    const filed = otherPcCategory(categories);
    if (filed) return filed;
    // what a PC release's own tags say it is: "(Demo)", "[Beta]", "[Network Test]" are not the game as it was sold (an early
    // access build is), "[Playtest]", "[Prologue]", "[Server]" … an add-on filed beside it; a tag that lists what comes with
    // the game says nothing about the release, and a way's description may ask for a tag
    const own = title.replace(EARLY_ACCESS_TAG, " ").replace(BUNDLE_TAG, " ");
    const sold = pcNotAsSold(own, q.name, dump.asked) ?? addonTag(own, name, dump.asked ?? []);
    if (sold) return sold;
  } else {
    // first what only a PC release carries: its retro tags name no console (platformAndTag), and it is no dump either way
    const pc = pcRelease(title, name);
    if (pc) return `a PC release (${pc}), not a console dump`;
    if (!plat && !dump.unnamed) return "names no console — a dump must say which console it is for";
    if (plat && !want.includes(plat)) return `platform: ${PLATFORM_LABEL[plat]}`;
    if (plat && tag && RETRO_TAG.has(tag) && known && !known.includes(plat)) return `a ${PLATFORM_LABEL[plat]} dump, and the game is not known to be on that console`;
    const sold = notAsSold(title, q.name, dump.asked);
    if (sold) return sold;
  }
  if (PART_POST.test(title)) return "one file of a usenet post, not a release";
  // ".PS1" ends a PlayStation dump's name too ("Crash.Bandicoot.USA.PS1"): a script's extension on PC only
  const exec = EXEC_FILE.exec(title);
  const file = (exec && (want.includes("pc") || !/^\.ps1/i.test(exec[0])) ? exec : null) ?? (want.includes("pc") ? ARCHIVE_END.exec(title) : null);
  if (file) return `a file name, not a release (${file[0].replace(/["'\s]/g, "")})`;
  if (COMIC.test(title)) return "a comic book, not a game";
  const sp = spaced(title);
  if (EPISODE.test(sp)) return "an episode of a show, not a game";
  if (ADULT.test(sp) && !name.has("xxx")) return "an adult video, not a game";
  const videoTags = new Set((sp.match(VIDEO_TAG) ?? []).map(t => t.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (videoTags.size >= 2) return `a video, not a game (${[...videoTags].slice(0, 3).join(", ")})`;
  if (notGameCategory(categories)) return "filed under video, music or books, not games";
  const tt = platformWords(title);
  if (want.includes("pc")) {
    // a retro tag on a repacker's or a Windows build names the games in it; a dump dressed in a group's tag ("Doom (USA)
    // SNES [P2P]") or handed out with an emulator ("Doom (USA) SNES x86") stays refused
    const pcBuild = retroTagsNameGames(title, name);
    const port = pcRelease(title, name) !== null;
    const notPc = tt.find(t => notPcToken(t) && !name.has(t) && !(pcBuild && RETRO_TAG.has(t)) && !(port && CONSOLE_SERIAL.test(t)));
    if (notPc) return `not a PC build (${notPc})`;
  }
  const i = tt.findIndex(t => MOD_TOKEN.has(t) && !name.has(t));
  if (i >= 0 && !BUNDLE_WORD.has(tt[i - 1] ?? "")) return `a mod, not the game (${tt[i]})`;
  return null;
}

/** "USA", "EUR", "Japan" … in a title: console dumps come per region, and an English one is the one to have */
const REGION = /(?:^|[\s./_()\[-])(usa|us|ntsc-?u|europe|eur|pal|world|japan|jpn|jp|ntsc-?j|asia|korea|kor)(?=$|[\s./_()\]-])/i;

const REORDERED = "the words of the name are in another order (another game?)";
/** the token after the name's word before its closing number, up to that number: a word there ("Resident Evil Revelations 2"
 *  for Resident Evil 2) is another game's; articles are fine. `placed` are the name's words in order, `tt` the title's */
function numberGap(placed: string[], tt: string[]): string | null {
  const num = placed[placed.length - 1];
  if (placed.length < 2 || !/^\d+$/.test(num)) return null;
  let at = 0;
  for (const w of placed.slice(0, -1)) { const j = tt.indexOf(w, at); if (j < 0) return null; at = j + 1; }
  const n = tt.indexOf(num, at);
  if (n < 0) return null;
  const prev = tt.lastIndexOf(placed[placed.length - 2], n - 1);
  return tt.slice(prev + 1, n).find(t => !STOP.has(t)) ?? null;
}

/** a word with a digit that is a word of a name all the same, never a version or a tag: "Wolfenstein 3D" is not "Wolfenstein",
 *  "Worms 3D" not "Worms" */
const DIMENSION_WORD = /^[2-4]d$/;

export function matchTitle(q: GameQuery, title: string): MatchInfo {
  const tt = new Set(tokens(title));
  const coreHit = q.core.filter(t => tt.has(t)).length;
  const optHit = q.optional.filter(t => tt.has(t)).length;
  return {
    ok: q.core.length > 0 && coreHit === q.core.length,
    core: q.core.length ? coreHit / q.core.length : 0,
    optional: q.optional.length ? optHit / q.optional.length : 1,
  };
}

export function scoreRelease(q: GameQuery, r: ProwlarrRelease, p: ParsedTitle, m: MatchInfo, privacy?: string, want: PlatformId[] = ["pc"], known?: PlatformId[], dump?: DumpPass): { score: number; reasons: string[]; flags: MatchFlags } {
  const reasons: string[] = [];
  const cats = (r.categories ?? []).map(c => c.id);
  const flags: MatchFlags = { sequel: false, extraWords: false, buried: false, yearOff: null, wrongKind: wrongKind(q, r.title, p, want, cats, known, dump), platform: releasePlatform(r.title, p, cats, new Set(tokens(q.name))) };
  let s = 0;
  if (m.ok) s += 100; else { s += 60 * m.core; reasons.push(`partial match ${Math.round(m.core * 100)}%`); }
  if (q.optional.length) { s += 30 * m.optional; if (m.optional === 1) reasons.push("full title"); }

  // title-shape heuristics look at the bare title — "[GOG Edition 2017]" / "(2020)" trailers are tracker metadata, not the name
  const bare = r.title.replace(/[\[(][^\])]*[\])]/g, " ");
  const tt = tokens(bare);
  const words = nameWords(q);
  const nameNums = new Set(tokens(q.name).filter(x => /^\d+$/.test(x)));
  const spaced = /\s/.test(bare.trim());

  // the name's words in the name's order, the tags counted ("Lords of the Fallen (2014)" names "Lords Of The Fallen™ 2014"):
  // "Call of Duty 4 Modern Warfare" has every word of "Call of Duty: Modern Warfare 4" and is the 2007 game (2026-11-09). They
  // are read where they are words of a name — a version ("v1.4"), a size ("[4 GB]") or a count ("+ 4 DLCs") supplies none —
  // a name's year counts wherever it stands, and a name that ends in its number has it right after the word before it
  const all = tokens(r.title);
  const read = tokens(shapeText(r.title, q.name, spaced));
  const placed = words.filter(w => !yearWord(w));
  if (words.length && words.every(w => all.includes(w))) {
    const lost = words.find(w => !read.includes(w));
    const gap = lost ? null : numberGap(placed, read);
    if (lost) { s -= 20; flags.misread = `the name's "${lost}" is only part of a version, a size or a count: another entry?`; reasons.push(flags.misread); }
    else if (placed.length >= 2 && inOrder(placed, read) < 0) { s -= 20; flags.reordered = true; reasons.push(REORDERED); }
    else if (gap) { s -= 20; flags.misread = `more words between the name and its number ("${gap}"): another game?`; reasons.push(flags.misread); }
  }

  // sequel sniff: "Hades 2" when you asked for "Hades" — a small integer right after the name's head, or right after the whole
  // name ("Modern Warfare 2" for "Call of Duty: Modern Warfare", "Black Ops II" for "Black Ops"); a version is one word
  // ("v1.02", "1.0.3"), and a number that counts what comes along ("+ 3 DLCs", "2 in 1") is no word at all
  const st = tokens(shapeText(bare, q.name, spaced));
  const sequelAt = (k: number) => { const n = st[k]; return n && /^\d{1,2}$/.test(n) && !nameNums.has(n) ? n : null; };
  const head = Math.max(-1, ...q.core.map(c => st.lastIndexOf(c)));
  if (head >= 0 && sequelAt(head + 1)) { s -= 20; flags.sequel = true; reasons.push("looks like a sequel / other entry"); }
  else {
    let k = inOrder(words, st);
    while (k > 0 && k < st.length && STOP.has(st[k])) k++;
    const n = k > 0 ? sequelAt(k) : null;
    if (n) { s -= 20; flags.sequel = true; reasons.push(`a number after the name ("${n}"): a sequel or another entry`); }
  }

  // extra title words right after the name ("Hollow Knight Silksong", "ELDEN RING NIGHTREIGN") → likely another entry;
  // waived for editions ("Tarnished Edition"), the release group, and the usual release noise
  const last = Math.max(-1, ...q.core.map(c => tt.lastIndexOf(c)));
  const nameTok = new Set(tokens(q.name));
  // the first real word after the name, looking past articles, release noise and every word with a digit in it (a version, a
  // volume, "MULTi12", "DX12"): "Bloodborne - The Death of Sleep", "Bloodborne v02: The Healing Thirst" and "ELDEN RING
  // MULTi12 Language Pack" are other things with the name in front
  const after = last >= 0 ? tt.slice(last + 1).find(w => !STOP.has(w) && !TRAIL_OK.has(w) && !nameTok.has(w) && (!/\d/.test(w) || DIMENSION_WORD.test(w))) : undefined;
  const afterIdx = after ? tt.indexOf(after, last + 1) : -1;
  const namesAnEdition = afterIdx >= 0 && (tt[afterIdx + 1] === "edition" || tt[afterIdx + 2] === "edition");   // "Voidheart Edition", "Old Hunters Edition"
  // the number waiver is for a sequel already flagged ("Hades 2 Nightmare"): the name's own number after its head ("Call of
  // Duty 4 Modern Warfare v1.7.2 MacOSX" for "Call of Duty: Modern Warfare 4") waives nothing
  if (after && (/^\p{L}+$/u.test(after) || DIMENSION_WORD.test(after)) && after !== p.group?.toLowerCase() && !SCENE.has(after) && !namesAnEdition && !flags.sequel) {
    s -= 12; flags.extraWords = true; reasons.push(`extra title words ("${after}")`);
  }

  // name buried mid-title ("Daymare 1998 HADES Dead End") — a different game that merely contains the word
  const first = Math.min(...q.core.map(c => { const i = tt.indexOf(c); return i < 0 ? Infinity : i; }));
  const lead = Number.isFinite(first) ? tt.slice(0, first).filter(x => !STOP.has(x) && !LEAD_OK.has(x) && !nameTok.has(x)) : [];
  if (lead.length) { s -= 25; flags.buried = true; reasons.push(`name not at start ("${lead.slice(0, 3).join(" ")}")`); }
  // the name only inside the tags the shape checks skip ("[Inside the 'Black Smog' (02)]", an episode's title): the release is
  // something else that mentions it; without this the checks above see no name at all and flag nothing
  else if (!Number.isFinite(first) && m.ok) { s -= 40; flags.buried = true; reasons.push("name only inside its tags"); }

  if (r.protocol === "torrent") {
    if (r.seeders == null) s += 5;
    else if (r.seeders === 0) { s -= 30; reasons.push("no seeders"); }
    else { s += Math.min(20, Math.log2(r.seeders + 1) * 3.3); reasons.push(`${r.seeders} seeders`); }
  } else if (r.protocol === "usenet") {
    s += 12; reasons.push("usenet");
    if (r.age > 1500) { s -= 10; reasons.push("old post, retention risk"); }
  }
  if (p.repack) { s += 8; reasons.push(`${p.group ?? "unknown"} repack`); }
  else if (p.scene && p.group) { s += 5; reasons.push(p.group); }
  else if (!p.group && !p.format) s -= 3;
  // GGn formats: Home Rip / DRM-Free are ready-to-run (best for automated processing); internals are curated; an ISO still needs installing
  if (p.format && /home rip|drm[\s._-]?free/i.test(p.format)) { s += 10; reasons.push(p.format); }
  else if (p.format && /internal/i.test(p.format)) { s += 5; reasons.push(p.format); }
  else if (p.format && /full iso/i.test(p.format)) { s += 3; reasons.push(p.format); }
  if (flags.wrongKind) { s -= 50; reasons.push(flags.wrongKind); }
  else if (flags.platform && flags.platform !== "pc") { s += 5; reasons.push(PLATFORM_LABEL[flags.platform]); }
  if (!want.includes("pc")) {                                              // a console dump comes per region: English first
    const region = REGION.exec(r.title)?.[1]?.toLowerCase();
    if (region && /^(japan|jpn|jp|ntsc-?j|asia|korea|kor)$/.test(region)) { s -= 8; reasons.push(`region ${region.toUpperCase()}`); }
    else if (region) { s += 4; reasons.push(region.toUpperCase()); }
  }
  if (q.year && p.year) {
    flags.yearOff = Math.abs(p.year - q.year);
    if (p.year === q.year) s += 5;
    else if (flags.yearOff >= 2) { s -= 15; reasons.push(`year ${p.year} vs ${q.year}`); }
  }
  for (const j of p.junk) { s -= j === "update-only" ? 25 : j === "dlc-only" ? 40 : 60; reasons.push(j); }
  const gb = r.size / 1e9;
  if (r.size && gb < 0.1) { s -= 40; reasons.push("tiny"); }
  else if (r.size && gb < 1) { s -= 10; reasons.push("small"); }
  else if (gb > 200) { s -= 5; reasons.push("huge"); }
  if (privacy === "private") s += 4; else if (privacy === "semiPrivate") s += 2;
  if (r.age <= 30) s += 3;
  return { score: Math.round(s * 10) / 10, reasons, flags };
}

/** what the title is missing of the name it was judged under, in words */
function lacking(r: ReleaseView): string {
  const q = r.matchedName ? buildQuery(r.matchedName) : null;
  const have = new Set(tokens(r.title));
  const miss = q ? (r.match.ok ? q.optional : q.core).filter(t => !have.has(t)) : [];
  return miss.length ? `the title lacks "${miss.join(" ")}" from the name` : "the title lacks words of the name";
}
/**
 * Every reason this release is not certainly the game, by its name and its kind, in plain words (empty: it is). `say`
 * false only counts them (certainlyThisGame), without composing the words.
 */
function uncertainty(r: ReleaseView, say: boolean): string[] {
  const out: string[] = [];
  const word = (re: RegExp) => r.reasons.find(x => re.test(x));
  if (!r.match.ok || r.match.optional < 1) out.push(say ? lacking(r) : "x");             // every subtitle word, or it is not this game
  const f = r.flags ?? { sequel: false, extraWords: false, buried: false, yearOff: null };
  if (f.reordered) out.push(REORDERED);
  if (f.misread) out.push(f.misread);
  if (f.sequel) out.push(say ? (word(/^a number after the name/) ?? "looks like a sequel or another entry") : "x");
  if (f.extraWords) { const w = say ? /\("(.*)"\)/.exec(word(/^extra title words/) ?? "")?.[1] : null; out.push(say ? `more words after the name${w ? ` ("${w}")` : ""}: another game or an add-on` : "x"); }
  if (f.buried) { const lead = say ? /\("(.*)"\)/.exec(word(/^name not at start/) ?? "")?.[1] : null; out.push(say ? (lead ? `the name is not at the start ("${lead}"): another game?` : "the name is only in its tags: something that mentions the game") : "x"); }
  if (f.wrongKind) out.push(f.wrongKind);                  // another platform's build, an APK mod, one usenet part … (the pass decides which platforms count)
  if (r.parsed.platform && !PC_PLATFORMS.test(r.parsed.platform) && !f.platform) out.push(`made for ${r.parsed.platform}, which this search never judged`);   // a non-PC trailer the pass never judged (an older candidate): not on faith
  if (f.yearOff != null && f.yearOff > 1) out.push(say ? `from ${r.parsed.year}: ${f.yearOff} years off the game's year` : "x");
  return out;
}

/**
 * Is this release certainly *this* game? Automatic searches never take a chance: the subtitle must be
 * there ("Belmont's Curse", not just "Castlevania"), in the name's order, nothing that smells like a sequel, another entry
 * or a buried name, and a year that is at most one off when both are known.
 */
export function certainlyThisGame(r: ReleaseView): boolean {
  return uncertainty(r, false).length === 0;
}

/** what parseTitle's junk tags mean, in words */
const JUNK_WORDS: Record<string, string> = {
  "update-only": "an update or a patch, not the game", "dlc-only": "a DLC by itself, not the game", trainer: "a trainer, not the game",
  "crack-only": "a crack by itself, not the game", keygen: "a key generator, not the game", cheat: "cheats, not the game",
  soundtrack: "the soundtrack, not the game", artbook: "an artbook, not the game", savegame: "a save game, not the game",
  nocd: "a no-CD patch, not the game", "comic / book": "a comic or a book, not a game", gamedox: "add-ons for the game (GameDOX), not the game",
};
/**
 * Every reason the automatic searcher would not take this release by what its title says — not certainly the game (above),
 * or an update, a trainer, a soundtrack … — in plain words; empty: nothing in its name stands in the way. The reasons that
 * need the whole search (the other copies, the game's dates, CrackWatch) are added by src/requests.ts automaticRefusals.
 */
export function nameRefusals(r: ReleaseView): string[] {
  return [...uncertainty(r, true), ...r.parsed.junk.map(j => JUNK_WORDS[j] ?? j)];
}

/** `platforms`: what this pass takes (PC by default); `known`: in a console pass, the consoles the game is known to be on
 *  (absent: no such limit); `unnamed` / `asked`: a way's own console pass (DumpPass) */
export interface RankOptions extends DumpPass { loose?: boolean; privacy?: Map<number, string>; platforms?: PlatformId[]; known?: PlatformId[] }

export function rankReleases(q: GameQuery, rows: ProwlarrRelease[], opt: RankOptions = {}): ReleaseView[] {
  return rankForNames([q], rows, opt);
}

/**
 * Rank releases for a game that goes by several names (its own first, then its aliases). Each release is judged under
 * every name on its own, with the full rules: the view kept is the best-scoring one among the names it is certainly the
 * game under, else the best-scoring one overall — so a view's score, flags and certainty always come from one name, and
 * an alias can make a release certain only by passing every rule itself.
 */
export function rankForNames(qs: GameQuery[], rows: ProwlarrRelease[], opt: RankOptions = {}): ReleaseView[] {
  const views: ReleaseView[] = [];
  for (const r of rows) {
    let best: ReleaseView | null = null, sure: ReleaseView | null = null;
    for (const q of qs) {
      const match = matchTitle(q, r.title);
      if (!match.ok && !opt.loose) continue;
      const parsed = parseTitle(r.title, q.name);                       // the name's own words never mark it ("Patch Quest")
      const { score, reasons, flags } = scoreRelease(q, r, parsed, match, opt.privacy?.get(r.indexerId), opt.platforms ?? ["pc"], opt.known, { unnamed: opt.unnamed, asked: opt.asked });
      const v: ReleaseView = { ...r, parsed, match, score, reasons, flags, alsoOn: [], matchedName: q.name };
      if (!best || v.score > best.score) best = v;
      if ((!sure || v.score > sure.score) && certainlyThisGame(v)) sure = v;
    }
    const pick = sure ?? best;
    if (pick) views.push(pick);
  }
  views.sort((a, b) => b.score - a.score || (b.seeders ?? 0) - (a.seeders ?? 0));
  const seen = new Map<string, ReleaseView>();
  const out: ReleaseView[] = [];
  for (const v of views) {
    const key = v.infoHash?.toUpperCase() ?? `${v.protocol}:${v.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}:${v.size}`;
    const prev = seen.get(key);
    if (prev) { if (prev.indexer !== v.indexer && !prev.alsoOn.includes(v.indexer)) prev.alsoOn.push(v.indexer); continue; }
    seen.set(key, v);
    out.push(v);
  }
  return out;
}
