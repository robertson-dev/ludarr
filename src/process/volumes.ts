import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The other volumes of a multi-volume archive whose first volume is `path`, beside it and in order: name.part01.rar →
 * name.part02.rar …; name.rar → name.r00, name.r01 … (and .s00 on); name.7z.001 → name.7z.002 …; name.zip → name.z01 …;
 * name.001 → name.002 …. [] for an archive of one file (or a volume that is not the first: the archiver starts at the first).
 */
export async function volumesOf(path: string): Promise<string[]> {
  const dir = dirname(path), name = basename(path);
  let m: RegExpExecArray | null, re: RegExp | null = null;
  if ((m = /^(.*)\.part0*1\.rar$/i.exec(name))) re = new RegExp(`^${escRe(m[1])}\\.part\\d+\\.rar$`, "i");
  else if (/\.part\d+\.rar$/i.test(name)) return [];
  else if ((m = /^(.*)\.rar$/i.exec(name))) re = new RegExp(`^${escRe(m[1])}\\.[r-z]\\d{2}$`, "i");
  else if ((m = /^(.*\.(?:7z|zip|rar|tar))\.0*1$/i.exec(name))) re = new RegExp(`^${escRe(m[1])}\\.\\d{2,4}$`, "i");
  else if ((m = /^(.*)\.zip$/i.exec(name))) re = new RegExp(`^${escRe(m[1])}\\.z\\d{2}$`, "i");
  else if ((m = /^(.*)\.0*1$/.exec(name))) re = new RegExp(`^${escRe(m[1])}\\.\\d{2,4}$`);
  if (!re) return [];
  const names = (await readdir(dir).catch(() => [] as string[])).filter(n => n !== name && re!.test(n));
  const key = (n: string) => { const d = /(\d+)(?:\.rar)?$/i.exec(n); const letter = /\.([r-z])\d{2}$/i.exec(n)?.[1]?.toLowerCase() ?? ""; return `${letter}${(d?.[1] ?? "").padStart(6, "0")}`; };
  return names.sort((a, b) => key(a).localeCompare(key(b))).map(n => join(dir, n));
}
