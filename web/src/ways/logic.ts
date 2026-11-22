/**
 * ludarr web — the rules behind the pages for games added by hand and ways to play that need no browser: the platform
 * list, what the game form sends, repo addresses, how an AI run's steps read, how a way's card and a job read, and how a
 * carry run reads (its rail, what it does now, what it asks, its steps, the game's copy and the check). Kept free of React
 * and of the API client so the engine's tests can hold them against the server's own rules (tests/web-logic.test.ts).
 */
import type {
  CheckReport, ContentFile, ContentPlan, CopyView, GameDraft, Identity, JobView, PinnedProgram, Plan, PlanSpec, ProgramSource, RailState, RunAsk, RunPhase,
  RunStep, RunView, SmokeReport, TraceStep, Way, WayRun,
} from "../api";

/** a size as the pages show it: one decimal up to 100 GB ("54.2 GB", as the engine's own progress words say it) */
export const fmtSize = (b: number | null | undefined) => b == null || !Number.isFinite(b) ? "—" : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} KB`;
const upFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* ─────────── platforms: the ids src/platforms.ts knows (anything else is refused by the server) ─────────── */

export const PLATFORM_LABEL: Record<string, string> = {
  pc: "PC", mac: "macOS", linux: "Linux", ps5: "PlayStation 5", ps4: "PlayStation 4", ps3: "PlayStation 3", ps2: "PlayStation 2", ps1: "PlayStation", psp: "PSP", vita: "PS Vita",
  switch: "Switch", switch2: "Switch 2", wiiu: "Wii U", wii: "Wii", gc: "GameCube", n64: "Nintendo 64", snes: "SNES", nes: "NES", gba: "Game Boy Advance", gbc: "Game Boy Color", gb: "Game Boy", nds: "Nintendo DS", "3ds": "Nintendo 3DS",
  xsx: "Xbox Series X|S", xone: "Xbox One", x360: "Xbox 360", xbox: "Xbox", dc: "Dreamcast", saturn: "Saturn", genesis: "Mega Drive", arcade: "Arcade", android: "Android", ios: "iOS",
};
/** the same ids, grouped the way a picker lists them */
export const PLATFORM_GROUPS: { label: string; ids: string[] }[] = [
  { label: "Computers", ids: ["pc", "mac", "linux"] },
  { label: "PlayStation", ids: ["ps5", "ps4", "ps3", "ps2", "ps1", "psp", "vita"] },
  { label: "Nintendo", ids: ["switch2", "switch", "wiiu", "wii", "gc", "n64", "snes", "nes", "3ds", "nds", "gba", "gbc", "gb"] },
  { label: "Xbox", ids: ["xsx", "xone", "x360", "xbox"] },
  { label: "Sega", ids: ["dc", "saturn", "genesis"] },
  { label: "Arcade", ids: ["arcade"] },
  { label: "Phones", ids: ["android", "ios"] },
];
/** how the stores spell some of them (Steam: win, mac, lin) */
const PLATFORM_ALIAS: Record<string, string> = { win: "pc", windows: "pc", lin: "linux", macos: "mac", osx: "mac", "os x": "mac" };
export const platformLabel = (p: string) => PLATFORM_LABEL[platformIdOf(p)] ?? p;
/** an id for a platform named by its label ("Nintendo 64" → n64); anything else is kept as it is, for the server to judge */
export function platformIdOf(p: string): string {
  const t = p.trim();
  if (PLATFORM_LABEL[t]) return t;
  const lower = t.toLowerCase();
  return PLATFORM_ALIAS[lower] ?? Object.keys(PLATFORM_LABEL).find(id => id === lower || PLATFORM_LABEL[id].toLowerCase() === lower) ?? t;
}

/* ─────────── the game form ─────────── */

/** the server's limits for a game's description (src/ways/validate.ts validateGameDraft) */
export const LIMITS = { aliases: 5, searchTerms: 3, genres: 12, platforms: 10 } as const;

/** the form as typed: texts stay texts until it is sent */
export interface DraftForm {
  name: string; aliases: string[]; platforms: string[]; year: string; releaseIso: string; summary: string;
  genres: string[]; developer: string; publisher: string; searchTerms: string[];
}
export type DraftField = keyof DraftForm;
export const DRAFT_FIELDS: DraftField[] = ["name", "aliases", "platforms", "year", "releaseIso", "summary", "genres", "developer", "publisher", "searchTerms"];
/** what a game from a store or the catalog keeps editable: how it is searched (everything else comes from its source) */
export const SEARCH_FIELDS: DraftField[] = ["aliases", "searchTerms"];
export const FIELD_WORD: Record<DraftField, string> = {
  name: "name", aliases: "other names", platforms: "platforms", year: "year", releaseIso: "release date", summary: "summary", genres: "genres",
  developer: "developer", publisher: "publisher", searchTerms: "search terms",
};

export const emptyForm = (name = ""): DraftForm => ({ name, aliases: [], platforms: [], year: "", releaseIso: "", summary: "", genres: [], developer: "", publisher: "", searchTerms: [] });

/** a library game's details as the form shows them */
export function formOf(g: { name: string; aliases?: string[]; platforms?: string[]; releaseYear?: number | null; releaseIso?: string | null; summary?: string | null; genres?: string[]; developer?: string | null; publisher?: string | null; searchTerms?: string[] }): DraftForm {
  return {
    name: g.name ?? "", aliases: [...(g.aliases ?? [])], platforms: [...(g.platforms ?? [])], year: g.releaseYear != null ? String(g.releaseYear) : "",
    releaseIso: g.releaseIso && /^\d{4}-\d{2}-\d{2}$/.test(g.releaseIso) ? g.releaseIso : "", summary: g.summary ?? "", genres: [...(g.genres ?? [])],
    developer: g.developer ?? "", publisher: g.publisher ?? "", searchTerms: [...(g.searchTerms ?? [])],
  };
}

const clean = (s: string) => s.trim().replace(/\s+/g, " ");
export const yearOfIso = (iso: string | null | undefined): number | null => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Number(iso.slice(0, 4)) : null);

/** the GameDraft a form sends: trimmed, empty texts as null, the year a number (the date's year when only a date is given) */
export function draftOf(f: DraftForm): GameDraft {
  const releaseIso = f.releaseIso.trim() || null;
  const typed = f.year.trim();
  const y = typed ? Number(typed) : yearOfIso(releaseIso);
  return {
    name: clean(f.name), aliases: f.aliases.map(clean).filter(Boolean), platforms: f.platforms.map(platformIdOf),
    year: y != null && Number.isInteger(y) ? y : null, releaseIso, summary: f.summary.trim() || null,
    genres: f.genres.map(clean).filter(Boolean), developer: clean(f.developer) || null, publisher: clean(f.publisher) || null,
    searchTerms: f.searchTerms.map(clean).filter(Boolean),
  };
}

/** what the server would refuse, said before anything is sent: its limits, and a year that disagrees with the date */
export function formProblems(f: DraftForm, only?: DraftField[]): Partial<Record<DraftField, string>> {
  const p: Partial<Record<DraftField, string>> = {};
  const on = (k: DraftField) => !only || only.includes(k);
  if (on("name")) { const n = clean(f.name); if (!n) p.name = "The game needs a name"; else if (n.length > 200) p.name = "Up to 200 characters"; }
  if (on("aliases")) {
    if (f.aliases.length > LIMITS.aliases) p.aliases = `At most ${LIMITS.aliases} other names`;
    else if (f.aliases.some(a => a.length > 200)) p.aliases = "Each name up to 200 characters";
  }
  if (on("searchTerms")) {
    if (f.searchTerms.length > LIMITS.searchTerms) p.searchTerms = `At most ${LIMITS.searchTerms} search terms`;
    else if (f.searchTerms.some(a => a.length > 120)) p.searchTerms = "Each term up to 120 characters";
  }
  if (on("genres")) {
    if (f.genres.length > LIMITS.genres) p.genres = `At most ${LIMITS.genres} genres`;
    else if (f.genres.some(a => a.length > 60)) p.genres = "Each genre up to 60 characters";
  }
  if (on("platforms") && f.platforms.length > LIMITS.platforms) p.platforms = `At most ${LIMITS.platforms} platforms`;
  const y = f.year.trim(), d = f.releaseIso.trim();
  if (on("year") && y && (!/^\d{4}$/.test(y) || Number(y) < 1970 || Number(y) > 2100)) p.year = "A year between 1970 and 2100";
  if (on("releaseIso") && d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) p.releaseIso = "A date as YYYY-MM-DD";
    else if (y && !p.year && yearOfIso(d) !== Number(y)) p.year = `The year (${y}) and the release date (${d}) disagree`;
  }
  if (on("summary") && f.summary.trim().length > 4000) p.summary = "Up to 4000 characters";
  for (const k of ["developer", "publisher"] as const) if (on(k) && clean(f[k]).length > 200) p[k] = "Up to 200 characters";
  return p;
}

/**
 * A draft fills only the fields that are still empty, and says which it filled. A date that disagrees with a year the
 * admin typed (or a year that disagrees with their date) is left out rather than written next to it.
 */
export function fillEmpty(f: DraftForm, d: Partial<GameDraft> | null | undefined): { form: DraftForm; filled: DraftField[] } {
  const next: DraftForm = { ...f, aliases: [...f.aliases], platforms: [...f.platforms], genres: [...f.genres], searchTerms: [...f.searchTerms] };
  const filled: DraftField[] = [];
  if (!d || typeof d !== "object") return { form: next, filled };
  const text = (k: "name" | "summary" | "developer" | "publisher", v: unknown) => {
    if (!next[k].trim() && typeof v === "string" && v.trim()) { next[k] = k === "summary" ? v.trim() : clean(v); filled.push(k); }
  };
  const list = (k: "aliases" | "platforms" | "genres" | "searchTerms", v: unknown, max: number) => {
    if (next[k].length || !Array.isArray(v)) return;
    const vals = [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => (k === "platforms" ? platformIdOf(x) : clean(x))))].slice(0, max);
    if (vals.length) { next[k] = vals; filled.push(k); }
  };
  text("name", d.name);
  list("aliases", d.aliases, LIMITS.aliases);
  list("platforms", d.platforms, LIMITS.platforms);
  const typedYear = next.year.trim() ? Number(next.year.trim()) : null;
  if (!next.releaseIso.trim() && typeof d.releaseIso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.releaseIso) && (typedYear == null || yearOfIso(d.releaseIso) === typedYear)) {
    next.releaseIso = d.releaseIso; filled.push("releaseIso");
  }
  const dateYear = yearOfIso(next.releaseIso.trim());
  if (!next.year.trim() && typeof d.year === "number" && Number.isInteger(d.year) && (dateYear == null || dateYear === d.year)) { next.year = String(d.year); filled.push("year"); }
  text("summary", d.summary);
  list("genres", d.genres, LIMITS.genres);
  text("developer", d.developer);
  text("publisher", d.publisher);
  list("searchTerms", d.searchTerms, LIMITS.searchTerms);
  return { form: next, filled };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * The fields an edit changed, as PUT /game/:id/details takes them. A game added by hand sends any of its fields; a game
 * from a store or the catalog only its other names and search terms (the server refuses the rest).
 */
export function detailsPatch(before: DraftForm, after: DraftForm, manual: boolean): Partial<GameDraft> {
  const a = draftOf(before), b = draftOf(after);
  const keys: (keyof GameDraft)[] = manual ? ["name", "aliases", "platforms", "year", "releaseIso", "summary", "genres", "developer", "publisher", "searchTerms"] : ["aliases", "searchTerms"];
  const out: Partial<GameDraft> = {};
  for (const k of keys) if (!same(a[k], b[k])) (out as Record<string, unknown>)[k] = b[k];
  return out;
}

/**
 * GET /api/v1/release for a game not saved yet: its name and year, then every other name, every search term and every
 * platform (each repeated; one empty when none is picked). With its platforms, even none, the server judges the draft as
 * the saved game's own search will: a console game's dumps are searched and read as that game, and a game without a
 * platform gets the profile's console search when nothing certain turns up for PC.
 */
export function searchQuery(f: DraftForm, loose = false): string {
  const d = draftOf(f);
  const q = [`term=${encodeURIComponent(d.name)}`];
  if (d.year) q.push(`year=${d.year}`);
  for (const a of d.aliases) q.push(`aliases=${encodeURIComponent(a)}`);
  for (const t of d.searchTerms) q.push(`terms=${encodeURIComponent(t)}`);
  for (const p of d.platforms) q.push(`platforms=${encodeURIComponent(p)}`);
  // with no platforms at all the server would search by the name alone, which it never does for a saved game
  if (!d.platforms.length) q.push("platforms=");
  if (loose) q.push("loose=1");
  q.push("limit=100");
  return q.join("&");
}

/** "a", "a and b", "a, b and c" */
export function joinWords(list: string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** where a draft's fields came from (src/ways/construct.ts draftGame names its sources), in the admin's words */
const SOURCE_WORD: Record<string, string> = {
  typed: "what you typed", curated: "ludarr's own list", library: "your library", catalog: "the catalog", steam: "Steam", igdb: "IGDB", ai: "the AI importer",
};
export const sourceWord = (s: string) => SOURCE_WORD[s] ?? s;

/**
 * What a draft filled, said: each filled field marked with its own source ("from Steam"), the sources of the filled
 * fields only, and whether the draft found anything beyond the name the admin typed. `fields` is the draft route's
 * source per field.
 */
export function draftReport(filled: DraftField[], fields: unknown): { marks: Partial<Record<DraftField, string>>; sources: string[]; found: boolean } {
  const per = fields && typeof fields === "object" && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {};
  const marks: Partial<Record<DraftField, string>> = {};
  const sources: string[] = [];
  for (const k of filled) {
    const s = typeof per[k] === "string" && per[k] ? sourceWord(per[k] as string) : null;
    marks[k] = s ? `from ${s}` : "from the draft";
    if (s && !sources.includes(s)) sources.push(s);
  }
  return { marks, sources, found: Object.values(per).some(v => typeof v === "string" && v !== "typed") };
}

/* ─────────── games by name (src/catalog/store.ts normName, src/ways/construct.ts sameGame; the server decides) ─────────── */

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16" };

/** "The Legend of Zelda™: Majora’s Mask" → "legend of zelda majoras mask"; "Final Fantasy VII" → "final fantasy 7" */
export function normName(s: string): string {
  const words = s.replace(/[™®©]/g, "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
    .map(w => ROMAN[w] ?? w);
  if (words[0] === "the" && words.length > 1) words.shift();
  return words.join(" ");
}

/**
 * The same game: the same name, or one name the other's subtitle ("Majora's Mask" for "The Legend of Zelda: Majora's
 * Mask"): its last words, two at least and a fair part of it. A name the other only starts with is another game.
 */
export function sameGame(names: string[], others: string[]): boolean {
  const words = (s: string) => normName(s).split(" ").filter(Boolean);
  const a = names.map(words).filter(w => w.length), b = others.map(words).filter(w => w.length);
  const subtitle = (long: string[], short: string[]) =>
    short.length >= 2 && short.length < long.length && short.length / long.length >= 0.3 && short.every((w, j) => long[long.length - short.length + j] === w);
  return a.some(x => b.some(y => x.join(" ") === y.join(" ") || subtitle(x, y) || subtitle(y, x)));
}

/**
 * The plans that play this game, to be listed first: a recomp or port whose game file is this game (by its names), and an
 * emulator of one of its platforms. Every other plan follows (the server refuses a recomp or port for another game unless
 * the admin insists).
 */
export function plansFor<P extends Pick<Plan, "kind" | "platforms" | "spec">>(g: { name: string; aliases?: string[]; platforms?: string[] }, plans: P[]): { fits: P[]; others: P[] } {
  const names = [g.name, ...(g.aliases ?? [])];
  const plats = new Set((g.platforms ?? []).map(platformIdOf));
  const fits = plans.filter(p => (p.kind === "emulator"
    ? [...p.platforms, p.spec.content?.platform].some(x => !!x && plats.has(platformIdOf(x)))
    : !!p.spec.content && sameGame(names, p.spec.content.search)));
  return { fits, others: plans.filter(p => !fits.includes(p)) };
}

/* ─────────── repos (the same reading as src/ways/validate.ts normalizeRepo; the server decides) ─────────── */

export type RepoHint = { repo: string; host: "github" | "forgejo" | "feed" } | { error: string };

/** GitHub 'owner/name' (a github.com link, a git@ address or the bare form), 'forgejo:host/owner/name' (codeberg.org links become that), or a feed id */
export function repoHint(input: string): RepoHint {
  let s = String(input ?? "").trim().replace(/\s+/g, "");
  if (!s) return { error: "a repo is required" };
  if (/^dolphin:(beta|dev)$/i.test(s)) return { repo: s.toLowerCase(), host: "feed" };
  s = s.replace(/[#?].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, NAME = /^[A-Za-z0-9._-]{1,100}$/;
  const ok = (o: string, n: string) => OWNER.test(o) && NAME.test(n) && n !== "." && n !== "..";
  let m = s.match(/^forgejo:([a-z0-9.-]+(?::\d{1,5})?)\/([^/]+)\/([^/]+)$/i);
  if (m) {
    const host = m[1].toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(host)) return { error: `"${m[1]}" is not a host name` };
    if (!NAME.test(m[2]) || !ok("x", m[3])) return { error: "forgejo repos are written forgejo:host/owner/name" };
    return { repo: `forgejo:${host}/${m[2]}/${m[3]}`, host: "forgejo" };
  }
  m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/i) ?? s.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (m) return ok(m[1], m[2]) ? { repo: `${m[1]}/${m[2]}`, host: "github" } : { error: "that GitHub address does not name owner/name" };
  m = s.match(/^(?:https?:\/\/)?codeberg\.org\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (m) return NAME.test(m[1]) && ok("x", m[2]) ? { repo: `forgejo:codeberg.org/${m[1]}/${m[2]}`, host: "forgejo" } : { error: "that Codeberg address does not name owner/name" };
  m = s.match(/^([^/:]+)\/([^/]+)$/);
  if (m && ok(m[1], m[2])) return { repo: `${m[1]}/${m[2]}`, host: "github" };
  return { error: "not a repo: give a GitHub link or owner/name, or forgejo:host/owner/name for another forge" };
}

/** where a plan's repo is on the web */
export function repoUrl(repo: string): string | null {
  if (/^dolphin:/i.test(repo)) return "https://dolphin-emu.org/download/";
  const f = repo.match(/^forgejo:([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (f) return `https://${f[1]}/${f[2]}/${f[3]}`;
  if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repo)) return `https://github.com/${repo}`;
  return null;
}
/** a repo as typed, read the way the server reads it (the typed text when it is not one) */
export function repoTitle(raw: string): string {
  const h = repoHint(raw);
  return "repo" in h ? repoLabel(h.repo) : raw.trim();
}
/** a repo as the admin reads it */
export function repoLabel(repo: string): string {
  if (/^dolphin:beta$/i.test(repo)) return "Dolphin's beta builds";
  if (/^dolphin:dev$/i.test(repo)) return "Dolphin's development builds";
  return repo.startsWith("forgejo:") ? repo.slice("forgejo:".length) : repo;
}

