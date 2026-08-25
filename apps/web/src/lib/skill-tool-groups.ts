// skill-tool-groups.ts — predicate for "tool group" system skills.
//
// Product decision (Quentin, 17/07): system skills that exist purely to GATE a
// bundle of native builtins (office-editing → 24 xlsx/docx/pptx tools,
// command-execution → run_command) are no longer presented as "skills" in the
// UI. They surface as toggleable TOOL GROUPS on the agent's Tools tab instead,
// and are hidden from every Skills surface (Skills tab, /skills page).
//
// HOW it is decided changed on 2026-08-25 (Quentin: « pk code_review est juste
// un tool et n'a pas de skill ? »). The rule used to be DEDUCED — "a system
// skill that gates ≥1 builtin" — and that deduction was too blunt: it also
// caught skills whose real payload is a DISCIPLINE, not a switch. `code-review`
// carries seven rules on how to judge someone's work, and it was filed under
// Tools where the owner could neither read nor edit it. The same was true of
// `command-execution` (never install heavyweight software on your own
// initiative).
//
// The flag is now DECLARED by each skill (`toolGroup: true` in the catalog), so
// the author decides rather than a heuristic. No slugs are hardcoded here
// (invariant #1): the list is derived from the catalog itself.
//
// Note this is a UI classification only — assignment, storage and runtime
// injection are identical either way.

import { toolGroupSkillSlugs } from '@nodal-agents/catalog';
import type { SkillRow } from './actions.ts';

const TOOL_GROUP_SLUGS = new Set(toolGroupSkillSlugs);

export function isToolGroupSkill(s: Pick<SkillRow, 'slug'>): boolean {
  return TOOL_GROUP_SLUGS.has(s.slug);
}
