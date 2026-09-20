// sidebar-nav.ts — LES CINQ DESTINATIONS DE LA BARRE LATÉRALE (#258).
//
// Le propriétaire a redessiné la barre le 19/09/2026 au soir, dans un nouveau
// fichier Figma : `WPLtjoJjXJBEqDyCpLy9xc`, nœud `25:1062`, cinq planches côte
// à côte, une par destination. Ces planches sont la SPEC.
//
// ⚠️ LEURS NOMS DE CALQUES SONT PÉRIMÉS. Les cinq cadres sont des copies des
// planches 4a, jamais renommées : ils s'appellent tous « 4a · Talk », les cases
// du rail « rail/Talk » et « rail/Build », les sections de Run
// « section/AUTOMATE » alors qu'elles affichent CRON et WEBHOOKS, et presque
// toutes les lignes « row/Suivis Candidatures ». Seuls le TEXTE rendu et la
// GÉOMÉTRIE font foi. Qui relira la planche par ses noms lira l'ancienne.
//
// Ce qui change depuis #230 :
//
//   - trois destinations deviennent CINQ : Approvals et Settings quittent
//     l'état de case sans panneau pour en avoir un ;
//   - « Agent » redevient « Agents », au pluriel, et sa section ouvre par un
//     dossier dépliable qui liste les agents ;
//   - Run ne montre plus ce qu'on surveille mais ce qu'on PROGRAMME : les
//     automatisations et les webhooks, chacun sous un titre portant un « + » ;
//   - Logs quitte les panneaux pour le rail, d'où il NAVIGUE ;
//   - les espaces de travail cessent d'être un dossier dépliable pour devenir
//     les lignes mêmes de la section WORKSPACES.
//
// ⚠️ UNE SECTION DISPARAÎT DES PLANCHES : RECENT, les cinq derniers fils tous
// canaux confondus livrés en #230. Le propriétaire ne la redessine pas, et
// « Nodal chats » déplié tient le rôle pour les conversations du tableau de
// bord. Dit ici, et dans la PR, plutôt que découvert plus tard.
//
// ⚠️ ET UNE ENTRÉE REVIENT CONTRE LA PLANCHE : « Dashboard ». Aucune des cinq
// ne la dessine — elles l'OMETTENT, sans dire de la retirer. Une page qu'on
// n'atteint plus que par son adresse est exactement le constat que la revue a
// posé sur la PR de l'écran d'accueil, et on ne le rouvre pas : la ligne
// ouvre le panneau Run, au-dessus du premier titre, là où la planche ne
// dessine aucune section (décision de l'orchestrateur, 19/09 au soir).

