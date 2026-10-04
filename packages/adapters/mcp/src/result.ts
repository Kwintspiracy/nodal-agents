// What an MCP tool call gives back: the record Nodal keeps, and the text the
// model reads.
//
// A `tools/call` result carries two channels (spec 2025-06-18 and later):
//   - `content`, the blocks meant for the model — text, image, audio,
//     resource_link, embedded resource — in the order the server wrote them;
//   - `structuredContent`, the machine form of the same result, which a server
//     "SHOULD also return … serialized … in a TextContent block" for clients
//     that read only `content`.
//
// Nodal used to hand the model `structuredContent` alone whenever it existed,
// dropping every text block (measured 2026-10-01, job ad38e1f3: a print server
// answered "Confirmation not possible … nothing was printed" in its text; the
// model read only `status: pending` in the JSON and asked again). The model now
// reads BOTH: every content block in order, then `structuredContent` — which
// carries what the next call needs (an id) — unless a text block already IS its
// serialization. Nothing the server sent is dropped in silence.
//
// The RECORD keeps both channels, so every reader of `tool_calls.tool_output`
// (the conversation screen, the audit, the bench) still finds the structured
// data where the server put it. Binary payloads (image, audio, blob) are kept
// as their type and size, never their bytes: the row is an audit, not a store.

import { isDeepStrictEqual } from 'node:util';
import { MCP_TOOL_OUTPUT_FORMAT } from '@nodal-agents/shared';

// audit#2026-07-07 F6: nothing capped the size of a returned MCP tool result.
// A third-party MCP server — buggy or actively malicious — can return several
// MB of text or structured data in one response, exploding the agent's token
// budget on a single tool call. 50k chars mirrors the CHAR_CAP pattern used by
// firecrawl/tavily (packages/adapters/firecrawl/src/tools/scrape.ts,
// packages/adapters/tavily/src/tools/search.ts). Overridable for servers that
// legitimately need more headroom.
//
// It bounds each channel as a whole: the content blocks share ONE budget (200
// blocks of 49k each would otherwise all pass a per-block cap), the structured
// payload has its own. This cap is the ROW's; what the model reads fits the
// runner's budget instead (`mcpResultForModel`, `fitToolResult`).
export const MCP_RESULT_CHAR_CAP = Number(process.env.MCP_RESULT_CHAR_CAP) || 50_000;

/**
 * A string cut to `limit` characters, the cut said with the length it was
 * actually cut at — a block cut by what is LEFT of the budget is not cut at
 * the overall cap.
 */
function capText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const kept = Math.max(0, limit);
  return `${value.slice(0, kept)}\n\n[...truncated at ${kept} chars — MCP tool result was larger]`;
}

/**
 * Cap a structured payload for the row.
 *
 * Non-string values are NOT byte-sliced: slicing serialized JSON would hand the
 * agent a syntactically broken payload, which is worse than the oversized-payload
 * problem it's meant to fix. They are REDUCED (`reduceToFit`, the same rule the
 * model's text follows): still valid JSON with every key, the longest strings
 * and lists cut where it happened, each cut said — so the short fields (an id,
 * a status) survive the cap. Only a payload with nothing long enough to reduce
 * is wrapped with an explicit `truncated: true` flag and a JSON preview, so the
 * caller can tell exactly what happened (invariant #4).
 */
function capPayload(value: unknown): unknown {
  if (typeof value === 'string') return capText(value, MCP_RESULT_CHAR_CAP);
  const serialized = JSON.stringify(value) ?? '';
  if (serialized.length <= MCP_RESULT_CHAR_CAP) return value;
  const reduced = reducedJson(value, MCP_RESULT_CHAR_CAP);
  if (reduced !== null) return JSON.parse(reduced) as unknown;
  return {
    truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, MCP_RESULT_CHAR_CAP),
  };
}

/** One content block as Nodal records it. Binary data is replaced by its size. */
export type McpRecordedBlock =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; mimeType: string; bytes: number }
  | {
      type: 'resource_link';
      uri: string;
      name?: string;
      title?: string;
      mimeType?: string;
      description?: string;
    }
  | { type: 'resource'; uri: string; mimeType?: string; text: string }
  | { type: 'resource'; uri: string; mimeType?: string; bytes: number }
  /** A block type this version of Nodal does not know. Kept, said, never dropped. */
  | { type: 'unsupported'; blockType: string }
  /** The blocks past the content budget: counted, never dropped in silence. */
  | { type: 'omitted'; count: number };

