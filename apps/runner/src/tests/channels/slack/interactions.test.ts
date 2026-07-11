// interactions.test.ts — Slack block_actions tap routing for approvals
// (apr:) and inbound-conversation authorization (sauth:). Focus: the
// SECURITY boundary — a tap only resolves when it comes from the delivering
// agent's OWNER conversation on channel='slack' AND targets a request owned
// by the polling agent. Resolution flips the real DB rows, asserted
// directly. Mirrors tests/channels/discord/interactions.test.ts's structure.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  approvalRequests,
  agentJobs,
  channelBindings,
  channelAllowedConversations,
} from '@nodal-agents/db';
import type { RunnerDeps } from '../../../deps.ts';
import type { RunnerEnv } from '../../../env.ts';
import { routeSlackInteraction } from '../../../channels/slack/interactions.ts';
import type { SlackInteractionAck } from '../../../channels/slack/types.ts';

// triggerWorker (resolveApprovalDecision's resume path) hits fetch — stub it
// to a generic ok so tests are hermetic.
vi.stubGlobal(
  'fetch',
  vi.fn(
    async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  ),
);

const OWNER_CHANNEL_ID = 'D-owner-dm-1';
const STRANGER_CHANNEL_ID = 'D-stranger-dm-1';

const env = {
  WORKER_SECRET: 'test-secret',
  APP_URL: 'http://localhost:3099',
} as unknown as RunnerEnv;

let db: TestDb;
let deps: RunnerDeps;
let seed: { entityId: string; agentId: string; jobId: string };

function makeAck(): SlackInteractionAck & { ephemeralCalls: string[]; resolveCalls: string[] } {
  const ephemeralCalls: string[] = [];
  const resolveCalls: string[] = [];
  return {
    ephemeralCalls,
    resolveCalls,
    async ephemeralReply(text: string) {
      ephemeralCalls.push(text);
    },
    async resolveCard(text: string) {
      resolveCalls.push(text);
    },
  };
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // The gated job must carry the conversation the card was delivered to (the
  // auth boundary, mirroring telegram's chat_id) and channel='slack'.
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval', channel: 'slack', chatId: OWNER_CHANNEL_ID })
    .where(eq(agentJobs.id, seed.jobId));

  // The agent's slack binding — resolveSlackApprovalTarget requires an
  // ENABLED binding to consider this agent a slack delivery point.
  await db.insert(channelBindings).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'slack',
    credentials: JSON.stringify({ botToken: 'xoxb-fake', appToken: 'xapp-fake' }),
    enabled: true,
  });

  // The bot OWNER of record — resolveSlackApprovalTarget resolves the card's
  // conversation from THIS row, never from agent_jobs.chat_id directly.
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'slack',
    conversationId: OWNER_CHANNEL_ID,
    kind: 'private',
    role: 'owner',
    status: 'active',
  });

  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
});

async function insertPendingApproval(toolName = 'run_command'): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName,
      toolInput: { command: 'rm -rf /tmp/x' },
      status: 'pending',
    })
    .returning();
  return row!.id;
}

