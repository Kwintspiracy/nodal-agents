// @nodal-agents/adapter-gmail — client factory tests

import { describe, it, expect } from 'vitest';
import { createGmailClient } from '../client';

/** Minimal shape of the OAuth2Client fields this suite inspects. */
type InspectableAuth = {
  refreshHandler?: () => Promise<{ access_token: string; expiry_date: number }>;
};

function authOf(gmail: ReturnType<typeof createGmailClient>): InspectableAuth {
  return (gmail as unknown as { context: { _options: { auth: InspectableAuth } } }).context._options
    .auth;
}

describe('createGmailClient', () => {
  it('returns a gmail_v1.Gmail instance with a users resource', () => {
    const gmail = createGmailClient(async () => 'fake_access_token');
    expect(gmail).toBeDefined();
    expect(typeof gmail.users).toBe('object');
    expect(typeof gmail.users.messages).toBe('object');
    expect(typeof gmail.users.messages.list).toBe('function');
    expect(typeof gmail.users.messages.get).toBe('function');
    expect(typeof gmail.users.messages.send).toBe('function');
  });

  it('creates distinct instances per call', () => {
    const a = createGmailClient(async () => 'token_a');
    const b = createGmailClient(async () => 'token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any resolver returning a string (validation is API-side)', () => {
    expect(() => createGmailClient(async () => 'any-token')).not.toThrow();
  });

  it('exposes threads, labels, drafts and history resources', () => {
    const gmail = createGmailClient(async () => 'token');
    expect(typeof gmail.users.threads).toBe('object');
    expect(typeof gmail.users.labels).toBe('object');
    expect(typeof gmail.users.drafts).toBe('object');
    expect(typeof gmail.users.history).toBe('object');
  });

  // ─── M-12: token resolved lazily, not captured once ─────────────────────────
  // Before this fix, createGmailClient(accessToken: string) called
  // auth.setCredentials({ access_token: accessToken }) once — the SAME token
  // was reused for the client's entire lifetime, so a job outliving the ~1h
  // Google token TTL got a permanent gmail_unauthorized even though the DB
  // credential was still valid and refreshable. This test would have failed
  // before the fix: there was no getAccessToken parameter and no
  // refreshHandler to invoke — the token was fixed at construction.
  it('registers a refreshHandler that re-invokes getAccessToken on every resolution', async () => {
    let calls = 0;
    const getAccessToken = async (): Promise<string> => {
      calls++;
      return `token-${calls}`;
    };
    const gmail = createGmailClient(getAccessToken);
    const auth = authOf(gmail);
    expect(typeof auth.refreshHandler).toBe('function');

    const first = await auth.refreshHandler!();
    expect(first.access_token).toBe('token-1');
    expect(calls).toBe(1);

    // A second resolution must call the resolver AGAIN — proving the token
    // is re-read (and, via the runner's advisory-lock path, refreshable)
    // before every network call rather than cached for the client's lifetime.
    const second = await auth.refreshHandler!();
    expect(second.access_token).toBe('token-2');
    expect(calls).toBe(2);
  });

  it('refreshHandler reports an already-elapsed expiry so the next request re-resolves too', async () => {
    const gmail = createGmailClient(async () => 'tok');
    const auth = authOf(gmail);
    const { expiry_date } = await auth.refreshHandler!();
    expect(expiry_date).toBeLessThan(Date.now());
  });

  // audit#2026-07-07 F2: gaxios defaults to timeout:0 (no timeout) — an
  // endpoint that accepts the connection but never responds would pend the
  // tool call forever. This asserts a bounded timeout is always configured.
  it('configures a 30s network timeout (no unbounded gaxios default)', () => {
    const gmail = createGmailClient(async () => 'tok');
    const options = (gmail as unknown as { context: { _options: { timeout?: number } } }).context
      ._options;
    expect(options.timeout).toBe(30_000);
  });
});
