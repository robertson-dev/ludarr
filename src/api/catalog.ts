/**
 * ludarr API — the catalog: every game the metadata sources know and every way to play it on a Windows PC.
 *
 *   GET  /api/v1/catalog/vocab                       platforms, route kinds, provenances, compatibility ladder
 *   GET  /api/v1/catalog/facets                      counts per kind / platform / provenance / runtime / status
 *   GET  /api/v1/catalog/titles                      ?q= &kind= &platform= &provenance= &runtime= &status= &library=1 &sort= &limit= &offset= &all=1
 *   GET  /api/v1/catalog/titles/:idOrSlug            metadata, external ids, routes best-first
 *   GET  /api/v1/catalog/runtimes  ·  /runtimes/:id  ·  POST /api/v1/catalog/runtimes/refresh
 *   GET  /api/v1/catalog/sources                     metadata sources: last run, counts, last error
 *   POST /api/v1/catalog/sources/:id/refresh         run one now
 */
import { Hono } from "hono";
import { facets, getTitle, queryTitles, runtimeRow, runtimeRows, serializeRuntime, sourceRows, type TitleQuery } from "../catalog/store";
import { cdeps, refreshRuntimes, runSource, sourceById, activeSources } from "../catalog/worker";
import { PLATFORMS, PROVENANCES, ROUTE_KINDS, STATUS_ORDER } from "../catalog/types";

export const catalogApi = new Hono();

catalogApi.get("/api/v1/catalog/vocab", c => c.json({ platforms: PLATFORMS, kinds: ROUTE_KINDS, provenances: PROVENANCES, statuses: STATUS_ORDER }));
catalogApi.get("/api/v1/catalog/facets", c => c.json(facets(activeSources())));

catalogApi.get("/api/v1/catalog/titles", c => {
  const p = (k: string) => c.req.query(k) || undefined;
  const sort = p("sort");
  const f: TitleQuery = {
    q: p("q"), kind: p("kind"), platform: p("platform"), provenance: p("provenance"), runtime: p("runtime"), status: p("status"),
    library: p("library") === "1", all: p("all") === "1",
    sort: sort === "year" || sort === "updated" || sort === "status" || sort === "name" ? sort : undefined,
    limit: Number(p("limit") ?? 60), offset: Number(p("offset") ?? 0), sources: activeSources(),
  };
  return c.json(queryTitles(f));
});
catalogApi.get("/api/v1/catalog/titles/:id", c => {
  const t = getTitle(c.req.param("id"), activeSources());
  return t ? c.json({ item: t }) : c.json({ error: "not found" }, 404);
});

catalogApi.get("/api/v1/catalog/runtimes", c => c.json({ items: runtimeRows().map(serializeRuntime), facets: facets(activeSources()).runtimes }));
catalogApi.get("/api/v1/catalog/runtimes/:id", c => {
  const r = runtimeRow(c.req.param("id"));
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json({ item: serializeRuntime(r), titles: queryTitles({ runtime: r.id, limit: 500 }) });
});
catalogApi.post("/api/v1/catalog/runtimes/refresh", async c => c.json(await refreshRuntimes(true)));

catalogApi.get("/api/v1/catalog/sources", c => {
  const runs = new Map(sourceRows().map(s => [s.id, s]));
  return c.json({
    items: cdeps.sources().map(({ id, name, source: p }) => {
      const s = runs.get(p.id);
      const ready = p.ready?.() ?? true;
      return { id: p.id, instanceId: id, label: name, about: p.about, every: p.every, ready: ready === true, notReady: ready === true ? null : ready,
        lastRun: s?.last_run ?? null, lastOk: s?.last_ok ?? null, lastError: s?.last_error ?? null, titles: s?.titles ?? 0, routes: s?.routes ?? 0, tookMs: s?.took_ms ?? null };
    }),
  });
});
catalogApi.post("/api/v1/catalog/sources/:id/refresh", async c => {
  const p = sourceById(c.req.param("id"));
  if (!p) return c.json({ error: "no such source (is it enabled?)" }, 404);
  const r = await runSource(p);
  return c.json(r, "error" in r ? 502 : 200);
});
