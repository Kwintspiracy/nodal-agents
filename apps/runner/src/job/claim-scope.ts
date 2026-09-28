// job/claim-scope.ts — la prise d'un run, et la condition de chacune de ses écritures (#566).
//
// CE QUI S'EST PASSÉ (revue Codex de la PR #575, passe 1). Le run vérifiait son
// droit d'agir AVANT chaque effet, mais ses propres écritures de statut ne le
// redisaient pas : un outil qui rend « approbation requise » pendant que le
// faucheur (ou Stop) termine le job, et `suspendForApproval` sauvait son point
// de reprise puis ÉCRASAIT `failed` / `cancelled` par `awaiting_approval` —
// la reprise d'approbation pouvait ensuite ressusciter le job.
//
// LA FORME GÉNÉRALE. Aucune écriture du run sur SA ligne sans la condition
// « sous ma prise » : `claim_generation` = le numéro rendu par `claimJob`, et
// un statut où ce run peut encore se trouver (`processing`, ou
// `awaiting_delegation` pendant qu'il attend en ligne l'enfant qu'il a lancé).
// La condition est posée par les primitives d'écriture elles-mêmes
// (`job/state.ts` : setJobStatus, saveCheckpoint, completeJob, failJob,
// cancelJob), jamais à chaque appel : les quarante chemins d'échec, les deux
// suspensions, la finalisation et les écritures à venir la portent sans qu'on
// ait à y penser.
//
// COMMENT ELLE VOYAGE. Un contexte asynchrone par RUN (`runJob`) : la prise y
// est posée juste après `claimJob`. Un enfant délégué en ligne a son propre
// run, donc son propre contexte ; une reprise imbriquée du même job
// (`return runJob(...)`) aussi, avec la prise qu'elle vient de faire. Hors de
// tout run — les faucheurs, le cron de livraison, les routes — il n'y a pas
// de prise : leurs écritures gardent leurs propres conditions, inchangées.

import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, inArray, agentJobs } from '@nodal-agents/db';

/** Une condition SQL — le type que rendent `eq` / `and`. */
type Condition = ReturnType<typeof eq>;

interface Prise {
  jobId: string;
  /** null tant que `claimJob` n'a pas réussi. */
  generation: number | null;
}

const contexte = new AsyncLocalStorage<Prise>();

/**
 * LA définition de « ce run tient son job » (#566), lue partout — autorité,
 * veille, battement, écritures, réservation d'un appel approuvé, état laissé
 * par un tour de CLI : la ligne porte la prise de CE run, et un statut où il
 * a le droit d'agir.
 */
export const RUN_ACTS_WHILE = ['processing'] as const;

/**
 * Le seul élargissement, explicite : un run ÉCRIT encore sa ligne pendant
 * qu'il attend en ligne l'enfant qu'il a lancé (`awaiting_delegation` —
 * cascade d'annulation, échec). Il n'y AGIT pas.
 */
export const RUN_WRITES_WHILE = ['processing', 'awaiting_delegation'] as const;

/**
 * La condition SQL « ce job est tenu sous cette prise » — la seule. `statuts`
 * vaut `RUN_ACTS_WHILE` sauf pour les écritures du run (`RUN_WRITES_WHILE`).
 */
export function heldBy(
  jobId: string,
  claimGeneration: number,
  statuts: readonly string[] = RUN_ACTS_WHILE,
): Condition {
  return and(
    eq(agentJobs.id, jobId),
    eq(agentJobs.claimGeneration, claimGeneration),
    inArray(agentJobs.status, [...statuts]),
  ) as Condition;
}

/** Fait tourner `fn` comme LE run de ce job : ses écritures porteront sa prise. */
export function withinRunScope<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  return contexte.run({ jobId, generation: null }, fn);
}

/** Le run vient de prendre le job : ses écritures sont désormais conditionnelles. */
export function recordClaim(jobId: string, generation: number): void {
  const prise = contexte.getStore();
  if (!prise || prise.jobId !== jobId) {
    throw new Error(`claim_scope_missing: job ${jobId} was claimed outside its run scope`);
  }
  prise.generation = generation;
}

/** La prise que le run courant tient sur CE job, ou null (hors run, autre job, avant la prise). */
export function heldClaim(jobId: string): number | null {
  const prise = contexte.getStore();
  return prise && prise.jobId === jobId ? prise.generation : null;
}

/**
 * La condition qu'une écriture du run courant sur ce job doit porter.
 * `statuts` : ceux où l'écriture a un sens (par défaut `RUN_WRITES_WHILE`) ;
 * `null` pour ne tenir que la prise (la transcription d'un job annulé par la
 * personne pendant que ce run le tenait). Rend `undefined` hors d'un run qui
 * tient ce job : l'écriture garde alors ses seules conditions.
 */
export function claimCondition(
  jobId: string,
  statuts: readonly string[] | null = RUN_WRITES_WHILE,
): Condition | undefined {
  const generation = heldClaim(jobId);
  if (generation === null) return undefined;
  return statuts === null
    ? and(eq(agentJobs.id, jobId), eq(agentJobs.claimGeneration, generation))
    : heldBy(jobId, generation, statuts);
}
