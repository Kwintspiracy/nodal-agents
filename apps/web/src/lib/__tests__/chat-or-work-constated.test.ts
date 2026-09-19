// chat-or-work-constated.test.ts — le verdict du fil lit le MÊME fait constaté
// que la primitive de vérification, sur une VRAIE base (#197).
//
// `chat-or-work.test.ts` prouve la RÈGLE, sur des lignes fabriquées. Ce
// fichier-ci prouve le CÂBLAGE : que le chargeur du fil va bien chercher
// `constated_writes` et le donne à la règle. Sans lui, la règle pourrait être
// juste et personne ne la nourrir — c'est exactement l'écart que l'issue
// nomme, où le verdict était calculé sur les CARTES et ignorait le constat.
//
// Par l'ACTION, sur une base éphémère, et les assertions portent sur le FIL
// RENDU — jamais sur des appels comptés (invariant #5).
//
// Mutation vérifiée : `constatedTurns` remplacé par un ensemble vide au point
// d'appel de `classifyProduction` → « une écriture constatée fait du tour un
// travail » rougit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, conversations, constatedWrites, toolCalls } from '@nodal-agents/db';

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

/** La conversation de chaque cas : c'est SON fil qui porte le verdict. */
const fils: Record<string, string> = {};

/** La carte que `run_command` remplit vraiment. */
const carteTerminal = (command: string) => ({
  card: 'terminal' as const,
  command,
  exitCode: 0,
  timedOut: false,
  stdoutTail: 'done',
  stdoutTruncated: false,
  stderrTail: '',
  stderrTruncated: false,
});

/** Une conversation, son travail, sa commande, et l'écriture constatée ou non. */
async function semer(opts: { cle: string; command: string; aEcrit: boolean }): Promise<void> {
  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: opts.cle,
      origin: 'user',
      channel: 'telegram',
      chatId: `constat-${opts.cle}`,
    })
    .returning({ id: conversations.id });
  fils[opts.cle] = conv!.id;

  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: `constat-${opts.cle}`,
      conversationId: conv!.id,
      task: 'Lance la commande',
      status: 'completed',
      result: 'Fait.',
      messages: [],
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });

  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: job!.id,
    toolName: 'run_command',
    toolInput: { command: opts.command },
    toolOutput: 'done',
    durationMs: 12,
    turn: 1,
    toolCallId: `c_${opts.cle}`,
    card: 'terminal',
    presented: carteTerminal(opts.command),
  });

  if (opts.aEcrit) {
    await testDb.insert(constatedWrites).values({
      jobId: job!.id,
      turn: 1,
      path: 'D:/projet/rapport.md',
      changeKind: 'added',
      constatedBy: 'git',
    });
  }
}

/** Le fil rendu porte-t-il un encart de production ? */
async function montreDuTravail(cle: string): Promise<boolean> {
  const { getConversationThreadAction } = await import('../conversation-actions.ts');
  const r = await getConversationThreadAction(fils[cle] ?? '');
  if (!r.ok) throw new Error(`${r.code} ${r.message}`);
  return r.data.feed.items.some((i) => i.kind === 'produced');
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  await semer({ cle: 'rien-ecrit', command: 'ls -la', aEcrit: false });
  await semer({ cle: 'a-ecrit', command: 'pnpm build', aEcrit: true });
});

describe('le verdict du fil lit l’écriture constatée @cap:verifier-un-livrable/moteur', () => {
  it('un tour shell qui n’a rien produit n’est PAS montré comme du travail', async () => {
    expect(await montreDuTravail('rien-ecrit')).toBe(false);
  });

  it('une écriture CONSTATÉE sur le même tour en fait un travail', async () => {
    expect(await montreDuTravail('a-ecrit')).toBe(true);
  });
});
