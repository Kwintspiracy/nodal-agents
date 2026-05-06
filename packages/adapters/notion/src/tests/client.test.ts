// @nodalai/adapter-notion — client factory tests

import { describe, it, expect } from 'vitest';
import { createNotionClient } from '../client';
import { Client } from '@notionhq/client';

describe('createNotionClient', () => {
  it('returns a @notionhq/client Client instance', () => {
    const client = createNotionClient('secret_test_key');
    expect(client).toBeInstanceOf(Client);
  });

  it('creates distinct instances per call', () => {
    const a = createNotionClient('secret_key_a');
    const b = createNotionClient('secret_key_b');
    expect(a).not.toBe(b);
  });

  it('accepts any non-empty string as apiKey (validation is API-side)', () => {
    // Should not throw — Notion validates the key at request time
    expect(() => createNotionClient('any-key')).not.toThrow();
  });
});
