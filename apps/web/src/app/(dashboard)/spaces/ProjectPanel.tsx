'use client';

// ProjectPanel — « Files & proof » vit dans un PANNEAU, plus dans un onglet
// (#143, Quentin 19/09).
//
// Un onglet oblige à quitter l'écran pour voir le dossier, et à le quitter de
// nouveau pour revenir aux conversations. Le panneau ancré à droite les met
// CÔTE À CÔTE : il pousse la page au lieu de la couvrir, la liste reste
// visible et cliquable, et on passe d'une ligne à l'autre sans rien fermer.
// C'est le même motif que la page Settings reçoit (planche P1, issue #231), et
// depuis le 20/09 la carte FLOTTE au bord droit (planche 498:5776).
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

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { FolderOpen, X } from '@phosphor-icons/react';
import IconButton from '@/components/ui/IconButton';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { useLayer } from '@/lib/layers.ts';

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

/**
 * La BASCULE de la barre d'outils.
 *
 * Son libellé ne bouge pas : il nomme la CHOSE, pas le geste. « Hide files &
 * proof » décrivait le geste, et l'écran offrait alors deux façons de fermer
 * qui se disaient différemment — ce bouton et la croix du panneau (Quentin,
 * 19/09). Un bouton pressoir dit où l'on en est par son ÉTAT (`aria-pressed`,
 * et le fond que le DS lui donne), pas par un mot qui change sous le curseur.
 */
export function ProjectPanelButton() {
  const { open, toggle } = usePanel();
  return (
    <PrimaryButton
      // Pressé = PLEIN, la façon dont le DS dit « actif » ailleurs (la
      // pastille sombre de `PillTabs`). Relâché = neutre, comme ses voisins.
      variant={open ? 'ink' : 'neutral'}
      onClick={toggle}
      aria-pressed={open}
      data-testid="project-panel-toggle"
    >
      <FolderOpen size={14} aria-hidden />
      Files &amp; proof
    </PrimaryButton>
  );
}

/** La largeur du panneau flottant, et la place qu'il prend au contenu. */
export const PROJECT_PANEL_W = 400;

/**
 * Le PANNEAU, FLOTTANT (planche 498:5776, Quentin 20/09) : une carte posée au
 * bord droit de l'écran, sous l'en-tête, avec ses coins et son ombre — pas une
 * colonne ancrée pleine hauteur qui coupait la page en deux. Il se ferme par
 * sa croix, par Échap (pile des calques), ou par le bouton de la rangée.
 *
 * Sur un écran étroit il ne flotte pas : il se pose SOUS la liste, en pleine
 * largeur, parce qu'une carte de 400 px par-dessus une colonne de 400 px
 * cacherait tout ce qu'elle est censée accompagner.
 */
export function ProjectFilesPanel({ title, children }: { title: string; children: ReactNode }) {
  const { open, close } = usePanel();
  const titleId = useId();
  useLayer(open, close);
  if (!open) return null;
  return (
    <aside
      role="complementary"
      aria-labelledby={titleId}
      data-testid="project-files-panel"
      className="mt-6 flex max-h-[70vh] flex-col overflow-hidden rounded-xl border border-rule bg-paper shadow-[0_12px_32px_rgba(0,0,0,0.28)] lg:fixed lg:top-[96px] lg:right-6 lg:bottom-6 lg:mt-0 lg:max-h-none lg:w-[400px]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule-2 py-3 pr-3 pl-5">
        <h2 id={titleId} className="min-w-0 truncate text-title-16 text-ink">
          {title}
        </h2>
        <IconButton ghost aria-label="Close" onClick={close} className="h-7 w-7">
          <X size={16} />
        </IconButton>
      </div>
      <div
        tabIndex={0}
        className="flex min-h-px flex-1 flex-col gap-3.5 overflow-y-auto p-5 focus-visible:outline-none"
      >
        {children}
      </div>
    </aside>
  );
}

/**
 * Le CORPS de la page : la rangée d'actions, puis le contenu, centrés comme
 * sur toute autre page — et décalés vers la gauche de la largeur du panneau
 * quand celui-ci flotte, pour que la colonne reste centrée dans la place qui
 * lui reste (c'est ce que la planche dessine : la liste au milieu de l'espace
 * à gauche de la carte).
 */
export function ProjectPanelBody({
  actions,
  children,
}: {
  /** La rangée d'actions de la page, au-dessus du contenu, alignée à droite. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { open } = usePanel();
  return (
    <div
      data-testid="project-body"
      className={`px-5 pt-6 pb-10 transition-[padding] sm:px-8 lg:px-9 ${open ? 'lg:pr-[440px]' : ''}`}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        {actions}
        {children}
      </div>
    </div>
  );
}
