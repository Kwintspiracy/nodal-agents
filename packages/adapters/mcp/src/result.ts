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
// payload has its own, and the model's text is capped once more after joining.
const MCP_RESULT_CHAR_CAP = Number(process.env.MCP_RESULT_CHAR_CAP) || 50_000;

const TRUNCATED = `\n\n[...truncated at ${MCP_RESULT_CHAR_CAP} chars — MCP tool result was larger]`;

/** A string cut to `limit` characters, the cut said. */
function capText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, Math.max(0, limit)) + TRUNCATED;
}

/**
 * Cap a structured payload.
 *
 * Non-string values are NOT byte-sliced: slicing serialized JSON would hand the
 * agent a syntactically broken payload, which is worse than the oversized-payload
 * problem it's meant to fix. Instead they are wrapped with an explicit
 * `truncated: true` flag and a JSON preview, so the caller can tell exactly what
 * happened instead of silently receiving cut-off/corrupt data (invariant #4).
 */
function capPayload(value: unknown): unknown {
  if (typeof value === 'string') return capText(value, MCP_RESULT_CHAR_CAP);
  const serialized = JSON.stringify(value) ?? '';
  if (serialized.length <= MCP_RESULT_CHAR_CAP) return value;
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
  const out: McpToolOutput = { content };
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
 *  - then the structured payload (`structuredContent`, or a 2024-10-07
 *    `toolResult`), serialized — unless a text block already IS it;
 *  - each channel capped on its own (the blocks here, the payload when it was
 *    recorded), so a long text never silently pushes out the payload or the
 *    line that counts the blocks not kept.
 */
export function mcpResultForModel(output: McpToolOutput): string {
  const texts = output.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
  const blocks = output.content
    .filter((b) => b.type !== 'omitted' && !(b.type === 'text' && b.text.trim() === ''))
    .map(describeBlock);
  const parts = blocks.length > 0 ? [capText(blocks.join('\n'), MCP_RESULT_CHAR_CAP)] : [];
  for (const b of output.content) if (b.type === 'omitted') parts.push(describeBlock(b));
  for (const payload of [output.structuredContent, output.toolResult]) {
    if (payload === undefined || texts.some((t) => serializes(t, payload))) continue;
    parts.push(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
  if (parts.length === 0) return '[The MCP tool returned an empty result.]';
  return parts.join('\n');
}
