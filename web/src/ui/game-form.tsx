/**
 * A game's description as a form (every field of a game added by hand, or only how a store game is searched), the
 * platform picker, and the art picker used before a game exists.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtSize } from "../api";
import { TagsInput } from "./forms";
import { Icon } from "./icons";
import { Btn, Row } from "./kit";
import { LIMITS, PLATFORM_GROUPS, platformLabel, yearOfIso, type DraftField, type DraftForm } from "../ways/logic";

export function PlatformPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const full = value.length >= LIMITS.platforms;
  return (
    <div className="field">
      {value.length > 0 && (
        <div className="taglist">{value.map(p => <span key={p} className="tagi">{platformLabel(p)}<button type="button" aria-label={`remove ${platformLabel(p)}`} onClick={() => onChange(value.filter(x => x !== p))}><Icon name="x" size={11} /></button></span>)}</div>
      )}
      <select className="select" value="" disabled={full} aria-label="Add a platform" onChange={e => { const id = e.target.value; if (id && !value.includes(id)) onChange([...value, id]); }}>
        <option value="">{full ? `that is all ${LIMITS.platforms} of them` : "Add a platform…"}</option>
        {PLATFORM_GROUPS.map(g => {
          const left = g.ids.filter(id => !value.includes(id));
          return left.length ? <optgroup key={g.label} label={g.label}>{left.map(id => <option key={id} value={id}>{platformLabel(id)}</option>)}</optgroup> : null;
        })}
      </select>
    </div>
  );
}

/**
 * The description fields. `only` limits it to some of them (a store game: its other names and search terms), `from`
 * marks fields a draft filled, `errors` comes from formProblems or the server.
 */
export function GameDraftForm({ value, onChange, only, errors = {}, from = {}, autoFocus, nameAside }: {
  value: DraftForm; onChange: (v: DraftForm) => void; only?: DraftField[];
  errors?: Partial<Record<DraftField, string>>; from?: Partial<Record<DraftField, string>>; autoFocus?: boolean; nameAside?: ReactNode;
}) {
  const show = (k: DraftField) => !only || only.includes(k);
  const set = <K extends DraftField>(k: K, v: DraftForm[K]) => onChange({ ...value, [k]: v });
  /** a new date carries its year along unless the admin typed a different one on purpose */
  const setDate = (d: string) => {
    const before = yearOfIso(value.releaseIso), after = yearOfIso(d);
    const follow = !value.year.trim() || (before != null && Number(value.year) === before);
    onChange({ ...value, releaseIso: d, year: follow && after != null ? String(after) : value.year });
  };
  return (
    <>
      {show("name") && (
        <Row label={<>Name<span className="muted"> *</span></>} error={errors.name} src={from.name}>
          <div className="row"><input className="input" value={value.name} onChange={e => set("name", e.target.value)} autoFocus={autoFocus} aria-label="Name" maxLength={200} />{nameAside}</div>
        </Row>
      )}
      {show("aliases") && (
        <Row label="Other names" help="Names the game also goes by: another region's title, a translation, a short form. Each one is searched, and a release must match it as closely as it would the name." error={errors.aliases} src={from.aliases}>
          <TagsInput value={value.aliases} onChange={v => set("aliases", v)} max={LIMITS.aliases} split={false} label="Other names" placeholder={`type a name and press Enter (up to ${LIMITS.aliases})`} />
        </Row>
      )}
      {show("platforms") && (
        <Row label="Platforms" help="What it came out on. For a game with no PC version, the search also looks for its console dumps." error={errors.platforms} src={from.platforms}>
          <PlatformPicker value={value.platforms} onChange={v => set("platforms", v)} />
        </Row>
      )}
      {show("year") && (
        <Row label="Release" help="The year is enough. With a full date, a game that is not out yet is picked up on the day." error={errors.year ?? errors.releaseIso} src={from.year ?? from.releaseIso}>
          <div className="split">
            <input className="input" inputMode="numeric" placeholder="Year" aria-label="Release year" value={value.year} maxLength={4} onChange={e => set("year", e.target.value.replace(/[^\d]/g, ""))} style={{ maxWidth: 110 }} />
            <input className="input" type="date" aria-label="Release date" value={value.releaseIso} onChange={e => setDate(e.target.value)} style={{ maxWidth: 190 }} />
          </div>
        </Row>
      )}
      {show("summary") && (
        <Row label="Summary" help="Players read this in Ahoy." error={errors.summary} src={from.summary}>
          <textarea className="textarea prose" rows={4} value={value.summary} onChange={e => set("summary", e.target.value)} aria-label="Summary" maxLength={4000} />
        </Row>
      )}
      {show("genres") && (
        <Row label="Genres" error={errors.genres} src={from.genres}>
          <TagsInput value={value.genres} onChange={v => set("genres", v)} max={LIMITS.genres} label="Genres" />
        </Row>
      )}
      {show("developer") && (
        <Row label="Developer" error={errors.developer} src={from.developer}>
          <input className="input" value={value.developer} onChange={e => set("developer", e.target.value)} aria-label="Developer" maxLength={200} />
        </Row>
      )}
      {show("publisher") && (
        <Row label="Publisher" error={errors.publisher} src={from.publisher}>
          <input className="input" value={value.publisher} onChange={e => set("publisher", e.target.value)} aria-label="Publisher" maxLength={200} />
        </Row>
      )}
      {show("searchTerms") && (
        <Row label="Search terms" help={`Up to ${LIMITS.searchTerms} extra queries, sent to the indexers as written. They only add results: a release still has to match the name or one of the other names.`} error={errors.searchTerms} src={from.searchTerms}>
          <TagsInput value={value.searchTerms} onChange={v => set("searchTerms", v)} max={LIMITS.searchTerms} split={false} label="Search terms" placeholder="type a query and press Enter" />
        </Row>
      )}
    </>
  );
}

