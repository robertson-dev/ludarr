/**
 * Emulators the catalog knows, with where their Windows builds come from and what they need besides the game.
 * Release sources verified 2026-10-18, and again 2026-11-11 for every entry that starts a game by itself (the asset's
 * name, the archive's layout and the program's command line, read from each project's releases and source); asset names
 * drift, so patterns match tokens, not exact names.
 * `repo` is "owner/name" on GitHub, or "forgejo:<host>/<owner>/<name>" for a Forgejo/Gitea instance.
 *
 * What ludarr needs to set one up by itself (portable mode, the settings that keep wizards and updaters away, the saves
 * it keeps, where a BIOS goes) is in src/ways/construct.ts STEP0_FACTS; which emulator plays which console is in
 * src/ways/recipes.ts.
 */
import type { From, Need, Platform, RuntimeInput } from "../types";

export const EMULATORS: RuntimeInput[] = [
  { id: "shadps4", name: "shadPS4", kind: "emulator", platforms: ["ps4"], homepage: "https://shadps4.net", repo: "shadps4-emu/shadPS4",
    assetPattern: "^shadps4-win64-sdl-.*\\.zip$", channel: "stable", launch: { exe: "shadPS4.exe", args: ["-g", "{content}"] },
    notes: "Game = a dumped/decrypted PS4 game folder (CUSA#####) or an installed PKG. Some games want firmware modules (sys_modules) from a console." },
  { id: "sharpemu", name: "SharpEmu", kind: "emulator", platforms: ["ps5"], homepage: "https://sharpemu.app", repo: "sharpemu/sharpemu",
    assetPattern: "win-x64\\.zip$", channel: "stable", notes: "Early PS5 emulator: about a hundred titles tested." },
  { id: "rpcs3", name: "RPCS3", kind: "emulator", platforms: ["ps3"], homepage: "https://rpcs3.net", repo: "RPCS3/rpcs3-binaries-win",
    assetPattern: "_win64(_msvc)?\\.7z$", channel: "stable", launch: { exe: "rpcs3.exe", args: ["--no-gui", "--fullscreen", "{content}"] },
    notes: "Rolling builds only. Needs the PS3 system software (PS3UPDAT.PUP, free from Sony) installed once (rpcs3.exe --headless --installfw). Needs the Visual C++ runtime." },
  { id: "xenia-canary", name: "Xenia Canary", kind: "emulator", platforms: ["x360"], homepage: "https://xenia.jp", repo: "xenia-canary/xenia-canary",
    assetPattern: "^xenia_canary_windows\\.(7z|zip)$", channel: "nightly", launch: { exe: "xenia_canary.exe", args: ["--fullscreen=true", "{content}"] },
    notes: "One release per commit. Game = an ISO (XISO), a default.xex or a GoD/XBLA container's header file. Needs the Visual C++ runtime and a CPU with AVX." },
  { id: "pcsx2", name: "PCSX2", kind: "emulator", platforms: ["ps2"], homepage: "https://pcsx2.net", repo: "PCSX2/pcsx2",
    assetPattern: "windows-x64-Qt\\.7z$", channel: "stable", launch: { exe: "pcsx2-qt.exe", args: ["-batch", "-fullscreen", "--", "{content}"] },
    notes: "Needs a PS2 BIOS dump. Needs the Visual C++ runtime." },
  { id: "vita3k", name: "Vita3K", kind: "emulator", platforms: ["vita"], homepage: "https://vita3k.org", repo: "Vita3K/Vita3K",
    assetPattern: "^windows-latest\\.zip$", channel: "nightly", notes: "Rolling 'continuous' build. Needs the Vita firmware (free from Sony)." },
  { id: "ryujinx", name: "Ryujinx (Ryubing)", kind: "emulator", platforms: ["switch"], homepage: "https://ryujinx.app", repo: null,
    notes: "Downloads come from ryujinx.app (its update server), not GitHub. Needs prod.keys and Switch firmware." },
  { id: "eden", name: "Eden", kind: "emulator", platforms: ["switch"], homepage: "https://eden-emu.dev", repo: "forgejo:git.eden-emu.dev/eden-emu/eden",
    assetPattern: "Windows.*amd64-msvc-standard\\.zip$", channel: "stable", launch: { exe: "eden.exe", args: ["-f", "-g", "{content}"] },
    notes: "yuzu-lineage Switch emulator. Needs prod.keys; some games also want the Switch firmware." },
  { id: "dolphin", name: "Dolphin", kind: "emulator", platforms: ["gc", "wii"], homepage: "https://dolphin-emu.org", repo: "dolphin:beta", launch: { exe: "Dolphin.exe", args: ["-b", "-e", "{content}"] },
    notes: "Builds from dolphin-emu.org/update/latest/beta/ (JSON). Needs the Visual C++ runtime." },
  { id: "cemu", name: "Cemu", kind: "emulator", platforms: ["wiiu"], homepage: "https://cemu.info", repo: "cemu-project/Cemu",
    assetPattern: "^cemu-[\\w.-]+-windows-x64\\.zip$", channel: "stable", launch: { exe: "Cemu.exe", args: ["-g", "{content}", "-f"] },
    notes: "Last tagged release is from 2025; newer builds are CI artifacts. A .wua holds a game with its update; .wud and .wux images need their disc keys (keys.txt)." },
  { id: "duckstation", name: "DuckStation", kind: "emulator", platforms: ["ps1"], homepage: "https://www.duckstation.org", repo: "stenzek/duckstation",
    assetPattern: "^duckstation-windows-x64-release\\.zip$", channel: "stable", launch: { exe: "duckstation-qt-x64-ReleaseLTCG.exe", args: ["-batch", "-nogui", "-fullscreen", "--", "{content}"] },
    notes: "Needs a PS1 BIOS dump. Needs the Visual C++ runtime." },
  { id: "ppsspp", name: "PPSSPP", kind: "emulator", platforms: ["psp"], homepage: "https://www.ppsspp.org", repo: "hrydgard/ppsspp",
    assetPattern: "^PPSSPP-v\\d+(\\.\\d+)*-Windows-x64\\.zip$", channel: "stable", launch: { exe: "PPSSPPWindows64.exe", args: ["--fullscreen", "--pause-menu-exit", "{content}"] } },
  { id: "xemu", name: "xemu", kind: "emulator", platforms: ["xbox"], homepage: "https://xemu.app", repo: "xemu-project/xemu",
    assetPattern: "^xemu-[0-9.]+-windows-x86_64[.]zip$", channel: "stable", launch: { exe: "xemu.exe", args: ["-full-screen", "-dvd_path", "{content}"] },
    notes: "Needs an Xbox BIOS, MCPX boot ROM and HDD image. Plays XISO images only (a Redump image is converted first)." },
  { id: "azahar", name: "Azahar", kind: "emulator", platforms: ["3ds"], homepage: "https://azahar-emu.org", repo: "azahar-emu/azahar",
    assetPattern: "^azahar-windows-mxe-[\\d.]+\\.zip$", channel: "stable", launch: { exe: "azahar.exe", args: ["-f", "{content}"] },
    notes: "Plays decrypted games only (an encrypted dump is refused). A .cia has to be installed first, so it is not taken." },
  { id: "rmg", name: "RMG", kind: "emulator", platforms: ["n64"], homepage: "https://github.com/Rosalie241/RMG", repo: "Rosalie241/RMG",
    assetPattern: "^RMG-Portable-Windows64-v[\\d.]+\\.zip$", channel: "stable", launch: { exe: "RMG.exe", args: ["-f", "-n", "-q", "{content}"] },
    notes: "Rosalie's Mupen GUI (mupen64plus). The portable build keeps everything beside the program." },
  { id: "ares", name: "ares", kind: "emulator", platforms: ["snes", "genesis"], homepage: "https://ares-emu.net", repo: "ares-emulator/ares",
    assetPattern: "^ares-windows-x64\\.zip$", channel: "stable", launch: { exe: "ares.exe", args: ["--kiosk", "--fullscreen", "{content}"] },
    notes: "Many systems in one program; it is told which one (--system). The SNES coprocessor firmware is built in. Needs a CPU with SSE4.2." },
  { id: "mesen", name: "Mesen", kind: "emulator", platforms: ["nes"], homepage: "https://www.mesen.ca", repo: "SourMesen/Mesen2",
    assetPattern: "^Mesen_[\\d.]+_Windows\\.zip$", channel: "stable", launch: { exe: "Mesen.exe", args: ["--fullscreen", "{content}"] },
    notes: "One self-contained program; it unpacks its own libraries beside itself on every start." },
  { id: "mgba", name: "mGBA", kind: "emulator", platforms: ["gba", "gbc", "gb"], homepage: "https://mgba.io", repo: "mgba-emu/mgba",
    assetPattern: "^mGBA-[\\d.]+-win64\\.7z$", channel: "stable", launch: { exe: "mGBA.exe", args: ["-f", "{content}"] },
    notes: "Needs no BIOS (it has its own). The archive ships portable.ini." },
  { id: "melonds", name: "melonDS", kind: "emulator", platforms: ["nds"], homepage: "https://melonds.kuribo64.net", repo: "melonDS-emu/melonDS",
    assetPattern: "^melonDS-(?:[\\d.]+-)?windows-x86_64\\.zip$", channel: "stable", launch: { exe: "melonDS.exe", args: ["-f", "{content}"] },
    notes: "Needs no BIOS or firmware for DS games (it has its own); DSi games need real dumps." },
  { id: "flycast", name: "Flycast", kind: "emulator", platforms: ["dc"], homepage: "https://github.com/flyinghead/flycast", repo: "flyinghead/flycast",
    assetPattern: "^flycast-win64-\\d+(\\.\\d+)*\\.zip$", channel: "stable", launch: { exe: "flycast.exe", args: ["-config", "window:fullscreen=yes", "{content}"] },
    notes: "Needs no BIOS (it has its own; a few games ask for a real one, data/dc_boot.bin)." },
  { id: "ymir", name: "Ymir", kind: "emulator", platforms: ["saturn"], homepage: "https://github.com/ymir-emu/Ymir", repo: "ymir-emu/Ymir",
    assetPattern: "^ymir-windows-x86_64-SSE2-v[\\d.]+\\.zip$", channel: "stable", launch: { exe: "ymir-sdl3.exe", args: ["-p", "{install}/profile", "-f", "{content}"] },
    notes: "Needs a Saturn BIOS dump. Needs the Visual C++ runtime." },
  { id: "mame", name: "MAME", kind: "emulator", platforms: ["arcade"], homepage: "https://www.mamedev.org", repo: "mamedev/mame",
    assetPattern: "^mame\\d+b_x64\\.exe$", channel: "stable", launch: { exe: "mame.exe", args: ["{content}", "-rompath", "{install}/roms", "-skip_gameinfo"] },
    notes: "The release is a self-extracting archive. A game is a ROM set named as MAME names it (mvsc.zip), from a set made for this MAME version; some need a BIOS or device set beside it (neogeo.zip, qsound.zip)." },
];

