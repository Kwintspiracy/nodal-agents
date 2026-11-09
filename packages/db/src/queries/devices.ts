// queries/devices.ts — reading the devices of a workspace (#945).
//
// A device belongs to a workspace (entity). Every read here is SCOPED to one:
// a device id alone is never enough to reach a device, so a job or a caller
// of workspace X can never address a device of workspace Y, even by naming
// its id (the isolation test of the device stream rests on this).

import { and, eq } from 'drizzle-orm';
import { devices, type DeviceRow } from '../schema/devices.ts';
import type { AnyDrizzleDb } from '../client.ts';

/** A device id is a uuid. Anything else names no device, and is not sent to Postgres. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Does this text have the shape of a device id? A chat id of another channel does not. */
export function isDeviceId(value: string): boolean {
  return UUID_RE.test(value);
}

/** The device `deviceId` of workspace `entityId`, or null: no such device THERE. */
export async function findWorkspaceDevice(
  db: AnyDrizzleDb,
  params: { entityId: string; deviceId: string },
): Promise<DeviceRow | null> {
  if (!isDeviceId(params.deviceId)) return null;
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, params.deviceId), eq(devices.entityId, params.entityId)))
    .limit(1);
  return row ?? null;
}

/**
 * The device `deviceId`, whatever its workspace — for the device guard ONLY,
 * which then checks that workspace against the caller's. Every other reader
 * goes through `findWorkspaceDevice`.
 */
export async function findDeviceForGuard(
  db: AnyDrizzleDb,
  deviceId: string,
): Promise<DeviceRow | null> {
  if (!isDeviceId(deviceId)) return null;
  const [row] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  return row ?? null;
}

/** The device was just seen: a request went through the guard. */
export async function touchDevice(db: AnyDrizzleDb, deviceId: string, at: Date): Promise<void> {
  await db.update(devices).set({ lastSeenAt: at }).where(eq(devices.id, deviceId));
}
