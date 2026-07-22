// meta-ops/routine-lint.ts — lintRoutineTask: warns (never blocks) when a
// cron routine's task text references capabilities the target agent doesn't
// actually have, or non-existent Nodal concepts.
//
// Root incident (H1b): a cron routine told an agent to "retrieve the
// previously stored version from your state" — "state" is not a Nodal
// concept, and the phrasing implied a tool (`cogni_cortex__get_state`) the
// agent didn't have. The agent improvised and derailed. This lint catches
// that CLASS of incident at routine-CREATION time (schedule-ops.ts wires it
// into create_schedule), surfacing a warning without ever blocking the
// schedule — a routine may legitimately use flexible language, and the
// pattern-match here is a heuristic, not a guarantee.
//
// Pure function: no DB, no I/O. `availableTools` is resolved by the caller
// (resolveAgentToolNames, apps/runner/src/job/resolve-agent-tools.ts).

export interface RoutineLintResult {
  warnings: string[];
}

/**
 * Curated, HIGH-PRECISION list of phrases that reference a non-existent
 * Nodal concept. Deliberately short — this is NOT an exhaustive grammar
 * check, just the specific phrasings that have caused real incidents. Add to
 * it only when a NEW incident proves a new phrase is worth flagging; a long
 * heuristic list would false-positive on legitimate routine language.
 *
 * Each entry: a case-insensitive, word-boundary regex + the warning to emit
 * when it matches.
 */
const AMBIGUOUS_CONCEPT_PATTERNS: ReadonlyArray<{ re: RegExp; warning: string }> = [
  {
    // Matches "your state", "from your state", "in your state", "stored ...
    // in ... state", "retrieve ... state" — the phrasings from the root
    // incident and its obvious variants.
    re: /\b(?:your state|from (?:the |your )?state|in (?:the |your )?state|stored\b[^.]{0,60}\bstate\b|retriev\w*\b[^.]{0,60}\bstate\b)/i,
    warning:
      'Routine says "state" — Nodal has no per-agent "state" store; use `query_memory`/`save_memory` for persistence.',
  },
];

/** Meta/assign tool name PREFIXES — a bare identifier starting with one of
 * these (even without `__`) is treated as tool-shaped. Kept in sync loosely
 * with the meta-tool family names (create_/assign_/attach_/…); not an exact
 * registry mirror — the point is to catch the SHAPE, and the caller's
 * availableTools set is the source of truth for whether it's real. */
const TOOL_SHAPE_PREFIXES = ['create_', 'assign_', 'attach_', 'update_', 'delete_', 'toggle_'];

/** True when a bare (non-backticked) identifier looks like a tool name by shape. */
function looksLikeToolIdentifier(token: string): boolean {
  if (token.includes('__')) return true; // MCP/prefixed tools: slug__tool
  return TOOL_SHAPE_PREFIXES.some((p) => token.startsWith(p));
}

/** True when a backtick-quoted identifier looks like a tool name (snake_case). */
function looksLikeBacktickedTool(token: string): boolean {
  // snake_case: lowercase letters/digits/underscores, at least one underscore
  // OR the `__` namespace shape — conservative, avoids flagging prose quoted
  // for emphasis (e.g. `"9:00"` or a single word like `daily`).
  return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(token);
}

/**
 * Extract tokens from routine text that plausibly look like tool identifiers:
 *  (a) backtick-quoted snake_case identifiers (the routine-writing convention), and
 *  (b) bare identifiers matching known tool-name shapes (`slug__tool`, or a
 *      known meta/assign prefix like `create_`/`assign_`).
 * Deliberately conservative — the goal is zero false positives on ordinary
 * routine prose, not exhaustive extraction.
 */
function extractToolLikeTokens(text: string): string[] {
  const found = new Set<string>();

  const backtickRe = /`([\w-]+)`/g;
  for (const m of text.matchAll(backtickRe)) {
    const token = m[1]!;
    if (looksLikeBacktickedTool(token) || token.includes('__')) found.add(token);
  }

  const bareRe = /\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b/g;
  for (const m of text.matchAll(bareRe)) {
    const token = m[0];
    if (looksLikeToolIdentifier(token)) found.add(token);
  }

  return [...found];
}

/** Suggest a near-match from availableTools for a "did you mean" hint. */
function suggestSimilar(badName: string, available: readonly string[]): string[] {
  const lower = badName.toLowerCase();
  return available
    .filter((t) => {
      const tl = t.toLowerCase();
      return tl !== lower && (tl.endsWith(lower) || tl.includes(lower) || lower.includes(tl));
    })
    .slice(0, 3);
}

/**
 * Lint a routine/schedule task's text against the target agent's real tool
 * whitelist. Two checks:
 *   1. Tool-shaped tokens (backtick-quoted snake_case, `slug__tool`, or a
 *      known meta/assign prefix) that are NOT in `availableTools`.
 *   2. A short, curated list of phrases referencing non-existent Nodal
 *      concepts (currently: "state").
 * Never throws. Returns `{ warnings: [] }` for a clean routine.
 */
export function lintRoutineTask(
  taskText: string,
  availableTools: ReadonlySet<string>,
): RoutineLintResult {
  const warnings: string[] = [];

  const tokens = extractToolLikeTokens(taskText);
  for (const token of tokens) {
    if (availableTools.has(token)) continue;
    const suggestions = suggestSimilar(token, [...availableTools]);
    const hint =
      suggestions.length > 0 ? `did you mean ${suggestions.join(' or ')}?` : 'none matching';
    warnings.push(
      `Routine references tool \`${token}\` which is not available to this agent (available: ${hint})`,
    );
  }

  for (const { re, warning } of AMBIGUOUS_CONCEPT_PATTERNS) {
    if (re.test(taskText)) warnings.push(warning);
  }

  return { warnings };
}