/** What an MCP tool's `execute()` returns, and what `tool_calls.tool_output` holds. */
export interface McpToolOutput {
  /**
   * Says this row holds the whole recorded result, not a server payload stored
   * at the root as rows written before did (`@nodal-agents/shared`).
   */
  format: typeof MCP_TOOL_OUTPUT_FORMAT;
  /** Every block of `content`, in the server's order, within the content budget. */
  content: McpRecordedBlock[];
  /** The server's `structuredContent`, capped; absent when it sent none. */
  structuredContent?: unknown;
  /**
   * The payload of a server speaking the 2024-10-07 protocol (`{ toolResult }`,
   * the SDK's CompatibilityCallToolResultSchema), capped; absent otherwise.
   */
  toolResult?: unknown;
}

/** Decoded size of a base64 payload, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** One block, every string the server wrote in it cut to `limit`. */
function recordBlock(block: unknown, limit: number): McpRecordedBlock {
  const b = (typeof block === 'object' && block !== null ? block : {}) as Record<string, unknown>;
  const cap = (v: unknown): string | undefined => {
    const s = str(v);
    return s === undefined ? undefined : capText(s, limit);
  };
  const type = str(b['type']) ?? '(none)';
  switch (type) {
    case 'text':
      return { type: 'text', text: cap(b['text']) ?? '' };
    case 'image':
    case 'audio':
      return {
        type,
        mimeType: cap(b['mimeType']) ?? 'application/octet-stream',
        bytes: base64Bytes(str(b['data']) ?? ''),
      };
    case 'resource_link': {
      const link: McpRecordedBlock = { type: 'resource_link', uri: cap(b['uri']) ?? '' };
      for (const k of ['name', 'title', 'mimeType', 'description'] as const) {
        const v = cap(b[k]);
        if (v !== undefined) link[k] = v;
      }
      return link;
    }
    case 'resource': {
      const r = (
        typeof b['resource'] === 'object' && b['resource'] !== null ? b['resource'] : {}
      ) as Record<string, unknown>;
      const uri = cap(r['uri']) ?? '';
      const mimeType = cap(r['mimeType']);
      const head = mimeType === undefined ? { uri } : { uri, mimeType };
      const text = cap(r['text']);
      if (text !== undefined) return { type: 'resource', ...head, text };
      return { type: 'resource', ...head, bytes: base64Bytes(str(r['blob']) ?? '') };
    }
    default:
      return { type: 'unsupported', blockType: capText(type, 100) };
  }
}

/**
 * The record of one `tools/call` result: the content blocks in order within one
 * budget (the rest counted in an `omitted` block), and the structured payload
 * where the server put it. Shared by success and `isError`.
 */
export function recordMcpResult(raw: object): McpToolOutput {
  // `object`: the SDK's result union also holds the 2024-10-07 compatibility
  // shape. Its loose result schema keeps `toolResult` and defaults `content`.
  const result = raw as { content?: unknown; structuredContent?: unknown; toolResult?: unknown };
  const blocks = Array.isArray(result.content) ? result.content : [];
  const content: McpRecordedBlock[] = [];
  let budget = MCP_RESULT_CHAR_CAP;
  let omitted = 0;
  for (const block of blocks) {
    if (budget <= 0) {
      omitted += 1;
      continue;
    }
    const recorded = recordBlock(block, budget);
    content.push(recorded);
    budget -= JSON.stringify(recorded).length;
  }
  if (omitted > 0) content.push({ type: 'omitted', count: omitted });
  const out: McpToolOutput = { format: MCP_TOOL_OUTPUT_FORMAT, content };
  if (result.structuredContent != null)
    out.structuredContent = capPayload(result.structuredContent);
  if (result.toolResult !== undefined) out.toolResult = capPayload(result.toolResult);
  return out;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function describeBlock(block: McpRecordedBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
    case 'audio':
      return (
        `[${block.type === 'image' ? 'Image' : 'Audio'} returned by the tool ` +
        `(${block.mimeType}, ${size(block.bytes)}): not passed to you. ` +
        `Nodal does not give a tool's ${block.type} to the model.]`
      );
    case 'resource_link': {
      const label = block.title ?? block.name;
      return (
        `[Resource link: ${block.uri}` +
        (label ? ` "${label}"` : '') +
        (block.mimeType ? ` (${block.mimeType})` : '') +
        (block.description ? ` — ${block.description}` : '') +
        ']'
      );
    }
    case 'resource':
      if ('text' in block) {
        return (
          `[Embedded resource ${block.uri}${block.mimeType ? ` (${block.mimeType})` : ''}]\n` +
          block.text
        );
      }
      return (
        `[Embedded resource ${block.uri} ` +
        `(${block.mimeType ?? 'binary'}, ${size(block.bytes)}): binary content, not passed to you.]`
      );
    case 'unsupported':
      return `[Content block of type "${block.blockType}": not supported by Nodal, not passed to you.]`;
    case 'omitted':
      return `[${block.count} more content blocks not kept: the result exceeded ${MCP_RESULT_CHAR_CAP} chars.]`;
  }
}

