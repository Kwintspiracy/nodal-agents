// gateway.test.ts — what the Discord gateway does on the MESSAGE after the
// handler's transaction commits: the only acknowledgement the runner gives a
// message is the `/stop` reaction (#602). A message sent while the
// conversation's work runs starts a reply turn (#531) and gets NO reaction:
// the agent answers it (Quentin, 30/09 — the 👀 said nothing the reply does
// not). The discord.js Client is replaced by a fake that keeps the listeners
// the gateway registers, so a message is fed through the real `onMessage`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, asc } from '@nodal-agents/db';
import { agentJobs, channelAllowedConversations, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../../../deps.ts';
import type { RunnerEnv } from '../../../env.ts';

const fake = vi.hoisted(() => ({
  listeners: new Map<string, (arg: unknown) => void>(),
}));

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  class FakeClient {
    user = { id: 'bot-user-1' };
    channels = { fetch: async () => null };
    on(event: string, listener: (arg: unknown) => void): this {
      fake.listeners.set(event, listener);
      return this;
    }
    login(): Promise<string> {
      return Promise.resolve('ok');
    }
    destroy(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, Client: FakeClient };
});

const { startDiscordGateway } = await import('../../../channels/discord/gateway.ts');
const { ChannelType, Events } = await import('discord.js');

const CHANNEL_ID = 'dm-gateway-1';

const testEnv = {
  WORKER_SECRET: 's',
  APP_URL: 'http://localhost:3099',
  PORT: 3099,
} as unknown as RunnerEnv;

function makeDeps(db: TestDb): RunnerDeps {
  return {
    db: db as unknown as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

/** A live discord.js Message, reduced to what the gateway reads, whose reactions are recorded. */
function fakeMessage(content: string, reactions: string[]): unknown {
  return {
    content,
    channelId: CHANNEL_ID,
    channel: { type: ChannelType.DM },
    author: { id: 'u1', bot: false, username: 'bob', globalName: 'Bob' },
    mentions: {
      users: new Map<string, unknown>(),
      roles: { find: () => undefined },
      repliedUser: null,
    },
    attachments: new Map<string, unknown>(),
    react: async (emoji: string) => {
      reactions.push(emoji);
    },
  };
}

describe('Discord gateway: a message sent while the work runs gets no reaction, /stop keeps its own @cap:parler-par-canal-externe/moteur', () => {
  let db: TestDb;
  let seed: { entityId: string; agentId: string };
  let workerWakes: string[];

  beforeEach(async () => {
    db = (await spinUpTestDb()).db;
    const minimal = await seedMinimal(db);
    seed = { entityId: minimal.entityId, agentId: minimal.agentId };
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      conversationId: CHANNEL_ID,
      role: 'owner',
      status: 'active',
    });
    workerWakes = [];
    // triggerJobWorker wakes the worker over HTTP: record it, the runner isn't up.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      workerWakes.push(String(init?.body ?? input));
      return Promise.resolve(new Response('ok'));
    });
    fake.listeners.clear();
    startDiscordGateway({
      agentId: seed.agentId,
      agentEntityId: seed.entityId,
      botToken: 'tok',
      deps: makeDeps(db),
      env: testEnv,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Feed `content` through the gateway's messageCreate listener and wait until it has fully run. */
  async function send(content: string, reactions: string[]): Promise<void> {
    const onMessageCreate = fake.listeners.get(Events.MessageCreate);
    expect(onMessageCreate).toBeDefined();
    const jobsBefore = (await db.select({ id: agentJobs.id }).from(agentJobs)).length;
    onMessageCreate!(fakeMessage(content, reactions));
    // The listener is fire-and-forget. A job-creating message is done once its
    // worker is woken, and the reaction step follows in the same tick.
    await vi.waitFor(async () => {
      const jobs = await db.select({ id: agentJobs.id }).from(agentJobs);
      expect(jobs.length).toBeGreaterThan(jobsBefore);
      expect(workerWakes.length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function threadJobs(): Promise<Array<{ task: string; answersWhileJobId: string | null }>> {
    return db
      .select({ task: agentJobs.task, answersWhileJobId: agentJobs.answersWhileJobId })
      .from(agentJobs)
      .where(eq(agentJobs.channel, 'discord'))
      .orderBy(asc(agentJobs.createdAt));
  }

  it('a message at rest and a message during the work both start a turn, and neither is reacted to', async () => {
    const reactions: string[] = [];

    await send('Cherche le changelog de la 0.9.2', reactions);
    workerWakes.length = 0;
    // The first job is still alive (pending): the second message arrives during it.
    await send('Et mets-le dans le dossier partagé', reactions);

    const jobs = await threadJobs();
    expect(jobs.map((j) => j.task)).toEqual([
      'Cherche le changelog de la 0.9.2',
      'Et mets-le dans le dossier partagé',
    ]);
    // The second is a reply turn answering while the first runs (#531)...
    expect(jobs[0]!.answersWhileJobId).toBeNull();
    const [head] = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.task, 'Cherche le changelog de la 0.9.2'));
    expect(jobs[1]!.answersWhileJobId).toBe(head!.id);
    // ...and the runner put nothing on either message: the agent answers.
    expect(reactions).toEqual([]);
  });

  it('/stop still stops the running work and is acknowledged by its reaction', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'discord',
        chatId: CHANNEL_ID,
      })
      .returning({ id: conversations.id });
    const [run] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'discord',
        chatId: CHANNEL_ID,
        conversationId: conv!.id,
        status: 'processing',
        task: 'Je relance la recherche',
      })
      .returning({ id: agentJobs.id });

    const reactions: string[] = [];
    const onMessageCreate = fake.listeners.get(Events.MessageCreate);
    onMessageCreate!(fakeMessage('/stop', reactions));
    await vi.waitFor(() => expect(reactions).toEqual(['👌']));

    const jobs = await db
      .select({ id: agentJobs.id, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.channel, 'discord'));
    expect(jobs).toEqual([{ id: run!.id, status: 'cancelled' }]);
  });
});
