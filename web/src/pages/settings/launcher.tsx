/** Settings → Launcher: this PC's side of things (only shown inside the Ahoy launcher). */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtSize, timeAgo } from "../../api";
import { launcher, type LauncherConfig } from "../../launcher";
import { useLauncher } from "../../launcher-state";
import { Btn, Empty, IconBtn, Label, Row, Section, Spinner, Toggle, useUi } from "../../ui/kit";

export function LauncherPage() {
  const { toast, confirm } = useUi();
  const { installed, playing, uninstall, openFolder } = useLauncher();
  const [cfg, setCfg] = useState<LauncherConfig | null>(null);
  const load = () => launcher?.config().then(setCfg).catch(() => {});
  useEffect(() => { void load(); }, []);
  const save = async (patch: Parameters<NonNullable<typeof launcher>["setConfig"]>[0]) => {
    const r = await launcher!.setConfig(patch);
    if (r.ok) { toast("Saved", "success"); void load(); } else toast(r.error ?? "could not save", "danger");
  };
  if (!launcher) return <div className="content narrow"><Empty title="Not the launcher" icon="info">This page only means something inside the Ahoy launcher.</Empty></div>;
  if (!cfg) return <Spinner />;
  return (
    <div className="content narrow">
      <h2 className="page-title">Launcher</h2>
      <Section title="This PC">
        <Row label="Launcher" help="the Ahoy launcher running on this PC"><span>v{cfg.version} · {cfg.platform}</span></Row>
        <Row label="Server" help="the ludarr server this launcher installs from; change it on the setup page by signing out"><span className="mono">{cfg.serverUrl}</span></Row>
        <Row label="Install games into" help="each game gets its own folder in here">
          <div className="row"><span className="mono grow">{cfg.libraryDir}</span><Btn size="sm" icon="folder" onClick={() => void launcher!.pickDir().then(d => { if (d) void save({ libraryDir: d }); })}>Change…</Btn></div>
        </Row>
        <Row label="Desktop shortcuts" help="a shortcut on the desktop for every game installed from here"><Toggle on={cfg.desktopShortcuts} onChange={v => void save({ desktopShortcuts: v })} /></Row>
        <Row label="Sign out" help="forget the server and show the setup page again"><Btn size="sm" icon="power" onClick={() => void save({ serverUrl: "", apiKey: "", user: "", pass: "" })}>Sign out</Btn></Row>
      </Section>
      <Section title={`Installed on this PC (${installed.length})`}>
        {!installed.length ? <p className="dim">Nothing installed yet — open a game that has a copy and press Install.</p> : (
          <table className="table">
            <thead><tr><th>Game</th><th>Version</th><th>Size</th><th>Installed</th><th>Folder</th><th className="actions"></th></tr></thead>
            <tbody>{installed.map(g => (
              <tr key={g.slug}>
                <td>{g.gameId ? <Link to={`/games/${g.gameId}`}>{g.name}</Link> : g.name}{playing[g.slug] && <> <Label tone="success">running</Label></>}{g.kind === "rom" && <> <Label tone="info">{g.platform ?? "console"} dump</Label></>}</td>
                <td>{g.version ?? "—"}</td><td>{fmtSize(g.sizeBytes)}</td><td className="dim">{timeAgo(Math.floor(g.installedAt / 1000))}</td>
                <td className="mono dim ellipsis" style={{ maxWidth: 320 }}>{g.path}</td>
                <td className="actions"><IconBtn icon="folder" label="Open folder" onClick={() => void openFolder(g.slug)} /><IconBtn icon="trash" label="Uninstall" danger onClick={async () => { if (await confirm(`Uninstall ${g.name}?`, <>The folder <code>{g.path}</code> is deleted from this PC. The server keeps its copy.</>, { ok: "Uninstall" })) void uninstall(g.slug); }} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
