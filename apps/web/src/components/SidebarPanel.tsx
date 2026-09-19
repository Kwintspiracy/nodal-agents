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
// ⚠️ LE TITRE ET LE SÉLECTEUR D'ESPACE SONT SUR DEUX LIGNES, alors que la
// planche les met côte à côte. Le sélecteur écrit le NOM de l'espace, qui n'est
// pas « Local » chez tout le monde ; dans les 140 px qui resteraient à côté du
// titre, il se couperait au deuxième mot. Une ligne chacun coûte 38 px de haut
// et ne ment sur rien.

import { Suspense } from 'react';
import SidebarSection from './ui/SidebarSection';
import SidebarLink from './ui/SidebarLink';
import ChatFolderGroup from './ChatFolderGroup';
import RecentThreads from './RecentThreads';
import VersionBadge from './VersionBadge';
import LiveCard from './ui/LiveCard';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { useApprovals } from './ApprovalsProvider';
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
  const { pending } = useApprovals();
  const pendingCount = pending.length;

  return (
    <nav
      // Nommé par la destination : un lecteur d'écran annonce « Talk,
      // navigation » et sait donc de quel menu il s'agit, à côté du rail qui
      // s'annonce « Sections ».
      aria-label={destination.label}
      data-testid="sidebar-panel"
      className="flex h-full min-w-0 flex-1 flex-col bg-sidebar pt-4 pb-3 lg:w-[var(--panel-w)] lg:flex-none"
    >
      <div className="px-3.5 pb-1">
        <h2 className="truncate text-title-16 text-ink">{destination.label}</h2>
      </div>

      <WorkspaceSwitcher workspaces={[...workspaces]} />

      <div className="flex flex-1 flex-col overflow-y-auto py-1.5">
        {destination.key === 'talk' ? (
          <>
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
        ) : (
          destination.groups.map((group) => (
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
                  dot={it.dot}
                  // La pastille corail d'Approvals : ce qui attend la personne,
                  // cachée à zéro — une pastille « 0 » demande de la lire pour
                  // apprendre qu'il n'y a rien.
                  pill={it.href === '/approvals' && pendingCount > 0 ? pendingCount : undefined}
                  isActive={isPanelItemActive(it.href, pathname)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* La version, et la proposition de mise à jour quand npm en sert une
          plus récente. Elle ferme le panneau, comme sur la planche. */}
      <VersionBadge />

      {/* Emplacement de la carte « ça tourne » — le primitif est en place pour
          le jour où la télémétrie sera branchée. */}
      <LiveCard runningAgents={undefined} />
    </nav>
  );
}
