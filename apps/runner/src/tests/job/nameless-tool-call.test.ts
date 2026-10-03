// nameless-tool-call.test.ts — a tool call without a name never reaches a
// provider again.
//
// Jobs 756b51ab… (banc r2, 02/10) and others of 01/10 died on
// `provider_rejected_request (http 400)`: glm-5.3 via OpenRouter emitted a tool
// call whose name was the empty string, the runner kept it in the transcript,
// and every provider refused the next request whole ("tool_calls[0].function.
// name must be a non-empty string", Parasail and InferenceNet alike).
//
// Proven on the REAL path: executeJob, a real test database, the REAL LLM
// client built from the agent's key, and the HTTP body read at the fetch
// boundary — what the provider actually receives. Both ways such a call can be
// in a request: emitted by the model during the run, and already in the
// persisted transcript a job resumes from.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests } from '@nodal-agents/secrets';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, eq } from '@nodal-agents/db';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import { jobRow, makeDeps, scriptProvider, seedJob } from './tool-loading-harness.ts';
import type { Body } from './tool-loading-harness.ts';

// Provider calls leave through packages/llm's own transport (#609), not the
// global fetch. Routed back to it here, so the harness's stub is still the
// fetch boundary and nothing leaves the machine.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

let db: TestDb;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type WireToolCall = { id?: string; function?: { name?: unknown } };

/** Every tool-call name the request carries, as the provider reads them. */
const wireToolCallNames = (b: Body): unknown[] =>
  b.messages.flatMap((m) =>
    ((m as { tool_calls?: WireToolCall[] }).tool_calls ?? []).map((tc) => tc.function?.name),
  );

describe('a tool call without a name @cap:parler-a-un-agent/moteur', () => {
  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])(
    'emitted with an %s name: the next request carries no nameless call, the model reads why, the job completes',
    async (_label, badName) => {
      const { jobId } = await seedJob(db, { model: 'z-ai/glm-5.3', role: 'agent' });
      const bodies = scriptProvider([
        // Turn 1: a well-formed call next to a nameless one, as glm-5.3 did.
        {
          calls: [
            { name: 'skill_view', args: { slug: 'none-a' } },
            { name: badName, args: { slug: 'none-b' } },
          ],
        },
        // Turn 2: the model, told why, answers.
        { text: 'All done.' },
      ]);

      const outcome = await executeJob(jobId as JobId, makeDeps(db));

      // Turn 2, then the runner's own re-read of a text-only turn: neither
      // carries a call without a name, in any message.
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      for (const body of bodies.slice(1)) {
        for (const name of wireToolCallNames(body)) {
          expect(typeof name === 'string' && name.trim() !== '').toBe(true);
        }
      }
      const second = bodies[1]!;
      // The well-formed call is replayed with its own result.
      expect(wireToolCallNames(second)).toEqual(['skill_view']);
      const toolMessages = second.messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]!.tool_call_id).toBe('call_1_0');
      // The model reads why its nameless call was not run.
      const told = second.messages.filter(
        (m) =>
          m.role === 'user' && JSON.stringify(m.content).includes('The tool call had no tool name'),
      );
      expect(told).toHaveLength(1);

      expect(outcome.status).toBe('completed');
      const row = await jobRow(db, jobId);
      expect(row.status).toBe('completed');
      // The transcript keeps what happened: the nameless call and its error.
      const transcript = JSON.stringify(row.messages);
      expect(transcript).toContain('The tool call had no tool name');
    },
  );

  it('already in the persisted transcript of a resumed job: the request carries no nameless call', async () => {
    const { jobId } = await seedJob(db, { model: 'z-ai/glm-5.3', role: 'agent' });
    // A transcript written before the fix: the nameless call and its result.
    await db
      .update(agentJobs)
      .set({
        turn: 1,
        messages: [
          { role: 'user', content: 'Do the thing.' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Looking it up.' },
              { type: 'tool-call', toolCallId: 'old_1', toolName: '', input: { slug: 'x' } },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'old_1',
                toolName: '',
                output: { type: 'error-text', value: 'The tool "" is not available to you.' },
              },
            ],
          },
        ],
      })
      .where(eq(agentJobs.id, jobId));
    const bodies = scriptProvider([{ text: 'All done.' }]);

    const outcome = await executeJob(jobId as JobId, makeDeps(db));

    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      expect(wireToolCallNames(body)).toEqual([]);
      expect(body.messages.some((m) => m.role === 'tool')).toBe(false);
    }
    const first = bodies[0]!;
    // The assistant's text stays; the old error reaches the model as text.
    const asText = JSON.stringify(first.messages);
    expect(asText).toContain('Looking it up.');
    expect(asText).toContain('The tool \\"\\" is not available to you.');
    expect(outcome.status).toBe('completed');
  });
});
