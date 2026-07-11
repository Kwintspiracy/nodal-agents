// server.ts — Hono app entry point
// Wires all routes, middleware, and starts the HTTP server.

import { Hono } from 'hono';
import type { Context } from 'hono';
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
import { webhookRoute } from './routes/webhook.ts';
import { installSkillRoute, uninstallSkillRoute } from './routes/skills.ts';
import {
  whatsappPairingStatusRoute,
  whatsappPairingStartRoute,
} from './routes/whatsapp-pairing.ts';
import { startCronTicker } from './cron/ticker.ts';
import { startTelegramManager } from './telegram/manager.ts';
import { startDiscordManager } from './channels/discord/manager.ts';
import { startSlackManager } from './channels/slack/manager.ts';
import { startWhatsAppManager } from './channels/whatsapp/manager.ts';
import type { WhatsAppManagerHandle } from './channels/whatsapp/manager.ts';
import { seedDefaultLlmKey } from './bootstrap/seed-llm-key.ts';
import { migrateLlmKeysToEncrypted } from './bootstrap/migrate-llm-keys.ts';
import { backfillMemoryEmbeddings } from './bootstrap/backfill-embeddings.ts';
import { seedDefaultSkills } from './bootstrap/seed-default-skills.ts';
import { AuthError } from '@nodal-agents/auth';
import { isValidWorkerSecret } from './lib/worker-secret.ts';
import './lib/runner-auth-context.ts';
import type { RunnerDeps } from './deps.ts';

// ─── startBackfillBackground ──────────────────────────────────────────────────

/**
 * Fire the memory-embedding backfill as a background task — never awaited
 * from main(). Finding M-17: a slow/unbounded backfill (EMBEDDING_PROVIDER=
 * openai + a large agent_memory table) must never delay /api/health becoming
 * reachable. Exported so tests can assert the non-blocking contract directly
 * (the function itself returns void, not a Promise the caller could await).
 */
export function startBackfillBackground(deps: Pick<RunnerDeps, 'db' | 'embeddingClient'>): void {
  void backfillMemoryEmbeddings(deps.db, deps.embeddingClient).catch((err) => {
    console.warn('[runner] memory embedding backfill failed (will retry next boot):', err);
  });
}

// ─── createApp ────────────────────────────────────────────────────────────────

/**
 * Create and configure the Hono app.
 * Accepts deps injection for testability.
 */
