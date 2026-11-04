// spoken-announcement.test.ts — ce que l'agent dit quand un job lancé par la voix finit (#967).
//
// Ce qui se prouve, sur une vraie base : la consigne de l'annonce porte la
// personnalité de l'agent, le fait que ce qu'il écrit est dit, et APRÈS le
// résultat cité tel qu'en base, la règle : un résultat court se dit, un
// document ne se raconte jamais (ni résumé, ni chiffre, ni constat), il est
// prêt, où le lire, et l'offre des canaux où la personne est VRAIMENT
// joignable, lus dans les liaisons de l'agent — jamais une liste du code.
// Les trois jobs du rejeu du 04/11 sont les fixtures (fixtures/
// spoken-announcement-jobs.json) : f7aecffd (le rapport de 3 737 caractères),
// 22720a8c et 3b33bf31 (deux résultats courts).
//
// Mutations vérifiées : voir le corps de la PR #967.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  channelAllowedConversations,
  channelBindings,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { buildSpokenAnnouncement, reachableChannels } from '../spoken-announcement';
import type { AnyDrizzleDb } from '../types';
import JOBS from './fixtures/spoken-announcement-jobs.json';

let db: TestDb;
let entityId = '';

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  ({ entityId } = await seedMinimal(db));
});

async function newAgent(): Promise<string> {
  const [a] = await db
    .insert(agents)
    .values({
      entityId,
      name: 'Alfred',
      slug: `alfred-${Math.random().toString(36).slice(2, 10)}`,
      personality: 'You are Alfred.',
      role: 'orchestrator',
    })
    .returning({ id: agents.id });
  return a!.id;
}

const binding = (agentId: string, channel: string, enabled = true) =>
  db.insert(channelBindings).values({
    entityId,
    agentId,
    channel,
    credentials: JSON.stringify({ botToken: 'fake' }),
    enabled,
  });

describe('the spoken announcement of a finished voice job (#967) @cap:parler-a-un-agent/moteur', () => {
  it('names only the channels where a send arrives: enabled, with an approved conversation', async () => {
    const agentId = await newAgent();
    await binding(agentId, 'telegram');
    await db
      .insert(telegramAllowedChats)
      .values({ entityId, agentId, chatId: 'owner-chat', role: 'owner', status: 'active' });
    await binding(agentId, 'discord');
    await db.insert(channelAllowedConversations).values({
      entityId,
      agentId,
      channel: 'discord',
      conversationId: 'dm-1',
      role: 'owner',
      status: 'active',
    });
    // A binding with no approved conversation: a send reaches nobody.
    await binding(agentId, 'whatsapp');
    await db.insert(channelAllowedConversations).values({
      entityId,
      agentId,
      channel: 'whatsapp',
      conversationId: 'pending-1',
      status: 'pending',
    });
    // A disabled binding, with an approved conversation.
    await binding(agentId, 'slack', false);
    await db.insert(channelAllowedConversations).values({
      entityId,
      agentId,
      channel: 'slack',
      conversationId: 'C1',
      role: 'owner',
      status: 'active',
    });

    expect(await reachableChannels(db as unknown as AnyDrizzleDb, agentId)).toEqual([
      'telegram',
      'discord',
    ]);
    // Another agent's bindings are not this agent's.
    expect(await reachableChannels(db as unknown as AnyDrizzleDb, await newAgent())).toEqual([]);
  });

  for (const job of JOBS) {
    it(`job ${job.job} (${job.kind}): the result is quoted whole, and the rule comes AFTER it`, () => {
      const { system, prompt } = buildSpokenAnnouncement({
        personality: 'You are Alfred.\n\n{{team}}',
        channels: ['telegram', 'discord', 'slack'],
        request: job.request,
        result: job.result,
      });
      expect(system).toBe(
        'You are Alfred.\n\n## Announcement\n' +
          'The work the person asked you for has just finished. You are now telling them, out ' +
          'loud: what you write is turned into speech and heard, not read.',
      );
      // The voice turn's rendering line is not reused: its "while the rest is
      // still being written" invites a rest an announcement does not have.
      expect(system).not.toContain('rendering:');
      expect(prompt).toBe(
        `The person asked:\n${job.request.trim()}\n\n` +
          'The result of the work, written in the conversation where they can read it:\n' +
          `<<<\n${job.result.trim()}\n>>>\n\n` +
          'Write only what you say to them now, in the language of their request.\n' +
          '- If the result is a short answer (a fact, a confirmation, a sentence or two), say it ' +
          'in plain spoken words. Never say a web address, a file path or markup.\n' +
          '- Otherwise it is a document. Do not tell them what it says: no summary, no finding, ' +
          'no number, no name from it. Say only that it is ready, that they can read it in Nodal, ' +
          'and offer to send it to them on telegram or discord or slack. Two short sentences at most.',
      );
      // The rule is the last thing the model reads, after the whole result.
      expect(prompt.indexOf(job.result.trim())).toBeLessThan(
        prompt.indexOf('Write only what you say'),
      );
      expect(prompt.endsWith('Two short sentences at most.')).toBe(true);
    });
  }

  it('no reachable channel: none is named, and the document is only said ready, where to read it', () => {
    const { prompt } = buildSpokenAnnouncement({
      personality: 'You are Alfred.',
      channels: [],
      request: JOBS[0]!.request,
      result: JOBS[0]!.result,
    });
    expect(prompt).toContain(
      'that they can read it in Nodal, and nothing else: there is no channel you can send it on.',
    );
    expect(prompt.split('>>>')[1]).not.toMatch(/telegram|slack|discord|whatsapp/i);
  });
});
