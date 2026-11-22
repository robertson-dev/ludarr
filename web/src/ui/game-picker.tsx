/** Pick a game from the library by its name or another name it goes by. */
import { useEffect, useRef, useState } from "react";
import { get, type Game } from "../api";
import { Art, art } from "./art";
import { Icon } from "./icons";

export function GamePicker({ value, onChange, placeholder = "Search the library", autoFocus }: { value: Game | null; onChange: (g: Game | null) => void; placeholder?: string; autoFocus?: boolean }) {
  const [games, setGames] = useState<Game[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const on = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); }; addEventListener("mousedown", on); return () => removeEventListener("mousedown", on); }, []);
  const load = () => { if (!games) void get<{ items: Game[] }>("/api/v1/game").then(r => setGames(r.items)).catch(() => setGames([])); };
  const t = q.trim().toLowerCase();
  const hits = t ? (games ?? []).filter(g => g.name.toLowerCase().includes(t) || g.aliases?.some(a => a.toLowerCase().includes(t))).slice(0, 8) : [];
  const pick = (g: Game) => { onChange(g); setQ(""); setOpen(false); };
  if (value) return (
    <div className="picked">
      <Art className="cover-sm" src={art.poster(value.id, value.customArtAt)} title={value.name} />
      <div className="grow"><div>{value.name}</div><div className="dim">{value.releaseYear ?? ""}{value.platforms.length ? ` · ${value.platforms.slice(0, 4).join(", ")}` : ""}</div></div>
      <button type="button" className="ibtn" aria-label="Choose another game" title="Choose another game" onClick={() => onChange(null)}><Icon name="x" /></button>
    </div>
  );
  return (
    <div className="picker" ref={box}>
      <input className="input" value={q} placeholder={placeholder} autoFocus={autoFocus} aria-label="Search the library"
        onFocus={() => { load(); setOpen(true); }} onChange={e => { setQ(e.target.value); setOpen(true); setSel(0); }}
        onKeyDown={e => { if (e.key === "ArrowDown") setSel(s => Math.min(s + 1, hits.length - 1)); else if (e.key === "ArrowUp") setSel(s => Math.max(0, s - 1)); else if (e.key === "Enter") { e.preventDefault(); if (hits[sel]) pick(hits[sel]); } else if (e.key === "Escape") setOpen(false); }} />
      {open && t && (
        <div className="picker-results">
          {!games ? <div className="dim pad">Looking it up…</div> : !hits.length ? <div className="dim pad">No game in the library is called that.</div>
            : hits.map((g, i) => (
              <button type="button" key={g.id} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onClick={() => pick(g)}>
                <Art className="thumb" src={art.poster(g.id, g.customArtAt)} title={g.name} /><span className="grow ellipsis">{g.name}</span><span className="dim">{g.releaseYear ?? ""}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
