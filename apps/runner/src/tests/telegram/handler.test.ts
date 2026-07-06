// handler.test.ts — handleTelegramUpdate creates jobs from updates,
// filters group chat noise, and routes /ask <slug> to the right agent.

import { mkdtemp, writeFile, utimes, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents, telegramAllowedChats } from '@nodal-agents/db';
import type { TelegramUpdate } from '@nodal-agents/delivery';
import { handleTelegramUpdate, pruneTelegramWorkspace } from '../../telegram/handler.ts';
import type { RunnerDeps } from '../../deps.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

// The job-creation / routing / filter tests below are not about H-1 authorization
// — so make the chats they use already-authorized, turning the new inbound
// allowlist check into a pass-through for them. The authorization behavior
// itself is covered by its own describe block (with a fresh agent) at the end.
beforeEach(async () => {
  await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  await db.insert(telegramAllowedChats).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '1',
      role: 'owner',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '555',
      role: 'member',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '999',
      role: 'member',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '-100123',
      role: 'member',
      status: 'active',
    },
  ]);
});

function privateMessage(text: string, chatId = 555): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, first_name: 'Alice', username: 'alice', is_bot: false },
      text,
    },
  };
}

function groupMessage(text: string, opts: { replyToBot?: boolean } = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: -100123, type: 'group' },
      from: { id: 7, first_name: 'Alice', is_bot: false },
      text,
      ...(opts.replyToBot ? { reply_to_message: { from: { is_bot: true } } } : {}),
    },
  };
}

describe('handleTelegramUpdate — private chats', () => {
  it('creates a telegram-channel job for the receiving agent', async () => {
    const result = await handleTelegramUpdate({
      update: privateMessage('hello world', 999),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.channel).toBe('telegram');
    expect(job?.task).toBe('hello world');
    expect(job?.chatId).toBe('999');
    expect(job?.agentId).toBe(seed.agentId);
    expect(job?.entityId).toBe(seed.entityId);
  });

  it('skips updates with no message body', async () => {
    const result = await handleTelegramUpdate({
      update: { update_id: 2 },
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'no_message' });
  });

  it('skips messages with no text', async () => {
    const result = await handleTelegramUpdate({
      update: {
        update_id: 3,
        message: { message_id: 1, chat: { id: 555, type: 'private' } },
      },
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'no_text' });
  });
});

describe('handleTelegramUpdate — group chats', () => {
  it('skips plain text in group chats (no command, no bot reply, no mention)', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('just chatting'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'group_filter' });
  });

  it('handles a reply to the bot in a group chat', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('thanks for the answer', { replyToBot: true }),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    // Group messages get the sender prefix so the agent knows who said what
    expect(job?.task).toContain('[Message from Alice');
    expect(job?.task).toContain('thanks for the answer');
  });

  it('handles @mention in a group chat (case-insensitive, mention stripped)', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('@Test_Bot dis bonjour'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.task).toContain('[Message from Alice');
    // The mention itself must be stripped — only the actual ask remains
    expect(job?.task).toContain('dis bonjour');
    expect(job?.task).not.toContain('@Test_Bot');
    expect(job?.task).not.toContain('@test_bot');
  });

  it('skips @mention with no payload (just "@bot")', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('@test_bot'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'mention_no_text' });
  });

  it('falls back to group_filter when bot username is unknown', async () => {
    // Bot configured but getMe never resolved username — should ignore
    // mention-shaped text rather than misroute it.
    const result = await handleTelegramUpdate({
      update: groupMessage('@some_other_bot do something'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: null,
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'group_filter' });
  });
});

