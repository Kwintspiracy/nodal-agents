// catalog/skills/research-scope-discipline.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const researchScopeDisciplineSkill: SystemSkill = {
  slug: 'research-scope-discipline',
  name: 'Research scope discipline',
  description:
    'Scope discipline to avoid research runaways and upstream timeouts on long-form syntheses.',
  requiredBuiltins: [],
  content: `Scope discipline for encyclopedic research and long-form syntheses. Avoids upstream timeouts and improves deliverable quality.

## Default target: 5-8 KB of structured content

When asked for an encyclopedic synthesis or in-depth research, aim for **5-8 KB of content** (≈ 1200-1800 words, ≈ 4-6 main sections).

**DO NOT** aim for 15-20 KB in a single shot. That's the #1 cause of upstream timeouts on LLMs — including large-context models. The user can always ask for a specific deep-dive afterward; a solid deliverable beats a 5-minute timeout.

## Progressive-scope workflow

1. **Frame the scope**: at the start of the task, identify 4-6 key sections (not 12+). If the orchestrator asks for a "complete synthesis on X", it's UP TO YOU to pick the 4-6 most representative angles and stick to them.
2. **Targeted research**: 3-5 searches/scrapes MAX (not 10+). You have what you need to write a clean synthesis from 3 solid sources. More scrapes = more tokens in context = more timeout risk.
3. **Write straight away**: after research, \`file_write\` (if the destination is a vault), \`dashboard_publish\` (if it's a dashboard deliverable), or \`return_result\` directly. No pointless intermediate saves.

## If you sense it's going to overflow

If you realize mid-job that the topic genuinely warrants 15+ KB (rare case: a truly dense subject, an explicit "exhaustive" request), **STOP**. Instead of pressing on in "full encyclopedia" mode:

- Finish what you've already written: 5-8 KB focused on the fundamentals ✅
- In your \`return_result\` or your \`file_write\`, flag it clearly to the orchestrator: *"This synthesis covers the fundamentals of X. The related topics (sub-theme A, sub-theme B, sub-theme C) would warrant dedicated research if the user wants to go further."*

This lets the orchestrator re-delegate into focused sub-tasks instead of one mega-call that times out.

## Proposed breakdown

If the orchestrator hands you a very broad task (e.g., "complete synthesis on quantum mechanics"), YOU are allowed to respond with a proposed breakdown BEFORE starting:

\`\`\`
This complete synthesis warrants 3-4 focused sub-researches:
1. History + founders (Planck → Dirac)
2. Postulates + mathematical formalism
3. Observable phenomena (entanglement, decoherence)
4. Applications + recent research (2024-2025)

I'll start with #1; it's up to you to re-delegate the other 3 in successive turns.
\`\`\`

This is a valid alternative to a silent timeout.

## Anti-patterns

- ❌ "Exhaustive encyclopedic synthesis covering the entire history + every theory + all recent developments" in a single shot → guaranteed timeout.
- ❌ 10+ scrapes "to be sure not to miss anything" → context bloat, and quality stops improving after 4-5 sources.
- ❌ Writing 15 KB then dashboard_publish-ing the whole thing — prefer a clean 6 KB deliverable + a "deeper dive if needed" signal.
- ❌ More than 30 execution turns without having called \`file_write\`, \`dashboard_publish\`, or \`return_result\` → you're in a research runaway, write what you have NOW.
- ✅ Focused 5-8 KB synthesis + an explicit signal of possible extensions.
`,
};
