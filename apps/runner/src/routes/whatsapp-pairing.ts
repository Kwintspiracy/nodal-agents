// routes/whatsapp-pairing.ts — GET/POST /api/whatsapp/pairing — expose the
// in-memory QR/status pairing state the whatsapp manager tracks per agent,
// and let the dashboard kick off pairing for a binding without waiting for
// the manager's next 30s poll tick.
//
// GET  ?agentId=<uuid>  → { status, qr } — qr is present only while status is
//      'qr_pending'; masked to null otherwise even if the manager still holds
//      a stale value internally (defense in depth — QR payloads are a
//      one-time linking secret and must never leak past their live window).
//      404 when the agent has no whatsapp binding currently tracked.
// POST { agentId }      → ensures the socket exists (idempotent) so a QR
//      starts being generated; the web polls GET afterward.
//
// Auth: same requireRunnerAuth gate as /api/agent et al. (wired in
// server.ts). An untrusted session bearer-token caller may only pair an
// agent within its OWN entity — mirrors agent.ts's entity-scoping.

import type { Context } from 'hono';
import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { agents } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import type { WhatsAppManagerHandle } from '../channels/whatsapp/manager.ts';

/** Verify `agentId` exists and — for an untrusted caller — belongs to its own
 *  entity. Returns the agent's id, or null (caller should respond 404 either
 *  way: same code for "doesn't exist" and "exists but belongs to another
 *  entity", so an untrusted caller can't learn which agentIds exist outside
 *  its scope). */
async function loadScopedAgentId(
  c: Context,
  deps: RunnerDeps,
  agentId: string,
): Promise<string | null> {
  const [row] = await deps.db
    .select({ id: agents.id, entityId: agents.entityId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!row) return null;
  if (!c.get('callerTrusted')) {
    const callerEntityId = c.get('callerEntityId');
    if (!callerEntityId || row.entityId !== callerEntityId) return null;
  }
  return row.id;
}

// ─── GET /api/whatsapp/pairing ───────────────────────────────────────────────

const StatusQuerySchema = z.object({ agentId: z.string().guid() });

export async function whatsappPairingStatusRoute(
  c: Context,
  deps: RunnerDeps,
  manager: WhatsAppManagerHandle | null,
): Promise<Response> {
  if (!manager) return c.json({ error: 'whatsapp_manager_unavailable' }, 503);

  const parsed = StatusQuerySchema.safeParse({ agentId: c.req.query('agentId') });
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const agentId = await loadScopedAgentId(c, deps, parsed.data.agentId);
  if (!agentId) return c.json({ error: 'agent_not_found' }, 404);

  const state = manager.getPairingState(agentId);
  if (!state) return c.json({ error: 'no_whatsapp_binding' }, 404);

  return c.json({ status: state.status, qr: state.status === 'qr_pending' ? state.qr : null }, 200);
}

// ─── POST /api/whatsapp/pairing ──────────────────────────────────────────────

const StartPairingSchema = z.object({ agentId: z.string().guid() });

export async function whatsappPairingStartRoute(
  c: Context,
  deps: RunnerDeps,
  manager: WhatsAppManagerHandle | null,
): Promise<Response> {
  if (!manager) return c.json({ error: 'whatsapp_manager_unavailable' }, 503);

  const body = await c.req.json().catch(() => null);
  const parsed = StartPairingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const agentId = await loadScopedAgentId(c, deps, parsed.data.agentId);
  if (!agentId) return c.json({ error: 'agent_not_found' }, 404);

  const result = await manager.ensurePairingStarted(agentId);
  if (result === 'no_binding') {
    return c.json({ error: 'no_whatsapp_binding' }, 404);
  }
  return c.json({ ok: true }, 202);
}
