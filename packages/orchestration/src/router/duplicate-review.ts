// router/duplicate-review.ts — une seconde revue de la MÊME chose, dans le même
// job, par le même relecteur, n'est pas lancée (issue #173).
//
// Ce qui a été observé (incident #124, 16/09/2026) : un parent délègue la revue
// de la PR #113, l'enfant enregistre son verdict avec `review_verdict`, et le
// parent redélègue la même revue au même spécialiste — trente à quarante
// minutes de modèle payées deux fois pour rendre le verdict déjà rendu. La
// PR #170 a fait VOYAGER le verdict jusqu'au parent (`DelegationOutcomeRecord.
// review_verdict`) : c'est de l'information pour le modèle, pas une garde. Un
// modèle qui redemande quand même repart pour un tour.
//
// La règle posée ici ne connaît aucun agent (invariant #3) et ne juge aucun
// texte. Elle tient en trois conditions, toutes lues sur des lignes :
//
//  1. MÊME AGENT délégué que celui qui a livré le verdict ;
//  2. MÊME CIBLE, lue dans la tâche par deux formes écrites, jamais par une
//     ressemblance de phrases (voir `extractReviewTarget`) — sans cible
//     reconnaissable, pas de garde, un refus fondé sur rien coûterait plus
//     cher que le doublon qu'il évite ;
//  3. RIEN N'A ABOUTI DEPUIS le verdict : aucune AUTRE délégation de ce job
//     n'est passée à `completed` après la ligne `review_verdict`.
//
// La troisième condition est ce qui sépare le doublon de la boucle de travail.
// Un orchestrateur qui fait relire, fait CORRIGER par un dev, puis fait relire
// la même PR demande une seconde passe sur une cible qui a changé : elle est
// légitime, et la refuser casserait un usage réel de Nodal. La seule
// redondance CERTAINE est la seconde passe sur une cible que personne n'a
// touchée entre-temps — le parent n'a rien fait faire, et la relecture rendrait
// le verdict déjà rendu. « Avoir abouti » se lit sur `status = 'completed'`, et
// non sur « une délégation a été lancée » : un enfant encore en cours n'a rien
// changé à la cible, un enfant qui a échoué non plus.
//
// Le refus est un résultat d'outil, jamais une exception : le job continue,
// l'information est DITE (invariant #4).

import { and, desc, eq, gt, isNotNull, ne, agentJobs, agents, toolCalls } from '@nodal-agents/db';
import { parseReviewVerdictOutput, REVIEW_VERDICT_TOOL } from './review-verdict';
import type { ReviewVerdictRecord } from './review-verdict';
import type { AnyDrizzleDb, EntityId, JobId } from '../types';

/**
 * La cible d'une tâche de revue, telle qu'elle est ÉCRITE dans la tâche.
 *
 * Deux formes, et deux seulement :
 *  - une ou plusieurs références de PR — `#185`, `PR 185`, `pr-185`, `PR/185`
 *    (la casse est ignorée) → `pr:185` ;
 *  - à défaut, un ou plusieurs chemins de paquet — `packages/<...>` ou
 *    `apps/<...>`, la casse ignorée là aussi → `path:packages/orchestration`.
 *    Un chemin est rendu en MINUSCULES : sur Windows `APPS/Web` et `apps/web`
 *    désignent le même dossier, et deux écritures d'un même chemin ne doivent
 *    pas faire deux cibles (revue de la PR #220).
 *
 * Les références trouvées sont dédoublonnées et TRIÉES : la cible est un
 * ensemble, pas une phrase. « relis #190 et #185 » et « relis #185 et #190 »
 * désignent donc la même chose, tandis que « relis #185 » et « relis #185
 * et #190 » désignent deux choses différentes — la seconde demande davantage,
 * et la refuser sur la foi de la première laisserait la PR #190 non relue.
 *
 * Les PR l'emportent sur les chemins quand les deux figurent : c'est la forme
 * la plus précise, et une tâche de revue de PR cite presque toujours des
 * chemins au passage.
 *
 * Rend `null` quand rien n'est reconnu — aucune garde ne s'appuie sur une
 * cible devinée.
 */
