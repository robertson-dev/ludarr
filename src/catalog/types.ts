/**
 * ludarr — the catalog's vocabulary: every game ludarr can offer, however it is played on a Windows PC.
 *
 *   Title    the game itself, independent of platform ("The Legend of Zelda: Majora's Mask")
 *   Route    one way to play it on this PC: the Steam/GOG release (native), a static recompilation
 *            (Zelda64Recomp), a decompilation-based source port (2 Ship 2 Harkinian), or an emulator (shadPS4)
 *            — plus where it comes from (retail copy, leaked build, prototype …)
 *   Runtime  what a non-native route runs on: a recomp/port build or an emulator, with its latest Windows release
 *   Provider a source that contributes titles + routes (Steam feeds, the curated port registry, emulator
 *            compatibility lists, release feeds). Providers hand in full snapshots; the catalog merges them.
 */

/** platform slugs: the platform the game *data* comes from */
export const PLATFORMS = {
  pc: "PC", dos: "DOS",
  nes: "NES", snes: "SNES", n64: "Nintendo 64", gc: "GameCube", wii: "Wii", wiiu: "Wii U", switch: "Switch", switch2: "Switch 2",
  gb: "Game Boy", gbc: "Game Boy Color", gba: "Game Boy Advance", nds: "Nintendo DS", "3ds": "Nintendo 3DS",
  ps1: "PlayStation", ps2: "PlayStation 2", ps3: "PlayStation 3", ps4: "PlayStation 4", ps5: "PlayStation 5", psp: "PSP", vita: "PS Vita",
  xbox: "Xbox", x360: "Xbox 360", xone: "Xbox One", xsx: "Xbox Series X|S",
  genesis: "Mega Drive / Genesis", saturn: "Saturn", dc: "Dreamcast", arcade: "Arcade",
} as const;
export type Platform = keyof typeof PLATFORMS;
export const isPlatform = (s: unknown): s is Platform => typeof s === "string" && s in PLATFORMS;

/** how the game runs on Windows */
export type RouteKind = "native" | "recomp" | "port" | "emulated";
export const ROUTE_KINDS: RouteKind[] = ["native", "recomp", "port", "emulated"];
/** where the build comes from — orthogonal to how it runs (a leaked Switch game is still "emulated") */
export type Provenance = "retail" | "leak" | "prototype" | "beta" | "demo";
export const PROVENANCES: Provenance[] = ["retail", "leak", "prototype", "beta", "demo"];

/** one ladder for every emulator's compatibility vocabulary (best first); native routes leave it null */
export type Status = "perfect" | "playable" | "ingame" | "intro" | "menus" | "boots" | "nothing" | "unknown";
export const STATUS_ORDER: Status[] = ["perfect", "playable", "ingame", "intro", "menus", "boots", "nothing", "unknown"];
export const statusRank = (s: Status | null | undefined) => (s ? STATUS_ORDER.indexOf(s) : STATUS_ORDER.length);

/** id schemes the outside world uses for a title — the catalog resolves contributions through them */
export type IdScheme = "steam" | "igdb" | "gog" | "serial" | "titleid" | "rom_sha1" | "rom_md5" | "registry" | "gametdb";
export interface ExtId { scheme: IdScheme; value: string }

/** where a piece of a route comes from */
export type From =
  | { type: "tracker"; query?: string; categories?: number[]; note?: string }   // Prowlarr search (the request pipeline)
  | { type: "release"; indexerId?: number; guid?: string; title: string; size?: number | null; url?: string } // one known release (leaks, scene posts)
  | { type: "github"; repo: string; asset?: string }                              // a GitHub release asset
  | { type: "url"; url: string }
  | { type: "user"; hint: string }                                                // only the user can supply it
  | { type: "bundled" };                                                          // ships with the runtime

