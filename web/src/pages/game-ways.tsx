/**
 * The game page's Ways to play: each way (its plan, status and what stands in the way of a build), its game file
 * (upload, a file on the server, the indexers when the server can search for one), the game's copy on the server as the
 * way sees it, the way's carry run (where it is, what it does now, what it asks), Make it playable, Build, Rebuild with
 * the AI, the plan's editor and Remove; the game files kept for the game (a second copy of the game's copy can be freed);
 * and adding a way from a repo or a plan ludarr has.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError, del, fmtDate, fmtSize, get, hasRoute, missingRoute, NOT_YET, post, put, routeMissing, sentence,
  type ContentFile, type CopyView, type GameDetail, type JobView, type Plan, type RunView, type UploadResult, type Way,
} from "../api";
import { subscribe, useEvents } from "../events";
import { Icon } from "../ui/icons";
import { Btn, Callout, Empty, Label, Modal, Progress, Row, Section, useLoad, useUi } from "../ui/kit";
import { COMPAT_TONE, KIND_TONE, planStatus } from "../ui/status";
import { ServerPathModal, UploadButton } from "../ui/files";
import { cancelJob, JobLogModal, Queued } from "../ui/job-log";
import { PlanEditorModal, RepoLink } from "../ui/plan-view";
import { WayStartLine } from "../ui/launch-editor";
import { RunModal, RunPanel, useRun } from "../ui/run-view";
import {
  aboutAiSetup, canCarry, contentLine, copyLine, identityWords, jobEnd, jobWay, plansFor, platformLabel, runOpen, runWorking, secondCopy, wayCard, type SecondCopy,
} from "../ways/logic";

/**
 * Kept files this page has settled: freed, found by the server not to be a second copy (its words came as a warning), or
 * still being compared when the answer did not come back. None of them is offered again until the page is opened anew.
 */
const settled = new Set<number>();
/**
 * "Free 54.2 GB (keeps one copy)": a second copy of the game's copy becomes a link to it (POST /content/:id/free-duplicate).
 * The server compares the bytes first and changes nothing when they differ; a guess by name and size says so before it asks.
 */
function useFreeCopy(onChanged: () => void) {
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState<number | null>(null);
  const [, redraw] = useState(0);
  const free = async (f: ContentFile, s: SecondCopy) => {
    const size = fmtSize(s.bytes);
    const body = s.sure
      ? <>The second copy, <span className="mono">{f.name}</span>, becomes a link to the game's copy on the server: the same bytes stay on the disk once, and nothing that uses either changes.</>
      : <>ludarr first compares <span className="mono">{f.name}</span> with the game's copy on the server, byte for byte (reading {size} can take a few minutes). Only when they are the same does it become a link to the copy: the same bytes stay on the disk once, and nothing that uses either changes. Otherwise nothing is changed.</>;
    if (!(await confirm(`Free ${size}?`, body, { ok: `Free ${size}`, kind: "primary" }))) return;
    setBusy(f.id);
    try {
      const r = await post<{ freedBytes: number }>(`/api/v1/content/${f.id}/free-duplicate`);
      settled.add(f.id);
      toast(`Freed ${fmtSize(r?.freedBytes ?? s.bytes)}: one copy is kept`, "success");
      onChanged();
    } catch (e) {
      if (missingRoute(e)) toast(`Freeing a second copy: ${NOT_YET.toLowerCase()}`, "info");
      else if (e instanceof ApiError && e.status === 409) { settled.add(f.id); toast(sentence(e.message), "warning"); }
      // the answer was cut off (a long comparison outlives the connection): the server may still be at it
      else if (!(e instanceof ApiError) || e.status === 0) { settled.add(f.id); toast(`No answer came back: ludarr may still be comparing ${f.name} with the copy. Look at the kept files again in a few minutes.`, "warning"); }
      else toast(sentence((e as Error).message), "danger");
    } finally { setBusy(null); redraw(n => n + 1); }
  };
  /** what freeing a kept file would give back, or null: no second copy, or settled on this page already */
  const spare = (f: ContentFile, copy: CopyView | null | undefined, used: boolean) => (settled.has(f.id) ? null : secondCopy(f, copy, used));
  return { busy, free, spare };
}

const PLAN_KIND_WORD: Record<string, string> = { recomp: "recomp", port: "port", emulator: "emulator" };

