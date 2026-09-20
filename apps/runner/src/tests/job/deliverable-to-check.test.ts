// deliverable-to-check.test.ts — « un livrable de ce run attend le regard de
// la personne », posé par la porte terminale de succès (#255).
//
// @cap:verifier-un-livrable/moteur
//
// La décision 2 de #135 énumère quatre choses que la pastille d'attention
// compte. Trois avaient une colonne ; la quatrième — « un livrable à
// vérifier » — n'en avait aucune, et rien ne pouvait donc la compter. Ce
// fichier prouve le côté MOTEUR du fait : qui le pose, quand, et sur quel run.
//
// CE QU'IL PROUVE, sur de vraies lignes :
//
//   1. UN RUN QUI A PRODUIT UN LIVRABLE POSE LE FAIT. La colonne est écrite
//      dans la même transaction que le statut terminal, donc un run `completed`
//      qui a livré ne peut pas exister sans elle.
//   2. UN RUN QUI N'A RIEN PRODUIT NE LE POSE PAS. `addressed` seul est une
//      INTENTION, posée avant l'exécution de l'outil : une écriture qui échoue
//      la laisse en place, et compter là-dessus ferait attendre un regard sur
//      un livrable que personne n'a produit.
//   3. LE FAIT REMONTE AU JOB DE TÊTE. C'est le run que la personne ouvre, et
//      sa page montre déjà les livrables de toute sa descendance. Posé sur le
//      délégué, il serait invisible : un délégué porte `internal` et aucune
//      conversation, donc aucun dossier du menu Chat ne le compterait, et
//      ouvrir le fil ne l'effacerait jamais.
//   4. UN RUN SANS AUCUN LIVRABLE NE LE POSE PAS. La pastille ne compte pas
//      les runs, elle compte les livrables qui attendent.
//   5. UNE CHAÎNE QUI BOUCLE NE POSE RIEN, LE DIT, ET LAISSE LE RUN FINIR.
//      `parent_job_id` est une auto-référence qu'aucune contrainte n'empêche de
//      boucler, et le pilote ne pose aucun `statement_timeout` : une remontée
//      non bornée tournerait sans fin en tenant le verrou du job.
//
// Mutations vérifiées :
//   - `poseDeliverableCheck` retiré de `finalizeJobSuccess` → les tests 1 et 3
//     rougissent (la colonne reste nulle après un run qui a livré) ;
//   - `eq(..., produced, true)` retiré du prédicat → le test 2 rougit (un
//     livrable seulement visé réclame un regard) ;
//   - le dernier `log(DELIVERABLE_CHECK_NO_ROOT, …)` retiré → le test 5 rougit
//     (la chaîne cassée passe en silence).
//
// Le type de livrable est `code_project` SANS ligne `code_projects` : sa
// configuration est alors `not_configured`, aucune preuve ne tourne et aucun
// processus n'est lancé. Ce fichier ne parle que de la colonne.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agentJobs,
  codeProjects,
  jobDeliverableVerificationState,
  verificationRuns,
} from '@nodal-agents/db';
import { finalizeJobSuccess } from '../../job/finalize.ts';
import type { FinalizeDeps } from '../../job/finalize.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

const asDb = (): Parameters<typeof finalizeJobSuccess>[0] =>
  db as unknown as Parameters<typeof finalizeJobSuccess>[0];

let logs: { code: string; data: Record<string, unknown> }[] = [];
const deps = (): FinalizeDeps => ({ log: (code, data) => logs.push({ code, data }) });

beforeAll(async () => {
  const spun = await spinUpTestDb();
  db = spun.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  logs = [];
  await db.delete(verificationRuns);
  await db.delete(jobDeliverableVerificationState);
  await db.delete(codeProjects);
});

/** Un run, de tête par défaut. `parentJobId` en fait un délégué. */
async function insertJob(parentJobId: string | null = null): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: parentJobId === null ? 'dashboard' : 'internal',
      task: 'écrire le rapport',
      status: 'processing',
      ...(parentJobId === null ? {} : { parentJobId }),
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('job insert failed');
  return row.id;
}

/**
 * Un livrable de ce run. `addressed` vaut `true` par défaut, comme la colonne :
 * un livrable NOMMÉ par un outil. `produced` dit si l'outil a RÉUSSI à y
 * écrire, et c'est la seconde moitié de la condition.
 */
async function insertLivrable(
  jobId: string,
  opts: { produced: boolean; addressed?: boolean },
): Promise<void> {
  await db.insert(jobDeliverableVerificationState).values({
    jobId,
    deliverableType: 'code_project',
    canonicalKey: `cle-${jobId}`,
    dirtyGeneration: 1,
    decisionStatus: 'dirty',
    addressed: opts.addressed ?? true,
    produced: opts.produced,
  });
}

/** Le fait, relu en base. `null` = rien n'attend de regard sur ce run. */
async function attend(jobId: string): Promise<Date | null> {
  const [row] = await db
    .select({ due: agentJobs.deliverableCheckDueAt })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job not found');
  return row.due ?? null;
}

