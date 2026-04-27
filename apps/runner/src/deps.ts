// deps.ts — createRunnerDeps: wires DB, LLM, embeddings, tool registry, auth
// This is the composition root for the runner. All packages assembled here.

import { createClient } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import { createLlmClient, createEmbeddingClient } from '@nodalai/llm';
import type { NodalLlmClient, EmbeddingClient } from '@nodalai/llm';
import { createToolRegistry, registerBuiltins } from '@nodalai/tools';
import type { ToolRegistry } from '@nodalai/tools';
import { LocalTrustProvider, BearerTokenProvider, seedLocalUser } from '@nodalai/auth';
import type { AuthProvider } from '@nodalai/auth';
import type { RunnerEnv } from './env.ts';

// ─── RunnerDeps ───────────────────────────────────────────────────────────────

export interface RunnerDeps {
  db: AnyDrizzleDb;
  llmClient: NodalLlmClient;
  embeddingClient: EmbeddingClient;
  registry: ToolRegistry;
  authProvider: AuthProvider;
  close: () => Promise<void>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create all runtime dependencies for the runner from validated env.
 * Call once at startup; pass deps to all routes.
 *
 * Performs DB setup (seed local user when AUTH_MODE=local-trust).
 */
export async function createRunnerDeps(runnerEnv: RunnerEnv): Promise<RunnerDeps> {
  // ── DB ───────────────────────────────────────────────────────────────────────
  const { db, close: closeDb } = createClient(runnerEnv.DATABASE_URL);

  // ── LLM ─────────────────────────────────────────────────────────────────────
  const llmClient = createLlmClient({
    provider: runnerEnv.LLM_PROVIDER,
    model: runnerEnv.LLM_MODEL,
    apiKey: runnerEnv.LLM_API_KEY,
    baseURL: runnerEnv.LLM_BASE_URL,
  });

  // ── Embeddings ───────────────────────────────────────────────────────────────
  // keyword fallback: use EmbeddingProviderConfig with provider='keyword'
  const embeddingConfig =
    runnerEnv.EMBEDDING_PROVIDER === 'keyword'
      ? { provider: 'keyword' as const }
      : {
          provider: runnerEnv.EMBEDDING_PROVIDER as 'ollama' | 'openai',
          baseURL: runnerEnv.EMBEDDING_BASE_URL,
          apiKey: runnerEnv.LLM_API_KEY,
          model: runnerEnv.EMBEDDING_MODEL,
        };

  const embeddingClient = createEmbeddingClient(embeddingConfig);

  // ── Tool registry ────────────────────────────────────────────────────────────
  const registry = createToolRegistry();
  // registerBuiltins takes only the registry — no db needed
  registerBuiltins(registry);

  // ── Auth provider ────────────────────────────────────────────────────────────
  let authProvider: AuthProvider;

  if (runnerEnv.AUTH_MODE === 'bearer-token') {
    if (!runnerEnv.BEARER_TOKEN) {
      throw new Error('BEARER_TOKEN is required when AUTH_MODE=bearer-token');
    }
    authProvider = new BearerTokenProvider({ token: runnerEnv.BEARER_TOKEN });
  } else {
    // local-trust (default) — single user/entity, no auth required
    authProvider = new LocalTrustProvider();
    // Idempotently seed the default local user/entity
    await seedLocalUser(db as Parameters<typeof seedLocalUser>[0]);
  }

  return {
    db: db as AnyDrizzleDb,
    llmClient,
    embeddingClient,
    registry,
    authProvider,
    close: async () => {
      await closeDb();
    },
  };
}
