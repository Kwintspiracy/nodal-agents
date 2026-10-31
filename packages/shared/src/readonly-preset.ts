// readonly-preset.ts — les outils que le préréglage « agent en lecture seule »
// bloque, à UN endroit (#879).
//
// La liste vivait en trois copies : le dépôt qui pose les règles
// (`packages/db/src/repos/approval-rules.ts`), la section de l'écran d'édition
// (`AgentComposer.tsx`) et la fiche d'une recette (`RecipeDetail.tsx`). Un
// outil qui écrit, ajouté à l'une, laissait les deux autres dire autre chose :
// l'écran aurait compté « tout bloqué » sur un agent qui pouvait encore écrire.
// Elle vit ici, dans le paquet que les trois lisent déjà.

/**
 * Le préréglage « relecteur en lecture seule » : action='block' sur chaque
 * outil d'écriture qu'il couvre. La détection de lecture seule de code_task
 * (assertNotReadOnlyAgent, packages/tools/src/builtin/code-task/db.ts) s'appuie
 * sur l'un d'eux — file_write bloqué ⇒ le mode « write » est refusé aussi —, la
 * liste doit donc rester un sur-ensemble qui contient 'file_write'.
 */
export const READONLY_PRESET_TOOLS = [
  'file_write',
  'file_edit',
  'file_move',
  'skill_file_write',
  'run_command',
  'run_skill_script',
] as const;
