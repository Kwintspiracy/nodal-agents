// feed-dots.ts — les couleurs des pastilles du fil, dans un module SANS
// directive (#240).
//
// Pourquoi elles ne vivent plus dans `ToolBlock.tsx` et `FileDiff.tsx`. Ces
// deux modules portent `'use client'`, et `ConversationFeedView` — rendu côté
// serveur — y lisait `DOT[outcome]` et `FILE_DOT[f.action]`. Vu du serveur, un
// export de module client n'est PAS la valeur : le chargeur de Next remplace
// le module par une référence par export
// (`next/dist/build/webpack/loaders/next-flight-loader/index.js`, branche
// `assumedSourceType === 'module'`), et `registerClientReference` ne rend
// qu'une fonction porteuse de `$$typeof` / `$$id` / `$$async`. Y entrer par
// une clé ne jette pas : ça rend `undefined`. Le `?? 'bg-ink-4'` prenait donc
// le relais et TOUTES les pastilles du fil étaient grises, en silence.
//
// Un module sans directive est lisible des deux côtés : le serveur en obtient
// la valeur, les composants client l'importent comme avant.
// `feed-dots.server-boundary.test.tsx` le prouve par un rendu, et la garde
// `scan-server-uses-client-value.ts` refuse désormais qu'on revienne en
// arrière.

/**
 * La pastille de 8 px qui dit comment un appel d'outil s'est terminé. Partagée :
 * le bloc d'outil et la carte d'envoi la reprennent telle quelle — deux blocs
 * d'un même run ne disent pas leur issue de deux couleurs différentes.
 */
export const DOT: Readonly<Record<string, string>> = {
  success: 'bg-ok',
  error: 'bg-err',
  blocked: 'bg-err',
  awaiting_approval: 'bg-run',
};

/**
 * Ce qu'un fichier a subi, en une pastille de 6 px (P2bis). Écrit vert, touché
 * ambre, seulement listé gris : le design du fil ne met pas de mot là où une
 * couleur suffit, et le mot (`created`, `modified`) revenait sur chaque ligne.
 */
export const FILE_DOT: Readonly<Record<string, string>> = {
  created: 'bg-ok',
  modified: 'bg-warn',
  listed: 'bg-ink-4',
};
