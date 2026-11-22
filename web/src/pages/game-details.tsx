/**
 * The game page's Edit Details (a game added by hand: every field of its description; a game from a store or the
 * catalog: the other names it goes by and its search terms) and Art (upload, link or reset each kind; hero and logo
 * only for games added by hand).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, del, errorList, put, sentence, type Game, type GameDetail } from "../api";
import { Art, art } from "../ui/art";
import { Icon } from "../ui/icons";
import { Btn, Callout, Label, Modal, useReveal, useUi } from "../ui/kit";
import { ART_ACCEPT, ART_MAX, GameDraftForm } from "../ui/game-form";
import { detailsPatch, formOf, formProblems, SEARCH_FIELDS, type DraftField, type DraftForm } from "../ways/logic";
import { draftInto, duplicateName } from "./add-manual";

const SOURCE_WORD: Record<string, string> = { steam: "Steam", igdb: "IGDB", catalog: "the catalog" };

export function EditDetailsModal({ g, open, onClose, onSaved }: { g: GameDetail; open: boolean; onClose: () => void; onSaved: (g: Game) => void }) {
  const { toast } = useUi();
  const manual = g.source === "manual";
  const only = manual ? undefined : SEARCH_FIELDS;
  const [form, setForm] = useState<DraftForm>(() => formOf(g));
  const [marks, setMarks] = useState<Partial<Record<DraftField, string>>>({});
  const [note, setNote] = useState<ReactNode>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"save" | "draft" | null>(null);
  const [dup, setDup] = useState<{ id: number; name: string | null } | null>(null);
  const [failure, setFailure] = useState<string[] | null>(null);
  useEffect(() => { if (open) { setForm(formOf(g)); setMarks({}); setNote(null); setTried(false); setDup(null); setFailure(null); } }, [open, g.id]);
  const problems = formProblems(form, only);
  const notice = useReveal(dup ?? failure);
  const save = async (force = false) => {
    setTried(true);
    if (Object.keys(problems).length) return;
    const patch = detailsPatch(formOf(g), form, manual);
    if (!Object.keys(patch).length) { toast("Nothing changed"); onClose(); return; }
    setBusy("save"); setDup(null); setFailure(null);
    try {
      const r = await put<{ item: Game }>(`/api/v1/game/${g.id}/details`, { ...patch, ...(force ? { force: true } : {}) });
      toast(<>Saved <b>{r.item.name}</b></>, "success");
      onSaved(r.item); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.existingId) setDup({ id: Number(e.data.existingId), name: duplicateName(e.message) });
      else setFailure(errorList(e));
    } finally { setBusy(null); }
  };
  const draft = async () => {
    setBusy("draft"); setNote(null);
    const r = await draftInto(form, { name: form.name.trim() || g.name }, { self: g.id });
    setForm(r.form); setMarks(m => ({ ...m, ...r.marks })); setNote(r.note); setBusy(null);
  };
  return (
    <Modal open={open} onClose={onClose} wide={manual} title={<>Edit details — {g.name}</>}
      foot={<>
        {manual && <span className="left"><Btn kind="accent" icon="sparkles" busy={busy === "draft"} disabled={!!busy} onClick={() => void draft()}>Draft with AI</Btn></span>}
        <Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" icon="save" busy={busy === "save"} disabled={!!busy} onClick={() => void save()}>Save</Btn>
      </>}>
      <div ref={notice}>
        {dup && <Callout tone="warning">Another library game has this name{dup.name ? <>: <b>{dup.name}</b></> : null}. <Link to={`/games/${dup.id}`} onClick={onClose}>Open it</Link> · <button type="button" className="linkish" onClick={() => void save(true)}>save anyway</button></Callout>}
        {failure && <Callout tone="danger"><b>Nothing was saved.</b>{failure.length === 1 ? <> {sentence(failure[0])}</> : <ul className="errs">{failure.map((f, i) => <li key={i}>{f}</li>)}</ul>}</Callout>}
      </div>
      {!manual && <p className="dim" style={{ marginBottom: 6 }}>{g.name} comes from {SOURCE_WORD[g.source] ?? g.source}, and its details are read from there again on Refresh. How it is searched can be changed here.</p>}
      {note && <p className="dim draft-note">{note}</p>}
      <GameDraftForm value={form} onChange={setForm} only={only} errors={tried ? problems : {}} from={marks} />
    </Modal>
  );
}

const ART_WORD: Record<string, { label: string; help: string }> = {
  poster: { label: "Poster", help: "The cover in the library (2:3)." },
  banner: { label: "Banner", help: "The wide picture at the top of the game's page." },
  hero: { label: "Hero", help: "A wide background picture." },
  logo: { label: "Logo", help: "The game's logo, best on a transparent background." },
};

function ArtRow({ g, kind, onChanged }: { g: GameDetail; kind: "poster" | "banner" | "hero" | "logo"; onChanged: (g: Game) => void }) {
  const { toast, confirm } = useUi();
  const input = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const own = g.customArt.includes(kind);
  const v = g.customArtAt;
  const src = kind === "poster" ? art.poster(g.id, v) : kind === "banner" ? art.banner(g.id, v) : own ? (kind === "hero" ? art.hero(g.id, v) : art.logo(g.id, v)) : null;
  const done = (r: { item: Game }, what: string) => { setError(null); setLink(""); toast(what, "success"); onChanged(r.item); };
  const upload = async (f: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) { setError("A PNG, JPEG or WebP image"); return; }
    if (f.size > ART_MAX) { setError("Up to 15 MB"); return; }
    setBusy("upload");
    try { done(await api<{ item: Game }>(`/api/v1/game/${g.id}/art/${kind}`, { method: "PUT", body: f, headers: { "content-type": f.type } }), `${ART_WORD[kind].label} kept`); }
    catch (e: any) { setError(sentence(e.message)); } finally { setBusy(null); }
  };
  const fromLink = async () => {
    const u = link.trim();
    if (!/^https:\/\/\S+$/i.test(u)) { setError("An https link to the image"); return; }
    setBusy("link");
    try { done(await put<{ item: Game }>(`/api/v1/game/${g.id}/art/${kind}`, { url: u }), `${ART_WORD[kind].label} kept`); }
    catch (e: any) { setError(sentence(e.message)); } finally { setBusy(null); }
  };
  const reset = async () => {
    if (!(await confirm(`Reset the ${kind}?`, kind === "hero" || kind === "logo" ? `The game then has no ${kind}.` : `Automatic art takes its place again.`, { ok: "Reset", kind: "warning" }))) return;
    setBusy("reset");
    try { done(await del<{ item: Game }>(`/api/v1/game/${g.id}/art/${kind}`), `${ART_WORD[kind].label} reset`); }
    catch (e: any) { setError(sentence(e.message)); } finally { setBusy(null); }
  };
  return (
    <div className="artrow">
      <div className={`artprev art-${kind}`}>{src ? <Art src={src} title={g.name} lazy={false} /> : <span>No {kind}</span>}</div>
      <div className="artctl">
        <div className="row wrap"><b>{ART_WORD[kind].label}</b>{own ? <Label tone="accent">set by hand</Label> : <Label tone="dim">{kind === "hero" || kind === "logo" ? "none" : "automatic"}</Label>}</div>
        <div className="help">{ART_WORD[kind].help}{own ? " Automatic art never replaces it." : ""}</div>
        <div className="row wrap">
          <Btn size="sm" icon="upload" busy={busy === "upload"} disabled={!!busy} onClick={() => input.current?.click()}>Upload a file</Btn>
          {own && <Btn size="sm" kind="ghost" icon="refresh" busy={busy === "reset"} disabled={!!busy} onClick={() => void reset()}>Reset</Btn>}
        </div>
        <input ref={input} type="file" accept={ART_ACCEPT} hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        <div className="row">
          <input className="input" value={link} placeholder="or an https link to an image" onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void fromLink(); }} aria-label={`${kind} link`} />
          <Btn size="sm" icon="link" busy={busy === "link"} disabled={!!busy || !link.trim()} onClick={() => void fromLink()}>Use</Btn>
        </div>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

export function ArtModal({ g, open, onClose, onChanged }: { g: GameDetail; open: boolean; onClose: () => void; onChanged: (g: Game) => void }) {
  const kinds = g.source === "manual" ? (["poster", "banner", "hero", "logo"] as const) : (["poster", "banner"] as const);
  return (
    <Modal open={open} onClose={onClose} wide title={<>Art — {g.name}</>} foot={<Btn onClick={onClose}>Close</Btn>}>
      <p className="dim" style={{ marginBottom: 10 }}><Icon name="info" size={13} /> Images are PNG, JPEG or WebP, up to 15 MB. A link is fetched once by the server and kept.</p>
      <div className="artrows">{kinds.map(k => <ArtRow key={k} g={g} kind={k} onChanged={onChanged} />)}</div>
    </Modal>
  );
}
