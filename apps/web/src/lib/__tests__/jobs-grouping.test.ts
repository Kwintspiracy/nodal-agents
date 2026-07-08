// jobs-grouping.test.ts — pure unit tests for the Jobs page conversation
// grouping (migration 0059). No DB, no mocks: groupJobsForJobsPage only
// takes plain DelegationRunRow[] and returns JobsPageRow[].

import { describe, it, expect } from 'vitest';
import { groupJobsForJobsPage } from '../jobs-grouping.ts';
import type { DelegationRunRow } from '../actions.ts';

let n = 0;
function makeRow(overrides: Partial<DelegationRunRow> = {}): DelegationRunRow {
  n++;
  return {
    id: `job-${n}`,
    agentName: 'Alfred',
    agentSlug: 'alfred',
    agentAvatarUrl: null,
    role: 'standalone',
    fromAgentName: null,
    task: `task ${n}`,
    channel: 'telegram',
    status: 'completed',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.01,
    createdAt: new Date(2026, 5, 1, 10, n),
    completedAt: new Date(2026, 5, 1, 10, n, 30),
    conversationId: null,
    toolsUsed: [],
    ...overrides,
  };
}

describe('groupJobsForJobsPage', () => {
  it('collapses chat-classified jobs sharing a conversation_id into one conversation row', () => {
    const conversationId = 'conv-1';
    // rows arrive desc(createdAt) — most recent first, like listDelegationRunsAction.
    const rows = [
      makeRow({ id: 'j3', conversationId, toolsUsed: ['telegram_send_message'] }),
      makeRow({ id: 'j2', conversationId, toolsUsed: ['query_memory', 'telegram_send_message'] }),
      makeRow({ id: 'j1', conversationId, toolsUsed: [] }),
    ];

    const grouped = groupJobsForJobsPage(rows);

    expect(grouped).toHaveLength(1);
    const row = grouped[0]!;
    expect(row.kind).toBe('conversation');
    if (row.kind === 'conversation') {
      expect(row.conversationId).toBe(conversationId);
      expect(row.exchangeCount).toBe(3);
      expect(row.jobs.map((j) => j.id)).toEqual(['j3', 'j2', 'j1']);
    }
  });

  it('leaves a task job as its own row even when it has a conversation_id', () => {
    const conversationId = 'conv-2';
    const rows = [makeRow({ id: 'j1', conversationId, toolsUsed: ['run_command'] })];

    const grouped = groupJobsForJobsPage(rows);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.kind).toBe('job');
    if (grouped[0]!.kind === 'job') {
      expect(grouped[0]!.job.id).toBe('j1');
      expect(grouped[0]!.job.conversationId).toBe(conversationId);
    }
  });

  it('leaves jobs with no conversation_id ungrouped (one row each)', () => {
    const rows = [
      makeRow({ id: 'j1', conversationId: null, toolsUsed: [] }),
      makeRow({ id: 'j2', conversationId: null, toolsUsed: [] }),
    ];

    const grouped = groupJobsForJobsPage(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped.every((r) => r.kind === 'job')).toBe(true);
  });

  it('a conversation with a mix of chat and task jobs: chat jobs collapse, task job stays separate', () => {
    const conversationId = 'conv-3';
    const rows = [
      makeRow({ id: 'j3', conversationId, toolsUsed: ['run_command'] }), // task
      makeRow({ id: 'j2', conversationId, toolsUsed: ['telegram_send_message'] }), // chat
      makeRow({ id: 'j1', conversationId, toolsUsed: [] }), // chat
    ];

    const grouped = groupJobsForJobsPage(rows);

    // j3 (task) is its own row; j2+j1 (chat) collapse into one conversation row.
    expect(grouped).toHaveLength(2);
    const [first, second] = grouped;
    expect(first!.kind).toBe('job'); // j3 comes first (most recent)
    expect(second!.kind).toBe('conversation');
    if (second!.kind === 'conversation') {
      expect(second!.exchangeCount).toBe(2);
      expect(second!.jobs.map((j) => j.id)).toEqual(['j2', 'j1']);
    }
  });

  it('never groups a delegated job — it keeps rendering under its orchestrator', () => {
    const conversationId = 'conv-4';
    const rows = [
      makeRow({
        id: 'child',
        role: 'delegated',
        fromAgentName: 'Orchestrator',
        conversationId,
        toolsUsed: [],
      }),
      makeRow({ id: 'root', role: 'orchestrator', conversationId, toolsUsed: [] }),
    ];

    const grouped = groupJobsForJobsPage(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped.find((r) => r.kind === 'job' && r.job.id === 'child')).toBeDefined();
  });

  it('aggregates status: any failed → failed', () => {
    const conversationId = 'conv-5';
    const rows = [
      makeRow({ id: 'j2', conversationId, status: 'failed', toolsUsed: [] }),
      makeRow({ id: 'j1', conversationId, status: 'completed', toolsUsed: [] }),
    ];
    const grouped = groupJobsForJobsPage(rows);
    const row = grouped[0]!;
    expect(row.kind).toBe('conversation');
    if (row.kind === 'conversation') expect(row.status).toBe('failed');
  });

  it('aggregates status: any running (no failure) → running', () => {
    const conversationId = 'conv-6';
    const rows = [
      makeRow({ id: 'j2', conversationId, status: 'processing', toolsUsed: [] }),
      makeRow({ id: 'j1', conversationId, status: 'completed', toolsUsed: [] }),
    ];
    const grouped = groupJobsForJobsPage(rows);
    const row = grouped[0]!;
    expect(row.kind).toBe('conversation');
    if (row.kind === 'conversation') expect(row.status).toBe('running');
  });

  it('aggregates total cost and tokens across the conversation', () => {
    const conversationId = 'conv-7';
    const rows = [
      makeRow({
        id: 'j2',
        conversationId,
        costUsd: 0.02,
        inputTokens: 200,
        outputTokens: 100,
        toolsUsed: [],
      }),
      makeRow({
        id: 'j1',
        conversationId,
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        toolsUsed: [],
      }),
    ];
    const grouped = groupJobsForJobsPage(rows);
    const row = grouped[0]!;
    expect(row.kind).toBe('conversation');
    if (row.kind === 'conversation') {
      expect(row.totalCostUsd).toBeCloseTo(0.03);
      expect(row.totalTokens).toBe(450);
    }
  });
});
