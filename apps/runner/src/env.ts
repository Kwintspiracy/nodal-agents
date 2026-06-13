// env.ts — Zod-validated environment for the runner
// All required and optional env vars are declared here.
// Import `env` from this file to get a fully-typed, validated env object.

import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // LLM Provider — all optional since Brique 25.
  // The seeder uses these on first boot to populate entity_llm_keys; the runner
  // loop reads LLM config from DB at runtime (via agent.llmKeyId). Installs that
  // have removed the `llm` section from config.json omit these env vars entirely.
  LLM_PROVIDER: z
    .enum([
      'anthropic',
      'openai',
      'ollama',
      'openai-compatible',
      'google',
      'mistral',
      'groq',
      'openrouter',
    ])
    .optional(),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),

  // Embeddings (optional — falls back to keyword search)
  EMBEDDING_PROVIDER: z.enum(['ollama', 'openai', 'keyword']).default('keyword'),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().optional(),

  // Delivery
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Auth
  AUTH_MODE: z.enum(['local-trust', 'local-auth', 'bearer-token']).default('local-trust'),
  WORKER_SECRET: z.string().default(''),

  // Bearer token mode (required when AUTH_MODE=bearer-token)
  BEARER_TOKEN: z.string().optional(),

  // Server
  PORT: z.coerce.number().default(3001),
  BIND: z.string().default('127.0.0.1'),
  APP_URL: z.string().default('http://localhost:3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Learning-loop — Tier-1 "reflection" pass (Phase B). After a substantial
  // completed job, a cheap LLM call reads the transcript and may create/patch
  // the agent's own skills. Ships OFF by default: set REFLECTION_ENABLED='true'
  // to opt in. The other knobs gate WHICH jobs qualify and bound the pass.
  REFLECTION_ENABLED: z.string().default('false'),
  // Minimum job turns before a completed job is "substantial" enough to reflect on.
  REFLECTION_MIN_TURNS: z.coerce.number().default(3),
  // Per-entity rolling-hour cap on reflection passes (rate limit / cost guard).
  REFLECTION_MAX_PER_HOUR: z.coerce.number().default(6),
  // Max LLM turns inside a single reflection pass (the reflection loop itself).
  REFLECTION_MAX_TURNS: z.coerce.number().default(3),
});

export type RunnerEnv = z.infer<typeof envSchema>;

let _env: RunnerEnv | undefined;

/**
 * Parse and validate the environment.
 * Throws a descriptive error on first call if any required var is missing.
 * Results are cached after first parse.
 */
export function parseEnv(raw: Record<string, string | undefined> = process.env): RunnerEnv {
  if (_env) return _env;
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Runner env validation failed:\n${issues}`);
  }
  _env = result.data;
  return _env;
}

/** Reset cached env — only for tests. */
export function _resetEnvCache(): void {
  _env = undefined;
}

export const env = new Proxy({} as RunnerEnv, {
  get(_target, prop) {
    return parseEnv()[prop as keyof RunnerEnv];
  },
});
