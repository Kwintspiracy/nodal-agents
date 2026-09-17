// feed-signature.ts — la signature d'un fil rendu par le serveur (18/09).
//
// Un module PUR, sans 'use client' : les pages (serveur) la calculent, le
// porteur `PendingTurnProvider` (client) la reçoit en prop. Une fonction
// exportée d'un fichier client ne peut pas être appelée côté serveur — c'est
// exactement l'erreur que Next rendait quand elle vivait dans PendingTurn.tsx.
//
// Elle change dès que le serveur ajoute une ligne au fil : un tour de plus,
// une réponse de plus. Le nombre d'items et la nature du dernier suffisent.

export function feedSignature(itemCount: number, lastKind: string): string {
  return `${itemCount}:${lastKind}`;
}
