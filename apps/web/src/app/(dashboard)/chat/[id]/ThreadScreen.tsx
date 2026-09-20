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
import ActionRow from '@/components/ui/ActionRow';
import ThreadScroller, { type ThreadFollow } from './ThreadScroller.tsx';

export default function ThreadScreen({
  children,
  composer,
  actions = null,
  actionsBox = '',
  follow = 'bottom',
  sidePadding = true,
}: {
  /** Le fil : la seule zone qui défile. */
  children: ReactNode;
  /** La saisie, ou ce qui la remplace (un mot quand on ne peut pas écrire). */
  composer?: ReactNode;
  /**
   * CE QUE L'ÉCRAN PERMET DE FAIRE — arrêter ce qui court (#252).
   *
   * HORS DE LA ZONE QUI DÉFILE, juste sous la barre : un fil s'ouvre par sa
   * fin, et une rangée posée en tête du contenu serait déjà remontée hors de
   * l'écran au moment où l'on cherche à s'en servir. C'est la place que la
   * règle de #242 lui donne — sa propre rangée, sous la barre — et c'est la
   * seule où elle reste sous les yeux pendant que le travail avance.
   *
   * `null` : aucune rangée, pas une rangée vide.
   */
  actions?: ReactNode;
  /**
   * LA BOÎTE de la rangée d'actions — la même que le contenu qu'elle commande
   * (Reviewer C, passe 1 de la PR #325).
   *
   * Elle n'en avait aucune, et le bouton Stop tenait le bord droit de l'écran
   * pendant que le corps d'un run s'arrêtait à 1080 px : 384 px d'écart sur un
   * écran de 1920, entre le bouton et ce qu'il arrête. Une rangée d'actions
   * s'aligne sur ce qu'elle commande, c'est la règle d'`ActionRow`.
   *
   * L'appelant la donne parce qu'elle diffère d'un écran à l'autre : le corps
   * d'un run fait 1152 px de boîte, la colonne d'un fil 760. La déduire ici
   * demanderait à cette charpente de connaître ses trois pages.
   */
  actionsBox?: string;
  /**
   * Ce que l'écran fait du bas de son contenu (voir `ThreadFollow`). Un fil se
   * lit par sa fin : il s'ouvre en bas et suit ce qui arrive. La page d'un run
   * est un tableau : elle s'ouvre en haut, sur sa carte de tête, et ne déplace
   * jamais la vue toute seule (Quentin, 18/09).
   */
  follow?: ThreadFollow;
  /**
   * Les gouttières latérales de la zone de défilement. Un fil les veut ICI :
   * sa colonne de 760 px est centrée dans ce qui reste, et la saisie se cale
   * dessus.
   *
   * La page d'un run les veut sur SON corps, et pas ici (Quentin, 18/09 : « le
   * corps est plus large que toutes les autres pages »). La raison est le
   * modèle de boîte : `PageShell` pose `max-w-6xl` ET ses gouttières sur LA
   * MÊME boîte, donc son contenu fait 1152 − 2 × 36 = 1080 px au-delà de
   * `lg`. Les poser ici et la largeur maximale là-bas faisait deux boîtes
   * emboîtées : un contenu de 1152 px, soit 72 px de plus que partout
   * ailleurs. Le corps d'un run reproduit donc la boîte de `PageShell`, et
   * cette zone ne pousse plus rien sur les côtés.
   */
  sidePadding?: boolean;
}) {
  return (
    <>
      {actions !== null && (
        // Les gouttières de la page, et la boîte que l'appelant donne : c'est ce
        // qui aligne le bouton sur le bord droit de ce qu'il arrête.
        <div className={`w-full min-w-0 shrink-0 px-5 pt-4 sm:px-8 lg:px-9 ${actionsBox}`}>
          <ActionRow>{actions}</ActionRow>
        </div>
      )}
      {/* `scrollbar-gutter: stable` : la gouttière de la barre est réservée
          même quand le fil tient dans l'écran, sinon le fil se recentre d'une
          demi-barre au premier message qui le fait déborder. */}
      {/* `pb-8` : au bout du fil, le dernier bloc s'arrête à 32 px de la saisie,
          pas collé dessous (Quentin, 17/09 : « augmente l'espace maximal entre
          la fin du feed et le haut du chat »). */}
      <ThreadScroller
        follow={follow}
        className={`min-h-0 flex-1 overflow-y-auto pt-6 pb-8 [scrollbar-gutter:stable] ${
          sidePadding ? 'px-5 sm:px-8 lg:px-9' : ''
        }`}
      >
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
    </>
  );
}