/* ─────────── what a plan does, in a line ─────────── */

/** a plan the build job builds once (from source, without the game file); one that needs the game file builds per way when it is assembled */
export const buildsOnce = (p: ProgramSource | null | undefined) => p?.kind === "source" && p.content !== "build";

/**
 * The plan's own build action (POST /plan/:id/build): a program built once from source, its tools with it; or the tools
 * of a ready-made program (a release or a feed), which only that action builds. None for a program built per game (its
 * ways build it) or one with nothing to build.
 */
export function planBuildAction(spec: Pick<PlanSpec, "program" | "tools">): "Build from source" | "Build its tools" | null {
  if (buildsOnce(spec.program)) return "Build from source";
  if (spec.program?.kind !== "source" && spec.tools) return "Build its tools";
  return null;
}

const short = (h: string | null | undefined, n = 12) => (h ? h.slice(0, n) : "");
export function programLine(p: ProgramSource | null | undefined, pinned?: PinnedProgram | null): string {
  if (!p) return "—";
  const pin = pinned ? `pinned to ${pinned.tag} · ${pinned.asset}` : "";
  switch (p.kind) {
    case "release": return [`the release file matching /${p.assetPattern}/${p.channel === "nightly" ? " (nightly builds)" : ""}`, pin].filter(Boolean).join(" · ");
    case "feed": return [repoLabel(p.feed), pin].filter(Boolean).join(" · ");
    case "url": return `one fixed file (sha256 ${short(p.sha256)}…)`;
    case "source": return [`built from source at ${p.ref}${p.content === "build" ? ", once per game (the build needs the game file)" : ""}`, pinned ? `built ${pinned.tag}` : "not built yet"].join(" · ");
    default: return String((p as { kind?: string }).kind ?? "—");
  }
}
/** "a", "a or b", "a, b or c" */
export const orWords = (list: string[]) => (list.length <= 1 ? list[0] ?? "" : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`);
/** what a way's game file must be, in a line: its forms, the title ids, versions and builds it accepts, and how it is made */
export function contentLine(c: ContentPlan | null | undefined): string {
  if (!c) return "No game file: the program needs nothing else to start.";
  const plat = platformLabel(c.platform);
  const a = c.accept ?? { hashes: [] };
  const parts: string[] = [];
  if (c.kind === "folder") parts.push(`a game folder${c.marker ? ` (holding ${c.marker})` : ""}`);
  if (a.formats?.length) parts.push(a.formats.map(f => "." + f).join(" "));
  if (a.serials?.length) parts.push(orWords(a.serials));
  if (a.versions?.length) parts.push(`version ${orWords(a.versions)}`);
  if (a.builds?.length) parts.push(`build ${orWords(a.builds.map(b => (b.length > 12 ? `${b.slice(0, 8)}…` : b)))}`);
  const n = (a.hashes ?? []).length;
  if (n) parts.push(`${n} accepted version${n === 1 ? "" : "s"}`);
  else if (!a.serials?.length && !a.builds?.length) parts.push(`any ${plat} file`);
  if (c.make) parts.push(c.make.input.shape === "file" ? `made from ${orWords((c.make.input.formats ?? []).map(f => "." + f)) || "another file"}` : "made from the game folder");
  if (c.personalDump) parts.push(`made by ${c.personalDump}`);
  // an emulator way's description names its platform already ("Metroid Prime (GameCube)")
  const what = c.what.toLowerCase().includes(plat.toLowerCase()) ? c.what : `${c.what} (${plat})`;
  return [what, ...parts].join(" · ");
}

/* ─────────── an AI run's steps ─────────── */

const txt = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const firstLine = (t: string, n = 160) => { const l = t.split("\n")[0]; return l.length > n ? l.slice(0, n - 1) + "…" : l; };

/** one line saying what a tool call asked for */
export function toolLine(step: Pick<TraceStep, "tool" | "input">): string {
  const i = step.input ?? {};
  switch (step.tool) {
    case "github": return [txt(i.op), txt(i.path ?? i.query), i.ref ? `@ ${txt(i.ref)}` : ""].filter(Boolean).join(" ");
    case "fetch": return txt(i.url);
    case "download": return `${txt(i.name)} ← ${txt(i.url)}`;
    case "clone": return i.ref ? `at ${txt(i.ref)}` : "the default branch";
    case "shell": return `$ ${firstLine(txt(i.cmd))}`;
    case "list": case "read": return txt(i.path) || ".";
    case "grep": return `${txt(i.pattern)}${i.path ? ` in ${txt(i.path)}` : ""}`;
    case "hash": return `${txt(i.path)}${i.normalize ? ` (${txt(i.normalize)})` : ""}`;
    case "try_plan": return planLine(i.spec);
    case "finish": return `${i.ok === false ? "gave up" : "done"}${i.summary ? `: ${firstLine(txt(i.summary), 200)}` : ""}`;
    case "validate": return txt(i.launch_exe) || "the installed folder";
    default: return firstLine(JSON.stringify(i), 160);
  }
}
function planLine(spec: unknown): string {
  const p = (spec as { program?: ProgramSource } | null)?.program, l = (spec as { launch?: { exe?: string } } | null)?.launch;
  if (!p) return "a dry run of the plan";
  const prog = p.kind === "release" ? `release /${p.assetPattern}/` : p.kind === "feed" ? p.feed : p.kind === "url" ? "a fixed file" : p.kind === "source" ? `source at ${p.ref}` : String((p as { kind?: string }).kind);
  return `a dry run: ${prog}${l?.exe ? ` → ${l.exe}` : ""}`;
}

/** who said a step's words: ludarr's own list (a construct run's step 0 records its words as turn 0, before any model
 *  call), else the AI importer */
export const sayWho = (s: Pick<TraceStep, "turn">) => (s.turn === 0 ? "ludarr's own list" : "The AI importer");

export interface PlanVerdict { ok: boolean | null; problems: string[]; warnings: string[] }
/**
 * What a try_plan step's output says: the plan worked, or the problems it hit. JSON {ok, problems, warnings}, or the
 * engine's text (src/ways/construct-tools.ts renderReport): "try_plan #N: PASS" or "try_plan #N: NOT YET — …", its
 * problems: and warnings: lists, then "what it did:", the log, whose lines are never problems or warnings.
 */
export function tryPlanVerdict(output: string | null | undefined): PlanVerdict {
  const out = (output ?? "").trim();
  if (!out) return { ok: null, problems: [], warnings: [] };
  const list = (v: unknown) => (Array.isArray(v) ? v.map(x => (typeof x === "string" ? x : JSON.stringify(x))) : typeof v === "string" && v ? [v] : []);
  try {
    const j = JSON.parse(out);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const problems = list(j.problems ?? j.errors), warnings = list(j.warnings);
      return { ok: typeof j.ok === "boolean" ? j.ok : problems.length === 0, problems, warnings };
    }
  } catch { /* text */ }
  const lines = out.split("\n").map(l => l.trim()).filter(Boolean);
  const first = lines[0].replace(/^try_plan\s*#\d+\s*:\s*/i, "");
  let ok: boolean | null = /^(pass|ok\b|works|it works|the plan works|success)/i.test(first) ? true
    : /^(fail|not yet|problems?\b|refused|error|broken|does not|did not)/i.test(first) ? false : null;
  const problems: string[] = [], warnings: string[] = [];
  let into: string[] | null = null;
  for (const l of lines) {
    if (/^what it did\s*:/i.test(l)) break;
    const head = l.match(/^(problems?|errors?|warnings?)\s*:\s*(.*)$/i);
    if (head) { into = /^warn/i.test(head[1]) ? warnings : problems; if (head[2]) into.push(head[2]); continue; }
    if (into && /^[-•*]\s+/.test(l)) into.push(l.replace(/^[-•*]\s+/, ""));
  }
  if (ok === null && problems.length) ok = false;
  return { ok, problems, warnings };
}

/** the smoke-start screenshots a try_plan step's output names ("smoke start: screenshot job-12-1.png (attached)") */
export function smokeShots(output: string | null | undefined): { jobId: number; n: number }[] {
  const shots: { jobId: number; n: number }[] = [];
  for (const m of (output ?? "").matchAll(/\bscreenshot job-(\d+)-(\d+)\.png\b/g)) {
    const jobId = Number(m[1]), n = Number(m[2]);
    if (jobId > 0 && n > 0 && !shots.some(s => s.jobId === jobId && s.n === n)) shots.push({ jobId, n });
  }
  return shots;
}
/** where the engine serves a smoke-start screenshot; it wants the API key, so it is fetched with the key in the header */
export const shotPath = (jobId: number, n: number) => `/api/v1/plan/construct/${jobId}/shot/${n}`;
/**
 * A smoke-start screenshot as an object URL, never as an address with the key in it: `fetchBlob` (the API client) gets
 * it, and `ready` gives its URL once it is there (null when it is not kept any more). `stop` revokes it, or the one
 * still on its way as soon as it arrives.
 */
export function shotUrl(jobId: number, n: number, fetchBlob: (path: string) => Promise<Blob>): { ready: Promise<string | null>; stop: () => void } {
  return blobUrl(() => fetchBlob(shotPath(jobId, n)));
}
/**
 * A picture the API serves (it wants the key in the header), as an object URL once it is here; `stop` revokes it. The
 * picture is a screenshot of a program's window, so whatever the answer says it is, the URL is a PNG's: opened in a tab
 * of its own it shows as a picture, never as a page of this origin.
 */
export function blobUrl(fetchIt: () => Promise<Blob>): { ready: Promise<string | null>; stop: () => void } {
  let stopped = false, url: string | null = null;
  const ready = fetchIt().then(got => {
    const b = got.type === "image/png" ? got : new Blob([got], { type: "image/png" });
    const u = URL.createObjectURL(b);
    if (stopped) { URL.revokeObjectURL(u); return null; }
    url = u;
    return u;
  }, () => null);
  return { ready, stop: () => { stopped = true; if (url) { URL.revokeObjectURL(url); url = null; } } };
}
/** a check screenshot's file name as the engine names them (anything else is never asked for) */
export const checkShotName = (name: string | null | undefined): string | null => (name && /^[a-z0-9-]+\.png$/.test(name) ? name : null);

/** seconds since the run started as m:ss (h:mm:ss past an hour) */
export function fmtClock(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** JSON as typed in an editor: the value, or where it stops being JSON */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const lc = msg.match(/line (\d+) column (\d+)/i);
    if (lc) return { ok: false, error: `Not valid JSON at line ${lc[1]}, column ${lc[2]}` };
    const pos = msg.match(/position (\d+)/i);
    if (pos) {
      const at = Number(pos[1]), before = text.slice(0, at);
      return { ok: false, error: `Not valid JSON at line ${before.split("\n").length}, column ${at - before.lastIndexOf("\n")}` };
    }
    return { ok: false, error: `Not valid JSON (${msg.replace(/^JSON Parse error:\s*/i, "")})` };
  }
}

/**
 * what a finished construct job made: its plan, the way when it had a game, the game it proposes when it had none, and the
 * carry run that takes the plan on from there (a new plan's run, or the run whose repair round it was)
 */
export function constructOutcome(job: { id: number; manifest?: unknown; spec?: unknown }, plans: { id: number; jobId: number | null }[] = []): { planId: number | null; wayId: number | null; game: Partial<GameDraft> | null; runId: number | null } {
  const m = (job.manifest && typeof job.manifest === "object" ? job.manifest : {}) as { planId?: unknown; wayId?: unknown; game?: unknown; runId?: unknown };
  const s = (job.spec && typeof job.spec === "object" ? job.spec : {}) as { planId?: unknown; runId?: unknown };
  const num = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const planId = num(m.planId) ?? num(s.planId) ?? plans.find(p => p.jobId === job.id)?.id ?? null;
  return { planId, wayId: num(m.wayId), game: m.game && typeof m.game === "object" ? (m.game as Partial<GameDraft>) : null, runId: num(m.runId) ?? num(s.runId) };
}

/** a refusal about the AI importer's setup, which Settings → Importers fixes; other refusals (a game the repo does not
 *  play, a file kept for another game) are not, and get no such link */
export const aboutAiSetup = (message: string | null | undefined) => /\bAI importer\b/i.test(message ?? "");

/* ─────────── jobs ─────────── */

export const jobActive = (s: string | null | undefined) => s === "queued" || s === "running";
/** who did an import's work */
export const tierLabel = (tier: string | null | undefined) => (tier === "agent" ? "AI importer" : "recipes");
/**
 * Who did a job's work, for the Jobs tables: an import's tier; for a construct job the AI importer only when the AI ran
 * (tier 'agent'), else ludarr's own list, and nobody when it never ran: the runner writes the tier as the job starts,
 * so a job still queued, or cancelled before it started, has none. Nothing for the other kinds.
 */
export function jobBy(kind: string | null | undefined, tier: string | null | undefined): string | null {
  const k = kind ?? "import";
  if (k === "import") return tierLabel(tier);
  if (k === "construct") return tier === "agent" ? "AI importer" : tier ? "ludarr's own list" : null;
  return null;
}
/** a file kept for a way it does not fit: the content job's message says so ("kept X (1 MB) — not the file Y needs: …") */
export const misfitMessage = (message: string | null | undefined) => /\bnot the file\b.+\bneeds\b/i.test(message ?? "");
/** how a finished job reads: done; done with a warning (a file kept that is not the one its way needs); or not done */
export const jobEnd = (j: { state: string; message?: string | null }): "ok" | "warn" | "bad" =>
  (j.state !== "done" ? "bad" : misfitMessage(j.message) ? "warn" : "ok");

/* ─────────── a way's card ─────────── */

/** a status as its label reads (the tones are a part of kit.tsx's) */
export interface Look { label: string; tone: "default" | "primary" | "success" | "danger" | "warning" | "queue" | "accent" | "info" | "dim" | "outline" }
const WAY_STATUS: Record<string, Look> = {
  "needs-files": { label: "Needs files", tone: "warning" }, ready: { label: "Ready to build", tone: "primary" }, building: { label: "Building", tone: "queue" },
  built: { label: "Built", tone: "success" }, failed: { label: "Failed", tone: "danger" },
};
export const wayStatus = (s: string | null | undefined): Look => WAY_STATUS[s ?? ""] ?? { label: s ?? "—", tone: "dim" };
/**
 * A way's status as its card and its plan's dialog read it. 'ready' (src/ways/store.ts settleWay) only says the way has
 * its files: it reads "Ready to build" only when a press of Build is all that is missing, and "Waiting for its plan"
 * while the plan has to be checked, mended or built first.
 */
export function wayLook(w: { status: string; blockers?: { code: string }[] }, planStatus?: string | null): Look {
  if (w.status === "ready") {
    const b = w.blockers ?? [];
    if (b.some(x => x.code === "plan") || (planStatus != null && planStatus !== "ready")) return { label: "Waiting for its plan", tone: "warning" };
    if (b.some(x => x.code === "file" || x.code === "needs")) return WAY_STATUS["needs-files"];
  }
  return wayStatus(w.status);
}
/** the way a job is about: a way's build (assemble), its plan's build for it (a build with a wayId), its game file being
 *  made (make), or the game's copy being taken in for it (a content job with fromCopy) */
export const jobWay = (j: Pick<JobView, "kind" | "spec">) =>
  (j.kind === "assemble" || j.kind === "build" || j.kind === "make" || (j.kind === "content" && !!j.spec?.fromCopy) ? Number(j.spec?.wayId) || null : null);
/**
 * The job a way's card shows: the server's after each reload (the way's build, or its plan's first build for this game);
 * a tick of that same job only freshens it, and a tick of a job the server has not listed yet (it just started) shows
 * until the next reload.
 */
export function wayJob(served: JobView | null, tick: JobView | null): JobView | null {
  const s = served && jobActive(served.state) ? served : null;
  if (s) return tick && tick.id === s.id ? (jobActive(tick.state) ? tick : null) : s;
  return tick && jobActive(tick.state) ? tick : null;
}
export interface WayCardModel {
  /** the job on the card while it is queued or running */
  job: JobView | null;
  building: boolean;
  look: Look;
  /** what that job is doing, as the card's part heading says it */
  jobTitle: string;
  /** the plan is built per game and not yet built: its first build is this way's (the plan blocker's link starts it) */
  perGameFirst: boolean;
  /**
   * the repin action's label: a release or feed program that is pinned can build with its newest release instead, built
   * yet or not. A pinned file gone from its host fails every Build until the pin moves, and once Check has made the plan
   * ready again such a way can look like one never built: a file landing for the game sets a failed way back to ready
   * (src/ways/store.ts settleWay), and the card has no record of the failure.
   */
  repin: string | null;
}
/** a job on a way's card, by its kind: the status it reads while queued and while running, and its part's heading */
const JOB_LOOK: Record<string, { queued: string; running: string; title: string }> = {
  make: { queued: "Queued: its game file", running: "Making its game file", title: "Making its game file" },
  content: { queued: "Queued: the game's copy", running: "Taking the game's copy", title: "Taking in the game's copy" },
};
/** what a way's card shows, from the way the server listed, its plan, and the latest event of its job */
export function wayCard(w: Pick<Way, "status" | "job" | "blockers" | "plan">, plan: Pick<Plan, "spec" | "pinned" | "status"> | null, tick: JobView | null): WayCardModel {
  const job = wayJob(w.job, tick);
  const kind = JOB_LOOK[job?.kind ?? ""];
  const look: Look = job?.state === "queued" ? { label: kind?.queued ?? "Queued to build", tone: "dim" } : job ? (kind ? { label: kind.running, tone: "queue" } : wayStatus("building")) : wayLook(w, w.plan?.status ?? plan?.status);
  const prog = plan?.spec.program;
  const perGameFirst = prog?.kind === "source" && prog.content === "build" && !/@[0-9a-f]{40}$/.test(plan?.pinned?.tag ?? "");
  const repin = plan?.pinned && (prog?.kind === "release" || prog?.kind === "feed") ? (w.status === "built" ? "Update the program" : "Build with the newest release") : null;
  const jobTitle = kind ? kind.title : job?.kind === "build" ? (prog && prog.kind !== "source" ? "Building the program for this game on the server" : "Building it from source for this game") : "Building";
  return { job, building: !!job || w.status === "building", look, jobTitle, perGameFirst, repin };
}

/* ─────────── carry runs: a repo carried all the way to a game members install (src/ways/carry.ts) ─────────── */

/** the rail's phases, in order */
export const RAIL_PHASES = ["plan", "game", "file", "build", "check"] as const;
export type RailPhase = (typeof RAIL_PHASES)[number];
/** a phase as the admin reads it */
export const PHASE_WORD: Record<RunPhase, string> = { plan: "Plan", game: "Game", file: "Game file", build: "Build", check: "Check", done: "Done" };
/** a run that still carries its game on: not done, not stopped */
export const runOpen = (state: string | null | undefined) => !!state && state !== "done" && state !== "stopped";
/** a run that follows a job or a request of its own right now (what it does has real progress) */
export const runWorking = (state: string | null | undefined) => state === "active" || state === "waiting";
/** a progress as a part of 1, whichever way it came (a part, or a percentage) */
export const fraction = (p: number) => { const v = p > 1 ? p / 100 : p; return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)); };

export type RailTone = "ok" | "active" | "wait" | "ask" | "bad" | "env" | "todo";
/** a phase on the rail: `words` its state in words, `summary` what the run says of it, `line` what the full rail shows
 *  under its label (the summary, with the state first when the run is on hold or stopped there) */
export interface RailStep { phase: RailPhase; label: string; state: RailState; icon: string; words: string; tone: RailTone; summary: string | null; line: string }
const RAIL_LOOK: Record<RailState, { icon: string; words: string; tone: RailTone }> = {
  done: { icon: "check", words: "done", tone: "ok" },
  active: { icon: "spinner", words: "working on it", tone: "active" },
  waiting: { icon: "clock", words: "waiting", tone: "wait" },
  asked: { icon: "help", words: "asks you", tone: "ask" },
  failed: { icon: "x", words: "failed", tone: "bad" },
  env: { icon: "minusCircle", words: "not checked here", tone: "env" },
  todo: { icon: "circle", words: "not yet", tone: "todo" },
};
/**
 * The run's rail, Plan · Game · Game file · Build · Check, each phase in the state the server gives it (one it does not
 * list is still to come). A stopped run shows no phase as still working, and a run on hold none as moving.
 */
export function runRail(v: Pick<RunView, "rail" | "state">): RailStep[] {
  const by = new Map((v.rail ?? []).map(r => [r.phase, r] as const));
  return RAIL_PHASES.map(phase => {
    const r = by.get(phase);
    const state: RailState = r && RAIL_LOOK[r.state] ? r.state : "todo";
    let look = RAIL_LOOK[state], paused = false;
    if (state === "env" && phase !== "check") look = { ...look, words: "the server cannot do it now" };
    if (v.state === "stopped" && (state === "active" || state === "waiting" || state === "asked")) { look = { icon: "minusCircle", words: "stopped here", tone: "todo" }; paused = true; }
    else if (v.state === "held" && (state === "active" || state === "waiting")) { look = { icon: "clock", words: "on hold", tone: "wait" }; paused = true; }
    const summary = r?.summary ?? null;
    const line = summary ? (paused ? `${upFirst(look.words)}: ${summary}` : upFirst(summary)) : upFirst(look.words);
    return { phase, label: PHASE_WORD[phase], state, icon: look.icon, words: look.words, tone: look.tone, summary, line };
  });
}

/** what each ask is waiting for, as the run's label says it */
const ASK_LOOK: Record<string, string> = {
  file: "Needs its game data", "held-file": "Needs your look at a file", game: "Needs the game it plays", choice: "Needs your choice",
  needs: "Needs a system file", ai: "Needs the AI importer", budget: "Out of AI budget", room: "Needs room on the library",
  env: "Waiting for the server", "go-ahead": "Waiting for your go-ahead",
};
/** a run's state as its label reads */
export function runLook(v: { state: string; ask?: Pick<RunAsk, "code"> | null }): Look {
  if (runWorking(v.state)) return { label: "Working on it", tone: "queue" };
  if (v.state === "asking") return { label: (v.ask && ASK_LOOK[v.ask.code]) || "Asks you", tone: "warning" };
  if (v.state === "held") return { label: (v.ask && ASK_LOOK[v.ask.code]) || "On hold", tone: "warning" };
  if (v.state === "done") return { label: "Done", tone: "success" };
  if (v.state === "stopped") return { label: "Stopped", tone: "dim" };
  return { label: v.state || "—", tone: "dim" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** when something is due, in the admin's words: "now", "at 18:40" (today), "tomorrow at 06:10", "on 12 Nov at 06:10" */
export function whenWords(sec: number, nowSec = Date.now() / 1000): string {
  if (sec <= nowSec + 30) return "now";
  const d = new Date(sec * 1000), n = new Date(nowSec * 1000);
  if (sameDay(d, n)) return `at ${hhmm(d)}`;
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  if (sameDay(d, next)) return `tomorrow at ${hhmm(d)}`;
  return `on ${d.getDate()} ${MONTHS[d.getMonth()]} at ${hhmm(d)}`;
}
/** when a step happened: "18:40" today, "7 Nov 18:40" before */
export function stepTime(sec: number, nowSec = Date.now() / 1000): string {
  const d = new Date(sec * 1000);
  return sameDay(d, new Date(nowSec * 1000)) ? hhmm(d) : `${d.getDate()} ${MONTHS[d.getMonth()]} ${hhmm(d)}`;
}

/** what an asking run keeps doing by itself: "Still watching: next search at 18:40 · the inbox every 2 minutes" */
export function watchLine(w: RunAsk["watching"] | null | undefined, nowSec = Date.now() / 1000): string | null {
  if (!w) return null;
  const parts = [w.nextSearchAt ? `next search ${whenWords(w.nextSearchAt, nowSec)}` : "no search of the indexers planned", w.inbox ? `the inbox every ${w.every || "2 minutes"}` : null];
  return `Still watching: ${parts.filter(Boolean).join(" · ")}`;
}

/** a text cut into its sentences (a version's dots, "1.07", never end one) */
function sentences(t: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of t.matchAll(/([.!?]\)?)\s+(?=[A-Z("“])/g)) {
    const end = (m.index ?? 0) + m[1].length;
    out.push(t.slice(from, end).trim());
    from = end;
  }
  out.push(t.slice(from).trim());
  return out.filter(Boolean);
}
/** "a", "a or b", "a, b, or c" */
const orList = (parts: string[]) => (parts.length <= 2 ? parts.join(" or ") : `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`);
const bare = (p: string) => p.replace(/[\\/]+$/, "");

export interface AskModel {
  code: RunAsk["code"]; title: string;
  /** the need, sentence by sentence, without the ones the card says itself (the inbox folder and its hint) */
  need: string[];
  tried: string[];
  /** the inbox: the path shown (as the admin's PC opens it when Settings says how), the server's own path in small type
   *  when the shown one is the PC's, whether a folder in it starts with a dot, whether Settings says how the PC opens it */
  inbox: { shown: string; server: string | null; dotted: boolean; mapped: boolean } | null;
  /** how what is asked for can come in ("Put it in this folder, pick it on the server, or upload it: …") */
  bring: string | null;
  /** the controls the ask offers */
  pick: boolean; upload: boolean; accept: number | null;
  choices: RunAsk["choices"]; newGame: boolean; pickGame: boolean; go: boolean; retry: boolean;
  link: { to: string; label: string } | null;
  watching: string | null; byAi: string | null;
}
/**
 * What an ask's card shows, from the ask alone: its words, the inbox folder (with a copy button) instead of the sentence
 * that names it, and only the controls that can work for what is asked for, as the engine takes answers (carry-api.ts):
 * an upload only when the ask says one can bring it; a game (one of its choices, another library game, or a new game from
 * the plan) only for "which game" — the plan's own question, or which game an emulator should make playable, never a
 * question the AI asked; Go ahead / Not now only for a go-ahead. A question the AI asked is answered by changing what it
 * asks about (the plan, a file): Look again now then lets the run try once more.
 */
export function askLines(ask: RunAsk, o: { planId?: number | null; nowSec?: number } = {}): AskModel {
  const code = ask.code, ai = !!ask.byAi;
  const paths = [ask.inbox, ask.inboxShare].filter((p): p is string => !!p).map(bare);
  const need = sentences(ask.need ?? "").filter(s => !paths.some(p => s.includes(p)) && !/starts with a dot/i.test(s));
  const shown = ask.inboxShare || ask.inbox;
  const inbox = shown ? { shown, server: ask.inboxShare && ask.inbox ? ask.inbox : null, dotted: /(^|[\\/])\.[^\\/.]/.test(shown), mapped: !!ask.inboxShare } : null;
  const file = code === "file";
  const upload = file && !!ask.canUpload;
  const bring = file ? `${upFirst(orList([...(inbox ? ["put it in this folder"] : []), "pick it on the server", ...(upload ? ["upload it"] : [])]))}: ludarr takes it from there and finishes by itself.` : null;
  const answersGame = code === "game" || (code === "choice" && !ai);
  const games = answersGame ? ask.choices ?? [] : [];
  const link = code === "needs" && o.planId ? { to: `/settings/runtimes?plan=${o.planId}`, label: "Fill it with the plan" }
    : code === "ai" ? { to: "/settings/importers", label: "Settings → Importers" }
    : code === "budget" ? { to: "/settings/general", label: "Settings → General → Import" }
    : code === "room" ? { to: "/settings/mediamanagement", label: "The root folders and their free space" }
    : code === "choice" && ai && o.planId ? { to: `/settings/runtimes?plan=${o.planId}`, label: "Open the plan" } : null;
  return {
    code, title: ask.title, need, tried: ask.tried ?? [], inbox: file ? inbox : null, bring,
    pick: file, upload, accept: code === "held-file" ? ask.heldContentId ?? null : null,
    choices: games, newGame: code === "game", pickGame: answersGame,
    go: code === "go-ahead", retry: ai || !["game", "choice", "go-ahead"].includes(code),
    link, watching: watchLine(ask.watching, o.nowSec), byAi: ask.byAi ?? null,
  };
}

/** a run in one line, for lists: what it asks, what it does now (with its progress), or how it ended */
export function runLine(v: Pick<RunView, "state" | "phase" | "ask" | "now" | "rail">): string {
  if (v.ask && (v.state === "asking" || v.state === "held")) return `${v.ask.title}${v.ask.watching ? " · still watching" : ""}`;
  // held with no ask: the admin cancelled what it followed (a job, or the way's search)
  if (v.state === "held") return "On hold since you cancelled what it was doing: Resume carries on";
  if (v.state === "stopped") return "Stopped";
  if (v.state === "done") { const check = (v.rail ?? []).find(r => r.phase === "check"); return check?.summary && check.state !== "todo" ? `Done · the check: ${check.summary}` : "Done"; }
  if (v.now?.text) return `${upFirst(v.now.text)}${v.now.progress != null ? ` · ${Math.round(fraction(v.now.progress) * 100)}%` : ""}`;
  return `${PHASE_WORD[v.phase] ?? v.phase}: working on it`;
}
/** when an open run looks again by itself ("looks again at 18:40"); nothing for one that follows its own job right now */
export function nextLook(v: Pick<RunView, "state" | "nextAt">, nowSec = Date.now() / 1000): string | null {
  if (!runOpen(v.state) || runWorking(v.state) || !v.nextAt) return null;
  return `looks again ${whenWords(v.nextAt, nowSec)}`;
}

/**
 * Whether a run's card shows what it does now: while it follows a job or a request of its own, and while it asks only
 * when its search has something moving (a download, or the file it brought being taken in: a job, or progress), so the
 * bytes of a long step show while the ask stands. A search that only looks shows as the ask's "Still watching" line.
 */
export function nowShown(v: Pick<RunView, "state" | "now">): boolean {
  if (!v.now) return false;
  if (runWorking(v.state)) return true;
  return v.state === "asking" && (v.now.jobId != null || (v.now.progress ?? 0) > 0);
}

/**
 * What a run does now. `heading` is the run's own words, left out when they are the job's own words of an earlier moment
 * (the engine says what a running job says), so the live line is not said twice; `detail` is the job's live words (the
 * step it is on, bytes of total), on a line of its own so a long one wraps instead of being cut.
 */
export interface NowModel { text: string; heading: string | null; progress: number | null; detail: string | null; queued: boolean; jobId: number | null; requestId: number | null }
/** the same words but for the numbers in them ("22.1 of 54.2 GB" and "23.9 of 54.2 GB") */
const sameWords = (a: string, b: string) => { const k = (s: string) => s.toLowerCase().replace(/[\d.,]+/g, "#").replace(/\s+/g, " ").trim(); return k(a) === k(b); };
/** what a run does now: its own words, and the live progress of the job it follows when that job's latest tick is here */
export function runNow(now: RunView["now"] | null | undefined, tick: Pick<JobView, "id" | "state" | "progress" | "message"> | null): NowModel | null {
  if (!now) return null;
  const live = tick && now.jobId != null && tick.id === now.jobId && jobActive(tick.state) ? tick : null;
  const p = live ? live.progress : now.progress;
  const detail = live?.message?.split("\n")[0]?.trim() || null;
  return { text: now.text, heading: detail && sameWords(now.text, detail) ? null : now.text, progress: p == null ? null : fraction(p), detail, queued: live?.state === "queued", jobId: now.jobId, requestId: now.requestId };
}

export type StepTone = "ok" | "bad" | "wait" | "env" | "ask" | "none";
const STEP_LOOK: Record<string, { icon: string; tone: StepTone; word: string }> = {
  ok: { icon: "check", tone: "ok", word: "done" }, refused: { icon: "ban", tone: "bad", word: "refused" }, failed: { icon: "alert", tone: "bad", word: "failed" },
  waiting: { icon: "clock", tone: "wait", word: "waiting" }, env: { icon: "minusCircle", tone: "env", word: "not checked here" }, asked: { icon: "help", tone: "ask", word: "asked you" },
};
/** a step's outcome as its icon and word */
export const stepIcon = (s: Pick<RunStep, "outcome">): { icon: string; tone: StepTone; word: string } => STEP_LOOK[s.outcome ?? ""] ?? { icon: "dot", tone: "none", word: "" };
/** who took a step: "ludarr", "the AI", "you" */
export const whoWord = (who: string) => (who === "ai" ? "the AI" : who === "admin" ? "you" : who === "ludarr" ? "ludarr" : who);
const STARTED: Record<string, string> = { construct: "started when its plan was saved", admin: "started by you", way: "started when this way to play was added", backfill: "started by ludarr for a way not built yet" };
/** why the run started; a backfill run with no way (wayId null) was started for a plan with nothing playable yet */
export const startedWords = (by: string, wayId?: number | null) =>
  by === "backfill" && wayId === null ? "started by ludarr for a plan with no way to play yet" : STARTED[by] ?? `started by ${by}`;
const millions = (n: number) => { const m = Math.max(0, n) / 1e6; return String(m < 1 ? Math.round(m * 100) / 100 : m < 10 ? Math.round(m * 10) / 10 : Math.round(m)); };
/** what the run's AI may still spend */
export function budgetLine(b: RunView["budget"] | null | undefined): string | null {
  if (!b) return null;
  if (!b.rounds) return "AI repairs are switched off (Settings → General → Import: AI repairs per game)";
  return `AI repairs: ${b.roundsUsed} of ${b.rounds} used · ${millions(b.tokensUsed)} of ${millions(b.tokens)} million tokens`;
}

export interface CopyLine { text: string; tone: "ok" | "warn" | "wait"; icon: string }
/** the game's copy on the server, as a way's card says it: its file, made from it, or exactly why it cannot be either */
export function copyLine(copy: CopyView | null | undefined): CopyLine | null {
  if (!copy) return null;
  const it = `the game's copy on the server (${copy.name}, ${fmtSize(copy.size)})`;
  const why = (copy.why ?? "").trim().replace(/[.\s]+$/, "");
  switch (copy.serves) {
    case "direct": return { tone: "ok", icon: "box", text: `${upFirst(it)} is the game file this way needs: the build takes it as it is.` };
    case "make": return { tone: "ok", icon: "box", text: `The game file is made from ${it}.` };
    case "no": return { tone: "warn", icon: "alert", text: `${upFirst(it)} is ${why || "not the game file this way needs"}.` };
    default: return { tone: "wait", icon: "spinner", text: `Looking at ${it}…` };
  }
}
/** what a file's own bytes say, in a line ("PPSA01342 · US · disc 01.00 · sealed for the console"), or null */
export function identityWords(id: Identity | null | undefined): string | null {
  if (!id) return null;
  const category = id.category === "patch" ? "an update, not the game" : id.category === "addon" ? "an add-on, not the game" : id.category === "app" ? "an application, not a game" : null;
  const parts = [id.serial ?? id.discId ?? id.gameCode ?? null, id.region ?? null, id.version ?? (id.masterVersion ? `disc ${id.masterVersion}` : null),
    id.build ? `build ${id.build.length > 12 ? `${id.build.slice(0, 8)}…` : id.build}` : null, category, id.sealed ? "sealed for the console" : null];
  return parts.filter(Boolean).join(" · ") || null;
}
/** a kept file that may be the game's copy kept a second time: the bytes freeing it gives back, and whether the engine said so */
export interface SecondCopy { bytes: number; sure: boolean }
/**
 * A kept file that is the game's copy kept a second time, in its own space. The engine says so when it tells
 * (secondCopy: it compared the bytes and the files). An engine that does not tell is read by the copy's own name and size,
 * only on a file kept from the copy that no way uses, and only as a guess (`sure` false): a file the copy was taken in by
 * a link has the same name and size and frees nothing, and the free itself compares the bytes before it changes anything.
 */
