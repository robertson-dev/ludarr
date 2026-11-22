/** Releases the indexers answered, as Interactive Search and "Test the search" show them. */
import { fmtSize, type Release, type ReleaseSearch } from "../api";
import { IconBtn, Label } from "./kit";
import { protocolTone } from "./status";

/** the line under the table: how many, what was asked, how long, and which indexers failed */
export function SearchSummary({ data }: { data: ReleaseSearch }) {
  return (
    <span className="dim">
      {data.total} release{data.total === 1 ? "" : "s"} · {data.searched.join(" / ")} · {(data.elapsedMs / 1000).toFixed(1)} s
      {data.errors.length > 0 && <span style={{ color: "var(--warning)" }}> · {data.errors.map(e => `${e.indexer}: ${e.error}`).join("; ")}</span>}
    </span>
  );
}

/** the name checks' own reasons (src/releases.ts scoreRelease): a refusal says each of them again, in its own words */
const SAID = /^(the words of the name are in another order|a number after the name|looks like a sequel|extra title words|name not at start|name only inside|the name's "|more words between the name)/;
/** the chips under a release: its first reasons, less what the refusal after them says already */
const chips = (r: Release) => (r.blocked || r.certain ? r.reasons : r.reasons.filter(x => !SAID.test(x) && !(r.refusals ?? []).includes(x))).slice(0, 3);

/** why the automatic search would not take a release: the first reason, every one of them on hover */
function NotTaken({ why }: { why: string[] }) {
  return <span title={why.join("\n")}> · not taken automatically: {why[0] ?? "not certainly this game"}</span>;
}

/** `onGrab` adds the grab button (a saved game); without it the table only shows what a search finds */
export function ReleaseTable({ items, name, onGrab, grabbing }: { items: Release[]; name?: string; onGrab?: (r: Release) => void; grabbing?: string | null }) {
  return (
    <table className="table compact">
      <thead><tr><th>Release</th><th>Indexer</th><th>Age</th><th>Size</th><th>Peers</th><th>Format</th><th>Score</th>{onGrab && <th></th>}</tr></thead>
      <tbody>{items.map(r => (
        <tr key={`${r.instanceId}:${r.guid}`} style={{ opacity: r.blocked ? .5 : 1 }}>
          <td>
            <div className="ellipsis" style={{ maxWidth: 520 }} title={r.title}>{r.infoUrl ? <a href={r.infoUrl} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</div>
            <div className="dim">
              {r.parsed.group && <>{r.parsed.group} · </>}{chips(r).join(" · ")}
              {r.matchedName && name && r.matchedName.toLowerCase() !== name.trim().toLowerCase() ? <> · matched as “{r.matchedName}”</> : null}
              {r.blocked ? " · blocklisted" : !r.certain ? <NotTaken why={r.refusals ?? []} /> : !r.allowed ? " · not allowed by the profile" : ""}
            </div>
          </td>
          <td><Label tone={protocolTone(r.protocol)}>{r.protocol}</Label> <span className="nowrap">{r.indexer}</span></td>
          <td className="nowrap">{r.age} d</td><td className="nowrap">{fmtSize(r.size)}</td>
          <td className="nowrap">{r.protocol === "torrent" ? `${r.seeders ?? "?"} / ${r.leechers ?? "?"}` : "—"}</td>
          <td><Label tone={r.format === "clean" ? "success" : r.format === "iso" ? "info" : r.format === "repack" ? "warning" : "dim"}>{r.format}</Label></td>
          <td>{r.score}</td>
          {onGrab && <td className="actions"><IconBtn icon={grabbing === r.guid ? "spinner" : "download"} label="Grab" onClick={() => onGrab(r)} disabled={!!grabbing} /></td>}
        </tr>
      ))}</tbody>
    </table>
  );
}
