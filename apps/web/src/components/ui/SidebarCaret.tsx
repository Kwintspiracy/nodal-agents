'use client';

// SidebarCaret — le chevron qui déplie une ligne de la barre latérale
// (Quentin, 18/09/2026).
//
// Pourquoi il n'est pas un `DisclosureButton`. Celui-ci est un `<button>` qui
// PORTE le contenu de la ligne ; or les lignes qui se déplient ici — le groupe
// Channels, chacun de ses dossiers — sont déjà des LIENS, et un bouton ne peut
// pas contenir un lien. La ligne reste donc ce qu'elle était, cliquable vers sa
// destination, et le chevron se pose à côté d'elle : cliquer le nom ouvre le
// dossier, cliquer le chevron le déplie sur place.
//
// Même primitif que partout ailleurs (`IconButton` en mode `ghost`, les carets
// Phosphor du DS) : ni `<button>` nu, ni SVG dessiné à la main.

import { CaretDown, CaretRight } from '@phosphor-icons/react';
import IconButton from './IconButton';

type Props = {
  open: boolean;
  onToggle: () => void;
  /** Ce que le chevron déplie, nommé pour un lecteur d'écran (« Channels »). */
  label: string;
  /** Passé en `data-testid` — la cible des tests et des parcours. */
  testId?: string;
  className?: string;
};

export default function SidebarCaret({ open, onToggle, label, testId, className = '' }: Props) {
  // Le nom dit le GESTE, pas l'état : « Expand Telegram » quand il est fermé.
  const aria = open ? `Collapse ${label}` : `Expand ${label}`;
  return (
    <IconButton
      ghost
      onClick={onToggle}
      aria-expanded={open}
      aria-label={aria}
      title={aria}
      data-testid={testId}
      className={`mr-3 h-9 w-9 rounded-lg text-ink-3 hover:bg-hover hover:text-ink-2 lg:h-6 lg:w-6 ${className}`}
    >
      {open ? <CaretDown size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
    </IconButton>
  );
}
