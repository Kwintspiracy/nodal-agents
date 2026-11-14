// channels/device-adapter.ts — the ChannelAdapter of channel `device` (#945).
//
// A device (an external module: a desktop companion, a speaker, a small
// robot, a piece of software) has no platform API to call: what Nodal says to
// it goes over ITS event stream, the runner's push stream (#944). This adapter
// is therefore a thin seam: it hands each send to the SINK the runner binds at
// startup (`bindDeviceSink`), which turns it into a protocol event on that
// device's stream (apps/runner/src/devices/device-sink.ts). There is no second
// transport, and the protocol lives in one place (@nodal-agents/shared,
// device-protocol.ts), on the runner's side of the seam.
//
// The credential bag is the WORKSPACE the send is made for (`{ entityId }`,
// getBindingCredentials in @nodal-agents/db): a device belongs to a workspace,
// never to an agent. The sink refuses a device outside it — a job of
// workspace X never reaches a device of workspace Y, even by naming its id.
//
// A device answers every card through `POST /api/approve`, with a decision
// and, for a choice, the option: its cards are CHOICES (`sendApprovalCard`,
// `sendQuestionCard`, and `sendChoiceCard` for the question of an MCP server
// that a list of choices answers, #1067). The images of such a card travel
// INSIDE it, as pointers the device reads with its key: the sink names them,
// the bytes never ride the stream.
//
// What a device does NOT get through this adapter, said here once:
//   - media (`capabilities.media` false): a file sent on its own, outside a
//     card, has no pointer for a device;
//   - free-button cards (`sendCard`, a server's form filled gesture by
//     gesture, 0145): `POST /api/approve` takes a decision or an option, not
//     a callback; a form no list of choices answers is answered on the
//     dashboard, and the question that reaches the device says why;
//   - a finished job's RESULT: the device reads it on its stream (`job.finished`),
//     like the dashboard — `CHANNEL_REACH` says `stream` (transport-channel.ts).

import { DeliveryError } from '../errors.ts';
import type {
  ApprovalCard,
  BotIdentity,
  ChannelAdapter,
  ChannelCredentials,
  ChoiceCard,
  EditResult,
  QuestionCard,
  SendResult,
} from '../channel-adapter.ts';

/** Where a send goes: a device of a workspace. */
export interface DeviceAddress {
  entityId: string;
  deviceId: string;
}

/** A send, in the adapter's neutral terms — the sink speaks the protocol. */
export type DeviceOutbound =
  | { kind: 'text'; text: string }
  | { kind: 'approval_card'; card: ApprovalCard }
  | { kind: 'question_card'; card: QuestionCard }
  | { kind: 'choice_card'; card: ChoiceCard }
  | { kind: 'card_edit'; messageId: string; text: string };

/**
 * What the runner binds: deliver one send to a device's stream. Rejects when
 * the device is not of the address's workspace (or does not exist). Resolves
 * with the id of what was sent — a card's id is what a later edit names.
 */
export interface DeviceSink {
  deliver(to: DeviceAddress, out: DeviceOutbound): Promise<SendResult>;
}

let boundSink: DeviceSink | null = null;

/** Bind (or unbind, `null`) the sink. The runner does it once, at startup. */
export function bindDeviceSink(sink: DeviceSink | null): void {
  boundSink = sink;
}

function sinkOrFail(): DeviceSink {
  if (!boundSink) {
    // Invariant #4: no device stream in this process (a CLI, a test without
    // the runner) — the send fails loud rather than vanishing.
    throw new DeliveryError(
      'device_stream_unavailable',
      'device_stream_unavailable: no device stream is bound in this process',
    );
  }
  return boundSink;
}

function addressOf(creds: ChannelCredentials, conversationId: string): DeviceAddress {
  const entityId = creds['entityId'];
  if (!entityId) {
    throw new DeliveryError(
      'device_no_workspace',
      'device_no_workspace: a device send must name the workspace it is made for',
    );
  }
  if (!conversationId) {
    throw new DeliveryError('device_no_device_id', 'device_no_device_id: no device to send to');
  }
  return { entityId, deviceId: conversationId };
}

export const deviceAdapter: ChannelAdapter = {
  channel: 'device',
  capabilities: {
    buttons: true,
    threads: false,
    media: false,
    editMessage: true,
  },
  // The device shows the text as it is: nothing is rendered, nothing is cut.
  text: { renders: [], maxMessageChars: Number.MAX_SAFE_INTEGER },

  async sendText(creds, conversationId, text, opts): Promise<SendResult> {
    // One piece only: a resumed send (`fromChunk` ≥ 1) has nothing left to send.
    if ((opts?.fromChunk ?? 0) > 0) {
      throw new DeliveryError(
        'device_no_such_chunk',
        `device_no_such_chunk: a device message is one piece, there is no chunk ${opts?.fromChunk}`,
      );
    }
    return sinkOrFail().deliver(addressOf(creds, conversationId), { kind: 'text', text });
  },

  async sendMedia(): Promise<SendResult> {
    throw new DeliveryError(
      'device_media_unsupported',
      'device_media_unsupported: a file sent outside a card has no pointer for a device; it stays on the dashboard',
    );
  },

  async sendApprovalCard(creds, conversationId, card): Promise<SendResult> {
    return sinkOrFail().deliver(addressOf(creds, conversationId), {
      kind: 'approval_card',
      card,
    });
  },

  async sendQuestionCard(creds, conversationId, card): Promise<SendResult> {
    return sinkOrFail().deliver(addressOf(creds, conversationId), {
      kind: 'question_card',
      card,
    });
  },

  async sendChoiceCard(creds, conversationId, card): Promise<SendResult> {
    return sinkOrFail().deliver(addressOf(creds, conversationId), { kind: 'choice_card', card });
  },

  async editMessageText(creds, conversationId, messageId, text, buttons): Promise<EditResult> {
    // A settled card has no button; a card re-drawn WITH buttons (Telegram's
    // "Always allow?" step) has no device form.
    if (buttons && buttons.length > 0) {
      return { ok: false, error: 'device_cannot_redraw_buttons' };
    }
    try {
      await sinkOrFail().deliver(addressOf(creds, conversationId), {
        kind: 'card_edit',
        messageId,
        text,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async validateCredentials(creds: ChannelCredentials): Promise<BotIdentity> {
    const entityId = creds['entityId'];
    if (!entityId) {
      throw new DeliveryError('device_no_workspace', 'device_no_workspace: no workspace named');
    }
    return { id: entityId, username: null, displayName: null };
  },
};
