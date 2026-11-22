/**
 * The admin UI's pages, two ways. As they render, server-side with web/'s own React: the timeline of a run (who said each
 * step, a dry run that passed, the smoke start's screenshot), how a finished job ends, a way's card, the kept files and
 * the game page's Jobs table, for the shapes the engine sends. And as the admin uses them: mounted by react-dom's client on
 * the small DOM below, every request answered by the engine's own routes, the buttons pressed and the fields typed into,
 * so what a page does with an answer is held as well as the rules behind it. The pages are imported by path while the
 * tests run, so the engine's typecheck (which has no JSX) leaves them to web/'s own. Without web/'s packages (bun install
 * in web/) the file is skipped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiKey, downloadsDir } from "../src/config";
import { db, serializeJob, stmts, upsertGame, type GameRow, type JobRow, type PackageRow } from "../src/db";
import { events } from "../src/events";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { enqueueJob } from "../src/process/kinds";
import { buildManifest } from "../src/process/validate";
import { app } from "../src/server";
import { cxdeps } from "../src/ways/construct";
import { renderReport, type TryReport } from "../src/ways/construct-tools";
import { insertContent, insertPlan, insertWay, settleWay, updateWay, wstmts } from "../src/ways/store";
import { validatePlanSpec } from "../src/ways/validate";
import { whenWords } from "../web/src/ways/logic";
import { bytes, sha1, tempConfig, tmp } from "./ways-fixtures";
import { DS_INBOX, DS_ISO, DS_SHARE, dsSecondCopy, dsWay, KYTY, runSamples } from "./web-runs";
import { peBytes } from "./pe-build";

const SRC = join(import.meta.dir, "..", "web", "src");
/** web/'s packages, as the pages resolve them: there once `bun install` has run in web/ */
const WEB = (() => { try { Bun.resolveSync("react-dom/client", SRC); return true; } catch { return false; } })();
if (!WEB) console.warn("tests/web-render.test.ts is skipped: web/'s packages are not installed (run bun install in web/)");
const describeWeb = WEB ? describe : describe.skip;

/* ─────────── a small DOM: what react-dom's client needs to mount the pages, and what a test needs to press and type ─────────── */

const HTML_NS = "http://www.w3.org/1999/xhtml";
type Heard = ((e: DomEvent) => void) | { handleEvent: (e: DomEvent) => void };

/** an event as the DOM dispatches it: captured down to its target, then bubbled back up, unless something stops it */
class DomEvent {
  target: DomNode | null = null;
  currentTarget: DomNode | null = null;
  defaultPrevented = false;
  stopped = false;
  readonly timeStamp = Date.now();
  readonly isTrusted = true;
  button = 0; buttons = 0; detail = 1; ctrlKey = false; shiftKey = false; altKey = false; metaKey = false;
  constructor(readonly type: string, readonly bubbles = true, readonly cancelable = true) {}
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; }
  getModifierState() { return false; }
}

class DomNode {
  parentNode: DomNode | null = null;
  childNodes: DomNode[] = [];
  private heard = new Map<string, { fn: Heard; capture: boolean }[]>();
  constructor(readonly ownerDocument: DomDocument | null, readonly nodeType: number, readonly nodeName: string) {}
  get firstChild(): DomNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): DomNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): DomNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  get previousSibling(): DomNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] ?? null : null; }
  appendChild<T extends DomNode>(c: T): T { return this.insertBefore(c, null); }
  insertBefore<T extends DomNode>(c: T, ref: DomNode | null): T {
    c.parentNode?.removeChild(c);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(c); else this.childNodes.splice(at, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild<T extends DomNode>(c: T): T {
    const at = this.childNodes.indexOf(c);
    if (at >= 0) this.childNodes.splice(at, 1);
    c.parentNode = null;
    return c;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(n: DomNode | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get textContent(): string { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v != null && v !== "") this.appendChild((this.ownerDocument as DomDocument).createTextNode(String(v)));
  }
  addEventListener(type: string, fn: Heard | null, o?: boolean | { capture?: boolean }) {
    if (!fn) return;
    const capture = typeof o === "boolean" ? o : !!o?.capture;
    const list = this.heard.get(type) ?? [];
    if (!list.some(l => l.fn === fn && l.capture === capture)) list.push({ fn, capture });
    this.heard.set(type, list);
  }
  removeEventListener(type: string, fn: Heard | null, o?: boolean | { capture?: boolean }) {
    const capture = typeof o === "boolean" ? o : !!o?.capture;
    this.heard.set(type, (this.heard.get(type) ?? []).filter(l => !(l.fn === fn && l.capture === capture)));
  }
  dispatchEvent(e: DomEvent): boolean {
    e.target = this;
    const path: DomNode[] = [];
    for (let n: DomNode | null = this; n; n = n.parentNode) path.push(n);
    const fire = (n: DomNode, capture: boolean) => {
      e.currentTarget = n;
      for (const l of [...(n.heard.get(e.type) ?? [])]) if (l.capture === capture) (typeof l.fn === "function" ? l.fn.call(n, e) : l.fn.handleEvent(e));
    };
    for (const n of path.slice(1).reverse()) { if (e.stopped) break; fire(n, true); }
    if (!e.stopped) { fire(this, true); fire(this, false); }
    if (e.bubbles) for (const n of path.slice(1)) { if (e.stopped) break; fire(n, false); }
    e.currentTarget = null;
    return !e.defaultPrevented;
  }
}

class DomText extends DomNode {
  constructor(doc: DomDocument, public data: string) { super(doc, 3, "#text"); }
  get nodeValue() { return this.data; }
  set nodeValue(v: string) { this.data = String(v); }
  override get textContent() { return this.data; }
  override set textContent(v: string) { this.data = String(v); }
}

function domStyle(): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  Object.defineProperties(s, {
    setProperty: { value: (k: string, v: unknown) => { s[k] = v; } },
    removeProperty: { value: (k: string) => { delete s[k]; } },
    getPropertyValue: { value: (k: string) => String(s[k] ?? "") },
  });
  return s;
}

class DomElement extends DomNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style = domStyle();
  constructor(doc: DomDocument, tag: string, readonly namespaceURI: string) {
    super(doc, 1, namespaceURI === HTML_NS ? tag.toUpperCase() : tag);
    this.tagName = this.nodeName;
  }
  getAttribute(n: string) { return this.attributes.get(n) ?? null; }
  setAttribute(n: string, v: unknown) { this.attributes.set(n, String(v)); }
  hasAttribute(n: string) { return this.attributes.has(n); }
  removeAttribute(n: string) { this.attributes.delete(n); }
  setAttributeNS(_ns: string | null, n: string, v: unknown) { this.setAttribute(n, v); }
  removeAttributeNS(_ns: string | null, n: string) { this.removeAttribute(n); }
  get className() { return this.getAttribute("class") ?? ""; }
  get type() { return this.getAttribute("type") ?? (this.nodeName === "INPUT" ? "text" : this.nodeName === "BUTTON" ? "submit" : ""); }
  set type(v: string) { this.setAttribute("type", v); }
  focus() {}
  blur() {}
  scrollIntoView() {}
}
/** an input or a textarea: its value and checked are its own, so react-dom keeps no value tracker on it and every typed
 *  value reads as a change */
class DomField extends DomElement { value = ""; defaultValue = ""; checked = false; defaultChecked = false; }
class DomSelect extends DomElement {
  multiple = false;
  size = 0;
  get options(): DomOption[] {
    const out: DomOption[] = [];
    const walk = (n: DomNode) => { for (const c of n.childNodes) { if (c instanceof DomOption) out.push(c); else walk(c); } };
    walk(this);
    return out;
  }
  get value(): string { const o = this.options; return (o.find(x => x.selected) ?? o[0])?.value ?? ""; }
  set value(v: string) { for (const o of this.options) o.picked = o.value === String(v); }
}
class DomOption extends DomElement {
  picked = false;
  defaultSelected = false;
  get value(): string { return this.getAttribute("value") ?? this.textContent; }
  set value(v: string) { this.setAttribute("value", v); }
  get selected() { return this.picked; }
  set selected(v: boolean) {
    if (v) for (let n = this.parentNode; n; n = n.parentNode) if (n instanceof DomSelect) { for (const o of n.options) o.picked = false; break; }
    this.picked = !!v;
  }
}

