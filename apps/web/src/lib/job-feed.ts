// job-feed.ts — l'assemblage du fil d'UN travail, et la descendance d'un job.
//
// Ce code vivait dans `getSpaceConversationAction` (P2). P7 en a besoin aussi :
// le fil d'une conversation est la suite des fils de ses jobs de tête. Il est
// donc sorti ici plutôt que copié — deux copies auraient divergé au premier
// correctif, et c'est exactement ce que la revue reproche depuis P4.
//
// Pourquoi un module à part et pas `actions.ts` : les deux appelants sont des
// fichiers `'use server'`, où chaque export devient un point d'entrée réseau.
// Un helper interne n'a rien à y faire, et re-exporter une action d'un fichier
// `'use server'` à l'autre est un piège connu de ce dépôt.

import 'server-only';
import {
  eq,
  and,
  desc,
  inArray,
  agents,
  agentJobs,
  toolCalls,
  llmCalls,
  approvalRequests,
} from '@nodal-agents/db';
import {
  parseReviewVerdictOutput,
  REVIEW_VERDICT_TOOL,
  type ReviewVerdictRecord,
} from '@nodal-agents/orchestration';
import { redactTranscriptForDisplay, redactSecretsInText } from '@nodal-agents/shared';
import type { JobTriggerContext } from '@nodal-agents/db';
import { buildConversationFeed } from './conversation-feed.ts';
import type { ConversationFeed } from './conversation-feed.ts';
import { ROLLUP_MAX_DEPTH } from './coding-rollup.ts';
import { redactPresented } from './redact-presented.ts';
import type { getDb } from './server.ts';

type Db = ReturnType<typeof getDb>;
/**
 * La base, OU une transaction ouverte dessus.
 *
 * Dérivé de `Db` plutôt qu'importé de drizzle : le type d'une transaction est
 * celui que `db.transaction` passe à son rappel, quel que soit le pilote. Une
 * lecture qui doit pouvoir se faire DANS une transaction — la descendance d'un
 * job juste avant de le supprimer — s'écrit avec ce type et sert les deux.
 */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * CE QU'UN RUN A RENDU, masqué comme sa transcription l'est déjà (#194, revue
 * passe 1). La page d'un job masquait `result` et `error` depuis toujours
 * (`jobs/[id]/page.tsx`) ; le fil, lui, les posait BRUTS — et c'est le fil
 * qu'on lit. Un `run_command` qui échoue en recopiant `ANTHROPIC_API_KEY=…`
 * dans son message d'erreur s'affichait donc masqué d'un écran, en clair de
 * l'autre. Une seule porte, celle par où les lignes entrent dans le fil.
 */
function redactedText(value: string | null): string | null {
  return value === null ? null : redactSecretsInText(value);
}

/** Le job tel que la requête d'appel le rend : la ligne, plus l'agent joint. */
export type JobFeedInput = {
  job: typeof agentJobs.$inferSelect;
  agentName: string | null;
  agentSlug: string | null;
  agentAvatarUrl: string | null;
};

export type JobFeedResult = {
  feed: ConversationFeed;
  /** La tâche APRÈS masquage des secrets — celle que l'écran affiche. */
  displayTask: string;
  /** Le nom de l'automatisation, quand le travail vient d'un cron. */
  scheduleName: string | null;
};

export type DescendantJob = {
  id: string;
  /** La racine DONT il descend — P7 attribue sa production au bon tour. */
  rootId: string;
  verificationSkippedSurfaces: unknown;
};

/**
 * Les descendants d'un ou plusieurs jobs, à TOUTE profondeur (niveau par
 * niveau, borné par `ROLLUP_MAX_DEPTH`), bornés à l'entité.
 *
 * Les enfants directs ne suffisent pas : la preuve d'un petit-enfant remonte à
 * la racine dans le détail Code, et le fil doit dire la même chose (revue de
 * P2, passe 20). Chaque ligne porte sa trace D8 des surfaces décochées.
 */
