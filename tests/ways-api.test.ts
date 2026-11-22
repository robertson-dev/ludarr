import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeBuilds, db, stmts, upsertGame, type GameRow, type JobRow, type RootFolderRow } from "../src/db";
import { apiKey, cfgNum, downloadsDir } from "../src/config";
import { app } from "../src/server";
import { RateLimited } from "../src/catalog/github";
import { runtimeRow } from "../src/catalog/store";
import { ndeps } from "../src/net/public-url";
import * as registry from "../src/plugins/registry";
import { BUILTIN } from "../src/plugins/builtin";
import { enqueueJob } from "../src/process/kinds";
import { runJob } from "../src/process/runner";
import { ensureDefaultRootFolder } from "../src/library/rootfolders";
import { waysApi, wdeps } from "../src/ways/api";
import { ctdeps, STORE } from "../src/ways/content";
import { cpdeps, judgeCopy } from "../src/ways/copy";
import { getPlan, getWay, insertContent, wstmts } from "../src/ways/store";
import { crdeps, getRun } from "../src/ways/carry";
import { atdeps } from "../src/ways/attach";

for (const p of BUILTIN) registry.registerPlugin(p, "builtin");
registry.ensureSingletons();
try { db.exec("ALTER TABLE games ADD COLUMN aliases_json TEXT DEFAULT '[]'"); } catch { /* the manual-games columns are there already */ }

const realW = { ...wdeps }, realC = { ...ctdeps }, realN = { ...ndeps }, realCr = { ...crdeps }, realCp = { ...cpdeps };
const tmp = mkdtempSync(join(tmpdir(), "ways-api-"));
const rootDir = join(tmp, "library"); mkdirSync(rootDir, { recursive: true });
const rootReal = realpathSync(rootDir);
const root: RootFolderRow = { id: 992_000, path: rootDir, name: null, created_at: 0 };
const made = { plans: [] as number[], games: [] as number[], jobs: [] as number[], packages: [] as number[] };
// a way added here fetches no dump list from the network (src/ways/attach.ts addWay)
const local = () => { ctdeps.rootFolders = () => [root]; ctdeps.diskSpace = async () => ({ free: 1e15, total: 2e15 }); atdeps.loadDat = async () => null; };
const realAt = { ...atdeps };
beforeAll(local);
afterEach(() => { Object.assign(wdeps, realW); Object.assign(ctdeps, realC); Object.assign(ndeps, realN); Object.assign(crdeps, realCr); Object.assign(cpdeps, realCp); local(); });
afterAll(() => {
  Object.assign(ctdeps, realC);
  Object.assign(atdeps, realAt);
  db.query("DELETE FROM contents WHERE substr(path, 1, ?)=?").run(rootReal.length, rootReal);
  for (const id of made.jobs) db.query("DELETE FROM jobs WHERE id=?").run(id);
  for (const id of made.packages) db.query("DELETE FROM packages WHERE id=?").run(id);
  for (const id of made.plans) db.query("DELETE FROM runtime_plans WHERE id=?").run(id);
  for (const id of made.games) db.query("DELETE FROM games WHERE id=?").run(id);
  rmSync(tmp, { recursive: true, force: true });
});

/* ─────────── helpers ─────────── */

