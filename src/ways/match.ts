/**
 * ludarr — does this game file (or system file) satisfy what a way (or one of its plan's needs) asks for? Pure checks
 * over stored hashes and the file's identity (src/ways/identity.ts), so the API, the assemble job and the content job all
 * judge a file the same way. A wrong file is worse than none: when a plan lists hashes, one of them must match exactly
 * (normalised bytes, or as received); when it lists no hashes but serials, a serial or game code read from the file must
 * be one of them — a file whose header carries none (a .chd, a cartridge without a game code) is not refused for that,
 * but nothing proves it either. Only a proven file is ever taken by itself (proven()); the header's title never proves
 * anything.
 *
 * The game's data may be one file or one folder (a content plan of kind 'folder'), and a way may also name the versions
 * it takes (compared by number: 01.007.000 = 1.07), what the data must be (the game, never its update or an add-on, unless
 * the plan says otherwise) and the program builds it takes (a Switch title's main build id, matched as a prefix). Data
 * encrypted for the console (a retail PS5 disc as a PC drive reads it, an NSP) is refused; only a Switch NSP or XCI is
 * taken as it is, by a plan that names that very format (an emulator opens it with its player's own keys: ludarr never
 * does). What a reader could not tell (no identity, no version, no build) never refuses: the file is simply not
 * proven, so it waits for the admin ("accept it if it is"); only another title, another version, another build, a patch or
 * an add-on, or sealed data refuses.
 *
 * A make's input (what a game file is made from) is judged by inputMatches() the same way, over its shape, console,
 * formats, serials, versions, regions and category; what must be inside it is judged by the make itself.
 */
import { PLATFORM_LABEL, type PlatformId } from "../platforms";
import { hasReader, identityKeys, NAMED, serialKeys, serialWord, shownSerial, type Identity } from "./identity";
import { regionName, sameVersion, shownVersion, versionKind } from "./readers/titles";
import type { AcceptHash, ContentPlan, Hashes, MakeInput, NeedSlot, RuntimePlanSpec } from "./types";

export { sameVersion, shownVersion } from "./readers/titles";

/** shape: a file, or a folder (a game folder kept as a tree; its hashes are of its canonical listing) */
export interface FileFacts { platform: string | null; name: string; size: number; hashes: Hashes; rawHashes?: Hashes | null; identity?: Identity | null; shape?: "file" | "folder" }
/** `matched`: the hash that proved it; `serial`: the accepted serial its identity matched; `version` / `build`: the accepted
 *  version and build its identity matched; `unchecked`: what could not be checked (the file is not refused for it, and is
 *  not proven either) */
export interface Verdict { ok: boolean; why: string | null; matched?: AcceptHash; serial?: string; version?: string; build?: string; unchecked?: string }

