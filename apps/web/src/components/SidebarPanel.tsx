'use client';

// SidebarPanel — la colonne de 226 px qui montre la destination active (#230).
//
// Elle porte le titre de la destination, le sélecteur d'espace, le contenu du
// panneau, puis la version du produit tout en bas.
//
// ⚠️ SA LARGEUR NE BOUGE JAMAIS (`--panel-w`). Un titre de fil long se coupe
// (`truncate` sur chaque libellé) ; s'il élargissait la colonne, toute la page
// se décalerait en ouvrant un dossier — et la mesure que la page lit
// (`--sidebar-w`) serait fausse une ligne plus tard.
//
// ⚠️ LE TITRE ET LE SÉLECTEUR D'ESPACE SONT SUR UNE SEULE LIGNE (planches de
// Quentin du 19/09/2026, Figma 487:5489) : le titre à gauche, l'espace en
// CAPSULE à droite. Ils tenaient sur deux lignes tant que le panneau faisait
// 226 px ; à 280 px la capsule a la place, et le nom d'un espace long s'y
// coupe au lieu de pousser le titre.

import { Suspense } from 'react';
import SidebarSection from './ui/SidebarSection';
import SidebarLink from './ui/SidebarLink';
import ChatFolderGroup from './ChatFolderGroup';
import WorkspacesFolder from './WorkspacesFolder';
import RecentThreads from './RecentThreads';
import VersionBadge from './VersionBadge';
import LiveCard from './ui/LiveCard';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { isPanelItemActive, type Destination } from './sidebar-nav.ts';
import type { WorkspaceRow } from '@/lib/actions';

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
      // Nommé par la destination : un lecteur d'écran annonce « Talk,
      // navigation » et sait donc de quel menu il s'agit, à côté du rail qui
      // s'annonce « Sections ».
      aria-label={destination.label}
      data-testid="sidebar-panel"
      // 8 px de côté, 16 en haut, 12 en bas, et 2 px entre les blocs : les
      // mesures de la planche. Les lignes sont pleine largeur DEDANS, ce qui
      // aligne leur icône sur le titre de leur section.
      className="flex h-full min-w-0 flex-1 flex-col gap-0.5 bg-sidebar px-2 pt-4 pb-3 lg:w-[var(--panel-w)] lg:flex-none"
    >
      {/* La tête : 6 px à gauche, 2 px à droite, 4 px en dessous — les mesures
          de la planche. Le titre prend la place qui reste et se coupe ; la
          capsule garde la sienne. */}
      <div className="flex items-center gap-2 pb-1 pl-1.5">
        <h2 className="min-w-0 flex-1 truncate text-title-16 text-ink">{destination.label}</h2>
        <WorkspaceSwitcher workspaces={[...workspaces]} compact />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {/* Les blocs ÉCRITS de la destination. Work en a un — ses espaces de
            travail — et il ouvre son panneau, avant les canaux. */}
        {destination.groups.map((group) => (
          // Le groupe se DÉSIGNE : l'ordre de ses entrées est une décision
          // produit, et un test qui le lit doit pouvoir nommer le groupe
          // plutôt que compter des lignes depuis le haut du panneau.
          <div key={group.section} data-testid={`nav-group-${group.section}`}>
            <SidebarSection>{group.section}</SidebarSection>
            {group.items.map((it) => (
              <SidebarLink
                key={it.href}
                href={it.href}
                label={it.label}
                icon={<it.icon size={20} className="h-5 w-5 lg:h-3.5 lg:w-3.5" />}
                // Le compte des espaces, à droite de leur ligne : la planche en
                // dessine un, et c'est le seul nombre que le panneau connaisse
                // sans rien lire — il est déjà dans ses props.
                count={
                  it.href === '/spaces' && workspaces.length > 0 ? workspaces.length : undefined
                }
                isActive={isPanelItemActive(it.href, pathname)}
              />
            ))}
          </div>
        ))}

        {destination.key === 'work' && (
          <>
            {/* WORKSPACES — un dossier, exactement comme un canal (décision du
                propriétaire, 19/09/2026 au soir) : il se plie du même geste et
                déplie ses derniers projets. Il OUVRE le panneau, avant les
                canaux : on choisit d'abord où l'on travaille. */}
            <SidebarSection>Workspaces</SidebarSection>
            <WorkspacesFolder />

            {/* CHANNELS — un dossier par endroit d'où les conversations
                arrivent. Ce sont les mêmes lignes qu'en 0.8.11 : le titre de
                section a remplacé la ligne « Channels » qui les portait, et
                rien d'autre n'a changé (#135, #206, #209).

                Sous <Suspense> : le groupe lit `useSearchParams`, et sans
                frontière Next fait attendre tout le panneau. */}
            <SidebarSection>Channels</SidebarSection>
            <Suspense fallback={null}>
              <ChatFolderGroup />
            </Suspense>
            <RecentThreads />
          </>
        )}
      </div>

      {/* La version, et la proposition de mise à jour quand npm en sert une
          plus récente. Elle ferme le panneau, alignée à gauche sur les titres
          de section, comme sur la planche. */}
      <VersionBadge />

      {/* Emplacement de la carte « ça tourne » — le primitif est en place pour
          le jour où la télémétrie sera branchée. */}
      <LiveCard runningAgents={undefined} />
    </nav>
  );
}
