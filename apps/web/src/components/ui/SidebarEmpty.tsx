// SidebarEmpty — CE QUE LA BARRE DIT QUAND UNE SECTION N'A RIEN (#258).
//
// La planche du propriétaire (Figma `WPLtjoJjXJBEqDyCpLy9xc`, nœud `25:1062`)
// en dessine deux : « No Existing Webhook » sous WEBHOOKS, et « No Approval
// Requests » sous APPROVALS. Toutes les deux ont la même forme — un cadre en
// POINTILLÉS de 39 px de haut, et une phrase en italique, grise, centrée.
//
// Le pointillé porte un sens que le plein n'aurait pas : le cadre montre la
// place d'une chose qui n'est pas encore là. Un cadre plein aurait dessiné un
// objet, et un texte nu n'aurait rien réservé du tout.
//
// ⚠️ CE N'EST PAS `EmptyState`. Celui-ci est le bloc des PAGES — coins `2xl`,
// 24 px de côté, 48 px de haut, fond papier, avec place pour un sous-titre et
// un bouton. Dans une colonne de 300 px il tiendrait la moitié du panneau.
// Deux vides de tailles différentes dans le même produit, c'est voulu : une
// page qui n'a rien montre un grand vide, un menu montre une ligne.
//
// ⚠️ LES COULEURS SONT DES JETONS (décision de l'orchestrateur, 19/09 au
// soir). La planche écrit `#242424` pour le trait et `#4e4e4e` pour le texte ;
// ce sont les valeurs SOMBRES de `rule-2` et d'`ink-4`, et les recopier en
// hexadécimal aurait figé le thème sombre dans un produit qui en a deux.

import type { ReactNode } from 'react';

export default function SidebarEmpty({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="sidebar-empty"
      // 39 px : la mesure de la planche. Les 12 px de retrait latéral sont
      // ceux d'une ligne de menu, si bien que le cadre s'aligne sur les lignes
      // qu'il remplace.
      className="mx-3 flex h-[39px] items-center justify-center rounded-lg border border-dashed border-rule-2 px-3"
    >
      <span className="truncate text-body-12 text-ink-4 italic">{children}</span>
    </div>
  );
}
