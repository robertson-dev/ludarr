/** Files a release kit consumes on the server. Kept outside its output and never placed in the package. */
import { chmod, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileChunks } from "../fsutil";
import { NeedsFiles, PlanFault } from "./errors";
import { needMatches } from "./match";
import { copyHashed } from "./program";
import { handTo } from "./sandbox";
import { contentFacts, contentHashes, type ContentRow } from "./store";
import type { NeedSlot, RuntimePlanSpec } from "./types";

export interface BuildNeed { need: NeedSlot; file: ContentRow | null }
export const buildNeeds = (spec: RuntimePlanSpec, files: ContentRow[]): BuildNeed[] => spec.needs.flatMap((need, i) =>
  need.build ? [{ need, file: files.find(f => f.need_index === i && needMatches(need, contentFacts(f)).ok) ?? null }] : []);

/** Missing or changed inputs cannot reuse a build made with other bytes. No key bytes enter the cache key. */
export const buildNeedsKey = (inputs: BuildNeed[]) => inputs.map(({ need, file }) => ({
  kind: need.kind, place: need.place, sha256: file ? contentHashes(file).sha256 ?? null : null,
}));

export async function prepareBuildNeeds(inputs: BuildNeed[], dir: string, signal?: AbortSignal): Promise<void> {
  for (const { need, file } of inputs) {
    if (!file || !contentHashes(file).sha256) throw new NeedsFiles(`needs ${need.name} for the server build`);
    const st = await lstat(file.path).catch(() => null);
    if (!st?.isFile() || st.isSymbolicLink()) throw new NeedsFiles(`${need.name} is gone or is not a file`);
  }
  // Never follow a pre-existing directory or link when placing private inputs.
  await mkdir(dir, { mode: 0o700 });
  try {
    for (const { need, file } of inputs) {
      const to = join(dir, ...need.place.split("/"));
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      const sum = await copyHashed(file!.path, to, signal, undefined, "wx");
      if (sum.sha256 !== contentHashes(file!).sha256 || sum.size !== file!.size)
        throw new NeedsFiles(`${need.name} changed on disk: supply it again`);
      await chmod(to, 0o400);
    }
    await handTo(dir, "builder");
  } catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
}

/** A copied/renamed input, or key material in a small output file, is a build fault, never a package. */
export async function checkBuildNeedLeaks(dir: string, inputs: BuildNeed[]): Promise<void> {
  if (!inputs.length) return;
  const files = inputs.flatMap(i => i.file ? [i.file] : []);
  const secrets: string[] = [];
  for (const { need, file } of inputs) if (need.kind === "keys" && file && file.size <= 1024 * 1024) {
    const raw = await readFile(file.path, "utf8");
    for (const m of raw.matchAll(/^\s*[a-zA-Z0-9_]+\s*=\s*([a-fA-F0-9]{32,})/gm)) secrets.push(m[1].toLowerCase());
  }
  const walk = async (at: string): Promise<void> => {
    for (const name of await readdir(at)) {
      const path = join(at, name), st = await lstat(path);
      if (st.isSymbolicLink()) throw new PlanFault("build", "the build output contains a link");
      if (st.isDirectory()) { await walk(path); continue; }
      if (files.some(f => f.size === st.size)) {
        const hash = new Bun.CryptoHasher("sha256");
        for await (const chunk of fileChunks(path)) hash.update(chunk);
        const sum = hash.digest("hex");
        if (files.some(f => contentHashes(f).sha256 === sum))
          throw new PlanFault("build", "the build output contains a server-only input; remove it before packaging");
      }
      if (secrets.length && st.size <= 1024 * 1024) {
        const text = (await readFile(path, "utf8")).toLowerCase();
        if (secrets.some(s => text.includes(s))) throw new PlanFault("build", "the build output contains console key material; remove it before packaging");
      }
    }
  };
  await walk(dir);
}