const ext = (name: string) => (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
/** a file's format, a multi-volume archive's included (game.7z.001 is a 7z, game.part02.rar and game.r00 are a rar) */
export function formatOf(name: string): string {
  const n = name.toLowerCase();
  const vol = /\.(7z|zip|rar)\.\d{3}$/.exec(n);
  if (vol) return vol[1];
  if (/\.part\d+\.rar$/.test(n) || /\.r\d{2}$/.test(n)) return "rar";
  if (/\.z\d{2}$/.test(n)) return "zip";
  return ext(n);
}
const label = (p: string) => PLATFORM_LABEL[p as PlatformId] ?? p;
const listWords = (xs: string[], last = "or") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${last} ${xs[xs.length - 1]}`);
const formatWords = (formats: string[]) => formats.map(x => "." + x).join(", ");

function hashVerdict(accept: AcceptHash[], f: FileFacts, what: string): Verdict {
  for (const h of accept) {
    const mine = f.hashes[h.algo], raw = f.rawHashes?.[h.algo];
    if ((mine && mine === h.value) || (raw && raw === h.value)) return { ok: true, why: null, matched: h };
  }
  const shown = accept.find(h => f.hashes[h.algo]) ?? accept[0];
  const has = f.hashes[shown.algo];
  return { ok: false, why: `not the ${what} this needs${has ? ` (its ${shown.algo} is ${has})` : ""}` };
}

/** what a reader that found nothing says, for a format or folder it can read; null when no reader looks at such data (a
 *  packed game such as a .zar or a .nup is a game, not a disc, whatever the way's kind) */
function silence(platform: string, f: FileFacts, kind: ContentPlan["kind"] | "input"): string | null {
  if (f.identity || !hasReader(platform, { name: f.name, shape: f.shape })) return null;
  const what = f.shape === "folder" || kind === "folder" ? "game folder" : kind === "disc" && !PACKED.has(ext(f.name)) ? "disc" : "game";
  return `nothing in it reads as a ${label(platform)} ${what}`;
}
const PACKED = new Set(["zar", "nup", "nsp", "nsz", "xci", "xcz"]);

/** the file's serial (or game id, or game code) against the serials a way accepts */
function serialVerdict(serials: string[], f: FileFacts, platform: string, kind: ContentPlan["kind"] | "input"): Verdict {
  const mine = identityKeys(f.identity);
  if (!mine.length) return { ok: true, why: null, unchecked: silence(platform, f, kind) ?? (f.identity ? `its header carries no ${serialWord(platform)}` : "no serial can be read from it") };
  for (const s of serials) if (serialKeys(platform, s).some(k => mine.includes(k))) return { ok: true, why: null, serial: s };
  const more = serials.length > 3 ? ` or ${serials.length - 3} more` : "";
  return { ok: false, why: `another game (its ${serialWord(platform)} is ${shownSerial(f.identity)}, and this takes ${serials.slice(0, 3).join(", ")}${more})` };
}

/** the data's own version against the versions a way accepts, by number; a version of another kind of number (a Switch
 *  title version against dotted ones) is not compared */
function versionVerdict(versions: string[], f: FileFacts): Verdict {
  const v = f.identity?.version;
  if (!v) return { ok: true, why: null, unchecked: "its version cannot be read" };
  const hit = versions.find(a => sameVersion(a, v));
  if (hit) return { ok: true, why: null, version: hit };
  if (!versions.some(a => versionKind(a) === versionKind(v))) return { ok: true, why: null, unchecked: `its version ${v} is not the kind of number this way names (${versions.join(", ")})` };
  return { ok: false, why: `version ${shownVersion(v)}, and this takes ${listWords(versions.map(shownVersion))}` };
}

/** the program's build (a Switch title's main build id) against the builds a way accepts, as a prefix of 8 digits or more */
function buildVerdict(builds: string[], f: FileFacts): Verdict {
  const b = f.identity?.build?.toLowerCase();
  if (!b) return { ok: true, why: null, unchecked: "its program's build cannot be read" };
  const hit = builds.find(a => a.length >= 8 && b.startsWith(a.toLowerCase()));
  if (hit) return { ok: true, why: null, build: hit };
  return { ok: false, why: `another build of the game (its main program is build ${b.slice(0, 8)}…, and this takes ${listWords(builds.map(x => x.slice(0, 8) + "…"))})` };
}

const CATEGORY_WORDS: Record<NonNullable<Identity["category"]>, string> = {
  game: "the game itself", patch: "an update of the game, not the game itself", addon: "an add-on, not the game", app: "an application, not a game",
};
/** what the data is against what the way takes (the game, unless it says a patch or an add-on) */
function categoryVerdict(want: "game" | "patch" | "addon", id: Identity | null | undefined): Verdict | null {
  const c = id?.category;
  if (!c || c === want) return null;
  return { ok: false, why: want === "game" ? CATEGORY_WORDS[c] : `${CATEGORY_WORDS[c]}, and this takes ${want === "patch" ? "its update" : "an add-on"}` };
}

/** why encrypted data cannot be used: the words the admin reads (a PS5 disc: "the retail disc as a PC drive reads it (US,
 *  PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it") */
export function sealedWhy(id: Identity): string {
  const facts = [id.region, id.serial, id.version ?? id.masterVersion ? shownVersion(id.version ?? id.masterVersion) : undefined].filter(Boolean).join(", ");
  const said = facts ? ` (${facts})` : "";
  if (id.shape === "bd-image") return `the retail disc as a PC drive reads it${said}: its game data is encrypted for the console, and nothing can open it`;
  if (id.shape === "nsp" || id.shape === "xci") return `a Switch ${id.shape === "nsp" ? "package (NSP)" : "game card image (XCI)"}${said}: its game data requires matching keys and a plan that processes this format`;
  return `encrypted for the console${said}, and nothing can open it`;
}

/** sealed data a plan still takes as it is: a Switch NSP or XCI (an emulator or a server-side build opens it with matching keys) when the
 *  plan names that very format; a console's retail disc image never (nothing opens it, so it is no game for anyone) */
export const takenSealed = (id: Identity, shape: "file" | "folder", formats: string[], e: string) =>
  (id.shape === "nsp" || id.shape === "xci") && shape === "file" && formats.includes(e);

/** A declared file format is handed to the recipe's own reader/extractor. Encryption is not an identity failure;
 *  the tool must open it, and the resulting game data must still pass the product checks. */
export const takesMakeFile = (input: MakeInput, shape: "file" | "folder", name: string): boolean =>
  shape === "file" && input.shape !== "folder" && (input.formats ?? []).some(f => f.toLowerCase().replace(/^\./, "") === formatOf(name));

/** the platform a file is for: what its bytes name beyond doubt, else what it was stored as */
const platformOf = (f: FileFacts) => (f.identity && NAMED.has(f.identity.platform) ? f.identity.platform : f.platform);
/** soft notes joined */
const notes = (xs: (string | undefined)[]) => xs.filter(Boolean).join("; ") || undefined;
/** a verdict with only the fields that hold something (so it compares and serializes cleanly) */
const verdict = (v: Verdict): Verdict => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as unknown as Verdict;

/** a game file against a way's content plan */
export function contentMatches(c: ContentPlan, f: FileFacts): Verdict {
  const fp = platformOf(f);
  if (c.platform && fp && c.platform !== fp) return { ok: false, why: `a ${fp} file, and this needs a ${c.platform} one` };
  const shape = f.shape ?? "file";
  if (c.kind === "folder" && shape !== "folder") return { ok: false, why: `one file, and this needs the game folder${c.marker ? ` (holding ${c.marker})` : ""}` };
  const formats = c.accept.formats ?? [];
  if (c.kind !== "folder" && shape === "folder") return { ok: false, why: `a folder, and this needs one ${formats.length ? formatWords(formats) : "game"} file` };
  const e = ext(f.name);
  if (f.identity?.sealed && !takenSealed(f.identity, shape, formats, e)) return { ok: false, why: sealedWhy(f.identity) };
  if (shape === "file" && formats.length && !formats.includes(e)) return { ok: false, why: `a .${e || "?"} file, and this needs ${formatWords(formats)}` };
  const cat = categoryVerdict(c.accept.category ?? "game", f.identity);
  if (cat) return cat;
  if (c.accept.hashes.length) return hashVerdict(c.accept.hashes, f, "version");
  const serials = c.accept.serials ?? [], versions = c.accept.versions ?? [], builds = c.accept.builds ?? [];
  const s = serials.length ? serialVerdict(serials, f, c.platform, c.kind) : null;
  if (s && !s.ok) return s;
  const v = versions.length ? versionVerdict(versions, f) : null;
  if (v && !v.ok) return v;
  const b = builds.length ? buildVerdict(builds, f) : null;
  if (b && !b.ok) return b;
  const quiet = !s && !v && !b ? silence(c.platform, f, c.kind) ?? undefined : undefined;
  return verdict({ ok: true, why: null, serial: s?.serial, version: v?.version, build: b?.build, unchecked: notes([s?.unchecked, v?.unchecked, b?.unchecked, quiet]) });
}

/**
 * Whether a kept file or folder (its facts) is what a make takes as its input: its shape and console, that its identity
 * uses a declared file format when encrypted, then its category, serial, version and region, each against
 * make.input as contentMatches judges a game file (what could not be read does not refuse it; the make judges the input
 * fully, marker and completeness included, before its first step).
 */
export function inputMatches(input: MakeInput, f: FileFacts): Verdict {
  const shape = f.shape ?? "file";
  const formats = (input.formats ?? []).map(x => x.toLowerCase().replace(/^\./, ""));
  if (input.shape === "folder" && shape !== "folder") return { ok: false, why: `one file, and this is made from the game folder${input.marker ? ` (holding ${input.marker})` : ""}` };
  if (input.shape === "file" && shape === "folder") return { ok: false, why: `a folder, and this is made from one ${formats.length ? formatWords(formats) : ""} file`.replace("  ", " ") };
  const fp = platformOf(f);
  if (input.platform && fp && input.platform !== fp) return { ok: false, why: `a ${fp} file, and this is made from a ${input.platform} one` };
  const id = f.identity ?? null;
  if (id?.sealed && !takesMakeFile(input, shape, f.name)) return { ok: false, why: sealedWhy(id) };
  if (shape === "file" && formats.length && !formats.includes(formatOf(f.name))) return { ok: false, why: `a .${formatOf(f.name) || "?"} file, and this is made from ${formatWords(formats)}${input.shape === "either" ? " or the game folder" : ""}` };
  const cat = categoryVerdict(input.category ?? "game", id);
  if (cat) return cat;
  const s = input.serials?.length ? serialVerdict(input.serials, f, input.platform, "input") : null;
  if (s && !s.ok) return s;
  const v = input.versions?.length ? versionVerdict(input.versions, f) : null;
  if (v && !v.ok) return v;
  let region: string | undefined;
  if (input.regions?.length) {
    const want = input.regions.map(r => regionName(r) ?? r.toUpperCase());
    const mine = id?.region ? regionName(id.region) ?? id.region.toUpperCase() : null;
    if (!mine) region = "its region cannot be read";
    else if (mine !== "WORLD" && !want.includes("WORLD") && !want.includes(mine)) return { ok: false, why: `a ${mine} copy, and this is made from ${listWords(want)} copies` };
  }
  return verdict({ ok: true, why: null, serial: s?.serial, version: v?.version, unchecked: notes([s?.unchecked, v?.unchecked, region]) });
}

/** did the check prove the file is the one asked for (a hash, a serial or a build matched), rather than find nothing
 *  against it; a version alone proves nothing (1.07 of what?) */
export const proven = (v: Verdict): boolean => v.ok && (!!v.matched || !!v.serial || !!v.build);
/** can a way's content plan prove a file by itself (it lists hashes, serials or builds) */
export const checksFiles = (c: ContentPlan): boolean => c.accept.hashes.length > 0 || (c.accept.serials ?? []).length > 0 || (c.accept.builds ?? []).length > 0;

/** a system file against one of the plan's needs */
export function needMatches(n: NeedSlot, f: FileFacts): Verdict {
  const formats = n.accept?.formats ?? [];
  if (formats.length && !formats.includes(ext(f.name))) return { ok: false, why: `a .${ext(f.name) || "?"} file, and ${n.name} is ${formats.map(x => "." + x).join(", ")}` };
  const sizes = n.accept?.sizes ?? [];
  if (sizes.length && !sizes.includes(f.size)) return { ok: false, why: `${f.size} bytes, and ${n.name} is ${sizes.join(" or ")} bytes` };
  if (n.accept?.hashes?.length) return hashVerdict(n.accept.hashes, f, n.name);
  return { ok: true, why: null };
}

/** which of a plan's needs have a matching system file (`files` = the plan's system files, by need_index) */
export function needsMet(spec: RuntimePlanSpec, files: (FileFacts & { needIndex: number | null })[]): { met: boolean; missing: { index: number; name: string; why: string | null }[] } {
  const missing: { index: number; name: string; why: string | null }[] = [];
  spec.needs.forEach((n, i) => {
    const mine = files.filter(f => f.needIndex === i);
    if (!mine.length) { missing.push({ index: i, name: n.name, why: null }); return; }
    const v = mine.map(f => needMatches(n, f));
    if (!v.some(x => x.ok)) missing.push({ index: i, name: n.name, why: v[0].why });
  });
  return { met: missing.length === 0, missing };
}
