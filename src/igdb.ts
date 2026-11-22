/**
 * ludarr — IGDB metadata client (clean-room, on the public IGDB/Twitch protocol).
 *
 * Contract (public API, see api-docs.igdb.com):
 *   auth:  POST https://id.twitch.tv/oauth2/token  (client_credentials)
 *   api:   POST https://api.igdb.com/v4/{endpoint}  with Apicalypse body
 *   limits: 4 requests / second sustained
 *   images: https://images.igdb.com/igdb/image/upload/t_{size}/{image_id}.jpg
 *
 * Layered on battle-tested knobs proven by ForbesGRyon/gamearr:
 *   - token cached until `expires_in - 60s`
 *   - strict 4 rps limiter with queueing
 *   - one retry on transient failure (never loop)
 */
import { kv } from "./db";

const AUTH_URL = "https://id.twitch.tv/oauth2/token";
const API_URL = "https://api.igdb.com/v4";

export const IMG_SIZES = {
  cover: "cover_big_2x",       // 528x748 — posters
  cover_small: "cover_small",
  banner: "720p",              // artwork/banner grade
  shot: "screenshot_hugecap",  // 1280 wide
  thumb: "thumb",
} as const;

export function imageUrl(imageId: string, size: keyof typeof IMG_SIZES = "cover"): string {
  return `https://images.igdb.com/igdb/image/upload/t_${IMG_SIZES[size]}/${imageId}.jpg`;
}

class RateLimiter {
  private stamps: number[] = [];
  constructor(private max: number, private windowMs: number) {}
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter(t => now - t < this.windowMs);
      if (this.stamps.length < this.max) { this.stamps.push(now); return; }
      await new Promise(r => setTimeout(r, this.windowMs - (now - this.stamps[0]) + 5));
    }
  }
}

export interface IgdbGame {
  id: number;
  name: string;
  slug?: string;
  summary?: string;
  storyline?: string;
  total_rating?: number;
  first_release_date?: number;
  cover?: { image_id: string };
  artworks?: { image_id: string }[];
  screenshots?: { image_id: string }[];
  genres?: { name: string }[];
  themes?: { name: string }[];
  platforms?: { abbreviation?: string; name: string }[];
  game_modes?: { name: string }[];
  involved_companies?: {
    developer?: boolean; publisher?: boolean;
    company?: { name: string };
  }[];
}

export class IgdbClient {
  private clientId = "";
  private clientSecret = "";
  private token: string | null = null;
  private tokenExpires = 0;
  private limiter = new RateLimiter(4, 1000);

  constructor() {
    // restore persisted credentials, env wins on first boot
    this.clientId = process.env.IGDB_CLIENT_ID || kv.get("igdb.client_id") || "";
    this.clientSecret = process.env.IGDB_CLIENT_SECRET || kv.get("igdb.client_secret") || "";
    if (!process.env.IGDB_CLIENT_ID && kv.get("igdb.client_id")) {
      this.clientId = kv.get("igdb.client_id")!;
      this.clientSecret = kv.get("igdb.client_secret")!;
    }
  }

  configured() { return !!(this.clientId && this.clientSecret); }

  configure(clientId: string, clientSecret: string, persist = true) {
    if (clientId !== this.clientId || clientSecret !== this.clientSecret) {
      this.token = null; this.tokenExpires = 0;
    }
    this.clientId = clientId; this.clientSecret = clientSecret;
    if (persist) { kv.set("igdb.client_id", clientId); kv.set("igdb.client_secret", clientSecret); }
  }

