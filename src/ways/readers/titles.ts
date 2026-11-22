/**
 * ludarr — what a PlayStation title id, a content id or a version string says, as data the readers and match.ts share:
 *
 *   console   the title id's prefix names the console beyond doubt: a PS5 app's own title id is PPSA…, a PS4 app's CUSA…,
 *             a Vita app's PCS[A-H]…, a PS3 disc's B[LC]xx… (PSN NPxA / NPxB), a PSP UMD's U[LC]xx… (PSN NPxG / NPxH)
 *   region    a content id's first two letters (UP9000-… is the American store, EP the European one, JP, HP Asia, KP Korea);
 *             a PS3 or PSP serial's third letter (BLUS, ULES, NPJB …)
 *   versions  compared by number: "01.007.000" = "1.07" = "1.7" (leading zeros and trailing zero parts dropped); a Switch
 *             title version ("v196608") is another kind of number and is compared only with its own kind
 *
 * Region names are the ones src/ways/names.ts writes (US, EU, JP, ASIA, KR, …). This file is a leaf: match.ts reads it
 * without pulling in the library (names.ts reaches the database through the catalog).
 */
import type { PlatformId } from "../../platforms";

/** title id prefixes, first match wins (the table is data, tested in tests/ways-readers.test.ts) */
export const TITLE_PREFIX: readonly [RegExp, PlatformId][] = [
  [/^PPS[AB]\d{5}$/, "ps5"],
  [/^(CUSA|PLAS|PLJM|PLJS|PCAS|PCJS|PCKS|PLKS)\d{5}$/, "ps4"],
  [/^(PCS[A-H]|V[LC][A-Z]{2})\d{5}$/, "vita"],
  [/^(B[LC][A-Z]{2}|NP[A-Z][AB])\d{5}$/, "ps3"],
  [/^(U[LC][A-Z]{2}|NP[A-Z][GHZ])\d{5}$/, "psp"],
];

/** "PPSA01342" (or "PPSA-01342") → its console; null when the prefix names none */
export function consoleOfTitle(id: string | null | undefined): PlatformId | null {
  const s = String(id ?? "").toUpperCase().replace(/[-_\s]/g, "");
  for (const [re, p] of TITLE_PREFIX) if (re.test(s)) return p;
  return null;
}
/** a title id as the data writes it, without separators: "PPSA-01342" → "PPSA01342" (null when it is no title id) */
export const titleIdOf = (id: unknown): string | null => {
  if (typeof id !== "string") return null;
  const s = id.toUpperCase().replace(/[-_\s]/g, "");
  return /^[A-Z]{4}\d{5}$/.test(s) ? s : null;
};

/** a content id: two letters, four digits, the title id, two digits, sixteen letters or digits (Kyty's pattern,
 *  src/libs/libAppContent.cpp:198) */
export const CONTENT_ID = /^([A-Z]{2})\d{4}-([A-Z]{4}\d{5})_\d{2}-[A-Z0-9]{16}$/;
const CONTENT_REGION: Record<string, string> = { UP: "US", EP: "EU", JP: "JP", HP: "ASIA", KP: "KR" };
/** the store a content id was made for, as a region */
export function regionOfContentId(cid: string | null | undefined): string | undefined {
  const m = CONTENT_ID.exec(String(cid ?? ""));
  return m ? CONTENT_REGION[m[1]] : undefined;
}
/** the title id inside a content id */
export const titleOfContentId = (cid: string | null | undefined): string | null => CONTENT_ID.exec(String(cid ?? ""))?.[2] ?? null;

const SERIAL_REGION: Record<string, string> = { U: "US", E: "EU", J: "JP", A: "ASIA", H: "ASIA", K: "KR" };
/** a PS3 or PSP serial's region: its third letter (BLUS → US, ULES → EU, NPJB → JP) */
export const regionOfSerial = (serial: string | null | undefined): string | undefined => SERIAL_REGION[String(serial ?? "").toUpperCase()[2] ?? ""];

/* ─────────── regions in any spelling ─────────── */

const REGION_SPELLING: Record<string, string> = {
  us: "US", usa: "US", u: "US", ntsc: "US", ntscu: "US", ntscuc: "US", na: "US", america: "US", northamerica: "US",
  eu: "EU", eur: "EU", e: "EU", europe: "EU", pal: "EU", uk: "EU",
  jp: "JP", jpn: "JP", jap: "JP", j: "JP", japan: "JP", ntscj: "JP",
  asia: "ASIA", as: "ASIA", hk: "ASIA", hongkong: "ASIA",
  kr: "KR", kor: "KR", korea: "KR", ntsck: "KR",
  world: "WORLD", w: "WORLD", au: "AU", australia: "AU", cn: "CN", china: "CN", tw: "TW", taiwan: "TW", br: "BR", brazil: "BR",
};
/** one name per region ("USA", "NTSC-U", "u" → US); null for a word that names none */
export const regionName = (s: string | null | undefined): string | null => REGION_SPELLING[String(s ?? "").toLowerCase().replace(/[^a-z]/g, "")] ?? null;

/* ─────────── versions by number ─────────── */

/** the kind of number a version is: a Switch title version ("v196608"), or digits and dots */
export const versionKind = (v: string): "title" | "dotted" | "other" => (/^v\d+$/i.test(v.trim()) ? "title" : /^\d+(\.\d+)*$/.test(v.trim()) ? "dotted" : "other");
/** a version as it is compared: numeric parts without leading zeros, trailing zero parts dropped ("01.007.000" → "1.7") */
export function versionKey(v: string): string {
  const t = v.trim().replace(/^v/i, "");
  const parts = t.split(".").map(p => (/^\d+$/.test(p) ? String(Number(p)) : p.toLowerCase()));
  while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
  return parts.join(".");
}
/** two versions name the same build of the game: same kind of number, same parts */
export const sameVersion = (a: string, b: string): boolean => versionKind(a) === versionKind(b) && versionKey(a) === versionKey(b);
/** a version as the admin reads it: a PlayStation "01.007.000" or "01.00" as 1.07 / 1.00, anything else as it is */
export function shownVersion(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const m = /^(\d{2})\.(\d{2,3})(?:\.(\d{3}))?$/.exec(s);
  if (!m) return s;
  const minor = String(Number(m[2])).padStart(2, "0");
  return `${Number(m[1])}.${minor}${m[3] && Number(m[3]) ? `.${Number(m[3])}` : ""}`;
}