class DomDocument extends DomNode {
  readonly documentElement: DomElement;
  readonly head: DomElement;
  readonly body: DomElement;
  activeElement: DomElement | null = null;
  /** react-dom asks `'oninput' in document` to follow typed text by its input event */
  oninput = null;
  constructor() {
    super(null, 9, "#document");
    this.documentElement = this.appendChild(this.createElement("html"));
    this.head = this.documentElement.appendChild(this.createElement("head"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(tag: string): DomElement {
    const t = tag.toLowerCase();
    if (t === "select") return new DomSelect(this, t, HTML_NS);
    if (t === "option") return new DomOption(this, t, HTML_NS);
    if (t === "input" || t === "textarea") return new DomField(this, t, HTML_NS);
    return new DomElement(this, t, HTML_NS);
  }
  createElementNS(ns: string | null, tag: string): DomElement { return !ns || ns === HTML_NS ? this.createElement(tag) : new DomElement(this, tag, ns); }
  createTextNode(data: string) { return new DomText(this, String(data)); }
  querySelector() { return null; }
}

/** The WebSocket feed mirrors /api/v1/system/live: hello, then the engine's own events. */
class PageEvents {
  static open: PageEvents[] = [];
  private off: () => void;
  private closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    PageEvents.open.push(this);
    const send = (event: string, data: unknown) => {
      setTimeout(() => { if (!this.closed) this.onmessage?.({ data: JSON.stringify({ event, data }) }); }, 0);
    };
    this.off = events.subscribe(e => send(e.event, e.data));
    send("hello", { version: "test", at: Date.now() });
  }
  close() { if (this.closed) return; this.closed = true; this.off(); this.onclose?.(); }
}

/** window, document and the event stream for react-dom and the pages, until the file is done */
function installDom() {
  const g = globalThis as Record<string, unknown>;
  const before = { window: g.window, document: g.document, WebSocket: g.WebSocket, scrollTo: g.scrollTo };
  const doc = new DomDocument();
  g.window = {
    document: doc, HTMLIFrameElement: class {}, event: undefined, location: { protocol: "http:", host: "localhost", href: "http://localhost/" },
    // react-dom's check for passive listeners reads the option
    addEventListener: (_t: string, _l: unknown, o?: { passive?: boolean }) => { void o?.passive; }, removeEventListener: () => {},
  };
  g.document = doc;
  g.WebSocket = PageEvents;
  g.scrollTo = () => {};
  return {
    doc,
    restore() {
      for (const s of PageEvents.open) s.close();
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete g[k]; else g[k] = v; }
    },
  };
}
// react-dom reads what the DOM can do once, when it loads: the DOM comes first
const dom = WEB ? installDom() : null;
afterAll(() => dom?.restore());

/* ─────────── web/'s React, the router and the pages ─────────── */

/** a package as the pages resolve it (web/node_modules), so they and the test share one React and one router */
const pkg = (name: string): Promise<any> => import(Bun.resolveSync(name, SRC));
const page = (path: string): Promise<any> => import(join(SRC, ...path.split("/")));
const load = (f: () => Promise<any>): Promise<any> => (WEB ? f() : Promise.resolve({}));
const React = await load(() => pkg("react"));
const { renderToStaticMarkup } = await load(() => pkg("react-dom/server"));
const { StaticRouter } = await load(() => pkg("react-router-dom/server"));
const { MemoryRouter, Route, Routes, useLocation } = await load(() => pkg("react-router-dom"));
const { createRoot } = await load(() => pkg("react-dom/client"));
const { runtime } = await load(() => page("api.ts"));
const { UiProvider } = await load(() => page("ui/kit.tsx"));
const { JobHead, JobLogModal, JobResult, JobTimeline } = await load(() => page("ui/job-log.tsx"));
const { KeptFiles, WayCard } = await load(() => page("pages/game-ways.tsx"));
const { GamePage, JobsTable } = await load(() => page("pages/game.tsx"));
const { RepoTab } = await load(() => page("pages/add-repo.tsx"));
const { ManualTab } = await load(() => page("pages/add-manual.tsx"));
const { EditDetailsModal } = await load(() => page("pages/game-details.tsx"));
const { PlanDetailModal } = await load(() => page("ui/plan-view.tsx"));
const { RuntimesPage } = await load(() => page("pages/settings/plans.tsx"));
const { RunBody, RunCheck, RunModal } = await load(() => page("ui/run-view.tsx"));
const { BuildsPage } = await load(() => page("pages/builds.tsx"));
const { ReleaseTable } = await load(() => page("ui/releases.tsx"));
const { StartsWith, WayStartLine } = await load(() => page("ui/launch-editor.tsx"));
const h = (type: unknown, props: Record<string, unknown> | null = null, ...children: unknown[]) => React.createElement(type, props, ...children);

const html = (type: unknown, props: Record<string, unknown>): string => renderToStaticMarkup(h(StaticRouter, { location: "/" }, h(type, props)));
/** what a reader sees: the text without the markup and the icons */
const words = (s: string) => s.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const passed = {
  n: 1, ok: true, problems: [], warnings: ["no game file to place: only the program was tried (the admin adds the game file to the way)"], env: false,
  kind: "recomp", spec: { launch: { exe: "Zelda64Recompiled.exe", argv: [] } }, key: null, dir: "", built: null, packed: null, tools: null, toolsLookup: null,
  pinned: { tag: "v1.2.2", asset: "Zelda64Recompiled-v1.2.2-Windows.zip", url: "x", size: 30_300_000, sha256: "d02b95f1".padEnd(64, "0"), pinnedAt: 0 },
  exe: "Zelda64Recompiled.exe", files: 44, bytes: 67_200_000, placed: null, smoke: null,
  lines: ["warning: release v1.2.2 is not immutable on GitHub", "unpacking Zelda64Recompiled-v1.2.2-Windows.zip"],
} as unknown as TryReport;

describeWeb("the timeline of a run (admin-ui-5, admin-ui-6, admin-ui-16, e2e-8)", () => {
  const job = (trace: unknown[], over: Record<string, unknown> = {}) => ({
    id: 12, kind: "construct", state: "done", tier: "deterministic", trace, transcript: "line one\nline two", createdAt: 1, updatedAt: 2, doneAt: 3, progress: 1, message: "plan ready", ...over,
  });
  test("a step-0 run: its words are headed ludarr's own list, and its passing dry run reads 'The plan worked'", () => {
    const out = html(JobTimeline, { job: job([
      { turn: 0, t: 0, kind: "say", text: "Zelda64Recomp/Zelda64Recomp is on ludarr's own list (zelda64recomp): trying the plan made from it, without the AI" },
      { turn: 0, t: 3, kind: "tool", tool: "try_plan", input: { kind: "recomp", from: "ludarr's own list" }, output: renderReport(passed) },
    ]) });
    expect(words(out)).toContain("ludarr's own list Zelda64Recomp/Zelda64Recomp is on ludarr's own list");
    expect(words(out)).not.toContain("The AI importer");
    expect(words(out)).toContain("The plan worked");
    expect(out).toContain('class="tl-step tool ok"');
    // what it did is the log, not a warning
    expect(words(out)).not.toContain("release v1.2.2 is not immutable");
  });
  test("an AI run's words are the AI importer's", () => {
    const out = html(JobTimeline, { job: job([{ turn: 0, t: 0, kind: "brief", text: "the brief" }, { turn: 1, t: 2, kind: "say", text: "Reading the README." }], { tier: "agent" }) });
    expect(words(out)).toContain("The AI importer Reading the README.");
    expect(out).not.toContain("tl-step say own");
  });
  test("a dry run whose smoke start kept a screenshot shows it, loaded by the API client (never by an address with the key)", () => {
    const out = renderReport({ ...passed, smoke: { titles: ["Zelda 64: Recompiled"], screenshot: "/config/ways/shots/job-12-1.png", note: null } } as TryReport);
    const shown = html(JobTimeline, { job: job([{ turn: 1, t: 5, kind: "tool", tool: "try_plan", input: {}, output: out }], { tier: "agent" }) });
    expect(words(shown)).toContain("Loading the smoke start's screenshot");
    expect(shown).not.toMatch(/apikey/i);
    expect(words(html(JobTimeline, { job: job([{ turn: 1, t: 5, kind: "tool", tool: "try_plan", input: {}, output: renderReport(passed) }]) }))).not.toContain("screenshot");
  });
});

describeWeb("how a finished job ends (admin-ui-15)", () => {
  const misfit = { id: 3, kind: "content", state: "done", message: "kept Super Mario 64 (USA).z64 (32 KB) — not the file Zelda 64: Recompiled needs: not the version this needs", createdAt: 1, doneAt: 2, progress: 1 };
  test("a file kept that is not the one its way needs is a warning, in the server-path result and in the job's log", () => {
    expect(html(JobResult, { job: misfit })).toContain('class="test-result warn"');
    expect(html(JobHead, { job: misfit })).toContain('class="test-result warn"');
    expect(html(JobResult, { job: { ...misfit, message: "kept Majora's Mask (USA).z64 (32 MB)" } })).toContain('class="test-result ok"');
    expect(html(JobHead, { job: { ...misfit, message: "kept Majora's Mask (USA).z64 (32 MB)" } })).toContain('class="test-result ok"');
    expect(html(JobResult, { job: { ...misfit, state: "failed", message: "no such file" } })).toContain('class="test-result bad"');
  });
});

describeWeb("a way's card (admin-ui-7, admin-ui-9, admin-ui-10)", () => {
  const g = { id: 1, name: "Super Mario 64", routes: [] };
  const PLAN = { id: 2, slug: "p", name: "the plan", kind: "port", status: "ready", statusNote: null, repo: "sm64pc/sm64ex" };
  const way = (over: Record<string, unknown> = {}) => ({
    id: 5, gameId: 1, planId: 2, planName: "the plan", planKind: "port", content: null, ownContent: false, overrides: {}, contentId: null, packageId: null,
    status: "ready", statusNote: null, createdAt: 1, updatedAt: 1, plan: PLAN, file: null, fileCheck: null, fromConsoleCopy: false, needs: { met: true, missing: [] },
    blockers: [], canBuild: true, replaces: null, job: null, ...over,
  });
  const plan = (program: unknown, over: Record<string, unknown> = {}) => ({ id: 2, name: "the plan", kind: "port", repo: "r/r", spec: { program }, pinned: null, status: "ready", ...over });
  const card = (w: unknown, p: unknown = null, tick: unknown = null) =>
    html(WayCard, { w, plan: p, g, files: [], tick, findable: false, onChanged() {}, onLog() {}, onEditPlan() {}, onNoFind() {} });
  const PIN = { tag: "v2.2.0", asset: "a.7z", url: "u", size: 1, sha256: "s", pinnedAt: 1 };
  const release = { kind: "release", assetPattern: "x", channel: "stable" }, perGame = { kind: "source", ref: "nightly", steps: ["make"], artifact: "build", content: "build" };
  const planBlocked = { blockers: [{ code: "plan", error: "the plan builds from source with each game's own file: build it from source for this game first" }], canBuild: false, plan: { ...PLAN, status: "draft" } };

  test("a way with its files whose plan blocks the build reads 'Waiting for its plan'", () => {
    const blocked = words(card(way({ blockers: [{ code: "plan", error: "the plan has not been checked yet: check it first" }], canBuild: false, plan: { ...PLAN, status: "draft" } }), plan(release, { status: "draft" })));
    expect(blocked).toContain("Waiting for its plan");
    expect(blocked).not.toContain("Ready to build");
    expect(words(card(way(), plan(release)))).toContain("Ready to build");
  });
  test("a pinned release plan offers its repin before the way is built ('Build with the newest release') and after ('Update the program')", () => {
    const failed = card(way({ status: "failed", statusNote: "the pinned release file is gone from its host; check the plan and repin it" }), plan(release, { pinned: PIN }));
    expect(words(failed)).toContain("Build with the newest release");
    expect(words(card(way({ status: "built", packageId: 9 }), plan(release, { pinned: PIN })))).toContain("Update the program");
    expect(words(card(way({ status: "failed" }), plan(release)))).not.toMatch(/newest release|Update the program/);
  });
  test("the repin says how it differs from Build, which is true even when the pinned release is the newest", () => {
    const title = (w: unknown) => card(w, plan(release, { pinned: PIN })).split("<button").find(x => />(?:Build with the newest release|Update the program)<\/button>/.test(x))
      ?.match(/title="([^"]*)"/)?.[1].replace(/&#x27;/g, "'");
    expect(title(way())).toBe("Builds with the program's newest release, which becomes the pin once it builds; Build uses the pinned v2.2.0");
    expect(title(way({ status: "built", packageId: 9 }))).toBe("Builds again with the program's newest release, which becomes the pin once it builds; Rebuild uses the pinned v2.2.0");
    expect(title(way({ canBuild: false, blockers: [{ code: "plan", error: "the plan is broken: check it" }] }))).toBe("Builds with the program's newest release, which becomes the pin once it builds; Build uses the pinned v2.2.0. Not now: the plan is broken: check it");
  });
  test("a per-game plan's first build: its link while nothing runs; the build on the card, and no second link, while it is queued or running", () => {
    expect(card(way(planBlocked), plan(perGame, { status: "draft" }))).toContain(">build it from source for this game<");
    const queued = { id: 31, kind: "build", state: "queued", spec: { kind: "build", planId: 2, wayId: 5 }, progress: 0, message: null };
    const served = card(way({ ...planBlocked, job: queued }), plan(perGame, { status: "draft" }));
    expect(words(served)).toContain("Queued to build");
    expect(words(served)).toContain("Building it from source for this game");
    expect(served).not.toContain(">build it from source for this game<");
    // its first event, before the page has reloaded
    const ticked = card(way(planBlocked), plan(perGame, { status: "draft" }), { ...queued, state: "running", progress: 0.4, message: "compiling" });
    expect(words(ticked)).toContain("Building it from source for this game");
    expect(words(ticked)).toContain("40% · compiling");
    expect(ticked).not.toContain(">build it from source for this game<");
  });
});

describeWeb("the game page's tables at 1000 px (admin-ui-11), who did a job (admin-ui-6) and a file that does not fit (admin-ui-15)", () => {
  const kept = (name: string) => ({ id: 1, gameId: 1, planId: null, needIndex: null, role: "game", platform: "n64", name, size: 33_554_432,
    hashes: { sha1: "d6133ace5afaa0882cf214cf88daba39e266c078" }, rawHashes: null, normalized: null, source: "upload", createdAt: 1, onDisk: true });
  test("the kept files sit in a scrolling wrap, and a long file name breaks as the sha1 does, so the delete button stays in view", () => {
    const long = "The.Legend.of.Zelda.Majoras.Mask.USA.Rev.1.Wii.Virtual.Console.Proper.REPACK-GROUPNAME.z64";
    const out = html(KeptFiles, { files: [kept(long)], ways: [], onChanged() {} });
    expect(out).toContain('<div class="table-wrap"><table class="table compact">');
    expect(out).toContain(`<td class="mono" style="overflow-wrap:anywhere">${long}`);
    expect(out).toMatch(/style="word-break:break-all">sha1 d6133ace5afaa0882cf214cf88daba39e266c078</);
  });
  const jobs = [
    { id: 4, kind: "construct", state: "done", tier: "deterministic", message: "plan ready: Zelda 64: Recompiled · from ludarr's own list, without the AI", createdAt: 1, doneAt: 2 },
    { id: 5, kind: "construct", state: "done", tier: "agent", message: "plan ready: Goodport · written by the AI importer", createdAt: 1, doneAt: 2 },
    { id: 6, kind: "assemble", state: "done", tier: "deterministic", message: "built: 44 files, 0.07 GB", createdAt: 1, doneAt: 2 },
    { id: 7, kind: "import", state: "done", tier: "agent", message: "imported", createdAt: 1, doneAt: 2 },
    { id: 8, kind: "construct", state: "cancelled", tier: null, message: "cancelled", createdAt: 1, doneAt: 2 },
    { id: 9, kind: "content", state: "done", tier: "deterministic", message: "kept Diddy Kong Racing (USA).z64 (64 KB) — not the file Zelda 64: Recompiled needs: not the version this needs", createdAt: 1, doneAt: 2 },
    { id: 10, kind: "content", state: "done", tier: "deterministic", message: "kept Majora's Mask (USA).z64 (32 MB)", createdAt: 1, doneAt: 2 },
  ];
  const rows = () => html(JobsTable, { jobs, onLog() {} }).split("<tr>").slice(2);
  test("the Jobs table sits in a scrolling wrap, and By says the AI importer only for a run that used it, nobody for one that never ran", () => {
    expect(html(JobsTable, { jobs, onLog() {} }).startsWith('<div class="table-wrap"><table class="table jobs">')).toBe(true);
    const r = rows().map(words);
    expect(r.map(x => x.split(" ")[0])).toEqual(["4", "5", "6", "7", "8", "9", "10"]);
    expect(r[0]).toContain("done ludarr's own list plan ready");
    expect(r[1]).toContain("done AI importer plan ready");
    expect(r[2]).toContain("done — built");
    expect(r[3]).toContain("done AI importer imported");
    expect(r[4]).toContain("cancelled — cancelled");
  });
  test("a game file kept that is not the one its way needs reads as a warning in the State column, not as a green done", () => {
    const [misfit, fits] = rows().slice(5);
    expect(misfit).toContain('<span class="label warning">done · does not fit</span>');
    expect(misfit).not.toContain("label success");
    expect(fits).toContain('<span class="label success">done</span>');
  });
});

describeWeb("how a game starts: the whole start line, never the program alone", () => {
  const g = { id: 3, name: "Demon's Souls", routes: [], file: { id: 43, kind: "emulated", launch: "KytyLauncher.exe", start: "KytyLauncher.exe --play", launchRev: 5 } };
  const way = (over: Record<string, unknown> = {}) => ({ id: 1, gameId: 3, planId: 4, packageId: 43, status: "built", overrides: { launch: { exe: "KytyLauncher.exe", argv: ["--play"], at: 5 } }, ...over });
  test("the Overview row shows the program with its arguments before anything else is read", () => {
    expect(words(html(StartsWith, { g, onChanged() {} }))).toBe("KytyLauncher.exe --play");
    // a copy from before the line was sent: the program the library names
    expect(words(html(StartsWith, { g: { ...g, file: { ...g.file, start: undefined } }, onChanged() {} }))).toBe("KytyLauncher.exe");
    expect(words(html(StartsWith, { g: { ...g, file: { ...g.file, kind: "rom" } }, onChanged() {} }))).toBe("a console dump: a way to play starts it");
  });
  test("the way card of the way that built the copy: the same line, where it comes from, Change…; a start set by hand that is not in the copy says so", () => {
    expect(words(html(WayStartLine, { g, w: way(), onChanged() {} }))).toBe("Starts with KytyLauncher.exe --play set by hand Change…");
    expect(words(html(WayStartLine, { g: { ...g, file: { ...g.file, start: "kyty_emulator.exe --game {install}/game/PPSA01341-app0.zar", launchRev: null } }, w: way(), onChanged() {} })))
      .toBe("Starts with kyty_emulator.exe --game {install}/game/PPSA01341-app0.zar from the plan Change… The start set by hand (KytyLauncher.exe --play) is not applied to this copy.");
    expect(words(html(WayStartLine, { g, w: way({ overrides: {} }), onChanged() {} }))).toBe("Starts with KytyLauncher.exe --play from the plan Change…");
    // another way's card, or a way not built: nothing
    expect(html(WayStartLine, { g, w: way({ packageId: 42 }), onChanged() {} })).toBe("");
    expect(html(WayStartLine, { g, w: way({ status: "ready" }), onChanged() {} })).toBe("");
  });
});