export function extractReviewTarget(task: string | null | undefined): string | null {
  if (!task) return null;

  const prNumbers = new Set<string>();
  // `#185` : le dièse collé au nombre, précédé de n'importe quoi sauf un
  // caractère de mot (pour ne pas lire `abc#185` comme une PR).
  for (const m of task.matchAll(/(?:^|[^\w#])#(\d{1,6})\b/g)) {
    if (m[1]) prNumbers.add(String(Number(m[1])));
  }
  // `PR 185`, `pr-185`, `PR/185`, `pull request 185`.
  for (const m of task.matchAll(/\b(?:pr|pull\s+request)[\s\-/#]*(\d{1,6})\b/gi)) {
    if (m[1]) prNumbers.add(String(Number(m[1])));
  }
  if (prNumbers.size > 0) {
    return `pr:${[...prNumbers].sort((a, b) => Number(a) - Number(b)).join('+')}`;
  }

  const paths = new Set<string>();
  for (const m of task.matchAll(/\b((?:packages|apps)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/gi)) {
    if (m[1]) paths.add(m[1].toLowerCase().replace(/[./]+$/, ''));
  }
  if (paths.size > 0) {
    return `path:${[...paths].sort().join('+')}`;
  }

  return null;
}

/** Ce qu'un enfant a DÉJÀ livré sur cette cible, dans ce job. */
export interface DeliveredReviewMatch {
  /** Le job enfant qui a livré le verdict. */
  childJobId: string;
  /** La cible commune, dans la forme normalisée d'`extractReviewTarget`. */
  target: string;
  /** Le slug de l'agent relecteur. */
  childSlug: string;
  /** Le verdict, tel que l'outil l'a validé. */
  verdict: ReviewVerdictRecord;
}

/**
 * L'enfant de CE job qui a déjà livré un verdict sur CETTE cible, par CE
 * relecteur, ET SUR LEQUEL RIEN N'A BOUGÉ DEPUIS — s'il existe.
 *
 * Deux lectures, toutes deux bornées à l'entité et au job parent :
 *
 *  - les enfants directs du parent, joints à leur agent (pour le slug) et à
 *    leurs lignes `review_verdict`. Le verdict retenu par enfant est celui de
 *    sa DERNIÈRE ligne (`seq` décroissant) — la même lecture que
 *    `readDeliveredReviewVerdict`, qui fait foi quand un relecteur a corrigé
 *    un appel refusé. Le tri par `seq` vaut aussi entre enfants : à cible
 *    égale, c'est le verdict écrit en dernier qui est nommé dans le refus ;
 *  - la fenêtre depuis ce verdict : un AUTRE enfant du même parent, passé à
 *    `completed` après l'heure de la ligne du verdict. S'il en existe un,
 *    quelque chose a été fait entre les deux relectures et la seconde passe
 *    est légitime — cette fonction rend `null`, la délégation part.
 *
 * La fenêtre se lit sur `tool_calls.created_at` et `agent_jobs.completed_at`,
 * pas sur `seq` : `seq` n'existe que sur les lignes d'outils et ne place pas
 * un job dans le temps. La comparaison est STRICTE (`>`) et un enfant
 * `completed` sans `completed_at` (lignes anciennes) ne compte pas : à égalité
 * d'instant, ou sans instant, rien ne PROUVE que le travail a suivi le
 * verdict, et la garde reste posée.
 */
export async function findDeliveredReviewForTarget(
  db: AnyDrizzleDb,
  params: {
    parentJobId: JobId;
    entityId: EntityId;
    childSlug: string;
    task: string | null | undefined;
  },
): Promise<DeliveredReviewMatch | null> {
  const target = extractReviewTarget(params.task);
  if (target === null) return null;

  const rows = await db
    .select({
      childJobId: agentJobs.id,
      childTask: agentJobs.task,
      toolOutput: toolCalls.toolOutput,
      verdictAt: toolCalls.createdAt,
      seq: toolCalls.seq,
    })
    .from(toolCalls)
    .innerJoin(agentJobs, eq(agentJobs.id, toolCalls.jobId))
    .innerJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(
      and(
        eq(agentJobs.parentJobId, params.parentJobId as string),
        eq(agentJobs.entityId, params.entityId as string),
        eq(agents.slug, params.childSlug),
        eq(toolCalls.toolName, REVIEW_VERDICT_TOOL),
      ),
    )
    .orderBy(desc(toolCalls.seq));

  const seen = new Set<string>();
  for (const row of rows) {
    // Une seule ligne par enfant : la première rencontrée est la dernière
    // écrite. Les suivantes sont des appels antérieurs que le relecteur a
    // lui-même remplacés.
    if (seen.has(row.childJobId)) continue;
    seen.add(row.childJobId);

    if (extractReviewTarget(row.childTask) !== target) continue;
    const verdict = parseReviewVerdictOutput(row.toolOutput);
    if (!verdict) continue;

    // Quelque chose a-t-il abouti depuis ce verdict ? Une correction terminée,
    // n'importe quel autre délégué passé à `completed` : la cible a bougé, la
    // relecture n'est plus le même travail.
    if (row.verdictAt && (await somethingCompletedSince(db, params, row.childJobId, row.verdictAt)))
      return null;

    return {
      childJobId: row.childJobId,
      target,
      childSlug: params.childSlug,
      verdict,
    };
  }

  return null;
}

/**
 * Un AUTRE enfant de ce parent a-t-il abouti après cet instant ?
 *
 * Borné au job parent et à l'entité, l'enfant relecteur exclu : c'est lui qui
 * a écrit le verdict, sa propre fin ne prouve rien sur la cible.
 */
async function somethingCompletedSince(
  db: AnyDrizzleDb,
  params: { parentJobId: JobId; entityId: EntityId },
  reviewerChildJobId: string,
  since: Date,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentJobs.id })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.parentJobId, params.parentJobId as string),
        eq(agentJobs.entityId, params.entityId as string),
        ne(agentJobs.id, reviewerChildJobId),
        eq(agentJobs.status, 'completed'),
        isNotNull(agentJobs.completedAt),
        gt(agentJobs.completedAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Le code de refus, tel qu'il apparaît dans le résultat d'outil. */
export const DUPLICATE_REVIEW_REFUSAL_CODE = 'duplicate_review_blocked';

/**
 * Le refus, écrit pour le modèle qui va le lire : il NOMME le verdict existant
 * (verdict, résumé, compte des constats, id du job enfant) pour que le parent
 * puisse conclure sans relancer quoi que ce soit.
 *
 * Ce texte part dans un `tool_result`, pas vers la personne : il n'entre pas
 * sous l'invariant #2 (pas de texte utilisateur codé en dur dans le runner),
 * exactement comme `delegation_depth_exceeded` et `delegation_retry_blocked`
 * à côté. Il est en anglais, comme eux.
 */
export function describeDuplicateReview(match: DeliveredReviewMatch): string {
  const { verdict } = match;
  const counts = `${verdict.counts.blocker} blocker, ${verdict.counts.major} major, ${verdict.counts.minor} minor`;
  return (
    `${DUPLICATE_REVIEW_REFUSAL_CODE}: ${match.childSlug} already delivered a review verdict for ` +
    `${match.target} in this job (child job ${match.childJobId}), so this second review was NOT run. ` +
    `Verdict: ${verdict.verdict} (${counts}). Summary: ${verdict.summary} ` +
    `Use that verdict — do not ask for the same review again. If the code changed since, the new ` +
    `review belongs to a new job; here, act on the verdict above or call return_result.`
  );
}
