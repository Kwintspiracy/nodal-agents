// conversation-audit-redaction.test.ts — les lignes d'audit qu'un fil de
// conversation passe au récapitulatif de livraison sont MASQUÉES.
//
// Reviewer C, passe 3 du 18/09 : ce chargeur ne masquait que la carte
// (`presented`) ; la sortie brute et l'entrée voyageaient telles quelles
// jusqu'à `buildConversationThread`. Aucun écran ne les rend AUJOURD'HUI — et
// c'est exactement le raisonnement qui avait laissé le trou de #150, où la
// carte était rendue en priorité sur une sortie déjà masquée.
//
// Ce test regarde la SEULE chose qui prouve la garde : ce que le chargeur
// remet au constructeur de fil. Il le remplace donc par un témoin, qui garde
// l'argument reçu. Sans cela le test serait vert quoi qu'il arrive — rien de
// ce que l'action rend aujourd'hui ne montre ces champs.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, conversations, toolCalls } from '@nodal-agents/db';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import type { ThreadJob } from '../conversation-thread.ts';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Les travaux tels que le chargeur les remet au constructeur de fil. */
const vus: { jobs: readonly ThreadJob[] } = { jobs: [] };

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

// Le témoin : il garde ce qu'on lui donne et rend un fil vide. Tout le reste du
// module (les types, `JOB_GONE_NOTE`…) passe tel quel.
vi.mock('../conversation-thread.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conversation-thread.ts')>();
  return {
    ...actual,
    buildConversationThread: (input: Parameters<typeof actual.buildConversationThread>[0]) => {
      vus.jobs = input.jobs;
      // Le fil lui-même n'est pas le sujet : on rend celui d'une conversation
      // SANS travail, donc des totaux à zéro, par la vraie fonction.
      return actual.buildConversationThread({ ...input, jobs: [] });
    },
  };
});

const actions = () => import('../conversation-actions.ts');

/** Une clé factice, de la forme que le masqueur reconnaît. */
const CLE = 'sk-ant-api03-AUDITAUDITAUDITAUDITAUDITAUDIT1234'; // secrets:allow (fixture : clé factice)
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
      title: 'Audit',
      origin: 'user',
      channel: 'telegram',
      chatId: 'audit-1',
    })
    .returning({ id: conversations.id });
  fil.id = conv!.id;

  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'audit-1',
      conversationId: fil.id,
      task: 'Lis la configuration',
      status: 'completed',
      result: 'Fait.',
      messages: [],
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });

  // La ligne d'audit porte la clé AUX TROIS ENDROITS où elle peut se lire.
  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: job!.id,
    toolName: 'cli:Bash',
    toolInput: { command: `curl -H "x: ${CLE}" https://api` },
    toolOutput: `200 OK — la clé ${CLE} est encore dans le log`,
    durationMs: 12,
    turn: 1,
    toolCallId: 'c_audit',
    card: 'text',
    presented: { card: 'text', text: `posé avec ${CLE}` },
  });
});

describe('le fil d’une conversation masque ses lignes d’audit @cap:suivre-execution/moteur', () => {
  it('la clé n’atteint ni la sortie brute, ni l’entrée, ni la carte', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(fil.id);
    expect(r.ok).toBe(true);

    const audit = vus.jobs.flatMap((j) => j.audit);
    expect(audit, 'le chargeur a bien remis une ligne d’audit').toHaveLength(1);
    const ligne = audit[0]!;
    expect(JSON.stringify(ligne)).not.toContain(CLE);
    expect(ligne.toolOutput).toContain(REDACTED_TEXT);
    expect(JSON.stringify(ligne.toolInput)).toContain(REDACTED_TEXT);
    expect(JSON.stringify(ligne.presented)).toContain(REDACTED_TEXT);
    // Le nom de l'outil traverse intact : c'est un nom, pas une valeur.
    expect(ligne.toolName).toBe('cli:Bash');
  });
});