import {
  BookOpen,
  Brain,
  BookOpenText,
  ChatCircleText,
  Cube,
  CheckCircle,
  DiscordLogo,
  GearSix,
  Key,
  Lightbulb,
  Plug,
  PlugsConnected,
  Pulse,
  SealCheck,
  ShieldCheck,
  Sparkle,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';

/** Une entrée du panneau : une destination interne du tableau de bord. */
export type PanelItem = {
  href: string;
  label: string;
  icon: PhosphorIcon;
  /**
   * La TEINTE de l'icône, quand la planche en donne une (25:1062, 20/09) :
   * lime pour ce qui touche aux agents, corail pour les skills, bleu pour ce
   * qu'on branche. Absente, l'icône est grise comme le libellé.
   */
  tone?: 'agent' | 'skill' | 'conn';
};

/**
 * Une LISTE qui n'existe qu'en base, et que le panneau lit à l'exécution.
 *
 * Elle est NOMMÉE ici plutôt que devinée dans le rendu : la table dit ce que
 * chaque section contient, et le panneau ne fait que le dessiner.
 */
export type PanelDynamic =
  | 'workspaces'
  | 'channels'
  | 'agents'
  | 'cron'
  | 'webhooks'
  | 'approvals'
  | 'recents';

/** Un bloc du panneau, sous son titre en capitales. */
export type PanelGroup = {
  /**
   * Le titre du bloc. ABSENT pour le bloc qui ouvre un panneau SANS titre —
   * la ligne « Dashboard » de Run est dans ce cas, la planche ne lui en
   * dessinant aucun.
   */
  section?: string;
  /** La liste lue en base, rendue EN TÊTE du bloc, avant ses entrées écrites. */
  dynamic?: PanelDynamic;
  items: readonly PanelItem[];
  /**
   * Le « + » du titre de section : où il mène, et ce qu'il promet. La planche
   * le dessine sur CRON et sur WEBHOOKS, et nulle part ailleurs.
   */
  add?: { href: string; label: string };
};

/** Laquelle des cinq destinations du rail. */
export type DestinationKey = 'work' | 'agents' | 'run' | 'approvals' | 'settings';

export type Destination = {
  key: DestinationKey;
  /** Le libellé du rail ET le titre du panneau : un seul mot, le même. */
  label: string;
  icon: PhosphorIcon;
  /** Où mène le clic sur la destination. */
  href: string;
  /**
   * Les préfixes de route qui allument cette destination. `/` ne vaut QUE pour
   * lui-même — sans quoi il préfixerait toutes les autres.
   */
  routes: readonly string[];
  groups: readonly PanelGroup[];
  /**
   * La case vit-elle AU BAS du rail, sous la séparation ?
   *
   * Settings est le seul cas : c'est une destination comme les quatre autres —
   * elle ouvre un panneau — mais la planche la range en bas, avec Logs et
   * Help, parce qu'on y va pour régler le produit et non pour travailler. Le
   * dire ici plutôt que dans le rail fait que la table décrit le rail EN
   * ENTIER, et qu'un test peut l'énumérer sans connaître un cas particulier.
   */
  foot?: true;
};

/**
 * Le panneau WORK — là où l'on travaille.
 *
 * Deux blocs, tous deux LUS EN BASE : les espaces de travail, puis les canaux
 * d'où les conversations arrivent. Aucune entrée écrite.
 */
const WORK_GROUPS: readonly PanelGroup[] = [
  { section: 'Projects', dynamic: 'workspaces', items: [] },
  { section: 'Channels', dynamic: 'channels', items: [] },
];

/**
 * Le panneau AGENTS — ce qu'on monte, puis ce qu'on y branche.
 *
 * Le bloc AGENTS ouvre par un DOSSIER dépliable qui liste les agents, puis
 * porte ce qu'ils savent faire et ce dont ils se souviennent.
 */
const AGENTS_GROUPS: readonly PanelGroup[] = [
  {
    section: 'Agents',
    dynamic: 'agents',
    items: [
      { href: '/skills', label: 'Skills', icon: BookOpenText, tone: 'skill' },
      { href: '/learned-skills', label: 'Learned Skills', icon: Lightbulb, tone: 'skill' },
      { href: '/memories', label: 'Memory', icon: Brain },
    ],
  },
  {
    section: 'Connect',
    items: [
      { href: '/connectors', label: 'API Connectors', icon: Plug, tone: 'conn' },
      { href: '/mcp', label: 'MCP Connectors', icon: PlugsConnected, tone: 'conn' },
      { href: '/credentials', label: 'Credentials', icon: Key },
    ],
  },
];

/**
 * Le panneau RUN — ce qu'on programme.
 *
 * Les deux façons de déclencher un agent sans lui parler : une horloge, ou un
 * appel venu de dehors. Chaque titre porte un « + » vers la page où l'on en
 * crée un.
 */
const RUN_GROUPS: readonly PanelGroup[] = [
  {
    section: 'Cron',
    dynamic: 'cron',
    items: [],
    add: { href: '/automations', label: 'New automation' },
  },
  {
    section: 'Webhooks',
    dynamic: 'webhooks',
    items: [],
    add: { href: '/automations', label: 'New webhook' },
  },
];

/** Le panneau APPROVALS — ce qui attend une réponse, puis ce qui en a reçu une. */
const APPROVALS_GROUPS: readonly PanelGroup[] = [
  { section: 'Approvals', dynamic: 'approvals', items: [] },
  { section: 'Recents', dynamic: 'recents', items: [] },
];

/**
 * Le panneau SETTINGS — les familles de la page des réglages.
 *
 * ⚠️ « INSTALL » N'EST PAS UNE FAMILLE, et la planche en dessine une. Les
 * familles sont `access`, `safety`, `workspace` et `advanced`
 * (`settings/settings-rows.ts`) ; « Install notes » est une LIGNE de la famille
 * `workspace`. La planche la sort donc au premier plan, et laisse `advanced` de
 * côté. Décision de l'orchestrateur du 19/09 au soir : les quatre lignes de la
 * planche, chacune menant à quelque chose de RÉEL.
 *
 * Chaque ligne ouvre la PREMIÈRE entrée de sa famille (`/settings?open=…`),
 * parce que c'est le seul point d'entrée que la page connaisse : elle ouvre un
 * RÉGLAGE, pas une famille. On atterrit donc dans la bonne famille, sur son
 * premier réglage, et jamais sur une page qui ignorerait ce qu'on a cliqué.
 */
const SETTINGS_GROUPS: readonly PanelGroup[] = [
  {
    section: 'Settings',
    items: [
      { href: '/settings?open=sign-in', label: 'Access', icon: Key },
      { href: '/settings?open=auto-run-brake', label: 'Safety', icon: ShieldCheck },
      { href: '/settings?open=timezone', label: 'Workspace', icon: Cube },
      { href: '/llm-providers', label: 'LLM Providers', icon: Sparkle },
      { href: '/settings?open=install-notes', label: 'Install', icon: PlugsConnected },
    ],
  },
];

/**
 * Les cinq destinations, dans l'ordre du rail.
 *
 * Work d'abord : c'est là qu'on travaille, et c'est la raison d'être du
 * produit. Approvals ferme le groupe du haut parce que c'est la seule qui
 * compte quelque chose.
 */
export const DESTINATIONS: readonly Destination[] = [
  {
    key: 'work',
    label: 'Work',
    icon: ChatCircleText,
    href: '/',
    // `/` allume Work (#248) : la racine est un fil vide, donc l'endroit où
    // l'on travaille. `/spaces` aussi, puisque les espaces sont dans ce
    // panneau — une destination qui ne s'allume pas sur la page qu'elle porte
    // se lit comme un menu cassé.
    routes: ['/', '/chat', '/spaces'],
    groups: WORK_GROUPS,
  },
  {
    key: 'agents',
    label: 'Agents',
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
    groups: AGENTS_GROUPS,
  },
  {
    key: 'run',
    label: 'Run',
    icon: Pulse,
    // `/dashboard`, et non `/` (issue #248) ni `/automations`. La case du rail
    // est un LIEN, et elle mène là où mène la PREMIÈRE LIGNE de son panneau —
    // « Dashboard », que le propriétaire a fait revenir en tête de Run le
    // 19/09 au soir. Tant que la racine ÉTAIT le tableau de bord, `/` faisait
    // l'affaire ; elle rend un fil vide depuis #248, et cliquer Run emmenait
    // alors sur Work, qui s'allumait à sa place — un rail qui répond à côté.
    href: '/automations',
    routes: [
      // Le tableau de bord OUVRE la liste : c'est la première ligne du
      // panneau, donc l'adresse de la destination.
      '/dashboard',
      '/automations',
      // Les pages d'un run et d'un espace de travail. On y arrive depuis une
      // liste, jamais depuis le menu (#143 les fusionnera dans Workspaces).
      '/jobs',
      '/runs',
      '/code',
    ],
    groups: RUN_GROUPS,
  },
  {
    key: 'approvals',
    label: 'Approvals',
    // Un rond COCHÉ, et plus un bouclier (planche v2) : le bouclier disait
    // « on te protège », alors que ce panneau montre ce que l'on VALIDE.
    icon: CheckCircle,
    href: '/approvals',
    routes: ['/approvals'],
    groups: APPROVALS_GROUPS,
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: GearSix,
    href: '/llm-providers',
    routes: ['/settings', '/llm-providers'],
    groups: SETTINGS_GROUPS,
    foot: true,
  },
];

/**
 * Ce que le rail porte EN BAS, sous la séparation : ce qui n'ouvre pas de
 * panneau.
 *
 * Logs NAVIGUE — sa page est une liste, elle n'a rien à déplier dans une
 * colonne de 300 px. Help ouvre une CARTE de trois liens, tous dehors.
 *
 * ⚠️ POURQUOI UNE CARTE, ET PAS UN LIEN. La planche ne dessine que la CASE,
 * jamais ce qu'elle ouvre : elle ne dit donc rien du nombre de liens, et en
 * faire un raccourci vers la documentation seule aurait retiré du produit le
 * serveur Discord et le portail qualité, qui vivaient dans le groupe « About
 * Nodal-Agents » de la 0.8.11 puis dans la carte Help de #230. Décision du
 * propriétaire, 20/09/2026 : les trois restent, dans la carte.
 */
export const RAIL_FOOT = {
  logs: { href: '/logs', label: 'Logs' },
  /**
   * Les trois endroits qui parlent DU PRODUIT, et qui sont tous hors de
   * l'application. Les adresses sont celles que la 0.8.11 utilisait déjà ;
   * aucune n'est inventée ici.
   */
  help: [
    { href: 'https://kwintspiracy.github.io/nodal-agents/', label: 'Docs', icon: BookOpen },
    { href: 'https://discord.gg/7UZsvZPgU', label: 'Discord', icon: DiscordLogo },
    {
      href: 'https://kwintspiracy.github.io/nodal-agents/qa/',
      label: 'Quality portal',
      icon: SealCheck,
    },
  ],
} as const;

/**
 * La destination que la route DÉSIGNE, ou `null` quand aucune ne la reconnaît.
 *
 * Le préfixe LE PLUS LONG gagne : `/mcp` et `/memories` ne se confondent pas,
 * et une route couverte par deux destinations ne dépendrait pas de l'ordre de
 * la table. `/` ne vaut que pour lui-même.
 *
 * `null` est un fait, pas un trou : c'est la réponse sur `/logs`, dont la case
 * vit au bas du rail et n'ouvre aucun panneau.
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
 * Celle que la route désigne, sinon WORK. Le panneau doit bien montrer quelque
 * chose, et Work porte la racine du produit. Un panneau vide serait pire, et
 * « la dernière destination visitée » ferait deux écrans différents pour la
 * même adresse.
 */
export function destinationForPath(pathname: string): Destination {
  return matchedDestination(pathname) ?? workDestination();
}

/** Une route est-elle celle-ci, ou dedans ? Jamais un préfixe de mot. */
function isUnder(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(route + '/');
}

/** Work, la destination de repli. Lue dans la table, jamais réécrite. */
function workDestination(): Destination {
  const work = DESTINATIONS.find((d) => d.key === 'work');
  // La table est une constante de ce module : l'absence de `work` serait une
  // faute de frappe, pas un cas d'exécution. On le dit fort (invariant #4).
  if (work === undefined) throw new Error('sidebar-nav: no "work" destination');
  return work;
}

/**
 * L'entrée du panneau qui correspond à la route — CHEMIN ET PARAMÈTRES.
 *
 * ⚠️ UNE ENTRÉE QUI PORTE UN PARAMÈTRE SE COMPARE SUR CE PARAMÈTRE. Les quatre
 * lignes de Settings mènent toutes à `/settings`, chacune avec un `?open=`
 * différent. Les comparer sur le chemin seul allumait les QUATRE d'un coup —
 * quatre lignes qui se disent toutes « la page où vous êtes », ce qui ne veut
 * plus rien dire (passe 1 de la revue de la PR #279). Les comparer sur la
 * chaîne entière n'en allumait aucune, jamais, même sur la bonne : la route
 * porte bien `?open=timezone`, mais `usePathname` s'arrête au chemin.
 *
 * La règle tient donc en deux temps : le chemin doit correspondre, et CHAQUE
 * paramètre que l'entrée écrit doit se retrouver, avec la même valeur, dans
 * ceux de la route. Sur `/settings?open=timezone`, seule « Workspace »
 * s'allume ; sur `/settings` nu, aucune — ce que la planche dessine.
 *
 * Une entrée SANS paramètre ne regarde pas ceux de la route : `/skills`
 * s'allume sur `/skills?tab=installed` comme sur `/skills`, et c'est bien la
 * même page.
 */
export function isPanelItemActive(href: string, pathname: string, search = ''): boolean {
  const [chemin = href, query] = href.split('?');
  if (query === undefined || query === '') {
    if (chemin === '/') return pathname === '/';
    return isUnder(pathname, chemin);
  }
  // Le chemin EXACT : une entrée paramétrée désigne un état d'une page, pas
  // une branche de routes, et `/settings?open=x` ne couvre pas `/settings/y`.
  if (pathname !== chemin) return false;
  const courants = new URLSearchParams(search);
  for (const [cle, valeur] of new URLSearchParams(query)) {
    if (courants.get(cle) !== valeur) return false;
  }
  return true;
}
