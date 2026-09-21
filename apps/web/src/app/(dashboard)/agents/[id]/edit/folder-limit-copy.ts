// folder-limit-copy.ts — la phrase qui dit ce qu'enregistrer coûte à une règle
// confinée à un dossier, écrite UNE fois.
//
// Depuis « Approve for this project » (#360), une règle agent+outil peut porter
// `condition_json.workspacePath` : « approuvé, mais seulement quand l'agent
// travaille là ». #390 a fait dire cette perte à l'onglet Approvals, avant
// d'enregistrer. L'onglet Connectors doit dire la MÊME chose (issue #401), et
// une seconde copie du texte dérive : deux écrans qui décrivent la même perte
// avec deux phrases, c'est deux promesses différentes.

/** Titre de la boîte quand la limite de dossier va sauter. */
export const FOLDER_LIMIT_TITLE = 'Remove the folder limit?';

/** Ce que la règle vaut AUJOURD'HUI. Commun aux deux issues de la boîte. */
export function folderLimitPreamble(folder: string): string {
  return `This rule applies only in ${folder} today.`;
}

/** Ce qu'enregistrer une permission sans condition va faire. */
export function folderLimitWideningMessage(folder: string): string {
  return `${folderLimitPreamble(folder)} Saving from here applies your choice everywhere this agent works.`;
}

/** Le bouton qui confirme la perte de la limite. */
export const FOLDER_LIMIT_CONFIRM_LABEL = 'Remove the limit';
