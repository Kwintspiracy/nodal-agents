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

/**
 * Reasoning-effort levels an agent can request. 'off' disables thinking where
 * the model allows it; a null/absent agent setting means Auto (the provider's
 * current default behavior, unchanged from before this feature).
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

/** UI/validation order of the full scale (Auto is the absence of a value). */
export const REASONING_EFFORT_LEVELS: readonly ReasoningEffort[] = [
  'off',
  'low',
  'medium',
  'high',
  'max',
];

/** A level that carries an intensity (everything except 'off'). */
export type ReasoningLevel = Exclude<ReasoningEffort, 'off'>;

/**
 * HOW a model's reasoning intensity is controlled — declared per catalog entry
 * so the UI only offers levels the model really has and each provider builder
 * translates deterministically (no silent clamping at runtime):
 * - 'effort':          named level sent as-is (OpenRouter `reasoning.effort`,
 *                      OpenAI `reasoning_effort`, Kimi K3 top-level field).
 * - 'adaptive-effort': Anthropic ≥4.6 `output_config.effort`.
 * - 'budget':          level mapped to a thinking token budget (`budgets`).
 * - 'onoff':           thinking can only be enabled/disabled — no intensity.
 */
export interface ReasoningControl {
  kind: 'effort' | 'adaptive-effort' | 'budget' | 'onoff';
  /** For 'effort'/'adaptive-effort': levels the model actually accepts (ordered low→high). */
  levels?: ReasoningLevel[];
  /** For 'budget': thinking-token budget per level. */
  budgets?: Partial<Record<ReasoningLevel, number>>;
  /** Reasoning cannot be disabled for this model — 'off' is not offered. */
  mandatory?: boolean;
}

export interface ModelCapabilities {
  tools: boolean;
  forcedToolChoice: boolean;
  /**
   * The model accepts IMAGE input (it can "see" pictures). Sourced from the
   * providers themselves — OpenRouter's `/api/v1/models` `architecture.
   * input_modalities` and models.dev's `modalities.input` (refresh with
   * `node scripts/refresh-model-vision.mjs`). Drives whether an inbound image is
   * sent to the model AND is surfaced in the orchestrator's team block so it can
   * route an image to a vision-capable teammate. Stamped onto every entry at load
   * from VISION_MODEL_IDS; absence/false = text-only.
   */
  vision?: boolean;
  /**
   * The model emits a hidden chain-of-thought (a "reasoning model"). On
   * OpenRouter these come back as `reasoning_details` and MUST be echoed back
   * unmodified on the next turn for the model to continue reasoning across tool
   * calls. When true, the OpenRouter provider is told to enable reasoning (so
   * the details are returned) and the runner round-trips them via the assistant
   * message it replays. Omit/false for non-reasoning models.
   */
  reasoning?: boolean;
  /**
   * How the model's reasoning INTENSITY is controlled (see ReasoningControl).
   * Present ⇒ the agent's reasoning-effort setting applies to this model and
   * the UI shows the declared levels. Can be present with `reasoning` unset
   * (OpenRouter Claude routes: effort is controllable on demand, but we do NOT
   * flip the always-on reasoning default the `reasoning` flag implies).
   */
  reasoningControl?: ReasoningControl;
}

/**
 * List price per the provider's own published rate card (not a live quote —
 * refresh manually when a vendor changes pricing). Used to DERIVE a call's
 * dollar cost for providers that don't self-report one (see `estimateModelCostUsd`
 * / Guard 1e in apps/runner/src/job/execute.ts). Standard/cache-miss rate.
 */
export interface ModelPricing {
  /** USD per 1M INPUT tokens. */
  inputPerMillionUsd: number;
  /** USD per 1M OUTPUT tokens. */
  outputPerMillionUsd: number;
}

