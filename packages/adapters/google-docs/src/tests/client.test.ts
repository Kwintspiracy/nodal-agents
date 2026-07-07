// @nodal-agents/adapter-google-docs — client factory tests

import { describe, it, expect } from 'vitest';
import { createDocsClient } from '../client';

/** Minimal shape of the OAuth2Client fields this suite inspects. */
type InspectableAuth = {
  refreshHandler?: () => Promise<{ access_token: string; expiry_date: number }>;
};

function authOf(docs: ReturnType<typeof createDocsClient>): InspectableAuth {
  return (docs as unknown as { context: { _options: { auth: InspectableAuth } } }).context._options
    .auth;
}

describe('createDocsClient', () => {
  it('returns a docs_v1.Docs instance with a documents resource', () => {
    const docs = createDocsClient(async () => 'fake_access_token');
    expect(docs).toBeDefined();
    expect(typeof docs.documents).toBe('object');
    expect(typeof docs.documents.get).toBe('function');
    expect(typeof docs.documents.create).toBe('function');
    expect(typeof docs.documents.batchUpdate).toBe('function');
  });

  it('creates distinct instances per call', () => {
    const a = createDocsClient(async () => 'token_a');
    const b = createDocsClient(async () => 'token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any resolver returning a string (validation is API-side)', () => {
    expect(() => createDocsClient(async () => 'any-token')).not.toThrow();
  });

  it('exposes batchUpdate and get on documents', () => {
    const docs = createDocsClient(async () => 'token');
    expect(typeof docs.documents.batchUpdate).toBe('function');
    expect(typeof docs.documents.get).toBe('function');
    expect(typeof docs.documents.create).toBe('function');
  });

  // M-12: same fix as gmail's client — see that suite for the full rationale.
  it('registers a refreshHandler that re-invokes getAccessToken on every resolution', async () => {
    let calls = 0;
    const getAccessToken = async (): Promise<string> => {
      calls++;
      return `token-${calls}`;
    };
    const docs = createDocsClient(getAccessToken);
    const auth = authOf(docs);
    expect(typeof auth.refreshHandler).toBe('function');

    const first = await auth.refreshHandler!();
    expect(first.access_token).toBe('token-1');
    const second = await auth.refreshHandler!();
    expect(second.access_token).toBe('token-2');
    expect(calls).toBe(2);
    expect(first.expiry_date).toBeLessThan(Date.now());
  });

  // audit#2026-07-07 F2: gaxios defaults to timeout:0 (no timeout) — an
  // endpoint that accepts the connection but never responds would pend the
  // tool call forever. This asserts a bounded timeout is always configured.
  it('configures a 30s network timeout (no unbounded gaxios default)', () => {
    const docs = createDocsClient(async () => 'tok');
    const options = (docs as unknown as { context: { _options: { timeout?: number } } }).context
      ._options;
    expect(options.timeout).toBe(30_000);
  });
});
