/**
 * ludarr — what a carry run asks the admin, in words generated from structured facts (the content plan and its make
 * recipe, the verdicts on the game's copy, the kept files and the indexers), never from the AI's prose alone: when a repair
 * round asks, its exact line comes along as byAi, beside the words made here. Every ask names only actions that can work
 * for that content: an upload only for one file within the upload limit, the inbox folder as the admin's PC opens it when
 * Settings says how (Library as your PC sees it), with the server's own path beside it.
 *
 * The words are admin-facing (the run's routes are admin-only): they may name plans, programs and the AI. Nothing here
 * reaches players.
 */
import { cfg, cfgNum } from "../config";
import { PLATFORM_LABEL, type PlatformId } from "../platforms";
import { SIZE_RANGE } from "./find";
import type { AskCode, AskSpec, ContentPlan, CopyView, NeedSlot, RunAsk } from "./types";

/** swapped in tests: the largest upload the server takes, and the sizes a console's game files come in */
export const askdeps = {
  uploadMaxBytes: (): number => Math.max(1, cfgNum("CONTENT_UPLOAD_MAX_GB", 16)) * 1e9,
  sizeRange: (platform: string): [number, number] | null => SIZE_RANGE[platform as PlatformId] ?? null,
};

/** the library folder as the admin's PC opens it (LIBRARY_SHARE_PATH), or null when it is not set */
export function sharePath(): string | null {
  const s = cfg("LIBRARY_SHARE_PATH").trim();
  return s || null;
}

/** what the run tried for the game file, each as a fact the words are made from */
export interface TriedFacts {
  /** the game's copy on the server and why it is no file for the way (copyServes 'no') */
  copy?: { name: string; size: number; why: string } | null;
  /** files kept on the server that are not the way's file, each with why (same: the same bytes as the copy) */
  kept?: { name: string; why: string; same?: boolean }[];
  /** a route the run tried that failed and is not tried again until something changes (a make, a build) */
  failed?: { what: string; why: string }[];
  /** the indexers: how many releases were looked at, the top reason one was refused, when they are searched again; or why
   *  they are not searched now */
  indexers?: { looked: number; reason: string | null; nextAt: number | null; not?: string | null; searching?: boolean } | null;
  /** a download of the game that is already running (an ordinary search of the game), which the run waits for */
  download?: { title: string | null } | null;
  /** why the game's inbox folder cannot be used (then it is not offered) */
  inbox?: string | null;
  /** the game's earlier downloads on the server that are not tried, each with why */
  earlier?: { title: string; why: string }[];
}

/** the facts an ask is written from */
export interface AskFacts {
  plan?: { name: string } | null;
  game?: { name: string } | null;
  /** the way's content plan (what the file must be, and what it may be made from) */
  content?: ContentPlan | null;
  tried?: TriedFacts;
  /** the inbox folder as the server sees it */
  inbox?: string | null;
  /** a file the indexers brought that nothing proves */
  held?: { contentId: number; name: string; facts: string | null } | null;
  /** what failed and where (ai, budget, env) */
  failure?: string | null;
  phase?: string | null;
  /** AI rounds used, and the setting's value; rearms: the run tries once more by itself on the program's next release */
  rounds?: number;
  roundsSetting?: number;
  rearms?: boolean;
  /** the need a plan lacks */
  need?: NeedSlot | null;
  /** room a step needs on the library, and what is free (bytes); what: the step, in words ("Building Demon's Souls");
   *  keepFree: what the library keeps free (LIBRARY_KEEP_FREE_GB), part of need; duplicate: a second copy of the game's copy
   *  kept in the content store, which freeing gives back losslessly */
  room?: { need: number; free: number; what?: string | null; keepFree?: number; duplicate?: { contentId: number; name: string; size: number; game?: string | null } | null } | null;
  /** the go-ahead to build a way over what the game already plays: what it plays through ("its PC copy (lichii.exe)"),
   *  what a build would take the place of ("the PC copy"), and the game's copy as the way sees it (unproven: a console file
   *  in it that the plan does not prove yet) */
  replace?: { through: string; replaces: string; copy?: CopyView | null; unproven?: boolean } | null;
  /** library games to choose from */
  choices?: RunAsk["choices"];
  /** what the AI asked, when a repair round asked */
  byAi?: AskSpec | null;
  /** when the run looks again by itself (env) */
  nextAt?: number | null;
  /** the step waits for the seedbox (its folder troubled while the step read it), not for this server (env) */
  seedbox?: boolean;
  /** what kind of thing waits for the server (env) */
  what?: string | null;
  /** what the run keeps watching meanwhile (a file ask): the next search, the inbox */
  watching?: RunAsk["watching"];
  /** when the ask was first made (kept across refreshes) */
  askedAt?: number;
  now?: number;
}

