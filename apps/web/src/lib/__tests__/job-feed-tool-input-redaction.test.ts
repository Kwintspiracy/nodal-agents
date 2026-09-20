// job-feed-tool-input-redaction.test.ts — les lignes d'outils du FIL passent
// par la même porte de rédaction que celles de la page de run (#212).
//
// Le trou : `assembleJobFeeds` masquait `toolOutput` et `presented` (#150) et
// laissait `toolInput` traverser brut jusqu'à `buildConversationFeed`. Aucun
// écran ne rend ce champ aujourd'hui — le fil affiche l'entrée de la
// TRANSCRIPTION, déjà masquée par `redactTranscriptForDisplay` — et c'est
// exactement le raisonnement qui avait laissé le trou de #150, où la carte
// était rendue en priorité sur une sortie déjà masquée.
//
// Ce test regarde donc la SEULE chose qui prouve la garde : ce que le fil
// remet au constructeur. Il remplace `buildConversationFeed` par un témoin qui
// garde ses lignes d'outils. Sans ce témoin le test serait vert quoi qu'il
// arrive, puisque rien de ce que le fil REND ne montre ce champ.
//
// Par l'ACTION, et non par `assembleJobFeeds` en direct : c'est le chemin que
// la page emprunte, et appeler la fonction interne aurait demandé de forcer le
// type de la base de test — le genre de raccourci qui fait passer un test là où
// le produit échoue.
//
// Mutation vérifiée : `toolInput` réintroduit brut après `redactAuditRow` → le
// premier cas rougit sur la clé retrouvée dans l'entrée.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, conversations, toolCalls, eq } from '@nodal-agents/db';
import { REDACTED_TEXT } from '@nodal-agents/shared';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

/** Les lignes d'outils telles que le fil les remet au constructeur. */
const vues: { rows: readonly { toolInput: unknown; toolOutput: string | null }[] } = { rows: [] };

// Le témoin : il garde les lignes reçues et laisse le vrai assemblage se faire.
vi.mock('../conversation-feed.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conversation-feed.ts')>();
  return {
    ...actual,
    buildConversationFeed: (
      ...args: Parameters<typeof actual.buildConversationFeed>
    ): ReturnType<typeof actual.buildConversationFeed> => {
      vues.rows = args[1];
      return actual.buildConversationFeed(...args);
    },
  };
});

/** Une clé factice, de la forme réelle d'un jeton Anthropic. */
const CLE = 'sk-ant-api03-FEEDFEEDFEEDFEEDFEEDFEEDFEED5678'; // secrets:allow (fixture : clé factice)

const travail = { id: '' };
const fil = { id: '' };

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Appel d’API',
      origin: 'user',
      channel: 'telegram',
      chatId: 'feed-212',
    })
    .returning({ id: conversations.id });
  fil.id = conv!.id;

  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'feed-212',
      conversationId: fil.id,
      task: 'Appelle l’API',
      status: 'completed',
      result: 'Fait.',
      messages: [],
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });
  travail.id = job!.id;

  // La clé est posée AUX TROIS ENDROITS où la ligne se lit.
  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: travail.id,
    toolName: 'run_command',
    toolInput: { command: `curl -H "authorization: Bearer ${CLE}" https://api.example` },
    toolOutput: `200 OK — la clé ${CLE} est encore dans le log`,
    durationMs: 12,
    turn: 1,
    toolCallId: 'c_feed_212',
    card: 'text',
    presented: { card: 'text', text: `lancé avec ${CLE}` },
  });
});

describe('le fil d’un travail masque ses lignes d’outils @cap:suivre-execution/moteur', () => {
  it('la clé n’atteint ni l’entrée, ni la sortie brute, ni la carte', async () => {
    const { getConversationThreadAction } = await import('../conversation-actions.ts');
    const r = await getConversationThreadAction(fil.id);
    expect(r.ok, 'le fil s’assemble').toBe(true);

    expect(vues.rows, 'le fil a bien remis une ligne d’outil').toHaveLength(1);
    const ligne = vues.rows[0]!;
    // Le fait que l'issue nomme : `toolInput` sortait brut.
    expect(JSON.stringify(ligne.toolInput)).not.toContain(CLE);
    expect(JSON.stringify(ligne.toolInput)).toContain(REDACTED_TEXT);
    // Et les deux champs gardés depuis #150 le restent.
    expect(JSON.stringify(ligne)).not.toContain(CLE);
    expect(ligne.toolOutput).toContain(REDACTED_TEXT);
  });

  it('la ligne STOCKÉE reste intacte — le runner la relit pour reprendre', async () => {
    const [stockee] = await testDb
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.toolCallId, 'c_feed_212'));
    expect(JSON.stringify(stockee!.toolInput)).toContain(CLE);
  });
});
