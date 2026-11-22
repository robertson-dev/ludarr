/** The library settings every add asks for: root folder, profile, monitored and search now (once only in the Add modal). */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, type Profile, type RootFolder } from "../api";
import { Row, useLoad } from "./kit";

export interface LibraryValue { monitored: boolean; profileId: number; rootFolderId: number; searchNow: boolean }
/** what POST /api/v1/game takes from them */
export const libraryBody = (v: LibraryValue) => ({ monitored: v.monitored, profileId: v.profileId || null, rootFolderId: v.rootFolderId || null, searchNow: v.searchNow });

/** the choices and the value; the first profile and root folder are picked once they load */
export function useLibraryFields(initial: Partial<LibraryValue> = {}) {
  const { data: profiles } = useLoad(() => get<{ items: Profile[] }>("/api/v1/profile"), []);
  const { data: roots } = useLoad(() => get<{ items: RootFolder[] }>("/api/v1/rootfolder"), []);
  const [value, setValue] = useState<LibraryValue>({ monitored: true, profileId: 0, rootFolderId: 0, searchNow: true, ...initial });
  useEffect(() => {
    setValue(v => ({ ...v, profileId: v.profileId || profiles?.items[0]?.id || 0, rootFolderId: v.rootFolderId || roots?.items[0]?.id || 0 }));
  }, [profiles, roots]);
  return { profiles: profiles?.items ?? [], roots: roots?.items ?? null, value, setValue };
}
export type LibraryState = ReturnType<typeof useLibraryFields>;

export function LibraryFields({ lib, searchHelp }: { lib: LibraryState; searchHelp?: string }) {
  const { value: v, setValue: set, profiles, roots } = lib;
  return (
    <>
      <Row label="Root folder" help={roots && !roots.length ? <>There is no root folder yet: add one under <Link to="/settings/mediamanagement">Settings → Media Management</Link>.</> : undefined}>
        <select className="select" value={v.rootFolderId} onChange={e => set({ ...v, rootFolderId: Number(e.target.value) })} aria-label="Root folder">
          {(roots ?? []).map(r => <option key={r.id} value={r.id}>{r.path}{r.freeSpace != null ? ` (${(r.freeSpace / 1e9).toFixed(0)} GB free)` : ""}</option>)}
        </select>
      </Row>
      <Row label="Profile">
        <select className="select" value={v.profileId} onChange={e => set({ ...v, profileId: Number(e.target.value) })} aria-label="Profile">
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Row>
      <Row label="Monitor" help="Monitored games are searched automatically and picked up on release day.">
        <label className="check"><input type="checkbox" checked={v.monitored} onChange={e => set({ ...v, monitored: e.target.checked })} /> monitored</label>
      </Row>
      <Row label="Start search" help={searchHelp ?? "Search the indexers as soon as the game is added (released games only)."}>
        <label className="check"><input type="checkbox" checked={v.searchNow} disabled={!v.monitored} onChange={e => set({ ...v, searchNow: e.target.checked })} /> search now</label>
      </Row>
    </>
  );
}
