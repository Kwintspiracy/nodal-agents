// mxc-tier.ts — ce qu'une suite fait d'un palier d'isolation MXC qu'elle ne peut
// pas lire (CI Windows, run 39796089254 ; revue de #859, passe 2).
//
// Le SDK MXC lance `wxc-exec --probe` (5 s au plus) et garde sa réponse pour la
// vie du module. Quand la sonde échoue ou dépasse son délai (un runner chargé),
// il laisse `isolationTier` absent, sans le dire. Le palier est alors INCONNU,
// et ce n'est pas « un palier autre que base-container » : toutes les preuves
// sur une vraie machine (un conteneur ouvert pour de vrai) se sautent sur un
// palier qui n'est pas `base-container`, et une suite qui prendrait l'inconnu
// pour un autre palier passerait au vert sans qu'aucun conteneur s'ouvre
// (invariant #4 : pas de repli silencieux). Sous Windows, un palier illisible
// FAIT ÉCHOUER la suite, avec ce que le SDK a dit.

/** L'échec d'une suite qui ne peut pas lire le palier : ce qu'elle ne prouvera pas, et pourquoi. */
export function unreadableTierError(detail: string): Error {
  return new Error(
    `MXC SDK probe could not read the isolation tier: ${detail}; the sandbox proofs cannot run`,
  );
}

/** Ce que la sonde du produit rend (SandboxStatus), réduit à ce qui compte ici. */
export interface TierStatus {
  state: string;
  code?: string;
  reason?: string;
}

/**
 * Ce bac à sable est-il indisponible À CAUSE DU PALIER (`appcontainer-dacl`,
 * Windows Server) ? Alors la batterie de confinement se saute, nommément. Un
 * palier que la sonde du produit dit `unknown` n'est pas un palier : la suite
 * échoue (`unreadableTierError`), elle ne se saute pas.
 */
export function unsupportedByTier(status: TierStatus | undefined): boolean {
  if (status?.state !== 'unavailable' || status.code !== 'SANDBOX_PLATFORM_UNSUPPORTED') {
    return false;
  }
  const reason = status.reason ?? '';
  if (/^isolationTier=unknown(?![\w-])/.test(reason)) {
    throw unreadableTierError(`the sandbox probe says ${JSON.stringify(reason)}`);
  }
  return true;
}
