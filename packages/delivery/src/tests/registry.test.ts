// registry.test.ts — getAdapter resolution: registered channels resolve,
// unregistered ones fail loud (invariant #4 — no silent smart fallback).

import { describe, it, expect } from 'vitest';
import { getAdapter } from '../registry.ts';
import { telegramAdapter } from '../channels/telegram-adapter.ts';
import { discordAdapter } from '../channels/discord-adapter.ts';
import { DeliveryError } from '../errors.ts';
import type { ChannelKind } from '../channel-adapter.ts';

describe('getAdapter', () => {
  it('resolves the registered telegram adapter', () => {
    expect(getAdapter('telegram')).toBe(telegramAdapter);
  });

  it('resolves the registered discord adapter', () => {
    expect(getAdapter('discord')).toBe(discordAdapter);
  });

  it('throws channel_adapter_not_found for an unregistered channel', () => {
    expect(() => getAdapter('slack' as ChannelKind)).toThrow(DeliveryError);
    try {
      getAdapter('slack' as ChannelKind);
      expect.fail('expected getAdapter to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryError);
      expect((err as DeliveryError).code).toBe('channel_adapter_not_found');
    }
  });
});
