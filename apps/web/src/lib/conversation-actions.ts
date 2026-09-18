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
  or,
  desc,
  isNull,
  isNotNull,
  lt,
  ne,
  inArray,
  notInArray,
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
  telegramAllowedChats,
  channelAllowedConversations,
} from '@nodal-agents/db';
import { normalizePath, redactSecretsInText, stripGroupPrefix } from '@nodal-agents/shared';
import { plainText } from '@/components/Markdown.tsx';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  decodeRunCursor,
  encodeRunCursor,
  runIsDeletable,
  type RunCursor,
} from './external-runs.ts';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { assembleJobFeeds, collectDescendants } from './job-feed.ts';
// La borne de `collectDescendants`, nommée ici pour que le message d'erreur la
// dise plutôt que de la recopier en dur.
import { ROLLUP_MAX_DEPTH } from './coding-rollup.ts';
import { redactPresented } from './redact-presented.ts';
import { parsePresented } from './tool-card-payload.ts';
import { entityWorkspaceRoots } from './workspace-roots.ts';
import { buildConversationThread } from './conversation-thread.ts';
// UNE seule définition de la clé d'un chat, des deux côtés. Elle vit dans son
// propre module : l'importer de `chat-list.ts` formait un cycle, puisque ce
// dernier importe le type des lignes d'ici.
import { chatKey, LIST_MAX } from './chat-key.ts';
import type { ThreadJob, ThreadProject, ThreadProofRun } from './conversation-thread.ts';
import { classifyProduction } from './chat-or-work.ts';
import { folderOfWork, MCP_JOB_CHANNELS, RUNNING_JOB_STATUSES } from './chat-folders.ts';
import type { ConversationFeed } from './conversation-feed.ts';
import { aggregateSpaceCost, type SpaceCostView } from './space-cost.ts';
import {
  deliverableStatuses,
  FILE_DELIVERABLE_TYPES,
  groupVerificationRuns,
  mergeSkippedSurfaces,
  type DeliverableStatusView,
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

/**
 * Le fil COURANT de chaque chat, désigné par la BASE, avec exactement la clé et
 * l'ordre de `resolveConversation` (apps/runner/src/job/conversation-id.ts).
 *
 * Clé `<agentId>:<channel>:<chatId>` — la même que `chatKey` côté écran.
 */
export type CurrentThreadByChat = {
  /** Le fil courant de chaque chat — clé `chatKey`, valeur l'identifiant. */
  readonly current: Readonly<Record<string, string>>;
  /**
   * Les chats qui ont au moins une conversation ÉLIGIBLE à la liste. Sert à
   * compter ce qui manque à l'écran, et seulement à ça : un chat désigné mais
   * non éligible n'a rien à faire dans la liste, son absence n'est pas un
   * silence.
   */
  readonly listable: readonly string[];
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
    agentAvatarUrl: string | null;
    createdAt: Date | null;
    currentProject: ThreadProject | null;
  };
  feed: ConversationFeed;
  /** P3 — la preuve de TOUS les travaux du fil et de leurs délégués. */
  verification: {
    sequences: VerificationSequenceView[];
    skippedSurfaces: string[];
    unconfigured: VerificationUnconfiguredView[];
    /** P12 — l'état de chaque DOCUMENT du fil, pour la carte du fichier écrit. */
    deliverables: DeliverableStatusView[];
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
const TITLE_MAX = 60;
const PREVIEW_MAX = 120;

/**
 * La première ligne LISIBLE d'un texte d'agent : son markdown est aplati
 * (P2bis) avant la coupe, sinon la liste des conversations affichait
 * « ## **PRD**, Podium » avec ses dièses et ses astérisques.
 *
 * ET MASQUÉE (SECRET-001, Reviewer C sur #179). Le titre d'un fil que personne
 * n'a nommé EST la première demande de la personne, et l'aperçu est la dernière
 * réponse de l'agent : une clé collée dans l'un ou l'autre s'affichait en clair
 * dans la boîte de réception. Le fil, lui, était déjà masqué — pas sa liste.
 *
 * L'ORDRE compte, et c'est tout l'intérêt de le faire ici. Aplatir d'abord :
 * un `**sk-…**` garde ses astérisques et aucun motif ne le reconnaît. Masquer
 * ensuite, AVANT la coupe : couper à 60 signes d'abord laisserait passer les
 * 60 premiers signes d'une clé, ce qui en est l'essentiel.
 */
function firstLine(text: string, max: number): string {
  const line = redactSecretsInText(plainText(text));
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
 * l'utilisateur a ouverte. Celle qu'on ouvre depuis un projet (`project`,
 * 0097) est DEDANS : c'est une conversation de l'utilisateur comme une autre,
 * son origine ne sert qu'à désigner le fil que la page du projet prolonge.
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
      .where(
        and(
          eq(conversations.entityId, session.entityId),
          inArray(conversations.origin, ['user', 'project']),
        ),
      )
      // `id` DÉPARTAGE à date égale. Sans lui, deux fils du même chat posés à
      // la même seconde — un backfill, deux `/new` en rafale — sortaient dans
      // un ordre laissé au plan d'exécution, et la ligne du chat ouvrait
      // tantôt l'un tantôt l'autre (revue Codex, PR #48). Même remède que
      // `resolveConversation` côté runner, pour la même raison.
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
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
              ? firstLine(r.title, TITLE_MAX)
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

/**
 * Le fil courant de chaque chat, désigné PAR LA BASE.
 *
 * POURQUOI ce n'est pas calculable côté écran, et pourquoi l'avoir essayé était
 * l'erreur (revue Codex, PR #48, passes 5 et 6). Le fil courant d'un chat est
 * celui où le RUNNER posera le prochain message : `resolveConversation` le
 * choisit par `created_at DESC, id DESC` sur (entité, agent, canal, chat). Le
 * recalculer en TypeScript sur les lignes chargées échouait de trois façons,
 * toutes invisibles :
 *
 *   - la LISTE est coupée à 200 lignes, triées par `updated_at`. Un fil courant
 *     resté inactif pendant que 199 autres conversations bougent tombe hors de
 *     la fenêtre, et le calcul ne peut désigner que ce qu'il a reçu ;
 *   - `created_at` est `timestamptz`, donc microsecondes en base ; une `Date`
 *     JavaScript s'arrête à la milliseconde. Deux fils créés dans la même
 *     milliseconde paraissaient à ÉGALITÉ côté écran, et le départage par `id`
 *     se déclenchait sur une égalité qui n'existe pas en base ;
 *   - `created_at` est NULLABLE (migration 0028), et `ORDER BY … DESC` place
 *     les NULL DEVANT en PostgreSQL. Traiter `null` comme la plus ancienne date
 *     — le choix naturel en TypeScript — inversait le verdict du runner.
 *
 * Une seule règle, exécutée à un seul endroit, sur les données entières. La
 * requête rend une ligne par chat, sans plafond : c'est le nombre de chats, pas
 * le nombre de conversations.
 *
 * Le filtre d'origine de la liste (`user`, `project`) n'est PAS repris : le
 * runner ne l'applique pas, et c'est SON choix qu'on reproduit. Un chat dont le
 * fil courant serait d'une autre origine doit mener là où ira le message.
 */
export async function listCurrentThreadByChatAction(): Promise<ActionResult<CurrentThreadByChat>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const db = getDb();

    // `DISTINCT ON` rend la PREMIÈRE ligne de chaque groupe selon l'ORDER BY —
    // donc le fil courant, et lui seul. L'ordre reproduit `resolveConversation`
    // à la lettre, `NULLS FIRST` par défaut compris : diverger ici, même « en
    // mieux », recréerait exactement le désaccord qu'on répare.
    //
    // Passé par le constructeur de requêtes, pas par du SQL brut : `db.execute`
    // ne rend pas la même forme selon le pilote (un tableau avec postgres.js,
    // un objet `{ rows }` avec PGlite), et le premier test contre une vraie base
    // l'a montré tout de suite — « rows is not iterable ».
    const rows = await db
      .selectDistinctOn([conversations.agentId, conversations.channel, conversations.chatId], {
        agentId: conversations.agentId,
        channel: conversations.channel,
        chatId: conversations.chatId,
        id: conversations.id,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.entityId, session.entityId),
          isNotNull(conversations.chatId),
          ne(conversations.chatId, ''),
          ne(conversations.channel, 'dashboard'),
        ),
      )
      .orderBy(
        conversations.agentId,
        conversations.channel,
        conversations.chatId,
        desc(conversations.createdAt),
        desc(conversations.id),
      );

    // Les chats ÉLIGIBLES à la liste — ceux qui ont au moins une conversation
    // que `listAllConversationsAction` accepterait.
    //
    // C'est une question DIFFÉRENTE de la désignation, et les confondre faisait
    // mentir l'écran (revue Codex, PR #48, passe 9) : la désignation ne filtre
    // pas l'origine, parce qu'elle copie le runner. Un chat dont le seul fil est
    // un entretien d'accueil y figure donc — et il était compté comme « écarté
    // par le plafond » alors qu'aucune conversation listable ne le remplit.
    // Le plafond n'y est pour rien, et le dire était faux.
    const eligibles = await db
      .selectDistinct({
        agentId: conversations.agentId,
        channel: conversations.channel,
        chatId: conversations.chatId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.entityId, session.entityId),
          isNotNull(conversations.chatId),
          ne(conversations.chatId, ''),
          ne(conversations.channel, 'dashboard'),
          inArray(conversations.origin, ['user', 'project']),
        ),
      );

    const current: Record<string, string> = {};
    for (const r of rows) {
      if (r.chatId === null) continue;
      current[chatKey(r.agentId, r.channel, r.chatId)] = r.id;
    }
    const listable: string[] = [];
    for (const r of eligibles) {
      if (r.chatId === null) continue;
      listable.push(chatKey(r.agentId, r.channel, r.chatId));
    }
    return ok({ current, listable });
  } catch (err) {
    console.error('[listCurrentThreadByChatAction]', err);
    return fail('db_error', 'Failed to resolve current threads');
  }
}

