// question-answer.ts — la borne d'une réponse LIBRE à une question (#465).

/**
 * Ce que la personne écrit quand aucune option de l'agent ne lui va : une
 * explication, pas un document. UNE source pour les trois endroits qui la
 * lisent (revue Nodal de #622) : le runner qui refuse au-delà
 * (`approvals/resolve.ts`), le schéma de l'action web qui transporte la
 * réponse (`resolveApprovalAction`), et le champ de la carte qui la borne.
 */
export const FREE_ANSWER_MAX = 2000;
