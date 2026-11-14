// job/conversation-moments.ts — les moments d'une conversation de chat, dans
// l'ordre où ils ont eu lieu (#1078).
//
// LE DÉFAUT. L'issue d'une tâche lancée depuis une conversation était rejouée
// sous le tour qui l'avait LANCÉE, sans date, quoi qu'il se soit dit entre le
// lancement et la fin. L'historique suivait l'ordre des lancements, pas celui
// des fins, et un modèle prend la dernière issue qu'il lit pour l'état du
// travail : la réponse de 11:03 disait « refusé deux fois » parce que le refus
// d'une tâche finie à 10:59 venait, sur la page, après le livrable d'une tâche
// finie à 11:02. Mesuré sur l'appel réel : l'issue déplacée au moment où la
// tâche a fini fait passer un modèle de 3 réponses fausses sur 10 à 0, un autre
// de 1 juste sur 5 à 5. La date seule, sans le déplacement, ne corrige rien.
//
// LA RÈGLE. La fin d'une tâche est un moment de la conversation : chaque ligne
// de chat à l'heure où elle a été écrite, et, pour chaque ligne qui a lancé un
// job terminé, la FIN de ce job à l'heure où il a fini. Cette heure est un fait
// rangé à la fin (`agent_jobs.completed_at`), jamais redéduit : c'est le
// lecteur qui la donne, ou `null` quand la ligne n'a pas de fin à placer (rien
// de lancé, un travail encore en cours, ou une fin sans heure rangée).
//
// L'ORDRE, sans exception :
//   - une fin vient après sa ligne de lancement, et après toute ligne écrite
//     avant qu'elle n'arrive (une ligne écrite au même instant compris) ;
//   - elle ne vient JAMAIS avant sa ligne de lancement, même si les heures
//     rangées le disent ;
//   - deux fins au même endroit suivent leur heure, puis l'ordre de leurs
//     lancements.
// Le message auquel on répond n'est pas un moment de l'historique : le lecteur
// le pose après, et tout ce qui a fini avant l'appel le précède.
//
// UN ORDRE, DEUX LECTEURS : le tour de chat (run-chat-turn.ts), tableau de bord
// et appareils, et l'historique d'un job lancé depuis la même conversation
// (thread-history.ts, `loadDashboardHistory`). Deux vues d'une conversation ne
// se contredisent pas sur l'ordre de ce qui s'est passé.

import { TERMINAL_STATUSES, type JobStatus } from './state.ts';

/**
 * Quand un job lancé a fini, s'il a une fin à placer : un statut terminal ET
 * l'heure rangée à sa fin (`agent_jobs.completed_at`), rien d'autre — ni
 * `updated_at`, que des écritures postérieures déplacent, ni « maintenant ».
 * Un job fini sans heure rangée (il en existe : des annulations) n'a pas de fin
 * à placer ; son issue reste sous son lancement, comme avant #1078.
 */
export function taskEndedAt(job: { status: string | null; completedAt: Date | null }): Date | null {
  return job.completedAt !== null && isJobEnded(job.status) ? job.completedAt : null;
}

/** Le job a-t-il fini (terminé, échoué, annulé) ? */
export function isJobEnded(status: string | null): boolean {
  return TERMINAL_STATUSES.includes(status as JobStatus);
}

/** Un moment : une ligne de la conversation, ou la fin du job qu'elle a lancé. */
export type ConversationMoment<R> =
  | { kind: 'row'; row: R }
  | { kind: 'end'; row: R; endedAt: Date };

/** Ce que l'ordre lit d'une ligne : quand elle a été écrite, quand son job a fini. */
export interface MomentTimes {
  writtenAt: Date | null;
  /** La fin du job que cette ligne a lancé, `null` quand il n'y a pas de fin à placer. */
  endedAt: Date | null;
}

/**
 * Les moments d'une conversation, dans l'ordre où ils ont eu lieu. `rows` est
 * dans l'ordre de leur écriture ; `times` dit, pour chacune, quand elle a été
 * écrite et, s'il y a lieu, quand le job qu'elle a lancé a fini. Pure.
 */
export function conversationMoments<R>(
  rows: readonly R[],
  times: (row: R) => MomentTimes,
): ConversationMoment<R>[] {
  const read = rows.map((row) => {
    const t = times(row);
    if (t.writtenAt === null) {
      throw new Error('conversation moments: a chat_messages row has no created_at');
    }
    return { writtenAt: t.writtenAt.getTime(), endedAt: t.endedAt };
  });
  const ends: Array<{ after: number; endedAt: Date; launch: number }> = [];
  read.forEach(({ endedAt }, launch) => {
    if (endedAt === null) return;
    // Après la ligne de lancement, et après chaque ligne qui la suit écrite au
    // plus tard à la fin : la fin se pose avant la première ligne écrite après.
    let after = launch;
    for (let j = launch + 1; j < read.length; j++) {
      if (read[j]!.writtenAt > endedAt.getTime()) break;
      after = j;
    }
    ends.push({ after, endedAt, launch });
  });
  ends.sort(
    (a, b) => a.after - b.after || a.endedAt.getTime() - b.endedAt.getTime() || a.launch - b.launch,
  );
  const moments: ConversationMoment<R>[] = [];
  let next = 0;
  rows.forEach((row, i) => {
    moments.push({ kind: 'row', row });
    while (next < ends.length && ends[next]!.after === i) {
      const end = ends[next++]!;
      moments.push({ kind: 'end', row: rows[end.launch]!, endedAt: end.endedAt });
    }
  });
  return moments;
}