/* ─────────── art picked before the game exists ─────────── */

export interface ArtChoice { file: File | null; url: string }
export const noArt = (): ArtChoice => ({ file: null, url: "" });
const ART_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** the server's limit for an image (src/art.ts) */
export const ART_MAX = 15 * 1024 * 1024;
export const ART_ACCEPT = ART_TYPES.join(",");
/** what the server would refuse about a picked image or a pasted link */
export function artProblem(c: ArtChoice): string | null {
  if (c.file) {
    if (!ART_TYPES.includes(c.file.type)) return "A PNG, JPEG or WebP image";
    if (c.file.size > ART_MAX) return `Up to 15 MB (this one is ${fmtSize(c.file.size)})`;
    return null;
  }
  const u = c.url.trim();
  if (u && !/^https:\/\/[^\s]+$/i.test(u)) return "An https link to the image";
  return null;
}

function useObjectUrl(f: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!f) { setUrl(null); return; }
    const u = URL.createObjectURL(f);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [f]);
  return url;
}

/** a picked file or a pasted https link, with a preview; the file goes up once the game exists, the link is fetched by the server */
export function ArtPick({ kind, value, onChange }: { kind: "poster" | "banner" | "hero" | "logo"; value: ArtChoice; onChange: (v: ArtChoice) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const local = useObjectUrl(value.file);
  const link = value.url.trim();
  const preview = local ?? (/^https:\/\//i.test(link) ? link : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [preview]);
  const problem = artProblem(value);
  return (
    <div className="artpick">
      <div className={`artprev art-${kind}`}>
        {preview && !failed ? <img src={preview} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span>{failed ? "No preview" : `No ${kind}`}</span>}
      </div>
      <div className="artctl">
        <div className="row">
          <Btn size="sm" icon="upload" type="button" onClick={() => input.current?.click()}>Upload a file</Btn>
          {(value.file || link) && <Btn size="sm" kind="ghost" type="button" onClick={() => onChange(noArt())}>Clear</Btn>}
        </div>
        <input ref={input} type="file" accept={ART_ACCEPT} hidden onChange={e => { const f = e.target.files?.[0] ?? null; if (f) onChange({ file: f, url: "" }); e.target.value = ""; }} />
        {value.file
          ? <div className="dim">{value.file.name} · {fmtSize(value.file.size)}</div>
          : <input className="input" placeholder="or paste an https link to an image" aria-label={`${kind} link`} value={value.url} onChange={e => onChange({ file: null, url: e.target.value })} />}
        {problem ? <div className="err">{problem}</div>
          : failed && link ? <div className="help">The preview did not load here. The server fetches the link itself when the game is added, and refuses the add if it gives no image.</div> : null}
      </div>
    </div>
  );
}
