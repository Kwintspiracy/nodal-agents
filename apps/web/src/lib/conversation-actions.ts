'use server';

// conversation-actions.ts — Chat, la maison de TOUTES les conversations (plan
// « De la maquette au produit », P7).
//
// Une conversation est une conversation, d'où qu'elle vienne : le dashboard,
// Telegram, Slack, Discord, WhatsApp. Depuis P6, toutes ont une ligne dans
// `conversations` ; ce module les liste et rend le FIL de chacune.
//
// Les deux formes de tour ne vivent pas au même endroit, et c'est la seule
// complication réelle :
//   - dashboard : les tours sont des `chat_messages`, et certains ont escaladé
//     vers un `agent_jobs` (la colonne `job_id`) ;
//   - canal : il n'y a pas de `chat_messages` du tout — chaque message entrant
//     EST un job de tête portant `conversation_id`.
// `buildConversationThread` (pur) recolle les deux en une seule suite d'items,
// celle que `ConversationFeedView` dessine déjà depuis P2.

import 'server-only';
import { z } from 'zod';
import {
  eq,
  and,
  desc,
  isNull,
  inArray,
  sql,
  agents,
  agentJobs,
  approvalRequests,
  chatMessages,
  codeProjects,
  conversations,
  jobDeliverableVerificationState,
  jobDeliveries,
  llmCalls,
  toolCalls,
  verificationRuns,
} from '@nodal-agents/db';
import { normalizePath, stripGroupPrefix } from '@nodal-agents/shared';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { assembleJobFeeds, collectDescendants } from './job-feed.ts';
import { buildConversationThread } from './conversation-thread.ts';
import type { ThreadJob, ThreadProject } from './conversation-thread.ts';
import { classifyProduction } from './chat-or-work.ts';
import type { ConversationFeed } from './conversation-feed.ts';
import { aggregateSpaceCost, type SpaceCostView } from './space-cost.ts';
import {
  groupVerificationRuns,
  mergeSkippedSurfaces,
  type VerificationSequenceView,
  type VerificationUnconfiguredView,
} from './verification-runs-view.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

export type ConversationListRow = {
  id: string;
  channel: string;
  chatId: string | null;
  /** Vide quand ni la colonne ni la première demande ne donnent de titre. */
  title: string;
  agentId: string;
  agentName: string | null;
  agentSlug: string | null;
  agentAvatarUrl: string | null;
  updatedAt: Date | null;
  createdAt: Date | null;
  currentProject: ThreadProject | null;
  /** Les tours de l'utilisateur : messages `user` (dashboard) ou jobs de tête (canal). */
  turns: number;
  lastPreview: string | null;
};

export type ConversationThreadView = {
  conversation: {
    id: string;
    channel: string;
    chatId: string | null;
    title: string;
    agentId: string;
    agentName: string | null;
    agentSlug: string | null;
    createdAt: Date | null;
    currentProject: ThreadProject | null;
  };
  feed: ConversationFeed;
  /** P3 — la preuve de TOUS les travaux du fil et de leurs délégués. */
  verification: {
    sequences: VerificationSequenceView[];
    skippedSurfaces: string[];
    unconfigured: VerificationUnconfiguredView[];
  };
  cost: SpaceCostView;
  deliveries: Array<{
    channel: string;
    chatId: string;
    outcome: string;
    attempts: number;
    createdAt: Date | null;
    updatedAt: Date | null;
  }>;
  /** Un travail du fil n'est pas terminé : l'écran se rafraîchit. */
  live: boolean;
  /**
   * Le fil ne montre que sa FIN : les plafonds ont mordu. Le feed porte déjà
   * la note qui le dit ; ce drapeau existe pour qu'un appelant puisse en faire
   * autre chose (une pagination, un jour).
   */
  truncated: { messages: boolean; jobs: boolean };
  /**
   * Répondre depuis le web n'est câblé que pour le dashboard. Sur un canal, le
   * fil est en lecture seule et le DIT — répondre là-bas demanderait de
   * vérifier chaque canal un par un, ce que P7 ne fait pas.
   */
  canReply: boolean;
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Les jobs de tête chargés d'un fil — au-delà, l'écran n'est plus lisible. */
const HEAD_JOBS_MAX = 100;
const MESSAGES_MAX = 500;
const LIST_MAX = 200;
const TITLE_MAX = 60;
const PREVIEW_MAX = 120;

function firstLine(text: string, max: number): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length <= max ? line : line.slice(0, max);
}

