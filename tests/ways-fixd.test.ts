/**
 * After the live trace: a note about shader caches made on the player's PC is no build to move to the server
 * (src/ways/validate.ts firstRunOnPlayersPc), while NX2navi's first start still is; a kit's pinned fetches are downloaded
 * once — the AI's dry run keeps them in the server's sha256 cache, as the build does (src/ways/construct-tools.ts); and the
 * earlier downloads the AI is shown follow the run's own rules (including imported data still present, never one outside the folders
 * ludarr takes files from).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, stmts, upsertGame, type GameRow } from "../src/db";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { pdeps } from "../src/process/deps";
import { ndeps } from "../src/net/public-url";
import { sbdeps } from "../src/ways/sandbox";
import { prdeps } from "../src/ways/program";
import { crdeps } from "../src/ways/carry";
import { ConstructTools, ctdeps } from "../src/ways/construct-tools";
import { firstRunOnPlayersPc } from "../src/ways/validate";
import { bytes, fake7z, restoreDeps, sha256, tempConfig, tmp, tools7z, type Call } from "./ways-fixtures";

/* ─────────── the build players' PCs would run ─────────── */

/** plan 3's live text (KytyPS5), word for word */
const KYTY_FIRST_RUN = "KytyLauncher --play starts run-windows.ps1 in a console (minimized) with no dialogs: it lists the game's shaders from the .zar (seeds file), builds the background shader-preparation inputs for this PC's GPU and driver (about a minute, longer on fewer cores), then the game window opens and shows 'Preparing shaders xx%' at the top right while shaders translate. The optional full precompile (about 1-2 h) is on the launcher window's Shaders page (KytyLauncher.exe without --play, or precompile.cmd).";
const KYTY_NOTE = "Shader caches are per GPU/driver and made on the player's PC on first run (zip README.md:315-361) — they cannot be built at package time.";
const KYTY_NOTES = `Windows asset KytyPS5-v<date>.zip (linux/steamdeck zips excluded by the pattern). Fork tuned for Demon's Souls PPSA01341 v1.07/1.05 (README.md in the zip:7-19). ${KYTY_NOTE} Saves _SaveData, caches _PipelineCache, logs, settings launcher-settings.json (zip README.md:427-448). No hashes in the repo. Needs a Vulkan 1.3 GPU, AVX2, 16-32 GB RAM.`;
/** plan 2's live first start (NX2navi), word for word */
const NX_FIRST_RUN = "The NX2navi launcher window with the placed .nup dump already chosen and <install>/game as the folder; the player selects Begin Installation, it downloads ~175 MB of build tools and builds the game on their PC (10–25 min, ~30 GB), then Play starts it.";

describe("a build players' PCs would run", () => {
  test("shader caches made on the player's PC (plan 3's live note) are no build to move to the server", () => {
    expect(firstRunOnPlayersPc({ firstRun: null, notes: KYTY_NOTE })).toBeNull();
    expect(firstRunOnPlayersPc({ firstRun: KYTY_FIRST_RUN, notes: KYTY_NOTES })).toBeNull();
    // the subject far before its verb, in its own clause
    expect(firstRunOnPlayersPc({ firstRun: null, notes: "Shader caches are per GPU/driver and are compiled on the player's PC on first run." })).toBeNull();
  });
  test("the game built on the player's PC still is one (NX2navi's first start; the game named beside its shaders)", () => {
    expect(firstRunOnPlayersPc({ firstRun: NX_FIRST_RUN, notes: "" })).toMatch(/^firstRun says the game is made on the player's PC/);
    expect(firstRunOnPlayersPc({ firstRun: null, notes: "Shaders and the game are compiled on the player's PC on first launch." })).toMatch(/^notes says the game is made on the player's PC/);
    expect(firstRunOnPlayersPc({ firstRun: null, notes: "The game cannot be shipped built: it is compiled on the player's PC at first launch." })).toMatch(/^notes says/);
  });
});

/* ─────────── the AI's dry run of a kit ─────────── */

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...bytes(2000, 5)]);
const ASSET = "Emu-v1.0-win64.zip", URL_ = `https://github.com/some/emu/releases/download/v1.0/${ASSET}`;
const KIT_FILE = bytes(3000, 7), KIT_URL = "https://repo.msys2.org/mingw/ucrt64/kit-tool-1.0-1-any.bin";
function emu(out: string) {
  mkdirSync(join(out, "Emu"), { recursive: true });
  writeFileSync(join(out, "Emu", "Emu.exe"), bytes(50_000, 2));
}
const KIT_SPEC = {
  program: {
    kind: "release", assetPattern: "^Emu-v.*-win64[.]zip$", channel: "stable",
    perGame: { fetch: [{ url: KIT_URL, sha256: sha256(KIT_FILE), size: KIT_FILE.byteLength, to: "kit/kit-tool.bin", unpack: "none" }], steps: ["make_game --nup {content} --out {out}/game"], timeoutSec: 600, artifact: "game" },
  },
  launch: { exe: "Game.exe", argv: [] },
  content: { kind: "rom", platform: "switch", what: "the game as one .nup", search: ["Some Game"], accept: { hashes: [], formats: ["nup"], serials: ["0400486024DEC000"] }, place: "dump/{name}" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: null,
};

let cfg: ReturnType<typeof tempConfig>;
let calls: Call[];
const hits = new Map<string, number>();
const savedCt = { ...ctdeps };
beforeAll(() => { cfg = tempConfig(); });
afterAll(() => cfg.restore());
beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM packages; DELETE FROM ways; DELETE FROM contents; DELETE FROM runtime_plans;");
  ensureDefaultRootFolder();
  calls = []; hits.clear();
  pdeps.log = () => {};
  pdeps.tools = () => tools7z;
  sbdeps.platform = () => "win32";
  sbdeps.exec = fake7z({ [ASSET]: emu }, { calls });
  ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
  ndeps.fetch = async (url: string) => {
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (url === URL_) return new Response(new Uint8Array(ZIP), { headers: { "content-length": String(ZIP.byteLength) } });
    if (url === KIT_URL) return new Response(new Uint8Array(KIT_FILE), { headers: { "content-length": String(KIT_FILE.byteLength) } });
    return new Response("nope", { status: 404 });
  };
  prdeps.latestRelease = async () => ({ tag: "v1.0", name: "v1.0", date: "2026-01-01", prerelease: false, page: "p", immutable: true, asset: { name: ASSET, url: URL_, size: ZIP.byteLength, digest: `sha256:${sha256(ZIP)}` } });
});
afterEach(() => { restoreDeps(); Object.assign(ctdeps, savedCt); });

