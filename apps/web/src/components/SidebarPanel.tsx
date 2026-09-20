'use client';

// SidebarPanel — la colonne de 300 px qui montre la destination active (#230,
// refondue en #258).
//
// Elle porte le titre de la destination et le sélecteur d'espace sur une
// ligne, puis les blocs du panneau : des titres de section, des entrées
// ÉCRITES (la table `sidebar-nav`) et des listes LUES en base.
//
// ⚠️ LE PANNEAU NE CONNAÎT AUCUNE DESTINATION. Il lit `destination.groups`, et
// chaque groupe dit ce qu'il porte : un titre, un « + », des entrées écrites,
// et le NOM d'une liste dynamique. Ce fichier ne fait que brancher ce nom sur
// le composant qui sait le lire. C'est ce qui permet d'ajouter une section à
// un panneau sans toucher au rendu, et de tester la table sans monter React.
//
// ⚠️ SA LARGEUR NE BOUGE JAMAIS (`--panel-w`). Un titre long se coupe
// (`truncate` sur chaque libellé) ; s'il élargissait la colonne, toute la page
// se décalerait en ouvrant un dossier — et la mesure que la page lit
// (`--sidebar-w`) serait fausse une ligne plus tard.
//
// ⚠️ LE TITRE ET LE SÉLECTEUR D'ESPACE SONT SUR UNE SEULE LIGNE : le titre à
// gauche, l'espace en CAPSULE à droite. C'est la tête de #230, gardée telle
// quelle — les cinq planches v2 écrivent « Talk » à cet endroit sur TOUTES,
// y compris celles de Run et de Settings, ce qui est le reste d'une copie et
// non une demande (les cadres sont des duplicatas jamais renommés).

import { Suspense, type ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';
import SidebarSection from './ui/SidebarSection';
import SidebarLink from './ui/SidebarLink';
import ChatFolderGroup from './ChatFolderGroup';
import WorkspacesList from './sidebar/WorkspacesList';
import AgentsFolder from './sidebar/AgentsFolder';
import CronList from './sidebar/CronList';
import WebhooksList from './sidebar/WebhooksList';
import ApprovalsList from './sidebar/ApprovalsList';
import RecentApprovals from './sidebar/RecentApprovals';
import LiveCard from './ui/LiveCard';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { isPanelItemActive, type Destination, type PanelDynamic } from './sidebar-nav.ts';
import type { WorkspaceRow } from '@/lib/actions';

/**
 * Le nom d'une liste, et le composant qui la lit.
 *
 * Une TABLE, et pas une suite de `if` : elle se relit d'un coup d'œil, et
 * TypeScript refuse qu'un nom de `PanelDynamic` y manque. Ajouter une liste au
 * type sans la brancher ici ne compile pas.
 */
const DYNAMIC: Record<PanelDynamic, () => ReactElement> = {
  workspaces: () => <WorkspacesList />,
  // Sous <Suspense> : le groupe lit `useSearchParams`, et sans frontière Next
  // fait attendre tout le panneau.
  channels: () => (
    <Suspense fallback={null}>
      <ChatFolderGroup />
    </Suspense>
  ),
  agents: () => <AgentsFolder />,
  cron: () => <CronList />,
  webhooks: () => <WebhooksList />,
  approvals: () => <ApprovalsList />,
  // Sous <Suspense> : la section lit `?show=` pour allumer la ligne dont la
  // carte est ouverte, et Next veut `useSearchParams` sous une frontière.
  recents: () => (
    <Suspense fallback={null}>
      <RecentApprovals />
    </Suspense>
  ),
};

/**
 * Les entrées ÉCRITES d'un bloc, et la ligne allumée parmi elles.
 *
 * À part pour une raison : elles sont les seules du panneau à dépendre des
 * PARAMÈTRES de la route, et `useSearchParams` fait basculer son sous-arbre en
 * rendu client. L'isoler ici garde le rail, la tête et les listes lues hors de
 * cette frontière (le même geste que `ChatFolderGroup` depuis #230).
 */
function PanelItems({
  group,
  pathname,
  search,
}: {
  group: Destination['groups'][number];
  pathname: string;
  search: string;
}) {
  return (
    <>
      {group.items.map((it) => (
        <SidebarLink
          key={it.href}
          href={it.href}
          label={it.label}
          icon={<it.icon size={20} className="h-5 w-5 lg:h-3.5 lg:w-3.5" />}
          tone={it.tone}
          isActive={isPanelItemActive(it.href, pathname, search)}
        />
      ))}
    </>
  );
}

/** Les mêmes, avec les paramètres que la route porte vraiment. */
function PanelItemsLive({
  group,
  pathname,
}: {
  group: Destination['groups'][number];
  pathname: string;
}) {
  const search = useSearchParams().toString();
  return <PanelItems group={group} pathname={pathname} search={search} />;
}

export default function SidebarPanel({
  destination,
  pathname,
  workspaces,
}: {
  destination: Destination;
  pathname: string;
  workspaces: readonly WorkspaceRow[];
}) {
  return (
    <nav
      // Nommé par la destination : un lecteur d'écran annonce « Work,
      // navigation » et sait donc de quel menu il s'agit, à côté du rail qui
      // s'annonce « Sections ».
      aria-label={destination.label}
      data-testid="sidebar-panel"
      // 8 px de côté, 16 en haut, 12 en bas, et 2 px entre les blocs : les
      // mesures de la planche. Les lignes sont pleine largeur DEDANS, ce qui
      // aligne leur icône sur le titre de leur section.
      className="flex h-full min-w-0 flex-1 flex-col gap-0.5 bg-sidebar px-2 pt-4 pb-3 lg:w-[var(--panel-w)] lg:flex-none"
    >
      {/* La tête : 6 px à gauche, 2 px à droite, 4 px en dessous. Le titre
          prend la place qui reste et se coupe ; la capsule garde la sienne. */}
      <div className="flex items-center gap-2 pb-1 pl-1.5">
        <h2 className="min-w-0 flex-1 truncate text-title-16 text-ink">{destination.label}</h2>
        <WorkspaceSwitcher workspaces={[...workspaces]} compact />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {destination.groups.map((group, i) => (
          // Le groupe se DÉSIGNE par son titre : l'ordre de ses entrées est
          // une décision produit, et un test qui le lit doit pouvoir nommer le
          // groupe plutôt que compter des lignes depuis le haut du panneau. Le
          // seul groupe SANS titre — la ligne « Dashboard » de Run — se
          // désigne par sa place, faute de nom.
          <div key={group.section ?? `group-${i}`} data-testid={`nav-group-${group.section ?? i}`}>
            {group.section !== undefined && (
              <SidebarSection add={group.add}>{group.section}</SidebarSection>
            )}

            {group.dynamic !== undefined && DYNAMIC[group.dynamic]()}

            {/* Sous <Suspense> : ces lignes lisent les PARAMÈTRES de la route
                (`?open=` des réglages), et Next veut voir `useSearchParams`
                sous une frontière. Le repli dessine les MÊMES lignes sans
                paramètre — donc aucune allumée — plutôt que rien : un menu qui
                disparaîtrait le temps d'un rendu se remarquerait, un menu
                allumé une fraction de seconde plus tard, non. */}
            <Suspense fallback={<PanelItems group={group} pathname={pathname} search="" />}>
              <PanelItemsLive group={group} pathname={pathname} />
            </Suspense>
          </div>
        ))}
      </div>

      {/* Emplacement de la carte « ça tourne » — le primitif est en place pour
          le jour où la télémétrie sera branchée. */}
      <LiveCard runningAgents={undefined} />
    </nav>
  );
}
