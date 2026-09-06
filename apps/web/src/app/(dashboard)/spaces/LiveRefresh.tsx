'use client';

// LiveRefresh — tant que le travail court, la page se recharge toutes les
// quelques secondes : le fil est rendu côté serveur depuis les lignes, la
// fraîcheur vient d'une relecture, pas d'un second chemin de données.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LiveRefresh({ live, everyMs = 3000 }: { live: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [live, everyMs, router]);
  return null;
}
