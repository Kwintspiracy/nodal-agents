// stored-result-readers.test.ts — the engine's readers of stored tool results read a masked one.
//
// Since a tool result is masked at the seam, `tool_calls.tool_output` holds
// what the model saw, placeholder included. The engine reads that column back
// for facts, never for the hidden value: a review verdict (the delivery gate
// and the router), the path an edit wrote (the project registry, the Code
// tab), whether a call did nothing (a refused call). Each reader is run here
// on a row the REAL seam wrote, with a secret in it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, eq, toolCalls } from '@nodal-agents/db';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { fakeAlnum, fakeSecret } from '@nodal-agents/test-kit';
import { createToolRegistry, executeTool, registerBuiltins } from '@nodal-agents/tools';
import type { ApprovalRule, ToolContext, ToolDefinition } from '@nodal-agents/tools';
import { readFinalReviewVerdict, type JobId } from '@nodal-agents/orchestration';
import { scannedEditPath } from '../../job/code-projects.ts';

const registry = createToolRegistry();
registerBuiltins(registry);
const builtin = (name: string) => registry.get(name) as ToolDefinition<z.ZodTypeAny, unknown>;

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let dir = '';
let shaped = '';

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  shaped = fakeSecret('github', fakeAlnum(36));
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-readers-')));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const rows = (names: string[]): ApprovalRule[] =>
  names.map(
    (toolName) =>
      ({
        id: `rule-${toolName}`,
        toolName,
        action: 'auto_approve',
        agentId: seed.agentId,
        entityId: seed.entityId,
      }) as ApprovalRule,
  );

async function run(name: string, input: Record<string, unknown>, extra: string[] = []) {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'readers' })
    .returning();
  const ctx = {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: job!.id,
    jobChatId: null,
    workspaces: [{ label: 'ws', path: dir }],
    turn: 1,
  } as unknown as ToolContext;
  const res = await executeTool(builtin(name), input, ctx, {
    approvalRules: rows([name, 'replace_shared_file', ...extra]),
    onApprovalRequired: async () => {},
  });
  const [row] = await db.select().from(toolCalls).where(eq(toolCalls.jobId, job!.id));
  return { res, row: row!, jobId: job!.id };
}

describe('the engine’s readers of stored results read a masked one @cap:verifier-un-livrable/moteur', () => {
  it('a review verdict whose summary held a secret is still read as a verdict', async () => {
    const { row, jobId } = await run('review_verdict', {
      verdict: 'request_changes',
      summary: `The config commits a token: ${shaped}.`,
      findings: [{ file: 'config.env', line: 2, issue: `Remove ${shaped}.`, severity: 'blocker' }],
    });
    expect(row.toolOutput).not.toContain(shaped);
    expect(row.resultMasked).toBe(true);
    const verdict = await readFinalReviewVerdict(db as never, jobId as JobId);
    expect(verdict, 'the masked verdict is no longer read as a verdict').not.toBeNull();
    expect(verdict!.verdict).toBe('request_changes');
    expect(verdict!.summary).toBe(`The config commits a token: ${REDACTED_TEXT}.`);
    expect(verdict!.findings[0]!.file).toBe('config.env');
  });

  it('the path an edit wrote is read from a masked row', async () => {
    const { row } = await run('file_write', {
      path: 'notes.md',
      content: 'plain notes',
      purpose: 'Write notes.',
    });
    expect(scannedEditPath({ toolInput: row.toolInput, toolOutput: row.toolOutput })).toBe(
      'notes.md',
    );
  });
});
