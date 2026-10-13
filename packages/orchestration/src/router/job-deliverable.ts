// router/job-deliverable.ts — CE QU'UN JOB A LIVRÉ, lu en un seul endroit
// (issue #646).
//
// Le runner avait plusieurs lecteurs de « qu'est-ce que cet enfant a livré », et
// ils ne disaient pas la même chose :
//  - la reprise de délégation (`resume.ts`) lisait le verdict de revue de
//    l'enfant DIRECT, et de lui seul ;
//  - la compilation des enfants (`compileChildResults`, runner) ne lisait que
//    la colonne `agent_jobs.result` — le dernier texte, parfois une ligne de
//    narration écrite après un appel refusé — et affichait « no deliverable »
//    pour un relecteur qui n'avait livré QUE son verdict ;
//  - la garde « livrable vide » (runner) comptait un enfant comme livré sur sa
//    seule colonne `result` ;
//  - le tableau de tâches du cron recopiait le texte rendu par le job.
//
// Deux runs le montrent. Job 5ee022d7 (30/09) : le root relaie un relecteur, et
// son résultat ne porte que la phrase « je raccourcis chaque constat… » — le
// verdict enregistré n'est lu par personne sur ce chemin. Job 87c37ae8 (12/10) :
// root → Lead → Reviewer A ; Lead relaie sans appeler `review_verdict`, le root
// reçoit `review_verdict: null`, refait toute la revue (10 min) et attribue le
// constat à Lead.
//
// La règle posée ici ne connaît aucun agent, aucune skill, aucun canal
// (invariants #1 à #3) :
//
//  - le TEXTE d'un job est sa colonne `result`, telle quelle. Savoir s'il
//    faudrait plutôt son dernier texte SUBSTANTIEL est une question ouverte de
//    l'issue #646, volontairement pas tranchée ici ;
//  - les VERDICTS d'un job sont TOUS ceux livrés dans son SOUS-ARBRE : le sien
//    s'il en a enregistré un, puis ceux de ses enfants, dans l'ordre de leur
//    création, récursivement. Le verdict d'un job est son dernier appel à
//    `review_verdict` (un relecteur qui corrige son propre appel refusé) — une
//    règle PAR JOB, jamais d'un job à l'autre : le verdict d'un intermédiaire ne
//    remplace pas celui d'un relecteur en dessous. Rien dans les lignes ne dit
//    que l'un a lu l'autre, ni qu'ils portent sur la même cible (revue Codex de
//    la PR #712, passe 1 : un `approve` de Lead effaçait le `request_changes` de
//    Reviewer A, et le root concluait à une livraison) ;
//  - chaque verdict porte son AUTEUR (slug d'agent et id de job). Plusieurs
//    verdicts voyagent tous ; aucun n'est choisi parmi les autres. Une ligne
//    illisible, où qu'elle soit dans le sous-arbre, voyage de même.
//
// La lecture se fait sur les lignes réelles (`agent_jobs`, `tool_calls`),
// jamais sur une transcription ni sur un texte de modèle.

import { and, eq, inArray, desc, agentJobs, agents, toolCalls } from '@nodal-agents/db';
import { OrchestrationError } from '../errors';
import { parseReviewVerdictOutput, REVIEW_VERDICT_TOOL } from './review-verdict';
import type { ReviewVerdictRecord } from './review-verdict';
import { reviewBlocksDelivery } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../types';

/** Qui a enregistré un verdict : l'agent, et le job où il l'a fait. */
export interface VerdictAuthor {
  /** `null` quand l'agent a été supprimé depuis. */
  agent_slug: string | null;
  job_id: string;
}

/** Un verdict tel que l'outil l'a validé, avec son auteur. */
export type AuthoredReviewVerdict = { author: VerdictAuthor } & ReviewVerdictRecord;

/** Ce qu'un job a livré — la seule réponse à cette question dans la plateforme. */
export interface JobDeliverable {
  job_id: string;
  agent_slug: string | null;
  agent_name: string | null;
  status: string | null;
  error: string | null;
  /** `agent_jobs.result`, tel quel ; `''` quand la colonne est vide. */
  text: string;
  /** Les verdicts livrés dans le sous-arbre du job, chacun avec son auteur. */
  review_verdicts: AuthoredReviewVerdict[];
  /**
   * Les jobs du sous-arbre dont la dernière ligne `review_verdict` s'annonce
   * réussie SANS respecter le contrat de l'outil. Un contrat rompu, jamais tu
   * (invariant #4) : la reprise en fait une délégation échouée, la compilation
   * l'écrit par son code. Aucun verdict, au-dessus ou à côté, ne la cache.
   */
  unreadable_review_verdicts: VerdictAuthor[];
}

interface JobNode {
  id: string;
  parentJobId: string | null;
  createdAt: Date | null;
  slug: string | null;
  name: string | null;
  status: string | null;
  error: string | null;
  result: string | null;
}