export async function collectDescendants(
  // `DbOrTx` : la suppression des runs venus de dehors appelle cette marche
  // DANS sa transaction, pour que la descendance et la vérification qui suit
  // voient le même état (#183, Reviewer C passe 2).
  db: DbOrTx,
  entityId: string,
  rootIds: readonly string[],
): Promise<DescendantJob[]> {
  const descendants: DescendantJob[] = [];
  // La racine de chaque job rencontré : un fil de conversation a plusieurs
  // racines à la fois, et la production d'un petit-enfant doit revenir au tour
  // qui l'a déclenché, pas au premier de la liste.
  const rootOf = new Map<string, string>(rootIds.map((r) => [r, r]));
  let frontier = [...rootIds];
  const seen = new Set<string>(rootIds);
  for (let depth = 0; depth < ROLLUP_MAX_DEPTH && frontier.length > 0; depth++) {
    const rows = await db
      .select({
        id: agentJobs.id,
        parentJobId: agentJobs.parentJobId,
        verificationSkippedSurfaces: agentJobs.verificationSkippedSurfaces,
      })
      .from(agentJobs)
      .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.parentJobId, frontier)));
    const next: string[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const rootId = (r.parentJobId !== null ? rootOf.get(r.parentJobId) : undefined) ?? r.id;
      rootOf.set(r.id, rootId);
      descendants.push({
        id: r.id,
        rootId,
        verificationSkippedSurfaces: r.verificationSkippedSurfaces,
      });
      next.push(r.id);
    }
    frontier = next;
  }
  // La borne est ATTEINTE avec des enfants encore devant : la descendance
  // rendue est INCOMPLÈTE, et le dire vaut mieux que la rendre en silence
  // (invariant #4, Reviewer C sur la PR #185). Aucun appelant ne peut le
  // deviner d'une liste qui a l'air normale — et pour celui qui SUPPRIME, la
  // conséquence serait des délégués orphelins que plus aucun run ne porte.
  //
  // Un avertissement, pas une exception : cette fonction sert d'abord à
  // DESSINER des fils, et refuser d'afficher une conversation parce qu'une
  // chaîne est trop profonde serait pire que l'afficher tronquée. Les appelants
  // à qui l'incomplétude coûte cher posent leur propre garde —
  // `deleteExternalRunsAction` demande à la base s'il reste un orphelin, et
  // refuse.
  if (frontier.length > 0) {
    // Les IDENTIFIANTS, pas seulement leur nombre (Reviewer C, passe 2) : un
    // compte dit qu'il y a un problème, une liste dit par où commencer à
    // regarder. Bornée à dix, parce qu'un journal n'est pas un export.
    const devant = frontier.slice(0, 10).join(', ');
    const reste = frontier.length > 10 ? ` (+${frontier.length - 10} more)` : '';
    console.warn(
      `[job-feed] collectDescendants stopped at ${ROLLUP_MAX_DEPTH} levels with ${frontier.length} job(s) still below — the descendants returned are incomplete. Still ahead: ${devant}${reste}`,
    );
  }
  return descendants;
}

/**
 * Les fils de PLUSIEURS travaux, en trois requêtes — pas trois par travail.
 *
 * La première version en lançait trois par job dans un `Promise.all` : au
 * plafond de 100 jobs de tête d'une conversation, cela faisait 300 requêtes
 * pour afficher une page (revue Codex, passe 29, doute 2). Le pool en limitait
 * l'exécution simultanée, il n'en supprimait ni le nombre ni l'attente. Ici les
 * enfants, les lignes d'audit et les appels LLM sont chargés en une passe
 * chacun (`inArray` sur les ids), puis répartis en mémoire.
 *
 * Chaque fil est ensuite assemblé par `buildConversationFeed` (pur, testé sur
 * la vraie forme des lignes). Les messages sont masqués à l'AFFICHAGE
 * (SECRET-001), jamais à l'écriture.
 */
/**
 * P2bis — jusqu'où le fil d'une délégation s'ouvre. Un niveau : la carte
 * « Delegated to Officier » montre ce que l'Officier a fait (son classeur, sa
 * question, ses fichiers), pas seulement son texte. Le petit-enfant, lui, se
 * lit sur la page de son propre run — sinon un fil de conversation chargerait
 * toute la descendance à chaque affichage.
 */
const CHILD_FEED_DEPTH = 1;

/**
 * Combien de délégations d'une page ouvrent leur fil. Le fil d'un enfant se
 * lit dans sa ligne `agent_jobs` entière (`messages` JSONB compris) : cent
 * têtes à cinq délégués relieraient des centaines de transcripts pour une
 * seule page (revue Codex PR #46, passe 49). Les délégations les plus
 * RÉCENTES ouvrent leur fil ; les plus anciennes gardent la tâche, le résultat
 * et le lien vers leur run.
 */