export interface ModelCatalogEntry {
  modelId: string;
  label: string;
  capabilities: ModelCapabilities;
  /**
   * The model's context window in tokens. The runner uses it to compact the
   * conversation (evict old tool results) before it overflows. Omit for unknown
   * — callers fall back to DEFAULT_CONTEXT_WINDOW.
   */
  contextWindow?: number;
  /**
   * List price for deriving cost on providers that don't self-report it (see
   * `estimateModelCostUsd`). Omit for unpriced models — the derived cost then
   * stays 0 (documented debt: Guard 1a's token budget is the backstop for
   * those, same as before this field existed).
   */
  pricing?: ModelPricing;
  /** Optional endpoint override (e.g. a model's native Anthropic-compatible URL). */
  route?: { baseURL?: string };
  /**
   * Preferred upstream provider order for OpenRouter routing. When set,
   * `buildOpenRouterModel` adds `provider: { order, allow_fallbacks: true }` to
   * the extraBody so OpenRouter tries these upstreams in order before falling back
   * to its default routing. Omit for models where default routing is fine.
   * Example: `['deepseek']` pins a DeepSeek model to DeepSeek's own upstream
   * (lower latency, lower cost) while still allowing fallback.
   */
  providerOrder?: string[];
}

// Keyed by provider slug (matches entity_llm_keys.provider). Providers not
// listed (or local: openai-compatible / ollama) → no curated models, the form
// falls back to free-text + Custom + Test.
export const MODEL_CATALOG: Record<string, ModelCatalogEntry[]> = {
  // ─── Native DeepSeek (api.deepseek.com) ─────────────────────────────────────
  // Model IDs verified against DeepSeek API docs (June 2026).
  // Context windows from DeepSeek's documentation: both deepseek-chat and
  // deepseek-reasoner support 64K output / 128K context.
  deepseek: [
    {
      modelId: 'deepseek-chat',
      label: 'DeepSeek Chat (V3)',
      // deepseek-chat is the production alias for DeepSeek V3. Standard tool
      // calling with forced tool_choice supported.
      capabilities: { tools: true, forcedToolChoice: true },
      contextWindow: 128_000,
      // Standard (cache-miss) rate per DeepSeek's public pricing page —
      // verify against api-docs.deepseek.com/quick_start/pricing if this drifts.
      pricing: { inputPerMillionUsd: 0.27, outputPerMillionUsd: 1.1 },
    },
    {
      modelId: 'deepseek-reasoner',
      label: 'DeepSeek Reasoner (R1)',
      // DeepSeek R1 — a reasoning/thinking model. Requires `thinking: {type: 'enabled'}`
      // in the request (the deepseek.ts provider sets this automatically when
      // reasoning:true). Also requires reasoning_content to be echoed back on
      // assistant messages with tool_calls (the deepseek fetch shim handles this).
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        // DeepSeek's native API has no intensity knob — thinking is on or off.
        reasoningControl: { kind: 'onoff' },
      },
      contextWindow: 128_000,
      pricing: { inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19 },
    },
  ],

  // ─── Native MiniMax (api.minimax.io/anthropic) ───────────────────────────────
  // Current MiniMax text models, from the official docs
  // (platform.minimax.io/docs/api-reference/text-chat — June 2026). The M2/M3
  // line supersedes M1, which is no longer listed, so it's dropped here. The
  // full lineup also includes M2.1/M2.5 and `-highspeed` variants — use the
  // model picker's "Custom…" field for those; this is the curated short list.
  // forcedToolChoice:false across the M-series — the MiniMax endpoint rejects a
  // forced tool_choice with a 400/404 (observed on M3 via OpenRouter); the
  // runtime completion floor covers it. Context windows are docs-sourced where
  // available, else a conservative 200K until a live probe confirms.
  // No `pricing` yet (unlike deepseek above) — no confidently-current MiniMax
  // rate card verified at write time. Left as documented debt (Fix #21): the
  // derived-cost fallback returns 0 for these until pricing is added, same as
  // every other unpriced entry in this catalog; Guard 1a (token budget) is the
  // backstop meanwhile.
  minimax: [
    {
      modelId: 'MiniMax-M3',
      label: 'MiniMax M3',
      // Newest flagship — a reasoning model (adaptive `thinking`), 1M context.
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        // minimax.ts injects thinking.budget_tokens (today fixed at 8000 =
        // this scale's 'medium'); ladder mirrors Hermes' Anthropic budgets.
        reasoningControl: {
          kind: 'budget',
          budgets: { low: 4000, medium: 8000, high: 16_000, max: 32_000 },
        },
      },
      contextWindow: 1_048_576,
    },
    {
      modelId: 'MiniMax-M2.7',
      label: 'MiniMax M2.7',
      // Latest M2-series — non-reasoning per MiniMax docs.
      capabilities: { tools: true, forcedToolChoice: false },
      contextWindow: 200_000,
    },
    {
      modelId: 'MiniMax-M2',
      label: 'MiniMax M2',
      // Stable previous-generation baseline — non-reasoning.
      capabilities: { tools: true, forcedToolChoice: false },
      contextWindow: 200_000,
    },
  ],
  // ─── Native Moonshot / Kimi (api.moonshot.ai/v1) ────────────────────────────
  // Both models confirmed multimodal (text + image input) via WebFetch against
  // openrouter.ai's model pages and platform.kimi.ai/docs (2026-07). Both run
  // in mandatory thinking mode — moonshot.ts injects `thinking:{type:'enabled'}`
  // and never sends `temperature` (undocumented for this line) or a competing
  // `reasoning_effort`. No `forcedToolChoice`: Moonshot's chat API docs don't
  // mention a `tool_choice` parameter at all — the runtime completion floor
  // covers it, same treatment as the other undocumented-tool_choice reasoning
  // models (MiniMax M3, GLM 5.2) in this catalog.
  // No `pricing` — no native (non-OpenRouter) Moonshot rate card confirmed at
  // write time; documented debt, same convention as the MiniMax entries above.
  // kimi-k2-thinking is deliberately NOT catalogued (discontinued by Moonshot).
  moonshot: [
    {
      modelId: 'kimi-k2.6',
      label: 'Kimi K2.6',
      // K2-line: mandatory thinking mode (`thinking:{type:'enabled'}`), no
      // intensity knob, cannot be disabled.
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        reasoningControl: { kind: 'onoff', mandatory: true },
      },
      contextWindow: 262_144,
    },
    {
      modelId: 'kimi-k2.7-code',
      label: 'Kimi K2.7 Code',
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        reasoningControl: { kind: 'onoff', mandatory: true },
      },
      contextWindow: 262_144,
    },
    {
      modelId: 'kimi-k3',
      label: 'Kimi K3',
      // Released 2026-07-16. Verified against platform.kimi.ai/docs/pricing/
      // chat-k3: 1M context, multimodal, always reasons server-side with a
      // top-level `reasoning_effort` control (currently `max` only) — NOT the
      // K2-line `thinking` field, so moonshot.ts deliberately does not inject
      // `thinking` for it (K2-line gate). reasoning:true is still required so
      // the runtime round-trips reasoning content.
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        // K3 always reasons server-side; its only accepted level today is 'max'.
        reasoningControl: { kind: 'effort', levels: ['max'], mandatory: true },
      },
      contextWindow: 1_048_576,
    },
  ],
  // Anthropic — every current Claude supports extended thinking. Auto (no
  // agent setting) keeps today's behavior: NO thinking injected. Models ≥4.6
  // take the adaptive `output_config.effort`; Haiku 4.5 (<4.6) takes a
  // `thinking.budget_tokens` ladder (mirrors Hermes' anthropic_adapter table).
  anthropic: [
    {
      modelId: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        reasoningControl: { kind: 'adaptive-effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 200_000,
    },
    {
      modelId: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        reasoningControl: { kind: 'adaptive-effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 200_000,
    },
    {
      modelId: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        reasoningControl: {
          kind: 'budget',
          budgets: { low: 4000, medium: 8000, high: 16_000, max: 32_000 },
        },
      },
      contextWindow: 200_000,
    },
  ],
  // OpenAI — GPT-5 line takes `reasoning_effort`. Auto = today's behavior
  // (nothing sent, provider default). 'off' is not offered: the line always
  // reasons (minimal ≠ none), hence mandatory.
  openai: [
    {
      modelId: 'gpt-5',
      label: 'GPT-5',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high'], mandatory: true },
      },
      contextWindow: 400_000,
    },
    {
      modelId: 'gpt-5-mini',
      label: 'GPT-5 mini',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high'], mandatory: true },
      },
      contextWindow: 400_000,
    },
  ],
  // ─── Native Google (generativelanguage.googleapis.com) ──────────────────────
  // gemini-2.0-flash and gemini-2.5-pro were verified live (2026-07-12, real
  // key) to 404 / be shut down — dropped per product decision (family 3.x
  // only in the native catalog; gemini-2.5-flash deliberately NOT added).
  // Both entries below confirmed alive via ai.google.dev/gemini-api/docs/models
  // and openrouter.ai/google/… (2026-07-12): 1M-token context window, native
  // reasoning ("thinking") models, multimodal (text/image/video/audio/PDF).
  // forcedToolChoice:false — matches this file's reasoning-model convention
  // (MiniMax M3, Moonshot, GLM 5.2): don't force tool_choice on a thinking
  // model, let the runtime completion floor relax it to 'auto'. google.ts's
  // fetch shim injects generationConfig.thinkingConfig for these two entries
  // (reasoning:true gates it) so the API returns the chain-of-thought the
  // execute.ts round-trip needs across tool-call turns.
  // Reasoning control: Gemini 3.x takes `thinkingConfig.thinking_level`
  // (low/medium/high per ai.google.dev — MEDIUM available on 3.1 Pro and
  // 3 Flash+); thinking cannot be fully disabled on this line → mandatory.
  google: [
    {
      modelId: 'gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high'], mandatory: true },
      },
      contextWindow: 1_048_576,
    },
    {
      modelId: 'gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro (preview)',
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high'], mandatory: true },
      },
      contextWindow: 1_048_576,
    },
  ],
  groq: [
    {
      modelId: 'llama-3.3-70b-versatile',
      label: 'Llama 3.3 70B',
      capabilities: { tools: true, forcedToolChoice: true },
      contextWindow: 131_072,
    },
  ],
  mistral: [
    {
      modelId: 'mistral-large-latest',
      label: 'Mistral Large',
      capabilities: { tools: true, forcedToolChoice: true },
      contextWindow: 131_072,
    },
  ],
  // OpenRouter models are namespaced by sub-vendor (anthropic/, deepseek/, …).
  // The UI groups them by that vendor (see modelGroupLabel). Tested + working
  // routes. `forcedToolChoice` is per-model: most accept tool_choice:'required';
  // MiniMax M3 does not (some of its OpenRouter endpoints reject the forced
  // value), so it runs on 'auto' + the runtime floor.
  openrouter: [
    // Anthropic — reasoningControl WITHOUT the `reasoning` flag, on purpose:
    // the flag would flip openrouter.ts's always-on default injection; here
    // thinking is engaged only when the agent explicitly sets an effort.
    // OpenRouter's unified `reasoning.effort` reaches Claude (max → xhigh).
    {
      modelId: 'anthropic/claude-haiku-4.5',
      label: 'Claude Haiku 4.5',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 200_000,
    },
    {
      modelId: 'anthropic/claude-opus-4.7',
      label: 'Claude Opus 4.7',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_000_000,
    },
    {
      modelId: 'anthropic/claude-opus-4.7-fast',
      label: 'Claude Opus 4.7 (fast)',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_000_000,
    },
    {
      modelId: 'anthropic/claude-opus-4.8',
      label: 'Claude Opus 4.8',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_000_000,
    },
    {
      modelId: 'anthropic/claude-opus-4.8-fast',
      label: 'Claude Opus 4.8 (fast)',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_000_000,
    },
    {
      modelId: 'anthropic/claude-sonnet-4.6',
      label: 'Claude Sonnet 4.6',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_000_000,
    },
    // DeepSeek
    {
      modelId: 'deepseek/deepseek-v3.2',
      label: 'DeepSeek V3.2',
      capabilities: { tools: true, forcedToolChoice: true },
      contextWindow: 131_072,
    },
    {
      modelId: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      // DeepSeek V4 is a reasoning model (reasoning_content / reasoning effort).
      // Flagging reasoning makes the OpenRouter provider enable reasoning + round-trip
      // its reasoning_details across tool calls — without it the model misbehaves
      // (gathers then emits no answer). Matches how Hermes drives DeepSeek.
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        // OpenRouter unified `reasoning.effort` (max → xhigh); OpenRouter maps
        // a requested effort to the nearest level the upstream really supports.
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_048_576,
      providerOrder: ['deepseek'],
    },
    {
      modelId: 'deepseek/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        // OpenRouter unified `reasoning.effort` (max → xhigh); OpenRouter maps
        // a requested effort to the nearest level the upstream really supports.
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_048_576,
      providerOrder: ['deepseek'],
    },
    // Google — all three are thinking models on OpenRouter (supported_parameters
    // includes "reasoning", verified via openrouter.ai/google/… 2026-07-12).
    // reasoning:true makes the OpenRouter provider enable reasoning + round-trip
    // reasoning_details across tool-call turns. Unlike the M-series/Kimi/GLM
    // reasoning entries above, forcedToolChoice stays true here — no evidence
    // (live or documented) that OpenRouter's Gemini routes reject a forced
    // tool_choice, matching how deepseek/deepseek-v4-flash (also reasoning:true)
    // keeps forcedToolChoice:true in this file.
    {
      modelId: 'google/gemini-3.1-flash-lite-preview',
      label: 'Gemini 3.1 Flash Lite (preview)',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        // OpenRouter unified `reasoning.effort` (max → xhigh); OpenRouter maps
        // a requested effort to the nearest level the upstream really supports.
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_048_576,
    },
    {
      modelId: 'google/gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro (preview)',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        // OpenRouter unified `reasoning.effort` (max → xhigh); OpenRouter maps
        // a requested effort to the nearest level the upstream really supports.
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_048_576,
    },
    {
      modelId: 'google/gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        // OpenRouter unified `reasoning.effort` (max → xhigh); OpenRouter maps
        // a requested effort to the nearest level the upstream really supports.
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_048_576,
    },
    {
      modelId: 'google/gemma-4-31b-it',
      label: 'Gemma 4 31B-IT',
      capabilities: { tools: true, forcedToolChoice: true },
      contextWindow: 262_144,
    },
    // MiniMax
    {
      modelId: 'minimax/minimax-m3',
      label: 'MiniMax M3',
      // A reasoning model. Some of its OpenRouter endpoints reject a FORCED
      // tool_choice ('required') → we send 'auto' (forcedToolChoice:false).
      // reasoning:true makes the provider return reasoning_details so the runner
      // can round-trip them across tool-call turns.
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_048_576,
    },
    // Z.ai (GLM)
    {
      modelId: 'z-ai/glm-5.2',
      label: 'GLM 5.2',
      // A reasoning model (reasoning effort high/xhigh), strong at coding + tool
      // use. reasoning:true → provider returns reasoning_details for round-trip.
      // forcedToolChoice:false: send 'auto' (don't risk a rejected 'required' on
      // a reasoning model; workers are 'auto' after turn 1 anyway).
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        // GLM 5.2 always reasons; upstream accepts high/xhigh — OpenRouter
        // normalizes lower requests up to its floor.
        reasoningControl: {
          kind: 'effort',
          levels: ['low', 'medium', 'high', 'max'],
          mandatory: true,
        },
      },
      contextWindow: 1_048_576,
    },
    // Moonshot (Kimi)
    {
      modelId: 'moonshotai/kimi-k2.6',
      label: 'Kimi K2.6',
      // Confirmed multimodal + reasoning via WebFetch (openrouter.ai, 2026-07).
      // K2.6 is below the K2.7 native-tool_calls cutoff in detectAgenticFamily
      // (openrouter.ts) — it emits Kimi's pipe-bracket textual tool-call markup,
      // so it gets the kimiToolCallMiddleware parser. No pricing field: none of
      // this file's other OpenRouter entries carry one (OpenRouter self-reports
      // real cost via providerMetadata.openrouter.usage.cost — see
      // estimateModelCostUsd's doc comment).
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        reasoningControl: {
          kind: 'effort',
          levels: ['low', 'medium', 'high', 'max'],
          mandatory: true,
        },
      },
      contextWindow: 262_144,
    },
    {
      modelId: 'moonshotai/kimi-k2.7-code',
      label: 'Kimi K2.7 Code',
      // Always operates in thinking mode and preserves reasoning_content across
      // turns (like DeepSeek) → reasoning:true is required so the provider
      // round-trips reasoning_details. forcedToolChoice:false for the same reason
      // as the other reasoning models.
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        reasoningControl: {
          kind: 'effort',
          levels: ['low', 'medium', 'high', 'max'],
          mandatory: true,
        },
      },
      contextWindow: 262_144,
    },
    // xAI — grok-4.5 verified via OpenRouter /api/v1/models (2026-07-20):
    // 500K context, text+image, tools + tool_choice + reasoning params.
    // Reasoning control cross-checked against Hermes (model_metadata.py,
    // verified live by them 2026-07-08): accepts effort low/medium/high,
    // REJECTS 'none' → mandatory (no Off), no xhigh → no 'max' level.
    {
      modelId: 'x-ai/grok-4.5',
      label: 'Grok 4.5',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoning: true,
        reasoningControl: {
          kind: 'effort',
          levels: ['low', 'medium', 'high'],
          mandatory: true,
        },
      },
      contextWindow: 500_000,
    },
    // Qwen — both verified via OpenRouter /api/v1/models (2026-07-20): 1M
    // context, tools + tool_choice + reasoning params (no native
    // reasoning_effort — OpenRouter's unified param drives the hybrid
    // thinking mode). Same pattern as the Claude routes above:
    // reasoningControl WITHOUT the always-on `reasoning` flag — Auto keeps
    // the provider's default behavior, thinking engages only on explicit
    // effort. Hermes catalogs both as plain OpenRouter models (no adapter).
    // qwen3.7-max is TEXT-ONLY (no image input); qwen3.7-plus is multimodal.
    {
      modelId: 'qwen/qwen3.7-max',
      label: 'Qwen 3.7 Max',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_048_576,
    },
    {
      modelId: 'qwen/qwen3.7-plus',
      label: 'Qwen 3.7 Plus',
      capabilities: {
        tools: true,
        forcedToolChoice: true,
        reasoningControl: { kind: 'effort', levels: ['low', 'medium', 'high', 'max'] },
      },
      contextWindow: 1_048_576,
    },
    {
      modelId: 'moonshotai/kimi-k3',
      label: 'Kimi K3',
      // Released 2026-07-16, verified via OpenRouter /api/v1/models: 1,048,576
      // context, text+image input, supports tools/tool_choice/reasoning params.
      // Above the K2.7 native-tool_calls cutoff — detectAgenticFamily
      // (openrouter.ts) only matches `moonshotai/kimi-k2*`, so K3 correctly
      // falls through to native tool_calls with no textual-markup middleware
      // (the kimi-* tool-schema sanitizer still applies).
      capabilities: {
        tools: true,
        forcedToolChoice: false,
        reasoning: true,
        reasoningControl: {
          kind: 'effort',
          levels: ['low', 'medium', 'high', 'max'],
          mandatory: true,
        },
      },
      contextWindow: 1_048_576,
    },
  ],
};