/** Ce que l'allowlist sait d'un chat : son nom, et sa nature. */
export type ChatIdentities = Readonly<Record<string, { name: string | null; kind: string | null }>>;

/**
 * Ce que le menu « Chat folders » a besoin de savoir, et que les approbations
 * ne portent pas (#135).
 *
 * Trois faits, trois requêtes, aucune par dossier NI par ligne :
 *   - `channels` — les canaux qui portent au moins une conversation LISTABLE.
 *     Les mêmes prédicats que la désignation du fil courant, pour que l'index
 *     partiel `idx_conversations_listable_chats` les serve ;
 *   - `running` — combien de runs TOURNENT, par dossier. Groupé en SQL : une
 *     requête par dossier redeviendrait un N+1 au premier canal ajouté. Le
 *     dossier se lit sur le canal de la CONVERSATION du run quand il en a une
 *     (#148), sur le sien sinon — la règle de `folderOfWork`, la même que la
 *     pastille ;
 *   - `runningConversationIds` — SUR QUELLES conversations ils tournent, pour
 *     le point vert d'une LIGNE de la liste (#135). Un `distinct` en SQL, pas
 *     une lecture par ligne affichée.
 *
 * Ce qui ATTEND la personne ne se lit PAS ici : il vient des approbations que
 * la barre latérale a déjà en main (`ApprovalsProvider`), et le relire ferait
 * deux vérités pour le même chiffre.
 */
