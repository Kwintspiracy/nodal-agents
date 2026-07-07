// probe-context.ts — best-effort auto-detection of a local model's context
// window (É-3). Local runtimes expose the loaded model's real window over their
// native REST API; the catalog can't know it, so we probe the endpoint once (at
// LLM-key save time) to pre-fill entity_llm_keys.context_window. Purely
// best-effort: any failure returns null and the user sets the value by hand.

/**
 * Try to read the context window (tokens) of the model served at `baseURL`.
 * Returns null when it can't be determined (endpoint unreachable, non-local
 * provider, or an OpenAI-compatible server that doesn't report a window).
 *
 * LM Studio is supported today: its native `/api/v0/models` reports both
 * `loaded_context_length` (the window the model is CURRENTLY loaded with — the
 * one that actually applies) and `max_context_length`. Ollama and other local
 * runtimes can be added here later; until then they degrade to the manual field.
 */
export async function probeContextWindow(opts: {
  baseURL?: string | null;
  model?: string | null;
  timeoutMs?: number;
}): Promise<number | null> {
  const baseURL = opts.baseURL?.trim();
  if (!baseURL) return null;

  // Derive the server origin — LM Studio's rich endpoint lives at the host root
  // (`/api/v0/...`), NOT under the OpenAI-compat `/v1` base the client uses.
  let origin: string;
  try {
    const u = new URL(baseURL);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }

  let signal: AbortSignal;
  try {
    signal = AbortSignal.timeout(opts.timeoutMs ?? 3000);
  } catch {
    // Environments without AbortSignal.timeout — proceed without a timeout.
    signal = undefined as unknown as AbortSignal;
  }

  try {
    const res = await fetch(`${origin}/api/v0/models`, signal ? { signal } : {});
    if (!res.ok) return null;
    const body = (await res.json()) as
      | { data?: Array<Record<string, unknown>> }
      | Array<Record<string, unknown>>;
    const list = Array.isArray(body) ? body : (body.data ?? []);
    if (!Array.isArray(list) || list.length === 0) return null;
    const pick = opts.model ? (list.find((m) => m['id'] === opts.model) ?? list[0]) : list[0];
    if (!pick) return null;
    // The currently-loaded window is authoritative; fall back to the max the
    // model supports if the runtime doesn't report a loaded value.
    const loaded = Number(pick['loaded_context_length']);
    const max = Number(pick['max_context_length']);
    if (Number.isFinite(loaded) && loaded > 0) return Math.floor(loaded);
    if (Number.isFinite(max) && max > 0) return Math.floor(max);
    return null;
  } catch {
    return null; // best-effort — unreachable / non-LM-Studio / bad payload
  }
}
