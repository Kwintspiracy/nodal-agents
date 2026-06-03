// @nodal-agents/llm — tool_choice floor (runtime safety net)
//
// Some provider endpoints accept the `tools` array and `tool_choice: 'auto'` but
// REJECT the forced value `tool_choice: 'required'` — some OpenRouter routes
// answer "No endpoints found that support the provided 'tool_choice' value".
// Forcing 'required' is a heuristic (anti GPT-drift); when the provider
// can't honour it, falling back to the model's default ('auto') is strictly
// better than failing the whole job. We retry ONCE with 'auto' and LOG it.
//
// This is NOT a silent fallback (invariant #4): #4 forbids hiding a real
// FAILURE behind a fake success — here we adapt to a known provider capability
// limit, loudly, and the agent still gets its tools (just un-forced).

/**
 * True when an error means the provider rejected the tool_choice VALUE we sent
 * (not tool calling in general, and not a transient/quota/timeout error).
 * Scans message + responseBody + data across the cause chain.
 */
export function isUnsupportedToolChoiceError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (!(cur instanceof Error)) return false;
    const parts: string[] = [cur.message ?? ''];
    const body = (cur as { responseBody?: unknown }).responseBody;
    if (typeof body === 'string') parts.push(body);
    const data = (cur as { data?: unknown }).data;
    if (data !== undefined && data !== null) {
      try {
        parts.push(JSON.stringify(data));
      } catch {
        /* ignore non-serialisable */
      }
    }
    const text = parts.join(' ').toLowerCase();
    if (
      text.includes('tool_choice') &&
      (text.includes('no endpoints') ||
        text.includes('not supported') ||
        text.includes('does not support') ||
        text.includes('unsupported') ||
        text.includes('invalid value'))
    ) {
      return true;
    }
    const inner = (cur as { cause?: unknown }).cause;
    if (inner === cur) return false;
    cur = inner;
  }
  return false;
}

/**
 * Run an LLM generate call; if the provider rejects the forced tool_choice
 * value, retry once with 'auto'. `run(override)` performs the call, applying
 * `override` to tool_choice when provided. The relax only fires when the
 * original call forced a non-'auto' value.
 */
export async function generateWithToolChoiceFloor<T>(
  run: (toolChoiceOverride?: 'auto') => Promise<T>,
  toolChoice: unknown,
  label: string,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const wasForced = toolChoice !== undefined && toolChoice !== 'auto';
    if (wasForced && isUnsupportedToolChoiceError(err)) {
      console.warn(
        `[tool_choice_relaxed] ${label}: provider rejected tool_choice=${JSON.stringify(
          toolChoice,
        )} — retrying with 'auto'`,
      );
      return run('auto');
    }
    throw err;
  }
}