export type ChatFoldersSnapshot = {
  /** Les canaux qui portent au moins une conversation listable. */
  channels: string[];
  /** Le nombre de runs en cours, par dossier. Une clé absente vaut zéro. */
  running: Record<string, number>;
  /**
   * Les conversations sur lesquelles un run TOURNE en ce moment — les mêmes
   * statuts que `running`, donc sans celui qui attend une approbation.
   *
   * Sans rapport avec le dossier : une conversation n'appartient qu'à un seul,
   * et la ligne qui la dessine sait déjà lequel. Un job sans `conversation_id`
   * n'y figure pas — il tourne, mais aucune ligne ne peut le montrer.
   */
  runningConversationIds: string[];
  /**
   * Combien de runs de TÊTE viennent de dehors — `/api/agent` ou le serveur
   * MCP, donc `channel` à `api` ou `mcp`, sans parent et sans conversation.
   * C'est ce qui fait EXISTER le dossier MCP (18/09), comme une conversation
   * fait exister celui d'un canal.
   */
  externalRuns: number;
};

/**
 * Ce qu'un run venu de dehors est dans la liste de son dossier.
 *
 * Pas de conversation, donc pas de fil : la ligne ouvre la page du RUN. Le
 * titre est la tâche demandée — la seule chose que la machine à l'autre bout a
 * écrite.
 */
export type ExternalRunRow = {
  id: string;
  /** La tâche, telle qu'elle a été demandée. Coupée à l'affichage, pas ici. */
  task: string;
  /** Le statut du job de tête : c'est lui qui dit si le run avance encore. */
  status: string | null;
  createdAt: Date | null;
};

/** Une page de la liste, et de quoi demander la suivante. */
export type ExternalRunsPage = {
  runs: ExternalRunRow[];
  /**
   * Où reprendre. `null` = il n'y a plus rien après, et le bouton « Load more »
   * disparaît — un bouton qui rendrait une page vide se lirait comme une panne.
   */
  nextCursor: string | null;
};

/**
 * La taille d'UNE page (#183). La table entière ne se lit jamais : la base du
 * propriétaire porte déjà plus de cent runs de tête, et ce nombre ne fait que
 * monter — c'est une machine qui les crée.
 *
 * Cinquante, comme une boîte de réception : de quoi remplir l'écran et
 * quelques défilements, sans faire attendre l'ouverture du dossier.
 */
const EXTERNAL_RUNS_PAGE = 50;

/** Combien de runs une suppression accepte d'un coup. */
const EXTERNAL_RUNS_DELETE_MAX = 200;

/**
 * Ce qui fait d'un job un RUN VENU DE DEHORS, écrit à UN seul endroit : le
 * compte qui fait exister le dossier, la liste qu'il ouvre et la suppression
 * doivent dire la même chose, sinon le dossier s'affiche vide ou disparaît en
 * portant des lignes — ou l'on supprime par cette porte un job qu'elle ne
 * montre pas.
 *
 * `parent_job_id IS NULL` — un délégué n'est pas un run à lui seul, c'est une
 * étape de celui qui l'a créé. `conversation_id IS NULL` — un job `api`
 * rattaché à une conversation est un TOUR DE CHAT, et `folderOfWork` le range
 * déjà dans le dossier de cette conversation.
 */
function runsFromOutside(entityId: string) {
  return and(
    eq(agentJobs.entityId, entityId),
    isNull(agentJobs.parentJobId),
    isNull(agentJobs.conversationId),
    inArray(agentJobs.channel, [...MCP_JOB_CHANNELS]),
  );
}

