/** ludarr — "Connect": fan an event out to every enabled notification whose switch for it is on. */
import { logger } from "./log";
import * as registry from "./plugins/registry";
import { EVENT_SWITCH } from "./plugins/builtin/notifications";
import type { Notification, NotifyEvent } from "./plugins/types";

const log = logger("Notify");

export async function notify(event: NotifyEvent, n: Notification): Promise<void> {
  for (const { row, notifier } of registry.notifiers()) {
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(row.settings_json); } catch { /* defaults */ }
    const sw = EVENT_SWITCH[event];
    if (sw && settings[sw] === false) continue;
    try { await notifier.send(event, n); }
    catch (e: any) { log.warn(`${row.name}: ${e?.message ?? e}`); }
  }
}