/** Is this text block the serialization of `payload`? Compared as JSON, not as text. */
function serializes(text: string, payload: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(text), payload);
  } catch {
    return false;
  }
}

/**
 * The text the model reads for one MCP tool result.
 *
 *  - every content block, in the server's order: text as written, every other
 *    block said in one bracketed line (what it is, how big, that the model
 *    does not get it); an empty text block says nothing and is skipped;
 *  - then the machine form — `structuredContent`, or a 2024-10-07
 *    `toolResult` — once: a text block that already IS its serialization is
 *    that machine form (kept as the server wrote it), not text;
 *  - within `maxChars`, the room left for this result's own text
 *    (`fitToolResult`, one budget for the runner and the tool). The machine
 *    form and the line counting the blocks not kept take their room FIRST,
 *    the other blocks get what is left: a long text is cut, and says so. A
 *    machine form that alone exceeds the budget is REDUCED, not cut at its
 *    tail (`reduceToFit`: its longest strings and lists give way first), so
 *    its short fields — the id, the status the next call needs — always
 *    survive; the text it pushed out is named.
 */
export function mcpResultForModel(output: McpToolOutput, maxChars: number): string {
  const payloads = [output.structuredContent, output.toolResult].filter((p) => p !== undefined);
  const machine = payloads.map((payload) => {
    const asWritten = output.content.find(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && serializes(b.text, payload),
    );
    return { payload, text: asWritten?.text ?? serialize(payload) };
  });
  const head = output.content
    .filter(
      (b) =>
        b.type !== 'omitted' &&
        !(b.type === 'text' && (b.text.trim() === '' || machine.some((m) => m.text === b.text))),
    )
    .map(describeBlock)
    .join('\n');
  const omitted = output.content.filter((b) => b.type === 'omitted').map(describeBlock);
  const tail = [...omitted, ...machine.map((m) => m.text)].join('\n');

  if (head === '' && tail === '') return '[The MCP tool returned an empty result.]';
  if (tail === '') return fitWithin(head, maxChars);
  if (head === '' && tail.length <= maxChars) return tail;
  if (head !== '' && tail.length + 1 + MIN_HEAD_CHARS <= maxChars) {
    return `${fitWithin(head, maxChars - tail.length - 1)}\n${tail}`;
  }
  // The machine form leaves no room for the text: reduce it to fit, and name
  // the text it pushed out.
  const note =
    head === ''
      ? ''
      : `[${head.length} chars of text not passed to you: the structured result fills ` +
        `the budget of ${maxChars} chars.]\n`;
  const fixed = omitted.join('\n');
  let room = maxChars - note.length - (fixed === '' ? 0 : fixed.length + 1);
  const reduced: string[] = [];
  machine.forEach((m, i) => {
    const share = Math.floor(room / (machine.length - i)) - (i < machine.length - 1 ? 1 : 0);
    const text = reduceToFit(m.payload, share);
    reduced.push(text);
    room -= text.length + 1;
  });
  return note + [fixed, ...reduced].filter((p) => p !== '').join('\n');
}