describe('handleTelegramUpdate — /ask command', () => {
  it('routes /ask <slug> <text> to the named agent in the same entity', async () => {
    // Seed a second agent the user might want to /ask
    const [otherAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Other',
        slug: `ask-target-${Date.now()}`,
        personality: 'I am the target.',
      })
      .returning();
    expect(otherAgent).toBeDefined();

    const result = await handleTelegramUpdate({
      update: privateMessage(`/ask ${otherAgent!.slug} what is the time`),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.agentId).toBe(otherAgent!.id);
    expect(job?.task).toBe('what is the time');
  });

  it('skips /ask with no text payload', async () => {
    const result = await handleTelegramUpdate({
      update: privateMessage('/ask agent-x'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'ask_no_text' });
  });

  it('skips /ask <unknown-slug> rather than blindly creating a job', async () => {
    const result = await handleTelegramUpdate({
      update: privateMessage('/ask not-a-real-agent please help'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'ask_unknown_agent' });
  });

  it('refuses /ask <slug> when the slug belongs to a different entity', async () => {
    // Seed a user/entity/agent in a separate entity
    const [otherUser] = await db
      .insert((await import('@nodal-agents/db')).users)
      .values({ email: `ext-${Date.now()}@example.com` })
      .returning();
    const [otherEntity] = await db
      .insert((await import('@nodal-agents/db')).entities)
      .values({
        userId: otherUser!.id,
        name: 'Other Entity',
        slug: `ext-entity-${Date.now()}`,
      })
      .returning();
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        entityId: otherEntity!.id,
        name: 'Foreign',
        slug: `foreign-${Date.now()}`,
        personality: 'I belong elsewhere.',
      })
      .returning();

    const result = await handleTelegramUpdate({
      update: privateMessage(`/ask ${foreignAgent!.slug} hello`),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    // Cross-entity routing must be denied — agents in another workspace are
    // not reachable.
    expect(result).toEqual({ skipped: 'ask_unknown_agent' });
  });
});

describe('pruneTelegramWorkspace — F-13 bounded cleanup', () => {
  let workDir: string;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('never deletes the file of a job that has not reached a terminal state, even past the age cap', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nodalai-telegram-prune-'));

    // Two jobs: one still in flight (queued behind e.g. an approval), one done.
    const [activeJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 'active job',
        status: 'awaiting_approval',
      })
      .returning();
    const [doneJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 'done job',
        status: 'completed',
      })
      .returning();

    const activeFile = join(workDir, `${activeJob!.id}.jpg`);
    const doneFile = join(workDir, `${doneJob!.id}.jpg`);
    await writeFile(activeFile, Buffer.from([1, 2, 3]));
    await writeFile(doneFile, Buffer.from([4, 5, 6]));

    // Backdate BOTH files well past the age cap (30 days) — the only thing
    // that should save the active job's file is its job status, not its age.
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(activeFile, fortyDaysAgo, fortyDaysAgo);
    await utimes(doneFile, fortyDaysAgo, fortyDaysAgo);

    await pruneTelegramWorkspace(workDir, db as unknown as RunnerDeps['db']);

    const remaining = await readdir(workDir);
    // Before the fix: age alone decided deletion, and BOTH files (equally
    // old) would have been removed — including the active job's image.
    expect(remaining).toContain(`${activeJob!.id}.jpg`);
    expect(remaining).not.toContain(`${doneJob!.id}.jpg`);
  });

  it('deletes a file whose job no longer exists in the DB at all (purged)', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nodalai-telegram-prune-'));
    const orphanFile = join(workDir, `00000000-0000-0000-0000-000000000000.jpg`);
    await writeFile(orphanFile, Buffer.from([1, 2, 3]));
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(orphanFile, fortyDaysAgo, fortyDaysAgo);

    await pruneTelegramWorkspace(workDir, db as unknown as RunnerDeps['db']);

    const remaining = await readdir(workDir);
    expect(remaining).not.toContain('00000000-0000-0000-0000-000000000000.jpg');
  });

  it('enforces the 200-file cap among terminal jobs, evicting the oldest first', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nodalai-telegram-prune-'));

    const TOTAL = 205; // 5 over the module's TELEGRAM_WORKSPACE_MAX_FILES cap
    const jobs = await db
      .insert(agentJobs)
      .values(
        Array.from({ length: TOTAL }, (_, i) => ({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram' as const,
          task: `done job ${i}`,
          status: 'completed' as const,
        })),
      )
      .returning({ id: agentJobs.id });
    expect(jobs.length).toBe(TOTAL);

    const now = Date.now();
    for (const [i, job] of jobs.entries()) {
      const file = join(workDir, `${job.id}.jpg`);
      await writeFile(file, Buffer.from([i % 256]));
      // index 0 = oldest, index TOTAL-1 = newest — strictly increasing mtime.
      const mtime = new Date(now - (TOTAL - i) * 1000);
      await utimes(file, mtime, mtime);
    }

    await pruneTelegramWorkspace(workDir, db as unknown as RunnerDeps['db']);

    const remainingNames = new Set(await readdir(workDir));
    expect(remainingNames.size).toBe(200);
    // The 5 oldest (lowest index) were evicted; the 200 newest survive.
    const oldest5 = jobs.slice(0, 5);
    const newest200 = jobs.slice(5);
    for (const job of oldest5) {
      expect(remainingNames.has(`${job.id}.jpg`)).toBe(false);
    }
    for (const job of newest200) {
      expect(remainingNames.has(`${job.id}.jpg`)).toBe(true);
    }
  });
});

