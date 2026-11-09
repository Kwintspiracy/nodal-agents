// device-protocol.test.ts — the device protocol and the channel enumerations of @nodal-agents/shared (#945).

import { describe, it, expect } from 'vitest';
import {
  CHANNELS,
  CHAT_STORE_CHANNELS,
  DEVICE_CAPABILITIES,
  DeviceEventSchema,
  DeviceStreamResyncSchema,
  isDeviceOwnRoute,
  isDeviceTokenRoute,
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

describe('where a device key is accepted, read from the route table (#946) @cap:parler-par-canal-externe/moteur', () => {
  it('every route of DEVICE_GESTURES, with its method, and no other', () => {
    for (const [method, path] of [
      ['GET', '/api/devices/0b6f5a4e-1f2a-4c3b-9d8e-7f6a5b4c3d2e/events'],
      ['POST', '/api/devices/0b6f5a4e-1f2a-4c3b-9d8e-7f6a5b4c3d2e/conversation'],
      ['POST', '/api/voice/turns'],
      ['POST', '/api/voice/turns/t1/chunks/0'],
      ['POST', '/api/voice/turns/t1/end'],
      ['DELETE', '/api/voice/turns/t1'],
      ['POST', '/api/chat/stream'],
      ['POST', '/api/chat/stop'],
      ['POST', '/api/approve'],
      ['GET', '/api/voice/replies/a1'],
    ]) {
      expect(isDeviceTokenRoute(method!, path!)).toBe(true);
    }
    for (const [method, path] of [
      ['GET', '/api/devices/0b6f5a4e-1f2a-4c3b-9d8e-7f6a5b4c3d2e/conversation'],
      ['GET', '/api/events'],
      ['POST', '/api/agent'],
      ['POST', '/api/chat'],
      ['POST', '/api/devices/pair'],
      ['POST', '/api/devices/pair/poll'],
      ['GET', '/api/workspace-devices'],
      ['POST', '/api/voice/turns/t1/chunks'],
      ['POST', '/api/voice/turns//end'],
      ['GET', '/api/voice/setting'],
    ]) {
      expect(isDeviceTokenRoute(method!, path!)).toBe(false);
    }
  });

  it('a device’s own routes are the /api/devices/:deviceId/ ones, and the pairing routes are not', () => {
    expect(isDeviceOwnRoute('GET', '/api/devices/d1/events')).toBe(true);
    expect(isDeviceOwnRoute('POST', '/api/devices/d1/conversation')).toBe(true);
    expect(isDeviceOwnRoute('POST', '/api/devices/pair/poll')).toBe(false);
    expect(isDeviceOwnRoute('POST', '/api/devices/pair')).toBe(false);
    expect(isDeviceOwnRoute('POST', '/api/chat/stream')).toBe(false);
  });
});
