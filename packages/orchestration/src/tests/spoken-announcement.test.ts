// spoken-announcement.test.ts — ce que l'agent dit quand un job lancé par la voix finit (#967).
//
// Ce qui se prouve, sur une vraie base : la consigne de l'annonce porte la
// personnalité de l'agent, la forme entendue (la ligne même du tour vocal),
// la règle « un résultat court se dit, un document ne se lit jamais », et les
// canaux où la personne est VRAIMENT joignable, lus dans les liaisons de
// l'agent — jamais une liste du code. Le résultat est cité tel qu'en base.
//
// Mutations vérifiées (chacune rougit un cas) :
//   - `reachableChannels` sans le filtre `enabled` → « a disabled binding » ;
//   - sans le compte des conversations approuvées → « a binding with no
//     approved conversation » ;
//   - la ligne de forme retirée du système → « the announcement is heard ».

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

const RESULT =
  '**Microsoft layoffs: latest news**\n\n1. Voluntary Exit Offer (26 Oct 2026). ' +
  'Sources: NYT (https://www.nytimes.com/2026/10/26/technology/microsoft-buyouts-ai-spending.html)';

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

  it('the announcement is heard, in the agent’s own voice, and a document is offered, never read', () => {
    const { system, prompt } = buildSpokenAnnouncement({
      personality: 'You are Alfred.\n\n{{team}}',
      channels: ['telegram', 'discord'],
      request: 'Search the web for the latest news about Microsoft layoffs.',
      result: RESULT,
    });
    expect(system.startsWith('You are Alfred.\n\n## Job context\n')).toBe(true);
    expect(system).not.toContain('{{team}}');
    // The voice turn's own rendering line: one definition of what a voice carries.
    expect(system).toContain('- rendering: spoken — your reply is turned into speech and heard');
    const announcement = system.split('\n').find((l) => l.startsWith('- announcement:'));
    expect(announcement).toBeDefined();
    expect(announcement).toContain(
      'A short result (a fact, a confirmation, a sentence or two) is simply said.',
    );
    expect(announcement).toContain(
      'is never read out: say it is ready, that they can read it in Nodal',
    );
    expect(announcement).toContain('offer to send it to them on telegram or discord');
    // The request and the result are quoted as stored, never cut or picked.
    expect(prompt).toBe(
      'The person asked:\nSearch the web for the latest news about Microsoft layoffs.\n\n' +
        `The result of the work, as the conversation shows it:\n${RESULT}`,
    );
  });

  it('no reachable channel: no channel is named, and the announcement says only where to read', () => {
    const { system } = buildSpokenAnnouncement({
      personality: 'You are Alfred.',
      channels: [],
      request: 'Print the recipe.',
      result: 'Printed.',
    });
    expect(system).toContain(
      'there is no channel you can send it on, so say only where to read it',
    );
    for (const c of ['telegram', 'slack', 'discord', 'whatsapp']) expect(system).not.toContain(c);
  });
});