describe('handleTelegramUpdate — H-1 inbound authorization', () => {
  // A fresh agent per test so the top-level beforeEach (which seeds seed.agentId's
  // allowlist) never interferes: these tests own their bot's allowlist entirely.
  async function freshBot(): Promise<string> {
    const [row] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Auth Bot',
        slug: `auth-bot-${Date.now()}-${Math.floor(performance.now())}`,
        personality: 'p',
        role: 'agent',
        active: true,
      })
      .returning({ id: agents.id });
    return row!.id;
  }

  function dm(text: string, chatId: number): TelegramUpdate {
    return {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: chatId, type: 'private' },
        from: { id: 7, first_name: 'Bob', username: 'bob', is_bot: false },
        text,
      },
    };
  }

  const call = (agentId: string, update: TelegramUpdate) =>
    handleTelegramUpdate({
      update,
      receivingAgentId: agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'auth_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });

  it('first private DM with no owner claims ownership AND creates a job', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, dm('hi', 4001));
    expect(result.jobId).toBeDefined();

    const rows = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('owner');
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.chatId).toBe('4001');
  });

  it('an unknown chat when an owner exists creates NO job and asks the owner', async () => {
    const agentId = await freshBot();
    // Owner claims first.
    await call(agentId, dm('owner here', 4001));
    // A stranger DMs.
    const result = await call(agentId, dm('let me in', 4002));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerChatId: '4001',
      requesterChatId: '4002',
      requesterName: 'Bob',
    });

    // A pending row exists for the stranger; no job was created for chat 4002.
    const [pending] = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.chatId, '4002'));
    expect(pending?.status).toBe('pending');
    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, '4002'));
    expect(jobs).toHaveLength(0);
  });

  it('a repeat DM from an already-pending chat does NOT re-ask the owner', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner here', 4001));
    await call(agentId, dm('let me in', 4002)); // first ask
    const again = await call(agentId, dm('please?', 4002)); // repeat

    expect(again.jobId).toBeUndefined();
    expect(again.skipped).toBe('awaiting_authorization');
    expect(again.pendingAuth).toBeUndefined(); // no re-spam
  });

  it('an active member chat creates a job', async () => {
    const agentId = await freshBot();
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId,
      chatId: '4003',
      role: 'member',
      status: 'active',
    });
    const result = await call(agentId, dm('hello', 4003));
    expect(result.jobId).toBeDefined();
  });

  it('a group message with no owner is skipped (ownership needs a DM first)', async () => {
    const agentId = await freshBot();
    const result = await handleTelegramUpdate({
      update: {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: -4009, type: 'group' },
          from: { id: 7, first_name: 'Bob', is_bot: false },
          text: '/start',
        },
      },
      receivingAgentId: agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'auth_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('no_owner_group');
  });
});
