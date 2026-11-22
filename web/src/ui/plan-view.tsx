/**
 * Runtime plans as the admin sees them: what a plan does (program, start, game file, needs, first start), the system
 * files its needs ask for, the JSON editor, and the plan's own dialog with Check, Build from source (or Build its tools),
 * Edit and Delete.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ApiError, del, errorList, fmtSize, get, hasRoute, missingRoute, NOT_YET, post, put, routeMissing, timeAgo,
  type JobView, type NeedSlotView, type Plan, type PlanDetail, type PlanKind, type PlanSpec, type RunView,
} from "../api";
import { Icon } from "./icons";
import { Btn, Callout, Empty, Fold, Label, Modal, Row, Section, Spinner, useLoad, useReveal, useUi } from "./kit";
import { KIND_TONE, planStatus } from "./status";
import { UploadButton, ServerPathModal } from "./files";
import { JobLogModal } from "./job-log";
import { RunModal } from "./run-view";
import { contentLine, parseJson, planBuildAction, platformLabel, programLine, repoHint, repoLabel, repoUrl, runLine, runLook, wayLook } from "../ways/logic";

export const NEED_KIND: Record<string, string> = { bios: "BIOS", firmware: "Firmware", keys: "Keys", other: "File" };
const PLAN_KIND_WORD: Record<string, string> = { recomp: "recomp", port: "port", emulator: "emulator" };

export function RepoLink({ repo }: { repo: string }) {
  const url = repoUrl(repo);
  // a narrow column breaks the name after a slash, never inside a word
  const parts = repoLabel(repo).split("/");
  const label = parts.map((p, i) => <span key={i}>{p}{i < parts.length - 1 && <>/<wbr /></>}</span>);
  return url ? <a href={url} target="_blank" rel="noreferrer">{label} <Icon name="external" size={11} /></a> : <span>{label}</span>;
}

export function PlanLabels({ plan }: { plan: Pick<Plan, "kind" | "status" | "author"> }) {
  const st = planStatus(plan.status);
  return <><Label tone={KIND_TONE[plan.kind] ?? "default"}>{PLAN_KIND_WORD[plan.kind] ?? plan.kind}</Label><Label tone={st.tone}>{st.label}</Label>{plan.author === "ai" && <Label tone="outline">written by the AI importer</Label>}</>;
}

/** one setup step in a line */
function setupLine(s: Record<string, any>): string {
  if (s.run) return `run ${s.run.exe ?? `tool ${s.run.tool}`}${s.run.argv?.length ? " " + s.run.argv.join(" ") : ""}${s.run.wine ? " (under wine)" : ""}`;
  if (s.ini) return `set ${s.ini.path} [${s.ini.section}] ${s.ini.key}=${s.ini.value}`;
  if (s.remove !== undefined) return `remove ${s.remove}`;
  if (s.move) return `move ${s.move.from} → ${s.move.to}`;
  return JSON.stringify(s);
}

