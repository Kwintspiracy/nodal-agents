// routes/devices.ts — the device routes (#945).
//
//   GET  /api/devices/:deviceId/events        the device's stream (SSE)
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
// ROOT agent (devices/device-conversation.ts, the path a confirmed pairing
// takes too). `fresh: true` opens a new one, as `/new` does on a channel.
//
// THE GUARD: the device's own key (#946). The device gate (devices/device-auth.ts)
// accepts nothing else on these routes — never the worker secret — and
// `authorizeDevice` (devices/device-guard.ts) checks the route names the
// key's own device.

import type { Context } from 'hono';
import { z } from 'zod';
import type { RunnerDeps } from '../deps.ts';
import { jobEvents, type JobEventBus } from '../events/job-events.ts';
import { authorizeDevice } from '../devices/device-guard.ts';
import { deviceEventsOf } from '../devices/device-events.ts';
import { deviceConversation } from '../devices/device-conversation.ts';
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

  const outcome = await deps.db.transaction((tx) =>
    deviceConversation(tx as unknown as RunnerDeps['db'], {
      entityId: device.entityId,
      deviceId: device.id,
      fresh: parsed.data.fresh === true,
    }),
  );
  if (!outcome.ok) return c.json({ error: outcome.code }, 409);

  return c.json({
    entityId: device.entityId,
    agentId: outcome.agentId,
    conversationId: outcome.conversationId,
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
