'use client';

// NavigationTrail — le greffier du fil de navigation (#232, 19/09/2026).
//
// Monté une fois dans la mise en page du dashboard, il note chaque page de
// l'app visitée dans cet onglet. Il ne dessine rien : c'est `BackButton` qui
// lit le fil et décide. Le POURQUOI est dans `lib/navigation-trail.ts` — en
// deux mots, « Back » doit ramener à la page d'où l'on vient, et une page de
// détail ne peut pas le savoir toute seule.

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  readTrail,
  writeTrail,
  readStampedKey,
  stampKey,
  recordVisit,
} from '@/lib/navigation-trail.ts';

export default function NavigationTrail() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === null || pathname === '') return;
    const { trail, key } = recordVisit(readTrail(), pathname, readStampedKey());
    writeTrail(trail);
    // Marquer l'entrée d'historique APRÈS l'écriture : si le marquage échoue,
    // le fil reste juste et « Back » retombe sur une navigation par l'avant.
    if (key !== null) stampKey(key);
  }, [pathname]);

  return null;
}
