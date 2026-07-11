// registry.test.ts — getAdapter resolution: registered channels resolve,
// unregistered ones fail loud (invariant #4 — no silent smart fallback).

import { describe, it, expect } from 'vitest';
import { getAdapter } from '../registry.ts';
import { telegramAdapter } from '../channels/telegram-adapter.ts';
import { discordAdapter } from '../channels/discord-adapter.ts';
import { slackAdapter } from '../channels/slack-adapter.ts';
import { whatsappAdapter } from '../channels/whatsapp-adapter.ts';
import { DeliveryError } from '../errors.ts';
import type { ChannelKind } from '../channel-adapter.ts';

describe('getAdapter', () => {
  it('resolves the registered telegram adapter', () => {
    expect(getAdapter('telegram')).toBe(telegramAdapter);
  });

  it('resolves the registered discord adapter', () => {
    expect(getAdapter('discord')).toBe(discordAdapter);
  });

  it('resolves the registered slack adapter', () => {
    expect(getAdapter('slack')).toBe(slackAdapter);
  });

  it('resolves the registered whatsapp adapter', () => {
    expect(getAdapter('whatsapp')).toBe(whatsappAdapter);
  });

  it('throws channel_adapter_not_found for an unregistered channel', () => {
    // Every real ChannelKind is registered today — this exercises the
    // fail-loud path via a value outside the union (invariant #4).
    expect(() => getAdapter('irc' as ChannelKind)).toThrow(DeliveryError);
    try {
      getAdapter('irc' as ChannelKind);
      expect.fail('expected getAdapter to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryError);
      expect((err as DeliveryError).code).toBe('channel_adapter_not_found');
    }
  });
});
