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
// OUVERT PAR DÉFAUT, À CHAQUE OUVERTURE DE PAGE, et la personne le referme si
// elle veut, pour cette page-là. Le choix ne tient PLUS d'une visite à l'autre
// (Quentin, 20/09) : mémorisé dans le navigateur, il s'appliquait après le
// montage, et un panneau rendu ouvert par le serveur se refermait sous les
// yeux une image plus tard, à chaque projet cliqué. Un flash à chaque
// navigation coûte plus qu'un clic pour refermer.

import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { FolderOpen, X } from '@phosphor-icons/react';
import IconButton from '@/components/ui/IconButton';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { useLayer } from '@/lib/layers.ts';

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
   * `/spaces/[id]/files` — cette adresse est dans des liens déjà envoyés et
   * dans la barre d'un run, et elle veut dire « montre-moi le dossier ». Le
   * panneau étant ouvert par défaut partout, elle ne change plus rien ; elle
   * reste acceptée pour que ces liens continuent de mener quelque part.
   */
  forceOpen = false,
  children,
}: {
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  void forceOpen;

  return (
    <PanelContext.Provider
      value={{ open, toggle: () => setOpen((o) => !o), close: () => setOpen(false) }}
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
      // Une COLONNE à côté du contenu, collante : son haut s'aligne sur la
      // rangée d'actions (même `pt-6` que le corps), jamais sur l'en-tête, et
      // elle suit le défilement. Sur un écran étroit elle passe sous la liste.
      //
      // ELLE NE POUSSE LE CONTENU QUE S'IL LE FAUT (Quentin, 20/09). La
      // colonne de contenu fait au plus 1152 px, centrée dans la zone
      // principale (la fenêtre moins les 372 px de la barre). Tant que la zone
      // a de quoi loger la colonne centrée ET la carte à droite — à partir de
      // 2372 px de fenêtre — la carte se pose PAR-DESSUS la marge libre
      // (marge négative de sa largeur plus l'écart) et le contenu reste au
      // milieu de la page. En dessous, elle prend sa place dans la rangée et
      // le contenu se recentre dans ce qui reste, donc glisse vers la gauche.
      className="mt-6 flex max-h-[70vh] flex-col overflow-hidden rounded-xl border border-rule bg-paper shadow-[0_12px_32px_rgba(0,0,0,0.28)] lg:sticky lg:top-6 lg:mt-0 lg:max-h-[calc(100vh-48px)] lg:w-[400px] lg:shrink-0 lg:self-start min-[2372px]:-ml-[424px]"
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
 * Le CORPS de la page : à gauche la colonne de contenu — la rangée d'actions
 * puis la liste — EXACTEMENT aux mesures des autres pages (la boîte de
 * `PageShell` : `max-w-6xl` gouttières comprises, centrée) ; à droite, quand
 * il est ouvert, le panneau en colonne collante. La colonne de contenu se
 * centre dans la place qui lui reste (planche 498:5776 : la liste au milieu
 * de l'espace à gauche de la carte).
 */
export function ProjectPanelBody({
  actions,
  panel,
  children,
}: {
  /** La rangée d'actions de la page, au-dessus du contenu, alignée à droite. */
  actions?: ReactNode;
  /** Le panneau « Files & proof », rendu à côté de la colonne. */
  panel?: ReactNode;
  children: ReactNode;
}) {
  return (
    // Les gouttières sont celles du `PageShell` (la page est `fluid`, son corps
    // garde `px-5 sm:px-8 lg:px-9`) : la colonne n'en remet PAS, et sa largeur
    // maximale est celle du CONTENU des autres pages — leur boîte de 1152 px
    // moins ses deux gouttières de 36 — pour que la liste fasse exactement la
    // largeur d'une liste ailleurs (Quentin, 20/09 : « pas la même taille que
    // les autres pages »).
    <div
      data-testid="project-body"
      className="flex flex-col items-stretch lg:flex-row lg:items-start lg:gap-6"
    >
      <div className="min-w-0 flex-1">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-4">
          {actions}
          {children}
        </div>
      </div>
      {panel}
    </div>
  );
}
