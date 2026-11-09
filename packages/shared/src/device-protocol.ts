// device-protocol.ts — what Nodal says to a device, and how a device speaks to Nodal (#945).
//
// A device is an external module (a desktop companion, a speaker, a small
// robot, a piece of software) plugged into Nodal as a channel. Nodal knows no
// device by name: the device side is someone else's code, and this module is
// the contract between the two. It is defined ONCE, here, typed with Zod, so
// that the public protocol docs (#947) and the device kit (#950) are generated
// from it or tested against it, never retyped.
//
// The protocol carries CONVERSATION GESTURES, never the agent's tools.
//
//   module → Nodal   say, send, answer, cancel   — the routes the dashboard
//                                                   uses, unchanged (DEVICE_GESTURES)
//   Nodal → module   bubble, card, card.closed, state, announce
//                                                 — the device's own event
//                                                   stream (DeviceEventSchema)
//
// What a card or a bubble SAYS is never composed for the device: a card
// carries the platform's fixed frame and the agent's words quoted as data,
// exactly as the Telegram card does (invariant #2); a bubble carries the
// agent's reply as it is stored.

import { z } from 'zod';

/** Bumped only when an existing field changes meaning; adding one does not. */
export const DEVICE_PROTOCOL_VERSION = 1;

/** What a device may declare it can do (`devices.capabilities`, migration 0163). */
export const DEVICE_CAPABILITIES = ['microphone', 'speaker', 'screen', 'buttons'] as const;
export const DeviceCapabilitySchema = z.enum(DEVICE_CAPABILITIES);
export type DeviceCapability = z.infer<typeof DeviceCapabilitySchema>;

// ─── Nodal → module ──────────────────────────────────────────────────────────

/**
 * One way to answer a card: what to send to `POST /api/approve` with the
 * card's id. A question's choices are its options; an approval's are approve
 * and reject.
 */
export const DeviceCardChoiceSchema = z.object({
  label: z.string(),
  decision: z.enum(['approve', 'reject']),
  /** The option chosen, for a question. Absent for an approval. */
  answer: z.string().optional(),
});
export type DeviceCardChoice = z.infer<typeof DeviceCardChoiceSchema>;

export const DeviceEventSchema = z.discriminatedUnion('type', [
  /** Something for the person to read or hear: an agent's reply, a message sent to this device. */
  z.object({
    type: z.literal('bubble'),
    bubbleId: z.string(),
    /** The job whose reply this is; null for a message that belongs to no job's end. */
    jobId: z.string().nullable(),
    conversationId: z.string().nullable(),
    text: z.string(),
  }),
  /** Nodal asks the person something on behalf of a job: approve an action, or choose an option. */
  z.object({
    type: z.literal('card'),
    /** The request's id: what `POST /api/approve` takes as `approvalRequestId`. */
    cardId: z.string(),
    kind: z.enum(['approval', 'question']),
    /** The platform's fixed frame, with the agent's words quoted in it. */
    text: z.string(),
    choices: z.array(DeviceCardChoiceSchema),
  }),
  /** A card's request was settled (here, on another device, on the dashboard, or by expiry). */
  z.object({
    type: z.literal('card.closed'),
    cardId: z.string(),
    /** What the card says now, in the same fixed frame. */
    text: z.string(),
  }),
  /** Where a job launched from this device stands. */
  z.object({
    type: z.literal('state'),
    jobId: z.string(),
    conversationId: z.string().nullable(),
    state: z.enum(['waiting', 'done', 'cancelled', 'failed']),
    /** For `failed`: the first line of the job's explanation, as stored. */
    reason: z.string().optional(),
  }),
  /**
   * A job launched by voice from this device ended, and its announcement is
   * spoken: the voice is read at `GET /api/voice/replies/:audioId`. A pointer,
   * never the audio itself.
   */
  z.object({
    type: z.literal('announce'),
    jobId: z.string(),
    conversationId: z.string().nullable(),
    audioId: z.string(),
  }),
]);
export type DeviceEvent = z.infer<typeof DeviceEventSchema>;
export type DeviceEventType = DeviceEvent['type'];

/**
 * The stream's own events, besides the gestures — the same two the
 * workspace stream (`GET /api/events`) writes, with the same resume ids:
 *   - SSE event `ready`, data `{}`: what was missed has been replayed, the
 *     stream is live;
 *   - SSE event `resync`, data `{ type: 'resync', reason }`: what was missed
 *     is no longer in memory — re-read the conversation (never nothing,
 *     invariant #4).
 */
export const DeviceStreamReadySchema = z.object({}).strict();
export const DeviceStreamResyncSchema = z.object({
  type: z.literal('resync'),
  reason: z.string(),
});

// ─── module → Nodal ──────────────────────────────────────────────────────────

/**
 * The gestures a device makes, and the routes that carry them: the very
 * routes the dashboard uses, so nothing is dashboard-only. A device first
 * gets its conversation (`POST /api/devices/:deviceId/conversation`); every
 * turn it then says or sends there is recorded as made on it.
 *
 * `drop` (a file) is not listed: the runner has no file-upload route yet, the
 * dashboard's goes through the web. It joins this table with that route.
 */
export const DEVICE_GESTURES = {
  conversation: [{ method: 'POST', path: '/api/devices/:deviceId/conversation' }],
  listen: [{ method: 'GET', path: '/api/devices/:deviceId/events' }],
  say: [
    { method: 'POST', path: '/api/voice/turns' },
    { method: 'POST', path: '/api/voice/turns/:turnId/chunks/:seq' },
    { method: 'POST', path: '/api/voice/turns/:turnId/end' },
  ],
  send: [{ method: 'POST', path: '/api/chat/stream' }],
  answer: [{ method: 'POST', path: '/api/approve' }],
  cancel: [
    { method: 'DELETE', path: '/api/voice/turns/:turnId' },
    { method: 'POST', path: '/api/chat/stop' },
  ],
  hear: [{ method: 'GET', path: '/api/voice/replies/:audioId' }],
} as const satisfies Record<
  string,
  readonly { method: 'GET' | 'POST' | 'DELETE'; path: `/api/${string}` }[]
>;
export type DeviceGesture = keyof typeof DEVICE_GESTURES;
