/**
 * ludarr API — uploads: a game's files sent from the admin's own PC, for any game (src/uploads.ts).
 *
 *   GET    /api/v1/upload?gameId=                      every upload that is under way, whole and being taken in, or failed
 *   POST   /api/v1/game/:id/upload                     { name, files, bytes, wayId?, replace? } → 201 { item }: a new upload
 *                                                       (name: what was picked; files, bytes: how many files and their size
 *                                                       together; wayId: it is that way's game file, not the game's copy;
 *                                                       replace: the copy may take the place of a built way). 200 { item,
 *                                                       resumed: true } when the very same pick is under way already: then only
 *                                                       what is missing is sent. 409 { needsReplace: true } for a copy when
 *                                                       the game plays through a built way; 507 when the library has no room
 *   GET    /api/v1/upload/:id                          { item, files: [{ path, size, done }] }: what is there, whole or in part
 *   PUT    /api/v1/upload/:id/file?path=&size=&offset= a piece of one file as the raw body, appended at `offset` (path: the
 *                                                       file's path inside the upload, forward slashes; size: the whole file's)
 *                                                       → { received, done, item }. 409 { received, done } when the piece does
 *                                                       not start where the file ends: go on from `received`; 409 { busy: true }
 *                                                       when an earlier piece of the file has not let go yet: try again in a
 *                                                       moment (a newer piece takes over from one whose sender went quiet, and a
 *                                                       piece that brings nothing for 90 s ends by itself). One request can
 *                                                       carry a whole file of up to CONTENT_UPLOAD_MAX_GB (curl -T); the web UI
 *                                                       sends pieces of 32 MB, so a file of any size goes up
 *   GET    /api/v1/upload/:id/file?path=               { received, done }: how much of one file is there, nothing written — what a
 *                                                       sender asks after its line dropped, before it goes on
 *   POST   /api/v1/upload/:id/finish                   every file whole → 202 { item, job }: the import (the game's copy) or the
 *                                                       content job (a way's game file). 409 saying what is missing
 *   POST   /api/v1/upload/:id/retry                    { wayId?, replace? } → 202 { item, job }: an upload whose job failed, taken
 *                                                       in again — as it was, or the other way (wayId: null for the game's copy)
 *   DELETE /api/v1/upload/:id                          removed with its files; one being taken in: its job is stopped first
 *
 * The files of an upload go by themselves once its job is done; one nobody finished, or whose job failed, after 7 days.
 */
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { serializeJob } from "../db";
import { allUploads, createUpload, finishUpload, getUpload, removeUpload, retryUpload, serializeUpload, UploadError, uploadFiles, uploadsOfGame, whereFile, writePiece } from "../uploads";

export const uploadsApi = new Hono();

const fail = (c: Context, e: unknown) => (e instanceof UploadError
  ? c.json({ error: e.message, ...e.extra }, e.status as ContentfulStatusCode)
  : c.json({ error: String((e as Error)?.message ?? e) }, 500));
const idOf = (c: Context) => { const n = Number(c.req.param("id")); return Number.isInteger(n) && n > 0 ? n : 0; };
const json = async (c: Context): Promise<Record<string, unknown>> => { const b = await c.req.json().catch(() => null); return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {}; };

uploadsApi.get("/api/v1/upload", c => {
  const gameId = Number(c.req.query("gameId"));
  return c.json({ items: (Number.isInteger(gameId) && gameId > 0 ? uploadsOfGame(gameId) : allUploads()).map(serializeUpload) });
});

uploadsApi.post("/api/v1/game/:id/upload", async c => {
  try {
    const r = await createUpload(idOf(c), await json(c));
    return c.json({ item: serializeUpload(r.row), ...(r.resumed ? { resumed: true } : {}) }, r.resumed ? 200 : 201);
  } catch (e) { return fail(c, e); }
});

uploadsApi.get("/api/v1/upload/:id", async c => {
  const u = getUpload(idOf(c));
  if (!u) return c.json({ error: "no such upload" }, 404);
  return c.json({ item: serializeUpload(u), files: await uploadFiles(u) });
});

uploadsApi.get("/api/v1/upload/:id/file", async c => {
  try { return c.json(await whereFile(idOf(c), c.req.query("path"))); } catch (e) { return fail(c, e); }
});

// a piece keeps the server's own idle timeout: bytes that flow keep it alive however slow the line, and a sender that went
// quiet without a word is let go (src/uploads.ts ends such a piece itself after 90 s)
uploadsApi.put("/api/v1/upload/:id/file", async c => {
  try {
    const r = await writePiece(idOf(c), {
      path: c.req.query("path"), size: c.req.query("size"), offset: c.req.query("offset") ?? "0",
      body: c.req.raw.body as unknown as AsyncIterable<Uint8Array> | null, signal: c.req.raw.signal,
    });
    return c.json({ received: r.received, done: r.done, item: r.upload });
  } catch (e) { return fail(c, e); }
});

uploadsApi.post("/api/v1/upload/:id/finish", async c => {
  try { const r = await finishUpload(idOf(c)); return c.json({ item: serializeUpload(r.row), job: serializeJob(r.job) }, 202); } catch (e) { return fail(c, e); }
});

uploadsApi.post("/api/v1/upload/:id/retry", async c => {
  try { const r = await retryUpload(idOf(c), await json(c)); return c.json({ item: serializeUpload(r.row), job: serializeJob(r.job) }, 202); } catch (e) { return fail(c, e); }
});

uploadsApi.delete("/api/v1/upload/:id", async c => {
  try { return c.json(await removeUpload(idOf(c))); } catch (e) { return fail(c, e); }
});
