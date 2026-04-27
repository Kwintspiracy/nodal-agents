// @nodalai/adapter-google-drive — client factory tests

import { describe, it, expect } from 'vitest';
import { createDriveClient } from '../client.js';

describe('createDriveClient', () => {
  it('returns a drive_v3.Drive instance with a files resource', () => {
    const drive = createDriveClient('fake_access_token');
    expect(drive).toBeDefined();
    expect(typeof drive.files).toBe('object');
    expect(typeof drive.files.list).toBe('function');
    expect(typeof drive.files.get).toBe('function');
    expect(typeof drive.permissions).toBe('object');
  });

  it('creates distinct instances per call', () => {
    const a = createDriveClient('token_a');
    const b = createDriveClient('token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any string as accessToken (validation is API-side)', () => {
    expect(() => createDriveClient('any-token')).not.toThrow();
  });
});
