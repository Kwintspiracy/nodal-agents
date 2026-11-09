// device-channel.test.ts — the `device` channel in the delivery layer (#945).
//
// Every channel is classified once (`CHANNEL_REACH`) and has its adapter; a
// device is a place a request is answered on (`isTransportChannel`) that Nodal
// never PUSHES to: no result, no send tool, no owner notice, never the
// fallback of a request made elsewhere. The device adapter hands its sends to
// the sink the runner binds, and fails loud without one.

import { describe, it, expect, afterEach } from 'vitest';
import {
  CHANNEL_REACH,
  bindDeviceSink,
  defaultSendChannel,
  deviceAdapter,
  getAdapter,
  isMessagingChannel,
  isTransportChannel,
  jobChatOn,
  resolveTransportChannel,
  type ChannelKind,
  type DeviceAddress,
  type DeviceOutbound,
} from '../index.ts';

afterEach(() => bindDeviceSink(null));

describe('every channel is classified, and has its adapter @cap:parler-par-canal-externe/moteur', () => {
  it('each kind of CHANNEL_REACH resolves to its own adapter', () => {
    for (const kind of Object.keys(CHANNEL_REACH) as ChannelKind[]) {
      expect(getAdapter(kind).channel).toBe(kind);
    }
    expect(CHANNEL_REACH.device).toBe('stream');
  });
});

describe('a device is answered on, never pushed to (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('a request made on a device is answered there', () => {
    expect(isTransportChannel('device')).toBe(true);
    expect(jobChatOn({ id: 'dev-1', channel: 'device' }, 'device')).toBe('dev-1');
  });

  it('it is not a messaging platform: a push falls back to the agent’s messaging channel', () => {
    expect(isMessagingChannel('device')).toBe(false);
    expect(resolveTransportChannel('device', ['discord'])).toBe('discord');
    expect(resolveTransportChannel('device')).toBe('telegram');
  });

  it('a send tool on a job asked from a device writes where a dashboard job’s does', () => {
    const fromDevice = defaultSendChannel({ id: 'dev-1', channel: 'device' }, 'device', ['slack']);
    const fromDashboard = defaultSendChannel({ id: null, channel: null }, 'dashboard', ['slack']);
    expect(fromDevice).toBe('slack');
    expect(fromDevice).toBe(fromDashboard);
    // A chat recorded on a messaging platform still decides, as before.
    expect(defaultSendChannel({ id: '42', channel: 'discord' }, 'cron', ['telegram'])).toBe(
      'discord',
    );
  });
});

describe('the device adapter hands its sends to the bound sink @cap:parler-par-canal-externe/moteur', () => {
  it('without a sink, a send fails loud', async () => {
    await expect(deviceAdapter.sendText({ entityId: 'ws' }, 'dev-1', 'hi')).rejects.toThrow(
      /device_stream_unavailable/,
    );
  });

  it('a send names its workspace, or is refused', async () => {
    bindDeviceSink({ deliver: async () => ({ messageId: 'm' }) });
    await expect(deviceAdapter.sendText({}, 'dev-1', 'hi')).rejects.toThrow(/device_no_workspace/);
  });

  it('text, cards and a settled card reach the sink, addressed to the device of the workspace', async () => {
    const got: Array<{ to: DeviceAddress; out: DeviceOutbound }> = [];
    bindDeviceSink({
      deliver: async (to, out) => {
        got.push({ to, out });
        return { messageId: `m${got.length}` };
      },
    });
    const creds = { entityId: 'ws-1' };
    expect(await deviceAdapter.sendText(creds, 'dev-1', 'hello')).toEqual({ messageId: 'm1' });
    await deviceAdapter.sendApprovalCard!(creds, 'dev-1', {
      text: 'card',
      approveLabel: 'yes',
      rejectLabel: 'no',
      callbackId: 'apr:x',
    });
    await deviceAdapter.sendQuestionCard!(creds, 'dev-1', {
      text: 'which?',
      options: ['a', 'b'],
      callbackId: 'apr:y',
    });
    expect(await deviceAdapter.editMessageText!(creds, 'dev-1', 'x', 'closed')).toEqual({
      ok: true,
    });
    expect(got.map((g) => g.to)).toEqual(Array(4).fill({ entityId: 'ws-1', deviceId: 'dev-1' }));
    expect(got.map((g) => g.out.kind)).toEqual([
      'text',
      'approval_card',
      'question_card',
      'card_edit',
    ]);
    expect(got[3]!.out).toEqual({ kind: 'card_edit', messageId: 'x', text: 'closed' });
  });

  it('what a device cannot receive is refused, never cut', async () => {
    bindDeviceSink({ deliver: async () => ({ messageId: 'm' }) });
    await expect(
      deviceAdapter.sendMedia({ entityId: 'ws' }, 'dev-1', {
        kind: 'photo',
        bytes: new Uint8Array([1]),
        filename: 'a.png',
      }),
    ).rejects.toThrow(/device_media_unsupported/);
    expect(
      await deviceAdapter.editMessageText!({ entityId: 'ws' }, 'dev-1', 'x', 'again', [
        [{ label: 'Yes', callbackData: 'apr:x:w' }],
      ]),
    ).toEqual({ ok: false, error: 'device_cannot_redraw_buttons' });
  });
});
