// @nodal-agents/adapter-google-drive — client factory tests

import { describe, it, expect } from 'vitest';
import { createDriveClient } from '../client';

/** Minimal shape of the OAuth2Client fields this suite inspects. */
type InspectableAuth = {
  refreshHandler?: () => Promise<{ access_token: string; expiry_date: number }>;
};

function authOf(drive: ReturnType<typeof createDriveClient>): InspectableAuth {
  return (drive as unknown as { context: { _options: { auth: InspectableAuth } } }).context
    ._options.auth;
}

describe('createDriveClient', () => {
  it('returns a drive_v3.Drive instance with a files resource', () => {
    const drive = createDriveClient(async () => 'fake_access_token');
    expect(drive).toBeDefined();
    expect(typeof drive.files).toBe('object');
    expect(typeof drive.files.list).toBe('function');
    expect(typeof drive.files.get).toBe('function');
    expect(typeof drive.permissions).toBe('object');
  });

  it('creates distinct instances per call', () => {
    const a = createDriveClient(async () => 'token_a');
    const b = createDriveClient(async () => 'token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any resolver returning a string (validation is API-side)', () => {
    expect(() => createDriveClient(async () => 'any-token')).not.toThrow();
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
    const drive = createDriveClient(getAccessToken);
    const auth = authOf(drive);
    expect(typeof auth.refreshHandler).toBe('function');

    const first = await auth.refreshHandler!();
    expect(first.access_token).toBe('token-1');
    const second = await auth.refreshHandler!();
    expect(second.access_token).toBe('token-2');
    expect(calls).toBe(2);
    expect(first.expiry_date).toBeLessThan(Date.now());
  });
});
