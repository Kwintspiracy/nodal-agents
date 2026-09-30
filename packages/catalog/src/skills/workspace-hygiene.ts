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
//
// RETIRÉ le 30/09 (#638) : la section « Reuse before recreating ». Elle
// ordonnait de reprendre « a workflow, script, or document » déjà présent, et
// le mot « document » faisait d'un livrable passé la réponse à une demande
// nouvelle (banc `recipe` : le PDF d'hier repris, donc écrasé, au lieu d'être
// refait). La règle corrigée — les moyens se réutilisent, un livrable se
// produit pour la demande — est dite une fois, dans le bloc `## Shared
// workspace` du prompt, à côté de l'inventaire qu'elle gouverne.
//
// RÉGIME du 01/10/2026 (lot 2 de la 0.9.5) : 2 813 caractères ramenés à une
// règle par sujet, sans perdre les corrections du 26/08 (portée PARTAGÉE, le
// dossier propre d'abord, pas de `shared/` inventé dedans). Ce qui est parti :
//  - « One workflow = one graph » et « Scripts must be reusable » tiennent en
//    une ligne, vraie pour tout fichier réutilisable : les valeurs d'un run
//    sont des arguments ;
//  - « Skill bundles are code » garde sa phrase ; le détail (la variable
//    NODAL_SHARED_WORKSPACE, déplacer les fichiers) est dit par l'outil qui
//    en a besoin, au moment où il sert : description de `run_skill_script` et
//    son avertissement `bundle_pollution` (tools/builtin/run-skill-script.ts).

import type { SystemSkill } from '../types';

export const workspaceHygieneSkill: SystemSkill = {
  slug: 'workspace-hygiene',
  name: 'Workspace hygiene',
  description:
    'One canonical folder per artifact kind. Parametrize scripts. Never write artifacts into a skill bundle.',
  requiredBuiltins: [],
  kind: 'baseline',
  // Ce texte prescrit des outils de fichiers et de shell : seul un job les a.
  surfaces: ['job'],
  content: `## Workspace hygiene

This applies to the SHARED workspace, which you have when your \`## Workspaces\` block lists a folder labelled \`shared\` (no \`## Shared workspace\` listing means it was not built this turn, never that the folder is missing). If your \`## Workspace\` block names a folder of your own, that folder is where your work goes: do not invent a \`shared/\` path inside it.

- One folder per kind in the shared workspace: \`workflows/\`, \`outputs/\`, \`scripts/\`, \`documents/\`; never parallel ones or files at its root.
- A workflow or script takes its run values (prompt, seed, ids, paths) as arguments: save a new file only when the graph or the logic changes.
- Never write generated files into a skill's folder: point a script's output at your own folder if you have one, otherwise the shared workspace.
- Delete temporary diagnostic files before you finish.`,
};
