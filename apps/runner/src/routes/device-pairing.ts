// routes/device-pairing.ts — a device asks for its key, the owner decides (#946).
//
// THE DEVICE'S SIDE, without a key (the contract: DEVICE_PAIRING_GESTURES,
// @nodal-agents/shared):
//   POST /api/devices/pair        { name, capabilities, protocolVersion }
//        → 201 { pairingId, deviceCode, userCode, expiresInSeconds, intervalSeconds }
//        → 429 { error: 'rate_limited', reason: 'per_address' | 'pending_cap' }
//   POST /api/devices/pair/poll   { deviceCode }
//        → 202 pending · 200 paired (the token, ONCE) · 403 refused · 410 expired · 429 slow_down
//
// THE OWNER'S SIDE (DEVICE_OWNER_ROUTES), behind `requireRunnerAuth`: the
// dashboard calls them with the worker secret and the workspace of the
// session; a session bearer reaches only its own workspace; a device key is
// refused by the device gate.
//
// A request belongs to NO workspace until it is confirmed: every Devices page
// lists the requests waiting, and the one that confirms binds the device to
// its workspace, opens the device's conversation with that workspace's root
// agent (devices/device-conversation.ts) and lets the next poll collect the
// key. What a request sends (its name above all) is stored and shown as TEXT;
// nothing in it is ever trusted beyond that.

import type { Context } from 'hono';
import { z } from 'zod';
import {
  createDevicePairing,
  createPairedDevice,
  dismissDevicePairing,
  listDevicePairings,
  listWorkspaceDevices,
  lockPendingDevicePairing,
  markDevicePairingConfirmed,
  pollDevicePairing,
  refuseDevicePairing,
  renameWorkspaceDevice,
  revokeWorkspaceDevice,
  type DevicePairingLimits,
  type DevicePairingRow,
  type DeviceRow,
} from '@nodal-agents/db';
import {
  DEVICE_PAIRING_INTERVAL_SECONDS,
  DEVICE_PAIRING_TTL_SECONDS,
  DEVICE_POLL_STATUS,
  DeviceConfirmRequestSchema,
  DevicePairRequestSchema,
  DevicePollRequestSchema,
  DeviceRenameRequestSchema,
  type DevicePairingView,
  type DevicePollResponse,
  type PairedDeviceView,
} from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { clientAddress } from '../devices/client-address.ts';
import { deviceConversation } from '../devices/device-conversation.ts';
import {
  drawDeviceCode,
  drawDeviceToken,
  drawUserCode,
  hashDeviceSecret,
} from '../devices/device-secrets.ts';
import { cutDeviceStreams, isDeviceConnected } from '../devices/device-streams.ts';

/** The abuse limits of the pairing route. */
export const DEVICE_PAIRING_LIMITS: DevicePairingLimits = {
  maxPending: 20,
  perAddressPerMinute: 5,
  // An expired request is shown as such (and can be dismissed) for an hour,
  // then purged with every other request past that point.
  keepExpiredMs: 60 * 60_000,
};

/**
 * How soon after an accepted poll the next one is accepted. A device polling
 * on a 2 s timer arrives a few milliseconds early about half the time (timer
 * and network jitter): those polls are on time from its side, and refusing
 * them would make an honest device wait twice as long. Below that margin, it
 * is polling too fast, and is told so (`slow_down`).
 */
export const DEVICE_POLL_MIN_INTERVAL_MS = DEVICE_PAIRING_INTERVAL_SECONDS * 1000 - 250;

async function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

// ─── The device's side ───────────────────────────────────────────────────────

export async function devicePairRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const parsed = DevicePairRequestSchema.safeParse(await jsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const from = clientAddress(c);
  // Without the address, the per-address limit would limit nothing.
  if (from === null) return c.json({ error: 'client_address_unknown' }, 500);

  const deviceCode = drawDeviceCode();
  const created = await createDevicePairing(deps.db, {
    deviceCodeHash: hashDeviceSecret(deviceCode),
    drawUserCode,
    name: parsed.data.name,
    capabilities: [...new Set(parsed.data.capabilities)],
    protocolVersion: parsed.data.protocolVersion,
    from,
    now: new Date(),
    ttlMs: DEVICE_PAIRING_TTL_SECONDS * 1000,
    limits: DEVICE_PAIRING_LIMITS,
  });
  if (!created.ok) return c.json({ error: 'rate_limited', reason: created.reason }, 429);

  return c.json(
    {
      pairingId: created.pairing.id,
      deviceCode,
      userCode: created.pairing.userCode,
      expiresInSeconds: DEVICE_PAIRING_TTL_SECONDS,
      intervalSeconds: DEVICE_PAIRING_INTERVAL_SECONDS,
    },
    201,
  );
}

export async function devicePollRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const parsed = DevicePollRequestSchema.safeParse(await jsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const outcome = await pollDevicePairing(deps.db, {
    deviceCodeHash: hashDeviceSecret(parsed.data.deviceCode),
    now: new Date(),
    minIntervalMs: DEVICE_POLL_MIN_INTERVAL_MS,
    issue: drawDeviceToken,
  });
  const body: DevicePollResponse = outcome;
  return c.json(body, DEVICE_POLL_STATUS[outcome.status]);
}

// ─── The owner's side ────────────────────────────────────────────────────────

/** The workspace the caller acts for, or the refusal: a session reaches only its own. */
function ownerWorkspace(c: Context, entityId: string): Response | null {
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return null;
}

