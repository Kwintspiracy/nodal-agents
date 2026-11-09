'use server';

// device-actions.ts — Settings → Devices (#946): the requests of devices that
// want to pair, and the devices paired with this workspace.
//
// EVERYTHING goes through the runner's owner routes (DEVICE_OWNER_ROUTES,
// @nodal-agents/shared), never straight to the database: confirming opens the
// device's conversation with the root agent through the runner's own path,
// removing a device cuts the streams it holds open in the runner, and
// "Connected" is a fact only the runner knows. The web calls with the worker
// secret and the workspace of the session; every answer is checked against
// the protocol's schemas, and an answer of another shape is an error said,
// never a half-filled screen (invariant #4).
//
// Only the workspace's OWNER pairs, renames or removes a device: a device's
// key lets it talk with the workspace's agents.

import 'server-only';
import { headers } from 'next/headers';
import { z } from 'zod';
import { requireAuth } from '@nodal-agents/auth';
import { eq, entities } from '@nodal-agents/db';
import {
  DevicePairingViewSchema,
  PairedDeviceViewSchema,
  type DevicePairingView,
  type PairedDeviceView,
} from '@nodal-agents/shared';
import { env } from './env.ts';
import { applyActiveEntity, getAuthProvider, getDb } from './server.ts';

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

async function ownerRefusal(session: {
  userId: string;
  entityId: string;
}): Promise<ActionResult<never> | null> {
  const [row] = await getDb()
    .select({ userId: entities.userId })
    .from(entities)
    .where(eq(entities.id, session.entityId));
  if (!row) return fail('not_found', 'Workspace not found');
  if (row.userId !== session.userId) {
    return fail('forbidden', 'Only the workspace owner can manage devices.');
  }
  return null;
}

const RUNNER_TIMEOUT_MS = 5_000;

/** What a refusal of the runner means for the person, in a few words. */
const REFUSALS: Record<string, string> = {
  pairing_not_pending: 'This request is no longer waiting.',
  pairing_not_expired: 'This request is still waiting.',
  no_root_agent: 'Set a root agent first. A device talks with it.',
  device_not_found: 'This device is no longer paired.',
  forbidden: 'This workspace is not yours.',
  multi_user_host:
    'Only a single-user install can pair a device, and this one has several accounts.',
};

