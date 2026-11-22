/**
 * How a game's copy starts (the server's src/library/launch.ts): the game page's "Starts with" row, the same line on the
 * card of the way that built the copy, and the editor both open ("How <game> starts"). The editor's list is the copy's own
 * programs (what each one's header and the package's words say about it, quoted as written), its scripts (the program one
 * starts offered in its place; a .bat or .cmd can itself be picked, with what it does on a player's PC said and its text to
 * read), every other file behind a search; the arguments are a list with inserts, the folder it starts in, the variables, and a
 * preview of what runs on a player's PC. What Save would say is asked as the admin types, so the words are the server's.
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from "react";
import { del, errorList, get, getBlob, post, put, type GameDetail, type LaunchCheck, type LaunchFields, type LaunchFileHit, type LaunchView, type Way } from "../api";
import { BY_WORDS, INSTALLED_WORDS, isStartScript, needsAhoy, newer, pasted, preview, saidOfStart, SCRIPT_WORDS, shortVersion, splitCommandLine, startExtras, startLine } from "../ways/launch-logic";
import { Icon } from "./icons";
import { Btn, Callout, Empty, Fold, IconBtn, Label, Modal, Row, Spinner, useLoad, useUi } from "./kit";

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** the one line of what the package says about the program a copy starts (launch-logic's saidOfStart) */
function saidOf(v: LaunchView | null): { text: string; source: string } | null {
  const cur = v?.programs.find(p => p.current);
  return cur && v?.start ? saidOfStart(cur.words, cur.path, v.start.argv) : null;
}

/** the game page's Overview row: the whole start, where it comes from, what the package says of it, Change… and Reset */
export function StartsWith({ g, onChanged }: { g: GameDetail; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: v, reload } = useLoad(() => (g.file ? get<{ item: LaunchView }>(`/api/v1/game/${g.id}/launch`).then(r => r.item) : Promise.resolve(null)), [g.id, g.file?.id, g.file?.launchRev], { quiet: true });
  const reset = useReset(g.id, g.name, () => { void reload(); onChanged(); });
  if (!g.file) return null;
  if (g.file.kind === "rom" || v?.kind === "rom") return <span className="dim">a console dump: a way to play starts it</span>;
  // the line the library knows comes first, so the whole start (arguments too) shows before the view is read
  const line = v?.start?.line ?? g.file.start ?? g.file.launch ?? "";
  const said = saidOf(v ?? null);
  return (
    <div className="launch-row">
      <div className="wrap">
        <span className="mono launch-line">{line}</span>
        {v?.start && startExtras(v.start).map(x => <span key={x} className="dim">{x}</span>)}
        {v?.start && <Label tone={v.start.by === "hand" ? "accent" : "dim"}>{BY_WORDS[v.start.by]}</Label>}
        {v?.editable && <button type="button" className="linkish" disabled={!!v.busy} title={v.busy ?? undefined} onClick={() => setOpen(true)}>Change…</button>}
        {v?.resettable && <button type="button" className="linkish" disabled={!!v.busy} title={v.busy ?? undefined} onClick={() => void reset(v)}>Reset</button>}
      </div>
      {said && <div className="launch-said"><span className="src">{said.source}:</span> “{said.text}”</div>}
      {isStartScript(v?.start?.exe) && <div className="dim">{SCRIPT_WORDS}</div>}
      {v?.set && !v.applied && <div className="warn-text"><Icon name="alert" size={13} /> The start set by hand ({v.set.line}) is not applied{v.notApplied ? `: ${v.notApplied}` : " to this copy"}.</div>}
      {v?.start?.by === "hand" && <div className="dim">{INSTALLED_WORDS}</div>}
      {v?.busy && <div className="dim">{v.busy}: it can be changed once that is done.</div>}
      {v && !v.editable && v.why && <div className="dim">{v.why}</div>}
      <LaunchEditor gameId={g.id} name={g.name} open={open} onClose={() => setOpen(false)} onSaved={() => { void reload(); onChanged(); }} />
    </div>
  );
}

