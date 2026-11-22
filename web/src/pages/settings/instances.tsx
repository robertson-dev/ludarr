/**
 * Settings → Indexers / Download Clients / Connect (instances the user adds) and Metadata / Importers /
 * Runtimes (one instance per definition, created automatically). Forms are generated from each
 * definition's fields.
 */
import { useEffect, useState, type ReactNode } from "react";
import { del, get, post, put, type Definition, type Instance, type Settings } from "../../api";
import { SettingsForm, validate, withDefaults } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Btn, Empty, IconBtn, Label, Modal, Row, Spinner, Toggle, useLoad, useUi } from "../../ui/kit";

type KindRoute = "indexer" | "downloadclient" | "notification" | "metadata" | "importer" | "runtime";
const ORDERED_KINDS: KindRoute[] = ["importer"];

function EditModal({ kind, def, instance, onClose, onSaved }: { kind: KindRoute; def: Definition | null; instance: Instance | null; onClose: () => void; onSaved: () => void }) {
  const { toast, confirm } = useUi();
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState(50);
  const [settings, setSettings] = useState<Settings>({});
  // priority only means something where the order of instances matters
  const priorityField = kind === "downloadclient" ? { label: "Priority", help: "lower runs first: the first enabled client that speaks the protocol gets the release" }
    : kind === "importer" ? { label: "Order", help: "lower runs first: importers are tried in this order until one produces a valid game folder" } : null;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const singleton = ["metadata", "importer", "runtime"].includes(kind);
  useEffect(() => {
    if (!def) return;
    setName(instance?.name ?? def.name); setEnabled(instance?.enabled ?? true); setPriority(instance?.priority ?? 50); setSettings(withDefaults(def.fields, instance?.settings ?? {})); setErrors({}); setTest(null);
  }, [def, instance]);
  if (!def) return null;
  const runTest = async () => {
    const errs = validate(def.fields, settings);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy("test");
    try { setTest(await post(`/api/v1/${kind}/test`, { impl: def.impl, settings, id: instance?.id })); } catch (e: any) { setTest({ ok: false, detail: e.message }); } finally { setBusy(null); }
  };
  const save = async () => {
    const errs = enabled ? validate(def.fields, settings) : {};
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy("save");
    try {
      const body = { name, enabled, settings, ...(priorityField ? { priority } : {}) };
      if (instance) await put(`/api/v1/${kind}/${instance.id}`, body); else await post(`/api/v1/${kind}`, { impl: def.impl, ...body });
      toast(`${name} saved`, "success"); onSaved(); onClose();
    } catch (e: any) { toast(e.message, "danger"); } finally { setBusy(null); }
  };
  const remove = async () => {
    if (!instance || !(await confirm(`Delete ${instance.name}?`, "It is removed right away."))) return;
    try { await del(`/api/v1/${kind}/${instance.id}`); toast("Deleted", "success"); onSaved(); onClose(); } catch (e: any) { toast(e.message, "danger"); }
  };
  return (
    <Modal open={!!def} onClose={onClose} title={<>{instance ? "Edit" : "Add"} — {def.name}</>}
      foot={<>
        <span className="left">{instance && !singleton && <Btn kind="danger" onClick={remove}>Delete</Btn>}{test && <span className={`test-result ${test.ok ? "ok" : "bad"}`}><Icon name={test.ok ? "check" : "alert"} size={13} /> {test.detail}</span>}</span>
        <Btn onClick={onClose}>Cancel</Btn>
        {(def.fields.length > 0 || !singleton) && <Btn icon="plug" busy={busy === "test"} onClick={runTest}>Test</Btn>}
        <Btn kind="primary" busy={busy === "save"} onClick={save}>Save</Btn>
      </>}>
      {def.description && <p className="dim" style={{ marginBottom: 10 }}>{def.description}{def.infoLink && <> <a href={def.infoLink} target="_blank" rel="noreferrer">More info <Icon name="external" size={11} /></a></>}</p>}
      {!singleton && <Row label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} /></Row>}
      <Row label="Enabled"><Toggle on={enabled} onChange={setEnabled} label="Enabled" /></Row>
      {priorityField && <Row label={priorityField.label} help={priorityField.help}><input className="input" type="number" min={1} max={999} value={priority} onChange={e => setPriority(Number(e.target.value) || 50)} style={{ maxWidth: 140 }} /></Row>}
      {def.fields.length ? <SettingsForm fields={def.fields} value={settings} onChange={setSettings} errors={errors} autoFocus={singleton} /> : <p className="dim">Nothing to configure.</p>}
    </Modal>
  );
}