export async function getChatFoldersAction(): Promise<ActionResult<ChatFoldersSnapshot>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const db = getDb();

    const [channelRows, runningRows, runningConvRows, externalRows] = await Promise.all([
      db
        .selectDistinct({ channel: conversations.channel })
        .from(conversations)
        .where(
          and(
            eq(conversations.entityId, session.entityId),
            isNotNull(conversations.chatId),
            ne(conversations.chatId, ''),
            ne(conversations.channel, 'dashboard'),
            inArray(conversations.origin, ['user', 'project']),
          ),
        ),
      // Groupé sur les DEUX canaux — celui du job et celui de sa conversation —
      // parce que c'est le second qui range le travail quand il existe (#148).
      // La règle reste en TypeScript, la même que la pastille et que la ligne ;
      // un `coalesce` en SQL en ferait une deuxième, à tenir d'accord avec la
      // première. Le groupe a au pire autant de lignes que de paires de canaux.
      db
        .select({
          jobChannel: agentJobs.channel,
          conversationChannel: conversations.channel,
          n: sql<number>`count(*)::int`,
        })
        .from(agentJobs)
        // Seule une conversation que la liste MONTRE (`origin` user/project)
        // range le run : la même frontière que la requête `channels` au-dessus,
        // sinon le point du dossier s'allumerait sans ligne (Reviewer C, #157).
        .leftJoin(
          conversations,
          and(
            eq(conversations.id, agentJobs.conversationId),
            eq(conversations.entityId, session.entityId),
            inArray(conversations.origin, ['user', 'project']),
          ),
        )
        .where(
          and(
            eq(agentJobs.entityId, session.entityId),
            inArray(agentJobs.status, [...RUNNING_JOB_STATUSES]),
          ),
        )
        .groupBy(agentJobs.channel, conversations.channel),
      // Les CONVERSATIONS où ça tourne. Une seule lecture, dédupliquée en
      // base : trois jobs d'un même fil n'allument qu'un point, et cinquante
      // lignes à l'écran ne font pas cinquante requêtes.
      db
        .selectDistinct({ conversationId: agentJobs.conversationId })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.entityId, session.entityId),
            inArray(agentJobs.status, [...RUNNING_JOB_STATUSES]),
            isNotNull(agentJobs.conversationId),
          ),
        ),
      // Combien de runs viennent de dehors — le chiffre qui fait exister le
      // dossier MCP. Un `count` en base : la liste, elle, ne se lit qu'en
      // ouvrant le dossier.
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(agentJobs)
        .where(runsFromOutside(session.entityId)),
    ]);

    const running: Record<string, number> = {};
    for (const r of runningRows) {
      // Un run devient un DOSSIER par la même règle que partout ailleurs : le
      // canal de sa conversation d'abord, le sien ensuite. Un canal qui n'en
      // désigne aucun (`internal`, `webhook`, `task-board`…) n'allume aucun
      // point : son run existe, il n'est dans aucun dossier de chat, et il
      // reste lisible sur la page des runs.
      //
      // ⚠️ UN DÉLÉGUÉ QUI TOURNE n'a pas besoin d'être compté ici : son parent
      // est alors `awaiting_delegation`, un statut vivant, et c'est le parent
      // qui porte le canal du dossier. Remonter la chaîne pour le point vert
      // compterait deux fois la même chose.
      const key = folderOfWork(r);
      if (key === null) continue;
      running[key] = (running[key] ?? 0) + r.n;
    }

    return ok({
      channels: channelRows.map((r) => r.channel),
      running,
      // `isNotNull` filtre déjà en SQL ; le `filter` est ce qui le DIT au
      // typage, sans jamais rendre un `null` que l'écran prendrait pour un
      // identifiant.
      runningConversationIds: runningConvRows
        .map((r) => r.conversationId)
        .filter((id): id is string => id !== null),
      externalRuns: externalRows[0]?.n ?? 0,
    });
  } catch (err) {
    console.error('[getChatFoldersAction]', err);
    return fail('db_error', 'Failed to load the chat folders');
  }
}

/**
 * UNE PAGE des runs venus de dehors, les plus récents d'abord — la liste du
 * dossier MCP (#183).
 *
 * Les mêmes conditions que le compte du menu (`runsFromOutside`), et rien de
 * plus : ni approbation ni descendance ne se lit ici. Ce qui ATTEND la
 * personne vient des approbations que la page a déjà en main, comme pour les
 * dossiers de canal — les relire ferait deux vérités pour le même chiffre.
 *
 * LA PAGE SUIVANTE SE DEMANDE PAR CURSEUR, pas par `offset` : une machine peut
 * poster un run entre deux pages, et un rang se décale quand une ligne entre
 * ou sort (voir `lib/external-runs-cursor.ts`). La borne `(created_at, id)`
 * désigne une LIGNE ; ce qui arrive après ne la déplace pas.
 *
 * `N + 1` lignes sont lues, jamais un `count` : la ligne en trop ne sert qu'à
 * SAVOIR s'il y en a d'autres, et elle n'est pas rendue. Compter à part
 * coûterait une seconde requête pour une réponse que cette lecture contient
 * déjà.
 */
export async function listExternalRunsAction(
  opts: { cursor?: string | null } = {},
): Promise<ActionResult<ExternalRunsPage>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const db = getDb();

    // Un curseur illisible repart du DÉBUT plutôt que de rendre une page vide.
    const apres = decodeRunCursor(opts.cursor ?? null);
    const borne =
      apres === null
        ? runsFromOutside(session.entityId)
        : and(runsFromOutside(session.entityId), apresLaLigne(apres));

    const rows = await db
      .select({
        id: agentJobs.id,
        task: agentJobs.task,
        status: agentJobs.status,
        createdAt: agentJobs.createdAt,
      })
      .from(agentJobs)
      .where(borne)
      // `DESC` NU, donc `NULLS FIRST` — l'ordre exact de l'index
      // `idx_agent_jobs_entity_created (entity_id, created_at DESC)`.
      //
      // Il portait `NULLS LAST`, pour ranger en dernier les lignes dont on
      // ignore la date. Mesuré sur 10 001 runs (Reviewer C, passe 1), ce mot
      // coûtait le balayage de TOUS les jobs de l'entité puis un tri complet —
      // 8,1 ms et 10 001 lignes lues, là où l'index nu en lit 52 en 0,19 ms, et
      // l'écart grandit avec la table. Une page qui coûte toute la table n'est
      // pas une pagination.
      //
      // Le prix : une ligne sans date se range en TÊTE. Elle paraît donc sur la
      // première page, et la borne ci-dessous la laisse derrière — ni doublon,
      // ni trou, seulement une place qu'on n'a pas choisie pour une ligne dont
      // la date manque. `created_at` porte `DEFAULT now()` (migration 0000) :
      // le cas demande une écriture qui force `NULL`.
      .orderBy(desc(agentJobs.createdAt), desc(agentJobs.id))
      .limit(EXTERNAL_RUNS_PAGE + 1);

    const page = rows.slice(0, EXTERNAL_RUNS_PAGE);
    const encore = rows.length > EXTERNAL_RUNS_PAGE;
    const derniere = page[page.length - 1];
    return ok({
      runs: page,
      nextCursor: encore && derniere !== undefined ? encodeRunCursor(derniere) : null,
    });
  } catch (err) {
    console.error('[listExternalRunsAction]', err);
    return fail('db_error', 'Failed to load the runs started from outside');
  }
}

