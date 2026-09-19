// sidebar-nav.ts — LES TROIS DESTINATIONS DE LA BARRE LATÉRALE (#230).
//
// Décision du propriétaire du 19/09/2026, planche Figma « Sidebar propositions
// · 4a 3b 3c » (GWXBALe90DMFR3XYGccofJ, frames 458:4, 458:88, 458:181) : la
// colonne unique de 0.8.11 devient un RAIL de trois destinations — Talk,
// Build, Run — et un PANNEAU qui montre celle qui est active.
//
// Le contenu ne change pas : ce sont les MÊMES entrées qu'en 0.8.11, réparties
// en trois. Rien n'est ajouté, rien n'est retiré — c'est ce que dit l'issue, et
// c'est ce que ce fichier doit rendre vérifiable : le test d'énumération
// compare les libellés panneau par panneau.
//
// ⚠️ DEUX ÉCARTS ASSUMÉS AVEC LA PLANCHE, et leur raison.
//
//   - « LLM Providers » est dessiné sous Build/CONNECT sur la planche, et rangé
//     dans Run par le texte de l'issue. L'ISSUE GAGNE : c'est elle qui porte la
//     décision, la planche montrait une liste plus courte, dessinée avant.
//   - « Scheduled » (/scheduled) n'apparaît dans AUCUNE des trois listes de
//     l'issue, et c'est VOULU : la page disparaît (#202, PR #224). Les runs
//     d'une automatisation se lisent désormais sur SA page, et `/scheduled`
//     redirige vers `/automations`. La table ne la connaît donc ni comme
//     entrée ni comme route — deux portes vers la même chose obligeaient à
//     choisir sans rien pour choisir.

import {
  Brain,
  BookOpenText,
  CardsThree,
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
  ShieldCheck,
  Sparkle,
  UsersThree,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';

/** Une entrée du panneau : une destination interne du tableau de bord. */
export type PanelItem = {
  href: string;
  label: string;
  icon: PhosphorIcon;
  /** La pastille de sens du DS — une couleur par famille d'objets. */
  dot?: 'agent' | 'skill' | 'conn';
};

/** Un bloc du panneau, sous son titre en capitales. */
export type PanelGroup = { section: string; items: readonly PanelItem[] };

/** Laquelle des trois destinations du rail. */
export type DestinationKey = 'talk' | 'build' | 'run';

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
   * Le contenu du panneau. Vide pour Talk : ses lignes sont les dossiers de
   * canaux, qui n'existent qu'en base et se lisent à l'exécution (#135).
   */
  groups: readonly PanelGroup[];
};

/**
 * Le panneau BUILD — ce qu'on monte. Les deux blocs de la planche : l'équipe
 * et ce qu'elle sait faire d'abord, ce à quoi on la branche ensuite.
 */
const BUILD_GROUPS: readonly PanelGroup[] = [
  {
    section: 'Agents',
    items: [
      { href: '/agents', label: 'Agents', icon: UsersThree, dot: 'agent' },
      { href: '/skills', label: 'Skills', icon: BookOpenText, dot: 'skill' },
      { href: '/learned-skills', label: 'Learned Skills', icon: Lightbulb },
      { href: '/memories', label: 'Memory', icon: Brain },
    ],
  },
  {
    section: 'Connect',
    items: [
      { href: '/connectors', label: 'API Connectors', icon: Plug, dot: 'conn' },
      { href: '/mcp', label: 'MCP Connectors', icon: PlugsConnected, dot: 'conn' },
      { href: '/credentials', label: 'Credentials', icon: Key },
    ],
  },
];

/**
 * Le panneau RUN — ce qui tourne, et ce qu'on règle pour que ça tourne.
 *
 * « Models » est un TROISIÈME bloc, et il n'est pas sur la planche : celle-ci
 * rangeait le fournisseur de modèles sous Build, l'issue le range ici, et il
 * n'est ni quelque chose qu'on surveille ni quelque chose qu'on programme. Lui
 * donner son titre vaut mieux que le glisser sous un titre qui le décrit mal.
 */
const RUN_GROUPS: readonly PanelGroup[] = [
  {
    section: 'Monitor',
    items: [
      { href: '/', label: 'Dashboard', icon: House },
      // « Workspaces », pas « Spaces » (Quentin, 18/09/2026). La ROUTE ne bouge
      // pas : `/spaces` est dans les favoris et dans les liens déjà envoyés.
      { href: '/spaces', label: 'Workspaces', icon: CardsThree },
      { href: '/approvals', label: 'Approvals', icon: ShieldCheck },
      { href: '/logs', label: 'Logs', icon: ListMagnifyingGlass },
    ],
  },
  {
    section: 'Automate',
    items: [{ href: '/automations', label: 'Automations & Webhooks', icon: ClockCountdown }],
  },
  {
    section: 'Models',
    items: [{ href: '/llm-providers', label: 'LLM Providers', icon: Sparkle }],
  },
];

/**
 * Les trois destinations, dans l'ordre du rail.
 *
 * Talk d'abord : c'est là qu'on parle, et c'est la raison d'être du produit.
 */
export const DESTINATIONS: readonly Destination[] = [
  {
    key: 'talk',
    label: 'Talk',
    icon: ChatCircleText,
    href: '/chat',
    routes: ['/chat'],
    groups: [],
  },
  {
    key: 'build',
    label: 'Build',
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
    ],
    groups: BUILD_GROUPS,
  },
  {
    key: 'run',
    label: 'Run',
    icon: Pulse,
    href: '/',
    routes: [
      '/',
      '/spaces',
      '/approvals',
      '/logs',
      '/automations',
      '/llm-providers',
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
