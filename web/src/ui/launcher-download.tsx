/** The desktop launcher build the server publishes (<config>/launcher/): a download link in a plain browser, nothing inside the launcher. */
import { fmtSize, get, urlBase } from "../api";
import { inLauncher, launcher } from "../launcher";
import { Btn, Modal, Section, useLoad } from "./kit";

interface Build { file: string | null; version?: string | null; size?: number; url?: string }
export const useLauncherBuild = () => useLoad(() => get<Build>("/api/v1/launcher"), [], { quiet: true });

export function LauncherSection() {
  const { data } = useLauncherBuild();
  if (inLauncher) return <Section title="Desktop launcher"><p className="dim">You are using the Ahoy launcher v{launcher!.version} — its own settings are under Settings → Launcher.</p></Section>;
  return (
    <Section title="Desktop launcher">
      <p className="dim" style={{ marginBottom: 10 }}>Games are installed onto a PC by the Ahoy launcher, a small desktop app that shows this same UI and adds Install / Play.</p>
      {data?.file ? <a className="btn primary" href={`${urlBase}${data.url}`} download>Download Ahoy launcher{data.version ? ` ${data.version}` : ""}{data.size ? ` · ${fmtSize(data.size)}` : ""}</a>
        : <p className="dim">No build is published on this server yet: build it with <code>bun run dist</code> in <code>launcher/</code> and run <code>deploy/unraid.py</code>, or drop the exe into <code>&lt;config&gt;/launcher/</code>.</p>}
    </Section>
  );
}

export function LauncherDownload({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useLauncherBuild();
  return (
    <Modal open={open} onClose={onClose} title="Installing happens in the launcher" sm foot={<><Btn onClick={onClose}>Close</Btn>{data?.file && <a className="btn primary" href={`${urlBase}${data.url}`} download>Download the launcher</a>}</>}>
      <p>A browser cannot write a game onto your disk. The Ahoy launcher is this same page in a small desktop app that can: it installs the copy from the server, verifies every file, and launches the game.</p>
      {!data?.file && <p className="dim">No launcher build is published on this server yet (Settings → General says how).</p>}
    </Modal>
  );
}
