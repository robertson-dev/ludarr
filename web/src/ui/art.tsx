/** Game art always comes through ludarr's art endpoints (resolved + cached server-side, never a 404); a CSS placeholder is the second safety net. */
import { useEffect, useState, type CSSProperties } from "react";
import { urlBase } from "../api";

/** `v` is the game's customArtAt: art set by hand is cached by the browser, so a new upload needs a new address */
const ver = (v?: number | null) => (v ? `?v=${v}` : "");
export const art = {
  poster: (gameId: number, v?: number | null) => `${urlBase}/api/v1/art/game/${gameId}/poster${ver(v)}`,
  banner: (gameId: number, v?: number | null) => `${urlBase}/api/v1/art/game/${gameId}/banner${ver(v)}`,
  /** hero and logo exist only when set by hand (the server answers 404 otherwise) */
  hero: (gameId: number, v?: number | null) => `${urlBase}/api/v1/art/game/${gameId}/hero${ver(v)}`,
  logo: (gameId: number, v?: number | null) => `${urlBase}/api/v1/art/game/${gameId}/logo${ver(v)}`,
  title: (titleId: number | string) => `${urlBase}/api/v1/art/title/${titleId}/poster`,
  steam: (appId: number | string, name?: string) => `${urlBase}/api/v1/art/steam/${appId}/poster${name ? `?n=${encodeURIComponent(name)}` : ""}`,
  proxy: (u: string) => `${urlBase}/api/v1/art/url?u=${encodeURIComponent(u)}`,
};

/** the best art for an "Add new" hit: the library game's poster, a catalog title's poster, a Steam app's capsule, or a proxied source image */
export function hitArt(h: { id: { scheme: string; value: string }; name?: string; cover: string | null; gameId?: number | null }): string | null {
  if (h.gameId) return art.poster(h.gameId);
  if (h.id.scheme === "catalog") return art.title(h.id.value);
  if (h.id.scheme === "steam") return art.steam(h.id.value, h.name);
  return h.cover ? art.proxy(h.cover) : null;
}

export function Art({ src, title, className, style, lazy = true }: { src: string | null; title: string; className?: string; style?: CSSProperties; lazy?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <div className={`art-ph${className ? " " + className : ""}`} style={style} title={title} role="img" aria-label={title}><span>{title}</span></div>;
  return <img src={src} alt="" loading={lazy ? "lazy" : undefined} className={className} style={style} onError={() => setFailed(true)} />;
}
