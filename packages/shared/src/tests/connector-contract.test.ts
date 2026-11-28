// connector-contract.test.ts — a connector call's failure in one closed set,
// classified by protocol: the same answer, from any provider, lands in the
// same kind; the provider's retry time is read, never invented.

import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_ERROR_KINDS,
  ConnectionUnavailableError,
  callFailure,
  classifyCallFailure,
  connectionState,
  neverSent,
  retryAfterOf,
  type ProviderAnswer,
} from '../connection-state';
import {
  ConnectorCallError,
  connectorFailureMessage,
  decodeCursor,
  encodeResumeCursor,
  isConnectorList,
} from '../connector-contract';

const now = new Date('2026-11-28T12:00:00Z');

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ProviderAnswer {
  return { status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

describe('a connector failure is one kind of a closed set, by protocol @cap:connecter-un-service/moteur', () => {
  it('a pace refusal is rate_limited whatever status carries it', () => {
    // AIP-193, JSON v1 form, as Google's APIs answer a per-user rate refusal.
    const google403 = answer(403, {
      error: {
        code: 403,
        errors: [{ reason: 'userRateLimitExceeded' }],
        status: 'PERMISSION_DENIED',
      },
    });
    // AIP-193, its google.rpc.Status form.
    const rpc429 = answer(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    // Any provider: a 4xx that names when to try again.
    const header503 = answer(403, 'slow down', { 'retry-after': '30' });
    expect(classifyCallFailure(new Error('x'), google403, now)).toMatchObject({
      kind: 'rate_limited',
      providerCode: 'userRateLimitExceeded',
      retryAfter: null,
      connection: null,
    });
    expect(classifyCallFailure(new Error('x'), rpc429, now).kind).toBe('rate_limited');
    expect(classifyCallFailure(new Error('x'), header503, now)).toMatchObject({
      kind: 'rate_limited',
      retryAfter: new Date(now.getTime() + 30_000),
    });
  });

  it('a 403 without a pace reason is not_permitted, not rate_limited', () => {
    const scope = answer(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } });
    expect(classifyCallFailure(new Error('x'), scope, now).kind).toBe('not_permitted');
  });

  it.each([
    [401, 'reauth_required'],
    [404, 'not_found'],
    [410, 'not_found'],
    [400, 'invalid_input'],
    [409, 'invalid_input'],
    [413, 'invalid_input'],
    [422, 'invalid_input'],
    [408, 'temporary'],
    [500, 'temporary'],
    [503, 'temporary'],
    [418, 'failed'],
  ] as const)('HTTP %i is %s', (status, kind) => {
    expect(classifyCallFailure(new Error('x'), answer(status, ''), now).kind).toBe(kind);
  });

  it('the connection part is what connection-state reads in the same answer', () => {
    expect(classifyCallFailure(new Error('x'), answer(401, ''), now).connection).toMatchObject({
      state: 'needs_reauth',
      cause: 'grant_refused',
    });
    expect(classifyCallFailure(new Error('x'), answer(502, ''), now).connection).toMatchObject({
      state: 'unreachable',
    });
    expect(classifyCallFailure(new Error('x'), answer(404, ''), now).connection).toBeNull();
  });

  it('without an answer, the status the error carries is read under any SDK name', () => {
    for (const err of [
      { status: 404 },
      { statusCode: 404 },
      { code: 404 },
      { response: { status: 404 } },
    ]) {
      expect(classifyCallFailure(Object.assign(new Error('x'), err), null, now).kind).toBe(
        'not_found',
      );
    }
  });

  it('a transport failure is temporary; an unknown error is failed, never guessed', () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(classifyCallFailure(reset, null, now).kind).toBe('temporary');
    expect(classifyCallFailure(new TypeError('x is undefined'), null, now).kind).toBe('failed');
  });

  it('a connection already known unusable keeps its state', () => {
    const state = connectionState('needs_reauth', 'credential_removed', null, now);
    const err = new ConnectionUnavailableError({ kind: 'credential', id: 'c1' }, state);
    expect(classifyCallFailure(err, null, now)).toMatchObject({
      kind: 'reauth_required',
      connection: state,
    });
  });

  it('every kind is in the closed set', () => {
    expect(CONNECTOR_ERROR_KINDS).toEqual([
      'reauth_required',
      'not_permitted',
      'not_found',
      'rate_limited',
      'temporary',
      'invalid_input',
      'failed',
    ]);
  });
});

describe('Retry-After (RFC 9110 §10.2.3) is read, never invented', () => {
  it('seconds and an HTTP date', () => {
    expect(retryAfterOf({ 'retry-after': '120' }, now)).toEqual(new Date(now.getTime() + 120_000));
    expect(retryAfterOf({ 'retry-after': 'Sat, 28 Nov 2026 12:05:00 GMT' }, now)).toEqual(
      new Date('2026-11-28T12:05:00Z'),
    );
    expect(retryAfterOf({ 'retry-after': 'soon' }, now)).toBeNull();
    expect(retryAfterOf({}, now)).toBeNull();
  });
});

describe('whether a failed request may have reached the provider', () => {
  it('a connection never made did not; a reset or an abort may have', () => {
    expect(neverSent(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(
      neverSent(
        new Error('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }),
      ),
    ).toBe(true);
    expect(neverSent(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false);
    expect(neverSent(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

describe('the contract error carries its class for every later reader', () => {
  it('callFailure reads the connection from it instead of classifying again', () => {
    const failure = classifyCallFailure(
      new Error('x'),
      answer(429, '', { 'retry-after': '5' }),
      now,
    );
    const err = new ConnectorCallError(
      failure,
      connectorFailureMessage(failure.kind, 'busy', {
        retryAfter: failure.retryAfter,
        boundMs: null,
      }),
      null,
    );
    // A 429 carries a `status`, but it says nothing of the grant.
    expect(err.status).toBe(429);
    expect(callFailure(err, now)).toBeNull();
    expect(err.message).toBe(
      `rate_limited: busy The provider asks to try again after ${failure.retryAfter!.toISOString()}.`,
    );
    expect(classifyCallFailure(err, answer(500, ''), now)).toBe(failure);
  });
});

describe('the list shape and its resume cursor', () => {
  it('recognises the shape', () => {
    expect(isConnectorList({ items: [], next: null, truncated: null })).toBe(true);
    expect(isConnectorList({ items: [], next: 'n', truncated: null, total: 4 })).toBe(true);
    expect(isConnectorList({ files: [], next: null, truncated: null })).toBe(false);
    expect(isConnectorList({ items: [], next: null, truncated: null, total: '4' })).toBe(false);
  });

  it('a resume cursor round-trips; a provider cursor passes through', () => {
    const c = encodeResumeCursor({ provider: 'tok', skip: 7 });
    expect(decodeCursor(c)).toEqual({ provider: 'tok', skip: 7 });
    expect(decodeCursor(encodeResumeCursor({ provider: null, skip: 2 }))).toEqual({
      provider: null,
      skip: 2,
    });
    expect(decodeCursor('provider-token')).toEqual({ provider: 'provider-token', skip: 0 });
    expect(decodeCursor(undefined)).toEqual({ provider: null, skip: 0 });
    expect(() => decodeCursor('nodal-resume:bm90IGpzb24')).toThrow(ConnectorCallError);
  });
});
