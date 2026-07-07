// @nodal-agents/adapter-google-sheets — client factory tests

import { describe, it, expect } from 'vitest';
import { createSheetsClient } from '../client';

/** Minimal shape of the OAuth2Client fields this suite inspects. */
type InspectableAuth = {
  refreshHandler?: () => Promise<{ access_token: string; expiry_date: number }>;
};

function authOf(sheets: ReturnType<typeof createSheetsClient>): InspectableAuth {
  return (sheets as unknown as { context: { _options: { auth: InspectableAuth } } }).context
    ._options.auth;
}

describe('createSheetsClient', () => {
  it('returns a sheets_v4.Sheets instance with a spreadsheets resource', () => {
    const sheets = createSheetsClient(async () => 'fake_access_token');
    expect(sheets).toBeDefined();
    expect(typeof sheets.spreadsheets).toBe('object');
    expect(typeof sheets.spreadsheets.values).toBe('object');
    expect(typeof sheets.spreadsheets.values.get).toBe('function');
    expect(typeof sheets.spreadsheets.values.update).toBe('function');
    expect(typeof sheets.spreadsheets.values.append).toBe('function');
  });

  it('creates distinct instances per call', () => {
    const a = createSheetsClient(async () => 'token_a');
    const b = createSheetsClient(async () => 'token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any resolver returning a string (validation is API-side)', () => {
    expect(() => createSheetsClient(async () => 'any-token')).not.toThrow();
  });

  it('exposes batchUpdate and get on spreadsheets', () => {
    const sheets = createSheetsClient(async () => 'token');
    expect(typeof sheets.spreadsheets.batchUpdate).toBe('function');
    expect(typeof sheets.spreadsheets.get).toBe('function');
    expect(typeof sheets.spreadsheets.create).toBe('function');
  });

  // M-12: same fix as gmail's client — see that suite for the full rationale.
  it('registers a refreshHandler that re-invokes getAccessToken on every resolution', async () => {
    let calls = 0;
    const getAccessToken = async (): Promise<string> => {
      calls++;
      return `token-${calls}`;
    };
    const sheets = createSheetsClient(getAccessToken);
    const auth = authOf(sheets);
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
    const sheets = createSheetsClient(async () => 'tok');
    const options = (sheets as unknown as { context: { _options: { timeout?: number } } }).context
      ._options;
    expect(options.timeout).toBe(30_000);
  });
});
