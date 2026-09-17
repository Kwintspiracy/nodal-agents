// back-links.ts — où « Back to … » ramène, déduit de la DONNÉE, pas de
// l'historique du navigateur.
//
// Quentin, 17/09/2026 : « si je sélectionne un chat dans Discord, ça me met
// une flèche Back to channels qui ne me remet pas sur Discord ». Un fil sait
// d'où il vient (son canal), un run sait à quoi il appartient (sa conversation,
// ou son automation) : le retour se calcule, il n'a pas besoin d'un `?from=`
// qui se perdrait au premier lien copié.

import { folderHref, folderLabel, folderOfJobChannel } from './chat-folders.ts';

export type BackLink = { label: string; href: string };

/**
 * Un fil ramène dans SON dossier : un chat Discord dans « Discord », une
 * conversation du dashboard dans « Nodal chats ». Un canal qui n'a pas de
 * dossier (api, webhook…) ramène à la liste entière.
 */
export function threadBackLink(channel: string): BackLink {
  const key = folderOfJobChannel(channel);
  if (key === null) return { label: 'Back to channels', href: '/chat' };
  return { label: `Back to ${folderLabel(key)}`, href: folderHref(key) };
}

/**
 * Un run ramène là d'où on l'a ouvert, dans l'ordre de ce qu'il EST : une
 * automation revient aux routines ; un run d'une conversation revient à cette
 * conversation (c'est « Open run » qui y mène) ; le reste revient à Activity,
 * la liste des runs.
 */
export function runBackLink(job: { channel: string; conversationId: string | null }): BackLink {
  if (job.channel === 'cron') return { label: 'Back to Scheduled', href: '/scheduled' };
  if (job.conversationId !== null && job.conversationId !== '') {
    return { label: 'Back to the conversation', href: `/chat/${job.conversationId}` };
  }
  return { label: 'Back to Activity', href: '/logs' };
}
