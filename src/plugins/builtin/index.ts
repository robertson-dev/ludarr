/** The plugins ludarr ships with. They go through the same contract as anything in <config>/plugins. */
import { definePlugin, type LudarrPlugin } from "../types";
import { prowlarr, torznab, newznab } from "./indexers";
import { seedbox, rtorrent, nzbget } from "./clients";
import { metadataDefinitions } from "./metadata";
import { importerDefinitions } from "./importers";
import { runtimeDefinitions } from "./runtimes";
import { notificationDefinitions } from "./notifications";

export const BUILTIN: LudarrPlugin[] = [
  definePlugin({ api: 1, id: "indexers", name: "Indexers", version: "1.0.0", description: "Prowlarr, Torznab and Newznab.", indexers: [prowlarr, torznab, newznab] }),
  definePlugin({ api: 1, id: "download-clients", name: "Download clients", version: "1.0.0", description: "A seedbox over SSH, rTorrent, NZBGet.", downloadClients: [seedbox, rtorrent, nzbget] }),
  definePlugin({ api: 1, id: "catalog", name: "Catalog sources", version: "1.0.0", description: "Steam, IGDB, emulator compatibility lists, the recomp / port registry, scene releases.", metadata: metadataDefinitions }),
  definePlugin({ api: 1, id: "importers", name: "Importers", version: "1.0.0", description: "How a download becomes an installed game: automatic recipes, then the AI importer.", importers: importerDefinitions }),
  definePlugin({ api: 1, id: "runtimes", name: "Runtimes", version: "1.0.0", description: "Emulators and recomp / port builds the catalog can offer.", runtimes: runtimeDefinitions }),
  definePlugin({ api: 1, id: "notifications", name: "Notifications", version: "1.0.0", description: "Webhook, Discord, custom script.", notifications: notificationDefinitions }),
];
