// verification/repair-brief.ts — ce que le MODÈLE reçoit quand une preuve rouge
// rouvre le run pour un tour de réparation (issue #375, plan « Vérifier &
// Corriger » PR②, décision D2).
//
// ─── Pourquoi du texte en dur ici, et pourquoi ce n'est pas l'invariant #2 ───
//
// L'invariant #2 interdit au runner de parler À L'UTILISATEUR : l'écran ne
// porte que ce que le modèle dit, ou rien. Ce module ne s'adresse pas à
// l'écran : il écrit l'ENTRÉE d'un tour, au même titre que les rappels déjà
// posés par `execute.ts` (livraison non partie, échec de délégation non
// résolu). C'est du harnais qui parle au modèle, jamais du harnais qui parle à
// la place du modèle.
//
// ─── Ce que le brief porte, et pourquoi VERBATIM ─────────────────────────────
//
// La commande, son code de sortie, sa sortie capturée. Rien de reformulé : un
// harnais qui résume une erreur de compilateur enlève exactement ce qui permet
// de la corriger. Le seul traitement est une BORNE, et elle se dit — un
// résultat d'outil de 50 Ko est un résultat que le modèle ne lit pas (v5-B du
// plan), et une troncature muette ferait chercher une ligne qui n'est plus là.

import type { ProofCommandRecord } from './types.ts';

/**
 * Le nombre de caractères gardés PAR FLUX (stdout, stderr) et par commande.
 *
 * La fin, pas le début : un `tsc` ou un `vitest` posent leur diagnostic en
 * queue de sortie. Les enregistrements arrivent déjà bornés du vérificateur
 * (`MAX_TAIL_CHARS`) ; cette borne-ci est celle du brief, indépendante, parce
 * que le brief peut porter PLUSIEURS commandes rouges et que la somme doit
 * rester lisible.
 */
export const REPAIR_BRIEF_TAIL_CHARS = 2_000;

/** Une commande rouge, telle que la finalisation l'a vue tourner. */
export interface RepairBriefCommand {
  /** L'adresse du livrable (`display_path_snapshot`), ou sa clé à défaut. */
  readonly deliverable: string;
  readonly record: ProofCommandRecord;
}

/**
 * Garde la fin de `texte` et DIT ce qui a été retiré. Une sortie vide rend la
 * chaîne vide : l'appelant décide alors de ne pas écrire la section.
 */
function borner(texte: string): string {
  if (texte.length <= REPAIR_BRIEF_TAIL_CHARS) return texte;
  const garde = texte.slice(texte.length - REPAIR_BRIEF_TAIL_CHARS);
  return `[truncated: kept the last ${REPAIR_BRIEF_TAIL_CHARS} characters of ${texte.length}]\n${garde}`;
}

/**
 * Ce que le moteur shell a répondu, sans jamais confondre ses trois issues.
 *
 * ⚠️ LES DEUX PREMIÈRES BRANCHES SONT INATTEIGNABLES AUJOURD'HUI, et c'est
 * assumé : un `timeout` ou un `spawn_error` rendent le verdict `infra_error`
 * (`verdictOf`, code-project.ts), jamais `red`, et seul un enregistrement
 * ROUGE entre dans un brief. C'est ce que le plan demande — « `timeout` /
 * `spawn_error` ⇒ `infra_error` immédiat, pas de réparation » : on ne fait pas
 * corriger du code à cause d'une machine qui n'a pas répondu. Elles restent
 * parce qu'écrire « Exit code: null » sur un timeout serait faux, et qu'un
 * vérificateur à venir peut très bien rendre un rouge sur un timeout.
 */
function issue(record: ProofCommandRecord): string {
  if (record.outcomeKind === 'timeout') return 'Outcome: timed out (no exit code)';
  if (record.outcomeKind === 'spawn_error') return 'Outcome: could not be started (no exit code)';
  return `Exit code: ${record.exitCode ?? 'unknown'}`;
}

function bloc(item: RepairBriefCommand): string {
  const lignes = [
    `Deliverable: ${item.deliverable}`,
    `Command: ${item.record.command}`,
    issue(item.record),
  ];
  const stdout = borner(item.record.stdoutTail ?? '');
  const stderr = borner(item.record.stderrTail ?? '');
  if (stdout.trim() !== '') lignes.push('stdout:', stdout);
  if (stderr.trim() !== '') lignes.push('stderr:', stderr);
  if (stdout.trim() === '' && stderr.trim() === '')
    lignes.push('Output: (the command printed nothing)');
  return lignes.join('\n');
}

/**
 * Le message de plateforme qui ouvre le tour de réparation.
 *
 * Le contrat, dit exactement (#711). Ce qui est rouge, c'est le LIVRABLE (un
 * fichier, un projet) : c'est lui qu'on répare. « Livre à nouveau de la même
 * façon » faisait refaire au modèle tout ce qui avait accompagné sa première
 * fin — un courriel déjà parti est reparti le 12/10. Ce qui a été fait au
 * dehors (un message, une publication, une impression, une délégation) a eu
 * lieu ; le refaire ne répare rien. Pour que la preuve repasse, il suffit de
 * FINIR, comme toute tâche : une réponse sans appel d'outil, ou
 * `return_result` — les deux portes de `finalizeJobSuccess` dans la boucle
 * (execute.ts), et `return_result` est le seul outil que tout agent a.
 *
 * La dernière phrase est celle de la décision D2 : le modèle doit savoir si
 * le verdict suivant est le dernier mot — sinon il livre une correction
 * partielle en comptant sur un essai qui n'existe pas. `toursRestants` est ce
 * qui restera APRÈS ce tour-ci : le réglage de l'espace en permet plusieurs
 * (#377), et « ton seul tour » était faux dès qu'il valait plus d'un.
 */
export function buildRepairBrief(
  commands: readonly RepairBriefCommand[],
  toursRestants: number,
): string {
  if (commands.length === 0) {
    throw new Error('REPAIR_BRIEF_WITHOUT_RED_COMMAND');
  }
  const tete =
    commands.length === 1
      ? 'The proof of your deliverable failed. Here is the command that failed, verbatim.'
      : `The proof of your deliverables failed. Here are the ${commands.length} commands that failed, verbatim.`;
  const unSeul = new Set(commands.map((c) => c.deliverable)).size === 1;
  const fin =
    toursRestants <= 0
      ? 'This is your last repair turn: the verdict of that proof is final.'
      : `If it fails again, you get at most ${toursRestants} more repair turn${toursRestants === 1 ? '' : 's'}.`;
  return [
    tete,
    '',
    commands.map(bloc).join('\n\n'),
    '',
    `Repair ${unSeul ? 'the deliverable' : 'the deliverables'} named above, so that ` +
      `${commands.length === 1 ? 'this command passes' : 'every command above passes'}. ` +
      `Do not repeat anything you already did outside ${unSeul ? 'it' : 'them'}: a message or ` +
      'a post already sent, a print, a delegation, or any other action already performed has ' +
      'happened, and doing it again repairs nothing. ' +
      `Once ${unSeul ? 'it is' : 'they are'} repaired, finish as you finish any task — reply ` +
      `without calling a tool, or call return_result — and the proof runs again on ` +
      `${unSeul ? 'it' : 'them'}. ` +
      fin,
  ].join('\n');
}
