/**
 * ludarr — one classification of trouble on the way to the seedbox (src/remote.ts is what is done about it): an error's own
 * code (EIO, ETIMEDOUT, ESTALE, ENOTCONN, ECONNRESET …, a timeout) is the read path's or the connection's, never the copy's.
 * Words a child program printed ("Input/output error", "Transport endpoint is not connected", "unexpected end of archive")
 * decide nothing by themselves: they only call for a closer look. No imports: the lowest modules (the classifier of a
 * download, the pull engines) use it too.
 */

/** error codes that are the read path's or the connection's (ludarr's own calls), never the copy's */
const CODE_WORDS: Record<string, string> = {
  EIO: "an input/output error", ETIMEDOUT: "a timeout", ESTALE: "a stale file handle", ENOTCONN: "the folder is not connected",
  ECONNRESET: "the connection was reset", ECONNABORTED: "the connection was dropped", ECONNREFUSED: "the connection was refused",
  EHOSTUNREACH: "the host cannot be reached", ENETUNREACH: "the network cannot be reached", ENETDOWN: "the network is down",
  EHOSTDOWN: "the host is down", EAGAIN: "the folder is busy", EPIPE: "the connection broke", ENODEV: "the folder's device is gone",
  ENXIO: "the folder's device is gone", EAI_AGAIN: "the name lookup failed for now", ENOBUFS: "the system ran short of buffers",
  ConnectionRefused: "the connection was refused", ConnectionClosed: "the connection was closed", FailedToOpenSocket: "the connection could not be opened",
  UND_ERR_SOCKET: "the connection broke", UND_ERR_CONNECT_TIMEOUT: "a timeout", UND_ERR_HEADERS_TIMEOUT: "a timeout", UND_ERR_BODY_TIMEOUT: "a timeout",
};
/** the same in words: an error that lost its code on the way (a client's message, what a child program printed). "ran out of
 *  time": a step of a way's make (an unpack, a 7z listing) that read the seedbox's folder past its time limit */
export const TRANSPORT_WORDS = /\b(?:EIO|ETIMEDOUT|ESTALE|ENOTCONN|ECONNRESET|ECONNABORTED|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN)\b|Transport endpoint is not connected|Stale file handle|Input\/output error|\bI\/O error|Read error|\btimed? ?out\b|TimeoutError|socket hang ?up|socket connection was closed|fetch failed|Unable to connect|network (?:error|is unreachable)|connection (?:reset|refused|closed)|\bHTTP[ _]?5\d\d\b|_HTTP_5\d\d\b|unexpected end of (?:archive|data|file)|ran out of time/i;
/** what a download client's own call failing says (its RPC timing out, a 5xx, a dropped connection): the client's trouble */
const CLIENT_WORDS = /TimeoutError|timed? ?out|aborted due to timeout|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|socket|fetch failed|Unable to connect|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|_HTTP_5\d\d\b|\bHTTP[ _]?5\d\d\b|network/i;

export const codeOf = (e: unknown): string => (e && typeof e === "object" ? String((e as { code?: unknown }).code ?? "") : "");
const nameOf = (e: unknown): string => (e && typeof e === "object" ? String((e as { name?: unknown }).name ?? "") : "");
export const messageOf = (e: unknown): string => (e && typeof e === "object" ? String((e as { message?: unknown }).message ?? e) : String(e ?? ""));

/**
 * The read path's or the connection's trouble in an error, in words (null: none). Its own code decides (an fs or network
 * call ludarr made); `words` (default true) also reads its message — only ever for an error ludarr's own call raised
 * (a client's RPC), never as a verdict on what a child program printed (wordsTrouble is that, and decides nothing).
 */
export function transportTrouble(e: unknown, o: { words?: boolean } = {}): string | null {
  const code = codeOf(e);
  if (code && CODE_WORDS[code]) return `${CODE_WORDS[code]} (${code})`;
  if (nameOf(e) === "TimeoutError") return "a timeout";
  if (o.words === false) return null;
  const m = TRANSPORT_WORDS.exec(messageOf(e));
  return m ? `"${m[0]}"` : null;
}
/** words a child program printed that call for a closer look (never a verdict by themselves) */
export const wordsTrouble = (text: string | null | undefined): string | null => { const m = TRANSPORT_WORDS.exec(String(text ?? "")); return m ? m[0] : null; };
/** the system's own words for a transport errno, printed by a child program that read a file or passed on by an importer that
 *  caught ludarr's own call (its code lost on the way): the read path failed it — a damaged copy gives a CRC error, never
 *  these. Both spellings: the kernel's strerror ("Input/output error", "Transport endpoint is not connected" …) and libuv's,
 *  which Bun's own fs errors carry ("EIO: i/o error, copyfile …", "ENOTCONN: socket is not connected") */
const ERRNO_WORDS = /Input\/output error|Transport endpoint is not connected|Stale (?:NFS )?file handle|Connection reset by peer|Connection timed out|No route to host|Software caused connection abort|Host is down|Network is unreachable|\bi\/o error\b|socket is not connected|host is unreachable|\b(?:EIO|ENOTCONN|ESTALE|ETIMEDOUT|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENODEV|ENXIO): /i;
export const errnoWords = (text: string | null | undefined): string | null => { const m = ERRNO_WORDS.exec(String(text ?? "")); return m ? m[0].replace(/: $/, "") : null; };
/** what an archiver says only of the copy itself — a checksum that does not match, a wrong password: a read the seedbox's
 *  link broke off ends in an I/O error or a short read, never in these (SFTP is integrity-checked) */
const COPY_WORDS = /CRC failed|checksum error|wrong password|password is incorrect|incorrect password|Corrupt file|Data error/i;
export const copyWords = (text: string | null | undefined): string | null => { const m = COPY_WORDS.exec(String(text ?? "")); return m ? m[0] : null; };
/** a download client's own call that failed for the connection (a timeout, a 5xx, a refused or dropped connection), not for
 *  anything the release is: the same release is tried again later, nothing is marked tried */
export const clientTrouble = (e: unknown): string | null => transportTrouble(e, { words: false }) ?? (CLIENT_WORDS.test(messageOf(e)) ? messageOf(e).slice(0, 160) : null);

/** where a reader of a folder reports a transient error it swallowed (src/remote.ts installs its trouble log: a walk of the
 *  seedbox's folder that skipped what it could not read then judges nothing from it) — a hook, so the lowest readers need
 *  not import the monitor */
export const readTrouble = { note: (_path: string, _e: unknown): void => { /* nothing installed */ } };
/** for walks that swallow what they cannot read: `.catch(noted(path))` — reported when it is the read path's, then null */
export const noted = (path: string) => (e: unknown): null => { readTrouble.note(path, e); return null; };
