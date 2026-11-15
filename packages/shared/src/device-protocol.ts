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
// What the stream never carries is a file: an announcement points to its
// audio, a card to its images, and the device reads them with its token.
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
 * An image that comes with a card (an MCP server's question shows what it is
 * about to do): a POINTER, never the bytes. `GET path` with the device's
 * token (DEVICE_GESTURES `see`) answers the bytes, with `mimeType` as their
 * content type.
 */
export const DeviceCardImageSchema = z.object({
  /** `/api/devices/:deviceId/cards/:cardId/images/:n`: append it to Nodal's address. */
  path: z.string(),
  /** `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
  mimeType: z.string(),
  /** What the server says of the image, as data. Absent: it says nothing. */
  caption: z.string().optional(),
});
export type DeviceCardImage = z.infer<typeof DeviceCardImageSchema>;

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
  /**
   * Nodal asks the person something on behalf of a job: approve an action,
   * choose an option, or answer the question an MCP server asks during a
   * call (`kind: 'question'`, its choices the server's own buttons, a decline
   * among them).
   */
  z.object({
    type: z.literal('card'),
    /** The request's id: what `POST /api/approve` takes as `approvalRequestId`. */
    cardId: z.string(),
    kind: z.enum(['approval', 'question']),
    /** The platform's fixed frame, with the agent's (or the server's) words quoted in it. */
    text: z.string(),
    choices: z.array(DeviceCardChoiceSchema),
    /** The images that come with the question, in order. Absent: there are none. */
    images: z.array(DeviceCardImageSchema).optional(),
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
   *
   * ORDER. The server never publishes a reading of a run older than the last
   * one it published for that run (its pushes are serialized, each reading
   * the base after the previous one was published). `seq` lets the client
   * prove it: within a run, a `state` whose `seq` is not higher than the last
   * one shown is older — ignore it. `seq` is the event's number in the
   * workspace's stream (the number in the SSE `id:`), so it restarts with the
   * runner: after a `resync`, forget the last `seq` of every run.
   */
  z.object({
    type: z.literal('state'),
    /** Higher is newer, within a runner's life (see ORDER above). */
    seq: z.number().int().positive(),
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
  /** An image of a card (`images[].path`): only a card of a request made on this device. */
  see: [{ method: 'GET', path: '/api/devices/:deviceId/cards/:cardId/images/:n' }],
} as const satisfies Record<
  string,
  readonly { method: 'GET' | 'POST' | 'DELETE'; path: `/api/${string}` }[]
>;
export type DeviceGesture = keyof typeof DEVICE_GESTURES;

/** The `path` of a card's image `n` (DEVICE_GESTURES `see`), as the card names it. */
export function deviceCardImagePath(deviceId: string, cardId: string, n: number): string {
  return DEVICE_GESTURES.see[0].path
    .replace(':deviceId', encodeURIComponent(deviceId))
    .replace(':cardId', encodeURIComponent(cardId))
    .replace(':n', String(n));
}

// ─── Pairing (#946) ──────────────────────────────────────────────────────────
//
// A device pairs FROM ITS OWN SIDE, in the style of RFC 8628 (the device
// authorization grant): it holds no key yet, asks Nodal for a pairing code,
// shows it or says it aloud, and polls until the owner confirms or refuses it
// in Settings → Devices. On confirmation it receives, ONCE, its own key: a
// device token, scoped to its own routes and its own conversation. A device
// never holds the worker secret.
//
//   POST /api/devices/pair        DevicePairRequest → 201 DevicePairStarted
//                                                      429 { error: 'rate_limited', reason }
//   POST /api/devices/pair/poll   DevicePollRequest → 202 { status: 'pending' }
//                                                      200 { status: 'paired', deviceId, token, conversationId }
//                                                      403 { status: 'refused' }
//                                                      410 { status: 'expired' }  (also: a wrong code,
//                                                          or a token already handed over)
//                                                      429 { status: 'slow_down' } (polled faster than
//                                                          `intervalSeconds`)
//
// After pairing, every request of the device carries
//   Authorization: Bearer ndv_<43 base64url chars>
// It is accepted on the routes of DEVICE_GESTURES (`isDeviceTokenRoute`), and
// refused by every other route of the runner, the two pairing routes included:
// a device reaches those without a key.

/** How long a pairing code lives. */
export const DEVICE_PAIRING_TTL_SECONDS = 600;
/** How often a device may poll. */
export const DEVICE_PAIRING_INTERVAL_SECONDS = 2;
/** The longest name a device may give itself. */
export const DEVICE_NAME_MAX = 60;

/** A device token: `ndv_` then 32 random bytes in base64url (43 characters). */
export const DEVICE_TOKEN_PREFIX = 'ndv_';
export const DEVICE_TOKEN_RE = /^ndv_[A-Za-z0-9_-]{43}$/;

const DeviceNameSchema = z.string().trim().min(1).max(DEVICE_NAME_MAX);

export const DevicePairRequestSchema = z
  .object({
    name: DeviceNameSchema,
    capabilities: z.array(DeviceCapabilitySchema).max(DEVICE_CAPABILITIES.length),
    protocolVersion: z.number().int().min(1),
  })
  .strict();
export type DevicePairRequest = z.infer<typeof DevicePairRequestSchema>;

export const DevicePairStartedSchema = z.object({
  pairingId: z.string().guid(),
  /** Secret: what the device polls with. Never shown. */
  deviceCode: z.string().min(43),
  /** Six digits the device shows or says, for the owner to compare. */
  userCode: z.string().regex(/^[0-9]{6}$/),
  expiresInSeconds: z.literal(DEVICE_PAIRING_TTL_SECONDS),
  intervalSeconds: z.literal(DEVICE_PAIRING_INTERVAL_SECONDS),
});
export type DevicePairStarted = z.infer<typeof DevicePairStartedSchema>;

export const DevicePairRateLimitedSchema = z.object({
  error: z.literal('rate_limited'),
  /** `per_address`: too many requests from this address in a minute; `pending_cap`: too many waiting. */
  reason: z.enum(['per_address', 'pending_cap']),
});

export const DevicePollRequestSchema = z
  .object({ deviceCode: z.string().min(1).max(200) })
  .strict();
export type DevicePollRequest = z.infer<typeof DevicePollRequestSchema>;

export const DevicePollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('paired'),
    deviceId: z.string().guid(),
    /** Returned ONCE. Nodal keeps only its hash. */
    token: z.string().regex(DEVICE_TOKEN_RE),
    conversationId: z.string().guid(),
  }),
  z.object({ status: z.literal('refused') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('slow_down') }),
]);
export type DevicePollResponse = z.infer<typeof DevicePollResponseSchema>;

