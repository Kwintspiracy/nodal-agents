// devices/device-sink.ts — what the `device` adapter sends, put on the device's stream (#945).
//
// The adapter (@nodal-agents/delivery, channels/device-adapter.ts) knows no
// protocol: it hands each send, in its neutral terms, to the sink this module
// builds. Here the send becomes a protocol event (@nodal-agents/shared,
// device-protocol.ts), checked against its schema, and is published on THE
// bus (events/job-events.ts) addressed to that device — the stream it reads
// is the push stream of #944, not a second transport.
//
// The isolation rule lives here, at the send site: the device must be a
// device of the send's workspace (`findWorkspaceDevice`). A job of workspace
// X naming a device of workspace Y reaches nobody, and fails loud.

import { randomUUID } from 'node:crypto';
import { DeliveryError, type DeviceOutbound, type DeviceSink } from '@nodal-agents/delivery';
import { findWorkspaceDevice, isDeviceId } from '@nodal-agents/db';
import { DeviceEventSchema, type DeviceEvent } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { jobEvents, type JobEventBus } from '../events/job-events.ts';
import { APPROVAL_CALLBACK_PREFIX } from '../approvals/notify.ts';

/**
 * The request a card answers, read on its callback id (`apr:<id>`, the one
 * notify.ts gives every card): what the device sends back to
 * `POST /api/approve` as `approvalRequestId`.
 */
function cardIdOf(callbackId: string): string {
  const prefix = `${APPROVAL_CALLBACK_PREFIX}:`;
  const id = callbackId.startsWith(prefix) ? callbackId.slice(prefix.length) : '';
  if (!isDeviceId(id)) {
    throw new DeliveryError(
      'send_failed',
      `send_failed: a device card must answer a request (apr:<id>), got "${callbackId}"`,
    );
  }
  return id;
}

/** The protocol event for one send, and the id a later edit names. */
export function deviceEventFor(out: DeviceOutbound): { event: DeviceEvent; messageId: string } {
  switch (out.kind) {
    case 'text': {
      const bubbleId = randomUUID();
      return {
        messageId: bubbleId,
        event: { type: 'bubble', bubbleId, jobId: null, conversationId: null, text: out.text },
      };
    }
    case 'approval_card': {
      const cardId = cardIdOf(out.card.callbackId);
      return {
        messageId: cardId,
        event: {
          type: 'card',
          cardId,
          kind: 'approval',
          text: out.card.text,
          // « Always allow » asks a confirmation step that only Telegram draws
          // today: the device gets the two decisions /api/approve takes.
          choices: [
            { label: out.card.approveLabel, decision: 'approve' },
            { label: out.card.rejectLabel, decision: 'reject' },
          ],
        },
      };
    }
    case 'question_card': {
      const cardId = cardIdOf(out.card.callbackId);
      return {
        messageId: cardId,
        event: {
          type: 'card',
          cardId,
          kind: 'question',
          text: out.card.text,
          choices: out.card.options.map((option) => ({
            label: option,
            decision: 'approve' as const,
            answer: option,
          })),
        },
      };
    }
    case 'card_edit':
      return {
        messageId: out.messageId,
        event: { type: 'card.closed', cardId: out.messageId, text: out.text },
      };
    default: {
      const unhandled: never = out;
      throw new Error(`device_outbound_unhandled: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The sink the runner binds (`bindDeviceSink`, server.ts). */
export function createDeviceSink(db: RunnerDeps['db'], bus: JobEventBus = jobEvents): DeviceSink {
  return {
    async deliver(to, out) {
      const device = await findWorkspaceDevice(db, to);
      if (!device) {
        throw new DeliveryError(
          'device_not_in_workspace',
          `device_not_in_workspace: ${to.deviceId} is not a device of workspace ${to.entityId}`,
        );
      }
      const { event, messageId } = deviceEventFor(out);
      // The schema is the contract #947 and #950 are tested against: an event
      // that does not fit it is never sent.
      bus.publish(
        device.entityId,
        null,
        { type: 'device.event', event: DeviceEventSchema.parse(event) },
        device.id,
      );
      return { messageId };
    },
  };
}