/** the same line on the card of the way that built the game's copy */
export function WayStartLine({ g, w, onChanged }: { g: GameDetail; w: Way; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (!g.file || w.packageId == null || w.packageId !== g.file.id || w.status !== "built") return null;
  const hand = w.overrides?.launch ?? null;
  const applied = !!hand && g.file.launchRev === hand.at;
  return (
    <div className="part">
      <h5>Starts with</h5>
      <div className="wrap">
        <span className="mono launch-line">{g.file.start ?? g.file.launch}</span>
        <Label tone={applied ? "accent" : "dim"}>{applied ? BY_WORDS.hand : BY_WORDS.plan}</Label>
        <button type="button" className="linkish" onClick={() => setOpen(true)}>Change…</button>
      </div>
      {hand && !applied && <div className="warn-text"><Icon name="alert" size={13} /> The start set by hand ({startLine(hand.exe, hand.argv)}) is not applied to this copy.</div>}
      <LaunchEditor gameId={g.id} name={g.name} open={open} onClose={() => setOpen(false)} onSaved={onChanged} />
    </div>
  );
}

/** Reset, after the admin says yes: the start found comes back */
function useReset(gameId: number, name: string, done: () => void) {
  const { toast, confirm } = useUi();
  return async (v: LaunchView): Promise<boolean> => {
    const how = v.from === "way" ? "as the plan says" : v.auto?.by === "ai" ? "as the AI importer found it" : "as ludarr found it";
    if (!(await confirm(`Reset how ${name} starts?`, <>It starts with <span className="mono">{v.auto?.line}</span> again, {how}.</>, { ok: "Reset", kind: "warning" }))) return false;
    try {
      await del(`/api/v1/game/${gameId}/launch`);
      toast(<>{name} starts with <span className="mono">{v.auto?.line}</span> again.</>, "success");
      done();
      return true;
    } catch (e) { toast(String((e as Error).message), "danger"); return false; }
  };
}

let rowSeq = 0;
interface Arg { id: number; text: string }
interface Variable { id: number; name: string; value: string }
interface Draft { exe: string; args: Arg[]; cwd: string; env: Variable[] }
const toDraft = (f: LaunchFields): Draft => ({
  exe: f.exe, args: f.argv.map(text => ({ id: ++rowSeq, text })), cwd: f.cwd ?? "",
  env: Object.entries(f.env).map(([name, value]) => ({ id: ++rowSeq, name, value })),
});
const fieldsOf = (d: Draft): LaunchFields => ({
  exe: d.exe, argv: d.args.map(a => a.text.trim()).filter(Boolean), cwd: d.cwd || null,
  env: Object.fromEntries(d.env.filter(v => v.name.trim()).map(v => [v.name.trim(), v.value])),
});
const bodyOfFields = (f: LaunchFields) => ({ exe: f.exe, argv: f.argv, ...(f.cwd ? { cwd: f.cwd } : {}), ...(Object.keys(f.env).length ? { env: f.env } : {}) });
/** what the editor sends (the check and Save): the arguments row by row, empty ones too, so the server's words number them as
 *  the rows are (it leaves the empty ones out) */
const bodyOf = (d: Draft) => ({ ...bodyOfFields(fieldsOf(d)), argv: d.args.map(a => a.text) });

/** "How <game> starts" */
export function LaunchEditor({ gameId, name, open, onClose, onSaved }: { gameId: number; name: string; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const { data: v, loading, error } = useLoad(() => (open ? get<{ item: LaunchView }>(`/api/v1/game/${gameId}/launch`).then(r => r.item) : Promise.resolve(null)), [open, gameId]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [check, setCheck] = useState<LaunchCheck | null>(null);
  /** what Save refused, and the start it refused (sent as `sent` is): said while the editor holds that start */
  const [refused, setRefused] = useState<{ body: string; errors: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  /** the argument a file found by the search goes into (null: a new one at the end) */
  const [target, setTarget] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const reset = useReset(gameId, name, () => { onSaved(); onClose(); });
  useEffect(() => { if (!open) { setDraft(null); setCheck(null); setRefused(null); setTarget(null); } }, [open]);
  useEffect(() => { if (open && v?.fields && !draft) setDraft(toDraft(v.fields)); }, [open, v, draft]);
  // what Save would say, asked as the admin types (the server's own words)
  const sent = draft ? JSON.stringify(bodyOf(draft)) : "";
  useEffect(() => {
    if (!open || !draft) return;
    let live = true;
    const t = setTimeout(() => { void post<LaunchCheck>(`/api/v1/game/${gameId}/launch/check`, JSON.parse(sent)).then(r => { if (live) setCheck(r); }, () => {}); }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [open, gameId, sent]); // eslint-disable-line react-hooks/exhaustive-deps

  const programs = useMemo(() => (v?.programs ?? []).filter(p => !p.refused).map(p => p.path), [v]);
  if (!open) return null;
  const set = (patch: Partial<Draft>) => setDraft(d => (d ? { ...d, ...patch } : d));
  const setArg = (id: number, text: string) => setDraft(d => (d ? { ...d, args: d.args.map(a => (a.id === id ? { ...a, text } : a)) } : d));
  const insert = (id: number | null, text: string) => setDraft(d => {
    if (!d) return d;
    if (id == null || !d.args.some(a => a.id === id)) return { ...d, args: [...d.args, { id: ++rowSeq, text }] };
    return { ...d, args: d.args.map(a => (a.id === id ? { ...a, text: a.text + text } : a)) };
  });
  /** a pasted command line becomes arguments (and the program, when its first word is one of the copy's) */
  const onPaste = (id: number, e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (splitCommandLine(text).length < 2) return;
    e.preventDefault();
    const r = pasted(text, programs);
    setDraft(d => {
      if (!d) return d;
      const at = d.args.findIndex(a => a.id === id);
      const rows = r.argv.map(t => ({ id: ++rowSeq, text: t }));
      const keep = d.args[at]?.text.trim() ? [d.args[at]] : [];
      const args = at < 0 ? [...d.args, ...rows] : [...d.args.slice(0, at), ...keep, ...rows, ...d.args.slice(at + 1)];
      return { ...d, args, ...(r.exe ? { exe: r.exe } : {}) };
    });
  };
  const save = async () => {
    if (!draft) return;
    const body = bodyOf(draft);
    setBusy(true); setRefused(null);
    try {
      const r = await put<{ item: LaunchView; warnings: string[] }>(`/api/v1/game/${gameId}/launch`, body);
      toast(<>{name} starts with <span className="mono">{r.item.start?.line ?? draft.exe}</span> now.</>, "success");
      if (r.warnings.length) toast(r.warnings.join(" · "), "warning");
      onSaved(); onClose();
    } catch (e) { setRefused({ body: JSON.stringify(body), errors: errorList(e) }); } finally { setBusy(false); }
  };

  const f = draft ? fieldsOf(draft) : null;
  const need = f && v ? newer(v.auto?.needsAhoy ?? null, needsAhoy(f)) : null;
  const pv = f && v ? preview(f, { install: v.placeholders.install, content: v.placeholders.content }) : null;
  // a refused Save's words while the start is the one it refused (the admin may change it before the answer comes), else
  // what the check of the start as it is says
  const errors = refused && refused.body === sent ? refused.errors : check?.errors ?? [];
  const blocked = !!v?.busy || !v?.editable;
  // nothing to save while the fields are the copy's start as it is (a stray Save would pin it as set by hand)
  const changed = !!draft && (!v?.now || JSON.stringify(bodyOfFields(fieldsOf(draft))) !== JSON.stringify(bodyOfFields(v.now)));
  return (
    <Modal open={open} onClose={onClose} wide title={<>How {name} starts</>}
      foot={<>
        <span className="left">{v?.resettable && v.editable && <Btn kind="outline" icon="refresh" disabled={busy || !!v.busy} onClick={() => void reset(v)}>Reset</Btn>}</span>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" busy={busy} disabled={!draft?.exe || blocked || !changed} title={v?.busy ?? (!changed ? "nothing changed yet" : undefined)} onClick={() => void save()}>Save</Btn>
      </>}>
      {loading && !v ? <Spinner text="Reading the copy…" /> : !v ? <Empty title="The copy could not be read" icon="alert">{error}</Empty> : !v.editable ? <Callout tone="info">{v.why}</Callout> : !draft ? <Spinner /> : (
        <div className="launch-editor">
          {v.busy && <Callout tone="warning">{v.busy}: it can be changed once that is done.</Callout>}
          {v.set && !v.applied && <Callout tone="warning">The start set by hand ({v.set.line}) is not applied{v.notApplied ? `: ${v.notApplied}` : " to this copy"}. It starts with {v.start?.line} until you change it or reset it.</Callout>}

          <Row label="Program">
            <div className="launch-list" aria-label="The copy's programs">
              {v.programs.map(p => (
                <button type="button" key={p.path} aria-pressed={draft.exe === p.path} disabled={!!p.refused}
                  className={`launch-item${draft.exe === p.path ? " on" : ""}${p.helper || p.refused ? " faded" : ""}`} onClick={() => set({ exe: p.path })}>
                  <span className="head">
                    <span className="mono">{p.path}</span>
                    {p.current && <Label tone="outline">starts it now</Label>}
                    {p.ui && <span className="dim">{p.ui === "window" ? "opens a window" : "a console program"}</span>}
                    {p.refused ? <span className="dim">{p.refused}</span> : p.helper ? <span className="dim">looks like an installer or a helper</span> : null}
                  </span>
                  {p.words.map((w, i) => <span key={i} className="launch-said"><span className="src">{w.source}:</span> “{w.text}”</span>)}
                </button>
              ))}
              {!v.programs.length && <div className="dim pad">The copy has no programs (.exe).</div>}
            </div>
            {v.scripts.length > 0 && (
              <>
                <div className="dim launch-intro">Scripts: pick the program a script starts. A .bat or .cmd can itself be the start when the game needs its script: it then runs on each player's PC as it is written.</div>
                <div className="launch-list launch-scripts" aria-label="The copy's scripts">
                  {v.scripts.map(s => {
                    const on = draft.exe === s.path;
                    return (
                      <div key={s.path} className={`launch-item script${on ? " on" : ""}`} aria-current={on || undefined}>
                        <span className="head"><span className="mono">{s.path}</span>{s.current && <Label tone="outline">starts it now</Label>}{s.program && <button type="button" className="linkish" onClick={() => set({ exe: s.program! })}>pick {s.program}</button>}</span>
                        {s.comment && <span className="launch-said">“{s.comment}”</span>}
                        {s.runs && <span className="launch-said">it runs: <span className="mono">{s.runs}</span></span>}
                        {s.startable && (s.does ?? []).map((d, i) => <span key={i} className="launch-said warn-text">it {d}</span>)}
                        {s.startable && (s.refused
                          ? <span className="launch-said">it cannot be the start: {s.refused}</span>
                          : <span className="launch-acts">{on ? <span className="dim">the start, as picked here</span> : <button type="button" className="linkish" onClick={() => set({ exe: s.path })}>start the game with this script</button>}<ScriptText packageId={v.packageId} path={s.path} /></span>)}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <FileSearch gameId={gameId} total={v.files} inputRef={search}
              onProgram={path => set({ exe: path })}
              onArgument={path => { insert(target, `{install}/${path}`); setTarget(null); }} />
          </Row>

          <Row label="Arguments" help="One per row.">
            <div className="launch-args">
              {draft.args.map((a, i) => (
                <div key={a.id} className="launch-arg">
                  <input className="input mono-in" value={a.text} aria-label={`Argument ${i + 1}`} onChange={e => setArg(a.id, e.target.value)} onPaste={e => onPaste(a.id, e)} />
                  <select className="select" value="" aria-label={`Insert into argument ${i + 1}`} onChange={e => {
                    const pick = e.target.value;
                    if (pick === "file") { setTarget(a.id); search.current?.focus(); } else if (pick) insert(a.id, pick);
                  }}>
                    <option value="">Insert…</option>
                    <option value="{install}">{"{install}"}: the game's folder</option>
                    {v.placeholders.content && <option value="{content}">{"{content}"}: {v.placeholders.content} inside the game's folder</option>}
                    <option value="file">a file of the copy…</option>
                  </select>
                  <IconBtn icon="x" label={`Remove argument ${i + 1}`} onClick={() => set({ args: draft.args.filter(x => x.id !== a.id) })} />
                </div>
              ))}
              <div className="row"><Btn size="sm" kind="outline" icon="plus" onClick={() => set({ args: [...draft.args, { id: ++rowSeq, text: "" }] })}>Add an argument</Btn>
                {target != null && <span className="dim">Pick a file in the search above to put it into argument {draft.args.findIndex(x => x.id === target) + 1}.</span>}</div>
            </div>
          </Row>

          <Row label="Starts in">
            <select className="select" value={draft.cwd} aria-label="Starts in" onChange={e => set({ cwd: e.target.value })}>
              <option value="">the {isStartScript(draft.exe) ? "script" : "program"}'s folder{dirOf(draft.exe) ? ` (${dirOf(draft.exe)})` : ""}</option>
              <option value="{install}">the game's folder</option>
              {[...new Set([...(draft.cwd && draft.cwd !== "{install}" && !v.folders.includes(draft.cwd) ? [draft.cwd] : []), ...v.folders])].map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </Row>

          <Row label="More">
            <Fold label={`Variables${draft.env.length ? ` (${draft.env.length})` : ""}`} open={draft.env.length > 0}>
              <div className="launch-args">
                {draft.env.map((x, i) => (
                  <div key={x.id} className="launch-env">
                    <input className="input mono-in" value={x.name} placeholder="NAME" aria-label={`Variable ${i + 1} name`} onChange={e => set({ env: draft.env.map(y => (y.id === x.id ? { ...y, name: e.target.value } : y)) })} />
                    <span className="dim">=</span>
                    <input className="input mono-in" value={x.value} aria-label={`Variable ${i + 1} value`} onChange={e => set({ env: draft.env.map(y => (y.id === x.id ? { ...y, value: e.target.value } : y)) })} />
                    <IconBtn icon="x" label={`Remove variable ${i + 1}`} onClick={() => set({ env: draft.env.filter(y => y.id !== x.id) })} />
                  </div>
                ))}
                <div className="row"><Btn size="sm" kind="outline" icon="plus" onClick={() => set({ env: [...draft.env, { id: ++rowSeq, name: "", value: "" }] })}>Add a variable</Btn><span className="dim">{"{install}"} in a value is the game's folder.</span></div>
              </div>
            </Fold>
          </Row>

          {pv && (
            <div className="launch-preview" aria-label="What runs on a player's PC">
              <div className="dim">What runs on a player's PC (the folder is an example):</div>
              <code className="launch-cmd">{pv.line}</code>
              <div className="dim">in <span className="mono">{pv.folder}</span>{isStartScript(f?.exe) ? " · through the Windows command shell" : ""}{need ? ` · needs Ahoy ${shortVersion(need)} or newer` : ""}</div>
            </div>
          )}
          {errors.length > 0 && <Callout tone="danger"><ul className="launch-problems">{errors.map((x, i) => <li key={i}>{x}</li>)}</ul></Callout>}
          {!errors.length && (check?.warnings.length ?? 0) > 0 && <Callout tone="warning"><ul className="launch-problems">{check!.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul></Callout>}
        </div>
      )}
    </Modal>
  );
}

/** a script's own text, read on demand (the first 64 KB): what the admin reads before a script starts a game on every player's PC */
function ScriptText({ packageId, path }: { packageId: number; path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = async () => {
    setOpen(o => !o);
    if (text !== null || error) return;
    try {
      const blob = await getBlob(`/api/v1/package/${packageId}/files/${path.split("/").map(encodeURIComponent).join("/")}`);
      setText(await blob.slice(0, 64 * 1024).text());
    } catch (e) { setError(String((e as Error).message)); }
  };
  return (
    <>
      <button type="button" className="linkish" aria-expanded={open} onClick={() => void read()}>{open ? "hide the script" : "read the script"}</button>
      {open && (error ? <span className="launch-said">It could not be read: {error}</span> : text === null ? <span className="dim">Reading…</span> : <pre className="launch-script-text" aria-label={`The text of ${path}`}>{text}</pre>)}
    </>
  );
}

/** every file of the copy, by any part of its path: a program can be picked, any file can go into an argument */
function FileSearch({ gameId, total, inputRef, onProgram, onArgument }: { gameId: number; total: number; inputRef: RefObject<HTMLInputElement>; onProgram: (path: string) => void; onArgument: (path: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ items: LaunchFileHit[]; matched: number } | null>(null);
  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => { void get<{ items: LaunchFileHit[]; matched: number }>(`/api/v1/game/${gameId}/launch/files?q=${encodeURIComponent(q.trim())}`).then(r => { if (live) setHits(r); }, () => {}); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, gameId]);
  return (
    <div className="launch-search">
      <input ref={inputRef} className="input" value={q} placeholder={`Search all ${total} files`} aria-label="Search the copy's files" onChange={e => setQ(e.target.value)} />
      {hits && (
        <div className="launch-hits">
          {hits.items.map(h => (
            <div key={h.path} className="launch-hit">
              <span className="mono grow">{h.path}</span>
              {(h.kind === "program" || (h.kind === "script" && isStartScript(h.path))) && <button type="button" className="linkish" onClick={() => onProgram(h.path)}>start this</button>}
              <button type="button" className="linkish" onClick={() => onArgument(h.path)}>use it as an argument</button>
            </div>
          ))}
          {!hits.items.length && <div className="dim pad">No file of the copy has that in its path.</div>}
          {hits.matched > hits.items.length && <div className="dim pad">{hits.matched - hits.items.length} more: type more of the path.</div>}
        </div>
      )}
    </div>
  );
}
