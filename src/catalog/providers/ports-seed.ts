/**
 * Breadth for recomps and decomp ports: SubmitGame/awesome-decomp-games (CC0, rebuilt daily from 13
 * community lists). Only projects that actually ship a release, are not archived and have some traction
 * make it in; the curated registry (ports.ts) and this server's own plans (src/ways) win for anything they
 * already cover. These routes carry no install detail beyond the project and its latest release, so their
 * status is "unknown".
 */
import type { Contribution, Platform, Provider, RuntimeInput } from "../types";
import { PORTS } from "./ports";
import { wstmts, type PlanRow } from "../../ways/store";

const SEED_URL = "https://raw.githubusercontent.com/SubmitGame/awesome-decomp-games/main/data/games.json";
const MIN_STARS = 25;

export interface SeedRow {
  id: string; title: string; game_key?: string; platform: string; type: string; repo?: string | null; url?: string | null; description?: string | null;
  stars?: number | null; archived?: boolean; release?: string | null; release_date?: string | null; release_url?: string | null; homepage?: string | null;
}

const PLATFORM: Record<string, Platform> = {
  "PC": "pc", "DOS": "dos", "N64": "n64", "NES": "nes", "SNES": "snes", "GameCube": "gc", "Wii": "wii", "Wii U": "wiiu", "Switch": "switch",
  "Game Boy": "gb", "Game Boy Color": "gbc", "GBA": "gba", "DS": "nds", "3DS": "3ds", "PS1": "ps1", "PS2": "ps2", "PS3": "ps3", "PS4": "ps4",
  "PSP": "psp", "Xbox": "xbox", "Xbox 360": "x360", "Genesis": "genesis", "Mega Drive": "genesis", "Saturn": "saturn", "Dreamcast": "dc", "Arcade": "arcade",
};
/** ports whose target is not a Windows PC: phones, handhelds, other consoles, Macs, browsers, VR headsets */
const NOT_WINDOWS = /(android|3ds|psvita|vita|switch|macos|dreamcast|webgl|browser|uefi|wiiu|team-beef|lambda1vr|(^|[-_ \[(])(ios|psp|nx|mac|dc|web|vr|wii|ps2|ps3|n64|xbox|gba|nds)($|[-_ \])]))/i;
const KIND: Record<string, "recomp" | "port"> = { "static-recomp": "recomp", "source-port": "port", "decompilation": "port", "engine-remake": "port" };

/** "The Legend of Zelda: Ocarina of Time (Ship of Harkinian)" → game + project label */
export function splitTitle(t: string): { game: string; label: string | null } {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(t.trim());
  return m && m[1] ? { game: m[1].trim(), label: m[2].trim() } : { game: t.trim(), label: null };
}

export function seedContributions(rows: SeedRow[], skipRepos: Set<string>): { items: Contribution[]; runtimes: RuntimeInput[] } {
  const items: Contribution[] = [];
  const runtimes: RuntimeInput[] = [];
  for (const r of rows) {
    const kind = KIND[r.type];
    const platform = PLATFORM[(r.platform ?? "").split("/")[0].trim()];
    if (!kind || !platform || !r.repo || !r.release || r.archived || (r.stars ?? 0) < MIN_STARS) continue;
    if (skipRepos.has(r.repo.toLowerCase())) continue;
    const { game, label } = splitTitle(r.title);
    if (!game || NOT_WINDOWS.test(`${r.repo} ${label ?? ""}`)) continue;
    const id = `gh-${r.repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const name = label ?? r.repo.split("/")[1];
    runtimes.push({
      id, name, kind, platforms: [platform], homepage: r.homepage || r.url || `https://github.com/${r.repo}`, repo: r.repo, channel: "seed",
      notes: r.description ?? null,
      latest: { tag: r.release, name: r.release, date: r.release_date ?? null, prerelease: false, asset: null, page: r.release_url ?? `https://github.com/${r.repo}/releases` },
    });
    items.push({
      title: { ids: [], name: game, platforms: [platform] },
      routes: [{
        key: r.repo.toLowerCase(), kind, platform, runtime: id, label: name, status: "unknown",
        statusNote: `${r.stars} stars on GitHub · not reviewed`, link: `https://github.com/${r.repo}`,
        content: { kind: platform === "pc" || platform === "dos" ? "files" : "rom", platform, from: [{ type: "tracker", query: game }] },
      }],
    });
  }
  return { items, runtimes };
}

/** repos the curated registry or one of this server's plans already covers (a plan's repo is GitHub's owner/name) */
export function skipRepos(): Set<string> {
  return new Set([...PORTS.map(p => p.repo), ...(wstmts.plansAll.all() as PlanRow[]).map(p => p.repo)].map(r => r.toLowerCase()));
}

let lastRuntimes: RuntimeInput[] = [];
export const portsSeedProvider: Provider = {
  id: "ports-seed", label: "Community ports list", every: 24 * 60, metaRank: 15,
  about: "More recomps and decomp ports from the community list awesome-decomp-games (CC0): released, not archived, 25+ stars. Not reviewed.",
  runtimes: () => lastRuntimes,
  async collect(ctx) {
    const res = await ctx.fetch(SEED_URL, { headers: { "User-Agent": "AhoyCatalogBot/0.1" }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from the community list`);
    const data = await res.json() as { games?: SeedRow[] };
    const { items, runtimes } = seedContributions(data.games ?? [], skipRepos());
    lastRuntimes = runtimes;
    ctx.log(`${items.length} projects kept of ${data.games?.length ?? 0}`);
    return items;
  },
};
