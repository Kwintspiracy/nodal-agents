// Mises en forme propres à Bench Studio. Durées, jetons et dollars viennent de
// results.ts (`@nodal-agents/bench/results`), le même code que le portail.

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Une date ISO, lisible à la minute ; une absence est dite. */
export function when(iso: unknown): string {
  return typeof iso === 'string' && iso ? iso.replace('T', ' ').slice(0, 16) : 'no date';
}

/** Une part de verts, ou « no trial » : jamais un 0 % pour une cellule vide. */
export function greenRate(green: number, tried: number): string {
  return tried === 0 ? 'no trial' : `${Math.round((green / tried) * 100)}%`;
}
