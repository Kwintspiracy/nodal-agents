'use client';

// AgentsFolder — le dossier « Agents » qui ouvre la section AGENTS (#258).
//
// La planche v2 met les agents EUX-MÊMES dans le menu : une ligne « Agents »
// qui se déplie et liste les agents de l'entité, avant Skills, Learned Skills
// et Memory. En #230, « Agent » était une entrée qui menait à la page et rien
// de plus ; on ne pouvait pas sauter à un agent sans passer par la liste.
//
// Il se plie du MÊME geste qu'un dossier de canal — cliquer le nom plie, le
// chevron aussi, le survol éclaire la ligne entière — et monte donc les mêmes
// primitifs. Deux dossiers qui se plieraient différemment dans la même colonne
// se remarqueraient tout de suite.
//
// ⚠️ IL EST DÉPLIÉ AU CHARGEMENT, et c'est le seul du produit dans ce cas.
// La planche le dessine ouvert, ses cinq agents sous les yeux, et c'est
// cohérent avec ce que ce panneau est : on n'y va pas pour « voir les
// endroits », on y va pour ouvrir un agent. Un canal replié cache des
// conversations qui se comptent par centaines ; une entité a une poignée
// d'agents.
//
// ⚠️ SES LIGNES NE PORTENT AUCUN POINT (planche, et décision du propriétaire
// du 19/09 au soir) : un agent n'a rien de non lu. Elles ont une place vide à
// la largeur d'un point, pour que leurs noms s'alignent sur ceux des autres
// sous-menus.

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { UsersThree } from '@phosphor-icons/react';
import InboxFolder from '../ui/InboxFolder';
import SidebarCaret from '../ui/SidebarCaret';
import SidebarDynamicList from './SidebarDynamicList';
import { listSidebarAgentsAction } from '@/lib/sidebar-actions.ts';

/** Où mène le dossier, et son « See all » : la page des agents. */
const HREF = '/agents';

export default function AgentsFolder() {
  const pathname = usePathname();
  const [ouvert, setOuvert] = useState(true);

  return (
    <div>
      <InboxFolder
        folderKey="agents"
        label="Agents"
        icon={<UsersThree size={14} className="h-3.5 w-3.5" />}
        waiting={0}
        running={false}
        // ACTIF sur la page des agents et sur celle d'un agent : c'est ce que
        // ce dossier porte, et c'est là qu'on se trouve.
        active={pathname === HREF || pathname.startsWith(`${HREF}/`)}
        expanded={ouvert}
        onToggle={() => setOuvert((o) => !o)}
        caret={
          <SidebarCaret
            open={ouvert}
            onToggle={() => setOuvert((o) => !o)}
            label="Agents"
            testId="folder-caret-agents"
          />
        }
      />
      {ouvert && (
        <div className="pt-0.5" data-testid="folder-threads-agents">
          <SidebarDynamicList
            testId="agents"
            read={listSidebarAgentsAction}
            hrefOf={(r) => `${HREF}/${r.id}`}
            empty="No Agent Yet"
            seeAll={HREF}
          />
        </div>
      )}
    </div>
  );
}
