// devices/device-auth.ts — the device gate: where a device key is accepted, and where it is not (#946).
//
// ONE middleware, on every `/api/*` route, right after the origin check. It
// decides from the protocol's own route table (DEVICE_GESTURES,
// @nodal-agents/shared), never from a list of its own:
//
//   a device token (`Authorization: Bearer ndv_…`)
//     on a route of DEVICE_GESTURES   verified: the caller becomes that device
//                                     (`callerDevice`, its workspace as
//                                     `callerEntityId`, never trusted);
//                                     unknown or removed → 401
//     anywhere else                   403 `device_token_not_accepted` — the
//                                     owner's routes, the pairing routes, all
//
//   no device token
//     on a device's own route         401 `device_token_required`: the worker
//     (`/api/devices/:deviceId/…`)    secret, a session, local trust are
//                                     refused there — a device never needs
//                                     the worker secret
//     anywhere else                   passes, to the guard the route has
//                                     (`requireRunnerAuth`, server.ts)
//
// What a device may then reach is narrower than its workspace: its own device
// routes (devices/device-guard.ts) and its own conversations
// (devices/device-scope.ts).
//
// Its key is checked on EVERY request (a hash lookup), so a removed device is
// refused on its very next one. What it holds open is cut at once: every
// streamed answer it reads is registered (devices/device-streams.ts), and
// removing it cuts them.
//
// `last_seen_at` is stamped on use, at most once a minute, and when a stream
// of the device closes.

import type { Context, Next } from 'hono';
import { findDeviceByTokenHash, touchDevice } from '@nodal-agents/db';
import {
  DEVICE_TOKEN_PREFIX,
  DEVICE_TOKEN_RE,
  isDeviceOwnRoute,
  isDeviceTokenRoute,
} from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { hashDeviceSecret } from './device-secrets.ts';
import { registerDeviceStream } from './device-streams.ts';

/** `last_seen_at` is written at most this often while a device keeps calling. */
export const DEVICE_SEEN_THROTTLE_MS = 60_000;

function bearerOf(c: Context): string | null {
  const auth = c.req.header('authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

export function createDeviceGate(deps: Pick<RunnerDeps, 'db'>) {
  return async function deviceGate(c: Context, next: Next): Promise<Response | void> {
    const method = c.req.method;
    const path = c.req.path;
    const bearer = bearerOf(c);

    if (bearer === null || !bearer.startsWith(DEVICE_TOKEN_PREFIX)) {
      if (isDeviceOwnRoute(method, path)) {
        return c.json({ error: 'device_token_required' }, 401);
      }
      await next();
      return;
    }

    if (!isDeviceTokenRoute(method, path)) {
      return c.json({ error: 'device_token_not_accepted' }, 403);
    }
    const device = DEVICE_TOKEN_RE.test(bearer)
      ? await findDeviceByTokenHash(deps.db, hashDeviceSecret(bearer))
      : null;
    if (!device) return c.json({ error: 'device_token_invalid' }, 401);

    c.set('callerDevice', { id: device.id, entityId: device.entityId });
    c.set('callerTrusted', false);
    c.set('callerEntityId', device.entityId);
    c.set('callerUserId', undefined);
    await touchDevice(deps.db, device.id, new Date(), DEVICE_SEEN_THROTTLE_MS);

    await next();

    const res = c.res;
    if (res.body && (res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      c.res = cuttable(res, (cut) => {
        const unregister = registerDeviceStream(device.id, cut);
        return () => {
          unregister();
          // Seen until now: the stream it held just closed.
          void touchDevice(deps.db, device.id, new Date()).catch((err: unknown) => {
            console.warn(`[device-gate] last_seen_at of ${device.id} not written:`, err);
          });
        };
      });
    }
  };
}

/**
 * The same streamed answer, which the device registry can cut. Cutting
 * cancels the route's own stream (its `cancel` unsubscribes it, as when the
 * reader leaves), and the device's reader sees the end of the stream.
 */
function cuttable(res: Response, register: (cut: () => void) => () => void): Response {
  const source = res.body!.getReader();
  let finished = false;
  let unregister: () => void = () => {};
  const finish = (): void => {
    if (finished) return;
    finished = true;
    unregister();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await source.read();
      } catch (err) {
        finish();
        controller.error(err);
        return;
      }
      if (chunk.done) {
        finish();
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      finish();
      return source.cancel(reason);
    },
  });
  unregister = register(() => {
    void source.cancel('device_removed').catch(() => {});
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