export function secondCopy(f: Pick<ContentFile, "role" | "source" | "name" | "size" | "secondCopy">, copy: Pick<CopyView, "name" | "size"> | null | undefined, used = false): SecondCopy | null {
  if (f.secondCopy !== undefined) return f.secondCopy ? { bytes: f.secondCopy.bytes, sure: true } : null;
  return f.role === "game" && f.source === "package" && !used && !!copy && f.name === copy.name && f.size === copy.size ? { bytes: f.size, sure: false } : null;
}
/**
 * Whether a way's card offers "Make it playable": the engine has runs (the way listing names the way's run, or null),
 * the way has its plan and is not built, no run of it is open, and nothing is being built for it.
 */
export function canCarry(w: Pick<Way, "status" | "plan"> & { run?: WayRun | null }, run: Pick<WayRun, "state"> | null | undefined = w.run, job: Pick<JobView, "state"> | null = null): boolean {
  if (w.run === undefined || !w.plan || w.status === "built" || w.status === "building") return false;
  if (run && runOpen(run.state)) return false;
  return !(job && jobActive(job.state));
}

/**
 * The job whose trace holds the run's check: the build its newest check step names, else the newest step of ludarr's
 * own in the build (or at the end) that names a job — the way's build, which ran the check and keeps it in its trace (the
 * engine writes "built: …" with that job while the run is still in its build, and the check's own step without one). A
 * step of the AI's names its round, which holds no check.
 */
