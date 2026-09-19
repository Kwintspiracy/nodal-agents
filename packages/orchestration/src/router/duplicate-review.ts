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
// texte : « la même chose », c'est le MÊME AGENT délégué ET la MÊME CIBLE,
// où la cible est lue dans la tâche par deux formes écrites, jamais par une
// ressemblance de phrases (voir `extractReviewTarget`). Sans cible
// reconnaissable, pas de garde — un refus fondé sur rien coûterait plus cher
// que le doublon qu'il évite.
//
// ⚠️ Conséquence assumée : une boucle revue → correction → revue DANS UN MÊME
// JOB, vers le même relecteur et la même cible, est refusée à la seconde passe.
// C'est ce que l'issue #173 demande, et le refus le dit en toutes lettres pour
// que le modèle conclue au lieu de s'entêter — une seconde passe après
// correction se demande dans un nouveau job, qui a sa propre liste d'enfants.
// Le refus est un résultat d'outil, jamais une exception : le job continue,
// l'information est DITE (invariant #4).

import { and, desc, eq, agentJobs, agents, toolCalls } from '@nodal-agents/db';
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
 *    `apps/<...>` → `path:packages/orchestration`.
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
  for (const m of task.matchAll(/\b((?:packages|apps)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g)) {
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
 * relecteur — s'il existe.
 *
 * Une seule requête, bornée à l'entité et au job parent : les enfants directs
 * du parent, joints à leur agent (pour le slug) et à leurs lignes
 * `review_verdict`. Le verdict retenu par enfant est celui de sa DERNIÈRE
 * ligne (`seq` décroissant) — la même lecture que
 * `readDeliveredReviewVerdict`, qui fait foi quand un relecteur a corrigé un
 * appel refusé.
 *
 * Le tri par `seq` vaut aussi entre enfants : à cible égale, c'est le verdict
 * écrit en dernier qui est nommé dans le refus.
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

    return {
      childJobId: row.childJobId,
      target,
      childSlug: params.childSlug,
      verdict,
    };
  }

  return null;
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
