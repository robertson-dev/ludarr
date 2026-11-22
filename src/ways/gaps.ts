/**
 * ludarr — what a plan made before the content model could say more still lacks, so a carry run asks the AI once to
 * turn it into data before it searches for anything (a search under the old plan would fetch and refuse the very files a
 * better plan takes):
 *
 *   a product only a tool makes   the plan takes a form (a .zar, a .nup, an .o2r …) that only a tool makes, and it has no
 *                                 make recipe and does not say that only the game's owner can make it (personalDump)
 *   facts only in words           title ids, build ids and versions written in `what` that accept does not list, so
 *                                 nothing checks them
 *   no check                      nothing is run on the server before the package is offered
 *   nothing proves the file       a recomp or port that lists no hashes, serials or builds
 *
 * Pure: the same plan always gives the same gaps. No gaps: no round.
 */
import type { ContentPlan, PlanKind, RuntimePlanSpec } from "./types";
import { provingProblem, versionKey } from "./validate";

/** forms of a game's data that only a tool makes, and which tool: a plan that takes one needs a recipe to make it, or must
 *  say that only the game's owner can */
export const TOOL_MADE: Record<string, string> = {
  zar: "packed from the game folder with ZArchive",
  nup: "made by Eglantine on the console",
  o2r: "made by the port's own extractor",
  otr: "made by the port's own extractor",
  rvz: "made by Dolphin from a disc",
  wbfs: "made by Dolphin from a disc",
  chd: "made by chdman",
};

/** title ids the console's own data carries (PlayStation 3, 4, 5, PSP, Vita) */
const TITLE_ID = /\b(PPSA|PPSB|CUSA|PLAS|BL[EU]S|BC[EU]S|NP[EUJ][AB]|UL[EU]S|PCS[ABEG])[-_]?(\d{4,5})\b/g;
/** a Switch or Switch 2 title id: 16 hex digits, 01… or 04… */
const SWITCH_TITLE = /\b(0[14][0-9a-f]{14})\b/gi;
/** a program build id written next to the word build */
const BUILD_ID = /\bbuild(?:\s+id)?\s*[:=#]?\s*([0-9a-f]{8,64})\b/gi;
/** versions as the consoles write them (01.007.000), or as a release names them (v1.1.1), or next to the word version */
const VERSIONS = [
  /(?<![\w.])(\d{2}\.\d{3}\.\d{3})(?![\w.])/g,
  /(?<![\w.])v(\d+(?:\.\d+){1,3})(?![\w.])/gi,
  /\b(?:version|ver\.?|update)\s+(\d+(?:\.\d+){1,3})(?![\w.])/gi,
  /(?<![\w.])(\d+(?:\.\d+){1,3})\s+(?:update|version)\b/gi,
];

const squash = (s: string) => s.toUpperCase().replace(/[-_.\s]/g, "");
const uniq = (xs: string[]) => [...new Set(xs)];

/** the title ids, build ids and versions `text` names */
export function factsIn(text: string): { serials: string[]; builds: string[]; versions: string[] } {
  const serials: string[] = [], builds: string[] = [], versions: string[] = [];
  for (const m of text.matchAll(TITLE_ID)) serials.push(`${m[1].toUpperCase()}${m[2]}`);
  for (const m of text.matchAll(SWITCH_TITLE)) serials.push(m[1].toUpperCase());
  for (const m of text.matchAll(BUILD_ID)) builds.push(m[1].toLowerCase());
  for (const re of VERSIONS) for (const m of text.matchAll(re)) versions.push(m[1]);
  // a version that is only a part of a title id or build id named in the same text is none
  return { serials: uniq(serials), builds: uniq(builds).filter(b => !serials.some(s => squash(s) === squash(b))), versions: uniq(versions) };
}

const extOf = (f: string) => f.toLowerCase().replace(/^\./, "");

/**
 * Each gap in words (empty: the plan says everything the new readers can use). For an emulator plan pass the way's own
 * content plan, and a spec whose check is the way's own when it has one: the round then edits the way, not the shared plan.
 */
export function upgradeGaps(spec: RuntimePlanSpec, content: ContentPlan | null, kind?: PlanKind): string[] {
  const gaps: string[] = [];
  const c = content ?? spec.content;
  if (c) {
    // (1) a product only a tool makes, with nothing that makes it and no word that only its owner can
    if (!c.make && !c.personalDump) {
      for (const f of (c.accept.formats ?? []).map(extOf)) {
        const tool = TOOL_MADE[f];
        if (tool) gaps.push(`it takes a .${f} file, which is ${tool}, and the plan has no recipe that makes one (content.make) and does not say only the game's owner can make it (content.personalDump)`);
      }
    }
    // (2) identity facts written only in words
    const said = factsIn([c.what, ...c.search].join("\n"));
    const serials = (c.accept.serials ?? []).map(squash), builds = (c.accept.builds ?? []).map(b => b.toLowerCase());
    const versions = (c.accept.versions ?? []).map(versionKey);
    const make = c.make?.input;
    const inputSerials = (make?.serials ?? []).map(squash), inputVersions = (make?.versions ?? []).map(versionKey);
    for (const s of said.serials) if (!serials.includes(squash(s)) && !inputSerials.includes(squash(s))) gaps.push(`what names the title id ${s}, which accept.serials does not list`);
    for (const b of said.builds) if (!builds.some(x => x.startsWith(b) || b.startsWith(x))) gaps.push(`what names the build ${b}, which accept.builds does not list`);
    for (const v of said.versions) if (!versions.includes(versionKey(v)) && !inputVersions.includes(versionKey(v))) gaps.push(`what names the version ${v}, which accept.versions does not list`);
  }
  // (3) nothing is checked on the server
  if (!spec.check || (!spec.check.steps.length && !spec.check.smoke)) gaps.push("the plan runs no check on the server before the package is offered (check)");
  // (4) a recomp or port that proves nothing
  const proving = kind ? provingProblem({ content: c }, kind) : null;
  if (proving) gaps.push(proving);
  return gaps;
}
