import type { GameStatus } from "../api";
import type { Tone } from "./kit";
import type { IconName } from "./icons";
// kept in ways/logic.ts, which the engine's tests read without React
export { jobActive, tierLabel, wayStatus } from "../ways/logic";

export const STATUS: Record<GameStatus, { label: string; tone: Tone; icon: IconName }> = {
  available: { label: "Available", tone: "success", icon: "check" },
  missing: { label: "Missing", tone: "danger", icon: "wanted" },
  searching: { label: "Searching", tone: "queue", icon: "search" },
  downloading: { label: "Downloading", tone: "queue", icon: "download" },
  importing: { label: "Importing", tone: "queue", icon: "box" },
  unreleased: { label: "Unreleased", tone: "primary", icon: "calendar" },
  unmonitored: { label: "Unmonitored", tone: "dim", icon: "bookmarkOff" },
  failed: { label: "Failed", tone: "warning", icon: "alert" },
};
export const statusLabel = (s: string) => STATUS[s as GameStatus]?.label ?? s;
export const statusTone = (s: string): Tone => STATUS[s as GameStatus]?.tone ?? "default";

export const EVENT_TONE: Record<string, Tone> = { cracked: "success", cleaned: "info", grabbed: "primary", downloaded: "info", downloadFailed: "warning", imported: "success", importFailed: "warning", failed: "danger", upgraded: "success", deleted: "dim", blocklisted: "danger", added: "accent", edited: "accent", left: "dim" };
export const EVENT_ICON: Record<string, IconName> = { cracked: "check", cleaned: "trash", grabbed: "download", downloaded: "drive", downloadFailed: "alert", imported: "check", importFailed: "alert", failed: "x", upgraded: "arrowUp", deleted: "trash", blocklisted: "ban", added: "plus", edited: "pencil", left: "drive" };

/** CrackWatch verdicts */
export const CRACK_TONE: Record<string, Tone> = { cracked: "success", uncracked: "danger", unreleased: "primary", hypervisor: "warning", unknown: "dim", untracked: "dim" };
export const crackLabel = (s: string | null | undefined) => (s === "cracked" ? "Cracked" : s === "uncracked" ? "Uncracked" : s === "unreleased" ? "Unreleased" : s === "hypervisor" ? "Bypassed" : s === "untracked" ? "Not tracked" : s ? "Unknown" : "");
/** the chip on a poster: only what is worth a glance — an uncracked game, or notable DRM (anything but plain Steam) */
export function crackChip(drm: string | null | undefined, status: string | null | undefined): { text: string; tone: Tone } | null {
  const notable = drm && !/^steam$/i.test(drm);
  if (status === "uncracked") return { text: `${drm ?? "DRM"} · Uncracked`, tone: "danger" };
  if (status === "cracked" && notable) return { text: `${drm} · Cracked`, tone: "success" };
  if (status === "hypervisor") return { text: `${drm ?? "DRM"} · Bypassed`, tone: "warning" };
  if (status === "unreleased" && notable) return { text: `${drm}`, tone: "warning" };
  return null;
}

export const COMPAT_TONE: Record<string, Tone> = { perfect: "success", playable: "success", ingame: "warning", intro: "warning", menus: "warning", boots: "danger", nothing: "danger", unknown: "dim" };
export const KIND_TONE: Record<string, Tone> = { native: "primary", recomp: "accent", port: "accent", emulated: "info", emulator: "info" };

/* ─────────── ways to play ─────────── */

type Look = { label: string; tone: Tone };
const look = (map: Record<string, Look>, s: string | null | undefined): Look => map[s ?? ""] ?? { label: s ?? "—", tone: "dim" };
const PLAN_STATUS: Record<string, Look> = { draft: { label: "Draft", tone: "dim" }, ready: { label: "Ready", tone: "success" }, broken: { label: "Broken", tone: "danger" } };
const JOB_STATE: Record<string, Look> = {
  queued: { label: "Queued", tone: "dim" }, running: { label: "Running", tone: "queue" }, done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" }, cancelled: { label: "Cancelled", tone: "dim" },
};
export const planStatus = (s: string | null | undefined) => look(PLAN_STATUS, s);
export const jobState = (s: string | null | undefined) => look(JOB_STATE, s);
/** what a job of each kind is, in the admin's words ('make': a way's game file made from another form of the game's data) */
export const JOB_KIND: Record<string, string> = { import: "Import", construct: "From a repo", assemble: "Way to play", content: "Game file", build: "From source", make: "Game data" };
export const protocolTone = (p: string | null | undefined): Tone => (p === "usenet" ? "usenet" : p === "torrent" ? "torrent" : "dim");
