/** Ahoy — the data every page shares: the library (live), the storefront feeds, one app, one search. */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { del, get, post, put, type BestList, type BestListInfo, type DiscoverItem, type DiscoverSection, type Game, type GameDetail, type LookupHit } from "../api";
import { useEvents } from "../events";

/* ─────────── the library, live ─────────── */

export interface Lib { games: Game[]; loaded: boolean; error: string | null; reload: () => Promise<void>; byApp: Map<number, Game>; byId: Map<number, Game> }
export const LibCtx = createContext<Lib>({ games: [], loaded: false, error: null, reload: async () => {}, byApp: new Map(), byId: new Map() });
export const useLib = () => useContext(LibCtx);

export function useLibrarySource(): Lib {
  const [games, setGames] = useState<Game[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    try { setGames((await get<{ items: Game[] }>("/api/v1/game")).items); setError(null); }
    catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setLoaded(true); }
  };
  useEffect(() => { void reload(); }, []);
  useEvents(["request", "job", "package", "game", "fetch", "follow"], () => void reload());
  const byApp = useMemo(() => new Map(games.filter(g => g.steamAppId != null).map(g => [g.steamAppId!, g])), [games]);
  const byId = useMemo(() => new Map(games.map(g => [g.id, g])), [games]);
  return { games, loaded, error, reload, byApp, byId };
}

/* ─────────── the storefront feeds (cached across pages) ─────────── */

let feedCache: { at: number; sections: DiscoverSection[] } | null = null;
export function useDiscover() {
  const [sections, setSections] = useState<DiscoverSection[] | null>(feedCache?.sections ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (feedCache && Date.now() - feedCache.at < 5 * 60_000) return;
    get<{ sections: DiscoverSection[] }>("/api/v1/discover").then(r => { feedCache = { at: Date.now(), sections: r.sections }; setSections(r.sections); }).catch(e => setError(String(e?.message ?? e)));
  }, []);
  const section = (key: string) => sections?.find(s => s.key === key)?.items ?? [];
  return { sections, error, section };
}

/* ─────────── one game / one app ─────────── */

export function useGame(id: number) {
  const [item, setItem] = useState<GameDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get<{ item: GameDetail }>(`/api/v1/game/${id}`).then(r => { setItem(r.item); setError(null); }).catch(e => setError(String(e?.message ?? e)));
  useEffect(() => { setItem(null); void load(); }, [id]);
  useEvents(["request", "job", "package", "game", "fetch", "follow"], () => void load(), [id]);
  return { item, error, reload: load };
}

export interface Trailer { name: string; thumb: string; hls: string | null; mp4: string | null; webm: string | null }
export interface AppDetail extends DiscoverItem { developers: string[]; publishers: string[]; about: string | null; screenshots: string[]; trailers: Trailer[]; hero: string | null; header: string | null; platforms: string[] }
const appCache = new Map<number, AppDetail>();
export function useApp(appId: number | null | undefined) {
  const [item, setItem] = useState<AppDetail | null>(appId ? appCache.get(appId) ?? null : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!appId) { setItem(null); return; }
    const hit = appCache.get(appId);
    setItem(hit ?? null); setError(null);
    if (hit) return;
    get<{ item: AppDetail }>(`/api/v1/discover/app/${appId}`).then(r => { appCache.set(appId, r.item); setItem(r.item); }).catch(e => setError(String(e?.message ?? e)));
  }, [appId]);
  return { item, error };
}

/* ─────────── more rows: genres, and what just became playable ─────────── */

