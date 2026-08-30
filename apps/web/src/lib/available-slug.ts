// available-slug.ts — a profile's default identity, made free.
//
// A profile pre-fills the create form with its own slug and name. Creating a
// second Developer is legitimate (the picker keeps every profile selectable),
// but pre-filling a slug that is already taken turns an unchanged submission
// into a `conflict` error — the form defaulting to a value known to collide.
// So the default is the first free one: `developer`, then `developer-2`,
// `developer-3`… and the name follows the same count.

export function availableSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(Array.from(taken, (s) => s.toLowerCase()));
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!set.has(candidate)) return candidate;
  }
}

/** `Developer` → `Developer 2` when `developer` → `developer-2`. */
export function nameForSlug(baseName: string, baseSlug: string, slug: string): string {
  if (slug === baseSlug) return baseName;
  const suffix = slug.slice(baseSlug.length + 1);
  return `${baseName} ${suffix}`;
}
