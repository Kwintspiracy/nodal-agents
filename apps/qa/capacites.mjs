// capacites.mjs — ce que le produit sait faire, nommé une fois.
//
// Le portail mesurait le DÉPÔT : « @nodal-agents/web à 78 % ». Cette phrase ne
// dit rien à personne. La question qu'on se pose vraiment est « est-ce qu'un
// utilisateur peut connecter Notion ce matin, et qu'est-ce qui le prouve ».
//
// Ce fichier est la réponse à la première moitié. Chaque test répond à la
// seconde en écrivant `@cap:<slug>` dans son titre.
//
// ─── D'où vient cette liste ───────────────────────────────────────────────────
//
// Elle est DÉRIVÉE, pas inventée : des 33 parcours de `apps/web/tests/e2e/` et
// des 32 écrans de `apps/web/src/app/`. Un registre écrit d'imagination décrit
// le produit qu'on aimerait avoir ; celui-ci décrit celui qui existe. C'est la
// seule version dont l'écart avec les tests veut dire quelque chose.
//
// ─── `exigee` ─────────────────────────────────────────────────────────────────
//
// La porte refuse une capacité `exigee` que plus aucun test ne prouve.
//
// Elles ne l'étaient pas toutes au départ — sept seulement — parce qu'une porte
// qui exige tout le premier jour se fait désactiver le deuxième. La vague s'est
// élargie à mesure de l'étiquetage, et elle est CLOSE : les vingt-quatre sont
// désormais revendiquées par au moins un test, donc toutes exigées. Supprimer
// le dernier test qui prouve l'une d'elles fait maintenant rougir la CI.
//
// Ajouter une capacité ici sans l'étiqueter nulle part casse la porte, et c'est
// voulu : c'est le seul moment où quelqu'un se demande encore ce qui la prouve.

/** @typedef {{ slug: string, domaine: string, nom: string, question: string, exigee: boolean }} Capacite */

