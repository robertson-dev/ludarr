/**
 * ludarr — a PS5 game's sce_sys/param.json (plain JSON) read into an identity, the way KytyPS5 reads it
 * (chenxiao07/KytyPS5 @ 65ed19d9):
 *
 *   src/loader/systemContent.cpp:164-174   titleId → TITLE_ID, contentId → CONTENT_ID, contentVersion → APP_VER and then
 *                                          appVersion over it when there is one (AddParamString replaces a param, 274-285),
 *                                          attribute, userDefinedParam1-4
 *   systemContent.cpp:182-220              the title: localizedParameters[defaultLanguage].titleName, else en-US's, else the
 *                                          first language's
 *   launcher-linux/game.cpp:17, 82-90      a byte order mark is stripped; the version the launcher checks against the tested
 *                                          ones is contentVersion (so are the caches: run-windows.ps1:172, precompile.py:139)
 *   src/libs/libAppContent.cpp:214-216     "applicationCategoryType marks an application's own param.json, never an add-on's"
 *
 * So: serial = titleId, version = contentVersion (appVersion when there is none), contentId and the region of its store
 * (UP… America, EP… Europe), internalName = the default language's title. Category: applicationCategoryType 0 is the game,
 * another value an application that is no game; no applicationCategoryType, a content id and no eboot.bin is an add-on.
 *
 * Which field marks a patch: none that Kyty reads, and none can. A console's app0 folder is the game as the console runs
 * it, the update applied, so the whole game at 01.007.000 carries the update's own param.json (Kyty's README dumps
 * "PPSA01341-app0" at 01.007.000; the disc is 01.00). The same param.json sits in a dump of the update alone. Only the
 * folder's contents tell the two apart: completeness() in src/ways/inspect.ts (a count and a size, and the program's own
 * list of the game's files) — the content plan's `complete`.
 */
import type { Identity } from "../identity";
import { jsonObject, jsonText, nothing, type Read } from "./bytes";
import { consoleOfTitle, CONTENT_ID, regionOfContentId, titleIdOf, titleOfContentId } from "./titles";

/** param.json's bytes as an object (a byte order mark and padding NULs dropped), or null */
export const parseParamJson = (b: Uint8Array): Record<string, unknown> | null => jsonObject(jsonText(b));

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const pack = (id: Identity): Identity => Object.fromEntries(Object.entries(id).filter(([, v]) => v !== undefined && v !== "")) as unknown as Identity;

/** the title Kyty shows: the default language's, else en-US's, else the first one written */
function titleOf(j: Record<string, unknown>): string | undefined {
  const loc = j.localizedParameters;
  if (!loc || typeof loc !== "object" || Array.isArray(loc)) return undefined;
  const l = loc as Record<string, unknown>;
  const name = (lang: unknown) => {
    const o = typeof lang === "string" ? l[lang] : null;
    return o && typeof o === "object" && !Array.isArray(o) ? str((o as Record<string, unknown>).titleName) : undefined;
  };
  return name(l.defaultLanguage) ?? name("en-US") ?? Object.keys(l).map(k => name(k)).find(Boolean);
}

/** where a param.json was read: a folder (and whether eboot.bin sits beside sce_sys), a .zar, a disc image */
export interface ParamPlace { shape: "folder" | "zar" | "iso"; eboot: boolean | null }

/** a param.json's fields as a PS5 identity; null with the reason when they name no PS5 game or the game's program is missing */
export function ps5Identity(j: Record<string, unknown>, at: ParamPlace): Read {
  const serial = titleIdOf(j.titleId);
  if (!serial) return nothing("its sce_sys/param.json names no title id");
  if (consoleOfTitle(serial) !== "ps5") return nothing(`its sce_sys/param.json names ${serial}, which is not a PlayStation 5 title id`);
  const cidRaw = str(j.contentId);
  const contentId = cidRaw && CONTENT_ID.test(cidRaw) && titleOfContentId(cidRaw) === serial ? cidRaw : undefined;
  const act = j.applicationCategoryType;
  let category: Identity["category"];
  if (typeof act === "number" && Number.isFinite(act)) category = act === 0 ? "game" : "app";
  else if (act === undefined && contentId && at.eboot === false) category = "addon";
  if (at.eboot === false && category !== "addon") {
    // a game archive without its program at the root is refused by the emulator that reads them (Kyty src/main.cpp:209-214)
    return nothing(at.shape === "zar"
      ? "it holds no eboot.bin at its root, so it is not a packed PS5 game folder"
      : "it has no eboot.bin beside sce_sys, so it is not a whole PS5 game folder");
  }
  return {
    identity: pack({
      platform: "ps5", serial, contentId, region: regionOfContentId(contentId), version: str(j.contentVersion) ?? str(j.appVersion),
      internalName: titleOf(j), category, shape: at.shape,
    }),
    why: null,
  };
}
