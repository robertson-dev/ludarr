/**
 * ludarr — storage for runtime plans, ways and game files (src/ways/types.ts says what each is). The tables are made
 * when this module is first imported, like the catalog's. Rows come back as stored; the serializers give the API's
 * camelCase shapes. Writes here never run anything: the API (src/ways/api.ts) and the jobs (assemble, construct, content)
 * call these and then re-ingest the custom catalog source.
 */
import { existsSync } from "node:fs";
import { db, stmts, type JobRow, type PackageRow } from "../db";
import { scopeProblem } from "./emulator-scope";
import { copyVerdict } from "./copy";
import type { Identity } from "./identity";
import { contentMatches, needMatches, needsMet, type FileFacts } from "./match";
import type { ContentPlan, Hashes, HashedStat, MadeInfo, PinnedProgram, PlanKind, PlanStatus, RuntimePlanSpec, WayOverrides, WayStatus } from "./types";

db.exec(`
CREATE TABLE IF NOT EXISTS runtime_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  repo TEXT NOT NULL,
  homepage TEXT,
  platforms_json TEXT NOT NULL DEFAULT '[]',
  spec_json TEXT NOT NULL,
  pinned_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  status_note TEXT,
  author TEXT NOT NULL DEFAULT 'user',
  job_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS emulator_plan_targets (
  plan_id INTEGER PRIMARY KEY REFERENCES runtime_plans(id) ON DELETE CASCADE,
  game_id INTEGER NOT NULL, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emulator_research (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE, platform TEXT NOT NULL,
  checked_at INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(game_id,platform)
);
CREATE TABLE IF NOT EXISTS contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  plan_id INTEGER REFERENCES runtime_plans(id) ON DELETE CASCADE,
  need_index INTEGER,
  role TEXT NOT NULL DEFAULT 'game',
  platform TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  hashes_json TEXT NOT NULL,
  raw_hashes_json TEXT,
  normalized TEXT,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_contents_game ON contents(game_id);
CREATE INDEX IF NOT EXISTS idx_contents_plan ON contents(plan_id);
CREATE TABLE IF NOT EXISTS ways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES runtime_plans(id) ON DELETE CASCADE,
  content_json TEXT,
  overrides_json TEXT,
  content_id INTEGER REFERENCES contents(id) ON DELETE SET NULL,
  package_id INTEGER,
  status TEXT NOT NULL DEFAULT 'needs-files',
  status_note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(game_id, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_ways_game ON ways(game_id);
`);
/* what a game file's own bytes say it is (src/ways/identity.ts: serial, game id or code, title, region), read when it is
   taken in — idempotent */
try { db.exec("ALTER TABLE contents ADD COLUMN identity_json TEXT"); } catch { /* already there */ }
/* the serials the admin took off a way: the catalog and the dump lists never put them back (src/ways/find.ts) — idempotent */
try { db.exec("ALTER TABLE ways ADD COLUMN dropped_serials_json TEXT"); } catch { /* already there */ }
try { db.exec("ALTER TABLE ways ADD COLUMN manual_choice INTEGER"); } catch { /* already there */ }
/* a game file may be a folder kept as a tree (shape 'folder'), and may have been made from another form of the game's data
   by a make (made_json: src/ways/types.ts MadeInfo) — idempotent */
for (const ddl of ["ALTER TABLE contents ADD COLUMN shape TEXT DEFAULT 'file'", "ALTER TABLE contents ADD COLUMN made_json TEXT", "ALTER TABLE contents ADD COLUMN stat_json TEXT"]) {
  try { db.exec(ddl); } catch { /* already there */ }
}

export interface PlanRow {
  id: number; slug: string; name: string; kind: PlanKind; repo: string; homepage: string | null; platforms_json: string;
  spec_json: string; pinned_json: string | null; status: PlanStatus; status_note: string | null; author: "user" | "ai";
  job_id: number | null; created_at: number; updated_at: number;
}
export interface WayRow {
  id: number; game_id: number; plan_id: number; content_json: string | null; overrides_json: string | null; content_id: number | null;
  package_id: number | null; status: WayStatus; status_note: string | null; created_at: number; updated_at: number;
  /** the serials the admin took off the way's own content (JSON list): never added back from the catalog or a dump list */
  dropped_serials_json?: string | null;
  manual_choice?: number | null;
}
/** role 'game': a game file (game_id); role 'system': a file one of a plan's needs asks for (plan_id + need_index). source
 *  'made': made by a make from another form of the game's data; 'inbox': dropped into the game's inbox folder */
