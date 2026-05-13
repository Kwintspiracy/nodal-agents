// @nodal-agents/adapter-gmail — client factory tests

import { describe, it, expect } from 'vitest';
import { createGmailClient } from '../client';

describe('createGmailClient', () => {
  it('returns a gmail_v1.Gmail instance with a users resource', () => {
    const gmail = createGmailClient('fake_access_token');
    expect(gmail).toBeDefined();
    expect(typeof gmail.users).toBe('object');
    expect(typeof gmail.users.messages).toBe('object');
    expect(typeof gmail.users.messages.list).toBe('function');
    expect(typeof gmail.users.messages.get).toBe('function');
    expect(typeof gmail.users.messages.send).toBe('function');
  });

  it('creates distinct instances per call', () => {
    const a = createGmailClient('token_a');
    const b = createGmailClient('token_b');
    expect(a).not.toBe(b);
  });

  it('accepts any string as accessToken (validation is API-side)', () => {
    expect(() => createGmailClient('any-token')).not.toThrow();
  });

  it('exposes threads, labels, drafts and history resources', () => {
    const gmail = createGmailClient('token');
    expect(typeof gmail.users.threads).toBe('object');
    expect(typeof gmail.users.labels).toBe('object');
    expect(typeof gmail.users.drafts).toBe('object');
    expect(typeof gmail.users.history).toBe('object');
  });
});
