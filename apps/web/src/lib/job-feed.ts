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
import { eq, and, inArray, agents, agentJobs, toolCalls, llmCalls } from '@nodal-agents/db';
import { redactTranscriptForDisplay, redactSecretsInText } from '@nodal-agents/shared';
import type { JobTriggerContext } from '@nodal-agents/db';
import { buildConversationFeed } from './conversation-feed.ts';
import type { ConversationFeed } from './conversation-feed.ts';
import { ROLLUP_MAX_DEPTH } from './coding-rollup.ts';
import type { getDb } from './server.ts';

type Db = ReturnType<typeof getDb>;

/** Le job tel que la requête d'appel le rend : la ligne, plus l'agent joint. */
export type JobFeedInput = {
  job: typeof agentJobs.$inferSelect;
  agentName: string | null;
  agentSlug: string | null;
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
  db: Db,
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
export async function assembleJobFeeds(
  db: Db,
  entityId: string,
  inputs: readonly JobFeedInput[],
): Promise<JobFeedResult[]> {
  if (inputs.length === 0) return [];
  const ids = inputs.map((i) => i.job.id);

  const [childRows, toolRows, llmRows] = await Promise.all([
    db
      .select({
        parentJobId: agentJobs.parentJobId,
        id: agentJobs.id,
        agentName: agents.name,
        agentSlug: agents.slug,
        status: agentJobs.status,
        task: agentJobs.task,
        result: agentJobs.result,
        error: agentJobs.error,
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

  const childrenByJob = groupBy(childRows, (r) => r.parentJobId);
  const toolsByJob = groupBy(toolRows, (r) => r.jobId);
  const llmByJob = groupBy(llmRows, (r) => r.jobId);

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
        result: job.result,
        error: job.error,
        agentName: input.agentName,
        agentSlug: input.agentSlug,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        messages,
        scheduleName,
        children: childrenByJob.get(job.id) ?? [],
      },
      (toolsByJob.get(job.id) ?? []).map((t) => ({
        ...t,
        toolOutput: t.toolOutput === null ? null : redactSecretsInText(t.toolOutput),
      })),
      llmByJob.get(job.id) ?? [],
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
