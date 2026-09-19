// WorkBar — LA barre d'une page de détail, sous l'en-tête (#242, 19/09/2026).
//
// Deux décisions du propriétaire le même jour, et la seconde a défait la
// première.
//
// D'abord, page après page : « trop de pages n'utilisent pas cette barre, ce
// qui veut dire que ce n'est pas un système. » La barre existait — composant
// Figma `WorkBar`, node 353:3378 — mais codée SOUS un dossier de page, avec une
// API taillée pour le fil de chat. Elle vit donc ici, dans le design system.
//
// Puis, le soir : « Retire les boutons retour PARTOUT. On le remettra après
// testing si je ressens le besoin. À l'heure actuelle ça casse complètement la
// navigation. » La barre ne porte donc plus de retour. On se déplace par la
// barre latérale, qui reste visible et dit toujours où l'on est.
//
// Ce qu'il reste : le CONTEXTE de la page, à droite — qui a travaillé, l'état,
// la preuve, un bouton de contexte. Ce qui est propre au fil (les avatars, le
// dossier, la densité) vit dans l'enveloppe `spaces/ThreadWorkBar.tsx`.
//
// Une barre qui n'aurait rien à dire ne se dessine pas : depuis que le retour
// est parti, le contexte peut être vide, et 54 px de fond entre deux filets
// autour de rien ne sont pas un élément d'interface.
//
// Ce que la barre NE porte PAS : les actions de la page. « Run now », « Edit »,
// « Rename » vont sur leur propre rangée EN DESSOUS (`ActionRow`). C'est le
// second constat du 19/09 : des actions sur la ligne du retour faisaient du
// retour un bouton parmi d'autres.

import type { ReactNode } from 'react';

export default function WorkBar({
  context,
}: {
  /**
   * Ce que la page dit d'elle-même : qui a travaillé, son état, un bouton de
   * contexte. Jamais une action qui CHANGE quelque chose — celles-là sont sur
   * la rangée du dessous.
   */
  context: ReactNode;
}) {
  // Rien à dire, rien à dessiner. Pas de bandeau vide (#242).
  if (context === null || context === undefined || context === false) return null;

  return (
    // #135 — la barre dessinée : 54 px, un fond, deux filets, d'un bord à
    // l'autre de l'écran. Ses gouttières sont les siennes et celles de la page
    // (`toolbarBleed` de `PageShell` retire l'enveloppe qui les ajouterait).
    // `shrink-0` : dans la colonne pleine hauteur d'un écran de fil, une barre
    // à hauteur fixe se laisse comprimer par ce qui pousse sous elle.
    <div
      data-testid="work-bar"
      className="flex h-[54px] w-full min-w-0 shrink-0 items-center gap-4 border-y border-rule-2 bg-canvas px-5 sm:px-8 lg:px-9"
    >
      {/* Le contexte tient le bord droit, là où il a toujours été. La place du
          retour, à gauche, reste vide plutôt que d'être reprise par autre
          chose : on saura la rendre si le retour revient. */}
      <div className="ml-auto flex shrink-0 items-center gap-4">{context}</div>
    </div>
  );
}