/* ─────────── the pages as the admin uses them ─────────── */

const said = (n: DomNode | null | undefined) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
/** every element under `root` that passes */
function every(root: DomNode, ok: (e: DomElement) => boolean): DomElement[] {
  const out: DomElement[] = [];
  const walk = (n: DomNode) => { for (const c of n.childNodes) if (c instanceof DomElement) { if (ok(c)) out.push(c); walk(c); } };
  walk(root);
  return out;
}
const byClass = (root: DomNode, cls: string) => every(root, e => e.className.split(" ").includes(cls));
/** the buttons and links whose words, or label, are `name` */
const controls = (root: DomNode, name: string) => every(root, e => (e.nodeName === "BUTTON" || e.nodeName === "A") && (said(e) === name || e.getAttribute("aria-label") === name));
const field = (root: DomNode, label: string) => every(root, e => e.getAttribute("aria-label") === label)[0];
/** controls as their words (a test compares words: a node handed to expect is printed with its whole page and React's fibers) */
const named = (list: DomElement[]) => list.map(e => said(e) || e.getAttribute("aria-label") || e.nodeName);
/** the page settles in its own time (the scheduler, the engine's answers): wait for what a test expects */
async function until<T>(what: string, f: () => T, ms = 5000): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > ms) throw new Error(`gave up waiting for ${what}; the page reads: ${said(dom!.doc.body).slice(0, 1600)}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
function click(e: DomElement) {
  if (e.hasAttribute("disabled")) throw new Error(`"${said(e) || e.getAttribute("aria-label")}" is disabled`);
  e.dispatchEvent(new DomEvent("click"));
}
/** press the control once it is there and can be pressed (a page enables it in its own time) */
async function press(root: DomNode, name: string) { click(await until(`"${name}" to be pressable`, () => controls(root, name).find(e => !e.hasAttribute("disabled")))); }
function typeInto(e: DomElement, text: string) { (e as DomField).value = text; e.dispatchEvent(new DomEvent("input")); }
function choose(e: DomElement, value: string | number) { (e as DomSelect).value = String(value); e.dispatchEvent(new DomEvent("change")); }
function toggle(e: DomElement) { (e as DomField).checked = !(e as DomField).checked; e.dispatchEvent(new DomEvent("click")); }

/** a page mounted as the app mounts it (the router outside, the toasts and confirms inside), and where it navigated to */
function mount(element: unknown, at = "/") {
  const box = dom!.doc.body.appendChild(dom!.doc.createElement("div"));
  const root = createRoot(box);
  let where = at;
  function Where() { const l = useLocation(); where = l.pathname + l.search; return null; }
  root.render(h(MemoryRouter, { initialEntries: [at] }, h(UiProvider, null, element, h(Where))));
  return { box, get where() { return where; }, toasts: (tone: string) => byClass(box, "toast").filter(t => t.className.split(" ").includes(tone)).map(said), unmount() { root.unmount(); box.remove(); } };
}

/** what the pages asked the engine; `answer` stands in for the engine's half of a contract that lands with fixer E's work */
const asked: { method: string; path: string; body: any }[] = [];
let answer: ((r: { method: string; path: string; body: any }) => Response | undefined) | null = null;
async function pageFetch(url: unknown, init: RequestInit = {}): Promise<Response> {
  const path = String(url);
  if (!path.startsWith("/")) throw new Error(`a page asked ${path}: only the engine's own routes answer in these tests`);
  let body: any = init.body ?? null;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* not JSON */ } }
  const r = { method: (init.method ?? "GET").toUpperCase(), path, body };
  asked.push(r);
  return answer?.(r) ?? app.request(path, init);
}
const sent = (method: string, path: string | RegExp) => asked.filter(r => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path))).map(r => r.body);
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { "x-api-key": apiKey(), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};