export function checkJobOf(steps: RunStep[] | null | undefined): number | null {
  const list = steps ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].phase === "check" && list[i].jobId && list[i].who !== "ai") return list[i].jobId!;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if ((s.phase === "build" || s.phase === "done") && s.jobId && s.who === "ludarr") return s.jobId;
  }
  return null;
}
/** the last check an assemble job's trace holds ({kind: "check", report}) */
export function checkOfTrace(trace: unknown): CheckReport | null {
  if (!Array.isArray(trace)) return null;
  for (let i = trace.length - 1; i >= 0; i--) {
    const s = trace[i] as { kind?: unknown; report?: unknown } | null;
    if (s && s.kind === "check" && s.report && typeof s.report === "object" && Array.isArray((s.report as CheckReport).steps)) return s.report as CheckReport;
  }
  return null;
}
const lastWords = (s: string) => s.trim().replace(/[.\s]+$/, "");
/** what the program's smoke start showed, in a line: its windows and how it ended (the check's verdict says what that means) */
export function smokeLine(s: SmokeReport): string {
  const windows = s.titles.length ? `its window${s.titles.length === 1 ? "" : "s"} ${s.titles.map(t => `“${t}”`).join(", ")} came up` : "no window came up";
  const end = s.alive ? "it kept running" : s.exitCode != null ? `it stopped (exit ${s.exitCode})` : "it stopped";
  return `The smoke start: ${windows}, and ${end}`;
}
/** why the smoke start did not pass, or passed, as the check's verdict says it */
const smokeVerdict = (s: SmokeReport) =>
  s.verdict === "pass" ? "The program started on the server"
  : `The program did not start${s.exitCode != null ? ` (exit ${s.exitCode})` : ""}${s.why ? `: ${lastWords(s.why)}` : ""}`;
