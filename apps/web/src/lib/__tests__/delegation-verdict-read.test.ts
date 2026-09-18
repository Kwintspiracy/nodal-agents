// delegation-verdict-read.test.ts — le fil lit le verdict ENREGISTRÉ d'un
// délégué, sur une VRAIE base (#174).
//
// Le fil devinait le verdict d'une revue en lisant la première ligne du
// résultat du délégué. Depuis #170 l'outil `review_verdict` l'écrit typé dans
// `tool_calls`, validé par son schéma Zod : c'est cette ligne que
// `assembleJobFeeds` doit remonter, et la prose ne doit plus servir que de
// repli.
//
// Ce que seul un test sur base prouve : la ligne est bien LUE — la bonne, celle
// du dernier appel au sens de `seq` — et une ligne abîmée ne tue pas la
// conversation entière.
//
// Les assertions portent sur le fil rendu, jamais sur des appels comptés
// (invariant #5).
//
// Mutations vérifiées : le tri `desc(seq)` remplacé par `desc(createdAt)` →
// « garde le DERNIER appel » rougit ; le `try/catch` retiré autour du parseur →
// « une ligne abîmée n'emporte pas le fil » rougit ; la lecture retirée →
// les trois premiers cas rougissent.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, toolCalls } from '@nodal-agents/db';
import { REVIEW_VERDICT_TOOL } from '@nodal-agents/orchestration';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
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
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

/** Le parent de chaque cas : c'est SON fil qui porte la délégation. */
const parents: Record<string, string> = {};

/** La sortie que l'outil écrit quand il a validé un verdict. */
function sortieVerdict(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    verdict: 'request_changes',
    summary: 'Deux gardes manquent.',
    findings: [],
    counts: { blocker: 2, major: 0, minor: 1 },
    ...over,
  });
}

/** Un parent, son délégué, et ce que le délégué a écrit. */
async function semerDelegation(opts: {
  cle: string;
  resultatEnfant: string | null;
  appels?: Array<{ toolOutput: string | null; toolName?: string }>;
}): Promise<string> {
  const [parent] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: `orchestre la revue (${opts.cle})`,
      status: 'completed',
    })
    .returning({ id: agentJobs.id });
  parents[opts.cle] = parent!.id;

  const [enfant] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'relis la PR',
      status: 'completed',
      result: opts.resultatEnfant,
      parentJobId: parent!.id,
    })
    .returning({ id: agentJobs.id });

  // Écrits UN PAR UN et dans l'ordre : c'est `seq` qui doit trancher, et une
  // écriture en lot laisserait l'ordre au hasard.
  for (const appel of opts.appels ?? []) {
    await testDb.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: enfant!.id,
      toolName: appel.toolName ?? REVIEW_VERDICT_TOOL,
      toolInput: {},
      toolOutput: appel.toolOutput,
      // LE MÊME tour et la MÊME heure pour tous : ni l'un ni l'autre ne peut
      // départager deux appels d'un même tour, et c'est précisément le piège
      // que `seq` existe pour éviter (#170).
      turn: 1,
      createdAt: new Date('2026-09-18T10:00:00.000Z'),
    });
  }
  return enfant!.id;
}

/**
 * La délégation telle que le fil du parent la porte.
 *
 * Par l'ACTION, et non par `assembleJobFeeds` en direct : c'est le chemin que
 * la page emprunte, et il traverse la lecture, la rédaction des secrets et
 * l'assemblage. Appeler la fonction interne aurait aussi demandé de forcer le
 * type de la base de test, ce qui est exactement le genre de raccourci qui fait
 * passer un test là où le produit échoue.
 */
async function delegationDuFil(cle: string) {
  const { getSpaceConversationAction } = await import('../actions.ts');
  const result = await getSpaceConversationAction(parents[cle] ?? '');
  if (!result.ok) throw new Error(`${result.code} ${result.message}`);
  const enfant = result.data.feed.items.find((i) => i.kind === 'child');
  if (enfant === undefined || enfant.kind !== 'child') throw new Error('pas de délégation au fil');
  return enfant.job;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // 1. Le cas de l'issue : la prose dit le contraire de ce qui a été enregistré.
  await semerDelegation({
    cle: 'prose-trompeuse',
    resultatEnfant: 'Verdict global : rien à signaler, tout est propre.',
    appels: [{ toolOutput: sortieVerdict() }],
  });

  // 2. Deux appels du MÊME tour : le relecteur s'est repris, le second fait foi.
  await semerDelegation({
    cle: 'deux-appels',
    resultatEnfant: null,
    appels: [
      {
        toolOutput: sortieVerdict({
          verdict: 'approve',
          counts: { blocker: 0, major: 0, minor: 0 },
        }),
      },
      { toolOutput: sortieVerdict({ summary: 'Le second, celui qui compte.' }) },
    ],
  });

  // 3. Aucun appel : il n'y a que la prose.
  await semerDelegation({
    cle: 'sans-verdict',
    resultatEnfant: 'Verdict final — la reprise tient.',
  });

  // 4. Une ligne qui S'ANNONCE réussie sans respecter le contrat. Le parseur
  //    LÈVE dessus — c'est le bon geste dans l'orchestration. Ici, il ne doit
  //    pas emporter la conversation.
  await semerDelegation({
    cle: 'ligne-abimee',
    resultatEnfant: 'Verdict : approuvé.',
    appels: [{ toolOutput: JSON.stringify({ ok: true, verdict: 'peut-être' }) }],
  });

  // 5. Un appel d'un AUTRE outil, plus récent : il ne doit rien effacer.
  await semerDelegation({
    cle: 'autre-outil',
    resultatEnfant: null,
    appels: [
      { toolOutput: sortieVerdict() },
      { toolName: 'file_read', toolOutput: JSON.stringify({ ok: true, content: 'x' }) },
    ],
  });
});

describe('le fil remonte le verdict enregistré d’un délégué @cap:verifier-un-livrable/moteur', () => {
  it('lit la ligne `review_verdict`, pas la prose qui dit le contraire', async () => {
    const job = await delegationDuFil('prose-trompeuse');
    expect(job.reviewVerdict).toEqual({
      verdict: 'request_changes',
      summary: 'Deux gardes manquent.',
      findings: [],
      counts: { blocker: 2, major: 0, minor: 1 },
    });
    // Le résultat n'est pas touché : le corps du bloc le montre toujours entier.
    expect(job.result).toContain('rien à signaler');
  });

  it('garde le DERNIER appel, même tour et même heure', async () => {
    const job = await delegationDuFil('deux-appels');
    expect(job.reviewVerdict?.summary).toBe('Le second, celui qui compte.');
    expect(job.reviewVerdict?.verdict).toBe('request_changes');
  });

  it('ne rend RIEN quand le délégué n’a enregistré aucun verdict', async () => {
    const job = await delegationDuFil('sans-verdict');
    expect(job.reviewVerdict).toBeNull();
    // La prose reste là, et c'est elle que l'écran affichera.
    expect(job.result).toBe('Verdict final — la reprise tient.');
  });

  it('une ligne abîmée n’emporte pas le fil : la délégation arrive quand même', async () => {
    const job = await delegationDuFil('ligne-abimee');
    expect(job.reviewVerdict).toBeNull();
    expect(job.task).toBe('relis la PR');
  });

  it('un appel d’un autre outil, plus récent, n’efface pas le verdict', async () => {
    const job = await delegationDuFil('autre-outil');
    expect(job.reviewVerdict?.counts).toEqual({ blocker: 2, major: 0, minor: 1 });
  });
});
