// queries/device-pairings.ts — a device asks for a key, the owner decides (#946, migration 0164).
//
// The device side holds no key: it is known by the hash of its device code,
// and nothing else. The owner side confirms from a workspace, which binds the
// request there. The secrets themselves (device code, token) are drawn and
// hashed by the caller; this module only ever sees hashes.
//
//   pending → confirmed → delivered      the token is handed over ONCE
//   pending → refused
//   pending, past `expires_at`           expired: listed until dismissed or purged
//
// Every state change is a guarded UPDATE (`WHERE status = …`), so two owners
// confirming at once, or two polls collecting at once, never both win.

import { and, asc, count, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm';
import type { DeviceCapability } from '@nodal-agents/shared';
import {
  devicePairings,
  devices,
  type DevicePairingRow,
  type DeviceRow,
} from '../schema/devices.ts';
import type { AnyDrizzleDb } from '../client.ts';

export interface DevicePairingLimits {
  /** Requests waiting at once, every address together. */
  maxPending: number;
  /** Requests from one address in the last minute. */
  perAddressPerMinute: number;
  /** How long an expired request stays listed (and its row kept) before it is purged. */
  keepExpiredMs: number;
}

export type CreateDevicePairingResult =
  | { ok: true; pairing: DevicePairingRow }
  | { ok: false; reason: 'per_address' | 'pending_cap' };

/**
 * Records a pairing request, under the abuse limits. Purges what expired long
 * ago first. One request at a time takes the limits' lock, so that two
 * requests racing never both pass a cap.
 */
export async function createDevicePairing(
  db: AnyDrizzleDb,
  input: {
    deviceCodeHash: string;
    /** Draws a candidate code; it is drawn again while a live request uses it. */
    drawUserCode: () => string;
    name: string;
    capabilities: DeviceCapability[];
    protocolVersion: number;
    from: string;
    now: Date;
    ttlMs: number;
    limits: DevicePairingLimits;
  },
): Promise<CreateDevicePairingResult> {
  const { now, limits } = input;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('device_pairings.create'))`);
    await tx
      .delete(devicePairings)
      .where(lt(devicePairings.expiresAt, new Date(now.getTime() - limits.keepExpiredMs)));

    const [fromHere] = await tx
      .select({ n: count() })
      .from(devicePairings)
      .where(
        and(
          eq(devicePairings.requestedFrom, input.from),
          gt(devicePairings.createdAt, new Date(now.getTime() - 60_000)),
        ),
      );
    if ((fromHere?.n ?? 0) >= limits.perAddressPerMinute) {
      return { ok: false as const, reason: 'per_address' as const };
    }
    const live = await tx
      .select({ userCode: devicePairings.userCode })
      .from(devicePairings)
      .where(and(eq(devicePairings.status, 'pending'), gt(devicePairings.expiresAt, now)));
    if (live.length >= limits.maxPending) {
      return { ok: false as const, reason: 'pending_cap' as const };
    }

    // Two requests waiting with the same code would make the owner's check
    // meaningless: the code is drawn again until no live request shows it.
    const taken = new Set(live.map((r) => r.userCode));
    let userCode = input.drawUserCode();
    for (let i = 0; taken.has(userCode); i++) {
      if (i >= 50) throw new Error('createDevicePairing: no free user code after 50 draws');
      userCode = input.drawUserCode();
    }

    const [pairing] = await tx
      .insert(devicePairings)
      .values({
        deviceCodeHash: input.deviceCodeHash,
        userCode,
        name: input.name,
        capabilities: input.capabilities,
        protocolVersion: input.protocolVersion,
        requestedFrom: input.from,
        createdAt: now,
        expiresAt: new Date(now.getTime() + input.ttlMs),
      })
      .returning();
    return { ok: true as const, pairing: pairing! };
  });
}

export type DevicePollOutcome =
  | { status: 'pending' }
  | { status: 'paired'; deviceId: string; conversationId: string; token: string }
  | { status: 'refused' }
  | { status: 'expired' }
  | { status: 'slow_down' };

/**
 * One poll of the device holding the code that hashes to `deviceCodeHash`.
 *
 * - A code that names no request (wrong, purged) is `expired`, like a token
 *   already handed over: there is nothing left to collect with it.
 * - Polled sooner than `minIntervalMs` after the last ACCEPTED poll:
 *   `slow_down`, and the clock is not reset.
 * - Confirmed: the token (`issue()` draws it) is set on the device and the
 *   request becomes `delivered`, in one transaction, under the row's lock.
 *   Only one poll can ever collect it. A device removed between the
 *   confirmation and this poll is `refused`.
 */
export async function pollDevicePairing(
  db: AnyDrizzleDb,
  input: {
    deviceCodeHash: string;
    now: Date;
    minIntervalMs: number;
    issue: () => { token: string; tokenHash: string };
  },
): Promise<DevicePollOutcome> {
  const { now } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(devicePairings)
      .where(eq(devicePairings.deviceCodeHash, input.deviceCodeHash))
      .for('update')
      .limit(1);
    if (!row) return { status: 'expired' as const };
    if (
      row.lastPolledAt !== null &&
      now.getTime() - row.lastPolledAt.getTime() < input.minIntervalMs
    ) {
      return { status: 'slow_down' as const };
    }
    await tx.update(devicePairings).set({ lastPolledAt: now }).where(eq(devicePairings.id, row.id));

    const expired = row.expiresAt.getTime() <= now.getTime();
    switch (row.status) {
      case 'refused':
        return { status: 'refused' as const };
      case 'delivered':
        return { status: 'expired' as const };
      case 'pending':
        return expired ? { status: 'expired' as const } : { status: 'pending' as const };
      case 'confirmed': {
        if (expired) return { status: 'expired' as const };
        const { token, tokenHash } = input.issue();
        const [device] = await tx
          .update(devices)
          .set({ tokenHash })
          .where(and(eq(devices.id, row.deviceId!), isNull(devices.revokedAt)))
          .returning({ id: devices.id });
        if (!device) return { status: 'refused' as const };
        await tx
          .update(devicePairings)
          .set({ status: 'delivered' })
          .where(and(eq(devicePairings.id, row.id), eq(devicePairings.status, 'confirmed')));
        return {
          status: 'paired' as const,
          deviceId: device.id,
          conversationId: row.conversationId!,
          token,
        };
      }
    }
  });
}

/**
 * The requests the owner can act on, every workspace together (a request
 * belongs to none): those waiting, and those that expired less than
 * `keepExpiredMs` ago and were not dismissed. Oldest first.
 */
export async function listDevicePairings(
  db: AnyDrizzleDb,
  params: { now: Date; keepExpiredMs: number },
): Promise<DevicePairingRow[]> {
  return db
    .select()
    .from(devicePairings)
    .where(
      and(
        eq(devicePairings.status, 'pending'),
        gt(devicePairings.expiresAt, new Date(params.now.getTime() - params.keepExpiredMs)),
      ),
    )
    .orderBy(asc(devicePairings.createdAt));
}

/**
 * The request `pairingId`, if it is still waiting, locked until the end of
 * the caller's transaction: the confirmation reads it, creates the device,
 * and marks it confirmed without anyone deciding in between.
 */
export async function lockPendingDevicePairing(
  tx: AnyDrizzleDb,
  params: { pairingId: string; now: Date },
): Promise<DevicePairingRow | null> {
  const [row] = await tx
    .select()
    .from(devicePairings)
    .where(
      and(
        eq(devicePairings.id, params.pairingId),
        eq(devicePairings.status, 'pending'),
        gt(devicePairings.expiresAt, params.now),
      ),
    )
    .for('update')
    .limit(1);
  return row ?? null;
}

/** The device a confirmed request becomes: the name and capabilities it gave, the address it came from. */
export async function createPairedDevice(
  tx: AnyDrizzleDb,
  params: { entityId: string; pairing: DevicePairingRow; now: Date },
): Promise<DeviceRow> {
  const [device] = await tx
    .insert(devices)
    .values({
      entityId: params.entityId,
      name: params.pairing.name,
      capabilities: params.pairing.capabilities,
      pairedFrom: params.pairing.requestedFrom,
      createdAt: params.now,
    })
    .returning();
  return device!;
}

export async function markDevicePairingConfirmed(
  tx: AnyDrizzleDb,
  params: {
    pairingId: string;
    entityId: string;
    deviceId: string;
    conversationId: string;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(devicePairings)
    .set({
      status: 'confirmed',
      entityId: params.entityId,
      deviceId: params.deviceId,
      conversationId: params.conversationId,
      decidedAt: params.now,
    })
    .where(and(eq(devicePairings.id, params.pairingId), eq(devicePairings.status, 'pending')));
}

/** Refuses a request still waiting. False: none (decided, expired, or no such request). */
export async function refuseDevicePairing(
  db: AnyDrizzleDb,
  params: { pairingId: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(devicePairings)
    .set({ status: 'refused', decidedAt: params.now })
    .where(
      and(
        eq(devicePairings.id, params.pairingId),
        eq(devicePairings.status, 'pending'),
        gt(devicePairings.expiresAt, params.now),
      ),
    )
    .returning({ id: devicePairings.id });
  return rows.length > 0;
}

/** Dismisses an EXPIRED request. False: none (still waiting, decided, or no such request). */
export async function dismissDevicePairing(
  db: AnyDrizzleDb,
  params: { pairingId: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .delete(devicePairings)
    .where(
      and(
        eq(devicePairings.id, params.pairingId),
        eq(devicePairings.status, 'pending'),
        lte(devicePairings.expiresAt, params.now),
      ),
    )
    .returning({ id: devicePairings.id });
  return rows.length > 0;
}
