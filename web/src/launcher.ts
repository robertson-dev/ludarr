/** The bridge the Ahoy launcher injects (window.ahoyLauncher). Null in a plain browser. */

export interface InstalledGame {
  slug: string; gameId: number | null; packageId: number; name: string; version: string | null;
  path: string; launch: { exe: string; args: string; cwd: string }; kind: "native" | "rom"; platform: string | null;
  sizeBytes: number; installedAt: number; serverUrl: string;
}
export type InstallPhase = "downloading" | "verifying" | "prerequisites" | "finishing" | "done" | "failed" | "cancelled";
export interface InstallProgress {
  type: "install"; packageId: number; gameId: number | null; slug: string; name: string; phase: InstallPhase;
  progress: number; bytes: number; total: number; rate: number; message?: string;
}
export type LauncherEvent = InstallProgress
  | { type: "installed-changed"; installed: InstalledGame[] }
  | { type: "play"; slug: string; running: boolean; pid?: number; code?: number | null; message?: string };

export interface LauncherConfig { serverUrl: string; libraryDir: string; desktopShortcuts: boolean; user: string; hasKey: boolean; version: string; platform: string }

export interface LauncherBridge {
  version: string;
  features?: string[];
  config(): Promise<LauncherConfig>;
  probe(patch: Record<string, unknown>): Promise<{ ok: boolean; detail: string; needsLogin?: boolean; version?: string }>;
  setConfig(patch: Partial<{ serverUrl: string; apiKey: string; libraryDir: string; desktopShortcuts: boolean; user: string; pass: string }>): Promise<{ ok: boolean; error?: string; needsLogin?: boolean }>;
  pickDir(): Promise<string | null>;
  state(): Promise<{ installed: InstalledGame[]; config: LauncherConfig }>;
  installed(): Promise<InstalledGame[]>;
  install(packageId: number): Promise<InstalledGame>;
  cancelInstall(packageId: number): Promise<boolean>;
  uninstall(slug: string): Promise<boolean>;
  play(slug: string): Promise<number>;
  openFolder(slug: string): Promise<boolean>;
  onEvent(cb: (e: LauncherEvent) => void): () => void;
}

export const launcher: LauncherBridge | null = (globalThis as { ahoyLauncher?: LauncherBridge }).ahoyLauncher ?? null;
export const inLauncher = !!launcher;

export const PHASE_LABEL: Record<InstallPhase, string> = {
  downloading: "downloading", verifying: "verifying files", prerequisites: "installing prerequisites", finishing: "finishing up",
  done: "installed", failed: "install failed", cancelled: "cancelled",
};
