/**
 * Add → Manual: a game no source knows, described by hand (the AI importer can draft the empty fields), its art, what
 * the indexers answer for it before it is saved, and where it goes in the library.
 */
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, errorList, get, missingRoute, NOT_YET, post, sentence, type Game, type GameDraft, type ReleaseSearch } from "../api";
import { Icon } from "../ui/icons";
import { Btn, Callout, Empty, Section, Spinner, useUi } from "../ui/kit";
import { ArtPick, artProblem, noArt, GameDraftForm, type ArtChoice } from "../ui/game-form";
import { LibraryFields, libraryBody, useLibraryFields } from "../ui/library-fields";
import { ReleaseTable, SearchSummary } from "../ui/releases";
import { DRAFT_FIELDS, draftOf, draftReport, emptyForm, FIELD_WORD, fillEmpty, formProblems, joinWords, searchQuery, sourceWord, type DraftField, type DraftForm } from "../ways/logic";

const GAME_FIELDS: DraftField[] = DRAFT_FIELDS.filter(k => k !== "searchTerms");

/** the duplicate the server found: '"Name" (2004) is already in the library …' */
export function duplicateName(message: string): string | null {
  const m = message.match(/^"(.+?)"(?: \((\d{4})\))?/);
  return m ? `${m[1]}${m[2] ? ` (${m[2]})` : ""}` : null;
}

/** what a draft request sends back: the fields, their sources (the list, and the source of each field), and the library
 *  game it found, when it found one */
interface DraftAnswer { draft: Partial<GameDraft>; from?: unknown; fields?: unknown; inLibrary?: number | null }

/**
 * Ask for a draft and fill the empty fields of `form`; says what it did in `note`: each filled field marked with its own
 * source, the sources in words, and the library game it found (not the game `self` being edited).
 */
export async function draftInto(form: DraftForm, body: { name?: string; repo?: string }, o: { self?: number } = {}): Promise<{ form: DraftForm; marks: Partial<Record<DraftField, string>>; note: ReactNode }> {
  try {
    const r = await post<DraftAnswer>("/api/v1/game/draft", body);
    const { form: next, filled } = fillEmpty(form, r.draft);
    // the source of each field (an older engine sent that map as `from`, and only a list otherwise)
    const per = r.fields && typeof r.fields === "object" ? r.fields : r.from && typeof r.from === "object" && !Array.isArray(r.from) ? r.from : null;
    const { marks, sources, found } = draftReport(filled, per);
    const listed = !per && Array.isArray(r.from) ? r.from.map(String).filter(Boolean).map(sourceWord) : [];
    const named = sources.length ? sources : listed;
    const own = Number(r.inLibrary) > 0 && Number(r.inLibrary) !== o.self ? Number(r.inLibrary) : null;
    // each sentence one piece: the note is a flex row, which would set a link apart from the words around it
    const note = <>
      <span>{filled.length ? <>Filled the {joinWords(filled.map(k => FIELD_WORD[k]))}{named.length ? <> from {joinWords(named)}</> : null}. Check them before adding.</>
        : found || listed.length ? <>Nothing to fill: what the draft found is in the form already.</> : <>Nothing found for the empty fields.</>}</span>
      {own && <span>Already in your library: <Link to={`/games/${own}`}>open it</Link>.</span>}
    </>;
    return { form: next, marks, note };
  } catch (e) {
    if (missingRoute(e)) return { form, marks: {}, note: <>Drafting: {NOT_YET.toLowerCase()}</> };
    return { form, marks: {}, note: <span className="err-text">{sentence((e as Error).message)}</span> };
  }
}

function TestSearch({ form }: { form: DraftForm }) {
  const [asked, setAsked] = useState<string | null>(null);
  const [loose, setLoose] = useState(false);
  const [state, setState] = useState<{ loading: boolean; data: ReleaseSearch | null; error: string | null }>({ loading: false, data: null, error: null });
  const run = async (q: string) => {
    setAsked(q); setState({ loading: true, data: null, error: null });
    try { setState({ loading: false, data: await get<ReleaseSearch>(`/api/v1/release?${q}`), error: null }); }
    catch (e: any) { setState({ loading: false, data: null, error: String(e?.message ?? e) }); }
  };
  const name = form.name.trim();
  return (
    <>
      <div className="row wrap">
        <Btn icon="search" disabled={!name || state.loading} busy={state.loading} onClick={() => void run(searchQuery(form, loose))}>Test the search</Btn>
        <label className="check"><input type="checkbox" checked={loose} onChange={e => { setLoose(e.target.checked); if (asked) void run(searchQuery(form, e.target.checked)); }} /> show everything the indexers returned</label>
        <span className="dim">{name ? "Asks the indexers now with the name, the year, every other name, every search term and the platforms. Nothing is grabbed." : "Give the game a name first."}</span>
      </div>
      {asked && (
        <div style={{ marginTop: 12 }}>
          {state.loading ? <Spinner text="Asking the indexers…" /> : state.error ? <Callout tone="danger">{sentence(state.error)}</Callout>
            : state.data && (
              <>
                <div style={{ marginBottom: 6 }}><SearchSummary data={state.data} /></div>
                {state.data.items.length ? <ReleaseTable items={state.data.items} name={state.data.game.name} />
                  : <Empty title="Nothing found" icon="search">No release matched. Another name or a search term may find it; the loose search shows everything the indexers returned.</Empty>}
              </>
            )}
        </div>
      )}
    </>
  );
}

