/** Settings → Profiles: what may be grabbed, in which order, and what counts as good enough. */
import { useEffect, useState } from "react";
import { del, get, post, put, type Profile } from "../../api";
import { TagsInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Btn, IconBtn, Label, Modal, Row, Spinner, Toggle, useLoad, useUi } from "../../ui/kit";

interface Schema { formats: { value: string; label: string; doc: string }[]; kinds: string[]; protocols: string[] }
const PROTO_LABEL: Record<string, string> = { any: "Any", "prefer-usenet": "Prefer usenet", "prefer-torrent": "Prefer torrents", usenet: "Usenet only", torrent: "Torrents only" };
const empty = (): Omit<Profile, "id"> => ({ name: "", formats: ["clean", "iso", "unknown", "repack", "installer", "rom"], cutoff: "clean", upgrade: false, consoleFallback: true, protocol: "prefer-usenet", kinds: ["native", "recomp", "port", "emulated"], maxSizeGb: null, minSeeders: 0, mustContain: [], mustNotContain: [], preferredGroups: [], blockedGroups: [], minScore: 70 });

function Editor({ schema, profile, onClose, onSaved }: { schema: Schema; profile: Profile | "new" | null; onClose: () => void; onSaved: () => void }) {
  const { toast, confirm } = useUi();
  const [p, setP] = useState<Omit<Profile, "id"> & { id?: number }>(empty());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (profile === "new") setP(empty()); else if (profile) setP({ ...profile }); }, [profile]);
  const all = schema.formats.map(f => f.value);
  const enabled = p.formats;
  const disabled = all.filter(f => !enabled.includes(f));
  const move = (i: number, d: number) => { const n = [...enabled]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setP({ ...p, formats: n }); };
  const toggleFormat = (f: string, on: boolean) => setP({ ...p, formats: on ? [...enabled, f] : enabled.filter(x => x !== f), cutoff: !on && p.cutoff === f ? (enabled.filter(x => x !== f)[0] ?? f) : p.cutoff });
  const save = async () => {
    if (!p.name.trim()) return toast("A name is required", "warning");
    if (!p.formats.length) return toast("Allow at least one format", "warning");
    setBusy(true);
    try { if (p.id) await put(`/api/v1/profile/${p.id}`, p); else await post("/api/v1/profile", p); toast("Profile saved", "success"); onSaved(); onClose(); }
    catch (e: any) { toast(e.message, "danger"); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!p.id || !(await confirm(`Delete profile ${p.name}?`, "Games using it must be moved to another profile first."))) return;
    try { await del(`/api/v1/profile/${p.id}`); toast("Profile deleted", "success"); onSaved(); onClose(); } catch (e: any) { toast(e.message, "danger"); }
  };
  return (
    <Modal open={!!profile} onClose={onClose} title={p.id ? `Edit profile — ${p.name}` : "New profile"} wide
      foot={<>{p.id && <span className="left"><Btn kind="danger" onClick={remove}>Delete</Btn></span>}<Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" busy={busy} onClick={save}>Save</Btn></>}>
      <Row label="Name"><input className="input" value={p.name} onChange={e => setP({ ...p, name: e.target.value })} autoFocus /></Row>
      <Row label="Formats" help="What may be grabbed, best first. A clean copy imports by extraction alone; a scene ISO or repack is installed under wine first.">
        <table className="table compact">
          <tbody>
            {enabled.map((f, i) => { const d = schema.formats.find(x => x.value === f); return (
              <tr key={f}><td style={{ width: 30 }}><input type="checkbox" checked onChange={() => toggleFormat(f, false)} aria-label={`allow ${d?.label}`} /></td><td><b>{d?.label ?? f}</b><div className="dim">{d?.doc}</div></td>
                <td className="actions"><IconBtn icon="arrowUp" label="Move up" disabled={i === 0} onClick={() => move(i, -1)} /><IconBtn icon="arrowDown" label="Move down" disabled={i === enabled.length - 1} onClick={() => move(i, 1)} /></td></tr>
            ); })}
            {disabled.map(f => { const d = schema.formats.find(x => x.value === f); return (
              <tr key={f} style={{ opacity: .55 }}><td><input type="checkbox" checked={false} onChange={() => toggleFormat(f, true)} aria-label={`allow ${d?.label}`} /></td><td><b>{d?.label ?? f}</b><div className="dim">{d?.doc}</div></td><td className="actions"><Label tone="dim">not allowed</Label></td></tr>
            ); })}
          </tbody>
        </table>
      </Row>
      <Row label="Console fallback" help="when no PC version can be found, the best dump for a console the game is on (any console when unknown) is grabbed and unpacked as it is — nothing is installed or run. A way to play's game file is looked for either way: it is built into the way, never kept as the copy"><Toggle on={p.consoleFallback} onChange={v => setP({ ...p, consoleFallback: v })} /></Row>
      <Row label="Upgrades allowed" help="when on, ludarr keeps searching for a better format until the cutoff; the old copy is replaced on import"><Toggle on={p.upgrade} onChange={v => setP({ ...p, upgrade: v })} label="Upgrades allowed" /></Row>
      <Row label="Upgrade until" help="the format that ends the search: once a copy of this format (or better) is imported, ludarr stops looking"><select className="select" value={p.cutoff} disabled={!p.upgrade} onChange={e => setP({ ...p, cutoff: e.target.value })}>{enabled.map(f => <option key={f} value={f}>{schema.formats.find(x => x.value === f)?.label ?? f}</option>)}</select></Row>
      <Row label="Protocol" help="Usenet is preferred only when a client can take an NZB."><select className="select" value={p.protocol} onChange={e => setP({ ...p, protocol: e.target.value })}>{schema.protocols.map(x => <option key={x} value={x}>{PROTO_LABEL[x] ?? x}</option>)}</select></Row>
      <Row label="Minimum seeders" help="0 lets a torrent posted in the last hours through with no seeders yet (the stall watchdog drops dead ones)."><input className="input" type="number" min={0} value={p.minSeeders} onChange={e => setP({ ...p, minSeeders: Number(e.target.value) })} style={{ maxWidth: 140 }} /></Row>
      <Row label="Maximum size (GB)" help="Empty = no limit."><input className="input" type="number" min={0} value={p.maxSizeGb ?? ""} onChange={e => setP({ ...p, maxSizeGb: e.target.value === "" ? null : Number(e.target.value) })} style={{ maxWidth: 140 }} /></Row>
      <Row label="Minimum score" help="The matcher's confidence (0–100) under which a release is never grabbed automatically."><input className="input" type="number" min={0} max={100} value={p.minScore} onChange={e => setP({ ...p, minScore: Number(e.target.value) })} style={{ maxWidth: 140 }} /></Row>
      <Row label="Must contain" help="Words a release title must contain (any of them)."><TagsInput value={p.mustContain} onChange={v => setP({ ...p, mustContain: v })} /></Row>
      <Row label="Must not contain"><TagsInput value={p.mustNotContain} onChange={v => setP({ ...p, mustNotContain: v })} /></Row>
      <Row label="Preferred groups" help="Release groups tried first within a format."><TagsInput value={p.preferredGroups} onChange={v => setP({ ...p, preferredGroups: v })} /></Row>
      <Row label="Blocked groups"><TagsInput value={p.blockedGroups} onChange={v => setP({ ...p, blockedGroups: v })} /></Row>
    </Modal>
  );
}

