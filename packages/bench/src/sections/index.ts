// The section registry. Adding a section here is the only wiring needed —
// the CLI, the baselines and the diff all key off `id`.

import type { Section } from '../types';
import { architectureSection } from './architecture';
import { gateSection } from './gate';
import { trustBoundarySection } from './trust-boundary';
import { catalogSection } from './catalog';
import { catalogDriftSection } from './catalog-drift';

/** Sections that need no network. The default run. */
export const OFFLINE_SECTIONS: readonly Section[] = [
  architectureSection,
  gateSection,
  trustBoundarySection,
  catalogSection,
];

/** Sections that reach a third party. Opt-in with `--online`. */
export const ONLINE_SECTIONS: readonly Section[] = [catalogDriftSection];

export const ALL_SECTIONS: readonly Section[] = [...OFFLINE_SECTIONS, ...ONLINE_SECTIONS];

export function sectionById(id: string): Section | undefined {
  return ALL_SECTIONS.find((s) => s.id === id);
}
