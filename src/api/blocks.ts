/**
 * API — a package as blocks (src/blocks.ts): what a launcher takes a game by, in a few requests.
 *
 *   GET    /api/v1/blocks                  how far the library is: { packages, ready, blocks, sending, working, waiting, refused }
 *                                          (sending: streams of blocks going out now)
 *   GET    /api/v1/package/:id/blocks      the package's block index: header and hashes (404 while it has none)
 *   POST   /api/v1/package/:id/blocks      { digest, want: [[file, first block, count], …] } → the blocks as one stream of
 *                                          frames (409 with the index's own digest when the package's files changed; 413
 *                                          for more than one request may ask)
 */
import { Hono } from "hono";
import { stmts, type PackageRow } from "../db";
import { blocksResponse, blocksStatus, indexResponse } from "../blocks";

export const blocksApi = new Hono();

blocksApi.get("/api/v1/blocks", c => c.json(blocksStatus()));
blocksApi.on(["GET", "HEAD"], "/api/v1/package/:id/blocks", c => {
  const p = stmts.packageById.get(Number(c.req.param("id"))) as PackageRow | undefined;
  return p ? indexResponse(p, c.req.method === "HEAD") : c.json({ error: "not found" }, 404);
});
blocksApi.post("/api/v1/package/:id/blocks", async c => {
  const p = stmts.packageById.get(Number(c.req.param("id"))) as PackageRow | undefined;
  if (!p) return c.json({ error: "not found" }, 404);
  return blocksResponse(p, await c.req.json().catch(() => null));
});
