// feed-density.ts — À QUELLE DENSITÉ une personne lit un fil (#132).
//
// Le tableau de #135 pose deux écrans du même fil : « Thread, folded (default
// density) » et « Thread, unfolded (builder density) ». Ce n'est pas deux
// rendus : c'est le même, ouvert autrement. La densité ne fixe que l'état de
// DÉPART des groupes de run ; chaque bloc se déplie toujours pour son compte.
//
// C'est une préférence DE LA PERSONNE, pas une constante de code : celui qui
// construit veut voir le travail, celui qui discute veut voir la réponse. Elle
// vit donc sur `users.feed_density`, et le module qui la nomme est pur, pour
// que l'écran (client) et l'action (serveur) lisent la même liste.

import { z } from 'zod';

export const FEED_DENSITIES = ['folded', 'unfolded'] as const;

export type FeedDensity = (typeof FEED_DENSITIES)[number];

/**
 * Ce que voit quelqu'un qui n'a jamais rien choisi : la réponse d'abord, le
 * travail replié dessous (décision de Quentin, #132).
 */
export const DEFAULT_FEED_DENSITY: FeedDensity = 'folded';

export const feedDensitySchema = z.enum(FEED_DENSITIES);

/**
 * La densité lue d'une colonne. La contrainte `CHECK` de la table interdit déjà
 * toute autre valeur ; ce garde-fou existe pour la ligne d'une base plus
 * ancienne que la migration, et il rend la densité DESSINÉE par défaut plutôt
 * qu'une page blanche — une préférence d'affichage illisible n'est pas une
 * panne.
 */
export function parseFeedDensity(value: unknown): FeedDensity {
  const parsed = feedDensitySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_FEED_DENSITY;
}
