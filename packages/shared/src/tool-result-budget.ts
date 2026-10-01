// tool-result-budget.ts — how much of ONE tool result the model reads.
//
// One source for every reader of that budget: the runner cuts every tool
// result at this length before it enters the conversation
// (`truncateForContext`, apps/runner/src/job/execute.ts), and a tool that
// shapes its own model text (`ToolDefinition.toModelOutput`, an MCP result)
// shapes it to fit, so that what it must keep — an MCP server's machine form,
// the id the next call needs — is never what the runner's cut removes.
//
// 25K chars ≈ ~6.5K tokens — lowered from 50K (perf/tokens audit): several
// parallel tool calls in one turn (e.g. 6 tool-calls × 50K) were injecting
// ~78K tokens into a single message. A single tool (e.g. firecrawl_scrape
// returning a full web page) can otherwise inject 100K+ tokens into
// `messages`, which every subsequent turn re-sends to the LLM.

import { isUntrustedTool, wrapUntrusted, UNTRUSTED_WRAP_MIN_CHARS } from './untrusted';

/** Characters of one tool result the model reads. */
export const TOOL_RESULT_MODEL_CHARS = 25_000;

/**
 * The room left for a tool's own text once the runner has framed it: the
 * budget minus what `wrapUntrusted` adds around a third-party tool's result.
 */
export function toolResultRoom(toolName: string): number {
  if (!isUntrustedTool(toolName)) return TOOL_RESULT_MODEL_CHARS;
  const probe = 'x'.repeat(UNTRUSTED_WRAP_MIN_CHARS);
  return TOOL_RESULT_MODEL_CHARS - (wrapUntrusted(toolName, probe).length - probe.length);
}
