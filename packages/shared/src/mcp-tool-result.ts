// mcp-tool-result.ts — the mark of an MCP tool result as Nodal records it.
//
// `tool_calls.tool_output` of an MCP call holds the whole result the server
// returned (`packages/adapters/mcp/src/result.ts`): `{ format, content,
// structuredContent?, toolResult? }`. Rows written before that change held the
// server's payload ALONE, at the root — and a server payload may itself carry a
// `content` array (a Notion page, a CRM list). Telling the two apart by shape
// would be a guess; this mark says which is which.

/** The `format` field of a recorded MCP tool result. Absent from any older row. */
export const MCP_TOOL_OUTPUT_FORMAT = 'mcp-tool-result/1';
