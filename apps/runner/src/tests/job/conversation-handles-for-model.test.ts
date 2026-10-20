// conversation-handles-for-model.test.ts — l'adresse du chat d'un job, telle
// qu'un modèle la lit (#824), sur une vraie base.
//
// `telegramChatOf` écrit le `telegram_chat_id` du bloc Job context, pour les
// DEUX runtimes (execute.ts, cli-runtime/run-job.ts) ; `jobChatForModel` écrit
// l'adresse de l'avis de livraison d'un délégué. Les deux nomment le chat par
// son HANDLE, jamais par l'identifiant du canal : un DM WhatsApp s'appelle par
// un numéro de téléphone.
//
// Le chemin API (executeJob) est prouvé de bout en bout dans execute.test.ts
// (« Brique 31 » et « delivery notice of a delegated child ») ; ici, le prompt
// d'un job en runtime CLI, construit par la même composition que run-job.ts.
//
// Mutation vérifiée : `telegramChatOf` rendant `{ telegramChatId: id }` (l'id
// brut) → « le prompt d'un job CLI » et « le handle du chat Telegram »
// rougissent.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, conversationHandleFor, eq, resolveConversationHandle } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { buildSystemPrompt } from '@nodal-agents/orchestration';
import type { Agent } from '@nodal-agents/orchestration';
import { CONVERSATION_HANDLE_RE } from '@nodal-agents/shared';
import { jobChatForModel, telegramChatOf } from '../../job/channel-delivery.ts';
import { buildCliRuntimeJobContext } from '../../cli-runtime/run-job.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
const any = () => db as unknown as AnyDrizzleDb;

const WA_DM = '33612345678@s.whatsapp.net';

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

describe('the job chat as a model reads it @cap:parler-par-canal-externe/moteur', () => {
  it('telegram_chat_id is the HANDLE of a chat resolved on Telegram', async () => {
    const ctx = await telegramChatOf(any(), seed.entityId, { id: '12345', channel: 'telegram' });
    expect(ctx.telegramChatId).toMatch(CONVERSATION_HANDLE_RE);
    expect(
      await resolveConversationHandle(any(), {
        entityId: seed.entityId,
        handle: ctx.telegramChatId!,
      }),
    ).toEqual({ channel: 'telegram', conversationId: '12345' });
  });

  it('a chat on another channel, or on none, is never presented as a Telegram chat (#649)', async () => {
    for (const channel of ['discord', 'slack', 'whatsapp', null]) {
      const ctx = await telegramChatOf(any(), seed.entityId, { id: '555', channel });
      expect({ channel, ctx }).toEqual({ channel, ctx: {} });
    }
    expect(await telegramChatOf(any(), seed.entityId, { id: null, channel: 'telegram' })).toEqual(
      {},
    );
  });

  it('the delivery-notice address is the handle, on every channel; a chat with no channel has none', async () => {
    for (const [channel, id] of [
      ['whatsapp', WA_DM],
      ['telegram', '12345'],
      ['discord', '1188000000000000001'],
    ] as const) {
      const address = await jobChatForModel(any(), seed.entityId, { id, channel });
      expect(address).toBe(
        await conversationHandleFor(any(), {
          entityId: seed.entityId,
          channel,
          conversationId: id,
        }),
      );
      expect(address).not.toContain(id.slice(0, 5));
    }
    expect(await jobChatForModel(any(), seed.entityId, { id: '12345', channel: null })).toBeNull();
    expect(
      await jobChatForModel(any(), seed.entityId, { id: null, channel: 'telegram' }),
    ).toBeNull();
  });

  it('two jobs, two agents of one entity: the same chat, the same handle', async () => {
    const [second] = await db
      .insert(agents)
      .values({ entityId: seed.entityId, name: 'Other bot', slug: 'other-bot', personality: 'p' })
      .returning();
    // L'agent ne fait pas partie de la clé : c'est l'entité qui possède la conversation.
    expect(second!.id).not.toBe(seed.agentId);
    const a = await telegramChatOf(any(), seed.entityId, { id: '777', channel: 'telegram' });
    const b = await telegramChatOf(any(), seed.entityId, { id: '777', channel: 'telegram' });
    expect(b).toEqual(a);
  });

  it('the prompt of a CLI-runtime job carries the handle, never the Telegram id', async () => {
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
    const prompt = await buildSystemPrompt(
      agentRow as unknown as Agent,
      any(),
      buildCliRuntimeJobContext({
        origin: 'telegram',
        deployment: { os: 'Linux', networkMode: 'loopback', authMode: 'local-trust' },
        task: 'hello',
        telegramChat: await telegramChatOf(any(), seed.entityId, {
          id: '4242424242',
          channel: 'telegram',
        }),
      }),
    );
    const handle = await conversationHandleFor(any(), {
      entityId: seed.entityId,
      channel: 'telegram',
      conversationId: '4242424242',
    });
    expect(prompt).toContain(`- telegram_chat_id: ${handle}`);
    expect(prompt).not.toContain('4242424242');
  });

  it('run-job.ts builds that context from telegramChatOf — the composition above is the real one', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'cli-runtime', 'run-job.ts'), 'utf8');
    expect(src).toMatch(
      /const telegramChat = await telegramChatOf\(db, job\.entityId \?\? null, \{/,
    );
    expect(src).toMatch(/buildCliRuntimeJobContext\(\{[\s\S]{0,300}?\btelegramChat,/);
  });
});
