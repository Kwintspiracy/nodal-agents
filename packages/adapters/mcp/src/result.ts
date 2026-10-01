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
// reads `content`, every block in order; `structuredContent` reaches it only
// when the server wrote no text block, the case the spec's back-compat rule
// leaves without anything else to read.
//
// The RECORD keeps both channels, so every reader of `tool_calls.tool_output`
// (the conversation screen, the audit, the bench) still finds the structured
// data where the server put it. Binary payloads (image, audio, blob) are kept
// as their type and size, never their bytes: the row is an audit, not a store.

// audit#2026-07-07 F6: nothing capped the size of a returned MCP tool result.
// A third-party MCP server — buggy or actively malicious — can return several
// MB of text or structured data in one response, exploding the agent's token
// budget on a single tool call. 50k chars mirrors the CHAR_CAP pattern used by
// firecrawl/tavily (packages/adapters/firecrawl/src/tools/scrape.ts,
// packages/adapters/tavily/src/tools/search.ts). Overridable for servers that
// legitimately need more headroom.
const MCP_RESULT_CHAR_CAP = Number(process.env.MCP_RESULT_CHAR_CAP) || 50_000;

/**
 * Cap the size of a value returned by an MCP tool call.
 *
 * - Strings are truncated in place with a trailing marker (same pattern as
 *   capField/capText in firecrawl/tavily) — always valid text, still readable.
 * - Non-string values (structuredContent objects) are NOT byte-sliced: slicing
 *   serialized JSON would hand the agent a syntactically broken payload, which
 *   is worse than the oversized-payload problem it's meant to fix. Instead they
 *   are wrapped with an explicit `truncated: true` flag and a JSON preview, so
 *   the caller can tell exactly what happened instead of silently receiving
 *   cut-off/corrupt data (invariant #4 — fail loud, no silent smart fallback).
 */
function capMcpResult(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= MCP_RESULT_CHAR_CAP) return value;
    return (
      value.slice(0, MCP_RESULT_CHAR_CAP) +
      `\n\n[...truncated at ${MCP_RESULT_CHAR_CAP} chars — MCP tool result was larger]`
    );
  }
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
  | { type: 'unsupported'; blockType: string };

/** What an MCP tool's `execute()` returns, and what `tool_calls.tool_output` holds. */
export interface McpToolOutput {
  /** Every block of `content`, in the server's order. */
  content: McpRecordedBlock[];
  /** The server's `structuredContent`, capped like any result; absent when it sent none. */
  structuredContent?: unknown;
}

/** Decoded size of a base64 payload, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function recordBlock(block: unknown): McpRecordedBlock {
  const b = (typeof block === 'object' && block !== null ? block : {}) as Record<string, unknown>;
  const type = str(b['type']) ?? '(none)';
  switch (type) {
    case 'text':
      return { type: 'text', text: capMcpResult(str(b['text']) ?? '') as string };
    case 'image':
    case 'audio':
      return {
        type,
        mimeType: str(b['mimeType']) ?? 'application/octet-stream',
        bytes: base64Bytes(str(b['data']) ?? ''),
      };
    case 'resource_link': {
      const link: McpRecordedBlock = { type: 'resource_link', uri: str(b['uri']) ?? '' };
      for (const k of ['name', 'title', 'mimeType', 'description'] as const) {
        const v = str(b[k]);
        if (v !== undefined) link[k] = v;
      }
      return link;
    }
    case 'resource': {
      const r = (
        typeof b['resource'] === 'object' && b['resource'] !== null ? b['resource'] : {}
      ) as Record<string, unknown>;
      const uri = str(r['uri']) ?? '';
      const mimeType = str(r['mimeType']);
      const head = mimeType === undefined ? { uri } : { uri, mimeType };
      const text = str(r['text']);
      if (text !== undefined) {
        return { type: 'resource', ...head, text: capMcpResult(text) as string };
      }
      return { type: 'resource', ...head, bytes: base64Bytes(str(r['blob']) ?? '') };
    }
    default:
      return { type: 'unsupported', blockType: type };
  }
}

/**
 * The record of one `tools/call` result: every content block in order, and the
 * structured payload where the server put it. Shared by success and `isError`.
 */
export function recordMcpResult(raw: object): McpToolOutput {
  // `object`: the SDK's result union also holds the 2024-10-07 compatibility
  // shape (`{ toolResult }`), which has neither channel and records as empty.
  const result = raw as { content?: unknown; structuredContent?: unknown };
  const blocks = Array.isArray(result.content) ? result.content : [];
  const out: McpToolOutput = { content: blocks.map(recordBlock) };
  if (result.structuredContent != null)
    out.structuredContent = capMcpResult(result.structuredContent);
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
  }
}

/**
 * The text the model reads for one MCP tool result.
 *
 *  - every content block, in the server's order: text as written, every other
 *    block said in one bracketed line (what it is, how big, that the model
 *    does not get it) — never silently dropped;
 *  - `structuredContent`, serialized, only when no text block exists;
 *  - capped as a whole, with the truncation said.
 */
export function mcpResultForModel(output: McpToolOutput): string {
  const parts = output.content.map(describeBlock);
  const hasText = output.content.some((b) => b.type === 'text');
  if (!hasText && output.structuredContent !== undefined) {
    parts.push(JSON.stringify(output.structuredContent));
  }
  if (parts.length === 0) return '[The MCP tool returned an empty result.]';
  return capMcpResult(parts.join('\n')) as string;
}
