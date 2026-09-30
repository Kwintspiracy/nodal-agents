// channels/turn.ts — ce que devient un message AUTORISÉ d'un canal : un tour de
// sa conversation (un job), un message remis au travail qui y tourne déjà
// (#531), ou la commande `/stop`, que la plateforme traite elle-même (#602).
//
// UN TRAVAIL DE TÊTE PAR CONVERSATION (#531). Chaque message insérait sa tête :
// une précision envoyée pendant que la première demande tournait (« et mets-le
// dans le dossier partagé ») relançait tout le travail. Le choix entre
// « démarrer » et « remettre » est `deliverOrStartTurn` (@nodal-agents/db), le
// point de décision que le chat web appelle aussi : tant qu'une tête du fil vit
// — en cours, en attente d'une approbation ou d'une délégation, pas encore
// prise —, le message va dans sa file, que la boucle lit à son prochain tour.
// `/stop` et `/new` restent les sorties immédiates : l'un arrête tout (file
// comprise), l'autre ouvre un fil neuf où rien ne vit.
//
// UN endroit pour les quatre canaux. Telegram, Discord, Slack et WhatsApp
// portaient chacun leur copie de la même fin de parcours (`/new`, préfixe de
// groupe, conversation, insertion du job, titrage) ; une commande de plus
// aurait été quatre branches de plus. Chaque handler garde ce qui est à lui
// (autorisation, filtre de groupe, mention, `/ask`, média) et remet ici le
// texte TAPÉ, ce qui reste une fois la mention retirée et le routage fait.
//
// POURQUOI `/stop` N'EST PAS UN TOUR. Le 28/09, trois « Arrête !!! » sur
// Telegram ont chacun créé un job neuf, qui répondait « rien ne tourne »
// pendant qu'un délégué continuait deux heures. #575 a donné au job de tête les
// outils pour voir et arrêter les runs de sa conversation, mais c'est au modèle
// de choisir de les appeler : un modèle dégénéré ne le fait pas, et un job
// Claude Code ou Codex n'a aucun outil Nodal. L'arrêt ne dépend donc d'aucun
// modèle : `/stop` arrête tous les runs vivants de la conversation par
// `stopConversationRuns` — la définition des runs que les outils de #575
// lisent, et la cascade du bouton Stop du web (`cancelJobTree`) — et ne crée
// aucun job.
//
// Le runner n'écrit AUCUN texte en retour (invariant #2) : le handler rend ce
// qui a été arrêté, et l'appelant de chaque canal le dit par une réaction sur
// le message `/stop` quand son SDK en offre une (`stopReaction`).

import {
  agentJobs,
  and,
  attachToInboxEntry,
  deliverOrStartTurn,
  eq,
  releaseInboxEntry,
  stopConversationRuns,
} from '@nodal-agents/db';
import type { InboxContent } from '@nodal-agents/shared';
import type { StoppedRun } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import {
  findCurrentConversation,
  NEW_CONVERSATION_COMMAND,
  openNewConversation,
  parseNewConversationCommand,
  resolveConversation,
  touchConversation,
} from '../job/conversation-id.ts';

/** La commande qui arrête tout ce qui tourne dans la conversation. */
export const STOP_COMMAND = '/stop';

/**
 * Les commandes de la plateforme, telles qu'un canal qui a un menu de commandes
 * les y inscrit (Telegram `setMyCommands`). Le libellé est du chrome de canal,
 * comme le bouton d'une carte d'approbation : ce n'est pas l'agent qui parle.
 */
export const PLATFORM_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: STOP_COMMAND.slice(1), description: 'Stop everything running in this conversation' },
  { command: NEW_CONVERSATION_COMMAND.slice(1), description: 'Start a new conversation' },
];

/**
 * Ce message est-il la commande `/stop` ?
 *
 * La commande SEULE (après trim, casse ignorée : un clavier de téléphone met la
 * majuscule), ou suffixée du nom du bot qui la reçoit — `/stop@nom_du_bot`,
 * la forme que le menu de commandes de Telegram envoie dans un groupe. Adressée
 * à un AUTRE bot, elle n'est pas pour celui-ci. « /stop la musique » est une
 * phrase pour l'agent, pas la commande.
 */