type OwnVerdict =
  | { kind: 'none' }
  | { kind: 'verdict'; record: ReviewVerdictRecord }
  | { kind: 'unreadable' };

const JOB_COLUMNS = {
  id: agentJobs.id,
  parentJobId: agentJobs.parentJobId,
  createdAt: agentJobs.createdAt,
  slug: agents.slug,
  name: agents.name,
  status: agentJobs.status,
  error: agentJobs.error,
  result: agentJobs.result,
};

function byCreation(a: JobNode, b: JobNode): number {
  const ta = a.createdAt?.getTime() ?? 0;
  const tb = b.createdAt?.getTime() ?? 0;
  return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
}

/**
 * Ce que chacun de ces jobs a livré. Un id sans ligne n'apparaît pas dans la
 * carte rendue.
 *
 * Trois lectures quel que soit le nombre de jobs : les jobs, leur
 * descendance étage par étage, puis les lignes `review_verdict` de tout ce
 * monde. « Dernier appel » se lit sur `seq`, l'ordre d'ÉCRITURE (migration
 * 0110) — la règle de `readFinalReviewVerdict` et de l'écran.
 */
export async function readJobDeliverables(
  db: AnyDrizzleDb,
  jobIds: readonly string[],
): Promise<Map<string, JobDeliverable>> {
  const out = new Map<string, JobDeliverable>();
  if (jobIds.length === 0) return out;

  const nodes = new Map<string, JobNode>();
  const childrenOf = new Map<string, JobNode[]>();
  const roots = (await db
    .select(JOB_COLUMNS)
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(inArray(agentJobs.id, [...jobIds]))) as JobNode[];
  for (const n of roots) nodes.set(n.id, n);

  // La descendance, étage par étage. L'ensemble `nodes` borne la boucle même
  // sur une ligne corrompue qui ferait un cycle.
  let frontier = roots.map((n) => n.id);
  while (frontier.length > 0) {
    const kids = (await db
      .select(JOB_COLUMNS)
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(inArray(agentJobs.parentJobId, frontier))) as JobNode[];
    const next: string[] = [];
    for (const k of kids) {
      if (nodes.has(k.id)) continue;
      nodes.set(k.id, k);
      next.push(k.id);
      const parent = k.parentJobId ?? '';
      const list = childrenOf.get(parent) ?? [];
      list.push(k);
      childrenOf.set(parent, list);
    }
    frontier = next;
  }
  for (const list of childrenOf.values()) list.sort(byCreation);

  // Le dernier appel à `review_verdict` de chaque job, et lui seul : un
  // relecteur qui corrige un appel refusé rappelle l'outil, et c'est ce second
  // appel qui fait foi ; un dernier appel refusé ne livre rien.
  const verdictRows = await db
    .select({ jobId: toolCalls.jobId, toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(
      and(inArray(toolCalls.jobId, [...nodes.keys()]), eq(toolCalls.toolName, REVIEW_VERDICT_TOOL)),
    )
    .orderBy(desc(toolCalls.seq));
  const own = new Map<string, OwnVerdict>();
  for (const row of verdictRows) {
    if (!row.jobId || own.has(row.jobId)) continue;
    own.set(row.jobId, readOwnVerdict(row.jobId, row.toolOutput));
  }

  const memo = new Map<
    string,
    Pick<JobDeliverable, 'review_verdicts' | 'unreadable_review_verdicts'>
  >();
  const subtree = (
    node: JobNode,
  ): Pick<JobDeliverable, 'review_verdicts' | 'unreadable_review_verdicts'> => {
    const known = memo.get(node.id);
    if (known) return known;
    // Posé AVANT la descente : un cycle (ligne corrompue) rend le vide au lieu
    // de boucler.
    memo.set(node.id, { review_verdicts: [], unreadable_review_verdicts: [] });
    const author: VerdictAuthor = { agent_slug: node.slug, job_id: node.id };
    const mine = own.get(node.id) ?? { kind: 'none' };
    // Le job d'abord, puis chaque enfant : un verdict n'en remplace aucun autre.
    const verdicts: AuthoredReviewVerdict[] =
      mine.kind === 'verdict' ? [{ author, ...mine.record }] : [];
    const unreadable: VerdictAuthor[] = mine.kind === 'unreadable' ? [author] : [];
    for (const child of childrenOf.get(node.id) ?? []) {
      const s = subtree(child);
      verdicts.push(...s.review_verdicts);
      unreadable.push(...s.unreadable_review_verdicts);
    }
    const value = { review_verdicts: verdicts, unreadable_review_verdicts: unreadable };
    memo.set(node.id, value);
    return value;
  };

  for (const id of jobIds) {
    const node = nodes.get(id);
    if (!node) continue;
    out.set(id, {
      job_id: node.id,
      agent_slug: node.slug,
      agent_name: node.name,
      status: node.status,
      error: node.error,
      text: node.result ?? '',
      ...subtree(node),
    });
  }
  return out;
}

/** Ce qu'un job a livré ; `null` quand le job n'existe pas. */
export async function readJobDeliverable(
  db: AnyDrizzleDb,
  jobId: string,
): Promise<JobDeliverable | null> {
  return (await readJobDeliverables(db, [jobId])).get(jobId) ?? null;
}

/** Ce que chacun des enfants directs de ce job a livré, dans l'ordre de leur création. */
export async function readChildDeliverables(
  db: AnyDrizzleDb,
  parentJobId: string,
): Promise<JobDeliverable[]> {
  const kids = (await db
    .select(JOB_COLUMNS)
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(eq(agentJobs.parentJobId, parentJobId))) as JobNode[];
  kids.sort(byCreation);
  const read = await readJobDeliverables(
    db,
    kids.map((k) => k.id),
  );
  return kids.map((k) => read.get(k.id)).filter((d): d is JobDeliverable => d !== undefined);
}

/** Ce job a-t-il livré quelque chose : un texte, ou un verdict lisible ? */
export function deliveredSomething(d: JobDeliverable): boolean {
  return d.text.trim() !== '' || d.review_verdicts.length > 0;
}

/**
 * Ces verdicts interdisent-ils de conclure à une livraison (#59) ?
 *
 * Oui dès qu'UN d'eux demande des corrections, quels que soient les autres.
 * Deux verdicts qui se contredisent dans un même sous-arbre ne s'annulent pas :
 * un `approve` ne lève pas le `request_changes` d'un autre job, qu'il vienne
 * d'un relecteur voisin ou d'un intermédiaire au-dessus — rien dans les lignes
 * ne dit que les deux portent sur la même chose, ni que l'un a lu l'autre. Le
 * parent reçoit les deux, avec leurs auteurs. Un faux « bloqué » se lit et se
 * tranche ; un faux « livré » est le défaut que #59 ferme.
 */
export function verdictsBlockDelivery(verdicts: readonly AuthoredReviewVerdict[]): boolean {
  return verdicts.some((v) => reviewBlocksDelivery(v));
}

/**
 * Les verdicts d'un job, mis en page pour un texte compilé (un relais, une
 * tâche du tableau).
 *
 * Invariant #2 : le runner ne dit pas le verdict avec ses mots. Il pose les
 * champs typés — l'outil, le verdict, l'auteur, le résumé, les constats
 * (sévérité, fichier:ligne, texte) — sous leurs noms de champ, entre crochets
 * comme les autres lignes de la plateforme. `''` quand il n'y a rien.
 */
export function renderDeliveredVerdicts(
  d: Pick<JobDeliverable, 'review_verdicts' | 'unreadable_review_verdicts'>,
): string {
  const blocks: string[] = [];
  for (const v of d.review_verdicts) {
    const lines = [
      `[${REVIEW_VERDICT_TOOL}] verdict: ${v.verdict} · author: ${authorLabel(v.author)}`,
    ];
    if (v.summary.trim() !== '') lines.push(`summary: ${v.summary.trim()}`);
    if (v.findings.length > 0) {
      lines.push('findings:');
      for (const f of v.findings) {
        const where = f.line === undefined ? f.file : `${f.file}:${f.line}`;
        lines.push(`- ${f.severity} · ${where} · ${f.issue}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  for (const a of d.unreadable_review_verdicts) {
    blocks.push(`[review_verdict_malformed] author: ${authorLabel(a)}`);
  }
  return blocks.join('\n\n');
}

/**
 * Un texte, suivi des verdicts mis en page (`renderDeliveredVerdicts`). Sans
 * verdict, le texte revient TEL QUEL, octet pour octet : un livrable qui n'est
 * pas une revue ne change pas.
 */
export function appendDeliveredVerdicts(
  text: string,
  d: Pick<JobDeliverable, 'review_verdicts' | 'unreadable_review_verdicts'> | null,
): string {
  const verdicts = d ? renderDeliveredVerdicts(d) : '';
  if (verdicts === '') return text;
  return text.trim() === '' ? verdicts : `${text}\n\n${verdicts}`;
}

function authorLabel(a: VerdictAuthor): string {
  return `${a.agent_slug ?? 'null'} · job: ${a.job_id}`;
}

/**
 * Une ligne `review_verdict` lue pour son job. Un contrat rompu devient
 * `unreadable` — dit à chaque lecteur, et journalisé ici avec le job.
 */
function readOwnVerdict(jobId: string, raw: string | null): OwnVerdict {
  try {
    const record = parseReviewVerdictOutput(raw);
    return record ? { kind: 'verdict', record } : { kind: 'none' };
  } catch (err) {
    if (!(err instanceof OrchestrationError) || err.code !== 'review_verdict_malformed') throw err;
    console.error(`[job-deliverable] job ${jobId} recorded an unreadable review_verdict:`, err);
    return { kind: 'unreadable' };
  }
}
