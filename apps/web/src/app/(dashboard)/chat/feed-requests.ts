// feed-requests.ts — ce que le fil rendu par le serveur dit des demandes (18/09).
//
// Un module PUR, sans 'use client' : les pages (serveur) le calculent, le
// porteur `PendingTurnProvider` (client) le reçoit en props. Une fonction
// exportée d'un fichier client ne peut pas être appelée côté serveur.

type Item = { readonly kind: string; readonly text?: unknown };

/**
 * Les textes des demandes, dans l'ordre du fil. C'est à eux que la copie
 * optimiste d'un message envoyé se compare pour savoir si le serveur l'a
 * rendu : quand le texte est là, la copie a fait son temps.
 */
export function feedRequests(items: ReadonlyArray<Item>): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === 'request' && typeof item.text === 'string') out.push(item.text);
  }
  return out;
}

/**
 * Le fil se termine sur une demande sans réponse : le runner l'a écrite en
 * ouvrant son tour, la réponse n'est pas encore là. C'est SOUS cette demande
 * que l'agent réfléchit — pas sous les copies qui attendent leur tour.
 */
export function feedAwaitsReply(items: ReadonlyArray<Item>): boolean {
  return items.at(-1)?.kind === 'request';
}