/** a check's verdict in a line: passed, what failed, or why the server could not tell */
export function checkWords(r: CheckReport): { tone: "ok" | "bad" | "env" | "none"; text: string } {
  if (r.verdict === "pass") return { tone: "ok", text: r.smoke?.verdict === "pass" ? "The checks passed, and the program started on the server" : "The checks passed" };
  if (r.verdict === "fail") {
    const bad = r.steps.find(s => !s.ok);
    if (bad) return { tone: "bad", text: `${upFirst(lastWords(bad.what))} failed${bad.code != null ? ` (exit ${bad.code})` : ""}` };
    return { tone: "bad", text: r.smoke && r.smoke.verdict === "fail" ? smokeVerdict(r.smoke) : "A check failed" };
  }
  if (r.verdict === "env") {
    // a smoke start the server could not give a window, or a check step it could not run (a CPU it lacks)
    const smoke = r.smoke?.verdict === "env" && !!r.smoke.why;
    const why = smoke ? r.smoke!.why : r.text.replace(/^not (?:started|run|checked) here:\s*/i, "");
    return { tone: "env", text: `${smoke || /^not started here/i.test(r.text) ? "Not started here" : "Not run here"}: ${lastWords(why) || "the server cannot tell"}` };
  }
  return { tone: "none", text: "The plan has no checks to run on the server" };
}
