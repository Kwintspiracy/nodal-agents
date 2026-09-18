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
//
// Elle rend DEUX choses par verdict : la forme validée par l'outil (verdict,
// résumé, constats) et le RAPPORT ENTIER du relecteur — ce que son job a rendu.
// Le second existe parce que le rapport se lisait ailleurs : l'orchestrateur le
// recopiait dans sa réponse finale, et la page montrait donc la même relecture
// deux fois, une fois en prose flottante et une fois en bloc structuré
// (Quentin, 18/09 : « il ne devrait y en avoir qu'une seule et elle devrait
// être dans le bloc review prévu à cet effet »).

import 'server-only';
import { and, asc, eq, inArray, agentJobs, toolCalls } from '@nodal-agents/db';
import { parseReviewVerdictOutput, REVIEW_VERDICT_TOOL } from '@nodal-agents/orchestration';
import { redactSecretsInText } from '@nodal-agents/shared';
import type { getDb } from './server.ts';

type Db = ReturnType<typeof getDb>;

/** Un constat de relecture : où, et ce qui ne va pas. */
export type ReviewFinding = { file?: string; line?: number; severity?: string; issue?: string };

/**
 * Un verdict de relecture, tel que les écrans le dessinent. `verdict` et
 * `summary` valent `null` quand la sortie de l'outil ne se lit pas comme un
 * verdict : la ligne a eu lieu, on ne prétend pas savoir ce qu'elle disait.
 */
export type ReviewVerdictView = {
  jobId: string;
  verdict: string | null;
  summary: string | null;
  findings: ReviewFinding[];
  counts: Record<string, number> | null;
  /**
   * LE RAPPORT du relecteur, en toutes lettres : ce que le job qui a rendu ce
   * verdict a rendu (`agent_jobs.result`), secrets masqués à l'affichage.
   * `null` quand ce job n'a rien rendu — un verdict sans rapport garde son
   * résumé et ses constats, on n'invente pas le reste.
   */
  report: string | null;
};

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
 * sa preuve. Ordonnés par `seq`, le rang d'écriture de la ligne : l'écran
 * montre l'état du DERNIER, et deux verdicts d'une même seconde se départagent
 * (la date seule ne les départageait pas).
 *
 * La sortie est lue par `parseReviewVerdictOutput`, le lecteur de
 * l'orchestration — celui qui fait autorité sur la forme d'un verdict. Il lève
 * quand une sortie s'annonce réussie sans respecter le contrat : ici, on
 * l'attrape et la ligne garde ses champs vides. Une page qui tombe en panne
 * dirait moins qu'une page qui montre une relecture illisible.
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
    .orderBy(asc(toolCalls.seq));

  const rawByJob = new Map<string, string[]>();
  const views: ReviewVerdictView[] = [];
  for (const row of rows) {
    if (row.jobId === null || row.toolOutput === null) continue;
    const bucket = rawByJob.get(row.jobId) ?? [];
    bucket.push(row.toolOutput);
    rawByJob.set(row.jobId, bucket);
    const parsed = readVerdict(row.toolOutput, row.jobId);
    views.push({
      jobId: row.jobId,
      verdict: parsed?.verdict ?? null,
      summary: parsed?.summary ?? null,
      findings: parsed?.findings ?? [],
      counts: parsed?.counts ?? null,
      report: null,
    });
  }
  if (views.length === 0) return { views, rawByJob };

  // LE RAPPORT de chaque relecteur, en UNE requête pour tous les verdicts —
  // jamais une par ligne. Masqué à l'affichage comme tout texte d'agent :
  // c'est un chemin de lecture de plus sur les mêmes mots (SECRET-001).
  const reviewerIds = [...new Set(views.map((v) => v.jobId))];
  const reports = await db
    .select({ id: agentJobs.id, result: agentJobs.result })
    .from(agentJobs)
    .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.id, reviewerIds)));
  const reportById = new Map(
    reports.map((r) => [
      r.id,
      r.result === null || r.result.trim() === '' ? null : redactSecretsInText(r.result),
    ]),
  );
  for (const view of views) view.report = reportById.get(view.jobId) ?? null;
  return { views, rawByJob };
}

/**
 * Le verdict d'une sortie, ou `null` — une sortie hors contrat ne fait pas
 * tomber la page, mais elle ne disparaît pas en silence non plus : le job est
 * NOMMÉ dans le journal (Reviewer C, passe 3). Un contrat rompu entre l'outil
 * et ce lecteur est un défaut à corriger, et un `catch` muet le cachait —
 * l'écran montrait alors une ligne de relecture vide sans que rien n'explique
 * pourquoi. Même geste que `job-feed.ts` quand une lecture reste incomplète :
 * un avertissement qui dit par où regarder.
 */
function readVerdict(
  raw: string,
  jobId: string,
): {
  verdict: string;
  summary: string;
  findings: ReviewFinding[];
  counts: Record<string, number>;
} | null {
  try {
    return parseReviewVerdictOutput(raw);
  } catch (err) {
    console.warn(
      `[review-verdicts] job ${jobId}: a ${REVIEW_VERDICT_TOOL} output claims success but breaks the verdict contract — the review is shown without its verdict. ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
