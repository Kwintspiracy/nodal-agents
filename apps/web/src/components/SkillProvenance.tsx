// SkillProvenance.tsx — JSX side of the shared provenance model
// (lib/skill-provenance.ts): the per-row icon and micro-tag.

import { BookOpenText, DownloadSimple, Lightbulb, PencilSimple } from '@phosphor-icons/react';
import type { SkillRow } from '@/lib/actions.ts';
import { skillProvenanceOf } from '@/lib/skill-provenance.ts';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';

/**
 * Provenance glyph inside the skill Disc — one icon per origin, reusing the
 * app's existing icon grammar: BookOpenText = the Skills library (sidebar) for
 * built-ins, DownloadSimple = the community-install icon (CommunitySkillsGrid),
 * Lightbulb = Learned Skills (sidebar), PencilSimple = hand-authored.
 * Disc sizes the svg itself ([&_svg] rules).
 */
export function skillProvenanceIcon(skill: Pick<SkillRow, 'isCommunity' | 'createdBy'>) {
  switch (skillProvenanceOf(skill)) {
    case 'community':
      return <DownloadSimple weight="regular" />;
    case 'learned':
      return <Lightbulb weight="regular" />;
    case 'custom':
      return <PencilSimple weight="regular" />;
    case 'builtin':
      return <BookOpenText weight="regular" />;
  }
}

/**
 * Provenance flag for a skill row — for lists where provenances mix (e.g. the
 * agent composer's Attached card; segmented lists carry the info in their
 * headers instead). The untagged default is the built-in catalog.
 */
export function skillProvenanceTag(skill: Pick<SkillRow, 'isCommunity' | 'createdBy'>) {
  switch (skillProvenanceOf(skill)) {
    case 'community':
      return <MonoMicroTag tone="skill">community</MonoMicroTag>;
    case 'learned':
      return <MonoMicroTag tone="agent">learned</MonoMicroTag>;
    case 'custom':
      return <MonoMicroTag tone="ink">custom</MonoMicroTag>;
    case 'builtin':
      return null;
  }
}
