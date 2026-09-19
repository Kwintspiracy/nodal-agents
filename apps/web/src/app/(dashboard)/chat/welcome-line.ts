// welcome-line.ts — la ligne d'accueil d'une conversation qui n'a pas encore
// commencé (#248, planche « #146 A run is not a chat », cadre `398:3917`).
//
// « Hey {prénom}, what are we building today? » quand le produit connaît un
// nom, « Hey, what are we building today? » quand il n'en connaît pas. Il n'en
// INVENTE aucun (invariant #4) : le compte du mode local porte l'adresse
// `local@nodalai.local`, et en tirer « local » saluerait quelqu'un qui n'existe
// pas.
//
// D'où vient le nom : de `users.name`, le seul endroit où un nom est écrit.
// better-auth la remplit à l'inscription (mode local-auth) ; elle reste vide en
// local-trust, où personne ne s'est présenté — et la phrase se passe alors du
// nom, sans rien perdre.

/**
 * Le prénom : le premier mot du nom. « Quentin Beau » → « Quentin ». Un nom
 * vide, absent ou fait d'espaces ne rend rien, plutôt qu'une chaîne vide
 * glissée dans la phrase (« Hey , what are we… »).
 */
export function firstName(name: string | null): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first === '' ? null : first;
}

/** La ligne d'accueil entière, nom compris quand il y en a un. */
export function welcomeLine(name: string | null): string {
  const who = firstName(name);
  return who === null
    ? 'Hey, what are we building today?'
    : `Hey ${who}, what are we building today?`;
}
