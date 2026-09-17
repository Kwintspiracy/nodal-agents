'use client';

// InlineSelect — le choix POSÉ DANS UNE PHRASE : un intitulé, un caret, et sa
// liste ancrée dessous. Pas un champ de formulaire.
//
// Pourquoi un primitif de plus à côté de `Select` : `Select` habille un
// `<select>` natif, avec le cadre, le fond et la hauteur d'un champ — ce qu'il
// faut dans un formulaire, et ce qui casse une rangée serrée. La pastille du
// composeur (#138, Figma `ThreadComposer` 355:2928) met TROIS choix dans un
// seul cadre de 30 px, séparés par un point : chaque choix doit donc être un
// mot cliquable, sans cadre à lui, avec sa propre liste.
//
// Il vit ici, dans le design system, parce que c'est ici que les éléments
// natifs ont le droit d'exister : un `<button>` brut est refusé partout
// ailleurs (`no-restricted-syntax`), et à raison — un widget natif posé dans un
// écran est un widget qui ne suivra pas le design.
//
// Ce qu'il fait, et rien de plus : ouvrir, fermer, choisir, au clavier comme à
// la souris. Il ne sait NI ce qu'il choisit, ni quoi en faire : l'appelant tient
// l'état ouvert/fermé (pour n'en ouvrir qu'un à la fois) et écrit la valeur.

import { useEffect, useRef, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';

/** Une ligne de liste. Un intitulé de groupe ne se choisit pas. */
export type InlineSelectRow =
  | { kind: 'heading'; label: string }
  | { kind: 'option'; value: string; label: string };

export default function InlineSelect({
  name,
  label,
  tone = 'text-ink',
  open,
  title,
  disabled = false,
  rows,
  value,
  onToggle,
  onPick,
  onClose,
}: {
  /** Ce que la liste choisit — porte le nom accessible et l'ancre de test. */
  name: string;
  /** Ce qui est écrit quand la liste est fermée : la valeur courante. */
  label: string;
  /** La couleur de l'intitulé : c'est elle qui dit de quoi on parle (#135). */
  tone?: string;
  open: boolean;
  title?: string | undefined;
  disabled?: boolean;
  rows: InlineSelectRow[];
  value: string;
  onToggle: () => void;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <span className="relative flex min-w-0 items-center">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        data-testid={`inline-select-${name}`}
        disabled={disabled}
        onClick={onToggle}
        className={`flex min-w-0 cursor-pointer items-center gap-1 text-mono-12 ${tone} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span className="truncate">{label}</span>
        <CaretDown size={12} aria-hidden className="shrink-0 text-ink-4" />
      </button>
      {open && (
        <OptionList name={name} rows={rows} value={value} onPick={onPick} onClose={onClose} />
      )}
    </span>
  );
}

/**
 * La liste, ancrée AU-DESSUS de l'intitulé : ce choix vit en bas d'un écran,
 * une liste ouverte vers le bas sortirait de la fenêtre. Au clavier : les
 * flèches déplacent, Entrée choisit, Échap ferme.
 */
function OptionList({
  name,
  rows,
  value,
  onPick,
  onClose,
}: {
  name: string;
  rows: InlineSelectRow[];
  value: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const options = rows.filter(
    (r): r is Extract<InlineSelectRow, { kind: 'option' }> => r.kind === 'option',
  );
  const selected = options.findIndex((o) => o.value === value);
  const [active, setActive] = useState(selected >= 0 ? selected : 0);
  const panel = useRef<HTMLDivElement>(null);

  // Le seul effet : donner le focus au panneau à l'ouverture, sinon les flèches
  // défileraient la page. Aucun setState — `active` est calculé à
  // l'initialisation, depuis la valeur courante (la règle
  // `react-hooks/set-state-in-effect` refuse un setState synchrone ici).
  useEffect(() => {
    panel.current?.focus();
  }, []);

  function move(delta: number): void {
    if (options.length === 0) return;
    setActive((i) => (i + delta + options.length) % options.length);
  }

  return (
    <div
      ref={panel}
      role="listbox"
      tabIndex={-1}
      aria-label={name}
      data-testid={`inline-select-${name}-list`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const picked = options[active];
          if (picked) onPick(picked.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
      className="absolute bottom-full left-0 z-20 mb-1.5 max-h-[300px] min-w-[180px] overflow-y-auto rounded-xl border border-rule-2 bg-paper p-1 shadow focus:outline-none"
    >
      {rows.map((row, i) =>
        row.kind === 'heading' ? (
          <p key={`h-${i}`} className="px-2 pt-2 pb-1 text-mono-12 text-ink-4">
            {row.label}
          </p>
        ) : (
          <button
            key={`o-${row.value}`}
            type="button"
            role="option"
            aria-selected={row.value === value}
            data-value={row.value}
            onClick={() => onPick(row.value)}
            onMouseEnter={() => setActive(options.indexOf(row))}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-mono-12 ${
              options[active] === row ? 'bg-hover' : ''
            } ${row.value === value ? 'text-ink' : 'text-ink-2'}`}
          >
            <span aria-hidden="true" className="w-2 shrink-0 text-ink-3">
              {row.value === value ? '•' : ''}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
