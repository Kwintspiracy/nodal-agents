// device-bus.test.ts — who hears what on the push stream, once devices listen (#945).
//
// The rule (`reaches`, events/job-events.ts): a device hears what its own
// requests produce and what is addressed to it; a gesture addressed to a
// device reaches no one else; the workspace's clients (the dashboard) hear the
// workspace's job events as before, never a device's gestures. And a device
// that comes back is replayed ITS events only.

import { describe, it, expect } from 'vitest';
import { JobEventBus, type StoredJobEvent } from '../../events/job-events.ts';
import { deviceEventsOf } from '../../devices/device-events.ts';

const WS = 'ws-1';
const A = 'device-a';
const B = 'device-b';

function finished(jobId: string, conversationId: string | null) {
  return {
    type: 'job.finished' as const,
    jobId,
    conversationId,
    parentJobId: null,
    status: 'completed' as const,
    reply: `reply of ${jobId}`,
  };
}

const bubble = (text: string) => ({
  type: 'device.event' as const,
  event: { type: 'bubble' as const, bubbleId: text, jobId: null, conversationId: null, text },
});

describe('the push stream, with devices listening (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('a device hears its own requests and what is addressed to it; the dashboard never hears a gesture', () => {
    const bus = new JobEventBus({ bootId: 'boot' });
    const heard: Record<string, StoredJobEvent[]> = { a: [], b: [], dashboard: [], conv: [] };
    bus.open(WS, null, null, (e) => heard['a']!.push(e), A);
    bus.open(WS, null, null, (e) => heard['b']!.push(e), B);
    bus.open(WS, null, null, (e) => heard['dashboard']!.push(e));
    bus.open(WS, 'conv-1', null, (e) => heard['conv']!.push(e));

    bus.publish(WS, 'conv-1', finished('job-a', 'conv-1'), A);
    bus.publish(WS, 'conv-2', finished('job-dash', 'conv-2'));
    bus.publish(WS, null, bubble('to A'), A);
    bus.resyncEverywhere('event_lost');

    const types = (k: string) =>
      heard[k]!.map((e) => (e.payload.type === 'job.finished' ? e.payload.jobId : e.payload.type));
    expect(types('a')).toEqual(['job-a', 'device.event', 'resync']);
    expect(types('b')).toEqual(['resync']);
    expect(types('dashboard')).toEqual(['job-a', 'job-dash', 'resync']);
    expect(types('conv')).toEqual(['job-a', 'resync']);
  });

  it('counts a device as a listener of its own requests only', () => {
    const bus = new JobEventBus({ bootId: 'boot' });
    bus.open(WS, null, null, () => {}, B);
    expect(bus.listenersOf(WS, 'conv-1', A)).toBe(0);
    expect(bus.listenersOf(WS, 'conv-1', B)).toBe(1);
    expect(bus.listenersOf(WS, 'conv-1', null)).toBe(0);
    bus.open(WS, null, null, () => {});
    expect(bus.listenersOf(WS, 'conv-1', A)).toBe(1);
  });

  it('a device that comes back is replayed its events, and only its own', () => {
    const bus = new JobEventBus({ bootId: 'boot' });
    const first = bus.publish(WS, null, bubble('one'), A);
    bus.publish(WS, null, bubble('for B'), B);
    bus.publish(WS, 'conv-1', finished('job-dash', 'conv-1'));
    bus.publish(WS, null, bubble('two'), A);
    const { opening } = bus.open(WS, null, first.id, () => {}, A);
    expect(opening.kind).toBe('replay');
    const replayed = opening.kind === 'replay' ? opening.events : [];
    expect(replayed.flatMap(deviceEventsOf)).toEqual([
      { type: 'bubble', bubbleId: 'two', jobId: null, conversationId: null, text: 'two' },
    ]);
  });
});

describe('what a device hears of a job’s life (#945) @cap:parler-par-canal-externe/moteur', () => {
  const at = (payload: StoredJobEvent['payload']): StoredJobEvent => ({
    id: 'boot:1',
    seq: 1,
    conversationId: null,
    deviceId: A,
    payload,
  });

  it('the root’s end: its reply as a bubble, then its state; a delegate’s end: nothing', () => {
    expect(deviceEventsOf(at(finished('job-1', 'conv-1')))).toEqual([
      {
        type: 'bubble',
        bubbleId: 'job-1',
        jobId: 'job-1',
        conversationId: 'conv-1',
        text: 'reply of job-1',
      },
      { type: 'state', jobId: 'job-1', conversationId: 'conv-1', state: 'done' },
    ]);
    expect(deviceEventsOf(at({ ...finished('child', 'conv-1'), parentJobId: 'job-1' }))).toEqual(
      [],
    );
    expect(
      deviceEventsOf(at({ ...finished('job-2', null), status: 'cancelled', reply: '' })),
    ).toEqual([{ type: 'state', jobId: 'job-2', conversationId: null, state: 'cancelled' }]);
  });

  it('a failure says its reason as stored; a request makes the job wait', () => {
    expect(
      deviceEventsOf(
        at({
          type: 'job.failed',
          jobId: 'job-3',
          conversationId: null,
          parentJobId: null,
          error: 'llm_error',
          reason: 'The model did not answer.',
        }),
      ),
    ).toEqual([
      {
        type: 'state',
        jobId: 'job-3',
        conversationId: null,
        state: 'failed',
        reason: 'The model did not answer.',
      },
    ]);
    expect(
      deviceEventsOf(
        at({
          type: 'approval.requested',
          approvalId: 'r',
          jobId: 'job-4',
          conversationId: null,
          kind: 'approval',
          toolName: 'run_command',
          text: 'why',
        }),
      ),
    ).toEqual([{ type: 'state', jobId: 'job-4', conversationId: null, state: 'waiting' }]);
  });
});