export interface ContentRow {
  id: number; game_id: number | null; plan_id: number | null; need_index: number | null; role: "game" | "system";
  platform: string | null; name: string; path: string; size: number; hashes_json: string; raw_hashes_json: string | null;
  normalized: string | null; source: "upload" | "path" | "package" | "indexer" | "made" | "inbox"; created_at: number;
  /** src/ways/identity.ts Identity as JSON; null for a system file, a file nothing could be read from, or one from before */
  identity_json?: string | null;
  /** 'folder': a game folder kept as a tree (its hashes are of its canonical listing) */
  shape?: "file" | "folder" | null;
  /** what a made file was made from and how (src/ways/types.ts MadeInfo as JSON) */
  made_json?: string | null;
  /** the file's stat when its hashes were taken (src/ways/types.ts HashedStat as JSON); null: from before, or a folder */
  stat_json?: string | null;
}

const J = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };

export const wstmts = {
  planById: db.query("SELECT * FROM runtime_plans WHERE id=?"),
  planBySlug: db.query("SELECT * FROM runtime_plans WHERE slug=?"),
  plansByRepo: db.query("SELECT * FROM runtime_plans WHERE repo=? ORDER BY id"),
  plansAll: db.query("SELECT * FROM runtime_plans ORDER BY name COLLATE NOCASE, id"),
  insertPlan: db.query(`INSERT INTO runtime_plans (slug, name, kind, repo, homepage, platforms_json, spec_json, status, status_note, author, job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
  deletePlan: db.query("DELETE FROM runtime_plans WHERE id=?"),
  setPlanStatus: db.query("UPDATE runtime_plans SET status=?, status_note=?, updated_at=unixepoch() WHERE id=?"),
  setPinned: db.query("UPDATE runtime_plans SET pinned_json=?, updated_at=unixepoch() WHERE id=?"),
  /** the pin a build took, kept only while the plan still asks for what that build read (spec and repo unchanged) */
  setPinnedIf: db.query("UPDATE runtime_plans SET pinned_json=?, updated_at=unixepoch() WHERE id=? AND spec_json=? AND repo=?"),

  wayById: db.query("SELECT * FROM ways WHERE id=?"),
  wayFor: db.query("SELECT * FROM ways WHERE game_id=? AND plan_id=?"),
  waysForGame: db.query("SELECT * FROM ways WHERE game_id=? ORDER BY id"),
  waysForPlan: db.query("SELECT * FROM ways WHERE plan_id=? ORDER BY id"),
  waysAll: db.query("SELECT * FROM ways ORDER BY id"),
  insertWay: db.query("INSERT INTO ways (game_id, plan_id, content_json, overrides_json, status, status_note, manual_choice) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"),
  deleteWay: db.query("DELETE FROM ways WHERE id=?"),
  setWayStatus: db.query("UPDATE ways SET status=?, status_note=?, updated_at=unixepoch() WHERE id=?"),
  setWayBuilt: db.query("UPDATE ways SET status='built', status_note=NULL, package_id=?, updated_at=unixepoch() WHERE id=?"),
  setWayContentFile: db.query("UPDATE ways SET content_id=?, updated_at=unixepoch() WHERE id=?"),
  setDroppedSerials: db.query("UPDATE ways SET dropped_serials_json=? WHERE id=?"),
  /** a package replaced or removed: the ways that had built it go back to ready */
  unbuildPackage: db.query("UPDATE ways SET status='ready', package_id=NULL, status_note=?, updated_at=unixepoch() WHERE package_id=?"),

  contentById: db.query("SELECT * FROM contents WHERE id=?"),
  contentsForGame: db.query("SELECT * FROM contents WHERE game_id=? AND role='game' ORDER BY id DESC"),
  systemFilesForPlan: db.query("SELECT * FROM contents WHERE plan_id=? AND role='system' ORDER BY need_index, id DESC"),
  contentBySha1: db.query("SELECT * FROM contents WHERE json_extract(hashes_json, '$.sha1')=? AND role='game' ORDER BY id DESC LIMIT 1"),
  /** a game file of this game whose bytes have this sha256 (normalised, or as received): the game's copy kept before */
  contentBySha256: db.query("SELECT * FROM contents WHERE game_id=?1 AND role='game' AND (json_extract(hashes_json, '$.sha256')=?2 OR json_extract(raw_hashes_json, '$.sha256')=?2) ORDER BY id DESC LIMIT 1"),
  /** a made game file of this game by its make key (MadeInfo.key): made before from the same data by the same recipe */
  contentByMadeKey: db.query("SELECT * FROM contents WHERE game_id=? AND role='game' AND source='made' AND json_extract(made_json, '$.key')=? ORDER BY id DESC LIMIT 1"),
  insertContent: db.query(`INSERT INTO contents (game_id, plan_id, need_index, role, platform, name, path, size, hashes_json, raw_hashes_json, normalized, source, identity_json, shape, made_json, stat_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
  /** the stat of a kept file when its hashes were taken (HashedStat as JSON) */
  setContentStat: db.query("UPDATE contents SET stat_json=? WHERE id=?"),
  setContentIdentity: db.query("UPDATE contents SET identity_json=? WHERE id=?"),
  /** what a made file was made from (MadeInfo as JSON), learnt by a row that already held the same bytes */
  setContentMade: db.query("UPDATE contents SET made_json=? WHERE id=?"),
  deleteContent: db.query("DELETE FROM contents WHERE id=?"),
};

export const getPlan = (id: number) => (wstmts.planById.get(id) as PlanRow | null) ?? null;
export const getWay = (id: number) => (wstmts.wayById.get(id) as WayRow | null) ?? null;
export const getContent = (id: number) => (wstmts.contentById.get(id) as ContentRow | null) ?? null;
export const planSpec = (p: PlanRow): RuntimePlanSpec => JSON.parse(p.spec_json) as RuntimePlanSpec;
export const planPinned = (p: PlanRow): PinnedProgram | null => J<PinnedProgram | null>(p.pinned_json, null);
export const contentHashes = (c: ContentRow): Hashes => J<Hashes>(c.hashes_json, {});
export const contentRawHashes = (c: ContentRow): Hashes | null => J<Hashes | null>(c.raw_hashes_json, null);
export const contentIdentity = (c: ContentRow): Identity | null => J<Identity | null>(c.identity_json, null);
export const contentMade = (c: ContentRow): MadeInfo | null => J<MadeInfo | null>(c.made_json, null);
/** the file's stat when its hashes were taken, or null (a row from before, a folder) */
export const contentStat = (c: ContentRow): HashedStat | null => J<HashedStat | null>(c.stat_json ?? null, null);
/** a way's game file plan: its own (an emulator way's, or an edited one), else the plan's */
export const wayContent = (w: WayRow, p: PlanRow): ContentPlan | null => (w.content_json ? J<ContentPlan | null>(w.content_json, null) : planSpec(p).content);

/** a value as JSON with every object's keys sorted, at every depth: equal plans give the same text whatever order their
 *  fields were written in (undefined fields are left out, as JSON.stringify does) */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
/** a way's game file plan as one digest (sha256 of its canonical JSON): a release a way's search refused only for its form
 *  is refused under this digest, and is looked at again once the plan says something else (src/requests.ts) */
export const contentDigest = (c: ContentPlan | null | undefined): string => new Bun.CryptoHasher("sha256").update(canonicalJson(c ?? null)).digest("hex");
export const wayOverrides = (w: WayRow): WayOverrides => J<WayOverrides>(w.overrides_json, {});
export const droppedSerials = (w: WayRow): string[] => J<string[]>(w.dropped_serials_json, []).filter(s => typeof s === "string");

/** a slug for a new plan from its name ('zelda-64-recompiled', then '-2', '-3' …) */
export function uniquePlanSlug(name: string): string {
  const base = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
  let slug = base;
  for (let i = 2; wstmts.planBySlug.get(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export function insertPlan(v: { name: string; kind: PlanKind; repo: string; homepage?: string | null; platforms: string[]; spec: RuntimePlanSpec; status?: PlanStatus; statusNote?: string | null; author?: "user" | "ai"; jobId?: number | null; slug?: string }): PlanRow {
  return wstmts.insertPlan.get(v.slug ?? uniquePlanSlug(v.name), v.name, v.kind, v.repo, v.homepage ?? null, JSON.stringify(v.platforms), JSON.stringify(v.spec),
    v.status ?? "draft", v.statusNote ?? null, v.author ?? "user", v.jobId ?? null) as PlanRow;
}

/** change a plan's own fields; a changed program, or a changed repo it comes from, drops what was pinned (the old file is
 *  no longer what the plan asks for) */
export function updatePlan(id: number, patch: { name?: string; kind?: PlanKind; repo?: string; homepage?: string | null; platforms?: string[]; spec?: RuntimePlanSpec; status?: PlanStatus; statusNote?: string | null; author?: "user" | "ai"; jobId?: number | null }): PlanRow | null {
  const cur = getPlan(id);
  if (!cur) return null;
  const sets: string[] = [], vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => { sets.push(`${col}=?`); vals.push(v); };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.kind !== undefined) set("kind", patch.kind);
  if (patch.repo !== undefined) set("repo", patch.repo);
  if (patch.homepage !== undefined) set("homepage", patch.homepage);
  if (patch.platforms !== undefined) set("platforms_json", JSON.stringify(patch.platforms));
  if (patch.spec !== undefined) set("spec_json", JSON.stringify(patch.spec));
  // a pin belongs to the program and the repo it was taken from
  const programChanged = patch.spec !== undefined && JSON.stringify(patch.spec.program) !== JSON.stringify(planSpec(cur).program);
  if (programChanged || (patch.repo !== undefined && patch.repo !== cur.repo)) set("pinned_json", null);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.statusNote !== undefined) set("status_note", patch.statusNote);
  if (patch.author !== undefined) set("author", patch.author);
  if (patch.jobId !== undefined) set("job_id", patch.jobId);
  if (!sets.length) return cur;
  db.query(`UPDATE runtime_plans SET ${sets.join(", ")}, updated_at=unixepoch() WHERE id=?`).run(...vals, id);
  return getPlan(id);
}

export function insertWay(v: { gameId: number; planId: number; automatic?: boolean; content?: ContentPlan | null; overrides?: WayOverrides | null; status?: WayStatus; statusNote?: string | null }): WayRow {
  return wstmts.insertWay.get(v.gameId, v.planId, v.content ? JSON.stringify(v.content) : null, v.overrides && Object.keys(v.overrides).length ? JSON.stringify(v.overrides) : null,
    v.status ?? "needs-files", v.statusNote ?? null, v.automatic ? 0 : 1) as WayRow;
}

export function updateWay(id: number, patch: { content?: ContentPlan | null; overrides?: WayOverrides | null; contentId?: number | null; status?: WayStatus; statusNote?: string | null; packageId?: number | null }): WayRow | null {
  const sets: string[] = [], vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => { sets.push(`${col}=?`); vals.push(v); };
  if (patch.content !== undefined) set("content_json", patch.content ? JSON.stringify(patch.content) : null);
  if (patch.overrides !== undefined) set("overrides_json", patch.overrides && Object.keys(patch.overrides).length ? JSON.stringify(patch.overrides) : null);
  if (patch.contentId !== undefined) set("content_id", patch.contentId);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.statusNote !== undefined) set("status_note", patch.statusNote);
  if (patch.packageId !== undefined) set("package_id", patch.packageId);
  if (sets.length) db.query(`UPDATE ways SET ${sets.join(", ")}, updated_at=unixepoch() WHERE id=?`).run(...vals, id);
  return getWay(id);
}

export function insertContent(v: { gameId?: number | null; planId?: number | null; needIndex?: number | null; role?: "game" | "system"; platform?: string | null; name: string; path: string; size: number; hashes: Hashes; rawHashes?: Hashes | null; normalized?: string | null; source: ContentRow["source"]; identity?: Identity | null; shape?: "file" | "folder"; made?: MadeInfo | null; stat?: HashedStat | null }): ContentRow {
  return wstmts.insertContent.get(v.gameId ?? null, v.planId ?? null, v.needIndex ?? null, v.role ?? "game", v.platform ?? null, v.name, v.path, v.size,
    JSON.stringify(v.hashes), v.rawHashes ? JSON.stringify(v.rawHashes) : null, v.normalized ?? null, v.source, v.identity ? JSON.stringify(v.identity) : null,
    v.shape ?? "file", v.made ? JSON.stringify(v.made) : null, v.stat ? JSON.stringify(v.stat) : null) as ContentRow;
}

export function serializePlan(p: PlanRow) {
  return {
    id: p.id, slug: p.slug, name: p.name, kind: p.kind, repo: p.repo, homepage: p.homepage, platforms: J<string[]>(p.platforms_json, []),
    spec: planSpec(p), pinned: planPinned(p), status: p.status, statusNote: p.status_note, author: p.author, jobId: p.job_id,
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}
export function serializeWay(w: WayRow, plan?: PlanRow | null) {
  const p = plan === undefined ? getPlan(w.plan_id) : plan;
  return {
    id: w.id, gameId: w.game_id, planId: w.plan_id, planName: p?.name ?? null, planKind: p?.kind ?? null,
    content: p ? wayContent(w, p) : null, ownContent: !!w.content_json, overrides: wayOverrides(w), contentId: w.content_id, packageId: w.package_id,
    status: w.status, statusNote: w.status_note, createdAt: w.created_at, updatedAt: w.updated_at,
  };
}
/** admin-facing (the path stays on the server) */
export function serializeContent(c: ContentRow) {
  return {
    id: c.id, gameId: c.game_id, planId: c.plan_id, needIndex: c.need_index, role: c.role, platform: c.platform, name: c.name, size: c.size,
    hashes: contentHashes(c), rawHashes: contentRawHashes(c), normalized: c.normalized, source: c.source, createdAt: c.created_at,
    identity: contentIdentity(c), shape: c.shape ?? "file", made: contentMade(c),
  };
}

/* ─────────── what a way still lacks, and the status that follows from it ───────────
   needs-files while a game file or a need is missing (or the attached file no longer matches), ready once it has
   everything; building / built / failed belong to the assemble job (src/ways/assemble.ts), so a way it is working on,
   or one whose package is still there, keeps its status. */

const wq = {
  assembling: db.query("SELECT * FROM jobs WHERE kind='assemble' AND state IN ('queued','running') AND json_extract(spec_json, '$.wayId')=? ORDER BY id DESC LIMIT 1"),
  making: db.query("SELECT * FROM jobs WHERE kind='make' AND state IN ('queued','running') AND json_extract(spec_json, '$.wayId')=? ORDER BY id DESC LIMIT 1"),
  planBuilds: db.query("SELECT * FROM jobs WHERE kind='build' AND state IN ('queued','running') AND json_extract(spec_json, '$.planId')=? ORDER BY id DESC"),
  waysCount: db.query("SELECT COUNT(*) AS n FROM ways WHERE plan_id=?"),
  waysUsingContent: db.query("SELECT * FROM ways WHERE content_id=? ORDER BY id"),
  waysOfPackage: db.query("SELECT id FROM ways WHERE package_id=? ORDER BY id"),
  sameFile: db.query(`SELECT * FROM contents WHERE json_extract(hashes_json, '$.sha1')=? AND role=? AND COALESCE(game_id, -1)=COALESCE(?, -1)
    AND COALESCE(plan_id, -1)=COALESCE(?, -1) AND COALESCE(need_index, -1)=COALESCE(?, -1) ORDER BY id LIMIT 1`),
  /** game files a search brought that no way took: kept for the admin to look at (src/ways/find.ts) */
  unattached: db.query(`SELECT * FROM contents c WHERE c.game_id=? AND c.role='game' AND c.source='indexer' AND COALESCE(c.platform, '')=?
    AND NOT EXISTS (SELECT 1 FROM ways w WHERE w.content_id=c.id) ORDER BY c.id DESC`),
};

/** what match.ts judges a stored file (or a kept game folder) by */
export function contentFacts(c: ContentRow): FileFacts & { needIndex: number | null } {
  return { platform: c.platform, name: c.name, size: c.size, hashes: contentHashes(c), rawHashes: contentRawHashes(c), identity: contentIdentity(c), shape: c.shape === "folder" ? "folder" : "file", needIndex: c.need_index };
}
/**
 * A file the indexers brought for a way of this console that nothing could prove is the game (src/ways/find.ts keeps it
 * rather than throw a good copy away): it waits for the admin, who accepts it for a way (POST /way/:id/accept-file) or
 * removes it, and until then no search fetches another for the game's ways of that console.
 */
export function heldFile(gameId: number, platform: string): ContentRow | null {
  return heldFiles(gameId, platform)[0] ?? null;
}
/** every such file, newest first (each way judges them for itself: a file one way cannot prove another may take or refuse) */
export const heldFiles = (gameId: number, platform: string): ContentRow[] => (wq.unattached.all(gameId, platform) as ContentRow[]).filter(f => existsSync(f.path));
/** Reuse an already supplied build input only when its name, kind and accepted facts agree and the bytes are
 * unambiguous. An explicit file on this plan always wins; different saved key sets require a choice. No file moves. */
export function reuseBuildNeeds(spec: RuntimePlanSpec, own: ContentRow[]): ContentRow[] {
  const out = [...own];
  for (const [i, need] of spec.needs.entries()) {
    if (!need.build || own.some(f => f.need_index === i)) continue;
    const candidates = (db.query("SELECT * FROM contents WHERE role='system' ORDER BY id DESC").all() as ContentRow[]).filter(f => {
      const plan = f.plan_id != null ? getPlan(f.plan_id) : null;
      const slot = plan && f.need_index != null ? planSpec(plan).needs[f.need_index] : null;
      return slot?.kind === need.kind && slot.name.trim().toLowerCase() === need.name.trim().toLowerCase()
        && !!contentHashes(f).sha256 && existsSync(f.path) && needMatches(need, contentFacts(f)).ok;
    });
    if (candidates.length && new Set(candidates.map(f => contentHashes(f).sha256)).size === 1)
      out.push({ ...candidates[0], need_index: i });
  }
  return out;
}
export const systemFiles = (planId: number): ContentRow[] => {
  const own = wstmts.systemFilesForPlan.all(planId) as ContentRow[];
  const plan = getPlan(planId);
  return plan ? reuseBuildNeeds(planSpec(plan), own) : own;
};
export const gameFiles = (gameId: number) => wstmts.contentsForGame.all(gameId) as ContentRow[];
export const waysOfPlan = (planId: number) => wstmts.waysForPlan.all(planId) as WayRow[];
export const waysOfGame = (gameId: number) => wstmts.waysForGame.all(gameId) as WayRow[];
export const waysUsingContent = (contentId: number) => wq.waysUsingContent.all(contentId) as WayRow[];
export const planWaysCount = (planId: number) => (wq.waysCount.get(planId) as { n: number }).n;
/** a file with these bytes already kept for the same game (or the same need slot of the same plan) */
export const sameStoredFile = (sha1: string, t: { role: "game" | "system"; gameId?: number | null; planId?: number | null; needIndex?: number | null }) =>
  (wq.sameFile.get(sha1, t.role, t.gameId ?? null, t.planId ?? null, t.needIndex ?? null) as ContentRow | null) ?? null;

/** the same bytes came in again after a kept file went missing from the disk: its row points at the new copy, so the
 *  ways that use it keep it */
export function repointContent(id: number, v: { name: string; path: string; rawHashes: Hashes | null; normalized: string | null }): ContentRow {
  db.query("UPDATE contents SET name=?, path=?, raw_hashes_json=?, normalized=? WHERE id=?").run(v.name, v.path, v.rawHashes ? JSON.stringify(v.rawHashes) : null, v.normalized, id);
  return getContent(id)!;
}

/** which of a plan's needs have a matching system file */
export const planNeeds = (p: PlanRow) => needsMet(planSpec(p), systemFiles(p.id).map(contentFacts));

/** the assemble job building a way, while it is queued or running */
export const assembling = (wayId: number) => (wq.assembling.get(wayId) as JobRow | null) ?? null;
/** the make job making a way's game file, while it is queued or running */
export const making = (wayId: number) => (wq.making.get(wayId) as JobRow | null) ?? null;

/** a plan's build jobs (src/ways/build.ts: its program from source, its tools) while they are queued or running, newest first */
export const planBuilds = (planId: number) => wq.planBuilds.all(planId) as JobRow[];
/** the way a build job builds for (a plan built once per game builds that game's program), or null for the whole plan */
export function buildWayId(j: Pick<JobRow, "spec_json">): number | null {
  try { const id = Number(JSON.parse(j.spec_json ?? "null")?.wayId); return Number.isInteger(id) && id > 0 ? id : null; } catch { return null; }
}
/** the build job working for this way, while it is queued or running */
export const buildingFor = (w: Pick<WayRow, "id" | "plan_id">) => planBuilds(w.plan_id).find(j => buildWayId(j) === w.id) ?? null;

/** the game's current package and its kind (a manifest without one is a native PC copy) */
export function currentPackage(gameId: number): { pkg: PackageRow; kind: string; platform: string | null } | null {
  const pkg = stmts.packageForGame.get(gameId) as PackageRow | null;
  if (!pkg) return null;
  let m: { kind?: string; platform?: string | null } = {};
  try { m = JSON.parse(pkg.manifest_json); } catch { /* an unreadable manifest counts as native */ }
  return { pkg, kind: m.kind || "native", platform: m.platform ?? null };
}


/** what keeps a way from having everything it needs, in words for the admin; empty when nothing does */
export function wayGaps(w: WayRow, p: PlanRow): string[] {
  const wrong = scopeProblem(p, w.game_id);
  if (wrong) return [wrong];
  const gaps: string[] = [];
  const c = wayContent(w, p);
  if (c) {
    const file = w.content_id != null ? getContent(w.content_id) : null;
    if (file) { const v = contentMatches(c, contentFacts(file)); if (!v.ok) gaps.push(`the game file is ${v.why}`); }
    else {
      // the game's copy on the server, judged where it is (src/ways/copy.ts): the way's file, what it is made from, or
      // exactly why not; nothing is said for sure before it has been looked at
      const copy = copyVerdict(w.game_id, c);
      if (copy.serves === "unknown") gaps.push("looking at the game's copy");
      else if (copy.serves === "no") {
        // only a waiting file this way could take is named (one its hashes or serials turn down is no file for it)
        const held = heldFiles(w.game_id, c.platform).find(f => contentMatches(c, contentFacts(f)).ok);
        gaps.push(held ? `needs the game file (${c.what}): ${held.name} came from the indexers, and nothing could prove it is the game — accept it if it is`
          : `needs the game file (${c.what})${copy.entry ? `: the game's copy ${copy.entry.name} is ${copy.why}` : ""}`);
      }
    }
  }
  for (const m of planNeeds(p).missing) gaps.push(m.why ? `needs ${m.name} (the file there is ${m.why})` : `needs ${m.name}`);
  return gaps;
}

/** recompute a way's status after something it depends on changed (a file, a need, its content plan); `readyNote` is
 *  what a way that can build says (why it is ready again) */
export function settleWay(id: number, readyNote: string | null = null): WayRow | null {
  const w = getWay(id);
  if (!w) return null;
  const p = getPlan(w.plan_id);
  if (!p || assembling(w.id)) return w;
  if (w.status === "built" && w.package_id != null && stmts.packageById.get(w.package_id)) return w;
  const gaps = wayGaps(w, p);
  const status: WayStatus = gaps.length ? "needs-files" : "ready";
  const note = gaps.length ? gaps.join("; ") : readyNote;
  const lostPackage = w.status === "built";                                   // built once, but that package is gone
  if (status === w.status && note === w.status_note && !lostPackage) return w;
  return updateWay(id, { status, statusNote: note, ...(lostPackage ? { packageId: null } : {}) });
}
/**
 * A package was replaced or removed: the ways that had built it no longer have one, and each settles — ready (saying why)
 * when it could build again, needs-files when its game file or a need is gone too (a way being built is its build's to
 * settle). Returns those ways; the caller emits the package event, on which the catalog is ingested again
 * (src/ways/hooks.ts).
 */
export function unbuildWays(packageId: number, why: string): WayRow[] {
  const ids = (wq.waysOfPackage.all(packageId) as { id: number }[]).map(r => r.id);
  if (!ids.length) return [];
  wstmts.unbuildPackage.run(why, packageId);
  return ids.map(id => settleWay(id, why)).filter((w): w is WayRow => !!w);
}
export const settleWaysOfPlan = (planId: number) => waysOfPlan(planId).map(w => settleWay(w.id)!);
export const settleWaysOfGame = (gameId: number) => waysOfGame(gameId).map(w => settleWay(w.id)!);
/**
 * The game's copy was just judged (src/ways/copy.ts), its hashes read, or a kept file of it removed: a way with no game file
 * of its own depends on what the copy is to it, so each such way settles (a way being built is its build's to settle).
 */
export function settleWaysOnCopy(gameId: number): WayRow[] {
  return waysOfGame(gameId).filter(w => {
    const p = w.content_id == null ? getPlan(w.plan_id) : null;
    return !!p && !!wayContent(w, p);
  }).map(w => settleWay(w.id)!);
}
