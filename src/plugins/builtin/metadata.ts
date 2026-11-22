/**
 * Built-in catalog sources (metadata). Each wraps a catalog provider and, where the source can search,
 * answers "Add new" lookups. All are singletons: enabled by default, configurable where they need keys.
 */
import { customProvider } from "../../catalog/providers/custom";
import { steamProvider } from "../../catalog/providers/steam";
import { COMPAT_PROVIDERS } from "../../catalog/providers/compat";
import { portsProvider } from "../../catalog/providers/ports";
import { portsSeedProvider } from "../../catalog/providers/ports-seed";
import { sceneProvider } from "../../catalog/providers/scene";
import type { Provider } from "../../catalog/types";
import { steamSearch, steamReleaseIso } from "../../steam";
import { IgdbClient, imageUrl } from "../../igdb";
import type { Field, LookupHit, MetadataDefinition, MetadataSource, PluginContext, Settings } from "../types";

const wrap = (p: Provider, extra: Partial<MetadataDefinition> & { fields?: Field[]; make?: (s: Settings, ctx: PluginContext) => Partial<MetadataSource> } = {}): MetadataDefinition => ({
  kind: "metadata", impl: p.id, name: p.label, description: p.about, fields: extra.fields ?? [], infoLink: extra.infoLink,
  // Steam covers the PC games; every other source starts off until it is switched on, unless its definition says otherwise
  defaultEnabled: extra.defaultEnabled ?? p.id === "steam",
  create: (s, ctx) => ({ ...p, ...(extra.make?.(s, ctx) ?? {}) }),
});

/** Steam: storefront feeds + the library, and the store search for "Add new" */
export const steam: MetadataDefinition = wrap(steamProvider, {
  make: () => ({
    async lookup(term): Promise<LookupHit[]> {
      const hits = await steamSearch(term);
      return hits.slice(0, 20).map(h => ({ id: { scheme: "steam", value: String(h.appId) }, name: h.name, year: null, platforms: ["pc"], cover: h.tinyImage ?? null, summary: null, releaseIso: null }));
    },
  }),
});

/** IGDB: metadata for anything (needs a free Twitch developer app) */
export const igdb: MetadataDefinition = {
  kind: "metadata", impl: "igdb", name: "IGDB", defaultEnabled: false,
  description: "Metadata, art and release dates for games on every platform. Needs a free Twitch developer application (client id + secret).",
  infoLink: "https://api-docs.igdb.com/#getting-started",
  fields: [
    { name: "clientId", label: "Twitch client id", type: "text", required: true },
    { name: "clientSecret", label: "Twitch client secret", type: "password", required: true },
  ],
  create(s: Settings): MetadataSource {
    const client = new IgdbClient();
    client.configure(String(s.clientId ?? ""), String(s.clientSecret ?? ""), false);
    return {
      id: "igdb", label: "IGDB", about: "metadata for games on every platform", every: 24 * 60, metaRank: 90,
      ready: () => (client.configured() ? true : "needs a Twitch client id and secret"),
      test: () => client.test(),
      async collect() { return []; },                         // IGDB only answers lookups; it does not list games
      async lookup(term): Promise<LookupHit[]> {
        const rows = await client.search(term, 20);
        return rows.map(g => ({
          id: { scheme: "igdb", value: String(g.id) }, name: g.name, year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
          platforms: (g.platforms ?? []).map(p => p.abbreviation ?? p.name ?? "").filter(Boolean), cover: g.cover?.image_id ? imageUrl(g.cover.image_id, "cover") : null,
          summary: g.summary ?? null, releaseIso: g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : null,
        }));
      },
    };
  },
};

/** the ways to play this server builds: on from the start, or what the admin builds would be missing from the catalog */
export const custom: MetadataDefinition = wrap(customProvider, { defaultEnabled: true });

export const metadataDefinitions: MetadataDefinition[] = [
  custom, steam, igdb,
  wrap(portsProvider),
  ...COMPAT_PROVIDERS.filter(p => p.id !== "emulators").map(p => wrap(p)),
  wrap(portsSeedProvider),
  wrap(sceneProvider),
];

// steamReleaseIso is re-exported for the library's "add" path (release dates for calendar entries)
export { steamReleaseIso };