/**
 * « Strictement après cette ligne », dans l'ordre exact de la liste —
 * `created_at DESC` (donc `NULLS FIRST`), puis `id DESC`.
 *
 * Écrit en deux morceaux plutôt qu'en comparaison de paires, à cause des dates
 * absentes : `(NULL, id) < (date, id)` vaut NULL, donc FAUX, et une ligne sans
 * date disparaîtrait de toutes les pages au lieu de tenir sa place.
 *
 *   - curseur SANS date : on est dans la TÊTE de la liste. Après lui viennent
 *     les autres lignes sans date d'`id` plus petit, puis toutes les lignes
 *     datées, sans exception ;
 *   - curseur AVEC date : les lignes sans date sont déjà passées. Reste ce qui
 *     est plus ancien, et, à date égale, un `id` plus petit.
 */
function apresLaLigne(apres: RunCursor) {
  if (apres.createdAt === null) {
    return or(
      and(isNull(agentJobs.createdAt), lt(agentJobs.id, apres.id)),
      isNotNull(agentJobs.createdAt),
    );
  }
  return or(
    lt(agentJobs.createdAt, apres.createdAt),
    and(eq(agentJobs.createdAt, apres.createdAt), lt(agentJobs.id, apres.id)),
  );
}

/**
 * Supprimer des runs venus de dehors, AVEC leur descendance (#183).
 *
 * **Pourquoi la descendance, explicitement.** `agent_jobs.parent_job_id` n'est
 * PAS une clé étrangère dans la vraie base (migration 0000 : une colonne et
 * deux index, aucune contrainte) : rien ne suit un parent supprimé, et ses
 * délégués resteraient là, orphelins et invisibles — plus aucun run ne les
 * porterait. On les supprime donc à la main, niveau par niveau
 * (`collectDescendants`), dans la MÊME instruction que leurs racines.
 *
 * **Ce qui part avec eux, et ce qui reste.** Les tables qui cascadent :
 * `tool_calls`, `approval_requests`, `job_deliveries`, `job_checkpoints`,
 * `job_deliverable_verification_state`. Celles qui se contentent d'oublier le
 * job (`ON DELETE SET NULL`) : `llm_calls` — donc le COÛT déjà dépensé reste
 * compté, ce qui est voulu, une facture ne s'annule pas en effaçant sa
 * ligne — `chat_messages`, `cli_runs`, `tasks`, `verification_runs`,
 * `code_projects.registered_job_id`.
 *
 * **Un run VIVANT ne se supprime pas.** Il écrit encore : le runner le relit
 * pour reprendre, et le retirer sous ses pieds ferait échouer une reprise au
 * lieu de dire non. La liste le montre déjà — case désactivée — et la règle est
 * REFAITE ici, parce qu'un écran n'est pas une garde.
 *
 * **Ce qui revient est une LISTE D'IDENTIFIANTS, pas un compte** (Reviewer C,
 * passe 1 de la PR #185). L'écran retirait toutes les lignes cochées et
 * annonçait à côté « 1 run was left » : la ligne refusée disparaissait quand
 * même, et `router.refresh()` ne la ramenait pas — la liste garde son état
 * jusqu'à un rechargement complet. Deux chiffres ne disent pas QUI ; deux
 * listes, si.
 */
