// ThreadScreen — la charpente d'un écran de conversation (07/09).
//
// Un fil, ce n'est pas une page qui défile : c'est un ÉCRAN. L'en-tête en
// haut, le fil qui défile au milieu, la saisie ancrée en bas, la barre d'état
// sous elle, pleine largeur. Avec un document qui défile, un fil de deux
// lignes laissait la saisie et la barre au milieu de l'écran, et la saisie
// descendait à mesure qu'on écrivait (Quentin, 07/09 : « est-ce que t'as
// sincèrement déjà vu une application fonctionner comme ça ? »).
//
// Les trois écrans de fil (chat, projet, run) partagent cette charpente : la
// géométrie ne doit pas diverger d'un écran à l'autre.

import type { ReactNode } from 'react';
import ThreadScroller from './ThreadScroller.tsx';

export default function ThreadScreen({
  children,
  composer,
  statusBar,
}: {
  /** Le fil : la seule zone qui défile. */
  children: ReactNode;
  /** La saisie, ou ce qui la remplace (un mot quand on ne peut pas écrire). */
  composer?: ReactNode;
  /** La barre d'état, tout en bas, pleine largeur. */
  statusBar?: ReactNode;
}) {
  return (
    <>
      {/* `scrollbar-gutter: stable` : la gouttière de la barre est réservée
          même quand le fil tient dans l'écran, sinon le fil se recentre d'une
          demi-barre au premier message qui le fait déborder. */}
      {/* `pb-8` : au bout du fil, le dernier bloc s'arrête à 32 px de la saisie,
          pas collé dessous (Quentin, 17/09 : « augmente l'espace maximal entre
          la fin du feed et le haut du chat »). */}
      <ThreadScroller className="min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-8 [scrollbar-gutter:stable] sm:px-8 lg:px-9">
        {/* Un seul enfant : c'est LUI dont la hauteur est observée. Sans ce
            conteneur, l'observateur suivrait la zone de défilement, dont la
            hauteur ne bouge jamais — et rien ne descendrait. */}
        <div>{children}</div>
      </ThreadScroller>
      {composer !== undefined && (
        // La saisie se réserve la MÊME gouttière que le fil (`--thread-gutter`,
        // posée par ThreadScroller) : les deux boîtes de 760 px sont alors
        // centrées dans la même largeur, et leurs bords tombent l'un sur
        // l'autre. Sans ça, la saisie était décalée d'une demi-barre vers la
        // droite (Quentin, 17/09).
        <div className="relative shrink-0 px-5 pt-2 pb-3 sm:px-8 lg:px-9 mr-[var(--thread-gutter,0px)]">
          {/* Le FONDU : le fil ne se coupe plus net au ras de la saisie, il
              s'éteint sur vingt-huit pixels dans la couleur du fond, comme
              sous n'importe quelle messagerie (Quentin, 17/09 : « la
              séparation est très abrupte » ; puis « réduis un peu la hauteur
              du fondu »). Posé au-dessus de la saisie, dans sa largeur — donc
              sans la gouttière de la barre, qui reste nette — et transparent
              aux clics : on peut toujours défiler à travers. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-full h-7 bg-linear-to-t from-canvas to-transparent"
          />
          {composer}
        </div>
      )}
      {statusBar}
    </>
  );
}