export const CHILD_FEEDS_MAX = 20;

/**
 * Le verdict ENREGISTRÉ de chaque job donné, quand il en a livré un (#174).
 *
 * La règle est celle de l'orchestration, à la lettre : le DERNIER appel à
 * `review_verdict`, « dernier » au sens de `seq`, l'ordre d'ÉCRITURE
 * (migration 0110). Ni l'heure ni le tour ne le disent — deux appels d'un même
 * tour portent le même `turn` et souvent le même `created_at`. La sortie est
 * relue par le parseur de l'outil, jamais par un second lecteur maison : c'est
 * le schéma de l'outil qui a validé ce verdict, et deux lectures auraient
 * divergé.
 *
 * ⚠️ UNE LIGNE ILLISIBLE NE TUE PAS LE FIL. `parseReviewVerdictOutput` LÈVE sur
 * une sortie qui s'annonce réussie sans respecter le contrat — c'est le bon
 * geste dans l'orchestration, où le parent doit échouer plutôt que recevoir un
 * verdict tronqué. Ici, la même exception effacerait la conversation entière
 * pour une ligne abîmée. Elle est donc retenue, et ce job n'a simplement pas de
 * verdict typé : le bloc retombe sur la prose, comme avant #170, ce qui est
 * exactement ce qu'on sait dire de lui.
 */