/**
 * Models that accept IMAGE input, by model id (both the namespaced OpenRouter
 * form and the native-provider form). Source of truth fetched from the providers:
 * OpenRouter's `/api/v1/models` (`architecture.input_modalities` includes "image")
 * and models.dev (`modalities.input`). Refresh with
 * `node scripts/refresh-model-vision.mjs`. Keyed by model id (not provider)
 * because a model is vision-capable wherever it's served.
 */
export const VISION_MODEL_IDS = new Set<string>([
  // OpenRouter (verified via /api/v1/models)
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.7-fast',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.8-fast',
  'anthropic/claude-sonnet-4.6',
  'google/gemini-3.1-flash-lite-preview',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash',
  'google/gemma-4-31b-it',
  'minimax/minimax-m3',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2.7-code',
  'moonshotai/kimi-k3',
  // Verified via OpenRouter /api/v1/models input_modalities (2026-07-20).
  // qwen/qwen3.7-max is deliberately absent — text-only per the same source.
  'x-ai/grok-4.5',
  'qwen/qwen3.7-plus',
  // Native-provider forms
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5',
  'gpt-5-mini',
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'mistral-large-latest',
  'MiniMax-M3',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k3',
]);

// Stamp the fetched vision capability onto every catalogued entry so the picker
// and any catalog consumer sees it alongside tools/reasoning — no per-entry edit.
for (const entries of Object.values(MODEL_CATALOG)) {
  for (const e of entries) e.capabilities.vision = VISION_MODEL_IDS.has(e.modelId);
}