/** what the plan does, read from its spec */
export function PlanSummary({ plan }: { plan: Plan }) {
  const s = plan.spec;
  return (
    <div className="plan-sum">
      <div className="row wrap"><b className="plan-name">{plan.name}</b><PlanLabels plan={plan} /></div>
      {plan.statusNote && <div className="dim" style={{ marginTop: 4 }}>{plan.statusNote}</div>}
      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Repo</dt><dd><RepoLink repo={plan.repo} />{plan.homepage && <> · <a href={plan.homepage} target="_blank" rel="noreferrer">homepage <Icon name="external" size={11} /></a></>}</dd>
        <dt>Program</dt><dd>{programLine(s.program, plan.pinned)}{plan.pinned && <div className="dim">{fmtSize(plan.pinned.size)} · sha256 {plan.pinned.sha256.slice(0, 16)}… · pinned {timeAgo(plan.pinned.pinnedAt)}</div>}</dd>
        <dt>Starts</dt><dd><span className="mono">{[s.launch.exe, ...s.launch.argv].join(" ")}</span>{s.launch.cwd && <span className="dim"> in {s.launch.cwd}</span>}{s.launch.env && Object.keys(s.launch.env).length > 0 && <span className="dim"> · {Object.keys(s.launch.env).length} environment setting{Object.keys(s.launch.env).length === 1 ? "" : "s"}</span>}</dd>
        <dt>Game file</dt><dd>{contentLine(s.content)}{s.content && <div className="dim">placed at <span className="mono">{s.content.place}</span>{s.content.ship === false ? " · used by setup, not shipped" : ""}{s.content.normalize === "n64-z64" ? " · byte order fixed to z64" : ""}</div>}</dd>
        {s.needs.length > 0 && <><dt>Needs</dt><dd>{s.needs.map((n, i) => <div key={i}>{NEED_KIND[n.kind] ?? n.kind}: {n.name} <span className="dim">→ <span className="mono">{n.place}</span></span></div>)}</dd></>}
        <dt>First start</dt><dd>{s.firstRun ?? "Straight into the game."}</dd>
        {s.keep.length > 0 && <><dt>Saves kept</dt><dd className="mono">{s.keep.join("  ")}</dd></>}
        {s.seed.length > 0 && <><dt>Set once</dt><dd className="mono">{s.seed.join("  ")}</dd></>}
        {plan.platforms.length > 0 && <><dt>Plays</dt><dd>{plan.platforms.map(platformLabel).join(", ")}</dd></>}
      </dl>
      {s.setup.length > 0 && <Fold label={`Setup on the server (${s.setup.length} step${s.setup.length === 1 ? "" : "s"})`}><pre className="log">{s.setup.map(setupLine).join("\n")}</pre></Fold>}
      {s.program.kind === "source" && <Fold label={`Build steps (${s.program.steps.length})`}><pre className="log">{[...s.program.steps, "", `artifact: ${s.program.artifact}`, ...(s.program.apt?.length ? [`packages: ${s.program.apt.join(" ")}`] : [])].join("\n")}</pre></Fold>}
      {s.notes && <Fold label="Notes"><pre className="log">{s.notes}</pre></Fold>}
    </div>
  );
}

/* ─────────── need slots ─────────── */

