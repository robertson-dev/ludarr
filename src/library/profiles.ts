/**
 * ludarr — profiles: what a game may be grabbed as, in which order, and what counts as good enough.
 * Where *arr has quality profiles, games have install formats: a clean copy (home rip / DRM-free / GOG)
 * imports without running anything; a scene ISO or repack has to be installed under wine first.
 */
import { stmts, type GameRow, type PackageRow, type ProfileRow } from "../db";
import { parseTitle } from "../releases";

/** "way": a package built from a runtime plan (src/ways); "uploaded": the copy the admin uploaded from their own PC
 *  (src/uploads.ts) — neither is a release format, so they are not on INSTALL_CLASSES */
export type InstallClass = "clean" | "iso" | "unknown" | "repack" | "installer" | "rom" | "way" | "uploaded";
export const INSTALL_CLASSES: { value: InstallClass; label: string; doc: string }[] = [
  { value: "clean", label: "Clean copy", doc: "home rip, DRM-free, GOG / Humble / itch: imports by extraction alone" },
  { value: "iso", label: "Scene ISO", doc: "a disc image with an installer and the group's crack; installed under wine" },
  { value: "unknown", label: "Unknown format", doc: "nothing in the title says what it is" },
  { value: "repack", label: "Repack", doc: "recompressed installers (FitGirl, DODI …); slow to install" },
  { value: "installer", label: "Bare installer", doc: "an installer without a known recipe" },
  { value: "rom", label: "Console dump", doc: "a disc image, package or cartridge dump for a console: unpacked as it is — the fallback when no PC version exists. A way to play's game file is looked for whatever this says: it is built into the way, never kept as the copy" },
];
export type RouteKind = "native" | "recomp" | "port" | "emulated";
export type ProtocolPref = "any" | "prefer-usenet" | "prefer-torrent" | "usenet" | "torrent";

export interface Profile {
  id: number; name: string;
  /** formats allowed, best first (what is not listed is never grabbed as the game's copy; a way to play's game file is
   *  looked for either way, src/ways/find.ts) */
  formats: InstallClass[];
  /** the format that ends the search; a worse copy is kept only while nothing better exists (when upgrades are on) */
  cutoff: InstallClass;
  upgrade: boolean;
  protocol: ProtocolPref;
  /** ways to play allowed, best first — used once non-native routes are installable */
  kinds: RouteKind[];
  maxSizeGb: number | null;
  minSeeders: number;
  /** words (case-insensitive) a release title must / must not contain */
  mustContain: string[];
  mustNotContain: string[];
  preferredGroups: string[];
  blockedGroups: string[];
  /** ranking score (0–100) under which a release is never grabbed automatically */
  minScore: number;
  /** when no PC version can be found: take the best dump for a console the game is on (any console when unknown) and unpack it as it is.
   *  A way to play's game file (src/ways/find.ts) is no copy of the game: it is looked for either way, and built into the way */
  consoleFallback: boolean;
}

export const DEFAULT_PROFILE: Omit<Profile, "id"> = {
  name: "Standard", formats: ["clean", "iso", "unknown", "repack", "installer", "rom"], cutoff: "clean", upgrade: false, protocol: "prefer-usenet",
  kinds: ["native", "recomp", "port", "emulated"], maxSizeGb: null, minSeeders: 0, mustContain: [], mustNotContain: [], preferredGroups: [], blockedGroups: [], minScore: 70,
  consoleFallback: true,
};

export class ProfileError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[,\n]/) : []).map(s => s.trim()).filter(Boolean);

export function parseProfile(r: ProfileRow): Profile {
  let s: Partial<Profile> = {};
  try { s = JSON.parse(r.settings_json); } catch { /* defaults */ }
  const consoleFallback = s.consoleFallback !== false;
  let formats = (list(s.formats) as InstallClass[]).filter(f => INSTALL_CLASSES.some(c => c.value === f));
  if (!formats.length) formats = [...DEFAULT_PROFILE.formats];
  // the console dump is the fallback format: on the list (last, unless placed) while the fallback is on, off it otherwise
  if (consoleFallback && !formats.includes("rom")) formats.push("rom");
  if (!consoleFallback) formats = formats.filter(f => f !== "rom");
  return {
    id: r.id, name: r.name, formats, consoleFallback,
    cutoff: INSTALL_CLASSES.some(c => c.value === s.cutoff) ? (s.cutoff as InstallClass) : DEFAULT_PROFILE.cutoff,
    upgrade: !!s.upgrade, protocol: (["any", "prefer-usenet", "prefer-torrent", "usenet", "torrent"].includes(String(s.protocol)) ? s.protocol : "prefer-usenet") as ProtocolPref,
    kinds: (list(s.kinds) as RouteKind[]).filter(k => ["native", "recomp", "port", "emulated"].includes(k)).length ? (list(s.kinds) as RouteKind[]) : DEFAULT_PROFILE.kinds,
    maxSizeGb: s.maxSizeGb == null || s.maxSizeGb === ("" as unknown) ? null : Number(s.maxSizeGb) || null,
    minSeeders: Math.max(0, Number(s.minSeeders) || 0), mustContain: list(s.mustContain), mustNotContain: list(s.mustNotContain),
    preferredGroups: list(s.preferredGroups), blockedGroups: list(s.blockedGroups), minScore: Math.min(100, Math.max(0, Number(s.minScore ?? 70))),
  };
}

