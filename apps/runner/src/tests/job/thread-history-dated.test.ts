// thread-history-dated.test.ts — chaque tour rejoué porte sa date (#650).
//
// Le 30/09 à 23:07, Alfred a dit sur Telegram « le Researcher est hors
// service » : c'était vrai le 29/09 à 14:21, dans un tour que l'historique lui
// rejouait SANS date. Le prompt dit « maintenant » ; les tours rejoués étaient
// la seule partie du contexte qui ne disait pas QUAND. Ce fichier prouve que
// chaque message de la personne rejoué par `loadThreadHistory` porte l'heure où
// elle l'a envoyé, dans le fuseau que le prompt connaît, sous la forme même du
// « maintenant » du prompt (`formatLocalTime`) — sans cas « aujourd'hui », et à
// l'identique d'une construction à l'autre (le préfixe mis en cache ne bouge
// pas). Le chat web a son propre test : run-chat-turn.test.ts.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, conversations } from '@nodal-agents/db';
import type { ModelMessage } from 'ai';
import { formatLocalTime, inboxMessage } from '@nodal-agents/shared';
import { loadThreadHistory } from '../../job/thread-history.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(agentJobs);
  await db.delete(conversations);
});

async function conversation(channel: string, chatId: string): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel, chatId, origin: 'user' })
    .returning({ id: conversations.id });
  if (!row) throw new Error('insert conversation');
  return row.id;
}

async function turn(opts: {
  conversationId: string;
  channel: string;
  chatId: string;
  task: string;
  reply: string;
  at: Date;
  messages?: unknown[];
}): Promise<void> {
  await db.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: opts.channel,
    chatId: opts.chatId,
    conversationId: opts.conversationId,
    task: opts.task,
    status: 'completed',
    result: opts.reply,
    resultKind: 'prose',
    messages: (opts.messages ?? []) as never,
    createdAt: opts.at,
  });
}

function load(conversationId: string, channel: string, timezone: string) {
  return loadThreadHistory({
    db: db as unknown as Parameters<typeof loadThreadHistory>[0]['db'],
    conversationId,
    channel,
    excludeJobId: '00000000-0000-0000-0000-000000000000',
    timezone,
  });
}

/** Le texte des messages de la PERSONNE, dans l'ordre où le modèle les lit. */
function userTexts(history: ModelMessage[]): string[] {
  return history
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .filter((text) => !text.startsWith('[système]'));
}

// L'incident, heures réelles : 29/09 14:21 et 30/09 23:07 à Singapour.
const YESTERDAY = new Date('2026-09-29T06:21:00Z');
const TODAY = new Date('2026-09-30T15:07:00Z');