export function ProfilesPage() {
  const { data, loading, reload } = useLoad(() => Promise.all([get<{ items: Profile[] }>("/api/v1/profile"), get<Schema>("/api/v1/profile/schema")]), []);
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [profiles, schema] = data ?? [null, null];
  return (
    <div className="content narrow">
      <h2 className="page-title">Profiles</h2>
      <p className="dim" style={{ marginBottom: 14 }}>A profile decides which install formats a game may be grabbed as, in which order, and when the search stops.</p>
      {loading && !data ? <Spinner /> : (
        <div className="cards">
          {profiles?.items.map(p => (
            <div key={p.id} className="card" onClick={() => setEditing(p)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter") setEditing(p); }}>
              <h4>{p.name}</h4>
              <div className="dim">{p.formats.map(f => schema?.formats.find(x => x.value === f)?.label ?? f).join(" → ")}</div>
              <div className="meta">{p.upgrade ? <Label tone="success">upgrades until {schema?.formats.find(x => x.value === p.cutoff)?.label ?? p.cutoff}</Label> : <Label tone="dim">no upgrades</Label>}<Label tone="outline">{PROTO_LABEL[p.protocol] ?? p.protocol}</Label>{p.maxSizeGb != null && <Label tone="outline">≤ {p.maxSizeGb} GB</Label>}</div>
            </div>
          ))}
          <div className="card add" onClick={() => setEditing("new")} role="button" tabIndex={0} aria-label="Add profile" onKeyDown={e => { if (e.key === "Enter") setEditing("new"); }}><Icon name="plus" size={40} /></div>
        </div>
      )}
      {schema && <Editor schema={schema} profile={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
    </div>
  );
}