export const profiles = () => (stmts.profiles.all() as ProfileRow[]).map(parseProfile);
export const profile = (id: number) => { const r = stmts.profile.get(id) as ProfileRow | undefined; return r ? parseProfile(r) : undefined; };

export function ensureDefaultProfile() {
  if (!(stmts.profiles.all() as ProfileRow[]).length) stmts.insertProfile.run(DEFAULT_PROFILE.name, JSON.stringify(DEFAULT_PROFILE));
}

export function createProfile(body: Partial<Profile>): Profile {
  const name = String(body.name ?? "").trim();
  if (!name) throw new ProfileError("a name is required");
  try { return parseProfile(stmts.insertProfile.get(name, JSON.stringify({ ...DEFAULT_PROFILE, ...body, name })) as ProfileRow); }
  catch (e: any) { throw new ProfileError(/UNIQUE/.test(String(e?.message)) ? "a profile with that name exists" : String(e?.message ?? e), 409); }
}
export function updateProfile(id: number, body: Partial<Profile>): Profile {
  const cur = profile(id);
  if (!cur) throw new ProfileError("no such profile", 404);
  const next = { ...cur, ...body, id, name: String(body.name ?? cur.name).trim() || cur.name };
  return parseProfile(stmts.updateProfile.get(next.name, JSON.stringify(next), id) as ProfileRow);
}
export function deleteProfile(id: number) {
  if (!profile(id)) throw new ProfileError("no such profile", 404);
  if (profiles().length <= 1) throw new ProfileError("the last profile cannot be deleted", 409);
  const n = (stmts.gamesUsingProfile.get(id) as { n: number }).n;
  if (n) throw new ProfileError(`${n} game${n === 1 ? " uses" : "s use"} this profile`, 409);
  stmts.deleteProfile.run(id);
}

/** the install format of an imported copy, judged from the release it came from (a hand-imported folder has no release);
 *  a way built from a plan (manifest kind recomp, port or emulated) is 'way' */
export function classOfPackage(pkg: Pick<PackageRow, "manifest_json">): InstallClass {
  let title = "";
  try {
    const m = JSON.parse(pkg.manifest_json);
    if (m?.kind === "rom") return "rom";
    if (m?.kind === "recomp" || m?.kind === "port" || m?.kind === "emulated") return "way";
    if (m?.source?.protocol === "upload") return "uploaded";
    title = m?.source?.protocol ? m.source.title ?? "" : "";
  } catch { /* none */ }
  if (!title) return "unknown";
  const p = parseTitle(title);
  const f = (p.format ?? "").toLowerCase(), t = title.toLowerCase();
  if (/home rip|drm.?free/.test(f) || /\b(gog|humble|drm.?free|itch)\b/.test(t)) return "clean";
  if (/full iso/.test(f) || p.scene) return "iso";
  if (p.repack) return "repack";
  return "unknown";
}
/** is a copy of this format worth replacing under the profile? (upgrades on, and the copy is worse than the cutoff); a
 *  built way never is: a release would replace the player's working recomp, port or emulator with something else. Nor is
 *  the copy the admin uploaded: it goes only for a release they pick themselves, or another upload */
export function wantsUpgrade(profile: Profile, current: InstallClass): boolean {
  if (current === "way" || current === "uploaded") return false;
  return profile.upgrade && profile.formats.indexOf(current) > profile.formats.indexOf(profile.cutoff);
}

/** a game's profile, else the first one */
export function profileFor(game?: Pick<GameRow, "profile_id"> | null): Profile {
  return (game?.profile_id ? profile(game.profile_id) : undefined) ?? profiles()[0] ?? { id: 0, ...DEFAULT_PROFILE };
}