function serialize(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

/** A cut list says how many items it lost, in its own last item. */
const CUT_ITEMS = /^\[(\d+) more items cut by Nodal\]$/;

/**
 * A machine form serialized within `max` characters, still valid JSON with
 * every key it had: the longest string or list gives way first — a string is
 * cut, a list loses its last items — each cut said where it happened, until it
 * fits. Short values (an id, a status) are the last things to go, and only if
 * nothing longer is left. A string payload, or one that cannot be reduced
 * further, is cut at its tail with the cut said.
 */
function reduceToFit(payload: unknown, max: number): string {
  return reducedJson(payload, max) ?? fitWithin(serialize(payload), max);
}

/**
 * At most this many fields give way. Each one costs a pass over the payload;
 * a machine form made of thousands of medium strings is not reduced field by
 * field: past this bound it is cut at its tail instead, and the cut is said.
 */
const MAX_REDUCTIONS = 200;

/**
 * The reduction of `reduceToFit` alone: valid JSON within `max`, or null when
 * the payload is not an object or list, has nothing long enough left to
 * reduce, or needs more than `MAX_REDUCTIONS` cuts.
 */
function reducedJson(payload: unknown, max: number): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const copy = structuredClone(payload) as Container;
  for (let cuts = 0; cuts <= MAX_REDUCTIONS; cuts += 1) {
    const json = JSON.stringify(copy);
    const excess = json.length - max;
    if (excess <= 0) return json;
    const leaf = longestLeaf(copy);
    if (!leaf) return null;
    const value = leafValue(leaf);
    if (typeof value === 'string') {
      const keep = Math.max(0, value.length - excess - 48);
      setLeaf(leaf, `${value.slice(0, keep)}…[${value.length - keep} chars cut by Nodal]`);
    } else {
      const list = value as unknown[];
      const last = list.at(-1);
      const already = typeof last === 'string' ? CUT_ITEMS.exec(last) : null;
      const items = already ? list.slice(0, -1) : list;
      const before = already ? Number(already[1]) : 0;
      const keep = Math.floor(items.length / 2);
      setLeaf(leaf, [
        ...items.slice(0, keep),
        `[${before + items.length - keep} more items cut by Nodal]`,
      ]);
    }
  }
  return null;
}

/** The longest string (over 64 chars) or list (over one item) inside `root`, by serialized size. */
function longestLeaf(root: Container): Leaf | null {
  const found: { leaf: Leaf | null; size: number } = { leaf: null, size: 0 };
  const visit = (parent: Container): void => {
    const entries: Array<[string | number, unknown]> = Array.isArray(parent)
      ? parent.map((v, i): [number, unknown] => [i, v])
      : Object.entries(parent);
    for (const [key, v] of entries) {
      if (typeof v === 'string') {
        if (v.length > 64 && v.length > found.size) {
          found.leaf = { parent, key };
          found.size = v.length;
        }
      } else if (Array.isArray(v)) {
        const last = v.at(-1);
        const items = typeof last === 'string' && CUT_ITEMS.test(last) ? v.length - 1 : v.length;
        const size = JSON.stringify(v).length;
        if (items > 1 && size > found.size) {
          found.leaf = { parent, key };
          found.size = size;
        }
        visit(v);
      } else if (v !== null && typeof v === 'object') {
        visit(v as Record<string, unknown>);
      }
    }
  };
  visit(root);
  return found.leaf;
}

type Container = Record<string, unknown> | unknown[];
interface Leaf {
  parent: Container;
  key: string | number;
}

/** Read or write `leaf` in place, object or list alike. */
function leafValue(leaf: Leaf): unknown {
  return (leaf.parent as Record<string | number, unknown>)[leaf.key];
}
function setLeaf(leaf: Leaf, value: unknown): void {
  (leaf.parent as Record<string | number, unknown>)[leaf.key] = value;
}

/**
 * Below this, the text left beside the machine form is too short to say
 * anything but its own truncation marker: the text is then named, not cut.
 */
const MIN_HEAD_CHARS = 200;

/** `value` within `total` characters, the truncation marker included and said. */
function fitWithin(value: string, total: number): string {
  if (value.length <= total) return value;
  const marker = (kept: number): string =>
    `\n\n[...truncated at ${kept} chars — MCP tool result was larger]`;
  const kept = Math.max(0, total - marker(total).length);
  return value.slice(0, kept) + marker(kept);
}
