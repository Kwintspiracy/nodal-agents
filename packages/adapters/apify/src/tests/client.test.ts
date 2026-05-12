// @nodalai/adapter-apify — client factory tests

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApifyClient } from '../client.ts';
import { ApifyApiError, wrapApifyError, mapApifyHttpError } from '../errors.ts';

const FAKE_TOKEN = 'apify_api_fake_token_123';

describe('createApifyClient — instantiation', () => {
  it('creates a client without throwing', () => {
    expect(() => createApifyClient(FAKE_TOKEN)).not.toThrow();
  });

  it('creates distinct client instances per call', () => {
    const a = createApifyClient('token-a');
    const b = createApifyClient('token-b');
    expect(a).not.toBe(b);
  });

  it('returns an object with actor, run, dataset, datasets methods', () => {
    const client = createApifyClient(FAKE_TOKEN);
    expect(typeof client.actor).toBe('function');
    expect(typeof client.run).toBe('function');
    expect(typeof client.dataset).toBe('function');
    expect(typeof client.datasets).toBe('function');
  });
});

describe('ApifyApiError', () => {
  it('has correct name, code, status, and message', () => {
    const err = new ApifyApiError('apify_not_found', 'Run not found', 404);
    expect(err.name).toBe('ApifyApiError');
    expect(err.code).toBe('apify_not_found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Run not found');
    expect(err instanceof Error).toBe(true);
  });

  it('status is undefined when not provided', () => {
    const err = new ApifyApiError('apify_unknown', 'Unknown error');
    expect(err.status).toBeUndefined();
  });
});

describe('mapApifyHttpError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cases: [number, ApifyApiError['code']][] = [
    [401, 'apify_unauthorized'],
    [403, 'apify_forbidden'],
    [404, 'apify_not_found'],
    [422, 'apify_validation_error'],
    [429, 'apify_rate_limited'],
    [500, 'apify_transient'],
    [503, 'apify_transient'],
    [400, 'apify_client_error'],
    [409, 'apify_client_error'],
  ];

  for (const [status, expectedCode] of cases) {
    it(`maps status ${status} → ${expectedCode}`, () => {
      const err = mapApifyHttpError(status, 'test message');
      expect(err).toBeInstanceOf(ApifyApiError);
      expect(err.code).toBe(expectedCode);
      expect(err.status).toBe(status);
      expect(err.message).toBe('test message');
    });
  }
});

describe('wrapApifyError', () => {
  it('passes through ApifyApiError unchanged', () => {
    const original = new ApifyApiError('apify_forbidden', 'Forbidden', 403);
    expect(wrapApifyError(original)).toBe(original);
  });

  it('wraps SDK error with statusCode into ApifyApiError', () => {
    const sdkErr = { statusCode: 401, message: 'Unauthorized' };
    const wrapped = wrapApifyError(sdkErr);
    expect(wrapped).toBeInstanceOf(ApifyApiError);
    expect(wrapped.code).toBe('apify_unauthorized');
    expect(wrapped.status).toBe(401);
    expect(wrapped.message).toBe('Unauthorized');
  });

  it('wraps native Error without statusCode as apify_unknown', () => {
    const err = new Error('Network failure');
    const wrapped = wrapApifyError(err);
    expect(wrapped).toBeInstanceOf(ApifyApiError);
    expect(wrapped.code).toBe('apify_unknown');
    expect(wrapped.message).toBe('Network failure');
  });

  it('wraps string as apify_unknown', () => {
    const wrapped = wrapApifyError('some string error');
    expect(wrapped).toBeInstanceOf(ApifyApiError);
    expect(wrapped.code).toBe('apify_unknown');
  });

  it('wraps null as apify_unknown', () => {
    const wrapped = wrapApifyError(null);
    expect(wrapped).toBeInstanceOf(ApifyApiError);
    expect(wrapped.code).toBe('apify_unknown');
  });
});
