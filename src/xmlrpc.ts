/**
 * ludarr — minimal XML-RPC codec (the subset rTorrent speaks).
 *
 * Encodes string / int (i4 or i8) / boolean / double / base64 (Uint8Array) / array / struct / nil.
 * Decodes the same, plus implicit-string <value>text</value> and <fault> → XmlRpcFault.
 * No DOM in Bun, so this is a tiny purpose-built tag tokenizer — not a general XML parser.
 */
export type XValue = string | number | boolean | Uint8Array | null | XValue[] | { [k: string]: XValue };

export class XmlRpcFault extends Error {
  constructor(public code: number, public fault: string) { super(`XMLRPC_FAULT ${code}: ${fault}`); }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, "&");

function encodeValue(v: XValue): string {
  if (v === null || v === undefined) return "<value><nil/></value>";
  if (typeof v === "string") return `<value><string>${esc(v)}</string></value>`;
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) return `<value><double>${v}</double></value>`;
    return Math.abs(v) <= 0x7fffffff ? `<value><i4>${v}</i4></value>` : `<value><i8>${v}</i8></value>`;
  }
  if (v instanceof Uint8Array) return `<value><base64>${Buffer.from(v).toString("base64")}</base64></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(encodeValue).join("")}</data></array></value>`;
  return `<value><struct>${Object.entries(v)
    .map(([k, x]) => `<member><name>${esc(k)}</name>${encodeValue(x)}</member>`).join("")}</struct></value>`;
}

export function encodeCall(method: string, params: XValue[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><methodCall><methodName>${esc(method)}</methodName><params>` +
    params.map(p => `<param>${encodeValue(p)}</param>`).join("") + `</params></methodCall>`;
}

interface Node { tag: string; kids: Node[]; text: string }

function parseXml(xml: string): Node {
  const root: Node = { tag: "#root", kids: [], text: "" };
  const stack: Node[] = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w:.-]+)\s*>|<([\w:.-]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }        // CDATA, verbatim
    if (m[2] !== undefined) { if (stack.length > 1) stack.pop(); continue; }
    if (m[3] !== undefined) {
      const n: Node = { tag: m[3], kids: [], text: "" };
      top.kids.push(n);
      if (!m[4]) stack.push(n);
      continue;
    }
    if (m[5] !== undefined) top.text += unesc(m[5]);
  }
  return root;
}

function valueOf(n: Node): XValue {
  const k = n.kids[0];
  if (!k) return n.text;                                  // <value>implicit string</value>
  switch (k.tag) {
    case "string": return k.text;
    case "i4": case "int": case "i8": return Number(k.text.trim());
    case "boolean": return k.text.trim() === "1";
    case "double": return parseFloat(k.text.trim());
    case "base64": return new Uint8Array(Buffer.from(k.text.replace(/\s+/g, ""), "base64"));
    case "nil": return null;
    case "array":
      return (k.kids.find(x => x.tag === "data")?.kids ?? []).filter(x => x.tag === "value").map(valueOf);
    case "struct": {
      const o: { [k: string]: XValue } = {};
      for (const mem of k.kids.filter(x => x.tag === "member")) {
        const name = mem.kids.find(x => x.tag === "name")?.text ?? "";
        const val = mem.kids.find(x => x.tag === "value");
        o[name] = val ? valueOf(val) : null;
      }
      return o;
    }
    default: return k.text;
  }
}

export function decodeResponse(xml: string): XValue {
  const resp = parseXml(xml).kids.find(n => n.tag === "methodResponse");
  if (!resp) throw new Error("XMLRPC_BAD_RESPONSE: " + xml.slice(0, 200).replace(/\s+/g, " "));
  const fault = resp.kids.find(n => n.tag === "fault");
  if (fault) {
    const v = fault.kids.find(n => n.tag === "value");
    const s = (v ? valueOf(v) : {}) as { faultCode?: number; faultString?: string };
    throw new XmlRpcFault(Number(s?.faultCode ?? -1), String(s?.faultString ?? "unknown fault"));
  }
  const value = resp.kids.find(n => n.tag === "params")?.kids.find(n => n.tag === "param")?.kids.find(n => n.tag === "value");
  return value ? valueOf(value) : null;
}