export interface Genre { tag: number; label: string }
const rowCache = new Map<string, { at: number; items: DiscoverItem[] }>();
function useCachedRow(key: string, path: string, pick: (r: any) => DiscoverItem[], enabled = true) {
  const [items, setItems] = useState<DiscoverItem[] | null>(rowCache.get(key)?.items ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const c = rowCache.get(key);
    if (c && Date.now() - c.at < 10 * 60_000) { setItems(c.items); return; }
    setItems(c?.items ?? null);
    get(path).then(r => { const it = pick(r); rowCache.set(key, { at: Date.now(), items: it }); setItems(it); }).catch(e => setError(String(e?.message ?? e)));
  }, [key, enabled]);
  return { items, error };
}
export const usePlayable = () => useCachedRow("playable", "/api/v1/discover/playable", (r: { items: DiscoverItem[] }) => r.items);
export const useGenre = (tag: number | null) => useCachedRow(`genre.${tag}`, `/api/v1/discover/genre/${tag}`, (r: { items: DiscoverItem[] }) => r.items, tag != null);
let genreCache: Genre[] | null = null;
export function useGenres() {
  const [items, setItems] = useState<Genre[]>(genreCache ?? []);
  useEffect(() => { if (genreCache) return; get<{ items: Genre[] }>("/api/v1/discover/genres").then(r => { genreCache = r.items; setItems(r.items); }).catch(() => {}); }, []);
  return items;
}

export const useSimilar = (appId: number | null | undefined) => useCachedRow(`similar.${appId}`, `/api/v1/discover/app/${appId}/similar`, (r: { items: DiscoverItem[] }) => r.items, !!appId);

/* ─────────── the best, by Metacritic ─────────── */

let bestListsCache: BestListInfo[] | null = null;
export function useBestLists() {
  const [items, setItems] = useState<BestListInfo[]>(bestListsCache ?? []);
  useEffect(() => { if (bestListsCache) return; get<{ items: BestListInfo[] }>("/api/v1/discover/best").then(r => { bestListsCache = r.items; setItems(r.items); }).catch(() => {}); }, []);
  return items;
}
const bestCache = new Map<string, { at: number; list: BestList }>();
/** one list; while the server is still matching titles to the store it is asked again every few seconds */
export function useBest(key: string | null) {
  const [list, setList] = useState<BestList | null>(key ? bestCache.get(key)?.list ?? null : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!key) { setList(null); return; }
    const c = bestCache.get(key);
    setList(c?.list ?? null); setError(null);
    if (c && Date.now() - c.at < 10 * 60_000 && !c.list.pending) return;
    let dead = false, tries = 0, t: ReturnType<typeof setTimeout> | null = null;
    const load = () => get<BestList>(`/api/v1/discover/best/${key}`).then(r => {
      if (dead) return;
      bestCache.set(key, { at: Date.now(), list: r }); setList(r); setError(null);
      if (r.pending > 0 && tries++ < 15) t = setTimeout(load, 4000);
    }).catch(e => { if (!dead) setError(String(e?.message ?? e)); });
    load();
    return () => { dead = true; if (t) clearTimeout(t); };
  }, [key]);
  return { list, error };
}

/* ─────────── search ─────────── */

export function useLookup(term: string) {
  const [hits, setHits] = useState<LookupHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  useEffect(() => {
    const q = term.trim();
    if (!q) { setHits(null); return; }
    const g = ++gen.current;
    setBusy(true);
    const t = setTimeout(() => get<{ items: LookupHit[] }>(`/api/v1/game/lookup?term=${encodeURIComponent(q)}`)
      .then(r => { if (g === gen.current) { setHits(r.items); setError(null); } })
      .catch(e => { if (g === gen.current) setError(String(e?.message ?? e)); })
      .finally(() => { if (g === gen.current) setBusy(false); }), 250);
    return () => clearTimeout(t);
  }, [term]);
  return { hits, error, busy };
}

/* ─────────── actions: one verb each ─────────── */

export const act = {
  /** add a Steam app to the server and start looking for it (or just watch it when it cannot be had yet) */
  getSteam: (appId: number, searchNow = true) => post<{ item: Game }>("/api/v1/game", { source: "steam", id: String(appId), monitored: true, searchNow }),
  getHit: (h: LookupHit, searchNow = true) => post<{ item: Game }>("/api/v1/game", { source: h.id.scheme, id: h.id.value, monitored: true, searchNow }),
  /** a game already on the server: look again (also what "Get it" means for a library game without a copy) */
  search: (gameId: number) => post(`/api/v1/game/${gameId}/search`),
  monitor: (gameId: number, on: boolean) => put(`/api/v1/game/${gameId}`, { monitored: on }),
  cancel: (requestId: number) => del(`/api/v1/queue/${requestId}`),
  remove: (gameId: number, files: boolean) => del(`/api/v1/game/${gameId}?deleteFiles=${files ? 1 : 0}`),
};