function NeedRow({ plan, n, onChanged }: { plan: PlanDetail; n: NeedSlotView; onChanged: () => void }) {
  const { toast, confirm } = useUi();
  const [path, setPath] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const why = plan.needs.missing.find(m => m.index === n.index)?.why ?? null;
  const acc = n.accept;
  const asks = [
    acc?.formats?.length ? acc.formats.map(f => "." + f).join(" ") : null,
    acc?.sizes?.length ? acc.sizes.map(x => fmtSize(x)).join(" or ") : null,
    acc?.hashes?.length ? `${acc.hashes.length} accepted version${acc.hashes.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  const removeFile = async () => {
    if (!n.file || !(await confirm(`Delete ${n.file.name}?`, "The file is deleted from the server. Ways of this plan cannot be built until the need is filled again."))) return;
    try { await del(`/api/v1/content/${n.file.id}`); toast("Deleted", "success"); onChanged(); } catch (e: any) { toast(e.message, "danger"); }
  };
  return (
    <div className="need">
      <div className="row wrap">
        <Label tone="outline">{NEED_KIND[n.kind] ?? n.kind}</Label><b>{n.name}</b>
        <span className="dim">→ <span className="mono">{n.place}</span></span>
        <span className="grow" />
        {n.ok ? <Label tone="success" icon="check">filled</Label> : <Label tone="warning">{n.file ? "not the right file" : "missing"}</Label>}
      </div>
      {(n.note || asks) && <div className="dim" style={{ marginTop: 3 }}>{[n.note, asks ? `Must be: ${asks}` : null].filter(Boolean).join(" · ")}</div>}
      {n.file && (
        <div className="fileline">
          <Icon name={n.ok ? "check" : "alert"} size={13} style={{ color: n.ok ? "var(--success)" : "var(--warning)" }} />
          <span className="mono">{n.file.name}</span><span className="dim">{fmtSize(n.file.size)}{!n.file.onDisk ? " · gone from the disk" : ""}{!n.ok && why ? ` · ${why}` : ""}</span>
          <button className="linkish danger" onClick={() => void removeFile()}>delete</button>
        </div>
      )}
      <div className="acts">
        <UploadButton<{ item: unknown }> kind="outline" label={n.file ? "Upload another file" : "Upload the file"} to={f => `/api/v1/plan/${plan.id}/needs/${n.index}/file?name=${encodeURIComponent(f.name)}`}
          onDone={(_, f) => { setError(null); toast(<>Kept <b>{f.name}</b> for {n.name}</>, "success"); onChanged(); }} onError={setError} />
        <Btn size="sm" kind="outline" icon="folder" onClick={() => setPath(true)}>Use a file on the server</Btn>
      </div>
      {error && <div className="err-line">{error}</div>}
      <ServerPathModal open={path} onClose={() => setPath(false)} title={<>{n.name} — a file on the server</>}
        start={p => post<{ job: JobView }>(`/api/v1/plan/${plan.id}/needs/${n.index}/path`, { path: p })}
        onDone={j => { if (j.state === "done") toast(<>{n.name}: {j.message}</>, "success"); onChanged(); }} />
    </div>
  );
}

/** the files a plan's needs ask for (a BIOS, firmware, keys): each is kept once on the server and placed in every way's package */
export function NeedSlots({ plan, onChanged }: { plan: PlanDetail; onChanged: () => void }) {
  if (!plan.needSlots.length) return <p className="dim">This plan needs no system files.</p>;
  return <div className="needs">{plan.needSlots.map(n => <NeedRow key={n.index} plan={plan} n={n} onChanged={onChanged} />)}</div>;
}

/* ─────────── the editor ─────────── */

/** a starting spec per kind for a plan written by hand (every field the server asks for, with the usual defaults) */
export function specTemplate(kind: PlanKind): PlanSpec {
  const base: PlanSpec = {
    program: { kind: "release", assetPattern: "Windows.*x64.*\\.zip$", channel: "stable" },
    launch: { exe: "Program.exe", argv: [] }, content: null, files: [], setup: [], needs: [], keep: [], seed: [], firstRun: null, notes: "",
  };
  if (kind === "emulator") return { ...base, launch: { exe: "Emulator.exe", argv: ["{content}"] }, content: { kind: "rom", platform: "n64", what: "a game for the console", search: ["the game's name"], accept: { hashes: [], formats: ["z64"] }, place: "games/{name}" } };
  return { ...base, content: { kind: "rom", platform: "n64", what: "the original game, its region and version", search: ["the original game's name"], accept: { hashes: [] }, place: "game.z64" } };
}

interface EditorState { name: string; kind: PlanKind; repo: string; spec: string }

/** the plan as JSON (its spec) with its name, kind and repo; the server checks it and lists what it refuses */
export function PlanEditorModal({ plan, open, onClose, onSaved }: { plan: Plan | null; open: boolean; onClose: () => void; onSaved: (p: PlanDetail) => void }) {
  const { toast } = useUi();
  const [v, setV] = useState<EditorState>({ name: "", kind: "recomp", repo: "", spec: "" });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErrors([]);
    setV(plan ? { name: plan.name, kind: plan.kind, repo: plan.repo, spec: JSON.stringify(plan.spec, null, 2) } : { name: "", kind: "recomp", repo: "", spec: JSON.stringify(specTemplate("recomp"), null, 2) });
  }, [open, plan]);
  const hint = v.repo.trim() ? repoHint(v.repo) : null;
  const parsed = parseJson(v.spec);
  const notice = useReveal(errors.length ? errors : null);
  const save = async () => {
    if (!parsed.ok) { setErrors([parsed.error]); return; }
    setBusy(true); setErrors([]);
    try {
      const body = { name: v.name, kind: v.kind, repo: v.repo, spec: parsed.value };
      const r = plan ? await put<{ item: PlanDetail; warnings?: string[] }>(`/api/v1/plan/${plan.id}`, body) : await post<{ item: PlanDetail; warnings?: string[] }>("/api/v1/plan", body);
      toast(plan ? <>Saved <b>{r.item.name}</b>{r.item.status === "draft" && plan.status !== "draft" ? " — check it before the next build" : ""}</> : <>Added <b>{r.item.name}</b> as a draft — check it before building</>, "success");
      for (const w of r.warnings ?? []) toast(w, "warning");
      onSaved(r.item); onClose();
    } catch (e) { setErrors(errorList(e)); } finally { setBusy(false); }
  };
  const changeKind = (k: PlanKind) => setV(x => (!plan && x.spec === JSON.stringify(specTemplate(x.kind), null, 2) ? { ...x, kind: k, spec: JSON.stringify(specTemplate(k), null, 2) } : { ...x, kind: k }));
  return (
    <Modal open={open} onClose={onClose} wide title={plan ? <>Edit the plan — {plan.name}</> : "New plan"}
      foot={<><span className="left dim">{plan && plan.waysCount > 0 ? `${plan.waysCount} way${plan.waysCount === 1 ? "" : "s"} to play use${plan.waysCount === 1 ? "s" : ""} this plan: a change applies to each.` : ""}</span>
        <Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" icon="save" busy={busy} onClick={() => void save()}>{plan ? "Save" : "Add the plan"}</Btn></>}>
      <div ref={notice}>{errors.length > 0 && <Callout tone="danger"><b>The plan was not saved.</b><ul className="errs">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Callout>}</div>
      <Row label="Name"><input className="input" value={v.name} onChange={e => setV({ ...v, name: e.target.value })} aria-label="Plan name" maxLength={120} /></Row>
      <Row label="Kind" help="An emulator plan plays any game of its platform; a recomp or port plays one game, from its exact data.">
        <select className="select" value={v.kind} onChange={e => changeKind(e.target.value as PlanKind)} aria-label="Plan kind"><option value="recomp">recomp</option><option value="port">port</option><option value="emulator">emulator</option></select>
      </Row>
      <Row label="Repo" error={hint && "error" in hint ? hint.error : null} src={hint && "repo" in hint && hint.repo !== v.repo.trim() ? `read as ${hint.repo}` : undefined}>
        <input className="input" value={v.repo} onChange={e => setV({ ...v, repo: e.target.value })} placeholder="owner/name, a GitHub link, or forgejo:host/owner/name" aria-label="Repo" />
      </Row>
      <div className="form-row">
        <label>Plan</label>
        <div className="field wide">
          <textarea className="textarea code" spellCheck={false} value={v.spec} onChange={e => setV({ ...v, spec: e.target.value })} aria-label="Plan as JSON" rows={22} />
          {!parsed.ok ? <div className="err">{parsed.error}</div>
            : <div className="help">{plan ? "Saving a change to the plan makes it a draft again: check it before the next build. A changed program drops what was pinned." : "A new plan starts as a draft: check it before anything is built from it. The fields are the ones src/ways/types.ts describes."}</div>}
        </div>
      </div>
    </Modal>
  );
}

/* ─────────── actions ─────────── */

/** Check, Build from source (or Build its tools) and Delete, with what each says back */
export function usePlanActions(onChanged: () => void) {
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  const [noBuild, setNoBuild] = useState(false);
  const [logId, setLogId] = useState<number | null>(null);
  const check = async (p: Plan) => {
    setBusy(`check:${p.id}`);
    try {
      const r = await post<{ release: { tag: string; asset: string | null } | null; picks: boolean; pinned: { tag: string } | null; newer: boolean; item: Plan }>(`/api/v1/plan/${p.id}/check`);
      if (p.spec.program.kind === "source") toast(r.picks ? <><b>{p.name}</b> is ready: its build is there</> : <><b>{p.name}</b> builds from source: it is ready once its build has run</>, r.picks ? "success" : "info");
      else if (r.picks && r.release) toast(<><b>{p.name}</b> is ready: {r.release.tag} · {r.release.asset}{r.newer && r.pinned ? <> (newer than the pinned {r.pinned.tag}: a rebuild takes it)</> : null}</>, "success");
      else toast(<><b>{p.name}</b>: {r.item.statusNote ?? "nothing usable in the latest release"}</>, "warning");
      onChanged();
    } catch (e: any) { toast(e.message, "danger"); } finally { setBusy(null); }
  };
  const buildSource = async (p: Plan) => {
    setBusy(`build:${p.id}`);
    try {
      const r = await post<{ job: JobView }>(`/api/v1/plan/${p.id}/build`);
      toast(planBuildAction(p.spec) === "Build its tools" ? <>Building the tools of <b>{p.name}</b></> : <>Building <b>{p.name}</b> from source</>, "success");
      setLogId(r.job.id);
      onChanged();
    } catch (e: any) {
      if (missingRoute(e)) { setNoBuild(true); toast(`Building from source: ${NOT_YET.toLowerCase()}`, "info"); }
      else toast(e.message, "danger");
    } finally { setBusy(null); }
  };
  const remove = async (p: Plan): Promise<boolean> => {
    if (!(await confirm(`Delete ${p.name}?`, "The plan is removed.", { ok: "Delete" }))) return false;
    try { await del(`/api/v1/plan/${p.id}`); toast(<>Deleted <b>{p.name}</b></>, "success"); onChanged(); return true; }
    catch (e) {
      const d = e instanceof ApiError && e.status === 409 ? e.data as { ways?: number; files?: number } : null;
      if (!d || d.ways == null) { toast((e as Error).message, "danger"); return false; }
      const what = [d.ways ? `${d.ways} way${d.ways === 1 ? "" : "s"} to play` : null, d.files ? `${d.files} system file${d.files === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");
      const one = (d.ways ?? 0) + (d.files ?? 0) === 1;
      const after = [d.ways ? "Packages the ways built stay." : null, d.files ? `The system file${d.files === 1 ? " is" : "s are"} deleted from the server.` : null].filter(Boolean).join(" ");
      if (!(await confirm(`${p.name} is in use`, <>{what} belong{one ? "s" : ""} to this plan. Delete {one ? "it" : "them"} with the plan? {after}</>, { ok: "Delete all" }))) return false;
      try { await del(`/api/v1/plan/${p.id}?force=1`); toast(<>Deleted <b>{p.name}</b> and {what}</>, "success"); onChanged(); return true; }
      catch (e2: any) { toast(e2.message, "danger"); return false; }
    }
  };
  const log = <JobLogModal id={logId} onClose={() => setLogId(null)} />;
  return { busy, noBuild, check, buildSource, remove, log };
}

