/**
 * Add New: look a game up (catalog, Steam, IGDB) and add it; Discover: the Steam storefront feeds; Manual: a game
 * described by hand; From a repo: a recomp, port or emulator that becomes a way to play.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { get, post, type DiscoverSection, type Game, type LookupHit } from "../api";
import { Icon } from "../ui/icons";
import { Btn, Empty, Label, Modal, Spinner, useLoad, useUi } from "../ui/kit";
import { statusLabel, statusTone, KIND_TONE, crackChip } from "../ui/status";
import { Art, art, hitArt } from "../ui/art";
import { LibraryFields, libraryBody, useLibraryFields } from "../ui/library-fields";
import { ManualTab } from "./add-manual";
import { RepoTab } from "./add-repo";

interface AddTarget { source: string; id: string; name: string; cover: string | null; year: number | null }

export function AddModal({ target, onClose, onAdded }: { target: AddTarget | null; onClose: () => void; onAdded: (g: Game) => void }) {
  const { toast } = useUi();
  const lib = useLibraryFields();
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await post<{ item: Game }>("/api/v1/game", { source: target.source, id: target.id, ...libraryBody(lib.value) });
      const searching = lib.value.monitored && lib.value.searchNow && (r.item.status === "searching" || r.item.status === "missing");
      toast(<>Added <b>{r.item.name}</b>{searching ? " — searching" : ""}</>, "success");
      onAdded(r.item); onClose();
    } catch (e: any) { toast(e.message, "danger"); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!target} onClose={onClose} title={<>Add — {target?.name}{target?.year ? ` (${target.year})` : ""}</>} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="success" icon="plus" busy={busy} onClick={add}>Add {target?.name}</Btn></>}>
      <div className="row" style={{ gap: 18, alignItems: "flex-start" }}>
        <Art src={target?.cover ?? null} title={target?.name ?? ""} style={{ width: 110, height: 165, borderRadius: 4, flex: "none", objectFit: "cover" }} lazy={false} />
        <div className="grow"><LibraryFields lib={lib} /></div>
      </div>
    </Modal>
  );
}

function Hit({ h, onAdd }: { h: LookupHit; onAdd: () => void }) {
  return (
    <div className="card" style={{ display: "flex", gap: 16, cursor: "default" }}>
      <div style={{ width: 90, flex: "none" }}><Art src={hitArt(h)} title={h.name} style={{ width: 90, height: 135, borderRadius: 3, display: "block", objectFit: "cover" }} /></div>
      <div className="grow">
        <h4 style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>{h.gameId ? <Link to={`/games/${h.gameId}`}>{h.name}</Link> : h.name}{h.year && <span className="muted" style={{ fontSize: 15 }}>{h.year}</span>}</h4>
        <div className="wrap" style={{ marginTop: 6 }}>
          <Label tone={h.source === "steam" ? "primary" : h.source === "igdb" ? "accent" : "outline"}>{h.source}</Label>
          {h.platforms.slice(0, 6).map(p => <Label key={p} tone="dim">{p}</Label>)}
          {(h.kinds ?? []).map(k => <Label key={k} tone={KIND_TONE[k] ?? "default"}>{k}</Label>)}
          {h.releaseIso && <span className="dim">releases {h.releaseIso}</span>}
        </div>
        {h.summary && <p className="dim" style={{ marginTop: 8, maxHeight: "3.2em", overflow: "hidden" }}>{h.summary}</p>}
        <div className="meta" style={{ marginTop: 10 }}>
          {h.gameId ? <><Label tone={statusTone(h.status ?? "missing")}>In library · {statusLabel(h.status ?? "")}</Label><Link to={`/games/${h.gameId}`} className="btn sm">Open</Link></>
            : <Btn kind="success" size="sm" icon="plus" onClick={onAdd}>Add</Btn>}
        </div>
      </div>
    </div>
  );
}

function SearchTab() {
  const [params, setParams] = useSearchParams();
  const term = params.get("term") ?? "";
  const [q, setQ] = useState(term);
  const [target, setTarget] = useState<AddTarget | null>(null);
  const nav = useNavigate();
  useEffect(() => { setQ(term); }, [term]);
  const { data, loading, error, reload } = useLoad(() => (term.trim() ? get<{ items: LookupHit[] }>(`/api/v1/game/lookup?term=${encodeURIComponent(term.trim())}`) : Promise.resolve({ items: [] })), [term]);
  return (
    <>
      <form className="filterbar" onSubmit={e => { e.preventDefault(); setParams(q.trim() ? { term: q.trim() } : {}); }}>
        <input className="input" style={{ flex: 1, maxWidth: 560, height: 40 }} placeholder="Search for a game — Steam, IGDB and the catalog (consoles, recomps, ports)" value={q} onChange={e => setQ(e.target.value)} autoFocus aria-label="Search for a game" />
        <Btn kind="primary" icon="search" type="submit" busy={loading && !!term}>Search</Btn>
      </form>
      {!term ? <Empty title="Find a game to add" icon="search">Type a name above. Results come from the catalog (10,000+ console titles, recomps and ports), the Steam store and IGDB when it is configured.</Empty>
        : loading ? <Spinner text="Looking it up…" /> : error ? <Empty title="Lookup failed" icon="alert">{error}</Empty>
        : !data?.items.length ? <Empty title="Nothing found" icon="search">No source knew “{term}”. <Link to={`/add/manual?name=${encodeURIComponent(term.trim())}`}>Add it by hand</Link></Empty>
        : <>
          <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))" }}>{data.items.map(h => <Hit key={`${h.id.scheme}:${h.id.value}`} h={h} onAdd={() => setTarget({ source: h.id.scheme === "steam" ? "steam" : h.id.scheme === "igdb" ? "igdb" : "catalog", id: h.id.value, name: h.name, cover: hitArt(h), year: h.year })} />)}</div>
          <p className="dim" style={{ marginTop: 14 }}>Not the game you mean? <Link to={`/add/manual?name=${encodeURIComponent(term.trim())}`}>Add it by hand</Link></p>
        </>}
      <AddModal target={target} onClose={() => setTarget(null)} onAdded={g => { void reload(); nav(`/games/${g.id}`); }} />
    </>
  );
}

/** a library game's poster, else the app's library capsule from the store (a placeholder when it has none — never the wide header cropped) */
const feedArt = (it: { appId: number; name: string; gameId: number | null }) => it.gameId ? art.poster(it.gameId) : art.steam(it.appId, it.name);

