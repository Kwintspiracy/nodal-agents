// result-kind.test.ts — LA MARQUE DE PROVENANCE du résultat d'un job (#154, #210).
//
// @cap:suivre-execution/moteur
//
// Ce que ces tests prouvent, sur de VRAIES lignes : chaque chemin par lequel
// le runner écrit `agent_jobs.result` pose aussi `agent_jobs.result_kind`, et
// il pose LA BONNE marque. Sans cela, les deux écrans qui lisent le résultat
// (le fil d'une conversation, la page d'un run) continueraient de deviner la
// nature du texte à son premier caractère — ce que #154 retire.
//
// L'assertion porte sur la LIGNE relue, jamais sur un appel : la marque n'a de
// valeur que si elle est en base quand un écran vient la lire.
//
// Les chemins couverts, un par un :
//
//   texte final de l'agent      → prose   (branche texte d'`executeJob`, CLI)
//   dernier texte repris        → prose   (`fillResultFromFinalTextIfEmpty`)
//   texte publié par l'agent    → prose   (marque déjà posée, préservée)
//   résultats des enfants       → relay   (`fillResultFromChildrenIfEmpty`)
//   tâches d'un root compilées  → relay   (`deliverCompletedRoots`)
//   root annulé, tâches compilées → relay (`cancelRootJob`)
//
// MUTATIONS VÉRIFIÉES (chacune rend rouge le test nommé) :
//   - `resultKind: 'relay'` → `'prose'` dans `fillResultFromChildrenIfEmpty`
//     ⇒ « les résultats des enfants sont marqués relay » rougit ;
//   - la marque retirée de l'UPDATE de `completeJob`
//     ⇒ « le texte final de l'agent est marqué prose » rougit ;
//   - la condition `result.length > 0` élargie à toute écriture
//     ⇒ « un résultat vide ne touche pas la marque déjà posée » rougit.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs } from '@nodal-agents/db';
import type { JobResultKind } from '@nodal-agents/shared';
import { cancelRootJob, completeJob } from '../../job/state.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
});

