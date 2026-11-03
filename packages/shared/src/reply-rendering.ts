// reply-rendering.ts — COMMENT la personne reçoit la réponse : lue ou entendue (#941).
//
// Un fait de la DEMANDE, pas du canal. Le même fil du tableau de bord reçoit
// une question tapée, dont la réponse se lit, et une question dite au micro,
// dont la réponse s'entend. Le canal ne le sait donc pas ; le tour le sait, et
// le job qu'il lance l'hérite (`agent_jobs.reply_rendering`, migration 0157).
//
// Trois surfaces lisent ces mots : le runner les pose (le tour vocal, le job
// qu'il lance), `packages/db` les range, l'orchestration en tire la ligne du
// prompt. Le type vit donc ici, en un seul exemplaire.

/**
 * `text` — la réponse se lit : ce que tout canal fait aujourd'hui, et la valeur
 *   par défaut de toute ligne déjà écrite.
 * `spoken` — la réponse est convertie en voix et entendue. Les mots restent
 *   ceux de l'agent (invariant #2) ; le prompt lui dit seulement qu'ils seront
 *   dits.
 */
export type ReplyRendering = 'text' | 'spoken';

export const REPLY_RENDERINGS: readonly ReplyRendering[] = ['text', 'spoken'];
