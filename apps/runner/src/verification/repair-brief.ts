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

/** Ce que le moteur shell a répondu, sans jamais confondre ses trois issues. */
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
 * La dernière phrase est le contrat de la décision D2 : UN tour, et la preuve
 * repasse ensuite quoi qu'il arrive. Le modèle doit savoir que ce n'est pas
 * une boucle — sinon il livre une correction partielle en comptant sur un
 * troisième essai qui n'existe pas.
 */
export function buildRepairBrief(commands: readonly RepairBriefCommand[]): string {
  if (commands.length === 0) {
    throw new Error('REPAIR_BRIEF_WITHOUT_RED_COMMAND');
  }
  const tete =
    commands.length === 1
      ? 'The proof of your delivery failed. Here is the command that failed, verbatim.'
      : `The proof of your delivery failed. Here are the ${commands.length} commands that failed, verbatim.`;
  return [
    tete,
    '',
    commands.map(bloc).join('\n\n'),
    '',
    'Fix the cause, then deliver again the same way you just did. This is your only repair turn: the proof runs once more after your next delivery, and its verdict is final.',
  ].join('\n');
}