const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await waysApi.request(path, init);
  return { status: r.status, body: await r.json() };
}
let appid = 992_100;
function game(name: string, aliases: string[] = []): GameRow {
  const g = upsertGame({ steam_appid: ++appid, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
  if (aliases.length) db.query("UPDATE games SET aliases_json=? WHERE id=?").run(JSON.stringify(aliases), g.id);
  made.games.push(g.id);
  return stmts.gameById.get(g.id) as GameRow;
}
/** a library game the test recomp plays: its content plan searches for "Api Test Game", which the game is also called */
const romGame = (name: string) => game(name, ["Api Test Game"]);
function random(n: number, seed = 1) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}
const z64 = (() => { const b = random(16_384, 1234); b.set([0x80, 0x37, 0x12, 0x40], 0); return b; })();
const v64 = (() => { const b = new Uint8Array(z64.length); for (let i = 0; i < b.length; i += 2) { b[i] = z64[i + 1]; b[i + 1] = z64[i]; } return b; })();
const sha1 = (b: Uint8Array) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
const ROM_SHA1 = sha1(z64);
const BIOS = random(4096, 4321);

const recompSpec = (o: Record<string, unknown> = {}) => ({
  program: { kind: "release", assetPattern: "^Apitest-v.*-Windows[.]zip$", channel: "stable" },
  launch: { exe: "Apitest.exe", argv: [] },
  content: { kind: "rom", platform: "n64", what: "the API test ROM", search: ["Api Test Game"], accept: { hashes: [{ algo: "sha1", value: ROM_SHA1 }], formats: ["z64"] }, normalize: "n64-z64", place: "rom.z64" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...o,
});
const emuSpec = (o: Record<string, unknown> = {}) => ({
  program: { kind: "release", assetPattern: "^Apiemu-.*[.]7z$", channel: "stable" },
  launch: { exe: "apiemu.exe", argv: ["-batch", "{content}"] },
  content: { kind: "disc", platform: "ps2", what: "a PS2 disc image", search: ["any"], accept: { hashes: [], formats: ["iso", "chd"] }, place: "discs/{name}" },
  files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "", ...o,
});
const needSpec = () => recompSpec({ needs: [{ kind: "bios", name: "Api BIOS", place: "bios/api.bin", accept: { hashes: [{ algo: "sha1", value: sha1(BIOS) }] } }] });
/** the Kyty make: the app0 folder (sce_sys/param.json and eboot.bin) packed into one .zar with zarchive */
const MAKE = {
  input: { shape: "folder", platform: "ps5", marker: "sce_sys/param.json", also: ["eboot.bin"] },
  steps: [{ pick: { within: "{in}", marker: "sce_sys/param.json", also: ["eboot.bin"], as: "app0" } }, { convert: { with: "zarchive", argv: ["{prep}/app0", "{out}"], timeoutSec: 7200 } }],
  output: { shape: "file", name: "{serial}-app0.zar" },
};

async function newPlan(name: string, o: { kind?: string; spec?: unknown; repo?: string; ready?: boolean } = {}) {
  const r = await call("/api/v1/plan", send("POST", { name, kind: o.kind ?? "recomp", repo: o.repo ?? `https://github.com/apitest/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, spec: o.spec ?? recompSpec() }));
  expect([r.status, r.body.error ?? null]).toEqual([201, null]);
  made.plans.push(r.body.item.id);
  if (o.ready) wstmts.setPlanStatus.run("ready", null, r.body.item.id);
  return r.body.item as { id: number; slug: string; status: string };
}
async function upload(g: GameRow, bytes: BodyInit, name: string, extra = "") {
  return call(`/api/v1/content?gameId=${g.id}&name=${encodeURIComponent(name)}${extra}`, { method: "POST", body: bytes });
}
function addPackage(g: GameRow, manifest: Record<string, unknown>) {
  const p = stmts.insertPackage.get(g.id, null, join(tmp, `pkg-${g.id}`), g.name, null, 1, JSON.stringify({ schema: 1, files: [], ...manifest })) as { id: number };
  made.packages.push(p.id);
  return p.id;
}

/* ─────────── plans ─────────── */

describe("ways API: plans", () => {
  test("a plan is stored as a draft once it passes every check; problems come back as a list", async () => {
    expect((await call("/api/v1/plan", send("POST", { name: "X", kind: "recomp", repo: "not a repo", spec: recompSpec() }))).body.error).toContain("repo:");
    expect((await call("/api/v1/plan", send("POST", { name: "X", kind: "game", repo: "a/b", spec: recompSpec() }))).status).toBe(400);
    expect((await call("/api/v1/plan", send("POST", { name: "", kind: "recomp", repo: "a/b", spec: recompSpec() }))).body.error).toContain("name:");
    const badSpec = await call("/api/v1/plan", send("POST", { name: "X", kind: "recomp", repo: "a/b", spec: recompSpec({ launch: { exe: "run.bat", argv: [] } }) }));
    expect(badSpec.status).toBe(400);
    expect(badSpec.body.errors.join(" ")).toContain("launch.exe");
    expect((await call("/api/v1/plan", send("POST", { name: "X", kind: "recomp", repo: "dolphin:beta", spec: recompSpec() }))).body.error).toContain("needs a GitHub or forgejo repo");
    const p = await newPlan("Api Plan Basics");
    const got = await call(`/api/v1/plan/${p.id}`);
    expect(got.body.item).toMatchObject({ status: "draft", repo: "apitest/api-plan-basics", platforms: ["n64"], waysCount: 0, needs: { met: true, missing: [] }, needSlots: [], ways: [], author: "user" });
    expect((await call("/api/v1/plan")).body.items.some((x: { id: number }) => x.id === p.id)).toBe(true);
    expect(runtimeRow(`plan:${p.slug}`)?.source).toBe("custom");                // the catalog knows it at once
    expect((await call("/api/v1/plan/999999")).status).toBe(404);
  });

  test("a rename keeps the status and the pin; a changed program makes it a draft and drops the pin", async () => {
    const p = await newPlan("Api Plan Edits", { ready: true });
    wstmts.setPinned.run(JSON.stringify({ tag: "v1", asset: "Apitest-v1-Windows.zip", url: "https://x/y.zip", size: 5, sha256: "b".repeat(64), pinnedAt: 1 }), p.id);
    const renamed = await call(`/api/v1/plan/${p.id}`, send("PUT", { name: "Api Plan Edits Renamed", homepage: "https://example.org/" }));
    expect(renamed.body.item).toMatchObject({ name: "Api Plan Edits Renamed", status: "ready", homepage: "https://example.org/", pinned: { tag: "v1" } });
    const changed = await call(`/api/v1/plan/${p.id}`, send("PUT", { spec: recompSpec({ program: { kind: "release", assetPattern: "^Other-.*[.]zip$", channel: "stable" } }) }));
    expect(changed.body.item).toMatchObject({ status: "draft", pinned: null, spec: { program: { assetPattern: "^Other-.*[.]zip$" } } });
    expect((await call(`/api/v1/plan/${p.id}`, send("PUT", { spec: { program: {} } }))).status).toBe(400);
    expect((await call(`/api/v1/plan/${p.id}`, send("PUT", { homepage: "ftp://nope" }))).body.error).toContain("homepage");
  });

  test("delete: refused while ways or system files belong to it; forced, they go with it", async () => {
    const p = await newPlan("Api Plan Delete", { spec: needSpec() });
    const g = romGame("Api Delete Game");
    const w = await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }));
    const bios = await call(`/api/v1/plan/${p.id}/needs/0/file?name=bios.bin`, { method: "POST", body: BIOS });
    expect(bios.status).toBe(201);
    const refused = await call(`/api/v1/plan/${p.id}`, { method: "DELETE" });
    expect(refused).toMatchObject({ status: 409, body: { ways: 1, files: 1 } });
    const forced = await call(`/api/v1/plan/${p.id}?force=1`, { method: "DELETE" });
    expect(forced.body).toMatchObject({ deleted: p.id, ways: [w.body.item.id], files: [bios.body.item.id] });
    expect(getPlan(p.id)).toBeNull();
    expect(getWay(w.body.item.id)).toBeNull();
    expect(existsSync(bios.body.item.path ?? join(rootReal, STORE, `plan-${p.id}`, "bios.bin"))).toBe(false);
    expect(runtimeRow(`plan:${p.slug}`)).toBeFalsy();
  });
});

describe("ways API: checking a plan's program", () => {
  test("the latest release decides: a picked file makes it ready, none makes it broken; the check goes through the address guard", async () => {
    const p = await newPlan("Api Check Release");
    let seen: unknown[] = [];
    wdeps.latestRelease = async (...a) => { seen = a; return { tag: "v1.2", name: "v1.2", date: "2026-10-01", prerelease: false, page: "https://github.com/x", asset: { name: "Apitest-v1.2-Windows.zip", url: "https://github.com/x.zip", size: 100, digest: "sha256:" + "c".repeat(64) } as never }; };
    const ok = await call(`/api/v1/plan/${p.id}/check`, { method: "POST" });
    expect(ok.body).toMatchObject({ picks: true, newer: false, pinned: null, release: { tag: "v1.2", asset: "Apitest-v1.2-Windows.zip", size: 100, digest: "c".repeat(64) }, item: { status: "ready", statusNote: null } });
    expect(seen.slice(0, 3)).toEqual(["apitest/api-check-release", "^Apitest-v.*-Windows[.]zip$", "stable"]);
    expect(seen[3]).toBe(realW.fetch);                                        // the guarded fetch, never the plain one
    expect(JSON.parse(runtimeRow(`plan:${p.slug}`)!.latest_json!).tag).toBe("v1.2");
    wdeps.latestRelease = async () => ({ tag: "v1.3", name: null, date: null, prerelease: false, page: null, asset: null });
    expect((await call(`/api/v1/plan/${p.id}/check`, { method: "POST" })).body.item).toMatchObject({ status: "broken", statusNote: "the plan's asset pattern picks nothing in v1.3" });
    wdeps.latestRelease = async () => null;
    expect((await call(`/api/v1/plan/${p.id}/check`, { method: "POST" })).body.item.statusNote).toBe("no release found for apitest/api-check-release");
    wdeps.latestRelease = async () => { throw new RateLimited("GitHub rate limit (0 left)"); };
    expect(await call(`/api/v1/plan/${p.id}/check`, { method: "POST" })).toEqual({ status: 429, body: { error: "GitHub's hourly limit: set a GitHub token in Settings → General" } });
    wdeps.latestRelease = async () => { throw new Error("HTTP 500 for x"); };
    expect((await call(`/api/v1/plan/${p.id}/check`, { method: "POST" })).status).toBe(502);
  });

  test("a pinned file that changed under its tag breaks the plan; a newer release is reported", async () => {
    const p = await newPlan("Api Check Pinned");
    const pin = { tag: "v1", asset: "Apitest-v1-Windows.zip", url: "https://x/y.zip", size: 100, sha256: "d".repeat(64), pinnedAt: 1 };
    wstmts.setPinned.run(JSON.stringify(pin), p.id);
    const rel = (tag: string, size: number, digest: string) => async () => ({ tag, name: null, date: null, prerelease: false, page: null, asset: { name: `Apitest-${tag}-Windows.zip`, url: "https://x", size, digest } as never });
    wdeps.latestRelease = rel("v1", 100, "sha256:" + "d".repeat(64));
    expect((await call(`/api/v1/plan/${p.id}/check`, { method: "POST" })).body).toMatchObject({ newer: false, item: { status: "ready" } });
    wdeps.latestRelease = rel("v1", 100, "sha256:" + "e".repeat(64));
    expect((await call(`/api/v1/plan/${p.id}/check`, { method: "POST" })).body.item).toMatchObject({ status: "broken", statusNote: "the release file changed since it was pinned; check the plan" });
    wdeps.latestRelease = rel("v1", 101, "");
    expect((await call(`/api/v1/plan/${p.id}/check`, { method: "POST" })).body.item.status).toBe("broken");
    wdeps.latestRelease = rel("v2", 200, "");
    expect((await call(`/api/v1/plan/${p.id}/check`, { method: "POST" })).body).toMatchObject({ newer: true, item: { status: "ready" } });
  });

  test("a forge host that leads into this network is refused before anything is fetched", async () => {
    let fetched = 0;
    ndeps.fetch = async () => { fetched++; return new Response("{}"); };
    ndeps.lookup = async (h: string) => [{ address: h === "evil.example" ? "192.168.1.20" : "140.82.112.3", family: 4 }];
    for (const repo of ["forgejo:evil.example/a/b", "forgejo:169.254.169.254/x/y"]) {
      const p = await newPlan(`Api Check ${repo.length}`, { repo });
      const r = await call(`/api/v1/plan/${p.id}/check`, { method: "POST" });
      expect([repo, r.status]).toEqual([repo, 400]);
      expect(r.body.error).toContain("refused");
      expect(getPlan(p.id)!.status).toBe("draft");
    }
    expect(fetched).toBe(0);
  });

  test("a feed plan reads its feed; a fixed file is asked of its host; a source plan waits for its build", async () => {
    const feed = await newPlan("Api Check Feed", { kind: "emulator", repo: "dolphin-emu/dolphin", spec: emuSpec({ program: { kind: "feed", feed: "dolphin:beta" } }) });
    let repo = "";
    wdeps.latestRelease = async r => { repo = r; return { tag: "2512", name: null, date: null, prerelease: false, page: null, asset: { name: "dolphin.7z", url: "https://dl.dolphin-emu.org/x.7z", size: 0 } }; };
    expect((await call(`/api/v1/plan/${feed.id}/check`, { method: "POST" })).body.item.status).toBe("ready");
    expect(repo).toBe("dolphin:beta");
    const url = await newPlan("Api Check Url", { spec: recompSpec({ program: { kind: "url", url: "https://files.example.org/build/Apitest.zip", sha256: "a".repeat(64) } }) });
    const asked: string[] = [];
    ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
    ndeps.fetch = async (u: string, init?: RequestInit) => { asked.push(`${init?.method} ${u}`); return new Response(null, { status: 200, headers: { "content-length": "1234" } }); };
    const fixed = await call(`/api/v1/plan/${url.id}/check`, { method: "POST" });
    expect(fixed.body).toMatchObject({ picks: true, release: { asset: "Apitest.zip", size: 1234 }, item: { status: "ready" } });
    expect(asked).toEqual(["HEAD https://files.example.org/build/Apitest.zip"]);
    const src = await newPlan("Api Check Source", { spec: recompSpec({ program: { kind: "source", ref: "v1", steps: ["make"], artifact: "build", content: "none" } }) });
    wdeps.buildsDir = () => join(tmp, "builds");
    expect((await call(`/api/v1/plan/${src.id}/check`, { method: "POST" })).body).toMatchObject({ picks: false, item: { status: "draft", statusNote: "builds from source: ready once its build has run" } });
    mkdirSync(join(tmp, "builds"), { recursive: true }); writeFileSync(join(tmp, "builds", "apitest-v1.tar"), "x");
    wstmts.setPinned.run(JSON.stringify({ tag: "v1", asset: "apitest-v1.tar", url: "", size: 1, sha256: "f".repeat(64), pinnedAt: 1 }), src.id);
    expect((await call(`/api/v1/plan/${src.id}/check`, { method: "POST" })).body.item.status).toBe("ready");
  });
});

/* ─────────── ways ─────────── */

describe("ways API: ways", () => {
  test("an emulator way gets this game's own content plan: its names, the plan's place and formats, no hashes", async () => {
    const emu = await newPlan("Api Emu", { kind: "emulator", spec: emuSpec() });
    const g = game("Api God of Jam II", ["God of Jam 2"]);
    const r = await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: emu.id }));
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({
      ownContent: true, status: "needs-files", planKind: "emulator",
      content: { platform: "ps2", what: "Api God of Jam II (PlayStation 2)", search: ["Api God of Jam II", "God of Jam 2"], place: "discs/{name}", accept: { hashes: [], formats: ["iso", "chd"] } },
      blockers: [{ code: "plan" }, { code: "file" }], canBuild: false,
    });
    expect(r.body.warnings.join(" ")).toContain("cannot be verified");
    expect((await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: emu.id }))).body).toMatchObject({ existingId: r.body.item.id });
    expect((await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: 999999 }))).status).toBe(404);
    expect((await call(`/api/v1/game/999999/ways`, send("POST", { planId: emu.id }))).status).toBe(404);
    expect((await call(`/api/v1/game/${g.id}/ways`)).body.items.map((w: { id: number }) => w.id)).toEqual([r.body.item.id]);
  });

  test("a recomp way takes the plan's content plan; overrides and a file kept out of the package are checked", async () => {
    const p = await newPlan("Api Recomp Way");
    const g = romGame("Api Recomp Game");
    expect((await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id, overrides: { env: { "BAD-NAME": "1" } } }))).status).toBe(400);
    const r = await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }));
    expect(r.body.item).toMatchObject({ ownContent: false, status: "needs-files", statusNote: "needs the game file (the API test ROM)", content: { platform: "n64" } });
    const shipless = { ...recompSpec().content, ship: false };
    const emu = await newPlan("Api Shipless Emu", { kind: "emulator", spec: emuSpec() });
    const g2 = game("Api Shipless Game");
    const bad = await call(`/api/v1/game/${g2.id}/ways`, send("POST", { planId: emu.id, content: { ...shipless, platform: "ps2", formats: undefined, accept: { hashes: [] }, normalize: null } }));
    expect(bad.body.error).toContain("content.ship: false");
  });

  test("an upload is kept big-endian and attached to every way it fits; a file kept earlier becomes a new way's", async () => {
    const p1 = await newPlan("Api Attach One", { ready: true }), p2 = await newPlan("Api Attach Two", { ready: true });
    const g = romGame("Api Attach Game");
    const w1 = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p1.id }))).body.item;
    const up = await upload(g, v64, "Attach Game (USA).v64");
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ duplicate: false, attached: [w1.id], checks: [{ wayId: w1.id, ok: true }], item: { name: "Attach Game (USA).z64", platform: "n64", normalized: "n64 byte order v64 → z64", onDisk: true } });
    expect(up.body.item.hashes.sha1).toBe(ROM_SHA1);
    expect(getWay(w1.id)!.status).toBe("ready");
    const w2 = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p2.id }))).body.item;
    expect(w2).toMatchObject({ contentId: up.body.item.id, status: "ready", canBuild: true, fileCheck: { ok: true } });
    expect((await upload(g, v64, "again.v64")).body).toMatchObject({ duplicate: true, item: { id: up.body.item.id } });
    expect((await upload(g, z64, "x.z64", "&platform=sega-cd")).status).toBe(400);
    expect((await call(`/api/v1/content?gameId=${g.id}&name=x.z64`, { method: "POST" })).status).toBe(400);   // no body
  });

  test("PUT: a file that does not fit is refused with the reason; one that fits is attached; a new content plan lets a misfit go", async () => {
    const p = await newPlan("Api Put Way", { ready: true });
    const g = romGame("Api Put Game"), other = game("Api Put Other");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    const wrong = (await upload(g, random(16_384, 9), "wrong.z64")).body.item;
    const r = await call(`/api/v1/way/${w.id}`, send("PUT", { contentId: wrong.id }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(`the file is not the version this needs (its sha1 is ${wrong.hashes.sha1})`);
    const theirs = (await upload(other, z64, "theirs.z64")).body.item;
    expect((await call(`/api/v1/way/${w.id}`, send("PUT", { contentId: theirs.id }))).body.error).toContain("another game");
    const right = (await upload(g, z64, "right.z64")).body.item;
    expect((await call(`/api/v1/way/${w.id}`, send("PUT", { contentId: right.id }))).body.item).toMatchObject({ contentId: right.id, status: "ready" });
    const narrower = { ...recompSpec().content, accept: { hashes: [{ algo: "sha1", value: "1".repeat(40) }], formats: ["z64"] } };
    const moved = await call(`/api/v1/way/${w.id}`, send("PUT", { content: narrower }));
    expect(moved.body.item).toMatchObject({ ownContent: true, contentId: null, status: "needs-files" });
    expect((await call(`/api/v1/way/${w.id}`, send("PUT", { content: null }))).body.item.ownContent).toBe(false);
    expect((await call(`/api/v1/way/${w.id}`, send("PUT", { content: { kind: "rom" } }))).status).toBe(400);
  });

  test("accept-file: the admin's own file joins the way's accepted hashes (and its format) and becomes the way's file", async () => {
    const p = await newPlan("Api Accept Way", { ready: true });
    const g = romGame("Api Accept Game");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    const mine = (await upload(g, random(8192, 77), "my dump.bin")).body.item;
    const r = await call(`/api/v1/way/${w.id}/accept-file`, send("POST", { contentId: mine.id }));
    expect(r.body.verdict).toMatchObject({ ok: true });
    expect(r.body.item).toMatchObject({ contentId: mine.id, status: "ready", ownContent: true, content: { accept: { formats: ["z64", "bin"] } } });
    expect(r.body.item.content.accept.hashes).toContainEqual({ algo: "sha1", value: mine.hashes.sha1, label: "accepted by admin" });
    expect(r.body.item.content.accept.hashes).toContainEqual({ algo: "sha1", value: ROM_SHA1 });          // what the plan accepted still counts
    expect((await call(`/api/v1/way/${w.id}/accept-file`, send("POST", { contentId: 999999 }))).status).toBe(404);
  });

  test("content routes: list a game's files, check one against a way, delete it — the way needs a file again", async () => {
    const p = await newPlan("Api Files Way", { ready: true });
    const g = romGame("Api Files Game");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    const f = (await upload(g, z64, "files.z64")).body.item;
    expect((await call(`/api/v1/content?gameId=${g.id}`)).body.items.map((x: { id: number; onDisk: boolean }) => [x.id, x.onDisk])).toEqual([[f.id, true]]);
    expect((await call(`/api/v1/content/${f.id}/check?wayId=${w.id}`)).body).toMatchObject({ ok: true, against: `way ${w.id}` });
    expect((await call(`/api/v1/content/${f.id}/check`)).status).toBe(400);
    const del = await call(`/api/v1/content/${f.id}`, { method: "DELETE" });
    expect(del.body).toMatchObject({ deleted: f.id, ways: [{ id: w.id, status: "needs-files", contentId: null }] });
    expect(readdirSync(join(rootReal, STORE, "api-files-game"))).toEqual([]);
    expect((await call(`/api/v1/content/${f.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("a file already on the server is taken in by a job; only from the folders ludarr reads", async () => {
    const g = game("Api Path Game");
    const dl = join(downloadsDir(), "ways-api"); mkdirSync(dl, { recursive: true });
    writeFileSync(join(dl, "disc.iso"), random(100));
    const r = await call("/api/v1/content/path", send("POST", { path: join(dl, "disc.iso"), gameId: g.id }));
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({ kind: "content", gameId: g.id, state: "queued", spec: { kind: "content", gameId: g.id, path: realpathSync(join(dl, "disc.iso")), wayId: null } });
    made.jobs.push(r.body.job.id);
    expect(activeBuilds().get(g.id)?.id).toBe(r.body.job.id);              // the game shows as being prepared meanwhile
    writeFileSync(join(tmp, "outside.iso"), "x");
    expect((await call("/api/v1/content/path", send("POST", { path: join(tmp, "outside.iso"), gameId: g.id }))).status).toBe(403);
    expect((await call("/api/v1/content/path", send("POST", { path: dl, gameId: g.id }))).status).toBe(400);
    expect((await call("/api/v1/content/path", send("POST", { path: join(dl, "disc.iso"), gameId: 999999 }))).status).toBe(404);
    stmts.setJobFailed.run("cancelled", "test", r.body.job.id);
  });

  test("a file taken in from the server for a way says so when it is not that way's file (admin-ui-15)", async () => {
    ensureDefaultRootFolder();
    const p = await newPlan("Api Path Misfit", { ready: true });
    const g = romGame("Api Path Misfit Game");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    const dl = join(downloadsDir(), "ways-api-misfit"); mkdirSync(dl, { recursive: true });
    const take = async (name: string, bytes: Uint8Array) => {
      writeFileSync(join(dl, name), bytes);
      const r = await call("/api/v1/content/path", send("POST", { path: join(dl, name), gameId: g.id, wayId: w.id }));
      expect(r.status).toBe(202);
      made.jobs.push(r.body.job.id);
      await runJob(r.body.job.id);
      return stmts.jobById.get(r.body.job.id) as JobRow;
    };
    const other = random(16_384, 33);
    const misfit = await take("Super Mario 64 (USA).z64", other);
    expect(misfit.state).toBe("done");
    expect(misfit.message).toBe(`kept Super Mario 64 (USA).z64 (16 KB) — not the file Api Path Misfit needs: not the version this needs (its sha1 is ${sha1(other)})`);
    expect(getWay(w.id)!.content_id).toBeNull();
    // the same file again: already kept, and still not this way's
    expect((await take("again.z64", other)).message).toBe(`already kept as Super Mario 64 (USA).z64 — not the file Api Path Misfit needs: not the version this needs (its sha1 is ${sha1(other)})`);
    // the way's own file: kept and attached, nothing more to say
    const fits = await take("right.z64", z64);
    expect(fits.message).toBe("kept right.z64 (16 KB)");
    expect(getWay(w.id)!.content_id).not.toBeNull();
  });
});

describe("ways API: a recomp or port plan is for the game it plays (admin-ui-13, e2e-3)", () => {
  test("another library game is refused (409, wrongGame) unless forced; the game by another of its names takes it; an emulator plays any", async () => {
    const recomp = await newPlan("Api Wrong Game Recomp", { ready: true });               // its content plan searches for "Api Test Game"
    const port = await newPlan("Api Wrong Game Port", { kind: "port", ready: true });
    const hollow = game("Api Hollow Game");
    for (const p of [recomp, port]) {
      const r = await call(`/api/v1/game/${hollow.id}/ways`, send("POST", { planId: p.id }));
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: `Api Wrong Game ${p.id === recomp.id ? "Recomp" : "Port"} plays Api Test Game, and Api Hollow Game does not look like that game`, wrongGame: true });
    }
    expect((await call(`/api/v1/game/${hollow.id}/ways`)).body.items).toEqual([]);
    // its own name, written another way, or one of its other names: that game
    expect((await call(`/api/v1/game/${game("The Api Test Game").id}/ways`, send("POST", { planId: recomp.id }))).status).toBe(201);
    expect((await call(`/api/v1/game/${romGame("Api Test Game Deluxe Edition Box").id}/ways`, send("POST", { planId: recomp.id }))).status).toBe(201);
    // the admin's say-so
    const forced = await call(`/api/v1/game/${hollow.id}/ways`, send("POST", { planId: recomp.id, force: true }));
    expect(forced.status).toBe(201);
    // an emulator's plan is a template for every game of its platform
    const emu = await newPlan("Api Wrong Game Emu", { kind: "emulator", spec: emuSpec() });
    expect((await call(`/api/v1/game/${hollow.id}/ways`, send("POST", { planId: emu.id }))).status).toBe(201);
  });
});

/* ─────────── needs, builds ─────────── */

describe("ways API: needs and builds", () => {
  test("a need slot takes only its file, by upload or from the server; the plan's ways follow", async () => {
    const p = await newPlan("Api Needs Plan", { spec: needSpec(), ready: true });
    const g = romGame("Api Needs Game");
    await upload(g, z64, "needs.z64");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    expect(w).toMatchObject({ status: "needs-files", statusNote: "needs Api BIOS", needs: { met: false, missing: [{ index: 0, name: "Api BIOS" }] } });
    const wrong = await call(`/api/v1/plan/${p.id}/needs/0/file?name=bios.bin`, { method: "POST", body: random(4096, 3) });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toContain("not the Api BIOS this needs");
    const ok = await call(`/api/v1/plan/${p.id}/needs/0/file?name=bios.bin`, { method: "POST", body: BIOS });
    expect(ok.body).toMatchObject({ item: { role: "system", planId: p.id, needIndex: 0 }, plan: { needs: { met: true }, needSlots: [{ index: 0, name: "Api BIOS", ok: true }] } });
    expect(getWay(w.id)!.status).toBe("ready");
    expect((await call(`/api/v1/plan/${p.id}/needs/4/file?name=x`, { method: "POST", body: BIOS })).status).toBe(404);
    expect((await call(`/api/v1/content?planId=${p.id}`)).body.items.map((x: { id: number }) => x.id)).toEqual([ok.body.item.id]);
    expect((await call(`/api/v1/content/${ok.body.item.id}/check`)).body).toMatchObject({ ok: true, against: "need 0" });
    const dl = join(downloadsDir(), "ways-api"); mkdirSync(dl, { recursive: true }); writeFileSync(join(dl, "bios2.bin"), BIOS);
    const job = await call(`/api/v1/plan/${p.id}/needs/0/path`, send("POST", { path: join(dl, "bios2.bin") }));
    expect(job.body.job).toMatchObject({ kind: "content", gameId: null, spec: { planId: p.id, needIndex: 0, gameId: null } });
    made.jobs.push(job.body.job.id);
  });

  test("build: refused while the plan is unchecked, a need is unmet or there is no game file; a PC copy needs replace", async () => {
    const p = await newPlan("Api Build Plan");
    const g = romGame("Api Build Game");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    const blocked = await call(`/api/v1/way/${w.id}/build`, send("POST", {}));
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers.map((b: { code: string }) => b.code)).toEqual(["plan", "file"]);
    expect(blocked.body.error).toBe("the plan has not been checked yet: check it first; there is no game file yet (the API test ROM)");
    wstmts.setPlanStatus.run("ready", null, p.id);
    await upload(g, z64, "build.z64");
    const native = addPackage(g, { kind: "native" });
    expect((await call(`/api/v1/way/${w.id}/build`, send("POST", {}))).body).toEqual({ error: "the game has a PC copy, and building this way replaces it: build with replace to go ahead", current: "native" });
    const go = await call(`/api/v1/way/${w.id}/build`, send("POST", { replace: true, repin: true }));
    expect(go.status).toBe(202);
    expect(go.body.job).toMatchObject({ kind: "assemble", gameId: g.id, inputPath: `way:${w.id}`, spec: { kind: "assemble", wayId: w.id, replace: true, repin: true } });
    made.jobs.push(go.body.job.id);
    // while it is queued the way is the job's
    expect((await call(`/api/v1/way/${w.id}/build`, send("POST", { replace: true }))).body.blockers.map((b: { code: string }) => b.code)).toEqual(["building"]);
    expect((await call(`/api/v1/way/${w.id}`, send("PUT", { overrides: {} }))).status).toBe(409);
    expect((await call(`/api/v1/way/${w.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await call(`/api/v1/game/${g.id}/ways`)).body.items[0]).toMatchObject({ job: { id: go.body.job.id }, replaces: "native" });
    stmts.setJobFailed.run("cancelled", "test", go.body.job.id);
    db.query("DELETE FROM packages WHERE id=?").run(native);
  });

  test("a game whose copy is a console dump: the dump stands in for the game file when the copy, judged in place, is it", async () => {
    const p = await newPlan("Api Dump Plan", { ready: true });
    const g = romGame("Api Dump Game");
    addPackage(g, { kind: "rom", platform: "n64", launch: { exe: "dump.z64", args: "", cwd: "" } });
    // the copy is judged where it lies (src/ways/copy.ts): its dump is on disk, and looked at before the way is added
    mkdirSync(join(tmp, `pkg-${g.id}`), { recursive: true }); writeFileSync(join(tmp, `pkg-${g.id}`, "dump.z64"), z64);
    await judgeCopy(g.id);
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    expect(w).toMatchObject({ status: "ready", contentId: null, fromConsoleCopy: true, canBuild: true, replaces: "rom", copy: { serves: "direct", name: "dump.z64" } });
    const go = await call(`/api/v1/way/${w.id}/build`, send("POST", {}));
    expect(go.status).toBe(202);
    expect(go.body.job).toMatchObject({ kind: "assemble", spec: { kind: "assemble", wayId: w.id } });
    made.jobs.push(go.body.job.id);
    stmts.setJobFailed.run("cancelled", "test", go.body.job.id);
  });
});

/* ─────────── the game's copy, honestly (the live bug) ─────────── */

describe("ways API: the game's copy is judged before Build says it can", () => {
  const SEALED = "the retail disc as a PC drive reads it (US, PPSA01342, 1.00): its game data is encrypted for the console, and nothing can open it";
  const ISO = 54.2e9;
  /** way 1 as it is live: an emulator way of Demon's Souls that takes one .zar of PPSA01341; the game's copy a 54 GB .iso,
   *  and a second copy of it kept in the content store (content row 1, source 'package') */
  async function demonsSouls(name: string) {
    const kyty = await newPlan(`KytyPS5 ${name}`, { kind: "emulator", spec: emuSpec({ content: { kind: "disc", platform: "ps5", what: "a PS5 game", search: ["any"], accept: { hashes: [], formats: ["zar"] }, place: "game/{name}" } }), ready: true });
    const g = game(`Demon's Souls ${name}`);
    db.query("UPDATE games SET platforms_json=? WHERE id=?").run(JSON.stringify(["PS5"]), g.id);
    const pkgDir = join(tmp, `pkg-ds-${g.id}`);
    mkdirSync(join(pkgDir, "bbb-ps5-01342"), { recursive: true });
    writeFileSync(join(pkgDir, "bbb-ps5-01342", "bbb-ps5-01342.iso"), "iso");
    const manifest = { schema: 1, kind: "rom", platform: "ps5", launch: { exe: "bbb-ps5-01342/bbb-ps5-01342.iso", args: "", cwd: "" }, files: [{ path: "bbb-ps5-01342/bbb-ps5-01342.iso", size: ISO, sha256: "a".repeat(64) }], source: { title: "Demons.Souls.PS5-BigBlueBox (2020) [PlayStation 5 / Multi-Language / USA / Full ISO]" } };
    const pkg = stmts.insertPackage.get(g.id, null, pkgDir, g.name, null, ISO, JSON.stringify(manifest)) as { id: number };
    made.packages.push(pkg.id);
    const store = join(rootReal, STORE, `ds-${g.id}`);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "bbb-ps5-01342.iso"), "iso");
    const row = insertContent({ gameId: g.id, platform: "ps5", name: "bbb-ps5-01342.iso", path: join(store, "bbb-ps5-01342.iso"), size: ISO, hashes: { sha1: "b".repeat(40), sha256: "a".repeat(64) }, source: "package" });
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: kyty.id }))).body.item;
    expect(w.content).toMatchObject({ platform: "ps5", accept: { formats: ["zar"] } });
    return { g, kyty, w, pkg, row };
  }

  test("way 1: a 54 GB .iso copy and a way that takes .zar — canBuild is false with the copy's own words, nothing is queued", async () => {
    const judged: number[] = [];
    let verdict: { serves: "unknown" | "no"; why: string } = { serves: "unknown", why: "looking at the game's copy" };
    crdeps.copyServes = () => verdict;
    crdeps.judgeCopy = async gameId => { judged.push(gameId); return null; };
    cpdeps.judgeSoon = () => {};   // the files here are stand-ins: the copy is judged only through the fake above
    const { g, w, row } = await demonsSouls("live");
    // not judged yet: the way says it is being looked at, and the listing has it judged (small reads, in the background)
    const first = (await call(`/api/v1/game/${g.id}/ways`)).body.items[0];
    expect(first).toMatchObject({ canBuild: false, fromConsoleCopy: false, copy: { serves: "unknown", name: "bbb-ps5-01342.iso", size: ISO } });
    expect(first.blockers).toContainEqual({ code: "file", error: "looking at the game's copy" });
    await Bun.sleep(5);
    expect(judged).toContain(g.id);
    // judged: the sealed retail disc, in its own words; the Build button stays off and a press is refused
    verdict = { serves: "no", why: SEALED };
    const item = (await call(`/api/v1/game/${g.id}/ways`)).body.items[0];
    const words = `there is no game file yet (${w.content.what}): the game's copy on the server (bbb-ps5-01342.iso, 54.2 GB) is ${SEALED}`;
    expect(item).toMatchObject({ canBuild: false, fromConsoleCopy: false, copy: { packageId: expect.any(Number), name: "bbb-ps5-01342.iso", size: ISO, serves: "no", why: SEALED } });
    expect(item.blockers).toEqual([{ code: "file", error: words }]);
    const before = (db.query("SELECT COUNT(*) AS n FROM jobs WHERE game_id=?").get(g.id) as { n: number }).n;
    const press = await call(`/api/v1/way/${w.id}/build`, send("POST", {}));
    expect(press.status).toBe(409);
    expect(press.body.error).toBe(words);
    expect((db.query("SELECT COUNT(*) AS n FROM jobs WHERE game_id=?").get(g.id) as { n: number }).n).toBe(before);
    // the kept second copy is not touched
    expect(stmts.jobById.get(-1)).toBeNull();
    expect((db.query("SELECT size, source FROM contents WHERE id=?").get(row.id) as { size: number; source: string })).toEqual({ size: ISO, source: "package" });
  });

  test("one press builds: a make from the copy, a make from a kept dump, the program built for this game first", async () => {
    // the copy is what the way's file is made from
    const a = await demonsSouls("make-copy");
    crdeps.copyServes = gameId => (gameId === a.g.id ? { serves: "make", why: "made from the game folder" } : { serves: "no", why: "not it" });
    await call(`/api/v1/way/${a.w.id}`, send("PUT", { content: { ...a.w.content, make: MAKE } }));
    const viewA = (await call(`/api/v1/game/${a.g.id}/ways`)).body.items[0];
    expect(viewA).toMatchObject({ canBuild: true, blockers: [], copy: { serves: "make" } });
    const goA = await call(`/api/v1/way/${a.w.id}/build`, send("POST", {}));
    expect([goA.status, goA.body.job?.kind]).toEqual([202, "make"]);
    expect(goA.body.job.spec).toEqual({ kind: "make", wayId: a.w.id, from: "copy", packageId: a.pkg.id, then: "assemble" });
    made.jobs.push(goA.body.job.id);
    // while it runs the way says its file is being made
    expect((await call(`/api/v1/game/${a.g.id}/ways`)).body.items[0].blockers).toContainEqual({ code: "building", error: "its game file is being made" });
    stmts.setJobFailed.run("cancelled", "test", goA.body.job.id);
    // a kept dump is what it is made from
    const b = await demonsSouls("make-kept");
    crdeps.copyServes = () => ({ serves: "no", why: SEALED });
    await call(`/api/v1/way/${b.w.id}`, send("PUT", { content: { ...b.w.content, make: MAKE } }));
    const dumpDir = join(rootReal, STORE, `ds-dump-${b.g.id}`);
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "PPSA01341-app0"), "folder");
    const dump = insertContent({ gameId: b.g.id, platform: "ps5", name: "PPSA01341-app0", path: join(dumpDir, "PPSA01341-app0"), size: 9e10, hashes: {}, source: "inbox", shape: "folder" });
    crdeps.inputMatches = (_i, row) => (row.id === dump.id ? { ok: true, why: null } : { ok: false, why: "not the game folder" });
    const goB = await call(`/api/v1/way/${b.w.id}/build`, send("POST", {}));
    expect([goB.status, goB.body.job?.spec]).toEqual([202, { kind: "make", wayId: b.w.id, from: "kept", contentId: dump.id, then: "assemble" }]);
    made.jobs.push(goB.body.job.id);
    stmts.setJobFailed.run("cancelled", "test", goB.body.job.id);
    // a plan whose program is built for each game: that build first, then the assemble
    const p = await newPlan("Api Per Game Build", { ready: true });
    const g = romGame("Api Per Game Build Game");
    await upload(g, z64, "pergame.z64");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    crdeps.wayBuildNeeded = (_p, way) => way.id === w.id;
    const goC = await call(`/api/v1/way/${w.id}/build`, send("POST", {}));
    expect([goC.status, goC.body.job?.spec]).toEqual([202, { kind: "build", planId: p.id, wayId: w.id, then: "assemble" }]);
    made.jobs.push(goC.body.job.id);
    stmts.setJobFailed.run("cancelled", "test", goC.body.job.id);
  });

  test("one press over a PC copy, with replace: the make or the per-way build queued first carries replace to the assemble it queues", async () => {
    const b = await demonsSouls("make-kept-replace");
    crdeps.copyServes = () => ({ serves: "no", why: SEALED });
    await call(`/api/v1/way/${b.w.id}`, send("PUT", { content: { ...b.w.content, make: MAKE } }));
    const dumpDir = join(rootReal, STORE, `ds-dump-r-${b.g.id}`);
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "PPSA01341-app0"), "folder");
    const dump = insertContent({ gameId: b.g.id, platform: "ps5", name: "PPSA01341-app0", path: join(dumpDir, "PPSA01341-app0"), size: 9e10, hashes: {}, source: "inbox", shape: "folder" });
    crdeps.inputMatches = (_i, row) => (row.id === dump.id ? { ok: true, why: null } : { ok: false, why: "not the game folder" });
    addPackage(b.g, { kind: "native", launch: { exe: "DemonsSouls.exe", args: "", cwd: "" } });
    expect((await call(`/api/v1/way/${b.w.id}/build`, send("POST", {}))).status).toBe(409);
    const go = await call(`/api/v1/way/${b.w.id}/build`, send("POST", { replace: true }));
    expect([go.status, go.body.job?.spec]).toEqual([202, { kind: "make", wayId: b.w.id, from: "kept", contentId: dump.id, then: "assemble", replace: true }]);
    made.jobs.push(go.body.job.id);
    stmts.setJobFailed.run("cancelled", "test", go.body.job.id);
    // a plan whose program is built for each game: that build first, then the assemble that replaces the PC copy
    const p = await newPlan("Api Replace Per Game", { ready: true });
    const g = romGame("Api Replace Per Game Game");
    await upload(g, z64, "pergame-replace.z64");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    addPackage(g, { kind: "native" });
    crdeps.wayBuildNeeded = (_p, way) => way.id === w.id;
    const goC = await call(`/api/v1/way/${w.id}/build`, send("POST", { replace: true }));
    expect([goC.status, goC.body.job?.spec]).toEqual([202, { kind: "build", planId: p.id, wayId: w.id, then: "assemble", replace: true }]);
    made.jobs.push(goC.body.job.id);
    stmts.setJobFailed.run("cancelled", "test", goC.body.job.id);
  });

  test("the copy's verdict is copy.ts's: api.ts never asks the old romCopyServes", async () => {
    const src = await Bun.file(join(import.meta.dir, "..", "src", "ways", "api.ts")).text();
    expect(src).not.toContain("romCopyServes");
  });
});

