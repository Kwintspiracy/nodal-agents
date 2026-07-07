// @nodal-agents/adapter-google-calendar — client factory tests

import { describe, it, expect } from 'vitest';
import { createGoogleCalendarClient } from '../client';

/** Minimal shape of the OAuth2Client fields this suite inspects. */
type InspectableAuth = {
  refreshHandler?: () => Promise<{ access_token: string; expiry_date: number }>;
};

function authOf(calendar: ReturnType<typeof createGoogleCalendarClient>): InspectableAuth {
  return (calendar as unknown as { context: { _options: { auth: InspectableAuth } } }).context
    ._options.auth;
}

describe('createGoogleCalendarClient', () => {
  it('returns a calendar_v3.Calendar instance with an events resource', () => {
    const calendar = createGoogleCalendarClient(async () => 'fake_access_token');
    expect(calendar).toBeDefined();
    expect(typeof calendar.events).toBe('object');
    expect(typeof calendar.events.list).toBe('function');
    expect(typeof calendar.events.get).toBe('function');
    expect(typeof calendar.events.insert).toBe('function');
  });

  it('creates distinct instances per call', () => {
    const a = createGoogleCalendarClient(async () => 'token_a');
    const b = createGoogleCalendarClient(async () => 'token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any resolver returning a string (validation is API-side)', () => {
    expect(() => createGoogleCalendarClient(async () => 'any-token')).not.toThrow();
  });

  // M-12: same fix as gmail's client — see that suite for the full rationale.
  // Before the fix there was no getAccessToken parameter and no
  // refreshHandler; the token was captured once via setCredentials() and
  // reused for the client's entire lifetime.
  it('registers a refreshHandler that re-invokes getAccessToken on every resolution', async () => {
    let calls = 0;
    const getAccessToken = async (): Promise<string> => {
      calls++;
      return `token-${calls}`;
    };
    const calendar = createGoogleCalendarClient(getAccessToken);
    const auth = authOf(calendar);
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
    const calendar = createGoogleCalendarClient(async () => 'tok');
    const options = (calendar as unknown as { context: { _options: { timeout?: number } } }).context
      ._options;
    expect(options.timeout).toBe(30_000);
  });
});