/**
 * "Make it playable" for a plan no game uses yet: a carry run finds the game it plays (or asks which), adds its way,
 * and takes it from there (POST /plan/:id/carry); its run opens once it starts. Offered only by a server with runs.
 */
function useCarryPlan(onChanged: () => void) {
  const { toast } = useUi();
  const [can, setCan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<number | null>(null);
  useEffect(() => { void hasRoute("POST", "/api/v1/plan/0/carry").then(setCan); }, []);
  const carry = async (p: Plan) => {
    setBusy(true);
    try {
      const r = await post<{ item: RunView }>(`/api/v1/plan/${p.id}/carry`, {});
      toast(<>Making <b>{p.name}</b> playable</>, "success");
      if (r?.item?.id) setRunId(r.item.id);
      onChanged();
    } catch (e) {
      if (missingRoute(e)) { routeMissing("POST", "/api/v1/plan/0/carry"); setCan(false); toast(`Making it playable: ${NOT_YET.toLowerCase()}`, "info"); }
      else toast((e as Error).message, "danger");
    } finally { setBusy(false); }
  };
  return { can, busy, carry, runId, open: (id: number) => setRunId(id), closeRun: () => setRunId(null) };
}

/**
 * The plan's runs that have not ended and have no way to play yet (an engine without runs lists none): the game each would
 * make playable, what it waits for, and the way into it — where a run held for a go-ahead is answered (the plan's Delete,
 * below, is the other answer)
 */
function PlanRuns({ runs, onOpen }: { runs: RunView[]; onOpen: (id: number) => void }) {
  return (
    <div className="plan-runs">{runs.map(r => {
      const look = runLook(r);
      return (
        <div key={r.id} className="plan-run">
          <Label tone={look.tone}>{look.label}</Label>
          <span className="grow">{r.gameName ?? <span className="dim">no game yet</span>}<span className="dim"> · {runLine(r)}</span></span>
          <button type="button" className="linkish" onClick={() => onOpen(r.id)}>Open the run</button>
        </div>
      );
    })}</div>
  );
}

/** the plan's own dialog: what it does, the files its needs ask for, the ways that use it, and its actions */
export function PlanDetailModal({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const { data, loading, error, reload } = useLoad(() => (id ? get<{ item: PlanDetail }>(`/api/v1/plan/${id}`) : Promise.resolve(null)), [id]);
  // its runs with no way yet (a plan whose game is not in the library waits for a go-ahead); none on an engine without runs
  const { data: runs, reload: reloadRuns } = useLoad(() => (id
    ? get<{ items: RunView[] }>(`/api/v1/runs?planId=${id}&open=1`).then(r => r.items.filter(x => x.wayId == null), e => { if (missingRoute(e)) return [] as RunView[]; throw e; })
    : Promise.resolve([] as RunView[])), [id]);
  const [editing, setEditing] = useState(false);
  const changed = () => { void reload(); void reloadRuns(); onChanged(); };
  const act = usePlanActions(changed);
  const carrying = useCarryPlan(changed);
  const p = data?.item ?? null;
  const planRuns = runs ?? [];
  const builds = p ? planBuildAction(p.spec) : null;
  const foot: ReactNode = p ? (
    <>
      <span className="left"><Btn kind="danger" icon="trash" onClick={async () => { if (await act.remove(p)) onClose(); }}>Delete</Btn></span>
      <Btn icon="refresh" busy={act.busy === `check:${p.id}`} onClick={() => void act.check(p)}>Check</Btn>
      {builds && !act.noBuild && <Btn icon="hammer" busy={act.busy === `build:${p.id}`} onClick={() => void act.buildSource(p)}>{builds}</Btn>}
      <Btn icon="pencil" onClick={() => setEditing(true)}>Edit</Btn>
      <Btn onClick={onClose}>Close</Btn>
    </>
  ) : <Btn onClick={onClose}>Close</Btn>;
  return (
    <>
      <Modal open={id != null} onClose={onClose} wide title={p ? <>Plan — {p.name}</> : "Plan"} foot={foot}>
        {loading && !p ? <Spinner /> : !p ? <Empty title="No such plan" icon="alert">{error}</Empty> : (
          <>
            <PlanSummary plan={p} />
            <Section title="System files"><NeedSlots plan={p} onChanged={changed} /></Section>
            <Section title={`Ways to play (${p.ways.length})`}>
              {!p.ways.length && planRuns.length > 0 ? <PlanRuns runs={planRuns} onOpen={carrying.open} /> : !p.ways.length ? (
                <div className="row wrap">
                  <span className="dim grow">No game uses this plan yet. Add it from a game's Ways to play tab{carrying.can ? ", or let ludarr find the game it plays and make it playable" : ""}.</span>
                  {carrying.can && <Btn kind="primary" size="sm" icon="play" busy={carrying.busy} onClick={() => void carrying.carry(p)}>Make it playable</Btn>}
                </div>
              ) : (
                <table className="table compact"><tbody>{p.ways.map(w => {
                  // a way with its files reads as waiting while this plan is not ready
                  const look = wayLook(w, p.status);
                  return <tr key={w.id}><td><Link to={`/games/${w.gameId}?tab=ways`} onClick={onClose}>{w.gameName}</Link></td><td><Label tone={look.tone}>{look.label}</Label></td><td className="dim">{w.statusNote ?? ""}</td></tr>;
                })}</tbody></table>
              )}
            </Section>
          </>
        )}
      </Modal>
      <PlanEditorModal plan={p} open={editing && !!p} onClose={() => setEditing(false)} onSaved={changed} />
      {act.log}
      <RunModal id={carrying.runId} onClose={carrying.closeRun} onChanged={changed} />
    </>
  );
}
