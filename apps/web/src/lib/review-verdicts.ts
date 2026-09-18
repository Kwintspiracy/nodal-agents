// review-verdicts.ts — CE QUE LA RELECTURE A DIT d'un travail, lu une fois
// pour tous les écrans.
//
// Le même run se lisait de deux façons selon la porte (Quentin, 18/09) : ouvert
// depuis Code, il montrait le verdict complet de Reviewer C ; ouvert depuis le
// dossier MCP — la MÊME demande, le même job — il disait « No review on this
// run ». La page n'avait pas changé : c'est le chargeur qui différait. Celui de
// Code lisait les lignes `review_verdict`, celui d'un run n'en lisait aucune.
//
// Un run ne peut pas dire deux choses de lui-même selon l'adresse par laquelle
// on y arrive. La lecture vit donc ICI, et les deux chargeurs l'appellent.

import 'server-only';
import { and, asc, eq, inArray, toolCalls } from '@nodal-agents/db';
import type { getDb } from './server.ts';

type Db = ReturnType<typeof getDb>;

/** Le nom de l'outil qui rend un verdict. Une seule écriture, ici. */
const REVIEW_VERDICT_TOOL = 'review_verdict';

/** Un constat de relecture : où, et ce qui ne va pas. */
export type ReviewFinding = { file?: string; line?: number; severity?: string; issue?: string };

/**
 * Un verdict de relecture, tel que les écrans le dessinent. `verdict` et
 * `summary` valent `null` quand la sortie de l'outil ne se lit pas comme du
 * JSON : la ligne a eu lieu, on ne prétend pas savoir ce qu'elle disait.
 */
export type ReviewVerdictView = {
  jobId: string;
  verdict: string | null;
  summary: string | null;
  findings: ReviewFinding[];
  counts: Record<string, number> | null;
};

type VerdictJson = {
  verdict?: string;
  summary?: string;
  findings?: ReviewFinding[];
  counts?: Record<string, number>;
};

function parseVerdictJson(raw: string): VerdictJson | null {
  try {
    return JSON.parse(raw) as VerdictJson;
  } catch {
    return null;
  }
}

export type JobReviewVerdicts = {
  /** Les verdicts prêts à dessiner, du plus ancien au plus récent. */
  views: ReviewVerdictView[];
  /**
   * Les sorties BRUTES, rangées par job — la dérivation d'étape du détail Code
   * y cherche son marqueur d'approbation, et elle a besoin du texte, pas de la
   * forme lue.
   */
  rawByJob: Map<string, string[]>;
};

/**
 * Les verdicts de relecture d'un travail ET de sa descendance.
 *
 * Les ids sont ceux que l'appelant a déjà rassemblés (racine + descendants) :
 * un verdict rendu par un délégué appartient au travail qui l'a mandaté, comme
 * sa preuve. Ordonnés par date : l'écran montre l'état du DERNIER, et sans
 * ordre « le dernier » dépendait de l'ordre de retour de Postgres.
 *
 * Bornés à l'entité, jamais à un id venu du client.
 */
export async function readReviewVerdicts(
  db: Db,
  entityId: string,
  jobIds: readonly string[],
): Promise<JobReviewVerdicts> {
  if (jobIds.length === 0) return { views: [], rawByJob: new Map() };
  const rows = await db
    .select({ jobId: toolCalls.jobId, toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.entityId, entityId),
        inArray(toolCalls.jobId, [...jobIds]),
        eq(toolCalls.toolName, REVIEW_VERDICT_TOOL),
      ),
    )
    .orderBy(asc(toolCalls.createdAt));

  const rawByJob = new Map<string, string[]>();
  const views: ReviewVerdictView[] = [];
  for (const row of rows) {
    if (row.jobId === null || row.toolOutput === null) continue;
    const bucket = rawByJob.get(row.jobId) ?? [];
    bucket.push(row.toolOutput);
    rawByJob.set(row.jobId, bucket);
    const parsed = parseVerdictJson(row.toolOutput);
    views.push({
      jobId: row.jobId,
      verdict: parsed?.verdict ?? null,
      summary: parsed?.summary ?? null,
      findings: parsed?.findings ?? [],
      counts: parsed?.counts ?? null,
    });
  }
  return { views, rawByJob };
}
