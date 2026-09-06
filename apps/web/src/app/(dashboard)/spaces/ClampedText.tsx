'use client';

// ClampedText — un texte long se replie à quelques lignes et se déplie d'un
// clic. La demande d'une automatisation est un prompt entier : le fil la
// montre, il ne la déroule pas d'office (retour de Quentin, 06/09).

import { useState } from 'react';
import TextButton from '@/components/ui/TextButton';

const LINES = 6;

export default function ClampedText({
  text,
  className = '',
}: {
  text: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n').length;
  const long = lines > LINES || text.length > 600;
  return (
    <div className={className}>
      <p className={`whitespace-pre-wrap ${!open && long ? 'line-clamp-6' : ''}`}>{text}</p>
      {long && (
        <TextButton
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 text-body-12 text-ink-3 hover:text-ink"
        >
          {open ? 'Show less' : 'Show more'}
        </TextButton>
      )}
    </div>
  );
}
