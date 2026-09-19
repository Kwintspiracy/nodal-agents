'use client';

// ProjectPanel — « Files & proof » vit dans un PANNEAU, plus dans un onglet
// (#143, Quentin 19/09).
//
// Un onglet oblige à quitter l'écran pour voir le dossier, et à le quitter de
// nouveau pour revenir aux conversations. Le panneau ancré à droite les met
// CÔTE À CÔTE : il pousse la page au lieu de la couvrir, la liste reste
// visible et cliquable, et on passe d'une ligne à l'autre sans rien fermer.
// C'est le même motif que la page Settings reçoit (planche P1, issue #231), et
// c'est le composant partagé `DockedPanel` qui le dessine.
//
// L'état est PARTAGÉ entre deux endroits de la page : le bouton, qui vit dans
// la barre d'outils du `PageShell`, et le panneau, qui vit dans le corps. D'où
// le contexte — les deux sont rendus par des branches différentes de l'arbre,
// et se passer l'état par props demanderait de le faire traverser `PageShell`.
//
// OUVERT PAR DÉFAUT, et la personne décide ensuite. Son choix tient dans son
// navigateur (`localStorage`) : c'est une préférence d'affichage, elle ne
// concerne qu'elle et elle n'a pas besoin de voyager. Le serveur rend donc
// toujours l'état par défaut, et le choix s'applique après le montage — un
// panneau fermé s'affiche une image avant de se replier. C'est le prix d'une
// préférence qui ne fait pas d'aller-retour, et il est payé une fois par
// ouverture de page.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { FolderOpen } from '@phosphor-icons/react';
import DockedPanel from '@/components/ui/DockedPanel';
import PrimaryButton from '@/components/ui/PrimaryButton';

/** La clé du choix, une seule pour tous les projets : c'est une habitude de lecture. */
const STORAGE_KEY = 'nodal.project-panel-open';

type PanelState = { open: boolean; toggle: () => void; close: () => void };

const PanelContext = createContext<PanelState | null>(null);

function usePanel(): PanelState {
  const ctx = useContext(PanelContext);
  // Un bouton ou un panneau rendu hors du fournisseur ne « marche à moitié »
  // pas : il le dit (invariant #4).
  if (ctx === null) throw new Error('ProjectPanel: used outside ProjectPanelProvider');
  return ctx;
}

export function ProjectPanelProvider({
  /**
   * Force l'ouverture, quel que soit le choix mémorisé. C'est ce que rend
   * `/spaces/[id]/files` : cette adresse est dans des liens déjà envoyés et
   * dans la barre d'un run, et elle veut dire « montre-moi le dossier ». La
   * personne peut refermer ensuite, et son choix redevient le sien.
   */
  forceOpen = false,
  children,
}: {
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (forceOpen) return;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(window.localStorage.getItem(STORAGE_KEY) !== 'closed');
    } catch {
      // Un navigateur qui refuse le stockage (navigation privée, réglage) ne
      // doit pas emporter l'écran : on reste sur le défaut.
    }
  }, [forceOpen]);

  function remember(next: boolean): void {
    setOpen(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'open' : 'closed');
    } catch {
      // Le choix ne survivra pas au rechargement, et c'est tout : l'écran, lui,
      // obéit tout de suite.
    }
  }

  return (
    <PanelContext.Provider
      value={{ open, toggle: () => remember(!open), close: () => remember(false) }}
    >
      {children}
    </PanelContext.Provider>
  );
}

/** Le bouton de la barre d'outils. Il DIT ce qu'il va faire, pas où l'on est. */
export function ProjectPanelButton() {
  const { open, toggle } = usePanel();
  return (
    <PrimaryButton
      variant="neutral"
      size="sm"
      onClick={toggle}
      aria-expanded={open}
      data-testid="project-panel-toggle"
    >
      <FolderOpen size={14} aria-hidden />
      {open ? 'Hide files & proof' : 'Files & proof'}
    </PrimaryButton>
  );
}

/**
 * Le corps de la page et le panneau, CÔTE À CÔTE.
 *
 * `DockedPanel` est un enfant flex dimensionné en pixels : son parent doit
 * être la rangée qui porte les deux. C'est cette rangée-là, et c'est elle qui
 * donne au panneau sa pleine hauteur sous l'en-tête.
 */
export function ProjectPanelLayout({
  title,
  panel,
  children,
}: {
  title: string;
  panel: ReactNode;
  children: ReactNode;
}) {
  const { open, close } = usePanel();
  return (
    <div className="flex min-h-0 flex-1">
      <main className="min-w-0 flex-1 overflow-y-auto px-5 pt-5 pb-10 sm:px-8 lg:px-9">
        {children}
      </main>
      <DockedPanel open={open} onClose={close} title={title} testId="project-files-panel">
        {panel}
      </DockedPanel>
    </div>
  );
}
