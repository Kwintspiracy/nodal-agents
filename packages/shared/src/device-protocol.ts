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

/**
 * Where a run stands, as a device reads it: `working` (a job of the run is
 * running), `waiting` (a request waits for a person), then one of the ends.
 */
export const DEVICE_RUN_STATES = ['working', 'waiting', 'done', 'cancelled', 'failed'] as const;
export const DeviceRunStateSchema = z.enum(DEVICE_RUN_STATES);
export type DeviceRunState = z.infer<typeof DeviceRunStateSchema>;

/** A file a run addressed: the deliverable `get_task` returns, as data. */
export const DeviceDeliverableSchema = z.object({
  /** Where it is, as the workspace names it. */
  path: z.string(),
  /** `code_project`, `office_file`, `document`, `outbound_action` or `other`. */
  type: z.string(),
  /** The agent named it in its result. */
  declared: z.boolean(),
  /** The state of its proof: `green`, `red`, `dirty`, … */
  verification: z.string(),
});
export type DeviceDeliverable = z.infer<typeof DeviceDeliverableSchema>;

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
  /**
   * Where a job launched from this device stands — the same run state
   * `get_task` reads (readRunState, @nodal-agents/db), PUSHED at each of its
   * transitions (claimed, a request asked or settled, ended): a device follows
   * a job without polling. `jobId` is the job the request launched (the head
   * of its run), whichever of its delegates moved.
   */
  z.object({
    type: z.literal('state'),
    jobId: z.string(),
    conversationId: z.string().nullable(),
    state: DeviceRunStateSchema,
    /** For `waiting`: the cards it waits on (their `cardId`). Empty otherwise. */
    waitingFor: z.array(z.string()),
    /** The files the run addressed, the paths `get_task` returns. Complete once it ends. */
    deliverables: z.array(DeviceDeliverableSchema),
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
 *     is no longer in memory (the runner restarted, or the device was away
 *     longer than the buffer holds). Re-read your pending cards with
 *     `GET /api/devices/:deviceId/cards` (DEVICE_GESTURES `cards`): every
 *     request still waiting for a person, as the `card` it was sent as.
 *     Never nothing (invariant #4).
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
  /** What waits for a person on this device now: after a `resync`, or at start. */
  cards: [{ method: 'GET', path: '/api/devices/:deviceId/cards' }],
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