export function ManualTab() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { toast } = useUi();
  const [form, setForm] = useState<DraftForm>(() => emptyForm(params.get("name") ?? ""));
  const [marks, setMarks] = useState<Partial<Record<DraftField, string>>>({});
  const [poster, setPoster] = useState<ArtChoice>(noArt());
  const [banner, setBanner] = useState<ArtChoice>(noArt());
  const lib = useLibraryFields();
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"add" | "draft" | null>(null);
  const [dup, setDup] = useState<{ id: number; name: string | null } | null>(null);
  const [failure, setFailure] = useState<string[] | null>(null);
  const [note, setNote] = useState<ReactNode>(null);
  const problems = formProblems(form);
  const shown = tried ? problems : {};
  const artBad = !!(artProblem(poster) || artProblem(banner));

  /** an edit takes away the "from the draft" mark of the field it changed */
  const change = (next: DraftForm) => {
    setMarks(m => { const out = { ...m }; for (const k of DRAFT_FIELDS) if (JSON.stringify(next[k]) !== JSON.stringify(form[k])) delete out[k]; return out; });
    setForm(next);
  };

  const draft = async () => {
    if (!form.name.trim()) { setTried(true); return; }
    setBusy("draft"); setNote(null);
    const r = await draftInto(form, { name: form.name.trim() });
    setForm(r.form); setMarks(m => ({ ...m, ...r.marks })); setNote(r.note);
    setBusy(null);
  };

  const add = async (force = false) => {
    setTried(true);
    // the problems show once this render is done: then the first one is brought into view
    if (Object.keys(problems).length || artBad) { setTimeout(() => document.querySelector(".form-row .err, .artctl .err")?.scrollIntoView({ block: "center", behavior: "smooth" }), 60); return; }
    setBusy("add"); setDup(null); setFailure(null);
    try {
      const body = {
        source: "manual", game: draftOf(form), ...libraryBody(lib.value),
        ...(!poster.file && poster.url.trim() ? { posterUrl: poster.url.trim() } : {}), ...(!banner.file && banner.url.trim() ? { bannerUrl: banner.url.trim() } : {}),
        ...(force ? { force: true } : {}),
      };
      const g = (await post<{ item: Game }>("/api/v1/game", body)).item;
      // files picked go up once the game exists; the game stays added if one is refused
      const kept: string[] = [];
      for (const [kind, c] of [["poster", poster], ["banner", banner]] as const) {
        if (!c.file) continue;
        try { await api(`/api/v1/game/${g.id}/art/${kind}`, { method: "PUT", body: c.file, headers: { "content-type": c.file.type || "application/octet-stream" } }); }
        catch (e: any) { kept.push(`The ${kind} was not kept: ${e.message}`); }
      }
      const searching = lib.value.monitored && lib.value.searchNow && (g.status === "searching" || g.status === "missing");
      toast(<>Added <b>{g.name}</b>{searching ? " — searching" : ""}</>, "success");
      for (const k of kept) toast(k, "warning");
      nav(`/games/${g.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.existingId) setDup({ id: Number(e.data.existingId), name: duplicateName(e.message) });
      else setFailure(errorList(e));
      scrollTo({ top: 0, behavior: "smooth" });
    } finally { setBusy(null); }
  };

  return (
    <div className="narrow-inner">
      {dup && (
        <Callout tone="warning">
          Already in your library{dup.name ? <> as <b>{dup.name}</b></> : null}: <Link to={`/games/${dup.id}`}>open it</Link> · <button type="button" className="linkish" onClick={() => void add(true)}>add anyway</button>
        </Callout>
      )}
      {failure && <Callout tone="danger"><b>The game was not added.</b>{failure.length === 1 ? <> {sentence(failure[0])}</> : <ul className="errs">{failure.map((f, i) => <li key={i}>{f}</li>)}</ul>}</Callout>}
      <Section title="The game" right={<Btn kind="accent" size="sm" icon="sparkles" busy={busy === "draft"} disabled={!!busy} onClick={() => void draft()} title="Fill the empty fields from the catalog, IGDB and the AI importer">Draft with AI</Btn>}>
        {busy === "draft" ? <p className="dim draft-note"><Icon name="spinner" size={13} /> Looking it up…</p> : note && <p className="dim draft-note">{note}</p>}
        <GameDraftForm value={form} onChange={change} only={GAME_FIELDS} errors={shown} from={marks} autoFocus={!form.name} />
      </Section>
      <Section title="Searching">
        <GameDraftForm value={form} onChange={change} only={["searchTerms"]} errors={shown} from={marks} />
        <TestSearch form={form} />
      </Section>
      <Section title="Art">
        <p className="dim" style={{ marginBottom: 6 }}>Art set here is the game's own: automatic art never replaces it.</p>
        <div className="artpicks">
          <div><div className="artlabel">Poster</div><ArtPick kind="poster" value={poster} onChange={setPoster} /></div>
          <div><div className="artlabel">Banner</div><ArtPick kind="banner" value={banner} onChange={setBanner} /></div>
        </div>
      </Section>
      <Section title="Library">
        <LibraryFields lib={lib} />
      </Section>
      <div className="form-actions">
        {tried && (Object.keys(problems).length > 0 || artBad) && <span className="err-text">Some fields need a look before the game can be added.</span>}
        <Btn kind="success" size="lg" icon="plus" busy={busy === "add"} disabled={busy === "draft"} onClick={() => void add()}>Add game</Btn>
      </div>
    </div>
  );
}
