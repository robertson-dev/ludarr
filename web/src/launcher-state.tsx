/** What the launcher knows, kept live for every page: installed games, installs in flight, what is running. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { launcher, inLauncher, PHASE_LABEL, type InstalledGame, type InstallProgress, type LauncherEvent } from "./launcher";
import { useUi } from "./ui/kit";

interface LauncherState {
  inLauncher: boolean;
  installed: InstalledGame[];
  installs: Record<number, InstallProgress>;      // by package id, while one is in flight
  playing: Record<string, boolean>;               // by slug
  installedFor: (gameId: number | null | undefined, packageId?: number | null) => InstalledGame | undefined;
  install: (packageId: number) => Promise<void>;
  cancelInstall: (packageId: number) => Promise<void>;
  uninstall: (slug: string) => Promise<void>;
  play: (slug: string) => Promise<void>;
  openFolder: (slug: string) => Promise<void>;
}

const Ctx = createContext<LauncherState>({ inLauncher: false, installed: [], installs: {}, playing: {}, installedFor: () => undefined, install: async () => {}, cancelInstall: async () => {}, uninstall: async () => {}, play: async () => {}, openFolder: async () => {} });
export const useLauncher = () => useContext(Ctx);

export function LauncherProvider({ children }: { children: ReactNode }) {
  const { toast } = useUi();
  const [installed, setInstalled] = useState<InstalledGame[]>([]);
  const [installs, setInstalls] = useState<Record<number, InstallProgress>>({});
  const [playing, setPlaying] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!launcher) return;
    void launcher.installed().then(setInstalled).catch(() => {});
    return launcher.onEvent((e: LauncherEvent) => {
      if (e.type === "installed-changed") setInstalled(e.installed);
      else if (e.type === "install") {
        setInstalls(m => { const n = { ...m }; if (e.phase === "done" || e.phase === "failed" || e.phase === "cancelled") delete n[e.packageId]; else n[e.packageId] = e; return n; });
        if (e.phase === "done") toast(`${e.name} is installed — press Play`, "success");
        if (e.phase === "failed") toast(`${e.name}: ${e.message ?? PHASE_LABEL.failed}`, "danger");
      } else if (e.type === "play") {
        setPlaying(p => ({ ...p, [e.slug]: e.running }));
        if (!e.running && e.message) toast(`could not start: ${e.message}`, "danger");
      }
    });
  }, [toast]);

  const installedFor = useCallback((gameId: number | null | undefined, packageId?: number | null) =>
    installed.find(g => (packageId != null && g.packageId === packageId) || (gameId != null && g.gameId === gameId)), [installed]);
  const install = useCallback(async (packageId: number) => {
    if (!launcher) throw new Error("installing needs the Ahoy launcher");
    try { await launcher.install(packageId); } catch (e: any) { if (!/cancelled/.test(String(e?.message))) toast(String(e?.message ?? e), "danger"); }
  }, [toast]);
  const cancelInstall = useCallback(async (packageId: number) => { await launcher?.cancelInstall(packageId); }, []);
  const uninstall = useCallback(async (slug: string) => { await launcher?.uninstall(slug); }, []);
  const play = useCallback(async (slug: string) => {
    if (!launcher) return;
    setPlaying(p => ({ ...p, [slug]: true }));
    try { await launcher.play(slug); } catch (e: any) { setPlaying(p => ({ ...p, [slug]: false })); toast(String(e?.message ?? e), "danger"); }
  }, [toast]);
  const openFolder = useCallback(async (slug: string) => { await launcher?.openFolder(slug); }, []);

  return <Ctx.Provider value={{ inLauncher, installed, installs, playing, installedFor, install, cancelInstall, uninstall, play, openFolder }}>{children}</Ctx.Provider>;
}

export const fmtRate = (bps: number) => (bps > 1e6 ? `${(bps / 1e6).toFixed(bps > 50e6 ? 0 : 1)} MB/s` : bps > 1e3 ? `${Math.round(bps / 1e3)} KB/s` : "");