describe('routeSlackInteraction — approval taps (apr:)', () => {
  it('a tap from the owner conversation resolves the approval and rewrites the card', async () => {
    const approvalId = await insertPendingApproval();
    const ack = makeAck();

    const result = await routeSlackInteraction({
      actionId: `apr:${approvalId}:a`,
      channelId: OWNER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack,
      deps,
      env,
    });

    expect(result).toMatchObject({ handled: true, kind: 'approval', decision: 'approve' });
    expect(ack.resolveCalls).toHaveLength(1);
    expect(ack.resolveCalls[0]).toContain('Approved');
    expect(ack.ephemeralCalls).toHaveLength(0);

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(approval?.status).toBe('approved');
    expect(approval?.resolvedBy).toBe('slack');
  });

  it('a tap from a NON-owner conversation is rejected and does NOT resolve the approval', async () => {
    const approvalId = await insertPendingApproval();
    const ack = makeAck();

    const result = await routeSlackInteraction({
      actionId: `apr:${approvalId}:a`,
      channelId: STRANGER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack,
      deps,
      env,
    });

    expect(result.handled).toBe(false);
    expect(ack.ephemeralCalls).toContain('Not authorized.');
    expect(ack.resolveCalls).toHaveLength(0);

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(approval?.status).toBe('pending');
  });

  it('a channel-kind tap is refused — approvals are DM-only', async () => {
    const approvalId = await insertPendingApproval();
    const ack = makeAck();

    const result = await routeSlackInteraction({
      actionId: `apr:${approvalId}:a`,
      channelId: OWNER_CHANNEL_ID,
      channelType: 'channel',
      receivingAgentId: seed.agentId,
      ack,
      deps,
      env,
    });

    expect(result).toEqual({ handled: false, reason: 'not_dm' });
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(approval?.status).toBe('pending');
  });

  it('an already-resolved approval is reported, not re-applied', async () => {
    const approvalId = await insertPendingApproval();
    // First tap resolves it.
    await routeSlackInteraction({
      actionId: `apr:${approvalId}:r`,
      channelId: OWNER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack: makeAck(),
      deps,
      env,
    });
    // A stale/second tap on the same card.
    const ack = makeAck();
    const result = await routeSlackInteraction({
      actionId: `apr:${approvalId}:a`,
      channelId: OWNER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack,
      deps,
      env,
    });
    expect(result).toEqual({ handled: false, reason: 'already_resolved' });
    expect(ack.ephemeralCalls[0]).toContain('Already rejected');
  });
});

describe('routeSlackInteraction — auth-confirmation taps (sauth:)', () => {
  async function insertPendingConversation(conversationId: string): Promise<string> {
    const [row] = await db
      .insert(channelAllowedConversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'slack',
        conversationId,
        kind: 'private',
        role: 'member',
        status: 'pending',
        requesterName: 'Carol',
      })
      .returning();
    return row!.id;
  }

  it('the owner allowing a pending conversation flips it active', async () => {
    const rowId = await insertPendingConversation('D-pending-convo-1');
    const ack = makeAck();

    const result = await routeSlackInteraction({
      actionId: `sauth:${rowId}:a`,
      channelId: OWNER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack,
      deps,
      env,
    });

    expect(result).toMatchObject({ handled: true, kind: 'auth', decision: 'allow' });
    expect(ack.resolveCalls[0]).toContain('autorisé');

    const [row] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.id, rowId));
    expect(row?.status).toBe('active');
  });

  it('a non-owner tap is refused and the row stays pending', async () => {
    const rowId = await insertPendingConversation('D-pending-convo-2');
    const ack = makeAck();

    const result = await routeSlackInteraction({
      actionId: `sauth:${rowId}:a`,
      channelId: STRANGER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack,
      deps,
      env,
    });

    expect(result).toEqual({ handled: false, reason: 'not_owner' });
    const [row] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.id, rowId));
    expect(row?.status).toBe('pending');
  });

  it('the owner denying a pending conversation deletes the row', async () => {
    const rowId = await insertPendingConversation('D-pending-convo-3');
    const ack = makeAck();

    await routeSlackInteraction({
      actionId: `sauth:${rowId}:d`,
      channelId: OWNER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack,
      deps,
      env,
    });

    const rows = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.id, rowId));
    expect(rows).toHaveLength(0);
  });

  it('an unrecognized actionId is not handled by either flow', async () => {
    const ack = makeAck();
    const result = await routeSlackInteraction({
      actionId: 'something:else:x',
      channelId: OWNER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack,
      deps,
      env,
    });
    expect(result).toEqual({ handled: false, reason: 'unknown_custom_id' });
  });
});

// Defense-in-depth: a slack approval tap must be scoped to the RECEIVING
// agent — a second agent's socket must never resolve another agent's approval.
describe('routeSlackInteraction — cross-agent defense in depth', () => {
  it('a tap arriving on a DIFFERENT agent than the delivery target is refused', async () => {
    const approvalId = await insertPendingApproval();
    const otherSeed = await seedMinimal(db);
    const ack = makeAck();

    const result = await routeSlackInteraction({
      actionId: `apr:${approvalId}:a`,
      channelId: OWNER_CHANNEL_ID,
      channelType: 'im',
      receivingAgentId: otherSeed.agentId,
      ack,
      deps,
      env,
    });

    expect(result).toEqual({ handled: false, reason: 'agent_mismatch' });
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(approval?.status).toBe('pending');
  });
});