function useKind(kind: KindRoute) {
  return useLoad(() => Promise.all([get<{ items: Instance[] }>(`/api/v1/${kind}`), get<{ definitions: Definition[] }>(`/api/v1/${kind}/schema`)]), [kind]);
}

export function InstancesPage({ kind, title, blurb }: { kind: KindRoute; title: string; blurb: string }) {
  const { data, loading, reload } = useKind(kind);
  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState<{ def: Definition; instance: Instance | null } | null>(null);
  const [items, schema] = data ?? [null, null];
  const defs = schema?.definitions ?? [];
  const defOf = (i: Instance) => defs.find(d => d.impl === i.impl) ?? null;
  return (
    <div className="content narrow">
      <h2 className="page-title">{title}</h2>
      <p className="dim" style={{ marginBottom: 14 }}>{blurb}</p>
      {loading && !data ? <Spinner /> : (
        <div className="cards">
          {items?.items.map(i => (
            <div key={i.id} className={`card${i.enabled ? "" : " disabled"}`} onClick={() => { const d = defOf(i); if (d) setEditing({ def: d, instance: i }); }} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter") { const d = defOf(i); if (d) setEditing({ def: d, instance: i }); } }}>
              <h4>{i.name}</h4>
              <div className="dim">{i.implName}{i.missing && <span className="label danger" style={{ marginLeft: 8 }}>plugin missing</span>}</div>
              <div className="meta">{!i.enabled && <Label tone="dim">disabled</Label>}{(defOf(i)?.protocols ?? []).map(p => <Label key={p} tone={p === "usenet" ? "usenet" : "torrent"}>{p}</Label>)}{i.priority !== 50 && <Label tone="outline">priority {i.priority}</Label>}</div>
            </div>
          ))}
          <div className="card add" onClick={() => setChoosing(true)} role="button" tabIndex={0} aria-label={`Add ${title}`} onKeyDown={e => { if (e.key === "Enter") setChoosing(true); }}><Icon name="plus" size={40} /></div>
        </div>
      )}
      <Modal open={choosing} onClose={() => setChoosing(false)} title={<>Add {title}</>}>
        {!defs.length ? <Empty title="Nothing to add" icon="plug">No plugin provides this kind.</Empty> : (
          <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {defs.map(d => (
              <div key={d.impl} className="card" onClick={() => { setChoosing(false); setEditing({ def: d, instance: null }); }} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter") { setChoosing(false); setEditing({ def: d, instance: null }); } }}>
                <h4 style={{ fontSize: 17 }}>{d.name}</h4>
                <div className="dim" style={{ fontSize: 12.5 }}>{d.description}</div>
                <div className="meta">{(d.protocols ?? []).map(p => <Label key={p} tone={p === "usenet" ? "usenet" : "torrent"}>{p}</Label>)}<Label tone="outline">{d.plugin}</Label></div>
              </div>
            ))}
          </div>
        )}
      </Modal>
      <EditModal kind={kind} def={editing?.def ?? null} instance={editing?.instance ?? null} onClose={() => setEditing(null)} onSaved={() => void reload()} />
    </div>
  );
}