async function lireVerdictsLivres(
  db: Db,
  entityId: string,
  jobIds: readonly string[],
): Promise<Map<string, ReviewVerdictRecord>> {
  const parJob = new Map<string, ReviewVerdictRecord>();
  if (jobIds.length === 0) return parJob;

  const rows = await db
    .select({ jobId: toolCalls.jobId, toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(
      and(
        inArray(toolCalls.jobId, [...jobIds]),
        eq(toolCalls.entityId, entityId),
        eq(toolCalls.toolName, REVIEW_VERDICT_TOOL),
      ),
    )
    // Décroissant : la PREMIÈRE ligne vue pour un job est donc la dernière
    // écrite, et les suivantes — des appels corrigés, repris — sont ignorées.
    .orderBy(desc(toolCalls.seq));

  // Les jobs déjà tranchés. Pas `parJob` : sa ligne la plus récente peut ne
  // RIEN livrer — un appel refusé après un succès dit que le relecteur s'est
  // repris — et il faut alors s'arrêter là, sans remonter au succès d'avant.
  const tranches = new Set<string>();
  for (const row of rows) {
    if (row.jobId === null || tranches.has(row.jobId)) continue;
    tranches.add(row.jobId);
    try {
      const verdict = parseReviewVerdictOutput(row.toolOutput);
      if (verdict !== null) parJob.set(row.jobId, verdict);
    } catch (err) {
      console.warn(`[job-feed] job ${row.jobId} carries an unreadable review_verdict:`, err);
    }
  }
  return parJob;
}

export async function assembleJobFeeds(
  db: Db,
  entityId: string,
  inputs: readonly JobFeedInput[],
  depth = 0,
): Promise<JobFeedResult[]> {
  if (inputs.length === 0) return [];
  const ids = inputs.map((i) => i.job.id);

  const [childRows, toolRows, llmRows, questionRows] = await Promise.all([
    db
      .select({
        parentJobId: agentJobs.parentJobId,
        id: agentJobs.id,
        agentName: agents.name,
        agentSlug: agents.slug,
        agentAvatarUrl: agents.avatarUrl,
        status: agentJobs.status,
        task: agentJobs.task,
        result: agentJobs.result,
        error: agentJobs.error,
        // Le geste que le runner a écrit sur cet échec (#193) : le bloc de la
        // délégation le DIT, il ne le devine plus du code d'erreur.
        failureHint: agentJobs.failureHint,
        createdAt: agentJobs.createdAt,
        completedAt: agentJobs.completedAt,
      })
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(and(inArray(agentJobs.parentJobId, ids), eq(agentJobs.entityId, entityId)))
      .orderBy(agentJobs.createdAt),
    db
      .select({
        jobId: toolCalls.jobId,
        toolCallId: toolCalls.toolCallId,
        toolName: toolCalls.toolName,
        card: toolCalls.card,
        presented: toolCalls.presented,
        durationMs: toolCalls.durationMs,
        turn: toolCalls.turn,
        toolInput: toolCalls.toolInput,
        toolOutput: toolCalls.toolOutput,
        createdAt: toolCalls.createdAt,
      })
      .from(toolCalls)
      .where(and(inArray(toolCalls.jobId, ids), eq(toolCalls.entityId, entityId)))
      .orderBy(toolCalls.createdAt),
    db
      .select({
        jobId: llmCalls.jobId,
        turn: llmCalls.turn,
        source: llmCalls.source,
        modelEffective: llmCalls.modelEffective,
        provider: llmCalls.provider,
        inputTokens: llmCalls.inputTokens,
        outputTokens: llmCalls.outputTokens,
        cachedTokens: llmCalls.cachedTokens,
        cacheCreationTokens: llmCalls.cacheCreationTokens,
        costUsd: llmCalls.costUsd,
        durationMs: llmCalls.durationMs,
      })
      .from(llmCalls)
      .where(and(inArray(llmCalls.jobId, ids), eq(llmCalls.entityId, entityId)))
      .orderBy(llmCalls.createdAt),
    // P10a — les QUESTIONS de ces travaux. Chargées ici, avec le reste du fil,
    // et filtrées EN SQL sur `kind` : une approbation ordinaire n'a rien à
    // faire sur une carte, et la ramener pour l'écarter en mémoire ferait
    // grossir la page de toutes les approbations d'un travail bavard.
    db
      .select({
        approvalRequestId: approvalRequests.id,
        jobId: approvalRequests.jobId,
        toolCallId: approvalRequests.toolCallId,
        status: approvalRequests.status,
        answer: approvalRequests.answer,
        notes: approvalRequests.notes,
      })
      .from(approvalRequests)
      .where(
        and(
          inArray(approvalRequests.jobId, ids),
          eq(approvalRequests.entityId, entityId),
          eq(approvalRequests.kind, 'question'),
        ),
      )
      .orderBy(approvalRequests.requestedAt),
  ]);

  /** Range les lignes sous leur job, en gardant l'ordre de la requête. */
  function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string | null): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
      const key = keyOf(row);
      if (key === null) continue;
      const bucket = out.get(key) ?? [];
      bucket.push(row);
      out.set(key, bucket);
    }
    return out;
  }

  // Le fil des enfants DIRECTS, assemblé par la même fonction (une passe pour
  // tous les enfants de tous les jobs, jamais une par enfant), borné en
  // profondeur. Sans lui, la délégation n'avait que le texte du délégué : le
  // classeur qu'il avait écrit, avec son aperçu et son état, restait invisible
  // depuis la conversation (capture du 07/09).
  const childFeedById = new Map<string, ConversationFeed>();
  // Les CHILD_FEEDS_MAX enfants les plus récents de la page, toutes têtes
  // confondues (`childRows` arrive trié par `created_at` croissant).
  const openable = childRows.slice(-CHILD_FEEDS_MAX).map((r) => r.id);
  if (depth < CHILD_FEED_DEPTH && openable.length > 0) {
    const childJobs = await db
      .select({
        job: agentJobs,
        agentName: agents.name,
        agentSlug: agents.slug,
        agentAvatarUrl: agents.avatarUrl,
      })
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(and(inArray(agentJobs.id, openable), eq(agentJobs.entityId, entityId)))
      .orderBy(agentJobs.createdAt);
    const childFeeds = await assembleJobFeeds(db, entityId, childJobs, depth + 1);
    childJobs.forEach((c, i) => {
      const assembledChild = childFeeds[i];
      if (assembledChild) childFeedById.set(c.job.id, assembledChild.feed);
    });
  }

  // Le VERDICT ENREGISTRÉ de chaque délégué (#174). Le fil le déduisait de la
  // PROSE de l'enfant — « Verdict global : … » — alors que depuis #170 l'outil
  // `review_verdict` l'écrit typé dans `tool_calls`, validé par son schéma. Une
  // prose trompeuse faisait donc dire au bloc autre chose que ce qui a été
  // enregistré.
  //
  // UNE requête pour tous les enfants de ce niveau, jamais une par enfant. Et
  // pas une lecture des lignes déjà chargées : celles-là sont celles des
  // PARENTS (`ids`), et le fil d'un enfant n'est assemblé que dans la limite de
  // profondeur — au-delà il n'y aurait rien à relire.
  //
  // Pourquoi pas la transcription du parent, qui porte pourtant le même JSON
  // sans coûter une requête : il faudrait y retrouver le résultat d'outil qui
  // correspond À CET enfant, par son identifiant d'appel, et cette
  // correspondance se perd dès qu'un tour est tronqué. La ligne `tool_calls`
  // est la source que l'orchestration elle-même relit.
  const verdictsParEnfant = await lireVerdictsLivres(
    db,
    entityId,
    childRows.map((r) => r.id),
  );

  const childrenByJob = groupBy(childRows, (r) => r.parentJobId);
  const toolsByJob = groupBy(toolRows, (r) => r.jobId);
  const llmByJob = groupBy(llmRows, (r) => r.jobId);
  const questionsByJob = groupBy(questionRows, (r) => r.jobId);

  return inputs.map((input) => {
    const { job } = input;
    const triggerContext = job.triggerContext as JobTriggerContext | null;
    const scheduleName =
      job.channel === 'cron' && triggerContext?.type === 'cron'
        ? triggerContext.scheduleName
        : null;
    const messages = redactTranscriptForDisplay(
      Array.isArray(job.messages) ? (job.messages as Record<string, unknown>[]) : [],
    );
    // La tâche passe par la MÊME rédaction que les messages : le modèle trouve
    // la demande en comparant les deux (`content === task`), et une demande qui
    // contient un secret serait masquée d'un côté seulement (revue passe 18).
    const [redactedRequest] = redactTranscriptForDisplay([{ role: 'user', content: job.task }]);
    const displayTask =
      typeof redactedRequest?.content === 'string' ? redactedRequest.content : job.task;

    const feed = buildConversationFeed(
      {
        id: job.id,
        task: displayTask,
        channel: job.channel,
        chatId: job.chatId,
        status: job.status,
        result: redactedText(job.result),
        error: redactedText(job.error),
        // Pas de masquage : un geste est un slug fermé du harnais, il ne peut
        // pas porter de secret (#193).
        failureHint: job.failureHint,
        agentName: input.agentName,
        agentSlug: input.agentSlug,
        agentAvatarUrl: input.agentAvatarUrl,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        messages,
        scheduleName,
        children: (childrenByJob.get(job.id) ?? []).map((c) => {
          const childFeed = childFeedById.get(c.id);
          // Le délégué passe par la même rédaction que sa tête : son échec se
          // lit dans le bloc de la délégation, exactement comme celui du job.
          // Et il porte son verdict ENREGISTRÉ (#174), jamais deviné de sa prose.
          const child = {
            ...c,
            result: redactedText(c.result),
            error: redactedText(c.error),
            reviewVerdict: verdictsParEnfant.get(c.id) ?? null,
          };
          return childFeed === undefined ? child : { ...child, feed: childFeed };
        }),
      },
      // La sortie brute ET la CARTE, masquées ensemble : la carte est bâtie à
      // partir de cette même sortie, et `ToolBlock` la rend DE PRÉFÉRENCE à
      // elle. Rédiger l'une sans l'autre montrait le jeton en clair sur la
      // carte pendant que la vue brute le masquait (#150).
      (toolsByJob.get(job.id) ?? []).map((t) => ({
        ...t,
        toolOutput: t.toolOutput === null ? null : redactSecretsInText(t.toolOutput),
        presented: redactPresented(t.presented),
      })),
      llmByJob.get(job.id) ?? [],
      (questionsByJob.get(job.id) ?? []).map((q) => ({
        approvalRequestId: q.approvalRequestId,
        toolCallId: q.toolCallId,
        status: q.status ?? 'pending',
        answer: q.answer,
        notes: q.notes,
      })),
    );

    return { feed, displayTask, scheduleName };
  });
}

/**
 * Le fil d'UN travail — la version groupée avec un seul élément, jamais une
 * seconde implémentation.
 */
export async function assembleJobFeed(
  db: Db,
  entityId: string,
  input: JobFeedInput,
): Promise<JobFeedResult> {
  const [only] = await assembleJobFeeds(db, entityId, [input]);
  if (!only) throw new Error('assembleJobFeeds returned nothing for a single job');
  return only;
}
