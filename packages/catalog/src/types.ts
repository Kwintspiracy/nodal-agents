// bootstrap/catalog/types.ts — canonical types for the product catalog
//
// The catalog is the source of truth for everything that ships with
// NodalAI out of the box: system skills, system agents, default skill→agent
// assignments. At boot, the corresponding seeders upsert each catalog entry
// into the DB so every install of the same npm version has the same product.
//
// Runtime still reads from the DB — invariant #1 (no hardcoded agent
// metadata) is preserved. The catalog is data-as-code purely for the
// install-time bootstrap, exactly like `seedDefaultLlmKey` reads env to
// seed the first row.

/** Skill that ships with the product. */
export interface SystemSkill {
  /** Stable identifier used for tool naming + assignment lookups. */
  slug: string;
  /** Display name in the dashboard. */
  name: string;
  /** One-line description shown in the dashboard skill picker. */
  description: string;
  /** Markdown body injected into the system prompt of agents that own this skill. */
  content: string;
  /** Tool names this skill needs the agent to have access to (whitelist hint). */
  requiredBuiltins?: string[];
}

/**
 * Default model preference for a system agent.
 *
 * The seeder picks the first model whose required LLM provider matches a key
 * the install has. If none match, falls back to the seeded default LLM key
 * (whatever was set via `LLM_PROVIDER`/`LLM_MODEL` env) and surfaces a hint
 * via dashboard banner: "this system agent recommends X but your only key
 * is Y — add the key or change the model".
 */
export interface ModelPreference {
  /** Provider slug as it appears in `entity_llm_keys.provider`. */
  provider: 'anthropic' | 'openai' | 'openrouter' | 'google' | 'mistral' | 'groq';
  /** Concrete model id passed to the LLM client. */
  model: string;
}

/** Agent that ships with the product as a default orchestrator/worker. */
export interface SystemAgent {
  /** Stable identifier used in `assign_<slug>` tool names. */
  slug: string;
  /** Display name. */
  name: string;
  /** Role check column accepts `'agent' | 'orchestrator' | 'system'`. */
  role: 'agent' | 'orchestrator' | 'system';
  /**
   * For orchestrators only: `'router'` (delegates per-turn) or `'planner'`
   * (creates an agent_tasks plan). Workers leave this null.
   */
  orchestratorMode?: 'router' | 'planner';
  /** Markdown personality body. Shown in dashboard, editable per-install. */
  personality: string;
  /**
   * Ordered list of model preferences. The seeder picks the first that
   * matches an available LLM key; falls back to the install's default key
   * + its default model if none match.
   */
  preferredModels: ModelPreference[];
}

/** Skill→agent default assignment that ships with the product. */
export interface SystemAssignment {
  agentSlug: string;
  skillSlug: string;
}