/** "Rebuild with the AI": the AI importer works the plan out again from its repo, for this game and its file */
function RebuildModal({ w, gameId, open, onClose, onStarted }: { w: Way; gameId: number; open: boolean; onClose: () => void; onStarted: (job: JobView) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [notYet, setNotYet] = useState(false);
  useEffect(() => { if (open) { setNote(""); setError(null); setNotYet(false); } }, [open]);
  const start = async () => {
    if (!w.plan) return;
    setBusy(true); setError(null);
    try {
      const r = await post<{ job: JobView }>("/api/v1/plan/construct", { repo: w.plan.repo, planId: w.planId, gameId, ...(w.contentId ? { contentId: w.contentId } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      onStarted(r.job); onClose();
    } catch (e) {
      if (missingRoute(e)) setNotYet(true);
      else setError({ message: String((e as Error).message), status: e instanceof ApiError ? e.status : 0 });
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={<>Rebuild with the AI — {w.plan?.name ?? w.planName}</>}
      foot={<><Btn onClick={onClose}>Cancel</Btn>{!notYet && <Btn kind="accent" icon="sparkles" busy={busy} onClick={() => void start()}>Start</Btn>}</>}>
      {notYet ? <Callout tone="info">{NOT_YET}</Callout> : <>
        <p className="dim" style={{ marginBottom: 8 }}>The AI importer reads <RepoLink repo={w.plan?.repo ?? ""} /> again and tests a new plan with this game{w.file ? <> and its file <span className="mono">{w.file.name}</span></> : null} before saving it over this one. The plan's other ways get the new plan too.</p>
        {error && <Callout tone="danger">{sentence(error.message)}{error.status === 409 && aboutAiSetup(error.message) && <> · <Link to="/settings/importers">Settings → Importers</Link></>}</Callout>}
        <Row label="What should change" help="Optional: what went wrong, or what to do differently.">
          <textarea className="textarea prose" rows={4} value={note} onChange={e => setNote(e.target.value)} autoFocus maxLength={2000} aria-label="What should change" />
        </Row>
      </>}
    </Modal>
  );
}

/** the plan editor for a way's plan (the way only carries part of the plan) */
function EditPlanFor({ planId, onClose, onSaved }: { planId: number | null; onClose: () => void; onSaved: () => void }) {
  const { data } = useLoad(() => (planId ? get<{ item: Plan }>(`/api/v1/plan/${planId}`) : Promise.resolve(null)), [planId]);
  return <PlanEditorModal plan={data?.item ?? null} open={planId != null && !!data} onClose={onClose} onSaved={onSaved} />;
}

export function WayCard({ w, plan, g, files, tick, findable, onChanged, onLog, onEditPlan, onNoFind, used = [] }: {
  w: Way; plan: Plan | null; g: GameDetail; files: ContentFile[]; tick: JobView | null; findable: boolean;
  onChanged: () => void; onLog: (id: number) => void; onEditPlan: (planId: number) => void; onNoFind: () => void;
  /** the kept files the game's ways use (each way's game file) */
  used?: number[];
}) {
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [misfit, setMisfit] = useState<ContentFile | null>(null);
  const [pathOpen, setPathOpen] = useState(false);
  const [rebuild, setRebuild] = useState(false);
  const [showRun, setShowRun] = useState<number | null>(null);
  // the job on the card (the way's build, its plan's build for this game, its game file being made or the game's copy
  // taken in, queued or running), the status it reads, the plan's first build for this game, and the repin action
  const { job, building, look: st, jobTitle, perGameFirst, repin } = wayCard(w, plan, tick);
  const name = w.plan?.name ?? w.planName ?? "a plan that is gone";
  /** a file whose own bytes say it is sealed for the console is never offered for a way: nothing can open it (it stays
   *  in the kept files below); nor is a kept game folder for a way whose game file is one file (a folder kept as what the
   *  file is made from is the make's to read) */
  const acceptable = (f: ContentFile) => !f.identity?.sealed && (f.shape !== "folder" || w.content?.kind === "folder");
  const others = files.filter(f => f.role === "game" && f.id !== w.contentId && acceptable(f));
  // the way's carry run while it is open, kept current; once it ends the listing's next read drops it
  const seed = w.run && runOpen(w.run.state) ? w.run : null;
  const { run: runView, tick: runTick, reload: reloadRun } = useRun(seed?.id ?? null);
  const live: RunView | null = runView && runOpen(runView.state) ? runView : null;
  // the run shows the job it follows itself (its words, its progress, its log): the card does not show it twice
  const covered = !!(live && job && runWorking(live.state) && live.now?.jobId === job.id);
  // while the run asks for the game file, the ask's own controls (pick it, upload it when it can, look again) take the
  // place of the card's; an upload never brings a folder, nor what the ask says is too large to send. Until the run is
  // read, the way listing's word on its ask counts
  const asked = live ? live.ask : seed?.ask ?? null;
  const asksFile = asked?.code === "file";
  const uploadable = w.content?.kind !== "folder" && !(asked?.code === "file" && !asked.canUpload);
  const copy = copyLine(w.copy);
  /** the game data may come as a folder (a game folder, or what the file is made from) */
  const takesFolder = w.content?.kind === "folder" || (!!w.content?.make && w.content.make.input.shape !== "file");
  const freeing = useFreeCopy(onChanged);
  const spare = files.map(f => ({ f, s: freeing.spare(f, w.copy, f.id === w.contentId || used.includes(f.id)) })).find((x): x is { f: ContentFile; s: SecondCopy } => x.s != null) ?? null;
  const carry = canCarry(w, live ?? w.run, job);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast(e.message, "danger"); } finally { setBusy(null); }
  };
  const build = async (opts: { repin?: boolean }, replace = false): Promise<void> => {
    setBusy(opts.repin ? "repin" : "build");
    try {
      await post<{ job: JobView }>(`/api/v1/way/${w.id}/build`, { ...opts, ...(replace ? { replace: true } : {}) });
      toast(<>Building <b>{g.name}</b> through {name}</>, "success");
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.current === "native") {
        setBusy(null);
        if (await confirm("Replace the PC copy?", <><b>{g.name}</b> has a PC copy. Building this way makes its package the game's copy in place of the PC one.</>, { ok: "Replace", kind: "warning" })) return build(opts, true);
        return;
      }
      toast((e as Error).message, "danger");
    } finally { setBusy(null); }
  };
  const takeFile = (f: ContentFile) => act(`use:${f.id}`, async () => {
    try { await put(`/api/v1/way/${w.id}`, { contentId: f.id }); setMisfit(null); setFileError(null); toast(<><b>{f.name}</b> is this way's game file now</>, "success"); onChanged(); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.verdict) { setMisfit(f); setFileError(sentence(e.message)); return; }
      throw e;
    }
  });
  const accept = (f: ContentFile) => act(`accept:${f.id}`, async () => {
    if (!(await confirm(`Accept ${f.name}?`, <>Its sha1 joins the versions this way accepts, and it becomes the way's game file. Only do this for a file you know is the right game: a wrong file builds a game that does not start.</>, { ok: "Accept it", kind: "warning" }))) return;
    await post(`/api/v1/way/${w.id}/accept-file`, { contentId: f.id });
    setMisfit(null); setFileError(null);
    toast(<><b>{f.name}</b> is accepted for {name}</>, "success"); onChanged();
  });
  const find = () => act("find", async () => {
    try {
      const r = await post<{ job?: JobView }>(`/api/v1/way/${w.id}/find-files`);
      toast(<>Looking for the game file on the indexers</>, "success");
      if (r?.job) onLog(r.job.id);
      onChanged();
    } catch (e) {
      if (missingRoute(e)) { routeMissing("POST", "/api/v1/way/0/find-files"); onNoFind(); toast(`Finding the file on the indexers: ${NOT_YET.toLowerCase()}`, "info"); return; }
      throw e;
    }
  });
  // a plan whose build needs the game file (sm64ex) is built per game: its first build, for this way, pins its commit
  const firstBuild = () => act("first", async () => {
    const r = await post<{ job: JobView }>(`/api/v1/plan/${w.planId}/build`, { wayId: w.id });
    toast(<>Building <b>{name}</b> from source for <b>{g.name}</b></>, "success");
    if (r?.job) onLog(r.job.id);
    onChanged();
  });
  const check = () => act("check", async () => {
    const r = await post<{ picks: boolean; item: Plan }>(`/api/v1/plan/${w.planId}/check`);
    toast(r.picks ? <><b>{name}</b> is ready</> : <><b>{name}</b>: {r.item.statusNote ?? "nothing usable in the latest release"}</>, r.picks ? "success" : "warning");
    onChanged();
  });
  const remove = () => act("remove", async () => {
    if (!(await confirm(`Remove ${name} from ${g.name}?`, "The way to play is removed. The package it built stays, and so do the game files kept for the game.", { ok: "Remove" }))) return;
    await del(`/api/v1/way/${w.id}`);
    toast("Removed", "success"); onChanged();
  });
  // "Make it playable": a carry run takes the way from here to a game members install (a PC copy is replaced only when
  // the admin says so, as Build asks)
  const makePlayable = () => act("carry", async () => {
    let replace = false;
    if (w.replaces === "native") {
      if (!(await confirm("Replace the PC copy?", <><b>{g.name}</b> has a PC copy members play. Making this way playable builds its package as the game's copy in place of the PC one.</>, { ok: "Replace", kind: "warning" }))) return;
      replace = true;
    }
    try {
      const r = await post<{ item: RunView }>(`/api/v1/way/${w.id}/carry`, replace ? { replace: true } : {});
      toast(<>Making <b>{g.name}</b> playable through {name}</>, "success");
      onChanged();
      if (r?.item?.id) setShowRun(r.item.id);
    } catch (e) {
      if (missingRoute(e)) { toast(`Making it playable: ${NOT_YET.toLowerCase()}`, "info"); return; }
      throw e;
    }
  });
  const runChanged = () => { reloadRun(); onChanged(); };
  const blockers = w.blockers.filter(b => b.code !== "building");
  /** reasons not already shown in the game file or system files part */
  const listed = blockers.filter(b => !(b.code === "file" && w.content) && !(b.code === "needs" && w.needs.missing.length > 0));
  const cancel = () => act("cancel", async () => { if (job) { toast(await cancelJob(job.id)); onChanged(); } });
  return (
    <div className="way">
      <div className="way-head">
        <Label tone={KIND_TONE[w.planKind ?? ""] ?? "default"}>{PLAN_KIND_WORD[w.planKind ?? ""] ?? w.planKind ?? "plan"}</Label>
        <h4>{name}</h4>
        <Label tone={st.tone}>{st.label}</Label>
        <span className="grow" />
        {w.plan && <span className="dim">plan <Label tone={planStatus(w.plan.status).tone}>{planStatus(w.plan.status).label}</Label></span>}
      </div>
      <div className="way-sub">
        {w.plan ? <RepoLink repo={w.plan.repo} /> : "its plan is gone"}
        {plan?.pinned && <> · {plan.spec.program.kind === "source" ? "built" : "pinned to"} {plan.pinned.tag}</>}
        {w.plan && <> · <Link to={`/settings/runtimes?plan=${w.planId}`}>the plan</Link></>}
        {w.packageId && w.status === "built" && <> · built package #{w.packageId}</>}
      </div>
      {/* what is missing is said in its own part below; the note matters when a build failed */}
      {w.statusNote && w.status === "failed" && <div className="way-note">{sentence(w.statusNote)}</div>}
      {/* how the copy this way built starts (the plan's start, or the one set by hand), and Change… */}
      <WayStartLine g={g} w={w} onChanged={onChanged} />

      {w.content && (
        <div className="part">
          <h5>Game file</h5>
          <div className="dim">Needs {contentLine(w.content)}</div>
          {w.file ? (
            <div className="fileline copyline">
              <Icon name={w.fileCheck?.ok ? "check" : "alert"} size={13} style={{ color: w.fileCheck?.ok ? "var(--success)" : "var(--warning)" }} />
              <div className="grow fl-body">
                <span className="mono">{w.file.name}</span>
                <span className="dim">{fmtSize(w.file.size)}{w.file.platform ? ` · ${platformLabel(w.file.platform)}` : ""}{w.file.normalized ? ` · ${w.file.normalized}` : ""}{!w.file.onDisk ? " · gone from the disk" : ""}</span>
                <span className={w.fileCheck?.ok ? "ok-text" : "warn-text"}>{w.fileCheck?.ok ? (w.fileCheck.matched?.label ? `the version this needs (${w.fileCheck.matched.label})` : w.fileCheck.matched ? "the version this needs" : "fits") : sentence(w.fileCheck?.why ?? "not checked")}</span>
                {w.fileCheck && !w.fileCheck.ok && acceptable(w.file) && <button className="linkish" disabled={!!busy} onClick={() => void accept(w.file!)}>accept it anyway</button>}
              </div>
            </div>
          ) : !copy && w.fromConsoleCopy ? (
            <div className="fileline"><Icon name="box" size={13} /><span>The game's console copy stands in for the game file: the build takes the dump from it.</span></div>
          ) : copy?.tone !== "ok" ? <div className="fileline"><Icon name="alert" size={13} style={{ color: "var(--warning)" }} /><span>No game file yet.</span></div> : null}
          {copy && (!w.file || !w.fileCheck?.ok) && (
            <div className="fileline copyline">
              <Icon name={copy.icon} size={13} style={{ color: copy.tone === "ok" ? "var(--success)" : copy.tone === "warn" ? "var(--warning)" : undefined }} /><span className="grow">{copy.text}</span>
            </div>
          )}
          {spare && (
            <div className="fileline copyline dimline">
              <Icon name="copy" size={13} />
              <div className="grow fl-body">
                {spare.s.sure
                  ? <span>The game's copy is kept a second time on the server (<span className="mono">{spare.f.name}</span>, {fmtSize(spare.s.bytes)}).</span>
                  : <span>A file kept for the game has the copy's name and size (<span className="mono">{spare.f.name}</span>, {fmtSize(spare.s.bytes)}): it may be the same bytes kept a second time.</span>}
                <button type="button" className="linkish" disabled={freeing.busy != null} onClick={() => void freeing.free(spare.f, spare.s)}>{freeing.busy === spare.f.id ? "freeing…" : `Free ${fmtSize(spare.s.bytes)} (keeps one copy)`}</button>
              </div>
            </div>
          )}
          {others.length > 0 && (
            <div className="others">
              {others.map(f => (
                <div key={f.id} className="fileline dimline">
                  <Icon name="file" size={13} /><span className="mono">{f.name}</span><span className="dim">{fmtSize(f.size)} · kept {fmtDate(f.createdAt)}{identityWords(f.identity) ? ` · ${identityWords(f.identity)}` : ""}</span>
                  <button className="linkish" disabled={!!busy} onClick={() => void takeFile(f)}>use it for this way</button>
                  {misfit?.id === f.id && <button className="linkish" disabled={!!busy} onClick={() => void accept(f)}>accept it anyway</button>}
                </div>
              ))}
            </div>
          )}
          {fileError && <div className="err-line">{fileError}</div>}
          {!building && !asksFile && (
            <div className="acts">
              {uploadable && <UploadButton<UploadResult> kind="outline" label={w.file ? "Upload another file" : "Upload the file"} to={f => `/api/v1/content?gameId=${g.id}&wayId=${w.id}&name=${encodeURIComponent(f.name)}`}
                onError={m => setFileError(sentence(m))}
                onDone={(r, f) => {
                  setFileError(null);
                  const mine = r.checks?.find(c => c.wayId === w.id);
                  if (r.attached?.includes(w.id)) toast(<>Kept <b>{r.item.name}</b>: it is this way's game file now</>, "success");
                  else if (mine && !mine.ok) { setMisfit(r.item); setFileError(`${f.name} is kept, but it is ${mine.why ?? "not the file this way needs"}.`); }
                  else toast(<>Kept <b>{r.item.name}</b>{r.duplicate ? " (it was kept already)" : ""}</>, "success");
                  onChanged();
                }} />}
              <Btn size="sm" kind="outline" icon="folder" onClick={() => setPathOpen(true)}>{takesFolder ? "Use a file or folder on the server" : "Use a file on the server"}</Btn>
              {findable && <Btn size="sm" kind="outline" icon="search" busy={busy === "find"} onClick={() => void find()}>Find it on my indexers</Btn>}
            </div>
          )}
        </div>
      )}

      {w.needs.missing.length > 0 && (
        <div className="part">
          <h5>System files</h5>
          <div className="fileline"><Icon name="alert" size={13} style={{ color: "var(--warning)" }} /><span>The plan still needs {w.needs.missing.map(m => m.name).join(", ")}.</span><Link to={`/settings/runtimes?plan=${w.planId}`}>Fill {w.needs.missing.length === 1 ? "it" : "them"} with the plan</Link></div>
        </div>
      )}

      {/* the job the card knows (its message, bytes of total) stands in until the job's own first tick reaches the run */}
      {seed && <RunPanel seed={seed} view={live} tick={runTick ?? (covered ? job : null)} onChanged={runChanged} onLog={onLog} onOpen={() => setShowRun(seed.id)}
        at={{ planId: w.planId, planName: name, gameId: g.id, gameName: g.name, wayId: w.id }} />}

      {building ? (covered ? null : (
        <div className="part">
          <h5>{jobTitle}</h5>
          {!job ? <span className="dim">Starting…</span> : job.state === "queued" ? <Queued job={job} />
            : <Progress value={job.progress} tone="queue" text={`${Math.round(job.progress * 100)}%${job.message ? ` · ${job.message}` : ""}`} />}
          <div className="acts">
            {job && <Btn size="sm" kind="outline" icon="terminal" onClick={() => onLog(job.id)}>Open the log</Btn>}
            {job && <Btn size="sm" kind="outline" icon="x" busy={busy === "cancel"} onClick={() => void cancel()}>Cancel</Btn>}
          </div>
        </div>
      )) : (
        <>
          {listed.length > 0 && (
            <div className="part">
              <h5>Before it can be built</h5>
              <ul className="blockers">{listed.map((b, i) => (
                <li key={i}>{sentence(b.error)}{b.code === "plan" && (perGameFirst
                  ? <> <button className="linkish" disabled={!!busy || blockers.some(x => x.code === "file" || x.code === "needs")} onClick={() => void firstBuild()}>{busy === "first" ? "starting…" : "build it from source for this game"}</button></>
                  : <> <button className="linkish" disabled={!!busy} onClick={() => void check()}>{busy === "check" ? "checking…" : "check the plan"}</button></>)}</li>
              ))}</ul>
            </div>
          )}
          <div className="acts way-acts">
            {carry && <Btn kind="primary" icon="play" busy={busy === "carry"} disabled={!!busy} title="Finds or makes the game file, builds and checks the way, and offers it in Ahoy; it asks you only for what it cannot get" onClick={() => void makePlayable()}>Make it playable</Btn>}
            <Btn kind="success" icon="hammer" busy={busy === "build"} disabled={!w.canBuild || !!busy} title={w.canBuild ? undefined : blockers.map(b => b.error).join("; ")} onClick={() => void build({})}>{w.status === "built" ? "Rebuild" : "Build"}</Btn>
            {repin && (
              <Btn kind="outline" icon="refresh" busy={busy === "repin"} disabled={!w.canBuild || !!busy}
                title={`${w.status === "built" ? "Builds again" : "Builds"} with the program's newest release, which becomes the pin once it builds; ${w.status === "built" ? "Rebuild" : "Build"} uses the pinned ${plan?.pinned?.tag ?? "one"}${w.canBuild ? "" : `. Not now: ${blockers.map(b => b.error).join("; ")}`}`}
                onClick={() => void build({ repin: true })}>{repin}</Btn>
            )}
            {w.plan && <Btn kind="accent" icon="sparkles" disabled={!!busy} onClick={() => setRebuild(true)}>Rebuild with the AI</Btn>}
            {w.plan && <Btn kind="outline" icon="pencil" disabled={!!busy} onClick={() => onEditPlan(w.planId)}>Edit the plan</Btn>}
            <Btn kind="ghost" icon="trash" busy={busy === "remove"} disabled={!!busy && busy !== "remove"} onClick={() => void remove()}>Remove</Btn>
            {w.replaces === "native" && w.canBuild && <span className="dim">Building replaces the game's PC copy.</span>}
          </div>
        </>
      )}
      <ServerPathModal open={pathOpen} onClose={() => setPathOpen(false)} title={<>{g.name} — {takesFolder ? "its game data" : "a file"} on the server</>}
        intro={<>For {name}: {contentLine(w.content)}.</>}
        help={takesFolder ? "A file or a folder in the downloads folder, a root folder or a download client's mapped folder. It stays where it is." : undefined}
        placeholder={takesFolder ? "/downloads/the game folder" : undefined}
        start={p => post<{ job: JobView }>("/api/v1/content/path", { path: p, gameId: g.id, wayId: w.id })}
        onDone={j => {
          // a file kept that is not the one this way needs: kept for the game, but the way still has no file
          if (jobEnd(j) === "warn") { setFileError(sentence(j.message)); toast(<>{sentence(j.message)}</>, "warning"); }
          else if (j.state === "done") toast(<>{sentence(j.message)}</>, "success");
          onChanged();
        }} />
      <RebuildModal w={w} gameId={g.id} open={rebuild} onClose={() => setRebuild(false)} onStarted={j => { toast(<>The AI importer is working on {name}</>, "success"); onLog(j.id); onChanged(); }} />
      <RunModal id={showRun} onClose={() => setShowRun(null)} onChanged={onChanged} />
    </div>
  );
}

function AddWayModal({ g, used, open, onClose, onAdded }: { g: GameDetail; used: number[]; open: boolean; onClose: () => void; onAdded: () => void }) {
  const { toast } = useUi();
  const { data } = useLoad(() => (open ? get<{ items: Plan[] }>("/api/v1/plan") : Promise.resolve(null)), [open]);
  const [planId, setPlanId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** the server's word that the chosen recomp or port plays another game (an admin who knows better adds it anyway) */
  const [wrong, setWrong] = useState<string | null>(null);
  useEffect(() => { if (open) { setPlanId(""); setError(null); setWrong(null); } }, [open]);
  const plans = (data?.items ?? []).filter(p => !used.includes(p.id));
  // the plans that play this game first: a recomp or port of it, an emulator of one of its platforms
  const { fits, others } = plansFor(g, plans);
  const add = async (force = false) => {
    if (planId === "") return;
    setBusy(true); setError(null); setWrong(null);
    try {
      const r = await post<{ item: Way; warnings?: string[] }>(`/api/v1/game/${g.id}/ways`, { planId, ...(force ? { force: true } : {}) });
      toast(<><b>{g.name}</b> can be played through {r.item.planName} now</>, "success");
      for (const w of r.warnings ?? []) toast(w, "warning");
      onAdded(); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.wrongGame) { setWrong(sentence(e.message)); return; }
      const list = e instanceof ApiError && Array.isArray(e.data?.errors) ? e.data.errors as string[] : null;
      setError(list?.length ? `${(e as Error).message}: ${list.join("; ")}` : (e as Error).message);
    } finally { setBusy(false); }
  };
  const chosen = plans.find(p => p.id === planId);
  const option = (p: Plan) => <option key={p.id} value={p.id}>{p.name} ({PLAN_KIND_WORD[p.kind] ?? p.kind}{p.status !== "ready" ? `, ${planStatus(p.status).label.toLowerCase()}` : ""})</option>;
  return (
    <Modal open={open} onClose={onClose} title={<>Add a way to play — {g.name}</>}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" icon="plus" busy={busy} disabled={planId === ""} onClick={() => void add()}>Add it</Btn></>}>
      <div className="choice">
        <Icon name="gitBranch" size={18} />
        <div className="grow"><b>From a repo</b><div className="dim">The repo of a recomp, port or emulator becomes a plan for this game.</div></div>
        <Link className="btn" to={`/add/repo?gameId=${g.id}`}>Start</Link>
      </div>
      <div className="choice">
        <Icon name="box" size={18} />
        <div className="grow">
          <b>A plan ludarr has</b>
          <div className="dim">An emulator plan gets this game's names and its own game file.</div>
          {data && !plans.length ? <p className="dim" style={{ marginTop: 8 }}>{data.items.length ? "Every plan is a way to play this game already." : "There are no plans yet."}</p> : (
            <select className="select" style={{ marginTop: 8 }} value={planId} onChange={e => { setPlanId(e.target.value ? Number(e.target.value) : ""); setWrong(null); setError(null); }} aria-label="Plan">
              <option value="">Choose a plan…</option>
              {fits.length > 0 && others.length > 0 ? <>
                <optgroup label={`For ${g.name}`}>{fits.map(option)}</optgroup>
                <optgroup label="Other plans">{others.map(option)}</optgroup>
              </> : plans.map(option)}
            </select>
          )}
          {chosen && <div className="dim" style={{ marginTop: 6 }}>{contentLine(chosen.spec.content)}</div>}
          {wrong && <div className="warn-line">{wrong} · <button type="button" className="linkish" disabled={busy} onClick={() => void add(true)}>add it anyway</button></div>}
          {error && <div className="err-line">{sentence(error)}</div>}
        </div>
      </div>
    </Modal>
  );
}

/** where a kept file came from, in the admin's words */
const SOURCE_WORD: Record<string, string> = { upload: "uploaded", path: "the server", package: "its console copy", indexer: "the indexers", made: "made by ludarr", inbox: "its inbox folder" };

export function KeptFiles({ files, ways, onChanged }: { files: ContentFile[]; ways: Way[]; onChanged: () => void }) {
  const { toast, confirm } = useUi();
  const freeing = useFreeCopy(onChanged);
  const copy = ways.find(w => w.copy)?.copy ?? null;
  const remove = async (f: ContentFile) => {
    if (!(await confirm(`Delete ${f.name}?`, "The file is deleted from the server. A way that used it keeps its package, and needs a game file again for its next build."))) return;
    try { await del(`/api/v1/content/${f.id}`); toast("Deleted", "success"); onChanged(); } catch (e: any) { toast(e.message, "danger"); }
  };
  return (
    <div className="kept-files"><Section title={`Game files kept for this game (${files.length})`}>
      <div className="table-wrap"><table className="table compact">
        <thead><tr><th>File</th><th>Platform</th><th>Size</th><th>From</th><th>Kept</th><th>Used by</th><th className="actions"></th></tr></thead>
        <tbody>{files.map(f => {
          const by = ways.filter(w => w.contentId === f.id).map(w => w.plan?.name ?? w.planName ?? `way ${w.id}`);
          const id = identityWords(f.identity);
          const spare = freeing.spare(f, copy, by.length > 0);
          return (
            <tr key={f.id}>
              <td className="mono" style={{ overflowWrap: "anywhere" }}>{f.name}{f.shape === "folder" && <span className="dim"> (a folder)</span>}{!f.onDisk && <Label tone="danger">gone from the disk</Label>}<div className="dim" style={{ wordBreak: "break-all" }}>sha1 {f.hashes.sha1 ?? "—"}</div>
                {id && <div className="dim">{id}</div>}
                {spare != null && (
                  <div className="td-act">
                    {!spare.sure && <span className="dim">It has the copy's name and size: </span>}
                    <button className="linkish" disabled={freeing.busy != null} onClick={() => void freeing.free(f, spare)}>{freeing.busy === f.id ? "freeing…" : `Free ${fmtSize(spare.bytes)} (keeps one copy)`}</button>
                  </div>
                )}</td>
              <td>{f.platform ? platformLabel(f.platform) : <span className="dim">—</span>}</td>
              <td className="nowrap">{fmtSize(f.size)}</td>
              <td>{SOURCE_WORD[f.source] ?? f.source}</td>
              <td className="dim nowrap">{fmtDate(f.createdAt)}</td>
              <td>{by.length ? by.join(", ") : <span className="dim">no way</span>}</td>
              <td className="actions"><button className="ibtn danger" title="Delete the file" aria-label={`Delete ${f.name}`} onClick={() => void remove(f)}><Icon name="trash" /></button></td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </Section></div>
  );
}

export function WaysTab({ g, ways, research, reloadWays }: { g: GameDetail; ways: Way[] | null; research: { platform: string; reason: string; link?: string }[]; reloadWays: () => void }) {
  const { data: files, reload: reloadFiles } = useLoad(() => get<{ items: ContentFile[] }>(`/api/v1/content?gameId=${g.id}`), [g.id]);
  const { data: plans, reload: reloadPlans } = useLoad(() => get<{ items: Plan[] }>("/api/v1/plan"), [g.id]);
  const planOf = new Map((plans?.items ?? []).map(p => [p.id, p]));
  const reload = () => { reloadWays(); void reloadFiles(); void reloadPlans(); };
  useEvents(["job", "catalog", "package"], () => reload(), [g.id]);
  // a run of this game that starts, ends, moves on or asks something new: the cards follow (its progress ticks do not
  // reload the page; each card's own run view follows them)
  const listed = useRef<Way[] | null>(ways);
  listed.current = ways;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = subscribe((ev, d) => {
      if (ev !== "run" || !d || (d as RunView).gameId !== g.id) return;
      const r = d as RunView, mine = (listed.current ?? []).find(x => x.run?.id === r.id);
      if (mine?.run && mine.run.state === r.state && mine.run.phase === r.phase && (mine.run.ask?.code ?? null) === (r.ask?.code ?? null)) return;
      if (!t) t = setTimeout(() => { t = null; reload(); }, 400);
    });
    return () => { off(); if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.id]);
  /** the latest word from each way's job (its build, or its plan's first build for it): its progress ticks ('build') and
   *  its state changes ('job', the start and the end included) */
  const [ticks, setTicks] = useState<Record<number, JobView>>({});
  useEffect(() => subscribe((ev, d) => {
    if ((ev !== "build" && ev !== "job") || !d) return;
    const j = d as JobView, wayId = jobWay(j);
    if (wayId) setTicks(t => ({ ...t, [wayId]: j }));
  }), []);
  const [findable, setFindable] = useState(false);
  useEffect(() => { void hasRoute("POST", "/api/v1/way/0/find-files").then(setFindable); }, []);
  const [adding, setAdding] = useState(false);
  const [logId, setLogId] = useState<number | null>(null);
  const [planEdit, setPlanEdit] = useState<number | null>(null);
  const list = ways ?? [];
  const kept = (files?.items ?? []).filter(f => f.role === "game");
  const usedIds = list.map(w => w.contentId).filter((id): id is number => id != null);
  const otherRoutes = g.routes.filter(r => r.source !== "custom");
  return (
    <div className="ways">
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="dim">{list.length ? `${list.length} way${list.length === 1 ? "" : "s"} to play this game through a recomp, a port or an emulator.` : ""}</span>
        <span className="grow" />
        <Btn icon="plus" onClick={() => setAdding(true)}>Add a way to play</Btn>
      </div>
      {research.map(r => <p key={r.platform}>{r.reason} {r.link && <a href={r.link} target="_blank" rel="noreferrer">Compatibility source</a>}</p>)}
      {ways === null ? null : !list.length && !otherRoutes.length && !research.length ? (
        <Empty title="No ways to play yet" icon="compass">A recomp, a port or an emulator can play this game: add one from its repo, or from a plan ludarr has.</Empty>
      ) : list.map(w => (
        <WayCard key={w.id} w={w} plan={planOf.get(w.planId) ?? null} g={g} files={kept} tick={ticks[w.id] ?? null} findable={findable} used={usedIds}
          onChanged={reload} onLog={setLogId} onEditPlan={setPlanEdit} onNoFind={() => setFindable(false)} />
      ))}
      {otherRoutes.length > 0 && (
        <Section title={list.length ? "Also in the catalog" : "In the catalog"}>
          <div className="routes">{otherRoutes.map(r => (
            <div className="route" key={r.id}>
              <div className="k"><Label tone={KIND_TONE[r.kind] ?? "default"}>{r.kind}</Label></div>
              <div className="main"><span>{r.label ?? r.runtime?.name ?? r.kind} <span className="dim">· {r.platform}{r.provenance !== "retail" ? ` · ${r.provenance}` : ""}</span></span>
                <small>{r.runtime?.latest ? `${r.runtime.name} ${r.runtime.latest.tag}${r.runtime.latest.asset ? ` — ${r.runtime.latest.asset.name}` : ""}` : r.statusNote ?? ""}{r.features.length ? ` · ${r.features.join(", ")}` : ""}</small></div>
              {r.status && <Label tone={COMPAT_TONE[r.status] ?? "dim"}>{r.status}</Label>}
              {r.link && <a href={r.link} target="_blank" rel="noreferrer" title="Open"><Icon name="external" size={14} /></a>}
            </div>
          ))}</div>
        </Section>
      )}
      {kept.length > 0 && <KeptFiles files={kept} ways={list} onChanged={reload} />}
      <AddWayModal g={g} used={list.map(w => w.planId)} open={adding} onClose={() => setAdding(false)} onAdded={reload} />
      <JobLogModal id={logId} onClose={() => setLogId(null)} />
      <EditPlanFor planId={planEdit} onClose={() => setPlanEdit(null)} onSaved={reload} />
    </div>
  );
}