const EntityQuerySchema = z.object({ entityId: z.string().guid() });
const PairingParamSchema = z.string().guid();

function pairingView(row: DevicePairingRow, now: Date): DevicePairingView {
  return {
    pairingId: row.id,
    name: row.name,
    capabilities: row.capabilities,
    userCode: row.userCode,
    from: row.requestedFrom,
    requestedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    state: row.expiresAt.getTime() > now.getTime() ? 'pending' : 'expired',
  };
}

function deviceView(row: DeviceRow): PairedDeviceView {
  return {
    deviceId: row.id,
    name: row.name,
    capabilities: row.capabilities,
    pairedAt: row.createdAt.toISOString(),
    pairedFrom: row.pairedFrom,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    connected: isDeviceConnected(row.id),
  };
}

export async function listPairingsRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const q = EntityQuerySchema.safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid_request', issues: q.error.issues }, 400);
  const refused = ownerWorkspace(c, q.data.entityId);
  if (refused) return refused;
  const now = new Date();
  const rows = await listDevicePairings(deps.db, {
    now,
    keepExpiredMs: DEVICE_PAIRING_LIMITS.keepExpiredMs,
  });
  return c.json({ pairings: rows.map((r) => pairingView(r, now)) });
}

/** A confirmation that cannot complete undoes what it wrote. */
class ConfirmAborted extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function confirmPairingRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const pairingId = PairingParamSchema.safeParse(c.req.param('pairingId'));
  const body = DeviceConfirmRequestSchema.safeParse(await jsonBody(c));
  if (!pairingId.success || !body.success) return c.json({ error: 'invalid_request' }, 400);
  const { entityId } = body.data;
  const refused = ownerWorkspace(c, entityId);
  if (refused) return refused;

  const now = new Date();
  try {
    const confirmed = await deps.db.transaction(async (tx) => {
      const db = tx as unknown as RunnerDeps['db'];
      const pairing = await lockPendingDevicePairing(db, { pairingId: pairingId.data, now });
      if (!pairing) throw new ConfirmAborted('pairing_not_pending');
      const device = await createPairedDevice(db, { entityId, pairing, now });
      const conversation = await deviceConversation(db, { entityId, deviceId: device.id });
      if (!conversation.ok) throw new ConfirmAborted(conversation.code);
      await markDevicePairingConfirmed(db, {
        pairingId: pairing.id,
        entityId,
        deviceId: device.id,
        conversationId: conversation.conversationId,
        now,
      });
      return { deviceId: device.id, conversationId: conversation.conversationId };
    });
    return c.json(confirmed);
  } catch (err) {
    if (err instanceof ConfirmAborted) {
      return c.json({ error: err.code }, err.code === 'pairing_not_pending' ? 404 : 409);
    }
    throw err;
  }
}

export async function refusePairingRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const pairingId = PairingParamSchema.safeParse(c.req.param('pairingId'));
  const body = DeviceConfirmRequestSchema.safeParse(await jsonBody(c));
  if (!pairingId.success || !body.success) return c.json({ error: 'invalid_request' }, 400);
  const refused = ownerWorkspace(c, body.data.entityId);
  if (refused) return refused;
  const done = await refuseDevicePairing(deps.db, { pairingId: pairingId.data, now: new Date() });
  if (!done) return c.json({ error: 'pairing_not_pending' }, 404);
  return c.json({ refused: true });
}

export async function dismissPairingRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const pairingId = PairingParamSchema.safeParse(c.req.param('pairingId'));
  const q = EntityQuerySchema.safeParse(c.req.query());
  if (!pairingId.success || !q.success) return c.json({ error: 'invalid_request' }, 400);
  const refused = ownerWorkspace(c, q.data.entityId);
  if (refused) return refused;
  const done = await dismissDevicePairing(deps.db, { pairingId: pairingId.data, now: new Date() });
  if (!done) return c.json({ error: 'pairing_not_expired' }, 404);
  return c.json({ dismissed: true });
}

export async function listDevicesRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const q = EntityQuerySchema.safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid_request', issues: q.error.issues }, 400);
  const refused = ownerWorkspace(c, q.data.entityId);
  if (refused) return refused;
  const rows = await listWorkspaceDevices(deps.db, q.data.entityId);
  return c.json({ devices: rows.map(deviceView) });
}

export async function renameDeviceRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const deviceId = c.req.param('deviceId') ?? '';
  const body = DeviceRenameRequestSchema.safeParse(await jsonBody(c));
  if (!body.success) return c.json({ error: 'invalid_request', issues: body.error.issues }, 400);
  const refused = ownerWorkspace(c, body.data.entityId);
  if (refused) return refused;
  const row = await renameWorkspaceDevice(deps.db, {
    entityId: body.data.entityId,
    deviceId,
    name: body.data.name,
  });
  if (!row) return c.json({ error: 'device_not_found' }, 404);
  return c.json({ device: deviceView(row) });
}

export async function removeDeviceRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const deviceId = c.req.param('deviceId') ?? '';
  const q = EntityQuerySchema.safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid_request', issues: q.error.issues }, 400);
  const refused = ownerWorkspace(c, q.data.entityId);
  if (refused) return refused;
  const row = await revokeWorkspaceDevice(deps.db, {
    entityId: q.data.entityId,
    deviceId,
    at: new Date(),
  });
  if (!row) return c.json({ error: 'device_not_found' }, 404);
  // Its key is refused from its next request on; what it holds open, now.
  cutDeviceStreams(row.id);
  return c.json({ removed: true });
}