/**
 * Does this model accept image input? Keyed by model id (the canonical truth from
 * the providers). Unknown/custom → false (conservative: don't send an image to a
 * model we can't confirm sees them, which would error the provider call).
 */
export function modelCanSeeImages(modelId: string): boolean {
  return VISION_MODEL_IDS.has(modelId);
}

/** Look up a curated entry by (provider, modelId). Returns undefined for custom/unknown. */
export function findModelCatalogEntry(
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  return MODEL_CATALOG[provider]?.find((e) => e.modelId === modelId);
}

/**
 * Whether a model can call tools, as three distinct states — NOT a boolean,
 * because "not in the catalog" (a custom id, a local ollama/openai-compatible
 * model, or a live id the provider returns that we haven't curated yet) is
 * genuinely unknown, not a "no". Only 'no' should ever gate a model out of an
 * orchestrator picker; 'unknown' models stay selectable (see
 * apps/web's model pickers — the `requireTools` gate only disables 'no').
 */
export type ModelToolsSupport = 'yes' | 'no' | 'unknown';

/** Resolve a model's tools capability from the catalog (see `ModelToolsSupport`). */
export function modelToolsSupport(provider: string, modelId: string): ModelToolsSupport {
  const entry = findModelCatalogEntry(provider, modelId);
  if (!entry) return 'unknown';
  return entry.capabilities.tools ? 'yes' : 'no';
}