/** Le nom du dossier, quand le propriétaire n'en a pas choisi un autre. */
function basenameOf(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function projectOf(row: {
  projectId: string | null;
  projectDisplayName: string | null;
  projectPath: string | null;
}): ThreadProject | null {
  if (row.projectId === null || row.projectPath === null) return null;
  return {
    id: row.projectId,
    name: row.projectDisplayName ?? basenameOf(row.projectPath),
    path: row.projectPath,
  };
}

// ─── listAllConversationsAction ──────────────────────────────────────────────

/**
 * Toutes les conversations de l'entité, la plus récente d'abord — tous canaux,
 * tous agents. L'entretien d'accueil (`origin = 'onboarding'`) reste dehors :
 * il est estampillé à la création et n'a jamais été une conversation que
 * l'utilisateur a ouverte.
 *
 * Trois requêtes, jamais une par conversation : la liste, puis les agrégats
 * des deux formes de tour (les messages du dashboard, les jobs de tête d'un
 * canal). Une requête par ligne aurait été 200 allers-retours pour le premier
 * écran du produit.
 */
export async function listAllConversationsAction(): Promise<ActionResult<ConversationListRow[]>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const db = getDb();

    const rows = await db
      .select({
        id: conversations.id,
        channel: conversations.channel,
        chatId: conversations.chatId,
        title: conversations.title,
        agentId: conversations.agentId,
        agentName: agents.name,
        agentSlug: agents.slug,
        agentAvatarUrl: agents.avatarUrl,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        projectId: codeProjects.id,
        projectDisplayName: codeProjects.displayName,
        projectPath: codeProjects.projectPath,
      })
      .from(conversations)
      .leftJoin(agents, eq(agents.id, conversations.agentId))
      .leftJoin(codeProjects, eq(codeProjects.id, conversations.currentProjectId))
      .where(and(eq(conversations.entityId, session.entityId), eq(conversations.origin, 'user')))
      .orderBy(desc(conversations.updatedAt))
      .limit(LIST_MAX);
    if (rows.length === 0) return ok([]);

    const ids = rows.map((r) => r.id);

    // Les deux agrégats, en une requête chacun. `array_agg(... ORDER BY ...)`
    // filtré donne la PREMIÈRE demande (le titre de repli) et le DERNIER mot
    // de l'agent (l'aperçu) sans rapatrier les fils entiers.
    const [messageStats, jobStats] = await Promise.all([
      db
        .select({
          conversationId: chatMessages.conversationId,
          turns: sql<number>`count(*) FILTER (WHERE ${chatMessages.role} = 'user')::int`,
          firstRequest: sql<
            string | null
          >`(array_agg(${chatMessages.content} ORDER BY ${chatMessages.createdAt}) FILTER (WHERE ${chatMessages.role} = 'user'))[1]`,
          lastReply: sql<
            string | null
          >`(array_agg(${chatMessages.content} ORDER BY ${chatMessages.createdAt} DESC) FILTER (WHERE ${chatMessages.role} = 'assistant'))[1]`,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.conversationId, ids))
        .groupBy(chatMessages.conversationId),
      db
        .select({
          conversationId: agentJobs.conversationId,
          turns: sql<number>`count(*)::int`,
          firstRequest: sql<
            string | null
          >`(array_agg(${agentJobs.task} ORDER BY ${agentJobs.createdAt}))[1]`,
          lastReply: sql<
            string | null
          >`(array_agg(${agentJobs.result} ORDER BY ${agentJobs.createdAt} DESC) FILTER (WHERE ${agentJobs.result} IS NOT NULL))[1]`,
        })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.entityId, session.entityId),
            isNull(agentJobs.parentJobId),
            inArray(agentJobs.conversationId, ids),
          ),
        )
        .groupBy(agentJobs.conversationId),
    ]);

    const byMessage = new Map(messageStats.map((s) => [s.conversationId ?? '', s]));
    const byJob = new Map(jobStats.map((s) => [s.conversationId ?? '', s]));

    return ok(
      rows.map((r): ConversationListRow => {
        const stats = r.channel === 'dashboard' ? byMessage.get(r.id) : byJob.get(r.id);
        return {
          id: r.id,
          channel: r.channel,
          chatId: r.chatId,
          // Le titre de la colonne d'abord ; sinon la première demande, qui est
          // le seul titre honnête d'un fil que personne n'a nommé — sans son
          // préfixe de groupe, qui nomme l'expéditeur et pas le sujet.
          title:
            r.title !== ''
              ? r.title
              : firstLine(stripGroupPrefix(stats?.firstRequest ?? ''), TITLE_MAX),
          agentId: r.agentId,
          agentName: r.agentName,
          agentSlug: r.agentSlug,
          agentAvatarUrl: r.agentAvatarUrl,
          updatedAt: r.updatedAt,
          createdAt: r.createdAt,
          currentProject: projectOf(r),
          turns: stats?.turns ?? 0,
          lastPreview:
            stats?.lastReply != null ? firstLine(stats.lastReply, PREVIEW_MAX) || null : null,
        };
      }),
    );
  } catch (err) {
    console.error('[listAllConversationsAction]', err);
    return fail('db_error', 'Failed to load conversations');
  }
}

