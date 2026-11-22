/**
 * Ahoy — one status model for every surface. A game is somewhere on a journey of five stops
 * (Found · Downloaded · Prepared · Ready · Installed), and there is exactly one thing to do about it.
 */
import { fmtSize, type DiscoverItem, type Game } from "../api";
import type { InstallProgress, InstalledGame } from "../launcher";

export const STOPS = ["Found", "Downloaded", "Prepared", "Ready", "Installed"] as const;
export type Stage = "none" | "waiting" | "finding" | "downloading" | "preparing" | "ready" | "installing" | "installed" | "failed";

export interface Journey {
  stage: Stage;
  done: number;                 // stops completed, 0..5
  current: number | null;       // the stop in progress (index into STOPS), or null
  label: string;                // one short word for the card: Installed, Ready, Downloading…
  detail: string;               // one human line under it
  progress: number | null;      // 0..1 while something moves
  rate?: number; eta?: string;
  active: boolean;              // moving right now
}

const eta = (bytes: number, total: number, rate: number) => {
  if (!rate || !total || total <= bytes) return undefined;
  const s = (total - bytes) / rate;
  return s < 60 ? "under a minute left" : s < 3600 ? `about ${Math.round(s / 60)} min left` : `about ${(s / 3600).toFixed(1)} h left`;
};

export function journeyOf(g: Game | null | undefined, inst?: InstalledGame, prog?: InstallProgress): Journey {
  if (prog) {
    const p = prog.phase;
    const label = p === "downloading" ? "Installing" : p === "verifying" ? "Checking files" : p === "prerequisites" ? "Setting up" : "Finishing";
    return { stage: "installing", done: 4, current: 4, label, detail: `${Math.round(prog.progress * 100)}%${prog.rate ? ` · ${fmtRateShort(prog.rate)}` : ""}${eta(prog.bytes, prog.total, prog.rate) ? ` · ${eta(prog.bytes, prog.total, prog.rate)}` : ""}`, progress: prog.progress, rate: prog.rate, eta: eta(prog.bytes, prog.total, prog.rate), active: true };
  }
  if (inst) return { stage: "installed", done: 5, current: null, label: "Installed", detail: "On this PC", progress: null, active: false };
  if (!g) return { stage: "none", done: 0, current: null, label: "", detail: "", progress: null, active: false };
  const r = g.request;
  switch (g.status) {
    case "available": return { stage: "ready", done: 4, current: null, label: "Ready", detail: `${fmtSize(g.file?.size)} on your server`, progress: null, active: false };
    case "importing": return { stage: "preparing", done: 2, current: 2, label: "Preparing", detail: sentence(r?.stage ?? g.statusDetail), progress: r?.progress ?? null, active: true };
    case "downloading": return { stage: "downloading", done: 1, current: 1, label: "Downloading", detail: sentence(r?.stage ?? g.statusDetail), progress: r?.progress ?? null, active: true };
    case "searching": return { stage: "finding", done: 0, current: 0, label: "Finding", detail: sentence(r?.stage ?? g.statusDetail), progress: null, active: true };
    case "failed": return { stage: "failed", done: 0, current: null, label: "Didn't make it", detail: sentence(r?.message ?? g.statusDetail), progress: null, active: false };
    case "unreleased": return { stage: "waiting", done: 0, current: null, label: g.tracked ? "Tracked" : "Not out yet", detail: g.releaseText || g.releaseIso || "no date yet", progress: null, active: false };
    default: return { stage: "none", done: 0, current: null, label: g.monitored ? "Not found yet" : "Not on your server", detail: sentence(g.statusDetail), progress: null, active: false };
  }
}

const fmtRateShort = (bps: number) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 5e7 ? 0 : 1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`);
export const sentence = (s: string | null | undefined) => (!s ? "" : s.charAt(0).toUpperCase() + s.slice(1));

/** the word under a card for something that is not in the library: can it be had today? */
export function availabilityOf(i: Pick<DiscoverItem, "comingSoon" | "releaseText" | "releaseIso" | "crackStatus" | "drm" | "free" | "reviewPct">): { text: string; dot: "ok" | "lamp" | "muted" } {
  if (i.comingSoon) return { text: shortDate(i.releaseIso) ?? i.releaseText ?? "Coming soon", dot: "muted" };
  if (i.crackStatus === "cracked") return { text: `Available${i.reviewPct != null ? ` · ${i.reviewPct}%` : ""}`, dot: "ok" };
  if (i.crackStatus === "uncracked" || i.crackStatus === "hypervisor") return { text: `Not yet · ${i.drm ?? "protected"}`, dot: "muted" };
  if (i.free) return { text: "Free on Steam", dot: "muted" };
  return { text: i.reviewPct != null ? `${i.reviewPct}% positive` : "", dot: "muted" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

export const isActive = (g: Game) => g.status === "searching" || g.status === "downloading" || g.status === "importing";

/** strip Steam's HTML from "about the game" into a few readable paragraphs */
export function plainText(html: string | null | undefined, maxChars = 1400): string[] {
  if (!html) return [];
  const t = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h\d|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const out: string[] = [];
  let n = 0;
  for (const p of t.split(/\n+/).map(s => s.trim()).filter(Boolean)) { if (n + p.length > maxChars) break; out.push(p); n += p.length; }
  return out;
}