/** `children` follow the table on the same page (Settings → Runtimes puts the plans there) */
export function SingletonsPage({ kind, title, blurb, ordered, children }: { kind: KindRoute; title: string; blurb: string; ordered?: boolean; children?: ReactNode }) {
  const { toast } = useUi();
  const { data, loading, reload } = useKind(kind);
  const [editing, setEditing] = useState<{ def: Definition; instance: Instance } | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, { ok: boolean; detail: string }>>({});
  const [items, schema] = data ?? [null, null];
  const defs = schema?.definitions ?? [];
  const rows = [...(items?.items ?? [])].sort((a, b) => a.priority - b.priority || a.id - b.id);
  const toggle = async (i: Instance, on: boolean) => { try { await put(`/api/v1/${kind}/${i.id}`, { enabled: on }); void reload(); } catch (e: any) { toast(e.message, "danger"); } };
  const move = async (idx: number, d: number) => {
    const j = idx + d; if (j < 0 || j >= rows.length) return;
    const a = rows[idx], b = rows[j];
    try { await put(`/api/v1/${kind}/${a.id}`, { priority: b.priority }); await put(`/api/v1/${kind}/${b.id}`, { priority: a.priority === b.priority ? a.priority + d : a.priority }); void reload(); } catch (e: any) { toast(e.message, "danger"); }
  };
  const runTest = async (i: Instance) => {
    setTesting(i.id);
    try { setResults(r => ({ ...r, [i.id]: {} as never })); const res = await post<{ ok: boolean; detail: string }>(`/api/v1/${kind}/${i.id}/test`); setResults(r => ({ ...r, [i.id]: res })); }
    catch (e: any) { setResults(r => ({ ...r, [i.id]: { ok: false, detail: e.message } })); } finally { setTesting(null); }
  };
  return (
    <div className="content narrow">
      <h2 className="page-title">{title}</h2>
      <p className="dim" style={{ marginBottom: 14 }}>{blurb}{ordered ? " Order matters: the first one that can handle a download runs first." : ""}</p>
      {loading && !data ? <Spinner /> : !rows.length ? <Empty title={`No ${title.toLowerCase()}`} icon="plug" /> : (
        <table className="table">
          <thead><tr>{ordered && <th style={{ width: 70 }}>Order</th>}<th style={{ width: 70 }}>On</th><th>Name</th><th>What it does</th><th className="actions"></th></tr></thead>
          <tbody>{rows.map((i, idx) => { const d = defs.find(x => x.impl === i.impl); const r = results[i.id]; return (
            <tr key={i.id} style={{ opacity: i.enabled ? 1 : .6 }}>
              {ordered && <td className="nowrap"><IconBtn icon="arrowUp" label="Earlier" disabled={idx === 0} onClick={() => void move(idx, -1)} /><IconBtn icon="arrowDown" label="Later" disabled={idx === rows.length - 1} onClick={() => void move(idx, 1)} /></td>}
              <td><Toggle on={i.enabled} onChange={on => void toggle(i, on)} label={`enable ${i.name}`} /></td>
              <td><b>{i.name}</b>{i.missing && <span className="label danger" style={{ marginLeft: 8 }}>plugin missing</span>}{d?.plugin && <div className="dim">{d.plugin}</div>}</td>
              <td className="dim" style={{ maxWidth: 520 }}>{d?.description}{r?.detail != null && <div className={`test-result ${r.ok ? "ok" : "bad"}`} style={{ marginTop: 4 }}><Icon name={r.ok ? "check" : "alert"} size={12} /> {r.detail}</div>}</td>
              <td className="actions">
                {d && d.fields.length > 0 && <Btn size="sm" icon="pencil" onClick={() => setEditing({ def: d, instance: i })}>Configure</Btn>}{" "}
                {(kind === "metadata" || kind === "importer") && <Btn size="sm" icon="plug" busy={testing === i.id} onClick={() => void runTest(i)}>Test</Btn>}
              </td>
            </tr>
          ); })}</tbody>
        </table>
      )}
      <EditModal kind={kind} def={editing?.def ?? null} instance={editing?.instance ?? null} onClose={() => setEditing(null)} onSaved={() => void reload()} />
      {children}
    </div>
  );
}
void ORDERED_KINDS;
