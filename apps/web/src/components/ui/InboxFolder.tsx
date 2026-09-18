'use client';

// InboxFolder — une ligne du groupe « Chat folders » (#135).
//
// Plus en RETRAIT qu'un `SidebarLink` : ce n'est pas une destination de plus
// dans la barre, c'est un sous-endroit de « Chat ». Le retrait à gauche
// (28 px) aligne son icône sous le libellé du lien parent, ce qui est la seule
// chose qui dise « ceci est dedans ».
//
// Et ce n'est plus un LIEN depuis le 19/09/2026 (Quentin) : la ligne entière
// plie et déplie le dossier, chevron compris, et « See all » est la seule
// chose du sous-menu qui ouvre la liste. C'est donc un bouton — vrai bouton,
// avec son focus clavier et son `aria-expanded`, pas un lien sans adresse.
//
// Sa FORME, en revanche, est celle de toutes les lignes du rail depuis le
// 19/09/2026 : elle vient de `SidebarRow`. Elle était plus basse, ses coins
// plus serrés et son état actif différent (`bg-hover`, qu'on lisait comme un
// survol) ; trois écarts qu'aucune règle ne justifiait, et qui sautaient aux
// yeux dès que la ligne a gagné un chevron.
//
// Deux signaux, jamais confondus : le POINT vert (un run tourne) et la
// PASTILLE corail (ce qui attend la personne). Le point n'a pas de nombre —
// voir `lib/chat-folders.ts`, qui porte la règle et sa raison.

import type { ReactNode } from 'react';
import LiveDot from './LiveDot';
import AttentionCount from './AttentionCount';
import SidebarRow from './SidebarRow';

type Props = {
  /** L'identité du dossier — sert au `data-testid`. */
  folderKey: string;
  label: string;
  icon: ReactNode;
  /** Ce qui attend la personne. 0 → aucune pastille. */
  waiting: number;
  /** Un run tourne ici. */
  running: boolean;
  active: boolean;
  /** Le dossier est-il déplié ? */
  expanded: boolean;
  /** Ce que la ligne fait quand on la clique : plier, ou déplier. */
  onToggle: () => void;
  /** Le chevron qui déplie les derniers fils. Frère du bouton dans la ligne. */
  caret?: ReactNode;
};

export default function InboxFolder({
  folderKey,
  label,
  icon,
  waiting,
  running,
  active,
  expanded,
  onToggle,
  caret,
}: Props) {
  return (
    <SidebarRow
      // AUCUNE adresse (Quentin, 19/09/2026) : cliquer un dossier le DÉPLIE, il
      // ne navigue plus. Sa liste entière reste à un clic, par « See all », qui
      // est désormais la seule chose du sous-menu qui y mène.
      onToggle={onToggle}
      expanded={expanded}
      title={label}
      active={active}
      markCurrent
      depth="folder"
      testId={`inbox-folder-${folderKey}`}
      caret={caret}
    >
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${
          active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'
        }`}
      >
        {icon}
      </span>
      {/* leading-5 : `truncate` coupe le débordement, et une line box serrée
          rognerait les descendantes (g, p, y) du nom du dossier. */}
      <span className={`flex-1 truncate leading-5 ${active ? 'text-ink font-medium!' : ''}`}>
        {label}
      </span>
      {running && <LiveDot variant="ok" size="sm" />}
      {waiting > 0 && <AttentionCount count={waiting} max={9} variant="solid" />}
    </SidebarRow>
  );
}
