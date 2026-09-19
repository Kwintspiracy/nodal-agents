// sidebar-nav.ts — LES TROIS DESTINATIONS DE LA BARRE LATÉRALE (#230).
//
// Décision du propriétaire du 19/09/2026, planches Figma reprises par lui
// (GWXBALe90DMFR3XYGccofJ, frames 487:5489, 487:5579, 487:5652) : la colonne
// unique de 0.8.11 devient un RAIL de trois destinations — Work, Agent, Run —
// et un PANNEAU qui montre celle qui est active.
//
// ⚠️ LES NOMS ONT CHANGÉ le 19/09, après une première livraison : « Talk » est
// devenu « Work » et « Build » est devenu « Agent », au SINGULIER. Work dit
// l'endroit où l'on travaille, ce qui couvre les conversations ET les espaces
// de travail que la destination porte maintenant ; Agent dit ce qu'on y monte,
// et le singulier parce qu'on en règle un à la fois.
//
// Le contenu ne change pas : ce sont les MÊMES entrées qu'en 0.8.11, réparties
// en trois. Rien n'est ajouté, rien n'est retiré — c'est ce que dit l'issue, et
// c'est ce que ce fichier doit rendre vérifiable : le test d'énumération
// compare les libellés panneau par panneau.
//
// ⚠️ DEUX ÉCARTS ASSUMÉS AVEC LA PLANCHE, et leur raison.
//
//   - « LLM Providers » ferme Build/CONNECT. Il a d'abord vécu dans Run, sur le
//     texte de l'issue et sur une décision du 18/09 (« le fournisseur de
//     modèles ouvre ce qu'on règle »). Les planches que Quentin a reprises le
//     19/09 (487:5579) le rangent sous CONNECT, après Credentials : c'est ce
//     qu'on branche au produit, au même titre qu'un connecteur. La planche du
//     propriétaire est la plus récente, et c'est elle qui décide.
//   - « Scheduled » (/scheduled) n'apparaît dans AUCUNE des trois listes de
//     l'issue, et c'est VOULU : la page disparaît (#202, PR #224). Les runs
//     d'une automatisation se lisent désormais sur SA page, et `/scheduled`
//     redirige vers `/automations`. La table ne la connaît donc ni comme
//     entrée ni comme route — deux portes vers la même chose obligeaient à
//     choisir sans rien pour choisir.

