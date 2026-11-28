// answer.ts — THE answer the MCP server gives an outside client.
//
// An outside client (an editor, another agent's host) reads a run's result,
// its error and the input of every request waiting for a person. That is text
// an agent, a tool or a third party wrote, leaving Nodal: it leaves through
// the outbound seam (`@nodal-agents/shared`, outbound.ts), here, for every
// tool of the server. The architecture suite of this package refuses an MCP
// content block built anywhere else (`scanForOutboundBypass`).
//
// The masked copy is what the client reads; the stored rows are untouched.

import { outboundText, outboundValue } from '@nodal-agents/shared';

/** A tool's answer: `value`, masked, as the JSON text of one content block. */
export function mcpAnswer(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(outboundValue(value)) }] };
}

/** A tool's failure: the error's message, masked (it can quote what it failed on). */
export function mcpError(err: unknown): {
  isError: true;
  content: { type: 'text'; text: string }[];
} {
  return {
    isError: true,
    content: [
      { type: 'text', text: outboundText(err instanceof Error ? err.message : String(err)) },
    ],
  };
}