/** @type {Capacite[]} */
export const CAPACITES = [
  // ─── Entrer ─────────────────────────────────────────────────────────────────
  {
    slug: 'installer-et-demarrer',
    domaine: 'Entrer',
    nom: 'Installer et démarrer',
    question: 'Puis-je installer Nodal et arriver sur un écran qui répond ?',
    exigee: true,
  },
  {
    slug: 'se-connecter',
    domaine: 'Entrer',
    nom: 'Protéger et se connecter',
    question: 'Puis-je fermer mon instance et y revenir avec mon compte ?',
    exigee: true,
  },

  // ─── Composer une équipe ────────────────────────────────────────────────────
  {
    slug: 'creer-agent',
    domaine: 'Composer une équipe',
    nom: 'Créer un agent',
    question: 'Puis-je créer un agent et lui donner un rôle ?',
    exigee: true,
  },
  {
    slug: 'configurer-agent',
    domaine: 'Composer une équipe',
    nom: 'Configurer un agent',
    question: 'Puis-je changer son profil, sa personnalité, ses réglages ?',
    exigee: true,
  },
  {
    slug: 'organiser-equipe',
    domaine: 'Composer une équipe',
    nom: 'Organiser une équipe',
    question: 'Puis-je rattacher des agents à un orchestrateur ?',
    exigee: true,
  },
  {
    slug: 'choisir-modele',
    domaine: 'Composer une équipe',
    nom: 'Choisir un modèle',
    question: 'Puis-je décider quel modèle fait tourner quel agent ?',
    exigee: true,
  },

  // ─── Parler et suivre ───────────────────────────────────────────────────────
  {
    slug: 'parler-a-un-agent',
    domaine: 'Parler et suivre',
    nom: 'Parler à un agent',
    question: 'Puis-je écrire à un agent et obtenir une réponse ?',
    exigee: true,
  },
  {
    slug: 'suivre-execution',
    domaine: 'Parler et suivre',
    nom: "Suivre ce qu'il fait",
    question: "Puis-je voir, pendant qu'il travaille, ce qu'il fait vraiment ?",
    exigee: true,
  },
  {
    slug: 'reprendre-conversation',
    domaine: 'Parler et suivre',
    nom: 'Reprendre une conversation',
    question: 'Puis-je revenir demain et repartir de là où on en était ?',
    exigee: true,
  },
  {
    slug: 'parler-par-canal-externe',
    domaine: 'Parler et suivre',
    nom: 'Parler depuis ailleurs',
    question: "Puis-je lui parler depuis Telegram plutôt que depuis l'écran ?",
    exigee: true,
  },

  // ─── Donner des capacités ───────────────────────────────────────────────────
  {
    slug: 'assigner-outils',
    domaine: 'Donner des capacités',
    nom: 'Donner des outils',
    question: 'Puis-je décider exactement ce que cet agent a le droit de faire ?',
    exigee: true,
  },
  {
    slug: 'assigner-skill',
    domaine: 'Donner des capacités',
    nom: 'Donner un savoir-faire',
    question: 'Puis-je lui attacher une skill, et la lui retirer ?',
    exigee: true,
  },
  {
    slug: 'apprendre-une-skill',
    domaine: 'Donner des capacités',
    nom: 'Installer une skill du catalogue',
    question: 'Puis-je prendre une skill de la communauté et la tenir à jour ?',
    exigee: true,
  },
  {
    slug: 'connecter-un-service',
    domaine: 'Donner des capacités',
    nom: 'Connecter un service',
    question: 'Puis-je connecter Notion, Google, Airtable — et voir ce que je cède ?',
    exigee: true,
  },
  {
    slug: 'se-souvenir',
    domaine: 'Donner des capacités',
    nom: 'Se souvenir',
    question: "Est-ce qu'il retient ce que je lui ai appris ?",
    exigee: true,
  },

  // ─── Garder la main ─────────────────────────────────────────────────────────
  {
    slug: 'regler-autonomie',
    domaine: 'Garder la main',
    nom: "Régler l'autonomie",
    question: 'Puis-je choisir ce qui passe seul et ce qui me demande ?',
    exigee: true,
  },
  {
    slug: 'approuver-une-action',
    domaine: 'Garder la main',
    nom: 'Approuver ou refuser',
    question: "Est-ce qu'il m'attend vraiment quand il doit m'attendre ?",
    exigee: true,
  },
  {
    slug: 'executer-une-commande',
    domaine: 'Garder la main',
    nom: 'Exécuter une commande',
    question: 'Puis-je le laisser lancer une commande sur ma machine ?',
    exigee: true,
  },
  {
    slug: 'travailler-sur-des-fichiers',
    domaine: 'Garder la main',
    nom: 'Travailler sur mes fichiers',
    question: 'Puis-je lui donner un dossier et retrouver ce qu’il y a écrit ?',
    exigee: true,
  },
  {
    slug: 'verifier-un-livrable',
    domaine: 'Garder la main',
    nom: 'Vérifier un livrable',
    question: "Est-ce que ce qu'il annonce avoir produit est vraiment là ?",
    exigee: true,
  },

  // ─── Automatiser ────────────────────────────────────────────────────────────
  {
    slug: 'planifier-une-tache',
    domaine: 'Automatiser',
    nom: 'Planifier une tâche',
    question: 'Puis-je lui demander de faire ça tous les matins ?',
    exigee: true,
  },
  {
    slug: 'declencher-sur-evenement',
    domaine: 'Automatiser',
    nom: 'Déclencher sur un événement',
    question: "Puis-je le faire réagir à quelque chose qui arrive de l'extérieur ?",
    exigee: true,
  },

  // ─── Piloter ────────────────────────────────────────────────────────────────
  {
    slug: 'voir-le-cout',
    domaine: 'Piloter',
    nom: 'Voir ce que ça coûte',
    question: 'Puis-je savoir ce que ce tour de chat vient de me coûter ?',
    exigee: true,
  },
  {
    slug: 'consulter-l-aide',
    domaine: 'Piloter',
    nom: 'Trouver comment faire',
    question: "Quand je bloque, est-ce que le produit sait me l'expliquer ?",
    exigee: true,
  },
];

/** Les slugs, en Set, pour dire vite si une étiquette existe. */
export const SLUGS = new Set(CAPACITES.map((c) => c.slug));
