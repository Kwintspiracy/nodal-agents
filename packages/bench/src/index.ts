// @nodal-agents/bench — le banc d'essai : mesurer, pas seulement passer/échouer.
//
// La suite de tests répond « est-ce que quelque chose est cassé ? ». Le banc
// répond « qu'est-ce qui a BOUGÉ, et de combien, depuis la dernière fois ? » —
// la question qui compte quand on ajoute un modèle, un fournisseur ou un outil,
// parce que la réponse honnête est le plus souvent « ces quatre nombres ont
// changé » plutôt que vert ou rouge.

export * from './types';
export * from './compare';
export * from './baseline';
export * from './run';
export { ALL_SECTIONS, OFFLINE_SECTIONS, ONLINE_SECTIONS, sectionById } from './sections/index';
