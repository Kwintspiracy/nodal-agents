// routes/devices.ts — the device routes (#945).
//
//   GET  /api/devices/:deviceId/events        the device's stream (SSE)
//   GET  /api/devices/:deviceId/cards         → { cards: card[] } what waits for a person
//   POST /api/devices/:deviceId/conversation  { fresh?: true } → { entityId, agentId, conversationId }
//
// A device then SAYS and SENDS through the routes the dashboard uses
// (`/api/voice/turns`, `/api/chat/stream`), in the conversation this route
// gives it, and answers a card through `POST /api/approve` — nothing is
// dashboard-only (DEVICE_GESTURES, @nodal-agents/shared). The conversation is
// what records the origin: every turn made in it, and every job such a turn
// launches, is recorded as made on this device (chat/turn-origin.ts), and the
// questions, approvals and the spoken announcement of those jobs come back on
// this stream.
//
// THE STREAM. The push stream of #944 (`streamJobEvents`, routes/events.ts),
// subscribed as this device: the same bus, the same resume ids
// (`Last-Event-ID`, or `?lastEventId=`), the same `ready` / `resync`, the same
// ping. What it carries is the protocol's Nodal → module gestures
// (DeviceEventSchema): bubble, card, card.closed, state, announce — what is
// addressed to this device, and what the jobs of its requests do
// (devices/device-events.ts). A device never hears another device's events,
// nor another workspace's.
//
// THE CONVERSATION. The device's current conversation with its workspace's
// ROOT agent — the agent the dashboard's chat talks to — on the thread
// (`device`, its id), resolved like a Telegram chat's (`resolveConversation`).
// `fresh: true` opens a new one, as `/new` does on a channel.
//
// THE CARDS. What the stream can lose, the base keeps: a pending request
// survives a restart, its event does not. After a `resync` (or at start) the
// device reads here every request of ITS jobs (their chat is this device)
// still waiting for a person, as the very `card` it was sent as — the same
// composition (`composeRequestCard`, approvals/notify.ts) and the same
// builder (`deviceEventFor`, devices/device-sink.ts). A server's form
// (elicitation) is not a device card: it waits on the dashboard, and is not
// listed.
//
// THE GUARD: `authorizeDevice` (devices/device-guard.ts), behind
// `requireRunnerAuth` (server.ts) — the guard `/api/events` uses. #946
// replaces it with device tokens, in that one place.

import type { Context } from 'hono';
import { z } from 'zod';
import {
  eq,
  entities,
  agents,
  and,
  agentJobs,
  approvalRequests,
  approvalsOldestFirst,
  inArray,
} from '@nodal-agents/db';
import { deviceAdapter } from '@nodal-agents/delivery';
import type { DeviceEvent, ShellGateReason } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { jobEvents, type JobEventBus } from '../events/job-events.ts';
import { authorizeDevice } from '../devices/device-guard.ts';
import { deviceEventsOf } from '../devices/device-events.ts';
import { deviceEventFor } from '../devices/device-sink.ts';
import { composeRequestCard } from '../approvals/notify.ts';
import { openNewConversation, resolveConversation } from '../job/conversation-id.ts';
import { streamJobEvents } from './events.ts';

const EventsQuerySchema = z.object({
  lastEventId: z.string().min(1).max(200).optional(),
});

export async function deviceEventsRoute(
  c: Context,
  deps: RunnerDeps,
  bus: JobEventBus = jobEvents,
): Promise<Response> {
  const parsed = EventsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const guard = await authorizeDevice(c, deps, c.req.param('deviceId') ?? '');
  if (!guard.ok) return guard.response;
  const { device } = guard;
  const lastEventId = c.req.header('last-event-id') ?? parsed.data.lastEventId ?? null;

  return streamJobEvents(
    c,
    bus,
    { entityId: device.entityId, conversationId: null, deviceId: device.id },
    lastEventId,
    (e) =>
      e.payload.type === 'resync'
        ? [{ event: 'resync', data: e.payload }]
        : deviceEventsOf(e).map((event) => ({ event: event.type, data: event })),
  );
}

export async function deviceCardsRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const guard = await authorizeDevice(c, deps, c.req.param('deviceId') ?? '');
  if (!guard.ok) return guard.response;
  const { device } = guard;

  // The requests of THIS device's jobs, in its workspace, still pending.
  const rows = await deps.db
    .select({
      id: approvalRequests.id,
      kind: approvalRequests.kind,
      toolName: approvalRequests.toolName,
      toolInput: approvalRequests.toolInput,
      gateReasons: approvalRequests.gateReasons,
      agentId: approvalRequests.agentId,
    })
    .from(approvalRequests)
    .innerJoin(agentJobs, eq(agentJobs.id, approvalRequests.jobId))
    .where(
      and(
        eq(approvalRequests.entityId, device.entityId),
        eq(agentJobs.entityId, device.entityId),
        eq(agentJobs.chatChannel, 'device'),
        eq(agentJobs.chatId, device.id),
        eq(approvalRequests.status, 'pending'),
        inArray(approvalRequests.kind, ['approval', 'question']),
      ),
    )
    .orderBy(approvalsOldestFirst);

  const cards: Extract<DeviceEvent, { type: 'card' }>[] = [];
  for (const row of rows) {
    if (!row.agentId) continue;
    const composed = await composeRequestCard(
      deps.db,
      {
        approvalRequestId: row.id,
        toolName: row.toolName,
        toolInput: row.toolInput,
        agentId: row.agentId,
        entityId: device.entityId,
        kind: row.kind === 'question' ? 'question' : 'approval',
        gateReasons: (row.gateReasons as readonly ShellGateReason[] | null) ?? [],
      },
      deviceAdapter,
    );
    const { event } = deviceEventFor(composed);
    // A device draws every card (`capabilities.buttons`): anything else is a
    // composition the device could not have been sent, said loud.
    if (event.type !== 'card') {
      throw new Error(`device_card_not_a_card: request ${row.id} composed as ${event.type}`);
    }
    cards.push(event);
  }
  return c.json({ cards });
}

const ConversationBodySchema = z
  .object({
    /** Open a new conversation instead of continuing the current one. */
    fresh: z.boolean().optional(),
  })
  .strict();

export async function deviceConversationRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const raw = await c.req.text();
  const parsed = ConversationBodySchema.safeParse(raw.trim() === '' ? {} : safeJson(raw));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const guard = await authorizeDevice(c, deps, c.req.param('deviceId') ?? '');
  if (!guard.ok) return guard.response;
  const { device } = guard;

  // The workspace's ROOT agent, as the dashboard's chat resolves it — and an
  // active agent of THIS workspace: a root that left it answers nobody.
  const [root] = await deps.db
    .select({ agentId: agents.id })
    .from(entities)
    .innerJoin(agents, and(eq(agents.id, entities.rootAgentId), eq(agents.entityId, entities.id)))
    .where(and(eq(entities.id, device.entityId), eq(agents.active, true)))
    .limit(1);
  if (!root) return c.json({ error: 'no_root_agent' }, 409);

  // The advisory lock of the thread holds until COMMIT: two first requests
  // of a device never open two conversations (job/conversation-id.ts).
  const conversation = await deps.db.transaction(async (tx) => {
    const key = {
      db: tx as unknown as RunnerDeps['db'],
      entityId: device.entityId,
      agentId: root.agentId,
      channel: 'device',
      chatId: device.id,
    };
    return parsed.data.fresh ? openNewConversation(key) : resolveConversation(key);
  });

  return c.json({
    entityId: device.entityId,
    agentId: root.agentId,
    conversationId: conversation.id,
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
