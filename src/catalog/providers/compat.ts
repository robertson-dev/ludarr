/**
 * Emulator compatibility lists → emulated routes. Each list is a public, machine-readable file or API
 * (verified 2026-10-18). Reports for the same game (regions, editions) are folded into one route that
 * carries every serial it was reported under and the best status among them.
 */
import { normName } from "../store";
import type { Contribution, IdScheme, Platform, Provenance, Provider, ProviderCtx, Status } from "../types";
import { consoleContent, EMULATOR_NEEDS, EMULATORS } from "./emulators";

const UA = { "User-Agent": "AhoyCatalogBot/0.1 (self-hosted game launcher)", Accept: "application/json, text/plain, */*" };
const DAY = 24 * 60;

export interface Report { id: string; name: string; status: Status; at: number | null; note?: string | null; link?: string | null }

const TAIL = /\s*[\[(][^\[\]()]*[\])]\s*$/;
/** "Dark Chronicle [Trial]" → { name: "Dark Chronicle", provenance: "demo" } */
export function baseName(raw: string): { name: string; provenance: Provenance } {
  let name = raw.replace(/\s+/g, " ").trim();
  const provenance: Provenance = /\b(demo|trial|kiosk|taikenban)\b|体験版/i.test(name) ? "demo"
    : /\bbeta\b/i.test(name) ? "beta" : /\bproto(type)?\b/i.test(name) ? "prototype" : "retail";
  while (TAIL.test(name) && name.replace(TAIL, "").trim()) name = name.replace(TAIL, "").trim();
  return { name, provenance };
}