export function createApp(
  deps: Awaited<ReturnType<typeof createRunnerDeps>>,
  runnerEnv: ReturnType<typeof parseEnv>,
  whatsappManager: WhatsAppManagerHandle | null = null,
): Hono {
  const app = new Hono();

  // ── requireRunnerAuth ────────────────────────────────────────────────────────
  //
  // Unified auth gate for /api/agent, /api/chat, /api/approve, /api/cron.
  //
  // local-trust: pass through unconditionally (intentional single-user no-auth
  //   mode for trusted local/dev use). NOTE: this mode does NOT change the
  //   network bind — main() always binds to runnerEnv.BIND (0.0.0.0 in LAN
  //   mode) in every mode. What closes the LAN exposure is the WORKER_SECRET
  //   requirement enforced below for local-auth / bearer-token, not any
  //   loopback binding.
  //
  // local-auth / bearer-token: require "Authorization: Bearer <WORKER_SECRET>".
  //   The web already sends this on every runner call it makes (worker, approve,
  //   chat, skills). The runner cannot validate better-auth session cookies
  //   cross-process (separate port, separate session store), so WORKER_SECRET
  //   is the runner's auth boundary; external /api/agent and /api/cron callers
  //   must present it too.
  //
  // bearer-token mode additionally accepts a valid authProvider session so that
  //   external API clients using BEARER_TOKEN keep working.
  //
  // Authorization vs authentication: the branches above only prove WHO is
  // calling. They also stamp `callerTrusted` / `callerEntityId` on the
  // context (packages/auth's AuthSession → Hono ContextVariableMap, see
  // lib/runner-auth-context.ts) so the routes below can enforce WHICH
  // entity's data the caller is allowed to touch — a trusted caller
  // (local-trust / WORKER_SECRET) has already had its entity scoped by the
  // web from the user's session, so its request body is trusted as-is; an
  // untrusted session bearer-token caller must be checked against its own
  // session.entityId (findings #4/#5).
  //
  // /api/health and /api/worker stay public/self-authed respectively.
  const requireRunnerAuth = async (
    c: Context,
    next: () => Promise<void>,
  ): Promise<Response | void> => {
    // local-trust: no auth required (intentional single-user no-auth for trusted local/dev use)
    if (runnerEnv.AUTH_MODE === 'local-trust') {
      c.set('callerTrusted', true);
      await next();
      return;
    }

    // All other modes: check WORKER_SECRET bearer first
    const auth = c.req.header('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (bearer && runnerEnv.WORKER_SECRET && isValidWorkerSecret(bearer, runnerEnv.WORKER_SECRET)) {
      c.set('callerTrusted', true);
      await next();
      return;
    }

    // bearer-token mode: also accept a valid authProvider session (external API clients)
    if (runnerEnv.AUTH_MODE === 'bearer-token') {
      try {
        const session = await deps.authProvider.getSession(c.req.raw);
        // Fail-closed defense in depth: an untrusted caller with no entity on
        // its session is authorized for NOTHING. Every route below trusts
        // that an untrusted caller's callerEntityId is always a real,
        // non-empty id (chat.ts/agent.ts/approve.ts key their scoping off
        // that assumption) — never let a session with a falsy entityId
        // (a future provider bug, e.g. an `?? ''` fallback) through as
        // "authenticated" and silently reopen the cross-entity IDOR.
        if (session && session.entityId) {
          c.set('callerTrusted', false);
          c.set('callerEntityId', session.entityId);
          await next();
          return;
        }
      } catch (err) {
        if (!(err instanceof AuthError)) {
          throw err;
        }
      }
    }

    return c.json({ error: 'AUTH_REQUIRED' }, 401);
  };

  app.use('/api/agent', requireRunnerAuth);
  app.use('/api/chat', requireRunnerAuth);
  app.use('/api/approve', requireRunnerAuth);
  app.use('/api/cron', requireRunnerAuth);
  app.use('/api/whatsapp/pairing', requireRunnerAuth);

  // ── Routes ────────────────────────────────────────────────────────────────────

  app.get('/api/health', (c) => healthRoute(c, deps));

  app.post('/api/agent', (c) => agentRoute(c, deps, runnerEnv));

  app.post('/api/worker', (c) => workerRoute(c, deps, runnerEnv));

  app.post('/api/chat', (c) => chatRoute(c, deps, runnerEnv));

  app.post('/api/approve', (c) => approveRoute(c, deps, runnerEnv));

  app.post('/api/cron', (c) => cronRoute(c, deps));

  // Community skill install/uninstall (open Agent Skills format). Own
  // WORKER_SECRET check inside the handlers (web → runner cross-process call).
  app.post('/api/skills/install', (c) => installSkillRoute(c, deps, runnerEnv));
  app.post('/api/skills/uninstall', (c) => uninstallSkillRoute(c, deps, runnerEnv));

  // WhatsApp pairing status/start — reads/kicks the whatsapp manager's
  // in-memory qr/status map (null in tests/environments that never started
  // one; the routes answer 503 rather than crash).
  app.get('/api/whatsapp/pairing', (c) => whatsappPairingStatusRoute(c, deps, whatsappManager));
  app.post('/api/whatsapp/pairing', (c) => whatsappPairingStartRoute(c, deps, whatsappManager));

  // Inbound webhooks (Brique 5) — intentionally OUTSIDE requireRunnerAuth
  // (that gate is a literal-path app.use on the four /api/* routes above, so
  // it never matches here regardless). Auth is per-trigger: slug+secret in the
  // path, checked inside webhookRoute against the webhook_triggers row.
  app.post('/webhooks/:slug/:secret', (c) => webhookRoute(c, deps, runnerEnv));

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
  // the user. Kept blocking (unlike the backfill below): the catalog is a
  // small, fixed-size list bundled with the product (packages/catalog), not
  // something that scales with a user's data — a handful of local queries,
  // no external network call, sub-second in practice.
  await seedDefaultSkills(deps.db, runnerEnv);

  // Start the WhatsApp manager BEFORE createApp: the pairing route needs the
  // manager's handle threaded in at route-registration time (its GET/POST
  // closures capture it directly — there's no other shared-state channel
  // between a route and a long-lived runtime manager in this app). Disable
  // with WHATSAPP_BRIDGE_ENABLED=false (e.g. tests).
  const whatsappEnabled = process.env['WHATSAPP_BRIDGE_ENABLED'] !== 'false';
  const whatsappManager = whatsappEnabled ? startWhatsAppManager(deps, { env: runnerEnv }) : null;
  if (whatsappEnabled) {
    console.warn('[runner] whatsapp manager started');
  }

  const app = createApp(deps, runnerEnv, whatsappManager);

  const port = runnerEnv.PORT;
  const hostname = runnerEnv.BIND;

  // Start the in-process cron ticker (default: every 2 min).
  // Disable with CRON_TICKER_ENABLED=false if using an external managed cron.
  const cronTickerEnabled = process.env['CRON_TICKER_ENABLED'] !== 'false';
  // R1 watchdog ceiling — how long a single tick may run before the ticker
  // forces `running` back to false and lets the loop continue (see ticker.ts
  // for the full rationale). Read directly from process.env (not the Zod
  // RunnerEnv) — same lightweight pattern as CRON_TICKER_ENABLED above, a
  // rarely-touched operational knob, not core config.
  const cronTickMaxMsRaw = Number(process.env['CRON_TICK_MAX_MS']);
  const cronTickMaxMs =
    Number.isFinite(cronTickMaxMsRaw) && cronTickMaxMsRaw > 0 ? cronTickMaxMsRaw : 15 * 60_000;
  // Pass runnerEnv to the ticker so it can re-attempt seedDefaultLlmKey on
  // each tick — covers the local-auth case where the first user signs up
  // AFTER the runner boot-time seed has already run and skipped on 0 entities.
  const ticker = cronTickerEnabled
    ? startCronTicker(deps, { runnerEnv, maxTickMs: cronTickMaxMs })
    : null;
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

  // Start the Discord gateway manager — one live gateway Client per
  // channel_bindings row (channel='discord', enabled=true). Refreshes every
  // 30s. Disable with DISCORD_GATEWAY_ENABLED=false (e.g. tests).
  const discordEnabled = process.env['DISCORD_GATEWAY_ENABLED'] !== 'false';
  const discordManager = discordEnabled ? startDiscordManager(deps, { env: runnerEnv }) : null;
  if (discordEnabled) {
    console.warn('[runner] discord manager started');
  }

  // Start the Slack Socket Mode manager — one live @slack/bolt App per
  // channel_bindings row (channel='slack', enabled=true). Refreshes every
  // 30s. Disable with SLACK_SOCKET_ENABLED=false (e.g. tests).
  const slackEnabled = process.env['SLACK_SOCKET_ENABLED'] !== 'false';
  const slackManager = slackEnabled ? startSlackManager(deps, { env: runnerEnv }) : null;
  if (slackEnabled) {
    console.warn('[runner] slack manager started');
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

  // One-shot: generate embeddings for memory rows written before Sprint 1's
  // inline embedding generation existed (idempotent — zero-row pass once
  // caught up). Search still finds un-backfilled rows via the keyword
  // fallback, so this is safe to run in the background. Finding M-17: this
  // used to run SEQUENTIALLY, unbounded, BEFORE serve() — with
  // EMBEDDING_PROVIDER=openai and a large table, that stalled the whole boot
  // (the health endpoint wasn't reachable yet) for however long the backlog
  // took. Firing it here, after serve(), means /api/health is already up by
  // the time this starts; a slow or failing backfill degrades to "search
  // still works via keyword" instead of "runner never comes up".
  startBackfillBackground(deps);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    ticker?.stop();
    await telegramManager?.stop();
    await discordManager?.stop();
    await slackManager?.stop();
    await whatsappManager?.stop();
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
  main().catch((err) => {
    console.error('[runner] boot failed:', err);
    process.exit(1);
  });
}

export { createRunnerDeps, parseEnv };