export async function deleteExternalRunsAction(
  ids: readonly string[],
): Promise<ActionResult<{ deletedIds: string[]; skippedLiveIds: string[] }>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const parsed = z.array(z.string().guid()).min(1).max(EXTERNAL_RUNS_DELETE_MAX).safeParse(ids);
    if (!parsed.success) return fail('validation_failed', 'Invalid run ids');
    const db = getDb();

    // Les racines DEMANDÉES qui sont vraiment des runs de dehors DE CETTE
    // ENTITÉ. Une ligne absente d'ici — un job d'un autre espace, un délégué,
    // un tour de chat — n'est pas refusée une par une : elle n'entre
    // simplement jamais dans ce qui suit.
    const racines = await db
      .select({ id: agentJobs.id, status: agentJobs.status })
      .from(agentJobs)
      .where(and(runsFromOutside(session.entityId), inArray(agentJobs.id, parsed.data)));

    // LA MÊME règle que la case de l'écran, pas une seconde : `runIsDeletable`
    // (lib/external-runs.ts) est lue des deux côtés.
    const supprimables = racines.filter((r) => runIsDeletable(r.status)).map((r) => r.id);
    const skippedLiveIds = racines.filter((r) => !runIsDeletable(r.status)).map((r) => r.id);
    if (supprimables.length === 0) return ok({ deletedIds: [], skippedLiveIds });

    // ─── UNE SEULE TRANSACTION : marche, vérification, suppression ──────────
    //
    // Les trois gestes étaient trois allers-retours séparés (Reviewer C, passe
    // 2). Entre la vérification et le `DELETE`, un délégué inséré par le runner
    // survivait en orphelin — exactement ce que cette action prétend empêcher.
    //
    // CE QUE LA TRANSACTION FERME. La marche et la vérification lisent le MÊME
    // état, et la suppression est tout ou rien : plus de demi-suppression où
    // les racines partent pendant qu'une descendance lue avant reste. Une
    // erreur en cours de route ne laisse rien derrière elle.
    //
    // CE QU'ELLE NE FERME PAS, et il faut le dire. En `READ COMMITTED` — le
    // niveau par défaut — chaque instruction prend son propre instantané : un
    // délégué dont l'insertion est validée APRÈS l'instantané du `DELETE`
    // devient orphelin, transaction ou pas. La fenêtre passe de trois
    // allers-retours à l'intérieur d'une instruction, elle ne disparaît pas.
    // Seule une clé étrangère sur `parent_job_id` la fermerait vraiment, et la
    // vraie base n'en a pas (migration 0000) ; la poser est un sujet à part, qui
    // touche toutes les écritures de jobs. C'est nommé ici plutôt que promis
    // ailleurs (invariant #4).
    const issue = await db.transaction(async (tx) => {
      const descendants = await collectDescendants(tx, session.entityId, supprimables);
      const aSupprimer = [...supprimables, ...descendants.map((d) => d.id)];

      // AUCUN ORPHELIN, et on le VÉRIFIE plutôt que de faire confiance à une
      // borne (Reviewer C, passe 1). `collectDescendants` s'arrête à
      // `ROLLUP_MAX_DEPTH` niveaux : sur une chaîne plus profonde — une base
      // abîmée, un import — elle rendrait une descendance incomplète, et le
      // `DELETE` laisserait des délégués que plus aucun run ne porte. La
      // question se pose donc à la base, exactement : reste-t-il un enfant d'un
      // job qu'on s'apprête à supprimer, hors de la liste ?
      const orphelins = await tx
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.entityId, session.entityId),
            inArray(agentJobs.parentJobId, aSupprimer),
            notInArray(agentJobs.id, aSupprimer),
          ),
        )
        .limit(1);
      if (orphelins.length > 0) {
        console.error(
          `[deleteExternalRunsAction] delegation chain deeper than ${ROLLUP_MAX_DEPTH} levels — refusing to delete and leave orphans behind (first: ${orphelins[0]?.id})`,
        );
        // On REND le refus plutôt que de lever : une exception ferait un
        // `db_error` sans nom, et la personne lirait « impossible de
        // supprimer » au lieu de la raison. Rien n'a été écrit, il n'y a donc
        // rien à annuler.
        return { refuse: true as const };
      }

      // UNE seule instruction, racines et descendants ensemble. Le SQL en ligne
      // des tests de base donne à `parent_job_id` une clé étrangère que la
      // vraie base n'a pas ; en un seul `DELETE`, la vérification tombe en fin
      // d'instruction et les deux côtés s'accordent.
      const parties = await tx
        .delete(agentJobs)
        .where(and(eq(agentJobs.entityId, session.entityId), inArray(agentJobs.id, aSupprimer)))
        .returning({ id: agentJobs.id });
      return { refuse: false as const, parties };
    });

    if (issue.refuse) {
      return fail(
        'chain_too_deep',
        'These runs delegate deeper than this screen can follow. Nothing was deleted.',
      );
    }
    const parties = issue.parties;

    revalidatePath('/chat');
    // Les RACINES réellement parties, nommées une par une : c'est ce que
    // l'écran retire de sa liste, et lui seul sait quelles lignes il affiche.
    const partiesSet = new Set(parties.map((r) => r.id));
    return ok({
      deletedIds: supprimables.filter((id) => partiesSet.has(id)),
      skippedLiveIds,
    });
  } catch (err) {
    console.error('[deleteExternalRunsAction]', err);
    return fail('db_error', 'Failed to delete the runs');
  }
}

/**
 * Le NOM de chaque chat de canal — la personne ou le salon à l'autre bout.
 *
 * Clé `<canal>:<chatId>`, la même que `chatKey` (lib/chat-list.ts). La source
 * est l'allowlist d'approbation : elle porte `requester_name`, déclaré par qui
 * a demandé l'accès. Telegram vit encore dans sa table historique
 * (`telegram_allowed_chats`), les autres canaux dans
 * `channel_allowed_conversations` — deux requêtes, jamais une par ligne.
 *
 * Un chat sans nom rend `null` plutôt que d'être absent : c'est le cas du
 * PROPRIÉTAIRE, qui a branché le bot lui-même et que personne n'a « demandé ».
 * L'écran montre alors l'identifiant, qui est au moins vrai.
 */
