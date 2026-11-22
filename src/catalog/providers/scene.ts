/**
 * Scene releases (predb.club, the open successor of the predb.ovh API): what was released lately for PS5,
 * Switch, PS4 and PC. A release that appeared before the game's official release date is a leak.
 *
 * Console releases create titles of their own (that is how a PS5 game without a compatibility report shows
 * up at all); PC releases only attach to titles the catalog already knows, because the PC category is
 * dominated by Linux/Mac/GOG rips of everything.
 */
import { db } from "../../db";
import { findTitle } from "../store";
import type { Contribution, Platform, Provider, RouteInput } from "../types";

const API = "https://predb.club/api/v1/";
interface PreRow { id: number; name: string; team: string; cat: string; size: number | null; files: number | null; preAt: number; nuke: unknown }

const SECTIONS: { cat: string; platform: Platform; pages: number; known: boolean }[] = [
  { cat: "GAMES-PS5", platform: "ps5", pages: 6, known: false },
  { cat: "GAMES-NSW", platform: "switch", pages: 5, known: false },
  { cat: "GAMES-PS4", platform: "ps4", pages: 2, known: false },
  { cat: "GAMES-PC", platform: "pc", pages: 5, known: true },
];
const RUNTIME: Partial<Record<Platform, string>> = { ps5: "sharpemu", ps4: "shadps4", switch: "ryujinx" };

const SKIP = /\b(dlc|update|patch|crack ?fix|fix|trainer|soundtrack|ost|artbook|unlocker|linux|macos|mac|android|keygen|sdk|demo)\b/i;
const CUT = /\b(incl|v\d+(\s\d+)*|build\s?\d+|multi\d*|proper|repack|read ?nfo|internal|gog|nsw|switch|ps5|ps4|ps3|xbox(360|one)?|eur|usa|jpn|asia|kor|eng(lish)?|japanese|korean|chinese)\b/i;

/** "Trails.in.the.Sky.2nd.Chapter.Deluxe.Edition.incl.DLC.PS5-DUPLEX" → { name: "Trails in the Sky 2nd Chapter", group: "DUPLEX" } — null for DLC, updates, trainers … */
export function sceneTitle(release: string): { name: string; group: string | null } | null {
  const dash = release.lastIndexOf("-");
  const group = dash > 0 ? release.slice(dash + 1) : null;
  let s = (dash > 0 ? release.slice(0, dash) : release).replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const incl = /\bincl\b/i.exec(s);
  if (incl) s = s.slice(0, incl.index).trim();
  if (SKIP.test(s)) return null;
  const cut = CUT.exec(s);
  if (cut && cut.index > 0) s = s.slice(0, cut.index).trim();
  s = s.replace(/\s(digital\s)?(deluxe|ultimate|complete|gold|definitive|standard|premium|collectors?|anniversary|launch|special|limited|game of the year|goty)(\sedition)?$/i, "").replace(/\sedition$/i, "").trim();
  return s.length >= 2 ? { name: s, group } : null;
}

const releaseIsoOf = db.query("SELECT release_iso FROM titles WHERE id=?");

export function sceneContributions(rows: PreRow[], platform: Platform, knownOnly: boolean): Contribution[] {
  const out: Contribution[] = [];
  for (const r of rows) {
    if (r.nuke) continue;
    const t = sceneTitle(r.name);
    if (!t) continue;
    const title = { ids: [], name: t.name, platforms: [platform] };
    const id = findTitle(title);
    if (knownOnly && id == null) continue;
    const iso = id != null ? (releaseIsoOf.get(id) as { release_iso: string | null } | undefined)?.release_iso ?? null : null;
    const leak = !!iso && r.preAt < Date.parse(iso + "T00:00:00Z") / 1000;
    const route: RouteInput = {
      key: `predb:${r.id}`, kind: platform === "pc" ? "native" : "emulated", platform, provenance: leak ? "leak" : "retail",
      runtime: RUNTIME[platform] ?? null, label: `${r.team || t.group || "scene"} release`, status: platform === "pc" ? null : "unknown",
      statusAt: r.preAt, statusNote: [r.name, r.size ? `${(r.size / 1024).toFixed(1)} GB` : null, leak ? `before the ${iso} release` : null].filter(Boolean).join(" · "),
      content: { kind: platform === "pc" ? "files" : "pkg", platform, from: [{ type: "release", title: r.name, size: r.size ? r.size * 1024 * 1024 : null }] },
    };
    out.push({ title, routes: [route] });
  }
  return out;
}

export const sceneProvider: Provider = {
  id: "scene", label: "Scene releases", every: 6 * 60, metaRank: 10,
  about: "Recent PS5, Switch, PS4 and PC scene releases (predb.club); a release that came out before the game's official date is marked as a leak.",
  async collect(ctx) {
    const out: Contribution[] = [];
    for (const s of SECTIONS) {
      const rows: PreRow[] = [];
      for (let page = 1; page <= s.pages; page++) {
        const res = await ctx.fetch(`${API}?q=${encodeURIComponent(`@cat ${s.cat}`)}&count=100&page=${page}`, { headers: { "User-Agent": "AhoyCatalogBot/0.1" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} from predb.club`);
        const j = await res.json() as { status: string; data?: { rows: PreRow[] } };
        const got = j.data?.rows ?? [];
        rows.push(...got);
        if (got.length < 100) break;
        await Bun.sleep(1500);
      }
      const items = sceneContributions(rows, s.platform, s.known);
      ctx.log(`${s.cat}: ${items.length} of ${rows.length} releases`);
      out.push(...items);
    }
    return out;
  },
};
