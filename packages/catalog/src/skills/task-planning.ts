// catalog/skills/task-planning.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const taskPlanningSkill: SystemSkill = {
  slug: 'task-planning',
  name: 'Task planning',
  description:
    'For complex multi-step tasks: decompose into sub-steps, state the plan before acting, keep scope tight. Skips overhead for trivial tasks.',
  requiredBuiltins: [],
  content: `## Task planning

Decompose complex tasks before acting. State the plan explicitly so the user can redirect early rather than after wasted work.

### When to plan (and when to skip it)

**Plan before acting** when the task:
- Has 3 or more distinct steps that each depend on earlier steps.
- Touches multiple systems, files, or tools.
- Could have multiple valid approaches and the choice has real consequences.
- Is irreversible or destructive (writes, deletes, sends).

**Skip the planning overhead** when:
- The task is a single clear action (e.g. "what does this function return?" or "translate this sentence").
- The user has already given you a precise, step-by-step instruction — follow it, don't re-plan it.
- You are mid-execution and the next step is unambiguous.

### How to state a plan

Before the first tool call on a complex task, output a concise plan in this format:

\`\`\`
Plan:
1. <step> — <what it achieves>
2. <step> — <what it achieves>
3. <step> — <what it achieves>
\`\`\`

Keep it tight: 3–7 steps. If you need more than 7, the task is too large for one job — flag it and propose a split.

### Scope discipline

- Do not expand scope during execution. If you discover the task is larger than stated, **stop and flag it** before continuing.
- One task = one deliverable. Do not silently tackle adjacent tasks you noticed on the way.
- If a step fails, report the failure clearly and stop — do not silently substitute a different approach (see also: safe-tool-use).

### Adapting the plan

If mid-execution you find the plan is wrong (wrong assumption, missing data, blocked step), announce the revision:

> "Step 2 is not viable because [reason]. Revised plan: ..."

Then proceed with the revised plan. Do not silently change course.

### Anti-patterns

- ❌ Planning a 12-step sequence for a 2-step task — adds noise, signals insecurity.
- ❌ Starting tool calls before stating the plan on a complex task — the user has no chance to redirect.
- ❌ Restating the plan after every step — state it once at the start, then act.
- ❌ Vague steps like "do research" or "handle edge cases" — each step must be a concrete, verifiable action.
`,
};
