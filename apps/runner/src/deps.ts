// deps.ts — createRunnerDeps: wires DB, LLM, embeddings, tool registry, auth
// This is the composition root for the runner. All packages assembled here.

import { createClient } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import type { NodalLlmClient, EmbeddingClient } from '@nodal-agents/llm';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import type { ToolRegistry } from '@nodal-agents/tools';
import { LocalTrustProvider, BearerTokenProvider, seedLocalUser } from '@nodal-agents/auth';
import type { AuthProvider } from '@nodal-agents/auth';
import type { RunnerEnv } from './env.ts';

// ─── RunnerDeps ───────────────────────────────────────────────────────────────

export interface RunnerDeps {
  db: AnyDrizzleDb;
  /**
   * Kept for backward compatibility with tests.
   * execute.ts no longer reads this field at runtime (Brique 25): every job
   * resolves its LLM client from the agent's entity_llm_keys row. Tests that
   * populate llmKeyId supply their own client via that row; tests that don't
   * need LLM calls can pass `{} as RunnerDeps['llmClient']`.
   */
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
  // LLM_PROVIDER / LLM_MODEL are optional since Brique 25 (runner reads from DB).
  // Build a real client only when the env vars are present (first-boot / legacy
  // config.json installs). When absent, use a no-op placeholder — execute.ts
  // never reads deps.llmClient at runtime; it resolves per-job from entity_llm_keys.
  const llmClient: NodalLlmClient =
    runnerEnv.LLM_PROVIDER && runnerEnv.LLM_MODEL
      ? createLlmClient({
          provider: runnerEnv.LLM_PROVIDER,
          model: runnerEnv.LLM_MODEL,
          apiKey: runnerEnv.LLM_API_KEY,
          baseURL: runnerEnv.LLM_BASE_URL,
        })
      : createLlmClient({ provider: 'anthropic', model: 'claude-sonnet-4-6-20260217' });

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
    // local-trust + local-auth both fall through to LocalTrustProvider on the
    // runner side — the web is what enforces the better-auth session in
    // local-auth mode, and the runner only checks a shared worker secret.
    authProvider = new LocalTrustProvider();
    // Only seed the LOCAL_USER/LOCAL_ENTITY pair in local-trust mode. In
    // local-auth the user creates their own entity at signup; pre-creating
    // the local pair would attach the env-derived LLM key to a phantom
    // entity the signed-up user never sees.
    if (runnerEnv.AUTH_MODE === 'local-trust') {
      await seedLocalUser(db as Parameters<typeof seedLocalUser>[0]);
    }
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
