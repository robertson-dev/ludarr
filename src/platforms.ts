/**
 * ludarr — platform ids shared by everything that names a platform: metadata (IGDB abbreviations, Steam's
 * win/mac/lin), release titles (GazelleGames trailers "[PlayStation 5 / …]", scene tags "PS3", "NSW"),
 * newznab categories (1080 = PS3 …) and manifests. A PC game is "pc"; everything else is a console, and a
 * console dump is unpacked as it is — the fallback when no PC version of a game exists.
 */
export type PlatformId =
  | "pc" | "mac" | "linux"
  | "ps5" | "ps4" | "ps3" | "ps2" | "ps1" | "psp" | "vita"
  | "switch" | "switch2" | "wiiu" | "wii" | "gc" | "n64" | "snes" | "nes" | "gba" | "gbc" | "gb" | "nds" | "3ds"
  | "xsx" | "xone" | "x360" | "xbox" | "dc" | "saturn" | "genesis" | "arcade" | "android" | "ios";

const ALIASES: [RegExp, PlatformId][] = [
  [/^(pc|win|windows|win32|win64|dos|pc \(microsoft windows\)|microsoft windows)$/i, "pc"],
  [/^(mac|macos|macosx|macintosh|osx|os x|mac os x?|dmg|tnt)$/i, "mac"], [/^(lin|linux)$/i, "linux"],
  [/^(ps5|playstation ?5|ppsa\d{4,5})$/i, "ps5"], [/^(ps4|playstation ?4|cusa\d{4,5})$/i, "ps4"], [/^(ps3|playstation ?3|(?:bles|blus|bljm|bcus|bces|npub|npeb|npjb|npua|npea)\d{4,5})$/i, "ps3"], [/^(ps2|ps2dvd|ps2cd|playstation ?2)$/i, "ps2"],
  [/^(ps1|psx|psone|playstation(?: ?1)?)$/i, "ps1"], [/^(psp|playstation portable|psx2psp)$/i, "psp"], [/^(vita|psvita|ps vita|playstation vita)$/i, "vita"],
  [/^(?:ns2|nsw2|(?:nintendo )?switch ?2)$/i, "switch2"], [/^(switch|nsw|nsz|nintendo switch)$/i, "switch"], [/^(wiiu|wii u|wux|wua)$/i, "wiiu"], [/^wii$/i, "wii"], [/^(gc|ngc|gcn|gamecube|nintendo gamecube)$/i, "gc"],
  [/^(n64|nintendo 64)$/i, "n64"], [/^(snes|sfc|super nintendo.*|super famicom)$/i, "snes"], [/^(nes|famicom|nintendo entertainment system)$/i, "nes"],
  [/^(gba|game boy advance)$/i, "gba"], [/^(gbc|game boy color)$/i, "gbc"], [/^(gb|game boy)$/i, "gb"], [/^(nds|ds|nintendo ds)$/i, "nds"], [/^(3ds|n3ds|nintendo 3ds)$/i, "3ds"],
  [/^(xsx|xbsx|series x\|s|xbox series(?: x\|s| x| s)?)$/i, "xsx"], [/^(xone|xb1|xbox one)$/i, "xone"], [/^(x360|xbox ?360|xbla)$/i, "x360"], [/^(xbox|xb)$/i, "xbox"],
  [/^(dc|dreamcast)$/i, "dc"], [/^saturn$/i, "saturn"], [/^(genesis|mega ?drive|md)$/i, "genesis"], [/^(arcade|mame|fbneo|fb ?neo|fb ?alpha|coin-?op)$/i, "arcade"], [/^(android|xapk|apks|obb)$/i, "android"], [/^(ios|iphone|ipad|ipa)$/i, "ios"],
];

/** "PS5", "PlayStation 5", "nsw", "PC (Microsoft Windows)" → the id; anything unknown → null */
export function platformId(s: string | null | undefined): PlatformId | null {
  const t = String(s ?? "").replace(/[™®]/g, "").trim();
  if (!t) return null;
  for (const [re, id] of ALIASES) if (re.test(t)) return id;
  return null;
}
export const isPc = (id: PlatformId | null | undefined): boolean => id === "pc";
export const isConsole = (id: PlatformId | null | undefined): boolean => !!id && !["pc", "mac", "linux", "android", "ios"].includes(id);

