// devices/device-events.ts — what a device hears, read on the bus (#945).
//
// The device's stream is the push stream (#944): the same bus, the same
// resume ids. A device listener receives two kinds of events
// (events/job-events.ts, `reaches`):
//
//   - what is ADDRESSED to it — `device.event`, put there by the `device`
//     adapter (devices/device-sink.ts): a card asked through notify.ts, the
//     card closed by card-settlement.ts, a message. Already a protocol event;
//   - what the jobs of ITS requests do — the bus events the dashboard also
//     reads, for a job whose chat is this device. Each becomes the protocol
//     gesture that says it: the reply as a `bubble`, where the job stands as a
//     `state`, the spoken announcement as an `announce` pointer.
//
// Nothing here writes words: a bubble is the job's reply as stored (masked of
// its secrets by publish.ts), a failure's reason its first line, as stored.

import type { DeviceEvent } from '@nodal-agents/shared';
import type { StoredJobEvent } from '../events/job-events.ts';

/** The protocol events one bus event gives a device: none, one, or several. */
export function deviceEventsOf(e: StoredJobEvent): DeviceEvent[] {
  const p = e.payload;
  switch (p.type) {
    case 'device.event':
      return [p.event];
    case 'job.finished': {
      // A delegated job answers its parent; the request's answer is the root's.
      if (p.parentJobId !== null) return [];
      const out: DeviceEvent[] = [];
      if (p.status === 'completed' && p.reply.trim() !== '') {
        out.push({
          type: 'bubble',
          bubbleId: p.jobId,
          jobId: p.jobId,
          conversationId: p.conversationId,
          text: p.reply,
        });
      }
      out.push({
        type: 'state',
        jobId: p.jobId,
        conversationId: p.conversationId,
        state: p.status === 'completed' ? 'done' : 'cancelled',
      });
      return out;
    }
    case 'job.failed':
      if (p.parentJobId !== null) return [];
      return [
        {
          type: 'state',
          jobId: p.jobId,
          conversationId: p.conversationId,
          state: 'failed',
          ...(p.reason ? { reason: p.reason } : {}),
        },
      ];
    case 'approval.requested':
    case 'question.asked':
      // The card itself is addressed to the device by the adapter; here, the
      // job is waiting for the person.
      return [
        { type: 'state', jobId: p.jobId, conversationId: p.conversationId, state: 'waiting' },
      ];
    case 'approval.resolved':
      // The card says it is closed (`card.closed`, from its own card).
      return [];
    case 'reply.audio':
      return [
        {
          type: 'announce',
          jobId: p.jobId,
          conversationId: p.conversationId,
          audioId: p.audioId,
        },
      ];
    case 'resync':
      // Written by the stream itself, as a control event (routes/devices.ts).
      return [];
    default: {
      const unhandled: never = p;
      throw new Error(`device_event_unhandled: ${JSON.stringify(unhandled)}`);
    }
  }
}