export async function listChatNamesAction(): Promise<ActionResult<ChatIdentities>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const db = getDb();

    const agentIds = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.entityId, session.entityId));
    if (agentIds.length === 0) return ok({});
    const ids = agentIds.map((a) => a.id);

    const [telegram, others] = await Promise.all([
      db
        .select({
          chatId: telegramAllowedChats.chatId,
          name: telegramAllowedChats.requesterName,
        })
        .from(telegramAllowedChats)
        .where(inArray(telegramAllowedChats.agentId, ids)),
      db
        .select({
          channel: channelAllowedConversations.channel,
          chatId: channelAllowedConversations.conversationId,
          name: channelAllowedConversations.requesterName,
          kind: channelAllowedConversations.kind,
        })
        .from(channelAllowedConversations)
        .where(inArray(channelAllowedConversations.agentId, ids)),
    ]);

    const names: Record<string, { name: string | null; kind: string | null }> = {};
    // Telegram n'a pas de colonne `kind` : la convention de l'API Bot veut
    // qu'un identifiant négatif soit un groupe, un positif un privé.
    for (const r of telegram) {
      names[`telegram:${r.chatId}`] = {
        name: r.name,
        kind: r.chatId.startsWith('-') ? 'group' : 'private',
      };
    }
    // Les lignes channel-neutres passent APRÈS : quand un chat Telegram existe
    // des deux côtés (migration en cours), la table historique reste la source.
    for (const r of others) {
      const key = `${r.channel}:${r.chatId}`;
      if (!(key in names)) names[key] = { name: r.name, kind: r.kind };
    }
    return ok(names);
  } catch (err) {
    console.error('[listChatNamesAction]', err);
    return fail('db_error', 'Failed to load chat names');
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
        agentAvatarUrl: agents.avatarUrl,
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
        // N + 1 : la ligne en trop ne sert qu'à SAVOIR s'il y en avait plus.
        .limit(MESSAGES_MAX + 1),
      db
        .select({
          job: agentJobs,
          agentName: agents.name,
          agentSlug: agents.slug,
          agentAvatarUrl: agents.avatarUrl,
        })
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
        .limit(HEAD_JOBS_MAX + 1),
    ]);
    // On a lu N + 1 pour n'en garder que N : la ligne en trop PROUVE la
    // troncature, sans requête de comptage. Le plafond atteint tout juste ne
    // ment plus — un fil de exactement 500 tours n'annonce plus un début
    // manquant qui n'existe pas (revue passe 30, doute 5).
    const truncated = {
      messages: recentMessages.length > MESSAGES_MAX,
      jobs: recentHeads.length > HEAD_JOBS_MAX,
    };
    const messageRows = [...recentMessages.slice(0, MESSAGES_MAX)].reverse();
    const headRows = [...recentHeads.slice(0, HEAD_JOBS_MAX)].reverse();

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
        headRows.map((r) => ({
          job: r.job,
          agentName: r.agentName,
          agentSlug: r.agentSlug,
          agentAvatarUrl: r.agentAvatarUrl,
        })),
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
    //
    // La CARTE est masquée en entrant ici (#150) : l'encart « Produced » nomme
    // les fichiers et les envois qu'elle porte, et c'est un troisième chemin de
    // lecture des mêmes lignes. Le masquage ne change que des chaînes de forme
    // credential : la carte, son étiquette et ses comptes traversent intacts,
    // donc le classement chat/travail rend le même verdict.
    //
    // Le masquage a un effet de bord sur le COMPTE (#161) : deux fichiers dont
    // les chemins ne diffèrent que par une chaîne de forme credential masquent
    // vers le même chemin. Les chemins d'AVANT masquage partent donc avec la
    // ligne, pour la seule identité des fichiers dans le récapitulatif ; ils ne
    // s'affichent nulle part, seule la carte masquée va jusqu'à l'écran.
    const rowsByRoot = new Map<
      string,
      Array<(typeof classifiableRows)[number] & { rawFilePaths?: readonly string[] }>
    >();
    for (const row of classifiableRows) {
      const root = row.jobId !== null ? rootOf.get(row.jobId) : undefined;
      if (root === undefined) continue;
      // La validation Zod ne tourne que sur une charge qui se DIT `files` :
      // seule cette carte porte des chemins, et valider toutes les autres pour
      // jeter le résultat coûtait sur chaque ligne du fil (revue C, C2). Une
      // charge qui ment sur son `card` est rejetée par `parsePresented` comme
      // avant, et repart donc sans chemins bruts.
      const diteFiles =
        row.presented !== null &&
        typeof row.presented === 'object' &&
        (row.presented as { card?: unknown }).card === 'files';
      const brut = diteFiles ? parsePresented(row.presented) : null;
      const bucket = rowsByRoot.get(root) ?? [];
      bucket.push({
        ...row,
        presented: redactPresented(row.presented),
        rawFilePaths:
          brut !== null && brut.card === 'files' ? brut.files.map((f) => f.path) : undefined,
      });
      rowsByRoot.set(root, bucket);
    }

    // Les appels LLM du fil : ceux de ses TRAVAUX, et ceux de la conversation
    // elle-même (`source = 'chat'`, sans job — migration 0100). Hors du bloc
    // ci-dessous, qui ne tourne que s'il y a au moins un job : une conversation
    // du tableau de bord n'en a aucun, et TOUS ses compteurs étaient sautés
    // d'un coup — « 0 agents, 0 tokens, n/a » sous une vraie réponse (Quentin,
    // 07/09).
    const costRows = await db
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
        and(
          eq(llmCalls.entityId, session.entityId),
          relevantIds.length === 0
            ? eq(llmCalls.conversationId, id)
            : or(inArray(llmCalls.jobId, relevantIds), eq(llmCalls.conversationId, id)),
        ),
      );

    // P3/P4 — la preuve et la file d'envoi de TOUT le fil : les jobs de tête et
    // leurs délégués, jamais le réglage courant.
    const [verificationRunRows, unconfiguredRows, deliveryRows, approvalRows] =
      relevantIds.length === 0
        ? [[], [], [], []]
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
                jobId: jobDeliverableVerificationState.jobId,
                deliverableType: jobDeliverableVerificationState.deliverableType,
                canonicalKey: jobDeliverableVerificationState.canonicalKey,
                displayPath: jobDeliverableVerificationState.displayPathSnapshot,
                decisionStatus: jobDeliverableVerificationState.decisionStatus,
                addressed: jobDeliverableVerificationState.addressed,
              })
              .from(jobDeliverableVerificationState)
              .where(
                and(
                  inArray(jobDeliverableVerificationState.jobId, relevantIds),
                  // Deux lectures dans une seule requête. La section de preuve
                  // (P3) ne veut que les livrables NON configurés ; la carte
                  // d'un classeur écrit (P12) veut l'état de TOUS les
                  // documents du fil, `dirty` et `green` compris — sans quoi
                  // elle ne saurait dire que « pas de vérification », même
                  // quand la base sait mieux.
                  or(
                    inArray(jobDeliverableVerificationState.decisionStatus, [
                      'not_configured',
                      'pending_approval',
                    ]),
                    inArray(jobDeliverableVerificationState.deliverableType, [
                      ...FILE_DELIVERABLE_TYPES,
                    ]),
                  ),
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

    const conversationRef = { channel: conv.channel, chatId: conv.chatId };
    // Les racines des dossiers de travail : le récapitulatif ramène les chemins
    // absolus des cartes au relatif avant de compter les fichiers (passe 57).
    const workspaceRoots = await entityWorkspaceRoots(db, session.entityId);
    // P2bis — la preuve rangée SOUS le job de tête, comme les lignes d'audit :
    // un délégué qui fait tourner les tests les fait tourner POUR le travail
    // qui l'a mandaté, et c'est le récapitulatif de ce travail-là qui doit les
    // montrer. Une ligne dont le job n'appartient pas au fil est ignorée.
    const proofByRoot = new Map<string, ThreadProofRun[]>();
    for (const row of verificationRunRows) {
      const root = row.jobId !== null ? rootOf.get(row.jobId) : undefined;
      if (root === undefined) continue;
      const bucket = proofByRoot.get(root) ?? [];
      bucket.push({ command: row.command, verdict: row.verdict });
      proofByRoot.set(root, bucket);
    }

    const jobs: ThreadJob[] = headRows.map((r, i) => ({
      jobId: r.job.id,
      feed: assembled[i]!.feed,
      createdAt: r.job.createdAt,
      completedAt: r.job.completedAt,
      result: r.job.result,
      verdict: classifyProduction({
        conversation: conversationRef,
        rows: rowsByRoot.get(r.job.id) ?? [],
      }),
      project: r.job.projectId !== null ? (projectById.get(r.job.projectId) ?? null) : null,
      proof: proofByRoot.get(r.job.id) ?? [],
      // Les lignes d'audit de la tête ET de toute sa descendance, déjà
      // rangées sous la tête pour la frontière chat/travail : le récapitulatif
      // y compte fichiers et lignes en entier (revue Codex, passe 56).
      audit: (rowsByRoot.get(r.job.id) ?? []).map((row) => ({
        toolName: row.toolName,
        toolInput: row.toolInput,
        toolOutput: row.toolOutput,
        presented: row.presented,
        rawFilePaths: row.rawFilePaths,
      })),
      workspaceRoots,
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
        agentAvatarUrl: conv.agentAvatarUrl,
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
        agentAvatarUrl: conv.agentAvatarUrl,
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
        // La requête ci-dessus ramène DEUX choses ; la section de preuve ne
        // garde que les livrables réellement non configurés — un document
        // `dirty` ou `green` n'est pas un trou de configuration.
        unconfigured: unconfiguredRows
          .filter(
            (r) =>
              // ADRESSÉ seulement : le périmètre large d'un shell est une garde,
              // pas une liste de livrables. Sans ce filtre, une application de
              // recettes s'affichait avec vingt livrables non vérifiés, dont
              // `shared/_archive` et `waterapp-animation-qwen3.827b` (08/09/2026).
              r.addressed &&
              (r.decisionStatus === 'not_configured' || r.decisionStatus === 'pending_approval'),
          )
          .map(
            (r): VerificationUnconfiguredView => ({
              deliverableType: r.deliverableType,
              canonicalKey: r.canonicalKey,
              displayPath: r.displayPath,
              reason:
                r.decisionStatus === 'pending_approval' ? 'pending_approval' : 'not_configured',
            }),
          ),
        // P12 — l'état de vérification de chaque DOCUMENT du fil, rangé par sa
        // clé canonique, tel que la base le porte. La carte d'un classeur écrit
        // le lit ; une clé absente ne dit rien du tout (invariant #4).
        deliverables: deliverableStatuses(unconfiguredRows),
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
