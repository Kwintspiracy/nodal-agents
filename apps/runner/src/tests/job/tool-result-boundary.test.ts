// tool-result-boundary.test.ts — a tool result is masked before the model, and every store holds what it saw.
//
// The real path: executeJob, a real test database, the real file_read, the
// real LLM client, the provider requests read at the fetch boundary. The
// workspace holds a connector key (a value with no credential shape: only the
// registry of the workspace's own values knows it) and a file that holds it
// beside a value with a credential's shape. What is asserted:
//   - the body of every later request to the provider holds neither;
//   - the stored transcript, its search text and the tool-call row hold
//     neither, and hold the same text the provider received;
//   - a job suspended after the masked result (an approval) resumes with the
//     very text the provider had received, byte for byte.
// Values are assembled at run time, never printed.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agentWorkspaces,
  approvalRequests,
  and,
  connectors,
  eq,
  toolCalls,
} from '@nodal-agents/db';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { fakeAlnum, fakeSecret } from '@nodal-agents/test-kit';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import {
  jobRow,
  makeDeps,
  scriptProvider,
  seedJob,
  testEnv,
  toolResults,
  type Body,
} from './tool-loading-harness.ts';

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

let db: TestDb;
let dir = '';
let registered = '';
let shaped = '';

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  db = (await spinUpTestDb()).db;
  registered = randomBytes(20).toString('hex');
  shaped = fakeSecret('github', fakeAlnum(36));
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-boundary-job-')));
  await writeFile(
    join(dir, 'settings.env'),
    ['NAME=demo', `ACME_KEY=${registered}`, `GH_TOKEN=${shaped}`, 'PORT=8080', ''].join('\n'),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** A job of an agent of a workspace that holds `registered` as a connector key. */
async function seeded(opts: Parameters<typeof seedJob>[1]) {
  const s = await seedJob(db, opts);
  await db
    .insert(connectors)
    .values({ entityId: s.entityId, name: 'Acme', slug: 'acme', apiKey: encrypt(registered) });
  await db
    .insert(agentWorkspaces)
    .values({ agentId: s.agentId, entityId: s.entityId, label: 'ws', path: dir, position: 0 });
  return s;
}

const holdsNeither = (text: string, where: string): void => {
  expect(text, `${where}: the registered value`).not.toContain(registered);
  expect(text, `${where}: the shaped value`).not.toContain(shaped);
};

/**
 * The text of the file_read result as one request carries it: a string, or
 * text parts (the form a message takes when it carries a cache mark).
 */
const readResultIn = (b: Body): string => {
  const found = toolResults(b).find((t) => t.includes('PORT=8080'));
  if (found === undefined) throw new Error('the file_read result is not in this request');
  if (!found.startsWith('[')) return found;
  const parts = JSON.parse(found) as Array<{ type: string; text?: string }>;
  return parts.map((p) => p.text ?? '').join('');
};

/** The stored message that carries the file_read result, as stored. */
const storedReadOf = (messages: unknown): string => {
  const found = ((messages as unknown[]) ?? [])
    .map((m) => JSON.stringify(m))
    .find((m) => m.includes('PORT=8080') && m.includes('tool'));
  if (found === undefined) throw new Error('the file_read result is not in the stored transcript');
  return found;
};

describe('a tool result reaches the model and every store masked, the same text everywhere @cap:travailler-sur-des-fichiers/moteur', () => {
  it('the next request, the transcript, the search text and the tool-call row hold neither value', async () => {
    const { jobId } = await seeded({ model: 'anthropic/claude-sonnet-5.5', role: 'agent' });
    const bodies = scriptProvider([
      { calls: [{ name: 'file_read', args: { path: 'settings.env', purpose: 'Read it.' } }] },
      { calls: [{ name: 'file_list', args: { path: '.', purpose: 'List.' } }] },
      { text: 'Done.' },
    ]);
    await executeJob(jobId as JobId, makeDeps(db), testEnv);

    expect(bodies.length).toBeGreaterThanOrEqual(3);
    // Every request after the read: masked, and the same text each time.
    const sent = readResultIn(bodies[1]!);
    expect(sent).toContain(REDACTED_TEXT);
    for (const b of bodies.slice(1)) {
      holdsNeither(JSON.stringify(b.messages), 'request to the provider');
      expect(readResultIn(b)).toBe(sent);
    }

    const row = await jobRow(db, jobId);
    holdsNeither(JSON.stringify(row.messages), 'agent_jobs.messages');
    holdsNeither(row.searchText ?? '', 'agent_jobs.search_text');
    expect(row.searchText ?? '').toContain('PORT=8080');
    const calls = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolName, 'file_read')));
    expect(calls).toHaveLength(1);
    holdsNeither(calls[0]!.toolOutput ?? '', 'tool_calls.tool_output');
    expect(calls[0]!.resultMasked).toBe(true);
  });

  it('a job suspended after the masked result resumes with the very text the provider received', async () => {
    const { jobId, agentSlug } = await seeded({
      model: 'anthropic/claude-sonnet-5.5',
      role: 'orchestrator',
      root: true,
      autonomy: 'propose_confirm',
    });
    const bodies = scriptProvider([
      { calls: [{ name: 'file_read', args: { path: 'settings.env', purpose: 'Read it.' } }] },
      { calls: [{ name: 'load_tools', args: { names: ['create_schedule'] } }] },
      {
        calls: [
          {
            name: 'create_schedule',
            args: {
              agentSlug,
              name: 'Digest',
              atTimes: ['09:00'],
              task: 'Send the digest.',
              purpose: 'The owner asked for it.',
            },
          },
        ],
      },
      { text: 'Done.' },
    ]);
    const deps = makeDeps(db);
    const suspended = await executeJob(jobId as JobId, deps, testEnv);
    expect(suspended.status).toBe('awaiting_approval');
    const beforeSuspend = readResultIn(bodies[1]!);
    const storedBefore = storedReadOf((await jobRow(db, jobId)).messages);
    holdsNeither(storedBefore, 'stored read before the suspension');

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, jobId), eq(approvalRequests.status, 'pending')));
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, jobId));
    const resolved = await resolveApprovalDecision(deps, testEnv, {
      answeredBy: { userId: '00000000-0000-4000-8000-00000000a11e' },
      approvalRequestId: pending!.id,
      decision: 'approve',
      resolvedBy: 'api',
    });
    expect(resolved.ok).toBe(true);
    const countBefore = bodies.length;
    await executeJob(jobId as JobId, deps, testEnv);

    const afterResume = bodies.slice(countBefore);
    expect(afterResume.length).toBeGreaterThan(0);
    for (const b of afterResume) {
      holdsNeither(JSON.stringify(b.messages), 'request after resume');
      expect(readResultIn(b), 'the resume replays another text').toBe(beforeSuspend);
    }
    // The stored message of the read is the same before and after the resume.
    expect(storedReadOf((await jobRow(db, jobId)).messages)).toBe(storedBefore);
  });
});