const ts = (s: string | null | undefined) => { const t = s ? Date.parse(s.includes("T") || s.length <= 10 ? s : s.replace(" ", "T") + "Z") : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
const rank = (s: Status) => ["perfect", "playable", "ingame", "intro", "menus", "boots", "nothing", "unknown"].indexOf(s);

export function groupReports(reports: Report[], o: { runtime: string; platform: Platform; scheme: IdScheme; cover?: (ids: string[]) => string | null }): Contribution[] {
  const groups = new Map<string, { name: string; provenance: Provenance; list: Report[] }>();
  for (const r of reports) {
    if (!r.id || !r.name?.trim()) continue;
    const b = baseName(r.name);
    const key = `${normName(b.name)}|${b.provenance}`;
    const g = groups.get(key) ?? { name: b.name, provenance: b.provenance, list: [] };
    g.list.push(r); groups.set(key, g);
  }
  const runtime = EMULATORS.find(e => e.id === o.runtime);
  const out: Contribution[] = [];
  for (const g of groups.values()) {
    const list = g.list.sort((a, b) => rank(a.status) - rank(b.status) || (b.at ?? 0) - (a.at ?? 0));
    const best = list[0];
    const ids = [...new Set(list.map(r => r.id))];
    const cover = o.cover?.(ids) ?? null;
    out.push({
      title: { ids: ids.map(value => ({ scheme: o.scheme, value })), name: g.name, platforms: [o.platform], ...(cover ? { meta: { cover } } : {}) },
      routes: [{
        key: `${o.runtime}:${[...ids].sort()[0]}`, kind: "emulated", platform: o.platform, provenance: g.provenance,
        runtime: o.runtime, label: runtime?.name ?? o.runtime, status: best.status, statusAt: best.at,
        statusNote: [best.note, ids.length > 1 ? `${ids.length} releases reported` : null].filter(Boolean).join(" · ") || null,
        link: best.link ?? null, content: consoleContent(o.platform, g.name, ids), needs: EMULATOR_NEEDS[o.runtime] ?? [],
      }],
    });
  }
  return out;
}

async function getJson<T>(ctx: ProviderCtx, url: string): Promise<T> {
  const r = await ctx.fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return await r.json() as T;
}
async function getText(ctx: ProviderCtx, url: string): Promise<string> {
  const r = await ctx.fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return await r.text();
}

/* ─────────── PS4 · shadPS4 ─────────── */

type ShadData = Record<string, Record<string, { issue_number: string; name: string; serial: string; last_tested: string; status: string; version: string }>>;
export function parseShadps4(data: ShadData): Report[] {
  const out: Report[] = [];
  for (const [serial, byOs] of Object.entries(data)) {
    const win = byOs["os-windows"];
    const rep = win ?? Object.values(byOs)[0];
    if (!rep) continue;
    const os = win ? "Windows" : (Object.keys(byOs)[0] ?? "").replace("os-", "");
    const s = rep.status.replace("status-", "") as Status;
    out.push({ id: serial, name: rep.name, status: ["playable", "ingame", "menus", "boots", "nothing"].includes(s) ? s : "unknown",
      at: ts(rep.last_tested), note: `tested on ${rep.version || "?"} · ${win ? os : `${os} (no Windows report)`}`,
      link: `https://github.com/shadps4-compatibility/shadps4-game-compatibility/issues/${rep.issue_number}` });
  }
  return out;
}
export const shadps4Provider: Provider = {
  id: "compat-shadps4", label: "shadPS4 compatibility", every: DAY, metaRank: 20,
  about: "PS4 games tested on shadPS4 (community compatibility tracker), Windows reports first.",
  runtimes: () => EMULATORS.filter(e => e.id === "shadps4"),
  async collect(ctx) {
    const data = await getJson<ShadData>(ctx, "https://github.com/shadps4-compatibility/shadps4-game-compatibility/releases/latest/download/compatibility_data.json");
    return groupReports(parseShadps4(data), { runtime: "shadps4", platform: "ps4", scheme: "serial" });
  },
};

/* ─────────── PS5 · SharpEmu ─────────── */

export function parseSharpemu(rows: { t: string; a: string; n: string; s: string }[]): Report[] {
  return rows.filter(r => r.s && r.s !== "untested").flatMap(r => {
    const s = (["playable", "ingame", "menus", "boots", "nothing"].includes(r.s) ? r.s : "unknown") as Status;
    return [{ id: r.t, name: r.n, status: s, at: null, link: `https://sharpemu.app/game/${r.t}/`, note: r.a && r.a !== r.t ? `also ${r.a.split(" ").filter(x => x !== r.t).slice(0, 4).join(", ")}` : null }];
  });
}
export const sharpemuProvider: Provider = {
  id: "compat-sharpemu", label: "SharpEmu compatibility", every: DAY, metaRank: 20,
  about: "PS5 games tested on SharpEmu (the untested majority of its title index is left out).",
  runtimes: () => EMULATORS.filter(e => e.id === "sharpemu"),
  async collect(ctx) {
    return groupReports(parseSharpemu(await getJson(ctx, "https://sharpemu.app/games-index.json")), { runtime: "sharpemu", platform: "ps5", scheme: "serial" });
  },
};

/* ─────────── PS3 · RPCS3 ─────────── */

const RPCS3_STATUS: Record<string, Status> = { Playable: "playable", Ingame: "ingame", Intro: "intro", Loadable: "boots", Nothing: "nothing" };
type RpcsPage = { return_code: number; results?: Record<string, { title: string; status: string; date: string; thread: number }> };
export function parseRpcs3(page: RpcsPage): Report[] {
  return Object.entries(page.results ?? {}).map(([serial, r]) => ({
    id: serial, name: r.title, status: RPCS3_STATUS[r.status] ?? "unknown", at: ts(r.date),
    link: r.thread ? `https://forums.rpcs3.net/thread-${r.thread}.html` : null,
  }));
}
/** GameTDB has US covers keyed exactly like RPCS3 (BLUS30001); other regions are patchy */
export const ps3Cover = (ids: string[]) => { const us = ids.find(i => i[2] === "U"); return us ? `https://art.gametdb.com/ps3/cover/US/${us}.jpg` : null; };
export const rpcs3Provider: Provider = {
  id: "compat-rpcs3", label: "RPCS3 compatibility", every: DAY, metaRank: 25,
  about: "PS3 games from RPCS3's compatibility database (games only, every status).",
  runtimes: () => EMULATORS.filter(e => e.id === "rpcs3"),
  async collect(ctx) {
    const all: Report[] = [];
    let first: string | null = null;
    for (let p = 1; p <= 40; p++) {
      const page = await getJson<RpcsPage>(ctx, `https://rpcs3.net/compatibility?api=v1&type=1&r=400&p=${p}`);
      if (page.return_code !== 0 || !page.results) break;
      const reports = parseRpcs3(page);
      if (!reports.length) break;
      if (p === 1) first = reports[0].id;
      else if (reports[0].id === first) break;          // past the last page the API silently serves page 1 again
      all.push(...reports);
      if (reports.length < 50) break;
      await Bun.sleep(800);
    }
    ctx.log(`${all.length} serials`);
    return groupReports(all, { runtime: "rpcs3", platform: "ps3", scheme: "serial", cover: ps3Cover });
  },
};

/* ─────────── Xbox 360 · Xenia Canary ─────────── */

const XENIA_STATUS: Record<string, Status> = { Playable: "playable", Gameplay: "ingame", Loads: "boots", Unplayable: "nothing", Unknown: "unknown" };
export function parseXenia(rows: { id: string; title: string; updated: string; state: string; url: string; labels?: { others?: string[] } }[]): Report[] {
  return rows.map(r => ({ id: r.id.toUpperCase(), name: r.title, status: XENIA_STATUS[r.state] ?? "unknown", at: ts(r.updated), link: r.url,
    note: r.labels?.others?.length ? r.labels.others.slice(0, 6).join(", ") : null }));
}
export const xeniaProvider: Provider = {
  id: "compat-xenia", label: "Xenia Canary compatibility", every: DAY, metaRank: 20,
  about: "Xbox 360 games from Xenia Canary's compatibility tracker (via the Xenia Manager database).",
  runtimes: () => EMULATORS.filter(e => e.id === "xenia-canary"),
  async collect(ctx) {
    return groupReports(parseXenia(await getJson(ctx, "https://raw.githubusercontent.com/xenia-manager/database/main/data/game-compatibility/canary.json")),
      { runtime: "xenia-canary", platform: "x360", scheme: "titleid" });
  },
};

/* ─────────── PS2 · PCSX2 ─────────── */

const PCSX2_STATUS: Record<number, Status> = { 1: "nothing", 2: "intro", 3: "menus", 4: "ingame", 5: "playable", 6: "perfect" };
export function parsePcsx2(index: Record<string, { name?: string; "name-en"?: string; region?: string; compat?: number }>): Report[] {
  const out: Report[] = [];
  for (const [serial, g] of Object.entries(index)) {
    if (!g || !g.compat || !PCSX2_STATUS[g.compat]) continue;
    const name = g["name-en"] || g.name;
    if (!name) continue;
    out.push({ id: serial, name, status: PCSX2_STATUS[g.compat], at: null, note: g.region ?? null });
  }
  return out;
}
export const pcsx2Provider: Provider = {
  id: "compat-pcsx2", label: "PCSX2 game index", every: DAY, metaRank: 25,
  about: "PS2 games rated in the game index PCSX2 ships with (unrated entries are left out).",
  runtimes: () => EMULATORS.filter(e => e.id === "pcsx2"),
  async collect(ctx) {
    const yaml = await getText(ctx, "https://raw.githubusercontent.com/PCSX2/pcsx2/master/bin/resources/GameIndex.yaml");
    return groupReports(parsePcsx2(Bun.YAML.parse(yaml) as any), { runtime: "pcsx2", platform: "ps2", scheme: "serial" });
  },
};

/* ─────────── Switch · Ryujinx (Ryubing) ─────────── */

export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
export function parseRyubing(text: string): Report[] {
  const [head, ...rows] = csvRows(text);
  const col = (n: string) => head.indexOf(n);
  const [id, name, labels, status, updated] = ["title_id", "game_name", "labels", "status", "last_updated"].map(col);
  return rows.map(r => {
    const s = (r[status] ?? "").trim().toLowerCase();
    return { id: (r[id] ?? "").trim().toUpperCase(), name: r[name] ?? "", status: (["playable", "ingame", "menus", "boots", "nothing"].includes(s) ? s : "unknown") as Status,
      at: ts(r[updated]), note: r[labels]?.trim() ? r[labels].split(";").slice(0, 6).join(", ") : null };
  });
}
export const ryubingProvider: Provider = {
  id: "compat-ryubing", label: "Ryujinx compatibility", every: DAY, metaRank: 20,
  about: "Switch games from the Ryubing (Ryujinx) compatibility list. Many reports are years old.",
  runtimes: () => EMULATORS.filter(e => e.id === "ryujinx" || e.id === "eden"),
  async collect(ctx) {
    return groupReports(parseRyubing(await getText(ctx, "https://raw.githubusercontent.com/Ryubing/Compatibility/HEAD/compatibility.csv")),
      { runtime: "ryujinx", platform: "switch", scheme: "titleid" });
  },
};

/** emulators that have no compatibility provider yet still belong in the runtime list */
export const emulatorRuntimesProvider: Provider = {
  id: "emulators", label: "Emulators", every: DAY, metaRank: 0,
  about: "The emulators the catalog knows and where their Windows builds come from.",
  runtimes: () => EMULATORS,
  async collect() { return []; },
};

export const COMPAT_PROVIDERS = [shadps4Provider, sharpemuProvider, rpcs3Provider, xeniaProvider, pcsx2Provider, ryubingProvider, emulatorRuntimesProvider];
