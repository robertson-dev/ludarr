/**
 * Settings → Runtimes: the runtime sets, then every plan — how to get, set up and start one program — with Check,
 * Build from source (or Build its tools), the system files its needs ask for, the editor and Delete.
 */
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, type Plan, type PlanDetail } from "../../api";
import { useEvents } from "../../events";
import { Icon } from "../../ui/icons";
import { Btn, Empty, IconBtn, Label, Section, Spinner, useLoad } from "../../ui/kit";
import { KIND_TONE, planStatus } from "../../ui/status";
import { PlanDetailModal, PlanEditorModal, RepoLink, usePlanActions } from "../../ui/plan-view";
import { planBuildAction, programLine } from "../../ways/logic";
import { SingletonsPage } from "./instances";

const KIND_WORD: Record<string, string> = { recomp: "recomp", port: "port", emulator: "emulator" };

function PlansSection() {
  const [params, setParams] = useSearchParams();
  const { data, loading, error, reload } = useLoad(() => get<{ items: Plan[] }>("/api/v1/plan"), []);
  useEvents(["job", "catalog"], () => void reload());
  const act = usePlanActions(() => void reload());
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const open = Number(params.get("plan")) || null;
  const setOpen = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set("plan", String(id)); else p.delete("plan");
    setParams(p, { replace: true });
  };
  const items = data?.items ?? [];
  return (
    <div style={{ marginTop: 30 }}>
      <Section title={`Plans${data ? ` (${items.length})` : ""}`} right={<><Link className="btn sm" to="/add/repo"><Icon name="gitBranch" size={14} />From a repo</Link><Btn size="sm" icon="plus" onClick={() => setEditing("new")}>New plan</Btn></>}>
        <p className="dim" style={{ marginBottom: 8 }}>A plan says how to get, set up and start one program: a recomp or a port of one game, or an emulator for a platform's games. A game plays through it once it has a way to play with that plan.</p>
        {loading && !data ? <Spinner /> : error && !data ? <Empty title="Could not load the plans" icon="alert">{error}</Empty> : !items.length ? (
          <Empty title="No plans yet" icon="box">Build one from a repo, or write one by hand with New plan.</Empty>
        ) : (
          <div className="table-wrap"><table className="table plans">
            <thead><tr><th>Plan</th><th>Repo</th><th>Status</th><th>Ways</th><th>System files</th><th className="actions"></th></tr></thead>
            <tbody>{items.map(p => {
              const st = planStatus(p.status);
              const missing = p.needs.missing.length;
              const builds = planBuildAction(p.spec);
              return (
                <tr key={p.id}>
                  <td>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <button className="linkish strong" onClick={() => setOpen(p.id)}>{p.name}</button>
                      <Label tone={KIND_TONE[p.kind] ?? "default"}>{KIND_WORD[p.kind] ?? p.kind}</Label>{p.author === "ai" && <Label tone="outline" title="written by the AI importer">AI</Label>}
                    </div>
                    <div className="dim clamp2" style={{ maxWidth: 360 }} title={programLine(p.spec.program, p.pinned)}>{programLine(p.spec.program, p.pinned)}</div>
                  </td>
                  <td className="repo-cell"><RepoLink repo={p.repo} /></td>
                  <td><Label tone={st.tone}>{st.label}</Label>{p.statusNote && <div className="dim clamp2" style={{ maxWidth: 240 }} title={p.statusNote}>{p.statusNote}</div>}</td>
                  <td>{p.waysCount}</td>
                  <td className="nowrap">{!p.spec.needs.length ? <span className="dim">none</span> : missing ? <button className="linkish warn-text" onClick={() => setOpen(p.id)}>{missing} of {p.spec.needs.length} missing</button> : <span className="ok-text"><Icon name="check" size={12} /> all {p.spec.needs.length}</span>}</td>
                  <td className="actions">
                    <IconBtn icon={act.busy === `check:${p.id}` ? "spinner" : "refresh"} label="Check" disabled={!!act.busy} onClick={() => void act.check(p)} />
                    {builds && !act.noBuild && <IconBtn icon={act.busy === `build:${p.id}` ? "spinner" : "hammer"} label={builds} disabled={!!act.busy} onClick={() => void act.buildSource(p)} />}
                    <IconBtn icon="pencil" label="Edit" onClick={() => setEditing(p)} />
                    <IconBtn icon="trash" label="Delete" danger onClick={() => void act.remove(p)} />
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Section>
      <PlanDetailModal id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />
      <PlanEditorModal plan={editing === "new" ? null : editing} open={editing != null} onClose={() => setEditing(null)}
        onSaved={(p: PlanDetail) => { void reload(); if (editing === "new") setOpen(p.id); }} />
      {act.log}
    </div>
  );
}

export function RuntimesPage() {
  return (
    <SingletonsPage kind="runtime" title="Runtimes" blurb="Emulators and recomp / port builds the catalog can offer, with their release sources.">
      <PlansSection />
    </SingletonsPage>
  );
}
