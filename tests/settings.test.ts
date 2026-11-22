import { beforeEach, describe, expect, test } from "bun:test";
import { db, kv, stmts } from "../src/db";
import { cfg, readConfig, writeConfig, CONFIG_KEYS } from "../src/config";
import { settingsApi } from "../src/api/settings";
import { app } from "../src/server";
import { apiKey } from "../src/config";
import { classOfPackage, createProfile, updateProfile, wantsUpgrade, DEFAULT_PROFILE, ensureDefaultProfile } from "../src/library/profiles";
import { listTasks, registerTask } from "../src/tasks";

beforeEach(() => { db.exec("DELETE FROM kv WHERE key LIKE 'cfg.%'"); });

describe("global settings", () => {
  test("every key is read somewhere: no decorative options", async () => {
    const src = (await Promise.all(["src/main.ts", "src/server.ts", "src/fetch.ts", "src/requests.ts", "src/discover.ts", "src/catalog/worker.ts", "src/catalog/github.ts", "src/process/scene.ts", "src/process/runner.ts", "src/plugins/builtin/clients.ts", "src/library/rootfolders.ts", "src/library/games.ts", "src/api/settings.ts", "src/config.ts", "src/rss.ts", "src/crackwatch.ts", "src/ways/program.ts", "src/ways/carry.ts", "src/ways/content.ts", "src/ways/make.ts", "src/ways/asks.ts"].map(f => Bun.file(f).text()))).join("\n");
    const unread = CONFIG_KEYS.map(k => k.key).filter(key => !new RegExp(`cfg(?:Num|Bool|List|Ints)?\\("${key}"\\)|"${key}"`).test(src.replace(/CONFIG_KEYS[\s\S]*?\];/, "")));
    expect(unread).toEqual([]);
  });
  test("basic auth is refused without both credentials; a username + password switch it on; numbers are checked", () => {
    expect(writeConfig({ AUTH_METHOD: "basic" }).errors).toEqual(["Basic authentication needs both a username and a password"]);
    expect(cfg("AUTH_METHOD")).toBe("none");
    const r = writeConfig({ AUTH_USERNAME: "yam", AUTH_PASSWORD: "pw" });
    expect(r.errors).toEqual([]); expect(r.changed.sort()).toEqual(["AUTH_METHOD", "AUTH_PASSWORD", "AUTH_USERNAME"]);
    expect(cfg("AUTH_METHOD")).toBe("basic");
    expect(readConfig("host").find(c => c.key === "AUTH_PASSWORD")).toMatchObject({ value: "••••••••", showIf: { field: "AUTH_METHOD", equals: "basic" } });
    expect(writeConfig({ AUTH_PASSWORD: "••••••••", LOG_LEVEL: "debug" }).changed).toEqual(["LOG_LEVEL"]);   // the mask leaves the secret alone
    expect(cfg("AUTH_PASSWORD")).toBe("pw");
    expect(writeConfig({ PULL_PARALLEL: "many" }).errors).toEqual(["Transfers at once must be a number"]);
    expect(writeConfig({ NOPE: 1 }).rejected).toEqual(["NOPE"]);
  });
  test("the server enforces it: UI prompts, API still takes the key, wrong password refused", async () => {
    writeConfig({ AUTH_USERNAME: "yam", AUTH_PASSWORD: "pw" });
    const basic = (u: string, p: string) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/", { headers: basic("yam", "nope") })).status).toBe(401);
    expect((await app.request("/", { headers: basic("yam", "pw") })).status).toBe(200);
    expect((await app.request("/api/v1/system/status")).status).toBe(401);
    expect((await app.request("/api/v1/system/status", { headers: { "x-api-key": apiKey() } })).status).toBe(200);
    expect((await app.request("/api/v1/system/status", { headers: basic("yam", "pw") })).status).toBe(200);
    expect((await app.request("/api/health")).status).toBe(200);                     // liveness never needs auth
    const r = await settingsApi.request("/api/v1/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ AUTH_METHOD: "basic", AUTH_USERNAME: "" }) });
    expect(r.status).toBe(400);
    writeConfig({ AUTH_METHOD: "none" });
    expect((await app.request("/")).status).toBe(200);
  });
  test("task intervals follow the setting without a restart", () => {
    registerTask({ name: "t-queue", label: "t", intervalSec: () => Number(cfg("QUEUE_POLL_SEC")) || 10, run: async () => {} });
    expect(listTasks().find(t => t.name === "t-queue")!.intervalSec).toBe(10);
    writeConfig({ QUEUE_POLL_SEC: "25" });
    expect(listTasks().find(t => t.name === "t-queue")!.intervalSec).toBe(25);
  });
});

describe("profiles: upgrades", () => {
  test("a copy below the cutoff wants an upgrade only when upgrades are on; the format comes from the release", () => {
    db.exec("DELETE FROM profiles"); ensureDefaultProfile();
    const p = createProfile({ ...DEFAULT_PROFILE, name: "Up", upgrade: true, cutoff: "clean" });
    const iso = { manifest_json: JSON.stringify({ source: { title: "Dave.The.Diver-RUNE (2023) [Windows / Multi-Language / Full ISO]", protocol: "torrent" } }) };
    const clean = { manifest_json: JSON.stringify({ source: { title: "Frosthaven (2026) [Windows / English / Home Rip]", protocol: "torrent" } }) };
    const manual = { manifest_json: JSON.stringify({ source: { title: "Tiny Game-GROUP", protocol: null } }) };
    expect(classOfPackage(iso)).toBe("iso"); expect(classOfPackage(clean)).toBe("clean"); expect(classOfPackage(manual)).toBe("unknown");
    expect(wantsUpgrade(p, "iso")).toBe(true); expect(wantsUpgrade(p, "clean")).toBe(false);
    expect(wantsUpgrade(updateProfile(p.id, { upgrade: false }), "iso")).toBe(false);
    expect(kv.get("cfg.PORT")).toBeNull();
    expect(stmts.profiles.all().length).toBe(2);
  });
});