import {
  Brain,
  BookOpenText,
  ChatCircleText,
  ClockCountdown,
  Cube,
  House,
  Key,
  Lightbulb,
  ListMagnifyingGlass,
  Plug,
  PlugsConnected,
  Pulse,
  Sparkle,
  UsersThree,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';

/**
 * Une entrée du panneau : une destination interne du tableau de bord.
 *
 * ⚠️ PLUS DE PASTILLE DE COULEUR. Agents, Skills et les deux connecteurs
 * portaient la pastille de sens du DS — une couleur par famille d'objets — qui
 * REMPLAÇAIT leur icône sur grand écran. Les planches du propriétaire
 * (19/09/2026, Figma 487:5579) dessinent l'icône de chaque entrée, et rien
 * d'autre : à côté de Credentials et de Memory, qui n'ont jamais eu de
 * pastille, une ligne sur deux montrait un rond et l'autre un dessin.
 */
export type PanelItem = {
  href: string;
  label: string;
  icon: PhosphorIcon;
};

/** Un bloc du panneau, sous son titre en capitales. */
export type PanelGroup = { section: string; items: readonly PanelItem[] };

/** Laquelle des trois destinations du rail. */
export type DestinationKey = 'work' | 'agent' | 'run';

export type Destination = {
  key: DestinationKey;
  /** Le libellé du rail ET le titre du panneau : un seul mot, le même. */
  label: string;
  icon: PhosphorIcon;
  /** Où mène le clic sur la destination : sa première entrée. */
  href: string;
  /**
   * Les préfixes de route qui allument cette destination. `/` ne vaut QUE
   * pour lui-même — sans quoi il préfixerait toutes les autres.
   */
  routes: readonly string[];
  /**
   * Les blocs FIXES du panneau. Work n'en a qu'un — ses espaces de travail —
   * parce que le reste de son panneau, les dossiers de canaux et les fils
   * récents, n'existe qu'en base et se lit à l'exécution (#135, #230).
   */
  groups: readonly PanelGroup[];
};

/**
 * Le panneau AGENT — ce qu'on monte. Les deux blocs de la planche : l'équipe
 * et ce qu'elle sait faire d'abord, ce à quoi on la branche ensuite.
 */
const BUILD_GROUPS: readonly PanelGroup[] = [
  {
    section: 'Agents',
    items: [
      { href: '/agents', label: 'Agents', icon: UsersThree },
      { href: '/skills', label: 'Skills', icon: BookOpenText },
      { href: '/learned-skills', label: 'Learned Skills', icon: Lightbulb },
      { href: '/memories', label: 'Memory', icon: Brain },
    ],
  },
  {
    section: 'Connect',
    items: [
      { href: '/connectors', label: 'API Connectors', icon: Plug },
      { href: '/mcp', label: 'MCP Connectors', icon: PlugsConnected },
      { href: '/credentials', label: 'Credentials', icon: Key },
      { href: '/llm-providers', label: 'LLM Providers', icon: Sparkle },
    ],
  },
];

/**
 * Le panneau RUN — ce qui tourne, et ce qu'on surveille.
 *
 * Deux blocs : ce qu'on regarde, ce qu'on programme. « Models » n'existe plus,
 * le fournisseur de modèles ayant rejoint Agent/CONNECT.
 *
 * ⚠️ DEUX ENTRÉES EN SONT PARTIES le 19/09, et aucune n'a disparu du produit :
 * « Workspaces » ouvre maintenant le panneau Work, où l'on travaille ;
 * « Approvals » est devenu une CASE DU RAIL, parce que ce qui attend une
 * réponse doit se voir sans changer de destination.
 */
const RUN_GROUPS: readonly PanelGroup[] = [
  {
    section: 'Monitor',
    items: [
      // Le tableau de bord a DÉMÉNAGÉ sur `/dashboard` (issue #248) : la
      // racine rend désormais un fil vide. Le déménagement de la page vit
      // dans sa propre PR ; ici, c'est l'adresse du lien qui change.
      { href: '/dashboard', label: 'Dashboard', icon: House },
      { href: '/logs', label: 'Logs', icon: ListMagnifyingGlass },
    ],
  },
  {
    section: 'Automate',
    items: [{ href: '/automations', label: 'Automations & Webhooks', icon: ClockCountdown }],
  },
];

/**
 * Les trois destinations, dans l'ordre du rail.
 *
 * Talk d'abord : c'est là qu'on parle, et c'est la raison d'être du produit.
 */
export const DESTINATIONS: readonly Destination[] = [
  {
    key: 'work',
    label: 'Work',
    icon: ChatCircleText,
    href: '/',
    // `/` allume WORK depuis le 19/09 au soir (issue #248) : la racine n'est
    // plus le tableau de bord, c'est un fil vide — « New conversation » — et
    // c'est donc l'endroit où l'on travaille.
    //
    // `/spaces` aussi : les espaces de travail vivent dans ce panneau, et une
    // destination qui ne s'allume pas sur la page qu'elle porte se lit comme
    // un menu cassé.
    routes: ['/', '/chat', '/spaces'],
    // AUCUN bloc écrit. Le panneau Work n'a que des lignes qui n'existent
    // qu'en base : son dossier « Workspaces », qui déplie les projets, et ses
    // dossiers de canaux. Toutes deux se lisent à l'exécution.
    groups: [],
  },
  {
    key: 'agent',
    label: 'Agent',
    icon: Cube,
    href: '/agents',
    routes: [
      '/agents',
      '/skills',
      '/learned-skills',
      '/memories',
      '/connectors',
      '/mcp',
      '/credentials',
      '/llm-providers',
    ],
    groups: BUILD_GROUPS,
  },
  {
    key: 'run',
    label: 'Run',
    icon: Pulse,
    // `/dashboard`, et non `/` (issue #248, constaté au rebase). La case du
    // rail est un LIEN : tant que la racine ÉTAIT le tableau de bord, `/` était
    // la bonne adresse pour Run. Elle rend un fil vide depuis #248, et cliquer
    // Run emmenait donc sur Work, qui s'allumait à sa place — un rail qui
    // répond à côté. L'adresse d'une destination est la première de ses routes.
    href: '/dashboard',
    routes: [
      '/dashboard',
      '/logs',
      '/automations',
      // Les pages d'un run et d'un espace de travail. Elles n'ont PAS d'entrée
      // dans le panneau — on y arrive depuis une liste, jamais depuis le menu
      // (#143 les fusionnera dans Workspaces) — mais elles doivent allumer une
      // destination : le rail sans destination active se lit comme un rail
      // cassé.
      '/jobs',
      '/runs',
      '/code',
    ],
    groups: RUN_GROUPS,
  },
];

/**
 * La destination que la route DÉSIGNE, ou `null` quand aucune ne la reconnaît.
 *
 * Le préfixe LE PLUS LONG gagne : `/mcp` et `/memories` ne se confondent pas,
 * et une route couverte par deux destinations ne dépendrait pas de l'ordre de
 * la table. `/` ne vaut que pour lui-même.
 *
 * `null` est un fait, pas un trou : c'est la réponse sur `/settings`, dont la
 * case vit au bas du rail. Le rail n'y allume alors AUCUNE des trois, et dire
 * « Run » ferait mentir la case sur la page où l'on se trouve.
 */
export function matchedDestination(pathname: string): Destination | null {
  let best: Destination | null = null;
  let bestLength = -1;
  for (const dest of DESTINATIONS) {
    for (const route of dest.routes) {
      // `/` ne vaut QUE pour lui-même : en préfixe il couvrirait toutes les
      // autres routes, et la première destination de la table gagnerait tout.
      const matches = route === '/' ? pathname === '/' : isUnder(pathname, route);
      if (!matches || route.length <= bestLength) continue;
      best = dest;
      bestLength = route.length;
    }
  }
  return best;
}

/**
 * La destination que le PANNEAU montre — toujours une, jamais zéro.
 *
 * Celle que la route désigne, sinon RUN. Le panneau doit bien montrer quelque
 * chose, et Run porte le tableau de bord, donc la racine du produit. Un panneau
 * vide serait pire, et « la dernière destination visitée » ferait deux écrans
 * différents pour la même adresse.
 */
export function destinationForPath(pathname: string): Destination {
  return matchedDestination(pathname) ?? runDestination();
}

/** Une route est-elle celle-ci, ou dedans ? Jamais un préfixe de mot. */
function isUnder(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(route + '/');
}

/** Run, la destination de repli. Lue dans la table, jamais réécrite. */
function runDestination(): Destination {
  const run = DESTINATIONS.find((d) => d.key === 'run');
  // La table est une constante de ce module : l'absence de `run` serait une
  // faute de frappe, pas un cas d'exécution. On le dit fort (invariant #4).
  if (run === undefined) throw new Error('sidebar-nav: no "run" destination');
  return run;
}

/** L'entrée du panneau qui correspond à la route — exacte, ou dedans. */
export function isPanelItemActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return isUnder(pathname, href);
}
