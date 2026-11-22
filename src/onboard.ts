/** ludarr — a Steam app id → a game row with its metadata and art. */
import { stmts, type GameRow } from "./db";
import { steamDetailsMany, steamToGameRow, steamArt } from "./steam";

export async function onboardSteamApps(appIds: number[]): Promise<{ saved: GameRow[]; missing: number[] }> {
  const saved: GameRow[] = [];
  const missing: number[] = [];
  const details = await steamDetailsMany(appIds);
  for (let i = 0; i < details.length; i++) {
    const d = details[i];
    if (!d) { missing.push(appIds[i]); continue; }
    const row = steamToGameRow(d);
    const art = await steamArt(d.steam_appid, d.header_image);   // location-aware art; the store header when the CDN has nothing
    row.cover_url = art.portrait;                     // box art
    row.banner_url = art.hero;                        // wide hero
    saved.push(stmts.upsertGame(row));
  }
  return { saved, missing };
}