async function freshJob(over: { parentJobId?: string; status?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 'faire le point',
      status: over.status ?? 'processing',
      ...(over.parentJobId === undefined ? {} : { parentJobId: over.parentJobId }),
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

/** La LIGNE relue — le texte ET sa marque, comme un écran les lira. */
async function rowOf(
  jobId: string,
): Promise<{ result: string | null; kind: JobResultKind | null }> {
  const [r] = await db
    .select({ result: agentJobs.result, resultKind: agentJobs.resultKind })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return { result: r?.result ?? null, kind: r?.resultKind ?? null };
}

describe('la marque de provenance du résultat @cap:suivre-execution/moteur', () => {
  it('le texte final de l’agent est marqué prose', async () => {
    const jobId = await freshJob();
    // La branche texte d'`executeJob` et le runtime CLI passent tous deux le
    // texte de l'agent avec `resultKind: 'prose'`.
    await completeJob(db, jobId, 'Voilà le bilan.', ['file_read'], undefined, undefined, 'prose');

    const row = await rowOf(jobId);
    expect(row.result).toBe('Voilà le bilan.');
    expect(row.kind, 'le texte de l’agent est resté sans marque').toBe('prose');
  });

  it('un texte final qui ressemble à du JSON est marqué prose, pas autre chose', async () => {
    // LE TROU DE #154 : l'ancienne heuristique du fil refusait ce résultat
    // comme « machine » sur la foi de son premier caractère. La marque dit ce
    // qu'il est : les mots de l'agent, rendus sous une forme lisible.
    const jobId = await freshJob();
    const texte = '["3 constats, aucun bloquant"]';
    await completeJob(db, jobId, texte, [], undefined, undefined, 'prose');

    const row = await rowOf(jobId);
    expect(row.result).toBe(texte);
    expect(row.kind).toBe('prose');
  });

  it('le dernier texte de l’agent, repris faute d’outil de livraison, est marqué prose', async () => {
    const jobId = await freshJob();
    const rapport = '# Rapport\nLe marché est concurrentiel.';
    const messages = [
      { role: 'user', content: 'fais le point' },
      { role: 'assistant', content: rapport },
    ];
    // `result` vide : l'agent a fini par `return_result`, qui ne transporte
    // aucun contenu. C'est `fillResultFromFinalTextIfEmpty` qui écrit.
    await completeJob(db, jobId, '', ['return_result'], undefined, messages, 'prose');

    const row = await rowOf(jobId);
    expect(row.result).toBe(rapport);
    expect(row.kind, 'le texte repris est resté sans marque').toBe('prose');
  });

  it('les résultats des enfants, recompilés, sont marqués relay', async () => {
    const parentId = await freshJob();
    const enfantId = await freshJob({ parentJobId: parentId, status: 'completed' });
    await db
      .update(agentJobs)
      .set({ result: 'Le délégué a trouvé trois constats.', status: 'completed' })
      .where(eq(agentJobs.id, enfantId));

    // Le parent n'a écrit NI texte final NI publication : son résultat est la
    // compilation de ses enfants (`fillResultFromChildrenIfEmpty`).
    await completeJob(db, parentId, '', [], undefined, [], 'prose');

    const row = await rowOf(parentId);
    expect(row.result, 'le parent n’a pas repris ses enfants').toContain(
      'Le délégué a trouvé trois constats.',
    );
    expect(row.kind, 'le texte d’un délégué a été marqué comme celui du parent').toBe('relay');
  });

  it('les tâches d’un root, compilées par le cron, sont marquées relay', async () => {
    const rootId = await freshJob();
    const compile = '## Tâche 1\nfaite\n\n---\n\n## Tâche 2\nfaite';
    // Ce que `deliverCompletedRoots` passe à la porte terminale.
    await completeJob(db, rootId, compile, [], undefined, undefined, 'relay');

    const row = await rowOf(rootId);
    expect(row.result).toBe(compile);
    expect(row.kind, 'la compilation des tâches a été prise pour la voix du root').toBe('relay');
  });

  it('un root annulé garde la compilation de ses tâches, marquée relay', async () => {
    const rootId = await freshJob();
    const landed = await cancelRootJob(db, rootId, '## Tâche 1\nannulée');

    expect(landed).toBe(true);
    const row = await rowOf(rootId);
    expect(row.result).toBe('## Tâche 1\nannulée');
    expect(row.kind).toBe('relay');
  });

  it('un résultat vide ne touche pas la marque déjà posée par l’outil de livraison', async () => {
    const jobId = await freshJob();
    // Ce que `dashboard_publish` écrit : le texte ET sa marque, ensemble.
    await db
      .update(agentJobs)
      .set({ result: 'Publié sur le dashboard.', resultKind: 'prose' })
      .where(eq(agentJobs.id, jobId));

    // La porte terminale du chemin `return_result` passe un texte VIDE : ni le
    // texte ni la marque ne doivent bouger.
    await completeJob(
      db,
      jobId,
      '',
      ['dashboard_publish', 'return_result'],
      undefined,
      [{ role: 'assistant', content: 'Je publie la revue.' }],
      'relay',
    );

    const row = await rowOf(jobId);
    expect(row.result, 'la publication de l’agent a été écrasée').toBe('Publié sur le dashboard.');
    expect(row.kind, 'la marque d’une publication a été remplacée par celle de la porte').toBe(
      'prose',
    );
  });

  it('un job terminé sans marque garde NULL, et n’en reçoit pas une par défaut', async () => {
    const jobId = await freshJob();
    // Le cas d'une ligne écrite avant la colonne : aucune marque n'est passée.
    await completeJob(db, jobId, 'Un texte sans provenance.', [], undefined, undefined);

    const row = await rowOf(jobId);
    expect(row.result).toBe('Un texte sans provenance.');
    expect(row.kind, 'une marque a été inventée là où personne n’en a posé').toBeNull();
  });
});
