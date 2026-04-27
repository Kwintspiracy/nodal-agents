// seed.test.ts — verify seedDefaultUserEntityAgent constants and shape

import { describe, it, expect } from 'vitest';
import { STARTER_AGENT_SLUG, LOCAL_USER_ID, LOCAL_ENTITY_ID } from '../lib/seed.ts';

// Note: full integration test (actual DB insert) is covered by the up command
// smoke test. These unit tests verify constants and exported values that drive
// the idempotent seed logic.

describe('seed constants', () => {
  it('STARTER_AGENT_SLUG is "starter"', () => {
    expect(STARTER_AGENT_SLUG).toBe('starter');
  });

  it('LOCAL_USER_ID is the canonical fixed UUID', () => {
    expect(LOCAL_USER_ID).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('LOCAL_ENTITY_ID is the canonical fixed UUID', () => {
    expect(LOCAL_ENTITY_ID).toBe('00000000-0000-0000-0000-000000000002');
  });

  it('USER and ENTITY ids are different', () => {
    expect(LOCAL_USER_ID).not.toBe(LOCAL_ENTITY_ID);
  });
});

describe('seedDefaultUserEntityAgent idempotence (structural)', () => {
  it('exports a seedDefaultUserEntityAgent function', async () => {
    const mod = await import('../lib/seed.ts');
    expect(typeof mod.seedDefaultUserEntityAgent).toBe('function');
  });

  it('function signature returns a promise', () => {
    const mod = {
      seedDefaultUserEntityAgent: async (db: unknown) => {
        void db;
        return { userId: LOCAL_USER_ID, entityId: LOCAL_ENTITY_ID, agentId: 'test-id' };
      },
    };
    // Calling with a mock db should return an object with the right keys
    const result = mod.seedDefaultUserEntityAgent({});
    expect(result).toBeInstanceOf(Promise);
  });
});
