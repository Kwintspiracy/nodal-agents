// tool-result-budget.ts — how much of ONE tool result the model reads.
//
// One source for every reader of that budget: the runner fits every tool
// result to it before it enters the conversation (apps/runner/src/job/
// execute.ts), and a tool that shapes its own model text
// (`ToolDefinition.toModelOutput`, an MCP result) shapes it to fit, so that
// what it must keep — an MCP server's machine form, the id the next call
// needs — is never what a cut removes.
//
// The budget is measured on the BLOCK the model reads, not on the tool's
// text: a third party's result is framed (`wrapUntrusted`), and the frame
// both adds its delimiters and lengthens the content (every delimiter token
// inside it is neutralized). A failure the tool raised is a `{ error }` JSON
// block, escaping included. Content is cut to fit, THEN framed — never framed
// then cut, which could remove the closing delimiter.
//
// 25K chars ≈ ~6.5K tokens — lowered from 50K (perf/tokens audit): several
// parallel tool calls in one turn (e.g. 6 tool-calls × 50K) were injecting
// ~78K tokens into a single message. A single tool (e.g. firecrawl_scrape
// returning a full web page) can otherwise inject 100K+ tokens into
// `messages`, which every subsequent turn re-sends to the LLM.

import { isUntrustedTool, wrapUntrusted } from './untrusted';

/** Characters of one tool result the model reads. */
export const TOOL_RESULT_MODEL_CHARS = 25_000;

/**
 * Elide long base64/binary runs. They're useless to the model as text, and
 * they're the dominant re-sent-every-turn bloat: a generated image comes back
 * as ~50K of base64, and the runner re-sends the whole history each turn, so
 * over ~10 turns one job burns ~700K input tokens (observed live, 7c78bf2c,
 * $2.14). Files belong on disk — reference them by path/URL, not inline bytes.
 */
export function elideBinary(value: string): string {
  return value.replace(
    /[A-Za-z0-9+/]{256,}={0,2}/g,
    (m) => `[binary elided: ${m.length} chars — reference the file by path/URL, not inline]`,
  );
}

/**
 * `value` cut to `room` characters, with an explicit, model-readable marker.
 *
 * THE cut of a tool result, for every writer of one: the runner's loop
 * (apps/runner/src/job/execute.ts) and the delegation resume, which writes a
 * child's outcome into its parent's conversation
 * (packages/orchestration/src/router/resume.ts). One function, so one marker
 * and one budget, whoever writes the result.
 */
export function cutForContext(value: string, room: number = TOOL_RESULT_MODEL_CHARS): string {
  if (value.length <= room) return value;
  const dropped = value.length - room;
  return (
    value.slice(0, room) +
    `\n\n[... truncated: ${dropped} chars dropped (total ${value.length}) ...]`
  );
}

/** Truncate an oversized tool-result string with an explicit, model-readable marker. */
export function truncateForContext(value: string): string {
  // Binary runs are elided FIRST (elideBinary), then the rest is cut.
  return cutForContext(elideBinary(value), TOOL_RESULT_MODEL_CHARS);
}

/** The text the model reads for `text` from `toolName`: framed when the tool is a third party's. */
export function framedForModel(toolName: string, text: string): string {
  return isUntrustedTool(toolName) ? wrapUntrusted(toolName, text) : text;
}

/** Length of the `{ error, ...extra }` block of a failure `toolName` raised, as serialized. */
export function raisedErrorBlockLength(
  toolName: string,
  text: string,
  extra: Record<string, unknown> = {},
): number {
  return JSON.stringify({ error: framedForModel(toolName, text), ...extra }).length;
}

/**
 * The longest `render(room)` whose block, as `measure` sizes it, fits the
 * budget. `render` honours `room` for the tool's own text; the room shrinks by
 * what the real block measured over the budget (frame, neutralization,
 * escaping) until it fits.
 */
export function fitToolResult(
  render: (room: number) => string,
  measure: (text: string) => number,
): string {
  let room = TOOL_RESULT_MODEL_CHARS;
  for (;;) {
    const text = render(room);
    const excess = measure(text) - TOOL_RESULT_MODEL_CHARS;
    if (excess <= 0 || room === 0) return text;
    room = Math.max(0, room - excess);
  }
}