/* ─────────── ways and their carry runs ─────────── */

describe("ways API: a way is carried through, and its runs stop with it", () => {
  test("a way added starts its run; deleting the way stops it (the run never adds the way back)", async () => {
    const p = await newPlan("Api Carried Way", { ready: true });
    const g = romGame("Api Carried Game");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    expect(w.run).toMatchObject({ phase: "plan", state: "active", ask: null });
    const runId = w.run.id as number;
    expect(getRun(runId)).toMatchObject({ way_id: w.id, game_id: g.id, plan_id: p.id, started_by: "way" });
    expect((await call(`/api/v1/way/${w.id}`, { method: "DELETE" })).status).toBe(200);
    const stopped = getRun(runId)!;
    expect(stopped.state).toBe("stopped");
    expect(JSON.parse(stopped.steps_json).at(-1).text).toBe("stopped: the way was removed");
  });

  test("deleting a plan stops its runs first: the jobs they started are cancelled, not left running for a plan that is gone", async () => {
    const p = await newPlan("Api Removed Plan", { ready: true });
    const g = romGame("Api Removed Plan Game");
    const w = (await call(`/api/v1/game/${g.id}/ways`, send("POST", { planId: p.id }))).body.item;
    const runId = w.run.id as number;
    const job = enqueueJob({ kind: "make", wayId: w.id, from: "kept", contentId: 1, runId }, { gameId: g.id, runId });
    made.jobs.push(job.id);
    expect((await call(`/api/v1/plan/${p.id}?force=1`, { method: "DELETE" })).status).toBe(200);
    expect(stmts.jobById.get(job.id)).toMatchObject({ state: "cancelled", message: "cancelled: the carry run stopped (the plan was removed)" });
    expect(getRun(runId)).toBeNull();
  });

  test("the admin's cancel of a job is the admin's: its run is held, not undone", async () => {
    const a = enqueueJob({ kind: "assemble", wayId: 424243 });
    made.jobs.push(a.id);
    expect((await call(`/api/v1/jobs/${a.id}/cancel`, { method: "POST" })).body.item).toMatchObject({ state: "cancelled", message: "cancelled by the admin" });
  });
});

