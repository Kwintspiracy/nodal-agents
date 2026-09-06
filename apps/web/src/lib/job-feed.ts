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
 * Le fil d'un travail, prêt à dessiner : ses enfants directs, ses lignes
 * d'audit (carte + charge utile persistées par P1), ses appels LLM par tour —
 * assemblés par `buildConversationFeed` (pur, testé sur la vraie forme des
 * lignes). Les messages sont masqués à l'AFFICHAGE (SECRET-001), jamais à
 * l'écriture.
 */
export async function assembleJobFeed(
  db: Db,
  entityId: string,
  input: JobFeedInput,
): Promise<JobFeedResult> {
  const { job } = input;
  const [childRows, toolRows, llmRows] = await Promise.all([
    db
      .select({
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
      .where(and(eq(agentJobs.parentJobId, job.id), eq(agentJobs.entityId, entityId)))
      .orderBy(agentJobs.createdAt),
    db
      .select({
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
      .where(and(eq(toolCalls.jobId, job.id), eq(toolCalls.entityId, entityId)))
      .orderBy(toolCalls.createdAt),
    db
      .select({
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
      .where(and(eq(llmCalls.jobId, job.id), eq(llmCalls.entityId, entityId)))
      .orderBy(llmCalls.createdAt),
  ]);

  const triggerContext = job.triggerContext as JobTriggerContext | null;
  const scheduleName =
    job.channel === 'cron' && triggerContext?.type === 'cron' ? triggerContext.scheduleName : null;
  const messages = redactTranscriptForDisplay(
    Array.isArray(job.messages) ? (job.messages as Record<string, unknown>[]) : [],
  );
  // La tâche passe par la MÊME rédaction que les messages : le modèle trouve la
  // demande en comparant les deux (`content === task`), et une demande qui
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
      children: childRows,
    },
    toolRows.map((t) => ({
      ...t,
      toolOutput: t.toolOutput === null ? null : redactSecretsInText(t.toolOutput),
    })),
    llmRows,
  );

  return { feed, displayTask, scheduleName };
}