function DiscoverTab() {
  const { toast } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ sections: DiscoverSection[] }>("/api/v1/discover"), []);
  const [target, setTarget] = useState<AddTarget | null>(null);
  const nav = useNavigate();
  const refresh = async () => { try { await post("/api/v1/discover/refresh"); void reload(); toast("Feeds refreshed"); } catch (e: any) { toast(e.message, "danger"); } };
  if (loading && !data) return <Spinner text="Reading the storefront feeds…" />;
  return (
    <>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}><Btn icon="refresh" onClick={refresh}>Refresh feeds</Btn></div>
      {(data?.sections ?? []).map(s => (
        <div key={s.key} className="form-section">
          <h3>{s.title}<span className="dim" style={{ fontSize: 13, fontWeight: 400 }}>{s.sub}</span></h3>
          {!s.items.length ? <p className="muted">Nothing here yet.</p> : (
            <div className="posters" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
              {s.items.map(it => (
                <div className="poster" key={it.appId}>
                  <div className="img" onClick={() => (it.gameId ? nav(`/games/${it.gameId}`) : setTarget({ source: "steam", id: String(it.appId), name: it.name, cover: feedArt(it), year: null }))} style={{ cursor: "pointer" }}>
                    <Art src={feedArt(it)} title={it.name} />
                    {it.inLibrary && <span className="badge"><Label tone="success"><Icon name="check" size={11} /> in library</Label></span>}
                    {(() => { const c = crackChip(it.drm, it.crackStatus); return c ? <span className="drm"><Label tone={c.tone}>{c.text}</Label></span> : null; })()}
                  </div>
                  <div className="t">{it.name}</div>
                  <div className="s">{it.releaseText ?? ""}{it.metacritic ? ` · ${it.metacritic}` : ""}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <AddModal target={target} onClose={() => setTarget(null)} onAdded={g => nav(`/games/${g.id}`)} />
    </>
  );
}

export type AddTab = "search" | "discover" | "manual" | "repo";

export function AddPage({ tab }: { tab: AddTab }) {
  return (
    <>
      <div className="toolbar"><div className="tb-left">
        <Link to="/add" className={`tbtn${tab === "search" ? " on" : ""}`}><Icon name="search" />Search</Link>
        <Link to="/add/discover" className={`tbtn${tab === "discover" ? " on" : ""}`}><Icon name="compass" />Discover</Link>
        <span className="sep" />
        <Link to="/add/manual" className={`tbtn${tab === "manual" ? " on" : ""}`}><Icon name="pencil" />Manual</Link>
        <Link to="/add/repo" className={`tbtn${tab === "repo" ? " on" : ""}`}><Icon name="gitBranch" />From a Repo</Link>
      </div></div>
      <div className="content">{tab === "search" ? <SearchTab /> : tab === "discover" ? <DiscoverTab /> : tab === "manual" ? <ManualTab /> : <RepoTab />}</div>
    </>
  );
}
