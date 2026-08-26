// catalog/skills/workspace-hygiene.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder upserts this
// row at boot; users can override per-install via the dashboard (preserved via
// the 'content_overridden' flag).
//
// WHY (2026-07-20 audit): a month of jobs left the shared workspace with three
// competing workflow folders, four output folders, ~40 one-shot scripts at the
// root (values hardcoded → unusable next session → rewritten), and 70 MB of
// generated images inside the comfyui skill bundle. The runner now injects a
// live inventory of the shared workspace into each job's prompt (mechanism);
// this skill is the matching behavior contract (discipline).
//
// CORRIGÉ le 26/08, sur un run réel de Quentin. « One folder per kind » ne
// disait pas DE QUEL workspace il parlait, et se lisait donc comme « tout va
// dans le partagé, rangé par genre ». Lead-Dev a fait construire une app par
// Dev C dans `shared/outputs/color-wheel/` alors que les deux ont
// `Documents/Dev` attaché — deux fois de suite, la seconde APRÈS que le bloc
// `## Shared workspace` du prompt eut été corrigé pour dire l'inverse. Ce
// skill est injecté à tous les agents en baseline : il gagnait.
//
// La section porte maintenant sa portée dans son titre, et renvoie au bloc du
// prompt pour la question « où va mon travail ». Le skill garde son sujet — la
// discipline INTERNE du partagé — sans plus décider ce qui doit y atterrir.

import type { SystemSkill } from '../types';

export const workspaceHygieneSkill: SystemSkill = {
  slug: 'workspace-hygiene',
  name: 'Workspace hygiene',
  description:
    'Reuse before recreating. One canonical folder per artifact kind. Parametrize scripts. Never write artifacts into a skill bundle.',
  requiredBuiltins: [],
  kind: 'baseline',
  content: `## Workspace hygiene

This is how you keep the SHARED workspace usable. It is a durable, common asset — not a scratch pad — and its live inventory is in your context under "Shared workspace". Everything below applies to what you put THERE. If you have no \`## Shared workspace\` block, you do not have one: work in the folder your \`## Workspace\` block names, and ignore this skill's folder layout.

### Reuse before recreating

Before building a workflow, script, or document, check the inventory: if a file already covers the need, load it and adapt it (\`file_read\`, then edit or pass different arguments). Recreating an existing artifact under a new name is a failure mode, not a fresh start.

### One folder per kind — inside the shared workspace

These are the canonical folders **of the shared workspace**. When you save there, use them and never invent parallel ones (no \`outputs_v2/\`, \`my_workflows/\`, files dumped at the root):
- \`workflows/\` — workflow definitions (JSON)
- \`outputs/\` — generated artifacts (images, exports)
- \`scripts/\` — reusable scripts
- \`documents/\` — reports, notes, deliverables

This layout applies to the shared workspace ONLY. If your \`## Workspace\` block names a folder of your own, that folder is where your work goes — do not invent a \`shared/\` path inside it, and do not reach for the folders above.

### One workflow = one graph

A saved workflow file is a reusable GRAPH (models, samplers, node wiring) — not a snapshot of one run. FORBIDDEN: saving a workflow file whose only difference from an existing one is the prompt, seed, or other run values — that is clutter, never value. Pass those as execution arguments instead (e.g. \`run_workflow.py --args {"prompt": …, "seed": …}\`) against the EXISTING file. The only reason to save a new workflow file is a change to the graph itself (different model, different node chain) — and it is named after the graph, not the scene.

### Scripts must be reusable

A script you write takes its variable values (ids, paths, prompts) as ARGUMENTS — never hardcoded in the file. If you find yourself editing a script only to change a value, parametrize it instead. Before writing a helper, check whether an installed skill already ships one (\`skill_view\`, then \`run_skill_script\`).

### Skill bundles are code, not storage

Never write generated artifacts into an installed skill's folder. Point a skill script's output argument at a real workspace instead — your own if you have one, otherwise the shared workspace, whose absolute path is in the \`NODAL_SHARED_WORKSPACE\` environment variable of every script/command you run. If a \`warning\` reports bundle writes, move those files out before finishing.

### Leave it clean

Temporary diagnostic files (probe scripts, dumps, logs) are deleted before you finish the task — or not written to the workspace at all when \`stdout\` suffices.`,
};
