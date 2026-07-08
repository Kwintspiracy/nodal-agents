// backfill-conversation-ids.test.mjs — pure-function tests for the
// conversation_id backfill (migration 0059). No DB: computeConversationIds
// takes plain row arrays, so this exercises the exact grouping logic the
// live script runs, without needing a Postgres connection.
//
// Run from the repo root: npx vitest run scripts/tests/backfill-conversation-ids.test.mjs

import { describe, it, expect } from 'vitest';
import { computeConversationIds } from '../backfill-conversation-ids.mjs';

const IDLE_RESET_MS = 240 * 60_000; // matches the runner's default (4h)

const T0 = new Date('2026-06-01T10:00:00.000Z').getTime();
const iso = (ms) => new Date(ms).toISOString();

describe('computeConversationIds', () => {
  it('groups two telegram jobs in the same thread with a short gap into one conversation', () => {
    const jobs = [
      {
        id: 'job-1',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'c1',
        created_at: iso(T0),
        completed_at: iso(T0 + 60_000),
        conversation_id: null,
      },
      {
        id: 'job-2',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'c1',
        // 5 minutes after job-1 was delivered — well under the 4h reset.
        created_at: iso(T0 + 60_000 + 5 * 60_000),
        completed_at: null,
        conversation_id: null,
      },
    ];

    const { resolved, updates } = computeConversationIds(jobs, [], IDLE_RESET_MS);

    expect(resolved.get('job-1')).toBeTruthy();
    expect(resolved.get('job-2')).toBe(resolved.get('job-1'));
    expect(updates).toHaveLength(2);
  });

  it('starts a new conversation when the gap exceeds the idle-reset window', () => {
    const jobs = [
      {
        id: 'job-1',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'c1',
        created_at: iso(T0),
        completed_at: iso(T0 + 60_000),
        conversation_id: null,
      },
      {
        id: 'job-2',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'c1',
        // 5 hours after job-1 was delivered — past the 4h reset.
        created_at: iso(T0 + 60_000 + 5 * 60 * 60_000),
        completed_at: null,
        conversation_id: null,
      },
    ];

    const { resolved } = computeConversationIds(jobs, [], IDLE_RESET_MS);
    expect(resolved.get('job-2')).not.toBe(resolved.get('job-1'));
  });

  it('never mixes two different chat_id threads', () => {
    const jobs = [
      {
        id: 'job-1',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'chat-a',
        created_at: iso(T0),
        completed_at: iso(T0 + 1_000),
        conversation_id: null,
      },
      {
        id: 'job-2',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'chat-b',
        created_at: iso(T0 + 2_000),
        completed_at: null,
        conversation_id: null,
      },
    ];

    const { resolved } = computeConversationIds(jobs, [], IDLE_RESET_MS);
    expect(resolved.get('job-2')).not.toBe(resolved.get('job-1'));
  });

  it('a delegated child inherits its parent conversation_id', () => {
    const jobs = [
      {
        id: 'root',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'c1',
        created_at: iso(T0),
        completed_at: null,
        conversation_id: null,
      },
      {
        id: 'child',
        parent_job_id: 'root',
        entity_id: 'e1',
        agent_id: 'a2',
        channel: 'internal',
        chat_id: null,
        created_at: iso(T0 + 1_000),
        completed_at: null,
        conversation_id: null,
      },
    ];

    const { resolved } = computeConversationIds(jobs, [], IDLE_RESET_MS);
    expect(resolved.get('child')).toBe(resolved.get('root'));
    expect(resolved.get('child')).toBeTruthy();
  });

  it('a cron job with no parent and no chat_id stays null (not a conversation)', () => {
    const jobs = [
      {
        id: 'cron-1',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'cron',
        chat_id: null,
        created_at: iso(T0),
        completed_at: null,
        conversation_id: null,
      },
    ];

    const { resolved, updates } = computeConversationIds(jobs, [], IDLE_RESET_MS);
    expect(resolved.get('cron-1')).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('a dashboard escalation takes the real conversations.id via the chat_messages link', () => {
    const jobs = [
      {
        id: 'dash-1',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'dashboard',
        chat_id: null,
        created_at: iso(T0),
        completed_at: null,
        conversation_id: null,
      },
    ];
    const chatLinks = [{ job_id: 'dash-1', conversation_id: 'conv-real-123' }];

    const { resolved, updates } = computeConversationIds(jobs, chatLinks, IDLE_RESET_MS);
    expect(resolved.get('dash-1')).toBe('conv-real-123');
    expect(updates).toEqual([{ id: 'dash-1', conversationId: 'conv-real-123' }]);
  });

  it('idempotence: a second pass over already-backfilled rows produces zero updates', () => {
    const jobs = [
      {
        id: 'job-1',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'c1',
        created_at: iso(T0),
        completed_at: iso(T0 + 1_000),
        conversation_id: null,
      },
      {
        id: 'job-2',
        parent_job_id: null,
        entity_id: 'e1',
        agent_id: 'a1',
        channel: 'telegram',
        chat_id: 'c1',
        created_at: iso(T0 + 60_000),
        completed_at: null,
        conversation_id: null,
      },
    ];

    const first = computeConversationIds(jobs, [], IDLE_RESET_MS);
    expect(first.updates).toHaveLength(2);

    // Simulate the DB state after the first run's writes landed, then re-run.
    const jobsAfterFirstRun = jobs.map((j) => ({
      ...j,
      conversation_id: first.resolved.get(j.id),
    }));
    const second = computeConversationIds(jobsAfterFirstRun, [], IDLE_RESET_MS);

    expect(second.updates).toHaveLength(0);
    expect(second.resolved.get('job-1')).toBe(first.resolved.get('job-1'));
    expect(second.resolved.get('job-2')).toBe(first.resolved.get('job-2'));
  });
});
