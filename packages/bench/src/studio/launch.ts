// studio/launch.ts — pourquoi Bench Studio ne lance pas d'essai.
//
// Décision du propriétaire (16/10) : les vrais essais ne tournent JAMAIS sur
// ses agents, seulement dans l'espace banc (#758). Depuis #769, le CLI
// (`pnpm bench:workflows`, et sa tâche planifiée) y dirige ses essais par une
// seule résolution de la cible. Bench Studio n'a pas encore de chemin de
// lancement bâti sur cette même résolution : il n'en a AUCUN, le bouton Launch
// est désactivé avec cette raison, et le serveur n'a pas de route de lancement.
export const LAUNCH_DISABLED_REASON =
  'Bench Studio does not launch trials yet: run them with `pnpm bench:workflows`, which plays them in the bench space.';
