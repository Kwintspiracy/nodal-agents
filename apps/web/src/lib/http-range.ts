// http-range.ts — l'en-tête `Range` d'une requête, pour la route qui sert un
// média livré (#490) : `<audio>` et `<video>` lisent par morceaux.

/**
 * Le morceau demandé par `Range: bytes=a-b` (une seule plage, la forme que les
 * lecteurs des navigateurs envoient). null = tout le fichier ; 'unsatisfiable'
 * = une plage hors du fichier, que HTTP refuse en 416.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (header === null) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // `bytes=-500` : les 500 derniers octets.
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}
