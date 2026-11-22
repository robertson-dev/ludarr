import { db, type GameRow } from "../db";
import { normName } from "../catalog/store";
import { EMULATORS } from "../catalog/providers/emulators";
import { PLATFORM_LABEL, type PlatformId } from "../platforms";
import { forgeJson } from "./construct-tools";
import { copyFacts } from "./copy";
import { gameNames } from "./names";

export interface EmulatorResearch {
  reason: string;
  link?: string;
  repo?: string;
  assetUrl?: string;
  incomplete?: boolean;
}
type Route = { title_id: number; runtime_id: string; status: string; link: string | null; content_json: string | null };
const sources: Partial<Record<PlatformId, string>> = {
  ps5: "compat-sharpemu", x360: "compat-xenia", switch: "compat-ryubing",
};

function catalogReport(game: GameRow, platform: PlatformId): EmulatorResearch | null {
  const source = sources[platform];
  if (!source) return null;
  const names = [...new Set(gameNames(game).map(normName))];
  const rows = db.query(`SELECT DISTINCT r.title_id,r.runtime_id,r.status,r.link,r.content_json FROM routes r
    JOIN titles t ON t.id=r.title_id JOIN title_names n ON n.title_id=t.id
    WHERE r.platform=? AND r.source=? AND r.provenance='retail' AND r.kind='emulated'
      AND (t.id=? OR (n.norm IN (SELECT value FROM json_each(?)) AND (t.game_id IS NULL OR t.game_id=?)
           AND (t.year IS NULL OR ? IS NULL OR t.year=?))) ORDER BY r.status_rank,r.status_at DESC`)
    .all(platform, source, game.title_id, JSON.stringify(names), game.id, game.release_year, game.release_year) as Route[];
  const own = rows.filter(r => r.title_id === game.title_id);
  const matches = own.length ? own : rows;
  if (new Set(matches.map(r => r.title_id)).size !== 1) return null;
  const exact = copyFacts(game.id)?.entries.find(e => e.identity?.platform === platform)?.identity?.serial;
  for (const row of matches) {
    const e = EMULATORS.find(e => e.id === row.runtime_id);
    if (!e) continue;
    const ids: string[] = JSON.parse(row.content_json || "{}").accept?.serials ?? [];
    if (exact && ids.length && !ids.some(id => id.toUpperCase() === exact.toUpperCase())) continue;
    const playable = row.status === "perfect" || row.status === "playable";
    return { reason: `${e.name} reports ${game.name} as ${row.status}.`,
      ...(row.link ? { link: row.link } : {}), ...(playable && e.repo ? { repo: e.repo } : {}) };
  }
  return null;
}

type Repo = { full_name: string; description?: string; archived?: boolean; source?: { full_name: string }; parent?: { full_name: string } };
type Release = { name?: string; body?: string; html_url: string; draft?: boolean; assets?: { name: string; browser_download_url: string }[] };
const upstreams: Partial<Record<PlatformId, string[]>> = {
  ps5: ["inorirus/kyty", "jetsku/kytyps5", "chenxiao07/kytyps5", "sharpemu/sharpemu", "rpcsx/rpcsx"],
  xbox: ["xemu-project/xemu"], x360: ["xenia-canary/xenia-canary", "xenia-project/xenia"],
};
const compact = (s: string) => normName(s).replace(/ /g, "");

