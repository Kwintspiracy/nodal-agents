// routes/devices.ts — the device routes (#945).
//
//   GET  /api/devices/:deviceId/events        the device's stream (SSE)
//   GET  /api/devices/:deviceId/cards         → { cards: card[] } what waits for a person
//   GET  /api/devices/:deviceId/cards/:cardId/images/:n   the bytes of a card's image
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
// THE CARDS. What the stream can lose, the base keeps: a pending request
// survives a restart, its event does not. After a `resync` (or at start) the
// device reads here every request of ITS runs (the chat of the run's head is
// this device, `runOriginOf`) still waiting for a person, as the very `card` it was sent as — the same
// composition (`composeRequestCard`, and `composeElicitationChoiceCard` for
// the question of an MCP server, approvals/notify.ts) and the same builder
// (`deviceEventFor`, devices/device-sink.ts). A server's question that no
// list of choices answers was sent as a bubble saying so, not as a card: it
// waits on the dashboard, and is not listed.
//
// THE IMAGES. A card names its images (`images[].path`), it never carries
// them. Their bytes are served here, with their content type (one of the four
// image types, else nothing), for a request this device may see by THE rule of
// the cards list (`requestsOfDevice`): still waiting for a person, its run made
// on this device, in its workspace, and a card that carries images. Any other —
// answered, withdrawn, expired, another device's — answers 404, exactly like an
// image that does not exist.
//
// THE GUARD: the device's own key (#946). The device gate (devices/device-auth.ts)
// accepts nothing else on these routes — never the worker secret — and
// `authorizeDevice` (devices/device-guard.ts) checks the route names the
// key's own device.

import type { Context } from 'hono';
import { z } from 'zod';
import {
  eq,
  and,
  agentJobs,
  approvalRequests,
  approvalsOldestFirst,
  approvalRequestAttachments,
  inArray,
  isDeviceId,
  runOriginOf,
  type DeviceRow,
} from '@nodal-agents/db';
import { deviceAdapter } from '@nodal-agents/delivery';
import {
  ELICITATION_ATTACHMENT_MIME_TYPES,
  type DeviceEvent,
  type ShellGateReason,
} from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { jobEvents, type JobEventBus } from '../events/job-events.ts';
import { authorizeDevice } from '../devices/device-guard.ts';
import { deviceEventsOf } from '../devices/device-events.ts';
import { deviceConversation } from '../devices/device-conversation.ts';
import { deviceEventFor } from '../devices/device-sink.ts';
import { composeElicitationChoiceCard, composeRequestCard } from '../approvals/notify.ts';
import { loadElicitationCard } from '../approvals/elicitation-card-view.ts';
import { deviceOfChat } from '../events/publish.ts';
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

  const cards: Extract<DeviceEvent, { type: 'card' }>[] = [];
  for (const row of await requestsOfDevice(deps, device)) {
    if (!row.agentId) continue;
    if (row.kind === 'elicitation') {
      const event = await elicitationCardOf(deps, device, row.id);
      if (event) cards.push(event);
      continue;
    }
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
    const { event } = deviceEventFor(composed, device.id);
    // A device draws every card (`capabilities.buttons`): anything else is a
    // composition the device could not have been sent, said loud.
    if (event.type !== 'card') {
      throw new Error(`device_card_not_a_card: request ${row.id} composed as ${event.type}`);
    }
    cards.push(event);
  }
  return c.json({ cards });
}

/**
 * THE rule of what a device may see of a request, read by the cards list AND
 * by the images of a card — never a second copy of its conditions: a request
 * of the device's workspace that is STILL waiting for a person (`pending`,
 * which answered, withdrawn and expired requests are not), whose run was made
 * on THIS device. The run's origin is read the one way (`runOriginOf`: the
 * chat of the run's head, through delegation, task-board children and
 * relaunches), as the send (approvals/notify.ts) and the pushed state
 * (events/publish.ts) read it. `onlyId` narrows to one request.
 */
async function requestsOfDevice(deps: RunnerDeps, device: DeviceRow, onlyId?: string) {
  const pending = await deps.db
    .select({
      id: approvalRequests.id,
      jobId: approvalRequests.jobId,
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
        eq(approvalRequests.status, 'pending'),
        inArray(approvalRequests.kind, ['approval', 'question', 'elicitation']),
        ...(onlyId === undefined ? [] : [eq(approvalRequests.id, onlyId)]),
      ),
    )
    .orderBy(approvalsOldestFirst);
  const deviceOfJob = new Map<string, string | null>();
  const rows: typeof pending = [];
  for (const row of pending) {
    if (!deviceOfJob.has(row.jobId)) {
      const origin = await runOriginOf(deps.db, device.entityId, row.jobId);
      deviceOfJob.set(row.jobId, origin ? deviceOfChat(origin) : null);
    }
    if (deviceOfJob.get(row.jobId) === device.id) rows.push(row);
  }
  return rows;
}

/**
 * The card of a server's question, as it was sent: a card when a list of
 * choices answers it, otherwise it was a bubble — null, not a card. Shared by
 * the list and by the images (a bubble's images were never offered).
 */
async function elicitationCardOf(
  deps: RunnerDeps,
  device: DeviceRow,
  requestId: string,
): Promise<Extract<DeviceEvent, { type: 'card' }> | null> {
  const loaded = await loadElicitationCard(deps.db, requestId);
  if (!loaded.ok) return null;
  const composed = await composeElicitationChoiceCard(deps.db, loaded.state, deviceAdapter);
  if (composed.kind === 'text') return null;
  const { event } = deviceEventFor(composed, device.id);
  if (event.type !== 'card') {
    throw new Error(`device_card_not_a_card: request ${requestId} composed as ${event.type}`);
  }
  return event;
}

/** An image's place among its request's attachments: a small whole number. */
const IMAGE_INDEX_RE = /^(0|[1-9][0-9]{0,2})$/;

export async function deviceCardImageRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const guard = await authorizeDevice(c, deps, c.req.param('deviceId') ?? '');
  if (!guard.ok) return guard.response;
  const { device } = guard;
  const cardId = c.req.param('cardId') ?? '';
  const n = c.req.param('n') ?? '';
  // Another device's card, another workspace's, a request that does not
  // exist or is no longer open, an image it does not have or whose type is
  // not an image's: the same 404, nothing to guess from.
  const notFound = (): Response => c.json({ error: 'image_not_found' }, 404);
  if (!isDeviceId(cardId) || !IMAGE_INDEX_RE.test(n)) return notFound();
  // The request is one the device may see (the list's rule), and it is a card
  // that carries images: the question of a server answered by choices.
  const [request] = await requestsOfDevice(deps, device, cardId);
  if (!request || request.kind !== 'elicitation') return notFound();
  if (!(await elicitationCardOf(deps, device, cardId))) return notFound();
  const [image] = await deps.db
    .select({
      mimeType: approvalRequestAttachments.mimeType,
      data: approvalRequestAttachments.data,
    })
    .from(approvalRequestAttachments)
    .where(
      and(
        eq(approvalRequestAttachments.approvalRequestId, cardId),
        eq(approvalRequestAttachments.position, Number(n)),
      ),
    )
    .limit(1);
  if (!image) return notFound();
  // Fail closed: only the image types intake admits are ever served, so that
  // nothing a row could hold (html, svg) reaches a device with a type of its own.
  if (!(ELICITATION_ATTACHMENT_MIME_TYPES as readonly string[]).includes(image.mimeType)) {
    return notFound();
  }
  const bytes = Buffer.from(image.data, 'base64');
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': image.mimeType,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
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
