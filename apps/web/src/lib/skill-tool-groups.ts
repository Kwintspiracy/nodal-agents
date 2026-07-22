// skill-tool-groups.ts — predicate for "tool group" system skills.
//
// Product decision (Quentin, 17/07): system skills that exist purely to GATE a
// bundle of native builtins (office-editing → 24 xlsx/docx/pptx tools,
// command-execution → run_command) are no longer presented as "skills" in the
// UI. They surface as toggleable TOOL GROUPS on the agent's Tools tab instead,
// and are hidden from every Skills surface (Skills tab, /skills page).
//
// No slugs hardcoded here (invariant #1, no-hardcoded-agent-metadata) — the
// predicate is generic: a SYSTEM skill (systemKind non-null) that GATES at
// least one native builtin (requiredBuiltins.length > 0). Today that matches
// exactly office-editing and command-execution; any future tool-gating system
// skill lands in the Tools tab automatically without touching this file.

import type { SkillRow } from './actions.ts';

export function isToolGroupSkill(s: Pick<SkillRow, 'systemKind' | 'requiredBuiltins'>): boolean {
  return s.systemKind !== null && s.requiredBuiltins.length > 0;
}