/** what each emulator needs besides the game itself */
export const EMULATOR_NEEDS: Record<string, Need[]> = {
  rpcs3: [{ kind: "firmware", name: "PS3 system software (PS3UPDAT.PUP)", note: "free download from Sony, installed once", from: [{ type: "url", url: "https://www.playstation.com/en-us/support/hardware/ps3/system-software/" }] }],
  vita3k: [{ kind: "firmware", name: "PS Vita firmware (PSVUPDAT.PUP)", note: "free download from Sony, installed once", from: [{ type: "url", url: "https://www.playstation.com/en-us/support/hardware/psvita/system-software/" }] }],
  shadps4: [{ kind: "firmware", name: "PS4 system modules", note: "only some games; dumped from a console", from: [{ type: "user", hint: "copy sys_modules from a PS4 dump into the emulator's sys_modules folder" }] }],
  pcsx2: [{ kind: "bios", name: "PS2 BIOS", from: [{ type: "user", hint: "a BIOS dumped from a PS2" }] }],
  ryujinx: [{ kind: "keys", name: "prod.keys", from: [{ type: "user", hint: "dumped from a Switch" }] }, { kind: "firmware", name: "Switch firmware", from: [{ type: "user", hint: "dumped from a Switch" }] }],
  eden: [{ kind: "keys", name: "prod.keys", from: [{ type: "user", hint: "dumped from a Switch" }] }],
  duckstation: [{ kind: "bios", name: "PS1 BIOS", from: [{ type: "user", hint: "a BIOS dumped from a PlayStation" }] }],
  cemu: [{ kind: "keys", name: "Wii U disc keys (keys.txt)", note: "for .wud and .wux images", from: [{ type: "user", hint: "the disc keys of your games, one per line" }] }],
  xemu: [
    { kind: "bios", name: "Xbox MCPX boot ROM", from: [{ type: "user", hint: "mcpx_1.0.bin, 512 bytes, dumped from an Xbox" }] },
    { kind: "bios", name: "Xbox BIOS", note: "a retail BIOS boots no game: a modified or debug one (Complex 4627)", from: [{ type: "user", hint: "a BIOS image dumped from an Xbox" }] },
    { kind: "extract", name: "Xbox hard disk image", note: "the ready-made xbox_hdd.qcow2 from xemu's own project", from: [{ type: "url", url: "https://github.com/xemu-project/xemu-dashboard/releases/latest" }] },
  ],
  ymir: [{ kind: "bios", name: "Saturn BIOS", from: [{ type: "user", hint: "a BIOS dumped from a Saturn (512 KiB)" }] }],
};

/** the game data an emulated route needs, per console: what it is and how the request pipeline would look for it */
export function consoleContent(platform: Platform, name: string, serials: string[]): { kind: "pkg" | "disc" | "rom"; platform: Platform; accept: { serials: string[] }; from: From[] } {
  const KIND: Partial<Record<Platform, "pkg" | "disc" | "rom">> = { ps4: "pkg", ps5: "pkg", switch: "pkg", vita: "pkg", ps3: "disc", ps2: "disc", ps1: "disc", psp: "disc", x360: "disc", xbox: "disc", gc: "disc", wii: "disc", wiiu: "disc" };
  const TAG: Partial<Record<Platform, string>> = { ps4: "PS4", ps5: "PS5", ps3: "PS3", ps2: "PS2", ps1: "PSX", psp: "PSP", vita: "PS Vita", x360: "XBOX360", xbox: "XBOX", switch: "NSW", gc: "NGC", wii: "WII", wiiu: "WIIU" };
  return { kind: KIND[platform] ?? "rom", platform, accept: { serials }, from: [{ type: "tracker", query: `${name} ${TAG[platform] ?? platform.toUpperCase()}` }] };
}
