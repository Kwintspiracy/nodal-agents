'use client';

// FoldableBlock — la COQUILLE d'un bloc de run (#135).
//
// Le tableau de Quentin pose un principe pour tous les blocs d'un run : replié,
// chaque bloc tient sur une ligne de 33 px ; chacun se déplie pour son compte.
// Ce fichier ne porte que ça — le cadre, la hauteur de la ligne, le chevron et
// l'état du dépliage — pour que deux blocs qui se déplient ne se déplient pas
// de deux façons. `ToolBlock` et la carte d'envoi le partagent.
//
// Le corps n'est RENDU que déplié : replié, il n'est pas dans le DOM. Un corps
// caché en CSS resterait cherchable (Ctrl+F le trouverait dans une page qui ne
// le montre pas) et pèserait sur chaque tour d'un fil de vingt blocs.
//
// Composant CLIENT : le dépliage est un état du navigateur. Le contenu, lui,
// reste au serveur — `head` et `body` arrivent en props, déjà construits par
// l'appelant, y compris quand cet appelant est un composant serveur.

import { useState, type ReactNode } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';

export default function FoldableBlock({
  head,
  body,
}: {
  head: ReactNode;
  /**
   * Ce que le clic ouvre. ABSENT quand il n'y a rien à ouvrir : le bloc garde
   * sa ligne, sans bouton et sans chevron — un chevron qui n'ouvre rien se lit
   * comme un bug, pas comme « rien à dire ».
   */
  body?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-rule-2 bg-canvas">
      {body !== undefined ? (
        <DisclosureButton
          open={open}
          onClick={() => setOpen((v) => !v)}
          chevron="end"
          inset="tight"
          insetY="none"
          className="h-[33px] gap-2"
        >
          {head}
        </DisclosureButton>
      ) : (
        <div className="flex h-[33px] items-center gap-2 px-3">{head}</div>
      )}
      {open && body}
    </div>
  );
}

/** Le corps d'un bloc déplié : le même fond, le même filet, la même marge. */
export function FoldableBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-rule-2 bg-paper px-3 pt-2 pb-2.5">
      {children}
    </div>
  );
}
