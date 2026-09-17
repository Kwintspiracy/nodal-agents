'use client';

// DelegationBlock — la COQUILLE d'une délégation (#135).
//
// Le tableau de Quentin lui donne une tête de 46 px qui se lit comme une
// phrase : « Alfred delegated to Reviewer C — review the memory search
// journey », puis l'état et les chiffres. Le chevron OUVRE la tête, il ne la
// suit pas : une délégation se lit de gauche à droite, du délégant au délégué.
//
// La géométrie diffère de `FoldableBlock` (33 px, `bg-canvas`, chevron à
// droite) : un bloc d'outil est une ligne technique, une délégation est un
// moment du fil. Deux formes, deux coquilles — plutôt qu'une coquille à
// options qui ne serait ni l'une ni l'autre.
//
// Seule la bascule est cliente. La tête et le corps arrivent en `children`
// depuis le serveur : le fil ne bascule pas dans le navigateur pour un chevron,
// et le corps n'est RENDU que déplié (replié, il n'est pas dans le DOM).

import { useState, type ReactNode } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';

export default function DelegationBlock({ head, body }: { head: ReactNode; body: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-delegation="" className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <DisclosureButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        className="h-[46px] gap-2.5 py-0 px-3.5"
      >
        {head}
      </DisclosureButton>
      {open && <div className="border-t border-rule-2">{body}</div>}
    </div>
  );
}