export const researchDeps = { json: forgeJson, catalog: catalogReport };
export async function researchEmulator(game: GameRow, platform: PlatformId): Promise<EmulatorResearch> {
  let catalog = researchDeps.catalog(game, platform);
  if (platform === "xbox") {
    try {
      const rows = await researchDeps.json("https://xemu.app/compat.json", { signal: AbortSignal.timeout(8_000) }) as { name: string; status: string; url: string }[];
      const names = gameNames(game).map(normName);
      const matches = rows.filter(r => names.includes(normName(r.name)) && /^\/titles\/[a-f\d]{8}(?:#|$)/i.test(r.url));
      if (matches.length === 1) {
        const r = matches[0];
        catalog = { reason: `xemu reports ${game.name} as ${r.status}.`, link: "https://xemu.app" + r.url,
          ...(/^(?:perfect|playable)$/i.test(r.status) ? { repo: "xemu-project/xemu" } : {}) };
      }
    } catch { /* The repository search can still find a title-specific build. */ }
  }
  if (catalog?.repo && platform !== "ps5") return catalog;
  const label = PLATFORM_LABEL[platform];
  const empty = catalog ?? { reason: `No playable ${label} build has been verified for ${game.name}.` };
  const safeTitle = game.name.replace(/["\\]/g, " ").slice(0, 120);
  const query = `"${safeTitle}" ${platform === "ps5" ? "PS5" : label} emulator in:name,description,readme fork:true`;
  const signal = AbortSignal.timeout(18_000);
  const identity = copyFacts(game.id)?.entries.find(e => e.identity?.platform === platform)?.identity;
  let lead: EmulatorResearch | null = null;
  let bestScore = -1;
  try {
    const title = compact(game.name);
    // The full-text search often ranks compatibility lists above a dedicated fork whose name joins the title's words.
    const queries = platform === "ps5" ? [`KytyPS5 ${title} in:name fork:true`, query] : [query];
    const searches = await Promise.allSettled(queries.map(async q => {
      const response = await researchDeps.json(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=30`, { signal }) as { items: Repo[] };
      return response.items;
    }));
    if (searches.every(s => s.status === "rejected")) throw new Error("repository search unavailable");
    const items = [...new Map(searches.flatMap(s => s.status === "fulfilled" ? s.value : []).map(r => [r.full_name,r])).values()];
    const candidates = items.filter(r => !r.archived && /^[\w.-]+\/[\w.-]+$/.test(r.full_name) &&
      title.length >= 3 && compact(r.full_name.split("/")[1]).includes(title) &&
      /emulat|kyty|xenia|xemu|ryujinx|yuzu|sharpemu/i.test(r.full_name + " " + r.description)).slice(0, 4);
    for (const item of candidates) {
      const root = `https://api.github.com/repos/${item.full_name}`;
      const link = `https://github.com/${item.full_name}`;
      const detail = await researchDeps.json(root, { signal }) as Repo;
      const doc = await researchDeps.json(root + "/readme", { signal }).catch(() => null) as { content?: string } | null;
      const readme = doc?.content ? Buffer.from(doc.content, "base64").toString("utf8").slice(0, 24_000) : "";
      const exactId = !!identity?.serial && readme.includes(identity.serial);
      const exactVersion = exactId && !!identity?.version && readme.includes(identity.version);
      const score = (exactId ? 4 : 0) + (exactVersion ? 4 : 0) + (compact(item.full_name.split("/")[1]).endsWith(title) ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        const target = exactId ? ` (${identity!.serial}${exactVersion ? ", " + identity!.version : ""})` : "";
        lead = { reason: `${item.full_name} is a candidate for ${game.name}${target}. A playable Windows build is unverified.`, link };
      }
      const lineage = [detail.full_name, detail.parent?.full_name, detail.source?.full_name];
      if (!lineage.some(n => n && upstreams[platform]?.includes(n.toLowerCase()))) continue;
      const releases = await researchDeps.json(root + "/releases?per_page=5", { signal }) as Release[];
      for (const release of releases) {
        const notes = [release.name, release.body].filter(Boolean).join("\n");
        if (release.draft || /not (?:yet )?playable|untested|not (?:yet )?(?:been )?(?:tested|played)|preview|work.in.progress/i.test(notes)) continue;
        const ids = notes.match(/\bPPSA\d{5}\b/gi) ?? [];
        if (platform === "ps5" && identity?.serial && ids.length && !ids.some(id => id.toUpperCase() === identity.serial!.toUpperCase())) continue;
        const reportsTitle = notes.split(/[\r\n]+/).some(line => {
          const fields = line.replace(/^\s*[-*]\s*/, "").replace(/[*.]+$/g, "").split("|").map(normName).filter(Boolean);
          return gameNames(game).some(n => {
            const name = normName(n), words = normName(line);
            return words === name + " is playable on windows" || words === name + " playable on windows" ||
              (fields.includes(name) && fields.some(f => /^(?:playable|perfect)$/.test(f)) && fields.some(f => /^windows(?: (?:x64|11|10))?$/.test(f)));
          });
        });
        const assets = (release.assets ?? []).filter(a => /(?:win(?:dows)?[-_. ]?(?:64|x64|amd64)|windows).+|win64/i.test(a.name) &&
          /\.(?:zip|7z)$/i.test(a.name) && a.browser_download_url.startsWith(link + "/releases/download/"));
        if (reportsTitle && assets.length === 1) return { repo: item.full_name, reason: `${item.full_name} reports ${game.name} playable on Windows.`, link: release.html_url, assetUrl: assets[0].browser_download_url };
      }
    }
    if (catalog?.repo) return catalog;
    if (searches.some(s => s.status === "rejected")) {
      const known = lead ?? empty;
      return { ...known, reason: known.reason + " Part of the GitHub lookup was unavailable.", incomplete: true };
    }
    return lead && catalog ? { ...lead, reason: catalog.reason + " " + lead.reason } : lead ?? empty;
  } catch {
    const known = catalog?.repo ? catalog : lead ?? empty;
    return { ...known, reason: known.reason + " The GitHub lookup was incomplete and will be retried.", incomplete: true };
  }
}

export function lastResearch(gameId: number, platform: PlatformId): { at: number; result: EmulatorResearch } | null {
  const r = db.query("SELECT checked_at,result FROM emulator_research WHERE game_id=? AND platform=?").get(gameId, platform) as { checked_at: number; result: string } | null;
  return r ? { at: r.checked_at, result: JSON.parse(r.result) } : null;
}
