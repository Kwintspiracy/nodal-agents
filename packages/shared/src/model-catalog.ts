// model-catalog.ts — curated, per-provider list of known-good LLM models with
// their tool-calling capability. Small on purpose: it's a convenience layer
// (nice labels + correct flags pre-filled) on top of the entity_llm_keys row.
// The "Custom" path + the live capability probe ("Test") are the source of
// truth for anything NOT listed here. Keep it conservative — a wrong flag is
// caught at runtime by the tool_choice floor, but accuracy avoids wasted calls.
//
// `forcedToolChoice`: does the model/endpoint accept tool_choice:'required'
// (Anthropic {type:'any'}, OpenAI 'required', Gemini ANY)? When false, the
// runner sends 'auto' instead. The runtime tool_choice floor also relaxes any
// model that rejects the forced value at call time, as a generic backstop.

export interface ModelCapabilities {
  tools: boolean;
  forcedToolChoice: boolean;
  /**
   * The model emits a hidden chain-of-thought (a "reasoning model"). On
   * OpenRouter these come back as `reasoning_details` and MUST be echoed back
   * unmodified on the next turn for the model to continue reasoning across tool
   * calls. When true, the OpenRouter provider is told to enable reasoning (so
   * the details are returned) and the runner round-trips them via the assistant
   * message it replays. Omit/false for non-reasoning models.
   */
  reasoning?: boolean;
}

export interface ModelCatalogEntry {
  modelId: string;
  label: string;
  capabilities: ModelCapabilities;
  /** Optional endpoint override (e.g. a model's native Anthropic-compatible URL). */
  route?: { baseURL?: string };
}

// Keyed by provider slug (matches entity_llm_keys.provider). Providers not
// listed (or local: openai-compatible / ollama) → no curated models, the form
// falls back to free-text + Custom + Test.
export const MODEL_CATALOG: Record<string, ModelCatalogEntry[]> = {
  anthropic: [
    {
      modelId: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      capabilities: { tools: true, forcedToolChoice: true },
    },
  ],
  openai: [
    { modelId: 'gpt-5', label: 'GPT-5', capabilities: { tools: true, forcedToolChoice: true } },
    {
      modelId: 'gpt-5-mini',
      label: 'GPT-5 mini',
      capabilities: { tools: true, forcedToolChoice: true },
    },
  ],
  google: [
    {
      modelId: 'gemini-2.0-flash',
      label: 'Gemini 2.0 Flash',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      capabilities: { tools: true, forcedToolChoice: true },
    },
  ],
  groq: [
    {
      modelId: 'llama-3.3-70b-versatile',
      label: 'Llama 3.3 70B',
      capabilities: { tools: true, forcedToolChoice: true },
    },
  ],
  mistral: [
    {
      modelId: 'mistral-large-latest',
      label: 'Mistral Large',
      capabilities: { tools: true, forcedToolChoice: true },
    },
  ],
  // OpenRouter models are namespaced by sub-vendor (anthropic/, deepseek/, …).
  // The UI groups them by that vendor (see modelGroupLabel). Tested + working
  // routes. `forcedToolChoice` is per-model: most accept tool_choice:'required';
  // MiniMax M3 does not (some of its OpenRouter endpoints reject the forced
  // value), so it runs on 'auto' + the runtime floor.
  openrouter: [
    // Anthropic
    {
      modelId: 'anthropic/claude-haiku-4.5',
      label: 'Claude Haiku 4.5',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'anthropic/claude-opus-4.7',
      label: 'Claude Opus 4.7',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'anthropic/claude-opus-4.7-fast',
      label: 'Claude Opus 4.7 (fast)',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'anthropic/claude-opus-4.8',
      label: 'Claude Opus 4.8',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'anthropic/claude-opus-4.8-fast',
      label: 'Claude Opus 4.8 (fast)',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'anthropic/claude-sonnet-4.6',
      label: 'Claude Sonnet 4.6',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    // DeepSeek
    {
      modelId: 'deepseek/deepseek-v3.2',
      label: 'DeepSeek V3.2',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'deepseek/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    // Google
    {
      modelId: 'google/gemini-3.1-flash-lite-preview',
      label: 'Gemini 3.1 Flash Lite (preview)',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'google/gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro (preview)',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'google/gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    {
      modelId: 'google/gemma-4-31b-it',
      label: 'Gemma 4 31B-IT',
      capabilities: { tools: true, forcedToolChoice: true },
    },
    // MiniMax
    {
      modelId: 'minimax/minimax-m3',
      label: 'MiniMax M3',
      // A reasoning model. Some of its OpenRouter endpoints reject a FORCED
      // tool_choice ('required') → we send 'auto' (forcedToolChoice:false).
      // reasoning:true makes the provider return reasoning_details so the runner
      // can round-trip them across tool-call turns.
      capabilities: { tools: true, forcedToolChoice: false, reasoning: true },
    },
  ],
};

/** Look up a curated entry by (provider, modelId). Returns undefined for custom/unknown. */
export function findModelCatalogEntry(
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  return MODEL_CATALOG[provider]?.find((e) => e.modelId === modelId);
}

// Pretty names for the sub-vendor namespaces seen in OpenRouter model ids.
const VENDOR_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  meta: 'Meta',
  qwen: 'Qwen',
  'meta-llama': 'Meta',
};

/**
 * The display GROUP for a catalog model — the sub-vendor prefix of a namespaced
 * id (e.g. `anthropic/claude-…` → "Anthropic"). Returns null for flat ids
 * (native-provider catalogs), which the UI renders without grouping.
 */
export function modelGroupLabel(modelId: string): string | null {
  const slash = modelId.indexOf('/');
  if (slash < 0) return null;
  const vendor = modelId.slice(0, slash);
  return VENDOR_LABELS[vendor] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

/**
 * Group catalog entries by sub-vendor for an `<optgroup>` dropdown. Groups and
 * the entries within each are alphabetical. Entries with no vendor prefix fall
 * into a single null-group (rendered flat).
 */
export function groupModelCatalog(
  entries: ModelCatalogEntry[],
): Array<{ group: string | null; models: ModelCatalogEntry[] }> {
  const byGroup = new Map<string | null, ModelCatalogEntry[]>();
  for (const e of entries) {
    const g = modelGroupLabel(e.modelId);
    const list = byGroup.get(g) ?? [];
    list.push(e);
    byGroup.set(g, list);
  }
  return [...byGroup.entries()]
    .map(([group, models]) => ({
      group,
      models: [...models].sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? ''));
}