/**
 * Display label for a catalog entry in a model picker `<option>`. Native
 * `<option>` elements render plain text only (no colored badge is possible
 * inside one), so a model that can't call tools gets a plain-text suffix
 * instead — kept quiet for the common case (tools:true, no suffix) and only
 * flagging the exceptional one.
 */
export function modelOptionLabel(entry: ModelCatalogEntry): string {
  return entry.capabilities.tools ? entry.label : `${entry.label} (no tools)`;
}

/**
 * Last-resort context window (tokens) for a model with NO catalogued value AND
 * no configured/probed value (É-3). It is deliberately large, NOT small: the
 * compaction trigger is window-relative (0.7 × window), so a too-SMALL default
 * would over-compact a big custom model and collapse its prompt cache (the
 * DeepSeek-1M regression the runner's compaction comment warns about). A
 * too-LARGE default instead risks a local 8-16K model overflowing before
 * compaction fires — which is exactly why É-3 threads a per-model override
 * (auto-detected or user-set) through `storedWindow` below, so this default is
 * only ever hit when nothing better is known.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * The model's context window in tokens, by priority:
 *   1. the catalogued value (authoritative for known cloud models);
 *   2. `storedWindow` — a per-model value auto-detected from a local endpoint or
 *      set by the user (entity_llm_keys.context_window), for custom/unknown
 *      models the catalog can't know (É-3);
 *   3. DEFAULT_CONTEXT_WINDOW.
 * The runner uses this to decide when to compact before the window overflows.
 */
