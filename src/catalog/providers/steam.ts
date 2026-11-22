/**
 * Steam: the PC games ludarr already knows — the storefront feeds' catalog cache and the library.
 * One native route each; the copy itself comes through the request pipeline (Prowlarr → seedbox → processor).
 */
import { db, type GameRow } from "../../db";
import { steamArtMany, type AppArt } from "../../steam";
import type { Contribution, Provider } from "../types";

interface CatalogRow { steam_appid: number; name: string; type: string | null; release_iso: string | null; release_sort: string | null; genres_json: string; short_description: string | null; header_image: string | null }

const list = (s: string | null | undefined): string[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
const yearOf = (iso: string | null | undefined) => (iso && /^\d{4}/.test(iso) ? Number(iso.slice(0, 4)) : null);

const route = (appId: number) => ({
  key: `app/${appId}`, kind: "native" as const, platform: "pc" as const, label: "Steam",
  link: `https://store.steampowered.com/app/${appId}/`,
  content: { kind: "files" as const, platform: "pc" as const, from: [{ type: "tracker" as const }] },
});

export const steamProvider: Provider = {
  id: "steam",
  label: "Steam",
  about: "PC games from the Steam storefront feeds and the library. Native route; the copy comes through the usual request pipeline.",
  every: 60,
  metaRank: 80,
  async collect() {
    const out = new Map<number, Contribution>();
    const games = db.query("SELECT * FROM games WHERE steam_appid IS NOT NULL").all() as GameRow[];
    for (const g of games) {
      out.set(g.steam_appid!, {
        title: {
          ids: [{ scheme: "steam", value: String(g.steam_appid) }, ...(g.igdb_id ? [{ scheme: "igdb" as const, value: String(g.igdb_id) }] : [])],
          name: g.name, platforms: ["pc"], year: g.release_year ?? null, gameId: g.id,
          meta: { summary: g.summary, developer: g.developer, publisher: g.publisher, genres: list(g.genres_json), cover: g.cover_url, hero: g.banner_url, screenshots: list(g.screenshots_json),
            logo: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.steam_appid}/logo.png` },
        },
        routes: [route(g.steam_appid!)],
      });
    }
    const rows = (db.query("SELECT * FROM catalog WHERE type IS NULL OR type='game'").all() as CatalogRow[]).filter(r => !out.has(r.steam_appid));
    const arts = await steamArtMany(rows.map(r => r.steam_appid), new Map(rows.map(r => [r.steam_appid, r.header_image]))).catch(() => new Map<number, AppArt>());
    rows.forEach((r, i) => {
      const art = arts.get(r.steam_appid);
      out.set(r.steam_appid, {
        title: {
          ids: [{ scheme: "steam", value: String(r.steam_appid) }],
          name: r.name, platforms: ["pc"], year: yearOf(r.release_iso ?? r.release_sort), releaseIso: r.release_iso,
          meta: { summary: r.short_description, genres: list(r.genres_json), cover: art?.portrait ?? null, hero: art?.hero ?? r.header_image,
            logo: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${r.steam_appid}/logo.png` },
        },
        routes: [route(r.steam_appid)],
      });
    });
    return [...out.values()];
  },
};
