/**
 * ludarr — what a dump's name says about it, shared by the content pass (src/ways/find.ts), the dump lists
 * (src/catalog/providers/dats.ts) and the check of a way's game file plan (src/ways/validate.ts):
 *
 *   regions       one name per region: a way's own words ("US", "U", "NTSC-U", "Europe", "PAL" …, normalised when the
 *                 way is saved) and what a release or a file names ("(USA, Europe)", "PAL", GoodTools' "(U)")
 *   disc          which disc of a game a name is ("(Disc 2)"): a way keeps one file, the first disc unless it asks
 *   retail tags   whether every bracketed tag of a dump list's entry is one a retail dump carries (a region, languages,
 *                 a revision or version, the first disc, an alternate dump, a budget or limited re-release): anything
 *                 else is an edition the list cannot vouch for
 *
 *   same game     is it the same game? Names compared as the catalog normalises them (src/catalog/store.ts normName). The
 *                 construct job asks it (a repo's curated game against the job's game), the game draft asks it (a lookup's hit against
 *                 the name typed), and so do the ways (a recomp's or a port's plan against the library game it is added to).
 */
import { tokens } from "../releases";
import { normName } from "../catalog/store";
import { gameAliases } from "../catalog/providers/custom";
import type { GameRow } from "../db";

/** "US", "Europe", "PAL", "NTSC-J", GoodTools' "U" … as one name per region */
const REGION_WORD: Record<string, string> = {
  us: "US", usa: "US", u: "US", ntsc: "US", ntscu: "US", ntscuc: "US", na: "US", america: "US", northamerica: "US", canada: "US",
  eu: "EU", eur: "EU", e: "EU", europe: "EU", pal: "EU", uk: "EU", germany: "EU", france: "EU", spain: "EU", italy: "EU", netherlands: "EU",
  sweden: "EU", scandinavia: "EU", f: "EU", g: "EU", i: "EU", s: "EU",
  jp: "JP", jpn: "JP", jap: "JP", j: "JP", japan: "JP", ntscj: "JP",
  world: "WORLD", w: "WORLD", kr: "KR", kor: "KR", k: "KR", korea: "KR", ntsck: "KR", asia: "ASIA", au: "AU", a: "AU", australia: "AU",
  br: "BR", b: "BR", brazil: "BR", cn: "CN", c: "CN", china: "CN", tw: "TW", taiwan: "TW",
};
/** the region names a way's accept.regions is written in */
export const REGION_NAMES = [...new Set(Object.values(REGION_WORD))];

/** a way's region word as its one name ("U", "NTSC-U", "North America" → US), or null when it names no region */
export const regionKey = (s: string): string | null => REGION_WORD[s.toLowerCase().replace(/[^a-z]/g, "")] ?? null;

const GOODTOOLS_REGION = /\(([UEJWABCFGIKS]|[JUE]{2,3})\)/g;
/** the regions a release (or a file) names — No-Intro's "(USA, Europe)", a scene "PAL" or "NTSC-J", GoodTools' "(U)" —
 *  leaving out the game's own words ("Super Mario World" names no region); single letters only as GoodTools writes them */
export function regionsOf(title: string, nameWords: Set<string> = new Set()): string[] {
  const out = new Set<string>();
  const t = tokens(title);
  t.forEach((w, i) => {
    if (nameWords.has(w)) return;
    if (w === "ntsc") out.add(t[i + 1] === "j" ? "JP" : t[i + 1] === "k" ? "KR" : "US");
    else if (w.length > 2 || ["us", "uk", "jp", "eu"].includes(w)) { const r = REGION_WORD[w]; if (r) out.add(r); }
  });
  for (const m of title.matchAll(GOODTOOLS_REGION)) for (const ch of m[1]) out.add(REGION_WORD[ch.toLowerCase()]);
  return [...out].filter(Boolean);
}

/** how early a release comes by the way's regions: 0 for the first wanted region (a world release fits any), the count of
 *  wanted regions for one that names none, null for one that names only regions the way does not take */
export function regionRank(regions: string[], wanted: string[]): number | null {
  if (!wanted.length) return 0;
  if (!regions.length) return wanted.length;
  let best = Infinity;
  for (const r of regions) { const i = r === "WORLD" ? 0 : wanted.indexOf(r); if (i >= 0 && i < best) best = i; }
  return Number.isFinite(best) ? best : null;
}