export function modelContextWindow(
  provider: string,
  modelId: string,
  storedWindow?: number | null,
): number {
  const catalogued = findModelCatalogEntry(provider, modelId)?.contextWindow;
  if (catalogued !== undefined) return catalogued;
  if (typeof storedWindow === 'number' && Number.isFinite(storedWindow) && storedWindow > 0) {
    return storedWindow;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Estimate a single call's real dollar cost from its token counts × the
 * catalog's list price. Fix #21 (2026-07 audit, "cap coût $ inopérant hors
 * OpenRouter"): OpenRouter self-reports real cost in
 * `providerMetadata.openrouter.usage.cost`, but every native/BYOK provider
 * (DeepSeek/MiniMax/Anthropic-direct/OpenAI/Google/Groq/Mistral/Ollama) never
 * populates that path — without this fallback, Guard 1e (the $ cost cap in
 * apps/runner/src/job/execute.ts) never sees a non-zero cost for those calls
 * and can never fire. Returns 0 — not an error — for any model without a
 * catalogued `pricing` entry; that's tracked debt (see the `pricing` field
 * doc), not a silent fallback: Guard 1a's token budget remains the backstop
 * for unpriced models, same as before this function existed.
 */
export function estimateModelCostUsd(
  provider: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = findModelCatalogEntry(provider, modelId)?.pricing;
  if (!pricing) return 0;
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return (
    (inTok / 1_000_000) * pricing.inputPerMillionUsd +
    (outTok / 1_000_000) * pricing.outputPerMillionUsd
  );
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
  moonshotai: 'Moonshot',
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
