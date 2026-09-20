// capacites.mjs — ce que le produit sait faire, nommé une fois.
//
// Le portail mesurait le DÉPÔT : « @nodal-agents/web à 78 % ». Cette phrase ne
// dit rien à personne. La question qu'on se pose vraiment est « est-ce qu'un
// utilisateur peut connecter Notion ce matin, et qu'est-ce qui le prouve ».
//
// Ce fichier est la réponse à la première moitié. Chaque test répond à la
// seconde en écrivant `@cap:<slug>/ecran` ou `@cap:<slug>/moteur` dans son
// titre — deux niveaux, parce qu'un seul mot mentait : « Donner des outils »
// s'affichait « prouvée » sur la foi de trois parcours de NAVIGATEUR, quand
// les tests qui prouvent la promesse (la whitelist, l'exécution d'un outil)
// n'étaient étiquetés nulle part.
//
// ─── `ecranAttendu` / `preuveAttendue` ────────────────────────────────────────
//
// Quand un niveau n'a AUCUN test, la capacité porte en une phrase ce qu'un tel
// test devrait vérifier. C'est le plan de travail, écrit là où il se lit, et il
// est tenu par un test : `apps/qa/lib.test.mjs` refuse une phrase posée sur un
// niveau déjà prouvé (elle serait périmée) comme un niveau vide sans phrase.
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

/** @typedef {{ slug: string, domaine: string, nom: string, question: string, exigee: boolean, ecranAttendu?: string, preuveAttendue?: string }} Capacite */

/** @type {Capacite[]} */
export const CAPACITES = [
  // ─── Getting in ────────────────────────────────────────────
  {
    slug: 'installer-et-demarrer',
    domaine: 'Getting in',
    nom: 'Install and start',
    question: 'Can I install Nodal and land on a screen that answers?',
    exigee: true,
  },
  {
    slug: 'se-connecter',
    domaine: 'Getting in',
    nom: 'Protect and sign in',
    question: 'Can I close my instance and come back to it with my account?',
    exigee: true,
  },

  // ─── Building a team ──────────────────────────────────────
  {
    slug: 'creer-agent',
    domaine: 'Building a team',
    nom: 'Create an agent',
    question: 'Can I create an agent and give it a role?',
    exigee: true,
  },
  {
    slug: 'configurer-agent',
    domaine: 'Building a team',
    nom: 'Configure an agent',
    question: 'Can I change its profile, its personality, its settings?',
    exigee: true,
  },
  {
    slug: 'organiser-equipe',
    domaine: 'Building a team',
    nom: 'Organise a team',
    question: 'Can I attach agents to an orchestrator?',
    exigee: true,
  },
  {
    slug: 'choisir-modele',
    domaine: 'Building a team',
    nom: 'Choose a model',
    question: 'Can I decide which model runs which agent?',
    exigee: true,
  },

  // ─── Talking and following ─────────────────────────────────
  {
    slug: 'parler-a-un-agent',
    domaine: 'Talking and following',
    nom: 'Talk to an agent',
    question: 'Can I write to an agent and get an answer?',
    exigee: true,
  },
  {
    slug: 'suivre-execution',
    domaine: 'Talking and following',
    nom: 'Follow what it does',
    question: 'Can I see, while it works, what it is really doing?',
    exigee: true,
  },
  {
    slug: 'reprendre-conversation',
    domaine: 'Talking and following',
    nom: 'Resume a conversation',
    question: 'Can I come back tomorrow and pick up where we left off?',
    exigee: true,
  },
  {
    slug: 'parler-par-canal-externe',
    domaine: 'Talking and following',
    nom: 'Talk from elsewhere',
    question: 'Can I talk to it from Telegram rather than from the screen?',
    exigee: true,
  },

  // ─── Granting capabilities ───────────────────────────────
  {
    slug: 'assigner-outils',
    domaine: 'Granting capabilities',
    nom: 'Give tools',
    question: 'Can I decide exactly what this agent is allowed to do?',
    exigee: true,
  },
  {
    slug: 'assigner-skill',
    domaine: 'Granting capabilities',
    nom: 'Give a skill',
    question: 'Can I attach a skill to it, and take it back?',
    exigee: true,
    ecranAttendu:
      "That attaching a skill from an agent's Skills tab, then removing it, shows both in the list AND in the assignment row in the database.",
  },
  {
    slug: 'apprendre-une-skill',
    domaine: 'Granting capabilities',
    nom: 'Install a skill from the catalogue',
    question: 'Can I take a community skill and keep it up to date?',
    exigee: true,
  },
  {
    slug: 'connecter-un-service',
    domaine: 'Granting capabilities',
    nom: 'Connect a service',
    question: 'Can I connect Notion, Google, Airtable, and see what I am handing over?',
    exigee: true,
  },
  {
    slug: 'se-souvenir',
    domaine: 'Granting capabilities',
    nom: 'Remember',
    question: 'Does it hold on to what I taught it?',
    exigee: true,
  },

  // ─── Staying in control ───────────────────────────────────
  {
    slug: 'regler-autonomie',
    domaine: 'Staying in control',
    nom: 'Set the autonomy',
    question: 'Can I choose what goes through alone and what asks me first?',
    exigee: true,
  },
  {
    slug: 'approuver-une-action',
    domaine: 'Staying in control',
    nom: 'Approve or refuse',
    question: 'Does it really wait for me when it is supposed to wait?',
    exigee: true,
    // PR #159 (18/09) a posé le premier test d'écran de cette capacité
    // (`ChatFolderGroup.test.tsx`, la pastille d'Approvals) : la phrase
    // d'attente est tombée, le registre refuse un plan sur un niveau prouvé.
  },
  {
    slug: 'executer-une-commande',
    domaine: 'Staying in control',
    nom: 'Run a command',
    question: 'Can I let it run a command on my machine?',
    exigee: true,
    ecranAttendu:
      'That an agent allowed to run a command shows it on screen, asks for permission when it must, and renders its output in the thread.',
  },
  {
    slug: 'travailler-sur-des-fichiers',
    domaine: 'Staying in control',
    nom: 'Work on my files',
    question: 'Can I hand it a folder and find what it wrote there?',
    exigee: true,
  },
  {
    slug: 'verifier-un-livrable',
    domaine: 'Staying in control',
    nom: 'Verify a deliverable',
    question: 'Is what it claims to have produced really there?',
    exigee: true,
  },

  // ─── Automating ──────────────────────────────────────────
  {
    slug: 'planifier-une-tache',
    domaine: 'Automating',
    nom: 'Schedule a task',
    question: 'Can I ask it to do that every morning?',
    exigee: true,
  },
  {
    slug: 'declencher-sur-evenement',
    domaine: 'Automating',
    nom: 'Trigger on an event',
    question: 'Can I make it react to something happening outside?',
    exigee: true,
  },

  // ─── Steering ────────────────────────────────────────────
  {
    slug: 'voir-le-cout',
    domaine: 'Steering',
    nom: 'See what it costs',
    question: 'Can I know what this chat turn just cost me?',
    exigee: true,
  },
  {
    slug: 'consulter-l-aide',
    domaine: 'Steering',
    nom: 'Find out how',
    question: 'When I get stuck, can the product explain it to me?',
    exigee: true,
  },
];

/** Les slugs, en Set, pour dire vite si une étiquette existe. */
export const SLUGS = new Set(CAPACITES.map((c) => c.slug));
