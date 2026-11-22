/** ludarr web — forms generated from the server's field definitions (plugin settings and global config). */
import { useState } from "react";
import type { ConfigItem, Field, Settings } from "../api";
import { Row } from "./kit";
import { Icon } from "./icons";

const visible = (f: Field, s: Settings) => !f.showIf || s[f.showIf.field] === f.showIf.equals;

export function withDefaults(fields: Field[], s: Settings = {}): Settings {
  const out: Settings = { ...s };
  for (const f of fields) if (out[f.name] === undefined) out[f.name] = f.default ?? (f.type === "checkbox" ? false : f.type === "tags" ? [] : "");
  return out;
}

export function validate(fields: Field[], s: Settings): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of fields) {
    if (!visible(f, s)) continue;
    const v = s[f.name];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (f.required && empty) errs[f.name] = `${f.label} is required`;
    else if (f.type === "number" && !empty && !Number.isFinite(Number(v))) errs[f.name] = "Must be a number";
    else if (f.type === "url" && !empty && !/^https?:\/\//i.test(String(v))) errs[f.name] = "Must start with http:// or https://";
  }
  return errs;
}

/** a list of short texts; `max` stops adding once it is full (the server refuses more), `split` false keeps commas inside one entry */
export function TagsInput({ value, onChange, placeholder, max, split = true, label }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; max?: number; split?: boolean; label?: string }) {
  const [draft, setDraft] = useState("");
  const full = max != null && value.length >= max;
  const add = () => {
    const parts = (split ? draft.split(/[,\n]/) : [draft]).map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean);
    if (parts.length) {
      const seen = new Set(value.map(v => v.toLowerCase()));
      const next = [...value];
      for (const p of parts) if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); next.push(p); }
      onChange(max != null ? next.slice(0, max) : next);
    }
    setDraft("");
  };
  return (
    <div className="field">
      {value.length > 0 && <div className="taglist">{value.map(t => <span key={t} className="tagi">{t}<button type="button" aria-label={`remove ${t}`} onClick={() => onChange(value.filter(x => x !== t))}><Icon name="x" size={11} /></button></span>)}</div>}
      <input className="input" value={draft} aria-label={label} disabled={full} placeholder={full ? `that is all ${max} of them` : placeholder ?? "type and press Enter"}
        onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" || (split && e.key === ",")) { e.preventDefault(); add(); } }} onBlur={add} />
    </div>
  );
}

export function FieldInput({ f, value, onChange, autoFocus }: { f: Field; value: unknown; onChange: (v: unknown) => void; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  switch (f.type) {
    case "checkbox": return <label className="check"><input type="checkbox" checked={!!value} disabled={f.readOnly} onChange={e => onChange(e.target.checked)} /><span>{f.helpText ? "" : f.label}</span></label>;
    case "select": return <select className="select" value={String(value ?? "")} disabled={f.readOnly} onChange={e => onChange(e.target.value)}>{(f.options ?? []).map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}</select>;
    case "textarea": return <textarea className="textarea" value={String(value ?? "")} placeholder={f.placeholder} disabled={f.readOnly} onChange={e => onChange(e.target.value)} />;
    case "tags": return <TagsInput value={Array.isArray(value) ? value.map(String) : []} onChange={onChange} />;
    case "number": return <input className="input" type="number" value={value === "" || value == null ? "" : String(value)} placeholder={f.placeholder} disabled={f.readOnly} onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))} autoFocus={autoFocus} />;
    case "password": return (
      <div className="row"><input className="input" type={show ? "text" : "password"} value={String(value ?? "")} placeholder={f.placeholder} disabled={f.readOnly} onChange={e => onChange(e.target.value)} autoComplete="new-password" autoFocus={autoFocus} />
        <button type="button" className="ibtn" title={show ? "Hide" : "Show"} onClick={() => setShow(s => !s)}><Icon name={show ? "eyeOff" : "eye"} /></button></div>);
    default: return <input className="input" type="text" value={String(value ?? "")} placeholder={f.placeholder} disabled={f.readOnly} onChange={e => onChange(e.target.value)} autoFocus={autoFocus} />;
  }
}

export function SettingsForm({ fields, value, onChange, errors = {}, autoFocus = false }: { fields: Field[]; value: Settings; onChange: (v: Settings) => void; errors?: Record<string, string>; autoFocus?: boolean }) {
  const [adv, setAdv] = useState(false);
  const basic = fields.filter(f => !f.advanced && visible(f, value));
  const advanced = fields.filter(f => f.advanced && visible(f, value));
  const set = (name: string, v: unknown) => onChange({ ...value, [name]: v });
  return (
    <div>
      {basic.map((f, i) => <Row key={f.name} label={<>{f.label}{f.required && <span className="muted"> *</span>}</>} help={f.helpText} error={errors[f.name]}><FieldInput f={f} value={value[f.name]} onChange={v => set(f.name, v)} autoFocus={autoFocus && i === 0} /></Row>)}
      {advanced.length > 0 && (
        <div className="fieldset-adv">
          <button type="button" className="adv-toggle" onClick={() => setAdv(a => !a)}><Icon name={adv ? "chevronUp" : "chevronDown"} size={13} /> {adv ? "Hide" : "Show"} advanced ({advanced.length})</button>
          {adv && advanced.map(f => <Row key={f.name} label={f.label} help={f.helpText} error={errors[f.name]}><FieldInput f={f} value={value[f.name]} onChange={v => set(f.name, v)} /></Row>)}
        </div>
      )}
    </div>
  );
}

/** global config items (Settings → General / Media management …) as a form; returns the patch of changed keys */
export function configToFields(items: ConfigItem[], help: Record<string, string> = {}): Field[] {
  return items.map(c => ({
    name: c.key, label: c.label, type: c.secret ? "password" : c.type === "checkbox" ? "checkbox" : c.type === "number" ? "number" : c.type === "select" ? "select" : "text",
    helpText: [help[c.key] ?? c.doc, c.source === "env" ? "set by the environment (docker template)" : null].filter(Boolean).join(" · ") || undefined,
    options: c.options, advanced: c.advanced, showIf: c.showIf, readOnly: c.source === "env",
  }));
}
export function configToValues(items: ConfigItem[]): Settings {
  const out: Settings = {};
  for (const c of items) out[c.key] = c.type === "checkbox" ? ["1", "true", "yes", "on"].includes(c.value.toLowerCase()) : c.value;
  return out;
}