export const CONSOLE_PLATFORMS: PlatformId[] = ["ps5", "ps4", "ps3", "ps2", "ps1", "psp", "vita", "switch", "switch2", "wiiu", "wii", "gc", "n64", "snes", "nes", "gba", "gbc", "gb", "nds", "3ds", "xsx", "xone", "x360", "xbox", "dc", "saturn", "genesis"];
/**
 * the console pass asks every category: trackers file consoles inconsistently (GazelleGames puts PS5 and Switch
 * dumps under PC/Games, since newznab never got categories for them), so the platform named in the title decides
 */
export const CONSOLE_CATEGORIES: number[] = [];
const CATEGORY_PLATFORM: Record<number, PlatformId> = { 1010: "nds", 1020: "psp", 1030: "wii", 1040: "xbox", 1050: "x360", 1080: "ps3", 1110: "3ds", 1120: "vita", 1130: "wiiu", 1140: "xone", 1180: "ps4" };
export const platformOfCategory = (ids: number[]): PlatformId | null => ids.map(i => CATEGORY_PLATFORM[i]).find((p): p is PlatformId => !!p) ?? null;

/** the consoles a game is on, from its stored platforms ("PS5", "PS3", "win" …); empty for a PC-only game or when nothing is known */
export const consolePlatforms = (platforms: string[]): PlatformId[] => [...new Set(platforms.map(platformId).filter(isConsole) as PlatformId[])];
export const hasPc = (platforms: string[]): boolean => platforms.some(p => platformId(p) === "pc");

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  pc: "PC", mac: "macOS", linux: "Linux", ps5: "PlayStation 5", ps4: "PlayStation 4", ps3: "PlayStation 3", ps2: "PlayStation 2", ps1: "PlayStation", psp: "PSP", vita: "PS Vita",
  switch: "Switch", switch2: "Switch 2", wiiu: "Wii U", wii: "Wii", gc: "GameCube", n64: "Nintendo 64", snes: "SNES", nes: "NES", gba: "Game Boy Advance", gbc: "Game Boy Color", gb: "Game Boy", nds: "Nintendo DS", "3ds": "Nintendo 3DS",
  xsx: "Xbox Series X|S", xone: "Xbox One", x360: "Xbox 360", xbox: "Xbox", dc: "Dreamcast", saturn: "Saturn", genesis: "Mega Drive", arcade: "Arcade", android: "Android", ios: "iOS",
};

/* ─────────── the version that is asked for ─────────── */

/** what a game is never fetched for: other desktops and phones (a copy is installed on a Windows PC) */
const NOT_OFFERED: PlatformId[] = ["mac", "linux", "android", "ios"];
/**
 * The versions a game can be asked for: the platforms it is on, as ids, each once, PC first. A game on one platform has no
 * choice to make; a game on several (an arcade game that also came out on two consoles) is searched for whichever its
 * library entry names (games.want_platform), and with none named, as before: the PC version, else a console's.
 */
export function platformChoices(platforms: string[]): PlatformId[] {
  const ids = [...new Set(platforms.map(platformId).filter((p): p is PlatformId => !!p && !NOT_OFFERED.includes(p)))];
  return ids.sort((a, b) => Number(b === "pc") - Number(a === "pc"));
}
/** a wanted version as it is kept (games.want_platform), or null for none */
export function wantedPlatform(raw: string | null | undefined): PlatformId | null {
  const id = platformId(raw);
  return id && !NOT_OFFERED.includes(id) ? id : null;
}

/** files that are a console game by themselves: disc images, packages, cartridge dumps */
export const ROM_EXT = /\.(iso|pkg|bin|cue|chd|rvz|wbfs|wia|gcz|gcm|nsp|xci|nsz|xcz|3ds|cia|nds|gba|gbc|gb|z64|n64|v64|sfc|smc|nes|fds|pbp|cso|vpk|xex|wux|wud|wua|dol|elf|self|md|gen|cdi|gdi)$/i;
/** folder dumps: a PS3 "JB" folder, a PS4 Home Rip (sce_sys/param.sfo), a PS5 app0 folder (sce_sys/param.json), a Switch
 *  romfs … (the dump's launch is its marker file: the dump is the folder, read as one by src/ways/copy.ts) */
export const ROM_MARKER = /(^|\/)(ps3_game\/|ps3_disc\.sfb$|usrdir\/eboot\.bin$|sce_sys\/param\.sfo$|sce_sys\/param\.json$|param\.sfo$|app\.pkg$|exefs\/main$|romfs\/)/i;