const label = (p: string | null | undefined) => (p ? PLATFORM_LABEL[p as PlatformId] ?? p : "");
/** decimal, as every size ludarr says (1 GB = 10^9 bytes) */
const GB = 1e9, MB = 1e6;
/** a size in words: 54.2 GB, 312 MB, 12 KB */
export const sizeWords = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : n >= MB ? `${Math.round(n / MB)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** "A", "A or B", "A, B or C" */
export const orList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
/** "A", "A and B", "A, B and C" */
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** a time of day as the server's clock shows it: 18:40 */
export const clockWords = (unixSec: number) => { const d = new Date(unixSec * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
/** when something happens, with its day unless it is today (`now`, the facts' clock): "at 16:23", "tomorrow at 16:23",
 *  "on 10 Nov at 16:23" */
export function atClockWords(unixSec: number, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const d = new Date(unixSec * 1000), n = new Date(nowSec * 1000);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(n)) return `at ${clockWords(unixSec)}`;
  if (day(d) === day(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1))) return `tomorrow at ${clockWords(unixSec)}`;
  return `on ${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} at ${clockWords(unixSec)}`;
}
const dot = (s: string) => (/[.!?)]$/.test(s) ? s : `${s}.`);
const uniq = (xs: string[]) => [...new Set(xs)];

/* ─────────── what a content plan takes, in words ─────────── */

/** the forms the way takes its game data in, from the content plan and its make recipe only */
export function formsWords(c: ContentPlan): string {
  const product = (c.accept.formats ?? []).map(f => `.${f.replace(/^\./, "")}`);
  const input = c.make?.input ?? null;
  const marker = c.kind === "folder" ? c.marker : input?.marker;
  const also = c.kind === "folder" ? c.also ?? [] : input?.also ?? [];
  const holding = marker ? ` (holding ${andList([marker, ...also])})` : "";
  const folderIn = c.kind === "folder" || input?.shape === "folder" || input?.shape === "either";
  const archives = input && (input.shape === "file" || input.shape === "either") ? (input.formats ?? []).map(f => `.${f.replace(/^\./, "")}`) : [];
  if (folderIn) {
    const parts = [`the game folder dumped from a console${holding}`];
    if (archives.length) parts.push(`that folder in one ${orList(archives)} file`);
    if (product.length && c.kind !== "folder") parts.push(`that folder packed as one ${orList(product)}`);
    return parts.length === 3 ? `${parts[0]}, ${parts[1]}, or ${parts[2]}` : parts.join(", or ");
  }
  if (archives.length) {
    const inner = marker ? `the game folder${holding}` : "the game's data";
    const first = `one ${orList(archives)} file holding ${inner}`;
    return product.length ? `${first}, or one ${orList(product)} file` : first;
  }
  return product.length ? `one ${orList(product)} file` : "its game file";
}

/** the ids the data must carry: " — A, B or C, version X or Y, build Z" (empty when the plan lists none) */
function idWords(c: ContentPlan): string {
  const serials = uniq([...(c.accept.serials ?? []), ...(c.make?.input.serials ?? [])]);
  const versions = uniq([...(c.accept.versions ?? []), ...(c.make?.input.versions ?? [])]);
  const builds = c.accept.builds ?? [];
  const parts: string[] = [];
  if (serials.length) parts.push(orList(serials));
  if (versions.length) parts.push(`version ${orList(versions)}`);
  if (builds.length) parts.push(`build ${orList(builds)}`);
  return parts.length ? ` — ${parts.join(", ")}` : "";
}

/** can an upload bring this: one file (no folder form) whose expected size fits the upload limit */
export function canUploadFor(c: ContentPlan | null | undefined): boolean {
  if (!c) return false;
  const input = c.make?.input ?? null;
  if (c.kind === "folder" || input?.shape === "folder") return false;
  const formats = [...(c.accept.formats ?? []), ...(input?.formats ?? [])];
  // an 'either' input or a made product still comes as one file when a file form is listed
  if (input?.shape === "either" && !formats.length) return false;
  const expected = c.complete?.minBytes ?? input?.complete?.minBytes ?? askdeps.sizeRange(c.platform)?.[1] ?? null;
  return expected == null || expected <= askdeps.uploadMaxBytes();
}

/** the inbox folder as the admin's PC opens it (the share path with the inbox under it), or null */
export function inboxShare(inbox: string | null | undefined): string | null {
  const share = sharePath();
  if (!share || !inbox) return null;
  const at = inbox.replace(/\\/g, "/").split("/").indexOf(".ahoy-inbox");
  if (at < 0) return null;
  const rest = inbox.replace(/\\/g, "/").split("/").slice(at).filter(Boolean);
  const winish = /^\\\\|^[A-Za-z]:/.test(share);
  const sep = winish ? "\\" : "/";
  return `${share.replace(/[\\/]+$/, "")}${sep}${rest.join(sep)}${sep}`;
}

const folderPath = (p: string) => (/[\\/]$/.test(p) ? p : `${p}/`);

/** how to give it: the inbox, a file on the server, an upload (only when one can bring it) */
function actionWords(inbox: string | null | undefined, canUpload: boolean): string {
  const ways: string[] = [];
  if (inbox) {
    const share = inboxShare(inbox);
    ways.push(share ? `Put it in ${share} (on the server: ${folderPath(inbox)})` : `Put it in ${folderPath(inbox)}`);
  }
  ways.push(inbox ? "pick it on the server" : "Pick it on the server");
  if (canUpload) ways.push(`upload it (files up to ${Math.round(askdeps.uploadMaxBytes() / GB)} GB)`);
  const said = ways.length === 1 ? ways[0] : ways.length === 2 ? `${ways[0]}, or ${ways[1]}` : `${ways.slice(0, -1).join(", ")}, or ${ways[ways.length - 1]}`;
  const hint = inbox ? " (The folder starts with a dot, so Windows may hide it: type the path in Explorer's address bar.)" : "";
  return `${said}: ludarr takes it from there and finishes by itself.${hint}`;
}

/** one sentence per route the run tried for the game file */
function triedWords(t: TriedFacts | undefined, game: string, now?: number): string[] {
  const out: string[] = [];
  if (!t) return out;
  if (t.copy) out.push(`The copy on the server (${t.copy.name}, ${sizeWords(t.copy.size)}) is ${dot(t.copy.why)}`);
  for (const k of (t.kept ?? []).slice(0, 4)) out.push(k.same ? `${k.name}, kept on the server, is the same bytes as that copy: not used.` : `${k.name}, kept on the server, is ${dot(k.why)}`);
  for (const f of (t.failed ?? []).slice(0, 4)) out.push(`${f.what} failed: ${f.why.replace(/[.\s]+$/, "")}. It is not tried again until the plan or the game data changes.`);
  if (t.download) out.push(`A download of ${game} is already running${t.download.title ? ` (${t.download.title})` : ""}: ludarr looks at what it brings as soon as it lands.`);
  const ix = t.indexers;
  if (ix) {
    if (ix.not) out.push(`The indexers are not searched now: ${dot(ix.not)}`);
    else if (ix.searching) out.push(`The indexers are being searched for it now${ix.looked > 0 ? ` (${ix.looked} release${ix.looked === 1 ? "" : "s"} refused so far)` : ""}.`);
    else {
      const looked = ix.looked > 0 ? ` (${ix.looked} release${ix.looked === 1 ? "" : "s"} looked at${ix.reason ? `; ${ix.reason.replace(/[.\s]+$/, "")}` : ""})` : "";
      const again = ix.nextAt ? ` Looking again ${atClockWords(ix.nextAt, now)}.` : "";
      out.push(`The indexers have nothing it can use yet${looked}.${again}`);
    }
  }
  if (t.inbox) out.push(`The inbox folder cannot be used: ${dot(t.inbox)}`);
  for (const e of (t.earlier ?? []).slice(0, 3)) out.push(`An earlier download of ${game}, ${e.title}, was ${dot(e.why)}`);
  return out;
}

/** a need's accepted file in words: "a .bin file of 512 KB with sha1 …" */
export function needWords(n: NeedSlot): string {
  const formats = (n.accept?.formats ?? []).map(f => `.${f.replace(/^\./, "")}`);
  const parts = [formats.length ? `a ${orList(formats)} file` : "a file"];
  const sizes = n.accept?.sizes ?? [];
  if (sizes.length) parts.push(`of ${orList(sizes.map(s => sizeWords(s)))}`);
  const hashes = n.accept?.hashes ?? [];
  if (hashes.length) parts.push(`with ${orList(hashes.slice(0, 3).map(h => `${h.algo} ${h.value}`))}`);
  return parts.join(" ");
}

/* ─────────── the asks ─────────── */

/** the ask for `code`, in words; the facts say what is known */
export function askFor(code: AskCode, f: AskFacts): RunAsk {
  const now = f.now ?? Math.floor(Date.now() / 1000);
  const plan = f.plan?.name ?? "the plan";
  const game = f.game?.name ?? f.content?.search[0] ?? "the game";
  const c = f.content ?? null;
  const base: RunAsk = {
    code, title: "", need: "", tried: [], accept: null, inbox: f.inbox ?? null, inboxShare: inboxShare(f.inbox), canUpload: false,
    choices: f.choices ?? [], heldContentId: null, watching: code === "file" ? f.watching ?? null : null, askedAt: f.askedAt ?? now, byAi: f.byAi?.exact ?? null,
  };
  const failure = (f.failure ?? "").replace(/[.\s]+$/, "") || "it does not say why";
  switch (code) {
    case "file": {
      const canUpload = canUploadFor(c);
      const what = c ? `${plan} plays ${c.what.replace(/[.\s]+$/, "")}.` : `${plan} needs the game's data.`;
      // several forms are a list: a comma closes it before what they are of
      const forms = c ? formsWords(c) : "";
      const takes = c ? ` It takes ${forms}${forms.includes(", or ") ? "," : ""} of ${game} (${label(c.platform)})${idWords(c)}.` : "";
      const own = c?.personalDump ? ` It comes from your own console: ${c.personalDump.replace(/[.\s]+$/, "")} makes it.` : "";
      return {
        ...base, title: `${game} needs its game data`, need: `${what}${takes}${own} ${actionWords(f.inbox, canUpload)}`,
        tried: triedWords(f.tried, game, f.now), canUpload,
        accept: f.byAi?.accept ?? (c ? { platform: c.platform, shape: c.kind === "folder" ? "folder" : c.make?.input.shape === "folder" ? "folder" : c.make ? "either" : "file", formats: c.accept.formats, serials: c.accept.serials, versions: c.accept.versions, regions: c.accept.regions } : null),
      };
    }
    case "held-file": {
      const h = f.held;
      const name = h?.name ?? "A file";
      return {
        ...base, title: `Is ${name} the game?`, heldContentId: h?.contentId ?? null,
        need: `${name} came from the indexers, and nothing proves it is ${c ? c.what.replace(/[.\s]+$/, "") : game}${h?.facts ? ` (${h.facts.replace(/[.\s]+$/, "")})` : ""}. Accept it if it is.`,
      };
    }
    case "game":
      return {
        ...base, title: `Which game does ${plan} play?`,
        need: `Which game does ${plan} play? It plays ${c ? c.what.replace(/[.\s]+$/, "") : "a game nothing names yet"}.${base.choices.length ? " Pick it from the library, or add it as a new game." : " No library game is it: add it as a new game."}`,
      };
    case "choice": {
      if (f.byAi) return { ...base, title: f.byAi.title, need: `ludarr's AI needs your help with ${plan}${f.game ? ` for ${game}` : ""}: ${dot(f.byAi.exact)}` };
      const plat = c ? label(c.platform) : "its console";
      return {
        ...base, title: `Which game should ${plan} play?`,
        need: `${plan} is an emulator: it plays many games. ${base.choices.length ? `These library games of ${plat} have only a console copy so far: pick the one to make playable.` : `No library game of ${plat} has only a console copy: add the game it should play first.`}`,
      };
    }
    case "needs": {
      const n = f.need;
      const name = n?.name ?? "a system file";
      return { ...base, title: `${plan} needs ${name}`, need: `${plan} needs ${name}${n ? ` (${needWords(n)})` : ""}: add it once on the plan; every game it plays uses it.` };
    }
    case "ai":
      return {
        ...base, title: "The AI importer is not set up",
        need: `Working this out needs the AI importer, which is not set up: add its key under Settings → Importers. ludarr carries on by itself once it is there. (What stopped it: ${failure}.)`,
      };
    case "budget": {
      if ((f.roundsSetting ?? 1) <= 0) return { ...base, title: "AI repairs are switched off", need: `AI repairs are switched off (Settings → General → Import → AI repairs per game), and this needs one: ${failure}.` };
      const n = f.rounds ?? 0;
      // the promise of one more try only where the run makes it: after a build or check fault, on a program with releases
      const again = f.rearms ? " It tries once more by itself when the program has a new release." : "";
      return {
        ...base, title: `${game}: the AI stopped after ${n} ${n === 1 ? "try" : "tries"}`,
        need: `ludarr's AI tried ${n} ${n === 1 ? "time" : "times"} to make ${plan} work for ${game}; the last try failed at ${f.phase ?? "a step"}: ${failure}. It stops so it does not spend more: raise 'AI repairs per game' in Settings → General → Import, or change the plan.${again}`,
      };
    }
    case "room": {
      const r = f.room;
      const what = r?.what ?? `Making ${game}'s game data`;
      if (!r) return { ...base, title: `${game} needs more free space`, need: `${what} needs more free space on the library. ludarr tries again every hour.` };
      const gb = (n: number) => Math.max(0, Math.round(n / GB));
      const need = Math.max(1, gb(r.need)), free = Math.floor(r.free / GB);
      // what ludarr keeps free is part of the need, said with where it is set
      const keep = r.keepFree && r.keepFree > 0 ? `: what it writes, and the ${gb(r.keepFree)} GB ludarr keeps free (Settings → General → Import → Keep free on the library)` : "";
      // the kept second copy of the game's copy is the fix when there is one: freeing it loses nothing
      let fix = "";
      if (r.duplicate) {
        const short = r.need - (r.free + r.duplicate.size);
        fix = ` Freeing the second copy of ${r.duplicate.name}${r.duplicate.game ? ` (${r.duplicate.game})` : ""} kept in the game file store gives ${sizeWords(r.duplicate.size)} back; one copy stays${short > 0 ? `, and it is still about ${Math.max(1, gb(short))} GB short` : ", and that is enough"}.`;
      }
      return {
        ...base, title: `${game} needs more free space`,
        need: `${what} needs about ${need} GB free on the library${keep}; ${free} GB ${free === 1 ? "is" : "are"} free.${fix} ludarr tries again every hour.`,
      };
    }
    case "env": {
      if (f.seedbox) {
        const next = f.nextAt ? ` ludarr tries again by itself ${atClockWords(f.nextAt, f.now ?? undefined)}, and every hour after that.` : " ludarr does not try it again by itself: press Look again once the seedbox answers.";
        return { ...base, title: `${game} waits for the seedbox`, need: `${f.what ?? "A step"} waits for the seedbox: ${failure}.${next}` };
      }
      const again = f.nextAt ? ` ludarr tries again by itself ${atClockWords(f.nextAt, f.now ?? undefined)}, and every day after that.` : " ludarr tries again by itself every day.";
      return { ...base, title: `${game} waits for the server`, need: `${f.what ?? "A step"} could not run on this server: ${failure}.${again}` };
    }
    case "go-ahead": {
      const r = f.replace;
      if (r) {
        // build a way over what the game plays now: what that removes, said plainly, and where its game file comes from
        const cp = r.copy ?? null;
        const file = !cp ? ""
          : cp.serves === "direct" ? ` Its game file is on the server already (${cp.name}, ${sizeWords(cp.size)}): nothing is downloaded.`
          : cp.serves === "make" ? ` Its game file is made from ${cp.name} on the server: nothing is downloaded.`
          : r.unproven ? ` ${cp.name} (${sizeWords(cp.size)}) on the server may be its game file: ludarr takes it once ${plan} proves it is the game, before anything is downloaded.` : "";
        return {
          ...base, title: `Build ${game} with ${plan}?`,
          need: `${game} already plays through ${r.through}. Should ludarr build ${plan} for it instead? Building it replaces ${r.replaces}: its files are removed, and members install the ${plan} build in its place. Nothing changes until you say so.${file}`,
        };
      }
      return {
        ...base, title: `Make ${game} playable?`,
        need: `Should ludarr make ${game} playable through ${plan}? It adds the game to the library and looks for ${c ? c.what.replace(/[.\s]+$/, "") : "its game file"}.`,
      };
    }
  }
}
