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
import { agentJobs, jobDeliverableVerificationState, verificationRuns } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { DecisionStatus } from '@nodal-agents/shared';
import { getVerifier } from '../verification/registry.ts';
import type {
  DeliverableVerifier,
  LoadedConfig,
  ProofCommandRecord,
  ProofResult,
  ReadyConfig,
} from '../verification/registry.ts';
import { TERMINAL_STATUSES, completeJob } from './state.ts';

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
  | 'verification_persistence_failed';

/**
 * Ce que la primitive rend EFFECTIVEMENT en PR① : le job finit, ou il était
 * déjà fini. `verification_due` et `verification_persistence_failed` sont
 * observés, journalisés, et rendus comme `completed_unverified` — la phase
 * d'observation interdit de changer l'issue d'un job.
 */
export type FinalizeKind = 'completed' | 'completed_unverified' | 'already_terminal';

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

export interface FinalizeOutcome {
  readonly kind: FinalizeKind;
  /** Le résultat typé COMPLET, calculé même quand il n'est pas opposé. */
  readonly observedOutcome: ObservedOutcome;
  /** Au moins un livrable dû. Journalisé ; sans effet sur `kind` en ①. */
  readonly observedDue: boolean;
  readonly decisions: readonly DeliverableDecision[];
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
  readonly delivery?: {
    readonly channel: string;
    readonly chatId: string;
    readonly payload: string;
  };
}

// ─── Interne ────────────────────────────────────────────────────────────────

/** Ce que la transaction 1 a établi pour UN livrable, avant la preuve. */
interface DeliverablePlan {
  readonly stateId: string;
  readonly deliverableType: string;
  readonly canonicalKey: string;
  /** La génération sale capturée sous verrou — le garde de la transaction 2. */
  readonly generation: number;
  readonly verifier: DeliverableVerifier;
  readonly config: LoadedConfig;
}

interface OpenedJob {
  /** Nullable comme la colonne : un job sans espace n'a simplement aucun livrable. */
  readonly entityId: string | null;
  readonly plans: readonly DeliverablePlan[];
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
      });
      plans.push({
        stateId: state.id,
        deliverableType: state.deliverableType,
        canonicalKey: state.canonicalKey,
        generation: state.dirtyGeneration,
        verifier,
        config,
      });
    }
    return { entityId: job.entityId, plans };
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
    async (tx): Promise<{ decisions: DeliverableDecision[] } | null> => {
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
          });
          const moved =
            current.kind !== 'ready' ||
            current.epoch !== ready.epoch ||
            current.manifestHash !== ready.manifestHash;
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
              ...(status === 'green' ? { verifiedGeneration: plan.generation } : {}),
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

        decisions.push({
          deliverableType: plan.deliverableType,
          canonicalKey: plan.canonicalKey,
          decisionStatus: effective,
          ...classify(effective),
        });
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
      );
      if (!landed) {
        // Impossible tant que le `FOR UPDATE` ci-dessus tient : on le dit fort
        // plutôt que de rendre `completed` sur une ligne qu'on n'a pas écrite.
        // LEVÉ, pas rendu : un `return null` committerait les décisions d'état
        // écrites juste au-dessus sous un statut jamais posé (revue T09).
        log(VERIFY_TERMINAL_WRITE_LOST, { jobId });
        throw new Error(`${VERIFY_TERMINAL_WRITE_LOST}: ${jobId}`);
      }

      if (input.delivery && deps.prepareDelivery) {
        await deps.prepareDelivery(tx, { jobId, ...input.delivery });
      }

      return { decisions };
    },
  );

  if (!committed) return alreadyTerminal;

  const { decisions } = committed;
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
