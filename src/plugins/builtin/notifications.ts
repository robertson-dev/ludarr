/** Built-in notifications ("Connect"): a JSON webhook, a Discord webhook, a script on this machine. */
import type { Field, Notification, Notifier, NotificationDefinition, NotifyEvent, PluginContext, Settings } from "../types";
import { withFormerEnv } from "../../former";

/** every notification gets the same event switches; the dispatcher reads them from the instance settings */
export const EVENT_FIELDS: Field[] = [
  { name: "onGrab", label: "On grab", type: "checkbox", default: true, helpText: "a release was sent to a download client" },
  { name: "onDownload", label: "On import", type: "checkbox", default: true, helpText: "a game was imported and is ready" },
  { name: "onUpgrade", label: "On upgrade", type: "checkbox", default: true },
  { name: "onFailed", label: "On failure", type: "checkbox", default: true, helpText: "a download or import failed for good" },
  { name: "onDelete", label: "On delete", type: "checkbox", default: false },
  { name: "onHealth", label: "On health issue", type: "checkbox", default: true },
];
export const EVENT_SWITCH: Record<NotifyEvent, string> = { grab: "onGrab", download: "onDownload", upgrade: "onUpgrade", failed: "onFailed", delete: "onDelete", health: "onHealth", test: "" };

const COLORS: Record<NotifyEvent, number> = { grab: 0x5d9cec, download: 0x00853d, upgrade: 0x00853d, failed: 0xf05050, delete: 0x888888, health: 0xffa500, test: 0x7a43b6 };

export const webhook: NotificationDefinition = {
  kind: "notification", impl: "webhook", name: "Webhook",
  description: "POSTs a JSON body { event, title, message, game, release, data } to a URL.",
  fields: [
    { name: "url", label: "URL", type: "url", required: true },
    { name: "method", label: "Method", type: "select", default: "POST", options: [{ value: "POST", label: "POST" }, { value: "PUT", label: "PUT" }] },
    { name: "username", label: "Basic auth user", type: "text", default: "", advanced: true },
    { name: "password", label: "Basic auth password", type: "password", advanced: true },
    ...EVENT_FIELDS,
  ],
  create(s: Settings, ctx: PluginContext): Notifier {
    const send = async (event: NotifyEvent, n: Notification) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (s.username) headers.authorization = "Basic " + Buffer.from(`${s.username}:${s.password ?? ""}`).toString("base64");
      const res = await ctx.fetch(String(s.url), { method: String(s.method || "POST"), headers, body: JSON.stringify({ event, title: n.title, message: n.message, game: n.gameName ?? null, gameId: n.gameId ?? null, release: n.release ?? null, data: n.data ?? {}, at: new Date().toISOString() }), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
    };
    return { send, test: async () => { await send("test", { title: "ludarr test", message: "If you can read this, the webhook works." }); return { ok: true, detail: "sent" }; } };
  },
};

export const discord: NotificationDefinition = {
  kind: "notification", impl: "discord", name: "Discord",
  description: "Posts an embed to a Discord channel webhook.",
  infoLink: "https://support.discord.com/hc/en-us/articles/228383668",
  fields: [
    { name: "webhookUrl", label: "Webhook URL", type: "url", required: true, placeholder: "https://discord.com/api/webhooks/…" },
    { name: "username", label: "Bot name", type: "text", default: "ludarr" },
    ...EVENT_FIELDS,
  ],
  create(s: Settings, ctx: PluginContext): Notifier {
    const send = async (event: NotifyEvent, n: Notification) => {
      const res = await ctx.fetch(String(s.webhookUrl), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: String(s.username || "ludarr"), embeds: [{ title: n.title, description: n.message.slice(0, 1900), color: COLORS[event], timestamp: new Date().toISOString(), footer: { text: `ludarr · ${event}` } }] }),
        signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Discord answered HTTP ${res.status}`);
    };
    return { send, test: async () => { await send("test", { title: "ludarr test", message: "If you can read this, the Discord webhook works." }); return { ok: true, detail: "sent" }; } };
  },
};

export const script: NotificationDefinition = {
  kind: "notification", impl: "script", name: "Custom script",
  description: "Runs a script with the event in environment variables (LUDARR_EVENT, LUDARR_TITLE, LUDARR_MESSAGE, LUDARR_GAME, LUDARR_GAME_ID, LUDARR_RELEASE).",
  fields: [
    { name: "path", label: "Script path", type: "path", required: true, helpText: "inside the container: put scripts under /config/scripts" },
    { name: "args", label: "Arguments", type: "text", default: "", advanced: true },
    ...EVENT_FIELDS,
  ],
  create(s: Settings): Notifier {
    const send = async (event: NotifyEvent, n: Notification) => {
      const p = Bun.spawn([String(s.path), ...String(s.args ?? "").split(/\s+/).filter(Boolean)], {
        // (a script written for the engine's old name finds its variables under that name too)
        env: { ...process.env, ...withFormerEnv({ LUDARR_EVENT: event, LUDARR_TITLE: n.title, LUDARR_MESSAGE: n.message, LUDARR_GAME: n.gameName ?? "", LUDARR_GAME_ID: String(n.gameId ?? ""), LUDARR_RELEASE: n.release ?? "", LUDARR_DATA: JSON.stringify(n.data ?? {}) }) },
        stdout: "pipe", stderr: "pipe",
      });
      const code = await Promise.race([p.exited, new Promise<number>(r => setTimeout(() => { p.kill(); r(-1); }, 60_000))]);
      if (code !== 0) throw new Error(`script exited with ${code}: ${(await new Response(p.stderr).text()).trim().slice(-300)}`);
    };
    return { send, test: async () => { await send("test", { title: "ludarr test", message: "test" }); return { ok: true, detail: "the script ran and exited 0" }; } };
  },
};

export const notificationDefinitions: NotificationDefinition[] = [webhook, discord, script];
