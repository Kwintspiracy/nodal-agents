// lib/admission.ts — the runner's door: may this request be served, and who sends it?
//
// ONE middleware, on every `/api/*` route, first of all, in every auth mode. It
// gathers the facts of the request and applies the one decision both servers
// share (`admitRequest`, packages/auth/src/lib/request-origin.ts):
//
//   - the Host names this machine;
//   - a request that carries an `Origin` (a browser sends it on behalf of a
//     page) proves who sends it with a credential in the request. The runner
//     serves no page of its own, so no Origin is ever enough by itself;
//   - EVERY request proves who sends it, in every auth mode, the default one
//     included:
//       the worker secret          the install's secret (config.json, which
//                                  only the owner's account can read): the
//                                  dashboard's server side, the CLI, the MCP
//                                  server, the bench, the owner's scripts
//       the API token              in bearer-token mode, an API client
//       a paired device's key      on the routes of DEVICE_GESTURES
//     The device pairing gestures (`isDevicePairingRoute`) are the only routes
//     out of this rule: a device calls them before it holds a key, and what
//     proves them is the pairing itself (the owner confirms it from a caller
//     that proved who it is);
//   - a body has the media type the route takes: JSON, except the routes of
//     RUNNER_BODY_ROUTES.
//
// The caller it proved is the caller the routes read (`callerTrusted`,
// `callerEntityId`, `callerUserId`, lib/runner-auth-context.ts): the worker
// secret is a trusted caller, the API token is its session's workspace, a
// device is stamped by the device gate that follows (devices/device-auth.ts).
// There is no other auth gate: no route can be added outside this one.
//
// `/webhooks/:slug/:secret` is not under `/api/*`: third-party services call it
// with any Host (a tunnel, a reverse proxy) and the body type they choose, and
// it is proved by the secret in its own path, checked by the route.
//
// A refusal answers a stable status and a machine-readable code (invariant #2),
// and the log names the route and the reason, never a header's value.

import type { Context, Next } from 'hono';
import {
  AuthError,
  admitRequest,
  bodyTypesFor,
  hasRequestBody,
  type AuthSession,
  type BodyRoute,
} from '@nodal-agents/auth';
import { isDevicePairingRoute } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { verifyDeviceBearer, type DeviceBearer } from '../devices/device-auth.ts';
import { isValidWorkerSecret } from './worker-secret.ts';

/** The runner's routes that take a body of another type than JSON. */
export const RUNNER_BODY_ROUTES: readonly BodyRoute[] = [
  // The audio of a spoken turn, in raw chunks (DEVICE_GESTURES `say`).
  {
    method: 'POST',
    path: '/api/voice/turns/:turnId/chunks/:seq',
    types: ['application/octet-stream'],
  },
];

/** What the request's credential turned out to be, once verified. */
type Credential =
  | { proof: 'worker_secret' }
  | { proof: 'api_token'; session: AuthSession }
  | { proof: 'device_key' }
  | { proof: null; device: Extract<DeviceBearer, { kind: 'refused' }> | null };

async function credentialOf(
  c: Context,
  deps: Pick<RunnerDeps, 'db' | 'authProvider'>,
  runnerEnv: Pick<RunnerEnv, 'WORKER_SECRET' | 'AUTH_MODE'>,
): Promise<Credential> {
  const auth = c.req.header('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (
    bearer !== '' &&
    runnerEnv.WORKER_SECRET &&
    isValidWorkerSecret(bearer, runnerEnv.WORKER_SECRET)
  ) {
    return { proof: 'worker_secret' };
  }
  const device = bearer === '' ? null : await verifyDeviceBearer(deps, c);
  if (device?.kind === 'device') return { proof: 'device_key' };
  if (device?.kind === 'refused') return { proof: null, device };
  // The bearer-token mode's own proof is what its auth provider accepts (the
  // API token), and the session it returns says which workspace the caller is.
  if (runnerEnv.AUTH_MODE === 'bearer-token') {
    try {
      const session = await deps.authProvider.getSession(c.req.raw);
      // A session with no workspace is authorized for nothing: the routes
      // scope an untrusted caller by its `callerEntityId`.
      if (session && session.entityId) return { proof: 'api_token', session };
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
    }
  }
  return { proof: null, device: null };
}

/** A path as it may appear in a log line: printable, bounded. */
function loggablePath(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200);
}

export function createAdmission(
  deps: Pick<RunnerDeps, 'db' | 'authProvider'>,
  runnerEnv: Pick<RunnerEnv, 'WORKER_SECRET' | 'AUTH_MODE' | 'APP_URL'>,
) {
  return async function admission(c: Context, next: Next): Promise<Response | void> {
    const origin = c.req.header('origin') ?? null;
    // The authority can arrive two ways: the `Host` header on HTTP/1.1, or the
    // `:authority` pseudo-header on HTTP/2 — where `Host` is absent entirely.
    // Hono always reflects whichever one it got into `c.req.url`, so that is the
    // reliable fallback; the header is preferred because it is the literal
    // bytes the client sent.
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const credential = await credentialOf(c, deps, runnerEnv);
    const refusal = admitRequest({
      origin,
      host,
      appUrl: runnerEnv.APP_URL,
      proof: credential.proof,
      proofPresented: (c.req.header('authorization') ?? '') !== '',
      proofRequired: !isDevicePairingRoute(c.req.method, c.req.path),
      servesPages: false,
      contentType: c.req.header('content-type'),
      hasBody: hasRequestBody(c.req.raw.headers),
      bodyTypes: bodyTypesFor(c.req.method, c.req.path, RUNNER_BODY_ROUTES),
    });
    if (refusal) {
      console.warn(
        `[admission] refused ${c.req.method} ${loggablePath(c.req.path)}: ${refusal.reason}`,
      );
      // A device key that does not hold here says why in the device's own
      // words (an unknown key, or a route that takes none).
      if (refusal.reason === 'proof_invalid' && credential.proof === null && credential.device) {
        return c.json({ error: credential.device.error }, credential.device.status);
      }
      return c.json({ error: refusal.reason }, refusal.status);
    }
    if (credential.proof === 'worker_secret') {
      c.set('callerTrusted', true);
    } else if (credential.proof === 'api_token') {
      c.set('callerTrusted', false);
      c.set('callerEntityId', credential.session.entityId);
      c.set('callerUserId', credential.session.userId);
    } else {
      // A device (the device gate stamps which one next), or a pairing
      // gesture: never trusted.
      c.set('callerTrusted', false);
    }
    await next();
  };
}
