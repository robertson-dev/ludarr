/** Settings → General: authentication first, then host, the API key, and the search / import / catalog settings. */
import { useState } from "react";
import { get, post, runtime } from "../../api";
import { Icon } from "../../ui/icons";
import { Btn, Row, Section, Spinner, useLoad, useUi } from "../../ui/kit";
import { ConfigSection } from "./config";

const AUTH_KEYS = ["AUTH_METHOD", "AUTH_USERNAME", "AUTH_PASSWORD"];

export function GeneralPage() {
  const { toast, confirm } = useUi();
  const { data, loading, reload } = useLoad(() => get<{ apiKey: string; authMethod: string; port: string; version: string }>("/api/v1/config/host"), []);
  const [show, setShow] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(data?.apiKey ?? ""); toast("API key copied"); } catch { toast("Could not copy", "warning"); } };
  const rotate = async () => {
    if (!(await confirm("Regenerate the API key?", "Every client using the old key stops working until it is updated. This page keeps working.", { ok: "Regenerate", kind: "warning" }))) return;
    try {
      const r = await post<{ apiKey: string }>("/api/v1/config/apikey");
      runtime.apiKey = r.apiKey;                       // same object as window.ludarr: every later call uses the new key
      if (window.ludarr) window.ludarr.apiKey = r.apiKey;
      toast("New API key generated", "success"); setShow(true); void reload();
    } catch (e: any) { toast(e.message, "danger"); }
  };
  return (
    <div className="content narrow">
      <h2 className="page-title">General</h2>
      <ConfigSection group="host" title="Authentication" keys={AUTH_KEYS}
        help={{ AUTH_METHOD: "Basic: the browser asks for the username and password; API calls keep using the API key." }}
        onSaved={v => { if (v.AUTH_METHOD === "basic") toast("Authentication is on: the browser will ask for the username and password on the next page load.", "warning"); }} />
      <ConfigSection group="host" title="Host" exclude={AUTH_KEYS} blurb="The port needs a restart. Settings marked as set by the environment come from the container's variables (the Docker template) and cannot be changed here." />
      <Section title="Security">
        {loading && !data ? <Spinner /> : (
          <Row label="API key" help="Send it as the X-Api-Key header (or ?apikey=) with every API call.">
            <div className="apikey"><code>{show ? data?.apiKey : "•".repeat(32)}</code><Btn size="sm" icon={show ? "eyeOff" : "eye"} onClick={() => setShow(s => !s)}>{show ? "Hide" : "Show"}</Btn><Btn size="sm" icon="copy" onClick={copy}>Copy</Btn><Btn size="sm" kind="outline" icon="refresh" onClick={rotate}>Regenerate</Btn></div>
          </Row>
        )}
      </Section>
      <ConfigSection group="search" title="Search" blurb="How the automatic searcher behaves: how many releases a round may try, how often missing games are re-searched, when a stalled download is dropped." />
      <ConfigSection group="import" title="Import" blurb="Limits for running installers under wine, for building ways to play and making their game files, and for the AI's repairs while it makes a game playable. The AI importer itself is configured under Settings → Importers." />
      <ConfigSection group="catalog" title="Catalog" blurb="A GitHub token (no scopes) lets the catalog check emulator and port releases promptly; without one GitHub allows 60 calls an hour." />
      <p className="dim" style={{ marginTop: 20 }}><Icon name="info" size={13} /> ludarr {runtime.version}</p>
    </div>
  );
}
