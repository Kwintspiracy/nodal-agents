// result-capture.test.ts — Result-capture fix (orchestration reliability lot).
//
// Guarantees a leaf job's substantive output is captured into agent_jobs.result
// even when the agent never called a delivery tool (dashboard_publish / a send
// tool). Without this, a research/synthesis chain receives empty dep results.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs } from '@nodal-agents/db';
import { completeJob } from '../../job/state.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

async function freshJob(): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'task-board',
      task: 'do research',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function resultOf(jobId: string): Promise<string | null> {
  const [r] = await db
    .select({ result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return r?.result ?? null;
}

describe('result capture on completeJob (empty result + no delivery tool)', () => {
  it("captures the agent's final assistant TEXT into result when result is empty", async () => {
    const jobId = await freshJob();
    const report = '# Research report\nThe market is competitive. Key finding: X beats Y.';
    const messages = [
      { role: 'user', content: 'do research' },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tavily_search', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolName: 'tavily_search', output: { type: 'json', value: {} } },
        ],
      },
      { role: 'assistant', content: report },
    ];
    // completeJob with empty result (agent ended via return_result, no publish).
    await completeJob(db, jobId, '', ['tavily_search'], undefined, messages);
    expect(await resultOf(jobId)).toBe(report);
  });

  it('captures assistant text from a content-array (text part) too', async () => {
    const jobId = await freshJob();
    const messages = [
      { role: 'user', content: 'do research' },
      { role: 'assistant', content: [{ type: 'text', text: 'Final structured answer here.' }] },
    ];
    await completeJob(db, jobId, '', [], undefined, messages);
    expect(await resultOf(jobId)).toBe('Final structured answer here.');
  });

  it('does NOT fabricate a result when the agent produced no text (only tool calls)', async () => {
    const jobId = await freshJob();
    const messages = [
      { role: 'user', content: 'do research' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolName: 'return_result', input: { status: 'success' } }],
      },
    ];
    await completeJob(db, jobId, '', ['return_result'], undefined, messages);
    expect((await resultOf(jobId)) ?? '').toBe('');
  });

  it('preserves an explicit non-empty result (does not overwrite a real publish)', async () => {
    const jobId = await freshJob();
    // Simulate dashboard_publish having set the result earlier.
    await db.update(agentJobs).set({ result: 'published content' }).where(eq(agentJobs.id, jobId));
    const messages = [{ role: 'assistant', content: 'some later chatter' }];
    await completeJob(db, jobId, '', [], undefined, messages);
    expect(await resultOf(jobId)).toBe('published content');
  });
});
