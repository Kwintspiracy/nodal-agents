'use client';

// InboxFolder — une ligne du groupe « Chat folders » (#135).
//
// Plus basse et plus en retrait qu'un `SidebarLink` : ce n'est pas une
// destination de plus dans la barre, c'est un sous-endroit de « Chat ». Le
// retrait à gauche (28 px) aligne son icône sous le libellé du lien parent,
// ce qui est la seule chose qui dise « ceci est dedans ».
//
// Deux signaux, jamais confondus : le POINT vert (un run tourne) et la
// PASTILLE corail (ce qui attend la personne). Le point n'a pas de nombre —
// voir `lib/chat-folders.ts`, qui porte la règle et sa raison.

import Link from 'next/link';
import type { ReactNode } from 'react';
import LiveDot from './LiveDot';
import AttentionCount from './AttentionCount';

type Props = {
  /** L'identité du dossier — sert au `data-testid`. */
  folderKey: string;
  label: string;
  href: string;
  icon: ReactNode;
  /** Ce qui attend la personne. 0 → aucune pastille. */
  waiting: number;
  /** Un run tourne ici. */
  running: boolean;
  active: boolean;
};

export default function InboxFolder({
  folderKey,
  label,
  href,
  icon,
  waiting,
  running,
  active,
}: Props) {
  return (
    <Link
      href={href}
      title={label}
      data-testid={`inbox-folder-${folderKey}`}
      aria-current={active ? 'page' : undefined}
      className={`group mx-3 flex h-10 items-center gap-2 rounded-lg pr-2.5 pl-7 transition-colors lg:h-8 ${
        active ? 'bg-hover' : 'hover:bg-hover'
      }`}
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
      <span
        className={`flex-1 truncate leading-5 ${active ? 'text-medium-13 text-ink' : 'text-body-13 text-ink-2'}`}
      >
        {label}
      </span>
      {running && <LiveDot variant="ok" size="sm" />}
      {waiting > 0 && <AttentionCount count={waiting} max={9} variant="solid" />}
    </Link>
  );
}
