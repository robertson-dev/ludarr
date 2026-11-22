/** Wanted: monitored games without a copy (Missing) and copies worse than the profile's cutoff (Cutoff Unmet). */
import { useState } from "react";
import { Link } from "react-router-dom";
import { get, post, fmtSize, timeAgo, type Game } from "../api";
import { useEvents } from "../events";
import { Empty, Label, Spinner, ToolbarBtn, useLoad, useUi } from "../ui/kit";
import { statusLabel, statusTone } from "../ui/status";
import { Art, art } from "../ui/art";

export function WantedPage({ kind }: { kind: "missing" | "cutoff" }) {
  const { toast } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ items: Game[] }>(`/api/v1/wanted/${kind}`), [kind]);
  useEvents(["request", "job", "package", "game"], () => void reload());
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const items = data?.items ?? [];
  const searchGames = async (ids: number[]) => {
    if (!ids.length) return;
    setBusy(true);
    let ok = 0;
    for (const id of ids) { try { await post(`/api/v1/game/${id}/search`); ok++; } catch (e: any) { toast(e.message, "danger"); } }
    toast(`Searching for ${ok} game${ok === 1 ? "" : "s"}`, "success"); setSel(new Set()); setBusy(false); void reload();
  };
  const toggle = (id: number) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <>
      <div className="toolbar"><div className="tb-left">
        <ToolbarBtn icon="search" label="Search Selected" busy={busy} disabled={!sel.size} onClick={() => void searchGames([...sel])} />
        <ToolbarBtn icon="search" label="Search All" busy={busy} disabled={!items.length} onClick={() => void searchGames(items.map(g => g.id))} />
        <ToolbarBtn icon="refresh" label="Refresh" onClick={() => void reload()} />
      </div></div>
      <div className="content">
        <h2 className="page-title">{kind === "missing" ? "Missing" : "Cutoff Unmet"}</h2>
        {loading && !data ? <Spinner /> : !items.length ? <Empty title={kind === "missing" ? "Nothing is missing" : "Every copy meets its cutoff"} icon="check">{kind === "missing" ? "Every monitored, released game has a copy or a search in flight." : "Turn on upgrades in a profile to look for better copies."}</Empty> : (
          <table className="table">
            <thead><tr><th className="ck"><input type="checkbox" checked={sel.size === items.length} onChange={e => setSel(e.target.checked ? new Set(items.map(g => g.id)) : new Set())} aria-label="Select all" /></th><th></th><th>Game</th><th>Year</th><th>Status</th><th>Profile</th>{kind === "cutoff" ? <th>Current copy</th> : <th>Last search</th>}</tr></thead>
            <tbody>{items.map(g => (
              <tr key={g.id}>
                <td className="ck"><input type="checkbox" checked={sel.has(g.id)} onChange={() => toggle(g.id)} aria-label={`select ${g.name}`} /></td>
                <td style={{ width: 44 }}><Art className="cover-sm" src={art.poster(g.id, g.customArtAt)} title={g.name} /></td>
                <td><Link to={`/games/${g.id}`}>{g.name}</Link></td>
                <td>{g.releaseYear ?? ""}</td>
                <td><Label tone={statusTone(g.status)}>{statusLabel(g.status)}</Label> <span className="dim">{g.statusDetail}</span></td>
                <td>{g.profile?.name ?? "—"}</td>
                {kind === "cutoff" ? <td>{g.file ? `${g.file.format} · ${fmtSize(g.file.size)}` : "—"}</td> : <td className="dim">{g.request ? `${g.request.state} · ${timeAgo(g.request.updatedAt)}${g.request.message ? ` — ${g.request.message.slice(0, 60)}` : ""}` : "never"}</td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