export function parseStopCommand(text: string, botHandle: string | null): boolean {
  const m = /^\/stop(?:@([A-Za-z0-9_]+))?$/i.exec(text.trim());
  if (!m) return false;
  const addressee = m[1];
  if (addressee === undefined) return true;
  return botHandle !== null && addressee.toLowerCase() === botHandle.toLowerCase();
}

/**
 * Une commande de la plateforme (`/new`, `/stop`) : dans un groupe, elle passe
 * le filtre sans que le bot ait à être mentionné, sinon elle n'est jamais
 * atteinte.
 */
export function isPlatformCommand(text: string, botHandle: string | null): boolean {
  return parseStopCommand(text, botHandle) || parseNewConversationCommand(text).opensNew;
}

/** Ce que `/stop` a fait, lu en base. */
export interface ChannelStopResult {
  /** La conversation courante du fil ; `null` quand le fil n'en a aucune (rien n'y a jamais tourné). */
  readonly conversationId: string | null;
  /** Les runs trouvés vivants et arrêtés, avec ce que chaque arrêt a changé. */
  readonly stopped: StoppedRun[];
  readonly alreadyFinished: string[];
}

/**
 * Où un média arrivé avec le message (téléchargé hors transaction) doit être
 * rattaché : le job que le message a démarré, ou son entrée dans la file de la
 * tête qui l'a reçu (#531).
 */
export type ChannelTurnTarget =
  | { readonly kind: 'job'; readonly jobId: string }
  | {
      readonly kind: 'inbox';
      readonly entityId: string;
      readonly headJobId: string;
      readonly entryId: string;
    };

export type ChannelTurn =
  | { readonly kind: 'job'; readonly jobId: string; readonly taskText: string }
  /**
   * Un travail de la conversation vivait : le message est dans sa file, aucun
   * job n'est né (#531). Le canal l'accuse par une réaction (`DELIVERED_REACTION`).
   */
  | {
      readonly kind: 'delivered';
      readonly headJobId: string;
      readonly entryId: string;
      readonly taskText: string;
    }
  | { readonly kind: 'stop'; readonly stop: ChannelStopResult };

/**
 * Le message autorisé `text` sur le fil `chatId` de `channel` devient un tour
 * de la conversation de `agentId` (un job `pending`), ou, si c'est `/stop`,
 * l'arrêt de tous les runs vivants de cette conversation.
 *
 * `agentId` est l'agent à qui le message va APRÈS le routage `/ask` : c'est à
 * son fil qu'appartient le tour, et c'est son fil que `/stop` arrête.
 *
 * `tx` est la transaction du handler : le verrou du fil (conversation-id.ts)
 * tient jusqu'à son COMMIT.
 */
