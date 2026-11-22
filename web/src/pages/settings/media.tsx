/** Settings → Media Management: root folders and the media settings. */
import { useEffect, useState } from "react";
import { del, get, post, fmtSize, type Game, type RootFolder } from "../../api";
import { Icon } from "../../ui/icons";
import { Btn, Empty, IconBtn, Modal, Row, Section, Spinner, useLoad, useUi } from "../../ui/kit";
import { ConfigSection } from "./config";

interface Unmapped { name: string; path: string; modifiedAt: number | null }

/** folders in the root folders that no game accounts for (a hand-made copy, a leftover): import one as a game's copy */
function UnmappedFolders({ roots }: { roots: RootFolder[] }) {
  const { toast } = useUi();
  const [items, setItems] = useState<(Unmapped & { root: RootFolder })[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Unmapped | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [gameId, setGameId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const rootKey = roots.map(r => r.id).join(",");
  const load = async () => {
    setLoading(true);
    const all: (Unmapped & { root: RootFolder })[] = [];
    for (const r of roots) {
      try { const { items } = await get<{ items: Unmapped[] }>(`/api/v1/rootfolder/${r.id}/unmapped`); all.push(...items.map(i => ({ ...i, root: r }))); }
      catch { /* an unreadable root folder is reported by the health check */ }
    }
    setItems(all); setLoading(false);
  };
  useEffect(() => { void load(); }, [rootKey]);
  useEffect(() => { if (target && !games.length) void get<{ items: Game[] }>("/api/v1/game").then(r => setGames(r.items)).catch(() => {}); }, [target]);
  const start = async () => {
    if (!target || gameId === "") return;
    setBusy(true);
    try { await post("/api/v1/import", { path: target.path, gameId }); toast("Import started — see Activity", "success"); setTarget(null); setGameId(""); void load(); }
    catch (e: any) { toast(e.message, "danger"); } finally { setBusy(false); }
  };
  if (!roots.length) return null;
  return (
    <Section title="Unmapped folders" right={<Btn size="sm" icon="refresh" onClick={() => void load()}>Refresh</Btn>}>
      {loading ? <Spinner /> : !items.length ? <p className="dim">Every folder in the root folders belongs to a game.</p> : (
        <table className="table">
          <thead><tr><th>Folder</th><th>Root folder</th><th>Modified</th><th className="actions"></th></tr></thead>
          <tbody>{items.map(i => (
            <tr key={i.path}>
              <td className="mono">{i.name}</td>
              <td className="mono dim">{i.root.path}</td>
              <td>{i.modifiedAt ? new Date(i.modifiedAt * 1000).toLocaleDateString() : "—"}</td>
              <td className="actions"><Btn size="sm" icon="download" onClick={() => setTarget(i)}>Import</Btn></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <Modal open={!!target} onClose={() => setTarget(null)} title="Import a folder" sm foot={<><Btn onClick={() => setTarget(null)}>Cancel</Btn><Btn kind="primary" busy={busy} disabled={gameId === ""} onClick={() => void start()}>Import</Btn></>}>
        <p className="mono" style={{ marginBottom: 10 }}>{target?.path}</p>
        <Row label="Game" help="The library game this folder is a copy of. It goes through the importer like any download and becomes the game's copy.">
          <select className="input" value={gameId} onChange={e => setGameId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Choose a game…</option>
            {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Row>
      </Modal>
    </Section>
  );
}

export function MediaPage() {
  const { toast, confirm } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ items: RootFolder[] }>("/api/v1/rootfolder"), []);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try { await post("/api/v1/rootfolder", { path }); toast("Root folder added", "success"); setAdding(false); setPath(""); void reload(); }
    catch (e: any) { toast(e.message, "danger"); } finally { setBusy(false); }
  };
  const remove = async (r: RootFolder) => {
    if (!(await confirm("Remove root folder?", <>Games are not deleted; <code>{r.path}</code> just stops being a root folder.</>, { ok: "Remove" }))) return;
    try { await del(`/api/v1/rootfolder/${r.id}`); void reload(); } catch (e: any) { toast(e.message, "danger"); }
  };
  return (
    <div className="content narrow">
      <h2 className="page-title">Media Management</h2>
      <Section title="Root Folders" right={<Btn size="sm" icon="plus" onClick={() => setAdding(true)}>Add root folder</Btn>}>
        {loading && !data ? <Spinner /> : !data?.items.length ? <Empty title="No root folder" icon="folder">Add one — imported games have nowhere to go without it.</Empty> : (
          <table className="table">
            <thead><tr><th>Path</th><th>Free space</th><th>Games</th><th className="actions"></th></tr></thead>
            <tbody>{data.items.map(r => (
              <tr key={r.id}>
                <td className="mono">{r.path}{!r.accessible && <span className="label danger" style={{ marginLeft: 8 }}>not accessible</span>}</td>
                <td>{r.freeSpace != null ? `${fmtSize(r.freeSpace)} of ${fmtSize(r.totalSpace)}` : "—"}</td>
                <td>{r.games}</td>
                <td className="actions"><IconBtn icon="trash" label="Remove" danger onClick={() => void remove(r)} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
      <UnmappedFolders roots={data?.items ?? []} />
      <ConfigSection group="media" title="Importing & transfers" blurb="Where downloads land, scratch space for imports, and how many run at once." />
      <Modal open={adding} onClose={() => setAdding(false)} title="Add root folder" sm foot={<><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn kind="primary" busy={busy} disabled={!path.trim()} onClick={add}>Add</Btn></>}>
        <Row label="Path" help="A folder ludarr can write to — inside Docker, a mounted volume such as /games."><input className="input" value={path} onChange={e => setPath(e.target.value)} placeholder="/games" autoFocus onKeyDown={e => { if (e.key === "Enter" && path.trim()) void add(); }} /></Row>
        <p className="dim" style={{ marginTop: 6 }}><Icon name="info" size={13} /> Keep the work folder on the same volume: the final move of an import is then a rename, not a copy.</p>
      </Modal>
    </div>
  );
}
