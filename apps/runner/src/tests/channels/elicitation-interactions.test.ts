// elicitation-interactions.test.ts — un appui sur la carte d'une question de
// serveur MCP (0145), reçu par les routeurs Discord et Slack (`eli:`), sur de
// vraies lignes en base. Les adaptateurs sont simulés à la frontière : ce qui
// est relu, c'est le brouillon en base, la carte réécrite (avec ses boutons)
// et ce que la personne lit (acquittement, réponse éphémère).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agentJobs,
  approvalRequests,
  approvalCardMessages,
  channelBindings,
} from '@nodal-agents/db';
import { elicitationCallbackData } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

const edits = vi.hoisted(
  () => [] as Array<{ channel: string; messageId: string; buttons: string[] }>,
);

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: (channel: string) => ({
      ...actual.getAdapter(channel as Parameters<typeof actual.getAdapter>[0]),
      editMessageText: async (
        _c: unknown,
        _conv: string,
        messageId: string,
        _text: string,
        buttons?: Array<Array<{ label: string }>>,
      ) => {
        edits.push({ channel, messageId, buttons: (buttons ?? []).flat().map((b) => b.label) });
        return { ok: true };
      },
    }),
  };
});

import { routeDiscordInteraction } from '../../channels/discord/interactions.ts';
import { routeSlackInteraction } from '../../channels/slack/interactions.ts';

const FORM = {
  type: 'object',
  properties: { duplex: { type: 'boolean', title: 'Two-sided' } },
};
const env = { WORKER_SECRET: 's', APP_URL: 'http://x' } as unknown as RunnerEnv;

let db: TestDb;
let deps: RunnerDeps;
let seed: { entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  deps = { db: db as unknown as RunnerDeps['db'] } as RunnerDeps;
  for (const channel of ['discord', 'slack']) {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      enabled: true,
      credentials: JSON.stringify({ botToken: `${channel}-token` }),
    });
  }
  await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, seed.jobId));
});

beforeEach(() => {
  edits.length = 0;
});

async function questionOn(channel: string, conversationId: string): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'printer__request_print',
      toolInput: { server: 'printer', message: 'Two-sided?', requestedSchema: FORM },
      kind: 'elicitation',
      status: 'pending',
      executedAt: new Date(),
    })
    .returning();
  await db.insert(approvalCardMessages).values({
    approvalRequestId: row!.id,
    channel,
    agentId: seed.agentId,
    conversationId,
    messageId: `${channel}-card`,
  });
  return row!.id;
}

async function draftOf(id: string): Promise<unknown> {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  return row!.draft;
}

function ack() {
  const said: string[] = [];
  let acknowledged = 0;
  return {
    said,
    get acknowledged() {
      return acknowledged;
    },
    async ephemeralReply(text: string) {
      said.push(text);
    },
    async resolveCard() {},
    async acknowledge() {
      acknowledged += 1;
    },
  };
}

describe('Discord : un appui sur la carte d’une question de serveur MCP @cap:approuver-une-action/moteur', () => {
  it('pose la valeur, réécrit la carte avec ses boutons, acquitte le geste', async () => {
    const id = await questionOn('discord', 'dm-1');
    const a = ack();
    const r = await routeDiscordInteraction({
      customId: elicitationCallbackData(id, { op: 'bool', field: 0, value: true }),
      channelId: 'dm-1',
      channelType: 'dm',
      receivingAgentId: seed.agentId,
      ack: a,
      deps,
      env,
    });
    expect(r).toEqual({ handled: true, kind: 'elicitation' });
    expect(a.acknowledged).toBe(1);
    expect(a.said).toEqual([]);
    expect(await draftOf(id)).toEqual({ values: { duplex: true }, awaiting: null });
    expect(edits).toEqual([
      {
        channel: 'discord',
        messageId: 'discord-card',
        buttons: ['✅ Confirm', 'Decline', '✓ Two-sided: Yes', 'Two-sided: No'],
      },
    ]);
  });

  it('un appui venu d’une autre conversation est refusé, à la personne seule', async () => {
    const id = await questionOn('discord', 'dm-1');
    const a = ack();
    const r = await routeDiscordInteraction({
      customId: elicitationCallbackData(id, { op: 'bool', field: 0, value: true }),
      channelId: 'dm-other',
      channelType: 'dm',
      receivingAgentId: seed.agentId,
      ack: a,
      deps,
      env,
    });
    expect(r).toEqual({ handled: false, reason: 'not_authorized' });
    expect(a.said).toEqual(['Not authorized.']);
    expect(await draftOf(id)).toBeNull();
  });
});

describe('Slack : un appui sur la carte d’une question de serveur MCP @cap:approuver-une-action/moteur', () => {
  it('pose la valeur et réécrit la carte avec ses boutons', async () => {
    const id = await questionOn('slack', 'D1');
    const a = ack();
    const r = await routeSlackInteraction({
      actionId: elicitationCallbackData(id, { op: 'bool', field: 0, value: false }),
      channelId: 'D1',
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack: a,
      deps,
      env,
    });
    expect(r).toEqual({ handled: true, kind: 'elicitation' });
    expect(await draftOf(id)).toEqual({ values: { duplex: false }, awaiting: null });
    expect(edits[0]).toMatchObject({ channel: 'slack', messageId: 'slack-card' });
  });

  it('Decline : refusé à la personne d’une autre conversation, tranché depuis la bonne', async () => {
    const id = await questionOn('slack', 'D1');
    const decline = elicitationCallbackData(id, { op: 'decline' });
    const stranger = ack();
    await routeSlackInteraction({
      actionId: decline,
      channelId: 'D2',
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack: stranger,
      deps,
      env,
    });
    expect(stranger.said).toEqual(['Not authorized.']);
    const owner = ack();
    await routeSlackInteraction({
      actionId: decline,
      channelId: 'D1',
      channelType: 'im',
      receivingAgentId: seed.agentId,
      ack: owner,
      deps,
      env,
    });
    expect(owner.said).toEqual(['Declined.']);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row!.status).toBe('rejected');
    expect(row!.resolvedBy).toBe('slack');
  });
});