/* ─────────── jobs, auth, big uploads ─────────── */

describe("ways API: jobs", () => {
  test("every kind listed, newest first; a queued job is cancelled, a running one stopped, a finished one left alone", async () => {
    const a = enqueueJob({ kind: "assemble", wayId: 424242 }), b = enqueueJob({ kind: "content", gameId: null, path: "/nowhere" });
    made.jobs.push(a.id, b.id);
    const all = (await call("/api/v1/jobs")).body.items.map((j: { id: number }) => j.id);
    expect(all.indexOf(b.id)).toBeLessThan(all.indexOf(a.id));
    expect((await call("/api/v1/jobs?kind=assemble")).body.items.every((j: { kind: string }) => j.kind === "assemble")).toBe(true);
    expect((await call("/api/v1/jobs?kind=bogus")).status).toBe(400);
    expect((await call(`/api/v1/jobs/${a.id}/cancel`, { method: "POST" })).body.item).toMatchObject({ id: a.id, state: "cancelled", message: "cancelled by the admin" });
    stmts.setJob.run("running", null, 0.5, "copying", b.id);
    const stopped: number[] = [];
    wdeps.cancelRunning = id => { stopped.push(id); return true; };
    expect((await call(`/api/v1/jobs/${b.id}/cancel`, { method: "POST" })).status).toBe(202);
    expect(stopped).toEqual([b.id]);
    expect((await call(`/api/v1/jobs/${a.id}/cancel`, { method: "POST" })).status).toBe(409);
    expect((await call("/api/v1/jobs/999999/cancel", { method: "POST" })).status).toBe(404);
    stmts.setJobFailed.run("cancelled", "test", b.id);
  });
});