/** The HTTP status of each poll answer. */
export const DEVICE_POLL_STATUS = {
  pending: 202,
  paired: 200,
  refused: 403,
  expired: 410,
  slow_down: 429,
} as const satisfies Record<DevicePollResponse['status'], number>;

/** The gestures of a device that has no key yet. */
export const DEVICE_PAIRING_GESTURES = {
  pair: [
    { method: 'POST', path: '/api/devices/pair' },
    { method: 'POST', path: '/api/devices/pair/poll' },
  ],
} as const satisfies Record<
  string,
  readonly { method: 'GET' | 'POST' | 'DELETE'; path: `/api/${string}` }[]
>;

/** Does `path` match the route pattern `pattern` (`:name` is one non-empty segment)? */
function matchesRoute(pattern: string, path: string): boolean {
  const a = pattern.split('/');
  const b = path.split('/');
  return (
    a.length === b.length &&
    a.every((seg, i) => (seg.startsWith(':') ? (b[i] ?? '') !== '' : seg === b[i]))
  );
}

function namedBy(
  routes: Record<string, readonly { method: string; path: string }[]>,
  method: string,
  path: string,
): boolean {
  return Object.values(routes).some((list) =>
    list.some((r) => r.method === method && matchesRoute(r.path, path)),
  );
}

/**
 * The routes that accept a device token: every route of DEVICE_GESTURES, and
 * no other. The runner refuses a device token everywhere else.
 */
export function isDeviceTokenRoute(method: string, path: string): boolean {
  return namedBy(DEVICE_GESTURES, method, path);
}

// ─── The owner's side: Settings → Devices (#946) ─────────────────────────────
//
// Separate from the device routes: they never accept a device token, and keep
// the owner's guard (the dashboard calls them with the worker secret and the
// workspace it read from the session; a session bearer reaches only its own).
//
//   GET    /api/device-pairings?entityId=           → { pairings: DevicePairingView[] }
//   POST   /api/device-pairings/:pairingId/confirm  { entityId } → { deviceId, conversationId }
//   POST   /api/device-pairings/:pairingId/refuse   { entityId } → { refused: true }
//   DELETE /api/device-pairings/:pairingId?entityId= (an expired request, dismissed) → { dismissed: true }
//   GET    /api/workspace-devices?entityId=         → { devices: PairedDeviceView[] }
//   PATCH  /api/workspace-devices/:deviceId         { entityId, name } → { device: PairedDeviceView }
//   DELETE /api/workspace-devices/:deviceId?entityId= → { removed: true }: its key stops at
//                                                       once, its open streams are closed
//
// A pairing request belongs to NO workspace until the owner confirms it from
// one: every workspace's Devices page lists the requests waiting, and
// confirming binds the device to that workspace.

export const DEVICE_OWNER_ROUTES = {
  listPairings: { method: 'GET', path: '/api/device-pairings' },
  confirmPairing: { method: 'POST', path: '/api/device-pairings/:pairingId/confirm' },
  refusePairing: { method: 'POST', path: '/api/device-pairings/:pairingId/refuse' },
  dismissPairing: { method: 'DELETE', path: '/api/device-pairings/:pairingId' },
  listDevices: { method: 'GET', path: '/api/workspace-devices' },
  renameDevice: { method: 'PATCH', path: '/api/workspace-devices/:deviceId' },
  removeDevice: { method: 'DELETE', path: '/api/workspace-devices/:deviceId' },
} as const satisfies Record<
  string,
  { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: `/api/${string}` }
>;

export const DevicePairingViewSchema = z.object({
  pairingId: z.string().guid(),
  /** The name the device gives itself: TEXT, never markup. */
  name: z.string(),
  capabilities: z.array(DeviceCapabilitySchema),
  userCode: z.string().regex(/^[0-9]{6}$/),
  /** The address the request came from. */
  from: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  /** `expired`: not confirmed in time; listed until dismissed or purged. */
  state: z.enum(['pending', 'expired']),
});
export type DevicePairingView = z.infer<typeof DevicePairingViewSchema>;

export const PairedDeviceViewSchema = z.object({
  deviceId: z.string().guid(),
  name: z.string(),
  capabilities: z.array(DeviceCapabilitySchema),
  pairedAt: z.string(),
  /** The address it paired from; null for a device that never paired. */
  pairedFrom: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  /** The device holds an open stream right now. */
  connected: z.boolean(),
});
export type PairedDeviceView = z.infer<typeof PairedDeviceViewSchema>;

export const DeviceConfirmRequestSchema = z.object({ entityId: z.string().guid() }).strict();
export const DeviceRenameRequestSchema = z
  .object({ entityId: z.string().guid(), name: DeviceNameSchema })
  .strict();
