// device-run-state-order.test.ts — the state a device ends on is the run's newest (#945).
//
// Reviewer A of #1005, pass 2: two transitions of one run, pushed together,
// each read the base and published when their reading came back. A reading
// taken BEFORE the run ended could come back last, and the device ended on
// `waiting` after `done` — and showed it to the person.
//
// Here the first reading is HELD after it was read (the slow reading), the
// run ends meanwhile and its end is pushed, then the held reading is let go.
// The pushes of a run are serialized (events/publish.ts): the end's reading is
// taken after the held one was published, so the stream ends on `done`, and
// each `state` carries a `seq` that only grows.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, devices, eq } from '@nodal-agents/db';
import { DeviceEventSchema } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import { JobEventBus, type StoredJobEvent } from '../../events/job-events.ts';
import { deviceEventsOf } from '../../devices/device-events.ts';

/** The next run-state reading is held after it was read, until `release`. */
const gate = vi.hoisted(() => ({ hold: false, held: false, release: () => {} }));

vi.mock('@nodal-agents/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/db')>();
  return {
    ...actual,
    readRunState: async (...args: Parameters<typeof actual.readRunState>) => {
      const reading = await actual.readRunState(...args);
      if (gate.hold) {
        gate.hold = false;
        gate.held = true;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      return reading;
    },
  };
});

// After the mock: publish.ts reads the gated `readRunState`.
const { publishApprovalRequested, publishJobEnded } = await import('../../events/publish.ts');

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let deviceId = '';

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  const [d] = await db
    .insert(devices)
    .values({ entityId: seed.entityId, name: 'Desk', capabilities: ['speaker'] })
    .returning({ id: devices.id });
  deviceId = d!.id;
});

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: condition never met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('the pushes of a run are ordered (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('a reading taken before the end, slower than the end, never lands after it', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'device',
        chatId: deviceId,
        chatChannel: 'device',
        task: 'ordered states',
        status: 'awaiting_approval',
        messages: [],
        chainCount: 0,
      })
      .returning({ id: agentJobs.id });
    const toolInput = { question: 'Which tray?', options: ['1', '2'] };
    const [request] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: job!.id,
        agentId: seed.agentId,
        toolName: 'ask_user',
        toolInput,
        kind: 'question',
      })
      .returning({ id: approvalRequests.id });

    const bus = new JobEventBus({ bootId: 'boot' });
    const heard: StoredJobEvent[] = [];
    bus.open(seed.entityId, null, null, (e) => heard.push(e), deviceId);
    const states = () =>
      heard
        .flatMap(deviceEventsOf)
        .map((e) => DeviceEventSchema.parse(e))
        .filter((e) => e.type === 'state');

    // 1. The request is pushed; its reading (waiting) is held after it was read.
    gate.hold = true;
    const asked = publishApprovalRequested(
      db as RunnerDeps['db'],
      {
        approvalRequestId: request!.id,
        toolName: 'ask_user',
        toolInput,
        jobId: job!.id,
        agentId: seed.agentId,
        entityId: seed.entityId,
        kind: 'question',
      },
      bus,
    );
    await waitFor(() => gate.held);

    // 2. Meanwhile the request is answered and the run ends; its end is pushed.
    await db
      .update(approvalRequests)
      .set({ status: 'approved', answer: '2' })
      .where(eq(approvalRequests.id, request!.id));
    await db
      .update(agentJobs)
      .set({ status: 'completed', result: 'Tray 2.' })
      .where(eq(agentJobs.id, job!.id));
    const ended = publishJobEnded(db as RunnerDeps['db'], job!.id, bus);
    await waitFor(() => heard.some((e) => e.payload.type === 'job.finished'));

    // 3. The slow reading is let go.
    gate.release();
    await Promise.all([asked, ended]);

    const seen = states();
    expect(seen.map((s) => s.type === 'state' && s.state)).toEqual(['waiting', 'done']);
    expect(seen.at(-1)).toMatchObject({ type: 'state', jobId: job!.id, state: 'done' });
    const seqs = seen.map((s) => (s.type === 'state' ? s.seq : 0));
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
  });
});