export async function takeChannelTurn(args: {
  tx: RunnerDeps['db'];
  entityId: string;
  agentId: string;
  channel: string;
  chatId: string;
  /** Ce que la personne a tapé : mention retirée, `/ask` routé, AVANT le préfixe de groupe. */
  text: string;
  /** Le « qui parle » d'un message de groupe (`[Message from …]: `), ou `null`. */
  groupPrefix: string | null;
  /** Le nom du bot sur ce canal, pour `/stop@nom_du_bot` ; `null` quand le canal n'en a pas. */
  botHandle: string | null;
  /**
   * Le message porte un média que l'appelant téléchargera après la
   * transaction : remis à un travail en cours, il n'y sera lu qu'une fois ce
   * média attaché (`attachTurnContent`) ou abandonné (`releaseTurnContent`).
   */
  awaitsMedia: boolean;
}): Promise<ChannelTurn> {
  const { tx, entityId, agentId, channel, chatId, groupPrefix, botHandle } = args;
  const threadKey = { db: tx, entityId, agentId, channel, chatId };

  if (parseStopCommand(args.text, botHandle)) {
    // Lue SANS être créée : un `/stop` sur un fil neuf n'a rien à arrêter, et
    // ne doit pas y faire naître une conversation vide.
    const conversation = await findCurrentConversation(threadKey);
    if (!conversation) {
      return { kind: 'stop', stop: { conversationId: null, stopped: [], alreadyFinished: [] } };
    }
    const result = await stopConversationRuns(tx, {
      entityId,
      conversationId: conversation.id,
    });
    return { kind: 'stop', stop: { conversationId: conversation.id, ...result } };
  }

  let taskText = args.text;
  // `/new` s'analyse sur le texte que l'utilisateur a TAPÉ — après le retrait de
  // la mention et après le routage `/ask`, mais AVANT le préfixe de groupe.
  // Sinon la commande arrive derrière `[Message from …]: ` et n'est plus
  // reconnue : en groupe, `/new` ne rouvrait rien (revue Codex, passe 28).
  //
  // Un `/new` NU garde `/new` comme tâche : c'est le message de l'utilisateur,
  // et le runner ne fabrique rien à sa place (invariant #2) — c'est le bloc
  // `## Conversation` du prompt qui dira au modèle ce que ça veut dire.
  const { opensNew, rest } = parseNewConversationCommand(taskText);
  if (opensNew && rest) taskText = rest;
  // Le préfixe enveloppe ce qui RESTE : en groupe, l'agent doit toujours savoir
  // qui parle, `/new` ou pas. Sauf pour un `/new` NU : la tâche reste
  // exactement `/new`, sans préfixe — c'est à ce texte que
  // `loadConversationContext` reconnaît la commande (`openedByCommand`).
  if (groupPrefix && !(opensNew && !rest)) taskText = groupPrefix + taskText;

  const conversation = opensNew
    ? await openNewConversation(threadKey)
    : await resolveConversation(threadKey);

  // UN travail de tête par conversation (#531) : si une tête de ce fil vit
  // encore, le message va dans sa file au lieu de démarrer un second job qui
  // referait la même demande. `/new` ouvre une conversation neuve, où rien ne
  // vit : il démarre toujours. Le point de décision est celui du chat web.
  const turn = await deliverOrStartTurn(tx, {
    entityId,
    conversationId: conversation.id,
    // Texte seul ici ; un média entrant est attaché ensuite par l'appelant du
    // canal, hors transaction, à la cible que ce tour rend.
    message: { task: taskText, content: taskText, preparing: args.awaitsMedia },
    start: {
      entityId,
      agentId,
      channel,
      task: taskText,
      chatId,
      conversationId: conversation.id,
      // Le projet courant du fil suit le travail : un job né dans une
      // conversation ancrée à un projet porte ce projet dès l'insert.
      projectId: conversation.currentProjectId,
      status: 'pending',
      messages: [{ role: 'user', content: taskText }],
    },
  });

  // La conversation est vivante, et elle prend son nom sur le premier message.
  await touchConversation(tx, conversation.id, taskText);

  if (turn.kind === 'delivered') {
    return {
      kind: 'delivered',
      headJobId: turn.headJobId,
      entryId: turn.entryId,
      taskText,
    };
  }
  return { kind: 'job', jobId: turn.jobId, taskText };
}

/** La cible d'un média arrivé avec ce tour, ou `null` pour `/stop`. */
export function channelTurnTarget(turn: ChannelTurn, entityId: string): ChannelTurnTarget | null {
  if (turn.kind === 'job') return { kind: 'job', jobId: turn.jobId };
  if (turn.kind === 'delivered') {
    return { kind: 'inbox', entityId, headJobId: turn.headJobId, entryId: turn.entryId };
  }
  return null;
}

/**
 * Rattache le contenu complet d'un message (texte et image) à sa cible, une
 * fois le média téléchargé : le premier message d'un job encore `pending`, ou
 * l'entrée de la file où il attend. Rend `false` quand la cible a déjà avancé
 * (job pris, entrée vidée) : l'appelant le dit dans son journal (G1).
 */
