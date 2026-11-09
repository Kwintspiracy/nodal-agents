// device-protocol.test.ts — the device protocol and the channel enumerations of @nodal-agents/shared (#945).

import { describe, it, expect } from 'vitest';
import {
  CHANNELS,
  CHAT_STORE_CHANNELS,
  DEVICE_CAPABILITIES,
  DeviceEventSchema,
  DeviceStreamResyncSchema,
  JOB_CHANNELS,
  JobChannelSchema,
  keepsTurnsInChat,
} from '../index';

describe('the enumerations that accept `device`, and the one that leaves it out (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('a job can be launched from a device', () => {
    expect(JOB_CHANNELS).toContain('device');
    expect(JobChannelSchema.parse('device')).toBe('device');
    expect(JobChannelSchema.safeParse('pigeon').success).toBe(false);
  });

  it('a device keeps its turns in chat_messages, like the dashboard; a messaging thread does not', () => {
    expect([...CHAT_STORE_CHANNELS]).toEqual(['dashboard', 'device']);
    expect(keepsTurnsInChat('device')).toBe(true);
    expect(keepsTurnsInChat('dashboard')).toBe(true);
    expect(keepsTurnsInChat('telegram')).toBe(false);
    expect(keepsTurnsInChat(null)).toBe(false);
  });

  it('a device has no per-agent binding: the binding channels leave it out', () => {
    expect(CHANNELS).not.toContain('device');
  });
});

describe('the protocol events a device receives (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('accepts each gesture Nodal sends, and nothing else', () => {
    const gestures = [
      { type: 'bubble', bubbleId: 'b', jobId: null, conversationId: null, text: 'hi' },
      {
        type: 'card',
        cardId: 'c',
        kind: 'approval',
        text: 'frame',
        choices: [{ label: 'Approve', decision: 'approve' }],
      },
      { type: 'card.closed', cardId: 'c', text: 'done' },
      { type: 'state', jobId: 'j', conversationId: null, state: 'failed', reason: 'why' },
      { type: 'announce', jobId: 'j', conversationId: 'c', audioId: 'a' },
    ];
    for (const g of gestures) expect(DeviceEventSchema.parse(g)).toEqual(g);
    expect(DeviceEventSchema.safeParse({ type: 'tool_call', name: 'run_command' }).success).toBe(
      false,
    );
    expect(
      DeviceEventSchema.safeParse({ type: 'state', jobId: 'j', conversationId: null, state: 'x' })
        .success,
    ).toBe(false);
    expect(DeviceStreamResyncSchema.parse({ type: 'resync', reason: 'runner_restarted' })).toEqual({
      type: 'resync',
      reason: 'runner_restarted',
    });
  });

  it('declares the four capabilities the devices table accepts', () => {
    expect([...DEVICE_CAPABILITIES]).toEqual(['microphone', 'speaker', 'screen', 'buttons']);
  });
});
