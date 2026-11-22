/**
 * ludarr — loads the built-in plugins and whatever sits in <config>/plugins/<name>/ (a folder with an
 * index.ts / index.js, or a package.json whose "main" points at the module; default export = the plugin).
 * A broken plugin is recorded with its error and skipped; it never stops the app.
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configDir } from "../config";
import { logger } from "../log";
import { ensureSingletons, recordPluginFailure, registerPlugin } from "./registry";
import { PLUGIN_API, type LudarrPlugin } from "./types";
import { BUILTIN } from "./builtin";

const log = logger("Plugins");

export async function loadPlugins(): Promise<{ loaded: string[]; failed: { id: string; error: string }[] }> {
  const loaded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const p of BUILTIN) { registerPlugin(p, "builtin"); loaded.push(p.id); }

  const dir = resolve(configDir(), "plugins");
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries.sort()) {
    const folder = join(dir, name);
    if (!(await stat(folder).catch(() => null))?.isDirectory()) continue;
    let entry: string | null = null;
    try {
      const pkg = await Bun.file(join(folder, "package.json")).json().catch(() => null) as { main?: string } | null;
      for (const cand of [pkg?.main, "index.ts", "index.js", "index.mjs"].filter(Boolean) as string[]) {
        if (await Bun.file(join(folder, cand)).exists()) { entry = join(folder, cand); break; }
      }
      if (!entry) throw new Error("no index.ts / index.js / package.json main");
      const mod = await import(pathToFileURL(entry).href) as { default?: LudarrPlugin; plugin?: LudarrPlugin };
      const p = mod.default ?? mod.plugin;
      if (!p || typeof p !== "object" || !p.id) throw new Error("the module's default export is not a plugin");
      if (p.api !== PLUGIN_API) throw new Error(`plugin api ${p.api} is not supported (this ludarr speaks ${PLUGIN_API})`);
      registerPlugin(p, folder);
      loaded.push(p.id);
      log.info(`loaded ${p.id} ${p.version} from ${folder}`);
    } catch (e: any) {
      const error = String(e?.message ?? e);
      recordPluginFailure(name, folder, error);
      failed.push({ id: name, error });
      log.error(`plugin ${name} failed to load: ${error}`);
    }
  }
  ensureSingletons();
  return { loaded, failed };
}