const tools = (work: string) => new ConstructTools({ work, repo: "some/emu", jobId: 4545, signal: new AbortController().signal, log: () => {}, contentFor: () => null, systemFiles: [] });

describe("a kit's pinned fetches", () => {
  test("are downloaded once: a second round's dry run takes them from the server's cache, held to their sha256 again", async () => {
    const first = await tools(tmp("fixd-kit-1-")).run("try_plan", { kind: "recomp", spec: KIT_SPEC });
    expect(first.out).toContain("fetch 1: kit-tool-1.0-1-any.bin");
    expect(hits.get(KIT_URL)).toBe(1);
    const second = await tools(tmp("fixd-kit-2-")).run("try_plan", { kind: "recomp", spec: KIT_SPEC });
    expect(second.out).toContain("kit-tool-1.0-1-any.bin");
    expect(hits.get(KIT_URL)).toBe(1);
  });
});

/* ─────────── the earlier downloads the AI is shown ─────────── */

describe("the earlier downloads the AI sees", () => {
  test("include imported data still present, but exclude active jobs and paths outside the allowed folders", async () => {
    const g = upsertGame({ steam_appid: 985_001, name: "Fixd Earlier Game", slug: "fixd-earlier-game" }) as GameRow;
    const allowed = tmp("fixd-allowed-"), elsewhere = tmp("fixd-elsewhere-");
    const at = (dir: string, name: string) => { const p = join(dir, name); writeFileSync(p, "rar"); return p; };
    const add = (title: string, path: string, imported: boolean) =>
      (db.query("INSERT INTO fetches (game_id, title, protocol, client, state, local_path, size, imported_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id").get(g.id, title, "torrent", "rtorrent", "done", path, 3, imported ? 1_794_000_000 : null) as { id: number }).id;
    const kept = add("Kept.Download", at(allowed, "kept.rar"), false);
    const imported = add("Imported.Download", at(allowed, "imported.rar"), true);
    const busy = add("Active.Import", at(allowed, "active.rar"), false);
    const job = db.query("INSERT INTO jobs (game_id, fetch_id, input_path, state) VALUES (?, ?, '', 'running') RETURNING id").get(g.id, busy) as { id: number };
    add("Elsewhere.Download", at(elsewhere, "elsewhere.rar"), false);
    ctdeps.allowedRoots = async () => [realpathSync(allowed)];
    const ds = await ctdeps.earlierDownloads(g.id);
    expect(ds.map(d => d.fetchId)).toEqual([imported, kept]);
    expect(ds[0].imported).toBe(true);
    const roots = crdeps.allowedRoots;
    try {
      crdeps.allowedRoots = async () => [realpathSync(allowed)];
      expect((await crdeps.earlierDownloads(g.id)).map(d => d.fetchId)).toEqual([imported, kept]);
    } finally { crdeps.allowedRoots = roots; }
    db.query("DELETE FROM jobs WHERE id=?").run(job.id);
    db.query("DELETE FROM fetches WHERE game_id=?").run(g.id);
    db.query("DELETE FROM games WHERE id=?").run(g.id);
    void stmts;
  });
});
