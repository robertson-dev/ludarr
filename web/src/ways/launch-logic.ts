/**
 * ludarr web — the rules behind the game page's "Starts with" (src/library/launch.ts on the server) that need no browser:
 * a pasted command line split as Windows splits it, an argument quoted as Windows programs read it back, the preview of
 * what runs on a player's PC, what Ahoy a start needs, and the words for where a start comes from and where it starts. Kept
 * free of React and of the API client so the engine's tests hold them against the server's own rules.
 */
import type { LaunchFields, LaunchStart, LaunchWords, StartBy } from "../api";

/** where a start comes from, in the admin's words */
export const BY_WORDS: Record<StartBy, string> = { hand: "set by hand", plan: "from the plan", ludarr: "found by ludarr", ai: "found by the AI importer" };
/** the Ahoy that takes a start changed in place at its next start (an older one offers the same copy as an update) */
export const REFRESH_AHOY = "0.11";
/** what copies players already installed do with a start set by hand */
export const INSTALLED_WORDS = `Copies already installed take it at their next start with Ahoy ${REFRESH_AHOY} or newer; older Ahoy offers them an update.`;

/**
 * The one line under a start of what the package says about its program: a quote holding the start's arguments, else the
 * program's version info, else a sentence whose subject is the program (it opens with its name) — never a sentence that
 * only mentions it in passing ("put x.dll next to the program").
 */
export function saidOfStart(words: LaunchWords[], exe: string, argv: string[]): LaunchWords | null {
  const quotes = words.filter(w => w.source !== "version info");
  const holds = argv.length ? quotes.find(w => argv.every(a => w.text.toLowerCase().includes(a.toLowerCase()))) : undefined;
  if (holds) return holds;
  const info = words.find(w => w.source === "version info");
  if (info) return info;
  const name = exe.slice(exe.lastIndexOf("/") + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subject = new RegExp(`^[…"'“(\\s]*(?:[\\w.-]+[\\\\/])*${name}(?![\\w])`, "i");
  return quotes.find(w => subject.test(w.text)) ?? null;
}

/** one argument the way Windows programs read their command line back (the launcher's own quoteArg) */
export function quoteArg(a: string): string {
  if (a !== "" && !/[\s"]/.test(a)) return a;
  let out = '"', slashes = 0;
  for (const ch of a) {
    if (ch === "\\") { slashes++; continue; }
    out += ch === '"' ? "\\".repeat(slashes * 2 + 1) + '"' : "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}
/** the whole start on one line: the program and every argument */
export const startLine = (exe: string, argv: string[]) => [exe, ...argv.map(quoteArg)].join(" ");

/** a command line split as Windows programs split theirs: spaces and tabs separate, double quotes keep spaces together,
 *  "" inside quotes is a quote, backslashes count only before a quote (2n of them: n and the quote opens or closes; 2n+1:
 *  n and a quote of the argument's own) */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", has = false, quoted = false, i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i] === "\\") { n++; i++; }
      if (line[i] === '"') { cur += "\\".repeat(n >> 1); if (n % 2) { cur += '"'; i++; } }
      else cur += "\\".repeat(n);
      has = true;
      continue;
    }
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i += 2; has = true; continue; }
      quoted = !quoted; has = true; i++;
      continue;
    }
    if (!quoted && /\s/.test(c)) { if (has) { out.push(cur); cur = ""; has = false; } i++; continue; }
    cur += c; has = true; i++;
  }
  if (has) out.push(cur);
  return out;
}

const placeholder = (s: string) => /\{[A-Za-z]+\}/.test(s);
/** a Windows command script: the one kind of script that can be what starts a game, when the admin picks it by hand */
export const isStartScript = (p: string | null | undefined) => /\.(bat|cmd)$/i.test(p ?? "");
/** what a script as the start means for every player, said wherever one is the start */
export const SCRIPT_WORDS = "A script: it runs through the Windows command shell on each player's PC, as it is written.";
/** what Ahoy needs to start it: 0.10 or newer for an argument the old space-joined form cannot carry (a space, a
 *  placeholder), a variable, or a placeholder in the folder; 0.11 or newer for a script (the server's startNeeds) */
export function needsAhoy(f: Pick<LaunchFields, "argv" | "cwd" | "env"> & { exe?: string }): string | null {
  const argv = f.argv.map(a => a.trim()).filter(Boolean);
  const simple = argv.every(a => !/\s/.test(a) && !placeholder(a));
  const ways = !simple || Object.keys(f.env).length > 0 || placeholder(f.cwd ?? "") ? "0.10.0" : null;
  return isStartScript(f.exe) ? newer(ways, "0.11.0") : ways;
}
const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(n => parseInt(n, 10) || 0), pb = b.split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
/** the newer of two Ahoy versions (null: none needed) */
export const newer = (a: string | null | undefined, b: string | null | undefined): string | null => (!a ? b ?? null : !b ? a : cmp(a, b) >= 0 ? a : b);
/** "0.10.0" as the admin reads it: "0.10" */
export const shortVersion = (v: string) => v.replace(/(\.0)+$/, "");

/**
 * What runs on a player's PC, with an example folder for the game (`install`): the program by its whole path, every
 * argument with {install} filled in (backslashes, as the launcher writes them) and {content} as the way's placed game file,
 * and the folder it starts in.
 */
export function preview(f: LaunchFields, o: { install: string; content: string | null }): { line: string; folder: string } {
  const win = (s: string) => s.replace(/\//g, "\\");
  const fill = (s: string) => {
    const c = o.content ? s.replace(/\{content\}/g, `{install}/${o.content}`) : s;
    return c.includes("{install}") ? win(c.split("{install}").join(o.install)) : c;
  };
  const exe = `${o.install}\\${win(f.exe)}`;
  const at = exe.lastIndexOf("\\");
  const cwd = f.cwd ?? "";
  const folder = !cwd ? exe.slice(0, at) : cwd.startsWith("{install}") ? fill(cwd) : `${o.install}\\${win(cwd)}`;
  return { line: [`"${exe}"`, ...f.argv.map(a => a.trim()).filter(Boolean).map(a => quoteArg(fill(a)))].join(" "), folder };
}

/** where a start starts, when it is not the program's own folder ("in the game's folder", "in logs"), else null */
export function startsInWords(s: LaunchStart["startsIn"]): string | null {
  return s.kind === "program" ? null : s.kind === "game" ? "in the game's folder" : `in ${s.folder}`;
}
/** the extras after a start's line: where it starts, its variables */
export function startExtras(s: Pick<LaunchStart, "startsIn" | "env">): string[] {
  const n = Object.keys(s.env ?? {}).length;
  return [startsInWords(s.startsIn), n ? `${n} variable${n === 1 ? "" : "s"}` : null].filter((x): x is string => !!x);
}

/** a pasted command line as a start: when its first word names one of the copy's programs (its path or its name, case
 *  ignored), that program and the rest as arguments; otherwise every word an argument */
export function pasted(line: string, programs: string[]): { exe: string | null; argv: string[] } {
  const words = splitCommandLine(line.trim());
  if (!words.length) return { exe: null, argv: [] };
  const first = words[0].replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const base = first.slice(first.lastIndexOf("/") + 1);
  const hit = programs.find(p => p.toLowerCase() === first) ?? programs.find(p => p.toLowerCase().endsWith(`/${base}`) || p.toLowerCase() === base);
  return hit ? { exe: hit, argv: words.slice(1) } : { exe: null, argv: words };
}
