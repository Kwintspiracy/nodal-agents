// WorkBar — LA barre d'une page de détail, sous l'en-tête (#242, 19/09/2026).
//
// Constat du propriétaire, page après page : « trop de pages n'utilisent pas
// cette barre, ce qui veut dire que ce n'est pas un système. Je suis fatigué de
// donner ce retour page après page. » La barre existait — composant Figma
// `WorkBar`, node 353:3378 — mais elle était codée SOUS un dossier de page
// (`app/(dashboard)/spaces/`), avec une API taillée pour le fil de chat. Trois
// routes de détail sur onze la rendaient ; les autres dessinaient leur propre
// retour, ou aucun.
//
// Elle vit donc ici, dans le design system, et son API ne sait rien d'un fil :
// un retour à gauche, le contexte de la page à droite. Ce qui est propre au fil
// (les avatars, le dossier, la preuve, la densité) vit dans l'enveloppe
// `spaces/ThreadWorkBar.tsx`, qui compose celle-ci.
//
// Ce que la barre NE porte PAS : les actions de la page. « Run now », « Edit »,
// « Rename » vont sur leur propre rangée EN DESSOUS (`ActionRow`). C'est le
// second constat du 19/09 : des actions sur la ligne du retour font du retour
// un bouton parmi d'autres.

import type { ReactNode } from 'react';
import BackButton from './BackButton';

/** Le retour de la page : son libellé, et le parent déterministe de #232. */
export type WorkBarBack = { label: string; parent: string };

export default function WorkBar({
  back,
  context = null,
}: {
  back: WorkBarBack;
  /**
   * Ce que la page dit d'elle-même, à droite : qui a travaillé, son état, un
   * bouton de contexte. Jamais une action qui CHANGE quelque chose — celles-là
   * sont sur la rangée du dessous.
   */
  context?: ReactNode;
}) {
  return (
    // #135 — la barre dessinée : 54 px, un fond, deux filets, d'un bord à
    // l'autre de l'écran. Ses gouttières sont les siennes et celles de la page
    // (`toolbarBleed` de `PageShell` retire l'enveloppe qui les ajouterait),
    // donc le retour tombe sous l'avatar ou le titre de l'en-tête.
    // `shrink-0` : dans la colonne pleine hauteur d'un écran de fil, une barre
    // à hauteur fixe se laisse comprimer par ce qui pousse sous elle.
    <div
      data-testid="work-bar"
      className="flex h-[54px] w-full min-w-0 shrink-0 items-center gap-4 border-y border-rule-2 bg-canvas px-5 sm:px-8 lg:px-9"
    >
      {/* #232 — le retour ne mène pas au `parent` quoi qu'il arrive : c'est le
          repli. Quand cet onglet a une page précédente, on y revient. */}
      <BackButton
        parent={back.parent}
        label={back.label}
        className="text-body-13 hover:text-ink-2"
      />
      {context !== null && (
        <div className="ml-auto flex shrink-0 items-center gap-4">{context}</div>
      )}
    </div>
  );
}
