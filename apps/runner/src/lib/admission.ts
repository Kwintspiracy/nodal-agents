// lib/admission.ts — the runner's door: may this request be served at all?
//
// ONE middleware, on every `/api/*` route, first of all, in every auth mode. It
// gathers the facts of the request and applies the one decision both servers
// share (`admitRequest`, packages/auth/src/lib/request-origin.ts):
//
//   - the Host names this machine;
//   - a request that carries an `Origin` (a browser sends it on behalf of a
//     page) proves who sends it with a credential in the request: the worker
//     secret, the install's API token in bearer-token mode, or the key of a
//     paired device on a route that takes one. The runner serves no page of
//     its own, so no Origin is ever enough by itself;
//   - a body has the media type the route takes: JSON, except the routes of
//     RUNNER_BODY_ROUTES.
//
// A request with no `Origin` is not sent on behalf of a page, and goes on to
// the guard its route has (the device gate, then `requireRunnerAuth`).
//
// `/webhooks/:slug/:secret` is not under `/api/*`: third-party services call it
// with any Host (a tunnel, a reverse proxy) and the body type they choose, and
// it is proved by the secret in its own path, checked by the route.
//
// A refusal answers a stable status and a machine-readable code (invariant #2),
// and the log names the route and the reason, never a header's value.

import type { Context, Next } from 'hono';
import {
  admitRequest,
  bodyTypesFor,
  hasRequestBody,
  type BodyRoute,
  type RequestProof,
} from '@nodal-agents/auth';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { verifyDeviceBearer } from '../devices/device-auth.ts';
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

/** The credential the request carries, verified; null when it carries none that holds. */
async function proofOf(
  c: Context,
  deps: Pick<RunnerDeps, 'db'>,
  runnerEnv: Pick<RunnerEnv, 'WORKER_SECRET' | 'AUTH_MODE' | 'BEARER_TOKEN'>,
): Promise<RequestProof | null> {
  const auth = c.req.header('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (bearer === null || bearer === '') return null;
  if (runnerEnv.WORKER_SECRET && isValidWorkerSecret(bearer, runnerEnv.WORKER_SECRET)) {
    return 'worker_secret';
  }
  if (
    runnerEnv.AUTH_MODE === 'bearer-token' &&
    runnerEnv.BEARER_TOKEN &&
    isValidWorkerSecret(bearer, runnerEnv.BEARER_TOKEN)
  ) {
    return 'api_token';
  }
  const device = await verifyDeviceBearer(deps, c);
  return device.kind === 'device' ? 'device_key' : null;
}

/** A path as it may appear in a log line: printable, bounded. */
function loggablePath(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200);
}

export function createAdmission(
  deps: Pick<RunnerDeps, 'db'>,
  runnerEnv: Pick<RunnerEnv, 'WORKER_SECRET' | 'AUTH_MODE' | 'BEARER_TOKEN' | 'APP_URL'>,
) {
  return async function admission(c: Context, next: Next): Promise<Response | void> {
    const origin = c.req.header('origin') ?? null;
    // The authority can arrive two ways: the `Host` header on HTTP/1.1, or the
    // `:authority` pseudo-header on HTTP/2 — where `Host` is absent entirely.
    // Hono always reflects whichever one it got into `c.req.url`, so that is the
    // reliable fallback; the header is preferred because it is the literal
    // bytes the client sent.
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    // A proof is only looked for where it decides something: a request sent on
    // behalf of a page.
    const proof = origin ? await proofOf(c, deps, runnerEnv) : null;
    const refusal = admitRequest({
      origin,
      host,
      appUrl: runnerEnv.APP_URL,
      proof,
      servesPages: false,
      contentType: c.req.header('content-type'),
      hasBody: hasRequestBody(c.req.raw.headers),
      bodyTypes: bodyTypesFor(c.req.method, c.req.path, RUNNER_BODY_ROUTES),
    });
    if (refusal) {
      console.warn(
        `[admission] refused ${c.req.method} ${loggablePath(c.req.path)}: ${refusal.reason}`,
      );
      return c.json({ error: refusal.reason }, refusal.status);
    }
    await next();
  };
}
