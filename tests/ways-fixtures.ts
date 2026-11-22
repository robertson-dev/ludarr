/**
 * Shared by the ways tests (program, sandbox, assemble): a fake release host behind src/net/public-url.ts's ndeps, a
 * fake 7z run through the sandbox's exec, a temporary <config>, and the deps objects put back after each test.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ndeps } from "../src/net/public-url";
import { sbdeps } from "../src/ways/sandbox";
import { prdeps } from "../src/ways/program";
import { pdeps } from "../src/process/deps";
import type { Exec, ExecOpts, ExecResult, Toolbox } from "../src/process/tools";

export const tmp = (prefix = "ways-") => mkdtempSync(join(tmpdir(), prefix));
export const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
export const sha1 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha1").update(b).digest("hex");
export const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill);
export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** a folder link that needs no admin rights on Windows (a junction; lstat reports it as a link, like a symlink) */
export function dirLink(target: string, at: string) { symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir"); }

export const tools7z: Toolbox = { sevenZip: "7z", unar: null, unrar: null, innoextract: null, wine: null, xvfb: null, bash: "bash", dlgdrive: null };

/** what the tests swap, as it was, to put back */
const saved = { ndeps: { ...ndeps }, sbdeps: { ...sbdeps }, prdeps: { ...prdeps }, pdeps: { ...pdeps } };
export function restoreDeps() {
  Object.assign(ndeps, saved.ndeps); Object.assign(sbdeps, saved.sbdeps); Object.assign(prdeps, saved.prdeps); Object.assign(pdeps, saved.pdeps);
}

/** <config> in a temporary folder (the program cache, builds and tools live under it) */
export function tempConfig(): { dir: string; restore: () => void } {
  const before = process.env.LUDARR_CONFIG;
  const dir = tmp("ways-config-");
  process.env.LUDARR_CONFIG = dir;
  return { dir, restore: () => { if (before === undefined) delete process.env.LUDARR_CONFIG; else process.env.LUDARR_CONFIG = before; } };
}

/** the release host: url → bytes (404 for anything else); every request is recorded; names resolve to a public address */
export function releaseHost(files: Record<string, Uint8Array>) {
  const seen: string[] = [];
  ndeps.lookup = async () => [{ address: "140.82.112.3", family: 4 }];
  ndeps.fetch = async (url: string) => {
    seen.push(url);
    const b = files[url];
    return b ? new Response(new Uint8Array(b), { headers: { "content-length": String(b.byteLength) } }) : new Response("nope", { status: 404 });
  };
  return { seen, files };
}

export interface Call { cmd: string[]; opts: ExecOpts }
/**
 * 7z as the sandbox runs it: `x` materialises the layout registered for the archive's name into -o<dir>, `l -slt`
 * reports the type registered for it (Type = PE when none); anything else goes to `other`, else exit 127.
 */
export function fake7z(layouts: Record<string, (out: string) => void>, o: { types?: Record<string, string>; calls?: Call[]; other?: (cmd: string[], opts: ExecOpts) => Promise<ExecResult> | ExecResult | null } = {}): Exec {
  const calls = o.calls ?? [];
  return async (cmd, opts = {}) => {
    calls.push({ cmd, opts });
    // the sandbox puts runuser … env -i NAME=value … in front: the program is what follows the environment list
    let at = 0;
    if (/runuser$/.test(cmd[0] ?? "")) { at = cmd.indexOf("-i") + 1; while (at < cmd.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd[at])) at++; }
    const c = cmd.slice(at);
    if (c[0] === "7z" && c[1] === "x") {
      const out = c.find(a => a.startsWith("-o"))!.slice(2);
      const lay = layouts[basename(c[c.length - 1])];
      if (!lay) return { code: 2, stdout: "", stderr: `cannot open ${basename(c[c.length - 1])}`, timedOut: false };
      mkdirSync(out, { recursive: true });
      lay(out);
      return ok("Everything is Ok");
    }
    if (c[0] === "7z" && c[1] === "l") {
      const type = o.types?.[basename(c[c.length - 1])] ?? "PE";
      return ok(`7-Zip 16.02\n\nListing archive: ${c[c.length - 1]}\n\n--\nPath = ${c[c.length - 1]}\nType = ${type}\nPhysical Size = 100\n\n----------\nPath = .text\nSize = 10\n`);
    }
    const r = await o.other?.(c, opts);
    return r ?? { code: 127, stdout: "", stderr: `unknown ${c[0]}`, timedOut: false };
  };
}

/** a release archive's contents: the program in one top folder, the way most Windows zips are made */
export function zelda(out: string) {
  mkdirSync(join(out, "Zelda64Recompiled", "assets"), { recursive: true });
  writeFileSync(join(out, "Zelda64Recompiled", "Zelda64Recompiled.exe"), bytes(300_000, 1));
  writeFileSync(join(out, "Zelda64Recompiled", "assets", "ui.rml"), "<rml/>");
  writeFileSync(join(out, "Zelda64Recompiled", "Zelda64Recompiled.pdb"), bytes(1000, 2));
}
