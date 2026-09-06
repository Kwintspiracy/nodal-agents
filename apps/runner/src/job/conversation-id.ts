// conversation-id.ts — l'IDENTITÉ d'un fil de discussion (plan « De la maquette
// au produit », P6).
//
// CE QUI A CHANGÉ, ET POURQUOI. Jusqu'ici ce fichier ne faisait que frapper un
// uuid : « le job précédent de ce chat a-t-il été livré il y a moins de 4 h ?
// alors même uuid, sinon un neuf ». Le SILENCE décidait donc l'identité du fil.
// Deux conséquences que personne n'a demandées : répondre le lendemain à un
// agent ouvrait une conversation neuve sans que l'utilisateur ait rien fait, et
// une conversation ne pouvait porter aucun état durable — il n'y avait aucune
// ligne où l'écrire.
//
// P6 pose l'autre règle : UNE CONVERSATION PAR CHAT, qui dure jusqu'à ce que
// l'utilisateur en ouvre une autre — `/new` dans un canal, le « + » du
// dashboard. C'est un geste, pas une horloge. Le silence survit uniquement
// comme BUDGET DE RELECTURE (thread-history.ts) : combien de tours on redonne
// au modèle, ce qui n'a jamais rien eu à voir avec l'endroit où le fil commence.
//
// Chaque conversation a désormais une ligne `conversations` (migration 0094),
// tous canaux confondus, et cette ligne porte le PROJET COURANT du fil.
//
// INVARIANT #2 : rien ici ne fabrique de texte destiné à l'utilisateur. `/new`
// nu reste la tâche `/new` — c'est le message de l'utilisateur, et c'est le bloc
// `## Conversation` du prompt qui dit au modèle que c'est le premier tour.

import { basename } from 'node:path/posix';
import { eq, and, sql, desc, count, isNull, isNotNull, ne } from '@nodal-agents/db';
import { agentJobs, conversations, chatMessages, codeProjects } from '@nodal-agents/db';
import { stripGroupPrefix } from '@nodal-agents/shared';
import { REGISTERED_PROJECTS_IN_PROMPT } from '@nodal-agents/orchestration';
import type { ConversationContext } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../deps.ts';

/** Une conversation, réduite à ce que l'insertion d'un job en demande. */
export interface ConversationRef {
  readonly id: string;
  /** Le projet courant du fil — recopié sur le job à l'insert. */
  readonly currentProjectId: string | null;
}

/** Le fil, tel que le canal le désigne. */
export interface ThreadKey {
  db: RunnerDeps['db'];
  entityId: string;
  agentId: string;
  /** Le canal : `telegram`, `slack`, `discord`, `whatsapp`. */
  channel: string;
  /** L'identifiant du fil SUR le canal (chat Telegram, canal Slack, ...). */
  chatId: string;
}

/**
 * Même règle de titre que le chat du dashboard (run-chat-turn.ts) — 60
 * caractères, ellipse visible au-delà.
 */
const TITLE_MAX = 60;

/** La commande qui ouvre une conversation neuve depuis un canal. */
export const NEW_CONVERSATION_COMMAND = '/new';

/**
 * Est-ce que ce message ouvre une nouvelle conversation, et que reste-t-il
 * comme tâche ?
 *
 * `/new` exact (après trim) ou le PRÉFIXE `/new ` — jamais `/newer`, jamais un
 * `/new` au milieu d'une phrase. La frontière est un espace, pas un
 * `startsWith('/new')` : sans elle, « /newsletter du mois » ouvrirait un fil.
 */
export function parseNewConversationCommand(text: string): { opensNew: boolean; rest: string } {
  const trimmed = text.trim();
  if (trimmed === NEW_CONVERSATION_COMMAND) return { opensNew: true, rest: '' };
  if (trimmed.startsWith(`${NEW_CONVERSATION_COMMAND} `)) {
    return { opensNew: true, rest: trimmed.slice(NEW_CONVERSATION_COMMAND.length).trim() };
  }
  return { opensNew: false, rest: trimmed };
}

/**
 * La conversation en cours sur ce fil, ou une neuve si le fil n'en a aucune.
 *
 * La plus RÉCENTE par `created_at` — jamais par `updated_at` : un `/new` insère
 * une ligne neuve dont l'ancienne pourrait encore avoir un `updated_at` plus
 * grand si un job tardif de l'ancienne l'a touchée après coup. L'ordre de
 * NAISSANCE est le seul qui dise laquelle est ouverte. `id` départage à
 * `created_at` égal : deux `/new` en rafale, ou un backfill qui pose la même
 * date sur plusieurs lignes, laissaient sinon la conversation courante
 * INDÉTERMINÉE — le fil pouvait changer d'un message à l'autre sans que
 * personne n'ait rien fait (revue Codex, passe 28).
 *
 * SÉRIALISÉ par un verrou consultatif sur le tuple du fil. Sans lui, deux
 * messages arrivés ensemble constatent tous deux l'absence de ligne et en
 * créent chacun une : deux conversations naissent sans qu'aucun `/new` n'ait
 * été tapé, et les deux jobs partent dans des fils différents. L'index du tuple
 * n'est pas unique et ne peut pas l'être — `/new` existe précisément pour poser
 * une deuxième ligne sur le même tuple.
 *
 * Le verrou est XACT : il tient jusqu'au COMMIT de la transaction appelante.
 * Les quatre handlers passent leur `tx`, donc il couvre bien la lecture ET
 * l'insertion. Appelé HORS transaction, il se relâche immédiatement après
 * l'instruction et ne protège rien — c'est acceptable pour les appelants qui
 * n'ont pas de course (un tour de chat déjà rattaché à sa ligne), jamais pour
 * un handler entrant.
 */