/** One call to an owner route of the runner, its answer checked by `schema`. */
async function runner<T>(
  label: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<ActionResult<T>> {
  if (!env.WORKER_SECRET) {
    console.error(`[${label}] WORKER_SECRET missing`);
    return fail('config_error', 'Runner secret not configured');
  }
  let res: Response;
  try {
    res = await fetch(`${env.RUNNER_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.WORKER_SECRET}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    console.error(`[${label}] fetch failed`, err);
    return fail('runner_unreachable', 'The runner did not answer.');
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return fail('runner_contract', `The runner answered ${res.status} without a readable body.`);
  }
  if (!res.ok) {
    const code =
      typeof json === 'object' && json !== null && 'error' in json
        ? String((json as { error: unknown }).error)
        : `http_${res.status}`;
    return fail(code, REFUSALS[code] ?? `The runner refused (${code}).`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`[${label}] unexpected answer`, parsed.error.issues);
    return fail('runner_contract', 'The runner answered in an unexpected shape.');
  }
  return ok(parsed.data);
}

const q = (entityId: string) => `entityId=${encodeURIComponent(entityId)}`;
const Id = z.string().guid();

export interface DevicesView {
  pairings: DevicePairingView[];
  /**
   * Why the requests are not shown, when the install refuses them: they belong
   * to no workspace, and only a single-user install acts on them
   * (`multi_user_host`). Null: they are shown.
   */
  pairingsRefused: string | null;
  devices: PairedDeviceView[];
  isOwner: boolean;
}

/** The requests waiting (every workspace's, since a request belongs to none yet) and this workspace's devices. */
export async function getDevicesAction(): Promise<ActionResult<DevicesView>> {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (err) {
    console.error('[getDevicesAction] session', err);
    return fail('auth_error', 'Not signed in');
  }
  const [pairings, devices, refusal] = await Promise.all([
    runner(
      'getDevicesAction',
      'GET',
      `/api/device-pairings?${q(session.entityId)}`,
      z.object({ pairings: z.array(DevicePairingViewSchema) }),
    ),
    runner(
      'getDevicesAction',
      'GET',
      `/api/workspace-devices?${q(session.entityId)}`,
      z.object({ devices: z.array(PairedDeviceViewSchema) }),
    ),
    ownerRefusal(session),
  ]);
  if (!pairings.ok && pairings.code !== 'multi_user_host') return pairings;
  if (!devices.ok) return devices;
  return ok({
    pairings: pairings.ok ? pairings.data.pairings : [],
    pairingsRefused: pairings.ok ? null : pairings.message,
    devices: devices.data.devices,
    isOwner: refusal === null,
  });
}

/** How many requests wait right now: the red counter on "Devices". */
export async function countPendingPairingsAction(): Promise<ActionResult<number>> {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch {
    return fail('auth_error', 'Not signed in');
  }
  const res = await runner(
    'countPendingPairingsAction',
    'GET',
    `/api/device-pairings?${q(session.entityId)}`,
    z.object({ pairings: z.array(DevicePairingViewSchema) }),
  );
  // A multi-user install acts on no request (`multi_user_host`): none waits
  // for this person, and the pill says 0 rather than a count it last saw.
  if (!res.ok) return res.code === 'multi_user_host' ? ok(0) : res;
  return ok(res.data.pairings.filter((p) => p.state === 'pending').length);
}

/** The owner's gesture on a request or a device: session, owner, then the runner. */
async function ownerGesture<T>(
  label: string,
  id: string,
  call: (entityId: string, id: string) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  if (!Id.safeParse(id).success) return fail('validation_failed', 'Invalid id');
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (err) {
    console.error(`[${label}] session`, err);
    return fail('auth_error', 'Not signed in');
  }
  const refusal = await ownerRefusal(session);
  if (refusal) return refusal;
  return call(session.entityId, id);
}

export async function confirmDevicePairingAction(
  pairingId: string,
): Promise<ActionResult<{ deviceId: string; conversationId: string }>> {
  return ownerGesture('confirmDevicePairingAction', pairingId, (entityId, id) =>
    runner(
      'confirmDevicePairingAction',
      'POST',
      `/api/device-pairings/${id}/confirm`,
      z.object({ deviceId: z.string().guid(), conversationId: z.string().guid() }),
      { entityId },
    ),
  );
}

export async function refuseDevicePairingAction(pairingId: string): Promise<ActionResult> {
  const res = await ownerGesture('refuseDevicePairingAction', pairingId, (entityId, id) =>
    runner(
      'refuseDevicePairingAction',
      'POST',
      `/api/device-pairings/${id}/refuse`,
      z.object({ refused: z.literal(true) }),
      { entityId },
    ),
  );
  return res.ok ? ok(undefined) : res;
}

export async function dismissDevicePairingAction(pairingId: string): Promise<ActionResult> {
  const res = await ownerGesture('dismissDevicePairingAction', pairingId, (entityId, id) =>
    runner(
      'dismissDevicePairingAction',
      'DELETE',
      `/api/device-pairings/${id}?${q(entityId)}`,
      z.object({ dismissed: z.literal(true) }),
    ),
  );
  return res.ok ? ok(undefined) : res;
}

export async function renameDeviceAction(
  deviceId: string,
  name: string,
): Promise<ActionResult<PairedDeviceView>> {
  const res = await ownerGesture('renameDeviceAction', deviceId, (entityId, id) =>
    runner(
      'renameDeviceAction',
      'PATCH',
      `/api/workspace-devices/${id}`,
      z.object({ device: PairedDeviceViewSchema }),
      { entityId, name },
    ),
  );
  return res.ok ? ok(res.data.device) : res;
}

export async function removeDeviceAction(deviceId: string): Promise<ActionResult> {
  const res = await ownerGesture('removeDeviceAction', deviceId, (entityId, id) =>
    runner(
      'removeDeviceAction',
      'DELETE',
      `/api/workspace-devices/${id}?${q(entityId)}`,
      z.object({ removed: z.literal(true) }),
    ),
  );
  return res.ok ? ok(undefined) : res;
}
