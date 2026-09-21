// job/finalize.ts — LA porte terminale de succès d'un job.
//
// Plan « Vérifier & Corriger », « La primitive terminale typée ». Toutes les
// transitions terminales SUCCÈS passent par ici : le chemin sans tool call, le
// chemin `return_result`, le runtime CLI et le cron task-board (bascules
// T10-T12). Une seule porte, donc une seule place où la décision de
// vérification est calculée, journalisée, et — à partir de PR② — opposable.
//
// ─── Ce que fait la primitive, dans l'ordre imposé (décision n°5) ───────────
//
//   transaction 1 : `FOR UPDATE` sur `agent_jobs`, refus si déjà terminal,
//                   lecture des états de vérification sales du job (triés,
//                   donc verrouillés dans un ordre déterministe), capture de
//                   la génération G de chacun, lecture de leur configuration
//                   sous verrou → COMMIT.
//   hors transaction : la preuve. Un spawn de plusieurs secondes sous un
//                   `FOR UPDATE` heurterait `lock_timeout` (30 s) et
//                   bloquerait le heartbeat. C'est le garde de génération qui
//                   rattrape ce que le verrou ne tient plus.
//   transaction 2 : `FOR UPDATE` sur `agent_jobs` à nouveau + garde « statut
//                   non terminal » (c'est elle qui sérialise DEUX finalisations
//                   concurrentes du MÊME job : la seconde lit `already_terminal`
//                   et n'écrit rien ; `completed_at` n'entre pas dans la garde,
//                   un job réessayé en garde une trace), puis
//                   `UPDATE état … WHERE dirty_generation = G` — zéro ligne
//                   signifie qu'une écriture est passée pendant la preuve
//                   (`VERIFY_STALE_GENERATION`), puis l'écriture terminale.
//
// ─── La garde n'est PAS branchée en PR① (v5-C, phase d'observation) ─────────
//
// Le résultat typé est CALCULÉ et JOURNALISÉ (`observedOutcome`), la
// finalisation ne le consulte pas : un projet rouge finit quand même
// `completed`, et la ligne `verification_runs` porte `red`. On n'active pas
// une garde qu'on n'a pas mesurée. `review_pending` n'est JAMAIS rendu en ① —
// aucun cycle de revue n'existe encore (c'est PR④) ; la valeur est dans
// l'union parce que la primitive la rendra sans changer de signature.
//
// Même règle pour les pannes (décision n°4) : `verification_runs` est de
// l'observabilité best-effort en ①. Une écriture qui échoue est journalisée
// fort (code + données) et le job finit quand même ; le fail-closed n'entre en
// vigueur qu'en ②, avec la garde.
//
// ─── PR② — UN tour de réparation, et un seul (issue #375, décision D2) ──────
//
// Ce que ② ajoute à ① : un verdict `red` sur un livrable CONFIGURÉ n'écrit
// plus le statut terminal du premier coup. La primitive rend `repair_due`,
// pose `repair_attempts = 1` sur les états rouges, relâche sa réclamation et
// rend la main SANS écrire de statut : le job reste non terminal, son appelant
// lui donne un tour de plus avec la sortie rouge comme entrée, et la preuve
// repasse à la finalisation suivante. Deuxième rouge ⇒ `completed`,
// `red_streak + 1`, aucune troisième chance (invariant #8).
//
// COMBIEN DE TOURS ? C'EST UN RÉGLAGE DE L'ESPACE (issue #377). La borne
// n'est plus écrite ici : `entities.proof_repair_attempts` la porte, lue en
// transaction 1 sous le même verrou que le reste. `0` rend le comportement
// d'avant #375 — le run finit rouge tout de suite —, `1` est le défaut et la
// décision D2, `3` le plafond que le CHECK de la colonne tient. Une ligne
// lue avant la migration vaut le défaut (`readProofRepairAttempts`).
//
// POURQUOI L'APPELANT DÉCLARE (`repairTurn`). Un tour de réparation n'existe
// que là où il y a une boucle de tours à reprendre — `executeJob`. Le runtime
// CLI a son propre cycle (PR③ du plan) et le cron du tableau de tâches ne
// reprend rien : il compile des résultats d'enfants déjà finis. Le champ est
// REQUIS, comme `resultKind` : chaque porte terminale DIT si elle sait rouvrir
// son job, plutôt qu'un défaut qui laisserait un jour un job pendu sans statut
// parce que personne n'a lu ce retour.
//
// ─── Aucun type de livrable ici ────────────────────────────────────────────
//
// La primitive n'appelle que le registre (`../verification/registry.ts`).
// Elle ne sait pas ce qu'est un projet de code. Un type sans vérificateur
// LÈVE `DELIVERABLE_TYPE_UNSUPPORTED` — jamais une clé inventée.
//
// Invariant #2 : ce module ne dit rien à personne. Il journalise des CODES et
// des données.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from '@nodal-agents/db';
import {
  agentJobs,
  entities,
  jobDeliverableVerificationState,
  verificationRuns,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { DecisionStatus, JobResultKind } from '@nodal-agents/shared';
import { readProofRepairAttempts } from '@nodal-agents/shared';
import { getVerifier } from '../verification/registry.ts';
import { buildRepairBrief } from '../verification/repair-brief.ts';
import type { RepairBriefCommand } from '../verification/repair-brief.ts';
import type {
  DeliverableVerifier,
  LoadedConfig,
  ProofCommandRecord,
  ProofResult,
  ReadyConfig,
} from '../verification/registry.ts';
import { TERMINAL_STATUSES, completeJob, failJob } from './state.ts';

// ─── Codes journalisés ──────────────────────────────────────────────────────

/** Une écriture d'observabilité ou d'état a échoué — best-effort en ①. */
export const VERIFY_PERSISTENCE_FAILED = 'VERIFY_PERSISTENCE_FAILED';
/** L'UPDATE d'état n'a touché aucune ligne : une écriture est passée pendant la preuve. */
export const VERIFY_STALE_GENERATION = 'VERIFY_STALE_GENERATION';
/** Un livrable est dû — journalisé, PAS opposé au job en ① (v5-C). */
export const VERIFICATION_DUE_OBSERVED = 'VERIFICATION_DUE_OBSERVED';
/** La ligne d'état d'un livrable mutable sans génération : impossible par CHECK, refusé fort. */
export const VERIFY_STATE_GENERATION_MISSING = 'VERIFY_STATE_GENERATION_MISSING';
/** L'écriture terminale n'a pas atterri alors que la garde venait de passer. */
export const VERIFY_TERMINAL_WRITE_LOST = 'VERIFY_TERMINAL_WRITE_LOST';
/** Une livraison est demandée sans le préparateur qui sait l'écrire (T08). */
export const DELIVERY_PREPARE_UNAVAILABLE = 'DELIVERY_PREPARE_UNAVAILABLE';
/** Le job à finaliser n'existe pas. */
export const FINALIZE_JOB_NOT_FOUND = 'FINALIZE_JOB_NOT_FOUND';
/** Un autre finaliseur tient le marqueur `finalizing_at` de ce job : une seule preuve par job. */
export const FINALIZE_CLAIMED_ELSEWHERE = 'FINALIZE_CLAIMED_ELSEWHERE';
/** La configuration ou l'epoch du projet ont bougé PENDANT la preuve : ce qui a été prouvé n'est plus l'arbre courant. */
export const VERIFY_STALE_EPOCH = 'VERIFY_STALE_EPOCH';
/** Un tour de réparation vient de s'ouvrir sur ce job (PR②, décision D2). */
export const VERIFY_REPAIR_TURN_OPENED = 'VERIFY_REPAIR_TURN_OPENED';
/**
 * Le réglage de réparation de l'espace n'est pas lisible tel quel : ligne
 * absente, ou valeur hors des bornes que le CHECK de la colonne tient (#377).
 * Rabattu, et DIT — un repli muet sur une donnée abîme ferait tourner le
 * runner sur un nombre que personne n'a choisi (invariant #4).
 */
export const VERIFY_REPAIR_SETTING_UNREADABLE = 'VERIFY_REPAIR_SETTING_UNREADABLE';
/**
 * Au-delà de ce délai, un marqueur `finalizing_at` sans décision terminale est
 * réputé orphelin (le finaliseur qui l'a posé est mort entre ses deux
 * transactions) et se reprend. Seuil JS — décision de découpage n°12.
 */
export const FINALIZING_STALE_MS = 10 * 60_000;
/**
 * Un livrable à vérifier sur un job sans espace : `agent_jobs.entity_id` est
 * nullable, la configuration de preuve est portée PAR l'espace. Refusé fort
 * plutôt que vérifié contre rien.
 */
export const FINALIZE_JOB_WITHOUT_ENTITY = 'FINALIZE_JOB_WITHOUT_ENTITY';
/**
 * Un livrable attend un regard, mais la chaîne de délégation ne remonte à
 * AUCUN job de tête — un maillon manquant. Le fait n'est alors posé nulle
 * part, plutôt que sur un run choisi au hasard (invariant #4). Journalisé,
 * jamais opposé au job : la finalisation n'est pas l'affaire de la pastille.
 */
export const DELIVERABLE_CHECK_NO_ROOT = 'DELIVERABLE_CHECK_NO_ROOT';

// ─── Types de retour ────────────────────────────────────────────────────────

/**
 * L'union complète du plan. `observedOutcome` la porte ENTIÈRE dès PR① ; le
 * `kind` rendu, lui, est restreint tant que la garde n'est pas branchée.
 */
export type ObservedOutcome =
  | 'completed'
  | 'completed_unverified'
  | 'review_pending'
  | 'already_terminal'
  | 'verification_due'
  | 'repair_due'
  | 'verification_persistence_failed';

/**
 * Ce que la primitive rend EFFECTIVEMENT : le job finit, il était déjà fini,
 * ou — PR②, et seulement si l'appelant sait rouvrir son job — il repart pour
 * UN tour de réparation, sans statut terminal écrit.
 *
 * `verification_due` et `verification_persistence_failed` restent observés,
 * journalisés, et rendus comme `completed_unverified` : la garde de ① n'est
 * toujours pas branchée sur eux, seul le rouge réparable change l'issue.
 */
export type FinalizeKind = 'completed' | 'completed_unverified' | 'already_terminal' | 'repair_due';

/** L'état d'un livrable après la finalisation, tel que la décision l'a laissé. */
export interface DeliverableDecision {
  readonly deliverableType: string;
  readonly canonicalKey: string;
  readonly decisionStatus: DecisionStatus;
  /** Réglé : prouvé vert sur la génération et l'epoch courants. */
  readonly settled: boolean;
  /** Non vérifiable : rien n'est configuré — ce n'est pas un échec. */
  readonly unverifiable: boolean;
  /** Dû : sale non prouvé, rouge, périmé, en panne d'infra ou non approuvé. */
  readonly due: boolean;
}

/**
 * Ce qu'un tour de réparation ouvert donne à l'appelant : le texte à poser
 * comme entrée du tour suivant, et de quoi le journaliser.
 *
 * Le BRIEF est composé ici, dans la primitive, et pas chez l'appelant : les
 * enregistrements de preuve ne vivent que le temps de cette fonction, et deux
 * appelants qui composeraient chacun leur message diraient deux choses du
 * même rouge.
 */
export interface RepairTurn {
  /** Le message de plateforme, verbatim, destiné au MODÈLE (jamais à l'écran). */
  readonly brief: string;
  /** Les clés canoniques des livrables rouges qui ont ouvert ce tour. */
  readonly keys: readonly string[];
}

export interface FinalizeOutcome {
  readonly kind: FinalizeKind;
  /** Le résultat typé COMPLET, calculé même quand il n'est pas opposé. */
  readonly observedOutcome: ObservedOutcome;
  /** Au moins un livrable dû. Journalisé ; sans effet sur `kind` en ①. */
  readonly observedDue: boolean;
  readonly decisions: readonly DeliverableDecision[];
  /** Présent SI ET SEULEMENT SI `kind === 'repair_due'`. */
  readonly repair?: RepairTurn;
}

/** Compteurs de tokens/durée du run — même forme que celle de `completeJob`. */
export interface FinalizeStats {
  inputTokens: number;
  outputTokens: number;
  effectiveInputTokens?: number;
  totalCostUsd?: number;
  servedProvider?: string | null;
  turn: number;
  totalDurationMs?: number;
}

/**
 * POINT D'EXTENSION T08 — la livraison sortante.
 *
 * Le plan (« La livraison est une action sortante ») veut la ligne
 * `job_deliveries` en `prepared` écrite DANS la transaction qui pose le statut
 * terminal : l'intention de livrer est commise avec la décision, et
 * `drainDeliveries` la réclame ensuite, hors transaction. Ce module ne
 * l'implémente pas — T08 écrit `prepareDelivery` et le passe ici.
 *
 * Ce n'est pas un stub silencieux : demander une livraison sans fournir le
 * préparateur LÈVE `DELIVERY_PREPARE_UNAVAILABLE` avant toute écriture
 * (invariant #4). Tant que T08 n'est pas là, les appelants finalisent sans
 * `delivery` — exactement ce qu'ils font aujourd'hui.
 */
export type PrepareDelivery = (
  tx: AnyDrizzleDb,
  input: {
    readonly jobId: string;
    readonly channel: string;
    readonly chatId: string;
    readonly payload: string;
    /** Laisse le préparateur dédupliquer deux notices distinctes du même job. */
    readonly idempotencyKey?: string;
  },
) => Promise<void>;

/** Les dépendances, prises en PARAMÈTRE — rien n'est résolu depuis un module global. */
export interface FinalizeDeps {
  /** Le registre. Injectable pour tester un type de livrable sans le brancher. */
  readonly getVerifier?: (deliverableType: string) => DeliverableVerifier;
  /** Journal de codes. Par défaut `console.warn`, préfixé. */
  readonly log?: (code: string, data: Record<string, unknown>) => void;
  /** Identifiant de séquence de preuve — injectable pour des tests déterministes. */
  readonly newSequenceId?: () => string;
  /** Fourni par T08. Requis dès qu'une livraison est demandée. */
  readonly prepareDelivery?: PrepareDelivery;
}

/**
 * Ce que l'appelant demande à la porte terminale — UN objet, la forme que
 * T10-T12 écrivent littéralement (`finalizeJobSuccess(db, { jobId, result,
 * toolsUsed, … })`), jamais une liste positionnelle qu'un appelant peut
 * décaler d'un cran sans que le compilateur le voie.
 */
export interface FinalizeInput {
  readonly jobId: string;
  /** Le texte final du job — `completeJob` préserve un `result` non vide déjà écrit. */
  readonly result: string;
  /**
   * COMMENT `result` a été produit (#154, #210) — écrit sur la ligne AVEC le
   * texte, jamais deviné plus tard à partir de sa forme.
   *
   * REQUIS : chaque porte terminale le dit. Les appelantes n'écrivent pas le
   * même genre de texte — la branche texte de `executeJob` et le runtime CLI
   * rendent les mots de l'agent (`prose`), le cron du tableau de tâches rend
   * la compilation de ses tâches (`relay`) —, et une valeur par défaut aurait
   * rangé les deux sous la même marque.
   *
   * Sans effet quand `result` est vide : rien n'est alors écrit, et la marque
   * déjà posée par `dashboard_publish` — ou celle que les remplissages de
   * `completeJob` poseront — reste en place.
   */
  readonly resultKind: JobResultKind;
  /**
   * L'appelant SAIT-IL rouvrir ce job pour un tour de plus ? (PR②, D2.)
   *
   * `'supported'` — la boucle de tours de `executeJob` : une preuve rouge
   * jamais réparée rend `repair_due`, le job ne prend PAS de statut terminal,
   * et l'appelant relance un tour avec `outcome.repair.brief` en entrée.
   *
   * `'unsupported'` — les portes qui n'ont pas de tour à reprendre (le runtime
   * CLI, qui a son propre cycle en PR③ ; le cron du tableau de tâches, qui
   * compile des enfants déjà finis). Le rouge y reste OBSERVÉ, comme en ① : le
   * job finit `completed_unverified`. Pas de défaut : une porte terminale qui
   * oublierait de répondre laisserait un jour un job sans statut.
   */
  readonly repairTurn: 'supported' | 'unsupported';
  readonly toolsUsed?: readonly string[];
  /**
   * Le marqueur `finalizing_at` que l'APPELANT a déjà posé (le cron réclame un
   * root avant sa synthèse, hors de cette primitive) : la réclamation de la
   * transaction 1 l'accepte comme le sien. Sans ce champ, un marqueur frais
   * posé par quelqu'un d'autre refuse la finalisation (`already_terminal`,
   * code FINALIZE_CLAIMED_ELSEWHERE) — c'est ce qui garantit UNE preuve par
   * job quand deux finaliseurs se présentent.
   */
  readonly claim?: { readonly finalizingAt: Date };
  readonly stats?: FinalizeStats;
  readonly messages?: unknown[];
  /** Livraison à préparer dans la même transaction (T08). */
  readonly delivery?: TerminalDelivery;
}

/**
 * Ce qu'il y a à livrer, posé DANS la transaction terminale — succès comme
 * échec (issue #116, résidu 3).
 */
export interface TerminalDelivery {
  readonly channel: string;
  readonly chatId: string;
  readonly payload: string;
  readonly idempotencyKey?: string;
}

/** Ce que la porte terminale d'ÉCHEC demande. */
export interface FinalizeFailureInput {
  readonly jobId: string;
  /** Le code (ou la raison courte) écrit dans `agent_jobs.error`. */
  readonly errorCode: string;
  readonly stats?: FinalizeStats;
  readonly messages?: unknown[];
  /** L'explication rendue à l'utilisateur, quand l'appelant en a une. */
  readonly userMessage?: string;
  /** Livraison à préparer dans la même transaction que l'écriture terminale. */
  readonly delivery?: TerminalDelivery;
}

// ─── Interne ────────────────────────────────────────────────────────────────

/** Ce que la transaction 1 a établi pour UN livrable, avant la preuve. */
interface DeliverablePlan {
  readonly stateId: string;
  readonly deliverableType: string;
  readonly canonicalKey: string;
  /** L'ADRESSE du livrable, à côté de son identité (constat C2, revue de #66). */
  readonly displayPath: string | null;
  /** La génération sale capturée sous verrou — le garde de la transaction 2. */
  readonly generation: number;
  /** Réparations déjà ouvertes sur ce livrable. `>= 1` ⇒ plus aucune (D2). */
  readonly repairAttempts: number;
  readonly verifier: DeliverableVerifier;
  readonly config: LoadedConfig;
}

interface OpenedJob {
  /** Nullable comme la colonne : un job sans espace n'a simplement aucun livrable. */
  readonly entityId: string | null;
  readonly plans: readonly DeliverablePlan[];
  /**
   * Le réglage de l'espace (#377), lu en transaction 1. Un job sans espace
   * n'a aucun livrable, donc aucune réparation possible : la valeur vaut zéro
   * plutôt que le défaut, et personne ne s'en sert.
   */
  readonly maxReparations: number;
}

function defaultLog(code: string, data: Record<string, unknown>): void {
  console.warn(`[finalize] ${code}`, JSON.stringify(data));
}

/**
 * L'état lisible que la décision pose, d'après ce que la preuve a rendu.
 * Aucun type de livrable n'entre dans ce calcul — seulement la forme de la
 * configuration et le verdict.
 */
function decisionStatusFor(config: LoadedConfig, proof: ProofResult | null): DecisionStatus {
  if (config.kind === 'not_configured') return 'not_configured';
  if (config.kind === 'pending_approval') return 'pending_approval';
  if (!proof) return 'infra_error';
  if (proof.verdict === 'green') return 'green';
  return proof.verdict === 'red' ? 'red' : 'infra_error';
}

/**
 * Les prédicats du plan, par livrable. « Non vérifiable » ne couvre QUE
 * `not_configured` : `pending_approval` est DÛ, parce que le livrable est
 * vérifiable — il attend une approbation, ce qui est une action de l'owner,
 * pas une absence de configuration.
 */
function classify(status: DecisionStatus): {
  settled: boolean;
  unverifiable: boolean;
  due: boolean;
} {
  if (status === 'green') return { settled: true, unverifiable: false, due: false };
  if (status === 'not_configured') return { settled: false, unverifiable: true, due: false };
  return { settled: false, unverifiable: false, due: true };
}

// ─── « Un livrable attend un regard » (#255) ─────────────────────────────────

/**
 * Combien de maillons la remontée vers le job de tête suit, au plus.
 *
 * C'est une GARDE, pas une règle métier, et elle n'est pas DÉRIVÉE du plafond
 * de délégation exprès.
 *
 * `maxDelegationDepth` (3, packages/orchestration) borne les chaînes que
 * l'ORCHESTRATION crée, et elle seules. `POST /api/agent` accepte un
 * `parentJobId` fourni par l'appelant — vérifié comme appartenant à la même
 * entité (F-2 de l'audit #2), pas comme respectant une profondeur
 * (apps/runner/src/routes/agent.ts). Une chaîne plus longue que trois est donc
 * constructible, et une borne recopiée du plafond ferait rater sa tête à un run
 * parfaitement légitime. Soixante-quatre est au-dessus de tout ce qui s'écrit
 * en pratique, plafond d'hier compris.
 *
 * Ce qu'elle empêche est précis : `parent_job_id` boucle, et aucun
 * `statement_timeout` ne l'arrête (choix assumé de
 * `packages/db/src/client.ts`). Sans ce compteur, une seule ligne malformée
 * suffirait à faire tourner une finalisation sans fin, en tenant son verrou.
 */
const CHAIN_WALK_MAX = 64;

/**
 * Pose `agent_jobs.deliverable_check_due_at` sur le JOB DE TÊTE de ce run,
 * quand le job qui finit a produit au moins un livrable.
 *
 * CE QUI COMPTE COMME « A LIVRÉ » : une ligne de
 * `job_deliverable_verification_state` à la fois `addressed` ET `produced`.
 * Les deux, jamais l'une :
 *
 *   `addressed` est posé AVANT l'exécution de l'outil, et une écriture qui
 *   échoue laisse l'intention en place — compter là-dessus ferait attendre un
 *   regard sur un livrable que personne n'a produit ;
 *
 *   `produced` seul compterait aussi ce que l'écran ne montre pas : un
 *   périmètre marqué par précaution, qu'un shell peut salir en entier.
 *
 * SUR LA TÊTE DE LA CHAÎNE, pas sur le délégué qui a produit. C'est le run que
 * la personne ouvre, et sa page remonte déjà les livrables de toute sa
 * descendance (`collectDescendants`, côté web). Poser le fait sur un délégué
 * le rendrait invisible : un délégué porte `internal` et aucune conversation,
 * donc aucun dossier du menu Chat ne le compterait, et ouvrir le fil ne
 * l'effacerait jamais.
 *
 * La remontée est BORNÉE PAR LE CODE (`CHAIN_WALK_MAX`), et pas seulement par
 * la profondeur de délégation du produit. La raison est un constat de la revue
 * C de cette PR : `parent_job_id` est une auto-référence qu'aucune contrainte
 * n'empêche de boucler, et le pilote ne pose délibérément AUCUN
 * `statement_timeout` (packages/db/src/client.ts). Une remontée non bornée
 * tournerait sans fin sur un cycle, DANS la transaction qui tient le
 * `FOR UPDATE` du job — la finalisation n'aurait plus de fin. La borne la
 * ferme, quoi qu'il y ait en base.
 *
 * Une chaîne qui ne remonte à aucun job sans parent — un cycle, ou plus de
 * `CHAIN_WALK_MAX` maillons — ne pose RIEN et le dit
 * (`DELIVERABLE_CHECK_NO_ROOT`), jamais un fait posé sur un run choisi au
 * hasard (invariant #4).
 *
 * Une panne ici n'est PAS avalée : l'écriture vit dans la transaction du
 * statut terminal, et une pastille muette après un run qui a livré est
 * exactement ce que l'issue #255 corrige. Elle roule donc la transaction, qui
 * sera reprise — plutôt que de finir le job en taisant le fait.
 */
async function poseDeliverableCheck(
  tx: AnyDrizzleDb,
  jobId: string,
  log: (code: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const produits = await tx
    .select({ id: jobDeliverableVerificationState.id })
    .from(jobDeliverableVerificationState)
    .where(
      and(
        eq(jobDeliverableVerificationState.jobId, jobId),
        eq(jobDeliverableVerificationState.addressed, true),
        eq(jobDeliverableVerificationState.produced, true),
      ),
    )
    .limit(1);
  if (produits.length === 0) return;

  // La remontée, maillon par maillon, en TypeScript et non en SQL récursif.
  //
  // POURQUOI PAS UN `WITH RECURSIVE` (revue C de cette PR, passe 1). Il aurait
  // fallu le lire par `tx.execute`, dont la FORME du retour dépend du pilote :
  // postgres.js rend un tableau, PGlite un objet `{ rows }`. Le `length` d'une
  // branche d'erreur y était donc `undefined` en test et un nombre en
  // production — un code de diagnostic qui ne se serait jamais journalisé là où
  // les tests tournent. Ici tout passe par l'API typée de Drizzle : un `select`
  // et un `update … returning` rendent des tableaux, quel que soit le pilote.
  //
  // Le coût est celui de `CHAIN_WALK_MAX` lectures par clé primaire AU PIRE ;
  // en pratique une seule (un run de tête) ou trois (le plafond de délégation
  // du produit).
  let courant = jobId;
  for (let pas = 0; pas <= CHAIN_WALK_MAX; pas += 1) {
    const [maillon] = await tx
      .select({ id: agentJobs.id, parentJobId: agentJobs.parentJobId })
      .from(agentJobs)
      .where(eq(agentJobs.id, courant))
      .limit(1);

    if (!maillon) {
      // Impossible tant que la clé étrangère tient : on le dit plutôt que de
      // choisir un run au hasard.
      log(DELIVERABLE_CHECK_NO_ROOT, { jobId, cause: 'maillon_absent', maillon: courant });
      return;
    }

    if (maillon.parentJobId === null) {
      const now = new Date();
      const poses = await tx
        .update(agentJobs)
        .set({ deliverableCheckDueAt: now, updatedAt: now })
        .where(eq(agentJobs.id, maillon.id))
        .returning({ id: agentJobs.id });
      if (poses.length === 0) {
        // ⚠️ AUCUN TEST NE COUVRE CETTE BRANCHE, et c'est assumé : il faudrait
        // que la tête disparaisse ENTRE le `select` juste au-dessus et cet
        // `update`, dans la transaction qui tient déjà son propre verrou. Elle
        // reste parce qu'un `update` qui ne touche rien après un `select` qui a
        // rendu une ligne est précisément ce qu'on ne veut jamais taire
        // (invariant #4). Un mutant qui la retirerait ne ferait donc rougir
        // personne — il n'enlèverait pas non plus un comportement prouvé
        // (revue C, passe 2, constat C2).
        log(DELIVERABLE_CHECK_NO_ROOT, { jobId, cause: 'tete_disparue', maillon: maillon.id });
      }
      return;
    }

    courant = maillon.parentJobId;
  }

  // Plus de `CHAIN_WALK_MAX` maillons sans atteindre de job sans parent : la
  // chaîne boucle, ou elle est plus longue que tout ce que le produit sait
  // créer. Rien n'est posé.
  log(DELIVERABLE_CHECK_NO_ROOT, { jobId, cause: 'chaine_sans_tete', maillons: CHAIN_WALK_MAX });
}

/**
 * Ouvre UN tour de réparation sur les livrables rouges de ce job, ou rend
 * `null` si aucun ne peut en avoir un (issue #375, décision D2).
 *
 * TOUT SE PASSE DANS LA TRANSACTION TERMINALE, et c'est la seule façon d'être
 * juste : `repair_attempts` passe de 0 à 1 SOUS LA MÊME garde de génération
 * que l'écriture d'état, et aucun statut terminal n'est écrit. Un processus
 * qui meurt AVANT le commit ne laisse donc rien : ni réparation marquée, ni
 * statut.
 *
 * CE QU'IL ADVIENT D'UN RUNNER QUI MEURT APRÈS LE COMMIT, dit exactement
 * (constat C1 de la revue C, qui a réfuté la version précédente de ce
 * commentaire) : le job reste `processing`, et il est FAUCHÉ comme n'importe
 * quel job en cours d'un runner mort — `reclaimJobsOfDeadRunners` l'échoue en
 * `runner_restarted` à 2,5 min (`cron/reclaim-jobs.ts`), `resetOrphanedJobs`
 * en `orphan_job_reset` à 5 min. Ni l'un ni l'autre ne rejoue la preuve : le
 * tour de réparation est perdu avec le run, exactement comme le tour ordinaire
 * qu'il aurait joué. Aucun job pendu, et jamais deux réparations — c'est la
 * borne en base qui le garantit, pas la reprise.
 *
 * LA BORNE EST EN BASE, pas en mémoire : le compte déjà consommé est dans le
 * `WHERE`, comparé à `max` (le réglage de l'espace, #377). Un runner
 * redémarré entre le tour de réparation et la re-finalisation relit le
 * compteur et s'arrête au même endroit (« y compris après reprise du
 * processus », D2).
 *
 * `max = 0` ne fait rien du tout : c'est le comportement d'avant #375, le run
 * finit avec son verdict rouge. La garde est ÉCRITE, pas déduite du `WHERE` :
 * sans elle, un `repair_attempts` à 0 satisferait `< 0` — faux — mais la
 * boucle tournerait quand même sur chaque rouge pour rien.
 *
 * UN SEUL TOUR POUR TOUS LES ROUGES. Le brief porte toutes les commandes
 * rouges du job, pas une par livrable : l'agent a un tour, il doit voir tout
 * ce qu'il a à corriger. Un livrable qui a épuisé sa réserve et rougit encore
 * entre dans le brief sans rouvrir quoi que ce soit — c'est un fait que
 * l'agent doit lire, ce n'est plus une chance de plus.
 */
async function ouvrirReparation(
  tx: AnyDrizzleDb,
  jobId: string,
  rouges: readonly { plan: DeliverablePlan; proof: ProofResult }[],
  max: number,
): Promise<RepairTurn | null> {
  if (rouges.length === 0 || max <= 0) return null;

  const now = new Date();
  let ouvert = false;
  for (const rouge of rouges) {
    if (rouge.plan.repairAttempts >= max) continue;
    const marque = await tx
      .update(jobDeliverableVerificationState)
      .set({ repairAttempts: rouge.plan.repairAttempts + 1, updatedAt: now })
      .where(
        and(
          eq(jobDeliverableVerificationState.id, rouge.plan.stateId),
          // Le compte QU'ON A LU : deux finalisations concurrentes ne peuvent
          // pas incrémenter deux fois depuis le même point de départ.
          eq(jobDeliverableVerificationState.repairAttempts, rouge.plan.repairAttempts),
          eq(jobDeliverableVerificationState.dirtyGeneration, rouge.plan.generation),
        ),
      )
      .returning({ id: jobDeliverableVerificationState.id });
    if (marque.length > 0) ouvert = true;
  }
  if (!ouvert) return null;

  const commandes: RepairBriefCommand[] = [];
  for (const rouge of rouges) {
    for (const record of rouge.proof.records) {
      if (record.verdict !== 'red') continue;
      commandes.push({
        // L'ADRESSE si on la connaît, l'identité sinon (constat C2) : c'est
        // ce que l'agent doit rouvrir, pas une clé repliée en casse.
        deliverable: rouge.plan.displayPath ?? rouge.plan.canonicalKey,
        record,
      });
    }
  }
  if (commandes.length === 0) {
    // Un verdict rouge sans commande rouge : la preuve se contredirait. On
    // refuse plutôt que d'ouvrir un tour au brief vide (invariant #4).
    throw new Error(`REPAIR_BRIEF_WITHOUT_RED_COMMAND: ${jobId}`);
  }

  // La réclamation se RELÂCHE (`completeJob` l'aurait fait ; il n'est pas
  // appelé ici) : sans ça, la finalisation d'après le tour de réparation lirait
  // un marqueur frais qui n'est pas le sien et se retirerait pendant dix
  // minutes. Et le tour compte pour UNE reprise de chaîne, comme une reprise
  // après délégation — jamais plus : `repair_attempts` garantit qu'il n'y en a
  // qu'un par job.
  await tx
    .update(agentJobs)
    .set({
      finalizingAt: null,
      chainCount: sql`coalesce(${agentJobs.chainCount}, 0) + 1`,
      updatedAt: now,
    })
    .where(eq(agentJobs.id, jobId));

  return {
    brief: buildRepairBrief(commandes),
    keys: rouges.map((r) => r.plan.canonicalKey),
  };
}

// ─── La primitive ───────────────────────────────────────────────────────────

/**
 * Finalise un job en SUCCÈS : calcule la décision de vérification de chacun de
 * ses livrables, la journalise, écrit le statut terminal.
 *
 * Rend `already_terminal` sans rien écrire si le job est déjà fini — y compris
 * quand un second finaliseur du MÊME job arrive après le premier.
 */
export async function finalizeJobSuccess(
  db: AnyDrizzleDb,
  input: FinalizeInput,
  deps: FinalizeDeps = {},
): Promise<FinalizeOutcome> {
  const { jobId, result: finalText } = input;
  const toolsUsed = [...(input.toolsUsed ?? [])];
  const log = deps.log ?? defaultLog;
  const resolveVerifier = deps.getVerifier ?? getVerifier;
  const newSequenceId = deps.newSequenceId ?? randomUUID;

  // Refus AVANT toute écriture : une livraison demandée sans préparateur est
  // une erreur de câblage, pas une livraison silencieusement perdue.
  if (input.delivery && !deps.prepareDelivery) {
    throw new Error(`${DELIVERY_PREPARE_UNAVAILABLE}: ${input.delivery.channel}`);
  }

  const alreadyTerminal: FinalizeOutcome = {
    kind: 'already_terminal',
    observedOutcome: 'already_terminal',
    observedDue: false,
    decisions: [],
  };

  // ─── Transaction 1 : verrous, lecture, capture de G ───────────────────────
  const opened = await db.transaction(async (tx): Promise<OpenedJob | null> => {
    const jobRows = await tx
      .select({
        entityId: agentJobs.entityId,
        status: agentJobs.status,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .for('update');
    const job = jobRows[0];
    if (!job) throw new Error(`${FINALIZE_JOB_NOT_FOUND}: ${jobId}`);
    // Le STATUT seul dit qu'un job est terminal — pas `completed_at`. Un job
    // remis à `pending` par le tableau de bord (nouvel essai, F1/Leg1) garde
    // l'horodatage de son premier passage : le refuser sur cette seule trace
    // rendrait un job réessayé infinalisable (trouvé par la suite d'execute).
    if (TERMINAL_STATUSES.includes(job.status as (typeof TERMINAL_STATUSES)[number])) return null;

    // LA RÉCLAMATION (verdict d'incomplétude du découpage) : la preuve tourne
    // hors transaction, donc le verrou ci-dessus ne sérialise plus deux
    // finalisations du même job — sans marqueur, chacune lancerait SA preuve
    // et la seconde ne l'apprendrait qu'en transaction 2. Le marqueur
    // `finalizing_at` est posé ici, sous le verrou : libre, périmé, ou déjà
    // le nôtre (le cron l'a posé avant sa synthèse) ⇒ à nous ; frais et posé
    // par un autre ⇒ on se retire, dit par un code. `completeJob` le lève.
    const claimNow = new Date();
    const claimCutoff = new Date(claimNow.getTime() - FINALIZING_STALE_MS);
    const claimed = await tx
      .update(agentJobs)
      .set({ finalizingAt: claimNow })
      .where(
        and(
          eq(agentJobs.id, jobId),
          or(
            isNull(agentJobs.finalizingAt),
            lt(agentJobs.finalizingAt, claimCutoff),
            input.claim ? eq(agentJobs.finalizingAt, input.claim.finalizingAt) : sql`false`,
          ),
        ),
      )
      .returning({ id: agentJobs.id });
    if (claimed.length === 0) {
      log(FINALIZE_CLAIMED_ELSEWHERE, { jobId });
      return null;
    }

    const states = await tx
      .select({
        id: jobDeliverableVerificationState.id,
        deliverableType: jobDeliverableVerificationState.deliverableType,
        canonicalKey: jobDeliverableVerificationState.canonicalKey,
        dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration,
        displayPathSnapshot: jobDeliverableVerificationState.displayPathSnapshot,
        repairAttempts: jobDeliverableVerificationState.repairAttempts,
      })
      .from(jobDeliverableVerificationState)
      .where(eq(jobDeliverableVerificationState.jobId, jobId));

    // Ordre déterministe (type, clé) : les verrous `code_projects` que
    // `loadConfig` prend ensuite sont pris dans le même ordre par TOUS les
    // jobs, ce qui interdit l'interblocage croisé.
    const ordered = [...states].sort(
      (a, b) =>
        a.deliverableType.localeCompare(b.deliverableType) ||
        a.canonicalKey.localeCompare(b.canonicalKey),
    );

    const plans: DeliverablePlan[] = [];
    for (const state of ordered) {
      const verifier = resolveVerifier(state.deliverableType);
      if (state.dirtyGeneration === null) {
        throw new Error(
          `${VERIFY_STATE_GENERATION_MISSING}: ${state.deliverableType} ${state.canonicalKey}`,
        );
      }
      if (job.entityId === null) {
        throw new Error(
          `${FINALIZE_JOB_WITHOUT_ENTITY}: ${state.deliverableType} ${state.canonicalKey}`,
        );
      }
      const config = await verifier.loadConfig(tx, {
        entityId: job.entityId,
        canonicalKey: state.canonicalKey,
        // L'ADRESSE, à côté de l'identité : un document s'ouvre par son chemin
        // réel, jamais par sa clé repliée en casse (constat C2).
        displayPath: state.displayPathSnapshot,
      });
      plans.push({
        stateId: state.id,
        deliverableType: state.deliverableType,
        canonicalKey: state.canonicalKey,
        displayPath: state.displayPathSnapshot,
        generation: state.dirtyGeneration,
        repairAttempts: state.repairAttempts,
        verifier,
        config,
      });
    }
    // LE RÉGLAGE DE L'ESPACE (#377), lu dans la même transaction que le reste
    // et pas plus tard : ce qui décide de rouvrir le run doit être lu avant la
    // preuve, comme la configuration de chaque livrable. Un job sans espace
    // n'a aucun livrable — la lecture n'a pas lieu, et la borne vaut zéro.
    let maxReparations = 0;
    if (job.entityId !== null && plans.length > 0) {
      const [espace] = await tx
        .select({ proofRepairAttempts: entities.proofRepairAttempts })
        .from(entities)
        .where(eq(entities.id, job.entityId));
      if (!espace) {
        // ⚠️ AUCUN TEST NE COUVRE CETTE BRANCHE, et c'est assumé : il faudrait
        // que la ligne `entities` disparaisse alors qu'un job la référence, ce
        // que la clé étrangère interdit. Elle reste parce que réparer selon un
        // défaut inventé serait pire que ne pas réparer, et parce qu'un repli
        // muet est exactement ce que l'invariant #4 refuse (Reviewer C, #392).
        maxReparations = 0;
        log(VERIFY_REPAIR_SETTING_UNREADABLE, {
          jobId,
          entityId: job.entityId,
          cause: 'no_entity',
        });
      } else {
        maxReparations = readProofRepairAttempts(espace.proofRepairAttempts);
        if (maxReparations !== espace.proofRepairAttempts) {
          // Le CHECK de la colonne interdit d'ÉCRIRE une valeur hors bornes :
          // en LIRE une veut dire qu'elle est entrée autrement — restauration
          // d'une sauvegarde antérieure à la contrainte, contrainte tombée.
          // Rabattue sur la borne la plus proche, et dite.
          log(VERIFY_REPAIR_SETTING_UNREADABLE, {
            jobId,
            entityId: job.entityId,
            stored: espace.proofRepairAttempts,
            used: maxReparations,
          });
        }
      }
    }

    return { entityId: job.entityId, plans, maxReparations };
  });

  if (!opened) return alreadyTerminal;

  // ─── Hors transaction : la preuve ─────────────────────────────────────────
  //
  // Une panne d'écriture d'observabilité est avalée ICI avec un code : elle ne
  // doit pas casser la preuve, ni l'issue du job (décision n°4).
  let persistenceFailed = false;
  const proofs = new Map<string, ProofResult>();
  for (const plan of opened.plans) {
    if (plan.config.kind !== 'ready') continue;
    const ready: ReadyConfig = plan.config;
    const sequenceId = newSequenceId();
    const proof = await plan.verifier.runProof(ready, async (record: ProofCommandRecord) => {
      try {
        await db.insert(verificationRuns).values({
          jobId,
          entityId: opened.entityId,
          deliverableType: plan.deliverableType,
          canonicalKey: plan.canonicalKey,
          manifestHash: ready.manifestHash,
          sequenceId,
          commandRank: record.rank,
          command: record.command,
          exitCode: record.exitCode,
          outcomeKind: record.outcomeKind,
          stdoutTail: record.stdoutTail,
          stderrTail: record.stderrTail,
          durationMs: record.durationMs,
          verdict: record.verdict,
          testedGeneration: plan.generation,
          testedEpoch: ready.epoch,
        });
      } catch (error) {
        persistenceFailed = true;
        log(VERIFY_PERSISTENCE_FAILED, {
          jobId,
          key: plan.canonicalKey,
          rank: record.rank,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    proofs.set(plan.stateId, proof);
  }

  // ─── Transaction 2 : décision, statut terminal ────────────────────────────
  const committed = await db.transaction(
    async (tx): Promise<{ decisions: DeliverableDecision[]; repair?: RepairTurn } | null> => {
      // La MÊME garde qu'en transaction 1, reprise sous le verrou : c'est elle
      // qui sérialise deux finalisations concurrentes du même job. Celle qui
      // arrive après le commit de l'autre lit un job terminal et n'écrit rien.
      const jobRows = await tx
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, jobId))
        .for('update');
      const job = jobRows[0];
      if (!job) throw new Error(`${FINALIZE_JOB_NOT_FOUND}: ${jobId}`);
      if (TERMINAL_STATUSES.includes(job.status as (typeof TERMINAL_STATUSES)[number])) return null;

      const decisions: DeliverableDecision[] = [];
      /**
       * Les livrables dont le verdict est ROUGE et dont l'écriture d'état a
       * bien atterri — les seuls candidats à un tour de réparation. Un rouge
       * retombé en `dirty` (génération périmée, panne d'écriture) n'en est pas
       * un : on ne fait pas réparer ce qu'on n'a pas su prouver.
       */
      const rouges: { plan: DeliverablePlan; proof: ProofResult }[] = [];

      for (const plan of opened.plans) {
        const proof = proofs.get(plan.stateId) ?? null;
        let status = decisionStatusFor(plan.config, proof);
        const ready = plan.config.kind === 'ready' ? plan.config : null;

        // L'ARBRE A-T-IL BOUGÉ PENDANT LA PREUVE ? Le garde de génération
        // ci-dessous ne voit que les écritures de CE job ; un autre job qui
        // écrit dans le même projet pendant la preuve avance l'epoch du projet
        // (intention T16) sans toucher notre état. La configuration est relue
        // sous verrou, dans le même ordre (type, clé) qu'en transaction 1 :
        // epoch ou manifeste différents ⇒ ce qui a été prouvé n'est plus
        // l'arbre courant, l'état reste sale, et c'est dit.
        if (ready && opened.entityId !== null) {
          const current = await plan.verifier.loadConfig(tx, {
            entityId: opened.entityId,
            canonicalKey: plan.canonicalKey,
            displayPath: plan.displayPath,
          });
          // Comparer à ce que la preuve a RÉELLEMENT lu quand elle sait le dire,
          // et à la configuration sinon. Sans ça, une séquence A → B → A passe :
          // la transaction 1 voit A, la preuve trouve B vert, un autre job remet
          // A, et les deux empreintes coïncident (dette #66, passe 3, R1).
          const provenHash = proof?.provedManifestHash ?? ready.manifestHash;
          const moved =
            current.kind !== 'ready' ||
            current.epoch !== ready.epoch ||
            current.manifestHash !== provenHash;
          if (moved) {
            status = 'dirty';
            log(VERIFY_STALE_EPOCH, {
              jobId,
              key: plan.canonicalKey,
              testedEpoch: ready.epoch,
              currentEpoch: current.kind === 'not_configured' ? null : current.epoch,
            });
          }
        }
        let effective = status;

        try {
          const updated = await tx
            .update(jobDeliverableVerificationState)
            .set({
              decisionStatus: status,
              // Un vert REMET LE COMPTEUR DE ROUGES À ZÉRO : `red_streak` dit
              // les rouges consécutifs, pas les rouges de toujours. L'incrément,
              // lui, n'est PAS écrit ici : il n'a lieu que si le rouge est le
              // dernier mot (voir plus bas, après la décision de réparation).
              ...(status === 'green' ? { verifiedGeneration: plan.generation, redStreak: 0 } : {}),
              ...(ready
                ? { testedEpoch: ready.epoch, commandHashSnapshot: ready.manifestHash }
                : {}),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(jobDeliverableVerificationState.id, plan.stateId),
                eq(jobDeliverableVerificationState.dirtyGeneration, plan.generation),
              ),
            )
            .returning({ id: jobDeliverableVerificationState.id });

          if (updated.length === 0) {
            // Une écriture est passée pendant la preuve : ce qu'on vient de
            // prouver ne concerne plus la génération courante. L'état RESTE
            // sale ; en ① le job finit quand même (correction T09(c)).
            effective = 'dirty';
            log(VERIFY_STALE_GENERATION, {
              jobId,
              key: plan.canonicalKey,
              generation: plan.generation,
            });
          }
        } catch (error) {
          persistenceFailed = true;
          effective = 'dirty';
          log(VERIFY_PERSISTENCE_FAILED, {
            jobId,
            key: plan.canonicalKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        if (effective === 'red') {
          const prouve = proofs.get(plan.stateId);
          // `red` ne sort de `decisionStatusFor` que sur un `proof` non nul :
          // la garde est là pour le compilateur, pas pour un cas atteignable.
          if (prouve) rouges.push({ plan, proof: prouve });
        }

        decisions.push({
          deliverableType: plan.deliverableType,
          canonicalKey: plan.canonicalKey,
          decisionStatus: effective,
          ...classify(effective),
        });
      }

      // ─── PR② : UN tour de réparation, ou le rouge est le dernier mot ──────
      const repair =
        input.repairTurn === 'supported'
          ? await ouvrirReparation(tx, jobId, rouges, opened.maxReparations)
          : null;

      if (repair) {
        // RIEN de terminal n'est écrit : pas de `completeJob`, pas de
        // `poseDeliverableCheck` (le run n'a pas livré, il rejoue), pas de
        // livraison préparée (livrer une notice sur un job qui continue la
        // dupliquerait au tour suivant). L'état des livrables, lui, EST commis
        // — le rouge est un fait, réparé ou non.
        return { decisions, repair };
      }

      // Aucune réparation : chaque rouge est définitif pour ce job, et le
      // compteur de rouges consécutifs l'enregistre. Même garde de génération
      // que l'écriture d'état plus haut — sur une ligne qui aurait bougé
      // depuis, on n'incrémente rien.
      for (const rouge of rouges) {
        await tx
          .update(jobDeliverableVerificationState)
          .set({
            redStreak: sql`${jobDeliverableVerificationState.redStreak} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(jobDeliverableVerificationState.id, rouge.plan.stateId),
              eq(jobDeliverableVerificationState.dirtyGeneration, rouge.plan.generation),
            ),
          );
      }

      // L'écriture terminale elle-même : `completeJob` porte déjà la
      // sémantique exacte attendue (préservation d'un `result` non vide écrit
      // plus tôt, remplissage depuis les enfants puis depuis le transcript,
      // nettoyage de l'erreur, stats, transcript + texte de recherche). Elle
      // est APPELÉE, pas recopiée — deux copies divergeraient.
      const landed = await completeJob(
        tx,
        jobId,
        finalText,
        toolsUsed,
        input.stats,
        input.messages,
        // La provenance, posée dans la MÊME écriture que le texte (#154, #210).
        input.resultKind,
      );
      if (!landed) {
        // Impossible tant que le `FOR UPDATE` ci-dessus tient : on le dit fort
        // plutôt que de rendre `completed` sur une ligne qu'on n'a pas écrite.
        // LEVÉ, pas rendu : un `return null` committerait les décisions d'état
        // écrites juste au-dessus sous un statut jamais posé (revue T09).
        log(VERIFY_TERMINAL_WRITE_LOST, { jobId });
        throw new Error(`${VERIFY_TERMINAL_WRITE_LOST}: ${jobId}`);
      }

      // LE RUN A LIVRÉ : un livrable attend un regard (#255). Dans la MÊME
      // transaction que le statut terminal, comme la ligne `job_deliveries`
      // juste en dessous — un crash entre les deux laisserait sinon un run
      // livré dont aucune pastille ne dit qu'il attend.
      await poseDeliverableCheck(tx, jobId, log);

      if (input.delivery && deps.prepareDelivery) {
        await deps.prepareDelivery(tx, { jobId, ...input.delivery });
      }

      return { decisions };
    },
  );

  if (!committed) return alreadyTerminal;

  const { decisions, repair } = committed;
  if (repair) {
    // Le job N'EST PAS terminal : il repart pour un tour, avec `repair.brief`
    // en entrée. Journalisé par un CODE et des données, jamais une phrase.
    log(VERIFY_REPAIR_TURN_OPENED, { jobId, keys: repair.keys });
    return {
      kind: 'repair_due',
      observedOutcome: 'repair_due',
      observedDue: true,
      decisions,
      repair,
    };
  }
  const observedDue = decisions.some((d) => d.due);
  if (observedDue) {
    log(VERIFICATION_DUE_OBSERVED, {
      jobId,
      keys: decisions.filter((d) => d.due).map((d) => d.canonicalKey),
    });
  }

  // Le résultat typé COMPLET — calculé, journalisé, non opposé (v5-C).
  // `review_pending` n'est jamais produit en ① : aucun cycle de revue
  // n'existe avant PR④.
  const observedOutcome: ObservedOutcome = persistenceFailed
    ? 'verification_persistence_failed'
    : observedDue
      ? 'verification_due'
      : decisions.some((d) => d.unverifiable)
        ? 'completed_unverified'
        : 'completed';

  // La garde n'est PAS branchée : tout ce qui n'est pas un succès pleinement
  // vérifié finit `completed_unverified`, jamais bloqué.
  const kind: FinalizeKind = observedOutcome === 'completed' ? 'completed' : 'completed_unverified';

  return { kind, observedOutcome, observedDue, decisions };
}

// ─── La porte terminale d'ÉCHEC ─────────────────────────────────────────────

/**
 * Écrit l'échec terminal d'un job ET, dans la MÊME transaction, l'intention de
 * livrer ce que le harnais a à dire (issue #116, résidu 3).
 *
 * La couture T08 n'existait que du côté succès : `finalizeJobSuccess` pose la
 * ligne `job_deliveries` en `prepared` dans la transaction qui pose le statut.
 * Les chemins d'échec, eux, écrivaient la ligne terminale, PUIS préparaient la
 * notice. Une panne entre les deux laissait un job fini avec rien à livrer, et
 * aucune reprise ne pouvait le rattraper : le drain ne réclame que des lignes
 * `prepared`, et il n'y en avait pas.
 *
 * Même refus qu'au succès, et avant toute écriture : demander une livraison
 * sans fournir le préparateur LÈVE `DELIVERY_PREPARE_UNAVAILABLE` (invariant
 * #4). Une livraison n'est préparée que si l'écriture terminale a ATTERRI —
 * un job qu'un autre écrivain a déjà fini n'est pas le nôtre à commenter.
 *
 * Rend `true` si cette écriture-ci a posé le statut terminal.
 */
export async function finalizeJobFailure(
  db: AnyDrizzleDb,
  input: FinalizeFailureInput,
  deps: Pick<FinalizeDeps, 'prepareDelivery'> = {},
): Promise<boolean> {
  if (input.delivery && !deps.prepareDelivery) {
    throw new Error(`${DELIVERY_PREPARE_UNAVAILABLE}: ${input.delivery.channel}`);
  }
  return db.transaction(async (tx) => {
    const landed = await failJob(
      tx,
      input.jobId,
      input.errorCode,
      input.stats,
      input.messages,
      input.userMessage,
    );
    if (landed && input.delivery && deps.prepareDelivery) {
      await deps.prepareDelivery(tx, { jobId: input.jobId, ...input.delivery });
    }
    return landed;
  });
}
