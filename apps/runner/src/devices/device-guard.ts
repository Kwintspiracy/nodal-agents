// devices/device-guard.ts — who may act as a device, in ONE place (#945).
//
// Every device route (routes/devices.ts) asks this function, and only it,
// whether the caller may act as the device it names. Until #946 the answer is
// the guard `/api/events` uses today, `requireRunnerAuth` (server.ts), plus
// the device's workspace:
//   - a TRUSTED caller (local-trust, WORKER_SECRET) has resolved its
//     workspace itself and may act as any device;
//   - a session bearer acts only as a device of ITS workspace.
// A device of another workspace answers exactly like a device that does not
// exist (`device_not_found`): its existence is not guessable.
//
// #946 replaces this, and only this: a device presents its OWN token, scoped to
// the device routes and its conversation, and the worker secret is no longer
// accepted here. A device must never be required to hold the worker secret in
// the final design. Keeping the decision in this one function is what lets
// that swap happen in one place.
//
// The device is seen: each request through the guard stamps `last_seen_at`.

import type { Context } from 'hono';
import { findDeviceForGuard, touchDevice, type DeviceRow } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';

export type DeviceGuardOutcome =
  | { ok: true; device: DeviceRow }
  | { ok: false; response: Response };

export async function authorizeDevice(
  c: Context,
  deps: RunnerDeps,
  deviceId: string,
  now: Date = new Date(),
): Promise<DeviceGuardOutcome> {
  const device = await findDeviceForGuard(deps.db, deviceId);
  const mine =
    device !== null && (c.get('callerTrusted') || device.entityId === c.get('callerEntityId'));
  if (!device || !mine) {
    return { ok: false, response: c.json({ error: 'device_not_found' }, 404) };
  }
  await touchDevice(deps.db, device.id, now);
  return { ok: true, device: { ...device, lastSeenAt: now } };
}
