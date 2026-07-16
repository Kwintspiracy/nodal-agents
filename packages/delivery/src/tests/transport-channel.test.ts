// transport-channel.test.ts — resolveTransportChannel's default rule.

import { describe, it, expect } from 'vitest';
import { resolveTransportChannel } from '../transport-channel.ts';

describe('resolveTransportChannel', () => {
  it('defaults a non-transport trigger origin (cron) to telegram', () => {
    expect(resolveTransportChannel('cron')).toBe('telegram');
  });

  it('defaults webhook and dashboard origins to telegram', () => {
    expect(resolveTransportChannel('webhook')).toBe('telegram');
    expect(resolveTransportChannel('dashboard')).toBe('telegram');
    expect(resolveTransportChannel('api')).toBe('telegram');
  });

  it('defaults null/undefined to telegram', () => {
    expect(resolveTransportChannel(null)).toBe('telegram');
    expect(resolveTransportChannel(undefined)).toBe('telegram');
  });

  it('keeps telegram as telegram', () => {
    expect(resolveTransportChannel('telegram')).toBe('telegram');
  });

  it('keeps a registered non-telegram transport (discord) as itself, not redirected', () => {
    expect(resolveTransportChannel('discord')).toBe('discord');
  });

  it('keeps a registered non-telegram transport (whatsapp) as itself, not redirected', () => {
    expect(resolveTransportChannel('whatsapp')).toBe('whatsapp');
  });

  it('defaults a non-transport origin to the agent\'s only active channel (discord)', () => {
    expect(resolveTransportChannel('cron', ['discord'])).toBe('discord');
  });

  it('picks the highest-priority active channel among several (slack over whatsapp)', () => {
    expect(resolveTransportChannel('webhook', ['slack', 'whatsapp'])).toBe('slack');
  });

  it('defaults a non-transport origin to the agent\'s only active channel (whatsapp)', () => {
    expect(resolveTransportChannel('dashboard', ['whatsapp'])).toBe('whatsapp');
  });

  it('prefers telegram over discord when both are active', () => {
    expect(resolveTransportChannel('cron', ['telegram', 'discord'])).toBe('telegram');
  });

  it('falls back to telegram when activeChannels is an empty array', () => {
    expect(resolveTransportChannel('cron', [])).toBe('telegram');
  });

  it('keeps an already-transport channel even when activeChannels names a different one', () => {
    expect(resolveTransportChannel('discord', ['telegram'])).toBe('discord');
  });
});
