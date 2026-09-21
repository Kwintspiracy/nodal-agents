// feed-density.ts — À QUELLE DENSITÉ une personne lit un fil (#132).
//
// Le tableau de #135 pose deux écrans du même fil : « Thread, folded (default
// density) » et « Thread, unfolded (builder density) ». Ce n'est pas deux
// rendus : c'est le même, ouvert autrement. La densité ne fixe que l'état de
// DÉPART des groupes de run ; chaque bloc se déplie toujours pour son compte.
//
// Jusqu'au 22/09/2026 c'était une préférence de la personne (`users.feed_density`,
// choisie par un contrôle dans la barre du fil). Quentin l'a retirée : un fil
// s'ouvre replié, la page d'un run s'ouvre dépliée, et chaque bloc se déplie
// pour son compte. Ce module ne garde que la liste et le défaut, lus par le
// fil pour l'état de départ de ses groupes.

export const FEED_DENSITIES = ['folded', 'unfolded'] as const;

export type FeedDensity = (typeof FEED_DENSITIES)[number];

/** Ce que voit tout le monde : la réponse d'abord, le travail replié dessous. */
export const DEFAULT_FEED_DENSITY: FeedDensity = 'folded';
