// queries/devices.ts — reading the devices of a workspace (#945), and their keys (#946).
//
// A device belongs to a workspace (entity). Every read here is SCOPED to one:
// a device id alone is never enough to reach a device, so a job or a caller
// of workspace X can never address a device of workspace Y, even by naming
// its id (the isolation test of the device stream rests on this).
//
// A REMOVED device (`revoked_at`) is reached by nothing: no read here returns
// it, so its key is refused, cards stop being sent to it
// (`isConversationAllowed`), and the sink addresses nothing to it. Its row
// stays, for its past conversation's name.
//
// The one read that takes no workspace is `findDeviceByTokenHash`: the token
// IS the proof, and it names its device and that device's workspace.

import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import { devices, type DeviceRow } from '../schema/devices.ts';
import type { AnyDrizzleDb } from '../client.ts';

/** A device id is a uuid. Anything else names no device, and is not sent to Postgres. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Does this text have the shape of a device id? A chat id of another channel does not. */
export function isDeviceId(value: string): boolean {
  return UUID_RE.test(value);
}

/** The device `deviceId` of workspace `entityId`, or null: no such device THERE, or removed. */
export async function findWorkspaceDevice(
  db: AnyDrizzleDb,
  params: { entityId: string; deviceId: string },
): Promise<DeviceRow | null> {
  if (!isDeviceId(params.deviceId)) return null;
  const [row] = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.id, params.deviceId),
        eq(devices.entityId, params.entityId),
        isNull(devices.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The device whose key hashes to `tokenHash`, or null: no such key, or the device was removed. */
export async function findDeviceByTokenHash(
  db: AnyDrizzleDb,
  tokenHash: string,
): Promise<DeviceRow | null> {
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.tokenHash, tokenHash), isNull(devices.revokedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The device was just seen. Throttled: the row is written only when its last
 * stamp is older than `minIntervalMs` (0: always), so a device streaming audio
 * chunks does not write a row per chunk.
 */
export async function touchDevice(
  db: AnyDrizzleDb,
  deviceId: string,
  at: Date,
  minIntervalMs = 0,
): Promise<void> {
  const before = new Date(at.getTime() - minIntervalMs);
  await db
    .update(devices)
    .set({ lastSeenAt: at })
    .where(
      and(
        eq(devices.id, deviceId),
        minIntervalMs > 0
          ? or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, before))
          : undefined,
      ),
    );
}

/** The devices of a workspace, oldest first; removed ones are not listed. */
export async function listWorkspaceDevices(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<DeviceRow[]> {
  return db
    .select()
    .from(devices)
    .where(and(eq(devices.entityId, entityId), isNull(devices.revokedAt)))
    .orderBy(asc(devices.createdAt));
}

/** Renames a device of the workspace. Null: no such device there. */
export async function renameWorkspaceDevice(
  db: AnyDrizzleDb,
  params: { entityId: string; deviceId: string; name: string },
): Promise<DeviceRow | null> {
  if (!isDeviceId(params.deviceId)) return null;
  const [row] = await db
    .update(devices)
    .set({ name: params.name })
    .where(
      and(
        eq(devices.id, params.deviceId),
        eq(devices.entityId, params.entityId),
        isNull(devices.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Removes a device of the workspace: its key is dropped and refused from now
 * on. Null: no such device there (or already removed).
 */
export async function revokeWorkspaceDevice(
  db: AnyDrizzleDb,
  params: { entityId: string; deviceId: string; at: Date },
): Promise<DeviceRow | null> {
  if (!isDeviceId(params.deviceId)) return null;
  const [row] = await db
    .update(devices)
    .set({ revokedAt: params.at, tokenHash: null })
    .where(
      and(
        eq(devices.id, params.deviceId),
        eq(devices.entityId, params.entityId),
        isNull(devices.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}