describe("ways API: behind the API key", () => {
  test("every ways route wants the key", async () => {
    expect((await app.request("/api/v1/plan")).status).toBe(401);
    expect((await app.request("/api/v1/content?gameId=1&name=x.iso", { method: "POST", body: "x" })).status).toBe(401);
    expect((await app.request("/api/v1/jobs")).status).toBe(401);
    expect((await app.request("/api/v1/plan", { headers: { "x-api-key": apiKey() } })).status).toBe(200);
  });

  test("a disc larger than Bun's default request limit streams through the server, with the limit from CONTENT_UPLOAD_MAX_GB", async () => {
    const g = game("Api Big Disc");
    const size = 130 * 2 ** 20, piece = random(2 ** 20, 5);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120, maxRequestBodySize: Math.max(1, cfgNum("CONTENT_UPLOAD_MAX_GB", 16)) * 2 ** 30 });
    try {
      let sent = 0;
      const want = new Bun.CryptoHasher("sha1");
      const body = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= size) return c.close(); want.update(piece); c.enqueue(piece); sent += piece.length; } });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/content?gameId=${g.id}&name=Big%20Disc.iso`, { method: "POST", body, headers: { "x-api-key": apiKey() } });
      const j = await res.json() as any;
      expect([res.status, j.error ?? null]).toEqual([201, null]);
      expect(j.item.size).toBe(size);
      expect(j.item.hashes.sha1).toBe(want.digest("hex"));
    } finally { server.stop(true); }
  }, 60_000);
});