describeWeb("the pages as the admin uses them, against the engine's routes", () => {
  const ROM = bytes(32 * 1024, 5);
  const content = (search: string[], hashes: { algo: "sha1"; value: string }[]) => ({ kind: "rom", platform: "n64", what: "the game, NTSC-U 1.0", search, accept: { hashes, formats: ["z64"] }, normalize: "n64-z64", place: "game.z64" });
  const recomp = (search: string[]) => validatePlanSpec({
    program: { kind: "release", assetPattern: "^Zelda64Recompiled-v.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "Zelda64Recompiled.exe", argv: [] },
    content: content(search, [{ algo: "sha1", value: sha1(ROM) }]), files: [], setup: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: null,
  }, "recomp");
  const made = { games: [] as number[], plans: [] as number[], jobs: [] as number[] };
  let seq = 0;
  const game = (name: string, platforms: string[] = ["n64"]): GameRow => {
    const g = upsertGame({ steam_appid: 9_990_700 + ++seq, name, slug: `web-render-${seq}` });
    db.query("UPDATE games SET platforms_json=? WHERE id=?").run(JSON.stringify(platforms), g.id);
    made.games.push(g.id);
    return stmts.gameById.get(g.id) as GameRow;
  };
  const plan = (name: string, kind: "recomp" | "port" | "emulator", repo: string, spec: { value?: unknown; errors: string[] }, status: "ready" | "draft" = "ready") => {
    expect(spec.errors).toEqual([]);
    const p = insertPlan({ name, kind, repo, platforms: ["n64"], spec: spec.value as never, status });
    made.plans.push(p.id);
    return p;
  };
  /** the misfit message the content job writes for the way it was taken in for (the contract's wording) */
  const MISFIT = "kept Diddy Kong Racing (USA).z64 (32 KB) — not the file Zelda 64: Recompiled (pages) needs: not the version this needs";
  let cfg: ReturnType<typeof tempConfig>;
  let mm: ReturnType<typeof insertPlan>, port: ReturnType<typeof insertPlan>, emu: ReturnType<typeof insertPlan>;
  const savedCx = { ...cxdeps }, realFetch = globalThis.fetch;
  let realKey = "";
  beforeAll(() => {
    cfg = tempConfig();
    ensureDefaultRootFolder();
    process.env.LUDARR_ALLOW_UNSANDBOXED = "1";
    cxdeps.ai = () => null; cxdeps.igdb = () => null; cxdeps.lookup = async () => [];
    realKey = runtime.apiKey;
    runtime.apiKey = apiKey();
    globalThis.fetch = pageFetch as typeof fetch;
    mm = plan("Zelda 64: Recompiled (pages)", "recomp", "Zelda64Recomp/Zelda64Recomp", recomp(["The Legend of Zelda: Majora's Mask"]));
    port = plan("Kazooie Port (pages)", "port", "someone/not-a-known-port", recomp(["Banjo-Kazooie"]));
    emu = plan("N64 emulator (pages)", "emulator", "someone/n64-emulator", validatePlanSpec({
      program: { kind: "release", assetPattern: "win64[.]zip$", channel: "stable" }, launch: { exe: "emu.exe", argv: ["{content}"] },
      content: { kind: "rom", platform: "n64", what: "a game for the console", search: ["the game's name"], accept: { hashes: [], formats: ["z64"] }, place: "games/{name}" },
      files: [], setup: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: null,
    }, "emulator"));
  });
  afterEach(() => { answer = null; asked.length = 0; });
  afterAll(() => {
    globalThis.fetch = realFetch;
    runtime.apiKey = realKey;
    Object.assign(cxdeps, savedCx);
    delete process.env.LUDARR_ALLOW_UNSANDBOXED;
    cfg.restore();
    for (const id of made.games) { db.query("DELETE FROM ways WHERE game_id=?").run(id); db.query("DELETE FROM contents WHERE game_id=?").run(id); db.query("DELETE FROM jobs WHERE game_id=?").run(id); }
    for (const id of made.jobs) db.query("DELETE FROM jobs WHERE id=?").run(id);
    for (const id of made.plans) { db.query("DELETE FROM ways WHERE plan_id=?").run(id); db.query("DELETE FROM runtime_plans WHERE id=?").run(id); }
    for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  });

  test("From a repo: a refusal names Settings → Importers only when it is about the AI importer (admin-ui-14)", async () => {
    const banjo = game("Banjo-Kazooie (pages, repo)");
    const wrong = mount(h(RepoTab), `/add/repo?repo=${encodeURIComponent("Zelda64Recomp/Zelda64Recomp")}&gameId=${banjo.id}`);
    try {
      await until("the game picked", () => said(wrong.box).includes(banjo.name));
      await press(wrong.box, "Build it");
      const refusal = await until("the refusal", () => byClass(wrong.box, "callout")[0]);
      expect(said(refusal)).toContain("does not look like that game");
      expect(named(controls(wrong.box, "Settings → Importers"))).toEqual([]);
    } finally { wrong.unmount(); }
    const unknown = mount(h(RepoTab), `/add/repo?repo=${encodeURIComponent("someone/not-a-known-port")}`);
    try {
      await press(unknown.box, "Build it");
      const refusal = await until("the refusal", () => byClass(unknown.box, "callout")[0]);
      expect(said(refusal)).toContain("AI importer");
      expect(controls(refusal, "Settings → Importers").map(a => a.getAttribute("href"))).toEqual(["/settings/importers"]);
    } finally { unknown.unmount(); }
  });

  test("Rebuild with the AI: the same rule on a way's card (admin-ui-14)", async () => {
    const banjo = game("Banjo-Kazooie (pages, rebuild)");
    insertWay({ gameId: banjo.id, planId: mm.id });
    insertWay({ gameId: banjo.id, planId: port.id });
    const v = mount(h(Routes, null, h(Route, { path: "/games/:id", element: h(GamePage) })), `/games/${banjo.id}?tab=ways`);
    try {
      const cardOf = (name: string) => byClass(v.box, "way").find(c => said(every(c, e => e.nodeName === "H4")[0]) === name);
      const rebuild = async (name: string) => {
        const c = await until(`the card of ${name}`, () => cardOf(name));
        await press(c, "Rebuild with the AI");
        const dialog = await until("the dialog", () => every(c, e => e.getAttribute("role") === "dialog")[0]);
        await press(dialog, "Start");
        return { dialog, refusal: await until("the refusal", () => byClass(dialog, "callout")[0]) };
      };
      const wrong = await rebuild(mm.name);
      expect(said(wrong.refusal)).toContain("does not look like that game");
      expect(named(controls(wrong.dialog, "Settings → Importers"))).toEqual([]);
      await press(wrong.dialog, "Cancel");
      const noAi = await rebuild(port.name);
      expect(said(noAi.refusal)).toContain("AI importer");
      expect(controls(noAi.refusal, "Settings → Importers").map(a => a.getAttribute("href"))).toEqual(["/settings/importers"]);
      expect(sent("POST", "/api/v1/plan/construct")).toEqual([{ repo: mm.repo, planId: mm.id, gameId: banjo.id }, { repo: port.repo, planId: port.id, gameId: banjo.id }]);
    } finally { v.unmount(); }
  });

  test("Add a way to play: the plans that play the game come first, and a recomp of another game is added only when the admin insists (admin-ui-13)", async () => {
    const tooie = game("Banjo-Tooie (pages)");
    const ways = `/api/v1/game/${tooie.id}/ways`;
    // the engine's refusal of a recomp for a game it does not play (POST /game/:id/ways, without force)
    answer = r => (r.method === "POST" && r.path === ways && !r.body?.force
      ? Response.json({ error: `${mm.name} plays The Legend of Zelda: Majora's Mask, and ${tooie.name} does not look like that game`, wrongGame: true }, { status: 409 }) : undefined);
    const v = mount(h(Routes, null, h(Route, { path: "/games/:id", element: h(GamePage) })), `/games/${tooie.id}?tab=ways`);
    try {
      await press(v.box, "Add a way to play");
      const dialog = await until("the dialog", () => every(v.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Add a way to play —"))[0]);
      const pick = await until("the plans", () => { const s = field(dialog, "Plan"); return s && (s as DomSelect).options.some(o => o.value === String(mm.id)) ? s : null; });
      const groupOf = (id: number) => ((pick as DomSelect).options.find(o => o.value === String(id))?.parentNode as DomElement | null)?.getAttribute("label");
      expect(groupOf(emu.id)).toBe(`For ${tooie.name}`);
      expect(groupOf(mm.id)).toBe("Other plans");
      choose(pick, mm.id);
      await press(dialog, "Add it");
      const warned = await until("the refusal", () => byClass(dialog, "warn-line")[0]);
      expect(said(warned)).toContain("does not look like that game");
      expect(wstmts.wayFor.get(tooie.id, mm.id)).toBeNull();
      await press(warned, "add it anyway");
      await until("the dialog to close", () => !every(v.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Add a way to play —")).length);
      expect(sent("POST", ways)).toEqual([{ planId: mm.id }, { planId: mm.id, force: true }]);
      expect(wstmts.wayFor.get(tooie.id, mm.id)).toMatchObject({ game_id: tooie.id, plan_id: mm.id });
      expect(v.toasts("success").join(" ")).toContain(`${tooie.name} can be played through ${mm.name} now`);
      await until("the new way's card", () => byClass(v.box, "way").some(c => said(c).includes(mm.name)));
    } finally { v.unmount(); }
  });

  test("From a repo, the game it proposes: added to the library, and its way only when the admin insists (admin-ui-13)", async () => {
    const draft = { name: "Majora's Mask (pages proposal)", platforms: ["n64"], year: 2000, summary: "Link has three days to save Termina from the falling moon." };
    const j = enqueueJob({ kind: "construct", repo: "Zelda64Recomp/Zelda64Recomp" });
    made.jobs.push(j.id);
    stmts.setJobDone.run(`plan ready: ${mm.name}`, null, JSON.stringify({ planId: mm.id, game: draft }), j.id);
    db.query("UPDATE jobs SET tier='deterministic' WHERE id=?").run(j.id);
    const ways = /^\/api\/v1\/game\/\d+\/ways$/;
    answer = r => (r.method === "POST" && ways.test(r.path) && !r.body?.force
      ? Response.json({ error: `${mm.name} plays The Legend of Zelda: Majora's Mask, and ${draft.name} does not look like that game`, wrongGame: true }, { status: 409 }) : undefined);
    const v = mount(h(RepoTab), `/add/repo?job=${j.id}`);
    try {
      await until("the proposed game", () => (field(v.box, "Name") as DomField | undefined)?.value === draft.name);
      // not searched for once added: the search is not what this is about
      toggle(await until("monitored", () => every(v.box, e => e.nodeName === "INPUT" && e.type === "checkbox")[0]));
      // the form's own button (the tab above it has the same words)
      await press(await until("the form's buttons", () => byClass(v.box, "form-actions")[0]), "Add this game");
      const warned = await until("the refusal", () => byClass(v.box, "callout").find(c => said(c).includes("does not look like that game")));
      expect(said(warned)).toContain(`${draft.name} is in the library without this way to play`);
      const added = db.query("SELECT * FROM games WHERE name=?").get(draft.name) as GameRow;
      made.games.push(added.id);
      expect(wstmts.wayFor.get(added.id, mm.id)).toBeNull();
      await press(warned, "add it anyway");
      await until("the game's page", () => v.where === `/games/${added.id}?tab=ways`);
      expect(sent("POST", ways)).toEqual([{ planId: mm.id }, { planId: mm.id, force: true }]);
      expect(wstmts.wayFor.get(added.id, mm.id)).toMatchObject({ game_id: added.id, plan_id: mm.id });
      expect(v.toasts("success").join(" ")).toContain(`${draft.name} plays through ${mm.name} now`);
    } finally { v.unmount(); }
  });

  test("Use a file on the server: a file that does not fit the way is kept, and the card says so as a warning (admin-ui-15)", async () => {
    const majora = game("Majora (pages)");
    insertWay({ gameId: majora.id, planId: mm.id });
    const path = join(downloadsDir(), "Diddy Kong Racing (USA).z64");
    writeFileSync(path, bytes(32 * 1024, 9));
    const v = mount(h(Routes, null, h(Route, { path: "/games/:id", element: h(GamePage) })), `/games/${majora.id}?tab=ways`);
    try {
      const card = await until("the way's card", () => byClass(v.box, "way").find(c => said(c).includes(mm.name)));
      await press(card, "Use a file on the server");
      const dialog = await until("the dialog", () => every(card, e => e.getAttribute("role") === "dialog")[0]);
      typeInto(await until("the path field", () => field(dialog, "Path on the server")), path);
      await press(dialog, "Take it in");
      await until("the copy to be queued", () => said(dialog).includes("Queued"));
      // the runner ends the job with the contract's message (it says the file is not this way's), then says so
      const job = db.query("SELECT * FROM jobs WHERE kind='content' AND game_id=? ORDER BY id DESC").get(majora.id) as JobRow;
      expect(JSON.parse(job.spec_json!)).toMatchObject({ kind: "content", wayId: expect.any(Number) });
      stmts.setJobDone.run(MISFIT, null, null, job.id);
      events.emit("job", serializeJob(stmts.jobById.get(job.id) as JobRow));
      const line = await until("the card's warning", () => byClass(card, "err-line")[0]);
      expect(said(line)).toBe(MISFIT.charAt(0).toUpperCase() + MISFIT.slice(1));
      expect(byClass(dialog, "test-result").map(e => e.className)).toEqual(["test-result warn"]);
      await until("the toast", () => v.toasts("warning").length);
      expect(v.toasts("warning").join(" ")).toContain("not the file Zelda 64: Recompiled (pages) needs");
      expect(v.toasts("success")).toEqual([]);
    } finally { v.unmount(); }
  });

  test("Draft with AI in Add → Manual names the library game it found, and Test the search says it asks with the platforms (admin-ui-12, admin-ui-4)", async () => {
    const celeste = game("Celeste (pages)", ["pc"]);
    cxdeps.lookup = async (name: string) => (name === celeste.name ? [{ id: { scheme: "steam", value: "504230" }, name: celeste.name, year: 2018, releaseIso: null, platforms: ["pc"], cover: null, summary: null, source: "library", gameId: celeste.id, status: null }] as never : []);
    const v = mount(h(ManualTab), `/add/manual?name=${encodeURIComponent(celeste.name)}`);
    try {
      expect(await until("the search's help", () => byClass(v.box, "dim").map(said).find(t => t.startsWith("Asks the indexers")))).toContain("every search term and the platforms");
      await press(v.box, "Draft with AI");
      const note = await until("the draft's note", () => byClass(v.box, "draft-note").find(n => said(n).includes("library")));
      expect(said(note)).toContain("Already in your library: open it.");
      expect(controls(note, "open it").map(a => a.getAttribute("href"))).toEqual([`/games/${celeste.id}`]);
    } finally { v.unmount(); cxdeps.lookup = async () => []; }
  });

  test("Draft with AI in Edit Details never sends the admin to the game being edited (admin-ui-12)", async () => {
    const added = await call("POST", "/api/v1/game", { source: "manual", monitored: false, searchNow: false, game: { name: "Homebrew Quest (pages)", platforms: ["pc"] } });
    expect(added.status).toBe(201);
    made.games.push(added.json.item.id);
    const g = (await call("GET", `/api/v1/game/${added.json.item.id}`)).json.item;
    cxdeps.lookup = async (name: string) => (name === g.name ? [{ id: { scheme: "steam", value: "1" }, name: g.name, year: null, releaseIso: null, platforms: ["pc"], cover: null, summary: "A quest made at home.", source: "library", gameId: g.id, status: null }] as never : []);
    // the draft route finds the game itself in the library
    expect((await call("POST", "/api/v1/game/draft", { name: g.name })).json.inLibrary).toBe(g.id);
    const v = mount(h(EditDetailsModal, { g, open: true, onClose() {}, onSaved() {} }));
    try {
      await press(v.box, "Draft with AI");
      const note = await until("the draft's note", () => byClass(v.box, "draft-note")[0]);
      expect(said(note)).toContain("from your library");
      expect(said(note)).not.toContain("Already in your library");
      expect(sent("POST", "/api/v1/game/draft")).toEqual([{ name: g.name }]);
    } finally { v.unmount(); cxdeps.lookup = async () => []; }
  });

  describe("a plan's own actions and its ways (admin-ui-8, admin-ui-9)", () => {
    const tools = { ref: "{tag}", steps: ["make -C tools"], outputs: ["tools/extract"] };
    const soh = () => plan("Ship of Harkinian (pages)", "port", "HarbourMasters/Shipwright", validatePlanSpec({
      program: { kind: "release", assetPattern: "^SoH-.*-Win64[.]zip$", channel: "stable" }, launch: { exe: "soh.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "Ocarina of Time, NTSC 1.0", search: ["The Legend of Zelda: Ocarina of Time"], accept: { hashes: [{ algo: "sha1", value: "a".repeat(40) }], formats: ["z64"] }, normalize: "n64-z64", place: "oot.z64", ship: false },
      tools, setup: [{ run: { tool: "tools/extract", argv: ["{content}", "{stage}/oot.o2r"], wine: false, timeoutSec: 600 } }],
      files: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: null,
    }, "port"));

    test("Settings → Runtimes offers 'Build its tools' for a release plan with tools, and nothing to build for one without", async () => {
      const p = soh();
      const v = mount(h(RuntimesPage), "/settings/runtimes");
      try {
        const rowOf = (name: string) => every(v.box, e => e.nodeName === "TR" && said(e).startsWith(name))[0];
        const row = await until("the plan's row", () => rowOf(p.name));
        expect(named(controls(row, "Build its tools"))).toEqual(["Build its tools"]);
        const plain = await until("another plan's row", () => rowOf(mm.name));
        expect(named([...controls(plain, "Build its tools"), ...controls(plain, "Build from source")])).toEqual([]);
      } finally { v.unmount(); }
    });

    test("the plan's dialog builds a release plan's tools through POST /plan/:id/build", async () => {
      const p = soh();
      const v = mount(h(PlanDetailModal, { id: p.id, onClose() {}, onChanged() {} }));
      try {
        await press(v.box, "Build its tools");
        await until("the toast", () => v.toasts("success").length);
        expect(v.toasts("success").join(" ")).toContain(`Building the tools of ${p.name}`);
        expect(sent("POST", `/api/v1/plan/${p.id}/build`)).toEqual([null]);
      } finally {
        v.unmount();
        for (const j of db.query("SELECT id FROM jobs WHERE kind='build' AND input_path=? AND state='queued'").all(`plan:${p.id}`) as { id: number }[]) { await call("POST", `/api/v1/jobs/${j.id}/cancel`); made.jobs.push(j.id); }
      }
    });

    test("the plan's dialog reads a way that has its file as waiting while the plan is a draft", async () => {
      const draftPlan = plan("Zelda 64 by hand (pages)", "recomp", "Zelda64Recomp/Zelda64Recomp", recomp(["The Legend of Zelda: Majora's Mask"]), "draft");
      const g = game("Majora by hand (pages)");
      const dir = tmp("web-render-rom-"), file = join(dir, "mm.z64");
      writeFileSync(file, ROM);
      const kept = insertContent({ gameId: g.id, platform: "n64", name: "mm.z64", path: file, size: ROM.byteLength, hashes: { sha1: sha1(ROM) }, source: "upload" });
      const w = insertWay({ gameId: g.id, planId: draftPlan.id });
      updateWay(w.id, { contentId: kept.id });
      expect(settleWay(w.id)?.status).toBe("ready");
      const v = mount(h(PlanDetailModal, { id: draftPlan.id, onClose() {}, onChanged() {} }));
      try {
        const row = await until("the way's row", () => every(v.box, e => e.nodeName === "TR" && said(e).startsWith(g.name))[0]);
        expect(said(row)).toContain("Waiting for its plan");
        expect(said(row)).not.toContain("Ready to build");
      } finally { v.unmount(); }
    });
  });

  test("Starts with: the whole line and where it comes from; Change… lists the copy's programs with the package's own words and its scripts greyed, the preview says what runs, Save sets it, Reset gives the start found back", async () => {
    const g = game("Demon's Souls (pages)", ["ps5"]);
    const dir = join(process.env.AHOY_LIBRARY!, `pages-launch-${g.id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kyty_emulator.exe"), peBytes({ ui: "console", version: { FileDescription: "KytyPS5 PS5 emulator" } }));
    writeFileSync(join(dir, "KytyLauncher.exe"), peBytes({ ui: "window", version: { FileDescription: "KytyPS5 launcher" } }));
    writeFileSync(join(dir, "README.md"), "`KytyLauncher.exe --play` starts the game right away with the launcher's settings, without its window.\n");
    writeFileSync(join(dir, "run.cmd"), "@echo off\r\nrem Starts the game with the default settings.\r\n\"%~dp0kyty_emulator.exe\" --game x\r\n");
    writeFileSync(join(dir, "game.bin"), bytes(4096, 1));
    const m = await buildManifest({ ok: true, root: dir, problems: [], exeCandidates: [], launch: "kyty_emulator.exe", prerequisites: [], totalSize: 0, fileCount: 0 },
      { name: g.name, slug: g.slug!, version: null, source: null, tier: "deterministic", kind: "native", argv: ["--game", "{install}/game.bin"], launchArgs: "" });
    const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, m.totalSize, JSON.stringify(m)) as PackageRow;
    const v = mount(h(Routes, null, h(Route, { path: "/games/:id", element: h(GamePage) })), `/games/${g.id}`);
    const row = () => byClass(v.box, "launch-row")[0];
    try {
      // the Overview row: the program and every argument, and where the start comes from
      await until("the start's row and where it comes from", () => row() && said(row()).includes("found by ludarr"));
      expect(said(row())).toContain("kyty_emulator.exe --game {install}/game.bin");
      expect(named(controls(row(), "Reset"))).toEqual([]);
      await press(row(), "Change…");
      const modal = await until("the editor", () => byClass(v.box, "modal").find(x => said(x).startsWith(`How ${g.name} starts`)));
      await until("the copy's programs", () => said(modal).includes("KytyPS5 launcher"));
      // nothing to save before anything is changed
      expect(controls(modal, "Save")[0].hasAttribute("disabled")).toBe(true);
      // what the package says, quoted with its source; a script listed with its words and what it runs, never pickable
      expect(said(modal)).toContain("README.md: “KytyLauncher.exe --play starts the game right away with the launcher's settings, without its window.”");
      expect(said(modal)).toContain("Scripts: pick the program a script starts. A .bat or .cmd can itself be the start when the game needs its script: it then runs on each player's PC as it is written.");
      // its first comment, and the program it starts offered in its place (it is one of the copy's)
      expect(said(modal)).toContain("run.cmdpick kyty_emulator.exe“Starts the game with the default settings.”");
      expect(said(modal)).toContain("it runs: kyty_emulator.exe --game x");
      expect(every(modal, e => e.nodeName === "BUTTON" && said(e).startsWith("run.cmd"))).toEqual([]);
      // the launcher, with --play in place of the arguments it had
      click(every(modal, e => e.nodeName === "BUTTON" && e.className.split(" ").includes("launch-item") && said(e).startsWith("KytyLauncher.exe"))[0]);
      await press(modal, "Remove argument 1");
      await press(modal, "Remove argument 1");
      await press(modal, "Add an argument");
      typeInto(await until("the new argument", () => field(modal, "Argument 1")), "--play");
      await until("the preview", () => said(modal).includes(`"C:\\Games\\Ahoy\\${g.slug}\\KytyLauncher.exe" --play`));
      expect(said(modal)).toContain(`in C:\\Games\\Ahoy\\${g.slug}`);
      await press(modal, "Save");
      await until("the toast", () => v.toasts("success").length);
      expect(v.toasts("success").join(" ")).toContain(`${g.name} starts with KytyLauncher.exe --play now.`);
      expect(sent("PUT", `/api/v1/game/${g.id}/launch`)).toEqual([{ exe: "KytyLauncher.exe", argv: ["--play"] }]);
      await until("set by hand", () => said(row()).includes("set by hand"));
      expect(said(row())).toContain("KytyLauncher.exe --play");
      // what installed copies do with it, as it is: Ahoy 0.11 takes it at the next start, an older Ahoy offers an update
      expect(said(row())).toContain("Copies already installed take it at their next start with Ahoy 0.11 or newer; older Ahoy offers them an update.");
      expect(JSON.parse((stmts.packageForGame.get(g.id) as PackageRow).manifest_json).launch).toMatchObject({ exe: "KytyLauncher.exe", argv: ["--play"] });
      // Reset, once the admin says yes: the start found comes back
      await press(row(), "Reset");
      const yes = await until("the question", () => controls(v.box, "Reset").find(e => e.className.split(" ").includes("btn")));
      expect(said(v.box)).toContain("It starts with kyty_emulator.exe --game {install}/game.bin again, as ludarr found it.");
      click(yes);
      await until("found again", () => said(row()).includes("found by ludarr") && !said(row()).includes("set by hand"));
      expect(said(row())).toContain("kyty_emulator.exe --game {install}/game.bin");
      expect(sent("DELETE", `/api/v1/game/${g.id}/launch`)).toEqual([null]);
    } finally {
      v.unmount();
      db.query("DELETE FROM packages WHERE id=?").run(pkg.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** a game's PC copy of KytyPS5 as an import leaves it: the emulator, its launcher, a README when given */
  const startCopy = async (name: string, o: { readme?: string } = {}) => {
    const g = game(name, ["ps5"]);
    const dir = join(process.env.AHOY_LIBRARY!, `pages-start-${g.id}`);
    mkdirSync(dir, { recursive: true });
    if (o.readme) writeFileSync(join(dir, "README.md"), o.readme);
    writeFileSync(join(dir, "kyty_emulator.exe"), peBytes({ ui: "console", version: { FileDescription: "KytyPS5 PS5 emulator" } }));
    writeFileSync(join(dir, "KytyLauncher.exe"), peBytes({ ui: "window", version: { FileDescription: "KytyPS5 launcher" } }));
    writeFileSync(join(dir, "game.bin"), bytes(4096, 1));
    const m = await buildManifest({ ok: true, root: dir, problems: [], exeCandidates: [], launch: "kyty_emulator.exe", prerequisites: [], totalSize: 0, fileCount: 0 },
      { name: g.name, slug: g.slug!, version: null, source: null, tier: "deterministic", kind: "native" });
    const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, m.totalSize, JSON.stringify(m)) as PackageRow;
    return { g, dir, pkg, done() { db.query("DELETE FROM packages WHERE id=?").run(pkg.id); rmSync(dir, { recursive: true, force: true }); } };
  };
  const startPage = (g: GameRow) => {
    const v = mount(h(Routes, null, h(Route, { path: "/games/:id", element: h(GamePage) })), `/games/${g.id}`);
    return { v, row: () => byClass(v.box, "launch-row")[0] };
  };
  const openStartEditor = async (g: GameRow) => {
    const { v, row } = startPage(g);
    await until("the row", () => row() && said(row()).includes("found by ludarr"));
    await press(row(), "Change…");
    const modal = await until("the editor", () => byClass(v.box, "modal").find(x => said(x).startsWith(`How ${g.name} starts`)));
    await until("the programs", () => said(modal).includes("KytyPS5 launcher"));
    return { v, modal, row };
  };

  test("the start editor says what each thing is, never how the editor works", async () => {
    const c = await startCopy("Start Editor Words (pages)");
    const { v, modal } = await openStartEditor(c.g);
    try {
      expect(said(modal)).not.toContain("the one it starts now first");
      expect(said(modal)).not.toContain("Paste a whole command line");
      expect(said(modal)).not.toContain("unless another is picked");
      expect(said(modal)).toContain("One per row.");
    } finally { v.unmount(); c.done(); }
  });

  test("the start editor: a .bat can be picked: said as a script, with what it does and its text to read, and the Ahoy it needs", async () => {
    const c = await startCopy("Start Script (pages)");
    // the game's own start script is one of the copy's files: it asks for administrator rights and loads a driver first
    const BAT = ["@echo off", 'cd /d "%~dp0"', "net session >nul 2>&1", "if %errorlevel% neq 0 (", "  powershell -Command \"Start-Process -FilePath '%~f0' -Verb RunAs\"", "  exit /b", ")",
      'sc.exe create game-guard type= kernel binPath="%CD%\\Guard.sys"', "start /wait kyty_emulator.exe key123", ""].join("\r\n");
    writeFileSync(join(c.dir, "!start.bat"), BAT);
    const m = await buildManifest({ ok: true, root: c.dir, problems: [], exeCandidates: [], launch: "kyty_emulator.exe", prerequisites: [], totalSize: 0, fileCount: 0 },
      { name: c.g.name, slug: c.g.slug!, version: null, source: null, tier: "deterministic", kind: "native" });
    db.query("UPDATE packages SET manifest_json=? WHERE id=?").run(JSON.stringify(m), c.pkg.id);
    const { v, modal, row } = await openStartEditor(c.g);
    try {
      // listed with what it does on a player's PC, each with the line that does it, before anything is picked
      expect(said(modal)).toContain("Scripts: pick the program a script starts. A .bat or .cmd can itself be the start when the game needs its script");
      expect(said(modal)).toContain("it asks for administrator rights on the player's PC (Windows asks the player each time): powershell -Command");
      expect(said(modal)).toContain("it installs or starts a Windows service or driver: sc.exe create game-guard type= kernel");
      // its text, to read before it is picked
      await press(modal, "read the script");
      await until("the script's text", () => said(modal).includes("start /wait kyty_emulator.exe key123"));
      await press(modal, "start the game with this script");
      // the server's words for what picking a script means, the preview, and what Ahoy it needs
      await until("what picking a script means", () => said(modal).includes("!start.bat is a script: on each player's PC it runs through the Windows command shell and does whatever it says there"));
      expect(said(modal)).toContain(`"C:\\Games\\Ahoy\\${c.g.slug}\\!start.bat"`);
      expect(said(modal)).toContain("through the Windows command shell · needs Ahoy 0.11 or newer");
      expect(said(modal)).toContain("the script's folder");
      await press(modal, "Save");
      await until("the toast", () => v.toasts("success").length);
      await until("set by hand", () => said(row()).includes("set by hand"));
      expect(said(row())).toContain("!start.bat");
      expect(said(row())).toContain("A script: it runs through the Windows command shell on each player's PC, as it is written.");
      expect(JSON.parse((stmts.packageForGame.get(c.g.id) as PackageRow).manifest_json)).toMatchObject({ launch: { exe: "!start.bat", argv: [] }, requires: { launcher: "0.11.0" } });
    } finally { v.unmount(); c.done(); }
  });

  test("the start editor: a refused Save's words stay only while the start is the one refused — answered before the fix, or after it", async () => {
    const c = await startCopy("Start Refused Then Fixed (pages)");
    const { v, modal } = await openStartEditor(c.g);
    const putUrl = `/api/v1/game/${c.g.id}/launch`, checkUrl = `${putUrl}/check`;
    const REFUSED = "argument 1: {foo} is not a placeholder here ({install})";
    // the check as the admin types finds nothing here: any refusal on the screen is Save's own; Save is the engine's
    let gate: Promise<void> | null = null, answered: Promise<Response> | null = null;
    answer = r => {
      if (r.method === "POST" && r.path === checkUrl) return Response.json({ errors: [], warnings: [], line: null, needsAhoy: null });
      if (r.method !== "PUT" || r.path !== putUrl) return undefined;
      answered = (gate ?? Promise.resolve()).then(() => app.request(putUrl, { method: "PUT", headers: { "x-api-key": apiKey(), "content-type": "application/json" }, body: JSON.stringify(r.body) }));
      return answered as unknown as Response;
    };
    try {
      await press(modal, "Add an argument");
      // answered before the fix: said, then gone once the start is changed
      typeInto(await until("argument 1", () => field(modal, "Argument 1")), "--x={foo}");
      await press(modal, "Save");
      await until("Save's refusal", () => said(modal).includes(REFUSED));
      typeInto(field(modal, "Argument 1"), "--play");
      await until("the refusal gone", () => !said(modal).includes(REFUSED));
      // answered after the fix (a slow Save): never said over the start as it is now
      typeInto(field(modal, "Argument 1"), "--x={foo}");
      let release!: () => void;
      gate = new Promise<void>(r => { release = r; });
      await press(modal, "Save");
      await until("the Save asked", () => sent("PUT", putUrl).length === 2);
      typeInto(field(modal, "Argument 1"), "--play");
      release();
      expect((await answered!).status).toBe(400);
      await new Promise(r => setTimeout(r, 100));
      expect(said(modal)).not.toContain(REFUSED);
      expect(byClass(modal, "launch-problems")).toEqual([]);
      // and back to the start refused: its refusal is said again
      typeInto(field(modal, "Argument 1"), "--x={foo}");
      await until("the refusal of that start again", () => said(modal).includes(REFUSED));
    } finally { v.unmount(); c.done(); }
  });

  test("the start editor: with an empty row above, the words name the row the problem is in", async () => {
    const c = await startCopy("Start Rows Numbered (pages)");
    const { v, modal } = await openStartEditor(c.g);
    try {
      await press(modal, "Add an argument");
      await press(modal, "Add an argument");
      typeInto(await until("argument 2", () => field(modal, "Argument 2")), "--x={foo}");
      await until("the words for row 2", () => said(modal).includes("argument 2: {foo} is not a placeholder here ({install})"));
      expect((field(modal, "Argument 1") as DomField).value).toBe("");
    } finally { v.unmount(); c.done(); }
  });

  test("the line under the start: what the package says of the program itself (its version info before a sentence that only mentions it)", async () => {
    const c = await startCopy("Start Said (pages)", { readme: "For FSR, put amd_fidelityfx_upscaler_vk.dll next to kyty_emulator.exe (only DLLs signed by AMD are loaded).\n\nDo not double-click kyty_emulator.exe directly: it would lack its launch options.\n" });
    const { v, row } = startPage(c.g);
    try {
      await until("the line under the start", () => row() && byClass(row(), "launch-said").length > 0);
      expect(said(byClass(row(), "launch-said")[0])).toBe("version info: “KytyPS5 PS5 emulator”");
    } finally { v.unmount(); c.done(); }
  });

  test("a way's copy whose way was removed: the row says it starts as set by hand, what gives control back, and offers Reset, which gives the plan's start back", async () => {
    const g = game("Start Way Removed (pages)");
    const dir = join(process.env.AHOY_LIBRARY!, `pages-start-way-${g.id}`);
    mkdirSync(join(dir, "games"), { recursive: true });
    writeFileSync(join(dir, "emu.exe"), peBytes({ ui: "window", version: { FileDescription: "The emulator" } }));
    writeFileSync(join(dir, "Launcher.exe"), peBytes({ ui: "window", version: { FileDescription: "Its launcher" } }));
    writeFileSync(join(dir, "games", "game.z64"), bytes(4096, 2));
    const m = await buildManifest({ ok: true, root: dir, problems: [], exeCandidates: [], launch: "emu.exe", prerequisites: [], totalSize: 0, fileCount: 0 },
      { name: g.name, slug: g.slug!, version: null, source: { title: g.name, group: null, protocol: "way", indexer: null }, tier: "deterministic", kind: "emulated", platform: "n64", launchArgs: "", argv: ["{install}/games/game.z64"], requires: { launcher: "0.10.0" }, keep: ["saves/**"], seed: ["saves/**"] });
    const pkg = stmts.insertPackage.get(g.id, null, dir, g.name, null, m.totalSize, JSON.stringify(m)) as PackageRow;
    const way = insertWay({ gameId: g.id, planId: emu.id, status: "built" });
    wstmts.setWayBuilt.run(pkg.id, way.id);
    expect((await call("PUT", `/api/v1/game/${g.id}/launch`, { exe: "Launcher.exe", argv: ["--play"] })).status).toBe(200);
    expect((await call("DELETE", `/api/v1/way/${way.id}`)).status).toBe(200);
    const { v, row } = startPage(g);
    try {
      await until("the row", () => row() && said(row()).includes("set by hand"));
      expect(said(row())).toContain("Launcher.exe --play");
      expect(said(row())).toContain("the way to play that built this copy is gone: build a way to play again, or import a new copy, to change how the game starts");
      expect(named(controls(row(), "Change…"))).toEqual([]);
      await press(row(), "Reset");
      const yes = await until("the question", () => controls(v.box, "Reset").find(e => e.className.split(" ").includes("btn")));
      expect(said(v.box)).toContain("It starts with emu.exe {install}/games/game.z64 again, as the plan says.");
      click(yes);
      await until("the plan's start again", () => said(row()).includes("from the plan") && !said(row()).includes("set by hand"));
      expect(said(row())).toContain("emu.exe {install}/games/game.z64");
      expect(JSON.parse((stmts.packageForGame.get(g.id) as PackageRow).manifest_json).launch).toMatchObject({ exe: "emu.exe", argv: ["{install}/games/game.z64"] });
    } finally { v.unmount(); db.query("DELETE FROM packages WHERE id=?").run(pkg.id); rmSync(dir, { recursive: true, force: true }); }
  });

  test("a job's log reads the job once more after it ends, for the lines written just after (admin-ui-1)", async () => {
    const g = game("Log reader (pages)");
    const j = stmts.insertJobOf.get(null, null, g.id, "way:0", "assemble", JSON.stringify({ kind: "assemble", wayId: 0 }), null) as JobRow;
    stmts.setJob.run("running", "deterministic", 0.5, "packing the files", j.id);
    db.query("UPDATE jobs SET transcript=? WHERE id=?").run("unpacking the release", j.id);
    const v = mount(h(JobLogModal, { id: j.id, onClose() {} }));
    try {
      await until("the running job", () => said(v.box).includes("50% · packing the files"));
      // the job ends; its last lines (the scratch folder cleared, the hand-off) are written after that. No event: the page's
      // own reading every two seconds finds it ended, and nothing but the read after the end can bring those lines
      stmts.setJobDone.run("built: 3 files", null, null, j.id);
      await until("the end", () => byClass(v.box, "test-result").some(e => said(e) === "built: 3 files"), 4000);
      expect(said(v.box)).not.toContain("the scratch folder is cleared");
      db.query("UPDATE jobs SET transcript=transcript || ? WHERE id=?").run("\nthe scratch folder is cleared", j.id);
      await until("the last line", () => said(v.box).includes("the scratch folder is cleared"), 4000);
    } finally { v.unmount(); }
  });
});

/* ─────────── a carry run: its page in each state, and the way card that carries it (DESIGN3 B4 item 4) ─────────── */

const RUN_NOW = Date.now() / 1000;
const R = runSamples(RUN_NOW);
const body = (view: unknown, tick: unknown = null) => html(RunBody, { view, tick, onChanged() {}, onLog() {} });
/** the controls a page shows, by their words (or labels) */
const buttons = (markup: string) => [...markup.matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/g)].map(m => words(m[1])).filter(Boolean);

describeWeb("a carry run's page, state by state", () => {
  test("Demon's Souls asks for its game folder: the sealed copy's words, the share path once with a copy button, the server's path in small type, no upload", () => {
    const out = body(R.ds), said = words(out);
    expect(said).toContain("Demon's Souls needs its game data");
    expect(said).toContain(`${KYTY} plays Demon's Souls at 1.05 or 1.07. It takes the game folder dumped from a console (holding sce_sys/param.json and eboot.bin), or that folder packed as one .zar`);
    expect(said).toContain("What it tried The copy on the server (bbb-ps5-01342.iso, 54.2 GB) is the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it.");
    expect(said).toContain("Put it in this folder or pick it on the server: ludarr takes it from there and finishes by itself.");
    // the folder, as the admin's PC opens it, said once (the need's own sentence naming it is the card's line)
    expect(said.split(DS_SHARE).length - 1).toBe(1);
    expect(out).toContain(`<code class="inbox-path">${DS_SHARE.replace(/&/g, "&amp;")}</code>`);
    expect(said).toContain(`On the server: ${DS_INBOX} · The folder starts with a dot, so Windows may hide it: type the path in Explorer's address bar.`);
    expect(buttons(out)).toEqual(expect.arrayContaining(["Copy", "Pick it on the server", "Look again now"]));
    expect(buttons(out)).not.toContain("Upload it");
    expect(said).toContain(`Still watching: next search ${whenWords(R.ds.ask!.watching!.nextSearchAt!, RUN_NOW)} · the inbox every 2 minutes`);
    // the rail, and the steps with who took each and its proof; the AI's round opens what it changed and what it did
    expect(out).toContain('title="Game file: asks you — needs the game folder dumped from a console"');
    expect(said).toContain("the AI Round 1 of 3 (upgrade): the game file is now made from the game folder with ZArchive");
    expect(said).toContain("chenxiao07/KytyPS5@65ed19d9 src/graphics/host_gpu/renderer/demonsSouls.h:13-26");
    expect(buttons(out)).toEqual(expect.arrayContaining(["What the AI changed", "What the AI did", "The search (request 9)"]));
  });
  test("a make at 41 %: what it does now, the job's own ticks with bytes of total as they come, its log and Cancel", () => {
    expect(words(body(R.dsMake))).toContain("Making the game file from the game folder that landed in the inbox 41%");
    const ticked = words(body(R.dsMake, { id: 70, state: "running", progress: 0.43, message: "packing the game folder · 23.3 of 54.2 GB" }));
    // the bar holds the percentage, the job's live words have a line of their own (a long one wraps on a phone)
    expect(ticked).toContain("Making the game file from the game folder that landed in the inbox 43% packing the game folder · 23.3 of 54.2 GB");
    expect(body(R.dsMake, { id: 70, state: "running", progress: 0.43, message: "packing the game folder · 23.3 of 54.2 GB" })).toContain('<div class="run-now-detail">packing the game folder · 23.3 of 54.2 GB</div>');
    // the engine says a running job's own words as what the run does now: said once, the live line wins
    const same = words(body({ ...R.dsMake, now: { ...R.dsMake.now!, text: "packing the game folder · 22.1 of 54.2 GB" } }, { id: 70, state: "running", progress: 0.43, message: "packing the game folder · 23.3 of 54.2 GB" }));
    expect(same.split("packing the game folder").length - 1).toBe(1);
    expect(same).toContain("43% packing the game folder · 23.3 of 54.2 GB");
    expect(buttons(body(R.dsMake))).toEqual(expect.arrayContaining(["Open its log", "Cancel this step"]));
    // an ask the run no longer has is not shown
    expect(words(body(R.dsMake))).not.toContain("needs its game data");
  });
  test("done, with a check the server could not run: the verdict, the smoke start's words, its screenshot and its output", () => {
    const out = body({ ...R.mm, check: R.mmCheck }), said = words(out);
    expect(said).toContain("Playable: members can install it from Ahoy");
    expect(said).toContain("The check Not started here: the server has no graphics device");
    expect(said).toContain("Loading the screenshot");
    // the smoke row says what the start showed; the verdict above says what that means
    expect(said).toContain("The smoke start: its window “Zelda 64: Recompiled” came up, and it stopped (exit 1)");
    expect(buttons(out)).toContain("Its output");
    expect(out).toContain('title="Check: not checked here — not started here: the server has no graphics device"');
    expect(buttons(out)).not.toContain("Look again now");
  });
  test("held by a cancel: what you did, and Resume", () => {
    const out = body(R.nxHeld);
    expect(words(out)).toContain("On hold: you cancelled job 75 (building the game on the server): press Resume to carry on.");
    expect(buttons(out)).toContain("Resume");
    expect(out).toContain('title="Build: on hold — building the game on the server"');
    expect(words(out)).toContain("Build On hold: building the game on the server");
  });
  test("Zelda 64: Recompiled's go-ahead offers Go ahead and Not now, and nothing to bring", () => {
    const out = body(R.zelda);
    expect(words(out)).toContain("Should ludarr make The Legend of Zelda: Majora's Mask playable through Zelda 64: Recompiled?");
    expect(buttons(out)).toEqual(expect.arrayContaining(["Go ahead", "Not now"]));
    expect(buttons(out).filter(b => /Look again now|Pick it on the server|Upload it/.test(b))).toEqual([]);
  });
  test("an emulator plan's choice lists the library games it can make playable, and another library game", () => {
    const out = body(R.pcsx2), said = words(out);
    expect(said).toContain("Shadow of the Colossus (2005) · PlayStation 2");
    expect(buttons(out).filter(b => b === "Make this one playable")).toHaveLength(3);
    expect(out).toContain('placeholder="Another game in the library"');
  });
  test("out of AI budget: the words, where the setting is, and Look again now (for after it is raised)", () => {
    const out = body(R.sonic);
    expect(words(out)).toContain("ludarr's AI tried 3 times to make Unleashed Recompiled work for Sonic Unleashed");
    expect(out).toContain('href="/settings/general"');
    expect(buttons(out)).toEqual(expect.arrayContaining(["Settings → General → Import", "Look again now"]));
  });
  test("NX2navi's personal dump: the .nup only the owner's console makes, the AI's own words, no upload", () => {
    const out = body(R.nx), said = words(out);
    expect(said).toContain("It comes only from your own console: Eglantine on your Switch 2 dumps it.");
    expect(said).toContain("The AI's words: “Only the owner's console can make the .nup");
    expect(buttons(out)).not.toContain("Upload it");
  });
  test("NX2navi on game 48 while the game's ordinary download runs: the ask says so, keeps watching the inbox, plans no search beside it, no upload", () => {
    const running = "A download of The Legend of Zelda: Ocarina of Time is already running (The.Legend.of.Zelda.Ocarina.of.Time.V2-nogrp): ludarr looks at what it brings as soon as it lands.";
    const out = body({ ...R.nx, ask: { ...R.nx.ask!, watching: { nextSearchAt: null, inbox: true, every: "2 minutes" }, tried: ["No copy of the game is on the server, and no file is kept for it.", running] } });
    const said = words(out);
    expect(said).toContain(running);
    expect(said).toContain("Still watching: no search of the indexers planned · the inbox every 2 minutes");
    expect(buttons(out)).toEqual(expect.arrayContaining(["Copy", "Pick it on the server", "Look again now"]));
    expect(buttons(out)).not.toContain("Upload it");
  });
  test("a ROM the admin can upload: Upload it, and where to say how the PC opens the library", () => {
    const out = body(R.sm64);
    expect(buttons(out)).toEqual(expect.arrayContaining(["Pick it on the server", "Upload it", "Look again now"]));
    expect(words(out)).toContain("To see it as your PC opens it, set Library as your PC sees it under Settings → Media Management (advanced).");
  });
  test("while it asks, a download its search brings shows its bytes, without a Cancel of a job that is not the run's own", () => {
    const fetching = { ...R.ds, now: { text: "downloading Demons.Souls.PS5.app0-GRP · 31.0 of 83.1 GB", progress: 0.37, jobId: null, requestId: 9 } };
    const out = body(fetching), said = words(out);
    expect(said).toContain("Downloading Demons.Souls.PS5.app0-GRP · 31.0 of 83.1 GB 37%");
    expect(said).toContain("Demon's Souls needs its game data");
    expect(buttons(out)).toContain("Open the queue");
    expect(buttons(out)).not.toContain("Cancel this step");
    // a search that only looks says so on the ask's own line instead
    expect(words(body({ ...R.ds, now: { ...fetching.now, text: "looking on the indexers", progress: 0 } }))).not.toContain("Looking on the indexers");
  });
  test("a file nothing proves: Accept it", () => {
    expect(buttons(body(R.banjo))).toEqual(expect.arrayContaining(["Accept it", "Look again now"]));
  });
});

describeWeb("a way's card with its run and the game's copy", () => {
  const g = { id: 21, name: "Demon's Souls", routes: [] };
  const card = (w: unknown, files: unknown[] = []) => html(WayCard, { w, plan: null, g, files, tick: null, findable: true, onChanged() {}, onLog() {}, onEditPlan() {}, onNoFind() {} });
  test("the copy's own words, the second copy that can be freed, and the sealed disc never offered as the way's file", () => {
    const out = card(dsWay(R), [dsSecondCopy({ id: 5, secondCopy: { bytes: DS_ISO } })]), said = words(out);
    expect(said).toContain("The game's copy on the server (bbb-ps5-01342.iso, 54.2 GB) is the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it.");
    expect(said).toMatch(/The game's copy is kept a second time on the server \( ?bbb-ps5-01342\.iso ?, 54\.2 GB\)\./);
    expect(buttons(out)).toContain("Free 54.2 GB (keeps one copy)");
    // the sealed disc is never offered as the way's file: it is listed with the kept files, with what its bytes say
    expect(said).not.toContain("sealed for the console");
    expect(buttons(out)).not.toContain("use it for this way");
    const kept = html(KeptFiles, { files: [dsSecondCopy({ id: 5, secondCopy: { bytes: DS_ISO } })], ways: [dsWay(R)], onChanged() {} });
    expect(words(kept)).toContain("PPSA01342 · US · disc 01.00 · sealed for the console");
    expect(words(kept)).toContain("its console copy");
    expect(buttons(kept)).toContain("Free 54.2 GB (keeps one copy)");
    // the run, until it is read, by what the way listing says of it: its ask, with the ask's own controls at once
    expect(said).toContain("Making it playable Needs its game data Open the run Demon's Souls needs its game data");
    expect(said).toContain("Put it in this folder or pick it on the server: ludarr takes it from there and finishes by itself.");
    expect(buttons(out)).toEqual(expect.arrayContaining(["Copy", "Pick it on the server", "Look again now"]));
    // they take the place of the card's own (an upload never brings a game folder, nor a .zar too large to send)
    expect(said).toContain("Needs Demon's Souls (PlayStation 5) · .zar · PPSA01341, PPSA01342 or PPSA01340 · version 01.005.000 or 01.007.000 · made from the game folder");
    expect(buttons(out).filter(b => /^(Use a file or folder on the server|Upload the file|Upload it)$/.test(b))).toEqual([]);
    // with no run asking, the card's own controls are there, and the server pick takes a folder
    expect(buttons(card(dsWay(R, { run: null })))).toEqual(expect.arrayContaining(["Use a file or folder on the server", "Upload the file"]));
  });
  test("Make it playable: only on an engine with runs, for a way with no open run", () => {
    expect(buttons(card(dsWay(R, { run: null })))).toContain("Make it playable");
    expect(buttons(card(dsWay(R)))).not.toContain("Make it playable");
    expect(buttons(card(dsWay(R, { run: undefined, copy: undefined })))).not.toContain("Make it playable");
    // the Build button says why it cannot build
    expect(card(dsWay(R))).toContain(`title="the game&#x27;s copy on the server is ${R.dsCopy.why.replace(/'/g, "&#x27;")}"`);
  });
  test("the live way 1 as the box has it (a .zar of PPSA01341, nothing to make it from) beside content row 1, from an engine that does not say which file is a second copy", () => {
    const live = {
      kind: "disc" as const, platform: "ps5", what: "Demon's Souls", search: ["Demon's Souls"], place: "game/{name}",
      accept: { hashes: [], formats: ["zar"], serials: ["PPSA01341"] },
    };
    const w = dsWay(R, { content: live, run: null });
    const out = card(w, [dsSecondCopy()]), said = words(out);
    expect(said).toContain("Needs Demon's Souls (PlayStation 5) · .zar · PPSA01341");
    // the sealed copy's own words, and Build off with the same words
    expect(said).toContain(`The game's copy on the server (bbb-ps5-01342.iso, 54.2 GB) is ${R.dsCopy.why}.`);
    const build = [...out.matchAll(/<button([^>]*)>((?:(?!<\/button>)[\s\S])*)<\/button>/g)].find(m => words(m[2]) === "Build");
    expect(build?.[1]).toContain('disabled=""');
    expect(build?.[1]).toContain('title="the game&#x27;s copy on the server is the retail disc as a PC drive reads it');
    // row 1 has the copy's name and size: offered to be freed, as what it may be (the server compares the bytes first)
    expect(said).toMatch(/A file kept for the game has the copy's name and size \( ?bbb-ps5-01342\.iso ?, 54\.2 GB\): it may be the same bytes kept a second time\./);
    expect(buttons(out)).toContain("Free 54.2 GB (keeps one copy)");
    // the sealed disc is never offered as the way's file; the file the way takes is one file, so the server pick says so
    expect(buttons(out)).not.toContain("use it for this way");
    expect(buttons(out)).toEqual(expect.arrayContaining(["Use a file on the server", "Make it playable"]));
    const kept = words(html(KeptFiles, { files: [dsSecondCopy()], ways: [w], onChanged() {} }));
    expect(kept).toContain("It has the copy's name and size: Free 54.2 GB (keeps one copy)");
    expect(kept).toContain("its console copy");
  });
  test("a file the copy was taken in by (a hard link, so the same name and size) is the way's file: never called a second copy", () => {
    const rom = { ...dsSecondCopy({ id: 9, name: "Super Mario 64 (USA).z64", size: 8_388_608, platform: "n64", identity: { platform: "n64", gameCode: "NSME", region: "US" } }) };
    const copy = { ...R.dsCopy, name: rom.name, size: rom.size, shape: "file" as const, identity: rom.identity ?? null, serves: "direct" as const, why: "" };
    const w = dsWay(R, { contentId: 9, file: rom, fileCheck: { ok: true, why: null }, copy, run: null, blockers: [], canBuild: true, status: "ready" });
    const out = card(w, [rom]);
    expect(words(out)).not.toContain("second time");
    expect(buttons(out).filter(b => b.startsWith("Free"))).toEqual([]);
    expect(buttons(html(KeptFiles, { files: [rom], ways: [w], onChanged() {} })).filter(b => b.startsWith("Free"))).toEqual([]);
  });
  test("an emulator's choice with no library game to list, and a question the AI asked: only answers the engine takes", () => {
    const none = body({ ...R.pcsx2, ask: { ...R.pcsx2.ask!, choices: [] } });
    expect(none).toContain('placeholder="A game in the library"');
    expect(buttons(none).filter(b => /^(Go ahead|Not now)$/.test(b))).toEqual([]);
    const ai = body({ ...R.pcsx2, ask: { ...R.pcsx2.ask!, title: "Which of the program's two kits fits this server?", choices: R.pcsx2.ask!.choices, byAi: "the release has an AVX2 build and an SSE4 build" } });
    expect(buttons(ai).filter(b => /^(Go ahead|Not now|Make this one playable|Add it as a new game)$/.test(b))).toEqual([]);
    expect(ai).not.toContain("placeholder=");
    expect(buttons(ai)).toEqual(expect.arrayContaining(["Open the plan", "Look again now"]));
    expect(words(ai)).toContain("The AI's words: “the release has an AVX2 build and an SSE4 build”");
  });
});

describeWeb("a carry run as the admin uses it (the engine's run routes answered as SEAMS.md sets them out)", () => {
  const savedFetch = globalThis.fetch;
  let savedKey = "";
  let cfg: ReturnType<typeof tempConfig>;
  const made = { plans: [] as number[], jobs: [] as number[] };
  beforeAll(() => { cfg = tempConfig(); savedKey = runtime.apiKey; runtime.apiKey = apiKey(); globalThis.fetch = pageFetch as typeof fetch; });
  afterEach(() => { answer = null; asked.length = 0; });
  afterAll(() => {
    globalThis.fetch = savedFetch; runtime.apiKey = savedKey;
    for (const id of made.jobs) db.query("DELETE FROM jobs WHERE id=?").run(id);
    for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
    cfg.restore();
  });
  /** the run routes B1 mounts, answered from these runs; anything else goes to the engine */
  const runs = (list: Record<number, unknown>, extra?: (r: { method: string; path: string; body: any }) => Response | undefined) => (r: { method: string; path: string; body: any }) => {
    const m = r.path.match(/^\/api\/v1\/run\/(\d+)(\/(retry|stop|answer))?$/);
    if (m && list[Number(m[1])]) return Response.json({ item: list[Number(m[1])] });
    return extra?.(r);
  };
  const g = { id: 21, name: "Demon's Souls", routes: [] };
  const cardOf = (w: unknown, files: unknown[] = []) => h(WayCard, { w, plan: null, g, files, tick: null, findable: true, onChanged() {}, onLog() {}, onEditPlan() {}, onNoFind() {} });

  test("on the way card the ask's controls take the place of the card's own, and Look again now asks the run to look again", async () => {
    answer = runs({ 11: R.ds });
    const v = mount(cardOf(dsWay(R)));
    try {
      await until("the run's ask", () => said(v.box).includes("Put it in this folder or pick it on the server"));
      expect(named(controls(v.box, "Use a file or folder on the server"))).toEqual([]);
      expect(named(controls(v.box, "Upload the file"))).toEqual([]);
      expect(named(controls(v.box, "Pick it on the server"))).toEqual(["Pick it on the server"]);
      await press(v.box, "Look again now");
      await until("the retry", () => sent("POST", "/api/v1/run/11/retry").length === 1);
      await until("its toast", () => v.toasts("success").includes("Looking again now"));
    } finally { v.unmount(); }
  });
  test("a make: the card shows the job once, in the run, with the job's own ticks", async () => {
    answer = runs({ 12: R.dsMake });
    const v = mount(cardOf(dsWay(R, { run: { id: 12, phase: "file", state: "waiting", ask: null }, job: R.makeJob })));
    try {
      await until("the run's progress", () => said(v.box).includes("Making the game file from the game folder that landed in the inbox"));
      events.emit("build", { ...R.makeJob, progress: 0.44, message: "packing the game folder · 23.9 of 54.2 GB" });
      await until("the tick", () => said(v.box).includes("44%packing the game folder · 23.9 of 54.2 GB") || said(v.box).includes("44% packing the game folder · 23.9 of 54.2 GB"));
      // one progress for the job, not the card's and the run's
      expect(byClass(v.box, "progress")).toHaveLength(1);
      expect(said(v.box)).not.toContain("Making its game file 44%");
    } finally { v.unmount(); }
  });
  test("Make it playable asks first when the game has a PC copy, posts the way's carry, and opens the run", async () => {
    answer = runs({ 11: R.ds }, r => (r.method === "POST" && r.path === "/api/v1/way/1/carry" ? Response.json({ item: R.ds }, { status: 202 }) : undefined));
    const v = mount(cardOf(dsWay(R, { run: null, replaces: "native" })));
    try {
      await press(v.box, "Make it playable");
      const ask = await until("the question", () => every(v.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Replace the PC copy?"))[0]);
      await press(ask, "Replace");
      await until("the carry", () => sent("POST", "/api/v1/way/1/carry").length === 1);
      expect(sent("POST", "/api/v1/way/1/carry")).toEqual([{ replace: true }]);
      await until("the run's dialog", () => every(v.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Making Demon's Souls playable")).length > 0);
    } finally { v.unmount(); }
  });
  test("Free 54.2 GB (keeps one copy) asks, then frees the second copy through its route", async () => {
    answer = runs({ 11: R.ds }, r => (r.method === "POST" && r.path === "/api/v1/content/6/free-duplicate" ? Response.json({ freedBytes: DS_ISO }) : undefined));
    const v = mount(cardOf(dsWay(R), [dsSecondCopy({ id: 6 })]));
    try {
      await press(v.box, "Free 54.2 GB (keeps one copy)");
      const ask = await until("the question", () => every(v.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Free 54.2 GB?"))[0]);
      await press(ask, "Free 54.2 GB");
      await until("the toast", () => v.toasts("success").some(t => t.includes("Freed 54.2 GB: one copy is kept")));
      expect(sent("POST", "/api/v1/content/6/free-duplicate")).toEqual([null]);
    } finally { v.unmount(); }
  });
  test("the run's dialog: Go ahead and Not now answer a held run, Resume carries a cancelled one on, Stop asks first", async () => {
    answer = runs({ 16: R.zelda, 15: R.nxHeld, 17: R.pcsx2 });
    const z = mount(h(RunModal, { id: 16, onClose() {} }));
    try {
      await press(z.box, "Go ahead");
      await until("the answer", () => sent("POST", "/api/v1/run/16/answer").length === 1);
      await press(z.box, "Not now");
      await press(await until("the question", () => every(z.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Not now?"))[0]), "Stop the run");
      await until("the second answer", () => sent("POST", "/api/v1/run/16/answer").length === 2);
      expect(sent("POST", "/api/v1/run/16/answer")).toEqual([{ go: true }, { go: false }]);
    } finally { z.unmount(); }
    const held = mount(h(RunModal, { id: 15, onClose() {} }));
    try {
      await press(held.box, "Resume");
      await until("the resume", () => sent("POST", "/api/v1/run/15/retry").length === 1);
      await press(held.box, "Stop");
      await press(await until("the question", () => every(held.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Stop making The Legend of Zelda: Ocarina of Time playable?"))[0]), "Stop");
      await until("the stop", () => sent("POST", "/api/v1/run/15/stop").length === 1);
    } finally { held.unmount(); }
    const choice = mount(h(RunModal, { id: 17, onClose() {} }));
    try {
      const okami = await until("Okami's row", () => every(choice.box, e => e.nodeName === "LI" && said(e).startsWith("Okami"))[0]);
      await press(okami, "Make this one playable");
      await until("the answer", () => sent("POST", "/api/v1/run/17/answer").length === 1);
      expect(sent("POST", "/api/v1/run/17/answer")).toEqual([{ gameId: 31 }]);
    } finally { choice.unmount(); }
  });
  test("the run's check is read from its build's job, and its screenshot from the check-shot route with the key in the header", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    answer = r => (r.path === "/api/v1/import/80" ? Response.json({ item: R.assembleJob })
      : r.path === "/api/v1/check-shot/check-80-1.png" ? new Response(png, { headers: { "content-type": "image/png" } }) : undefined);
    const v = mount(h(RunCheck, { view: R.mm }));
    try {
      await until("the verdict", () => said(v.box).includes("Not started here: the server has no graphics device"));
      await until("the screenshot", () => every(v.box, e => e.nodeName === "IMG").length === 1);
      expect(asked.filter(r => r.path === "/api/v1/check-shot/check-80-1.png").map(r => r.method)).toEqual(["GET"]);
      expect(every(v.box, e => e.nodeName === "IMG")[0].getAttribute("src")).toMatch(/^blob:/);
    } finally { v.unmount(); }
  });
  test("a server without run routes: the run's dialog says so quietly", async () => {
    // an engine from before the run routes (this one has them): its 404 for an unknown route
    answer = r => (r.path.startsWith("/api/v1/run") ? Response.json({ error: "no such endpoint" }, { status: 404 }) : undefined);
    const v = mount(h(RunModal, { id: 11, onClose() {} }));
    try { await until("the words", () => said(v.box).includes("Not available on this server yet.")); }
    finally { v.unmount(); }
  });
  test("Activity → Builds lists the games being made playable and opens their run; a server that does not know 'make' jobs still lists the others", async () => {
    answer = runs({ 11: R.ds }, r => (r.method === "GET" && r.path.startsWith("/api/v1/runs") ? Response.json({ items: [R.ds, R.zelda] }) : undefined));
    const v = mount(h(BuildsPage), "/activity/builds");
    try {
      const row = await until("the run's row", () => every(v.box, e => e.nodeName === "TR" && said(e).includes("through " + KYTY))[0]);
      expect(said(row)).toContain("Needs its game data");
      expect(said(row)).toContain("Demon's Souls needs its game data · still watching");
      expect(said(await until("the held run", () => every(v.box, e => e.nodeName === "TR" && said(e).includes("through Zelda 64: Recompiled"))[0]))).toContain("Waiting for your go-ahead");
      // the engine refuses kind=make (400) until it knows the kind: the other kinds are still listed
      await until("the jobs list", () => byClass(v.box, "builds").length > 0 || said(v.box).includes("No builds yet"));
      expect(said(v.box)).not.toContain("Could not load the builds");
      expect(sent("GET", "/api/v1/jobs?kind=make")).toHaveLength(1);
      await press(row, "Open the run");
      await until("the run's dialog", () => every(v.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Making Demon's Souls playable")).length > 0);
      expect(v.where).toBe("/activity/builds?run=11");
    } finally { v.unmount(); }
  });
  test("From a repo: once the plan is saved the page becomes its run's view; a server that cannot show the run keeps the forms", async () => {
    const ROM = bytes(16 * 1024, 7);
    const spec = validatePlanSpec({
      program: { kind: "release", assetPattern: "^NX2navi-app-.*[.]zip$", channel: "stable" }, launch: { exe: "ocarina.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "the game, NTSC-U 1.0", search: ["The Legend of Zelda: Ocarina of Time"], accept: { hashes: [{ algo: "sha1", value: sha1(ROM) }], formats: ["z64"] }, place: "game.z64" },
      files: [], setup: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: null,
    }, "recomp");
    expect(spec.errors).toEqual([]);
    const p = insertPlan({ name: "NX2navi (pages)", kind: "recomp", repo: "NX2navi/NX2navi", platforms: ["n64"], spec: spec.value!, status: "ready" });
    made.plans.push(p.id);
    const j = enqueueJob({ kind: "construct", repo: "NX2navi/NX2navi" });
    made.jobs.push(j.id);
    stmts.setJobDone.run(`plan ready: ${p.name}`, null, JSON.stringify({ planId: p.id, runId: 14 }), j.id);
    answer = runs({ 14: R.nx });
    const v = mount(h(RepoTab), `/add/repo?job=${j.id}`);
    try {
      await until("the run's view", () => said(v.box).includes("Making The Legend of Zelda: Ocarina of Time playable"));
      await until("its ask", () => said(v.box).includes("The Legend of Zelda: Ocarina of Time needs its game data"));
      expect(said(v.box)).toContain("Open it with the plans");
      expect(named(controls(v.box, "Add a game for it"))).toEqual([]);
    } finally { v.unmount(); }
    answer = null;
    const old = mount(h(RepoTab), `/add/repo?job=${j.id}`);
    try { await until("the forms", () => said(old.box).includes("The run proposed no game: describe the one it plays.")); }
    finally { old.unmount(); }
  });
  test("the plan's dialog lists its run that waits for a go-ahead (Zelda 64: Recompiled, its game not in the library) and opens it where Go ahead is", async () => {
    const ROM = bytes(16 * 1024, 9);
    const spec = validatePlanSpec({
      program: { kind: "release", assetPattern: "^Zelda64Recompiled-.*-Windows[.]zip$", channel: "stable" }, launch: { exe: "Zelda64Recompiled.exe", argv: [] },
      content: { kind: "rom", platform: "n64", what: "The Legend of Zelda: Majora's Mask, NTSC-U 1.0", search: ["The Legend of Zelda: Majora's Mask"], accept: { hashes: [{ algo: "sha1", value: sha1(ROM) }], formats: ["z64"] }, place: "mm.n64.us.1.0.z64" },
      files: [], setup: [], needs: [], keep: ["saves/**"], seed: [], firstRun: null, notes: null,
    }, "recomp");
    expect(spec.errors).toEqual([]);
    const p = insertPlan({ name: "Zelda 64: Recompiled (pages)", kind: "recomp", repo: "Zelda64Recomp/Zelda64Recomp", platforms: ["n64"], spec: spec.value!, status: "ready" });
    made.plans.push(p.id);
    const held = { ...R.zelda, planId: p.id, planName: p.name };
    answer = runs({ 16: held }, r => (r.method === "GET" && r.path === `/api/v1/runs?planId=${p.id}&open=1` ? Response.json({ items: [{ ...held, steps: undefined }] }) : undefined));
    const v = mount(h(PlanDetailModal, { id: p.id, onClose() {}, onChanged() {} }));
    try {
      const row = await until("the run's row", () => byClass(v.box, "plan-run").find(e => said(e).includes("Waiting for your go-ahead")));
      expect(said(row)).toContain("no game yet");
      expect(said(row)).toContain("Make The Legend of Zelda: Majora's Mask playable?");
      await press(row, "Open the run");
      const run = await until("the run's dialog", () => every(v.box, e => e.getAttribute("role") === "dialog" && said(e).includes("Making a game playable through Zelda 64: Recompiled (pages)"))[0]);
      await press(run, "Go ahead");
      await until("the answer", () => sent("POST", "/api/v1/run/16/answer").length === 1);
      expect(sent("POST", "/api/v1/run/16/answer")).toEqual([{ go: true }]);
    } finally { v.unmount(); }
  });
  test("Free on a file that is not the copy's bytes: the server's words as a warning, and it is not offered again", async () => {
    const no = "the copy's file is not the same bytes now (its sha256 is 9f…): nothing is freed";
    answer = runs({ 11: R.ds }, r => (r.method === "POST" && r.path === "/api/v1/content/7/free-duplicate" ? Response.json({ error: no }, { status: 409 }) : undefined));
    const v = mount(cardOf(dsWay(R), [dsSecondCopy({ id: 7 })]));
    try {
      await press(v.box, "Free 54.2 GB (keeps one copy)");
      await press(await until("the question", () => every(v.box, e => e.getAttribute("role") === "dialog" && said(e).includes("compares"))[0]), "Free 54.2 GB");
      await until("the warning", () => v.toasts("warning").some(t => t.includes("The copy's file is not the same bytes now")));
      await until("the offer gone", () => !controls(v.box, "Free 54.2 GB (keeps one copy)").length);
      expect(sent("POST", "/api/v1/content/7/free-duplicate")).toHaveLength(1);
    } finally { v.unmount(); }
  });
  test("a done run's check, as the engine's own steps name its build: read from that build's job", async () => {
    const steps = [
      { at: RUN_NOW - 300, phase: "build", who: "ludarr", text: "built: 44 files, 67 MB · not started here: the server has no graphics device", outcome: "ok", jobId: 80 },
      { at: RUN_NOW - 299, phase: "check", who: "ludarr", text: "built: The Legend of Zelda: Majora's Mask is ready for members to install; not started here: the server has no graphics device", outcome: "ok" },
    ];
    answer = r => (r.path === "/api/v1/import/80" ? Response.json({ item: R.assembleJob }) : r.path.startsWith("/api/v1/check-shot/") ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }) : undefined);
    const v = mount(h(RunCheck, { view: { ...R.mm, steps } }));
    try {
      await until("the verdict", () => said(v.box).includes("Not started here: the server has no graphics device"));
      expect(sent("GET", "/api/v1/import/80")).toHaveLength(1);
    } finally { v.unmount(); }
  });
  test("Activity → Builds: the ticks of the job a run follows move its row (bytes of total, as they come)", async () => {
    answer = r => (r.method === "GET" && r.path.startsWith("/api/v1/runs") ? Response.json({ items: [{ ...R.dsMake, steps: undefined }] }) : undefined);
    const v = mount(h(BuildsPage), "/activity/builds");
    try {
      const row = () => every(v.box, e => e.nodeName === "TR" && said(e).includes("through " + KYTY))[0];
      await until("the run's row", () => row() && said(row()).includes("Making the game file from the game folder that landed in the inbox · 41%"));
      events.emit("build", { ...R.makeJob, progress: 0.44, message: "packing the game folder · 23.9 of 54.2 GB" });
      await until("the tick", () => said(row()).includes("Packing the game folder · 23.9 of 54.2 GB · 44%"));
      // another job's tick leaves it as it is
      events.emit("build", { ...R.makeJob, id: 71, progress: 0.9, message: "something else" });
      await new Promise(r => setTimeout(r, 30));
      expect(said(row())).toContain("23.9 of 54.2 GB · 44%");
    } finally { v.unmount(); }
  });
});

describeWeb("the release list says why the automatic search would not take a release (Fix A)", () => {
  test("its first reason after the chips, every reason on hover; a release it would take says nothing", () => {
    const razor = {
      guid: "g1", title: "Call.of.Duty.4.Modern.Warfare-Razor1911", instanceId: 1, indexerId: 5, indexer: "FileList.io", size: 6.79e9, age: 31, publishDate: "", seeders: 55, leechers: 0,
      grabs: null, downloadUrl: "x", magnetUrl: null, infoUrl: null, protocol: "torrent", score: 138.2, reasons: ["full title", "55 seeders", "Razor1911"],
      parsed: { group: "Razor1911", format: null, repack: false, scene: true, version: null, junk: [], platform: null }, match: { ok: true, core: 1, optional: 1 },
      format: "iso", certain: false, allowed: false, blocked: false, refusals: ["the words of the name are in another order (another game?)", "posted 13 days before the game came out"],
    };
    const rune = { ...razor, guid: "g2", title: "Call.of.Duty.Modern.Warfare.4-RUNE", parsed: { ...razor.parsed, group: "RUNE" }, certain: true, allowed: true, refusals: [] };
    const out = html(ReleaseTable, { items: [razor, rune], name: "Call of Duty®: Modern Warfare® 4" });
    const rows = out.split("<tr").slice(2);                                                   // the header row first
    expect(words(rows[0])).toContain("Razor1911 · full title · 55 seeders · Razor1911 · not taken automatically: the words of the name are in another order (another game?)");
    expect(rows[0]).toContain('title="the words of the name are in another order (another game?)\nposted 13 days before the game came out"');
    expect(words(rows[1])).not.toContain("not taken automatically");
    expect(words(rows[1])).not.toContain("not certainly this game");
  });
});

/* ─────────── Fix A review round (2026-11-09): each reason once, the reason first ─────────── */
const { RefusedList } = await load(() => page("pages/activity.tsx"));

describeWeb("review: the release list and the queue say why, each reason once", () => {
  const REORDER = "the words of the name are in another order (another game?)";
  const base = {
    guid: "g1", title: "Call.of.Duty.4.Modern.Warfare-Razor1911", instanceId: 1, indexerId: 5, indexer: "FileList.io", size: 6.79e9, age: 31, publishDate: "", seeders: 55, leechers: 0,
    grabs: null, downloadUrl: "x", magnetUrl: null, infoUrl: null, protocol: "torrent", score: 138.2,
    parsed: { group: "Razor1911", format: null, repack: false, scene: true, version: null, junk: [], platform: null }, match: { ok: true, core: 1, optional: 1 },
    format: "iso", allowed: false, blocked: false, certain: false,
  };
  test("a chip that the refusal already says is left out (the reasons as GET /release really sends them)", () => {
    const razor = { ...base, reasons: ["full title", REORDER, "55 seeders", "Razor1911"], refusals: [REORDER] };
    const hell = { ...base, guid: "g2", title: "Hades.Hellfire-RUNE", parsed: { ...base.parsed, group: "RUNE" }, reasons: ['extra title words ("hellfire")', "55 seeders", "RUNE"], refusals: ['more words after the name ("hellfire"): another game or an add-on'] };
    const two = { ...base, guid: "g3", title: "Hades.2-RUNE", parsed: { ...base.parsed, group: "RUNE" }, reasons: ["looks like a sequel / other entry", "55 seeders", "RUNE"], refusals: ["looks like a sequel or another entry"] };
    const rows = html(ReleaseTable, { items: [razor, hell, two], name: "Call of Duty®: Modern Warfare® 4" }).split("<tr").slice(2).map(words);
    expect(rows[0]).toContain(`Razor1911 · full title · 55 seeders · Razor1911 · not taken automatically: ${REORDER}`);
    expect(rows[0].split(REORDER)).toHaveLength(2);
    expect(rows[1]).toContain('RUNE · 55 seeders · RUNE · not taken automatically: more words after the name ("hellfire")');
    expect(rows[1]).not.toContain('extra title words');
    expect(rows[2]).not.toContain("looks like a sequel / other entry");
  });
  test("the queue lists what a search that took nothing found: each release, where, and its first reason", () => {
    const out = words(html(RefusedList, { items: [
      { title: "Call.of.Duty.4.Modern.Warfare-Razor1911", indexer: "FileList.io", size: 6.79e9, protocol: "torrent", why: [REORDER] },
      { title: "Call.of.Duty.Modern.Warfare.4-RUNE", indexer: "DrunkenSlug", size: 98e9, protocol: "usenet", why: ["no seeders", "blocklisted"] },
    ] }));
    expect(out).toContain("2 found, none taken");
    expect(out).toContain(`Call.of.Duty.4.Modern.Warfare-Razor1911 · FileList.io · ${REORDER}`);
    expect(out).toContain("Call.of.Duty.Modern.Warfare.4-RUNE · DrunkenSlug · no seeders");
  });
});
