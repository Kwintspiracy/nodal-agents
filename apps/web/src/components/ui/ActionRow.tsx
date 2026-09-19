// ActionRow — la rangée des actions d'une page de détail, SOUS la WorkBar
// (#242, 19/09/2026).
//
// Le second constat du propriétaire ce jour-là : sur la page d'une automation,
// « Run now », « Edit » et « Pause » étaient sur la MÊME ligne que le retour.
// Un retour entouré de boutons n'est plus un retour, c'est un bouton parmi
// d'autres, et l'œil ne sait plus où il est.
//
// Donc : la barre dit d'où l'on vient et où l'on est ; cette rangée porte ce
// que la page permet de FAIRE. Elle vit dans les gouttières du corps, pas dans
// la barre pleine largeur, pour s'aligner sur le contenu qu'elle commande.
//
// Alignée à DROITE (revue #243, passe 1). Le retour tient le bord gauche, tout
// en haut ; les actions tiennent l'autre bord, sous le contexte de la barre qui
// s'y trouve déjà. Les coller à gauche les remettrait juste sous le retour,
// c'est-à-dire à l'endroit qu'on vient de leur retirer.

import type { ReactNode } from 'react';

export default function ActionRow({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="action-row"
      className={`flex min-w-0 flex-wrap items-center justify-end gap-2 ${className}`}
    >
      {children}
    </div>
  );
}