export async function attachTurnContent(
  db: RunnerDeps['db'],
  target: ChannelTurnTarget,
  content: InboxContent,
): Promise<boolean> {
  if (target.kind === 'inbox') {
    // L'entrée est cherchée par son id, où qu'elle attende : si la tête a fini
    // pendant le téléchargement, le déclencheur l'a portée dans la file de la
    // tête relancée.
    return attachToInboxEntry(db, {
      entityId: target.entityId,
      entryId: target.entryId,
      content,
    });
  }
  const attached = await db
    .update(agentJobs)
    .set({ messages: [{ role: 'user', content }] })
    .where(and(eq(agentJobs.id, target.jobId), eq(agentJobs.status, 'pending')))
    .returning({ id: agentJobs.id });
  return attached.length > 0;
}

/**
 * Le téléchargement du média a échoué : le message remis devient lisible tel
 * qu'il est, texte seul, sans attendre `INBOX_MEDIA_WAIT_MS`. Rien à faire pour
 * un job neuf : son worker n'est réveillé qu'après la tentative.
 */
export async function releaseTurnContent(
  db: RunnerDeps['db'],
  target: ChannelTurnTarget,
): Promise<void> {
  if (target.kind !== 'inbox') return;
  await releaseInboxEntry(db, { entityId: target.entityId, entryId: target.entryId });
}

/**
 * Télécharge le média d'un tour : si le téléchargement échoue, le message remis
 * est libéré (`releaseTurnContent`) avant que l'erreur remonte — il ne reste
 * pas retenu jusqu'à `INBOX_MEDIA_WAIT_MS`. Le seul chemin des canaux qui
 * attachent un média (Telegram, Discord).
 */
export async function downloadTurnMedia<T>(
  db: RunnerDeps['db'],
  target: ChannelTurnTarget,
  download: () => Promise<T>,
): Promise<T> {
  try {
    return await download();
  } catch (err) {
    await releaseTurnContent(db, target).catch((releaseErr: unknown) =>
      console.warn(
        `[channel] releasing the waiting message ${turnMediaFileStem(target)} failed: ${
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
        }`,
      ),
    );
    throw err;
  }
}

/**
 * Le nom de fichier d'un média entrant : il COMMENCE par l'id du job qui le
 * lira (la tête, pour un message en file), c'est par là que l'élagage d'un
 * dossier de canal sait s'il sert encore (`pruneTelegramWorkspace`).
 */
export function turnMediaFileStem(target: ChannelTurnTarget): string {
  return target.kind === 'job' ? target.jobId : `${target.headJobId}.${target.entryId}`;
}

/**
 * La réaction qui accuse réception d'un `/stop`, en emoji Unicode — le runner
 * n'écrit aucun texte (invariant #2). Deux faits distincts, parce que la
 * personne a besoin de savoir lequel est vrai : « arrêté » (au moins un run
 * vivait et ne vit plus) et « rien ne tournait ». Réagir aussi dans le second
 * cas dit que la commande a été reçue et lue : un silence ne se distingue pas
 * d'un bot hors ligne. Les deux emojis sont dans la liste restreinte des
 * réactions que Telegram accepte d'un bot.
 */
export function stopReaction(stop: ChannelStopResult): '👌' | '🤷' {
  return stop.stopped.length > 0 ? '👌' : '🤷';
}

/**
 * La réaction qui accuse réception d'un message remis au travail en cours
 * (#531) : il a été reçu, et c'est le travail en cours qui le lira. Aucun texte
 * du runner (invariant #2). Dans la liste restreinte de Telegram.
 */
export const DELIVERED_REACTION = '👀';

/** La réaction d'un tour de canal, quand il en appelle une. */
export function channelTurnReaction(result: {
  stop?: ChannelStopResult;
  delivered?: unknown;
}): '👌' | '🤷' | typeof DELIVERED_REACTION | null {
  if (result.stop) return stopReaction(result.stop);
  if (result.delivered) return DELIVERED_REACTION;
  return null;
}
