// server.ts — Hono app entry point
// Wires all routes, middleware, and starts the HTTP server.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'url';
import { parseEnv } from './env.ts';
import { createRunnerDeps } from './deps.ts';
import { healthRoute } from './routes/health.ts';
import { agentRoute } from './routes/agent.ts';
import { workerRoute } from './routes/worker.ts';
import { approveRoute } from './routes/approve.ts';
import { cronRoute } from './routes/cron.ts';
import { chatRoute } from './routes/chat.ts';
import { startCronTicker } from './cron/ticker.ts';
import { startTelegramManager } from './telegram/manager.ts';
import { seedDefaultLlmKey } from './bootstrap/seed-llm-key.ts';
import { migrateLlmKeysToEncrypted } from './bootstrap/migrate-llm-keys.ts';
import { backfillMemoryEmbeddings } from './bootstrap/backfill-embeddings.ts';
import { seedDefaultSkills } from './bootstrap/seed-default-skills.ts';
import { AuthError } from '@nodal-agents/auth';

// ─── createApp ────────────────────────────────────────────────────────────────

/**
 * Create and configure the Hono app.
 * Accepts deps injection for testability.
 */
export function createApp(
  deps: Awaited<ReturnType<typeof createRunnerDeps>>,
  runnerEnv: ReturnType<typeof parseEnv>,
): Hono {
  const app = new Hono();

  // ── Auth middleware (applied to all routes except /api/worker and /api/health) ──
  // /api/worker uses its own WORKER_SECRET check
  // /api/health is always public (liveness probe)
  app.use('/api/agent', async (c, next) => {
    try {
      const session = await deps.authProvider.getSession(c.req.raw);
      if (!session && runnerEnv.AUTH_MODE !== 'local-trust') {
        return c.json({ error: 'AUTH_REQUIRED' }, 401);
      }
      await next();
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: 'AUTH_REQUIRED' }, 401);
      }
      throw err;
    }
  });

  app.use('/api/approve', async (c, next) => {
    // Accept either:
    //   - a valid auth-provider session (for browser → runner direct calls), OR
    //   - the WORKER_SECRET bearer token (for web → runner cross-process
    //     calls; the web app and runner run in separate processes/ports so
    //     session cookies aren't shared).
    const auth = c.req.header('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (bearer && runnerEnv.WORKER_SECRET && bearer === runnerEnv.WORKER_SECRET) {
      await next();
      return;
    }
    try {
      const session = await deps.authProvider.getSession(c.req.raw);
      if (!session && runnerEnv.AUTH_MODE !== 'local-trust') {
        return c.json({ error: 'AUTH_REQUIRED' }, 401);
      }
      await next();
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: 'AUTH_REQUIRED' }, 401);
      }
      throw err;
    }
  });

  // ── Routes ────────────────────────────────────────────────────────────────────

  app.get('/api/health', (c) => healthRoute(c, deps));

  app.post('/api/agent', (c) => agentRoute(c, deps, runnerEnv));

  app.post('/api/worker', (c) => workerRoute(c, deps, runnerEnv));

  app.post('/api/chat', (c) => chatRoute(c, deps, runnerEnv));

  app.post('/api/approve', (c) => approveRoute(c, deps, runnerEnv));

  app.post('/api/cron', (c) => cronRoute(c, deps));

  // ── 404 fallback ──────────────────────────────────────────────────────────────
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // ── Error handler ─────────────────────────────────────────────────────────────
  app.onError((err, c) => {
    // Invariant 2: no user-facing strings in error responses
    const code = err instanceof Error ? err.constructor.name.toLowerCase() : 'internal_error';
    return c.json({ error: code }, 500);
  });

  return app;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const runnerEnv = parseEnv();
  const deps = await createRunnerDeps(runnerEnv);

  // One-shot: encrypt any plaintext entity_llm_keys.api_key rows in place
  // (Brique 26). Idempotent — already-encrypted rows are skipped. Must run
  // BEFORE seedDefaultLlmKey so the seed inserts already-encrypted ciphertext.
  await migrateLlmKeysToEncrypted(deps.db);

  // One-shot: if the local entity has no entity_llm_keys rows yet, seed one
  // from env so existing agents keep working post-Brique-24 (idempotent).
  await seedDefaultLlmKey(deps.db, runnerEnv);

  // Catalog seeding — every install gets the same system skills. Idempotent,
  // respects user overrides. Agents are NOT seeded: every agent is created by
  // the user.
  await seedDefaultSkills(deps.db, runnerEnv);

  // One-shot: generate embeddings for memory rows written before Sprint 1's
  // inline embedding generation existed (idempotent — zero-row pass once caught
  // up). Search still finds un-backfilled rows via the keyword fallback.
  await backfillMemoryEmbeddings(deps.db, deps.embeddingClient);

  const app = createApp(deps, runnerEnv);

  const port = runnerEnv.PORT;
  const hostname = runnerEnv.BIND;

  // Start the in-process cron ticker (default: every 2 min).
  // Disable with CRON_TICKER_ENABLED=false if using an external managed cron.
  const cronTickerEnabled = process.env['CRON_TICKER_ENABLED'] !== 'false';
  // Pass runnerEnv to the ticker so it can re-attempt seedDefaultLlmKey on
  // each tick — covers the local-auth case where the first user signs up
  // AFTER the runner boot-time seed has already run and skipped on 0 entities.
  const ticker = cronTickerEnabled ? startCronTicker(deps, { runnerEnv }) : null;
  if (cronTickerEnabled) {
    console.warn('[runner] cron ticker started (120s interval)');
  }

  // Start the Telegram poller manager — long-polls Telegram for each agent
  // that has a bot token configured. Refreshes the bot list every 30s.
  // Disable with TELEGRAM_POLLER_ENABLED=false (e.g. tests).
  const telegramEnabled = process.env['TELEGRAM_POLLER_ENABLED'] !== 'false';
  const telegramManager = telegramEnabled ? startTelegramManager(deps, { env: runnerEnv }) : null;
  if (telegramEnabled) {
    console.warn('[runner] telegram manager started');
  }

  serve(
    {
      fetch: app.fetch,
      port,
      hostname,
    },
    (info) => {
      console.warn(`[runner] listening on http://${hostname}:${info.port}`);
    },
  );

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    ticker?.stop();
    await telegramManager?.stop();
    await deps.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

// Only run when this is the entry point (not when imported by tests).
// pathToFileURL(process.argv[1]) converts the script path to a file:// URL
// so we can compare it against import.meta.url of this module.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}

export { createRunnerDeps, parseEnv };