describe('un livrable de ce run attend un regard @cap:verifier-un-livrable/moteur', () => {
  it('un run qui a PRODUIT un livrable pose le fait, avec son statut terminal', async () => {
    const jobId = await insertJob();
    await insertLivrable(jobId, { produced: true });

    const out = await finalizeJobSuccess(
      asDb(),
      { jobId, resultKind: 'prose', result: 'fait' },
      deps(),
    );
    // Le run FINIT : le fait accompagne la décision terminale, il ne la
    // remplace pas et ne l'empêche pas.
    expect(out.kind).toBe('completed_unverified');

    const pose = await attend(jobId);
    expect(pose, 'un run qui a livré n’attend aucun regard').not.toBeNull();
    // Il date de la finalisation, pas d'un défaut de colonne.
    expect(pose!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(pose!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('un livrable seulement VISÉ, jamais écrit, ne réclame aucun regard', async () => {
    const jobId = await insertJob();
    // L'intention est posée AVANT l'exécution de l'outil ; l'écriture a échoué,
    // et `produced` est resté faux. Rien n'a été livré.
    await insertLivrable(jobId, { produced: false });

    await finalizeJobSuccess(asDb(), { jobId, resultKind: 'prose', result: 'rien écrit' }, deps());

    expect(
      await attend(jobId),
      'un livrable que personne n’a produit réclame un regard',
    ).toBeNull();
  });

  it('un livrable dans le PÉRIMÈTRE mais non visé ne réclame aucun regard', async () => {
    const jobId = await insertJob();
    // Un shell écrit où il veut : tout son périmètre est marqué sale par
    // précaution. L'écran ne montre pas ces lignes-là, et la pastille ne doit
    // pas les compter non plus.
    await insertLivrable(jobId, { produced: true, addressed: false });

    await finalizeJobSuccess(
      asDb(),
      { jobId, resultKind: 'prose', result: 'un shell a tourné' },
      deps(),
    );

    expect(await attend(jobId), 'un livrable non visé réclame un regard').toBeNull();
  });

  it('un run SANS aucun livrable ne pose rien', async () => {
    const jobId = await insertJob();

    await finalizeJobSuccess(
      asDb(),
      { jobId, resultKind: 'prose', result: 'juste une réponse' },
      deps(),
    );

    expect(await attend(jobId), 'un run qui n’a rien livré réclame un regard').toBeNull();
  });

  it('le livrable d’un DÉLÉGUÉ fait attendre le run de TÊTE, pas le délégué', async () => {
    const tete = await insertJob();
    const delegue = await insertJob(tete);
    await insertLivrable(delegue, { produced: true });

    await finalizeJobSuccess(
      asDb(),
      { jobId: delegue, resultKind: 'prose', result: 'rapport écrit' },
      deps(),
    );

    expect(
      await attend(tete),
      'le livrable d’un délégué n’a pas fait attendre son run de tête',
    ).not.toBeNull();
    // Le délégué lui-même ne porte rien : il n'est pas un run qu'on ouvre, et
    // aucun dossier du menu Chat ne le compterait.
    expect(await attend(delegue), 'le délégué porte le fait à la place de sa tête').toBeNull();
  });

  it('une chaîne qui BOUCLE ne pose rien, le DIT, et laisse le run finir', async () => {
    // `parent_job_id` est une auto-référence qu'aucune contrainte n'empêche de
    // boucler. Sans la borne `CHAIN_WALK_MAX`, la remontée tournerait SANS FIN
    // dans la transaction qui tient le verrou du job — le pilote ne pose aucun
    // `statement_timeout` (constat majeur de la revue C, passe 1).
    //
    // Ce cas a aussi révélé le second : la branche de journalisation lisait le
    // retour d'un `tx.execute`, dont la FORME dépend du pilote, et ne partait
    // donc jamais sous PGlite. La remontée passe désormais par l'API typée.
    const a = await insertJob();
    const b = await insertJob(a);
    await db.update(agentJobs).set({ parentJobId: b }).where(eq(agentJobs.id, a));
    await insertLivrable(a, { produced: true });

    const out = await finalizeJobSuccess(
      asDb(),
      { jobId: a, resultKind: 'prose', result: 'fait' },
      deps(),
    );

    // Le run FINIT quand même : la pastille n'est pas l'affaire de la
    // finalisation.
    expect(out.kind).toBe('completed_unverified');
    // Rien n'est posé — surtout pas sur un run choisi au hasard.
    expect(await attend(a)).toBeNull();
    expect(await attend(b)).toBeNull();
    // Et le silence est dit : un code, des données, jamais une phrase.
    expect(
      logs.map((l) => l.code),
      'la chaîne cassée n’a pas été journalisée',
    ).toContain('DELIVERABLE_CHECK_NO_ROOT');
    expect(logs.find((l) => l.code === 'DELIVERABLE_CHECK_NO_ROOT')!.data).toEqual({
      jobId: a,
      cause: 'chaine_sans_tete',
      maillons: 64,
    });
  });

  it('remonte la chaîne sur DEUX niveaux de délégation', async () => {
    const tete = await insertJob();
    const milieu = await insertJob(tete);
    const feuille = await insertJob(milieu);
    await insertLivrable(feuille, { produced: true });

    await finalizeJobSuccess(
      asDb(),
      { jobId: feuille, resultKind: 'prose', result: 'rapport écrit' },
      deps(),
    );

    expect(await attend(tete), 'la chaîne n’a pas été remontée jusqu’à sa tête').not.toBeNull();
    expect(await attend(milieu)).toBeNull();
    expect(await attend(feuille)).toBeNull();
  });
});
