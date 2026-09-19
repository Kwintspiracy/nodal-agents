// back-links.ts — où « Back to … » ramène, déduit de la DONNÉE, pas de
// l'historique du navigateur.
//
// Quentin, 17/09/2026 : « si je sélectionne un chat dans Discord, ça me met
// une flèche Back to channels qui ne me remet pas sur Discord ». Un fil sait
// d'où il vient (son canal), un run sait à quoi il appartient (sa conversation,
// ou son automation) : le retour se calcule, il n'a pas besoin d'un `?from=`
// qui se perdrait au premier lien copié.

import { folderHref, folderLabel, folderOfJobChannel, MCP_FOLDER } from './chat-folders.ts';

export type BackLink = { label: string; href: string };

/**
 * Un fil ramène dans SON dossier : un chat Discord dans « Discord », une
 * conversation du dashboard dans « Nodal chats ». Un canal qui n'a pas de
 * dossier (webhook, task-board…) ramène à la liste entière.
 *
 * Le dossier MCP est EXCLU, bien que `api` et `mcp` y mènent pour un run : il
 * liste des runs, pas des fils. Y renvoyer un fil le déposerait sur une liste
 * où il ne figure pas (invariant #4).
 */
export function threadBackLink(channel: string): BackLink {
  const key = folderOfJobChannel(channel);
  if (key === null || key === MCP_FOLDER) return { label: 'Back to channels', href: '/chat' };
  return { label: `Back to ${folderLabel(key)}`, href: folderHref(key) };
}

/**
 * Un run ramène là d'où on l'a ouvert, dans l'ordre de ce qu'il EST : un run
 * d'automatisation revient à SON automatisation ; un run d'une conversation
 * revient à cette conversation (c'est « Open run » qui y mène) ; un run venu de
 * dehors revient au dossier MCP, d'où on vient de le lister (18/09) ; le reste
 * revient à Activity, la liste des runs.
 *
 * Le cron ramenait à `/scheduled`, une page qui n'existe plus (#202) — Quentin,
 * 19/09 : « le bouton back me ramène à la page Scheduled, qui est censée ne
 * plus exister ». Il ramène maintenant à la page de l'automatisation, où ce run
 * est justement listé. Un run trop ancien pour porter cet id revient à la LISTE
 * des automatisations : on ne devine pas laquelle c'était.
 */
export function runBackLink(job: {
  channel: string;
  conversationId: string | null;
  /** L'automatisation qui a lancé ce run, quand elle est connue. */
  scheduleId?: string | null;
}): BackLink {
  if (job.channel === 'cron') {
    const id = job.scheduleId ?? null;
    return id === null
      ? { label: 'Back to Automations', href: '/automations' }
      : { label: 'Back to the automation', href: `/automations/${id}` };
  }
  if (job.conversationId !== null && job.conversationId !== '') {
    return { label: 'Back to the conversation', href: `/chat/${job.conversationId}` };
  }
  // APRÈS la conversation, jamais avant : un job `api` qui porte un fil est un
  // tour de chat, et c'est le fil qu'on rouvre — pas la liste des runs.
  if (folderOfJobChannel(job.channel) === MCP_FOLDER) {
    return { label: `Back to ${folderLabel(MCP_FOLDER)}`, href: folderHref(MCP_FOLDER) };
  }
  return { label: 'Back to Activity', href: '/logs' };
}
