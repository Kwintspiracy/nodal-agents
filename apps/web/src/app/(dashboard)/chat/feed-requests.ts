// feed-requests.ts — ce que l'utilisateur a demandé, tel que le serveur l'a
// rendu (18/09).
//
// Un module PUR, sans 'use client' : les pages (serveur) le calculent, le
// porteur `PendingTurnProvider` (client) le reçoit en prop. Une fonction
// exportée d'un fichier client ne peut pas être appelée côté serveur.
//
// Les textes des demandes, dans l'ordre du fil. C'est à eux que la copie
// optimiste d'un message envoyé se compare pour savoir si le serveur l'a
// rendu : quand le texte est là, la copie a fait son temps.

export function feedRequests(
  items: ReadonlyArray<{ readonly kind: string; readonly text?: unknown }>,
): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === 'request' && typeof item.text === 'string') out.push(item.text);
  }
  return out;
}
