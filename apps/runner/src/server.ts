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
import { telegramRoute } from './routes/telegram.ts';
import { AuthError } from '@nodalai/auth';

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
  // /api/telegram handles its own webhook secret
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

  app.post('/api/approve', (c) => approveRoute(c, deps, runnerEnv));

  app.post('/api/cron', (c) => cronRoute(c));

  app.post('/api/telegram', (c) => telegramRoute(c, deps, runnerEnv));

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
  const app = createApp(deps, runnerEnv);

  const port = runnerEnv.PORT;
  const hostname = runnerEnv.BIND;

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
  process.on('SIGTERM', async () => {
    await deps.close();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    await deps.close();
    process.exit(0);
  });
}

// Only run when this is the entry point (not when imported by tests).
// pathToFileURL(process.argv[1]) converts the script path to a file:// URL
// so we can compare it against import.meta.url of this module.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}

export { createRunnerDeps, parseEnv };