export async function resolveConversation(k: ThreadKey): Promise<ConversationRef> {
  const threadLockKey = `${k.entityId}:${k.agentId}:${k.channel}:${k.chatId}`;
  await k.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${threadLockKey}))`);

  const [existing] = await k.db
    .select({ id: conversations.id, currentProjectId: conversations.currentProjectId })
    .from(conversations)
    .where(
      and(
        eq(conversations.entityId, k.entityId),
        eq(conversations.agentId, k.agentId),
        eq(conversations.channel, k.channel),
        eq(conversations.chatId, k.chatId),
      ),
    )
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(1);
  if (existing) return { id: existing.id, currentProjectId: existing.currentProjectId };

  return openNewConversation(k);
}

/**
 * Ouvre une conversation NEUVE sur ce fil, quoi qu'il y ait avant.
 *
 * L'ancienne n'est ni fermée ni supprimée : elle reste lisible, avec ses jobs
 * qui gardent son id. Ouvrir un nouveau fil n'efface pas le précédent — c'est
 * la différence entre « je passe à autre chose » et « oublie tout ».
 *
 * Le projet courant ne s'hérite PAS : une conversation neuve part sans dossier,
 * et la première production qui atterrit quelque part le posera. Hériter
 * ferait dire au modèle « ton projet est X » sur un fil dont rien ne dit
 * encore qu'il parle de X.
 */
export async function openNewConversation(k: ThreadKey): Promise<ConversationRef> {
  const [row] = await k.db
    .insert(conversations)
    .values({
      entityId: k.entityId,
      agentId: k.agentId,
      // Le titre est posé par `touchConversation` sur le premier message : ici
      // on n'a pas encore la tâche sous la main.
      title: '',
      origin: 'user',
      channel: k.channel,
      chatId: k.chatId,
    })
    .returning({ id: conversations.id, currentProjectId: conversations.currentProjectId });
  if (!row) {
    // Un INSERT ... RETURNING qui ne rend rien n'a pas de repli honnête : le job
    // qui suit a besoin d'un id réel. Échouer fort (invariant #4).
    throw new Error('conversation_insert_failed');
  }
  return { id: row.id, currentProjectId: row.currentProjectId };
}

/**
 * Marque la conversation comme vivante, et la NOMME si elle ne l'est pas encore.
 *
 * Le titre est la première ligne de la première tâche — la même règle que le
 * chat du dashboard. Posé UNE SEULE FOIS : le `CASE` le fait en une instruction,
 * pour que deux messages arrivés ensemble ne se disputent pas le nom (une
 * lecture puis une écriture laisserait le second écraser le premier).
 *
 * Le préfixe de groupe (`[Message from Untel]: `) est retiré ICI, au titrage
 * seulement : la TÂCHE le garde — le modèle doit savoir qui parle — mais un
 * titre qui commence par les mêmes crochets pour tout un salon ne nomme plus
 * rien (revue Codex, passe 29, doute 1).
 */
export async function touchConversation(
  db: RunnerDeps['db'],
  id: string,
  firstTask: string,
): Promise<void> {
  const firstLine = stripGroupPrefix((firstTask.split('\n')[0] ?? '').trim());
  const title = firstLine.slice(0, TITLE_MAX) + (firstLine.length > TITLE_MAX ? '…' : '');
  await db
    .update(conversations)
    .set({
      updatedAt: new Date(),
      title: sql`CASE WHEN ${conversations.title} = '' THEN ${title} ELSE ${conversations.title} END`,
    })
    .where(eq(conversations.id, id));
}

/**
 * Ce que la conversation dit au modèle sur ce tour (bloc `## Conversation`).
 *
 * Rend `null` quand la ligne n'existe pas — un job d'avant P6 porte un uuid
 * qu'aucune ligne ne porte (voir le commentaire de `agent_jobs.conversation_id`
 * dans le schéma : pas de clé étrangère, délibérément). Le bloc est alors omis,
 * jamais rendu avec des zéros inventés.
 */
