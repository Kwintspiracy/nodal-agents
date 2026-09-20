'use client';

// RowMenu — les trois points en bout d'une ligne de la barre latérale, et le
// petit menu qu'ils ouvrent (planche 25:1062, cadre 22:1514 : la ligne
// « Release check » porte `lucide/ellipsis` à droite ; demande du propriétaire
// du 20/09 : « sur tous les champs qui acceptent la suppression et le
// renommage »).
//
// Le bouton est un FRÈRE du lien de la ligne, dans le conteneur qui porte le
// survol — jamais dedans : un `<button>` ne vit pas dans un `<a>`. Il ne se
// voit qu'au survol de la ligne, quand la ligne est active, ou quand le menu
// est ouvert ; le reste du temps la colonne reste calme.
//
// Le menu se ferme comme toute carte du produit : au clic dehors, à Échap par
// la pile des calques (`@/lib/layers.ts`). AUCUN dialogue natif (invariant
// #10) : ce que chaque entrée déclenche (une confirmation, une saisie) est
// une modale du design system, montée par l'appelant.

import { useEffect, useRef, useState } from 'react';
import { DotsThree } from '@phosphor-icons/react';
import { useLayer } from '@/lib/layers.ts';

export type RowMenuItem = {
  label: string;
  onSelect: () => void;
  /** Rouge : l'entrée retire quelque chose. */
  destructive?: boolean;
};

export default function RowMenu({
  label,
  items,
  testId,
}: {
  /** Ce que le menu concerne, pour un lecteur d'écran : « Actions for Recipes ». */
  label: string;
  items: readonly RowMenuItem[];
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const boite = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function dehors(e: PointerEvent) {
      if (boite.current?.contains(e.target as Node | null) === true) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', dehors);
    return () => document.removeEventListener('pointerdown', dehors);
  }, [open]);

  useLayer(open, () => setOpen(false));

  return (
    <div ref={boite} className="relative shrink-0 self-center">
      <button
        type="button"
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={(e) => {
          // Le clic ne doit pas suivre le lien voisin ni plier le dossier.
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition-opacity hover:bg-hover-2 hover:text-ink focus-visible:opacity-100 ${
          open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <DotsThree size={16} weight="bold" className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${label}`}
          data-testid={testId !== undefined ? `${testId}-menu` : undefined}
          className="absolute top-full right-0 z-30 mt-1 min-w-[150px] rounded-lg border border-rule-2 bg-paper p-1 shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                it.onSelect();
              }}
              className={`flex h-8 w-full items-center rounded-md px-2.5 text-left text-body-13 hover:bg-hover ${
                it.destructive === true ? 'text-err' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
