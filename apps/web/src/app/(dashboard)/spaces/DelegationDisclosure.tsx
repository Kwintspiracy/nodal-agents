'use client';

// DelegationDisclosure — un travail confié à un autre agent (P2bis).
//
// Une délégation était une ligne tronquée : « Delegated to Lead-Dev » suivi du
// début de son résultat, coupé au milieu d'un mot. C'est pourtant le moment le
// plus intéressant du fil — un autre agent a travaillé. Le design (Figma
// 2:330, « DelegationBlock ») lui donne le nom du délégué en capitales vertes
// au-dessus, puis un cadre dont la BORDURE est teintée du même vert — pas de
// filet à gauche — et une ligne de 40 px qui dit ce qu'il a rendu ; le détail
// est sous le chevron. Le vert est le token `ok` du DS, à 25 % comme dans le
// design, jamais une couleur littérale.
//
// Seule la bascule est cliente. Ce qui est dedans (la consigne et le résultat,
// rendus en markdown) arrive en `children` depuis le serveur : le fil ne
// bascule pas dans le navigateur pour un chevron.

import { useState } from 'react';
import type { ReactNode } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';

export default function DelegationDisclosure({
  label,
  avatar,
  title,
  ok,
  aside,
  children,
}: {
  /** « Delegated to Le Relecteur » — mis en capitales par l'échelle typo. */
  label: string;
  /** L'avatar du délégué, à gauche du titre. */
  avatar?: ReactNode;
  /** Ce que le délégué a rendu, en une ligne. */
  title: string;
  /**
   * Le travail est-il allé au bout ? Une pastille, pas un mot : le design ne
   * met pas d'étiquette là où une couleur suffit. Un échec ne se perd pas pour
   * autant — il est rouge, et le détail est sous le chevron.
   */
  ok: boolean;
  /** Ce qui se lit à droite : durée, jetons, coût. */
  aside?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-delegation="">
      <p className="mb-1.5 text-mono-11-caps text-ok">{label}</p>
      <div className="overflow-hidden rounded-xl border border-ok/25 bg-paper">
        <DisclosureButton
          open={open}
          onClick={() => setOpen((v) => !v)}
          inset="tight"
          insetY="none"
          className="h-[40px]"
        >
          {avatar}
          <span className="min-w-0 flex-1 truncate text-left text-body-13 text-ink">{title}</span>
          {/* `data-outcome` dit CE QUE la pastille annonce ; la classe dit
              seulement de quelle couleur elle est. Le parcours de #55 lisait
              `span.bg-err`, donc une couleur : un thème qui renomme son jeton
              d'erreur rendait muet le test qui prouve qu'une délégation ratée
              se voit (issue #55). */}
          <span
            data-outcome={ok ? 'ok' : 'failed'}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-err'}`}
          />
          {aside !== undefined && aside !== '' && (
            <span className="shrink-0 text-mono-11 text-ink-4">{aside}</span>
          )}
        </DisclosureButton>
        {open && <div className="border-t border-rule-2">{children}</div>}
      </div>
    </div>
  );
}
