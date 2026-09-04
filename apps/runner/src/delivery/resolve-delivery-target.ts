// delivery/resolve-delivery-target.ts — WHERE a finished job's result goes.
//
// Plan « Vérifier & Corriger », « La livraison est une action sortante —
// outbox » : la ligne `job_deliveries` en `prepared` fige le couple
// (canal de transport, chat) AVANT la transaction terminale, pour que le drain
// n'ait plus à redériver une cible qui aurait pu changer entre la décision et
// l'envoi.
//
// Ce fichier n'invente rien : c'est l'EXTRACTION, à l'identique, de la
// résolution de cible aujourd'hui recopiée à deux endroits —
// `cron/deliver-results.ts` (le bloc « Actually DELIVER to the originating
// channel », listActiveChannelsForAgent + override notifyChannel du
// triggerContext cron/webhook + resolveTransportChannel) et
// `cli-runtime/run-job.ts` (le bloc « Channel delivery », qui fait la même
// chose SANS l'override). T10-T12 rebranchent ces deux appelants ici ; ce
// ticket (T08) ne les touche pas.
//
// Ce qui reste DEHORS, volontairement, et se fait au drain :
//   - `isConversationAllowed` — l'allowlist se revérifie juste avant l'envoi,
//     jamais à la préparation : entre les deux, un chat peut avoir été révoqué
//     (c'est le commentaire M4 de deliver-results.ts qui l'exige) ;
//   - `getBindingCredentials` — une credential ne traverse JAMAIS la table
//     `job_deliveries` (voir l'en-tête du schéma) ; elle est relue au moment
//     d'envoyer et jetée.
//
// Le refus est TYPÉ et rendu à l'appelant : pas de `null` muet, pas de
// livraison fantôme (inv. #4).

import { listActiveChannelsForAgent, resolveTransportChannel } from '@nodal-agents/delivery';
import type { ChannelKind } from '@nodal-agents/delivery';
import type { AnyDrizzleDb, JobTriggerContext } from '@nodal-agents/db';

/** Les seuls champs d'`agent_jobs` dont la résolution de cible a besoin. Un
 *  objet, pas un id : les deux appelants ont déjà la ligne en main. */
export interface DeliveryTargetJob {
  /** `agent_jobs.chat_id` — absent = aucune intention de livrer. */
  chatId: string | null;
  agentId: string | null;
  /** `agent_jobs.channel` : une ORIGINE (cron, webhook, dashboard, api…), pas
   *  un transport — d'où `resolveTransportChannel`. */
  channel: string | null;
  triggerContext: unknown;
}

export interface DeliveryTarget {
  channel: ChannelKind;
  chatId: string;
}

export type DeliveryTargetRefusal = {
  /**
   * `no_chat` : le job ne porte pas de chat (ou pas d'agent à qui attribuer
   * un transport) — il n'y a rien à livrer, ce n'est pas une panne.
   * `channel_inactive` : l'agent existe mais n'a AUCUN canal de transport
   * actif (ni token Telegram ni binding activé), donc aucun transport ne peut
   * porter ce résultat.
   */
  refused: 'no_chat' | 'channel_inactive';
};

export type DeliveryTargetOutcome = DeliveryTarget | DeliveryTargetRefusal;

/** Discriminant lisible à l'appel — `'refused' in outcome` marche aussi, mais
 *  cette garde nomme l'intention. */
export function isDeliveryRefusal(
  outcome: DeliveryTargetOutcome,
): outcome is DeliveryTargetRefusal {
  return 'refused' in outcome;
}

/**
 * Résout le canal de TRANSPORT et le chat sur lesquels le résultat d'un job
 * doit partir.
 *
 * Règle, identique à celle des deux appelants d'aujourd'hui :
 *   1. pas de `chatId` ou pas d'`agentId` ⇒ refus `no_chat` (le garde
 *      `rootJob.chatId && rootJob.agentId` de deliver-results.ts) ;
 *   2. un job d'origine cron/webhook dont le déclencheur a choisi un canal de
 *      notification EXPLICITE (`triggerContext.notifyChannel`) l'emporte sur
 *      l'ordre de priorité — c'est le canal contre lequel `chat_id` a été
 *      résolu (B1/B2 notify-channel-choice) ;
 *   3. sinon `resolveTransportChannel(job.channel, activeChannels)` : le
 *      canal du job s'il est déjà un transport, sinon le premier canal ACTIF
 *      de l'agent par ordre de priorité.
 *
 * Divergence assumée avec le code d'aujourd'hui, et la seule : quand l'agent
 * n'a aucun canal actif, `resolveTransportChannel` rend `'telegram'` par
 * défaut historique ; les deux appelants poursuivent alors jusqu'à
 * `getBindingCredentials`, qui rend `null`, et rien n'est envoyé — en silence.
 * Ici ce cas est refusé PAR SON NOM (`channel_inactive`) avant d'écrire une
 * ligne d'outbox, plutôt que d'inscrire une livraison qui ne peut pas aboutir
 * et de la faire échouer trois fois. Le résultat observable est le même (rien
 * n'est envoyé) ; ce qui change, c'est qu'il est dit.
 */
export async function resolveDeliveryTarget(
  db: AnyDrizzleDb,
  job: DeliveryTargetJob,
): Promise<DeliveryTargetOutcome> {
  const chatId = job.chatId?.trim() ?? '';
  if (chatId === '' || !job.agentId) return { refused: 'no_chat' };

  const activeChannels = await listActiveChannelsForAgent(db, job.agentId);

  const triggerContext = job.triggerContext as JobTriggerContext | null;
  const notifyChannelOverride: ChannelKind | undefined =
    triggerContext?.type === 'cron' || triggerContext?.type === 'webhook'
      ? (triggerContext.notifyChannel ?? undefined)
      : undefined;

  if (!notifyChannelOverride && activeChannels.length === 0) {
    return { refused: 'channel_inactive' };
  }

  const channel = notifyChannelOverride ?? resolveTransportChannel(job.channel, activeChannels);
  return { channel, chatId };
}