describe('loadThreadHistory — chaque tour rejoué porte sa date (#650) @cap:reprendre-conversation/moteur', () => {
  it.each(['telegram', 'whatsapp'])(
    '%s : deux jours de conversation, chaque demande porte son jour et son heure, dans le fuseau de la personne',
    async (channel) => {
      const conv = await conversation(channel, `c-${channel}`);
      await turn({
        conversationId: conv,
        channel,
        chatId: `c-${channel}`,
        task: 'Trouve et imprime une recette de caviar d’aubergines',
        reply: 'Le Researcher est bloqué (son LLM timeoute).',
        at: YESTERDAY,
      });
      await turn({
        conversationId: conv,
        channel,
        chatId: `c-${channel}`,
        task: 'Fais-moi une recherche sur les catacombes parisiennes',
        reply: 'Recherche terminée.',
        at: TODAY,
      });

      const history = await load(conv, channel, 'Asia/Singapore');

      expect(userTexts(history)).toEqual([
        `[${formatLocalTime('Asia/Singapore', YESTERDAY)}] Trouve et imprime une recette de caviar d’aubergines`,
        `[${formatLocalTime('Asia/Singapore', TODAY)}] Fais-moi une recherche sur les catacombes parisiennes`,
      ]);
      // Le fuseau est celui de la personne, pas celui du serveur ni UTC :
      // 06:21 UTC se lit 14:21 à Singapour, 15:07 UTC se lit 23:07.
      expect(userTexts(history)[0]).toMatch(/^\[[^\]]*29[^\]]*2026, 14:21\] /);
      expect(userTexts(history)[1]).toMatch(/^\[[^\]]*30[^\]]*2026, 23:07\] /);
      // La réponse de l'agent reste ses mots : aucune date dans sa bouche, sinon
      // il apprendrait à en écrire une en tête de ses réponses.
      const replies = JSON.stringify(history.filter((m) => m.role === 'assistant'));
      expect(replies).toContain('Le Researcher est bloqué (son LLM timeoute).');
      expect(replies).not.toContain('2026');
    },
  );

  it('le même historique lu dans un autre fuseau donne une autre heure : le fuseau vient de l’appelant', async () => {
    const conv = await conversation('telegram', 'paris');
    await turn({
      conversationId: conv,
      channel: 'telegram',
      chatId: 'paris',
      task: 'bonjour',
      reply: 'Bonjour !',
      at: YESTERDAY,
    });
    const history = await load(conv, 'telegram', 'Europe/Paris');
    expect(userTexts(history)).toEqual([`[${formatLocalTime('Europe/Paris', YESTERDAY)}] bonjour`]);
    expect(userTexts(history)[0]).toMatch(/, 08:21\] bonjour$/);
  });

  it('un tour de quelques minutes porte sa date lui aussi : pas de cas « aujourd’hui »', async () => {
    const conv = await conversation('telegram', 'now');
    const fewMinutesAgo = new Date(Date.now() - 4 * 60_000);
    await turn({
      conversationId: conv,
      channel: 'telegram',
      chatId: 'now',
      task: 'Il est quelle heure à Tokyo ?',
      reply: '00:08 à Tokyo.',
      at: fewMinutesAgo,
    });
    const history = await load(conv, 'telegram', 'Asia/Singapore');
    expect(userTexts(history)).toEqual([
      `[${formatLocalTime('Asia/Singapore', fewMinutesAgo)}] Il est quelle heure à Tokyo ?`,
    ]);
  });

  it('un message remis pendant le travail (#531) porte l’heure où il est arrivé, pas celle de la demande', async () => {
    const conv = await conversation('telegram', 'inbox');
    const receivedAt = new Date(YESTERDAY.getTime() + 25 * 60_000);
    await turn({
      conversationId: conv,
      channel: 'telegram',
      chatId: 'inbox',
      task: 'imprime la recette',
      reply: 'Imprimée.',
      at: YESTERDAY,
      messages: [
        { role: 'user', content: 'imprime la recette' },
        inboxMessage({
          id: 'e1',
          task: 'en couleur',
          content: 'en couleur',
          receivedAt: receivedAt.toISOString(),
        }),
      ],
    });
    const history = await load(conv, 'telegram', 'Asia/Singapore');
    expect(userTexts(history)).toEqual([
      `[${formatLocalTime('Asia/Singapore', YESTERDAY)}] imprime la recette`,
      `[${formatLocalTime('Asia/Singapore', receivedAt)}] en couleur`,
    ]);
    expect(userTexts(history)[1]).toMatch(/, 14:46\] en couleur$/);
  });

  it('deux constructions du même historique donnent le même texte, au caractère près', async () => {
    const conv = await conversation('telegram', 'stable');
    await turn({
      conversationId: conv,
      channel: 'telegram',
      chatId: 'stable',
      task: 'première demande',
      reply: 'première réponse',
      at: YESTERDAY,
    });
    await turn({
      conversationId: conv,
      channel: 'telegram',
      chatId: 'stable',
      task: 'deuxième demande',
      reply: 'deuxième réponse',
      at: TODAY,
    });
    const first = await load(conv, 'telegram', 'Asia/Singapore');
    const second = await load(conv, 'telegram', 'Asia/Singapore');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(userTexts(first)).toHaveLength(2);
  });
});
