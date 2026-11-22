/**
 * ludarr — a PARAM.SFO (the system file every PS3, PS4, PSP and Vita game carries) read into an identity.
 *
 *   0x00 "\0PSF", 0x04 version, 0x08 key table start, 0x0C data table start, 0x10 entry count; entries from 0x14, 16 bytes
 *   each: key offset u16, data format u16 (0x0404 a 32-bit number, 0x0204 text ending in NUL, 0x0004 text without one),
 *   data length u32, data room u32, data offset u32 (all little-endian)
 *
 * The keys read: TITLE_ID (PSP: DISC_ID), APP_VER (PSP: DISC_VERSION), VERSION, CATEGORY, CONTENT_ID, TITLE. CATEGORY says what
 * the data is: PS4 and Vita gd (the game) / gp (its patch) / ac (an add-on); PS3 DG and HG (a disc or an installed game) / GD
 * (game data: an update); PSP UG and MG (a game) / PG (its update) / UV and UM (a UMD film or album). The console comes from
 * the title id (titles.ts), and must be one the place the file was found in holds.
 */
import type { PlatformId } from "../../platforms";
import type { Identity } from "../identity";
import { le16, le32, nothing, raw, type Read } from "./bytes";
import { consoleOfTitle, CONTENT_ID, regionOfContentId, regionOfSerial, titleIdOf } from "./titles";

/** the fields of an SFO, or null when the bytes are not one (every offset is checked against the bytes given) */
export function parseSfo(b: Uint8Array): Map<string, string | number> | null {
  if (b.length < 0x14 || raw(b.subarray(0, 4)) !== "\0PSF") return null;
  const keys = le32(b, 8), data = le32(b, 12), n = le32(b, 16);
  if (n === 0 || n > 256 || 0x14 + n * 16 > keys || keys > data || data > b.length) return null;
  const out = new Map<string, string | number>();
  for (let i = 0; i < n; i++) {
    const e = 0x14 + i * 16;
    const ko = keys + le16(b, e), fmt = le16(b, e + 2), len = le32(b, e + 4), off = data + le32(b, e + 12);
    if (ko >= data || off > b.length || len > b.length - off) return null;
    let end = ko;
    while (end < data && b[end] !== 0) end++;
    const key = raw(b.subarray(ko, end));
    if (!/^[A-Z0-9_]{1,32}$/.test(key)) return null;
    if (fmt === 0x0404) { if (len >= 4) out.set(key, le32(b, off)); }
    else if (fmt === 0x0204 || fmt === 0x0004) {
      let stop = off + len;
      while (stop > off && b[stop - 1] === 0) stop--;
      out.set(key, new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(off, stop)));
    }
  }
  return out;
}

/** where an SFO was found, and so which consoles it may be for */
export type SfoPlace = "sce_sys" | "PS3_GAME" | "PSP_GAME" | "root";
const PLACE_HOLDS: Record<SfoPlace, PlatformId[]> = { sce_sys: ["ps4", "vita"], PS3_GAME: ["ps3"], PSP_GAME: ["psp"], root: ["ps3"] };
const PLACE_WORDS: Record<SfoPlace, string> = { sce_sys: "sce_sys/param.sfo", PS3_GAME: "PS3_GAME/PARAM.SFO", PSP_GAME: "PSP_GAME/PARAM.SFO", root: "PARAM.SFO" };

/** CATEGORY by console: what the data is (anything else is not said) */
const CATEGORY: Partial<Record<PlatformId, Record<string, Identity["category"]>>> = {
  ps4: { gd: "game", gp: "patch", ac: "addon" },
  vita: { gd: "game", gc: "game", gp: "patch", ac: "addon" },
  ps3: { DG: "game", HG: "game", GD: "patch" },
  psp: { UG: "game", MG: "game", EG: "game", PG: "patch", UV: "app", UM: "app" },
};

const text = (v: string | number | undefined): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const pack = (id: Identity): Identity => Object.fromEntries(Object.entries(id).filter(([, v]) => v !== undefined && v !== "")) as unknown as Identity;

/** an SFO's fields as an identity (shape: the form it was read from); null with the reason when they name no game */
export function sfoIdentity(f: Map<string, string | number>, place: SfoPlace, shape: Identity["shape"]): Read {
  const id = titleIdOf(text(f.get(place === "PSP_GAME" ? "DISC_ID" : "TITLE_ID")) ?? text(f.get("TITLE_ID")) ?? text(f.get("DISC_ID")));
  if (!id) return nothing(`${PLACE_WORDS[place]} names no title id`);
  const platform = consoleOfTitle(id);
  if (!platform) return nothing(`${PLACE_WORDS[place]} names ${id}, a title id of no PlayStation console ludarr knows`);
  if (!PLACE_HOLDS[place].includes(platform)) return nothing(`${PLACE_WORDS[place]} names ${id}, which is not a title id that file holds`);
  const cat = text(f.get("CATEGORY"));
  const contentId = text(f.get("CONTENT_ID"));
  const cid = contentId && CONTENT_ID.test(contentId) ? contentId : undefined;
  const version = platform === "psp" ? text(f.get("DISC_VERSION")) ?? text(f.get("APP_VER")) : text(f.get("APP_VER")) ?? text(f.get("VERSION"));
  const region = platform === "ps3" || platform === "psp" ? regionOfSerial(id) : regionOfContentId(cid);
  const title = text(f.get("TITLE"))?.replace(/\s+/g, " ");
  return {
    identity: pack({ platform, serial: id, internalName: title, region, version, category: cat ? CATEGORY[platform]?.[cat] : undefined, contentId: cid, shape }),
    why: null,
  };
}
