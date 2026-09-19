/**
 * docked-form-id.ts — l'`id` du `<form>` d'un réglage ouvert dans le panneau
 * ancré, des deux côtés de la frontière serveur / client.
 *
 * Pourquoi cette fonction d'une ligne vit dans SON fichier, et surtout PAS
 * dans `DockedFormCta.tsx` : ce dernier porte `'use client'` parce qu'il tient
 * un contexte React. Or `/settings` est un composant SERVEUR, et il appelle
 * cette fonction pour donner son `id` à chaque formulaire.
 *
 * Dans le modèle serveur de React, tout ce qu'un module `'use client'` exporte
 * devient, vu du serveur, une RÉFÉRENCE client : un objet que le serveur sait
 * rendre comme composant, mais pas appeler. Appeler `dockedFormId()` depuis la
 * page faisait donc tomber le rendu, et `/settings` répondait 500 sur une
 * stack fraîche — la CI l'a vu avant nous (`e2e-smoke`, PR #237). Le
 * typecheck, lui, ne pouvait rien en dire : les types sont les mêmes des deux
 * côtés, seule l'exécution diffère.
 *
 * Un module sans directive est lisible par les deux mondes. C'est la seule
 * forme correcte pour une valeur partagée entre une page serveur et un
 * composant client, et `src/tests/architecture.test.ts` refuse désormais le
 * cas inverse.
 */

/** L'`id` du `<form>` d'un réglage. Une seule source, des deux côtés. */
export function dockedFormId(settingId: string): string {
  return `settings-form-${settingId}`;
}
