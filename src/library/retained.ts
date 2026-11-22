import { db, stmts, type JobRow } from "../db";
import { enqueueJob } from "../process/kinds";
import { checkServerPath } from "../ways/content";
import { getWay } from "../ways/store";
import { LibraryError } from "./games";

interface Download { id: number; title: string; path: string; size: number | null; reason: string | null }
const retained = db.query(`SELECT f.id, f.title, f.local_path AS path, f.size,
  COALESCE((SELECT b.reason FROM blocklist b WHERE b.game_id=f.game_id AND (b.guid=f.guid OR b.title=f.title) ORDER BY b.id DESC LIMIT 1),
           (SELECT j.message FROM jobs j WHERE j.game_id=f.game_id AND (j.fetch_id=f.id OR json_extract(j.spec_json,'$.fetchId')=f.id) AND j.state='failed' ORDER BY j.id DESC LIMIT 1)) AS reason
  FROM fetches f WHERE f.game_id=? AND f.state='done' AND f.local_path IS NOT NULL ORDER BY f.id DESC`);
export const retainedDownloads = (game: number) => retained.all(game) as Download[];
export async function useDownload(game: number, fetchId: number, wayId: number | null) {
  const f = retainedDownloads(game).find(d => d.id === fetchId);
  if (!f) throw new LibraryError("No completed download with that ID for this game", 404);
  if (wayId !== null && (!Number.isSafeInteger(wayId) || getWay(wayId)?.game_id !== game)) throw new LibraryError("Choose a way for this game", 400);
  const { real } = await checkServerPath(f.path, { folders: true });
  return db.transaction(() => {
    const active = db.query(`SELECT * FROM jobs WHERE game_id=? AND state IN ('queued','running')
      AND (fetch_id=? OR json_extract(spec_json,'$.fetchId')=?) AND COALESCE(kind,'import')=?
      AND json_extract(spec_json,'$.wayId') IS ? LIMIT 1`).get(game, fetchId, fetchId, wayId === null ? "import" : "content", wayId) as JobRow | null;
    if (active) return active;
    if (wayId !== null) return enqueueJob({ kind: "content", gameId: game, wayId, fetchId, earlier: true, manualSelection: true, path: real }, { gameId: game, fetchId });
    return stmts.insertJobOf.get(null, fetchId, game, real, "import", JSON.stringify({ earlier: true }), null) as JobRow;
  }).immediate();
}