  private async auth(force = false): Promise<string> {
    if (!this.configured()) throw new Error("IGDB_NOT_CONFIGURED");
    if (!force && this.token && Date.now() < this.tokenExpires) return this.token;

    const qs = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "client_credentials",
    });
    const res = await fetch(`${AUTH_URL}?${qs}`, { method: "POST" });
    if (!res.ok) throw new Error(`IGDB_AUTH_FAILED (${res.status}): ${await res.text()}`);
    const j = await res.json() as { access_token: string; expires_in: number };
    this.token = j.access_token;
    this.tokenExpires = Date.now() + (j.expires_in - 60) * 1000;
    return this.token!;
  }

  async call<T>(endpoint: string, apicalypse: string, retried = false): Promise<T> {
    const token = await this.auth();
    await this.limiter.take();
    const res = await fetch(`${API_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": this.clientId,
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
      body: apicalypse,
    });
    if (res.status === 401 && !retried) {
      await this.auth(true);           // token rotated server-side; force once
      return this.call<T>(endpoint, apicalypse, true);
    }
    if (!res.ok) throw new Error(`IGDB_CALL_FAILED (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<T>;
  }

  static SEARCH_FIELDS = `
    fields id,name,slug,summary,storyline,total_rating,first_release_date,
      cover.image_id,artworks.image_id,screenshots.image_id,
      genres.name,themes.name,platforms.abbreviation,platforms.name,
      game_modes.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name;
  `;

  async search(q: string, limit = 12): Promise<IgdbGame[]> {
    const safe = q.replace(/[";]/g, " ").trim();
    if (!safe) return [];
    return this.call<IgdbGame[]>("games",
      `${IgdbClient.SEARCH_FIELDS} search "${safe}"; limit ${Math.min(limit, 30)};`);
  }

  async details(ids: number[]): Promise<IgdbGame[]> {
    if (!ids.length) return [];
    return this.call<IgdbGame[]>("games",
      `${IgdbClient.SEARCH_FIELDS} where id = (${ids.join(",")}); limit ${ids.length};`);
  }

  /** Feed stock for the storefront — by IGDB popularity category. */
  async popular(category = "POPULARITY", limit = 24): Promise<number[]> {
    const j = await this.call<{ id: number; game: number }[]>("popularity_primitives",
      `fields game,value; sort value desc; limit ${Math.min(limit, 50)};
       where popularity_type = (select id from popularity_types where identifier = "${category}");`);
    return j.map(p => p.game);
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const rows = await this.call<IgdbGame[]>("games", "fields id,name; where id = 1942; limit 1;"); // Witcher 3
      return rows.length ? { ok: true, detail: `IGDB reachable, sample: ${rows[0].name}` }
                         : { ok: false, detail: "connected but sample game missing" };
    } catch (e: any) {
      return { ok: false, detail: String(e.message || e) };
    }
  }
}

/** Normalize IGDB payload → row shape for the games table. */
export function igdbToGameRow(g: IgdbGame) {
  const devs = (g.involved_companies ?? []).filter(c => c.developer).map(c => c.company?.name).filter(Boolean);
  const pubs = (g.involved_companies ?? []).filter(c => c.publisher).map(c => c.company?.name).filter(Boolean);
  return {
    igdb_id: g.id,
    name: g.name,
    slug: g.slug ?? null,
    summary: g.summary ?? null,
    storyline: g.storyline ?? null,
    release_year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    first_release_date: g.first_release_date ?? null,
    rating: g.total_rating ?? null,
    cover_url: g.cover ? imageUrl(g.cover.image_id, "cover") : null,
    banner_url: g.artworks?.length ? imageUrl(g.artworks[0].image_id, "banner")
              : g.screenshots?.length ? imageUrl(g.screenshots[0].image_id, "banner") : null,
    screenshots_json: JSON.stringify((g.screenshots ?? []).map(s => imageUrl(s.image_id, "shot"))),
    genres_json: JSON.stringify((g.genres ?? []).map(x => x.name)),
    themes_json: JSON.stringify((g.themes ?? []).map(x => x.name)),
    platforms_json: JSON.stringify((g.platforms ?? []).map(p => p.abbreviation ?? p.name)),
    game_modes_json: JSON.stringify((g.game_modes ?? []).map(x => x.name)),
    developer: devs.join(", ") || null,
    publisher: pubs.join(", ") || null,
  };
}
