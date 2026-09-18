// router/review-verdict.ts — le verdict de revue EST le livrable du job qui
// l'a enregistré (issue #124).
//
// Ce qui a été observé le 16/09/2026, sur six revues : un agent relecteur
// termine par l'outil `review_verdict` (verdict, résumé, constats). L'appel est
// écrit dans `tool_calls`, mais ce que le parent reçoit par le contrat de
// délégation, c'est le `result` du job — la dernière phrase du modèle, « je
// constate maintenant le verdict et je livre les constats ». Le parent, qui
// orchestre les revues, redéléguait alors la MÊME revue (job ebf1951a, PR #113,
// puis un second enfant sous le même parent), et la personne allait lire
// `tool_calls` à la main.
//
// La règle posée ici ne connaît aucun agent (invariant #3) : un job dont le
// DERNIER appel à `review_verdict` a réussi livre ce verdict, quel que soit
// l'agent, sa skill ou son canal. La lecture se fait sur les lignes réelles,
// jamais sur la transcription — c'est l'outil qui a validé le verdict par son
// schéma Zod, pas le texte du modèle.

import { desc, eq, and, toolCalls } from '@nodal-agents/db';
import { OrchestrationError } from '../errors';
import type { AnyDrizzleDb, JobId } from '../types';

/** Le nom de l'outil, tel qu'il est écrit dans `tool_calls.tool_name`. */
export const REVIEW_VERDICT_TOOL = 'review_verdict';

export interface ReviewVerdictFinding {
  file: string;
  line?: number;
  issue: string;
  severity: 'blocker' | 'major' | 'minor';
}

/**
 * Le verdict tel qu'il voyage jusqu'au parent : exactement ce que l'outil a
 * validé, jamais une reformulation.
 */
export interface ReviewVerdictRecord {
  verdict: 'approve' | 'request_changes';
  summary: string;
  findings: ReviewVerdictFinding[];
  counts: { blocker: number; major: number; minor: number };
}

function isFinding(value: unknown): value is ReviewVerdictFinding {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f['file'] === 'string' &&
    typeof f['issue'] === 'string' &&
    (f['severity'] === 'blocker' || f['severity'] === 'major' || f['severity'] === 'minor') &&
    (f['line'] === undefined || typeof f['line'] === 'number')
  );
}

/**
 * Lit UNE ligne `tool_calls` de `review_verdict` et dit si elle porte un verdict
 * réussi.
 *
 * Trois cas, et aucun fourre-tout :
 *  - la sortie n'est pas un succès de cet outil (appel refusé par le schéma,
 *    sortie illisible, `ok` absent) → `null`, l'appel n'a rien livré ;
 *  - la sortie s'annonce réussie (`ok: true`) et respecte le contrat → le
 *    verdict ;
 *  - la sortie s'annonce réussie et NE respecte PAS le contrat → on lève.
 *    C'est un contrat rompu entre l'outil et ce lecteur, pas une donnée
 *    douteuse : le taire livrerait un verdict tronqué au parent (invariant #4).
 */
export function parseReviewVerdictOutput(
  raw: string | null | undefined,
): ReviewVerdictRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const out = parsed as Record<string, unknown>;
  if (out['ok'] !== true) return null;

  const verdict = out['verdict'];
  const summary = out['summary'];
  const findings = out['findings'];
  const counts = out['counts'];
  const shapeOk =
    (verdict === 'approve' || verdict === 'request_changes') &&
    typeof summary === 'string' &&
    Array.isArray(findings) &&
    findings.every(isFinding) &&
    !!counts &&
    typeof counts === 'object';
  if (!shapeOk) {
    throw new OrchestrationError(
      'review_verdict_malformed',
      `A ${REVIEW_VERDICT_TOOL} tool_call claims success but does not match the verdict contract: ${raw.slice(0, 200)}`,
    );
  }

  const c = counts as Record<string, unknown>;
  return {
    verdict,
    summary,
    findings: findings as ReviewVerdictFinding[],
    counts: {
      blocker: typeof c['blocker'] === 'number' ? c['blocker'] : 0,
      major: typeof c['major'] === 'number' ? c['major'] : 0,
      minor: typeof c['minor'] === 'number' ? c['minor'] : 0,
    },
  };
}

/**
 * Le verdict livré par ce job, s'il en a livré un : celui de son DERNIER appel
 * à `review_verdict`, et seulement si cet appel a réussi.
 *
 * Le dernier, et pas « le dernier réussi » : un relecteur qui corrige un appel
 * refusé rappelle l'outil, et c'est ce second appel qui fait foi ; à l'inverse,
 * remonter à un succès plus ancien livrerait un verdict que le relecteur a
 * lui-même remis en cause.
 */
export async function readDeliveredReviewVerdict(
  db: AnyDrizzleDb,
  jobId: JobId,
): Promise<ReviewVerdictRecord | null> {
  const rows = await db
    .select({ toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, jobId as string), eq(toolCalls.toolName, REVIEW_VERDICT_TOOL)))
    .orderBy(desc(toolCalls.createdAt), desc(toolCalls.turn))
    .limit(1);

  const last = rows[0];
  if (!last) return null;
  return parseReviewVerdictOutput(last.toolOutput);
}
