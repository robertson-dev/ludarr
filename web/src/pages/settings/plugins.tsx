/** Settings → Plugins: what is loaded, from where, and the on/off switch per plugin. */
import { get, put, timeAgo, type PluginView } from "../../api";
import { Icon } from "../../ui/icons";
import { Label, Spinner, Toggle, useLoad, useUi } from "../../ui/kit";

const KIND_LABEL: Record<string, string> = { indexer: "indexer", downloadClient: "download client", metadata: "metadata source", importer: "importer", runtime: "runtime set", notification: "notification" };

export function PluginsPage() {
  const { toast } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ items: PluginView[]; folder: string; api: number; kinds: string[] }>("/api/v1/plugin"), []);
  const toggle = async (p: PluginView, on: boolean) => { try { await put(`/api/v1/plugin/${p.id}`, { enabled: on }); toast(`${p.name ?? p.id} ${on ? "enabled" : "disabled"}`, "success"); void reload(); } catch (e: any) { toast(e.message, "danger"); } };
  return (
    <div className="content narrow">
      <h2 className="page-title">Plugins</h2>
      <p className="dim" style={{ marginBottom: 14 }}>Everything that touches the outside world is a plugin: indexers, download clients, metadata sources, importers, runtimes and notifications. The built-in ones use the same contract as anything you drop in.</p>
      {loading && !data ? <Spinner /> : (
        <>
          <div className="cards">
            {data?.items.map(p => (
              <div key={p.id} className={`card${p.enabled ? "" : " disabled"}`} style={{ cursor: "default" }}>
                <div className="corner"><Toggle on={p.enabled} onChange={on => void toggle(p, on)} label={`enable ${p.id}`} /></div>
                <h4 style={{ fontSize: 18 }}>{p.name ?? p.id} <span className="dim" style={{ fontSize: 13 }}>{p.version ?? ""}</span></h4>
                <div className="dim" style={{ fontSize: 12.5 }}>{p.description}</div>
                {p.error && <div className="test-result bad"><Icon name="alert" size={12} /> {p.error}</div>}
                <div className="meta">
                  <Label tone={p.builtin ? "outline" : "accent"}>{p.builtin ? "built-in" : "external"}</Label>
                  {p.definitions.map(d => <Label key={`${d.kind}:${d.impl}`} tone="dim" title={`${KIND_LABEL[d.kind] ?? d.kind}: ${d.name}`}>{d.name}</Label>)}
                </div>
                <div className="dim" style={{ fontSize: 11.5 }}>{p.builtin ? "" : `${p.source} · `}{p.loadedAt ? `loaded ${timeAgo(p.loadedAt)}` : ""}</div>
              </div>
            ))}
          </div>
          <div className="card" style={{ marginTop: 20 }}>
            <h4 style={{ fontSize: 16, marginBottom: 6 }}>Writing a plugin</h4>
            <p className="dim">Put a folder in <code>{data?.folder}</code> with an <code>index.ts</code> (or <code>index.js</code>, or a <code>package.json</code> whose <code>main</code> points at the module). Its default export is the plugin — a plain object with <code>api: {data?.api}</code>, an <code>id</code>, <code>name</code>, <code>version</code> and any of <code>indexers</code>, <code>downloadClients</code>, <code>metadata</code>, <code>importers</code>, <code>runtimes</code>, <code>notifications</code>. Each definition declares its settings as <code>fields</code> (the form you see here is generated from them) and a <code>create(settings, ctx)</code> that returns the implementation. Restart ludarr to load it; a broken plugin shows its error above and never stops the app. The contract lives in <code>src/plugins/types.ts</code>.</p>
          </div>
        </>
      )}
    </div>
  );
}
