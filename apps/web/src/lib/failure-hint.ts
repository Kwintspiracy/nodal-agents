// failure-hint.ts — LE GESTE QU'UN ÉCHEC APPELLE, dit par l'écran (#184).
//
// Le harnais ne conseille pas : il pose un fait. Un job qui meurt sur un refus
// du fournisseur porte un champ typé, `hint: 'switch_model'`, et pas une
// phrase (#119, invariant #2 — le runner se tait, le modèle ou l'écran parle).
// La phrase, en anglais et dans la langue de la personne qui lit, vit donc ICI.
//
// D'OÙ VIENT LE CODE, PUISQUE LE CHAMP N'EST PAS EN BASE. Le `hint` du runner
// voyage en mémoire jusqu'au parent (`delegationRecordFromOutcome`), et dans le
// résultat d'outil que le modèle parent lit. Il n'atteint JAMAIS la base :
// `agent_jobs` n'a pas de colonne pour lui, et un `assign_*` n'écrit pas de
// ligne d'audit (`conversation-feed.ts` le dit : « execute() lève avant
// d'écrire »). Le seul fait persisté de ce refus est le CODE D'ERREUR du job,
// écrit par `providerRejectionCode` (`apps/runner/src/job/execute.ts`).
// L'écran lit donc le même fait que le runner, et en tire le même geste.
// L'issue #193 porte la suite : mettre le champ en base, pour lire le mot du
// runner au lieu de le relire du code.
//
// LE PRÉFIXE ET LE TYPE SONT PARTAGÉS, PAS RECOPIÉS (#194, revue passe 1). Ils
// vivent dans `@nodal-agents/shared` : le runner les pose, cet écran les lit.
// Recopiés, un renommage d'un côté rendait l'écran muet avec tous les tests au
// vert — les tests aussi tenaient leur copie de la chaîne.
//
// Ce qui reste écrit à deux endroits est la CORRESPONDANCE « ce code appelle ce
// geste » : le site du refus dans le runner, et la fonction ci-dessous. Les
// deux ne peuvent pas se contredire — même code, même geste — mais un `hint`
// ajouté côté runner pour un autre échec resterait MUET ici. C'est le sens du
// silence choisi plus bas : un geste inconnu ne rend RIEN, jamais un slug brut.

import { PROVIDER_REJECTED_PREFIX, type JobFailureHint } from '@nodal-agents/shared';

/** Les gestes que l'écran sait dire — le type du harnais, jamais une copie. */
export type FailureHint = JobFailureHint;

/**
 * Le geste que cet échec appelle, lu sur ce qui est PERSISTÉ, ou `null`.
 *
 * `null` est la réponse normale : la grande majorité des échecs n'appellent
 * aucun geste nommable, et inventer une suggestion pour eux serait pire que le
 * silence. Le préfixe porte ses DEUX-POINTS : un futur
 * `provider_rejected_request_autre_chose` n'est pas ce refus-là.
 */
export function failureHint(error: string | null | undefined): FailureHint | null {
  if (typeof error !== 'string') return null;
  return error.startsWith(PROVIDER_REJECTED_PREFIX) ? 'switch_model' : null;
}

/** Ce que l'écran DIT de chaque geste. Court, en anglais, une phrase par code. */
const HINT_SENTENCE: Readonly<Record<FailureHint, string>> = {
  switch_model: 'Try another model for this agent',
};

/**
 * La phrase à afficher, ou `null` quand il n'y a rien à dire.
 *
 * Prend un `string` et non un `FailureHint` exprès : un code venu d'une version
 * du runner plus récente que cet écran ne doit pas s'afficher en slug brut. Il
 * ne se dit pas, point.
 */
export function hintSentence(hint: string | null | undefined): string | null {
  if (typeof hint !== 'string') return null;
  return HINT_SENTENCE[hint as FailureHint] ?? null;
}
