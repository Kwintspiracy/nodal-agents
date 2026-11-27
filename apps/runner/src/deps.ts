// deps.ts — createRunnerDeps: wires DB, LLM, embeddings, tool registry, auth
// This is the composition root for the runner. All packages assembled here.

import { createClient } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { createEmbeddingClient } from '@nodal-agents/llm';
import type { NodalLlmClient, EmbeddingClient, EmbeddingProviderConfig } from '@nodal-agents/llm';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import type { ToolRegistry } from '@nodal-agents/tools';
import { LocalTrustProvider, BearerTokenProvider, seedLocalUser } from '@nodal-agents/auth';
import type { AuthProvider } from '@nodal-agents/auth';
import type { RunnerEnv } from './env.ts';
import { embeddingsAddressedByHandle } from './llm/addressed-by-handle.ts';

// ─── Runner instance identity ─────────────────────────────────────────────────
//
// Minted once at boot in the LEAF module runner-identity.ts (the outbox must
// not import this composition root for a single UUID — the terminal paths that
// call it live under this graph, and the cycle would be one import away).
// Re-exported here so the identity stays readable from the composition root.
export { runnerInstanceId } from './runner-identity.ts';

// ─── RunnerDeps ───────────────────────────────────────────────────────────────

export interface RunnerDeps {
  db: AnyDrizzleDb;
  /**
   * Kept for backward compatibility with tests. Production reads none: every
   * job, chat turn and platform call resolves its LLM client from the agent's
   * entity_llm_keys row (Brique 25), and `createRunnerDeps` puts a client here
   * that refuses every use. Tests that don't need LLM calls can pass
   * `{} as RunnerDeps['llmClient']`.
   */
  llmClient: NodalLlmClient;
  embeddingClient: EmbeddingClient;
  registry: ToolRegistry;
  authProvider: AuthProvider;
  close: () => Promise<void>;
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

/**
 * THE runner's embedding client — its single source. Every text it sends to
 * the embedding provider (a memory's fact at its write and at the startup
 * backfill, a recall's query) names conversations by their handle, never by
 * the channel's id (#824, `embeddingsAddressedByHandle`).
 */
export function createRunnerEmbeddingClient(
  config: EmbeddingProviderConfig,
  db: AnyDrizzleDb,
): EmbeddingClient {
  return embeddingsAddressedByHandle(createEmbeddingClient(config), db);
}

/**
 * The embedding settings of the runner. The credential is the embedding
 * provider's own (`EMBEDDING_API_KEY`), never the chat provider's
 * `LLM_API_KEY`: a key is only sent to the provider it was issued for. An
 * openai embedding without one is refused when the client is built.
 */
export function embeddingConfigFromEnv(
  runnerEnv: Pick<
    RunnerEnv,
    'EMBEDDING_PROVIDER' | 'EMBEDDING_BASE_URL' | 'EMBEDDING_API_KEY' | 'EMBEDDING_MODEL'
  >,
): EmbeddingProviderConfig {
  if (runnerEnv.EMBEDDING_PROVIDER === 'keyword') return { provider: 'keyword' };
  return {
    provider: runnerEnv.EMBEDDING_PROVIDER,
    baseURL: runnerEnv.EMBEDDING_BASE_URL,
    apiKey: runnerEnv.EMBEDDING_API_KEY,
    model: runnerEnv.EMBEDDING_MODEL,
  };
}

/**
 * The runner has no model client of its own: a call always goes through the
 * key of the agent it is made for. Any use of this one is a wiring error and
 * fails loud (invariant #4) instead of reaching a provider with a key nobody
 * chose for that call.
 */
function refusingProcessLlmClient(): NodalLlmClient {
  const refuse = (): never => {
    throw new Error(
      'RunnerDeps.llmClient is not a model client: resolve the agent client (resolveAgentLlmClient)',
    );
  };
  return {
    get config(): never {
      return refuse();
    },
    get capabilities(): never {
      return refuse();
    },
    generateText: refuse,
    streamText: refuse,
    generateObject: refuse,
  };
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
  // No process-wide model client: every job, chat turn and platform call
  // resolves its client from the agent's entity_llm_keys row
  // (resolveAgentLlmClient), so the key and its address are the stored ones.
  const llmClient = refusingProcessLlmClient();

  // ── Embeddings ───────────────────────────────────────────────────────────────
  const embeddingConfig = embeddingConfigFromEnv(runnerEnv);

  const embeddingClient = createRunnerEmbeddingClient(embeddingConfig, db as AnyDrizzleDb);

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