/** which disc of a game a name says it is: "(Disc 2)", "(Disc B)", "(CD 2)", a scene "Disc.2" or "Disc2"; null when it names none */
export function discNumber(name: string): number | null {
  const tag = /[([](?:disc|disk|cd|dvd)[\s_-]?(\d{1,2}|[A-H])(?:[\s_-]?of[\s_-]?\d+)?[)\]]/i.exec(name);
  if (tag) return /\d/.test(tag[1]) ? Number(tag[1]) : tag[1].toUpperCase().charCodeAt(0) - 64;
  const t = tokens(name.replace(/\.[A-Za-z0-9]{1,5}$/, ""));
  for (let i = 0; i < t.length; i++) {
    const glued = /^dis[ck](\d{1,2})$/.exec(t[i]);
    if (glued) return Number(glued[1]);
    if ((t[i] === "disc" || t[i] === "disk") && /^\d{1,2}$/.test(t[i + 1] ?? "")) return Number(t[i + 1]);
  }
  return null;
}

/* ─────────── the tags a retail dump carries ─────────── */

/** the regions No-Intro and Redump name their dumps by */
const LIST_REGIONS = new Set([
  "USA", "Europe", "Japan", "World", "Asia", "Australia", "Brazil", "Canada", "China", "France", "Germany", "Hong Kong", "Italy", "Korea",
  "Netherlands", "Spain", "Sweden", "Taiwan", "UK", "Russia", "Scandinavia", "Latin America", "Greece", "Portugal", "Poland", "Denmark",
  "Finland", "Norway", "Belgium", "Austria", "Switzerland", "India", "Israel", "Mexico", "Argentina", "South Africa", "New Zealand",
  "Turkey", "Czech", "Hungary", "Croatia", "Ireland", "Singapore", "Thailand", "Malaysia", "Indonesia", "Philippines",
  "United Arab Emirates", "Saudi Arabia", "Chile", "Colombia", "Peru", "Ukraine", "Middle East",
]);
const LANGUAGES = /^[A-Z][a-z](?:-[A-Z][A-Za-z]+)?(?:[,+][A-Z][a-z](?:-[A-Z][A-Za-z]+)?)*$/;
/** the game as it was sold, again: a revision, a version, an alternate dump, the first disc, a budget or limited
 *  re-release, a console's own re-release service */
const RETAIL_TAG: RegExp[] = [
  /^Rev [0-9A-Z.]+$/, /^v\d+(?:\.\d+)*[a-z]?$/i, /^Alt(?: \d+)?$/, /^Dis[ck] (?:1|A)$/, /^EDC$/,
  /^(?:Wii |3DS |Wii U )?Virtual Console$/, /^Switch Online$/, /^Rerelease$/, /^Reprint$/,
  /\bbest\b/i, /\bhits!?$/i, /\bclassics$/i, /\bchoice$/i, /^Platinum\b/, /^PSone Books$/, /^Major Wave$/, /^Essentials$/, /^Nintendo Selects$/,
  /^(?:Shokai )?(?:Gentei|Genteiban|Seisanban|Gentei Seisanban)$/, /^Shokai (?:SP )?Genteiban(?: [A-Z]-Type)?$/, /^Tokubetsuban$/, /^Doukonban$/,
  /^(?:Limited|Collector's|Special|Premium|Deluxe|Anniversary) Edition$/, /^(?:Premium|Limited|Deluxe|DX|Gentei DX) (?:Box|Pack|Package|Set)$/,
  /^Controller Set$/, /^Limited Run Games$/, /^Evercade$/,
];
/** is every tag of this list entry's name one a retail dump carries (its region, languages, revision …)? */
export function retailTags(name: string): boolean {
  for (const m of name.matchAll(/\(([^()]*)\)|\[([^\]]*)\]/g)) {
    if (m[2] !== undefined) { if (m[2] !== "!") return false; continue; }      // GoodTools' [!] is a verified dump; any other code is not
    const t = m[1].trim();
    if (t.split(/,\s*/).every(p => LIST_REGIONS.has(p))) continue;
    if (LANGUAGES.test(t)) continue;
    if (RETAIL_TAG.some(re => re.test(t))) continue;
    return false;
  }
  return true;
}

/* ─────────── is it the same game ─────────── */

const words = (s: string) => normName(s).split(" ").filter(Boolean);

/**
 * The same game: the same name, or one name the other's subtitle ("Majora's Mask" for "The Legend of Zelda: Majora's
 * Mask"): its last words, two at least and a fair part of it. A name the other only starts with is another game ("Sonic
 * the Hedgehog" and "Sonic the Hedgehog 2"), and a lone word ("Zelda") pairs nothing.
 */
export function sameGame(names: string[], others: string[]): boolean {
  const a = names.map(words).filter(w => w.length), b = others.map(words).filter(w => w.length);
  const subtitle = (long: string[], short: string[]) =>
    short.length >= 2 && short.length < long.length && short.length / long.length >= 0.3 && short.every((w, j) => long[long.length - short.length + j] === w);
  return a.some(x => b.some(y => x.join(" ") === y.join(" ") || subtitle(x, y) || subtitle(y, x)));
}

/** a library game's names: its own, then its other names */
export const gameNames = (g: GameRow) => [g.name, ...gameAliases(g)];
