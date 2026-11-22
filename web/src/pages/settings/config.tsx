/** A group of global settings (host / media / search / import / catalog) as a form with its own Save. */
import { useEffect, useState } from "react";
import { ApiError, get, put, type ConfigItem, type Settings } from "../../api";
import { configToFields, configToValues, SettingsForm } from "../../ui/forms";
import { Btn, Section, Spinner, useLoad, useUi } from "../../ui/kit";

export function ConfigSection({ group, title, blurb, keys, exclude, help, onSaved }: {
  group: string; title: string; blurb?: string;
  /** only these keys (in this order) … */
  keys?: string[];
  /** … or everything in the group except these */
  exclude?: string[];
  /** help text overrides per key */
  help?: Record<string, string>;
  onSaved?: (values: Settings) => void;
}) {
  const { toast } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ config: ConfigItem[] }>(`/api/v1/config?group=${group}`), [group]);
  const [values, setValues] = useState<Settings>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { setValues(configToValues(data.config)); setDirty(false); } }, [data]);
  const all = data?.config ?? [];
  const items = keys ? keys.map(k => all.find(c => c.key === k)).filter((c): c is ConfigItem => !!c) : all.filter(c => !exclude?.includes(c.key));
  const save = async () => {
    if (!data) return;
    const base = configToValues(all);
    const patch: Record<string, unknown> = {};
    for (const c of items) if (c.source !== "env" && values[c.key] !== base[c.key]) patch[c.key] = values[c.key];
    setBusy(true);
    try {
      const r = await put<{ rejected: string[]; changed: string[]; errors?: string[] }>("/api/v1/config", patch);
      if (r.errors?.length) { for (const e of r.errors) toast(e, "danger"); return; }
      toast(r.changed.length ? `Saved ${r.changed.length} setting${r.changed.length === 1 ? "" : "s"}` : "Nothing changed", "success");
      onSaved?.(values);
      void reload();
    } catch (e: any) {
      const errors: unknown = e instanceof ApiError ? e.data?.errors : null;
      if (Array.isArray(errors) && errors.length) for (const err of errors) toast(String(err), "danger");
      else toast(e.message, "danger");
    } finally { setBusy(false); }
  };
  if (loading && !data) return <Spinner />;
  return (
    <Section title={title} right={<Btn kind="primary" size="sm" icon="save" busy={busy} disabled={!dirty} onClick={save}>Save</Btn>}>
      {blurb && <p className="dim" style={{ marginBottom: 6 }}>{blurb}</p>}
      <SettingsForm fields={configToFields(items, help)} value={values} onChange={v => { setValues(v); setDirty(true); }} />
    </Section>
  );
}