export async function loadConversationContext(
  db: RunnerDeps['db'],
  conversationId: string,
  opts: {
    excludeJobId?: string;
    /**
     * La tâche / le message du tour COURANT. Sert uniquement à reconnaître un
     * `/new` nu — le seul cas où le message de l'utilisateur ne porte aucune
     * demande. Absent ⇒ `openedByCommand` reste false.
     */
    task?: string | null;
  } = {},
): Promise<ConversationContext | null> {
  const [conv] = await db
    .select({
      id: conversations.id,
      entityId: conversations.entityId,
      channel: conversations.channel,
      projectId: codeProjects.id,
      projectPath: codeProjects.projectPath,
      projectDisplayName: codeProjects.displayName,
      projectKind: codeProjects.kind,
    })
    .from(conversations)
    .leftJoin(codeProjects, eq(conversations.currentProjectId, codeProjects.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return null;

  const priorTurns =
    conv.channel === 'dashboard'
      ? await countDashboardPriorTurns(db, conversationId)
      : await countChannelPriorTurns(db, conversationId, opts.excludeJobId);

  const currentProject =
    conv.projectId && conv.projectPath
      ? {
          // Le nom AFFICHÉ : celui que le propriétaire a choisi, sinon le nom du
          // dossier. `project_path` est toujours slash-normalisé, d'où le
          // basename POSIX.
          name: conv.projectDisplayName ?? basename(conv.projectPath),
          path: conv.projectPath,
          kind: (conv.projectKind === 'documents' ? 'documents' : 'code') as 'code' | 'documents',
        }
      : null;

  // `/new` NU, et sur le PREMIER tour seulement : ailleurs, un message qui
  // vaut `/new` est une coïncidence sans conséquence. `/new rédige le plan` ne
  // compte pas non plus — les handlers ont déjà remplacé la tâche par le reste,
  // et ce reste EST la demande.
  const openedByCommand = priorTurns === 0 && (opts.task ?? '').trim() === NEW_CONVERSATION_COMMAND;

  // P10b — les projets DÉCLARÉS de l'espace, chargés seulement quand le fil
  // n'en a pas encore un : ce sont les options de la question « où ranger ce
  // document ? ». Avec un projet courant, la question ne se pose plus, et la
  // requête serait payée pour rien à chaque tour.
  // `entity_id` est nullable en base : sans entité il n'y a pas de registre à
  // interroger — liste vide, jamais un scan de toute la table.
  const registeredProjects =
    currentProject || !conv.entityId ? [] : await listRegisteredProjects(db, conv.entityId);

  return {
    id: conv.id,
    priorTurns,
    openedByCommand,
    currentProject,
    ...(registeredProjects.length > 0 ? { registeredProjects } : {}),
  };
}

/**
 * Les projets DÉCLARÉS de cette entité — jamais les lignes de COMPTABILITÉ.
 *
 * `registered_at IS NOT NULL` est LE discriminant du registre (migration 0093,
 * voir le schéma) : une ligne posée par un renommage, un masquage ou une
 * intention de mutation n'est pas un projet qu'on peut proposer. Les projets
 * MASQUÉS sont exclus aussi — masquer les retire du bloc `## Runtime`, les
 * proposer ici les ramènerait par la fenêtre.
 *
 * Plafonné à ce que le prompt affiche : rendre plus ne servirait qu'à jeter.
 */
async function listRegisteredProjects(
  db: RunnerDeps['db'],
  entityId: string,
): Promise<Array<{ name: string; path: string; kind: 'code' | 'documents' }>> {
  const rows = await db
    .select({
      path: codeProjects.projectPath,
      displayName: codeProjects.displayName,
      kind: codeProjects.kind,
    })
    .from(codeProjects)
    .where(
      and(
        eq(codeProjects.entityId, entityId),
        isNotNull(codeProjects.registeredAt),
        eq(codeProjects.hidden, false),
      ),
    )
    .orderBy(desc(codeProjects.registeredAt))
    .limit(REGISTERED_PROJECTS_IN_PROMPT);
  return rows.map((r) => ({
    name: r.displayName ?? basename(r.path),
    path: r.path,
    kind: r.kind === 'documents' ? ('documents' as const) : ('code' as const),
  }));
}

/**
 * Les tours d'une conversation de CANAL sont ses jobs de TÊTE : un job enfant
 * (délégation, task-board) hérite du `conversation_id` de son créateur sans
 * jamais avoir été un message de l'utilisateur.
 */
async function countChannelPriorTurns(
  db: RunnerDeps['db'],
  conversationId: string,
  excludeJobId?: string,
): Promise<number> {
  const conditions = [
    eq(agentJobs.conversationId, conversationId),
    isNull(agentJobs.parentJobId),
    ...(excludeJobId ? [ne(agentJobs.id, excludeJobId)] : []),
  ];
  const [row] = await db
    .select({ n: count() })
    .from(agentJobs)
    .where(and(...conditions));
  return Number(row?.n ?? 0);
}

/**
 * Les tours d'une conversation du DASHBOARD sont ses messages `user`, MOINS UN :
 * ce contexte est chargé APRÈS l'insertion du tour courant (run-chat-turn.ts
 * nomme la conversation sur ce même insert), donc le message qu'on est en train
 * de traiter est déjà compté.
 */
async function countDashboardPriorTurns(
  db: RunnerDeps['db'],
  conversationId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, 'user')));
  return Math.max(0, Number(row?.n ?? 0) - 1);
}
