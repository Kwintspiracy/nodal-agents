// devices/device-guard.ts — who may act as a device, in ONE place (#945, #946).
//
// Every device route (routes/devices.ts) asks this function, and only it,
// whether the caller may act as the device it names. Since #946 the answer is
// the device's own key: the device gate (devices/device-auth.ts) has verified
// the token and set `callerDevice`; this function checks that the device the
// route names IS that one. The worker secret, a session, local trust never
// reach here — the gate refused them on a device's own route — and a device
// never acts as another: another device's id answers exactly like a device
// that does not exist (`device_not_found`), its existence is not guessable.
//
// The device is seen: the gate stamps `last_seen_at`.

import type { Context } from 'hono';
import { findWorkspaceDevice, type DeviceRow } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';

export type DeviceGuardOutcome =
  | { ok: true; device: DeviceRow }
  | { ok: false; response: Response };

export async function authorizeDevice(
  c: Context,
  deps: RunnerDeps,
  deviceId: string,
): Promise<DeviceGuardOutcome> {
  const caller = c.get('callerDevice');
  if (!caller) return { ok: false, response: c.json({ error: 'device_token_required' }, 401) };
  const device =
    caller.id === deviceId
      ? await findWorkspaceDevice(deps.db, { entityId: caller.entityId, deviceId })
      : null;
  if (!device) return { ok: false, response: c.json({ error: 'device_not_found' }, 404) };
  return { ok: true, device };
}