/** the game data a route needs and what counts as the right copy */
export interface ContentSpec {
  kind: "none" | "rom" | "disc" | "pkg" | "files";
  platform: Platform;
  accept?: {
    /** every hash a project documents for the copy it accepts — ports check different ones (XXH3-64, SHA-1, CRC32C, MD5, SHA-256 …) */
    hashes?: { algo: "sha1" | "md5" | "sha256" | "crc32" | "crc32c" | "xxh3-64" | "xxh3-128" | "xxh64"; value: string; label?: string; of?: string }[];
    sha1?: string[]; md5?: string[]; serials?: string[]; regions?: string[]; formats?: string[]; version?: string; note?: string;
  };
  /** where it goes inside the installed folder (relative to the runtime), when the runtime looks for it there */
  place?: string;
  from: From[];
}

/** anything else the route needs before it runs: console firmware, keys, a BIOS, an asset-extraction step */
export interface Need { kind: "firmware" | "keys" | "bios" | "extract" | "other"; name: string; note?: string; from: From[] }

/** how the launcher starts it — {runtime} = the runtime's folder, {content} = the game data's path */
export interface LaunchSpec { exe: string; args?: string[]; cwd?: string }

export interface TitleMeta {
  summary: string | null; developer: string | null; publisher: string | null; genres: string[];
  cover: string | null; hero: string | null; logo: string | null; screenshots: string[];
}

/** what a provider says about one title */
export interface TitleInput {
  ids: ExtId[];
  name: string;
  aliases?: string[];
  platforms?: Platform[];               // the title's original platforms
  year?: number | null;
  releaseIso?: string | null;
  meta?: Partial<TitleMeta>;
  /** the library row for it, when a built-in provider knows it */
  gameId?: number;
}

export interface RouteInput {
  /** the provider's own stable key for this route (idempotent upserts, stale removal) */
  key: string;
  kind: RouteKind;
  platform: Platform;
  provenance?: Provenance;
  runtime?: string | null;               // runtimes.id
  label?: string | null;                 // "Zelda64Recomp", "shadPS4", "Steam"
  status?: Status | null;
  statusNote?: string | null;
  statusAt?: number | null;              // unix seconds: when it was last tested / reported
  content?: ContentSpec | null;
  needs?: Need[];
  features?: string[];                   // "60 fps", "widescreen", "mods", "ray tracing" …
  launch?: LaunchSpec | null;
  link?: string | null;                  // a page about this route (project page, compat report, store page)
}

export interface Contribution { title: TitleInput; routes: RouteInput[] }

/** asset.digest is the host's own checksum as it gives it ("sha256:<hex>" on GitHub; absent elsewhere); immutable is
 *  GitHub's immutable-release flag (its assets can no longer be replaced under the same tag); both are optional */
export interface RuntimeRelease { tag: string; name: string | null; date: string | null; prerelease: boolean; asset: { name: string; url: string; size: number; digest?: string | null } | null; page: string | null; immutable?: boolean | null }
export interface RuntimeInput {
  id: string;                            // "zelda64recomp", "shadps4"
  name: string;
  kind: "recomp" | "port" | "emulator";
  platforms: Platform[];                 // what it plays
  homepage?: string | null;
  repo?: string | null;                  // GitHub "owner/name"
  assetPattern?: string | null;          // regex (source) for the Windows x64 release asset
  channel?: "stable" | "nightly" | "seed"; // which releases count; "seed" = the provider supplies `latest`, never checked
  notes?: string | null;                 // how content is placed, portable mode, first run …
  launch?: LaunchSpec | null;            // default launch for routes on this runtime
  /** the provider already knows the latest release (no GitHub call needed) */
  latest?: RuntimeRelease | null;
}

export interface ProviderCtx { log: (line: string) => void; signal?: AbortSignal; fetch: typeof fetch }
export interface Provider {
  id: string;
  label: string;
  /** what it contributes, in a sentence for the Ship page */
  about: string;
  /** how often to re-collect (minutes) */
  every: number;
  /** how much its metadata (names, art, summaries) should win over other providers' (0–100) */
  metaRank: number;
  /** false when it lacks configuration; the reason is shown instead of running */
  ready?: () => true | string;
  runtimes?: () => RuntimeInput[];
  collect: (ctx: ProviderCtx) => Promise<Contribution[]>;
}
