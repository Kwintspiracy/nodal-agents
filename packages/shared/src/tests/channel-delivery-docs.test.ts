// channel-delivery-docs.test.ts — exhaustiveness invariant for JOB_CHANNEL_DELIVERY_DOCS
// Every value in JOB_CHANNELS MUST have a non-empty entry in
// JOB_CHANNEL_DELIVERY_DOCS, otherwise an agent on that channel sees a generic
// fallback in its system prompt — the generic message exists for graceful
// degradation on truly unknown channels, not as an excuse for missing docs.

import { describe, it, expect } from 'vitest';
import { JOB_CHANNELS, JOB_CHANNEL_DELIVERY_DOCS } from '../enums';

describe('JOB_CHANNEL_DELIVERY_DOCS', () => {
  it('has a non-empty description for every JOB_CHANNELS value', () => {
    for (const channel of JOB_CHANNELS) {
      const description = JOB_CHANNEL_DELIVERY_DOCS[channel];
      expect(description, `missing description for channel "${channel}"`).toBeDefined();
      expect(description.length, `empty description for channel "${channel}"`).toBeGreaterThan(0);
    }
  });

  it('does not contain entries for unknown channels (no drift)', () => {
    const knownChannels = new Set<string>(JOB_CHANNELS);
    for (const docKey of Object.keys(JOB_CHANNEL_DELIVERY_DOCS)) {
      expect(knownChannels.has(docKey), `stray doc entry for channel "${docKey}"`).toBe(true);
    }
  });

  it("user-facing channels mention the user — they don't bury delivery semantics", () => {
    const userFacing: ReadonlyArray<keyof typeof JOB_CHANNEL_DELIVERY_DOCS> = [
      'telegram',
      'whatsapp',
      'slack',
      'discord',
    ];
    for (const ch of userFacing) {
      expect(
        JOB_CHANNEL_DELIVERY_DOCS[ch].toLowerCase(),
        `description for "${ch}" should mention user`,
      ).toContain('user');
    }
  });

  it('non-user-facing channels do not falsely promise user delivery', () => {
    // task-board jobs go to the parent orchestrator, not a user
    expect(JOB_CHANNEL_DELIVERY_DOCS['task-board'].toLowerCase()).not.toContain('to the user');
    // internal jobs have no user-facing delivery
    expect(JOB_CHANNEL_DELIVERY_DOCS['internal'].toLowerCase()).toContain('internal');
  });
});
