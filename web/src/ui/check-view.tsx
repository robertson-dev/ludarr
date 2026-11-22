/**
 * A build's check, as the run and the job's log show it: the verdict in a line, each GPU-free step with its exit code,
 * time and output, and the program's smoke start with its window titles, its output and the screenshot the server kept
 * (fetched with the API key in the header, shown from an object URL that goes with the view).
 */
import { useEffect, useState } from "react";
import { getBlob, sentence, type CheckReport, type SmokeReport } from "../api";
import { Icon } from "./icons";
import { Fold } from "./kit";
import { blobUrl, checkShotName, checkWords, smokeLine } from "../ways/logic";

const TONE_ICON: Record<string, string> = { ok: "check", bad: "x", env: "minusCircle", none: "info" };

/** the check's screenshot (GET /api/v1/check-shot/:name) */
export function CheckShot({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const safe = checkShotName(name);
  useEffect(() => {
    setUrl(null); setGone(false);
    if (!safe) { setGone(true); return; }
    let alive = true;
    const shot = blobUrl(() => getBlob(`/api/v1/check-shot/${encodeURIComponent(safe)}`));
    void shot.ready.then(u => { if (!alive) return; if (u) setUrl(u); else setGone(true); });
    return () => { alive = false; shot.stop(); };
  }, [safe]);
  if (gone) return <div className="dim smoke-note">The screenshot is not kept any more.</div>;
  if (!url) return <div className="dim smoke-note"><Icon name="spinner" size={12} /> Loading the screenshot…</div>;
  return <a className="smoke-shot" href={url} target="_blank" rel="noreferrer" title="Open it full size"><img src={url} alt="The program's window when the server started it" /></a>;
}

function SmokeView({ smoke }: { smoke: SmokeReport }) {
  const tone = smoke.verdict === "pass" ? "ok" : smoke.verdict === "env" ? "env" : "bad";
  return (
    <div className={`check-step ${tone}`}>
      <div className="check-line"><Icon name={TONE_ICON[tone]} size={13} /><span className="grow">{smokeLine(smoke)}</span></div>
      {smoke.screenshot && <CheckShot name={smoke.screenshot} />}
      {smoke.outputTail.trim() && <Fold label="Its output"><pre className="log">{smoke.outputTail}</pre></Fold>}
    </div>
  );
}

export function CheckView({ report }: { report: CheckReport }) {
  const w = checkWords(report);
  const text = report.text.trim();
  // the report's own words, unless the verdict line already says them
  const extra = text && text.toLowerCase().replace(/[.\s]+$/, "") !== w.text.toLowerCase() ? text : null;
  return (
    <div className="check-view">
      <div className={`check-verdict ${w.tone}`}><Icon name={TONE_ICON[w.tone]} size={14} /><b>{w.text}</b></div>
      {extra && <div className="dim check-text">{sentence(extra)}</div>}
      {report.steps.map((s, i) => (
        <div key={i} className={`check-step ${s.ok ? "ok" : "bad"}`}>
          <div className="check-line">
            <Icon name={s.ok ? "check" : "x"} size={13} /><span className="grow">{sentence(s.what)}</span>
            <span className="dim nowrap">{s.code != null ? `exit ${s.code} · ` : ""}{s.seconds < 10 ? s.seconds.toFixed(1) : Math.round(s.seconds)} s</span>
          </div>
          {s.tail.trim() && <Fold label="Its output"><pre className="log">{s.tail}</pre></Fold>}
        </div>
      ))}
      {report.smoke && <SmokeView smoke={report.smoke} />}
    </div>
  );
}
