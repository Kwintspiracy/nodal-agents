// skill-provenance.ts — shared provenance model for skills.
//
// One provenance = one segment = one dot colour = one icon = one tag, reused
// identically by the agent composer's Skills tab and /skills' Workspace view
// (JSX helpers live in components/SkillProvenance.tsx). Ground truth is
// (isCommunity, createdBy): community installs keep their installer's
// createdBy='user', so isCommunity is checked first.

import type { SkillRow } from './actions.ts';

export type SkillProvenance = 'community' | 'custom' | 'learned' | 'builtin';

export function skillProvenanceOf(s: Pick<SkillRow, 'isCommunity' | 'createdBy'>): SkillProvenance {
  if (s.isCommunity) return 'community';
  if (s.createdBy === 'agent') return 'learned';
  if (s.createdBy === 'user') return 'custom';
  return 'builtin';
}

/** Dot colour = the provenance's tone (same mapping as the MonoMicroTag),
 *  echoing the sidebar's category-dot grammar; built-in stays neutral. */
export const SKILL_PROVENANCE_META: Record<SkillProvenance, { label: string; dot: string }> = {
  community: { label: 'Community', dot: 'bg-skill-vivid' },
  custom: { label: 'Custom', dot: 'bg-ink-3' },
  learned: { label: 'Learned', dot: 'bg-agent-vivid' },
  builtin: { label: 'Built-in', dot: 'bg-ink-4' },
};

/** The distinctive origins lead; the built-in catalog — the bulk — closes. */
export const SKILL_PROVENANCE_ORDER: SkillProvenance[] = [
  'community',
  'custom',
  'learned',
  'builtin',
];

export type SkillProvenanceSegment<T> = {
  key: SkillProvenance;
  label: string;
  dot: string;
  skills: T[];
};

/** Groups skills into ordered provenance segments (empty ones dropped),
 *  alphabetical within each segment. */
export function segmentSkillsByProvenance<
  T extends Pick<SkillRow, 'isCommunity' | 'createdBy' | 'name'>,
>(skills: T[]): SkillProvenanceSegment<T>[] {
  return SKILL_PROVENANCE_ORDER.map((key) => ({
    key,
    ...SKILL_PROVENANCE_META[key],
    skills: skills
      .filter((s) => skillProvenanceOf(s) === key)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((seg) => seg.skills.length > 0);
}
