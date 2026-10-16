// studio/launch.ts — pourquoi Bench Studio ne lance pas d'essai.
//
// Décision du propriétaire (16/10) : les vrais essais ne tournent JAMAIS sur
// ses agents, seulement dans l'espace banc (#758). Le banc ne sait pas encore y
// diriger ses essais : quel agent `run_task` atteint, quelle entité le juge lit,
// comment le CLI est épinglé. Ce ciblage se conçoit d'un bloc dans #769. D'ici
// là, Bench Studio n'a AUCUN chemin qui joue une session : le bouton Launch est
// désactivé avec cette raison, et le serveur n'a pas de route de lancement.
export const LAUNCH_DISABLED_REASON = 'Trials are not pinned to the bench space yet (#769).';
