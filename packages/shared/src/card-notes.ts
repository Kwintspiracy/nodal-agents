// card-notes.ts — la borne des mots qu'une personne joint à sa réponse à une carte.

/**
 * Ce que la personne écrit EN PLUS de son choix sur une carte (approbation,
 * question, question d'un serveur) : une raison, un changement à faire. Ces
 * mots sont stockés sur la demande (`approval_requests.notes`) et remis à la
 * tête du run (`approvals/card-words.ts`) : ils ont une borne, UNE, pour toute
 * surface qui répond.
 *
 * Le tableau de bord bornait déjà ce texte à 5000 caractères avant que cette
 * constante existe (`resolveApprovalAction`) : la borne est celle-là, pas une
 * seconde échelle, et elle ne refuse rien de ce que le tableau de bord envoie.
 * Les canaux (Telegram, Slack, Discord) n'envoient aucune note. La réponse
 * LIBRE à une question (`answer`) a sa propre borne, `FREE_ANSWER_MAX`.
 *
 * UNE source pour le runner (`approvals/resolve.ts` refuse au-delà), le schéma
 * de l'action web, et le client de référence d'un appareil (qui refuse avant
 * d'envoyer, via le protocole généré).
 */
export const CARD_NOTES_MAX = 5000;