// ─── getConversationThreadAction ─────────────────────────────────────────────

/**
 * Le fil d'une conversation, prêt à dessiner : ses tours, le fil de chacun de
 * ses travaux (le MÊME assemblage que la page d'un espace, `job-feed.ts`), ce
 * que chaque travail a fait sortir du chat, la preuve, la file d'envoi et le
 * coût de l'ensemble.
 */
export async function getConversationThreadAction(
  id: string,
): Promise<ActionResult<ConversationThreadView>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid conversation id');
    }
    const db = getDb();

    const [conv] = await db
      .select({
        id: conversations.id,
        channel: conversations.channel,
        chatId: conversations.chatId,
        title: conversations.title,
        agentId: conversations.agentId,
        agentName: agents.name,
        agentSlug: agents.slug,
        createdAt: conversations.createdAt,
        projectId: codeProjects.id,
        projectDisplayName: codeProjects.displayName,
        projectPath: codeProjects.projectPath,
      })
      .from(conversations)
      .leftJoin(agents, eq(agents.id, conversations.agentId))
      .leftJoin(codeProjects, eq(codeProjects.id, conversations.currentProjectId))
      .where(and(eq(conversations.id, id), eq(conversations.entityId, session.entityId)))
      .limit(1);
    if (!conv) return fail('not_found', 'Conversation not found');

    // LES PLUS RÉCENTS, puis remis dans l'ordre. Le plafond gardait le DÉBUT
    // du fil : au 101e tour d'un canal, la page restait figée sur les cent
    // premiers jobs et ne montrait plus la conversation en cours (revue Codex,
    // passe 29). On lit donc la FIN, et on dit que le début manque.
    const [recentMessages, recentHeads] = await Promise.all([
      db
        .select({
          id: chatMessages.id,
          role: chatMessages.role,
          content: chatMessages.content,
          jobId: chatMessages.jobId,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, id))
        .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
        .limit(MESSAGES_MAX),
      db
        .select({ job: agentJobs, agentName: agents.name, agentSlug: agents.slug })
        .from(agentJobs)
        .leftJoin(agents, eq(agents.id, agentJobs.agentId))
        .where(
          and(
            eq(agentJobs.entityId, session.entityId),
            eq(agentJobs.conversationId, id),
            isNull(agentJobs.parentJobId),
          ),
        )
        .orderBy(desc(agentJobs.createdAt), desc(agentJobs.id))
        .limit(HEAD_JOBS_MAX),
    ]);
    // Le plafond ATTEINT ne prouve pas qu'il a mordu (il peut y avoir
    // exactement N tours), mais c'est le seul signal disponible sans une
    // requête de comptage de plus ; dire « il y en a peut-être d'autres » vaut
    // mieux que laisser croire que le fil commence là.
    const truncated = {
      messages: recentMessages.length === MESSAGES_MAX,
      jobs: recentHeads.length === HEAD_JOBS_MAX,
    };
    const messageRows = [...recentMessages].reverse();
    const headRows = [...recentHeads].reverse();

    const headIds = headRows.map((r) => r.job.id);
    const descendants =
      headIds.length > 0 ? await collectDescendants(db, session.entityId, headIds) : [];
    const relevantIds = [...headIds, ...descendants.map((d) => d.id)];
    // Chaque descendant rend sa production au tour qui l'a déclenché.
    const rootOf = new Map<string, string>(headIds.map((h) => [h, h]));
    for (const d of descendants) rootOf.set(d.id, d.rootId);

    // Le fil de chaque travail : un assemblage par job, celui de la page d'un
    // espace. Les lignes d'audit de TOUS les jobs (têtes et descendants) sont
    // relues à part, parce que la frontière chat/travail est récursive.
    const [assembled, classifiableRows, projectRows] = await Promise.all([
      // Trois requêtes pour TOUS les jobs de tête, pas trois par job : au
      // plafond de cent, l'ancienne version en lançait trois cents pour une
      // seule page (revue Codex, passe 29, doute 2).
      assembleJobFeeds(
        db,
        session.entityId,
        headRows.map((r) => ({ job: r.job, agentName: r.agentName, agentSlug: r.agentSlug })),
      ),
      relevantIds.length > 0
        ? db
            .select({
              jobId: toolCalls.jobId,
              toolName: toolCalls.toolName,
              card: toolCalls.card,
              presented: toolCalls.presented,
              riskLevel: toolCalls.riskLevel,
              toolInput: toolCalls.toolInput,
              // L'ISSUE de l'appel : sans elle, un refus d'approbation passait
              // pour une production (revue Codex, passe 29).
              toolOutput: toolCalls.toolOutput,
            })
            .from(toolCalls)
            .where(
              and(eq(toolCalls.entityId, session.entityId), inArray(toolCalls.jobId, relevantIds)),
            )
            .orderBy(toolCalls.createdAt)
        : Promise.resolve([]),
      (() => {
        const projectIds = [
          ...new Set(
            headRows
              .map((r) => r.job.projectId)
              .filter((p): p is string => typeof p === 'string' && p !== ''),
          ),
        ];
        return projectIds.length > 0
          ? db
              .select({
                id: codeProjects.id,
                displayName: codeProjects.displayName,
                projectPath: codeProjects.projectPath,
              })
              .from(codeProjects)
              .where(
                and(
                  eq(codeProjects.entityId, session.entityId),
                  inArray(codeProjects.id, projectIds),
                ),
              )
          : Promise.resolve([]);
      })(),
    ]);

    const projectById = new Map(
      projectRows.map((p) => [
        p.id,
        { id: p.id, name: p.displayName ?? basenameOf(p.projectPath), path: p.projectPath },
      ]),
    );

    // Les lignes d'audit rangées SOUS leur job de tête : la production d'un
    // sous-agent fait l'encart du tour parent (lecture (b) du plan).
    const rowsByRoot = new Map<string, Array<(typeof classifiableRows)[number]>>();
    for (const row of classifiableRows) {
      const root = row.jobId !== null ? rootOf.get(row.jobId) : undefined;
      if (root === undefined) continue;
      const bucket = rowsByRoot.get(root) ?? [];
      bucket.push(row);
      rowsByRoot.set(root, bucket);
    }

    const conversationRef = { channel: conv.channel, chatId: conv.chatId };
    const jobs: ThreadJob[] = headRows.map((r, i) => ({
      jobId: r.job.id,
      feed: assembled[i]!.feed,
      createdAt: r.job.createdAt,
      verdict: classifyProduction({
        conversation: conversationRef,
        rows: rowsByRoot.get(r.job.id) ?? [],
      }),
      project: r.job.projectId !== null ? (projectById.get(r.job.projectId) ?? null) : null,
    }));

    const currentProject = projectOf(conv);
    const feed = buildConversationThread({
      conversation: {
        id: conv.id,
        channel: conv.channel,
        chatId: conv.chatId,
        title: conv.title,
        agentName: conv.agentName,
        agentSlug: conv.agentSlug,
        currentProject,
      },
      messages: messageRows.map((m) => ({
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        jobId: m.jobId,
        createdAt: m.createdAt,
      })),
      jobs,
      truncated,
    });

    // P3/P4 — la preuve, la file d'envoi et le coût de TOUT le fil : les jobs
    // de tête et leurs délégués, jamais le réglage courant.
    const [verificationRunRows, unconfiguredRows, deliveryRows, costRows, approvalRows] =
      relevantIds.length === 0
        ? [[], [], [], [], []]
        : await Promise.all([
            db
              .select({
                jobId: verificationRuns.jobId,
                deliverableType: verificationRuns.deliverableType,
                canonicalKey: verificationRuns.canonicalKey,
                sequenceId: verificationRuns.sequenceId,
                commandRank: verificationRuns.commandRank,
                command: verificationRuns.command,
                exitCode: verificationRuns.exitCode,
                outcomeKind: verificationRuns.outcomeKind,
                durationMs: verificationRuns.durationMs,
                verdict: verificationRuns.verdict,
                testedGeneration: verificationRuns.testedGeneration,
                testedEpoch: verificationRuns.testedEpoch,
                createdAt: verificationRuns.createdAt,
              })
              .from(verificationRuns)
              .where(
                and(
                  eq(verificationRuns.entityId, session.entityId),
                  inArray(verificationRuns.jobId, relevantIds),
                ),
              ),
            db
              .select({
                deliverableType: jobDeliverableVerificationState.deliverableType,
                canonicalKey: jobDeliverableVerificationState.canonicalKey,
                displayPath: jobDeliverableVerificationState.displayPathSnapshot,
                decisionStatus: jobDeliverableVerificationState.decisionStatus,
              })
              .from(jobDeliverableVerificationState)
              .where(
                and(
                  inArray(jobDeliverableVerificationState.jobId, relevantIds),
                  inArray(jobDeliverableVerificationState.decisionStatus, [
                    'not_configured',
                    'pending_approval',
                  ]),
                ),
              ),
            db
              .select({
                channel: jobDeliveries.channel,
                chatId: jobDeliveries.chatId,
                outcome: jobDeliveries.outcome,
                attempts: jobDeliveries.attempts,
                createdAt: jobDeliveries.createdAt,
                updatedAt: jobDeliveries.updatedAt,
              })
              .from(jobDeliveries)
              .where(inArray(jobDeliveries.jobId, relevantIds))
              .orderBy(jobDeliveries.createdAt),
            db
              .select({
                agentId: llmCalls.agentId,
                agentName: agents.name,
                modelEffective: llmCalls.modelEffective,
                inputTokens: llmCalls.inputTokens,
                outputTokens: llmCalls.outputTokens,
                cachedTokens: llmCalls.cachedTokens,
                cacheCreationTokens: llmCalls.cacheCreationTokens,
                costUsd: llmCalls.costUsd,
                durationMs: llmCalls.durationMs,
              })
              .from(llmCalls)
              .leftJoin(agents, eq(agents.id, llmCalls.agentId))
              .where(
                and(eq(llmCalls.entityId, session.entityId), inArray(llmCalls.jobId, relevantIds)),
              ),
            db
              .select({
                requestedAt: approvalRequests.requestedAt,
                resolvedAt: approvalRequests.resolvedAt,
              })
              .from(approvalRequests)
              .where(
                and(
                  eq(approvalRequests.entityId, session.entityId),
                  inArray(approvalRequests.jobId, relevantIds),
                ),
              ),
          ]);

    // Le fil COURT depuis l'ouverture de la conversation, pas depuis son
    // premier travail : c'est la durée que l'utilisateur a vécue. Il ne se
    // referme que lorsque tous ses travaux sont terminés.
    const allTerminal = headRows.every((r) => TERMINAL_STATUSES.has(r.job.status ?? ''));
    const lastCompletedAt = headRows.reduce<Date | null>((acc, r) => {
      const at = r.job.completedAt;
      if (at === null) return acc;
      return acc === null || at > acc ? at : acc;
    }, null);
    const cost = aggregateSpaceCost({
      calls: costRows,
      approvals: approvalRows,
      proofMs: verificationRunRows.reduce((acc, r) => acc + (r.durationMs ?? 0), 0),
      startedAt: conv.createdAt,
      endedAt: allTerminal ? lastCompletedAt : null,
    });

    return ok({
      conversation: {
        id: conv.id,
        channel: conv.channel,
        chatId: conv.chatId,
        title: conv.title,
        agentId: conv.agentId,
        agentName: conv.agentName,
        agentSlug: conv.agentSlug,
        createdAt: conv.createdAt,
        currentProject,
      },
      feed,
      verification: {
        sequences: groupVerificationRuns(verificationRunRows),
        skippedSurfaces: mergeSkippedSurfaces([
          ...headRows.map((r) => r.job.verificationSkippedSurfaces),
          ...descendants.map((d) => d.verificationSkippedSurfaces),
        ]),
        unconfigured: unconfiguredRows.map(
          (r): VerificationUnconfiguredView => ({
            deliverableType: r.deliverableType,
            canonicalKey: r.canonicalKey,
            displayPath: r.displayPath,
            reason: r.decisionStatus === 'pending_approval' ? 'pending_approval' : 'not_configured',
          }),
        ),
      },
      cost,
      deliveries: deliveryRows,
      live: !allTerminal,
      truncated,
      canReply: conv.channel === 'dashboard',
    });
  } catch (err) {
    console.error('[getConversationThreadAction]', err);
    return fail('db_error', 'Failed to load the conversation');
  }
}
